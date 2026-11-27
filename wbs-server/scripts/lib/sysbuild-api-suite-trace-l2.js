// #213 L2：汇报、立项依据与上线附件。HTTP 与进程内变异共用；期望值手写。
// SQL 仅用于身份/附件夹具、日期历史与不可读载荷；业务正反例走真实端点。
'use strict';
const assert = require('assert');
const path = require('path');
const P = 'L2 留痕：';
// #212 C6 新增用例名（变异 expect 与 entries 套件的改挂一致）
const T_C6_R6 = 'C6 R6：进度汇报影响里程碑须方向类证据，无认可任务与本人确认';
const T_C6_DEV = 'C6 R6：entry_create_dev 判定矩阵（进度汇报登记权限不变）';
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
  const action = (eid, name, extra) => post(U.pm, `/sysbuild/entries/${eid}/actions`, { action: name, [name === 'correct' ? 'text' : 'reason']: '核实原始记录后追加本次办理说明', ...extra });
  const entry = async (eid) => { const r = await get(U.pm, `/sysbuild/entries/${eid}`); assert.strictEqual(r.status, 200, r.text); return r.body.entry; };
  const plan = async (pid) => { const r = await get(U.pm, `/sysbuild/projects/${pid}/plan`); assert.strictEqual(r.status, 200, r.text); return r.body; };
  const nodeView = async (s) => (await plan(s.pid)).nodes.find((n) => n.id === s.node.id);
  const nodeRow = (s) => sqlGet('SELECT * FROM sysbuild_nodes WHERE id = ?', [s.node.id]);
  const start = (s, uid = U.pm) => post(uid, `/sysbuild/nodes/${s.node.id}/start`);
  const schedule = (s, date) => post(U.pm, `/sysbuild/nodes/${s.node.id}/schedule`, { kind: 'plan', planned_start: date, planned_end: plusDays(date, 90) });
  const todo = async (uid) => { const r = await get(uid, '/sysbuild/my/todo'); assert.strictEqual(r.status, 200, r.text); assert.strictEqual(r.body.counts.badge, r.body.counts.confirm, 'L2 新类别不进入角标'); return r.body; };
  const mine = (t, key, pid) => t.items[key].filter((v) => v.project_id === pid);
  let todayCache = null;
  async function today() {
    if (todayCache) return todayCache;
    const pid = await H.newProject();
    const n = await sqlGet("SELECT id FROM sysbuild_nodes WHERE project_id=? AND template_key='p_initiation'", [pid]);
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
  async function ordinaryBatchNode(s) {
    const created = await post(U.pm, `/sysbuild/batches/${s.node.batch_id}/nodes`, { name: '非开发对照阶段', g_stage: 'G1' });
    assert.strictEqual(created.status, 201, created.text);
    return sqlGet('SELECT * FROM sysbuild_nodes WHERE id = ?', [created.body.node.id]);
  }
  const rawForm = (eid, value) => sqlRun('UPDATE sysbuild_entries SET routing_json=? WHERE id=?', [JSON.stringify(value), eid]);
  // C6：commitment 选项与两个承诺列从 INSERT 去掉（列默认 0 / NULL：commitment_flag 为 INTEGER NOT NULL DEFAULT 0，commitment_flag_source 可空，CHECK 在 0 / NULL 下成立；列清单、问号个数、绑定数组三者同步收窄）
  async function seedForm(s, form, { voided = false } = {}) {
    const result = await sqlRun(
      "INSERT INTO sysbuild_entries(project_id,node_id,type,source_party_id,operator_user_id,operator_identity_snapshot,period,title,body,routing_json) VALUES (?,?,'note',?,?,?,'process','日历历史夹具','日历历史夹具',?)",
      [s.pid, s.node.id, s.dev || null, U.pm, '{}', JSON.stringify({ v: 1, form })]
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
    assert.deepStrictEqual([s.cycle.type, s.cycle.form_kind, s.cycle.form_label], ['note', 'report_cycle', '汇报节奏']);
    assert.strictEqual(s.cycle.title, `汇报节奏：每周，首次应交 ${s.today}`);
    assert.strictEqual(s.cycle.body, `汇报节奏：每周，首次应交 ${s.today}\n\n请按期汇报开发进展`);
    const rq = await reg(s, U.pm, requestForm(s.today)); assert.strictEqual(rq.status, 201, rq.text);
    assert.deepStrictEqual([rq.body.entry.type, rq.body.entry.form_label, rq.body.entry.title, rq.body.entry.body], ['note', '临时汇报要求', `临时汇报要求：${s.today} 前`, REASON]);
    const f = reportForm({ due_on: s.today }); const r = await reg(s, U.x2, f); assert.strictEqual(r.status, 201, r.text);
    assert.deepStrictEqual([r.body.entry.type, r.body.entry.form_kind, r.body.entry.form_label, r.body.entry.title], ['note', 'progress_report', '进度汇报', `进度汇报（应交日 ${s.today}）`]);
    assert.strictEqual(r.body.entry.body, `本期进展\n${DONE}\n\n下期计划\n${NEXT}\n\n风险\n未填写\n\n是否影响里程碑：否`);
    assert.deepStrictEqual((await entry(r.body.entry.id)).form, f);
    const list = await get(U.pm, `/sysbuild/projects/${s.pid}/entries`); assert.strictEqual(list.status, 200, list.text);
    assert.deepStrictEqual(list.body.registration.forms.map((x) => x.kind), ['progress_report', 'report_cycle', 'report_request'], 'C5 R9：change_request / dev_assessment 已删，元数据只剩三张保留表单');
    assert.deepStrictEqual(list.body.entries.find((x) => x.id === r.body.entry.id).form, f);
    // C5 N-FORM：保留表单以 routing_json = {v:1, form} 信封落库。
    for (const [id, form] of [[rq.body.entry.id, requestForm(s.today)], [r.body.entry.id, f]]) assert.deepStrictEqual(JSON.parse((await sqlGet('SELECT routing_json FROM sysbuild_entries WHERE id=?', [id])).routing_json), { v: 1, form }, 'routing_json = {v:1, form} 信封');
    const impact = await reg(s, U.x2, reportForm({ milestone_impact: true }), EVID); assert.strictEqual(impact.status, 201, impact.text);
    assert.strictEqual(impact.body.milestone_warning, '本次汇报影响里程碑，请 PM 评估是否发起改期');
  });

  test(`${P}三表单逐字段校验——必填类型长度日期取值未知键与派生键`, async () => {
    const s = await scene({ started: true });
    const bases = [reportForm(), cycleForm(s.today), requestForm(s.today)];
    const bad = [];
    for (const [base, required] of [[bases[0], ['kind', 'done']], [bases[1], ['kind', 'cycle', 'first_due_on']], [bases[2], ['kind', 'due_on', 'reason']]]) {
      for (const key of required) { const b = { ...base }; delete b[key]; bad.push(b); }
      for (const key of ['extra', 'scope_digest', 'package_version_id']) bad.push({ ...base, [key]: 1 });
    }
    for (const [key, values] of Object.entries({ done: ['', '短', 1, '字'.repeat(2001)], next: [1, '字'.repeat(2001)], risks: [1, '字'.repeat(1001)], milestone_impact: [null, 0, 1, 'true'], due_on: [1, '2024-02-30', '1999-01-01', '2100-01-01', '2024-1-01'] })) for (const value of values) bad.push({ ...bases[0], [key]: value });
    for (const [key, values] of Object.entries({ cycle: ['daily', 1, null], first_due_on: ['', null, 1, '2024-02-30'], note: [1, '字'.repeat(501)] })) for (const value of values) bad.push({ ...bases[1], [key]: value });
    for (const [key, values] of Object.entries({ due_on: ['', null, 1, '2024-02-30'], reason: ['', '短', 1, '字'.repeat(501)] })) for (const value of values) bad.push({ ...bases[2], [key]: value });
    const before = (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE project_id=?', [s.pid])).n;
    for (const f of bad) expectErr(await reg(s, U.pm, f, { source_party_id: s.dev }), 400, 'SYSBUILD_INVALID_INPUT', JSON.stringify(f).slice(0, 100));
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE project_id=?', [s.pid])).n, before, '校验失败整笔回滚');
    const shortPlan = await reg(s, U.pm, { kind: 'progress_report', done: DONE, next: ' 联调 ', risks: ' ' }, { source_party_id: s.dev });
    assert.strictEqual(shortPlan.status, 201, shortPlan.text);
    assert.deepStrictEqual([shortPlan.body.entry.form.milestone_impact, shortPlan.body.entry.form.next, shortPlan.body.entry.form.risks], [false, '联调', null]);
    // 历法反例必须位于允许的未来区间，避免被“早于今天/计划”掩盖日历校验失效。
    const futureYear = Number(s.today.slice(0, 4)) + 1;
    const validFuture = `${futureYear}-02-28`; const invalidFuture = `${futureYear}-02-30`;
    const current = await nodeView(s); assert.strictEqual(current.status, 'in_progress');
    assert.ok(current.current_plan && current.current_plan.start <= validFuture); assert.ok(validFuture > s.today);
    const control = await reg(s, U.pm, cycleForm(validFuture)); assert.strictEqual(control.status, 201, control.text);
    expectErr(await reg(s, U.pm, cycleForm(invalidFuture)), 400, 'SYSBUILD_INVALID_INPUT', '未来2月30日仍须被历法校验拒绝');
  });

  test(`${P}三表单互斥与规范化——禁止客户端承诺及修订异议；self_confirm_text / commitment_flag / objects_entry_id / revision_of_entry_id 是退出键，出现即拒、不看值（R6-4 / R9；影响里程碑汇报的方向类证据与无认可任务见「C6 R6」用例）`, async () => {
    const s = await scene({ started: true });
    for (const form of [reportForm(), cycleForm(s.today), requestForm(s.today)]) {
      for (const key of ['title', 'body', 'objects_entry_id', 'revision_of_entry_id']) expectErr(await reg(s, U.pm, form, { source_party_id: s.dev, [key]: null }), 400, 'SYSBUILD_INVALID_INPUT', key);
      for (const [extra, field] of [[{ type: 'issue' }, 'type'], [{ purpose: 'dev_note' }, 'purpose'], [{ commitment_flag: 1 }, 'commitment_flag'], [{ commitment_flag: true }, 'commitment_flag'], [{ self_confirm_text: CB }, 'self_confirm_text']]) {
        const r = await reg(s, U.pm, form, { source_party_id: s.dev, ...extra });
        expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', JSON.stringify(extra));
        assert.strictEqual(r.body.field, field, `${JSON.stringify(extra)} 的 field`);
      }
    }
  });

  test(`${P}登记人来源与节点——PM设节奏要求、开发负责人代表人或PM代报、开发节点及状态限定`, async () => {
    const s = await scene({ started: true });
    for (const uid of [U.x1, U.x2, U.m1]) for (const f of [cycleForm(s.today), requestForm(s.today)]) expectErr(await reg(s, uid, f), 403, 'SYSBUILD_FORBIDDEN', '仅PM');
    // C6（4.2 trace-l2 行，CA1k 179-M4）：与 C6 R6 entry_create_dev 新增五格同口径——每个身份请求前后各取一次本项目 sysbuild_entries 行数，被拒请求增量 0
    for (const uid of [U.x3, U.m1]) {
      const entriesBefore = (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE project_id=?', [s.pid])).n;
      expectErr(await reg(s, uid, reportForm()), 403, 'SYSBUILD_FORBIDDEN', '非开发负责人代表人');
      assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE project_id=?', [s.pid])).n, entriesBefore, `被拒请求不留登记：${uid}`);
    }
    expectErr(await reg(s, U.pm, reportForm()), 400, 'SYSBUILD_INVALID_INPUT', 'PM须指定开发来源');
    expectErr(await reg(s, U.pm, reportForm(), { source_party_id: s.demand }), 400, 'SYSBUILD_INVALID_INPUT', '错误来源方');
    const pm = await reg(s, U.pm, reportForm(), { source_party_id: s.dev }); assert.strictEqual(pm.status, 201, pm.text);
    const foreign = await scene(); const req = await ordinaryBatchNode(s);
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

  test(`${P}汇报日期校验——无计划以今天为下限，保留有计划、临时31天与真实应交的校验`, async () => {
    const s = await scene({ withPlan: false });
    const early = await reg(s, U.pm, cycleForm(plusDays(s.today, -1)));
    expectErr(early, 400, 'SYSBUILD_INVALID_INPUT', '无计划不能早于今天');
    assert.strictEqual(early.body.field, 'form.first_due_on');
    const withNoPlan = await reg(s, U.pm, cycleForm(s.today));
    assert.strictEqual(withNoPlan.status, 201, withNoPlan.text);
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

  // C6：原「节奏要求不可补取消标记」循环（mark_* / unmark_* / split 五个动作）随动作删除而整个删，这些请求 C6 后是 400 field=action，由「C6 R9：办理动作只剩更正与作废」用例承接
  test(`${P}组合矩阵与勘误——节奏不可作废、勘误只追加、字段不变`, async () => {
    const s = await scene({ started: true }); const rq = await reg(s, U.pm, requestForm(s.today)); assert.strictEqual(rq.status, 201, rq.text);
    for (const eid of [s.cycle.id, rq.body.entry.id]) {
      const before = await sqlGet('SELECT routing_json FROM sysbuild_entries WHERE id=?', [eid]);
      const d = await entry(eid);
      assert.strictEqual(d.actions.correct, true, '节奏 / 临时要求可勘误');
      const c = await action(eid, 'correct'); assert.strictEqual(c.status, 201, c.text);
      assert.deepStrictEqual(await sqlGet('SELECT routing_json FROM sysbuild_entries WHERE id=?', [eid]), before);
      const after = await entry(eid); assert.strictEqual(after.has_correction, true); assert.strictEqual(after.corrections.length, 1);
    }
    assert.strictEqual((await entry(s.cycle.id)).actions.void, false);
    expectErr(await action(s.cycle.id, 'void'), 409, 'SYSBUILD_STATE', '节奏不可作废');
    assert.strictEqual((await entry(rq.body.entry.id)).actions.void, true);
    assert.strictEqual((await action(rq.body.entry.id, 'void')).status, 201);
  });

  test(`${P}开始门与开发节点——无计划和节奏可开始、读写同源、非开发节点不受限`, async () => {
    const s = await scene({ withPlan: false });
    const n = await ordinaryBatchNode(s);
    assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${n.id}/start`)).status, 200, '非开发节点无需计划节奏');
    const initial = await nodeView(s);
    assert.deepStrictEqual([initial.current_plan, initial.report.current_cycle, initial.dev_start_ready, initial.actions.start], [null, null, 'ok', true]);
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

  test(`${P}同日合并与已交——保留全部来源、提前交与已交、主动及作废不抵`, async () => {
    const s = await calendar({ now: '2024-01-08' });
    const r1 = await seedForm(s, requestForm('2024-01-08')); const r2 = await seedForm(s, { ...requestForm('2024-01-08'), reason: '另外一项关键问题也需要说明进展' });
    await seedForm(s, reportForm());
    await seedForm(s, reportForm({ due_on: '2024-01-08' }), { voided: true });
    let due = await s.due('2024-01-15'); const d = due.find((x) => x.due_on === '2024-01-08');
    assert.deepStrictEqual(d.sources.map((x) => [x.kind, x.entry_id]), [['cycle', s.cycleId], ['request', r1], ['request', r2]]);
    assert.strictEqual(d.submitted, false); assert.strictEqual(d.overdue, false, '今天到期未交不算逾期');
    const reportId = await seedForm(s, reportForm({ due_on: '2024-01-08', milestone_impact: true }));
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
    const noCycleDue = await noCycle.due('2024-02-01');
    assert.deepStrictEqual(dates(noCycleDue), ['2024-01-15', '2024-01-29']);
    assert.deepStrictEqual(noCycleDue[0].sources.map((item) => item.kind), ['default_cycle', 'request']);
    assert.strictEqual((await noCycle.view()).cycle_source, 'default');
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

  test(`${P}生成器前提与失败保守——项目非进行中或节点未开始收口非开发为空、事实未知不放行`, async () => {
    const s = await calendar();
    for (const status of ['paused', 'terminated', 'closed']) {
      await sqlRun('UPDATE sysbuild_projects SET status=? WHERE id=?', [status, s.pid]);
      assert.deepStrictEqual(await s.due('2024-02-29'), [], status);
    }
    await sqlRun("UPDATE sysbuild_projects SET status='active' WHERE id=?", [s.pid]);
    await sqlRun("UPDATE sysbuild_nodes SET status='not_started' WHERE id=?", [s.node.id]);
    assert.deepStrictEqual(await s.due('2024-02-29'), []);
    const nonDev = await ordinaryBatchNode(s);
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
    let view = await s.view();
    assert.deepStrictEqual([view.warning, view.current_cycle, view.default_cycle, view.cycle_source], ['节奏登记无法读取', null, null, null]);
    const badRequest = await seedForm(s, requestForm('2024-01-16')); await rawForm(badRequest, { v: 99, form: requestForm('2024-01-16') });
    view = await s.view(); assert.ok(view.unreadable_request_ids.includes(badRequest)); assert.deepStrictEqual(await s.due('2024-02-01'), []);
    const good = await seedForm(s, cycleForm('2024-01-15')); view = await s.view(); assert.strictEqual(view.current_cycle.entry_id, good);
    const badReport = await seedForm(s, reportForm({ due_on: '2024-01-15' })); await rawForm(badReport, { v: 99, form: reportForm({ due_on: '2024-01-15' }) });
    s.today = '2024-01-16'; const due = await s.due('2024-02-01'); assert.strictEqual(due[0].submitted, false); assert.strictEqual(due[0].overdue, true);
  });

  test(`${P}节点HTTP视图与重开——31天清单、最近汇报、直接及级联事件提供起算事实`, async () => {
    const s = await scene({ started: true, buildType: 'outsource' });
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
    const req = await sqlGet("SELECT id FROM sysbuild_nodes WHERE project_id=? AND template_key='b_design'", [s.pid]);
    assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${req.id}/start`)).status, 200);
    assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${req.id}/close`)).status, 200);
    assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${s.node.id}/close`)).status, 200);
    const reopened = await post(U.pm, `/sysbuild/nodes/${req.id}/reopen`, { reason: '只重新打开设计阶段' });
    assert.strictEqual(reopened.status, 200, reopened.text);
    assert.strictEqual((await nodeView(s)).status, 'closed');
    assert.strictEqual(await sqlGet("SELECT id FROM sysbuild_events WHERE object_type='node' AND object_id=? AND event_type='node_cascade_reopened'", [s.node.id]), undefined);
    // 历史旧事件的读侧兼容：显式布置旧版本曾产生的事实。
    await sqlRun("UPDATE sysbuild_nodes SET status='in_progress', closed_at=NULL WHERE id=?", [s.node.id]);
    await sqlRun("INSERT INTO sysbuild_events (project_id,object_type,object_id,event_type,payload_json,operator_id,operator_name,created_at) VALUES (?,'node',?,'node_cascade_reopened',?,?,?,?)",
      [s.pid, s.node.id, JSON.stringify({ cause_node_id: req.id, reason: '历史夹具的连带重开' }), U.pm, '测试项目经理', s.today + ' 13:00:00']);
    n = await nodeView(s); assert.strictEqual(n.status, 'in_progress'); assert.strictEqual(n.report.started_on, s.today);
  });

  test(`${P}旧进行中无节奏与异常节奏——由真实开始日算默认，异常节奏可新登恢复`, async () => {
    const s = await scene();
    // 上线切换前已开始、没有节奏；不能要求回填，保留真实开始记录。
    await sqlRun("UPDATE sysbuild_nodes SET status='in_progress',opened_at=? WHERE id=?", [s.today + ' 00:00:00', s.node.id]);
    await sqlRun("INSERT INTO sysbuild_node_schedule_records(node_id,kind,actual_date,created_by) VALUES (?,'actual_start',?,?)", [s.node.id, s.today, U.pm]);
    const n = await nodeView(s);
    assert.strictEqual(n.status, 'in_progress');
    assert.strictEqual(n.report.warning, null);
    assert.deepStrictEqual(n.report.default_cycle, { cycle: 'biweekly', first_due_on: plusDays(s.today, 14) });
    assert.deepStrictEqual(n.report.due_items.map((item) => item.due_on), [14, 28].map((d) => plusDays(s.today, d)));
    expectErr(await reg(s, U.pm, cycleForm(plusDays(s.today, -1))), 400, 'SYSBUILD_INVALID_INPUT', '已开始首次不能追溯');
    const c = await reg(s, U.pm, cycleForm(s.today)); assert.strictEqual(c.status, 201, c.text);
    assert.strictEqual((await nodeView(s)).report.warning, null);
    const x = await scene({ withCycle: true });
    await rawForm(x.cycle.id, { v: 99, form: cycleForm(x.today) });
    assert.strictEqual((await entry(x.cycle.id)).actions.void, false, '不可读节奏仍不可作废');
    assert.strictEqual((await nodeView(x)).actions.start, true);
    assert.strictEqual((await start(x)).status, 200);
    const unreadable = (await nodeView(x)).report;
    assert.strictEqual(unreadable.warning, '节奏登记无法读取');
    assert.strictEqual(unreadable.default_cycle, null);
    assert.deepStrictEqual(unreadable.due_items, []);
    const again = await reg(x, U.pm, cycleForm(x.today)); assert.strictEqual(again.status, 201, again.text);
    assert.strictEqual((await nodeView(x)).report.cycle_source, 'registered');
  });

  test(`${P}汇报节奏缺回退时的提示`, async () => {
    const s = await calendar({ withCycle: false, now: '2024-01-15' });
    const withoutKnownType = {
      all: sqlAll,
      async get(query, args) {
        const row = await sqlGet(query, args);
        // 模拟读取端遇到超出当前支持范围的建设方式，现行库的枚举限制维持原样。
        return row && query.includes('build_type FROM sysbuild_projects') ? { ...row, build_type: 'unsupported_type' } : row;
      },
    };
    const report = await mod('report-core.js').reportViewOf(withoutKnownType, await nodeRow(s), () => s.today);
    assert.deepStrictEqual([report.warning, report.cycle_source, report.due_items], ['当前没有可用的汇报节奏', null, []]);
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
    assert.deepStrictEqual(mine(await todo(U.pm), 'report_overdue', s.pid), [], '已交抵交');
    await sqlRun("UPDATE sysbuild_delegations SET status='revoked',revoked_at=datetime('now','localtime'),revoke_reason='代表人调整' WHERE id=?", [s.dlg]);
    assert.deepStrictEqual(mine(await todo(U.x2), 'report_due', s.pid), []);
    assert.deepStrictEqual(mine(await todo(U.x1), 'report_due', s.pid).map((x) => x.due_on).sort(), [s.today, plusDays(s.today, 2)]);
    assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${s.node.id}/close`)).status, 200);
    assert.deepStrictEqual(mine(await todo(U.x1), 'report_due', s.pid), [], '收口不再催报');
  });

  test(`${P}临时要求无收件人——无开发方、开发方无任职也无代表人时提示无收件人，不新增推送`, async () => {
    const empty = await scene({ withDev: false, started: true });
    const none = await reg(empty, U.pm, requestForm(empty.today)); assert.strictEqual(none.status, 201, none.text); assert.strictEqual(none.body.no_recipient, true);
    const s = await scene({ started: true });
    const before = (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_send_intents WHERE project_id=?', [s.pid])).n;
    let r = await reg(s, U.pm, requestForm(s.today)); assert.strictEqual(r.status, 201, r.text); assert.notStrictEqual(r.body.no_recipient, true);
    // 撤销开发方代表人、结束负责人任职（开发方没有任职也没有代表人）→ 无收件人提示
    await sqlRun("UPDATE sysbuild_delegations SET status='revoked',revoked_at=datetime('now','localtime'),revoke_reason='调整' WHERE id=?", [s.dlg]);
    await sqlRun("UPDATE sysbuild_appointments SET status='ended',ended_at=datetime('now','localtime'),end_reason='调整' WHERE member_id=? AND status='active'", [s.owner]);
    r = await reg(s, U.pm, requestForm(plusDays(s.today, 1))); assert.strictEqual(r.status, 201, r.text); assert.strictEqual(r.body.no_recipient, true, '开发方无任职也无代表人');
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_send_intents WHERE project_id=?', [s.pid])).n, before, '节奏临时要求不新增发送意图');
    const nc = mod('notify-core.js');
    assert.deepStrictEqual(nc.PURPOSE_LIST, ['confirm_request', 'confirm_reissue', 'decision_objected', 'schedule_notice', 'leader_confirmation_notice',
      'opinion_assess_notice', 'opinion_ready_notice', 'opinion_result_notice', 'opinion_cut_notice']);
    assert.deepStrictEqual(nc.REF_TYPE_LIST, ['confirm_revision', 'notice', 'opinion', 'cut_approval']);
  });

  async function initiation() {
    const pid = await H.newProject(); await H.seedParty(pid, '立项部门', U.own, U.del);
    const pk = await H.mkPackage(pid, 'initiation'); const vid = await H.mkVersion(pk);
    return { pid, pk, vid, node: await sqlGet("SELECT * FROM sysbuild_nodes WHERE project_id=? AND template_key='p_initiation'", [pid]) };
  }
  const versionView = async (vid) => { const r = await get(U.pm, `/sysbuild/package-versions/${vid}`); assert.strictEqual(r.status, 200, r.text); return r.body; };
  const submitVersion = (vid) => post(U.pm, `/sysbuild/package-versions/${vid}/submit`);
  const snap = (vid, value) => patch(`/sysbuild/package-versions/${vid}`, { snapshot_json: { text: '立项依据用例确认正文', ...value } });
  const declare = (s, reason) => post(U.pm, `/sysbuild/nodes/${s.node.id}/materials/initiation-basis/not-applicable`, { reason });
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
    const other = await material(s, elsewhere, true, 'elsewhere-basis'); assert.strictEqual((await snap(s.vid, { material_version_ids: [other.mid] })).status, 200);
    assert.strictEqual((await versionView(s.vid)).actions.submit, false); expectErr(await submitVersion(s.vid), 409, 'SYSBUILD_STATE', '其他节点材料不充数');
    const text = await material(s, s.node, false); assert.strictEqual((await snap(s.vid, { material_version_ids: [text.mid] })).status, 200);
    expectErr(await submitVersion(s.vid), 409, 'SYSBUILD_STATE', '只有正文不充数');
    const good = await material(s, s.node); assert.strictEqual((await snap(s.vid, { material_version_ids: [good.mid] })).status, 200);
    assert.strictEqual((await versionView(s.vid)).actions.submit, true); assert.strictEqual((await submitVersion(s.vid)).status, 200);
    const frozen = await sqlAll("SELECT attachment_id FROM sysbuild_frozen_attachments WHERE object_type='package_version' AND object_version_id=?", [s.vid]); assert.deepStrictEqual(frozen.map((x) => x.attachment_id), [good.aid]);
    const decl = await initiation(); assert.strictEqual((await declare(decl, '口头会议已经批准项目立项，没有形成书面文件')).status, 201);
    assert.strictEqual((await versionView(decl.vid)).actions.submit, true); assert.strictEqual((await submitVersion(decl.vid)).status, 200);
    await H.confirmAll(decl.vid); assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id=?', [decl.vid])).status, 'effective');
  });

  test(`${P}立项声明双重校验与scope同源——材料卡写入、禁止草稿代写、提交复用所选范围`, async () => {
    const s = await initiation();
    for (const value of [null, 1, true, [], {}, '', '不足十字', '字'.repeat(501), '无书面依据原因包含\u0001控制字符']) expectErr(await declare(s, value), 400, 'SYSBUILD_INVALID_INPUT', '无书面依据声明');
    const forged = await snap(s.vid, { no_written_basis_reason: '字'.repeat(10) });
    expectErr(forged, 400, 'SYSBUILD_INVALID_INPUT', '草稿不能代写声明');
    assert.strictEqual(forged.body.field, 'snapshot_json.no_written_basis_reason');
    await sqlRun('UPDATE sysbuild_package_versions SET snapshot_json=? WHERE id=?', [JSON.stringify({ no_written_basis_reason: '短' }), s.vid]);
    assert.strictEqual((await versionView(s.vid)).actions.submit, false); expectErr(await submitVersion(s.vid), 409, 'SYSBUILD_STATE', '旧草稿理由不能成为声明来源');
    assert.strictEqual((await declare(s, '字'.repeat(10))).status, 201);
    assert.strictEqual((await declare(s, '字'.repeat(500))).status, 201);
    await snap(s.vid, {}); const m = await material(s, s.node); await snap(s.vid, { material_version_ids: [m.mid] });
    const ver = await sqlGet('SELECT * FROM sysbuild_package_versions WHERE id=?', [s.vid]); const pkg = await sqlGet('SELECT * FROM sysbuild_packages WHERE id=?', [s.pk]);
    const sc = mod('submission-scope.js'); const scope = await sc.readSubmissionScope(q, pkg, ver);
    const readOnlyNodes = { get: async () => { throw new Error('不准独立重读材料附件'); }, all: async (sql, params) => { assert.match(sql, /FROM sysbuild_nodes/); return sqlAll(sql, params); } };
    const cards = mod('stage-cards.js');
    assert.deepStrictEqual(await cards.submissionBasis(readOnlyNodes, pkg, 'inhouse', scope.materials), { ok: true, declaration: null });
    const broken = { get: async () => { throw new Error('事实不可取'); }, all: async () => { throw new Error('事实不可取'); } };
    await assert.rejects(() => cards.submissionBasis(broken, pkg, 'inhouse', scope.materials), /事实不可取/);
    await sqlRun("UPDATE sysbuild_attachments SET masked_at=datetime('now','localtime'),masked_by=?,mask_reason='核对材料' WHERE id=?", [U.pm, m.aid]);
    const denied = await submitVersion(s.vid); expectErr(denied, 400, 'SYSBUILD_INVALID_INPUT', '材料遮蔽原样拒绝'); assert.ok(denied.body.message.includes('已删除或已遮蔽'));
  });

  test(`${P}立项切换旧待确认——旧任务走完不追溯`, async () => {
    const old = await initiation(); await declare(old, '当前口头立项已经完成审批，没有书面依据'); assert.strictEqual((await submitVersion(old.vid)).status, 200);
    // 模拟上线前已提交且未带新字段的版本，不重新提交、不追溯新门。
    await sqlRun("UPDATE sysbuild_package_versions SET snapshot_json='{}' WHERE id=?", [old.vid]);
    await H.confirmAll(old.vid); assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id=?', [old.vid])).status, 'effective');
  });

  async function changeScene() {
    const s = await scene(); await H.produceEffectiveOverall(s.pid);
    const r = await post(U.pm, `/sysbuild/projects/${s.pid}/changes`, { title: '增加部门汇总功能', body: '补充部门汇总输出的范围与验收说明', ...EVID }); assert.strictEqual(r.status, 201, r.text);
    return { ...s, cid: r.body.change.id, vid: r.body.version.id };
  }
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
    const old = await sqlRun("INSERT INTO sysbuild_golive_events(batch_id,kind,created_by) VALUES (?,'golive',?)", [s.batch, U.pm]);
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

  test(`${P}B15不可读汇报边界——不可读汇报不允许办理（除作废）、不抵交`, async () => {
    const s = await scene({ started: true });
    const r = await reg(s, U.x2, reportForm({ due_on: s.today, milestone_impact: true }), EVID); assert.strictEqual(r.status, 201, r.text);
    await rawForm(r.body.entry.id, { v: 99, form: reportForm({ due_on: s.today, milestone_impact: true }) });
    const d = await entry(r.body.entry.id); assert.strictEqual(d.form_unreadable, true);
    // 不可读表单只挡非作废动作（rules.js entry_* 的 formUnreadable 判定）；PM 对 void 放行（canCorrectOrVoidEntry）：actions 全等，correct 缺失或以 false 残留之外的任何键都判红（CA3c 163-M9）
    assert.deepStrictEqual(d.actions, { correct: false, void: true });
    expectErr(await action(r.body.entry.id, 'correct'), 409, 'SYSBUILD_STATE', '不可读表单不能勘误');
    assert.strictEqual((await nodeView(s)).report.due_items[0].submitted, false, '不可读汇报不抵交');
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
    let v = await s.view();
    assert.deepStrictEqual([v.current_cycle, v.default_cycle, v.cycle_source], [null, null, null]);
    assert.ok(v.warning.includes('节奏未知'));
    assert.ok(v.unreadable_entry_ids.includes(unknown)); assert.deepStrictEqual(v.due_items, []);
    const newer = await seedForm(s, cycleForm('2024-01-15'));
    v = await s.view(); assert.strictEqual(v.current_cycle.entry_id, newer); assert.deepStrictEqual(dates(await s.due('2024-01-29')), ['2024-01-15', '2024-01-22', '2024-01-29']);
  });

  test(`${P}已上线批次的汇报仍按节点自身状态记交付`, async () => {
    const s = await calendar({ now: '2024-01-15' });
    const rid = await seedForm(s, reportForm({ due_on: '2024-01-15' }));
    // 真实上线会先收口开发节点。组合夹具单独验证生成器不把批次状态当作节点状态。
    assert.ok(mod('schema.js').ENUMS.batchStatus.includes('live'));
    await sqlRun("UPDATE sysbuild_batches SET status='live' WHERE id=?", [s.batch]);
    const due = await s.due('2024-02-01'); assert.strictEqual(due.find((x) => x.due_on === '2024-01-15').submitted, true);
    assert.deepStrictEqual(due.find((x) => x.due_on === '2024-01-15').report_entry_ids, [rid]);
    const view = await s.view();
    assert.strictEqual(view.cutoff, '2024-02-15');
    assert.deepStrictEqual(view.due_items, await s.due(view.cutoff));
    const inView = view.due_items.find((x) => x.due_on === '2024-01-15');
    assert.ok(inView);
    assert.deepStrictEqual([inView.submitted, inView.report_entry_ids], [true, [rid]]);
  });

  test(`${P}C8 报表未知候选仍同时要求 note 类型与无表单提示`, async () => {
    const s = await calendar({ now: '2024-01-15' });
    const unknown = { v: 1, form: { kind: 'unknown_report', due_on: '2024-01-15' } };
    const included = await seedForm(s, reportForm());
    const wrongType = await seedForm(s, reportForm());
    const knownHint = await seedForm(s, reportForm());
    await rawForm(included, unknown);
    await rawForm(wrongType, unknown);
    await sqlRun("UPDATE sysbuild_entries SET type='issue' WHERE id=?", [wrongType]);
    await rawForm(knownHint, { v: 1, form: { kind: 'report_cycle' } });
    const facts = await s.view();
    assert.deepStrictEqual(facts.unreadable_request_ids, [included]);
    assert.deepStrictEqual(facts.unreadable_report_ids, [included]);
    assert.ok([included, wrongType, knownHint].every((id) => facts.unreadable_entry_ids.includes(id)));
  });

  test(`${P}表单元数据权限——PM三种入口、开发代表仅进度、其他成员不开放汇报`, async () => {
    const s = await scene({ started: true });
    for (const [uid, expected] of [[U.pm, [true,true,true]], [U.x1, [true,false,false]], [U.x2, [true,false,false]], [U.x3, [false,false,false]], [U.m1, [false,false,false]]]) {
      const list = await get(uid, `/sysbuild/projects/${s.pid}/entries`); assert.strictEqual(list.status, 200, list.text);
      const fs = list.body.registration.forms;
      assert.deepStrictEqual(['progress_report','report_cycle','report_request'].map((kind) => fs.find((f) => f.kind === kind).allowed), expected, `uid=${uid}`);
    }
  });

  test(`${P}取消开发节点更换承载——旧节奏保留，新自定义节点开始后使用自身默认节奏`, async () => {
    const s = await scene({ withCycle: true });
    const created = await post(U.pm, `/sysbuild/batches/${s.batch}/nodes`, { name: '替代开发节点', g_stage: 'G3' });
    assert.strictEqual(created.status, 201, created.text);
    const nid = created.body.node.id;
    const cancel = await post(U.pm, `/sysbuild/nodes/${s.node.id}/cancel`, { reason: '调整本批的开发承载节点' }); assert.strictEqual(cancel.status, 200, cancel.text);
    assert.ok(await sqlGet('SELECT id FROM sysbuild_entries WHERE id=?', [s.cycle.id]));
    const replacement = { ...s, node: await sqlGet('SELECT * FROM sysbuild_nodes WHERE id=?', [nid]) };
    assert.strictEqual((await mod('report-core.js').developmentNodeOf(q, s.batch)).id, nid);
    assert.strictEqual((await start(replacement)).status, 200);
    const defaultReport = (await nodeView(replacement)).report;
    assert.strictEqual(defaultReport.current_cycle, null, '旧节点节奏不能沿用');
    assert.strictEqual(defaultReport.cycle_source, 'default');
    assert.strictEqual((await reg(replacement, U.pm, cycleForm(s.today))).status, 201);
    assert.notStrictEqual((await nodeView(replacement)).report.current_cycle.entry_id, s.cycle.id);
  });

  test(`${P}开发负责人缺位——影响汇报不再建认可任务、照常 201 落一条登记（C6：认可删后，旧版 409 开发方暂无负责人，见 R6-1）、一般主动汇报可由PM继续留痕`, async () => {
    const s = await scene({ started: true });
    await sqlRun("UPDATE sysbuild_delegations SET status='revoked',revoked_at=datetime('now','localtime'),revoke_reason='任职结束' WHERE id=?", [s.dlg]);
    await sqlRun("UPDATE sysbuild_appointments SET status='ended',ended_at=datetime('now','localtime'),end_reason='任职结束' WHERE id=?", [s.apt]);
    const entriesOf = async () => (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE project_id=?', [s.pid])).n;
    const tasksOf = async () => (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE project_id=?', [s.pid])).n;
    const before = await entriesOf(); const tasksBefore = await tasksOf();
    const impacted = await reg(s, U.pm, reportForm({ milestone_impact: true }), { ...EVID, source_party_id: s.dev }); assert.strictEqual(impacted.status, 201, impacted.text);
    assert.strictEqual(await entriesOf(), before + 1, '登记数 +1');
    const note = await reg(s, U.pm, reportForm(), { source_party_id: s.dev }); assert.strictEqual(note.status, 201, note.text);
    assert.strictEqual(await tasksOf(), tasksBefore, '两格（勾 / 不勾影响里程碑）都不建确认任务：sysbuild_confirm_tasks 行数差 0');
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

  // ═══════════════════════ C6 新增（生效清单 4.3 第 3 条）：进度汇报影响里程碑须方向类证据，无认可任务与本人确认 ═══════════════════════
  //   先采集后汇总：全部请求先发完记进 REC（键 = 请求标签），再逐项带标签断言，每条各自判红绿（N5 / N6 / N7 变异下前面的请求变红时，后面的目标标签仍能求值）。
  //   R6-1（开发方无现任负责人时 201）的落点是本文件「开发负责人缺位」用例（原位改写，不另建）；R6-3（无权 403、来源方不是开发方 400）是本文件「登记人来源与节点」用例的保留断言。
  test(`${T_C6_R6}——R6-2 / R6-4 / R6-5 / R6-6 / R6-7 / R6-8 / R6-9 / R6-10：证据触发条件是 milestone_impact === true（方向类证据 = 附件，或声明无书面证据且原因 ≥ 10 字）、self_confirm_text 键出现即拒、不建认可任务、不置承诺标记、提交即算已交`, async () => {
    const s = await scene({ started: true });
    const IMPACT_MSG = '影响里程碑的进度汇报须上传证据附件，或声明无书面证据并写明原因（至少 10 个字）'; // F3 冻结逐字
    const impact = reportForm({ milestone_impact: true });
    const tasksCount = async () => (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE project_id=?', [s.pid])).n;
    const att = (uid) => H.stageAtt(s.pid, uid || U.pm);
    const REC = {};
    const send = async (label, uid, form, extra) => { REC[label] = await reg(s, uid, form, extra); };
    const t0 = await tasksCount();
    // R6-2a：不勾里程碑，PM 代报（接替 trace-l2.js:102、:610）
    await send('R6-2a', U.pm, reportForm(), { source_party_id: s.dev }); REC.afterR62a = await tasksCount();
    if (REC['R6-2a'].status === 201) { // 194-M2：创建响应之外再采详情与列表，核「读接口」也没有 dev_confirm / conclusion_state
      REC.r62Detail = await get(U.pm, `/sysbuild/entries/${REC['R6-2a'].body.entry.id}`);
      REC.r62List = await get(U.pm, `/sysbuild/projects/${s.pid}/entries`);
    }
    // R6-4：勾影响里程碑 + 合规附件 + self_confirm_text → 400 field=self_confirm_text；R6-4-order：同时缺证据，仍先报该键（键检查在派生字段之前）
    await send('R6-4', U.x1, impact, { attachment_ids: [await att(U.x1)], self_confirm_text: CB });
    await send('R6-4-order', U.x1, impact, { self_confirm_text: CB });
    // R6-5：共用缺证请求（不带该键）→ 400 SYSBUILD_EVIDENCE_REQUIRED，新文案逐字；对照：不勾里程碑缺证据仍 201
    await send('R6-5', U.x1, impact);
    await send('R6-5-ctl-nomile', U.x1, reportForm());
    // R6-6：声明无书面证据 + 16 字原因，PM 代报
    await send('R6-6', U.pm, impact, { ...EVID, source_party_id: s.dev });
    // R6-7：三负例各勾 / 未勾影响里程碑两组共 6 请求
    for (const [tag, form] of [['mile', impact], ['nomile', reportForm()]]) {
      await send(`R6-7-short-${tag}`, U.x1, form, { no_written_evidence: true, no_evidence_reason: '短原因' });
      await send(`R6-7-both-${tag}`, U.x1, form, { attachment_ids: [await att(U.x1)], ...EVID });
      await send(`R6-7-reasononly-${tag}`, U.x1, form, { no_evidence_reason: EVID.no_evidence_reason });
    }
    // R6-8：合规附件，PM 与 x2 代表人本人各一条（due_on: null，不抵应交日）
    const before8 = await tasksCount();
    await send('R6-8-pm', U.pm, impact, { attachment_ids: [await att(U.pm)], source_party_id: s.dev });
    await send('R6-8-x2', U.x2, impact, { attachment_ids: [await att(U.x2)] }); REC.after8 = await tasksCount(); REC.before8 = before8;
    // R6-9：开发方负责人本人 x1（旧版带确认文案才能登记并建「已确认」任务）：不带 self_confirm_text → 201、任务表无新行、commitment_flag 为 0；带该键 → 400
    const before9 = await tasksCount();
    await send('R6-9-nokey', U.x1, impact, { attachment_ids: [await att(U.x1)] }); REC.after9 = await tasksCount(); REC.before9 = before9;
    await send('R6-9-withkey', U.x1, impact, { ...EVID, self_confirm_text: CB });
    // R6-10：x2 提交今日汇报（due_on = 今天，勾影响里程碑，合规附件；不与 R6-8 共用请求：R6-8 的 due_on 为 null 不抵应交日）→ 今日项 submitted、x2 的 report_due 里该项消失、PM 的 report_overdue 为空
    const dueBefore = mine(await todo(U.x2), 'report_due', s.pid).filter((x) => x.due_on === s.today);
    await send('R6-10', U.x2, reportForm({ due_on: s.today, milestone_impact: true }), { attachment_ids: [await att(U.x2)] });
    REC.dueBefore = dueBefore;
    REC.dueAfter = mine(await todo(U.x2), 'report_due', s.pid).filter((x) => x.due_on === s.today);
    REC.overdueAfter = mine(await todo(U.pm), 'report_overdue', s.pid);
    REC.nodeAfter = await nodeView(s);
    const fails = [];
    const chk = (label, fn) => { try { fn(); } catch (e) { fails.push(`[${label}] ${String(e.message).split('\n')[0].slice(0, 300)}`); } };
    const ok201 = (label) => { assert.strictEqual(REC[label].status, 201, `${label}: ${REC[label].text}`); };
    const taskFree = async (eid) => (await sqlGet("SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE object_type = 'dev_entry' AND object_id = ?", [eid])).n;
    chk('R6-2a 不勾里程碑 PM 代报 201、任务表无新行', () => { ok201('R6-2a'); assert.strictEqual(REC.afterR62a - t0, 0); });
    chk('R6-2 响应与读接口没有 dev_confirm 键、事件只有 entry_created', () => {
      const eid = REC['R6-2a'].body.entry.id;
      assert.strictEqual(REC.r62Detail.status, 200, REC.r62Detail.text); assert.strictEqual(REC.r62List.status, 200, REC.r62List.text);
      const row = REC.r62List.body.entries.find((x) => x.id === eid); assert.ok(row, '列表含这条汇报');
      for (const [where, e] of [['创建响应', REC['R6-2a'].body.entry], ['详情', REC.r62Detail.body.entry], ['列表行', row]]) {
        assert.ok(!('dev_confirm' in e), `${where} 没有 dev_confirm`); assert.ok(!('conclusion_state' in e), `${where} 没有 conclusion_state`);
      }
    });
    chk('R6-4 带 self_confirm_text 即 400 field=self_confirm_text', () => { expectErr(REC['R6-4'], 400, 'SYSBUILD_INVALID_INPUT', 'R6-4'); assert.strictEqual(REC['R6-4'].body.field, 'self_confirm_text'); assert.strictEqual(REC['R6-4'].body.message, '不支持的字段 self_confirm_text'); });
    chk('R6-4-order 键检查先于证据校验', () => { expectErr(REC['R6-4-order'], 400, 'SYSBUILD_INVALID_INPUT', 'R6-4-order'); assert.strictEqual(REC['R6-4-order'].body.field, 'self_confirm_text'); });
    chk('R6-5 影响里程碑缺证据 400 SYSBUILD_EVIDENCE_REQUIRED 新文案逐字', () => { expectErr(REC['R6-5'], 400, 'SYSBUILD_EVIDENCE_REQUIRED', 'R6-5'); assert.strictEqual(REC['R6-5'].body.message, IMPACT_MSG); });
    chk('R6-5-ctl-nomile 不勾里程碑缺证据仍 201（证据触发边界）', () => ok201('R6-5-ctl-nomile'));
    chk('R6-6 声明无书面证据 + 16 字原因 PM 代报 201', () => { ok201('R6-6'); });
    for (const tag of ['mile', 'nomile']) {
      chk(`R6-7 原因不足 10 字（${tag}）`, () => { expectErr(REC[`R6-7-short-${tag}`], 400, 'SYSBUILD_INVALID_INPUT', 'short'); assert.strictEqual(REC[`R6-7-short-${tag}`].body.field, 'no_evidence_reason'); });
      chk(`R6-7 已附附件又声明（${tag}）`, () => { expectErr(REC[`R6-7-both-${tag}`], 400, 'SYSBUILD_INVALID_INPUT', 'both'); assert.strictEqual(REC[`R6-7-both-${tag}`].body.field, 'no_written_evidence'); });
      chk(`R6-7 未声明却填原因（${tag}）`, () => { expectErr(REC[`R6-7-reasononly-${tag}`], 400, 'SYSBUILD_INVALID_INPUT', 'reasononly'); assert.strictEqual(REC[`R6-7-reasononly-${tag}`].body.field, 'no_evidence_reason'); });
    }
    chk('R6-8 合规附件 PM 与 x2 各一条 201、任务表无新行', () => { ok201('R6-8-pm'); ok201('R6-8-x2'); assert.strictEqual(REC.after8 - REC.before8, 0); });
    chk('R6-9 x1 本人不带键 201、无任务；带键 400', () => {
      ok201('R6-9-nokey'); assert.strictEqual(REC.after9 - REC.before9, 0);
      expectErr(REC['R6-9-withkey'], 400, 'SYSBUILD_INVALID_INPUT', 'R6-9-withkey'); assert.strictEqual(REC['R6-9-withkey'].body.field, 'self_confirm_text');
    });
    chk('R6-10 提交即算已交', () => {
      ok201('R6-10');
      assert.ok(REC.dueBefore.length === 1, '前置：提交前 x2 的 report_due 含今日项');
      const item = REC.nodeAfter.report.due_items.find((x) => x.due_on === s.today);
      assert.deepStrictEqual([item.submitted, item.report_entry_ids], [true, [REC['R6-10'].body.entry.id]]);
      assert.deepStrictEqual(REC.dueAfter, [], 'x2 的今日 report_due 消失（按项目与应交日匹配）');
      assert.deepStrictEqual(REC.overdueAfter, [], 'PM 的 report_overdue 为空');
    });
    // 落库核对：每个 201 的汇报没有认可任务、commitment_flag 为 0、事件只有 entry_created（异步取数后同样进 fails，不在第一条失败处停）
    for (const label of ['R6-2a', 'R6-5-ctl-nomile', 'R6-6', 'R6-8-pm', 'R6-8-x2', 'R6-9-nokey', 'R6-10']) {
      if (REC[label].status !== 201) { fails.push(`[${label} 落库] 请求不是 201：${REC[label].status} ${REC[label].text}`); continue; }
      const eid = REC[label].body.entry.id;
      try {
        assert.strictEqual(await taskFree(eid), 0, `${label}：没有认可任务`);
        assert.deepStrictEqual((await sqlAll("SELECT event_type FROM sysbuild_events WHERE object_type = 'entry' AND object_id = ? ORDER BY id", [eid])).map((x) => x.event_type), ['entry_created'], `${label}：事件只有 entry_created`);
      } catch (e) { fails.push(`[${label} 落库] ${String(e.message).split('\n')[0].slice(0, 300)}`); }
    }
    assert.strictEqual(fails.length, 0, fails.join(' ‖ '));
  });

  // ═══════════════════════ C6 新增（4.3 第 4 条）：entry_create_dev 判定矩阵（进度汇报登记权限不变）═══════════════════════
  //   接替整删的 devkey.js:589 手写矩阵与 :119 的 HTTP 部分；规则体按 F2 保留（只服务进度汇报登记权限）。M1407–M1411、M1491 改挂此用例（A.5），M1412 equivalent 于 M1491。
  test(`${T_C6_DEV}——手写矩阵：开发方负责人 / 代表人 / PM 代登放行，别的参与方负责人与代表人 / 一般成员 / admin 未接管 / 只读 / 事实没取到一律 403；项目状态 active / paused 放行、terminated / closed 409；HTTP：七格 403、同身份对照、来源方 400、非成员 404、暂停放行、已终止 / 已结项 409，被拒请求不留登记`, async () => {
    const R = mod('rules.js');
    const idn = (o) => Object.assign({ isPm: false, isAdmin: false, isReadonly: false, isMember: false, userId: 50, ownerOfParties: [], delegateOfParties: [] }, o);
    const chk = (i, st, t) => R.checkOp('entry_create_dev', i, { id: 1, status: st || 'active' }, t);
    const code = (v) => (v === null ? null : `${v.status}:${v.code}`);
    const DP = 7; const OP = 9; const TD = { devPartyId: DP };
    // ① 手写矩阵：放行
    assert.strictEqual(chk(idn({ isMember: true, ownerOfParties: [DP] }), 'active', TD), null, '开发方负责人放行');
    assert.strictEqual(chk(idn({ isMember: true, delegateOfParties: [DP] }), 'active', TD), null, '开发方代表人放行');
    assert.strictEqual(chk(idn({ isPm: true, isMember: true }), 'active', TD), null, 'PM 代登放行');
    assert.strictEqual(chk(idn({ isPm: true, isMember: true }), 'active', { devPartyId: null }), null, 'PM × devPartyId 缺失放行（rules.js 先判 PM，不依赖开发方参与方事实；来源方校验在端点层）');
    // ② 拒绝：按拒绝（403:SYSBUILD_FORBIDDEN）
    for (const [label, who, t] of [
      ['别的参与方负责人', idn({ isMember: true, ownerOfParties: [OP] }), TD], ['别的参与方代表人', idn({ isMember: true, delegateOfParties: [OP] }), TD],
      ['一般成员', idn({ isMember: true }), TD], ['admin 未接管', idn({ isAdmin: true }), TD], ['只读 PM', idn({ isPm: true, isMember: true, isReadonly: true }), TD],
      ['只读开发方负责人', idn({ isMember: true, isReadonly: true, ownerOfParties: [DP] }), TD],
      ['非 PM 且 devPartyId 为 null（事实没取到）', idn({ isMember: true, ownerOfParties: [DP] }), { devPartyId: null }], ['非 PM 且 devPartyId 缺失', idn({ isMember: true, ownerOfParties: [DP] }), {}],
    ]) assert.strictEqual(code(chk(who, 'active', t)), '403:SYSBUILD_FORBIDDEN', label);
    // ③ 项目状态按 accept 类：active / paused 放行、terminated / closed 409；无权者 403 先于项目状态
    const dev = idn({ isMember: true, ownerOfParties: [DP] });
    for (const [st, want] of [['active', null], ['paused', null], ['terminated', '409:SYSBUILD_PROJECT_READONLY'], ['closed', '409:SYSBUILD_PROJECT_READONLY']]) assert.strictEqual(code(chk(dev, st, TD)), want, `开发方负责人 × ${st}`);
    assert.strictEqual(code(chk(idn({ isMember: true }), 'terminated', TD)), '403:SYSBUILD_FORBIDDEN', '已终止项目：无权者先 403');
    assert.strictEqual(R.OP_KIND.entry_create_dev, 'accept', '类别手写：accept');
    // ④ HTTP：七格 403（x3 一般成员、m1 需求方一般成员、own 需求方负责人、del 需求方代表人、cand 内部成员、ro 只读账号、admin 未接管），被拒请求不留登记；同身份对照；来源方 400；非成员 404
    const s = await scene({ started: true });
    await addMember(s.pid, U.cand);
    const cnt = async (pid) => (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE project_id = ?', [pid || s.pid])).n;
    const REC = {};
    for (const [label, uid] of [['x3', U.x3], ['m1', U.m1], ['own', U.own], ['del', U.del], ['cand', U.cand], ['ro', U.ro], ['admin', U.admin]]) {
      const b = await cnt(); REC[`403-${label}`] = await reg(s, uid, reportForm()); REC[`403-${label}-n`] = (await cnt()) - b;
    }
    { const b = await cnt(); REC.out = await reg(s, U.out, reportForm()); REC['out-n'] = (await cnt()) - b; }
    { const b = await cnt(); REC.ctlGeneral = await post(U.x3, `/sysbuild/projects/${s.pid}/entries`, { type: 'feedback', title: '开发方一般成员的通用登记', body: '内容' }); REC['ctlGeneral-n'] = (await cnt()) - b; }
    { const b = await cnt(); REC.pmDemand = await reg(s, U.pm, reportForm(), { source_party_id: s.demand }); REC['pmDemand-n'] = (await cnt()) - b; }
    { const b = await cnt(); REC.pmNone = await reg(s, U.pm, reportForm()); REC['pmNone-n'] = (await cnt()) - b; }
    { // 194-L4：返回的 entry.id 在库里查得到且属本项目；196-M2：请求前后各采一次本项目登记编号集合，唯一新增的编号严格等于响应的 entry.id（同项目已有 ctlGeneral 等旧登记，接口若返回旧编号，只核行数 +1 与项目归属会漏过）
      const idsOf = async () => (await sqlAll('SELECT id FROM sysbuild_entries WHERE project_id = ?', [s.pid])).map((r) => r.id);
      const idsBefore = await idsOf();
      REC.x1ok = await reg(s, U.x1, reportForm());
      const idsAfter = await idsOf();
      REC['x1ok-n'] = idsAfter.length - idsBefore.length;
      REC.x1okNew = idsAfter.filter((id) => !idsBefore.includes(id));
      if (REC.x1ok.status === 201) REC.x1okRow = await sqlGet('SELECT project_id FROM sysbuild_entries WHERE id = ?', [REC.x1ok.body.entry.id]);
    }
    { const b = await cnt(); REC.pmDev = await reg(s, U.pm, reportForm(), { source_party_id: s.dev }); REC['pmDev-n'] = (await cnt()) - b; }
    // 部分暂停项目：开发方负责人登记进度汇报 201（accept 类）
    const sp = await scene({ started: true });
    assert.strictEqual((await post(U.admin, `/sysbuild/projects/${sp.pid}/status`, { to: 'paused', reason: 'C6 R6 用例' })).status, 200);
    REC.paused = await reg(sp, U.x1, reportForm());
    // 已终止：x1 合法进度汇报（勾影响里程碑、合规附件）409，同项目无权的 x3 403 先于项目状态；已结项（夹具）409
    const st = await scene({ started: true });
    assert.strictEqual((await post(U.admin, `/sysbuild/projects/${st.pid}/status`, { to: 'terminated', reason: 'C6 R6 用例' })).status, 200);
    { const b = await cnt(st.pid); REC.term = await reg(st, U.x1, reportForm({ milestone_impact: true }), { attachment_ids: [await H.stageAtt(st.pid, U.x1)] }); REC['term-n'] = (await cnt(st.pid)) - b; }
    { const b = await cnt(st.pid); REC.termX3 = await reg(st, U.x3, reportForm()); REC['termX3-n'] = (await cnt(st.pid)) - b; }
    const sc = await scene({ started: true });
    await sqlRun("UPDATE sysbuild_projects SET status = 'closed' WHERE id = ?", [sc.pid]);
    { const b = await cnt(sc.pid); REC.closed = await reg(sc, U.x1, reportForm()); REC['closed-n'] = (await cnt(sc.pid)) - b; }
    // PM × 项目没有开发方参与方：规则层 PM 放行，来源方校验在端点层给 400（不是 403）
    const nodev = await scene({ withDev: false, withPlan: false });
    { const b = await cnt(nodev.pid); REC.pmNoDev = await reg(nodev, U.pm, reportForm(), { source_party_id: nodev.demand }); REC['pmNoDev-n'] = (await cnt(nodev.pid)) - b; }
    const fails = [];
    const c = (label, fn) => { try { fn(); } catch (e) { fails.push(`[${label}] ${String(e.message).split('\n')[0].slice(0, 300)}`); } };
    for (const label of ['x3', 'm1', 'own', 'del', 'cand', 'ro', 'admin']) c(`七格 403：${label}`, () => { expectErr(REC[`403-${label}`], 403, 'SYSBUILD_FORBIDDEN', label); assert.strictEqual(REC[`403-${label}-n`], 0, '被拒不留登记'); });
    c('非成员 404', () => { expectErr(REC.out, 404, 'SYSBUILD_NOT_FOUND', 'out'); assert.strictEqual(REC['out-n'], 0); });
    c('同身份对照：x3 合法通用登记 201，来源方 = x3 所属开发方参与方', () => { assert.strictEqual(REC.ctlGeneral.status, 201, REC.ctlGeneral.text); assert.strictEqual(REC.ctlGeneral.body.entry.source_party_id, s.dev); assert.strictEqual(REC['ctlGeneral-n'], 1); });
    c('PM 填需求方来源 400 field=source_party_id', () => { expectErr(REC.pmDemand, 400, 'SYSBUILD_INVALID_INPUT', 'pmDemand'); assert.strictEqual(REC.pmDemand.body.field, 'source_party_id'); assert.strictEqual(REC.pmDemand.body.message, '进度汇报的来源方必须是开发方（项目经理代登请填写开发方参与方）'); assert.strictEqual(REC['pmDemand-n'], 0); });
    c('PM 不填来源方 400 field=source_party_id', () => { expectErr(REC.pmNone, 400, 'SYSBUILD_INVALID_INPUT', 'pmNone'); assert.strictEqual(REC.pmNone.body.field, 'source_party_id'); assert.strictEqual(REC['pmNone-n'], 0); });
    c('放行：开发方负责人 x1 201（成功格增量 1 且返回的 entry.id 查得到）', () => { assert.strictEqual(REC.x1ok.status, 201, REC.x1ok.text); assert.strictEqual(REC['x1ok-n'], 1); assert.ok(REC.x1okRow, '返回的 entry.id 在库里查得到'); assert.strictEqual(REC.x1okRow.project_id, s.pid, '登记属本项目'); assert.deepStrictEqual(REC.x1okNew, [REC.x1ok.body.entry.id], '请求前后本项目登记编号集合的唯一新增 = 响应 entry.id（196-M2）'); });
    c('放行：PM 代登 201', () => { assert.strictEqual(REC.pmDev.status, 201, REC.pmDev.text); assert.strictEqual(REC['pmDev-n'], 1); });
    c('部分暂停项目：开发方负责人登记进度汇报 201', () => assert.strictEqual(REC.paused.status, 201, REC.paused.text));
    c('已终止：开发方负责人合法进度汇报 409 SYSBUILD_PROJECT_READONLY、不留行', () => { expectErr(REC.term, 409, 'SYSBUILD_PROJECT_READONLY', 'term'); assert.strictEqual(REC['term-n'], 0); });
    c('已终止：无权的 x3 先 403、不留行', () => { expectErr(REC.termX3, 403, 'SYSBUILD_FORBIDDEN', 'termX3'); assert.strictEqual(REC['termX3-n'], 0); });
    c('已结项：开发方负责人 409 SYSBUILD_PROJECT_READONLY、不留行', () => { expectErr(REC.closed, 409, 'SYSBUILD_PROJECT_READONLY', 'closed'); assert.strictEqual(REC['closed-n'], 0); });
    c('PM × 无开发方参与方：400 field=source_party_id（规则层放行，不是 403）', () => { expectErr(REC.pmNoDev, 400, 'SYSBUILD_INVALID_INPUT', 'pmNoDev'); assert.strictEqual(REC.pmNoDev.body.field, 'source_party_id'); assert.strictEqual(REC['pmNoDev-n'], 0, '被拒不留登记'); });
    assert.strictEqual(fails.length, 0, fails.join(' ‖ '));
  });
}

const mu = (id, expect, file, from, to) => ({ id: `L2 ${id}`, expect: [`${P}${expect}`], edits: [{ file, from, to }] });
const TRACE_L2_MUTATIONS = [
  mu('未知报表候选不核登记类型', 'C8 报表未知候选', 'report-core.js', "hint === null && entry.type === 'note'", 'hint === null'),
  mu('未知报表候选不核表单提示', 'C8 报表未知候选', 'report-core.js', "hint === null && entry.type === 'note'", "entry.type === 'note'"),
  mu('汇报布尔类型不核', '三表单逐字段校验', 'entry-forms.js', "if (hasKey(form, 'milestone_impact') && typeof form.milestone_impact !== 'boolean') throw invalid(", 'if (false) throw invalid('),
  mu('汇报done不核最小长度', '三表单逐字段校验', 'entry-forms.js', "done: textField(form, 'done', 10, 2000)", "done: textField(form, 'done', 0, 2000)"),
  mu('汇报next不核最大长度', '三表单逐字段校验', 'entry-forms.js', "next: textField(form, 'next', 0, 2000)", "next: textField(form, 'next', 0, 3000)"),
  mu('节奏周期不核枚举', '三表单逐字段校验', 'entry-forms.js', "typeof form.cycle !== 'string' || !hasKey(CYCLE_LABELS, form.cycle)", 'false'),
  mu('日期允许不存在日', '三表单逐字段校验', 'entry-forms.js', 'date.getUTCFullYear() !== y || date.getUTCMonth() + 1 !== m || date.getUTCDate() !== d', 'false'),
  mu('临时事由不核长度', '三表单逐字段校验', 'entry-forms.js', "reason: textField(form, 'reason', 10, 500)", "reason: textField(form, 'reason', 0, 1000)"),
  mu('汇报不核开发来源', '登记人来源与节点', 'entry-forms.js', 'if (!(await entries.isDevParty(q, c.sourcePartyId))) throw invalid(', 'if (false) throw invalid('),
  mu('汇报取消登记人限制', '登记人来源与节点', 'entry-forms.js', "if (form.kind === 'progress_report') rules.assertOp('entry_create_dev', identity, project, { devPartyId: await require('./entries-core').devPartyIdOf(q, projectId) });", ''),
  mu('节奏要求不限PM', '登记人来源与节点', 'entry-forms.js', "['report_cycle', 'report_request'].includes(form.kind) && !rules.canActAsPm(identity)", 'false'),
  mu('表单可关联其他节点', '登记人来源与节点', 'entry-forms.js', 'if (!node || !dev || dev.id !== node.id) throw invalid(', 'if (!node) throw invalid('),
  mu('表单取消节点状态限制', '登记人来源与节点', 'entry-forms.js', "if (!(form.kind === 'report_cycle' ? ['not_started', 'in_progress'] : ['in_progress']).includes(node.status)) throw invalid(", 'if (false) throw invalid('),
  mu('首次日期不核计划及今天', '汇报日期校验', 'entry-forms.js', "form.first_due_on < state.current_plan.start || (node.status === 'in_progress' && form.first_due_on < today)", 'false'),
  mu('临时应交窗口取消', '汇报日期校验', 'entry-forms.js', 'if (form.due_on < today || form.due_on > cutoff) throw invalid(', 'if (false) throw invalid('),
  mu('汇报不核真实应交日', '汇报日期校验', 'entry-forms.js', 'if (!due.some((item) => item.due_on === form.due_on)) throw invalid(', 'if (false) throw invalid('),
  mu('节奏作废保护遗漏', '组合矩阵与勘误', 'rules.js', "if (t.formKind === 'report_cycle' || t.formKindHint === 'report_cycle') return", 'if (false) return'),
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
  mu('损坏节奏误用默认周期', '不可读三表单保守口径', 'report-core.js', '&& !state.cycle_unreadable && !state.cycle_unknown && state.started_on', '&& !state.cycle_unknown && state.started_on'),
  mu('未知节奏误用默认周期', '不可读未知kind', 'report-core.js', '&& !state.cycle_unreadable && !state.cycle_unknown && state.started_on', '&& !state.cycle_unreadable && state.started_on'),
  mu('无可用汇报节奏时遗漏提示', '汇报节奏缺回退时的提示', 'report-core.js', "warning = '当前没有可用的汇报节奏';", 'warning = null;'),
  mu('无法取事实按非开发放行', '生成器前提与失败保守', 'report-core.js', "if (facts.unreadable || facts.is_dev === null) return 'unknown';", "if (facts.unreadable || facts.is_dev === null) return 'not_dev_node';"),
  mu('视图窗口缩为30天', '节点HTTP视图与重开', 'report-core.js', 'const cutoff = facts.today ? addDays(facts.today, 31) : null;', 'const cutoff = facts.today ? addDays(facts.today, 30) : null;'),
  mu('待办截止误用1天', '待办汇报收件人与窗口', 'notify.js', 'reports.dueDatesOf(q, node, reports.addDays(today, 2), () => today)', 'reports.dueDatesOf(q, node, reports.addDays(today, 1), () => today)'),
  mu('已交仍催报', '待办汇报收件人与窗口', 'notify.js', 'if (item.submitted) continue;', ''),
  mu('开发待办忽略代表优先', '待办汇报收件人与窗口', 'report-recipients.js', 'const dueUser = await userOf(delegate || owner);', 'const dueUser = await userOf(owner || delegate);'),
  mu('无收件人提示遗漏', '临时要求无收件人', 'entries.js', 'response.no_recipient = true;', 'response.no_recipient = false;'),
  {"id":"L2 立项门遗漏","expect":["L2 留痕：立项门五例"],"edits":[{"file":"rules.js","from":"if (t.packageType === 'initiation' && t.initiationBasis !== 'ok') return","to":"if (false) return"}]},
  {"id":"L2 立项附件允许他节点","expect":["L2 留痕：立项门五例"],"edits":[{"file":"stage-cards.js","from":"m.node_id === nodeId && m.material_key === key && materialCore.isQualifiedVersion(m)","to":"materialCore.isQualifiedVersion(m)"}]},
  {"id":"L2 立项无附件也通过","expect":["L2 留痕：立项门五例"],"edits":[{"file":"stage-cards.js","from":"m.node_id === nodeId && m.material_key === key && materialCore.isQualifiedVersion(m)","to":"m.node_id === nodeId && m.material_key === key"}]},
  {"id":"L2 立项声明被忽略","expect":["L2 留痕：立项门五例"],"edits":[{"file":"stage-cards.js","from":"return { ok: !!state.declaration, declaration: state.declaration };","to":"return { ok: false, declaration: null };"}]},
  {"id":"L2 立项声明长度不核","expect":["L2 留痕：立项声明双重校验与scope同源"],"edits":[{"file":"stage-cards.js","from":"return length >= 10 && length <= 500 ? text : null;","to":"return text;"}]},
  {"id":"L2 立项取数失败放行","expect":["L2 留痕：立项声明双重校验与scope同源"],"edits":[{"file":"stage-cards.js","from":"    [pkg.project_id, expectedKey, pkg.type === 'batch_accept' ? pkg.batch_id : null]\n  );\n  if (nodes.length","to":"    [pkg.project_id, expectedKey, pkg.type === 'batch_accept' ? pkg.batch_id : null]\n  ).catch(() => [{ id: selected[0]?.node_id, status: 'not_started' }]);\n  if (nodes.length"}]},
  mu('上线附件上限放宽', '上线附件校验与原子性', 'golive.js', 'raw.length > 10', 'raw.length > 20'),
  mu('上线事件漏附件绑定', '上线撤销附件', 'golive.js', "// L2 golive: binding failure rolls back the event and the existing state transitions together.\n      await attachmentHelpers.bindStagedAttachments(q, { projectId: batch.project_id, userId: Number(user.id), attachmentIds, ownerType: 'golive_event', ownerId: rec.goliveEventId, operatorName: core.operatorNameOf(user) });", ''),
  mu('撤销事件漏附件绑定', '上线撤销附件', 'golive.js', "// L2 revoke: evidence is appended in the same transaction as the revoke event.\n      await attachmentHelpers.bindStagedAttachments(q, { projectId: batch.project_id, userId: Number(user.id), attachmentIds, ownerType: 'golive_event', ownerId: rec.goliveEventId, operatorName: core.operatorNameOf(user) });", ''),
  mu('上线凭据删除读标志放开', '上线撤销附件', 'attachments.js', "const evidence = await q.get(\"SELECT id FROM sysbuild_attachment_bindings WHERE attachment_id = ? AND owner_type IN ('schedule_record', 'golive_event', 'opinion_assessment') LIMIT 1\", [aid]);", "const evidence = await q.get(\"SELECT id FROM sysbuild_attachment_bindings WHERE attachment_id = ? AND owner_type IN ('schedule_record', 'opinion_assessment') LIMIT 1\", [aid]);"),
  mu('上线凭据删除写守卫遗漏', '上线撤销附件', 'attachments.js', "const evidenceBound = await q.get(\n        \"SELECT owner_type FROM sysbuild_attachment_bindings WHERE attachment_id = ? AND owner_type IN ('schedule_record', 'golive_event', 'opinion_assessment') LIMIT 1\",", "const evidenceBound = await q.get(\n        \"SELECT owner_type FROM sysbuild_attachment_bindings WHERE attachment_id = ? AND owner_type IN ('schedule_record', 'opinion_assessment') LIMIT 1\","),
  mu('未知kind错误识别为已知', '不可读未知kind', 'entry-forms.js', "typeof payload.form.kind === 'string' && hasKey(DEFINITIONS, payload.form.kind) ? payload.form.kind : null", "typeof payload.form.kind === 'string' ? payload.form.kind : null"),
  mu('节奏元数据向所有人开放', '表单元数据权限', 'entry-forms.js', "['report_cycle', 'report_request'].includes(kind) ? isPm === true : true", "['report_cycle', 'report_request'].includes(kind) ? true : true"),
  mu('进度元数据向所有人开放', '表单元数据权限', 'entry-forms.js', "kind === 'progress_report' ? devAllowed === true", "kind === 'progress_report' ? true"),
  mu('十个上线附件被错拒', '上线附件十个边界与撤销回滚', 'golive.js', 'raw.length > 10', 'raw.length >= 10'),
  mu('进度正文遗漏风险', '三表单正例与读视图', 'entry-forms.js', "\\n\\n风险\\n${form.risks || '未填写'}\\n\\n是否影响里程碑", '\\n\\n是否影响里程碑'),
  mu('节奏正文遗漏说明', '三表单正例与读视图', 'entry-forms.js', "body: title + (form.note ? '\\n\\n' + form.note : '')", 'body: title'),
  mu('临时要求正文遗漏事由', '三表单正例与读视图', 'entry-forms.js', "title: `临时汇报要求：${form.due_on} 前`, body: form.reason", "title: `临时汇报要求：${form.due_on} 前`, body: '临时要求'"),
  mu('进度汇报错误放宽32天', '进度汇报31天窗口', 'entry-forms.js', 'const cutoff = reports.addDays(today, 31);', 'const cutoff = reports.addDays(today, 32);'),
  mu('取数失败视图遗漏提示', '取数失败视图显式标记', 'report-core.js', "if (facts.unreadable) warning = '汇报事实无法读取';", 'if (facts.unreadable) warning = null;'),
  mu('取数失败视图遗漏不可读标志', '取数失败视图显式标记', 'report-core.js', '    facts_unreadable: facts.unreadable,', ''),
  // ── #212 C6 改挂（A.5 F-gone）：原载体 devkey.js 套件整删，写关键事项（进度汇报登记权限）的变异定义（id 不变）改挂到本套件的「C6 R6：entry_create_dev 判定矩阵」；M1412 equivalent 于 M1491 ──
  { id: 'C5 开发方：写关键事项对开发方成员一律放行', expect: [T_C6_DEV], edits: [{ file: 'rules.js', from: 'return ownsParty(identity, dp) || (Array.isArray(identity.delegateOfParties) && identity.delegateOfParties.includes(dp));', to: 'return true;' }] },
  { id: 'C5 开发方：开发方代表人不能写关键事项', expect: [T_C6_DEV], edits: [{ file: 'rules.js', from: ' || (Array.isArray(identity.delegateOfParties) && identity.delegateOfParties.includes(dp));\n    },\n    state: noStateLimit,', to: ';\n    },\n    state: noStateLimit,' }] },
  { id: 'C5 开发方：开发方负责人不能写关键事项', expect: [T_C6_DEV], edits: [{ file: 'rules.js', from: 'return ownsParty(identity, dp) || (Array.isArray(identity.delegateOfParties)', to: 'return false || (Array.isArray(identity.delegateOfParties)' }] },
  { id: 'C5 开发方：PM 不能代登关键事项', expect: [T_C6_DEV], edits: [{ file: 'rules.js', from: 'if (identity.isReadonly) return false;\n      if (canActAsPm(identity)) return true;', to: 'if (identity.isReadonly) return false;\n      if (identity.isSuper === true) return true;' }] },
  { id: 'C5 开发方：只读账号可写关键事项（只读否决去掉）', expect: [T_C6_DEV], edits: [{ file: 'rules.js', from: 'if (identity.isReadonly) return false;\n      if (canActAsPm(identity)) return true;', to: 'if (identity.isPm || identity.isSuper === true) return true;' }] },
  { id: 'C5 开发方：写关键事项的项目状态类别放宽成 resolve（规则表单拆：执行被建任务落点遮蔽，只由规则矩阵钉住）', expect: [T_C6_DEV], edits: [{ file: 'rules.js', from: "entry_create_dev: 'accept',", to: "entry_create_dev: 'resolve'," }] },
  // ── #212 C6 新增变异（A.3 N5–N7）：证据触发条件 / 证据可选 / self_confirm_text 放回白名单 ──
  { id: 'C6 R6：证据触发漏判 milestone_impact', expect: [T_C6_R6], edits: [{ file: 'entries.js', from: "input.type === 'material' ? 'material' : (input.form !== null && input.form.kind === 'progress_report' && input.form.milestone_impact === true ? 'direction' : 'optional')", to: "input.type === 'material' ? 'material' : (input.form !== null && input.form.kind === 'progress_report' ? 'direction' : 'optional')" }] },
  { id: 'C6 R6：影响里程碑不要求方向类证据', expect: [T_C6_R6], edits: [{ file: 'entries.js', from: "input.type === 'material' ? 'material' : (input.form !== null && input.form.kind === 'progress_report' && input.form.milestone_impact === true ? 'direction' : 'optional')", to: "input.type === 'material' ? 'material' : 'optional'" }] },
  { id: 'C6 R6：self_confirm_text 放回登记键白名单', expect: [T_C6_R6], edits: [{ file: 'entries.js', from: "'source_party_id', 'attachment_ids', 'no_written_evidence', 'no_evidence_reason', 'form',\n]);", to: "'source_party_id', 'attachment_ids', 'no_written_evidence', 'no_evidence_reason', 'form', 'self_confirm_text',\n]);" }] },
];
module.exports = { defineTraceL2Cases, TRACE_L2_MUTATIONS };
