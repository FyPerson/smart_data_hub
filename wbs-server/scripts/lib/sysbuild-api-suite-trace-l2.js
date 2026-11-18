// #213 L2：汇报、立项依据与上线附件。HTTP 与进程内变异共用；期望值手写。
// SQL 仅用于身份/附件夹具、日期历史与不可读载荷；业务正反例走真实端点。
'use strict';
const assert = require('assert');
const path = require('path');
const P = 'L2 留痕：';
const CB = '我已阅读以上全部内容，确认无误';
const EVID = { no_written_evidence: true, no_evidence_reason: '已通过线下会议确认本次里程碑影响' };
const DONE = '已完成本期接口开发和联调验证';
const NEXT = '下期继续完成剩余接口和回归验证';
const REASON = '请补充说明本次联调问题的处理进展';
const reportForm = (extra) => Object.assign({ kind: 'progress_report', due_on: null, done: DONE, next: NEXT, risks: null, milestone_impact: false }, extra || {});
const cycleForm = (date, cycle = 'weekly') => ({ kind: 'report_cycle', cycle, first_due_on: date, note: '请按期汇报开发进展' });
const requestForm = (date) => ({ kind: 'report_request', due_on: date, reason: REASON });
const plusDays = (date, n) => { const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function defineTraceL2Cases(T) {
  const { test, U, api, sqlRun, sqlGet, sqlAll, expectErr, addMember, addParty, addAppointment, addDelegation, confirm: H } = T;
  const q = { get: sqlGet, all: sqlAll };
  const mod = (file) => require(path.join(T.getModuleDir(), file));
  const post = (uid, url, body) => api(uid, 'POST', url, body === undefined ? {} : body);
  const get = (uid, url) => api(uid, 'GET', url);
  const patch = (url, body) => api(U.pm, 'PATCH', url, body);
  const reg = (s, uid, form, extra) => post(uid, `/sysbuild/projects/${s.pid}/entries`, { form, node_id: s.node.id, ...extra });
  const action = (eid, name, extra) => post(U.pm, `/sysbuild/entries/${eid}/actions`, name === 'split'
    ? { action: name, text: '核实原始记录后按条目拆分', groups: [[1], [2]], ...extra }
    : { action: name, [name === 'correct' ? 'text' : 'reason']: '核实原始记录后追加本次办理说明', ...extra });
  const entry = async (eid) => { const r = await get(U.pm, `/sysbuild/entries/${eid}`); assert.strictEqual(r.status, 200, r.text); return r.body.entry; };
  const plan = async (pid) => { const r = await get(U.pm, `/sysbuild/projects/${pid}/plan`); assert.strictEqual(r.status, 200, r.text); return r.body; };
  const nodeView = async (s) => (await plan(s.pid)).nodes.find((n) => n.id === s.node.id);
  const nodeRow = (s) => sqlGet('SELECT * FROM sysbuild_nodes WHERE id = ?', [s.node.id]);
  const start = (s, uid = U.pm) => post(uid, `/sysbuild/nodes/${s.node.id}/start`);
  const schedule = (s, date) => post(U.pm, `/sysbuild/nodes/${s.node.id}/schedule`, { kind: 'plan', planned_start: date, planned_end: plusDays(date, 90) });
  const task = (eid) => sqlGet("SELECT t.id AS tid,r.id AS rid,r.status FROM sysbuild_confirm_tasks t JOIN sysbuild_confirm_task_revisions r ON r.task_id=t.id WHERE t.object_type='dev_entry' AND t.object_id=? ORDER BY r.id DESC LIMIT 1", [eid]);
  const todo = async (uid) => { const r = await get(uid, '/sysbuild/my/todo'); assert.strictEqual(r.status, 200, r.text); assert.strictEqual(r.body.counts.badge, r.body.counts.confirm + r.body.counts.accept, 'L2 新类别不进入角标'); return r.body; };
  const mine = (t, key, pid) => t.items[key].filter((v) => v.project_id === pid);
  let todayCache = null;
  async function today() {
    if (todayCache) return todayCache;
    const pid = await H.newProject();
    const n = await sqlGet("SELECT id FROM sysbuild_nodes WHERE project_id=? AND template_key='b_req'", [pid]);
    const r = await post(U.pm, `/sysbuild/nodes/${n.id}/start`);
    assert.strictEqual(r.status, 200, r.text);
    todayCache = r.body.node.actual_start;
    assert.match(todayCache, /^\d{4}-\d{2}-\d{2}$/);
    if (T.getFixedToday && T.getFixedToday()) assert.strictEqual(todayCache, '2090-11-15', '进程内 todayProvider 固定日');
    return todayCache;
  }
  async function scene({ withDev = true, withPlan = true, withCycle = false, started = false, buildType = 'inhouse' } = {}) {
    const pid = await H.newProject(buildType);
    const demand = await H.seedParty(pid, '需求部门', U.own, U.del);
    await addMember(pid, U.m1, { party: demand.party });
    const node = await sqlGet("SELECT * FROM sysbuild_nodes WHERE project_id=? AND template_key=?", [pid, buildType === 'procurement' ? 'b_config' : 'b_dev']);
    const s = { pid, node, batch: await H.defaultBatchId(pid), demand: demand.party, today: await today() };
    if (withDev) {
      s.dev = await addParty(pid, '开发方', 'dev');
      s.owner = await addMember(pid, U.x1, { party: s.dev });
      s.apt = await addAppointment(s.dev, s.owner, 'active');
      s.delegate = await addMember(pid, U.x2, { party: s.dev });
      s.dlg = await addDelegation(s.dev, s.delegate, s.apt, 'active');
      await addMember(pid, U.x3, { party: s.dev });
    }
    if (withPlan) { const r = await schedule(s, s.today); assert.strictEqual(r.status, 201, r.text); }
    if (withCycle || started) { const r = await reg(s, U.pm, cycleForm(s.today)); assert.strictEqual(r.status, 201, r.text); s.cycle = r.body.entry; }
    if (started) { const r = await start(s); assert.strictEqual(r.status, 200, r.text); }
    return s;
  }
  const rawForm = (eid, value) => sqlRun('UPDATE sysbuild_entries SET routing_json=? WHERE id=?', [JSON.stringify(value), eid]);
  async function seedForm(s, form, { voided = false, commitment = false } = {}) {
    const result = await sqlRun(
      "INSERT INTO sysbuild_entries(project_id,node_id,type,purpose,commitment_flag,commitment_flag_source,source_party_id,operator_user_id,operator_identity_snapshot,period,title,body,routing_json) VALUES (?,?,'note','general',?,?,?,?,?,'process','日历历史夹具','日历历史夹具',?)",
      [s.pid, s.node.id, commitment ? 1 : 0, commitment ? 'submitter' : null, s.dev || null, U.pm, '{}', JSON.stringify({ v: 1, form })]
    );
    if (voided) await sqlRun("INSERT INTO sysbuild_entry_actions(entry_id,action,text,created_by) VALUES (?,'void','历史夹具已作废',?)", [result.lastID, U.pm]);
    return result.lastID;
  }
  async function calendar({ first = '2024-01-01', cycle = 'weekly', started = '2024-01-01', now = '2024-02-15', withCycle = true } = {}) {
    const pid = await H.newProject();
    const node = await sqlGet("SELECT * FROM sysbuild_nodes WHERE project_id=? AND template_key='b_dev'", [pid]);
    const s = { pid, node, batch: node.batch_id, today: now };
    await sqlRun("UPDATE sysbuild_nodes SET status='in_progress',opened_at=? WHERE id=?", [started + ' 00:00:00', node.id]);
    await sqlRun("INSERT INTO sysbuild_node_schedule_records(node_id,kind,actual_date,created_by) VALUES (?,'actual_start',?,?)", [node.id, started, U.pm]);
    if (withCycle) s.cycleId = await seedForm(s, cycleForm(first, cycle));
    s.provider = () => s.today;
    s.due = async (cutoff) => mod('report-core.js').dueDatesOf(q, await nodeRow(s), cutoff, s.provider);
    s.view = async () => mod('report-core.js').reportViewOf(q, await nodeRow(s), s.provider);
    return s;
  }
  const dates = (items) => items.map((x) => x.due_on);

  test(`${P}三表单正例与读视图——固定标题正文、类型用途、列表元数据与里程碑提示`, async () => {
    const s = await scene({ started: true });
    assert.deepStrictEqual([s.cycle.type, s.cycle.purpose, s.cycle.form_kind, s.cycle.form_label], ['note', 'general', 'report_cycle', '汇报节奏']);
    assert.strictEqual(s.cycle.title, `汇报节奏：每周，首次应交 ${s.today}`);
    assert.strictEqual(s.cycle.body, `汇报节奏：每周，首次应交 ${s.today}\n\n请按期汇报开发进展`);
    const rq = await reg(s, U.pm, requestForm(s.today)); assert.strictEqual(rq.status, 201, rq.text);
    assert.deepStrictEqual([rq.body.entry.type, rq.body.entry.purpose, rq.body.entry.form_label, rq.body.entry.title, rq.body.entry.body], ['note', 'general', '临时汇报要求', `临时汇报要求：${s.today} 前`, REASON]);
    const f = reportForm({ due_on: s.today }); const r = await reg(s, U.x2, f); assert.strictEqual(r.status, 201, r.text);
    assert.deepStrictEqual([r.body.entry.type, r.body.entry.purpose, r.body.entry.form_kind, r.body.entry.form_label, r.body.entry.title], ['note', 'general', 'progress_report', '进度汇报', `进度汇报（应交日 ${s.today}）`]);
    assert.strictEqual(r.body.entry.body, `已完成\n${DONE}\n\n下一步\n${NEXT}\n\n风险\n无\n\n是否影响里程碑：否`);
    assert.deepStrictEqual((await entry(r.body.entry.id)).form, f);
    assert.ok(!(await task(r.body.entry.id)), '不影响里程碑不建认可任务');
    const list = await get(U.pm, `/sysbuild/projects/${s.pid}/entries`); assert.strictEqual(list.status, 200, list.text);
    assert.deepStrictEqual(list.body.registration.forms.map((x) => x.kind), ['change_request', 'dev_assessment', 'progress_report', 'report_cycle', 'report_request']);
    assert.deepStrictEqual(list.body.entries.find((x) => x.id === r.body.entry.id).form, f);
    for (const id of [s.cycle.id, rq.body.entry.id, r.body.entry.id]) {
      assert.deepStrictEqual(await sqlGet('SELECT commitment_flag,commitment_flag_source FROM sysbuild_entries WHERE id=?', [id]), { commitment_flag: 0, commitment_flag_source: null });
    }
    const impact = await reg(s, U.x2, reportForm({ milestone_impact: true }), EVID); assert.strictEqual(impact.status, 201, impact.text);
    assert.strictEqual(impact.body.milestone_warning, '本次汇报影响里程碑，请 PM 评估是否发起改期');
  });

  test(`${P}三表单逐字段校验——必填类型长度日期取值未知键与派生键`, async () => {
    const s = await scene({ started: true });
    const bases = [reportForm(), cycleForm(s.today), requestForm(s.today)];
    const bad = [];
    for (const [base, required] of [[bases[0], ['kind', 'done', 'next', 'milestone_impact']], [bases[1], ['kind', 'cycle', 'first_due_on']], [bases[2], ['kind', 'due_on', 'reason']]]) {
      for (const key of required) { const b = { ...base }; delete b[key]; bad.push(b); }
      for (const key of ['extra', 'scope_digest', 'package_version_id']) bad.push({ ...base, [key]: 1 });
    }
    for (const [key, values] of Object.entries({ done: ['', '短', 1, '字'.repeat(2001)], next: ['', '短', 1, '字'.repeat(2001)], risks: [1, '字'.repeat(1001)], milestone_impact: [null, 0, 1, 'true'], due_on: [1, '2024-02-30', '1999-01-01', '2100-01-01', '2024-1-01'] })) for (const value of values) bad.push({ ...bases[0], [key]: value });
    for (const [key, values] of Object.entries({ cycle: ['daily', 1, null], first_due_on: ['', null, 1, '2024-02-30'], note: [1, '字'.repeat(501)] })) for (const value of values) bad.push({ ...bases[1], [key]: value });
    for (const [key, values] of Object.entries({ due_on: ['', null, 1, '2024-02-30'], reason: ['', '短', 1, '字'.repeat(501)] })) for (const value of values) bad.push({ ...bases[2], [key]: value });
    const before = (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE project_id=?', [s.pid])).n;
    for (const f of bad) expectErr(await reg(s, U.pm, f, { source_party_id: s.dev }), 400, 'SYSBUILD_INVALID_INPUT', JSON.stringify(f).slice(0, 100));
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE project_id=?', [s.pid])).n, before, '校验失败整笔回滚');
    // 历法反例必须位于允许的未来区间，避免被“早于今天/计划”掩盖日历校验失效。
    const futureYear = Number(s.today.slice(0, 4)) + 1;
    const validFuture = `${futureYear}-02-28`; const invalidFuture = `${futureYear}-02-30`;
    const current = await nodeView(s); assert.strictEqual(current.status, 'in_progress');
    assert.ok(current.current_plan && current.current_plan.start <= validFuture); assert.ok(validFuture > s.today);
    const control = await reg(s, U.pm, cycleForm(validFuture)); assert.strictEqual(control.status, 201, control.text);
    expectErr(await reg(s, U.pm, cycleForm(invalidFuture)), 400, 'SYSBUILD_INVALID_INPUT', '未来2月30日仍须被历法校验拒绝');
  });

  test(`${P}三表单互斥与规范化——禁止客户端承诺及修订异议、self_confirm_text限影响汇报`, async () => {
    const s = await scene({ started: true });
    for (const form of [reportForm(), cycleForm(s.today), requestForm(s.today)]) {
      for (const key of ['title', 'body', 'objects_entry_id', 'revision_of_entry_id']) expectErr(await reg(s, U.pm, form, { source_party_id: s.dev, [key]: null }), 400, 'SYSBUILD_INVALID_INPUT', key);
      for (const extra of [{ type: 'issue' }, { purpose: 'dev_note' }, { commitment_flag: 1 }, { commitment_flag: true }, { self_confirm_text: CB }]) expectErr(await reg(s, U.pm, form, { source_party_id: s.dev, ...extra }), 400, 'SYSBUILD_INVALID_INPUT', JSON.stringify(extra));
    }
    const impact = reportForm({ milestone_impact: true });
    expectErr(await reg(s, U.x1, impact, { self_confirm_text: CB }), 400, 'SYSBUILD_EVIDENCE_REQUIRED', '服务端置承诺后须核方向证据');
    expectErr(await reg(s, U.x1, impact, EVID), 400, 'SYSBUILD_INVALID_INPUT', '本人提交须确认文案');
    const ok = await reg(s, U.x1, impact, { ...EVID, self_confirm_text: CB }); assert.strictEqual(ok.status, 201, ok.text);
    assert.deepStrictEqual(await sqlGet('SELECT commitment_flag,commitment_flag_source FROM sysbuild_entries WHERE id=?', [ok.body.entry.id]), { commitment_flag: 1, commitment_flag_source: 'submitter' });
    assert.strictEqual((await task(ok.body.entry.id)).status, 'confirmed');
    const aid = await H.stageAtt(s.pid, U.x2);
    const byDelegate = await reg(s, U.x2, impact, { attachment_ids: [aid] }); assert.strictEqual(byDelegate.status, 201, byDelegate.text);
    assert.strictEqual((await task(byDelegate.body.entry.id)).status, 'pending');
    const byPm = await reg(s, U.pm, impact, { ...EVID, source_party_id: s.dev }); assert.strictEqual(byPm.status, 201, byPm.text); assert.strictEqual((await task(byPm.body.entry.id)).status, 'pending');
  });

  test(`${P}登记人来源与节点——PM设节奏要求、开发负责人代表人或PM代报、开发节点及状态限定`, async () => {
    const s = await scene({ started: true });
    for (const uid of [U.x1, U.x2, U.m1]) for (const f of [cycleForm(s.today), requestForm(s.today)]) expectErr(await reg(s, uid, f), 403, 'SYSBUILD_FORBIDDEN', '仅PM');
    for (const uid of [U.x3, U.m1]) expectErr(await reg(s, uid, reportForm()), 403, 'SYSBUILD_FORBIDDEN', '非开发负责人代表人');
    expectErr(await reg(s, U.pm, reportForm()), 400, 'SYSBUILD_INVALID_INPUT', 'PM须指定开发来源');
    expectErr(await reg(s, U.pm, reportForm(), { source_party_id: s.demand }), 400, 'SYSBUILD_INVALID_INPUT', '错误来源方');
    const pm = await reg(s, U.pm, reportForm(), { source_party_id: s.dev }); assert.strictEqual(pm.status, 201, pm.text);
    const foreign = await scene(); const req = await sqlGet("SELECT id FROM sysbuild_nodes WHERE project_id=? AND template_key='b_req'", [s.pid]);
    // 非开发节点具备合法计划且已经开始，拒绝只能来自开发承载节点身份，不能由状态/计划兜底。
    const ordinary = { ...s, node: req };
    const ordinaryPlan = await schedule(ordinary, s.today); assert.strictEqual(ordinaryPlan.status, 201, ordinaryPlan.text);
    const ordinaryStart = await start(ordinary); assert.strictEqual(ordinaryStart.status, 200, ordinaryStart.text);
    const ordinaryView = await nodeView(ordinary); assert.strictEqual(ordinaryView.status, 'in_progress'); assert.strictEqual(ordinaryView.current_plan.start, s.today);
    assert.notStrictEqual((await mod('report-core.js').developmentNodeOf(q, s.batch)).id, req.id);
    expectErr(await reg(s, U.pm, reportForm(), { source_party_id: s.dev, node_id: req.id }), 400, 'SYSBUILD_INVALID_INPUT', '已开始有计划的普通节点仍不能承载主动汇报');
    for (const nodeId of [null, req.id, foreign.node.id, 99999999]) for (const f of [reportForm(), cycleForm(s.today), requestForm(s.today)]) {
      const r = await reg(s, U.pm, f, { source_party_id: s.dev, node_id: nodeId }); expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', '关联节点不符');
    }
    const unopened = await scene();
    for (const f of [reportForm(), requestForm(s.today)]) expectErr(await reg(unopened, U.pm, f, { source_party_id: unopened.dev }), 400, 'SYSBUILD_INVALID_INPUT', '未开始不能报进度或临时要求');
    const c = await post(U.pm, `/sysbuild/nodes/${s.node.id}/close`); assert.strictEqual(c.status, 200, c.text);
    for (const f of [reportForm(), cycleForm(s.today), requestForm(s.today)]) expectErr(await reg(s, U.pm, f, { source_party_id: s.dev }), 400, 'SYSBUILD_INVALID_INPUT', '收口不接受三表单');
  });

  test(`${P}汇报日期校验——节奏须计划、首次不早于计划和今天、临时31天边界、真实应交校验`, async () => {
    const s = await scene({ withPlan: false });
    expectErr(await reg(s, U.pm, cycleForm(s.today)), 400, 'SYSBUILD_INVALID_INPUT', '无计划');
    const future = plusDays(s.today, 7); assert.strictEqual((await schedule(s, future)).status, 201);
    expectErr(await reg(s, U.pm, cycleForm(s.today)), 400, 'SYSBUILD_INVALID_INPUT', '早于计划开始');
    assert.strictEqual((await reg(s, U.pm, cycleForm(future))).status, 201);
    assert.strictEqual((await start(s)).status, 200);
    expectErr(await reg(s, U.pm, cycleForm(plusDays(s.today, -1))), 400, 'SYSBUILD_INVALID_INPUT', '进行中不得早于今天');
    for (const date of [plusDays(s.today, -1), plusDays(s.today, 32)]) expectErr(await reg(s, U.pm, requestForm(date)), 400, 'SYSBUILD_INVALID_INPUT', '临时窗口外');
    const far = plusDays(s.today, 31); assert.strictEqual((await reg(s, U.pm, requestForm(far))).status, 201);
    expectErr(await reg(s, U.x2, reportForm({ due_on: plusDays(s.today, 1) })), 400, 'SYSBUILD_INVALID_INPUT', '不是真实应交日');
    assert.strictEqual((await reg(s, U.x2, reportForm({ due_on: far }))).status, 201, '31天内真实应交可提前交');
  });

  test(`${P}组合矩阵与勘误——节奏不可作废、节奏要求不可补取消标记、字段不变`, async () => {
    const s = await scene({ started: true }); const rq = await reg(s, U.pm, requestForm(s.today)); assert.strictEqual(rq.status, 201, rq.text);
    for (const eid of [s.cycle.id, rq.body.entry.id]) {
      const before = await sqlGet('SELECT routing_json FROM sysbuild_entries WHERE id=?', [eid]);
      const d = await entry(eid);
      for (const name of ['mark_commitment', 'unmark_commitment', 'mark_risk', 'unmark_risk', 'split']) {
        assert.strictEqual(d.actions[name], false, name);
        expectErr(await action(eid, name), 409, 'SYSBUILD_STATE', name);
      }
      const c = await action(eid, 'correct'); assert.strictEqual(c.status, 201, c.text);
      assert.deepStrictEqual(await sqlGet('SELECT routing_json FROM sysbuild_entries WHERE id=?', [eid]), before);
      const after = await entry(eid); assert.strictEqual(after.has_correction, true); assert.strictEqual(after.corrections.length, 1);
    }
    assert.strictEqual((await entry(s.cycle.id)).actions.void, false);
    expectErr(await action(s.cycle.id, 'void'), 409, 'SYSBUILD_STATE', '节奏不可作废');
    assert.strictEqual((await entry(rq.body.entry.id)).actions.void, true);
    assert.strictEqual((await action(rq.body.entry.id, 'void')).status, 201);
  });

  test(`${P}开始门与开发节点——缺计划缺节奏拒绝、读写同源、非开发节点不受限`, async () => {
    const s = await scene({ withPlan: false });
    assert.strictEqual((await nodeView(s)).actions.start, false); expectErr(await start(s), 409, 'SYSBUILD_STATE', '缺计划');
    assert.strictEqual((await schedule(s, s.today)).status, 201);
    assert.strictEqual((await nodeView(s)).actions.start, false); const denied = await start(s); expectErr(denied, 409, 'SYSBUILD_STATE', '缺节奏'); assert.ok(denied.body.message.includes('汇报节奏'));
    const n = await sqlGet("SELECT id FROM sysbuild_nodes WHERE project_id=? AND template_key='b_req'", [s.pid]);
    assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${n.id}/start`)).status, 200, '非开发节点无需计划节奏');
    assert.strictEqual((await reg(s, U.pm, cycleForm(s.today))).status, 201);
    assert.strictEqual((await nodeView(s)).actions.start, true);
    expectErr(await start(s, U.x2), 403, 'SYSBUILD_FORBIDDEN', '仍须PM');
    const begun = await start(s); assert.strictEqual(begun.status, 200, begun.text); assert.strictEqual(begun.body.node.actual_start, s.today);
    assert.strictEqual((await nodeView(s)).actions.start, false);
  });

  test(`${P}开发节点稳定选择——模板优先、采购合并G3、自定义最小编号、改序取消与无G3`, async () => {
    for (const [buildType, key] of [['inhouse', 'b_dev'], ['outsource', 'b_dev'], ['procurement', 'b_config']]) {
      const s = await scene({ withPlan: false, buildType });
      const a = await sqlRun("INSERT INTO sysbuild_nodes(project_id,batch_id,name,g_stage,sort_order) VALUES (?,?,'自定义开发一','G3',-100)", [s.pid, s.batch]);
      const b = await sqlRun("INSERT INTO sysbuild_nodes(project_id,batch_id,name,g_stage,sort_order) VALUES (?,?,'自定义开发二','G3',-200)", [s.pid, s.batch]);
      let dev = await mod('report-core.js').developmentNodeOf(q, s.batch); assert.strictEqual(dev.id, s.node.id); assert.strictEqual(dev.template_key, key);
      assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${a.lastID}/start`)).status, 200, '其他G3节点不受开始门限制');
      // 取消后承载规则只看编号，非排序；将非目标节点恢复未开始是隔离状态夹具。
      await sqlRun("UPDATE sysbuild_nodes SET status='not_started',opened_at=NULL WHERE id=?", [a.lastID]);
      const cancelled = await post(U.pm, `/sysbuild/nodes/${s.node.id}/cancel`, { reason: '改用自定义开发节点承载' }); assert.strictEqual(cancelled.status, 200, cancelled.text);
      dev = await mod('report-core.js').developmentNodeOf(q, s.batch); assert.strictEqual(dev.id, a.lastID);
      await sqlRun('UPDATE sysbuild_nodes SET sort_order=999 WHERE id=?', [a.lastID]);
      assert.strictEqual((await mod('report-core.js').developmentNodeOf(q, s.batch)).id, a.lastID);
      await sqlRun("UPDATE sysbuild_nodes SET status='cancelled' WHERE id IN (?,?)", [a.lastID, b.lastID]);
      assert.strictEqual(await mod('report-core.js').developmentNodeOf(q, s.batch), null);
    }
  });

  for (const [label, cycle, first, now, cutoff, expected] of [
    ['每周', 'weekly', '2024-01-01', '2024-01-15', '2024-02-01', ['2024-01-01','2024-01-08','2024-01-15','2024-01-22','2024-01-29']],
    ['每两周', 'biweekly', '2024-01-01', '2024-01-15', '2024-02-01', ['2024-01-01','2024-01-15','2024-01-29']],
    ['非闰年月末31日', 'monthly', '2023-01-31', '2023-03-31', '2023-04-30', ['2023-01-31','2023-02-28','2023-03-31','2023-04-30']],
    ['非闰年月末30日', 'monthly', '2023-01-30', '2023-03-30', '2023-04-30', ['2023-01-30','2023-02-28','2023-03-30','2023-04-30']],
    ['闰年月末31日', 'monthly', '2024-01-31', '2024-03-31', '2024-04-30', ['2024-01-31','2024-02-29','2024-03-31','2024-04-30']],
    ['闰年月末30日', 'monthly', '2024-01-30', '2024-03-30', '2024-04-30', ['2024-01-30','2024-02-29','2024-03-30','2024-04-30']],
  ]) test(`${P}生成器日期${label}——每期从原锚点计算、截止日含边界`, async () => {
    const s = await calendar({ first, cycle, started: first, now });
    const got = await s.due(cutoff); assert.deepStrictEqual(dates(got), expected);
    assert.deepStrictEqual(got.map((x) => x.overdue), expected.map((date) => date < now));
    assert.ok(got.every((x) => x.submitted === false && x.report_entry_ids.length === 0));
    assert.deepStrictEqual(got[0].sources.map((x) => [x.kind, x.entry_id]), [['cycle', s.cycleId]]);
  });

  test(`${P}同日合并与已交——保留全部来源、提前交与待认可已交、主动及作废不抵`, async () => {
    const s = await calendar({ now: '2024-01-08' });
    const r1 = await seedForm(s, requestForm('2024-01-08')); const r2 = await seedForm(s, { ...requestForm('2024-01-08'), reason: '另外一项关键问题也需要说明进展' });
    await seedForm(s, reportForm());
    await seedForm(s, reportForm({ due_on: '2024-01-08' }), { voided: true });
    let due = await s.due('2024-01-15'); const d = due.find((x) => x.due_on === '2024-01-08');
    assert.deepStrictEqual(d.sources.map((x) => [x.kind, x.entry_id]), [['cycle', s.cycleId], ['request', r1], ['request', r2]]);
    assert.strictEqual(d.submitted, false); assert.strictEqual(d.overdue, false, '今天到期未交不算逾期');
    const reportId = await seedForm(s, reportForm({ due_on: '2024-01-08', milestone_impact: true }), { commitment: true });
    due = await s.due('2024-01-15'); assert.strictEqual(due[1].submitted, true); assert.deepStrictEqual(due[1].report_entry_ids, [reportId]);
    const early = await seedForm(s, reportForm({ due_on: '2024-01-15' }));
    due = await s.due('2024-01-15'); assert.deepStrictEqual(due[2].report_entry_ids, [early]); assert.strictEqual(due[2].submitted, true);
    s.today = '2024-01-09'; due = await s.due('2024-01-15'); assert.strictEqual(due[0].overdue, true); assert.strictEqual(due[1].overdue, false);
  });

  test(`${P}改节奏与临时要求——旧欠报消失、无节奏仍生成临时、作废要求不生成`, async () => {
    const s = await calendar({ now: '2024-01-15' });
    const oldReport = await seedForm(s, reportForm({ due_on: '2024-01-01' }));
    await seedForm(s, cycleForm('2024-01-15', 'biweekly'));
    assert.deepStrictEqual(dates(await s.due('2024-02-01')), ['2024-01-15', '2024-01-29']);
    assert.strictEqual((await s.view()).latest_report.entry_id, oldReport, '换节奏仍保留历史最近汇报');
    const noCycle = await calendar({ withCycle: false, now: '2024-01-15' });
    await seedForm(noCycle, requestForm('2024-01-15'));
    await seedForm(noCycle, requestForm('2024-01-16'), { voided: true });
    assert.deepStrictEqual(dates(await noCycle.due('2024-02-01')), ['2024-01-15']);
    assert.strictEqual((await noCycle.view()).warning, '尚未设定汇报节奏');
  });

  test(`${P}重开起算三来源——关闭不生成、直接及级联重开取最晚、不补旧欠报与旧临时`, async () => {
    const s = await calendar({ now: '2024-02-15' });
    await seedForm(s, requestForm('2024-01-08')); await seedForm(s, requestForm('2024-02-13'));
    await sqlRun("UPDATE sysbuild_nodes SET status='closed',closed_at='2024-01-20 00:00:00' WHERE id=?", [s.node.id]);
    assert.deepStrictEqual(await s.due('2024-02-29'), []);
    await sqlRun("UPDATE sysbuild_nodes SET status='in_progress',closed_at=NULL WHERE id=?", [s.node.id]);
    const event = async (kind, actual) => sqlRun("INSERT INTO sysbuild_events(project_id,object_type,object_id,event_type,payload_json,operator_id,operator_name,created_at) VALUES (?,'node',?,?,'{}',?,'夹具',?)", [s.pid, s.node.id, kind, U.pm, actual + ' 00:00:00']);
    await event('node_reopened', '2024-02-01');
    assert.deepStrictEqual(dates(await s.due('2024-02-15')), ['2024-02-05', '2024-02-12', '2024-02-13']);
    await event('node_cascade_reopened', '2024-02-10');
    assert.deepStrictEqual(dates(await s.due('2024-02-15')), ['2024-02-12', '2024-02-13']);
    await sqlRun("INSERT INTO sysbuild_node_schedule_records(node_id,kind,actual_date,created_by) VALUES (?,'actual_start','2024-02-14',?)", [s.node.id, U.pm]);
    assert.deepStrictEqual(dates(await s.due('2024-02-29')), ['2024-02-19', '2024-02-26']);
  });

  test(`${P}生成器前提与失败保守——项目非进行中批次冻结未开始收口非开发为空、事实未知不放行`, async () => {
    const s = await calendar();
    for (const status of ['paused', 'terminated', 'closed']) {
      await sqlRun('UPDATE sysbuild_projects SET status=? WHERE id=?', [status, s.pid]);
      assert.deepStrictEqual(await s.due('2024-02-29'), [], status);
    }
    await sqlRun("UPDATE sysbuild_projects SET status='active' WHERE id=?", [s.pid]);
    await sqlRun("UPDATE sysbuild_batches SET status='superseded',superseded_by=id WHERE id=?", [s.batch]);
    assert.deepStrictEqual(await s.due('2024-02-29'), []);
    await sqlRun("UPDATE sysbuild_batches SET status='planning',superseded_by=NULL WHERE id=?", [s.batch]);
    await sqlRun("UPDATE sysbuild_nodes SET status='not_started' WHERE id=?", [s.node.id]);
    assert.deepStrictEqual(await s.due('2024-02-29'), []);
    const nonDev = await sqlGet("SELECT * FROM sysbuild_nodes WHERE project_id=? AND template_key='b_req'", [s.pid]);
    assert.deepStrictEqual(await mod('report-core.js').dueDatesOf(q, nonDev, '2024-02-29', s.provider), []);
    const broken = { get: async () => { throw new Error('读取失败'); }, all: async () => { throw new Error('读取失败'); } };
    assert.deepStrictEqual(await mod('report-core.js').dueDatesOf(broken, await nodeRow(s), '2024-02-29', s.provider), []);
    const readiness = await mod('report-core.js').devStartReadyOf(broken, await nodeRow(s), s.provider);
    assert.ok(!['ok', 'not_dev_node'].includes(readiness), '事实未知不能按非开发或已就绪放行');
  });

  test(`${P}不可读三表单保守口径——节奏不回退、要求不生成、汇报不抵交、新节奏恢复`, async () => {
    const s = await calendar({ now: '2024-01-15' });
    const badCycle = await seedForm(s, cycleForm('2024-01-15'));
    await rawForm(badCycle, { v: 99, form: cycleForm('2024-01-15') });
    assert.deepStrictEqual(await s.due('2024-02-01'), []);
    let view = await s.view(); assert.strictEqual(view.warning, '节奏登记无法读取'); assert.strictEqual(view.current_cycle, null);
    const badRequest = await seedForm(s, requestForm('2024-01-16')); await rawForm(badRequest, { v: 99, form: requestForm('2024-01-16') });
    view = await s.view(); assert.ok(view.unreadable_request_ids.includes(badRequest)); assert.deepStrictEqual(await s.due('2024-02-01'), []);
    const good = await seedForm(s, cycleForm('2024-01-15')); view = await s.view(); assert.strictEqual(view.current_cycle.entry_id, good);
    const badReport = await seedForm(s, reportForm({ due_on: '2024-01-15' })); await rawForm(badReport, { v: 99, form: reportForm({ due_on: '2024-01-15' }) });
    s.today = '2024-01-16'; const due = await s.due('2024-02-01'); assert.strictEqual(due[0].submitted, false); assert.strictEqual(due[0].overdue, true);
  });

  test(`${P}节点HTTP视图与重开——31天清单、最近汇报、直接及级联事件提供起算事实`, async () => {
    const s = await scene({ started: true });
    const rr = await reg(s, U.x2, reportForm({ due_on: s.today })); assert.strictEqual(rr.status, 201, rr.text);
    let n = await nodeView(s); assert.ok(n.report); assert.strictEqual(n.report.current_cycle.entry_id, s.cycle.id);
    assert.strictEqual(n.report.cutoff, plusDays(s.today, 31)); assert.strictEqual(n.report.latest_report.entry_id, rr.body.entry.id);
    assert.deepStrictEqual(n.report.due_items.map((x) => x.due_on), [0,7,14,21,28].map((d) => plusDays(s.today, d)));
    assert.deepStrictEqual(n.report.due_items[0].report_entry_ids, [rr.body.entry.id]); assert.strictEqual(n.report.due_items[0].submitted, true);
    assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${s.node.id}/close`)).status, 200);
    assert.deepStrictEqual((await nodeView(s)).report.due_items, []);
    const re = await post(U.pm, `/sysbuild/nodes/${s.node.id}/reopen`, { reason: '继续补充开发验证工作' }); assert.strictEqual(re.status, 200, re.text);
    const ev = await sqlGet("SELECT id,created_at,payload_json FROM sysbuild_events WHERE object_type='node' AND object_id=? AND event_type='node_reopened' ORDER BY id DESC LIMIT 1", [s.node.id]);
    assert.deepStrictEqual(JSON.parse(ev.payload_json), { reason: '继续补充开发验证工作' }); assert.match(ev.created_at, /^\d{4}-\d{2}-\d{2}/);
    // 进程内 todayProvider 与SQL事件默认墙钟不同；只校准本测试事件，不改变业务写法。
    await sqlRun('UPDATE sysbuild_events SET created_at=? WHERE id=?', [s.today + ' 12:00:00', ev.id]);
    await H.produceEffectiveOverall(s.pid);
    const req = await sqlGet("SELECT id FROM sysbuild_nodes WHERE project_id=? AND template_key='b_req'", [s.pid]);
    assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${req.id}/start`)).status, 200);
    assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${req.id}/close`)).status, 200);
    assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${s.node.id}/close`)).status, 200);
    const cascade = await post(U.pm, `/sysbuild/nodes/${req.id}/reopen`, { reason: '需求复核引起后续节点重开' }); assert.strictEqual(cascade.status, 200, cascade.text);
    const ce = await sqlGet("SELECT id,created_at,payload_json FROM sysbuild_events WHERE object_type='node' AND object_id=? AND event_type='node_cascade_reopened' ORDER BY id DESC LIMIT 1", [s.node.id]);
    assert.strictEqual(JSON.parse(ce.payload_json).cause_node_id, req.id); assert.match(ce.created_at, /^\d{4}-\d{2}-\d{2}/);
    await sqlRun('UPDATE sysbuild_events SET created_at=? WHERE id=?', [s.today + ' 13:00:00', ce.id]);
    n = await nodeView(s); assert.strictEqual(n.status, 'in_progress'); assert.strictEqual(n.report.started_on, s.today);
  });

  test(`${P}旧进行中无节奏与异常节奏——保留开始事实、视图提示、节奏不可读开始门拒绝并可新登恢复`, async () => {
    const s = await scene();
    // 上线切换前已开始、没有节奏；不能要求回填，保留真实开始记录。
    await sqlRun("UPDATE sysbuild_nodes SET status='in_progress',opened_at=? WHERE id=?", [s.today + ' 00:00:00', s.node.id]);
    await sqlRun("INSERT INTO sysbuild_node_schedule_records(node_id,kind,actual_date,created_by) VALUES (?,'actual_start',?,?)", [s.node.id, s.today, U.pm]);
    let n = await nodeView(s); assert.strictEqual(n.status, 'in_progress'); assert.strictEqual(n.report.warning, '尚未设定汇报节奏'); assert.deepStrictEqual(n.report.due_items, []);
    expectErr(await reg(s, U.pm, cycleForm(plusDays(s.today, -1))), 400, 'SYSBUILD_INVALID_INPUT', '已开始首次不能追溯');
    const c = await reg(s, U.pm, cycleForm(s.today)); assert.strictEqual(c.status, 201, c.text);
    assert.strictEqual((await nodeView(s)).report.warning, null);
    const x = await scene({ withCycle: true });
    await rawForm(x.cycle.id, { v: 99, form: cycleForm(x.today) });
    assert.strictEqual((await entry(x.cycle.id)).actions.void, false, '不可读节奏仍不可作废');
    assert.strictEqual((await nodeView(x)).actions.start, false); expectErr(await start(x), 409, 'SYSBUILD_STATE', '不可读节奏缺事实');
    const again = await reg(x, U.pm, cycleForm(x.today)); assert.strictEqual(again.status, 201, again.text);
    assert.strictEqual((await nodeView(x)).actions.start, true); assert.strictEqual((await start(x)).status, 200);
  });

  test(`${P}待办汇报收件人与窗口——代表人优先负责人回退、逾期PM、2天含边界及交后消失`, async () => {
    const s = await scene({ started: true });
    // 仅时间夹具：已在上周开始且有当时登记的节奏，HTTP用例仍以服务端today为参照。
    await sqlRun("INSERT INTO sysbuild_node_schedule_records(node_id,kind,actual_date,created_by) VALUES (?,'actual_start',?,?)", [s.node.id, plusDays(s.today, -7), U.pm]);
    await seedForm(s, cycleForm(plusDays(s.today, -7)));
    await reg(s, U.pm, requestForm(plusDays(s.today, 2))); await reg(s, U.pm, requestForm(plusDays(s.today, 3)));
    let dev = mine(await todo(U.x2), 'report_due', s.pid);
    assert.deepStrictEqual(dev.map((x) => x.due_on).sort(), [plusDays(s.today, -7), s.today, plusDays(s.today, 2)]);
    assert.ok(dev.every((x) => x.node_id === s.node.id && x.sources.length > 0));
    assert.deepStrictEqual(mine(await todo(U.x1), 'report_due', s.pid), [], '已有代表人不重复发负责人');
    assert.deepStrictEqual(mine(await todo(U.m1), 'report_due', s.pid), [], '不发需求方');
    assert.deepStrictEqual(mine(await todo(U.pm), 'report_overdue', s.pid).map((x) => x.due_on), [plusDays(s.today, -7)]);
    const done = await reg(s, U.x2, reportForm({ due_on: plusDays(s.today, -7), milestone_impact: true }), EVID); assert.strictEqual(done.status, 201, done.text);
    assert.strictEqual((await task(done.body.entry.id)).status, 'pending');
    assert.deepStrictEqual(mine(await todo(U.pm), 'report_overdue', s.pid), [], '待认可也抵交');
    await sqlRun("UPDATE sysbuild_delegations SET status='revoked',revoked_at=datetime('now','localtime'),revoke_reason='代表人调整' WHERE id=?", [s.dlg]);
    assert.deepStrictEqual(mine(await todo(U.x2), 'report_due', s.pid), []);
    assert.deepStrictEqual(mine(await todo(U.x1), 'report_due', s.pid).map((x) => x.due_on).sort(), [s.today, plusDays(s.today, 2)]);
    assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${s.node.id}/close`)).status, 200);
    assert.deepStrictEqual(mine(await todo(U.x1), 'report_due', s.pid), [], '收口不再催报');
  });

  test(`${P}临时要求无收件人——无开发方无账号负责人、无账号代表人不重复回退与不新增推送`, async () => {
    const empty = await scene({ withDev: false, started: true });
    const none = await reg(empty, U.pm, requestForm(empty.today)); assert.strictEqual(none.status, 201, none.text); assert.strictEqual(none.body.no_recipient, true);
    const s = await scene({ started: true });
    const before = (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_send_intents WHERE project_id=?', [s.pid])).n;
    let r = await reg(s, U.pm, requestForm(s.today)); assert.strictEqual(r.status, 201, r.text); assert.notStrictEqual(r.body.no_recipient, true);
    await sqlRun("UPDATE sysbuild_members SET user_id=NULL,person_name='线下开发代表' WHERE id=?", [s.delegate]);
    r = await reg(s, U.pm, requestForm(plusDays(s.today, 1))); assert.strictEqual(r.status, 201, r.text); assert.strictEqual(r.body.no_recipient, true, '存在无账号代表人时不改发负责人');
    await sqlRun("UPDATE sysbuild_delegations SET status='revoked',revoked_at=datetime('now','localtime'),revoke_reason='调整' WHERE id=?", [s.dlg]);
    await sqlRun("UPDATE sysbuild_members SET user_id=NULL,person_name='线下开发负责人' WHERE id=?", [s.owner]);
    r = await reg(s, U.pm, requestForm(plusDays(s.today, 2))); assert.strictEqual(r.status, 201, r.text); assert.strictEqual(r.body.no_recipient, true);
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_send_intents WHERE project_id=?', [s.pid])).n, before, '节奏临时要求不新增发送意图');
    const nc = mod('notify-core.js');
    assert.deepStrictEqual(nc.PURPOSE_LIST, ['confirm_request', 'confirm_reissue', 'decision_objected', 'invitation', 'delegation_accept', 'schedule_notice']);
    assert.deepStrictEqual(nc.REF_TYPE_LIST, ['confirm_revision', 'invitation', 'delegation', 'notice']);
  });

  async function initiation() {
    const pid = await H.newProject(); await H.seedParty(pid, '立项部门', U.own, U.del);
    const pk = await H.mkPackage(pid, 'initiation'); const vid = await H.mkVersion(pk);
    return { pid, pk, vid, node: await sqlGet("SELECT * FROM sysbuild_nodes WHERE project_id=? AND template_key='p_initiation'", [pid]) };
  }
  const versionView = async (vid) => { const r = await get(U.pm, `/sysbuild/package-versions/${vid}`); assert.strictEqual(r.status, 200, r.text); return r.body; };
  const submitVersion = (vid) => post(U.pm, `/sysbuild/package-versions/${vid}/submit`);
  const snap = (vid, value) => patch(`/sysbuild/package-versions/${vid}`, { snapshot_json: value });
  async function material(s, node, withAttachment = true, key = 'initiation-basis') {
    const aid = withAttachment ? await H.stageAtt(s.pid, U.pm) : null;
    const r = await post(U.pm, `/sysbuild/nodes/${node.id}/materials/${key}/versions`, { name: '立项依据', body: '会议决定的项目立项说明材料', attachment_ids: aid ? [aid] : [] });
    assert.strictEqual(r.status, 201, r.text); return { mid: r.body.version.id, aid };
  }
  test(`${P}立项门五例——本节点附件及声明通过、他节点正文无依据拒绝、旧草稿执行新门`, async () => {
    const s = await initiation();
    assert.strictEqual((await versionView(s.vid)).actions.submit, false);
    expectErr(await submitVersion(s.vid), 409, 'SYSBUILD_STATE', '没有依据和声明');
    const elsewhere = await sqlGet("SELECT * FROM sysbuild_nodes WHERE project_id=? AND template_key='b_dev'", [s.pid]);
    const other = await material(s, elsewhere); assert.strictEqual((await snap(s.vid, { material_version_ids: [other.mid] })).status, 200);
    assert.strictEqual((await versionView(s.vid)).actions.submit, false); expectErr(await submitVersion(s.vid), 409, 'SYSBUILD_STATE', '其他节点材料不充数');
    const text = await material(s, s.node, false); assert.strictEqual((await snap(s.vid, { material_version_ids: [text.mid] })).status, 200);
    expectErr(await submitVersion(s.vid), 409, 'SYSBUILD_STATE', '只有正文不充数');
    const good = await material(s, s.node, true, 'written-basis'); assert.strictEqual((await snap(s.vid, { material_version_ids: [good.mid] })).status, 200);
    assert.strictEqual((await versionView(s.vid)).actions.submit, true); assert.strictEqual((await submitVersion(s.vid)).status, 200);
    const frozen = await sqlAll("SELECT attachment_id FROM sysbuild_frozen_attachments WHERE object_type='package_version' AND object_version_id=?", [s.vid]); assert.deepStrictEqual(frozen.map((x) => x.attachment_id), [good.aid]);
    const decl = await initiation(); assert.strictEqual((await snap(decl.vid, { no_written_basis_reason: '口头会议已经批准项目立项，没有形成书面文件' })).status, 200);
    assert.strictEqual((await versionView(decl.vid)).actions.submit, true); assert.strictEqual((await submitVersion(decl.vid)).status, 200);
    await H.confirmAll(decl.vid); assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id=?', [decl.vid])).status, 'effective');
  });

  test(`${P}立项声明双重校验与scope同源——PATCH类型长度、提交再核、已读材料复用与读取失败拒绝`, async () => {
    const s = await initiation();
    for (const value of [null, 1, true, [], {}, '', '不足十字', '字'.repeat(501), '无书面依据原因包含\u0001控制字符']) expectErr(await snap(s.vid, { no_written_basis_reason: value }), 400, 'SYSBUILD_INVALID_INPUT', '无书面依据声明');
    assert.strictEqual((await snap(s.vid, { no_written_basis_reason: '字'.repeat(10) })).status, 200);
    assert.strictEqual((await snap(s.vid, { no_written_basis_reason: '字'.repeat(500) })).status, 200);
    await sqlRun('UPDATE sysbuild_package_versions SET snapshot_json=? WHERE id=?', [JSON.stringify({ no_written_basis_reason: '短' }), s.vid]);
    assert.strictEqual((await versionView(s.vid)).actions.submit, false); expectErr(await submitVersion(s.vid), 400, 'SYSBUILD_INVALID_INPUT', '旧库异常声明提交仍核');
    await snap(s.vid, {}); const m = await material(s, s.node); await snap(s.vid, { material_version_ids: [m.mid] });
    const ver = await sqlGet('SELECT * FROM sysbuild_package_versions WHERE id=?', [s.vid]); const pkg = await sqlGet('SELECT * FROM sysbuild_packages WHERE id=?', [s.pk]);
    const sc = mod('submission-scope.js'); const scope = await sc.readSubmissionScope(q, pkg, ver);
    const readOnlyNodes = { get: async () => { throw new Error('不准独立重读材料附件'); }, all: async (sql, params) => { assert.match(sql, /FROM sysbuild_nodes/); return sqlAll(sql, params); } };
    assert.strictEqual((await sc.initiationBasisOf(readOnlyNodes, pkg, ver, scope)).fact, 'ok');
    const broken = { get: async () => { throw new Error('事实不可取'); }, all: async () => { throw new Error('事实不可取'); } };
    assert.strictEqual((await sc.initiationBasisOf(broken, pkg, ver)).fact, 'missing');
    await sqlRun("UPDATE sysbuild_attachments SET masked_at=datetime('now','localtime'),masked_by=?,mask_reason='核对材料' WHERE id=?", [U.pm, m.aid]);
    const denied = await submitVersion(s.vid); expectErr(denied, 400, 'SYSBUILD_INVALID_INPUT', '材料遮蔽原样拒绝'); assert.ok(denied.body.message.includes('已删除或已遮蔽'));
  });

  test(`${P}立项切换历史导入与旧待确认——无依据历史可导入、旧任务走完不追溯`, async () => {
    const s = await initiation();
    const opened = await post(U.pm, `/sysbuild/projects/${s.pid}/history-window`, { action: 'open', attachment_ids: [await H.stageAtt(s.pid, U.pm)] }); assert.strictEqual(opened.status, 200, opened.text);
    const imported = await post(U.pm, `/sysbuild/projects/${s.pid}/history-imports`, { fact_type: 'package_effective', object_id: s.vid, original_date: '2026-10-25', actual_confirmer: '立项负责人', identity_basis: '历史会议签字记录可以证明原立项事实', attachment_ids: [await H.stageAtt(s.pid, U.pm)] });
    assert.strictEqual(imported.status, 201, imported.text); assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id=?', [s.vid])).status, 'effective');
    const old = await initiation(); await snap(old.vid, { no_written_basis_reason: '当前口头立项已经完成审批，没有书面依据' }); assert.strictEqual((await submitVersion(old.vid)).status, 200);
    // 模拟上线前已提交且未带新字段的版本，不重新提交、不追溯新门。
    await sqlRun("UPDATE sysbuild_package_versions SET snapshot_json='{}' WHERE id=?", [old.vid]);
    await H.confirmAll(old.vid); assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id=?', [old.vid])).status, 'effective');
  });

  async function changeScene() {
    const s = await scene(); await H.produceEffectiveOverall(s.pid);
    const r = await post(U.pm, `/sysbuild/projects/${s.pid}/changes`, { title: '增加部门汇总功能', body: '补充部门汇总输出的范围与验收说明', ...EVID }); assert.strictEqual(r.status, 201, r.text);
    return { ...s, cid: r.body.change.id, vid: r.body.version.id };
  }
  const assessment = (cid) => ({ kind: 'dev_assessment', about_change_id: cid, feasible: 'yes', extra_person_days: 1, schedule_impact_days: 0, impact_note: null, premise: null });
  test(`${P}开发评估待办——none待认可stale发开发双方、ok豁免撤回消失、缺位及unknown改发PM`, async () => {
    const s = await changeScene();
    for (const uid of [U.x1, U.x2]) { const t = mine(await todo(uid), 'change_assess', s.pid); assert.strictEqual(t.length, 1); assert.strictEqual(t[0].change_id, s.cid); assert.strictEqual(t[0].fact, 'none'); }
    const a = await reg(s, U.x2, assessment(s.cid)); assert.strictEqual(a.status, 201, a.text);
    assert.strictEqual(mine(await todo(U.x1), 'change_assess', s.pid)[0].fact, 'not_approved');
    assert.strictEqual((await H.openAndDecide(U.x1, (await task(a.body.entry.id)).tid, 'confirm')).status, 200);
    assert.deepStrictEqual(mine(await todo(U.x1), 'change_assess', s.pid), []); assert.deepStrictEqual(mine(await todo(U.x2), 'change_assess', s.pid), []);
    assert.strictEqual((await snap(s.vid, { text: '追加需要开发方重新评估的内容' })).status, 200);
    assert.strictEqual(mine(await todo(U.x1), 'change_assess', s.pid)[0].fact, 'stale');
    await sqlRun("UPDATE sysbuild_delegations SET status='revoked',revoked_at=datetime('now','localtime'),revoke_reason='负责人离任' WHERE party_id=? AND status='active'", [s.dev]);
    await sqlRun("UPDATE sysbuild_appointments SET status='ended',ended_at=datetime('now','localtime'),end_reason='负责人离任' WHERE id=?", [s.apt]);
    let pm = mine(await todo(U.pm), 'change_assess', s.pid); assert.strictEqual(pm[0].fact, 'dev_lead_vacant'); assert.ok(pm[0].message.includes('先补任'));
    assert.deepStrictEqual(mine(await todo(U.x1), 'change_assess', s.pid), []);
    await rawForm(a.body.entry.id, { v: 99, form: assessment(s.cid) });
    pm = mine(await todo(U.pm), 'change_assess', s.pid); assert.strictEqual(pm[0].fact, 'unknown'); assert.strictEqual(pm[0].message, '有一条开发评估记录无法读取，请作废该登记或重新登记开发评估');
    const wd = await post(U.pm, `/sysbuild/package-versions/${s.vid}/withdraw`, { reason: '重新梳理范围后另建草稿' }); assert.strictEqual(wd.status, 200, wd.text);
    assert.deepStrictEqual(mine(await todo(U.pm), 'change_assess', s.pid), []);
  });

  test(`${P}开发评估待办scopeRejection——送审内容被拒发PM原文、不误导作废评估`, async () => {
    const s = await changeScene(); const a = await reg(s, U.x1, assessment(s.cid), { self_confirm_text: CB }); assert.strictEqual(a.status, 201, a.text);
    const m = await material(s, s.node, true, 'assessment-evidence'); await snap(s.vid, { material_version_ids: [m.mid] });
    const valid = await reg(s, U.x1, assessment(s.cid), { self_confirm_text: CB }); assert.strictEqual(valid.status, 201, valid.text);
    await sqlRun("UPDATE sysbuild_attachments SET masked_at=datetime('now','localtime'),masked_by=?,mask_reason='依据需核对' WHERE id=?", [U.pm, m.aid]);
    const pm = mine(await todo(U.pm), 'change_assess', s.pid); assert.strictEqual(pm.length, 1); assert.strictEqual(pm[0].fact, 'unknown');
    assert.ok(pm[0].message.includes('已删除或已遮蔽')); assert.ok(!pm[0].message.includes('无法读取'));
    assert.deepStrictEqual(mine(await todo(U.x1), 'change_assess', s.pid), []); assert.deepStrictEqual(mine(await todo(U.x2), 'change_assess', s.pid), []);
  });

  async function liveScene() {
    const pid = await H.newProject(); await H.produceEffectiveOverall(pid); const batch = await H.defaultBatchId(pid);
    await H.readyForGolive(pid, batch);
    return { pid, batch };
  }
  test(`${P}上线撤销附件——事务绑定、响应及批次视图清单、凭据不可普通删除、旧事件空清单`, async () => {
    const s = await liveScene(); const a = await H.stageAtt(s.pid, U.pm);
    const r = await post(U.pm, `/sysbuild/batches/${s.batch}/golive`, { attachment_ids: [a] }); assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body.golive_event.attachment_ids, [a]); assert.strictEqual(r.body.golive_event.attachments[0].attachment_id, a);
    assert.deepStrictEqual(await sqlAll("SELECT owner_id FROM sysbuild_attachment_bindings WHERE owner_type='golive_event' AND attachment_id=?", [a]), [{ owner_id: r.body.golive_event.id }]);
    assert.deepStrictEqual((await plan(s.pid)).batches.find((x) => x.id === s.batch).last_golive_event.attachment_ids, [a]);
    const av = await get(U.pm, `/sysbuild/attachments/${a}`); assert.strictEqual(av.status, 200, av.text); assert.strictEqual(av.body.attachment.evidence_bound, true); assert.strictEqual(av.body.attachment.actions.delete, false);
    expectErr(await post(U.pm, `/sysbuild/attachments/${a}/delete`), 409, 'SYSBUILD_STATE', '上线凭据不可删除');
    await sqlRun("UPDATE sysbuild_golive_events SET created_at=datetime('now','localtime','-1 hour') WHERE id=?", [r.body.golive_event.id]);
    const b = await H.stageAtt(s.pid, U.admin); const rv = await post(U.admin, `/sysbuild/batches/${s.batch}/revoke-golive`, { reason: '上线验收发现问题需要撤销', attachment_ids: [b] }); assert.strictEqual(rv.status, 200, rv.text);
    assert.deepStrictEqual(rv.body.golive_event.attachment_ids, [b]);
    expectErr(await post(U.pm, `/sysbuild/attachments/${b}/delete`), 409, 'SYSBUILD_STATE', '撤销凭据不可删除');
    const old = await sqlRun("INSERT INTO sysbuild_golive_events(batch_id,kind,handover_snapshot_json,created_by) VALUES (?,'golive','{}',?)", [s.batch, U.pm]);
    assert.deepStrictEqual((await mod('golive.js').goliveEventView(q, { id: old.lastID })).attachments, []);
  });

  test(`${P}上线附件校验与原子性——上限重复未知键外项目他人已绑定过期均拒绝并无上线副作用`, async () => {
    const s = await liveScene(); const url = `/sysbuild/batches/${s.batch}/golive`;
    for (const extra of [{ unknown: true }, { attachment_ids: '1' }, { attachment_ids: [0] }, { attachment_ids: [1,1] }, { attachment_ids: Array.from({ length: 11 }, (_, i) => i + 1) }]) expectErr(await post(U.pm, url, extra), 400, 'SYSBUILD_INVALID_INPUT', '附件请求校验');
    // 11个附件全部真实、同项目、本人、未绑定且未过期；只剩数量上限这一道拒绝。
    const eleven = [];
    for (let i = 0; i < 11; i += 1) eleven.push(await H.stageAtt(s.pid, U.pm));
    const marks = eleven.map(() => '?').join(',');
    const staged = await sqlAll(`SELECT id,project_id,uploaded_by,deleted_at,masked_at,staged_at >= datetime('now','localtime','-24 hours') AS fresh FROM sysbuild_attachments WHERE id IN (${marks}) ORDER BY id`, eleven);
    assert.strictEqual(staged.length, 11); assert.ok(staged.every((a) => a.project_id === s.pid && a.uploaded_by === U.pm && a.deleted_at === null && a.masked_at === null && a.fresh === 1));
    assert.strictEqual((await sqlGet(`SELECT COUNT(*) AS n FROM sysbuild_attachment_bindings WHERE attachment_id IN (${marks})`, eleven)).n, 0);
    const eventCount = (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_golive_events WHERE batch_id=?', [s.batch])).n;
    const batchStatus = (await sqlGet('SELECT status FROM sysbuild_batches WHERE id=?', [s.batch])).status; assert.strictEqual(batchStatus, 'active');
    expectErr(await post(U.pm, url, { attachment_ids: eleven }), 400, 'SYSBUILD_INVALID_INPUT', '11个真实可绑定附件仍须被数量上限拒绝');
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_golive_events WHERE batch_id=?', [s.batch])).n, eventCount);
    assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_batches WHERE id=?', [s.batch])).status, batchStatus);
    assert.strictEqual((await sqlGet(`SELECT COUNT(*) AS n FROM sysbuild_attachment_bindings WHERE attachment_id IN (${marks})`, eleven)).n, 0);
    const own = await H.stageAtt(s.pid, U.pm); const otherUser = await H.stageAtt(s.pid, U.own);
    const foreignPid = await H.newProject(); const foreign = await H.stageAtt(foreignPid, U.pm);
    const old = await H.stageAtt(s.pid, U.pm); await sqlRun("UPDATE sysbuild_attachments SET staged_at=datetime('now','localtime','-25 hours') WHERE id=?", [old]);
    const bound = await H.stageAtt(s.pid, U.pm); await sqlRun("INSERT INTO sysbuild_attachment_bindings(attachment_id,owner_type,owner_id,bound_by) VALUES (?,'entry',999999,?)", [bound, U.pm]);
    for (const bad of [otherUser, foreign, old, bound, 99999999]) {
      const before = (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_golive_events WHERE batch_id=?', [s.batch])).n;
      const r = await post(U.pm, url, { attachment_ids: [own, bad] }); assert.ok([400,409].includes(r.status), r.text);
      assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_golive_events WHERE batch_id=?', [s.batch])).n, before);
      assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_attachment_bindings WHERE attachment_id=?', [own])).n, 0, '先处理的有效附件也回滚');
      assert.notStrictEqual((await sqlGet('SELECT status FROM sysbuild_batches WHERE id=?', [s.batch])).status, 'live');
    }
  });

  test(`${P}B15确认任务边界——不可读汇报不允许办理但原认可任务仍按既有规则确认`, async () => {
    const s = await scene({ started: true });
    const r = await reg(s, U.x2, reportForm({ due_on: s.today, milestone_impact: true }), EVID); assert.strictEqual(r.status, 201, r.text);
    const t = await task(r.body.entry.id); assert.strictEqual(t.status, 'pending');
    await rawForm(r.body.entry.id, { v: 99, form: reportForm({ due_on: s.today, milestone_impact: true }) });
    const d = await entry(r.body.entry.id); assert.strictEqual(d.form_unreadable, true);
    for (const [name, allowed] of Object.entries(d.actions)) if (name !== 'void') {
      if (name === 'conclude_kinds') assert.deepStrictEqual(allowed, []);
      else assert.strictEqual(allowed, false, name);
    }
    expectErr(await action(r.body.entry.id, 'correct'), 409, 'SYSBUILD_STATE', '不可读表单不能勘误');
    const confirmed = await H.openAndDecide(U.x1, t.tid, 'confirm'); assert.strictEqual(confirmed.status, 200, confirmed.text);
    assert.strictEqual((await nodeView(s)).report.due_items[0].submitted, false, '即使原任务确认，不可读汇报仍不抵交');
  });

  test(`${P}旧重开事件与起算缺失——旧created_at兼容、最新坏日期不能回退、原计划不代替实际开工`, async () => {
    const s = await calendar({ now: '2024-02-15' });
    await sqlRun("INSERT INTO sysbuild_events(project_id,object_type,object_id,event_type,payload_json,operator_id,operator_name,created_at) VALUES (?,'node',?,'node_reopened','{}',?,'历史夹具','2024-02-01 23:59:59')", [s.pid, s.node.id, U.pm]);
    assert.deepStrictEqual(dates(await s.due('2024-02-15')), ['2024-02-05', '2024-02-12']);
    await sqlRun("INSERT INTO sysbuild_events(project_id,object_type,object_id,event_type,payload_json,operator_id,operator_name,created_at) VALUES (?,'node',?,'node_reopened','{}',?,'历史夹具','2024-02-30 00:00:00')", [s.pid, s.node.id, U.pm]);
    assert.deepStrictEqual(await s.due('2024-02-15'), []); assert.ok((await s.view()).warning.includes('无法读取'));
    const x = await scene({ withPlan: true, withCycle: true });
    await sqlRun("UPDATE sysbuild_nodes SET status='in_progress',opened_at=? WHERE id=?", [x.today + ' 00:00:00', x.node.id]);
    const n = await nodeRow(x); assert.deepStrictEqual(await mod('report-core.js').dueDatesOf(q, n, plusDays(x.today, 31), () => x.today), [], '无actual_start和重开记录不猜起算日');
  });

  test(`${P}不可读未知kind——未知种类不伪装普通登记、较新异常阻断节奏、新节奏编号覆盖`, async () => {
    const s = await calendar({ now: '2024-01-15' });
    const unknown = await seedForm(s, reportForm());
    await rawForm(unknown, { v: 1, form: { kind: 'unknown_report', due_on: '2024-01-15' } });
    const raw = await sqlGet('SELECT * FROM sysbuild_entries WHERE id=?', [unknown]);
    assert.strictEqual(mod('entry-forms.js').formKindHint(raw), null);
    assert.strictEqual(mod('entry-forms.js').readEntryForm(raw).form_unreadable, true);
    let v = await s.view(); assert.strictEqual(v.current_cycle, null); assert.ok(v.warning.includes('节奏未知'));
    assert.ok(v.unreadable_entry_ids.includes(unknown)); assert.deepStrictEqual(v.due_items, []);
    const newer = await seedForm(s, cycleForm('2024-01-15'));
    v = await s.view(); assert.strictEqual(v.current_cycle.entry_id, newer); assert.deepStrictEqual(dates(await s.due('2024-01-29')), ['2024-01-15', '2024-01-22', '2024-01-29']);
  });

  test(`${P}转出批次不催报——生成器与节点视图同源为空、恢复后现有汇报仍抵交`, async () => {
    const s = await calendar({ now: '2024-01-15' });
    const rid = await seedForm(s, reportForm({ due_on: '2024-01-15' }));
    await sqlRun("UPDATE sysbuild_batches SET status='transferred',transfer_change_id=999999 WHERE id=?", [s.batch]);
    assert.deepStrictEqual(await s.due('2024-02-01'), []); assert.deepStrictEqual((await s.view()).due_items, []);
    await sqlRun("UPDATE sysbuild_batches SET status='active',transfer_change_id=NULL WHERE id=?", [s.batch]);
    const due = await s.due('2024-02-01'); assert.strictEqual(due.find((x) => x.due_on === '2024-01-15').submitted, true);
    assert.deepStrictEqual(due.find((x) => x.due_on === '2024-01-15').report_entry_ids, [rid]);
  });

  test(`${P}表单元数据权限——PM三种入口、开发代表仅进度、其他成员不开放汇报`, async () => {
    const s = await scene({ started: true });
    for (const [uid, expected] of [[U.pm, [true,true,true]], [U.x1, [true,false,false]], [U.x2, [true,false,false]], [U.x3, [false,false,false]], [U.m1, [false,false,false]]]) {
      const list = await get(uid, `/sysbuild/projects/${s.pid}/entries`); assert.strictEqual(list.status, 200, list.text);
      const fs = list.body.registration.forms;
      assert.deepStrictEqual(['progress_report','report_cycle','report_request'].map((kind) => fs.find((f) => f.kind === kind).allowed), expected, `uid=${uid}`);
    }
  });

  test(`${P}取消开发节点更换承载——旧节奏保留、新自定义节点必须重新计划设节奏`, async () => {
    const s = await scene({ withCycle: true });
    const created = await post(U.pm, `/sysbuild/batches/${s.batch}/nodes`, { name: '替代开发节点', g_stage: 'G3' });
    assert.strictEqual(created.status, 201, created.text);
    const nid = created.body.node.id;
    const cancel = await post(U.pm, `/sysbuild/nodes/${s.node.id}/cancel`, { reason: '调整本批的开发承载节点' }); assert.strictEqual(cancel.status, 200, cancel.text);
    assert.ok(await sqlGet('SELECT id FROM sysbuild_entries WHERE id=?', [s.cycle.id]));
    const replacement = { ...s, node: await sqlGet('SELECT * FROM sysbuild_nodes WHERE id=?', [nid]) };
    assert.strictEqual((await mod('report-core.js').developmentNodeOf(q, s.batch)).id, nid);
    expectErr(await start(replacement), 409, 'SYSBUILD_STATE', '新节点缺计划');
    assert.strictEqual((await schedule(replacement, s.today)).status, 201);
    expectErr(await start(replacement), 409, 'SYSBUILD_STATE', '旧节点节奏不能沿用');
    assert.strictEqual((await reg(replacement, U.pm, cycleForm(s.today))).status, 201);
    assert.strictEqual((await start(replacement)).status, 200);
    const view = await nodeView(replacement); assert.notStrictEqual(view.report.current_cycle.entry_id, s.cycle.id);
  });

  test(`${P}开发负责人缺位——影响汇报创建回滚、一般主动汇报可由PM继续留痕`, async () => {
    const s = await scene({ started: true });
    await sqlRun("UPDATE sysbuild_delegations SET status='revoked',revoked_at=datetime('now','localtime'),revoke_reason='任职结束' WHERE id=?", [s.dlg]);
    await sqlRun("UPDATE sysbuild_appointments SET status='ended',ended_at=datetime('now','localtime'),end_reason='任职结束' WHERE id=?", [s.apt]);
    const before = (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE project_id=?', [s.pid])).n;
    const impacted = await reg(s, U.pm, reportForm({ milestone_impact: true }), { ...EVID, source_party_id: s.dev }); expectErr(impacted, 409, 'SYSBUILD_STATE', '无负责人不可建认可');
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE project_id=?', [s.pid])).n, before);
    const note = await reg(s, U.pm, reportForm(), { source_party_id: s.dev }); assert.strictEqual(note.status, 201, note.text);
    assert.ok(!(await task(note.body.entry.id)));
  });

  test(`${P}上线附件十个边界与撤销回滚——十个允许、撤销未知键及失效附件不落事件不改状态`, async () => {
    const s = await liveScene(); const ids = [];
    for (let i = 0; i < 10; i += 1) ids.push(await H.stageAtt(s.pid, U.pm));
    const r = await post(U.pm, `/sysbuild/batches/${s.batch}/golive`, { attachment_ids: ids }); assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body.golive_event.attachment_ids, ids); assert.strictEqual(r.body.golive_event.attachments.length, 10);
    await sqlRun("UPDATE sysbuild_golive_events SET created_at=datetime('now','localtime','-1 hour') WHERE id=?", [r.body.golive_event.id]);
    const url = `/sysbuild/batches/${s.batch}/revoke-golive`;
    expectErr(await post(U.admin, url, { reason: '验证撤销请求', unknown: true }), 400, 'SYSBUILD_INVALID_INPUT', '撤销未知键');
    expectErr(await post(U.admin, url, { reason: '验证撤销请求', attachment_ids: Array.from({ length: 11 }, (_, i) => i + 1) }), 400, 'SYSBUILD_INVALID_INPUT', '撤销11个附件');
    const good = await H.stageAtt(s.pid, U.admin);
    const before = (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_golive_events WHERE batch_id=?', [s.batch])).n;
    const failed = await post(U.admin, url, { reason: '验证撤销整笔回滚', attachment_ids: [good, ids[0]] }); assert.ok([400,409].includes(failed.status), failed.text);
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_golive_events WHERE batch_id=?', [s.batch])).n, before);
    assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_batches WHERE id=?', [s.batch])).status, 'live');
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_attachment_bindings WHERE attachment_id=?', [good])).n, 0);
    const ok = await post(U.admin, url, { reason: '撤销附件现在齐全', attachment_ids: [good] }); assert.strictEqual(ok.status, 200, ok.text); assert.deepStrictEqual(ok.body.golive_event.attachment_ids, [good]);
  });

  test(`${P}进度汇报31天窗口——真实周期应交日32天仍拒绝、31天边界允许`, async () => {
    const s = await scene();
    const day32 = plusDays(s.today, 32); const day31 = plusDays(s.today, 31);
    const cycle32 = await reg(s, U.pm, cycleForm(day32)); assert.strictEqual(cycle32.status, 201, cycle32.text);
    assert.strictEqual((await start(s)).status, 200);
    const actual = await mod('report-core.js').dueDatesOf(q, await nodeRow(s), day32, () => s.today);
    assert.deepStrictEqual(dates(actual), [day32], '32天确实是周期应交日，拒绝必须来自登记的31天窗口');
    const before = (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE project_id=?', [s.pid])).n;
    expectErr(await reg(s, U.x2, reportForm({ due_on: day32 })), 400, 'SYSBUILD_INVALID_INPUT', '真实应交日超过登记窗口');
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE project_id=?', [s.pid])).n, before);
    const cycle31 = await reg(s, U.pm, cycleForm(day31)); assert.strictEqual(cycle31.status, 201, cycle31.text);
    const allowed = await reg(s, U.x2, reportForm({ due_on: day31 })); assert.strictEqual(allowed.status, 201, allowed.text);
    assert.strictEqual(allowed.body.entry.form.due_on, day31);
  });

  test(`${P}取数失败视图显式标记——应交为空且不可读标志与提示齐全`, async () => {
    const s = await calendar({ now: '2024-01-15' });
    const normal = await s.view(); assert.strictEqual(normal.facts_unreadable, false); assert.strictEqual(normal.warning, null); assert.ok(normal.due_items.length > 0);
    const broken = { get: async () => { throw new Error('模拟底层事实读取失败'); }, all: async () => { throw new Error('模拟底层事实读取失败'); } };
    const view = await mod('report-core.js').reportViewOf(broken, await nodeRow(s), () => '2024-01-15');
    assert.ok(view, '不能降级成非开发节点而不给report');
    assert.deepStrictEqual(view.due_items, []);
    assert.strictEqual(view.facts_unreadable, true);
    assert.strictEqual(view.warning, '汇报事实无法读取');
  });

  test(`${P}负责人未认可仍算已交——真实reject任务不撤销汇报事实、不恢复应交待办`, async () => {
    const s = await scene({ started: true });
    const r = await reg(s, U.x2, reportForm({ due_on: s.today, milestone_impact: true }), EVID); assert.strictEqual(r.status, 201, r.text);
    const t = await task(r.body.entry.id); assert.strictEqual(t.status, 'pending');
    const rejected = await H.openAndDecide(U.x1, t.tid, 'reject'); assert.strictEqual(rejected.status, 200, rejected.text);
    assert.strictEqual((await task(r.body.entry.id)).status, 'rejected');
    assert.strictEqual((await entry(r.body.entry.id)).dev_confirm.status, 'not_approved');
    const due = (await nodeView(s)).report.due_items.find((x) => x.due_on === s.today);
    assert.strictEqual(due.submitted, true); assert.deepStrictEqual(due.report_entry_ids, [r.body.entry.id]);
    assert.deepStrictEqual(mine(await todo(U.x2), 'report_due', s.pid), []);
    assert.deepStrictEqual(mine(await todo(U.pm), 'report_overdue', s.pid), []);
  });

  test(`${P}开发评估豁免不催办——没有开发方的草稿变更不发PM或开发账号`, async () => {
    const s = await scene({ withDev: false }); await H.produceEffectiveOverall(s.pid);
    const created = await post(U.pm, `/sysbuild/projects/${s.pid}/changes`, { title: '开发方入场前调整范围', body: '开发方从未入场，本次先整理项目需求范围', ...EVID }); assert.strictEqual(created.status, 201, created.text);
    const ver = await sqlGet('SELECT * FROM sysbuild_package_versions WHERE id=?', [created.body.version.id]);
    const pkg = await sqlGet('SELECT * FROM sysbuild_packages WHERE id=?', [created.body.change.package_id]);
    assert.strictEqual((await mod('submission-scope.js').devAssessmentOf(q, pkg, ver)).fact, 'exempt');
    for (const uid of [U.pm, U.x1, U.x2]) assert.deepStrictEqual(mine(await todo(uid), 'change_assess', s.pid), [], `豁免不向uid=${uid}催办`);
  });

  test(`${P}可读进度汇报不可拆分——合法分组请求仍409且actions同源拒绝`, async () => {
    const s = await scene({ started: true });
    const one = await H.mkItem(s.pid); const two = await H.mkItem(s.pid);
    const r = await reg(s, U.x2, reportForm(), { item_ids: [one.id, two.id] }); assert.strictEqual(r.status, 201, r.text);
    const d = await entry(r.body.entry.id); assert.strictEqual(d.form_kind, 'progress_report'); assert.strictEqual(d.form_unreadable, false); assert.strictEqual(d.actions.split, false);
    expectErr(await action(r.body.entry.id, 'split', { groups: [[one.id], [two.id]] }), 409, 'SYSBUILD_STATE', '可读汇报不可拆分');
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE parent_entry_id=?', [r.body.entry.id])).n, 0);
  });
}

const mu = (id, expect, file, from, to) => ({ id: `L2 ${id}`, expect: [`${P}${expect}`], edits: [{ file, from, to }] });
const TRACE_L2_MUTATIONS = [
  mu('汇报布尔类型不核', '三表单逐字段校验', 'entry-forms.js', "if (typeof form.milestone_impact !== 'boolean') throw invalid(", 'if (false) throw invalid('),
  mu('汇报done不核最小长度', '三表单逐字段校验', 'entry-forms.js', "done: textField(form, 'done', 10, 2000)", "done: textField(form, 'done', 0, 2000)"),
  mu('汇报next不核最大长度', '三表单逐字段校验', 'entry-forms.js', "next: textField(form, 'next', 10, 2000)", "next: textField(form, 'next', 10, 3000)"),
  mu('节奏周期不核枚举', '三表单逐字段校验', 'entry-forms.js', "typeof form.cycle !== 'string' || !hasKey(CYCLE_LABELS, form.cycle)", 'false'),
  mu('日期允许不存在日', '三表单逐字段校验', 'entry-forms.js', 'date.getUTCFullYear() !== y || date.getUTCMonth() + 1 !== m || date.getUTCDate() !== d', 'false'),
  mu('临时事由不核长度', '三表单逐字段校验', 'entry-forms.js', "reason: textField(form, 'reason', 10, 500)", "reason: textField(form, 'reason', 0, 1000)"),
  mu('影响汇报不规范化承诺', '三表单互斥与规范化', 'entry-forms.js', 'commitment_flag: milestone ? 1 : 0', 'commitment_flag: 0'),
  mu('普通汇报可带本人确认', '三表单互斥与规范化', 'entry-forms.js', "form.kind !== 'dev_assessment' && !milestone && hasKey(body, 'self_confirm_text')", 'false'),
  mu('汇报不核开发来源', '登记人来源与节点', 'entry-forms.js', 'if (!(await entries.isDevParty(q, c.sourcePartyId))) throw invalid(', 'if (false) throw invalid('),
  mu('汇报取消登记人限制', '登记人来源与节点', 'entry-forms.js', "if (form.kind === 'progress_report') rules.assertOp('entry_create_dev', identity, project, { devPartyId: await require('./entries-core').devPartyIdOf(q, projectId) });", ''),
  mu('节奏要求不限PM', '登记人来源与节点', 'entry-forms.js', "['report_cycle', 'report_request'].includes(form.kind) && !rules.canActAsPm(identity)", 'false'),
  mu('表单可关联其他节点', '登记人来源与节点', 'entry-forms.js', 'if (!node || !dev || dev.id !== node.id) throw invalid(', 'if (!node) throw invalid('),
  mu('表单取消节点状态限制', '登记人来源与节点', 'entry-forms.js', "if (!(form.kind === 'report_cycle' ? ['not_started', 'in_progress'] : ['in_progress']).includes(node.status)) throw invalid(", 'if (false) throw invalid('),
  mu('首次日期不核计划及今天', '汇报日期校验', 'entry-forms.js', "form.first_due_on < state.current_plan.start || (node.status === 'in_progress' && form.first_due_on < today)", 'false'),
  mu('临时应交窗口取消', '汇报日期校验', 'entry-forms.js', 'if (form.due_on < today || form.due_on > cutoff) throw invalid(', 'if (false) throw invalid('),
  mu('汇报不核真实应交日', '汇报日期校验', 'entry-forms.js', 'if (!due.some((item) => item.due_on === form.due_on)) throw invalid(', 'if (false) throw invalid('),
  mu('节奏作废保护遗漏', '组合矩阵与勘误', 'rules.js', "if (t.formKind === 'report_cycle' || t.formKindHint === 'report_cycle') return", 'if (false) return'),
  mu('节奏要求允许补取消标记', '组合矩阵与勘误', 'rules.js', "['report_cycle', 'report_request'].includes(t.formKind) && ['entry_mark_commitment', 'entry_unmark_commitment', 'entry_mark_risk', 'entry_unmark_risk'].includes(op)", 'false'),
  mu('开发开始缺计划放行', '开始门与开发节点', 'rules.js', "if (t.devStartReady === 'no_plan') return '请先确定开工日（开发节点的计划开始）';", "if (t.devStartReady === 'no_plan') return null;"),
  mu('开发开始缺节奏放行', '开始门与开发节点', 'rules.js', "return t.devStartReady === 'no_cycle' ? '请先设定汇报节奏'", "return t.devStartReady === 'no_cycle' ? null"),
  mu('模板不优先于自定义', '开发节点稳定选择', 'report-core.js', 'if (template) return template;', ''),
  mu('开发节点按改序变化', '开发节点稳定选择', 'report-core.js', "status <> 'cancelled' ORDER BY id`, [batchId]", "status <> 'cancelled' ORDER BY sort_order, id`, [batchId]"),
  mu('取消开发节点仍参与选择', '开发节点稳定选择', 'report-core.js', "WHERE batch_id = ? AND status <> 'cancelled' ORDER BY id", 'WHERE batch_id = ? ORDER BY id'),
  mu('周间隔错一天', '生成器日期每周', 'report-core.js', "const step = form.cycle === 'weekly' ? 7 : 14;", "const step = form.cycle === 'weekly' ? 8 : 14;"),
  mu('两周间隔错一周', '生成器日期每两周', 'report-core.js', "const step = form.cycle === 'weekly' ? 7 : 14;", "const step = form.cycle === 'weekly' ? 7 : 7;"),
  mu('月末不截断', '生成器日期非闰年月末31日', 'report-core.js', 'Math.min(day, lastDay)', 'day'),
  mu('月锚从二月后永远截28', '生成器日期非闰年月末30日', 'report-core.js', 'Math.min(day, lastDay)', 'Math.min(day, lastDay, k > 0 ? 28 : 31)'),
  mu('闰年二月错按28', '生成器日期闰年月末31日', 'report-core.js', 'Math.min(day, lastDay)', 'Math.min(day, lastDay === 29 ? 28 : lastDay)'),
  mu('起算三来源取最早', '重开起算三来源', 'report-core.js', 'startDays.filter(validDay).sort().slice(-1)[0]', 'startDays.filter(validDay).sort()[0]'),
  mu('遗漏直接重开', '重开起算三来源', 'report-core.js', "const direct = events.find((event) => event.event_type === 'node_reopened');", 'const direct = null;'),
  mu('遗漏级联重开', '重开起算三来源', 'report-core.js', "const cascade = events.find((event) => event.event_type === 'node_cascade_reopened');", 'const cascade = null;'),
  mu('最近actual_start错误取第一条', '重开起算三来源', 'report-core.js', 'starts[starts.length - 1].actual_date', 'starts[0].actual_date'),
  mu('旧重开日期不兼容', '旧重开事件与起算缺失', 'report-core.js', "const day = typeof event.created_at === 'string' ? event.created_at.slice(0, 10) : null;", 'const day = null;'),
  mu('生成器忽略节点状态', '重开起算三来源', 'report-core.js', "if (!node || node.status !== 'in_progress') return [];", "if (!node) return [];"),
  mu('生成器忽略项目状态', '生成器前提与失败保守', 'report-core.js', "facts.project.status !== 'active'", 'false'),
  mu('生成器忽略批次冻结', '生成器前提与失败保守', 'report-core.js', " || rules.BATCH_FROZEN_STATUSES.includes(facts.batch.status)", ''),
  mu('临时应交未限制重开下限', '重开起算三来源', 'report-core.js', 'if (day < facts.started_on || day > cutoff) return;', 'if (day > cutoff) return;'),
  mu('截止日不包含等号', '生成器日期非闰年月末31日', 'report-core.js', 'if (day < facts.started_on || day > cutoff) return;', 'if (day < facts.started_on || day >= cutoff) return;'),
  mu('同日来源被覆盖', '同日合并与已交', 'report-core.js', 'byDate[day].sources.push(source);', 'byDate[day].sources = [source];'),
  mu('忽略临时应交', '改节奏与临时要求', 'report-core.js', "for (const request of facts.requests) add(request.form.due_on, { kind: 'request', entry_id: request.entry_id, reason: request.form.reason });", ''),
  mu('主动汇报错误抵最早应交', '同日合并与已交', 'report-core.js', 'const item = byDate[report.form.due_on];', 'const item = byDate[report.form.due_on] || byDate[Object.keys(byDate)[0]];'),
  mu('汇报不记已交', '同日合并与已交', 'report-core.js', 'item.submitted = item.report_entry_ids.length > 0;', 'item.submitted = false;'),
  mu('今日到期误算逾期', '同日合并与已交', 'report-core.js', 'item.due_on < facts.today && !item.submitted', 'item.due_on <= facts.today && !item.submitted'),
  mu('作废汇报要求仍计入', '改节奏与临时要求', 'report-core.js', "if (entryActions.some((action) => action.action === 'void')) continue;", ''),
  mu('当前节奏回退最旧', '改节奏与临时要求', 'report-core.js', "parsed.form_kind === 'report_cycle' && !state.current_cycle", "parsed.form_kind === 'report_cycle'"),
  mu('不可读节奏仍回退旧条', '不可读三表单保守口径', 'report-core.js', 'if (state.cycle_unreadable || state.cycle_unknown) state.current_cycle = null;', ''),
  mu('无法取事实按非开发放行', '生成器前提与失败保守', 'report-core.js', "if (facts.unreadable || facts.is_dev === null) return 'unknown';", "if (facts.unreadable || facts.is_dev === null) return 'not_dev_node';"),
  mu('视图窗口缩为30天', '节点HTTP视图与重开', 'report-core.js', 'const cutoff = facts.today ? addDays(facts.today, 31) : null;', 'const cutoff = facts.today ? addDays(facts.today, 30) : null;'),
  mu('待办截止误用1天', '待办汇报收件人与窗口', 'notify.js', 'reports.dueDatesOf(q, node, reports.addDays(today, 2), () => today)', 'reports.dueDatesOf(q, node, reports.addDays(today, 1), () => today)'),
  mu('已交仍催报', '待办汇报收件人与窗口', 'notify.js', 'if (item.submitted) continue;', ''),
  mu('开发待办忽略代表优先', '待办汇报收件人与窗口', 'report-recipients.js', 'const dueUser = await userOf(delegate || owner);', 'const dueUser = await userOf(owner || delegate);'),
  mu('无收件人提示遗漏', '临时要求无收件人', 'entries.js', 'response.no_recipient = true;', 'response.no_recipient = false;'),
  mu('评估待办漏负责人', '开发评估待办——', 'report-recipients.js', 'for (const person of [delegate, owner])', 'for (const person of [delegate])'),
  mu('评估未知不转PM', '开发评估待办——', 'notify.js', "const toPm = ['dev_lead_vacant', 'unknown'].includes(assessment.fact);", 'const toPm = false;'),
  mu('评估scope拒绝文案丢失', '开发评估待办scopeRejection', 'notify.js', 'message: assessment.scopeRejection ? assessment.scopeRejection.message : messages[assessment.fact]', 'message: messages[assessment.fact]'),
  mu('立项门遗漏', '立项门五例', 'rules.js', "if (t.initiationBasis !== 'ok') return", 'if (false) return'),
  mu('立项附件允许他节点', '立项门五例', 'submission-scope.js', 'nodeIds.has(material.node_id)\n      && material.attachments.some', 'true\n      && material.attachments.some'),
  mu('立项无附件也通过', '立项门五例', 'submission-scope.js', 'material.attachments.some((attachment) => !attachment.deleted && !attachment.masked)', 'true'),
  mu('立项声明被忽略', '立项门五例', 'submission-scope.js', "hasBasis || reason !== null ? 'ok' : 'missing'", "hasBasis ? 'ok' : 'missing'"),
  mu('立项声明长度不核', '立项声明双重校验与scope同源', 'submission-scope.js', 'Array.from(reason).length < 10 || Array.from(reason).length > 500 ||', ''),
  mu('立项取数失败放行', '立项声明双重校验与scope同源', 'submission-scope.js', ": { fact: 'missing' };\n  }\n}\n\nasync function readSubmissionScope", ": { fact: 'ok' };\n  }\n}\n\nasync function readSubmissionScope"),
  mu('上线附件上限放宽', '上线附件校验与原子性', 'golive.js', 'raw.length > 10', 'raw.length > 20'),
  mu('上线事件漏附件绑定', '上线撤销附件', 'golive.js', "// L2 golive: binding failure rolls back the event and the existing state transitions together.\n      await attachmentHelpers.bindStagedAttachments(q, { projectId: batch.project_id, userId: Number(user.id), attachmentIds, ownerType: 'golive_event', ownerId: rec.goliveEventId, operatorName: core.operatorNameOf(user) });", ''),
  mu('撤销事件漏附件绑定', '上线撤销附件', 'golive.js', "// L2 revoke: evidence is appended in the same transaction as the revoke event.\n      await attachmentHelpers.bindStagedAttachments(q, { projectId: batch.project_id, userId: Number(user.id), attachmentIds, ownerType: 'golive_event', ownerId: rec.goliveEventId, operatorName: core.operatorNameOf(user) });", ''),
  mu('上线凭据删除读标志放开', '上线撤销附件', 'attachments.js', "const evidence = await q.get(\"SELECT id FROM sysbuild_attachment_bindings WHERE attachment_id = ? AND owner_type IN ('confirmation', 'history_import', 'schedule_record', 'event', 'golive_event') LIMIT 1\", [aid]);", "const evidence = await q.get(\"SELECT id FROM sysbuild_attachment_bindings WHERE attachment_id = ? AND owner_type IN ('confirmation', 'history_import', 'schedule_record', 'event') LIMIT 1\", [aid]);"),
  mu('上线凭据删除写守卫遗漏', '上线撤销附件', 'attachments.js', "const evidenceBound = await q.get(\n        \"SELECT id FROM sysbuild_attachment_bindings WHERE attachment_id = ? AND owner_type IN ('confirmation', 'history_import', 'schedule_record', 'event', 'golive_event') LIMIT 1\",", "const evidenceBound = await q.get(\n        \"SELECT id FROM sysbuild_attachment_bindings WHERE attachment_id = ? AND owner_type IN ('confirmation', 'history_import', 'schedule_record', 'event') LIMIT 1\","),
  mu('未知kind错误识别为已知', '不可读未知kind', 'entry-forms.js', "typeof payload.form.kind === 'string' && hasKey(DEFINITIONS, payload.form.kind) ? payload.form.kind : null", "typeof payload.form.kind === 'string' ? payload.form.kind : null"),
  mu('节奏元数据向所有人开放', '表单元数据权限', 'entry-forms.js', "['report_cycle', 'report_request'].includes(kind) ? isPm === true : true", "['report_cycle', 'report_request'].includes(kind) ? true : true"),
  mu('进度元数据向所有人开放', '表单元数据权限', 'entry-forms.js', "kind === 'progress_report' ? devAllowed === true", "kind === 'progress_report' ? true"),
  mu('十个上线附件被错拒', '上线附件十个边界与撤销回滚', 'golive.js', 'raw.length > 10', 'raw.length >= 10'),
  mu('历史立项误走新提交门', '立项切换历史导入与旧待确认', 'history.js', "pkg.type === 'initiation' ? { initiationBasis: 'ok', scopeRejection: null } : {}", '{}'),
  mu('进度正文遗漏风险', '三表单正例与读视图', 'entry-forms.js', "\\n\\n风险\\n${form.risks || '无'}\\n\\n是否影响里程碑", '\\n\\n是否影响里程碑'),
  mu('节奏正文遗漏说明', '三表单正例与读视图', 'entry-forms.js', "body: title + (form.note ? '\\n\\n' + form.note : '')", 'body: title'),
  mu('临时要求正文遗漏事由', '三表单正例与读视图', 'entry-forms.js', "title: `临时汇报要求：${form.due_on} 前`, body: form.reason", "title: `临时汇报要求：${form.due_on} 前`, body: '临时要求'"),
  mu('进度汇报错误放宽32天', '进度汇报31天窗口', 'entry-forms.js', 'const cutoff = reports.addDays(today, 31);', 'const cutoff = reports.addDays(today, 32);'),
  mu('取数失败视图遗漏提示', '取数失败视图显式标记', 'report-core.js', "if (facts.unreadable) warning = '汇报事实无法读取';", 'if (facts.unreadable) warning = null;'),
  mu('取数失败视图遗漏不可读标志', '取数失败视图显式标记', 'report-core.js', '    facts_unreadable: facts.unreadable,', ''),
  mu('未认可汇报错误不抵交', '负责人未认可仍算已交', 'report-core.js', '        state.reports.push(view);', "        if ((await require('./entries-core').devConfirmOf(q, entry)).status !== 'not_approved') state.reports.push(view);"),
  mu('评估豁免误当未知催办', '开发评估豁免不催办', 'notify.js', 'const assessment = await devAssessmentOf(q, pkg, ver);', "const assessment = await devAssessmentOf(q, pkg, ver);\n            if (assessment.fact === 'exempt') assessment.fact = 'unknown';"),
];
module.exports = { defineTraceL2Cases, TRACE_L2_MUTATIONS };
