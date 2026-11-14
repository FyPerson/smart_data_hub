// 验证脚本库：项目管理（系统建设记录）模块 C5 S-S1b——问题分流与判定快照、混合拆分与手动拆分、待判定归属、节点收口前置、收口后异议、记系统迭代单号（#113 段 7 C5 S-S1b）的用例与变异
//   方案：docs/local/系统建设记录/系统建设记录_平台集成_方案_20261105_v1.4.md §4.1（关联内容已上线后）、§4.3（分流判定流程 1–7、尚未判定、跨批次拆分、换批与拆分）、§4.5、§6.2 判定快照行与「C5 增量」D39
//   派单：docs/local/系统建设记录/送审准备/C5_S-S1b_分流与收口_派单_20261105.md（含 0b 补充裁定；§7 测试清单与本文件的 T_* 常量逐项对应）
//
// 本文件只放用例与变异，由 sysbuild-api-suite.js 登记（同一套夹具、同一个变异自检）。期望值一律手写，不取自被测代码。
// 夹具规则：建项、登记、办理动作、结论确认、节点开始 / 收口、历史窗口与导入全部走生产端点。只有这几类直接写库：
//   ① 需求方参与方、成员、任职、授权（confirm 助手与 addMember）；② 附件行（暂存）；③ 第二批次与总体规划里的条目集合修订（produceEffectiveOverall 只产生默认批次的一个条目，
//      这里往已生效版本追加修订行以得到第二批次 / 无承诺批次的条目——C3 起总体规划已生效后不能直接改版本，没有生产写入口）；
//   ④ 上线事件（sysbuild_golive_events）：C6a 起有生产写入口（POST /batches/:bid/golive、revoke-golive）。「上线事件有效性」一组（T_GOLIVE）的 golive / revoke / regolive 已改经生产端点（H.readyForGolive / productionGolive / productionRevoke）；
//      其余用例只需要「某批已上线」这个事实、不关心上线前置，仍直接写事件夹具；时刻一律写成相对真实时间（datetime('now','localtime', '-1 hour') 这类），不依赖进程内固定的「今天」；
//   ⑤ 节点收口状态与时刻、项目终止状态（本批没有改动它们的新生产路径）。
'use strict';
const assert = require('assert');
const path = require('path');

const P = 'C5 分流：';
const T_ROUTE = `${P}分流判定`;
const T_GOLIVE = `${P}上线事件有效性`;
const T_SPLIT = `${P}混合拆分`;
const T_MSPLIT = `${P}手动拆分`;
const T_PEND = `${P}待判定列表`;
const T_ASSIGN = `${P}待判定归属`;
const T_CLOSE = `${P}收口前置`;
const T_HIST = `${P}历史导入收口`;
const T_OBJ = `${P}收口后异议`;
const T_NOTICE = `${P}知会异议`;
const T_LINK = `${P}记系统迭代单号`;
const T_FLAGS = `${P}actions 同源`;
const T_RULES = `${P}rules`;
const T_APPEND = `${P}快照只追加`;
const T_CHECK = `${P}结构约束`;

const OK_DATE = '2026-10-25';

const shift = (d, n) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n)).toISOString().slice(0, 10);
};
const localToday = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function defineRoutingCases(T) {
  const { test, U, api, sqlRun, sqlGet, sqlAll, expectErr, eventsOf, addMember, addDelegation, confirm: H } = T;
  const { newProject, stageAtt, openAndDecide, produceEffectiveOverall, mkItem, defaultBatchId } = H;
  const post = (uid, url, body) => api(uid, 'POST', url, body === undefined ? {} : body);
  const get = (uid, url) => api(uid, 'GET', url);
  const today = () => (T.getFixedToday && T.getFixedToday()) || localToday();
  const countOf = async (s, p) => (await sqlGet(s, p)).n;
  const modDir = () => T.getModuleDir();
  const planMod = () => require(path.join(modDir(), 'plan.js'));
  const routingMod = () => require(path.join(modDir(), 'entries-routing.js'));

  // ── 登记 / 办理 / 节点助手 ───────────────────────────────────────────────────────────────────
  //   异议登记请求（带 objects_entry_id 键）不套默认的类型 / 标题 / 内容，请求体原样发（异议登记只认几个键，默认值会被当成多余键或错误类型）。
  const reg = (uid, pid, extra) => post(uid, `/sysbuild/projects/${pid}/entries`, extra && Object.prototype.hasOwnProperty.call(extra, 'objects_entry_id')
    ? extra : Object.assign({ type: 'note', title: '标题', body: '内容' }, extra || {}));
  async function regOk(uid, pid, extra) {
    const r = await reg(uid, pid, extra);
    assert.strictEqual(r.status, 201, r.text);
    return r.body.entry;
  }
  const act = (uid, eid, body) => post(uid, `/sysbuild/entries/${eid}/actions`, body);
  async function actOk(uid, eid, body) {
    const r = await act(uid, eid, body);
    assert.strictEqual(r.status, 201, `${JSON.stringify(body)}: ${r.text}`);
    return r.body;
  }
  const detail = async (uid, eid) => {
    const r = await get(uid, `/sysbuild/entries/${eid}`);
    assert.strictEqual(r.status, 200, r.text);
    return r.body.entry;
  };
  const CONCLUDE = { action: 'conclude', conclusion_kind: 'handled', text: '已处理，见方案说明' };
  const nodeId = async (pid, key) => (await sqlGet('SELECT id FROM sysbuild_nodes WHERE project_id = ? AND template_key = ?', [pid, key])).id;
  const closeNodeFx = (nid, closedAt) => sqlRun("UPDATE sysbuild_nodes SET status = 'closed', opened_at = COALESCE(opened_at, '2026-10-01 09:00:00'), closed_at = ? WHERE id = ?", [closedAt, nid]);
  const reopenNodeFx = (nid) => sqlRun("UPDATE sysbuild_nodes SET status = 'in_progress', closed_at = NULL WHERE id = ?", [nid]);
  async function startNode(pid, key) {
    const nid = await nodeId(pid, key);
    const r = await post(U.pm, `/sysbuild/nodes/${nid}/start`);
    assert.strictEqual(r.status, 200, r.text);
    return nid;
  }
  const planNode = async (pid, nid) => (await get(U.pm, `/sysbuild/projects/${pid}/plan`)).body.nodes.find((n) => n.id === nid);
  const eventsOfType = (pid, type) => sqlAll('SELECT * FROM sysbuild_events WHERE project_id = ? AND event_type = ? ORDER BY id', [pid, type]);
  const snapsOf = (eid) => sqlAll('SELECT * FROM sysbuild_routing_snapshots WHERE entry_id = ? ORDER BY id', [eid]);
  const snapRows = async (eid) => (await snapsOf(eid)).map((r) => [r.part_no, r.overall_package_version_id, r.item_version_id, r.committed_batch_id, r.golive_event_id, r.trigger_action_id, r.route, r.basis_category]);
  const kidsOf = (eid) => sqlAll('SELECT * FROM sysbuild_entries WHERE parent_entry_id = ? ORDER BY id', [eid]);
  const itemRowsOf = async (eid) => (await sqlAll('SELECT item_id, item_version_id, assigned_by_action_id FROM sysbuild_entry_items WHERE entry_id = ? ORDER BY id', [eid])).map((r) => [r.item_id, r.item_version_id, r.assigned_by_action_id]);
  const stateOf = async (eid) => (await detail(U.pm, eid)).conclusion_state;
  async function lastConclusionTask(eid) {
    const rows = await sqlAll("SELECT id FROM sysbuild_confirm_tasks WHERE object_type = 'conclusion' AND object_id = ? ORDER BY id DESC LIMIT 1", [eid]);
    assert.ok(rows.length > 0, `登记 ${eid} 应有结论确认任务`);
    return rows[0].id;
  }
  // 上线事件夹具（C6 才有生产写入口，C6 后改生产路径复验）：offset 是 SQLite 时间修饰符，如 '-1 hour'；返回事件编号
  async function golive(batch, kind, offset) {
    const r = await sqlRun(
      "INSERT INTO sysbuild_golive_events (batch_id, kind, handover_snapshot_json, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, datetime('now','localtime',?))",
      [batch, kind, kind === 'revoke' ? null : '{}', kind === 'revoke' ? '撤销上线（用例夹具）' : null, U.pm, offset]
    );
    return r.lastID;
  }

  // 标准场景：总体规划已经生产路径生效（甲部 own / del、一个条目 i1 在默认批次 batch1），再加：甲部一般成员 m1 / m2、信息技术部内部成员 cand、第二批次 batch2。
  //   mkInPlan(batch) 往已生效版本追加一个条目（夹具，见文件头 ③）；batch 为 null = 在规划里却没有承诺批次；outPlan() 建一个不在规划里的条目。
  async function mkPlan() {
    const pid = await newProject();
    const eff = await produceEffectiveOverall(pid);
    const A = eff.party;
    const mM1 = await addMember(pid, U.m1, { party: A });
    const mM2 = await addMember(pid, U.m2, { party: A });
    const mInt = await addMember(pid, U.cand);
    const batch1 = await defaultBatchId(pid);
    const batch2 = (await sqlRun("INSERT INTO sysbuild_batches (project_id, seq, name, is_default, status) VALUES (?, 2, '第 2 批', 0, 'planning')", [pid])).lastID;
    const i1row = await sqlGet('SELECT item_id FROM sysbuild_item_versions WHERE id = ?', [eff.itemVersionId]);
    const i1 = { id: i1row.item_id, ver: eff.itemVersionId };
    const mkInPlan = async (batch) => {
      const it = await mkItem(pid);
      const ver = it.versions[0].id;
      await sqlRun("INSERT INTO sysbuild_package_item_revisions (package_version_id, item_version_id, committed_batch_id, op, created_by) VALUES (?, ?, ?, 'add', ?)", [eff.pv, ver, batch, U.pm]);
      return { id: it.id, ver };
    };
    const outPlan = async () => {
      const it = await mkItem(pid);
      return { id: it.id, ver: it.versions[0].id };
    };
    return { pid, eff, A, mM1, mM2, mInt, batch1, batch2, i1, mkInPlan, outPlan };
  }

  // ═══════════════════════ 1 分流判定 ═══════════════════════
  test(`${T_ROUTE}——办理类登记提交时分流：全部未上线 → 留项目（快照 in_plan，一个条目一行）；未关联条目 / 条目不在生效规划里 / 规划里没有承诺批次 → 尚未判定（待判定）；全部已上线 → 409 拒绝新增（guide = sys_iteration + 已上线清单，不留行）；既有未上线又有已上线 → 受理并拆分；补充登记同样分流；知悉类不分流`, async () => {
    const s = await mkPlan();
    const i2 = await s.mkInPlan(s.batch2);
    const i4 = await s.outPlan();
    const i5 = await s.mkInPlan(null);
    // ① 全部未上线：留项目，不拆分
    const e1 = await regOk(U.pm, s.pid, { type: 'feedback', item_ids: [s.i1.id, i2.id] });
    assert.deepStrictEqual([e1.routing.route, e1.routing.basis_category, e1.routing.part_no, e1.conclusion_state, e1.split_children, e1.parent_entry_id], ['project', 'in_plan', 1, 'none', [], null]);
    assert.ok(typeof e1.routing.decided_at === 'string' && e1.routing.decided_at.length >= 19);
    assert.deepStrictEqual(await snapRows(e1.id), [
      [1, s.eff.pv, s.i1.ver, s.batch1, null, null, 'project', 'in_plan'],
      [1, s.eff.pv, i2.ver, s.batch2, null, null, 'project', 'in_plan'],
    ], '一个条目一行：总体包版本 / 条目版本 / 承诺批次；留项目没有上线事件；首次判定没有触发动作');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE parent_entry_id = ?', [e1.id]), 0);
    assert.strictEqual(e1.routing_snapshots.length, 2, '详情带判定快照清单');
    // ② 尚未判定：没有条目 / 条目不在生效总体规划里 / 在规划里却没有承诺批次 → 一个处理项，判定列全空
    for (const [label, ids] of [['未关联条目', []], ['规划外条目', [i4.id]], ['规划里没有承诺批次', [i5.id]]]) {
      const e = await regOk(U.pm, s.pid, { type: 'issue', item_ids: ids });
      assert.deepStrictEqual([e.routing.route, e.routing.basis_category, e.split_children], ['pending', 'undetermined', []], label);
      assert.deepStrictEqual(await snapRows(e.id), [[1, null, null, null, null, null, 'pending', 'undetermined']], `${label}：一行全空`);
      assert.strictEqual(e.items.length, ids.length, `${label}：关联关系照常保存`);
    }
    // ③ 全部已上线 → 409 拒绝新增，不留行
    const gid = await golive(s.batch1, 'golive', '-1 hour');
    const beforeEntries = await countOf('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE project_id = ?', [s.pid]);
    const beforeSnaps = await countOf('SELECT COUNT(*) AS n FROM sysbuild_routing_snapshots WHERE entry_id IN (SELECT id FROM sysbuild_entries WHERE project_id = ?)', [s.pid]);
    const beforeEvents = await countOf('SELECT COUNT(*) AS n FROM sysbuild_events WHERE project_id = ?', [s.pid]);
    const rej = await reg(U.m1, s.pid, { type: 'issue', item_ids: [s.i1.id] });
    expectErr(rej, 409, 'SYSBUILD_STATE', '全部已上线');
    assert.strictEqual(rej.body.guide, 'sys_iteration');
    const code1 = (await sqlGet('SELECT code FROM sysbuild_items WHERE id = ?', [s.i1.id])).code;
    assert.deepStrictEqual(rej.body.live_items, [{ item_id: s.i1.id, code: code1, batch_id: s.batch1, batch_name: '第 1 批', golive_event_id: gid }], '已上线条目 / 批次 / 上线事件清单');
    assert.ok(rej.body.message.includes('系统迭代'), rej.body.message);
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE project_id = ?', [s.pid]), beforeEntries, '被拒不留登记行');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_routing_snapshots WHERE entry_id IN (SELECT id FROM sysbuild_entries WHERE project_id = ?)', [s.pid]), beforeSnaps, '被拒不留快照');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_events WHERE project_id = ?', [s.pid]), beforeEvents, '被拒不留事件');
    // 两个条目都已上线（同一批次）：清单两项；一个已上线 + 一个未上线 → 不是「全部已上线」，受理并拆分
    const i3 = await s.mkInPlan(s.batch1);
    const rej2 = await reg(U.pm, s.pid, { type: 'feedback', item_ids: [s.i1.id, i3.id] });
    expectErr(rej2, 409, 'SYSBUILD_STATE', '两个条目都已上线');
    assert.deepStrictEqual(rej2.body.live_items.map((x) => x.item_id), [s.i1.id, i3.id]);
    // ④ 既有未上线又有已上线 → 受理并拆分（详细字段见「混合拆分」用例）
    const mix = await regOk(U.pm, s.pid, { type: 'feedback', item_ids: [s.i1.id, i2.id] });
    assert.strictEqual(mix.conclusion_state, 'split_container');
    assert.strictEqual(mix.split_children.length, 2);
    // ⑤ 已上线 + 规划外：不是「全部已上线」→ 拆分（已上线项 + 待判定项）
    const mix2 = await regOk(U.pm, s.pid, { type: 'issue', item_ids: [s.i1.id, i4.id] });
    assert.strictEqual(mix2.split_children.length, 2);
    assert.deepStrictEqual((await kidsOf(mix2.id)).map((k) => k.parent_entry_id), [mix2.id, mix2.id]);
    // ⑥ 补充登记同样分流：节点已收口 + 批次已上线 → 拒绝新增；节点已收口 + 批次未上线 → 留项目办理
    const nid = await nodeId(s.pid, 'b_dev');
    await closeNodeFx(nid, `${shift(today(), -3)} 09:00:00`);
    expectErr(await reg(U.pm, s.pid, { type: 'feedback', node_id: nid, item_ids: [s.i1.id] }), 409, 'SYSBUILD_STATE', '补充登记 + 已上线');
    const sup = await regOk(U.pm, s.pid, { type: 'feedback', node_id: nid, item_ids: [i2.id] });
    assert.deepStrictEqual([sup.period, sup.days_after_close, sup.routing.route], ['supplement', 3, 'project'], '补充登记 + 未上线');
    assert.deepStrictEqual(await snapRows(sup.id), [[1, s.eff.pv, i2.ver, s.batch2, null, null, 'project', 'in_plan']]);
    // ⑦ 知悉类（补充说明 / 经验教训 / 使用与效益 / 补交材料）不分流：关联已上线条目照常受理，没有快照
    for (const type of ['note', 'lesson', 'benefit']) {
      const e = await regOk(U.m1, s.pid, { type, item_ids: [s.i1.id] });
      assert.deepStrictEqual([e.routing, e.items.length], [null, 1], `${type} 不分流`);
      assert.strictEqual((await snapsOf(e.id)).length, 0);
    }
    const mat = await regOk(U.m1, s.pid, { type: 'material', item_ids: [s.i1.id], attachment_ids: [await stageAtt(s.pid, U.m1, 'a')] });
    assert.strictEqual(mat.routing, null);
    // ⑧ 每个处理项一条 routing_decided 事件
    assert.ok((await eventsOfType(s.pid, 'routing_decided')).length >= 4);
  });

  // ═══════════════════════ 2 上线事件有效性 ═══════════════════════
  test(`${T_GOLIVE}——批次「当前有效上线」：没有事件 = 未上线；golive → 已上线；revoke → 未上线；regolive → 又已上线；以最后一条事件（按编号）为准；事件时刻不早于登记时刻（晚于或同时）= 未上线；别的批次的事件不影响；快照记录的是当时有效的上线事件`, async () => {
    const s = await mkPlan();
    const probe = () => reg(U.pm, s.pid, { type: 'issue', item_ids: [s.i1.id] });
    // C6a：探测登记随即办结（不留未结登记挡后面的上线前置——交接集合里的未办结登记会拦确认试运行结束）
    const live = async () => {
      const r = await probe();
      if (r.status === 201) { await actOk(U.pm, r.body.entry.id, CONCLUDE); return false; }
      expectErr(r, 409, 'SYSBUILD_STATE', '探测');
      return true;
    };
    assert.strictEqual(await live(), false, '没有上线事件');
    // C6a：上线 / 撤销 / 再上线三条事件改经生产端点写入（确认试运行结束 POST /batches/:bid/golive、admin 撤销 POST …/revoke-golive；readyForGolive 先满足前置：批次验收包生效 + 本批节点收口），
    //   「已上线」判据与分流同一个函数；下面「别的批次 / 编号取最后一条 / 时刻边界」仍用夹具构造（端点只会写出 now 时刻的事件，造不出未来时刻与乱序编号）
    await H.readyForGolive(s.pid, s.batch1);
    const g1 = (await H.productionGolive(s.batch1, '-3 hours')).golive_event.id;
    assert.strictEqual(await live(), true, 'golive');
    await H.productionRevoke(s.batch1, '撤销（生产路径复验）');
    assert.strictEqual(await live(), false, 'revoke 之后');
    const g2 = (await H.productionGolive(s.batch1, '-1 hour')).golive_event.id; // 最后一条是 revoke，端点写 regolive
    assert.strictEqual((await sqlGet('SELECT kind FROM sysbuild_golive_events WHERE id = ?', [g2])).kind, 'regolive', '撤销后的再上线事件 kind = regolive');
    assert.strictEqual(await live(), true, 'regolive 之后');
    // 别的批次的事件不影响本批
    await golive(s.batch2, 'revoke', '-30 minutes');
    assert.strictEqual(await live(), true, '别的批次的撤销不影响');
    // 事件时刻晚于登记时刻（登记时刻不晚于事件时刻）：未上线
    const g3 = await golive(s.batch1, 'revoke', '-20 minutes');
    await golive(s.batch1, 'golive', '+1 hour');
    assert.strictEqual(await live(), false, '最后一条 golive 的时刻在一小时后：登记时刻不晚于它');
    // 「最后一条」按编号：编号更大但时刻更早的 regolive 才是最后一条
    const g4 = await golive(s.batch1, 'regolive', '-10 minutes');
    assert.strictEqual(await live(), true, '按编号取最后一条');
    // 快照记录当时有效的上线事件（混合拆分时已上线项带 golive_event_id = 最后一条）
    const i2 = await s.mkInPlan(s.batch2);
    const mix = await regOk(U.pm, s.pid, { type: 'feedback', item_ids: [s.i1.id, i2.id] });
    const kids = await kidsOf(mix.id);
    const rowsByKid = [];
    for (const k of kids) rowsByKid.push(await snapRows(k.id));
    assert.deepStrictEqual(rowsByKid, [
      [[1, s.eff.pv, i2.ver, s.batch2, null, null, 'project', 'in_plan']],
      [[2, s.eff.pv, s.i1.ver, s.batch1, g4, null, 'sys_iteration', 'in_plan']],
    ], '已上线项的 golive_event_id 是最后一条有效上线事件');
    assert.ok(g1 < g2 && g2 < g3 && g3 < g4, '前置：事件编号递增');
  });

  // ═══════════════════════ 3 混合拆分 ═══════════════════════
  test(`${T_SPLIT}——混合拆分：原登记成为已拆分容器（保留关联与附件，自己没有判定快照）；每个去向一个子登记（留项目 → 转系统迭代 → 待判定的顺序，part_no 从 1 起），复制类型 / 来源方 / 时段 / 标志 / 证据声明 / 登记人身份快照；子项各自快照、各自关联本组条目；容器上的办理动作 409；子项全部已结 = 容器有结论`, async () => {
    const s = await mkPlan();
    const i2 = await s.mkInPlan(s.batch2);
    const i4 = await s.outPlan();
    const gid = await golive(s.batch1, 'golive', '-1 hour');
    const att = await stageAtt(s.pid, U.m1, 'a');
    const R10 = '十个字的原因啊啊啊啊';
    const m = await regOk(U.m1, s.pid, {
      type: 'issue', title: '混合问题', body: '正文X', is_risk: 1, commitment_flag: 1, no_written_evidence: true, no_evidence_reason: R10, business_date: OK_DATE, item_ids: [s.i1.id, i2.id, i4.id],
    });
    assert.deepStrictEqual([m.conclusion_state, m.resolved, m.routing, m.attachments.length], ['split_container', false, null, 0]);
    // 容器：保留关联（三个条目）、没有自己的判定快照
    assert.deepStrictEqual(await itemRowsOf(m.id), [[s.i1.id, s.i1.ver, null], [i2.id, i2.ver, null], [i4.id, i4.ver, null]]);
    assert.strictEqual((await snapsOf(m.id)).length, 0);
    const kids = await kidsOf(m.id);
    assert.strictEqual(kids.length, 3);
    const parent = await sqlGet('SELECT * FROM sysbuild_entries WHERE id = ?', [m.id]);
    for (const k of kids) {
      for (const col of ['project_id', 'node_id', 'type', 'purpose', 'commitment_flag', 'commitment_flag_source', 'is_risk', 'source_party_id', 'source_name', 'operator_user_id', 'operator_identity_snapshot',
        'period', 'days_after_close', 'business_date', 'title', 'no_written_evidence', 'no_evidence_reason']) {
        assert.strictEqual(k[col], parent[col], `子项复制 ${col}`);
      }
      assert.deepStrictEqual([k.parent_entry_id, k.objects_entry_id], [m.id, null]);
      assert.ok(k.body.startsWith(`由第 ${m.id} 条登记按分流归属拆出`) && k.body.includes('正文X'), k.body);
    }
    assert.deepStrictEqual([parent.commitment_flag, parent.commitment_flag_source, parent.is_risk, parent.no_written_evidence, parent.no_evidence_reason, parent.business_date], [1, 'submitter', 1, 1, R10, OK_DATE], '前置：原登记带标志与证据声明');
    assert.strictEqual(JSON.parse(kids[0].operator_identity_snapshot).is_pm, false);
    // 顺序与各自快照 / 关联
    assert.deepStrictEqual(await itemRowsOf(kids[0].id), [[i2.id, i2.ver, null]]);
    assert.deepStrictEqual(await itemRowsOf(kids[1].id), [[s.i1.id, s.i1.ver, null]]);
    assert.deepStrictEqual(await itemRowsOf(kids[2].id), [[i4.id, i4.ver, null]]);
    assert.deepStrictEqual(await snapRows(kids[0].id), [[1, s.eff.pv, i2.ver, s.batch2, null, null, 'project', 'in_plan']]);
    assert.deepStrictEqual(await snapRows(kids[1].id), [[2, s.eff.pv, s.i1.ver, s.batch1, gid, null, 'sys_iteration', 'in_plan']]);
    assert.deepStrictEqual(await snapRows(kids[2].id), [[3, null, null, null, null, null, 'pending', 'undetermined']]);
    assert.deepStrictEqual([(await detail(U.pm, kids[0].id)).awaiting_sys_iteration, (await detail(U.pm, kids[1].id)).awaiting_sys_iteration, (await detail(U.pm, kids[2].id)).awaiting_sys_iteration], [false, true, false], '只有转系统迭代的处理项是「待转系统迭代」');
    // 附件不复制：容器 1 个、子项 0 个；子项详情回读不到附件（回读原登记）
    const a2 = await regOk(U.m1, s.pid, { type: 'feedback', item_ids: [s.i1.id, i2.id], attachment_ids: [await stageAtt(s.pid, U.m1, 'b')] });
    assert.strictEqual(a2.attachments.length, 1);
    for (const k of await kidsOf(a2.id)) assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_attachment_bindings WHERE owner_type = 'entry' AND owner_id = ?", [k.id]), 0, '附件不复制');
    // 事件：一条 entry_split（via = auto）、每个子项一条 routing_decided
    const sp = (await eventsOfType(s.pid, 'entry_split')).map((e) => JSON.parse(e.payload_json)).find((p) => p.children.some((c) => c.entry_id === kids[0].id));
    assert.deepStrictEqual([sp.via, sp.children.map((c) => [c.entry_id, c.part_no, c.route])], ['auto', [[kids[0].id, 1, 'project'], [kids[1].id, 2, 'sys_iteration'], [kids[2].id, 3, 'pending']]]);
    // 子项的读接口：来源 / 状态 / 路由 / 确认人（沿用登记人身份快照 → 来源方代表人）
    const k0 = await detail(U.pm, kids[0].id);
    assert.deepStrictEqual([k0.parent_entry_id, k0.routing.route, k0.conclusion_state, k0.confirmer.kind, k0.source_party_id, k0.items.length], [m.id, 'project', 'none', 'delegate', s.A, 1]);
    assert.deepStrictEqual((await detail(U.pm, m.id)).split_children.map((c) => [c.id, c.conclusion_state, c.resolved]), kids.map((k) => [k.id, 'none', false]));
    // 补充登记的父项拆分：子项复制 period / days_after_close（DDL：补充登记必须带天数）
    const nid = await nodeId(s.pid, 'b_dev');
    await closeNodeFx(nid, `${shift(today(), -4)} 09:00:00`);
    const sm = await regOk(U.pm, s.pid, { type: 'feedback', node_id: nid, item_ids: [s.i1.id, i2.id] });
    for (const k of await kidsOf(sm.id)) assert.deepStrictEqual([k.period, k.days_after_close, k.node_id], ['supplement', 4, nid]);
    // 容器上的办理动作一律 409（含更正 / 作废 / 结论 / 标记 / 交裁定 / 拆分 / 归属 / 记单号）；标志全假
    const dm = await detail(U.pm, m.id);
    for (const a of ['correct', 'void', 'conclude', 'for_reference', 'mark_commitment', 'unmark_commitment', 'mark_risk', 'unmark_risk', 'escalate', 'split', 'assign_items', 'link_sys_issue']) {
      assert.strictEqual(dm.actions[a], false, `容器的 actions.${a}`);
    }
    const BODY = {
      correct: { action: 'correct', text: '更正' }, void: { action: 'void', reason: '作废' }, conclude: CONCLUDE, for_reference: { action: 'for_reference' },
      mark_commitment: { action: 'mark_commitment', reason: '补标' }, unmark_commitment: { action: 'unmark_commitment', reason: '取消' }, mark_risk: { action: 'mark_risk', reason: '补标' },
      unmark_risk: { action: 'unmark_risk', reason: '取消' }, escalate: { action: 'escalate' }, split: { action: 'split', groups: [[s.i1.id], [i2.id, i4.id]] },
      assign_items: { action: 'assign_items', basis_category: 'out_of_plan', route: 'project', text: '依据' }, link_sys_issue: { action: 'link_sys_issue', sys_issue_no: 'SI-1' },
    };
    for (const [a, body] of Object.entries(BODY)) {
      const r = await act(U.pm, m.id, body);
      expectErr(r, 409, 'SYSBUILD_STATE', `容器 ${a}`);
      assert.ok(r.body.message.includes('已拆分'), r.body.message);
    }
    assert.strictEqual((await sqlAll('SELECT id FROM sysbuild_entry_actions WHERE entry_id = ?', [m.id])).length, 0, '容器没有办理记录');
    // 子项各自办理，全部「已结」后容器视为有结论：PM 登记的子项不需确认
    const p = await regOk(U.pm, s.pid, { type: 'feedback', item_ids: [s.i1.id, i2.id, i4.id] });
    const pk = await kidsOf(p.id);
    assert.deepStrictEqual((await detail(U.pm, pk[0].id)).confirmer.kind, 'none');
    await actOk(U.pm, pk[0].id, CONCLUDE);
    assert.strictEqual((await detail(U.pm, p.id)).resolved, false, '还有两个子项未结');
    await actOk(U.pm, pk[1].id, { action: 'conclude', conclusion_kind: 'to_sys_iteration', text: '转系统迭代受理', sys_issue_no: 'SI-100', assignee_text: '外包张三' });
    assert.strictEqual((await detail(U.pm, p.id)).resolved, false, '还有一个子项未结');
    assert.strictEqual((await detail(U.pm, pk[1].id)).awaiting_sys_iteration, false, '转系统迭代结论给出后不再是「待转系统迭代」');
    await actOk(U.pm, pk[2].id, { action: 'void', reason: '待判定的子项作废' });
    const done = await detail(U.pm, p.id);
    assert.deepStrictEqual([done.conclusion_state, done.resolved], ['split_container', true], '子项全部已结（含作废）= 容器有结论');
    assert.deepStrictEqual(done.split_children.map((c) => [c.conclusion_state, c.resolved]), [['settled_no_confirm', true], ['settled_no_confirm', true], ['voided', true]]);
    // 来源方有代表人的子项：结论仍须提出方代表人确认（D30 不因分流豁免），待确认的子项让容器保持未结
    const qAtt = await stageAtt(s.pid, U.m1, 'c');
    const q = await regOk(U.m1, s.pid, { type: 'feedback', item_ids: [s.i1.id, i2.id], attachment_ids: [qAtt] });
    const qk = await kidsOf(q.id);
    // 预筛 M-2：去向转系统迭代的处理项，结论只能是「转系统迭代」，不能给别的结论或标仅供参考；conclude_kinds 随之
    const sysKid = await detail(U.pm, qk[1].id);
    assert.deepStrictEqual([sysKid.routing.route, sysKid.actions.conclude_kinds, sysKid.actions.for_reference], ['sys_iteration', ['to_sys_iteration'], false]);
    const badKind = await act(U.pm, qk[1].id, CONCLUDE);
    expectErr(badKind, 409, 'SYSBUILD_STATE', '转系统迭代的处理项给 handled');
    assert.ok(badKind.body.message.includes('转系统迭代'), badKind.body.message);
    expectErr(await act(U.pm, qk[1].id, { action: 'conclude', conclusion_kind: 'no_further', text: '不再处理' }), 409, 'SYSBUILD_STATE', 'no_further 不放行');
    expectErr(await act(U.pm, qk[1].id, { action: 'for_reference' }), 409, 'SYSBUILD_STATE', '转系统迭代的处理项标仅供参考');
    assert.strictEqual((await sqlAll('SELECT id FROM sysbuild_entry_actions WHERE entry_id = ?', [qk[1].id])).length, 0, '被拒不留办理记录');
    assert.deepStrictEqual((await detail(U.pm, qk[0].id)).actions.conclude_kinds, ['handled', 'adopted', 'not_adopted', 'deferred', 'to_change', 'to_sys_iteration', 'no_further'], '留项目的处理项不受影响（S-S1c：to_change 按类别可用性列出）');
    // 拆分子项的附件不复制：详情回读原登记附件并标 from_parent；子项给结论时冻结清单取原登记（容器）名下附件，冻结键挂子项
    const qkDetail = await detail(U.pm, qk[0].id);
    assert.deepStrictEqual(qkDetail.attachments.map((a) => [a.attachment_id, a.from_parent]), [[qAtt, true]]);
    assert.deepStrictEqual((await detail(U.pm, q.id)).attachments.map((a) => [a.attachment_id, a.from_parent]), [[qAtt, false]], '容器自己的附件 from_parent = false');
    await actOk(U.pm, qk[0].id, CONCLUDE);
    assert.deepStrictEqual((await sqlAll("SELECT attachment_id FROM sysbuild_frozen_attachments WHERE object_type = 'entry' AND object_version_id = ?", [qk[0].id])).map((r) => r.attachment_id), [qAtt], '子项冻结清单 = 原登记附件');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_frozen_attachments WHERE object_type = 'entry' AND object_version_id = ?", [q.id]), 0, '冻结键不挂容器');
    await actOk(U.pm, qk[1].id, { action: 'conclude', conclusion_kind: 'to_sys_iteration', text: '转系统迭代受理', sys_issue_no: 'SI-101', assignee_text: '外包张三' });
    assert.deepStrictEqual([await stateOf(qk[0].id), await stateOf(qk[1].id), (await detail(U.pm, q.id)).resolved], ['pending_confirm', 'pending_confirm', false]);
    assert.strictEqual((await openAndDecide(U.del, await lastConclusionTask(qk[0].id), 'confirm')).status, 200);
    assert.strictEqual((await detail(U.pm, q.id)).resolved, false);
    assert.strictEqual((await openAndDecide(U.del, await lastConclusionTask(qk[1].id), 'confirm')).status, 200);
    assert.strictEqual((await detail(U.pm, q.id)).resolved, true, '两个子项都已确认');
    // 子项（拆出的处理项）不能再拆分
    expectErr(await act(U.pm, qk[0].id, { action: 'split', groups: [[s.i1.id], [i2.id]] }), 409, 'SYSBUILD_STATE', '子项再拆分');
  });

  // ═══════════════════════ 4 手动拆分 ═══════════════════════
  test(`${T_MSPLIT}——split 办理动作：PM 按条目分组拆成子登记，每组走一次分流（组内去向须一致，不同组可以同去向）；至少两组、不漏条目、同一条目不进两组、条目须是本登记关联的；已有有效结论 / 已拆分 / 子项 / 作废 / 条目少于两个 / 非办理类 → 409；快照的触发动作是 split 动作`, async () => {
    const s = await mkPlan();
    const i2 = await s.mkInPlan(s.batch2);
    const i3 = await s.mkInPlan(s.batch2);
    const e = await regOk(U.m1, s.pid, { type: 'issue', item_ids: [s.i1.id, i2.id, i3.id] });
    assert.strictEqual(e.routing.route, 'project', '前置：三个条目都未上线，不自动拆分');
    // 权限：只有 PM；登记人本人 403；只读 403；非成员 404
    const G = [[s.i1.id], [i2.id, i3.id]];
    for (const uid of [U.m1, U.m2, U.ro, U.admin]) expectErr(await act(uid, e.id, { action: 'split', groups: G }), 403, 'SYSBUILD_FORBIDDEN', `用户 ${uid} 拆分`);
    expectErr(await act(U.out, e.id, { action: 'split', groups: G }), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    // 参数 400
    const bad = async (extra, field, label) => {
      const r = await act(U.pm, e.id, Object.assign({ action: 'split' }, extra));
      expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', label);
      assert.strictEqual(r.body.field, field, label);
    };
    await bad({}, 'groups', '缺 groups');
    await bad({ groups: 'x' }, 'groups', 'groups 不是数组');
    await bad({ groups: [[s.i1.id, i2.id, i3.id]] }, 'groups', '只有一组');
    await bad({ groups: [[s.i1.id], []] }, 'groups', '有空组');
    await bad({ groups: [[s.i1.id], 'x'] }, 'groups', '组不是数组');
    await bad({ groups: [[s.i1.id], ['a']] }, 'groups', '条目编号不合法');
    await bad({ groups: [[s.i1.id], [i2.id]] }, 'groups', '漏了条目 i3');
    await bad({ groups: [[s.i1.id, i2.id], [i2.id, i3.id]] }, 'groups', '同一条目进两组');
    await bad({ groups: [[s.i1.id, i2.id, i3.id], []] }, 'groups', '并集齐全但有一个空组');
    const other = await mkPlan();
    await bad({ groups: [[s.i1.id], [i2.id, i3.id, other.i1.id]] }, 'groups', '别的项目的条目');
    await bad({ groups: [[s.i1.id, i2.id], [other.i1.id]] }, 'groups', '个数凑齐但换进别的项目的条目');
    await bad({ groups: G, bogus: 1 }, 'bogus', '多余键');
    assert.strictEqual((await kidsOf(e.id)).length, 0, '被拒的请求不留子项');
    assert.strictEqual((await sqlAll('SELECT id FROM sysbuild_entry_actions WHERE entry_id = ?', [e.id])).length, 0, '被拒的请求不留办理记录');
    // 成功：两组都未上线 → 两个留项目的子项（跨模块 / 跨批次拆分，不同组可以同去向）
    const r = await actOk(U.pm, e.id, { action: 'split', groups: G, text: '按模块拆给不同承接人' });
    assert.deepStrictEqual(r.children.map((c) => [c.part_no, c.route]), [[1, 'project'], [2, 'project']]);
    const kids = await kidsOf(e.id);
    assert.deepStrictEqual(r.children.map((c) => c.entry_id), kids.map((k) => k.id));
    assert.deepStrictEqual(await snapRows(kids[0].id), [[1, s.eff.pv, s.i1.ver, s.batch1, null, r.action_id, 'project', 'in_plan']], '触发动作 = split 动作');
    assert.deepStrictEqual(await snapRows(kids[1].id), [
      [2, s.eff.pv, i2.ver, s.batch2, null, r.action_id, 'project', 'in_plan'],
      [2, s.eff.pv, i3.ver, s.batch2, null, r.action_id, 'project', 'in_plan'],
    ]);
    assert.deepStrictEqual(await itemRowsOf(kids[1].id), [[i2.id, i2.ver, r.action_id], [i3.id, i3.ver, r.action_id]], '子项关联的 assigned_by_action_id = split 动作');
    assert.deepStrictEqual((await detail(U.pm, e.id)).conclusion_state, 'split_container');
    assert.deepStrictEqual((await actOk(U.pm, kids[0].id, CONCLUDE)).entry.conclusion_state, 'pending_confirm', '子项来源方有代表人，照常发确认任务');
    const rec = (await detail(U.pm, e.id)).records;
    assert.deepStrictEqual(rec.map((x) => [x.action, x.text]), [['split', '按模块拆给不同承接人']]);
    const ev = (await eventsOfType(s.pid, 'entry_split')).map((x) => JSON.parse(x.payload_json)).find((p) => p.via === 'manual');
    assert.deepStrictEqual([ev.action_id, ev.children.length], [r.action_id, 2]);
    // 已拆分过 → 409；子项再拆 → 409
    expectErr(await act(U.pm, e.id, { action: 'split', groups: G }), 409, 'SYSBUILD_STATE', '已拆分过');
    expectErr(await act(U.pm, kids[1].id, { action: 'split', groups: [[i2.id], [i3.id]] }), 409, 'SYSBUILD_STATE', '子项再拆');
    // 手动拆分时每组重新分流（拆分发生在原登记受理之后，所以已上线的组转系统迭代而不是被拒绝）：登记时三个条目都未上线，之后批次一上线
    const f = await regOk(U.pm, s.pid, { type: 'issue', item_ids: [s.i1.id, i2.id, i3.id] });
    const g = await regOk(U.pm, s.pid, { type: 'issue', item_ids: [s.i1.id, i2.id, i3.id] });
    assert.deepStrictEqual([f.routing.route, g.routing.route], ['project', 'project'], '前置：登记时三个条目都未上线');
    const gid = await golive(s.batch1, 'golive', '-1 hour');
    // 组内既有已上线又有未上线 → 409（文案指出第几组），不留子项与办理记录
    const mixed = await act(U.pm, g.id, { action: 'split', groups: [[s.i1.id, i2.id], [i3.id]] });
    expectErr(mixed, 409, 'SYSBUILD_STATE', '组内既有已上线又有未上线');
    assert.ok(mixed.body.message.includes('第 1 组'), mixed.body.message);
    assert.deepStrictEqual([(await kidsOf(g.id)).length, (await sqlAll('SELECT id FROM sysbuild_entry_actions WHERE entry_id = ?', [g.id])).length], [0, 0]);
    // 按归属分组：已上线的组 → 转系统迭代（快照带上线事件），未上线的组 → 留项目
    const rf = await actOk(U.pm, f.id, { action: 'split', groups: [[s.i1.id], [i2.id, i3.id]] });
    assert.deepStrictEqual(rf.children.map((c) => [c.part_no, c.route]), [[1, 'sys_iteration'], [2, 'project']]);
    const fk = await kidsOf(f.id);
    assert.deepStrictEqual(await snapRows(fk[0].id), [[1, s.eff.pv, s.i1.ver, s.batch1, gid, rf.action_id, 'sys_iteration', 'in_plan']]);
    assert.deepStrictEqual((await snapRows(fk[1].id)).map((x) => [x[0], x[3], x[4], x[6]]), [[2, s.batch2, null, 'project'], [2, s.batch2, null, 'project']]);
    assert.strictEqual((await actOk(U.pm, fk[0].id, { action: 'conclude', conclusion_kind: 'to_sys_iteration', text: '转系统迭代', sys_issue_no: 'SI-7', assignee_text: '外包张三' })).entry.conclusion_state, 'settled_no_confirm');
    // 规划外条目组成的待判定登记也可以拆：每组一个待判定子项
    const i4 = await s.outPlan();
    const i5 = await s.outPlan();
    const i6 = await s.outPlan();
    const p = await regOk(U.pm, s.pid, { type: 'issue', item_ids: [i4.id, i5.id, i6.id] });
    assert.deepStrictEqual([p.routing.route, p.split_children.length], ['pending', 0], '前置：三个条目都不在规划里，一个待判定登记');
    // 组内规划内 + 规划外混放 → 409（先让 i5 进规划，夹具）
    await sqlRun("INSERT INTO sysbuild_package_item_revisions (package_version_id, item_version_id, committed_batch_id, op, created_by) VALUES (?, ?, ?, 'add', ?)", [s.eff.pv, i5.ver, s.batch2, U.pm]);
    expectErr(await act(U.pm, p.id, { action: 'split', groups: [[i4.id, i5.id], [i6.id]] }), 409, 'SYSBUILD_STATE', '规划内与规划外混放');
    const rp = await actOk(U.pm, p.id, { action: 'split', groups: [[i4.id, i6.id], [i5.id]] });
    assert.deepStrictEqual(rp.children.map((c) => [c.part_no, c.route]), [[1, 'pending'], [2, 'project']], '规划外一组仍待判定；进了规划的 i5 按规划留项目');
    const pk = await kidsOf(p.id);
    assert.deepStrictEqual(await snapRows(pk[0].id), [[1, null, null, null, null, rp.action_id, 'pending', 'undetermined']]);
    assert.deepStrictEqual(await snapRows(pk[1].id), [[2, s.eff.pv, i5.ver, s.batch2, null, rp.action_id, 'project', 'in_plan']]);
    // 已有有效结论 / 作废 / 条目少于两个 / 知悉类 → 409
    const one = await regOk(U.pm, s.pid, { type: 'issue', item_ids: [i2.id] });
    expectErr(await act(U.pm, one.id, { action: 'split', groups: [[i2.id], [i3.id]] }), 409, 'SYSBUILD_STATE', '条目少于两个');
    const done = await regOk(U.pm, s.pid, { type: 'issue', item_ids: [i2.id, i3.id] });
    await actOk(U.pm, done.id, CONCLUDE);
    expectErr(await act(U.pm, done.id, { action: 'split', groups: [[i2.id], [i3.id]] }), 409, 'SYSBUILD_STATE', '已有有效结论');
    const vd = await regOk(U.pm, s.pid, { type: 'issue', item_ids: [i2.id, i3.id] });
    await actOk(U.pm, vd.id, { action: 'void', reason: '作废' });
    expectErr(await act(U.pm, vd.id, { action: 'split', groups: [[i2.id], [i3.id]] }), 409, 'SYSBUILD_STATE', '已作废');
    const nt = await regOk(U.pm, s.pid, { type: 'note', item_ids: [i2.id, i3.id] });
    expectErr(await act(U.pm, nt.id, { action: 'split', groups: [[i2.id], [i3.id]] }), 409, 'SYSBUILD_STATE', '知悉类');
  });

  test(`${T_MSPLIT}（状态限制）——预筛 H-1：只有尚未给结论（none）的登记可以拆分；待确认 / 有异议 / 裁定中 / 裁定未通过 / 仅供参考被异议 / 项目已终止结论失效 / 有效结论 / 作废 一律 409（actions.split 为假、不留子项与办理记录）；H-2：容器名下有待确认修订时 500 回滚；拆分后待确认列表不出现容器任务`, async () => {
    const s = await mkPlan();
    const i2 = await s.mkInPlan(s.batch2);
    const G = [[s.i1.id], [i2.id]];
    const two = () => regOk(U.m1, s.pid, { type: 'feedback', item_ids: [s.i1.id, i2.id] });
    const noSplit = async (e, label) => {
      assert.strictEqual((await detail(U.pm, e.id)).actions.split, false, `${label}：标志`);
      const r = await act(U.pm, e.id, { action: 'split', groups: G });
      expectErr(r, 409, 'SYSBUILD_STATE', label);
      if (label !== '已作废') assert.ok(r.body.message.includes('尚未给结论'), `${label}：${r.body.message}`); // 作废的登记先被「已作废」拦下
      assert.strictEqual((await kidsOf(e.id)).length, 0, `${label}：不留子项`);
      assert.strictEqual((await sqlAll("SELECT id FROM sysbuild_entry_actions WHERE entry_id = ? AND action = 'split'", [e.id])).length, 0, `${label}：不留办理记录`);
    };
    // none：可拆（标志为真）
    const e0 = await two();
    assert.strictEqual((await detail(U.pm, e0.id)).actions.split, true);
    // 待确认 → 有异议 → 裁定中 → 裁定未通过（同一条登记走一遍）
    const e1 = await two();
    await actOk(U.pm, e1.id, CONCLUDE);
    assert.strictEqual(await stateOf(e1.id), 'pending_confirm');
    await noSplit(e1, '待确认');
    assert.strictEqual((await openAndDecide(U.del, await lastConclusionTask(e1.id), 'object', { reason: '不同意' })).status, 200);
    assert.strictEqual(await stateOf(e1.id), 'objected');
    await noSplit(e1, '有异议');
    await actOk(U.pm, e1.id, { action: 'escalate' });
    assert.strictEqual(await stateOf(e1.id), 'escalated');
    await noSplit(e1, '裁定中');
    const adj = (await sqlAll("SELECT id FROM sysbuild_confirm_tasks WHERE object_type = 'adjudication' AND object_id = ?", [e1.id]))[0].id;
    assert.strictEqual((await openAndDecide(U.own, adj, 'reject', { reason: '不认可' })).status, 200);
    assert.strictEqual(await stateOf(e1.id), 'adjudication_rejected');
    await noSplit(e1, '裁定未通过');
    // 仅供参考被异议（节点未收口：回到办理）
    const e2 = await two();
    await actOk(U.pm, e2.id, { action: 'for_reference' });
    await noSplit(e2, '仅供参考');
    const n2 = (await sqlGet("SELECT id FROM sysbuild_notices WHERE ref_type = 'entry' AND ref_id = ?", [e2.id])).id;
    assert.strictEqual((await post(U.del, `/sysbuild/notices/${n2}/object`, { reason: '不是无实质内容' })).status, 201);
    assert.strictEqual(await stateOf(e2.id), 'for_reference_objected');
    await noSplit(e2, '仅供参考被异议');
    // 有效结论、作废
    const e3 = await two();
    await actOk(U.pm, e3.id, CONCLUDE);
    assert.strictEqual((await openAndDecide(U.del, await lastConclusionTask(e3.id), 'confirm')).status, 200);
    await noSplit(e3, '已确认');
    const e4 = await two();
    await actOk(U.m1, e4.id, { action: 'void', reason: '作废' });
    await noSplit(e4, '已作废');
    // 项目已终止结论失效：终止 → 项目已终止结论 → 重开
    const t = await mkPlan();
    const ti2 = await t.mkInPlan(t.batch2);
    const te = await regOk(U.m1, t.pid, { type: 'feedback', item_ids: [t.i1.id, ti2.id] });
    assert.strictEqual((await post(U.admin, `/sysbuild/projects/${t.pid}/status`, { to: 'terminated', reason: 'C5 用例' })).status, 200);
    await actOk(U.pm, te.id, { action: 'conclude', conclusion_kind: 'project_terminated', text: '项目已终止，关闭本条' });
    assert.strictEqual((await post(U.admin, `/sysbuild/projects/${t.pid}/status`, { to: 'active', reason: 'C5 用例重开' })).status, 200);
    assert.strictEqual(await stateOf(te.id), 'terminated_conclusion_lapsed');
    assert.strictEqual((await detail(U.pm, te.id)).actions.split, false);
    const tr = await act(U.pm, te.id, { action: 'split', groups: [[t.i1.id], [ti2.id]] });
    expectErr(tr, 409, 'SYSBUILD_STATE', '项目已终止结论失效');
    assert.ok(tr.body.message.includes('尚未给结论'), tr.body.message);
    // H-2：库内矛盾（容器名下有待确认修订）→ 500 整笔回滚，不留子项与办理记录
    const h = await two();
    const orphan = await sqlRun("INSERT INTO sysbuild_confirm_tasks (project_id, object_type, object_id, object_version_id, purpose, party_id, created_by) VALUES (?, 'conclusion', ?, 987654, 'conclusion_confirm', ?, ?)", [s.pid, h.id, s.A, U.pm]);
    await sqlRun("INSERT INTO sysbuild_confirm_task_revisions (task_id, rev_no, required_member_id, status, created_by) VALUES (?, 1, ?, 'pending', ?)", [orphan.lastID, s.mM1, U.pm]);
    const rh = await act(U.pm, h.id, { action: 'split', groups: G });
    expectErr(rh, 500, 'SYSBUILD_INTERNAL', '容器名下有待确认修订');
    assert.deepStrictEqual([(await kidsOf(h.id)).length, (await sqlAll('SELECT id FROM sysbuild_entry_actions WHERE entry_id = ?', [h.id])).length], [0, 0], '整笔回滚');
    // 修订批 2 M-2：PM 已按规划外 / 规划内待细化人工归属的登记不能拆（拆分每组重新分流，会洗掉人工归属）；关联条目 ≥ 2 个，所以只剩依据这一条挡着
    const o4 = await s.outPlan();
    const o5 = await s.outPlan();
    for (const [label, body] of [
      ['规划外 → 转系统迭代', { basis_category: 'out_of_plan', route: 'sys_iteration' }],
      ['规划外 → 留项目', { basis_category: 'out_of_plan', route: 'project' }],
      ['规划内待细化', { basis_category: 'planned_detail', item_ids: [o4.id, o5.id] }],
    ]) {
      const e = await regOk(U.pm, s.pid, { type: 'issue', item_ids: [o4.id, o5.id] });
      assert.strictEqual((await detail(U.pm, e.id)).actions.split, true, `${label}：前置——归属前可拆`);
      await actOk(U.pm, e.id, Object.assign({ action: 'assign_items', text: '人工归属依据' }, body));
      assert.strictEqual((await detail(U.pm, e.id)).actions.split, false, `${label}：标志`);
      const r = await act(U.pm, e.id, { action: 'split', groups: [[o4.id], [o5.id]] });
      expectErr(r, 409, 'SYSBUILD_STATE', label);
      assert.ok(r.body.message.includes('不能拆分'), r.body.message);
      assert.strictEqual((await kidsOf(e.id)).length, 0, `${label}：不留子项`);
    }
    // 正常拆分后，代表人的待我确认里没有容器任务
    await actOk(U.pm, e0.id, { action: 'split', groups: G });
    const mine = (await get(U.del, '/sysbuild/my/confirmations')).body.items;
    assert.ok(!mine.some((x) => (x.object_type === 'conclusion' || x.object_type === 'adjudication') && x.object_id === e0.id), '容器没有确认任务');
  });

  test(`${T_MSPLIT}（标记继承）——预筛 M-1：拆分子项继承原登记的当前风险 / 涉及承诺（PM 补标不丢）：风险 = 当前值，涉及承诺 = 初始 ∨ 当前，初始为 1 取原来源、只由 PM 补标取 pm；子项的初始标记由此守住「初始带标记不能标仅供参考」`, async () => {
    const s = await mkPlan();
    const i2 = await s.mkInPlan(s.batch2);
    const G = [[s.i1.id], [i2.id]];
    const R10 = '十个字的原因啊啊啊啊';
    const colsOf = async (id) => { const r = await sqlGet('SELECT commitment_flag, commitment_flag_source, is_risk FROM sysbuild_entries WHERE id = ?', [id]); return [r.commitment_flag, r.commitment_flag_source, r.is_risk]; };
    // ① PM 补标涉及承诺后拆 → 子项带承诺（来源 pm）、当前为真，不能标仅供参考；PM 在子项上取消后，初始标记仍拦
    const a = await regOk(U.pm, s.pid, { type: 'feedback', item_ids: [s.i1.id, i2.id] });
    await actOk(U.pm, a.id, { action: 'mark_commitment', reason: '补标：涉及交付承诺' });
    await actOk(U.pm, a.id, { action: 'split', groups: G });
    const ak = await kidsOf(a.id);
    for (const k of ak) {
      assert.deepStrictEqual(await colsOf(k.id), [1, 'pm', 0], '补标的涉及承诺：子项标志 1、来源 pm');
      const d = await detail(U.pm, k.id);
      assert.deepStrictEqual([d.commitment_current, d.actions.for_reference], [true, false]);
      const r = await act(U.pm, k.id, { action: 'for_reference' });
      expectErr(r, 409, 'SYSBUILD_STATE', '补标承诺后拆分的子项标仅供参考');
      assert.ok(r.body.message.includes('涉及承诺'), r.body.message);
    }
    await actOk(U.pm, ak[0].id, { action: 'unmark_commitment', reason: '取消' });
    const ur = await act(U.pm, ak[0].id, { action: 'for_reference' });
    expectErr(ur, 409, 'SYSBUILD_STATE', '子项取消后初始标记仍拦');
    assert.ok(ur.body.message.includes('登记时带'), ur.body.message);
    // ② PM 补标风险后拆 → 子项风险为真（初始列 is_risk = 1）
    const b = await regOk(U.pm, s.pid, { type: 'issue', item_ids: [s.i1.id, i2.id] });
    await actOk(U.pm, b.id, { action: 'mark_risk', reason: '补标风险' });
    await actOk(U.pm, b.id, { action: 'split', groups: G });
    for (const k of await kidsOf(b.id)) {
      assert.deepStrictEqual(await colsOf(k.id), [0, null, 1]);
      assert.strictEqual((await detail(U.pm, k.id)).risk_current, true);
    }
    // 初始带风险、PM 取消后拆（修订批 2 L-1）→ 子项保留初始 1，并追加一条 unmark_risk（随原登记取消，created_by = 执行拆分的 PM），子项当前风险为假
    const b2 = await regOk(U.m1, s.pid, { type: 'issue', is_risk: 1, item_ids: [s.i1.id, i2.id] });
    await actOk(U.pm, b2.id, { action: 'unmark_risk', reason: '解除' });
    await actOk(U.pm, b2.id, { action: 'split', groups: G });
    for (const k of await kidsOf(b2.id)) {
      assert.deepStrictEqual([(await colsOf(k.id))[2], (await detail(U.pm, k.id)).risk_current], [1, false], '初始带风险且已取消 → 子项初始 1、当前假');
      assert.deepStrictEqual((await sqlAll('SELECT action, text, created_by FROM sysbuild_entry_actions WHERE entry_id = ? ORDER BY id', [k.id])).map((r) => [r.action, r.text, r.created_by]), [['unmark_risk', '随原登记取消', U.pm]]);
    }
    // ③ 初始带承诺（来源 submitter）后被 PM 取消再拆（修订批 2 L-1）→ 子项保留初始 1 与原来源，并追加一条 unmark_commitment（随原登记取消，created_by = 执行拆分的 PM），
    //   子项当前值为假、仍受初始值约束（不能标仅供参考）
    const c = await regOk(U.m1, s.pid, { type: 'feedback', commitment_flag: 1, no_written_evidence: true, no_evidence_reason: R10, item_ids: [s.i1.id, i2.id] });
    await actOk(U.pm, c.id, { action: 'unmark_commitment', reason: '取消' });
    await actOk(U.pm, c.id, { action: 'split', groups: G });
    for (const k of await kidsOf(c.id)) {
      assert.deepStrictEqual(await colsOf(k.id), [1, 'submitter', 0]);
      assert.strictEqual((await detail(U.pm, k.id)).commitment_current, false);
      assert.deepStrictEqual((await sqlAll('SELECT action, text, created_by FROM sysbuild_entry_actions WHERE entry_id = ? ORDER BY id', [k.id])).map((r) => [r.action, r.text, r.created_by]), [['unmark_commitment', '随原登记取消', U.pm]]);
      const fr0 = await act(U.pm, k.id, { action: 'for_reference' });
      expectErr(fr0, 409, 'SYSBUILD_STATE', '初始带承诺的子项');
      assert.ok(fr0.body.message.includes('登记时带'), fr0.body.message);
    }
    // 对照：初始带承诺且当前仍有（PM 没取消）→ 子项不追加取消记录
    const c2 = await regOk(U.m1, s.pid, { type: 'feedback', commitment_flag: 1, no_written_evidence: true, no_evidence_reason: R10, item_ids: [s.i1.id, i2.id] });
    await actOk(U.pm, c2.id, { action: 'split', groups: G });
    for (const k of await kidsOf(c2.id)) assert.strictEqual((await sqlAll('SELECT id FROM sysbuild_entry_actions WHERE entry_id = ?', [k.id])).length, 0, '没取消就不追加记录');
    // ④ 对照：没有任何标记的登记拆分后子项也没有
    const d0 = await regOk(U.pm, s.pid, { type: 'feedback', item_ids: [s.i1.id, i2.id] });
    await actOk(U.pm, d0.id, { action: 'split', groups: G });
    for (const k of await kidsOf(d0.id)) assert.deepStrictEqual(await colsOf(k.id), [0, null, 0]);
  });

  test(`${T_MSPLIT}（容器去向）——预筛 L-1：手动拆分后的容器没有当前去向——不进待判定列表、详情 routing = null、awaiting_sys_iteration = false（旧快照仍保留作历史）；拆出的待判定子项照常列出`, async () => {
    const s = await mkPlan();
    const i4 = await s.outPlan();
    const i5 = await s.outPlan();
    const j1 = await s.mkInPlan(s.batch1);
    await golive(s.batch1, 'golive', '-1 hour');
    const ids = (r) => r.body.entries.map((x) => x.id);
    const base = `/sysbuild/projects/${s.pid}/entries?routing=pending`;
    // 待判定登记（规划外条目）拆分：容器离开待判定列表，子项进入
    const p = await regOk(U.pm, s.pid, { type: 'issue', item_ids: [i4.id, i5.id] });
    assert.deepStrictEqual(ids(await get(U.pm, base)), [p.id]);
    await actOk(U.pm, p.id, { action: 'split', groups: [[i4.id], [i5.id]] });
    const pk = await kidsOf(p.id);
    assert.deepStrictEqual(ids(await get(U.pm, base)), [pk[1].id, pk[0].id], '容器不列，两个待判定子项列出');
    const dp = await detail(U.pm, p.id);
    assert.deepStrictEqual([dp.routing, dp.awaiting_sys_iteration, dp.conclusion_state], [null, false, 'split_container']);
    assert.strictEqual((await snapsOf(p.id)).length, 1, '旧快照仍保留');
    assert.deepStrictEqual(dp.routing_snapshots.map((x) => x.route), ['pending'], '详情仍可查历史快照');
    // 待转系统迭代的登记拆分：容器不再是「待转系统迭代」
    const x = await regOk(U.pm, s.pid, { type: 'issue' });
    await actOk(U.pm, x.id, { action: 'assign_items', basis_category: 'in_plan', item_ids: [s.i1.id, j1.id], text: '已上线功能缺陷' });
    const dx = await detail(U.pm, x.id);
    assert.deepStrictEqual([dx.routing.route, dx.awaiting_sys_iteration], ['sys_iteration', true]);
    await actOk(U.pm, x.id, { action: 'split', groups: [[s.i1.id], [j1.id]] });
    const dx2 = await detail(U.pm, x.id);
    assert.deepStrictEqual([dx2.routing, dx2.awaiting_sys_iteration], [null, false]);
    for (const k of await kidsOf(x.id)) assert.deepStrictEqual([(await detail(U.pm, k.id)).routing.route, (await detail(U.pm, k.id)).awaiting_sys_iteration], ['sys_iteration', true]);
  });

  // ═══════════════════════ 5 待判定列表 ═══════════════════════
  test(`${T_PEND}——GET entries?routing=pending：当前去向为「尚未判定」且未结（没有有效结论、未作废）的登记；PM 看全量、其余成员只看自己登记的（admin 未接管 / 只读账号为空）；与 type / node 等筛选叠加；非法取值 400；已拆分容器不列、拆出的待判定子项列出`, async () => {
    const s = await mkPlan();
    const i4 = await s.outPlan();
    const nid = await nodeId(s.pid, 'b_dev');
    const a = await regOk(U.m1, s.pid, { type: 'feedback' });
    const b = await regOk(U.m2, s.pid, { type: 'issue', node_id: nid });
    const c = await regOk(U.pm, s.pid, { type: 'issue', item_ids: [i4.id] });
    const d = await regOk(U.pm, s.pid, { type: 'feedback', item_ids: [s.i1.id] }); // 留项目：不列
    const done = await regOk(U.pm, s.pid, { type: 'feedback' });
    await actOk(U.pm, done.id, CONCLUDE); // 待判定但已有有效结论：不列
    const voided = await regOk(U.pm, s.pid, { type: 'issue' });
    await actOk(U.pm, voided.id, { action: 'void', reason: '作废' }); // 已作废：不列
    const note = await regOk(U.pm, s.pid, { type: 'note' }); // 知悉类没有快照：不列
    const mix = await regOk(U.pm, s.pid, { type: 'issue', item_ids: [s.i1.id, i4.id] }); // 拆成 项目 + 待判定
    const mixKids = await kidsOf(mix.id);
    const base = `/sysbuild/projects/${s.pid}/entries?routing=pending`;
    const ids = (r) => r.body.entries.map((x) => x.id);
    const pendingKid = mixKids[1].id;
    assert.deepStrictEqual(ids(await get(U.pm, base)), [pendingKid, c.id, b.id, a.id], 'PM 看全量，最新在前；容器 / 留项目 / 已结 / 已作废 / 知悉类不列');
    assert.deepStrictEqual(ids(await get(U.m1, base)), [a.id], '成员只看自己登记的');
    assert.deepStrictEqual(ids(await get(U.m2, base)), [b.id]);
    assert.deepStrictEqual(ids(await get(U.cand, base)), [], '内部成员没有自己登记的待判定项');
    assert.deepStrictEqual(ids(await get(U.admin, base)), [], 'admin 未接管：只看自己登记的（没有）');
    assert.deepStrictEqual(ids(await get(U.ro, base)), [], '只读账号为空');
    assert.deepStrictEqual(ids(await get(U.pm, `${base}&type=issue`)), [pendingKid, c.id, b.id].filter((x) => x !== undefined), '与 type 叠加');
    assert.deepStrictEqual(ids(await get(U.pm, `${base}&node=${nid}`)), [b.id], '与 node 叠加');
    for (const q of ['routing=bogus', 'routing=project']) expectErr(await get(U.pm, `/sysbuild/projects/${s.pid}/entries?${q}`), 400, 'SYSBUILD_INVALID_INPUT', q);
    expectErr(await get(U.out, base), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    // 不带 routing 的列表不受影响（全部登记都在）
    assert.ok(ids(await get(U.pm, `/sysbuild/projects/${s.pid}/entries`)).includes(d.id));
    // 规划外归属之后离开待判定列表
    await actOk(U.pm, a.id, { action: 'assign_items', basis_category: 'out_of_plan', route: 'sys_iteration', text: '确属规划外' });
    assert.deepStrictEqual(ids(await get(U.pm, base)), [pendingKid, c.id, b.id]);
    // 读接口 routing 字段
    const dv = await detail(U.pm, a.id);
    assert.deepStrictEqual([dv.routing.route, dv.routing.basis_category], ['sys_iteration', 'out_of_plan']);
    assert.ok(note.id > 0);
  });

  // ═══════════════════════ 6 待判定归属 ═══════════════════════
  test(`${T_ASSIGN}——assign_items：规划内尚未细化（新条目 / 条目新版本，留项目，不要求总体包与上线事件）、已上线功能缺陷（关联已上线条目，转系统迭代，须有上线事件）、已生效规划内未上线（留项目，须有承诺批次）、规划外（不关联条目，选去向；留项目的结论只能转正式变更）；每次追加快照且触发动作 = 本动作；只有「尚未判定」的登记可归属；依据必填`, async () => {
    const s = await mkPlan();
    const i2 = await s.mkInPlan(s.batch2);
    const i3 = await s.mkInPlan(s.batch2);
    const i4 = await s.outPlan();
    const i5 = await s.outPlan();
    const gid = await golive(s.batch1, 'golive', '-1 hour');
    const mk = (extra) => regOk(U.pm, s.pid, Object.assign({ type: 'issue' }, extra || {}));
    const A = (body) => Object.assign({ action: 'assign_items', text: '判定依据说明' }, body);
    // 权限与前置
    const e0 = await mk();
    for (const uid of [U.m1, U.m2, U.ro, U.admin]) expectErr(await act(uid, e0.id, A({ basis_category: 'out_of_plan', route: 'sys_iteration' })), 403, 'SYSBUILD_FORBIDDEN', `用户 ${uid}`);
    expectErr(await act(U.out, e0.id, A({ basis_category: 'out_of_plan', route: 'sys_iteration' })), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    // 参数 400
    const bad = async (body, field, label) => {
      const r = await act(U.pm, e0.id, body);
      expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', label);
      assert.strictEqual(r.body.field, field, `${label}：field`);
    };
    await bad({ action: 'assign_items', basis_category: 'out_of_plan', route: 'sys_iteration' }, 'text', '缺依据');
    await bad({ action: 'assign_items', text: '依据' }, 'basis_category', '缺依据类别');
    await bad(A({ basis_category: 'bogus' }), 'basis_category', '依据类别越界');
    await bad(A({ basis_category: 'undetermined' }), 'basis_category', 'undetermined 不是人工选项');
    await bad(A({ basis_category: 'out_of_plan' }), 'route', '规划外缺去向');
    await bad(A({ basis_category: 'out_of_plan', route: 'pending' }), 'route', '规划外去向不能是 pending');
    await bad(A({ basis_category: 'out_of_plan', route: 'sys_iteration', item_ids: [i4.id] }), 'item_ids', '规划外不关联条目');
    await bad(A({ basis_category: 'planned_detail' }), 'item_ids', '待细化缺条目');
    await bad(A({ basis_category: 'planned_detail', item_ids: [i4.id], route: 'project' }), 'route', '待细化不带去向');
    await bad(A({ basis_category: 'in_plan' }), 'item_ids', '规划内缺条目');
    await bad(A({ basis_category: 'in_plan', item_ids: [s.i1.id], route: 'sys_iteration' }), 'route', '规划内不带去向');
    await bad(A({ basis_category: 'planned_detail', item_ids: [99999999] }), 'item_ids', '条目不存在');
    const otherScene = await mkPlan();
    const foreignItem = await otherScene.outPlan();
    await bad(A({ basis_category: 'planned_detail', item_ids: [foreignItem.id] }), 'item_ids', '别的项目的条目');
    await bad(A({ basis_category: 'in_plan', item_ids: [otherScene.i1.id] }), 'item_ids', '别的项目的规划内条目');
    await bad(A({ basis_category: 'planned_detail', item_ids: [i4.id], bogus: 1 }), 'bogus', '多余键');
    assert.strictEqual((await sqlAll('SELECT id FROM sysbuild_entry_actions WHERE entry_id = ?', [e0.id])).length, 0, '被拒的请求不留办理记录');
    assert.strictEqual((await snapsOf(e0.id)).length, 1, '被拒的请求不留快照');
    // ① 规划内尚未细化：新条目（不在规划里）→ 留项目，快照 planned_detail（不要求上线事件；总体包版本记当前生效版本）
    const e1 = await mk();
    const r1 = await actOk(U.pm, e1.id, A({ basis_category: 'planned_detail', item_ids: [i4.id] }));
    assert.deepStrictEqual(await snapRows(e1.id), [
      [1, null, null, null, null, null, 'pending', 'undetermined'],
      [1, s.eff.pv, i4.ver, null, null, r1.action_id, 'project', 'planned_detail'],
    ], '追加一行，首次判定的快照不改写');
    assert.deepStrictEqual(await itemRowsOf(e1.id), [[i4.id, i4.ver, r1.action_id]], '新关联的条目 assigned_by_action_id = 本动作');
    assert.deepStrictEqual([r1.entry.routing.route, r1.entry.routing.basis_category], ['project', 'planned_detail']);
    assert.strictEqual((await actOk(U.pm, e1.id, CONCLUDE)).entry.conclusion_state, 'settled_no_confirm', '归属后可以照常给结论');
    // 登记时已关联的条目再归属：同一条目同一版本不重复追加关联行（只追加判定快照）
    const e1d = await mk({ item_ids: [i5.id] });
    assert.deepStrictEqual(await itemRowsOf(e1d.id), [[i5.id, i5.ver, null]]);
    const r1d = await actOk(U.pm, e1d.id, A({ basis_category: 'planned_detail', item_ids: [i5.id] }));
    // codex 25 M2：归属把归属后的完整集合各写一行（assigned_by_action_id = 本动作），当前关联 = 最近一次归属的集合；登记时的关联行留作历史
    assert.deepStrictEqual(await itemRowsOf(e1d.id), [[i5.id, i5.ver, null], [i5.id, i5.ver, r1d.action_id]], '历史关联行保留，归属后的完整集合另写一行');
    const d1d = await detail(U.pm, e1d.id);
    assert.deepStrictEqual([d1d.items.map((x) => x.assigned_by_action_id), d1d.items_history.length], [[r1d.action_id], 2], 'items = 当前关联，items_history = 全部');
    assert.deepStrictEqual((await snapRows(e1d.id)).map((x) => x[7]), ['undetermined', 'planned_detail']);
    assert.ok(r1d.action_id > 0);
    // 条目新版本（在规划里的条目出了更新的版本）也算「新条目版本」
    const nv = await post(U.pm, `/sysbuild/items/${i2.id}/versions`, { content: '需求：新版本', no_written_evidence: true, no_evidence_reason: '口头电话确认了本次需求内容' });
    assert.strictEqual(nv.status, 201, nv.text);
    const e1b = await mk();
    const r1b = await actOk(U.pm, e1b.id, A({ basis_category: 'planned_detail', item_ids: [i2.id] }));
    assert.deepStrictEqual((await snapRows(e1b.id))[1], [1, s.eff.pv, nv.body.item_version_id, null, null, r1b.action_id, 'project', 'planned_detail'], '取条目最新版本');
    // 在规划里且最新版本就是现行版本的条目不是「新条目版本」→ 409
    const e1c = await mk();
    expectErr(await act(U.pm, e1c.id, A({ basis_category: 'planned_detail', item_ids: [i3.id] })), 409, 'SYSBUILD_STATE', '条目已是现行版本');
    // ② 已上线功能缺陷：关联已上线条目 → 转系统迭代；快照 in_plan，须有总体包版本 / 条目版本 / 上线事件
    const e2 = await mk();
    const r2 = await actOk(U.pm, e2.id, A({ basis_category: 'in_plan', item_ids: [s.i1.id] }));
    assert.deepStrictEqual((await snapRows(e2.id))[1], [1, s.eff.pv, s.i1.ver, s.batch1, gid, r2.action_id, 'sys_iteration', 'in_plan']);
    const c2 = await actOk(U.pm, e2.id, { action: 'conclude', conclusion_kind: 'to_sys_iteration', text: '已上线功能缺陷转系统迭代', sys_issue_no: 'SI-200', assignee_text: '外包张三' });
    assert.strictEqual(c2.entry.conclusion_state, 'settled_no_confirm');
    // ③ 已生效规划内、未上线（普通补选归属）：留项目，快照 in_plan，须有承诺批次
    const e3 = await mk();
    const r3 = await actOk(U.pm, e3.id, A({ basis_category: 'in_plan', item_ids: [i3.id] }));
    assert.deepStrictEqual((await snapRows(e3.id))[1], [1, s.eff.pv, i3.ver, s.batch2, null, r3.action_id, 'project', 'in_plan']);
    // 规划内的条目归类冲突 → 409：含规划外条目 / 已上线 + 未上线混放
    const e3b = await mk();
    expectErr(await act(U.pm, e3b.id, A({ basis_category: 'in_plan', item_ids: [i5.id] })), 409, 'SYSBUILD_STATE', '规划外条目按规划内归属');
    // codex 25 M3：混合去向（既有已上线又有未上线）→ 非子项登记在同一事务写关联并按去向自动拆成子登记（快照触发动作 = 本次归属动作）；本登记成为已拆分容器
    const e3c = await mk();
    const r3c = await actOk(U.pm, e3c.id, A({ basis_category: 'in_plan', item_ids: [s.i1.id, i3.id] }));
    assert.deepStrictEqual(r3c.children.map((c) => [c.part_no, c.route]), [[1, 'project'], [2, 'sys_iteration']]);
    assert.strictEqual(r3c.entry.conclusion_state, 'split_container');
    assert.deepStrictEqual(r3c.entry.items.map((x) => [x.item_id, x.assigned_by_action_id]), [[s.i1.id, r3c.action_id], [i3.id, r3c.action_id]], '容器保留归属后的完整集合');
    const k3c = await kidsOf(e3c.id);
    assert.deepStrictEqual(await snapRows(k3c[0].id), [[1, s.eff.pv, i3.ver, s.batch2, null, r3c.action_id, 'project', 'in_plan']]);
    assert.deepStrictEqual(await snapRows(k3c[1].id), [[2, s.eff.pv, s.i1.ver, s.batch1, gid, r3c.action_id, 'sys_iteration', 'in_plan']]);
    assert.deepStrictEqual(await itemRowsOf(k3c[1].id), [[s.i1.id, s.i1.ver, r3c.action_id]]);
    assert.deepStrictEqual(r3c.entry.routing, null, '容器没有当前去向');
    const sp3 = (await eventsOfType(s.pid, 'entry_split')).map((x) => JSON.parse(x.payload_json)).find((p) => p.via === 'assign');
    assert.deepStrictEqual([sp3.action_id, sp3.children.length], [r3c.action_id, 2]);
    // 补选到混合去向的自动拆分同样继承原登记的当前标记（PM 补标的涉及承诺 → 子项标志 1、来源 pm）
    const e3d = await mk();
    await actOk(U.pm, e3d.id, { action: 'mark_commitment', reason: '补标：涉及交付承诺' });
    const r3d = await actOk(U.pm, e3d.id, A({ basis_category: 'in_plan', item_ids: [s.i1.id, i3.id] }));
    for (const k of r3d.children) {
      const row = await sqlGet('SELECT commitment_flag, commitment_flag_source FROM sysbuild_entries WHERE id = ?', [k.entry_id]);
      assert.deepStrictEqual([row.commitment_flag, row.commitment_flag_source], [1, 'pm'], '子项继承补标的涉及承诺');
    }
    // 子项（拆出的待判定处理项）补选到混合去向：子项不能再拆分，409
    const mixSrc = await regOk(U.pm, s.pid, { type: 'issue', item_ids: [i3.id, (await s.outPlan()).id] });
    const pendKid2 = (await kidsOf(mixSrc.id))[1];
    assert.strictEqual((await detail(U.pm, pendKid2.id)).routing.route, 'pending', '前置：待判定子项');
    const ck = await act(U.pm, pendKid2.id, A({ basis_category: 'in_plan', item_ids: [s.i1.id, i3.id] }));
    expectErr(ck, 409, 'SYSBUILD_STATE', '子项补选到混合去向');
    // 预筛 3 轮 L（codex 25-R L）：提示改为「未上线部分请单独补选归属；已上线部分请到系统迭代受理渠道提单」，响应带 guide = sys_iteration 与已上线条目清单
    assert.strictEqual(ck.body.message, '未上线部分请单独补选归属；已上线部分请到系统迭代受理渠道提单');
    assert.strictEqual(ck.body.guide, 'sys_iteration');
    assert.deepStrictEqual(ck.body.live_items.map((x) => [x.item_id, x.batch_id]), [[s.i1.id, s.batch1]], '已上线条目清单：只列已上线的 i1，未上线的 i3 不列');
    assert.strictEqual((await kidsOf(pendKid2.id)).length, 0);
    // codex 25 H1：已给结论（待确认 / 有异议 / 裁定中）的登记不能补选归属，标志同源为假
    const h1 = await regOk(U.m1, s.pid, { type: 'feedback' });
    await actOk(U.pm, h1.id, CONCLUDE);
    for (const phase of ['pending_confirm', 'objected', 'escalated']) {
      if (phase === 'objected') assert.strictEqual((await openAndDecide(U.del, await lastConclusionTask(h1.id), 'object', { reason: '不同意' })).status, 200);
      if (phase === 'escalated') await actOk(U.pm, h1.id, { action: 'escalate' });
      assert.strictEqual(await stateOf(h1.id), phase);
      assert.strictEqual((await detail(U.pm, h1.id)).actions.assign_items, false, `${phase}：标志`);
      const hr = await act(U.pm, h1.id, A({ basis_category: 'out_of_plan', route: 'sys_iteration' }));
      expectErr(hr, 409, 'SYSBUILD_STATE', `${phase} 补选归属`);
      assert.ok(hr.body.message.includes('已给结论'), hr.body.message);
    }
    assert.strictEqual((await snapsOf(h1.id)).length, 1, '被拒不追加快照');
    const nullBatch = await s.mkInPlan(null);
    expectErr(await act(U.pm, e3b.id, A({ basis_category: 'in_plan', item_ids: [nullBatch.id] })), 409, 'SYSBUILD_STATE', '规划里没有承诺批次');
    // ④ 规划外：不关联条目，去向转系统迭代；快照 out_of_plan，没有条目与上线事件
    const e4 = await mk();
    const r4 = await actOk(U.pm, e4.id, A({ basis_category: 'out_of_plan', route: 'sys_iteration' }));
    assert.deepStrictEqual((await snapRows(e4.id))[1], [1, null, null, null, null, r4.action_id, 'sys_iteration', 'out_of_plan']);
    assert.strictEqual((await actOk(U.pm, e4.id, { action: 'conclude', conclusion_kind: 'to_sys_iteration', text: '规划外转系统迭代', sys_issue_no: 'SI-201', assignee_text: '外包李四' })).entry.conclusion_state, 'settled_no_confirm');
    // 规划外 + 留项目：结论只能是转正式变更（S-S1c 起开放，须带 change_id）；其余类别 409，conclude_kinds 只剩 to_change；作废仍可
    const e5 = await mk();
    await actOk(U.pm, e5.id, A({ basis_category: 'out_of_plan', route: 'project' }));
    const d5 = await detail(U.pm, e5.id);
    assert.deepStrictEqual([d5.routing.route, d5.routing.basis_category, d5.actions.conclude, d5.actions.conclude_kinds], ['project', 'out_of_plan', true, ['to_change']]);
    const c5 = await act(U.pm, e5.id, CONCLUDE);
    expectErr(c5, 409, 'SYSBUILD_STATE', '规划外留项目的 handled 结论');
    assert.ok(c5.body.message.includes('正式变更') && !c5.body.message.includes('S1c'), c5.body.message);
    const chg5 = await post(U.pm, `/sysbuild/projects/${s.pid}/changes`, { title: '规划外问题转变更', body: '新增一项规划外功能', no_written_evidence: true, no_evidence_reason: '口头电话确认了本次变更内容' });
    assert.strictEqual(chg5.status, 201, chg5.text);
    assert.strictEqual((await actOk(U.pm, e5.id, { action: 'void', reason: '作废' })).entry.conclusion_state, 'voided');
    const e5b = await mk();
    await actOk(U.pm, e5b.id, A({ basis_category: 'out_of_plan', route: 'project' }));
    const tc5 = await actOk(U.pm, e5b.id, { action: 'conclude', conclusion_kind: 'to_change', text: '转变更', change_id: chg5.body.change.id });
    assert.strictEqual(tc5.entry.current_conclusion.change_id, chg5.body.change.id, '规划外留项目的问题转正式变更：结论带变更号');
    // Q1：规划里条目的承诺批次已正式上线，它的新版本不能当作「规划内尚未细化」留项目（已上线条目的增强须建新条目）；批次未上线的条目出新版本可以（上面 e1b）
    const nv1 = await post(U.pm, `/sysbuild/items/${s.i1.id}/versions`, { content: '需求：增强', no_written_evidence: true, no_evidence_reason: '口头电话确认了本次需求内容' });
    assert.strictEqual(nv1.status, 201, nv1.text);
    const e6 = await mk();
    const q1 = await act(U.pm, e6.id, A({ basis_category: 'planned_detail', item_ids: [s.i1.id] }));
    expectErr(q1, 409, 'SYSBUILD_STATE', '已上线条目的新版本');
    assert.ok(q1.body.message.includes('新条目'), q1.body.message);
    assert.strictEqual((await snapsOf(e6.id)).length, 1, '被拒不追加快照');
    // Q4：已有有效结论的登记不再归属
    const e7 = await mk();
    await actOk(U.pm, e7.id, CONCLUDE);
    const q4 = await act(U.pm, e7.id, A({ basis_category: 'out_of_plan', route: 'sys_iteration' }));
    expectErr(q4, 409, 'SYSBUILD_STATE', '已有有效结论');
    assert.ok(q4.body.message.includes('已给结论'), q4.body.message);
    assert.strictEqual((await detail(U.pm, e7.id)).actions.assign_items, false);
    // M-3：规划外且留项目的不能用「仅供参考」绕开只能转正式变更
    const e8 = await regOk(U.pm, s.pid, { type: 'feedback' });
    await actOk(U.pm, e8.id, A({ basis_category: 'out_of_plan', route: 'project' }));
    const q3 = await act(U.pm, e8.id, { action: 'for_reference' });
    expectErr(q3, 409, 'SYSBUILD_STATE', '规划外留项目标仅供参考');
    assert.ok(q3.body.message.includes('正式变更'), q3.body.message);
    assert.strictEqual((await detail(U.pm, e8.id)).actions.for_reference, false);
    // 只有「尚未判定」的登记可归属：已有去向 / 已作废 / 容器 / 知悉类 → 409
    expectErr(await act(U.pm, e3.id, A({ basis_category: 'out_of_plan', route: 'project' })), 409, 'SYSBUILD_STATE', '已有去向');
    expectErr(await act(U.pm, e5.id, A({ basis_category: 'out_of_plan', route: 'project' })), 409, 'SYSBUILD_STATE', '已作废');
    const cont = await mk({ item_ids: [s.i1.id, i4.id] });
    expectErr(await act(U.pm, cont.id, A({ basis_category: 'out_of_plan', route: 'project' })), 409, 'SYSBUILD_STATE', '容器');
    const nt = await regOk(U.pm, s.pid, { type: 'note' });
    expectErr(await act(U.pm, nt.id, A({ basis_category: 'out_of_plan', route: 'project' })), 409, 'SYSBUILD_STATE', '知悉类');
    // 拆出的待判定子项可以归属；part_no 沿用子项自己的处理项序号
    const kids = await kidsOf(cont.id);
    const pendKid = kids[1];
    const rk = await actOk(U.pm, pendKid.id, A({ basis_category: 'planned_detail', item_ids: [i4.id] }));
    assert.deepStrictEqual((await snapRows(pendKid.id)).map((x) => x[0]), [2, 2], '处理项序号沿用');
    assert.ok(rk.action_id > 0);
    // 事件
    const ev = (await eventsOfType(s.pid, 'routing_assigned')).map((x) => JSON.parse(x.payload_json));
    assert.ok(ev.some((p) => p.basis_category === 'out_of_plan' && p.route === 'sys_iteration' && p.action_id === r4.action_id));
  });

  // ═══════════════════════ 7 节点收口前置 ═══════════════════════
  test(`${T_CLOSE}——本节点过程登记里办理类（意见与反馈、问题与处理）未作废且没有有效结论的阻塞收口（ENTRY_UNRESOLVED，带 entry_ids；读接口 close_blockers 与收口端点同一个函数）；待确认 / 有异议 / 裁定中 / 裁定未通过 / 仅供参考被异议都算未结；已确认 / 已确定 / 裁定通过 / 仅供参考 / 作废不阻塞；知悉类、补充登记、别的节点、项目整体的登记不阻塞；拆分子项按子项判`, async () => {
    const s = await mkPlan();
    const nid = await startNode(s.pid, 'b_dev');
    const other = await startNode(s.pid, 'b_req');
    const blockers = async () => (await planNode(s.pid, nid)).close_blockers;
    const entryBlock = async () => (await blockers()).filter((b) => b.code === 'ENTRY_UNRESOLVED');
    assert.deepStrictEqual(await blockers(), [], '没有登记：不阻塞');
    // 知悉类不阻塞
    for (const type of ['note', 'lesson', 'benefit']) await regOk(U.m1, s.pid, { type, node_id: nid });
    await regOk(U.m1, s.pid, { type: 'material', node_id: nid, attachment_ids: [await stageAtt(s.pid, U.m1, 'a')] });
    assert.deepStrictEqual(await blockers(), []);
    // 别的节点 / 项目整体的办理类登记不阻塞本节点
    await regOk(U.pm, s.pid, { type: 'issue', node_id: other });
    await regOk(U.pm, s.pid, { type: 'issue' });
    assert.deepStrictEqual(await blockers(), []);
    // 办理类未结阻塞：结构 + 读写同源
    const e1 = await regOk(U.pm, s.pid, { type: 'feedback', node_id: nid });
    const e2 = await regOk(U.m1, s.pid, { type: 'issue', node_id: nid });
    let b = await blockers();
    assert.strictEqual(b.length, 1);
    assert.deepStrictEqual([b[0].code, b[0].node_ids, b[0].entry_ids], ['ENTRY_UNRESOLVED', [nid], [e1.id, e2.id]]);
    assert.ok(b[0].message.includes('2 条'), b[0].message);
    const close1 = await post(U.pm, `/sysbuild/nodes/${nid}/close`);
    expectErr(close1, 409, 'SYSBUILD_CLOSE_BLOCKED', '有未结登记不能收口');
    assert.deepStrictEqual(close1.body.blockers, b, '读接口 close_blockers 与收口端点同一个函数');
    // 已确定（不需确认）→ 不再阻塞；仍待确认的继续阻塞
    await actOk(U.pm, e1.id, CONCLUDE);
    assert.deepStrictEqual((await entryBlock())[0].entry_ids, [e2.id]);
    // e2：待确认 → 阻塞；有异议 → 阻塞；改结论再确认 → 放行
    await actOk(U.pm, e2.id, CONCLUDE);
    assert.strictEqual(await stateOf(e2.id), 'pending_confirm');
    assert.deepStrictEqual((await entryBlock())[0].entry_ids, [e2.id], '待确认');
    assert.strictEqual((await openAndDecide(U.del, await lastConclusionTask(e2.id), 'object', { reason: '不同意' })).status, 200);
    assert.deepStrictEqual([await stateOf(e2.id), (await entryBlock())[0].entry_ids], ['objected', [e2.id]], '有异议');
    await actOk(U.pm, e2.id, { action: 'escalate' });
    assert.deepStrictEqual([await stateOf(e2.id), (await entryBlock())[0].entry_ids], ['escalated', [e2.id]], '裁定中');
    const adjTask = (await sqlAll("SELECT id FROM sysbuild_confirm_tasks WHERE object_type = 'adjudication' AND object_id = ?", [e2.id]))[0].id;
    assert.strictEqual((await openAndDecide(U.own, adjTask, 'reject', { reason: '不认可' })).status, 200);
    assert.deepStrictEqual([await stateOf(e2.id), (await entryBlock())[0].entry_ids], ['adjudication_rejected', [e2.id]], '裁定未通过');
    await actOk(U.pm, e2.id, CONCLUDE);
    assert.strictEqual((await openAndDecide(U.del, await lastConclusionTask(e2.id), 'confirm')).status, 200);
    assert.deepStrictEqual([await stateOf(e2.id), await entryBlock()], ['confirmed', []], '已确认放行');
    // 仅供参考：有效结论放行；被异议（回到办理）重新阻塞
    const e3 = await regOk(U.m1, s.pid, { type: 'feedback', node_id: nid });
    assert.deepStrictEqual((await entryBlock())[0].entry_ids, [e3.id]);
    await actOk(U.pm, e3.id, { action: 'for_reference' });
    assert.deepStrictEqual([await stateOf(e3.id), await entryBlock()], ['for_reference', []], '仅供参考 = 有效结论');
    const nid3 = (await sqlGet("SELECT id FROM sysbuild_notices WHERE ref_type = 'entry' AND ref_id = ?", [e3.id])).id;
    assert.strictEqual((await post(U.del, `/sysbuild/notices/${nid3}/object`, { reason: '不是无实质内容' })).status, 201);
    assert.deepStrictEqual([await stateOf(e3.id), (await entryBlock())[0].entry_ids], ['for_reference_objected', [e3.id]], '仅供参考被异议');
    await actOk(U.m1, e3.id, { action: 'void', reason: '作废' }); // 有未结异议时只有登记人本人（非 PM 代登）可作废（P94）
    assert.deepStrictEqual([await stateOf(e3.id), await entryBlock()], ['voided', []], '作废不阻塞');
    // 补充登记（节点曾收口时登记的）不阻塞：节点收口 → 登记 → 重开
    await closeNodeFx(nid, `${shift(today(), -2)} 09:00:00`);
    const sup = await regOk(U.pm, s.pid, { type: 'issue', node_id: nid });
    assert.strictEqual(sup.period, 'supplement');
    await reopenNodeFx(nid);
    assert.deepStrictEqual(await entryBlock(), [], '补充登记不阻塞');
    // 拆分：容器不列，子项按子项判
    const gid = await golive(s.batch1, 'golive', '-1 hour');
    const i4 = await s.outPlan();
    const m = await regOk(U.pm, s.pid, { type: 'issue', node_id: nid, item_ids: [s.i1.id, i4.id] });
    const mk = await kidsOf(m.id);
    assert.deepStrictEqual((await entryBlock())[0].entry_ids, mk.map((k) => k.id), '容器不列，子项各列');
    await actOk(U.pm, mk[0].id, { action: 'conclude', conclusion_kind: 'to_sys_iteration', text: '转迭代', sys_issue_no: 'SI-1', assignee_text: '外包张三' });
    assert.deepStrictEqual((await entryBlock())[0].entry_ids, [mk[1].id]);
    await actOk(U.pm, mk[1].id, { action: 'void', reason: '待判定子项作废' });
    assert.deepStrictEqual(await entryBlock(), []);
    // 全部放行后可以收口
    const closed = await post(U.pm, `/sysbuild/nodes/${nid}/close`);
    assert.strictEqual(closed.status, 200, closed.text);
    assert.strictEqual(closed.body.node.status, 'closed');
    assert.ok(gid > 0);
  });

  test(`${T_CLOSE}（纯函数）——plan.closeBlockers：facts 没带登记事实 → ENTRY_FACTS_MISSING（fail-closed）；带了未结清单 → 只列本节点的；项目整体（node_id 为空）的登记阻塞整体验收结项节点；有效结论判定只有 entries-core.entryResolved 一份`, async () => {
    const P = planMod();
    const E = T.getMods().entries;
    const node = (key, id) => ({ id, batch_id: null, template_key: key, status: 'in_progress', current_plan: { start: '2026-11-01', end: '2026-11-02' } });
    const n1 = node('b_dev', 11);
    const codes = (blk) => blk.map((x) => x.code);
    assert.ok(codes(P.closeBlockers(n1, [n1], {})).includes('ENTRY_FACTS_MISSING'), '没带登记事实');
    assert.ok(codes(P.closeBlockers(n1, [n1], undefined)).includes('ENTRY_FACTS_MISSING'));
    assert.ok(codes(P.closeBlockers(n1, [n1], { entryUnresolved: 'x' })).includes('ENTRY_FACTS_MISSING'), '不是数组');
    assert.deepStrictEqual(P.closeBlockers(n1, [n1], { entryUnresolved: [] }), [], '空清单：不阻塞');
    const mineOnly = P.closeBlockers(n1, [n1], { entryUnresolved: [{ id: 5, node_id: 11 }, { id: 6, node_id: 12 }, { id: 7, node_id: null }] });
    assert.deepStrictEqual(mineOnly.map((x) => [x.code, x.node_ids, x.entry_ids]), [['ENTRY_UNRESOLVED', [11], [5]]], '只列本节点的');
    const closing = node('p_closing', 21);
    const pc = P.closeBlockers(closing, [closing], { entryUnresolved: [{ id: 5, node_id: 11 }, { id: 7, node_id: null }, { id: 8, node_id: 21 }] });
    assert.deepStrictEqual(pc.filter((x) => x.code === 'ENTRY_UNRESOLVED').map((x) => x.entry_ids), [[7, 8]], '项目整体的登记阻塞整体验收结项');
    // 已结口径
    const d = (state, extra) => Object.assign({ voided: false, conclusion_state: state }, extra || {});
    for (const st of ['settled_no_confirm', 'confirmed', 'adjudicated', 'for_reference']) assert.strictEqual(E.entryResolved(d(st)), true, st);
    for (const st of ['none', 'pending_confirm', 'objected', 'escalated', 'adjudication_rejected', 'for_reference_objected', 'terminated_conclusion_lapsed', 'to_change_lapsed']) assert.strictEqual(E.entryResolved(d(st)), false, st);
    assert.strictEqual(E.entryResolved({ voided: true, conclusion_state: 'voided' }), true, '作废');
    assert.strictEqual(E.entryResolved(d('split_container', { split_resolved: true })), true);
    assert.strictEqual(E.entryResolved(d('split_container', { split_resolved: false })), false);
    assert.strictEqual(E.entryResolved(d('split_container')), false, 'split_resolved 缺失按未结');
    const cs = E.deriveContainerState({ voided: false, conclusion_state: 'none', commitment_current: false, risk_current: false }, [
      { entry: { id: 1 }, facts: { derived: d('confirmed') } }, { entry: { id: 2 }, facts: { derived: d('none') } },
    ]);
    assert.deepStrictEqual([cs.conclusion_state, cs.split_resolved, cs.split_children], ['split_container', false, [{ id: 1, conclusion_state: 'confirmed', resolved: true }, { id: 2, conclusion_state: 'none', resolved: false }]]);
    assert.strictEqual(E.deriveContainerState({ voided: false }, [{ entry: { id: 1 }, facts: { derived: d('confirmed') } }]).split_resolved, true);
  });

  // ═══════════════════════ 8 历史导入收口同核 ═══════════════════════
  test(`${T_HIST}——历史事实导入节点收口同样核「过程登记均有结论」：有未结的办理类过程登记 → 409 且文案带收口阻塞；办理完后可导入`, async () => {
    const s = await mkPlan();
    const nid = await nodeId(s.pid, 'b_dev');
    const e = await regOk(U.pm, s.pid, { type: 'issue', node_id: nid });
    const open = await post(U.pm, `/sysbuild/projects/${s.pid}/history-window`, { action: 'open', attachment_ids: [await stageAtt(s.pid, U.pm, 'e')] });
    assert.strictEqual(open.status, 200, open.text);
    const body = async () => ({
      fact_type: 'node_closed', object_id: nid, original_date: OK_DATE, actual_confirmer: '甲部张主任', identity_basis: '甲部现任负责人，当年的会议纪要', attachment_ids: [await stageAtt(s.pid, U.pm, 'f')],
    });
    const url = `/sysbuild/projects/${s.pid}/history-imports`;
    const r1 = await post(U.pm, url, await body());
    expectErr(r1, 409, 'SYSBUILD_STATE', '有未结登记');
    assert.ok(r1.body.message.includes('收口前置条件未满足') && r1.body.message.includes('过程登记'), r1.body.message);
    assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_nodes WHERE id = ?', [nid])).status, 'not_started', '被拒不改节点');
    await actOk(U.pm, e.id, CONCLUDE);
    const r2 = await post(U.pm, url, await body());
    assert.strictEqual(r2.status, 201, r2.text);
    assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_nodes WHERE id = ?', [nid])).status, 'closed');
  });

  // ═══════════════════════ 9 收口后异议 ═══════════════════════
  test(`${T_OBJ}——POST entries 带 objects_entry_id：对已有有效结论的登记提异议，服务端生成异议登记（不撤回原确认）：节点未收口 → 过程登记（进收口前置），已收口 → 补充登记（不重开节点，节点读接口 post_close_objections_open 计数）；谁能提（登记人 / 原结论确认人 / 来源方负责人或代表人 / 来源方为空时任一方成员）；非有效结论 / 容器 / 作废 / 非办理类 409；关联条目已上线 → 409 引导系统迭代`, async () => {
    const s = await mkPlan();
    const nid = await startNode(s.pid, 'b_dev');
    const i2 = await s.mkInPlan(s.batch2);
    // e：m1 登记（来源方甲部）→ PM 结论 → 代表人 del 确认；关联 i2（未上线）
    const e = await regOk(U.m1, s.pid, { type: 'feedback', node_id: nid, item_ids: [i2.id] });
    await actOk(U.pm, e.id, CONCLUDE);
    const t = await lastConclusionTask(e.id);
    // 结论待确认期间不能这样提异议（请在确认任务里提）
    expectErr(await reg(U.m1, s.pid, { objects_entry_id: e.id, body: '待确认期间' }), 409, 'SYSBUILD_STATE', '结论待确认');
    assert.strictEqual((await openAndDecide(U.del, t, 'confirm')).status, 200);
    assert.strictEqual(await stateOf(e.id), 'confirmed');
    const O = (extra) => Object.assign({ objects_entry_id: e.id, body: '对结论有异议：处理不彻底' }, extra || {});
    // 资格：m2 / cand / PM / admin / 只读 403，非成员 404；登记人 m1、确认人 del、来源方负责人 own 201
    for (const uid of [U.m2, U.cand, U.pm, U.admin, U.ro]) expectErr(await reg(uid, s.pid, O()), 403, 'SYSBUILD_FORBIDDEN', `用户 ${uid} 无资格`);
    expectErr(await reg(U.out, s.pid, O()), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE objects_entry_id = ?', [e.id]), 0, '被拒不留行');
    const o1 = await regOk(U.del, s.pid, O());
    // 节点未收口 → 过程登记；挂靠 / 条目沿用被异议的登记；来源方 = 提出人本方；类型缺省意见与反馈；标题缺省按被异议登记生成
    assert.deepStrictEqual([o1.objects_entry_id, o1.parent_entry_id, o1.node_id, o1.period, o1.days_after_close, o1.type, o1.purpose, o1.source_party_id, o1.operator_user_id],
      [e.id, null, nid, 'process', null, 'feedback', 'general', s.A, U.del]);
    assert.ok(o1.title.startsWith(`对第 ${e.id} 条登记的异议：`), o1.title);
    assert.strictEqual(o1.body, '对结论有异议：处理不彻底');
    assert.deepStrictEqual(o1.items.map((x) => x.item_id), [i2.id], '关联条目沿用');
    assert.deepStrictEqual(await snapRows(o1.id), [[1, s.eff.pv, i2.ver, s.batch2, null, null, 'project', 'in_plan']], '异议登记同样分流');
    assert.deepStrictEqual([o1.conclusion_state, o1.routing.route], ['none', 'project']);
    // 原登记不撤回确认
    const eAfter = await detail(U.pm, e.id);
    assert.deepStrictEqual([eAfter.conclusion_state, eAfter.current_conclusion.action_id], ['confirmed', (await sqlAll("SELECT id FROM sysbuild_entry_actions WHERE entry_id = ? AND action = 'conclude'", [e.id]))[0].id]);
    assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_confirm_task_revisions WHERE task_id = ?', [t])).status, 'confirmed');
    // 过程异议进入节点收口前置
    const bl = (await planNode(s.pid, nid)).close_blockers;
    assert.deepStrictEqual(bl.filter((x) => x.code === 'ENTRY_UNRESOLVED').map((x) => x.entry_ids), [[o1.id]], '过程异议登记必须办理');
    // 自定义类型 / 标题 / 附件
    const o2 = await regOk(U.m1, s.pid, O({ type: 'issue', title: '自拟标题', attachment_ids: [await stageAtt(s.pid, U.m1, 'a')] }));
    assert.deepStrictEqual([o2.type, o2.title, o2.attachments.length], ['issue', '自拟标题', 1]);
    const o3 = await regOk(U.own, s.pid, O());
    assert.deepStrictEqual([o3.source_party_id, o3.operator_user_id], [s.A, U.own]);
    // 请求体校验 400（键集合收窄、类型、必填、对象存在）
    const bad = async (extra, field, label, uid) => {
      const r = await reg(uid || U.m1, s.pid, O(extra));
      expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', label);
      assert.strictEqual(r.body.field, field, `${label}：field`);
    };
    await bad({ type: 'note' }, 'type', '类型必须是办理类');
    await bad({ node_id: nid }, 'node_id', '不能指定节点');
    await bad({ item_ids: [i2.id] }, 'item_ids', '不能指定条目');
    await bad({ source_party_id: s.A }, 'source_party_id', '不能指定来源方');
    await bad({ purpose: 'general' }, 'purpose', '不能指定用途');
    await bad({ commitment_flag: 1 }, 'commitment_flag', '不能指定承诺标记');
    await bad({ body: undefined }, 'body', '缺内容');
    await bad({ objects_entry_id: 'abc' }, 'objects_entry_id', '编号非法');
    await bad({ objects_entry_id: 99999999 }, 'objects_entry_id', '被异议的登记不存在');
    const foreign = await mkPlan();
    const fe = await regOk(U.pm, foreign.pid, { type: 'feedback' });
    await actOk(U.pm, fe.id, CONCLUDE);
    await bad({ objects_entry_id: fe.id }, 'objects_entry_id', '别的项目的登记');
    // 非有效结论 / 容器 / 作废 / 非办理类 → 409
    const none = await regOk(U.m1, s.pid, { type: 'feedback' });
    expectErr(await reg(U.m1, s.pid, { objects_entry_id: none.id, body: '无结论' }), 409, 'SYSBUILD_STATE', '无结论');
    const vd = await regOk(U.m1, s.pid, { type: 'feedback' });
    await actOk(U.m1, vd.id, { action: 'void', reason: '作废' });
    expectErr(await reg(U.m1, s.pid, { objects_entry_id: vd.id, body: '已作废' }), 409, 'SYSBUILD_STATE', '已作废');
    const nt = await regOk(U.m1, s.pid, { type: 'note' });
    expectErr(await reg(U.m1, s.pid, { objects_entry_id: nt.id, body: '知悉类' }), 409, 'SYSBUILD_STATE', '知悉类');
    const i4 = await s.outPlan();
    const cont = await regOk(U.m1, s.pid, { type: 'feedback', item_ids: [i2.id, i4.id] });
    assert.strictEqual(cont.conclusion_state, 'split_container');
    expectErr(await reg(U.m1, s.pid, { objects_entry_id: cont.id, body: '容器' }), 409, 'SYSBUILD_STATE', '容器');
    // 来源方为空（PM 本人登记的不需确认结论）：需求方 / 开发方的任一成员可提，内部成员不能；登记人（PM）本人也不能（预筛 3 轮 L：「原登记人」依据要求登记时身份非 PM）
    const pe = await regOk(U.pm, s.pid, { type: 'feedback', node_id: nid });
    await actOk(U.pm, pe.id, CONCLUDE);
    assert.strictEqual(await stateOf(pe.id), 'settled_no_confirm');
    const PO = (extra) => Object.assign({ objects_entry_id: pe.id, body: '需求方对 PM 自行给出的结论有异议' }, extra || {});
    expectErr(await reg(U.cand, s.pid, PO()), 403, 'SYSBUILD_FORBIDDEN', '内部成员无资格');
    expectErr(await reg(U.admin, s.pid, PO()), 403, 'SYSBUILD_FORBIDDEN', 'admin 无资格');
    const p1 = await regOk(U.m2, s.pid, PO());
    assert.deepStrictEqual([p1.source_party_id, p1.operator_user_id, p1.objects_entry_id], [s.A, U.m2, pe.id], '甲部一般成员可提');
    expectErr(await reg(U.pm, s.pid, PO()), 403, 'SYSBUILD_FORBIDDEN', '登记人（PM）本人：登记时身份是 PM，不算原登记人依据');
    assert.strictEqual((await detail(U.pm, pe.id)).actions.object, false, '读接口标志同源：PM 本人对自己登记的结论不能提异议');
    // 节点已收口 → 补充登记（不重开节点）；节点读接口计数；办理完（PM 结论 + 代表人确认）后计数归零
    await closeNodeFx(nid, `${shift(today(), -2)} 09:00:00`);
    const before = (await planNode(s.pid, nid)).post_close_objections_open;
    assert.strictEqual(before, 0, '没有收口后的异议登记');
    const s1 = await regOk(U.m1, s.pid, O());
    assert.deepStrictEqual([s1.period, s1.days_after_close, s1.node_id, s1.objects_entry_id, s1.source_party_id], ['supplement', 2, nid, e.id, s.A], '节点已收口 → 补充登记');
    const s2 = await regOk(U.m2, s.pid, PO());
    assert.strictEqual(s2.period, 'supplement');
    const nodeView = await planNode(s.pid, nid);
    assert.deepStrictEqual([nodeView.status, nodeView.post_close_objections_open], ['closed', 2], '不重开节点，计数收口后未结异议');
    assert.deepStrictEqual(nodeView.close_blockers, [], '已收口节点没有收口阻塞项');
    await actOk(U.pm, s2.id, CONCLUDE); // 来源方甲部 → 代表人确认
    assert.strictEqual((await planNode(s.pid, nid)).post_close_objections_open, 2, '结论待确认仍算未结');
    assert.strictEqual((await openAndDecide(U.del, await lastConclusionTask(s2.id), 'confirm')).status, 200);
    assert.strictEqual((await planNode(s.pid, nid)).post_close_objections_open, 1);
    await actOk(U.m1, s1.id, { action: 'void', reason: '撤回这条异议' });
    assert.strictEqual((await planNode(s.pid, nid)).post_close_objections_open, 0, '作废也算结');
    // 项目已终止仍可提异议（既有登记的异议四态都允许，resolve 类）
    assert.strictEqual((await post(U.admin, `/sysbuild/projects/${s.pid}/status`, { to: 'terminated', reason: 'C5 用例' })).status, 200);
    const tr = await regOk(U.m1, s.pid, O());
    assert.strictEqual(tr.objects_entry_id, e.id, '已终止项目：既有登记的异议照常');
    // 关联条目所在批次已上线 → 409 引导系统迭代；PM 在原登记上追加 link_sys_issue 记单号
    const s2p = await mkPlan();
    const nid2 = await startNode(s2p.pid, 'b_dev');
    const j = await regOk(U.m1, s2p.pid, { type: 'feedback', node_id: nid2, item_ids: [s2p.i1.id] });
    await actOk(U.pm, j.id, CONCLUDE);
    assert.strictEqual((await openAndDecide(U.del, await lastConclusionTask(j.id), 'confirm')).status, 200);
    await golive(s2p.batch1, 'golive', '-1 hour');
    const rj = await reg(U.m1, s2p.pid, { objects_entry_id: j.id, body: '上线后才发现问题' });
    expectErr(rj, 409, 'SYSBUILD_STATE', '关联条目已上线');
    assert.strictEqual(rj.body.guide, 'sys_iteration');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE objects_entry_id = ?', [j.id]), 0);
    const lk = await actOk(U.pm, j.id, { action: 'link_sys_issue', sys_issue_no: 'SI-300', text: '上线后问题转系统迭代' });
    assert.deepStrictEqual([lk.entry.conclusion_state, lk.entry.records.filter((x) => x.action === 'link_sys_issue').map((x) => x.sys_issue_no)], ['confirmed', ['SI-300']]);
    // 原结论的确认人在代表人更换后不再是来源方的代表人，仍可对自己确认过的结论提异议（依据 = 原结论确认人）；同方一般成员仍不行
    const cs = await mkPlan();
    const cn = await startNode(cs.pid, 'b_dev');
    const ce = await regOk(U.m1, cs.pid, { type: 'feedback', node_id: cn });
    await actOk(U.pm, ce.id, CONCLUDE);
    assert.strictEqual((await openAndDecide(U.del, await lastConclusionTask(ce.id), 'confirm')).status, 200);
    await sqlRun("UPDATE sysbuild_delegations SET status = 'revoked', revoked_at = datetime('now','localtime'), revoke_reason = '更换代表人' WHERE party_id = ? AND status = 'active'", [cs.A]);
    const CO = { objects_entry_id: ce.id, body: '代表人更换后仍有异议' };
    expectErr(await reg(U.m2, cs.pid, CO), 403, 'SYSBUILD_FORBIDDEN', '同方一般成员');
    const co = await regOk(U.del, cs.pid, CO);
    assert.deepStrictEqual([co.operator_user_id, co.objects_entry_id], [U.del, ce.id], '原确认人（已不是代表人）仍可提');
    // Q3：仅供参考的登记只有「对知会提异议」一个入口，objects_entry_id 路径 409（节点收口前后都如此）；标志同源为假
    const qs = await mkPlan();
    const qn = await startNode(qs.pid, 'b_dev');
    const fr = await regOk(U.m1, qs.pid, { type: 'feedback', node_id: qn });
    await actOk(U.pm, fr.id, { action: 'for_reference' });
    for (const phase of ['节点未收口', '节点已收口']) {
      if (phase === '节点已收口') await closeNodeFx(qn, `${shift(today(), -2)} 09:00:00`);
      const r = await reg(U.m1, qs.pid, { objects_entry_id: fr.id, body: '对仅供参考提异议' });
      expectErr(r, 409, 'SYSBUILD_STATE', `仅供参考 × ${phase}`);
      assert.ok(r.body.message.includes('对知会提异议'), r.body.message);
      assert.strictEqual((await detail(U.m1, fr.id)).actions.object, false, `${phase}：标志`);
    }
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE objects_entry_id = ?', [fr.id]), 0);
    // 修订批 2 M-1：没有仅供参考知会的登记（PM 本人 / 内部成员登记，不需确认、没有接收人）没有知会可异议，改走 objects_entry_id：甲部一般成员 m1 的 actions.object 为真；
    //   节点未收口 → 过程异议登记，已收口 → 补充异议登记；原登记保持仅供参考
    const rs = await mkPlan();
    const rn = await startNode(rs.pid, 'b_dev');
    const pmRef = await regOk(U.pm, rs.pid, { type: 'feedback', node_id: rn });
    const intRef = await regOk(U.cand, rs.pid, { type: 'feedback', node_id: rn });
    for (const e of [pmRef, intRef]) {
      await actOk(U.pm, e.id, { action: 'for_reference' });
      assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_notices WHERE ref_type = 'entry' AND ref_id = ?", [e.id]), 0, '前置：没有知会');
      assert.strictEqual(await stateOf(e.id), 'for_reference');
      assert.strictEqual((await detail(U.m1, e.id)).actions.object, true, '无知会的仅供参考：actions.object 为真');
      const o = await regOk(U.m1, rs.pid, { objects_entry_id: e.id, body: '对仅供参考有异议' });
      assert.deepStrictEqual([o.objects_entry_id, o.period, o.node_id, o.source_party_id, o.operator_user_id], [e.id, 'process', rn, rs.A, U.m1], '节点未收口 → 过程异议登记');
      assert.strictEqual(await stateOf(e.id), 'for_reference', '原登记保持仅供参考');
    }
    await closeNodeFx(rn, `${shift(today(), -2)} 09:00:00`);
    for (const e of [pmRef, intRef]) {
      const o = await regOk(U.m1, rs.pid, { objects_entry_id: e.id, body: '收口后对仅供参考有异议' });
      assert.deepStrictEqual([o.period, o.days_after_close, o.objects_entry_id], ['supplement', 2, e.id], '节点已收口 → 补充异议登记');
    }
    assert.strictEqual((await planNode(rs.pid, rn)).post_close_objections_open, 2, '收口后两条未结异议');
    // L-2：关联条目全部已上线 → actions.object 为假、执行 409（带 guide）；上线前为真
    const ls = await mkPlan();
    const ln = await startNode(ls.pid, 'b_dev');
    const le = await regOk(U.pm, ls.pid, { type: 'feedback', node_id: ln, item_ids: [ls.i1.id] });
    await actOk(U.pm, le.id, CONCLUDE);
    // 预筛 3 轮 L：PM 代登 / 自登的登记，PM 本人不算「原登记人」，提异议的是来源方为空时的需求方成员（party_member，甲部成员 m1）
    assert.strictEqual((await detail(U.m1, le.id)).actions.object, true, '上线前');
    await golive(ls.batch1, 'golive', '-1 hour');
    assert.strictEqual((await detail(U.m1, le.id)).actions.object, false, '关联条目全部已上线');
    const lr = await reg(U.m1, ls.pid, { objects_entry_id: le.id, body: '上线后异议' });
    expectErr(lr, 409, 'SYSBUILD_STATE', '关联条目已上线');
    assert.strictEqual(lr.body.guide, 'sys_iteration');
    // 部分已上线（另有未上线条目）的登记会被自动拆分，容器不能提异议；子项各自判断：未上线的子项仍可
    const li2 = await ls.mkInPlan(ls.batch2);
    const lm = await regOk(U.pm, ls.pid, { type: 'feedback', node_id: ln, item_ids: [ls.i1.id, li2.id] });
    const lmk = await kidsOf(lm.id);
    for (const k of lmk) await actOk(U.pm, k.id, k === lmk[0] ? CONCLUDE : { action: 'conclude', conclusion_kind: 'to_sys_iteration', text: '转迭代', sys_issue_no: 'SI-5', assignee_text: '外包张三' });
    assert.deepStrictEqual([(await detail(U.m1, lmk[0].id)).actions.object, (await detail(U.m1, lmk[1].id)).actions.object], [true, false], '未上线的子项可提，已上线的子项不可');
    // L-2：节点已取消 → 标志为假、执行 409
    const cs2 = await mkPlan();
    const cnode = await nodeId(cs2.pid, 'b_dev');
    const ce2 = await regOk(U.pm, cs2.pid, { type: 'feedback', node_id: cnode });
    await actOk(U.pm, ce2.id, CONCLUDE);
    assert.strictEqual((await detail(U.m1, ce2.id)).actions.object, true, '节点取消前');
    assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${cnode}/cancel`, { reason: '用例：取消节点' })).status, 200);
    assert.strictEqual((await detail(U.m1, ce2.id)).actions.object, false, '节点已取消');
    expectErr(await reg(U.m1, cs2.pid, { objects_entry_id: ce2.id, body: '节点取消后异议' }), 409, 'SYSBUILD_STATE', '节点已取消');
    // codex 25 M4：「原结论确认人」资格只认当前有效结论的确认修订：旧结论（有异议后被新结论替换）的确认人，换授权后不再有资格
    const ms = await mkPlan();
    const mn = await startNode(ms.pid, 'b_dev');
    const me = await regOk(U.m1, ms.pid, { type: 'feedback', node_id: mn });
    await actOk(U.pm, me.id, CONCLUDE);
    assert.strictEqual((await openAndDecide(U.del, await lastConclusionTask(me.id), 'object', { reason: '不同意' })).status, 200);
    await sqlRun("UPDATE sysbuild_delegations SET status = 'revoked', revoked_at = datetime('now','localtime'), revoke_reason = '更换代表人' WHERE party_id = ? AND status = 'active'", [ms.A]);
    const mApt = (await sqlGet("SELECT id FROM sysbuild_appointments WHERE party_id = ? AND status = 'active'", [ms.A])).id;
    const mDlg = await addDelegation(ms.A, ms.mM2, mApt, 'active');
    await actOk(U.pm, me.id, { action: 'conclude', conclusion_kind: 'adopted', text: '改结论，采纳' }); // 新结论由新代表人 m2 确认
    assert.strictEqual((await openAndDecide(U.m2, await lastConclusionTask(me.id), 'confirm')).status, 200);
    assert.strictEqual(await stateOf(me.id), 'confirmed');
    const MO = { objects_entry_id: me.id, body: '确认后仍有异议' };
    assert.strictEqual((await detail(U.del, me.id)).actions.object, false, '旧结论的确认人（有异议那次）：标志为假');
    expectErr(await reg(U.del, ms.pid, MO), 403, 'SYSBUILD_FORBIDDEN', '旧结论的确认人已不是代表人');
    // m2 之后也被换掉（授权撤销）：他仍是当前有效结论的确认人 → 有资格（依据 = 确认人，不靠现任代表人身份）
    await sqlRun("UPDATE sysbuild_delegations SET status = 'revoked', revoked_at = datetime('now','localtime'), revoke_reason = '再次更换' WHERE id = ?", [mDlg]);
    assert.strictEqual((await detail(U.m2, me.id)).actions.object, true, '当前有效结论的确认人');
    const mo = await regOk(U.m2, ms.pid, MO);
    assert.deepStrictEqual([mo.operator_user_id, mo.objects_entry_id], [U.m2, me.id]);
    expectErr(await reg(U.del, ms.pid, MO), 403, 'SYSBUILD_FORBIDDEN', '旧确认人仍无资格');
    // 裁定通过：当前结论的修订是「有异议」，异议人（del）不能因此成为确认人；裁定任务的确认人（负责人 own）才是——即使他的任职已结束，仍有资格（依据 = 确认人）
    const as2 = await mkPlan();
    const an2 = await startNode(as2.pid, 'b_dev');
    const ae = await regOk(U.m1, as2.pid, { type: 'feedback', node_id: an2 });
    await actOk(U.pm, ae.id, CONCLUDE);
    assert.strictEqual((await openAndDecide(U.del, await lastConclusionTask(ae.id), 'object', { reason: '不同意' })).status, 200);
    await actOk(U.pm, ae.id, { action: 'escalate' });
    const adjTask = (await sqlAll("SELECT id FROM sysbuild_confirm_tasks WHERE object_type = 'adjudication' AND object_id = ?", [ae.id]))[0].id;
    assert.strictEqual((await openAndDecide(U.own, adjTask, 'confirm')).status, 200);
    assert.strictEqual(await stateOf(ae.id), 'adjudicated');
    await sqlRun("UPDATE sysbuild_delegations SET status = 'revoked', revoked_at = datetime('now','localtime'), revoke_reason = '更换代表人' WHERE party_id = ? AND status = 'active'", [as2.A]);
    await sqlRun("UPDATE sysbuild_appointments SET status = 'ended', ended_at = datetime('now','localtime'), end_reason = '换人' WHERE party_id = ? AND status = 'active'", [as2.A]);
    const AO = { objects_entry_id: ae.id, body: '裁定后仍有异议' };
    assert.deepStrictEqual([(await detail(U.del, ae.id)).actions.object, (await detail(U.own, ae.id)).actions.object], [false, true], '有异议的修订不是确认；裁定的确认人是');
    expectErr(await reg(U.del, as2.pid, AO), 403, 'SYSBUILD_FORBIDDEN', '当前结论修订是有异议的人');
    const ao = await regOk(U.own, as2.pid, AO);
    assert.strictEqual(ao.operator_user_id, U.own);
  });

  // ═══════════════════════ 9b 当前关联 ═══════════════════════
  test(`${T_ASSIGN}（当前关联）——codex 25 M2：补选归属只追加关联行，拆分 / 提异议 / 关联条目数都用「当前关联」（最近一次归属写下的完整集合，规划外归属 = 空集），被替代的历史关联留在 items_history`, async () => {
    const s = await mkPlan();
    const nid = await startNode(s.pid, 'b_dev');
    const i2 = await s.mkInPlan(s.batch2);
    const i3 = await s.mkInPlan(s.batch2);
    const outA = await s.outPlan();
    const outB = await s.outPlan();
    await golive(s.batch1, 'golive', '-1 hour');
    const A = (body) => Object.assign({ action: 'assign_items', text: '判定依据说明' }, body);
    // ① 原关联规划外条目，归属到已上线条目：当前关联 = 已上线条目；提异议按「全部已上线」判（标志为假，执行 409 带 guide）；条目数按当前 1 个（不能拆）
    const a = await regOk(U.pm, s.pid, { type: 'issue', node_id: nid, item_ids: [outA.id, outB.id] });
    assert.strictEqual(a.items.length, 2);
    const ra = await actOk(U.pm, a.id, A({ basis_category: 'in_plan', item_ids: [s.i1.id] }));
    assert.deepStrictEqual([ra.entry.items.map((x) => x.item_id), ra.entry.items_history.map((x) => x.item_id)], [[s.i1.id], [outA.id, outB.id, s.i1.id]], '当前关联只剩已上线条目，历史关联保留');
    assert.deepStrictEqual(await itemRowsOf(a.id), [[outA.id, outA.ver, null], [outB.id, outB.ver, null], [s.i1.id, s.i1.ver, ra.action_id]]);
    assert.strictEqual(ra.entry.actions.split, false, '当前关联只有 1 个条目：不能拆（不按历史的 3 行算）');
    await actOk(U.pm, a.id, { action: 'conclude', conclusion_kind: 'to_sys_iteration', text: '转迭代', sys_issue_no: 'SI-8', assignee_text: '外包张三' });
    assert.strictEqual((await detail(U.m1, a.id)).actions.object, false, '当前关联全部已上线（历史里的规划外条目不算）');
    const ro = await reg(U.m1, s.pid, { objects_entry_id: a.id, body: '异议' }); // 来源方为空（PM 登记）：甲部成员有资格（party_member）；PM 本人没有
    expectErr(ro, 409, 'SYSBUILD_STATE', '提异议按当前关联判已上线');
    assert.strictEqual(ro.body.guide, 'sys_iteration');
    // ② 规划外归属：当前关联为空集，历史关联保留
    const b = await regOk(U.pm, s.pid, { type: 'issue', node_id: nid, item_ids: [outA.id, outB.id] });
    const rb = await actOk(U.pm, b.id, A({ basis_category: 'out_of_plan', route: 'project' }));
    assert.deepStrictEqual([rb.entry.items.length, rb.entry.items_history.length, rb.entry.actions.split], [0, 2, false]);
    // ③ 归属后手动拆分按当前关联：登记时关联规划外两个条目，归属到规划内两个未上线条目后，可按这两个条目拆分
    const c = await regOk(U.pm, s.pid, { type: 'issue', node_id: nid, item_ids: [outA.id, outB.id] });
    await actOk(U.pm, c.id, A({ basis_category: 'in_plan', item_ids: [i2.id, i3.id] }));
    assert.strictEqual((await detail(U.pm, c.id)).actions.split, true, '当前关联 2 个条目');
    const rc = await actOk(U.pm, c.id, { action: 'split', groups: [[i2.id], [i3.id]] });
    assert.deepStrictEqual(rc.children.map((k) => k.route), ['project', 'project']);
    assert.deepStrictEqual(await itemRowsOf(rc.children[0].entry_id), [[i2.id, i2.ver, rc.action_id]]);
    const badSplit = await regOk(U.pm, s.pid, { type: 'issue', node_id: nid, item_ids: [outA.id, outB.id] });
    await actOk(U.pm, badSplit.id, A({ basis_category: 'in_plan', item_ids: [i2.id, i3.id] }));
    const sr = await act(U.pm, badSplit.id, { action: 'split', groups: [[outA.id], [outB.id]] });
    expectErr(sr, 400, 'SYSBUILD_INVALID_INPUT', '历史关联的条目不能再作为拆分分组');
  });

  // ═══════════════════════ 10 知会异议 ═══════════════════════
  test(`${T_NOTICE}——仅供参考知会的异议：节点未收口 → 原登记回到办理（mode = return_to_handling，同 S-S1a）；节点已收口 → 不拉回办理，生成异议补充登记（mode = supplement_entry，原登记保持仅供参考，不算「曾被异议」）；同一知会至多一次；关联条目已上线 → 整笔 409`, async () => {
    const s = await mkPlan();
    const nid = await startNode(s.pid, 'b_dev');
    const i2 = await s.mkInPlan(s.batch2);
    // 节点未收口：S-S1a 行为
    const f1 = await regOk(U.m1, s.pid, { type: 'feedback', node_id: nid });
    await actOk(U.pm, f1.id, { action: 'for_reference' });
    const n1 = (await sqlGet("SELECT id FROM sysbuild_notices WHERE ref_type = 'entry' AND ref_id = ?", [f1.id])).id;
    const r1 = await post(U.del, `/sysbuild/notices/${n1}/object`, { reason: '不是无实质内容' });
    assert.strictEqual(r1.status, 201, r1.text);
    assert.deepStrictEqual([r1.body.mode, r1.body.objection_entry_id, r1.body.entry.conclusion_state, r1.body.notice.objection.mode], ['return_to_handling', null, 'for_reference_objected', 'return_to_handling']);
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE objects_entry_id = ?', [f1.id]), 0, '未收口：不生成异议登记');
    // 节点已收口：生成异议补充登记，原登记保持仅供参考
    const f2 = await regOk(U.m1, s.pid, { type: 'feedback', node_id: nid, item_ids: [i2.id] });
    await actOk(U.pm, f2.id, { action: 'for_reference' });
    const n2 = (await sqlGet("SELECT id FROM sysbuild_notices WHERE ref_type = 'entry' AND ref_id = ?", [f2.id])).id;
    await closeNodeFx(nid, `${shift(today(), -2)} 09:00:00`);
    const r2 = await post(U.del, `/sysbuild/notices/${n2}/object`, { reason: '这条意见有实质内容，请处理' });
    assert.strictEqual(r2.status, 201, r2.text);
    assert.deepStrictEqual([r2.body.mode, r2.body.entry.conclusion_state, r2.body.notice.objection.mode, r2.body.notice.objection.objection_entry_id === r2.body.objection_entry_id], ['supplement_entry', 'for_reference', 'supplement_entry', true]);
    const oe = await detail(U.pm, r2.body.objection_entry_id);
    assert.deepStrictEqual([oe.objects_entry_id, oe.period, oe.days_after_close, oe.node_id, oe.type, oe.body, oe.source_party_id, oe.operator_user_id, oe.conclusion_state],
      [f2.id, 'supplement', 2, nid, 'feedback', '这条意见有实质内容，请处理', s.A, U.del, 'none']);
    assert.ok(oe.title.startsWith(`对第 ${f2.id} 条仅供参考登记的异议：`), oe.title);
    assert.deepStrictEqual(await snapRows(oe.id), [[1, s.eff.pv, i2.ver, s.batch2, null, null, 'project', 'in_plan']], '异议登记分流');
    const f2d = await detail(U.pm, f2.id);
    assert.deepStrictEqual([f2d.conclusion_state, f2d.actions.conclude, f2d.actions.for_reference], ['for_reference', false, false], '原登记保持仅供参考，不回到办理');
    assert.strictEqual((await planNode(s.pid, nid)).post_close_objections_open, 1);
    // 重复异议 409；知会视图带 mode
    expectErr(await post(U.del, `/sysbuild/notices/${n2}/object`, { reason: '再来一次' }), 409, 'SYSBUILD_STATE', '同一知会只能异议一次');
    const mine = (await get(U.del, '/sysbuild/my/notices')).body.items.find((x) => x.id === n2);
    assert.deepStrictEqual([mine.objected, mine.objection.mode, mine.objection.objection_entry_id], [true, 'supplement_entry', oe.id]);
    // 办理异议登记：PM 结论 + 代表人确认后计数归零
    await actOk(U.pm, oe.id, CONCLUDE);
    assert.strictEqual((await openAndDecide(U.del, await lastConclusionTask(oe.id), 'confirm')).status, 200);
    assert.strictEqual((await planNode(s.pid, nid)).post_close_objections_open, 0);
    // 来源方负责人也能对知会提异议，同样生成补充登记，来源方 = 提出人本方
    const f3 = await regOk(U.m2, s.pid, { type: 'feedback', node_id: nid });
    await actOk(U.pm, f3.id, { action: 'for_reference' });
    const n3 = (await sqlGet("SELECT id FROM sysbuild_notices WHERE ref_type = 'entry' AND ref_id = ?", [f3.id])).id;
    const r3 = await post(U.own, `/sysbuild/notices/${n3}/object`, { reason: '负责人认为需要处理' });
    assert.deepStrictEqual([r3.status, r3.body.mode], [201, 'supplement_entry']);
    assert.strictEqual((await detail(U.pm, r3.body.objection_entry_id)).operator_user_id, U.own);
    // 关联条目所在批次已上线：整笔 409（不记异议，原登记不变）
    const f4 = await regOk(U.m1, s.pid, { type: 'feedback', node_id: nid, item_ids: [s.i1.id] });
    // f4 登记时 i1 未上线（节点已收口所以是补充登记），PM 标仅供参考后，批次上线，再提异议
    await actOk(U.pm, f4.id, { action: 'for_reference' });
    const n4 = (await sqlGet("SELECT id FROM sysbuild_notices WHERE ref_type = 'entry' AND ref_id = ?", [f4.id])).id;
    await golive(s.batch1, 'golive', '-1 hour');
    const r4 = await post(U.del, `/sysbuild/notices/${n4}/object`, { reason: '上线后才发现' });
    expectErr(r4, 409, 'SYSBUILD_STATE', '关联条目已上线');
    assert.strictEqual(r4.body.guide, 'sys_iteration');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_notice_objections WHERE notice_id = ?', [n4]), 0, '不记异议');
    assert.strictEqual((await stateOf(f4.id)), 'for_reference');
    // codex 25 M1：有仅供参考知会的登记不经 objects_entry_id，所以知会异议的资格 = 接收人，或原登记人 / 当前结论确认人 / 来源方现任负责人或代表人；/my/notices 列出范围同步扩大
    const ns = await mkPlan();
    const nn = await startNode(ns.pid, 'b_dev');
    const refOf = async (e) => { await actOk(U.pm, e.id, { action: 'for_reference' }); return (await sqlGet("SELECT id FROM sysbuild_notices WHERE ref_type = 'entry' AND ref_id = ?", [e.id])).id; };
    const myNotice = async (uid, nid) => (await get(uid, '/sysbuild/my/notices')).body.items.find((x) => x.id === nid);
    // ① 普通原登记人：不是接收人（接收人是代表人 del）、不是负责人，也有入口
    const g1 = await regOk(U.m1, ns.pid, { type: 'feedback', node_id: nn });
    const gn1 = await refOf(g1);
    const lm1 = await myNotice(U.m1, gn1);
    assert.deepStrictEqual([lm1.as, lm1.actions.object], ['registrant', true], '原登记人的 /my/notices：as = registrant，可异议');
    assert.strictEqual(await myNotice(U.m2, gn1), undefined, '同方一般成员的 /my/notices 没有');
    expectErr(await post(U.m2, `/sysbuild/notices/${gn1}/object`, { reason: '无关成员' }), 403, 'SYSBUILD_FORBIDDEN', '无关成员');
    expectErr(await post(U.cand, `/sysbuild/notices/${gn1}/object`, { reason: '内部成员' }), 403, 'SYSBUILD_FORBIDDEN', '内部成员');
    const rg1 = await post(U.m1, `/sysbuild/notices/${gn1}/object`, { reason: '我提的意见不是无实质内容' });
    assert.deepStrictEqual([rg1.status, rg1.body.mode, rg1.body.entry.conclusion_state], [201, 'return_to_handling', 'for_reference_objected']);
    expectErr(await post(U.m1, `/sysbuild/notices/${gn1}/object`, { reason: '再来一次' }), 409, 'SYSBUILD_STATE', '同一知会至多一次');
    // ② 代表人更换后的现任代表人（不是接收人）：撤销 del 的授权，m2 成为现任代表人
    const g2 = await regOk(U.m1, ns.pid, { type: 'feedback', node_id: nn });
    const gn2 = await refOf(g2);
    expectErr(await post(U.m2, `/sysbuild/notices/${gn2}/object`, { reason: '还不是代表人' }), 403, 'SYSBUILD_FORBIDDEN', '换授权前的一般成员');
    await sqlRun("UPDATE sysbuild_delegations SET status = 'revoked', revoked_at = datetime('now','localtime'), revoke_reason = '更换代表人' WHERE party_id = ? AND status = 'active'", [ns.A]);
    const apt = (await sqlGet("SELECT id FROM sysbuild_appointments WHERE party_id = ? AND status = 'active'", [ns.A])).id;
    await addDelegation(ns.A, ns.mM2, apt, 'active');
    const lm2 = await myNotice(U.m2, gn2);
    assert.deepStrictEqual([lm2.as, lm2.actions.object], ['source_party', true], '现任代表人的 /my/notices：as = source_party，可异议');
    const rg2 = await post(U.m2, `/sysbuild/notices/${gn2}/object`, { reason: '现任代表人认为需要处理' });
    assert.deepStrictEqual([rg2.status, rg2.body.mode], [201, 'return_to_handling']);
    // 来源方负责人（不是接收人）仍是 party_owner
    const g3 = await regOk(U.m1, ns.pid, { type: 'feedback', node_id: nn });
    const gn3 = await refOf(g3);
    assert.strictEqual((await myNotice(U.own, gn3)).as, 'party_owner');
  });

  // ═══════════════════════ 11 记系统迭代单号 ═══════════════════════
  test(`${T_LINK}——link_sys_issue：PM 在登记上追加系统迭代单号（只存文本 1–32 位），只追加办理记录、不改结论状态；有无结论都可；作废 / 容器 / 非办理类 409；其他人 403`, async () => {
    const s = await mkPlan();
    const e = await regOk(U.m1, s.pid, { type: 'issue' });
    const L = (extra) => Object.assign({ action: 'link_sys_issue', sys_issue_no: 'SI-1001' }, extra || {});
    for (const uid of [U.m1, U.m2, U.ro, U.admin]) expectErr(await act(uid, e.id, L()), 403, 'SYSBUILD_FORBIDDEN', `用户 ${uid}`);
    expectErr(await act(U.out, e.id, L()), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    const bad = async (body, field, label) => { const r = await act(U.pm, e.id, body); expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', label); assert.strictEqual(r.body.field, field, label); };
    await bad({ action: 'link_sys_issue' }, 'sys_issue_no', '缺单号');
    await bad(L({ sys_issue_no: '   ' }), 'sys_issue_no', '单号空白');
    await bad(L({ sys_issue_no: 'N'.repeat(33) }), 'sys_issue_no', '单号 33 位');
    await bad(L({ bogus: 1 }), 'bogus', '多余键');
    assert.strictEqual((await sqlAll('SELECT id FROM sysbuild_entry_actions WHERE entry_id = ?', [e.id])).length, 0);
    const r1 = await actOk(U.pm, e.id, L({ sys_issue_no: 'N'.repeat(32), text: '关联系统迭代单' }));
    assert.deepStrictEqual([r1.entry.conclusion_state, r1.entry.records.map((x) => [x.action, x.sys_issue_no, x.text])], ['none', [['link_sys_issue', 'N'.repeat(32), '关联系统迭代单']]]);
    const row = await sqlGet('SELECT action, sys_issue_no, conclusion_kind FROM sysbuild_entry_actions WHERE id = ?', [r1.action_id]);
    assert.deepStrictEqual([row.action, row.sys_issue_no, row.conclusion_kind], ['link_sys_issue', 'N'.repeat(32), null]);
    // 有有效结论后仍可追加，状态不变；可追加多次
    await actOk(U.pm, e.id, CONCLUDE);
    assert.strictEqual((await openAndDecide(U.del, await lastConclusionTask(e.id), 'confirm')).status, 200);
    const r2 = await actOk(U.pm, e.id, L({ sys_issue_no: 'SI-1002' }));
    assert.deepStrictEqual([r2.entry.conclusion_state, r2.entry.records.filter((x) => x.action === 'link_sys_issue').length], ['confirmed', 2]);
    // 作废 / 容器 / 知悉类 409
    const vd = await regOk(U.pm, s.pid, { type: 'issue' });
    await actOk(U.pm, vd.id, { action: 'void', reason: '作废' });
    expectErr(await act(U.pm, vd.id, L()), 409, 'SYSBUILD_STATE', '已作废');
    const i4 = await s.outPlan();
    const cont = await regOk(U.pm, s.pid, { type: 'issue', item_ids: [s.i1.id, i4.id] });
    await golive(s.batch1, 'golive', '-1 hour');
    const cont2 = await regOk(U.pm, s.pid, { type: 'issue', item_ids: [s.i1.id, i4.id] });
    expectErr(await act(U.pm, cont2.id, L()), 409, 'SYSBUILD_STATE', '容器');
    const nt = await regOk(U.pm, s.pid, { type: 'note' });
    expectErr(await act(U.pm, nt.id, L()), 409, 'SYSBUILD_STATE', '知悉类');
    assert.ok(cont.id > 0);
  });

  // ═══════════════════════ 12 actions 同源 ═══════════════════════
  test(`${T_FLAGS}——逐对象 actions 的四个新标志（split / assign_items / link_sys_issue / object）：五种登记状态 × PM / 登记人 / 其他成员 / 只读账号，手写期望；标志为真执行成功，为假执行 403 / 409（同一判定）`, async () => {
    const s = await mkPlan();
    const i2 = await s.mkInPlan(s.batch2);
    const NEW = ['split', 'assign_items', 'link_sys_issue', 'object'];
    const flagsOf = (list) => { const o = {}; for (const a of NEW) o[a] = list.includes(a); return o; };
    // 状态工厂：每次现建一条（执行动作会改状态）
    const factories = {
      pendingEntry: () => regOk(U.m1, s.pid, { type: 'feedback' }),
      twoItems: () => regOk(U.pm, s.pid, { type: 'issue', item_ids: [s.i1.id, i2.id] }),
      confirmed: async () => {
        const e = await regOk(U.m1, s.pid, { type: 'feedback' });
        await actOk(U.pm, e.id, CONCLUDE);
        assert.strictEqual((await openAndDecide(U.del, await lastConclusionTask(e.id), 'confirm')).status, 200);
        return e;
      },
      voided: async () => { const e = await regOk(U.m1, s.pid, { type: 'feedback' }); await actOk(U.m1, e.id, { action: 'void', reason: '作废' }); return e; },
      container: async () => {
        const i4 = await s.outPlan();
        return regOk(U.pm, s.pid, { type: 'issue', item_ids: [i2.id, i4.id] });
      },
    };
    // 手写期望：状态 → 角色 → 为真的新标志
    const WANT = {
      pendingEntry: { PM: ['assign_items', 'link_sys_issue'], 登记人: [], 其他成员: [], 只读账号: [] },
      twoItems: { PM: ['split', 'link_sys_issue'], 登记人: [], 其他成员: [], 只读账号: [] },
      confirmed: { PM: ['link_sys_issue'], 登记人: ['object'], 其他成员: [], 只读账号: [] }, // Q4：已有有效结论的登记不再归属
      voided: { PM: [], 登记人: [], 其他成员: [], 只读账号: [] },
      container: { PM: [], 登记人: [], 其他成员: [], 只读账号: [] },
    };
    // 登记人视角：pendingEntry / confirmed / voided 的登记人是 m1；twoItems / container 是 PM 登记的，m1 是「其他成员」，这里的「登记人」只取 m1 登记的三种
    const BODY = async (name, e) => {
      if (name === 'split') return { action: 'split', groups: [[s.i1.id], [i2.id]] };
      if (name === 'assign_items') return { action: 'assign_items', basis_category: 'out_of_plan', route: 'sys_iteration', text: '依据' };
      if (name === 'link_sys_issue') return { action: 'link_sys_issue', sys_issue_no: 'SI-1' };
      return null;
    };
    const ROLES = [['PM', U.pm], ['登记人', U.m1], ['其他成员', U.m2], ['只读账号', U.ro]];
    for (const [state, make] of Object.entries(factories)) {
      for (const [role, uid] of ROLES) {
        const registrantIsM1 = ['pendingEntry', 'confirmed', 'voided'].includes(state);
        if (role === '登记人' && !registrantIsM1) continue;
        const want = flagsOf(WANT[state][role]);
        for (const name of NEW) {
          const e = await make();
          const d = await detail(uid, e.id);
          const got = {};
          for (const a of NEW) got[a] = d.actions[a];
          assert.deepStrictEqual(got, want, `${state} × ${role}：新标志手写期望`);
          let r;
          if (name === 'object') r = await post(uid, `/sysbuild/projects/${s.pid}/entries`, { objects_entry_id: e.id, body: '异议内容' });
          else r = await act(uid, e.id, await BODY(name, e));
          if (want[name]) assert.strictEqual(r.status, 201, `${state} × ${role} × ${name}：标志为真应成功 ${r.text}`);
          else assert.ok(r.status === 403 || r.status === 409, `${state} × ${role} × ${name}：标志为假应 403 / 409，实际 ${r.status} ${r.text}`);
          if (!want[name] && role !== 'PM' && name !== 'object') assert.strictEqual(r.status, 403, `${state} × ${role} × ${name}：没有权限一律 403`);
          if (!want[name] && name === 'object' && role !== 'PM') assert.ok(r.status === 403 || r.status === 409);
        }
      }
    }
    // 列表与详情同源
    const e = await factories.confirmed();
    const lst = (await get(U.m1, `/sysbuild/projects/${s.pid}/entries`)).body.entries.find((x) => x.id === e.id);
    assert.deepStrictEqual([lst.actions.object, lst.actions.assign_items, lst.actions.split, lst.actions.link_sys_issue], [true, false, false, false]);
  });

  // ═══════════════════════ 13 rules 矩阵与纯函数 ═══════════════════════
  test(`${T_RULES}——手写判定矩阵：entry_split / entry_assign_items / entry_link_sys_issue / entry_object 的身份 × 对象状态；已拆分容器拒绝一切办理；规划外留项目的结论限制；ENTRY_CONCLUSION_STATES 含 split_container 而有效结论集合不含；纯函数 planParts / snapshotRowsOfPart`, async () => {
    const R = T.getMods().rules;
    const RT = routingMod();
    const idn = (o) => Object.assign({ isPm: false, isAdmin: false, isReadonly: false, isMember: true, userId: 50, ownerOfParties: [], delegateOfParties: [], partyId: null, memberId: 9 }, o);
    const pm = idn({ isPm: true });
    const base = {
      isRegistrant: false, registrantWasPm: false, voided: false, type: 'issue', conclusionState: 'none', commitmentCurrent: false, commitmentInitial: false, refObjectedEver: false, riskCurrent: false,
      confirmer: 'delegate', confirmerProxyOnly: false, owner: 'ok', projectStatus: 'active', isSplitContainer: false, isChild: false, distinctItemCount: 0, route: 'pending', basisCategory: 'undetermined', objectorBasis: null,
      itemsAllLive: false, nodeCancelled: false, hasRefNotice: false, devConfirmStatus: 'none', markNeedsDevTask: false,
    };
    const chk = (op, i, st, t) => R.checkOp(op, i, { id: 1, status: st || 'active', pm_user_id: 7 }, Object.assign({}, base, t || {}));
    const code = (v) => (v === null ? null : `${v.status}:${v.code}`);
    // 状态集合
    assert.ok(R.ENTRY_CONCLUSION_STATES.includes('split_container'));
    assert.ok(!R.EFFECTIVE_CONCLUSION_STATES.includes('split_container'));
    // entry_split：PM；办理类；非容器；非子项；无有效结论；至少两个条目
    assert.strictEqual(chk('entry_split', pm, 'active', { distinctItemCount: 2 }), null);
    assert.strictEqual(chk('entry_split', pm, 'terminated', { distinctItemCount: 3 }), null, 'resolve 类：四态都允许');
    assert.strictEqual(chk('entry_split', pm, 'closed', { distinctItemCount: 3 }), null);
    for (const [label, t] of [['一个条目', { distinctItemCount: 1 }], ['零个条目', { distinctItemCount: 0 }], ['子项', { distinctItemCount: 2, isChild: true }], ['已有有效结论', { distinctItemCount: 2, conclusionState: 'confirmed' }],
      ['仅供参考', { distinctItemCount: 2, conclusionState: 'for_reference' }], ['作废', { distinctItemCount: 2, voided: true }], ['容器', { distinctItemCount: 2, isSplitContainer: true, conclusionState: 'split_container' }],
      ['知悉类', { distinctItemCount: 2, type: 'note' }], ['isChild 缺失', { distinctItemCount: 2, isChild: undefined }], ['作废标志缺失', { distinctItemCount: 2, voided: undefined }], ['条目数缺失', { distinctItemCount: undefined }]]) {
      assert.strictEqual(code(chk('entry_split', pm, 'active', t)), '409:SYSBUILD_STATE', label);
    }
    // 修订批 2 M-2：PM 已按规划外 / 规划内待细化人工归属的登记不能拆；依据为已生效规划内 / 尚未判定 / 缺失（从未分流）的可以
    for (const ba of ['out_of_plan', 'planned_detail']) {
      for (const route of ['project', 'sys_iteration']) {
        const v = chk('entry_split', pm, 'active', { distinctItemCount: 2, route, basisCategory: ba });
        assert.strictEqual(code(v), '409:SYSBUILD_STATE', `拆分 × ${ba} × ${route}`);
        assert.ok(v.message.includes('不能拆分'), v.message);
      }
    }
    for (const [route, ba] of [['project', 'in_plan'], ['sys_iteration', 'in_plan'], ['pending', 'undetermined'], [undefined, undefined]]) {
      assert.strictEqual(chk('entry_split', pm, 'active', { distinctItemCount: 2, route, basisCategory: ba }), null, `拆分 × ${ba}`);
    }
    // 预筛 H-1：只有「尚未给结论」可以拆分；其余每个结论状态都 409（待确认 / 有异议 / 裁定中 / 裁定未通过 / 仅供参考被异议 / 项目已终止结论失效 / 有效结论 / 作废）
    for (const st of ['pending_confirm', 'objected', 'escalated', 'adjudication_rejected', 'for_reference_objected', 'terminated_conclusion_lapsed', 'to_change_lapsed', 'confirmed', 'settled_no_confirm', 'adjudicated', 'for_reference']) {
      const v = chk('entry_split', pm, 'active', { distinctItemCount: 2, conclusionState: st });
      assert.strictEqual(code(v), '409:SYSBUILD_STATE', `拆分 × ${st}`);
      assert.ok(v.message.includes('尚未给结论'), v.message);
    }
    for (const [label, i] of [['成员', idn({})], ['登记人', idn({})], ['admin 未接管', idn({ isAdmin: true })], ['只读 PM', idn({ isPm: true, isReadonly: true })]]) {
      assert.strictEqual(code(chk('entry_split', i, 'active', { distinctItemCount: 2, isRegistrant: label === '登记人' })), '403:SYSBUILD_FORBIDDEN', label);
    }
    // entry_assign_items：PM；办理类；非容器；去向 = pending
    assert.strictEqual(chk('entry_assign_items', pm, 'active', {}), null);
    assert.strictEqual(chk('entry_assign_items', pm, 'terminated', {}), null, 'resolve 类：已终止');
    // Q4 + codex 25 H1：只有尚未给结论（none）的登记可补选归属——待确认 / 有异议 / 裁定中 / 裁定未通过 / 仅供参考被异议 / 失效 / 有效结论一律 409
    for (const st of ['pending_confirm', 'objected', 'escalated', 'adjudication_rejected', 'for_reference_objected', 'terminated_conclusion_lapsed', 'to_change_lapsed', 'confirmed', 'settled_no_confirm', 'adjudicated', 'for_reference']) {
      const v = chk('entry_assign_items', pm, 'active', { conclusionState: st });
      assert.strictEqual(code(v), '409:SYSBUILD_STATE', `补选归属 × ${st}`);
      assert.ok(v.message.includes('已给结论'), v.message);
    }
    for (const [label, t] of [['已留项目', { route: 'project' }], ['已转迭代', { route: 'sys_iteration' }], ['去向缺失', { route: undefined }], ['作废', { voided: true }], ['容器', { isSplitContainer: true, route: undefined }], ['知悉类', { type: 'lesson' }]]) {
      assert.strictEqual(code(chk('entry_assign_items', pm, 'active', t)), '409:SYSBUILD_STATE', label);
    }
    assert.strictEqual(code(chk('entry_assign_items', idn({}), 'active', {})), '403:SYSBUILD_FORBIDDEN');
    // entry_link_sys_issue：PM；办理类；非容器；非作废；任何结论状态
    for (const st of ['none', 'pending_confirm', 'confirmed', 'objected', 'settled_no_confirm']) assert.strictEqual(chk('entry_link_sys_issue', pm, 'active', { conclusionState: st }), null, st);
    assert.strictEqual(chk('entry_link_sys_issue', pm, 'terminated', {}), null, 'resolve 类：已终止');
    assert.strictEqual(chk('entry_link_sys_issue', pm, 'closed', {}), null, 'resolve 类：已结项');
    assert.strictEqual(chk('entry_link_sys_issue', pm, 'paused', {}), null, 'resolve 类：已暂停');
    for (const [label, t] of [['作废', { voided: true }], ['容器', { isSplitContainer: true }], ['知悉类', { type: 'note' }], ['状态缺失', { conclusionState: undefined }]]) assert.strictEqual(code(chk('entry_link_sys_issue', pm, 'active', t)), '409:SYSBUILD_STATE', label);
    assert.strictEqual(code(chk('entry_link_sys_issue', idn({ isReadonly: true }), 'active', {})), '403:SYSBUILD_FORBIDDEN');
    // entry_object：objectorBasis 四种依据之一；办理类；有效结论；非作废 / 容器；不带只读一票否决；项目状态 resolve 类
    for (const basis of ['registrant', 'confirmer', 'source_party', 'party_member']) {
      assert.strictEqual(chk('entry_object', idn({}), 'active', { objectorBasis: basis, conclusionState: 'confirmed' }), null, basis);
      assert.strictEqual(chk('entry_object', idn({}), 'terminated', { objectorBasis: basis, conclusionState: 'settled_no_confirm' }), null, `${basis} × 已终止`);
      assert.strictEqual(chk('entry_object', idn({ isReadonly: true }), 'closed', { objectorBasis: basis, conclusionState: 'adjudicated' }), null, `${basis} × 已结项 × 只读（与知会异议同口径，P107）`);
      // Q3 + 修订批 2 M-1：存在仅供参考知会时只能对知会提异议（不经 objects_entry_id）；没有知会（PM 本人 / 内部成员登记）时走本入口；事实缺失按拒绝
      const fr = chk('entry_object', idn({}), 'active', { objectorBasis: basis, conclusionState: 'for_reference', hasRefNotice: true });
      assert.strictEqual(code(fr), '409:SYSBUILD_STATE', `${basis} × 仅供参考（有知会）`);
      assert.ok(fr.message.includes('对知会提异议'), fr.message);
      assert.strictEqual(chk('entry_object', idn({}), 'active', { objectorBasis: basis, conclusionState: 'for_reference', hasRefNotice: false }), null, `${basis} × 仅供参考（无知会）`);
      assert.strictEqual(code(chk('entry_object', idn({}), 'active', { objectorBasis: basis, conclusionState: 'for_reference', hasRefNotice: undefined })), '409:SYSBUILD_STATE', `${basis} × 仅供参考（知会事实缺失）`);
    }
    for (const b of [null, undefined, 'pm', '']) assert.strictEqual(code(chk('entry_object', pm, 'active', { objectorBasis: b, conclusionState: 'confirmed' })), '403:SYSBUILD_FORBIDDEN', `无资格 ${String(b)}`);
    for (const st of ['none', 'pending_confirm', 'objected', 'escalated', 'adjudication_rejected', 'for_reference_objected', 'terminated_conclusion_lapsed', 'to_change_lapsed', 'voided', 'split_container']) {
      assert.strictEqual(code(chk('entry_object', idn({}), 'active', { objectorBasis: 'registrant', conclusionState: st, isSplitContainer: st === 'split_container', voided: st === 'voided' })), '409:SYSBUILD_STATE', `非有效结论 ${st}`);
    }
    assert.strictEqual(code(chk('entry_object', idn({}), 'active', { objectorBasis: 'registrant', conclusionState: 'confirmed', type: 'note' })), '409:SYSBUILD_STATE', '知悉类');
    // 已拆分容器拒绝其余一切办理动作
    for (const op of ['entry_correct', 'entry_void', 'entry_conclude', 'entry_for_reference', 'entry_mark_commitment', 'entry_unmark_commitment', 'entry_mark_risk', 'entry_unmark_risk', 'entry_escalate']) {
      const v = chk(op, Object.assign({}, pm, { isRegistrant: true }), 'active', { isSplitContainer: true, conclusionState: 'split_container', type: 'issue', commitmentCurrent: true, riskCurrent: true, isRegistrant: true });
      assert.strictEqual(code(v), '409:SYSBUILD_STATE', `${op} × 容器`);
      assert.ok(v.message.includes('已拆分'), `${op}：${v.message}`);
    }
    // 规划外 + 留项目：结论只能转正式变更（S-S1c 起放行）；project_terminated 收尾除外；其余去向 / 类别不受限；读接口 actions 不带 kind 时不判
    const oop = { route: 'project', basisCategory: 'out_of_plan' };
    assert.strictEqual(code(chk('entry_conclude', pm, 'active', Object.assign({ kind: 'handled' }, oop))), '409:SYSBUILD_STATE');
    assert.strictEqual(code(chk('entry_conclude', pm, 'active', Object.assign({ kind: 'to_sys_iteration' }, oop))), '409:SYSBUILD_STATE');
    assert.strictEqual(chk('entry_conclude', pm, 'active', Object.assign({ kind: 'to_change' }, oop)), null, 'to_change 放行（S-S1c）');
    assert.strictEqual(chk('entry_conclude', pm, 'terminated', Object.assign({ kind: 'project_terminated', confirmer: 'none', projectStatus: 'terminated' }, oop)), null, '项目已终止收尾不受限');
    assert.strictEqual(chk('entry_conclude', pm, 'active', Object.assign({ confirmer: 'none' }, oop)), null, '不带 kind 不判');
    assert.strictEqual(chk('entry_conclude', pm, 'active', { kind: 'handled', route: 'project', basisCategory: 'planned_detail' }), null, '待细化留项目不受限');
    assert.strictEqual(chk('entry_conclude', pm, 'active', { kind: 'handled', route: 'project', basisCategory: 'in_plan' }), null);
    assert.strictEqual(chk('entry_conclude', pm, 'active', { kind: 'to_sys_iteration', route: 'sys_iteration', basisCategory: 'out_of_plan' }), null, '规划外转系统迭代不受限');
    assert.strictEqual(chk('entry_conclude', pm, 'active', { kind: 'handled', route: 'pending', basisCategory: 'undetermined' }), null, '待判定的登记仍可直接给结论（派单未要求先归属）');
    // 预筛 M-2：去向转系统迭代的处理项，结论只能是转系统迭代（项目已终止收尾除外，no_further 也不放行）；仅供参考一律 409；读接口 actions 不带 kind 不判
    const sysR = { route: 'sys_iteration', basisCategory: 'in_plan' };
    for (const kind of ['handled', 'adopted', 'not_adopted', 'deferred', 'no_further']) {
      const v = chk('entry_conclude', pm, 'active', Object.assign({ kind, confirmer: 'none' }, sysR));
      assert.strictEqual(code(v), '409:SYSBUILD_STATE', `去向转系统迭代 × ${kind}`);
      assert.ok(v.message.includes('转系统迭代'), v.message);
    }
    assert.strictEqual(chk('entry_conclude', pm, 'active', Object.assign({ kind: 'to_sys_iteration', confirmer: 'none' }, sysR)), null);
    assert.strictEqual(chk('entry_conclude', pm, 'terminated', Object.assign({ kind: 'project_terminated', confirmer: 'none', projectStatus: 'terminated' }, sysR)), null, '项目已终止收尾不受限');
    assert.strictEqual(chk('entry_conclude', pm, 'active', Object.assign({ confirmer: 'none' }, sysR)), null, '不带 kind 不判');
    assert.strictEqual(chk('entry_conclude', pm, 'active', { kind: 'handled', confirmer: 'none', route: 'project', basisCategory: 'in_plan' }), null, '留项目不受这条限制');
    const v2 = chk('entry_for_reference', pm, 'active', Object.assign({ type: 'feedback' }, sysR));
    assert.strictEqual(code(v2), '409:SYSBUILD_STATE', '去向转系统迭代不能标仅供参考');
    assert.ok(v2.message.includes('转系统迭代'), v2.message);
    assert.strictEqual(chk('entry_for_reference', pm, 'active', { type: 'feedback', route: 'project', basisCategory: 'in_plan' }), null, '留项目的可以');
    assert.strictEqual(chk('entry_for_reference', pm, 'active', { type: 'feedback' }), null, '待判定的可以（S-S1a 行为）');
    // 预筛 M-3：规划外且留项目的不能用仅供参考绕开「只能转正式变更」
    const v3 = chk('entry_for_reference', pm, 'active', { type: 'feedback', route: 'project', basisCategory: 'out_of_plan' });
    assert.strictEqual(code(v3), '409:SYSBUILD_STATE', '规划外留项目不能标仅供参考');
    assert.ok(v3.message.includes('正式变更'), v3.message);
    assert.strictEqual(chk('entry_for_reference', pm, 'active', { type: 'feedback', route: 'project', basisCategory: 'planned_detail' }), null, '待细化留项目可以');
    // 预筛 L-2：提异议的执行前提——关联条目全部已上线 / 节点已取消时标志为假；事实没取到按拒绝
    const ob = { objectorBasis: 'registrant', conclusionState: 'confirmed' };
    assert.strictEqual(code(chk('entry_object', idn({}), 'active', Object.assign({ itemsAllLive: true }, ob))), '409:SYSBUILD_STATE', '条目全部已上线');
    assert.strictEqual(code(chk('entry_object', idn({}), 'active', Object.assign({ nodeCancelled: true }, ob))), '409:SYSBUILD_STATE', '节点已取消');
    assert.strictEqual(code(chk('entry_object', idn({}), 'active', Object.assign({ itemsAllLive: undefined }, ob))), '409:SYSBUILD_STATE', '条目事实缺失');
    assert.strictEqual(code(chk('entry_object', idn({}), 'active', Object.assign({ nodeCancelled: undefined }, ob))), '409:SYSBUILD_STATE', '节点事实缺失');
    assert.strictEqual(chk('entry_object', idn({}), 'active', ob), null);
    // 纯函数：处理项划分与快照行
    const it = (id, group, extra) => Object.assign({ item_id: id, group }, extra || {});
    assert.deepStrictEqual(RT.planParts([]), [{ route: 'pending', items: [] }]);
    assert.deepStrictEqual(RT.planParts([it(1, 'pending'), it(2, 'sys_iteration'), it(3, 'project'), it(4, 'project')]).map((p) => [p.route, p.items.map((x) => x.item_id)]), [['project', [3, 4]], ['sys_iteration', [2]], ['pending', [1]]], '顺序：项目 → 系统迭代 → 待判定');
    assert.strictEqual(RT.planParts([it(1, 'sys_iteration')]).length, 1);
    assert.deepStrictEqual(RT.snapshotRowsOfPart({ route: 'pending', items: [it(1, 'pending'), it(2, 'pending')] }), [{ route: 'pending', basis_category: 'undetermined', overall_package_version_id: null, item_version_id: null, committed_batch_id: null, golive_event_id: null }], '待判定整项一行');
    const full = (id, route) => ({ item_id: id, group: route, overall_package_version_id: 7, item_version_id: 100 + id, committed_batch_id: 5, golive_event_id: route === 'sys_iteration' ? 9 : null });
    assert.deepStrictEqual(RT.snapshotRowsOfPart({ route: 'sys_iteration', items: [full(1, 'sys_iteration'), full(2, 'sys_iteration')] }), [
      { route: 'sys_iteration', basis_category: 'in_plan', overall_package_version_id: 7, item_version_id: 101, committed_batch_id: 5, golive_event_id: 9 },
      { route: 'sys_iteration', basis_category: 'in_plan', overall_package_version_id: 7, item_version_id: 102, committed_batch_id: 5, golive_event_id: 9 },
    ], '一个条目一行');
    assert.deepStrictEqual(RT.snapshotRowsOfPart({ route: 'project', items: [full(1, 'project')] }), [{ route: 'project', basis_category: 'in_plan', overall_package_version_id: 7, item_version_id: 101, committed_batch_id: 5, golive_event_id: null }]);
    assert.deepStrictEqual([RT.GROUP_ORDER, RT.ASSIGN_BASES, RT.ASSIGN_ROUTES], [['project', 'sys_iteration', 'pending'], ['planned_detail', 'in_plan', 'out_of_plan'], ['project', 'sys_iteration']]);
  });

  // ═══════════════════════ 14 快照只追加 ═══════════════════════
  test(`${T_APPEND}——判定快照只追加：之后的归属 / 拆分 / 结论 / 上线事件变化都不改写已有快照行（逐行比对）；每次判定新增行的触发动作各不相同`, async () => {
    const s = await mkPlan();
    const i2 = await s.mkInPlan(s.batch2);
    const all = () => sqlAll('SELECT * FROM sysbuild_routing_snapshots WHERE entry_id IN (SELECT id FROM sysbuild_entries WHERE project_id = ?) ORDER BY id', [s.pid]);
    const e1 = await regOk(U.pm, s.pid, { type: 'issue' });
    const e2 = await regOk(U.pm, s.pid, { type: 'issue', item_ids: [s.i1.id, i2.id] });
    const snap0 = JSON.stringify(await all());
    assert.strictEqual((await all()).length, 3);
    // 批次上线 / 条目出新版本 / 结论：已保存的判定依据不追溯改写
    await golive(s.batch1, 'golive', '-1 hour');
    const nv = await post(U.pm, `/sysbuild/items/${i2.id}/versions`, { content: '需求：新版本', no_written_evidence: true, no_evidence_reason: '口头电话确认了本次需求内容' });
    assert.strictEqual(nv.status, 201, nv.text);
    await actOk(U.pm, e2.id, CONCLUDE);
    await actOk(U.pm, e1.id, CONCLUDE);
    assert.strictEqual(JSON.stringify(await all()), snap0, '上线 / 新版本 / 结论之后，已有快照一字未变');
    // 归属追加：旧行不变，新行 id 更大
    const r = await actOk(U.pm, (await regOk(U.pm, s.pid, { type: 'issue' })).id, { action: 'assign_items', basis_category: 'out_of_plan', route: 'sys_iteration', text: '依据' });
    const after = await all();
    assert.strictEqual(JSON.stringify(after.slice(0, 3)), snap0);
    assert.deepStrictEqual(after.slice(3).map((x) => [x.route, x.basis_category, x.trigger_action_id]), [['pending', 'undetermined', null], ['sys_iteration', 'out_of_plan', r.action_id]]);
    assert.ok(after.every((x, i) => i === 0 || x.id > after[i - 1].id));
    // 拆分追加：手动 split 的子项各有新行，触发动作 = split 动作，原登记名下的快照不动
    const e3 = await regOk(U.pm, s.pid, { type: 'issue', item_ids: [i2.id, (await s.mkInPlan(s.batch2)).id] });
    const before3 = JSON.stringify(await snapsOf(e3.id));
    const sp = await actOk(U.pm, e3.id, { action: 'split', groups: [[i2.id], [(await sqlAll('SELECT item_id FROM sysbuild_entry_items WHERE entry_id = ? ORDER BY id', [e3.id]))[1].item_id]] });
    assert.strictEqual(JSON.stringify(await snapsOf(e3.id)), before3, '原登记名下的快照不动');
    for (const k of sp.children) assert.ok((await snapsOf(k.entry_id)).every((x) => x.trigger_action_id === sp.action_id));
  });

  // ═══════════════════════ 15 结构约束 ═══════════════════════
  test(`${T_CHECK}——判定快照的类别分支 CHECK（直接插库）：尚未判定 ⇔ pending；规划内须有总体包 / 条目版本，留项目须有承诺批次、转系统迭代须有上线事件；待细化须有条目版本且只能留项目；规划外不带条目版本；登记的拆分来源与异议对象互斥；知会异议的处理方式与引用`, async () => {
    const snap = "INSERT INTO sysbuild_routing_snapshots (entry_id, part_no, overall_package_version_id, item_version_id, committed_batch_id, golive_event_id, route, basis_category) VALUES (999001, 1, ?, ?, ?, ?, ?, ?)";
    const ok = async (params, label) => { await sqlRun(snap, params); assert.ok(label); };
    const no = async (params, label) => { await assert.rejects(() => sqlRun(snap, params), /CHECK constraint failed/, label); };
    await ok([null, null, null, null, 'pending', 'undetermined'], '尚未判定');
    await ok([7, 8, 9, null, 'project', 'in_plan'], '规划内留项目');
    await ok([7, 8, 9, 5, 'sys_iteration', 'in_plan'], '规划内转系统迭代');
    await ok([null, 8, null, null, 'project', 'planned_detail'], '待细化');
    await ok([null, null, null, null, 'sys_iteration', 'out_of_plan'], '规划外');
    await no([null, null, null, null, 'pending', 'in_plan'], 'pending × in_plan');
    await no([null, null, null, null, 'project', 'undetermined'], 'project × undetermined');
    await no([7, null, null, null, 'pending', 'undetermined'], '尚未判定带判定列');
    await no([null, 8, 9, null, 'project', 'in_plan'], '规划内缺总体包');
    await no([7, 8, null, null, 'project', 'in_plan'], '规划内留项目缺承诺批次');
    await no([7, 8, 9, null, 'sys_iteration', 'in_plan'], '规划内转迭代缺上线事件');
    await no([null, null, null, null, 'project', 'planned_detail'], '待细化缺条目版本');
    await no([null, 8, null, null, 'sys_iteration', 'planned_detail'], '待细化转迭代');
    await no([null, 8, null, null, 'project', 'out_of_plan'], '规划外带条目版本');
    await no([null, null, null, null, 'project', 'bogus'], '类别越界');
    const ent = "INSERT INTO sysbuild_entries (project_id, type, operator_user_id, operator_identity_snapshot, period, title, body, parent_entry_id, objects_entry_id) VALUES (999001, 'issue', 1, '{}', 'process', 't', 'b', ?, ?)";
    await sqlRun(ent, [null, 5]);
    await sqlRun(ent, [5, null]);
    await assert.rejects(() => sqlRun(ent, [5, 6]), /CHECK constraint failed/, '拆分来源与异议对象并存');
    const obj = "INSERT INTO sysbuild_notice_objections (notice_id, actor_user_id, member_id, reason, mode, objection_entry_id) VALUES (?, 1, 1, '原因', ?, ?)";
    await sqlRun(obj, [999101, 'return_to_handling', null]);
    await sqlRun(obj, [999102, 'supplement_entry', 7]);
    await assert.rejects(() => sqlRun(obj, [999103, 'supplement_entry', null]), /CHECK constraint failed/, 'supplement_entry 缺引用');
    await assert.rejects(() => sqlRun(obj, [999104, 'return_to_handling', 7]), /CHECK constraint failed/, 'return_to_handling 带引用');
    await assert.rejects(() => sqlRun(obj, [999105, 'bogus', null]), /CHECK constraint failed/, '处理方式越界');
    // 清理（本用例用的是不存在的项目 / 登记编号，不影响别的用例，但保持库干净）
    await sqlRun('DELETE FROM sysbuild_routing_snapshots WHERE entry_id = 999001');
    await sqlRun('DELETE FROM sysbuild_entries WHERE project_id = 999001');
    await sqlRun('DELETE FROM sysbuild_notice_objections WHERE notice_id BETWEEN 999101 AND 999105');
  });
}

// ── 变异 ───────────────────────────────────────────────────────────────────────────────────────
// 每条 { id, expect: [用例名前缀], edits: [{ file, from, to }] }；锚点必须在副本里恰好出现一次（LF 归一后）。
const rm = (id, expect, file, from, to) => ({ id: `${P}${id}`, expect, edits: [{ file, from, to }] });
const ROUTING_MUTATIONS = [
  // ── entries-routing.js：上线事件有效性与条目归类 ──
  // C6a：「已上线」判据收口到 entries-core.batchLiveState（liveGoliveOf 只是转调），锚点随之换到那里
  rm('撤销上线的批次仍算已上线', [T_GOLIVE], 'entries-core.js', "return { last, live: LIVE_EVENT_KINDS.includes(ev.kind) && typeof ev.now_at === 'string' && ev.now_at > ev.created_at };", "return { last, live: typeof ev.now_at === 'string' && ev.now_at > ev.created_at };"),
  rm('事件时刻不早于登记时刻也算已上线', [T_GOLIVE], 'entries-core.js', "return { last, live: LIVE_EVENT_KINDS.includes(ev.kind) && typeof ev.now_at === 'string' && ev.now_at > ev.created_at };", 'return { last, live: LIVE_EVENT_KINDS.includes(ev.kind) };'),
  rm('上线事件取最早一条', [T_GOLIVE], 'entries-core.js', 'WHERE batch_id = ? ORDER BY id DESC LIMIT 1', 'WHERE batch_id = ? ORDER BY id ASC LIMIT 1'),
  rm('上线事件不按批次限定', [T_GOLIVE], 'entries-core.js', 'FROM sysbuild_golive_events WHERE batch_id = ?', 'FROM sysbuild_golive_events WHERE ? > 0'),
  rm('规划里没有承诺批次的条目不进待判定', [T_ROUTE], 'entries-routing.js', 'if (cell === null || cell.committed_batch_id === null || cell.committed_batch_id === undefined) {', 'if (cell === null) {'),
  rm('已上线 / 未上线组别写反', [T_ROUTE, T_GOLIVE, T_SPLIT], 'entries-routing.js', "group: live ? 'sys_iteration' : 'project',", "group: live ? 'project' : 'sys_iteration',"),
  rm('规划里的条目一律按未上线', [T_ROUTE, T_GOLIVE], 'entries-routing.js', 'const live = liveOfBatch[bid];', 'const live = null;'),
  rm('快照不记上线事件', [T_GOLIVE, T_SPLIT], 'entries-routing.js', 'committed_batch_id: c.committed_batch_id, golive_event_id: c.golive_event_id,', 'committed_batch_id: c.committed_batch_id, golive_event_id: null,'),
  rm('快照不记承诺批次', [T_ROUTE], 'entries-routing.js', 'committed_batch_id: c.committed_batch_id, golive_event_id: c.golive_event_id,', 'committed_batch_id: null, golive_event_id: c.golive_event_id,'),
  rm('快照不记总体包版本', [T_ROUTE], 'entries-routing.js', 'overall_package_version_id: c.overall_package_version_id, item_version_id: c.item_version_id,', 'overall_package_version_id: null, item_version_id: c.item_version_id,'),
  rm('处理项顺序被改', [T_SPLIT, T_RULES], 'entries-routing.js', "const GROUP_ORDER = Object.freeze(['project', 'sys_iteration', 'pending']);", "const GROUP_ORDER = Object.freeze(['sys_iteration', 'project', 'pending']);"),
  rm('没有条目时不给待判定项', [T_ROUTE, T_RULES], 'entries-routing.js', "if (classified.length === 0) return [{ route: 'pending', items: [] }];", 'if (classified.length === 0) return [];'),
  rm('待判定项按条目逐行写快照', [T_ROUTE, T_RULES], 'entries-routing.js', "if (part.route === 'pending') {", 'if (false) {'),
  rm('拒绝新增的响应不带 guide', [T_ROUTE], 'entries-routing.js', "extra: { guide: 'sys_iteration', live_items: live }", 'extra: { live_items: live }'),
  rm('拒绝新增的清单不带上线事件', [T_ROUTE], 'entries-routing.js', 'batch_name: b ? b.name : null, golive_event_id: c.golive_event_id }', 'batch_name: b ? b.name : null, golive_event_id: null }'),
  // ── entries-routing.js：子登记与手动拆分 ──
  rm('子项不复制登记人身份快照', [T_SPLIT], 'entries-routing.js', 'snapshotJson: parent.operator_identity_snapshot,', "snapshotJson: '{}',"),
  rm('子项不复制来源方', [T_SPLIT], 'entries-routing.js', 'sourcePartyId: parent.source_party_id,', 'sourcePartyId: null,'),
  rm('子项不复制登记人', [T_SPLIT], 'entries-routing.js', 'operatorUserId: parent.operator_user_id,', 'operatorUserId: 1,'),
  rm('子项不复制时段与天数', [T_SPLIT], 'entries-routing.js', 'period: parent.period, days: parent.days_after_close,', "period: 'process', days: null,"),
  // 预筛 M-1：子项的涉及承诺 = 初始 ∨ 当前，风险 = 当前（自动拆分时还没有办理记录，按初始值）
  rm('子项不复制承诺标记', [T_SPLIT], 'entries-routing.js', 'const commitment = parent.commitment_flag === 1 || (derived && derived.commitment_current === true) ? 1 : 0;', 'const commitment = (derived && derived.commitment_current === true) ? 1 : 0;'),
  rm('子项不复制风险标记', [T_SPLIT], 'entries-routing.js', 'const risk = parent.is_risk === 1 || (derived && derived.risk_current === true) ? 1 : 0;', 'const risk = (derived && derived.risk_current === true) ? 1 : 0;'),
  rm('子项不继承 PM 补标的涉及承诺', [T_MSPLIT], 'entries-routing.js', 'const commitment = parent.commitment_flag === 1 || (derived && derived.commitment_current === true) ? 1 : 0;', 'const commitment = parent.commitment_flag === 1 ? 1 : 0;'),
  rm('子项的涉及承诺只认当前值（丢初始标记）', [T_MSPLIT], 'entries-routing.js', 'const commitment = parent.commitment_flag === 1 || (derived && derived.commitment_current === true) ? 1 : 0;', 'const commitment = derived ? (derived.commitment_current ? 1 : 0) : parent.commitment_flag;'),
  rm('子项的涉及承诺来源恒取原来源', [T_MSPLIT], 'entries-routing.js', "const commitmentSource = parent.commitment_flag === 1 ? parent.commitment_flag_source : (commitment === 1 ? 'pm' : null);", 'const commitmentSource = parent.commitment_flag_source;'),
  rm('子项补标的涉及承诺来源记成提交人', [T_MSPLIT], 'entries-routing.js', "(commitment === 1 ? 'pm' : null);", "(commitment === 1 ? 'submitter' : null);"),
  rm('子项不继承 PM 补标的风险', [T_MSPLIT], 'entries-routing.js', 'const risk = parent.is_risk === 1 || (derived && derived.risk_current === true) ? 1 : 0;', 'const risk = parent.is_risk;'),
  rm('子项的风险只认当前值（丢初始标记）', [T_MSPLIT], 'entries-routing.js', 'const risk = parent.is_risk === 1 || (derived && derived.risk_current === true) ? 1 : 0;', 'const risk = derived ? (derived.risk_current ? 1 : 0) : parent.is_risk;'),
  rm('手动拆分不把原登记当前标记传给子项', [T_MSPLIT], 'entries.js', 'facts.currentItemRows, parts, actionId, facts.derived, uid, user);', 'facts.currentItemRows, parts, actionId, undefined, uid, user);'),
  // 修订批 2 L-1：初始带标记且当前已取消 → 子项保留初始 1，并追加一条取消记录
  // S-S1c：补写取消记录的代码收进了 recordCancel（同时发事件），下面六条随之改写锚点
  rm('取消了承诺的父登记拆分后子项不追加取消记录', [T_MSPLIT], 'entries-routing.js', "if (parent.commitment_flag === 1 && derived.commitment_current !== true) await recordCancel('unmark_commitment');", "if (false) await recordCancel('unmark_commitment');"),
  rm('取消了风险的父登记拆分后子项不追加取消记录', [T_MSPLIT], 'entries-routing.js', "if (parent.is_risk === 1 && derived.risk_current !== true) await recordCancel('unmark_risk');", "if (false) await recordCancel('unmark_risk');"),
  rm('子项追加取消承诺记录的条件写反', [T_MSPLIT], 'entries-routing.js', "if (parent.commitment_flag === 1 && derived.commitment_current !== true) await recordCancel('unmark_commitment');", "if (parent.commitment_flag === 1 && derived.commitment_current === true) await recordCancel('unmark_commitment');"),
  rm('子项追加取消风险记录的条件写反', [T_MSPLIT], 'entries-routing.js', "if (parent.is_risk === 1 && derived.risk_current !== true) await recordCancel('unmark_risk');", "if (parent.is_risk === 1 && derived.risk_current === true) await recordCancel('unmark_risk');"),
  rm('子项取消记录的记录人取登记人', [T_MSPLIT], 'entries-routing.js', "[id, action, CANCELLED_WITH_PARENT_TEXT, actorId]", "[id, action, CANCELLED_WITH_PARENT_TEXT, parent.operator_user_id]"),
  rm('子项取消记录事件的操作人取登记人', ['C5 预筛3轮：拆分子项取消记录事件'], 'entries-routing.js', 'operatorId: Number(actorId), operatorName: core.operatorNameOf(user),', 'operatorId: Number(parent.operator_user_id), operatorName: core.operatorNameOf(user),'),
  rm('子项取消记录的说明文字被改', [T_MSPLIT], 'entries-routing.js', "const CANCELLED_WITH_PARENT_TEXT = '随原登记取消';", "const CANCELLED_WITH_PARENT_TEXT = '取消';"),
  rm('手动拆分不传执行人', [T_MSPLIT], 'entries.js', 'facts.currentItemRows, parts, actionId, facts.derived, uid, user);', 'facts.currentItemRows, parts, actionId, facts.derived);'),
  // 修订批 2 M-2：人工归属（规划外 / 规划内待细化）的登记不能拆
  rm('规划外与待细化的登记也可拆分', [T_RULES, T_MSPLIT], 'rules.js', "if (t.basisCategory === 'out_of_plan' || t.basisCategory === 'planned_detail') return '已按规划外 / 规划内待细化归属的登记不能拆分';", ''),
  rm('拆分只拦规划外不拦待细化', [T_RULES, T_MSPLIT], 'rules.js', "if (t.basisCategory === 'out_of_plan' || t.basisCategory === 'planned_detail') return '已按规划外 / 规划内待细化归属的登记不能拆分';", "if (t.basisCategory === 'out_of_plan') return '已按规划外 / 规划内待细化归属的登记不能拆分';"),
  rm('拆分只拦待细化不拦规划外', [T_RULES, T_MSPLIT], 'rules.js', "if (t.basisCategory === 'out_of_plan' || t.basisCategory === 'planned_detail') return '已按规划外 / 规划内待细化归属的登记不能拆分';", "if (t.basisCategory === 'planned_detail') return '已按规划外 / 规划内待细化归属的登记不能拆分';"),
  rm('拆分连已生效规划内的登记也拦', [T_RULES, T_MSPLIT], 'rules.js', "if (t.basisCategory === 'out_of_plan' || t.basisCategory === 'planned_detail') return '已按规划外 / 规划内待细化归属的登记不能拆分';", "if (t.basisCategory === 'out_of_plan' || t.basisCategory === 'planned_detail' || t.basisCategory === 'in_plan') return '已按规划外 / 规划内待细化归属的登记不能拆分';"),
  rm('子项不复制证据声明', [T_SPLIT], 'entries-routing.js', 'noEvidence: parent.no_written_evidence, noEvidenceReason: parent.no_evidence_reason,', 'noEvidence: 0, noEvidenceReason: null,'),
  rm('子项不复制挂靠节点', [T_SPLIT], 'entries-routing.js', 'projectId: parent.project_id, nodeId: parent.node_id,', 'projectId: parent.project_id, nodeId: null,'),
  rm('子项不复制标题', [T_SPLIT], 'entries-routing.js', 'title: parent.title, body,', "title: '子项标题', body,"),
  rm('子项不记原登记编号', [T_SPLIT], 'entries-routing.js', 'parentEntryId: parent.id, objectsEntryId: null,', 'parentEntryId: null, objectsEntryId: null,'),
  rm('子项正文不引用原登记', [T_SPLIT], 'entries-routing.js', "`由第 ${parent.id} 条登记按分流归属拆出。\\n\\n【原登记内容】\\n${parent.body}`", 'parent.body'),
  rm('拆分子项不写判定快照', [T_SPLIT], 'entries-routing.js', 'const snapshotIds = await appendSnapshots(q, entryId, n, snapshotRowsOfPart(part), triggerActionId);', 'const snapshotIds = [];'),
  rm('处理项序号恒为 1', [T_SPLIT, T_MSPLIT], 'entries-routing.js', 'const snapshotIds = await appendSnapshots(q, entryId, n, snapshotRowsOfPart(part), triggerActionId);', 'const snapshotIds = await appendSnapshots(q, entryId, 1, snapshotRowsOfPart(part), triggerActionId);'),
  rm('判定快照不记触发动作', [T_MSPLIT, T_ASSIGN, T_APPEND], 'entries-routing.js', 'triggerActionId === undefined ? null : triggerActionId, r.route, r.basis_category]', 'null, r.route, r.basis_category]'),
  rm('子项条目关联不记触发动作', [T_MSPLIT], 'entries-routing.js', '[id, itemId, last.item_version_id, triggerActionId === undefined ? null : triggerActionId]', '[id, itemId, last.item_version_id, null]'),
  rm('手动拆分不要求至少两组', [T_MSPLIT], 'entries-routing.js', "if (!Array.isArray(groups) || groups.length < 2) throw invalid('至少分成两组', 'groups');", "if (!Array.isArray(groups)) throw invalid('至少分成两组', 'groups');"),
  rm('手动拆分允许空组', [T_MSPLIT], 'entries-routing.js', "if (!Array.isArray(g) || g.length === 0) throw invalid('每组至少有一个条目', 'groups');", "if (!Array.isArray(g)) throw invalid('每组至少有一个条目', 'groups');"),
  rm('手动拆分不核条目属于本登记', [T_MSPLIT], 'entries-routing.js', "if (!entryItemIds.includes(id)) throw invalid('分组里有不属于本登记关联条目的编号', 'groups');", ''),
  rm('手动拆分允许漏条目', [T_MSPLIT], 'entries-routing.js', "if (seen.length !== entryItemIds.length) throw invalid('分组必须包含本登记关联的全部条目', 'groups');", ''),
  { // 重复条目同时被「同一条目不能进两组」与「并集个数」两道判定拦下；两道都拆掉才暴露（个数判定放宽成 <）
    id: `${P}手动拆分允许同一条目进两组`, expect: [T_MSPLIT],
    edits: [
      { file: 'entries-routing.js', from: "if (seen.includes(id)) throw invalid('同一个条目不能进入两组', 'groups');", to: '' },
      { file: 'entries-routing.js', from: 'if (seen.length !== entryItemIds.length) throw invalid(', to: 'if (seen.length < entryItemIds.length) throw invalid(' },
    ],
  },
  rm('手动拆分不核组内去向一致', [T_MSPLIT], 'entries-routing.js', 'if (ps.length !== 1) throw stateError(', 'if (false) throw stateError('),
  // ── entries-routing.js：待判定归属 ──
  rm('归属不核依据类别', [T_ASSIGN], 'entries-routing.js', 'if (!ASSIGN_BASES.includes(basis)) throw invalid(', 'if (false) throw invalid('),
  rm('规划外不要求选去向', [T_ASSIGN], 'entries-routing.js', 'if (!ASSIGN_ROUTES.includes(route)) throw invalid(', 'if (false) throw invalid('),
  rm('规划外允许关联条目', [T_ASSIGN], 'entries-routing.js', "if (itemIds.length > 0) throw invalid('规划外不关联需求条目', 'item_ids');", ''),
  rm('归属不要求条目', [T_ASSIGN], 'entries-routing.js', "if (itemIds.length === 0) throw invalid('请选择要关联的需求条目', 'item_ids');", ''),
  rm('规划内 / 待细化允许选去向', [T_ASSIGN], 'entries-routing.js', 'if (route !== undefined && route !== null) throw invalid(', 'if (false) throw invalid('),
  rm('归属不核条目属于本项目', [T_ASSIGN], 'entries-routing.js', "'SELECT id FROM sysbuild_items WHERE id = ? AND project_id = ?', [itemId, projectId]", "'SELECT id FROM sysbuild_items WHERE id = ? AND ? > 0', [itemId, projectId]"),
  rm('待细化不核条目是新版本', [T_ASSIGN], 'entries-routing.js', 'if (hasKey(cur.byItem, itemId) && cur.byItem[itemId].item_version_id === last.id) {', 'if (false) {'),
  rm('待细化取条目最早版本', [T_ASSIGN], 'entries-routing.js', "'SELECT id, version_no FROM sysbuild_item_versions WHERE item_id = ? ORDER BY version_no DESC LIMIT 1'", "'SELECT id, version_no FROM sysbuild_item_versions WHERE item_id = ? ORDER BY version_no ASC LIMIT 1'"),
  rm('待细化快照不记总体包版本', [T_ASSIGN], 'entries-routing.js', "route: 'project', basis_category: 'planned_detail', overall_package_version_id: cur.overall_version_id,", "route: 'project', basis_category: 'planned_detail', overall_package_version_id: null,"),
  rm('规划外快照类别写成待细化', [T_ASSIGN], 'entries-routing.js', "rows: [{ route, basis_category: 'out_of_plan',", "rows: [{ route, basis_category: 'planned_detail',"),
  rm('规划内不挡规划外条目', [T_ASSIGN], 'entries-routing.js', "if (classified.some((c) => c.group === 'pending')) throw stateError(", 'if (false) throw stateError('),
  rm('规划内混合去向不自动拆分', [T_ASSIGN], 'entries-routing.js', 'if (groups.length !== 1) {', 'if (false) {'),
  // ── entries-core.js：已结口径、收口前置取数、异议资格、target ──
  rm('已拆分容器不看子项是否已结', [T_CLOSE, T_SPLIT], 'entries-core.js', "if (derived.conclusion_state === 'split_container') return derived.split_resolved === true;", "if (derived.conclusion_state === 'split_container') return true;"),
  rm('作废不算已结', [T_CLOSE, T_SPLIT], 'entries-core.js', 'if (derived.voided === true) return true;', ''),
  rm('已结不看有效结论集合', [T_CLOSE], 'entries-core.js', 'return rules.EFFECTIVE_CONCLUSION_STATES.includes(derived.conclusion_state);', "return derived.conclusion_state !== 'none';"),
  rm('容器只要一个子项已结就算已结', [T_CLOSE, T_SPLIT], 'entries-core.js', 'split_resolved: kids.every((k) => k.resolved)', 'split_resolved: kids.some((k) => k.resolved)'),
  rm('容器恒视为已结', [T_CLOSE, T_SPLIT], 'entries-core.js', 'split_resolved: kids.every((k) => k.resolved)', 'split_resolved: true'),
  rm('收口前置把补充登记也算进来', [T_CLOSE], 'entries-core.js', ': "AND period = \'process\' "}AND type IN (${marks}) ORDER BY id', ': "AND period IN (\'process\', \'supplement\') "}AND type IN (${marks}) ORDER BY id'), // C6b 修订批 1（L9）：unresolvedProcessEntriesOf 加了 opts（anyPeriod），时段条件改成条件拼接，锚点随之更新
  { // 类型占位符与参数一起放宽（只改占位符会让参数个数对不上）
    id: `${P}收口前置把知悉类也算进来`, expect: [T_CLOSE],
    edits: [
      { file: 'entries-core.js', from: "const marks = rules.ENTRY_HANDLED_TYPES.map(() => '?').join(', ');", to: "const marks = \"'feedback', 'issue', 'note', 'lesson', 'benefit', 'material'\";" },
      { file: 'entries-core.js', from: '[projectId].concat(rules.ENTRY_HANDLED_TYPES)', to: '[projectId]' },
    ],
  },
  rm('收口前置把已拆分容器自己也列入', [T_CLOSE], 'entries-core.js', 'if (kid) continue; // 已拆分容器：由子项判', '// 已拆分容器：由子项判'),
  rm('收口后异议计数含过程登记', [T_OBJ], 'entries-core.js', "AND objects_entry_id IS NOT NULL AND period = 'supplement' AND node_id IS NOT NULL ORDER BY id", 'AND objects_entry_id IS NOT NULL AND node_id IS NOT NULL ORDER BY id'),
  rm('收口后异议计数不看是否已结', [T_OBJ, T_NOTICE], 'entries-core.js', 'if (!entryResolved(facts.derived)) out[e.node_id] =', 'out[e.node_id] ='),
  rm('提异议：登记人本人不算有资格', [T_OBJ, T_FLAGS], 'entries-core.js', "if (Number(entry.operator_user_id) === me && parseSnapshot(entry).is_pm === false) return 'registrant';", ''),
  rm('提异议：原确认人不算有资格', [T_OBJ], 'entries-core.js', "if (m && m.user_id !== null && Number(m.user_id) === me) return 'confirmer';", ''),
  // codex 25 M4：确认人只认当前有效结论的确认修订
  rm('提异议：确认人不限当前结论（旧结论的确认人也算）', [T_OBJ], 'entries-core.js', "tr.task.object_type === 'conclusion' && tr.task.object_version_id === cur.id && tr.revision.status === 'confirmed'", "tr.task.object_type === 'conclusion'"),
  // 下一条靠「裁定通过」场景判别：当前结论的修订是有异议（不是确认），异议人不能因此成为确认人
  rm('提异议：确认人不限已确认的修订', [T_OBJ], 'entries-core.js', "tr.task.object_type === 'conclusion' && tr.task.object_version_id === cur.id && tr.revision.status === 'confirmed'", "tr.task.object_type === 'conclusion' && tr.task.object_version_id === cur.id"),
  rm('提异议：裁定确认人不算有资格', [T_OBJ], 'entries-core.js', "tr.task.object_type === 'adjudication' && tr.task.object_version_id === lastEscalate.id && tr.revision.status === 'confirmed'", 'false'),
  rm('提异议：来源方负责人 / 代表人不算有资格', [T_OBJ], 'entries-core.js', "if (rules.ownsParty(identity, pid) || (Array.isArray(identity.delegateOfParties) && identity.delegateOfParties.includes(pid))) return 'source_party';", ''),
  rm('提异议：来源方非空时同方一般成员也算有资格', [T_OBJ], 'entries-core.js', "return 'source_party';\n    return null;", "return 'source_party';\n    return 'party_member';"),
  rm('提异议：来源方为空时内部成员也算有资格', [T_OBJ], 'entries-core.js', "if (identity.isMember === true && identity.isPm !== true && identity.partyId !== null && identity.partyId !== undefined) return 'party_member';", "if (identity.isMember === true && identity.isPm !== true) return 'party_member';"),
  rm('target：已拆分容器标志恒假', [T_SPLIT], 'entries-core.js', "isSplitContainer: facts.derived.conclusion_state === 'split_container',", 'isSplitContainer: false,'),
  rm('target：处理项标志恒假', [T_MSPLIT], 'entries-core.js', 'isChild: entry.parent_entry_id !== null && entry.parent_entry_id !== undefined,', 'isChild: false,'),
  rm('target：关联条目数恒为 2', [T_MSPLIT], 'entries-core.js', 'distinctItemCount: new Set(facts.currentItemRows.map((r) => r.item_id)).size,', 'distinctItemCount: 2,'),
  rm('关联条目数取全部历史关联', [T_ASSIGN], 'entries-core.js', 'distinctItemCount: new Set(facts.currentItemRows.map((r) => r.item_id)).size,', 'distinctItemCount: new Set(facts.itemRows.map((r) => r.item_id)).size,'),
  rm('target：去向恒为待判定', [T_ASSIGN, T_FLAGS], 'entries-core.js', 'route: facts.routing ? facts.routing.route : undefined,', "route: 'pending',"),
  rm('target：判定依据类别缺失', [T_ASSIGN], 'entries-core.js', 'basisCategory: facts.routing ? facts.routing.basis_category : undefined,', 'basisCategory: undefined,'),
  rm('当前去向取最早一条快照', [T_ASSIGN, T_PEND], 'entries-core.js', 'FROM sysbuild_routing_snapshots WHERE entry_id = ? ORDER BY id DESC LIMIT 1`', 'FROM sysbuild_routing_snapshots WHERE entry_id = ? ORDER BY id ASC LIMIT 1`'),
  rm('收口后的知会异议也让原登记回到办理', [T_NOTICE], 'entries-core.js', 'latest !== null && returnedToHandling(latest.objection)', 'latest !== null && latest.objection !== null'),
  rm('「回到办理」判定恒真', [T_NOTICE], 'entries-core.js', "const returnedToHandling = (objection) => objection !== null && objection.mode === 'return_to_handling';", 'const returnedToHandling = (objection) => objection !== null;'),
  rm('写登记行不记异议对象', [T_OBJ, T_NOTICE], 'entries-core.js', 'f.objectsEntryId === undefined ? null : f.objectsEntryId, f.revisionOfEntryId', 'null, f.revisionOfEntryId'),
  rm('写登记行不记拆分来源', [T_SPLIT], 'entries-core.js', 'f.parentEntryId === undefined ? null : f.parentEntryId,', 'null,'),
  // ── entries.js：动作入口、写登记、列表、异议 ──
  rm('split 重新被当作未开放动作', [T_MSPLIT], 'entries.js', "const LATER_ACTIONS = Object.freeze(['adjudicate']);", "const LATER_ACTIONS = Object.freeze(['split', 'adjudicate']);"),
  rm('assign_items 重新被当作未开放动作', [T_ASSIGN], 'entries.js', "const LATER_ACTIONS = Object.freeze(['adjudicate']);", "const LATER_ACTIONS = Object.freeze(['assign_items', 'adjudicate']);"),
  rm('link_sys_issue 重新被当作未开放动作', [T_LINK], 'entries.js', "const LATER_ACTIONS = Object.freeze(['adjudicate']);", "const LATER_ACTIONS = Object.freeze(['link_sys_issue', 'adjudicate']);"),
  rm('归属依据可以不写', [T_ASSIGN], 'entries.js', "out.text = readText(body.text, 'text', '判定依据', TEXT_MAX, true);", "out.text = readText(body.text, 'text', '判定依据', TEXT_MAX, false);"),
  rm('记单号可以不写单号', [T_LINK], 'entries.js', "out.sysIssueNo = readText(body.sys_issue_no, 'sys_issue_no', '系统迭代单号', SYS_ISSUE_MAX, true);", "out.sysIssueNo = readText(body.sys_issue_no, 'sys_issue_no', '系统迭代单号', SYS_ISSUE_MAX, false);"),
  rm('归属不追加判定快照', [T_ASSIGN], 'entries.js', 'const sids = await routing.appendSnapshots(q, eid, facts.routing ? facts.routing.part_no : 1, plan.rows, actionId);', 'const sids = [];'),
  rm('归属的处理项序号恒为 1', [T_ASSIGN], 'entries.js', 'facts.routing ? facts.routing.part_no : 1', '1'),
  rm('归属新关联的条目不记触发动作', [T_ASSIGN], 'entries.js', '[eid, l.item_id, l.item_version_id, actionId]', '[eid, l.item_id, l.item_version_id, null]'),
  rm('归属只写新增条目不写完整集合', [T_ASSIGN], 'entries.js', 'for (const l of plan.links) {', 'for (const l of plan.links.filter((x) => !facts.itemRows.some((r) => r.item_id === x.item_id && r.item_version_id === x.item_version_id))) {'),
  // codex 25 M2：当前关联
  rm('当前关联恒取全部历史关联', [T_ASSIGN], 'entries-core.js', 'return itemRows.filter((r) => r.assigned_by_action_id === last.id);', 'return itemRows;'),
  rm('补选归属后当前关联取首次关联', [T_ASSIGN], 'entries-core.js', 'if (last === null) return itemRows;', 'return itemRows.filter((r) => r.assigned_by_action_id === null);'),
  rm('详情的关联条目不区分当前与历史', [T_ASSIGN], 'entries.js', 'view.items = view.items_history.filter((r) => currentIds.includes(r.id));', 'view.items = view.items_history;'),
  rm('手动拆分用全部历史关联算可分条目', [T_ASSIGN], 'entries.js', 'Array.from(new Set(facts.currentItemRows.map((r) => r.item_id))), input.groups);', 'Array.from(new Set(facts.itemRows.map((r) => r.item_id))), input.groups);'),
  rm('提异议的条目事实用全部历史关联', [T_ASSIGN], 'entries-routing.js', 'const itemIds = Array.from(new Set(facts.currentItemRows.map((r) => r.item_id))); // 当前关联', 'const itemIds = Array.from(new Set(facts.itemRows.map((r) => r.item_id))); // 当前关联'),
  // codex 25 M3：补选到混合去向自动拆分
  rm('子项补选到混合去向不拦', [T_ASSIGN], 'entries-routing.js', "if (opts && (opts.isChild === true || opts.noSplit === true)) {", 'if (false) {'),
  rm('补选到混合去向不拆子登记', [T_ASSIGN], 'entries.js', "if (plan.route === 'mixed') {", 'if (false) {'),
  rm('补选归属的子项拦截没传子项标志', [T_ASSIGN], 'entries.js', "{ isChild: entry.parent_entry_id !== null && entry.parent_entry_id !== undefined, noSplit", '{ isChild: false, noSplit'),
  rm('补选到混合去向拆分的快照不记触发动作', [T_ASSIGN], 'entries.js', 'written, plan.parts, actionId, facts.derived, uid, user);', 'written, plan.parts, null, facts.derived, uid, user);'),
  rm('补选到混合去向拆分不传当前标记', [T_ASSIGN], 'entries.js', 'written, plan.parts, actionId, facts.derived, uid, user);', 'written, plan.parts, actionId, undefined, uid, user);'),
  rm('补选到混合去向拆分的事件不标 assign', [T_ASSIGN], 'entries.js', "{ via: 'assign', action_id: actionId,", "{ via: 'manual', action_id: actionId,"),
  rm('手动拆分的事件不标 manual', [T_MSPLIT], 'entries.js', "{ via: 'manual', action_id: actionId,", "{ via: 'auto', action_id: actionId,"),
  rm('办理类登记不分流', [T_ROUTE], 'entries.js', "if (rules.ENTRY_HANDLED_TYPES.includes(input.type) && input.purpose === 'general') {", 'if (false) {'),
  rm('知悉类也分流', [T_ROUTE], 'entries.js', "if (rules.ENTRY_HANDLED_TYPES.includes(input.type) && input.purpose === 'general') {", 'if (true) {'),
  rm('全部已上线的登记也受理', [T_ROUTE, T_GOLIVE], 'entries.js', "if (parts.length === 1 && parts[0].route === 'sys_iteration') throw await routing.liveRejection(q, classified);", ''),
  rm('单个处理项不写判定快照', [T_ROUTE], 'entries.js', 'if (parts !== null && parts.length === 1) {', 'if (false) {'),
  rm('混合登记不拆分', [T_SPLIT, T_ROUTE], 'entries.js', '} else if (parts !== null) {', '} else if (false) {'),
  rm('错误响应不带附加字段', [T_ROUTE], 'entries.js', "if (err.extra && typeof err.extra === 'object') Object.assign(body, err.extra);", ''),
  rm('详情不带判定快照', [T_ROUTE], 'entries.js', 'view.routing_snapshots = await q.all(', 'view.routing_snapshots_off = await q.all('),
  rm('读接口不标待转系统迭代', [T_SPLIT], 'entries.js', "awaiting_sys_iteration: !!(facts.routing && facts.routing.route === 'sys_iteration') && !entries.entryResolved(d),", 'awaiting_sys_iteration: false,'),
  rm('读接口待转系统迭代不看是否已结', [T_SPLIT], 'entries.js', "&& facts.routing.route === 'sys_iteration') && !entries.entryResolved(d),", "&& facts.routing.route === 'sys_iteration') && true,"),
  rm('读接口「已结」恒假', [T_SPLIT], 'entries.js', 'resolved: entries.entryResolved(d),', 'resolved: false,'),
  { // SQL 筛选与 JS 里的当前去向判定（预筛 L-1 加）互为冗余；两处都改成取最早快照才能暴露「按最后一条快照取当前去向」
    id: `${P}待判定列表按最早快照筛选`, expect: [T_PEND],
    edits: [
      { file: 'entries.js', from: "ORDER BY s.id DESC LIMIT 1) = ?'", to: "ORDER BY s.id ASC LIMIT 1) = ?'" },
      { file: 'entries.js', from: "if (pendingOnly && (facts.routing === null || facts.routing.route !== 'pending')) continue;", to: '' },
    ],
  },
  rm('待判定列表成员也看全量', [T_PEND], 'entries.js', 'if (pendingOnly && !rules.canActAsPm(identity)) rows = rows.filter((r) => Number(r.operator_user_id) === Number(user.id));', ''),
  rm('待判定列表含已结的登记', [T_PEND], 'entries.js', 'if (pendingOnly && entries.entryResolved(facts.derived)) continue;', ''),
  rm('routing 筛选值不校验', [T_PEND], 'entries.js', "if (qs.routing !== 'pending') throw invalid(", 'if (false) throw invalid('),
  rm('异议登记不核提异议资格', [T_OBJ], 'entries.js', "rules.assertOp('entry_object', identity, access.project,", "rules.opAllowed('entry_object', identity, access.project,"),
  rm('异议登记不沿用节点', [T_OBJ], 'entries.js', 'input.nodeId = objected.node_id;', ''),
  rm('异议登记不沿用条目', [T_OBJ], 'entries.js', 'input.itemIds = Array.from(new Set(ofacts.currentItemRows.map((r) => r.item_id)));', 'input.itemIds = [];'),
  rm('异议登记不生成缺省标题', [T_OBJ], 'entries.js', 'if (input.title === null) input.title = Array.from(', 'if (false) input.title = Array.from('),
  rm('异议登记请求不收窄键集合', [T_OBJ], 'entries.js', 'onlyKeys(body, OBJECTION_KEYS);', ''),
  rm('异议登记类型不限办理类', [T_OBJ], 'entries.js', "if (typeof oType !== 'string' || !OBJECTION_TYPES.includes(oType)) throw invalid(", "if (typeof oType !== 'string') throw invalid("),
  rm('被异议的登记不核属于本项目', [T_OBJ], 'entries.js', 'WHERE id = ? AND project_id = ?`, [input.objectsEntryId, pid]', 'WHERE id = ? AND ? > 0`, [input.objectsEntryId, pid]'),
  rm('逐对象 actions 不带提异议资格', [T_FLAGS], 'entries.js', 'const basis = await entries.objectorBasisOf(q, entry, facts, identity, user);', 'const basis = null;'),
  rm('逐对象 actions 不带提异议的执行前提事实', [T_OBJ], 'entries.js', 'const oFacts = basis === null ? { itemsAllLive: false, nodeCancelled: false } : await routing.objectionFacts(q, entry, facts);', 'const oFacts = { itemsAllLive: false, nodeCancelled: false };'),
  rm('提异议的执行前提：节点已取消恒假', [T_OBJ], 'entries-routing.js', "nodeCancelled = !!n && n.status === 'cancelled';", 'nodeCancelled = false;'),
  rm('提异议的执行前提：条目已上线判定写反', [T_OBJ], 'entries-routing.js', "itemsAllLive = parts.length === 1 && parts[0].route === 'sys_iteration';", "itemsAllLive = parts.length === 1 && parts[0].route === 'project';"),
  rm('拆分的待确认修订防御被去掉', [T_MSPLIT], 'entries.js', "if (stuck) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：待拆分的登记名下有待确认的结论或裁定修订');", ''),
  rm('拆分的待确认修订防御不按登记限定', [T_MSPLIT], 'entries.js', "WHERE t.object_type IN ('conclusion', 'adjudication') AND t.object_id = ? AND r.status = 'pending' LIMIT 1", "WHERE t.object_type IN ('conclusion', 'adjudication') AND ? > 0 AND r.status = 'pending' LIMIT 1"),
  rm('待判定列表列出已拆分容器', [T_MSPLIT], 'entries.js', "if (pendingOnly && (facts.routing === null || facts.routing.route !== 'pending')) continue;", ''),
  rm('已拆分容器仍有当前去向', [T_MSPLIT], 'entries-core.js', 'const routing = childFacts.length > 0 ? null : await currentRoutingOf(q, entry.id);', 'const routing = await currentRoutingOf(q, entry.id);'),
  rm('子项冻结清单取自己名下的附件', [T_SPLIT], 'entries-core.js', 'ownerType: \'entry\', ownerId: sourceId,', "ownerType: 'entry', ownerId: entry.id,"),
  rm('子项详情不带原登记附件', [T_SPLIT], 'entries.js', 'for (const a of await attachmentsOfEntry(q, entry.parent_entry_id)) view.attachments.push(', 'for (const a of []) view.attachments.push('),
  rm('子项原登记附件不标 from_parent', [T_SPLIT], 'entries.js', 'Object.assign(a, { from_parent: true })', 'Object.assign(a, { from_parent: false })'),
  rm('actions 标志漏 object', [T_FLAGS], 'entries.js', "'link_sys_issue', 'link_change', 'object']);", "'link_sys_issue', 'link_change']);"),
  rm('知会异议恒回到办理', [T_NOTICE], 'entries.js', "const mode = per.period === 'supplement' ? 'supplement_entry' : 'return_to_handling';", "const mode = 'return_to_handling';"),
  rm('知会异议恒生成补充登记', [T_NOTICE], 'entries.js', "const mode = per.period === 'supplement' ? 'supplement_entry' : 'return_to_handling';", "const mode = 'supplement_entry';"),
  rm('知会异议不记异议登记引用', [T_NOTICE], 'entries.js', '[nid, uid, memberId, reason, mode, objectionEntryId]', '[nid, uid, memberId, reason, mode, null]'),
  rm('知会异议登记不沿用节点', [T_NOTICE], 'entries.js', 'nodeId: entry.node_id, sourcePartyId: null, itemIds:', 'nodeId: null, sourcePartyId: null, itemIds:'),
  rm('知会异议登记不沿用条目', [T_NOTICE], 'entries.js', 'itemIds: Array.from(new Set(facts.currentItemRows.map((r) => r.item_id))), attachmentIds: [],', 'itemIds: [], attachmentIds: [],'),
  rm('知会异议登记来源方不取提出人', [T_NOTICE], 'entries.js', 'const ownParty = identity.isPm !== true && identity.memberId !== null && identity.memberId !== undefined && identity.partyId !== undefined ? identity.partyId : null;', 'const ownParty = null;'),
  rm('知会异议登记不记原登记编号', [T_NOTICE], 'entries.js', '{ input, per, sourcePartyId: ownParty, objectsEntryId: entry.id }', '{ input, per, sourcePartyId: ownParty, objectsEntryId: null }'),
  // ── rules.js：新动作的判定、容器、规划外限制、项目状态类别 ──
  rm('拆分放行任何成员', [T_RULES, T_MSPLIT], 'rules.js', 'entry_split: Object.freeze({\n    can: (identity) => canActAsPm(identity),', 'entry_split: Object.freeze({\n    can: () => true,'),
  rm('拆分放行拆出的处理项', [T_RULES, T_MSPLIT], 'rules.js', "if (t.isChild === true) return '拆出的处理项不能再拆分';\n      if (t.isChild !== false) return PROXY_FACT_UNKNOWN_MESSAGE;", ''),
  // 预筛 H-1：只有 none 可拆分。恢复成「只拒有效结论」，或往可拆分状态集合里加一个状态，都要被判红
  rm('拆分恢复为只拒有效结论', [T_RULES, T_MSPLIT], 'rules.js', "if (!ENTRY_SPLIT_FROM_STATES.includes(t.conclusionState)) return '只有尚未给结论的登记可以拆分';", "if (EFFECTIVE_CONCLUSION_STATES.includes(t.conclusionState)) return '只有尚未给结论的登记可以拆分';"),
  ...['pending_confirm', 'objected', 'escalated', 'adjudication_rejected', 'for_reference_objected', 'terminated_conclusion_lapsed', 'confirmed'].map((st) => rm(
    `拆分的可出发状态集合多放行 ${st}`, [T_RULES, T_MSPLIT], 'rules.js', "const ENTRY_SPLIT_FROM_STATES = Object.freeze(['none']);", `const ENTRY_SPLIT_FROM_STATES = Object.freeze(['none', '${st}']);`
  )),
  // codex 25 H1：补选归属只允许 none。恢复成「只拒有效结论」或放行待确认 / 裁定中 / 有异议，都要被判红
  rm('归属恢复为只拒有效结论', [T_RULES, T_ASSIGN], 'rules.js', "if (t.conclusionState !== 'none') return '已给结论的登记不能补选归属';", "if (EFFECTIVE_CONCLUSION_STATES.includes(t.conclusionState)) return '已给结论的登记不能补选归属';"),
  ...['pending_confirm', 'objected', 'escalated'].map((st) => rm(
    `归属放行 ${st} 的登记`, [T_RULES, T_ASSIGN], 'rules.js', "if (t.conclusionState !== 'none') return '已给结论的登记不能补选归属';", `if (t.conclusionState !== 'none' && t.conclusionState !== '${st}') return '已给结论的登记不能补选归属';`
  )),
  // codex 25 M1：知会异议资格 = 接收人 或 objectorBasisOf 依据
  rm('知会异议资格漏原登记人', [T_NOTICE], 'rules.js', "const NOTICE_OBJECTOR_BASES = Object.freeze(['registrant', 'confirmer', 'source_party']);", "const NOTICE_OBJECTOR_BASES = Object.freeze(['confirmer', 'source_party']);"),
  rm('知会异议资格漏来源方负责人 / 现任代表人', [T_NOTICE], 'rules.js', "const NOTICE_OBJECTOR_BASES = Object.freeze(['registrant', 'confirmer', 'source_party']);", "const NOTICE_OBJECTOR_BASES = Object.freeze(['registrant', 'confirmer']);"),
  rm('知会异议资格只认接收人', [T_NOTICE, 'C5 登记：rules'], 'rules.js', 't.isRecipient === true || NOTICE_OBJECTOR_BASES.includes(t.objectorBasis);', 't.isRecipient === true;'),
  rm('知会异议资格放行一般成员依据', ['C5 登记：rules'], 'rules.js', "const NOTICE_OBJECTOR_BASES = Object.freeze(['registrant', 'confirmer', 'source_party']);", "const NOTICE_OBJECTOR_BASES = Object.freeze(['registrant', 'confirmer', 'source_party', 'party_member']);"),
  rm('我的知会不列原登记人', [T_NOTICE], 'entries.js', "WHERE n.kind = 'for_reference' AND e.operator_user_id = ? ORDER BY n.id DESC", 'WHERE ? > 0 ORDER BY n.id DESC'),
  rm('我的知会不列现任代表人', [T_NOTICE], 'entries.js', "JOIN sysbuild_delegations d ON d.party_id = e.source_party_id AND d.status = 'active'", "JOIN sysbuild_delegations d ON d.party_id = e.source_party_id AND d.status = 'none'"),
  rm('我的知会的现任代表人标成接收人', [T_NOTICE], 'entries.js', "rows.push(Object.assign({}, r, { as: 'source_party' }));", "rows.push(Object.assign({}, r, { as: 'recipient' }));"),
  rm('我的知会的原登记人标成接收人', [T_NOTICE], 'entries.js', "rows.push(Object.assign({}, r, { as: 'registrant' }));", "rows.push(Object.assign({}, r, { as: 'recipient' }));"),
  rm('转系统迭代的处理项可给任意结论', [T_RULES, T_SPLIT], 'rules.js', "if (t.route === 'sys_iteration' && t.kind !== undefined && t.kind !== 'to_sys_iteration' && t.kind !== 'project_terminated') return ENTRY_SYS_ITERATION_ROUTE_MESSAGE;", ''),
  rm('转系统迭代的处理项放行 no_further', [T_RULES, T_SPLIT], 'rules.js', "t.kind !== 'to_sys_iteration' && t.kind !== 'project_terminated') return ENTRY_SYS_ITERATION_ROUTE_MESSAGE;", "t.kind !== 'to_sys_iteration' && t.kind !== 'no_further' && t.kind !== 'project_terminated') return ENTRY_SYS_ITERATION_ROUTE_MESSAGE;"),
  rm('转系统迭代的处理项连项目已终止收尾也拦', [T_RULES], 'rules.js', " && t.kind !== 'project_terminated') return ENTRY_SYS_ITERATION_ROUTE_MESSAGE;", ') return ENTRY_SYS_ITERATION_ROUTE_MESSAGE;'),
  rm('转系统迭代的处理项可标仅供参考', [T_RULES, T_SPLIT], 'rules.js', "if (t.route === 'sys_iteration') return ENTRY_SYS_ITERATION_REFERENCE_MESSAGE;", ''),
  rm('规划外留项目可标仅供参考', [T_RULES, T_ASSIGN], 'rules.js', "if (t.route === 'project' && t.basisCategory === 'out_of_plan') return ENTRY_OUT_OF_PLAN_PROJECT_MESSAGE;", ''),
  { // 判定行与紧随其后的 fail-closed 兜底行一起去掉，否则兜底行仍以 409 拦下（等价变异）
    id: `${P}提异议不看条目已上线`, expect: [T_RULES, T_OBJ],
    edits: [
      { file: 'rules.js', from: "if (t.itemsAllLive === true) return '关联的需求条目所在批次已正式上线，项目内不再接受新增，请到系统迭代受理渠道提单';", to: '' },
      { file: 'rules.js', from: 'return t.itemsAllLive === false && t.nodeCancelled === false ? null : PROXY_FACT_UNKNOWN_MESSAGE;', to: 'return t.nodeCancelled === false ? null : PROXY_FACT_UNKNOWN_MESSAGE;' },
    ],
  },
  {
    id: `${P}提异议不看节点已取消`, expect: [T_RULES, T_OBJ],
    edits: [
      { file: 'rules.js', from: "if (t.nodeCancelled === true) return '该登记所在节点已取消，不能再关联新登记';", to: '' },
      { file: 'rules.js', from: 'return t.itemsAllLive === false && t.nodeCancelled === false ? null : PROXY_FACT_UNKNOWN_MESSAGE;', to: 'return t.itemsAllLive === false ? null : PROXY_FACT_UNKNOWN_MESSAGE;' },
    ],
  },
  rm('提异议的执行前提事实缺失时放行', [T_RULES], 'rules.js', 'return t.itemsAllLive === false && t.nodeCancelled === false ? null : PROXY_FACT_UNKNOWN_MESSAGE;', 'return null;'),
  rm('仅供参考的登记也可经 objects_entry_id 提异议', [T_RULES, T_OBJ], 'rules.js', "if (t.conclusionState === 'for_reference' && t.hasRefNotice === true) return '仅供参考的登记请对知会提异议';", ''),
  // 修订批 2 M-1：只在存在仅供参考知会时走知会路径
  rm('仅供参考的登记不看有无知会一律拦', [T_OBJ], 'rules.js', "if (t.conclusionState === 'for_reference' && t.hasRefNotice === true) return", "if (t.conclusionState === 'for_reference') return"),
  rm('知会事实恒为有知会', [T_OBJ], 'entries-core.js', 'hasRefNotice: facts.latestNotice !== null && facts.latestNotice !== undefined,', 'hasRefNotice: true,'),
  rm('知会事实恒为无知会', [T_OBJ], 'entries-core.js', 'hasRefNotice: facts.latestNotice !== null && facts.latestNotice !== undefined,', 'hasRefNotice: false,'),
  rm('知会事实缺失时放行', [T_RULES], 'rules.js', "if (t.conclusionState === 'for_reference' && t.hasRefNotice !== false) return PROXY_FACT_UNKNOWN_MESSAGE;", ''),
  rm('待细化不挡已上线条目的新版本', [T_ASSIGN], 'entries-routing.js', '&& (await liveGoliveOf(q, cur.byItem[itemId].committed_batch_id)) !== null) {', '&& false) {'),
  rm('拆分不要求至少两个条目', [T_RULES, T_MSPLIT], 'rules.js', "if (!(t.distinctItemCount >= 2)) return '登记关联的需求条目少于两个，无法拆分';", ''),
  rm('拆分放行知悉类', [T_RULES, T_MSPLIT], 'rules.js', "if (!ENTRY_HANDLED_TYPES.includes(t.type)) return '只有意见与反馈、问题与处理可以拆分';", ''),
  rm('归属放行任何成员', [T_RULES, T_ASSIGN], 'rules.js', 'entry_assign_items: Object.freeze({\n    can: (identity) => canActAsPm(identity),', 'entry_assign_items: Object.freeze({\n    can: () => true,'),
  rm('归属不要求尚未判定', [T_RULES, T_ASSIGN], 'rules.js', "if (t.route === 'pending') return null;", 'return null;'),
  // 知悉类没有判定快照（去向事实缺失），API 层仍被「去向缺失 fail-closed」409 拦下，所以只有 rules 矩阵能判别
  rm('归属放行知悉类', [T_RULES], 'rules.js', "if (!ENTRY_HANDLED_TYPES.includes(t.type)) return '只有意见与反馈、问题与处理需要分流归属';", ''),
  rm('记单号放行任何成员', [T_RULES, T_LINK], 'rules.js', 'entry_link_sys_issue: Object.freeze({\n    can: (identity) => canActAsPm(identity),', 'entry_link_sys_issue: Object.freeze({\n    can: () => true,'),
  rm('记单号放行知悉类', [T_RULES, T_LINK], 'rules.js', "return ENTRY_HANDLED_TYPES.includes(t.type) ? null : '只有意见与反馈、问题与处理可以记系统迭代单号';", 'return null;'),
  rm('提异议不要求已有有效结论', [T_RULES, T_OBJ], 'rules.js', "if (!EFFECTIVE_CONCLUSION_STATES.includes(t.conclusionState)) return '该登记还没有有效结论：结论待确认时请在确认任务里提异议，仅供参考请对知会提异议';", ''),
  rm('提异议的资格集合漏登记人', [T_RULES, T_OBJ], 'rules.js', "Object.freeze(['registrant', 'confirmer', 'source_party', 'party_member']);", "Object.freeze(['confirmer', 'source_party', 'party_member']);"),
  rm('提异议的资格集合漏原确认人', [T_RULES, T_OBJ], 'rules.js', "Object.freeze(['registrant', 'confirmer', 'source_party', 'party_member']);", "Object.freeze(['registrant', 'source_party', 'party_member']);"),
  rm('提异议的资格集合漏来源方负责人 / 代表人', [T_RULES, T_OBJ], 'rules.js', "Object.freeze(['registrant', 'confirmer', 'source_party', 'party_member']);", "Object.freeze(['registrant', 'confirmer', 'party_member']);"),
  rm('提异议的资格集合漏需求 / 开发方成员', [T_RULES, T_OBJ], 'rules.js', "Object.freeze(['registrant', 'confirmer', 'source_party', 'party_member']);", "Object.freeze(['registrant', 'confirmer', 'source_party']);"),
  rm('已拆分容器不挡办理动作', [T_RULES, T_SPLIT], 'rules.js', 'return t.isSplitContainer === true ? ENTRY_SPLIT_CONTAINER_MESSAGE : null;', 'return null;'),
  rm('登记状态集合漏已拆分容器', [T_RULES], 'rules.js', "  'split_container',\n]);", ']);'),
  rm('规划外留项目的结论不受限', [T_RULES, T_ASSIGN], 'rules.js', "if (t.route === 'project' && t.basisCategory === 'out_of_plan' && t.kind !== undefined && t.kind !== 'to_change' && t.kind !== 'project_terminated') return ENTRY_OUT_OF_PLAN_PROJECT_MESSAGE;", ''),
  rm('规划外留项目的限制连项目已终止结论也拦', [T_RULES], 'rules.js', " && t.kind !== 'project_terminated') return ENTRY_OUT_OF_PLAN_PROJECT_MESSAGE;", ') return ENTRY_OUT_OF_PLAN_PROJECT_MESSAGE;'),
  rm('规划外限制不看判定依据类别', [T_RULES], 'rules.js', "if (t.route === 'project' && t.basisCategory === 'out_of_plan' && t.kind !== undefined", "if (t.route === 'project' && t.kind !== undefined"),
  rm('拆分的项目状态类别记成 maintain', [T_RULES], 'rules.js', "  entry_split: 'resolve',", "  entry_split: 'maintain',"),
  rm('归属的项目状态类别记成 maintain', [T_RULES], 'rules.js', "  entry_assign_items: 'resolve',", "  entry_assign_items: 'maintain',"),
  rm('记单号的项目状态类别记成 maintain', [T_RULES], 'rules.js', "  entry_link_sys_issue: 'resolve',", "  entry_link_sys_issue: 'maintain',"),
  rm('提异议的项目状态类别记成 maintain', [T_RULES], 'rules.js', "  entry_object: 'resolve',", "  entry_object: 'maintain',"),
  // ── plan.js / history.js：收口前置 ──
  rm('收口前置缺登记事实时不报', [T_CLOSE], 'plan.js', 'if (!Array.isArray(f.entryUnresolved)) {', 'if (false) {'),
  rm('未结登记不限本节点', [T_CLOSE], 'plan.js', "const mine = f.entryUnresolved.filter((e) => e.node_id === node.id || (node.template_key === 'p_closing' && e.node_id === null));", 'const mine = f.entryUnresolved;'),
  rm('项目整体的登记阻塞所有节点', [T_CLOSE], 'plan.js', "|| (node.template_key === 'p_closing' && e.node_id === null)", '|| e.node_id === null'),
  rm('项目整体的登记不阻塞整体验收结项', [T_CLOSE], 'plan.js', " || (node.template_key === 'p_closing' && e.node_id === null)", ''),
  rm('阻塞项不带登记编号', [T_CLOSE], 'plan.js', 'node_ids: [node.id], entry_ids: mine.map((e) => e.id) });', 'node_ids: [node.id] });'),
  rm('取数不带登记事实', [T_CLOSE, T_HIST], 'plan.js', 'facts.entryUnresolved = await entriesCore.unresolvedProcessEntriesOf(q, projectId);', 'facts.entryUnresolved = [];'),
  rm('节点视图不带收口后异议计数', [T_OBJ, T_NOTICE], 'plan.js', 'post_close_objections_open: hasKey(data.postCloseObjections, n.id) ? data.postCloseObjections[n.id] : 0,', 'post_close_objections_open: 0,'),
  rm('收口端点不核登记前置', [T_CLOSE], 'plan.js', "if (blockers.length > 0) throw Object.assign(makeError(409, 'SYSBUILD_CLOSE_BLOCKED', '收口前置条件未满足'), { blockers });", "if (blockers.filter((b) => b.code !== 'ENTRY_UNRESOLVED').length > 0) throw Object.assign(makeError(409, 'SYSBUILD_CLOSE_BLOCKED', '收口前置条件未满足'), { blockers });"),
  rm('历史导入收口不核登记前置', [T_HIST], 'history.js', 'if (blockers.length > 0) return { block:', "if (blockers.filter((b) => b.code !== 'ENTRY_UNRESOLVED').length > 0) return { block:"),
  // ── events.js：事件类型登记 ──
  rm('分流判定事件类型未登记', [T_ROUTE], 'events.js', "'routing_decided', 'routing_assigned', 'entry_split',", "'routing_assigned', 'entry_split',"),
  rm('待判定归属事件类型未登记', [T_ASSIGN], 'events.js', "'routing_decided', 'routing_assigned', 'entry_split',", "'routing_decided', 'entry_split',"),
  rm('登记拆分事件类型未登记', [T_SPLIT], 'events.js', "'routing_decided', 'routing_assigned', 'entry_split',", "'routing_decided', 'routing_assigned',"),
];

module.exports = { defineRoutingCases, ROUTING_MUTATIONS };
