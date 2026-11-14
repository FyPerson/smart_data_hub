// 验证脚本库：项目管理（系统建设记录）模块 C4a——内容包提交与确认、撤回、任务改发、浏览记录、平台确认、包生效与基线、需求条目提出人确认、待我确认（#113 段 4 C4a）的用例
//   方案：docs/local/系统建设记录/系统建设记录_平台集成_方案_20261030_v1.2.md §2.2 不变量 2–5 / 9、§4.2、§4.4、§4.5、§5、§6.2、§7「确认」组
//   派单：docs/local/系统建设记录/送审准备/C4a_提交确认生效基线_派单_20261101.md §3
//
// 本文件只放用例、共用助手与变异，由 sysbuild-api-suite.js 登记（同一套夹具、同一个变异自检）。期望值一律手写，不取自被测代码。
//   makeConfirmHelpers(T)：「生产路径生效」共用助手——交接 ②：C3 的夹具直接把总体规划版本改成 effective 并插 baseline，C4a 起凡是能经生产路径
//     到达的 effective 用例都改用 produceEffectiveOverall（造需求部门参与方 + 条目 + 提交 + 全部确认）；经生产路径到不了的状态
//     （总体规划版本被替代、已有生效版本之后再出草稿等，C5 正式变更前不可达）保留夹具，用例名标「（夹具）」。
// 夹具规则：建项走 POST /projects；包 / 版本 / 条目 / 提交 / 撤回 / 浏览 / 决策 / 改发全部走生产端点。只有这几类直接写库：
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
  const { U, api, sqlRun, sqlGet, sqlAll, addMember, addParty, addAppointment, addDelegation } = T;
  const post = (uid, url, body) => api(uid, 'POST', url, body === undefined ? {} : body);
  const get = (uid, url) => api(uid, 'GET', url);
  let projSeq = 0;
  let attSeq = 0;
  const runTag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  async function newProject(buildType, pm) {
    projSeq += 1;
    const r = await post(pm || U.pm, '/sysbuild/projects', { system_name: `确认测试项目${projSeq}`, build_type: buildType || 'inhouse' });
    assert.strictEqual(r.status, 201, r.text);
    return r.body.project.id;
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
  async function mkItem(pid, extra, uid) {
    const body = Object.assign({ content: '需求：支持按部门导出', proposer_name: '外部张三' }, EV, extra || {});
    const r = await post(uid || U.pm, `/sysbuild/projects/${pid}/items`, body);
    assert.strictEqual(r.status, 201, r.text);
    return r.body.item;
  }
  async function mkPackage(pid, type, batchId) {
    const r = await post(U.pm, `/sysbuild/projects/${pid}/packages`, batchId ? { type, batch_id: batchId } : { type });
    assert.strictEqual(r.status, 201, r.text);
    return r.body.package.id;
  }
  async function mkVersion(pkid) {
    const r = await post(U.pm, `/sysbuild/packages/${pkid}/versions`);
    assert.strictEqual(r.status, 201, r.text);
    return r.body.version.id;
  }
  async function addToSet(vid, itemVersionId, batchId) {
    const r = await post(U.pm, `/sysbuild/package-versions/${vid}/items`, Object.assign({ op: 'add', item_version_id: itemVersionId }, batchId ? { committed_batch_id: batchId } : {}));
    assert.strictEqual(r.status, 201, r.text);
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
  // 立项包前置（P37）：总体规划包提交前须本项目立项包已有生效版本。
  //   produceEffectiveInitiation = 生产路径（建立项包 / 草稿 / 提交 / 全部确认；项目里已有立项包则在它上面再出一个草稿版本）；
  //   seedEffectiveInitiation = 夹具（直接写一个已生效的立项包版本，不产生任务 / 浏览 / 事件）——只给「并不关心立项包」的提交用例准备前置，
  //   避免它的任务 / 确认 / 生效事件混进以项目为范围的计数与事件断言。
  async function produceEffectiveInitiation(pid) {
    const has = await sqlGet("SELECT id FROM sysbuild_packages WHERE project_id = ? AND type = 'initiation'", [pid]);
    const pk = has ? has.id : await mkPackage(pid, 'initiation');
    const pv = await mkVersion(pk);
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
      "INSERT INTO sysbuild_package_versions (package_id, version_no, form, status, effective_at, snapshot_json, created_by) VALUES (?, 1, NULL, 'effective', datetime('now','localtime'), '{}', ?)",
      [pk, U.pm]
    )).lastID;
    return { pk, pv };
  }
  // 交接 ② 共用助手：经生产路径让 pid 的总体规划版本生效——补一个需求部门参与方（负责人 own + 代表人 del，已有则不补）、立项包生效（P37 前置，已有生效版本则不补）、
  //   一条条目、总体规划包、草稿版本（挂条目到默认批次）、提交、全部确认。返回 { pk, pv, itemVersionId, party }。pid 里已有同类包时复用（opts.pk / opts.itemVersionId）。
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
    const pv = await mkVersion(pk);
    const itemVersionId = o.itemVersionId || (await mkItem(pid)).versions[0].id;
    await addToSet(pv, itemVersionId, await defaultBatchId(pid));
    if (!o.noPlans) await planAllNodes(pid); // H-1：提交前计划须齐全（用例已给个别节点设的计划保留，其余补齐）
    const sub = await post(U.pm, `/sysbuild/package-versions/${pv}/submit`);
    assert.strictEqual(sub.status, 200, sub.text);
    await confirmAll(pv);
    const v = await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id = ?', [pv]);
    assert.strictEqual(v.status, 'effective', '生产路径生效后版本应为 effective');
    return { pk, pv, itemVersionId, party };
  }
  // ── C6a 共用助手：经生产路径让批次正式上线（确认试运行结束，POST /batches/:bid/golive）与撤销 ───────────────────────────────────────────────────────────
  //   readyForGolive：满足上线前置——批次验收包（建包 / 草稿 / 提交 / 全部确认）经生产路径生效，本批除里程碑外的节点全部（开始并）收口；只用于「批次进行中、没有别的未结登记」的场景，
  //   有登记要办理的用例自己先办结。productionGolive / productionRevoke：调端点并断言 200；上线事件时刻默认回拨一小时（「已正式上线」要求当前时刻严格晚于事件时刻，
  //   不回拨的话刚上线的同一秒内读到的是「未上线」，用例不能依赖墙钟）。
  async function acceptEffective(pid, batchId) {
    const pk = await mkPackage(pid, 'batch_accept', batchId);
    const pv = await mkVersion(pk);
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
  return {
    newProject, defaultBatchId, seedParty, stageAtt, mkItem, mkPackage, mkVersion, addToSet, tasksOf, openTask, decideBodyOf, decideRaw, openAndDecide, confirmAll,
    planAllNodes, PLAN_START, PLAN_END, produceEffectiveInitiation, seedEffectiveInitiation, produceEffectiveOverall,
    acceptEffective, closeBatchNodes, readyForGolive, productionGolive, productionRevoke,
  };
}

function defineConfirmCases(T) {
  const { test, U, api, sqlRun, sqlGet, sqlAll, expectErr, eventsOf, addMember, addParty, addAppointment, addDelegation, confirm: H } = T;
  const post = (uid, url, body) => api(uid, 'POST', url, body === undefined ? {} : body);
  const get = (uid, url) => api(uid, 'GET', url);
  const payloads = async (pid, type) => (await eventsOf(pid, type)).map((e) => JSON.parse(e.payload_json));
  const { newProject, defaultBatchId, seedParty, stageAtt, mkItem, mkPackage, mkVersion, addToSet, tasksOf, openTask, decideBodyOf, decideRaw, openAndDecide, confirmAll, produceEffectiveInitiation, seedEffectiveInitiation, planAllNodes, PLAN_START, PLAN_END } = H;
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
       FROM sysbuild_node_schedule_records r JOIN sysbuild_nodes n ON n.id = r.node_id WHERE n.project_id = ? AND r.kind = 'baseline' ORDER BY r.node_id`,
    [pid]
  );
  const baselineCount = async (pid) => (await baselinesIn(pid)).length;
  // 自研项目（newProject 的默认建设方式）建项带出的节点，手写：[模板键, 名称, 层]，节点编号按建项插入顺序升序（项目层 3 个在前，默认批次「第 1 批」的 3 个在后）。
  const INHOUSE_NODES = [
    ['p_initiation', '立项与授权', 'project'], ['p_overall', '总体范围与批次规划', 'project'], ['p_closing', '整体验收结项', 'project'],
    ['b_req', '需求确认', 'batch'], ['b_dev', '开发完成（含设计）', 'batch'], ['b_golive', '上线（含测试与验收）', 'batch'],
  ];
  const nodeIdOf = async (pid, key) => (await sqlGet('SELECT id FROM sysbuild_nodes WHERE project_id = ? AND template_key = ?', [pid, key])).id;
  // 自研项目全部节点都按 planAllNodes 补过计划（或经 plans 覆盖个别节点日期 [起, 止]）时，提交事件 node_plans 的期望值（H-2 快照字段手写，不取自被测代码）。
  //   cancelled = 已取消的模板键（不进清单）。
  async function inhouseNodePlans(pid, plans, cancelled) {
    const batch = await defaultBatchId(pid);
    const out = [];
    for (const [key, name, layer] of INHOUSE_NODES) {
      if ((cancelled || []).includes(key)) continue;
      const [ps, pe] = (plans && plans[key]) || [PLAN_START, PLAN_END];
      out.push({
        node_id: await nodeIdOf(pid, key), name, layer, batch_id: layer === 'batch' ? batch : null, batch_name: layer === 'batch' ? '第 1 批' : null,
        template_key: key, planned_start: ps, planned_end: pe,
      });
    }
    return out;
  }
  const memberRow = async (pid, uid) => (await sqlGet('SELECT id FROM sysbuild_members WHERE project_id = ? AND user_id = ? AND removed_at IS NULL ORDER BY id LIMIT 1', [pid, uid])).id;

  // 标准场景：甲部（负责人 own、代表人 del）、乙部（负责人 x1、代表人 x2）、条目带一个证据附件、总体规划包草稿已提交。返回各编号与 4 个任务。
  //   立项包前置（P37）用夹具 seedEffectiveInitiation（不产生任务 / 确认事件）；opt.noInitiation = 不补；opt.prepare(pid) = 提交之前的准备（如给节点设计划：
  //   总体规划待确认期间排期被冻结，P34，所以要在提交前做完）。计划齐全前置（H-1）：prepare 之后用 planAllNodes 把其余节点补齐（11-02 ~ 11-30）；opt.noPlans = 不补。
  async function mkSubmitted(opt) {
    const o = opt || {};
    const pid = await newProject();
    const A = await seedParty(pid, '甲部', U.own, U.del);
    const B = o.single ? null : await seedParty(pid, '乙部', U.x1, U.x2);
    if (!o.noInitiation) await seedEffectiveInitiation(pid);
    const att = o.noAtt ? null : await stageAtt(pid, U.pm, 'a');
    const item = await mkItem(pid, att ? { attachment_ids: [att], no_written_evidence: undefined, no_evidence_reason: undefined } : {});
    const pk = await mkPackage(pid, 'overall');
    const pv = await mkVersion(pk);
    const batch = await defaultBatchId(pid);
    await addToSet(pv, item.versions[0].id, batch);
    if (o.prepare) await o.prepare(pid);
    if (!o.noPlans) await planAllNodes(pid); // H-1：提交前计划须齐全；prepare 里设过计划的节点保留，其余补齐（opt.noPlans = 不补，用来造「缺计划」）
    const sub = await submit(U.pm, pv);
    assert.strictEqual(sub.status, 200, sub.text);
    const tasks = await tasksOf(pv);
    const by = {};
    for (const t of tasks) by[t.user_id] = t;
    return { pid, A, B, att, item, pk, pv, batch, sub, tasks, T: { aOwner: by[U.own], aDel: by[U.del], bOwner: by[U.x1], bDel: by[U.x2] } };
  }
  // 未提交的合格草稿（可对其做各种破坏后再提交）：甲部（own / del）+ 立项包已生效（夹具，opt.noInitiation 不补）+ 一条无附件但声明无书面证据的条目。
  async function mkDraft(opt) {
    const o = opt || {};
    const pid = await newProject();
    const A = o.noParty ? null : await seedParty(pid, '甲部', U.own, o.noDelegate ? null : U.del);
    const ini = o.noInitiation ? null : await seedEffectiveInitiation(pid);
    const item = await mkItem(pid);
    const pk = await mkPackage(pid, 'overall');
    const pv = await mkVersion(pk);
    const batch = await defaultBatchId(pid);
    if (!o.emptySet) await addToSet(pv, item.versions[0].id, o.noBatch ? null : batch);
    if (!o.noPlans) await planAllNodes(pid); // H-1：计划齐全（opt.noPlans = 不补）
    return { pid, A, item, pk, pv, batch, ini };
  }

  // ── rules：手写期望（四个新动作的项目状态类别与目标判定）───────────────────────────────────────────
  test('C4a rules：新动作的项目状态类别手写核对——提交 / 撤回 / 改发 = maintain 行（进行中 / 已暂停 是，已终止 / 已结项 否），决策 = accept 行；只读账号否决提交类但不否决本人决策；决策的错误码', async () => {
    const R = T.getMods().rules;
    const kinds = { package_version_submit: 'maintain', package_version_withdraw: 'maintain', confirm_reissue: 'maintain', confirm_decide: 'accept' };
    for (const [op, k] of Object.entries(kinds)) assert.strictEqual(R.OP_KIND[op], k, `${op} 的类别`);
    const rowAllowed = { active: true, paused: true, terminated: false, closed: false };
    const pm = { isPm: true, isReadonly: false };
    // 提交的项目级事实（修订批二 MED-1）：确认人齐全（confirmersMissing = null）、立项包已生效；缺失按 fail-closed 拒绝（下面单独断言）
    const F = { confirmersMissing: null, initiationEffective: true, planMissing: null, historyConflict: null, otherPendingPackage: null }; // 修订批三 H-1：总体规划包还要「计划齐全」（planMissing = null）；C4b Q-S2：历史互斥事实 historyConflict 缺失 fail-closed，手写目标补 null；C6a：总体规划 / 变更 / 批次验收 / 结项四类要「没有别的待确认内容包」（otherPendingPackage = null）
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
    assert.strictEqual(subV({ confirmersMissing: { noParty: false, missing: ['甲部（缺现任负责人）', '乙部（缺生效代表人）'] } }).message, '以下参与方缺少必需确认人：甲部（缺现任负责人）、乙部（缺生效代表人）');
    assert.strictEqual(subV({ initiationEffective: false }).message, '项目立项包还没有生效版本，总体规划不能提交确认（立项通过后总体范围与批次规划才生效）');
    assert.strictEqual(subV({ confirmersMissing: { noParty: true, missing: [] }, initiationEffective: false }).message, NOPARTY, '两类前置都不满足时先报确认人');
    assert.strictEqual(R.opAllowed('package_version_submit', pm, { status: 'active' }, subT({ initiationEffective: false, packageType: 'initiation' })), true, '立项包自己的提交不受立项前置约束');
    assert.strictEqual(R.opAllowed('package_version_submit', pm, { status: 'active' }, subT({ confirmersMissing: { noParty: false, missing: ['丙部（缺现任负责人）'] }, packageType: 'initiation' })), false, '立项包同样要求确认人齐全');
    assert.strictEqual(R.opAllowed('package_version_submit', pm, { status: 'active' }, { versionStatus: 'draft', packageType: 'overall', historyConflict: null, otherPendingPackage: null }), false, '事实没取到（confirmersMissing 缺失）：fail-closed（historyConflict / otherPendingPackage 补 null：只让 confirmersMissing 一项缺失，不被历史互斥与待确认互斥的 fail-closed 遮蔽）');
    assert.strictEqual(R.opAllowed('package_version_submit', pm, { status: 'active' }, { versionStatus: 'draft', packageType: 'overall', confirmersMissing: null, planMissing: null, historyConflict: null, otherPendingPackage: null }), false, '总体规划包：立项事实没取到 fail-closed（其余事实齐全，避免被计划事实缺失遮蔽）');
    // 计划齐全（修订批三 H-1 / P43，手写文案）：排在确认人、立项前置之后；undefined = 事实没取到 fail-closed；只对总体规划包判
    const PLAN_HEAD = '以下节点还没有计划起止日期，总体规划提交前须先补齐（总体排期基线是确认对象）：';
    const pmiss = subV({ planMissing: ['立项与授权', '需求确认（第 1 批）'] });
    assert.deepStrictEqual([pmiss.status, pmiss.code, pmiss.message], [409, 'SYSBUILD_STATE', `${PLAN_HEAD}立项与授权、需求确认（第 1 批）`]);
    assert.strictEqual(subV({ planMissing: undefined }).message, '无法确定节点计划是否齐全，请刷新后重试', '计划事实没取到：fail-closed');
    assert.strictEqual(R.opAllowed('package_version_submit', pm, { status: 'active' }, { versionStatus: 'draft', packageType: 'overall', confirmersMissing: null, initiationEffective: true, historyConflict: null, otherPendingPackage: null }), false, '总体规划包：计划事实没取到 fail-closed');
    assert.strictEqual(subV({ planMissing: ['x'], initiationEffective: false }).message, '项目立项包还没有生效版本，总体规划不能提交确认（立项通过后总体范围与批次规划才生效）', '立项前置先于计划齐全');
    assert.strictEqual(subV({ planMissing: ['x'], confirmersMissing: { noParty: true, missing: [] } }).message, NOPARTY, '确认人先于计划齐全');
    assert.strictEqual(R.opAllowed('package_version_submit', pm, { status: 'active' }, subT({ packageType: 'initiation', planMissing: ['x'] })), true, '立项包不要求计划齐全');
    assert.deepStrictEqual(R.SUBMITTABLE_PACKAGE_TYPES.slice(), ['overall', 'initiation', 'change', 'batch_accept', 'closing'], '提交开放的包类型清单（P35 的待确认包判定读同一份；C5 S-S1c 加入变更包；C6a 加入批次验收包与结项包）');
    // 批次冻结：批次包所在批次已转出 / 被替代，提交 / 撤回 / 改发一律拒绝
    for (const bs of ['transferred', 'superseded']) {
      assert.strictEqual(R.opAllowed('package_version_submit', pm, { status: 'active' }, Object.assign({ versionStatus: 'draft', packageType: 'overall', batchStatus: bs }, F)), false, `提交 × 批次 ${bs}`);
      assert.strictEqual(R.opAllowed('package_version_withdraw', pm, { status: 'active' }, { versionStatus: 'pending', batchStatus: bs }), false, `撤回 × 批次 ${bs}`);
      assert.strictEqual(R.opAllowed('confirm_reissue', pm, { status: 'active' }, Object.assign({}, targets.confirm_reissue, { batchStatus: bs })), false, `改发 × 批次 ${bs}`);
    }
    // 改发：只对包版本任务；只在包版本待确认、当前修订 pending / objected / rejected 时可用
    // C4b P48：条目版本任务（提出人确认）的改发放开（原断言 false「条目版本任务的改发 C4b 起可用」随契约改为 true）；邀请 / 授权类任务（代录时同事务建立、当场已确认）没有改发
    assert.strictEqual(R.opAllowed('confirm_reissue', pm, { status: 'active' }, Object.assign({}, targets.confirm_reissue, { objectType: 'item_version' })), true, 'P48：条目版本任务可改发');
    for (const ot of ['invitation', 'delegation', 'conclusion', 'bogus']) {
      assert.strictEqual(R.opAllowed('confirm_reissue', pm, { status: 'active' }, Object.assign({}, targets.confirm_reissue, { objectType: ot })), false, `改发 × 对象类型 ${ot}`);
    }
    // C6a：交接确认任务（handover，重新解析该参与方的生效代表人）可改发（原断言「handover 不能改发」随契约改为 true）
    assert.strictEqual(R.opAllowed('confirm_reissue', pm, { status: 'active' }, Object.assign({}, targets.confirm_reissue, { objectType: 'handover' })), true, 'C6a：交接确认任务可改发');
    // C5 S-S1c：开发方关键事项认可任务（dev_entry）的改发放开（重新解析开发方现任负责人；判定矩阵在 sysbuild-api-suite-devkey.js 的 rules 用例）
    assert.strictEqual(R.opAllowed('confirm_reissue', pm, { status: 'active' }, Object.assign({}, targets.confirm_reissue, { objectType: 'dev_entry' })), true, 'S-S1c：开发方关键事项任务可改发');
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
    const node = { nodeStatus: 'not_started', templateKey: 'b_dev', isMilestone: false, isProjectLayer: false, batchStatus: 'planning', hasBaseline: false, corrects: null };
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
    for (const who of [pm, adm]) {
      assert.strictEqual(R.opAllowed('party_add', who, active, { side: 'demand', hasDevParty: false, hasPendingContentPackage: false }), true);
      const v = R.checkOp('party_add', who, active, { side: 'demand', hasDevParty: false, hasPendingContentPackage: true });
      assert.ok(v && v.status === 409 && v.code === 'SYSBUILD_STATE' && v.message === '有待确认的内容包，请先撤回提交', `实际 ${JSON.stringify(v)}`);
      assert.strictEqual(R.opAllowed('party_add', who, active, { side: 'dev', hasDevParty: false, hasPendingContentPackage: true }), true, '开发方不受待确认内容包影响');
    }
  });

  // ── 提交 ───────────────────────────────────────────────────────────────────────────────────────
  test('C4a 提交：总体规划包成功——状态、必需确认人（两个需求部门的负责人 + 代表人共 4 条）手写核对、冻结清单（条目绑定 ∪ 引用 + 包材料附件）、事件、snapshot 此后不可改', async () => {
    const pid = await newProject();
    const A = await seedParty(pid, '甲部', U.own, U.del);
    const B = await seedParty(pid, '乙部', U.x1, U.x2);
    await seedEffectiveInitiation(pid); // P37 前置（夹具）
    const a1 = await stageAtt(pid, U.pm, 'a');
    const a2 = await stageAtt(pid, U.pm, 'd');
    const it1 = await mkItem(pid, { attachment_ids: [a1], no_written_evidence: undefined, no_evidence_reason: undefined });
    const v2 = await post(U.pm, `/sysbuild/items/${it1.id}/versions`, { content: '修订后的需求', attachment_ids: [a2], ref_attachment_ids: [a1] });
    assert.strictEqual(v2.status, 201, v2.text);
    const it2 = await mkItem(pid);
    const pk = await mkPackage(pid, 'overall');
    const pv = await mkVersion(pk);
    const batch = await defaultBatchId(pid);
    await addToSet(pv, v2.body.item_version_id, batch);
    await addToSet(pv, it2.versions[0].id, batch);
    // 夹具：包版本自己的材料附件（C4a 没有绑定它的端点，直接写绑定行），提交时要进冻结清单
    const a3 = await stageAtt(pid, U.pm, 'e');
    await sqlRun("INSERT INTO sysbuild_attachment_bindings (attachment_id, owner_type, owner_id, bound_by) VALUES (?, 'package_version', ?, ?)", [a3, pv, U.pm]);
    const before = (await rowOf('sysbuild_package_versions', pv)).snapshot_json;
    assert.strictEqual(await planAllNodes(pid), 6, 'H-1：自研项目 6 个节点（项目层 3 + 默认批次 3）补齐计划后才能提交');
    const r = await submit(U.pm, pv);
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body.version, { id: pv, package_id: pk, version_no: 1, status: 'pending' });
    const row = await rowOf('sysbuild_package_versions', pv);
    assert.deepStrictEqual([row.status, row.effective_at, row.snapshot_json], ['pending', null, before]);
    // 必需确认人（手写）：甲部负责人 own（依据任职）、甲部代表人 del（依据授权）、乙部负责人 x1、乙部代表人 x2
    const tasks = await tasksOf(pv);
    assert.strictEqual(tasks.length, 4);
    assert.deepStrictEqual(tasks.map((t) => [t.party_id, t.user_id, t.basis_appointment_id, t.basis_delegation_id]), [
      [A.party, U.own, A.apt, null], [A.party, U.del, null, A.dlg], [B.party, U.x1, B.apt, null], [B.party, U.x2, null, B.dlg],
    ]);
    assert.deepStrictEqual(tasks.map((t) => [t.rev_no, t.status, t.purpose, t.object_id, t.object_version_id]), [1, 2, 3, 4].map(() => [1, 'pending', 'package_confirm', pk, pv]));
    assert.deepStrictEqual(r.body.tasks.map((t) => [t.task_id, t.party_id, t.kind, t.required_member_id]), [
      [tasks[0].task_id, A.party, 'owner', A.mOwn], [tasks[1].task_id, A.party, 'delegate', A.mDel], [tasks[2].task_id, B.party, 'owner', B.mOwn], [tasks[3].task_id, B.party, 'delegate', B.mDel],
    ]);
    // 冻结清单：第 2 版条目的绑定 a2 ∪ 引用 a1，加包版本自己的材料 a3；条目 2 没有附件
    const expectFrozen = [{ attachment_id: a1, sha256: 'a'.repeat(64) }, { attachment_id: a2, sha256: 'd'.repeat(64) }, { attachment_id: a3, sha256: 'e'.repeat(64) }];
    assert.deepStrictEqual(await frozenOf('package_version', pv), expectFrozen);
    assert.deepStrictEqual(r.body.frozen_attachments, expectFrozen);
    // 事件（payload 不含附件原文件名，Q8）
    assert.deepStrictEqual(await payloads(pid, 'package_version_submitted'), [{
      package_id: pk, type: 'overall', version_no: 1, form: 'overall_batch_req', item_count: 2, task_ids: tasks.map((t) => t.task_id), frozen_attachment_ids: [a1, a2, a3],
      node_plans: await inhouseNodePlans(pid), // P34 + H-2：提交时各未取消节点的当前计划与名称 / 层 / 批次 / 模板快照（手写期望）；form / parent 没变化，所以没有 form_from 等键
    }]);
    const created = await payloads(pid, 'confirm_task_created');
    assert.strictEqual(created.length, 4);
    assert.deepStrictEqual(created[0], {
      revision_id: tasks[0].rev_id, rev_no: 1, object_type: 'package_version', object_id: pk, object_version_id: pv, purpose: 'package_confirm', party_id: A.party,
      required_member_id: A.mOwn, basis_appointment_id: A.apt, basis_delegation_id: null,
    });
    assert.strictEqual((await eventsOf(pid, 'attachment_frozen')).length, 3);
    assert.ok(!(await sqlAll('SELECT payload_json FROM sysbuild_events WHERE project_id = ?', [pid])).some((e) => String(e.payload_json).includes('确认证据')), '事件不含附件原文件名');
    // snapshot 此后不可改（版本已不是草稿）
    expectErr(await api(U.pm, 'PATCH', `/sysbuild/package-versions/${pv}`, { snapshot_json: { x: 1 } }), 409, 'SYSBUILD_STATE', '待确认版本不可改 snapshot');
    expectErr(await post(U.pm, `/sysbuild/package-versions/${pv}/items`, { op: 'remove', item_version_id: it2.versions[0].id }), 409, 'SYSBUILD_STATE', '待确认版本不可改集合');
    // 读接口：版本详情的 actions 随状态变化
    assert.deepStrictEqual((await get(U.pm, `/sysbuild/package-versions/${pv}`)).body.actions, { edit: false, add_item: false, remove_item: false, new_version: false, submit: false, withdraw: true, export_sheet: true }); // C4c：待确认版本可导出需求确认单
    // 任务清单读接口
    const list = await get(U.pm, `/sysbuild/package-versions/${pv}/confirm-tasks`);
    assert.strictEqual(list.status, 200, list.text);
    assert.deepStrictEqual(list.body.tasks.map((t) => [t.task_id, t.party_id, t.purpose, t.current_revision.rev_no, t.current_revision.status, t.current_revision.required_member_id]), [
      [tasks[0].task_id, A.party, 'package_confirm', 1, 'pending', A.mOwn], [tasks[1].task_id, A.party, 'package_confirm', 1, 'pending', A.mDel],
      [tasks[2].task_id, B.party, 'package_confirm', 1, 'pending', B.mOwn], [tasks[3].task_id, B.party, 'package_confirm', 1, 'pending', B.mDel],
    ]);
    expectErr(await get(U.out, `/sysbuild/package-versions/${pv}/confirm-tasks`), 404, 'SYSBUILD_NOT_FOUND', '非成员看任务清单');
  });

  test('C4a 提交：立项包成功——只要各需求部门负责人（不要代表人），没有条目集合，冻结清单为空', async () => {
    const pid = await newProject();
    const A = await seedParty(pid, '甲部', U.own, U.del);
    const B = await seedParty(pid, '乙部', U.x1, null);
    const pk = await mkPackage(pid, 'initiation');
    const pv = await mkVersion(pk);
    const r = await submit(U.pm, pv);
    assert.strictEqual(r.status, 200, r.text);
    const tasks = await tasksOf(pv);
    assert.deepStrictEqual(tasks.map((t) => [t.party_id, t.user_id, t.basis_appointment_id, t.basis_delegation_id]), [[A.party, U.own, A.apt, null], [B.party, U.x1, B.apt, null]], '甲部的代表人 del 不是立项包的必需确认人');
    assert.deepStrictEqual(r.body.frozen_attachments, []);
    assert.deepStrictEqual(await frozenOf('package_version', pv), []);
    assert.strictEqual(await verStatus(pv), 'pending');
    const ev = await payloads(pid, 'package_version_submitted');
    assert.deepStrictEqual(ev, [{ package_id: pk, type: 'initiation', version_no: 1, form: null, item_count: 0, task_ids: tasks.map((t) => t.task_id), frozen_attachment_ids: [] }]);
  });

  test('C4a 提交：失败分支（每条换一个不会先被别的规则拦下的输入）——非草稿 / 类型不开放 / 缺负责人 / 缺代表人 / 无需求部门 / 集合空 / 无承诺批次 / 承诺批次已转出 / 条目版本不属本项目', async () => {
    // 非草稿：提交过一次后再提交
    const d1 = await mkDraft();
    assert.strictEqual((await submit(U.pm, d1.pv)).status, 200);
    const again = await submit(U.pm, d1.pv);
    expectErr(again, 409, 'SYSBUILD_STATE', '非草稿');
    assert.ok(again.body.message.includes('只有草稿版本'), `非草稿提示实际 ${again.body.message}`);
    assert.strictEqual((await tasksOf(d1.pv)).length, 2, '被拒绝的重复提交不再生成任务');
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
    // 缺现任负责人：丙部有成员但没有现任任职（另有甲部齐全）
    const d3 = await mkDraft();
    const party3 = await addParty(d3.pid, '丙部', 'demand');
    await addMember(d3.pid, U.x1, { party: party3 });
    const r3 = await submit(U.pm, d3.pv);
    expectErr(r3, 409, 'SYSBUILD_STATE', '缺负责人');
    assert.ok(r3.body.message.includes('丙部（缺现任负责人）'), `缺负责人提示实际 ${r3.body.message}`);
    assert.strictEqual(await verStatus(d3.pv), 'draft');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE project_id = ? AND object_type = 'package_version'", [d3.pid]), 0, '被拒绝的提交不生成任务（立项包是夹具，本来就没有任务）');
    // 缺生效代表人：总体规划包要代表人，同项目的立项包只要负责人
    const d4 = await mkDraft({ noDelegate: true });
    const r4 = await submit(U.pm, d4.pv);
    expectErr(r4, 409, 'SYSBUILD_STATE', '缺代表人');
    assert.ok(r4.body.message.includes('甲部（缺生效代表人）'), `缺代表人提示实际 ${r4.body.message}`);
    const ini = await mkVersion(d4.ini.pk); // 立项包已存在（夹具生效版本），再出一个草稿版本
    assert.strictEqual((await submit(U.pm, ini)).status, 200, '同一项目的立项包不需要代表人');
    // 负责人在位但成员无平台账号：C4b P44 起不再当作缺负责人（原断言 409「无账号部（缺现任负责人）」随契约改写）——无账号成员是「代录确认人」，提交成功并生成只能代录的任务
    //   （账号停用的负责人仍视为缺人：见进程内用例「C4a 确认人解析与资格同源」）；用立项包验证（它只要负责人）
    const pidNa = await newProject();
    const partyNa = await addParty(pidNa, '无账号部', 'demand');
    const mNa = (await sqlRun("INSERT INTO sysbuild_members (project_id, party_id, person_name, joined_at, added_by) VALUES (?, ?, '无账号负责人', '2026-10-01 10:00:00', ?)", [pidNa, partyNa, U.admin])).lastID;
    await addAppointment(partyNa, mNa, 'active');
    const pvNa = await mkVersion(await mkPackage(pidNa, 'initiation'));
    const rNa = await submit(U.pm, pvNa);
    assert.strictEqual(rNa.status, 200, `负责人无账号：提交成功 ${rNa.text}`);
    assert.deepStrictEqual(rNa.body.tasks.map((t) => [t.party_id, t.kind, t.required_member_id, t.proxy_only]), [[partyNa, 'owner', mNa, true]], '无账号负责人的任务带 proxy_only = true');
    // 项目没有需求部门参与方
    const d5 = await mkDraft({ noParty: true });
    const r5 = await submit(U.pm, d5.pv);
    expectErr(r5, 409, 'SYSBUILD_STATE', '无需求部门');
    assert.ok(r5.body.message.includes('需求部门参与方'), `无需求部门提示实际 ${r5.body.message}`);
    // 集合空
    const d6 = await mkDraft({ emptySet: true });
    const r6 = await submit(U.pm, d6.pv);
    expectErr(r6, 409, 'SYSBUILD_STATE', '集合空');
    assert.ok(r6.body.message.includes('集合为空'), `集合空提示实际 ${r6.body.message}`);
    // 条目没有承诺批次
    const d7 = await mkDraft({ noBatch: true });
    const r7 = await submit(U.pm, d7.pv);
    expectErr(r7, 409, 'SYSBUILD_STATE', '无承诺批次');
    assert.ok(r7.body.message.includes('没有承诺批次') && r7.body.message.includes('R-01'), `无承诺批次提示实际 ${r7.body.message}`);
    // 承诺批次已转出（先挂在正常批次上，再把批次改为已转出：夹具，C3 没有转出批次的生产路径）
    const d8 = await mkDraft();
    await sqlRun("UPDATE sysbuild_batches SET status = 'transferred', transfer_change_id = 1 WHERE id = ?", [d8.batch]);
    const r8 = await submit(U.pm, d8.pv);
    expectErr(r8, 409, 'SYSBUILD_STATE', '承诺批次已转出');
    assert.ok(r8.body.message.includes('承诺批次已转出'), `批次已转出提示实际 ${r8.body.message}`);
    // 承诺批次是别的项目的批次
    const d8b = await mkDraft();
    const foreignBatch = await defaultBatchId(await newProject());
    await sqlRun('UPDATE sysbuild_package_item_revisions SET committed_batch_id = ? WHERE package_version_id = ?', [foreignBatch, d8b.pv]);
    expectErr(await submit(U.pm, d8b.pv), 409, 'SYSBUILD_STATE', '承诺批次属于别的项目');
    // 条目版本不属本项目（夹具：端点不允许这样加，直接写修订行）
    const d9 = await mkDraft();
    const foreignItem = await mkItem(await newProject());
    await sqlRun("INSERT INTO sysbuild_package_item_revisions (package_version_id, item_version_id, committed_batch_id, op, created_by) VALUES (?, ?, ?, 'add', ?)", [d9.pv, foreignItem.versions[0].id, d9.batch, U.pm]);
    const r9 = await submit(U.pm, d9.pv);
    expectErr(r9, 409, 'SYSBUILD_STATE', '条目版本不属本项目');
    assert.ok(r9.body.message.includes('不属于本项目'), `不属本项目提示实际 ${r9.body.message}`);
    // 以上失败的版本全部仍是草稿
    for (const d of [d3, d4, d5, d6, d7, d8, d9]) assert.strictEqual(await verStatus(d.pv), 'draft');
  });

  test('C4a 提交：方向类证据按「未软删除的绑定 ∪ 引用」提交时重核——两条证据附件都被软删除 409；恢复被引用的那条（绑定仍删除）即通过，冻结清单只含它；声明无书面证据的条目不受附件影响', async () => {
    const pid = await newProject();
    await seedParty(pid, '甲部', U.own, U.del);
    await seedEffectiveInitiation(pid); // P37 前置（夹具）
    const a1 = await stageAtt(pid, U.pm, 'a');
    const a2 = await stageAtt(pid, U.pm, 'd');
    const it = await mkItem(pid, { attachment_ids: [a1], no_written_evidence: undefined, no_evidence_reason: undefined });
    const v2 = await post(U.pm, `/sysbuild/items/${it.id}/versions`, { content: '修订后', attachment_ids: [a2], ref_attachment_ids: [a1], no_written_evidence: undefined, no_evidence_reason: undefined });
    assert.strictEqual(v2.status, 201, v2.text);
    const noEv = await mkItem(pid); // 声明无书面证据（原因 ≥ 10 字）：附件与它无关
    const pk = await mkPackage(pid, 'overall');
    const pv = await mkVersion(pk);
    const batch = await defaultBatchId(pid);
    await addToSet(pv, v2.body.item_version_id, batch);
    await addToSet(pv, noEv.versions[0].id, batch);
    await planAllNodes(pid); // H-1：计划齐全，否则下面的 409 会先被「缺计划」遮蔽，测不到证据重核
    const del = (aid, on) => sqlRun(on ? 'UPDATE sysbuild_attachments SET deleted_at = NULL, deleted_by = NULL WHERE id = ?' : "UPDATE sysbuild_attachments SET deleted_at = '2026-10-30 10:00:00', deleted_by = 1 WHERE id = ?", [aid]);
    await del(a1, false);
    await del(a2, false);
    const r = await submit(U.pm, pv);
    expectErr(r, 409, 'SYSBUILD_STATE', '两条证据附件都已软删除');
    assert.ok(r.body.message.includes('方向类证据') && r.body.message.includes('R-01') && !r.body.message.includes('R-02'), `证据不齐提示实际 ${r.body.message}`);
    assert.strictEqual(await verStatus(pv), 'draft');
    await del(a1, true); // 恢复被引用的 a1；绑定的 a2 仍是软删除：证据只剩「引用」
    const ok = await submit(U.pm, pv);
    assert.strictEqual(ok.status, 200, ok.text);
    assert.deepStrictEqual(await frozenOf('package_version', pv), [{ attachment_id: a1, sha256: 'a'.repeat(64) }], '冻结清单不含已软删除的附件');
  });

  test('C4a 提交 P32：form 与 parent_overall_version_id 提交时按现状重算，与草稿存的值不同则在草稿条件下回写（不再 409），变化记进提交事件；没变化时事件不带这些键；非草稿版本回写被拒', async () => {
    // 草稿建好后批次数变化：建草稿时单批 = overall_batch_req，之后多出第二个批次（夹具：C3 没有新增批次端点）→ 提交时重算为 overall
    const dForm = await mkDraft();
    assert.strictEqual((await rowOf('sysbuild_package_versions', dForm.pv)).form, 'overall_batch_req');
    const seq2 = (await sqlGet('SELECT MAX(seq) AS m FROM sysbuild_batches WHERE project_id = ?', [dForm.pid])).m + 1;
    await sqlRun("INSERT INTO sysbuild_batches (project_id, seq, name, is_default, status) VALUES (?, ?, '夹具批次2', 0, 'planning')", [dForm.pid, seq2]);
    const r1 = await submit(U.pm, dForm.pv);
    assert.strictEqual(r1.status, 200, r1.text);
    const row1 = await rowOf('sysbuild_package_versions', dForm.pv);
    assert.deepStrictEqual([row1.status, row1.form, row1.parent_overall_version_id], ['pending', 'overall', null], 'form 回写为重算的新值');
    const ev1 = (await payloads(dForm.pid, 'package_version_submitted'))[0];
    assert.deepStrictEqual([ev1.form, ev1.form_from, ev1.form_to, hasOwn(ev1, 'parent_from'), hasOwn(ev1, 'parent_to')], ['overall', 'overall_batch_req', 'overall', false, false], '事件记 form 的变化（form 字段取回写后的值），没变的 parent 不记');
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

  test('C4a 提交：已上线条目不能换到未上线批次（夹具：总体规划第二版 C5 前无生产路径）——换批 409，留在已上线批次则通过', async () => {
    const pid = await newProject();
    await seedParty(pid, '甲部', U.own, U.del);
    const { pk, itemVersionId: itemV1 } = await H.produceEffectiveOverall(pid);
    const batch1 = await defaultBatchId(pid);
    const seq2 = (await sqlGet('SELECT MAX(seq) AS m FROM sysbuild_batches WHERE project_id = ?', [pid])).m + 1;
    const batch2 = (await sqlRun("INSERT INTO sysbuild_batches (project_id, seq, name, is_default, status) VALUES (?, ?, '夹具批次2', 0, 'planning')", [pid, seq2])).lastID;
    // 夹具：第 1 批已正式上线——C6a 起「已上线」的判据是上线事件（entries-core.batchLiveState），不再读 batches.status；事件时刻写成一小时前（严格早于当前时刻才算已上线）。
    //   经生产端点上线的完整路径在 sysbuild-api-suite-golive.js；这里只造「第 1 批已上线」这个事实，不关心上线前置，所以直接写事件。
    await sqlRun("INSERT INTO sysbuild_golive_events (batch_id, kind, handover_snapshot_json, created_by, created_at) VALUES (?, 'golive', '{}', ?, datetime('now','localtime','-1 hour'))", [batch1, U.pm]);
    // 夹具：D1 之后总体规划包不能直接建草稿，直接写第二个草稿版本与它的集合修订（承诺批次换成未上线的第 2 批）
    const v2 = (await sqlRun("INSERT INTO sysbuild_package_versions (package_id, version_no, form, status, snapshot_json, created_by) VALUES (?, 2, 'overall', 'draft', '{}', ?)", [pk, U.pm])).lastID;
    const rev = (await sqlRun("INSERT INTO sysbuild_package_item_revisions (package_version_id, item_version_id, committed_batch_id, op, created_by) VALUES (?, ?, ?, 'add', ?)", [v2, itemV1, batch2, U.pm])).lastID;
    const r = await submit(U.pm, v2);
    expectErr(r, 409, 'SYSBUILD_STATE', '已上线条目换到未上线批次');
    assert.ok(r.body.message.includes('已上线批次'), `换批提示实际 ${r.body.message}`);
    assert.strictEqual(await verStatus(v2), 'draft');
    await sqlRun('UPDATE sysbuild_package_item_revisions SET committed_batch_id = ? WHERE id = ?', [batch1, rev]); // 对照：仍挂在已上线的第 1 批
    assert.strictEqual((await submit(U.pm, v2)).status, 200, '留在已上线批次则通过');
  });

  // ── 撤回提交 ─────────────────────────────────────────────────────────────────────────────────────
  test('C4a 撤回：待确认 → 已被替代，本版本全部待确认修订 → 已失效（带原因），已确认的修订不动；撤回后可再建草稿（继承集合）；事件手写核对；权限与参数', async () => {
    const s = await mkSubmitted();
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
    const pendingRevs = [s.T.aDel, s.T.bOwner, s.T.bDel].map((t) => t.rev_id);
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
    // 撤回后：不能再撤回 / 再提交；失效修订的任务打开不写浏览记录、也不能决策；PM 可再建草稿（继承集合）
    expectErr(await withdraw(U.pm, s.pv, '再撤一次'), 409, 'SYSBUILD_STATE', '已被替代的版本再撤回');
    expectErr(await submit(U.pm, s.pv), 409, 'SYSBUILD_STATE', '已被替代的版本再提交');
    const o = await openTask(U.x1, s.T.bOwner.task_id);
    assert.strictEqual(o.status, 200, o.text);
    assert.strictEqual(o.body.view_id, null, '失效修订不写浏览记录');
    expectErr(await decideRaw(U.x1, s.T.bOwner.task_id, decideBodyOf(o.body, 'confirm')), 409, 'SYSBUILD_STATE', '失效修订不能决策');
    const nv = await post(U.pm, `/sysbuild/packages/${s.pk}/versions`);
    assert.strictEqual(nv.status, 201, nv.text);
    assert.deepStrictEqual([nv.body.version.version_no, nv.body.copied_items], [2, 1]);
  });

  test('C4a 撤回：草稿 / 已生效的版本不能撤回；已终止项目 409 SYSBUILD_PROJECT_READONLY；已暂停可撤回', async () => {
    const d = await mkDraft();
    const r = await withdraw(U.pm, d.pv, '草稿不能撤回');
    expectErr(r, 409, 'SYSBUILD_STATE', '草稿');
    assert.ok(r.body.message.includes('待确认'), `草稿撤回提示实际 ${r.body.message}`);
    const e = await mkSubmitted({ single: true });
    await confirmAll(e.pv);
    assert.strictEqual(await verStatus(e.pv), 'effective');
    const re = await withdraw(U.pm, e.pv, '已生效不能撤回');
    expectErr(re, 409, 'SYSBUILD_STATE', '已生效');
    assert.ok(re.body.message.includes('已生效'), `已生效撤回提示实际 ${re.body.message}`);
    assert.strictEqual(await verStatus(e.pv), 'effective', '被拒绝的撤回不改状态');
    assert.strictEqual((await revOf(e.T.aOwner.rev_id)).status, 'confirmed');
    const t = await mkSubmitted({ single: true });
    assert.strictEqual((await setStatus(t.pid, 'terminated')).status, 200);
    expectErr(await withdraw(U.pm, t.pv, '终止后撤回'), 409, 'SYSBUILD_PROJECT_READONLY', '已终止');
    assert.strictEqual((await setStatus(t.pid, 'active')).status, 200);
    assert.strictEqual((await setStatus(t.pid, 'paused')).status, 200);
    assert.strictEqual((await withdraw(U.pm, t.pv, '暂停期撤回')).status, 200, '已暂停可撤回');
  });

  // ── 浏览 ─────────────────────────────────────────────────────────────────────────────────────────
  test('C4a 浏览：必需确认人打开当前待确认修订写一条浏览记录（带当时的冻结清单），其他人打开不写；响应含对象内容 / 冻结清单 / 固定文案 / actions；遮蔽附件不返回原名', async () => {
    const s = await mkSubmitted();
    await addMember(s.pid, U.m1);
    await addMember(s.pid, U.ro);
    const tid = s.T.aOwner.task_id;
    const viewsOf = (uid) => sqlAll("SELECT * FROM sysbuild_views WHERE user_id = ? AND object_type = 'package_version' AND object_version_id = ? ORDER BY id", [uid, s.pv]);
    const o = await openTask(U.own, tid);
    assert.strictEqual(o.status, 200, o.text);
    const vs = await viewsOf(U.own);
    assert.strictEqual(vs.length, 1);
    const frozenJson = JSON.stringify([{ attachment_id: s.att, sha256: 'a'.repeat(64) }]);
    assert.deepStrictEqual([vs[0].object_type, vs[0].object_version_id, vs[0].source, vs[0].card_instance_id, vs[0].frozen_attachment_set], ['package_version', s.pv, 'page', null, frozenJson]);
    const b = o.body;
    assert.strictEqual(b.view_id, vs[0].id);
    assert.deepStrictEqual(b.task, { id: tid, project_id: s.pid, object_type: 'package_version', object_id: s.pk, object_version_id: s.pv, purpose: 'package_confirm', party_id: s.A.party });
    assert.deepStrictEqual([b.revision.id, b.revision.rev_no, b.revision.status, b.revision.status_reason, b.revision.required_member_id], [s.T.aOwner.rev_id, 1, 'pending', null, s.A.mOwn]);
    assert.strictEqual(b.revisions.length, 1);
    assert.deepStrictEqual(b.confirmations, []);
    assert.deepStrictEqual(b.object.package, { id: s.pk, type: 'overall', batch_id: null });
    assert.deepStrictEqual(b.object.version, { id: s.pv, version_no: 1, form: 'overall_batch_req', status: 'pending', effective_at: null, parent_overall_version_id: null });
    assert.deepStrictEqual(b.object.items.map((i) => [i.item_id, i.item_version_id, i.committed_batch_id, i.code, i.version_no, i.content]), [[s.item.id, s.item.versions[0].id, s.batch, 'R-01', 1, '需求：支持按部门导出']]);
    assert.deepStrictEqual(b.frozen_attachments, [{ attachment_id: s.att, sha256: 'a'.repeat(64), masked: false, name: '确认证据.txt', size: 3, mime_type: 'text/plain', is_image: false, missing: false, masked_at: null, masked_by: null, masked_by_name: null, mask_reason: null, deleted: false, deleted_at: null, deleted_by: null, deleted_by_name: null }]);
    assert.deepStrictEqual(b.checkbox_texts, CHECKBOXES, 'M-3：任务详情返回三种决策各自的固定文案');
    assert.ok(!hasOwn(b, 'checkbox_text'), '不再返回共用的单条文案');
    assert.deepStrictEqual(b.actions, { decide: true, proxy: false, reissue: false, export_sheet: true }); // C8：导出仍按只读范围开放。
    // 再打开一次再写一条
    assert.strictEqual((await openTask(U.own, tid)).status, 200);
    assert.strictEqual((await viewsOf(U.own)).length, 2);
    // 其他人打开：不写浏览记录，decide 标志为假（PM 的 reissue 为真）
    for (const [uid, label, reissueFlag] of [[U.pm, 'PM', true], [U.admin, 'admin', false], [U.m1, '一般成员', false], [U.ro, '只读账号成员', false], [U.x1, '乙部负责人（别人的任务）', false], [U.del, '同部代表人（别人的任务）', false]]) {
      const r = await openTask(uid, tid);
      assert.strictEqual(r.status, 200, `${label}: ${r.text}`);
      assert.strictEqual(r.body.view_id, null, `${label} 打开不写浏览记录`);
      assert.deepStrictEqual(r.body.actions, { decide: false, proxy: reissueFlag, reissue: reissueFlag, export_sheet: true }, `${label} 的 actions`); // 读范围不因写动作不同而收窄。
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
    assert.deepStrictEqual(after.body.actions, { decide: false, proxy: false, reissue: false, export_sheet: true });
    assert.strictEqual(after.body.confirmations.length, 1);
    // 附件遮蔽后不返回原名（Q8）
    await sqlRun("UPDATE sysbuild_attachments SET masked_at = '2026-10-30 10:00:00', masked_by = 1, mask_reason = '含敏感信息' WHERE id = ?", [s.att]);
    const masked = await openTask(U.pm, tid);
    assert.deepStrictEqual([masked.body.frozen_attachments[0].masked, masked.body.frozen_attachments[0].name], [true, null]);
    assert.ok(!masked.text.includes('确认证据'), '响应体任何位置都不含原名');
  });

  // ── 决策 ─────────────────────────────────────────────────────────────────────────────────────────
  test('C4a 决策：成功路径三种结果——确认（可不写原因）/ 有异议 / 不认可：修订终态、确认记录各列、事件手写核对；有异议与不认可不算确认，版本仍待确认；响应与再读一致', async () => {
    const s = await mkSubmitted();
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
      id: c1.id, task_revision_id: t.aOwner.rev_id, object_type: 'package_version', object_version_id: s.pv, actor_user_id: U.own, actual_confirmer: null, identity_basis: null,
      method: 'platform', decision: 'confirm', checkbox_text: CHECKBOX, reason: null, view_id: o1.body.view_id, external_date: null, proxy_by: null, card_instance_id: null,
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
    const r4 = await openAndDecide(U.x2, t.bDel.task_id, 'reject', { reason: '范围不对' });
    assert.strictEqual(r4.status, 200, r4.text);
    assert.deepStrictEqual([r4.body.decision, r4.body.revision.status, r4.body.effective], ['reject', 'rejected', false]);
    assert.strictEqual((await revOf(t.bDel.rev_id)).status, 'rejected');
    assert.strictEqual((await rowOf('sysbuild_confirmations', r4.body.confirmation_id)).reason, '范围不对');
    const c4 = await rowOf('sysbuild_confirmations', r4.body.confirmation_id);
    assert.strictEqual(c4.checkbox_text, CHECKBOXES.reject, 'M-3：不认可的记录保存的是不认可那一条，不含「确认无误」');
    assert.ok(!c4.checkbox_text.includes('确认无误') && !c1.checkbox_text.includes('不认可'), '审计证据不自相矛盾');
    assert.strictEqual(await verStatus(s.pv), 'pending', '有异议 / 不认可不算确认，版本仍待确认');
    assert.strictEqual(await baselineCount(s.pid), 0, '未生效不形成基线');
    // 再读一致：任务详情的确认记录与修订
    const again = await openTask(U.pm, t.bOwner.task_id);
    assert.deepStrictEqual(again.body.confirmations.map((c) => [c.revision_id, c.decision, c.method, c.actor_user_id, c.reason]), [[t.bOwner.rev_id, 'object', 'platform', U.x1, '内容有出入，需要说明']]);
    assert.deepStrictEqual([again.body.revision.status, again.body.actions], ['objected', { decide: false, proxy: false, reissue: true, export_sheet: true }]);
  });

  test('C4a 决策：只读账号作为必需确认人可以确认（§5.1 只读否决不含本人确认类动作）；立项包单部门确认即生效', async () => {
    const pid = await newProject();
    const C = await seedParty(pid, '丙部', U.ro, null);
    const pk = await mkPackage(pid, 'initiation');
    const pv = await mkVersion(pk);
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
    const s = await mkSubmitted();
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
    const s = await mkSubmitted();
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
    await sqlRun("UPDATE sysbuild_frozen_attachments SET sha256 = ? WHERE object_type = 'package_version' AND object_version_id = ?", ['f'.repeat(64), s.pv]);
    const fc = await decideRaw(U.own, tOwn.task_id, bodyFor(tOwn));
    expectErr(fc, 409, 'SYSBUILD_VERSION_CHANGED', '冻结清单变了');
    assert.ok(fc.body.message.includes('附件清单'), `提示实际 ${fc.body.message}`);
    await sqlRun("UPDATE sysbuild_frozen_attachments SET sha256 = ? WHERE object_type = 'package_version' AND object_version_id = ?", ['a'.repeat(64), s.pv]);
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
    const t = s.T.aOwner;
    const o = await openTask(U.own, t.task_id);
    assert.strictEqual(o.status, 200);
    // 勾选文案默认取所选决策对应的那一条（M-3）；用例要测「文案与决策不匹配」时在 extra 里显式覆盖 checkbox_text
    const base = (extra) => {
      const e = extra || {};
      return Object.assign({ revision_id: t.rev_id, object_version_id: s.pv, decision: 'confirm', checkbox_text: CHECKBOXES[hasOwn(e, 'decision') ? e.decision : 'confirm'] }, e);
    };
    const bad = async (body, field, label) => {
      const r = await decideRaw(U.own, t.task_id, body);
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
    const arr = await decideRaw(U.own, t.task_id, []);
    expectErr(arr, 400, 'SYSBUILD_INVALID_INPUT', '数组体');
    assert.strictEqual(arr.body.field, 'body');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_confirmations WHERE task_revision_id = ?', [t.rev_id]), 0, '参数错误不留确认记录');
    assert.strictEqual((await revOf(t.rev_id)).status, 'pending');
    const ok = await decideRaw(U.own, t.task_id, base({ reason: '同'.repeat(500) }));
    assert.strictEqual(ok.status, 200, `原因 500 字通过: ${ok.text}`);
  });

  test('C4a 决策（D42）：同一修订并发两次决策只成功一次（一 200 一 409），库内恰一条确认记录；库层部分唯一索引兜底——直接再写一条同修订的确认记录被拒', async () => {
    const s = await mkSubmitted();
    const t = s.T.aOwner;
    const o = await openTask(U.own, t.task_id);
    const body = decideBodyOf(o.body, 'confirm');
    const rs = await Promise.all([decideRaw(U.own, t.task_id, body), decideRaw(U.own, t.task_id, body)]);
    assert.deepStrictEqual(rs.map((r) => r.status).sort(), [200, 409], `并发两次应一成一败: ${rs.map((r) => r.text).join(' | ')}`);
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_confirmations WHERE task_revision_id = ?', [t.rev_id]), 1);
    assert.strictEqual((await revOf(t.rev_id)).status, 'confirmed');
    await assert.rejects(
      sqlRun("INSERT INTO sysbuild_confirmations (task_revision_id, object_type, object_version_id, actor_user_id, method, decision, checkbox_text, view_id) VALUES (?, 'package_version', ?, ?, 'platform', 'confirm', ?, ?)", [t.rev_id, s.pv, U.own, CHECKBOX, o.body.view_id]),
      (e) => e && e.code === 'SQLITE_CONSTRAINT', '同一修订第二条确认记录应被唯一索引拒绝'
    );
  });

  // ── 改发 / 换人 ──────────────────────────────────────────────────────────────────────────────────
  test('C4a 改发：负责人更换后改发——有异议的修订保留、新增 rev_no+1 的修订指向当前负责人；旧负责人不再是必需确认人 403；新人不继承旧人的浏览记录（须自己浏览）', async () => {
    const s = await mkSubmitted();
    const tid = s.T.aOwner.task_id;
    assert.strictEqual((await openAndDecide(U.own, tid, 'object')).status, 200);
    const oldBody = decideBodyOf((await openTask(U.pm, tid)).body, 'confirm');
    // 夹具：负责人更换（membership 的更换流程另有用例）——结束旧任职，新成员 cand 现任
    await sqlRun("UPDATE sysbuild_appointments SET status = 'ended', ended_at = '2026-10-20 10:00:00', end_reason = '负责人更换' WHERE id = ?", [s.A.apt]);
    const mCand = await addMember(s.pid, U.cand, { party: s.A.party });
    const aptNew = await addAppointment(s.A.party, mCand, 'active');
    const rr = await reissue(U.pm, tid, '负责人更换，改发新负责人');
    assert.strictEqual(rr.status, 200, rr.text);
    assert.deepStrictEqual(rr.body, { task_id: tid, revision: { id: rr.body.revision.id, rev_no: 2, status: 'pending', required_member_id: mCand, proxy_only: false } }); // C4b：修订行多 proxy_only（新负责人有账号 → 假）
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
    // 新负责人：没打开过 → 未浏览（旧人的浏览记录不继承）
    const nb = { revision_id: nr.id, object_version_id: s.pv, decision: 'confirm', checkbox_text: CHECKBOX };
    expectErr(await decideRaw(U.cand, tid, nb), 409, 'SYSBUILD_NOT_VIEWED', '新人未浏览');
    assert.strictEqual((await openTask(U.cand, tid)).status, 200);
    assert.strictEqual((await decideRaw(U.cand, tid, nb)).status, 200);
    assert.strictEqual((await revOf(nr.id)).status, 'confirmed');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_confirmations WHERE object_type = 'package_version' AND object_version_id = ? AND actor_user_id = ?", [s.pv, U.own]), 1, '旧负责人只有那一条有异议记录');
  });

  test('C4a 改发：待确认 / 不认可的修订可改发（待确认的旧修订置已替代并写原因，同一任务始终至多一条待确认）；代表人任务按当前生效授权改发，无生效代表人 409', async () => {
    const s = await mkSubmitted();
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
    const rev = await post(U.own, `/sysbuild/delegations/${s.A.dlg}/revoke`, { reason: '更换代表人' });
    assert.strictEqual(rev.status, 200, rev.text);
    const none = await reissue(U.pm, tDel.task_id, '改发新代表人');
    expectErr(none, 409, 'SYSBUILD_STATE', '没有生效代表人');
    assert.ok(none.body.message.includes('代表人'), `提示实际 ${none.body.message}`);
    const mC2 = await addMember(s.pid, U.cand2, { party: s.A.party });
    const dlgNew = await addDelegation(s.A.party, mC2, s.A.apt, 'active');
    const ok = await reissue(U.pm, tDel.task_id, '改发新代表人');
    assert.strictEqual(ok.status, 200, ok.text);
    const nr3 = await revOf(ok.body.revision.id);
    assert.deepStrictEqual([nr3.rev_no, nr3.required_member_id, nr3.basis_appointment_id, nr3.basis_delegation_id], [2, mC2, null, dlgNew]);
    // 负责人任务：没有现任负责人 → 409
    await sqlRun("UPDATE sysbuild_appointments SET status = 'ended', ended_at = '2026-10-20 10:00:00', end_reason = '离任' WHERE id = ?", [s.B.apt]);
    const noOwner = await reissue(U.pm, s.T.bOwner.task_id, '改发');
    expectErr(noOwner, 409, 'SYSBUILD_STATE', '没有现任负责人');
    assert.ok(noOwner.body.message.includes('负责人'), `提示实际 ${noOwner.body.message}`);
  });

  test('C4a 改发：不能改发的情形与权限——已确认 / 版本不再待确认 409；非 PM 403；非成员 404；原因必填；多余键；已终止 409、已暂停可改发；条目版本任务 C4b 起可改发', async () => {
    const s = await mkSubmitted();
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
    // 条目版本任务（提出人确认）：C4b P48 起可改发（原 C4a 断言「条目版本任务 409，提示含 C4b」随契约放开而改写；改发的完整用例见 sysbuild-api-suite-proxy.js）
    const pid = await newProject();
    const m1 = await addMember(pid, U.m1);
    const item = await mkItem(pid, { proposer_name: undefined, proposer_member_id: m1 });
    const pt = await sqlGet("SELECT t.id AS id FROM sysbuild_confirm_tasks t WHERE t.object_type = 'item_version' AND t.object_version_id = ?", [item.versions[0].id]);
    const pr = await reissue(U.pm, pt.id, '想改发');
    assert.strictEqual(pr.status, 200, pr.text);
    assert.deepStrictEqual(pr.body, { task_id: pt.id, revision: { id: pr.body.revision.id, rev_no: 2, status: 'pending', required_member_id: m1, proxy_only: false } });
  });

  // ── 失资格 ───────────────────────────────────────────────────────────────────────────────────────
  test('C4a 失资格：负责人任职已结束 / 授权已撤销 / 成员已移出（只读账号仍可见）/ 账号已停用——decide 409 SYSBUILD_STATE，actions.decide 为假；改发后新人可确认；被移出的普通成员 404', async () => {
    const s = await mkSubmitted();
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
    assert.strictEqual((await post(U.own, `/sysbuild/delegations/${s.A.dlg}/revoke`, { reason: '更换代表人' })).status, 200);
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
        await setPlan('b_req', '2026-11-05', '2026-11-20');
        await setPlan('b_dev', '2026-11-21', '2026-11-28');
        assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${nodeId('b_dev')}/cancel`, { reason: '本期不做开发' })).status, 200); // 有计划但已取消：不形成基线
      },
    });
    // 提交事件记下各未取消节点当时的当前计划（P34；已取消的 b_dev 不在内；H-1 之后其余节点 p_closing / b_golive 由 planAllNodes 补成 11-02 ~ 11-30），按节点编号升序，
    //   并带名称 / 层 / 批次 / 模板键快照（H-2）
    const planOverrides = { p_initiation: ['2026-11-03', '2026-11-12'], p_overall: ['2026-11-02', '2026-11-30'], b_req: ['2026-11-05', '2026-11-20'] };
    const planned = (await inhouseNodePlans(s.pid, planOverrides, ['b_dev'])).map((x) => [x.node_id, x.template_key, x.planned_start, x.planned_end]);
    assert.deepStrictEqual(planned.map((x) => x[1]), ['p_initiation', 'p_overall', 'p_closing', 'b_req', 'b_golive'], '清单手写：5 个未取消节点，按节点编号升序');
    assert.deepStrictEqual((await payloads(s.pid, 'package_version_submitted'))[0].node_plans, await inhouseNodePlans(s.pid, planOverrides, ['b_dev']));
    const baselines = async () => (await baselinesIn(s.pid)).map((b) => ({ node_id: b.node_id, planned_start: b.planned_start, planned_end: b.planned_end, package_version_id: b.package_version_id, created_by: b.created_by, reason: b.reason }));
    const versionState = async () => (await get(U.pm, `/sysbuild/package-versions/${s.pv}`)).body.version;
    // 1 三人确认：仍待确认
    for (const [uid, t] of [[U.own, s.T.aOwner], [U.del, s.T.aDel], [U.x1, s.T.bOwner]]) {
      const r = await openAndDecide(uid, t.task_id, 'confirm');
      assert.strictEqual(r.status, 200, r.text);
      assert.strictEqual(r.body.effective, false);
      assert.strictEqual((await versionState()).status, 'pending');
    }
    assert.deepStrictEqual(await baselines(), [], '部分确认不形成基线');
    // 2 第四人不认可：不生效
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
    assert.deepStrictEqual(fin.body.baseline_node_ids, planned.map((x) => x[0]), '形成基线的 = 5 个有计划且未取消的节点（已取消的 b_dev 没有）');
    const row = await rowOf('sysbuild_package_versions', s.pv);
    assert.strictEqual(row.status, 'effective');
    assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row.effective_at), `effective_at 实际 ${row.effective_at}`);
    // 4 基线：有计划且未取消的 5 个节点，取最后一条计划（p_initiation 改过一次取 11-03 ~ 11-12），引用本版本，操作人 = 最后确认的人；已取消的 b_dev（有计划）没有
    const expectBase = planned.map(([n, , a, b]) => [n, a, b]);
    assert.deepStrictEqual(await baselines(), expectBase.map(([n, a, b]) => ({ node_id: n, planned_start: a, planned_end: b, package_version_id: s.pv, created_by: U.x2, reason: null })));
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_node_schedule_records WHERE node_id = ? AND kind = 'baseline'", [nodeId('b_dev')]), 0, '已取消的节点没有基线');
    const bev = await payloads(s.pid, 'baseline_formed');
    assert.strictEqual(bev.length, 5);
    assert.ok(bev.every((p) => p.package_version_id === s.pv && p.via === 'package_effective'));
    assert.deepStrictEqual((await payloads(s.pid, 'package_version_effective')), [{ package_id: s.pk, version_no: 1, replaced: [] }]);
    // 5 读接口：基线与当前计划一致、与基线差 0；总体规划现行版本 = 本版本；条目进入生效规划
    const pn = (await get(U.pm, `/sysbuild/projects/${s.pid}/plan`)).body.nodes.find((n) => n.template_key === 'p_initiation');
    assert.deepStrictEqual([pn.baseline, pn.current_plan, pn.diff_days], [{ start: '2026-11-03', end: '2026-11-12' }, { start: '2026-11-03', end: '2026-11-12' }, 0]);
    assert.strictEqual((await get(U.pm, `/sysbuild/projects/${s.pid}/packages`)).body.overall_version_id, s.pv);
    assert.strictEqual((await get(U.pm, `/sysbuild/items/${s.item.id}`)).body.item.in_effective_plan, true);
    // 5b 任务详情展示节点计划清单（P34 + H-2，取自提交事件快照）：整份与手写期望全等（名称 / 层 / 批次 / 模板键 / 日期）
    const detail = await openTask(U.pm, s.T.aOwner.task_id);
    assert.deepStrictEqual(detail.body.object.node_plans, await inhouseNodePlans(s.pid, planOverrides, ['b_dev']));
    assert.deepStrictEqual(detail.body.object.node_plans.map((n) => [n.node_id, n.template_key, n.planned_start, n.planned_end]), planned);
    // 6 生效后：已确认的修订不能再决策；生效版本不能再提交 / 撤回 / 改发
    expectErr(await decideRaw(U.x2, s.T.bDel.task_id, decideBodyOf((await openTask(U.x2, s.T.bDel.task_id)).body, 'confirm')), 409, 'SYSBUILD_STATE', '生效后再决策');
    expectErr(await submit(U.pm, s.pv), 409, 'SYSBUILD_STATE', '生效版本再提交');
    expectErr(await reissue(U.pm, s.T.aOwner.task_id, '想改发'), 409, 'SYSBUILD_STATE', '生效版本改发');
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
  test('C4a 生效：总体规划第二个版本生效（夹具：D1 之后第二版 C5 前无生产路径）——原生效版本被替代，已有基线的节点不被覆盖，也不新增', async () => {
    const pid = await newProject();
    await seedParty(pid, '甲部', U.own, U.del);
    const plan = (await get(U.pm, `/sysbuild/projects/${pid}/plan`)).body;
    const nid = plan.nodes.find((n) => n.template_key === 'p_overall').id;
    assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${nid}/schedule`, { kind: 'plan', planned_start: '2026-11-02', planned_end: '2026-11-30' })).status, 201);
    const { pk, pv, itemVersionId } = await H.produceEffectiveOverall(pid);
    const base1 = await baselinesIn(pid);
    assert.deepStrictEqual(base1.map((b) => [b.node_id, b.planned_start, b.planned_end, b.package_version_id]), (await inhouseNodePlans(pid)).map((x) => [x.node_id, x.planned_start, x.planned_end, pv]), 'H-1：produceEffectiveOverall 提交前补齐了全部 6 个节点的计划，生效时 6 个节点都形成基线');
    // 夹具：第二个版本（草稿）及它的集合；节点改期（走改期分支）后当前计划与基线不同
    const v2 = (await sqlRun("INSERT INTO sysbuild_package_versions (package_id, version_no, form, status, snapshot_json, created_by) VALUES (?, 2, 'overall_batch_req', 'draft', '{}', ?)", [pk, U.pm])).lastID;
    await sqlRun("INSERT INTO sysbuild_package_item_revisions (package_version_id, item_version_id, committed_batch_id, op, created_by) VALUES (?, ?, ?, 'add', ?)", [v2, itemVersionId, await defaultBatchId(pid), U.pm]);
    const rs = await post(U.pm, `/sysbuild/nodes/${nid}/schedule`, { kind: 'plan', planned_start: '2026-12-01', planned_end: '2026-12-20', reason: '客户要求延期', no_written_evidence: true, no_evidence_reason: '电话沟通后已确认延期事宜' });
    assert.strictEqual(rs.status, 201, rs.text);
    assert.strictEqual((await submit(U.pm, v2)).status, 200);
    const last = await confirmAll(v2);
    assert.deepStrictEqual([last.body.effective, last.body.superseded_version_ids, last.body.baseline_node_ids], [true, [pv], []]);
    assert.deepStrictEqual([await verStatus(pv), await verStatus(v2)], ['superseded', 'effective']);
    assert.deepStrictEqual(await baselinesIn(pid), base1, '已有基线不覆盖、不新增（基线不可覆盖）');
    assert.strictEqual((await get(U.pm, `/sysbuild/projects/${pid}/packages`)).body.overall_version_id, v2, '现行总体规划 = 第二版');
  });

  // ── H-1 / P43：基线只来自被确认的计划（撤销 C4a 交接 ①「生效后首次计划即基线」）──────────────────────────────
  test('C4a H-1（P43）生效后写计划：总体规划生效后新增的节点（尚无基线）设计划 = 改期式写入——要原因与证据、写 plan_change、不写 baseline；它的基线在下一次总体规划版本生效时由当时的当前计划形成；没有生效的项目不受影响，也不被别的项目的生效版本带出', async () => {
    const pid = await newProject();
    const { pk, pv, itemVersionId } = await H.produceEffectiveOverall(pid);
    const formedBefore = (await payloads(pid, 'baseline_formed')).length;
    assert.strictEqual(formedBefore, 6, '生效时 6 个节点形成基线');
    const bid = await defaultBatchId(pid);
    const addNode = await post(U.pm, `/sysbuild/batches/${bid}/nodes`, { name: '生效后新增的自定义节点' });
    assert.strictEqual(addNode.status, 201, addNode.text);
    const nid = addNode.body.node.id;
    // 节点视图：尚无基线，写计划走改期式（reschedule），has_baseline 区分于「已有基线的改期」
    assert.deepStrictEqual([addNode.body.node.plan_write_mode, addNode.body.node.has_baseline], ['reschedule', false]);
    const first = (extra) => post(U.pm, `/sysbuild/nodes/${nid}/schedule`, Object.assign({ kind: 'plan', planned_start: '2026-12-01', planned_end: '2026-12-10' }, extra || {}));
    const noReason = await first();
    expectErr(noReason, 400, 'SYSBUILD_INVALID_INPUT', '尚无基线的节点写计划缺原因');
    assert.strictEqual(noReason.body.field, 'reason');
    expectErr(await first({ reason: '新增节点排期' }), 400, 'SYSBUILD_EVIDENCE_REQUIRED', '缺证据');
    assert.deepStrictEqual(await recordsKinds(nid), [], '被拒绝的写入不留记录（草稿期写法——无原因无证据——不再被接受）');
    const ok1 = await first({ reason: '新增节点排期', no_written_evidence: true, no_evidence_reason: '电话沟通后已确认新增节点排期' });
    assert.strictEqual(ok1.status, 201, ok1.text);
    const recs = (await get(U.pm, `/sysbuild/nodes/${nid}/schedule`)).body.records;
    assert.deepStrictEqual(recs.map((r) => [r.kind, r.planned_start, r.planned_end, r.package_version_id, r.reason, r.no_written_evidence]), [['plan_change', '2026-12-01', '2026-12-10', null, '新增节点排期', true]], '写的是 plan_change，没有 baseline，不引用已生效版本');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_node_schedule_records WHERE node_id = ? AND kind = 'baseline'", [nid]), 0, '没有基线');
    assert.strictEqual((await payloads(pid, 'baseline_formed')).length, formedBefore, '没有新增 baseline_formed 事件');
    assert.deepStrictEqual((await payloads(pid, 'node_rescheduled')).pop(), {
      record_id: ok1.body.record_id, before: null, after: { start: '2026-12-01', end: '2026-12-10' }, reason: '新增节点排期', source_party_id: null, dev_key_entry_id: null,
      no_written_evidence: true, no_evidence_reason: '电话沟通后已确认新增节点排期', attachment_ids: [],
    });
    assert.deepStrictEqual([ok1.body.node.baseline, ok1.body.node.current_plan, ok1.body.node.diff_days, ok1.body.node.has_baseline], [null, { start: '2026-12-01', end: '2026-12-10' }, null, false]);
    // 再改一次：仍是改期式写入，仍无基线
    const ok2 = await first({ planned_start: '2026-12-05', planned_end: '2026-12-20', reason: '客户要求延期', no_written_evidence: true, no_evidence_reason: '电话沟通后已确认延期事宜' });
    assert.strictEqual(ok2.status, 201, ok2.text);
    assert.deepStrictEqual(await recordsKinds(nid), ['plan_change', 'plan_change']);
    // 已有基线的节点（生效时形成）改期：基线保留，plan_write_mode 同为 reschedule、has_baseline 为真
    const closingNode = (await get(U.pm, `/sysbuild/projects/${pid}/plan`)).body.nodes.find((n) => n.template_key === 'p_closing');
    assert.deepStrictEqual([closingNode.plan_write_mode, closingNode.has_baseline], ['reschedule', true]);
    // 下一次总体规划版本生效（夹具：第二个版本 C5 前无生产路径）：尚无基线的自定义节点在这时才形成基线 = 提交时记录的当前计划（12-05 ~ 12-20），引用第二版；已有基线的节点不动
    const v2 = (await sqlRun("INSERT INTO sysbuild_package_versions (package_id, version_no, form, status, snapshot_json, created_by) VALUES (?, 2, 'overall_batch_req', 'draft', '{}', ?)", [pk, U.pm])).lastID;
    await sqlRun("INSERT INTO sysbuild_package_item_revisions (package_version_id, item_version_id, committed_batch_id, op, created_by) VALUES (?, ?, ?, 'add', ?)", [v2, itemVersionId, bid, U.pm]);
    const sub = await submit(U.pm, v2);
    assert.strictEqual(sub.status, 200, sub.text);
    const subPlans = (await payloads(pid, 'package_version_submitted')).pop().node_plans;
    const mine = subPlans.find((x) => x.node_id === nid);
    assert.deepStrictEqual([mine.name, mine.layer, mine.batch_id, mine.batch_name, mine.template_key, mine.planned_start, mine.planned_end], ['生效后新增的自定义节点', 'batch', bid, '第 1 批', null, '2026-12-05', '2026-12-20'], 'H-1 + H-2：新节点的当前计划随第二版提交一起冻结并形成确认对象');
    const fin = await confirmAll(v2);
    assert.deepStrictEqual([fin.body.effective, fin.body.baseline_node_ids], [true, [nid]], '只有尚无基线的新节点形成基线');
    const baseNow = await sqlGet("SELECT planned_start, planned_end, package_version_id FROM sysbuild_node_schedule_records WHERE node_id = ? AND kind = 'baseline'", [nid]);
    assert.deepStrictEqual(baseNow, { planned_start: '2026-12-05', planned_end: '2026-12-20', package_version_id: v2 }, '基线引用包含这些日期的版本（第二版），不引用第一版');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_node_schedule_records WHERE kind = 'baseline' AND package_version_id = ? AND node_id <> ?", [pv, nid]), 6, '其余 6 个节点的基线仍引用第一版，不被覆盖');
    // 草稿期（项目没有生效的总体规划）：设计划仍是草稿期计划；别的项目已有生效版本不影响它
    const other = await newProject();
    const oView = (await get(U.pm, `/sysbuild/projects/${other}/plan`)).body.nodes.find((n) => n.template_key === 'p_overall');
    assert.deepStrictEqual([oView.plan_write_mode, oView.has_baseline], ['draft', false]);
    const o1 = await post(U.pm, `/sysbuild/nodes/${oView.id}/schedule`, { kind: 'plan', planned_start: '2026-12-01', planned_end: '2026-12-10' });
    assert.strictEqual(o1.status, 201, o1.text);
    const orecs = (await get(U.pm, `/sysbuild/nodes/${oView.id}/schedule`)).body.records;
    assert.deepStrictEqual(orecs.map((r) => [r.kind, r.package_version_id, r.is_draft_plan]), [['plan_change', null, true]], '没有生效版本的项目：草稿期计划，不写基线');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_events WHERE project_id = ? AND event_type = 'baseline_formed'", [other]), 0);
  });

  // ── H-1 / P43：提交前置「计划齐全」──────────────────────────────────────────────────────────────────────
  test('C4a H-1（P43）提交前置：计划齐全——合并形态（单批）要求项目内全部未取消节点（项目层 + 批次层）有当前计划，普通形态（多批）只要求项目层；缺则 409 列出缺计划的节点，读接口 actions.submit 同步为假；已取消的节点不要求；补齐后可提交；普通形态生效只给有计划的节点形成基线、不推进批次', async () => {
    const HEAD = '以下节点还没有计划起止日期，总体规划提交前须先补齐（总体排期基线是确认对象）：';
    const submitFlag = async (vid) => (await get(U.pm, `/sysbuild/package-versions/${vid}`)).body.actions.submit;
    const planNode = async (pid, key, a, b) => {
      const r = await post(U.pm, `/sysbuild/nodes/${await nodeIdOf(pid, key)}/schedule`, { kind: 'plan', planned_start: a || PLAN_START, planned_end: b || PLAN_END });
      assert.strictEqual(r.status, 201, `${key}: ${r.text}`);
    };
    // 兄弟项目有一个计划齐全、已提交的总体规划包：本项目的判定不得被它影响（过滤模式下用例单独运行，库里没有别的数据）
    await mkSubmitted({ single: true });
    await newProject(); // 另一个项目的 6 个节点全都没有计划：本项目的缺计划清单不得带上它们
    // 1 合并形态（单批）：6 个节点都没有计划 → 全部列出（项目层在前，批次层带批次名；按层、批次、排序、编号）
    const d = await mkDraft({ noPlans: true });
    assert.strictEqual((await rowOf('sysbuild_package_versions', d.pv)).form, 'overall_batch_req');
    assert.strictEqual(await submitFlag(d.pv), false, '缺计划：submit 标志为假');
    const r1 = await submit(U.pm, d.pv);
    expectErr(r1, 409, 'SYSBUILD_STATE', '合并形态全部缺计划');
    assert.strictEqual(r1.body.message, `${HEAD}立项与授权、总体范围与批次规划、整体验收结项、需求确认（第 1 批）、开发完成（含设计）（第 1 批）、上线（含测试与验收）（第 1 批）`);
    assert.strictEqual(await verStatus(d.pv), 'draft');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE object_version_id = ? AND object_type = 'package_version'", [d.pv]), 0, '被拒绝的提交不生成任务');
    // 2 只补项目层：批次层 3 个节点仍缺 → 合并形态仍 409，且只列批次层（换一个不会先被别的规则拦下的输入）
    for (const k of ['p_initiation', 'p_overall', 'p_closing']) await planNode(d.pid, k);
    const r2 = await submit(U.pm, d.pv);
    expectErr(r2, 409, 'SYSBUILD_STATE', '合并形态：项目层齐了，批次层缺');
    assert.strictEqual(r2.body.message, `${HEAD}需求确认（第 1 批）、开发完成（含设计）（第 1 批）、上线（含测试与验收）（第 1 批）`);
    // 3 已取消的节点不要求：取消 b_dev（未开始、非里程碑）→ 只列 b_req、b_golive；再补 b_req → 只列 b_golive
    assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${await nodeIdOf(d.pid, 'b_dev')}/cancel`, { reason: '本期不做开发' })).status, 200);
    const r3 = await submit(U.pm, d.pv);
    expectErr(r3, 409, 'SYSBUILD_STATE', '取消 b_dev 后仍缺两个');
    assert.strictEqual(r3.body.message, `${HEAD}需求确认（第 1 批）、上线（含测试与验收）（第 1 批）`);
    await planNode(d.pid, 'b_req');
    const r3b = await submit(U.pm, d.pv);
    expectErr(r3b, 409, 'SYSBUILD_STATE', '只缺 b_golive');
    assert.strictEqual(r3b.body.message, `${HEAD}上线（含测试与验收）（第 1 批）`);
    assert.strictEqual(await submitFlag(d.pv), false);
    await planNode(d.pid, 'b_golive');
    assert.strictEqual(await submitFlag(d.pv), true, '补齐后标志为真');
    const ok = await submit(U.pm, d.pv);
    assert.strictEqual(ok.status, 200, ok.text);
    assert.deepStrictEqual((await payloads(d.pid, 'package_version_submitted'))[0].node_plans.map((x) => x.template_key), ['p_initiation', 'p_overall', 'p_closing', 'b_req', 'b_golive'], '已取消的 b_dev 不在清单里');
    // 4 普通形态（多批）：草稿建好后多出第二个批次（夹具：C3 没有新增批次端点）→ 提交时重算为 overall，只要求项目层；批次层节点没有计划也能提交
    const d2 = await mkDraft({ noPlans: true });
    const seq2 = (await sqlGet('SELECT MAX(seq) AS m FROM sysbuild_batches WHERE project_id = ?', [d2.pid])).m + 1;
    const batch2 = (await sqlRun("INSERT INTO sysbuild_batches (project_id, seq, name, is_default, status) VALUES (?, ?, '夹具批次2', 0, 'planning')", [d2.pid, seq2])).lastID;
    const r4 = await submit(U.pm, d2.pv);
    expectErr(r4, 409, 'SYSBUILD_STATE', '普通形态：项目层缺计划');
    assert.strictEqual(r4.body.message, `${HEAD}立项与授权、总体范围与批次规划、整体验收结项`, '普通形态只列项目层节点，不列批次层');
    assert.strictEqual(await submitFlag(d2.pv), false);
    for (const k of ['p_initiation', 'p_overall', 'p_closing']) await planNode(d2.pid, k);
    assert.strictEqual(await submitFlag(d2.pv), true, '项目层齐了：普通形态的标志为真（批次层节点没有计划不挡）');
    const ok2 = await submit(U.pm, d2.pv);
    assert.strictEqual(ok2.status, 200, ok2.text);
    const ev2 = (await payloads(d2.pid, 'package_version_submitted'))[0];
    assert.deepStrictEqual([ev2.form, ev2.form_from, ev2.form_to], ['overall', 'overall_batch_req', 'overall'], '草稿存的是合并形态，提交时重算为普通形态（P32）');
    assert.deepStrictEqual(ev2.node_plans.map((x) => x.template_key), ['p_initiation', 'p_overall', 'p_closing'], '批次层节点没有计划，不在提交记录里');
    // 5 普通形态生效：只给有计划的节点（项目层 3 个）形成基线（formBaselines 跳过没有计划的节点），批次状态不推进（不是合并形态，M-1）
    const fin = await confirmAll(d2.pv);
    assert.strictEqual(fin.status, 200, fin.text);
    assert.deepStrictEqual(fin.body.baseline_node_ids, ev2.node_plans.map((x) => x.node_id), '项目层 3 个节点形成基线，批次层没有计划的节点没有');
    assert.deepStrictEqual(fin.body.advanced_batch_ids, [], '普通形态生效不推进批次');
    assert.deepStrictEqual([(await rowOf('sysbuild_batches', d2.batch)).status, (await rowOf('sysbuild_batches', batch2)).status], ['planning', 'planning']);
    assert.strictEqual(await baselineCount(d2.pid), 3);
    // 6 立项包不要求计划齐全
    const pidI = await newProject();
    await seedParty(pidI, '甲部', U.own, null);
    const iniV = await mkVersion(await mkPackage(pidI, 'initiation'));
    assert.strictEqual(await submitFlag(iniV), true);
    assert.strictEqual((await submit(U.pm, iniV)).status, 200, '立项包不要求节点计划齐全');
  });

  // ── M-1 合并包生效推进批次 ──────────────────────────────────────────────────────────────────────────────
  test('C4a M-1：合并形态（单批）总体规划包生效的同一事务里，「规划中」的批次推进到「进行中」并写批次状态事件——不需要先开始任何节点；已是进行中的批次不重复写；立项包生效不推进', async () => {
    const pid = await newProject();
    const batch = await defaultBatchId(pid);
    assert.strictEqual((await rowOf('sysbuild_batches', batch)).status, 'planning');
    const { pk, pv, itemVersionId } = await H.produceEffectiveOverall(pid);
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
    // 已是进行中的批次不重复写：第二个总体规划版本（夹具）生效，不再有批次状态事件
    const v2 = (await sqlRun("INSERT INTO sysbuild_package_versions (package_id, version_no, form, status, snapshot_json, created_by) VALUES (?, 2, 'overall_batch_req', 'draft', '{}', ?)", [pk, U.pm])).lastID;
    await sqlRun("INSERT INTO sysbuild_package_item_revisions (package_version_id, item_version_id, committed_batch_id, op, created_by) VALUES (?, ?, ?, 'add', ?)", [v2, itemVersionId, batch, U.pm]);
    assert.strictEqual((await submit(U.pm, v2)).status, 200);
    const fin2 = await confirmAll(v2);
    assert.deepStrictEqual([fin2.body.effective, fin2.body.advanced_batch_ids], [true, []], '已是进行中：不重复推进');
    assert.strictEqual((await payloads(pid, 'batch_status_changed')).length, 1, '批次状态事件只有第一次生效那一条');
    // 立项包生效不推进批次（立项包用例已核；这里再核一个干净项目）
    const p2 = await newProject();
    await seedParty(p2, '甲部', U.own, null);
    const iv = await mkVersion(await mkPackage(p2, 'initiation'));
    assert.strictEqual((await submit(U.pm, iv)).status, 200);
    await confirmAll(iv);
    assert.strictEqual((await rowOf('sysbuild_batches', await defaultBatchId(p2))).status, 'planning');
    assert.strictEqual((await payloads(p2, 'batch_status_changed')).length, 0);
  });

  // ── H-2 确认页排期用提交快照 ────────────────────────────────────────────────────────────────────────────
  test('C4a H-2：确认页的节点排期一律取提交快照——待确认期间节点 / 批次改名，先后打开的确认人看到同一份排期（名称、层、批次、模板键、日期），节点视图仍显示现值；生效核对按节点编号与日期，不受改名影响', async () => {
    const s = await mkSubmitted({ single: true });
    const expected = await inhouseNodePlans(s.pid);
    const first = await openTask(U.own, s.T.aOwner.task_id);
    assert.strictEqual(first.status, 200, first.text);
    assert.deepStrictEqual(first.body.object.node_plans, expected, '提交快照 = 提交时的名称 / 层 / 批次 / 模板键 / 日期');
    // 待确认期间改名（节点改名、批次改名都允许；排期与取消节点才被冻结）
    const reqId = await nodeIdOf(s.pid, 'b_req');
    const rn = await api(U.pm, 'PATCH', `/sysbuild/nodes/${reqId}`, { name: '改名后的需求确认' });
    assert.strictEqual(rn.status, 200, rn.text);
    const rb = await api(U.pm, 'PATCH', `/sysbuild/batches/${s.batch}`, { name: '改名后的批次' });
    assert.strictEqual(rb.status, 200, rb.text);
    const planNow = (await get(U.pm, `/sysbuild/projects/${s.pid}/plan`)).body;
    assert.strictEqual(planNow.nodes.find((n) => n.id === reqId).name, '改名后的需求确认', '节点视图显示现值');
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

  // ── M-2 确认页返回无书面证据声明 ────────────────────────────────────────────────────────────────────────
  test('C4a M-2：包任务详情的每个条目版本、提出人任务详情都返回 no_written_evidence 与 no_evidence_reason——声明了的返回真与原文，没声明的返回假与空', async () => {
    const d = await mkDraft(); // 条目 R-01 声明无书面证据（原因 EV.no_evidence_reason）
    const att = await stageAtt(d.pid, U.pm, 'a');
    const withAtt = await mkItem(d.pid, { attachment_ids: [att], no_written_evidence: undefined, no_evidence_reason: undefined });
    await addToSet(d.pv, withAtt.versions[0].id, d.batch);
    assert.strictEqual((await submit(U.pm, d.pv)).status, 200);
    const tasks = await tasksOf(d.pv);
    const o = await openTask(tasks[0].user_id, tasks[0].task_id);
    assert.strictEqual(o.status, 200, o.text);
    const byCode = Object.fromEntries(o.body.object.items.map((i) => [i.code, i]));
    assert.deepStrictEqual([byCode['R-01'].no_written_evidence, byCode['R-01'].no_evidence_reason], [true, EV.no_evidence_reason], '声明无书面证据的条目：返回真与原因原文');
    assert.deepStrictEqual([byCode['R-02'].no_written_evidence, byCode['R-02'].no_evidence_reason], [false, null], '有附件的条目：返回假与空');
    // 提出人任务详情（条目版本）：提出人 = 有账号的成员
    const party = await addParty(d.pid, '丙部', 'demand');
    const m1 = await addMember(d.pid, U.m1, { party });
    const it = await mkItem(d.pid, { proposer_name: undefined, proposer_member_id: m1 });
    const pt = await sqlGet("SELECT id FROM sysbuild_confirm_tasks WHERE object_type = 'item_version' AND object_version_id = ?", [it.versions[0].id]);
    const po = await openTask(U.m1, pt.id);
    assert.strictEqual(po.status, 200, po.text);
    assert.deepStrictEqual([po.body.object.version.no_written_evidence, po.body.object.version.no_evidence_reason], [true, EV.no_evidence_reason], '提出人任务详情：声明与原因都返回');
    // 对照：有附件、没声明的条目版本的提出人任务
    const att2 = await stageAtt(d.pid, U.pm, 'c');
    const it2 = await mkItem(d.pid, { proposer_name: undefined, proposer_member_id: m1, attachment_ids: [att2], no_written_evidence: undefined, no_evidence_reason: undefined });
    const pt2 = await sqlGet("SELECT id FROM sysbuild_confirm_tasks WHERE object_type = 'item_version' AND object_version_id = ?", [it2.versions[0].id]);
    const po2 = await openTask(U.m1, pt2.id);
    assert.deepStrictEqual([po2.body.object.version.no_written_evidence, po2.body.object.version.no_evidence_reason], [false, null]);
  });

  // ── 提出人确认（P29）──────────────────────────────────────────────────────────────────────────────
  test('C4a 提出人：条目版本创建时，提出人是本项目已加入、有账号的成员（含 PM 本人的成员行）→ 生成任务与首条修订并冻结附件清单；只填姓名 → 不生成；无账号成员 → 也生成（C4b P46，只能代录）', async () => {
    const pid = await newProject();
    const party = await addParty(pid, '甲部', 'demand');
    const m1 = await addMember(pid, U.m1, { party });
    const att = await stageAtt(pid, U.pm, 'c');
    const it = await mkItem(pid, { proposer_name: undefined, proposer_member_id: m1, attachment_ids: [att], no_written_evidence: undefined, no_evidence_reason: undefined });
    const ivid = it.versions[0].id;
    const tasks = await sqlAll("SELECT * FROM sysbuild_confirm_tasks WHERE object_type = 'item_version' ORDER BY id");
    const mine = tasks.filter((t) => t.object_version_id === ivid);
    assert.strictEqual(mine.length, 1);
    assert.deepStrictEqual([mine[0].project_id, mine[0].object_id, mine[0].purpose, mine[0].party_id, mine[0].created_by], [pid, it.id, 'proposer_confirm', party, U.pm]);
    const rev = await sqlAll('SELECT * FROM sysbuild_confirm_task_revisions WHERE task_id = ?', [mine[0].id]);
    assert.deepStrictEqual(rev.map((r) => [r.rev_no, r.required_member_id, r.basis_appointment_id, r.basis_delegation_id, r.status]), [[1, m1, null, null, 'pending']]);
    assert.deepStrictEqual(await frozenOf('item_version', ivid), [{ attachment_id: att, sha256: 'c'.repeat(64) }], '提出人确认任务生成时冻结条目版本的附件清单');
    assert.strictEqual((await payloads(pid, 'confirm_task_created')).filter((p) => p.object_type === 'item_version').length, 1);
    // PM 本人的成员行（没有参与方）：提出人是 PM，也生成任务，party_id 为空
    const pmRow = await memberRow(pid, U.pm);
    const it2 = await mkItem(pid, { proposer_name: undefined, proposer_member_id: pmRow });
    const t2 = await sqlGet("SELECT party_id FROM sysbuild_confirm_tasks WHERE object_type = 'item_version' AND object_version_id = ?", [it2.versions[0].id]);
    assert.deepStrictEqual(t2, { party_id: null });
    // 只填姓名：不生成
    const it3 = await mkItem(pid);
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE object_type = 'item_version' AND object_version_id = ?", [it3.versions[0].id]), 0);
    // 无账号成员（夹具：只填姓名的外部人员成员行）：C4b P44 / P46 起也生成任务（原断言「不生成」随契约改写；代录确认人只能代录，完整用例见 sysbuild-api-suite-proxy.js）
    const mNa = (await sqlRun("INSERT INTO sysbuild_members (project_id, party_id, person_name, joined_at, added_by) VALUES (?, ?, '无账号张三', '2026-10-01 10:00:00', ?)", [pid, party, U.admin])).lastID;
    const it4 = await mkItem(pid, { proposer_name: undefined, proposer_member_id: mNa });
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE object_type = 'item_version' AND object_version_id = ?", [it4.versions[0].id]), 1);
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE project_id = ?", [pid]), 3, '项目里共三个提出人任务（m1、PM 与无账号张三）');
  });

  test('C4a 提出人：确认 → proposer_status = confirmed；不认可 → denied 并写原因；有异议 → 修订 objected、提出人状态不变；决策后不能再决策；已终止 409', async () => {
    const pid = await newProject();
    const m1 = await addMember(pid, U.m1);
    const mk = async () => {
      const it = await mkItem(pid, { proposer_name: undefined, proposer_member_id: m1 });
      const tid = (await sqlGet("SELECT id FROM sysbuild_confirm_tasks WHERE object_type = 'item_version' AND object_version_id = ?", [it.versions[0].id])).id;
      return { it, ivid: it.versions[0].id, tid };
    };
    const statusOf = async (ivid) => sqlGet('SELECT proposer_status, deny_reason FROM sysbuild_item_versions WHERE id = ?', [ivid]);
    const a = await mk();
    const ra = await openAndDecide(U.m1, a.tid, 'confirm');
    assert.strictEqual(ra.status, 200, ra.text);
    assert.deepStrictEqual([ra.body.decision, ra.body.proposer_status, ra.body.revision.status], ['confirm', 'confirmed', 'confirmed']);
    assert.deepStrictEqual(await statusOf(a.ivid), { proposer_status: 'confirmed', deny_reason: null });
    assert.deepStrictEqual((await payloads(pid, 'item_proposer_status_changed'))[0], { item_id: a.it.id, from: 'pending', to: 'confirmed', confirmation_id: ra.body.confirmation_id });
    const ca = await rowOf('sysbuild_confirmations', ra.body.confirmation_id);
    assert.deepStrictEqual([ca.object_type, ca.object_version_id, ca.method, ca.actor_user_id], ['item_version', a.ivid, 'platform', U.m1]);
    const again = await decideRaw(U.m1, a.tid, decideBodyOf((await openTask(U.m1, a.tid)).body, 'confirm'));
    expectErr(again, 409, 'SYSBUILD_STATE', '确认后再决策');
    // 不认可：denied + 原因
    const b = await mk();
    const rb = await openAndDecide(U.m1, b.tid, 'reject', { reason: '这不是我提的需求' });
    assert.strictEqual(rb.status, 200, rb.text);
    assert.deepStrictEqual([rb.body.proposer_status, rb.body.revision.status], ['denied', 'rejected']);
    assert.deepStrictEqual(await statusOf(b.ivid), { proposer_status: 'denied', deny_reason: '这不是我提的需求' });
    // 有异议：修订 objected，提出人状态不变
    const c = await mk();
    const rc = await openAndDecide(U.m1, c.tid, 'object', { reason: '原话要点不准确' });
    assert.strictEqual(rc.status, 200, rc.text);
    assert.deepStrictEqual([rc.body.revision.status, rc.body.proposer_status], ['objected', undefined]);
    assert.deepStrictEqual(await statusOf(c.ivid), { proposer_status: 'pending', deny_reason: null });
    assert.strictEqual((await payloads(pid, 'item_proposer_status_changed')).length, 2, '有异议不写提出人状态事件');
    // 非提出人不能决策；浏览：提出人打开写浏览记录且冻结清单为空
    const d = await mk();
    expectErr(await decideRaw(U.pm, d.tid, decideBodyOf((await openTask(U.m1, d.tid)).body, 'confirm')), 403, 'SYSBUILD_FORBIDDEN', 'PM 不能替提出人确认');
    const vw = await sqlGet("SELECT object_type, source, frozen_attachment_set FROM sysbuild_views WHERE user_id = ? AND object_version_id = ? ORDER BY id DESC LIMIT 1", [U.m1, d.ivid]);
    assert.deepStrictEqual(vw, { object_type: 'item_version', source: 'page', frozen_attachment_set: '[]' });
    // 已终止：409 SYSBUILD_PROJECT_READONLY
    assert.strictEqual((await setStatus(pid, 'terminated')).status, 200);
    expectErr(await decideRaw(U.m1, d.tid, decideBodyOf((await openTask(U.m1, d.tid)).body, 'confirm')), 409, 'SYSBUILD_PROJECT_READONLY', '已终止');
  });

  test('C4a 提出人：条目出新版本——旧版本仍待确认的修订置已替代（原因「条目已有新版本」），新版本生成新任务；提出人状态与内容包确认互不影响', async () => {
    const s = await mkSubmitted({ single: true });
    await addMember(s.pid, U.m2);
    const m2 = await memberRow(s.pid, U.m2);
    const it = await mkItem(s.pid, { proposer_name: undefined, proposer_member_id: m2 });
    const iv1 = it.versions[0].id;
    const t1 = await sqlGet("SELECT t.id AS id, r.id AS rev FROM sysbuild_confirm_tasks t JOIN sysbuild_confirm_task_revisions r ON r.task_id = t.id WHERE t.object_type = 'item_version' AND t.object_version_id = ?", [iv1]);
    // 出新版本（PM；提出人沿用上一版本）
    const v2 = await post(U.pm, `/sysbuild/items/${it.id}/versions`, { content: '补正后的需求', no_written_evidence: true, no_evidence_reason: '口头电话确认了本次需求内容' });
    assert.strictEqual(v2.status, 201, v2.text);
    const old = await revOf(t1.rev);
    assert.deepStrictEqual([old.status, old.status_reason], ['superseded', '条目已有新版本']);
    const t2 = await sqlGet("SELECT t.id AS id, r.status AS status, r.required_member_id AS member FROM sysbuild_confirm_tasks t JOIN sysbuild_confirm_task_revisions r ON r.task_id = t.id WHERE t.object_type = 'item_version' AND t.object_version_id = ?", [v2.body.item_version_id]);
    assert.deepStrictEqual([t2.status, t2.member], ['pending', m2], '新版本生成新的提出人任务');
    assert.deepStrictEqual((await payloads(s.pid, 'confirm_revision_superseded'))[0], { revision_id: t1.rev, object_version_id: iv1, reason: '条目已有新版本', new_item_version_id: v2.body.item_version_id });
    // 旧任务不再可决策（修订已替代）
    const oldView = await openTask(U.m2, t1.id);
    assert.strictEqual(oldView.body.view_id, null);
    expectErr(await decideRaw(U.m2, t1.id, decideBodyOf(oldView.body, 'confirm')), 409, 'SYSBUILD_STATE', '旧版本任务已替代');
    // 新版本改成只填姓名的提出人：新版本不生成任务，旧的待确认修订同样被替代
    const v3 = await post(U.pm, `/sysbuild/items/${it.id}/versions`, { content: '再补正', proposer_name: '外部李四', no_written_evidence: true, no_evidence_reason: '口头电话确认了本次需求内容' });
    assert.strictEqual(v3.status, 201, v3.text);
    assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_confirm_task_revisions WHERE task_id = ?', [t2.id])).status, 'superseded');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE object_type = 'item_version' AND object_version_id = ?", [v3.body.item_version_id]), 0);
    // 互不影响：内容包全部确认生效后，条目版本的提出人状态仍是 pending；提出人确认也不改内容包
    const itemInPkg = s.item.versions[0].id;
    await confirmAll(s.pv);
    assert.strictEqual(await verStatus(s.pv), 'effective');
    assert.strictEqual((await sqlGet('SELECT proposer_status FROM sysbuild_item_versions WHERE id = ?', [itemInPkg])).proposer_status, 'pending');
  });

  // ── 待我确认 ────────────────────────────────────────────────────────────────────────────────────
  test('C4a 待我确认：只列我作为必需确认人的待确认修订（项目、对象、版本、修订号、创建时间），已处理 / 已替代 / 失效不列，别人的不列；被移出的成员不列', async () => {
    const s = await mkSubmitted();
    // 各用例共用一个库、同一批用户：只看本用例建的项目里的条目（scope 随场景切换）
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
    // 提出人任务也列；只读账号（仍可见）作为必需确认人被移出成员后不列
    const pid = await newProject();
    scope = [pid];
    const m1 = await addMember(pid, U.m1);
    const it = await mkItem(pid, { proposer_name: undefined, proposer_member_id: m1 });
    const pl = (await mine(U.m1)).body.items;
    assert.deepStrictEqual(pl.map((i) => [i.project_id, i.object_type, i.object_id, i.object_version_id, i.purpose, i.rev_no]), [[pid, 'item_version', it.id, it.versions[0].id, 'proposer_confirm', 1]]);
    const pid2 = await newProject();
    scope = [pid2];
    await seedParty(pid2, '丙部', U.ro, null);
    const pv2 = await mkVersion(await mkPackage(pid2, 'initiation'));
    assert.strictEqual((await submit(U.pm, pv2)).status, 200);
    assert.strictEqual((await mine(U.ro)).body.items.length, 1);
    assert.strictEqual((await post(U.pm, `/sysbuild/members/${await memberRow(pid2, U.ro)}/remove`, { reason: '离项' })).status, 200);
    assert.deepStrictEqual((await mine(U.ro)).body.items, [], '成员已移出（只读账号仍可见项目）：不再列');
  });

  // ── C4a 修订批（P31–P41 与预筛 M1 / M2 / L2 / L3）──────────────────────────────────────────────────
  test('C4a 失资格（L2）：没有任职 / 授权依据的必需确认人（只读账号作提出人的条目任务）被移出项目后 decide 409——「已移出」检查单独可观察（没有依据检查可以兜住）；对照：移出前同样请求通过', async () => {
    const pid = await newProject();
    await addMember(pid, U.ro);
    const roMember = await memberRow(pid, U.ro);
    const mkTask = async () => {
      const it = await mkItem(pid, { proposer_name: undefined, proposer_member_id: roMember });
      return (await sqlGet("SELECT id FROM sysbuild_confirm_tasks WHERE object_type = 'item_version' AND object_version_id = ?", [it.versions[0].id])).id;
    };
    const t1 = await mkTask();
    const t2 = await mkTask();
    const o1 = await openTask(U.ro, t1);
    assert.deepStrictEqual([o1.status, o1.body.actions.decide], [200, true]);
    assert.strictEqual((await decideRaw(U.ro, t1, decideBodyOf(o1.body, 'confirm'))).status, 200, '对照：未移出时提出人任务可确认');
    const o2 = await openTask(U.ro, t2); // 移出前打开：浏览证据齐备，下面 409 不是因为没浏览
    assert.strictEqual((await post(U.pm, `/sysbuild/members/${roMember}/remove`, { reason: '离项' })).status, 200);
    const o2b = await openTask(U.ro, t2); // 只读账号被移出后仍可见
    assert.deepStrictEqual([o2b.status, o2b.body.actions.decide], [200, false]);
    const dr = await decideRaw(U.ro, t2, decideBodyOf(o2.body, 'confirm'));
    expectErr(dr, 409, 'SYSBUILD_STATE', '成员已移出');
    assert.ok(dr.body.message.includes('成员'), `提示实际 ${dr.body.message}`);
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_confirmations WHERE task_revision_id = (SELECT id FROM sysbuild_confirm_task_revisions WHERE task_id = ?)', [t2]), 0);
  });

  test('C4a 确认人解析与资格同源（M1，进程内）：负责人账号停用后——提交 409 缺现任负责人；已有任务时改发 409 且 actions.reissue 为假、待我确认不列；提出人账号停用时建条目不生成任务；账号恢复后全部恢复', async () => {
    // 真实实例的鉴权中间件会先拦下停用账号，users.status 只能在进程内夹具里改（登记残余）。返回 T.SKIP：runAll 打印「跳过（进程内专属）」并在汇总行另计跳过数，
    //   不把这条记成「通过」（修订批二 LOW-6）。
    if (!isInproc()) return T.SKIP;
    const setUser = (uid, st) => sqlRun('UPDATE users SET status = ? WHERE id = ?', [st, uid]);
    // 1 提交
    const d = await mkDraft();
    await setUser(U.own, 'inactive');
    try {
      const r = await submit(U.pm, d.pv);
      expectErr(r, 409, 'SYSBUILD_STATE', '负责人账号停用');
      assert.ok(r.body.message.includes('甲部（缺现任负责人）'), `提示实际 ${r.body.message}`);
      assert.strictEqual(await verStatus(d.pv), 'draft');
    } finally { await setUser(U.own, 'active'); }
    assert.strictEqual((await submit(U.pm, d.pv)).status, 200, '账号恢复后提交通过');
    // 1b 代表人账号停用：总体规划包提交 409 缺生效代表人（立项包只要负责人，不受影响）
    const d2 = await mkDraft();
    await setUser(U.del, 'inactive');
    try {
      const r = await submit(U.pm, d2.pv);
      expectErr(r, 409, 'SYSBUILD_STATE', '代表人账号停用');
      assert.ok(r.body.message.includes('甲部（缺生效代表人）'), `提示实际 ${r.body.message}`);
    } finally { await setUser(U.del, 'active'); }
    assert.strictEqual((await submit(U.pm, d2.pv)).status, 200, '代表人账号恢复后提交通过');
    // 2 已有任务时停用负责人：改发不能生成同一个人的新修订
    const s = await mkSubmitted({ single: true });
    const mineOf = async (uid) => (await get(uid, '/sysbuild/my/confirmations')).body.items.filter((i) => i.project_id === s.pid).map((i) => i.task_id);
    assert.deepStrictEqual(await mineOf(U.own), [s.T.aOwner.task_id]);
    await setUser(U.own, 'inactive');
    try {
      assert.strictEqual((await openTask(U.pm, s.T.aOwner.task_id)).body.actions.reissue, false, '解析不到可用负责人：改发标志为假');
      const rr = await reissue(U.pm, s.T.aOwner.task_id, '改发');
      expectErr(rr, 409, 'SYSBUILD_STATE', '停用的负责人不能再被改发成同一个人');
      assert.ok(rr.body.message.includes('负责人'), `提示实际 ${rr.body.message}`);
      assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_confirm_task_revisions WHERE task_id = ?', [s.T.aOwner.task_id]), 1, '没有生成新修订');
      assert.deepStrictEqual(await mineOf(U.own), [], '账号停用：待我确认不列');
    } finally { await setUser(U.own, 'active'); }
    assert.deepStrictEqual(await mineOf(U.own), [s.T.aOwner.task_id], '账号恢复后重新列出');
    assert.strictEqual((await openTask(U.pm, s.T.aOwner.task_id)).body.actions.reissue, true);
    // 3 提出人账号停用：建条目不生成任务
    const pid = await newProject();
    const m2 = await addMember(pid, U.m2);
    await setUser(U.m2, 'inactive');
    try {
      const it = await mkItem(pid, { proposer_name: undefined, proposer_member_id: m2 });
      assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE object_type = 'item_version' AND object_version_id = ?", [it.versions[0].id]), 0, '提出人账号停用：不生成任务');
    } finally { await setUser(U.m2, 'active'); }
    const it2 = await mkItem(pid, { proposer_name: undefined, proposer_member_id: m2 });
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE object_type = 'item_version' AND object_version_id = ?", [it2.versions[0].id]), 1, '账号恢复后生成');
  });

  test('C4a 待我确认（L3②）：只列此刻还能作出确认的修订——任职结束 / 授权撤销的都不列（项目已终止见 P38 用例），与 decide 同一个资格判定', async () => {
    const s = await mkSubmitted({ single: true });
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
        for (const key of ['p_overall', 'b_req']) {
          const r = await post(U.pm, `/sysbuild/nodes/${p0.nodes.find((n) => n.template_key === key).id}/schedule`, { kind: 'plan', planned_start: '2026-11-02', planned_end: '2026-11-20' });
          assert.strictEqual(r.status, 201, r.text);
        }
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
    assert.strictEqual((await submit(U.pm, await mkVersion(pkI))).status, 200);
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
        const r = await post(U.pm, `/sysbuild/nodes/${p0.nodes.find((n) => n.template_key === 'p_overall').id}/schedule`, { kind: 'plan', planned_start: '2026-11-02', planned_end: '2026-11-30' });
        assert.strictEqual(r.status, 201, r.text);
      },
    });
    const plan0 = (await get(U.pm, `/sysbuild/projects/${s.pid}/plan`)).body;
    const overallId = plan0.nodes.find((n) => n.template_key === 'p_overall').id;
    // 除最后一条外全部确认
    const ts = await tasksOf(s.pv);
    const last = ts[ts.length - 1];
    for (const t of ts.slice(0, -1)) assert.strictEqual((await openAndDecide(t.user_id, t.task_id, 'confirm')).status, 200);
    const tryLast = async () => {
      const o = await openTask(last.user_id, last.task_id);
      return decideRaw(last.user_id, last.task_id, decideBodyOf(o.body, 'confirm'));
    };
    const expectBlocked = async (frag, label) => {
      const r = await tryLast();
      expectErr(r, 500, 'SYSBUILD_INTERNAL', label);
      assert.ok(r.body.message.includes(frag), `${label} 提示实际 ${r.body.message}`);
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
    await expectBlocked('与总体规划提交时的记录不一致', '提交后多出计划');
    await sqlRun('DELETE FROM sysbuild_node_schedule_records WHERE id = ?', [tamper1]);
    // 2 提交时有计划的节点之后计划被改（夹具）：日期不同 → 不一致
    const tamper2 = (await sqlRun("INSERT INTO sysbuild_node_schedule_records (node_id, kind, planned_start, planned_end, reason, created_by) VALUES (?, 'plan_change', '2026-11-03', '2026-11-30', '夹具', ?)", [overallId, U.pm])).lastID;
    await expectBlocked('与总体规划提交时的记录不一致', '提交后计划日期被改');
    await sqlRun('DELETE FROM sysbuild_node_schedule_records WHERE id = ?', [tamper2]);
    // 3 提交事件里没有节点计划记录（夹具：清空事件 payload）：无法核对 → 不形成基线
    const evRow = await sqlGet("SELECT id, payload_json FROM sysbuild_events WHERE project_id = ? AND event_type = 'package_version_submitted'", [s.pid]);
    await sqlRun("UPDATE sysbuild_events SET payload_json = '{}' WHERE id = ?", [evRow.id]);
    await expectBlocked('缺少节点计划记录', '提交事件缺记录');
    await sqlRun('UPDATE sysbuild_events SET payload_json = ? WHERE id = ?', [evRow.payload_json, evRow.id]);
    // 4 恢复一致：最后一条确认后生效，基线 = 提交时记录的计划
    const ok = await tryLast();
    assert.strictEqual(ok.status, 200, ok.text);
    assert.strictEqual(ok.body.effective, true);
    assert.deepStrictEqual((await baselinesIn(s.pid)).map((b) => [b.node_id, b.planned_start, b.planned_end]), (await inhouseNodePlans(s.pid)).map((x) => [x.node_id, x.planned_start, x.planned_end]), '基线 = 提交时记录的 6 个节点计划；提交后新增的节点（无计划）没有基线');
    assert.ok((await baselinesIn(s.pid)).some((b) => b.node_id === overallId));
    assert.strictEqual((await rowOf('sysbuild_batches', s.batch)).status, 'active', '恢复一致后生效，批次同事务推进到进行中（M-1）');
  });

  test('C4a 生效 LOW-1 / LOW-2：formBaselines 双向核对——提交记录里的节点生效时既没有基线、又不会形成基线（已取消 / 当前计划没了）→ 500 整体回滚，恢复后可生效；没有提交记录且没有节点需要形成基线时正常生效', async () => {
    // 反向（LOW-1）：提交时有计划的节点，生效时若既没有基线、又不会形成基线 → 500
    const s = await mkSubmitted({
      single: true,
      prepare: async (pid) => {
        const p0 = (await get(U.pm, `/sysbuild/projects/${pid}/plan`)).body;
        const r = await post(U.pm, `/sysbuild/nodes/${p0.nodes.find((n) => n.template_key === 'p_overall').id}/schedule`, { kind: 'plan', planned_start: '2026-11-02', planned_end: '2026-11-30' });
        assert.strictEqual(r.status, 201, r.text);
      },
    });
    const overallId = (await get(U.pm, `/sysbuild/projects/${s.pid}/plan`)).body.nodes.find((n) => n.template_key === 'p_overall').id;
    assert.deepStrictEqual((await payloads(s.pid, 'package_version_submitted'))[0].node_plans, await inhouseNodePlans(s.pid), 'H-1：提交前 6 个节点的计划都已补齐，提交事件记 6 项');
    const ts = await tasksOf(s.pv);
    const last = ts[ts.length - 1];
    for (const t of ts.slice(0, -1)) assert.strictEqual((await openAndDecide(t.user_id, t.task_id, 'confirm')).status, 200);
    const tryLast = async () => {
      const o = await openTask(last.user_id, last.task_id);
      return decideRaw(last.user_id, last.task_id, decideBodyOf(o.body, 'confirm'));
    };
    const expectBlocked = async (label) => {
      const r = await tryLast();
      expectErr(r, 500, 'SYSBUILD_INTERNAL', label);
      assert.ok(r.body.message.includes('既没有基线、也不能形成基线'), `${label} 提示实际 ${r.body.message}`);
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
    // 正向放宽（LOW-2）：没有提交记录（事件里没有 node_plans），但也没有任何节点需要形成基线 → 正常生效，不 500（为 C5 变更包生效复用留口）。
    //   H-1 之后提交前计划必须齐全，「没有节点需要形成基线」只能这样构造：提交后（夹具）给每个节点补一条 baseline（引用本版本），节点已有基线 = 不需要形成。
    const s2 = await mkSubmitted({ single: true });
    const nodes2 = await sqlAll('SELECT id FROM sysbuild_nodes WHERE project_id = ? ORDER BY id', [s2.pid]);
    for (const n of nodes2) {
      await sqlRun("INSERT INTO sysbuild_node_schedule_records (node_id, kind, planned_start, planned_end, package_version_id, created_by) VALUES (?, 'baseline', ?, ?, ?, ?)", [n.id, PLAN_START, PLAN_END, s2.pv, U.pm]);
    }
    const ev2 = await sqlGet("SELECT id FROM sysbuild_events WHERE project_id = ? AND event_type = 'package_version_submitted'", [s2.pid]);
    await sqlRun("UPDATE sysbuild_events SET payload_json = '{}' WHERE id = ?", [ev2.id]);
    const fin2 = await confirmAll(s2.pv);
    assert.strictEqual(fin2.status, 200, fin2.text);
    assert.deepStrictEqual([fin2.body.effective, fin2.body.baseline_node_ids], [true, []], '无记录、节点都已有基线（无需形成）：生效且不再形成基线');
    assert.strictEqual(await verStatus(s2.pv), 'effective');
    assert.strictEqual(await baselineCount(s2.pid), 6, '只有夹具写的 6 条，生效没有新增');
  });

  // ── P35 提交后新增需求部门 ──
  test('C4a P35：本项目有待确认的立项包 / 总体规划包时新建需求部门参与方 409，开发方不受影响；读接口 actions.party_sides 同步；撤回 / 生效后恢复', async () => {
    const MSG = '有待确认的内容包';
    await mkSubmitted({ single: true }); // 兄弟项目有一直待确认的总体规划包：只看本项目（过滤模式下用例单独运行，库里没有别的数据）
    const s = await mkSubmitted({ single: true });
    const mk = (uid, side, name) => post(uid, `/sysbuild/projects/${s.pid}/parties`, { side, name });
    const sides = async () => (await get(U.pm, `/sysbuild/projects/${s.pid}`)).body.actions.party_sides;
    assert.deepStrictEqual(await sides(), ['dev'], '待确认期间只剩开发方可建');
    for (const [uid, label] of [[U.pm, 'PM'], [U.admin, 'admin']]) {
      const r = await mk(uid, 'demand', `${label}建的需求部`);
      expectErr(r, 409, 'SYSBUILD_STATE', `${label} 建需求部门`);
      assert.ok(r.body.message.includes(MSG), `提示实际 ${r.body.message}`);
    }
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
    assert.strictEqual((await submit(U.pm, iv)).status, 200);
    expectErr(await post(U.pm, `/sysbuild/projects/${pid}/parties`, { side: 'demand', name: '乙部' }), 409, 'SYSBUILD_STATE', '立项包待确认');
    await confirmAll(iv);
    assert.strictEqual(await verStatus(iv), 'effective');
    assert.strictEqual((await post(U.pm, `/sysbuild/projects/${pid}/parties`, { side: 'demand', name: '乙部' })).status, 201, '立项包已生效：不再挡');
  });

  // ── P36 同一人两种身份 ──
  test('C4a P36：改发时新人已在本版本、同一参与方的另一类任务上确认 409（负责人 ⇄ 代表人两个方向，标志同步为假），已确认的修订保持有效；换第三人可改发；生效判定兜底——同一参与方两条任务确认人是同一用户则不生效', async () => {
    // 方向一：负责人任务改发给已确认了代表人任务的人
    const s = await mkSubmitted({ single: true });
    assert.strictEqual((await openAndDecide(U.del, s.T.aDel.task_id, 'confirm')).status, 200); // 代表人先确认（已确认的修订保持有效）
    assert.strictEqual((await openAndDecide(U.own, s.T.aOwner.task_id, 'object')).status, 200);
    await sqlRun("UPDATE sysbuild_appointments SET status = 'ended', ended_at = '2026-10-20 10:00:00', end_reason = '换人' WHERE id = ?", [s.A.apt]);
    const aptDel = await addAppointment(s.A.party, s.A.mDel, 'active'); // 夹具：代表人的成员行出任现任负责人
    assert.strictEqual((await openTask(U.pm, s.T.aOwner.task_id)).body.actions.reissue, false, '解析出的新人已确认过另一类任务：改发标志为假');
    const r1 = await reissue(U.pm, s.T.aOwner.task_id, '改发给代表人');
    expectErr(r1, 409, 'SYSBUILD_STATE', '同一人两种身份');
    assert.ok(r1.body.message.includes('同一人不能在本版本同时以负责人和代表人身份确认'), `提示实际 ${r1.body.message}`);
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
    const s2 = await mkSubmitted({ single: true });
    assert.strictEqual((await openAndDecide(U.own, s2.T.aOwner.task_id, 'confirm')).status, 200);
    assert.strictEqual((await openAndDecide(U.del, s2.T.aDel.task_id, 'object')).status, 200);
    await sqlRun("UPDATE sysbuild_delegations SET status = 'revoked', revoked_at = '2026-10-20 10:00:00', revoke_reason = '换人' WHERE id = ?", [s2.A.dlg]);
    await addDelegation(s2.A.party, s2.A.mOwn, s2.A.apt, 'active'); // 夹具：负责人本人被授权为代表人
    assert.strictEqual((await openTask(U.pm, s2.T.aDel.task_id)).body.actions.reissue, false);
    const r2 = await reissue(U.pm, s2.T.aDel.task_id, '改发给负责人');
    expectErr(r2, 409, 'SYSBUILD_STATE', '同一人两种身份（反方向）');
    assert.ok(r2.body.message.includes('同一人'), `提示实际 ${r2.body.message}`);
    // 只有「已确认」才算：另一类任务只是待确认（还没确认）时，同一个人被改发过来不被 P36 挡（之后若两条都由他确认，由生效判定兜底不生效）
    const s4 = await mkSubmitted({ single: true });
    assert.strictEqual((await openAndDecide(U.own, s4.T.aOwner.task_id, 'object')).status, 200);
    await sqlRun("UPDATE sysbuild_appointments SET status = 'ended', ended_at = '2026-10-20 10:00:00', end_reason = '换人' WHERE id = ?", [s4.A.apt]);
    await addAppointment(s4.A.party, s4.A.mDel, 'active');
    assert.strictEqual((await openTask(U.pm, s4.T.aOwner.task_id)).body.actions.reissue, true, '代表人任务只是待确认：不算冲突');
    assert.strictEqual((await reissue(U.pm, s4.T.aOwner.task_id, '改发给代表人')).status, 200);
    // 生效判定兜底：夹具让负责人 own 同时是本方代表人任务的必需确认人（正常路径被上面的改发拦下），两条都确认也不生效
    const s3 = await mkSubmitted({ single: true });
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
  test('C4a P38：终止项目——同一事务里本项目全部待确认修订（内容包任务与提出人任务）置已失效（原因「项目已终止」），已确认的不动，各写事件；已终止项目的待确认修订不在待我确认里；重开后 PM 可改发已失效的修订并走完确认生效', async () => {
    const s = await mkSubmitted({ single: true });
    const m1 = await addMember(s.pid, U.m1);
    const pit = await mkItem(s.pid, { proposer_name: undefined, proposer_member_id: m1 });
    const ptid = (await sqlGet("SELECT t.id AS tid, r.id AS rid FROM sysbuild_confirm_tasks t JOIN sysbuild_confirm_task_revisions r ON r.task_id = t.id WHERE t.object_type = 'item_version' AND t.object_version_id = ?", [pit.versions[0].id]));
    const other = await mkSubmitted({ single: true }); // 另一个项目的待确认修订：终止本项目不得波及
    assert.strictEqual((await openAndDecide(U.own, s.T.aOwner.task_id, 'confirm')).status, 200);
    assert.strictEqual((await setStatus(s.pid, 'terminated')).status, 200);
    assert.deepStrictEqual([(await revOf(other.T.aOwner.rev_id)).status, (await revOf(other.T.aDel.rev_id)).status], ['pending', 'pending'], '别的项目的待确认修订不受影响');
    const own = await revOf(s.T.aOwner.rev_id);
    assert.deepStrictEqual([own.status, own.status_reason], ['confirmed', null], '已确认的修订不动');
    for (const rid of [s.T.aDel.rev_id, ptid.rid]) {
      const rv = await revOf(rid);
      assert.deepStrictEqual([rv.status, rv.status_reason], ['invalid', '项目已终止'], `修订 ${rid}`);
    }
    assert.deepStrictEqual(await payloads(s.pid, 'confirm_revision_invalidated'), [
      { revision_id: s.T.aDel.rev_id, object_type: 'package_version', object_version_id: s.pv, reason: '项目已终止' },
      { revision_id: ptid.rid, object_type: 'item_version', object_version_id: pit.versions[0].id, reason: '项目已终止' },
    ]);
    assert.strictEqual(await verStatus(s.pv), 'pending', '版本本身不动（等重开后继续）');
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
    assert.strictEqual((await revOf(s.T.aDel.rev_id)).status, 'invalid', '旧的已失效修订保持原状');
    assert.deepStrictEqual(await mineOf(U.del), [s.T.aDel.task_id]);
    const fin = await openAndDecide(U.del, s.T.aDel.task_id, 'confirm');
    assert.strictEqual(fin.status, 200, fin.text);
    assert.strictEqual(fin.body.effective, true, '重开后改发并确认，内容包生效');
    // 提出人任务的失效修订：C4b 才能改发，decide 409
    expectErr(await decideRaw(U.m1, ptid.tid, decideBodyOf((await openTask(U.m1, ptid.tid)).body, 'confirm')), 409, 'SYSBUILD_STATE', '失效的提出人修订不能决策');
    // 暂停不失效：暂停 → 恢复后待确认修订照旧
    const s2 = await mkSubmitted({ single: true });
    assert.strictEqual((await setStatus(s2.pid, 'paused')).status, 200);
    assert.strictEqual((await revOf(s2.T.aOwner.rev_id)).status, 'pending', '暂停不失效待确认修订');
  });

  // ── 收口前置：内容包已生效 ──
  test('C4a 收口前置：内容包已生效（PACKAGE_NOT_EFFECTIVE）——立项与授权需立项包生效、总体范围与批次规划和需求确认需总体规划包生效、用户验收测试需本批批次验收包生效；草稿 / 待确认 / 别的批次的包不算；读接口 close_blockers 与收口 409 同源；排在 PLAN_MISSING 之后', async () => {
    // 兄弟项目有生效的立项包与总体规划包：本项目的内容包事实不得取到它们（过滤模式下用例单独运行，库里没有别的项目的数据）
    await H.produceEffectiveOverall(await newProject('outsource'));
    // 0 PLAN_MISSING 与 PACKAGE_NOT_EFFECTIVE 同时存在：两条都给，PLAN_MISSING 在前
    const pid0 = await newProject('outsource');
    const reqId0 = (await get(U.pm, `/sysbuild/projects/${pid0}/plan`)).body.nodes.find((n) => n.template_key === 'b_req').id;
    assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${reqId0}/start`)).status, 200);
    const r0 = await post(U.pm, `/sysbuild/nodes/${reqId0}/close`);
    expectErr(r0, 409, 'SYSBUILD_CLOSE_BLOCKED', '缺计划 + 总体规划未生效');
    assert.deepStrictEqual(r0.body.blockers.map((b) => b.code), ['PLAN_MISSING', 'PACKAGE_NOT_EFFECTIVE']);
    // 1 全部计划到位（草稿期计划），四个节点开始；全部未生效 → 各自恰一个 PACKAGE_NOT_EFFECTIVE
    const pid = await newProject('outsource');
    await seedParty(pid, '甲部', U.own, U.del);
    const p0 = (await get(U.pm, `/sysbuild/projects/${pid}/plan`)).body;
    for (const n of p0.nodes) {
      const r = await post(U.pm, `/sysbuild/nodes/${n.id}/schedule`, { kind: 'plan', planned_start: '2026-11-02', planned_end: '2026-11-30' });
      assert.strictEqual(r.status, 201, `${n.template_key}: ${r.text}`);
    }
    const idOf = (key) => p0.nodes.find((n) => n.template_key === key).id;
    const KEYS = [['p_initiation', '立项包'], ['p_overall', '总体规划包'], ['b_req', '总体规划包'], ['b_uat', '批次验收包']];
    for (const [key] of KEYS) assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${idOf(key)}/start`)).status, 200, `${key} 开始`);
    const blockersOf = async (key) => (await get(U.pm, `/sysbuild/projects/${pid}/plan`)).body.nodes.find((n) => n.template_key === key).close_blockers;
    const expectBlocked = async (key, frag) => {
      const r = await post(U.pm, `/sysbuild/nodes/${idOf(key)}/close`);
      expectErr(r, 409, 'SYSBUILD_CLOSE_BLOCKED', `${key} 被内容包前置挡住`);
      assert.deepStrictEqual(r.body.blockers.map((b) => [b.code, b.node_ids]), [['PACKAGE_NOT_EFFECTIVE', [idOf(key)]]], `${key} 的阻塞项`);
      assert.ok(r.body.blockers[0].message.includes(frag), `${key} 提示实际 ${r.body.blockers[0].message}`);
      assert.deepStrictEqual(await blockersOf(key), r.body.blockers, `${key}：读接口 close_blockers 与收口 409 同源`);
    };
    for (const [key, frag] of KEYS) await expectBlocked(key, frag);
    // 2 立项包：草稿 / 待确认都不算，生效后 p_initiation 放行，其余仍被挡
    const pkI = await mkPackage(pid, 'initiation');
    const iv = await mkVersion(pkI);
    await expectBlocked('p_initiation', '立项包');
    assert.strictEqual((await submit(U.pm, iv)).status, 200);
    await expectBlocked('p_initiation', '立项包');
    await confirmAll(iv);
    assert.deepStrictEqual(await blockersOf('p_initiation'), []);
    assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${idOf('p_initiation')}/close`)).status, 200);
    for (const key of ['p_overall', 'b_req', 'b_uat']) assert.strictEqual((await blockersOf(key)).length, 1, `${key} 仍被挡`);
    // 3 总体规划包：生效后 p_overall 与 b_req 放行；b_uat 仍被挡
    await H.produceEffectiveOverall(pid);
    assert.deepStrictEqual([await blockersOf('p_overall'), await blockersOf('b_req')], [[], []]);
    assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${idOf('p_overall')}/close`)).status, 200);
    assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${idOf('b_req')}/close`)).status, 200);
    await expectBlocked('b_uat', '批次验收包');
    // 4 批次验收包（夹具：批次验收包的提交 C6 才开放，C6 之前 b_uat 收口恒被挡——有意的收紧）：别的批次的生效包不算，本批的待确认不算，本批生效才放行
    const batch1 = await defaultBatchId(pid);
    const seq2 = (await sqlGet('SELECT MAX(seq) AS m FROM sysbuild_batches WHERE project_id = ?', [pid])).m + 1;
    const batch2 = (await sqlRun("INSERT INTO sysbuild_batches (project_id, seq, name, is_default, status) VALUES (?, ?, '夹具批次2', 0, 'planning')", [pid, seq2])).lastID;
    const mkAccept = async (bid, status) => {
      const pk = (await sqlRun("INSERT INTO sysbuild_packages (project_id, batch_id, type, created_by) VALUES (?, ?, 'batch_accept', ?)", [pid, bid, U.pm])).lastID;
      const vid = (await sqlRun(
        `INSERT INTO sysbuild_package_versions (package_id, version_no, form, status, effective_at, snapshot_json, created_by) VALUES (?, 1, NULL, ?, ${status === 'effective' ? "datetime('now','localtime')" : 'NULL'}, '{}', ?)`,
        [pk, status, U.pm]
      )).lastID;
      return { pk, vid };
    };
    await mkAccept(batch2, 'effective');
    await expectBlocked('b_uat', '批次验收包');
    const acc1 = await mkAccept(batch1, 'pending');
    await expectBlocked('b_uat', '批次验收包');
    await sqlRun("UPDATE sysbuild_package_versions SET status = 'effective', effective_at = datetime('now','localtime') WHERE id = ?", [acc1.vid]);
    assert.deepStrictEqual(await blockersOf('b_uat'), []);
    assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${idOf('b_uat')}/close`)).status, 200, '本批批次验收包生效后放行');
  });

  // ── H-1 读接口信号（M2 → 修订批三改为 draft / reschedule 两态 + has_baseline）──
  test('C4a H-1 读接口信号：节点视图 plan_write_mode——没有生效的总体规划 = draft；总体规划生效后（节点有无基线都一样）= reschedule；has_baseline 区分有无基线；与 POST schedule 的实际落点一致', async () => {
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
    assert.deepStrictEqual(await modeOf('p_overall'), ['reschedule', true], '基线随生效形成：reschedule + 有基线');
    assert.deepStrictEqual(await modeOf('p_closing'), ['reschedule', true]);
    // 生效后新增的节点：尚无基线，仍是 reschedule（改期式写入），has_baseline 为假
    const added = await post(U.pm, `/sysbuild/batches/${await defaultBatchId(pid)}/nodes`, { name: '生效后新增' });
    assert.strictEqual(added.status, 201, added.text);
    assert.deepStrictEqual([added.body.node.plan_write_mode, added.body.node.has_baseline], ['reschedule', false]);
    const evid = { reason: '客户要求', no_written_evidence: true, no_evidence_reason: '电话沟通后已确认该安排' };
    const w1 = await post(U.pm, `/sysbuild/nodes/${added.body.node.id}/schedule`, Object.assign({ kind: 'plan', planned_start: '2027-01-04', planned_end: '2027-01-15' }, evid));
    assert.strictEqual(w1.status, 201, w1.text);
    assert.deepStrictEqual(await recordsKinds(added.body.node.id), ['plan_change'], '尚无基线的节点：落点 = 改期式 plan_change，不写 baseline');
    assert.deepStrictEqual(await modeOf('p_overall'), ['reschedule', true]);
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
  test('C4a actions 与执行一致：submit 标志承诺权限、对象状态、立项前置、确认人齐全、计划齐全（条目集合的提交时重核失败仍可能 409，不在承诺内）；withdraw / decide / reissue 标志为真则执行 2xx，为假则执行非 2xx（草稿 / 待确认 / 已确认各状态，PM / 成员 / 必需确认人各身份）', async () => {
    const d = await mkDraft();
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
    const ownerFlags = (await openTask(U.own, tid)).body.actions;
    assert.deepStrictEqual(ownerFlags, { decide: true, proxy: false, reissue: false, export_sheet: true });
    const pmFlags = (await openTask(U.pm, tid)).body.actions;
    assert.deepStrictEqual(pmFlags, { decide: false, proxy: true, reissue: true, export_sheet: true });
    const o = await openTask(U.own, tid);
    assert.ok((await reissue(U.own, tid, '本人改发')).status >= 400, '必需确认人 reissue 标志为假');
    assert.ok((await decideRaw(U.pm, tid, decideBodyOf(o.body, 'confirm'))).status >= 400, 'PM decide 标志为假');
    const dec = await decideRaw(U.own, tid, decideBodyOf(o.body, 'confirm'));
    assert.ok(dec.status >= 200 && dec.status < 300, `decide 标志为真，执行应成功: ${dec.text}`);
    // 已确认：decide 假 / reissue 假（当前修订已确认）
    const after = (await openTask(U.own, tid)).body.actions;
    assert.deepStrictEqual(after, { decide: false, proxy: false, reissue: false, export_sheet: true });
    assert.ok((await decideRaw(U.own, tid, decideBodyOf(o.body, 'confirm'))).status >= 400, '已确认 decide 标志为假');
    assert.ok((await reissue(U.pm, tid, '已确认再改发')).status >= 400, '已确认 reissue 标志为假');
    // 待确认版本 withdraw 真 → 执行成功后标志全假
    const wd = await withdraw(U.pm, d.pv, '撤回');
    assert.ok(wd.status >= 200 && wd.status < 300, `withdraw 标志为真，执行应成功: ${wd.text}`);
    f = await flagsOfVersion(U.pm, d.pv);
    assert.deepStrictEqual([f.submit, f.withdraw], [false, false]);
    // 反例：改发为真 → 执行 2xx（不认可的修订）
    const s = await mkSubmitted({ single: true });
    assert.strictEqual((await openAndDecide(U.own, s.T.aOwner.task_id, 'reject')).status, 200);
    assert.strictEqual((await openTask(U.pm, s.T.aOwner.task_id)).body.actions.reissue, true);
    const ri = await reissue(U.pm, s.T.aOwner.task_id, '重新请对方确认');
    assert.ok(ri.status >= 200 && ri.status < 300, `reissue 标志为真，执行应成功: ${ri.text}`);
    // 已终止项目：所有标志为假，执行 409
    assert.strictEqual((await setStatus(s.pid, 'terminated')).status, 200);
    const tf = (await openTask(U.pm, s.T.aOwner.task_id)).body.actions;
    assert.deepStrictEqual(tf, { decide: false, proxy: false, reissue: false, export_sheet: true });
    const vf = await flagsOfVersion(U.pm, s.pv);
    assert.deepStrictEqual([vf.submit, vf.withdraw], [false, false]);
    assert.ok((await withdraw(U.pm, s.pv, '终止后撤回')).status >= 400);
    // L3①：改发要先解析出可作为确认人的新负责人 / 代表人——解析不到时标志为假、执行 409（同一判定，不再「标志为真执行 409」）
    const s2 = await mkSubmitted({ single: true });
    assert.strictEqual((await openTask(U.pm, s2.T.aOwner.task_id)).body.actions.reissue, true, '有现任负责人：改发标志为真');
    await sqlRun("UPDATE sysbuild_appointments SET status = 'ended', ended_at = '2026-10-20 10:00:00', end_reason = '离任' WHERE id = ?", [s2.A.apt]);
    assert.strictEqual((await openTask(U.pm, s2.T.aOwner.task_id)).body.actions.reissue, false, '没有现任负责人：改发标志为假');
    const none = await reissue(U.pm, s2.T.aOwner.task_id, '改发');
    assert.ok(none.status >= 400, '标志为假，执行应失败');
    assert.strictEqual(none.status, 409);
    await sqlRun("UPDATE sysbuild_delegations SET status = 'revoked', revoked_at = '2026-10-20 10:00:00', revoke_reason = '换人' WHERE id = ?", [s2.A.dlg]);
    assert.strictEqual((await openTask(U.pm, s2.T.aDel.task_id)).body.actions.reissue, false, '没有生效代表人：代表人任务的改发标志为假');
    assert.ok((await reissue(U.pm, s2.T.aDel.task_id, '改发')).status >= 400);
    // MED-1：submit 标志的项目级前置与执行同源——立项包未生效 / 缺生效代表人 / 项目没有需求部门：标志为假且执行 409（同一文案）；补齐后标志为真且执行 2xx
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
    assert.strictEqual(await submitFlag(dM.pv), false, '缺生效代表人：submit 标志为假');
    const rM = await submit(U.pm, dM.pv);
    expectErr(rM, 409, 'SYSBUILD_STATE', '缺生效代表人');
    assert.ok(rM.body.message.includes('甲部（缺生效代表人）'), `提示实际 ${rM.body.message}`);
    await addDelegation(dM.A.party, await addMember(dM.pid, U.del, { party: dM.A.party }), dM.A.apt, 'active');
    assert.strictEqual(await submitFlag(dM.pv), true, '补上生效代表人后标志为真');
    assert.strictEqual((await submit(U.pm, dM.pv)).status, 200, '标志为真，执行应成功');
    // H-1 / P43：计划齐全——缺计划时标志为假且执行 409（同一文案）；补齐后标志为真且执行 2xx
    const dP = await mkDraft({ noPlans: true });
    assert.strictEqual(await submitFlag(dP.pv), false, '节点缺计划：submit 标志为假');
    const rP = await submit(U.pm, dP.pv);
    expectErr(rP, 409, 'SYSBUILD_STATE', '节点缺计划');
    assert.ok(rP.body.message.includes('还没有计划起止日期') && rP.body.message.includes('立项与授权'), `提示实际 ${rP.body.message}`);
    assert.strictEqual(await planAllNodes(dP.pid), 6);
    assert.strictEqual(await submitFlag(dP.pv), true, '补齐计划后标志为真');
    assert.strictEqual((await submit(U.pm, dP.pv)).status, 200, '标志为真，执行应成功');
    const dN = await mkDraft({ noParty: true });
    assert.strictEqual(await submitFlag(dN.pv), false, '项目没有需求部门参与方：submit 标志为假');
    expectErr(await submit(U.pm, dN.pv), 409, 'SYSBUILD_STATE', '无需求部门');
    // 标志不承诺条目集合的提交时重核（P24）：集合为空时标志为真、执行 409
    const dE = await mkDraft({ emptySet: true });
    assert.strictEqual(await submitFlag(dE.pv), true, '集合空：标志仍为真（集合重核只在执行时做）');
    expectErr(await submit(U.pm, dE.pv), 409, 'SYSBUILD_STATE', '集合空');
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
    { file: 'confirm.js', from: "WHERE id = ? AND status = 'draft'\", [vid]);", to: 'WHERE id = ?", [vid]);' },
  ] },
  { id: 'C4a 提交：类型不开放判定放开 batch_req', expect: ['C4a rules：新动作'], edits: [{ file: 'rules.js', from: "const SUBMITTABLE_PACKAGE_TYPES = Object.freeze(['overall', 'initiation', 'change', 'batch_accept', 'closing']);", to: "const SUBMITTABLE_PACKAGE_TYPES = Object.freeze(['overall', 'initiation', 'change', 'batch_accept', 'closing', 'batch_req']);" }] }, // S-S1c：清单加了 change；C6a：closing / batch_accept 已开放，锚点与目标改为放开 batch_req（第一期不建批次需求包，只有 rules 用例的类型矩阵能验）
  { id: 'C4a 提交：一般成员也能提交', expect: ['C4a 提交：权限与项目状态'], edits: [{ file: 'rules.js', from: 'package_version_submit: Object.freeze({\n    can: canActAsPm,', to: 'package_version_submit: Object.freeze({\n    can: canRegisterItem,' }] },
  { id: 'C4a 提交：项目状态类别改成 close（已暂停不能提交）', expect: ['C4a 提交：权限与项目状态', 'C4a rules：新动作'], edits: [{ file: 'rules.js', from: "package_version_submit: 'maintain',", to: "package_version_submit: 'close'," }] },
  { id: 'C4a 提交：条目集合为空放行', expect: ['C4a 提交：失败分支'], edits: [{ file: 'confirm.js', from: "if (set.length === 0) throw stateError('总体规划的条目集合为空，请先添加条目');", to: '' }] },
  { id: 'C4a 提交：条目没有承诺批次不判', expect: ['C4a 提交：失败分支'], edits: [{ file: 'confirm.js', from: 'if (it.committed_batch_id === null) bad.noBatch.push(label);', to: 'if (false) bad.noBatch.push(label);' }] },
  { id: 'C4a 提交：承诺批次已转出 / 被替代不判', expect: ['C4a 提交：失败分支'], edits: [{ file: 'confirm.js', from: 'if (!batch || rules.BATCH_FROZEN_STATUSES.includes(batch.status)) bad.batchGone.push(label);', to: 'if (!batch) bad.batchGone.push(label);' }] },
  { id: 'C4a 提交：条目版本不属本项目不判', expect: ['C4a 提交：失败分支'], edits: [{ file: 'confirm.js', from: 'if (!row || row.project_id !== pid) { bad.project.push(label); continue; }', to: 'if (!row) { bad.project.push(label); continue; }' }] },
  { id: 'C4a 提交：承诺批次属于别的项目不判', expect: ['C4a 提交：失败分支'], edits: [{ file: 'confirm.js', from: "SELECT id, status FROM sysbuild_batches WHERE id = ? AND project_id = ?', [bid, pid])", to: "SELECT id, status FROM sysbuild_batches WHERE id = ? AND project_id = ?', [bid, pid]) || { id: bid, status: 'planning' }" }] },
  { id: 'C4a 提交：已上线条目换到未上线批次不判', expect: ['C4a 提交：已上线条目'], edits: [{ file: 'confirm.js', from: 'if (was && (await isLive(was.id)) && !(await isLive(batch.id))) bad.liveMove.push(label);', to: '' }] },
  { id: 'C4a 提交：方向类证据不重核', expect: ['C4a 提交：方向类证据'], edits: [{ file: 'confirm.js', from: 'if (n === 0 && !reasonOk) bad.evidence.push(label);', to: '' }] },
  { id: 'C4a 提交：方向类证据只数绑定不数引用', expect: ['C4a 提交：方向类证据'], edits: [{ file: 'confirm.js', from: "UNION SELECT attachment_id FROM sysbuild_attachment_refs WHERE owner_type = 'item_version' AND owner_id = ?)", to: "UNION SELECT attachment_id FROM sysbuild_attachment_bindings WHERE owner_type = 'item_version' AND owner_id = ?)" }] },
  { id: 'C4a 提交：方向类证据把已软删除的附件也数进去', expect: ['C4a 提交：方向类证据'], edits: [{ file: 'confirm.js', from: 'WHERE a.deleted_at IS NULL\n          AND a.id IN (SELECT attachment_id FROM sysbuild_attachment_bindings', to: 'WHERE 1 = 1\n          AND a.id IN (SELECT attachment_id FROM sysbuild_attachment_bindings' }] },
  // P32：form / parent 提交时重算并回写。「回写的旧状态条件」与规则层的草稿判定互为双重保险（同一写事务内串行），单独去掉条件观察不到，所以对应变异把规则层判定、回写条件、状态更新条件三处同时去掉
  { id: 'C4a 提交 P32：重算后不回写（沿用草稿存的值）', expect: ['C4a 提交 P32'], edits: [{ file: 'packages.js', from: 'SET form = ?, parent_overall_version_id = ?, updated_at', to: 'SET form = COALESCE(form, ?), parent_overall_version_id = COALESCE(parent_overall_version_id, ?), updated_at' }] },
  { id: 'C4a 提交 P32：回写的旧状态条件、规则层草稿判定与状态更新条件同时去掉', expect: ['C4a 提交 P32'], edits: [
    { file: 'rules.js', from: "if (t.versionStatus !== 'draft') return '只有草稿版本可以提交确认';", to: '' },
    { file: 'packages.js', from: "parent_overall_version_id = ?, updated_at = datetime('now','localtime') WHERE id = ? AND status = 'draft'\",", to: "parent_overall_version_id = ?, updated_at = datetime('now','localtime') WHERE id = ?\"," },
    { file: 'confirm.js', from: "WHERE id = ? AND status = 'draft'\", [vid]);", to: 'WHERE id = ?", [vid]);' },
  ] },
  { id: 'C4a 提交 P32：form 变化不记事件', expect: ['C4a 提交 P32'], edits: [{ file: 'packages.js', from: 'if (ver.form !== calc.form) { changed.form_from = ver.form; changed.form_to = calc.form; }', to: '' }] },
  { id: 'C4a 提交 P32：parent 变化不记事件', expect: ['C4a 提交 P32'], edits: [{ file: 'packages.js', from: 'if (ver.parent_overall_version_id !== calc.parent) { changed.parent_from = ver.parent_overall_version_id; changed.parent_to = calc.parent; }', to: '' }] },
  { id: 'C4a 提交 P32：事件的 form 取回写前的旧值', expect: ['C4a 提交 P32'], edits: [{ file: 'confirm.js', from: 'version_no: ver.version_no, form: calc.form, item_count: set.length,', to: 'version_no: ver.version_no, form: ver.form, item_count: set.length,' }] },
  // P37：总体规划包提交前须立项包已生效（修订批二 MED-1 起判定在 rules.js package_version_submit，事实取自 packages.js versionFactsOf / effectiveInitiationVersionId）
  { id: 'C4a 提交 P37：不核对立项包是否生效', expect: ['C4a 提交 P37'], edits: [{ file: 'rules.js', from: "if (t.packageType === 'overall' && t.initiationEffective !== true) return INITIATION_NOT_EFFECTIVE_MESSAGE;", to: '' }] },
  { id: 'C4a 提交 P37：立项包待确认也算', expect: ['C4a 提交 P37'], edits: [{ file: 'packages.js', from: "p.type = 'initiation' AND v.status = 'effective' ORDER BY v.id DESC LIMIT 1", to: "p.type = 'initiation' AND v.status IN ('effective', 'pending') ORDER BY v.id DESC LIMIT 1" }] },
  { id: 'C4a 提交 P37：立项包生效不限本项目', expect: ['C4a 提交 P37'], edits: [{ file: 'packages.js', from: "WHERE p.project_id = ? AND p.type = 'initiation' AND v.status = 'effective' ORDER BY v.id DESC LIMIT 1", to: "WHERE (p.project_id = ? OR 1 = 1) AND p.type = 'initiation' AND v.status = 'effective' ORDER BY v.id DESC LIMIT 1" }] },
  { id: 'C4a 提交 P37：立项包自己的提交也要求立项包已生效', expect: ['C4a 提交 P37', 'C4a 提交：立项包成功'], edits: [{ file: 'rules.js', from: "if (t.packageType === 'overall' && t.initiationEffective !== true)", to: 'if (t.initiationEffective !== true)' }] },
  { id: 'C4a 提交：项目没有需求部门参与方放行', expect: ['C4a 提交：失败分支'], edits: [{ file: 'confirm-core.js', from: 'if (r.noParty) return { noParty: true, missing: [] };', to: 'if (r.noParty) return null;' }] },
  { id: 'C4a 提交：缺必需确认人放行', expect: ['C4a 提交：失败分支'], edits: [{ file: 'confirm-core.js', from: 'return r.missing.length > 0 ? { noParty: false, missing: r.missing } : null;', to: 'return null;' }] },
  { id: 'C4a 提交：总体规划包不要代表人', expect: ['C4a 提交：失败分支', 'C4a 提交：总体规划包成功'], edits: [{ file: 'confirm-core.js', from: 'if (DELEGATE_CONFIRM_PACKAGE_TYPES.includes(packageType)) {', to: 'if (false) {' }] }, // S-S1c：变更包与总体规划包同为负责人 + 代表人，锚点随之改写（C6a：改为共用类型表）
  { id: 'C4a 提交：立项包也要代表人', expect: ['C4a 提交：立项包成功'], edits: [{ file: 'confirm-core.js', from: 'if (DELEGATE_CONFIRM_PACKAGE_TYPES.includes(packageType)) {', to: 'if (true) {' }] }, // S-S1c：同上
  // C4b P44：原变异「负责人不要求有平台账号」（把 C4a 的一档判定放宽到无账号成员）随契约翻转——现在无账号成员本来就是代录确认人，对应变异是把它收回成 C4a 的一档判定（无账号视为缺人）。
  { id: 'C4b P44：无账号成员不算确认人（收回成 C4a 的一档判定）', expect: ['C4a 提交：失败分支', 'C4b 代录：无账号'], edits: [
    { file: 'confirm-core.js', from: "const CONFIRMER_ELIGIBLE_SQL = `${rules.MEMBER_ACTIVE_SQL} AND (m.user_id IS NULL OR u.status = 'active')`;", to: "const CONFIRMER_ELIGIBLE_SQL = `${rules.MEMBER_ACTIVE_SQL} AND u.status = 'active'`;" },
  ] },
  // M1：确认人解析与资格复核同源（可作为确认人 = 成员已加入未移出 + 有平台账号且 active，或无账号（C4b P44），CONFIRMER_ELIGIBLE_SQL 一处定义）
  { id: 'C4a 确认人解析 M1：解析去掉账号状态条件', expect: ['C4a 确认人解析与资格同源', 'C4a 失资格'], edits: [{ file: 'confirm-core.js', from: "const CONFIRMER_ELIGIBLE_SQL = `${rules.MEMBER_ACTIVE_SQL} AND (m.user_id IS NULL OR u.status = 'active')`;", to: 'const CONFIRMER_ELIGIBLE_SQL = `${rules.MEMBER_ACTIVE_SQL}`;' }] },
  { id: 'C4a 确认人解析 M1：提出人任务生成不查账号状态', expect: ['C4a 确认人解析与资格同源'], edits: [{ file: 'confirm-core.js', from: 'const m = await eligibleMember(q, o.proposerMemberId);', to: "const m = await q.get('SELECT m.id AS id, m.party_id AS party_id FROM sysbuild_members m WHERE m.id = ? AND m.user_id IS NOT NULL AND m.removed_at IS NULL AND m.joined_at IS NOT NULL', [o.proposerMemberId]);" }] },
  { id: 'C4a 确认人解析 M1：代表人解析不查账号状态', expect: ['C4a 确认人解析与资格同源'], edits: [{ file: 'confirm-core.js', from: "WHERE d.party_id = ? AND d.status = 'active' AND ${CONFIRMER_ELIGIBLE_SQL} ORDER BY d.id DESC LIMIT 1", to: "WHERE d.party_id = ? AND d.status = 'active' AND ${rules.MEMBER_ACTIVE_SQL} ORDER BY d.id DESC LIMIT 1" }] },
  { id: 'C4a 提交：条目附件不冻结', expect: ['C4a 提交：总体规划包成功'], edits: [{ file: 'confirm.js', from: "await attachmentHelpers.freezeAttachmentSet(q, { objectType: 'package_version', objectVersionId: vid, ownerType: 'item_version', ownerId: it.item_version_id, operatorId: opId, operatorName: opName, projectId: pid });", to: '' }] },
  { id: 'C4a 提交：包版本自己的材料附件不冻结', expect: ['C4a 提交：总体规划包成功'], edits: [{ file: 'confirm.js', from: "await attachmentHelpers.freezeAttachmentSet(q, { objectType: 'package_version', objectVersionId: vid, ownerType: 'package_version', ownerId: vid, operatorId: opId, operatorName: opName, projectId: pid });", to: '' }] },
  // ── 撤回 ──
  { id: 'C4a 撤回：已生效的版本也能撤回', expect: ['C4a 撤回：草稿 / 已生效', 'C4a rules：新动作'], edits: [{ file: 'rules.js', from: "(t.versionStatus === 'pending' ? null : '只有待确认的版本可以撤回提交，已生效的版本不能撤回')", to: "(t.versionStatus !== 'superseded' ? null : '只有待确认的版本可以撤回提交，已生效的版本不能撤回')" }] },
  { id: 'C4a 撤回：待确认修订不置失效', expect: ['C4a 撤回：待确认'], edits: [{ file: 'confirm.js', from: "for (const r of revs) await core.closePendingRevision(q, r.id, 'invalid', reason);", to: '' }] },
  { id: 'C4a 撤回：原因不必填', expect: ['C4a 撤回：待确认'], edits: [{ file: 'confirm.js', from: "readText(body.reason, 'reason', '撤回原因', REASON_MAX, true)", to: "readText(body.reason, 'reason', '撤回原因', REASON_MAX, false) || '未写'" }] },
  { id: 'C4a 撤回：非 PM 也能撤回', expect: ['C4a 撤回：待确认'], edits: [{ file: 'rules.js', from: 'package_version_withdraw: Object.freeze({\n    can: canActAsPm,', to: 'package_version_withdraw: Object.freeze({\n    can: canRegisterItem,' }] },
  { id: 'C4a 撤回：项目状态类别改成 resolve（已终止也能撤回）', expect: ['C4a 撤回：草稿 / 已生效', 'C4a rules：新动作'], edits: [{ file: 'rules.js', from: "package_version_withdraw: 'maintain',", to: "package_version_withdraw: 'resolve'," }] },
  // ── 浏览 ──
  { id: 'C4a 浏览：非必需确认人打开也写浏览记录', expect: ['C4a 浏览：'], edits: [{ file: 'confirm.js', from: 'const shouldRecord = target.isRequired && c.latest.status === \'pending\';', to: "const shouldRecord = c.latest.status === 'pending';" }] },
  { id: 'C4a 浏览：必需确认人打开不写浏览记录', expect: ['C4a 浏览：', 'C4a 决策：成功路径'], edits: [{ file: 'confirm.js', from: 'if (record && shouldRecord) {', to: 'if (false) {' }] },
  { id: 'C4a 浏览：浏览记录里的冻结清单写成空', expect: ['C4a 浏览：', 'C4a 决策：409 各分支'], edits: [{ file: 'confirm.js', from: '[Number(user.id), c.task.object_type, c.task.object_version_id, JSON.stringify(frozen)]', to: "[Number(user.id), c.task.object_type, c.task.object_version_id, '[]']" }] },
  { id: 'C4a 浏览：任务读接口不查项目可见性', expect: ['C4a 浏览：'], edits: [{ file: 'confirm.js', from: "rules.assertVisible(access);\n    if (task.object_type === 'invitation' || task.object_type === 'delegation') {", to: "if (task.object_type === 'invitation' || task.object_type === 'delegation') {" }] },
  // ── 决策 ──
  { id: 'C4a 决策：任何人都能决策', expect: ['C4a 决策：403 / 404', 'C4a rules：新动作'], edits: [{ file: 'rules.js', from: 'can: (identity, project, t) => t.isRequired === true,', to: 'can: () => true,' }] },
  { id: 'C4a 决策：当前修订取第一条而不是最新一条', expect: ['C4a 改发：负责人更换后改发'], edits: [{ file: 'confirm-core.js', from: 'FROM sysbuild_confirm_task_revisions WHERE task_id = ? ORDER BY rev_no DESC LIMIT 1', to: 'FROM sysbuild_confirm_task_revisions WHERE task_id = ? ORDER BY rev_no ASC LIMIT 1' }] },
  { id: 'C4a 决策：修订编号不核对', expect: ['C4a 决策：409 各分支', 'C4a rules：新动作'], edits: [{ file: 'rules.js', from: 'if (t.revisionIdGiven !== undefined && t.revisionIdGiven !== t.currentRevisionId)', to: 'if (false)' }] },
  { id: 'C4a 决策：对象版本编号不核对', expect: ['C4a 决策：409 各分支', 'C4a rules：新动作'], edits: [{ file: 'rules.js', from: 'if (t.objectVersionIdGiven !== undefined && t.objectVersionIdGiven !== t.objectVersionId)', to: 'if (false)' }] },
  { id: 'C4a 决策：修订已处理不拦（规则层）', expect: ['C4a 决策：409 各分支', 'C4a rules：新动作'], edits: [{ file: 'rules.js', from: "if (t.revisionStatus !== 'pending') return '该任务修订已处理，不能再次决策';", to: '' }] },
  { id: 'C4a 决策：对象版本不再待确认不拦', expect: ['C4a 决策：409 各分支', 'C4a rules：新动作'], edits: [{ file: 'rules.js', from: "if (!t.objectPending) return { code: 'SYSBUILD_VERSION_CHANGED', message: '确认的对象版本已不在待确认状态' };", to: '' }] },
  { id: 'C4a 决策：资格复核结果不用', expect: ['C4a 失资格', 'C4a rules：新动作'], edits: [{ file: 'rules.js', from: 'return t.qualificationLoss || null;', to: 'return null;' }] },
  { id: 'C4a 决策：资格复核不查任职是否仍生效', expect: ['C4a 失资格'], edits: [{ file: 'confirm-core.js', from: "if (!a || a.status !== 'active' || a.member_id !== rev.required_member_id) return", to: 'if (!a) return' }] },
  { id: 'C4a 决策：资格复核不查授权是否仍生效', expect: ['C4a 失资格'], edits: [{ file: 'confirm-core.js', from: "if (!d || d.status !== 'active' || d.member_id !== rev.required_member_id) return", to: 'if (!d) return' }] },
  // 资格复核第一层 = 解析用的同一份「可作为确认人」判定（CONFIRMER_ELIGIBLE_SQL）：去掉「已移出」条件会同时放过解析与复核；L2 用例让「已移出」检查单独可观察（提出人任务没有任职 / 授权依据兜底）
  { id: 'C4a 决策：资格复核不查成员是否已移出', expect: ['C4a 失资格', 'C4a 失资格（L2）'], edits: [{ file: 'confirm-core.js', from: "const CONFIRMER_ELIGIBLE_SQL = `${rules.MEMBER_ACTIVE_SQL} AND (m.user_id IS NULL OR u.status = 'active')`;", to: "const CONFIRMER_ELIGIBLE_SQL = `m.joined_at IS NOT NULL AND (m.user_id IS NULL OR u.status = 'active')`;" }] },
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
  { id: 'C4a 决策：D42 唯一索引去掉', expect: ['C4a 决策（D42）'], edits: [{ file: 'schema.js', from: "['uq_sysbuild_confirmations_revision', 'sysbuild_confirmations(task_revision_id) WHERE task_revision_id IS NOT NULL', true],", to: "['uq_sysbuild_confirmations_revision', 'sysbuild_confirmations(task_revision_id) WHERE task_revision_id IS NOT NULL', false]," }] },
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
  // C4b P48：原变异「条目版本任务也能改发」（去掉 C4a 的类型限制）随契约翻转——现在条目版本任务本来可改发；对应变异一是回到 C4a 的「只开放内容包」，二是类型限制整句去掉（邀请 / 授权类任务也能改发）。
  { id: 'C4b P48：改发只开放内容包任务（回到 C4a）', expect: ['C4a rules：新动作', 'C4b 提出人改发'], edits: [{ file: 'rules.js', from: "if (!['package_version', 'item_version', 'dev_entry', 'handover'].includes(t.objectType)) return '该类型的确认任务不支持改发';", to: "if (t.objectType !== 'package_version') return '该类型的确认任务不支持改发';" }] }, // S-S1c：对象类型清单加了 dev_entry，锚点随之改写；C6a：再加 handover
  { id: 'C4b P48：改发不限对象类型（邀请 / 授权类任务也能改发）', expect: ['C4a rules：新动作'], edits: [{ file: 'rules.js', from: "if (!['package_version', 'item_version', 'dev_entry', 'handover'].includes(t.objectType)) return '该类型的确认任务不支持改发';", to: '' }] }, // S-S1c：同上
  { id: 'C4a 改发：非 PM 也能改发', expect: ['C4a 改发：不能改发'], edits: [{ file: 'rules.js', from: 'confirm_reissue: Object.freeze({\n    can: canActAsPm,', to: 'confirm_reissue: Object.freeze({\n    can: canRegisterItem,' }] },
  { id: 'C4a 改发：原因不必填', expect: ['C4a 改发：不能改发'], edits: [{ file: 'confirm.js', from: "readText(body.reason, 'reason', '改发原因', REASON_MAX, true)", to: "readText(body.reason, 'reason', '改发原因', REASON_MAX, false) || '未写'" }] },
  { id: 'C4a 改发：待确认的旧修订不置已替代', expect: ['C4a 改发：待确认 / 不认可'], edits: [{ file: 'confirm.js', from: "if (c.latest.status === 'pending') await core.closePendingRevision(q, c.latest.id, 'superseded', reason);", to: '' }] },
  { id: 'C4a 改发：不重新解析必需确认人（沿用旧人）', expect: ['C4a 改发：负责人更换后改发', 'C4a 失资格'], edits: [{ file: 'confirm.js', from: 'const cur = isDelegate ? await core.currentDelegate(q, c.task.party_id) : await core.currentOwner(q, c.task.party_id);', to: 'const cur = { memberId: c.latest.required_member_id, appointmentId: c.latest.basis_appointment_id, delegationId: c.latest.basis_delegation_id };' }] },
  { id: 'C4a 改发：没有当前负责人 / 代表人不拦', expect: ['C4a 改发：待确认 / 不认可'], edits: [{ file: 'confirm.js', from: 'if (!cur) return { isDelegate, cur: null, blocked:', to: 'if (false) return { isDelegate, cur: null, blocked:' }] },
  { id: 'C4a 改发：代表人任务按负责人解析', expect: ['C4a 改发：待确认 / 不认可'], edits: [{ file: 'confirm.js', from: 'const isDelegate = c.latest.basis_delegation_id !== null;', to: 'const isDelegate = false;' }] },
  // ── 生效与基线 ──
  { id: 'C4a 生效：任一人确认即生效', expect: ['C4a 生效：部分确认'], edits: [{ file: 'confirm-core.js', from: "if (!(rows.length > 0 && rows.every((r) => r.status === 'confirmed'))) return false;", to: "if (!(rows.length > 0 && rows.some((r) => r.status === 'confirmed'))) return false;" }] },
  { id: 'C4a 生效：判定把已替代的旧修订也算进来（不取最新修订）', expect: ['C4a 生效：部分确认'], edits: [{ file: 'confirm-core.js', from: "AND t.purpose = 'package_confirm'\n        AND r.rev_no = (SELECT MAX(r2.rev_no) FROM sysbuild_confirm_task_revisions r2 WHERE r2.task_id = t.id)", to: "AND t.purpose = 'package_confirm'\n        AND 1 = 1" }] },
  { id: 'C4a 生效：原生效版本不被替代', expect: ['C4a 生效：立项包'], edits: [{ file: 'confirm-core.js', from: "WHERE package_id = ? AND status = 'effective' AND id <> ? ORDER BY id\"", to: "WHERE package_id = ? AND status = 'draft' AND id <> ? ORDER BY id\"" }] },
  { id: 'C4a 生效：立项包也形成基线', expect: ['C4a 生效：立项包'], edits: [{ file: 'confirm-core.js', from: "const baselineNodes = pkg.type === 'overall' ? await formBaselines(q, user, projectId, ver.id, o.recordedPlans) : [];", to: 'const baselineNodes = await formBaselines(q, user, projectId, ver.id, o.recordedPlans);' }] },
  { id: 'C4a 生效：已取消的节点也形成基线', expect: ['C4a 生效：部分确认'], edits: [{ file: 'confirm-core.js', from: "WHERE n.project_id = ? AND n.status <> 'cancelled'\n        AND NOT EXISTS", to: "WHERE n.project_id = ? AND 1 = 1\n        AND NOT EXISTS" }] },
  { id: 'C4a 生效：覆盖已有基线', expect: ['C4a 生效：总体规划第二个版本'], edits: [{ file: 'confirm-core.js', from: "AND NOT EXISTS (SELECT 1 FROM sysbuild_node_schedule_records r WHERE r.node_id = n.id AND r.kind = 'baseline')", to: 'AND 1 = 1' }] },
  { id: 'C4a 生效：没有计划的节点也要写基线', expect: ['C4a H-1（P43）提交前置'], edits: [{ file: 'confirm-core.js', from: 'if (!cur) continue;', to: '' }] },
  { id: 'C4a 生效：基线取第一条计划而不是最后一条', expect: ['C4a 生效：部分确认'], edits: [{ file: 'confirm-core.js', from: "AND kind = 'plan_change' ORDER BY id DESC LIMIT 1", to: "AND kind = 'plan_change' ORDER BY id ASC LIMIT 1" }] },
  // ── H-1（原交接 ①「生效后首次设计划即基线」已撤销，改期式写入）──
  { id: 'C4a H-1：生效后尚无基线的节点写计划不要求原因（仍按草稿期放行）', expect: ['C4a H-1（P43）生效后写计划'], edits: [{ file: 'plan.js', from: "if (reason === null) throw invalid('改期必须填写原因', 'reason');", to: "if (reason === null && hasBaseline) throw invalid('改期必须填写原因', 'reason');" }] },
  // 修订批二 LOW-3：收口前置与 plan_write_mode 的「有无生效总体规划」读 effectiveOverallVersionId（同一来源），所以这条变异的 expect 也含读接口用例（别的项目的生效版本被带出）
  { id: 'C4a H-1：现行总体规划版本解析不限本项目', expect: ['C4a H-1（P43）生效后写计划', 'C4a H-1 读接口信号'], edits: [{ file: 'packages.js', from: "WHERE p.project_id = ? AND p.type = 'overall' AND v.status = 'effective' ORDER BY v.id DESC LIMIT 1", to: "WHERE (p.project_id = ? OR 1 = 1) AND p.type = 'overall' AND v.status = 'effective' ORDER BY v.id DESC LIMIT 1" }] },
  // ── 提出人 ──
  { id: 'C4a 提出人：条目创建不生成任务', expect: ['C4a 提出人：条目版本创建时'], edits: [{ file: 'items.js', from: "await confirmCore.createProposerTask(q, user, { projectId: pid, itemId: it.lastID,", to: "if (false) await confirmCore.createProposerTask(q, user, { projectId: pid, itemId: it.lastID," }] },
  // C4b P46：原变异「无账号成员也生成任务」随契约翻转——对应变异是让提出人任务生成重新跳过无账号成员（C4a 行为）。
  { id: 'C4b P46：无账号提出人不生成任务（回到 C4a）', expect: ['C4a 提出人：条目版本创建时', 'C4b 代录：提出人'], edits: [
    { file: 'confirm-core.js', from: 'const m = await eligibleMember(q, o.proposerMemberId);\n  if (!m) return null;', to: 'const m = await eligibleMember(q, o.proposerMemberId);\n  if (!m || m.proxy_only) return null;' },
  ] },
  // L1：让判红落在冻结清单断言上——owner 类型换成另一个合法枚举（package_version），冻结的是「编号碰巧相同的内容包版本」名下的附件（本用例里没有），条目版本自己的清单为空
  { id: 'C4a 提出人：任务生成时不冻结条目附件', expect: ['C4a 提出人：条目版本创建时'], edits: [{ file: 'confirm-core.js', from: "objectType: 'item_version', objectVersionId: o.itemVersionId, ownerType: 'item_version', ownerId: o.itemVersionId,", to: "objectType: 'item_version', objectVersionId: o.itemVersionId, ownerType: 'package_version', ownerId: o.itemVersionId," }] },
  { id: 'C4a 提出人：有异议也改提出人状态', expect: ['C4a 提出人：确认 →'], edits: [{ file: 'confirm.js', from: "} else if (c.task.object_type === 'item_version' && decision !== 'object') {", to: "} else if (c.task.object_type === 'item_version') {" }] },
  { id: 'C4a 提出人：出新版本不替代旧修订', expect: ['C4a 提出人：条目出新版本'], edits: [{ file: 'items.js', from: 'await confirmCore.supersedeProposerRevisions(q, user, item.project_id, iid, vr.lastID);', to: '' }] },
  // ── 待我确认 ──
  { id: 'C4a 待我确认：不限本人', expect: ['C4a 待我确认'], edits: [{ file: 'confirm.js', from: "WHERE r.status = 'pending' AND m.user_id = ?", to: "WHERE r.status = 'pending' AND (m.user_id = ? OR 1 = 1)" }] },
  { id: 'C4a 待我确认：已处理的修订也列', expect: ['C4a 待我确认'], edits: [{ file: 'confirm.js', from: "WHERE r.status = 'pending' AND m.user_id = ?", to: "WHERE r.status <> 'invalid' AND m.user_id = ?" }] },
  // L3②：待我确认与 decide 同一个资格判定（成员已移出 / 账号停用 / 任职或授权不再生效的修订不列）
  { id: 'C4a 待我确认 L3②：不做资格复核（被移出的成员、停用账号、失效的任职 / 授权也列）', expect: ['C4a 待我确认', 'C4a 确认人解析与资格同源'], edits: [{ file: 'confirm-core.js', from: 'return qualificationLoss(q, rev, o);', to: 'return null;' }] }, // C6b 修订批 1（K1）：三项判定抽成 confirm-core.confirmAvailabilityBlock，锚点随之换文件
  { id: 'C4a 待我确认 P38：已终止 / 已结项项目的待确认修订也列', expect: ['C4a P38'], edits: [{ file: 'confirm-core.js', from: 'canDecide: !!access.project && rules.projectAllowsWrite(access.project.status, rules.OP_KIND.confirm_decide)', to: 'canDecide: true' }] }, // C6b 修订批 1（K1）：判定抽到 confirm-core.confirmAvailabilityBlock，锚点随之换文件
  // ── P34 总体排期基线来源 ──
  { id: 'C4a P34：总体规划待确认期间节点设计划不拦', expect: ['C4a P34：总体规划待确认期间', 'C4a rules（修订批）'], edits: [{ file: 'rules.js', from: "      if (t.overallPending) return OVERALL_PENDING_PLAN_MESSAGE;\n      return t.nodeStatus === 'closed' && t.hasBaseline", to: "      return t.nodeStatus === 'closed' && t.hasBaseline" }] },
  { id: 'C4a P34：总体规划待确认期间取消节点不拦', expect: ['C4a P34：总体规划待确认期间', 'C4a rules（修订批）'], edits: [{ file: 'rules.js', from: "      if (t.overallPending) return OVERALL_PENDING_PLAN_MESSAGE; // C4a P34：总体规划待确认期间排期已随包冻结，取消节点也会改变将形成的基线\n", to: '' }] },
  { id: 'C4a P34：待确认判定取成立项包 / 别的状态（不认总体规划的待确认版本）', expect: ['C4a P34：总体规划待确认期间'], edits: [{ file: 'golive-core.js', from: "WHERE p.project_id = ? AND p.type IN ('overall', 'change') AND v.status = 'pending' LIMIT 1", to: "WHERE p.project_id = ? AND p.type IN ('overall', 'change') AND v.status = 'draft' LIMIT 1" }] }, // S-S1c：类型清单加了 change，锚点随之改写
  { id: 'C4a P34：待确认判定不限本项目', expect: ['C4a P34：总体规划待确认期间'], edits: [{ file: 'golive-core.js', from: "WHERE p.project_id = ? AND p.type IN ('overall', 'change') AND v.status = 'pending' LIMIT 1", to: "WHERE (p.project_id = ? OR 1 = 1) AND p.type IN ('overall', 'change') AND v.status = 'pending' LIMIT 1" }] },
  { id: 'C4a P34：待确认判定把立项包也算进来', expect: ['C4a P34：总体规划待确认期间'], edits: [{ file: 'golive-core.js', from: "WHERE p.project_id = ? AND p.type IN ('overall', 'change') AND v.status = 'pending' LIMIT 1", to: "WHERE p.project_id = ? AND p.type IN ('overall', 'change', 'initiation') AND v.status = 'pending' LIMIT 1" }] },
  { id: 'C4a P34：读接口节点标志不带总体规划待确认', expect: ['C4a P34：总体规划待确认期间'], edits: [{ file: 'plan.js', from: 'nodeTarget(n, batch, recs, corrects, data.overallPending)', to: 'nodeTarget(n, batch, recs, corrects)' }] },
  { id: 'C4a P34：设计划端点的 target 不带总体规划待确认', expect: ['C4a P34：总体规划待确认期间'], edits: [{ file: 'plan.js', from: "rules.assertOp('schedule_plan', access, access.project, nodeTarget(node, batch, recs, null, overallPending));", to: "rules.assertOp('schedule_plan', access, access.project, nodeTarget(node, batch, recs, null));" }] },
  { id: 'C4a P34：取消端点的 target 不带总体规划待确认', expect: ['C4a P34：总体规划待确认期间'], edits: [{ file: 'plan.js', from: "rules.assertOp('node_cancel', access, access.project, nodeTarget(node, batch, recs, null, overallPending));", to: "rules.assertOp('node_cancel', access, access.project, nodeTarget(node, batch, recs, null));" }] },
  { id: 'C4a P34：提交事件不记节点计划', expect: ['C4a P34：生效时形成的基线', 'C4a 提交：总体规划包成功'], edits: [{ file: 'confirm.js', from: "pkg.type === 'overall' || pkg.type === 'change' ? { node_plans: await core.currentNodePlans(q, pid) } : {}", to: '{}' }] }, // S-S1c：变更包同样记节点计划，锚点随之改写
  { id: 'C4a P34：提交事件的节点计划含已取消节点', expect: ['C4a 生效：部分确认'], edits: [{ file: 'confirm-core.js', from: "WHERE n.project_id = ? AND n.status <> 'cancelled' ORDER BY n.id", to: 'WHERE n.project_id = ? AND 1 = 1 ORDER BY n.id' }] },
  { id: 'C4a P34：生效时基线不与提交记录核对', expect: ['C4a P34：生效时形成的基线'], edits: [{ file: 'confirm-core.js', from: 'if (!rec || rec.planned_start !== cur.planned_start || rec.planned_end !== cur.planned_end) {', to: 'if (false) {' }] },
  { id: 'C4a P34：生效时基线只核对节点有无记录、不核对日期', expect: ['C4a P34：生效时形成的基线'], edits: [{ file: 'confirm-core.js', from: 'if (!rec || rec.planned_start !== cur.planned_start || rec.planned_end !== cur.planned_end) {', to: 'if (!rec) {' }] },
  { id: 'C4a P34：提交事件缺节点计划记录时不 fail-closed', expect: ['C4a P34：生效时形成的基线'], edits: [{ file: 'confirm-core.js', from: 'if (recorded === null && toForm.length > 0) throw internalError(', to: 'if (false) throw internalError(' }] },
  { id: 'C4a P34：任务详情不展示节点计划清单', expect: ['C4a 生效：部分确认'], edits: [{ file: 'confirm.js', from: "if (pkg.type === 'overall' || pkg.type === 'change') {\n        const snap", to: "if (false) {\n        const snap" }] }, // S-S1c：变更包同样展示节点计划，锚点随之改写
  // ── P35 提交后新增需求部门 ──
  { id: 'C4a P35：待确认内容包期间新建需求部门不拦（规则层）', expect: ['C4a P35', 'C4a rules（修订批）'], edits: [{ file: 'rules.js', from: "return t.side === 'demand' && t.hasPendingContentPackage ? PENDING_PACKAGE_PARTY_MESSAGE : null; // C4a P35", to: 'return null; // C4a P35' }] },
  { id: 'C4a P35：新建参与方端点不带待确认标志', expect: ['C4a P35'], edits: [{ file: 'membership.js', from: '{ side, hasDevParty: !!dev, hasPendingContentPackage: !!identity.hasPendingContentPackage }', to: '{ side, hasDevParty: !!dev }' }] },
  // 待确认包的类型清单读 rules.SUBMITTABLE_PACKAGE_TYPES（修订批二 LOW-5），变异直接替换 SQL 里引用常量的那一处
  { id: 'C4a P35：待确认判定漏掉立项包', expect: ['C4a P35'], edits: [{ file: 'rules.js', from: "p.type IN (${SUBMITTABLE_TYPES_SQL_LIST}) AND v.status = 'pending' LIMIT 1", to: "p.type IN ('overall') AND v.status = 'pending' LIMIT 1" }] },
  { id: 'C4a P35：待确认判定漏掉总体规划包', expect: ['C4a P35'], edits: [{ file: 'rules.js', from: "p.type IN (${SUBMITTABLE_TYPES_SQL_LIST}) AND v.status = 'pending' LIMIT 1", to: "p.type IN ('initiation') AND v.status = 'pending' LIMIT 1" }] },
  { id: 'C4a P35：待确认判定不限本项目', expect: ['C4a P35'], edits: [{ file: 'rules.js', from: "WHERE p.project_id = ? AND p.type IN (${SUBMITTABLE_TYPES_SQL_LIST}) AND v.status = 'pending' LIMIT 1", to: "WHERE (p.project_id = ? OR 1 = 1) AND p.type IN (${SUBMITTABLE_TYPES_SQL_LIST}) AND v.status = 'pending' LIMIT 1" }] },
  { id: 'C4a P35：待确认期间开发方也不能建', expect: ['C4a P35', 'C4a rules（修订批）'], edits: [{ file: 'rules.js', from: "return t.side === 'demand' && t.hasPendingContentPackage ? PENDING_PACKAGE_PARTY_MESSAGE : null; // C4a P35", to: 'return t.hasPendingContentPackage ? PENDING_PACKAGE_PARTY_MESSAGE : null; // C4a P35' }] },
  { id: 'C4a P35：读接口 party_sides 不带待确认标志', expect: ['C4a P35'], edits: [{ file: 'rules.js', from: '{ side, hasDevParty: !!identity.hasDevParty, hasPendingContentPackage: !!identity.hasPendingContentPackage }', to: '{ side, hasDevParty: !!identity.hasDevParty }' }] },
  // ── P38 终止项目 ──
  { id: 'C4a P38：终止项目不失效待确认修订', expect: ['C4a P38'], edits: [{ file: 'projects.js', from: "if (to === 'terminated') await confirmCore.invalidatePendingRevisionsOfProject(", to: "if (false) await confirmCore.invalidatePendingRevisionsOfProject(" }] },
  { id: 'C4a P38：终止项目只失效内容包任务（漏掉提出人任务）', expect: ['C4a P38'], edits: [{ file: 'confirm-core.js', from: "WHERE t.project_id = ? AND r.status = 'pending' ORDER BY r.id", to: "WHERE t.project_id = ? AND r.status = 'pending' AND t.object_type = 'package_version' ORDER BY r.id" }] },
  { id: 'C4a P38：终止项目的失效波及别的项目', expect: ['C4a P38'], edits: [{ file: 'confirm-core.js', from: "WHERE t.project_id = ? AND r.status = 'pending' ORDER BY r.id", to: "WHERE (t.project_id = ? OR 1 = 1) AND r.status = 'pending' ORDER BY r.id" }] },
  { id: 'C4a P38：终止项目的失效原因写成别的文案', expect: ['C4a P38'], edits: [{ file: 'confirm-core.js', from: "const PROJECT_TERMINATED_REASON = '项目已终止';", to: "const PROJECT_TERMINATED_REASON = '已终止';" }] },
  { id: 'C4a P38：暂停项目也失效待确认修订', expect: ['C4a P38'], edits: [{ file: 'projects.js', from: "if (to === 'terminated') await confirmCore.invalidatePendingRevisionsOfProject(", to: "if (to === 'terminated' || to === 'paused') await confirmCore.invalidatePendingRevisionsOfProject(" }] },
  { id: 'C4a P38：终止项目的失效不写事件', expect: ['C4a P38'], edits: [{ file: 'confirm-core.js', from: "    await emit(q, user, projectId, 'confirm_task', row.task_id, 'confirm_revision_invalidated', {", to: "    if (false) await emit(q, user, projectId, 'confirm_task', row.task_id, 'confirm_revision_invalidated', {" }] },
  // ── M2 读接口的计划写入方式 ──
  { id: 'C4a M2：读接口 plan_write_mode 不看总体规划是否生效（读写分叉）', expect: ['C4a H-1 读接口信号'], edits: [{ file: 'plan.js', from: 'planWriteMode(recs.some((r) => r.kind === \'baseline\'), data.facts.overall)', to: "planWriteMode(recs.some((r) => r.kind === 'baseline'), false)" }] },
  { id: 'C4a M2：写端点不看总体规划是否生效（读写分叉）', expect: ['C4a H-1 读接口信号', 'C4a H-1（P43）生效后写计划'], edits: [{ file: 'plan.js', from: 'const mode = planWriteMode(hasBaseline, (await effectiveOverallVersionId(q, node.project_id)) !== null);', to: 'const mode = planWriteMode(hasBaseline, false);' }] },
  { id: 'C4a H-1：读接口 has_baseline 恒为假', expect: ['C4a H-1 读接口信号', 'C4a H-1（P43）生效后写计划'], edits: [{ file: 'plan.js', from: "has_baseline: recs.some((r) => r.kind === 'baseline'),", to: 'has_baseline: false,' }] },
  { id: 'C4a M2：planWriteMode 不认总体规划已生效（恒 draft）', expect: ['C4a H-1 读接口信号'], edits: [{ file: 'plan.js', from: 'return hasBaseline || hasEffectiveOverall ? \'reschedule\' : \'draft\';', to: "return hasBaseline ? 'reschedule' : 'draft';" }] },
  // ── 收口前置：内容包已生效 ──
  { id: 'C4a 收口前置：立项与授权收口不要求立项包生效', expect: ['C4a 收口前置：内容包已生效'], edits: [{ file: 'plan.js', from: "node.template_key === 'p_initiation' && f.initiation !== true", to: "node.template_key === 'p_initiation' && false" }] },
  { id: 'C4a 收口前置：总体范围与批次规划收口不要求总体规划包生效', expect: ['C4a 收口前置：内容包已生效'], edits: [{ file: 'plan.js', from: "node.template_key === 'p_overall' && f.overall !== true", to: "node.template_key === 'p_overall' && false" }] },
  { id: 'C4a 收口前置：需求确认收口不要求总体规划包生效', expect: ['C4a 收口前置：内容包已生效'], edits: [{ file: 'plan.js', from: "node.template_key === 'b_req' && f.overall !== true", to: "node.template_key === 'b_req' && false" }] },
  { id: 'C4a 收口前置：用户验收测试收口不要求批次验收包生效', expect: ['C4a 收口前置：内容包已生效'], edits: [{ file: 'plan.js', from: "node.template_key === 'b_uat' && !(f.batchAccept && f.batchAccept[node.batch_id] === true)", to: "node.template_key === 'b_uat' && false" }] },
  { id: 'C4a 收口前置：用户验收测试认任何一批的批次验收包', expect: ['C4a 收口前置：内容包已生效'], edits: [{ file: 'plan.js', from: '!(f.batchAccept && f.batchAccept[node.batch_id] === true)', to: '!(f.batchAccept && Object.keys(f.batchAccept).length > 0)' }] },
  { id: 'C4a 收口前置：待确认的包版本也算已生效', expect: ['C4a 收口前置：内容包已生效'], edits: [{ file: 'plan.js', from: "WHERE p.project_id = ? AND v.status = 'effective'`,", to: "WHERE p.project_id = ? AND v.status IN ('effective', 'pending')`," }] },
  { id: 'C4a 收口前置：内容包生效事实不限本项目', expect: ['C4a 收口前置：内容包已生效'], edits: [{ file: 'plan.js', from: "WHERE p.project_id = ? AND v.status = 'effective'`,", to: "WHERE (p.project_id = ? OR 1 = 1) AND v.status = 'effective'`," }] },
  { id: 'C4a 收口前置：读接口 close_blockers 不带内容包事实', expect: ['C4a 收口前置：内容包已生效'], edits: [{ file: 'plan.js', from: "close_blockers: n.status === 'in_progress' ? closeBlockers(n, brief, data.facts) : [],", to: "close_blockers: n.status === 'in_progress' ? closeBlockers(n, brief) : []," }] },
  { id: 'C4a 收口前置：收口端点不带内容包事实（恒放行）', expect: ['C4a 收口前置：内容包已生效'], edits: [{ file: 'plan.js', from: 'const blockers = closeBlockers(node, brief, data.facts);', to: 'const blockers = closeBlockers(node, brief, { initiation: true, overall: true, batchAccept: new Proxy({}, { get: () => true }) });' }] },
  // ── actions 与执行判定分叉 ──
  { id: 'C4a actions：包版本 submit 标志忽略对象状态', expect: ['C4a actions 与执行一致', 'C4a 提交：总体规划包成功'], edits: [{ file: 'packages.js', from: "submit: rules.opAllowed('package_version_submit', access, access.project, t),", to: 'submit: !!access.isPm,' }] },
  { id: 'C4a actions：包版本 withdraw 标志忽略对象状态', expect: ['C4a actions 与执行一致'], edits: [{ file: 'packages.js', from: "withdraw: rules.opAllowed('package_version_withdraw', access, access.project, t),", to: 'withdraw: !!access.isPm,' }] },
  { id: 'C4a actions：任务 decide 标志忽略对象状态', expect: ['C4a actions 与执行一致', 'C4a 浏览：'], edits: [{ file: 'confirm.js', from: "decide: rules.opAllowed('confirm_decide', c.access, c.access.project, target),", to: 'decide: target.isRequired,' }] },
  { id: 'C4a actions：任务 reissue 标志忽略对象状态', expect: ['C4a actions 与执行一致'], edits: [{ file: 'confirm.js', from: "reissue: rules.opAllowed('confirm_reissue', c.access, c.access.project, reissueTarget(c, await resolveReissue(q, c))),", to: 'reissue: !!c.access.isPm,' }] },
  // ── 修订批二（下标 550–557 为本批新增；P30：过滤自检之外再跑 --self-test --full --mutations 550-557）──
  // MED-1：submit 标志与执行同源——读接口的标志忽略某个项目级事实，而执行端点仍用它（标志为真、执行 409）
  { id: 'C4a MED-1：读接口 submit 标志不看 initiationEffective（恒视为立项包已生效）', expect: ['C4a actions 与执行一致'], edits: [{ file: 'packages.js', from: 'const facts = await versionFactsOf(q, pkg, ver);', to: 'const facts = Object.assign(await versionFactsOf(q, pkg, ver), { initiationEffective: true });' }] },
  { id: 'C4a MED-1：读接口 submit 标志不看 confirmersMissing（恒视为确认人齐全）', expect: ['C4a actions 与执行一致'], edits: [{ file: 'packages.js', from: 'const facts = await versionFactsOf(q, pkg, ver);', to: 'const facts = Object.assign(await versionFactsOf(q, pkg, ver), { confirmersMissing: null });' }] },
  { id: 'C4a MED-1：提交端点的项目级事实恒视为齐全（执行端不再核对立项前置与确认人）', expect: ['C4a 提交：失败分支', 'C4a 提交 P37', 'C4a actions 与执行一致'], edits: [{ file: 'confirm.js', from: 'versionTarget(ver, pkg, batchStatus, await versionFactsOf(q, pkg, ver))', to: "versionTarget(ver, pkg, batchStatus, { confirmersMissing: null, initiationEffective: true })" }] },
  { id: 'C4a MED-1：提交判定的事实缺失时放行（确认人事实没取到不 fail-closed）', expect: ['C4a rules：新动作'], edits: [{ file: 'rules.js', from: "if (cm === undefined) return CONFIRMERS_UNKNOWN_MESSAGE;\n      if (cm !== null) return cm.noParty ? NO_DEMAND_PARTY_MESSAGE : `以下参与方缺少必需确认人", to: "if (cm === undefined) return null;\n      if (cm !== null) return cm.noParty ? NO_DEMAND_PARTY_MESSAGE : `以下参与方缺少必需确认人" }] }, // C6a：handover_request 里有同一句 cm === undefined，锚点带上下一行以保唯一
  { id: 'C4a MED-1：提交判定的立项事实缺失时放行（只拦明确为假）', expect: ['C4a rules：新动作'], edits: [{ file: 'rules.js', from: "t.packageType === 'overall' && t.initiationEffective !== true", to: "t.packageType === 'overall' && t.initiationEffective === false" }] },
  // LOW-1 / LOW-2：formBaselines 双向核对
  { id: 'C4a LOW-1：提交记录里的节点既无基线又不会形成基线仍放行（去掉反向核对）', expect: ['C4a 生效 LOW-1 / LOW-2'], edits: [{ file: 'confirm-core.js', from: 'if (!has) throw internalError(', to: 'if (false) throw internalError(' }] },
  { id: 'C4a LOW-1：反向核对不认已有基线（提交记录里的节点只要不是本次形成的一律拦）', expect: ['C4a 生效：总体规划第二个版本'], edits: [{ file: 'confirm-core.js', from: 'if (!has) throw internalError(', to: 'if (true) throw internalError(' }] },
  { id: 'C4a LOW-2：没有提交记录时一律 500（不看有没有需要形成基线的节点）', expect: ['C4a 生效 LOW-1 / LOW-2'], edits: [{ file: 'confirm-core.js', from: 'if (recorded === null && toForm.length > 0) throw internalError(', to: 'if (recorded === null) throw internalError(' }] },
  // ── 修订批三（codex 19 号：H-1 / H-2 / M-1 / M-2 / M-3；P30：过滤自检之外再跑 --self-test --full --mutation-ids <本批新增与改动的变异 id 名单>，名单见 tmp/c4a/fix4_ids_41.json；下标 558–586 只作快速定位）──
  // H-1 / P43 提交前置「计划齐全」（标志与执行同源、事实缺失 fail-closed）
  { id: 'C4a H-1：读接口 submit 标志不看 planMissing（恒视为计划齐全）', expect: ['C4a actions 与执行一致', 'C4a H-1（P43）提交前置'], edits: [{ file: 'packages.js', from: 'const facts = await versionFactsOf(q, pkg, ver);', to: 'const facts = Object.assign(await versionFactsOf(q, pkg, ver), { planMissing: null });' }] },
  { id: 'C4a H-1：提交端点恒视为计划齐全（执行端不再核对计划）', expect: ['C4a H-1（P43）提交前置', 'C4a actions 与执行一致'], edits: [{ file: 'confirm.js', from: 'versionTarget(ver, pkg, batchStatus, await versionFactsOf(q, pkg, ver))', to: 'versionTarget(ver, pkg, batchStatus, Object.assign(await versionFactsOf(q, pkg, ver), { planMissing: null }))' }] },
  { id: 'C4a H-1：计划事实缺失时放行（不 fail-closed）', expect: ['C4a rules：新动作'], edits: [{ file: 'rules.js', from: 'if (t.planMissing === undefined) return PLANS_UNKNOWN_MESSAGE;', to: '' }] },
  { id: 'C4a H-1：缺计划的判定去掉（规则层）', expect: ['C4a rules：新动作', 'C4a H-1（P43）提交前置'], edits: [{ file: 'rules.js', from: 'if (t.planMissing !== null) return `${PLAN_MISSING_MESSAGE_HEAD}${t.planMissing.join(\'、\')}`;', to: '' }] },
  { id: 'C4a H-1：合并形态只要求项目层节点有计划', expect: ['C4a H-1（P43）提交前置'], edits: [{ file: 'confirm-core.js', from: "const scope = form === 'overall_batch_req' ? '' : ' AND n.batch_id IS NULL';", to: "const scope = ' AND n.batch_id IS NULL';" }] },
  { id: 'C4a H-1：普通形态也要求批次层节点有计划', expect: ['C4a H-1（P43）提交前置'], edits: [{ file: 'confirm-core.js', from: "const scope = form === 'overall_batch_req' ? '' : ' AND n.batch_id IS NULL';", to: "const scope = '';" }] },
  { id: 'C4a H-1：缺计划的判定含已取消节点', expect: ['C4a H-1（P43）提交前置'], edits: [{ file: 'confirm-core.js', from: "WHERE n.project_id = ? AND n.status <> 'cancelled'${scope}", to: 'WHERE n.project_id = ? AND 1 = 1${scope}' }] },
  { id: 'C4a H-1：form 取草稿存的值而不是提交时重算（恒按合并形态判）', expect: ['C4a H-1（P43）提交前置'], edits: [{ file: 'packages.js', from: 'facts.planMissing = await confirmCore.planMissingNodes(q, pkg.project_id, (await computeFormAndParent(q, pkg)).form);', to: "facts.planMissing = await confirmCore.planMissingNodes(q, pkg.project_id, 'overall_batch_req');" }] },
  { id: 'C4a H-1：缺计划的判定不限本项目', expect: ['C4a H-1（P43）提交前置'], edits: [{ file: 'confirm-core.js', from: "WHERE n.project_id = ? AND n.status <> 'cancelled'${scope}", to: "WHERE (n.project_id = ? OR 1 = 1) AND n.status <> 'cancelled'${scope}" }] },
  { id: 'C4a H-1：生效后尚无基线的节点写计划不要求证据', expect: ['C4a H-1（P43）生效后写计划'], edits: [{ file: 'plan.js', from: 'if (!noEvidence && attachmentIds.length === 0) {', to: 'if (!noEvidence && attachmentIds.length === 0 && hasBaseline) {' }] },
  // H-2 确认页排期用提交快照
  { id: 'C4a H-2：确认页节点名称读节点现值', expect: ['C4a H-2'], edits: [{ file: 'confirm.js', from: 'node_id: np.node_id, name: snap(np.name),', to: "node_id: np.node_id, name: (await q.get('SELECT name FROM sysbuild_nodes WHERE id = ?', [np.node_id])).name," }] },
  { id: 'C4a H-2：确认页批次名称读批次现值', expect: ['C4a H-2'], edits: [{ file: 'confirm.js', from: 'batch_name: snap(np.batch_name),', to: "batch_name: np.batch_id === null ? null : (await q.get('SELECT name FROM sysbuild_batches WHERE id = ?', [np.batch_id])).name," }] },
  { id: 'C4a H-2：提交快照不存节点名称', expect: ['C4a 提交：总体规划包成功', 'C4a H-2'], edits: [{ file: 'confirm-core.js', from: 'node_id: n.id, name: n.name, layer:', to: 'node_id: n.id, name: null, layer:' }] },
  { id: 'C4a H-2：提交快照的层写反', expect: ['C4a 提交：总体规划包成功', 'C4a H-2'], edits: [{ file: 'confirm-core.js', from: "layer: n.batch_id === null ? 'project' : 'batch'", to: "layer: n.batch_id === null ? 'batch' : 'project'" }] },
  { id: 'C4a H-2：提交快照不存批次名称', expect: ['C4a 提交：总体规划包成功', 'C4a H-2'], edits: [{ file: 'confirm-core.js', from: 'batch_id: n.batch_id, batch_name: n.batch_name,', to: 'batch_id: n.batch_id, batch_name: null,' }] },
  { id: 'C4a H-2：提交快照不存模板键', expect: ['C4a 提交：总体规划包成功', 'C4a H-2'], edits: [{ file: 'confirm-core.js', from: 'template_key: n.template_key, planned_start: cur.planned_start,', to: 'template_key: null, planned_start: cur.planned_start,' }] },
  // M-1 合并包生效推进批次
  { id: 'C4a M-1：合并形态生效不推进批次', expect: ['C4a M-1'], edits: [{ file: 'confirm-core.js', from: "pkg.type === 'overall' && ver.form === 'overall_batch_req' ? await advancePlanningBatches(", to: "false ? await advancePlanningBatches(" }] },
  { id: 'C4a M-1：普通形态生效也推进批次', expect: ['C4a H-1（P43）提交前置'], edits: [{ file: 'confirm-core.js', from: "pkg.type === 'overall' && ver.form === 'overall_batch_req' ? await advancePlanningBatches(", to: "pkg.type === 'overall' ? await advancePlanningBatches(" }] },
  { id: 'C4a M-1：立项包生效也推进批次', expect: ['C4a 生效：立项包', 'C4a M-1'], edits: [{ file: 'confirm-core.js', from: "pkg.type === 'overall' && ver.form === 'overall_batch_req' ? await advancePlanningBatches(", to: "(pkg.type === 'overall' && ver.form === 'overall_batch_req') || pkg.type === 'initiation' ? await advancePlanningBatches(" }] },
  { id: 'C4a M-1：已是进行中的批次也重复推进并写事件', expect: ['C4a M-1'], edits: [
    { file: 'confirm-core.js', from: "SELECT id FROM sysbuild_batches WHERE project_id = ? AND status = 'planning' ORDER BY seq, id", to: "SELECT id FROM sysbuild_batches WHERE project_id = ? AND status IN ('planning', 'active') ORDER BY seq, id" },
    { file: 'confirm-core.js', from: "'UPDATE sysbuild_batches SET status = ? WHERE id = ? AND status = ?', ['active', b.id, 'planning']", to: "'UPDATE sysbuild_batches SET status = ? WHERE id = ?', ['active', b.id]" },
  ] },
  { id: 'C4a M-1：推进不限本项目的批次', expect: ['C4a M-1'], edits: [{ file: 'confirm-core.js', from: "SELECT id FROM sysbuild_batches WHERE project_id = ? AND status = 'planning' ORDER BY seq, id", to: "SELECT id FROM sysbuild_batches WHERE (project_id = ? OR 1 = 1) AND status = 'planning' ORDER BY seq, id" }] },
  { id: 'C4a M-1：推进批次不写状态事件', expect: ['C4a M-1'], edits: [{ file: 'confirm-core.js', from: "await emit(q, user, projectId, 'batch', b.id, 'batch_status_changed',", to: "if (false) await emit(q, user, projectId, 'batch', b.id, 'batch_status_changed'," }] },
  // M-2 确认页返回无书面证据声明
  { id: 'C4a M-2：包任务详情的条目不返回无书面证据声明', expect: ['C4a M-2'], edits: [{ file: 'confirm.js', from: 'proposed_on: row.proposed_on, no_written_evidence: row.no_written_evidence === 1, no_evidence_reason: row.no_evidence_reason,', to: 'proposed_on: row.proposed_on,' }] },
  { id: 'C4a M-2：包任务详情的条目不返回无书面证据原因', expect: ['C4a M-2'], edits: [{ file: 'confirm.js', from: 'proposed_on: row.proposed_on, no_written_evidence: row.no_written_evidence === 1, no_evidence_reason: row.no_evidence_reason,', to: 'proposed_on: row.proposed_on, no_written_evidence: row.no_written_evidence === 1,' }] },
  { id: 'C4a M-2：提出人任务详情不返回无书面证据原因', expect: ['C4a M-2'], edits: [{ file: 'confirm.js', from: 'no_written_evidence: iv.no_written_evidence === 1, no_evidence_reason: iv.no_evidence_reason,', to: 'no_written_evidence: iv.no_written_evidence === 1,' }] },
  // M-3 按决策分设勾选文案
  { id: 'C4a M-3：勾选文案不按决策匹配（一律认确认那一条）', expect: ['C4a 决策：400 各分支', 'C4a 决策：成功路径'], edits: [{ file: 'confirm.js', from: 'body.checkbox_text !== core.checkboxTextsOf(c.task.purpose)[decision]', to: 'body.checkbox_text !== core.checkboxTextsOf(c.task.purpose).confirm' }] },
  { id: 'C4a M-3：确认记录保存确认那一条文案（而不是实际提交的）', expect: ['C4a 决策：成功路径'], edits: [{ file: 'confirm.js', from: 'uid, decision, body.checkbox_text, reason, view.id]', to: 'uid, decision, core.CHECKBOX_TEXTS.confirm, reason, view.id]' }] },
  { id: 'C4a M-3：任务详情只返回确认那一条文案', expect: ['C4a 浏览：'], edits: [{ file: 'confirm.js', from: 'checkbox_texts: core.checkboxTextsOf(c.task.purpose),', to: 'checkbox_texts: { confirm: core.checkboxTextsOf(c.task.purpose).confirm },' }] },
  { id: 'C4a M-3：不认可的固定文案写成确认无误', expect: ['C4a 决策：400 各分支', 'C4a 浏览：', 'C4a 决策：成功路径'], edits: [{ file: 'confirm-core.js', from: "reject: '我已阅读以上全部内容，不认可（原因见下）',", to: "reject: '我已阅读以上全部内容，确认无误'," }] },
];

module.exports = { makeConfirmHelpers, defineConfirmCases, CONFIRM_MUTATIONS };
