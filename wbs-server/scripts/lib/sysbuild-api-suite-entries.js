// 验证脚本库：项目管理（系统建设记录）模块 C5 S-S1a——登记与办理、知会与知会异议、办理结论确认与负责人裁定（#113 段 7 C5 S-S1a）的用例与变异
//   方案：docs/local/系统建设记录/系统建设记录_平台集成_方案_20261105_v1.4.md §4.1（登记规则表、过程 / 补充登记、办理结论的确认、仅供参考）、§4.2「办理结论」「异议裁定」两行、§4.5、§5.2–5.3、§6.2、§6.3、§7
//   派单：docs/local/系统建设记录/送审准备/C5_S-S1a_登记与办理_派单_20261105.md（§9 测试清单 15 项；本文件的 T_* 常量与之逐项对应）
//
// 本文件只放用例与变异，由 sysbuild-api-suite.js 登记（同一套夹具、同一个变异自检）。期望值一律手写，不取自被测代码。
// 夹具规则：建项走 POST /projects；登记、办理、知会异议、结论确认的打开 / 决策 / 代录 / 改发、项目状态转移全部走生产端点。只有这几类直接写库：
//   ① 需求方 / 开发方参与方、成员、现任任职、生效授权（含无账号成员）；② 附件行（暂存）；③ 节点收口状态与时刻、项目结项状态与结项事件（结项由 C6 产生，本批没有生产路径）、
//   任务修订创建时间回拨（代录外部日期的下限取修订创建日）；④ 授权撤销 / 任职结束（构造代表人更换）。
// 时间：进程内夹具的「今天」固定为 2026-11-15，实例模式取真实本地日期；与「今天」有关的期望一律由 today() 推算（收口日 = 今天往前 N 天），不写死日期。
'use strict';
const assert = require('assert');

const P = 'C5 登记：';
const T_PERIOD = `${P}时段判定`;
const T_STATUS = `${P}项目状态 × 写登记`;
const T_WHO = `${P}来源方与权限`;
const T_EVID = `${P}证据`;
const T_FIELDS = `${P}字段校验`;
const T_ITEMS = `${P}关联需求条目`;
const T_CONFIRMER = `${P}确认人解析`;
const T_FLOW = `${P}结论流`;
const T_ESC = `${P}交裁定`;
const T_REF = `${P}仅供参考`;
const T_MARK = `${P}D43 标记`;
const T_TERM = `${P}终止项目`;
const T_CLASS = `${P}终止分类表`;
const T_LAPSE = `${P}项目已终止结论失效`;
const T_ESCTERM = `${P}裁定中的项目已终止`;
const T_KINDLIST = `${P}可用结论类别`;
const T_PROXY = `${P}代录结论确认`;
const T_REISSUE = `${P}改发`;
const T_FLAGS = `${P}actions 同源`;
const T_VOID = `${P}更正与作废`;
const T_KINDS = `${P}结论类别`;
const T_READ = `${P}读接口`;
const T_RULES = `${P}rules`;
const T_ORDER = `${P}检查顺序`;
const T_ONLY = `${P}只追加`;

const CHECKBOX = '我已阅读以上全部内容，确认无误';
const CHECKBOX_REJECT = '我已阅读以上全部内容，不认可（原因见下）';
const FLOOR_AT = '2026-10-20 09:00:00';
const OK_DATE = '2026-10-25';
const ACTION_NAMES = ['correct', 'void', 'conclude', 'for_reference', 'mark_commitment', 'unmark_commitment', 'mark_risk', 'unmark_risk', 'escalate'];

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
  const { newProject, seedParty, stageAtt, openAndDecide, openTask, decideBodyOf, decideRaw, produceEffectiveOverall, mkItem, seedEffectiveInitiation, mkPackage, mkVersion, addToSet, defaultBatchId, planAllNodes } = H;
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
  const CONCLUDE = { action: 'conclude', conclusion_kind: 'handled', text: '已处理，见方案说明' };
  const nodeId = async (pid, key) => (await sqlGet('SELECT id FROM sysbuild_nodes WHERE project_id = ? AND template_key = ?', [pid, key])).id;
  // 夹具：把节点直接写成已收口（收口 = 今天往前 daysAgo 天的 09:00:00；库内约束要求进行中 / 已收口的节点有开始时刻）。daysAgo 为字符串日期时直接用。
  const closeNode = (nid, closedAt) => sqlRun(
    "UPDATE sysbuild_nodes SET status = 'closed', opened_at = COALESCE(opened_at, '2026-10-01 09:00:00'), closed_at = ? WHERE id = ?", [closedAt, nid]
  );
  // 登记的结论 / 裁定任务及当前修订（按任务编号升序，最新在后）
  const tasksOfEntry = (eid, objectType) => sqlAll(
    `SELECT t.id AS tid, t.object_type AS object_type, t.object_version_id AS action_id, t.purpose AS purpose, t.party_id AS party_id,
            r.id AS rid, r.rev_no AS rev_no, r.status AS status, r.status_reason AS status_reason, r.required_member_id AS member_id,
            r.basis_appointment_id AS basis_appointment_id, r.basis_delegation_id AS basis_delegation_id, m.user_id AS user_id
       FROM sysbuild_confirm_tasks t JOIN sysbuild_confirm_task_revisions r ON r.task_id = t.id JOIN sysbuild_members m ON m.id = r.required_member_id
      WHERE t.object_type = ? AND t.object_id = ? AND r.rev_no = (SELECT MAX(r2.rev_no) FROM sysbuild_confirm_task_revisions r2 WHERE r2.task_id = t.id) ORDER BY t.id`,
    [objectType, eid]
  );
  async function lastTask(eid, objectType) {
    const rows = await tasksOfEntry(eid, objectType);
    assert.ok(rows.length > 0, `登记 ${eid} 应有 ${objectType} 任务`);
    return rows[rows.length - 1];
  }
  const stateOf = async (eid) => (await detail(U.pm, eid)).conclusion_state;
  const actionsRows = (eid) => sqlAll('SELECT * FROM sysbuild_entry_actions WHERE entry_id = ? ORDER BY id', [eid]);
  const backdateRev = (rid) => sqlRun('UPDATE sysbuild_confirm_task_revisions SET created_at = ? WHERE id = ?', [FLOOR_AT, rid]);
  async function proxyEvid(pid, extra) {
    return Object.assign({ external_date: OK_DATE, actual_confirmer: '甲部李代表', identity_basis: '甲部授权代表人，电话确认记录', attachment_ids: [await stageAtt(pid, U.pm, 'c')] }, extra || {});
  }
  const eventsOfType = (pid, type) => sqlAll('SELECT * FROM sysbuild_events WHERE project_id = ? AND event_type = ? ORDER BY id', [pid, type]);
  const openIds = async (uid, tid) => {
    const o = await openTask(uid, tid);
    assert.strictEqual(o.status, 200, o.text);
    return o.body;
  };

  // ═══════════════════════ 1 时段判定 ═══════════════════════
  test(`${T_PERIOD}——节点未收口 → 过程登记；已收口 → 补充登记 + 收口后第 N 天（登记日 − 收口日，当天 = 0）；节点重开后已有登记不改写；项目整体按是否结项（结项事件优先，缺事件取 updated_at）`, async () => {
    const s = await mkScene();
    const t0 = today();
    const nid = await nodeId(s.pid, 'b_req');
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
    const closedNode = await nodeId(s.pid, 'b_req');
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
    const pClosed = await nodeId(p.pid, 'b_req');
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
    assert.deepStrictEqual([am.confirmer.kind, am.confirmer.member_id], ['delegate', s.A.mDel], 'admin 兼成员登记的结论由来源方代表人确认');
    const sAdm = await mkScene();
    await addMember(sAdm.pid, U.admin);
    const am2 = await regOk(U.admin, sAdm.pid, { type: 'feedback' });
    assert.deepStrictEqual([am2.source_party_id, snap(am2).is_internal, snap(am2).is_admin], [null, true, true], 'admin 兼成员（无参与方）：来源方空');
    // 待接受 / 已移出的成员行不算成员（不能写登记，与非成员一样 404）
    const s2 = await mkScene();
    await addMember(s2.pid, U.out, { pending: true });
    expectErr(await reg(U.out, s2.pid), 404, 'SYSBUILD_NOT_FOUND', '待接受的成员行');
    const gone = await newProject();
    await addMember(gone, U.out, { removed: true });
    expectErr(await reg(U.out, gone), 404, 'SYSBUILD_NOT_FOUND', '已移出的成员行');
  });

  // ═══════════════════════ 4 证据 ═══════════════════════
  test(`${T_EVID}——补交材料必有附件（无附件 400 SYSBUILD_EVIDENCE_REQUIRED，「无书面证据」不能代替）；涉及承诺为方向类（附件，或无书面证据 + 原因 ≥10 字）；附件在同一事务绑定为 entry`, async () => {
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
    // 涉及承诺：方向类
    expectErr(await reg(U.m1, s.pid, { type: 'feedback', commitment_flag: 1 }), 400, 'SYSBUILD_EVIDENCE_REQUIRED', '涉及承诺无任何证据');
    const R9 = '九个字的原因啊啊啊';
    const R10 = '十个字的原因啊啊啊啊';
    assert.deepStrictEqual([Array.from(R9).length, Array.from(R10).length], [9, 10], '手写的 9 字 / 10 字原因');
    const r9 = await reg(U.m1, s.pid, { type: 'feedback', commitment_flag: 1, no_written_evidence: true, no_evidence_reason: R9 });
    expectErr(r9, 400, 'SYSBUILD_INVALID_INPUT', '无书面证据原因 9 字');
    assert.strictEqual(r9.body.field, 'no_evidence_reason');
    const r10 = await regOk(U.m1, s.pid, { type: 'feedback', commitment_flag: 1, no_written_evidence: true, no_evidence_reason: R10 });
    assert.deepStrictEqual([r10.no_written_evidence, r10.no_evidence_reason, r10.commitment_flag, r10.commitment_flag_source], [true, R10, true, 'submitter']);
    const a2 = await stageAtt(s.pid, U.m1, 'b');
    const withAtt = await regOk(U.m1, s.pid, { type: 'feedback', commitment_flag: 1, attachment_ids: [a2] });
    assert.deepStrictEqual([withAtt.no_written_evidence, withAtt.attachments.length], [false, 1]);
    // 互斥与形态：有附件又声明无书面证据 400；未声明却写原因 400；声明非布尔 400
    const a3 = await stageAtt(s.pid, U.m1, 'd');
    const both = await reg(U.m1, s.pid, { type: 'feedback', commitment_flag: 1, attachment_ids: [a3], no_written_evidence: true, no_evidence_reason: R10 });
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
  test(`${T_FIELDS}——is_risk 只 issue；purpose 越界 400（dev_note / deliverable 自 S-S1c 起开放）；type 更正 / 越界 400；键白名单、标题 / 内容 / 业务日期 / 节点 / 条目编号的形态；业务日期不晚于今天`, async () => {
    const s = await mkScene();
    const bad = async (extra, field, label) => {
      const r = await reg(U.pm, s.pid, extra);
      expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', label);
      assert.strictEqual(r.body.field, field, `${label} 的 field`);
    };
    await bad({ is_risk: 1 }, 'is_risk', '问题类以外标风险（note）');
    await bad({ type: 'feedback', is_risk: true }, 'is_risk', '意见与反馈标风险');
    await bad({ type: 'issue', is_risk: 2 }, 'is_risk', 'is_risk 取值');
    const issue = await regOk(U.pm, s.pid, { type: 'issue', is_risk: 1 });
    assert.deepStrictEqual([issue.is_risk, issue.risk_current], [true, true], 'issue 可标风险');
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
    await bad({ item_ids: 'x' }, 'item_ids', '条目编号非数组');
    await bad({ item_ids: [99999999] }, 'item_ids', '条目不存在');
    await bad({ item_ids: [1, 1] }, 'item_ids', '条目编号重复');
    await bad({ commitment_flag: 'yes' }, 'commitment_flag', '承诺标记取值');
    await bad({ attachment_ids: [1, 1] }, 'attachment_ids', '附件编号重复');
    await bad({ bogus: 1 }, 'bogus', '多余键');
    const arr = await post(U.pm, `/sysbuild/projects/${s.pid}/entries`, []);
    expectErr(arr, 400, 'SYSBUILD_INVALID_INPUT', '请求体是数组');
    assert.strictEqual(arr.body.field, 'body');
    // 节点属于别的项目 → 400；已取消的节点 → 409
    const other = await mkScene();
    await bad({ node_id: await nodeId(other.pid, 'b_req') }, 'node_id', '别的项目的节点');
    const cn = await nodeId(s.pid, 'b_dev');
    await sqlRun("UPDATE sysbuild_nodes SET status = 'cancelled' WHERE id = ?", [cn]);
    expectErr(await reg(U.pm, s.pid, { node_id: cn }), 409, 'SYSBUILD_STATE', '已取消的节点');
    // 用途：越界值 400（dev_note / deliverable 自 S-S1c 起开放，权限 / 认可 / 附件的用例在 sysbuild-api-suite-devkey.js）
    for (const purpose of ['bogus', 7, '']) expectErr(await reg(U.x2, s.pid, { purpose }), 400, 'SYSBUILD_INVALID_INPUT', `用途 ${JSON.stringify(purpose)}`);
    assert.strictEqual((await regOk(U.pm, s.pid, { purpose: 'general', business_date: today(), title: '  带空白  ' })).title, '带空白', '一般用途、业务日期 = 今天、标题 trim');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_entries WHERE project_id = ? AND purpose <> 'general'", [s.pid]), 0, '被拒的用途不留行');
    // 边界：标题 100 字、内容 4000 字通过
    const edge = await regOk(U.pm, s.pid, { title: 'x'.repeat(100), body: 'y'.repeat(4000) });
    assert.deepStrictEqual([Array.from(edge.title).length, Array.from(edge.body).length], [100, 4000]);
    const ev = (await eventsOfType(s.pid, 'entry_created')).map((e) => JSON.parse(e.payload_json));
    assert.ok(ev.length >= 3 && ev.every((p) => typeof p.period === 'string'), '每条登记一条 entry_created 事件');
  });

  // ═══════════════════════ 6 关联需求条目 ═══════════════════════
  test(`${T_ITEMS}——item_ids 写 entry_items：条目在生效总体规划里取现行版本（不取更新的版本），不在规划里取最新版本；assigned_by_action_id 为空；别的项目的条目 400；规划内未上线 + 规划外混合 → 拆分，全部已上线 → 409，知悉类不分流`, async () => {
    const pid = await newProject();
    const eff = await produceEffectiveOverall(pid);
    const inPlan = await sqlGet('SELECT item_id FROM sysbuild_item_versions WHERE id = ?', [eff.itemVersionId]);
    // 在规划里的条目再出一个新版本（待处理版本）：登记关联的仍是现行版本
    const nv = await post(U.pm, `/sysbuild/items/${inPlan.item_id}/versions`, { content: '需求：新版本', no_written_evidence: true, no_evidence_reason: '口头电话确认了本次需求内容' });
    assert.strictEqual(nv.status, 201, nv.text);
    // 不在规划里的条目：有两个版本，取最新
    const loose = await mkItem(pid);
    const nv2 = await post(U.pm, `/sysbuild/items/${loose.id}/versions`, { content: '需求：第二版', no_written_evidence: true, no_evidence_reason: '口头电话确认了本次需求内容' });
    assert.strictEqual(nv2.status, 201, nv2.text);
    const e = await regOk(U.pm, pid, { type: 'feedback', item_ids: [inPlan.item_id, loose.id] });
    const rows = await sqlAll('SELECT item_id, item_version_id, assigned_by_action_id FROM sysbuild_entry_items WHERE entry_id = ? ORDER BY item_id', [e.id]);
    const expectedLoose = nv2.body.item_version_id;
    assert.deepStrictEqual(rows.map((r) => [r.item_id, r.item_version_id, r.assigned_by_action_id]).sort((a, b) => a[0] - b[0]), [
      [inPlan.item_id, eff.itemVersionId, null], [loose.id, expectedLoose, null],
    ].sort((a, b) => a[0] - b[0]), '现行版本 / 最新版本');
    assert.deepStrictEqual(e.items.map((i) => [i.item_id, i.item_version_id]).sort((a, b) => a[0] - b[0]), [[inPlan.item_id, eff.itemVersionId], [loose.id, expectedLoose]].sort((a, b) => a[0] - b[0]), '详情返回关联条目');
    assert.ok(e.items.every((i) => /^R-\d+$/.test(i.code) && i.version_no >= 1));
    // 别的项目的条目
    const other = await newProject();
    const foreign = await mkItem(other);
    const r = await reg(U.pm, pid, { item_ids: [foreign.id] });
    expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', '别的项目的条目');
    assert.strictEqual(r.body.field, 'item_ids');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE project_id = ? AND title = ? AND parent_entry_id IS NULL', [pid, '标题']), 1, '被拒的请求不留行（e 同时关联规划内与规划外条目，S-S1b 起会拆成子项，子项复制标题，所以只数顶层登记）');
    // S-S1b 起 e 同时关联「规划内、未上线」与「规划外」的条目：登记照常受理并按去向拆成两个处理项，原登记成为已拆分容器（分流与拆分的完整用例在 sysbuild-api-suite-routing.js）
    assert.strictEqual(e.conclusion_state, 'split_container');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE parent_entry_id = ?', [e.id]), 2, '拆成两个处理项');
    // 条目所在批次正式上线（夹具：上线事件，C6 有生产写入口后改生产路径复验）：只关联已上线条目的办理类登记被拒绝新增（409，引导系统迭代），不留行
    const batch = await defaultBatchId(pid);
    const before = await countOf('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE project_id = ?', [pid]);
    await sqlRun("INSERT INTO sysbuild_golive_events (batch_id, kind, handover_snapshot_json, created_by, created_at) VALUES (?, 'golive', '{}', ?, datetime('now','localtime','-1 hour'))", [batch, U.pm]);
    const live = await reg(U.pm, pid, { type: 'issue', item_ids: [inPlan.item_id] });
    expectErr(live, 409, 'SYSBUILD_STATE', '已上线条目的问题');
    assert.strictEqual(live.body.guide, 'sys_iteration');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE project_id = ?', [pid]), before, '被拒的请求不留行');
    // 知悉类登记（补充说明）不分流，仍可关联已上线条目，也没有判定快照
    const note = await regOk(U.pm, pid, { type: 'note', item_ids: [inPlan.item_id] });
    assert.strictEqual(note.items.length, 1);
    assert.strictEqual(note.routing, null, '知悉类不分流');
  });

  // ═══════════════════════ 7 确认人解析 ═══════════════════════
  test(`${T_CONFIRMER}——七种：PM 本人 / 内部成员 / 需求方一般成员 → 代表人 / 需求方负责人本人 → 本人 / PM 代登需求方 → 代表人 / 开发方代表人 / 来源方无代表人 → conclude 409；读接口 confirmer 与执行同一个函数`, async () => {
    const s = await mkScene();
    // 1 PM 本人登记（来源方空）：不需要确认
    const e1 = await regOk(U.pm, s.pid, { type: 'feedback' });
    assert.deepStrictEqual([e1.confirmer.kind, e1.confirmer.text], ['none', '不需要']);
    const r1 = await actOk(U.pm, e1.id, CONCLUDE);
    assert.strictEqual(r1.task, null);
    assert.strictEqual(r1.entry.conclusion_state, 'settled_no_confirm');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE object_type = 'conclusion' AND object_id = ?", [e1.id]), 0, '不生成确认任务');
    expectErr(await act(U.pm, e1.id, CONCLUDE), 409, 'SYSBUILD_STATE', '已确定（不需确认）也是有效结论，不能再给结论');
    expectErr(await act(U.pm, e1.id, { action: 'void', reason: '想作废' }), 409, 'SYSBUILD_STATE', '已确定的结论后不能作废');
    // 2 内部成员登记：不需要确认
    const e2 = await regOk(U.cand, s.pid, { type: 'issue' });
    assert.strictEqual(e2.confirmer.kind, 'none');
    assert.strictEqual((await actOk(U.pm, e2.id, CONCLUDE)).entry.conclusion_state, 'settled_no_confirm');
    // 3 需求方一般成员 → 该方生效代表人（授权依据）
    const e3 = await regOk(U.m1, s.pid, { type: 'feedback' });
    assert.deepStrictEqual([e3.confirmer.kind, e3.confirmer.member_id, e3.confirmer.role, e3.confirmer.proxy_only], ['delegate', s.A.mDel, '代表人', false]);
    const r3 = await actOk(U.pm, e3.id, CONCLUDE);
    const t3 = await lastTask(e3.id, 'conclusion');
    assert.deepStrictEqual([t3.purpose, t3.party_id, t3.member_id, t3.user_id, t3.basis_appointment_id, t3.basis_delegation_id, t3.status, t3.action_id], ['conclusion_confirm', s.A.party, s.A.mDel, U.del, null, s.A.dlg, 'pending', r3.action_id]);
    assert.strictEqual(r3.entry.conclusion_state, 'pending_confirm');
    // 4 需求方负责人本人登记 → 负责人本人（专用权限；依据任职）
    const e4 = await regOk(U.own, s.pid, { type: 'issue' });
    assert.deepStrictEqual([e4.confirmer.kind, e4.confirmer.member_id, e4.confirmer.role], ['owner', s.A.mOwn, '负责人']);
    await actOk(U.pm, e4.id, CONCLUDE);
    const t4 = await lastTask(e4.id, 'conclusion');
    assert.deepStrictEqual([t4.member_id, t4.user_id, t4.basis_appointment_id, t4.basis_delegation_id], [s.A.mOwn, U.own, s.A.apt, null]);
    // 5 PM 代登需求方 → 代表人（不是负责人）
    const e5 = await regOk(U.pm, s.pid, { type: 'feedback', source_party_id: s.A.party });
    assert.deepStrictEqual([e5.confirmer.kind, e5.confirmer.member_id], ['delegate', s.A.mDel]);
    await actOk(U.pm, e5.id, CONCLUDE);
    assert.strictEqual((await lastTask(e5.id, 'conclusion')).user_id, U.del);
    // 6 开发方代表人登记 → 开发方代表人本人；开发方负责人登记 → 本人
    const e6 = await regOk(U.x2, s.pid, { type: 'feedback' });
    assert.deepStrictEqual([e6.confirmer.kind, e6.confirmer.member_id], ['delegate', s.mDevDel]);
    await actOk(U.pm, e6.id, CONCLUDE);
    assert.deepStrictEqual([(await lastTask(e6.id, 'conclusion')).user_id, (await lastTask(e6.id, 'conclusion')).party_id], [U.x2, s.D]);
    const e6b = await regOk(U.x1, s.pid, { type: 'feedback' });
    assert.deepStrictEqual([e6b.confirmer.kind, e6b.confirmer.member_id], ['owner', s.mDevOwn]);
    // 6b 乙部负责人登记而乙部没有代表人：负责人本人确认本人提出的登记（专用权限），不要求代表人
    const e6c = await regOk(U.cand2, s.pid, { type: 'feedback' });
    assert.deepStrictEqual([e6c.confirmer.kind, e6c.confirmer.member_id], ['owner', s.mBOwn]);
    assert.strictEqual((await actOk(U.pm, e6c.id, CONCLUDE)).task.kind, 'owner');
    // 7 来源方无代表人（乙部一般成员登记）→ confirmer unavailable；conclude / for_reference 409 且不写任何办理记录
    const e7 = await regOk(U.x3, s.pid, { type: 'feedback' });
    assert.deepStrictEqual([e7.confirmer.kind, e7.confirmer.text, e7.actions.conclude, e7.actions.for_reference], ['unavailable', '暂无代表人', false, false]);
    const c7 = await act(U.pm, e7.id, CONCLUDE);
    expectErr(c7, 409, 'SYSBUILD_STATE', '来源方无代表人');
    assert.ok(c7.body.message.includes('暂无代表人'), c7.body.message);
    expectErr(await act(U.pm, e7.id, { action: 'for_reference' }), 409, 'SYSBUILD_STATE', '来源方无代表人：仅供参考');
    assert.strictEqual((await actionsRows(e7.id)).length, 0, '被拒的动作不写办理记录');
    // PM 代登乙部也一样（来源方是乙部）；授权代表人后即可办理
    const e7b = await regOk(U.pm, s.pid, { type: 'issue', source_party_id: s.B });
    expectErr(await act(U.pm, e7b.id, CONCLUDE), 409, 'SYSBUILD_STATE', 'PM 代登乙部');
    const mNew = await addMember(s.pid, U.out);
    const dl = await addDelegation(s.B, mNew, s.aptB, 'active');
    assert.ok(dl > 0);
    const after = await detail(U.pm, e7.id);
    assert.deepStrictEqual([after.confirmer.kind, after.confirmer.member_id, after.actions.conclude], ['delegate', mNew, true], '授权代表人后 confirmer 与标志随之变化');
    assert.strictEqual((await actOk(U.pm, e7.id, CONCLUDE)).entry.conclusion_state, 'pending_confirm');
    // P93：负责人分支须「登记时快照是负责人（参与方 = 来源方）且此刻仍是该方现任负责人」。
    //   (a) 一般成员登记后才被任命为负责人 → 确认人仍是代表人，不是他自己
    const s2 = await mkScene();
    const ea = await regOk(U.m2, s2.pid, { type: 'feedback' });
    assert.deepStrictEqual([ea.confirmer.kind, ea.operator_identity.is_owner], ['delegate', false]);
    await sqlRun("UPDATE sysbuild_appointments SET status = 'ended', ended_at = '2026-10-20 10:00:00', end_reason = '换人' WHERE id = ?", [s2.A.apt]);
    const aptM2 = await addAppointment(s2.A.party, s2.mM2, 'active');
    assert.ok(aptM2 > 0);
    const ea2 = await detail(U.pm, ea.id);
    assert.deepStrictEqual([ea2.confirmer.kind, ea2.confirmer.member_id], ['delegate', s2.A.mDel], '登记后才任命为负责人：走代表人');
    await actOk(U.pm, ea.id, CONCLUDE);
    const ta = await lastTask(ea.id, 'conclusion');
    assert.deepStrictEqual([ta.user_id, ta.basis_appointment_id, ta.basis_delegation_id], [U.del, null, s2.A.dlg]);
    //   (b) 登记时是负责人、后来卸任（另有人接任）→ 代表人；卸任后无人接任同样走代表人
    const s3 = await mkScene();
    const eb = await regOk(U.own, s3.pid, { type: 'feedback' });
    assert.deepStrictEqual([eb.confirmer.kind, eb.operator_identity.is_owner, eb.operator_identity.party_id], ['owner', true, s3.A.party]);
    await sqlRun("UPDATE sysbuild_appointments SET status = 'ended', ended_at = '2026-10-20 10:00:00', end_reason = '卸任' WHERE id = ?", [s3.A.apt]);
    assert.strictEqual((await detail(U.pm, eb.id)).confirmer.kind, 'delegate', '卸任后无人接任：走代表人');
    await addAppointment(s3.A.party, s3.mM1, 'active');
    assert.deepStrictEqual([(await detail(U.pm, eb.id)).confirmer.kind, (await detail(U.pm, eb.id)).confirmer.member_id], ['delegate', s3.A.mDel], '卸任后他人接任：走代表人');
    // admin 非成员登记：不需要确认
    const eA = await regOk(U.admin, s.pid, { type: 'feedback' });
    assert.strictEqual(eA.confirmer.kind, 'none');
    // 确认人是无账号成员：任务 proxy_only
    const na = await sqlRun("INSERT INTO sysbuild_members (project_id, party_id, user_id, person_name, joined_at, added_by) VALUES (?, ?, NULL, '无账号代表', '2026-10-01 10:00:00', ?)", [s.pid, s.D, U.admin]);
    await sqlRun("UPDATE sysbuild_delegations SET status = 'revoked', revoked_at = '2026-10-20 10:00:00', revoke_reason = '更换' WHERE id = ?", [s.dlgD]);
    await addDelegation(s.D, na.lastID, s.aptD, 'active');
    const eNa = await regOk(U.m1, s.pid, { type: 'feedback', source_party_id: undefined });
    assert.strictEqual(eNa.confirmer.member_id, s.A.mDel, '甲部代表人仍是有账号的 del');
    const eNb = await regOk(U.pm, s.pid, { type: 'feedback', source_party_id: s.D });
    assert.deepStrictEqual([eNb.confirmer.kind, eNb.confirmer.member_id, eNb.confirmer.proxy_only], ['delegate', na.lastID, true]);
    assert.strictEqual((await actOk(U.pm, eNb.id, CONCLUDE)).task.proxy_only, true);
  });

  // ═══════════════════════ 8 结论流 ═══════════════════════
  test(`${T_FLOW}——conclude → 待确认；代表人打开 + 确认 → 已确认；有异议 → PM 再 conclude → 确认；待确认期间改结论：旧修订 superseded（PM 已改结论）；已有有效结论 409；结论确认 reject 400；未浏览 409 NOT_VIEWED；冻结登记附件只一次`, async () => {
    const s = await mkScene();
    const att = await stageAtt(s.pid, U.m1, 'a');
    const e = await regOk(U.m1, s.pid, { type: 'feedback', attachment_ids: [att] });
    assert.strictEqual(e.conclusion_state, 'none');
    assert.strictEqual(e.current_conclusion, null);
    // 1 conclude → 待确认
    const c1 = await actOk(U.pm, e.id, CONCLUDE);
    assert.strictEqual(c1.entry.conclusion_state, 'pending_confirm');
    assert.deepStrictEqual([c1.entry.current_conclusion.kind, c1.entry.current_conclusion.text, c1.entry.current_conclusion.action_id], ['handled', '已处理，见方案说明', c1.action_id]);
    const t1 = await lastTask(e.id, 'conclusion');
    assert.deepStrictEqual([t1.user_id, t1.status, t1.action_id], [U.del, 'pending', c1.action_id]);
    // 冻结：登记附件冻结为 (entry, 登记编号)，浏览记录按任务自己的对象类型 / 结论动作编号
    const frozen = await sqlAll("SELECT attachment_id FROM sysbuild_frozen_attachments WHERE object_type = 'entry' AND object_version_id = ?", [e.id]);
    assert.deepStrictEqual(frozen.map((f) => f.attachment_id), [att]);
    // 2 未浏览直接决策 → 409 NOT_VIEWED（先拿到 revision 编号但不打开）
    const noView = await decideRaw(U.del, t1.tid, { revision_id: t1.rid, object_version_id: t1.action_id, decision: 'confirm', checkbox_text: CHECKBOX });
    expectErr(noView, 409, 'SYSBUILD_NOT_VIEWED', '未浏览');
    // 非必需确认人（PM、其他成员）不能决策 403
    expectErr(await decideRaw(U.pm, t1.tid, { revision_id: t1.rid, object_version_id: t1.action_id, decision: 'confirm', checkbox_text: CHECKBOX }), 403, 'SYSBUILD_FORBIDDEN', 'PM 不是必需确认人');
    // 3 打开：任务详情带登记原文、结论原文、冻结清单；只有必需确认人打开才写浏览记录
    const vBefore = await countOf("SELECT COUNT(*) AS n FROM sysbuild_views WHERE object_type = 'conclusion' AND object_version_id = ?", [c1.action_id]);
    const pmOpen = await openIds(U.pm, t1.tid);
    assert.strictEqual(pmOpen.view_id, null);
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_views WHERE object_type = 'conclusion' AND object_version_id = ?", [c1.action_id]), vBefore, 'PM 打开不写浏览记录');
    const o = await openIds(U.del, t1.tid);
    assert.ok(o.view_id > 0);
    assert.strictEqual(o.object.type, 'conclusion');
    assert.deepStrictEqual([o.object.entry.id, o.object.entry.title, o.object.entry.body, o.object.conclusion.kind, o.object.conclusion.text, o.object.entry_state], [e.id, '标题', '内容', 'handled', '已处理，见方案说明', 'pending_confirm']);
    assert.deepStrictEqual(o.frozen_attachments.map((f) => f.attachment_id), [att], '冻结清单');
    assert.strictEqual(o.actions.decide, true);
    assert.strictEqual((await openIds(U.pm, t1.tid)).actions.decide, false);
    // reject 对结论确认 400（按固定文案提交，不是文案不符）
    const rj = await decideRaw(U.del, t1.tid, decideBodyOf(o, 'reject'));
    expectErr(rj, 400, 'SYSBUILD_INVALID_INPUT', '结论确认不认 reject');
    assert.strictEqual(rj.body.field, 'decision');
    assert.strictEqual((await lastTask(e.id, 'conclusion')).status, 'pending', '400 不改状态');
    // 4 确认 → 已确认
    const d1 = await decideRaw(U.del, t1.tid, decideBodyOf(o, 'confirm'));
    assert.strictEqual(d1.status, 200, d1.text);
    assert.deepStrictEqual([d1.body.decision, d1.body.entry.conclusion_state], ['confirm', 'confirmed']);
    assert.strictEqual((await detail(U.pm, e.id)).conclusion_state, 'confirmed');
    const cf = await sqlGet('SELECT object_type, object_version_id, method, decision, actor_user_id FROM sysbuild_confirmations WHERE task_revision_id = ?', [t1.rid]);
    assert.deepStrictEqual([cf.object_type, cf.object_version_id, cf.method, cf.decision, cf.actor_user_id], ['conclusion', c1.action_id, 'platform', 'confirm', U.del]);
    // 5 已有有效结论：conclude / for_reference / void 都 409
    expectErr(await act(U.pm, e.id, CONCLUDE), 409, 'SYSBUILD_STATE', '已确认后再给结论');
    expectErr(await act(U.pm, e.id, { action: 'for_reference' }), 409, 'SYSBUILD_STATE', '已确认后标仅供参考');
    expectErr(await act(U.pm, e.id, { action: 'void', reason: '作废' }), 409, 'SYSBUILD_STATE', '已确认后作废');
    // 同一修订不能二次决策
    expectErr(await decideRaw(U.del, t1.tid, decideBodyOf(o, 'confirm')), 409, 'SYSBUILD_STATE', '修订已处理');
    // 冻结只有一次：之后的任务不重复冻结
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_frozen_attachments WHERE object_type = 'entry' AND object_version_id = ?", [e.id]), 1);

    // 有异议 → PM 再 conclude → 确认
    const e2 = await regOk(U.m1, s.pid, { type: 'issue', attachment_ids: [await stageAtt(s.pid, U.m1, 'b')] });
    await actOk(U.pm, e2.id, CONCLUDE);
    const t2 = await lastTask(e2.id, 'conclusion');
    const od = await openAndDecide(U.del, t2.tid, 'object', { reason: '结论没有回答我们的问题' });
    assert.strictEqual(od.status, 200, od.text);
    assert.deepStrictEqual([od.body.decision, od.body.entry.conclusion_state], ['object', 'objected']);
    assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_confirm_task_revisions WHERE id = ?', [t2.rid])).status, 'objected');
    // 有异议不能再改发，但 PM 可以再给结论；新任务、新修订；异议历史留在确认页
    const c2 = await actOk(U.pm, e2.id, { action: 'conclude', conclusion_kind: 'adopted', text: '按意见调整后重新给出结论' });
    assert.strictEqual(c2.entry.conclusion_state, 'pending_confirm');
    const t2b = await lastTask(e2.id, 'conclusion');
    assert.notStrictEqual(t2b.tid, t2.tid, '新结论 = 新任务');
    assert.strictEqual(t2b.action_id, c2.action_id);
    const o2 = await openIds(U.del, t2b.tid);
    assert.deepStrictEqual(o2.object.objections.map((x) => [x.source, x.reason]), [['conclusion_confirm', '结论没有回答我们的问题']], '确认页带异议历史');
    assert.strictEqual(o2.object.conclusion.kind, 'adopted');
    assert.strictEqual((await decideRaw(U.del, t2b.tid, decideBodyOf(o2, 'confirm'))).status, 200);
    assert.strictEqual(await stateOf(e2.id), 'confirmed');
    assert.strictEqual((await actionsRows(e2.id)).length, 2, '旧结论保留在办理记录里');
    // 冻结仍只一次（两个结论任务共用一份）
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_frozen_attachments WHERE object_type = 'entry' AND object_version_id = ?", [e2.id]), 1);

    // 待确认期间改结论：旧待确认修订 → superseded（原因「PM 已改结论」），旧任务不能再决策
    const e3 = await regOk(U.m1, s.pid, { type: 'feedback' });
    await actOk(U.pm, e3.id, CONCLUDE);
    const t3 = await lastTask(e3.id, 'conclusion');
    // 同项目另一条登记也有待确认的结论：改 e3 的结论只关 e3 自己的修订，不动别的登记的（L3：按登记编号限定）
    const eOther = await regOk(U.m2, s.pid, { type: 'issue' });
    await actOk(U.pm, eOther.id, CONCLUDE);
    const tOther = await lastTask(eOther.id, 'conclusion');
    const c3 = await actOk(U.pm, e3.id, { action: 'conclude', conclusion_kind: 'not_adopted', text: '改为不采纳' });
    assert.deepStrictEqual(c3.closed_revision_ids, [t3.rid]);
    assert.strictEqual((await lastTask(eOther.id, 'conclusion')).status, 'pending', '别的登记的待确认修订不被关');
    assert.strictEqual(await stateOf(eOther.id), 'pending_confirm');
    assert.ok(tOther.rid > 0);
    const old = await sqlGet('SELECT status, status_reason FROM sysbuild_confirm_task_revisions WHERE id = ?', [t3.rid]);
    assert.deepStrictEqual([old.status, old.status_reason], ['superseded', 'PM 已改结论']);
    const stale = await decideRaw(U.del, t3.tid, { revision_id: t3.rid, object_version_id: t3.action_id, decision: 'confirm', checkbox_text: CHECKBOX });
    expectErr(stale, 409, 'SYSBUILD_STATE', '旧修订已被替代');
    assert.strictEqual(await stateOf(e3.id), 'pending_confirm');
    assert.deepStrictEqual((await eventsOfType(s.pid, 'confirm_revision_superseded')).filter((ev) => JSON.parse(ev.payload_json).entry_id === e3.id).length, 1);
    // 库内被改动（夹具，用完恢复）：旧修订被写回「待确认」而它对应的结论已不是登记的当前结论 → 决策 409 SYSBUILD_VERSION_CHANGED（确认的对象已变），不能确认一条被改掉的旧结论
    await sqlRun("UPDATE sysbuild_confirm_task_revisions SET status = 'pending', status_reason = NULL WHERE id = ?", [t3.rid]);
    try {
      const o3 = await openIds(U.del, t3.tid);
      assert.strictEqual(o3.actions.decide, false, '旧结论的任务 actions.decide 为假');
      expectErr(await decideRaw(U.del, t3.tid, decideBodyOf(o3, 'confirm')), 409, 'SYSBUILD_VERSION_CHANGED', '旧结论的待确认修订');
      // 改发同样要求对象仍是登记的当前结论（L3：entry_conclusion_reissue 的 objectPending 判定）
      assert.strictEqual((await openIds(U.pm, t3.tid)).actions.reissue, false, '旧结论的任务 PM 视角 actions.reissue 为假');
      const rs = await post(U.pm, `/sysbuild/confirm-tasks/${t3.tid}/reissue`, { reason: '想改发旧结论' });
      expectErr(rs, 409, 'SYSBUILD_STATE', '旧结论的待确认修订不能改发');
      assert.ok(rs.body.message.includes('当前结论'), rs.body.message);
    } finally {
      await sqlRun("UPDATE sysbuild_confirm_task_revisions SET status = 'superseded', status_reason = 'PM 已改结论' WHERE id = ?", [t3.rid]);
    }
    // 事件
    const evs = (await eventsOfType(s.pid, 'entry_action_recorded')).map((x) => JSON.parse(x.payload_json)).filter((p) => p.action_id === c1.action_id);
    assert.deepStrictEqual([evs.length, evs[0].action, evs[0].conclusion_kind, evs[0].task_id], [1, 'conclude', 'handled', t1.tid]);
  });

  // ═══════════════════════ 8b 交裁定 ═══════════════════════
  test(`${T_ESC}——有异议 → 交负责人裁定 → 负责人确认（裁定通过，最终）/ 不认可（裁定未通过，PM 须改结论再发起）；裁定 object 400；裁定不可代录；非有异议不能交裁定；无账号负责人拒绝建任务`, async () => {
    const s = await mkScene();
    const objected = async (type) => {
      const e = await regOk(U.m1, s.pid, { type: type || 'feedback' });
      await actOk(U.pm, e.id, CONCLUDE);
      const t = await lastTask(e.id, 'conclusion');
      assert.strictEqual((await openAndDecide(U.del, t.tid, 'object', { reason: '不同意这个结论' })).status, 200);
      assert.strictEqual(await stateOf(e.id), 'objected');
      return e;
    };
    // 非有异议状态：无结论 / 待确认 / 已确认 都不能交裁定
    const fresh = await regOk(U.m1, s.pid, { type: 'feedback' });
    expectErr(await act(U.pm, fresh.id, { action: 'escalate' }), 409, 'SYSBUILD_STATE', '无结论不能交裁定');
    await actOk(U.pm, fresh.id, CONCLUDE);
    expectErr(await act(U.pm, fresh.id, { action: 'escalate' }), 409, 'SYSBUILD_STATE', '待确认不能交裁定');
    // 1 裁定通过
    const e1 = await objected();
    const esc = await actOk(U.pm, e1.id, { action: 'escalate', text: '谈不拢，请负责人裁定' });
    assert.strictEqual(esc.entry.conclusion_state, 'escalated');
    const at = await lastTask(e1.id, 'adjudication');
    assert.deepStrictEqual([at.purpose, at.user_id, at.member_id, at.basis_appointment_id, at.basis_delegation_id, at.action_id, at.party_id], ['adjudicate', U.own, s.A.mOwn, s.A.apt, null, esc.action_id, s.A.party]);
    // 裁定中：不能再给结论、不能再交裁定、不能作废没问题但此处不测
    expectErr(await act(U.pm, e1.id, CONCLUDE), 409, 'SYSBUILD_STATE', '裁定中不能再给结论');
    expectErr(await act(U.pm, e1.id, { action: 'escalate' }), 409, 'SYSBUILD_STATE', '裁定中不能再交裁定');
    // 代表人不是必需确认人 403；负责人打开后 object 对裁定 400（reason 必填的文案已含），代录不可 409
    const oa = await openIds(U.own, at.tid);
    assert.strictEqual(oa.object.type, 'adjudication');
    assert.deepStrictEqual([oa.object.escalation.action_id, oa.object.escalation.text, oa.object.conclusion.text], [esc.action_id, '谈不拢，请负责人裁定', '已处理，见方案说明']);
    assert.strictEqual(oa.object.objections.length, 1, '裁定页带异议历史');
    expectErr(await decideRaw(U.del, at.tid, { revision_id: at.rid, object_version_id: at.action_id, decision: 'confirm', checkbox_text: CHECKBOX }), 403, 'SYSBUILD_FORBIDDEN', '代表人不是裁定人');
    const bad = await decideRaw(U.own, at.tid, decideBodyOf(oa, 'object'));
    expectErr(bad, 400, 'SYSBUILD_INVALID_INPUT', '裁定不认 object');
    assert.strictEqual(bad.body.field, 'decision');
    await backdateRev(at.rid);
    expectErr(await post(U.pm, `/sysbuild/confirm-tasks/${at.tid}/proxy`, Object.assign({ revision_id: at.rid, object_version_id: at.action_id, decision: 'confirm' }, await proxyEvid(s.pid))), 409, 'SYSBUILD_STATE', '裁定不可代录');
    expectErr(await post(U.m1, `/sysbuild/confirm-tasks/${at.tid}/proxy`, Object.assign({ revision_id: at.rid, object_version_id: at.action_id, decision: 'confirm' }, await proxyEvid(s.pid))), 403, 'SYSBUILD_FORBIDDEN', '非 PM 代录');
    const ok = await decideRaw(U.own, at.tid, decideBodyOf(oa, 'confirm'));
    assert.strictEqual(ok.status, 200, ok.text);
    assert.deepStrictEqual([ok.body.decision, ok.body.entry.conclusion_state], ['confirm', 'adjudicated']);
    // 裁定通过是最终结论：不能再给结论 / 仅供参考 / 作废 / 交裁定
    expectErr(await act(U.pm, e1.id, CONCLUDE), 409, 'SYSBUILD_STATE', '裁定通过后再给结论');
    expectErr(await act(U.pm, e1.id, { action: 'void', reason: '作废' }), 409, 'SYSBUILD_STATE', '裁定通过后作废');
    // 2 裁定未通过：负责人 reject（必须写原因）→ 裁定未通过 → PM 改结论再发起，走代表人确认
    const e2 = await objected('issue');
    await actOk(U.pm, e2.id, { action: 'escalate' });
    const at2 = await lastTask(e2.id, 'adjudication');
    const oa2 = await openIds(U.own, at2.tid);
    const noReason = await decideRaw(U.own, at2.tid, Object.assign(decideBodyOf(oa2, 'reject'), { reason: undefined }));
    expectErr(noReason, 400, 'SYSBUILD_INVALID_INPUT', '不认可必须写原因');
    const rej = await decideRaw(U.own, at2.tid, decideBodyOf(oa2, 'reject'));
    assert.strictEqual(rej.status, 200, rej.text);
    assert.deepStrictEqual([rej.body.decision, rej.body.entry.conclusion_state], ['reject', 'adjudication_rejected']);
    assert.strictEqual((await sqlGet('SELECT checkbox_text FROM sysbuild_confirmations WHERE task_revision_id = ?', [at2.rid])).checkbox_text, CHECKBOX_REJECT);
    const re = await actOk(U.pm, e2.id, { action: 'conclude', conclusion_kind: 'deferred', text: '按负责人意见留待后续', assignee_text: '第 2 批' });
    assert.strictEqual(re.entry.conclusion_state, 'pending_confirm');
    assert.strictEqual((await lastTask(e2.id, 'conclusion')).user_id, U.del, '重新走代表人确认');
    // 裁定未通过后不能直接再交裁定（状态不是有异议）
    expectErr(await act(U.pm, e2.id, { action: 'escalate' }), 409, 'SYSBUILD_STATE', '待确认不能交裁定');
    // 第二次异议 → 第二次交裁定：旧裁定任务（裁定未通过）的修订库内被写回「待确认」（夹具，用完恢复）→ 决策 409 SYSBUILD_VERSION_CHANGED（该裁定已不是登记的当前裁定）
    const t2b = await lastTask(e2.id, 'conclusion');
    assert.strictEqual((await openAndDecide(U.del, t2b.tid, 'object', { reason: '仍然不同意' })).status, 200);
    await actOk(U.pm, e2.id, { action: 'escalate', text: '第二次交裁定' });
    assert.strictEqual(await stateOf(e2.id), 'escalated');
    assert.strictEqual((await tasksOfEntry(e2.id, 'adjudication')).length, 2, '两次交裁定 = 两个裁定任务');
    await sqlRun("UPDATE sysbuild_confirm_task_revisions SET status = 'pending' WHERE id = ?", [at2.rid]);
    try {
      const oldView = await openIds(U.own, at2.tid);
      assert.strictEqual(oldView.actions.decide, false, '旧裁定任务 actions.decide 为假');
      expectErr(await decideRaw(U.own, at2.tid, decideBodyOf(oldView, 'confirm')), 409, 'SYSBUILD_VERSION_CHANGED', '旧裁定已不是当前裁定');
    } finally {
      await sqlRun("UPDATE sysbuild_confirm_task_revisions SET status = 'rejected' WHERE id = ?", [at2.rid]);
    }
    assert.strictEqual(await stateOf(e2.id), 'escalated');
    // 3 来源方没有现任负责人 → 交裁定 409，不建任务；无账号负责人 → 409（裁定只在平台作出）
    const e3 = await regOk(U.pm, s.pid, { type: 'feedback', source_party_id: s.D });
    await actOk(U.pm, e3.id, CONCLUDE);
    const t3 = await lastTask(e3.id, 'conclusion');
    assert.strictEqual((await openAndDecide(U.x2, t3.tid, 'object', { reason: '不同意' })).status, 200);
    await sqlRun("UPDATE sysbuild_appointments SET status = 'ended', ended_at = '2026-10-20 10:00:00', end_reason = '换人' WHERE id = ?", [s.aptD]);
    const miss = await act(U.pm, e3.id, { action: 'escalate' });
    expectErr(miss, 409, 'SYSBUILD_STATE', '没有现任负责人');
    assert.ok(miss.body.message.includes('没有现任负责人'), miss.body.message);
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE object_type = 'adjudication' AND object_id = ?", [e3.id]), 0);
    const na = await sqlRun("INSERT INTO sysbuild_members (project_id, party_id, user_id, person_name, joined_at, added_by) VALUES (?, ?, NULL, '无账号负责人', '2026-10-01 10:00:00', ?)", [s.pid, s.D, U.admin]);
    await addAppointment(s.D, na.lastID, 'active');
    const px = await act(U.pm, e3.id, { action: 'escalate' });
    expectErr(px, 409, 'SYSBUILD_STATE', '无账号负责人');
    assert.ok(px.body.message.includes('没有平台账号'), px.body.message);
    assert.strictEqual(await stateOf(e3.id), 'objected', '被拒绝后状态不变，PM 仍可改结论');
    assert.strictEqual((await actOk(U.pm, e3.id, { action: 'conclude', conclusion_kind: 'handled', text: '改结论' })).entry.conclusion_state, 'pending_confirm');
  });

  // ═══════════════════════ 9 仅供参考与知会 ═══════════════════════
  test(`${T_REF}——feedback 可、issue 409、涉及承诺（初始）409；生成知会给代表人 + 一条平台发送尝试；/my/notices 可见且不写浏览记录；接收人 / 本方负责人可异议 → 仅供参考被异议 → 可 conclude；非接收人 403 / 非成员 404；重复异议 409`, async () => {
    const s = await mkScene();
    const fb = await regOk(U.m1, s.pid, { type: 'feedback' });
    assert.strictEqual((await detail(U.pm, fb.id)).actions.for_reference, true);
    // issue 409；涉及承诺（初始）409
    const iss = await regOk(U.m1, s.pid, { type: 'issue' });
    assert.strictEqual((await detail(U.pm, iss.id)).actions.for_reference, false);
    expectErr(await act(U.pm, iss.id, { action: 'for_reference' }), 409, 'SYSBUILD_STATE', 'issue 不能标仅供参考');
    const cm = await regOk(U.m1, s.pid, { type: 'feedback', commitment_flag: 1, no_written_evidence: true, no_evidence_reason: '口头电话确认了本次需求内容' });
    expectErr(await act(U.pm, cm.id, { action: 'for_reference' }), 409, 'SYSBUILD_STATE', '带初始涉及承诺');
    // 非 PM 403
    expectErr(await act(U.m1, fb.id, { action: 'for_reference' }), 403, 'SYSBUILD_FORBIDDEN', '登记人本人也不能标仅供参考');
    // 标仅供参考：视为有明确结果，不需确认；同事务生成知会
    const viewsBefore = await countOf('SELECT COUNT(*) AS n FROM sysbuild_views', []);
    const r = await actOk(U.pm, fb.id, { action: 'for_reference', text: '界面意见，仅供参考' });
    assert.strictEqual(r.entry.conclusion_state, 'for_reference');
    assert.strictEqual(r.task, null, '不生成确认任务');
    assert.strictEqual(r.entry.current_conclusion.kind, 'for_reference');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE object_type = 'conclusion' AND object_id = ?", [fb.id]), 0);
    const notice = await sqlGet("SELECT * FROM sysbuild_notices WHERE ref_type = 'entry' AND ref_id = ?", [fb.id]);
    assert.deepStrictEqual([notice.kind, notice.project_id, notice.recipient_member_id, notice.created_by], ['for_reference', s.pid, s.A.mDel, U.pm]);
    const att = await sqlAll('SELECT channel, result FROM sysbuild_notice_attempts WHERE notice_id = ?', [notice.id]);
    assert.deepStrictEqual(att.map((a) => [a.channel, a.result]), [['platform', 'sent']], '一条平台发送尝试，不发钉钉');
    assert.strictEqual(r.notice.id, notice.id);
    // 有效结论：不能再给结论 / 再标 / 作废
    expectErr(await act(U.pm, fb.id, CONCLUDE), 409, 'SYSBUILD_STATE', '仅供参考已是有效结论');
    expectErr(await act(U.pm, fb.id, { action: 'void', reason: '作废' }), 409, 'SYSBUILD_STATE', '仅供参考后作废');
    // /my/notices：代表人可见（含登记标题 / 结论 / 是否被异议），其他人不可见；只读，不写浏览记录
    const mine = await get(U.del, '/sysbuild/my/notices');
    assert.strictEqual(mine.status, 200, mine.text);
    const it = mine.body.items.find((x) => x.id === notice.id);
    assert.ok(it, '代表人看得到知会');
    assert.deepStrictEqual([it.kind, it.ref_type, it.ref_id, it.objected, it.entry.title, it.entry.conclusion_state, it.entry.current_conclusion.kind, it.actions.object, it.project_id],
      ['for_reference', 'entry', fb.id, false, '标题', 'for_reference', 'for_reference', true, s.pid]);
    assert.strictEqual(it.as, 'recipient', '代表人是接收人');
    // L6：负责人（来源方现任负责人）也列出这条知会，标 party_owner，且可异议；开发方负责人 / 登记人不列
    const ownMine = (await get(U.own, '/sysbuild/my/notices')).body.items.find((x) => x.id === notice.id);
    assert.ok(ownMine, '来源方现任负责人看得到本方的仅供参考知会');
    assert.deepStrictEqual([ownMine.as, ownMine.actions.object, ownMine.entry.title], ['party_owner', true, '标题']);
    assert.strictEqual((await get(U.x1, '/sysbuild/my/notices')).body.items.some((x) => x.id === notice.id), false, '别方负责人不列');
    // L6：登记详情里每条知会带 actions.object（与 POST /notices/:nid/object 同源）：接收人 / 本方负责人真，其他成员与 PM 假
    const noticeFlag = async (uid) => (await detail(uid, fb.id)).notices.map((n) => n.actions.object);
    assert.deepStrictEqual([await noticeFlag(U.del), await noticeFlag(U.own), await noticeFlag(U.m2), await noticeFlag(U.pm), await noticeFlag(U.ro)], [[true], [true], [false], [false], [false]]);
    // codex 25 M1：原登记人（m1）不是接收人，但有知会异议的资格，所以 /my/notices 里列出（as = registrant）；这里的标志手写核对上面 L6 的五个视角没有登记人，登记人的视角在 sysbuild-api-suite-routing.js 的知会异议用例
    assert.strictEqual((await get(U.m1, '/sysbuild/my/notices')).body.items.find((x) => x.id === notice.id).as, 'registrant', '登记人不是接收人，但列为 registrant');
    assert.strictEqual((await get(U.out, '/sysbuild/my/notices')).body.items.length, 0);
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_views', []), viewsBefore, '读知会不写浏览记录');
    // 异议：非接收人且非本方负责人的项目成员 403（m2 / PM / 开发方负责人）；非成员 404；空原因 400
    for (const uid of [U.m2, U.pm, U.x1]) expectErr(await post(uid, `/sysbuild/notices/${notice.id}/object`, { reason: '想提异议' }), 403, 'SYSBUILD_FORBIDDEN', `用户 ${uid} 不是接收人也不是本方负责人`);
    expectErr(await post(U.out, `/sysbuild/notices/${notice.id}/object`, { reason: '想提异议' }), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    expectErr(await post(U.del, `/sysbuild/notices/${notice.id}/object`, { reason: '   ' }), 400, 'SYSBUILD_INVALID_INPUT', '原因空白');
    expectErr(await post(U.del, `/sysbuild/notices/${notice.id}/object`, {}), 400, 'SYSBUILD_INVALID_INPUT', '缺原因');
    expectErr(await post(U.del, `/sysbuild/notices/${notice.id}/object`, { reason: '有原因', extra: 1 }), 400, 'SYSBUILD_INVALID_INPUT', '多余键');
    expectErr(await post(U.del, '/sysbuild/notices/99999999/object', { reason: '有原因' }), 404, 'SYSBUILD_NOT_FOUND', '知会不存在');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_notice_objections WHERE notice_id = ?', [notice.id]), 0, '被拒不留行');
    // 接收人（代表人）异议 → 仅供参考被异议
    const ob = await post(U.del, `/sysbuild/notices/${notice.id}/object`, { reason: '这条意见有实质内容，请给结论' });
    assert.strictEqual(ob.status, 201, ob.text);
    assert.deepStrictEqual([ob.body.entry.conclusion_state, ob.body.notice.objection.reason, ob.body.notice.objection.member_id], ['for_reference_objected', '这条意见有实质内容，请给结论', s.A.mDel]);
    assert.strictEqual(await stateOf(fb.id), 'for_reference_objected');
    assert.strictEqual((await get(U.del, '/sysbuild/my/notices')).body.items.find((x) => x.id === notice.id).objected, true);
    expectErr(await post(U.del, `/sysbuild/notices/${notice.id}/object`, { reason: '再提一次' }), 409, 'SYSBUILD_STATE', '重复异议');
    expectErr(await post(U.own, `/sysbuild/notices/${notice.id}/object`, { reason: '负责人也不能再提' }), 409, 'SYSBUILD_STATE', '同一知会只能异议一次（负责人）');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_notice_objections WHERE notice_id = ?', [notice.id]), 1);
    // 回到正常办理：可再给结论并经确认；不能再次标仅供参考
    expectErr(await act(U.pm, fb.id, { action: 'for_reference' }), 409, 'SYSBUILD_STATE', '被异议后不能再标仅供参考');
    const back = await actOk(U.pm, fb.id, CONCLUDE);
    assert.strictEqual(back.entry.conclusion_state, 'pending_confirm');
    // M1：仅供参考被异议后，不能再用「改结论 → 待确认 → 再标仅供参考」两步绕回仅供参考（待确认状态对从未被异议的登记仍放行，见下面 fb3）
    const again = await act(U.pm, fb.id, { action: 'for_reference' });
    expectErr(again, 409, 'SYSBUILD_STATE', '曾被异议的登记在待确认期间也不能再标仅供参考');
    assert.ok(again.body.message.includes('已被异议'), again.body.message);
    assert.strictEqual((await detail(U.pm, fb.id)).actions.for_reference, false, '标志同步为假');
    assert.strictEqual(await stateOf(fb.id), 'pending_confirm', '被拒后状态不变');
    const tb = await lastTask(fb.id, 'conclusion');
    assert.strictEqual((await openAndDecide(U.del, tb.tid, 'confirm')).status, 200);
    assert.strictEqual(await stateOf(fb.id), 'confirmed');
    // 结论已变后，旧知会不再能异议（登记不再是「仅供参考」）
    expectErr(await post(U.own, `/sysbuild/notices/${notice.id}/object`, { reason: '结论已变' }), 409, 'SYSBUILD_STATE', '已重新给结论');
    // 来源方现任负责人可以异议（本方负责人）
    const fb2 = await regOk(U.m2, s.pid, { type: 'feedback' });
    await actOk(U.pm, fb2.id, { action: 'for_reference' });
    const n2 = await sqlGet("SELECT id FROM sysbuild_notices WHERE ref_type = 'entry' AND ref_id = ?", [fb2.id]);
    const ownList = (await get(U.own, '/sysbuild/my/notices')).body.items.find((x) => x.id === n2.id);
    assert.deepStrictEqual([ownList.as, ownList.actions.object], ['party_owner', true], '本方负责人在「我的知会」里看到并可异议');
    const own = await post(U.own, `/sysbuild/notices/${n2.id}/object`, { reason: '本方负责人认为应当办理' });
    assert.strictEqual(own.status, 201, own.text);
    assert.deepStrictEqual([own.body.entry.conclusion_state, own.body.notice.objection.actor_user_id, own.body.notice.objection.member_id], ['for_reference_objected', U.own, s.A.mOwn]);
    // PM 自己登记（来源方空）的意见标仅供参考：没有接收人，不写知会
    const pmFb = await regOk(U.pm, s.pid, { type: 'feedback' });
    const pr = await actOk(U.pm, pmFb.id, { action: 'for_reference' });
    assert.deepStrictEqual([pr.entry.conclusion_state, pr.notice], ['for_reference', null]);
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_notices WHERE ref_id = ? AND ref_type = 'entry'", [pmFb.id]), 0);
    // 待确认期间改标仅供参考：旧结论的待确认修订失效，新的是仅供参考
    const fb3 = await regOk(U.m1, s.pid, { type: 'feedback' });
    await actOk(U.pm, fb3.id, CONCLUDE);
    const t3 = await lastTask(fb3.id, 'conclusion');
    const sw = await actOk(U.pm, fb3.id, { action: 'for_reference' });
    assert.deepStrictEqual([sw.closed_revision_ids, sw.entry.conclusion_state], [[t3.rid], 'for_reference']);
    assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_confirm_task_revisions WHERE id = ?', [t3.rid])).status, 'superseded');
    // 异议属既有登记继续办理：已终止项目也可
    const fb4 = await regOk(U.m1, s.pid, { type: 'feedback' });
    await actOk(U.pm, fb4.id, { action: 'for_reference' });
    const n4 = await sqlGet("SELECT id FROM sysbuild_notices WHERE ref_type = 'entry' AND ref_id = ?", [fb4.id]);
    assert.strictEqual((await post(U.admin, `/sysbuild/projects/${s.pid}/status`, { to: 'terminated', reason: 'C5 用例' })).status, 200);
    assert.strictEqual((await post(U.del, `/sysbuild/notices/${n4.id}/object`, { reason: '终止后仍可异议' })).status, 201);
    // C6b（P158，替换 C5 的占位）：改期知会（kind = schedule_change，夹具直接写库；生产路径与完整用例在 sysbuild-api-suite-notify.js）的异议按知会来源判资格——
    //   只有接收人本人、且仍是需求部门现任负责人；其他人 403（含接收人以外的代表人、一般成员），非成员 404；接收人（现任负责人）提异议成功，转 PM（mode = to_pm，无异议登记），同一知会只能异议一次（409）。
    const sched = await sqlRun("INSERT INTO sysbuild_notices (project_id, kind, ref_type, ref_id, recipient_member_id, created_by) VALUES (?, 'schedule_change', 'node', ?, ?, ?)", [s.pid, await nodeId(s.pid, 'b_req'), s.A.mOwn, U.pm]);
    const objUrl = `/sysbuild/notices/${sched.lastID}/object`;
    expectErr(await post(U.m2, objUrl, { reason: '想异议' }), 403, 'SYSBUILD_FORBIDDEN', '非接收人、非负责人');
    expectErr(await post(U.m1, objUrl, { reason: '想异议' }), 403, 'SYSBUILD_FORBIDDEN', '一般成员');
    expectErr(await post(U.out, objUrl, { reason: '想异议' }), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    expectErr(await post(U.del, objUrl, { reason: '代表人想异议' }), 403, 'SYSBUILD_FORBIDDEN', '本方代表人不是接收人');
    expectErr(await post(U.pm, objUrl, { reason: 'PM 想异议' }), 403, 'SYSBUILD_FORBIDDEN', 'PM 不是接收人');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_notice_objections WHERE notice_id = ?', [sched.lastID]), 0);
    const okSched = await post(U.own, objUrl, { reason: '负责人（接收人）提异议' });
    assert.strictEqual(okSched.status, 201, okSched.text);
    assert.deepStrictEqual([okSched.body.mode, okSched.body.objection_entry_id], ['to_pm', null]);
    expectErr(await post(U.own, objUrl, { reason: '再提一次' }), 409, 'SYSBUILD_STATE', '同一知会只能异议一次');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_notice_objections WHERE notice_id = ?', [sched.lastID]), 1);
  });

  // ═══════════════════════ 10 D43 标记 ═══════════════════════
  test(`${T_MARK}——mark / unmark 涉及承诺与风险：当前值 = 初始值 + 动作按时间归并；重复标 / 重复取消 409；原因必填；风险只 issue；PM 才能；取消涉及承诺后可标仅供参考；已标仅供参考不能补标承诺`, async () => {
    const s = await mkScene();
    const e = await regOk(U.m1, s.pid, { type: 'issue' });
    assert.deepStrictEqual([e.commitment_current, e.risk_current, e.commitment_flag, e.is_risk], [false, false, false, false]);
    // 原因必填 / 非 PM 403 / 状态 409
    expectErr(await act(U.pm, e.id, { action: 'mark_commitment' }), 400, 'SYSBUILD_INVALID_INPUT', '缺原因');
    expectErr(await act(U.pm, e.id, { action: 'mark_commitment', reason: '   ' }), 400, 'SYSBUILD_INVALID_INPUT', '空白原因');
    expectErr(await act(U.m1, e.id, { action: 'mark_commitment', reason: '想标' }), 403, 'SYSBUILD_FORBIDDEN', '登记人不能补标');
    expectErr(await act(U.pm, e.id, { action: 'unmark_commitment', reason: '取消' }), 409, 'SYSBUILD_STATE', '没标就取消');
    expectErr(await act(U.pm, e.id, { action: 'unmark_risk', reason: '取消' }), 409, 'SYSBUILD_STATE', '没标风险就取消');
    // 补标 → 当前值 true，初始列不变；重复补标 409
    const m1 = await actOk(U.pm, e.id, { action: 'mark_commitment', reason: '会上口头承诺了工期' });
    assert.deepStrictEqual([m1.entry.commitment_current, m1.entry.commitment_flag], [true, false]);
    assert.strictEqual((await sqlGet('SELECT commitment_flag FROM sysbuild_entries WHERE id = ?', [e.id])).commitment_flag, 0, '初始列不改写');
    expectErr(await act(U.pm, e.id, { action: 'mark_commitment', reason: '重复' }), 409, 'SYSBUILD_STATE', '重复补标');
    // 取消 → false；再补标 → true（按时间归并）
    assert.strictEqual((await actOk(U.pm, e.id, { action: 'unmark_commitment', reason: '核实后并无承诺' })).entry.commitment_current, false);
    expectErr(await act(U.pm, e.id, { action: 'unmark_commitment', reason: '重复取消' }), 409, 'SYSBUILD_STATE', '重复取消');
    assert.strictEqual((await actOk(U.pm, e.id, { action: 'mark_commitment', reason: '再次确认有承诺' })).entry.commitment_current, true);
    // 风险
    const k1 = await actOk(U.pm, e.id, { action: 'mark_risk', reason: '可能影响上线' });
    assert.deepStrictEqual([k1.entry.risk_current, k1.entry.is_risk], [true, false]);
    expectErr(await act(U.pm, e.id, { action: 'mark_risk', reason: '重复' }), 409, 'SYSBUILD_STATE', '重复标风险');
    assert.strictEqual((await actOk(U.pm, e.id, { action: 'unmark_risk', reason: '风险解除' })).entry.risk_current, false);
    // 办理记录里四类动作都有，原因在 text
    const rows = await actionsRows(e.id);
    assert.deepStrictEqual(rows.map((r) => [r.action, r.text]), [
      ['mark_commitment', '会上口头承诺了工期'], ['unmark_commitment', '核实后并无承诺'], ['mark_commitment', '再次确认有承诺'], ['mark_risk', '可能影响上线'], ['unmark_risk', '风险解除'],
    ]);
    // 风险只 issue：feedback / note 补标风险 409（取消同）
    const fb = await regOk(U.m1, s.pid, { type: 'feedback' });
    expectErr(await act(U.pm, fb.id, { action: 'mark_risk', reason: '想标' }), 409, 'SYSBUILD_STATE', '意见与反馈补标风险');
    expectErr(await act(U.pm, fb.id, { action: 'unmark_risk', reason: '想取消' }), 409, 'SYSBUILD_STATE', '意见与反馈取消风险');
    // 初始风险 = 1 的问题：取消 → false；初始承诺 = 1：取消 → false，初始列仍为 1
    const ir = await regOk(U.pm, s.pid, { type: 'issue', is_risk: 1, commitment_flag: 1, no_written_evidence: true, no_evidence_reason: '口头电话确认了本次需求内容' });
    assert.deepStrictEqual([ir.risk_current, ir.commitment_current], [true, true]);
    expectErr(await act(U.pm, ir.id, { action: 'mark_risk', reason: '已标' }), 409, 'SYSBUILD_STATE', '初始已标风险');
    expectErr(await act(U.pm, ir.id, { action: 'mark_commitment', reason: '已标' }), 409, 'SYSBUILD_STATE', '初始已标承诺');
    const u = await actOk(U.pm, ir.id, { action: 'unmark_risk', reason: '风险解除' });
    assert.deepStrictEqual([u.entry.risk_current, u.entry.is_risk], [false, true]);
    // M2（派单「当前或初始」）：登记时的初始承诺标记即使被取消，也不能标仅供参考
    const fc = await regOk(U.m1, s.pid, { type: 'feedback', commitment_flag: 1, no_written_evidence: true, no_evidence_reason: '口头电话确认了本次需求内容' });
    expectErr(await act(U.pm, fc.id, { action: 'for_reference' }), 409, 'SYSBUILD_STATE', '承诺未取消');
    assert.strictEqual((await actOk(U.pm, fc.id, { action: 'unmark_commitment', reason: '核实无承诺' })).entry.commitment_current, false);
    const fcRef = await act(U.pm, fc.id, { action: 'for_reference' });
    expectErr(fcRef, 409, 'SYSBUILD_STATE', '初始承诺标记被取消后仍不能标仅供参考');
    assert.ok(fcRef.body.message.includes('登记时'), fcRef.body.message);
    assert.strictEqual((await detail(U.pm, fc.id)).actions.for_reference, false, '标志同步为假');
    assert.strictEqual(await stateOf(fc.id), 'none');
    // 初始没有承诺标记：补标 → 取消后可标仅供参考；之后不能补标承诺
    const fe = await regOk(U.m1, s.pid, { type: 'feedback' });
    await actOk(U.pm, fe.id, { action: 'mark_commitment', reason: '先补标' });
    assert.strictEqual((await actOk(U.pm, fe.id, { action: 'unmark_commitment', reason: '核实无承诺' })).entry.commitment_current, false);
    assert.strictEqual((await detail(U.pm, fe.id)).actions.for_reference, true);
    assert.strictEqual((await actOk(U.pm, fe.id, { action: 'for_reference' })).entry.conclusion_state, 'for_reference');
    expectErr(await act(U.pm, fe.id, { action: 'mark_commitment', reason: '补标' }), 409, 'SYSBUILD_STATE', '已标仅供参考不能补标承诺');
    // 补标后再标仅供参考 409
    const fd = await regOk(U.m1, s.pid, { type: 'feedback' });
    await actOk(U.pm, fd.id, { action: 'mark_commitment', reason: '补标' });
    expectErr(await act(U.pm, fd.id, { action: 'for_reference' }), 409, 'SYSBUILD_STATE', '补标后不能标仅供参考');
  });

  // ═══════════════════════ 11 终止项目 ═══════════════════════
  test(`${T_TERM}——终止项目：待确认的结论确认 / 裁定修订不失效，终止后仍可决策，/my/confirmations 仍列出；内容包修订照旧失效（回归）；已结项（夹具）同样可决策；PM 仍可继续办理`, async () => {
    // 只有甲部（负责人 own + 代表人 del）一个需求方，才能满足总体规划包的必需确认人齐全前置
    const s = { pid: await newProject() };
    s.A = await seedParty(s.pid, '甲部', U.own, U.del);
    s.mM1 = await addMember(s.pid, U.m1, { party: s.A.party });
    await seedEffectiveInitiation(s.pid);
    // 一个待确认的内容包（甲部负责人 + 代表人两个任务）
    const item = await mkItem(s.pid);
    const pk = await mkPackage(s.pid, 'overall');
    const pv = await mkVersion(pk);
    await addToSet(pv, item.versions[0].id, await defaultBatchId(s.pid));
    await planAllNodes(s.pid);
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${pv}/submit`)).status, 200);
    const pkgTasks = await sqlAll("SELECT t.id AS tid FROM sysbuild_confirm_tasks t WHERE t.object_type = 'package_version' AND t.object_version_id = ?", [pv]);
    assert.ok(pkgTasks.length >= 2);
    // 两条登记：一条结论待确认，一条已有异议并交裁定（裁定待确认）
    const e1 = await regOk(U.m1, s.pid, { type: 'feedback' });
    await actOk(U.pm, e1.id, CONCLUDE);
    const t1 = await lastTask(e1.id, 'conclusion');
    const e2 = await regOk(U.m1, s.pid, { type: 'issue' });
    await actOk(U.pm, e2.id, CONCLUDE);
    const t2 = await lastTask(e2.id, 'conclusion');
    assert.strictEqual((await openAndDecide(U.del, t2.tid, 'object', { reason: '不同意' })).status, 200);
    await actOk(U.pm, e2.id, { action: 'escalate' });
    const a2 = await lastTask(e2.id, 'adjudication');
    assert.strictEqual((await post(U.admin, `/sysbuild/projects/${s.pid}/status`, { to: 'terminated', reason: 'C5 用例' })).status, 200);
    // 回归：内容包修订照旧失效（原因「项目已终止」）
    const pkgRevs = await sqlAll(
      `SELECT r.status AS status, r.status_reason AS reason FROM sysbuild_confirm_task_revisions r JOIN sysbuild_confirm_tasks t ON t.id = r.task_id
        WHERE t.object_type = 'package_version' AND t.object_version_id = ?`, [pv]
    );
    assert.ok(pkgRevs.length >= 2 && pkgRevs.every((r) => r.status === 'invalid' && r.reason === '项目已终止'), '内容包修订失效');
    // 结论 / 裁定修订仍待确认
    assert.strictEqual((await lastTask(e1.id, 'conclusion')).status, 'pending');
    assert.strictEqual((await lastTask(e2.id, 'adjudication')).status, 'pending');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_events WHERE project_id = ? AND event_type = 'confirm_revision_invalidated' AND payload_json LIKE '%\"entry_id\"%'", [s.pid]), 0, '终止不产生登记修订的失效事件');
    // /my/confirmations：代表人仍列出结论确认、负责人仍列出裁定；内容包任务不列
    const myDel = await get(U.del, '/sysbuild/my/confirmations');
    assert.deepStrictEqual(myDel.body.items.filter((x) => x.project_id === s.pid).map((x) => [x.purpose, x.object_type, x.task_id]), [['conclusion_confirm', 'conclusion', t1.tid]]);
    const myOwn = await get(U.own, '/sysbuild/my/confirmations');
    assert.deepStrictEqual(myOwn.body.items.filter((x) => x.project_id === s.pid).map((x) => [x.purpose, x.object_type, x.task_id]), [['adjudicate', 'adjudication', a2.tid]]);
    // 终止后仍可打开、可决策（resolve 类，四态都允许）
    const o1 = await openIds(U.del, t1.tid);
    assert.strictEqual(o1.actions.decide, true, '终止后 actions.decide 仍为真');
    const d1 = await decideRaw(U.del, t1.tid, decideBodyOf(o1, 'confirm'));
    assert.strictEqual(d1.status, 200, d1.text);
    assert.strictEqual(d1.body.entry.conclusion_state, 'confirmed');
    const oa = await openIds(U.own, a2.tid);
    const da = await decideRaw(U.own, a2.tid, decideBodyOf(oa, 'confirm'));
    assert.strictEqual(da.status, 200, da.text);
    assert.strictEqual(da.body.entry.conclusion_state, 'adjudicated');
    assert.strictEqual((await get(U.del, '/sysbuild/my/confirmations')).body.items.filter((x) => x.project_id === s.pid).length, 0, '决策后不再列出');
    // PM 仍可继续办理（resolve）：终止后的新结论（先写补充登记——终止后只能写补充登记，节点收口为夹具）
    const closedNode = await nodeId(s.pid, 'b_req');
    await closeNode(closedNode, `${shift(today(), -1)} 09:00:00`);
    const e3 = await regOk(U.m1, s.pid, { type: 'issue', node_id: closedNode });
    assert.strictEqual(e3.period, 'supplement');
    const r3 = await actOk(U.pm, e3.id, { action: 'conclude', conclusion_kind: 'project_terminated', text: '项目已终止，关闭本条' });
    assert.strictEqual(r3.entry.current_conclusion.kind, 'project_terminated');
    // P96：「项目已终止」结论不需要确认：直接已确定，不建任务、不冻结附件
    assert.strictEqual(r3.entry.conclusion_state, 'settled_no_confirm');
    assert.strictEqual(r3.task, null);
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE object_type = 'conclusion' AND object_id = ?", [e3.id]), 0, '不建确认任务');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_frozen_attachments WHERE object_type = 'entry' AND object_version_id = ?", [e3.id]), 0, '不冻结附件');
    // 对照：终止后的其他结论类别仍走代表人确认
    const e3b = await regOk(U.m1, s.pid, { type: 'issue', node_id: closedNode });
    const r3b = await actOk(U.pm, e3b.id, { action: 'conclude', conclusion_kind: 'handled', text: '终止后按已处理给结论' });
    assert.strictEqual(r3b.entry.conclusion_state, 'pending_confirm');
    assert.strictEqual((await openAndDecide(U.del, (await lastTask(e3b.id, 'conclusion')).tid, 'confirm')).status, 200, '终止项目里其他结论也可确认');
    // 已结项（夹具）：同样可决策
    const e4 = await regOk(U.m1, s.pid, { type: 'feedback', node_id: closedNode });
    await actOk(U.pm, e4.id, CONCLUDE);
    await sqlRun("UPDATE sysbuild_projects SET status = 'closed' WHERE id = ?", [s.pid]);
    const t4 = await lastTask(e4.id, 'conclusion');
    assert.strictEqual((await get(U.del, '/sysbuild/my/confirmations')).body.items.some((x) => x.task_id === t4.tid), true, '已结项仍列出');
    assert.strictEqual((await openAndDecide(U.del, t4.tid, 'confirm')).status, 200, '已结项可决策');
  });

  // ═══════════════════════ 11b 终止分类表 ═══════════════════════
  test(`${T_CLASS}——confirm-core 的「终止失效 / 终止保留」两张表把 schema 的每个确认用途恰好分到一张（手写全集核对）；加载断言：漏登记、重复登记、多出表外用途的副本加载即抛错；原样加载不抛`, async () => {
    const C = T.getMods().confirmCore;
    // C6a：加交接确认两种用途（handover_accept_issue / handover_no_further）：推进类确认，终止后不可作出，归失效表
    const ALL = ['package_confirm', 'proposer_confirm', 'accept_invitation', 'delegation_grant', 'delegation_accept', 'dev_key_confirm', 'conclusion_confirm', 'adjudicate', 'handover_accept', 'handover_accept_issue', 'handover_no_further'];
    assert.deepStrictEqual([...C.INVALIDATED_ON_TERMINATE_PURPOSES].sort(), ['accept_invitation', 'delegation_accept', 'delegation_grant', 'dev_key_confirm', 'handover_accept', 'handover_accept_issue', 'handover_no_further', 'package_confirm', 'proposer_confirm']);
    assert.deepStrictEqual([...C.RETAINED_ON_TERMINATE_PURPOSES].sort(), ['adjudicate', 'conclusion_confirm']);
    assert.deepStrictEqual([...C.INVALIDATED_ON_TERMINATE_PURPOSES, ...C.RETAINED_ON_TERMINATE_PURPOSES].sort(), [...ALL].sort(), '两张表的并集 = 手写的确认用途全集');
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
    const retained = "const RETAINED_ON_TERMINATE_PURPOSES = Object.freeze(['conclusion_confirm', 'adjudicate']);";
    const invalidated = "'delegation_accept', 'dev_key_confirm', 'handover_accept', 'handover_accept_issue', 'handover_no_further']);";
    assert.strictEqual(src.split(retained).length - 1, 1, '锚点应恰好出现一次');
    assert.strictEqual(src.split(invalidated).length - 1, 1, '锚点应恰好出现一次');
    assert.doesNotThrow(() => load(src), '原样加载不抛');
    assert.throws(() => load(src.replace(retained, "const RETAINED_ON_TERMINATE_PURPOSES = Object.freeze(['conclusion_confirm']);")), (e) => /adjudicate/.test(e.message), '保留表漏 adjudicate');
    assert.throws(() => load(src.replace(invalidated, "'delegation_accept', 'dev_key_confirm', 'handover_accept_issue', 'handover_no_further']);")), (e) => /handover_accept/.test(e.message), '失效表漏 handover_accept');
    assert.throws(() => load(src.replace(invalidated, "'delegation_accept', 'dev_key_confirm', 'handover_accept', 'handover_accept_issue']);")), (e) => /handover_no_further/.test(e.message), '失效表漏 handover_no_further（C6a）');
    assert.throws(() => load(src.replace(retained, "const RETAINED_ON_TERMINATE_PURPOSES = Object.freeze(['conclusion_confirm', 'adjudicate', 'handover_accept']);")), (e) => /重复登记/.test(e.message), '同一用途两张表都登记');
    assert.throws(() => load(src.replace(retained, "const RETAINED_ON_TERMINATE_PURPOSES = Object.freeze(['conclusion_confirm', 'adjudicate', 'bogus_purpose']);")), (e) => /bogus_purpose/.test(e.message), '表里多出 schema 之外的用途');
  });

  // ═══════════════════════ 11c 项目已终止结论的失效与裁定中收尾 ═══════════════════════
  test(`${T_LAPSE}——「项目已终止」结论只在项目当前状态为已终止时算有效结论：重开 / 结项后派生为 terminated_conclusion_lapsed（actions.conclude 真、可作废、可标仅供参考），再给结论走正常确认；再次终止又恢复`, async () => {
    const s = await mkScene();
    const eIssue = await regOk(U.m1, s.pid, { type: 'issue' });
    const eFb = await regOk(U.m1, s.pid, { type: 'feedback' });
    const eVoid = await regOk(U.m1, s.pid, { type: 'issue' });
    const eRe = await regOk(U.m1, s.pid, { type: 'issue' });
    const setStatus = (to) => post(U.admin, `/sysbuild/projects/${s.pid}/status`, { to, reason: 'C5 用例' });
    // 对照：其他结论类别的「已确定（不需确认）」结论（PM 本人登记的登记给 handled）不受项目状态影响
    const ePm = await regOk(U.pm, s.pid, { type: 'issue' });
    assert.strictEqual((await actOk(U.pm, ePm.id, CONCLUDE)).entry.conclusion_state, 'settled_no_confirm');
    assert.strictEqual((await setStatus('terminated')).status, 200);
    const PT ={ action: 'conclude', conclusion_kind: 'project_terminated', text: '项目已终止，关闭本条' };
    for (const e of [eIssue, eFb, eVoid, eRe]) assert.strictEqual((await actOk(U.pm, e.id, PT)).entry.conclusion_state, 'settled_no_confirm');
    // 已终止时是有效结论：不能再给结论
    expectErr(await act(U.pm, eIssue.id, CONCLUDE), 409, 'SYSBUILD_STATE', '终止时项目已终止结论是有效结论');
    // admin 重开项目：该结论失效
    assert.strictEqual((await setStatus('active')).status, 200);
    for (const e of [eIssue, eFb, eVoid, eRe]) {
      const d = await detail(U.pm, e.id);
      assert.deepStrictEqual([d.conclusion_state, d.current_conclusion.kind, d.voided], ['terminated_conclusion_lapsed', 'project_terminated', false], `登记 ${e.id}：重开后结论失效，办理记录里的旧结论保留`);
    }
    assert.strictEqual(await stateOf(ePm.id), 'settled_no_confirm', '重开后 handled 的已确定结论不受影响');
    assert.strictEqual((await detail(U.pm, ePm.id)).actions.conclude, false);
    const di = await detail(U.pm, eIssue.id);
    assert.strictEqual(di.actions.conclude, true, 'lapsed：actions.conclude 为真');
    assert.strictEqual(di.actions.void, true, 'lapsed：可作废（等同无结论）');
    assert.strictEqual(di.actions.escalate, false);
    expectErr(await act(U.pm, eIssue.id, PT), 409, 'SYSBUILD_STATE', '项目未终止时不能再给项目已终止结论');
    // 再给 handled 结论：走正常确认（代表人确认）
    const c = await actOk(U.pm, eIssue.id, CONCLUDE);
    assert.strictEqual(c.entry.conclusion_state, 'pending_confirm');
    assert.strictEqual((await lastTask(eIssue.id, 'conclusion')).user_id, U.del);
    assert.strictEqual((await openAndDecide(U.del, (await lastTask(eIssue.id, 'conclusion')).tid, 'confirm')).status, 200);
    assert.strictEqual(await stateOf(eIssue.id), 'confirmed');
    // lapsed 的意见与反馈可标仅供参考；lapsed 可作废
    assert.strictEqual((await detail(U.pm, eFb.id)).actions.for_reference, true);
    assert.strictEqual((await actOk(U.pm, eFb.id, { action: 'for_reference' })).entry.conclusion_state, 'for_reference');
    assert.strictEqual((await actOk(U.pm, eVoid.id, { action: 'void', reason: '结论已失效，登记作废' })).entry.voided, true);
    // 再次终止：该结论又是有效结论；结项（夹具）同样失效
    assert.strictEqual((await setStatus('terminated')).status, 200);
    assert.strictEqual(await stateOf(eRe.id), 'settled_no_confirm', '再次终止后恢复有效');
    assert.strictEqual((await detail(U.pm, eRe.id)).actions.conclude, false);
    await sqlRun("UPDATE sysbuild_projects SET status = 'closed' WHERE id = ?", [s.pid]);
    assert.strictEqual(await stateOf(eRe.id), 'terminated_conclusion_lapsed', '已结项：项目已终止结论不再有效');
    assert.strictEqual((await detail(U.pm, eRe.id)).actions.conclude, true);
    // 列表里的状态同样按项目当前状态派生
    const list = await get(U.pm, `/sysbuild/projects/${s.pid}/entries`);
    assert.strictEqual(list.body.entries.find((x) => x.id === eRe.id).conclusion_state, 'terminated_conclusion_lapsed');
  });

  test(`${T_ESCTERM}——项目已终止且给「项目已终止」结论时，可从裁定中（escalated）收尾：同一事务把待确认的裁定修订置 superseded（原因「项目已终止，PM 以项目已终止结论关闭」）；其他结论类别从裁定中仍 409；项目未终止时 409`, async () => {
    const s = await mkScene();
    const escalated = async () => {
      const e = await regOk(U.m1, s.pid, { type: 'issue' });
      await actOk(U.pm, e.id, CONCLUDE);
      assert.strictEqual((await openAndDecide(U.del, (await lastTask(e.id, 'conclusion')).tid, 'object', { reason: '不同意' })).status, 200);
      await actOk(U.pm, e.id, { action: 'escalate' });
      assert.strictEqual(await stateOf(e.id), 'escalated');
      return e;
    };
    const e = await escalated();
    const other = await escalated();
    const at = await lastTask(e.id, 'adjudication');
    const PT = { action: 'conclude', conclusion_kind: 'project_terminated', text: '项目已终止，关闭本条' };
    // 项目未终止：裁定中 + 项目已终止结论 → 409（项目状态那条），其他结论类别 409
    expectErr(await act(U.pm, e.id, PT), 409, 'SYSBUILD_STATE', '项目未终止');
    expectErr(await act(U.pm, e.id, CONCLUDE), 409, 'SYSBUILD_STATE', '裁定中不能再给 handled 结论');
    assert.strictEqual((await lastTask(e.id, 'adjudication')).status, 'pending');
    assert.strictEqual((await post(U.admin, `/sysbuild/projects/${s.pid}/status`, { to: 'terminated', reason: 'C5 用例' })).status, 200);
    assert.strictEqual((await lastTask(e.id, 'adjudication')).status, 'pending', '终止不失效裁定');
    // 项目已终止：其他结论类别从裁定中仍 409，标志（不带结论类别）仍为假
    for (const body of [CONCLUDE, { action: 'conclude', conclusion_kind: 'deferred', text: '留待', assignee_text: '第 2 批' }, { action: 'conclude', conclusion_kind: 'to_sys_iteration', text: '转迭代', sys_issue_no: '1001', assignee_text: '外包张三' }]) {
      expectErr(await act(U.pm, e.id, body), 409, 'SYSBUILD_STATE', `裁定中 + ${body.conclusion_kind}`);
    }
    // codex 24 M2 场景①：已终止项目、登记裁定中 → conclude_kinds 只有 project_terminated，actions.conclude 为真（标志与可提交的类别对得上），非 PM 为空
    const dEsc = await detail(U.pm, e.id);
    assert.deepStrictEqual([dEsc.actions.conclude_kinds, dEsc.actions.conclude, dEsc.actions.escalate], [['project_terminated'], true, false]);
    assert.deepStrictEqual((await detail(U.m1, e.id)).actions.conclude_kinds, [], '非 PM 无可用类别');
    assert.strictEqual((await detail(U.m1, e.id)).actions.conclude, false);
    // 项目已终止结论：收尾成功，不建任务，裁定修订 superseded 且原因逐字
    const r = await actOk(U.pm, e.id, PT);
    assert.deepStrictEqual([r.entry.conclusion_state, r.task, r.closed_revision_ids], ['settled_no_confirm', null, [at.rid]]);
    const rev = await sqlGet('SELECT status, status_reason FROM sysbuild_confirm_task_revisions WHERE id = ?', [at.rid]);
    assert.deepStrictEqual([rev.status, rev.status_reason], ['superseded', '项目已终止，PM 以项目已终止结论关闭']);
    const ev = (await eventsOfType(s.pid, 'confirm_revision_superseded')).map((x) => JSON.parse(x.payload_json)).filter((p) => p.revision_id === at.rid);
    assert.deepStrictEqual([ev.length, ev[0].reason, ev[0].entry_id, ev[0].object_type], [1, '项目已终止，PM 以项目已终止结论关闭', e.id, 'adjudication']);
    // 负责人此后不能再裁定（修订已被替代）；别的登记的裁定不受影响
    const stale = await decideRaw(U.own, at.tid, { revision_id: at.rid, object_version_id: at.action_id, decision: 'confirm', checkbox_text: CHECKBOX });
    expectErr(stale, 409, 'SYSBUILD_STATE', '裁定修订已被替代');
    assert.strictEqual(await stateOf(other.id), 'escalated');
    assert.strictEqual((await lastTask(other.id, 'adjudication')).status, 'pending', '别的登记的裁定修订不动');
  });

  // ═══════════════════════ 11d 可用结论类别 ═══════════════════════
  test(`${T_KINDLIST}——登记 actions.conclude_kinds：对全部结论类别逐一用 conclude 同一判定（带 kind 的 target）算出当前可用类别，actions.conclude = 非空；普通进行中项目全等断言；已终止项目裁定中 / 来源方无代表人且有异议两个场景对拍提交结果`, async () => {
    // ③ 普通进行中项目：手写全集（枚举顺序），含 to_change（S-S1c 起开放，按类别可用性列出，change_id 只在端点校验）、不含 project_terminated（项目未终止）
    const OPEN = ['handled', 'adopted', 'not_adopted', 'deferred', 'to_change', 'to_sys_iteration', 'no_further'];
    const s = await mkScene();
    const fb = await regOk(U.m1, s.pid, { type: 'feedback' });
    const dfb = await detail(U.pm, fb.id);
    assert.deepStrictEqual([dfb.actions.conclude_kinds, dfb.actions.conclude], [OPEN, true]);
    assert.deepStrictEqual((await detail(U.m1, fb.id)).actions.conclude_kinds, [], '登记人本人（非 PM）无可用类别');
    assert.deepStrictEqual((await detail(U.ro, fb.id)).actions.conclude_kinds, [], '只读账号无可用类别');
    assert.deepStrictEqual((await detail(U.admin, fb.id)).actions.conclude_kinds, [], 'admin 未接管无可用类别');
    const note = await regOk(U.m1, s.pid, { type: 'note' });
    assert.deepStrictEqual((await detail(U.pm, note.id)).actions.conclude_kinds, [], '办理类以外没有可用类别');
    // 来源方无代表人（乙部）：进行中项目里全部类别被「暂无代表人」或项目状态挡住
    const nd = await regOk(U.x3, s.pid, { type: 'issue' });
    assert.deepStrictEqual([(await detail(U.pm, nd.id)).actions.conclude_kinds, (await detail(U.pm, nd.id)).actions.conclude], [[], false]);
    // 列表里同样带 conclude_kinds，与详情一致
    const lst = (await get(U.pm, `/sysbuild/projects/${s.pid}/entries`)).body.entries;
    assert.deepStrictEqual(lst.find((x) => x.id === fb.id).actions.conclude_kinds, OPEN);
    // 每个类别的标志与执行对拍（进行中项目）：可用的提交成功（各用一条新登记；to_change 要真实变更，另在 changes 套件对拍，这里只核「缺 change_id 400」），project_terminated 提交 409
    for (const kind of OPEN.filter((k) => k !== 'to_change')) {
      const x = await regOk(U.pm, s.pid, { type: 'issue' });
      const body = { action: 'conclude', conclusion_kind: kind, text: `结论 ${kind}`, ...(kind === 'deferred' ? { assignee_text: '第 2 批' } : {}), ...(kind === 'to_sys_iteration' ? { sys_issue_no: '2001', assignee_text: '外包张三' } : {}) };
      assert.ok((await detail(U.pm, x.id)).actions.conclude_kinds.includes(kind), `${kind} 在可用类别里`);
      assert.strictEqual((await act(U.pm, x.id, body)).status, 201, `${kind} 提交成功`);
    }
    const y = await regOk(U.pm, s.pid, { type: 'issue' });
    expectErr(await act(U.pm, y.id, { action: 'conclude', conclusion_kind: 'to_change', text: 'x' }), 400, 'SYSBUILD_INVALID_INPUT', 'to_change 在可用类别里，但缺 change_id 400');
    expectErr(await act(U.pm, y.id, { action: 'conclude', conclusion_kind: 'project_terminated', text: 'x' }), 409, 'SYSBUILD_STATE', 'project_terminated 不在可用类别里也提交不了');

    // ② 已终止项目、来源方无代表人、登记有异议：只有 project_terminated 可用（handled 等被「暂无代表人」挡）
    const pid = await newProject();
    const A = await seedParty(pid, '甲部', U.own, U.del);
    await addMember(pid, U.m1, { party: A.party });
    const e = await regOk(U.m1, pid, { type: 'issue' });
    await actOk(U.pm, e.id, CONCLUDE);
    assert.strictEqual((await openAndDecide(U.del, (await lastTask(e.id, 'conclusion')).tid, 'object', { reason: '不同意' })).status, 200);
    assert.strictEqual(await stateOf(e.id), 'objected');
    await sqlRun("UPDATE sysbuild_delegations SET status = 'revoked', revoked_at = '2026-10-20 10:00:00', revoke_reason = '撤销' WHERE id = ?", [A.dlg]);
    assert.deepStrictEqual((await detail(U.pm, e.id)).actions.conclude_kinds, [], '进行中项目：来源方无代表人，全部类别被挡');
    assert.strictEqual((await post(U.admin, `/sysbuild/projects/${pid}/status`, { to: 'terminated', reason: 'C5 用例' })).status, 200);
    const d2 = await detail(U.pm, e.id);
    assert.deepStrictEqual([d2.actions.conclude_kinds, d2.actions.conclude, d2.confirmer.kind], [['project_terminated'], true, 'unavailable']);
    for (const body of [CONCLUDE, { action: 'conclude', conclusion_kind: 'adopted', text: 'x' }, { action: 'conclude', conclusion_kind: 'no_further', text: 'x' }]) {
      const r = await act(U.pm, e.id, body);
      expectErr(r, 409, 'SYSBUILD_STATE', `${body.conclusion_kind} 被暂无代表人挡`);
      assert.ok(r.body.message.includes('暂无代表人'), r.body.message);
    }
    const ok = await act(U.pm, e.id, { action: 'conclude', conclusion_kind: 'project_terminated', text: '项目已终止，来源方无代表人也直接关闭' });
    assert.strictEqual(ok.status, 201, ok.text);
    assert.strictEqual(ok.body.entry.conclusion_state, 'settled_no_confirm');
  });

  // ═══════════════════════ 12 代录 ═══════════════════════
  test(`${T_PROXY}——无账号代表人的结论确认只能代录：平台决策 403、PM 代录 200（确认 / 有异议；reject 400）；代录需本人暂存凭据与外部日期；裁定不可代录；代录不计浏览；PM 不是必需确认人才可代录`, async () => {
    const pid = await newProject();
    const A = await seedParty(pid, '甲部', U.own, null);
    const mM = await addMember(pid, U.m1, { party: A.party });
    assert.ok(mM > 0);
    const na = await sqlRun("INSERT INTO sysbuild_members (project_id, party_id, user_id, person_name, joined_at, added_by) VALUES (?, ?, NULL, '无账号代表', '2026-10-01 10:00:00', ?)", [pid, A.party, U.admin]);
    const dlg = await addDelegation(A.party, na.lastID, A.apt, 'active');
    const e = await regOk(U.m1, pid, { type: 'feedback' });
    // codex 24 M1：确认人是无账号代表人（只能代录）时，仅供参考的知会没人看得到、也就没人能提异议：for_reference 409 且标志同步为假；普通 conclude 不受影响（结论确认任务可代录）
    const dNa = await detail(U.pm, e.id);
    assert.deepStrictEqual([dNa.confirmer.kind, dNa.confirmer.proxy_only, dNa.actions.for_reference, dNa.actions.conclude], ['delegate', true, false, true]);
    const fr = await act(U.pm, e.id, { action: 'for_reference' });
    expectErr(fr, 409, 'SYSBUILD_STATE', '确认人无账号：不能标仅供参考');
    assert.ok(fr.body.message.includes('没有平台账号') && fr.body.message.includes('代录'), fr.body.message);
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_notices WHERE ref_type = 'entry' AND ref_id = ?", [e.id]), 0, '没有写知会');
    assert.strictEqual((await actionsRows(e.id)).length, 0, '被拒不写办理记录');
    const c = await actOk(U.pm, e.id, CONCLUDE);
    const t = await lastTask(e.id, 'conclusion');
    assert.deepStrictEqual([t.user_id, t.member_id, t.basis_delegation_id], [null, na.lastID, dlg]);
    assert.strictEqual(c.task.proxy_only, true);
    const body = (uid) => ({ revision_id: t.rid, object_version_id: t.action_id, decision: 'confirm', checkbox_text: CHECKBOX, uid });
    // 平台决策：任何人都不是必需确认人 → 403
    expectErr(await decideRaw(U.pm, t.tid, body()), 403, 'SYSBUILD_FORBIDDEN', 'PM 平台决策');
    expectErr(await decideRaw(U.m1, t.tid, body()), 403, 'SYSBUILD_FORBIDDEN', '成员平台决策');
    const view = await openIds(U.pm, t.tid);
    assert.deepStrictEqual([view.revision.proxy_only, view.actions.decide, view.actions.proxy, view.actions.reissue], [true, false, true, true]);
    await backdateRev(t.rid);
    const proxyBody = async (decision, extra) => Object.assign({ revision_id: t.rid, object_version_id: t.action_id, decision }, await proxyEvid(pid), extra || {});
    // 非 PM 403；reject 对结论确认 400；缺凭据 400；外部日期晚于今天 400
    expectErr(await post(U.own, `/sysbuild/confirm-tasks/${t.tid}/proxy`, await proxyBody('confirm')), 403, 'SYSBUILD_FORBIDDEN', '非 PM 代录');
    const rj = await post(U.pm, `/sysbuild/confirm-tasks/${t.tid}/proxy`, await proxyBody('reject', { reason: '不认可' }));
    expectErr(rj, 400, 'SYSBUILD_INVALID_INPUT', '结论确认不认 reject');
    assert.strictEqual(rj.body.field, 'decision');
    expectErr(await post(U.pm, `/sysbuild/confirm-tasks/${t.tid}/proxy`, await proxyBody('confirm', { attachment_ids: [] })), 400, 'SYSBUILD_INVALID_INPUT', '缺凭据附件');
    expectErr(await post(U.pm, `/sysbuild/confirm-tasks/${t.tid}/proxy`, await proxyBody('confirm', { external_date: shift(today(), 1) })), 400, 'SYSBUILD_INVALID_INPUT', '外部日期晚于今天');
    assert.strictEqual((await lastTask(e.id, 'conclusion')).status, 'pending', '被拒的代录不改状态');
    // 有异议代录 → 有异议；PM 再给结论 → 新任务；确认代录 → 已确认
    const ob = await post(U.pm, `/sysbuild/confirm-tasks/${t.tid}/proxy`, await proxyBody('object', { reason: '电话里对方有异议' }));
    assert.strictEqual(ob.status, 200, ob.text);
    assert.deepStrictEqual([ob.body.method, ob.body.entry.conclusion_state], ['proxy', 'objected']);
    const cf = await sqlGet('SELECT method, decision, actor_user_id, proxy_by, object_type, object_version_id, view_id, checkbox_text FROM sysbuild_confirmations WHERE task_revision_id = ?', [t.rid]);
    assert.deepStrictEqual([cf.method, cf.decision, cf.actor_user_id, cf.proxy_by, cf.object_type, cf.object_version_id, cf.view_id, cf.checkbox_text], ['proxy', 'object', null, U.pm, 'conclusion', t.action_id, null, null]);
    const bound = await sqlAll("SELECT b.owner_type AS owner_type, b.owner_id AS owner_id FROM sysbuild_attachment_bindings b WHERE b.owner_type = 'confirmation'");
    assert.ok(bound.some((b) => b.owner_id > 0), '凭据以 confirmation 绑定');
    await actOk(U.pm, e.id, { action: 'conclude', conclusion_kind: 'adopted', text: '调整后重新给出结论' });
    const t2 = await lastTask(e.id, 'conclusion');
    await backdateRev(t2.rid);
    const ok = await post(U.pm, `/sysbuild/confirm-tasks/${t2.tid}/proxy`, Object.assign({ revision_id: t2.rid, object_version_id: t2.action_id, decision: 'confirm' }, await proxyEvid(pid, { attachment_ids: [await stageAtt(pid, U.pm, 'e')] })));
    assert.strictEqual(ok.status, 200, ok.text);
    assert.strictEqual(ok.body.entry.conclusion_state, 'confirmed');
    // 裁定不可代录（409）：另一条登记走到裁定中（负责人有账号）
    const e2 = await regOk(U.m1, pid, { type: 'issue' });
    await actOk(U.pm, e2.id, CONCLUDE);
    const u2 = await lastTask(e2.id, 'conclusion');
    await backdateRev(u2.rid);
    assert.strictEqual((await post(U.pm, `/sysbuild/confirm-tasks/${u2.tid}/proxy`, Object.assign({ revision_id: u2.rid, object_version_id: u2.action_id, decision: 'object', reason: '有异议' }, await proxyEvid(pid, { attachment_ids: [await stageAtt(pid, U.pm, 'f')] })))).status, 200);
    await actOk(U.pm, e2.id, { action: 'escalate' });
    const at = await lastTask(e2.id, 'adjudication');
    await backdateRev(at.rid);
    const adj = await post(U.pm, `/sysbuild/confirm-tasks/${at.tid}/proxy`, Object.assign({ revision_id: at.rid, object_version_id: at.action_id, decision: 'confirm' }, await proxyEvid(pid, { attachment_ids: [await stageAtt(pid, U.pm, '1')] })));
    expectErr(adj, 409, 'SYSBUILD_STATE', '裁定不可代录');
    assert.strictEqual((await openIds(U.pm, at.tid)).actions.proxy, false, '裁定的 actions.proxy 为假');
    assert.strictEqual((await lastTask(e2.id, 'adjudication')).status, 'pending');
    // 终止项目后仍可代录结论确认（resolve 类，四态都允许）：先造一条待确认的结论再终止
    const e3 = await regOk(U.m1, pid, { type: 'issue' });
    await actOk(U.pm, e3.id, CONCLUDE);
    const u3 = await lastTask(e3.id, 'conclusion');
    await backdateRev(u3.rid);
    assert.strictEqual((await post(U.admin, `/sysbuild/projects/${pid}/status`, { to: 'terminated', reason: 'C5 用例' })).status, 200);
    assert.strictEqual((await lastTask(e3.id, 'conclusion')).status, 'pending', '终止不失效结论确认');
    assert.strictEqual((await openIds(U.pm, u3.tid)).actions.proxy, true, '终止后 actions.proxy 仍为真');
    const tp = await post(U.pm, `/sysbuild/confirm-tasks/${u3.tid}/proxy`, Object.assign({ revision_id: u3.rid, object_version_id: u3.action_id, decision: 'confirm' }, await proxyEvid(pid, { attachment_ids: [await stageAtt(pid, U.pm, '2')] })));
    assert.strictEqual(tp.status, 200, tp.text);
    assert.strictEqual(tp.body.entry.conclusion_state, 'confirmed');
  });

  // ═══════════════════════ 13 改发 ═══════════════════════
  test(`${T_REISSUE}——代表人更换后改发结论确认（新修订、旧修订 superseded、新人须自己浏览）；有异议 / 已处理的修订不改发 409；非 PM 403；没有代表人 / 不再需要确认 → 409；裁定任务随负责人更换改发`, async () => {
    const s = await mkScene();
    const e = await regOk(U.m1, s.pid, { type: 'feedback' });
    await actOk(U.pm, e.id, CONCLUDE);
    const t = await lastTask(e.id, 'conclusion');
    const reissue = (uid, tid, reason) => post(uid, `/sysbuild/confirm-tasks/${tid}/reissue`, reason === undefined ? {} : { reason });
    expectErr(await reissue(U.m1, t.tid, '换人'), 403, 'SYSBUILD_FORBIDDEN', '非 PM');
    expectErr(await reissue(U.pm, t.tid), 400, 'SYSBUILD_INVALID_INPUT', '缺原因');
    // 旧代表人授权撤销，换成 m2 当代表人
    await sqlRun("UPDATE sysbuild_delegations SET status = 'revoked', revoked_at = '2026-10-20 10:00:00', revoke_reason = '更换' WHERE id = ?", [s.A.dlg]);
    const dlgNew = await addDelegation(s.A.party, s.mM2, s.A.apt, 'active');
    const old = await openIds(U.pm, t.tid);
    assert.strictEqual(old.actions.reissue, true, '标志为真');
    // 旧人失去资格：决策 409
    const lost = await openAndDecide(U.del, t.tid, 'confirm');
    expectErr(lost, 409, 'SYSBUILD_STATE', '旧代表人已失去资格');
    const r = await reissue(U.pm, t.tid, '代表人更换');
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.body.revision.rev_no, r.body.revision.status, r.body.revision.required_member_id], [2, 'pending', s.mM2]);
    const revs = await sqlAll('SELECT rev_no, status, status_reason, required_member_id, basis_delegation_id FROM sysbuild_confirm_task_revisions WHERE task_id = ? ORDER BY rev_no', [t.tid]);
    assert.deepStrictEqual(revs.map((x) => [x.rev_no, x.status, x.status_reason, x.required_member_id, x.basis_delegation_id]), [[1, 'superseded', '代表人更换', s.A.mDel, s.A.dlg], [2, 'pending', null, s.mM2, dlgNew]]);
    // 新人须自己浏览；旧人 403；新人确认 → 已确认
    const newRid = (await lastTask(e.id, 'conclusion')).rid;
    const noView = await decideRaw(U.m2, t.tid, { revision_id: newRid, object_version_id: t.action_id, decision: 'confirm', checkbox_text: CHECKBOX });
    expectErr(noView, 409, 'SYSBUILD_NOT_VIEWED', '新人未浏览');
    expectErr(await decideRaw(U.del, t.tid, { revision_id: newRid, object_version_id: t.action_id, decision: 'confirm', checkbox_text: CHECKBOX }), 403, 'SYSBUILD_FORBIDDEN', '旧人不再是必需确认人');
    assert.strictEqual((await openAndDecide(U.m2, t.tid, 'confirm')).status, 200);
    assert.strictEqual(await stateOf(e.id), 'confirmed');
    // 已处理的修订不能改发
    expectErr(await reissue(U.pm, t.tid, '再改发'), 409, 'SYSBUILD_STATE', '已确认的修订');
    assert.strictEqual((await openIds(U.pm, t.tid)).actions.reissue, false);
    // 有异议的修订不改发
    const e3 = await regOk(U.m1, s.pid, { type: 'issue' });
    await actOk(U.pm, e3.id, CONCLUDE);
    const t3 = await lastTask(e3.id, 'conclusion');
    assert.strictEqual((await openAndDecide(U.m2, t3.tid, 'object', { reason: '不同意' })).status, 200);
    const ob = await reissue(U.pm, t3.tid, '想改发');
    expectErr(ob, 409, 'SYSBUILD_STATE', '有异议的修订不改发');
    assert.ok(ob.body.message.includes('改结论') || ob.body.message.includes('裁定'), ob.body.message);
    // 没有代表人 → 409（blocked 文案）；不需要确认人了 → 409
    const e4 = await regOk(U.m1, s.pid, { type: 'issue' });
    await actOk(U.pm, e4.id, CONCLUDE);
    const t4 = await lastTask(e4.id, 'conclusion');
    await sqlRun("UPDATE sysbuild_delegations SET status = 'revoked', revoked_at = '2026-10-21 10:00:00', revoke_reason = '撤销' WHERE id = ?", [dlgNew]);
    const nod = await reissue(U.pm, t4.tid, '想改发');
    expectErr(nod, 409, 'SYSBUILD_STATE', '没有代表人');
    assert.ok(nod.body.message.includes('代表人'), nod.body.message);
    assert.strictEqual((await openIds(U.pm, t4.tid)).actions.reissue, false, '标志同步为假');
    // 裁定任务随负责人更换改发
    await addDelegation(s.A.party, s.A.mDel, s.A.apt, 'active');
    const e5 = await regOk(U.m1, s.pid, { type: 'feedback' });
    await actOk(U.pm, e5.id, CONCLUDE);
    const t5 = await lastTask(e5.id, 'conclusion');
    assert.strictEqual((await openAndDecide(U.del, t5.tid, 'object', { reason: '不同意' })).status, 200);
    await actOk(U.pm, e5.id, { action: 'escalate' });
    const a5 = await lastTask(e5.id, 'adjudication');
    assert.strictEqual(a5.user_id, U.own);
    await sqlRun("UPDATE sysbuild_appointments SET status = 'ended', ended_at = '2026-10-22 10:00:00', end_reason = '换人' WHERE id = ?", [s.A.apt]);
    const newApt = await addAppointment(s.A.party, s.mM1, 'active');
    const ra = await reissue(U.pm, a5.tid, '负责人更换');
    assert.strictEqual(ra.status, 200, ra.text);
    const a5b = await lastTask(e5.id, 'adjudication');
    assert.deepStrictEqual([a5b.user_id, a5b.basis_appointment_id, a5b.rev_no, a5b.status], [U.m1, newApt, 2, 'pending']);
    assert.strictEqual((await openAndDecide(U.m1, a5.tid, 'confirm')).status, 200);
    assert.strictEqual(await stateOf(e5.id), 'adjudicated');
    // 终止项目后仍可改发（resolve 类）：代表人更换后 PM 改发待确认的结论确认
    const tp = { pid: await newProject() };
    tp.A = await seedParty(tp.pid, '甲部', U.own, U.del);
    tp.mM1 = await addMember(tp.pid, U.m1, { party: tp.A.party });
    tp.mM2 = await addMember(tp.pid, U.m2, { party: tp.A.party });
    const e6 = await regOk(U.m1, tp.pid, { type: 'feedback' });
    await actOk(U.pm, e6.id, CONCLUDE);
    const t6 = await lastTask(e6.id, 'conclusion');
    assert.strictEqual((await post(U.admin, `/sysbuild/projects/${tp.pid}/status`, { to: 'terminated', reason: 'C5 用例' })).status, 200);
    await sqlRun("UPDATE sysbuild_delegations SET status = 'revoked', revoked_at = '2026-10-20 10:00:00', revoke_reason = '更换' WHERE id = ?", [tp.A.dlg]);
    const dlg6 = await addDelegation(tp.A.party, tp.mM2, tp.A.apt, 'active');
    assert.strictEqual((await openIds(U.pm, t6.tid)).actions.reissue, true, '终止后 actions.reissue 为真');
    const r6 = await reissue(U.pm, t6.tid, '代表人更换');
    assert.strictEqual(r6.status, 200, r6.text);
    const t6b = await lastTask(e6.id, 'conclusion');
    assert.deepStrictEqual([t6b.rev_no, t6b.user_id, t6b.basis_delegation_id], [2, U.m2, dlg6]);
  });

  // ═══════════════════════ 14 actions 同源 ═══════════════════════
  test(`${T_FLAGS}——逐对象 actions：五种登记状态 × 九个动作 × PM / 登记人 / 其他成员 / 只读账号，标志手写；标志为真执行 201，为假执行 403 / 409（同一判定）`, async () => {
    const s = await mkScene();
    const BODY = {
      correct: { action: 'correct', text: '更正内容' }, void: { action: 'void', reason: '作废原因' }, conclude: CONCLUDE, for_reference: { action: 'for_reference' },
      mark_commitment: { action: 'mark_commitment', reason: '补标' }, unmark_commitment: { action: 'unmark_commitment', reason: '取消' },
      mark_risk: { action: 'mark_risk', reason: '补标' }, unmark_risk: { action: 'unmark_risk', reason: '取消' }, escalate: { action: 'escalate' },
    };
    const flagsOf = (list) => { const o = {}; for (const a of ACTION_NAMES) o[a] = list.includes(a); return o; };
    const factories = {
      none: async () => regOk(U.m1, s.pid, { type: 'feedback' }),
      confirmed: async () => {
        const e = await regOk(U.m1, s.pid, { type: 'feedback' });
        await actOk(U.pm, e.id, CONCLUDE);
        assert.strictEqual((await openAndDecide(U.del, (await lastTask(e.id, 'conclusion')).tid, 'confirm')).status, 200);
        return e;
      },
      riskIssue: async () => regOk(U.m1, s.pid, { type: 'issue', is_risk: 1 }),
      voided: async () => {
        const e = await regOk(U.m1, s.pid, { type: 'feedback' });
        await actOk(U.pm, e.id, { action: 'void', reason: '作废' });
        return e;
      },
      objected: async () => {
        const e = await regOk(U.m1, s.pid, { type: 'feedback' });
        await actOk(U.pm, e.id, CONCLUDE);
        assert.strictEqual((await openAndDecide(U.del, (await lastTask(e.id, 'conclusion')).tid, 'object', { reason: '不同意' })).status, 200);
        return e;
      },
    };
    // 手写期望（PM）：state → 为真的动作
    const PM_TRUE = {
      none: ['correct', 'void', 'conclude', 'for_reference', 'mark_commitment'],
      confirmed: ['correct', 'mark_commitment'],
      riskIssue: ['correct', 'void', 'conclude', 'mark_commitment', 'unmark_risk'],
      voided: [],
      objected: ['correct', 'conclude', 'for_reference', 'mark_commitment', 'escalate'], // P94：有异议时 PM 不能作废（只有登记人本人可作废，见 OWNER_TRUE）
    };
    // 登记人 m1：只有更正 / 作废可能为真；其他成员 m2：全假；只读账号 ro：全假
    const OWNER_TRUE = { none: ['correct', 'void'], confirmed: ['correct'], riskIssue: ['correct', 'void'], voided: [], objected: ['correct', 'void'] };
    for (const [state, make] of Object.entries(factories)) {
      for (const [role, uid, table] of [['PM', U.pm, PM_TRUE], ['登记人', U.m1, OWNER_TRUE], ['其他成员', U.m2, null], ['只读账号', U.ro, null], ['admin 未接管', U.admin, null]]) {
        const want = flagsOf(table ? table[state] : []);
        want.revise = false; // 本矩阵均为一般登记，不存在开发方未认可的修订重提事实。
        // 其他视角（其他成员 / 只读账号 / admin 未接管）标志全假：各状态只需要核一遍标志与一个动作，不必九个动作都重复建登记
        for (const name of (table ? ACTION_NAMES : ['conclude'])) {
          const e = await make();
          const d = await detail(uid, e.id);
          const { conclude_kinds: ck, split: _s, assign_items: _a, link_sys_issue: _l, link_change: _lc, object: _o, ...flagsOnly } = d.actions; // S-S1b 的四个新标志（split / assign_items / link_sys_issue / object）在 sysbuild-api-suite-routing.js 手写核对；S-S1c 的 link_change 在 sysbuild-api-suite-changes.js
          assert.deepStrictEqual(flagsOnly, want, `${state} × ${role}：actions 手写期望`);
          assert.ok(Array.isArray(ck) && (ck.length > 0) === want.conclude, `${state} × ${role}：conclude_kinds 非空 ⇔ conclude`);
          const r = await act(uid, e.id, BODY[name]);
          if (want[name]) assert.strictEqual(r.status, 201, `${state} × ${role} × ${name}：标志为真应成功 ${r.text}`);
          else assert.ok(r.status === 403 || r.status === 409, `${state} × ${role} × ${name}：标志为假应 403 / 409，实际 ${r.status} ${r.text}`);
          // 没有权限的视角（非 PM 动作的其他成员 / 只读账号 / admin 未接管；登记人对 PM 专属动作）一律 403，权限先于对象状态
          if (!want[name] && (role !== '登记人' || !['correct', 'void'].includes(name)) && role !== 'PM') assert.strictEqual(r.status, 403, `${state} × ${role} × ${name}：没有权限一律 403（权限先于状态）`);
        }
      }
    }
    // 项目状态：已终止项目里 resolve 类动作的标志仍按对象状态给出（四态都允许）
    const e = await factories.none();
    assert.strictEqual((await post(U.admin, `/sysbuild/projects/${s.pid}/status`, { to: 'terminated', reason: 'C5 用例' })).status, 200);
    const { conclude_kinds: ckT, split: _s2, assign_items: _a2, link_sys_issue: _l2, link_change: _lc2, object: _o2, ...flagsT } = (await detail(U.pm, e.id)).actions;
    assert.deepStrictEqual(flagsT, Object.assign(flagsOf(PM_TRUE.none), { revise: false }), '已终止项目：标志不变');
    assert.deepStrictEqual(ckT, ['handled', 'adopted', 'not_adopted', 'deferred', 'to_change', 'to_sys_iteration', 'no_further', 'project_terminated'], '已终止项目：多出 project_terminated');
    assert.strictEqual((await act(U.pm, e.id, BODY.conclude)).status, 201, '已终止项目：PM 仍可办理');
  });

  // ═══════════════════════ 15 更正与作废 ═══════════════════════
  test(`${T_VOID}——更正 / 作废：登记人本人与 PM 可、他人 403；更正只追加不改原文；作废需原因；有有效结论后作废 409；作废后一切办理 409，待确认的结论修订随之失效，列表仍显示`, async () => {
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
    assert.strictEqual(c2.entry.conclusion_state, 'none', '更正不改结论状态');
    // 有有效结论后不能作废（更正仍可）
    const e2 = await regOk(U.pm, s.pid, { type: 'feedback' });
    await actOk(U.pm, e2.id, CONCLUDE);
    expectErr(await act(U.pm, e2.id, { action: 'void', reason: '想作废' }), 409, 'SYSBUILD_STATE', '已确定的结论后作废');
    await actOk(U.pm, e2.id, { action: 'correct', text: '文字更正' });
    // 待确认的结论：作废允许，修订随之失效（原因「登记已作废」），任务不能再决策
    const e3 = await regOk(U.m1, s.pid, { type: 'feedback' });
    await actOk(U.pm, e3.id, CONCLUDE);
    const t3 = await lastTask(e3.id, 'conclusion');
    const v = await actOk(U.m1, e3.id, { action: 'void', reason: '提错了' });
    assert.deepStrictEqual([v.entry.voided, v.entry.conclusion_state, v.closed_revision_ids], [true, 'voided', [t3.rid]]);
    const rv = await sqlGet('SELECT status, status_reason FROM sysbuild_confirm_task_revisions WHERE id = ?', [t3.rid]);
    assert.deepStrictEqual([rv.status, rv.status_reason], ['invalid', '登记已作废']);
    expectErr(await decideRaw(U.del, t3.tid, { revision_id: t3.rid, object_version_id: t3.action_id, decision: 'confirm', checkbox_text: CHECKBOX }), 409, 'SYSBUILD_STATE', '作废后决策');
    // 作废后：一切办理 409；列表默认仍显示并标已作废
    for (const name of ['correct', 'void', 'conclude', 'for_reference', 'mark_commitment', 'mark_risk', 'escalate']) {
      const body = { correct: { action: 'correct', text: 'x' }, void: { action: 'void', reason: 'x' }, conclude: CONCLUDE, for_reference: { action: 'for_reference' }, mark_commitment: { action: 'mark_commitment', reason: 'x' }, mark_risk: { action: 'mark_risk', reason: 'x' }, escalate: { action: 'escalate' } }[name];
      const r = await act(U.pm, e3.id, body);
      expectErr(r, 409, 'SYSBUILD_STATE', `作废后 ${name}`);
      assert.ok(r.body.message.includes('已作废'), r.body.message);
    }
    const list = await get(U.pm, `/sysbuild/projects/${s.pid}/entries`);
    const row = list.body.entries.find((x) => x.id === e3.id);
    assert.deepStrictEqual([row.voided, row.conclusion_state], [true, 'voided'], '列表仍显示并标已作废');
    // 作废事件
    assert.strictEqual((await eventsOfType(s.pid, 'confirm_revision_invalidated')).filter((x) => JSON.parse(x.payload_json).entry_id === e3.id).length, 1);
    // 作废的补充登记同样：PM 也可作废他人的
    const e4 = await regOk(U.m1, s.pid, { type: 'note' });
    assert.strictEqual((await actOk(U.pm, e4.id, { action: 'void', reason: 'PM 作废' })).entry.voided, true);
    // 作废只关本登记自己的待确认修订，同项目别的登记的不动（L3：closePendingEntryRevisions 按登记编号限定）
    const va = await regOk(U.m1, s.pid, { type: 'feedback' });
    const vb = await regOk(U.m2, s.pid, { type: 'feedback' });
    await actOk(U.pm, va.id, CONCLUDE);
    await actOk(U.pm, vb.id, CONCLUDE);
    const ta = await lastTask(va.id, 'conclusion');
    const vv = await actOk(U.pm, va.id, { action: 'void', reason: '作废 va' });
    assert.deepStrictEqual(vv.closed_revision_ids, [ta.rid]);
    assert.strictEqual((await lastTask(vb.id, 'conclusion')).status, 'pending', '别的登记的待确认修订不被关');
    assert.strictEqual(await stateOf(vb.id), 'pending_confirm');

    // P94：有未结异议时（有异议 / 裁定中 / 裁定未通过 / 仅供参考被异议），PM 不能作废，只有登记人本人可作废（防止 PM 用作废绕开提出方的异议与负责人裁定）
    const objectedEntry = async (type) => {
      const x = await regOk(U.m1, s.pid, { type: type || 'issue' });
      await actOk(U.pm, x.id, CONCLUDE);
      assert.strictEqual((await openAndDecide(U.del, (await lastTask(x.id, 'conclusion')).tid, 'object', { reason: '不同意' })).status, 200);
      return x;
    };
    const pmVoid = (id) => act(U.pm, id, { action: 'void', reason: 'PM 想作废' });
    // 有异议
    const o1 = await objectedEntry();
    const v1 = await pmVoid(o1.id);
    expectErr(v1, 409, 'SYSBUILD_STATE', '有异议时 PM 不能作废');
    assert.strictEqual(v1.body.message, '有未结异议，不能由 PM 作废');
    assert.deepStrictEqual([(await detail(U.pm, o1.id)).actions.void, (await detail(U.m1, o1.id)).actions.void], [false, true], 'PM 视角标志为假、登记人视角为真');
    assert.strictEqual(await stateOf(o1.id), 'objected', '被拒后状态不变');
    assert.strictEqual((await actOk(U.m1, o1.id, { action: 'void', reason: '登记人自己作废' })).entry.voided, true, '登记人本人可作废');
    // 裁定中：登记人作废时裁定任务的待确认修订一并失效
    const o2 = await objectedEntry();
    await actOk(U.pm, o2.id, { action: 'escalate' });
    expectErr(await pmVoid(o2.id), 409, 'SYSBUILD_STATE', '裁定中 PM 不能作废');
    const at2 = await lastTask(o2.id, 'adjudication');
    const w2 = await actOk(U.m1, o2.id, { action: 'void', reason: '登记人作废' });
    assert.deepStrictEqual(w2.closed_revision_ids, [at2.rid]);
    assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_confirm_task_revisions WHERE id = ?', [at2.rid])).status, 'invalid');
    // 裁定未通过
    const o3 = await objectedEntry();
    await actOk(U.pm, o3.id, { action: 'escalate' });
    assert.strictEqual((await openAndDecide(U.own, (await lastTask(o3.id, 'adjudication')).tid, 'reject')).status, 200);
    assert.strictEqual(await stateOf(o3.id), 'adjudication_rejected');
    expectErr(await pmVoid(o3.id), 409, 'SYSBUILD_STATE', '裁定未通过 PM 不能作废');
    assert.strictEqual((await actOk(U.m1, o3.id, { action: 'void', reason: '登记人作废' })).entry.voided, true);
    // 仅供参考被异议
    const o4 = await regOk(U.m1, s.pid, { type: 'feedback' });
    await actOk(U.pm, o4.id, { action: 'for_reference' });
    const n4 = await sqlGet("SELECT id FROM sysbuild_notices WHERE ref_type = 'entry' AND ref_id = ?", [o4.id]);
    assert.strictEqual((await post(U.del, `/sysbuild/notices/${n4.id}/object`, { reason: '请办理' })).status, 201);
    expectErr(await pmVoid(o4.id), 409, 'SYSBUILD_STATE', '仅供参考被异议 PM 不能作废');
    assert.strictEqual((await actOk(U.m1, o4.id, { action: 'void', reason: '登记人作废' })).entry.voided, true);
    // 没有未结异议时 PM 仍可作废他人的登记：无结论 / 待确认（上面 va）
    // M-a：PM 代登的登记（登记时身份是 PM）有未结异议时，任何人都不能作废（登记人本人也是 PM，不享豁免），只能给结论 / 交裁定收尾
    const pmOwn = await regOk(U.pm, s.pid, { type: 'issue', source_party_id: s.A.party });
    assert.strictEqual(pmOwn.operator_identity.is_pm, true);
    await actOk(U.pm, pmOwn.id, CONCLUDE);
    assert.strictEqual((await openAndDecide(U.del, (await lastTask(pmOwn.id, 'conclusion')).tid, 'object', { reason: '不同意' })).status, 200);
    const pv = await pmVoid(pmOwn.id);
    expectErr(pv, 409, 'SYSBUILD_STATE', 'PM 代登的有异议登记：PM 不能作废');
    assert.strictEqual(pv.body.message, '有未结异议，不能由 PM 作废');
    assert.strictEqual((await detail(U.pm, pmOwn.id)).actions.void, false, 'PM 代登的有异议登记 actions.void 为假');
    expectErr(await act(U.m1, pmOwn.id, { action: 'void', reason: '一般成员' }), 403, 'SYSBUILD_FORBIDDEN', '其他成员更不能作废');
    assert.strictEqual(await stateOf(pmOwn.id), 'objected');
    // 收尾出路：PM 仍可给结论
    assert.strictEqual((await actOk(U.pm, pmOwn.id, { action: 'conclude', conclusion_kind: 'not_adopted', text: '改结论收尾' })).entry.conclusion_state, 'pending_confirm');
    // 对照：登记人本人且登记时不是 PM 的登记（上面 o1–o4）仍可作废；PM 是登记人本人但没有未结异议（无结论）时可作废
    const pmNone = await regOk(U.pm, s.pid, { type: 'issue', source_party_id: s.A.party });
    assert.strictEqual((await actOk(U.pm, pmNone.id, { action: 'void', reason: '没有未结异议，PM 可作废' })).entry.voided, true);
  });

  // ═══════════════════════ 16 结论类别 ═══════════════════════
  test(`${T_KINDS}——to_sys_iteration 必填单号（≤32 位，只存文本）与承接人；deferred 必填承接说明；to_change 必带 change_id（缺 400、不存在 409）；project_terminated 仅已终止；字段只用于对应类别；未开放的动作 409，未知动作 400`, async () => {
    const s = await mkScene();
    const mk = async () => regOk(U.pm, s.pid, { type: 'issue' });
    const bad = async (extra, field, label) => {
      const e = await mk();
      const r = await act(U.pm, e.id, Object.assign({ action: 'conclude' }, extra));
      expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', label);
      assert.strictEqual(r.body.field, field, `${label} 的 field`);
      assert.strictEqual((await actionsRows(e.id)).length, 0, `${label}：不写办理记录`);
    };
    await bad({ text: '转迭代', conclusion_kind: 'to_sys_iteration', assignee_text: '外包张三' }, 'sys_issue_no', '转系统迭代缺单号');
    await bad({ text: '转迭代', conclusion_kind: 'to_sys_iteration', sys_issue_no: '1234' }, 'assignee_text', '转系统迭代缺承接人');
    await bad({ text: '转迭代', conclusion_kind: 'to_sys_iteration', sys_issue_no: 'N'.repeat(33), assignee_text: '外包张三' }, 'sys_issue_no', '单号 33 位');
    await bad({ text: '留待', conclusion_kind: 'deferred' }, 'assignee_text', '留待后续缺承接说明');
    await bad({ text: '已处理', conclusion_kind: 'handled', assignee_text: '多余' }, 'assignee_text', '承接说明只用于 deferred / to_sys_iteration');
    await bad({ text: '已处理', conclusion_kind: 'handled', sys_issue_no: '1234' }, 'sys_issue_no', '单号只用于转系统迭代');
    await bad({ conclusion_kind: 'handled' }, 'text', '缺结论说明');
    await bad({ text: '已处理' }, 'conclusion_kind', '缺类别');
    await bad({ text: '已处理', conclusion_kind: 'bogus' }, 'conclusion_kind', '类别越界');
    await bad({ text: '已处理', conclusion_kind: 'handled', bogus: 1 }, 'bogus', '多余键');
    // 成功：转系统迭代存文本（不校验单据存在），32 位边界
    const e1 = await mk();
    const r1 = await actOk(U.pm, e1.id, { action: 'conclude', conclusion_kind: 'to_sys_iteration', text: '转系统迭代受理', sys_issue_no: 'N'.repeat(32), assignee_text: '外包张三' });
    assert.deepStrictEqual([r1.entry.current_conclusion.kind, r1.entry.current_conclusion.sys_issue_no, r1.entry.current_conclusion.assignee_text, r1.entry.conclusion_state], ['to_sys_iteration', 'N'.repeat(32), '外包张三', 'settled_no_confirm']);
    const row = await sqlGet('SELECT conclusion_kind, sys_issue_no, assignee_text, text FROM sysbuild_entry_actions WHERE id = ?', [r1.action_id]);
    assert.deepStrictEqual([row.conclusion_kind, row.sys_issue_no, row.assignee_text, row.text], ['to_sys_iteration', 'N'.repeat(32), '外包张三', '转系统迭代受理']);
    const e2 = await mk();
    const r2 = await actOk(U.pm, e2.id, { action: 'conclude', conclusion_kind: 'deferred', text: '留待后续', assignee_text: '第 2 批需求确认' });
    assert.strictEqual(r2.entry.current_conclusion.assignee_text, '第 2 批需求确认');
    for (const kind of ['handled', 'adopted', 'not_adopted', 'no_further']) {
      const e = await mk();
      assert.strictEqual((await actOk(U.pm, e.id, { action: 'conclude', conclusion_kind: kind, text: `结论 ${kind}` })).entry.current_conclusion.kind, kind);
    }
    // to_change（S-S1c 起开放，完整用例在 sysbuild-api-suite-changes.js）：必带 change_id——缺 400（field change_id）、不存在 / 不属于本项目 409；project_terminated 在进行中项目 409
    const e3 = await mk();
    const tc = await act(U.pm, e3.id, { action: 'conclude', conclusion_kind: 'to_change', text: '转正式变更' });
    expectErr(tc, 400, 'SYSBUILD_INVALID_INPUT', 'to_change 缺 change_id');
    assert.strictEqual(tc.body.field, 'change_id');
    expectErr(await act(U.pm, e3.id, { action: 'conclude', conclusion_kind: 'to_change', text: '转正式变更', change_id: 999999 }), 409, 'SYSBUILD_STATE', 'to_change 的变更不存在');
    expectErr(await act(U.pm, e3.id, { action: 'conclude', conclusion_kind: 'handled', text: 'x', change_id: 1 }), 400, 'SYSBUILD_INVALID_INPUT', '非转变更结论不许带 change_id');
    expectErr(await act(U.pm, e3.id, { action: 'conclude', conclusion_kind: 'project_terminated', text: '项目已终止' }), 409, 'SYSBUILD_STATE', '项目未终止');
    assert.strictEqual((await actionsRows(e3.id)).length, 0);
    // 未开放 / 未知动作（S-S1b 起 link_sys_issue / assign_items / split 已开放，S-S1c 起 link_change 已开放，用例在 sysbuild-api-suite-routing.js / sysbuild-api-suite-changes.js；这里只剩 adjudicate）
    expectErr(await act(U.pm, e3.id, { action: 'link_change' }), 400, 'SYSBUILD_INVALID_INPUT', 'link_change 缺 change_id');
    // L5：adjudicate 不作为办理动作（裁定经确认任务进行），文案与「后续阶段开放」区分
    const adj = await act(U.pm, e3.id, { action: 'adjudicate' });
    expectErr(adj, 409, 'SYSBUILD_STATE', 'adjudicate 不作为办理动作');
    assert.strictEqual(adj.body.message, '裁定经确认任务进行，不作为办理动作');
    expectErr(await act(U.pm, e3.id, { action: 'bogus' }), 400, 'SYSBUILD_INVALID_INPUT', '未知动作');
    expectErr(await act(U.pm, e3.id, {}), 400, 'SYSBUILD_INVALID_INPUT', '缺动作');
    // L2（§5.3 403 先于 409）：没有「办理登记」权限的人（登记人本人、其他成员、只读账号、admin 未接管）得 403，不是「未开放」409；非成员 404
    for (const uid of [U.m1, U.m2, U.ro, U.admin]) {
      expectErr(await act(uid, e3.id, { action: 'adjudicate' }), 403, 'SYSBUILD_FORBIDDEN', `用户 ${uid} 的未开放动作 adjudicate：权限先于未开放`);
    }
    expectErr(await act(U.out, e3.id, { action: 'adjudicate' }), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    assert.strictEqual((await actionsRows(e3.id)).length, 0, '未开放动作不写办理记录');
    // P96：「项目已终止」结论不需要确认——来源方没有代表人（乙部）时也能直接已确定；有代表人的来源方同样不建任务
    const eNoDel = await regOk(U.x3, s.pid, { type: 'issue' });
    assert.strictEqual((await detail(U.pm, eNoDel.id)).confirmer.kind, 'unavailable', '前置：乙部没有代表人');
    const eNoDel3 = await regOk(U.x3, s.pid, { type: 'issue' });
    const eWithDel = await regOk(U.m1, s.pid, { type: 'issue' });
    assert.strictEqual((await detail(U.pm, eWithDel.id)).confirmer.kind, 'delegate');
    // 项目已终止后 project_terminated 可用
    assert.strictEqual((await post(U.admin, `/sysbuild/projects/${s.pid}/status`, { to: 'terminated', reason: 'C5 用例' })).status, 200);
    const pt = await actOk(U.pm, e3.id, { action: 'conclude', conclusion_kind: 'project_terminated', text: '项目已终止，关闭本条' });
    assert.deepStrictEqual([pt.entry.current_conclusion.kind, pt.entry.conclusion_state], ['project_terminated', 'settled_no_confirm']);
    const ptNo = await actOk(U.pm, eNoDel.id, { action: 'conclude', conclusion_kind: 'project_terminated', text: '项目已终止，乙部无代表人也直接关闭' });
    assert.deepStrictEqual([ptNo.entry.conclusion_state, ptNo.task], ['settled_no_confirm', null], '来源方无代表人：直接已确定');
    const ptDel = await actOk(U.pm, eWithDel.id, { action: 'conclude', conclusion_kind: 'project_terminated', text: '项目已终止' });
    assert.deepStrictEqual([ptDel.entry.conclusion_state, ptDel.task], ['settled_no_confirm', null], '有代表人也不建任务');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE object_type = 'conclusion' AND object_id IN (?, ?)", [eNoDel.id, eWithDel.id]), 0);
    // 对照：终止后其他结论类别仍要求来源方有代表人
    const ctl = await act(U.pm, eNoDel3.id, CONCLUDE);
    expectErr(ctl, 409, 'SYSBUILD_STATE', '终止后 handled 结论仍要求来源方有代表人');
    assert.ok(ctl.body.message.includes('暂无代表人'), ctl.body.message);
  });

  // ═══════════════════════ 17 读接口 ═══════════════════════
  test(`${T_READ}——列表按 node / period / type / party 筛选（最新在前，非法值 400，非成员 404，只读账号可读）；详情含附件、关联条目、办理记录、确认任务与修订、知会；办理类以外不能给结论`, async () => {
    const s = await mkScene();
    const n1 = await nodeId(s.pid, 'b_req');
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
    assert.ok(ro.body.entries.every((x) => ACTION_NAMES.every((n) => x.actions[n] === false)), '只读账号逐对象 actions 全假');
    // 别的项目的登记不出现
    const other = await mkScene();
    await regOk(U.pm, other.pid, { type: 'note' });
    assert.strictEqual((await get(U.pm, base)).body.entries.length, 4);
    // 详情
    const att = await stageAtt(s.pid, U.m1, 'a');
    const item = await mkItem(s.pid);
    const full = await regOk(U.m1, s.pid, { type: 'feedback', attachment_ids: [att], item_ids: [item.id] });
    await actOk(U.pm, full.id, CONCLUDE);
    const t = await lastTask(full.id, 'conclusion');
    assert.strictEqual((await openAndDecide(U.del, t.tid, 'object', { reason: '不同意' })).status, 200);
    await actOk(U.pm, full.id, { action: 'conclude', conclusion_kind: 'adopted', text: '改结论' });
    const dt = await detail(U.ro, full.id);
    assert.deepStrictEqual(dt.attachments.map((x) => [x.attachment_id, x.masked, x.deleted, x.original_name]), [[att, false, false, '确认证据.txt']]);
    assert.strictEqual(dt.attachments[0].sha256, 'a'.repeat(64));
    assert.deepStrictEqual(dt.items.map((x) => x.item_id), [item.id]);
    assert.deepStrictEqual(dt.records.map((x) => [x.action, x.conclusion_kind, x.created_by]), [['conclude', 'handled', U.pm], ['conclude', 'adopted', U.pm]]);
    assert.strictEqual(dt.confirm_tasks.length, 2);
    assert.deepStrictEqual(dt.confirm_tasks[0].revisions.map((r) => [r.rev_no, r.status, r.confirmation && r.confirmation.decision, r.confirmation && r.confirmation.method]), [[1, 'objected', 'object', 'platform']]);
    assert.deepStrictEqual(dt.confirm_tasks[1].revisions.map((r) => [r.rev_no, r.status, r.confirmation]), [[1, 'pending', null]]);
    assert.deepStrictEqual([dt.confirm_tasks[0].purpose, dt.confirm_tasks[0].object_type, dt.confirm_tasks[0].action_id], ['conclusion_confirm', 'conclusion', dt.records[0].id]);
    assert.deepStrictEqual([dt.notices.length, dt.operator_name !== null, dt.conclusion_state], [0, true, 'pending_confirm']);
    // 办理类以外不能给结论
    for (const type of ['note', 'lesson', 'benefit']) {
      const e = await regOk(U.m1, s.pid, { type });
      expectErr(await act(U.pm, e.id, CONCLUDE), 409, 'SYSBUILD_STATE', `${type} 不是办理类`);
    }
    const mat = await regOk(U.m1, s.pid, { type: 'material', attachment_ids: [await stageAtt(s.pid, U.m1, 'b')] });
    expectErr(await act(U.pm, mat.id, CONCLUDE), 409, 'SYSBUILD_STATE', 'material 不是办理类');
    // 详情：非法编号 400、不存在 404、非成员 404
    expectErr(await get(U.pm, '/sysbuild/entries/abc'), 400, 'SYSBUILD_INVALID_INPUT', '编号非法');
    expectErr(await get(U.pm, '/sysbuild/entries/99999999'), 404, 'SYSBUILD_NOT_FOUND', '不存在');
    expectErr(await get(U.out, `/sysbuild/entries/${a.id}`), 404, 'SYSBUILD_NOT_FOUND', '非成员');
  });

  // ═══════════════════════ 18 检查顺序 ═══════════════════════
  test(`${T_ORDER}——参数 400 → 对象 404 → 可见 404 → 权限 403 → 项目状态 409 → 对象状态 409；已终止项目里非 PM 先 403；办理 resolve 类在已终止 / 已结项 / 已暂停都不被项目状态拒绝`, async () => {
    const s = await mkScene();
    const e = await regOk(U.m1, s.pid, { type: 'feedback' });
    // 400 先于 404：不存在的登记 + 非法动作体 → 400
    expectErr(await act(U.pm, 99999999, { action: 'bogus' }), 400, 'SYSBUILD_INVALID_INPUT', '参数先于对象');
    expectErr(await act(U.pm, 99999999, CONCLUDE), 404, 'SYSBUILD_NOT_FOUND', '对象不存在');
    expectErr(await act(U.pm, 'abc', CONCLUDE), 400, 'SYSBUILD_INVALID_INPUT', '编号非法');
    expectErr(await act(U.out, e.id, CONCLUDE), 404, 'SYSBUILD_NOT_FOUND', '非成员先 404');
    expectErr(await act(U.m2, e.id, CONCLUDE), 403, 'SYSBUILD_FORBIDDEN', '成员无权先 403');
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
    expectErr(await act(U.m2, e.id, CONCLUDE), 403, 'SYSBUILD_FORBIDDEN', '终止后成员无权');
    assert.strictEqual((await act(U.pm, e.id, CONCLUDE)).status, 201, '终止后 PM 可办理');
    // 已结项（夹具）、已暂停：同样
    for (const st of ['closed', 'paused']) {
      const p = await mkScene();
      const pe = await regOk(U.m1, p.pid, { type: 'feedback' });
      if (st === 'closed') await sqlRun("UPDATE sysbuild_projects SET status = 'closed' WHERE id = ?", [p.pid]);
      else assert.strictEqual((await post(U.admin, `/sysbuild/projects/${p.pid}/status`, { to: 'paused', reason: 'C5 用例' })).status, 200);
      assert.strictEqual((await act(U.pm, pe.id, CONCLUDE)).status, 201, `${st}：PM 可办理`);
    }
  });

  // ═══════════════════════ 19 rules 矩阵与纯函数 ═══════════════════════
  test(`${T_RULES}——手写判定矩阵：写登记两类 × 四种项目状态；办理动作的权限 / 对象状态；知会异议；结论确认三个委托动作与 resolve 类；deriveEntryState 纯函数各路径`, async () => {
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
    // 办理动作
    const pm = idn({ isPm: true, isMember: true });
    const base = {
      isRegistrant: false, registrantWasPm: false, voided: false, type: 'feedback', conclusionState: 'none', commitmentCurrent: false, commitmentInitial: false, refObjectedEver: false, riskCurrent: false,
      confirmer: 'delegate', confirmerProxyOnly: false, owner: 'ok', projectStatus: 'active', markNeedsDevTask: false, // 修订批 3 H2：补标会不会建开发方认可任务（rules entry_mark_commitment，fail-closed 事实）
    };
    const T0 = (o) => Object.assign({}, base, o || {});
    const stateMsgNull = (op, t, who) => chk(op, who || pm, 'active', t);
    assert.strictEqual(stateMsgNull('entry_conclude', T0()), null);
    for (const st of ['confirmed', 'adjudicated', 'settled_no_confirm', 'for_reference']) assert.strictEqual(code(stateMsgNull('entry_conclude', T0({ conclusionState: st }))), '409:SYSBUILD_STATE', `有效结论 ${st} 不能再给结论`);
    for (const st of ['pending_confirm', 'objected', 'adjudication_rejected', 'for_reference_objected', 'none', 'terminated_conclusion_lapsed', 'to_change_lapsed']) assert.strictEqual(stateMsgNull('entry_conclude', T0({ conclusionState: st })), null, `${st} 可给结论`);
    // M-c：裁定中只有「项目已终止」结论（且项目已终止）可以收尾；其他结论类别、项目未终止时仍 409
    assert.strictEqual(stateMsgNull('entry_conclude', T0({ conclusionState: 'escalated', kind: 'project_terminated', projectStatus: 'terminated' })), null, '裁定中 + 项目已终止结论 + 项目已终止');
    assert.strictEqual(code(stateMsgNull('entry_conclude', T0({ conclusionState: 'escalated', kind: 'project_terminated', projectStatus: 'active' }))), '409:SYSBUILD_STATE', '裁定中 + 项目已终止结论 + 项目未终止');
    for (const kind of ['handled', 'adopted', 'deferred', 'to_sys_iteration', 'no_further', undefined]) {
      assert.strictEqual(code(stateMsgNull('entry_conclude', T0({ conclusionState: 'escalated', kind, projectStatus: 'terminated' }))), '409:SYSBUILD_STATE', `裁定中 + ${String(kind)}：仍 409`);
    }
    for (const st of ['escalated', 'voided', 'bogus', undefined]) assert.strictEqual(code(stateMsgNull('entry_conclude', T0({ conclusionState: st }))), '409:SYSBUILD_STATE', `${String(st)} 不可给结论（含事实没取到 fail-closed）`);
    assert.strictEqual(code(stateMsgNull('entry_conclude', T0({ type: 'note' }))), '409:SYSBUILD_STATE', '非办理类');
    assert.strictEqual(code(stateMsgNull('entry_conclude', T0({ confirmer: 'unavailable' }))), '409:SYSBUILD_STATE', '来源方暂无代表人');
    assert.strictEqual(code(stateMsgNull('entry_conclude', T0({ confirmer: undefined }))), '409:SYSBUILD_STATE', '确认人事实没取到 fail-closed');
    for (const c of ['none', 'owner', 'delegate']) assert.strictEqual(stateMsgNull('entry_conclude', T0({ confirmer: c })), null, `确认人 ${c}`);
    assert.strictEqual(stateMsgNull('entry_conclude', T0({ kind: 'to_change' })), null, 'S-S1c：转正式变更放行（change_id 在端点里校验）');
    assert.strictEqual(code(stateMsgNull('entry_conclude', T0({ kind: 'project_terminated' }))), '409:SYSBUILD_STATE');
    assert.strictEqual(stateMsgNull('entry_conclude', T0({ kind: 'project_terminated', projectStatus: 'terminated' })), null);
    assert.strictEqual(code(chk('entry_conclude', idn({ isAdmin: true, isMember: true }), 'active', T0())), '403:SYSBUILD_FORBIDDEN', 'admin 未接管不是 PM');
    assert.strictEqual(code(chk('entry_conclude', idn({ isPm: true, isMember: true, isReadonly: true }), 'active', T0())), '403:SYSBUILD_FORBIDDEN', '只读 PM');
    // 项目状态：resolve 类四态都放行
    for (const st of ['active', 'paused', 'terminated', 'closed']) assert.strictEqual(chk('entry_conclude', pm, st, T0()), null, `conclude × ${st}`);
    // for_reference
    assert.strictEqual(stateMsgNull('entry_for_reference', T0()), null);
    assert.strictEqual(code(stateMsgNull('entry_for_reference', T0({ type: 'issue' }))), '409:SYSBUILD_STATE');
    assert.strictEqual(code(stateMsgNull('entry_for_reference', T0({ commitmentCurrent: true }))), '409:SYSBUILD_STATE');
    assert.strictEqual(code(stateMsgNull('entry_for_reference', T0({ commitmentCurrent: undefined }))), '409:SYSBUILD_STATE', '承诺标记事实没取到 fail-closed');
    for (const st of ['none', 'pending_confirm', 'objected', 'terminated_conclusion_lapsed', 'to_change_lapsed']) assert.strictEqual(stateMsgNull('entry_for_reference', T0({ conclusionState: st })), null, `${st} 可标仅供参考`);
    assert.strictEqual(code(stateMsgNull('entry_for_reference', T0({ conclusionState: 'terminated_conclusion_lapsed', refObjectedEver: true }))), '409:SYSBUILD_STATE', 'lapsed 仍受「曾被异议」限制');
    assert.strictEqual(code(stateMsgNull('entry_for_reference', T0({ conclusionState: 'terminated_conclusion_lapsed', commitmentInitial: true }))), '409:SYSBUILD_STATE', 'lapsed 仍受承诺标记限制');
    for (const st of ['confirmed', 'for_reference', 'escalated', 'adjudication_rejected', 'for_reference_objected', 'voided']) assert.strictEqual(code(stateMsgNull('entry_for_reference', T0({ conclusionState: st }))), '409:SYSBUILD_STATE', `${st} 不可标仅供参考`);
    // M2 / M1：初始承诺标记与「仅供参考曾被异议」（fail-closed：事实没取到拒绝）
    assert.strictEqual(code(stateMsgNull('entry_for_reference', T0({ commitmentInitial: true }))), '409:SYSBUILD_STATE', '初始承诺标记');
    assert.ok(R.checkOp('entry_for_reference', pm, prj('active'), T0({ commitmentInitial: true })).message.includes('登记时'));
    assert.strictEqual(code(stateMsgNull('entry_for_reference', T0({ commitmentInitial: undefined }))), '409:SYSBUILD_STATE', '初始承诺事实没取到 fail-closed');
    assert.strictEqual(code(stateMsgNull('entry_for_reference', T0({ refObjectedEver: true }))), '409:SYSBUILD_STATE', '曾被异议');
    assert.ok(R.checkOp('entry_for_reference', pm, prj('active'), T0({ refObjectedEver: true })).message.includes('已被异议'));
    assert.strictEqual(code(stateMsgNull('entry_for_reference', T0({ refObjectedEver: undefined }))), '409:SYSBUILD_STATE', '曾被异议事实没取到 fail-closed');
    assert.strictEqual(stateMsgNull('entry_for_reference', T0({ conclusionState: 'pending_confirm', refObjectedEver: false })), null, '从未被异议的待确认登记仍可改标仅供参考');
    assert.strictEqual(code(stateMsgNull('entry_for_reference', T0({ conclusionState: 'pending_confirm', refObjectedEver: true }))), '409:SYSBUILD_STATE');
    // codex 24 M1：确认人无账号（只能代录）→ 不能标仅供参考；事实没取到拒绝；普通 conclude 不受影响；确认人 none / 有账号照常
    const proxyRef = R.checkOp('entry_for_reference', pm, prj('active'), T0({ confirmerProxyOnly: true }));
    assert.strictEqual(code(proxyRef), '409:SYSBUILD_STATE', '确认人无账号');
    assert.ok(proxyRef.message.includes('没有平台账号') && proxyRef.message.includes('代录'), proxyRef.message);
    assert.strictEqual(code(stateMsgNull('entry_for_reference', T0({ confirmerProxyOnly: undefined }))), '409:SYSBUILD_STATE', '确认人账号事实没取到 fail-closed');
    assert.strictEqual(stateMsgNull('entry_for_reference', T0({ confirmer: 'none', confirmerProxyOnly: false })), null);
    assert.strictEqual(stateMsgNull('entry_conclude', T0({ confirmerProxyOnly: true })), null, '普通 conclude 不看确认人是否有账号');
    // P96：项目已终止结论不要求确认人（含来源方暂无代表人、确认人事实没取到）；其他结论类别仍要求
    for (const c of ['unavailable', 'none', 'owner', 'delegate', undefined]) assert.strictEqual(stateMsgNull('entry_conclude', T0({ kind: 'project_terminated', projectStatus: 'terminated', confirmer: c })), null, `project_terminated × 确认人 ${String(c)}`);
    assert.strictEqual(code(stateMsgNull('entry_conclude', T0({ kind: 'handled', confirmer: 'unavailable' }))), '409:SYSBUILD_STATE', '其他结论类别仍要求确认人');
    // P94：有未结异议时只有登记人本人可作废；没有未结异议时 PM 可作废
    for (const st of ['objected', 'escalated', 'adjudication_rejected', 'for_reference_objected']) {
      const bad = R.checkOp('entry_void', pm, prj('active'), T0({ conclusionState: st }));
      assert.strictEqual(code(bad), '409:SYSBUILD_STATE', `${st}：PM 不能作废`);
      assert.strictEqual(bad.message, '有未结异议，不能由 PM 作废');
      assert.strictEqual(chk('entry_void', idn({ isMember: true }), 'active', T0({ conclusionState: st, isRegistrant: true })), null, `${st}：登记人本人可作废`);
      // M-a：登记时身份是 PM（PM 代登）的登记，即使 PM 就是登记人本人也不享豁免；快照事实没取到（undefined）同样拒绝
      assert.strictEqual(code(chk('entry_void', pm, 'active', T0({ conclusionState: st, isRegistrant: true, registrantWasPm: true }))), '409:SYSBUILD_STATE', `${st}：PM 代登的登记 PM 不能作废`);
      assert.strictEqual(code(chk('entry_void', pm, 'active', T0({ conclusionState: st, isRegistrant: true, registrantWasPm: undefined }))), '409:SYSBUILD_STATE', `${st}：登记时身份事实没取到 fail-closed`);
    }
    for (const st of ['none', 'pending_confirm', 'terminated_conclusion_lapsed', 'to_change_lapsed']) assert.strictEqual(chk('entry_void', pm, 'active', T0({ conclusionState: st })), null, `${st}：PM 可作废（无未结异议）`);
    assert.strictEqual(chk('entry_void', pm, 'active', T0({ conclusionState: 'none', isRegistrant: true, registrantWasPm: true })), null, '无未结异议时 PM 代登的登记 PM 可作废');
    // 更正 / 作废：登记人本人与 PM；只读一票否决
    const reg1 = idn({ isMember: true });
    assert.strictEqual(chk('entry_correct', reg1, 'active', T0({ isRegistrant: true })), null);
    assert.strictEqual(code(chk('entry_correct', reg1, 'active', T0())), '403:SYSBUILD_FORBIDDEN');
    assert.strictEqual(code(chk('entry_correct', idn({ isMember: true, isReadonly: true }), 'active', T0({ isRegistrant: true }))), '403:SYSBUILD_FORBIDDEN', '只读登记人');
    assert.strictEqual(chk('entry_correct', pm, 'closed', T0()), null);
    assert.strictEqual(chk('entry_void', reg1, 'terminated', T0({ isRegistrant: true })), null);
    assert.strictEqual(code(chk('entry_void', pm, 'active', T0({ conclusionState: 'confirmed' }))), '409:SYSBUILD_STATE');
    assert.strictEqual(chk('entry_void', pm, 'active', T0({ conclusionState: 'pending_confirm' })), null);
    assert.strictEqual(code(chk('entry_correct', pm, 'active', T0({ voided: true }))), '409:SYSBUILD_STATE');
    assert.strictEqual(code(chk('entry_correct', pm, 'active', T0({ voided: undefined }))), '409:SYSBUILD_STATE', 'voided 事实没取到 fail-closed');
    // 标记
    assert.strictEqual(stateMsgNull('entry_mark_commitment', T0()), null);
    assert.strictEqual(code(stateMsgNull('entry_mark_commitment', T0({ commitmentCurrent: true }))), '409:SYSBUILD_STATE');
    assert.strictEqual(code(stateMsgNull('entry_mark_commitment', T0({ conclusionState: 'for_reference' }))), '409:SYSBUILD_STATE');
    assert.strictEqual(stateMsgNull('entry_unmark_commitment', T0({ commitmentCurrent: true })), null);
    assert.strictEqual(code(stateMsgNull('entry_unmark_commitment', T0())), '409:SYSBUILD_STATE');
    assert.strictEqual(stateMsgNull('entry_mark_risk', T0({ type: 'issue' })), null);
    assert.strictEqual(code(stateMsgNull('entry_mark_risk', T0({ type: 'issue', riskCurrent: true }))), '409:SYSBUILD_STATE');
    assert.strictEqual(code(stateMsgNull('entry_mark_risk', T0({ type: 'feedback' }))), '409:SYSBUILD_STATE');
    assert.strictEqual(stateMsgNull('entry_unmark_risk', T0({ type: 'issue', riskCurrent: true, declineOutstanding: false })), null);
    assert.strictEqual(code(stateMsgNull('entry_unmark_risk', T0({ type: 'issue' }))), '409:SYSBUILD_STATE');
    // 修订批 4 P175：有未解除的不认可时不能取消风险标记（文案手写）；该事实没取到 fail-closed；没有风险标记时先报没有风险标记
    assert.strictEqual(stateMsgNull('entry_unmark_risk', T0({ type: 'issue', riskCurrent: true, declineOutstanding: true })).message, '该登记的交接确认已被代表人不认可，须先写答复重新发起、由代表人对重新发起的确认作出确认，或给出新的结论；在此之前不能取消风险标记');
    assert.strictEqual(code(stateMsgNull('entry_unmark_risk', T0({ type: 'issue', riskCurrent: true, declineOutstanding: true }))), '409:SYSBUILD_STATE');
    assert.strictEqual(code(stateMsgNull('entry_unmark_risk', T0({ type: 'issue', riskCurrent: true }))), '409:SYSBUILD_STATE', 'declineOutstanding 事实没取到 fail-closed');
    assert.strictEqual(stateMsgNull('entry_unmark_risk', T0({ type: 'issue', riskCurrent: false, declineOutstanding: true })).message, '该登记当前没有风险标记');
    assert.strictEqual(code(stateMsgNull('entry_unmark_risk', T0({ type: 'note', riskCurrent: true }))), '409:SYSBUILD_STATE');
    // 交裁定
    assert.strictEqual(stateMsgNull('entry_escalate', T0({ conclusionState: 'objected' })), null);
    for (const st of ['none', 'pending_confirm', 'confirmed', 'escalated', 'adjudication_rejected']) assert.strictEqual(code(stateMsgNull('entry_escalate', T0({ conclusionState: st }))), '409:SYSBUILD_STATE', `${st} 不可交裁定`);
    for (const o of ['missing', 'proxy_only', undefined]) assert.strictEqual(code(stateMsgNull('entry_escalate', T0({ conclusionState: 'objected', owner: o }))), '409:SYSBUILD_STATE', `负责人 ${String(o)}`);
    // 知会异议：接收人本人或来源方负责人；不带只读否决；已异议 / 非仅供参考 / 非最新知会 409
    const nt = (o) => Object.assign({ isRecipient: true, objectorBasis: null, objected: false, entryVoided: false, entryState: 'for_reference', isLatest: true }, o || {});
    assert.strictEqual(chk('notice_object', idn({ isReadonly: true }), 'active', nt()), null, '只读接收人可异议');
    assert.strictEqual(chk('notice_object', idn({ isMember: true }), 'closed', nt({ isRecipient: false, objectorBasis: 'source_party' })), null, '本方负责人 / 现任代表人');
    assert.strictEqual(chk('notice_object', idn({ isMember: true }), 'active', nt({ isRecipient: false, objectorBasis: 'registrant' })), null, '原登记人（codex 25 M1）');
    assert.strictEqual(chk('notice_object', idn({ isMember: true }), 'active', nt({ isRecipient: false, objectorBasis: 'confirmer' })), null, '当前结论确认人（codex 25 M1）');
    for (const b of ['party_member', 'pm', undefined]) assert.strictEqual(code(chk('notice_object', idn({ isMember: true }), 'active', nt({ isRecipient: false, objectorBasis: b }))), '403:SYSBUILD_FORBIDDEN', `无资格依据 ${String(b)}`);
    assert.strictEqual(code(chk('notice_object', idn({ isMember: true }), 'active', nt({ isRecipient: false }))), '403:SYSBUILD_FORBIDDEN');
    for (const o of [{ objected: true }, { objected: undefined }, { entryState: 'confirmed' }, { entryState: 'for_reference_objected' }, { isLatest: false }, { entryVoided: true }]) {
      assert.strictEqual(code(chk('notice_object', idn({}), 'active', nt(o))), '409:SYSBUILD_STATE', JSON.stringify(o));
    }
    // 结论确认三个委托动作：判定同 confirm_decide / confirm_proxy，项目状态类别 resolve（四态都允许）；confirm_decide 本身仍是 accept
    const dec = { isRequired: true, currentRevisionId: 5, revisionStatus: 'pending', objectVersionId: 9, objectPending: true, qualificationLoss: null };
    for (const st of ['active', 'paused', 'terminated', 'closed']) {
      assert.strictEqual(chk('entry_conclusion_decide', idn({}), st, dec), null, `结论确认 × ${st}`);
      assert.strictEqual(code(chk('confirm_decide', idn({}), st, dec)), st === 'active' || st === 'paused' ? null : '409:SYSBUILD_PROJECT_READONLY', `内容包确认 × ${st} 不变`);
    }
    assert.strictEqual(code(chk('entry_conclusion_decide', idn({}), 'active', Object.assign({}, dec, { isRequired: false }))), '403:SYSBUILD_FORBIDDEN');
    assert.strictEqual(code(chk('entry_conclusion_decide', idn({}), 'active', Object.assign({}, dec, { objectPending: false }))), '409:SYSBUILD_VERSION_CHANGED');
    assert.strictEqual(code(chk('entry_conclusion_decide', idn({}), 'active', Object.assign({}, dec, { qualificationLoss: '资格已失' }))), '409:SYSBUILD_STATE');
    const px = { proxyable: true, currentRevisionId: 5, revisionStatus: 'pending', objectVersionId: 9, objectPending: true, requiredIsSelf: false, qualificationLoss: null, historyConflict: null };
    assert.strictEqual(chk('entry_conclusion_proxy', pm, 'terminated', px), null);
    assert.strictEqual(code(chk('entry_conclusion_proxy', pm, 'active', Object.assign({}, px, { proxyable: false }))), '409:SYSBUILD_STATE');
    assert.strictEqual(code(chk('entry_conclusion_proxy', pm, 'active', Object.assign({}, px, { requiredIsSelf: true }))), '409:SYSBUILD_STATE');
    assert.strictEqual(code(chk('entry_conclusion_proxy', idn({ isMember: true }), 'active', px)), '403:SYSBUILD_FORBIDDEN');
    const ri = { objectType: 'conclusion', revisionStatus: 'pending', objectPending: true, reissueBlocked: null };
    assert.strictEqual(chk('entry_conclusion_reissue', pm, 'closed', ri), null);
    for (const o of [{ objectType: 'package_version' }, { revisionStatus: 'objected' }, { revisionStatus: 'rejected' }, { objectPending: false }, { reissueBlocked: '没有代表人' }]) {
      assert.strictEqual(code(chk('entry_conclusion_reissue', pm, 'active', Object.assign({}, ri, o))), '409:SYSBUILD_STATE', JSON.stringify(o));
    }
    assert.strictEqual(code(chk('entry_conclusion_reissue', idn({ isMember: true }), 'active', ri)), '403:SYSBUILD_FORBIDDEN');
    // 派生状态纯函数
    const ent = (o) => Object.assign({ commitment_flag: 0, is_risk: 0 }, o || {});
    const a = (id, action, o) => Object.assign({ id, action }, o || {});
    const d = (entry, actions, revs, objected, ps) => E.deriveEntryState(entry, actions, revs || {}, objected === true, ps === undefined ? 'active' : ps);
    // M-b：「项目已终止」结论只在项目当前状态为 terminated 时算有效结论，否则 terminated_conclusion_lapsed（不属有效结论）；其他结论类别不受项目状态影响
    const pt = a(1, 'conclude', { conclusion_kind: 'project_terminated' });
    assert.strictEqual(d(ent(), [pt], {}, false, 'terminated').conclusion_state, 'settled_no_confirm');
    for (const ps of ['active', 'paused', 'closed']) assert.strictEqual(d(ent(), [pt], {}, false, ps).conclusion_state, 'terminated_conclusion_lapsed', `项目 ${ps}：项目已终止结论失效`);
    assert.strictEqual(d(ent(), [a(1, 'conclude', { conclusion_kind: 'handled' })], {}, false, 'active').conclusion_state, 'settled_no_confirm', '其他结论类别不受影响');
    assert.strictEqual(d(ent(), [pt, a(2, 'conclude', { conclusion_kind: 'handled' })], { 2: 'pending' }, false, 'active').conclusion_state, 'pending_confirm', '重开后重新给结论：以新结论为准');
    assert.strictEqual(d(ent(), [pt], {}, false, 'terminated').current.id, 1);
    assert.strictEqual(d(ent(), [pt, a(2, 'void')], {}, false, 'active').conclusion_state, 'voided');
    // 预筛 Q4：「转正式变更」结论所挂变更已撤回 → to_change_lapsed（已确定 / 已确认两种有效结论都适用）；变更未撤回（草稿 / 待确认 / 已生效 / 状态未知）或结论还在待确认 / 有异议时不受影响
    const tc = a(5, 'conclude', { conclusion_kind: 'to_change', change_id: 3 });
    const dc = (revs, byChange) => E.deriveEntryState(ent(), [tc], revs, false, 'active', byChange).conclusion_state;
    assert.strictEqual(dc({}, { 3: 'withdrawn' }), 'to_change_lapsed', '已确定 + 变更已撤回');
    assert.strictEqual(dc({ 5: 'confirmed' }, { 3: 'withdrawn' }), 'to_change_lapsed', '已确认 + 变更已撤回');
    for (const st of ['draft', 'pending', 'effective']) assert.strictEqual(dc({}, { 3: st }), 'settled_no_confirm', `变更 ${st}：结论保持有效`);
    assert.strictEqual(dc({}, undefined), 'settled_no_confirm', '没带变更状态按未撤回');
    assert.strictEqual(dc({}, {}), 'settled_no_confirm', '变更状态未知按未撤回');
    assert.strictEqual(dc({ 5: 'pending' }, { 3: 'withdrawn' }), 'pending_confirm', '待确认的结论不改状态');
    assert.strictEqual(dc({ 5: 'objected' }, { 3: 'withdrawn' }), 'objected', '有异议的结论不改状态');
    assert.strictEqual(E.deriveEntryState(ent(), [tc, a(6, 'void')], {}, false, 'active', { 3: 'withdrawn' }).conclusion_state, 'voided', '作废优先');
    assert.strictEqual(E.deriveEntryState(ent(), [tc, a(6, 'conclude', { conclusion_kind: 'handled' })], {}, false, 'active', { 3: 'withdrawn' }).conclusion_state, 'settled_no_confirm', '再给结论：以新结论为准');
    assert.throws(() => E.deriveEntryState(ent(), [], {}, false, undefined), (e) => e && e.status === 500 && e.code === 'SYSBUILD_INTERNAL', '缺项目状态 fail-closed');
    assert.deepStrictEqual([d(ent(), []).conclusion_state, d(ent(), []).current], ['none', null]);
    assert.strictEqual(d(ent(), [a(1, 'conclude', { conclusion_kind: 'handled' })]).conclusion_state, 'settled_no_confirm', '无任务 = 已确定');
    assert.strictEqual(d(ent(), [a(1, 'conclude')], { 1: 'pending' }).conclusion_state, 'pending_confirm');
    assert.strictEqual(d(ent(), [a(1, 'conclude')], { 1: 'confirmed' }).conclusion_state, 'confirmed');
    assert.strictEqual(d(ent(), [a(1, 'conclude')], { 1: 'objected' }).conclusion_state, 'objected');
    assert.strictEqual(d(ent(), [a(1, 'conclude'), a(2, 'conclude')], { 1: 'superseded', 2: 'pending' }).conclusion_state, 'pending_confirm', '后一条结论为准');
    assert.strictEqual(d(ent(), [a(1, 'conclude'), a(2, 'escalate')], { 1: 'objected', 2: 'pending' }).conclusion_state, 'escalated');
    assert.strictEqual(d(ent(), [a(1, 'conclude'), a(2, 'escalate')], { 1: 'objected', 2: 'confirmed' }).conclusion_state, 'adjudicated');
    assert.strictEqual(d(ent(), [a(1, 'conclude'), a(2, 'escalate')], { 1: 'objected', 2: 'rejected' }).conclusion_state, 'adjudication_rejected');
    assert.strictEqual(d(ent(), [a(1, 'conclude'), a(2, 'escalate'), a(3, 'conclude')], { 1: 'objected', 2: 'rejected', 3: 'pending' }).conclusion_state, 'pending_confirm');
    assert.strictEqual(d(ent(), [a(1, 'for_reference')]).conclusion_state, 'for_reference');
    assert.strictEqual(d(ent(), [a(1, 'for_reference')], {}, true).conclusion_state, 'for_reference_objected');
    assert.strictEqual(d(ent(), [a(1, 'for_reference'), a(2, 'conclude')], { 2: 'confirmed' }, true).conclusion_state, 'confirmed', '被异议后改结论：以结论为准');
    assert.strictEqual(d(ent(), [a(1, 'conclude'), a(2, 'void')], { 1: 'invalid' }).conclusion_state, 'voided', '作废优先');
    assert.strictEqual(d(ent(), [a(1, 'void'), a(2, 'correct')]).voided, true);
    assert.strictEqual(d(ent(), [a(1, 'correct')]).conclusion_state, 'none', '更正不改状态');
    // 标记归并
    const m = d(ent({ commitment_flag: 1, is_risk: 1 }), [a(1, 'unmark_commitment'), a(2, 'unmark_risk'), a(3, 'mark_commitment'), a(4, 'mark_risk'), a(5, 'unmark_risk')]);
    assert.deepStrictEqual([m.commitment_current, m.risk_current], [true, false]);
    assert.deepStrictEqual([d(ent(), []).commitment_current, d(ent({ commitment_flag: 1 }), []).commitment_current], [false, true]);
    // 单个动作的效果（不被后面的动作遮蔽）
    assert.strictEqual(d(ent({ commitment_flag: 1 }), [a(1, 'unmark_commitment')]).commitment_current, false, '取消承诺');
    assert.strictEqual(d(ent(), [a(1, 'mark_commitment')]).commitment_current, true, '补标承诺');
    assert.strictEqual(d(ent(), [a(1, 'mark_risk')]).risk_current, true, '补标风险');
    assert.strictEqual(d(ent({ is_risk: 1 }), [a(1, 'unmark_risk')]).risk_current, false, '取消风险');
    assert.strictEqual(d(ent({ is_risk: 1 }), [a(1, 'unmark_commitment')]).risk_current, true, '取消承诺不动风险');
    // 库内矛盾：最终状态落在已被替代的修订上 / 未登记的修订状态 / 交裁定缺任务 → 500
    const ise = (e) => e && e.status === 500 && e.code === 'SYSBUILD_INTERNAL';
    assert.throws(() => d(ent(), [a(1, 'conclude')], { 1: 'superseded' }), ise);
    assert.throws(() => d(ent(), [a(1, 'conclude')], { 1: 'bogus' }), ise);
    assert.throws(() => d(ent(), [a(1, 'escalate')], {}), ise);
    assert.throws(() => d(ent(), [a(1, 'escalate')], { 1: 'objected' }), ise);
    assert.throws(() => d(ent(), [a(1, 'conclude')], { 1: 'rejected' }), ise);
    // 日期差
    assert.deepStrictEqual([E.daysBetween('2026-11-10 09:00:00', '2026-11-15'), E.daysBetween('2026-11-15', '2026-11-15'), E.daysBetween('2026-11-16', '2026-11-15'), E.daysBetween('2026-02-28', '2026-03-01')], [5, 0, 0, 1]);
    assert.throws(() => E.daysBetween('abc', '2026-11-15'), ise);
    // 有效结论集合与 rules 常量
    assert.deepStrictEqual([...R.EFFECTIVE_CONCLUSION_STATES].sort(), ['adjudicated', 'confirmed', 'for_reference', 'settled_no_confirm']);
    assert.deepStrictEqual([...R.ENTRY_CONCLUSION_STATES].sort(), ['adjudicated', 'adjudication_rejected', 'confirmed', 'escalated', 'for_reference', 'for_reference_objected', 'none', 'objected', 'pending_confirm', 'settled_no_confirm', 'split_container', 'terminated_conclusion_lapsed', 'to_change_lapsed', 'voided']);
  });

  // ═══════════════════════ 20 只追加 ═══════════════════════
  test(`${T_ONLY}——登记与办理记录只追加：全部办理动作之后登记行、办理记录行不被改写；知会异议每条知会至多一行（唯一索引兜底）`, async () => {
    const s = await mkScene();
    const e = await regOk(U.m1, s.pid, { type: 'issue', title: '原标题', body: '原文', is_risk: 1 });
    const snap = async () => JSON.stringify(await sqlGet('SELECT * FROM sysbuild_entries WHERE id = ?', [e.id]));
    const before = await snap();
    await actOk(U.m1, e.id, { action: 'correct', text: '更正' });
    await actOk(U.pm, e.id, { action: 'mark_commitment', reason: '补标' });
    await actOk(U.pm, e.id, { action: 'unmark_risk', reason: '解除' });
    await actOk(U.pm, e.id, CONCLUDE);
    const t = await lastTask(e.id, 'conclusion');
    assert.strictEqual((await openAndDecide(U.del, t.tid, 'object', { reason: '不同意' })).status, 200);
    await actOk(U.pm, e.id, { action: 'escalate' });
    assert.strictEqual(await snap(), before, '登记行一字未改');
    const rows = await actionsRows(e.id);
    assert.deepStrictEqual(rows.map((r) => r.action), ['correct', 'mark_commitment', 'unmark_risk', 'conclude', 'escalate']);
    assert.ok(rows.every((r, i) => i === 0 || r.id > rows[i - 1].id));
    // 知会异议唯一索引
    const fb = await regOk(U.m1, s.pid, { type: 'feedback' });
    await actOk(U.pm, fb.id, { action: 'for_reference' });
    const nid = (await sqlGet("SELECT id FROM sysbuild_notices WHERE ref_type = 'entry' AND ref_id = ?", [fb.id])).id;
    assert.strictEqual((await post(U.del, `/sysbuild/notices/${nid}/object`, { reason: '异议' })).status, 201);
    await assert.rejects(() => sqlRun("INSERT INTO sysbuild_notice_objections (notice_id, actor_user_id, member_id, reason, mode) VALUES (?, 1, 1, ?, 'return_to_handling')", [nid, '直接写库的第二条']), /UNIQUE/);
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
  em('有效结论集合漏掉仅供参考', [T_REF, T_RULES], 'rules.js', "Object.freeze(['settled_no_confirm', 'confirmed', 'adjudicated', 'for_reference']);", "Object.freeze(['settled_no_confirm', 'confirmed', 'adjudicated']);"),
  em('有效结论集合漏掉裁定通过', [T_ESC, T_RULES], 'rules.js', "Object.freeze(['settled_no_confirm', 'confirmed', 'adjudicated', 'for_reference']);", "Object.freeze(['settled_no_confirm', 'confirmed', 'for_reference']);"),
  em('有效结论集合漏掉已确定（不需确认）', [T_CONFIRMER, T_RULES], 'rules.js', "Object.freeze(['settled_no_confirm', 'confirmed', 'adjudicated', 'for_reference']);", "Object.freeze(['confirmed', 'adjudicated', 'for_reference']);"),
  // 预筛 Q4：两个状态集合都加了 to_change_lapsed，下面五条锚点随之改写（变异结果的列表同样带它）
  em('可再给结论的状态漏掉待确认', [T_FLOW, T_RULES], 'rules.js', "Object.freeze(['none', 'pending_confirm', 'objected', 'adjudication_rejected', 'for_reference_objected', 'terminated_conclusion_lapsed', 'to_change_lapsed']);", "Object.freeze(['none', 'objected', 'adjudication_rejected', 'for_reference_objected', 'terminated_conclusion_lapsed', 'to_change_lapsed']);"),
  em('可再给结论的状态漏掉裁定未通过', [T_ESC, T_RULES], 'rules.js', "Object.freeze(['none', 'pending_confirm', 'objected', 'adjudication_rejected', 'for_reference_objected', 'terminated_conclusion_lapsed', 'to_change_lapsed']);", "Object.freeze(['none', 'pending_confirm', 'objected', 'for_reference_objected', 'terminated_conclusion_lapsed', 'to_change_lapsed']);"),
  em('可再给结论的状态漏掉仅供参考被异议', [T_REF, T_RULES], 'rules.js', "Object.freeze(['none', 'pending_confirm', 'objected', 'adjudication_rejected', 'for_reference_objected', 'terminated_conclusion_lapsed', 'to_change_lapsed']);", "Object.freeze(['none', 'pending_confirm', 'objected', 'adjudication_rejected', 'terminated_conclusion_lapsed', 'to_change_lapsed']);"),
  em('裁定中也可再给结论', [T_ESC, T_RULES], 'rules.js', "Object.freeze(['none', 'pending_confirm', 'objected', 'adjudication_rejected', 'for_reference_objected', 'terminated_conclusion_lapsed', 'to_change_lapsed']);", "Object.freeze(['none', 'pending_confirm', 'objected', 'adjudication_rejected', 'for_reference_objected', 'terminated_conclusion_lapsed', 'to_change_lapsed', 'escalated']);"),
  em('可标仅供参考的状态漏掉有异议', [T_RULES, T_FLAGS], 'rules.js', "Object.freeze(['none', 'pending_confirm', 'objected', 'terminated_conclusion_lapsed', 'to_change_lapsed']);", "Object.freeze(['none', 'pending_confirm', 'terminated_conclusion_lapsed', 'to_change_lapsed']);"),
  em('给结论不限办理类', [T_READ, T_RULES], 'rules.js', "if (!ENTRY_HANDLED_TYPES.includes(t.type)) return '只有意见与反馈、问题与处理可以给结论';", ''),
  em('项目已终止结论不限项目状态', [T_KINDS, T_RULES], 'rules.js', "if (t.kind === 'project_terminated' && t.projectStatus !== 'terminated')", 'if (false)'),
  em('来源方暂无代表人时放行', [T_CONFIRMER, T_RULES], 'rules.js', "return t.confirmer === 'unavailable' ? ENTRY_CONFIRMER_UNAVAILABLE_MESSAGE : PROXY_FACT_UNKNOWN_MESSAGE;", 'return null;'),
  em('仅供参考不限意见与反馈', [T_REF, T_RULES], 'rules.js', "if (t.type !== 'feedback') return '只有意见与反馈可以标仅供参考';", ''),
  // 下面几条把「判定行 + 紧随其后的 fail-closed 兜底行」一起去掉：只去判定行时兜底行仍以 409 拦下，状态码不变，属于等价变异
  em('仅供参考不挡涉及承诺', [T_MARK, T_RULES], 'rules.js', "if (t.commitmentCurrent === true) return '带「涉及承诺」标记的登记不能标仅供参考';\n      if (t.commitmentCurrent !== false) return PROXY_FACT_UNKNOWN_MESSAGE;", ''),
  em('重复补标涉及承诺放行', [T_MARK, T_RULES], 'rules.js', "if (t.commitmentCurrent === true) return '该登记已标注涉及承诺';\n      if (t.commitmentCurrent !== false) return PROXY_FACT_UNKNOWN_MESSAGE;", ''),
  em('已标仅供参考仍可补标涉及承诺', [T_MARK, T_RULES], 'rules.js', "return t.conclusionState === 'for_reference' ? '已标仅供参考的登记不能补标涉及承诺' : null;", 'return null;'),
  em('没标承诺也能取消', [T_MARK, T_RULES], 'rules.js', "if (t.commitmentCurrent === false) return '该登记当前没有涉及承诺标记';\n      return t.commitmentCurrent === true ? null : PROXY_FACT_UNKNOWN_MESSAGE;", 'return null;'),
  em('重复补标风险放行', [T_MARK, T_RULES], 'rules.js', "if (t.riskCurrent === true) return '该登记已标风险';\n      return t.riskCurrent === false ? null : PROXY_FACT_UNKNOWN_MESSAGE;", 'return null;'),
  em('补标风险不限问题与处理', [T_MARK, T_RULES], 'rules.js', "if (t.type !== 'issue') return '只有问题与处理类可以标风险';\n      if (t.riskCurrent === true)", 'if (t.riskCurrent === true)'),
  em('没标风险也能取消', [T_MARK, T_RULES], 'rules.js', "if (t.riskCurrent === false) return '该登记当前没有风险标记';\n      if (t.riskCurrent === true && t.declineOutstanding === true) return UNMARK_RISK_DECLINED_MESSAGE;\n      return t.riskCurrent === true && t.declineOutstanding === false ? null : PROXY_FACT_UNKNOWN_MESSAGE;", 'return null;'),  em('交裁定不要求有异议', [T_ESC, T_RULES], 'rules.js', "if (t.conclusionState !== 'objected') return '只有「有异议」的结论可以交负责人裁定';", ''),
  { // 去掉判定行并把兜底行放宽，否则兜底行仍以 409 拦下
    id: 'C5 登记：交裁定不挡没有现任负责人', expect: [T_ESC, T_RULES],
    edits: [
      { file: 'rules.js', from: "if (t.owner === 'missing') return '来源方没有现任负责人，无法交负责人裁定';", to: '' },
      { file: 'rules.js', from: "return t.owner === 'ok' ? null : PROXY_FACT_UNKNOWN_MESSAGE;", to: 'return null;' },
    ],
  },
  {
    id: 'C5 登记：交裁定不挡无账号负责人', expect: [T_ESC, T_RULES],
    edits: [
      { file: 'rules.js', from: "if (t.owner === 'proxy_only') return '来源方负责人没有平台账号，裁定只能在平台作出，请改结论后重新发起确认';", to: '' },
      { file: 'rules.js', from: "return t.owner === 'ok' ? null : PROXY_FACT_UNKNOWN_MESSAGE;", to: 'return null;' },
    ],
  },
  em('知会重复异议放行', [T_RULES], 'rules.js', "if (t.objected === true) return '该知会已提过异议，同一知会只能异议一次';\n      if (t.objected !== false) return PROXY_FACT_UNKNOWN_MESSAGE;", ''),
  em('知会异议任何成员都可提', [T_REF, T_RULES], 'rules.js', 'const canObjectNotice = (identity, project, t) => t.isRecipient === true || NOTICE_OBJECTOR_BASES.includes(t.objectorBasis);', 'const canObjectNotice = () => true;'), // codex 25 M1：资格改为接收人或 objectorBasisOf 依据，锚点随之改写
  em('知会异议漏掉来源方负责人', [T_REF, T_RULES], 'rules.js', 'const canObjectNotice = (identity, project, t) => t.isRecipient === true || NOTICE_OBJECTOR_BASES.includes(t.objectorBasis);', 'const canObjectNotice = (identity, project, t) => t.isRecipient === true;'),
  em('知会异议不核登记当前状态', [T_RULES], 'rules.js', "if (t.isLatest !== true || t.entryState !== 'for_reference') return", 'if (false) return'), // API 层只有「已异议」一条路能到达这个分支（被异议后状态才会离开仅供参考），所以只有 rules 用例能判别
  em('写登记过程类按补充类判项目状态', [T_STATUS, T_RULES], 'rules.js', "entry_create_process: 'register_process',", "entry_create_process: 'register_supplement',"),
  em('写登记补充类按过程类判项目状态', [T_STATUS, T_RULES], 'rules.js', "entry_create_supplement: 'register_supplement',", "entry_create_supplement: 'register_process',"),
  em('给结论的项目状态类别记成 maintain', [T_ORDER, T_RULES], 'rules.js', "  entry_conclude: 'resolve',", "  entry_conclude: 'maintain',"),
  em('知会异议的项目状态类别记成 maintain', [T_REF, T_RULES], 'rules.js', "  notice_object: 'resolve',", "  notice_object: 'maintain',"),
  em('结论确认决策的项目状态类别记成 accept', [T_TERM, T_RULES], 'rules.js', "  entry_conclusion_decide: 'resolve',", "  entry_conclusion_decide: 'accept',"),
  em('结论确认改发的项目状态类别记成 maintain', [T_REISSUE, T_RULES], 'rules.js', "  entry_conclusion_reissue: 'resolve',", "  entry_conclusion_reissue: 'maintain',"),
  em('结论确认代录的项目状态类别记成 accept', [T_PROXY, T_RULES], 'rules.js', "  entry_conclusion_proxy: 'resolve',", "  entry_conclusion_proxy: 'accept',"),
  em('项目 actions.create_entry 只看过程登记', [T_STATUS], 'rules.js', "create_entry: opAllowed('entry_create_process', identity, project, {}) || opAllowed('entry_create_supplement', identity, project, {}),", "create_entry: opAllowed('entry_create_process', identity, project, {}),"),
  em('结论确认决策不再委托 confirm_decide 的对象状态', [T_FLOW, T_RULES], 'rules.js', 'state: (t) => OBJECT_OPS.confirm_decide.state(t),', 'state: () => null,'),
  em('结论确认决策不再委托 confirm_decide 的权限', [T_FLOW, T_RULES], 'rules.js', 'can: (identity, project, t) => OBJECT_OPS.confirm_decide.can(identity, project, t),', 'can: () => true,'),
  em('结论确认改发放行已处理的修订', [T_REISSUE, T_RULES], 'rules.js', "if (t.revisionStatus !== 'pending') return '只有待确认的修订可以改发；有异议的结论请改结论或交负责人裁定';", ''),
  // ── entries-core.js：时段、确认人解析、状态派生、冻结、关闭待确认修订 ──
  em('收口后天数多算一天', [T_PERIOD, T_RULES], 'entries-core.js', 'Math.round(ms / 86400000)', 'Math.round(ms / 86400000) + 1'),
  em('节点未收口也判补充登记', [T_PERIOD, T_STATUS], 'entries-core.js', "if (node.status !== 'closed') return { period: 'process', days: null };", ''),
  em('项目整体未结项 / 终止也判补充登记', [T_PERIOD, T_STATUS], 'entries-core.js', "if (!PROJECT_ENDED_STATUSES.includes(project.status)) return { period: 'process', days: null };", ''),
  em('结项 / 终止日期不读状态事件', [T_PERIOD], 'entries-core.js', 'if (to === toStatus) return e.created_at;', ''),
  em('确认人解析：任何负责人都当作登记人本人', [T_CONFIRMER], 'entries-core.js', 'if (m && m.user_id !== null && Number(m.user_id) === Number(entry.operator_user_id)) {', 'if (m) {'),
  em('确认人解析：没有代表人时负责人代行', [T_CONFIRMER, T_FLOW], 'entries-core.js', 'const dlg = await core.currentDelegate(q, partyId);', 'const dlg = owner ? { delegationId: null, memberId: owner.memberId, proxyOnly: owner.proxyOnly } : await core.currentDelegate(q, partyId);'),
  em('确认人解析：来源方为空也要确认', [T_CONFIRMER], 'entries-core.js', "return { kind: 'none', partyId: null,", "return { kind: 'unavailable', partyId: null,"),
  em('身份快照：内部成员标志恒假', [T_WHO], 'entries-core.js', 'is_internal: identity.isPm !== true && identity.memberId !== null && identity.memberId !== undefined && partyId === null,', 'is_internal: false,'),
  em('身份快照：负责人标志恒假', [T_WHO], 'entries-core.js', "is_owner: partyId !== null && Array.isArray(identity.ownerOfParties) && identity.ownerOfParties.includes(partyId),", 'is_owner: false,'),
  em('派生：作废不改状态', [T_VOID, T_RULES], 'entries-core.js', "case 'void': voided = true; break;", "case 'void': break;"),
  em('派生：作废后状态仍是结论状态', [T_VOID, T_RULES], 'entries-core.js', "conclusion_state: voided ? 'voided' : state,", 'conclusion_state: state,'),
  em('派生：取消承诺不生效', [T_MARK, T_RULES], 'entries-core.js', "case 'unmark_commitment': commitment = false; break;", "case 'unmark_commitment': break;"),
  em('派生：补标风险不生效', [T_MARK, T_RULES], 'entries-core.js', "case 'mark_risk': risk = true; break;", "case 'mark_risk': break;"),
  em('派生：忽略登记时的初始承诺标记', [T_MARK, T_RULES], 'entries-core.js', 'let commitment = entry.commitment_flag === 1;', 'let commitment = false;'),
  em('派生：仅供参考被异议不生效', [T_REF, T_RULES], 'entries-core.js', "if (state === 'for_reference' && latestRefObjected === true) state = 'for_reference_objected';", ''),
  em('派生：裁定通过记成已确认', [T_ESC, T_RULES], 'entries-core.js', "confirmed: 'adjudicated', rejected:", "confirmed: 'confirmed', rejected:"),
  em('派生：裁定不认可记成有异议', [T_ESC, T_RULES], 'entries-core.js', "rejected: 'adjudication_rejected',", "rejected: 'objected',"),
  em('派生：待确认记成无结论', [T_FLOW, T_RULES], 'entries-core.js', "{ pending: 'pending_confirm', confirmed:", "{ pending: 'none', confirmed:"),
  em('派生：最终状态落在已替代修订上不再报错', [T_RULES], 'entries-core.js', "if (!voided && !pendingResolved) throw internalError('登记的最终结论落在已被替代或已失效的修订上');", ''),
  em('裁定人解析：无账号负责人也算 ok', [T_ESC], 'entries-core.js', "return { state: owner.proxyOnly ? 'proxy_only' : 'ok', owner };", "return { state: 'ok', owner };"),
  em('登记附件每次给结论都重复冻结', [T_FLOW], 'entries-core.js', 'if (!existing) {', 'if (true) {'),
  em('新结论替代旧待确认修订的原因被改', [T_FLOW], 'entries-core.js', "const SUPERSEDED_BY_NEW_CONCLUSION = 'PM 已改结论';", "const SUPERSEDED_BY_NEW_CONCLUSION = '改结论';"),
  em('作废失效修订的原因被改', [T_VOID], 'entries-core.js', "const ENTRY_VOIDED_REASON = '登记已作废';", "const ENTRY_VOIDED_REASON = '作废';"),
  em('结论任务对象一律视为仍是当前结论', [T_FLOW], 'entries-core.js', "pending = action.action === 'conclude' && d.current !== null && d.current.id === action.id && d.conclusion_state === 'pending_confirm';", 'pending = true;'),
  em('裁定任务对象一律视为仍是当前裁定', [T_ESC], 'entries-core.js', "pending = action.action === 'escalate' && lastEscalate !== undefined && lastEscalate.id === action.id && d.conclusion_state === 'escalated';", 'pending = true;'),
  em('办理动作 target 的作废标志恒假', [T_VOID, T_FLAGS], 'entries-core.js', 'voided: facts.derived.voided,', 'voided: false,'),
  em('办理动作 target 的结论状态恒无结论', [T_FLAGS, T_FLOW], 'entries-core.js', 'conclusionState: facts.derived.conclusion_state,', "conclusionState: 'none',"),
  em('办理动作 target 的确认人恒代表人', [T_CONFIRMER], 'entries-core.js', 'confirmer: conf.kind,', "confirmer: 'delegate',"),
  em('办理动作 target 的负责人状态恒 ok', [T_ESC], 'entries-core.js', 'owner: adj.state,', "owner: 'ok',"),
  em('办理动作 target 的项目状态恒已终止', [T_KINDS], 'entries-core.js', 'projectStatus: project.status,', "projectStatus: 'terminated',"),
  em('办理动作 target 不认登记人', [T_VOID, T_FLAGS], 'entries-core.js', 'isRegistrant: Number(entry.operator_user_id) === Number(user.id),', 'isRegistrant: false,'),
  // ── entries.js：写登记 / 办理 / 知会 ──
  em('用途越界不校验', [T_FIELDS], 'entries.js', "if (typeof purpose !== 'string' || !schema.ENUMS.entryPurpose.includes(purpose)) throw invalid(", 'if (false) throw invalid('),
  em('非问题类也能标风险', [T_FIELDS], 'entries.js', "if (isRisk === 1 && type !== 'issue') throw invalid(", 'if (false) throw invalid('),
  em('业务日期可晚于今天', [T_FIELDS], 'entries.js', 'if (input.businessDate !== null && input.businessDate > todayStr)', 'if (false)'),
  em('已取消的节点可关联新登记', [T_FIELDS], 'entries.js', "if (node !== null && node.status === 'cancelled') throw stateError(", 'if (false) throw stateError('),
  em('非 PM 也能填来源方', [T_WHO], 'entries.js', "if (identity.isPm !== true) throw invalid('只有项目经理代登时可以填写来源方', 'source_party_id');", ''),
  em('来源方不核属于本项目', [T_WHO], 'entries.js', "'SELECT id FROM sysbuild_parties WHERE id = ? AND project_id = ?', [input.sourcePartyId, pid]", "'SELECT id FROM sysbuild_parties WHERE id = ? AND ? > 0', [input.sourcePartyId, pid]"),
  em('成员登记不取成员行的参与方', [T_WHO, T_CONFIRMER], 'entries.js', 'sourcePartyId = identity.partyId === undefined ? null : identity.partyId;', 'sourcePartyId = null;'),
  em('补交材料不要求附件', [T_EVID], 'entries.js', "if (mode === 'material' && count === 0) throw makeError(400, 'SYSBUILD_EVIDENCE_REQUIRED', '补交材料必须上传附件');", ''),
  em('涉及承诺不要求证据', [T_EVID], 'entries.js', "if (mode === 'direction' && !ev.noEvidence && count === 0) {", 'if (false) {'),
  em('无书面证据原因不核 10 字', [T_EVID], 'entries.js', 'if (ev.noEvidence && (ev.noEvidenceReason === null || Array.from(ev.noEvidenceReason).length < EVIDENCE_REASON_MIN)) {', 'if (false) {'),
  em('证据模式一律可选', [T_EVID], 'entries.js', "input.type === 'material' ? 'material' : (input.commitment === 1 ? 'direction' : 'optional')", "'optional'"),
  em('附件与声明可以并存', [T_EVID], 'entries.js', "if (ev.noEvidence && count > 0) throw invalid('已附证据附件，不应再声明无书面证据', 'no_written_evidence');", ''),
  em('登记附件绑定类型写错', [T_EVID], 'entries.js', "ownerType: 'entry', ownerId: eid,", "ownerType: 'event', ownerId: eid,"),
  em('关联条目一律取最新版本', [T_ITEMS], 'entries.js', 'if (hasKey(cur.byItem, itemId)) versionId = cur.byItem[itemId].item_version_id;', 'if (false) versionId = cur.byItem[itemId].item_version_id;'),
  em('关联条目取最早版本', [T_ITEMS], 'entries.js', "'SELECT id FROM sysbuild_item_versions WHERE item_id = ? ORDER BY version_no DESC LIMIT 1'", "'SELECT id FROM sysbuild_item_versions WHERE item_id = ? ORDER BY version_no ASC LIMIT 1'"),
  em('关联条目不核属于本项目', [T_ITEMS], 'entries.js', "'SELECT id FROM sysbuild_items WHERE id = ? AND project_id = ?', [itemId, pid]", "'SELECT id FROM sysbuild_items WHERE id = ? AND ? > 0', [itemId, pid]"),
  em('可见性检查被去掉', [T_WHO, T_READ], 'entries.js', 'rules.assertVisible(access);\n    const identity = await rules.completeIdentity(q, access, user);', 'const identity = await rules.completeIdentity(q, access, user);'),
  em('新结论不替代旧待确认修订', [T_FLOW], 'entries.js', "closed = await entries.closePendingEntryRevisions(q, user, entry, 'superseded', entries.SUPERSEDED_BY_NEW_CONCLUSION, input.kind === 'project_terminated' ? entries.ESCALATED_CLOSED_BY_TERMINATION_REASON : undefined);", 'closed = [];'),
  em('作废不失效待确认修订', [T_VOID], 'entries.js', "closed = await entries.closePendingEntryRevisions(q, user, entry, 'invalid', entries.ENTRY_VOIDED_REASON);", 'closed = [];'),
  em('结论确认任务不记依据任职 / 授权', [T_CONFIRMER], 'entries.js', 'requiredMemberId: conf.memberId, basisAppointmentId: conf.appointmentId, basisDelegationId: conf.delegationId,', 'requiredMemberId: conf.memberId, basisAppointmentId: null, basisDelegationId: null,'),
  em('裁定任务不记依据任职', [T_ESC], 'entries.js', 'requiredMemberId: adj.owner.memberId, basisAppointmentId: adj.owner.appointmentId, basisDelegationId: null,', 'requiredMemberId: adj.owner.memberId, basisAppointmentId: null, basisDelegationId: null,'),
  em('仅供参考不写发送尝试', [T_REF], 'entries.js', `await q.run("INSERT INTO sysbuild_notice_attempts (notice_id, channel, result) VALUES (?, 'platform', 'sent')", [nr.lastID]);`, ''),
  em('conclude 的 kind 不进 target', [T_KINDS], 'entries.js', 'input.kind === null ? {} : { kind: input.kind }', '{}'),
  em('转系统迭代不要求单号', [T_KINDS], 'entries.js', "out.sysIssueNo = readText(body.sys_issue_no, 'sys_issue_no', '系统迭代单号', SYS_ISSUE_MAX, kind === 'to_sys_iteration');", "out.sysIssueNo = readText(body.sys_issue_no, 'sys_issue_no', '系统迭代单号', SYS_ISSUE_MAX, false);"),
  em('转系统迭代 / 留待后续不要求承接说明', [T_KINDS], 'entries.js', "'承接说明', ASSIGNEE_MAX, kind === 'deferred' || kind === 'to_sys_iteration');", "'承接说明', ASSIGNEE_MAX, false);"),
  em('系统迭代单号不限长度', [T_KINDS], 'entries.js', 'const SYS_ISSUE_MAX = 32;', 'const SYS_ISSUE_MAX = 64;'),
  em('单号可用于其他结论类别', [T_KINDS], 'entries.js', "if (out.sysIssueNo !== null && kind !== 'to_sys_iteration') throw invalid(", 'if (false) throw invalid('),
  em('承接说明可用于其他结论类别', [T_KINDS], 'entries.js', "if (out.assigneeText !== null && kind !== 'deferred' && kind !== 'to_sys_iteration') throw invalid(", 'if (false) throw invalid('),
  em('结论说明不必填', [T_KINDS], 'entries.js', "out.text = readText(body.text, 'text', '结论说明', TEXT_MAX, true);", "out.text = readText(body.text, 'text', '结论说明', TEXT_MAX, false);"),
  em('标记 / 作废的原因不必填', [T_MARK, T_VOID], 'entries.js', "out.text = readText(body.reason, 'reason', '原因', REASON_MAX, true);", "out.text = readText(body.reason, 'reason', '原因', REASON_MAX, false);"),
  em('adjudicate 被当作未知动作（办理动作白名单里漏掉）', [T_KINDS], 'entries.js', "const LATER_ACTIONS = Object.freeze(['adjudicate']);", 'const LATER_ACTIONS = Object.freeze([]);'), // S-S1c：link_change 已开放，LATER_ACTIONS 只剩 adjudicate；本条随之改写（原「link_change 被当作未知动作」）
  em('逐对象 actions 不带对象状态', [T_FLAGS], 'entries.js', ': rules.opAllowed(`entry_${a}`, identity, access.project, t);', ': rules.opAllowed(`entry_${a}`, identity, access.project, {});'),
  em('列表不按时段筛选', [T_READ], 'entries.js', "conds.push('period = ?'); params.push(qs.period);", ''),
  em('列表按来源方筛选取反', [T_READ], 'entries.js', "conds.push('source_party_id = ?');", "conds.push('source_party_id <> ?');"),
  em('列表最旧在前', [T_READ], 'entries.js', 'ORDER BY id DESC`, params);', 'ORDER BY id ASC`, params);'),
  em('我的知会不限本人', [T_REF], 'entries.js', 'WHERE m.user_id = ? ORDER BY n.id DESC', 'WHERE ? > 0 ORDER BY n.id DESC'),
  em('知会异议不核接收人身份', [T_REF], 'entries.js', 'isRecipient: recipientUserId !== null && recipientUserId !== undefined && Number(recipientUserId) === Number(uid),', 'isRecipient: true,'),
  em('知会异议不核来源方负责人', [T_REF], 'entries.js', 'objectorBasis: basis,', "objectorBasis: 'source_party',"), // codex 25 M1：target 改为 objectorBasis，锚点随之改写
  { // 重复异议同时被「已异议」标志与登记状态两道判定拦下；两道都拆掉，只剩库内唯一索引兜底（500），重复异议的 409 用例才判红
    id: 'C5 登记：知会异议不记已异议且不核登记状态（只剩唯一索引兜底）', expect: [T_REF],
    edits: [
      { file: 'entries.js', from: 'objected: !!objection,\n      entryVoided:', to: 'objected: false,\n      entryVoided:' },
      { file: 'rules.js', from: "if (t.isLatest !== true || t.entryState !== 'for_reference') return", to: 'if (false) return' },
    ],
  },
  // ── confirm.js / confirm-core.js：结论确认 / 裁定任务的对象分支、决策取值、冻结清单、终止项目、待我确认 ──
  em('结论确认不可代录', [T_PROXY], 'confirm.js', "['package_confirm', 'proposer_confirm', 'conclusion_confirm', 'dev_key_confirm', 'handover_accept_issue', 'handover_no_further']", "['package_confirm', 'proposer_confirm', 'dev_key_confirm', 'handover_accept_issue', 'handover_no_further']"), // S-S1c：清单加了 dev_key_confirm；C6a：再加两个交接确认用途，锚点随之改写
  em('裁定也可代录', [T_ESC], 'confirm.js', "['package_confirm', 'proposer_confirm', 'conclusion_confirm', 'dev_key_confirm', 'handover_accept_issue', 'handover_no_further']", "['package_confirm', 'proposer_confirm', 'conclusion_confirm', 'dev_key_confirm', 'handover_accept_issue', 'handover_no_further', 'adjudicate']"),
  em('结论确认也认不认可', [T_FLOW], 'confirm.js', "conclusion_confirm: Object.freeze(['confirm', 'object']),", "conclusion_confirm: Object.freeze(['confirm', 'object', 'reject']),"),
  em('裁定也认有异议', [T_ESC], 'confirm.js', "adjudicate: Object.freeze(['confirm', 'reject']), dev_key_confirm:", "adjudicate: Object.freeze(['confirm', 'reject', 'object']), dev_key_confirm:"), // S-S1c：表里加了 dev_key_confirm，锚点随之改写
  em('决策不校验任务用途的决策取值', [T_FLOW, T_ESC], 'confirm.js', 'assertEntryTaskDecision(c.task, decision); // C5：办理结论确认只认', '// C5：办理结论确认只认'),
  em('代录不校验任务用途的决策取值', [T_PROXY], 'confirm.js', 'assertEntryTaskDecision(c.task, decision); // C5：办理结论确认的代录同样只认', '// C5：办理结论确认的代录同样只认'),
  em('结论确认的决策按内容包的 accept 类判项目状态', [T_TERM], 'confirm.js', "isEntryTask(task) ? 'entry_conclusion_decide' : 'confirm_decide'", "'confirm_decide'"),
  em('结论确认的代录按内容包的 accept 类判项目状态', [T_PROXY], 'confirm.js', "isEntryTask(task) ? 'entry_conclusion_proxy' : 'confirm_proxy'", "'confirm_proxy'"),
  em('结论确认的改发按内容包的 maintain 类判项目状态', [T_REISSUE], 'confirm.js', "isEntryTask(task) ? 'entry_conclusion_reissue' : 'confirm_reissue'", "'confirm_reissue'"),
  em('办理结论任务代录的历史窗口事实恒缺失', [T_PROXY], 'confirm.js', "if (c.obj.kind === 'conclusion' || c.obj.kind === 'adjudication') return null;", "if (c.obj.kind === 'conclusion' || c.obj.kind === 'adjudication') return undefined;"),
  em('决策比对冻结清单用任务自己的对象类型', [T_FLOW], 'confirm.js', 'const frozenNow = await core.frozenSetOfTask(q, c.task);', 'const frozenNow = await core.frozenSetOf(q, c.task.object_type, c.task.object_version_id);'),
  em('确认页冻结清单用任务自己的对象类型', [T_FLOW], 'confirm.js', 'const frozen = await core.frozenSetOfTask(q, c.task);', 'const frozen = await core.frozenSetOf(q, c.task.object_type, c.task.object_version_id);'),
  em('决策后不回填登记结论状态', [T_FLOW, T_ESC], 'confirm.js', 'result.entry = { id: c.task.object_id, conclusion_state: after ? after.status : null };', 'result.entry = { id: c.task.object_id, conclusion_state: null };'),
  em('改发解析：有代表人授权的任务按负责人任职记依据', [T_REISSUE], 'confirm.js', 'isDelegate: conf.kind === \'delegate\',', 'isDelegate: false,'),
  em('待我确认：办理结论任务也按 accept 类过滤项目状态', [T_TERM], 'confirm-core.js', 'ENTRY_TASK_PURPOSES.includes(rev.purpose) ? info.canResolve : info.canDecide', 'info.canDecide'), // C6b 修订批 1（K1）：判定抽成 confirm-core.confirmAvailabilityBlock，锚点随之换文件
  em('待我确认：resolve 类项目状态恒不可', [T_TERM], 'confirm-core.js', 'canResolve: !!access.project && rules.projectAllowsWrite(access.project.status, rules.OP_KIND.entry_conclusion_decide),', 'canResolve: false,'),
  em('冻结清单映射不识别办理结论任务', [T_FLOW], 'confirm-core.js', "if (task.object_type === 'conclusion' || task.object_type === 'adjudication' || task.object_type === 'dev_entry' || task.object_type === 'handover') return { objectType: 'entry', versionId: task.object_id };", ''), // S-S1c：映射加了 dev_entry，锚点随之改写；C6a：再加 handover
  { // 两张分类表要同时改（只改一张会被加载断言拦下：模块加载即抛，子进程异常，不算检出）
    id: 'C5 登记：终止项目也失效办理结论确认', expect: [T_TERM],
    edits: [
      { file: 'confirm-core.js', from: "'dev_key_confirm', 'handover_accept', 'handover_accept_issue', 'handover_no_further']);", to: "'dev_key_confirm', 'handover_accept', 'handover_accept_issue', 'handover_no_further', 'conclusion_confirm', 'adjudicate']);" },
      { file: 'confirm-core.js', from: "const RETAINED_ON_TERMINATE_PURPOSES = Object.freeze(['conclusion_confirm', 'adjudicate']);", to: 'const RETAINED_ON_TERMINATE_PURPOSES = Object.freeze([]);' },
    ],
  },
  {
    id: 'C5 登记：终止项目不再失效内容包确认', expect: [T_TERM],
    edits: [
      { file: 'confirm-core.js', from: "Object.freeze(['package_confirm', 'proposer_confirm', 'accept_invitation',", to: "Object.freeze(['proposer_confirm', 'accept_invitation'," },
      { file: 'confirm-core.js', from: "const RETAINED_ON_TERMINATE_PURPOSES = Object.freeze(['conclusion_confirm', 'adjudicate']);", to: "const RETAINED_ON_TERMINATE_PURPOSES = Object.freeze(['conclusion_confirm', 'adjudicate', 'package_confirm']);" },
    ],
  },
  // C6a：决策取值校验改按 ENTRY_TASK_DECISIONS 的键判（不再依赖本集合），本集合只剩「项目状态类别走 resolve 类 / accept 类」这一个用途，由终止项目用例判红
  em('任务用途集合漏掉裁定', [T_TERM],'confirm-core.js', "const ENTRY_TASK_PURPOSES = Object.freeze(['conclusion_confirm', 'adjudicate']);", "const ENTRY_TASK_PURPOSES = Object.freeze(['conclusion_confirm']);"),
  // ── 预筛修订批（2026-11-06）：M1 / M2 / L1–L6 / P93–P96 ──
  em('M1 曾被异议的登记仍可再标仅供参考', [T_REF, T_RULES], 'rules.js', "if (t.refObjectedEver === true) return '本登记的仅供参考已被异议，须给结论并经确认';\n      if (t.refObjectedEver !== false) return PROXY_FACT_UNKNOWN_MESSAGE;", ''),
  em('M1 target 的「曾被异议」恒假', [T_REF], 'entries-core.js', 'refObjectedEver: facts.noticeRows.some((nr) => returnedToHandling(nr.objection)),', 'refObjectedEver: false,'), // S-S1b：只认「回到办理」的异议，锚点随之改写
  em('M2 初始承诺标记被取消后仍可标仅供参考', [T_MARK, T_RULES], 'rules.js', "if (t.commitmentInitial === true) return '登记时带「涉及承诺」标记的登记不能标仅供参考';\n      if (t.commitmentInitial !== false) return PROXY_FACT_UNKNOWN_MESSAGE;", ''),
  em('M2 target 的初始承诺标记恒假', [T_MARK], 'entries-core.js', 'commitmentInitial: entry.commitment_flag === 1,', 'commitmentInitial: false,'),
  em('L1 终止分类表的加载断言被去掉', [T_CLASS], 'confirm-core.js', 'assertTerminatePurposeClassification(schema.ENUMS.confirmPurpose, INVALIDATED_ON_TERMINATE_PURPOSES, RETAINED_ON_TERMINATE_PURPOSES);', ''),
  em('L1 终止分类断言放过重复登记', [T_CLASS], 'confirm-core.js', 'if (n !== 1) throw new Error(', 'if (n === 0) throw new Error('),
  em('L1 终止分类断言不查表外用途', [T_CLASS], 'confirm-core.js', 'if (!all.includes(p)) throw new Error(', 'if (false) throw new Error('),
  em('L2 未开放动作不先核权限', [T_KINDS], 'entries.js', "if (!rules.canActAsPm(identity)) throw makeError(403, 'SYSBUILD_FORBIDDEN', '没有权限执行该操作');\n        throw stateError(input.action", 'throw stateError(input.action'),
  // C6b：占位判定已换成 rules.schedule_notice_object（改期知会按来源判资格）；本条改钉在新的资格判定上（锚点随实现更新，id 不变）
  em('L2 非仅供参考类知会的异议不先核资格', [T_REF], 'entries.js', "rules.assertOp('schedule_notice_object', identity, access.project, starget);", ''),
  em('L3 改发不核对象是否仍是当前结论', [T_FLOW, T_RULES], 'rules.js', "if (!(t.objectPending === true)) return '该结论已不是登记的当前结论，不能改发';", ''),
  em('L3 关闭待确认修订不按登记编号限定', [T_FLOW, T_VOID], 'entries-core.js', "WHERE t.object_type IN ('conclusion', 'adjudication') AND t.object_id = ? AND r.status = 'pending' ORDER BY r.id", "WHERE t.object_type IN ('conclusion', 'adjudication') AND ? > 0 AND r.status = 'pending' ORDER BY r.id"),
  em('L4 admin 兼成员写登记不取成员行的参与方', [T_WHO], 'entries.js', '} else if (identity.isPm !== true && identity.memberId !== null && identity.memberId !== undefined) {', '} else if (identity.isPm !== true && identity.isAdmin !== true && identity.memberId !== null && identity.memberId !== undefined) {'),
  em('L5 adjudicate 动作沿用「后续阶段开放」文案', [T_KINDS], 'entries.js', "throw stateError(input.action === 'adjudicate' ? ADJUDICATE_ACTION_MESSAGE : LATER_ACTION_MESSAGE);", 'throw stateError(LATER_ACTION_MESSAGE);'),
  em('L6 知会视图的 actions.object 恒真', [T_REF], 'entries.js', "actions: { object: rules.opAllowed('notice_object', c.identity, c.access.project, target) },", 'actions: { object: true },'),
  em('L6 我的知会不列来源方现任负责人', [T_REF], 'entries.js', "AND a.status = 'active'\n                JOIN sysbuild_members m ON m.id = a.member_id", "AND a.status = 'none'\n                JOIN sysbuild_members m ON m.id = a.member_id"),
  em('L6 来源方负责人的知会标成接收人', [T_REF], 'entries.js', "rows.push(Object.assign({}, r, { as: 'party_owner' }));", "rows.push(Object.assign({}, r, { as: 'recipient' }));"),
  em('P93 确认人解析：登记后才任命的负责人也当作登记人本人', [T_CONFIRMER], 'entries-core.js', 'if (owner && snap.is_pm !== true && snap.is_owner === true && snap.party_id === partyId) {', 'if (owner && snap.is_pm !== true && snap.party_id === partyId) {'),
  em('P94 有未结异议时 PM 也能作废', [T_VOID, T_RULES, T_FLAGS], 'rules.js', "if (ENTRY_OPEN_OBJECTION_STATES.includes(t.conclusionState) && !(t.isRegistrant === true && t.registrantWasPm === false)) return '有未结异议，不能由 PM 作废';", ''),
  em('P94 有未结异议时登记人本人也不能作废', [T_VOID, T_RULES, T_FLAGS], 'rules.js', "if (ENTRY_OPEN_OBJECTION_STATES.includes(t.conclusionState) && !(t.isRegistrant === true && t.registrantWasPm === false)) return", "if (ENTRY_OPEN_OBJECTION_STATES.includes(t.conclusionState)) return"),
  em('M-a PM 代登的登记仍按登记人本人豁免', [T_VOID, T_RULES], 'rules.js', 't.isRegistrant === true && t.registrantWasPm === false)) return', 't.isRegistrant === true)) return'),
  em('M-a target 的「登记时是 PM」恒假', [T_VOID], 'entries-core.js', "return typeof s.is_pm === 'boolean' ? s.is_pm : undefined; })(),", 'return false; })(),'),
  // ── 修订批 2：M-b / M-c ──
  em('M-b 派生不看项目当前状态（项目已终止结论永远有效）', [T_LAPSE, T_RULES], 'entries-core.js', "current.conclusion_kind === 'project_terminated' && projectStatus !== 'terminated') {", "current.conclusion_kind === 'project_terminated' && false) {"),
  em('M-b 派生把任何已确定结论都当作项目已终止结论', [T_LAPSE, T_RULES], 'entries-core.js', "current.conclusion_kind === 'project_terminated' && projectStatus !== 'terminated') {", "projectStatus !== 'terminated') {"),
  em('M-b lapsed 不在可给结论的状态集合', [T_LAPSE, T_RULES], 'rules.js', "'for_reference_objected', 'terminated_conclusion_lapsed', 'to_change_lapsed']);\nconst FOR_REFERENCE_FROM_STATES", "'for_reference_objected', 'to_change_lapsed']);\nconst FOR_REFERENCE_FROM_STATES"),
  em('M-b lapsed 不在可标仅供参考的状态集合', [T_LAPSE, T_RULES], 'rules.js', "Object.freeze(['none', 'pending_confirm', 'objected', 'terminated_conclusion_lapsed', 'to_change_lapsed']);", "Object.freeze(['none', 'pending_confirm', 'objected', 'to_change_lapsed']);"),
  em('M-b lapsed 被算作有效结论', [T_LAPSE, T_RULES], 'rules.js', "const EFFECTIVE_CONCLUSION_STATES = Object.freeze(['settled_no_confirm', 'confirmed', 'adjudicated', 'for_reference']);", "const EFFECTIVE_CONCLUSION_STATES = Object.freeze(['settled_no_confirm', 'confirmed', 'adjudicated', 'for_reference', 'terminated_conclusion_lapsed']);"),
  em('预筛 Q4 状态全集漏掉 to_change_lapsed', [T_RULES], 'rules.js', "'to_change_lapsed',\n  // S-S1b：已拆分容器", '// S-S1b：已拆分容器'),
  em('预筛 Q4 转变更失效不在可标仅供参考的状态集合', [T_RULES], 'rules.js', "'terminated_conclusion_lapsed', 'to_change_lapsed']);\n// 有未结异议的状态", "'terminated_conclusion_lapsed']);\n// 有未结异议的状态"),
  em('预筛 Q4 转变更失效被算作有效结论', [T_RULES], 'rules.js', "const EFFECTIVE_CONCLUSION_STATES = Object.freeze(['settled_no_confirm', 'confirmed', 'adjudicated', 'for_reference']);", "const EFFECTIVE_CONCLUSION_STATES = Object.freeze(['settled_no_confirm', 'confirmed', 'adjudicated', 'for_reference', 'to_change_lapsed']);"),
  em('M-b lapsed 被算作未结异议（PM 不能作废）', [T_LAPSE, T_RULES], 'rules.js', "const ENTRY_OPEN_OBJECTION_STATES = Object.freeze(['objected', 'escalated', 'adjudication_rejected', 'for_reference_objected']);", "const ENTRY_OPEN_OBJECTION_STATES = Object.freeze(['objected', 'escalated', 'adjudication_rejected', 'for_reference_objected', 'terminated_conclusion_lapsed']);"),
  em('M-c 裁定中不放行项目已终止结论', [T_ESCTERM, T_RULES], 'rules.js', "const closeEscalatedByTermination = t.conclusionState === 'escalated' && t.kind === 'project_terminated';", 'const closeEscalatedByTermination = false;'),
  em('M-c 裁定中放行任何结论类别', [T_ESCTERM, T_RULES], 'rules.js', "const closeEscalatedByTermination = t.conclusionState === 'escalated' && t.kind === 'project_terminated';", "const closeEscalatedByTermination = t.conclusionState === 'escalated';"),
  em('M-c 收尾时不替代待确认的裁定修订原因被改', [T_ESCTERM], 'entries-core.js', "const ESCALATED_CLOSED_BY_TERMINATION_REASON = '项目已终止，PM 以项目已终止结论关闭';", "const ESCALATED_CLOSED_BY_TERMINATION_REASON = 'PM 已改结论';"),
  em('M-c 收尾不传裁定修订的专用原因', [T_ESCTERM], 'entries.js', "input.kind === 'project_terminated' ? entries.ESCALATED_CLOSED_BY_TERMINATION_REASON : undefined);", 'undefined);'),
  em('M-c 关闭待确认修订不区分裁定任务的原因', [T_ESCTERM], 'entries-core.js', "const why = row.object_type === 'adjudication' && adjudicationReason !== undefined ? adjudicationReason : reason;", 'const why = reason;'),
  // ── codex 24：M1 / M2 ──
  em('codex24 M1 确认人无账号时仍可标仅供参考', [T_PROXY, T_RULES], 'rules.js', "if (t.confirmerProxyOnly === true) return '确认人没有平台账号，看不到仅供参考知会，请给结论（可代录确认）';\n      return t.confirmerProxyOnly === false ? null : PROXY_FACT_UNKNOWN_MESSAGE;", 'return null;'),
  em('codex24 M1 确认人账号事实没取到时放行（fail-closed 被去掉）', [T_RULES], 'rules.js', 'return t.confirmerProxyOnly === false ? null : PROXY_FACT_UNKNOWN_MESSAGE;', 'return null;'),
  em('codex24 M1 target 的「确认人无账号」恒假', [T_PROXY], 'entries-core.js', 'confirmerProxyOnly: conf.proxyOnly === true,', 'confirmerProxyOnly: false,'),
  em('codex24 M2 conclude_kinds 的判定不带 kind', [T_KINDLIST], 'entries.js', 'Object.assign({}, t, { kind })', 't'),
  em('codex24 M2 actions.conclude 不由 conclude_kinds 推出（不带 kind 的判定）', [T_ESCTERM, T_KINDLIST], 'entries.js', "a === 'conclude' ? out.conclude_kinds.length > 0 :", "a === 'conclude' ? rules.opAllowed('entry_conclude', identity, access.project, t) :"),
  em('codex24 M2 conclude_kinds 漏掉一个类别', [T_KINDLIST, T_FLAGS], 'entries.js', 'schema.ENUMS.conclusionKind.filter((kind) =>', "schema.ENUMS.conclusionKind.filter((kind) => kind !== 'no_further' &&"),
  em('codex24 M2 conclude_kinds 漏掉 to_change（S-S1c 起 to_change 按类别可用性列出）', [T_KINDLIST, T_FLAGS], 'entries.js', 'schema.ENUMS.conclusionKind.filter((kind) =>', "schema.ENUMS.conclusionKind.filter((kind) => kind !== 'to_change' &&"),
  em('P94 未结异议集合漏掉有异议', [T_VOID, T_FLAGS], 'rules.js', "Object.freeze(['objected', 'escalated', 'adjudication_rejected', 'for_reference_objected']);", "Object.freeze(['escalated', 'adjudication_rejected', 'for_reference_objected']);"),
  em('P94 未结异议集合漏掉裁定中', [T_VOID, T_RULES], 'rules.js', "Object.freeze(['objected', 'escalated', 'adjudication_rejected', 'for_reference_objected']);", "Object.freeze(['objected', 'adjudication_rejected', 'for_reference_objected']);"),
  em('P94 未结异议集合漏掉裁定未通过', [T_VOID, T_RULES], 'rules.js', "Object.freeze(['objected', 'escalated', 'adjudication_rejected', 'for_reference_objected']);", "Object.freeze(['objected', 'escalated', 'for_reference_objected']);"),
  em('P94 未结异议集合漏掉仅供参考被异议', [T_VOID, T_RULES], 'rules.js', "Object.freeze(['objected', 'escalated', 'adjudication_rejected', 'for_reference_objected']);", "Object.freeze(['objected', 'escalated', 'adjudication_rejected']);"),
  em('P95 终止项目的项目整体登记判过程登记', [T_STATUS, T_PERIOD, T_ORDER], 'entries-core.js', "const PROJECT_ENDED_STATUSES = Object.freeze(['terminated', 'closed']);", "const PROJECT_ENDED_STATUSES = Object.freeze(['closed']);"),
  em('P95 项目整体登记的天数一律按结项事件', [T_STATUS, T_PERIOD], 'entries-core.js', 'await projectEndedOn(q, project.id, project.status)', "await projectEndedOn(q, project.id, 'closed')"),
  em('P96 项目已终止结论仍要求确认人可解析', [T_KINDS, T_RULES], 'rules.js', "return t.kind === 'project_terminated' ? null : entryConfirmerState(t);", 'return entryConfirmerState(t);'),
  em('P96 项目已终止结论仍建确认任务', [T_TERM, T_KINDS], 'entries.js', "if ((conf.kind === 'owner' || conf.kind === 'delegate') && input.kind !== 'project_terminated') {", "if (conf.kind === 'owner' || conf.kind === 'delegate') {"),
];

module.exports = { defineEntryCases, ENTRY_MUTATIONS };
