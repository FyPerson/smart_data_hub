// 验证脚本库：项目管理（系统建设记录）模块 C5 S-S1a——登记与办理（#113 段 7 C5 S-S1a；#212 C6 起办理只剩更正与作废）的用例与变异
//   方案：docs/local/系统建设记录/系统建设记录_平台集成_方案_20261105_v1.4.md §4.1（登记规则表、过程 / 补充登记）、§4.5、§5.2–5.3、§6.2、§6.3、§7；#212 第一步 C6 生效清单第四节（改写与新增断言）
//   派单：docs/local/系统建设记录/送审准备/C5_S-S1a_登记与办理_派单_20261105.md（§9 测试清单；本文件的 T_* 常量与之逐项对应）
//
// 本文件只放用例与变异，由 sysbuild-api-suite.js 登记（同一套夹具、同一个变异自检）。期望值一律手写，不取自被测代码。
// 夹具规则：建项走 POST /projects；登记、办理、项目状态转移全部走生产端点。只有这几类直接写库：
//   ① 需求方 / 开发方参与方、成员、现任任职、生效授权（含无账号成员）；② 附件行（暂存）；③ 节点收口状态与时刻、项目结项状态与结项事件、
//   旧库遗留状态（C6 P-W8 用例：办理结论 / 办理依据 / 改期引用 / 未结异议，C6 后没有写入口）。
// 时间：进程内夹具的「今天」由统一todayProvider固定注入，实例模式取真实本地日期；与「今天」有关的期望一律由 today() 推算（收口日 = 今天往前 N 天），不写死日期。
'use strict';
const assert = require('assert');
const { isDeepStrictEqual } = require('node:util');

const P = 'C5 登记：';
const T_PERIOD = `${P}时段判定`;
const T_STATUS = `${P}项目状态 × 写登记`;
const T_WHO = `${P}来源方与权限`;
const T_EVID = `${P}证据`;
const T_FIELDS = `${P}字段校验`;
const T_CLASS = `${P}终止分类表`;
const T_FLAGS = `${P}actions 同源`;
const T_VOID = `${P}更正与作废`;
const T_READ = `${P}读接口`;
const T_RULES = `${P}rules`;
const T_ORDER = `${P}检查顺序`;
const T_ONLY = `${P}只追加`;
// #212 C6 新增用例
const T_C6_R9 = 'C6 R9：登记入口只收通用登记与三张表单，退出键出现即拒';
const T_C6_ACT = 'C6 R9：办理动作只剩更正与作废';
const T_C6_PW8 = 'C8 作废保留规则';
const T_C6_PW9 = 'C6 P-W9：登记列表 routing 查询键出现即拒';
// 其它套件的用例名（变异 expect 改挂用，必须与那些用例标题的前缀一致）
const T_C6_R6 = 'C6 R6：进度汇报影响里程碑须方向类证据，无认可任务与本人确认';
const T_C6_R7 = 'C6 R7：知会与待办不再有异议与 notice 类';
const T_C6B_SCHEDULE = 'C6b 通知：改期知会生成';

const ACTION_NAMES = ['correct', 'void'];

const shift = (d, n) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n)).toISOString().slice(0, 10);
};
const localToday = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function defineEntryCases(T) {
  const { test, U, api, sqlRun, sqlGet, sqlAll, expectErr, addMember, addParty, addAppointment, addDelegation, confirm: H } = T;
  const { newProject, seedParty, stageAtt } = H;
  const post = (uid, url, body) => api(uid, 'POST', url, body === undefined ? {} : body);
  const get = (uid, url) => api(uid, 'GET', url);
  const today = () => (T.getFixedToday && T.getFixedToday()) || localToday();
  const countOf = async (s, p) => (await sqlGet(s, p)).n;

  // ── 场景与助手 ─────────────────────────────────────────────────────────────────────────────
  // 标准场景：甲部（需求方）负责人 own、代表人 del、一般成员 m1 / m2；信息技术部内部成员 cand（无参与方）；开发方负责人 x1、代表人 x2；
  //   乙部（需求方）只有负责人 cand2、没有代表人，一般成员 x3；非成员 out。PM = U.pm。
  async function mkScene() {
    const pid = await newProject();
    const A = await seedParty(pid, '甲部', U.own, U.del);
    const mM1 = await addMember(pid, U.m1, { party: A.party });
    const mM2 = await addMember(pid, U.m2, { party: A.party });
    const mInt = await addMember(pid, U.cand);
    const D = await addParty(pid, '开发方', 'dev');
    const mDevOwn = await addMember(pid, U.x1, { party: D });
    const aptD = await addAppointment(D, mDevOwn, 'active');
    const mDevDel = await addMember(pid, U.x2, { party: D });
    const dlgD = await addDelegation(D, mDevDel, aptD, 'active');
    const B = await addParty(pid, '乙部', 'demand');
    const mBOwn = await addMember(pid, U.cand2, { party: B });
    const aptB = await addAppointment(B, mBOwn, 'active');
    const mB = await addMember(pid, U.x3, { party: B });
    return { pid, A, mM1, mM2, mInt, D, mDevOwn, aptD, mDevDel, dlgD, B, mBOwn, aptB, mB };
  }
  const reg = (uid, pid, extra) => post(uid, `/sysbuild/projects/${pid}/entries`, Object.assign({ type: 'note', title: '标题', body: '内容' }, extra || {}));
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
  const nodeId = async (pid, key) => (await sqlGet('SELECT id FROM sysbuild_nodes WHERE project_id = ? AND template_key = ?', [pid, key])).id;
  async function ordinaryBatchNode(pid) {
    const bid = await H.defaultBatchId(pid);
    const response = await post(U.pm, `/sysbuild/batches/${bid}/nodes`, { name: '登记对照阶段', g_stage: 'G1' });
    assert.strictEqual(response.status, 201, response.text);
    return response.body.node.id;
  }
  // 夹具：把节点直接写成已收口（收口 = 今天往前 daysAgo 天的 09:00:00；库内约束要求进行中 / 已收口的节点有开始时刻）。daysAgo 为字符串日期时直接用。
  const closeNode = (nid, closedAt) => sqlRun(
    "UPDATE sysbuild_nodes SET status = 'closed', opened_at = COALESCE(opened_at, '2026-10-01 09:00:00'), closed_at = ? WHERE id = ?", [closedAt, nid]
  );
  const actionsRows = (eid) => sqlAll('SELECT * FROM sysbuild_entry_actions WHERE entry_id = ? ORDER BY id', [eid]);
  const eventsOfType = (pid, type) => sqlAll('SELECT * FROM sysbuild_events WHERE project_id = ? AND event_type = ? ORDER BY id', [pid, type]);

  // ═══════════════════════ 1 时段判定 ═══════════════════════
  test(`${T_PERIOD}——节点未收口 → 过程登记；已收口 → 补充登记 + 收口后第 N 天（登记日 − 收口日，当天 = 0）；节点重开后已有登记不改写；项目整体按是否结项（结项事件优先，缺事件取 updated_at）`, async () => {
    const s = await mkScene();
    const t0 = today();
    const nid = await ordinaryBatchNode(s.pid);
    const e1 = await regOk(U.pm, s.pid, { node_id: nid });
    assert.strictEqual(e1.period, 'process');
    assert.strictEqual(e1.days_after_close, null);
    assert.strictEqual(e1.node_id, nid);
    await closeNode(nid, `${shift(t0, -5)} 09:00:00`);
    const e2 = await regOk(U.pm, s.pid, { node_id: nid });
    assert.strictEqual(e2.period, 'supplement');
    assert.strictEqual(e2.days_after_close, 5);
    const row2 = await sqlGet('SELECT period, days_after_close FROM sysbuild_entries WHERE id = ?', [e2.id]);
    assert.deepStrictEqual([row2.period, row2.days_after_close], ['supplement', 5], '落库值');
    await sqlRun("UPDATE sysbuild_nodes SET closed_at = ? WHERE id = ?", [`${t0} 08:00:00`, nid]);
    assert.strictEqual((await regOk(U.pm, s.pid, { node_id: nid })).days_after_close, 0, '收口当天 = 第 0 天');
    // 节点重开：已有登记不随之改写，新登记按未收口算
    await sqlRun("UPDATE sysbuild_nodes SET status = 'in_progress', closed_at = NULL WHERE id = ?", [nid]);
    const keep1 = await sqlGet('SELECT period, days_after_close FROM sysbuild_entries WHERE id = ?', [e1.id]);
    const keep2 = await sqlGet('SELECT period, days_after_close FROM sysbuild_entries WHERE id = ?', [e2.id]);
    assert.deepStrictEqual([keep1.period, keep1.days_after_close, keep2.period, keep2.days_after_close], ['process', null, 'supplement', 5], '重开后已有登记的时段固化');
    const e4 = await regOk(U.pm, s.pid, { node_id: nid });
    assert.strictEqual(e4.period, 'process');
    // 再次收口：之前那条补充登记的天数仍是 5
    await closeNode(nid, `${shift(t0, -1)} 09:00:00`);
    assert.strictEqual((await sqlGet('SELECT days_after_close AS d FROM sysbuild_entries WHERE id = ?', [e2.id])).d, 5, '再收口不改写');
    assert.strictEqual((await regOk(U.pm, s.pid, { node_id: nid })).days_after_close, 1);
    // 项目整体：未结项 → 过程
    assert.strictEqual((await regOk(U.pm, s.pid)).period, 'process');
    assert.strictEqual((await regOk(U.pm, s.pid)).node_id, null);
    // 项目整体 + 已结项：无结项事件时取项目 updated_at；有结项事件取事件时刻
    await sqlRun("UPDATE sysbuild_projects SET status = 'closed', updated_at = ? WHERE id = ?", [`${shift(t0, -3)} 10:00:00`, s.pid]);
    const c1 = await regOk(U.pm, s.pid);
    assert.deepStrictEqual([c1.period, c1.days_after_close], ['supplement', 3]);
    await sqlRun(
      "INSERT INTO sysbuild_events (project_id, object_type, object_id, event_type, payload_json, operator_id, operator_name, created_at) VALUES (?, 'project', ?, 'project_status_changed', ?, ?, 'x', ?)",
      [s.pid, s.pid, JSON.stringify({ from: 'active', to: 'closed', reason: '结项' }), U.admin, `${shift(t0, -2)} 08:00:00`]
    );
    const c2 = await regOk(U.pm, s.pid);
    assert.deepStrictEqual([c2.period, c2.days_after_close], ['supplement', 2], '结项事件优先于 updated_at');
    // 关联项目下的节点：节点没收口仍按过程登记判（已结项项目只允许补充登记，所以过程登记 409）
    const nid2 = await nodeId(s.pid, 'b_dev');
    expectErr(await reg(U.pm, s.pid, { node_id: nid2 }), 409, 'SYSBUILD_PROJECT_READONLY', '已结项项目里未收口节点的过程登记');
    // P95：项目整体 + 已终止 = 补充登记，天数按「最后一条改为 terminated 的状态事件」（终止 → 重开 → 再终止以最后一次为准）；缺事件取 updated_at（夹具）
    const e = await mkScene();
    await sqlRun("UPDATE sysbuild_projects SET status = 'terminated', updated_at = ? WHERE id = ?", [`${shift(t0, -2)} 10:00:00`, e.pid]);
    const t1 = await regOk(U.pm, e.pid);
    assert.deepStrictEqual([t1.period, t1.days_after_close], ['supplement', 2], '已终止、无状态事件：取 updated_at');
    const ins = (to, day) => sqlRun(
      "INSERT INTO sysbuild_events (project_id, object_type, object_id, event_type, payload_json, operator_id, operator_name, created_at) VALUES (?, 'project', ?, 'project_status_changed', ?, ?, 'x', ?)",
      [e.pid, e.pid, JSON.stringify({ from: 'x', to, reason: '用例' }), U.admin, `${shift(t0, day)} 08:00:00`]
    );
    await ins('terminated', -6);
    assert.strictEqual((await regOk(U.pm, e.pid)).days_after_close, 6, '终止事件优先于 updated_at');
    await ins('active', -4);
    await ins('terminated', -1);
    assert.strictEqual((await regOk(U.pm, e.pid)).days_after_close, 1, '以最后一条终止事件为准（终止 → 重开 → 再终止）');
    // 已暂停的项目整体登记仍是过程登记
    const pz = await mkScene();
    assert.strictEqual((await post(U.admin, `/sysbuild/projects/${pz.pid}/status`, { to: 'paused', reason: 'C5 用例' })).status, 200);
    assert.strictEqual((await regOk(U.pm, pz.pid)).period, 'process', '已暂停：项目整体仍是过程登记');
  });

  // ═══════════════════════ 2 项目状态 × 写登记 ═══════════════════════
  test(`${T_STATUS}——已终止 / 已结项只能写补充登记（过程登记 409 SYSBUILD_PROJECT_READONLY、补充登记 201）；已暂停两种都可；时段类别决定查哪一行`, async () => {
    // 已终止：先把一个节点置为已收口（夹具），再终止
    const s = await mkScene();
    const closedNode = await ordinaryBatchNode(s.pid);
    const openNode = await nodeId(s.pid, 'b_dev');
    await closeNode(closedNode, `${shift(today(), -2)} 09:00:00`);
    assert.strictEqual((await post(U.admin, `/sysbuild/projects/${s.pid}/status`, { to: 'terminated', reason: 'C5 用例' })).status, 200);
    expectErr(await reg(U.pm, s.pid, { node_id: openNode }), 409, 'SYSBUILD_PROJECT_READONLY', '已终止：过程登记（节点未收口）');
    // P95：项目整体登记在项目已终止时 = 补充登记（天数按终止日：取 admin 终止时写的状态事件；这里把事件时刻改成固定的 3 天前）
    await sqlRun("UPDATE sysbuild_events SET created_at = ? WHERE project_id = ? AND event_type = 'project_status_changed'", [`${shift(today(), -3)} 08:00:00`, s.pid]);
    const whole = await regOk(U.pm, s.pid);
    assert.deepStrictEqual([whole.period, whole.days_after_close, whole.node_id], ['supplement', 3, null], '已终止：项目整体登记 = 补充登记，天数按终止日');
    assert.strictEqual((await regOk(U.m1, s.pid)).period, 'supplement', '已终止：成员写项目整体补充登记');
    const sup = await regOk(U.pm, s.pid, { node_id: closedNode });
    assert.deepStrictEqual([sup.period, sup.days_after_close], ['supplement', 2], '已终止：补充登记');
    assert.strictEqual((await regOk(U.m1, s.pid, { node_id: closedNode })).period, 'supplement', '已终止：成员写补充登记');
    // 已结项（夹具）：项目整体 = 补充；未收口节点 = 过程 → 409
    const c = await mkScene();
    const cOpen = await nodeId(c.pid, 'b_dev');
    await sqlRun("UPDATE sysbuild_projects SET status = 'closed', updated_at = ? WHERE id = ?", [`${shift(today(), -4)} 09:00:00`, c.pid]);
    assert.deepStrictEqual([(await regOk(U.pm, c.pid)).period, (await regOk(U.pm, c.pid)).days_after_close], ['supplement', 4], '已结项：项目整体 = 补充登记');
    expectErr(await reg(U.pm, c.pid, { node_id: cOpen }), 409, 'SYSBUILD_PROJECT_READONLY', '已结项：未收口节点的过程登记');
    // 已暂停：过程与补充都可
    const p = await mkScene();
    const pClosed = await ordinaryBatchNode(p.pid);
    await closeNode(pClosed, `${shift(today(), -1)} 09:00:00`);
    assert.strictEqual((await post(U.admin, `/sysbuild/projects/${p.pid}/status`, { to: 'paused', reason: 'C5 用例' })).status, 200);
    assert.strictEqual((await regOk(U.pm, p.pid)).period, 'process');
    assert.strictEqual((await regOk(U.pm, p.pid, { node_id: pClosed })).period, 'supplement');
    // 项目 actions.create_entry：终止后仍为真（可写补充登记）；非成员只读账号为假
    const proj = await get(U.pm, `/sysbuild/projects/${s.pid}`);
    assert.strictEqual(proj.body.actions.create_entry, true, '已终止项目仍可写补充登记');
    assert.strictEqual((await get(U.ro, `/sysbuild/projects/${s.pid}`)).body.actions.create_entry, false, '只读账号为假');
    assert.strictEqual((await get(U.pm, `/sysbuild/projects/${s.pid}/entries`)).body.actions.create_entry, true);
  });

  // ═══════════════════════ 3 来源方与权限 ═══════════════════════
  test(`${T_WHO}——一般成员 / 负责人 / 代表人 / 内部成员 / PM / PM 代登 / admin 的来源方与身份快照；非 PM 填来源方 400；只读账号 403（含只读成员）、非成员 404`, async () => {
    const s = await mkScene();
    const snap = (e) => e.operator_identity;
    const m1 = await regOk(U.m1, s.pid);
    assert.deepStrictEqual([m1.source_party_id, m1.operator_user_id], [s.A.party, U.m1], '一般成员取其成员行的参与方');
    assert.deepStrictEqual(snap(m1), { is_admin: false, is_pm: false, is_owner: false, is_delegate: false, is_internal: false, member_id: s.mM1, party_id: s.A.party });
    const own = await regOk(U.own, s.pid);
    assert.strictEqual(own.source_party_id, s.A.party);
    assert.deepStrictEqual([snap(own).is_owner, snap(own).is_delegate, snap(own).is_internal], [true, false, false]);
    assert.strictEqual(snap(own).party_id, s.A.party, '负责人登记的身份快照 party_id（原只在被删的确认人解析用例里断言）');
    const del = await regOk(U.del, s.pid);
    assert.deepStrictEqual([del.source_party_id, snap(del).is_owner, snap(del).is_delegate], [s.A.party, false, true]);
    const dev = await regOk(U.x2, s.pid);
    assert.strictEqual(dev.source_party_id, s.D, '开发方代表人的来源方 = 开发方');
    const internal = await regOk(U.cand, s.pid);
    assert.strictEqual(internal.source_party_id, null, '内部成员来源方为空');
    assert.deepStrictEqual([snap(internal).is_internal, snap(internal).party_id, snap(internal).member_id], [true, null, s.mInt]);
    const pm = await regOk(U.pm, s.pid);
    assert.strictEqual(pm.source_party_id, null, 'PM 本人登记：来源方为空');
    assert.deepStrictEqual([snap(pm).is_pm, snap(pm).is_internal, snap(pm).is_admin], [true, false, false]);
    const proxy = await regOk(U.pm, s.pid, { source_party_id: s.A.party });
    assert.deepStrictEqual([proxy.source_party_id, proxy.operator_user_id, snap(proxy).is_pm], [s.A.party, U.pm, true], 'PM 代登：来源方 = 真实来源方，操作人 = PM');
    const proxyDev = await regOk(U.pm, s.pid, { source_party_id: s.D });
    assert.strictEqual(proxyDev.source_party_id, s.D);
    const admin = await regOk(U.admin, s.pid);
    assert.deepStrictEqual([admin.source_party_id, admin.operator_user_id, snap(admin).is_admin, snap(admin).member_id], [null, U.admin, true, null], 'admin 非成员：来源方为空，操作人记 admin');
    const row = await sqlGet('SELECT operator_user_id, source_party_id, operator_identity_snapshot FROM sysbuild_entries WHERE id = ?', [admin.id]);
    assert.strictEqual(row.operator_user_id, U.admin);
    assert.strictEqual(JSON.parse(row.operator_identity_snapshot).is_admin, true, '快照落库');
    // 非 PM 填来源方 → 400；PM 填别的项目的参与方 → 400
    for (const uid of [U.m1, U.own, U.del, U.cand, U.admin]) {
      const r = await reg(uid, s.pid, { source_party_id: s.A.party });
      expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', `非 PM（${uid}）填来源方`);
      assert.strictEqual(r.body.field, 'source_party_id');
    }
    const other = await mkScene();
    const bad = await reg(U.pm, s.pid, { source_party_id: other.A.party });
    expectErr(bad, 400, 'SYSBUILD_INVALID_INPUT', '别的项目的参与方');
    assert.strictEqual(bad.body.field, 'source_party_id');
    // 权限：只读账号（非成员）403、只读账号是成员也 403、非成员 404、PM 只读否决见 rules 用例
    expectErr(await reg(U.ro, s.pid), 403, 'SYSBUILD_FORBIDDEN', '只读账号（非成员）');
    expectErr(await reg(U.out, s.pid), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    const roMember = await addMember(s.pid, U.ro, { party: s.A.party });
    assert.ok(roMember > 0);
    expectErr(await reg(U.ro, s.pid), 403, 'SYSBUILD_FORBIDDEN', '只读账号是成员：一票否决');
    // 被拒的请求不留行
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE project_id = ? AND operator_user_id IN (?, ?)', [s.pid, U.ro, U.out]), 0);
    // L4：admin 同时是（非 PM 的）成员时，按成员行的参与方记来源方（操作人仍是 admin，快照 is_admin 与成员信息都在）；admin 成员行没有参与方时 = 内部成员口径（来源方空）
    const mAdm = await addMember(s.pid, U.admin, { party: s.A.party });
    const am = await regOk(U.admin, s.pid, { type: 'feedback' });
    assert.deepStrictEqual([am.source_party_id, am.operator_user_id], [s.A.party, U.admin], 'admin 兼成员：来源方取成员行的参与方');
    assert.deepStrictEqual(snap(am), { is_admin: true, is_pm: false, is_owner: false, is_delegate: false, is_internal: false, member_id: mAdm, party_id: s.A.party });
    const sAdm = await mkScene();
    await addMember(sAdm.pid, U.admin);
    const am2 = await regOk(U.admin, sAdm.pid, { type: 'feedback' });
    assert.deepStrictEqual([am2.source_party_id, snap(am2).is_internal, snap(am2).is_admin], [null, true, true], 'admin 兼成员（无参与方）：来源方空');
    // 未加入与已移出的账号都不能写登记。
    const s2 = await mkScene();
    expectErr(await reg(U.out, s2.pid), 404, 'SYSBUILD_NOT_FOUND', '没有成员行');
    const gone = await newProject();
    await addMember(gone, U.out, { removed: true });
    expectErr(await reg(U.out, gone), 404, 'SYSBUILD_NOT_FOUND', '已移出的成员行');
  });

  // ═══════════════════════ 4 证据 ═══════════════════════
  test(`${T_EVID}——补交材料必有附件（无附件 400 SYSBUILD_EVIDENCE_REQUIRED，「无书面证据」不能代替）；无书面证据原因 ≥10 字、附件与声明互斥、附件在同一事务绑定为 entry`, async () => {
    const s = await mkScene();
    const noAtt = await reg(U.m1, s.pid, { type: 'material' });
    expectErr(noAtt, 400, 'SYSBUILD_EVIDENCE_REQUIRED', '补交材料无附件');
    expectErr(await reg(U.m1, s.pid, { type: 'material', no_written_evidence: true, no_evidence_reason: '口头说明，没有任何书面材料' }), 400, 'SYSBUILD_EVIDENCE_REQUIRED', '补交材料声明无书面证据也不行');
    const a1 = await stageAtt(s.pid, U.m1, 'a');
    const mat = await regOk(U.m1, s.pid, { type: 'material', attachment_ids: [a1] });
    assert.strictEqual(mat.attachments.length, 1);
    assert.strictEqual(mat.attachments[0].attachment_id, a1);
    const bind = await sqlGet('SELECT owner_type, owner_id, bound_by FROM sysbuild_attachment_bindings WHERE attachment_id = ?', [a1]);
    assert.deepStrictEqual([bind.owner_type, bind.owner_id, bind.bound_by], ['entry', mat.id, U.m1], '附件绑定为 entry');
    assert.strictEqual((await eventsOfType(s.pid, 'attachment_bound')).filter((e) => JSON.parse(e.payload_json).owner_type === 'entry').length, 1);
    // 同一附件不能再用于第二条登记
    const again = await reg(U.m1, s.pid, { type: 'material', attachment_ids: [a1] });
    expectErr(again, 400, 'SYSBUILD_INVALID_INPUT', '附件重复使用');
    assert.strictEqual(again.body.field, 'attachment_ids');
    // 可选模式同一套规则：无书面证据原因 ≥ 10 字、附件与声明互斥（影响里程碑的进度汇报的方向类证据由 trace-l2 套件「C6 R6」用例守）
    const R9 = '九个字的原因啊啊啊';
    const R10 = '十个字的原因啊啊啊啊';
    assert.deepStrictEqual([Array.from(R9).length, Array.from(R10).length], [9, 10], '手写的 9 字 / 10 字原因');
    const r9 = await reg(U.m1, s.pid, { type: 'feedback', no_written_evidence: true, no_evidence_reason: R9 });
    expectErr(r9, 400, 'SYSBUILD_INVALID_INPUT', '无书面证据原因 9 字');
    assert.strictEqual(r9.body.field, 'no_evidence_reason');
    const r10 = await regOk(U.m1, s.pid, { type: 'feedback', no_written_evidence: true, no_evidence_reason: R10 });
    assert.deepStrictEqual([r10.no_written_evidence, r10.no_evidence_reason], [true, R10]);
    const a2 = await stageAtt(s.pid, U.m1, 'b');
    const withAtt = await regOk(U.m1, s.pid, { type: 'feedback', attachment_ids: [a2] });
    assert.deepStrictEqual([withAtt.no_written_evidence, withAtt.attachments.length], [false, 1]);
    // 互斥与形态：有附件又声明无书面证据 400；未声明却写原因 400；声明非布尔 400
    const a3 = await stageAtt(s.pid, U.m1, 'd');
    const both = await reg(U.m1, s.pid, { type: 'feedback', attachment_ids: [a3], no_written_evidence: true, no_evidence_reason: R10 });
    expectErr(both, 400, 'SYSBUILD_INVALID_INPUT', '附件与声明互斥');
    assert.strictEqual(both.body.field, 'no_written_evidence');
    const rsn = await reg(U.m1, s.pid, { type: 'feedback', no_evidence_reason: R10 });
    expectErr(rsn, 400, 'SYSBUILD_INVALID_INPUT', '未声明却写原因');
    assert.strictEqual(rsn.body.field, 'no_evidence_reason');
    expectErr(await reg(U.m1, s.pid, { type: 'feedback', no_written_evidence: 'yes' }), 400, 'SYSBUILD_INVALID_INPUT', '声明非布尔');
    // 其余类型证据可选：无附件、无声明也成功
    for (const type of ['note', 'lesson', 'benefit', 'feedback', 'issue']) assert.strictEqual((await regOk(U.m1, s.pid, { type })).no_written_evidence, false, `${type} 证据可选`);
    // 失败的登记不留半截数据：没有登记行、附件仍可用于后续成功的登记
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_attachment_bindings WHERE attachment_id = ?', [a3])).n, 0, '被拒的请求不绑定附件');
    assert.strictEqual((await regOk(U.m1, s.pid, { type: 'material', attachment_ids: [a3] })).attachments.length, 1);
  });

  // ═══════════════════════ 5 字段校验 ═══════════════════════
  test(`${T_FIELDS}——purpose 越界 400（只收 general，F7；dev_note / deliverable 的矩阵在 C6 R9 用例）；type 更正 / 越界 400；键白名单、标题 / 内容 / 业务日期 / 节点的形态；业务日期不晚于今天`, async () => {
    const s = await mkScene();
    const bad = async (extra, field, label) => {
      const r = await reg(U.pm, s.pid, extra);
      expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', label);
      assert.strictEqual(r.body.field, field, `${label} 的 field`);
    };
    await bad({ type: 'correction' }, 'type', '更正不作独立登记');
    await bad({ type: 'bogus' }, 'type', '类型越界');
    await bad({ type: undefined }, 'type', '缺类型');
    await bad({ purpose: 'bogus' }, 'purpose', '用途越界');
    await bad({ title: '' }, 'title', '标题空');
    await bad({ title: 'x'.repeat(101) }, 'title', '标题 101 字');
    await bad({ body: '   ' }, 'body', '内容空白');
    await bad({ body: 'x'.repeat(4001) }, 'body', '内容 4001 字');
    await bad({ title: '含控制字符\u0007' }, 'title', '标题含控制字符');
    await bad({ business_date: '2026-13-01' }, 'business_date', '业务日期月份 13');
    await bad({ business_date: shift(today(), 1) }, 'business_date', '业务日期晚于今天');
    await bad({ node_id: 'abc' }, 'node_id', '节点编号非法');
    await bad({ node_id: 99999999 }, 'node_id', '节点不存在');
    await bad({ attachment_ids: [1, 1] }, 'attachment_ids', '附件编号重复');
    await bad({ bogus: 1 }, 'bogus', '多余键');
    const arr = await post(U.pm, `/sysbuild/projects/${s.pid}/entries`, []);
    expectErr(arr, 400, 'SYSBUILD_INVALID_INPUT', '请求体是数组');
    assert.strictEqual(arr.body.field, 'body');
    // 节点属于别的项目 → 400；已取消的节点 → 409
    const other = await mkScene();
    await bad({ node_id: await ordinaryBatchNode(other.pid) }, 'node_id', '别的项目的节点');
    const cn = await nodeId(s.pid, 'b_dev');
    await sqlRun("UPDATE sysbuild_nodes SET status = 'cancelled' WHERE id = ?", [cn]);
    expectErr(await reg(U.pm, s.pid, { node_id: cn }), 409, 'SYSBUILD_STATE', '已取消的节点');
    // 用途只收 general：dev_note / deliverable 与其它值一律 400 field=purpose（R9，F7；dev_note / deliverable 的逐身份矩阵在「C6 R9」用例）
    const beforeRejectedPurpose = await countOf('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE project_id = ?', [s.pid]);
    for (const purpose of ['bogus', 7, '']) expectErr(await reg(U.x2, s.pid, { purpose }), 400, 'SYSBUILD_INVALID_INPUT', `用途 ${JSON.stringify(purpose)}`);
    assert.strictEqual((await regOk(U.pm, s.pid, { purpose: 'general', business_date: today(), title: '  带空白  ' })).title, '带空白', '一般用途、业务日期 = 今天、标题 trim');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_entries WHERE project_id = ?", [s.pid]), beforeRejectedPurpose + 1, '被拒的用途不留行');
    // 边界：标题 100 字、内容 4000 字通过
    const edge = await regOk(U.pm, s.pid, { title: 'x'.repeat(100), body: 'y'.repeat(4000) });
    assert.deepStrictEqual([Array.from(edge.title).length, Array.from(edge.body).length], [100, 4000]);
    const ev = (await eventsOfType(s.pid, 'entry_created')).map((e) => JSON.parse(e.payload_json));
    assert.ok(ev.length >= 2 && ev.every((p) => typeof p.period === 'string'), '每条登记一条 entry_created 事件');
  });

  // ═══════════════════════ 11b 终止分类表 ═══════════════════════
  test(`${T_CLASS}——confirm-core 的「终止失效 / 终止保留」两张表把 schema 的每个确认用途恰好分到一张（手写全集核对）；加载断言：漏登记、重复登记、多出表外用途的副本加载即抛错；原样加载不抛`, async () => {
    const C = T.getMods().confirmCore;
    assert.deepStrictEqual([...C.INVALIDATED_ON_TERMINATE_PURPOSES], ['package_confirm']);
    assert.deepStrictEqual([...C.RETAINED_ON_TERMINATE_PURPOSES], []);
    // 纯函数：全分类才通过
    const A = C.assertTerminatePurposeClassification;
    assert.doesNotThrow(() => A(['a', 'b'], ['a'], ['b']));
    assert.throws(() => A(['a', 'b'], ['a'], []), (e) => /b/.test(e.message) && /都没有登记/.test(e.message), '漏登记');
    assert.throws(() => A(['a'], ['a'], ['a']), (e) => /重复登记/.test(e.message), '两张表都有');
    assert.throws(() => A(['a'], ['a', 'z'], []), (e) => /z/.test(e.message) && /不是 schema/.test(e.message), '表里有 schema 之外的用途');
    assert.throws(() => A(['a'], ['a'], ['z']), (e) => /z/.test(e.message), '保留表里有 schema 之外的用途');
    // 加载断言：把 confirm-core.js 副本里的两张表改坏后编译，加载必须抛错；原样编译不抛
    const Module = require('module');
    const fs = require('fs');
    const path = require('path');
    const dir = T.getModuleDir();
    const file = path.join(dir, 'confirm-core.js');
    const src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const load = (text) => {
      const m = new Module(file, module);
      m.filename = file;
      m.paths = Module._nodeModulePaths(dir);
      m._compile(text, file);
      return m.exports;
    };
    const retained = "const RETAINED_ON_TERMINATE_PURPOSES = Object.freeze([]);";
    const invalidated = "const INVALIDATED_ON_TERMINATE_PURPOSES = Object.freeze(['package_confirm']);";
    assert.strictEqual(src.split(retained).length - 1, 1);
    assert.strictEqual(src.split(invalidated).length - 1, 1);
    assert.doesNotThrow(() => load(src));
    assert.throws(() => load(src.replace(invalidated, "const INVALIDATED_ON_TERMINATE_PURPOSES = Object.freeze([]);")), /package_confirm/);
    assert.throws(() => load(src.replace(retained, "const RETAINED_ON_TERMINATE_PURPOSES = Object.freeze(['package_confirm']);")), /重复登记/);
    assert.throws(() => load(src.replace(retained, "const RETAINED_ON_TERMINATE_PURPOSES = Object.freeze(['unknown_purpose']);")), /不是 schema/);

  });

  // ═══════════════════════ 14 actions 同源 ═══════════════════════
  test(`${T_FLAGS}——逐对象 actions：两种登记状态 × 两个动作（更正 / 作废）× PM / 登记人 / 其他成员 / 只读账号 / admin 未接管，标志手写（键集合只有 correct、void）；标志为真执行 201，为假执行 403 / 409（同一判定）`, async () => {
    const s = await mkScene();
    const BODY = {
      correct: { action: 'correct', text: '更正内容' }, void: { action: 'void', reason: '作废原因' },
    };
    const flagsOf = (list) => { const o = {}; for (const a of ACTION_NAMES) o[a] = list.includes(a); return o; };
    const factories = {
      none: async () => regOk(U.m1, s.pid, { type: 'feedback' }),
      voided: async () => {
        const e = await regOk(U.m1, s.pid, { type: 'feedback' });
        await actOk(U.pm, e.id, { action: 'void', reason: '作废' });
        return e;
      },
    };
    // 手写期望（PM）：state → 为真的动作
    const PM_TRUE = {
      none: ['correct', 'void'],
      voided: [],
    };
    // 登记人 m1：只有更正 / 作废可能为真；其他成员 m2：全假；只读账号 ro：全假
    const OWNER_TRUE = { none: ['correct', 'void'], voided: [] };
    for (const [state, make] of Object.entries(factories)) {
      for (const [role, uid, table] of [['PM', U.pm, PM_TRUE], ['登记人', U.m1, OWNER_TRUE], ['其他成员', U.m2, null], ['只读账号', U.ro, null], ['admin 未接管', U.admin, null]]) {
        const want = flagsOf(table ? table[state] : []);
        // 其他视角（其他成员 / 只读账号 / admin 未接管）标志全假：两个动作都发请求，权限先于对象状态一律 403（未接管的 admin 对 correct 也断言 403，原只核标志）
        for (const name of ACTION_NAMES) {
          const e = await make();
          const d = await detail(uid, e.id);
          assert.deepStrictEqual(d.actions, want, `${state} × ${role}：actions 手写期望（键集合只有 correct、void）`);
          const r = await act(uid, e.id, BODY[name]);
          if (want[name]) assert.strictEqual(r.status, 201, `${state} × ${role} × ${name}：标志为真应成功 ${r.text}`);
          else assert.ok(r.status === 403 || r.status === 409, `${state} × ${role} × ${name}：标志为假应 403 / 409，实际 ${r.status} ${r.text}`);
          // 没有权限的视角（其他成员 / 只读账号 / admin 未接管）一律 403，权限先于对象状态
          if (!want[name] && (role !== '登记人' || !['correct', 'void'].includes(name)) && role !== 'PM') assert.strictEqual(r.status, 403, `${state} × ${role} × ${name}：没有权限一律 403（权限先于状态）`);
        }
      }
    }
    // 项目状态：已终止项目里 resolve 类动作的标志仍按对象状态给出（四态都允许）
    const e = await factories.none();
    assert.strictEqual((await post(U.admin, `/sysbuild/projects/${s.pid}/status`, { to: 'terminated', reason: 'C5 用例' })).status, 200);
    assert.deepStrictEqual((await detail(U.pm, e.id)).actions, flagsOf(PM_TRUE.none), '已终止项目：标志不变');
    assert.strictEqual((await act(U.pm, e.id, BODY.correct)).status, 201, '已终止项目：PM 仍可办理');
  });

  // ═══════════════════════ 15 更正与作废 ═══════════════════════
  test(`${T_VOID}——更正 / 作废：登记人本人与 PM 可、他人 403；更正只追加不改原文；作废需原因；作废后一切办理 409（被拒不写入），列表仍显示`, async () => {
    const s = await mkScene();
    const e = await regOk(U.m1, s.pid, { type: 'feedback', title: '原标题', body: '原文' });
    expectErr(await act(U.m2, e.id, { action: 'correct', text: '别人的更正' }), 403, 'SYSBUILD_FORBIDDEN', '他人更正');
    expectErr(await act(U.m2, e.id, { action: 'void', reason: '别人作废' }), 403, 'SYSBUILD_FORBIDDEN', '他人作废');
    expectErr(await act(U.own, e.id, { action: 'void', reason: '负责人也不能作废别人的' }), 403, 'SYSBUILD_FORBIDDEN', '负责人作废他人的登记');
    expectErr(await act(U.ro, e.id, { action: 'correct', text: '只读' }), 403, 'SYSBUILD_FORBIDDEN', '只读账号');
    expectErr(await act(U.out, e.id, { action: 'correct', text: '非成员' }), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    expectErr(await act(U.m1, e.id, { action: 'correct' }), 400, 'SYSBUILD_INVALID_INPUT', '更正缺内容');
    expectErr(await act(U.m1, e.id, { action: 'void' }), 400, 'SYSBUILD_INVALID_INPUT', '作废缺原因');
    const c1 = await actOk(U.m1, e.id, { action: 'correct', text: '更正：标题应为 X' });
    const c2 = await actOk(U.pm, e.id, { action: 'correct', text: 'PM 补充更正' });
    assert.deepStrictEqual([c2.entry.title, c2.entry.body], ['原标题', '原文'], '原文不改');
    assert.deepStrictEqual(c2.entry.records.filter((r) => r.action === 'correct').map((r) => [r.id, r.text, r.created_by]), [[c1.action_id, '更正：标题应为 X', U.m1], [c2.action_id, 'PM 补充更正', U.pm]]);
    assert.strictEqual((await sqlGet('SELECT title FROM sysbuild_entries WHERE id = ?', [e.id])).title, '原标题', '库里的登记原文未被 UPDATE');
    assert.strictEqual(c2.entry.voided, false, '更正不改作废状态');
    // 登记人本人作废（登记时不是 PM，进行中项目）；作废后一切办理 409 且被拒不写入
    const e3 = await regOk(U.m1, s.pid, { type: 'feedback' });
    const v = await actOk(U.m1, e3.id, { action: 'void', reason: '提错了' });
    assert.strictEqual(v.entry.voided, true);
    const writeState = async () => ({
      actions: await sqlAll('SELECT * FROM sysbuild_entry_actions WHERE entry_id = ? ORDER BY id', [e3.id]),
      events: (await sqlGet("SELECT COUNT(*) AS n FROM sysbuild_events WHERE object_type = 'entry' AND object_id = ?", [e3.id])).n,
      row: await sqlGet('SELECT * FROM sysbuild_entries WHERE id = ?', [e3.id]),
    });
    const before = await writeState();
    // 作废后：一切办理 409；列表默认仍显示并标已作废
    for (const name of ['correct', 'void']) {
      const body = { correct: { action: 'correct', text: 'x' }, void: { action: 'void', reason: 'x' } }[name];
      const r = await act(U.pm, e3.id, body);
      expectErr(r, 409, 'SYSBUILD_STATE', `作废后 ${name}`);
      assert.ok(r.body.message.includes('已作废'), r.body.message);
    }
    assert.deepStrictEqual(await writeState(), before, '被拒的办理不写办理记录、不发事件、不改登记行');
    const list = await get(U.pm, `/sysbuild/projects/${s.pid}/entries`);
    const row = list.body.entries.find((x) => x.id === e3.id);
    assert.strictEqual(row.voided, true, '列表仍显示并标已作废');
    // 他人的登记同样：PM 也可作废他人的
    const e4 = await regOk(U.m1, s.pid, { type: 'note' });
    assert.strictEqual((await actOk(U.pm, e4.id, { action: 'void', reason: 'PM 作废' })).entry.voided, true);
    // PM 作废他人的登记（旧版 P94 的未结异议拦截随 C6 删，无旧库状态的对照另见「C6 P-W8」用例）
    expectErr(await act(U.m2, e4.id, { action: 'correct', text: '作废后更正' }), 403, 'SYSBUILD_FORBIDDEN', '他人 403 先于对象状态');
  });

  // ═══════════════════════ 17 读接口 ═══════════════════════
  test(`${T_READ}——列表按 node / period / type / party 筛选（最新在前，非法值 400，非成员 404，只读账号可读）；详情含附件、办理记录与登记人名`, async () => {
    const s = await mkScene();
    const n1 = await ordinaryBatchNode(s.pid);
    const n2 = await nodeId(s.pid, 'b_dev');
    await closeNode(n2, `${shift(today(), -2)} 09:00:00`);
    const a = await regOk(U.m1, s.pid, { type: 'feedback', node_id: n1 });
    const b = await regOk(U.x2, s.pid, { type: 'issue', node_id: n2 });
    const c = await regOk(U.pm, s.pid, { type: 'note' });
    const d = await regOk(U.cand, s.pid, { type: 'lesson', node_id: n2 });
    const ids = (r) => r.body.entries.map((x) => x.id);
    const base = `/sysbuild/projects/${s.pid}/entries`;
    assert.deepStrictEqual(ids(await get(U.pm, base)), [d.id, c.id, b.id, a.id], '最新在前');
    assert.deepStrictEqual(ids(await get(U.pm, `${base}?node=${n1}`)), [a.id]);
    assert.deepStrictEqual(ids(await get(U.pm, `${base}?node=${n2}`)), [d.id, b.id]);
    assert.deepStrictEqual(ids(await get(U.pm, `${base}?period=supplement`)), [d.id, b.id]);
    assert.deepStrictEqual(ids(await get(U.pm, `${base}?period=process`)), [c.id, a.id]);
    assert.deepStrictEqual(ids(await get(U.pm, `${base}?type=issue`)), [b.id]);
    assert.deepStrictEqual(ids(await get(U.pm, `${base}?party=${s.D}`)), [b.id]);
    assert.deepStrictEqual(ids(await get(U.pm, `${base}?party=${s.A.party}`)), [a.id]);
    assert.deepStrictEqual(ids(await get(U.pm, `${base}?period=supplement&type=lesson&node=${n2}`)), [d.id], '多条件取交集');
    for (const q of ['period=bogus', 'type=bogus', 'node=abc', 'party=0']) {
      const r = await get(U.pm, `${base}?${q}`);
      expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', q);
    }
    expectErr(await get(U.out, base), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    expectErr(await get(U.pm, '/sysbuild/projects/abc/entries'), 400, 'SYSBUILD_INVALID_INPUT', '项目编号非法');
    expectErr(await get(U.pm, '/sysbuild/projects/99999999/entries'), 404, 'SYSBUILD_NOT_FOUND', '项目不存在');
    const ro = await get(U.ro, base);
    assert.strictEqual(ro.status, 200, '只读账号可读');
    assert.strictEqual(ro.body.entries.length, 4);
    assert.strictEqual(ro.body.actions.create_entry, false);
    assert.ok(ro.body.entries.every((x) => isDeepStrictEqual(x.actions, { correct: false, void: false })), '只读账号逐对象 actions 全假且键集合只有 correct / void');
    // 别的项目的登记不出现
    const other = await mkScene();
    await regOk(U.pm, other.pid, { type: 'note' });
    assert.strictEqual((await get(U.pm, base)).body.entries.length, 4);
    // 详情
    const att = await stageAtt(s.pid, U.m1, 'a');
    const full = await regOk(U.m1, s.pid, { type: 'feedback', attachment_ids: [att] });
    await actOk(U.pm, full.id, { action: 'correct', text: '更正' });
    const dt = await detail(U.ro, full.id);
    assert.deepStrictEqual(dt.attachments.map((x) => [x.attachment_id, x.masked, x.deleted, x.original_name]), [[att, false, false, '确认证据.txt']]);
    assert.strictEqual(dt.attachments[0].sha256, 'a'.repeat(64));
    assert.deepStrictEqual(dt.records.map((x) => [x.action, x.created_by]), [['correct', U.pm]]);
    const m1Name = (await sqlGet('SELECT COALESCE(display_name, username) AS n FROM users WHERE id = ?', [U.m1])).n;
    assert.strictEqual(dt.operator_name, m1Name, 'operator_name = 登记人 m1 的显示名');
    // 详情：非法编号 400、不存在 404、非成员 404
    expectErr(await get(U.pm, '/sysbuild/entries/abc'), 400, 'SYSBUILD_INVALID_INPUT', '编号非法');
    expectErr(await get(U.pm, '/sysbuild/entries/99999999'), 404, 'SYSBUILD_NOT_FOUND', '不存在');
    expectErr(await get(U.out, `/sysbuild/entries/${a.id}`), 404, 'SYSBUILD_NOT_FOUND', '非成员');
  });

  // ═══════════════════════ 18 检查顺序 ═══════════════════════
  test(`${T_ORDER}——参数 400 → 对象 404 → 可见 404 → 权限 403 → 项目状态 409 → 对象状态 409；已终止项目里非 PM 先 403；办理 resolve 类（更正 / 作废）在已终止 / 已结项 / 已暂停都不被项目状态拒绝`, async () => {
    const s = await mkScene();
    const e = await regOk(U.m1, s.pid, { type: 'feedback' });
    const CORRECT = { action: 'correct', text: 'x' };
    // 400 先于 404：不存在的登记 + 非法动作体 → 400
    expectErr(await act(U.pm, 99999999, { action: 'bogus' }), 400, 'SYSBUILD_INVALID_INPUT', '参数先于对象');
    expectErr(await act(U.pm, 99999999, CORRECT), 404, 'SYSBUILD_NOT_FOUND', '对象不存在');
    expectErr(await act(U.pm, 'abc', CORRECT), 400, 'SYSBUILD_INVALID_INPUT', '编号非法');
    expectErr(await act(U.out, e.id, CORRECT), 404, 'SYSBUILD_NOT_FOUND', '非成员先 404');
    expectErr(await act(U.m2, e.id, CORRECT), 403, 'SYSBUILD_FORBIDDEN', '成员无权先 403');
    // 写登记：参数 400 先于 404；404 先于 403
    expectErr(await reg(U.out, s.pid, { type: 'bogus' }), 400, 'SYSBUILD_INVALID_INPUT', '参数先于可见性');
    expectErr(await reg(U.out, s.pid), 404, 'SYSBUILD_NOT_FOUND', '非成员 404');
    expectErr(await reg(U.ro, s.pid), 403, 'SYSBUILD_FORBIDDEN', '只读 403');
    // 已终止项目：写过程登记，只读账号仍是 403（权限先于项目状态）；成员是 409
    assert.strictEqual((await post(U.admin, `/sysbuild/projects/${s.pid}/status`, { to: 'terminated', reason: 'C5 用例' })).status, 200);
    expectErr(await reg(U.ro, s.pid), 403, 'SYSBUILD_FORBIDDEN', '终止后只读账号：权限先于项目状态');
    expectErr(await reg(U.m1, s.pid, { node_id: await nodeId(s.pid, 'b_dev') }), 409, 'SYSBUILD_PROJECT_READONLY', '终止后成员：未收口节点的过程登记看项目状态');
    assert.strictEqual((await reg(U.m1, s.pid)).status, 201, '终止后项目整体登记 = 补充登记（P95）');
    // 办理（resolve）在已终止项目里不被项目状态拒绝；权限仍先
    expectErr(await act(U.m2, e.id, CORRECT), 403, 'SYSBUILD_FORBIDDEN', '终止后成员无权');
    assert.strictEqual((await act(U.pm, e.id, CORRECT)).status, 201, '终止后 PM 对登记 correct 201');
    // 已结项（夹具）、已暂停：同样；作废不可逆，每个状态用各自的新场景
    for (const st of ['closed', 'paused']) {
      const p = await mkScene();
      const pe = await regOk(U.m1, p.pid, { type: 'feedback' });
      if (st === 'closed') await sqlRun("UPDATE sysbuild_projects SET status = 'closed' WHERE id = ?", [p.pid]);
      else assert.strictEqual((await post(U.admin, `/sysbuild/projects/${p.pid}/status`, { to: 'paused', reason: 'C5 用例' })).status, 200);
      assert.strictEqual((await act(U.pm, pe.id, { action: 'void', reason: 'x' })).status, 201, `${st}：PM 可作废（resolve 类不被项目状态拒绝）`);
    }
  });

  // ═══════════════════════ 19 rules 矩阵与纯函数 ═══════════════════════
  test(`${T_RULES}——手写判定矩阵：写登记两类 × 四种项目状态；办理动作（更正 / 作废）的权限 / 对象状态；deriveEntryState 纯函数各路径`, async () => {
    const R = T.getMods().rules;
    const E = T.getMods().entries;
    const idn = (o) => Object.assign({ isPm: false, isAdmin: false, isReadonly: false, isMember: false, userId: 50, ownerOfParties: [], delegateOfParties: [] }, o);
    const prj = (st) => ({ id: 1, status: st });
    const chk = (op, i, st, t) => R.checkOp(op, i, prj(st || 'active'), t || {});
    const code = (v) => (v === null ? null : `${v.status}:${v.code}`);
    // 写登记：admin / PM / 成员可；只读账号一票否决；非成员（也非 admin）403
    for (const op of ['entry_create_process', 'entry_create_supplement']) {
      assert.strictEqual(chk(op, idn({ isMember: true })), null, `${op} 成员`);
      assert.strictEqual(chk(op, idn({ isAdmin: true })), null, `${op} admin 非成员`);
      assert.strictEqual(chk(op, idn({ isPm: true, isMember: true })), null, `${op} PM`);
      assert.strictEqual(code(chk(op, idn({ isMember: true, isReadonly: true }))), '403:SYSBUILD_FORBIDDEN', `${op} 只读成员`);
      assert.strictEqual(code(chk(op, idn({ isAdmin: true, isReadonly: true }))), '403:SYSBUILD_FORBIDDEN', `${op} 只读 admin`);
      assert.strictEqual(code(chk(op, idn({}))), '403:SYSBUILD_FORBIDDEN', `${op} 非成员`);
    }
    const table = { process: { active: null, paused: null, terminated: '409:SYSBUILD_PROJECT_READONLY', closed: '409:SYSBUILD_PROJECT_READONLY' }, supplement: { active: null, paused: null, terminated: null, closed: null } };
    for (const [period, row] of Object.entries(table)) {
      for (const [st, want] of Object.entries(row)) assert.strictEqual(code(chk(`entry_create_${period}`, idn({ isMember: true }), st)), want, `写登记 ${period} × ${st}`);
    }
    // 办理动作（C6 起只有更正与作废）：target 只剩 isRegistrant / registrantWasPm / voided / type
    const pm = idn({ isPm: true, isMember: true });
    const base = { isRegistrant: false, registrantWasPm: false, voided: false, type: 'feedback' };
    const T0 = (o) => Object.assign({}, base, o || {});
    // 更正 / 作废：登记人本人与 PM；只读一票否决
    const reg1 = idn({ isMember: true });
    assert.strictEqual(chk('entry_correct', reg1, 'active', T0({ isRegistrant: true })), null);
    assert.strictEqual(code(chk('entry_correct', reg1, 'active', T0())), '403:SYSBUILD_FORBIDDEN');
    assert.strictEqual(code(chk('entry_correct', idn({ isMember: true, isReadonly: true }), 'active', T0({ isRegistrant: true }))), '403:SYSBUILD_FORBIDDEN', '只读登记人');
    assert.strictEqual(chk('entry_correct', pm, 'closed', T0()), null);
    assert.strictEqual(chk('entry_void', reg1, 'terminated', T0({ isRegistrant: true })), null, '登记人本人可作废（已终止项目）');
    assert.strictEqual(chk('entry_void', idn({ isMember: true }), 'active', T0({ isRegistrant: true })), null, '登记人本人可作废（进行中）');
    assert.strictEqual(chk('entry_void', pm, 'active', T0()), null, 'PM 可作废他人的登记');
    assert.strictEqual(chk('entry_void', pm, 'active', T0({ isRegistrant: true, registrantWasPm: true })), null, 'PM 代登的登记 PM 可作废');
    assert.strictEqual(code(chk('entry_void', reg1, 'active', T0())), '403:SYSBUILD_FORBIDDEN', '他人不能作废');
    assert.strictEqual(code(chk('entry_correct', pm, 'active', T0({ voided: true }))), '409:SYSBUILD_STATE');
    assert.strictEqual(code(chk('entry_correct', pm, 'active', T0({ voided: undefined }))), '409:SYSBUILD_STATE', 'voided 事实没取到 fail-closed');
    assert.strictEqual(code(chk('entry_void', pm, 'active', T0({ voided: true }))), '409:SYSBUILD_STATE', '已作废不能再作废');
    // 派生状态纯函数：C6 起 deriveEntryState(entry, actions) 只返回 { voided }
    const ent = () => ({});
    const a = (id, action) => ({ id, action });
    const d = (entry, actions) => E.deriveEntryState(entry, actions);
    assert.deepStrictEqual(d(ent(), []), { voided: false });
    assert.deepStrictEqual(d(ent(), [a(1, 'void')]), { voided: true });
    assert.strictEqual(d(ent(), [a(1, 'void'), a(2, 'correct')]).voided, true);
    assert.strictEqual(d(ent(), [a(1, 'correct')]).voided, false, '更正不改作废状态');
    // 日期差
    const ise = (e) => e && e.status === 500 && e.code === 'SYSBUILD_INTERNAL';
    assert.deepStrictEqual([E.daysBetween('2026-11-10 09:00:00', '2026-11-15'), E.daysBetween('2026-11-15', '2026-11-15'), E.daysBetween('2026-11-16', '2026-11-15'), E.daysBetween('2026-02-28', '2026-03-01')], [5, 0, 0, 1]);
    assert.throws(() => E.daysBetween('abc', '2026-11-15'), ise);
  });

  // ═══════════════════════ 20 只追加 ═══════════════════════
  test(`${T_ONLY}——登记与办理记录只追加：全部办理动作（更正、作废）之后登记行、办理记录行不被改写`, async () => {
    const s = await mkScene();
    const e = await regOk(U.m1, s.pid, { type: 'issue', title: '原标题', body: '原文' });
    const snap = async () => JSON.stringify(await sqlGet('SELECT * FROM sysbuild_entries WHERE id = ?', [e.id]));
    const before = await snap();
    const c = await actOk(U.m1, e.id, { action: 'correct', text: '更正' });
    const actionRow = async (id) => JSON.stringify(await sqlGet('SELECT * FROM sysbuild_entry_actions WHERE id = ?', [id]));
    const correctRow = await actionRow(c.action_id);
    await actOk(U.pm, e.id, { action: 'void', reason: '作废' });
    assert.strictEqual(await snap(), before, '登记行一字未改');
    assert.strictEqual(await actionRow(c.action_id), correctRow, '旧办理记录不被后续作废改写（整行全等）');
    const rows = await actionsRows(e.id);
    assert.deepStrictEqual(rows.map((r) => r.action), ['correct', 'void']);
    assert.ok(rows.every((r, i) => i === 0 || r.id > rows[i - 1].id));
  });

  // ═══════════════════════ C6 新增（生效清单 4.3 第 6 / 7 条与 R9）═══════════════════════
  //   以下四个用例都按「先采集后汇总」：全部请求先发完记进 REC（键 = 请求标签），再逐项带标签断言，每条各自判红绿，不在第一条失败处停。

  // ── 第 6 条：P-W8（旧库状态下作废不再受结论 / 引用 / 异议拦截；主会话自决，待追认）──
  test(`${T_C6_PW8}——登记人可作废自己的登记，PM 可作废他人的登记，保留附件与事件`, async () => {
    const s = await mkScene();
    const aid = await stageAtt(s.pid, U.m1, 'a');
    for (const [who, extra] of [[U.m1, {}], [U.pm, { attachment_ids: [aid] }]]) {
      const entry = await regOk(U.m1, s.pid, { type: 'feedback', ...extra });
      const entryEvents = () => sqlAll("SELECT event_type, payload_json FROM sysbuild_events WHERE object_type = 'entry' AND object_id = ? ORDER BY id", [entry.id]);
      const before = await entryEvents();
      const result = await act(who, entry.id, { action: 'void', reason: '作废登记' });
      assert.strictEqual(result.status, 201, result.text);
      assert.strictEqual(result.body.entry.voided, true);
      assert.deepStrictEqual(Object.keys(result.body).sort(), ['action_id', 'entry']);
      assert.strictEqual(result.body.entry.attachments.length, who === U.pm ? 1 : 0);
      if (who === U.pm) {
        assert.strictEqual(Object.keys(result.body.entry.attachments[0]).length, 16);
        assert.ok(!('from_parent' in result.body.entry.attachments[0]));
      }
      const events = await entryEvents();
      assert.deepStrictEqual(events.slice(0, before.length), before);
      assert.deepStrictEqual(events.slice(before.length).map((event) => [event.event_type, JSON.parse(event.payload_json)]),
        [['entry_action_recorded', { action_id: result.body.action_id, action: 'void' }]]);
      for (const request of [{ action: 'correct', text: '重复办理' }, { action: 'void', reason: '重复办理' }]) {
        const rejected = await act(U.pm, entry.id, request);
        expectErr(rejected, 409, 'SYSBUILD_STATE');
        assert.strictEqual(rejected.body.message, '登记已作废，不能再办理');
      }
      assert.deepStrictEqual(await entryEvents(), events, '重复办理被拒后没有新增事件');
      const list = await get(U.pm, `/sysbuild/projects/${s.pid}/entries`);
      assert.strictEqual(list.body.entries.find((r) => r.id === entry.id).voided, true);
    }
  });

  // ── 第 7 条（P-W9）：登记列表 routing 查询键出现即拒 ──
  test(`${T_C6_PW9}——GET /projects/:id/entries?routing=pending / xyz / 空值 都 400 SYSBUILD_INVALID_INPUT field=routing「不支持的查询参数 routing」；非成员 / 只读账号带该键同样 400（检查早于 loadProjectCtx）；与非法 node / period / type / party 同时出现时先报前者；对照：不带该键 200`, async () => {
    const s = await mkScene();
    const base = `/sysbuild/projects/${s.pid}/entries`;
    await regOk(U.m1, s.pid, { type: 'feedback' });
    const REC = {};
    for (const [label, q] of [['pending', 'routing=pending'], ['xyz', 'routing=xyz'], ['empty', 'routing=']]) REC[label] = await get(U.pm, `${base}?${q}`);
    REC.out = await get(U.out, `${base}?routing=pending`);
    REC.ro = await get(U.ro, `${base}?routing=pending`);
    REC.admin = await get(U.admin, `${base}?routing=`);
    REC.nodeFirst = await get(U.pm, `${base}?node=abc&routing=pending`);
    REC.periodFirst = await get(U.pm, `${base}?period=bogus&routing=xyz`);
    REC.typeFirst = await get(U.pm, `${base}?type=bogus&routing=pending`); // 192-M1：type / party 与 routing 同时非法时也先报前者
    REC.partyFirst = await get(U.pm, `${base}?party=abc&routing=pending`);
    REC.ctl = await get(U.pm, base);
    const fails = [];
    const c = (label, fn) => { try { fn(); } catch (e) { fails.push(`[${label}] ${String(e.message).split('\n')[0].slice(0, 300)}`); } };
    for (const label of ['pending', 'xyz', 'empty', 'out', 'ro', 'admin']) c(`${label} 400 field=routing`, () => { expectErr(REC[label], 400, 'SYSBUILD_INVALID_INPUT', label); assert.strictEqual(REC[label].body.field, 'routing'); assert.strictEqual(REC[label].body.message, '不支持的查询参数 routing'); assert.deepStrictEqual(Object.keys(REC[label].body).sort(), ['code', 'field', 'message']); });
    c('与非法 node 同时出现先报 node', () => { expectErr(REC.nodeFirst, 400, 'SYSBUILD_INVALID_INPUT', 'nodeFirst'); assert.strictEqual(REC.nodeFirst.body.field, 'node'); });
    c('与非法 period 同时出现先报 period', () => { expectErr(REC.periodFirst, 400, 'SYSBUILD_INVALID_INPUT', 'periodFirst'); assert.strictEqual(REC.periodFirst.body.field, 'period'); });
    c('与非法 type 同时出现先报 type', () => { expectErr(REC.typeFirst, 400, 'SYSBUILD_INVALID_INPUT', 'typeFirst'); assert.strictEqual(REC.typeFirst.body.field, 'type'); });
    c('与非法 party 同时出现先报 party', () => { expectErr(REC.partyFirst, 400, 'SYSBUILD_INVALID_INPUT', 'partyFirst'); assert.strictEqual(REC.partyFirst.body.field, 'party'); });
    c('对照：不带 routing 键 200 且列出登记', () => { assert.strictEqual(REC.ctl.status, 200, REC.ctl.text); assert.ok(REC.ctl.body.entries.length >= 1); });
    assert.strictEqual(fails.length, 0, fails.join(' ‖ '));
  });

  // ── R9：办理动作只剩更正与作废 ──
  test(`${T_C6_ACT}——POST /entries/:eid/actions 对 11 个已删动作（含 adjudicate）、link_change、foo 逐一发请求，一律 400 field=action（link_change 与 foo 的 message 逐字、同形）；空体 400「办理动作必填」；对非成员 / 不存在登记 / 只读 / 一般成员各身份同样 400；被拒的办理不写办理记录、不发事件；列表行与详情 actions 全等且键集合只有 correct、void`, async () => {
    const s = await mkScene();
    const e = await regOk(U.m1, s.pid, { type: 'feedback' });
    const NAMES = ['conclude', 'for_reference', 'mark_commitment', 'unmark_commitment', 'mark_risk', 'unmark_risk', 'escalate', 'split', 'assign_items', 'link_sys_issue', 'adjudicate', 'link_change', 'foo'];
    // N12 判红格的请求体：沿用 <S> 中原本可执行的 conclude 请求体（PM、办理类 feedback、未作废、进行中项目），保证越过 :620 之前的全部校验——基线 400 field=action，N12 放回 ACTION_FIELDS 后落到 assertOp 报 500
    const CONCLUDE_BODY = { action: 'conclude', conclusion_kind: 'handled', text: '已处理，见方案说明' };
    const stateOf = async () => ({ acts: (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_entry_actions WHERE entry_id = ?', [e.id])).n, evs: (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_events WHERE project_id = ?', [s.pid])).n });
    const before = await stateOf();
    const REC = {};
    REC.conclude = await act(U.pm, e.id, CONCLUDE_BODY);
    for (const name of NAMES.filter((n) => n !== 'conclude')) REC[name] = await act(U.pm, e.id, { action: name, reason: '请求', text: '请求' });
    REC.empty = await act(U.pm, e.id, {});
    for (const [who, uid] of [['m2', U.m2], ['ro', U.ro], ['out', U.out]]) for (const name of ['conclude', 'escalate', 'split']) REC[`${who}-${name}`] = await act(uid, e.id, { action: name });
    for (const name of ['conclude', 'escalate']) REC[`missing-${name}`] = await act(U.pm, 99999999, { action: name });
    REC.after = await stateOf();
    REC.detail = await get(U.pm, `/sysbuild/entries/${e.id}`);
    REC.list = await get(U.pm, `/sysbuild/projects/${s.pid}/entries`);
    const fails = [];
    const c = (label, fn) => { try { fn(); } catch (e2) { fails.push(`[${label}] ${String(e2.message).split('\n')[0].slice(0, 300)}`); } };
    for (const name of NAMES) c(`${name} 400 field=action`, () => { expectErr(REC[name], 400, 'SYSBUILD_INVALID_INPUT', name); assert.strictEqual(REC[name].body.field, 'action'); assert.deepStrictEqual(Object.keys(REC[name].body).sort(), ['code', 'field', 'message']); });
    c('conclude 请求体 message 逐字', () => assert.strictEqual(REC.conclude.body.message, '不支持的办理动作 conclude'));
    c('link_change 与 foo message 逐字', () => { assert.strictEqual(REC.link_change.body.message, '不支持的办理动作 link_change'); assert.strictEqual(REC.foo.body.message, '不支持的办理动作 foo'); });
    c('link_change 与 foo 同形（状态码 / code / field / 键集合全等）', () => { const shape = (r) => ({ status: r.status, code: r.body.code, field: r.body.field, keys: Object.keys(r.body).sort() }); assert.deepStrictEqual(shape(REC.link_change), shape(REC.foo)); });
    c('空体 {} 400 办理动作必填', () => { expectErr(REC.empty, 400, 'SYSBUILD_INVALID_INPUT', 'empty'); assert.strictEqual(REC.empty.body.field, 'action'); assert.strictEqual(REC.empty.body.message, '办理动作必填'); });
    for (const k of Object.keys(REC).filter((x) => /^(m2|ro|out|missing)-/.test(x))) c(`${k} 400 field=action（身份与对象存在性之前先判动作）`, () => { expectErr(REC[k], 400, 'SYSBUILD_INVALID_INPUT', k); assert.strictEqual(REC[k].body.field, 'action'); });
    c('被拒的办理不写办理记录、不发事件', () => assert.deepStrictEqual(REC.after, before));
    c('详情 actions 键集合只有 correct、void', () => { assert.strictEqual(REC.detail.status, 200); assert.deepStrictEqual(Object.keys(REC.detail.body.entry.actions), ['correct', 'void']); });
    c('列表行 actions 与详情 actions 全等（baseView 同源）', () => { const row = REC.list.body.entries.find((x) => x.id === e.id); assert.deepStrictEqual(row.actions, REC.detail.body.entry.actions); });
    assert.strictEqual(fails.length, 0, fails.join(' ‖ '));
  });

  // ── R9：登记入口只收通用登记与三张表单，退出键出现即拒 ──
  test(`${T_C6_R9}——①通用登记用途矩阵（省略 / null 201、空串 / xyz 400、dev_note / deliverable 对所有身份一律 400 field=purpose）；②三张保留表单用途矩阵；③六个退出键（通用登记 × null / 有值，多键首报按请求体键序，三张表单 × 全部退出键与取值，非成员 / 只读也是 400）；④元数据 purposes 只给 general 且无 self_confirm；⑥详情 27 键按序全等`, async () => {
    const s = await mkScene();
    const nid = await nodeId(s.pid, 'b_dev');
    const t0 = today();
    // 夹具：开发节点计划 + 汇报节奏 + 开工，才能登记进度汇报 / 临时要求
    assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${nid}/schedule`, { kind: 'plan', planned_start: t0, planned_end: shift(t0, 90) })).status, 201);
    const cyc = await post(U.pm, `/sysbuild/projects/${s.pid}/entries`, { form: { kind: 'report_cycle', cycle: 'weekly', first_due_on: t0, note: '请按期汇报开发进展' }, node_id: nid });
    assert.strictEqual(cyc.status, 201, cyc.text);
    assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${nid}/start`)).status, 200);
    const CB = '我已阅读以上全部内容，确认无误';
    const PROG = { kind: 'progress_report', due_on: null, done: '已完成接口联调的第一阶段工作', next: '继续推进第二阶段联调工作', risks: null, milestone_impact: false };
    const IMPACT = Object.assign({}, PROG, { milestone_impact: true });
    const CYCLE = { kind: 'report_cycle', cycle: 'weekly', first_due_on: shift(t0, 7), note: '请按期汇报开发进展' };
    const REQ = { kind: 'report_request', due_on: t0, reason: '请开发方补充本周接口联调进展说明' };
    const REC = {};
    const send = async (label, uid, body) => { REC[label] = await post(uid, `/sysbuild/projects/${s.pid}/entries`, body); };
    const G = { type: 'feedback', title: '通用登记', body: '内容' };
    const att = async (uid) => stageAtt(s.pid, uid, 'a');
    // ① 通用登记用途矩阵
    await send('gen-omit', U.m1, G); await send('gen-null', U.m1, Object.assign({}, G, { purpose: null })); await send('gen-empty', U.m1, Object.assign({}, G, { purpose: '' }));
    await send('gen-general', U.m1, Object.assign({}, G, { purpose: 'general' })); await send('gen-xyz', U.m1, Object.assign({}, G, { purpose: 'xyz' }));
    for (const [who, uid] of [['pm', U.pm], ['x1', U.x1], ['x2', U.x2], ['m1', U.m1], ['ro', U.ro], ['out', U.out], ['admin', U.admin]]) for (const p of ['dev_note', 'deliverable']) await send(`purpose-${p}-${who}`, uid, Object.assign({}, G, { purpose: p }));
    // ② 三张保留表单用途矩阵：省略 201、null 400、空串 400、同值 201、异值（含 dev_note）400
    const FORMS = { cycle: [U.pm, CYCLE], request: [U.pm, REQ], progress: [U.x1, PROG] };
    for (const [fk, [uid, form]] of Object.entries(FORMS)) {
      await send(`mx-${fk}-omit`, uid, { form, node_id: nid }); await send(`mx-${fk}-null`, uid, { form, node_id: nid, purpose: null });
      await send(`mx-${fk}-empty`, uid, { form, node_id: nid, purpose: '' }); await send(`mx-${fk}-same`, uid, { form, node_id: nid, purpose: 'general' });
      await send(`mx-${fk}-other`, uid, { form, node_id: nid, purpose: 'dev_note' });
    }
    // ③ 退出键：通用登记 6 键 × null / 有值（R9-12b）
    const EXIT = { item_ids: [1], commitment_flag: 1, is_risk: 1, objects_entry_id: 1, revision_of_entry_id: 1, self_confirm_text: CB };
    for (const [k, v] of Object.entries(EXIT)) { await send(`x12b-${k}-null`, U.m1, Object.assign({}, G, { [k]: null })); await send(`x12b-${k}-val`, U.m1, Object.assign({}, G, { [k]: v })); }
    // 多退出键首报顺序两格（按请求体键序取第一个不在 CREATE_KEYS 的键）
    await send('x12c-a', U.m1, Object.assign({}, G, { self_confirm_text: CB, commitment_flag: 1 })); await send('x12c-b', U.m1, Object.assign({}, G, { commitment_flag: 1, self_confirm_text: CB }));
    // 三张表单 × objects_entry_id / revision_of_entry_id × null / 整数（R9-12a）
    for (const [fk, [uid, form]] of Object.entries(FORMS)) for (const k of ['objects_entry_id', 'revision_of_entry_id']) for (const [tag, v] of [['null', null], ['int', 1]]) await send(`x12a-${fk}-${k}-${tag}`, uid, { form, node_id: nid, [k]: v });
    // 三张表单 × 其余四个退出键（commitment_flag 0 / false / null / 1 / true、is_risk 0 / 1、item_ids [] / 有效 / 无效、self_confirm_text）
    const REST = { commitment_flag: [0, false, null, 1, true], is_risk: [0, 1], item_ids: [[], [1], [99999999]], self_confirm_text: [CB] };
    for (const [fk, [uid, form]] of Object.entries(FORMS)) for (const [k, vals] of Object.entries(REST)) for (const [i, v] of vals.entries()) await send(`fxk-${fk}-${k}-${i}`, uid, { form, node_id: nid, [k]: v });
    await send('fxk-impact-self', U.x1, { form: IMPACT, node_id: nid, attachment_ids: [await att(U.x1)], self_confirm_text: CB });
    await send('fxk-impact-pm', U.pm, { form: IMPACT, node_id: nid, source_party_id: s.D, attachment_ids: [await att(U.pm)], commitment_flag: 1 });
    await send('fxk-impact-ctl', U.x1, { form: IMPACT, node_id: nid, attachment_ids: [await att(U.x1)] });
    // 非成员 / 只读带键同样 400（onlyKeys 早于项目可见性）
    await send('out-key', U.out, Object.assign({}, G, { item_ids: [1] })); await send('ro-key', U.ro, Object.assign({}, G, { is_risk: 1 }));
    // ④ 元数据；⑥ 详情 27 键
    REC.metaOwner = await get(U.own, `/sysbuild/projects/${s.pid}/entries`); REC.metaPm = await get(U.pm, `/sysbuild/projects/${s.pid}/entries`); REC.metaX2 = await get(U.x2, `/sysbuild/projects/${s.pid}/entries`);
    const eid = REC['gen-omit'].body && REC['gen-omit'].body.entry ? REC['gen-omit'].body.entry.id : null;
    REC.detail = eid ? await get(U.pm, `/sysbuild/entries/${eid}`) : null;
    const fails = [];
    const c = (label, fn) => { try { fn(); } catch (e) { fails.push(`[${label}] ${String(e.message).split('\n')[0].slice(0, 300)}`); } };
    const is = (label, status) => c(label, () => assert.strictEqual(REC[label].status, status, `${label}: ${REC[label].text}`));
    const bad = (label, field) => c(label, () => { expectErr(REC[label], 400, 'SYSBUILD_INVALID_INPUT', label); assert.strictEqual(REC[label].body.field, field, `${label} field`); });
    for (const l of ['gen-omit', 'gen-null', 'gen-general']) is(l, 201);
    bad('gen-empty', 'purpose'); bad('gen-xyz', 'purpose');
    for (const who of ['pm', 'x1', 'x2', 'm1', 'ro', 'out', 'admin']) for (const p of ['dev_note', 'deliverable']) bad(`purpose-${p}-${who}`, 'purpose');
    // 192-M2：用途拒绝的冻结值（C6-RC32 / RC35 / RC76 / RC77）——message 逐字、响应键集合全等（16 个标签：gen-empty、gen-xyz，7 个身份 × dev_note / deliverable）
    for (const label of ['gen-empty', 'gen-xyz', ...['pm', 'x1', 'x2', 'm1', 'ro', 'out', 'admin'].flatMap((who) => ['dev_note', 'deliverable'].map((p) => `purpose-${p}-${who}`))]) {
      c(`用途拒绝冻结值 ${label}`, () => { assert.strictEqual(REC[label].body.message, '用途必须是 general', `${label} message`); assert.deepStrictEqual(Object.keys(REC[label].body).sort(), ['code', 'field', 'message'], `${label} 键集合`); });
    }
    for (const fk of Object.keys(FORMS)) { is(`mx-${fk}-omit`, 201); bad(`mx-${fk}-null`, 'purpose'); bad(`mx-${fk}-empty`, 'purpose'); is(`mx-${fk}-same`, 201); bad(`mx-${fk}-other`, 'purpose'); }
    for (const k of Object.keys(EXIT)) { bad(`x12b-${k}-null`, k); bad(`x12b-${k}-val`, k); }
    bad('x12c-a', 'self_confirm_text'); bad('x12c-b', 'commitment_flag');
    for (const fk of Object.keys(FORMS)) for (const k of ['objects_entry_id', 'revision_of_entry_id']) for (const tag of ['null', 'int']) bad(`x12a-${fk}-${k}-${tag}`, k);
    for (const fk of Object.keys(FORMS)) for (const [k, vals] of Object.entries(REST)) for (let i = 0; i < vals.length; i += 1) bad(`fxk-${fk}-${k}-${i}`, k);
    bad('fxk-impact-self', 'self_confirm_text'); bad('fxk-impact-pm', 'commitment_flag'); is('fxk-impact-ctl', 201);
    bad('out-key', 'item_ids'); bad('ro-key', 'is_risk');
    c('④ 元数据 purposes 只给 general、registration 无 self_confirm（owner / PM / x2）', () => {
      for (const k of ['metaOwner', 'metaPm', 'metaX2']) { assert.strictEqual(REC[k].status, 200, REC[k].text); assert.deepStrictEqual(REC[k].body.registration.purposes, ['general'], k); assert.ok(!('self_confirm' in REC[k].body.registration), `${k} 无 self_confirm`); }
    });
    c('⑥ 登记详情顶层 27 键按序全等（退役键缺失由它承担）', () => {
      assert.deepStrictEqual(Object.keys(REC.detail.body.entry), ['id', 'project_id', 'node_id', 'type', 'source_party_id', 'source_name', 'operator_user_id', 'operator_name', 'operator_identity', 'period', 'days_after_close', 'business_date', 'title', 'body', 'no_written_evidence', 'no_evidence_reason', 'voided', 'created_at', 'actions', 'form', 'form_kind', 'form_label', 'form_unreadable', 'has_correction', 'corrections', 'attachments', 'records']);
    });
    assert.strictEqual(fails.length, 0, fails.join(' ‖ '));
    // 被拒请求不落登记：退出键全部 400，库里该项目只有成功的那些行（通用 3 + 表单 3 × 2 + 影响里程碑对照 1 + 夹具节奏 1）
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE project_id = ?', [s.pid]), 3 + 6 + 1 + 1, '全部退出键 / 用途拒绝都不落登记');
  });
}

// ── 变异 ───────────────────────────────────────────────────────────────────────────────────────
// 每条 { id, expect: [用例名前缀], edits: [{ file, from, to }] }；锚点必须在副本里恰好出现一次。
const em = (id, expect, file, from, to) => ({ id: `C5 登记：${id}`, expect, edits: [{ file, from, to }] });
const ENTRY_MUTATIONS = [
  // ── rules.js：写登记 / 更正作废 / 状态集合 / 各动作的对象状态 / 项目状态类别 ──
  em('写登记不再有只读一票否决', [T_WHO, T_RULES], 'rules.js', 'return !!(!identity.isReadonly && (identity.isAdmin || identity.isMember));', 'return !!(identity.isAdmin || identity.isMember);'),
  em('写登记不让 admin 非成员写', [T_WHO, T_RULES], 'rules.js', 'return !!(!identity.isReadonly && (identity.isAdmin || identity.isMember));', 'return !!(!identity.isReadonly && identity.isMember);'),
  em('写登记放行非成员', [T_RULES], 'rules.js', 'return !!(!identity.isReadonly && (identity.isAdmin || identity.isMember));', 'return !identity.isReadonly;'),
  em('更正 / 作废不认登记人本人', [T_VOID, T_FLAGS, T_RULES], 'rules.js', 'return !!(identity.isPm || t.isRegistrant === true);', 'return !!identity.isPm;'),
  em('更正 / 作废放行任何成员', [T_VOID, T_FLAGS, T_RULES], 'rules.js', 'return !!(identity.isPm || t.isRegistrant === true);', 'return true;'),
  em('更正 / 作废没有只读一票否决', [T_RULES], 'rules.js', 'if (identity.isReadonly) return false;\n  return !!(identity.isPm || t.isRegistrant === true);', 'return !!(identity.isPm || t.isRegistrant === true);'),
  // API 层只有「已异议」一条路能到达这个分支（被异议后状态才会离开仅供参考），所以只有 rules 用例能判别
  em('写登记过程类按补充类判项目状态', [T_STATUS, T_RULES], 'rules.js', "entry_create_process: 'register_process',", "entry_create_process: 'register_supplement',"),
  em('写登记补充类按过程类判项目状态', [T_STATUS, T_RULES], 'rules.js', "entry_create_supplement: 'register_supplement',", "entry_create_supplement: 'register_process',"),
  em('项目 actions.create_entry 只看过程登记', [T_STATUS], 'rules.js', "create_entry: opAllowed('entry_create_process', identity, project, {}) || opAllowed('entry_create_supplement', identity, project, {}),", "create_entry: opAllowed('entry_create_process', identity, project, {}),"),
  // ── entries-core.js：时段、确认人解析、状态派生、冻结、关闭待确认修订 ──
  em('收口后天数多算一天', [T_PERIOD, T_RULES], 'entries-core.js', 'Math.round(ms / 86400000)', 'Math.round(ms / 86400000) + 1'),
  em('节点未收口也判补充登记', [T_PERIOD, T_STATUS], 'entries-core.js', "if (node.status !== 'closed') return { period: 'process', days: null };", ''),
  em('项目整体未结项 / 终止也判补充登记', [T_PERIOD, T_STATUS], 'entries-core.js', "if (!PROJECT_ENDED_STATUSES.includes(project.status)) return { period: 'process', days: null };", ''),
  em('结项 / 终止日期不读状态事件', [T_PERIOD], 'entries-core.js', 'if (to === toStatus) return e.created_at;', ''),
  em('身份快照：内部成员标志恒假', [T_WHO], 'entries-core.js', 'is_internal: identity.isPm !== true && identity.memberId !== null && identity.memberId !== undefined && partyId === null,', 'is_internal: false,'),
  em('身份快照：负责人标志恒假', [T_WHO], 'entries-core.js', "is_owner: partyId !== null && Array.isArray(identity.ownerOfParties) && identity.ownerOfParties.includes(partyId),", 'is_owner: false,'),
  em('派生：作废不改状态', [T_VOID, T_RULES], 'entries-core.js', "case 'void': voided = true; break;", "case 'void': break;"),
  em('办理动作 target 的作废标志恒假', [T_VOID, T_FLAGS], 'entries-core.js', 'voided: facts.derived.voided,', 'voided: false,'),
  em('办理动作 target 不认登记人', [T_VOID, T_FLAGS], 'entries-core.js', 'isRegistrant: Number(entry.operator_user_id) === Number(user.id),', 'isRegistrant: false,'),
  // ── entries.js：写登记 / 办理 / 知会 ──
  em('用途越界不校验', [T_FIELDS], 'entries.js', "if (typeof purpose !== 'string' || !rules.ENTRY_PURPOSES_FINAL.includes(purpose)) throw invalid(", 'if (false) throw invalid('),
  em('业务日期可晚于今天', [T_FIELDS], 'entries.js', 'if (input.businessDate !== null && input.businessDate > todayStr)', 'if (false)'),
  em('已取消的节点可关联新登记', [T_FIELDS], 'entries.js', "if (node !== null && node.status === 'cancelled') throw stateError(", 'if (false) throw stateError('),
  em('非 PM 也能填来源方', [T_WHO], 'entries.js', "if (identity.isPm !== true) throw invalid('只有项目经理代登时可以填写来源方', 'source_party_id');", ''),
  em('来源方不核属于本项目', [T_WHO], 'entries.js', "'SELECT id FROM sysbuild_parties WHERE id = ? AND project_id = ?', [input.sourcePartyId, pid]", "'SELECT id FROM sysbuild_parties WHERE id = ? AND ? > 0', [input.sourcePartyId, pid]"),
  em('成员登记不取成员行的参与方', [T_WHO], 'entries.js', 'sourcePartyId = identity.partyId === undefined ? null : identity.partyId;', 'sourcePartyId = null;'),
  em('补交材料不要求附件', [T_EVID], 'entries.js', "if (mode === 'material' && count === 0) throw makeError(400, 'SYSBUILD_EVIDENCE_REQUIRED', '补交材料必须上传附件');", ''),
  em('涉及承诺不要求证据', [T_C6_R6], 'entries.js', "if (mode === 'direction' && !ev.noEvidence && count === 0) {", 'if (false) {'),
  em('无书面证据原因不核 10 字', [T_EVID], 'entries.js', 'if (ev.noEvidence && (ev.noEvidenceReason === null || Array.from(ev.noEvidenceReason).length < EVIDENCE_REASON_MIN)) {', 'if (false) {'),
  em('证据模式一律可选', [T_EVID, T_C6_R6], 'entries.js', "input.type === 'material' ? 'material' : (input.form !== null && input.form.kind === 'progress_report' && input.form.milestone_impact === true ? 'direction' : 'optional')", "'optional'"),
  em('附件与声明可以并存', [T_EVID], 'entries.js', "if (ev.noEvidence && count > 0) throw invalid('已附证据附件，不应再声明无书面证据', 'no_written_evidence');", ''),
  em('登记附件绑定类型写错', [T_EVID], 'entries.js', "ownerType: 'entry', ownerId: eid,", "ownerType: 'event', ownerId: eid,"),
  em('可见性检查被去掉', [T_WHO, T_READ], 'entries.js', 'rules.assertVisible(access);\n    const identity = await rules.completeIdentity(q, access, user);', 'const identity = await rules.completeIdentity(q, access, user);'),
  em('标记 / 作废的原因不必填', [T_VOID], 'entries.js', "out.text = readText(body.reason, 'reason', '原因', REASON_MAX, true);", "out.text = readText(body.reason, 'reason', '原因', REASON_MAX, false);"),
  // S-S1c：link_change 已开放，LATER_ACTIONS 只剩 adjudicate；本条随之改写（原「link_change 被当作未知动作」）
  em('逐对象 actions 不带对象状态', [T_FLAGS], 'entries.js', 'rules.opAllowed(`entry_${a}`, identity, access.project, t);', 'rules.opAllowed(`entry_${a}`, identity, access.project, {});'),
  em('列表不按时段筛选', [T_READ], 'entries.js', "conds.push('period = ?'); params.push(qs.period);", ''),
  em('列表按来源方筛选取反', [T_READ], 'entries.js', "conds.push('source_party_id = ?');", "conds.push('source_party_id <> ?');"),
  em('列表最旧在前', [T_READ], 'entries.js', 'ORDER BY id DESC`, params);', 'ORDER BY id ASC`, params);'),
  em('我的知会不限本人', [T_C6B_SCHEDULE], 'entries.js', 'WHERE m.user_id = ? ORDER BY n.id DESC', 'WHERE ? > 0 ORDER BY n.id DESC'),
  // codex 25 M1：target 改为 objectorBasis，锚点随之改写
  // ── confirm.js / confirm-core.js：结论确认 / 裁定任务的对象分支、决策取值、冻结清单、终止项目、待我确认 ──
  // S-S1c：表里加了 dev_key_confirm，锚点随之改写
  // C6b 修订批 1（K1）：判定抽成 confirm-core.confirmAvailabilityBlock，锚点随之换文件
  // S-S1c：映射加了 dev_entry，锚点随之改写；#212 C4：去掉 handover
  {
    id: 'C5 登记：终止项目不再失效内容包确认', expect: ['C4a P38：终止项目', T_CLASS],
    edits: [
      { file: 'confirm-core.js', from: "const INVALIDATED_ON_TERMINATE_PURPOSES = Object.freeze(['package_confirm']);", to: 'const INVALIDATED_ON_TERMINATE_PURPOSES = Object.freeze([]);' },
      { file: 'confirm-core.js', from: 'const RETAINED_ON_TERMINATE_PURPOSES = Object.freeze([]);', to: "const RETAINED_ON_TERMINATE_PURPOSES = Object.freeze(['package_confirm']);" },
    ],
  },
  // C6a：决策取值校验改按 ENTRY_TASK_DECISIONS 的键判（不再依赖本集合），本集合只剩「项目状态类别走 resolve 类 / accept 类」这一个用途，由终止项目用例判红
  // ── 预筛修订批（2026-11-06）：M1 / M2 / L1–L6 / P93–P96 ──
  // S-S1b：只认「回到办理」的异议，锚点随之改写
  em('L1 终止分类表的加载断言被去掉', [T_CLASS], 'confirm-core.js', 'assertTerminatePurposeClassification(schema.ENUMS.confirmPurpose, INVALIDATED_ON_TERMINATE_PURPOSES, RETAINED_ON_TERMINATE_PURPOSES);', ''),
  em('L1 终止分类断言放过重复登记', [T_CLASS], 'confirm-core.js', 'if (n !== 1) throw new Error(', 'if (n === 0) throw new Error('),
  em('L1 终止分类断言不查表外用途', [T_CLASS], 'confirm-core.js', 'if (!all.includes(p)) throw new Error(', 'if (false) throw new Error('),
  em('L4 admin 兼成员写登记不取成员行的参与方', [T_WHO], 'entries.js', '} else if (identity.isPm !== true && identity.memberId !== null && identity.memberId !== undefined) {', '} else if (identity.isPm !== true && identity.isAdmin !== true && identity.memberId !== null && identity.memberId !== undefined) {'),
  // ── 修订批 2：M-b / M-c ──
  // ── codex 24：M1 / M2 ──
  em('P95 终止项目的项目整体登记判过程登记', [T_STATUS, T_PERIOD, T_ORDER], 'entries-core.js', "const PROJECT_ENDED_STATUSES = Object.freeze(['terminated', 'closed']);", "const PROJECT_ENDED_STATUSES = Object.freeze(['closed']);"),
  em('P95 项目整体登记的天数一律按结项事件', [T_STATUS, T_PERIOD], 'entries-core.js', 'await projectEndedOn(q, project.id, project.status)', "await projectEndedOn(q, project.id, 'closed')"),
  // ── #212 C6 新增变异（生效清单 A.3 N8–N17；锚点取自 <S> 里保留（K）的原文）──
  { id: 'C6 R9：item_ids 放回登记键白名单', expect: [T_C6_R9], edits: [{ file: 'entries.js', from: "'source_party_id', 'attachment_ids', 'no_written_evidence', 'no_evidence_reason', 'form',\n]);", to: "'source_party_id', 'attachment_ids', 'no_written_evidence', 'no_evidence_reason', 'form', 'item_ids',\n]);" }] },
  { id: 'C6 R9：commitment_flag / is_risk 放回登记键白名单', expect: [T_C6_R9], edits: [{ file: 'entries.js', from: "'source_party_id', 'attachment_ids', 'no_written_evidence', 'no_evidence_reason', 'form',\n]);", to: "'source_party_id', 'attachment_ids', 'no_written_evidence', 'no_evidence_reason', 'form', 'commitment_flag', 'is_risk',\n]);" }] },
  { id: 'C6 R9：objects_entry_id / revision_of_entry_id 放回登记键白名单', expect: [T_C6_R9], edits: [{ file: 'entries.js', from: "'source_party_id', 'attachment_ids', 'no_written_evidence', 'no_evidence_reason', 'form',\n]);", to: "'source_party_id', 'attachment_ids', 'no_written_evidence', 'no_evidence_reason', 'form', 'objects_entry_id', 'revision_of_entry_id',\n]);" }] },
  { id: 'C6 R9：通用登记用途清单加回 dev_note / deliverable', expect: [T_C6_R9], edits: [{ file: 'rules.js', from: "const ENTRY_PURPOSES_FINAL = Object.freeze(['general']);", to: "const ENTRY_PURPOSES_FINAL = Object.freeze(['general', 'dev_note', 'deliverable']);" }] },
  { id: 'C6 P-W9：登记列表 routing 键被静默忽略', expect: [T_C6_PW9], edits: [{ file: 'entries.js', from: "if (hasKey(qs, 'routing')) throw invalid('不支持的查询参数 routing', 'routing');", to: '' }] },
  { id: 'C6 P-W9：routing 检查先于 party 校验', expect: [T_C6_PW9], edits: [{ file: 'entries.js', from: "if (qs.party !== undefined && qs.party !== '') { conds.push('source_party_id = ?'); params.push(readIdParam(qs.party, 'party', '来源方')); }", to: "if (hasKey(qs, 'routing')) throw invalid('不支持的查询参数 routing', 'routing');\n    if (qs.party !== undefined && qs.party !== '') { conds.push('source_party_id = ?'); params.push(readIdParam(qs.party, 'party', '来源方')); }" }] },
  { id: 'C6 R7：待办加回 notice 键', expect: [T_C6_R7], edits: [{ file: 'notify.js', from: 'counts.report_overdue = reportOverdue.length; items.report_overdue = cap(reportOverdue);', to: 'counts.report_overdue = reportOverdue.length; items.report_overdue = cap(reportOverdue); counts.notice = 0; items.notice = [];' }] },
  { id: 'C6 R7：我的知会加回 objected 键', expect: [T_C6_R7], edits: [{ file: 'entries.js', from: "ref_id: n.ref_id, created_at: n.created_at, as: n.as };", to: "ref_id: n.ref_id, created_at: n.created_at, as: n.as, objected: false };" }] },
  { id: 'C6 R7：待办加回 objection 类', expect: [T_C6_R7], edits: [{ file: 'notify.js', from: 'counts.report_overdue = reportOverdue.length; items.report_overdue = cap(reportOverdue);', to: 'counts.report_overdue = reportOverdue.length; items.report_overdue = cap(reportOverdue); counts.objection = 0; items.objection = [];' }] },
];

module.exports = { defineEntryCases, ENTRY_MUTATIONS };
