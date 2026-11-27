// 验证脚本库：项目管理（系统建设记录）模块 C4a——内容包提交与确认、撤回、任务改发、浏览记录、平台确认、包生效与基线、待我确认（#113 段 4 C4a）的用例
//   方案：docs/local/系统建设记录/系统建设记录_平台集成_方案_20261030_v1.2.md §2.2 不变量 2–5 / 9、§4.2、§4.4、§4.5、§5、§6.2、§7「确认」组
//   派单：docs/local/系统建设记录/送审准备/C4a_提交确认生效基线_派单_20261101.md §3
//
// 本文件只放用例、共用助手与变异，由 sysbuild-api-suite.js 登记（同一套夹具、同一个变异自检）。期望值一律手写，不取自被测代码。
//   makeConfirmHelpers(T)：「生产路径生效」共用助手——交接 ②：C3 的夹具直接把总体规划版本改成 effective 并插 baseline，C4a 起凡是能经生产路径
//     到达的 effective 用例都改用 produceEffectiveOverall（造需求部门参与方 + 提交 + 全部确认）；经生产路径到不了的状态
//     （总体规划版本被替代、已有生效版本之后再出草稿等，C5 正式变更前不可达）保留夹具，用例名标「（夹具）」。
// 夹具规则：建项走 POST /projects；包 / 版本 / 提交 / 撤回 / 浏览 / 决策 / 改发全部走生产端点。只有这几类直接写库：
//   ① 需求部门参与方、成员、任职、授权（membership 套件另有端点用例，这里只要「现任负责人 / 生效代表人」这个事实）；② 附件行与附件软删除；
//   ③ 篡改版本 form / parent / 状态、浏览记录时间、冻结清单（构造「库内与现状不符」）；④ 总体规划第二个版本（D1：C5 前无生产路径）。
'use strict';
const assert = require('assert');

// 固定勾选文案（手写，与服务端常量逐字相等才算勾选，§4.2）。修订批三 M-3：按决策分设，三条都以「我已阅读以上全部内容」开头；CHECKBOX = 确认那一条（沿用旧名，大多数用例提交的是确认）。
const CHECKBOXES = {
  confirm: '我已阅读以上全部内容，确认无误',
  object: '我已阅读以上全部内容，对其有异议（原因见下）',
  reject: '我已阅读以上全部内容，不认可（原因见下）',
};
const CHECKBOX = CHECKBOXES.confirm;
const EV = { no_written_evidence: true, no_evidence_reason: '口头电话确认了本次需求内容' };

function makeConfirmHelpers(T) {
  const { U, api, sqlRun, sqlGet, sqlAll, addMember, addParty, addAppointment, addDelegation, createEmptyProjectFixture } = T;
  const post = (uid, url, body) => api(uid, 'POST', url, body === undefined ? {} : body);
  const get = (uid, url) => api(uid, 'GET', url);
  let projSeq = 0;
  let attSeq = 0;
  const runTag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  async function newProject(buildType, pm) {
    projSeq += 1;
    return createEmptyProjectFixture(pm || U.pm, { system_name: `确认测试项目${projSeq}`, build_type: buildType || 'inhouse' });
  }
  const defaultBatchId = async (pid) => (await sqlGet('SELECT id FROM sysbuild_batches WHERE project_id = ? AND is_default = 1', [pid])).id;
  // 需求部门参与方 + 现任负责人（+ 生效代表人）：直接写库（夹具①）。返回各编号。
  async function seedParty(pid, name, ownerUid, delegateUid) {
    const party = await addParty(pid, name, 'demand');
    const mOwn = await addMember(pid, ownerUid, { party });
    const apt = await addAppointment(party, mOwn, 'active');
    let mDel = null;
    let dlg = null;
    if (delegateUid) {
      mDel = await addMember(pid, delegateUid, { party });
      dlg = await addDelegation(party, mDel, apt, 'active');
    }
    return { party, mOwn, apt, mDel, dlg };
  }
  async function stageAtt(pid, uid, shaChar) {
    attSeq += 1;
    const r = await sqlRun(
      "INSERT INTO sysbuild_attachments (project_id, file_name, original_name, mime_type, size, sha256, is_image, uploaded_by) VALUES (?, ?, '确认证据.txt', 'text/plain', 3, ?, 0, ?)",
      [pid, `c4a-${runTag}-${attSeq}.txt`, (shaChar || 'b').repeat(64), uid]
    );
    return r.lastID;
  }
  async function mkPackage(pid, type, batchId) {
    const r = await post(U.pm, `/sysbuild/projects/${pid}/packages`, batchId ? { type, batch_id: batchId } : { type });
    assert.strictEqual(r.status, 201, r.text);
    return r.body.package.id;
  }
  async function mkVersion(pkid) {
    const r = await post(U.pm, `/sysbuild/packages/${pkid}/versions`);
    assert.strictEqual(r.status, 201, r.text);
    await prepareConfirmationText(r.body.version.id);
    return r.body.version.id;
  }
  async function prepareConfirmationText(vid) {
    const row = await sqlGet('SELECT snapshot_json FROM sysbuild_package_versions WHERE id = ?', [vid]);
    const snapshot = JSON.parse(row.snapshot_json);
    if (!Object.hasOwn(snapshot, 'text')) {
      const saved = await api(U.pm, 'PATCH', `/sysbuild/package-versions/${vid}`, {
        snapshot_json: { ...snapshot, text: '本次需要确认的内容及依据' },
      });
      assert.strictEqual(saved.status, 200, saved.text);
    }
  }
  // 为以其他分支为观测目标的范围/验收场景准备明确指定的材料。
  async function prepareBasisVersion(vid) {
    await prepareConfirmationText(vid);
    const row = await sqlGet(
      `SELECT p.project_id, p.type, p.batch_id, v.snapshot_json, r.build_type
         FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id
         JOIN sysbuild_projects r ON r.id = p.project_id WHERE v.id = ?`, [vid]
    );
    if (!['overall', 'batch_accept'].includes(row.type)) return null;
    const range = row.type === 'overall';
    const key = range ? 'requirements-document' : 'acceptance-record';
    const stage = range ? 'p_overall' : { outsource: 'b_uat', procurement: 'b_training', inhouse: 'b_golive' }[row.build_type];
    const node = await sqlGet('SELECT id FROM sysbuild_nodes WHERE project_id = ? AND template_key = ? AND batch_id IS ?', [row.project_id, stage, range ? null : row.batch_id]);
    assert.ok(node, `夹具缺少材料阶段 ${stage}`);
    const snapshot = JSON.parse(row.snapshot_json);
    const selected = snapshot.material_version_ids || [];
    const stored = await sqlAll(
      'SELECT v.id FROM sysbuild_material_versions v JOIN sysbuild_materials m ON m.id = v.material_id WHERE m.node_id = ? AND m.material_key = ?',
      [node.id, key]
    );
    const has = new Set(stored.map((item) => item.id));
    if (selected.some((id) => has.has(id))) return selected.find((id) => has.has(id));
    const attachment = await stageAtt(row.project_id, U.pm, 'e');
    await sqlRun("UPDATE sysbuild_attachments SET original_name = '配对确认材料.txt' WHERE id = ?", [attachment]);
    const made = await post(U.pm, `/sysbuild/nodes/${node.id}/materials/${key}/versions`, { attachment_ids: [attachment] });
    assert.strictEqual(made.status, 201, `夹具材料：${made.text}`);
    const id = made.body.version.id;
    const saved = await api(U.pm, 'PATCH', `/sysbuild/package-versions/${vid}`, {
      snapshot_json: { ...snapshot, material_version_ids: [...selected, id] },
    });
    assert.strictEqual(saved.status, 200, `夹具选入依据：${saved.text}`);
    return id;
  }
  async function mkPreparedVersion(pkid) {
    const vid = await mkVersion(pkid);
    await prepareBasisVersion(vid);
    return vid;
  }
  async function prepareAdditionalClosingCards(pid) {
    const nodes = await sqlAll(
      "SELECT id, template_key FROM sysbuild_nodes WHERE project_id = ? AND status <> 'cancelled' AND (template_key = 'p_contract' OR is_golive_milestone = 1)",
      [pid]
    );
    for (const node of nodes) {
      const key = node.template_key === 'p_contract' ? 'contract-order' : 'operations-handover';
      const response = await post(U.pm, `/sysbuild/nodes/${node.id}/materials/${key}/not-applicable`, { reason: '此测试场景不涉及合同或实际运维移交' });
      assert.strictEqual(response.status, 201, response.text);
    }
  }
  // 声明经真实材料卡写入；正例草稿的正文单独准备。
  async function declareInitiationBasis(vid) {
    await prepareConfirmationText(vid);
    const row = await sqlGet(
      `SELECT n.id FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id
        JOIN sysbuild_nodes n ON n.project_id = p.project_id AND n.template_key = 'p_initiation' AND n.batch_id IS NULL WHERE v.id = ?`, [vid]);
    const r = await post(U.pm, `/sysbuild/nodes/${row.id}/materials/initiation-basis/not-applicable`, { reason: '原确认流程用例采用口头立项依据说明' });
    assert.strictEqual(r.status, 201, `立项正例补依据声明: ${r.text}`);
  }
  // 每个任务（package_version 类）的当前修订 + 必需确认人的用户编号
  const tasksOf = (vid) => sqlAll(
    `SELECT t.id AS task_id, t.party_id AS party_id, t.purpose AS purpose, t.object_id AS object_id, t.object_version_id AS object_version_id,
            r.id AS rev_id, r.rev_no AS rev_no, r.status AS status, r.status_reason AS status_reason, r.required_member_id AS required_member_id,
            r.basis_appointment_id AS basis_appointment_id, r.basis_delegation_id AS basis_delegation_id, m.user_id AS user_id
       FROM sysbuild_confirm_tasks t JOIN sysbuild_confirm_task_revisions r ON r.task_id = t.id JOIN sysbuild_members m ON m.id = r.required_member_id
      WHERE t.object_type = 'package_version' AND t.object_version_id = ? AND r.rev_no = (SELECT MAX(r2.rev_no) FROM sysbuild_confirm_task_revisions r2 WHERE r2.task_id = t.id)
      ORDER BY t.id`,
    [vid]
  );
  const openTask = (uid, tid) => get(uid, `/sysbuild/confirm-tasks/${tid}`);
  const decideBodyOf = (o, decision, extra) => Object.assign(
    { revision_id: o.revision.id, object_version_id: o.task.object_version_id, decision, checkbox_text: CHECKBOXES[decision] },
    decision === 'confirm' ? {} : { reason: '内容有出入，需要说明' },
    extra || {}
  );
  const decideRaw = (uid, tid, body) => post(uid, `/sysbuild/confirm-tasks/${tid}/decide`, body);
  async function openAndDecide(uid, tid, decision, extra) {
    const o = await openTask(uid, tid);
    assert.strictEqual(o.status, 200, o.text);
    return decideRaw(uid, tid, decideBodyOf(o.body, decision, extra));
  }
  // 全部待确认任务由各自的必需确认人打开并确认（生产路径）。返回最后一次决策的响应。
  async function confirmAll(vid) {
    let last = null;
    for (const t of await tasksOf(vid)) {
      if (t.status !== 'pending') continue;
      last = await openAndDecide(t.user_id, t.task_id, 'confirm');
      assert.strictEqual(last.status, 200, `任务 ${t.task_id} 确认: ${last.text}`);
    }
    return last;
  }
  // 计划齐全前置（修订批三 H-1 / P43）：总体规划包提交前，应形成基线的节点须已有当前计划。给本项目全部未取消且尚无计划的节点写一条草稿期计划（生产端点，必须 201），
  //   已有计划的节点不动（所以用例可先给个别节点设特定计划，再调用本助手补齐其余）。只能在项目还没有生效的总体规划版本时使用（之后写计划走改期规则，要原因与证据）。
  //   返回被补计划的节点数。日期固定（与 plan 套件的 planAll 同一组），用例要核对基线 / 计划清单时按这组日期手写期望。
  const PLAN_START = '2026-11-02';
  const PLAN_END = '2026-11-30';
  async function planAllNodes(pid) {
    const view = await get(U.pm, `/sysbuild/projects/${pid}/plan`);
    assert.strictEqual(view.status, 200, view.text);
    let n = 0;
    for (const node of view.body.nodes) {
      if (node.status === 'cancelled' || node.current_plan) continue;
      const r = await post(U.pm, `/sysbuild/nodes/${node.id}/schedule`, { kind: 'plan', planned_start: PLAN_START, planned_end: PLAN_END });
      assert.strictEqual(r.status, 201, `节点 ${node.template_key || node.name} 补计划: ${r.text}`);
      n += 1;
    }
    return n;
  }
  // L2 §10：具体正向场景调用；只准备仍未开始的模板开发节点，不改已有计划或节奏。
  async function prepareDevStart(pid, nid) {
    const view = await get(U.pm, `/sysbuild/projects/${pid}/plan`);
    assert.strictEqual(view.status, 200, view.text);
    const node = view.body.nodes.find((n) => n.id === nid);
    assert.ok(node, `开发节点正例准备：节点 ${nid} 存在`);
    if (!['b_dev', 'b_config'].includes(node.template_key) || node.status !== 'not_started') return;
    if (!node.current_plan) {
      const evidence = node.plan_write_mode === 'reschedule' ? { reason: '旧正向用例补齐开发节点计划', ...EV } : {};
      const r = await post(U.pm, `/sysbuild/nodes/${nid}/schedule`, { kind: 'plan', planned_start: PLAN_START, planned_end: PLAN_END, ...evidence });
      assert.strictEqual(r.status, 201, `开发节点正例补计划: ${r.text}`);
    }
    if (!node.report || !node.report.current_cycle) {
      const r = await post(U.pm, `/sysbuild/projects/${pid}/entries`, { node_id: nid, form: { kind: 'report_cycle', cycle: 'weekly', first_due_on: node.current_plan ? node.current_plan.start : PLAN_START } });
      assert.strictEqual(r.status, 201, `开发节点正例补节奏: ${r.text}`);
    }
  }
  // 立项包前置（P37）：总体规划包提交前须本项目立项包已有生效版本。
  //   produceEffectiveInitiation = 生产路径（建立项包 / 草稿 / 提交 / 全部确认；项目里已有立项包则在它上面再出一个草稿版本）；
  //   seedEffectiveInitiation = 夹具（直接写一个已生效的立项包版本，不产生任务 / 浏览 / 事件）——只给「并不关心立项包」的提交用例准备前置，
  //   避免它的任务 / 确认 / 生效事件混进以项目为范围的计数与事件断言。
  async function produceEffectiveInitiation(pid) {
    const has = await sqlGet("SELECT id FROM sysbuild_packages WHERE project_id = ? AND type = 'initiation'", [pid]);
    const pk = has ? has.id : await mkPackage(pid, 'initiation');
    const pv = await mkVersion(pk);
    await declareInitiationBasis(pv);
    const sub = await post(U.pm, `/sysbuild/package-versions/${pv}/submit`);
    assert.strictEqual(sub.status, 200, sub.text);
    await confirmAll(pv);
    const v = await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id = ?', [pv]);
    assert.strictEqual(v.status, 'effective', '生产路径生效后立项包版本应为 effective');
    return { pk, pv };
  }
  async function seedEffectiveInitiation(pid) {
    const pk = (await sqlRun("INSERT INTO sysbuild_packages (project_id, batch_id, type, created_by) VALUES (?, NULL, 'initiation', ?)", [pid, U.pm])).lastID;
    const pv = (await sqlRun(
      "INSERT INTO sysbuild_package_versions (package_id, version_no, form, status, effective_at, snapshot_json, created_by) VALUES (?, 1, NULL, 'effective', datetime('now','localtime'), ?, ?)",
      [pk, JSON.stringify({ no_written_basis_reason: '立项生效的夹具已具有冻结的无书面依据声明' }), U.pm]
    )).lastID;
    return { pk, pv };
  }
  // 交接 ② 共用助手：经生产路径让 pid 的总体规划版本生效——补一个需求部门参与方（负责人 own + 代表人 del，已有则不补）、立项包生效（P37 前置，已有生效版本则不补）、
  //   总体规划包、草稿版本、提交、全部确认。返回 { pk, pv, party }。pid 里已有同类包时复用（opts.pk）。
  async function produceEffectiveOverall(pid, opts) {
    const o = opts || {};
    let party = o.party || null;
    if (!party) {
      const has = await sqlGet("SELECT id FROM sysbuild_parties WHERE project_id = ? AND side = 'demand' LIMIT 1", [pid]);
      if (!has) party = (await seedParty(pid, '甲部', U.own, U.del)).party;
    }
    const iniEff = await sqlGet("SELECT v.id AS id FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id WHERE p.project_id = ? AND p.type = 'initiation' AND v.status = 'effective'", [pid]);
    if (!iniEff) await produceEffectiveInitiation(pid);
    const pk = o.pk || await mkPackage(pid, 'overall');
    const pv = await mkPreparedVersion(pk);
    if (!o.noPlans) await planAllNodes(pid); // H-1：提交前计划须齐全（用例已给个别节点设的计划保留，其余补齐）
    const sub = await post(U.pm, `/sysbuild/package-versions/${pv}/submit`);
    assert.strictEqual(sub.status, 200, sub.text);
    await confirmAll(pv);
    const v = await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id = ?', [pv]);
    assert.strictEqual(v.status, 'effective', '生产路径生效后版本应为 effective');
    return { pk, pv, party };
  }
  // ── C6a 共用助手：经生产路径让批次正式上线（确认试运行结束，POST /batches/:bid/golive）与撤销 ───────────────────────────────────────────────────────────
  //   readyForGolive：满足上线前置——批次验收包（建包 / 草稿 / 提交 / 全部确认）经生产路径生效，本批除里程碑外的节点全部（开始并）收口；只用于「批次进行中、没有别的未结登记」的场景，
  //   有登记要办理的用例自己先办结。productionGolive / productionRevoke：调端点并断言 200；上线事件时刻默认回拨一小时（「已正式上线」要求当前时刻严格晚于事件时刻，
  //   不回拨的话刚上线的同一秒内读到的是「未上线」，用例不能依赖墙钟）。
  async function acceptEffective(pid, batchId) {
    const pk = await mkPackage(pid, 'batch_accept', batchId);
    const pv = await mkPreparedVersion(pk);
    const sub = await post(U.pm, `/sysbuild/package-versions/${pv}/submit`);
    assert.strictEqual(sub.status, 200, sub.text);
    await confirmAll(pv);
    const v = await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id = ?', [pv]);
    assert.strictEqual(v.status, 'effective', '批次验收包经生产路径生效后版本应为 effective');
    return { pk, pv };
  }
  async function closeBatchNodes(pid, batchId) {
    const nodes = await sqlAll("SELECT id, status FROM sysbuild_nodes WHERE project_id = ? AND batch_id = ? AND is_golive_milestone = 0 AND status <> 'cancelled' ORDER BY sort_order, id", [pid, batchId]);
    for (const n of nodes) {
      if (n.status === 'closed') continue;
      if (n.status === 'not_started') {
        await prepareDevStart(pid, n.id);
        const s = await post(U.pm, `/sysbuild/nodes/${n.id}/start`);
        assert.strictEqual(s.status, 200, s.text);
      }
      const c = await post(U.pm, `/sysbuild/nodes/${n.id}/close`);
      assert.strictEqual(c.status, 200, `节点 ${n.id} 收口: ${c.text}`);
    }
  }
  async function readyForGolive(pid, batchId) {
    const acc = await acceptEffective(pid, batchId);
    await closeBatchNodes(pid, batchId);
    return acc;
  }
  async function productionGolive(batchId, offset) {
    const r = await post(U.pm, `/sysbuild/batches/${batchId}/golive`);
    assert.strictEqual(r.status, 200, r.text);
    if (offset !== null) await sqlRun("UPDATE sysbuild_golive_events SET created_at = datetime('now','localtime', ?) WHERE id = ?", [offset || '-1 hour', r.body.golive_event.id]);
    return r.body;
  }
  async function productionRevoke(batchId, reason) {
    const r = await post(U.admin, `/sysbuild/batches/${batchId}/revoke-golive`, { reason: reason || '用例撤销上线' });
    assert.strictEqual(r.status, 200, r.text);
    return r.body;
  }
  async function seedHistoricalLeaderTask(pid, pk, pv, party) {
    const task = await sqlRun(
      "INSERT INTO sysbuild_confirm_tasks (project_id, object_type, object_id, object_version_id, purpose, party_id, created_by) VALUES (?, 'package_version', ?, ?, 'package_confirm', ?, ?)",
      [pid, pk, pv, party.party, U.pm]
    );
    await sqlRun(
      "INSERT INTO sysbuild_confirm_task_revisions (task_id, rev_no, required_member_id, basis_appointment_id, status, created_by) VALUES (?, 1, ?, ?, 'pending', ?)",
      [task.lastID, party.mOwn, party.apt, U.pm]
    );
  }
  return {
    newProject, defaultBatchId, seedParty, seedHistoricalLeaderTask, stageAtt, mkPackage, mkVersion, mkPreparedVersion, prepareBasisVersion, prepareAdditionalClosingCards, tasksOf, openTask, decideBodyOf, decideRaw, openAndDecide, confirmAll,
    planAllNodes, PLAN_START, PLAN_END, declareInitiationBasis, prepareDevStart, produceEffectiveInitiation, seedEffectiveInitiation, produceEffectiveOverall,
    acceptEffective, closeBatchNodes, readyForGolive, productionGolive, productionRevoke,
  };
}

function defineConfirmCases(T) {
  const { test, U, api, sqlRun, sqlGet, sqlAll, expectErr, eventsOf, addMember, addParty, addAppointment, addDelegation, confirm: H } = T;
  const post = (uid, url, body) => api(uid, 'POST', url, body === undefined ? {} : body);
  const get = (uid, url) => api(uid, 'GET', url);
  const payloads = async (pid, type) => (await eventsOf(pid, type)).map((e) => JSON.parse(e.payload_json));
  const { newProject, defaultBatchId, seedParty, seedHistoricalLeaderTask, stageAtt, mkPackage, mkPreparedVersion: mkVersion, tasksOf, openTask, decideBodyOf, decideRaw, openAndDecide, confirmAll, declareInitiationBasis, prepareDevStart, produceEffectiveInitiation, seedEffectiveInitiation, planAllNodes, PLAN_START, PLAN_END } = H;
  const setStatus = (pid, to) => post(U.admin, `/sysbuild/projects/${pid}/status`, { to, reason: '确认用例' });
  const submit = (uid, vid) => post(uid, `/sysbuild/package-versions/${vid}/submit`);
  const withdraw = (uid, vid, reason) => post(uid, `/sysbuild/package-versions/${vid}/withdraw`, reason === undefined ? {} : { reason });
  const reissue = (uid, tid, reason) => post(uid, `/sysbuild/confirm-tasks/${tid}/reissue`, reason === undefined ? {} : { reason });
  const verStatus = async (vid) => (await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id = ?', [vid])).status;
  const isInproc = () => !!(T.getFixedToday && T.getFixedToday());
  const rowOf = (table, id) => sqlGet(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  const revOf = (rid) => rowOf('sysbuild_confirm_task_revisions', rid);
  const countOf = async (s, p) => (await sqlGet(s, p)).n;
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  // 节点的基线 / 计划记录种类（按 id 升序）
  const recordsKinds = async (nid) => (await sqlAll("SELECT kind FROM sysbuild_node_schedule_records WHERE node_id = ? AND kind IN ('baseline', 'plan_change') ORDER BY id", [nid])).map((r) => r.kind);
  const frozenOf = (type, vid) => sqlAll('SELECT attachment_id, sha256 FROM sysbuild_frozen_attachments WHERE object_type = ? AND object_version_id = ? ORDER BY attachment_id', [type, vid]);
  // 项目内全部节点的 baseline 记录（只看本项目：各用例共用一个库，不能数全库）
  const baselinesIn = (pid) => sqlAll(
    `SELECT r.id AS id, r.node_id AS node_id, r.planned_start AS planned_start, r.planned_end AS planned_end, r.package_version_id AS package_version_id, r.created_by AS created_by, r.reason AS reason
       FROM sysbuild_node_schedule_records r JOIN sysbuild_nodes n ON n.id = r.node_id WHERE n.project_id = ? AND r.kind = 'baseline' ORDER BY r.id`,
    [pid]
  );
  const baselineCount = async (pid) => (await baselinesIn(pid)).length;
  // 自研范围确认清单，手写期望，按职责排序。
  const INHOUSE_NODES = [
    ['b_golive', '上线（含测试与验收）', 'batch', ['acceptance', 'golive']],
    ['p_closing', '结项', 'project', ['closing']],
  ];
  const nodeIdOf = async (pid, key) => (await sqlGet('SELECT id FROM sysbuild_nodes WHERE project_id = ? AND template_key = ?', [pid, key])).id;
  // 自研项目全部节点都按 planAllNodes 补过计划（或经 plans 覆盖个别节点日期 [起, 止]）时，提交事件 node_plans 的期望值（H-2 快照字段手写，不取自被测代码）。
  //   cancelled = 已取消的模板键（不进清单）。
  async function inhouseNodePlans(pid, plans, cancelled) {
    const batch = await defaultBatchId(pid);
    const out = [];
    for (const [key, name, layer, roles] of INHOUSE_NODES) {
      if ((cancelled || []).includes(key)) continue;
      const [ps, pe] = (plans && plans[key]) || [PLAN_START, PLAN_END];
      out.push({
        node_id: await nodeIdOf(pid, key), name, layer, batch_id: layer === 'batch' ? batch : null, batch_name: layer === 'batch' ? '第 1 批' : null,
        template_key: key, planned_start: ps, planned_end: pe, roles,
      });
    }
    return out;
  }
  const memberRow = async (pid, uid) => (await sqlGet('SELECT id FROM sysbuild_members WHERE project_id = ? AND user_id = ? AND removed_at IS NULL ORDER BY id LIMIT 1', [pid, uid])).id;

  // 标准场景：甲部（负责人 own、代表人 del）、乙部（负责人 x1、代表人 x2）、包版本自己绑定一个证据附件、总体规划包草稿已提交。返回各编号与 4 个任务。
  //   #212 C7：没有条目这一路，附件直接写库绑到包版本（owner_type = package_version，C4a 没有绑定它的端点；写法同「C4a 提交：总体规划包成功」），冻结仍走 attachmentSources 里 package_version 一路。
  //   立项包前置（P37）用夹具 seedEffectiveInitiation（不产生任务 / 确认事件）；opt.noInitiation = 不补；opt.prepare(pid) = 提交之前的准备（如给节点设计划：
  //   总体规划待确认期间排期被冻结，P34，所以要在提交前做完）。计划齐全前置（H-1）：prepare 之后用 planAllNodes 把其余节点补齐（11-02 ~ 11-30）；opt.noPlans = 不补。
  async function mkSubmitted(opt) {
    const o = opt || {};
    const pid = await newProject();
    const A = await seedParty(pid, '甲部', U.own, U.del);
    const B = o.single ? null : await seedParty(pid, '乙部', U.x1, U.x2);
    if (!o.noInitiation) await seedEffectiveInitiation(pid);
    const att = o.noAtt ? null : await stageAtt(pid, U.pm, 'a');
    const pk = await mkPackage(pid, 'overall');
    const pv = await mkVersion(pk);
    const batch = await defaultBatchId(pid);
    const basisVersion = await H.prepareBasisVersion(pv);
    const basisAttachment = (await sqlGet("SELECT attachment_id FROM sysbuild_attachment_bindings WHERE owner_type = 'material_version' AND owner_id = ?", [basisVersion])).attachment_id;
    if (att) await sqlRun("INSERT INTO sysbuild_attachment_bindings (attachment_id, owner_type, owner_id, bound_by) VALUES (?, 'package_version', ?, ?)", [att, pv, U.pm]);
    if (o.prepare) await o.prepare(pid);
    if (!o.noPlans) await planAllNodes(pid); // H-1：提交前计划须齐全；prepare 里设过计划的节点保留，其余补齐（opt.noPlans = 不补，用来造「缺计划」）
    if (o.historicalLeaderTasks) {
      // 保留旧任职任务的规则覆盖，提交入口仍只创建现行所需的负责人任务。
      await seedHistoricalLeaderTask(pid, pk, pv, A);
      if (B) await seedHistoricalLeaderTask(pid, pk, pv, B);
    }
    const sub = await submit(U.pm, pv);
    assert.strictEqual(sub.status, 200, sub.text);
    const tasks = await tasksOf(pv);
    const by = {};
    for (const t of tasks) by[t.user_id] = t;
    return { pid, A, B, att, basisAttachment, pk, pv, batch, sub, tasks, T: { aOwner: by[U.own], aDel: by[U.del], bOwner: by[U.x1], bDel: by[U.x2] } };
  }
  // 未提交的合格草稿（可对其做各种破坏后再提交）：甲部（own / del）+ 立项包已生效（夹具，opt.noInitiation 不补）+ 总体规划包的草稿版本（没有附件）。
  async function mkDraft(opt) {
    const o = opt || {};
    const pid = await newProject();
    const A = o.noParty ? null : await seedParty(pid, '甲部', U.own, o.noDelegate ? null : U.del);
    const ini = o.noInitiation ? null : await seedEffectiveInitiation(pid);
    const pk = await mkPackage(pid, 'overall');
    const pv = await mkVersion(pk);
    const batch = await defaultBatchId(pid);
    if (!o.noPlans) await planAllNodes(pid); // H-1：计划齐全（opt.noPlans = 不补）
    return { pid, A, pk, pv, batch, ini };
  }

  // ── rules：手写期望（四个新动作的项目状态类别与目标判定）───────────────────────────────────────────
  test('C4a rules：新动作的项目状态类别手写核对——提交 / 撤回 / 改发 = maintain 行（进行中 / 已暂停 是，已终止 / 已结项 否），决策 = accept 行；只读账号否决提交类但不否决本人决策；决策的错误码', async () => {
    const R = T.getMods().rules;
    const kinds = { package_version_submit: 'maintain', package_version_withdraw: 'maintain', confirm_reissue: 'maintain', confirm_decide: 'accept' };
    for (const [op, k] of Object.entries(kinds)) assert.strictEqual(R.OP_KIND[op], k, `${op} 的类别`);
    const rowAllowed = { active: true, paused: true, terminated: false, closed: false };
    const pm = { isPm: true, isReadonly: false };
    // 提交的项目级事实（修订批二 MED-1）：确认人齐全（confirmersMissing = null）、立项包已生效；缺失按 fail-closed 拒绝（下面单独断言）
    const F = { confirmersMissing: null, initiationEffective: true, initiationBasis: 'ok', pairedBasis: true, planMissing: null, historyConflict: null, otherPendingPackage: null, hasConfirmationText: true };
    const targets = {
      package_version_submit: Object.assign({ versionStatus: 'draft', packageType: 'overall', batchStatus: undefined }, F),
      package_version_withdraw: { versionStatus: 'pending', batchStatus: undefined },
      confirm_reissue: { objectType: 'package_version', objectStatus: 'pending', revisionStatus: 'objected', batchStatus: undefined, historyConflict: null },
    };
    for (const op of Object.keys(targets)) {
      for (const [st, ok] of Object.entries(rowAllowed)) assert.strictEqual(R.opAllowed(op, pm, { status: st }, targets[op]), ok, `${op} × ${st}`);
      assert.strictEqual(R.opAllowed(op, { isPm: true, isReadonly: true }, { status: 'active' }, targets[op]), false, `${op}：只读账号即使是 PM 也否决`);
      assert.strictEqual(R.opAllowed(op, { isPm: false, isReadonly: false, isMember: true }, { status: 'active' }, targets[op]), false, `${op}：非 PM 成员否`);
    }
    const dec = { isRequired: true, currentRevisionId: 7, revisionStatus: 'pending', objectVersionId: 9, objectPending: true, qualificationLoss: null };
    for (const [st, ok] of Object.entries(rowAllowed)) assert.strictEqual(R.opAllowed('confirm_decide', {}, { status: st }, dec), ok, `confirm_decide × ${st}`);
    assert.strictEqual(R.opAllowed('confirm_decide', { isReadonly: true }, { status: 'active' }, dec), true, '§5.1：只读账号可以作出本人的确认类动作');
    assert.strictEqual(R.opAllowed('confirm_decide', {}, { status: 'active' }, Object.assign({}, dec, { isRequired: false })), false, '不是必需确认人');
    const code = (t) => R.checkOp('confirm_decide', {}, { status: 'active' }, Object.assign({}, dec, t));
    assert.deepStrictEqual([code({ revisionIdGiven: 8 }).status, code({ revisionIdGiven: 8 }).code], [409, 'SYSBUILD_TASK_SUPERSEDED']);
    assert.deepStrictEqual([code({ objectVersionIdGiven: 10 }).status, code({ objectVersionIdGiven: 10 }).code], [409, 'SYSBUILD_VERSION_CHANGED']);
    assert.deepStrictEqual([code({ revisionStatus: 'confirmed' }).status, code({ revisionStatus: 'confirmed' }).code], [409, 'SYSBUILD_STATE']);
    assert.deepStrictEqual([code({ objectPending: false }).status, code({ objectPending: false }).code], [409, 'SYSBUILD_VERSION_CHANGED']);
    assert.deepStrictEqual([code({ qualificationLoss: '失去资格' }).status, code({ qualificationLoss: '失去资格' }).code, code({ qualificationLoss: '失去资格' }).message], [409, 'SYSBUILD_STATE', '失去资格']);
    assert.strictEqual(code({ revisionIdGiven: 7, objectVersionIdGiven: 9 }), null, '请求带的编号与现状一致时放行');
    // C6 补格（confirm_reissue 规则矩阵；本用例的 code 助手专给 confirm_decide，不可复用）：对象已不是待确认、修订已处理时 409 SYSBUILD_STATE（rules.js 的 objectStatus / revisionStatus 检查）；对象类型清单外 409
    const rcEff = R.checkOp('confirm_reissue', pm, { status: 'active' }, Object.assign({}, targets.confirm_reissue, { objectStatus: 'effective' }));
    assert.deepStrictEqual([rcEff.status, rcEff.code], [409, 'SYSBUILD_STATE'], '对象已不是待确认');
    const rcDone = R.checkOp('confirm_reissue', pm, { status: 'active' }, Object.assign({}, targets.confirm_reissue, { revisionStatus: 'confirmed' }));
    assert.deepStrictEqual([rcDone.status, rcDone.code], [409, 'SYSBUILD_STATE'], '修订已处理（confirmed）');
    const rcBogus = R.checkOp('confirm_reissue', pm, { status: 'active' }, Object.assign({}, targets.confirm_reissue, { objectType: 'bogus' }));
    assert.deepStrictEqual([rcBogus.status, rcBogus.code], [409, 'SYSBUILD_STATE'], '类型清单里没有的对象类型一律 409');
    // 提交只对草稿；撤回只对待确认
    for (const vs of ['pending', 'effective', 'superseded']) {
      assert.strictEqual(R.opAllowed('package_version_submit', pm, { status: 'active' }, Object.assign({ versionStatus: vs, packageType: 'overall' }, F)), false, `提交 × 版本 ${vs}`);
    }
    for (const vs of ['draft', 'effective', 'superseded']) {
      assert.strictEqual(R.opAllowed('package_version_withdraw', pm, { status: 'active' }, { versionStatus: vs }), false, `撤回 × 版本 ${vs}`);
    }
    // 提交类型：开放 overall / initiation / change（变更另要变更事实）/ batch_accept（C6a，批次须进行中）/ closing（C6a，须每个有效批次已正式上线）；batch_req（第一期不建）不开放
    for (const [type, extra, ok] of [
      ['overall', {}, true], ['initiation', {}, true], ['closing', { closingNotReady: null }, true], ['closing', {}, false], ['batch_accept', { batchStatus: 'active' }, true], ['batch_accept', {}, false],
      ['batch_req', {}, false], ['change', {}, false],
    ]) {
      assert.strictEqual(R.opAllowed('package_version_submit', pm, { status: 'active' }, Object.assign({ versionStatus: 'draft', packageType: type }, F, extra)), ok, `提交类型 ${type} ${JSON.stringify(extra)}`);
    }
    // 提交的项目级前置（修订批二 MED-1，手写文案）：确认人齐全 → 立项前置，两类前置都在 rules 里判，标志与执行同一个文案；缺失按 fail-closed 拒绝
    const subT = (extra) => Object.assign({ versionStatus: 'draft', packageType: 'overall', batchStatus: undefined }, F, extra);
    const subV = (extra) => R.checkOp('package_version_submit', pm, { status: 'active' }, subT(extra));
    const NOPARTY = '项目还没有需求部门参与方，无法确定必需确认人';
    assert.deepStrictEqual([subV({ confirmersMissing: { noParty: true, missing: [] } }).status, subV({ confirmersMissing: { noParty: true, missing: [] } }).code, subV({ confirmersMissing: { noParty: true, missing: [] } }).message], [409, 'SYSBUILD_STATE', NOPARTY]);
    assert.strictEqual(subV({ confirmersMissing: { noParty: false, missing: ['甲部（缺现任领导）', '乙部（缺生效负责人）'] } }).message, '以下参与方缺少必需确认人：甲部（缺现任领导）、乙部（缺生效负责人）');
    assert.strictEqual(subV({ initiationEffective: false }).message, '项目立项包还没有生效版本，总体规划不能提交确认（立项通过后才能确认需求与范围）');
    assert.strictEqual(subV({ confirmersMissing: { noParty: true, missing: [] }, initiationEffective: false }).message, NOPARTY, '两类前置都不满足时先报确认人');
    assert.strictEqual(R.opAllowed('package_version_submit', pm, { status: 'active' }, subT({ initiationEffective: false, packageType: 'initiation' })), true, '立项包自己的提交不受立项前置约束');
    assert.strictEqual(R.opAllowed('package_version_submit', pm, { status: 'active' }, subT({ confirmersMissing: { noParty: false, missing: ['丙部（缺现任领导）'] }, packageType: 'initiation' })), false, '立项包同样要求确认人齐全');
    assert.strictEqual(R.opAllowed('package_version_submit', pm, { status: 'active' }, { versionStatus: 'draft', packageType: 'overall', historyConflict: null, otherPendingPackage: null }), false, '事实没取到（confirmersMissing 缺失）：fail-closed（historyConflict / otherPendingPackage 补 null：只让 confirmersMissing 一项缺失，不被历史互斥与待确认互斥的 fail-closed 遮蔽）');
    const unknownInitiation = subV({ initiationEffective: undefined });
    assert.deepStrictEqual([unknownInitiation?.status, unknownInitiation?.code, unknownInitiation?.message], [
      409, 'SYSBUILD_STATE', '项目立项包还没有生效版本，总体规划不能提交确认（立项通过后才能确认需求与范围）',
    ], '其他提交事实齐全时，未知的立项事实仍须拒绝');
    // 计划齐全（修订批三 H-1 / P43，手写文案）：排在确认人、立项前置之后；undefined = 事实没取到 fail-closed；只对总体规划包判
    const planMessage = '以下阶段还没有有效的计划起止日期：验收阶段（第 1 批）、结项';
    const pmiss = subV({ planMissing: planMessage });
    assert.deepStrictEqual([pmiss.status, pmiss.code, pmiss.message], [409, 'SYSBUILD_STATE', planMessage]);
    assert.strictEqual(subV({ planMissing: undefined }).message, '无法确定节点计划是否齐全，请刷新后重试', '计划事实没取到：fail-closed');
    assert.strictEqual(R.opAllowed('package_version_submit', pm, { status: 'active' }, { versionStatus: 'draft', packageType: 'overall', confirmersMissing: null, initiationEffective: true, historyConflict: null, otherPendingPackage: null }), false, '总体规划包：计划事实没取到 fail-closed');
    assert.strictEqual(subV({ planMissing: ['x'], initiationEffective: false }).message, '项目立项包还没有生效版本，总体规划不能提交确认（立项通过后才能确认需求与范围）', '立项前置先于计划齐全');
    assert.strictEqual(subV({ planMissing: ['x'], confirmersMissing: { noParty: true, missing: [] } }).message, NOPARTY, '确认人先于计划齐全');
    assert.strictEqual(R.opAllowed('package_version_submit', pm, { status: 'active' }, subT({ packageType: 'initiation', planMissing: ['x'] })), true, '立项包不要求计划齐全');
    assert.deepStrictEqual(R.SUBMITTABLE_PACKAGE_TYPES.slice(), ['overall', 'initiation', 'batch_accept', 'closing'], '提交开放的包类型清单（P35 的待确认包判定读同一份；C5 起变更包已移出；C6a 加入批次验收包与结项包）');
    // 改发：只对包版本任务；只在包版本待确认、当前修订 pending / objected / rejected 时可用
    // 邀请 / 授权类任务没有改发（#212 C7：条目版本任务随需求条目流程删除，不再是可改发的对象类型）
    for (const ot of ['invitation', 'delegation', 'conclusion', 'item_version', 'bogus']) {
      assert.strictEqual(R.opAllowed('confirm_reissue', pm, { status: 'active' }, Object.assign({}, targets.confirm_reissue, { objectType: ot })), false, `改发 × 对象类型 ${ot}`);
    }
    // C6：开发方关键事项认可任务（dev_entry）随 R6 删除，改发类型清单去 dev_entry（rules.js 类型清单只剩 package_version），原「放开」断言改为拒绝
    assert.strictEqual(R.opAllowed('confirm_reissue', pm, { status: 'active' }, Object.assign({}, targets.confirm_reissue, { objectType: 'dev_entry' })), false, 'C6：开发方关键事项任务不可改发');
    // 已失效（项目终止时待确认修订被置为已失效，P38）可改发——重开后由 PM 改发；已确认 / 已替代不可
    for (const [rs, ok] of [['pending', true], ['objected', true], ['rejected', true], ['invalid', true], ['confirmed', false], ['superseded', false]]) {
      assert.strictEqual(R.opAllowed('confirm_reissue', pm, { status: 'active' }, Object.assign({}, targets.confirm_reissue, { revisionStatus: rs })), ok, `改发 × 当前修订 ${rs}`);
    }
    assert.strictEqual(R.opAllowed('confirm_reissue', pm, { status: 'active' }, Object.assign({}, targets.confirm_reissue, { objectStatus: 'superseded' })), false, '包版本已不是待确认');
    // 改发解析被挡（L3①：没有可作为确认人的负责人 / 代表人，或 P36 同一人两种身份）：标志为假，执行 409 带原文
    const blocked = R.checkOp('confirm_reissue', pm, { status: 'active' }, Object.assign({}, targets.confirm_reissue, { reissueBlocked: '没有现任负责人' }));
    assert.deepStrictEqual([blocked.status, blocked.code, blocked.message], [409, 'SYSBUILD_STATE', '没有现任负责人']);
    assert.strictEqual(R.opAllowed('confirm_reissue', pm, { status: 'active' }, Object.assign({}, targets.confirm_reissue, { reissueBlocked: null })), true);
  });

  test('C4a rules（修订批）：总体规划待确认期间 node_cancel / schedule_plan 一律 409（P34）；待确认内容包期间不能新建需求部门参与方、开发方不受影响（P35）', async () => {
    const R = T.getMods().rules;
    const pm = { isPm: true, isReadonly: false };
    const active = { status: 'active' };
    const node = { nodeStatus: 'not_started', templateKey: 'b_dev', isMilestone: false, isProjectLayer: false, batchStatus: 'planning', hasBaseline: false, corrects: null, devStartReady: 'ok' }; // L2 §10：不测开始门的正向规则夹具显式满足新门。
    const projNode = Object.assign({}, node, { isProjectLayer: true, templateKey: 'p_overall' });
    const MSG = '总体规划待确认中，排期已随包冻结；如需修改请撤回提交';
    for (const [op, tgt] of [['node_cancel', node], ['schedule_plan', node], ['schedule_plan', projNode]]) {
      assert.strictEqual(R.opAllowed(op, pm, active, Object.assign({}, tgt, { overallPending: false })), true, `${op} 非待确认放行`);
      assert.strictEqual(R.opAllowed(op, pm, active, tgt), true, `${op} 缺省 overallPending 视为否`);
      const v = R.checkOp(op, pm, active, Object.assign({}, tgt, { overallPending: true }));
      assert.deepStrictEqual([v.status, v.code, v.message], [409, 'SYSBUILD_STATE', MSG], `${op} 待确认期间`);
    }
    // 只有这两个动作读 overallPending：新增节点 / 改名 / 开始 / 收口不受影响
    for (const op of ['node_add', 'node_rename', 'node_start', 'node_reorder', 'batch_update']) {
      const tgt = op === 'node_add' || op === 'node_reorder' || op === 'batch_update' ? { batchStatus: 'planning', overallPending: true } : Object.assign({}, node, { overallPending: true });
      assert.strictEqual(R.opAllowed(op, pm, active, tgt), true, `${op} 不受总体规划待确认影响`);
    }
    // 已取消节点优先给「已取消」的原因（相邻规则不遮蔽：overallPending 为真时已取消仍报已取消）
    const cancelled = R.checkOp('schedule_plan', pm, active, Object.assign({}, node, { nodeStatus: 'cancelled', overallPending: true }));
    assert.ok(cancelled.message.includes('已取消'), `实际 ${cancelled.message}`);
    // P35
    const adm = { isAdmin: true, isReadonly: false };
    for (const who of [pm, { ...adm, isPm: true }]) {
      assert.strictEqual(R.opAllowed('party_add', who, active, { side: 'demand', hasDevParty: false, hasPendingContentPackage: false }), true);
      const v = R.checkOp('party_add', who, active, { side: 'demand', hasDevParty: false, hasPendingContentPackage: true });
      assert.ok(v && v.status === 409 && v.code === 'SYSBUILD_STATE' && v.message === '有待确认的内容包，请先撤回提交', `实际 ${JSON.stringify(v)}`);
      assert.strictEqual(R.opAllowed('party_add', who, active, { side: 'dev', hasDevParty: false, hasPendingContentPackage: true }), true, '开发方不受待确认内容包影响');
    }
    assert.strictEqual(R.checkOp('party_add', adm, active, { side: 'dev', hasDevParty: false }).status, 403);
  });

  // ── 提交 ───────────────────────────────────────────────────────────────────────────────────────
  test('C4a 提交：总体规划包成功——两个需求部门各一位负责人，核任务、冻结清单、事件、不可回写的快照及生效时机', async () => {
    const pid = await newProject();
    const A = await seedParty(pid, '甲部', U.own, U.del);
    const B = await seedParty(pid, '乙部', U.x1, U.x2);
    await seedEffectiveInitiation(pid); // P37 前置（夹具）
    const pk = await mkPackage(pid, 'overall');
    const pv = await mkVersion(pk);
    // 夹具：包版本自己的附件（C4a 没有绑定它的端点，直接写绑定行），提交时要进冻结清单（#212 C7：需求条目没有了，冻结清单只剩包版本这一路）
    const a1 = await stageAtt(pid, U.pm, 'a');
    const a3 = await stageAtt(pid, U.pm, 'e');
    await sqlRun("INSERT INTO sysbuild_attachment_bindings (attachment_id, owner_type, owner_id, bound_by) VALUES (?, 'package_version', ?, ?)", [a1, pv, U.pm]);
    await sqlRun("INSERT INTO sysbuild_attachment_bindings (attachment_id, owner_type, owner_id, bound_by) VALUES (?, 'package_version', ?, ?)", [a3, pv, U.pm]);
    const deleted = await stageAtt(pid, U.pm, 'f');
    await sqlRun("INSERT INTO sysbuild_attachment_bindings (attachment_id, owner_type, owner_id, bound_by) VALUES (?, 'package_version', ?, ?)", [deleted, pv, U.pm]);
    await sqlRun("UPDATE sysbuild_attachments SET deleted_at = '2026-11-01 10:00:00', deleted_by = ? WHERE id = ?", [U.pm, deleted]);
    const before = (await rowOf('sysbuild_package_versions', pv)).snapshot_json;
    assert.strictEqual(await planAllNodes(pid), 5, 'H-1：自研项目 5 个节点（项目层 3 + 默认批次 2）补齐计划后才能提交');
    const r = await submit(U.pm, pv);
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body.version, { id: pv, package_id: pk, version_no: 1, status: 'pending' });
    const row = await rowOf('sysbuild_package_versions', pv);
    assert.deepStrictEqual([row.status, row.effective_at, row.snapshot_json], ['pending', null, before]);
    // 范围确认每个需求部门仅有一条任务，均以负责人的授权为依据。
    const tasks = await tasksOf(pv);
    assert.strictEqual(tasks.length, 2);
    assert.deepStrictEqual(tasks.map((t) => [t.party_id, t.user_id, t.basis_appointment_id, t.basis_delegation_id]), [
      [A.party, U.del, null, A.dlg], [B.party, U.x2, null, B.dlg],
    ]);
    assert.deepStrictEqual(tasks.map((t) => [t.rev_no, t.status, t.purpose, t.object_id, t.object_version_id]), [1, 2].map(() => [1, 'pending', 'package_confirm', pk, pv]));
    assert.deepStrictEqual(r.body.tasks.map((t) => [t.task_id, t.party_id, t.kind, t.required_member_id]), [
      [tasks[0].task_id, A.party, 'delegate', A.mDel], [tasks[1].task_id, B.party, 'delegate', B.mDel],
    ]);
    // 冻结清单：包版本绑定的 a1、a3
    const basis = JSON.parse(before).material_version_ids[0];
    const proof = await sqlGet("SELECT attachment_id FROM sysbuild_attachment_bindings WHERE owner_type = 'material_version' AND owner_id = ?", [basis]);
    const expectFrozen = [{ attachment_id: proof.attachment_id, sha256: 'e'.repeat(64) }, { attachment_id: a1, sha256: 'a'.repeat(64) }, { attachment_id: a3, sha256: 'e'.repeat(64) }];
    assert.deepStrictEqual(await frozenOf('package_version', pv), expectFrozen);
    assert.deepStrictEqual(r.body.frozen_attachments, expectFrozen);
    // 事件（payload 不含附件原文件名，Q8）
    assert.deepStrictEqual(await payloads(pid, 'package_version_submitted'), [{
      package_id: pk, type: 'overall', version_no: 1, form: 'overall_batch_req', task_ids: tasks.map((t) => t.task_id), frozen_attachment_ids: [proof.attachment_id, a1, a3],
      node_plans: await inhouseNodePlans(pid), // P34 + H-2：提交时各未取消节点的当前计划与名称 / 层 / 批次 / 模板快照（手写期望）；form / parent 没变化，所以没有 form_from 等键
    }]);
    const created = await payloads(pid, 'confirm_task_created');
    assert.strictEqual(created.length, 2);
    assert.deepStrictEqual(created[0], {
      revision_id: tasks[0].rev_id, rev_no: 1, object_type: 'package_version', object_id: pk, object_version_id: pv, purpose: 'package_confirm', party_id: A.party,
      required_member_id: A.mDel, basis_appointment_id: null, basis_delegation_id: A.dlg,
    });
    assert.strictEqual((await payloads(pid, 'attachment_frozen')).filter((event) => event.object_type === 'package_version').length, 3);
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_events WHERE project_id = ? AND object_type = 'attachment' AND object_id = ? AND event_type = 'attachment_frozen'", [pid, deleted]), 0, '软删除的包附件不写冻结事件');
    assert.ok(!(await sqlAll('SELECT payload_json FROM sysbuild_events WHERE project_id = ?', [pid])).some((e) => String(e.payload_json).includes('确认证据')), '事件不含附件原文件名');
    // snapshot 此后不可改（版本已不是草稿）
    expectErr(await api(U.pm, 'PATCH', `/sysbuild/package-versions/${pv}`, { snapshot_json: { x: 1 } }), 409, 'SYSBUILD_STATE', '待确认版本不可改 snapshot');
    // 读接口：版本详情的 actions 随状态变化
    assert.deepStrictEqual((await get(U.pm, `/sysbuild/package-versions/${pv}`)).body.actions, { edit: false, new_version: false, submit: false, withdraw: true, export_sheet: true }); // C4c：待确认版本可导出需求确认单
    // 任务清单读接口
    const list = await get(U.pm, `/sysbuild/package-versions/${pv}/confirm-tasks`);
    assert.strictEqual(list.status, 200, list.text);
    assert.deepStrictEqual(list.body.tasks.map((t) => [t.task_id, t.party_id, t.purpose, t.current_revision.rev_no, t.current_revision.status, t.current_revision.required_member_id]), [
      [tasks[0].task_id, A.party, 'package_confirm', 1, 'pending', A.mDel], [tasks[1].task_id, B.party, 'package_confirm', 1, 'pending', B.mDel],
    ]);
    expectErr(await get(U.out, `/sysbuild/package-versions/${pv}/confirm-tasks`), 404, 'SYSBUILD_NOT_FOUND', '非成员看任务清单');
    assert.strictEqual((await openTask(U.own, tasks[0].task_id)).body.actions.decide, false, '领导本人没有本次决策权');
    assert.strictEqual((await openAndDecide(U.del, tasks[0].task_id, 'confirm')).body.effective, false, '仅一个部门确认不生效');
    assert.strictEqual((await openAndDecide(U.x2, tasks[1].task_id, 'confirm')).body.effective, true, '全部部门确认后生效');
  });

  test('C4a 提交：立项包成功——只要各需求部门负责人（不要代表人），冻结清单为空', async () => {
    const pid = await newProject();
    const A = await seedParty(pid, '甲部', U.own, U.del);
    const B = await seedParty(pid, '乙部', U.x1, null);
    const pk = await mkPackage(pid, 'initiation');
    const pv = await mkVersion(pk);
    await declareInitiationBasis(pv);
    const r = await submit(U.pm, pv);
    assert.strictEqual(r.status, 200, r.text);
    const tasks = await tasksOf(pv);
    assert.deepStrictEqual(tasks.map((t) => [t.party_id, t.user_id, t.basis_appointment_id, t.basis_delegation_id]), [[A.party, U.own, A.apt, null], [B.party, U.x1, B.apt, null]], '甲部的代表人 del 不是立项包的必需确认人');
    assert.deepStrictEqual(r.body.frozen_attachments, []);
    assert.deepStrictEqual(await frozenOf('package_version', pv), []);
    assert.strictEqual(await verStatus(pv), 'pending');
    const ev = await payloads(pid, 'package_version_submitted');
    const stated = (await eventsOf(pid, 'material_not_applicable'))[0];
    assert.deepStrictEqual(ev, [{ package_id: pk, type: 'initiation', version_no: 1, form: null, task_ids: tasks.map((t) => t.task_id), frozen_attachment_ids: [], initiation_basis_event_id: stated.id }]);
  });

  test('C4a 提交：失败分支（每条换一个不会先被别的规则拦下的输入）——非草稿 / 类型不开放 / 缺负责人 / 缺代表人 / 无需求部门（#212 C7：条目集合与承诺批次的重核随需求条目流程删除）', async () => {
    // 非草稿：提交过一次后再提交
    const d1 = await mkDraft();
    assert.strictEqual((await submit(U.pm, d1.pv)).status, 200);
    const again = await submit(U.pm, d1.pv);
    expectErr(again, 409, 'SYSBUILD_STATE', '非草稿');
    assert.ok(again.body.message.includes('只有草稿版本'), `非草稿提示实际 ${again.body.message}`);
    assert.strictEqual((await tasksOf(d1.pv)).length, 1, '被拒绝的重复提交不再生成任务');
    // C6a：结项包 / 批次验收包已开放提交，各有自己的提交前置（批次验收包：批次须进行中；结项包：每个有效批次须已正式上线）；原「类型不开放」的 409 改为这两条前置
    //   （「该类型的内容包 C5 / C6 起可用」只剩批次需求包能触发，第一期不建批次需求包，由 rules 用例的类型矩阵覆盖）。成功路径与互斥见 sysbuild-api-suite-golive.js。
    const pidT = await newProject();
    await seedParty(pidT, '甲部', U.own, U.del);
    for (const [type, batchId, expectMsg] of [['closing', null, '不能提交结项：以下批次还没有正式上线：第 1 批'], ['batch_accept', await defaultBatchId(pidT), '批次还没有进入进行中，不能提交批次验收']]) {
      const pv = await mkVersion(await mkPackage(pidT, type, batchId));
      const r = await submit(U.pm, pv);
      expectErr(r, 409, 'SYSBUILD_STATE', `类型 ${type} 的提交前置`);
      assert.ok(r.body.message.includes(expectMsg), `${type} 提示实际 ${r.body.message}`);
      assert.strictEqual(await verStatus(pv), 'draft');
    }
    // 缺生效负责人：丙部有成员但没有负责人的现行授权（另有甲部齐全）
    const d3 = await mkDraft();
    const party3 = await addParty(d3.pid, '丙部', 'demand');
    await addMember(d3.pid, U.x1, { party: party3 });
    const r3 = await submit(U.pm, d3.pv);
    expectErr(r3, 409, 'SYSBUILD_STATE', '缺负责人');
    assert.ok(r3.body.message.includes('丙部（缺生效负责人）'), `缺负责人提示实际 ${r3.body.message}`);
    assert.strictEqual(await verStatus(d3.pv), 'draft');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE project_id = ? AND object_type = 'package_version'", [d3.pid]), 0, '被拒绝的提交不生成任务（立项包是夹具，本来就没有任务）');
    // 缺生效负责人：总体规划包要代表人，同项目的立项包只要负责人
    const d4 = await mkDraft({ noDelegate: true });
    const r4 = await submit(U.pm, d4.pv);
    expectErr(r4, 409, 'SYSBUILD_STATE', '缺代表人');
    assert.ok(r4.body.message.includes('甲部（缺生效负责人）'), `缺代表人提示实际 ${r4.body.message}`);
    const ini = await mkVersion(d4.ini.pk); // 立项包已存在（夹具生效版本），再出一个草稿版本
    await declareInitiationBasis(ini);
    const iniSubmission = await submit(U.pm, ini);
    assert.strictEqual(iniSubmission.status, 200, '同一项目的立项包不需要代表人');
    assert.deepStrictEqual(iniSubmission.body.tasks.map((t) => t.kind), ['owner']);
    assert.ok(iniSubmission.body.tasks.every((t) => !hasOwn(t, 'proxy_only')));
    // 项目没有需求部门参与方
    const d5 = await mkDraft({ noParty: true });
    const r5 = await submit(U.pm, d5.pv);
    expectErr(r5, 409, 'SYSBUILD_STATE', '无需求部门');
    assert.ok(r5.body.message.includes('需求部门参与方'), `无需求部门提示实际 ${r5.body.message}`);
    // 以上失败的版本全部仍是草稿
    for (const d of [d3, d4, d5]) assert.strictEqual(await verStatus(d.pv), 'draft');

  });

  test('C4a 提交 P32：form 与 parent_overall_version_id 提交时按现状重算，与草稿存的值不同则在草稿条件下回写（不再 409），变化记进提交事件；没变化时事件不带这些键；非草稿版本回写被拒', async () => {
    // 结构仍接受旧形态的夹具，提交时回写为现行合并形态。
    const dForm = await mkDraft();
    const second = (await sqlRun("INSERT INTO sysbuild_batches (project_id, seq, name, is_default, status) VALUES (?, 2, '夹具第二批', 0, 'planning')", [dForm.pid])).lastID;
    const extra = await post(U.pm, '/sysbuild/batches/' + second + '/nodes', { name: '第二批校验阶段' });
    assert.strictEqual(extra.status, 201, extra.text);
    const extraNode = extra.body.node.id;
    await sqlRun("UPDATE sysbuild_package_versions SET form = 'overall' WHERE id = ?", [dForm.pv]);
    const before = await submit(U.pm, dForm.pv);
    expectErr(before, 409, 'SYSBUILD_STATE');
    assert.strictEqual(before.body.message, '范围确认要求恰有一个有效批次，请核对项目批次');
    assert.strictEqual(await verStatus(dForm.pv), 'draft');
    assert.strictEqual((await payloads(dForm.pid, 'package_version_submitted')).length, 0);
    await sqlRun('DELETE FROM sysbuild_nodes WHERE id = ?', [extraNode]);
    await sqlRun('DELETE FROM sysbuild_batches WHERE id = ?', [second]);
    const r1 = await submit(U.pm, dForm.pv);
    assert.strictEqual(r1.status, 200, r1.text);
    const row1 = await rowOf('sysbuild_package_versions', dForm.pv);
    assert.deepStrictEqual([row1.status, row1.form, row1.parent_overall_version_id], ['pending', 'overall_batch_req', null], 'form 回写为重算的新值');
    const ev1 = (await payloads(dForm.pid, 'package_version_submitted'))[0];
    assert.deepStrictEqual([ev1.form, ev1.form_from, ev1.form_to, hasOwn(ev1, 'parent_from'), hasOwn(ev1, 'parent_to')], ['overall_batch_req', 'overall', 'overall_batch_req', false, false], '事件记 form 的变化（form 字段取回写后的值），没变的 parent 不记');
    assert.ok(!ev1.node_plans.some((p) => p.node_id === extraNode));
    // 存的 parent 与现状不同（夹具：总体规划包版本的 parent 应为空）→ 回写为空，事件记 parent_from / parent_to
    const dParent = await mkDraft();
    await sqlRun('UPDATE sysbuild_package_versions SET parent_overall_version_id = 999999 WHERE id = ?', [dParent.pv]);
    const r2 = await submit(U.pm, dParent.pv);
    assert.strictEqual(r2.status, 200, r2.text);
    const row2 = await rowOf('sysbuild_package_versions', dParent.pv);
    assert.deepStrictEqual([row2.status, row2.form, row2.parent_overall_version_id], ['pending', 'overall_batch_req', null]);
    const ev2 = (await payloads(dParent.pid, 'package_version_submitted'))[0];
    assert.deepStrictEqual([ev2.parent_from, ev2.parent_to, hasOwn(ev2, 'form_from'), hasOwn(ev2, 'form_to')], [999999, null, false, false]);
    // 与现状一致：事件不带 form_* / parent_*（总体规划包提交成功用例已核整份 payload）
    const dSame = await mkDraft();
    assert.strictEqual((await submit(U.pm, dSame.pv)).status, 200);
    const ev3 = (await payloads(dSame.pid, 'package_version_submitted'))[0];
    assert.deepStrictEqual(['form_from', 'form_to', 'parent_from', 'parent_to'].filter((k) => hasOwn(ev3, k)), []);
    // 立项包的 form 必须为空：草稿里存了 overall → 提交时回写为空，事件记 form_from
    const pid = await newProject();
    await seedParty(pid, '甲部', U.own, null);
    const ini = await mkVersion(await mkPackage(pid, 'initiation'));
    await declareInitiationBasis(ini);
    await sqlRun("UPDATE sysbuild_package_versions SET form = 'overall' WHERE id = ?", [ini]);
    assert.strictEqual((await submit(U.pm, ini)).status, 200);
    assert.strictEqual((await rowOf('sysbuild_package_versions', ini)).form, null);
    const ev4 = (await payloads(pid, 'package_version_submitted'))[0];
    assert.deepStrictEqual([ev4.form, ev4.form_from, ev4.form_to], [null, 'overall', null]);
    // 非草稿版本（已提交）：夹具篡改 form 后再提交 409，form 保持被篡改的值（回写只在草稿条件下发生，也不会因再提交被改写）
    await sqlRun("UPDATE sysbuild_package_versions SET form = 'overall' WHERE id = ?", [dSame.pv]);
    expectErr(await submit(U.pm, dSame.pv), 409, 'SYSBUILD_STATE', '待确认版本再提交');
    assert.strictEqual((await rowOf('sysbuild_package_versions', dSame.pv)).form, 'overall', '被拒绝的再提交不回写 form');
  });

  test('C4a 提交 P37：总体规划包提交前须本项目立项包已有生效版本——没有立项包 / 立项包只有草稿 / 待确认 409；生效后通过；立项包出新版本待确认期间旧生效版本仍算（提交通过）', async () => {
    await seedEffectiveInitiation(await newProject()); // 兄弟项目有生效的立项包：本项目的判定不得取到它（过滤模式下用例单独运行，库里没有别的数据）
    const d = await mkDraft({ noInitiation: true });
    const none = await submit(U.pm, d.pv);
    expectErr(none, 409, 'SYSBUILD_STATE', '没有立项包');
    assert.ok(none.body.message.includes('立项包'), `提示实际 ${none.body.message}`);
    assert.strictEqual(await verStatus(d.pv), 'draft');
    // 立项包只有草稿版本
    const pkIni = await mkPackage(d.pid, 'initiation');
    const iniV1 = await mkVersion(pkIni);
    await declareInitiationBasis(iniV1);
    expectErr(await submit(U.pm, d.pv), 409, 'SYSBUILD_STATE', '立项包只有草稿');
    // 立项包待确认（已提交、未全部确认）
    assert.strictEqual((await submit(U.pm, iniV1)).status, 200);
    const pend = await submit(U.pm, d.pv);
    expectErr(pend, 409, 'SYSBUILD_STATE', '立项包待确认');
    assert.ok(pend.body.message.includes('立项包'), `提示实际 ${pend.body.message}`);
    // 立项包撤回后也不算
    assert.strictEqual((await withdraw(U.pm, iniV1, '先撤回')).status, 200);
    expectErr(await submit(U.pm, d.pv), 409, 'SYSBUILD_STATE', '立项包已撤回（被替代）');
    // 立项包生效后通过（新版本走完提交 + 确认）
    const iniV2 = await mkVersion(pkIni);
    assert.strictEqual((await submit(U.pm, iniV2)).status, 200);
    await confirmAll(iniV2);
    assert.strictEqual(await verStatus(iniV2), 'effective');
    // 立项包再出新版本并提交（待确认）：旧生效版本仍在，总体规划包可提交
    const iniV3 = await mkVersion(pkIni);
    assert.strictEqual((await submit(U.pm, iniV3)).status, 200);
    assert.deepStrictEqual([await verStatus(iniV2), await verStatus(iniV3)], ['effective', 'pending']);
    const ok = await submit(U.pm, d.pv);
    assert.strictEqual(ok.status, 200, ok.text);
    // 立项包的提交本身不受 P37 约束（它是前置）：本用例上面的立项包提交都成功
  });

  test('C4a 提交：权限与项目状态——一般成员 / 只读账号成员 / admin 未接管 403；非成员 404；版本不存在 404；多余键 400；已暂停可提交；已终止 409 SYSBUILD_PROJECT_READONLY', async () => {
    const d = await mkDraft();
    await addMember(d.pid, U.m1);
    await addMember(d.pid, U.ro);
    for (const [uid, label] of [[U.m1, '一般成员'], [U.ro, '只读账号成员'], [U.admin, 'admin 未接管'], [U.own, '负责人']]) expectErr(await submit(uid, d.pv), 403, 'SYSBUILD_FORBIDDEN', label);
    expectErr(await submit(U.out, d.pv), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    expectErr(await submit(U.pm, 99999999), 404, 'SYSBUILD_NOT_FOUND', '版本不存在');
    expectErr(await submit(U.pm, 'abc'), 400, 'SYSBUILD_INVALID_INPUT', '编号非法');
    expectErr(await post(U.pm, `/sysbuild/package-versions/${d.pv}/submit`, { x: 1 }), 400, 'SYSBUILD_INVALID_INPUT', '多余键');
    assert.strictEqual(await verStatus(d.pv), 'draft', '被拒绝的提交不改状态');
    assert.strictEqual((await setStatus(d.pid, 'terminated')).status, 200);
    expectErr(await submit(U.pm, d.pv), 409, 'SYSBUILD_PROJECT_READONLY', '已终止');
    assert.strictEqual((await setStatus(d.pid, 'active')).status, 200);
    assert.strictEqual((await setStatus(d.pid, 'paused')).status, 200);
    assert.strictEqual((await submit(U.pm, d.pv)).status, 200, '已暂停可提交');
  });

  // ── 撤回提交 ─────────────────────────────────────────────────────────────────────────────────────
  test('C4a 撤回：待确认 → 已被替代，本版本全部待确认修订 → 已失效（带原因），已确认的修订不动；撤回后可再建草稿（继承集合）；事件手写核对；权限与参数', async () => {
    const s = await mkSubmitted({ historicalLeaderTasks: true });
    await addMember(s.pid, U.m1);
    assert.strictEqual((await openAndDecide(U.own, s.T.aOwner.task_id, 'confirm')).status, 200); // 甲部负责人先确认，撤回后这条不得被改动
    expectErr(await withdraw(U.m1, s.pv, '要撤回'), 403, 'SYSBUILD_FORBIDDEN', '一般成员');
    expectErr(await withdraw(U.own, s.pv, '要撤回'), 403, 'SYSBUILD_FORBIDDEN', '负责人');
    expectErr(await withdraw(U.admin, s.pv, '要撤回'), 403, 'SYSBUILD_FORBIDDEN', 'admin 未接管');
    expectErr(await withdraw(U.out, s.pv, '要撤回'), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    expectErr(await withdraw(U.pm, 99999999, '要撤回'), 404, 'SYSBUILD_NOT_FOUND', '版本不存在');
    const noReason = await withdraw(U.pm, s.pv);
    expectErr(noReason, 400, 'SYSBUILD_INVALID_INPUT', '缺原因');
    assert.strictEqual(noReason.body.field, 'reason');
    expectErr(await withdraw(U.pm, s.pv, '   '), 400, 'SYSBUILD_INVALID_INPUT', '空白原因');
    expectErr(await post(U.pm, `/sysbuild/package-versions/${s.pv}/withdraw`, { reason: '要撤回', x: 1 }), 400, 'SYSBUILD_INVALID_INPUT', '多余键');
    assert.strictEqual(await verStatus(s.pv), 'pending', '被拒绝的撤回不改状态');
    const r = await withdraw(U.pm, s.pv, '条目范围需要调整');
    assert.strictEqual(r.status, 200, r.text);
    const pendingRevs = [s.T.aDel, s.T.bOwner, s.T.bDel].map((t) => t.rev_id).sort((a, b) => a - b);
    assert.deepStrictEqual(r.body, { version: { id: s.pv, package_id: s.pk, version_no: 1, status: 'superseded' }, invalidated_revision_ids: pendingRevs });
    const row = await rowOf('sysbuild_package_versions', s.pv);
    assert.deepStrictEqual([row.status, row.effective_at], ['superseded', null]);
    const own = await revOf(s.T.aOwner.rev_id);
    assert.deepStrictEqual([own.status, own.status_reason], ['confirmed', null], '已确认的修订不动');
    for (const rid of pendingRevs) {
      const rv = await revOf(rid);
      assert.deepStrictEqual([rv.status, rv.status_reason], ['invalid', '条目范围需要调整'], `修订 ${rid} 应失效并带原因`);
    }
    assert.deepStrictEqual(await payloads(s.pid, 'package_version_withdrawn'), [{ package_id: s.pk, version_no: 1, reason: '条目范围需要调整', invalidated_revision_ids: pendingRevs }]);
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE object_type = 'package_version' AND object_version_id = ?", [s.pv]), 4, '任务行保留');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_confirmations WHERE task_revision_id = ?', [s.T.aOwner.rev_id]), 1, '已有确认记录保留');
    // 撤回后：不能再撤回 / 再提交；失效修订的任务打开不写浏览记录、也不能决策；PM 可再建草稿（继承 snapshot）
    expectErr(await withdraw(U.pm, s.pv, '再撤一次'), 409, 'SYSBUILD_STATE', '已被替代的版本再撤回');
    expectErr(await submit(U.pm, s.pv), 409, 'SYSBUILD_STATE', '已被替代的版本再提交');
    const o = await openTask(U.x1, s.T.bOwner.task_id);
    assert.strictEqual(o.status, 200, o.text);
    assert.strictEqual(o.body.view_id, null, '失效修订不写浏览记录');
    expectErr(await decideRaw(U.x1, s.T.bOwner.task_id, decideBodyOf(o.body, 'confirm')), 409, 'SYSBUILD_STATE', '失效修订不能决策');
    const nv = await post(U.pm, `/sysbuild/packages/${s.pk}/versions`);
    assert.strictEqual(nv.status, 201, nv.text);
    assert.strictEqual(nv.body.version.version_no, 2);
    assert.ok(!hasOwn(nv.body, 'copied_items'), '建版本响应不再有 copied_items（#212 C7：条目集合没有了）');
  });

  test('C4a 撤回：草稿 / 已生效的版本不能撤回；已终止项目 409 SYSBUILD_PROJECT_READONLY；已暂停可撤回', async () => {
    const d = await mkDraft();
    const r = await withdraw(U.pm, d.pv, '草稿不能撤回');
    expectErr(r, 409, 'SYSBUILD_STATE', '草稿');
    assert.ok(r.body.message.includes('待确认'), `草稿撤回提示实际 ${r.body.message}`);
    const e = await mkSubmitted({ historicalLeaderTasks: true, single: true });
    await confirmAll(e.pv);
    assert.strictEqual(await verStatus(e.pv), 'effective');
    const re = await withdraw(U.pm, e.pv, '已生效不能撤回');
    expectErr(re, 409, 'SYSBUILD_STATE', '已生效');
    assert.ok(re.body.message.includes('已生效'), `已生效撤回提示实际 ${re.body.message}`);
    assert.strictEqual(await verStatus(e.pv), 'effective', '被拒绝的撤回不改状态');
    assert.strictEqual((await revOf(e.T.aOwner.rev_id)).status, 'confirmed');
    const t = await mkSubmitted({ historicalLeaderTasks: true, single: true });
    assert.strictEqual((await setStatus(t.pid, 'terminated')).status, 200);
    expectErr(await withdraw(U.pm, t.pv, '终止后撤回'), 409, 'SYSBUILD_PROJECT_READONLY', '已终止');
    assert.strictEqual((await setStatus(t.pid, 'active')).status, 200);
    assert.strictEqual((await setStatus(t.pid, 'paused')).status, 200);
    assert.strictEqual((await withdraw(U.pm, t.pv, '暂停期撤回')).status, 200, '已暂停可撤回');
  });

  // ── 浏览 ─────────────────────────────────────────────────────────────────────────────────────────
  test('C4a 浏览：必需确认人打开当前待确认修订写一条浏览记录（带当时的冻结清单），其他人打开不写；响应含对象内容 / 冻结清单 / 固定文案 / actions；遮蔽附件不返回原名', async () => {
    const s = await mkSubmitted({ historicalLeaderTasks: true });
    await addMember(s.pid, U.m1);
    await addMember(s.pid, U.ro);
    const tid = s.T.aOwner.task_id;
    const viewsOf = (uid) => sqlAll("SELECT * FROM sysbuild_views WHERE user_id = ? AND object_type = 'package_version' AND object_version_id = ? ORDER BY id", [uid, s.pv]);
    const o = await openTask(U.own, tid);
    assert.strictEqual(o.status, 200, o.text);
    const vs = await viewsOf(U.own);
    assert.strictEqual(vs.length, 1);
    const expectedFrozen = [{ attachment_id: s.att, sha256: 'a'.repeat(64) }, { attachment_id: s.basisAttachment, sha256: 'e'.repeat(64) }];
    const frozenJson = JSON.stringify(expectedFrozen);
    assert.deepStrictEqual([vs[0].object_type, vs[0].object_version_id, vs[0].source, vs[0].card_instance_id, vs[0].frozen_attachment_set], ['package_version', s.pv, 'page', null, frozenJson]);
    const b = o.body;
    assert.strictEqual(b.view_id, vs[0].id);
    assert.deepStrictEqual(b.task, { id: tid, project_id: s.pid, object_type: 'package_version', object_id: s.pk, object_version_id: s.pv, purpose: 'package_confirm', party_id: s.A.party, party_name: '甲部' });
    assert.deepStrictEqual([b.revision.id, b.revision.rev_no, b.revision.status, b.revision.status_reason, b.revision.required_member_id], [s.T.aOwner.rev_id, 1, 'pending', null, s.A.mOwn]);
    assert.strictEqual(b.revisions.length, 1);
    assert.deepStrictEqual(b.confirmations, []);
    assert.deepStrictEqual(b.object.package, { id: s.pk, type: 'overall', batch_id: null });
    assert.deepStrictEqual(b.object.version, { id: s.pv, version_no: 1, form: 'overall_batch_req', status: 'pending', effective_at: null, parent_overall_version_id: null });
    assert.ok(!hasOwn(b.object, 'items'), '对象视图不再有条目清单（#212 C7）');
    assert.deepStrictEqual(b.frozen_attachments, expectedFrozen.map((attachment) => ({ ...attachment, masked: false, name: attachment.attachment_id === s.att ? '确认证据.txt' : '配对确认材料.txt', size: 3, mime_type: 'text/plain', is_image: false, missing: false, masked_at: null, masked_by: null, masked_by_name: null, mask_reason: null, deleted: false, deleted_at: null, deleted_by: null, deleted_by_name: null })));
    assert.deepStrictEqual(b.checkbox_texts, CHECKBOXES, 'M-3：任务详情返回三种决策各自的固定文案');
    assert.ok(!hasOwn(b, 'checkbox_text'), '不再返回共用的单条文案');
    assert.deepStrictEqual(b.actions, { decide: true, decide_mode: 'self', reissue: false, export_sheet: true }); // C8：导出仍按只读范围开放。
    // 再打开一次再写一条
    assert.strictEqual((await openTask(U.own, tid)).status, 200);
    assert.strictEqual((await viewsOf(U.own)).length, 2);
    // 其他人打开：不写浏览记录，decide 标志为假（PM 的 reissue 为真）
    for (const [uid, label, reissueFlag] of [[U.pm, 'PM', true], [U.admin, 'admin', false], [U.m1, '一般成员', false], [U.ro, '只读账号成员', false], [U.x1, '乙部负责人（别人的任务）', false], [U.del, '同部代表人（别人的任务）', false]]) {
      const r = await openTask(uid, tid);
      assert.strictEqual(r.status, 200, `${label}: ${r.text}`);
      assert.strictEqual(r.body.view_id, null, `${label} 打开不写浏览记录`);
      assert.deepStrictEqual(r.body.actions, { decide: false, decide_mode: null, reissue: reissueFlag, export_sheet: true }, `${label} 的 actions`); // 读范围不因写动作不同而收窄。
      assert.strictEqual((await viewsOf(uid)).length, 0, `${label} 名下没有浏览记录`);
    }
    // 乙部负责人打开自己的任务：只写他自己的一条
    assert.strictEqual((await openTask(U.x1, s.T.bOwner.task_id)).status, 200);
    assert.strictEqual((await viewsOf(U.x1)).length, 1);
    assert.strictEqual((await viewsOf(U.own)).length, 2, '别人打开不增加我的浏览记录');
    expectErr(await openTask(U.out, tid), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    expectErr(await openTask(U.pm, 99999999), 404, 'SYSBUILD_NOT_FOUND', '任务不存在');
    expectErr(await openTask(U.pm, 'abc'), 400, 'SYSBUILD_INVALID_INPUT', '编号非法');
    // 已处理的修订：再打开不写浏览记录
    assert.strictEqual((await openAndDecide(U.own, tid, 'confirm')).status, 200);
    const nViews = (await viewsOf(U.own)).length;
    const after = await openTask(U.own, tid);
    assert.strictEqual(after.body.view_id, null);
    assert.strictEqual((await viewsOf(U.own)).length, nViews, '已确认的修订再打开不写浏览记录');
    assert.deepStrictEqual(after.body.actions, { decide: false, decide_mode: null, reissue: false, export_sheet: true });
    assert.strictEqual(after.body.confirmations.length, 1);
    // 附件遮蔽后不返回原名（Q8）
    await sqlRun("UPDATE sysbuild_attachments SET masked_at = '2026-10-30 10:00:00', masked_by = ?, mask_reason = '含敏感信息' WHERE id = ?", [U.pm, s.att]);
    const masked = await openTask(U.pm, tid);
    assert.deepStrictEqual([masked.body.frozen_attachments[0].masked, masked.body.frozen_attachments[0].name], [true, null]);
    assert.ok(!masked.text.includes('确认证据'), '响应体任何位置都不含原名');
    // #212 C2（清单 4.4 ⑤ 第 1 处）：遮蔽原因、遮蔽人、遮蔽时间与遮蔽人姓名（手写查询，期望不取自被测代码）
    const mv = masked.body.frozen_attachments[0];
    assert.deepStrictEqual([mv.mask_reason, mv.masked_by, mv.masked_at], ['含敏感信息', U.pm, '2026-10-30 10:00:00']);
    assert.strictEqual(mv.masked_by_name, (await sqlGet('SELECT COALESCE(display_name, username) AS n FROM users WHERE id = ?', [U.pm])).n);
  });

  // ── 决策 ─────────────────────────────────────────────────────────────────────────────────────────
  test('C4a 决策：成功路径三种结果——确认（可不写原因）/ 有异议 / 不认可：修订终态、确认记录各列、事件手写核对；有异议与不认可不算确认，版本仍待确认；响应与再读一致', async () => {
    const s = await mkSubmitted({ historicalLeaderTasks: true });
    const t = s.T;
    const o1 = await openTask(U.own, t.aOwner.task_id);
    const r1 = await decideRaw(U.own, t.aOwner.task_id, decideBodyOf(o1.body, 'confirm'));
    assert.strictEqual(r1.status, 200, r1.text);
    assert.deepStrictEqual(r1.body, {
      decision: 'confirm', revision: { id: t.aOwner.rev_id, status: 'confirmed' }, confirmation_id: r1.body.confirmation_id,
      effective: false, superseded_version_ids: [], baseline_node_ids: [], advanced_batch_ids: [], version: { id: s.pv, status: 'pending' },
    });
    const c1 = await rowOf('sysbuild_confirmations', r1.body.confirmation_id);
    assert.deepStrictEqual(c1, {
      id: c1.id, task_revision_id: t.aOwner.rev_id, object_type: 'package_version', object_version_id: s.pv, actor_user_id: U.own,
      method: 'platform', decision: 'confirm', checkbox_text: CHECKBOX, reason: null, view_id: o1.body.view_id, card_instance_id: null,
      dingtalk_user_id: null, created_at: c1.created_at,
    });
    const rv1 = await revOf(t.aOwner.rev_id);
    assert.strictEqual(rv1.status, 'confirmed');
    assert.deepStrictEqual((await payloads(s.pid, 'confirmation_recorded'))[0], {
      confirmation_id: c1.id, revision_id: t.aOwner.rev_id, object_type: 'package_version', object_version_id: s.pv, decision: 'confirm', method: 'platform', view_id: o1.body.view_id, reason: null,
    });
    // 确认也可以带原因
    const r2 = await openAndDecide(U.del, t.aDel.task_id, 'confirm', { reason: '同意' });
    assert.strictEqual(r2.status, 200, r2.text);
    assert.strictEqual((await rowOf('sysbuild_confirmations', r2.body.confirmation_id)).reason, '同意');
    // 有异议
    const r3 = await openAndDecide(U.x1, t.bOwner.task_id, 'object');
    assert.strictEqual(r3.status, 200, r3.text);
    assert.deepStrictEqual([r3.body.decision, r3.body.revision.status, r3.body.effective, r3.body.version.status], ['object', 'objected', false, 'pending']);
    const c3 = await rowOf('sysbuild_confirmations', r3.body.confirmation_id);
    assert.deepStrictEqual([c3.decision, c3.reason, c3.method, c3.actor_user_id], ['object', '内容有出入，需要说明', 'platform', U.x1]);
    assert.strictEqual(c3.checkbox_text, CHECKBOXES.object, 'M-3：确认记录保存实际提交的文案（有异议那一条，不含「确认无误」）');
    assert.strictEqual((await revOf(t.bOwner.rev_id)).status, 'objected');
    // 不认可
    const listX2 = async () => { const r = await get(U.x2, '/sysbuild/my/confirmations'); assert.strictEqual(r.status, 200, r.text); return r.body.items.filter((i) => i.project_id === s.pid).map((i) => i.task_id); }; // 191-M1
    assert.ok((await listX2()).includes(t.bDel.task_id), '前置：不认可前在待我确认里');
    const r4 = await openAndDecide(U.x2, t.bDel.task_id, 'reject', { reason: '范围不对' });
    assert.strictEqual(r4.status, 200, r4.text);
    assert.deepStrictEqual([r4.body.decision, r4.body.revision.status, r4.body.effective], ['reject', 'rejected', false]);
    assert.strictEqual((await revOf(t.bDel.rev_id)).status, 'rejected');
    // C6 补读（接替整删的 devkey.js:213 用例的 :254，附录 C devkey:213:254）：不认可后，同一必需确认人 x2 的待我确认里不再有这条任务（confirm.js 的待我确认只列待确认修订；本用例原只覆盖确认与有异议，不含不认可）
    assert.ok(!(await listX2()).includes(t.bDel.task_id), '不认可后不再出现在待我确认');
    assert.strictEqual((await rowOf('sysbuild_confirmations', r4.body.confirmation_id)).reason, '范围不对');
    const c4 = await rowOf('sysbuild_confirmations', r4.body.confirmation_id);
    assert.strictEqual(c4.checkbox_text, CHECKBOXES.reject, 'M-3：不认可的记录保存的是不认可那一条，不含「确认无误」');
    assert.ok(!c4.checkbox_text.includes('确认无误') && !c1.checkbox_text.includes('不认可'), '审计证据不自相矛盾');
    assert.strictEqual(await verStatus(s.pv), 'pending', '有异议 / 不认可不算确认，版本仍待确认');
    assert.strictEqual(await baselineCount(s.pid), 0, '未生效不形成基线');
    // 再读一致：任务详情的确认记录与修订
    const again = await openTask(U.pm, t.bOwner.task_id);
    assert.deepStrictEqual(again.body.confirmations.map((c) => [c.revision_id, c.decision, c.method, c.actor_user_id, c.reason]), [[t.bOwner.rev_id, 'object', 'platform', U.x1, '内容有出入，需要说明']]);
    assert.deepStrictEqual([again.body.revision.status, again.body.actions], ['objected', { decide: false, decide_mode: null, reissue: true, export_sheet: true }]);
    const rec = again.body.confirmations[0];
    assert.deepStrictEqual(Object.keys(rec).sort(), ['actor_name', 'actor_user_id', 'by_admin_proxy', 'created_at', 'decision', 'id', 'method', 'reason', 'revision_id'], '确认记录键集合全等（七个代录相关键随 C3 消失，W1 7；by_admin_proxy 是平台管理员代办标识，2026-11-27 加）');
    assert.strictEqual(rec.by_admin_proxy, false, '必需确认人本人的决定不标代办');
    assert.ok(again.body.revisions.some((r) => r.id === t.bOwner.rev_id), 'revisions[] 非空且含已知修订编号（codex 118 L：空数组时下面的 every 恒真）');
    assert.ok(!('proxy_only' in again.body.revision) && again.body.revisions.every((r) => !('proxy_only' in r)), 'revision / revisions[] 不再带 proxy_only（W1 5 / 6）');
  });

  test('C4a 决策：只读账号作为必需确认人可以确认（§5.1 只读否决不含本人确认类动作）；立项包单部门确认即生效', async () => {
    const pid = await newProject();
    const C = await seedParty(pid, '丙部', U.ro, null);
    const pk = await mkPackage(pid, 'initiation');
    const pv = await mkVersion(pk);
    await declareInitiationBasis(pv);
    assert.strictEqual((await submit(U.pm, pv)).status, 200);
    const [t] = await tasksOf(pv);
    assert.strictEqual(t.user_id, U.ro);
    const o = await openTask(U.ro, t.task_id);
    assert.deepStrictEqual([o.status, o.body.actions.decide], [200, true]);
    const r = await decideRaw(U.ro, t.task_id, decideBodyOf(o.body, 'confirm'));
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.body.effective, r.body.version], [true, { id: pv, status: 'effective' }]);
    assert.strictEqual(await verStatus(pv), 'effective');
    assert.ok(C.party > 0);
  });

  test('C4a 决策：403 / 404——PM、一般成员、只读账号成员、admin、同部代表人、别部负责人都不是该任务当前修订的必需确认人 403；非成员 404；任务不存在 404；编号非法 400', async () => {
    const s = await mkSubmitted({ historicalLeaderTasks: true });
    await addMember(s.pid, U.m1);
    await addMember(s.pid, U.ro);
    const tid = s.T.aOwner.task_id;
    const o = await openTask(U.own, tid); // 浏览证据齐备，403 不是因为没浏览
    const body = decideBodyOf(o.body, 'confirm');
    for (const [uid, label] of [[U.pm, 'PM'], [U.m1, '一般成员'], [U.ro, '只读账号成员'], [U.admin, 'admin'], [U.del, '同部代表人'], [U.x1, '乙部负责人']]) {
      expectErr(await decideRaw(uid, tid, body), 403, 'SYSBUILD_FORBIDDEN', label);
    }
    expectErr(await decideRaw(U.out, tid, body), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    expectErr(await decideRaw(U.own, 99999999, body), 404, 'SYSBUILD_NOT_FOUND', '任务不存在');
    expectErr(await decideRaw(U.own, 'abc', body), 400, 'SYSBUILD_INVALID_INPUT', '编号非法');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_confirmations WHERE task_revision_id = ?', [s.T.aOwner.rev_id]), 0, '被拒绝的决策不留确认记录');
    assert.strictEqual((await decideRaw(U.own, tid, body)).status, 200, '对照：必需确认人本人同样的请求通过');
  });

  test('C4a 决策：409 各分支（每条换一个不会先被别的规则拦下的输入）——未浏览 / 修订编号不符 / 版本编号不符 / 浏览早于修订 / 冻结清单变了 / 版本不再待确认 / 已终止 / 已暂停可决策 / 已处理不能再次决策', async () => {
    const s = await mkSubmitted({ historicalLeaderTasks: true });
    const tOwn = s.T.aOwner;
    const tDel = s.T.aDel;
    const tB = s.T.bOwner;
    const bodyFor = (t, extra) => Object.assign({ revision_id: t.rev_id, object_version_id: s.pv, decision: 'confirm', checkbox_text: CHECKBOX }, extra || {});
    const nConf = () => countOf("SELECT COUNT(*) AS n FROM sysbuild_confirmations WHERE object_type = 'package_version' AND object_version_id = ?", [s.pv]);
    // 乙部代表人先打开自己的任务：同一对象版本上有别人的浏览记录，不能顶替我的（浏览证据只认本人）
    assert.strictEqual((await openTask(U.x2, s.T.bDel.task_id)).status, 200);
    // 1 未浏览（其余输入全部合法）
    const nv = await decideRaw(U.own, tOwn.task_id, bodyFor(tOwn));
    expectErr(nv, 409, 'SYSBUILD_NOT_VIEWED', '未浏览');
    // 409 先于 decision 的 400：未浏览时 decision 非法也先得 409（派单 P27 的检查顺序）
    expectErr(await decideRaw(U.x1, tB.task_id, bodyFor(tB, { decision: 'maybe' })), 409, 'SYSBUILD_NOT_VIEWED', '未浏览 + decision 非法 → 先 409');
    assert.strictEqual(await nConf(), 0);
    // 2 打开后：修订编号 / 对象版本编号不符
    assert.strictEqual((await openTask(U.own, tOwn.task_id)).status, 200);
    expectErr(await decideRaw(U.own, tOwn.task_id, bodyFor(tOwn, { revision_id: tOwn.rev_id + 1000 })), 409, 'SYSBUILD_TASK_SUPERSEDED', 'revision_id 不符');
    expectErr(await decideRaw(U.own, tOwn.task_id, bodyFor(tOwn, { object_version_id: s.pv + 1000 })), 409, 'SYSBUILD_VERSION_CHANGED', 'object_version_id 不符');
    // 3 浏览早于修订（把浏览记录改到很早以前）
    await sqlRun("UPDATE sysbuild_views SET opened_at = '2000-01-01 00:00:00' WHERE user_id = ?", [U.own]);
    expectErr(await decideRaw(U.own, tOwn.task_id, bodyFor(tOwn)), 409, 'SYSBUILD_NOT_VIEWED', '浏览早于修订');
    assert.strictEqual((await openTask(U.own, tOwn.task_id)).status, 200); // 重新打开 = 新的浏览记录
    // 4 冻结清单变了：浏览记录里存的清单与现在库里的清单不等
    await sqlRun("UPDATE sysbuild_frozen_attachments SET sha256 = ? WHERE object_type = 'package_version' AND object_version_id = ? AND attachment_id = ?", ['f'.repeat(64), s.pv, s.att]);
    const fc = await decideRaw(U.own, tOwn.task_id, bodyFor(tOwn));
    expectErr(fc, 409, 'SYSBUILD_VERSION_CHANGED', '冻结清单变了');
    assert.ok(fc.body.message.includes('附件清单'), `提示实际 ${fc.body.message}`);
    await sqlRun("UPDATE sysbuild_frozen_attachments SET sha256 = ? WHERE object_type = 'package_version' AND object_version_id = ? AND attachment_id = ?", ['a'.repeat(64), s.pv, s.att]);
    // 5 版本不再待确认（修订仍是待确认；用另一个任务，其余输入合法）
    assert.strictEqual((await openTask(U.del, tDel.task_id)).status, 200);
    await sqlRun("UPDATE sysbuild_package_versions SET status = 'superseded' WHERE id = ?", [s.pv]);
    const vc = await decideRaw(U.del, tDel.task_id, bodyFor(tDel));
    expectErr(vc, 409, 'SYSBUILD_VERSION_CHANGED', '版本不再待确认');
    assert.ok(vc.body.message.includes('不在待确认'), `提示实际 ${vc.body.message}`);
    await sqlRun("UPDATE sysbuild_package_versions SET status = 'pending' WHERE id = ?", [s.pv]);
    // 6 项目状态：已终止 409，已暂停可决策
    assert.strictEqual((await openTask(U.x1, tB.task_id)).status, 200);
    await sqlRun("UPDATE sysbuild_projects SET status = 'terminated' WHERE id = ?", [s.pid]);
    expectErr(await decideRaw(U.x1, tB.task_id, bodyFor(tB)), 409, 'SYSBUILD_PROJECT_READONLY', '已终止');
    await sqlRun("UPDATE sysbuild_projects SET status = 'paused' WHERE id = ?", [s.pid]);
    assert.strictEqual((await decideRaw(U.x1, tB.task_id, bodyFor(tB))).status, 200, '已暂停可作出推进类确认');
    await sqlRun("UPDATE sysbuild_projects SET status = 'active' WHERE id = ?", [s.pid]);
    // 7 已处理的修订不能再次决策
    const done = await decideRaw(U.x1, tB.task_id, bodyFor(tB));
    expectErr(done, 409, 'SYSBUILD_STATE', '已处理');
    assert.ok(done.body.message.includes('已处理'), `提示实际 ${done.body.message}`);
    // 以上失败都没有留下确认记录；对照：本人在条件满足后同样的请求通过
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_confirmations WHERE task_revision_id = ?', [tOwn.rev_id]), 0);
    assert.strictEqual((await decideRaw(U.own, tOwn.task_id, bodyFor(tOwn))).status, 200);
    assert.strictEqual(await nConf(), 2, '只有 tB 与 tOwn 两条确认记录');
  });

  test('C4a 决策：400 各分支（浏览与状态都满足的输入）——decision 枚举 / 固定勾选文案 / 异议与不认可必须写原因 / 原因超长 / 多余键 / 编号缺失或非法 / 数组体；原因 500 字边界通过', async () => {
    const s = await mkSubmitted();
    const t = s.T.aDel;
    const o = await openTask(U.del, t.task_id);
    assert.strictEqual(o.status, 200);
    // 勾选文案默认取所选决策对应的那一条（M-3）；用例要测「文案与决策不匹配」时在 extra 里显式覆盖 checkbox_text
    const base = (extra) => {
      const e = extra || {};
      return Object.assign({ revision_id: t.rev_id, object_version_id: s.pv, decision: 'confirm', checkbox_text: CHECKBOXES[hasOwn(e, 'decision') ? e.decision : 'confirm'] }, e);
    };
    const bad = async (body, field, label) => {
      const r = await decideRaw(U.del, t.task_id, body);
      expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', label);
      assert.strictEqual(r.body.field, field, `${label} 的 field`);
    };
    await bad(base({ decision: 'maybe' }), 'decision', 'decision 非法');
    await bad(base({ decision: undefined }), 'decision', 'decision 缺失');
    await bad(base({ decision: 5 }), 'decision', 'decision 非文本');
    await bad(base({ checkbox_text: '我已阅读' }), 'checkbox_text', '勾选文案不符');
    await bad(base({ checkbox_text: undefined }), 'checkbox_text', '勾选文案缺失');
    await bad(base({ checkbox_text: `${CHECKBOX} ` }), 'checkbox_text', '勾选文案多一个空格');
    // M-3 勾选文案按决策匹配：原因、浏览、状态都合法，只有文案与所选决策不配——换一个不会先被别的规则拦下的输入，每个决策各用另外两条文案提交一遍
    for (const [decision, wrongKeys] of [['confirm', ['object', 'reject']], ['object', ['confirm', 'reject']], ['reject', ['confirm', 'object']]]) {
      for (const wk of wrongKeys) {
        await bad(base({ decision, reason: '内容有出入，需要说明', checkbox_text: CHECKBOXES[wk] }), 'checkbox_text', `${decision} 用 ${wk} 的文案`);
      }
    }
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_confirmations WHERE task_revision_id = ?', [t.rev_id]), 0, '文案不配的提交不留确认记录');
    await bad(base({ decision: 'object' }), 'reason', '有异议缺原因');
    await bad(base({ decision: 'reject', reason: '   ' }), 'reason', '不认可原因空白');
    await bad(base({ decision: 'object', reason: '异'.repeat(501) }), 'reason', '有异议原因 501 字');
    await bad(base({ reason: '同'.repeat(501) }), 'reason', '确认原因 501 字');
    await bad(base({ x: 1 }), 'x', '多余键');
    await bad(base({ revision_id: undefined }), 'revision_id', 'revision_id 缺失');
    await bad(base({ revision_id: 'abc' }), 'revision_id', 'revision_id 非法');
    await bad(base({ object_version_id: 0 }), 'object_version_id', 'object_version_id 非法');
    const arr = await decideRaw(U.del, t.task_id, []);
    expectErr(arr, 400, 'SYSBUILD_INVALID_INPUT', '数组体');
    assert.strictEqual(arr.body.field, 'body');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_confirmations WHERE task_revision_id = ?', [t.rev_id]), 0, '参数错误不留确认记录');
    assert.strictEqual((await revOf(t.rev_id)).status, 'pending');
    const ok = await decideRaw(U.del, t.task_id, base({ reason: '同'.repeat(500) }));
    assert.strictEqual(ok.status, 200, `原因 500 字通过: ${ok.text}`);
  });

  test('C4a 决策（D42）：同一修订并发两次决策只成功一次（一 200 一 409），库内恰一条确认记录；库层部分唯一索引兜底——直接再写一条同修订的确认记录被拒', async () => {
    const s = await mkSubmitted();
    const t = s.T.aDel;
    const o = await openTask(U.del, t.task_id);
    const body = decideBodyOf(o.body, 'confirm');
    const rs = await Promise.all([decideRaw(U.del, t.task_id, body), decideRaw(U.del, t.task_id, body)]);
    assert.deepStrictEqual(rs.map((r) => r.status).sort(), [200, 409], `并发两次应一成一败: ${rs.map((r) => r.text).join(' | ')}`);
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_confirmations WHERE task_revision_id = ?', [t.rev_id]), 1);
    assert.strictEqual((await revOf(t.rev_id)).status, 'confirmed');
    await assert.rejects(
      sqlRun("INSERT INTO sysbuild_confirmations (task_revision_id, object_type, object_version_id, actor_user_id, method, decision, checkbox_text, view_id) VALUES (?, 'package_version', ?, ?, 'platform', 'confirm', ?, ?)", [t.rev_id, s.pv, U.del, CHECKBOX, o.body.view_id]),
      (e) => e && e.code === 'SQLITE_CONSTRAINT', '同一修订第二条确认记录应被唯一索引拒绝'
    );
  });

  // ── 改发 / 换人 ──────────────────────────────────────────────────────────────────────────────────
  test('C4a 改发：负责人更换后改发——有异议的修订保留、新增 rev_no+1 的修订指向当前负责人；旧负责人不再是必需确认人 403；新人不继承旧人的浏览记录（须自己浏览）', async () => {
    const s = await mkSubmitted({ historicalLeaderTasks: true });
    const tid = s.T.aOwner.task_id;
    assert.strictEqual((await openAndDecide(U.own, tid, 'object')).status, 200);
    const oldBody = decideBodyOf((await openTask(U.pm, tid)).body, 'confirm');
    // 夹具：负责人更换（membership 的更换流程另有用例）——结束旧任职，新成员 cand 现任
    await sqlRun("UPDATE sysbuild_appointments SET status = 'ended', ended_at = '2026-10-20 10:00:00', end_reason = '负责人更换' WHERE id = ?", [s.A.apt]);
    const mCand = await addMember(s.pid, U.cand, { party: s.A.party });
    const aptNew = await addAppointment(s.A.party, mCand, 'active');
    const rr = await reissue(U.pm, tid, '负责人更换，改发新负责人');
    assert.strictEqual(rr.status, 200, rr.text);
    assert.deepStrictEqual(rr.body, { task_id: tid, revision: { id: rr.body.revision.id, rev_no: 2, status: 'pending', required_member_id: mCand } });
    const nr = await revOf(rr.body.revision.id);
    assert.deepStrictEqual([nr.task_id, nr.rev_no, nr.required_member_id, nr.basis_appointment_id, nr.basis_delegation_id, nr.status], [tid, 2, mCand, aptNew, null, 'pending']);
    const old = await revOf(s.T.aOwner.rev_id);
    assert.deepStrictEqual([old.status, old.status_reason], ['objected', null], '有异议的旧修订保留原状');
    assert.deepStrictEqual((await payloads(s.pid, 'confirm_task_reissued'))[0], {
      revision_id: nr.id, previous_revision_id: s.T.aOwner.rev_id, rev_no: 2, required_member_id: mCand, basis_appointment_id: aptNew, basis_delegation_id: null, reason: '负责人更换，改发新负责人',
    });
    const view = await openTask(U.pm, tid);
    assert.deepStrictEqual([view.body.revisions.length, view.body.revision.rev_no, view.body.revision.required_member_id], [2, 2, mCand]);
    // 旧负责人（带旧修订编号）：不是当前修订的必需确认人
    expectErr(await decideRaw(U.own, tid, oldBody), 403, 'SYSBUILD_FORBIDDEN', '旧负责人');
    // 旧必需确认人带当前修订编号仍 403：confirm_decide 的 can = t.isRequired 只看当前修订（rules.js 的必需确认人判定，不看浏览与修订编号；原 devkey.js:259 的承接，附录 C entries:1194:1219）
    expectErr(await decideRaw(U.own, tid, { revision_id: nr.id, object_version_id: s.pv, decision: 'confirm', checkbox_text: CHECKBOX }), 403, 'SYSBUILD_FORBIDDEN', '旧负责人带当前修订号');
    // 新负责人：没打开过 → 未浏览（旧人的浏览记录不继承）
    const nb = { revision_id: nr.id, object_version_id: s.pv, decision: 'confirm', checkbox_text: CHECKBOX };
    expectErr(await decideRaw(U.cand, tid, nb), 409, 'SYSBUILD_NOT_VIEWED', '新人未浏览');
    assert.strictEqual((await openTask(U.cand, tid)).status, 200);
    assert.strictEqual((await decideRaw(U.cand, tid, nb)).status, 200);
    assert.strictEqual((await revOf(nr.id)).status, 'confirmed');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_confirmations WHERE object_type = 'package_version' AND object_version_id = ? AND actor_user_id = ?", [s.pv, U.own]), 1, '旧负责人只有那一条有异议记录');
  });

  // C6 新增（CA3c 161-M2；接替整删的 devkey.js:259 用例里同一任务第二次改发的 rev_no = 3 与新任负责人成员编号断言，原 :289，附录 C devkey:259:289；保留的「C4a 改发」用例只到 rev_no = 2）
  //   另含旧修订号决策一格（接替 entries.js:532 的 :624，附录 C entries:532:624）：同一必需确认人先不认可首修订、PM 改发、新修订必需确认人不变，旧人用首修订编号提交决策 → 409 SYSBUILD_TASK_SUPERSEDED（rules.js 的 revisionIdGiven 判定先于修订状态判定，不是 SYSBUILD_STATE）。
  test('C6：内容包确认任务连续改发——同一任务第二次改发 rev_no = 3、必需确认人为当时现任负责人（成员编号与任职依据），第一次改发出的修订置已替代；旧修订号决策 409 SYSBUILD_TASK_SUPERSEDED（不是 SYSBUILD_STATE，不新增确认记录）', async () => {
    const s = await mkSubmitted({ historicalLeaderTasks: true });
    const tid = s.T.aOwner.task_id;
    assert.strictEqual((await openAndDecide(U.own, tid, 'object')).status, 200, '前置：首修订有异议（才能改发）');
    // 第一次：结束旧任职，cand 现任 → 改发 rev_no = 2 指向 cand
    await sqlRun("UPDATE sysbuild_appointments SET status = 'ended', ended_at = '2026-10-20 10:00:00', end_reason = '负责人更换' WHERE id = ?", [s.A.apt]);
    const mCand = await addMember(s.pid, U.cand, { party: s.A.party });
    const apt1 = await addAppointment(s.A.party, mCand, 'active');
    const r1 = await reissue(U.pm, tid, '第一次更换，改发新负责人');
    assert.strictEqual(r1.status, 200, r1.text);
    assert.deepStrictEqual([r1.body.revision.rev_no, r1.body.revision.required_member_id], [2, mCand]);
    // 第二次：cand 的任职结束，cand2 现任（rev_no = 2 仍待确认）→ 再改发 rev_no = 3 指向 cand2，第一次改发出的 rev_no = 2 置已替代
    await sqlRun("UPDATE sysbuild_appointments SET status = 'ended', ended_at = '2026-10-21 10:00:00', end_reason = '再次更换' WHERE id = ?", [apt1]);
    const mCand2 = await addMember(s.pid, U.cand2, { party: s.A.party });
    const apt2 = await addAppointment(s.A.party, mCand2, 'active');
    const r2 = await reissue(U.pm, tid, '第二次更换，再次改发');
    assert.strictEqual(r2.status, 200, r2.text);
    assert.deepStrictEqual([r2.body.revision.rev_no, r2.body.revision.status, r2.body.revision.required_member_id], [3, 'pending', mCand2], '第二次改发：rev_no = 3，必需确认人 = 当时现任负责人的成员编号');
    const n3 = await revOf(r2.body.revision.id);
    assert.deepStrictEqual([n3.task_id, n3.rev_no, n3.required_member_id, n3.basis_appointment_id, n3.basis_delegation_id], [tid, 3, mCand2, apt2, null], '任职依据 = 当时的任职');
    const rev2 = await revOf(r1.body.revision.id);
    assert.strictEqual(rev2.status, 'superseded', '第一次改发出的修订被置已替代');
    // 旧修订号决策一格：必需确认人在改发前后是同一人（同 P38 后改发的 aDel 形态）
    const s2 = await mkSubmitted({ historicalLeaderTasks: true });
    const tid2 = s2.T.aOwner.task_id;
    assert.strictEqual((await openAndDecide(U.own, tid2, 'reject', { reason: '范围不对' })).status, 200, '前置：首修订被不认可');
    const rr = await reissue(U.pm, tid2, '同一负责人重新确认');
    assert.strictEqual(rr.status, 200, rr.text);
    assert.strictEqual(rr.body.revision.required_member_id, (await revOf(s2.T.aOwner.rev_id)).required_member_id, '前置：新修订的必需确认人仍是同一人');
    const confCount = () => countOf("SELECT COUNT(*) AS n FROM sysbuild_confirmations WHERE object_type = 'package_version' AND object_version_id = ?", [s2.pv]);
    const confBefore = await confCount();
    const stale = await decideRaw(U.own, tid2, { revision_id: s2.T.aOwner.rev_id, object_version_id: s2.pv, decision: 'confirm', checkbox_text: CHECKBOX });
    expectErr(stale, 409, 'SYSBUILD_TASK_SUPERSEDED', '用首修订编号提交决策');
    assert.strictEqual(stale.body.message, '该确认任务已被改发或替代，请刷新后重试');
    assert.strictEqual(await confCount(), confBefore, '被拒的决策不新增确认记录');
  });

  test('C4a 改发：待确认 / 不认可的修订可改发（待确认的旧修订置已替代并写原因，同一任务始终至多一条待确认）；代表人任务按当前生效授权改发，无生效代表人 409', async () => {
    const s = await mkSubmitted({ historicalLeaderTasks: true });
    // 待确认 → 改发给同一人：旧修订 superseded，新修订 pending
    const tB = s.T.bOwner;
    const r1 = await reissue(U.pm, tB.task_id, '重新请对方确认');
    assert.strictEqual(r1.status, 200, r1.text);
    const old = await revOf(tB.rev_id);
    assert.deepStrictEqual([old.status, old.status_reason], ['superseded', '重新请对方确认']);
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_confirm_task_revisions WHERE task_id = ? AND status = 'pending'", [tB.task_id]), 1);
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_confirm_task_revisions WHERE task_id = ?', [tB.task_id]), 2);
    // 不认可 → 改发：旧修订保持 rejected
    const tBd = s.T.bDel;
    assert.strictEqual((await openAndDecide(U.x2, tBd.task_id, 'reject')).status, 200);
    const r2 = await reissue(U.pm, tBd.task_id, '范围已调整，请重新确认');
    assert.strictEqual(r2.status, 200, r2.text);
    assert.strictEqual((await revOf(tBd.rev_id)).status, 'rejected');
    const nr2 = await revOf(r2.body.revision.id);
    assert.deepStrictEqual([nr2.rev_no, nr2.required_member_id, nr2.basis_appointment_id, nr2.basis_delegation_id], [2, s.B.mDel, null, s.B.dlg], '代表人任务改发后仍依据授权');
    // 代表人任务：授权被负责人撤销 → 改发 409（没有生效代表人）；补上新授权后改发给新代表人
    const tDel = s.T.aDel;
    const rev = await post(U.pm, `/sysbuild/delegations/${s.A.dlg}/revoke`, { reason: '更换代表人' });
    assert.strictEqual(rev.status, 200, rev.text);
    const none = await reissue(U.pm, tDel.task_id, '改发新代表人');
    expectErr(none, 409, 'SYSBUILD_STATE', '没有生效负责人');
    assert.ok(none.body.message.includes('没有生效负责人'), `提示实际 ${none.body.message}`);
    const mC2 = await addMember(s.pid, U.cand2, { party: s.A.party });
    const dlgNew = await addDelegation(s.A.party, mC2, s.A.apt, 'active');
    const ok = await reissue(U.pm, tDel.task_id, '改发新代表人');
    assert.strictEqual(ok.status, 200, ok.text);
    const nr3 = await revOf(ok.body.revision.id);
    assert.deepStrictEqual([nr3.rev_no, nr3.required_member_id, nr3.basis_appointment_id, nr3.basis_delegation_id], [2, mC2, null, dlgNew]);
    // 负责人任务：没有现任负责人 → 409
    await sqlRun("UPDATE sysbuild_appointments SET status = 'ended', ended_at = '2026-10-20 10:00:00', end_reason = '离任' WHERE id = ?", [s.B.apt]);
    const noOwner = await reissue(U.pm, s.T.bOwner.task_id, '改发');
    expectErr(noOwner, 409, 'SYSBUILD_STATE', '没有现任领导');
    assert.ok(noOwner.body.message.includes('没有现任领导'), `提示实际 ${noOwner.body.message}`);
  });

  test('C4a 改发：不能改发的情形与权限——已确认 / 版本不再待确认 409；非 PM 403；非成员 404；原因必填；多余键；已终止 409、已暂停可改发', async () => {
    const s = await mkSubmitted({ historicalLeaderTasks: true });
    await addMember(s.pid, U.m1);
    // 已确认
    assert.strictEqual((await openAndDecide(U.own, s.T.aOwner.task_id, 'confirm')).status, 200);
    const done = await reissue(U.pm, s.T.aOwner.task_id, '想改发');
    expectErr(done, 409, 'SYSBUILD_STATE', '已确认');
    assert.ok(done.body.message.includes('待确认、有异议、不认可或已失效'), `提示实际 ${done.body.message}`);
    // 版本不再待确认（修订仍待确认：直接改版本状态）
    await sqlRun("UPDATE sysbuild_package_versions SET status = 'superseded' WHERE id = ?", [s.pv]);
    const gone = await reissue(U.pm, s.T.bOwner.task_id, '想改发');
    expectErr(gone, 409, 'SYSBUILD_STATE', '版本不再待确认');
    assert.ok(gone.body.message.includes('已不是待确认'), `提示实际 ${gone.body.message}`);
    await sqlRun("UPDATE sysbuild_package_versions SET status = 'pending' WHERE id = ?", [s.pv]);
    // 权限 / 参数
    const tid = s.T.bDel.task_id;
    for (const [uid, label] of [[U.m1, '一般成员'], [U.x2, '必需确认人本人'], [U.admin, 'admin 未接管']]) expectErr(await reissue(uid, tid, '想改发'), 403, 'SYSBUILD_FORBIDDEN', label);
    expectErr(await reissue(U.out, tid, '想改发'), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    expectErr(await reissue(U.pm, 99999999, '想改发'), 404, 'SYSBUILD_NOT_FOUND', '任务不存在');
    const nr = await reissue(U.pm, tid);
    expectErr(nr, 400, 'SYSBUILD_INVALID_INPUT', '缺原因');
    assert.strictEqual(nr.body.field, 'reason');
    expectErr(await post(U.pm, `/sysbuild/confirm-tasks/${tid}/reissue`, { reason: '改发', x: 1 }), 400, 'SYSBUILD_INVALID_INPUT', '多余键');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_confirm_task_revisions WHERE task_id = ?', [tid]), 1, '被拒绝的改发不新增修订');
    // 项目状态
    assert.strictEqual((await setStatus(s.pid, 'terminated')).status, 200);
    expectErr(await reissue(U.pm, tid, '终止后改发'), 409, 'SYSBUILD_PROJECT_READONLY', '已终止');
    assert.strictEqual((await setStatus(s.pid, 'active')).status, 200);
    assert.strictEqual((await setStatus(s.pid, 'paused')).status, 200);
    assert.strictEqual((await reissue(U.pm, tid, '暂停期改发')).status, 200, '已暂停可改发');
  });

  // ── 失资格 ───────────────────────────────────────────────────────────────────────────────────────
  test('C4a 失资格：负责人任职已结束 / 授权已撤销 / 成员已移出（只读账号仍可见）/ 账号已停用——decide 409 SYSBUILD_STATE，actions.decide 为假；改发后新人可确认；被移出的普通成员 404', async () => {
    const s = await mkSubmitted({ historicalLeaderTasks: true });
    // 任职已结束（负责人更换）
    await sqlRun("UPDATE sysbuild_appointments SET status = 'ended', ended_at = '2026-10-20 10:00:00', end_reason = '负责人更换' WHERE id = ?", [s.B.apt]);
    const o1 = await openTask(U.x1, s.T.bOwner.task_id);
    assert.strictEqual(o1.body.actions.decide, false, '失去资格后 decide 标志为假');
    const d1 = await decideRaw(U.x1, s.T.bOwner.task_id, decideBodyOf(o1.body, 'confirm'));
    expectErr(d1, 409, 'SYSBUILD_STATE', '任职已结束');
    assert.ok(d1.body.message.includes('任职'), `提示实际 ${d1.body.message}`);
    // 授权已撤销（负责人撤销代表人）
    const o2 = await openTask(U.del, s.T.aDel.task_id);
    assert.strictEqual(o2.body.actions.decide, true, '撤销前可决策');
    assert.strictEqual((await post(U.pm, `/sysbuild/delegations/${s.A.dlg}/revoke`, { reason: '更换代表人' })).status, 200);
    const o2b = await openTask(U.del, s.T.aDel.task_id);
    assert.strictEqual(o2b.body.actions.decide, false);
    const d2 = await decideRaw(U.del, s.T.aDel.task_id, decideBodyOf(o2b.body, 'confirm'));
    expectErr(d2, 409, 'SYSBUILD_STATE', '授权已撤销');
    assert.ok(d2.body.message.includes('授权'), `提示实际 ${d2.body.message}`);
    // 成员被移出：普通成员不再可见（404）
    assert.strictEqual((await post(U.pm, `/sysbuild/members/${s.B.mDel}/remove`, { reason: '离项' })).status, 200);
    expectErr(await openTask(U.x2, s.T.bDel.task_id), 404, 'SYSBUILD_NOT_FOUND', '被移出的普通成员看不到项目');
    // 账号已停用（进程内夹具没有鉴权层，直接到资格复核；真实实例的鉴权中间件会先拦下这个账号）
    if (isInproc()) {
      const o4 = await openTask(U.own, s.T.aOwner.task_id);
      let d4;
      await sqlRun("UPDATE users SET status = 'inactive' WHERE id = ?", [U.own]);
      try {
        d4 = await decideRaw(U.own, s.T.aOwner.task_id, decideBodyOf(o4.body, 'confirm'));
      } finally {
        // 还原放 finally：decide 抛出时也不把停用状态留给后面共用这个账号的用例（修订批二 LOW-7）
        await sqlRun("UPDATE users SET status = 'active' WHERE id = ?", [U.own]);
      }
      expectErr(d4, 409, 'SYSBUILD_STATE', '账号已停用');
      assert.ok(d4.body.message.includes('账号'), `提示实际 ${d4.body.message}`);
      assert.strictEqual((await decideRaw(U.own, s.T.aOwner.task_id, decideBodyOf(o4.body, 'confirm'))).status, 200, '对照：账号恢复后通过');
    }
    // 改发：负责人任务改给新负责人，新人可以确认
    const mCand = await addMember(s.pid, U.cand, { party: s.B.party });
    await addAppointment(s.B.party, mCand, 'active');
    const rr = await reissue(U.pm, s.T.bOwner.task_id, '负责人更换');
    assert.strictEqual(rr.status, 200, rr.text);
    assert.strictEqual((await openAndDecide(U.cand, s.T.bOwner.task_id, 'confirm')).status, 200, '改发后新负责人可确认');
    // 只读账号作为必需确认人：被移出项目后仍能打开（只读账号可见），但失去资格，decide 409
    const pid = await newProject();
    await seedParty(pid, '丙部', U.ro, null);
    const pv = await mkVersion(await mkPackage(pid, 'initiation'));
    await declareInitiationBasis(pv);
    assert.strictEqual((await submit(U.pm, pv)).status, 200);
    const [t] = await tasksOf(pv);
    const roMember = await memberRow(pid, U.ro);
    assert.strictEqual((await post(U.pm, `/sysbuild/members/${roMember}/remove`, { reason: '离项' })).status, 200);
    const ro = await openTask(U.ro, t.task_id);
    assert.deepStrictEqual([ro.status, ro.body.actions.decide], [200, false]);
    const dr = await decideRaw(U.ro, t.task_id, decideBodyOf(ro.body, 'confirm'));
    expectErr(dr, 409, 'SYSBUILD_STATE', '成员已移出');
    assert.ok(dr.body.message.includes('成员'), `提示实际 ${dr.body.message}`);
    assert.strictEqual(await verStatus(pv), 'pending');
  });

  // ── 生效与基线 ────────────────────────────────────────────────────────────────────────────────────
  test('C4a 生效：部分确认仍待确认；有人不认可不生效；改发后最后一人确认才生效；基线逐节点手写核对（有计划的有、取最后一条计划；已取消的没有；提交前计划已补齐，H-1）；任务详情节点清单与提交快照全等', async () => {
    // 总体规划待确认期间节点排期被冻结（P34），所以计划与取消节点都在提交之前做完（prepare）
    let nodeId;
    const s = await mkSubmitted({
      prepare: async (pid) => {
        const plan0 = (await get(U.pm, `/sysbuild/projects/${pid}/plan`)).body;
        nodeId = (key) => plan0.nodes.find((n) => n.template_key === key).id;
        const setPlan = async (key, a, b) => {
          const r = await post(U.pm, `/sysbuild/nodes/${nodeId(key)}/schedule`, { kind: 'plan', planned_start: a, planned_end: b });
          assert.strictEqual(r.status, 201, `${key}: ${r.text}`);
        };
        await setPlan('p_initiation', '2026-11-02', '2026-11-10');
        await setPlan('p_initiation', '2026-11-03', '2026-11-12'); // 改过一次：基线取最后一条
        await setPlan('p_overall', '2026-11-02', '2026-11-30');
        await setPlan('b_golive', '2026-11-04', '2026-11-19');
        await setPlan('b_golive', '2026-11-05', '2026-11-20');
        await setPlan('b_dev', '2026-11-21', '2026-11-28');
        assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${nodeId('b_dev')}/cancel`, { reason: '本期不做开发' })).status, 200); // 有计划但已取消：不形成基线
      },
    });
    // 提交事件记下各未取消节点当时的当前计划（P34；已取消的 b_dev 不在内，p_closing 由 planAllNodes 补齐），按节点编号升序，
    //   并带名称 / 层 / 批次 / 模板键快照（H-2）
    const planOverrides = { p_initiation: ['2026-11-03', '2026-11-12'], p_overall: ['2026-11-02', '2026-11-30'], b_golive: ['2026-11-05', '2026-11-20'] };
    const planned = (await inhouseNodePlans(s.pid, planOverrides, ['b_dev'])).map((x) => [x.node_id, x.template_key, x.planned_start, x.planned_end]);
    assert.deepStrictEqual(planned.map((x) => x[1]), ['b_golive', 'p_closing'], '自研两个节点覆盖三个职责');
    assert.deepStrictEqual((await payloads(s.pid, 'package_version_submitted'))[0].node_plans, await inhouseNodePlans(s.pid, planOverrides, ['b_dev']));
    const baselines = async () => (await baselinesIn(s.pid)).map((b) => ({ node_id: b.node_id, planned_start: b.planned_start, planned_end: b.planned_end, package_version_id: b.package_version_id, created_by: b.created_by, reason: b.reason }));
    const versionState = async () => (await get(U.pm, `/sysbuild/package-versions/${s.pv}`)).body.version;
    // 1 甲部负责人确认后，乙部仍待确认。
    const first = await openAndDecide(U.del, s.T.aDel.task_id, 'confirm');
    assert.strictEqual(first.status, 200, first.text);
    assert.strictEqual(first.body.effective, false);
    assert.strictEqual((await versionState()).status, 'pending');
    assert.deepStrictEqual(await baselines(), [], '部分确认不形成基线');
    // 2 乙部负责人不认可：不生效
    const rj = await openAndDecide(U.x2, s.T.bDel.task_id, 'reject');
    assert.deepStrictEqual([rj.status, rj.body.effective], [200, false]);
    assert.strictEqual((await versionState()).status, 'pending');
    assert.deepStrictEqual(await baselines(), []);
    // 3 改发后重新确认：最后一人确认生效
    const rr = await reissue(U.pm, s.T.bDel.task_id, '范围已说明，请重新确认');
    assert.strictEqual(rr.status, 200, rr.text);
    const fin = await openAndDecide(U.x2, s.T.bDel.task_id, 'confirm');
    assert.strictEqual(fin.status, 200, fin.text);
    assert.deepStrictEqual([fin.body.effective, fin.body.version, fin.body.superseded_version_ids], [true, { id: s.pv, status: 'effective' }, []]);
    assert.deepStrictEqual(fin.body.baseline_node_ids, planned.map((x) => x[0]), '只有确认清单中的节点形成基线');
    const row = await rowOf('sysbuild_package_versions', s.pv);
    assert.strictEqual(row.status, 'effective');
    assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row.effective_at), `effective_at 实际 ${row.effective_at}`);
    // 4 四个未取消节点各成一条基线，取最后一条计划，保留最终确认人以及版本依据。
    const expectBase = planned.map(([n, , a, b]) => [n, a, b]);
    assert.deepStrictEqual(await baselines(), expectBase.map(([n, a, b]) => ({ node_id: n, planned_start: a, planned_end: b, package_version_id: s.pv, created_by: U.x2, reason: null })));
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_node_schedule_records WHERE node_id = ? AND kind = 'baseline'", [nodeId('b_dev')]), 0, '已取消的节点没有基线');
    const bev = await payloads(s.pid, 'baseline_formed');
    assert.strictEqual(bev.length, 2);
    assert.ok(bev.every((p) => p.package_version_id === s.pv && p.via === 'package_effective'));
    assert.deepStrictEqual((await payloads(s.pid, 'package_version_effective')), [{ package_id: s.pk, version_no: 1, replaced: [] }]);
    // 5 读接口：基线与当前计划一致、与基线差 0；总体规划现行版本 = 本版本
    const pn = (await get(U.pm, `/sysbuild/projects/${s.pid}/plan`)).body.nodes.find((n) => n.template_key === 'p_initiation');
    assert.deepStrictEqual([pn.baseline, pn.current_plan, pn.diff_days], [null, { start: '2026-11-03', end: '2026-11-12' }, null]);
    assert.strictEqual((await get(U.pm, `/sysbuild/projects/${s.pid}/packages`)).body.overall_version_id, s.pv);
    // 5b 任务详情展示节点计划清单（P34 + H-2，取自提交事件快照）：整份与手写期望全等（名称 / 层 / 批次 / 模板键 / 日期）
    const detail = await openTask(U.pm, s.T.aDel.task_id);
    assert.deepStrictEqual(detail.body.object.node_plans, await inhouseNodePlans(s.pid, planOverrides, ['b_dev']));
    assert.deepStrictEqual(detail.body.object.node_plans.map((n) => [n.node_id, n.template_key, n.planned_start, n.planned_end]), planned);
    // 6 生效后：已确认的修订不能再决策；生效版本不能再提交 / 撤回 / 改发
    expectErr(await decideRaw(U.x2, s.T.bDel.task_id, decideBodyOf((await openTask(U.x2, s.T.bDel.task_id)).body, 'confirm')), 409, 'SYSBUILD_STATE', '生效后再决策');
    expectErr(await submit(U.pm, s.pv), 409, 'SYSBUILD_STATE', '生效版本再提交');
    expectErr(await reissue(U.pm, s.T.aDel.task_id, '想改发'), 409, 'SYSBUILD_STATE', '生效版本改发');
    expectErr(await post(U.pm, `/sysbuild/packages/${s.pk}/versions`), 409, 'SYSBUILD_STATE', '总体规划已生效：不能直接建草稿（D1）');
  });

  test('C4a 生效：立项包——生效不形成基线（即使节点有计划）；立项包新版本全部确认后原生效版本被替代', async () => {
    const pid = await newProject();
    const A = await seedParty(pid, '甲部', U.own, U.del);
    const B = await seedParty(pid, '乙部', U.x1, null);
    const plan = (await get(U.pm, `/sysbuild/projects/${pid}/plan`)).body;
    const nid = plan.nodes.find((n) => n.template_key === 'p_initiation').id;
    assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${nid}/schedule`, { kind: 'plan', planned_start: '2026-11-02', planned_end: '2026-11-10' })).status, 201);
    const pk = await mkPackage(pid, 'initiation');
    const v1 = await mkVersion(pk);
    await declareInitiationBasis(v1);
    assert.strictEqual((await submit(U.pm, v1)).status, 200);
    const last1 = await confirmAll(v1);
    assert.deepStrictEqual([last1.body.effective, last1.body.baseline_node_ids, last1.body.superseded_version_ids], [true, [], []]);
    assert.strictEqual(await verStatus(v1), 'effective');
    assert.strictEqual(await baselineCount(pid), 0, '立项包生效不形成基线');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_events WHERE project_id = ? AND event_type = 'baseline_formed'", [pid]), 0);
    assert.strictEqual((await rowOf('sysbuild_batches', await defaultBatchId(pid))).status, 'planning', 'M-1：立项包生效不推进批次（只有合并形态的总体规划包生效才推进）');
    // 第二版：立项包不受「生效后不能建草稿」限制
    const v2 = await mkVersion(pk);
    assert.strictEqual((await api(U.pm, 'PATCH', `/sysbuild/package-versions/${v2}`, { snapshot_json: { 说明: '第二版立项文案' } })).status, 200);
    await declareInitiationBasis(v2);
    assert.strictEqual((await submit(U.pm, v2)).status, 200);
    assert.strictEqual(await verStatus(v1), 'effective', '新版本待确认期间原版本仍生效');
    const last2 = await confirmAll(v2);
    assert.deepStrictEqual([last2.body.effective, last2.body.superseded_version_ids], [true, [v1]]);
    assert.deepStrictEqual([await verStatus(v1), await verStatus(v2)], ['superseded', 'effective']);
    assert.deepStrictEqual(await payloads(pid, 'package_version_superseded'), [{ package_id: pk, replaced_by: v2 }]);
    assert.deepStrictEqual((await payloads(pid, 'package_version_effective')).map((p) => [p.version_no, p.replaced]), [[1, []], [2, [v1]]]);
    // 第二版的必需确认人是新的任务（前一版确认不继承）
    assert.strictEqual((await tasksOf(v2)).length, 2);
    assert.ok(A.party > 0 && B.party > 0);
  });

  // S-S1c：「第二次总体规划生效」的生产路径复验（经变更包：建变更 → 提交 → 全部确认 → 同一事务生成新的完整总体规划版本、旧版本被替代、基线按提交记录核对）在 sysbuild-api-suite-changes.js 的
  //   「C5 变更：生效」「C5 变更：基线」两条用例；本条保留夹具版（直接插第二个版本）作对照，它覆盖的是「基线不可覆盖」的两个变异（覆盖已有基线 / 反向核对）。
  test('C4a 生效：总体规划第二个版本生效（夹具：D1 之后第二版 C5 前无生产路径）——以另一版本已有的基线为来源时拒绝并回滚', async () => {
    const pid = await newProject();
    await seedParty(pid, '甲部', U.own, U.del);
    const plan = (await get(U.pm, `/sysbuild/projects/${pid}/plan`)).body;
    const nid = plan.nodes.find((n) => n.template_key === 'p_overall').id;
    assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${nid}/schedule`, { kind: 'plan', planned_start: '2026-11-02', planned_end: '2026-11-30' })).status, 201);
    const { pk, pv } = await H.produceEffectiveOverall(pid);
    const base1 = await baselinesIn(pid);
    assert.deepStrictEqual(base1.map((b) => [b.node_id, b.planned_start, b.planned_end, b.package_version_id]), (await inhouseNodePlans(pid)).map((x) => [x.node_id, x.planned_start, x.planned_end, pv]), 'H-1：produceEffectiveOverall 提交前补齐全部节点计划，生效时逐节点形成基线');
    // 夹具：第二个版本（草稿）；节点改期（走改期分支）后当前计划与基线不同
    const v2 = (await sqlRun("INSERT INTO sysbuild_package_versions (package_id, version_no, form, status, snapshot_json, created_by) VALUES (?, 2, 'overall_batch_req', 'draft', '{}', ?)", [pk, U.pm])).lastID;
    const rs = await post(U.pm, `/sysbuild/nodes/${nid}/schedule`, { kind: 'plan', planned_start: '2026-12-01', planned_end: '2026-12-20', reason: '客户要求延期', no_written_evidence: true, no_evidence_reason: '电话沟通后已确认延期事宜' });
    assert.strictEqual(rs.status, 201, rs.text);
    await H.prepareBasisVersion(v2);
    assert.strictEqual((await submit(U.pm, v2)).status, 200);
    const [task] = await tasksOf(v2);
    const last = await openAndDecide(task.user_id, task.task_id, 'confirm');
    expectErr(last, 500, 'SYSBUILD_INTERNAL', '已有基线属于上一范围确认');
    assert.strictEqual(last.body.message, '范围确认计划快照无法核对');
    assert.deepStrictEqual([await verStatus(pv), await verStatus(v2)], ['effective', 'pending']);
    assert.strictEqual((await revOf(task.rev_id)).status, 'pending', '最后一次决定回滚');
    assert.deepStrictEqual(await baselinesIn(pid), base1, '已有基线不覆盖、不新增（基线不可覆盖）');
    assert.strictEqual((await get(U.pm, `/sysbuild/projects/${pid}/packages`)).body.overall_version_id, pv, '现行范围仍为原版');
  });

  // ── H-1 / P43：基线只来自被确认的计划（撤销 C4a 交接 ①「生效后首次计划即基线」）──────────────────────────────
  test('C4a H-1（P43）生效后写计划：新增节点可首排；再排须有原因，基线保留确认事实与项目边界', async () => {
    const pid = await newProject();
    await H.produceEffectiveOverall(pid);
    const formedBefore = (await payloads(pid, 'baseline_formed')).length;
    assert.strictEqual(formedBefore, 2, '自研只形成两个范围职责节点的基线');
    const bid = await defaultBatchId(pid);
    const addNode = await post(U.pm, `/sysbuild/batches/${bid}/nodes`, { name: '生效后新增的自定义节点' });
    assert.strictEqual(addNode.status, 201, addNode.text);
    const nid = addNode.body.node.id;
    assert.deepStrictEqual([addNode.body.node.plan_write_mode, addNode.body.node.has_baseline], ['draft', false]);
    const first = (extra) => post(U.pm, `/sysbuild/nodes/${nid}/schedule`, Object.assign({ kind: 'plan', planned_start: '2026-12-01', planned_end: '2026-12-10' }, extra || {}));
    const ok1 = await first();
    assert.strictEqual(ok1.status, 201, ok1.text);
    const recs = (await get(U.pm, `/sysbuild/nodes/${nid}/schedule`)).body.records;
    assert.deepStrictEqual(recs.map((r) => [r.kind, r.planned_start, r.planned_end, r.package_version_id, r.reason, r.no_written_evidence]), [['plan_change', '2026-12-01', '2026-12-10', null, '范围生效后首次排期', false]]);
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_node_schedule_records WHERE node_id = ? AND kind = 'baseline'", [nid]), 0, '没有基线');
    assert.strictEqual((await payloads(pid, 'baseline_formed')).length, formedBefore, '没有新增 baseline_formed 事件');
    assert.deepStrictEqual((await payloads(pid, 'node_plan_set')).pop(), {
      record_id: ok1.body.record_id, before: null, after: { start: '2026-12-01', end: '2026-12-10' }, reason: '范围生效后首次排期', draft: false,
    });
    assert.deepStrictEqual([ok1.body.node.baseline, ok1.body.node.current_plan, ok1.body.node.diff_days, ok1.body.node.has_baseline], [null, { start: '2026-12-01', end: '2026-12-10' }, null, false]);
    // 再改一次：仍是改期式写入，仍无基线
    assert.strictEqual(ok1.body.node.plan_write_mode, 'reschedule');
    const noReason = await first({ planned_end: '2026-12-20' });
    expectErr(noReason, 400, 'SYSBUILD_INVALID_INPUT', '后续修改须有原因');
    assert.strictEqual(noReason.body.field, 'reason');
    const ok2 = await first({ planned_start: '2026-12-05', planned_end: '2026-12-20', reason: '客户要求延期' });
    assert.strictEqual(ok2.status, 201, ok2.text);
    assert.deepStrictEqual(await recordsKinds(nid), ['plan_change', 'plan_change']);
    // 已有基线的节点（生效时形成）改期：基线保留，plan_write_mode 同为 reschedule、has_baseline 为真
    const closingNode = (await get(U.pm, `/sysbuild/projects/${pid}/plan`)).body.nodes.find((n) => n.template_key === 'p_closing');
    assert.deepStrictEqual([closingNode.plan_write_mode, closingNode.has_baseline], ['reschedule', true]);
    // 范围发起前已排好计划的普通开发阶段，有当前计划而没有基线。
    const dev = (await get(U.pm, `/sysbuild/projects/${pid}/plan`)).body.nodes.find((n) => n.template_key === 'b_dev');
    assert.deepStrictEqual([dev.current_plan, dev.baseline, dev.diff_days, dev.has_baseline, dev.plan_write_mode], [
      { start: PLAN_START, end: PLAN_END }, null, null, false, 'reschedule',
    ]);
    const devPlan = (extra) => post(U.pm, `/sysbuild/nodes/${dev.id}/schedule`, { kind: 'plan', planned_start: '2026-12-06', planned_end: '2026-12-22', ...extra });
    expectErr(await devPlan({}), 400, 'SYSBUILD_INVALID_INPUT', '已有计划、没有基线的普通阶段仍需原因');
    const devChange = await devPlan({ reason: '调整开发计划' });
    assert.strictEqual(devChange.status, 201, devChange.text);
    assert.deepStrictEqual([devChange.body.node.current_plan, devChange.body.node.baseline, devChange.body.node.diff_days], [{ start: '2026-12-06', end: '2026-12-22' }, null, null]);
    assert.strictEqual((await get(U.pm, `/sysbuild/projects/${pid}/plan`)).body.nodes.find((n) => n.id === dev.id).report !== undefined, true);
    // 草稿期（项目没有生效的总体规划）：设计划仍是草稿期计划；别的项目已有生效版本不影响它
    const other = await newProject();
    const oView = (await get(U.pm, `/sysbuild/projects/${other}/plan`)).body.nodes.find((n) => n.template_key === 'p_overall');
    assert.deepStrictEqual([oView.plan_write_mode, oView.has_baseline], ['draft', false]);
    const o1 = await post(U.pm, `/sysbuild/nodes/${oView.id}/schedule`, { kind: 'plan', planned_start: '2026-12-01', planned_end: '2026-12-10' });
    assert.strictEqual(o1.status, 201, o1.text);
    const orecs = (await get(U.pm, `/sysbuild/nodes/${oView.id}/schedule`)).body.records;
    assert.deepStrictEqual(orecs.map((r) => [r.kind, r.package_version_id, r.is_draft_plan]), [['plan_change', null, true]], '没有生效版本的项目：草稿期计划，不写基线');
    const [otherPlan] = await payloads(other, 'node_plan_set');
    assert.deepStrictEqual([otherPlan.draft, otherPlan.reason], [true, '草稿期计划'], '邻项目的范围生效事实不得改写草稿期排期事件');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_events WHERE project_id = ? AND event_type = 'baseline_formed'", [other]), 0);
  });

  // ── H-1 / P43：提交前置「计划齐全」──────────────────────────────────────────────────────────────────────
  test('C4a H-1（P43）提交前置：计划齐全——只要求三个职责节点，缺节点或日期按提交和读标志同源拒绝，无旧快照回退', async () => {
    const HEAD = '以下阶段还没有有效的计划起止日期：';
    const submitFlag = async (vid) => (await get(U.pm, `/sysbuild/package-versions/${vid}`)).body.actions.submit;
    const planNode = async (pid, key, a, b) => {
      const r = await post(U.pm, `/sysbuild/nodes/${await nodeIdOf(pid, key)}/schedule`, { kind: 'plan', planned_start: a || PLAN_START, planned_end: b || PLAN_END });
      assert.strictEqual(r.status, 201, `${key}: ${r.text}`);
    };
    // 兄弟项目有一个计划齐全、已提交的总体规划包：本项目的判定不得被它影响（过滤模式下用例单独运行，库里没有别的数据）
    await mkSubmitted({ single: true });
    await newProject(); // 另一个项目的节点全都没有计划：本项目的缺计划清单不得带上它们。
    // 1 合并形态（单批）：5 个节点都没有计划 → 全部列出（项目层在前，批次层带批次名）。
    const d = await mkDraft({ noPlans: true });
    assert.strictEqual((await rowOf('sysbuild_package_versions', d.pv)).form, 'overall_batch_req');
    assert.strictEqual(await submitFlag(d.pv), false, '缺计划：submit 标志为假');
    const r1 = await submit(U.pm, d.pv);
    expectErr(r1, 409, 'SYSBUILD_STATE', '合并形态全部缺计划');
    assert.strictEqual(r1.body.message, `${HEAD}上线（含测试与验收）（第 1 批）、结项`);
    assert.strictEqual(await verStatus(d.pv), 'draft');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE object_version_id = ? AND object_type = 'package_version'", [d.pv]), 0, '被拒绝的提交不生成任务');
    // 2 只补项目层：批次层两个节点仍缺，提交仍 409，且只列批次层。
    for (const k of ['p_initiation', 'p_overall', 'p_closing']) await planNode(d.pid, k);
    await sqlRun("UPDATE sysbuild_package_versions SET form = 'overall' WHERE id = ? AND status = 'draft'", [d.pv]);
    const r2 = await submit(U.pm, d.pv);
    expectErr(r2, 409, 'SYSBUILD_STATE', '合并形态：项目层齐了，批次层缺');
    assert.strictEqual(r2.body.message, `${HEAD}上线（含测试与验收）（第 1 批）`);
    // 3 已取消的节点不要求：取消 b_dev 后只列 b_golive。
    assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${await nodeIdOf(d.pid, 'b_dev')}/cancel`, { reason: '本期不做开发' })).status, 200);
    const r3 = await submit(U.pm, d.pv);
    expectErr(r3, 409, 'SYSBUILD_STATE', '取消 b_dev 后只缺 b_golive');
    assert.strictEqual(r3.body.message, `${HEAD}上线（含测试与验收）（第 1 批）`);
    assert.strictEqual(await submitFlag(d.pv), false);
    await planNode(d.pid, 'b_golive');
    assert.strictEqual(await submitFlag(d.pv), true, '补齐后标志为真');
    const ok = await submit(U.pm, d.pv);
    assert.strictEqual(ok.status, 200, ok.text);
    assert.deepStrictEqual((await payloads(d.pid, 'package_version_submitted'))[0].node_plans.map((x) => x.template_key), ['b_golive', 'p_closing'], '已取消的 b_dev 不在清单里');
    const missing = await mkDraft();
    await sqlRun("UPDATE sysbuild_nodes SET status = 'cancelled' WHERE project_id = ? AND template_key = 'p_closing'", [missing.pid]);
    assert.strictEqual(await submitFlag(missing.pv), false);
    const noNode = await submit(U.pm, missing.pv);
    expectErr(noNode, 409, 'SYSBUILD_STATE', '必须节点不能靠不存在而绕过计划检查');
    assert.strictEqual(noNode.body.message, '范围确认所需阶段缺失、重复或已取消：结项');

    // 立项包不要求计划齐全。
    const pidI = await newProject();
    await seedParty(pidI, '甲部', U.own, null);
    const iniV = await mkVersion(await mkPackage(pidI, 'initiation'));
    await declareInitiationBasis(iniV);
    assert.strictEqual(await submitFlag(iniV), true);
    assert.strictEqual((await submit(U.pm, iniV)).status, 200, '立项包不要求节点计划齐全');
  });

  // ── M-1 合并包生效推进批次 ──────────────────────────────────────────────────────────────────────────────
  test('C4a M-1：合并形态（单批）总体规划包生效的同一事务里，「规划中」的批次推进到「进行中」并写批次状态事件——不需要先开始任何节点；已是进行中的批次不重复写；立项包生效不推进', async () => {
    const pid = await newProject();
    const batch = await defaultBatchId(pid);
    assert.strictEqual((await rowOf('sysbuild_batches', batch)).status, 'planning');
    const { pk, pv } = await H.produceEffectiveOverall(pid);
    // 不开始任何节点：全部仍是未开始
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_nodes WHERE project_id = ? AND status <> 'not_started'", [pid]), 0, '没有开始过任何节点');
    assert.strictEqual((await rowOf('sysbuild_batches', batch)).status, 'active', '合并包生效：规划中 → 进行中');
    const evs = await payloads(pid, 'batch_status_changed');
    assert.deepStrictEqual(evs, [{ from: 'planning', to: 'active', via: 'package_effective', package_version_id: pv }]);
    const evRow = await sqlGet("SELECT object_type, object_id FROM sysbuild_events WHERE project_id = ? AND event_type = 'batch_status_changed'", [pid]);
    assert.deepStrictEqual(evRow, { object_type: 'batch', object_id: batch }, '事件挂在批次上');
    // 响应里带推进的批次（用最后一次决策的响应核对：重新造一个项目走一遍手写核对）；兄弟项目另有一个「规划中」的批次，推进只作用于本项目
    const sib = await newProject();
    const sibBatch = await defaultBatchId(sib);
    const s = await mkSubmitted({ single: true });
    const last = await confirmAll(s.pv);
    assert.deepStrictEqual([last.body.effective, last.body.advanced_batch_ids], [true, [s.batch]]);
    assert.strictEqual((await rowOf('sysbuild_batches', s.batch)).status, 'active');
    assert.strictEqual((await rowOf('sysbuild_batches', sibBatch)).status, 'planning', '兄弟项目的规划中批次不被推进');
    // 现行提交会归一为合并形态。用待确认的旧形态记录检验保留的生效分支。
    const legacy = await mkSubmitted({ single: true });
    await sqlRun("UPDATE sysbuild_package_versions SET form = 'overall' WHERE id = ? AND status = 'pending'", [legacy.pv]);
    const legacyVersion = await rowOf('sysbuild_package_versions', legacy.pv);
    assert.deepStrictEqual([legacyVersion.form, legacyVersion.status], ['overall', 'pending']);
    const legacyDecision = await confirmAll(legacy.pv);
    assert.deepStrictEqual([legacyDecision.body.effective, legacyDecision.body.advanced_batch_ids], [true, []]);
    assert.strictEqual((await rowOf('sysbuild_batches', legacy.batch)).status, 'planning', '旧式总体规划生效不推进批次');
    assert.deepStrictEqual(await payloads(legacy.pid, 'batch_status_changed'), []);
    // 独立夹具：范围确认前批次已是进行中，不重复推进。
    const activeProject = await newProject();
    const activeBatch = await defaultBatchId(activeProject);
    await sqlRun("UPDATE sysbuild_batches SET status = 'active' WHERE id = ?", [activeBatch]);
    await H.produceEffectiveOverall(activeProject);
    assert.deepStrictEqual(await payloads(activeProject, 'batch_status_changed'), []);
    assert.strictEqual((await payloads(pid, 'batch_status_changed')).length, 1, '批次状态事件只有第一次生效那一条');
    // 立项包生效不推进批次（立项包用例已核；这里再核一个干净项目）
    const p2 = await newProject();
    await seedParty(p2, '甲部', U.own, null);
    const iv = await mkVersion(await mkPackage(p2, 'initiation'));
    await declareInitiationBasis(iv);
    assert.strictEqual((await submit(U.pm, iv)).status, 200);
    await confirmAll(iv);
    assert.strictEqual((await rowOf('sysbuild_batches', await defaultBatchId(p2))).status, 'planning');
    assert.strictEqual((await payloads(p2, 'batch_status_changed')).length, 0);
  });

  // ── H-2 确认页排期用提交快照 ────────────────────────────────────────────────────────────────────────────
  test('C4a H-2：确认页的节点排期一律取提交快照——待确认期间节点 / 批次改名，先后打开的确认人看到同一份排期（名称、层、批次、模板键、日期），节点视图仍显示现值；生效核对按节点编号与日期，不受改名影响', async () => {
    const s = await mkSubmitted({ historicalLeaderTasks: true, single: true });
    const expected = await inhouseNodePlans(s.pid);
    const first = await openTask(U.own, s.T.aOwner.task_id);
    assert.strictEqual(first.status, 200, first.text);
    assert.deepStrictEqual(first.body.object.node_plans, expected, '提交快照 = 提交时的名称 / 层 / 批次 / 模板键 / 日期');
    // 待确认期间改名（节点改名、批次改名都允许；排期与取消节点才被冻结）
    const reqId = await nodeIdOf(s.pid, 'b_golive');
    const rn = await api(U.pm, 'PATCH', `/sysbuild/nodes/${reqId}`, { name: '改名后的验收与正式上线节点' });
    assert.strictEqual(rn.status, 200, rn.text);
    const rb = await api(U.pm, 'PATCH', `/sysbuild/batches/${s.batch}`, { name: '改名后的批次' });
    assert.strictEqual(rb.status, 200, rb.text);
    const planNow = (await get(U.pm, `/sysbuild/projects/${s.pid}/plan`)).body;
    assert.strictEqual(planNow.nodes.find((n) => n.id === reqId).name, '改名后的验收与正式上线节点', '节点视图显示现值');
    assert.strictEqual(planNow.batches.find((b) => b.id === s.batch).name, '改名后的批次');
    // 后打开的确认人（乙部不存在：single）——用代表人 del 与 PM 都读到同一份快照，不是现值
    for (const [uid, tid, label] of [[U.del, s.T.aDel.task_id, '代表人'], [U.pm, s.T.aOwner.task_id, 'PM'], [U.own, s.T.aOwner.task_id, '负责人再次打开']]) {
      const r = await openTask(uid, tid);
      assert.strictEqual(r.status, 200, `${label}: ${r.text}`);
      assert.deepStrictEqual(r.body.object.node_plans, expected, `${label} 看到的排期仍是提交时的快照`);
      assert.ok(!JSON.stringify(r.body.object.node_plans).includes('改名后'), `${label}：快照里没有改名后的名称`);
    }
    // 提交事件本身也没变
    assert.deepStrictEqual((await payloads(s.pid, 'package_version_submitted'))[0].node_plans, expected);
    // 生效核对按节点编号与日期：改名不影响，照常生效并形成基线
    const fin = await confirmAll(s.pv);
    assert.deepStrictEqual([fin.body.effective, fin.body.baseline_node_ids], [true, expected.map((x) => x.node_id)]);
    // 生效后再读：仍是快照
    const after = await openTask(U.pm, s.T.aOwner.task_id);
    assert.deepStrictEqual(after.body.object.node_plans, expected);
  });

  // ── 待我确认 ────────────────────────────────────────────────────────────────────────────────────
  test('C4a 待我确认：只列我作为必需确认人的待确认修订（项目、对象、版本、修订号、创建时间），已处理 / 已替代 / 失效不列，别人的不列；被移出的成员不列', async () => {
    const s = await mkSubmitted({ historicalLeaderTasks: true });
    // 各用例共用一个库、同一批用户：只看本用例建的项目里的确认任务（scope 随场景切换）
    let scope = [s.pid];
    const mine = async (uid) => {
      const r0 = await get(uid, '/sysbuild/my/confirmations');
      if (r0.status !== 200) return r0;
      return { status: 200, text: r0.text, body: { items: r0.body.items.filter((i) => scope.includes(i.project_id)) } };
    };
    const r = await mine(U.own);
    assert.strictEqual(r.status, 200, r.text);
    const a = s.T.aOwner;
    const sysName = (await sqlGet('SELECT system_name FROM sysbuild_projects WHERE id = ?', [s.pid])).system_name;
    assert.deepStrictEqual(r.body.items, [{
      task_id: a.task_id, revision_id: a.rev_id, rev_no: 1, created_at: r.body.items[0].created_at, project_id: s.pid, system_name: sysName,
      object_type: 'package_version', object_id: s.pk, object_version_id: s.pv, purpose: 'package_confirm', party_id: s.A.party,
    }]);
    assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(r.body.items[0].created_at));
    assert.deepStrictEqual((await mine(U.x1)).body.items.map((i) => i.task_id), [s.T.bOwner.task_id]);
    assert.deepStrictEqual((await mine(U.pm)).body.items, [], 'PM 不是必需确认人');
    assert.deepStrictEqual((await mine(U.m1)).body.items, []);
    assert.strictEqual((await get(null, '/sysbuild/my/confirmations')).status, 401, '未登录');
    // 已处理不列
    assert.strictEqual((await openAndDecide(U.own, a.task_id, 'confirm')).status, 200);
    assert.deepStrictEqual((await mine(U.own)).body.items, []);
    // 有异议后改发：旧修订不列，新修订给新人
    assert.strictEqual((await openAndDecide(U.x1, s.T.bOwner.task_id, 'object')).status, 200);
    assert.deepStrictEqual((await mine(U.x1)).body.items, [], '有异议的修订不再待确认');
    const mCand = await addMember(s.pid, U.cand, { party: s.B.party });
    await sqlRun("UPDATE sysbuild_appointments SET status = 'ended', ended_at = '2026-10-20 10:00:00', end_reason = '更换' WHERE id = ?", [s.B.apt]);
    await addAppointment(s.B.party, mCand, 'active');
    const rr = await reissue(U.pm, s.T.bOwner.task_id, '更换负责人');
    assert.strictEqual(rr.status, 200, rr.text);
    assert.deepStrictEqual((await mine(U.cand)).body.items.map((i) => [i.revision_id, i.rev_no]), [[rr.body.revision.id, 2]]);
    // 撤回后全部失效，不再列
    assert.strictEqual((await withdraw(U.pm, s.pv, '整体撤回')).status, 200);
    assert.deepStrictEqual((await mine(U.cand)).body.items, []);
    assert.deepStrictEqual((await mine(U.del)).body.items, []);
    // 只读账号（仍可见）作为必需确认人被移出成员后不列
    const pid2 = await newProject();
    scope = [pid2];
    await seedParty(pid2, '丙部', U.ro, null);
    const pv2 = await mkVersion(await mkPackage(pid2, 'initiation'));
    await declareInitiationBasis(pv2);
    assert.strictEqual((await submit(U.pm, pv2)).status, 200);
    assert.strictEqual((await mine(U.ro)).body.items.length, 1);
    assert.strictEqual((await post(U.pm, `/sysbuild/members/${await memberRow(pid2, U.ro)}/remove`, { reason: '离项' })).status, 200);
    assert.deepStrictEqual((await mine(U.ro)).body.items, [], '成员已移出（只读账号仍可见项目）：不再列');
  });

  // ── C4a 修订批（P31–P41 与预筛 M1 / M2 / L2 / L3）──────────────────────────────────────────────────
  test('C4a 失资格（L2）：没有任职 / 授权依据的必需确认人（只读账号；夹具：把内容包任务的当前修订改成必需确认人 = 只读账号成员、依据清空）被移出项目后 decide 409——「已移出」检查单独可观察（没有依据检查可以兜住）；对照：移出前同样请求通过', async () => {
    // #212 C7：原夹具是只读账号作提出人的条目任务（没有依据）；条目没有了，改成直接写库造出同样「没有依据」的内容包任务修订（生产路径造不出：包任务的必需确认人总带任职 / 授权依据）
    const s = await mkSubmitted({ historicalLeaderTasks: true, single: true });
    const pid = s.pid;
    await addMember(pid, U.ro);
    const roMember = await memberRow(pid, U.ro);
    const noBasis = async (task) => {
      await sqlRun('UPDATE sysbuild_confirm_task_revisions SET required_member_id = ?, basis_appointment_id = NULL, basis_delegation_id = NULL WHERE id = ?', [roMember, task.rev_id]);
      return task.task_id;
    };
    const t1 = await noBasis(s.T.aOwner);
    const t2 = await noBasis(s.T.aDel);
    const o1 = await openTask(U.ro, t1);
    assert.deepStrictEqual([o1.status, o1.body.actions.decide], [200, true]);
    assert.strictEqual((await decideRaw(U.ro, t1, decideBodyOf(o1.body, 'confirm'))).status, 200, '对照：未移出时没有依据的任务可确认');
    const o2 = await openTask(U.ro, t2); // 移出前打开：浏览证据齐备，下面 409 不是因为没浏览
    assert.strictEqual((await post(U.pm, `/sysbuild/members/${roMember}/remove`, { reason: '离项' })).status, 200);
    const o2b = await openTask(U.ro, t2); // 只读账号被移出后仍可见
    assert.deepStrictEqual([o2b.status, o2b.body.actions.decide], [200, false]);
    const dr = await decideRaw(U.ro, t2, decideBodyOf(o2.body, 'confirm'));
    expectErr(dr, 409, 'SYSBUILD_STATE', '成员已移出');
    assert.ok(dr.body.message.includes('成员'), `提示实际 ${dr.body.message}`);
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_confirmations WHERE task_revision_id = (SELECT id FROM sysbuild_confirm_task_revisions WHERE task_id = ?)', [t2]), 0);
  });

  test('C4a 确认人解析与资格同源（M1，进程内）：负责人账号停用后——提交 409 缺现任领导；已有任务时改发 409 且 actions.reissue 为假、待我确认不列；账号恢复后全部恢复', async () => {
    // 真实实例的鉴权中间件会先拦下停用账号，users.status 只能在进程内夹具里改（登记残余）。返回 T.SKIP：runAll 打印「跳过（进程内专属）」并在汇总行另计跳过数，
    //   不把这条记成「通过」（修订批二 LOW-6）。
    if (!isInproc()) return T.SKIP;
    const setUser = (uid, st) => sqlRun('UPDATE users SET status = ? WHERE id = ?', [st, uid]);
    // 1 提交
    const d = await mkDraft();
    const initiation = await mkVersion(d.ini.pk);
    await declareInitiationBasis(initiation);
    await setUser(U.own, 'inactive');
    try {
      const r = await submit(U.pm, initiation);
      expectErr(r, 409, 'SYSBUILD_STATE', '立项领导账号停用');
      assert.ok(r.body.message.includes('甲部（缺现任领导）'), `提示实际 ${r.body.message}`);
      assert.strictEqual(await verStatus(initiation), 'draft');
      assert.strictEqual((await submit(U.pm, d.pv)).status, 200, '范围只核负责人，领导账号停用不拦');
    } finally { await setUser(U.own, 'active'); }
    assert.strictEqual((await submit(U.pm, initiation)).status, 200, '领导账号恢复后立项可提交');
    // 1b 代表人账号停用：总体规划包提交 409 缺生效负责人（立项包只要负责人，不受影响）
    const d2 = await mkDraft();
    await setUser(U.del, 'inactive');
    try {
      const r = await submit(U.pm, d2.pv);
      expectErr(r, 409, 'SYSBUILD_STATE', '代表人账号停用');
      assert.ok(r.body.message.includes('甲部（缺生效负责人）'), `提示实际 ${r.body.message}`);
    } finally { await setUser(U.del, 'active'); }
    assert.strictEqual((await submit(U.pm, d2.pv)).status, 200, '代表人账号恢复后提交通过');
    // 2 已有任务时停用负责人：改发不能生成同一个人的新修订
    const s = await mkSubmitted({ historicalLeaderTasks: true, single: true });
    const mineOf = async (uid) => (await get(uid, '/sysbuild/my/confirmations')).body.items.filter((i) => i.project_id === s.pid).map((i) => i.task_id);
    assert.deepStrictEqual(await mineOf(U.own), [s.T.aOwner.task_id]);
    await setUser(U.own, 'inactive');
    try {
      assert.strictEqual((await openTask(U.pm, s.T.aOwner.task_id)).body.actions.reissue, false, '解析不到可用负责人：改发标志为假');
      const rr = await reissue(U.pm, s.T.aOwner.task_id, '改发');
      expectErr(rr, 409, 'SYSBUILD_STATE', '停用的负责人不能再被改发成同一个人');
      assert.ok(rr.body.message.includes('没有现任领导'), `提示实际 ${rr.body.message}`);
      assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_confirm_task_revisions WHERE task_id = ?', [s.T.aOwner.task_id]), 1, '没有生成新修订');
      assert.deepStrictEqual(await mineOf(U.own), [], '账号停用：待我确认不列');
    } finally { await setUser(U.own, 'active'); }
    assert.deepStrictEqual(await mineOf(U.own), [s.T.aOwner.task_id], '账号恢复后重新列出');
    assert.strictEqual((await openTask(U.pm, s.T.aOwner.task_id)).body.actions.reissue, true);
  });

  test('C4a 待我确认（L3②）：只列此刻还能作出确认的修订——任职结束 / 授权撤销的都不列（项目已终止见 P38 用例），与 decide 同一个资格判定', async () => {
    const s = await mkSubmitted({ historicalLeaderTasks: true, single: true });
    const mineOf = async (uid) => (await get(uid, '/sysbuild/my/confirmations')).body.items.filter((i) => i.project_id === s.pid).map((i) => i.task_id);
    assert.deepStrictEqual([await mineOf(U.own), await mineOf(U.del)], [[s.T.aOwner.task_id], [s.T.aDel.task_id]]);
    await sqlRun("UPDATE sysbuild_appointments SET status = 'ended', ended_at = '2026-10-20 10:00:00', end_reason = '负责人更换' WHERE id = ?", [s.A.apt]);
    assert.deepStrictEqual([await mineOf(U.own), await mineOf(U.del)], [[], [s.T.aDel.task_id]], '任职结束：负责人的修订不再列');
    await sqlRun("UPDATE sysbuild_delegations SET status = 'revoked', revoked_at = '2026-10-20 10:00:00', revoke_reason = '更换' WHERE id = ?", [s.A.dlg]);
    assert.deepStrictEqual(await mineOf(U.del), [], '授权撤销：代表人的修订不再列');
  });

  // ── P34 总体排期基线来源 ──
  test('C4a P34：总体规划待确认期间本项目节点排期 / 取消节点一律 409（项目层与批次层、有计划与没计划一样），读接口 actions 同步；新增节点允许但新节点也不能设计划；只有总体规划待确认才冻结（立项包待确认、别的项目不受影响）；撤回后恢复', async () => {
    const MSG = '排期已随包冻结';
    const s = await mkSubmitted({
      prepare: async (pid) => {
        const p0 = (await get(U.pm, `/sysbuild/projects/${pid}/plan`)).body;
        const scope = p0.nodes.find((n) => n.template_key === 'p_overall');
        const r = await post(U.pm, `/sysbuild/nodes/${scope.id}/schedule`, { kind: 'plan', planned_start: '2026-11-02', planned_end: '2026-11-20' });
        assert.strictEqual(r.status, 201, r.text);
      },
    });
    const view = async () => (await get(U.pm, `/sysbuild/projects/${s.pid}/plan`)).body;
    const nodeOf = async (key) => (await view()).nodes.find((n) => n.template_key === key);
    const sched = (nid, a, b) => post(U.pm, `/sysbuild/nodes/${nid}/schedule`, { kind: 'plan', planned_start: a, planned_end: b });
    const dev = await nodeOf('b_dev');
    const overall = await nodeOf('p_overall');
    // 1 待确认期间：自己设过计划的（p_overall，草稿期改计划）与提交前由助手补齐计划的（b_dev）都 409（没有计划的节点见下面第 2 点：新增节点）；取消批次层节点 409
    const r1 = await sched(overall.id, '2026-11-03', '2026-11-21');
    expectErr(r1, 409, 'SYSBUILD_STATE', '项目层节点已有计划也不能改');
    assert.ok(r1.body.message.includes(MSG), `提示实际 ${r1.body.message}`);
    expectErr(await sched(dev.id, '2026-11-03', '2026-11-21'), 409, 'SYSBUILD_STATE', '批次层节点改计划');
    const rc = await post(U.pm, `/sysbuild/nodes/${dev.id}/cancel`, { reason: '想取消' });
    expectErr(rc, 409, 'SYSBUILD_STATE', '取消节点');
    assert.ok(rc.body.message.includes(MSG), `提示实际 ${rc.body.message}`);
    assert.strictEqual((await nodeOf('b_dev')).status, 'not_started');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_node_schedule_records WHERE node_id IN (?, ?)", [dev.id, overall.id]), 2, '被拒绝的写入不留记录（p_overall 与 b_dev 各只有提交前的那一条：H-1 之后 b_dev 的计划由提交前的补齐写入）');
    // 读接口 actions 同步：全部节点 schedule_plan 为假；b_dev（未开始、批次层）cancel 为假
    for (const n of (await view()).nodes) assert.strictEqual(n.actions.schedule_plan, false, `${n.template_key} 的 schedule_plan 标志`);
    assert.strictEqual((await nodeOf('b_dev')).actions.cancel, false);
    // 2 新增节点允许；新节点（没有计划）也不能设计划，也不进基线
    const addNode = await post(U.pm, `/sysbuild/batches/${s.batch}/nodes`, { name: '待确认期间新增的节点' });
    assert.strictEqual(addNode.status, 201, addNode.text);
    expectErr(await sched(addNode.body.node.id, '2026-11-03', '2026-11-04'), 409, 'SYSBUILD_STATE', '新增节点也不能设计划');
    assert.strictEqual(addNode.body.node.actions.schedule_plan, false);
    // 3 只有总体规划待确认才冻结：立项包待确认的项目不冻结；别的项目不受影响
    const pidI = await newProject();
    await seedParty(pidI, '甲部', U.own, null);
    const pkI = await mkPackage(pidI, 'initiation');
    const preparedInitiation = await mkVersion(pkI);
    await declareInitiationBasis(preparedInitiation);
    assert.strictEqual((await submit(U.pm, preparedInitiation)).status, 200);
    const nodeI = (await get(U.pm, `/sysbuild/projects/${pidI}/plan`)).body.nodes.find((n) => n.template_key === 'b_dev').id;
    assert.strictEqual((await sched(nodeI, '2026-11-03', '2026-11-04')).status, 201, '立项包待确认不冻结排期');
    const nodeO = (await get(U.pm, `/sysbuild/projects/${(await newProject())}/plan`)).body.nodes.find((n) => n.template_key === 'b_dev').id;
    assert.strictEqual((await sched(nodeO, '2026-11-03', '2026-11-04')).status, 201, '别的项目不受影响');
    // 4 撤回后恢复
    assert.strictEqual((await withdraw(U.pm, s.pv, '要改排期')).status, 200);
    assert.strictEqual((await sched(dev.id, '2026-11-03', '2026-11-21')).status, 201);
    assert.strictEqual((await nodeOf('b_dev')).actions.schedule_plan, true);
    assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${addNode.body.node.id}/cancel`, { reason: '不要了' })).status, 200, '撤回后可取消节点');
  });

  test('C4a P34：生效时形成的基线与提交事件里记录的节点计划逐项核对，不一致 fail-closed（500 SYSBUILD_INTERNAL，整个生效事务回滚，最后一条确认也随之回滚）；记录缺失同样；恢复一致后可生效', async () => {
    const s = await mkSubmitted({
      single: true,
      prepare: async (pid) => {
        const p0 = (await get(U.pm, `/sysbuild/projects/${pid}/plan`)).body;
        const r = await post(U.pm, `/sysbuild/nodes/${p0.nodes.find((n) => n.template_key === 'p_closing').id}/schedule`, { kind: 'plan', planned_start: '2026-11-02', planned_end: '2026-11-30' });
        assert.strictEqual(r.status, 201, r.text);
      },
    });
    const plan0 = (await get(U.pm, `/sysbuild/projects/${s.pid}/plan`)).body;
    const overallId = plan0.nodes.find((n) => n.template_key === 'p_closing').id;
    // 除最后一条外全部确认
    const ts = await tasksOf(s.pv);
    const last = ts[ts.length - 1];
    for (const t of ts.slice(0, -1)) assert.strictEqual((await openAndDecide(t.user_id, t.task_id, 'confirm')).status, 200);
    const opened = await openTask(last.user_id, last.task_id);
    assert.strictEqual(opened.status, 200, opened.text);
    const tryLast = () => decideRaw(last.user_id, last.task_id, decideBodyOf(opened.body, 'confirm'));
    const expectBlocked = async (label) => {
      const r = await tryLast();
      expectErr(r, 500, 'SYSBUILD_INTERNAL', label);
      assert.strictEqual(r.body.message, '范围确认计划快照无法核对');
      assert.strictEqual(await verStatus(s.pv), 'pending', `${label}：版本仍待确认`);
      assert.strictEqual((await revOf(last.rev_id)).status, 'pending', `${label}：最后一条确认随事务回滚`);
      assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_confirmations WHERE task_revision_id = ?', [last.rev_id]), 0);
      assert.strictEqual(await baselineCount(s.pid), 0, `${label}：没有基线`);
      assert.strictEqual((await rowOf('sysbuild_batches', s.batch)).status, 'planning', `${label}：批次状态推进随生效事务一起回滚（M-1）`);
    };
    // 1 提交之后新增的节点有了计划（夹具：直接写库，正常路径被 P34 挡住；新增节点在待确认期间允许）：提交时没有它的记录 → 不一致
    const extra = await post(U.pm, `/sysbuild/batches/${s.batch}/nodes`, { name: '提交后新增的节点' });
    assert.strictEqual(extra.status, 201, extra.text);
    const tamper1 = (await sqlRun("INSERT INTO sysbuild_node_schedule_records (node_id, kind, planned_start, planned_end, reason, created_by) VALUES (?, 'plan_change', '2026-11-05', '2026-11-06', '夹具', ?)", [extra.body.node.id, U.pm])).lastID;
    assert.ok(tamper1 > 0, '提交之后新增的普通节点有计划，仍不属于职责范围');
    // 2 提交时有计划的节点之后计划被改（夹具）：日期不同 → 不一致
    const tamper2 = (await sqlRun("INSERT INTO sysbuild_node_schedule_records (node_id, kind, planned_start, planned_end, reason, created_by) VALUES (?, 'plan_change', '2026-11-03', '2026-11-30', '夹具', ?)", [overallId, U.pm])).lastID;
    await expectBlocked('职责节点提交后计划日期被改');
    await sqlRun('DELETE FROM sysbuild_node_schedule_records WHERE id = ?', [tamper2]);
    // 3 提交事件里没有节点计划记录（夹具：清空事件 payload）：无法核对 → 不形成基线
    const evRow = await sqlGet("SELECT id, payload_json FROM sysbuild_events WHERE project_id = ? AND event_type = 'package_version_submitted'", [s.pid]);
    const payload = JSON.parse(evRow.payload_json);
    payload.node_plans.push({ ...payload.node_plans[0], node_id: extra.body.node.id });
    await sqlRun('UPDATE sysbuild_events SET payload_json = ? WHERE id = ?', [JSON.stringify(payload), evRow.id]);
    await expectBlocked('提交快照多出非职责节点');
    await sqlRun("UPDATE sysbuild_events SET payload_json = '{}' WHERE id = ?", [evRow.id]);
    expectErr(await openTask(last.user_id, last.task_id), 500, 'SYSBUILD_INTERNAL', '读确认页同样拒绝缺失快照');
    await expectBlocked('提交事件缺记录');
    await sqlRun('UPDATE sysbuild_events SET payload_json = ? WHERE id = ?', [evRow.payload_json, evRow.id]);
    // 4 恢复一致：最后一条确认后生效，基线 = 提交时记录的计划
    const ok = await tryLast();
    assert.strictEqual(ok.status, 200, ok.text);
    assert.strictEqual(ok.body.effective, true);
    assert.deepStrictEqual((await baselinesIn(s.pid)).map((b) => [b.node_id, b.planned_start, b.planned_end]), (await inhouseNodePlans(s.pid)).map((x) => [x.node_id, x.planned_start, x.planned_end]), '基线按提交时记录的节点计划形成，提交后新增节点没有基线');
    assert.ok((await baselinesIn(s.pid)).some((b) => b.node_id === overallId));
    assert.strictEqual((await rowOf('sysbuild_batches', s.batch)).status, 'active', '恢复一致后生效，批次同事务推进到进行中（M-1）');
  });

  test('C4a 生效 LOW-1 / LOW-2：formBaselines 双向核对——提交记录里的节点生效时既没有基线、又不会形成基线（已取消 / 当前计划没了）→ 500 整体回滚，恢复后可生效；同一提交已有的基线不重复写', async () => {
    // 反向（LOW-1）：提交时有计划的节点，生效时若既没有基线、又不会形成基线 → 500
    const s = await mkSubmitted({
      single: true,
      prepare: async (pid) => {
        const p0 = (await get(U.pm, `/sysbuild/projects/${pid}/plan`)).body;
        const r = await post(U.pm, `/sysbuild/nodes/${p0.nodes.find((n) => n.template_key === 'p_closing').id}/schedule`, { kind: 'plan', planned_start: '2026-11-02', planned_end: '2026-11-30' });
        assert.strictEqual(r.status, 201, r.text);
      },
    });
    const overallId = (await get(U.pm, `/sysbuild/projects/${s.pid}/plan`)).body.nodes.find((n) => n.template_key === 'p_closing').id;
    assert.deepStrictEqual((await payloads(s.pid, 'package_version_submitted'))[0].node_plans, await inhouseNodePlans(s.pid), 'H-1：提交事件记录全部自研节点的计划');
    const ts = await tasksOf(s.pv);
    const last = ts[ts.length - 1];
    for (const t of ts.slice(0, -1)) assert.strictEqual((await openAndDecide(t.user_id, t.task_id, 'confirm')).status, 200);
    const opened = await openTask(last.user_id, last.task_id);
    assert.strictEqual(opened.status, 200, opened.text);
    const tryLast = () => decideRaw(last.user_id, last.task_id, decideBodyOf(opened.body, 'confirm'));
    const expectBlocked = async (label) => {
      const r = await tryLast();
      expectErr(r, 500, 'SYSBUILD_INTERNAL', label);
      assert.strictEqual(r.body.message, '范围确认计划快照无法核对');
      assert.strictEqual(await verStatus(s.pv), 'pending', `${label}：版本仍待确认`);
      assert.strictEqual((await revOf(last.rev_id)).status, 'pending', `${label}：最后一条确认随事务回滚`);
      assert.strictEqual(await baselineCount(s.pid), 0, `${label}：没有基线`);
    };
    // 1 节点已取消（夹具：正常路径被 P34 挡住）
    await sqlRun("UPDATE sysbuild_nodes SET status = 'cancelled' WHERE id = ?", [overallId]);
    await expectBlocked('提交记录里的节点已取消');
    await sqlRun("UPDATE sysbuild_nodes SET status = 'not_started' WHERE id = ?", [overallId]);
    // 2 当前计划没了（夹具：删掉那条计划记录；提交时的记录还在）
    const planRow = await sqlGet("SELECT * FROM sysbuild_node_schedule_records WHERE node_id = ? AND kind = 'plan_change'", [overallId]);
    await sqlRun('DELETE FROM sysbuild_node_schedule_records WHERE id = ?', [planRow.id]);
    await expectBlocked('提交记录里的节点当前计划没了');
    await sqlRun(
      'INSERT INTO sysbuild_node_schedule_records (node_id, kind, planned_start, planned_end, reason, no_written_evidence, no_evidence_reason, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [planRow.node_id, planRow.kind, planRow.planned_start, planRow.planned_end, planRow.reason, planRow.no_written_evidence, planRow.no_evidence_reason, planRow.created_by]
    );
    // 3 恢复后可生效：基线 = 提交时记录的计划
    const ok = await tryLast();
    assert.strictEqual(ok.status, 200, ok.text);
    assert.deepStrictEqual([ok.body.effective, ok.body.baseline_node_ids], [true, (await inhouseNodePlans(s.pid)).map((x) => x.node_id)]);
    assert.ok(ok.body.baseline_node_ids.includes(overallId));
    // 同一提交已有两条一致的基线时，仍需完整快照，生效不会重复写。
    const s2 = await mkSubmitted({ single: true });
    for (const entry of await inhouseNodePlans(s2.pid)) {
      await sqlRun("INSERT INTO sysbuild_node_schedule_records (node_id, kind, planned_start, planned_end, package_version_id, created_by) VALUES (?, 'baseline', ?, ?, ?, ?)", [entry.node_id, PLAN_START, PLAN_END, s2.pv, U.pm]);
    }
    const fin2 = await confirmAll(s2.pv);
    assert.deepStrictEqual([fin2.body.effective, fin2.body.baseline_node_ids], [true, []]);
    assert.strictEqual(await verStatus(s2.pv), 'effective');
    assert.strictEqual(await baselineCount(s2.pid), 2);
  });

  // ── P35 提交后新增需求部门 ──
  test('C4a P35：本项目有待确认的立项包 / 总体规划包时新建需求部门参与方 409，开发方不受影响；读接口 actions.party_sides 同步；撤回 / 生效后恢复', async () => {
    const MSG = '有待确认的内容包';
    await mkSubmitted({ single: true }); // 兄弟项目有一直待确认的总体规划包：只看本项目（过滤模式下用例单独运行，库里没有别的数据）
    const s = await mkSubmitted({ single: true });
    const mk = (uid, side, name) => post(uid, `/sysbuild/projects/${s.pid}/parties`, {
      side, name, leader_user_id: side === 'dev' ? U.cand : U.fixtureLeader, representative_user_id: side === 'dev' ? null : U.fixtureRepresentative,
    });
    const sides = async () => (await get(U.pm, `/sysbuild/projects/${s.pid}`)).body.actions.party_sides;
    assert.deepStrictEqual(await sides(), ['dev'], '待确认期间只剩开发方可建');
    const blocked = await mk(U.pm, 'demand', '暂不能新增的需求部门');
    expectErr(blocked, 409, 'SYSBUILD_STATE', 'PM 建需求部门');
    assert.ok(blocked.body.message.includes(MSG), `提示实际 ${blocked.body.message}`);
    expectErr(await mk(U.admin, 'demand', '管理员未接管'), 403, 'SYSBUILD_FORBIDDEN');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_parties WHERE project_id = ? AND side = 'demand'", [s.pid]), 1, '被拒绝的不新增参与方');
    const dev = await mk(U.pm, 'dev', '开发方');
    assert.strictEqual(dev.status, 201, '开发方不受影响');
    assert.deepStrictEqual(await sides(), [], '开发方已有、需求方被挡');
    // 撤回后恢复
    assert.strictEqual((await withdraw(U.pm, s.pv, '要加需求部门')).status, 200);
    assert.deepStrictEqual(await sides(), ['demand']);
    assert.strictEqual((await mk(U.pm, 'demand', '新需求部')).status, 201);
    // 立项包待确认同样挡；生效后不挡
    const pid = await newProject();
    await seedParty(pid, '甲部', U.own, null);
    const pkI = await mkPackage(pid, 'initiation');
    const iv = await mkVersion(pkI);
    await declareInitiationBasis(iv);
    assert.strictEqual((await submit(U.pm, iv)).status, 200);
    const newDemand = { side: 'demand', name: '乙部', leader_user_id: U.fixtureLeader, representative_user_id: U.fixtureRepresentative };
    expectErr(await post(U.pm, `/sysbuild/projects/${pid}/parties`, newDemand), 409, 'SYSBUILD_STATE', '立项包待确认');
    await confirmAll(iv);
    assert.strictEqual(await verStatus(iv), 'effective');
    assert.strictEqual((await post(U.pm, `/sysbuild/projects/${pid}/parties`, newDemand)).status, 201, '立项包已生效：不再挡');
  });

  // ── P36 同一人两种身份 ──
  test('C4a P36：改发时新人已在本版本、同一参与方的另一类任务上确认 409（负责人 ⇄ 代表人两个方向，标志同步为假），已确认的修订保持有效；换第三人可改发；生效判定兜底——同一参与方两条任务确认人是同一用户则不生效', async () => {
    // 方向一：负责人任务改发给已确认了代表人任务的人
    const s = await mkSubmitted({ historicalLeaderTasks: true, single: true });
    assert.strictEqual((await openAndDecide(U.del, s.T.aDel.task_id, 'confirm')).status, 200); // 代表人先确认（已确认的修订保持有效）
    assert.strictEqual((await openAndDecide(U.own, s.T.aOwner.task_id, 'object')).status, 200);
    await sqlRun("UPDATE sysbuild_appointments SET status = 'ended', ended_at = '2026-10-20 10:00:00', end_reason = '换人' WHERE id = ?", [s.A.apt]);
    const aptDel = await addAppointment(s.A.party, s.A.mDel, 'active'); // 夹具：代表人的成员行出任现任负责人
    assert.strictEqual((await openTask(U.pm, s.T.aOwner.task_id)).body.actions.reissue, false, '解析出的新人已确认过另一类任务：改发标志为假');
    const r1 = await reissue(U.pm, s.T.aOwner.task_id, '改发给代表人');
    expectErr(r1, 409, 'SYSBUILD_STATE', '同一人两种身份');
    assert.ok(r1.body.message.includes('同一人不能在本版本同时以领导和负责人身份确认'), `提示实际 ${r1.body.message}`);
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_confirm_task_revisions WHERE task_id = ?', [s.T.aOwner.task_id]), 1, '没有新修订');
    assert.strictEqual((await revOf(s.T.aDel.rev_id)).status, 'confirmed', '已确认的修订保持有效');
    // 对照：负责人换成第三人 → 可改发
    await sqlRun("UPDATE sysbuild_appointments SET status = 'ended', ended_at = '2026-10-21 10:00:00', end_reason = '再换人' WHERE id = ?", [aptDel]);
    const mCand = await addMember(s.pid, U.cand, { party: s.A.party });
    await addAppointment(s.A.party, mCand, 'active');
    assert.strictEqual((await openTask(U.pm, s.T.aOwner.task_id)).body.actions.reissue, true);
    const ok1 = await reissue(U.pm, s.T.aOwner.task_id, '改发给第三人');
    assert.strictEqual(ok1.status, 200, ok1.text);
    // 方向二：代表人任务改发给已确认了负责人任务的人
    const s2 = await mkSubmitted({ historicalLeaderTasks: true, single: true });
    assert.strictEqual((await openAndDecide(U.own, s2.T.aOwner.task_id, 'confirm')).status, 200);
    assert.strictEqual((await openAndDecide(U.del, s2.T.aDel.task_id, 'object')).status, 200);
    await sqlRun("UPDATE sysbuild_delegations SET status = 'revoked', revoked_at = '2026-10-20 10:00:00', revoke_reason = '换人' WHERE id = ?", [s2.A.dlg]);
    await addDelegation(s2.A.party, s2.A.mOwn, s2.A.apt, 'active'); // 夹具：负责人本人被授权为代表人
    assert.strictEqual((await openTask(U.pm, s2.T.aDel.task_id)).body.actions.reissue, false);
    const r2 = await reissue(U.pm, s2.T.aDel.task_id, '改发给负责人');
    expectErr(r2, 409, 'SYSBUILD_STATE', '同一人两种身份（反方向）');
    assert.ok(r2.body.message.includes('同一人'), `提示实际 ${r2.body.message}`);
    // 只有「已确认」才算：另一类任务只是待确认（还没确认）时，同一个人被改发过来不被 P36 挡（之后若两条都由他确认，由生效判定兜底不生效）
    const s4 = await mkSubmitted({ historicalLeaderTasks: true, single: true });
    assert.strictEqual((await openAndDecide(U.own, s4.T.aOwner.task_id, 'object')).status, 200);
    await sqlRun("UPDATE sysbuild_appointments SET status = 'ended', ended_at = '2026-10-20 10:00:00', end_reason = '换人' WHERE id = ?", [s4.A.apt]);
    await addAppointment(s4.A.party, s4.A.mDel, 'active');
    assert.strictEqual((await openTask(U.pm, s4.T.aOwner.task_id)).body.actions.reissue, true, '代表人任务只是待确认：不算冲突');
    assert.strictEqual((await reissue(U.pm, s4.T.aOwner.task_id, '改发给代表人')).status, 200);
    // 生效判定兜底：夹具让负责人 own 同时是本方代表人任务的必需确认人（正常路径被上面的改发拦下），两条都确认也不生效
    const s3 = await mkSubmitted({ historicalLeaderTasks: true, single: true });
    await sqlRun('UPDATE sysbuild_delegations SET member_id = ? WHERE id = ?', [s3.A.mOwn, s3.A.dlg]);
    await sqlRun('UPDATE sysbuild_confirm_task_revisions SET required_member_id = ? WHERE id = ?', [s3.A.mOwn, s3.T.aDel.rev_id]);
    const f1 = await openAndDecide(U.own, s3.T.aOwner.task_id, 'confirm');
    assert.deepStrictEqual([f1.status, f1.body.effective], [200, false]);
    const f2 = await openAndDecide(U.own, s3.T.aDel.task_id, 'confirm');
    assert.strictEqual(f2.status, 200, f2.text);
    assert.deepStrictEqual([f2.body.effective, f2.body.version.status], [false, 'pending'], '同一用户确认了本方两条任务：不生效');
    assert.strictEqual(await verStatus(s3.pv), 'pending');
    assert.strictEqual(await baselineCount(s3.pid), 0);
  });

  // ── P38 终止项目 ──
  test('C4a P38：终止项目——同一事务里本项目全部待确认修订（内容包任务）置已失效（原因「项目已终止」），已确认的不动，各写事件；已终止项目的待确认修订不在待我确认里；重开后 PM 可改发已失效的修订并走完确认生效', async () => {
    const s = await mkSubmitted({ historicalLeaderTasks: true, single: true });
    const other = await mkSubmitted({ historicalLeaderTasks: true, single: true }); // 另一个项目的待确认修订：终止本项目不得波及
    assert.strictEqual((await openTask(U.del, s.T.aDel.task_id)).status, 200, '必需确认人 del 先有浏览记录（让夹具贴近真实顺序；下面「已终止且修订已失效」一格的 409 SYSBUILD_PROJECT_READONLY 来自 assertOp，先于 NOT_VIEWED 校验，有没有浏览记录都不影响该格结果）');
    assert.strictEqual((await openAndDecide(U.own, s.T.aOwner.task_id, 'confirm')).status, 200);
    assert.strictEqual((await setStatus(s.pid, 'terminated')).status, 200);
    assert.deepStrictEqual([(await revOf(other.T.aOwner.rev_id)).status, (await revOf(other.T.aDel.rev_id)).status], ['pending', 'pending'], '别的项目的待确认修订不受影响');
    const own = await revOf(s.T.aOwner.rev_id);
    assert.deepStrictEqual([own.status, own.status_reason], ['confirmed', null], '已确认的修订不动');
    for (const rid of [s.T.aDel.rev_id]) {
      const rv = await revOf(rid);
      assert.deepStrictEqual([rv.status, rv.status_reason], ['invalid', '项目已终止'], `修订 ${rid}`);
    }
    assert.deepStrictEqual(await payloads(s.pid, 'confirm_revision_invalidated'), [
      { revision_id: s.T.aDel.rev_id, object_type: 'package_version', object_version_id: s.pv, reason: '项目已终止' },
    ]);
    assert.strictEqual(await verStatus(s.pv), 'pending', '版本本身不动（等重开后继续）');
    // C6 补格（接替整删的 devkey.js:259 用例的 :273，附录 C devkey:259:273）：项目已终止且修订已失效时，必需确认人用该修订号提交决策 → 项目状态先于对象状态（rules.js checkOp：can → 项目状态 → state）409 SYSBUILD_PROJECT_READONLY，且不新增确认记录
    const confRows = () => countOf("SELECT COUNT(*) AS n FROM sysbuild_confirmations WHERE object_type = 'package_version' AND object_version_id = ?", [s.pv]);
    const confBefore = await confRows();
    expectErr(await decideRaw(U.del, s.T.aDel.task_id, { revision_id: s.T.aDel.rev_id, object_version_id: s.pv, decision: 'confirm', checkbox_text: CHECKBOX }), 409, 'SYSBUILD_PROJECT_READONLY', '已终止且修订已失效：项目状态先于对象状态');
    assert.strictEqual(await confRows(), confBefore, '被拒的决策不新增确认记录');
    // 待我确认：已终止项目的待确认修订不列（夹具：把一条修订改回待确认，只靠项目状态过滤挡住）
    const mineOf = async (uid) => (await get(uid, '/sysbuild/my/confirmations')).body.items.filter((i) => i.project_id === s.pid).map((i) => i.task_id);
    await sqlRun("UPDATE sysbuild_confirm_task_revisions SET status = 'pending', status_reason = NULL WHERE id = ?", [s.T.aDel.rev_id]);
    assert.deepStrictEqual(await mineOf(U.del), [], '已终止项目：待确认修订不在待我确认里');
    await sqlRun("UPDATE sysbuild_confirm_task_revisions SET status = 'invalid', status_reason = '项目已终止' WHERE id = ?", [s.T.aDel.rev_id]);
    // 已终止时改发 409（项目状态）；重开后已失效的修订可改发
    expectErr(await reissue(U.pm, s.T.aDel.task_id, '终止期改发'), 409, 'SYSBUILD_PROJECT_READONLY', '已终止');
    assert.strictEqual((await setStatus(s.pid, 'active')).status, 200);
    assert.strictEqual((await openTask(U.pm, s.T.aDel.task_id)).body.actions.reissue, true, '重开后已失效的修订可改发');
    const rr = await reissue(U.pm, s.T.aDel.task_id, '项目重开，重新请代表人确认');
    assert.strictEqual(rr.status, 200, rr.text);
    assert.deepStrictEqual([rr.body.revision.rev_no, rr.body.revision.status], [2, 'pending']);
    assert.strictEqual(rr.body.revision.required_member_id, (await revOf(s.T.aDel.rev_id)).required_member_id, '重开后改发：新修订的必需确认人仍是原代表人（接替 devkey.js:259 的 :279，附录 C devkey:259:279）');
    assert.strictEqual((await revOf(s.T.aDel.rev_id)).status, 'invalid', '旧的已失效修订保持原状');
    assert.deepStrictEqual(await mineOf(U.del), [s.T.aDel.task_id]);
    const fin = await openAndDecide(U.del, s.T.aDel.task_id, 'confirm');
    assert.strictEqual(fin.status, 200, fin.text);
    assert.strictEqual(fin.body.effective, true, '重开后改发并确认，内容包生效');
    // 暂停不失效：暂停 → 恢复后待确认修订照旧
    const s2 = await mkSubmitted({ historicalLeaderTasks: true, single: true });
    assert.strictEqual((await setStatus(s2.pid, 'paused')).status, 200);
    assert.strictEqual((await revOf(s2.T.aOwner.rev_id)).status, 'pending', '暂停不失效待确认修订');
  });

  // H1：结记普通阶段不改变原有关口是否已经确认。
  test('C4a 普通阶段先完成，之后仍能独立发起原有关口', async () => {
    const pid = await newProject('outsource');
    const view = (await get(U.pm, `/sysbuild/projects/${pid}/plan`)).body;
    for (const key of ['p_initiation', 'p_overall', 'b_uat']) {
      const node = view.nodes.find((item) => item.template_key === key);
      assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${node.id}/start`)).status, 200);
      assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${node.id}/close`)).status, 200);
    }
    assert.strictEqual((await sqlGet('SELECT count(*) AS n FROM sysbuild_packages WHERE project_id = ?', [pid])).n, 0, '完成普通阶段没有伪造生效内容包');
    await H.produceEffectiveOverall(pid);
    await H.acceptEffective(pid, await defaultBatchId(pid));
    const final = (await get(U.pm, `/sysbuild/projects/${pid}/plan`)).body;
    for (const key of ['p_initiation', 'p_overall', 'b_uat']) assert.strictEqual(final.nodes.find((node) => node.template_key === key).status, 'closed');
  });

  // ── H-1 读接口信号（M2 → 修订批三改为 draft / reschedule 两态 + has_baseline）──
  test('C4a H-1 读接口信号：范围生效与阶段既有计划决定首排或改期，与写入一致', async () => {
    const pid = await newProject();
    const viewOf = async () => (await get(U.pm, `/sysbuild/projects/${pid}/plan`)).body.nodes;
    const modeOf = async (key) => { const n = (await viewOf()).find((x) => x.template_key === key); return [n.plan_write_mode, n.has_baseline]; };
    const idOf = async (key) => (await viewOf()).find((n) => n.template_key === key).id;
    assert.deepStrictEqual([...new Set((await viewOf()).map((n) => `${n.plan_write_mode}/${n.has_baseline}`))], ['draft/false'], '没有生效的总体规划：全部节点 draft、无基线');
    const overall = await idOf('p_overall');
    assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${overall}/schedule`, { kind: 'plan', planned_start: '2026-11-02', planned_end: '2026-11-30' })).status, 201);
    assert.deepStrictEqual(await modeOf('p_overall'), ['draft', false], '草稿期计划之后仍是 draft（还没有基线）');
    assert.deepStrictEqual((await recordsKinds(overall)), ['plan_change'], 'draft 的落点 = 草稿期计划');
    await H.produceEffectiveOverall(pid);
    assert.deepStrictEqual(await modeOf('p_closing'), ['reschedule', true], '职责节点生效后有基线并使用改期');
    assert.deepStrictEqual(await modeOf('p_overall'), ['reschedule', false], '非职责节点保留改期方式但没有基线');
    assert.deepStrictEqual(await modeOf('p_closing'), ['reschedule', true]);
    // 生效后新增的节点尚无基线和计划，先首排。
    const added = await post(U.pm, `/sysbuild/batches/${await defaultBatchId(pid)}/nodes`, { name: '生效后新增' });
    assert.strictEqual(added.status, 201, added.text);
    assert.deepStrictEqual([added.body.node.plan_write_mode, added.body.node.has_baseline], ['draft', false]);
    const w1 = await post(U.pm, `/sysbuild/nodes/${added.body.node.id}/schedule`, { kind: 'plan', planned_start: '2027-01-04', planned_end: '2027-01-15' });
    assert.strictEqual(w1.status, 201, w1.text);
    assert.deepStrictEqual(await recordsKinds(added.body.node.id), ['plan_change']);
    assert.deepStrictEqual([w1.body.node.plan_write_mode, w1.body.node.has_baseline], ['reschedule', false]);
    const w2 = await post(U.pm, `/sysbuild/nodes/${added.body.node.id}/schedule`, { kind: 'plan', planned_start: '2027-01-04', planned_end: '2027-01-16' });
    expectErr(w2, 400, 'SYSBUILD_INVALID_INPUT', '读接口改期提示与同节点写入一致');
    assert.strictEqual(w2.body.field, 'reason');
    assert.deepStrictEqual(await recordsKinds(added.body.node.id), ['plan_change']);
    assert.deepStrictEqual(await modeOf('p_overall'), ['reschedule', false]);
    // 别的项目没有生效的总体规划：不被带出（读写两端都读 effectiveOverallVersionId，同一来源）
    const other = await newProject();
    assert.deepStrictEqual([...new Set((await get(U.pm, `/sysbuild/projects/${other}/plan`)).body.nodes.map((n) => `${n.plan_write_mode}/${n.has_baseline}`))], ['draft/false']);
    // 已有基线的节点改期落点
    const closing = await idOf('p_closing');
    const rs = await post(U.pm, `/sysbuild/nodes/${closing}/schedule`, Object.assign({ kind: 'plan', planned_start: '2027-01-05', planned_end: '2027-01-20' }, { reason: '客户要求延期', no_written_evidence: true, no_evidence_reason: '电话沟通后已确认延期事宜' }));
    assert.strictEqual(rs.status, 201, rs.text);
    assert.deepStrictEqual(await recordsKinds(closing), ['plan_change', 'baseline', 'plan_change'], 'reschedule 的落点 = 改期记录（草稿期计划 → 生效时的基线 → 改期）');
  });

  // ── actions 与执行一致 ──────────────────────────────────────────────────────────────────────────────
  test('C4a actions 与执行一致：submit 标志承诺权限、对象状态、立项前置、确认人齐全、计划齐全；withdraw / decide / reissue 标志为真则执行 2xx，为假则执行非 2xx（草稿 / 待确认 / 已确认各状态，PM / 成员 / 必需确认人各身份）', async () => {
    const d = await mkDraft();
    await seedParty(d.pid, '乙部', U.x1, U.x2); // 甲部确认后仍有待确认部门，可以继续核撤回。
    await addMember(d.pid, U.m1);
    const flagsOfVersion = async (uid, vid) => (await get(uid, `/sysbuild/package-versions/${vid}`)).body.actions;
    // 草稿：PM submit 真 / withdraw 假；一般成员都假
    let f = await flagsOfVersion(U.pm, d.pv);
    assert.deepStrictEqual([f.submit, f.withdraw], [true, false]);
    assert.ok((await withdraw(U.pm, d.pv, '草稿撤回')).status >= 400, 'withdraw 标志为假，执行应失败');
    f = await flagsOfVersion(U.m1, d.pv);
    assert.deepStrictEqual([f.submit, f.withdraw], [false, false]);
    assert.ok((await submit(U.m1, d.pv)).status >= 400, '一般成员 submit 标志为假');
    const sub = await submit(U.pm, d.pv);
    assert.ok(sub.status >= 200 && sub.status < 300, `submit 标志为真，执行应成功: ${sub.text}`);
    // 待确认：submit 假 / withdraw 真
    f = await flagsOfVersion(U.pm, d.pv);
    assert.deepStrictEqual([f.submit, f.withdraw], [false, true]);
    assert.ok((await submit(U.pm, d.pv)).status >= 400, '待确认版本 submit 标志为假');
    // 任务：必需确认人 decide 真 / reissue 假；PM decide 假 / reissue 真
    const [t] = await tasksOf(d.pv);
    const tid = t.task_id;
    const confirmerFlags = (await openTask(U.del, tid)).body.actions;
    assert.deepStrictEqual(confirmerFlags, { decide: true, decide_mode: 'self', reissue: false, export_sheet: true });
    const pmFlags = (await openTask(U.pm, tid)).body.actions;
    assert.deepStrictEqual(pmFlags, { decide: false, decide_mode: null, reissue: true, export_sheet: true });
    const o = await openTask(U.del, tid);
    assert.ok((await reissue(U.del, tid, '本人改发')).status >= 400, '必需确认人 reissue 标志为假');
    assert.ok((await decideRaw(U.pm, tid, decideBodyOf(o.body, 'confirm'))).status >= 400, 'PM decide 标志为假');
    const dec = await decideRaw(U.del, tid, decideBodyOf(o.body, 'confirm'));
    assert.ok(dec.status >= 200 && dec.status < 300, `decide 标志为真，执行应成功: ${dec.text}`);
    // 已确认：decide 假 / reissue 假（当前修订已确认）
    const after = (await openTask(U.del, tid)).body.actions;
    assert.deepStrictEqual(after, { decide: false, decide_mode: null, reissue: false, export_sheet: true });
    assert.ok((await decideRaw(U.del, tid, decideBodyOf(o.body, 'confirm'))).status >= 400, '已确认 decide 标志为假');
    assert.ok((await reissue(U.pm, tid, '已确认再改发')).status >= 400, '已确认 reissue 标志为假');
    // 待确认版本 withdraw 真 → 执行成功后标志全假
    const wd = await withdraw(U.pm, d.pv, '撤回');
    assert.ok(wd.status >= 200 && wd.status < 300, `withdraw 标志为真，执行应成功: ${wd.text}`);
    f = await flagsOfVersion(U.pm, d.pv);
    assert.deepStrictEqual([f.submit, f.withdraw], [false, false]);
    // 反例：改发为真 → 执行 2xx（不认可的修订）
    const s = await mkSubmitted({ historicalLeaderTasks: true, single: true });
    assert.strictEqual((await openAndDecide(U.own, s.T.aOwner.task_id, 'reject')).status, 200);
    assert.strictEqual((await openTask(U.pm, s.T.aOwner.task_id)).body.actions.reissue, true);
    const ri = await reissue(U.pm, s.T.aOwner.task_id, '重新请对方确认');
    assert.ok(ri.status >= 200 && ri.status < 300, `reissue 标志为真，执行应成功: ${ri.text}`);
    // 已终止项目：所有标志为假，执行 409
    assert.strictEqual((await setStatus(s.pid, 'terminated')).status, 200);
    const tf = (await openTask(U.pm, s.T.aOwner.task_id)).body.actions;
    assert.deepStrictEqual(tf, { decide: false, decide_mode: null, reissue: false, export_sheet: true });
    const vf = await flagsOfVersion(U.pm, s.pv);
    assert.deepStrictEqual([vf.submit, vf.withdraw], [false, false]);
    assert.ok((await withdraw(U.pm, s.pv, '终止后撤回')).status >= 400);
    // L3①：改发要先解析出可作为确认人的新负责人 / 代表人——解析不到时标志为假、执行 409（同一判定，不再「标志为真执行 409」）
    const s2 = await mkSubmitted({ historicalLeaderTasks: true, single: true });
    assert.strictEqual((await openTask(U.pm, s2.T.aOwner.task_id)).body.actions.reissue, true, '有现任负责人：改发标志为真');
    await sqlRun("UPDATE sysbuild_appointments SET status = 'ended', ended_at = '2026-10-20 10:00:00', end_reason = '离任' WHERE id = ?", [s2.A.apt]);
    assert.strictEqual((await openTask(U.pm, s2.T.aOwner.task_id)).body.actions.reissue, false, '没有现任负责人：改发标志为假');
    const none = await reissue(U.pm, s2.T.aOwner.task_id, '改发');
    assert.ok(none.status >= 400, '标志为假，执行应失败');
    assert.strictEqual(none.status, 409);
    await sqlRun("UPDATE sysbuild_delegations SET status = 'revoked', revoked_at = '2026-10-20 10:00:00', revoke_reason = '换人' WHERE id = ?", [s2.A.dlg]);
    assert.strictEqual((await openTask(U.pm, s2.T.aDel.task_id)).body.actions.reissue, false, '没有生效代表人：代表人任务的改发标志为假');
    assert.ok((await reissue(U.pm, s2.T.aDel.task_id, '改发')).status >= 400);
    // MED-1：submit 标志的项目级前置与执行同源——立项包未生效 / 缺生效负责人 / 项目没有需求部门：标志为假且执行 409（同一文案）；补齐后标志为真且执行 2xx
    const submitFlag = async (vid) => (await flagsOfVersion(U.pm, vid)).submit;
    const dI = await mkDraft({ noInitiation: true });
    assert.strictEqual(await submitFlag(dI.pv), false, '立项包未生效：submit 标志为假');
    const rI = await submit(U.pm, dI.pv);
    expectErr(rI, 409, 'SYSBUILD_STATE', '立项包未生效');
    assert.ok(rI.body.message.includes('立项包还没有生效版本'), `提示实际 ${rI.body.message}`);
    await seedEffectiveInitiation(dI.pid);
    assert.strictEqual(await submitFlag(dI.pv), true, '立项包生效后标志为真');
    assert.strictEqual((await submit(U.pm, dI.pv)).status, 200, '标志为真，执行应成功');
    const dM = await mkDraft({ noDelegate: true });
    assert.strictEqual(await submitFlag(dM.pv), false, '缺生效负责人：submit 标志为假');
    const rM = await submit(U.pm, dM.pv);
    expectErr(rM, 409, 'SYSBUILD_STATE', '缺生效负责人');
    assert.ok(rM.body.message.includes('甲部（缺生效负责人）'), `提示实际 ${rM.body.message}`);
    await addDelegation(dM.A.party, await addMember(dM.pid, U.del, { party: dM.A.party }), dM.A.apt, 'active');
    assert.strictEqual(await submitFlag(dM.pv), true, '补上生效代表人后标志为真');
    assert.strictEqual((await submit(U.pm, dM.pv)).status, 200, '标志为真，执行应成功');
    // H-1 / P43：计划齐全——缺计划时标志为假且执行 409（同一文案）；补齐后标志为真且执行 2xx
    const dP = await mkDraft({ noPlans: true });
    assert.strictEqual(await submitFlag(dP.pv), false, '节点缺计划：submit 标志为假');
    const rP = await submit(U.pm, dP.pv);
    expectErr(rP, 409, 'SYSBUILD_STATE', '节点缺计划');
    assert.strictEqual(rP.body.message, '以下阶段还没有有效的计划起止日期：上线（含测试与验收）（第 1 批）、结项');
    assert.strictEqual(await planAllNodes(dP.pid), 5);
    assert.strictEqual(await submitFlag(dP.pv), true, '补齐计划后标志为真');
    assert.strictEqual((await submit(U.pm, dP.pv)).status, 200, '标志为真，执行应成功');
    const dN = await mkDraft({ noParty: true });
    assert.strictEqual(await submitFlag(dN.pv), false, '项目没有需求部门参与方：submit 标志为假');
    expectErr(await submit(U.pm, dN.pv), 409, 'SYSBUILD_STATE', '无需求部门');
  });
}

// ── 变异（登记到 sysbuild-api-suite.js 的 MUTATIONS 末尾）：每条必须登记 expect；不改变 SQL 占位符个数 ─────────────────────────────────
//   锚点必须在被测文件副本里恰好出现一次。说明：条件更新的旧状态条件（WHERE … AND status = '…'）与它前面的规则层判定互为双重保险（同一写事务内
//   串行执行，前一层先拦），所以单独去掉任一层都能被另一层兜住；对应变异把两层同时去掉。
const CONFIRM_MUTATIONS = [
  // ── 提交 ──
  { id: 'C4a 提交：非草稿判定（规则层）去掉', expect: ['C4a 提交：失败分支'], edits: [{ file: 'rules.js', from: "if (t.versionStatus !== 'draft') return '只有草稿版本可以提交确认';", to: '' }] },
  { id: 'C4a 提交：非草稿判定与条件更新的旧状态条件同时去掉', expect: ['C4a 提交：失败分支', 'C4a rules：新动作'], edits: [
    { file: 'rules.js', from: "if (t.versionStatus !== 'draft') return '只有草稿版本可以提交确认';", to: '' },
    { file: 'confirm.js', from: "WHERE id = ? AND status = 'draft'\", [snapshotText, vid]);", to: 'WHERE id = ?", [snapshotText, vid]);' },
  ] },
  { id: 'C4a 提交：类型不开放判定放开 batch_req', expect: ['C4a rules：新动作'], edits: [{ file: 'rules.js', from: "const SUBMITTABLE_PACKAGE_TYPES = Object.freeze(['overall', 'initiation', 'batch_accept', 'closing']);", to: "const SUBMITTABLE_PACKAGE_TYPES = Object.freeze(['overall', 'initiation', 'batch_accept', 'closing', 'batch_req']);" }] }, // S-S1c：清单加了 change；C6a：closing / batch_accept 已开放，锚点与目标改为放开 batch_req（第一期不建批次需求包，只有 rules 用例的类型矩阵能验）
  { id: 'C4a 提交：一般成员也能提交', expect: ['C4a 提交：权限与项目状态'], edits: [{ file: 'rules.js', from: 'package_version_submit: Object.freeze({\n    can: canActAsPm,', to: 'package_version_submit: Object.freeze({\n    can: (identity) => !!(!identity.isReadonly && identity.isMember),' }] }, // #212 C7（H2）：原 to 引用 canRegisterItem（随 rules.js 删），改成语义相同的内联判定（不用 canRegisterEntry，它多放行 admin）
  { id: 'C4a 提交：项目状态类别改成 close（已暂停不能提交）', expect: ['C4a 提交：权限与项目状态', 'C4a rules：新动作'], edits: [{ file: 'rules.js', from: "package_version_submit: 'maintain',", to: "package_version_submit: 'close'," }] },
  // P32：form / parent 提交时重算并回写。「回写的旧状态条件」与规则层的草稿判定互为双重保险（同一写事务内串行），单独去掉条件观察不到，所以对应变异把规则层判定、回写条件、状态更新条件三处同时去掉
  { id: 'C4a 提交 P32：重算后不回写（沿用草稿存的值）', expect: ['C4a 提交 P32'], edits: [{ file: 'packages.js', from: 'SET form = ?, parent_overall_version_id = ?, updated_at', to: 'SET form = COALESCE(form, ?), parent_overall_version_id = COALESCE(parent_overall_version_id, ?), updated_at' }] },
  { id: 'C4a 提交 P32：回写的旧状态条件、规则层草稿判定与状态更新条件同时去掉', expect: ['C4a 提交 P32'], edits: [
    { file: 'rules.js', from: "if (t.versionStatus !== 'draft') return '只有草稿版本可以提交确认';", to: '' },
    { file: 'packages.js', from: "if (ver.status !== 'draft' || !rules.SUBMITTABLE_PACKAGE_TYPES.includes(pkg.type)) return facts;", to: 'if (!rules.SUBMITTABLE_PACKAGE_TYPES.includes(pkg.type)) return facts;' },
    { file: 'packages.js', from: "parent_overall_version_id = ?, updated_at = datetime('now','localtime') WHERE id = ? AND status = 'draft'\",", to: "parent_overall_version_id = ?, updated_at = datetime('now','localtime') WHERE id = ?\"," },
    { file: 'confirm.js', from: "WHERE id = ? AND status = 'draft'\", [snapshotText, vid]);", to: 'WHERE id = ?", [snapshotText, vid]);' },
  ] },
  { id: 'C4a 提交 P32：form 变化不记事件', expect: ['C4a 提交 P32'], edits: [{ file: 'packages.js', from: 'if (ver.form !== calc.form) { changed.form_from = ver.form; changed.form_to = calc.form; }', to: '' }] },
  { id: 'C4a 提交 P32：parent 变化不记事件', expect: ['C4a 提交 P32'], edits: [{ file: 'packages.js', from: 'if (ver.parent_overall_version_id !== calc.parent) { changed.parent_from = ver.parent_overall_version_id; changed.parent_to = calc.parent; }', to: '' }] },
  // #212 C2 新增（N2，清单 4.4 ③）：原件 history 套件 1920 只覆盖 history.js 里的调用点，普通提交的调用点 confirm.js 从没有变异；判红点 :671（form 仍是草稿存的 overall_batch_req）
  {"id":"C4a 提交 P32：提交不调用回写（只重算不写）","expect":["C4a 提交 P32"],"edits":[{"file":"confirm.js","from":"const { calc, changed } = await rewriteFormAndParent(q, pkg, ver);","to":"const calc = { form: ver.form }; const changed = {};"}]},
  {"id":"C4a 提交 P32：事件的 form 取回写前的旧值","expect":["C4a 提交 P32"],"edits":[{"file":"confirm.js","from":"version_no: ver.version_no, form: calc.form,","to":"version_no: ver.version_no, form: ver.form,"}]},
  // P37：总体规划包提交前须立项包已生效（修订批二 MED-1 起判定在 rules.js package_version_submit，事实取自 packages.js versionFactsOf / effectiveInitiationVersionId）
  { id: 'C4a 提交 P37：不核对立项包是否生效', expect: ['C4a 提交 P37'], edits: [{ file: 'rules.js', from: "if (t.packageType === 'overall' && t.initiationEffective !== true) return INITIATION_NOT_EFFECTIVE_MESSAGE;", to: '' }] },
  { id: 'C4a 提交 P37：立项包待确认也算', expect: ['C4a 提交 P37'], edits: [{ file: 'packages.js', from: "p.type = 'initiation' AND v.status = 'effective' ORDER BY v.id DESC LIMIT 1", to: "p.type = 'initiation' AND v.status IN ('effective', 'pending') ORDER BY v.id DESC LIMIT 1" }] },
  { id: 'C4a 提交 P37：立项包生效不限本项目', expect: ['C4a 提交 P37'], edits: [{ file: 'packages.js', from: "WHERE p.project_id = ? AND p.type = 'initiation' AND v.status = 'effective' ORDER BY v.id DESC LIMIT 1", to: "WHERE (p.project_id = ? OR 1 = 1) AND p.type = 'initiation' AND v.status = 'effective' ORDER BY v.id DESC LIMIT 1" }] },
  { id: 'C4a 提交 P37：立项包自己的提交也要求立项包已生效', expect: ['C4a 提交 P37', 'C4a 提交：立项包成功'], edits: [{ file: 'rules.js', from: "if (t.packageType === 'overall' && t.initiationEffective !== true)", to: 'if (t.initiationEffective !== true)' }] },
  { id: 'C4a 提交：项目没有需求部门参与方放行', expect: ['C4a 提交：失败分支'], edits: [{ file: 'confirm-core.js', from: 'if (r.noParty) return { noParty: true, missing: [] };', to: 'if (r.noParty) return null;' }] },
  { id: 'C4a 提交：缺必需确认人放行', expect: ['C4a 提交：失败分支'], edits: [{ file: 'confirm-core.js', from: 'return r.missing.length > 0 ? { noParty: false, missing: r.missing } : null;', to: 'return null;' }] },
  { id: 'C4a 提交：总体规划包不要代表人', expect: ['C4a 提交：失败分支', 'C4a 提交：总体规划包成功'], edits: [{ file: 'confirm-core.js', from: "initiation: 'owner', overall: 'delegate',", to: "initiation: 'owner', overall: 'owner'," }] },
  { id: 'C4a 提交：立项包也要代表人', expect: ['C4a 提交：立项包成功'], edits: [{ file: 'confirm-core.js', from: "    } else {\n      const dlg = await currentDelegate(q, p.id);", to: "    }\n    if (true) {\n      const dlg = await currentDelegate(q, p.id);" }] },
  // C4b P44：原变异「负责人不要求有平台账号」（把 C4a 的一档判定放宽到无账号成员）随契约翻转——现在无账号成员本来就是代录确认人，对应变异是把它收回成 C4a 的一档判定（无账号视为缺人）。
  // M1：确认人解析与资格复核同源（可作为确认人 = 成员已加入未移出 + 有平台账号且 active，或无账号（C4b P44），CONFIRMER_ELIGIBLE_SQL 一处定义）
  // R1（#212 C3，R8）：确认人资格要求平台账号；变异把 CONFIRMER_ELIGIBLE_SQL 放宽回「无账号成员也算确认人」（载体：C4a 提交：失败分支的 R8 反转段）
  // R3（#212 C3）：P36 同一人判定恒为真
  { id: 'P36：同一人判定恒为真（只要另一类任务已确认就算冲突）', expect: ['C4a P36'], edits: [{ file: 'confirm-core.js', from: 'return rows.some((r) => r.user_id === me.user_id);', to: 'return rows.length > 0;' }] },
  // M635（改挂）：最后一人确认后版本仍待确认；to 去掉 C3 后不存在的 method 变量
  { id: 'C4b fix1 L5：代录确认不走 takeEffectIfComplete（最后一条代录后版本仍待确认）', expect: ['C4a 生效：部分确认仍待确认'], edits: [{ file: 'confirm.js', from: 'const eff = await core.takeEffectIfComplete(q, user, c.task.project_id, c.obj.pkg, c.obj.ver);', to: 'const eff = { effective: false, superseded: [], baselineNodes: [], advancedBatches: [] };' }] },
  { id: 'C4a 确认人解析 M1：解析去掉账号状态条件', expect: ['C4a 确认人解析与资格同源', 'C4a 失资格'], edits: [{ file: 'confirm-core.js', from: "const CONFIRMER_ELIGIBLE_SQL = `${rules.MEMBER_ACTIVE_SQL} AND u.status = 'active'`;", to: 'const CONFIRMER_ELIGIBLE_SQL = `${rules.MEMBER_ACTIVE_SQL}`;' }] },
  { id: 'C4a 确认人解析 M1：代表人解析不查账号状态', expect: ['C4a 确认人解析与资格同源'], edits: [{ file: 'confirm-core.js', from: "WHERE d.party_id = ? AND d.status = 'active' AND ${eligibleSqlOf(o)} ORDER BY d.id DESC LIMIT 1", to: "WHERE d.party_id = ? AND d.status = 'active' AND ${rules.MEMBER_ACTIVE_SQL} ORDER BY d.id DESC LIMIT 1" }] },
  { id: 'C4a 提交：包版本自己的材料附件不冻结', expect: ['C4a 提交：总体规划包成功'], edits: [{ file: 'confirm.js', from: "for (const source of scope.attachmentSources) await freezeSource(source);", to: "for (const source of scope.attachmentSources) if (source.ownerType !== 'package_version') await freezeSource(source);" }] },
  // ── 撤回 ──
  { id: 'C4a 撤回：已生效的版本也能撤回', expect: ['C4a 撤回：草稿 / 已生效', 'C4a rules：新动作'], edits: [{ file: 'rules.js', from: "(t.versionStatus === 'pending' ? null : '只有待确认的版本可以撤回提交，已生效的版本不能撤回')", to: "(t.versionStatus !== 'superseded' ? null : '只有待确认的版本可以撤回提交，已生效的版本不能撤回')" }] },
  { id: 'C4a 撤回：待确认修订不置失效', expect: ['C4a 撤回：待确认'], edits: [{ file: 'confirm.js', from: "for (const r of revs) await core.closePendingRevision(q, r.id, 'invalid', reason);", to: '' }] },
  { id: 'C4a 撤回：原因不必填', expect: ['C4a 撤回：待确认'], edits: [{ file: 'confirm.js', from: "readText(body.reason, 'reason', '撤回原因', REASON_MAX, true)", to: "readText(body.reason, 'reason', '撤回原因', REASON_MAX, false) || '未写'" }] },
  { id: 'C4a 撤回：非 PM 也能撤回', expect: ['C4a 撤回：待确认'], edits: [{ file: 'rules.js', from: 'package_version_withdraw: Object.freeze({\n    can: canActAsPm,', to: 'package_version_withdraw: Object.freeze({\n    can: (identity) => !!(!identity.isReadonly && identity.isMember),' }] }, // #212 C7（H2）：同「一般成员也能提交」
  { id: 'C4a 撤回：项目状态类别改成 resolve（已终止也能撤回）', expect: ['C4a 撤回：草稿 / 已生效', 'C4a rules：新动作'], edits: [{ file: 'rules.js', from: "package_version_withdraw: 'maintain',", to: "package_version_withdraw: 'resolve'," }] },
  // ── 浏览 ──
  // #212 C2 新增（N3，清单 4.4 ⑤）：遮蔽人姓名取空——只在新增的 masked_by_name 断言判红（未遮蔽的对照里该字段本来就是 null）
  { id: '遮蔽读面：确认任务附件视图遮蔽人姓名取空', expect: ['C4a 浏览：'], edits: [{ file: 'confirm-core.js', from: 'COALESCE(mu.display_name, mu.username) AS masked_by_name', to: 'NULL AS masked_by_name' }] },
  { id: 'C4a 浏览：非必需确认人打开也写浏览记录', expect: ['C4a 浏览：'], edits: [{ file: 'confirm.js', from: "const shouldRecord = target.isRequired ? c.latest.status === 'pending' : rules.opAllowed('confirm_decide', c.access, c.access.project, target);", to: "const shouldRecord = c.latest.status === 'pending';" }] },
  { id: 'C4a 浏览：必需确认人打开不写浏览记录', expect: ['C4a 浏览：', 'C4a 决策：成功路径'], edits: [{ file: 'confirm.js', from: 'if (record && shouldRecord) {', to: 'if (false) {' }] },
  { id: 'C4a 浏览：浏览记录里的冻结清单写成空', expect: ['C4a 浏览：', 'C4a 决策：409 各分支'], edits: [{ file: 'confirm.js', from: '[Number(user.id), c.task.object_type, c.task.object_version_id, JSON.stringify(frozen)]', to: "[Number(user.id), c.task.object_type, c.task.object_version_id, '[]']" }] },
  { id: 'C4a 浏览：任务读接口不查项目可见性', expect: ['C4a 浏览：'], edits: [{ file: 'confirm.js', from: "rules.assertVisible(access);\n    const latest = await core.latestRevision(q, tid);", to: 'const latest = await core.latestRevision(q, tid);' }] },
  // ── 决策 ──
  { id: 'C4a 决策：任何人都能决策', expect: ['C4a 决策：403 / 404', 'C4a rules：新动作'], edits: [{ file: 'rules.js', from: 'can: (identity, project, t) => t.isRequired === true || canProxyAsSuperAdmin(identity),', to: 'can: () => true,' }] },
  { id: 'C4a 决策：当前修订取第一条而不是最新一条', expect: ['C4a 改发：负责人更换后改发'], edits: [{ file: 'confirm-core.js', from: 'FROM sysbuild_confirm_task_revisions WHERE task_id = ? ORDER BY rev_no DESC LIMIT 1', to: 'FROM sysbuild_confirm_task_revisions WHERE task_id = ? ORDER BY rev_no ASC LIMIT 1' }] },
  { id: 'C4a 决策：修订编号不核对', expect: ['C4a 决策：409 各分支', 'C4a rules：新动作'], edits: [{ file: 'rules.js', from: 'if (t.revisionIdGiven !== undefined && t.revisionIdGiven !== t.currentRevisionId)', to: 'if (false)' }] },
  { id: 'C4a 决策：对象版本编号不核对', expect: ['C4a 决策：409 各分支', 'C4a rules：新动作'], edits: [{ file: 'rules.js', from: 'if (t.objectVersionIdGiven !== undefined && t.objectVersionIdGiven !== t.objectVersionId)', to: 'if (false)' }] },
  { id: 'C4a 决策：修订已处理不拦（规则层）', expect: ['C4a 决策：409 各分支', 'C4a rules：新动作'], edits: [{ file: 'rules.js', from: "if (t.revisionStatus !== 'pending') return '该任务修订已处理，不能再次决策';", to: '' }] },
  { id: 'C4a 决策：对象版本不再待确认不拦', expect: ['C4a 决策：409 各分支', 'C4a rules：新动作'], edits: [{ file: 'rules.js', from: "if (!t.objectPending) return { code: 'SYSBUILD_VERSION_CHANGED', message: '确认的对象版本已不在待确认状态' };", to: '' }] },
  { id: 'C4a 决策：资格复核结果不用', expect: ['C4a 失资格', 'C4a rules：新动作'], edits: [{ file: 'rules.js', from: 'return t.qualificationLoss || null;', to: 'return null;' }] },
  { id: 'C4a 决策：资格复核不查任职是否仍生效', expect: ['C4a 失资格'], edits: [{ file: 'confirm-core.js', from: "if (!a || a.status !== 'active' || a.member_id !== rev.required_member_id) return", to: 'if (!a) return' }] },
  { id: 'C4a 决策：资格复核不查授权是否仍生效', expect: ['C4a 失资格'], edits: [{ file: 'confirm-core.js', from: "if (!d || d.status !== 'active' || d.member_id !== rev.required_member_id) return", to: 'if (!d) return' }] },
  // 资格复核第一层 = 解析用的同一份「可作为确认人」判定（CONFIRMER_ELIGIBLE_SQL）：去掉「已移出」条件会同时放过解析与复核；L2 用例让「已移出」检查单独可观察（#212 C7 起用清空依据的内容包任务夹具，原是提出人任务没有任职 / 授权依据兜底）
  { id: 'C4a 决策：资格复核不查成员是否已移出', expect: ['C4a 失资格', 'C4a 失资格（L2）'], edits: [{ file: 'confirm-core.js', from: "const CONFIRMER_ELIGIBLE_SQL = `${rules.MEMBER_ACTIVE_SQL} AND u.status = 'active'`;", to: "const CONFIRMER_ELIGIBLE_SQL = `m.joined_at IS NOT NULL AND u.status = 'active'`;" }] },
  { id: 'C4a 决策：资格复核不查账号状态（复核端不调用同源判定）', expect: ['C4a 失资格', 'C4a 确认人解析与资格同源'], edits: [{ file: 'confirm-core.js', from: 'if (!(await eligibleMember(q, rev.required_member_id, o))) {', to: 'if (false) {' }] }, // C6b 修订批 3：eligibleMember 多一个可选参数 o（发送侧「忽略账号状态」），锚点随之改
  { id: 'C4a 决策：未浏览放行', expect: ['C4a 决策：409 各分支', 'C4a 改发：负责人更换后改发'], edits: [{ file: 'confirm.js', from: "if (!view) throw makeError(409, 'SYSBUILD_NOT_VIEWED',", to: "if (false) throw makeError(409, 'SYSBUILD_NOT_VIEWED'," }] },
  { id: 'C4a 决策：浏览记录不限本人', expect: ['C4a 决策：409 各分支'], edits: [{ file: 'confirm.js', from: 'FROM sysbuild_views WHERE user_id = ? AND object_type = ?', to: 'FROM sysbuild_views WHERE (user_id = ? OR 1 = 1) AND object_type = ?' }] },
  { id: 'C4a 决策：浏览时间窗去掉', expect: ['C4a 决策：409 各分支'], edits: [{ file: 'confirm.js', from: 'AND opened_at >= ? ORDER BY id DESC LIMIT 1', to: 'AND (opened_at >= ? OR 1 = 1) ORDER BY id DESC LIMIT 1' }] },
  { id: 'C4a 决策：冻结清单比对去掉', expect: ['C4a 决策：409 各分支'], edits: [{ file: 'confirm.js', from: 'if (seenKey !== core.frozenKey(frozenNow)) throw makeError(', to: 'if (false) throw makeError(' }] },
  { id: 'C4a 决策：勾选文案不核对', expect: ['C4a 决策：400 各分支'], edits: [{ file: 'confirm.js', from: 'if (body.checkbox_text !== core.checkboxTextsOf(c.task.purpose)[decision]) throw invalid(', to: 'if (false) throw invalid(' }] },
  { id: 'C4a 决策：decision 枚举不核对', expect: ['C4a 决策：400 各分支'], edits: [{ file: 'confirm.js', from: "if (typeof decision !== 'string' || !hasKey(DECISIONS, decision)) throw invalid(", to: 'if (false) throw invalid(' }] },
  { id: 'C4a 决策：有异议 / 不认可不要求原因', expect: ['C4a 决策：400 各分支'], edits: [{ file: 'confirm.js', from: "readText(body.reason, 'reason', '原因', REASON_MAX, decision !== 'confirm')", to: "readText(body.reason, 'reason', '原因', REASON_MAX, false) || '未写'" }] },
  { id: 'C4a 决策：请求体键不限白名单', expect: ['C4a 决策：400 各分支'], edits: [{ file: 'confirm.js', from: "onlyKeys(body, ['revision_id', 'object_version_id', 'decision', 'checkbox_text', 'reason']);", to: 'onlyKeys(body, Object.keys(body));' }] },
  { id: 'C4a 决策：有异议被记成已确认', expect: ['C4a 决策：成功路径'], edits: [{ file: 'confirm.js', from: "confirm: 'confirmed', object: 'objected', reject: 'rejected'", to: "confirm: 'confirmed', object: 'confirmed', reject: 'rejected'" }] },
  { id: 'C4a 决策：D42 唯一索引去掉', expect: ['C4a 决策（D42）'], edits: [{ file: 'schema.js', from: "['uq_sysbuild_confirmations_revision', 'sysbuild_confirmations(task_revision_id)', true],", to: "['uq_sysbuild_confirmations_revision', 'sysbuild_confirmations(task_revision_id)', false]," }] },
  { id: 'C4a 决策：项目状态类别改成 resolve（已终止也能决策）', expect: ['C4a 决策：409 各分支', 'C4a rules：新动作'], edits: [{ file: 'rules.js', from: "confirm_decide: 'accept',", to: "confirm_decide: 'resolve'," }] },
  // ── 改发 ──
  { id: 'C4a 改发：已确认的修订也能改发', expect: ['C4a 改发：不能改发', 'C4a rules：新动作'], edits: [{ file: 'rules.js', from: "if (!['pending', 'objected', 'rejected', 'invalid'].includes(t.revisionStatus)) return '只有待确认、有异议、不认可或已失效的修订可以改发';", to: '' }] },
  { id: 'C4a 改发 P38：已失效的修订不能改发', expect: ['C4a rules：新动作', 'C4a P38'], edits: [{ file: 'rules.js', from: "['pending', 'objected', 'rejected', 'invalid'].includes(t.revisionStatus)", to: "['pending', 'objected', 'rejected'].includes(t.revisionStatus)" }] },
  { id: 'C4a 改发 L3①：改发解析被挡时标志仍为真（reissueBlocked 不进判定）', expect: ['C4a rules：新动作', 'C4a actions 与执行一致', 'C4a P36'], edits: [{ file: 'rules.js', from: 'return t.reissueBlocked || null;', to: 'return null;' }] },
  { id: 'C4a 改发 L3①：读接口 actions.reissue 不带解析结果', expect: ['C4a actions 与执行一致', 'C4a P36', 'C4a 确认人解析与资格同源'], edits: [{ file: 'confirm.js', from: "reissue: rules.opAllowed('confirm_reissue', c.access, c.access.project, reissueTarget(c, await resolveReissue(q, c))),", to: "reissue: rules.opAllowed('confirm_reissue', c.access, c.access.project, reissueTarget(c, { blocked: null })),", }] },
  // P36
  { id: 'C4a 改发 P36：不核对新人是否已确认另一类任务', expect: ['C4a P36'], edits: [{ file: 'confirm.js', from: 'if (await core.confirmedOnOtherRoleBySameUser(q, c.task, cur.memberId)) {', to: 'if (false) {' }] },
  { id: 'C4a 改发 P36：另一类任务只要有修订就算冲突（不限已确认）', expect: ['C4a P36'], edits: [{ file: 'confirm-core.js', from: "AND r.status = 'confirmed' AND r.rev_no = (SELECT MAX(r2.rev_no)", to: "AND r.status <> 'invalid' AND r.rev_no = (SELECT MAX(r2.rev_no)" }] },
  { id: 'C4a 生效 P36：同一参与方两条任务由同一用户确认也生效', expect: ['C4a P36'], edits: [{ file: 'confirm-core.js', from: 'if (seen.has(k)) return false;', to: '' }] },
  { id: 'C4a 改发：版本不再待确认也能改发', expect: ['C4a 改发：不能改发', 'C4a rules：新动作'], edits: [{ file: 'rules.js', from: "if (t.objectStatus !== 'pending') return '任务所在的版本已不是待确认，不能改发';", to: '' }] },
  // C4b P48：改发的对象类型限制整句去掉（邀请 / 授权类任务也能改发）。#212 C7：条目版本任务没有了，类型清单只剩 package_version，锚点随 rules.js 改写（M484）；「改发只开放内容包任务（回到 C4a）」一条的 to 与现行写法相同，退役。
  { id: 'C4b P48：改发不限对象类型（邀请 / 授权类任务也能改发）', expect: ['C4a rules：新动作'], edits: [{ file: 'rules.js', from: "if (t.objectType !== 'package_version') return '该类型的确认任务不支持改发';", to: '' }] },
  { id: 'C4a 改发：非 PM 也能改发', expect: ['C4a 改发：不能改发'], edits: [{ file: 'rules.js', from: 'confirm_reissue: Object.freeze({\n    can: canActAsPm,', to: 'confirm_reissue: Object.freeze({\n    can: (identity) => !!(!identity.isReadonly && identity.isMember),' }] }, // #212 C7（H2）：同「一般成员也能提交」
  { id: 'C4a 改发：原因不必填', expect: ['C4a 改发：不能改发'], edits: [{ file: 'confirm.js', from: "readText(body.reason, 'reason', '改发原因', REASON_MAX, true)", to: "readText(body.reason, 'reason', '改发原因', REASON_MAX, false) || '未写'" }] },
  { id: 'C4a 改发：待确认的旧修订不置已替代', expect: ['C4a 改发：待确认 / 不认可'], edits: [{ file: 'confirm.js', from: "if (c.latest.status === 'pending') await core.closePendingRevision(q, c.latest.id, 'superseded', reason);", to: '' }] },
  { id: 'C4a 改发：不重新解析必需确认人（沿用旧人）', expect: ['C4a 改发：负责人更换后改发', 'C4a 失资格'], edits: [{ file: 'confirm.js', from: 'const cur = isDelegate ? await core.currentDelegate(q, c.task.party_id) : await core.currentOwner(q, c.task.party_id);', to: 'const cur = { memberId: c.latest.required_member_id, appointmentId: c.latest.basis_appointment_id, delegationId: c.latest.basis_delegation_id };' }] },
  { id: 'C4a 改发：没有当前负责人 / 代表人不拦', expect: ['C4a 改发：待确认 / 不认可'], edits: [{ file: 'confirm.js', from: 'if (!cur) return { isDelegate, cur: null, blocked:', to: 'if (false) return { isDelegate, cur: null, blocked:' }] },
  { id: 'C4a 改发：代表人任务按负责人解析', expect: ['C4a 改发：待确认 / 不认可'], edits: [{ file: 'confirm.js', from: 'const isDelegate = c.latest.basis_delegation_id !== null;', to: 'const isDelegate = false;' }] },
  // ── 生效与基线 ──
  { id: 'C4a 生效：任一人确认即生效', expect: ['C4a 生效：部分确认'], edits: [{ file: 'confirm-core.js', from: "if (!(rows.length > 0 && rows.every((r) => r.status === 'confirmed'))) return false;", to: "if (!(rows.length > 0 && rows.some((r) => r.status === 'confirmed'))) return false;" }] },
  { id: 'C4a 生效：判定把已替代的旧修订也算进来（不取最新修订）', expect: ['C4a 生效：部分确认'], edits: [{ file: 'confirm-core.js', from: "AND t.purpose = 'package_confirm'\n        AND r.rev_no = (SELECT MAX(r2.rev_no) FROM sysbuild_confirm_task_revisions r2 WHERE r2.task_id = t.id)", to: "AND t.purpose = 'package_confirm'\n        AND 1 = 1" }] },
  { id: 'C4a 生效：原生效版本不被替代', expect: ['C4a 生效：立项包'], edits: [{ file: 'confirm-core.js', from: "WHERE package_id = ? AND status = 'effective' AND id <> ? ORDER BY id\"", to: "WHERE package_id = ? AND status = 'draft' AND id <> ? ORDER BY id\"" }] },
  {"id":"C4a 生效：立项包也形成基线","expect":["C4a 生效：立项包"],"edits":[{"file":"confirm-core.js","from":"const baselineNodes = pkg.type === 'overall' ? await formBaselines(q, user, projectId, ver.id) : [];","to":"const baselineNodes = await formBaselines(q, user, projectId, ver.id);"}]},
  {"id":"C4a 生效：已取消的节点也形成基线","expect":["C4a 生效 LOW-1 / LOW-2"],"edits":[{"file":"scope-plans.js","from":" || match.status === 'cancelled'","to":""}]},
  {"id":"C4a 生效：覆盖已有基线","expect":["C4a 生效：总体规划第二个版本"],"edits":[{"file":"confirm-core.js","from":"if (existing.package_version_id !== versionId || existing.planned_start !== start || existing.planned_end !== end) throw snapshotError();","to":"if (false) throw snapshotError();"}]},
  {"id":"C4a 生效：没有计划的节点也要写基线","expect":["B3.2 三职责计划与范围材料"],"edits":[{"file":"scope-plans.js","from":"if (!dates || !validDates(dates)) missing.push","to":"if (dates && !validDates(dates)) missing.push"}]},
  {"id":"C4a 生效：基线取第一条计划而不是最后一条","expect":["C4a 生效：部分确认"],"edits":[{"file":"scope-plans.js","from":"AND kind IN ('baseline', 'plan_change') ORDER BY id DESC LIMIT 1","to":"AND kind IN ('baseline', 'plan_change') ORDER BY id ASC LIMIT 1"}]},
  // ── H-1（原交接 ①「生效后首次设计划即基线」已撤销，改期式写入）──
  { id: 'C4a H-1：生效后尚无基线的节点写计划不要求原因（仍按草稿期放行）', expect: ['C4a H-1（P43）生效后写计划'], edits: [{ file: 'plan.js', from: "if (reason === null) throw invalid('改期必须填写原因', 'reason');", to: "if (reason === null && recs.some((r) => r.kind === 'baseline')) throw invalid('改期必须填写原因', 'reason');" }] },
  // 修订批二 LOW-3：收口前置与 plan_write_mode 的「有无生效总体规划」读 effectiveOverallVersionId（同一来源），所以这条变异的 expect 也含读接口用例（别的项目的生效版本被带出）
  { id: 'C4a H-1：现行总体规划版本解析不限本项目', expect: ['C4a H-1（P43）生效后写计划', 'C4a H-1 读接口信号'], edits: [{ file: 'packages.js', from: "WHERE p.project_id = ? AND p.type = 'overall' AND v.status = 'effective' ORDER BY v.id DESC LIMIT 1", to: "WHERE (p.project_id = ? OR 1 = 1) AND p.type = 'overall' AND v.status = 'effective' ORDER BY v.id DESC LIMIT 1" }] },
  // ── 待我确认 ──
  { id: 'C4a 待我确认：不限本人', expect: ['C4a 待我确认'], edits: [{ file: 'confirm.js', from: "WHERE r.status = 'pending' AND m.user_id = ?", to: "WHERE r.status = 'pending' AND (m.user_id = ? OR 1 = 1)" }] },
  { id: 'C4a 待我确认：已处理的修订也列', expect: ['C4a 待我确认'], edits: [{ file: 'confirm.js', from: "WHERE r.status = 'pending' AND m.user_id = ?", to: "WHERE r.status <> 'invalid' AND m.user_id = ?" }] },
  // L3②：待我确认与 decide 同一个资格判定（成员已移出 / 账号停用 / 任职或授权不再生效的修订不列）
  { id: 'C4a 待我确认 L3②：不做资格复核（被移出的成员、停用账号、失效的任职 / 授权也列）', expect: ['C4a 待我确认', 'C4a 确认人解析与资格同源'], edits: [{ file: 'confirm-core.js', from: 'return qualificationLoss(q, rev, o);', to: 'return null;' }] }, // C6b 修订批 1（K1）：三项判定抽成 confirm-core.confirmAvailabilityBlock，锚点随之换文件
  { id: 'C4a 待我确认 P38：已终止 / 已结项项目的待确认修订也列', expect: ['C4a P38'], edits: [{ file: 'confirm-core.js', from: 'canDecide: !!access.project && rules.projectAllowsWrite(access.project.status, rules.OP_KIND.confirm_decide)', to: 'canDecide: true' }] }, // C6b 修订批 1（K1）：判定抽到 confirm-core.confirmAvailabilityBlock，锚点随之换文件
  // ── P34 总体排期基线来源 ──
  { id: 'C4a P34：总体规划待确认期间节点设计划不拦', expect: ['C4a P34：总体规划待确认期间', 'C4a rules（修订批）'], edits: [{ file: 'rules.js', from: "      if (t.overallPending) return OVERALL_PENDING_PLAN_MESSAGE;\n      return t.nodeStatus === 'closed' && t.hasBaseline", to: "      return t.nodeStatus === 'closed' && t.hasBaseline" }] },
  { id: 'C4a P34：总体规划待确认期间取消节点不拦', expect: ['C4a P34：总体规划待确认期间', 'C4a rules（修订批）'], edits: [{ file: 'rules.js', from: "      if (t.overallPending) return OVERALL_PENDING_PLAN_MESSAGE; // C4a P34：总体规划待确认期间排期已随包冻结，取消节点也会改变将形成的基线\n", to: '' }] },
  { id: 'C4a P34：待确认判定取成立项包 / 别的状态（不认总体规划的待确认版本）', expect: ['C4a P34：总体规划待确认期间'], edits: [{ file: 'golive-core.js', from: "WHERE p.project_id = ? AND p.type = 'overall' AND v.status = 'pending' LIMIT 1", to: "WHERE p.project_id = ? AND p.type = 'overall' AND v.status = 'draft' LIMIT 1" }] }, // C5：类型清单收回到只认总体规划包，锚点随之改写
  { id: 'C4a P34：待确认判定不限本项目', expect: ['C4a P34：总体规划待确认期间'], edits: [{ file: 'golive-core.js', from: "WHERE p.project_id = ? AND p.type = 'overall' AND v.status = 'pending' LIMIT 1", to: "WHERE (p.project_id = ? OR 1 = 1) AND p.type = 'overall' AND v.status = 'pending' LIMIT 1" }] },
  { id: 'C4a P34：待确认判定把立项包也算进来', expect: ['C4a P34：总体规划待确认期间'], edits: [{ file: 'golive-core.js', from: "WHERE p.project_id = ? AND p.type = 'overall' AND v.status = 'pending' LIMIT 1", to: "WHERE p.project_id = ? AND p.type IN ('overall', 'initiation') AND v.status = 'pending' LIMIT 1" }] },
  { id: 'C4a P34：读接口节点标志不带总体规划待确认', expect: ['C4a P34：总体规划待确认期间'], edits: [{ file: 'plan.js', from: 'nodeTarget(n, batch, recs, corrects, data.overallPending, data.devStartReady[n.id])', to: 'nodeTarget(n, batch, recs, corrects, undefined, data.devStartReady[n.id])' }] },
  { id: 'C4a P34：设计划端点的 target 不带总体规划待确认', expect: ['C4a P34：总体规划待确认期间'], edits: [{ file: 'plan.js', from: "rules.assertOp('schedule_plan', access, access.project, nodeTarget(node, batch, recs, null, overallPending));", to: "rules.assertOp('schedule_plan', access, access.project, nodeTarget(node, batch, recs, null));" }] },
  { id: 'C4a P34：取消端点的 target 不带总体规划待确认', expect: ['C4a P34：总体规划待确认期间'], edits: [{ file: 'plan.js', from: "rules.assertOp('node_cancel', access, access.project, nodeTarget(node, batch, recs, null, overallPending));", to: "rules.assertOp('node_cancel', access, access.project, nodeTarget(node, batch, recs, null));" }] },
  {"id":"C4a P34：提交事件不记节点计划","expect":["C4a P34：生效时形成的基线","C4a 提交：总体规划包成功"],"edits":[{"file":"confirm.js","from":"pkg.type === 'overall' ? { node_plans: facts.plan.entries } : {}","to":"{}"}]},
  {"id":"C4a P34：生效时基线不与提交记录核对","expect":["C4a P34：生效时形成的基线"],"edits":[{"file":"confirm-core.js","from":"if (['node_id', 'template_key', 'batch_id', 'planned_start', 'planned_end'].some((key) => item[key] !== actual[key])) throw snapshotError();","to":"if (false) throw snapshotError();"}]},
  {"id":"C4a P34：生效时基线只核对节点有无记录、不核对日期","expect":["C4a P34：生效时形成的基线"],"edits":[{"file":"confirm-core.js","from":"if (['node_id', 'template_key', 'batch_id', 'planned_start', 'planned_end'].some((key) => item[key] !== actual[key])) throw snapshotError();","to":"if (['node_id', 'template_key', 'batch_id'].some((key) => item[key] !== actual[key])) throw snapshotError();"}]},
  {"id":"C4a P34：提交事件缺节点计划记录时不 fail-closed","expect":["C4a P34：生效时形成的基线"],"edits":[{"file":"scope-plans.js","from":"if (!payload || payload.package_id !== row.package_id || payload.type !== 'overall' || !Array.isArray(payload.node_plans)) throw snapshotError();","to":"if (!payload || !Array.isArray(payload.node_plans)) return (await currentScopePlans(q, projectId, row.build_type)).entries;"}]},
  {"id":"C4a P34：任务详情不展示节点计划清单","expect":["C4a 生效：部分确认"],"edits":[{"file":"confirm.js","from":"const nodePlans = pkg.type === 'overall' ? await core.submittedNodePlans(q, pkg.project_id, ver.id) : [];","to":"const nodePlans = [];"}]},
  // ── P35 提交后新增需求部门 ──
  { id: 'C4a P35：待确认内容包期间新建需求部门不拦（规则层）', expect: ['C4a P35', 'C4a rules（修订批）'], edits: [{ file: 'rules.js', from: "return t.side === 'demand' && t.hasPendingContentPackage ? PENDING_PACKAGE_PARTY_MESSAGE : null; // C4a P35", to: 'return null; // C4a P35' }] },
  { id: 'C4a P35：新建参与方端点不带待确认标志', expect: ['C4a P35'], edits: [{ file: 'membership.js', from: 'side: values.side, hasDevParty: identity.hasDevParty, hasPendingContentPackage: identity.hasPendingContentPackage,', to: 'side: values.side, hasDevParty: identity.hasDevParty, hasPendingContentPackage: false,' }] },
  // 待确认包的类型清单读 rules.SUBMITTABLE_PACKAGE_TYPES（修订批二 LOW-5），变异直接替换 SQL 里引用常量的那一处
  { id: 'C4a P35：待确认判定漏掉立项包', expect: ['C4a P35'], edits: [{ file: 'rules.js', from: "p.type IN (${SUBMITTABLE_TYPES_SQL_LIST}) AND v.status = 'pending' LIMIT 1", to: "p.type IN ('overall') AND v.status = 'pending' LIMIT 1" }] },
  { id: 'C4a P35：待确认判定漏掉总体规划包', expect: ['C4a P35'], edits: [{ file: 'rules.js', from: "p.type IN (${SUBMITTABLE_TYPES_SQL_LIST}) AND v.status = 'pending' LIMIT 1", to: "p.type IN ('initiation') AND v.status = 'pending' LIMIT 1" }] },
  { id: 'C4a P35：待确认判定不限本项目', expect: ['C4a P35'], edits: [{ file: 'rules.js', from: "WHERE p.project_id = ? AND p.type IN (${SUBMITTABLE_TYPES_SQL_LIST}) AND v.status = 'pending' LIMIT 1", to: "WHERE (p.project_id = ? OR 1 = 1) AND p.type IN (${SUBMITTABLE_TYPES_SQL_LIST}) AND v.status = 'pending' LIMIT 1" }] },
  { id: 'C4a P35：待确认期间开发方也不能建', expect: ['C4a P35', 'C4a rules（修订批）'], edits: [{ file: 'rules.js', from: "return t.side === 'demand' && t.hasPendingContentPackage ? PENDING_PACKAGE_PARTY_MESSAGE : null; // C4a P35", to: 'return t.hasPendingContentPackage ? PENDING_PACKAGE_PARTY_MESSAGE : null; // C4a P35' }] },
  { id: 'C4a P35：读接口 party_sides 不带待确认标志', expect: ['C4a P35'], edits: [{ file: 'rules.js', from: '{ side, hasDevParty: !!identity.hasDevParty, hasPendingContentPackage: !!identity.hasPendingContentPackage }', to: '{ side, hasDevParty: !!identity.hasDevParty }' }] },
  // ── P38 终止项目 ──
  { id: 'C4a P38：终止项目不失效待确认修订', expect: ['C4a P38'], edits: [{ file: 'projects.js', from: "if (to === 'terminated') await confirmCore.invalidatePendingRevisionsOfProject(", to: "if (false) await confirmCore.invalidatePendingRevisionsOfProject(" }] },
  { id: 'C4a P38：终止项目的失效波及别的项目', expect: ['C4a P38'], edits: [{ file: 'confirm-core.js', from: "WHERE t.project_id = ? AND r.status = 'pending' ORDER BY r.id", to: "WHERE (t.project_id = ? OR 1 = 1) AND r.status = 'pending' ORDER BY r.id" }] },
  { id: 'C4a P38：终止项目的失效原因写成别的文案', expect: ['C4a P38'], edits: [{ file: 'confirm-core.js', from: "const PROJECT_TERMINATED_REASON = '项目已终止';", to: "const PROJECT_TERMINATED_REASON = '已终止';" }] },
  { id: 'C4a P38：暂停项目也失效待确认修订', expect: ['C4a P38'], edits: [{ file: 'projects.js', from: "if (to === 'terminated') await confirmCore.invalidatePendingRevisionsOfProject(", to: "if (to === 'terminated' || to === 'paused') await confirmCore.invalidatePendingRevisionsOfProject(" }] },
  { id: 'C4a P38：终止项目的失效不写事件', expect: ['C4a P38'], edits: [{ file: 'confirm-core.js', from: "    await emit(q, user, projectId, 'confirm_task', row.task_id, 'confirm_revision_invalidated', {", to: "    if (false) await emit(q, user, projectId, 'confirm_task', row.task_id, 'confirm_revision_invalidated', {" }] },
  // ── M2 读接口的计划写入方式 ──
  { id: 'C4a M2：读接口 plan_write_mode 不看总体规划是否生效（读写分叉）', expect: ['C4a H-1 读接口信号'], edits: [{ file: 'plan.js', from: 'planWriteMode(recs, data.facts.overall)', to: 'planWriteMode(recs, false)' }] },
  { id: 'C4a M2：写端点不看总体规划是否生效（读写分叉）', expect: ['C4a H-1 读接口信号', 'C4a H-1（P43）生效后写计划'], edits: [{ file: 'plan.js', from: 'const mode = planWriteMode(recs, hasEffectiveOverall);', to: 'const mode = planWriteMode(recs, false);' }] },
  { id: 'C4a H-1：读接口 has_baseline 恒为假', expect: ['C4a H-1 读接口信号', 'C4a H-1（P43）生效后写计划'], edits: [{ file: 'plan.js', from: "has_baseline: recs.some((r) => r.kind === 'baseline'),", to: 'has_baseline: false,' }] },
  { id: 'C4a M2：planWriteMode 不认总体规划已生效（恒 draft）', expect: ['C4a H-1 读接口信号'], edits: [{ file: 'plan.js', from: "(hasEffectiveOverall && records.some((r) => r.kind === 'plan_change'))", to: 'false' }] },
  // ── 收口前置：内容包已生效 ──
  { id: 'C4a 收口前置：读接口 close_blockers 不带内容包事实', expect: ['整体验收结项（D3'], edits: [{ file: 'plan.js', from: 'closeBlockers(n, data.facts)', to: 'closeBlockers(n, {})' }] },
  { id: 'C4a 收口前置：收口端点不带内容包事实（恒放行）', expect: ['整体验收结项（D3'], edits: [{ file: 'plan.js', from: 'const blockers = closing ? closeBlockers(node, (await loadPlanData(q, node.project_id)).facts) : [];', to: 'const blockers = [];' }] },
  // ── actions 与执行判定分叉 ──
  { id: 'C4a actions：包版本 submit 标志忽略对象状态', expect: ['C4a actions 与执行一致', 'C4a 提交：总体规划包成功'], edits: [{ file: 'packages.js', from: "submit: rules.opAllowed('package_version_submit', access, access.project, t),", to: 'submit: !!access.isPm,' }] },
  { id: 'C4a actions：包版本 withdraw 标志忽略对象状态', expect: ['C4a actions 与执行一致'], edits: [{ file: 'packages.js', from: "withdraw: rules.opAllowed('package_version_withdraw', access, access.project, t),", to: 'withdraw: !!access.isPm,' }] },
  { id: 'C4a actions：任务 decide 标志忽略对象状态', expect: ['C4a actions 与执行一致', 'C4a 浏览：'], edits: [{ file: 'confirm.js', from: "decide: rules.opAllowed('confirm_decide', c.access, c.access.project, target),", to: 'decide: target.isRequired,' }] },
  { id: 'C4a actions：任务 reissue 标志忽略对象状态', expect: ['C4a actions 与执行一致'], edits: [{ file: 'confirm.js', from: "reissue: rules.opAllowed('confirm_reissue', c.access, c.access.project, reissueTarget(c, await resolveReissue(q, c))),", to: 'reissue: !!c.access.isPm,' }] },
  // ── 修订批二（下标 550–557 为本批新增；P30：过滤自检之外再跑 --self-test --full --mutations 550-557）──
  // MED-1：submit 标志与执行同源——读接口的标志忽略某个项目级事实，而执行端点仍用它（标志为真、执行 409）
  {"id":"C4a MED-1：读接口 submit 标志不看 initiationEffective（恒视为立项包已生效）","expect":["C4a actions 与执行一致"],"edits":[{"file":"packages.js","from":"const facts = await versionFactsOf(q, pkg, ver, access.project);","to":"const facts = Object.assign(await versionFactsOf(q, pkg, ver, access.project), { initiationEffective: true });"}]},
  {"id":"C4a MED-1：读接口 submit 标志不看 confirmersMissing（恒视为确认人齐全）","expect":["C4a actions 与执行一致"],"edits":[{"file":"packages.js","from":"const facts = await versionFactsOf(q, pkg, ver, access.project);","to":"const facts = Object.assign(await versionFactsOf(q, pkg, ver, access.project), { confirmersMissing: null });"}]},
  {"id":"C4a MED-1：提交端点的项目级事实恒视为齐全（执行端不再核对立项前置与确认人）","expect":["C4a 提交：失败分支","C4a 提交 P37","C4a actions 与执行一致"],"edits":[{"file":"confirm.js","from":"const facts = await versionFactsOf(q, pkg, ver, access.project);","to":"const facts = Object.assign(await versionFactsOf(q, pkg, ver, access.project), { confirmersMissing: null, initiationEffective: true });"}]},
  { id: 'C4a MED-1：提交判定的事实缺失时放行（确认人事实没取到不 fail-closed）', expect: ['C4a rules：新动作'], edits: [{ file: 'rules.js', from: "if (cm === undefined) return CONFIRMERS_UNKNOWN_MESSAGE;\n      if (cm !== null) return cm.noParty ? NO_DEMAND_PARTY_MESSAGE : `以下参与方缺少必需确认人", to: "if (cm === undefined) return null;\n      if (cm !== null) return cm.noParty ? NO_DEMAND_PARTY_MESSAGE : `以下参与方缺少必需确认人" }] }, // 锚点带上下一行（C4 起 `cm === undefined` 在 rules.js 里只剩这一处，带不带都唯一，保持原样不动）
  { id: 'C4a MED-1：提交判定的立项事实缺失时放行（只拦明确为假）', expect: ['C4a rules：新动作'], edits: [{ file: 'rules.js', from: "t.packageType === 'overall' && t.initiationEffective !== true", to: "t.packageType === 'overall' && t.initiationEffective === false" }] },
  // LOW-1 / LOW-2：formBaselines 双向核对
  {"id":"C4a LOW-1：提交记录里的节点既无基线又不会形成基线仍放行（去掉反向核对）","expect":["C4a 生效 LOW-1 / LOW-2"],"edits":[{"file":"confirm-core.js","from":"if (current.blocked || recorded.length !== current.entries.length) throw snapshotError();","to":"if (current.blocked) return []; if (recorded.length !== current.entries.length) throw snapshotError();"}]},
  {"id":"C4a LOW-1：反向核对不认已有基线（提交记录里的节点只要不是本次形成的一律拦）","expect":["C4a 生效 LOW-1 / LOW-2"],"edits":[{"file":"confirm-core.js","from":"if (existing.package_version_id !== versionId || existing.planned_start !== start || existing.planned_end !== end) throw snapshotError();","to":"throw snapshotError();"}]},
  // ── 修订批三（codex 19 号：H-1 / H-2 / M-1 / M-2 / M-3；P30：过滤自检之外再跑 --self-test --full --mutation-ids <本批新增与改动的变异 id 名单>，名单见 tmp/c4a/fix4_ids_41.json；下标 558–586 只作快速定位）──
  // H-1 / P43 提交前置「计划齐全」（标志与执行同源、事实缺失 fail-closed）
  {"id":"C4a H-1：读接口 submit 标志不看 planMissing（恒视为计划齐全）","expect":["C4a actions 与执行一致","C4a H-1（P43）提交前置"],"edits":[{"file":"packages.js","from":"const facts = await versionFactsOf(q, pkg, ver, access.project);","to":"const facts = Object.assign(await versionFactsOf(q, pkg, ver, access.project), { planMissing: null });"}]},
  {"id":"C4a H-1：提交端点恒视为计划齐全（执行端不再核对计划）","expect":["C4a H-1（P43）提交前置","C4a actions 与执行一致"],"edits":[{"file":"confirm.js","from":"const facts = await versionFactsOf(q, pkg, ver, access.project);","to":"const facts = Object.assign(await versionFactsOf(q, pkg, ver, access.project), { planMissing: null });"}]},
  { id: 'C4a H-1：计划事实缺失时放行（不 fail-closed）', expect: ['C4a rules：新动作'], edits: [{ file: 'rules.js', from: 'if (t.planMissing === undefined) return PLANS_UNKNOWN_MESSAGE;', to: '' }] },
  {"id":"C4a H-1：缺计划的判定去掉（规则层）","expect":["C4a rules：新动作","C4a H-1（P43）提交前置"],"edits":[{"file":"rules.js","from":"if (t.planMissing !== null) return t.planMissing;","to":""}]},
  {"id":"C4a H-1：合并形态只要求项目层节点有计划","expect":["C4a H-1（P43）提交前置"],"edits":[{"file":"scope-plans.js","from":"return missing.length ? planBlocked","to":"return missing.length && !entries.some((p) => p.layer === 'project') ? planBlocked"}]},
  {"id":"C4a H-1：缺计划的判定不限本项目","expect":["C4a H-1（P43）提交前置"],"edits":[{"file":"scope-plans.js","from":"WHERE project_id = ? AND (batch_id IS NULL OR batch_id = ?)","to":"WHERE (project_id = ? OR 1 = 1) AND (batch_id IS NULL OR batch_id = ?)"}]},
  // H-2 确认页排期用提交快照
  {"id":"C4a H-2：确认页节点名称读节点现值","expect":["C4a H-2"],"edits":[{"file":"scope-plans.js","from":"  return plans;\n}","to":"  for (const item of plans) item.name = (await q.get('SELECT name FROM sysbuild_nodes WHERE id = ?', [item.node_id])).name;\n  return plans;\n}"}]},
  {"id":"C4a H-2：确认页批次名称读批次现值","expect":["C4a H-2"],"edits":[{"file":"scope-plans.js","from":"  return plans;\n}","to":"  for (const item of plans) if (item.batch_id !== null) item.batch_name = (await q.get('SELECT name FROM sysbuild_batches WHERE id = ?', [item.batch_id])).name;\n  return plans;\n}"}]},
  {"id":"C4a H-2：提交快照不存节点名称","expect":["C4a 提交：总体规划包成功","C4a H-2"],"edits":[{"file":"scope-plans.js","from":"node_id: node.id, name: node.name,","to":"node_id: node.id, name: null,"}]},
  {"id":"C4a H-2：提交快照的层写反","expect":["C4a 提交：总体规划包成功","C4a H-2"],"edits":[{"file":"scope-plans.js","from":"layer: node.batch_id === null ? 'project' : 'batch'","to":"layer: node.batch_id === null ? 'batch' : 'project'"}]},
  {"id":"C4a H-2：提交快照不存批次名称","expect":["C4a 提交：总体规划包成功","C4a H-2"],"edits":[{"file":"scope-plans.js","from":"batch_name: node.batch_id === null ? null : batch.name,","to":"batch_name: null,"}]},
  {"id":"C4a H-2：提交快照不存模板键","expect":["C4a 提交：总体规划包成功","C4a H-2"],"edits":[{"file":"scope-plans.js","from":"name: node.name, template_key: node.template_key,","to":"name: node.name, template_key: null,"}]},
  // M-1 合并包生效推进批次
  { id: 'C4a M-1：合并形态生效不推进批次', expect: ['C4a M-1'], edits: [{ file: 'confirm-core.js', from: "pkg.type === 'overall' && ver.form === 'overall_batch_req' ? await advancePlanningBatches(", to: "false ? await advancePlanningBatches(" }] },
  { id: 'C4a M-1：普通形态生效也推进批次', expect: ['C4a M-1：合并形态'], edits: [{ file: 'confirm-core.js', from: "pkg.type === 'overall' && ver.form === 'overall_batch_req' ? await advancePlanningBatches(", to: "pkg.type === 'overall' ? await advancePlanningBatches(" }] },
  { id: 'C4a M-1：立项包生效也推进批次', expect: ['C4a 生效：立项包', 'C4a M-1'], edits: [{ file: 'confirm-core.js', from: "pkg.type === 'overall' && ver.form === 'overall_batch_req' ? await advancePlanningBatches(", to: "(pkg.type === 'overall' && ver.form === 'overall_batch_req') || pkg.type === 'initiation' ? await advancePlanningBatches(" }] },
  { id: 'C4a M-1：已是进行中的批次也重复推进并写事件', expect: ['C4a M-1'], edits: [
    { file: 'confirm-core.js', from: "SELECT id FROM sysbuild_batches WHERE project_id = ? AND status = 'planning' ORDER BY seq, id", to: "SELECT id FROM sysbuild_batches WHERE project_id = ? AND status IN ('planning', 'active') ORDER BY seq, id" },
    { file: 'confirm-core.js', from: "'UPDATE sysbuild_batches SET status = ? WHERE id = ? AND status = ?', ['active', b.id, 'planning']", to: "'UPDATE sysbuild_batches SET status = ? WHERE id = ?', ['active', b.id]" },
  ] },
  { id: 'C4a M-1：推进不限本项目的批次', expect: ['C4a M-1'], edits: [{ file: 'confirm-core.js', from: "SELECT id FROM sysbuild_batches WHERE project_id = ? AND status = 'planning' ORDER BY seq, id", to: "SELECT id FROM sysbuild_batches WHERE (project_id = ? OR 1 = 1) AND status = 'planning' ORDER BY seq, id" }] },
  { id: 'C4a M-1：推进批次不写状态事件', expect: ['C4a M-1'], edits: [{ file: 'confirm-core.js', from: "await emit(q, user, projectId, 'batch', b.id, 'batch_status_changed',", to: "if (false) await emit(q, user, projectId, 'batch', b.id, 'batch_status_changed'," }] },
  // M-2 确认页返回无书面证据声明
  // M-3 按决策分设勾选文案
  { id: 'C4a M-3：勾选文案不按决策匹配（一律认确认那一条）', expect: ['C4a 决策：400 各分支', 'C4a 决策：成功路径'], edits: [{ file: 'confirm.js', from: 'body.checkbox_text !== core.checkboxTextsOf(c.task.purpose)[decision]', to: 'body.checkbox_text !== core.checkboxTextsOf(c.task.purpose).confirm' }] },
  { id: 'C4a M-3：确认记录保存确认那一条文案（而不是实际提交的）', expect: ['C4a 决策：成功路径'], edits: [{ file: 'confirm.js', from: 'uid, decision, body.checkbox_text, reason, view.id]', to: 'uid, decision, core.CHECKBOX_TEXTS.confirm, reason, view.id]' }] },
  { id: 'C4a M-3：任务详情只返回确认那一条文案', expect: ['C4a 浏览：'], edits: [{ file: 'confirm.js', from: 'checkbox_texts: core.checkboxTextsOf(c.task.purpose),', to: 'checkbox_texts: { confirm: core.checkboxTextsOf(c.task.purpose).confirm },' }] },
  { id: 'C4a M-3：不认可的固定文案写成确认无误', expect: ['C4a 决策：400 各分支', 'C4a 浏览：', 'C4a 决策：成功路径'], edits: [{ file: 'confirm-core.js', from: "reject: '我已阅读以上全部内容，不认可（原因见下）',", to: "reject: '我已阅读以上全部内容，确认无误'," }] },
];

module.exports = { makeConfirmHelpers, defineConfirmCases, CONFIRM_MUTATIONS };
