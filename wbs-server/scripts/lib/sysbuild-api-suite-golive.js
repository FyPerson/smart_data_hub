// 验证脚本库：项目管理（系统建设记录）模块 C6a——统一上线判据、批次验收包与结项包的提交、上线交接集合与交接确认、确认试运行结束（上线 / 再上线）、撤销上线、
//   整体结项（p_closing 收口）与项目重开、上线事件的历史导入（#113 段 8 C6a）的用例与变异
//   方案：docs/local/系统建设记录/系统建设记录_平台集成_方案_20261107_v1.5.md §2.2 :425、§2.3 :442–443、§3.2 :465–469、§4.2 :609 / :613 / :616、§4.3（:714 上线交接清单、:720 P106）、§4.5 :755–806、§5.2 :855–857、§7 :991
//   派单：docs/local/系统建设记录/送审准备/C6_C6a_上线交接结项_派单_20261107.md（§10 测试清单与本文件的 T_* 常量逐项对应）
//
// 本文件只放用例与变异，由 sysbuild-api-suite.js 登记（同一套夹具、同一个变异自检）。期望值一律手写，不取自被测代码。
// 夹具规则：建项、登记、办理动作、内容包提交与确认、节点开始 / 收口、上线 / 撤销 / 交接确认 / 历史导入全部走生产端点。只有这几类直接写库：
//   ① 需求方参与方、成员、任职、授权（H.seedParty / addMember）；② 附件行（暂存）；③ 第二批次与总体规划里的条目集合修订（produceEffectiveOverall 只产生默认批次的一个条目，
//   这里往已生效版本追加修订行以得到第二批次的条目——C3 起总体规划已生效后不能直接改版本，没有生产写入口）；④ 时间校准：上线事件 created_at、结项包 effective_at 回拨 / 前移
//   （「已正式上线」要求当前时刻严格晚于事件时刻，生产端点只会写出此刻的时间戳，用例不能靠墙钟，也不 sleep）；⑤ 批次 / 项目状态的少数边界（暂停、已结项、冻结批次）。
'use strict';
const assert = require('assert');
const path = require('path');

const P = 'C6a 上线：';
const T_LIVE = `${P}统一上线判据`;
const T_PROD = `${P}生产路径复验`;
const T_PKG = `${P}批次验收包提交`;
const T_UAT = `${P}验收包生效后用户验收测试可收口`;
const T_EXCL = `${P}待确认互斥`;
const T_CPKG = `${P}结项包提交`;
const T_SET = `${P}交接集合`;
const T_CLEAR = `${P}已清判定`;
const T_REQ = `${P}交接确认`;
const T_FP = `${P}状态指纹失效`;
const T_GOLIVE = `${P}确认试运行结束`;
const T_REVOKE = `${P}撤销上线`;
const T_CLOSE = `${P}整体结项`;
const T_IMPORT = `${P}上线事件导入`;
const T_FLAGS = `${P}actions 同源`;
const T_RULES = `${P}rules`;
const T_CORE = `${P}纯函数`;
// 修订批 1（预筛 1 轮）
const T_UNB = `${P}去向无承诺批次与转系统迭代进交接集合`;
const T_STALE = `${P}上线前置核验验收包引用的现行规划`;
const T_FREEZE = `${P}已上线批次的承诺条目集合冻结`;
const T_PPEND = `${P}结项前置核验结项包引用的现行规划与待确认的内容包`;
const T_LAPSE = `${P}交接任务对象随登记派生状态失效`;
const T_REOPEN = `${P}已结项重开要求结项节点已收口`;
// 修订批 2（预筛 2 轮）
const T_DECL = `${P}不认可后须有新的结论类动作才解除`;
const T_EFFECT = `${P}变更生效时重核已上线批次冻结与导入上线核待确认的规划`;
const T_EXEMPT = `${P}上线事件导入豁免用户验收测试节点`;
// 修订批 3（P174）
const T_REPLY = `${P}不认可后 PM 答复重新发起`;
// 修订批 4（P175 / P176 / LOW-1）
const T_UNMARK = `${P}不认可后不能取消风险标记`;
const T_ACCT = `${P}交接确认代录只放无账号代表人`;
// 修订批 5（P177）
const T_LIFT = `${P}答复只解锁重新发起不解除不认可`;
// 修订批 6（P178 / codex 27 M1）
const T_GATE = `${P}导入上线共用交接闸门`;
const T_SEEREPLY = `${P}代表人看得到 PM 的答复`;
// 修订批 7（27-R M1 / P179 / LOW-3）
const T_LINK = `${P}答复与修订的直接关联`;
const T_PAUSE = `${P}暂停时不能导入上线事件`;
const T_ORDER = `${P}导入上线先报已有上线事件`;
// C6b 残余⑦（预筛 6 LOW）
const T_CHAIN = `C6b 上线：答复回退层沿任务修订链继承`;
const T_HONOTIFY = `C6b 通知：交接确认的发送意图`; // 通知类用例，前缀与 sysbuild-api-suite-notify.js 一致

const OK_DATE = '2026-10-25';
// 交接确认的固定勾选文案（手写，与服务端常量逐字相等才算勾选）：确认一条按用途分设，不认可一条沿用通用文案
const HO_CONFIRM = {
  handover_accept_issue: '我已阅读以上全部内容，确认接受该问题带着上线',
  handover_no_further: '我已阅读以上全部内容，确认该问题不再处理',
};
const HO_REJECT = '我已阅读以上全部内容，不认可（原因见下）';
const HO_OBJECT = '我已阅读以上全部内容，对其有异议（原因见下）';
const GENERIC_CONFIRM = '我已阅读以上全部内容，确认无误';
const EV = { no_written_evidence: true, no_evidence_reason: '口头电话确认了本次变更内容' };
const CHG = Object.assign({ title: '新增批量导出', body: '范围变更：新增一项批量导出需求' }, EV);

const localToday = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function defineGoliveCases(T) {
  const { test, U, api, sqlRun, sqlGet, sqlAll, expectErr, eventsOf, addMember, addParty, addAppointment, addDelegation, confirm: H } = T;
  const { newProject, stageAtt, mkItem, mkPackage, mkVersion, tasksOf, confirmAll, produceEffectiveOverall, defaultBatchId, seedParty } = H;
  const post = (uid, url, body) => api(uid, 'POST', url, body === undefined ? {} : body);
  const get = (uid, url) => api(uid, 'GET', url);
  const countOf = async (s, p) => (await sqlGet(s, p)).n;
  const payloads = async (pid, type) => (await eventsOf(pid, type)).map((e) => JSON.parse(e.payload_json));
  const modDir = () => T.getModuleDir();
  const today = () => (T.getFixedToday && T.getFixedToday()) || localToday();

  // ── 助手 ───────────────────────────────────────────────────────────────────────────────────────
  const nodeIdOf = async (pid, key) => (await sqlGet('SELECT id FROM sysbuild_nodes WHERE project_id = ? AND template_key = ?', [pid, key])).id;
  const nodeRow = (nid) => sqlGet('SELECT * FROM sysbuild_nodes WHERE id = ?', [nid]);
  const startNode = async (pid, key) => {
    const id = await nodeIdOf(pid, key);
    const r = await post(U.pm, `/sysbuild/nodes/${id}/start`);
    assert.strictEqual(r.status, 200, r.text);
    return id;
  };
  const closeNodeReq = (nid) => post(U.pm, `/sysbuild/nodes/${nid}/close`);
  const batchRow = (bid) => sqlGet('SELECT * FROM sysbuild_batches WHERE id = ?', [bid]);
  const projStatus = async (pid) => (await sqlGet('SELECT status FROM sysbuild_projects WHERE id = ?', [pid])).status;
  const setStatus = (pid, to) => post(U.admin, `/sysbuild/projects/${pid}/status`, { to, reason: '上线交接用例' });
  const goliveReq = (uid, bid, body) => post(uid, `/sysbuild/batches/${bid}/golive`, body);
  const revokeReq = (uid, bid, body) => post(uid, `/sysbuild/batches/${bid}/revoke-golive`, body);
  const handoverGet = async (uid, bid) => {
    const r = await get(uid, `/sysbuild/batches/${bid}/handover`);
    assert.strictEqual(r.status, 200, r.text);
    return r.body;
  };
  const itemOf = (view, eid) => view.items.find((i) => i.entry_id === eid);
  const idsOf = (view) => view.items.map((i) => i.entry_id);
  const requestHo = (uid, bid, eid) => post(uid, `/sysbuild/batches/${bid}/handover/requests`, { entry_id: eid });
  const eventsAll = (bid) => sqlAll('SELECT * FROM sysbuild_golive_events WHERE batch_id = ? ORDER BY id', [bid]);
  const backdate = (eventId, offset) => sqlRun("UPDATE sysbuild_golive_events SET created_at = datetime('now','localtime', ?) WHERE id = ?", [offset || '-1 hour', eventId]);
  // 上线事件夹具（只用于造「未来时刻 / 多批次」这类生产端点写不出的事件；时刻相对真实时间）
  async function goliveFx(batch, kind, offset) {
    const r = await sqlRun(
      "INSERT INTO sysbuild_golive_events (batch_id, kind, handover_snapshot_json, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, datetime('now','localtime',?))",
      [batch, kind, kind === 'revoke' ? null : '{}', kind === 'revoke' ? '撤销上线（用例夹具）' : null, U.pm, offset]
    );
    return r.lastID;
  }

  // 登记 / 办理
  const reg = (uid, pid, extra) => post(uid, `/sysbuild/projects/${pid}/entries`, Object.assign({ type: 'feedback', title: '标题', body: '内容' }, extra || {}));
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
  const CONCLUDE = { action: 'conclude', conclusion_kind: 'handled', text: '已处理，见方案说明' };
  const concl = (kind, extra) => Object.assign({ action: 'conclude', conclusion_kind: kind, text: `结论 ${kind}` }, extra || {});
  const detail = async (uid, eid) => {
    const r = await get(uid, `/sysbuild/entries/${eid}`);
    assert.strictEqual(r.status, 200, r.text);
    return r.body.entry;
  };

  // 标准场景：总体规划已经生产路径生效（甲部 own / del、一个条目 i1 在默认批次 batch1，批次进行中），可选乙部（x1 / x2）、第二批次（夹具）、甲部一般成员 m1。
  async function mkPlan(opts) {
    const o = opts || {};
    const pid = await newProject(o.buildType);
    const eff = await produceEffectiveOverall(pid);
    const A = eff.party;
    const B = o.partyB ? (await seedParty(pid, '乙部', U.x1, U.x2)).party : null;
    const batch1 = await defaultBatchId(pid);
    const i1row = await sqlGet('SELECT item_id FROM sysbuild_item_versions WHERE id = ?', [eff.itemVersionId]);
    const i1 = { id: i1row.item_id, ver: eff.itemVersionId };
    const batch2 = o.batch2 ? (await sqlRun("INSERT INTO sysbuild_batches (project_id, seq, name, is_default, status) VALUES (?, 2, '第 2 批', 0, ?)", [pid, o.batch2 === true ? 'planning' : o.batch2])).lastID : null;
    if (o.m1) await addMember(pid, U.m1, { party: A });
    const mkInPlan = async (batch) => {
      const it = await mkItem(pid);
      const ver = it.versions[0].id;
      await sqlRun("INSERT INTO sysbuild_package_item_revisions (package_version_id, item_version_id, committed_batch_id, op, created_by) VALUES (?, ?, ?, 'add', ?)", [eff.pv, ver, batch, U.pm]);
      return { id: it.id, ver };
    };
    return { pid, eff, A, B, batch1, batch2, i1, mkInPlan };
  }
  // 经生产路径让 s.batch1 满足上线前置（批次验收包生效 + 本批节点收口），返回验收包
  const ready = (s) => H.readyForGolive(s.pid, s.batch1);
  // 经生产路径上线并把事件回拨成「已正式上线」
  const goLive = (s, offset) => H.productionGolive(s.batch1, offset);

  // 交接确认任务（每个需求部门一条）的当前修订
  const hoTasks = (eid) => sqlAll(
    `SELECT t.id AS task_id, t.party_id AS party_id, t.purpose AS purpose, t.object_type AS object_type, t.object_id AS object_id, t.object_version_id AS object_version_id,
            r.id AS rev_id, r.rev_no AS rev_no, r.status AS status, r.status_reason AS status_reason, m.user_id AS user_id
       FROM sysbuild_confirm_tasks t JOIN sysbuild_confirm_task_revisions r ON r.task_id = t.id JOIN sysbuild_members m ON m.id = r.required_member_id
      WHERE t.object_type = 'handover' AND t.object_id = ? AND r.rev_no = (SELECT MAX(r2.rev_no) FROM sysbuild_confirm_task_revisions r2 WHERE r2.task_id = t.id) ORDER BY t.id`,
    [eid]
  );
  async function decideHo(uid, tid, decision, extra) {
    const o = await get(uid, `/sysbuild/confirm-tasks/${tid}`);
    assert.strictEqual(o.status, 200, o.text);
    const body = Object.assign(
      { revision_id: o.body.revision.id, object_version_id: o.body.task.object_version_id, decision, checkbox_text: decision === 'confirm' ? HO_CONFIRM[o.body.task.purpose] : HO_REJECT },
      decision === 'confirm' ? {} : { reason: '业务不接受这个问题带着上线' }, extra || {}
    );
    return post(uid, `/sysbuild/confirm-tasks/${tid}/decide`, body);
  }
  // 发起并让全部任务由各自的代表人确认；返回发起响应
  async function requestAndConfirm(bid, eid) {
    const r = await requestHo(U.pm, bid, eid);
    assert.strictEqual(r.status, 201, r.text);
    for (const t of (await hoTasks(eid)).filter((x) => x.status === 'pending')) {
      const d = await decideHo(t.user_id, t.task_id, 'confirm');
      assert.strictEqual(d.status, 200, `任务 ${t.task_id}: ${d.text}`);
    }
    return r.body;
  }
  // 带风险标记、结论 not_adopted 的问题 = 阻塞项（需要「接受带此问题上线」确认）；返回登记
  const blockerIssue = async (s, extra) => {
    const e = await regOk(U.pm, s.pid, Object.assign({ type: 'issue', is_risk: 1, title: '风险问题' }, extra || {}));
    await actOk(U.pm, e.id, concl('not_adopted'));
    return e;
  };

  // ═══════════════════════ 1 统一上线判据（§1）═══════════════════════
  test(`${T_LIVE}——批次「是否已正式上线」只有一个判定助手（entries-core.batchLiveState）：最后一条事件是 golive / regolive 且当前时刻**严格晚于**事件时刻（同一秒算未上线，P106）；撤销后分流回到未上线、变更集合重核同口径`, async () => {
    // ① 纯函数边界（假 q，时刻手写）：没有事件 / golive / regolive / revoke × 现在晚于 / 等于 / 早于事件时刻
    const ec = require(path.join(modDir(), 'entries-core.js'));
    const fake = (row) => ({ get: async () => row });
    const T0 = '2026-11-03 10:00:00';
    const ev = (kind, nowAt) => ({ id: 5, kind, reason: kind === 'revoke' ? '撤销' : null, created_by: 1, created_at: T0, now_at: nowAt });
    assert.deepStrictEqual(await ec.batchLiveState(fake(undefined), 1), { last: null, live: false }, '没有事件');
    for (const [kind, nowAt, live] of [
      ['golive', '2026-11-03 10:00:01', true], ['golive', T0, false], ['golive', '2026-11-03 09:59:59', false],
      ['regolive', '2026-11-03 10:00:01', true], ['regolive', T0, false], ['regolive', '2026-11-03 09:59:59', false],
      ['revoke', '2026-11-03 11:00:00', false], ['revoke', T0, false],
    ]) {
      const st = await ec.batchLiveState(fake(ev(kind, nowAt)), 1);
      assert.strictEqual(st.live, live, `${kind} × 现在 ${nowAt}（事件 ${T0}）`);
      assert.deepStrictEqual(st.last, { id: 5, kind, reason: kind === 'revoke' ? '撤销' : null, created_by: 1, created_at: T0 }, `${kind} 最后一条事件原样返回`);
    }
    // ② 分流与批次视图同口径（生产路径上线 / 撤销 / 再上线）：事件时刻不早于当前（回拨到未来）= 未上线；回拨到过去 = 已上线；撤销后 = 未上线
    const s = await mkPlan();
    const probe = async () => {
      const r = await reg(U.pm, s.pid, { type: 'issue', item_ids: [s.i1.id] });
      if (r.status === 201) { await actOk(U.pm, r.body.entry.id, CONCLUDE); return false; }
      expectErr(r, 409, 'SYSBUILD_STATE', '探测');
      assert.strictEqual(r.body.guide, 'sys_iteration');
      return true;
    };
    assert.strictEqual(await probe(), false, '没有上线事件');
    await ready(s);
    const g1 = await H.productionGolive(s.batch1, '+1 hour'); // 事件时刻在一小时后：当前时刻不晚于它 = 未上线（批次状态已是 live）
    assert.strictEqual((await batchRow(s.batch1)).status, 'live', '批次状态随上线维护');
    assert.strictEqual(await probe(), false, '事件时刻在未来：分流判未上线');
    await backdate(g1.golive_event.id, '-1 hour');
    assert.strictEqual(await probe(), true, '事件时刻在过去：分流判已上线');
    await H.productionRevoke(s.batch1, '撤销后分流回到未上线');
    assert.strictEqual(await probe(), false, '撤销后：分流判未上线（已有判定快照不追溯改写）');
    // ③ 变更集合重核同口径：现行规划里承诺批次已上线的条目不得从变更集合移出——读同一个判据（未来时刻的上线事件不算已上线；撤销后不算）
    const s2 = await mkPlan();
    const i2 = await mkItem(s2.pid);
    const draftOf = async (cid) => (await sqlGet("SELECT v.id AS id FROM sysbuild_package_versions v JOIN sysbuild_changes c ON c.package_id = v.package_id WHERE c.id = ? AND v.status = 'draft'", [cid])).id;
    const mkRemoveChange = async () => {
      const r = await post(U.pm, `/sysbuild/projects/${s2.pid}/changes`, CHG);
      assert.strictEqual(r.status, 201, r.text);
      const cid = r.body.change.id;
      const vid = await draftOf(cid);
      assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${vid}/items`, { op: 'add', item_version_id: i2.versions[0].id, committed_batch_id: s2.batch1 })).status, 201);
      assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${vid}/items`, { op: 'remove', item_version_id: s2.i1.ver })).status, 201);
      return { cid, vid };
    };
    const code1 = (await sqlGet('SELECT code FROM sysbuild_items WHERE id = ?', [s2.i1.id])).code;
    const evId = await goliveFx(s2.batch1, 'golive', '+1 hour');
    const c1 = await mkRemoveChange();
    assert.strictEqual((await post(U.pm, `/sysbuild/changes/${c1.cid}/submit`)).status, 200, '事件时刻在未来：不算已上线，移出放行');
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${c1.vid}/withdraw`, { reason: '撤回再试' })).status, 200);
    await backdate(evId, '-1 hour');
    const c2 = await mkRemoveChange();
    const r2 = await post(U.pm, `/sysbuild/changes/${c2.cid}/submit`);
    expectErr(r2, 409, 'SYSBUILD_STATE', '已上线条目移出');
    assert.ok(r2.body.message.includes('已上线条目不能移出规划') && r2.body.message.includes(code1), r2.body.message);
    await goliveFx(s2.batch1, 'revoke', '-5 minutes');
    assert.strictEqual((await post(U.pm, `/sysbuild/changes/${c2.cid}/submit`)).status, 200, '撤销后（最后一条是 revoke）：不算已上线，移出放行');
  });

  // ═══════════════════════ 2 生产路径复验（分流 / 交接 / 上线 / 再上线）═══════════════════════
  test(`${T_PROD}——经生产端点上线、撤销、再上线：已上线批次登记被拒（guide = sys_iteration，清单里的 golive_event_id 就是端点写出的事件编号）；撤销后恢复受理；再上线后又被拒，事件编号换成 regolive 的那条`, async () => {
    const s = await mkPlan();
    await ready(s);
    const g1 = await goLive(s);
    assert.strictEqual(g1.golive_event.kind, 'golive');
    const code1 = (await sqlGet('SELECT code FROM sysbuild_items WHERE id = ?', [s.i1.id])).code;
    const rej = await reg(U.pm, s.pid, { type: 'issue', item_ids: [s.i1.id] });
    expectErr(rej, 409, 'SYSBUILD_STATE', '已上线批次登记');
    assert.deepStrictEqual(rej.body.live_items, [{ item_id: s.i1.id, code: code1, batch_id: s.batch1, batch_name: '第 1 批', golive_event_id: g1.golive_event.id }]);
    await H.productionRevoke(s.batch1, '撤销后恢复受理');
    const ok = await regOk(U.pm, s.pid, { type: 'issue', item_ids: [s.i1.id] });
    assert.strictEqual(ok.routing.route, 'project', '撤销后新登记分流回到留项目');
    await actOk(U.pm, ok.id, CONCLUDE);
    const g2 = await goLive(s);
    assert.strictEqual(g2.golive_event.kind, 'regolive');
    const rej2 = await reg(U.pm, s.pid, { type: 'issue', item_ids: [s.i1.id] });
    expectErr(rej2, 409, 'SYSBUILD_STATE', '再上线后');
    assert.strictEqual(rej2.body.live_items[0].golive_event_id, g2.golive_event.id, '清单里的上线事件 = 再上线那条');
    // 已有判定快照不追溯改写：撤销前登记的 ok 的快照仍是留项目 / 无上线事件
    const snaps = await sqlAll('SELECT route, golive_event_id FROM sysbuild_routing_snapshots WHERE entry_id = ? ORDER BY id', [ok.id]);
    assert.deepStrictEqual(snaps.map((x) => [x.route, x.golive_event_id]), [['project', null]]);
  });

  // ═══════════════════════ 3 批次验收包提交（§2）═══════════════════════
  test(`${T_PKG}——批次验收包开放提交：批次须「进行中」（规划中 / 已上线 / 已转出 / 被替代一律 409，actions.submit 同源为假）；必需确认人 = 每个需求部门负责人 + 生效代表人（缺代表人拒绝并列出参与方）；父总体版本 = 提交时的现行版本；生效只切版本状态，不形成基线、不推进批次`, async () => {
    // ① 批次还在规划中（总体规划未生效）：409
    const p0 = await newProject();
    await seedParty(p0, '甲部', U.own, U.del);
    const b0 = await defaultBatchId(p0);
    const v0 = await mkVersion(await mkPackage(p0, 'batch_accept', b0));
    const r0 = await post(U.pm, `/sysbuild/package-versions/${v0}/submit`);
    expectErr(r0, 409, 'SYSBUILD_STATE', '规划中');
    assert.ok(r0.body.message.includes('批次还没有进入进行中，不能提交批次验收'), r0.body.message);
    assert.strictEqual((await get(U.pm, `/sysbuild/package-versions/${v0}`)).body.actions.submit, false, '提交标志同源为假');
    assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id = ?', [v0])).status, 'draft');
    // ② 进行中：成功。必需确认人 = 甲部 / 乙部各 负责人 + 代表人 共 4 条
    const s = await mkPlan({ partyB: true });
    const pk = await mkPackage(s.pid, 'batch_accept', s.batch1);
    const pv = await mkVersion(pk);
    assert.strictEqual((await sqlGet('SELECT parent_overall_version_id AS p FROM sysbuild_package_versions WHERE id = ?', [pv])).p, s.eff.pv, '建草稿时 parent = 现行总体版本');
    // 夹具：草稿期间总体规划换版——parent 指向一个已被替代的总体版本。批次验收包「只引用验收时的现行版本」：提交时按现行版本重写，不报「请基于现行规划重建草稿」
    //   （该 409 只对变更包 / 总体规划包 / 批次需求包；验收包与结项包没有别的办法重建草稿——建新草稿要求本包没有草稿）
    const staleOv = (await sqlRun("INSERT INTO sysbuild_package_versions (package_id, version_no, form, status, snapshot_json, created_by) VALUES (?, 98, 'overall', 'superseded', '{}', ?)", [s.eff.pk, U.pm])).lastID;
    await sqlRun('UPDATE sysbuild_package_versions SET parent_overall_version_id = ? WHERE id = ?', [staleOv, pv]);
    assert.strictEqual((await get(U.pm, `/sysbuild/package-versions/${pv}`)).body.actions.submit, true, '提交标志为真（parent 过期不拒绝）');
    const baselinesBefore = await countOf("SELECT COUNT(*) AS n FROM sysbuild_node_schedule_records r JOIN sysbuild_nodes n ON n.id = r.node_id WHERE n.project_id = ? AND r.kind = 'baseline'", [s.pid]);
    const sub = await post(U.pm, `/sysbuild/package-versions/${pv}/submit`);
    assert.strictEqual(sub.status, 200, sub.text);
    // 需求确认单导出对验收包不报错（标题 / 类型用中文名「批次验收包」，没有条目集合与计划快照段）
    const sheet = await get(U.pm, `/sysbuild/package-versions/${pv}/confirmation-sheet`);
    assert.strictEqual(sheet.status, 200, String(sheet.text).slice(0, 200));
    assert.ok(sheet.text.includes('批次验收包') && !sheet.text.includes('节点计划快照'), '确认单写中文类型名、不带计划快照段');
    const tasks = await tasksOf(pv);
    assert.deepStrictEqual(tasks.map((t) => t.user_id).sort((a, b) => a - b), [U.own, U.del, U.x1, U.x2].sort((a, b) => a - b), '必需确认人：每个需求部门的负责人 + 代表人');
    assert.ok(tasks.every((t) => t.purpose === 'package_confirm'));
    assert.deepStrictEqual(tasks.map((t) => t.party_id).sort((a, b) => a - b), [s.A, s.A, s.B, s.B].sort((a, b) => a - b));
    assert.strictEqual((await sqlGet('SELECT parent_overall_version_id AS p FROM sysbuild_package_versions WHERE id = ?', [pv])).p, s.eff.pv, '提交时 parent 按现行版本重写');
    const ev = (await payloads(s.pid, 'package_version_submitted')).filter((p) => p.type === 'batch_accept');
    assert.strictEqual(ev.length, 1);
    assert.deepStrictEqual([ev[0].parent_from, ev[0].parent_to, ev[0].item_count], [staleOv, s.eff.pv, 0], '事件记下 parent 的重写');
    await confirmAll(pv);
    assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id = ?', [pv])).status, 'effective');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_node_schedule_records r JOIN sysbuild_nodes n ON n.id = r.node_id WHERE n.project_id = ? AND r.kind = 'baseline'", [s.pid]), baselinesBefore, '生效不形成基线');
    assert.strictEqual((await batchRow(s.batch1)).status, 'active', '生效不推进批次');
    assert.strictEqual((await eventsOf(s.pid, 'package_version_effective')).filter((e) => JSON.parse(e.payload_json).package_id === pk).length, 1);
    // ③ 批次状态：已上线 / 已转出 / 被替代 409（第二个草稿版本；状态直接改库）
    const pv2 = await mkVersion(pk);
    const sub2 = (status, extra) => sqlRun(`UPDATE sysbuild_batches SET status = ?${extra || ''} WHERE id = ?`, [status, s.batch1]);
    await sub2('live');
    const rl = await post(U.pm, `/sysbuild/package-versions/${pv2}/submit`);
    expectErr(rl, 409, 'SYSBUILD_STATE', '批次已上线');
    assert.ok(rl.body.message.includes('批次已正式上线，不能再提交批次验收'), rl.body.message);
    assert.strictEqual((await get(U.pm, `/sysbuild/package-versions/${pv2}`)).body.actions.submit, false);
    await sqlRun("UPDATE sysbuild_batches SET status = 'superseded', superseded_by = ? WHERE id = ?", [s.batch1 + 100000, s.batch1]);
    expectErr(await post(U.pm, `/sysbuild/package-versions/${pv2}/submit`), 409, 'SYSBUILD_STATE', '批次被替代');
    await sqlRun("UPDATE sysbuild_batches SET status = 'transferred', superseded_by = NULL, transfer_change_id = 999999 WHERE id = ?", [s.batch1]);
    expectErr(await post(U.pm, `/sysbuild/package-versions/${pv2}/submit`), 409, 'SYSBUILD_STATE', '批次已转出');
    await sqlRun("UPDATE sysbuild_batches SET status = 'active', transfer_change_id = NULL WHERE id = ?", [s.batch1]);
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${pv2}/submit`)).status, 200, '对照：批次恢复进行中后可提交');
    // ④ 缺生效代表人：乙部只有负责人
    const s3 = await mkPlan();
    await seedParty(s3.pid, '乙部', U.x1, null);
    const pv3 = await mkVersion(await mkPackage(s3.pid, 'batch_accept', s3.batch1));
    const r3 = await post(U.pm, `/sysbuild/package-versions/${pv3}/submit`);
    expectErr(r3, 409, 'SYSBUILD_STATE', '缺代表人');
    assert.strictEqual(r3.body.message, '以下参与方缺少必需确认人：乙部（缺生效代表人）');
    assert.strictEqual((await tasksOf(pv3)).length, 0, '被拒不生成任务');
  });

  test(`${T_UAT}——外包项目的「用户验收测试」节点：批次验收包未生效时收口被阻塞（PACKAGE_NOT_EFFECTIVE），验收包经生产路径生效后可收口（用户验收测试节点的收口前置读 batch_accept，P22 收尾）`, async () => {
    const s = await mkPlan({ buildType: 'outsource' });
    const uat = await startNode(s.pid, 'b_uat');
    const blocked = await closeNodeReq(uat);
    expectErr(blocked, 409, 'SYSBUILD_CLOSE_BLOCKED', '验收包未生效');
    assert.ok(blocked.body.blockers.some((b) => b.code === 'PACKAGE_NOT_EFFECTIVE' && b.message.includes('批次验收包')), JSON.stringify(blocked.body.blockers));
    await H.acceptEffective(s.pid, s.batch1);
    const ok = await closeNodeReq(uat);
    assert.strictEqual(ok.status, 200, ok.text);
    assert.strictEqual((await nodeRow(uat)).status, 'closed');
    // 外包批次的其余节点收口后可上线；里程碑是「试运行结束」b_trial
    await H.closeBatchNodes(s.pid, s.batch1);
    const g = await post(U.pm, `/sysbuild/batches/${s.batch1}/golive`);
    assert.strictEqual(g.status, 200, g.text);
    const trial = await nodeRow(await nodeIdOf(s.pid, 'b_trial'));
    assert.strictEqual(trial.status, 'closed', '外包的里程碑 b_trial（未开始）随上线收口');
    assert.ok(trial.opened_at && trial.closed_at, '未开始的里程碑收口时一并写开始 / 结束时刻');
    assert.strictEqual(g.body.milestone_node_id, trial.id);
  });

  // ═══════════════════════ 4 待确认互斥（P139）═══════════════════════
  test(`${T_EXCL}——总体规划 / 变更 / 批次验收 / 结项四类包同一项目同一时刻最多一个版本待确认：任一待确认时其余提交 409「已有待确认的内容包：<类型>，须先撤回或等确认完成」（提交标志同源为假）；撤回后放行；双向`, async () => {
    const s = await mkPlan();
    const accPk = await mkPackage(s.pid, 'batch_accept', s.batch1);
    const accV1 = await mkVersion(accPk);
    const mkCh = async () => {
      const r = await post(U.pm, `/sysbuild/projects/${s.pid}/changes`, CHG);
      assert.strictEqual(r.status, 201, r.text);
      return r.body.change.id;
    };
    const chSubmit = (cid) => post(U.pm, `/sysbuild/changes/${cid}/submit`);
    const chFlag = async (cid) => (await get(U.pm, `/sysbuild/changes/${cid}`)).body.change.actions.submit;
    const wd = (vid) => post(U.pm, `/sysbuild/package-versions/${vid}/withdraw`, { reason: '互斥用例撤回' });
    const verOfCh = async (cid) => (await sqlGet("SELECT v.id AS id FROM sysbuild_package_versions v JOIN sysbuild_changes c ON c.package_id = v.package_id WHERE c.id = ? AND v.status = 'pending'", [cid])).id;
    const MSG = (zh) => `已有待确认的内容包：${zh}，须先撤回或等确认完成`;
    // 验收包待确认 → 变更提交 409
    const c1 = await mkCh();
    assert.strictEqual(await chFlag(c1), true, '前置：变更提交标志为真');
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${accV1}/submit`)).status, 200);
    const r1 = await chSubmit(c1);
    expectErr(r1, 409, 'SYSBUILD_STATE', '验收包待确认时提交变更');
    assert.strictEqual(r1.body.message, MSG('批次验收'));
    assert.strictEqual(await chFlag(c1), false, '提交标志同源为假');
    assert.strictEqual((await wd(accV1)).status, 200);
    // 变更待确认 → 验收包再提交 409（双向）
    assert.strictEqual((await chSubmit(c1)).status, 200, '验收包撤回后变更可提交');
    const accV2 = await mkVersion(accPk);
    const r2 = await post(U.pm, `/sysbuild/package-versions/${accV2}/submit`);
    expectErr(r2, 409, 'SYSBUILD_STATE', '变更待确认时提交验收包');
    assert.strictEqual(r2.body.message, MSG('变更'));
    assert.strictEqual((await get(U.pm, `/sysbuild/package-versions/${accV2}`)).body.actions.submit, false);
    assert.strictEqual((await wd(await verOfCh(c1))).status, 200);
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${accV2}/submit`)).status, 200, '变更撤回后验收包可提交');
    assert.strictEqual((await wd(accV2)).status, 200);
    // 结项包 ↔ 变更：批次已正式上线后（验收包已有一个包：再来一个草稿版本提交 + 确认生效，节点另行收口）
    const accV3 = await mkVersion(accPk);
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${accV3}/submit`)).status, 200);
    await confirmAll(accV3);
    await H.closeBatchNodes(s.pid, s.batch1);
    await goLive(s);
    const clPk = await mkPackage(s.pid, 'closing');
    const clV1 = await mkVersion(clPk);
    const c2 = await mkCh();
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${clV1}/submit`)).status, 200, '结项包提交');
    const r3 = await chSubmit(c2);
    expectErr(r3, 409, 'SYSBUILD_STATE', '结项包待确认时提交变更');
    assert.strictEqual(r3.body.message, MSG('结项'));
    assert.strictEqual((await wd(clV1)).status, 200);
    assert.strictEqual((await chSubmit(c2)).status, 200, '结项包撤回后变更可提交');
    const clV2 = await mkVersion(clPk);
    const r4 = await post(U.pm, `/sysbuild/package-versions/${clV2}/submit`);
    expectErr(r4, 409, 'SYSBUILD_STATE', '变更待确认时提交结项包');
    assert.strictEqual(r4.body.message, MSG('变更'));
    assert.strictEqual((await get(U.pm, `/sysbuild/package-versions/${clV2}`)).body.actions.submit, false);
    // 立项包不在互斥范围内：只对四类提交判定（规则层矩阵见 rules 用例）；待确认的变更不挡立项包版本的提交
    const iniPk = (await sqlGet("SELECT id FROM sysbuild_packages WHERE project_id = ? AND type = 'initiation'", [s.pid])).id;
    const iniV = await mkVersion(iniPk);
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${iniV}/submit`)).status, 200, '立项包不受四类互斥约束');
  });

  // ═══════════════════════ 5 结项包提交（§2）═══════════════════════
  test(`${T_CPKG}——结项包：确认人 = 每个需求部门的生效代表人各一条（不含负责人）；提交前置 = 每个有效批次已正式上线（未上线 409 并列出批次）；缺代表人拒绝并列出参与方；无账号代表人只能 PM 代录；父总体版本取现行版本（建草稿与提交都重写）；草稿期间 parent 过期不拒绝`, async () => {
    const s = await mkPlan({ partyB: true });
    const clPk = await mkPackage(s.pid, 'closing');
    const clV = await mkVersion(clPk);
    assert.strictEqual((await sqlGet('SELECT parent_overall_version_id AS p FROM sysbuild_package_versions WHERE id = ?', [clV])).p, s.eff.pv, '建草稿：parent = 现行总体版本');
    // ① 批次未上线：409，文案列出批次；标志同源为假
    const r0 = await post(U.pm, `/sysbuild/package-versions/${clV}/submit`);
    expectErr(r0, 409, 'SYSBUILD_STATE', '批次未上线');
    assert.strictEqual(r0.body.message, '不能提交结项：以下批次还没有正式上线：第 1 批');
    assert.strictEqual((await get(U.pm, `/sysbuild/package-versions/${clV}`)).body.actions.submit, false);
    // 已转出且没有变更包的批次：同样拒绝并列出；被替代的批次不挡（夹具）
    const bX = (await sqlRun("INSERT INTO sysbuild_batches (project_id, seq, name, is_default, status, transfer_change_id) VALUES (?, 7, '第 7 批', 0, 'transferred', 999999)", [s.pid])).lastID;
    const bY = (await sqlRun("INSERT INTO sysbuild_batches (project_id, seq, name, is_default, status, superseded_by) VALUES (?, 8, '第 8 批', 0, 'superseded', ?)", [s.pid, bX])).lastID;
    const r0b = await post(U.pm, `/sysbuild/package-versions/${clV}/submit`);
    assert.strictEqual(r0b.body.message, '不能提交结项：以下批次还没有正式上线：第 1 批；以下已转出的批次没有已生效的变更包：第 7 批', '被替代的第 8 批不列');
    await sqlRun('DELETE FROM sysbuild_batches WHERE id IN (?, ?)', [bX, bY]);
    // ② 上线后：提交成功，确认人只有两个代表人
    await ready(s);
    await goLive(s);
    await sqlRun('UPDATE sysbuild_package_versions SET parent_overall_version_id = NULL WHERE id = ?', [clV]); // 夹具：草稿的 parent 丢了
    const stale = (await sqlRun("INSERT INTO sysbuild_package_versions (package_id, version_no, form, status, snapshot_json, created_by) VALUES (?, 99, 'overall', 'superseded', '{}', ?)", [s.eff.pk, U.pm])).lastID;
    await sqlRun('UPDATE sysbuild_package_versions SET parent_overall_version_id = ? WHERE id = ?', [stale, clV]); // 夹具：parent 指向一个已被替代的总体版本——结项包提交时按现行版本重写，不拒绝
    const sub = await post(U.pm, `/sysbuild/package-versions/${clV}/submit`);
    assert.strictEqual(sub.status, 200, sub.text);
    const sheetCl = await get(U.pm, `/sysbuild/package-versions/${clV}/confirmation-sheet`);
    assert.strictEqual(sheetCl.status, 200, String(sheetCl.text).slice(0, 200)); // 需求确认单导出对结项包不报错
    assert.ok(sheetCl.text.includes('结项包'), '确认单写中文类型名');
    const tasks = await tasksOf(clV);
    assert.deepStrictEqual(tasks.map((t) => t.user_id).sort((a, b) => a - b), [U.del, U.x2].sort((a, b) => a - b), '结项包确认人 = 每个需求部门的生效代表人，不含负责人');
    assert.deepStrictEqual(tasks.map((t) => t.party_id).sort((a, b) => a - b), [s.A, s.B].sort((a, b) => a - b));
    assert.strictEqual((await sqlGet('SELECT parent_overall_version_id AS p FROM sysbuild_package_versions WHERE id = ?', [clV])).p, s.eff.pv, '提交时 parent 按现行版本重写');
    const ev = (await payloads(s.pid, 'package_version_submitted')).filter((p) => p.type === 'closing');
    assert.deepStrictEqual([ev[0].parent_from, ev[0].parent_to], [stale, s.eff.pv]);
    await confirmAll(clV);
    assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id = ?', [clV])).status, 'effective');
    // ③ 缺生效代表人：乙部只有负责人（结项包不要求负责人，所以文案只写缺代表人）
    const s2 = await mkPlan();
    await ready(s2);
    await H.productionGolive(s2.batch1);
    await seedParty(s2.pid, '乙部', U.x1, null); // 上线之后才有的需求部门，只有负责人（验收包提交时它还不存在）
    const v2 = await mkVersion(await mkPackage(s2.pid, 'closing'));
    const r2 = await post(U.pm, `/sysbuild/package-versions/${v2}/submit`);
    expectErr(r2, 409, 'SYSBUILD_STATE', '缺代表人');
    assert.strictEqual(r2.body.message, '以下参与方缺少必需确认人：乙部（缺生效代表人）');
    // ④ 无账号代表人：任务只能 PM 代录（proxy_only），代录确认计入通过
    const s3 = await mkPlan();
    await ready(s3);
    await H.productionGolive(s3.batch1);
    const partyC = await addParty(s3.pid, '丙部', 'demand');
    const mOwn = await addMember(s3.pid, U.cand2, { party: partyC });
    const apt = await addAppointment(partyC, mOwn, 'active');
    const mDel = await sqlRun("INSERT INTO sysbuild_members (project_id, party_id, user_id, person_name, joined_at, added_by) VALUES (?, ?, NULL, '丙部代表（无账号）', '2026-10-01 10:00:00', ?)", [s3.pid, partyC, U.admin]);
    await addDelegation(partyC, mDel.lastID, apt, 'active');
    const v3 = await mkVersion(await mkPackage(s3.pid, 'closing'));
    const sub3 = await post(U.pm, `/sysbuild/package-versions/${v3}/submit`);
    assert.strictEqual(sub3.status, 200, sub3.text);
    const proxyTask = sub3.body.tasks.find((t) => t.party_id === partyC);
    assert.strictEqual(proxyTask.proxy_only, true, '无账号代表人 = 只能代录');
    assert.deepStrictEqual(sub3.body.tasks.map((t) => t.kind), ['delegate', 'delegate'], '两条都是代表人任务');
    const own3 = sub3.body.tasks.find((t) => t.party_id === s3.A);
    expectErr(await H.openAndDecide(U.pm, proxyTask.task_id, 'confirm'), 403, 'SYSBUILD_FORBIDDEN', '无账号代表人的任务平台上没人能决策（PM 也不能代为勾选）');
    const px = await post(U.pm, `/sysbuild/confirm-tasks/${proxyTask.task_id}/proxy`, {
      revision_id: proxyTask.revision_id, object_version_id: v3, decision: 'confirm', external_date: today(), actual_confirmer: '丙部代表', identity_basis: '电话确认，凭据见附件', attachment_ids: [await stageAtt(s3.pid, U.pm, 'd')],
    });
    assert.strictEqual(px.status, 200, px.text);
    assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id = ?', [v3])).status, 'pending', '还差甲部代表人');
    assert.strictEqual((await H.openAndDecide(U.del, own3.task_id, 'confirm')).status, 200);
    assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id = ?', [v3])).status, 'effective', '代录确认计入通过，结项包生效');
  });

  // ═══════════════════════ 6 交接集合（a / b / c 三来源）═══════════════════════
  test(`${T_SET}——GET /batches/:bid/handover：本项目内未作废、非已拆分容器的办理类登记，满足 (a) 当前去向留项目且承诺批次含本批 (b) 当前去向待判定 (c) 挂在本批节点上（含里程碑节点、收口后补充登记）之一；不属本批的不列；知悉类 / 作废 / 容器不列；已办结的也列；项目成员 / admin / 只读账号可读，非成员 404`, async () => {
    const s = await mkPlan({ batch2: true, m1: true });
    const i2 = await s.mkInPlan(s.batch2);
    const bDev = await nodeIdOf(s.pid, 'b_dev');
    const bGolive = await nodeIdOf(s.pid, 'b_golive');
    const eA = await regOk(U.pm, s.pid, { type: 'feedback', item_ids: [s.i1.id], title: 'A' });
    const eB = await regOk(U.pm, s.pid, { type: 'issue', title: 'B' });
    const eC = await regOk(U.pm, s.pid, { type: 'feedback', node_id: bDev, item_ids: [i2.id], title: 'C' });
    const eD = await regOk(U.pm, s.pid, { type: 'feedback', item_ids: [i2.id], title: 'D' });
    const eM = await regOk(U.pm, s.pid, { type: 'issue', item_ids: [s.i1.id, i2.id], title: 'M' });
    const eG = await regOk(U.pm, s.pid, { type: 'feedback', node_id: bGolive, item_ids: [i2.id], title: 'G' });
    const eV = await regOk(U.pm, s.pid, { type: 'feedback', item_ids: [s.i1.id], title: 'V' });
    await actOk(U.pm, eV.id, { action: 'void', reason: '作废' });
    const eN = await regOk(U.pm, s.pid, { type: 'note', item_ids: [s.i1.id], title: 'N' });
    await regOk(U.pm, s.pid, { type: 'note', node_id: bGolive, title: 'N2（挂在本批节点上的知悉类：节点来源也只收办理类）' });
    // 收口后的补充登记（节点 b_dev 收口，夹具）
    await sqlRun("UPDATE sysbuild_nodes SET status = 'closed', opened_at = '2026-10-01 09:00:00', closed_at = ? WHERE id = ?", [`${today()} 08:00:00`, bDev]);
    const eS = await regOk(U.pm, s.pid, { type: 'feedback', node_id: bDev, item_ids: [i2.id], title: 'S' });
    assert.strictEqual(eS.period, 'supplement', '前置：补充登记');
    await actOk(U.pm, eA.id, CONCLUDE); // 已办结的也列出
    const v1 = await handoverGet(U.pm, s.batch1);
    assert.deepStrictEqual(idsOf(v1), [eA.id, eB.id, eC.id, eM.id, eG.id, eS.id].sort((a, b) => a - b), '本批的交接集合：不含 D（只在第 2 批）、V（作废）、N（知悉类）');
    const by = (eid) => itemOf(v1, eid);
    assert.deepStrictEqual([by(eA.id).sources, by(eA.id).route, by(eA.id).committed_batch_ids, by(eA.id).resolved, by(eA.id).conclusion_kind], [['committed'], 'project', [s.batch1], true, 'handled']);
    assert.deepStrictEqual([by(eB.id).sources, by(eB.id).route, by(eB.id).committed_batch_ids, by(eB.id).resolved], [['pending'], 'pending', [], false]);
    assert.deepStrictEqual([by(eC.id).sources, by(eC.id).route, by(eC.id).committed_batch_ids], [['node'], 'project', [s.batch2]], '挂在本批节点上、承诺批次是第 2 批：只因节点入集合');
    assert.deepStrictEqual([by(eM.id).sources, by(eM.id).committed_batch_ids.sort((a, b) => a - b)], [['committed'], [s.batch1, s.batch2]], '一次判定里条目承诺批次不同：全部批次都算（含本批即入集合）');
    assert.deepStrictEqual(by(eG.id).sources, ['node'], '里程碑节点上的过程登记');
    assert.deepStrictEqual([by(eS.id).sources, by(eS.id).route], [['node'], 'project'], '收口后的补充登记');
    // 第 2 批：D、M、C（它的承诺批次含第 2 批）、G、S 也含第 2 批的承诺；A 不含
    const v2 = await handoverGet(U.pm, s.batch2);
    assert.deepStrictEqual(idsOf(v2), [eB.id, eC.id, eD.id, eM.id, eG.id, eS.id].sort((a, b) => a - b), '第 2 批：承诺批次含它的 + 待判定 B；没有节点的批次只靠 (a)(b)');
    assert.deepStrictEqual(itemOf(v2, eD.id).sources, ['committed']);
    assert.ok(!idsOf(v2).includes(eA.id));
    // 已拆分容器不列：手动拆分 M（i1 → 第 1 批，i2 → 第 2 批），容器退出集合，子项各归各的批次
    await actOk(U.pm, eM.id, { action: 'split', groups: [[s.i1.id], [i2.id]], text: '按批次拆开' });
    const kids = await sqlAll('SELECT id FROM sysbuild_entries WHERE parent_entry_id = ? ORDER BY id', [eM.id]);
    assert.strictEqual(kids.length, 2);
    const v1b = await handoverGet(U.pm, s.batch1);
    assert.ok(!idsOf(v1b).includes(eM.id), '容器退出集合');
    assert.ok(idsOf(v1b).includes(kids[0].id) && !idsOf(v1b).includes(kids[1].id), '子项 1（i1 → 第 1 批）入第 1 批，子项 2（i2 → 第 2 批）不入');
    const v2b = await handoverGet(U.pm, s.batch2);
    assert.ok(idsOf(v2b).includes(kids[1].id) && !idsOf(v2b).includes(kids[0].id));
    // 汇总计数：第 1 批 6 → 拆分后 6（容器去、子项 1 进）
    assert.strictEqual(v1b.summary.total, v1b.items.length);
    assert.deepStrictEqual([v1b.summary.cleared, v1b.summary.uncleared], [v1b.items.filter((i) => i.cleared).length, v1b.items.filter((i) => !i.cleared).length]);
    // 可见性：成员 / admin / 只读账号可读；非成员 404；批次不存在 404
    for (const uid of [U.m1, U.admin, U.ro, U.own]) assert.strictEqual((await get(uid, `/sysbuild/batches/${s.batch1}/handover`)).status, 200, `uid ${uid}`);
    expectErr(await get(U.out, `/sysbuild/batches/${s.batch1}/handover`), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    expectErr(await get(U.pm, '/sysbuild/batches/99999999/handover'), 404, 'SYSBUILD_NOT_FOUND', '批次不存在');
    expectErr(await get(U.pm, '/sysbuild/batches/abc/handover'), 400, 'SYSBUILD_INVALID_INPUT', '编号非法');
    // 读接口不写浏览记录 / 事件 / 任务
    const before = await countOf('SELECT COUNT(*) AS n FROM sysbuild_views', []);
    const evBefore = await countOf('SELECT COUNT(*) AS n FROM sysbuild_events WHERE project_id = ?', [s.pid]);
    await handoverGet(U.own, s.batch1);
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_views', []), before);
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_events WHERE project_id = ?', [s.pid]), evBefore);
  });

  // ═══════════════════════ 7 已清判定 ═══════════════════════
  test(`${T_CLEAR}——每项「已清」：必须已办结；结论为「业务确认不再处理」或当前带风险标记且结论不是已处理 / 已采纳（阻塞项）的，还须有交接确认（全部需求部门代表人确认，指纹仍是当前）；风险按当前值（补标 / 取消风险都算）；转系统迭代结论沿用单号与承接人必填`, async () => {
    const s = await mkPlan();
    const v = (eid, view) => itemOf(view, eid);
    // ① 未办结：不清（带风险的未办结 = 阻塞项，但还不能发起确认）
    const e1 = await regOk(U.pm, s.pid, { type: 'feedback', title: '未办结' });
    const e1r = await regOk(U.pm, s.pid, { type: 'issue', is_risk: 1, title: '未办结的风险问题' });
    // ② 已办结、无风险：清
    const e2 = await regOk(U.pm, s.pid, { type: 'feedback', title: '已处理' });
    await actOk(U.pm, e2.id, CONCLUDE);
    // ③ 不再处理：需要确认
    const e3 = await regOk(U.pm, s.pid, { type: 'feedback', title: '不再处理' });
    await actOk(U.pm, e3.id, concl('no_further'));
    // ④ 风险问题：handled / adopted 不需要确认，not_adopted / deferred / to_sys_iteration 需要接受带此问题上线
    const risk = {};
    for (const kind of ['handled', 'adopted', 'not_adopted']) {
      const e = await regOk(U.pm, s.pid, { type: 'issue', is_risk: 1, title: `风险 ${kind}` });
      await actOk(U.pm, e.id, concl(kind));
      risk[kind] = e;
    }
    const eSys = await regOk(U.pm, s.pid, { type: 'issue', is_risk: 1, title: '风险 转迭代' });
    await actOk(U.pm, eSys.id, concl('to_sys_iteration', { sys_issue_no: 'SI-100', assignee_text: '外包张三' }));
    // ⑤ 无风险的转系统迭代（单号与承接人齐全）：已办结、不需要确认 → 清
    const eSys2 = await regOk(U.pm, s.pid, { type: 'feedback', title: '无风险转迭代' });
    await actOk(U.pm, eSys2.id, concl('to_sys_iteration', { sys_issue_no: 'SI-101', assignee_text: '外包李四' }));
    // ⑥ 风险按当前值：无风险登记补标风险 → 变成需要确认；风险登记取消风险 → 不需要
    const eMark = await regOk(U.pm, s.pid, { type: 'issue', title: '后补风险' });
    await actOk(U.pm, eMark.id, concl('not_adopted'));
    const eUnmark = await regOk(U.pm, s.pid, { type: 'issue', is_risk: 1, title: '后取消风险' });
    await actOk(U.pm, eUnmark.id, concl('not_adopted'));
    const view0 = await handoverGet(U.pm, s.batch1);
    assert.strictEqual(v(eMark.id, view0).need_confirm, null, '补标前不需要确认');
    assert.strictEqual(v(eUnmark.id, view0).need_confirm, 'accept_issue', '取消前需要确认');
    await actOk(U.pm, eMark.id, { action: 'mark_risk', reason: '补标风险' });
    await actOk(U.pm, eUnmark.id, { action: 'unmark_risk', reason: '取消风险' });
    const view = await handoverGet(U.pm, s.batch1);
    const row = (e) => { const i = v(e.id, view); return [i.resolved, i.need_confirm, i.is_blocker, i.cleared]; };
    assert.deepStrictEqual(row(e1), [false, null, false, false], '未办结：不清');
    assert.ok(v(e1.id, view).reasons.includes('还没有办结'));
    assert.deepStrictEqual(row(e1r), [false, null, true, false], '带风险的未办结 = 阻塞项，先办结才能发起确认');
    assert.deepStrictEqual(row(e2), [true, null, false, true], '已处理：清');
    assert.deepStrictEqual(row(e3), [true, 'no_further', false, false], '不再处理：要确认');
    assert.deepStrictEqual(row(risk.handled), [true, null, false, true], '风险 + 已处理：不要确认');
    assert.deepStrictEqual(row(risk.adopted), [true, null, false, true], '风险 + 已采纳：不要确认');
    assert.deepStrictEqual(row(risk.not_adopted), [true, 'accept_issue', true, false], '风险 + 不采纳：阻塞项，要接受带此问题上线');
    assert.deepStrictEqual(row(eSys), [true, 'accept_issue', true, false], '风险 + 转系统迭代：要确认');
    assert.deepStrictEqual(row(eSys2), [true, null, false, true], '无风险转系统迭代：清');
    assert.deepStrictEqual(row(eMark), [true, 'accept_issue', true, false], '补标风险后：要确认');
    assert.deepStrictEqual(row(eUnmark), [true, null, false, true], '取消风险后：不要确认');
    assert.strictEqual(v(e3.id, view).confirm.purpose, 'handover_no_further');
    assert.strictEqual(v(risk.not_adopted.id, view).confirm.purpose, 'handover_accept_issue');
    assert.deepStrictEqual(v(e2.id, view).confirm, { purpose: null, state: 'none', fingerprint: v(e2.id, view).confirm.fingerprint, tasks: [] });
    // ⑦ 不再处理 + 带风险：取不再处理（一条确认，不拆成两条）
    const e7 = await regOk(U.pm, s.pid, { type: 'issue', is_risk: 1, title: '风险 + 不再处理' });
    await actOk(U.pm, e7.id, concl('no_further'));
    assert.strictEqual(v(e7.id, await handoverGet(U.pm, s.batch1)).need_confirm, 'no_further');
    // ⑧ 确认后：全部代表人确认 → 已清；汇总计数手写
    await requestAndConfirm(s.batch1, e3.id);
    await requestAndConfirm(s.batch1, risk.not_adopted.id);
    const after = await handoverGet(U.pm, s.batch1);
    assert.deepStrictEqual([v(e3.id, after).confirm.state, v(e3.id, after).cleared, v(risk.not_adopted.id, after).confirm.state, v(risk.not_adopted.id, after).cleared], ['confirmed', true, 'confirmed', true]);
    assert.strictEqual(v(eSys.id, after).cleared, false, '别的阻塞项仍未清');
    assert.deepStrictEqual(after.summary, {
      total: after.items.length, cleared: after.items.filter((i) => i.cleared).length, uncleared: after.items.filter((i) => !i.cleared).length,
      need_confirm: after.items.filter((i) => i.need_confirm !== null).length, confirmed: after.items.filter((i) => i.need_confirm !== null && i.confirm.state === 'confirmed').length,
    });
    assert.strictEqual(after.summary.confirmed, 2);
    assert.ok(after.summary.need_confirm >= 5);
  });

  // ═══════════════════════ 8 交接确认发起与决策 ═══════════════════════
  test(`${T_REQ}——POST /batches/:bid/handover/requests：PM 对已办结且需要确认的登记发起（用途自动判定）；确认人 = 每个需求部门生效代表人各一条；各前置 409（批次非进行中 / 不在集合 / 未办结 / 不需要 / 已有任务）；固定文案与决策取值；改发；无账号代表人代录；终止项目失效`, async () => {
    const s = await mkPlan({ partyB: true, batch2: true, m1: true });
    const i2 = await s.mkInPlan(s.batch2);
    const att = await stageAtt(s.pid, U.pm, 'e');
    const e = await blockerIssue(s, { attachment_ids: [att] });
    const url = (bid) => `/sysbuild/batches/${bid}/handover/requests`;
    // ① 权限与参数（检查顺序：参数 400 → 404 → 403 → 409）
    expectErr(await post(U.pm, url(s.batch1), {}), 400, 'SYSBUILD_INVALID_INPUT', '缺 entry_id');
    expectErr(await post(U.pm, url(s.batch1), { entry_id: e.id, x: 1 }), 400, 'SYSBUILD_INVALID_INPUT', '多余键');
    expectErr(await post(U.pm, url(s.batch1), { entry_id: 'abc' }), 400, 'SYSBUILD_INVALID_INPUT', 'entry_id 非法');
    expectErr(await post(U.pm, url(99999999), { entry_id: e.id }), 404, 'SYSBUILD_NOT_FOUND', '批次不存在');
    expectErr(await post(U.out, url(s.batch1), { entry_id: e.id }), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    for (const [uid, label] of [[U.m1, '一般成员'], [U.own, '负责人'], [U.del, '代表人'], [U.admin, 'admin 未接管'], [U.ro, '只读账号']]) {
      expectErr(await requestHo(uid, s.batch1, e.id), 403, 'SYSBUILD_FORBIDDEN', label);
    }
    const other = await mkPlan();
    const eOther = await blockerIssue(other);
    expectErr(await requestHo(U.pm, s.batch1, eOther.id), 400, 'SYSBUILD_INVALID_INPUT', '别的项目的登记');
    expectErr(await requestHo(U.pm, s.batch1, 99999999), 400, 'SYSBUILD_INVALID_INPUT', '登记不存在');
    expectErr(await requestHo(U.out, s.batch1, 99999999), 404, 'SYSBUILD_NOT_FOUND', '非成员对不存在的登记也先 404');
    expectErr(await requestHo(U.m1, s.batch1, 99999999), 403, 'SYSBUILD_FORBIDDEN', '无权限的人对不存在的登记先 403，不借 400 探测登记');
    // ② 409 各前置
    const eNot = await regOk(U.pm, s.pid, { type: 'feedback', title: '未办结' });
    const rNot = await requestHo(U.pm, s.batch1, eNot.id);
    expectErr(rNot, 409, 'SYSBUILD_STATE', '未办结');
    assert.ok(rNot.body.message.includes('还没有办结'), rNot.body.message);
    const eOk = await regOk(U.pm, s.pid, { type: 'feedback', title: '已处理' });
    await actOk(U.pm, eOk.id, CONCLUDE);
    const rOk = await requestHo(U.pm, s.batch1, eOk.id);
    expectErr(rOk, 409, 'SYSBUILD_STATE', '不需要');
    assert.ok(rOk.body.message.includes('不需要交接确认'), rOk.body.message);
    const eB2 = await regOk(U.pm, s.pid, { type: 'issue', is_risk: 1, item_ids: [i2.id], title: '第 2 批的阻塞项' });
    await actOk(U.pm, eB2.id, concl('not_adopted'));
    const rNotIn = await requestHo(U.pm, s.batch1, eB2.id);
    expectErr(rNotIn, 409, 'SYSBUILD_STATE', '不在本批集合');
    assert.ok(rNotIn.body.message.includes('不在本批的上线交接集合'), rNotIn.body.message);
    const rPlanning = await requestHo(U.pm, s.batch2, eB2.id);
    expectErr(rPlanning, 409, 'SYSBUILD_STATE', '批次规划中');
    assert.ok(rPlanning.body.message.includes('批次不是进行中'), rPlanning.body.message);
    // ③ 缺代表人：丙部只有负责人 → 拒绝并列出参与方
    const partyC = await addParty(s.pid, '丙部', 'demand');
    const mC = await addMember(s.pid, U.cand2, { party: partyC });
    await addAppointment(partyC, mC, 'active');
    const rMiss = await requestHo(U.pm, s.batch1, e.id);
    expectErr(rMiss, 409, 'SYSBUILD_STATE', '缺代表人');
    assert.strictEqual(rMiss.body.message, '以下参与方缺少生效代表人，无法发起交接确认：丙部');
    assert.strictEqual((await hoTasks(e.id)).length, 0, '被拒不建任务');
    assert.strictEqual((await itemOf(await handoverGet(U.pm, s.batch1), e.id).actions.handover_request), false, '标志同源为假');
    // 给丙部补一个无账号的生效代表人（只能代录）
    const mCdel = await sqlRun("INSERT INTO sysbuild_members (project_id, party_id, user_id, person_name, joined_at, added_by) VALUES (?, ?, NULL, '丙部代表（无账号）', '2026-10-01 10:00:00', ?)", [s.pid, partyC, U.admin]);
    const aptC = (await sqlGet("SELECT id FROM sysbuild_appointments WHERE party_id = ? AND status = 'active'", [partyC])).id;
    await addDelegation(partyC, mCdel.lastID, aptC, 'active');
    // ④ 成功：每个需求部门一条（甲 / 乙 / 丙），确认人 = 各自生效代表人；任务字段手写核对
    const flagBefore = itemOf(await handoverGet(U.pm, s.batch1), e.id).actions.handover_request;
    assert.strictEqual(flagBefore, true, '标志为真');
    const fp = (await sqlGet('SELECT MAX(id) AS m FROM sysbuild_entry_actions WHERE entry_id = ?', [e.id])).m;
    const ok = await requestHo(U.pm, s.batch1, e.id);
    assert.strictEqual(ok.status, 201, ok.text);
    const tasks = await hoTasks(e.id);
    assert.strictEqual(tasks.length, 3);
    assert.deepStrictEqual(tasks.map((t) => [t.object_type, t.object_id, t.object_version_id, t.purpose, t.status, t.rev_no]), tasks.map(() => ['handover', e.id, fp, 'handover_accept_issue', 'pending', 1]), '对象 = 登记，版本号 = 状态指纹（最后一条办理动作编号）');
    assert.deepStrictEqual(tasks.map((t) => t.party_id), [s.A, s.B, partyC]);
    assert.deepStrictEqual(tasks.map((t) => t.user_id), [U.del, U.x2, null], '确认人 = 各方生效代表人（丙部无账号）');
    assert.strictEqual(ok.body.tasks.length, 3);
    assert.strictEqual(ok.body.tasks.find((t) => t.party_id === partyC).proxy_only, true);
    assert.deepStrictEqual(ok.body.item.confirm.state, 'pending');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_frozen_attachments WHERE object_type = 'entry' AND object_version_id = ?", [e.id]), 1, '登记附件冻结（与结论任务共用一份清单）');
    const hev = (await payloads(s.pid, 'handover_requested')).filter((p) => p.task_ids.length === 3);
    assert.strictEqual(hev.length, 1);
    assert.deepStrictEqual([hev[0].batch_id, hev[0].purpose, hev[0].need_confirm, hev[0].fingerprint], [s.batch1, 'handover_accept_issue', 'accept_issue', fp]);
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_events WHERE project_id = ? AND event_type = 'confirm_task_created' AND object_type = 'confirm_task' AND payload_json LIKE '%\"object_type\":\"handover\"%'", [s.pid]), 3);
    // ⑤ 已有任务：再发起 409（任一状态）；标志为假
    const dup = await requestHo(U.pm, s.batch1, e.id);
    expectErr(dup, 409, 'SYSBUILD_STATE', '已有任务');
    assert.ok(dup.body.message.includes('已有当前有效的交接确认任务（待确认）'), dup.body.message);
    assert.strictEqual(itemOf(await handoverGet(U.pm, s.batch1), e.id).actions.handover_request, false);
    // ⑥ 打开任务（代表人本人）：对象视图、固定文案、冻结清单；非必需确认人 403
    const taskA = tasks.find((t) => t.party_id === s.A);
    const open = await get(U.del, `/sysbuild/confirm-tasks/${taskA.task_id}`);
    assert.strictEqual(open.status, 200, open.text);
    assert.deepStrictEqual(open.body.checkbox_texts, { confirm: HO_CONFIRM.handover_accept_issue, object: HO_OBJECT, reject: HO_REJECT }, '交接确认的固定文案按用途分设');
    assert.deepStrictEqual([open.body.object.type, open.body.object.purpose, open.body.object.entry.id, open.body.object.entry.risk_current, open.body.object.conclusion.kind, open.body.object.fingerprint_current],
      ['handover', 'handover_accept_issue', e.id, true, 'not_adopted', true]);
    assert.strictEqual(open.body.frozen_attachments.length, 1);
    assert.deepStrictEqual([open.body.actions.decide, open.body.actions.reissue, open.body.actions.proxy], [true, false, false], '代表人本人：能决策，不能改发 / 代录（PM 才能）');
    const openOwn = await get(U.own, `/sysbuild/confirm-tasks/${taskA.task_id}`);
    assert.strictEqual(openOwn.body.actions.decide, false, '负责人不是这条任务的必需确认人（交接确认只认代表人）');
    // ⑦ 决策：取值与文案校验（400）、非必需确认人 403、确认成功
    const dec = (uid, tid, body) => post(uid, `/sysbuild/confirm-tasks/${tid}/decide`, body);
    const base = { revision_id: open.body.revision.id, object_version_id: open.body.task.object_version_id };
    const r1 = await dec(U.del, taskA.task_id, Object.assign({}, base, { decision: 'object', checkbox_text: HO_OBJECT, reason: '有意见' }));
    expectErr(r1, 400, 'SYSBUILD_INVALID_INPUT', '交接确认不收 object');
    assert.strictEqual(r1.body.field, 'decision');
    const r2 = await dec(U.del, taskA.task_id, Object.assign({}, base, { decision: 'confirm', checkbox_text: GENERIC_CONFIRM }));
    expectErr(r2, 400, 'SYSBUILD_INVALID_INPUT', '通用文案不能用于交接确认');
    assert.strictEqual(r2.body.field, 'checkbox_text');
    const r3 = await dec(U.del, taskA.task_id, Object.assign({}, base, { decision: 'confirm', checkbox_text: HO_CONFIRM.handover_no_further }));
    expectErr(r3, 400, 'SYSBUILD_INVALID_INPUT', '别的用途的文案');
    const r4 = await dec(U.del, taskA.task_id, Object.assign({}, base, { decision: 'reject', checkbox_text: HO_REJECT }));
    expectErr(r4, 400, 'SYSBUILD_INVALID_INPUT', '不认可必须写原因');
    assert.strictEqual(r4.body.field, 'reason');
    expectErr(await dec(U.own, taskA.task_id, Object.assign({}, base, { decision: 'confirm', checkbox_text: HO_CONFIRM.handover_accept_issue })), 403, 'SYSBUILD_FORBIDDEN', '负责人不是必需确认人');
    const okA = await dec(U.del, taskA.task_id, Object.assign({}, base, { decision: 'confirm', checkbox_text: HO_CONFIRM.handover_accept_issue }));
    assert.strictEqual(okA.status, 200, okA.text);
    assert.deepStrictEqual([okA.body.decision, okA.body.revision.status, okA.body.handover.entry_id, okA.body.handover.fingerprint_current], ['confirm', 'confirmed', e.id, true]);
    const cf = await sqlGet("SELECT method, decision, checkbox_text FROM sysbuild_confirmations WHERE task_revision_id = ?", [open.body.revision.id]);
    assert.deepStrictEqual([cf.method, cf.decision, cf.checkbox_text], ['platform', 'confirm', HO_CONFIRM.handover_accept_issue], '确认记录保存实际提交的文案');
    assert.strictEqual(itemOf(await handoverGet(U.pm, s.batch1), e.id).confirm.state, 'pending', '乙部 / 丙部还没确认');
    // ⑧ 乙部不认可 → declined，不清；同一状态指纹下不能再发起、不能改发（P165：不认可不能靠重新发起或改发绕过，照 dev_entry 先例）；
    //   出路 = 办理 / 改结论让登记状态变化（指纹变化），之后重新发起三个新任务；乙部确认；丙部无账号 → PM 代录
    const taskB = tasks.find((t) => t.party_id === s.B);
    const rej = await decideHo(U.x2, taskB.task_id, 'reject');
    assert.strictEqual(rej.status, 200, rej.text);
    let view = await handoverGet(U.pm, s.batch1);
    assert.deepStrictEqual([itemOf(view, e.id).confirm.state, itemOf(view, e.id).cleared], ['declined', false], '有代表人不认可：整体 declined，不清');
    const rDeclined = await requestHo(U.pm, s.batch1, e.id);
    expectErr(rDeclined, 409, 'SYSBUILD_STATE', '同一指纹已有不认可');
    assert.ok(rDeclined.body.message.includes('不认可') && rDeclined.body.message.includes('须先写答复'), rDeclined.body.message);
    assert.deepStrictEqual([itemOf(view, e.id).reply_required, itemOf(view, e.id).actions.handover_request], [true, true], 'P174：要答复；标志按「带答复发起」算为真（不带答复发起仍 409）');
    expectErr(await post(U.m1, `/sysbuild/confirm-tasks/${taskB.task_id}/reissue`, { reason: '改发' }), 403, 'SYSBUILD_FORBIDDEN', '非 PM 不能改发');
    const reB = await post(U.pm, `/sysbuild/confirm-tasks/${taskB.task_id}/reissue`, { reason: '请乙部代表人重新确认' });
    expectErr(reB, 409, 'SYSBUILD_STATE', '不认可后不能改发');
    assert.ok(reB.body.message.includes('不能改发'), reB.body.message);
    assert.strictEqual((await get(U.pm, `/sysbuild/confirm-tasks/${taskB.task_id}`)).body.actions.reissue, false, '读接口的改发标志同为假');
    assert.strictEqual((await hoTasks(e.id))[1].rev_no, 1, '被拒的改发不产生新修订');
    const rejA = await post(U.pm, `/sysbuild/confirm-tasks/${taskA.task_id}/reissue`, { reason: '已确认的也不能改发' });
    expectErr(rejA, 409, 'SYSBUILD_STATE', '已确认的任务不能改发');
    // 更正只让指纹变化、不解除不认可（P173）：旧任务作废，但仍判 declined，不能重新发起；出路：新的结论类动作（改结论），旧任务全部作废（甲部已确认的也不再算数），之后重新发起三个新任务
    await actOk(U.pm, e.id, { action: 'correct', text: '更正：补充说明，请各代表人重新确认' });
    view = await handoverGet(U.pm, s.batch1);
    assert.deepStrictEqual([itemOf(view, e.id).confirm.state, itemOf(view, e.id).reply_required], ['declined', true], '更正不解除不认可');
    expectErr(await requestHo(U.pm, s.batch1, e.id), 409, 'SYSBUILD_STATE', '更正后仍不能重新发起');
    // 解除不认可的完整路径（已确认的结论不能再给结论，作废 / 结论失效后重给结论的路径在 T_DECL 用例）见该用例；这里换一条新的阻塞项走完 甲 / 乙 确认 + 丙 代录 的成功路径
    const eS = await blockerIssue(s);
    const again = await requestHo(U.pm, s.batch1, eS.id);
    assert.strictEqual(again.status, 201, again.text);
    const tasks2 = await hoTasks(eS.id);
    assert.strictEqual(tasks2.length, 3, '三个新任务');
    const taskA2 = tasks2.find((t) => t.party_id === s.A);
    const taskB2 = tasks2.find((t) => t.party_id === s.B);
    assert.strictEqual((await decideHo(U.del, taskA2.task_id, 'confirm')).status, 200);
    assert.strictEqual((await decideHo(U.x2, taskB2.task_id, 'confirm')).status, 200);
    const taskC = tasks2.find((t) => t.party_id === partyC);
    const openC = await get(U.pm, `/sysbuild/confirm-tasks/${taskC.task_id}`);
    assert.strictEqual(openC.body.actions.proxy, true, '无账号代表人的任务 PM 可代录');
    const pxC = await post(U.pm, `/sysbuild/confirm-tasks/${taskC.task_id}/proxy`, {
      revision_id: openC.body.revision.id, object_version_id: openC.body.task.object_version_id, decision: 'confirm', external_date: today(), actual_confirmer: '丙部代表', identity_basis: '电话确认，凭据见附件',
      attachment_ids: [await stageAtt(s.pid, U.pm, 'f')],
    });
    assert.strictEqual(pxC.status, 200, pxC.text);
    view = await handoverGet(U.pm, s.batch1);
    assert.deepStrictEqual([itemOf(view, eS.id).confirm.state, itemOf(view, eS.id).cleared], ['confirmed', true], '三个需求部门都确认（含代录）= 已清');
    assert.deepStrictEqual(itemOf(view, eS.id).confirm.tasks.map((t) => [t.party_name, t.status]), [['甲部', 'confirmed'], ['乙部', 'confirmed'], ['丙部', 'confirmed']]);
    assert.deepStrictEqual([itemOf(view, e.id).confirm.state, itemOf(view, e.id).cleared], ['declined', false], '被不认可的那条仍未解除、未清');
    // 登记状态指纹的页面读法：任务读接口 fingerprint_current 仍为真
    assert.strictEqual((await get(U.pm, `/sysbuild/confirm-tasks/${taskA2.task_id}`)).body.object.fingerprint_current, true);
  });

  // ═══════════════════════ 9 状态指纹失效（P149）═══════════════════════
  test(`${T_FP}——发起时记下登记最后一条办理动作的编号；之后登记有新的办理动作 → 未完成的修订同一事务置已失效（原因「问题状态已变化」），已确认的也不再算数（lapsed，不清），须重新发起（新任务按新指纹）；项目终止时待确认的交接确认失效、重开后可改发`, async () => {
    const s = await mkPlan();
    const e1 = await blockerIssue(s, { title: '确认后状态变化' });
    const e2 = await blockerIssue(s, { title: '待确认时状态变化' });
    await requestAndConfirm(s.batch1, e1.id);
    assert.strictEqual(itemOf(await handoverGet(U.pm, s.batch1), e1.id).cleared, true, '前置：已确认 = 已清');
    const r2 = await requestHo(U.pm, s.batch1, e2.id);
    assert.strictEqual(r2.status, 201, r2.text);
    const t2 = (await hoTasks(e2.id))[0];
    // ① 已确认之后登记有新的办理动作（更正）：不再算数，不清；已确认的修订不动；再发起 201（新指纹）
    await actOk(U.pm, e1.id, { action: 'correct', text: '更正：补充说明风险影响范围' });
    const v1 = itemOf(await handoverGet(U.pm, s.batch1), e1.id);
    assert.deepStrictEqual([v1.confirm.state, v1.cleared, v1.confirm.tasks], ['lapsed', false, []], '旧任务的指纹已过期：lapsed');
    assert.strictEqual((await hoTasks(e1.id))[0].status, 'confirmed', '已确认的修订不动（判已清时按指纹不再算数）');
    assert.strictEqual((await requestHo(U.pm, s.batch1, e1.id)).status, 201, '指纹过期后可以重新发起');
    assert.strictEqual((await hoTasks(e1.id)).length, 2, '旧任务保留，新任务另起');
    // ② 待确认时登记有新办理动作：修订同一事务置已失效，事件带原因；任务在读接口里 object.fingerprint_current 为假、decide 409
    await actOk(U.pm, e2.id, { action: 'mark_commitment', reason: '补标涉及承诺' });
    const t2after = (await hoTasks(e2.id))[0];
    assert.deepStrictEqual([t2after.status, t2after.status_reason], ['invalid', '问题状态已变化']);
    const inv = (await payloads(s.pid, 'confirm_revision_invalidated')).filter((p) => p.entry_id === e2.id && p.object_type === 'handover');
    assert.strictEqual(inv.length, 1);
    assert.strictEqual(inv[0].reason, '问题状态已变化');
    const ao = (await payloads(s.pid, 'entry_action_recorded')).filter((p) => p.closed_revision_ids.includes(t2.rev_id));
    assert.strictEqual(ao.length, 1, '办理动作事件的 closed_revision_ids 带上失效的交接确认修订');
    const open2 = await get(U.del, `/sysbuild/confirm-tasks/${t2.task_id}`);
    assert.strictEqual(open2.body.object.fingerprint_current, false);
    assert.strictEqual(open2.body.actions.decide, false);
    const stale = await decideHo(U.del, t2.task_id, 'confirm');
    expectErr(stale, 409, 'SYSBUILD_STATE', '修订已失效');
    // 指纹过期的任务不能改发（任务作废，重新发起）
    expectErr(await post(U.pm, `/sysbuild/confirm-tasks/${t2.task_id}/reissue`, { reason: '想改发' }), 409, 'SYSBUILD_STATE', '指纹过期的任务不能改发');
    // 第二层兜底的单独证明：修订仍待确认、任务指纹却已过期（夹具：把任务指纹往回拨一格，等于绕过失效钩子）→ 改发被指纹判据本身拒绝，文案指向重新发起
    const e4 = await blockerIssue(s, { title: '指纹过期但修订仍待确认' });
    assert.strictEqual((await requestHo(U.pm, s.batch1, e4.id)).status, 201);
    const t4 = (await hoTasks(e4.id))[0];
    await sqlRun('UPDATE sysbuild_confirm_tasks SET object_version_id = object_version_id - 1 WHERE id = ?', [t4.task_id]);
    const rs4 = await post(U.pm, `/sysbuild/confirm-tasks/${t4.task_id}/reissue`, { reason: '想改发' });
    expectErr(rs4, 409, 'SYSBUILD_STATE', '指纹过期、修订待确认');
    assert.strictEqual((await get(U.pm, `/sysbuild/confirm-tasks/${t4.task_id}`)).body.actions.reissue, false, '读接口的改发标志同为假');
    await sqlRun('UPDATE sysbuild_confirm_tasks SET object_version_id = object_version_id + 1 WHERE id = ?', [t4.task_id]);
    // ③ 重新发起：新任务按新指纹，旧任务保留
    const again = await requestHo(U.pm, s.batch1, e2.id);
    assert.strictEqual(again.status, 201, again.text);
    const ts = await hoTasks(e2.id);
    assert.strictEqual(ts.length, 2);
    assert.ok(ts[1].object_version_id > ts[0].object_version_id, '新任务的指纹 = 新的最后一条办理动作编号');
    assert.strictEqual(ts[1].status, 'pending');
    assert.strictEqual((await decideHo(U.del, ts[1].task_id, 'confirm')).status, 200);
    assert.strictEqual(itemOf(await handoverGet(U.pm, s.batch1), e2.id).cleared, true, '按新指纹确认后已清');
    // ④ 新办理动作的种类不限：只追加办理记录的「记系统迭代单号」也让已确认的交接确认不再算数
    await actOk(U.pm, e2.id, { action: 'link_sys_issue', sys_issue_no: 'SI-900', text: '记下系统迭代单号' });
    const v2c = itemOf(await handoverGet(U.pm, s.batch1), e2.id);
    assert.deepStrictEqual([v2c.confirm.state, v2c.cleared], ['lapsed', false]);
    // ⑤ 项目终止：待确认的交接确认修订失效（原因「项目已终止」，推进类确认终止后不可作出）；重开后 PM 可改发（指纹未变）
    const e3 = await blockerIssue(s, { title: '终止时待确认' });
    assert.strictEqual((await requestHo(U.pm, s.batch1, e3.id)).status, 201);
    const t3 = (await hoTasks(e3.id))[0];
    assert.strictEqual((await setStatus(s.pid, 'terminated')).status, 200);
    const t3t = (await hoTasks(e3.id))[0];
    assert.deepStrictEqual([t3t.status, t3t.status_reason], ['invalid', '项目已终止']);
    assert.strictEqual((await setStatus(s.pid, 'active')).status, 200);
    const reis = await post(U.pm, `/sysbuild/confirm-tasks/${t3.task_id}/reissue`, { reason: '项目重开后改发' });
    assert.strictEqual(reis.status, 200, reis.text);
    assert.strictEqual((await decideHo(U.del, t3.task_id, 'confirm')).status, 200);
    assert.strictEqual(itemOf(await handoverGet(U.pm, s.batch1), e3.id).cleared, true);
  });

  // ═══════════════════════ 10 确认试运行结束（上线 / 再上线）═══════════════════════
  test(`${T_GOLIVE}——POST /batches/:bid/golive：PM；前置在写事务内按当时完整集合重核（本批非里程碑节点全部收口、批次验收包已生效、交接集合每项已清；任一不满足 409 SYSBUILD_GOLIVE_BLOCKED 并列出每一项）；暂停 / 终止 409；非 PM 403；成功写上线事件（快照 = 完整集合与每项判定）、批次 → 已上线、里程碑 → 已收口并写实际结束；再上线 kind = regolive`, async () => {
    const s = await mkPlan({ m1: true, batch2: 'active' });
    const bReq = await nodeIdOf(s.pid, 'b_req');
    const bDev = await nodeIdOf(s.pid, 'b_dev');
    const bGolive = await nodeIdOf(s.pid, 'b_golive');
    // ① 前置：节点未收口 + 验收包未生效（两项都列出，带节点编号与节点名）
    const r0 = await goliveReq(U.pm, s.batch1);
    expectErr(r0, 409, 'SYSBUILD_GOLIVE_BLOCKED', '前置全不满足');
    assert.deepStrictEqual(r0.body.blockers.map((b) => b.code), ['NODES_NOT_CLOSED', 'ACCEPT_NOT_EFFECTIVE']);
    assert.deepStrictEqual(r0.body.blockers[0].node_ids, [bReq, bDev]);
    assert.ok(r0.body.blockers[0].message.includes('需求确认') && r0.body.blockers[0].message.includes('开发完成（含设计）'), r0.body.blockers[0].message);
    assert.strictEqual(r0.body.blockers[1].message, '本批批次验收包还没有生效版本');
    assert.strictEqual(r0.body.message, `上线前置条件未满足：${r0.body.blockers.map((b) => b.message).join('；')}`);
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_golive_events WHERE batch_id = ?', [s.batch1]), 0, '被拒不写事件');
    assert.strictEqual((await batchRow(s.batch1)).status, 'active');
    assert.strictEqual((await nodeRow(bGolive)).status, 'not_started', '被拒不动里程碑');
    // 读接口的阻塞项与执行同一个函数
    const v0 = await handoverGet(U.pm, s.batch1);
    assert.deepStrictEqual(v0.blockers, r0.body.blockers);
    assert.strictEqual(v0.actions.golive, false);
    // ② 验收包生效 + 节点逐个收口（别的批次的验收包生效不算本批：先生效第 2 批的验收包，本批仍报验收包未生效）
    await H.acceptEffective(s.pid, s.batch2);
    assert.deepStrictEqual((await goliveReq(U.pm, s.batch1)).body.blockers.map((b) => b.code), ['NODES_NOT_CLOSED', 'ACCEPT_NOT_EFFECTIVE'], '第 2 批的验收包生效不算本批');
    await H.acceptEffective(s.pid, s.batch1);
    const r1 = await goliveReq(U.pm, s.batch1);
    assert.deepStrictEqual(r1.body.blockers.map((b) => b.code), ['NODES_NOT_CLOSED'], '只剩节点');
    await startNode(s.pid, 'b_req');
    assert.strictEqual((await closeNodeReq(bReq)).status, 200);
    assert.deepStrictEqual((await goliveReq(U.pm, s.batch1)).body.blockers[0].node_ids, [bDev], '只剩 b_dev（未开始的节点也算未收口）');
    await startNode(s.pid, 'b_dev');
    assert.strictEqual((await closeNodeReq(bDev)).status, 200);
    // ③ 交接集合：未办结的登记 / 已办结但要确认而没确认的登记
    const eU = await regOk(U.pm, s.pid, { type: 'feedback', title: '还没办完' });
    const eR = await regOk(U.pm, s.pid, { type: 'feedback', title: '不再处理的' });
    await actOk(U.pm, eR.id, concl('no_further'));
    const r2 = await goliveReq(U.pm, s.batch1);
    expectErr(r2, 409, 'SYSBUILD_GOLIVE_BLOCKED', '交接未清');
    assert.deepStrictEqual(r2.body.blockers.map((b) => [b.code, b.entry_ids]), [['HANDOVER_UNCLEARED', [eU.id, eR.id].sort((a, b) => a - b)]]);
    assert.ok(r2.body.blockers[0].message.includes('2 项没有清') && r2.body.blockers[0].message.includes(`#${eU.id}`), r2.body.blockers[0].message);
    await actOk(U.pm, eU.id, CONCLUDE);
    assert.deepStrictEqual((await goliveReq(U.pm, s.batch1)).body.blockers[0].entry_ids, [eR.id], '办结后只剩要确认的那条');
    await requestAndConfirm(s.batch1, eR.id);
    // ④ 按当时完整集合重核：页面上看到「已清」之后登记又有新办理动作 → 执行时重核仍 409（不信任何事先看到的清单）
    const seen = itemOf(await handoverGet(U.pm, s.batch1), eR.id);
    assert.strictEqual(seen.cleared, true, '前置：页面上看到已清');
    await actOk(U.pm, eR.id, { action: 'correct', text: '更正说明' });
    const r3 = await goliveReq(U.pm, s.batch1);
    expectErr(r3, 409, 'SYSBUILD_GOLIVE_BLOCKED', '重核');
    assert.deepStrictEqual(r3.body.blockers[0].entry_ids, [eR.id]);
    await requestAndConfirm(s.batch1, eR.id);
    // ⑤ 权限 / 项目状态 / 批次状态 / 参数（检查顺序：400 → 404 → 403 → 409 项目状态 → 409 批次状态 → 409 前置）
    for (const [uid, label] of [[U.m1, '一般成员'], [U.own, '负责人'], [U.del, '代表人'], [U.admin, 'admin 未接管'], [U.ro, '只读账号']]) {
      expectErr(await goliveReq(uid, s.batch1), 403, 'SYSBUILD_FORBIDDEN', label);
    }
    expectErr(await goliveReq(U.out, s.batch1), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    expectErr(await goliveReq(U.pm, 99999999), 404, 'SYSBUILD_NOT_FOUND', '批次不存在');
    expectErr(await goliveReq(U.pm, 'abc'), 400, 'SYSBUILD_INVALID_INPUT', '编号非法');
    expectErr(await goliveReq(U.pm, s.batch1, { x: 1 }), 400, 'SYSBUILD_INVALID_INPUT', '多余键');
    assert.strictEqual((await setStatus(s.pid, 'paused')).status, 200);
    expectErr(await goliveReq(U.pm, s.batch1), 409, 'SYSBUILD_PROJECT_READONLY', '暂停');
    assert.strictEqual((await handoverGet(U.pm, s.batch1)).actions.golive, false, '暂停时标志同源为假');
    assert.strictEqual((await setStatus(s.pid, 'active')).status, 200);
    await sqlRun("UPDATE sysbuild_batches SET status = 'planning' WHERE id = ?", [s.batch1]);
    const rPl = await goliveReq(U.pm, s.batch1);
    expectErr(rPl, 409, 'SYSBUILD_STATE', '批次规划中');
    assert.ok(rPl.body.message.includes('还没有进入进行中'), rPl.body.message);
    await sqlRun("UPDATE sysbuild_batches SET status = 'active' WHERE id = ?", [s.batch1]);
    // ⑥ 成功
    const pre = await handoverGet(U.pm, s.batch1);
    assert.deepStrictEqual(pre.blockers, []);
    assert.strictEqual(pre.actions.golive, true, '标志为真');
    const ok = await goliveReq(U.pm, s.batch1);
    assert.strictEqual(ok.status, 200, ok.text);
    assert.deepStrictEqual([ok.body.batch.status, ok.body.golive_event.kind, ok.body.milestone_node_id], ['live', 'golive', bGolive]);
    assert.deepStrictEqual(ok.body.summary, pre.summary, '响应的汇总 = 重核时的集合汇总');
    const evs = await eventsAll(s.batch1);
    assert.strictEqual(evs.length, 1);
    assert.deepStrictEqual([evs[0].kind, evs[0].reason, evs[0].created_by], ['golive', null, U.pm]);
    const snap = JSON.parse(evs[0].handover_snapshot_json);
    assert.deepStrictEqual(Object.keys(snap).sort(), ['items', 'summary']);
    const cmp = (items) => items.map((i) => [i.entry_id, i.cleared, i.need_confirm, i.confirm.state, i.conclusion_kind]);
    assert.deepStrictEqual(cmp(snap.items), cmp(pre.items), '快照 = 重核时的完整集合及每项判定（与读接口同源）');
    assert.deepStrictEqual(snap.summary, pre.summary);
    assert.ok(snap.items.length >= 2 && snap.items.every((i) => i.cleared === true));
    assert.strictEqual((await batchRow(s.batch1)).status, 'live');
    const ms = await nodeRow(bGolive);
    assert.strictEqual(ms.status, 'closed');
    assert.ok(ms.opened_at && ms.closed_at, '里程碑（未开始）收口时一并写开始 / 结束时刻');
    const recs = await sqlAll("SELECT kind, actual_date FROM sysbuild_node_schedule_records WHERE node_id = ? AND kind IN ('actual_start', 'actual_end') ORDER BY id", [bGolive]);
    assert.deepStrictEqual(recs.map((r) => [r.kind, r.actual_date]), [['actual_start', today()], ['actual_end', today()]], '实际开始 / 结束记当天');
    const rec = (await payloads(s.pid, 'golive_recorded')).filter((p) => p.golive_event_id === ok.body.golive_event.id);
    assert.deepStrictEqual(rec, [{ kind: 'golive', golive_event_id: ok.body.golive_event.id, via: 'golive', milestone_node_id: bGolive }]);
    const bsc = (await payloads(s.pid, 'batch_status_changed')).filter((p) => p.via === 'golive');
    assert.deepStrictEqual(bsc, [{ from: 'active', to: 'live', via: 'golive', golive_event_id: ok.body.golive_event.id }]);
    const nc = (await payloads(s.pid, 'node_closed')).filter((p) => p.via === 'golive');
    assert.deepStrictEqual(nc, [{ actual_date: today(), via: 'golive', golive_event_id: ok.body.golive_event.id, from: 'not_started' }]);
    // ⑦ 上线之后：再上线 409；里程碑不能重开；本批节点不能重开；读接口的已上线 / 上线进度（事件回拨后）
    expectErr(await goliveReq(U.pm, s.batch1), 409, 'SYSBUILD_STATE', '已上线再上线');
    expectErr(await post(U.pm, `/sysbuild/nodes/${bGolive}/reopen`, { reason: '想重开' }), 409, 'SYSBUILD_STATE', '里程碑不能重开');
    expectErr(await post(U.pm, `/sysbuild/nodes/${bReq}/reopen`, { reason: '想重开' }), 409, 'SYSBUILD_STATE', '已上线批次的节点不能重开');
    await backdate(ok.body.golive_event.id);
    const plan = (await get(U.pm, `/sysbuild/projects/${s.pid}/plan`)).body;
    assert.deepStrictEqual(plan.project.golive_progress, { live: 1, total: 2, transferred: 0 }, '上线进度 1/2（第 2 批进行中，未上线）');
    const pb = plan.batches[0];
    assert.strictEqual(pb.live, true);
    assert.deepStrictEqual([pb.last_golive_event.kind, pb.last_golive_event.by, pb.last_golive_event.id, typeof pb.last_golive_event.at, pb.last_golive_event.reason], ['golive', U.pm, ok.body.golive_event.id, 'string', null]);
    assert.ok(typeof pb.last_golive_event.by_name === 'string' && pb.last_golive_event.by_name.length > 0, '带操作人显示名');
    assert.deepStrictEqual([pb.actions.golive, pb.actions.revoke_golive], [false, false], 'PM 视角：已上线不能再上线、撤销只有 admin');
    const adminPlan = (await get(U.admin, `/sysbuild/projects/${s.pid}/plan`)).body;
    assert.deepStrictEqual([adminPlan.batches[0].actions.golive, adminPlan.batches[0].actions.revoke_golive], [false, true], 'admin 视角：可撤销');
    expectErr(await reg(U.pm, s.pid, { type: 'issue', item_ids: [s.i1.id] }), 409, 'SYSBUILD_STATE', '上线后分流判已上线');
  });

  // ═══════════════════════ 11 撤销上线 ═══════════════════════
  test(`${T_REVOKE}——POST /batches/:bid/revoke-golive：admin（不必接管）写原因；批次须已上线、项目进行中 / 已暂停（已终止 / 已结项 409）、没有待确认的结项包（P150）；成功：revoke 事件、批次 → 进行中、里程碑 → 进行中并写节点事件、本批其他已收口节点不动；已确认的交接确认不因撤销失效；再上线走全部前置，kind = regolive`, async () => {
    const s = await mkPlan({ m1: true });
    const bGolive = await nodeIdOf(s.pid, 'b_golive');
    const bReq = await nodeIdOf(s.pid, 'b_req');
    const eB = await blockerIssue(s, { title: '要交接确认的阻塞项' });
    await ready(s);
    await requestAndConfirm(s.batch1, eB.id);
    // ① 批次还没上线：409
    const reasonBody = { reason: '上线后发现数据问题，需要撤销。'.padEnd(500, '补') }; // 恰 500 个字符：原因长度的边界通过
    assert.strictEqual(Array.from(reasonBody.reason).length, 500);
    expectErr(await revokeReq(U.admin, s.batch1, reasonBody), 409, 'SYSBUILD_STATE', '批次未上线');
    const g1 = await goLive(s);
    assert.deepStrictEqual((await get(U.pm, `/sysbuild/projects/${s.pid}/plan`)).body.project.golive_progress, { live: 1, total: 1, transferred: 0 }, '上线后进度计 1 个已上线批次');
    // 预筛 LOW-5：项目详情（GET /projects/:id）也带 golive_progress，与 GET /plan 同一个函数
    assert.deepStrictEqual((await get(U.pm, `/sysbuild/projects/${s.pid}`)).body.project.golive_progress, { live: 1, total: 1, transferred: 0 }, '项目详情的上线进度与计划视图同源');
    // ② 权限 / 参数（400 → 404 → 403 → 409）
    for (const [uid, label] of [[U.pm, 'PM（撤销只有 admin）'], [U.m1, '一般成员'], [U.own, '负责人'], [U.ro, '只读账号']]) {
      expectErr(await revokeReq(uid, s.batch1, reasonBody), 403, 'SYSBUILD_FORBIDDEN', label);
    }
    expectErr(await revokeReq(U.out, s.batch1, reasonBody), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    expectErr(await revokeReq(U.admin, 99999999, reasonBody), 404, 'SYSBUILD_NOT_FOUND', '批次不存在');
    for (const [body, label] of [[{}, '缺原因'], [{ reason: '   ' }, '空白原因'], [{ reason: '含控制字符\u0001' }, '控制字符'], [{ reason: 'x'.repeat(501) }, '超长原因'], [{ reason: 123 }, '非文本原因'], [{ reason: '原因', x: 1 }, '多余键']]) {
      const r = await revokeReq(U.admin, s.batch1, body);
      expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', label);
    }
    // ③ 项目状态：已终止 / 已结项 409（已结项须先由 admin 重开）；已暂停可撤销（见 ⑤）
    assert.strictEqual((await setStatus(s.pid, 'terminated')).status, 200);
    expectErr(await revokeReq(U.admin, s.batch1, reasonBody), 409, 'SYSBUILD_PROJECT_READONLY', '已终止');
    assert.strictEqual((await setStatus(s.pid, 'active')).status, 200);
    await sqlRun("UPDATE sysbuild_projects SET status = 'closed' WHERE id = ?", [s.pid]); // 夹具：已结项（整体结项的生产路径见 T_CLOSE）
    expectErr(await revokeReq(U.admin, s.batch1, reasonBody), 409, 'SYSBUILD_PROJECT_READONLY', '已结项');
    await sqlRun("UPDATE sysbuild_projects SET status = 'active' WHERE id = ?", [s.pid]);
    // ④ 有待确认的结项包 409（P150）；撤回结项包后放行
    const clV = await mkVersion(await mkPackage(s.pid, 'closing'));
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${clV}/submit`)).status, 200);
    const rCl = await revokeReq(U.admin, s.batch1, reasonBody);
    expectErr(rCl, 409, 'SYSBUILD_STATE', '结项包待确认');
    assert.ok(rCl.body.message.includes('待确认的结项包'), rCl.body.message);
    assert.strictEqual((await handoverGet(U.admin, s.batch1)).actions.revoke_golive, false, '标志同源为假');
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${clV}/withdraw`, { reason: '先撤回结项包' })).status, 200);
    assert.strictEqual((await handoverGet(U.admin, s.batch1)).actions.revoke_golive, true, '标志为真');
    // ⑤ 成功（暂停中也可撤销）：revoke 事件只追加、批次 → 进行中、里程碑 → 进行中、其他已收口节点不动
    const nBefore = (await eventsAll(s.batch1)).length;
    assert.strictEqual((await setStatus(s.pid, 'paused')).status, 200);
    const ok = await revokeReq(U.admin, s.batch1, reasonBody);
    assert.strictEqual(ok.status, 200, ok.text);
    assert.deepStrictEqual([ok.body.batch.status, ok.body.golive_event.kind, ok.body.milestone_node_id], ['active', 'revoke', bGolive]);
    const evs = await eventsAll(s.batch1);
    assert.strictEqual(evs.length, nBefore + 1, '上线事件只追加');
    const last = evs[evs.length - 1];
    assert.deepStrictEqual([last.kind, last.reason, last.created_by, last.handover_snapshot_json], ['revoke', reasonBody.reason, U.admin, null]);
    assert.strictEqual((await batchRow(s.batch1)).status, 'active');
    const ms = await nodeRow(bGolive);
    assert.deepStrictEqual([ms.status, ms.closed_at], ['in_progress', null], '里程碑 → 进行中（closed_at 清空）');
    assert.strictEqual((await nodeRow(bReq)).status, 'closed', '本批其他已收口节点不动');
    const reopened = (await payloads(s.pid, 'node_reopened')).filter((p) => p.via === 'revoke_golive');
    assert.deepStrictEqual(reopened, [{ reason: reasonBody.reason, via: 'revoke_golive', golive_event_id: last.id }], '里程碑节点事件一条');
    const rv = (await payloads(s.pid, 'golive_revoked')).pop();
    assert.deepStrictEqual(rv, { golive_event_id: last.id, reason: reasonBody.reason, milestone_node_id: bGolive });
    const bsc = (await payloads(s.pid, 'batch_status_changed')).filter((p) => p.via === 'revoke_golive').pop();
    assert.deepStrictEqual(bsc, { from: 'live', to: 'active', via: 'revoke_golive', golive_event_id: last.id });
    assert.strictEqual((await setStatus(s.pid, 'active')).status, 200);
    // ⑥ 撤销后：已确认的交接确认仍有效（不因撤销失效，按指纹判）；批次视图 live = false、最后一条事件是 revoke；再上线走全部前置，kind = regolive
    const view = await handoverGet(U.pm, s.batch1);
    assert.deepStrictEqual([itemOf(view, eB.id).confirm.state, itemOf(view, eB.id).cleared], ['confirmed', true], '撤销不使已确认的交接确认失效');
    assert.strictEqual(view.actions.golive, true, '前置仍全部满足');
    const pb = (await get(U.pm, `/sysbuild/projects/${s.pid}/plan`)).body.batches[0];
    assert.deepStrictEqual([pb.live, pb.last_golive_event.kind, pb.last_golive_event.reason], [false, 'revoke', reasonBody.reason]);
    assert.deepStrictEqual((await get(U.pm, `/sysbuild/projects/${s.pid}/plan`)).body.project.golive_progress, { live: 0, total: 1, transferred: 0 }, '撤销按当前有效上线状态计数');
    assert.deepStrictEqual((await get(U.pm, `/sysbuild/projects/${s.pid}`)).body.project.golive_progress, { live: 0, total: 1, transferred: 0 }, '项目详情同源');
    const re = await goliveReq(U.pm, s.batch1);
    assert.strictEqual(re.status, 200, re.text);
    assert.strictEqual(re.body.golive_event.kind, 'regolive');
    assert.strictEqual((await nodeRow(bGolive)).status, 'closed', '再上线里程碑再次收口');
    const snapRe = JSON.parse((await sqlGet('SELECT handover_snapshot_json AS j FROM sysbuild_golive_events WHERE id = ?', [re.body.golive_event.id])).j);
    assert.strictEqual(itemOf({ items: snapRe.items }, eB.id).confirm.state, 'confirmed', '再上线快照里仍是已确认');
    // 事件只追加：上线 → 撤销 → 再上线三条，编号递增
    const all = await eventsAll(s.batch1);
    assert.deepStrictEqual(all.map((x) => x.kind), ['golive', 'revoke', 'regolive']);
    assert.deepStrictEqual(all.map((x) => x.id), [g1.golive_event.id, last.id, re.body.golive_event.id]);
    // 撤销后再上线的前置照旧：撤销后又有登记未办结 → 再上线 409（再上线先要撤销）
    await backdate(re.body.golive_event.id);
    await revokeReq(U.admin, s.batch1, { reason: '再撤销一次，验证再上线前置' });
    await regOk(U.pm, s.pid, { type: 'feedback', title: '撤销后新登记的未办结问题' });
    const blockedAgain = await goliveReq(U.pm, s.batch1);
    expectErr(blockedAgain, 409, 'SYSBUILD_GOLIVE_BLOCKED', '撤销后新增未办结登记');
    assert.deepStrictEqual(blockedAgain.body.blockers.map((b) => b.code), ['HANDOVER_UNCLEARED']);
  });

  // ═══════════════════════ 12 整体结项与重开 ═══════════════════════
  const diffDays = (a, b) => Math.max(0, Math.round((Date.UTC(Number(b.slice(0, 4)), Number(b.slice(5, 7)) - 1, Number(b.slice(8, 10))) - Date.UTC(Number(a.slice(0, 4)), Number(a.slice(5, 7)) - 1, Number(a.slice(8, 10)))) / 86400000));
  test(`${T_CLOSE}——p_closing 收口 = 整体结项：前置（结项包已生效、每个有效批次已正式上线、已转出批次有变更包、结项包生效晚于每个批次最后一条上线事件 P141、项目整体未结过程登记）读接口与收口端点同一个函数；成功时同一事务项目 → 已结项并写项目状态事件；已结项后写动作 409、项目整体登记按补充登记；admin 重开项目时 p_closing 退回进行中（P142），之后可再收口`, async () => {
    const s = await mkPlan();
    await ready(s);
    await goLive(s, '-2 hours');
    const closingNode = await startNode(s.pid, 'p_closing');
    const planNodeOf = async (nid) => (await get(U.pm, `/sysbuild/projects/${s.pid}/plan`)).body.nodes.find((n) => n.id === nid);
    const codes = (r) => r.body.blockers.map((b) => b.code);
    // ① 结项包未生效
    const r1 = await closeNodeReq(closingNode);
    expectErr(r1, 409, 'SYSBUILD_CLOSE_BLOCKED', '结项包未生效');
    assert.deepStrictEqual(codes(r1), ['PACKAGE_NOT_EFFECTIVE']);
    assert.ok(r1.body.blockers[0].message.includes('结项包'), r1.body.blockers[0].message);
    assert.deepStrictEqual((await planNodeOf(closingNode)).close_blockers.map((b) => b.code), ['PACKAGE_NOT_EFFECTIVE'], '读接口 close_blockers 同源');
    assert.strictEqual(await projStatus(s.pid), 'active', '被拒不结项');
    // ② 结项包：提交（只有代表人确认）→ 生效
    const clPk = await mkPackage(s.pid, 'closing');
    const clV1 = await mkVersion(clPk);
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${clV1}/submit`)).status, 200);
    assert.deepStrictEqual((await tasksOf(clV1)).map((t) => t.user_id), [U.del]);
    await confirmAll(clV1);
    // ③ 项目整体的未结过程登记阻塞整体结项
    const eP = await regOk(U.pm, s.pid, { type: 'feedback', title: '项目整体问题' });
    const r2 = await closeNodeReq(closingNode);
    assert.deepStrictEqual([codes(r2), r2.body.blockers[0].entry_ids], [['ENTRY_UNRESOLVED'], [eP.id]]);
    await actOk(U.pm, eP.id, CONCLUDE);
    // ④ 撤销后再上线：结项包须重新确认（P141）。结项包 v1 的生效时刻前移到三小时前，再上线事件回拨到一小时前（晚于结项包生效）
    await sqlRun("UPDATE sysbuild_package_versions SET effective_at = datetime('now','localtime','-3 hours') WHERE id = ?", [clV1]);
    await H.productionRevoke(s.batch1, '撤销以验证结项包与再上线的先后');
    const r3 = await closeNodeReq(closingNode);
    assert.deepStrictEqual(codes(r3), ['BATCH_NOT_LIVE'], '撤销后批次不再是已正式上线');
    assert.deepStrictEqual(r3.body.blockers[0].batch_ids, [s.batch1]);
    const re = await H.productionGolive(s.batch1, '-1 hour');
    assert.strictEqual(re.golive_event.kind, 'regolive');
    const r4 = await closeNodeReq(closingNode);
    assert.deepStrictEqual([codes(r4), r4.body.blockers[0].batch_ids], [['CLOSING_BEFORE_GOLIVE'], [s.batch1]], '结项包早于再上线事件');
    assert.ok(r4.body.blockers[0].message.includes('第 1 批'), r4.body.blockers[0].message);
    // 结项包生效时刻等于最后一条上线事件的时刻：同样不算「晚于」
    const lastEv = (await eventsAll(s.batch1)).pop();
    await sqlRun('UPDATE sysbuild_package_versions SET effective_at = ? WHERE id = ?', [lastEv.created_at, clV1]);
    assert.deepStrictEqual(codes(await closeNodeReq(closingNode)), ['CLOSING_BEFORE_GOLIVE'], '同一时刻不算晚于');
    // 重新确认结项包（第二版）后放行
    const clV2 = await mkVersion(clPk);
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${clV2}/submit`)).status, 200);
    await confirmAll(clV2);
    assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id = ?', [clV1])).status, 'superseded');
    // 已转出且没有变更包的批次拦；被替代的批次不挡
    const bX = (await sqlRun("INSERT INTO sysbuild_batches (project_id, seq, name, is_default, status, transfer_change_id) VALUES (?, 7, '第 7 批', 0, 'transferred', 999999)", [s.pid])).lastID;
    const bY = (await sqlRun("INSERT INTO sysbuild_batches (project_id, seq, name, is_default, status, superseded_by) VALUES (?, 8, '第 8 批', 0, 'superseded', ?)", [s.pid, bX])).lastID;
    const r5 = await closeNodeReq(closingNode);
    assert.deepStrictEqual([codes(r5), r5.body.blockers[0].batch_ids], [['TRANSFER_CHANGE_MISSING'], [bX]]);
    await sqlRun('DELETE FROM sysbuild_batches WHERE id IN (?, ?)', [bX, bY]);
    // ⑤ 成功：节点收口 + 项目 → 已结项（同一事务）
    const ok = await closeNodeReq(closingNode);
    assert.strictEqual(ok.status, 200, ok.text);
    assert.strictEqual(ok.body.node.status, 'closed');
    assert.strictEqual(await projStatus(s.pid), 'closed');
    const psc = (await payloads(s.pid, 'project_status_changed')).filter((p) => p.to === 'closed');
    assert.deepStrictEqual(psc, [{ from: 'active', to: 'closed', reason: '整体验收结项节点收口' }], '项目状态事件与状态端点同形 { from, to, reason }');
    assert.strictEqual((await payloads(s.pid, 'node_closed')).filter((p) => p.actual_date === today()).length >= 1, true);
    assert.strictEqual((await sqlAll("SELECT id FROM sysbuild_node_schedule_records WHERE node_id = ? AND kind = 'actual_end'", [closingNode])).length, 1);
    assert.strictEqual((await get(U.pm, `/sysbuild/projects/${s.pid}`)).body.project.status, 'closed');
    // 已结项：维护类 / 收口类写动作 409；项目整体的新登记是补充登记，天数按结项事件的时刻算（P95）
    expectErr(await post(U.pm, `/sysbuild/nodes/${await nodeIdOf(s.pid, 'p_initiation')}/start`), 409, 'SYSBUILD_PROJECT_READONLY', '已结项后开始节点');
    expectErr(await post(U.pm, `/sysbuild/nodes/${await nodeIdOf(s.pid, 'b_req')}/reopen`, { reason: '想重开' }), 409, 'SYSBUILD_PROJECT_READONLY', '已结项后重开节点');
    const endedOn = (await sqlGet("SELECT created_at FROM sysbuild_events WHERE project_id = ? AND event_type = 'project_status_changed' ORDER BY id DESC LIMIT 1", [s.pid])).created_at.slice(0, 10);
    const eS = await regOk(U.pm, s.pid, { type: 'feedback', title: '结项后补充反馈' });
    assert.deepStrictEqual([eS.period, eS.days_after_close], ['supplement', diffDays(endedOn, today())], '已结项后项目整体登记 = 补充登记（天数 = 登记日 − 结项事件日）');
    // ⑥ 重开：非 admin 403；admin 重开 → 项目进行中、p_closing 进行中（closed_at 清空、写节点事件）；之后项目整体登记回到过程登记，已有的补充登记不改写
    expectErr(await post(U.pm, `/sysbuild/projects/${s.pid}/status`, { to: 'active', reason: '想重开' }), 403, 'SYSBUILD_FORBIDDEN', 'PM 不能重开');
    assert.strictEqual((await setStatus(s.pid, 'active')).status, 200);
    assert.strictEqual(await projStatus(s.pid), 'active');
    const cn = await nodeRow(closingNode);
    assert.deepStrictEqual([cn.status, cn.closed_at], ['in_progress', null], 'p_closing 退回进行中');
    const nre = (await payloads(s.pid, 'node_reopened')).filter((p) => p.via === 'project_reopen');
    assert.deepStrictEqual(nre, [{ reason: '上线交接用例', via: 'project_reopen' }]);
    assert.strictEqual((await eventsOf(s.pid, 'node_reopened')).filter((e) => e.object_id === closingNode).length, 1, '节点事件挂在 p_closing 上');
    const eN = await regOk(U.pm, s.pid, { type: 'feedback', title: '重开后的项目整体登记' });
    assert.deepStrictEqual([eN.period, eN.days_after_close], ['process', null], '重开后回到过程登记');
    assert.strictEqual((await detail(U.pm, eS.id)).period, 'supplement', '已写入的登记时段不改写');
    assert.strictEqual((await planNodeOf(closingNode)).actions.close, true);
    const r6 = await closeNodeReq(closingNode);
    assert.deepStrictEqual([codes(r6), r6.body.blockers[0].entry_ids], [['ENTRY_UNRESOLVED'], [eN.id]], '重开后项目整体的未结过程登记又拦整体结项');
    await actOk(U.pm, eN.id, CONCLUDE);
    // ⑦ 再收口 = 再结项
    const ok2 = await closeNodeReq(closingNode);
    assert.strictEqual(ok2.status, 200, ok2.text);
    assert.strictEqual(await projStatus(s.pid), 'closed');
    assert.strictEqual((await payloads(s.pid, 'project_status_changed')).filter((p) => p.to === 'closed').length, 2);
    // 终止后重开不影响 p_closing（只有已结项重开才退回它）：先重开到 active，再终止 / 恢复，p_closing 状态保持
    assert.strictEqual((await setStatus(s.pid, 'active')).status, 200);
    assert.strictEqual((await nodeRow(closingNode)).status, 'in_progress');
    assert.strictEqual((await setStatus(s.pid, 'terminated')).status, 200);
    assert.strictEqual((await setStatus(s.pid, 'active')).status, 200);
    assert.strictEqual((await nodeRow(closingNode)).status, 'in_progress', '终止后恢复不动 p_closing');
    assert.strictEqual((await payloads(s.pid, 'node_reopened')).filter((p) => p.via === 'project_reopen').length, 2, '只有已结项重开写 project_reopen 节点事件（共两次重开）');
  });

  // ═══════════════════════ 13 上线事件的历史导入 ═══════════════════════
  test(`${T_IMPORT}——history-imports fact_type = golive（对象 = 批次）：窗口开启、批次进行中、该批还没有任何上线事件、原日期不晚于今天；交接集合必须全部已清（P178，与普通上线共用闸门）、节点按 P166 / P171 收口，不要求验收包生效；写上线事件（时刻 = 原日期 00:00:00，快照带 history_import 标记与导入时的交接集合）、批次 → 已上线、里程碑 → 已收口、history_imports 与凭据附件、事件`, async () => {
    const s = await mkPlan({ m1: true });
    const url = `/sysbuild/projects/${s.pid}/history-imports`;
    const body = async (extra) => Object.assign({ fact_type: 'golive', object_id: s.batch1, actual_confirmer: '甲部负责人', identity_basis: '上线单与验收记录', original_date: OK_DATE, attachment_ids: [await stageAtt(s.pid, U.pm, 'a')] }, extra || {});
    const openWin = (pid) => sqlRun("UPDATE sysbuild_projects SET history_window = 'open' WHERE id = ?", [pid]);
    // ① 窗口没开：409（沿用窗口判定）；窗口开了之后非 PM 403
    expectErr(await post(U.pm, url, await body()), 409, 'SYSBUILD_STATE', '窗口未开启');
    await openWin(s.pid);
    expectErr(await post(U.m1, url, await body()), 403, 'SYSBUILD_FORBIDDEN', '一般成员');
    expectErr(await post(U.admin, url, await body()), 403, 'SYSBUILD_FORBIDDEN', 'admin 非 PM');
    // ② 对象与前置：别的项目 / 不存在的批次 409；批次不是进行中 409；批次已有上线事件 409；原日期晚于今天 400
    const other = await mkPlan();
    const rOther = await post(U.pm, url, await body({ object_id: other.batch1 }));
    expectErr(rOther, 409, 'SYSBUILD_STATE', '别的项目的批次');
    assert.strictEqual(rOther.body.message, '对象不存在或不属于本项目');
    expectErr(await post(U.pm, url, await body({ object_id: 99999999 })), 409, 'SYSBUILD_STATE', '批次不存在');
    await sqlRun("UPDATE sysbuild_batches SET status = 'planning' WHERE id = ?", [s.batch1]);
    const rPl = await post(U.pm, url, await body());
    expectErr(rPl, 409, 'SYSBUILD_STATE', '批次规划中');
    assert.ok(rPl.body.message.includes('只有进行中的批次可以导入上线事件'), rPl.body.message);
    await sqlRun("UPDATE sysbuild_batches SET status = 'active' WHERE id = ?", [s.batch1]);
    // P166：本批非里程碑、未取消的节点须全部已收口（否则导入后批次已上线，b_uat 等节点再也收不了口）：未收口 409 并列出节点名；收口后才放行
    const rOpenNodes = await post(U.pm, url, await body());
    expectErr(rOpenNodes, 409, 'SYSBUILD_STATE', '本批节点未收口');
    assert.ok(rOpenNodes.body.message.includes('本批还有未收口的节点') && rOpenNodes.body.message.includes('需求确认') && rOpenNodes.body.message.includes('开发完成（含设计）'), rOpenNodes.body.message);
    await H.closeBatchNodes(s.pid, s.batch1);
    const rFuture = await post(U.pm, url, await body({ original_date: '2099-12-31' }));
    expectErr(rFuture, 400, 'SYSBUILD_INVALID_INPUT', '原日期晚于今天');
    assert.strictEqual(rFuture.body.field, 'original_date');
    expectErr(await post(U.pm, url, await body({ original_date: '2026-13-01' })), 400, 'SYSBUILD_INVALID_INPUT', '日期非法');
    expectErr(await post(U.pm, url, await body({ attachment_ids: [] })), 400, 'SYSBUILD_INVALID_INPUT', '凭据附件必填');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_golive_events WHERE batch_id = ?', [s.batch1]), 0, '被拒不写事件');
    assert.strictEqual((await batchRow(s.batch1)).status, 'active');
    // ③ P178：交接集合有未清项（一条未办结的阻塞项）时 409，文案点名登记；办结后才放行。成功时不要求验收包生效（本场景没有验收包）
    const eOpen = await regOk(U.pm, s.pid, { type: 'issue', is_risk: 1, title: '未办结的阻塞项' });
    const bReq = await nodeIdOf(s.pid, 'b_req');
    const bGolive = await nodeIdOf(s.pid, 'b_golive');
    const rUnc = await post(U.pm, url, await body());
    expectErr(rUnc, 409, 'SYSBUILD_STATE', '交接集合有未清项');
    assert.ok(rUnc.body.message.includes('上线交接集合里还有 1 项没有清') && rUnc.body.message.includes(`#${eOpen.id}`), rUnc.body.message);
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_golive_events WHERE batch_id = ?', [s.batch1]), 0, '被拒不写事件');
    await actOk(U.pm, eOpen.id, CONCLUDE);
    const taskCount = await countOf('SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE project_id = ?', [s.pid]);
    const ok = await post(U.pm, url, await body());
    assert.strictEqual(ok.status, 201, ok.text);
    assert.deepStrictEqual([ok.body.history_import.fact_type, ok.body.history_import.object_type, ok.body.history_import.object_id, ok.body.history_import.original_date, ok.body.history_import.label], ['golive', 'batch', s.batch1, OK_DATE, '历史导入']);
    assert.deepStrictEqual([ok.body.result.status, ok.body.result.milestone_node_id], ['live', bGolive]);
    const evs = await eventsAll(s.batch1);
    assert.strictEqual(evs.length, 1);
    assert.deepStrictEqual([evs[0].kind, evs[0].created_at, evs[0].created_by, evs[0].reason, evs[0].id], ['golive', `${OK_DATE} 00:00:00`, U.pm, null, ok.body.result.golive_event_id], '上线事件时刻 = 原日期 00:00:00');
    const snap = JSON.parse(evs[0].handover_snapshot_json);
    assert.strictEqual(snap.history_import, true);
    assert.deepStrictEqual(Object.keys(snap).sort(), ['exempt_nodes', 'history_import', 'items', 'summary']);
    assert.deepStrictEqual(snap.exempt_nodes, [], '自研项目没有 b_uat：没有豁免的节点');
    assert.deepStrictEqual(snap.items.map((i) => [i.entry_id, i.cleared]), [[eOpen.id, true]], '快照记导入时的交接集合与判定（全部已清才放行）');
    assert.strictEqual((await batchRow(s.batch1)).status, 'live');
    const ms = await nodeRow(bGolive);
    assert.deepStrictEqual([ms.status, ms.opened_at, ms.closed_at], ['closed', `${OK_DATE} 00:00:00`, `${OK_DATE} 00:00:00`], '里程碑（未开始）开始 / 收口时刻都写原日期');
    assert.deepStrictEqual((await sqlAll("SELECT kind, actual_date FROM sysbuild_node_schedule_records WHERE node_id = ? AND kind IN ('actual_start', 'actual_end') ORDER BY id", [bGolive])).map((r) => [r.kind, r.actual_date]), [['actual_start', OK_DATE], ['actual_end', OK_DATE]]);
    assert.strictEqual((await nodeRow(bReq)).status, 'closed', '其他节点不动（已收口的前置照旧）');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id WHERE p.batch_id = ? AND p.type = 'batch_accept'", [s.batch1]), 0, '没有验收包也能导入');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE project_id = ?', [s.pid]), taskCount, '导入不产生任何确认任务');
    const hi = await sqlGet("SELECT * FROM sysbuild_history_imports WHERE project_id = ? AND fact_type = 'golive'", [s.pid]);
    assert.deepStrictEqual([hi.object_type, hi.object_id, hi.actual_confirmer, hi.identity_basis, hi.original_date, hi.imported_by], ['batch', s.batch1, '甲部负责人', '上线单与验收记录', OK_DATE, U.pm]);
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_attachment_bindings WHERE owner_type = 'history_import' AND owner_id = ?", [hi.id]), 1, '凭据附件以 history_import 绑定');
    const hev = (await payloads(s.pid, 'history_fact_imported')).filter((p) => p.fact_type === 'golive');
    assert.deepStrictEqual([hev.length, hev[0].object_type, hev[0].golive_event_id, hev[0].original_date], [1, 'batch', ok.body.result.golive_event_id, OK_DATE]);
    const grec = (await payloads(s.pid, 'golive_recorded')).filter((p) => p.via === 'history_import');
    assert.deepStrictEqual(grec, [{ kind: 'golive', golive_event_id: ok.body.result.golive_event_id, via: 'history_import', milestone_node_id: bGolive }]);
    // 导入的事件时刻在过去：批次视图立即是「已正式上线」，最后一条事件时刻 = 原日期
    const pb = (await get(U.pm, `/sysbuild/projects/${s.pid}/plan`)).body.batches[0];
    assert.deepStrictEqual([pb.live, pb.last_golive_event.at, pb.last_golive_event.kind], [true, `${OK_DATE} 00:00:00`, 'golive']);
    // 历史导入列表带出批次导入
    const list = await get(U.pm, `/sysbuild/projects/${s.pid}/history-imports`);
    assert.strictEqual(list.status, 200, list.text);
    assert.ok(JSON.stringify(list.body).includes('"object_type":"batch"'), '历史导入读接口认 batch 对象类型');
    // ④ 再导入：批次已不是进行中 409
    const again = await post(U.pm, url, await body());
    expectErr(again, 409, 'SYSBUILD_STATE', '再导入');
    assert.ok(again.body.message.includes('只有进行中的批次可以导入上线事件'), again.body.message);
    // ⑤ 已走过普通上线路径的批次（撤销后回到进行中，但已有上线事件）不能导入
    const s2 = await mkPlan();
    await ready(s2);
    await H.productionGolive(s2.batch1);
    await H.productionRevoke(s2.batch1, '撤销后回到进行中');
    await openWin(s2.pid);
    const r5 = await post(U.pm, `/sysbuild/projects/${s2.pid}/history-imports`, { fact_type: 'golive', object_id: s2.batch1, actual_confirmer: '甲部负责人', identity_basis: '上线单', original_date: OK_DATE, attachment_ids: [await stageAtt(s2.pid, U.pm, 'b')] });
    expectErr(r5, 409, 'SYSBUILD_STATE', '已有普通上线事件');
    assert.ok(r5.body.message.includes('已有上线事件'), r5.body.message);
    // ⑥ 里程碑已开始：原日期不能早于它在平台上的开始日
    const s3 = await mkPlan();
    await startNode(s3.pid, 'b_golive');
    await openWin(s3.pid);
    const r6 = await post(U.pm, `/sysbuild/projects/${s3.pid}/history-imports`, { fact_type: 'golive', object_id: s3.batch1, actual_confirmer: '甲部负责人', identity_basis: '上线单', original_date: '2025-01-01', attachment_ids: [await stageAtt(s3.pid, U.pm, 'c')] });
    expectErr(r6, 409, 'SYSBUILD_STATE', '早于里程碑开始日');
    assert.ok(r6.body.message.includes('不能导入更早'), r6.body.message);
    // ⑦ 整体验收结项的收口不支持历史导入（项目转入已结项只经结项包 + 节点收口）
    const rClosing = await post(U.pm, `/sysbuild/projects/${s3.pid}/history-imports`, { fact_type: 'node_closed', object_id: await nodeIdOf(s3.pid, 'p_closing'), actual_confirmer: '甲部负责人', identity_basis: '结项单', original_date: OK_DATE, attachment_ids: [await stageAtt(s3.pid, U.pm, 'd')] });
    expectErr(rClosing, 409, 'SYSBUILD_STATE', '整体验收结项不支持导入');
    assert.strictEqual(rClosing.body.message, '整体验收结项的收口不支持历史导入');
  });

  // ═══════════════════════ 14 actions 同源 ═══════════════════════
  test(`${T_FLAGS}——批次视图 actions.golive / revoke_golive 与交接集合每项 actions.handover_request：各身份 × 各状态，标志为真 ⇔ 对应端点执行成功，为假 ⇔ 被拒（403 / 409）`, async () => {
    const s = await mkPlan({ m1: true });
    const e = await blockerIssue(s);
    const roles = [[U.pm, 'PM'], [U.admin, 'admin'], [U.m1, '一般成员'], [U.ro, '只读账号'], [U.own, '负责人']];
    const bflags = async (uid) => (await get(uid, `/sysbuild/projects/${s.pid}/plan`)).body.batches[0].actions;
    const hflag = async (uid) => itemOf(await handoverGet(uid, s.batch1), e.id).actions.handover_request;
    // 状态 A：批次进行中，阻塞项还没发起交接确认、前置不满足
    for (const [uid, label] of roles) {
      const f = await bflags(uid);
      assert.deepStrictEqual([f.golive, f.revoke_golive], [false, false], `${label}：golive / revoke_golive 都为假`);
      assert.strictEqual(await hflag(uid), uid === U.pm, `${label}：handover_request 只有 PM 为真`);
    }
    for (const [uid, label] of roles.filter(([u]) => u !== U.pm)) {
      expectErr(await requestHo(uid, s.batch1, e.id), 403, 'SYSBUILD_FORBIDDEN', `${label} 发起（标志为假）`);
      assert.ok([403, 409].includes((await goliveReq(uid, s.batch1)).status), `${label} 上线被拒`);
    }
    expectErr(await goliveReq(U.pm, s.batch1), 409, 'SYSBUILD_GOLIVE_BLOCKED', 'PM 前置不满足（标志为假）');
    assert.strictEqual((await requestHo(U.pm, s.batch1, e.id)).status, 201, 'PM 发起（标志为真）');
    assert.strictEqual(await hflag(U.pm), false, '发起后标志为假');
    expectErr(await requestHo(U.pm, s.batch1, e.id), 409, 'SYSBUILD_STATE', '发起后再发起');
    // 状态 B：前置全部满足
    for (const t of (await hoTasks(e.id))) assert.strictEqual((await decideHo(t.user_id, t.task_id, 'confirm')).status, 200);
    await ready(s);
    for (const [uid, label] of roles) {
      const f = await bflags(uid);
      assert.deepStrictEqual([f.golive, f.revoke_golive], [uid === U.pm, false], `${label}：只有 PM 的 golive 为真`);
      assert.strictEqual((await handoverGet(uid, s.batch1)).actions.golive, uid === U.pm, `${label}：交接读接口的 golive 标志同源`);
    }
    for (const [uid, label] of roles.filter(([u]) => u !== U.pm)) expectErr(await goliveReq(uid, s.batch1), 403, 'SYSBUILD_FORBIDDEN', `${label} 上线（标志为假）`);
    const live = await goliveReq(U.pm, s.batch1);
    assert.strictEqual(live.status, 200, 'PM 上线（标志为真）');
    await backdate(live.body.golive_event.id);
    // 状态 C：已上线：只有 admin 的 revoke_golive 为真；golive 全员假
    for (const [uid, label] of roles) {
      const f = await bflags(uid);
      assert.deepStrictEqual([f.golive, f.revoke_golive], [false, uid === U.admin], `${label}：已上线只有 admin 可撤销`);
      assert.strictEqual((await handoverGet(uid, s.batch1)).actions.revoke_golive, uid === U.admin);
    }
    for (const [uid, label] of roles.filter(([u]) => u !== U.admin)) expectErr(await revokeReq(uid, s.batch1, { reason: '没权限' }), 403, 'SYSBUILD_FORBIDDEN', `${label} 撤销（标志为假）`);
    expectErr(await goliveReq(U.pm, s.batch1), 409, 'SYSBUILD_STATE', '已上线再上线（标志为假）');
    assert.strictEqual((await revokeReq(U.admin, s.batch1, { reason: '撤销（标志为真）' })).status, 200);
    // 状态 D：撤销之后回到进行中：PM 的 golive 又为真（前置仍满足）、revoke 全员假
    for (const [uid, label] of roles) {
      const f = await bflags(uid);
      assert.deepStrictEqual([f.golive, f.revoke_golive], [uid === U.pm, false], `${label}：撤销后`);
    }
    // 暂停：golive 标志为假（项目状态类别 golive 只有进行中），执行 409 SYSBUILD_PROJECT_READONLY
    assert.strictEqual((await setStatus(s.pid, 'paused')).status, 200);
    assert.strictEqual((await bflags(U.pm)).golive, false);
    expectErr(await goliveReq(U.pm, s.batch1), 409, 'SYSBUILD_PROJECT_READONLY', '暂停');
    assert.strictEqual((await setStatus(s.pid, 'active')).status, 200);
    // 交接确认的发起标志随项目状态：暂停仍可（维护类），已终止为假
    const e2 = await blockerIssue(s, { title: '暂停 / 终止对照' });
    assert.strictEqual(itemOf(await handoverGet(U.pm, s.batch1), e2.id).actions.handover_request, true);
    assert.strictEqual((await setStatus(s.pid, 'paused')).status, 200);
    assert.strictEqual(itemOf(await handoverGet(U.pm, s.batch1), e2.id).actions.handover_request, true, '暂停：维护类可发起');
    assert.strictEqual((await setStatus(s.pid, 'terminated')).status, 200);
    assert.strictEqual(itemOf(await handoverGet(U.pm, s.batch1), e2.id).actions.handover_request, false, '已终止：假');
    expectErr(await requestHo(U.pm, s.batch1, e2.id), 409, 'SYSBUILD_PROJECT_READONLY', '已终止发起');
  });

  // ═══════════════════════ 15 rules 手写矩阵 ═══════════════════════
  test(`${T_RULES}——手写判定矩阵：golive（PM × 项目状态 golive 行 × 批次状态 × 前置事实）/ revoke_golive（admin × maintain 行 × 批次已上线 × 结项包待确认）/ handover_request（事实逐项 fail-closed）/ package_version_submit 的批次验收包、结项包、待确认互斥分支；类别手写核对`, async () => {
    const R = T.getMods().rules;
    const idn = (o) => Object.assign({ isPm: false, isAdmin: false, isReadonly: false, isMember: false, userId: 50, ownerOfParties: [], delegateOfParties: [] }, o);
    const chk = (op, i, st, t) => R.checkOp(op, i, { id: 1, status: st || 'active', pm_user_id: 7 }, t || {});
    const code = (v) => (v === null ? null : `${v.status}:${v.code}`);
    const pm = idn({ isPm: true, isMember: true });
    const adm = idn({ isAdmin: true });
    // 类别（手写）
    assert.deepStrictEqual([R.OP_KIND.golive, R.OP_KIND.revoke_golive, R.OP_KIND.handover_request, R.OP_KIND.confirm_decide], ['golive', 'maintain', 'maintain', 'accept']);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(R.PROJECT_ACTION_TABLE.golive)), { active: true, paused: false, terminated: false, closed: false }, 'golive 行：只有进行中');
    // golive
    const G = { batchStatus: 'active', blockers: [] };
    assert.strictEqual(chk('golive', pm, 'active', G), null);
    for (const [st, ok] of [['active', true], ['paused', false], ['terminated', false], ['closed', false]]) {
      assert.strictEqual(code(chk('golive', pm, st, G)), ok ? null : '409:SYSBUILD_PROJECT_READONLY', `golive × ${st}`);
    }
    assert.strictEqual(code(chk('golive', idn({ isMember: true }), 'active', G)), '403:SYSBUILD_FORBIDDEN', '一般成员');
    assert.strictEqual(code(chk('golive', adm, 'active', G)), '403:SYSBUILD_FORBIDDEN', 'admin 未接管');
    assert.strictEqual(code(chk('golive', idn({ isPm: true, isReadonly: true }), 'active', G)), '403:SYSBUILD_FORBIDDEN', '只读 PM');
    assert.deepStrictEqual([code(chk('golive', pm, 'active', { batchStatus: 'live', blockers: [] })), chk('golive', pm, 'active', { batchStatus: 'live', blockers: [] }).message], ['409:SYSBUILD_STATE', '批次已正式上线']);
    assert.strictEqual(chk('golive', pm, 'active', { batchStatus: 'planning', blockers: [] }).message, '批次还没有进入进行中，不能确认试运行结束');
    for (const bs of ['transferred', 'superseded']) assert.strictEqual(chk('golive', pm, 'active', { batchStatus: bs, blockers: [] }).message, '批次已转出或被替代，不能上线');
    assert.strictEqual(chk('golive', pm, 'active', { batchStatus: undefined, blockers: [] }).message, '无法确定批次状态，请刷新后重试', '批次状态没取到 fail-closed');
    assert.strictEqual(code(chk('golive', pm, 'active', { batchStatus: 'active' })), '409:SYSBUILD_STATE', '前置事实没取到 fail-closed');
    assert.strictEqual(chk('golive', pm, 'active', { batchStatus: 'active' }).message, '无法确定上线前置事实，请刷新后重试');
    const gb = chk('golive', pm, 'active', { batchStatus: 'active', blockers: [{ code: 'A', message: '甲不满足' }, { code: 'B', message: '乙不满足' }] });
    assert.deepStrictEqual([gb.status, gb.code, gb.message], [409, 'SYSBUILD_GOLIVE_BLOCKED', '上线前置条件未满足：甲不满足；乙不满足']);
    // revoke_golive
    const RV = { batchStatus: 'live', closingPending: false };
    assert.strictEqual(chk('revoke_golive', adm, 'active', RV), null, 'admin 不必接管');
    assert.strictEqual(code(chk('revoke_golive', pm, 'active', RV)), '403:SYSBUILD_FORBIDDEN', 'PM 不能撤销');
    assert.strictEqual(code(chk('revoke_golive', idn({ isAdmin: true, isReadonly: true }), 'active', RV)), '403:SYSBUILD_FORBIDDEN', '只读 admin');
    for (const [st, ok] of [['active', true], ['paused', true], ['terminated', false], ['closed', false]]) {
      assert.strictEqual(code(chk('revoke_golive', adm, st, RV)), ok ? null : '409:SYSBUILD_PROJECT_READONLY', `revoke_golive × ${st}`);
    }
    for (const bs of ['planning', 'active', 'transferred', 'superseded']) assert.strictEqual(chk('revoke_golive', adm, 'active', { batchStatus: bs, closingPending: false }).message, '只有已正式上线的批次可以撤销上线', `批次 ${bs}`);
    assert.strictEqual(chk('revoke_golive', adm, 'active', { batchStatus: undefined, closingPending: false }).message, '无法确定批次状态，请刷新后重试');
    assert.strictEqual(chk('revoke_golive', adm, 'active', { batchStatus: 'live', closingPending: true }).message, '本项目有待确认的结项包，请先撤回结项包再撤销上线');
    assert.strictEqual(code(chk('revoke_golive', adm, 'active', { batchStatus: 'live' })), '409:SYSBUILD_STATE', '结项包待确认事实没取到 fail-closed');
    // handover_request
    const HR = { batchStatus: 'active', inSet: true, resolved: true, needKind: 'accept_issue', allCovered: false, confirmState: 'none', confirmersMissing: null };
    assert.strictEqual(chk('handover_request', pm, 'active', HR), null);
    for (const [st, ok] of [['active', true], ['paused', true], ['terminated', false], ['closed', false]]) {
      assert.strictEqual(code(chk('handover_request', pm, st, HR)), ok ? null : '409:SYSBUILD_PROJECT_READONLY', `handover_request × ${st}`);
    }
    for (const who of [idn({ isMember: true }), adm, idn({ isPm: true, isReadonly: true }), idn({ isMember: true, ownerOfParties: [1] })]) assert.strictEqual(code(chk('handover_request', who, 'active', HR)), '403:SYSBUILD_FORBIDDEN');
    const msg = (o) => chk('handover_request', pm, 'active', Object.assign({}, HR, o)).message;
    assert.strictEqual(msg({ batchStatus: 'planning' }), '批次不是进行中，不能发起交接确认');
    assert.strictEqual(msg({ batchStatus: 'live' }), '批次不是进行中，不能发起交接确认');
    assert.strictEqual(msg({ batchStatus: undefined }), '无法确定批次状态，请刷新后重试');
    assert.strictEqual(msg({ inSet: false }), '该登记不在本批的上线交接集合里');
    assert.strictEqual(msg({ inSet: undefined }), '无法确定上线前置事实，请刷新后重试');
    assert.strictEqual(msg({ resolved: false }), '该登记还没有办结，请先给出结论');
    assert.strictEqual(msg({ resolved: undefined }), '无法确定上线前置事实，请刷新后重试');
    assert.strictEqual(msg({ needKind: null }), '该登记不需要交接确认');
    assert.strictEqual(msg({ needKind: 'bogus' }), '无法确定上线前置事实，请刷新后重试');
    assert.strictEqual(msg({ needKind: undefined }), '无法确定上线前置事实，请刷新后重试');
    for (const [cs, zh] of [['pending', '待确认'], ['confirmed', '已确认'], ['incomplete', '部分参与方尚无任务']]) {
      assert.strictEqual(msg({ allCovered: true, confirmState: cs }), `该登记已有当前有效的交接确认任务（${zh}），请在任务上处理（待确认的任务可代录、可换人改发）或等待确认`, `已有任务 ${cs}`);
    }
    // P165：同一指纹下已有不认可 / 有异议的修订（declined）：无论是否每个需求部门都已有任务（只有部分部门有任务时也一样，不能靠补发新任务绕过）都不能再发起
    //   LOW-1（修订批 4）：文案出路不含「裁定」（adjudicate 办理动作未开放）
    const DECLINED_MSG = '该登记已有代表人作出不认可 / 有异议，须先写答复（reply）再重新发起交接确认，或先给出新的结论（给结论 / 仅供参考 / 作废）；更正、记单号、标或取消风险都不解除';
    assert.strictEqual(msg({ allCovered: true, confirmState: 'declined' }), DECLINED_MSG);
    assert.strictEqual(msg({ allCovered: false, confirmState: 'declined' }), DECLINED_MSG, '部分部门有任务、其中有不认可：同样拒绝');
    assert.strictEqual(DECLINED_MSG.includes('裁定'), false);
    // P174：带答复（replyGiven）重新发起：declined 放行（不算「已有任务」）；需要确认的仍核缺代表人；没有不认可却带答复 409；replyGiven 缺省按没带
    //   P175（修订批 4）：答复只在仍需交接确认时有效——needKind null 且有未解除的不认可：带不带答复都 409（文案指向新的结论类动作），不再有「只记答复」放行
    const withReply = (o) => chk('handover_request', pm, 'active', Object.assign({}, HR, { replyGiven: true }, o));
    assert.strictEqual(withReply({ allCovered: true, confirmState: 'declined' }), null, '答复后放行（所有部门都有任务也放行：被不认可的任务生成新修订）');
    assert.strictEqual(withReply({ allCovered: false, confirmState: 'declined' }), null);
    const NO_NEED_MSG = '该登记已有代表人作出不认可 / 有异议，答复只在仍需交接确认时有效；须先给出新的结论（给结论 / 仅供参考 / 作废）才能解除';
    assert.strictEqual(withReply({ allCovered: true, confirmState: 'declined', needKind: null }).message, NO_NEED_MSG, '不需要确认时带答复 409');
    assert.strictEqual(code(withReply({ allCovered: true, confirmState: 'declined', needKind: null })), '409:SYSBUILD_STATE');
    assert.strictEqual(msg({ allCovered: true, confirmState: 'declined', needKind: null }), NO_NEED_MSG, '不需要确认且没带答复：文案同样指向新的结论类动作，不再叫人写答复');
    assert.strictEqual(msg({ allCovered: false, confirmState: 'declined', needKind: null }), NO_NEED_MSG);
    assert.strictEqual(NO_NEED_MSG.includes('裁定'), false);
    assert.strictEqual(withReply({ allCovered: true, confirmState: 'declined', confirmersMissing: { noParty: false, missing: ['乙部'] } }).message, '以下参与方缺少生效代表人，无法发起交接确认：乙部');
    assert.strictEqual(withReply({ allCovered: undefined, confirmState: 'declined' }).message, '无法确定上线前置事实，请刷新后重试', '事实没取到仍 fail-closed');
    assert.strictEqual(withReply({ allCovered: true, confirmState: 'pending' }).message, '该登记没有需要答复的不认可 / 有异议，不需要答复');
    assert.strictEqual(withReply({ allCovered: false, confirmState: 'none' }).message, '该登记没有需要答复的不认可 / 有异议，不需要答复');
    assert.strictEqual(chk('handover_request', pm, 'active', Object.assign({}, HR, { replyGiven: false, allCovered: true, confirmState: 'declined' })).message, DECLINED_MSG);
    assert.strictEqual(withReply({ allCovered: true, confirmState: 'declined', resolved: false }).message, '该登记还没有办结，请先给出结论', '答复也不绕过办结前置');
    assert.strictEqual(chk('handover_request', pm, 'active', Object.assign({}, HR, { allCovered: false, confirmState: 'pending' })), null, '对照：还有部门没有任务、已有任务都在待确认：放行补发');
    assert.strictEqual(msg({ allCovered: undefined }), '无法确定上线前置事实，请刷新后重试');
    assert.strictEqual(msg({ confirmersMissing: undefined }), '无法确定必需确认人，请刷新后重试');
    assert.strictEqual(msg({ confirmersMissing: { noParty: true, missing: [] } }), '项目还没有需求部门参与方，无法确定必需确认人');
    assert.strictEqual(msg({ confirmersMissing: { noParty: false, missing: ['乙部', '丙部'] } }), '以下参与方缺少生效代表人，无法发起交接确认：乙部、丙部');
    for (const nk of ['accept_issue', 'no_further']) assert.strictEqual(chk('handover_request', pm, 'active', Object.assign({}, HR, { needKind: nk })), null, `用途 ${nk}`);
    // P175（修订批 4）entry_unmark_risk：有未解除的不认可（declineOutstanding）时 409（文案手写）；无不认可放行；该事实没取到 fail-closed；PM 专属；没有风险标记先报没有风险标记（不被事实缺失遮蔽）
    const UR = { voided: false, isSplitContainer: false, type: 'issue', riskCurrent: true, declineOutstanding: false };
    assert.strictEqual(chk('entry_unmark_risk', pm, 'active', UR), null, '无不认可：放行');
    const urBlocked = chk('entry_unmark_risk', pm, 'active', Object.assign({}, UR, { declineOutstanding: true }));
    assert.strictEqual(code(urBlocked), '409:SYSBUILD_STATE');
    assert.strictEqual(urBlocked.message, '该登记的交接确认已被代表人不认可，须先写答复重新发起、由代表人对重新发起的确认作出确认，或给出新的结论；在此之前不能取消风险标记');
    for (const bad of [undefined, null, 'yes', 1]) assert.strictEqual(code(chk('entry_unmark_risk', pm, 'active', Object.assign({}, UR, { declineOutstanding: bad }))), '409:SYSBUILD_STATE', `事实 ${String(bad)} 按拒绝`);
    assert.strictEqual(chk('entry_unmark_risk', pm, 'active', Object.assign({}, UR, { riskCurrent: false, declineOutstanding: true })).message, '该登记当前没有风险标记');
    assert.strictEqual(code(chk('entry_unmark_risk', idn({ isMember: true }), 'active', UR)), '403:SYSBUILD_FORBIDDEN', '非 PM');
    assert.strictEqual(chk('entry_unmark_risk', pm, 'terminated', UR), null, 'resolve 类：已终止仍可（对照：只被未解除的不认可挡）');
    // P176（修订批 4）confirm_proxy：交接确认（accountlessOnly）的代录只放无账号的代表人；别的用途（accountlessOnly 假 / 缺省）不受账号影响；事实没取到按拒绝
    const PX = { proxyable: true, currentRevisionId: 7, revisionStatus: 'pending', objectVersionId: 9, objectPending: true, requiredIsSelf: false, qualificationLoss: null, historyConflict: null };
    const HOACC = '有平台账号的代表人须本人在平台确认交接事项';
    assert.strictEqual(chk('confirm_proxy', pm, 'active', Object.assign({}, PX, { accountlessOnly: true, requiredHasAccount: false })), null, '交接确认 × 无账号：放行');
    const pxAcc = chk('confirm_proxy', pm, 'active', Object.assign({}, PX, { accountlessOnly: true, requiredHasAccount: true }));
    assert.deepStrictEqual([pxAcc.status, pxAcc.code, pxAcc.message], [409, 'SYSBUILD_STATE', HOACC], '交接确认 × 有账号：409');
    for (const bad of [undefined, null, 'no']) assert.strictEqual(code(chk('confirm_proxy', pm, 'active', Object.assign({}, PX, { accountlessOnly: true, requiredHasAccount: bad }))), '409:SYSBUILD_STATE', `账号事实 ${String(bad)} 按拒绝`);
    assert.strictEqual(chk('confirm_proxy', pm, 'active', Object.assign({}, PX, { accountlessOnly: false, requiredHasAccount: true })), null, '其他用途 × 有账号：照旧放行');
    assert.strictEqual(chk('confirm_proxy', pm, 'active', Object.assign({}, PX, { accountlessOnly: false, requiredHasAccount: false })), null);
    assert.strictEqual(chk('confirm_proxy', pm, 'active', PX), null, '缺省（旧目标）不判账号');
    assert.strictEqual(chk('entry_conclusion_proxy', pm, 'terminated', Object.assign({}, PX, { accountlessOnly: false, requiredHasAccount: true })), null, '结论确认的代录（委托同一判定）× 有账号：照旧放行');
    // package_version_submit：批次验收包 / 结项包 / 互斥
    const SUB = { versionStatus: 'draft', confirmersMissing: null, historyConflict: null, parentSuperseded: false, otherPendingPackage: null };
    const sub = (o, st) => chk('package_version_submit', pm, st || 'active', Object.assign({}, SUB, o));
    for (const [bs, expectMsg] of [['planning', '批次还没有进入进行中，不能提交批次验收'], ['live', '批次已正式上线，不能再提交批次验收'], [undefined, '无法确定批次状态，请刷新后重试']]) {
      assert.strictEqual(sub({ packageType: 'batch_accept', batchStatus: bs }).message, expectMsg, `验收包 × 批次 ${String(bs)}`);
    }
    for (const bs of ['transferred', 'superseded']) assert.strictEqual(code(sub({ packageType: 'batch_accept', batchStatus: bs })), '409:SYSBUILD_STATE', `验收包 × ${bs}（外层批次冻结先拦）`);
    assert.strictEqual(sub({ packageType: 'batch_accept', batchStatus: 'active' }), null);
    assert.strictEqual(sub({ packageType: 'closing', closingNotReady: null }), null);
    assert.strictEqual(sub({ packageType: 'closing' }).message, '无法确定批次上线情况，请刷新后重试', '结项前置事实没取到');
    assert.strictEqual(sub({ packageType: 'closing', closingNotReady: { notLive: ['第 1 批', '第 2 批'], transferNoChange: [] } }).message, '不能提交结项：以下批次还没有正式上线：第 1 批、第 2 批');
    assert.strictEqual(sub({ packageType: 'closing', closingNotReady: { notLive: [], transferNoChange: ['第 7 批'] } }).message, '不能提交结项：以下已转出的批次没有已生效的变更包：第 7 批');
    // 父版本过期：只对总体规划包 / 变更包 / 批次需求包拒绝；验收包与结项包提交时重写，不拒绝
    assert.strictEqual(sub({ packageType: 'overall', parentSuperseded: true, initiationEffective: true, planMissing: null }).message, '草稿所基于的总体规划版本已被替代，请基于现行规划重建草稿');
    assert.strictEqual(sub({ packageType: 'batch_accept', batchStatus: 'active', parentSuperseded: true }), null);
    assert.strictEqual(sub({ packageType: 'closing', closingNotReady: null, parentSuperseded: true }), null);
    // 待确认互斥：四类 × 其他待确认类型；立项包不在内；事实没取到 fail-closed
    const ZH = { overall: '总体规划', change: '变更', batch_accept: '批次验收', closing: '结项', initiation: '立项' };
    const base = { overall: { initiationEffective: true, planMissing: null }, change: { changeStatus: 'draft', otherChangePending: false, changeEvidenceOk: true }, batch_accept: { batchStatus: 'active' }, closing: { closingNotReady: null } };
    for (const type of ['overall', 'change', 'batch_accept', 'closing']) {
      assert.strictEqual(sub(Object.assign({ packageType: type }, base[type])), null, `${type} 无其他待确认`);
      for (const other of ['overall', 'change', 'batch_accept', 'closing']) {
        const r = sub(Object.assign({ packageType: type, otherPendingPackage: other }, base[type]));
        assert.strictEqual(r.message, `已有待确认的内容包：${ZH[other]}，须先撤回或等确认完成`, `${type} × 已有 ${other}`);
      }
      assert.strictEqual(sub(Object.assign({ packageType: type, otherPendingPackage: undefined }, base[type])).message, '无法确定项目里是否已有待确认的内容包，请刷新后重试', `${type} 事实没取到`);
    }
    assert.strictEqual(sub({ packageType: 'initiation', otherPendingPackage: 'overall' }), null, '立项包不受互斥约束');
    assert.strictEqual(sub({ packageType: 'initiation', otherPendingPackage: undefined }), null, '立项包不读这条事实');
    assert.deepStrictEqual(R.EXCLUSIVE_PENDING_PACKAGE_TYPES.slice(), ['overall', 'change', 'batch_accept', 'closing']);
    // 确认人集合（confirm-core 手写核对）：验收包 = 负责人 + 代表人；结项包 = 只有代表人；立项包 = 只有负责人
    assert.deepStrictEqual(R.SUBMITTABLE_PACKAGE_TYPES.slice(), ['overall', 'initiation', 'change', 'batch_accept', 'closing']);
  });

  // ═══════════════════════ 16 纯函数 ═══════════════════════
  test(`${T_CORE}——golive-core 纯函数手写矩阵：handoverNeedOf（未办结 / no_further / 风险 × 结论种类）、handoverConfirmStateOf（任务状态 × 需求部门覆盖）、conclusionKindOf、summaryOf`, async () => {
    const gc = require(path.join(modDir(), 'golive-core.js'));
    const cur = (action, kind) => ({ action, conclusion_kind: kind });
    // conclusionKindOf
    assert.strictEqual(gc.conclusionKindOf({ current: null }), null);
    assert.strictEqual(gc.conclusionKindOf({ current: cur('conclude', 'handled') }), 'handled');
    assert.strictEqual(gc.conclusionKindOf({ current: cur('for_reference', null) }), 'for_reference');
    assert.strictEqual(gc.conclusionKindOf({ current: cur('correct', null) }), null);
    // handoverNeedOf：未办结不需要；no_further 优先；风险 + 非 handled / adopted 要 accept_issue
    const need = (kind, risk, resolved, action) => gc.handoverNeedOf({ current: kind === null ? null : cur(action || 'conclude', kind), risk_current: risk }, resolved).need;
    for (const kind of ['handled', 'adopted']) assert.strictEqual(need(kind, true, true), null, `风险 + ${kind}`);
    for (const kind of ['not_adopted', 'deferred', 'to_change', 'to_sys_iteration', 'project_terminated']) assert.strictEqual(need(kind, true, true), 'accept_issue', `风险 + ${kind}`);
    for (const kind of ['handled', 'adopted', 'not_adopted', 'deferred', 'to_change', 'to_sys_iteration']) assert.strictEqual(need(kind, false, true), null, `无风险 + ${kind}`);
    assert.strictEqual(need('no_further', false, true), 'no_further');
    assert.strictEqual(need('no_further', true, true), 'no_further', '不再处理 + 风险：取不再处理');
    assert.strictEqual(need('for_reference', true, true, 'for_reference'), 'accept_issue', '风险 + 仅供参考（库内不可达的组合，照风险判）');
    assert.strictEqual(need('not_adopted', true, false), null, '未办结：先办结');
    assert.strictEqual(need(null, true, false), null);
    assert.strictEqual(gc.handoverNeedOf({ current: cur('conclude', 'no_further'), risk_current: false }, false).kind, 'no_further', '未办结也带回结论种类');
    // handoverConfirmStateOf(valid, anyOld, parties)
    const st = (valid, anyOld, parties) => gc.handoverConfirmStateOf(valid.map(([p, s]) => ({ party_id: p, status: s })), anyOld, parties);
    assert.strictEqual(st([], false, [1, 2]), 'none');
    assert.strictEqual(st([], true, [1, 2]), 'lapsed');
    assert.strictEqual(st([[1, 'confirmed'], [2, 'confirmed']], false, [1, 2]), 'confirmed');
    assert.strictEqual(st([[1, 'confirmed'], [2, 'pending']], false, [1, 2]), 'pending');
    assert.strictEqual(st([[1, 'confirmed'], [2, 'objected']], false, [1, 2]), 'declined');
    assert.strictEqual(st([[1, 'rejected'], [2, 'pending']], false, [1, 2]), 'declined');
    assert.strictEqual(st([[1, 'confirmed']], false, [1, 2]), 'incomplete', '还有需求部门没有任务');
    assert.strictEqual(st([[1, 'confirmed'], [2, 'invalid']], false, [1, 2]), 'pending', '失效的修订等改发');
    assert.strictEqual(st([[1, 'confirmed'], [2, 'superseded']], false, [1, 2]), 'pending');
    assert.strictEqual(st([[1, 'confirmed']], true, [1]), 'confirmed', '有旧任务不影响当前任务集');
    assert.strictEqual(st([[1, 'confirmed']], false, []), 'incomplete', '没有需求部门：不可能算确认');
    // summaryOf
    const items = [
      { cleared: true, need_confirm: null, confirm: { state: 'none' } }, { cleared: false, need_confirm: 'no_further', confirm: { state: 'pending' } },
      { cleared: true, need_confirm: 'accept_issue', confirm: { state: 'confirmed' } }, { cleared: false, need_confirm: null, confirm: { state: 'none' } },
    ];
    assert.deepStrictEqual(gc.summaryOf(items), { total: 4, cleared: 2, uncleared: 2, need_confirm: 2, confirmed: 1 });
    assert.deepStrictEqual(gc.summaryOf([]), { total: 0, cleared: 0, uncleared: 0, need_confirm: 0, confirmed: 0 });
    assert.deepStrictEqual(gc.HANDOVER_PURPOSE_OF, { accept_issue: 'handover_accept_issue', no_further: 'handover_no_further' });
    // 固定文案（confirm-core 手写）：交接确认按用途分设，其他用途沿用通用文案
    const cc = T.getMods().confirmCore;
    assert.deepStrictEqual(cc.checkboxTextsOf('handover_accept_issue'), { confirm: HO_CONFIRM.handover_accept_issue, object: HO_OBJECT, reject: HO_REJECT });
    assert.deepStrictEqual(cc.checkboxTextsOf('handover_no_further'), { confirm: HO_CONFIRM.handover_no_further, object: HO_OBJECT, reject: HO_REJECT });
    // plan.closeBlockers 的 p_closing 结项事实（手写）：closingStale / packagePending 必须是布尔 / 数组，否则 fail-closed 报 CLOSING_FACTS_MISSING；过期与待确认各报各的码
    const planMod = require(path.join(modDir(), 'plan.js'));
    const cNode = { id: 5, template_key: 'p_closing', batch_id: null, status: 'in_progress' };
    const cBase = { closingEffectiveAt: '2026-10-01 10:00:00', closingStale: false, packagePending: [], notLive: [], transferNoChange: [], goliveNewer: [] };
    const cb = (cl) => planMod.closeBlockers(cNode, [cNode], { closing: Object.assign({}, cBase, cl), entryUnresolved: [] });
    assert.deepStrictEqual(cb({}).map((b) => b.code), []);
    assert.deepStrictEqual(cb({ closingStale: true }).map((b) => b.code), ['CLOSING_STALE']);
    assert.deepStrictEqual(cb({ closingStale: true, closingEffectiveAt: null }).map((b) => b.code), ['PACKAGE_NOT_EFFECTIVE'], '没有生效的结项包时只报未生效，不报过期');
    const pp = cb({ packagePending: ['change', 'closing'] });
    assert.deepStrictEqual(pp.map((b) => b.code), ['PACKAGE_PENDING']);
    assert.strictEqual(pp[0].message, '项目里还有待确认的内容包（变更、结项），须先处理完再整体验收结项');
    assert.deepStrictEqual(cb({ closingStale: true, packagePending: ['closing'] }).map((b) => b.code), ['CLOSING_STALE', 'PACKAGE_PENDING']);
    for (const bad of [{ closingStale: undefined }, { closingStale: 'yes' }, { packagePending: undefined }, { packagePending: 'change' }]) assert.deepStrictEqual(cb(bad).map((b) => b.code), ['CLOSING_FACTS_MISSING'], JSON.stringify(bad));
    for (const purpose of ['package_confirm', 'proposer_confirm', 'conclusion_confirm', 'adjudicate', 'dev_key_confirm', 'bogus']) assert.deepStrictEqual(cc.checkboxTextsOf(purpose), { confirm: GENERIC_CONFIRM, object: HO_OBJECT, reject: HO_REJECT }, purpose);
  });

  // ═══════════════════════ 16 修订批 1（预筛 1 轮）═══════════════════════
  const draftOfChange = async (cid) => (await sqlGet("SELECT v.id AS id FROM sysbuild_package_versions v JOIN sysbuild_changes c ON c.package_id = v.package_id WHERE c.id = ? AND v.status = 'draft'", [cid])).id;
  // 建一次正式变更并按 ops 改它的草稿集合（op 为 add / remove，字段同 POST /package-versions/:vid/items），不提交。返回 { cid, vid }。
  async function draftChange(s, ops) {
    const r = await post(U.pm, `/sysbuild/projects/${s.pid}/changes`, CHG);
    assert.strictEqual(r.status, 201, r.text);
    const cid = r.body.change.id;
    const vid = await draftOfChange(cid);
    for (const o of ops) {
      const x = await post(U.pm, `/sysbuild/package-versions/${vid}/items`, o);
      assert.strictEqual(x.status, 201, `${JSON.stringify(o)}: ${x.text}`);
    }
    return { cid, vid };
  }
  const submitChange = (cid) => post(U.pm, `/sysbuild/changes/${cid}/submit`);
  const effectiveOverallOf = async (pid) => (await sqlGet("SELECT v.id AS id FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id WHERE p.project_id = ? AND p.type = 'overall' AND v.status = 'effective' ORDER BY v.id DESC LIMIT 1", [pid])).id;
  const blockerCodes = (view) => view.blockers.map((b) => b.code);

  test(`${T_UNB}——（P162）当前去向留项目且承诺批次为空的登记（补选「规划内待细化」新条目 / 本批条目的新版本、「规划外」留项目）进每个批次的集合并挡上线，办结 / 作废后放行；规划外转系统迭代不进集合；（P167）转系统迭代且承诺批次含本批的未办结登记进集合，撤销后再上线被拦`, async () => {
    const s = await mkPlan({ batch2: true, m1: true });
    const mkE = (title) => regOk(U.pm, s.pid, { type: 'issue', title });
    const snapsOf = (eid) => sqlAll('SELECT route, basis_category, committed_batch_id FROM sysbuild_routing_snapshots WHERE entry_id = ? ORDER BY id', [eid]);
    // PROBE A：规划内尚未细化（新条目）
    const eA = await mkE('A 规划内待细化（新条目）');
    const itN = await mkItem(s.pid);
    await actOk(U.pm, eA.id, { action: 'assign_items', basis_category: 'planned_detail', item_ids: [itN.id], text: '规划内尚未细化，补建条目' });
    // PROBE B：规划外留项目
    const eB = await mkE('B 规划外留项目');
    await actOk(U.pm, eB.id, { action: 'assign_items', basis_category: 'out_of_plan', route: 'project', text: '确属规划外，拟发起范围变更' });
    // PROBE C：规划内待细化（本批条目的新版本）
    const eC = await mkE('C 规划内待细化（本批条目新版本）');
    assert.strictEqual((await post(U.pm, `/sysbuild/items/${s.i1.id}/versions`, Object.assign({ content: '需求：支持按部门导出（细化）', proposer_name: '外部张三' }, EV))).status, 201);
    await actOk(U.pm, eC.id, { action: 'assign_items', basis_category: 'planned_detail', item_ids: [s.i1.id], text: '规划内尚未细化，本批条目出新版本' });
    // D：规划外转系统迭代（不进集合）
    const eD = await mkE('D 规划外转系统迭代');
    await actOk(U.pm, eD.id, { action: 'assign_items', basis_category: 'out_of_plan', route: 'sys_iteration', text: '确属规划外，到系统迭代受理' });
    for (const e of [eA, eB, eC]) assert.deepStrictEqual((await snapsOf(e.id)).map((x) => [x.route, x.committed_batch_id]).pop(), ['project', null], `前置：登记 ${e.id} 去向留项目、承诺批次为空`);
    assert.deepStrictEqual((await snapsOf(eD.id)).map((x) => [x.route, x.committed_batch_id]).pop(), ['sys_iteration', null], '前置：D 转系统迭代、没有承诺批次');
    const v1 = await handoverGet(U.pm, s.batch1);
    const v2 = await handoverGet(U.pm, s.batch2);
    for (const [view, label] of [[v1, '第 1 批'], [v2, '第 2 批']]) {
      assert.deepStrictEqual(idsOf(view), [eA.id, eB.id, eC.id], `${label}：A / B / C 都进集合（承诺批次为空 = 每个批次），D 不进`);
      for (const e of [eA, eB, eC]) assert.deepStrictEqual([itemOf(view, e.id).sources, itemOf(view, e.id).route, itemOf(view, e.id).committed_batch_ids, itemOf(view, e.id).cleared], [['unbatched'], 'project', [], false], `${label} 登记 ${e.id}`);
    }
    await ready(s);
    const r1 = await goliveReq(U.pm, s.batch1);
    expectErr(r1, 409, 'SYSBUILD_GOLIVE_BLOCKED', '承诺批次为空的未办结登记挡上线');
    assert.deepStrictEqual(r1.body.blockers.map((b) => [b.code, b.entry_ids]), [['HANDOVER_UNCLEARED', [eA.id, eB.id, eC.id]]]);
    // 办结 A、C；作废 B（作废的不在集合里）：放行
    await actOk(U.pm, eA.id, CONCLUDE);
    await actOk(U.pm, eC.id, CONCLUDE);
    assert.deepStrictEqual(blockerCodes(await handoverGet(U.pm, s.batch1)), ['HANDOVER_UNCLEARED'], 'B 还没办结');
    await actOk(U.pm, eB.id, { action: 'void', reason: '作废' });
    assert.deepStrictEqual(idsOf(await handoverGet(U.pm, s.batch1)), [eA.id, eC.id], '作废的出集合；已办结的仍列出');
    await goLive(s);
    // P167：上线后新登记（待判定）补选归属到已上线条目 → 去向转系统迭代、承诺批次 = 本批（commit_batch_id 随快照）
    const eS = await mkE('S 上线后登记');
    await actOk(U.pm, eS.id, { action: 'assign_items', basis_category: 'in_plan', item_ids: [s.i1.id], text: 'i1 已上线，转系统迭代受理' });
    assert.deepStrictEqual((await snapsOf(eS.id)).map((x) => [x.route, x.committed_batch_id]).pop(), ['sys_iteration', s.batch1], '前置：转系统迭代且承诺批次 = 第 1 批');
    const vS = await handoverGet(U.pm, s.batch1);
    assert.deepStrictEqual([itemOf(vS, eS.id).sources, itemOf(vS, eS.id).route, itemOf(vS, eS.id).committed_batch_ids, itemOf(vS, eS.id).cleared], [['committed'], 'sys_iteration', [s.batch1], false], '转系统迭代且承诺本批的登记进集合');
    assert.ok(!idsOf(await handoverGet(U.pm, s.batch2)).includes(eS.id), '承诺批次不含第 2 批：不进第 2 批');
    await H.productionRevoke(s.batch1, '撤销后验证转系统迭代的未办结登记');
    const r2 = await goliveReq(U.pm, s.batch1);
    expectErr(r2, 409, 'SYSBUILD_GOLIVE_BLOCKED', '转系统迭代的未办结登记挡再上线');
    assert.deepStrictEqual(r2.body.blockers.map((b) => [b.code, b.entry_ids]), [['HANDOVER_UNCLEARED', [eS.id]]]);
    await actOk(U.pm, eS.id, concl('to_sys_iteration', { sys_issue_no: 'SI-101', assignee_text: '外包张三' }));
    const re = await goLive(s);
    assert.strictEqual(re.golive_event.kind, 'regolive');
  });

  test(`${T_STALE}——（P168）上线前置 ACCEPT_STALE：本批现行生效的验收包版本 parent ≠ 现行总体规划版本（验收后规划经正式变更换版）→ 上线 409、actions.golive 为假；（P164）PLAN_PENDING：项目有待确认的总体规划 / 变更包版本时不能上线；重新确认的出路：已生效的验收包建新草稿 → 提交（parent 重写成现行）→ 生效 → 放行`, async () => {
    const s = await mkPlan();
    const acc = await ready(s);
    const i2 = await mkItem(s.pid);
    assert.deepStrictEqual((await handoverGet(U.pm, s.batch1)).blockers, [], '前置：验收包引用现行规划，没有阻塞');
    const eff1 = await effectiveOverallOf(s.pid);
    assert.strictEqual((await sqlGet('SELECT parent_overall_version_id AS p FROM sysbuild_package_versions WHERE id = ?', [acc.pv])).p, eff1, '前置：验收包 parent = 验收时的现行规划');
    // 正式变更提交 → 待确认：PLAN_PENDING
    const ch = await draftChange(s, [{ op: 'add', item_version_id: i2.versions[0].id, committed_batch_id: s.batch1 }]);
    assert.strictEqual((await submitChange(ch.cid)).status, 200);
    let view = await handoverGet(U.pm, s.batch1);
    assert.deepStrictEqual(blockerCodes(view), ['PLAN_PENDING']);
    assert.strictEqual(view.blockers[0].message, '项目里有待确认的总体规划或变更，须等确认完成或撤回后再上线');
    assert.strictEqual(view.actions.golive, false, 'actions.golive 同源为假');
    const rp = await goliveReq(U.pm, s.batch1);
    expectErr(rp, 409, 'SYSBUILD_GOLIVE_BLOCKED', '变更待确认');
    assert.deepStrictEqual(rp.body.blockers.map((b) => b.code), ['PLAN_PENDING']);
    assert.strictEqual((await get(U.pm, `/sysbuild/projects/${s.pid}/plan`)).body.batches[0].actions.golive, false, '计划视图的标志同为假');
    // 变更生效（规划换版）：验收包引用的规划已不是现行 → ACCEPT_STALE
    await confirmAll(ch.vid);
    const eff2 = await effectiveOverallOf(s.pid);
    assert.notStrictEqual(eff2, eff1, '前置：规划已换版');
    view = await handoverGet(U.pm, s.batch1);
    assert.deepStrictEqual(blockerCodes(view), ['ACCEPT_STALE']);
    assert.ok(view.blockers[0].message.includes('重新提交批次验收'), view.blockers[0].message);
    assert.strictEqual(view.actions.golive, false);
    const rs = await goliveReq(U.pm, s.batch1);
    expectErr(rs, 409, 'SYSBUILD_GOLIVE_BLOCKED', '验收包引用的规划已过期');
    assert.deepStrictEqual(rs.body.blockers.map((b) => b.code), ['ACCEPT_STALE']);
    assert.strictEqual((await batchRow(s.batch1)).status, 'active', '被拒不上线');
    assert.strictEqual((await get(U.pm, `/sysbuild/projects/${s.pid}/plan`)).body.batches[0].actions.golive, false);
    // 重新确认：已有生效版本的验收包可以建新草稿（parent = 现行）、提交、确认生效，旧版本被替代
    const nv = await mkVersion(acc.pk);
    assert.strictEqual((await sqlGet('SELECT parent_overall_version_id AS p FROM sysbuild_package_versions WHERE id = ?', [nv])).p, eff2, '新草稿的 parent = 现行规划');
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${nv}/submit`)).status, 200);
    assert.deepStrictEqual(blockerCodes(await handoverGet(U.pm, s.batch1)), ['ACCEPT_STALE'], '新版本待确认期间旧生效版本仍是过期的');
    await confirmAll(nv);
    assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id = ?', [acc.pv])).status, 'superseded');
    view = await handoverGet(U.pm, s.batch1);
    assert.deepStrictEqual([view.blockers, view.actions.golive], [[], true], '重新确认后放行');
    await goLive(s);
    assert.strictEqual((await batchRow(s.batch1)).status, 'live');
  });

  test(`${T_PPEND}——（P168）p_closing 前置 CLOSING_STALE：现行生效结项包版本 parent ≠ 现行总体规划版本；（P164）PACKAGE_PENDING：项目有任何待确认的内容包版本（变更 / 结项包新版本…）时不能整体结项；读接口 close_blockers 同源；重新确认结项包后放行`, async () => {
    const s = await mkPlan();
    await ready(s);
    await goLive(s, '-2 hours');
    const closingNode = await startNode(s.pid, 'p_closing');
    const codes = (r) => r.body.blockers.map((b) => b.code);
    const nodeBlockers = async () => (await get(U.pm, `/sysbuild/projects/${s.pid}/plan`)).body.nodes.find((n) => n.id === closingNode).close_blockers;
    const clPk = await mkPackage(s.pid, 'closing');
    const clV1 = await mkVersion(clPk);
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${clV1}/submit`)).status, 200);
    await confirmAll(clV1);
    assert.strictEqual((await sqlGet('SELECT parent_overall_version_id AS p FROM sysbuild_package_versions WHERE id = ?', [clV1])).p, await effectiveOverallOf(s.pid), '前置：结项包 parent = 现行规划');
    assert.deepStrictEqual(await nodeBlockers(), [], '前置：没有阻塞');
    // 集合不变的正式变更（已上线批次的承诺条目集合冻结，所以不改条目）：提交后待确认 → PACKAGE_PENDING（文案带包类型）
    const ch = await draftChange(s, []);
    assert.strictEqual((await submitChange(ch.cid)).status, 200);
    const r1 = await closeNodeReq(closingNode);
    expectErr(r1, 409, 'SYSBUILD_CLOSE_BLOCKED', '变更待确认');
    assert.deepStrictEqual(codes(r1), ['PACKAGE_PENDING']);
    assert.ok(r1.body.blockers[0].message.includes('变更'), r1.body.blockers[0].message);
    assert.deepStrictEqual((await nodeBlockers()).map((b) => b.code), ['PACKAGE_PENDING'], '读接口 close_blockers 同源');
    assert.strictEqual(await projStatus(s.pid), 'active', '被拒不结项');
    // 变更生效（规划换版）：结项包引用的规划已不是现行 → CLOSING_STALE
    await confirmAll(ch.vid);
    const r2 = await closeNodeReq(closingNode);
    assert.deepStrictEqual(codes(r2), ['CLOSING_STALE']);
    assert.ok(r2.body.blockers[0].message.includes('重新提交结项包'), r2.body.blockers[0].message);
    assert.deepStrictEqual((await nodeBlockers()).map((b) => b.code), ['CLOSING_STALE']);
    // 新结项包版本提交后待确认：两条同时挡（旧生效版本仍过期 + 有待确认的包）
    const clV2 = await mkVersion(clPk);
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${clV2}/submit`)).status, 200);
    assert.deepStrictEqual(codes(await closeNodeReq(closingNode)), ['CLOSING_STALE', 'PACKAGE_PENDING']);
    await confirmAll(clV2);
    assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id = ?', [clV1])).status, 'superseded');
    const ok = await closeNodeReq(closingNode);
    assert.strictEqual(ok.status, 200, ok.text);
    assert.strictEqual(await projStatus(s.pid), 'closed');
  });

  test(`${T_FREEZE}——（P163）正式变更提交时：已上线批次的承诺条目版本集合冻结——往已上线批次加条目 / 给已承诺到已上线批次的条目换版本 / 把条目移入已上线批次都 409（判据 batchLiveState）；集合不变的变更放行；撤销上线后同样的改动放行`, async () => {
    const s = await mkPlan();
    const i2 = await mkItem(s.pid);
    await ready(s);
    await goLive(s);
    const FROZEN = '已上线批次的承诺条目版本集合已冻结';
    // ① 加条目
    const c1 = await draftChange(s, [{ op: 'add', item_version_id: i2.versions[0].id, committed_batch_id: s.batch1 }]);
    const r1 = await submitChange(c1.cid);
    expectErr(r1, 409, 'SYSBUILD_STATE', '往已上线批次加条目');
    assert.ok(r1.body.message.includes(FROZEN), r1.body.message);
    const code2 = (await sqlGet('SELECT code FROM sysbuild_items WHERE id = ?', [i2.id])).code;
    assert.ok(r1.body.message.includes(code2), `文案列出条目编号 ${code2}：${r1.body.message}`);
    assert.strictEqual((await chStatus(c1.cid)), 'draft', '被拒不改状态');
    // ② 换版本：i1 出新版本，变更集合里把它的旧版本换成新版本（仍承诺到已上线批次）
    assert.strictEqual((await post(U.pm, `/sysbuild/items/${s.i1.id}/versions`, Object.assign({ content: '需求：支持按部门导出（改版）', proposer_name: '外部张三' }, EV))).status, 201);
    const newVer = (await sqlGet('SELECT id FROM sysbuild_item_versions WHERE item_id = ? ORDER BY version_no DESC LIMIT 1', [s.i1.id])).id;
    const c2 = await draftChange(s, [{ op: 'remove', item_version_id: s.i1.ver }, { op: 'add', item_version_id: newVer, committed_batch_id: s.batch1 }]);
    const r2 = await submitChange(c2.cid);
    expectErr(r2, 409, 'SYSBUILD_STATE', '给已上线批次的条目换版本');
    assert.ok(r2.body.message.includes(FROZEN), r2.body.message);
    // ③ 集合不变的变更放行（冻结的是「差异」，不是整个变更功能）
    const c3 = await draftChange(s, []);
    assert.strictEqual((await submitChange(c3.cid)).status, 200, '集合不变：放行');
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${c3.vid}/withdraw`, { reason: '撤回再试其他情形' })).status, 200);
    // ④ 撤销上线后（不再是已上线批次）同样的加条目放行
    await H.productionRevoke(s.batch1, '撤销后验证冻结只对已上线批次');
    assert.strictEqual((await submitChange(c1.cid)).status, 200, '批次未上线：加条目放行');
    // ⑤ 移入：第 2 批（夹具：现行规划里一个条目承诺到第 2 批）的条目被变更移入已上线的第 1 批
    const s2 = await mkPlan({ batch2: 'active' });
    const iM = await s2.mkInPlan(s2.batch2);
    await ready(s2);
    await goLive(s2);
    const c5 = await draftChange(s2, [{ op: 'remove', item_version_id: iM.ver }, { op: 'add', item_version_id: iM.ver, committed_batch_id: s2.batch1 }]);
    const r5 = await submitChange(c5.cid);
    expectErr(r5, 409, 'SYSBUILD_STATE', '条目移入已上线批次');
    assert.ok(r5.body.message.includes(FROZEN), r5.body.message);
    // ⑥ P170：上线后的同一秒窗口——批次状态已是 live，但 batchLiveState 还判未上线（事件时刻不早于现在）；冻结属编辑类守卫，两者任一成立就冻结。
    //   夹具：把上线事件时刻写成一小时后，窗口变成确定的（不依赖墙钟的秒边界）。
    const s3 = await mkPlan();
    const i3 = await mkItem(s3.pid);
    await ready(s3);
    await H.productionGolive(s3.batch1, '+1 hour');
    assert.strictEqual((await batchRow(s3.batch1)).status, 'live', '前置：状态 live');
    const c6 = await draftChange(s3, [{ op: 'add', item_version_id: i3.versions[0].id, committed_batch_id: s3.batch1 }]);
    const r6 = await submitChange(c6.cid);
    expectErr(r6, 409, 'SYSBUILD_STATE', '同一秒窗口内加条目');
    assert.ok(r6.body.message.includes(FROZEN), r6.body.message);
    await H.productionRevoke(s3.batch1, '撤销后冻结解除');
    assert.strictEqual((await submitChange(c6.cid)).status, 200, '撤销上线后（状态回 active、最后一条事件是 revoke）：放行');
  });
  const chStatus = async (cid) => (await sqlGet('SELECT status FROM sysbuild_changes WHERE id = ?', [cid])).status;

  test(`${T_LAPSE}——（预筛 LOW-1）交接确认任务的对象不仅要指纹未变，还要登记当前仍已办结且所需用途 = 任务用途：变更撤回让「转正式变更」结论派生为失效（没有新办理动作、指纹不变）后，待确认的交接修订不能再确认、不能改发，读接口 fingerprint_current 为假`, async () => {
    const s = await mkPlan({ m1: true });
    const r = await post(U.pm, `/sysbuild/projects/${s.pid}/changes`, CHG);
    assert.strictEqual(r.status, 201, r.text);
    const cid = r.body.change.id;
    const vid = await draftOfChange(cid);
    const e = await regOk(U.m1, s.pid, { type: 'issue', is_risk: 1, item_ids: [s.i1.id], title: '带风险、转正式变更的问题' }); // 成员提出：结论要提出人确认（代表人）
    await actOk(U.pm, e.id, { action: 'conclude', conclusion_kind: 'to_change', text: '转正式变更处理', change_id: cid });
    const ctask = await sqlGet("SELECT id FROM sysbuild_confirm_tasks WHERE object_type = 'conclusion' AND object_id = ?", [e.id]);
    assert.strictEqual((await H.openAndDecide(U.del, ctask.id, 'confirm')).status, 200, '前置：结论已确认');
    assert.strictEqual((await submitChange(cid)).status, 200, '前置：变更提交（待确认期间结论仍有效）');
    assert.strictEqual((await detail(U.pm, e.id)).conclusion_state, 'confirmed');
    assert.strictEqual(itemOf(await handoverGet(U.pm, s.batch1), e.id).need_confirm, 'accept_issue', '前置：带风险且结论不是已处理 / 已采纳 → 需要「接受带此问题上线」确认');
    const rq = await requestHo(U.pm, s.batch1, e.id);
    assert.strictEqual(rq.status, 201, rq.text);
    const t = (await hoTasks(e.id))[0];
    assert.strictEqual(t.status, 'pending');
    // 变更撤回：结论派生为失效，登记没有新办理动作（指纹不变）
    const fpBefore = (await sqlGet('SELECT MAX(id) AS m FROM sysbuild_entry_actions WHERE entry_id = ?', [e.id])).m;
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${vid}/withdraw`, { reason: '撤回变更' })).status, 200);
    assert.strictEqual((await sqlGet('SELECT MAX(id) AS m FROM sysbuild_entry_actions WHERE entry_id = ?', [e.id])).m, fpBefore, '前置：没有新的办理动作，指纹不变');
    assert.strictEqual((await detail(U.pm, e.id)).conclusion_state, 'to_change_lapsed');
    const open = await get(U.del, `/sysbuild/confirm-tasks/${t.task_id}`);
    assert.strictEqual(open.status, 200, open.text);
    assert.strictEqual(open.body.object.fingerprint_current, false, '对象已变化');
    assert.strictEqual(open.body.actions.decide, false);
    const dec = await decideHo(U.del, t.task_id, 'confirm');
    expectErr(dec, 409, 'SYSBUILD_VERSION_CHANGED', '结论已失效的交接修订不能再确认');
    expectErr(await post(U.pm, `/sysbuild/confirm-tasks/${t.task_id}/reissue`, { reason: '想改发' }), 409, 'SYSBUILD_STATE', '对象已变化不能改发');
    assert.strictEqual((await hoTasks(e.id))[0].status, 'pending', '失败的确认不改修订');
    assert.strictEqual(itemOf(await handoverGet(U.pm, s.batch1), e.id).resolved, false, '登记回到未办结');
  });

  test(`${T_REOPEN}——（预筛 LOW-3）已结项项目重开（closed → active）时整体验收结项节点 p_closing 必须是已收口（结项只经它收口产生）：不是 / 没有该节点 = 数据不一致，500 SYSBUILD_INTERNAL 且整个重开回滚，不静默跳过；节点已收口则重开并退回进行中`, async () => {
    const s = await mkPlan();
    const closingNode = await nodeIdOf(s.pid, 'p_closing');
    await sqlRun("UPDATE sysbuild_projects SET status = 'closed' WHERE id = ?", [s.pid]); // 夹具：项目已结项，但 p_closing 仍是未开始（直接改库造成的不一致）
    const r1 = await setStatus(s.pid, 'active');
    assert.strictEqual(r1.status, 500, r1.text);
    assert.strictEqual(r1.body.code, 'SYSBUILD_INTERNAL');
    assert.strictEqual(await projStatus(s.pid), 'closed', '整个重开回滚：项目仍是已结项');
    assert.strictEqual((await nodeRow(closingNode)).status, 'not_started');
    assert.strictEqual((await payloads(s.pid, 'project_status_changed')).filter((p) => p.from === 'closed').length, 0, '回滚后没有状态事件');
    // 没有 p_closing 节点（夹具：删掉）同样 500
    await sqlRun('DELETE FROM sysbuild_nodes WHERE id = ?', [closingNode]);
    assert.strictEqual((await setStatus(s.pid, 'active')).status, 500);
    assert.strictEqual(await projStatus(s.pid), 'closed');
    // 节点是已收口：正常重开，p_closing 退回进行中
    await sqlRun("INSERT INTO sysbuild_nodes (project_id, batch_id, template_key, name, sort_order, status, opened_at, closed_at) VALUES (?, NULL, 'p_closing', '整体验收结项', 99, 'closed', '2026-10-01 10:00:00', '2026-10-02 10:00:00')", [s.pid]);
    assert.strictEqual((await setStatus(s.pid, 'active')).status, 200);
    assert.strictEqual(await projStatus(s.pid), 'active');
    assert.strictEqual((await nodeRow(await nodeIdOf(s.pid, 'p_closing'))).status, 'in_progress');
  });

  // ═══════════════════════ 17 修订批 2（预筛 2 轮）═══════════════════════
  test(`${T_DECL}——（P173）交接确认被不认可（当前或历史上任一不认可的修订）之后，只有该登记出现新的结论类动作（conclude / for_reference / void / adjudicate）才解除：更正不解除；取消风险被拒（P175）；结论失效后不再需要确认的项仍判未清且答复无效、重新发起 409；改结论后可重新发起，全部确认后上线放行`, async () => {
    // 场景：带风险、转正式变更的问题（结论「转正式变更」所挂变更撤回后派生为失效，才能再给结论——已确认的有效结论不能直接改，所以「改结论」走这条路）
    const s = await mkPlan({ m1: true });
    const cr = await post(U.pm, `/sysbuild/projects/${s.pid}/changes`, CHG);
    assert.strictEqual(cr.status, 201, cr.text);
    const cid = cr.body.change.id;
    const cvid = await draftOfChange(cid);
    const e = await regOk(U.m1, s.pid, { type: 'issue', is_risk: 1, item_ids: [s.i1.id], title: '要被不认可的阻塞项' });
    await actOk(U.pm, e.id, { action: 'conclude', conclusion_kind: 'to_change', text: '转正式变更处理', change_id: cid });
    assert.strictEqual((await H.openAndDecide(U.del, (await sqlGet("SELECT id FROM sysbuild_confirm_tasks WHERE object_type = 'conclusion' AND object_id = ?", [e.id])).id, 'confirm')).status, 200);
    assert.strictEqual((await submitChange(cid)).status, 200, '前置：变更提交（待确认期间结论仍有效）');
    assert.strictEqual((await requestHo(U.pm, s.batch1, e.id)).status, 201);
    assert.strictEqual((await decideHo(U.del, (await hoTasks(e.id))[0].task_id, 'reject')).status, 200);
    const DECL = '须先写答复';
    const state = async () => itemOf(await handoverGet(U.pm, s.batch1), e.id);
    let it = await state();
    assert.deepStrictEqual([it.confirm.state, it.cleared, it.reply_required], ['declined', false, true]);
    // ① 更正：不解除（状态仍 declined、不能重新发起、不能上线）
    await actOk(U.pm, e.id, { action: 'correct', text: '更正：补充说明' });
    it = await state();
    assert.deepStrictEqual([it.confirm.state, it.cleared, it.reply_required], ['declined', false, true], '更正不解除');
    const r1 = await requestHo(U.pm, s.batch1, e.id);
    expectErr(r1, 409, 'SYSBUILD_STATE', '更正后重新发起');
    assert.ok(r1.body.message.includes(DECL), r1.body.message);
    // ② 取消风险标记（P175，修订批 4）：有未解除的不认可时被拒（不能靠取消风险使该项不再需要确认）；登记不变、读接口标志同源为假；上线前置仍列该项；重新发起仍 409
    const UNMARK_MSG = '该登记的交接确认已被代表人不认可，须先写答复重新发起、由代表人对重新发起的确认作出确认，或给出新的结论；在此之前不能取消风险标记';
    const rUn = await act(U.pm, e.id, { action: 'unmark_risk', reason: '风险解除' });
    expectErr(rUn, 409, 'SYSBUILD_STATE', '有未解除的不认可时取消风险');
    assert.strictEqual(rUn.body.message, UNMARK_MSG);
    it = await state();
    assert.deepStrictEqual([it.need_confirm, it.risk_current, it.cleared, it.confirm.state], ['accept_issue', true, false, 'declined'], '风险标记仍在、仍需确认、仍未清');
    assert.strictEqual((await detail(U.pm, e.id)).actions.unmark_risk, false, '读接口 actions.unmark_risk 与执行同源为假');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_entry_actions WHERE entry_id = ? AND action = 'unmark_risk'", [e.id]), 0, '被拒不写办理记录');
    const blk = (await handoverGet(U.pm, s.batch1)).blockers.find((b) => b.code === 'HANDOVER_UNCLEARED');
    assert.deepStrictEqual(blk && blk.entry_ids, [e.id], '上线前置 HANDOVER_UNCLEARED 列出该项（同时还有变更待确认的 PLAN_PENDING，与本断言无关）');
    const r2 = await requestHo(U.pm, s.batch1, e.id);
    expectErr(r2, 409, 'SYSBUILD_STATE', '取消风险被拒后重新发起');
    assert.ok(r2.body.message.includes(DECL), r2.body.message);
    // ③ 撤回变更使「转正式变更」结论派生为失效（不是结论类动作，不解除；此时未办结，该项不再需要确认，仍判未清且原因点名未解除的不认可；没有可写的答复）
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${cvid}/withdraw`, { reason: '撤回变更' })).status, 200);
    it = await state();
    assert.deepStrictEqual([it.resolved, it.need_confirm, it.confirm.state, it.cleared, it.reply_required], [false, null, 'declined', false, false], '撤回变更不解除；不需要确认时 reply_required 为假（P175）');
    assert.ok(it.reasons.some((x) => x.includes('不认可') && x.includes('已不需要交接确认')), `原因点名未解除的不认可：${JSON.stringify(it.reasons)}`);
    assert.strictEqual(it.reasons.some((x) => x.includes('裁定')), false, 'LOW-1：文案不把「裁定」列为出路');
    // ④ 新的结论类动作（conclude）：解除；可以重新发起，确认后上线放行
    await actOk(U.pm, e.id, concl('not_adopted', { text: '改结论：不采纳，重新说明' }));
    const ct2 = await sqlGet("SELECT id FROM sysbuild_confirm_tasks WHERE object_type = 'conclusion' AND object_id = ? ORDER BY id DESC LIMIT 1", [e.id]);
    assert.strictEqual((await H.openAndDecide(U.del, ct2.id, 'confirm')).status, 200, '提出人是成员：新结论要代表人确认才算办结');
    it = await state();
    assert.deepStrictEqual([it.confirm.state, it.actions.handover_request, it.cleared], ['lapsed', true, false], '结论类动作解除不认可');
    assert.strictEqual((await requestHo(U.pm, s.batch1, e.id)).status, 201);
    for (const t of (await hoTasks(e.id)).filter((x) => x.status === 'pending')) assert.strictEqual((await decideHo(t.user_id, t.task_id, 'confirm')).status, 200);
    assert.deepStrictEqual([(await state()).confirm.state, (await state()).cleared], ['confirmed', true]);
    await ready(s);
    const g = await goliveReq(U.pm, s.batch1);
    assert.strictEqual(g.status, 200, g.text);
  });

  test(`${T_DECL}（作废 / 仅供参考也解除）——结论类动作的种类集合手写核对：conclude / for_reference / void / adjudicate 解除，correct / link_sys_issue / mark_risk / unmark_risk / assign_items 等不解除；declineOutstandingOf 只认不认可之后（编号大于任务指纹）的动作`, async () => {
    const gc = require(path.join(modDir(), 'golive-core.js'));
    // 假 q：all → 一条不认可的任务指纹 5；get → 参数里的动作种类集合与「不认可之后出现的动作」有交集才返回一行（动作编号条件 id > 指纹由端到端用例核对）
    //   P177：(b) 被不认可的部门在其后有已确认修订也解除（第二条 get，SQL 含 c.status = 'confirmed'）；答复事件不影响「未解除」，只影响「待答复」
    let lastSql = '';
    let lastConfSql = '';
    let lastConfParams = null;
    const fake = (after, replied, confirmedAfter) => ({
      all: async (sql) => (sql.includes('sysbuild_events') ? (replied ? [{ payload_json: JSON.stringify({ replied_revision_ids: replied }) }, { payload_json: 'not json' }] : []) : [{ revision_id: 11, task_id: 1, party_id: 1, fp: 5 }]),
      get: async (sql, params) => {
        if (sql.includes("c.status = 'confirmed'")) { lastConfSql = sql; lastConfParams = params; return confirmedAfter ? { id: 99 } : undefined; }
        lastSql = sql;
        return params.slice(2).some((a) => after.includes(a)) ? { id: 9 } : undefined;
      },
    });
    await gc.declineOutstandingOf(fake([]), 1);
    assert.ok(lastSql.includes('id > ?') && !lastSql.includes('id >= ?'), `只认不认可之后（编号严格大于任务指纹）的动作：${lastSql}`);
    for (const a of ['conclude', 'for_reference', 'void', 'adjudicate']) assert.strictEqual(await gc.declineOutstandingOf(fake([a]), 1), false, `${a} 解除`);
    for (const a of ['correct', 'link_sys_issue', 'link_change', 'mark_risk', 'unmark_risk', 'mark_commitment', 'unmark_commitment', 'assign_items', 'split', 'escalate']) assert.strictEqual(await gc.declineOutstandingOf(fake([a]), 1), true, `${a} 不解除`);
    assert.strictEqual(await gc.declineOutstandingOf(fake([]), 1), true, '之后没有任何动作：未解除');
    assert.strictEqual(await gc.declineOutstandingOf({ all: async () => [], get: async () => undefined }, 1), false, '从未被不认可');
    // P177 (b)：同一登记、同一需求部门、编号大于该不认可修订、已确认；参数 [登记, 部门, 不认可修订编号]
    assert.strictEqual(await gc.declineOutstandingOf(fake([], undefined, true), 1), false, '(b) 之后已确认：解除');
    assert.ok(lastConfSql.includes('t.party_id = ?') && lastConfSql.includes('c.id > ?') && !lastConfSql.includes('c.id >= ?') && lastConfSql.includes("t.object_type = 'handover'"), lastConfSql);
    assert.deepStrictEqual(lastConfParams, [1, 1, 11], '(b) 的参数：登记 1、部门 1、被不认可的修订 11');
    // P177：答复事件不解除不认可（按修订编号，坏的事件 JSON 忽略）；只影响待答复
    assert.strictEqual(await gc.declineOutstandingOf(fake([], [11]), 1), true, '被答复的修订仍未解除');
    assert.strictEqual(await gc.declineOutstandingOf(fake([], [12]), 1), true);
    assert.deepStrictEqual((await gc.unrepliedDeclinesOf(fake([], [11]), 1)).map((r) => r.revision_id), [], '被答复的不再待答复');
    assert.deepStrictEqual((await gc.unrepliedDeclinesOf(fake([], [12]), 1)).map((r) => r.revision_id), [11], '答复的是别的修订：仍待答复');
    assert.deepStrictEqual((await gc.unrepliedDeclinesOf(fake([], []), 1)).map((r) => r.revision_id), [11]);
    assert.deepStrictEqual((await gc.unrepliedDeclinesOf(fake([], [], true), 1)).map((r) => r.revision_id), [], '已解除的不在待答复里');
    assert.deepStrictEqual((await gc.unrepliedDeclinesOf(fake([], []), 1, [])).map((r) => r.revision_id), [], '传入的未解除清单为空：没有待答复');
    // 状态纯函数：未解除的不认可恒为 declined（不论当前指纹下有没有任务）
    assert.strictEqual(gc.handoverConfirmStateOf([], true, [1], true), 'declined');
    assert.strictEqual(gc.handoverConfirmStateOf([], false, [1], true), 'declined');
    assert.strictEqual(gc.handoverConfirmStateOf([{ party_id: 1, status: 'confirmed' }], false, [1], true), 'declined');
    assert.strictEqual(gc.handoverConfirmStateOf([{ party_id: 1, status: 'confirmed' }], false, [1], false), 'confirmed');
    assert.strictEqual(gc.handoverConfirmStateOf([], true, [1]), 'lapsed', '缺省 false');
  });

  test(`${T_EFFECT}——（P169）(a) 项目有待确认的总体规划 / 变更包时上线事件历史导入 409（与普通上线前置共用 planPendingOf）；(b) 变更生效时再核已上线批次冻结：提交时批次未上线、生效前已上线（夹具：直接写上线事件，生产路径的上线与导入都被 (a) 挡住）→ 最后一个确认 409 整笔回滚，变更与确认任务仍待确认、可撤回`, async () => {
    // (a)
    const s = await mkPlan({ m1: true });
    const i2 = await mkItem(s.pid);
    const ch = await draftChange(s, [{ op: 'add', item_version_id: i2.versions[0].id, committed_batch_id: s.batch1 }]);
    assert.strictEqual((await submitChange(ch.cid)).status, 200);
    await sqlRun("UPDATE sysbuild_projects SET history_window = 'open' WHERE id = ?", [s.pid]);
    const imp = async (pid, batch) => post(U.pm, `/sysbuild/projects/${pid}/history-imports`, { fact_type: 'golive', object_id: batch, actual_confirmer: '甲部负责人', identity_basis: '上线单', original_date: OK_DATE, attachment_ids: [await stageAtt(pid, U.pm, 'c')] });
    const rImp = await imp(s.pid, s.batch1);
    expectErr(rImp, 409, 'SYSBUILD_STATE', '变更待确认时导入上线');
    assert.ok(rImp.body.message.includes('待确认的总体规划或变更'), rImp.body.message);
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_golive_events WHERE batch_id = ?', [s.batch1]), 0, '被拒不写事件');
    // (b)：夹具——提交之后批次上线（事件写成一小时前）
    await goliveFx(s.batch1, 'golive', '-1 hour');
    const tasks = (await tasksOf(ch.vid)).filter((t) => t.status === 'pending');
    assert.ok(tasks.length >= 2, `前置：变更有多个必需确认人（${tasks.length}）`);
    for (const t of tasks.slice(0, -1)) assert.strictEqual((await H.openAndDecide(t.user_id, t.task_id, 'confirm')).status, 200);
    const lastT = tasks[tasks.length - 1];
    const effBefore = await effectiveOverallOf(s.pid);
    const eff = await H.openAndDecide(lastT.user_id, lastT.task_id, 'confirm');
    expectErr(eff, 409, 'SYSBUILD_STATE', '生效时批次已上线');
    assert.ok(eff.body.message.includes('已上线批次的承诺条目已冻结') && eff.body.message.includes('撤回'), eff.body.message);
    assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id = ?', [ch.vid])).status, 'pending', '变更版本仍待确认');
    assert.strictEqual(await chStatus(ch.cid), 'pending');
    assert.strictEqual(await effectiveOverallOf(s.pid), effBefore, '现行总体规划不变');
    assert.strictEqual((await sqlGet("SELECT status FROM sysbuild_confirm_task_revisions r JOIN sysbuild_confirm_tasks t ON t.id = r.task_id WHERE t.id = ? ORDER BY r.id DESC LIMIT 1", [lastT.task_id])).status, 'pending', '最后一个确认整笔回滚');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_package_item_revisions WHERE package_version_id = ? AND item_version_id = ?", [effBefore, i2.versions[0].id]), 0, '新条目没有进入总体规划');
    // 可撤回
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${ch.vid}/withdraw`, { reason: '批次已上线，变更不能生效' })).status, 200);
    assert.strictEqual(await chStatus(ch.cid), 'withdrawn');
    // 对照：集合不变的变更在已上线批次下仍可生效
    const c2 = await draftChange(s, []);
    assert.strictEqual((await submitChange(c2.cid)).status, 200);
    await confirmAll(c2.vid);
    assert.strictEqual(await chStatus(c2.cid), 'effective', '集合与现行规划完全相同：放行');
  });

  test(`${T_EXEMPT}——（P171）上线事件历史导入的「本批节点全部收口」前置对 b_uat（用户验收测试）豁免——它的收口要验收包已生效而验收包不能历史导入；其余非里程碑、未取消节点仍须已收口；豁免的节点记进导入快照 exempt_nodes，批次上线后保持原状`, async () => {
    const mk = async () => {
      const s = await mkPlan({ buildType: 'outsource' });
      await sqlRun("UPDATE sysbuild_projects SET history_window = 'open' WHERE id = ?", [s.pid]);
      return s;
    };
    const imp = async (s) => post(U.pm, `/sysbuild/projects/${s.pid}/history-imports`, { fact_type: 'golive', object_id: s.batch1, actual_confirmer: '甲部负责人', identity_basis: '上线单', original_date: OK_DATE, attachment_ids: [await stageAtt(s.pid, U.pm, 'e')] });
    const others = (s) => sqlAll("SELECT id, status FROM sysbuild_nodes WHERE batch_id = ? AND is_golive_milestone = 0 AND template_key <> 'b_uat' AND status <> 'cancelled' ORDER BY sort_order, id", [s.batch1]);
    // ① 其余节点没收口：409，文案只列非 b_uat 的节点
    const s1 = await mk();
    const r1 = await imp(s1);
    expectErr(r1, 409, 'SYSBUILD_STATE', '其余节点未收口');
    assert.ok(r1.body.message.includes('需求确认') && !r1.body.message.includes('用户验收测试'), r1.body.message);
    // ② 其余节点收口、b_uat 没收口：放行，快照记豁免
    for (const n of await others(s1)) {
      if (n.status === 'not_started') assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${n.id}/start`)).status, 200);
      assert.strictEqual((await closeNodeReq(n.id)).status, 200);
    }
    const uat = await nodeIdOf(s1.pid, 'b_uat');
    assert.strictEqual((await nodeRow(uat)).status, 'not_started', '前置：b_uat 没收口');
    const ok = await imp(s1);
    assert.strictEqual(ok.status, 201, ok.text);
    const ev = (await eventsAll(s1.batch1))[0];
    const snap = JSON.parse(ev.handover_snapshot_json);
    assert.deepStrictEqual(snap.exempt_nodes, [{ id: uat, name: '用户验收测试', template_key: 'b_uat' }], '快照记下豁免的节点');
    assert.strictEqual(snap.history_import, true);
    assert.strictEqual((await batchRow(s1.batch1)).status, 'live');
    assert.strictEqual((await nodeRow(uat)).status, 'not_started', 'b_uat 在批次上线后保持原状');
  });

  test(`${T_REPLY}——（P174，方案 §4.2「有异议：PM 只能答复或出新版本重新发起」）交接确认被不认可后，POST …/handover/requests 带 reply（trim 后 10–500 字、无控制字符）重新发起：写 handover_replied 事件、被不认可的任务（同一任务）生成新修订由代表人重新决定；无答复仍 409；答复只解除被答复的那几条，答复之后再次不认可需要再答复；更正、记单号不解除`, async () => {
    const s = await mkPlan({ m1: true });
    const e = await blockerIssue(s, { title: '要被不认可后答复的阻塞项' });
    await ready(s);
    const url = `/sysbuild/batches/${s.batch1}/handover/requests`;
    const reqReply = (eid, reply, uid) => post(uid || U.pm, url, { entry_id: eid, reply });
    const REPLY = '已与业务方沟通，补充了影响范围说明，请重新决定。';
    const item = async (eid) => itemOf(await handoverGet(U.pm, s.batch1), eid);
    const revs = async (eid) => sqlAll("SELECT r.id AS id, r.task_id AS task_id, r.rev_no AS rev_no, r.status AS status FROM sysbuild_confirm_task_revisions r JOIN sysbuild_confirm_tasks t ON t.id = r.task_id WHERE t.object_type = 'handover' AND t.object_id = ? ORDER BY r.id", [eid]);
    // ① 没有不认可：带答复 409（没有需要答复的）；正常发起 201
    expectErr(await reqReply(e.id, REPLY), 409, 'SYSBUILD_STATE', '没有不认可时带答复');
    assert.strictEqual((await item(e.id)).reply_required, false);
    assert.strictEqual((await requestHo(U.pm, s.batch1, e.id)).status, 201);
    const t1 = (await hoTasks(e.id))[0];
    assert.strictEqual((await decideHo(U.del, t1.task_id, 'reject')).status, 200);
    let it = await item(e.id);
    assert.deepStrictEqual([it.confirm.state, it.cleared, it.reply_required, it.actions.handover_request], ['declined', false, true, true]);
    // ② 无答复重新发起 409（文案说明需先答复）；答复参数校验 400：不足 10 字 / 超 500 / 控制字符 / 非文本 / 空白
    const r0 = await requestHo(U.pm, s.batch1, e.id);
    expectErr(r0, 409, 'SYSBUILD_STATE', '无答复重新发起');
    assert.ok(r0.body.message.includes('须先写答复'), r0.body.message);
    for (const [bad, label] of [['短答复', '不足 10 字'], ['     短答复     ', 'trim 后不足 10 字'], ['x'.repeat(501), '超过 500 字'], ['答复含控制字符\u0001请注意', '控制字符'], [12345678901, '非文本'], ['            ', '空白']]) {
      const r = await reqReply(e.id, bad);
      expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', label);
      assert.strictEqual(r.body.field, 'reply', label);
    }
    assert.strictEqual((await reqReply(e.id, '恰好十个字的答复内容')).status, 201, '恰 10 字通过（边界）');
    // 回到被不认可的状态再测权限：先让这条再次被不认可（边界答复已重新发起）
    assert.strictEqual((await decideHo(U.del, t1.task_id, 'reject')).status, 200);
    assert.deepStrictEqual([(await item(e.id)).confirm.state, (await item(e.id)).reply_required], ['declined', true], '答复之后再次不认可：需要再答复');
    // ③ 权限：非 PM 带答复 403；PM 带答复成功
    for (const [uid, label] of [[U.m1, '一般成员'], [U.own, '负责人'], [U.del, '代表人'], [U.admin, 'admin 未接管'], [U.ro, '只读账号']]) {
      expectErr(await reqReply(e.id, REPLY, uid), 403, 'SYSBUILD_FORBIDDEN', label);
    }
    const nEvBefore = (await payloads(s.pid, 'handover_replied')).length;
    expectErr(await requestHo(U.pm, s.batch1, e.id), 409, 'SYSBUILD_STATE', '再次不认可后无新答复');
    const ok = await reqReply(e.id, `  ${REPLY}  `);
    assert.strictEqual(ok.status, 201, ok.text);
    assert.deepStrictEqual([ok.body.tasks.length, ok.body.reissued.length], [0, 1], '同一任务生成新修订，不新建任务');
    assert.deepStrictEqual([ok.body.reissued[0].task_id, ok.body.reissued[0].party_id], [t1.task_id, s.A]);
    const rv = await revs(e.id);
    assert.deepStrictEqual(rv.map((x) => [x.task_id, x.rev_no, x.status]), [[t1.task_id, 1, 'rejected'], [t1.task_id, 2, 'rejected'], [t1.task_id, 3, 'pending']], '旧修订保留，新修订待确认');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE object_type = 'handover' AND object_id = ?", [e.id]), 1, '仍是一个任务');
    // ④ 事件留痕：handover_replied 挂在登记上，payload 记被答复的修订与答复文字（trim 后）；重新发起事件标 replied
    const evs = (await payloads(s.pid, 'handover_replied')).slice(nEvBefore);
    assert.strictEqual(evs.length, 1);
    assert.deepStrictEqual(evs[0], { entry_id: e.id, batch_id: s.batch1, replied_revision_ids: [rv[1].id], reply: REPLY }, '被答复的是当时还没解除的那条不认可（rev 2）；rev 1 在上一次答复里');
    const evRaw = (await eventsOf(s.pid, 'handover_replied')).pop();
    assert.deepStrictEqual([evRaw.object_type, evRaw.object_id], ['entry', e.id]);
    assert.ok((await payloads(s.pid, 'handover_requested')).pop().replied === true);
    const reiss = (await payloads(s.pid, 'confirm_task_reissued')).pop();
    assert.deepStrictEqual([reiss.via, reiss.reason, reiss.rev_no, reiss.previous_revision_id], ['handover_reply', REPLY, 3, rv[1].id]);
    // ⑤ 答复解除：状态回到待确认，reply_required 为假；代表人确认 → 已清 → 上线 200
    it = await item(e.id);
    assert.deepStrictEqual([it.confirm.state, it.reply_required, it.cleared], ['pending', false, false]);
    assert.strictEqual((await decideHo(U.del, t1.task_id, 'confirm')).status, 200);
    it = await item(e.id);
    assert.deepStrictEqual([it.confirm.state, it.cleared], ['confirmed', true]);
    const g = await goliveReq(U.pm, s.batch1);
    assert.strictEqual(g.status, 200, g.text);
  });

  test(`${T_REPLY}（取消风险 / 更正 / 部分部门）——有未解除的不认可时取消风险被拒（P175），答复后被不认可的部门重新决定；更正让指纹变化后答复：旧任务作废、按当前指纹给每个部门建新任务；多部门里只有被不认可的任务生成新修订，已确认的不动`, async () => {
    const s = await mkPlan({ partyB: true });
    const url = `/sysbuild/batches/${s.batch1}/handover/requests`;
    const REPLY = '已补充说明并与业务方沟通，请重新决定。';
    const item = async (eid) => itemOf(await handoverGet(U.pm, s.batch1), eid);
    // ① 取消风险（P175，修订批 4）：有未解除的不认可时被拒，不能靠它使该项不再需要确认；该项仍需确认，答复有效 → 被不认可的部门生成新修订 → 代表人重新决定 → 已清
    const e1 = await blockerIssue(s, { title: '取消风险被拒后答复' });
    assert.strictEqual((await requestHo(U.pm, s.batch1, e1.id)).status, 201);
    assert.strictEqual((await decideHo(U.x2, (await hoTasks(e1.id)).find((t) => t.party_id === s.B).task_id, 'reject')).status, 200);
    assert.strictEqual((await decideHo(U.del, (await hoTasks(e1.id)).find((t) => t.party_id === s.A).task_id, 'confirm')).status, 200);
    expectErr(await act(U.pm, e1.id, { action: 'unmark_risk', reason: '风险解除' }), 409, 'SYSBUILD_STATE', '有未解除的不认可时取消风险');
    let it = await item(e1.id);
    assert.deepStrictEqual([it.need_confirm, it.risk_current, it.cleared, it.reply_required, it.actions.handover_request], ['accept_issue', true, false, true, true], '风险标记仍在，仍需确认，可答复');
    expectErr(await requestHo(U.pm, s.batch1, e1.id), 409, 'SYSBUILD_STATE', '无答复');
    const rr = await post(U.pm, url, { entry_id: e1.id, reply: REPLY });
    assert.strictEqual(rr.status, 201, rr.text);
    assert.deepStrictEqual([rr.body.tasks.length, rr.body.reissued.length], [0, 1], '答复：只有被不认可的乙部任务生成新修订，甲部已确认的不动');
    it = await item(e1.id);
    assert.deepStrictEqual([it.confirm.state, it.reply_required, it.cleared], ['pending', false, false], '答复后回到待确认，须乙部代表人重新决定');
    assert.strictEqual((await decideHo(U.x2, (await hoTasks(e1.id)).find((t) => t.party_id === s.B).task_id, 'confirm')).status, 200);
    assert.deepStrictEqual([(await item(e1.id)).confirm.state, (await item(e1.id)).cleared], ['confirmed', true], '代表人重新决定后已清');
    // ② 部门 A 已确认、部门 B 不认可 → 答复：只有 B 的任务生成新修订（A 的已确认修订不动）
    const e2 = await blockerIssue(s, { title: '部分部门不认可' });
    assert.strictEqual((await requestHo(U.pm, s.batch1, e2.id)).status, 201);
    const tk = await hoTasks(e2.id);
    const tA = tk.find((t) => t.party_id === s.A);
    const tB = tk.find((t) => t.party_id === s.B);
    assert.strictEqual((await decideHo(U.del, tA.task_id, 'confirm')).status, 200);
    assert.strictEqual((await decideHo(U.x2, tB.task_id, 'reject')).status, 200);
    const r2 = await post(U.pm, url, { entry_id: e2.id, reply: REPLY });
    assert.strictEqual(r2.status, 201, r2.text);
    assert.deepStrictEqual(r2.body.reissued.map((x) => [x.task_id, x.party_id]), [[tB.task_id, s.B]]);
    const after = await hoTasks(e2.id);
    assert.deepStrictEqual(after.map((t) => [t.party_id, t.rev_no, t.status]), [[s.A, 1, 'confirmed'], [s.B, 2, 'pending']]);
    assert.strictEqual((await decideHo(U.x2, tB.task_id, 'confirm')).status, 200);
    assert.deepStrictEqual([(await item(e2.id)).confirm.state, (await item(e2.id)).cleared], ['confirmed', true]);
    // ②b 被不认可的部门缺生效代表人：带答复也 409（文案列出该部门），读接口标志为假；补回代表人后答复成功
    const e4 = await blockerIssue(s, { title: '被不认可的部门缺代表人' });
    assert.strictEqual((await requestHo(U.pm, s.batch1, e4.id)).status, 201);
    const t4B = (await hoTasks(e4.id)).find((t) => t.party_id === s.B);
    assert.strictEqual((await decideHo(U.x2, t4B.task_id, 'reject')).status, 200);
    const dlgB = await sqlGet("SELECT id FROM sysbuild_delegations WHERE party_id = ? AND status = 'active'", [s.B]);
    await sqlRun("UPDATE sysbuild_delegations SET status = 'revoked', revoked_at = '2026-10-20 10:00:00', revoke_reason = '换人' WHERE id = ?", [dlgB.id]);
    const r4 = await post(U.pm, url, { entry_id: e4.id, reply: REPLY });
    expectErr(r4, 409, 'SYSBUILD_STATE', '被不认可的部门缺代表人');
    assert.strictEqual(r4.body.message, '以下参与方缺少生效代表人，无法发起交接确认：乙部');
    assert.strictEqual((await item(e4.id)).actions.handover_request, false, '标志同源为假');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_events WHERE event_type = 'handover_replied' AND object_id = ?", [e4.id]), 0, '被拒不写答复事件');
    await sqlRun("UPDATE sysbuild_delegations SET status = 'active', revoked_at = NULL, revoke_reason = NULL WHERE id = ?", [dlgB.id]);
    assert.strictEqual((await post(U.pm, url, { entry_id: e4.id, reply: REPLY })).status, 201, '代表人补回后答复成功');
    // ③ 更正使指纹变化（旧任务作废）后答复：按当前指纹给每个部门建新任务
    const e3 =await blockerIssue(s, { title: '更正后答复' });
    assert.strictEqual((await requestHo(U.pm, s.batch1, e3.id)).status, 201);
    assert.strictEqual((await decideHo(U.x2, (await hoTasks(e3.id)).find((t) => t.party_id === s.B).task_id, 'reject')).status, 200);
    await actOk(U.pm, e3.id, { action: 'correct', text: '更正：补充说明' });
    await actOk(U.pm, e3.id, { action: 'link_sys_issue', sys_issue_no: 'SI-300', text: '记单号' });
    it = await item(e3.id);
    assert.deepStrictEqual([it.confirm.state, it.reply_required], ['declined', true], '更正、记单号不解除');
    expectErr(await requestHo(U.pm, s.batch1, e3.id), 409, 'SYSBUILD_STATE', '更正后无答复');
    const r3 = await post(U.pm, url, { entry_id: e3.id, reply: REPLY });
    assert.strictEqual(r3.status, 201, r3.text);
    assert.deepStrictEqual([r3.body.tasks.length, r3.body.reissued.length], [2, 0], '旧任务指纹已过期：给 甲 / 乙 各建新任务');
    const fpNow = (await sqlGet('SELECT MAX(id) AS m FROM sysbuild_entry_actions WHERE entry_id = ?', [e3.id])).m;
    assert.deepStrictEqual((await hoTasks(e3.id)).slice(2).map((t) => t.object_version_id), [fpNow, fpNow], '状态指纹取发起时的当前值');
    it = await item(e3.id);
    assert.deepStrictEqual([it.confirm.state, it.reply_required], ['pending', false]);
  });

  // ═══════════════════════ 18 修订批 4（预筛 3 轮：P175 / P176 / LOW-1）═══════════════════════
  test(`${T_UNMARK}——（P175）交接确认被代表人不认可后，取消风险标记 409（跨批次：登记同时在两个批次的交接集合里，任一批次的不认可都算），读接口 actions.unmark_risk 同源为假；答复后被不认可的部门重新决定才算清；没有不认可的取消风险照常；答复并重新确认后不再有未解除的不认可；不需要确认（夹具造兜底状态）时带答复 409、无答复也 409，文案不列「裁定」`, async () => {
    const s = await mkPlan({ batch2: 'active' });
    const REPLY = '已与业务方沟通，补充了影响范围说明，请重新决定。';
    const UNMARK_MSG = '该登记的交接确认已被代表人不认可，须先写答复重新发起、由代表人对重新发起的确认作出确认，或给出新的结论；在此之前不能取消风险标记';
    const url = (bid) => `/sysbuild/batches/${bid}/handover/requests`;
    const unmark = (eid) => act(U.pm, eid, { action: 'unmark_risk', reason: '风险解除' });
    const view = async (bid, eid) => itemOf(await handoverGet(U.pm, bid), eid);
    // ① 去向留项目且承诺批次为空 = 进每个批次的集合（第 1 批、第 2 批）；带风险、结论不采纳 = 阻塞项（需要「接受带此问题上线」）
    const e = await regOk(U.pm, s.pid, { type: 'issue', is_risk: 1, title: '跨批次的阻塞项' });
    const itN = await mkItem(s.pid);
    await actOk(U.pm, e.id, { action: 'assign_items', basis_category: 'planned_detail', item_ids: [itN.id], text: '规划内尚未细化，补建条目' });
    await actOk(U.pm, e.id, concl('not_adopted'));
    for (const bid of [s.batch1, s.batch2]) assert.deepStrictEqual([(await view(bid, e.id)).sources, (await view(bid, e.id)).need_confirm], [['unbatched'], 'accept_issue'], `前置：批次 ${bid} 的集合里有该阻塞项`);
    // ② 没有不认可：取消风险照常（对照）——另一条登记，不影响本条
    const e0 = await blockerIssue(s, { title: '没有不认可的对照' });
    assert.strictEqual((await detail(U.pm, e0.id)).actions.unmark_risk, true, '对照：标志为真');
    await actOk(U.pm, e0.id, { action: 'unmark_risk', reason: '风险解除' });
    assert.strictEqual((await detail(U.pm, e0.id)).risk_current, false);
    // ③ 第 1 批发起、代表人不认可：两个批次里该项都是 declined；取消风险 409，标志（详情与列表）为假，登记不变，不写办理记录
    assert.strictEqual((await requestHo(U.pm, s.batch1, e.id)).status, 201);
    assert.strictEqual((await decideHo(U.del, (await hoTasks(e.id))[0].task_id, 'reject')).status, 200);
    for (const bid of [s.batch1, s.batch2]) assert.strictEqual((await view(bid, e.id)).confirm.state, 'declined', `批次 ${bid}：未解除的不认可跨批次`);
    const nBefore = await countOf("SELECT COUNT(*) AS n FROM sysbuild_entry_actions WHERE entry_id = ?", [e.id]);
    const rUn = await unmark(e.id);
    expectErr(rUn, 409, 'SYSBUILD_STATE', '有未解除的不认可时取消风险');
    assert.strictEqual(rUn.body.message, UNMARK_MSG);
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_entry_actions WHERE entry_id = ?", [e.id]), nBefore, '被拒不写办理记录');
    assert.strictEqual((await detail(U.pm, e.id)).actions.unmark_risk, false, '详情标志同源为假');
    const lst = (await get(U.pm, `/sysbuild/projects/${s.pid}/entries`)).body.entries.find((x) => x.id === e.id);
    assert.strictEqual(lst.actions.unmark_risk, false, '列表标志同源为假');
    assert.deepStrictEqual([(await view(s.batch1, e.id)).risk_current, (await view(s.batch1, e.id)).need_confirm, (await view(s.batch1, e.id)).cleared], [true, 'accept_issue', false], '风险标记仍在、仍需确认、仍未清');
    // ④ 非 PM 仍是 403（对照：先权限后状态）
    expectErr(await act(U.own, e.id, { action: 'unmark_risk', reason: '风险解除' }), 403, 'SYSBUILD_FORBIDDEN', '非 PM');
    // ⑤ 出路：写答复（第 2 批发起也行——任务按登记算，不按批次）→ 被不认可的部门生成新修订 → 代表人重新决定 → 已清；上线仍要重新决定（不是 PM 单方面）
    const r5 = await post(U.pm, url(s.batch2), { entry_id: e.id, reply: REPLY });
    assert.strictEqual(r5.status, 201, r5.text);
    assert.deepStrictEqual([r5.body.tasks.length, r5.body.reissued.length], [0, 1]);
    assert.deepStrictEqual([(await view(s.batch1, e.id)).confirm.state, (await view(s.batch1, e.id)).cleared], ['pending', false], '答复后待重新决定，未清');
    // P177（修订批 5）：答复只解锁重新发起、不解除不认可——新修订还没确认时取消风险仍 409，标志为假
    expectErr(await unmark(e.id), 409, 'SYSBUILD_STATE', '答复后新修订待确认时取消风险');
    assert.strictEqual((await detail(U.pm, e.id)).actions.unmark_risk, false, '答复后新修订待确认：标志仍为假');
    assert.strictEqual((await decideHo(U.del, (await hoTasks(e.id))[0].task_id, 'confirm')).status, 200);
    assert.deepStrictEqual([(await view(s.batch1, e.id)).confirm.state, (await view(s.batch1, e.id)).cleared], ['confirmed', true], '代表人重新决定后已清');
    // ⑥ 被答复且重新确认之后不再有未解除的不认可：取消风险放行（规则只看「未解除的不认可」）
    assert.strictEqual((await detail(U.pm, e.id)).actions.unmark_risk, true);
    await actOk(U.pm, e.id, { action: 'unmark_risk', reason: '风险解除' });
    // ⑦ 兜底状态（夹具）：不需要确认却有未解除的不认可——正常路径已被 ③ 挡住，这里直接写一条 unmark_risk 办理记录造出来；答复无效、无答复同样 409，文案只列新的结论类动作
    const e7 = await blockerIssue(s, { title: '兜底状态' });
    assert.strictEqual((await requestHo(U.pm, s.batch1, e7.id)).status, 201);
    assert.strictEqual((await decideHo(U.del, (await hoTasks(e7.id))[0].task_id, 'reject')).status, 200);
    await sqlRun("INSERT INTO sysbuild_entry_actions (entry_id, action, text, created_by) VALUES (?, 'unmark_risk', '夹具：造不需要确认的兜底状态', ?)", [e7.id, U.pm]);
    const i7 = await view(s.batch1, e7.id);
    assert.deepStrictEqual([i7.need_confirm, i7.confirm.state, i7.cleared, i7.reply_required, i7.actions.handover_request], [null, 'declined', false, false, false], '不需要确认、仍判未清、没有可写的答复、标志为假');
    assert.ok(i7.reasons.some((x) => x.includes('不认可') && x.includes('已不需要交接确认')), JSON.stringify(i7.reasons));
    assert.strictEqual(i7.reasons.some((x) => x.includes('裁定')), false, 'LOW-1：未清原因不把「裁定」列为出路');
    const nRep = await countOf("SELECT COUNT(*) AS n FROM sysbuild_events WHERE event_type = 'handover_replied' AND object_id = ?", [e7.id]);
    const r7 = await post(U.pm, url(s.batch1), { entry_id: e7.id, reply: REPLY });
    expectErr(r7, 409, 'SYSBUILD_STATE', '不需要确认时带答复');
    assert.strictEqual(r7.body.message, '该登记已有代表人作出不认可 / 有异议，答复只在仍需交接确认时有效；须先给出新的结论（给结论 / 仅供参考 / 作废）才能解除');
    assert.strictEqual(r7.body.message.includes('裁定'), false);
    const r7b = await requestHo(U.pm, s.batch1, e7.id);
    expectErr(r7b, 409, 'SYSBUILD_STATE', '不需要确认且无答复');
    assert.strictEqual(r7b.body.message, r7.body.message, '无答复同文案：不再叫人写答复');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_events WHERE event_type = 'handover_replied' AND object_id = ?", [e7.id]), nRep, '被拒不写答复事件');
    await ready(s);
    expectErr(await goliveReq(U.pm, s.batch1), 409, 'SYSBUILD_GOLIVE_BLOCKED', '该项仍未清，挡上线');
  });

  test(`${T_ACCT}——（P176）交接确认的代录只放无平台账号的代表人：有账号的代表人的交接修订 actions.proxy 为假、代录 409「有平台账号的代表人须本人在平台确认交接事项」（修订与确认记录不变）；无账号的代表人照常代录 200；别的用途（办理结论确认）有账号时仍可代录；有账号的代表人本人在平台确认不受影响`, async () => {
    const s = await mkPlan({ m1: true });
    const HOACC = '有平台账号的代表人须本人在平台确认交接事项';
    // 丙部：生效代表人无账号（只能代录）；甲部：代表人有账号（U.del）
    const partyC = await addParty(s.pid, '丙部', 'demand');
    const mC = await addMember(s.pid, U.cand2, { party: partyC });
    await addAppointment(partyC, mC, 'active');
    const mCdel = await sqlRun("INSERT INTO sysbuild_members (project_id, party_id, user_id, person_name, joined_at, added_by) VALUES (?, ?, NULL, '丙部代表（无账号）', '2026-10-01 10:00:00', ?)", [s.pid, partyC, U.admin]);
    const aptC = (await sqlGet("SELECT id FROM sysbuild_appointments WHERE party_id = ? AND status = 'active'", [partyC])).id;
    await addDelegation(partyC, mCdel.lastID, aptC, 'active');
    const e = await blockerIssue(s, { title: '交接代录对照' });
    assert.strictEqual((await requestHo(U.pm, s.batch1, e.id)).status, 201);
    const tasks = await hoTasks(e.id);
    const tA = tasks.find((t) => t.party_id === s.A);
    const tC = tasks.find((t) => t.party_id === partyC);
    assert.deepStrictEqual([tA.user_id !== null, tC.user_id], [true, null], '前置：甲部代表人有账号，丙部无账号');
    let shaN = 0; // 暂存附件的 sha256 要 64 位十六进制，每次换一个字符，互不相同
    const proxyBody = async (tid, extra) => {
      const o = await get(U.pm, `/sysbuild/confirm-tasks/${tid}`);
      assert.strictEqual(o.status, 200, o.text);
      shaN += 1;
      return { open: o.body, body: Object.assign({
        revision_id: o.body.revision.id, object_version_id: o.body.task.object_version_id, decision: 'confirm', external_date: today(), actual_confirmer: '代表人', identity_basis: '电话确认，凭据见附件',
        attachment_ids: [await stageAtt(s.pid, U.pm, 'abcdef'[shaN % 6])],
      }, extra || {}) };
    };
    // ① 有账号：标志为假、代录 409（文案手写）、修订仍待确认、没有确认记录、没有代录事件
    const a = await proxyBody(tA.task_id);
    assert.strictEqual(a.open.actions.proxy, false, '有账号代表人的交接修订：actions.proxy 为假');
    assert.strictEqual(a.open.revision.proxy_only, false);
    const nProxyEv = (await eventsOf(s.pid, 'confirm_proxy_recorded')).length;
    const rA = await post(U.pm, `/sysbuild/confirm-tasks/${tA.task_id}/proxy`, a.body);
    expectErr(rA, 409, 'SYSBUILD_STATE', '有账号代表人的交接确认不能代录');
    assert.strictEqual(rA.body.message, HOACC);
    assert.strictEqual((await hoTasks(e.id)).find((t) => t.task_id === tA.task_id).status, 'pending', '修订仍待确认');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_confirmations WHERE task_revision_id = ?', [tA.rev_id]), 0, '没有确认记录');
    assert.strictEqual((await eventsOf(s.pid, 'confirm_proxy_recorded')).length, nProxyEv, '没有代录事件');
    // 不认可 / 有异议类决策同样 409（交接确认只认 confirm / reject；不论决策都不能代录）
    const aRej = await proxyBody(tA.task_id, { decision: 'reject', reason: '业务不接受' });
    expectErr(await post(U.pm, `/sysbuild/confirm-tasks/${tA.task_id}/proxy`, aRej.body), 409, 'SYSBUILD_STATE', '有账号代表人的不认可也不能代录');
    // ② 无账号：标志为真、代录 200
    const c = await proxyBody(tC.task_id);
    assert.strictEqual(c.open.actions.proxy, true, '无账号代表人的交接修订：actions.proxy 为真');
    assert.strictEqual(c.open.revision.proxy_only, true);
    const rC = await post(U.pm, `/sysbuild/confirm-tasks/${tC.task_id}/proxy`, c.body);
    assert.strictEqual(rC.status, 200, rC.text);
    // ③ 有账号的代表人本人在平台确认不受影响
    assert.strictEqual((await decideHo(U.del, tA.task_id, 'confirm')).status, 200);
    assert.strictEqual(itemOf(await handoverGet(U.pm, s.batch1), e.id).confirm.state, 'confirmed');
    // ③b 「业务确认不再处理」用途同样只放无账号的代表人
    const e3 = await regOk(U.pm, s.pid, { type: 'issue', title: '不再处理的交接代录对照' });
    await actOk(U.pm, e3.id, concl('no_further'));
    assert.strictEqual((await requestHo(U.pm, s.batch1, e3.id)).status, 201);
    const t3 = await hoTasks(e3.id);
    assert.strictEqual(t3[0].purpose, 'handover_no_further');
    const t3A = t3.find((t) => t.party_id === s.A);
    const t3C = t3.find((t) => t.party_id === partyC);
    const a3 = await proxyBody(t3A.task_id);
    assert.strictEqual(a3.open.actions.proxy, false);
    const rA3 = await post(U.pm, `/sysbuild/confirm-tasks/${t3A.task_id}/proxy`, a3.body);
    expectErr(rA3, 409, 'SYSBUILD_STATE', '不再处理 × 有账号');
    assert.strictEqual(rA3.body.message, HOACC);
    const c3 = await proxyBody(t3C.task_id);
    assert.strictEqual(c3.open.actions.proxy, true);
    assert.strictEqual((await post(U.pm, `/sysbuild/confirm-tasks/${t3C.task_id}/proxy`, c3.body)).status, 200, '不再处理 × 无账号：代录放行');
    // ④ 别的用途不受影响：办理结论确认的代录对有账号的代表人照常放行（登记人是一般成员 → 结论要代表人确认；代表人有账号）
    const e4 = await regOk(U.m1, s.pid, { type: 'issue', title: '结论确认代录对照' });
    await actOk(U.pm, e4.id, concl('not_adopted'));
    const ct = await sqlGet("SELECT t.id AS id, m.user_id AS user_id FROM sysbuild_confirm_tasks t JOIN sysbuild_confirm_task_revisions r ON r.task_id = t.id JOIN sysbuild_members m ON m.id = r.required_member_id WHERE t.object_type = 'conclusion' AND t.object_id = ?", [e4.id]);
    assert.notStrictEqual(ct.user_id, null, '前置：结论确认的必需确认人有平台账号');
    const k = await proxyBody(ct.id);
    assert.strictEqual(k.open.actions.proxy, true, '结论确认 × 有账号：标志为真');
    const rK = await post(U.pm, `/sysbuild/confirm-tasks/${ct.id}/proxy`, k.body);
    assert.strictEqual(rK.status, 200, rK.text);
  });

  // ═══════════════════════ 19 修订批 5（P177：答复只解锁重新发起，不解除不认可）═══════════════════════
  test(`${T_LIFT}——（P177）PM 答复只解锁重新发起：新修订待确认期间该项仍未清、取消风险 409、上线 409；解除 = 被不认可的那个需求部门在其后有已确认的修订（或登记出现新的结论类动作）：新修订再次被不认可需要再答复；部分部门确认不算全部解除；先确认后又不认可不被更早的确认解除；更正使旧任务过期后按新指纹重建的任务确认也解除`, async () => {
    const s = await mkPlan({ partyB: true });
    const REPLY = '已与业务方沟通，补充了影响范围说明，请重新决定。';
    const url = `/sysbuild/batches/${s.batch1}/handover/requests`;
    const reply = (eid) => post(U.pm, url, { entry_id: eid, reply: REPLY });
    const unmark = (eid) => act(U.pm, eid, { action: 'unmark_risk', reason: '风险解除' });
    const item = async (eid) => itemOf(await handoverGet(U.pm, s.batch1), eid);
    const latestOf = async (eid, party) => (await hoTasks(eid)).filter((t) => t.party_id === party).pop();
    const userOf = (party) => (party === s.A ? U.del : U.x2);
    const decide = async (eid, party, decision) => {
      const r = await decideHo(userOf(party), (await latestOf(eid, party)).task_id, decision);
      assert.strictEqual(r.status, 200, r.text);
    };
    const stillLocked = async (eid, label) => {
      expectErr(await unmark(eid), 409, 'SYSBUILD_STATE', `${label}：取消风险`);
      assert.strictEqual((await detail(U.pm, eid)).actions.unmark_risk, false, `${label}：取消风险标志为假`);
      assert.strictEqual((await item(eid)).cleared, false, `${label}：未清`);
    };
    const unlocked = async (eid, label) => {
      assert.strictEqual((await detail(U.pm, eid)).actions.unmark_risk, true, `${label}：取消风险标志为真`);
      await actOk(U.pm, eid, { action: 'unmark_risk', reason: '风险解除' });
    };
    await ready(s);
    // ① 甲确认、乙不认可 → 答复 → 乙新修订待确认（未清 / 取消风险 409 / 上线 409）→ 乙再次不认可（需要再答复）→ 再答复 → 乙确认 → 解除
    const e1 = await blockerIssue(s, { title: '部分部门不认可' });
    assert.strictEqual((await requestHo(U.pm, s.batch1, e1.id)).status, 201);
    await decide(e1.id, s.A, 'confirm');
    await decide(e1.id, s.B, 'reject');
    assert.deepStrictEqual([(await item(e1.id)).confirm.state, (await item(e1.id)).reply_required], ['declined', true]);
    await stillLocked(e1.id, '①不认可后');
    assert.strictEqual((await reply(e1.id)).status, 201);
    assert.deepStrictEqual([(await item(e1.id)).confirm.state, (await item(e1.id)).reply_required], ['pending', false], '答复后：待重新决定，不再要求答复');
    await stillLocked(e1.id, '①答复后新修订待确认');
    const gBlocked = await goliveReq(U.pm, s.batch1);
    expectErr(gBlocked, 409, 'SYSBUILD_GOLIVE_BLOCKED', '答复后新修订待确认时上线');
    assert.ok(gBlocked.body.blockers.some((b) => b.code === 'HANDOVER_UNCLEARED' && b.entry_ids.includes(e1.id)), JSON.stringify(gBlocked.body.blockers));
    await decide(e1.id, s.B, 'reject'); // 再次不认可：新的待答复
    assert.deepStrictEqual([(await item(e1.id)).confirm.state, (await item(e1.id)).reply_required], ['declined', true], '再次不认可：需要再答复');
    await stillLocked(e1.id, '①再次不认可');
    assert.strictEqual((await reply(e1.id)).status, 201);
    await stillLocked(e1.id, '①再答复后');
    await decide(e1.id, s.B, 'confirm');
    assert.deepStrictEqual([(await item(e1.id)).confirm.state, (await item(e1.id)).cleared], ['confirmed', true], '乙重新确认：解除且已清');
    await unlocked(e1.id, '①乙确认后');
    // ② 两个部门都不认可 → 一次答复两个都重新发起 → 甲确认乙未确认：仍未解除（部分部门解除不算全部）→ 乙确认 → 解除
    const e2 = await blockerIssue(s, { title: '两个部门都不认可' });
    assert.strictEqual((await requestHo(U.pm, s.batch1, e2.id)).status, 201);
    await decide(e2.id, s.A, 'reject');
    await decide(e2.id, s.B, 'reject');
    const r2 = await reply(e2.id);
    assert.strictEqual(r2.status, 201, r2.text);
    assert.strictEqual(r2.body.reissued.length, 2);
    await decide(e2.id, s.A, 'confirm');
    await stillLocked(e2.id, '②甲确认、乙仍待确认');
    await decide(e2.id, s.B, 'confirm');
    await unlocked(e2.id, '②全部确认后');
    // ③ 先确认、更正使旧任务过期、重新发起后甲又不认可：更早的那条确认不能解除这次不认可（(b) 要「在其后」）
    const e3 = await blockerIssue(s, { title: '先确认后不认可' });
    await requestAndConfirm(s.batch1, e3.id);
    assert.strictEqual((await item(e3.id)).cleared, true, '前置：已确认 = 已清');
    await actOk(U.pm, e3.id, { action: 'correct', text: '更正：补充说明，请各代表人重新确认' });
    assert.strictEqual((await requestHo(U.pm, s.batch1, e3.id)).status, 201);
    await decide(e3.id, s.A, 'reject');
    await stillLocked(e3.id, '③先确认后不认可');
    assert.strictEqual((await reply(e3.id)).status, 201);
    await decide(e3.id, s.A, 'confirm');
    assert.deepStrictEqual([(await item(e3.id)).confirm.state, (await item(e3.id)).cleared], ['pending', false], '③甲重新确认：甲的不认可解除，乙仍待确认，未清');
    await decide(e3.id, s.B, 'confirm');
    await unlocked(e3.id, '③全部确认后');
    // ④ 乙不认可后更正（旧任务指纹过期，乙那条不认可挂在过期任务上）→ 答复按新指纹重建两个部门的任务 → 乙在新任务上确认也算「其后重新确认」，解除
    const e4 = await blockerIssue(s, { title: '更正后重建任务' });
    assert.strictEqual((await requestHo(U.pm, s.batch1, e4.id)).status, 201);
    await decide(e4.id, s.B, 'reject');
    await actOk(U.pm, e4.id, { action: 'correct', text: '更正：补充说明' });
    await stillLocked(e4.id, '④更正后');
    const r4 = await reply(e4.id);
    assert.strictEqual(r4.status, 201, r4.text);
    assert.deepStrictEqual([r4.body.tasks.length, r4.body.reissued.length], [2, 0], '按当前指纹给甲 / 乙各建新任务');
    await decide(e4.id, s.A, 'confirm');
    await stillLocked(e4.id, '④乙新任务待确认');
    await decide(e4.id, s.B, 'confirm');
    await unlocked(e4.id, '④乙在新任务上确认后');
    // ⑤ 全部解除后上线放行
    const g = await goliveReq(U.pm, s.batch1);
    assert.strictEqual(g.status, 200, g.text);
  });

  // ═══════════════════════ 20 修订批 6（P178：导入上线共用交接闸门；codex 27 M1：代表人看得到 PM 的答复）═══════════════════════
  test(`${T_GATE}——（P178，预筛 4 HIGH，PROBE N）上线事件历史导入与普通上线共用交接闸门：代表人不认可后普通上线 409，PM 自己开窗口导入上线也 409（文案点名未清登记，不写事件、批次仍进行中）；答复并重新确认、集合全清后导入 201（快照记全部已清）；没有任何登记的历史批次导入照常 201；待确认的规划 / 变更仍挡导入`, async () => {
    const s = await mkPlan({ m1: true });
    const url = `/sysbuild/projects/${s.pid}/history-imports`;
    const body = async (pid, batch) => ({ fact_type: 'golive', object_id: batch, actual_confirmer: '甲部负责人', identity_basis: '上线单与验收记录', original_date: OK_DATE, attachment_ids: [await stageAtt(pid, U.pm, 'a')] });
    const openWin = (pid) => sqlRun("UPDATE sysbuild_projects SET history_window = 'open' WHERE id = ?", [pid]);
    const e = await blockerIssue(s, { title: '被不认可的阻塞项（PROBE N）' });
    await ready(s);
    assert.strictEqual((await requestHo(U.pm, s.batch1, e.id)).status, 201);
    assert.strictEqual((await decideHo(U.del, (await hoTasks(e.id))[0].task_id, 'reject')).status, 200);
    // ① 普通上线 409（HANDOVER_UNCLEARED 点名该登记）；开窗口后导入上线同样 409，文案点名该登记，不写事件、批次仍进行中、里程碑不动
    const g = await goliveReq(U.pm, s.batch1);
    expectErr(g, 409, 'SYSBUILD_GOLIVE_BLOCKED', '普通上线被交接闸门挡住');
    assert.ok(g.body.blockers.some((b) => b.code === 'HANDOVER_UNCLEARED' && b.entry_ids.includes(e.id)), JSON.stringify(g.body.blockers));
    await openWin(s.pid);
    const msId = await nodeIdOf(s.pid, 'b_golive');
    const msBefore = (await nodeRow(msId)).status;
    const rImp = await post(U.pm, url, await body(s.pid, s.batch1));
    expectErr(rImp, 409, 'SYSBUILD_STATE', '导入上线绕过交接闸门');
    assert.ok(rImp.body.message.includes('上线交接集合里还有 1 项没有清') && rImp.body.message.includes(`#${e.id}`) && rImp.body.message.includes('交接闸门'), rImp.body.message);
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_golive_events WHERE batch_id = ?', [s.batch1]), 0, '被拒不写上线事件');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_history_imports WHERE project_id = ? AND fact_type = 'golive'", [s.pid]), 0, '被拒不写历史导入记录');
    assert.strictEqual((await batchRow(s.batch1)).status, 'active');
    assert.strictEqual((await nodeRow(msId)).status, msBefore, '里程碑不动');
    // ② 答复并让代表人重新确认、集合全清后导入 201；快照里该项已清
    assert.strictEqual((await post(U.pm, `/sysbuild/batches/${s.batch1}/handover/requests`, { entry_id: e.id, reply: '已与业务方沟通，补充了影响范围说明，请重新决定。' })).status, 201);
    expectErr(await post(U.pm, url, await body(s.pid, s.batch1)), 409, 'SYSBUILD_STATE', '答复后新修订待确认仍未清');
    assert.strictEqual((await decideHo(U.del, (await hoTasks(e.id))[0].task_id, 'confirm')).status, 200);
    const ok = await post(U.pm, url, await body(s.pid, s.batch1));
    assert.strictEqual(ok.status, 201, ok.text);
    assert.strictEqual((await batchRow(s.batch1)).status, 'live');
    const snap = JSON.parse((await eventsAll(s.batch1))[0].handover_snapshot_json);
    assert.deepStrictEqual(snap.items.map((i) => [i.entry_id, i.cleared]), [[e.id, true]]);
    // ③ 没有任何登记的历史批次：导入照常 201（节点收口后；不要求验收包）
    const s2 = await mkPlan();
    await openWin(s2.pid);
    await H.closeBatchNodes(s2.pid, s2.batch1);
    const ok2 = await post(U.pm, `/sysbuild/projects/${s2.pid}/history-imports`, await body(s2.pid, s2.batch1));
    assert.strictEqual(ok2.status, 201, ok2.text);
    assert.strictEqual((await batchRow(s2.batch1)).status, 'live');
  });

  test(`${T_SEEREPLY}——（codex 27 M1）代表人重新决定时看得到 PM 的答复：确认任务详情 object.current_reply = 与当前修订关联的答复（文字、答复人、时间、被答复的修订编号；首次发起 / 按新指纹重建的任务为 null），object.reply_history = 该登记全部答复（按时间，两次可区分）；交接清单每项 last_reply = 最近一次答复；只读，不改状态与指纹`, async () => {
    const s = await mkPlan({ m1: true });
    const R1 = '第一次答复：已补充影响范围说明，请重新决定。';
    const R2 = '第二次答复：已与业务方再次沟通并调整方案，请重新决定。';
    const e = await blockerIssue(s, { title: '要被答复两次的阻塞项' });
    const url = `/sysbuild/batches/${s.batch1}/handover/requests`;
    const revIds = async () => (await sqlAll("SELECT r.id AS id FROM sysbuild_confirm_task_revisions r JOIN sysbuild_confirm_tasks t ON t.id = r.task_id WHERE t.object_type = 'handover' AND t.object_id = ? ORDER BY r.id", [e.id])).map((r) => r.id);
    const objOf = async (uid, tid) => {
      const r = await get(uid, `/sysbuild/confirm-tasks/${tid}`);
      assert.strictEqual(r.status, 200, r.text);
      return r.body.object;
    };
    const itemNow = async () => itemOf(await handoverGet(U.pm, s.batch1), e.id);
    assert.strictEqual((await requestHo(U.pm, s.batch1, e.id)).status, 201);
    const tid = (await hoTasks(e.id))[0].task_id;
    // ① 首次发起：没有答复
    let o = await objOf(U.del, tid);
    assert.deepStrictEqual([o.current_reply, o.reply_history], [null, []]);
    assert.strictEqual((await itemNow()).last_reply, null);
    // ② 不认可 → 第一次答复：代表人读新修订详情看到这次答复，被答复的是第一条修订
    assert.strictEqual((await decideHo(U.del, tid, 'reject')).status, 200);
    assert.strictEqual((await post(U.pm, url, { entry_id: e.id, reply: R1 })).status, 201);
    let ids = await revIds();
    assert.strictEqual(ids.length, 2);
    o = await objOf(U.del, tid);
    assert.deepStrictEqual([o.current_reply.text, o.current_reply.by, o.current_reply.replied_revision_id, o.current_reply.replied_revision_ids], [R1, U.pm, ids[0], [ids[0]]]);
    assert.ok(typeof o.current_reply.by_name === 'string' && o.current_reply.by_name.length > 0 && typeof o.current_reply.at === 'string' && o.current_reply.at.length > 0, JSON.stringify(o.current_reply));
    assert.deepStrictEqual(o.reply_history.map((r) => r.text), [R1]);
    let li = (await itemNow()).last_reply;
    assert.deepStrictEqual([li.text, li.by, typeof li.by_name, typeof li.at], [R1, U.pm, 'string', 'string']);
    // ③ 再次不认可 → 第二次答复：当前答复换成第二次（被答复的是第二条修订），历史两条按时间可区分，最近一次 = 第二次
    assert.strictEqual((await decideHo(U.del, tid, 'reject')).status, 200);
    assert.strictEqual((await post(U.pm, url, { entry_id: e.id, reply: R2 })).status, 201);
    ids = await revIds();
    assert.strictEqual(ids.length, 3);
    o = await objOf(U.del, tid);
    assert.deepStrictEqual([o.current_reply.text, o.current_reply.replied_revision_id], [R2, ids[1]], '当前答复是第二次，被答复的是第二条修订');
    assert.deepStrictEqual(o.reply_history.map((r) => [r.text, r.replied_revision_ids]), [[R1, [ids[0]]], [R2, [ids[1]]]], '历史两条按时间可区分');
    assert.ok(o.reply_history[0].event_id < o.reply_history[1].event_id);
    assert.strictEqual((await itemNow()).last_reply.text, R2, '清单最近一次答复 = 第二次');
    // ④ 只读：PM 读详情与清单不改状态、指纹（办理动作 / 修订 / 事件条数不变）
    const snapshot = async () => [
      await countOf('SELECT COUNT(*) AS n FROM sysbuild_entry_actions WHERE entry_id = ?', [e.id]),
      await countOf('SELECT COUNT(*) AS n FROM sysbuild_events WHERE project_id = ?', [s.pid]),
      JSON.stringify(await sqlAll("SELECT r.id, r.status FROM sysbuild_confirm_task_revisions r JOIN sysbuild_confirm_tasks t ON t.id = r.task_id WHERE t.object_type = 'handover' AND t.object_id = ? ORDER BY r.id", [e.id])),
    ];
    const before = await snapshot();
    const fpBefore = (await itemNow()).confirm.fingerprint;
    await objOf(U.pm, tid);
    await handoverGet(U.pm, s.batch1);
    assert.deepStrictEqual(await snapshot(), before, '读详情与清单不写任何行');
    assert.strictEqual((await itemNow()).confirm.fingerprint, fpBefore);
    // ⑤ 更正使指纹变化后重新发起：按新指纹建的新任务不是因答复生成 → current_reply 为 null，历史仍是两条
    await actOk(U.pm, e.id, { action: 'correct', text: '更正：补充说明' });
    assert.strictEqual((await requestHo(U.pm, s.batch1, e.id)).status, 201, '更正后旧任务过期、两次不认可都已答复：可直接重新发起');
    const fresh = (await hoTasks(e.id)).pop();
    assert.notStrictEqual(fresh.task_id, tid, '新任务');
    o = await objOf(U.del, fresh.task_id);
    assert.strictEqual(o.current_reply, null, '新指纹下新建的任务不是因答复生成');
    assert.deepStrictEqual(o.reply_history.map((r) => r.text), [R1, R2], '答复历史仍是该登记的全部答复');
  });

  // ═══════════════════════ 21 修订批 7（27-R M1 / 预筛 5 LOW-1：答复与修订的直接关联；P179：导入上线按 golive 类核项目状态；LOW-3：已有上线事件先于交接闸门）═══════════════════════
  test(`${T_LINK}——（27-R M1）答复与修订的关联不依赖改发事件链：重新发起事件记答复事件编号与本次新建 / 改发的 任务、修订、参与方 映射；不认可 → 更正 → 带答复重新发起，新建任务的 current_reply = 本次答复（含该部门被答复的修订）；答复后 PM 手工改发仍是那次答复；两部门两轮答复各自对应正确`, async () => {
    const s = await mkPlan({ partyB: true });
    const R1 = '第一次答复：已补充影响范围说明，请重新决定。';
    const R2 = '第二次答复：已与业务方再次沟通并调整方案，请重新决定。';
    const url = `/sysbuild/batches/${s.batch1}/handover/requests`;
    const reply = (eid, text) => post(U.pm, url, { entry_id: eid, reply: text });
    const taskOf = async (eid, party) => (await hoTasks(eid)).filter((t) => t.party_id === party).pop();
    const revsOf = async (tid) => (await sqlAll('SELECT id, rev_no, status FROM sysbuild_confirm_task_revisions WHERE task_id = ? ORDER BY id', [tid]));
    const curReply = async (eid, party) => {
      const t = await taskOf(eid, party);
      const r = await get(U.pm, `/sysbuild/confirm-tasks/${t.task_id}`);
      assert.strictEqual(r.status, 200, r.text);
      return r.body.object.current_reply;
    };
    const decide = async (eid, party, decision) => {
      const r = await decideHo(party === s.A ? U.del : U.x2, (await taskOf(eid, party)).task_id, decision);
      assert.strictEqual(r.status, 200, r.text);
    };
    const manualReissue = async (eid, party) => {
      const r = await post(U.pm, `/sysbuild/confirm-tasks/${(await taskOf(eid, party)).task_id}/reissue`, { reason: '换人重新确认（手工改发）' });
      assert.strictEqual(r.status, 200, r.text);
    };
    // ① 不认可 → 更正（指纹过期，旧任务不在当前集合）→ 带答复重新发起：新建的任务由映射关联到本次答复；被答复的修订 = 该部门最近一条不认可修订；没有不认可的甲部取 null
    const e1 = await blockerIssue(s, { title: '更正后带答复重新发起' });
    assert.strictEqual((await requestHo(U.pm, s.batch1, e1.id)).status, 201);
    const oldB = await taskOf(e1.id, s.B);
    await decide(e1.id, s.B, 'reject');
    const oldBRev = (await revsOf(oldB.task_id))[0].id;
    await actOk(U.pm, e1.id, { action: 'correct', text: '更正：补充说明' });
    const r1 = await reply(e1.id, R1);
    assert.deepStrictEqual([r1.status, r1.body.tasks.length, r1.body.reissued.length], [201, 2, 0], r1.text);
    const hreq = (await payloads(s.pid, 'handover_requested')).filter((p) => p.reply_event_id !== null && p.reply_event_id !== undefined).pop();
    assert.deepStrictEqual(hreq.reply_links.map((l) => [l.kind, l.party_id]).sort(), [['created', s.A], ['created', s.B]].sort(), '映射记本次新建的两个任务');
    assert.ok(hreq.reply_links.every((l) => Number.isInteger(l.task_id) && Number.isInteger(l.revision_id)));
    const cB = await curReply(e1.id, s.B);
    assert.deepStrictEqual([cB.text, cB.replied_revision_id, cB.event_id], [R1, oldBRev, hreq.reply_event_id], '新任务（乙）：答复 = 本次答复，被答复的是乙部旧任务上的不认可修订');
    const cA = await curReply(e1.id, s.A);
    assert.deepStrictEqual([cA.text, cA.replied_revision_id], [R1, null], '新任务（甲）：同一次答复，甲部没有被答复的修订');
    // ② 答复后 PM 手工改发：映射与事件链都找不到新修订，回退按部门 + 最近一条不认可 → 仍是那次答复
    await manualReissue(e1.id, s.B);
    const cB2 = await curReply(e1.id, s.B);
    assert.deepStrictEqual([cB2.text, cB2.replied_revision_id], [R1, oldBRev], '手工改发后仍是那次答复');
    // ③ 两部门两轮答复：先都不认可 → 答复 1（两个任务各生成新修订）→ 甲再次不认可 → 答复 2（只有甲生成新修订）→ 各部门当前答复各自对应
    const e2 = await blockerIssue(s, { title: '两部门两轮答复' });
    assert.strictEqual((await requestHo(U.pm, s.batch1, e2.id)).status, 201);
    await decide(e2.id, s.A, 'reject');
    await decide(e2.id, s.B, 'reject');
    const a1 = (await revsOf((await taskOf(e2.id, s.A)).task_id))[0].id;
    const b1 = (await revsOf((await taskOf(e2.id, s.B)).task_id))[0].id;
    assert.strictEqual((await reply(e2.id, R1)).status, 201);
    const a2 = (await revsOf((await taskOf(e2.id, s.A)).task_id))[1].id;
    await decide(e2.id, s.A, 'reject');
    assert.strictEqual((await reply(e2.id, R2)).status, 201);
    let ca = await curReply(e2.id, s.A);
    let cb = await curReply(e2.id, s.B);
    assert.deepStrictEqual([ca.text, ca.replied_revision_id], [R2, a2], '甲部：第二轮答复，被答复的是甲部第二条修订');
    assert.deepStrictEqual([cb.text, cb.replied_revision_id], [R1, b1], '乙部：第一轮答复（第二轮没有动乙部的任务）');
    assert.notStrictEqual(a1, a2);
    // 第二层（改发事件链）：模拟没有 reply_links 的旧事件（夹具：把 handover_requested 的关联字段去掉），映射找不到时仍按改发事件链对应到各自那一轮答复
    await sqlRun("UPDATE sysbuild_events SET payload_json = json_remove(payload_json, '$.reply_links', '$.reply_event_id') WHERE event_type = 'handover_requested' AND object_id = ?", [e2.id]);    ca = await curReply(e2.id, s.A);
    cb = await curReply(e2.id, s.B);
    assert.deepStrictEqual([ca.text, ca.replied_revision_id], [R2, a2], '事件链：甲部第二轮');
    assert.deepStrictEqual([cb.text, cb.replied_revision_id], [R1, b1], '事件链：乙部第一轮');
    // 两部门各自手工改发：回退仍各自对应（甲 = 最近一次不认可对应的第二轮答复；乙 = 第一轮）
    await manualReissue(e2.id, s.A);
    await manualReissue(e2.id, s.B);
    ca = await curReply(e2.id, s.A);
    cb = await curReply(e2.id, s.B);
    assert.deepStrictEqual([ca.text, ca.replied_revision_id], [R2, a2], '甲部手工改发后：最近一次不认可对应的答复');
    assert.deepStrictEqual([cb.text, cb.replied_revision_id], [R1, b1], '乙部手工改发后：第一轮答复');
    // ④ 没带答复的发起不写关联（reply_event_id 空、映射空），新建任务没有答复
    const e3 = await blockerIssue(s, { title: '没带答复的发起' });
    assert.strictEqual((await requestHo(U.pm, s.batch1, e3.id)).status, 201);
    const plain = (await payloads(s.pid, 'handover_requested')).filter((p) => p.task_ids.length === 2).pop();
    assert.deepStrictEqual([plain.reply_event_id, plain.reply_links, plain.replied], [null, [], false]);
    assert.strictEqual(await curReply(e3.id, s.A), null);
  });

  test(`${T_PAUSE}——（P179）上线事件历史导入除 history_import 类外另按 golive 类核项目状态：已暂停 409 SYSBUILD_PROJECT_READONLY（文案说明暂停时不能上线），恢复进行中后可导入；项目读接口 actions.history_import_golive 同源（暂停为假，history_import 仍为真）`, async () => {
    const s = await mkPlan();
    const url = `/sysbuild/projects/${s.pid}/history-imports`;
    const body = async () => ({ fact_type: 'golive', object_id: s.batch1, actual_confirmer: '甲部负责人', identity_basis: '上线单与验收记录', original_date: OK_DATE, attachment_ids: [await stageAtt(s.pid, U.pm, 'a')] });
    const flags = async () => (await get(U.pm, `/sysbuild/projects/${s.pid}`)).body.actions;
    await sqlRun("UPDATE sysbuild_projects SET history_window = 'open' WHERE id = ?", [s.pid]);
    await H.closeBatchNodes(s.pid, s.batch1);
    let f = await flags();
    assert.deepStrictEqual([f.history_import, f.history_import_golive], [true, true], '进行中：两个标志都真');
    assert.strictEqual((await setStatus(s.pid, 'paused')).status, 200);
    f = await flags();
    assert.deepStrictEqual([f.history_import, f.history_import_golive], [true, false], '已暂停：导入上线事件的标志为假，其余历史导入仍可');
    const r = await post(U.pm, url, await body());
    expectErr(r, 409, 'SYSBUILD_PROJECT_READONLY', '暂停时导入上线');
    assert.ok(r.body.message.includes('暂停') && r.body.message.includes('不能导入上线事件'), r.body.message);
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_golive_events WHERE batch_id = ?', [s.batch1]), 0, '被拒不写事件');
    assert.strictEqual((await batchRow(s.batch1)).status, 'active');
    expectErr(await post(U.own, url, await body()), 403, 'SYSBUILD_FORBIDDEN', '非 PM 仍先 403');
    // 其他类事实不受 golive 类限制：暂停时导入节点收口仍走原有判定（本批节点已收口 → 409 SYSBUILD_STATE，不是 PROJECT_READONLY）
    const rNode = await post(U.pm, url, { fact_type: 'node_closed', object_id: await nodeIdOf(s.pid, 'b_req'), actual_confirmer: '甲部负责人', identity_basis: '收口记录', original_date: OK_DATE, attachment_ids: [await stageAtt(s.pid, U.pm, 'a')] });
    assert.strictEqual(rNode.status, 409, rNode.text);
    assert.strictEqual(rNode.body.code, 'SYSBUILD_STATE', '其他类事实在暂停时按各自的判定，不被 golive 类挡');
    assert.strictEqual((await setStatus(s.pid, 'active')).status, 200);
    assert.strictEqual((await flags()).history_import_golive, true, '恢复后标志为真');
    const ok = await post(U.pm, url, await body());
    assert.strictEqual(ok.status, 201, ok.text);
    assert.strictEqual((await batchRow(s.batch1)).status, 'live');
  });

  test(`${T_ORDER}——（预筛 5 LOW-3）撤销上线后批次回到进行中、仍带着未清项时导入上线：报「该批已有上线事件」（真正的原因，该走再上线），不是交接未清；没有上线事件的批次仍报交接未清`, async () => {
    const s = await mkPlan({ m1: true });
    const url = `/sysbuild/projects/${s.pid}/history-imports`;
    const body = async () => ({ fact_type: 'golive', object_id: s.batch1, actual_confirmer: '甲部负责人', identity_basis: '上线单与验收记录', original_date: OK_DATE, attachment_ids: [await stageAtt(s.pid, U.pm, 'a')] });
    await ready(s);
    await H.productionGolive(s.batch1);
    await H.productionRevoke(s.batch1, '撤销后回到进行中');
    assert.strictEqual((await batchRow(s.batch1)).status, 'active');
    const e = await regOk(U.pm, s.pid, { type: 'issue', is_risk: 1, title: '撤销后新增的未办结阻塞项' });
    await sqlRun("UPDATE sysbuild_projects SET history_window = 'open' WHERE id = ?", [s.pid]);
    const r = await post(U.pm, url, await body());
    expectErr(r, 409, 'SYSBUILD_STATE', '已有上线事件');
    assert.ok(r.body.message.includes('该批已有上线事件'), r.body.message);
    assert.strictEqual(r.body.message.includes('交接'), false, `不是交接未清：${r.body.message}`);
    // 对照：没有上线事件的批次同样带未清项时仍报交接未清
    const s2 = await mkPlan({ m1: true });
    await regOk(U.pm, s2.pid, { type: 'issue', is_risk: 1, title: '未办结阻塞项' });
    await sqlRun("UPDATE sysbuild_projects SET history_window = 'open' WHERE id = ?", [s2.pid]);
    const r2 = await post(U.pm, `/sysbuild/projects/${s2.pid}/history-imports`, { fact_type: 'golive', object_id: s2.batch1, actual_confirmer: '甲部负责人', identity_basis: '上线单', original_date: OK_DATE, attachment_ids: [await stageAtt(s2.pid, U.pm, 'a')] });
    expectErr(r2, 409, 'SYSBUILD_STATE', '没有上线事件仍报交接未清');
    assert.ok(r2.body.message.includes('上线交接集合里还有'), r2.body.message);
    assert.ok(e.id > 0);
  });

  // ═══════════════════════ 23 C6b 通知：交接确认的发送意图（与 sysbuild-api-suite-notify.js 的触发点用例互补，复用本文件的交接夹具）═══════════════════════
  test(`${T_HONOTIFY}——交接确认发起：每个需求部门代表人各一条 confirm_request（引用各自首修订）；代表人不认可 → PM 一条 decision_objected；PM 带答复重新发起 → 被不认可的任务生成的新修订，其代表人一条 confirm_reissue（引用新修订）`, async () => {
    const s = await mkPlan({ partyB: true });
    const e = await blockerIssue(s, { title: '交接通知' });
    const rowsAfter = (mark) => sqlAll('SELECT purpose, ref_type, ref_id, recipient_user_id FROM sysbuild_send_intents WHERE project_id = ? AND id > ? ORDER BY id', [s.pid, mark]);
    const lastIntent = async () => (await sqlGet('SELECT COALESCE(MAX(id), 0) AS n FROM sysbuild_send_intents WHERE project_id = ?', [s.pid])).n;
    let mark = await lastIntent();
    assert.strictEqual((await requestHo(U.pm, s.batch1, e.id)).status, 201);
    const tasks = await hoTasks(e.id);
    assert.deepStrictEqual(await rowsAfter(mark), tasks.map((t) => ({ purpose: 'confirm_request', ref_type: 'confirm_revision', ref_id: t.rev_id, recipient_user_id: t.user_id })), '每个代表人一条，引用各自首修订');
    assert.deepStrictEqual(tasks.map((t) => t.user_id).sort((a, b) => a - b), [U.del, U.x2].sort((a, b) => a - b));
    mark = await lastIntent();
    const tA = tasks.find((t) => t.party_id === s.A);
    assert.strictEqual((await decideHo(U.del, tA.task_id, 'reject')).status, 200);
    assert.deepStrictEqual(await rowsAfter(mark), [{ purpose: 'decision_objected', ref_type: 'confirm_revision', ref_id: tA.rev_id, recipient_user_id: U.pm }], '代表人不认可 → PM');
    mark = await lastIntent();
    const rp = await post(U.pm, `/sysbuild/batches/${s.batch1}/handover/requests`, { entry_id: e.id, reply: '已补充影响范围说明，请重新决定。' });
    assert.strictEqual(rp.status, 201, rp.text);
    assert.strictEqual(rp.body.reissued.length, 1);
    assert.deepStrictEqual(await rowsAfter(mark), [{ purpose: 'confirm_reissue', ref_type: 'confirm_revision', ref_id: rp.body.reissued[0].revision_id, recipient_user_id: U.del }], '答复后改发 → 新修订的代表人');
  });

  // ═══════════════════════ 22 C6b 残余⑦（预筛 6 LOW：答复回退层跨轮次挂出旧答复）═══════════════════════
  test(`${T_CHAIN}——（C6a 残余⑦）手工改发的修订沿用同一任务上一条修订的答复，递归到任务第一条修订；上一轮不认可已解除后，新一轮任务（含手工改发出的修订）不挂上一轮的答复；新一轮自己有答复时手工改发沿用的是新一轮的答复（连续两次手工改发仍是那次）`, async () => {
    const s = await mkPlan({ partyB: true });
    const R1 = '答复一：旧一轮的答复，与新一轮无关。';
    const R2 = '答复二：新一轮的答复。';
    const url = `/sysbuild/batches/${s.batch1}/handover/requests`;
    const taskOf = async (eid, party) => (await hoTasks(eid)).filter((t) => t.party_id === party).pop();
    const revsOf = async (tid) => (await sqlAll('SELECT id, rev_no FROM sysbuild_confirm_task_revisions WHERE task_id = ? ORDER BY id', [tid]));
    const curReply = async (eid, party) => {
      const t = await taskOf(eid, party);
      const r = await get(U.pm, `/sysbuild/confirm-tasks/${t.task_id}`);
      assert.strictEqual(r.status, 200, r.text);
      return r.body.object.current_reply;
    };
    const decide = async (eid, party, decision) => {
      const r = await decideHo(party === s.A ? U.del : U.x2, (await taskOf(eid, party)).task_id, decision);
      assert.strictEqual(r.status, 200, r.text);
    };
    const manualReissue = async (eid, party) => {
      const r = await post(U.pm, `/sysbuild/confirm-tasks/${(await taskOf(eid, party)).task_id}/reissue`, { reason: '换人重新确认（手工改发）' });
      assert.strictEqual(r.status, 200, r.text);
    };
    const e = await blockerIssue(s, { title: '旧一轮答复不跨轮' });
    // ① 第一轮：乙部不认可 → PM 答复 R1 → 乙部重新决定并确认、甲部确认 → 解除、已清
    assert.strictEqual((await requestHo(U.pm, s.batch1, e.id)).status, 201);
    const oldB = await taskOf(e.id, s.B);
    await decide(e.id, s.B, 'reject');
    assert.strictEqual((await post(U.pm, url, { entry_id: e.id, reply: R1 })).status, 201);
    await decide(e.id, s.B, 'confirm');
    await decide(e.id, s.A, 'confirm');
    assert.strictEqual(itemOf(await handoverGet(U.pm, s.batch1), e.id).cleared, true, '第一轮已解除、已清');
    // ② 更正使指纹变化后重新发起第二轮：新任务不是旧任务；第一条修订没有答复；手工改发一次、两次仍然没有（旧一轮的答复不跨任务继承）
    await actOk(U.pm, e.id, { action: 'correct', text: '更正：补一句说明' });
    assert.strictEqual((await requestHo(U.pm, s.batch1, e.id)).status, 201);
    const newB = await taskOf(e.id, s.B);
    assert.notStrictEqual(newB.task_id, oldB.task_id, '第二轮是新任务');
    assert.strictEqual(await curReply(e.id, s.B), null, '新任务第一条修订：没有答复');
    await manualReissue(e.id, s.B);
    assert.strictEqual(await curReply(e.id, s.B), null, '手工改发出的第二条修订：沿用第一条的结果 = 没有答复（不挂第一轮的 R1）');
    await manualReissue(e.id, s.B);
    assert.strictEqual(await curReply(e.id, s.B), null, '连续两次手工改发：递归到第一条，仍没有答复');
    await manualReissue(e.id, s.A);
    assert.strictEqual(await curReply(e.id, s.A), null, '甲部同理');
    // ③ 第二轮自己的答复：乙部在第三条修订上不认可 → 答复 R2（生成第四条修订，事件链解析）→ 手工改发两次（第五、第六条）都沿用 R2，被答复的修订编号不变
    const revs3 = await revsOf(newB.task_id);
    assert.strictEqual(revs3.length, 3);
    await decide(e.id, s.B, 'reject');
    assert.strictEqual((await post(U.pm, url, { entry_id: e.id, reply: R2 })).status, 201);
    let c = await curReply(e.id, s.B);
    assert.deepStrictEqual([c.text, c.replied_revision_id], [R2, revs3[2].id], '答复生成的修订：R2，被答复的是第三条修订');
    await manualReissue(e.id, s.B);
    c = await curReply(e.id, s.B);
    assert.deepStrictEqual([c.text, c.replied_revision_id], [R2, revs3[2].id], '手工改发一次：沿用 R2');
    await manualReissue(e.id, s.B);
    c = await curReply(e.id, s.B);
    assert.deepStrictEqual([c.text, c.replied_revision_id], [R2, revs3[2].id], '手工改发两次（递归两层）：仍是 R2');
    assert.strictEqual((await revsOf(newB.task_id)).length, 6);
    // ④ 答复历史仍是该登记全部答复；甲部（第二轮没有被不认可）不挂任何答复
    const r = await get(U.pm, `/sysbuild/confirm-tasks/${newB.task_id}`);
    assert.deepStrictEqual(r.body.object.reply_history.map((x) => x.text), [R1, R2]);
    assert.strictEqual(await curReply(e.id, s.A), null, '甲部：第二轮没有被不认可，仍无答复');
  });
}

// ── 变异 ───────────────────────────────────────────────────────────────────────────────────────
// 每条 { id（前缀 C6a ）, expect: [用例名前缀], edits: [{ file, from, to }] }；锚点必须在副本里恰好出现一次（LF 归一后）。expect 列全会被打红的负责用例。
//   不覆盖（残余）：条件更新的旧状态保护（active → live / live → active 的 WHERE status = ? 只在并发下起作用，静态守卫 S2 管）；库内缺单号 / 承接人的 to_sys_iteration 结论兜底（API 造不出这类数据）。
const gm = (id, expect, file, from, to) => ({ id: `C6a ${id}`, expect, edits: [{ file, from, to }] });
const gm_b = (id, expect, file, from, to) => ({ id: `C6b ${id}`, expect, edits: [{ file, from, to }] });
const GOLIVE_MUTATIONS = [
  // ── rules.js：上线 / 撤销 / 发起交接确认 ──
  gm('golive 对非 PM 放行', [T_GOLIVE, T_RULES, T_FLAGS], 'rules.js', 'golive: Object.freeze({\n    can: canActAsPm,', 'golive: Object.freeze({\n    can: () => true,'),
  gm('golive 不核对批次状态', [T_GOLIVE, T_RULES], 'rules.js', "if (t.batchStatus !== 'active') return goliveBatchStateMessage(t.batchStatus);", ''),
  gm('golive 前置事实没取到也放行', [T_RULES], 'rules.js', 'if (!Array.isArray(t.blockers)) return GOLIVE_FACT_UNKNOWN_MESSAGE;', ''),
  gm('golive 前置未满足也放行', [T_GOLIVE, T_RULES, T_FLAGS], 'rules.js', "return t.blockers.length > 0 ? { code: 'SYSBUILD_GOLIVE_BLOCKED', message: goliveBlockedMessage(t.blockers) } : null;", 'return null;'),
  gm('golive 项目状态类别改成 maintain（暂停可上线）', [T_GOLIVE, T_RULES, T_FLAGS, 'rules：OP_KIND 与状态表'], 'rules.js', "  golive: 'golive',", "  golive: 'maintain',"),
  gm('撤销上线放行 PM', [T_REVOKE, T_RULES, T_FLAGS], 'rules.js', 'revoke_golive: Object.freeze({\n    can: canChangeProjectStatus,', 'revoke_golive: Object.freeze({\n    can: canActAsPm,'),
  // 第二层兜底（recordRevoke 的条件更新 AND status = 'live'）会把同一个 409 SYSBUILD_STATE 接住，端点层看不出差别，只有 rules 层能判红
  gm('撤销上线不核对批次已上线', [T_RULES],'rules.js', "if (t.batchStatus !== 'live') return t.batchStatus === undefined ? BATCH_FACT_UNKNOWN_MESSAGE : '只有已正式上线的批次可以撤销上线';", ''),
  gm('撤销上线放行待确认的结项包（P150）', [T_REVOKE, T_RULES],'rules.js', "if (t.closingPending === true) return '本项目有待确认的结项包，请先撤回结项包再撤销上线';", ''),
  gm('撤销上线项目状态类别改成 close（暂停不能撤销）', [T_REVOKE, T_RULES], 'rules.js', "  revoke_golive: 'maintain',", "  revoke_golive: 'close',"),
  gm('发起交接确认不核对批次进行中', [T_REQ, T_RULES], 'rules.js', "if (t.batchStatus !== 'active') return t.batchStatus === undefined ? BATCH_FACT_UNKNOWN_MESSAGE : '批次不是进行中，不能发起交接确认';", ''),
  gm('发起交接确认不核对登记在本批集合里', [T_REQ, T_RULES], 'rules.js', "if (t.inSet !== true) return t.inSet === false ? '该登记不在本批的上线交接集合里' : GOLIVE_FACT_UNKNOWN_MESSAGE;", ''),
  gm('发起交接确认不核对已办结', [T_REQ, T_RULES], 'rules.js', "if (t.resolved !== true) return t.resolved === false ? '该登记还没有办结，请先给出结论' : GOLIVE_FACT_UNKNOWN_MESSAGE;", ''),
  gm('发起交接确认放行不需要确认的登记', [T_REQ, T_RULES], 'rules.js', "if (t.needKind === null) return replyOk ? DECLINED_NO_NEED_MESSAGE : '该登记不需要交接确认';", ''),
  gm('发起交接确认放行已有任务（重复发起）', [T_REQ, T_RULES],'rules.js', "if (t.allCovered === true && !replyOk) return `该登记已有当前有效的交接确认任务（${HANDOVER_STATE_LABELS[t.confirmState] || '处理中'}），请在任务上处理（待确认的任务可代录、可换人改发）或等待确认`;", ''),
  gm('发起交接确认不拒缺代表人的参与方', [T_REQ, T_RULES], 'rules.js', "if (cm !== null) return cm.noParty ? NO_DEMAND_PARTY_MESSAGE : `以下参与方缺少生效代表人，无法发起交接确认：${cm.missing.join('、')}`;", ''),
  gm('发起交接确认对非 PM 放行', [T_REQ, T_RULES, T_FLAGS], 'rules.js', 'handover_request: Object.freeze({\n    can: canActAsPm,', 'handover_request: Object.freeze({\n    can: () => true,'),
  gm('发起交接确认项目状态类别改成 close（暂停不能发起）', [T_FLAGS, T_RULES], 'rules.js', "  handover_request: 'maintain',", "  handover_request: 'close',"),
  // ── rules.js：提交内容包 ──
  gm('批次验收包提交不核对批次进行中', [T_PKG, T_RULES], 'rules.js', "if (t.packageType === 'batch_accept' && t.batchStatus !== 'active') {", 'if (false) {'),
  gm('结项包提交不核对批次已上线', [T_CPKG, T_RULES], 'rules.js', 'if (cn !== null) return closingNotReadyMessage(cn);', ''),
  gm('结项包提交前置事实没取到也放行', [T_RULES], 'rules.js', 'if (cn === undefined) return CLOSING_FACT_UNKNOWN_MESSAGE;', ''),
  gm('待确认互斥不拦（四类包可同时待确认）', [T_EXCL, T_RULES], 'rules.js', 'if (t.otherPendingPackage !== null) return `已有待确认的内容包：${PACKAGE_TYPE_LABELS[t.otherPendingPackage] || t.otherPendingPackage}，须先撤回或等确认完成`;', ''),
  gm('待确认互斥事实没取到也放行', [T_RULES], 'rules.js', 'if (t.otherPendingPackage === undefined) return PENDING_FACT_UNKNOWN_MESSAGE;', ''),
  gm('待确认互斥把立项包也算进去', [T_EXCL, T_RULES], 'rules.js', "const EXCLUSIVE_PENDING_PACKAGE_TYPES = Object.freeze(['overall', 'change', 'batch_accept', 'closing']);", "const EXCLUSIVE_PENDING_PACKAGE_TYPES = Object.freeze(['overall', 'change', 'batch_accept', 'closing', 'initiation']);"),
  gm('验收包 / 结项包草稿 parent 过期也拒绝（没有别的办法重建草稿）', [T_PKG, T_CPKG, T_RULES], 'rules.js', 'if (t.parentSuperseded === true && !PARENT_REWRITTEN_AT_SUBMIT_TYPES.includes(t.packageType)) return PARENT_SUPERSEDED_MESSAGE;', 'if (t.parentSuperseded === true) return PARENT_SUPERSEDED_MESSAGE;'),
  gm('提交开放清单漏掉结项包', [T_CPKG, T_RULES], 'rules.js', "const SUBMITTABLE_PACKAGE_TYPES = Object.freeze(['overall', 'initiation', 'change', 'batch_accept', 'closing']);", "const SUBMITTABLE_PACKAGE_TYPES = Object.freeze(['overall', 'initiation', 'change', 'batch_accept']);"),
  // ── entries-core.js：统一上线判据与结项前置 ──
  gm('上线判据：同一秒也算已上线（严格晚于改成不早于）', [T_LIVE], 'entries-core.js', "return { last, live: LIVE_EVENT_KINDS.includes(ev.kind) && typeof ev.now_at === 'string' && ev.now_at > ev.created_at };", "return { last, live: LIVE_EVENT_KINDS.includes(ev.kind) && typeof ev.now_at === 'string' && ev.now_at >= ev.created_at };"),
  gm('上线判据：撤销事件也算已上线', [T_LIVE],'entries-core.js', "return { last, live: LIVE_EVENT_KINDS.includes(ev.kind) && typeof ev.now_at === 'string' && ev.now_at > ev.created_at };", "return { last, live: typeof ev.now_at === 'string' && ev.now_at > ev.created_at };"),
  gm('结项前置：被替代的批次也要求已上线', [T_CPKG, T_CLOSE], 'entries-core.js', "if (b.status === 'superseded') continue;", ''),
  gm('结项前置：已转出的批次不核对变更包', [T_CPKG, T_CLOSE], 'entries-core.js', "if (!ch || ch.status !== 'effective') out.transferNoChange.push({ id: b.id, name: b.name });", ''),
  gm('结项前置：未上线的批次不列', [T_CPKG, T_CLOSE], 'entries-core.js', 'if (!st.live) out.notLive.push({ id: b.id, name: b.name });', 'if (false) out.notLive.push({ id: b.id, name: b.name });'),
  gm('结项前置：结项包与上线事件同一时刻也算晚于', [T_CLOSE], 'entries-core.js', 'else if (eff && !(st.last.created_at < eff.effective_at)) out.goliveNewer.push({ id: b.id, name: b.name });', 'else if (eff && st.last.created_at > eff.effective_at) out.goliveNewer.push({ id: b.id, name: b.name });'),
  // ── entries-routing.js / confirm.js：分流与变更重核读同一个判据 ──
  gm('分流只看最后一条事件的种类不看时刻', [T_LIVE], 'entries-routing.js', 'return st.live ? { id: st.last.id } : null;', "return st.last && st.last.kind !== 'revoke' ? { id: st.last.id } : null;"),
  // 修订批 2：变更重核的「已上线」判据抽到 entries-core.isFrozenLiveBatch（批次状态 live 或上线事件判已上线）；本条改为「只看批次状态、不认上线事件」
  gm('变更重核读批次状态而不是上线判据', [T_LIVE], 'entries-core.js', 'return (await batchLiveState(q, batchId)).live;', 'return false;'),
  // ── golive-core.js：交接集合 ──
  gm('集合：承诺批次只看最后一条快照行', [T_SET], 'golive-core.js', 'AND part_no = ? AND trigger_action_id IS ? ORDER BY id', 'AND part_no = ? AND trigger_action_id IS ? ORDER BY id DESC LIMIT 1'),
  gm('集合：作废的登记也列', [T_SET], 'golive-core.js', 'if (d.voided === true) continue;', ''),
  gm('集合：已拆分容器也列', [T_SET], 'golive-core.js', 'if (kid) continue; // 已拆分容器：由子项判', 'if (false) continue;'),
  gm('集合：不收挂在本批节点上的登记', [T_SET], 'golive-core.js', "if (e.node_id !== null && e.node_id !== undefined && batchNodes.has(e.node_id)) sources.push('node');", ''),
  gm('集合：不收待判定的登记', [T_SET], 'golive-core.js', "if (route === 'pending') sources.push('pending');", ''),
  gm('集合：不收承诺批次含本批的登记', [T_SET], 'golive-core.js', "if ((route === 'project' || route === 'sys_iteration') && committed.includes(batch.id)) sources.push('committed');", ''),
  gm('集合：知悉类登记也列', [T_SET], 'golive-core.js', 'AND type IN (${marks}) ORDER BY id', 'AND (type IN (${marks}) OR 1 = 1) ORDER BY id'),
  // ── golive-core.js：已清判定与交接确认状态 ──
  gm('已清：未办结的登记算已清', [T_CLEAR, T_GOLIVE], 'golive-core.js', "if (!resolved) reasons.push('还没有办结');", ''),
  gm('已清：恒为已清', [T_CLEAR, T_GOLIVE],'golive-core.js', 'cleared: reasons.length === 0, reasons,', 'cleared: true, reasons,'),
  gm('阻塞项标志恒为假', [T_CLEAR], 'golive-core.js', 'is_blocker: d.risk_current === true && !HANDLED_CONCLUSION_KINDS.includes(kind),', 'is_blocker: false,'),
  gm('需要确认：未办结也要', [T_CORE, T_CLEAR], 'golive-core.js', 'if (!resolved) return { kind, need: null };', ''),
  gm('需要确认：不再处理不要确认', [T_CORE, T_CLEAR], 'golive-core.js', "if (kind === 'no_further') return { kind, need: 'no_further' };", ''),
  gm('需要确认：风险阻塞项不要确认', [T_CORE, T_CLEAR], 'golive-core.js', "if (derived.risk_current === true && !HANDLED_CONCLUSION_KINDS.includes(kind)) return { kind, need: 'accept_issue' };", 'if (false) return { kind, need: null };'),
  gm('需要确认：已采纳的风险问题也要确认', [T_CORE, T_CLEAR], 'golive-core.js', "const HANDLED_CONCLUSION_KINDS = Object.freeze(['handled', 'adopted']);", "const HANDLED_CONCLUSION_KINDS = Object.freeze(['handled']);"),
  gm('确认状态：有代表人不认可不算 declined', [T_CORE],'golive-core.js', "if (valid.some((t) => HANDOVER_REVISION_STATUS_FAILED.includes(t.status))) return 'declined';", ''),
  gm('确认状态：不核对每个需求部门都有任务', [T_CORE], 'golive-core.js', "if (!covered) return 'incomplete';", ''),
  gm('确认状态：有一个确认就算全部确认', [T_CORE, T_REQ], 'golive-core.js', "return valid.every((t) => t.status === 'confirmed') ? 'confirmed' : 'pending';", "return valid.some((t) => t.status === 'confirmed') ? 'confirmed' : 'pending';"),
  gm('指纹：旧指纹的任务仍算当前任务', [T_FP], 'golive-core.js', 'if (t.object_version_id !== lastActionId || !snapshotOk) continue;', 'if (!snapshotOk) continue;'),
  gm('指纹：任务对象不核对办理动作编号', [T_FP], 'golive-core.js', 'if ((await lastActionIdOf(q, entryId)) !== versionId) return false;', ''),
  gm('指纹：任务对象恒有效', [T_FP], 'golive-core.js', "return { entry, pending: current, status: current ? 'pending' : 'stale' };", "return { entry, pending: true, status: 'pending' };"),
  gm('登记有新办理动作时不失效待确认的交接确认', [T_FP], 'entries.js', 'const staleHandover = await goliveCore.invalidateStaleHandoverRevisions(q, user, entry);', 'const staleHandover = [];'),
  gm('交接确认用途映射写反', [T_REQ, T_CORE], 'golive-core.js', "const HANDOVER_PURPOSE_OF = Object.freeze({ accept_issue: 'handover_accept_issue', no_further: 'handover_no_further' });", "const HANDOVER_PURPOSE_OF = Object.freeze({ accept_issue: 'handover_no_further', no_further: 'handover_accept_issue' });"),
  gm('发起交接确认不冻结登记附件', [T_REQ], 'golive-core.js', 'await entries.ensureEntryFrozen(q, attachmentHelpers, user, entry);', ''),
  gm('汇总的已确认计数不对', [T_CORE], 'golive-core.js', "confirmed: items.filter((i) => i.need_confirm !== null && i.confirm.state === 'confirmed').length,", "confirmed: items.filter((i) => i.confirm.state === 'confirmed').length + 1,"),
  // ── golive-core.js：上线 / 撤销的写入 ──
  gm('上线前置：未开始的节点不算未收口', [T_GOLIVE], 'golive-core.js', "AND is_golive_milestone = 0 AND status NOT IN ('closed', 'cancelled')", "AND is_golive_milestone = 0 AND status NOT IN ('closed', 'cancelled', 'not_started')"),
  gm('上线前置：里程碑节点也要先收口', [T_GOLIVE], 'golive-core.js', "AND is_golive_milestone = 0 AND status NOT IN ('closed', 'cancelled')", "AND status NOT IN ('closed', 'cancelled')"),
  gm('上线前置：不核对批次验收包', [T_GOLIVE],'golive-core.js', "if (want('ACCEPT_NOT_EFFECTIVE')) out.push(", 'if (false) out.push('),
  gm('上线前置：验收包不限本批', [T_GOLIVE], 'golive-core.js', "WHERE p.batch_id = ? AND p.type = 'batch_accept' AND v.status = 'effective' LIMIT 1", "WHERE ? IS NOT NULL AND p.type = 'batch_accept' AND v.status = 'effective' LIMIT 1"),
  gm('上线前置：交接集合有未清项也放行', [T_GOLIVE],'golive-core.js', 'if (unc.length > 0) {', 'if (false) {'),
  gm('上线快照不存完整集合', [T_GOLIVE], 'golive-core.js', '{ items: view.items, summary: view.summary }', '{ items: [], summary: view.summary }'),
  gm('上线收口里程碑不写实际结束', [T_GOLIVE, T_IMPORT], 'golive-core.js', "VALUES (?, 'actual_end', ?, ?)\", [node.id, o.dateStr, Number(user.id)]);", "VALUES (?, 'actual_end', ?, ?)\", [node.id, '2000-01-01', Number(user.id)]);"),
  gm('上线收口未开始的里程碑不写实际开始', [T_GOLIVE, T_IMPORT], 'golive-core.js', "await q.run(\"INSERT INTO sysbuild_node_schedule_records (node_id, kind, actual_date, created_by) VALUES (?, 'actual_start', ?, ?)\", [node.id, o.dateStr, Number(user.id)]);", ''),
  gm('撤销上线不把里程碑退回进行中', [T_REVOKE], 'golive-core.js', "if (node.status === 'closed') {", 'if (false) {'),
  gm('项目上线进度不计已上线批次', [T_GOLIVE, T_REVOKE], 'golive-core.js', 'if ((await entries.batchLiveState(q, b.id)).live) live += 1;', ''),
  // ── golive.js ──
  gm('再上线的事件种类恒为 golive', [T_REVOKE, T_PROD], 'golive.js', "const kind = last !== null && last.kind === 'revoke' ? 'regolive' : 'golive';", "const kind = 'golive';"),
  gm('上线按事先算好的空前置判定（不按当时完整集合重核）', [T_GOLIVE, T_FLAGS], 'golive.js', "const v = rules.checkOp('golive', access, access.project, { batchStatus: batch.status, blockers: view.blockers });", "const v = rules.checkOp('golive', access, access.project, { batchStatus: batch.status, blockers: [] });"),
  gm('上线被拒的响应不带 blockers 列表', [T_GOLIVE], 'golive.js', "if (v.code === 'SYSBUILD_GOLIVE_BLOCKED' && Array.isArray(blockers)) err.blockers = blockers;", ''),
  // ── confirm.js / confirm-core.js：交接确认任务 ──
  gm('指纹过期的交接确认任务仍可改发（改发判据不核对对象已不是待确认）', [T_FP], 'rules.js', "      if (t.objectStatus !== 'pending') return '任务所在的版本已不是待确认，不能改发';", ''),
  gm('交接确认也收「有异议」', [T_REQ], 'confirm.js', "handover_accept_issue: Object.freeze(['confirm', 'reject']), handover_no_further: Object.freeze(['confirm', 'reject']),", "handover_accept_issue: Object.freeze(['confirm', 'object', 'reject']), handover_no_further: Object.freeze(['confirm', 'object', 'reject']),"),
  gm('交接确认用通用确认文案', [T_REQ, T_CORE], 'confirm-core.js', "confirm: '我已阅读以上全部内容，确认接受该问题带着上线',", "confirm: '我已阅读以上全部内容，确认无误',"),
  gm('结项包确认人也含负责人', [T_CPKG], 'confirm-core.js', "const wantOwner = packageType !== 'closing';", 'const wantOwner = true;'),
  gm('批次验收包确认人不含代表人', [T_PKG], 'confirm-core.js', "const DELEGATE_CONFIRM_PACKAGE_TYPES = Object.freeze(['overall', 'change', 'batch_accept', 'closing']);", "const DELEGATE_CONFIRM_PACKAGE_TYPES = Object.freeze(['overall', 'change', 'closing']);"),
  gm('结项包确认人不含代表人', [T_CPKG], 'confirm-core.js', "const DELEGATE_CONFIRM_PACKAGE_TYPES = Object.freeze(['overall', 'change', 'batch_accept', 'closing']);", "const DELEGATE_CONFIRM_PACKAGE_TYPES = Object.freeze(['overall', 'change', 'batch_accept']);"),
  // ── packages.js ──
  gm('待确认互斥的事实恒为空', [T_EXCL], 'packages.js', 'facts.otherPendingPackage = other ? other.type : null;', 'facts.otherPendingPackage = null;'),
  gm('结项包提交前置的事实恒为满足', [T_CPKG], 'packages.js', 'facts.closingNotReady = cf.notLive.length === 0 && cf.transferNoChange.length === 0', 'facts.closingNotReady = true || cf.notLive.length === 0 && cf.transferNoChange.length === 0'),
  // ── plan.js / projects.js：整体结项与重开 ──
  gm('p_closing 收口不结项', [T_CLOSE], 'plan.js', "if (node.template_key === 'p_closing' && node.batch_id === null) {", 'if (false) {'),
  gm('结项事件缺原因', [T_CLOSE], 'plan.js', "{ from: 'active', to: 'closed', reason: '整体验收结项节点收口' }", "{ from: 'active', to: 'closed' }"),
  gm('p_closing 收口前置：结项包不晚于上线事件也放行', [T_CLOSE], 'plan.js', 'if (cl.goliveNewer.length > 0) {', 'if (false) {'),
  gm('p_closing 收口前置：转出批次无变更包也放行', [T_CLOSE], 'plan.js', 'if (cl.transferNoChange.length > 0) out.push(', 'if (false) out.push('),
  gm('已结项重开不退回 p_closing', [T_CLOSE], 'projects.js', "if (from === 'closed' && to === 'active') {", 'if (false) {'),
  // ── history.js：上线事件导入 ──
  gm('导入上线：批次不是进行中也放行', [T_IMPORT], 'history.js', "if (batch.status !== 'active') return { block: '只有进行中的批次可以导入上线事件（规划中、已上线、已转出、被替代的批次都不行）' };", ''),
  gm('导入上线：已有上线事件也放行', [T_IMPORT], 'history.js', 'if (any) return { block:', 'if (false) return { block:'),
  gm('导入上线：事件时刻取此刻而不是原日期', [T_IMPORT], 'history.js', 'createdAt: at,', 'createdAt: null,'),
  gm('导入上线：快照不带历史导入标记', [T_IMPORT], 'history.js', 'goliveCore.snapshotOf(view, { history_import: true, exempt_nodes: data.exemptNodes })', 'goliveCore.snapshotOf(view)'),
  gm('导入收口：整体验收结项也能导入', [T_IMPORT], 'history.js', "if (node.template_key === 'p_closing') return { block: '整体验收结项的收口不支持历史导入' };", ''),
  gm('导入上线：里程碑开始日之前的原日期也放行', [T_IMPORT], 'history.js', "milestone.status === 'in_progress' && milestone.opened_at && date < String(milestone.opened_at).slice(0, 10)", 'false'),
  // ── plan.js closePackageRequirement（对拍）──
  // ── 修订批 1（预筛 1 轮）──
  gm('P162：去向留项目且承诺批次为空的登记不进集合', [T_UNB], 'golive-core.js', "if (route === 'project' && committed.length === 0) sources.push('unbatched');", ''),
  gm('P162：承诺批次为空的判据不限去向（规划外转系统迭代也进集合）', [T_UNB], 'golive-core.js', "if (route === 'project' && committed.length === 0) sources.push('unbatched');", "if (committed.length === 0) sources.push('unbatched');"),
  gm('P167：转系统迭代且承诺本批的登记不进集合', [T_UNB], 'golive-core.js', "if ((route === 'project' || route === 'sys_iteration') && committed.includes(batch.id)) sources.push('committed');", "if (route === 'project' && committed.includes(batch.id)) sources.push('committed');"),
  gm('P168：不核验收包引用的规划是否现行', [T_STALE], 'golive-core.js', "else if (want('ACCEPT_STALE') && acc.parent_id !== (await packages.effectiveOverallVersionId(q, batch.project_id))) {", 'else if (false) {'),
  gm('P168：验收包过期判据读上一版规划（只看有没有 parent）', [T_STALE], 'golive-core.js', "else if (want('ACCEPT_STALE') && acc.parent_id !== (await packages.effectiveOverallVersionId(q, batch.project_id))) {", "else if (want('ACCEPT_STALE') && acc.parent_id === null) {"),
  gm('P164：待确认的规划类包不挡上线', [T_STALE], 'golive-core.js', "if (want('PLAN_PENDING') && (await planPendingOf(q, batch.project_id))) out.push(", 'if (false) out.push('),
  gm('P164：待确认判据只看总体规划包（变更包待确认不挡上线）', [T_STALE], 'golive-core.js', "WHERE p.project_id = ? AND p.type IN ('overall', 'change') AND v.status = 'pending' LIMIT 1", "WHERE p.project_id = ? AND p.type IN ('overall') AND v.status = 'pending' LIMIT 1"),
  gm('P168：结项包过期事实恒为假', [T_PPEND], 'entries-core.js', 'closingStale: !!eff && eff.parent_id !== curOverall,', 'closingStale: false,'),
  gm('P168：结项包过期不挡 p_closing 收口', [T_PPEND], 'plan.js', "if (cl.closingStale === true && typeof cl.closingEffectiveAt === 'string') {", 'if (false) {'),
  gm('P164：待确认的内容包不挡 p_closing 收口', [T_PPEND], 'plan.js', 'if (cl.packagePending.length > 0) {', 'if (false) {'),
  gm('P164：待确认事实漏掉变更包', [T_PPEND], 'entries-core.js', "AND v.status = 'pending' ORDER BY p.type`", "AND v.status = 'pending' AND p.type <> 'change' ORDER BY p.type`"),
  gm('结项事实缺新字段也放行（不 fail-closed）', [T_CORE], 'plan.js', "      || typeof cl.closingStale !== 'boolean' || !Array.isArray(cl.packagePending)) {", ') {'),
  gm('P163：不核已上线批次的承诺集合冻结', [T_FREEZE], 'entries-core.js', 'if (!(await frozenBatch(it.committed_batch_id))) continue;', 'continue;'),
  gm('P163：已上线批次的条目换版本不拦', [T_FREEZE], 'entries-core.js', 'c === null || c.item_version_id !== it.item_version_id || c.committed_batch_id !== it.committed_batch_id', 'c === null || c.committed_batch_id !== it.committed_batch_id'),
  gm('P163：条目移入已上线批次不拦', [T_FREEZE], 'entries-core.js', 'c === null || c.item_version_id !== it.item_version_id || c.committed_batch_id !== it.committed_batch_id', 'c === null || c.item_version_id !== it.item_version_id'),
  gm('P163：往已上线批次加新条目不拦', [T_FREEZE], 'entries-core.js', 'c === null || c.item_version_id !== it.item_version_id || c.committed_batch_id !== it.committed_batch_id', 'c !== null && (c.item_version_id !== it.item_version_id || c.committed_batch_id !== it.committed_batch_id)'),
  gm('P163：冻结拒绝不抛', [T_FREEZE], 'confirm.js', 'if (bad.liveFrozen.length > 0) throw stateError(', 'if (false) throw stateError('),
  gm('P165：代表人已决定的交接任务也可改发', [T_REQ], 'confirm.js', "if (c.latest.status !== 'pending' && c.latest.status !== 'invalid') return { isDelegate: true,", "if (false) return { isDelegate: true,"),
  gm('P165：同一指纹已有不认可也能重新发起（无答复也放行）', [T_REQ, T_RULES, T_REPLY], 'rules.js', "if (t.confirmState === 'declined' && !replyOk) return t.needKind === null ? DECLINED_NO_NEED_MESSAGE : DECLINED_REPLY_MESSAGE;", ''),
  // ── 修订批 3（P174：答复）──
  gm('P174：答复不算答复（待答复的不认可不看答复事件）', [T_REPLY], 'golive-core.js', 'if (replied.has(Number(r.revision_id))) continue;', ''),
  gm('P174：答复之后再次不认可也算已答复（任一答复覆盖全部不认可）', [T_REPLY], 'golive-core.js', 'if (replied.has(Number(r.revision_id))) continue;', 'if (replied.size > 0) continue;'),
  gm('P174：答复事件不记被答复的修订', [T_REPLY], 'golive-core.js', 'batch_id: batch.id, replied_revision_ids: unreplied.map((r) => r.revision_id), reply,', 'batch_id: batch.id, replied_revision_ids: [], reply,'),
  gm('P174：答复事件不记答复文字', [T_REPLY], 'golive-core.js', 'batch_id: batch.id, replied_revision_ids: unreplied.map((r) => r.revision_id), reply,', "batch_id: batch.id, replied_revision_ids: unreplied.map((r) => r.revision_id), reply: '',"),
  gm('P174：答复后不给被不认可的任务生成新修订', [T_REPLY], 'golive-core.js', 'if (!HANDOVER_REVISION_STATUS_FAILED.includes(t.status)) continue;\n    const dlg = await core.currentDelegate(q, t.party_id);', 'continue;\n    const dlg = await core.currentDelegate(q, t.party_id);'),
  gm('P174：没有不认可时带答复也放行', [T_REPLY, T_RULES], 'rules.js', 'if (t.confirmState !== \'declined\' && t.replyGiven === true) return NO_REPLY_NEEDED_MESSAGE;', ''),
  gm('P175：不需要确认时带答复也放行（只记答复）', [T_UNMARK, T_RULES], 'rules.js', "if (t.needKind === null) return replyOk ? DECLINED_NO_NEED_MESSAGE : '该登记不需要交接确认';", "if (t.needKind === null) return replyOk ? null : '该登记不需要交接确认';"),
  gm('P174：答复后仍按「已有任务」拦', [T_REPLY, T_RULES], 'rules.js', 'if (t.allCovered === true && !replyOk) return', 'if (t.allCovered === true) return'),
  gm('P174：答复不核缺代表人（被不认可的任务不算要重新解析的）', [T_REPLY], 'golive-core.js', 'const redo = new Set(reply ? item.confirm.tasks.filter((t) => HANDOVER_REVISION_STATUS_FAILED.includes(t.status)).map((t) => t.party_id) : []);', 'const redo = new Set([]);'),
  gm('P174：答复字数下限放宽到 1 字', [T_REPLY], 'golive.js', 'const REPLY_MIN = 10;', 'const REPLY_MIN = 1;'),
  gm('P174：reply_required 恒为假', [T_REPLY, T_REQ], 'golive-core.js', "reply_required: confirm.state === 'declined' && need !== null,", 'reply_required: false,'),
  gm('P174：读接口标志不按带答复算', [T_REPLY], 'golive.js', 'it.reply_required === true);', 'false);'),
  gm('P174：答复事件类型未登记', [T_REPLY], 'events.js', "'handover_requested', 'handover_replied',", "'handover_requested',"),
  gm('LOW-1：交接任务对象只看指纹不看登记当前是否仍需要该确认', [T_LAPSE], 'golive-core.js', 'current = need !== null && HANDOVER_PURPOSE_OF[need] === task.purpose;', 'current = true;'),
  gm('P166：上线事件导入不核本批节点全部收口', [T_IMPORT], 'history.js', 'if (openNodes.length > 0) return { block:', 'if (false) return { block:'),
  gm('LOW-3：重开项目时 p_closing 不是已收口也静默放过', [T_REOPEN], 'projects.js', "if (!closing || closing.status !== 'closed') throw makeError(500,", "if (false) throw makeError(500,"),
  gm('LOW-5：项目详情不带上线进度', [T_REVOKE], 'projects.js', 'const golive_progress = await goliveCore.goliveProgressOf(q, pid);', 'const golive_progress = undefined;'),
  gm('LOW-7：发起交接确认的任务指纹写成 0', [T_REQ], 'golive-core.js', 'objectVersionId: item.confirm.fingerprint,', 'objectVersionId: 0,'),
  gm('LOW-7：待确认结项包判据读草稿', [T_REVOKE], 'golive-core.js', "p.type = 'closing' AND v.status = 'pending' LIMIT 1", "p.type = 'closing' AND v.status = 'draft' LIMIT 1"),
  gm('LOW-7：待确认结项包判据读变更包', [T_REVOKE], 'golive-core.js', "p.type = 'closing' AND v.status = 'pending' LIMIT 1", "p.type = 'change' AND v.status = 'pending' LIMIT 1"),
  gm('LOW-7：计划视图的批次上线阻塞项只对进行中批次现算（判反）', [T_STALE, T_FLAGS], 'plan.js', "blockers: b.status === 'active' ? (await goliveCore.handoverViewOf(q, b)).blockers : [],", "blockers: b.status !== 'active' ? (await goliveCore.handoverViewOf(q, b)).blockers : [],"),
  // ── 修订批 2（预筛 2 轮）──
  gm('P169：上线事件导入不核待确认的规划', [T_EFFECT], 'history.js', "if (gate.some((b) => b.code === 'PLAN_PENDING')) return { block:", 'if (false) return { block:'),
  gm('P169：变更生效不重核已上线批次冻结', [T_EFFECT], 'confirm-core.js', 'if (breaches.frozen.length > 0 || breaches.removed.length > 0) throw stateError(', 'if (false) throw stateError('),
  gm('P169：变更生效重核漏掉往已上线批次新增条目', [T_EFFECT], 'confirm-core.js', 'if (breaches.frozen.length > 0 || breaches.removed.length > 0) throw stateError(', 'if (breaches.removed.length > 0) throw stateError('),
  gm('P170：冻结判据不认批次状态 live（只看上线事件）', [T_FREEZE], 'entries-core.js', "if (b && b.status === 'live') return true;", ''),
  gm('P171：上线导入不豁免 b_uat', [T_EXEMPT], 'history.js', "const openNodes = allOpen.filter((n) => n.template_key !== 'b_uat');", 'const openNodes = allOpen;'),
  gm('P171：上线导入豁免所有未收口节点', [T_EXEMPT], 'history.js', "const openNodes = allOpen.filter((n) => n.template_key !== 'b_uat');", 'const openNodes = [];'),
  gm('P171：导入快照不记豁免的节点', [T_EXEMPT], 'history.js', 'exempt_nodes: data.exemptNodes', 'exempt_nodes: []'),
  gm('P173：更正也解除不认可', [T_DECL], 'golive-core.js', "const CONCLUSION_CLASS_ACTIONS = Object.freeze(['conclude', 'for_reference', 'void', 'adjudicate']);", "const CONCLUSION_CLASS_ACTIONS = Object.freeze(['conclude', 'for_reference', 'void', 'adjudicate', 'correct']);"),
  gm('P173：仅供参考不解除不认可', [T_DECL], 'golive-core.js', "const CONCLUSION_CLASS_ACTIONS = Object.freeze(['conclude', 'for_reference', 'void', 'adjudicate']);", "const CONCLUSION_CLASS_ACTIONS = Object.freeze(['conclude', 'void', 'adjudicate']);"),
  gm('P173：作废不解除不认可', [T_DECL], 'golive-core.js', "const CONCLUSION_CLASS_ACTIONS = Object.freeze(['conclude', 'for_reference', 'void', 'adjudicate']);", "const CONCLUSION_CLASS_ACTIONS = Object.freeze(['conclude', 'for_reference', 'adjudicate']);"),
  gm('P173：不认可时刻当时的那条动作也算「之后」', [T_DECL, T_REQ],'golive-core.js', 'WHERE entry_id = ? AND id > ? AND action IN', 'WHERE entry_id = ? AND id >= ? AND action IN'),
  gm('P173：未解除的不认可不挡不再需要确认的项的已清（兜底原因）', [T_DECL, T_UNMARK], 'golive-core.js', 'if (declinedOut && need === null) reasons.push(', 'if (false) reasons.push('),
  gm('P173：未解除的不认可不体现在确认状态', [T_DECL], 'golive-core.js', "if (declinedOutstanding === true) return 'declined';", ''),
  gm('P173：集合项的确认状态不带未解除的不认可', [T_DECL], 'golive-core.js', 'handoverConfirmStateOf(valid, anyOld, partyIds, replyPending)', 'handoverConfirmStateOf(valid, anyOld, partyIds)'),
  // ── 修订批 4（P175：不认可后不能取消风险标记 / 答复只在仍需确认时有效；P176：交接确认代录只放无账号代表人；LOW-1：文案不列「裁定」）──
  // 判定行去掉后兜底行 declineOutstanding === false 对 true 仍给 409（文案不同、状态码相同），所以连同兜底行一起放宽成只看 riskCurrent
  gm('P175：有未解除的不认可仍可取消风险标记', [T_UNMARK, T_DECL, T_REPLY, T_RULES], 'rules.js', "if (t.riskCurrent === true && t.declineOutstanding === true) return UNMARK_RISK_DECLINED_MESSAGE;\n      return t.riskCurrent === true && t.declineOutstanding === false ? null : PROXY_FACT_UNKNOWN_MESSAGE;", 'return t.riskCurrent === true ? null : PROXY_FACT_UNKNOWN_MESSAGE;'),
  gm('P175：取消风险的未解除不认可事实没取到也放行', [T_RULES], 'rules.js', 'return t.riskCurrent === true && t.declineOutstanding === false ? null : PROXY_FACT_UNKNOWN_MESSAGE;', 'return t.riskCurrent === true && t.declineOutstanding !== true ? null : PROXY_FACT_UNKNOWN_MESSAGE;'),
  gm('P175：取消风险的拒绝只在状态码上拦（文案换成事实缺失）', [T_RULES, T_UNMARK], 'rules.js', 'if (t.riskCurrent === true && t.declineOutstanding === true) return UNMARK_RISK_DECLINED_MESSAGE;', 'if (t.riskCurrent === true && t.declineOutstanding === true) return PROXY_FACT_UNKNOWN_MESSAGE;'),
  gm('P175：办理目标不带未解除的不认可（恒为无）', [T_UNMARK, T_DECL, T_REPLY], 'entries-core.js', "const declineOutstanding = entry.type === 'issue' && facts.derived.risk_current === true ? await require('./golive-core').declineOutstandingOf(q, entry.id) : false;", 'const declineOutstanding = false;'),
  gm('P175：办理目标的未解除不认可恒为有', [T_UNMARK], 'entries-core.js', "const declineOutstanding = entry.type === 'issue' && facts.derived.risk_current === true ? await require('./golive-core').declineOutstandingOf(q, entry.id) : false;", 'const declineOutstanding = true;'),
  gm('P175：不需要确认时的拒绝文案仍叫人写答复', [T_UNMARK, T_RULES], 'rules.js', "return t.needKind === null ? DECLINED_NO_NEED_MESSAGE : DECLINED_REPLY_MESSAGE;", 'return DECLINED_REPLY_MESSAGE;'),
  gm('P175：不需要确认时仍要求答复（reply_required 不看是否需要确认）', [T_UNMARK, T_DECL], 'golive-core.js', "reply_required: confirm.state === 'declined' && need !== null,", "reply_required: confirm.state === 'declined',"),
  gm('P176：有账号的代表人的交接确认也能代录', [T_ACCT, T_RULES], 'rules.js', 'if (t.requiredHasAccount === true) return HANDOVER_ACCOUNT_PROXY_MESSAGE;', ''),
  gm('P176：代录账号事实没取到也放行', [T_RULES], 'rules.js', 'if (t.requiredHasAccount !== false) return PROXY_FACT_UNKNOWN_MESSAGE;', ''),
  gm('P176：交接确认的代录不判账号（用途判定恒为假）', [T_ACCT], 'confirm.js', 'accountlessOnly: goliveCore.HANDOVER_PURPOSES.includes(c.task.purpose),', 'accountlessOnly: false,'),
  gm('P176：账号事实恒为无账号（有账号的也能代录）', [T_ACCT], 'confirm.js', 'requiredHasAccount: c.requiredUserId !== null,', 'requiredHasAccount: false,'),
  gm('P176：账号事实恒为有账号（无账号的代表人也不能代录）', [T_ACCT], 'confirm.js', 'requiredHasAccount: c.requiredUserId !== null,', 'requiredHasAccount: true,'),
  gm('P176：所有用途的代录都不放有账号的人（办理结论确认也被挡）', [T_ACCT], 'confirm.js', 'accountlessOnly: goliveCore.HANDOVER_PURPOSES.includes(c.task.purpose),', 'accountlessOnly: true,'),
  gm('P176：只挡接受带问题上线一个用途（不再处理的代录放行有账号）', [T_ACCT], 'confirm.js', 'accountlessOnly: goliveCore.HANDOVER_PURPOSES.includes(c.task.purpose),', "accountlessOnly: c.task.purpose === 'handover_accept_issue',"),
  gm('LOW-1：解除不认可的拒绝文案又列出「裁定」', [T_RULES], 'rules.js', '或先给出新的结论（给结论 / 仅供参考 / 作废）；更正、记单号', '或先给出新的结论（给结论 / 仅供参考 / 作废 / 裁定）；更正、记单号'),
  gm('LOW-1：不需要确认时的拒绝文案列出「裁定」', [T_RULES, T_UNMARK], 'rules.js', "答复只在仍需交接确认时有效；须先给出新的结论（给结论 / 仅供参考 / 作废）才能解除';", "答复只在仍需交接确认时有效；须先给出新的结论（给结论 / 仅供参考 / 作废 / 裁定）才能解除';"),
  gm('LOW-1：兜底未清原因列出「裁定」', [T_DECL, T_UNMARK], 'golive-core.js', "须先给出新的结论（给结论 / 仅供参考 / 作废）才能解除');", "须先给出新的结论（给结论 / 仅供参考 / 作废 / 裁定）才能解除');"),
  gm('LOW-1：结论类动作集合去掉预留的 adjudicate', [T_DECL], 'golive-core.js', "const CONCLUSION_CLASS_ACTIONS = Object.freeze(['conclude', 'for_reference', 'void', 'adjudicate']);", "const CONCLUSION_CLASS_ACTIONS = Object.freeze(['conclude', 'for_reference', 'void']);"),
  // ── 修订批 5（P177：答复只解锁重新发起，不解除不认可；解除 = (a) 新的结论类动作 / (b) 被不认可的部门在其后重新确认）──
  gm('P177：答复即解除不认可', [T_LIFT, T_UNMARK], 'golive-core.js', 'if (reconfirmed) continue; // (b)', 'if (reconfirmed || (await repliedRevisionIdsOf(q, entryId)).has(Number(r.revision_id))) continue; // (b)'),
  gm('P177：(b) 只认待确认的修订（不认已确认）', [T_LIFT, T_UNMARK], 'golive-core.js', "AND c.id > ? AND c.status = 'confirmed' LIMIT 1", "AND c.id > ? AND c.status = 'pending' LIMIT 1"),
  gm('P177：(b) 不限同一需求部门（任一部门确认就解除）', [T_LIFT, T_DECL], 'golive-core.js', 'AND t.party_id = ? AND c.id > ?', 'AND ? IS NOT NULL AND c.id > ?'),
  gm('P177：(b) 不看确认是否在不认可之后', [T_LIFT, T_DECL], 'golive-core.js', 'AND t.party_id = ? AND c.id > ? AND c.status', 'AND t.party_id = ? AND c.id <> ? AND c.status'),
  gm('P177：部分部门解除就算全部解除', [T_LIFT], 'golive-core.js', 'return out;\n}\nasync function declineOutstandingOf', 'return out.length < rows.length ? [] : out;\n}\nasync function declineOutstandingOf'),
  gm('P177：未解除的不认可读待答复清单（答复即解除）', [T_LIFT, T_UNMARK, T_DECL], 'golive-core.js', 'return (await outstandingDeclinesOf(q, entryId)).length > 0;', 'return (await unrepliedDeclinesOf(q, entryId)).length > 0;'),
  gm('P177：待答复恒等于未解除（答复后仍要求再答复）', [T_LIFT, T_REPLY], 'golive-core.js', 'const replyPending = (await unrepliedDeclinesOf(q, e.id, outstandingDeclines)).length > 0;', 'const replyPending = declinedOut;'),
  { id: 'C6a P177：(b) 只认同一任务（不认指纹过期后重建的任务）', expect: [T_LIFT], edits: [
    { file: 'golive-core.js', from: 'AND t.party_id = ? AND c.id > ?', to: 'AND t.id = ? AND c.id > ?' },
    { file: 'golive-core.js', from: '[entryId, r.party_id, r.revision_id]', to: '[entryId, r.task_id, r.revision_id]' },
  ] },
  // ── 修订批 6（P178：导入上线共用交接闸门）──
  gm('P178：导入上线不核交接集合（PROBE N）', [T_GATE, T_IMPORT], 'history.js', 'if (other) return { block: `${other.message}', 'if (false) return { block: `${other.message}'),
  gm('P178：导入闸门漏掉 HANDOVER_UNCLEARED（只取待确认的规划）', [T_GATE, T_IMPORT], 'golive-core.js', "const IMPORT_GATE_CODES = Object.freeze(['PLAN_PENDING', 'HANDOVER_UNCLEARED']);", "const IMPORT_GATE_CODES = Object.freeze(['PLAN_PENDING']);"),
  gm('P178：导入闸门漏掉 PLAN_PENDING', [T_EFFECT], 'golive-core.js', "const IMPORT_GATE_CODES = Object.freeze(['PLAN_PENDING', 'HANDOVER_UNCLEARED']);", "const IMPORT_GATE_CODES = Object.freeze(['HANDOVER_UNCLEARED']);"),
  gm('P178：导入闸门连验收包也要求（历史项目没有验收包）', [T_GATE, T_IMPORT], 'golive-core.js', "const IMPORT_GATE_CODES = Object.freeze(['PLAN_PENDING', 'HANDOVER_UNCLEARED']);", "const IMPORT_GATE_CODES = Object.freeze(['PLAN_PENDING', 'HANDOVER_UNCLEARED', 'ACCEPT_NOT_EFFECTIVE']);"),
  // ── 修订批 6（codex 27 M1：代表人看得到 PM 的答复）──
  gm('M1：确认详情不带当前修订的答复', [T_SEEREPLY], 'golive-core.js', 'current_reply: currentReply,', 'current_reply: null,'),
  gm('M1：确认详情不带答复历史', [T_SEEREPLY], 'golive-core.js', 'reply_history: replies,', 'reply_history: [],'),
  gm('M1：不是因答复生成的修订也显示最近一次答复', [T_SEEREPLY], 'golive-core.js', 'if (prev === null) return replyByTaskChain(q, entryId, taskId, revisionId, replies);', "if (prev === null) return replies.length > 0 ? Object.assign({}, replies[replies.length - 1], { replied_revision_id: null }) : null;"),
  gm('M1：当前答复取历史第一条（第二次答复看不到）', [T_LINK], 'golive-core.js', 'const hit = replies.filter((r) => r.replied_revision_ids.includes(prev)).pop();', 'const hit = replies[0];'),
  gm('M1：被答复的修订编号取当前修订', [T_LINK], 'golive-core.js', 'replied_revision_id: prev });', 'replied_revision_id: revisionId });'),
  gm('M1：答复历史倒序', [T_SEEREPLY], 'golive-core.js', "AND event_type = 'handover_replied' ORDER BY id\",", "AND event_type = 'handover_replied' ORDER BY id DESC\","),
  gm('M1：交接清单每项不带最近一次答复', [T_SEEREPLY], 'golive.js', 'last_reply: await golive.lastReplyOf(q, it.entry_id),', 'last_reply: null,'),
  gm('M1：交接清单取第一次答复', [T_SEEREPLY], 'golive-core.js', 'const r = all[all.length - 1];', 'const r = all[0];'),
  // ── 修订批 7（27-R M1：答复与修订的直接关联）──
  gm('J1：重新发起事件不记答复关联', [T_LINK], 'golive.js', 'reply_event_id: replyLinks.reply_event_id, reply_links: replyLinks.reply_links,', 'reply_event_id: null, reply_links: [],'),
  gm('J1：新建的任务不进关联映射', [T_LINK], 'golive-core.js', 'for (const t of made) {', 'for (const t of []) {'),
  gm('J1：改发的修订不进关联映射的被答复修订', [T_LINK], 'golive-core.js', "links.push({ kind: 'reissued', task_id: t.task_id, revision_id: ins.lastID, party_id: t.party_id, replied_revision_id: prev.id });", "links.push({ kind: 'reissued', task_id: t.task_id, revision_id: ins.lastID, party_id: t.party_id, replied_revision_id: null });"),
  gm('J1：新建任务的被答复修订恒为空', [T_LINK], 'golive-core.js', 'replied_revision_id: mine.length > 0 ? Math.max(...mine) : null });', 'replied_revision_id: null });'),
  gm('J1：映射解析不认答复事件编号（取最近一次答复）', [T_LINK], 'golive-core.js', 'const linked = replies.find((r) => r.event_id === linkEventId);', 'const linked = replies[replies.length - 1];'),
  // C6b 残余⑦：回退层改为沿同一任务的修订链继承（replyByTaskChain），取代 C6a 的「按需求部门找最近一条不认可修订」；原 J1 三条回退变异随旧实现一并替换
  { id: 'C6b 残余⑦：回退链按需求部门跨任务找上一条修订（旧一轮的答复挂到新一轮任务的第一条修订上）', expect: [T_CHAIN], edits: [
    // 注意：to 里不能出现单引号（原文这一处是单引号字面量），所以不按 object_type 限定，只按登记编号 + 同一需求部门找「编号更小的最近一条」修订（跨任务）
    { file: 'golive-core.js', from: "SELECT id FROM sysbuild_confirm_task_revisions WHERE task_id = ? AND rev_no = ?', [taskId, cur.rev_no - 1]);", to: "SELECT r.id AS id FROM sysbuild_confirm_task_revisions r JOIN sysbuild_confirm_tasks t ON t.id = r.task_id WHERE t.object_id = ? AND t.party_id = (SELECT party_id FROM sysbuild_confirm_tasks WHERE id = ?) AND r.id < ? ORDER BY r.id DESC LIMIT 1', [entryId, taskId, revisionId]);" },
  ] },
  gm_b('残余⑦：回退链取任务第一条修订的结果（不取上一条）', [T_CHAIN, T_LINK], 'golive-core.js', "WHERE task_id = ? AND rev_no = ?', [taskId, cur.rev_no - 1]);", "WHERE task_id = ? AND rev_no = ? AND ? > 1', [taskId, 1, cur.rev_no]);"), // 第一条修订自己不再往前找（否则自指递归死循环）
  gm_b('残余⑦：回退链只支持第二条修订（不递归到更早的修订）', [T_CHAIN], 'golive-core.js', "WHERE task_id = ? AND rev_no = ?', [taskId, cur.rev_no - 1]);", "WHERE task_id = ? AND rev_no = ? AND ? < 3', [taskId, cur.rev_no - 1, cur.rev_no]);"),
  gm_b('残余⑦：回退不继承（手工改发的修订一律没有答复）', [T_LINK, T_CHAIN], 'golive-core.js', 'if (prev === null) return replyByTaskChain(q, entryId, taskId, revisionId, replies);', 'if (prev === null) return null;'),
  // ── 修订批 7（P179：导入上线按 golive 类核项目状态；LOW-3：已有上线事件先于交接闸门）──
  gm('P179：导入上线不按 golive 类核项目状态', [T_PAUSE], 'history.js', 'if (gb) throw makeError(gb.status, gb.code, gb.message);', ''),
  gm('P179：导入上线的 golive 类判定读成 maintain', [T_PAUSE], 'rules.js', "return projectAllowsWrite(projectStatus, 'golive') ? null :", "return projectAllowsWrite(projectStatus, 'maintain') ? null :"),
  gm('P179：actions 导入上线标志不看 golive 类', [T_PAUSE], 'rules.js', ' && goliveImportProjectBlock(project.status) === null,', ','),
  gm('P179：只在 golive 导入时才核（其他类事实也被挡）', [T_PAUSE], 'history.js', "if (factType === 'golive') {\n        const gb", "if (true) {\n        const gb"),
  { id: 'C6a LOW-3：已有上线事件检查放在交接闸门之后', expect: [T_ORDER], edits: [
    { file: 'history.js', from: "    const any = await q.get('SELECT id, created_at FROM sysbuild_golive_events WHERE batch_id = ? LIMIT 1', [batch.id]);\n    if (any) return { block: `该批已有上线事件（${String(any.created_at).slice(0, 10)}，已走过普通上线路径或已导入过），不能导入` };\n", to: '' },
    { file: 'history.js', from: '    if (other) return { block: `${other.message}，须先清完（与普通上线同一道交接闸门）再导入上线事件` };\n', to: '    if (other) return { block: `${other.message}，须先清完（与普通上线同一道交接闸门）再导入上线事件` };\n    const any = await q.get(\'SELECT id, created_at FROM sysbuild_golive_events WHERE batch_id = ? LIMIT 1\', [batch.id]);\n    if (any) return { block: `该批已有上线事件（${String(any.created_at).slice(0, 10)}，已走过普通上线路径或已导入过），不能导入` };\n' },
  ] },
  // ── plan.js closePackageRequirement（对拍）──
  gm('收口依赖包表漏 p_closing', ['C4b 历史 导入 节点 依赖包'], 'plan.js', "if (node.template_key === 'p_closing') return { type: 'closing', batchId: null, label: '结项包' };", ''),
];

module.exports = { defineGoliveCases, GOLIVE_MUTATIONS };
