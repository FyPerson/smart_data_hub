// #213 L1：结构化登记、开发评估门、送审范围、草稿放弃；与真实实例及进程内变异共用。
// 期望值手写。直接 SQL 只用于身份/附件夹具与历史异常载荷，业务动作均走 HTTP。
'use strict';
const assert = require('assert');
const path = require('path');
const crypto = require('crypto');
const P = 'L1 留痕：';
const EVID = { no_written_evidence: true, no_evidence_reason: '已通过会议讨论确认本次需求变更' };
const CB = '我已阅读以上全部内容，确认无误';
const request = () => ({ kind: 'change_request', change_kind: 'add', content: '新增部门汇总导出功能', reason: '当前人工汇总耗时且容易出现遗漏', problem: '解决不同部门口径不一致的问题' });
const assessment = (cid) => ({ kind: 'dev_assessment', about_change_id: cid, feasible: 'yes', extra_person_days: 2.5, schedule_impact_days: 0, impact_note: null, premise: '需要需求方提供完整样例数据' });

function defineTraceL1Cases(T) {
  const { test, U, api, sqlRun, sqlGet, sqlAll, expectErr, addMember, addParty, addAppointment, addDelegation, confirm: H } = T;
  const post = (uid, url, body) => api(uid, 'POST', url, body || {});
  const get = (uid, url) => api(uid, 'GET', url);
  const patch = (url, body) => api(U.pm, 'PATCH', url, body);
  const reg = (uid, pid, form, extra) => post(uid, `/sysbuild/projects/${pid}/entries`, Object.assign({ form }, extra || {}));
  const act = (eid, action, extra) => post(U.pm, `/sysbuild/entries/${eid}/actions`, Object.assign({ action, [action === 'void' || action.startsWith('mark_') || action.startsWith('unmark_') ? 'reason' : 'text']: '核查后按登记原意进行勘误说明' }, extra || {}));
  const detail = async (eid) => { const r = await get(U.pm, `/sysbuild/entries/${eid}`); assert.strictEqual(r.status, 200, r.text); return r.body.entry; };
  const change = async (s, extra) => {
    const r = await post(U.pm, `/sysbuild/projects/${s.pid}/changes`, Object.assign({ title: '范围调整', body: '新增部门汇总功能供业务核对' }, EVID, extra || {}));
    assert.strictEqual(r.status, 201, r.text); return { cid: r.body.change.id, vid: r.body.version.id, pkid: r.body.change.package_id };
  };
  async function scene(withDev = true) {
    const pid = await H.newProject();
    const eff = await H.produceEffectiveOverall(pid);
    await addMember(pid, U.m1, { party: eff.party });
    const s = { pid, eff, batch: await H.defaultBatchId(pid), item: (await sqlGet('SELECT item_id FROM sysbuild_item_versions WHERE id = ?', [eff.itemVersionId])).item_id };
    if (withDev) {
      s.dev = await addParty(pid, '研发方', 'dev');
      s.owner = await addMember(pid, U.x1, { party: s.dev });
      s.apt = await addAppointment(s.dev, s.owner, 'active');
      s.delegate = await addMember(pid, U.x2, { party: s.dev });
      await addDelegation(s.dev, s.delegate, s.apt, 'active');
      await addMember(pid, U.x3, { party: s.dev });
    }
    return s;
  }
  const submit = (cid) => post(U.pm, `/sysbuild/changes/${cid}/submit`);
  const withdraw = (vid) => post(U.pm, `/sysbuild/package-versions/${vid}/withdraw`, { reason: '重新整理范围，放弃本草稿' });
  const chView = async (cid) => { const r = await get(U.pm, `/sysbuild/changes/${cid}`); assert.strictEqual(r.status, 200, r.text); return r.body.change; };
  const devTask = (eid) => sqlGet("SELECT t.id AS tid, r.id AS rid, r.status, r.required_member_id, r.created_at FROM sysbuild_confirm_tasks t JOIN sysbuild_confirm_task_revisions r ON r.task_id = t.id WHERE t.object_type = 'dev_entry' AND t.object_id = ? ORDER BY t.id DESC, r.rev_no DESC LIMIT 1", [eid]);
  async function assess(s, c, uid = U.x1, extra) {
    const r = await reg(uid, s.pid, Object.assign(assessment(c.cid), extra || {}), { self_confirm_text: CB, ...(uid === U.pm ? { source_party_id: s.dev } : {}) });
    assert.strictEqual(r.status, 201, r.text); return r.body.entry;
  }
  async function gate(s, c, want, text) {
    const d = await chView(c.cid);
    assert.strictEqual(d.actions.submit, want, '读取 actions.submit 同源');
    if (!want) { const r = await submit(c.cid); expectErr(r, 409, 'SYSBUILD_STATE', '提交门'); if (text) assert.ok(r.body.message.includes(text), r.text); }
  }
  const scopeMod = () => require(path.join(T.getModuleDir(), 'submission-scope.js'));
  async function scope(c) {
    const ver = await sqlGet('SELECT * FROM sysbuild_package_versions WHERE id = ?', [c.vid]);
    const pkg = await sqlGet('SELECT * FROM sysbuild_packages WHERE id = ?', [ver.package_id]);
    return scopeMod().readSubmissionScope({ get: sqlGet, all: sqlAll }, pkg, ver);
  }
  async function fact(c) {
    const ver = await sqlGet('SELECT * FROM sysbuild_package_versions WHERE id = ?', [c.vid]);
    const pkg = await sqlGet('SELECT * FROM sysbuild_packages WHERE id = ?', [ver.package_id]);
    const result = await scopeMod().devAssessmentOf({ get: sqlGet, all: sqlAll }, pkg, ver);
    return { devAssessment: result.fact, assessment: result.payload, scopeRejection: result.scopeRejection || null };
  }
  const rawForm = (eid, value) => sqlRun('UPDATE sysbuild_entries SET routing_json = ? WHERE id = ?', [JSON.stringify(value), eid]);
  const endOwner = async (s) => {
    await sqlRun("UPDATE sysbuild_delegations SET status = 'revoked', revoked_at = datetime('now','localtime'), revoke_reason = '任职结束' WHERE party_id = ? AND status = 'active'", [s.dev]);
    await sqlRun("UPDATE sysbuild_appointments SET status = 'ended', ended_at = datetime('now','localtime'), end_reason = '任职结束' WHERE id = ?", [s.apt]);
  };

  test(`${P}需求申请正例——省略类型用途仍生成正文、方向证据与分流，详情列表及元数据给表单`, async () => {
    const s = await scene(false);
    const f = request();
    expectErr(await reg(U.m1, s.pid, f), 400, 'SYSBUILD_EVIDENCE_REQUIRED', '缺方向类证据');
    const r = await reg(U.m1, s.pid, f, EVID);
    assert.strictEqual(r.status, 201, r.text);
    const e = r.body.entry;
    assert.deepStrictEqual([e.type, e.purpose, e.title, e.body], ['feedback', 'general', '需求变更申请（新增）：新增部门汇总导出功能', '变更内容\n新增部门汇总导出功能\n\n原因\n当前人工汇总耗时且容易出现遗漏\n\n要解决的问题\n解决不同部门口径不一致的问题']);
    assert.deepStrictEqual(e.form, f); assert.strictEqual(e.form_label, '需求变更申请'); assert.strictEqual(e.form_unreadable, false);
    assert.strictEqual(e.routing.route, 'pending');
    const saved = await sqlGet('SELECT routing_json, commitment_flag FROM sysbuild_entries WHERE id = ?', [e.id]);
    assert.deepStrictEqual(JSON.parse(saved.routing_json), { v: 1, form: f }); assert.strictEqual(saved.commitment_flag, 0);
    const d = await detail(e.id); assert.deepStrictEqual(d.form, f); assert.strictEqual(d.has_correction, false);
    const list = await get(U.pm, `/sysbuild/projects/${s.pid}/entries`);
    assert.strictEqual(list.status, 200, list.text); assert.deepStrictEqual(list.body.entries.find((v) => v.id === e.id).form, f);
    const meta = list;
    assert.strictEqual(meta.status, 200, meta.text); assert.deepStrictEqual(meta.body.registration.forms.map((v) => v.kind), ['change_request', 'dev_assessment', 'progress_report', 'report_cycle', 'report_request']); // L2 §10：元数据新增三种表单。
    const modified = await reg(U.m1, s.pid, { ...f, change_kind: 'modify' }, { ...EVID, item_ids: [s.item] });
    assert.strictEqual(modified.status, 201, modified.text); assert.strictEqual(modified.body.entry.routing.route, 'project');
  });

  test(`${P}表单字段反例——两种全部字段的缺失类型长度范围取值、多余及派生键，L2三种缺必填字段拒绝`, async () => {
    const s = await scene(); const c = await change(s);
    const bad = [null, [], 'form', { ...request(), kind: 'other' }, ...['progress_report', 'report_cycle', 'report_request'].map((kind) => ({ kind }))];
    for (const key of ['kind', 'change_kind', 'content', 'reason', 'problem']) { const f = request(); delete f[key]; bad.push(f); }
    for (const [key, vals] of Object.entries({ change_kind: ['bad', 1], content: ['', 1, 'x'.repeat(2001)], reason: ['短', 1, 'x'.repeat(1001)], problem: ['短', 1, 'x'.repeat(1001)] })) for (const v of vals) bad.push({ ...request(), [key]: v });
    for (const key of ['about_change_id', 'feasible', 'extra_person_days', 'schedule_impact_days']) { const f = assessment(c.cid); delete f[key]; bad.push(f); }
    for (const [key, vals] of Object.entries({ about_change_id: [0, -1, 1.1, '1'], feasible: [null, 'maybe', 1], extra_person_days: [-1, 10000, 1.11, '1'], schedule_impact_days: [-1, 3651, 0.1, '1'], impact_note: [1, 'x'.repeat(1001)], premise: [1, 'x'.repeat(1001)] })) for (const v of vals) bad.push({ ...assessment(c.cid), [key]: v });
    bad.push({ ...assessment(c.cid), feasible: 'no', impact_note: '' }, { ...assessment(c.cid), schedule_impact_days: 1, impact_note: '短' }, { ...assessment(c.cid), schedule_impact_days: 0.1, impact_note: '已说明受影响的接口与交付节点' });
    for (const base of [request(), assessment(c.cid)]) for (const key of ['extra', 'scope_digest', 'package_version_id']) bad.push({ ...base, [key]: 1 });
    const before = (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE project_id = ?', [s.pid])).n;
    for (const f of bad) expectErr(await reg(U.pm, s.pid, f, { ...EVID, source_party_id: s.dev }), 400, 'SYSBUILD_INVALID_INPUT', JSON.stringify(f).slice(0, 130));
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE project_id = ?', [s.pid])).n, before, '反例整笔不落登记');
  });

  test(`${P}互斥与类型用途——请求键存在即拒绝，客户端承诺1拒绝，修改取消须条目`, async () => {
    const s = await scene(); const c = await change(s);
    for (const f of [request(), assessment(c.cid)]) {
      for (const key of ['title', 'body', 'objects_entry_id', 'revision_of_entry_id']) for (const val of [null, '', 1]) expectErr(await reg(U.pm, s.pid, f, { ...EVID, source_party_id: s.dev, [key]: val }), 400, 'SYSBUILD_INVALID_INPUT', key);
      for (const extra of [{ type: 'issue' }, { purpose: 'deliverable' }, { commitment_flag: 1 }, { commitment_flag: true }]) expectErr(await reg(U.pm, s.pid, f, { ...EVID, source_party_id: s.dev, ...extra }), 400, 'SYSBUILD_INVALID_INPUT', JSON.stringify(extra));
    }
    for (const kind of ['modify', 'cancel']) expectErr(await reg(U.m1, s.pid, { ...request(), change_kind: kind }, EVID), 400, 'SYSBUILD_INVALID_INPUT', kind);
  });

  test(`${P}评估正例与权限——省略类型用途仍需认可，负责人本人确认/代表人与PM待认可，来源及草稿校验`, async () => {
    const s = await scene(); const c = await change(s);
    expectErr(await reg(U.x1, s.pid, assessment(c.cid)), 400, 'SYSBUILD_INVALID_INPUT', '本人须确认文案');
    const e = await assess(s, c);
    assert.deepStrictEqual([e.type, e.purpose, e.form_kind, e.form_label], ['note', 'dev_note', 'dev_assessment', '开发评估']);
    assert.strictEqual(e.title, `开发评估：变更 #${c.cid}（能做，增加 2.5 人日，工期影响 0 天）`);
    assert.strictEqual(e.form.package_version_id, c.vid); assert.match(e.form.scope_digest, /^[a-f0-9]{64}$/);
    assert.strictEqual((await devTask(e.id)).status, 'confirmed');
    for (const uid of [U.x2, U.pm]) { const p = await assess(s, c, uid); assert.strictEqual((await devTask(p.id)).status, 'pending'); }
    for (const uid of [U.x3, U.m1]) expectErr(await reg(uid, s.pid, assessment(c.cid)), 403, 'SYSBUILD_FORBIDDEN', '非开发负责人或代表人');
    expectErr(await reg(U.pm, s.pid, assessment(c.cid)), 400, 'SYSBUILD_INVALID_INPUT', 'PM缺来源');
    expectErr(await reg(U.pm, s.pid, assessment(c.cid), { source_party_id: s.eff.party }), 400, 'SYSBUILD_INVALID_INPUT', 'PM错误来源');
    const foreign = await scene(false); const fc = await change(foreign);
    for (const id of [99999999, fc.cid]) expectErr(await reg(U.x1, s.pid, assessment(id), { self_confirm_text: CB }), 400, 'SYSBUILD_INVALID_INPUT', '变更不存在或跨项目');
    await withdraw(c.vid);
    expectErr(await reg(U.x1, s.pid, assessment(c.cid), { self_confirm_text: CB }), 400, 'SYSBUILD_INVALID_INPUT', '没有草稿');
  });

  test(`${P}混合归属与拆分——省略type仍拒绝混合，不落父子记录；补选混合不可洗掉表单，普通补选可用`, async () => {
    const s = await scene(false);
    const it = await H.mkItem(s.pid);
    const batch2 = (await sqlRun("INSERT INTO sysbuild_batches (project_id, seq, name, is_default, status) VALUES (?, 2, '第二批', 0, 'planning')", [s.pid])).lastID;
    await sqlRun("INSERT INTO sysbuild_package_item_revisions (package_version_id, item_version_id, committed_batch_id, op, created_by) VALUES (?, ?, ?, 'add', ?)", [s.eff.pv, it.versions[0].id, batch2, U.pm]);
    await sqlRun("INSERT INTO sysbuild_golive_events (batch_id, kind, handover_snapshot_json, created_by, created_at) VALUES (?, 'golive', '{}', ?, datetime('now','localtime','-1 hour'))", [s.batch, U.pm]);
    const before = (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE project_id = ?', [s.pid])).n;
    expectErr(await reg(U.m1, s.pid, request(), { ...EVID, item_ids: [s.item, it.id] }), 409, 'SYSBUILD_STATE', '混合归属');
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE project_id = ?', [s.pid])).n, before);
    const r = await reg(U.m1, s.pid, request(), EVID); assert.strictEqual(r.status, 201, r.text); const e = r.body.entry;
    assert.strictEqual(e.actions.split, false);
    expectErr(await act(e.id, 'split', { groups: [{ item_ids: [s.item] }, { item_ids: [it.id] }] }), 409, 'SYSBUILD_STATE', '表单不可拆');
    expectErr(await act(e.id, 'assign_items', { basis_category: 'in_plan', item_ids: [s.item, it.id] }), 409, 'SYSBUILD_STATE', '补选混合不可自动拆');
    const assigned = await act(e.id, 'assign_items', { basis_category: 'in_plan', item_ids: [it.id] }); assert.strictEqual(assigned.status, 201, assigned.text);
    const it2 = await H.mkItem(s.pid);
    await sqlRun("INSERT INTO sysbuild_package_item_revisions (package_version_id, item_version_id, committed_batch_id, op, created_by) VALUES (?, ?, ?, 'add', ?)", [s.eff.pv, it2.versions[0].id, batch2, U.pm]);
    const pair = await reg(U.m1, s.pid, request(), { ...EVID, item_ids: [it.id, it2.id] }); assert.strictEqual(pair.status, 201, pair.text);
    assert.strictEqual(pair.body.entry.actions.split, false);
    expectErr(await act(pair.body.entry.id, 'split', { groups: [[it.id], [it2.id]] }), 409, 'SYSBUILD_STATE', '两个有效关联条目仍不可拆表单');
  });

  test(`${P}勘误只追加——字段和存储不变，列表详情及确认任务单独带勘误`, async () => {
    const s = await scene(); const c = await change(s); const e = await assess(s, c);
    const before = await sqlGet('SELECT routing_json FROM sysbuild_entries WHERE id = ?', [e.id]);
    const r = await act(e.id, 'correct', { text: '样例数据名称笔误，更正为部门明细' }); assert.strictEqual(r.status, 201, r.text);
    const d = await detail(e.id); assert.deepStrictEqual(d.form, e.form); assert.strictEqual(d.has_correction, true); assert.strictEqual(d.corrections[0].text, '样例数据名称笔误，更正为部门明细');
    assert.deepStrictEqual(await sqlGet('SELECT routing_json FROM sysbuild_entries WHERE id = ?', [e.id]), before);
    assert.strictEqual((await fact(c)).devAssessment, 'ok');
    assert.strictEqual((await submit(c.cid)).status, 200);
    const task = (await H.tasksOf(c.vid))[0]; const view = await get(task.user_id, `/sysbuild/confirm-tasks/${task.task_id}`);
    assert.strictEqual(view.status, 200, view.text); assert.strictEqual(view.body.object.assessment.has_correction, true); assert.strictEqual(view.body.object.assessment.corrections[0].text, d.corrections[0].text);
  });

  test(`${P}不可读登记——读取容错，除作废外所有动作拒绝，安全作废保留事件原因`, async () => {
    const s = await scene(false);
    for (const payload of [[], 1, { v: 2, form: request() }, { v: 1, form: { kind: 'other' } }, { v: 1, form: { kind: 'change_request' } }]) {
      const r = await reg(U.m1, s.pid, request(), EVID); assert.strictEqual(r.status, 201, r.text); const eid = r.body.entry.id;
      await rawForm(eid, payload);
      const d = await detail(eid); assert.strictEqual(d.form_unreadable, true); assert.strictEqual(d.form, null); assert.ok(d.title.includes('需求变更申请'));
      for (const [name, allowed] of Object.entries(d.actions)) if (name !== 'void') {
        if (name === 'conclude_kinds') assert.deepStrictEqual(allowed, [], '不可读结论种类为空');
        else assert.strictEqual(allowed, false, `不可读 ${name}`);
      }
      for (const name of ['correct', 'mark_commitment', 'mark_risk', 'for_reference']) expectErr(await act(eid, name), 409, 'SYSBUILD_STATE', `不可读 ${name}`);
      assert.strictEqual(d.actions.void, true);
      const v = await act(eid, 'void'); assert.strictEqual(v.status, 201, v.text);
      const ev = await sqlGet("SELECT payload_json FROM sysbuild_events WHERE object_type = 'entry' AND object_id = ? AND event_type = 'entry_action_recorded' ORDER BY id DESC LIMIT 1", [eid]);
      assert.ok(ev.payload_json.includes('表单不可读') || JSON.parse(ev.payload_json).form_unreadable === true, '作废事件标明表单不可读');
    }
  });

  test(`${P}变更门七值——豁免、缺评估、待认可、最新优先、stale、负责人缺位及恢复，no/partial不拦`, async () => {
    const exempt = await scene(false); const ec = await change(exempt); assert.strictEqual((await fact(ec)).devAssessment, 'exempt'); await gate(exempt, ec, true);
    assert.strictEqual((await submit(ec.cid)).status, 200);
    const ev = JSON.parse((await sqlGet("SELECT payload_json FROM sysbuild_events WHERE object_type = 'package_version' AND object_id = ? AND event_type = 'package_version_submitted' ORDER BY id DESC LIMIT 1", [ec.vid])).payload_json);
    assert.deepStrictEqual(ev.assessment, { exempt: 'dev_never_joined' });
    const s = await scene(); const c = await change(s);
    assert.strictEqual((await fact(c)).devAssessment, 'none'); await gate(s, c, false, '请先让开发方登记开发评估');
    await assess(s, c); assert.strictEqual((await fact(c)).devAssessment, 'ok');
    const p = await assess(s, c, U.x2); assert.strictEqual((await fact(c)).devAssessment, 'not_approved'); await gate(s, c, false, '尚未获');
    assert.strictEqual((await H.openAndDecide(U.x1, (await devTask(p.id)).tid, 'confirm')).status, 200);
    const changed = await patch(`/sysbuild/package-versions/${c.vid}`, { snapshot_json: { text: '新增了需要评估的范围说明' } }); assert.strictEqual(changed.status, 200, changed.text);
    assert.strictEqual((await fact(c)).devAssessment, 'stale'); await gate(s, c, false, '重新评估');
    await endOwner(s); assert.strictEqual((await fact(c)).devAssessment, 'dev_lead_vacant'); await gate(s, c, false, '先补任负责人');
    const newApt = await addAppointment(s.dev, s.owner, 'active'); assert.ok(newApt);
    for (const feasible of ['partial', 'no']) { await assess(s, c, U.x1, { feasible, impact_note: '仍存在接口条件，需要确认人知悉' }); assert.strictEqual((await fact(c)).devAssessment, 'ok'); await gate(s, c, true); }
    assert.strictEqual((await submit(c.cid)).status, 200);
  });

  test(`${P}负责人缺位仍可用既有认可——ok不受缺位影响，未曾生效的pending任职仍豁免`, async () => {
    const s = await scene(); const c = await change(s); await assess(s, c); await endOwner(s);
    assert.strictEqual((await fact(c)).devAssessment, 'ok'); await gate(s, c, true); assert.strictEqual((await submit(c.cid)).status, 200);
    const x = await scene(false); const dev = await addParty(x.pid, '未入场开发', 'dev'); const mid = await addMember(x.pid, U.x1, { party: dev }); await addAppointment(dev, mid, 'pending');
    const xc = await change(x); assert.strictEqual((await fact(xc)).devAssessment, 'exempt');
  });

  test(`${P}不可读评估不回退——较新异常阻断为unknown，旧异常不遮蔽新评估，作废后恢复`, async () => {
    const s = await scene(); const c = await change(s); const e = await assess(s, c);
    const bad = await assess(s, c, U.x2); await rawForm(bad.id, { v: 99, form: assessment(c.cid) });
    assert.strictEqual((await fact(c)).devAssessment, 'unknown'); await gate(s, c, false, '无法读取');
    const d = await detail(bad.id); assert.strictEqual(d.form_unreadable, true); assert.strictEqual(d.actions.void, true);
    assert.strictEqual((await act(bad.id, 'void')).status, 201); assert.strictEqual((await fact(c)).devAssessment, 'ok');
    await rawForm(e.id, { v: 2 }); await assess(s, c); assert.strictEqual((await fact(c)).devAssessment, 'ok', '较旧异常不覆盖新的已认可评估');
  });

  test(`${P}scope只读与六项摘要——版本、条目、快照、形态父版本、全部节点计划、四来源附件固定并被摘要覆盖`, async () => {
    const s = await scene(); const c = await change(s);
    const before = await sqlGet('SELECT (SELECT COUNT(*) FROM sysbuild_events) AS events, (SELECT COUNT(*) FROM sysbuild_confirm_tasks) AS tasks, (SELECT COUNT(*) FROM sysbuild_frozen_attachments) AS frozen');
    const verBefore = await sqlGet('SELECT * FROM sysbuild_package_versions WHERE id = ?', [c.vid]);
    const x = await scope(c);
    assert.deepStrictEqual(Object.keys(x.digestInput), ['version_id', 'items', 'snapshot', 'form_and_parent', 'node_plans', 'attachments']);
    assert.strictEqual(x.digestInput.version_id, c.vid);
    assert.ok(x.digestInput.items.length > 0); assert.strictEqual(x.digestInput.node_plans.length, (await sqlAll("SELECT id FROM sysbuild_nodes WHERE project_id = ? AND status <> 'cancelled'", [s.pid])).length);
    assert.deepStrictEqual(await sqlGet('SELECT * FROM sysbuild_package_versions WHERE id = ?', [c.vid]), verBefore);
    assert.deepStrictEqual(await sqlGet('SELECT (SELECT COUNT(*) FROM sysbuild_events) AS events, (SELECT COUNT(*) FROM sysbuild_confirm_tasks) AS tasks, (SELECT COUNT(*) FROM sysbuild_frozen_attachments) AS frozen'), before);
    // 手写字段顺序与固定结构；摘要不能省掉任何一项（不从服务端摘要算法导出期望）。
    const expectedInput = { version_id: c.vid, items: [[s.eff.itemVersionId, s.batch]], snapshot: '{}', form_and_parent: { form: 'overall_batch_req', parent: s.eff.pv }, node_plans: (await sqlAll("SELECT id FROM sysbuild_nodes WHERE project_id = ? AND status <> 'cancelled' ORDER BY id", [s.pid])).map((n) => [n.id, '2026-11-02', '2026-11-30']), attachments: [] };
    assert.deepStrictEqual(x.digestInput, expectedInput);
    assert.strictEqual(x.scope_digest, crypto.createHash('sha256').update(JSON.stringify(expectedInput)).digest('hex'));
  });

  for (const kind of ['items', 'snapshot', 'plan', 'change_attachment', 'item_attachment', 'form']) test(`${P}scope失效-${kind}——评估后改动被读写两端阻断`, async () => {
    const s = await scene(); const c = await change(s); await assess(s, c);
    if (kind === 'items') { const it = await H.mkItem(s.pid); assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${c.vid}/items`, { op: 'add', item_version_id: it.versions[0].id, committed_batch_id: s.batch })).status, 201); }
    if (kind === 'snapshot') assert.strictEqual((await patch(`/sysbuild/package-versions/${c.vid}`, { snapshot_json: { text: '补充送审范围' } })).status, 200);
    if (kind === 'plan') { const nid = (await sqlGet("SELECT id FROM sysbuild_nodes WHERE project_id = ? AND status <> 'cancelled' ORDER BY id LIMIT 1", [s.pid])).id; const r = await post(U.pm, `/sysbuild/nodes/${nid}/schedule`, { kind: 'plan', planned_start: '2026-11-02', planned_end: '2026-12-01', reason: '需求方要求延后一天交付', ...EVID }); assert.strictEqual(r.status, 201, r.text); }
    if (kind === 'change_attachment' || kind === 'item_attachment') { const aid = await H.stageAtt(s.pid, U.pm, 'c'); await sqlRun('INSERT INTO sysbuild_attachment_bindings (attachment_id, owner_type, owner_id, bound_by) VALUES (?, ?, ?, ?)', [aid, kind === 'change_attachment' ? 'change' : 'item_version', kind === 'change_attachment' ? c.cid : s.eff.itemVersionId, U.pm]); }
    // 夹具：模拟继承来源的形态事实变化，change 的重算读取当前生效总体版本的形态。
    if (kind === 'form') await sqlRun("UPDATE sysbuild_package_versions SET form = 'overall' WHERE id = ?", [s.eff.pv]);
    assert.strictEqual((await fact(c)).devAssessment, 'stale'); await gate(s, c, false, '重新评估');
  });

  test(`${P}提交快照及确认展示——payload固定五键、字段与认可信息，后续评估不替换已提交评估，旧版和豁免标志`, async () => {
    const s = await scene(); const c = await change(s); const e = await assess(s, c); const t = await devTask(e.id);
    assert.strictEqual((await submit(c.cid)).status, 200);
    const event = await sqlGet("SELECT id, payload_json FROM sysbuild_events WHERE object_type = 'package_version' AND object_id = ? AND event_type = 'package_version_submitted' ORDER BY id DESC LIMIT 1", [c.vid]); const payload = JSON.parse(event.payload_json);
    assert.deepStrictEqual(Object.keys(payload.assessment).sort(), ['approved_at', 'approved_by_member_id', 'confirm_task_revision_id', 'entry_id', 'scope_digest']);
    assert.deepStrictEqual([payload.assessment.entry_id, payload.assessment.scope_digest, payload.assessment.confirm_task_revision_id, payload.assessment.approved_by_member_id], [e.id, e.form.scope_digest, t.rid, s.owner]); assert.ok(payload.assessment.approved_at);
    const task = (await H.tasksOf(c.vid))[0];
    const view = await get(task.user_id, `/sysbuild/confirm-tasks/${task.task_id}`); assert.strictEqual(view.status, 200, view.text);
    assert.deepStrictEqual([view.body.object.assessment.entry_id, view.body.object.assessment.form.extra_person_days, view.body.object.assessment.approved_by_member_id, view.body.object.assessment.approved_at], [e.id, 2.5, s.owner, payload.assessment.approved_at]);
    const c2 = await change(s); await assess(s, c2, U.x1, { extra_person_days: 99 });
    const still = await get(task.user_id, `/sysbuild/confirm-tasks/${task.task_id}`); assert.strictEqual(still.body.object.assessment.entry_id, e.id); assert.strictEqual(still.body.object.assessment.form.extra_person_days, 2.5);
    const sheet = await get(U.pm, `/sysbuild/package-versions/${c.vid}/confirmation-sheet`); assert.strictEqual(sheet.status, 200, sheet.text); assert.ok(sheet.text.includes('开发评估')); assert.ok(sheet.text.includes('2.5'));
    const legacy = { ...payload }; delete legacy.assessment; await sqlRun('UPDATE sysbuild_events SET payload_json = ? WHERE id = ?', [JSON.stringify(legacy), event.id]);
    const old = await get(task.user_id, `/sysbuild/confirm-tasks/${task.task_id}`); assert.strictEqual(old.body.object.assessment.legacy, true);
    const oldSheet = await get(U.pm, `/sysbuild/package-versions/${c.vid}/confirmation-sheet`); assert.ok(oldSheet.text.includes('提交时没有开发评估记录（旧版）'));
    await sqlRun('UPDATE sysbuild_events SET payload_json = ? WHERE id = ?', [JSON.stringify({ ...payload, assessment: { exempt: 'dev_never_joined' } }), event.id]);
    const ex = await get(task.user_id, `/sysbuild/confirm-tasks/${task.task_id}`); assert.strictEqual(ex.body.object.assessment.exempt, 'dev_never_joined');
    const exSheet = await get(U.pm, `/sysbuild/package-versions/${c.vid}/confirmation-sheet`); assert.ok(exSheet.text.includes('开发方尚未入场，本次变更未做开发评估'));
  });

  test(`${P}放弃草稿——状态条件更新、待认可修订关闭、已认可保留、待确认消失、非变更草稿拒绝`, async () => {
    const s = await scene(); const c = await change(s); const approved = await assess(s, c); const pending = await assess(s, c, U.x2); const pt = await devTask(pending.id);
    assert.strictEqual((await chView(c.cid)).actions.withdraw, true);
    const w = await withdraw(c.vid); assert.strictEqual(w.status, 200, w.text);
    assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_changes WHERE id = ?', [c.cid])).status, 'withdrawn'); assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id = ?', [c.vid])).status, 'superseded');
    assert.strictEqual((await devTask(approved.id)).status, 'confirmed'); assert.strictEqual((await devTask(pending.id)).status, 'invalid');
    const rev = await sqlGet('SELECT status_reason FROM sysbuild_confirm_task_revisions WHERE id = ?', [pt.rid]); assert.strictEqual(rev.status_reason, '变更草稿已放弃');
    const my = await get(U.x1, '/sysbuild/my/confirmations'); assert.ok(!my.body.items.some((i) => i.revision_id === pt.rid));
    const ev = JSON.parse((await sqlGet("SELECT payload_json FROM sysbuild_events WHERE object_type = 'package_version' AND object_id = ? AND event_type = 'package_version_withdrawn' ORDER BY id DESC LIMIT 1", [c.vid])).payload_json); assert.strictEqual(ev.from_status, 'draft'); assert.ok(ev.invalidated_revision_ids.includes(pt.rid));
    expectErr(await submit(c.cid), 409, 'SYSBUILD_STATE', '放弃后不能提交'); expectErr(await withdraw(c.vid), 409, 'SYSBUILD_STATE', '状态已改变');
    assert.strictEqual((await act(approved.id, 'void')).status, 201, '放弃后评估可作废');
    const pid = await H.newProject(); const pk = await H.mkPackage(pid, 'initiation'); const vid = await H.mkVersion(pk); expectErr(await withdraw(vid), 409, 'SYSBUILD_STATE', '非变更草稿不可撤回');
    // 51 号 LOW-2：被放弃关闭的评估认可任务不能改发，文案说明是随变更草稿放弃而失效
    const re = await post(U.pm, `/sysbuild/confirm-tasks/${pt.tid}/reissue`, { reason: '尝试重新发给负责人' });
    expectErr(re, 409, 'SYSBUILD_STATE', '放弃后的评估任务不能改发'); assert.ok(re.body.message.includes('随变更草稿放弃而失效'), re.text);
  });

  test(`${P}放弃草稿使转变更结论失效——引用该变更的转正式变更结论随放弃落到to_change_lapsed（51号LOW-3）`, async () => {
    const s = await scene(); const c = await change(s);
    const r = await post(U.pm, `/sysbuild/projects/${s.pid}/entries`, { type: 'feedback', title: '希望增加导出', body: '希望能批量导出部门汇总数据' });
    assert.strictEqual(r.status, 201, r.text);
    const k = await post(U.pm, `/sysbuild/entries/${r.body.entry.id}/actions`, { action: 'conclude', conclusion_kind: 'to_change', text: '转正式变更处理', change_id: c.cid });
    assert.strictEqual(k.status, 201, k.text);
    assert.strictEqual((await detail(r.body.entry.id)).conclusion_state, 'settled_no_confirm');
    assert.strictEqual((await withdraw(c.vid)).status, 200);
    assert.strictEqual((await detail(r.body.entry.id)).conclusion_state, 'to_change_lapsed');
  });

  test(`${P}送审内容被拒先报原因——已认可评估后送审内容失效，提交给出原始拒绝原因而非评估不可读，权限仍先于内容（51号HIGH-1）`, async () => {
    const s = await scene(); const c = await change(s); const e = await assess(s, c);
    assert.strictEqual((await fact(c)).devAssessment, 'ok');
    const rm = await post(U.pm, `/sysbuild/package-versions/${c.vid}/items`, { op: 'remove', item_version_id: s.eff.itemVersionId });
    assert.ok(rm.status === 200 || rm.status === 201, rm.text);
    const f = await fact(c);
    assert.deepStrictEqual([f.devAssessment, f.scopeRejection && f.scopeRejection.code], ['unknown', 'SYSBUILD_STATE']);
    assert.strictEqual((await chView(c.cid)).actions.submit, false);
    expectErr(await post(U.m1, `/sysbuild/changes/${c.cid}/submit`), 403, 'SYSBUILD_FORBIDDEN', '权限先于送审内容');
    const sub = await submit(c.cid);
    expectErr(sub, 409, 'SYSBUILD_STATE', '送审内容被拒');
    assert.ok(sub.body.message.includes('条目集合为空'), sub.text); assert.ok(!sub.body.message.includes('无法读取'), sub.text);
    assert.strictEqual((await devTask(e.id)).status, 'confirmed', '已认可评估不受影响');
  });

  test(`${P}评估作废保护——待确认和生效保护全部关联评估，撤回解除`, async () => {
    const s = await scene(); const c = await change(s); const old = await assess(s, c); const latest = await assess(s, c);
    assert.strictEqual((await submit(c.cid)).status, 200);
    for (const e of [old, latest]) { assert.strictEqual((await detail(e.id)).actions.void, false); expectErr(await act(e.id, 'void'), 409, 'SYSBUILD_STATE', '待确认引用保护'); }
    await withdraw(c.vid); assert.strictEqual((await act(old.id, 'void')).status, 201);
    const c2 = await change(s); const e2 = await assess(s, c2); assert.strictEqual((await submit(c2.cid)).status, 200); await H.confirmAll(c2.vid);
    assert.strictEqual((await detail(e2.id)).actions.void, false); expectErr(await act(e2.id, 'void'), 409, 'SYSBUILD_STATE', '生效保护');
  });
  test(`${P}不可读引用依据——已有认可也不能成为办理依据或开发方改期依据`, async () => {
    const s = await scene(); const c = await change(s); const e = await assess(s, c);
    await rawForm(e.id, { v: 99, form: assessment(c.cid) });
    const r = await reg(U.m1, s.pid, request(), { ...EVID, item_ids: [s.item] }); assert.strictEqual(r.status, 201, r.text);
    const conclusion = await act(r.body.entry.id, 'conclude', { conclusion_kind: 'handled', basis_dev_note_entry_id: e.id });
    expectErr(conclusion, 409, 'SYSBUILD_STATE', '不可读依据'); assert.ok(conclusion.body.message.includes('表单不可读'), conclusion.text);
    const node = await sqlGet("SELECT id FROM sysbuild_nodes WHERE project_id = ? AND template_key = 'b_dev'", [s.pid]);
    const schedule = await post(U.pm, `/sysbuild/nodes/${node.id}/schedule`, { kind: 'plan', planned_start: '2026-11-02', planned_end: '2026-12-01', reason: '开发方评估后要求延后一日', source_party_id: s.dev, dev_key_entry_id: e.id, ...EVID });
    expectErr(schedule, 409, 'SYSBUILD_STATE', '不可读改期依据'); assert.ok(schedule.body.message.includes('表单不可读'), schedule.text);
  });
  test(`${P}评估版本绑定与事实失败——版本不同即stale，取数失败只给unknown`, async () => {
    const s = await scene(); const c = await change(s); const e = await assess(s, c);
    await rawForm(e.id, { v: 1, form: { ...e.form, package_version_id: c.vid + 100000 } });
    assert.strictEqual((await fact(c)).devAssessment, 'stale'); await gate(s, c, false, '重新评估');
    const ver = await sqlGet('SELECT * FROM sysbuild_package_versions WHERE id = ?', [c.vid]); const pkg = await sqlGet('SELECT * FROM sysbuild_packages WHERE id = ?', [ver.package_id]);
    const bad = await scopeMod().devAssessmentOf({ get: async () => { throw new Error('受控取数失败'); }, all: sqlAll }, pkg, ver);
    assert.deepStrictEqual(bad, { fact: 'unknown', payload: null });
  });
  async function fourSources() {
    const s = await scene(); const ca = await H.stageAtt(s.pid, U.pm, 'a');
    const c = await change(s, { attachment_ids: [ca], no_written_evidence: undefined, no_evidence_reason: undefined });
    const ia = await H.stageAtt(s.pid, U.pm, 'b'); const pa = await H.stageAtt(s.pid, U.pm, 'c'); const ma = await H.stageAtt(s.pid, U.pm, 'd');
    for (const [aid, type, id] of [[ia, 'item_version', s.eff.itemVersionId], [pa, 'package_version', c.vid]]) await sqlRun('INSERT INTO sysbuild_attachment_bindings (attachment_id, owner_type, owner_id, bound_by) VALUES (?, ?, ?, ?)', [aid, type, id, U.pm]);
    const n = await sqlGet("SELECT id FROM sysbuild_nodes WHERE project_id = ? AND template_key = 'p_initiation'", [s.pid]);
    const m = await post(U.pm, `/sysbuild/nodes/${n.id}/materials/l1-evidence/versions`, { name: '评估依据', body: '评估时的冻结材料', attachment_ids: [ma] }); assert.strictEqual(m.status, 201, m.text);
    const mid = m.body.version.id;
    assert.strictEqual((await patch(`/sysbuild/package-versions/${c.vid}`, { snapshot_json: { z: 1, material_version_ids: [mid], a: { z: 2, b: 3 } } })).status, 200);
    return { s, c, ca, ia, pa, ma, mid };
  }
  test(`${P}scope四来源附件——来源清单与冻结编号散列一致、快照递归排序`, async () => {
    const { s, c, ca, ia, pa, ma, mid } = await fourSources(); const x = await scope(c);
    assert.deepStrictEqual(x.digestInput.attachments, [
      { source_type: 'change', source_id: c.cid, attachment_id: ca, sha256: 'a'.repeat(64) },
      { source_type: 'item_version', source_id: s.eff.itemVersionId, attachment_id: ia, sha256: 'b'.repeat(64) },
      { source_type: 'material_version', source_id: mid, attachment_id: ma, sha256: 'd'.repeat(64) },
      { source_type: 'package_version', source_id: c.vid, attachment_id: pa, sha256: 'c'.repeat(64) },
    ]);
    assert.strictEqual(x.digestInput.snapshot, `{"a":{"b":3,"z":2},"material_version_ids":[${mid}],"z":1}`);
    await assess(s, c); assert.strictEqual((await submit(c.cid)).status, 200);
    const frozen = await sqlAll("SELECT attachment_id, sha256 FROM sysbuild_frozen_attachments WHERE object_type = 'package_version' AND object_version_id = ? ORDER BY attachment_id", [c.vid]);
    assert.deepStrictEqual(frozen, [[ca, 'a'], [ia, 'b'], [pa, 'c'], [ma, 'd']].sort((a, b) => a[0] - b[0]).map(([attachment_id, h]) => ({ attachment_id, sha256: h.repeat(64) })));
  });
  test(`${P}scope材料删除遮蔽——禁止过滤后继续提交，原样报出材料拒绝（51号HIGH-1）且冻结散列不改`, async () => {
    const { s, c, ma, mid } = await fourSources(); await assess(s, c);
    for (const kind of ['deleted', 'masked']) {
      if (kind === 'deleted') await sqlRun("UPDATE sysbuild_attachments SET deleted_at = datetime('now','localtime'), deleted_by = ? WHERE id = ?", [U.pm, ma]);
      else await sqlRun("UPDATE sysbuild_attachments SET masked_at = datetime('now','localtime'), masked_by = ?, mask_reason = '受控材料' WHERE id = ?", [U.pm, ma]);
      await assert.rejects(() => scope(c), (err) => err.code === 'SYSBUILD_INVALID_INPUT' && err.message.includes('已删除或已遮蔽'));
      const f = await fact(c);
      assert.deepStrictEqual([f.devAssessment, f.scopeRejection && f.scopeRejection.code], ['unknown', 'SYSBUILD_INVALID_INPUT']);
      assert.strictEqual((await chView(c.cid)).actions.submit, false);
      const r = await submit(c.cid); expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', `${kind} 材料拒绝原样报出`);
      assert.ok(r.body.message.includes('已删除或已遮蔽'), r.text); assert.ok(!r.body.message.includes('无法读取'), r.text);
      await sqlRun('UPDATE sysbuild_attachments SET deleted_at = NULL, deleted_by = NULL, masked_at = NULL, masked_by = NULL, mask_reason = NULL WHERE id = ?', [ma]);
    }
    assert.strictEqual((await sqlGet("SELECT sha256 FROM sysbuild_frozen_attachments WHERE object_type = 'material_version' AND object_version_id = ? AND attachment_id = ?", [mid, ma])).sha256, 'd'.repeat(64));
    assert.strictEqual((await fact(c)).devAssessment, 'ok');
  });
  test(`${P}放弃条件更新探针——两条SQL带draft条件且零行立即409`, async () => {
    const s = await scene(); const c = await change(s); const mod = require(path.join(T.getModuleDir(), 'confirm.js'));
    for (const failTable of ['sysbuild_package_versions', 'sysbuild_changes']) {
      const reached = [];
      const q = { get: sqlGet, all: sqlAll, run: async (sql, params) => {
        const match = /^UPDATE (sysbuild_package_versions|sysbuild_changes) SET status = /.exec(sql);
        if (match) {
          reached.push(match[1]); assert.ok(sql.includes("WHERE id = ? AND status = 'draft'"), '旧状态必须在UPDATE条件中');
          assert.deepStrictEqual(params, [match[1] === 'sysbuild_package_versions' ? c.vid : c.cid]);
          return { changes: match[1] === failTable ? 0 : 1, lastID: 700001 };
        }
        return { changes: 1, lastID: 700002 };
      } };
      const { router } = mod.createConfirmRoutes({ db: { withWriteTxn: (fn) => fn(q) }, logger: { error() {} }, readonlyIds: [], writeRoles: ['admin', 'publisher', 'user'], attachmentHelpers: { freezeAttachmentSet: async () => [] } });
      const layer = router.stack.find((x) => x.route && x.route.path === '/sysbuild/package-versions/:vid/withdraw');
      const user = await sqlGet('SELECT id, role, username, display_name FROM users WHERE id = ?', [U.pm]);
      const response = await new Promise((resolve) => {
        const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { resolve({ status: this.statusCode, body }); return this; } };
        layer.route.stack[layer.route.stack.length - 1].handle({ params: { vid: String(c.vid) }, body: { reason: '条件更新探针' }, user }, res);
      });
      assert.deepStrictEqual([response.status, response.body.code], [409, 'SYSBUILD_STATE']);
      assert.deepStrictEqual(reached, failTable === 'sysbuild_package_versions' ? ['sysbuild_package_versions'] : ['sysbuild_package_versions', 'sysbuild_changes']);
    }
    assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id = ?', [c.vid])).status, 'draft', '探针未写库');
  });
  test(`${P}不可读办理类作废解除收口阻塞——保留原登记但不再列入未结过程登记`, async () => {
    const s = await scene(false); const n = await sqlGet("SELECT id FROM sysbuild_nodes WHERE project_id = ? AND template_key = 'b_dev'", [s.pid]);
    const r = await reg(U.m1, s.pid, request(), { ...EVID, node_id: n.id }); assert.strictEqual(r.status, 201, r.text);
    await rawForm(r.body.entry.id, { v: 99 });
    const entriesCore = require(path.join(T.getModuleDir(), 'entries-core.js')); const q = { get: sqlGet, all: sqlAll };
    assert.ok((await entriesCore.unresolvedProcessEntriesOf(q, s.pid)).some((e) => e.id === r.body.entry.id));
    assert.strictEqual((await act(r.body.entry.id, 'void')).status, 201);
    assert.ok(!(await entriesCore.unresolvedProcessEntriesOf(q, s.pid)).some((e) => e.id === r.body.entry.id));
    assert.ok(await sqlGet('SELECT id FROM sysbuild_entries WHERE id = ?', [r.body.entry.id]));
  });
}

const mu = (id, expect, file, from, to) => ({ id: `L1 ${id}`, expect: [`${P}${expect}`], edits: [{ file, from, to }] });
const TRACE_L1_MUTATIONS = [
  mu('校验漏字段白名单', '表单字段反例', 'entry-forms.js', 'if (!allowed.includes(key)) throw invalid(', 'if (false) throw invalid('),
  mu('表单文本不核长度', '表单字段反例', 'entry-forms.js', 'length < min || length > max || rules.hasControlChar(value)', 'rules.hasControlChar(value)'),
  mu('评估数字不核范围', '表单字段反例', 'entry-forms.js', 'value < 0 || value > max ||', 'false ||'),
  mu('评估工时允许多位小数', '表单字段反例', 'entry-forms.js', 'Math.round(value * 10) / 10 !== value', 'false'),
  mu('评估工期允许小数', '表单字段反例', 'entry-forms.js', 'integer ? !Number.isInteger(value) :', 'integer ? false :'),
  mu('影响说明不必填', '表单字段反例', 'entry-forms.js', "days > 0 || form.feasible !== 'yes' ? 10 : 0", '0'),
  mu('互斥键遗漏', '互斥与类型用途', 'entry-forms.js', "['title', 'body', 'objects_entry_id', 'revision_of_entry_id']", '[]'),
  mu('不核类型用途', '互斥与类型用途', 'entry-forms.js', 'hasKey(body, key) && body[key] !== def[key]', 'false'),
  { id: 'L1 客户端承诺允许1', expect: [`${P}互斥与类型用途`], edits: [
    { file: 'entry-forms.js', from: 'body.commitment_flag === true || body.commitment_flag === 1', to: 'false' },
    { file: 'entry-forms.js', from: '![0, false, null].includes(body.commitment_flag)', to: '![0, 1, false, true, null].includes(body.commitment_flag)' },
  ] },
  mu('修改取消不需条目', '互斥与类型用途', 'entry-forms.js', "form.kind === 'change_request' && form.change_kind !== 'add' && (!Array.isArray(body.item_ids) || body.item_ids.length === 0)", 'false'),
  mu('需求申请用途错归一', '需求申请正例', 'entry-forms.js', "type: 'feedback', purpose: 'general'", "type: 'note', purpose: 'general'"),
  mu('开发评估用途错归一', '评估正例与权限', 'entry-forms.js', "type: 'note', purpose: 'dev_note'", "type: 'note', purpose: 'general'"),
  mu('生成标题缺前缀', '需求申请正例', 'entry-forms.js', 'title: `需求变更申请（', 'title: `（'),
  mu('派生范围指纹遗漏', '评估正例与权限', 'entry-forms.js', 'scope_digest: scope.scope_digest, package_version_id: ver.id', 'package_version_id: ver.id'),
  mu('派生版本遗漏', '评估正例与权限', 'entry-forms.js', 'scope_digest: scope.scope_digest, package_version_id: ver.id', 'scope_digest: scope.scope_digest'),
  mu('混合表单允许拆分', '混合归属与拆分', 'entries.js', 'if (parts.length > 1 && input.form) throw stateError(', 'if (false) throw stateError('),
  mu('不可读降级普通', '不可读登记', 'entry-forms.js', 'return Object.assign({}, empty, { form_unreadable: true });', 'return empty;'),
  mu('不可读动作放开', '不可读登记', 'rules.js', "(op.startsWith('entry_') || op === 'notice_object') && op !== 'entry_void' && t.formUnreadable === true", 'false'),
  mu('勘误丢失', '勘误只追加', 'entry-forms.js', "(actions || []).filter((a) => a.action === 'correct')", '[]'),
  mu('变更提交门放开', '变更门七值', 'rules.js', "t.packageType === 'change' && !['ok', 'exempt'].includes(t.devAssessment)", 'false'),
  mu('当前缺位错误豁免', '负责人缺位仍可用既有认可', 'submission-scope.js', 'if (!ever) return', 'if (!ever || !(await core.currentOwner(q, partyId))) return'),
  mu('较新不可读被跳过', '不可读评估不回退', 'submission-scope.js', "if (unreadableId > (latest ? latest.id : 0)) return { fact: 'unknown', payload: null };", ''),
  mu('错误回退最旧评估', '变更门七值', 'submission-scope.js', "if (!latest && parsed.form_kind === 'dev_assessment'", "if (parsed.form_kind === 'dev_assessment'"),
  mu('缺位恢复文案遗漏', '变更门七值', 'submission-scope.js', "if (['none', 'not_approved', 'stale'].includes(fact) && !(await core.currentOwner(q, partyId))) fact = 'dev_lead_vacant';", ''),
  mu('草稿不可放弃', '放弃草稿', 'rules.js', " || (t.packageType === 'change' && t.versionStatus === 'draft')", ''),
  mu('放弃不关评估任务', '放弃草稿', 'confirm.js', "await core.closePendingRevision(q, r.id, 'invalid', CHANGE_DRAFT_ABANDONED_REASON);", ''),
  // 51 号修复批：HIGH-1（送审内容被拒原样报出）、LOW-2（放弃后改发文案）、LOW-4（确认展示与归档单）
  mu('送审被拒仍记为评估不可读', '送审内容被拒先报原因', 'submission-scope.js', "return { fact: 'unknown', payload: null, scopeRejection: { status: err.status, code: err.code, message: err.message } };", 'throw err;'),
  mu('规则不先报送审拒绝', '送审内容被拒先报原因', 'rules.js', "if (t.packageType === 'change' && t.scopeRejection) return", 'if (false) return'),
  mu('送审拒绝状态码一律409', 'scope材料删除遮蔽', 'rules.js', '{ status: msg.status === 400 ? 400 : 409, code: msg.code', '{ status: 409, code: msg.code'),
  mu('放弃评估改发文案退回通用', '放弃草稿', 'confirm.js', 'if (c.latest.status_reason === CHANGE_DRAFT_ABANDONED_REASON) return', 'if (false) return'),
  mu('确认展示改取最新评估', '提交快照及确认展示', 'assessment-view.js', 'FROM sysbuild_entries WHERE id = ? AND project_id = ?`, [a.entry_id, projectId]);', "FROM sysbuild_entries WHERE project_id = ? AND purpose = 'dev_note' ORDER BY id DESC LIMIT 1`, [projectId]);"),
  mu('归档单不显示评估', '提交快照及确认展示', 'confirmation-sheet.js', "${m.change === null ? '' : renderAssessmentRows(m.assessment)}", ''),
  mu('作废保护漏评估', '评估作废保护', 'rules.js', "(t.formKind === 'dev_assessment' || t.formUnreadable === true) && t.usedByActiveChange !== false", 'false'),
  mu('提交遗漏固定评估', '提交快照及确认展示', 'confirm.js', 'change_id: changeRow.id, assessment: assessment.payload', 'change_id: changeRow.id'),
  mu('不可读引用仍认可', '不可读引用依据', 'entries-core.js', "if (forms.readEntryForm(entry).form_unreadable) return { ok: false, reason: '表单不可读，不能作为已认可的关键事项使用' };", ''),
  mu('需求申请不核方向证据', '需求申请正例', 'entries.js', "input.commitment === 1 || (input.form && input.form.kind === 'change_request')", 'input.commitment === 1'),
  mu('补选混合洗掉表单', '混合归属与拆分', 'entries.js', 'noSplit: target.needsDevConfirm === true || target.formKind !== null', 'noSplit: target.needsDevConfirm === true'),
  mu('手动拆分不核表单', '混合归属与拆分', 'rules.js', "if (t.formKind) return '带表单的登记不能拆分，请分开登记';", ''),
  mu('评估不核版本', '评估版本绑定与事实失败', 'submission-scope.js', 'latestForm.package_version_id !== ver.id || latestForm.scope_digest !== current.scope_digest', 'latestForm.scope_digest !== current.scope_digest'),
  mu('取数异常错误豁免', '评估版本绑定与事实失败', 'submission-scope.js', "} catch (_) {\n    return { fact: 'unknown', payload: null };", "} catch (_) {\n    return { fact: 'exempt', payload: { exempt: 'dev_never_joined' } };"),
  mu('scope漏条目附件来源', 'scope四来源附件', 'submission-scope.js', "const owners = items.map((it) => ({ ownerType: 'item_version', ownerId: it.item_version_id }));", 'const owners = [];'),
  mu('scope漏包附件来源', 'scope四来源附件', 'submission-scope.js', "owners.push({ ownerType: 'package_version', ownerId: ver.id });", ''),
  mu('scope漏变更附件来源', 'scope四来源附件', 'submission-scope.js', "if (change) owners.push({ ownerType: 'change', ownerId: change.id });", ''),
  mu('scope漏材料附件来源', 'scope四来源附件', 'submission-scope.js', "manifest.push({ source_type: 'material_version', source_id: material.id, attachment_id: r.attachment_id, sha256: r.sha256 });", ''),
  mu('快照未递归排序', 'scope四来源附件', 'submission-scope.js', "Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k]))", "Object.keys(value).map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k]))"),
  mu('scope材料不可用仍通过', 'scope材料删除遮蔽', 'submission-scope.js', "const materials = await materialsCore.selectedMaterials(q, pkg.project_id, ver.snapshot_json, { usable: true });", "const materials = await materialsCore.selectedMaterials(q, pkg.project_id, ver.snapshot_json, { usable: false });"),
  mu('草稿版本更新丢旧状态', '放弃条件更新探针', 'confirm.js', "SET status = 'superseded', updated_at = datetime('now','localtime') WHERE id = ? AND status = 'draft'\", [ver.id]", "SET status = 'superseded', updated_at = datetime('now','localtime') WHERE id = ?\", [ver.id]"),
  mu('草稿变更更新丢旧状态', '放弃条件更新探针', 'confirm.js', "SET status = 'withdrawn', updated_at = datetime('now','localtime') WHERE id = ? AND status = 'draft'\", [ch.id]", "SET status = 'withdrawn', updated_at = datetime('now','localtime') WHERE id = ?\", [ch.id]"),
  mu('放弃版本零行未拒绝', '放弃条件更新探针', 'confirm.js', "if (up.changes === 0) throw stateError('版本状态已变化，请刷新后重试');\n      const revs", 'const revs'),
  mu('放弃变更零行未拒绝', '放弃条件更新探针', 'confirm.js', "if (cu.changes === 0) throw stateError('变更状态已变化，请刷新后重试');\n        await emit(q, user, pkg.project_id", 'await emit(q, user, pkg.project_id'),
  ...[
    ['版本', '    version_id: ver.id, // L1 scope: version\n'],
    ['条目', '    items: items.slice().sort((a, b) => a.item_version_id - b.item_version_id).map((it) => [it.item_version_id, it.committed_batch_id]), // L1 scope: items\n'],
    ['快照', '    snapshot, // L1 scope: snapshot\n'],
    ['形态父版', '    form_and_parent: calc, // L1 scope: form\n'],
    ['节点计划', '    node_plans: nodePlans.map((n) => [n.node_id, n.planned_start, n.planned_end]).sort((a, b) => a[0] - b[0]), // L1 scope: plans\n'],
    ['附件', "    attachments: manifest.sort((a, b) => (a.source_type < b.source_type ? -1 : a.source_type > b.source_type ? 1 : 0) || a.source_id - b.source_id || a.attachment_id - b.attachment_id), // L1 scope: attachments\n"],
  ].map(([label, from]) => mu(`scope漏${label}`, 'scope只读与六项摘要', 'submission-scope.js', from, '')),
];
module.exports = { defineTraceL1Cases, TRACE_L1_MUTATIONS };
