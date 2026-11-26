// 验证脚本库：#212 第一步 C5（删除 S1 正式变更）与 C6（删除 S4 / S7 记录的旧办理规则）的新增用例与变异（承接 / 新增断言见生效清单第四节与附录 C）：
//   登记更正与作废的读出、R9（两张表单被拒、元数据三项）、
//   待办键集合、确认任务对象视图键集合、范围包生效后不能出新版本（新提示）、C6 现行总体规划不被第二版草稿 / 待确认抢占、撤回条件更新探针、N-RULES 纯规则与过期草稿提交，
//   以及被保留的 C5 变更类变异（载体用例随变更套件整删后改挂到这里）与新增变异。
//   由 sysbuild-api-suite.js 登记（同一套夹具、同一个变异自检）；期望值手写，直接写库只用于旧变更行 / 旧库遗留的夹具。
'use strict';
const assert = require('assert');
const path = require('path');

const T_R9 = 'C5 R9：change_request / dev_assessment 表单被拒';
const T_TODO = 'C5：待办七类键集合';
const T_OBJ = 'C5：确认任务对象视图键集合';
const T_D1 = 'C5：范围包生效后不能出新版本（新提示）';
const T_CUR = 'C6：现行总体规划不被第二版草稿 / 待确认抢占';
const T_PROBE = 'C5：撤回条件更新探针';
const T_RULES = 'C5 N-RULES：纯规则';
const T_STALE_DRAFT = 'C5 N-RULES：过期草稿提交';
const EVID = { no_written_evidence: true, no_evidence_reason: '口头电话确认了本次登记内容' };

function defineC5Cases(T) {
  const { test, U, api, sqlRun, sqlGet, sqlAll, expectErr, addMember, confirm: H } = T;
  const post = (uid, url, body) => api(uid, 'POST', url, body === undefined ? {} : body);
  const get = (uid, url) => api(uid, 'GET', url);
  const plain = (uid, pid, extra) => post(uid, `/sysbuild/projects/${pid}/entries`, Object.assign({ type: 'feedback', title: '普通意见登记', body: '一条没有表单的普通登记' }, extra || {}));
  const act = (uid, eid, body) => post(uid, `/sysbuild/entries/${eid}/actions`, body);
  const detail = async (uid, eid) => { const r = await get(uid, `/sysbuild/entries/${eid}`); assert.strictEqual(r.status, 200, r.text); return r.body.entry; };
  async function scene() {
    const pid = await H.newProject();
    const eff = await H.produceEffectiveOverall(pid);
    await addMember(pid, U.m1, { party: eff.party });
    return { pid, eff, batch: await H.defaultBatchId(pid) };
  }
  const rulesMod = () => require(path.join(T.getModuleDir(), 'rules.js'));
  const sameShape = (r) => ({ status: r.status, code: r.body.code, field: r.body.field, keys: Object.keys(r.body).sort() });

  test('C8 登记办理读出：保留更正、作废与只读边界', async () => {
    const s = await scene();
    const opened = await plain(U.pm, s.pid);
    assert.strictEqual(opened.status, 201, opened.text);
    const eid = opened.body.entry.id;
    const amended = await act(U.pm, eid, { action: 'correct', text: '更正说明' });
    assert.strictEqual(amended.status, 201, amended.text);
    const before = await sqlAll('SELECT * FROM sysbuild_entry_actions WHERE entry_id = ?', [eid]);
    const actionMark = () => sqlGet('SELECT MAX(id) AS last_id, COUNT(*) AS total FROM sysbuild_entry_actions');
    const beforeReads = await actionMark();
    const record = await detail(U.pm, eid);
    assert.deepStrictEqual(record.records.map(r => [r.action, r.text]), [['correct', '更正说明']]);
    assert.deepStrictEqual(Object.keys(record.records[0]), ['id', 'action', 'text', 'created_by', 'created_by_name', 'created_at']);
    assert.deepStrictEqual(record.actions, { correct: true, void: true });
    const list = await get(U.pm, `/sysbuild/projects/${s.pid}/entries`);
    assert.strictEqual(list.status, 200, list.text);
    assert.deepStrictEqual(list.body.entries.find(r => r.id === eid).actions, record.actions);
    assert.deepStrictEqual(await sqlAll('SELECT * FROM sysbuild_entry_actions WHERE entry_id = ?', [eid]), before);
    assert.deepStrictEqual(await actionMark(), beforeReads);

    const voided = await act(U.pm, eid, { action: 'void', reason: '读出核对' });
    assert.strictEqual(voided.status, 201, voided.text);
    const beforeVoidedReads = await actionMark();
    const after = await detail(U.pm, eid);
    assert.strictEqual(after.voided, true);
    assert.deepStrictEqual(after.records.map(({ action }) => action), ['correct', 'void']);
    assert.deepStrictEqual(after.actions, { correct: false, void: false });
    const voidedList = await get(U.pm, `/sysbuild/projects/${s.pid}/entries`);
    const listRow = voidedList.body.entries.find((row) => row.id === eid);
    assert.deepStrictEqual([listRow.voided, listRow.actions], [true, after.actions]);
    assert.deepStrictEqual(await actionMark(), beforeVoidedReads);
  });

  // ── R9：两张表单被拒、元数据三项 ───────────────────────────────────────────────────────────────
  test(`${T_R9}——两张表单各一条请求 400 field=form.kind；GET /entries 元数据 registration.forms 恰为三项；self_confirm_text 键出现即拒 400 field=self_confirm_text（R6-4：退出键，不看值、不看是否影响里程碑）`, async () => {
    const s = await scene();
    for (const kind of ['change_request', 'dev_assessment']) {
      const r = await post(U.pm, `/sysbuild/projects/${s.pid}/entries`, { form: { kind } });
      expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', `${kind} 被拒`);
      assert.strictEqual(r.body.field, 'form.kind', `${kind} 的 field`);
    }
    // 三类调用者各读一次 registration.forms：三张保留表单各自的 allowed / conditions / label / type / purpose 与旧版实采值（<S>，old-capture.json OC23）逐项全等；改动只允许数组由五项变三项
    const devParty = await T.addParty(s.pid, '研发方', 'dev');
    const devOwner = await addMember(s.pid, U.x1, { party: devParty });
    await T.addAppointment(devParty, devOwner, 'active');
    const FORM_OLD = {
      progress_report: { kind: 'progress_report', label: '进度汇报', type: 'note', purpose: 'general', conditions: '开发方负责人、代表人或项目经理代登；来源方为开发方；关联进行中的开发节点；影响里程碑须方向类证据' }, // F3 冻结逐字（C6）
      report_cycle: { kind: 'report_cycle', label: '汇报节奏', type: 'note', purpose: 'general', conditions: '项目经理登记；关联未开始或进行中的开发节点；修改节奏请新登，原登记不可作废' },
      report_request: { kind: 'report_request', label: '临时汇报要求', type: 'note', purpose: 'general', conditions: '项目经理登记；关联进行中的开发节点；应交日在今天至未来31天内' },
    };
    const ALLOWED = { 项目经理: [U.pm, [true, true, true]], '有开发权限的非项目经理（开发方负责人）': [U.x1, [true, false, false]], '两者都不具备（一般成员）': [U.m1, [false, false, false]] };
    for (const [who, [uid, flags]] of Object.entries(ALLOWED)) {
      const meta = await get(uid, `/sysbuild/projects/${s.pid}/entries`);
      assert.strictEqual(meta.status, 200, meta.text);
      assert.deepStrictEqual(meta.body.registration.forms, ['progress_report', 'report_cycle', 'report_request'].map((k, i) => Object.assign({}, FORM_OLD[k], { allowed: flags[i] })), `${who}：forms 恰为三张保留表单，字段与旧版实采值全等`);
    }
    const bad = await post(U.pm, `/sysbuild/projects/${s.pid}/entries`, { form: { kind: 'report_request', due_on: '2099-01-01', reason: '请开发方补充本周接口联调进展说明' }, self_confirm_text: '我已阅读以上全部内容，确认无误' });
    expectErr(bad, 400, 'SYSBUILD_INVALID_INPUT', 'self_confirm_text');
    assert.deepStrictEqual([bad.body.field, bad.body.message], ['self_confirm_text', '不支持的字段 self_confirm_text'], 'R6-4：退出键出现即拒（onlyKeys，先于表单校验）');
    // 一对合法的普通进度汇报（开发方负责人登记、有效开发节点、来源方为开发方）：基础请求 201；同一请求加 self_confirm_text 则 400（退出键，field 与文案同上）——
    //   上面的 report_request 反例带了越界应交日，覆盖不到「合法的普通进度汇报带 self_confirm_text」，进度汇报分支若误放行该字段只有这一对能判红
    const nid = (await sqlGet("SELECT id FROM sysbuild_nodes WHERE project_id = ? AND template_key = 'b_dev'", [s.pid])).id;
    await H.prepareDevStart(s.pid, nid);
    assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${nid}/start`)).status, 200, '夹具：开发节点开工');
    const PROGRESS = { kind: 'progress_report', due_on: null, done: '已完成接口联调的第一阶段工作', next: '继续推进第二阶段联调工作', risks: null, milestone_impact: false };
    const entryCount = async () => (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE project_id = ?', [s.pid])).n;
    const n0 = await entryCount();
    const okRes = await post(U.x1, `/sysbuild/projects/${s.pid}/entries`, { form: PROGRESS, node_id: nid });
    assert.strictEqual(okRes.status, 201, okRes.text);
    assert.deepStrictEqual([okRes.body.entry.form_kind, okRes.body.entry.form_label], ['progress_report', '进度汇报']);
    assert.strictEqual(await entryCount(), n0 + 1, '基础请求落一条登记');
    const withSelf = await post(U.x1, `/sysbuild/projects/${s.pid}/entries`, { form: PROGRESS, node_id: nid, self_confirm_text: '我已阅读以上全部内容，确认无误' });
    expectErr(withSelf, 400, 'SYSBUILD_INVALID_INPUT', '普通进度汇报带 self_confirm_text');
    assert.deepStrictEqual([withSelf.body.field, withSelf.body.message], ['self_confirm_text', '不支持的字段 self_confirm_text']);
    assert.strictEqual(await entryCount(), n0 + 1, '被拒请求不落登记');
  });

  // ── 待办七类键集合 / 确认任务对象视图键集合 ──────────────────────────────────────────────────────
  test(`${T_TODO}——GET /my/todo 的 counts / items 键集合不再有 change_assess`, async () => {
    const r = await get(U.pm, '/sysbuild/my/todo');
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(Object.keys(r.body.counts).sort(), ['badge', 'confirm', 'handle', 'opinion', 'overdue', 'report_due', 'report_overdue', 'send_failed', 'work_task']);
    assert.deepStrictEqual(Object.keys(r.body.items).sort(), ['confirm', 'handle', 'opinion', 'overdue', 'report_due', 'report_overdue', 'send_failed', 'work_task']);
  });

  test(`${T_OBJ}——内容包确认任务的对象视图键集合：type / package / version / snapshot_json / materials / node_plans，不再有 change、assessment 与 items`, async () => {
    const pid = await H.newProject();
    await H.seedParty(pid, '需求方', U.own, U.del);
    await H.produceEffectiveInitiation(pid);
    await H.planAllNodes(pid);
    const pk = await H.mkPackage(pid, 'overall');
    const vid = await H.mkPreparedVersion(pk);
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${vid}/submit`)).status, 200);
    const task = (await H.tasksOf(vid))[0];
    const view = await get(task.user_id, `/sysbuild/confirm-tasks/${task.task_id}`);
    assert.strictEqual(view.status, 200, view.text);
    assert.deepStrictEqual(Object.keys(view.body.object).sort(), ['materials', 'node_plans', 'package', 'snapshot_json', 'type', 'version'], '对象视图键集合（C5-RC22；#212 C7 起不再有 items）');
  });

  // ── 范围包生效后不能出新版本（新提示）──────────────────────────────────────────────────────────────
  test(`${T_D1}——总体规划包已有生效版本时通用建版本端点 409 SYSBUILD_STATE，文案「范围已确认，不能再出新版本」`, async () => {
    const s = await scene();
    const r = await post(U.pm, `/sysbuild/packages/${s.eff.pk}/versions`, {});
    expectErr(r, 409, 'SYSBUILD_STATE', '范围已确认');
    assert.strictEqual(r.body.message, '范围已确认，不能再出新版本');
  });

  // ── C6：现行总体规划不被第二版草稿 / 待确认抢占（接替 C5 N-CUR：去掉 item_ids 登记与分流快照，只留包列表现行版本的读取规则；变异 N18）───────────────
  test(`${T_CUR}——第二版总体规划草稿期、待确认期 GET /projects/:pid/packages 的 overall_version_id 仍是第一版，生效后切到第二版（夹具造第二版，C5 起没有生产入口）`, async () => {
    const s = await scene();
    // 夹具：第二版总体规划草稿（直接写库，form 照第一版）；经正式提交入口提交并全部确认生效
    const form = (await sqlGet('SELECT form FROM sysbuild_package_versions WHERE id = ?', [s.eff.pv])).form;
    const max = await sqlGet('SELECT MAX(version_no) AS n FROM sysbuild_package_versions WHERE package_id = ?', [s.eff.pk]);
    const v2 = (await sqlRun("INSERT INTO sysbuild_package_versions (package_id, version_no, form, status, snapshot_json, created_by) VALUES (?, ?, ?, 'draft', '{}', ?)", [s.eff.pk, max.n + 1, form, U.pm])).lastID;
    // 第二版草稿 / 待确认期间现行总体规划仍是第一版（实现若误取最大版本号或最新创建的版本，包列表现行版本判红）
    const cur = async () => (await get(U.pm, `/sysbuild/projects/${s.pid}/packages`)).body.overall_version_id;
    assert.strictEqual(await cur(), s.eff.pv, '第二版草稿期：现行总体规划仍是第一版');
    await sqlRun("UPDATE sysbuild_package_versions SET status = 'pending' WHERE id = ?", [v2]);
    assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id = ?', [v2])).status, 'pending', '前置：第二版待确认');
    assert.strictEqual(await cur(), s.eff.pv, '第二版待确认期：现行总体规划仍是第一版');
    await sqlRun("UPDATE sysbuild_package_versions SET status = 'superseded' WHERE id = ?", [s.eff.pv]);
    await sqlRun("UPDATE sysbuild_package_versions SET status = 'effective', effective_at = datetime('now','localtime') WHERE id = ?", [v2]);
    assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id = ?', [s.eff.pv])).status, 'superseded', '前置：第一版已被替代');
    assert.strictEqual(await cur(), v2, '第二版生效后：现行总体规划切到第二版');
  });

  // ── 撤回条件更新探针（4.3 第 13 条；N18 / M2043 的真实影响行数探针）──────────────────────────────────
  //   包装真实库：get / all / 其余 run 原样交真实库，只在看到目标 UPDATE 时先把版本改成 effective（读到 pending 之后、执行更新之前，等同并发确认生效），再把原 SQL 交真实库执行，
  //   由真实影响行数决定响应。事务用桩 withWriteTxn: (fn) => fn(q)（不回滚），夹具写入走测试助手 sqlRun（直连、自动提交），所以 409 之后版本仍是 effective。
  test(`${T_PROBE}——撤回的条件更新：目标 UPDATE 在版本已被并发确认生效时真实影响 0 行 → 409「版本状态已变化」，版本未被覆盖、待确认修订未失效、没有新的撤回事件（先完成调用并记录，再汇总断言）`, async () => {
    const pid = await H.newProject();
    await H.seedParty(pid, '甲部', U.own, U.del);
    await H.seedEffectiveInitiation(pid);
    const vid = await H.mkPreparedVersion(await H.mkPackage(pid, 'overall'));
    await H.planAllNodes(pid);
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${vid}/submit`)).status, 200, '夹具：正常入口提交，带待确认任务修订');
    const revStates = () => sqlAll("SELECT r.id AS id, r.status AS status FROM sysbuild_confirm_task_revisions r JOIN sysbuild_confirm_tasks t ON t.id = r.task_id WHERE t.object_type = 'package_version' AND t.object_version_id = ? ORDER BY r.id", [vid]);
    const wdEvents = async () => (await sqlGet("SELECT COUNT(*) AS n FROM sysbuild_events WHERE object_type = 'package_version' AND object_id = ? AND event_type = 'package_version_withdrawn'", [vid])).n;
    const revsBefore = await revStates();
    assert.ok(revsBefore.length > 0 && revsBefore.every((x) => x.status === 'pending'), '前置：待确认修订在场且都是 pending');
    const REC = { targetSql: null, changes: null, params: null };
    const q = { get: sqlGet, all: sqlAll, run: async (sql, params) => {
      if (/^UPDATE sysbuild_package_versions SET status = 'superseded'/.test(sql)) {
        REC.targetSql = sql; REC.params = params;
        await sqlRun("UPDATE sysbuild_package_versions SET status = 'effective', effective_at = datetime('now','localtime') WHERE id = ?", [vid]);
        const r = await sqlRun(sql, params); REC.changes = r.changes; return r;
      }
      return sqlRun(sql, params);
    } };
    const mod = require(path.join(T.getModuleDir(), 'confirm.js'));
    const { router } = mod.createConfirmRoutes({ db: { withWriteTxn: (fn) => fn(q) }, logger: { error() {} }, readonlyIds: [], writeRoles: ['admin', 'publisher', 'user'], attachmentHelpers: { freezeAttachmentSet: async () => [] } });
    const layer = router.stack.find((x) => x.route && x.route.path === '/sysbuild/package-versions/:vid/withdraw');
    const user = await sqlGet('SELECT id, role, username, display_name FROM users WHERE id = ?', [U.pm]);
    const evBefore = await wdEvents();
    const response = await new Promise((resolve) => {
      const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { resolve({ status: this.statusCode, body }); return this; } };
      layer.route.stack[layer.route.stack.length - 1].handle({ params: { vid: String(vid) }, body: { reason: '条件更新探针' }, user }, res);
    });
    REC.status = response.status; REC.code = response.body.code; REC.message = response.body.message;
    REC.verStatus = (await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id = ?', [vid])).status;
    REC.revs = await revStates(); REC.newEvents = (await wdEvents()) - evBefore;
    const fails = [];
    const chk = (label, fn) => { try { fn(); } catch (e) { fails.push(`[${label}] ${String(e.message).split('\n')[0].slice(0, 300)}`); } };
    chk('SQL 文本', () => { assert.ok(REC.targetSql && REC.targetSql.includes("WHERE id = ? AND status = 'pending'"), '旧状态必须在 UPDATE 条件中'); assert.deepStrictEqual(REC.params, [vid]); });
    chk('影响行数', () => assert.strictEqual(REC.changes, 0, `目标 UPDATE 的真实影响行数应为 0，实际 ${REC.changes}`));
    chk('A1 响应', () => assert.deepStrictEqual([REC.status, REC.code, REC.message], [409, 'SYSBUILD_STATE', '版本状态已变化，请刷新后重试']));
    chk('A2 版本未被覆盖', () => assert.strictEqual(REC.verStatus, 'effective', '版本仍是 effective（没有被覆盖成 superseded）'));
    chk('A3 无新增副作用', () => {
      assert.deepStrictEqual(REC.revs, revsBefore, `确认修订的编号集合与状态前后全等（按编号排序比较；部分修订被删除或改状态都会判红），实际 ${JSON.stringify(REC.revs)}`);
      assert.ok(REC.revs.length > 0 && REC.revs.every((x) => x.status === 'pending'), `待确认修订仍是 pending，实际 ${JSON.stringify(REC.revs)}`);
      assert.strictEqual(REC.newEvents, 0, '没有新的 package_version_withdrawn 事件');
    });
    assert.strictEqual(fails.length, 0, fails.join(' ‖ ')); // 单行：变异记录只保留失败信息首行，各标签都要在这一行里
  });

  // ── N-RULES：纯规则与过期草稿提交（M1326 / M1333 / M1335）────────────────────────────────────────
  test(`${T_RULES}——rules.checkOp 纯规则：package_version_submit 的父版本过期（parentSuperseded）只对总体规划包 / 批次需求包拒绝，验收包 / 结项包不拒绝`, async () => {
    const R = rulesMod();
    const pm = { isPm: true, isAdmin: false };
    const chk = (op, target) => R.checkOp(op, pm, { status: 'active' }, target);
    const SUB = { versionStatus: 'draft', confirmersMissing: null, historyConflict: null, otherPendingPackage: null, initiationEffective: true, planMissing: null, pairedBasis: true, hasConfirmationText: true };
    const MSG = '草稿所基于的总体规划版本已被替代，请基于现行规划重建草稿';
    const r1 = chk('package_version_submit', Object.assign({ packageType: 'overall', parentSuperseded: true }, SUB));
    assert.strictEqual(r1.message, MSG, '总体规划包：父版本过期被拒');
    assert.strictEqual(chk('package_version_submit', Object.assign({ packageType: 'overall', parentSuperseded: false }, SUB)), null, '父版本不过期：放行');
    assert.strictEqual(chk('package_version_submit', Object.assign({ packageType: 'initiation', parentSuperseded: false, initiationBasis: 'ok' }, SUB)), null, '立项包正常提交：放行');
    assert.strictEqual(chk('package_version_submit', Object.assign({ packageType: 'batch_req', parentSuperseded: true }, SUB)).message, MSG, '批次需求包：父版本过期 → 同文案');
    assert.strictEqual(chk('package_version_submit', Object.assign({ packageType: 'batch_req', parentSuperseded: false }, SUB)).message, '该类型的内容包 C5 / C6 起可用提交确认', '批次需求包：不过期时仍是「C5 / C6 起可用」文案（对照）');
    assert.strictEqual(chk('package_version_submit', Object.assign({ packageType: 'batch_accept', batchStatus: 'active', parentSuperseded: true }, SUB)), null, '验收包不受父版本过期限制（提交时重写）');
    assert.strictEqual(chk('package_version_submit', Object.assign({ packageType: 'closing', closingNotReady: null, parentSuperseded: true }, SUB)), null, '结项包不受父版本过期限制');
  });

  test(`${T_STALE_DRAFT}——HTTP 夹具：总体规划草稿的父版本写成已被替代的版本 → 提交 409「请基于现行规划重建草稿」`, async () => {
    const s = await scene();
    const max = await sqlGet('SELECT MAX(version_no) AS n FROM sysbuild_package_versions WHERE package_id = ?', [s.eff.pk]);
    const stale = (await sqlRun("INSERT INTO sysbuild_package_versions (package_id, version_no, form, status, snapshot_json, created_by) VALUES (?, ?, 'overall', 'superseded', '{}', ?)", [s.eff.pk, max.n + 1, U.pm])).lastID;
    const draft = (await sqlRun("INSERT INTO sysbuild_package_versions (package_id, version_no, parent_overall_version_id, form, status, snapshot_json, created_by) VALUES (?, ?, ?, 'overall', 'draft', '{}', ?)", [s.eff.pk, max.n + 2, stale, U.pm])).lastID;
    const r = await post(U.pm, `/sysbuild/package-versions/${draft}/submit`);
    expectErr(r, 409, 'SYSBUILD_STATE', '父版本过期');
    assert.strictEqual(r.body.message, '草稿所基于的总体规划版本已被替代，请基于现行规划重建草稿');
    assert.strictEqual((await get(U.pm, `/sysbuild/package-versions/${draft}`)).body.actions.submit, false, '提交标志同源为假');
  });
}

// ── 变异 ───────────────────────────────────────────────────────────────────────────────────────
// 每条 { id, expect: [用例名前缀], edits: [{ file, from, to }] }；锚点必须在副本里恰好出现一次（LF 归一后）。
const cm = (id, expect, file, from, to) => ({ id: `C5 变更：${id}`, expect, edits: [{ file, from, to }] });
const nm = (id, expect, file, from, to) => ({ id, expect, edits: [{ file, from, to }] });
const C5_MUTATIONS = [
  // ── 保留的 C5 变更类变异（载体用例随变更套件整删，expect 改挂到承接用例）──
  cm('提交：继承来源已被替代也放行', [T_RULES, T_STALE_DRAFT], 'rules.js', 'if (t.parentSuperseded === true && !PARENT_REWRITTEN_AT_SUBMIT_TYPES.includes(t.packageType)) return PARENT_SUPERSEDED_MESSAGE;', ''),
  cm('继承来源被替代的事实恒为假', [T_STALE_DRAFT], 'packages.js', "facts.parentSuperseded = !!p && p.status === 'superseded';", 'facts.parentSuperseded = false;'),
  cm('变更包的确认人不含代表人', ['C6a 上线：批次验收包提交', 'C6a 上线：结项包提交'], 'confirm-core.js', "batch_accept: 'delegate', closing: 'delegate'", "batch_accept: 'owner', closing: 'owner'"),
  // ── C6f 放回（codex 190-M2）：C6 机读清单按「目标行落在删除区间」把这两条误列退役，目标行 rules.js:131 与承接用例都保留 ──
  nm('C5 R10：建包最终清单加回 change', ['C5 R10：通用建包入口按最终清单拒绝'], 'rules.js', "const PACKAGE_TYPES_FINAL = Object.freeze(['initiation', 'overall', 'batch_accept', 'closing']);", "const PACKAGE_TYPES_FINAL = Object.freeze(['initiation', 'overall', 'change', 'batch_accept', 'closing']);"),
  nm('C5 R10：建包最终清单加回 batch_req', ['C5 R10：通用建包入口按最终清单拒绝'], 'rules.js', "const PACKAGE_TYPES_FINAL = Object.freeze(['initiation', 'overall', 'batch_accept', 'closing']);", "const PACKAGE_TYPES_FINAL = Object.freeze(['initiation', 'overall', 'batch_req', 'batch_accept', 'closing']);"),
  // ── C5 提交新增的变异（生效清单 A.3：N1–N24；上面 C6f 放回的两条不在 N1–N24 之内，C6 新增的 N18 在本数组末尾另有小标题）──
  nm('C5 R10：类型错误的 field 写错', ['C5 R10：通用建包入口按最终清单拒绝'], 'packages.js', "throw invalid(`type 必须是 ${rules.PACKAGE_TYPES_FINAL.join(' / ')} 之一`, 'type');", "throw invalid(`type 必须是 ${rules.PACKAGE_TYPES_FINAL.join(' / ')} 之一`, 'batch_id');"),
  nm('C5 R10：包列表可建类型与建包入口不同源', ['C5 R10：create_package_types 与建包入口逐类型同源'], 'packages.js', 'for (const type of rules.PACKAGE_TYPES_FINAL) {', 'for (const type of rules.PACKAGE_TYPES_FINAL.slice(1)) {'),
  nm('C5 R9：表单定义仍含需求变更申请', [T_R9], 'entry-forms.js', 'const DEFINITIONS = Object.freeze({', "const DEFINITIONS = Object.freeze({\n  change_request: Object.freeze({ label: '需求变更申请', type: 'feedback', purpose: 'general', fields: ['kind'], conditions: 'x' }),"),
  nm('C5：待办仍带 change_assess 键', [T_TODO], 'notify.js', 'counts.report_overdue = reportOverdue.length; items.report_overdue = cap(reportOverdue);', 'counts.report_overdue = reportOverdue.length; items.report_overdue = cap(reportOverdue); counts.change_assess = 0; items.change_assess = [];'),
  nm('C5：确认任务对象视图仍带 change 键', [T_OBJ], 'confirm.js', 'package: { id: pkg.id, type: pkg.type, batch_id: pkg.batch_id },', 'package: { id: pkg.id, type: pkg.type, batch_id: pkg.batch_id }, change: null,'),
  nm('C5：验收包过期提示仍写「已被变更替换」', ['C5：ACCEPT_STALE / CLOSING_STALE / PLAN_PENDING 新文案'], 'golive-core.js', "message: '本批批次验收包引用的版本不是现行范围版本，须基于现行范围版本重新提交批次验收并确认'", "message: '本批批次验收包确认时引用的总体规划已被变更替换，须基于现行总体规划重新提交批次验收并确认'"),
  nm('C5：结项包过期提示仍写「已被变更替换」', ['C5：ACCEPT_STALE / CLOSING_STALE / PLAN_PENDING 新文案'], 'plan.js', "message: '结项包引用的版本不是现行范围版本，须基于现行范围版本重新提交结项包并确认'", "message: '结项包确认时引用的总体规划已被变更替换，须基于现行总体规划重新提交结项包并确认'"),
  nm('C5：范围包生效后出新版本的提示仍指向正式变更', [T_D1], 'rules.js', "if (t.packageType === 'overall' && t.hasEffective) return '范围已确认，不能再出新版本';", "if (t.packageType === 'overall' && t.hasEffective) return '总体规划已生效，修改须经正式变更（C5）';"),
  nm('C5：撤回的条件更新漏旧状态', [T_PROBE], 'confirm.js', "WHERE id = ? AND status = 'pending'\", [vid]);", 'WHERE id = ?", [vid]);'),
  nm('C5：收口 PACKAGE_PENDING 的类型顺序被反转', ['C6a 上线：结项前置核验结项包引用的现行规划与待确认的内容包'], 'entries-core.js', "AND v.status = 'pending' ORDER BY p.type`,", "AND v.status = 'pending' ORDER BY p.type DESC`,"),
  { id: 'C5 R10：类型校验晚于批次校验', expect: ['C5 R10：通用建包入口按最终清单拒绝'], edits: [
    { file: 'packages.js', from: "if (typeof body.type !== 'string' || !rules.PACKAGE_TYPES_FINAL.includes(body.type)) {", to: 'if (false) {' },
    { file: 'packages.js', from: "throw invalid('该类型的内容包不挂批次', 'batch_id');", to: "throw invalid('该类型的内容包不挂批次', 'batch_id');\n    }\n    if (typeof body.type !== 'string' || !rules.PACKAGE_TYPES_FINAL.includes(body.type)) {\n      throw invalid(`type 必须是 ${rules.PACKAGE_TYPES_FINAL.join(' / ')} 之一`, 'type');" },
  ] },
  { id: 'C5 R10：类型校验晚于可见性与权限', expect: ['C5 R10：通用建包入口按最终清单拒绝'], edits: [
    { file: 'packages.js', from: "if (typeof body.type !== 'string' || !rules.PACKAGE_TYPES_FINAL.includes(body.type)) {", to: 'if (false) {' },
    { file: 'packages.js', from: "rules.assertOp('package_create', access, access.project, { type, exists, batchStatus: batch ? batch.status : undefined });", to: "rules.assertOp('package_create', access, access.project, { type, exists, batchStatus: batch ? batch.status : undefined });\n      if (typeof body.type !== 'string' || !rules.PACKAGE_TYPES_FINAL.includes(body.type)) throw invalid('type 必须是 initiation / overall / batch_accept / closing 之一', 'type');" },
  ] },
  // ── #212 C6 新增（A.3 N18）：现行总体规划的现行版本改取 version_no 最大的版本 → 第二版草稿 / 待确认期判红 ──
  // #212 C7（#716）：原锚点在被删的 resolveCurrentPlan 里，改挂到 packages.js 包列表读接口的新取值点（变量名 overallVersionId、项目编号 pid）
  nm('C6 现行总体规划：现行版本改取最新创建版本', [T_CUR], 'packages.js', 'const overallVersionId = await effectiveOverallVersionId(q, pid);', "const overallVersionId = ((await q.get(\"SELECT v.id AS id FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id WHERE p.project_id = ? AND p.type = 'overall' ORDER BY v.version_no DESC LIMIT 1\", [pid])) || { id: null }).id;"),
  nm('C5：上线前置 PLAN_PENDING 提示仍写「或变更」', ['C5：ACCEPT_STALE / CLOSING_STALE / PLAN_PENDING 新文案'], 'golive-core.js', "message: '项目里有待确认的总体规划，须等确认完成或撤回后再上线'", "message: '项目里有待确认的总体规划或变更，须等确认完成或撤回后再上线'"),
];

module.exports = { defineC5Cases, C5_MUTATIONS };
