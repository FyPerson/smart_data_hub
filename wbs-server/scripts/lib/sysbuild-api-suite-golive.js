// 验证脚本库：项目管理（系统建设记录）模块 C6a——统一上线判据、批次验收包与结项包的提交、上线前置读接口、确认试运行结束（上线 / 再上线）、撤销上线、
//   整体结项（p_closing 收口）与项目重开的用例与变异（#212 C4 删上线交接：交接集合与交接确认的用例与变异随之退役）
//   方案：docs/local/系统建设记录/系统建设记录_平台集成_方案_20261107_v1.5.md §2.2 :425、§2.3 :442–443、§3.2 :465–469、§4.5 :755–806、§5.2 :855–857、§7 :991
//   派单：docs/local/系统建设记录/送审准备/C6_C6a_上线交接结项_派单_20261107.md（§10 测试清单与本文件的 T_* 常量逐项对应）
//
// 本文件只放用例与变异，由 sysbuild-api-suite.js 登记（同一套夹具、同一个变异自检）。期望值一律手写，不取自被测代码。
// 夹具规则：建项、登记、办理动作、内容包提交与确认、节点开始 / 收口、上线 / 撤销全部走生产端点。只有这几类直接写库：
//   ① 需求方参与方、成员、任职、授权（H.seedParty / addMember）；② 附件行（暂存）；③ 第二批次（#212 C7：条目集合修订随需求条目流程删除，不再有承诺到批次的条目夹具）；④ 时间校准：上线事件 created_at、结项包 effective_at 回拨 / 前移
//   （「已正式上线」要求当前时刻严格晚于事件时刻，生产端点只会写出此刻的时间戳，用例不能靠墙钟，也不 sleep）；⑤ 批次 / 项目状态的少数边界（暂停、已结项、冻结批次）。
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const P = 'C6a 上线：';
const T_LIVE = `${P}统一上线判据`;
const T_HELPER = 'C6：批次上线判定助手——多批次、同批多事件、读取口径';
const T_C6_R35 = 'C6 R3 / R5：办理类登记不再挡节点收口与结项';
const T_PKG = `${P}批次验收包提交`;
const T_UAT = `${P}验收包生效后用户验收测试可收口`;
const T_EXCL = `${P}待确认互斥`;
const T_CPKG = `${P}结项包提交`;
const T_GB = `${P}读接口只留阻塞原因与动作标志`;
const T_GOLIVE = `${P}确认试运行结束`;
const T_REVOKE = `${P}撤销上线`;
const T_CLOSE = `${P}整体结项`;
const T_FLAGS = `${P}actions 同源`;
const T_RULES = `${P}rules`;
const T_CORE = `${P}纯函数`;
// 修订批 1（预筛 1 轮）
const T_STALE = `${P}上线前置核验验收包引用的现行规划`;
const T_PPEND = `${P}结项前置核验结项包引用的现行规划与待确认的内容包`;
const T_REOPEN = `${P}已结项重开要求结项节点已收口`;
// 修订批 2（预筛 2 轮）
const T_EFFECT = `${P}变更生效时重核已上线批次冻结`;

const OK_DATE = '2026-10-25';
// 通用确认任务的固定勾选文案（手写，与服务端常量逐字相等才算勾选）：各用途一律取这三条
const GENERIC_REJECT = '我已阅读以上全部内容，不认可（原因见下）';
const GENERIC_OBJECT = '我已阅读以上全部内容，对其有异议（原因见下）';
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
  const { newProject, stageAtt, mkPackage, mkPreparedVersion: mkVersion, tasksOf, confirmAll, produceEffectiveOverall, defaultBatchId, seedParty } = H;
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
    // L2 §10：本助手仅构造开工成功的前置，失败用例仍直接调用端点。
    await H.prepareDevStart(pid, id);
    const r = await post(U.pm, `/sysbuild/nodes/${id}/start`);
    assert.strictEqual(r.status, 200, r.text);
    return id;
  };
  const closeNodeReq = (nid) => post(U.pm, `/sysbuild/nodes/${nid}/close`);
  const batchRow = (bid) => sqlGet('SELECT * FROM sysbuild_batches WHERE id = ?', [bid]);
  const projStatus = async (pid) => (await sqlGet('SELECT status FROM sysbuild_projects WHERE id = ?', [pid])).status;
  const setStatus = (pid, to) => post(U.admin, `/sysbuild/projects/${pid}/status`, { to, reason: '上线用例' });
  const goliveReq = (uid, bid, body) => post(uid, `/sysbuild/batches/${bid}/golive`, body);
  const revokeReq = (uid, bid, body) => post(uid, `/sysbuild/batches/${bid}/revoke-golive`, body);
  const handoverGet = async (uid, bid) => {
    const r = await get(uid, `/sysbuild/batches/${bid}/handover`);
    assert.strictEqual(r.status, 200, r.text);
    const { batch, blockers, actions, completion_candidates } = r.body;
    return { batch, blockers, actions, completion_candidates };
  };
  const eventsAll = (bid) => sqlAll('SELECT * FROM sysbuild_golive_events WHERE batch_id = ? ORDER BY id', [bid]);
  const backdate = (eventId, offset) => sqlRun("UPDATE sysbuild_golive_events SET created_at = datetime('now','localtime', ?) WHERE id = ?", [offset || '-1 hour', eventId]);
  // 上线事件夹具（只用于造「未来时刻 / 多批次」这类生产端点写不出的事件；时刻相对真实时间）
  async function goliveFx(batch, kind, offset) {
    const r = await sqlRun(
      "INSERT INTO sysbuild_golive_events (batch_id, kind, reason, created_by, created_at) VALUES (?, ?, ?, ?, datetime('now','localtime',?))",
      [batch, kind, kind === 'revoke' ? '撤销上线（用例夹具）' : null, U.pm, offset]
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
  const detail = async (uid, eid) => {
    const r = await get(uid, `/sysbuild/entries/${eid}`);
    assert.strictEqual(r.status, 200, r.text);
    return r.body.entry;
  };

  // 标准场景：总体规划已经生产路径生效（甲部 own / del，默认批次 batch1 进行中），可选乙部（x1 / x2）、第二批次（夹具）、甲部一般成员 m1。
  async function mkPlan(opts) {
    const o = opts || {};
    const pid = await newProject(o.buildType);
    const batch1 = await defaultBatchId(pid);
    let extraNodeId = null;
    if (o.extraNode) {
      const added = await post(U.pm, `/sysbuild/batches/${batch1}/nodes`, { name: '补充核对阶段', g_stage: 'G1' });
      assert.strictEqual(added.status, 201, added.text);
      extraNodeId = added.body.node.id;
    }
    const eff = await produceEffectiveOverall(pid);
    const A = eff.party;
    const B = o.partyB ? (await seedParty(pid, '乙部', U.x1, U.x2)).party : null;
    const batch2 = o.batch2 ? (await sqlRun("INSERT INTO sysbuild_batches (project_id, seq, name, is_default, status) VALUES (?, 2, '第 2 批', 0, ?)", [pid, o.batch2 === true ? 'planning' : o.batch2])).lastID : null;
    if (o.m1) await addMember(pid, U.m1, { party: A });
    return { pid, eff, A, B, batch1, batch2, extraNodeId };
  }
  // 经生产路径让 s.batch1 满足上线前置（批次验收包生效 + 本批节点收口），返回验收包
  const ready = async (s) => {
    const result = await H.readyForGolive(s.pid, s.batch1);
    await H.prepareAdditionalClosingCards(s.pid);
    return result;
  };
  // 经生产路径上线并把事件回拨成「已正式上线」
  const goLive = (s, offset) => H.productionGolive(s.batch1, offset);


  // ═══════════════════════ 1 统一上线判据（§1）═══════════════════════
  test(`${T_LIVE}——批次「是否已正式上线」只有一个判定助手（entries-core.batchLiveState）：最后一条事件是 golive / regolive 且当前时刻**严格晚于**事件时刻（同一秒算未上线，P106）；撤销后批次视图回到未上线（变更集合重核已随 C5 删除，总体规划包提交时的已上线批次承诺集合冻结已随 #212 C7 删除）`, async () => {
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
    // ② 批次视图同口径（生产路径上线 / 撤销 / 再上线）：读 GET /projects/:pid/plan 的 batches[].live / last_golive_event（C6：分流的登记探测随 R4 删除，读出口换成批次视图）——
    //   没有事件 = 未上线；事件时刻不早于当前（回拨到未来）= 未上线；回拨到过去 = 已上线；撤销后 = 未上线；再上线（regolive）= 已上线
    const s = await mkPlan();
    const batchView = async () => (await get(U.pm, `/sysbuild/projects/${s.pid}/plan`)).body.batches.find((b) => b.id === s.batch1);
    assert.deepStrictEqual([(await batchView()).live, (await batchView()).last_golive_event], [false, null], '没有上线事件：视图判未上线');
    await ready(s);
    const g1 = await H.productionGolive(s.batch1, '+1 hour'); // 事件时刻在一小时后：当前时刻不晚于它 = 未上线（批次状态已是 live）
    assert.strictEqual((await batchRow(s.batch1)).status, 'live', '批次状态随上线维护');
    assert.strictEqual((await batchView()).live, false, '事件时刻在未来：视图判未上线');
    await backdate(g1.golive_event.id, '-1 hour');
    const v1 = await batchView();
    assert.strictEqual(v1.live, true, '事件时刻在过去：视图判已上线');
    assert.deepStrictEqual([v1.last_golive_event.kind, v1.last_golive_event.id], ['golive', g1.golive_event.id], '最后一条事件 = 首次上线');
    await H.productionRevoke(s.batch1, '撤销后视图回到未上线');
    const v2 = await batchView();
    assert.strictEqual(v2.live, false, '撤销后：视图判未上线');
    assert.strictEqual(v2.last_golive_event.kind, 'revoke');
    // 上线 → 撤销 → 再上线：GET /plan 的 last_golive_event 是 8 键对象（golive-core.js:59 的 id / kind / at / by / by_name / reason，加 goliveEventView 补的 attachment_ids / attachments），不写成两键对象；goLive 默认把事件回拨一小时，保证读取时刻严格晚于事件
    const g2 = await goLive(s);
    assert.strictEqual(g2.golive_event.kind, 'regolive');
    const v3 = await batchView();
    assert.deepStrictEqual([v3.last_golive_event.kind, v3.last_golive_event.id, v3.live], ['regolive', g2.golive_event.id, true], '再上线：事件 = regolive 那条、live 为真');
    // 键集合字面量全等（排序后比；主会话裁定：清单 4.3 写的「六键」有误，产品自 <S> 起就是 8 键，基线 golive 套件已断言过 attachment_ids / attachments）
    assert.deepStrictEqual(Object.keys(v3.last_golive_event).sort(), ['at', 'attachment_ids', 'attachments', 'by', 'by_name', 'id', 'kind', 'reason'], 'last_golive_event 恰 8 键');
  });

  // ═══════════════════════ 1b 批次上线判定助手（C6 新增；接替整删的 routing.js:204 经登记探测的上线事件有效性，变异 M1094–M1097 改挂）═══════════════════════
  //   纯函数夹具补三项（真实库里的事件、真实 SQL，假 q 看不出 SQL 层的批次限定与取最新一条）：另一批次的撤销 / 上线事件不干扰、同批多事件取编号最大的一条、now_at 严格晚于事件时刻才算已上线。
  //   不设「登记时刻 T0」格：batchLiveState(q, batchId) 没有截止时刻参数，now_at 由 SQL 的 datetime('now','localtime') 取（CA1l L-5）。
  test(`${T_HELPER}——批次 A 的事件（上线 → 撤销）与批次 B 的事件（上线 → 撤销 → 再上线）交错写入：A 取自己最后一条（撤销 → 未上线），B 取自己编号最大的一条（再上线 → 已上线），互不干扰；事件时刻在未来不算已上线（精确同秒由「统一上线判据」的假查询覆盖）；编号大而时刻早的再上线事件仍取编号最大的一条`, async () => {
    const ec = require(path.join(modDir(), 'entries-core.js'));
    const q = { get: (sql, params) => sqlGet(sql, params) };
    const s = await mkPlan({ batch2: true });
    // 交错插入：A1 上线（-3h）、B1 上线（-3h）、A2 撤销（-2h）、B2 撤销（-2h）、B3 再上线（-1h）——编号递增，A 的最后一条是撤销，B 的最后一条是再上线
    const a1 = await goliveFx(s.batch1, 'golive', '-3 hour');
    const b1 = await goliveFx(s.batch2, 'golive', '-3 hour');
    const a2 = await goliveFx(s.batch1, 'revoke', '-2 hour');
    const b2 = await goliveFx(s.batch2, 'revoke', '-2 hour');
    const b3 = await goliveFx(s.batch2, 'regolive', '-1 hour');
    const REC = {};
    REC.A = await ec.batchLiveState(q, s.batch1);
    REC.B = await ec.batchLiveState(q, s.batch2);
    // 事件时刻在未来：另造一个批次，只有一条事件（同一秒的格不在这里，见标题）
    const bFuture = (await sqlRun("INSERT INTO sysbuild_batches (project_id, seq, name, is_default, status) VALUES (?, 3, '第 3 批', 0, 'planning')", [s.pid])).lastID;
    await goliveFx(bFuture, 'golive', '+1 hour');
    REC.future = await ec.batchLiveState(q, bFuture);
    REC.none = await ec.batchLiveState(q, 99999999);
    // 193-M4：编号大、时刻早——批次 C 先写撤销（-1h），再写再上线（-2h）：按编号取最新是再上线（已上线），按时刻取最新会是撤销（未上线）
    const bC = (await sqlRun("INSERT INTO sysbuild_batches (project_id, seq, name, is_default, status) VALUES (?, 4, '第 4 批', 0, 'planning')", [s.pid])).lastID;
    const c1 = await goliveFx(bC, 'revoke', '-1 hour');
    const c2 = await goliveFx(bC, 'regolive', '-2 hour');
    REC.C = await ec.batchLiveState(q, bC);
    const fails = [];
    const chk = (label, fn) => { try { fn(); } catch (e) { fails.push(`[${label}] ${String(e.message).split('\n')[0].slice(0, 300)}`); } };
    chk('批次 A：取自己编号最大的一条（撤销），未上线，不受 B 的后续事件干扰', () => { assert.deepStrictEqual([REC.A.last.id, REC.A.last.kind, REC.A.live], [a2, 'revoke', false]); });
    chk('批次 B：同批多事件取编号最大的一条（再上线），已上线（不是最早的上线，也不是中间的撤销）', () => { assert.deepStrictEqual([REC.B.last.id, REC.B.last.kind, REC.B.live], [b3, 'regolive', true]); });
    chk('事件时刻在未来：未上线（现在不晚于事件时刻）', () => { assert.strictEqual(REC.future.live, false); assert.strictEqual(REC.future.last.kind, 'golive'); });
    chk('批次 C：编号大、时刻早的再上线（-2h）压过编号小、时刻晚的撤销（-1h）——取编号最大的一条，已上线', () => { assert.ok(c1 < c2, '夹具前提：再上线编号更大'); assert.deepStrictEqual([REC.C.last.id, REC.C.last.kind, REC.C.live], [c2, 'regolive', true]); });
    chk('没有事件：{ last: null, live: false }', () => { assert.deepStrictEqual(REC.none, { last: null, live: false }); });
    chk('夹具前提：编号递增交错', () => { assert.ok(a1 < b1 && b1 < a2 && a2 < b2 && b2 < b3); });
    assert.strictEqual(fails.length, 0, fails.join(' ‖ '));
  });

  // ═══════════════════════ 3 批次验收包提交（§2）═══════════════════════
  test(`${T_PKG}——批次进行中才可提交，读写同源；每个需求部门的负责人确认，领导知悉；父总体版本取提交时现行版本；生效不形成基线或推进批次`, async () => {
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
    // ② 进行中：成功。批次验收由甲、乙每个需求部门的负责人分别确认。
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
    // 需求确认单导出对验收包不报错（标题 / 类型用中文名「批次验收包」，没有计划快照段）
    const sheet = await get(U.pm, `/sysbuild/package-versions/${pv}/confirmation-sheet`);
    assert.strictEqual(sheet.status, 200, String(sheet.text).slice(0, 200));
    assert.ok(sheet.text.includes('批次验收包') && !sheet.text.includes('节点计划快照'), '确认单写中文类型名、不带计划快照段');
    const tasks = await tasksOf(pv);
    assert.deepStrictEqual(tasks.map((t) => t.user_id).sort((a, b) => a - b), [U.del, U.x2].sort((a, b) => a - b), '必需确认人：每个需求部门的负责人');
    assert.ok(tasks.every((t) => t.purpose === 'package_confirm'));
    assert.deepStrictEqual(tasks.map((t) => t.party_id).sort((a, b) => a - b), [s.A, s.B].sort((a, b) => a - b));
    const noticeRows = await sqlAll("SELECT ref_id, recipient_user_id FROM sysbuild_send_intents WHERE purpose = 'leader_confirmation_notice' AND ref_id IN (?, ?) ORDER BY id", tasks.map((t) => t.rev_id));
    assert.deepStrictEqual(noticeRows.map((row) => [row.ref_id, row.recipient_user_id]), [[tasks[0].rev_id, U.own], [tasks[1].rev_id, U.x1]]);
    assert.strictEqual((await sqlGet('SELECT parent_overall_version_id AS p FROM sysbuild_package_versions WHERE id = ?', [pv])).p, s.eff.pv, '提交时 parent 按现行版本重写');
    const ev = (await payloads(s.pid, 'package_version_submitted')).filter((p) => p.type === 'batch_accept');
    assert.strictEqual(ev.length, 1);
    assert.deepStrictEqual([ev[0].parent_from, ev[0].parent_to], [staleOv, s.eff.pv], '事件记下 parent 的重写');
    await confirmAll(pv);
    assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id = ?', [pv])).status, 'effective');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_node_schedule_records r JOIN sysbuild_nodes n ON n.id = r.node_id WHERE n.project_id = ? AND r.kind = 'baseline'", [s.pid]), baselinesBefore, '生效不形成基线');
    assert.strictEqual((await batchRow(s.batch1)).status, 'active', '生效不推进批次');
    assert.strictEqual((await eventsOf(s.pid, 'package_version_effective')).filter((e) => JSON.parse(e.payload_json).package_id === pk).length, 1);
    // ③ 批次状态：已上线 409（第二个草稿版本；状态直接改库）
    const pv2 = await mkVersion(pk);
    const sub2 = (status, extra) => sqlRun(`UPDATE sysbuild_batches SET status = ?${extra || ''} WHERE id = ?`, [status, s.batch1]);
    await sub2('live');
    const rl = await post(U.pm, `/sysbuild/package-versions/${pv2}/submit`);
    expectErr(rl, 409, 'SYSBUILD_STATE', '批次已上线');
    assert.ok(rl.body.message.includes('批次已正式上线，不能再提交批次验收'), rl.body.message);
    assert.strictEqual((await get(U.pm, `/sysbuild/package-versions/${pv2}`)).body.actions.submit, false);
    await sub2('active');
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${pv2}/submit`)).status, 200, '对照：批次恢复进行中后可提交');
    // ④ 缺生效负责人：乙部只有负责人
    const s3 = await mkPlan();
    await seedParty(s3.pid, '乙部', U.x1, null);
    const pv3 = await mkVersion(await mkPackage(s3.pid, 'batch_accept', s3.batch1));
    const r3 = await post(U.pm, `/sysbuild/package-versions/${pv3}/submit`);
    expectErr(r3, 409, 'SYSBUILD_STATE', '缺代表人');
    assert.strictEqual(r3.body.message, '以下参与方缺少必需确认人：乙部（缺生效负责人）');
    assert.strictEqual((await tasksOf(pv3)).length, 0, '被拒不生成任务');
  });

  test(`${T_UAT}——普通验收阶段先完成，独立发起验收确认后即可上线`, async () => {
    const s = await mkPlan({ buildType: 'outsource' });
    const uat = await startNode(s.pid, 'b_uat');
    const ok = await closeNodeReq(uat);
    assert.strictEqual(ok.status, 200, ok.text);
    assert.strictEqual((await nodeRow(uat)).status, 'closed');
    const denied = await goliveReq(U.pm, s.batch1);
    expectErr(denied, 409, 'SYSBUILD_GOLIVE_BLOCKED');
    assert.deepStrictEqual(denied.body.blockers.map((blocker) => blocker.code), ['ACCEPT_NOT_EFFECTIVE']);
    await H.acceptEffective(s.pid, s.batch1);
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
  // 取证（C5）：去掉变更包后，三类包两两组合在 rules.js 互斥判定之前都先被别的前置挡下，互斥分支只能由夹具直接造待确认版本命中（生效清单 4.3 第 16 条）。
  //   G1–G3 = 阻塞方夹具待确认版本 × 被阻塞方 HTTP 提交；每组四项：409 逐字文案、被阻塞方 actions.submit 为假、对夹具版本经通用撤回入口 200（真实撤回）、再提交 200。
  //   G4 = 立项包不在互斥范围（提交 200）。G8 = 待确认的结项包仍能阻塞总体规划包提交。
  //   先采集、后汇总：全部请求先发完记入 REC，之后逐项断言、各带标签。变异下某组「首次提交」已成功（M1576 / M1520）时，只跳过「再提交」，撤回阻塞方照做，保证后续各组前置不变。
  test(`${T_EXCL}——C5（N-EXCL）：总体规划 / 批次验收 / 结项三类包同一项目同一时刻最多一个版本待确认：任一待确认时其余提交 409「已有待确认的内容包：<类型>，须先撤回或等确认完成」逐字、提交标志同源为假；经通用撤回入口真实撤回阻塞方后放行；立项包不在互斥范围`, async () => {
    const wd = (vid) => post(U.pm, `/sysbuild/package-versions/${vid}/withdraw`, { reason: '互斥用例撤回' });
    const sub = (vid) => post(U.pm, `/sysbuild/package-versions/${vid}/submit`);
    const MSG = (zh) => `已有待确认的内容包：${zh}，须先撤回或等确认完成`;
    const subFlag = async (vid) => (await get(U.pm, `/sysbuild/package-versions/${vid}`)).body.actions.submit;
    const pendingTypes = async (pid) => (await sqlAll("SELECT p.type AS t FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id WHERE p.project_id = ? AND v.status = 'pending'", [pid])).map((x) => x.t);
    const insertPending = async (pk, no, form) => (await sqlRun("INSERT INTO sysbuild_package_versions (package_id, version_no, form, status, snapshot_json, created_by) VALUES (?, ?, ?, 'pending', '{}', ?)", [pk, no, form, U.pm])).lastID;
    async function flow(rec, blocked, blockerVid) {
      rec.flag = await subFlag(blocked); rec.first = await sub(blocked); rec.firstOk = rec.first.status === 200;
      rec.wdBlocker = await wd(blockerVid);
      rec.second = rec.firstOk ? null : await sub(blocked);
    }
    const REC = { G1: {}, G2: {}, G3: {}, G4: {}, G8: {} };
    // G1–G4 共用一个项目与批次验收包 accPk（所以撤回阻塞方保证后续组的前置不变）
    const s = await mkPlan();
    const accPk = await mkPackage(s.pid, 'batch_accept', s.batch1);
    const accV1 = await mkVersion(accPk);
    const clPk = await mkPackage(s.pid, 'closing');
    const clV1 = await mkVersion(clPk);
    // G1：结项包草稿夹具置待确认 → 提交批次验收包
    await sqlRun("UPDATE sysbuild_package_versions SET status = 'pending' WHERE id = ?", [clV1]);
    await flow(REC.G1, accV1, clV1);
    // G2：总体规划包夹具待确认版本（version_no 97）→ 提交批次验收包新草稿 accV2（accV1 先经通用撤回退位）；再 confirmAll 生效
    REC.G2.wdAcc = await wd(accV1);
    const accV2 = await mkVersion(accPk);
    const ov97 = await insertPending(s.eff.pk, 97, 'overall');
    await flow(REC.G2, accV2, ov97);
    REC.G2.confirm = await confirmAll(accV2);
    // 批次验收包生效 → 本批节点收口 → 正式上线
    await H.closeBatchNodes(s.pid, s.batch1);
    await goLive(s);
    await H.prepareAdditionalClosingCards(s.pid);
    // G3：批次上线后，批次验收包新草稿 accV3 夹具置待确认（正常入口此时不能再提交验收）→ 提交结项包新草稿 clV2（结项包 clV1 已被 G1 撤回）
    const accV3 = await mkVersion(accPk);
    await sqlRun("UPDATE sysbuild_package_versions SET status = 'pending' WHERE id = ?", [accV3]);
    const clV2 = await mkVersion(clPk);
    await flow(REC.G3, clV2, accV3);
    // G4：总体规划包再插一条待确认版本（version_no 96）→ 立项包草稿提交 200（M1522 的载体）
    await insertPending(s.eff.pk, 96, 'overall');
    const iniV = await mkVersion((await sqlGet("SELECT id FROM sysbuild_packages WHERE project_id = ? AND type = 'initiation'", [s.pid])).id);
    await H.declareInitiationBasis(iniV);
    REC.G4.submit = await sub(iniV);
    async function overallDraftProject() {
      const pid = await newProject();
      await seedParty(pid, '甲部', U.own, U.del);
      await H.seedEffectiveInitiation(pid);
      const vid = await mkVersion(await mkPackage(pid, 'overall'));
      await H.planAllNodes(pid);
      return { pid, vid };
    }
    const p8 = await overallDraftProject();
    await insertPending(await mkPackage(p8.pid, 'closing'), 1, null);
    REC.G8.types = await pendingTypes(p8.pid); REC.G8.flag = await subFlag(p8.vid); REC.G8.submit = await sub(p8.vid);
    // ── 汇总 ──
    const fails = [];
    const chk = (label, fn) => { try { fn(); } catch (e) { fails.push(`[${label}] ${String(e.message).split('\n')[0].slice(0, 300)}`); } };
    for (const [g, zh] of [['G1', '结项'], ['G2', '总体规划'], ['G3', '批次验收']]) {
      const r = REC[g];
      chk(`N-EXCL-${g}-标志`, () => assert.strictEqual(r.flag, false, `${g} 被阻塞方提交标志（提交前）同源为假`));
      chk(`N-EXCL-${g}-首次提交`, () => { expectErr(r.first, 409, 'SYSBUILD_STATE', `${g} 首次提交（预期 409）`); assert.strictEqual(r.first.body.message, MSG(zh), `${g} 逐字文案`); });
      chk(`N-EXCL-${g}-撤回阻塞方`, () => assert.strictEqual(r.wdBlocker.status, 200, `${g} 经通用撤回入口真实撤回阻塞方 ${r.wdBlocker.text}`));
      chk(`N-EXCL-${g}-再提交`, () => assert.ok(r.firstOk || (r.second && r.second.status === 200), `${g} 撤回后再提交 200：${r.second ? r.second.text : '未再提交'}`)); // 首次提交已成功（变异下）时只跳过「再提交」
    }
    chk('N-EXCL-G2 前置与生效', () => { assert.strictEqual(REC.G2.wdAcc.status, 200, 'accV1 经通用撤回退位'); assert.strictEqual(REC.G2.confirm && REC.G2.confirm.body.effective, true, 'accV2 全部确认后生效'); });
    chk('N-EXCL-G4', () => assert.strictEqual(REC.G4.submit.status, 200, `立项包不在互斥范围，提交 200 ${REC.G4.submit.text}`));

    chk('N-EXCL-G8', () => {
      assert.deepStrictEqual(REC.G8.types, ['closing'], '前置：项目里只有结项包一个 pending 版本');
      assert.strictEqual(REC.G8.flag, false, '提交标志为假');
      expectErr(REC.G8.submit, 409, 'SYSBUILD_STATE', 'G8'); assert.strictEqual(REC.G8.submit.body.message, MSG('结项'), '保留类型的互斥对总体规划包同样成立');
    });
    assert.strictEqual(fails.length, 0, fails.join(' ‖ ')); // 单行：变异记录只保留失败信息首行，各标签都要在这一行里
  });

  // ═══════════════════════ 5 结项包提交（§2）═══════════════════════
  test(`${T_CPKG}——结项包：确认人 = 每个需求部门的生效代表人各一条（不含负责人）；提交前置 = 每个有效批次已正式上线（未上线 409 并列出批次）；缺代表人拒绝并列出参与方；父总体版本取现行版本（建草稿与提交都重写）；草稿期间 parent 过期不拒绝`, async () => {
    const s = await mkPlan({ partyB: true });
    const clPk = await mkPackage(s.pid, 'closing');
    const clV = await mkVersion(clPk);
    assert.strictEqual((await sqlGet('SELECT parent_overall_version_id AS p FROM sysbuild_package_versions WHERE id = ?', [clV])).p, s.eff.pv, '建草稿：parent = 现行总体版本');
    // ① 批次未上线：409，文案列出批次；标志同源为假
    const r0 = await post(U.pm, `/sysbuild/package-versions/${clV}/submit`);
    expectErr(r0, 409, 'SYSBUILD_STATE', '批次未上线');
    assert.strictEqual(r0.body.message, '不能提交结项：以下批次还没有正式上线：第 1 批');
    assert.strictEqual((await get(U.pm, `/sysbuild/package-versions/${clV}`)).body.actions.submit, false);
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
    const noticeRows = await sqlAll("SELECT ref_id, recipient_user_id FROM sysbuild_send_intents WHERE purpose = 'leader_confirmation_notice' AND ref_id IN (?, ?) ORDER BY id", tasks.map((t) => t.rev_id));
    assert.deepStrictEqual(noticeRows.map((row) => [row.ref_id, row.recipient_user_id]), [[tasks[0].rev_id, U.own], [tasks[1].rev_id, U.x1]]);
    assert.strictEqual((await sqlGet('SELECT parent_overall_version_id AS p FROM sysbuild_package_versions WHERE id = ?', [clV])).p, s.eff.pv, '提交时 parent 按现行版本重写');
    const ev = (await payloads(s.pid, 'package_version_submitted')).filter((p) => p.type === 'closing');
    assert.deepStrictEqual([ev[0].parent_from, ev[0].parent_to], [stale, s.eff.pv]);
    await confirmAll(clV);
    assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id = ?', [clV])).status, 'effective');
    // ③ 缺生效负责人：乙部只有负责人（结项包不要求负责人，所以文案只写缺代表人）
    const s2 = await mkPlan();
    await ready(s2);
    await H.productionGolive(s2.batch1);
    await seedParty(s2.pid, '乙部', U.x1, null); // 上线之后才有的需求部门，只有负责人（验收包提交时它还不存在）
    const v2 = await mkVersion(await mkPackage(s2.pid, 'closing'));
    const r2 = await post(U.pm, `/sysbuild/package-versions/${v2}/submit`);
    expectErr(r2, 409, 'SYSBUILD_STATE', '缺代表人');
    assert.strictEqual(r2.body.message, '以下参与方缺少必需确认人：乙部（缺生效负责人）');
  });

  // 4.3 第 6 条（C5-RC27 / RC29）：旧库遗留的待确认旧变更包版本（夹具直接写库，版本 6 结构）不再挡上线前置（(a)）与排期 / 取消（(b)），也不再挡新建需求部门参与方（(c) P35）；
  //   对照：同项目总体规划待确认（overall 包夹具 pending 版本）时 (a)(b) 仍拦、保留类型（立项包）待确认时 (c) 仍拦。(a) 独立项目；(b)(c) 共用一个项目，对照请求放在放行样本与 (c) 之后
  //   （给 overall 包 INSERT pending 版本会让同项目 (c) 的 POST /parties 先被 409，污染 (c)）。先采集、后汇总。
  test(`C8：排期、取消和 P35 的保留规则——(a) 有可选阶段仍可上线；(b) 排期与取消成功（读回）、对照 nS2 / nC2 在总体规划待确认时 409「排期已随包冻结」；(c) P35 标志含 demand 且 POST /parties 201（旧库遗留，C5-RC27）`, async () => {
    const REC = { a: {}, b: {}, c: {} };
    // (a) 独立项目：已确认验收，批次未完成普通阶段只列为可选。
    const sa = await mkPlan();
    await H.acceptEffective(sa.pid, sa.batch1);
    REC.a.handover = await get(U.pm, `/sysbuild/batches/${sa.batch1}/handover`);
    REC.a.golive = await goliveReq(U.pm, sa.batch1);
    REC.a.batchStatus = (await batchRow(sa.batch1)).status;
    // (b)(c) 共用项目
    const s = await mkPlan({ extraNode: true });
    const nid = (key) => nodeIdOf(s.pid, key);
    const nS = s.extraNodeId; const nS2 = await nid('b_dev');
    const addNode = async (name) => { const r = await post(U.pm, `/sysbuild/batches/${s.batch1}/nodes`, { name }); assert.strictEqual(r.status, 201, r.text); return (await sqlGet('SELECT id FROM sysbuild_nodes WHERE project_id = ? AND name = ?', [s.pid, name])).id; };
    const nC = await addNode('旧变更待确认期间取消的节点'); const nC2 = await addNode('总体规划待确认期间取消的对照节点');
    assert.strictEqual((await nodeRow(nC2)).status, 'not_started', '前置：nC2 未开始');
    const planNodes = async () => (await get(U.pm, `/sysbuild/projects/${s.pid}/plan`)).body.nodes;
    const nodesView = await planNodes();
    REC.b.flagS = nodesView.find((n) => n.id === nS).actions.schedule_plan; REC.b.flagC = nodesView.find((n) => n.id === nC).actions.cancel;
    const recsOf = (n) => sqlAll("SELECT planned_start, planned_end FROM sysbuild_node_schedule_records WHERE node_id = ? AND kind = 'plan_change' ORDER BY id", [n]);
    REC.b.recsBefore = await recsOf(nS);
    REC.b.sched = await post(U.pm, `/sysbuild/nodes/${nS}/schedule`, { kind: 'plan', planned_start: '2026-11-04', planned_end: '2026-11-27', reason: '顺延', no_written_evidence: true, no_evidence_reason: '口头电话确认了本次顺延安排' });
    REC.b.recsAfter = await recsOf(nS);
    REC.b.cancel = await post(U.pm, `/sysbuild/nodes/${nC}/cancel`, { reason: '旧变更待确认期间取消' });
    REC.b.cancelStatus = (await nodeRow(nC)).status;
    // (c) P35：先读标志，无论标志是否含 demand 都照常发请求
    REC.c.flagsBefore = (await get(U.pm, `/sysbuild/projects/${s.pid}`)).body.actions.party_sides;
    REC.c.req = await post(U.pm, `/sysbuild/projects/${s.pid}/parties`, { side: 'demand', name: '旧库遗留后新增的需求方', leader_user_id: U.fixtureLeader, representative_user_id: U.fixtureRepresentative });
    // 对照：总体规划待确认（夹具）→ 排期 nS2 与取消 nC2 同样两条请求得 409，文案逐字，并读回无写入
    await sqlRun("INSERT INTO sysbuild_package_versions (package_id, version_no, form, status, snapshot_json, created_by) VALUES (?, 97, 'overall', 'pending', '{}', ?)", [s.eff.pk, U.pm]);
    REC.b.s2Before = await recsOf(nS2);
    REC.b.ctlSched = await post(U.pm, `/sysbuild/nodes/${nS2}/schedule`, { kind: 'plan', planned_start: '2026-11-04', planned_end: '2026-11-27', reason: '顺延', no_written_evidence: true, no_evidence_reason: '口头电话确认了本次顺延安排' });
    REC.b.s2After = await recsOf(nS2);
    REC.b.ctlCancel = await post(U.pm, `/sysbuild/nodes/${nC2}/cancel`, { reason: '总体规划待确认期间取消' });
    REC.b.c2Status = (await nodeRow(nC2)).status;
    // ── 汇总 ──
    const fails = [];
    const chk = (label, fn) => { try { fn(); } catch (e) { fails.push(`[${label}] ${String(e.message).split('\n')[0].slice(0, 300)}`); } };
    chk('(a) 上线前置', () => {
      assert.strictEqual(REC.a.handover.status, 200, REC.a.handover.text);
      assert.deepStrictEqual(REC.a.handover.body.blockers, []);
      assert.ok(REC.a.handover.body.completion_candidates.length > 0);
      assert.strictEqual(REC.a.golive.status, 200, REC.a.golive.text);
      assert.deepStrictEqual(REC.a.golive.body.completed_node_ids, []);
      assert.strictEqual(REC.a.batchStatus, 'live');
    });
    chk('(b) 标志', () => assert.deepStrictEqual([REC.b.flagS, REC.b.flagC], [true, true], '未提交范围包时 nS 的 actions.schedule_plan 与 nC 的 actions.cancel 为真'));
    chk('(b) 排期成功与读回', () => {
      assert.strictEqual(REC.b.sched.status, 201, REC.b.sched.text);
      assert.strictEqual(REC.b.recsAfter.length, REC.b.recsBefore.length + 1, '新增一条 plan_change');
      assert.deepStrictEqual(REC.b.recsAfter[REC.b.recsAfter.length - 1], { planned_start: '2026-11-04', planned_end: '2026-11-27' }, '最新 plan_change 的起止 = 请求值');
    });
    chk('(b) 取消成功与读回', () => { assert.strictEqual(REC.b.cancel.status, 200, REC.b.cancel.text); assert.strictEqual(REC.b.cancelStatus, 'cancelled'); });
    chk('(b) 对照 nS2 排期', () => { expectErr(REC.b.ctlSched, 409, 'SYSBUILD_STATE', 'nS2'); assert.strictEqual(REC.b.ctlSched.body.message, '总体规划待确认中，排期已随包冻结；如需修改请撤回提交'); assert.deepStrictEqual(REC.b.s2After, REC.b.s2Before, 'nS2 排期记录条数不变'); });
    chk('(b) 对照 nC2 取消', () => { expectErr(REC.b.ctlCancel, 409, 'SYSBUILD_STATE', 'nC2'); assert.strictEqual(REC.b.ctlCancel.body.message, '总体规划待确认中，排期已随包冻结；如需修改请撤回提交'); assert.strictEqual(REC.b.c2Status, 'not_started', 'nC2 仍未开始'); });
    chk('(c) P35-标志', () => assert.ok(REC.c.flagsBefore.includes('demand'), `actions.party_sides 含 demand，实际 ${JSON.stringify(REC.c.flagsBefore)}`));
    chk('(c) P35-请求', () => assert.strictEqual(REC.c.req.status, 201, `POST /parties（side demand）201，不再得 409「有待确认的内容包」：${REC.c.req.status} ${REC.c.req.text}`));
    assert.strictEqual(fails.length, 0, fails.join(' ‖ ')); // 单行：变异记录只保留失败信息首行，各标签都要在这一行里
    // 对照（保留类型）：立项包待确认时 P35 仍拦（独立项目）
    const sc = await mkPlan();
    await sqlRun("INSERT INTO sysbuild_package_versions (package_id, version_no, form, status, snapshot_json, created_by) VALUES ((SELECT id FROM sysbuild_packages WHERE project_id = ? AND type = 'initiation'), 97, NULL, 'pending', '{}', ?)", [sc.pid, U.pm]);
    assert.ok(!(await get(U.pm, `/sysbuild/projects/${sc.pid}`)).body.actions.party_sides.includes('demand'), '对照：保留类型（立项包）待确认时 P35 标志为假');
    expectErr(await post(U.pm, `/sysbuild/projects/${sc.pid}/parties`, {
      side: 'demand', name: '立项包待确认期间的需求方', leader_user_id: U.fixtureLeader, representative_user_id: U.fixtureRepresentative,
    }), 409, 'SYSBUILD_STATE', '对照：保留类型待确认时 POST /parties 仍 409');
  });

  test(`C5：ACCEPT_STALE / CLOSING_STALE / PLAN_PENDING 新文案——三条冻结文案逐字（C5-RC10 / RC11；夹具造过期与待确认）`, async () => {
    const s = await mkPlan();
    await ready(s);
    {
      // PLAN_PENDING ① 读接口样本走正常入口（C5-RC11）：立项包生效 → 总体规划草稿 → 提交（待确认）→ GET /batches/:bid/handover（批次规划中，没有夹具）
      const pid = await newProject();
      await seedParty(pid, '甲部', U.own, U.del);
      await H.seedEffectiveInitiation(pid);
      const vid = await mkVersion(await mkPackage(pid, 'overall'));
      const bid = await defaultBatchId(pid);
      await H.planAllNodes(pid);
      assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${vid}/submit`)).status, 200, '正常入口提交总体规划包');
      const pp = (await handoverGet(U.pm, bid)).blockers.find((b) => b.code === 'PLAN_PENDING');
      assert.ok(pp, 'PLAN_PENDING ① 正常入口样本：读接口列出 PLAN_PENDING');
      assert.strictEqual(pp.message, '项目里有待确认的总体规划，须等确认完成或撤回后再上线', 'PLAN_PENDING ① 读接口样本（正常入口）逐字');
    }
    const pend = await pendingFx(s.pid, 'overall', 96);
    assert.strictEqual((await handoverGet(U.pm, s.batch1)).blockers[0].message, '项目里有待确认的总体规划，须等确认完成或撤回后再上线', 'PLAN_PENDING ① 读接口样本');
    const gl1 = await goliveReq(U.pm, s.batch1);
    expectErr(gl1, 409, 'SYSBUILD_GOLIVE_BLOCKED', 'PLAN_PENDING ② 上线 409 样本');
    assert.strictEqual(gl1.body.blockers[0].message, '项目里有待确认的总体规划，须等确认完成或撤回后再上线', 'PLAN_PENDING ② 上线 409 样本逐字');
    await sqlRun("UPDATE sysbuild_package_versions SET status = 'superseded' WHERE id = ?", [pend]);
    await bumpOverall(s.pid);
    assert.strictEqual((await handoverGet(U.pm, s.batch1)).blockers[0].message, '本批批次验收包引用的版本不是现行范围版本，须基于现行范围版本重新提交批次验收并确认', 'ACCEPT_STALE 交接读取路径');
    const gl2 = await goliveReq(U.pm, s.batch1);
    expectErr(gl2, 409, 'SYSBUILD_GOLIVE_BLOCKED', 'ACCEPT_STALE 上线 409 路径');
    assert.strictEqual(gl2.body.blockers[0].message, '本批批次验收包引用的版本不是现行范围版本，须基于现行范围版本重新提交批次验收并确认', 'ACCEPT_STALE 上线 409 路径逐字');
    const s2 = await mkPlan();
    await ready(s2);
    await goLive(s2, '-2 hours');
    const closingNode = await startNode(s2.pid, 'p_closing');
    const clV = await mkVersion(await mkPackage(s2.pid, 'closing'));
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${clV}/submit`)).status, 200);
    await confirmAll(clV);
    await bumpOverall(s2.pid);
    const r = await closeNodeReq(closingNode);
    expectErr(r, 409, 'SYSBUILD_CLOSE_BLOCKED', 'CLOSING_STALE 收口 409 路径的状态码与业务码');
    assert.strictEqual(r.body.blockers.find((b) => b.code === 'CLOSING_STALE').message, '结项包引用的版本不是现行范围版本，须基于现行范围版本重新提交结项包并确认', 'CLOSING_STALE 收口 409 路径');
    const planView = (await get(U.pm, `/sysbuild/projects/${s2.pid}/plan`)).body.nodes.find((n) => n.id === closingNode);
    assert.strictEqual(planView.close_blockers.find((b) => b.code === 'CLOSING_STALE').message, '结项包引用的版本不是现行范围版本，须基于现行范围版本重新提交结项包并确认', 'CLOSING_STALE GET /plan close_blockers 路径');
  });

  // ═══════════════════════ 9 上线前置读接口（P-GB A，#212 C4）═══════════════════════
  test(`${T_GB}——GET /batches/:bid/handover（C4 起只留上线前置阻塞原因与动作标志）：响应键只有 batch / blockers / actions（没有 items、summary）；访问权限与批次归属校验照旧（成员 / admin / 只读 / 负责人 / 代表人 200，非成员 / 另一项目的 PM / 批次不存在同形 404，编号非法 400）；只读不写浏览记录与事件；读写同源：阻塞项与上线 409 逐项一致；最近一次上线事件带凭据附件`, async () => {
    // 1 响应键集合（对拍旧版 OC1：顶层 batch / items / summary / blockers / actions，batch 六键，actions 两键）
    const s = await mkPlan({ m1: true });
    const g = await get(U.pm, `/sysbuild/batches/${s.batch1}/handover`);
    assert.strictEqual(g.status, 200, g.text);
    assert.deepStrictEqual(Object.keys(g.body).sort(), ['actions', 'batch', 'blockers', 'completion_candidates'], '响应顶层键含可选阶段');
    assert.deepStrictEqual(Object.keys(g.body.batch).sort(), ['id', 'last_golive_event', 'live', 'name', 'seq', 'status']);
    assert.deepStrictEqual(Object.keys(g.body.actions).sort(), ['golive', 'revoke_golive']);
    // 2 访问：成员 / admin / 只读 / 负责人 / 代表人 200；不属于本批的请求只有两类（现存但不可见的 bid、不存在的 bid），响应体逐字相同的 404
    for (const [uid, label] of [[U.m1, '一般成员'], [U.admin, 'admin'], [U.ro, '只读账号'], [U.own, '负责人'], [U.del, '代表人']]) {
      assert.strictEqual((await get(uid, `/sysbuild/batches/${s.batch1}/handover`)).status, 200, label);
    }
    const NOT_FOUND = { code: 'SYSBUILD_NOT_FOUND', message: '项目或附件不存在' };
    const p2 = await newProject('inhouse', U.m2); // 另一个项目 P2，PM 是 m2：它的成员身份不及于 s.pid 的批次（代码读法：loadBatchCtx 只做存在 / 取项目身份 / 可见三步，OC2 没采这一例）
    for (const [res, label] of [
      [await get(U.out, `/sysbuild/batches/${s.batch1}/handover`), '现存但不可见的 bid：无关账号（旧版 OC2-6）'],
      [await get(U.m2, `/sysbuild/batches/${s.batch1}/handover`), '现存但不可见的 bid：另一个项目的 PM'],
      [await get(U.pm, '/sysbuild/batches/99999999/handover'), '不存在的 bid（旧版 OC2-7）'],
      [await get(U.out, '/sysbuild/batches/99999999/handover'), '非成员请求不存在的 bid（旧版 OC2-12：不泄露批次是否存在）'],
    ]) {
      expectErr(res, 404, 'SYSBUILD_NOT_FOUND', label);
      assert.deepStrictEqual(res.body, NOT_FOUND, `${label}：响应体逐字相同`);
    }
    assert.deepStrictEqual([p2 !== s.pid, (await sqlGet('SELECT pm_user_id FROM sysbuild_projects WHERE id = ?', [p2])).pm_user_id], [true, U.m2], 'P2 不是本批所属项目、PM 是 m2（它的成员身份不及于 s.pid 的批次）');
    const bad = await get(U.pm, '/sysbuild/batches/abc/handover');
    expectErr(bad, 400, 'SYSBUILD_INVALID_INPUT', '编号非法');
    assert.deepStrictEqual(bad.body, { code: 'SYSBUILD_INVALID_INPUT', message: '批次编号不合法', field: 'bid' });
    // 3 读接口不写浏览记录与事件：计数对照放在第 4 项的登记前提成立之后（C4f，128 M3：旧 T_SET 在批次已有多条登记、拆分之后才查；这里改到批次有登记之后查，只在有登记时误写浏览记录 / 事件的回归才会被挡住）
    // 4 读写同源（同一身份 U.pm、同一批次、批次状态与登记在两次请求之间未变、合法请求）：GET 与 POST 409 的完整 blockers 逐项相同，再独立断言保留项字面量（两侧同错时比较仍会过）
    const s4 = await mkPlan({ m1: true, batch2: 'active', extraNode: true });
    const extraNodeId = s4.extraNodeId;
    const bDev = await nodeIdOf(s4.pid, 'b_dev');
    // RC10a：先登一条未办结登记。旧版同夹具多出一项 HANDOVER_UNCLEARED（OC3-13 同形），C4 后不再出现
    const eU = await regOk(U.pm, s4.pid, { type: 'feedback', title: '还没办完' });
    // 第 3 项（C4f）：eU 已登记在本批之后，两次计数之间只有一次读取（handoverGet 自带 200 断言）
    const viewsBefore = await countOf('SELECT COUNT(*) AS n FROM sysbuild_views', []);
    const evBefore = await countOf('SELECT COUNT(*) AS n FROM sysbuild_events WHERE project_id = ?', [s4.pid]);
    await handoverGet(U.own, s4.batch1);
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_views', []), viewsBefore, '读接口不写浏览记录（批次已有登记之后）');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_events WHERE project_id = ?', [s4.pid]), evBefore, '读接口不写项目事件（批次已有登记之后）');
    const g0 = await handoverGet(U.pm, s4.batch1);
    const r0 = await goliveReq(U.pm, s4.batch1);
    expectErr(r0, 409, 'SYSBUILD_GOLIVE_BLOCKED', '前置不满足');
    assert.deepStrictEqual(g0.blockers, r0.body.blockers, '读接口与上线 409 的完整 blockers（顺序、键、值、message）逐项一致');
    assert.strictEqual(g0.actions.golive, false);
    assert.deepStrictEqual(r0.body.blockers, [
      { code: 'ACCEPT_NOT_EFFECTIVE', message: '本批批次验收包还没有生效版本' },
    ], '只有验收前置，阶段列在可选清单');
    assert.deepStrictEqual(g0.completion_candidates.map((n) => n.id), [bDev, extraNodeId]);
    assert.strictEqual(r0.body.message, '上线前置条件未满足：本批批次验收包还没有生效版本');
    // 就绪后：blockers 为空、actions.golive 为真（eU 仍未办结）；随后发出同一次 POST golive（第 5 项的带凭据上线就是这一次，批次一经上线再发即 409）
    await ready(s4);
    const g1 = await handoverGet(U.pm, s4.batch1);
    assert.deepStrictEqual(g1.blockers, []);
    assert.strictEqual(g1.actions.golive, true);
    // 5 最近一次上线事件（凭据面板的数据来源）：上线带暂存附件，读回读接口，kind 与 attachment_ids / attachments 都在；撤销带另一个暂存附件后同样读回
    const att = await stageAtt(s4.pid, U.pm, 'c'); // 夹具暂存附件的 sha256 须是 64 位小写十六进制（库约束 length(sha256) = 64 AND NOT GLOB '*[^0-9a-f]*'），不能用 g
    const live = await goliveReq(U.pm, s4.batch1, { attachment_ids: [att] });
    assert.strictEqual(live.status, 200, live.text);
    // C4f（128 M5）：凭据面板（public/assets/js/sysbuild-plan.js:222 → sysbuild-evidence.js attachmentList）实际消费的附件字段：attachment_id（缺失 / 遮蔽 / 删除态的标题）、name（显示名）、mime_type 与 is_image（预览 / 下载分支）、
    //   size（KB 提示）、sha256（校验值）、missing / masked / masked_at / deleted / deleted_at（状态分支；预筛 LOW-3 补两个时间戳，期望都是 null）。夹具附件 stageAtt：原名「确认证据.txt」、text/plain、3 字节、非图片、sha256 = 传入字符重复 64 次。
    const panelFields = (a) => ({ attachment_id: a.attachment_id, name: a.name, mime_type: a.mime_type, is_image: a.is_image, size: a.size, sha256: a.sha256, missing: a.missing, masked: a.masked, masked_at: a.masked_at, deleted: a.deleted, deleted_at: a.deleted_at });
    const g2 = await handoverGet(U.pm, s4.batch1);
    assert.strictEqual(g2.batch.last_golive_event.kind, 'golive');
    assert.deepStrictEqual(g2.batch.last_golive_event.attachment_ids, [att]);
    assert.strictEqual(g2.batch.last_golive_event.attachments.length, 1, '凭据面板的 attachments 不能丢');
    assert.deepStrictEqual(panelFields(g2.batch.last_golive_event.attachments[0]), { attachment_id: att, name: '确认证据.txt', mime_type: 'text/plain', is_image: false, size: 3, sha256: 'c'.repeat(64), missing: false, masked: false, masked_at: null, deleted: false, deleted_at: null }, '上线事件的附件对象带凭据面板消费的字段');
    const att2 = await stageAtt(s4.pid, U.admin, 'd');
    const rv = await revokeReq(U.admin, s4.batch1, { reason: '撤销以核对读接口的凭据', attachment_ids: [att2] });
    assert.strictEqual(rv.status, 200, rv.text);
    const g3 = await handoverGet(U.pm, s4.batch1);
    assert.strictEqual(g3.batch.last_golive_event.kind, 'revoke');
    assert.deepStrictEqual(g3.batch.last_golive_event.attachment_ids, [att2]);
    assert.strictEqual(g3.batch.last_golive_event.attachments.length, 1);
    assert.deepStrictEqual(panelFields(g3.batch.last_golive_event.attachments[0]), { attachment_id: att2, name: '确认证据.txt', mime_type: 'text/plain', is_image: false, size: 3, sha256: 'd'.repeat(64), missing: false, masked: false, masked_at: null, deleted: false, deleted_at: null }, '撤销事件的附件对象带凭据面板消费的字段');
  });

  // ═══════════════════════ 10 确认试运行结束（上线 / 再上线）═══════════════════════
  test(`${T_GOLIVE}——POST /batches/:bid/golive：PM；前置在写事务内按当时状态重核（本批非里程碑节点全部收口、批次验收包已生效；任一不满足 409 SYSBUILD_GOLIVE_BLOCKED 并列出每一项）；暂停 / 终止 409；非 PM 403；成功写上线事件（交接快照列固定写空数组文本）、批次 → 已上线、里程碑 → 已收口并写实际结束；再上线 kind = regolive`, async () => {
    const s = await mkPlan({ m1: true, batch2: 'active', extraNode: true });
    const extraNodeId = s.extraNodeId;
    const bDev = await nodeIdOf(s.pid, 'b_dev');
    const bGolive = await nodeIdOf(s.pid, 'b_golive');
    // ① 前置：节点未收口 + 验收包未生效（两项都列出，带节点编号与节点名）
    //   被拒不留痕（C4f，129 M2，取自旧 T_GATE：请求前后各读一次）：请求前批次 active、该批上线事件 0 条
    assert.strictEqual((await batchRow(s.batch1)).status, 'active', '前置：请求前批次 active');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_golive_events WHERE batch_id = ?', [s.batch1]), 0, '前置：请求前该批无上线事件');
    const r0 = await goliveReq(U.pm, s.batch1);
    expectErr(r0, 409, 'SYSBUILD_GOLIVE_BLOCKED', '前置全不满足');
    assert.deepStrictEqual(r0.body.blockers.map((b) => b.code), ['ACCEPT_NOT_EFFECTIVE']);
    assert.strictEqual(r0.body.blockers[0].message, '本批批次验收包还没有生效版本');
    assert.strictEqual(r0.body.message, `上线前置条件未满足：${r0.body.blockers.map((b) => b.message).join('；')}`);
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_golive_events WHERE batch_id = ?', [s.batch1]), 0, '被拒不写事件');
    assert.strictEqual((await batchRow(s.batch1)).status, 'active', '被拒批次仍 active');
    assert.strictEqual((await nodeRow(bGolive)).status, 'not_started', '被拒不动里程碑');
    // 读接口的阻塞项与执行同一个函数
    const v0 = await handoverGet(U.pm, s.batch1);
    assert.deepStrictEqual(v0.blockers, r0.body.blockers);
    assert.deepStrictEqual(v0.completion_candidates.map((n) => n.id), [bDev, extraNodeId]);
    assert.strictEqual(v0.actions.golive, false);
    // ② 验收包生效 + 节点逐个收口（别的批次的验收包生效不算本批：先生效第 2 批的验收包，本批仍报验收包未生效）
    // 第二批由夹具插入，没有模板节点。补上它自己的验收职责阶段，避免借用第一批材料。
    await sqlRun("INSERT INTO sysbuild_nodes (project_id, batch_id, template_key, name, g_stage, sort_order, is_golive_milestone) VALUES (?, ?, 'b_golive', '夹具第二批验收上线', 'G4+G5', 10, 1)", [s.pid, s.batch2]);
    await H.acceptEffective(s.pid, s.batch2);
    assert.deepStrictEqual((await goliveReq(U.pm, s.batch1)).body.blockers.map((b) => b.code), ['ACCEPT_NOT_EFFECTIVE'], '第 2 批的验收包生效不算本批');
    await H.acceptEffective(s.pid, s.batch1);
    assert.strictEqual((await handoverGet(U.pm, s.batch1)).actions.golive, true);
    assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${extraNodeId}/start`)).status, 200);
    assert.strictEqual((await closeNodeReq(extraNodeId)).status, 200);
    assert.deepStrictEqual((await handoverGet(U.pm, s.batch1)).completion_candidates.map((n) => n.id), [bDev], '候选仅剩未开始的 b_dev');
    await startNode(s.pid, 'b_dev');
    assert.strictEqual((await closeNodeReq(bDev)).status, 200);
    // ③ 夹具（RC10b）：一条未办结的登记，不发起任何交接确认。C4 前它让交接集合未清而挡住上线；C4 起上线前置只剩节点 / 验收包 / 待确认范围包，
    //   这条登记不再挡上线（⑥ 成功路径就在这条登记存在下发生；C6 起登记没有办结结论，旧版「已办结不再处理」那条随结论删除，夹具前提的适用范围断言随分流删除）。
    const eU = await regOk(U.pm, s.pid, { type: 'feedback', title: '还没办完' });
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
    // ⑥ 成功（RC10b：仍有未办结登记 eU 时，上线前置只看节点 / 验收包 / 范围包，转成功）
    const pre = await handoverGet(U.pm, s.batch1);
    assert.deepStrictEqual(pre.blockers, []);
    assert.strictEqual(pre.actions.golive, true, '标志为真');
    // RC14：计划视图的上线标志同源——仅剩未办结 / 已办结登记（不发起任何交接）时为真；旧版此夹具下该标志为假（OC10-2 / OC10-4 / OC10-5）。:934 一带的 /plan 读取在上线之后，标志恒为假，不是这里的载体
    //   C4f（128 L1）：夹具显式建了第 2 个进行中批次，按 s.batch1 定位本批，并先断言计划读取 200（不依赖批次排序）
    const planRes = await get(U.pm, `/sysbuild/projects/${s.pid}/plan`);
    assert.strictEqual(planRes.status, 200, planRes.text);
    const planBatch1 = planRes.body.batches.find((b) => b.id === s.batch1);
    assert.ok(planBatch1, '计划视图里有本批（s.batch1）');
    assert.strictEqual(planBatch1.actions.golive, true, '计划视图的上线标志：仅剩未办结 / 已办结登记（不发起任何交接）时为真（RC14）');
    const ok = await goliveReq(U.pm, s.batch1);
    assert.strictEqual(ok.status, 200, ok.text);
    assert.deepStrictEqual([ok.body.batch.status, ok.body.golive_event.kind, ok.body.milestone_node_id], ['live', 'golive', bGolive]);
    assert.deepStrictEqual(Object.keys(ok.body).sort(), ['batch', 'completed_node_ids', 'golive_event', 'milestone_node_id'], '成功响应含选择结果');
    const evs = await eventsAll(s.batch1);
    assert.strictEqual(evs.length, 1);
    assert.deepStrictEqual([evs[0].kind, evs[0].reason, evs[0].created_by], ['golive', null, U.pm]);
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
    expectErr(await post(U.pm, `/sysbuild/nodes/${extraNodeId}/reopen`, { reason: '想重开' }), 409, 'SYSBUILD_STATE', '已上线批次的节点不能重开');
    await backdate(ok.body.golive_event.id);
    const plan = (await get(U.pm, `/sysbuild/projects/${s.pid}/plan`)).body;
    assert.deepStrictEqual(plan.project.golive_progress, { live: 1, total: 2 }, '上线进度 1/2（第 2 批进行中，未上线）');
    const pb = plan.batches[0];
    assert.strictEqual(pb.live, true);
    assert.deepStrictEqual([pb.last_golive_event.kind, pb.last_golive_event.by, pb.last_golive_event.id, typeof pb.last_golive_event.at, pb.last_golive_event.reason], ['golive', U.pm, ok.body.golive_event.id, 'string', null]);
    assert.ok(typeof pb.last_golive_event.by_name === 'string' && pb.last_golive_event.by_name.length > 0, '带操作人显示名');
    assert.deepStrictEqual([pb.actions.golive, pb.actions.revoke_golive], [false, false], 'PM 视角：已上线不能再上线、撤销只有 admin');
    const adminPlan = (await get(U.admin, `/sysbuild/projects/${s.pid}/plan`)).body;
    assert.deepStrictEqual([adminPlan.batches[0].actions.golive, adminPlan.batches[0].actions.revoke_golive], [false, true], 'admin 视角：可撤销');
  });

  // ═══════════════════════ 11 撤销上线 ═══════════════════════
  test(`${T_REVOKE}——POST /batches/:bid/revoke-golive：admin（不必接管）写原因；批次须已上线、项目进行中 / 已暂停（已终止 / 已结项 409）、没有待确认的结项包（P150）；成功：revoke 事件、批次 → 进行中、里程碑 → 进行中并写节点事件、本批其他已收口节点不动；再上线走全部前置，kind = regolive（交接快照列：上线 '[]'、撤销 NULL、再上线 '[]'）`, async () => {
    const s = await mkPlan({ m1: true });
    const bGolive = await nodeIdOf(s.pid, 'b_golive');
    const closedNonMilestone = await nodeIdOf(s.pid, 'b_dev');
    await ready(s);
    // ① 批次还没上线：409
    const reasonBody = { reason: '上线后发现数据问题，需要撤销。'.padEnd(500, '补') }; // 恰 500 个字符：原因长度的边界通过
    assert.strictEqual(Array.from(reasonBody.reason).length, 500);
    expectErr(await revokeReq(U.admin, s.batch1, reasonBody), 409, 'SYSBUILD_STATE', '批次未上线');
    const g1 = await goLive(s);
    assert.deepStrictEqual((await get(U.pm, `/sysbuild/projects/${s.pid}/plan`)).body.project.golive_progress, { live: 1, total: 1 }, '上线后进度计 1 个已上线批次');
    // 预筛 LOW-5：项目详情（GET /projects/:id）也带 golive_progress，与 GET /plan 同一个函数
    assert.deepStrictEqual((await get(U.pm, `/sysbuild/projects/${s.pid}`)).body.project.golive_progress, { live: 1, total: 1 }, '项目详情的上线进度与计划视图同源');
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
    assert.deepStrictEqual(Object.keys(ok.body).sort(), ['batch', 'golive_event', 'milestone_node_id'], '撤销成功响应的键集合（RC11，不带 summary）');
    const evs = await eventsAll(s.batch1);
    assert.strictEqual(evs.length, nBefore + 1, '上线事件只追加');
    const last = evs[evs.length - 1];
    assert.deepStrictEqual([last.kind, last.reason, last.created_by], ['revoke', reasonBody.reason, U.admin]);
    assert.strictEqual((await batchRow(s.batch1)).status, 'active');
    const ms = await nodeRow(bGolive);
    assert.deepStrictEqual([ms.status, ms.closed_at], ['in_progress', null], '里程碑 → 进行中（closed_at 清空）');
    assert.strictEqual((await nodeRow(closedNonMilestone)).status, 'closed', '本批其他已收口节点不动');
    const reopened = (await payloads(s.pid, 'node_reopened')).filter((p) => p.via === 'revoke_golive');
    assert.deepStrictEqual(reopened, [{ reason: reasonBody.reason, via: 'revoke_golive', golive_event_id: last.id }], '里程碑节点事件一条');
    const rv = (await payloads(s.pid, 'golive_revoked')).pop();
    assert.deepStrictEqual(rv, { golive_event_id: last.id, reason: reasonBody.reason, milestone_node_id: bGolive });
    const bsc = (await payloads(s.pid, 'batch_status_changed')).filter((p) => p.via === 'revoke_golive').pop();
    assert.deepStrictEqual(bsc, { from: 'live', to: 'active', via: 'revoke_golive', golive_event_id: last.id });
    assert.strictEqual((await setStatus(s.pid, 'active')).status, 200);
    // ⑥ 撤销后：批次视图 live = false、最后一条事件是 revoke；再上线走全部前置，kind = regolive
    const view = await handoverGet(U.pm, s.batch1);
    assert.strictEqual(view.actions.golive, true, '前置仍全部满足');
    const pb = (await get(U.pm, `/sysbuild/projects/${s.pid}/plan`)).body.batches[0];
    assert.deepStrictEqual([pb.live, pb.last_golive_event.kind, pb.last_golive_event.reason], [false, 'revoke', reasonBody.reason]);
    assert.deepStrictEqual((await get(U.pm, `/sysbuild/projects/${s.pid}/plan`)).body.project.golive_progress, { live: 0, total: 1 }, '撤销按当前有效上线状态计数');
    assert.deepStrictEqual((await get(U.pm, `/sysbuild/projects/${s.pid}`)).body.project.golive_progress, { live: 0, total: 1 }, '项目详情同源');
    const re = await goliveReq(U.pm, s.batch1);
    assert.strictEqual(re.status, 200, re.text);
    assert.strictEqual(re.body.golive_event.kind, 'regolive');
    assert.deepStrictEqual(Object.keys(re.body).sort(), ['batch', 'completed_node_ids', 'golive_event', 'milestone_node_id'], '再上线成功响应含选择结果');
    assert.strictEqual((await nodeRow(bGolive)).status, 'closed', '再上线里程碑再次收口');
    // 按事件 ID 读取再上线的持久化记录。
    const reRow = await sqlGet('SELECT kind FROM sysbuild_golive_events WHERE id = ?', [re.body.golive_event.id]);
    assert.strictEqual(reRow.kind, 'regolive');
    // 事件只追加：上线 → 撤销 → 再上线三条，编号递增
    const all = await eventsAll(s.batch1);
    assert.deepStrictEqual(all.map((x) => x.kind), ['golive', 'revoke', 'regolive']);
    assert.deepStrictEqual(all.map((x) => x.id), [g1.golive_event.id, last.id, re.body.golive_event.id]);
    // 撤销后重开本批开发阶段再上线。该阶段留在可选列表，未勾选保持进行中。
    await backdate(re.body.golive_event.id);
    assert.strictEqual((await revokeReq(U.admin, s.batch1, { reason: '再撤销一次，验证再上线前置' })).status, 200);
    const rReopen = await post(U.pm, `/sysbuild/nodes/${closedNonMilestone}/reopen`, { reason: '撤销后重开节点，验证再上线前置' });
    assert.strictEqual(rReopen.status, 200, rReopen.text);
    assert.ok((await handoverGet(U.pm, s.batch1)).completion_candidates.some((n) => n.id === closedNonMilestone));
    const again = await goliveReq(U.pm, s.batch1);
    assert.strictEqual(again.status, 200, again.text);
    assert.strictEqual(again.body.golive_event.kind, 'regolive');
    assert.strictEqual((await nodeRow(closedNonMilestone)).status, 'in_progress');
  });

  // ═══════════════════════ 12 整体结项与重开 ═══════════════════════
  const diffDays = (a, b) => Math.max(0, Math.round((Date.UTC(Number(b.slice(0, 4)), Number(b.slice(5, 7)) - 1, Number(b.slice(8, 10))) - Date.UTC(Number(a.slice(0, 4)), Number(a.slice(5, 7)) - 1, Number(a.slice(8, 10)))) / 86400000));
  test(`${T_CLOSE}——p_closing 收口 = 整体结项：前置（结项包已生效、每个有效批次已正式上线、结项包生效晚于每个批次最后一条上线事件 P141）读接口与收口端点同一个函数；成功时同一事务项目 → 已结项并写项目状态事件；已结项后写动作 409、项目整体登记按补充登记；admin 重开项目时 p_closing 退回进行中（P142），之后可再收口`, async () => {
    const s = await mkPlan();
    await ready(s);
    await goLive(s, '-2 hours');
    const closingNode = await startNode(s.pid, 'p_closing');
    const planNodeOf = async (nid) => (await get(U.pm, `/sysbuild/projects/${s.pid}/plan`)).body.nodes.find((n) => n.id === nid);
    const codes = (r) => r.body.blockers.map((b) => b.code);
    // ① 结项包未生效
    const r1 = await closeNodeReq(closingNode);
    expectErr(r1, 409, 'SYSBUILD_CLOSE_BLOCKED', '结项包未生效');
    assert.deepStrictEqual(codes(r1), ['REQUIRED_CARDS_INCOMPLETE']);
    assert.ok(r1.body.blockers[0].message.includes('结项 · 结项确认'), r1.body.blockers[0].message);
    assert.deepStrictEqual((await planNodeOf(closingNode)).close_blockers, r1.body.blockers, '读接口 close_blockers 同源');
    assert.strictEqual(await projStatus(s.pid), 'active', '被拒不结项');
    // ② 结项包：提交（只有代表人确认）→ 生效
    const clPk = await mkPackage(s.pid, 'closing');
    const clV1 = await mkVersion(clPk);
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${clV1}/submit`)).status, 200);
    assert.deepStrictEqual((await tasksOf(clV1)).map((t) => t.user_id), [U.del]);
    await confirmAll(clV1);
    // ④ 撤销后再上线：结项包须重新确认（P141）。结项包 v1 的生效时刻前移到三小时前，再上线事件回拨到一小时前（晚于结项包生效）
    await sqlRun("UPDATE sysbuild_package_versions SET effective_at = datetime('now','localtime','-3 hours') WHERE id = ?", [clV1]);
    await H.productionRevoke(s.batch1, '撤销以验证结项包与再上线的先后');
    const r3 = await closeNodeReq(closingNode);
    assert.deepStrictEqual(codes(r3), ['REQUIRED_CARDS_INCOMPLETE'], '撤销后批次正式上线卡片变为未完成');
    assert.ok(r3.body.blockers[0].message.includes('正式上线记录'));
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
    expectErr(await post(U.pm, `/sysbuild/nodes/${await nodeIdOf(s.pid, 'b_dev')}/reopen`, { reason: '想重开' }), 409, 'SYSBUILD_PROJECT_READONLY', '已结项后重开节点');
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
    assert.deepStrictEqual(nre, [{ reason: '上线用例', via: 'project_reopen' }]);
    assert.strictEqual((await eventsOf(s.pid, 'node_reopened')).filter((e) => e.object_id === closingNode).length, 1, '节点事件挂在 p_closing 上');
    const eN = await regOk(U.pm, s.pid, { type: 'feedback', title: '重开后的项目整体登记' });
    assert.deepStrictEqual([eN.period, eN.days_after_close], ['process', null], '重开后回到过程登记');
    assert.strictEqual((await detail(U.pm, eS.id)).period, 'supplement', '已写入的登记时段不改写');
    assert.strictEqual((await planNodeOf(closingNode)).actions.close, true);
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

  // ═══════════════════════ 14 actions 同源 ═══════════════════════
  test(`${T_FLAGS}——批次视图 actions.golive / revoke_golive：各身份 × 各状态，标志为真 ⇔ 对应端点执行成功，为假 ⇔ 被拒（403 / 409）`, async () => {
    const s = await mkPlan({ m1: true });
    const roles = [[U.pm, 'PM'], [U.admin, 'admin'], [U.m1, '一般成员'], [U.ro, '只读账号'], [U.own, '负责人']];
    const bflags = async (uid) => (await get(uid, `/sysbuild/projects/${s.pid}/plan`)).body.batches[0].actions;
    // 状态 A：批次进行中，前置不满足（默认夹具：本批节点未收口 + 验收包未生效，mkPlan 之后不调 ready）
    for (const [uid, label] of roles) {
      const f = await bflags(uid);
      assert.deepStrictEqual([f.golive, f.revoke_golive], [false, false], `${label}：golive / revoke_golive 都为假`);
      assert.strictEqual((await handoverGet(uid, s.batch1)).actions.golive, false, `${label}：前置不满足时上线前置读接口的 golive 标志同源为假`);
    }
    for (const [uid, label] of roles.filter(([u]) => u !== U.pm)) {
      assert.ok([403, 409].includes((await goliveReq(uid, s.batch1)).status), `${label} 上线被拒`);
    }
    expectErr(await goliveReq(U.pm, s.batch1), 409, 'SYSBUILD_GOLIVE_BLOCKED', 'PM 前置不满足（标志为假）');
    // 状态 B：前置全部满足
    await ready(s);
    for (const [uid, label] of roles) {
      const f = await bflags(uid);
      assert.deepStrictEqual([f.golive, f.revoke_golive], [uid === U.pm, false], `${label}：只有 PM 的 golive 为真`);
      assert.strictEqual((await handoverGet(uid, s.batch1)).actions.golive, uid === U.pm, `${label}：上线读接口的 golive 标志同源`);
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
  });

  // ═══════════════════════ 15 rules 手写矩阵 ═══════════════════════
  test(`${T_RULES}——手写判定矩阵：golive（PM × 项目状态 golive 行 × 批次状态 × 前置事实）/ revoke_golive（admin × maintain 行 × 批次已上线 × 结项包待确认）/ package_version_submit 的批次验收包、结项包、待确认互斥分支；类别手写核对`, async () => {
    const R = T.getMods().rules;
    const idn = (o) => Object.assign({ isPm: false, isAdmin: false, isReadonly: false, isMember: false, userId: 50, ownerOfParties: [], delegateOfParties: [] }, o);
    const chk = (op, i, st, t) => R.checkOp(op, i, { id: 1, status: st || 'active', pm_user_id: 7 }, t || {});
    const code = (v) => (v === null ? null : `${v.status}:${v.code}`);
    const pm = idn({ isPm: true, isMember: true });
    const adm = idn({ isAdmin: true });
    // 类别（手写）
    assert.deepStrictEqual([R.OP_KIND.golive, R.OP_KIND.revoke_golive, R.OP_KIND.confirm_decide], ['golive', 'maintain', 'accept']);
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
    for (const bs of ['planning', 'active']) assert.strictEqual(chk('revoke_golive', adm, 'active', { batchStatus: bs, closingPending: false }).message, '只有已正式上线的批次可以撤销上线', `批次 ${bs}`);
    assert.strictEqual(chk('revoke_golive', adm, 'active', { batchStatus: undefined, closingPending: false }).message, '无法确定批次状态，请刷新后重试');
    assert.strictEqual(chk('revoke_golive', adm, 'active', { batchStatus: 'live', closingPending: true }).message, '本项目有待确认的结项包，请先撤回结项包再撤销上线');
    assert.strictEqual(code(chk('revoke_golive', adm, 'active', { batchStatus: 'live' })), '409:SYSBUILD_STATE', '结项包待确认事实没取到 fail-closed');
    // package_version_submit：批次验收包 / 结项包 / 互斥
    const SUB = { versionStatus: 'draft', confirmersMissing: null, historyConflict: null, parentSuperseded: false, otherPendingPackage: null, pairedBasis: true, hasConfirmationText: true };
    const sub = (o, st) => chk('package_version_submit', pm, st || 'active', Object.assign({}, SUB, o));
    for (const [bs, expectMsg] of [['planning', '批次还没有进入进行中，不能提交批次验收'], ['live', '批次已正式上线，不能再提交批次验收'], [undefined, '无法确定批次状态，请刷新后重试']]) {
      assert.strictEqual(sub({ packageType: 'batch_accept', batchStatus: bs }).message, expectMsg, `验收包 × 批次 ${String(bs)}`);
    }
    assert.strictEqual(sub({ packageType: 'batch_accept', batchStatus: 'active' }), null);
    assert.strictEqual(sub({ packageType: 'closing', closingNotReady: null }), null);
    assert.strictEqual(sub({ packageType: 'closing' }).message, '无法确定批次上线情况，请刷新后重试', '结项前置事实没取到');
    assert.strictEqual(sub({ packageType: 'closing', closingNotReady: { notLive: ['第 1 批', '第 2 批'] } }).message, '不能提交结项：以下批次还没有正式上线：第 1 批、第 2 批');
    // 父版本过期：只对总体规划包 / 批次需求包拒绝；验收包与结项包提交时重写，不拒绝
    assert.strictEqual(sub({ packageType: 'overall', parentSuperseded: true, initiationEffective: true, planMissing: null }).message, '草稿所基于的总体规划版本已被替代，请基于现行规划重建草稿');
    assert.strictEqual(sub({ packageType: 'batch_accept', batchStatus: 'active', parentSuperseded: true }), null);
    assert.strictEqual(sub({ packageType: 'closing', closingNotReady: null, parentSuperseded: true }), null);
    // 待确认互斥：三类 × 其他待确认类型；立项包不在内；事实没取到 fail-closed（C5：变更包已从互斥类型集合移除，其待确认行只在旧库出现）
    const ZH = { overall: '总体规划', batch_accept: '批次验收', closing: '结项', initiation: '立项' };
    const base = { overall: { initiationEffective: true, planMissing: null }, batch_accept: { batchStatus: 'active' }, closing: { closingNotReady: null } }; // L1：旧的互斥矩阵补齐新事实，期望不变。
    for (const type of ['overall', 'batch_accept', 'closing']) {
      assert.strictEqual(sub(Object.assign({ packageType: type }, base[type])), null, `${type} 无其他待确认`);
      for (const other of ['overall', 'batch_accept', 'closing']) {
        const r = sub(Object.assign({ packageType: type, otherPendingPackage: other }, base[type]));
        assert.strictEqual(r.message, `已有待确认的内容包：${ZH[other]}，须先撤回或等确认完成`, `${type} × 已有 ${other}`);
      }
      assert.strictEqual(sub(Object.assign({ packageType: type, otherPendingPackage: undefined }, base[type])).message, '无法确定项目里是否已有待确认的内容包，请刷新后重试', `${type} 事实没取到`);
    }
    assert.strictEqual(sub({ packageType: 'initiation', initiationBasis: 'ok', otherPendingPackage: 'overall' }), null, '立项包不受互斥约束');
    assert.strictEqual(sub({ packageType: 'initiation', initiationBasis: 'ok', otherPendingPackage: undefined }), null, '立项包不读这条事实');
    assert.deepStrictEqual(R.EXCLUSIVE_PENDING_PACKAGE_TYPES.slice(), ['overall', 'batch_accept', 'closing']);
    // 确认人集合（confirm-core 手写核对）：验收包 = 负责人 + 代表人；结项包 = 只有代表人；立项包 = 只有负责人
    assert.deepStrictEqual(R.SUBMITTABLE_PACKAGE_TYPES.slice(), ['overall', 'initiation', 'batch_accept', 'closing']);
  });

  // ═══════════════════════ 16 纯函数 ═══════════════════════
  test(`${T_CORE}——纯函数手写矩阵：plan.closeBlockers 的 p_closing 结项事实（fail-closed）、confirm-core.checkboxTextsOf 各用途取通用固定文案`, async () => {
    const cc = T.getMods().confirmCore;
    // plan.closeBlockers 的 p_closing 结项事实（手写）：closingStale / packagePending 必须是布尔 / 数组，否则 fail-closed 报 CLOSING_FACTS_MISSING；过期与待确认各报各的码
    const planMod = require(path.join(modDir(), 'plan.js'));
    const cNode = { id: 5, template_key: 'p_closing', batch_id: null, status: 'in_progress' };
    const cBase = { closingEffectiveAt: '2026-10-01 10:00:00', closingStale: false, packagePending: [], notLive: [], goliveNewer: [] };
    const cb = (cl) => planMod.closeBlockers(cNode, { closing: Object.assign({}, cBase, cl) });
    assert.deepStrictEqual(cb({}).map((b) => b.code), []);
    assert.deepStrictEqual(cb({ closingStale: true }).map((b) => b.code), ['CLOSING_STALE']);
    assert.deepStrictEqual(cb({ closingStale: true, closingEffectiveAt: null }).map((b) => b.code), ['PACKAGE_NOT_EFFECTIVE'], '没有生效的结项包时只报未生效，不报过期');
    const pp = cb({ packagePending: ['overall', 'closing'] });
    assert.deepStrictEqual(pp.map((b) => b.code), ['PACKAGE_PENDING']);
    assert.strictEqual(pp[0].message, '项目里还有待确认的内容包（总体规划、结项），须先处理完再结项');
    assert.deepStrictEqual(cb({ closingStale: true, packagePending: ['closing'] }).map((b) => b.code), ['CLOSING_STALE', 'PACKAGE_PENDING']);
    for (const bad of [{ closingStale: undefined }, { closingStale: 'yes' }, { packagePending: undefined }, { packagePending: 'overall' }]) assert.deepStrictEqual(cb(bad).map((b) => b.code), ['CLOSING_FACTS_MISSING'], JSON.stringify(bad));
    for (const purpose of ['package_confirm', 'proposer_confirm', 'conclusion_confirm', 'adjudicate', 'dev_key_confirm', 'bogus']) assert.deepStrictEqual(cc.checkboxTextsOf(purpose), { confirm: GENERIC_CONFIRM, object: GENERIC_OBJECT, reject: GENERIC_REJECT }, purpose);
  });

  // ═══════════════════════ 16 修订批 1（预筛 1 轮；C5 起变更流程已删，换夹具载体）═══════════════════════
  const effectiveOverallOf = async (pid) => (await sqlGet("SELECT v.id AS id FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id WHERE p.project_id = ? AND p.type = 'overall' AND v.status = 'effective' ORDER BY v.id DESC LIMIT 1", [pid])).id;
  const blockerCodes = (view) => view.blockers.map((b) => b.code);
  // 夹具（C5）：总体规划换版没有生产入口，直接写库——旧生效版本置已被替代，插入一个新的生效版本（版本 6 结构：生效版本必带 effective_at）。
  async function bumpOverall(pid) {
    const old = await sqlGet("SELECT v.id AS id, v.package_id AS pk, v.form AS form, v.version_no AS no FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id WHERE p.project_id = ? AND p.type = 'overall' AND v.status = 'effective' ORDER BY v.id DESC LIMIT 1", [pid]);
    await sqlRun("UPDATE sysbuild_package_versions SET status = 'superseded' WHERE id = ?", [old.id]);
    const max = await sqlGet('SELECT MAX(version_no) AS n FROM sysbuild_package_versions WHERE package_id = ?', [old.pk]);
    return (await sqlRun("INSERT INTO sysbuild_package_versions (package_id, version_no, form, status, effective_at, snapshot_json, created_by) VALUES (?, ?, ?, 'effective', datetime('now','localtime'), '{}', ?)", [old.pk, max.n + 1, old.form, U.pm])).lastID;
  }
  // 夹具（C5）：给某类包写一个待确认版本（版本 6 结构，直接写库）。overall 用本项目已有的总体规划包，其余类型要求包已存在。
  async function pendingFx(pid, type, versionNo) {
    const pk = (await sqlGet('SELECT id FROM sysbuild_packages WHERE project_id = ? AND type = ?', [pid, type])).id;
    return (await sqlRun("INSERT INTO sysbuild_package_versions (package_id, version_no, form, status, snapshot_json, created_by) VALUES (?, ?, ?, 'pending', '{}', ?)", [pk, versionNo, type === 'overall' ? 'overall' : null, U.pm])).lastID;
  }

  test(`${T_STALE}——（P168）上线前置 ACCEPT_STALE：本批现行生效的验收包版本 parent ≠ 现行总体规划版本（夹具：总体规划换版，C5 起没有生产入口）→ 上线 409、actions.golive 为假；（P164）PLAN_PENDING：项目有待确认的总体规划版本时不能上线；重新确认的出路：已生效的验收包建新草稿 → 提交（parent 重写成现行）→ 生效 → 放行；新文案逐字（N14 / N20）`, async () => {
    const s = await mkPlan();
    const acc = await ready(s);
    assert.deepStrictEqual((await handoverGet(U.pm, s.batch1)).blockers, [], '前置：验收包引用现行规划，没有阻塞');
    const eff1 = await effectiveOverallOf(s.pid);
    assert.strictEqual((await sqlGet('SELECT parent_overall_version_id AS p FROM sysbuild_package_versions WHERE id = ?', [acc.pv])).p, eff1, '前置：验收包 parent = 验收时的现行规划');
    // 夹具：总体规划待确认版本 → PLAN_PENDING（冻结文案逐字）
    const pend = await pendingFx(s.pid, 'overall', 98);
    let view = await handoverGet(U.pm, s.batch1);
    assert.deepStrictEqual(blockerCodes(view), ['PLAN_PENDING']);
    assert.strictEqual(view.blockers[0].message, '项目里有待确认的总体规划，须等确认完成或撤回后再上线');
    assert.strictEqual(view.actions.golive, false, 'actions.golive 同源为假');
    const rp = await goliveReq(U.pm, s.batch1);
    expectErr(rp, 409, 'SYSBUILD_GOLIVE_BLOCKED', '总体规划待确认');
    assert.deepStrictEqual(rp.body.blockers.map((b) => b.code), ['PLAN_PENDING']);
    assert.deepStrictEqual(rp.body.blockers, view.blockers, 'PLAN_PENDING：写接口 409 的 blockers 与读接口逐项一致');
    assert.strictEqual((await get(U.pm, `/sysbuild/projects/${s.pid}/plan`)).body.batches[0].actions.golive, false, '计划视图的标志同为假');
    await sqlRun("UPDATE sysbuild_package_versions SET status = 'superseded' WHERE id = ?", [pend]);
    // 夹具：总体规划换版：验收包引用的规划已不是现行 → ACCEPT_STALE（冻结文案逐字）
    const eff2 = await bumpOverall(s.pid);
    assert.notStrictEqual(eff2, eff1, '前置：规划已换版');
    view = await handoverGet(U.pm, s.batch1);
    assert.deepStrictEqual(blockerCodes(view), ['ACCEPT_STALE']);
    assert.strictEqual(view.blockers[0].message, '本批批次验收包引用的版本不是现行范围版本，须基于现行范围版本重新提交批次验收并确认');
    assert.strictEqual(view.actions.golive, false);
    const rs = await goliveReq(U.pm, s.batch1);
    expectErr(rs, 409, 'SYSBUILD_GOLIVE_BLOCKED', '验收包引用的规划已过期');
    assert.deepStrictEqual(rs.body.blockers.map((b) => b.code), ['ACCEPT_STALE']);
    assert.deepStrictEqual(rs.body.blockers, view.blockers, 'ACCEPT_STALE：写接口 409 的 blockers 与读接口逐项一致');
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

  test(`${T_PPEND}——（P168）p_closing 前置 CLOSING_STALE：现行生效结项包版本 parent ≠ 现行总体规划版本（夹具：总体规划换版）；（P164）PACKAGE_PENDING：项目有任何待确认的内容包版本（保留包夹具，C5-RC26）时不能整体结项；类型名按升序取出；读接口 close_blockers 同源；重新确认结项包后放行`, async () => {
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
    // ① 单个待确认的保留包（夹具：overall 待确认版本）→ PACKAGE_PENDING，message 逐字
    const pend = await pendingFx(s.pid, 'overall', 98);
    const r1 = await closeNodeReq(closingNode);
    expectErr(r1, 409, 'SYSBUILD_CLOSE_BLOCKED', '总体规划待确认');
    assert.deepStrictEqual(codes(r1), ['PACKAGE_PENDING']);
    assert.strictEqual(r1.body.blockers[0].message, '项目里还有待确认的内容包（总体规划），须先处理完再结项');
    assert.deepStrictEqual((await nodeBlockers()).map((b) => b.code), ['PACKAGE_PENDING'], '读接口 close_blockers 同源');
    assert.strictEqual((await nodeBlockers())[0].message, '项目里还有待确认的内容包（总体规划），须先处理完再结项', '读接口 close_blockers 逐字同文案');
    // 样本 ② 与 ① 同项目：先经通用撤回入口真实撤回 ① 的夹具版本（200），再提交新结项包（待确认互斥，rules.js 互斥清单含 overall 与 closing）
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${pend}/withdraw`, { reason: '样本 ① 撤回，样本 ② 才能正常提交新结项包' })).status, 200, '真实撤回样本 ① 的待确认总体规划版本');
    assert.strictEqual(await projStatus(s.pid), 'active', '被拒不结项');
    await sqlRun("UPDATE sysbuild_package_versions SET status = 'superseded' WHERE id = ?", [pend]);
    // 夹具：总体规划换版：结项包引用的规划已不是现行 → CLOSING_STALE（冻结文案逐字）
    await bumpOverall(s.pid);
    const r2 = await closeNodeReq(closingNode);
    assert.deepStrictEqual(codes(r2), ['CLOSING_STALE']);
    assert.strictEqual(r2.body.blockers[0].message, '结项包引用的版本不是现行范围版本，须基于现行范围版本重新提交结项包并确认');
    assert.deepStrictEqual((await nodeBlockers()).map((b) => b.code), ['CLOSING_STALE']);
    assert.strictEqual((await nodeBlockers())[0].message, '结项包引用的版本不是现行范围版本，须基于现行范围版本重新提交结项包并确认', 'GET /plan 的 close_blockers 与收口 409 两条响应路径各逐字断言新文案（N15）');
    // 新结项包版本提交后待确认：两条同时挡（旧生效版本仍过期 + 有待确认的包）
    const clV2 = await mkVersion(clPk);
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${clV2}/submit`)).status, 200);
    assert.deepStrictEqual(codes(await closeNodeReq(closingNode)), ['CLOSING_STALE', 'PACKAGE_PENDING']);
    await confirmAll(clV2);
    assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id = ?', [clV1])).status, 'superseded');
    const ok = await closeNodeReq(closingNode);
    assert.strictEqual(ok.status, 200, ok.text);
    assert.strictEqual(await projStatus(s.pid), 'closed');
    // ③ 类型顺序：独立项目，先给 overall 后给 closing 造待确认版本（与预期输出「结项、总体规划」相反），读写两端同源
    const s3 = await mkPlan();
    await ready(s3);
    await goLive(s3, '-2 hours');
    const closingNode3 = await startNode(s3.pid, 'p_closing');
    const clPk3 = await mkPackage(s3.pid, 'closing');
    const clV3 = await mkVersion(clPk3);
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${clV3}/submit`)).status, 200);
    await confirmAll(clV3);
    await pendingFx(s3.pid, 'overall', 98);
    await pendingFx(s3.pid, 'closing', 98);
    const r3 = await closeNodeReq(closingNode3);
    assert.deepStrictEqual(codes(r3), ['PACKAGE_PENDING']);
    assert.strictEqual(r3.body.blockers[0].message, '项目里还有待确认的内容包（结项、总体规划），须先处理完再结项');
    const nb3 = (await get(U.pm, `/sysbuild/projects/${s3.pid}/plan`)).body.nodes.find((n) => n.id === closingNode3).close_blockers;
    assert.strictEqual(nb3.find((b) => b.code === 'PACKAGE_PENDING').message, '项目里还有待确认的内容包（结项、总体规划），须先处理完再结项', '读接口同源');
    // 排序子句存在性（文本检查，与逆序造数互补）：packagePending 的查询文本带 ORDER BY p.type
    const coreSrc = fs.readFileSync(path.join(modDir(), 'entries-core.js'), 'utf8').replace(/\r\n/g, '\n');
    assert.ok(/AND v\.status = 'pending' ORDER BY p\.type`/.test(coreSrc), 'packagePending 查询含 ORDER BY p.type');
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

  // ═══════════════════════ C6 新增（生效清单 4.3 第 2 条）：办理类登记不再挡节点收口与结项（R3 / R5）═══════════════════════
  //   落点选 golive 套件（清单写 plan 或 golive 套件均可）：结项节点夹具（结项包生效 / 批次已正式上线）就在本套件，R3-1、R5-1 各用独立项目夹具（同一项目时 N4 挡住 R3-1 的收口，R5-1 的前置就不成立，目标标签无法单独求值）。
  test(`${T_C6_R35}——R3-1：本节点有未作废的办理类登记（另放知悉类各一条、别的节点的问题、项目整体的问题）阶段完成 200（成功响应是节点视图，没有 blockers 键）；R5-1：项目整体不挂阶段的未办结登记，p_closing 完成 200；拒绝样本文案「收口前置条件未满足」且 blocker 不再带 entry_ids`, async () => {
    const REC = {};
    // ── R3-1：独立项目夹具 ──
    const a = await mkPlan({ extraNode: true });
    const reqNode = a.extraNodeId;
    assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${reqNode}/start`)).status, 200);
    const devNode = await nodeIdOf(a.pid, 'b_dev');
    const nodeView = async (pid, nid) => (await get(U.pm, `/sysbuild/projects/${pid}/plan`)).body.nodes.find((n) => n.id === nid);
    REC.r31Before = (await nodeView(a.pid, reqNode)).close_blockers; // 建任何登记之前：close_blockers 严格等于 []（接替 routing.js:963「没有登记：不阻塞」）
    const att = await stageAtt(a.pid, U.pm);
    for (const extra of [
      { type: 'feedback', node_id: reqNode }, { type: 'issue', node_id: reqNode }, // 本节点的办理类登记（period = process、type = feedback / issue、未作废）
      { type: 'note', node_id: reqNode }, { type: 'lesson', node_id: reqNode }, { type: 'benefit', node_id: reqNode }, { type: 'material', node_id: reqNode, attachment_ids: [att] }, // 知悉类 / 补交材料：旧版本就不挡
      { type: 'issue', node_id: devNode }, { type: 'issue' }, // 别的节点的问题、node_id 为空的项目整体问题（收口普通节点时不属本节点）
    ]) await regOk(U.pm, a.pid, Object.assign({ title: '登记', body: '内容' }, extra));
    REC.r31After = (await nodeView(a.pid, reqNode)).close_blockers; // 建齐登记后读接口 close_blockers 仍为 []（接替 routing.js:967）
    REC.r31 = await closeNodeReq(reqNode); // 并发出收口请求（接替 routing.js:971）
    // ── R5-1：独立项目夹具，结项节点 ──
    const s = await mkPlan();
    await ready(s);
    const closingNode = await startNode(s.pid, 'p_closing');
    // 拒绝样本：结项包未生效且批次未正式上线（先于批次上线）：文案、blocker 键集合
    REC.r5Rej = await closeNodeReq(closingNode);
    REC.r5RejPlan = (await nodeView(s.pid, closingNode)).close_blockers;
    await goLive(s, '-2 hours');
    const clPk = await mkPackage(s.pid, 'closing');
    const clV = await mkVersion(clPk);
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${clV}/submit`)).status, 200);
    await confirmAll(clV);
    await regOk(U.pm, s.pid, { type: 'feedback', title: '项目整体未办结的意见', body: '内容' }); // node_id 为空、period = process、未作废
    await regOk(U.pm, s.pid, { type: 'issue', title: '项目整体未办结的问题', body: '内容' });
    REC.r51Plan = (await nodeView(s.pid, closingNode)).close_blockers; // 193-M2：整体登记建齐后、收口请求前读接口 close_blockers（R5-1 与 R3-1 的 r31After 对称）
    REC.r51 = await closeNodeReq(closingNode);
    REC.r51Status = await projStatus(s.pid);
    const fails = [];
    const c = (label, fn) => { try { fn(); } catch (e) { fails.push(`[${label}] ${String(e.message).split('\n')[0].slice(0, 300)}`); } };
    c('R3-1 建登记前 close_blockers 严格等于 []', () => assert.deepStrictEqual(REC.r31Before, []));
    c('R3-1 建齐登记后读接口 close_blockers 仍为 []', () => assert.deepStrictEqual(REC.r31After, []));
    c('R3-1 阶段完成 200，成功响应是节点视图、没有 blockers 键（旧版 409 ENTRY_UNRESOLVED）', () => { assert.strictEqual(REC.r31.status, 200, REC.r31.text); assert.strictEqual(REC.r31.body.node.status, 'closed'); assert.ok(!('blockers' in REC.r31.body)); });
    c('R5-1 建齐项目整体登记后读接口 close_blockers 为 []', () => assert.deepStrictEqual(REC.r51Plan, []));
    c('R5-1 结项阶段完成 200、项目 → 已结项（旧版 409 ENTRY_UNRESOLVED）', () => { assert.strictEqual(REC.r51.status, 200, REC.r51.text); assert.strictEqual(REC.r51Status, 'closed'); });
    c('拒绝样本文案「收口前置条件未满足」（原承载 c5.js:206 随旧变更行读出用例删）', () => { expectErr(REC.r5Rej, 409, 'SYSBUILD_CLOSE_BLOCKED', 'r5Rej'); assert.strictEqual(REC.r5Rej.body.message, '收口前置条件未满足'); });
    c('拒绝样本以卡片一次显示，保留批次和节点编号，接口与读取同核', () => {
      for (const list of [REC.r5Rej.body.blockers, REC.r5RejPlan]) {
        assert.deepStrictEqual(list.map((b) => b.code), ['REQUIRED_CARDS_INCOMPLETE']);
        assert.deepStrictEqual(Object.keys(list[0]).sort(), ['batch_ids', 'code', 'message', 'node_ids']);
        assert.ok(list[0].message.includes('结项 · 结项确认'));
        assert.ok(list[0].message.includes('正式上线记录'));
      }
    });
    assert.strictEqual(fails.length, 0, fails.join(' ‖ '));
  });
}

// ── 变异 ───────────────────────────────────────────────────────────────────────────────────────
// 每条 { id（前缀 C6a ）, expect: [用例名前缀], edits: [{ file, from, to }] }；锚点必须在副本里恰好出现一次（LF 归一后）。expect 列全会被打红的负责用例。
//   不覆盖（残余）：条件更新的旧状态保护（active → live / live → active 的 WHERE status = ? 只在并发下起作用，静态守卫 S2 管）；库内缺单号 / 承接人的 to_sys_iteration 结论兜底（API 造不出这类数据）。
const gm = (id, expect, file, from, to) => ({ id: `C6a ${id}`, expect, edits: [{ file, from, to }] });
const gm_b = (id, expect, file, from, to) => ({ id: `C6b ${id}`, expect, edits: [{ file, from, to }] });
// C4 新增变异的登记 id 一律写字面量（C4 前缀，不走 gm 助手的 C6a 前缀）：N1 / N2 守 P-HS（上线事件交接快照列固定写空数组文本），N3–N7 守 P-GB（上线前置读接口），N8 守 R4（上线成功响应不再带 summary），N9 由 M1644 改挂（取消风险的风险事实 fail-closed）。
const c4 = (id, expect, file, from, to) => ({ id: `C4 ${id}`, expect, edits: [{ file, from, to }] });
const GOLIVE_MUTATIONS = [
  // ── rules.js：上线 / 撤销 ──
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
  // ── rules.js：提交内容包 ──
  gm('批次验收包提交不核对批次进行中', [T_PKG, T_RULES], 'rules.js', "if (t.packageType === 'batch_accept' && t.batchStatus !== 'active') {", 'if (false) {'),
  gm('结项包提交不核对批次已上线', [T_CPKG, T_RULES], 'rules.js', 'if (cn !== null) return closingNotReadyMessage(cn);', ''),
  gm('结项包提交前置事实没取到也放行', [T_RULES], 'rules.js', 'if (cn === undefined) return CLOSING_FACT_UNKNOWN_MESSAGE;', ''),
  gm('待确认互斥不拦（四类包可同时待确认）', [T_EXCL, T_RULES], 'rules.js', 'if (t.otherPendingPackage !== null) return `已有待确认的内容包：${PACKAGE_TYPE_LABELS[t.otherPendingPackage] || t.otherPendingPackage}，须先撤回或等确认完成`;', ''),
  gm('待确认互斥事实没取到也放行', [T_RULES], 'rules.js', 'if (t.otherPendingPackage === undefined) return PENDING_FACT_UNKNOWN_MESSAGE;', ''),
  gm('待确认互斥把立项包也算进去', [T_EXCL, T_RULES], 'rules.js', "const EXCLUSIVE_PENDING_PACKAGE_TYPES = Object.freeze(['overall', 'batch_accept', 'closing']);", "const EXCLUSIVE_PENDING_PACKAGE_TYPES = Object.freeze(['overall', 'batch_accept', 'closing', 'initiation']);"),
  gm('验收包 / 结项包草稿 parent 过期也拒绝（没有别的办法重建草稿）', [T_PKG, T_CPKG, T_RULES], 'rules.js', 'if (t.parentSuperseded === true && !PARENT_REWRITTEN_AT_SUBMIT_TYPES.includes(t.packageType)) return PARENT_SUPERSEDED_MESSAGE;', 'if (t.parentSuperseded === true) return PARENT_SUPERSEDED_MESSAGE;'),
  gm('提交开放清单漏掉结项包', [T_CPKG, T_RULES], 'rules.js', "const SUBMITTABLE_PACKAGE_TYPES = Object.freeze(['overall', 'initiation', 'batch_accept', 'closing']);", "const SUBMITTABLE_PACKAGE_TYPES = Object.freeze(['overall', 'initiation', 'batch_accept']);"),
  // ── entries-core.js：统一上线判据与结项前置 ──
  gm('上线判据：同一秒也算已上线（严格晚于改成不早于）', [T_LIVE], 'entries-core.js', "return { last, live: LIVE_EVENT_KINDS.includes(ev.kind) && typeof ev.now_at === 'string' && ev.now_at > ev.created_at };", "return { last, live: LIVE_EVENT_KINDS.includes(ev.kind) && typeof ev.now_at === 'string' && ev.now_at >= ev.created_at };"),
  gm('上线判据：撤销事件也算已上线', [T_LIVE],'entries-core.js', "return { last, live: LIVE_EVENT_KINDS.includes(ev.kind) && typeof ev.now_at === 'string' && ev.now_at > ev.created_at };", "return { last, live: typeof ev.now_at === 'string' && ev.now_at > ev.created_at };"),
  gm('结项前置：未上线的批次不列', [T_CPKG, T_CLOSE], 'entries-core.js', 'if (!st.live) out.notLive.push({ id: b.id, name: b.name });', 'if (false) out.notLive.push({ id: b.id, name: b.name });'),
  gm('结项前置：结项包与上线事件同一时刻也算晚于', [T_CLOSE], 'entries-core.js', 'else if (eff && !(st.last.created_at < eff.effective_at)) out.goliveNewer.push({ id: b.id, name: b.name });', 'else if (eff && st.last.created_at > eff.effective_at) out.goliveNewer.push({ id: b.id, name: b.name });'),
  // ── golive-core.js：上线 / 撤销的写入 ──
  gm('上线前置：不核对批次验收包', [T_GOLIVE],'golive-core.js', "if (!acc) { out.push({ code: 'ACCEPT_NOT_EFFECTIVE'", "if (!acc) { if (false) out.push({ code: 'ACCEPT_NOT_EFFECTIVE'"),
  gm('上线前置：验收包不限本批', [T_GOLIVE], 'golive-core.js', "WHERE p.batch_id = ? AND p.type = 'batch_accept' AND v.status = 'effective' LIMIT 1", "WHERE ? IS NOT NULL AND p.type = 'batch_accept' AND v.status = 'effective' LIMIT 1"),
  gm('上线收口里程碑不写实际结束', [T_GOLIVE], 'golive-core.js', "VALUES (?, 'actual_end', ?, ?)\", [node.id, o.dateStr, Number(user.id)]);", "VALUES (?, 'actual_end', ?, ?)\", [node.id, '2000-01-01', Number(user.id)]);"),
  gm('上线收口未开始的里程碑不写实际开始', [T_GOLIVE], 'golive-core.js', "await q.run(\"INSERT INTO sysbuild_node_schedule_records (node_id, kind, actual_date, created_by) VALUES (?, 'actual_start', ?, ?)\", [node.id, o.dateStr, Number(user.id)]);", ''),
  gm('撤销上线不把里程碑退回进行中', [T_REVOKE], 'golive-core.js', "if (node.status === 'closed') {", 'if (false) {'),
  gm('项目上线进度不计已上线批次', [T_GOLIVE, T_REVOKE], 'golive-core.js', 'if ((await entries.batchLiveState(q, b.id)).live) live += 1;', ''),
  // ── golive.js ──
  gm('再上线的事件种类恒为 golive', [T_REVOKE], 'golive.js', "const kind = last !== null && last.kind === 'revoke' ? 'regolive' : 'golive';", "const kind = 'golive';"),
  gm('上线按事先算好的空前置判定（不按当时完整集合重核）', [T_GOLIVE, T_FLAGS], 'golive.js', "const v = rules.checkOp('golive', access, access.project, { batchStatus: batch.status, blockers });", "const v = rules.checkOp('golive', access, access.project, { batchStatus: batch.status, blockers: [] });"),
  gm('上线被拒的响应不带 blockers 列表', [T_GOLIVE], 'golive.js', "if (v.code === 'SYSBUILD_GOLIVE_BLOCKED' && Array.isArray(blockers)) err.blockers = blockers;", ''),
  // ── confirm-core.js：确认人范围 ──
  gm('结项包确认人也含负责人', [T_CPKG], 'confirm-core.js', "    if (role === 'owner') {", "    if (packageType === 'closing') {\n      const owner = await currentOwner(q, p.id);\n      if (owner) out.entries.push({ partyId: p.id, kind: 'owner', memberId: owner.memberId, appointmentId: owner.appointmentId, delegationId: null });\n    }\n    if (role === 'owner') {"),
  gm('批次验收包确认人不含代表人', [T_PKG], 'confirm-core.js', "batch_accept: 'delegate'", "batch_accept: 'owner'"),
  gm('结项包确认人不含代表人', [T_CPKG], 'confirm-core.js', "closing: 'delegate'", "closing: 'owner'"),
  // ── packages.js ──
  gm('待确认互斥的事实恒为空', [T_EXCL], 'packages.js', 'facts.otherPendingPackage = other ? other.type : null;', 'facts.otherPendingPackage = null;'),
  gm('结项包提交前置的事实恒为满足', [T_CPKG], 'packages.js', 'facts.closingNotReady = cf.notLive.length === 0', 'facts.closingNotReady = true || cf.notLive.length === 0'),
  // ── plan.js / projects.js：整体结项与重开 ──
  gm('p_closing 收口不结项', [T_CLOSE], 'plan.js', "if (closing) {\n        const pr = await q.run(", "if (false) {\n        const pr = await q.run("),
  gm('结项事件缺原因', [T_CLOSE], 'plan.js', "{ from: 'active', to: 'closed', reason: '整体验收结项节点收口' }", "{ from: 'active', to: 'closed' }"),
  gm('p_closing 收口前置：结项包不晚于上线事件也放行', [T_CLOSE], 'plan.js', 'if (cl.goliveNewer.length > 0) {', 'if (false) {'),
  gm('已结项重开不退回 p_closing', [T_CLOSE], 'projects.js', "if (from === 'closed' && to === 'active') {", 'if (false) {'),
  // ── 修订批 1（预筛 1 轮）──
  gm('P168：不核验收包引用的规划是否现行', [T_STALE], 'golive-core.js', 'else if (acc.parent_id !== (await packages.effectiveOverallVersionId(q, batch.project_id))) {', 'else if (false) {'),
  gm('P168：验收包过期判据读上一版规划（只看有没有 parent）', [T_STALE], 'golive-core.js', 'else if (acc.parent_id !== (await packages.effectiveOverallVersionId(q, batch.project_id))) {', 'else if (acc.parent_id === null) {'),
  gm('P164：待确认的规划类包不挡上线', [T_STALE], 'golive-core.js', 'if (await planPendingOf(q, batch.project_id)) out.push(', 'if (false) out.push('),
  gm('P168：结项包过期事实恒为假', [T_PPEND], 'entries-core.js', 'closingStale: !!eff && eff.parent_id !== curOverall,', 'closingStale: false,'),
  gm('P168：结项包过期不挡 p_closing 收口', [T_PPEND], 'plan.js', "if (cl.closingStale === true && typeof cl.closingEffectiveAt === 'string') {", 'if (false) {'),
  gm('P164：待确认的内容包不挡 p_closing 收口', [T_PPEND], 'plan.js', 'if (cl.packagePending.length > 0) {', 'if (false) {'),
  gm('结项事实缺新字段也放行（不 fail-closed）', [T_CORE], 'plan.js', "      || typeof cl.closingStale !== 'boolean' || !Array.isArray(cl.packagePending)) {", ') {'),
  // ── 修订批 3（重开项目 / 项目详情 / 结项包判据 / 计划视图）──
  gm('LOW-3：重开项目时 p_closing 不是已收口也静默放过', [T_REOPEN], 'projects.js', "if (!closing || closing.status !== 'closed') throw makeError(500,", "if (false) throw makeError(500,"),
  gm('LOW-5：项目详情不带上线进度', [T_REVOKE], 'projects.js', 'const golive_progress = await goliveCore.goliveProgressOf(q, pid);', 'const golive_progress = undefined;'),
  gm('LOW-7：待确认结项包判据读草稿', [T_REVOKE], 'golive-core.js', "p.type = 'closing' AND v.status = 'pending' LIMIT 1", "p.type = 'closing' AND v.status = 'draft' LIMIT 1"),
  gm('LOW-7：待确认结项包判据读变更包', [T_REVOKE], 'golive-core.js', "p.type = 'closing' AND v.status = 'pending' LIMIT 1", "p.type = 'change' AND v.status = 'pending' LIMIT 1"),
  gm('LOW-7：计划视图的批次上线阻塞项只对进行中批次现算（判反）', [T_STALE, T_FLAGS], 'plan.js', "blockers: b.status === 'active' ? await goliveCore.goliveBlockersOf(q, b) : [],", "blockers: b.status !== 'active' ? await goliveCore.goliveBlockersOf(q, b) : [],"),
  // ── #212 C4（删上线交接）新增 ──
  // P-HS：上线事件的交接快照列固定写空数组文本（版本 6 条件 CHECK 要求上线 / 再上线事件非空）
  // P-GB：上线前置读接口只留 batch / blockers / actions，读写同源
  c4('P-GB：交接读接口响应仍带 summary 键', [T_GB], 'golive.js', 'return { batch: await batchView(q, batch), blockers,', 'return { batch: await batchView(q, batch), summary: {}, blockers,'),
  c4('P-GB：交接读接口的 blockers 恒空（与写接口 409 不同源）', [T_GB, T_GOLIVE], 'golive.js', 'blockers, completion_candidates, actions: await batchActions(q, access, batch, blockers) };', 'blockers: [], completion_candidates, actions: await batchActions(q, access, batch, blockers) };'),
  c4('P-GB：批次读写端点不校验项目可见（非成员不再 404）', [T_GB, T_GOLIVE, T_REVOKE], 'golive.js', 'rules.assertVisible(access);', ''),
  c4('P-GB：批次不存在时不报 404（loadBatchCtx 去 notFound）', [T_GB, T_GOLIVE], 'golive.js', 'if (!batch) throw rules.notFound();', ''),
  c4('P-GB：读接口 actions.golive 不按当前 blockers 判（与写接口不同源）', [T_FLAGS, T_GOLIVE], 'golive.js', "golive: rules.opAllowed('golive', access, access.project, { batchStatus: batch.status, blockers }),", "golive: rules.opAllowed('golive', access, access.project, { batchStatus: batch.status, blockers: [] }),"),
  // R4：上线成功响应不再带 summary
  c4('R4：上线成功响应仍带 summary 键', [T_GOLIVE], 'golive.js', 'golive_event: await goliveEventView(q, { id: rec.goliveEventId, kind }), milestone_node_id: rec.milestoneNodeId, completed_node_ids: completedNodeIds };', 'golive_event: await goliveEventView(q, { id: rec.goliveEventId, kind }), milestone_node_id: rec.milestoneNodeId, completed_node_ids: completedNodeIds, summary: {} };'),
  // ── #212 C6 改挂（A.5 F-gone）：原载体 routing.js 的 T_GOLIVE（经登记探测的上线事件有效性）随整文件删，变异定义（id 不变）改挂到本套件的「C6：批次上线判定助手」与「C6a 上线：统一上线判据」──
  { id: 'C5 分流：撤销上线的批次仍算已上线', expect: [T_HELPER, T_LIVE], edits: [{ file: 'entries-core.js', from: "return { last, live: LIVE_EVENT_KINDS.includes(ev.kind) && typeof ev.now_at === 'string' && ev.now_at > ev.created_at };", to: "return { last, live: typeof ev.now_at === 'string' && ev.now_at > ev.created_at };" }] },
  { id: 'C5 分流：事件时刻不早于登记时刻也算已上线', expect: [T_HELPER, T_LIVE], edits: [{ file: 'entries-core.js', from: "return { last, live: LIVE_EVENT_KINDS.includes(ev.kind) && typeof ev.now_at === 'string' && ev.now_at > ev.created_at };", to: 'return { last, live: LIVE_EVENT_KINDS.includes(ev.kind) };' }] }, // 名字里的「登记时刻」是旧名：C6 后判定只和当前时刻 now_at 比较（A.5 M1095）
  { id: 'C5 分流：上线事件取最早一条', expect: [T_HELPER], edits: [{ file: 'entries-core.js', from: 'WHERE batch_id = ? ORDER BY id DESC LIMIT 1', to: 'WHERE batch_id = ? ORDER BY id ASC LIMIT 1' }] },
  // ── #212 C6 新增（A.3 N4）：POST /nodes/:nid/close 在 blockers 判定之后加回「本节点（结项阶段含项目整体）有未作废办理类登记 → 409」查库拦截（R3-1 / R5-1 两条甲类样本得 409 而判红；口径同旧 unresolvedProcessEntriesOf：period = process、type IN feedback / issue）──
  { id: 'C6 R3 / R5：收口前置加回办理类登记检查', expect: [T_C6_R35], edits: [{ file: 'plan.js', from: "if (blockers.length > 0) throw Object.assign(makeError(409, 'SYSBUILD_CLOSE_BLOCKED', '收口前置条件未满足'), { blockers });", to: "if (blockers.length > 0) throw Object.assign(makeError(409, 'SYSBUILD_CLOSE_BLOCKED', '收口前置条件未满足'), { blockers });\n      const unresolved = await q.get(\"SELECT e.id AS id FROM sysbuild_entries e WHERE e.project_id = ? AND e.period = 'process' AND e.type IN ('feedback', 'issue') AND (e.node_id = ? OR (? = 'p_closing' AND e.node_id IS NULL)) AND NOT EXISTS (SELECT 1 FROM sysbuild_entry_actions a WHERE a.entry_id = e.id AND a.action = 'void') LIMIT 1\", [node.project_id, node.id, node.template_key]);\n      if (unresolved) throw Object.assign(makeError(409, 'SYSBUILD_CLOSE_BLOCKED', '收口前置条件未满足'), { blockers: [] });" }] },
  // ── #212 C6f 新增（193-M4）：最新事件改按事件时刻取（编号大而时刻早的再上线会被压过）──
  { id: 'C6 上线判定：最新事件改按事件时刻排序', expect: [T_HELPER], edits: [{ file: 'entries-core.js', from: 'WHERE batch_id = ? ORDER BY id DESC LIMIT 1', to: 'WHERE batch_id = ? ORDER BY created_at DESC LIMIT 1' }] },
  { id: 'C5 分流：上线事件不按批次限定', expect: [T_HELPER], edits: [{ file: 'entries-core.js', from: 'FROM sysbuild_golive_events WHERE batch_id = ?', to: 'FROM sysbuild_golive_events WHERE ? > 0' }] },
];

module.exports = { defineGoliveCases, GOLIVE_MUTATIONS };
