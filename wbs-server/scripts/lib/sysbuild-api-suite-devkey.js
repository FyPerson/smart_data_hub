// 验证脚本库：项目管理（系统建设记录）模块 C5 S-S1c——开发方关键事项（dev_entry：处理说明 / 正式交付物 / 来源方为开发方的涉及承诺）与预筛第 3 轮三条 LOW（#113 段 7 C5 S-S1c）的用例与变异
//   方案：docs/local/系统建设记录/系统建设记录_平台集成_方案_20261105_v1.4.md §4.1 表「开发方处理说明」「正式交付物提交」「涉及承诺」「改期记录」行、§4.2「本人提交并确认」、§4.5、§5.2
//   派单：docs/local/系统建设记录/送审准备/C5_S-S1c_正式变更_派单_20261106.md（§2 开发方关键事项；0b 冲突 5；0c 开工第一件）
//
// 本文件只放用例与变异，由 sysbuild-api-suite.js 登记（同一套夹具、同一个变异自检）。期望值一律手写，不取自被测代码。
// 夹具规则：建项、登记、办理动作、认可任务的打开 / 决策 / 代录 / 改发、改期、项目状态转移全部走生产端点；总体规划生效用 produceEffectiveOverall（生产路径）。只有这几类直接写库：
//   ① 参与方、成员（含无账号成员）、任职、授权；② 附件行（暂存）；③ 上线事件（C6 才有生产写入口，时刻写成相对真实时间）与第二批次、规划里追加条目（往已生效版本插修订行，同 routing 套件）；
//   ④ 任务修订创建时间回拨（代录外部日期的下限）；⑤ 一条 kind = schedule_change 的知会（C6 才有生产路径，用来证明 /my/notices 只列仅供参考知会）。
'use strict';
const assert = require('assert');

const P = 'C5 开发方：';
const T_WHO = `${P}写关键事项的权限与来源方`;
const T_TASK = `${P}认可任务`;
const T_SELF = `${P}本人提交并确认`;
const T_DECIDE = `${P}认可与不认可`;
const T_TERM = `${P}项目终止与改发`;
const T_PROXY = `${P}代录`;
const T_REVISE = `${P}修订重提`;
const T_BASIS = `${P}办理依据`;
const T_SCHED = `${P}改期引用`;
const T_COMMIT = `${P}涉及承诺`;
const T_ROUTE = `${P}不进分流`;
const T_VOID = `${P}作废`;
const T_RULES = `${P}rules`;
const Z = 'C5 预筛3轮：';
const T_Z_REG = `${Z}原登记人依据`;
const T_Z_SPLIT = `${Z}拆分子项取消记录事件`;
const T_Z_NOTICE = `${Z}我的知会只列仅供参考`;
const T_Z_ADJ = `${Z}裁定通过不可逆`;
const Y = 'C5 预筛4轮：';
const T_Y_REISSUE = `${Y}认可改发的失效原因与最新任务`;
const T_Y_WASH = `${Y}负责人未认可不能洗掉`;
const T_Y_SELFTEXT = `${Y}本人提交确认文案`;
const T_Y_VOIDKEY = `${Y}被改期引用的关键事项不能作废`;
const T_Y_REVSRC = `${Y}修订重提来源方一致`;
const W = 'C5 修订批3：';
const T_W_REISSUE = `${W}认可后不能改发`;
const T_W_GATE = `${W}终态不能提交认可`;
const T_W_SPLIT = `${W}未认可不能拆分`;

const CB_CONFIRM = '我已阅读以上全部内容，确认无误';
const CB_REJECT = '我已阅读以上全部内容，不认可（原因见下）';
const FLOOR_AT = '2026-10-20 09:00:00';
const OK_DATE = '2026-10-25';
const COMMIT_EV = { no_written_evidence: true, no_evidence_reason: '口头电话确认了本次承诺内容' };

function defineDevKeyCases(T) {
  const { test, U, api, sqlRun, sqlGet, sqlAll, expectErr, eventsOf, addMember, addParty, addAppointment, addDelegation, confirm: H } = T;
  const { newProject, seedParty, stageAtt, openAndDecide, produceEffectiveOverall, mkItem, defaultBatchId } = H;
  const post = (uid, url, body) => api(uid, 'POST', url, body === undefined ? {} : body);
  const get = (uid, url) => api(uid, 'GET', url);
  const countOf = async (s, p) => (await sqlGet(s, p)).n;
  const payloads = async (pid, type) => (await eventsOf(pid, type)).map((e) => JSON.parse(e.payload_json));
  // 某人在某项目里待确认的认可任务（/my/confirmations 跨项目，各用例共用一个库，所以按项目圈定）
  const pendingDev = async (uid, pid) => (await get(uid, '/sysbuild/my/confirmations')).body.items.filter((i) => i.purpose === 'dev_key_confirm' && i.project_id === pid);

  // ── 场景与助手 ─────────────────────────────────────────────────────────────────────────────
  // 标准场景：甲部（需求方）负责人 own、代表人 del、一般成员 m1；开发方负责人 x1、代表人 x2、一般成员 x3；信息技术部内部成员 cand。PM = U.pm。
  async function mkScene(opt) {
    const o = opt || {};
    const pid = o.plan ? await newProject() : await newProject();
    let A;
    let eff = null;
    if (o.plan) {
      eff = await produceEffectiveOverall(pid);
      A = eff.party;
    } else A = (await seedParty(pid, '甲部', U.own, U.del)).party;
    await addMember(pid, U.m1, { party: A });
    const D = await addParty(pid, '开发方', 'dev');
    const mOwn = o.noAccountOwner
      ? (await sqlRun("INSERT INTO sysbuild_members (project_id, party_id, user_id, person_name, joined_at, added_by) VALUES (?, ?, NULL, '无账号开发负责人', '2026-10-01 10:00:00', ?)", [pid, D, U.pm])).lastID
      : await addMember(pid, U.x1, { party: D });
    const apt = o.noOwner ? null : await addAppointment(D, mOwn, 'active');
    const mDel = await addMember(pid, U.x2, { party: D });
    if (apt !== null) await addDelegation(D, mDel, apt, 'active');
    await addMember(pid, U.x3, { party: D });
    await addMember(pid, U.cand);
    return { pid, A, D, mOwn, apt, mDel, eff };
  }
  // 预筛 Q2：开发方负责人本人登记需认可的事项必须带固定确认文案（self_confirm_text）；其余身份带了也被忽略，所以助手默认都带，缺失 / 不等的用例用 extra 覆盖（undefined 即不带）
  const regDev = (uid, pid, extra) => post(uid, `/sysbuild/projects/${pid}/entries`, Object.assign({ type: 'note', purpose: 'dev_note', title: '开发方处理说明', body: '已按需求完成开发', self_confirm_text: CB_CONFIRM }, extra || {}));
  async function regDevOk(uid, pid, extra) {
    const r = await regDev(uid, pid, extra);
    assert.strictEqual(r.status, 201, r.text);
    return r.body.entry;
  }
  const reg = (uid, pid, extra) => post(uid, `/sysbuild/projects/${pid}/entries`, Object.assign({ type: 'feedback', title: '标题', body: '内容', self_confirm_text: CB_CONFIRM }, extra || {}));
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
  const devTask = (eid) => sqlGet(
    `SELECT t.id AS tid, t.object_type AS object_type, t.object_id AS object_id, t.object_version_id AS object_version_id, t.purpose AS purpose, t.party_id AS party_id,
            r.id AS rid, r.rev_no AS rev_no, r.status AS status, r.status_reason AS reason, r.required_member_id AS mid, r.basis_appointment_id AS apt, r.basis_delegation_id AS dlg, m.user_id AS uid
       FROM sysbuild_confirm_tasks t JOIN sysbuild_confirm_task_revisions r ON r.task_id = t.id JOIN sysbuild_members m ON m.id = r.required_member_id
      WHERE t.object_type = 'dev_entry' AND t.object_id = ? AND r.rev_no = (SELECT MAX(r2.rev_no) FROM sysbuild_confirm_task_revisions r2 WHERE r2.task_id = t.id) ORDER BY t.id DESC LIMIT 1`,
    [eid]
  );
  const devTaskCount = (eid) => countOf("SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE object_type = 'dev_entry' AND object_id = ?", [eid]);
  const frozenOfEntry = (eid) => sqlAll("SELECT attachment_id, sha256 FROM sysbuild_frozen_attachments WHERE object_type = 'entry' AND object_version_id = ? ORDER BY attachment_id", [eid]);
  const decideBody = (rid, eid, decision) => Object.assign({ revision_id: rid, object_version_id: eid, decision, checkbox_text: decision === 'confirm' ? CB_CONFIRM : CB_REJECT }, decision === 'confirm' ? {} : { reason: '内容与实际不符' });
  const setStatus = (pid, to) => post(U.admin, `/sysbuild/projects/${pid}/status`, { to, reason: '开发方关键事项用例' });
  const backdate = (rid) => sqlRun('UPDATE sysbuild_confirm_task_revisions SET created_at = ? WHERE id = ?', [FLOOR_AT, rid]);
  const nodeId = async (pid, key) => (await sqlGet('SELECT id FROM sysbuild_nodes WHERE project_id = ? AND template_key = ?', [pid, key])).id;
  // 上线事件夹具（C6 才有生产写入口）：时刻相对真实时间
  const golive = (batch) => sqlRun("INSERT INTO sysbuild_golive_events (batch_id, kind, handover_snapshot_json, created_by, created_at) VALUES (?, 'golive', '{}', ?, datetime('now','localtime','-1 hour'))", [batch, U.pm]);

  // ═══════════════════════ 1 权限与来源方 ═══════════════════════
  test(`${T_WHO}——purpose = dev_note / deliverable：开发方负责人、开发方代表人、PM 代登可写（来源方必须是开发方），其他人（开发方一般成员、需求方、内部成员、只读账号、admin 未接管）403、非成员 404；PM 不填 / 填需求方来源 400；正式交付物必有附件；项目状态类别 accept（暂停可、已终止 409）；开发方暂无负责人 409 且不留登记`, async () => {
    const s = await mkScene();
    const e1 = await regDevOk(U.x1, s.pid);
    assert.deepStrictEqual([e1.purpose, e1.source_party_id, e1.operator_identity.is_owner, e1.type], ['dev_note', s.D, true, 'note'], '开发方负责人：来源方取其成员行的开发方');
    const e2 = await regDevOk(U.x2, s.pid);
    assert.deepStrictEqual([e2.source_party_id, e2.operator_identity.is_delegate], [s.D, true], '开发方代表人');
    const e3 = await regDevOk(U.pm, s.pid, { source_party_id: s.D });
    assert.deepStrictEqual([e3.source_party_id, e3.operator_identity.is_pm], [s.D, true], 'PM 代登');
    for (const [uid, label] of [[U.x3, '开发方一般成员'], [U.own, '需求方负责人'], [U.del, '需求方代表人'], [U.m1, '需求方一般成员'], [U.cand, '内部成员'], [U.ro, '只读账号'], [U.admin, 'admin 未接管']]) {
      expectErr(await regDev(uid, s.pid), 403, 'SYSBUILD_FORBIDDEN', label);
    }
    expectErr(await regDev(U.out, s.pid), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_entries WHERE project_id = ? AND purpose <> 'general'", [s.pid]), 3, '被拒的不留行');
    // PM 代登的来源方必须是开发方
    const noSrc = await regDev(U.pm, s.pid);
    expectErr(noSrc, 400, 'SYSBUILD_INVALID_INPUT', 'PM 不填来源方');
    assert.strictEqual(noSrc.body.field, 'source_party_id');
    expectErr(await regDev(U.pm, s.pid, { source_party_id: s.A }), 400, 'SYSBUILD_INVALID_INPUT', 'PM 填需求方来源');
    // 一般用途不受影响：开发方一般成员、需求方成员照常登记
    assert.strictEqual((await reg(U.x3, s.pid)).status, 201, '一般用途：开发方一般成员可写');
    // 正式交付物必有附件；「无书面证据」不能代替附件
    const noAtt = await regDev(U.x1, s.pid, { purpose: 'deliverable' });
    expectErr(noAtt, 400, 'SYSBUILD_EVIDENCE_REQUIRED', '交付物无附件');
    expectErr(await regDev(U.x1, s.pid, Object.assign({ purpose: 'deliverable' }, COMMIT_EV)), 400, 'SYSBUILD_EVIDENCE_REQUIRED', '无书面证据不能代替附件');
    const att = await stageAtt(s.pid, U.x1, '4');
    const d1 = await regDevOk(U.x1, s.pid, { purpose: 'deliverable', attachment_ids: [att] });
    assert.deepStrictEqual([d1.purpose, d1.attachments.length], ['deliverable', 1]);
    assert.strictEqual((await regDev(U.x1, s.pid, { purpose: 'dev_note', attachment_ids: [] })).status, 201, '处理说明可以没有附件');
    // 开发方暂无负责人 → 409，整笔回滚不留登记
    const s2 = await mkScene({ noOwner: true });
    const nOwner = await regDev(U.pm, s2.pid, { source_party_id: s2.D });
    expectErr(nOwner, 409, 'SYSBUILD_STATE', '开发方暂无负责人');
    assert.ok(nOwner.body.message.includes('开发方暂无负责人'), nOwner.body.message);
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE project_id = ?', [s2.pid]), 0, '回滚：不留登记');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE project_id = ?', [s2.pid]), 0, '回滚：不留任务');
    // 项目状态：暂停可写；已终止 409（需要负责人认可，已终止不能作出认可）
    assert.strictEqual((await setStatus(s.pid, 'paused')).status, 200);
    assert.strictEqual((await regDev(U.x1, s.pid)).status, 201, '暂停可写');
    assert.strictEqual((await setStatus(s.pid, 'active')).status, 200);
    assert.strictEqual((await setStatus(s.pid, 'terminated')).status, 200);
    expectErr(await regDev(U.x1, s.pid), 409, 'SYSBUILD_PROJECT_READONLY', '已终止');
    expectErr(await regDev(U.x3, s.pid), 403, 'SYSBUILD_FORBIDDEN', '已终止：没有权限的人仍先 403');
    assert.strictEqual((await reg(U.m1, s.pid, { type: 'note' })).status, 201, '已终止：一般用途的补充登记照常');
  });

  // ═══════════════════════ 2 认可任务 ═══════════════════════
  test(`${T_TASK}——需要开发方负责人认可的登记同一事务建任务：object_type dev_entry、object_id = object_version_id = 登记编号、purpose dev_key_confirm、party = 开发方、必需确认人 = 开发方现任负责人（依据任职）；冻结登记附件；读接口 dev_confirm 带状态与标签`, async () => {
    const s = await mkScene();
    const att = await stageAtt(s.pid, U.x2, '5');
    const e = await regDevOk(U.x2, s.pid, { attachment_ids: [att], type: 'issue' });
    const t = await devTask(e.id);
    assert.deepStrictEqual([t.object_type, t.object_id, t.object_version_id, t.purpose, t.party_id, t.rev_no, t.status, t.mid, t.apt, t.dlg, t.uid],
      ['dev_entry', e.id, e.id, 'dev_key_confirm', s.D, 1, 'pending', s.mOwn, s.apt, null, U.x1], '必需确认人 = 开发方现任负责人（依据任职，不是代表人）');
    assert.deepStrictEqual((await frozenOfEntry(e.id)).map((f) => [f.attachment_id, f.sha256]), [[att, '5'.repeat(64)]], '冻结登记附件');
    const d = await detail(U.pm, e.id);
    assert.deepStrictEqual([d.dev_confirm.required, d.dev_confirm.status, d.dev_confirm.label, d.dev_confirm.task_id, d.dev_confirm.required_member_id, d.dev_confirm.revised_by_entry_ids], [true, 'pending', '待开发方负责人认可', t.tid, s.mOwn, []]);
    // 事件：任务建立
    const ev = (await payloads(s.pid, 'confirm_task_created')).filter((p) => p.object_type === 'dev_entry' && p.object_id === e.id);
    assert.deepStrictEqual(ev.map((p) => [p.purpose, p.party_id, p.required_member_id, p.basis_appointment_id, p.object_version_id]), [['dev_key_confirm', s.D, s.mOwn, s.apt, e.id]]);
    // 一般用途的登记不建任务、dev_confirm 不需要
    const g = await regOk(U.m1, s.pid);
    assert.deepStrictEqual([g.dev_confirm.required, g.dev_confirm.status, g.dev_confirm.label, g.dev_confirm.task_id], [false, 'none', '未建认可任务', null]);
    assert.strictEqual(await devTaskCount(g.id), 0);
    // 登记人是代表人 / PM 代登：都不是「本人提交并确认」，待负责人认可
    const e3 = await regDevOk(U.pm, s.pid, { source_party_id: s.D });
    assert.strictEqual((await devTask(e3.id)).status, 'pending', 'PM 代登待认可');
    // 任务在 /my/confirmations 里列给负责人（accept 类：进行中列出）
    const mine = await pendingDev(U.x1, s.pid);
    assert.deepStrictEqual(mine.map((i) => [i.object_type, i.object_id, i.party_id]).sort((a, b) => a[1] - b[1]), [['dev_entry', e.id, s.D], ['dev_entry', e3.id, s.D]]);
  });

  // ═══════════════════════ 3 本人提交并确认 ═══════════════════════
  test(`${T_SELF}——登记人就是开发方现任负责人：同一事务写浏览记录（source self_submit，冻结清单照实记）+ 平台确认记录（确认，固定勾选文案），修订当场已确认，不留待确认；负责人的 PM 代登 / 代表人登记不适用`, async () => {
    const s = await mkScene();
    const att = await stageAtt(s.pid, U.x1, '6');
    const e = await regDevOk(U.x1, s.pid, { attachment_ids: [att] });
    const t = await devTask(e.id);
    assert.deepStrictEqual([t.status, t.rev_no, t.uid], ['confirmed', 1, U.x1], '修订当场已确认');
    const v = await sqlAll("SELECT user_id, object_type, object_version_id, source, frozen_attachment_set FROM sysbuild_views WHERE object_type = 'dev_entry' AND object_version_id = ?", [e.id]);
    assert.deepStrictEqual(v.map((x) => [x.user_id, x.source, JSON.parse(x.frozen_attachment_set)]), [[U.x1, 'self_submit', [{ attachment_id: att, sha256: '6'.repeat(64) }]]], '浏览记录：本人、self_submit、冻结清单');
    const cf = await sqlAll('SELECT task_revision_id, object_type, object_version_id, actor_user_id, method, decision, checkbox_text, view_id FROM sysbuild_confirmations WHERE task_revision_id = ?', [t.rid]);
    assert.deepStrictEqual(cf.map((c) => [c.object_type, c.object_version_id, c.actor_user_id, c.method, c.decision, c.checkbox_text]), [['dev_entry', e.id, U.x1, 'platform', 'confirm', CB_CONFIRM]]);
    assert.strictEqual(cf[0].view_id !== null, true);
    const d = await detail(U.pm, e.id);
    assert.deepStrictEqual([d.dev_confirm.status, d.dev_confirm.label], ['approved', '已认可']);
    assert.strictEqual((await pendingDev(U.x1, s.pid)).length, 0, '没有待确认');
    const ev = (await payloads(s.pid, 'confirmation_recorded')).filter((p) => p.object_type === 'dev_entry');
    assert.deepStrictEqual(ev.map((p) => [p.decision, p.method, p.self_submit]), [['confirm', 'platform', true]]);
    // 代表人登记 / PM 代登：待认可，不是本人提交并确认
    assert.strictEqual((await devTask((await regDevOk(U.x2, s.pid)).id)).status, 'pending');
    assert.strictEqual((await devTask((await regDevOk(U.pm, s.pid, { source_party_id: s.D })).id)).status, 'pending');
  });

  // ═══════════════════════ 4 认可与不认可 ═══════════════════════
  test(`${T_DECIDE}——负责人打开任务（写浏览记录）后认可 / 不认可（有异议 400）：认可 → 已认可；不认可 → 「负责人未认可」，登记保留；未浏览 409 NOT_VIEWED；非必需确认人 403；决策后不再 pending；暂停可决策；确认页对象带登记内容与冻结附件`, async () => {
    const s = await mkScene();
    const att = await stageAtt(s.pid, U.x2, '7');
    const e = await regDevOk(U.x2, s.pid, { attachment_ids: [att], title: '交付说明', body: '交付物已部署到测试环境' });
    const t = await devTask(e.id);
    const url = `/sysbuild/confirm-tasks/${t.tid}/decide`;
    // 未浏览 409；非必需确认人 403
    expectErr(await post(U.x1, url, decideBody(t.rid, e.id, 'confirm')), 409, 'SYSBUILD_NOT_VIEWED', '未浏览');
    expectErr(await post(U.x2, url, decideBody(t.rid, e.id, 'confirm')), 403, 'SYSBUILD_FORBIDDEN', '代表人不是必需确认人');
    // 打开任务：确认页对象 = 登记原文与来源，冻结附件清单带出
    const o = await get(U.x1, `/sysbuild/confirm-tasks/${t.tid}`);
    assert.strictEqual(o.status, 200, o.text);
    assert.deepStrictEqual([o.body.task.object_type, o.body.task.purpose, o.body.object.type, o.body.object.entry.id, o.body.object.entry.title, o.body.object.entry.body, o.body.object.voided, o.body.object.dev_confirm_state],
      ['dev_entry', 'dev_key_confirm', 'dev_entry', e.id, '交付说明', '交付物已部署到测试环境', false, 'pending']);
    assert.deepStrictEqual(o.body.frozen_attachments.map((f) => [f.attachment_id, f.sha256]), [[att, '7'.repeat(64)]]);
    assert.strictEqual(o.body.actions.decide, true);
    assert.strictEqual((await get(U.pm, `/sysbuild/confirm-tasks/${t.tid}`)).body.actions.decide, false, 'PM 看到的标志：不是必需确认人');
    // 有异议 400（只认可 / 不认可）；勾选文案按决策严格匹配
    const bad = await post(U.x1, url, Object.assign(decideBody(t.rid, e.id, 'confirm'), { decision: 'object', checkbox_text: '我已阅读以上全部内容，对其有异议（原因见下）', reason: '有意见' }));
    expectErr(bad, 400, 'SYSBUILD_INVALID_INPUT', '有异议');
    assert.strictEqual(bad.body.field, 'decision');
    // 暂停可决策（accept 类）
    assert.strictEqual((await setStatus(s.pid, 'paused')).status, 200);
    const ok = await post(U.x1, url, decideBody(t.rid, e.id, 'confirm'));
    assert.strictEqual(ok.status, 200, ok.text);
    assert.deepStrictEqual([ok.body.entry, ok.body.revision.status], [{ id: e.id, dev_confirm: 'approved' }, 'confirmed']);
    assert.strictEqual((await setStatus(s.pid, 'active')).status, 200);
    assert.strictEqual((await detail(U.pm, e.id)).dev_confirm.label, '已认可');
    expectErr(await post(U.x1, url, decideBody(t.rid, e.id, 'confirm')), 409, 'SYSBUILD_STATE', '已处理的修订不能再决策');
    // 不认可：负责人未认可，登记保留
    const e2 = await regDevOk(U.x2, s.pid, { title: '另一条说明' });
    const t2 = await devTask(e2.id);
    await get(U.x1, `/sysbuild/confirm-tasks/${t2.tid}`);
    const rj = await post(U.x1, `/sysbuild/confirm-tasks/${t2.tid}/decide`, decideBody(t2.rid, e2.id, 'reject'));
    assert.strictEqual(rj.status, 200, rj.text);
    assert.deepStrictEqual([rj.body.entry.dev_confirm, rj.body.revision.status], ['not_approved', 'rejected']);
    const d2 = await detail(U.pm, e2.id);
    assert.deepStrictEqual([d2.dev_confirm.status, d2.dev_confirm.label, d2.voided, d2.title], ['not_approved', '负责人未认可', false, '另一条说明'], '登记保留，标「负责人未认可」');
    const cfs = await sqlAll('SELECT decision, method, reason FROM sysbuild_confirmations WHERE task_revision_id = ?', [t2.rid]);
    assert.deepStrictEqual(cfs.map((c) => [c.decision, c.method, c.reason]), [['reject', 'platform', '内容与实际不符']]);
    // 不认可的任务不再出现在待办里；改发（不认可后 objectStatus 已 settled）409
    assert.strictEqual((await pendingDev(U.x1, s.pid)).length, 0);
    expectErr(await post(U.pm, `/sysbuild/confirm-tasks/${t2.tid}/reissue`, { reason: '想再发一次' }), 409, 'SYSBUILD_STATE', '不认可后不改发，出路是修订重提');
  });

  // ═══════════════════════ 5 项目终止与改发 ═══════════════════════
  test(`${T_TERM}——认可属「作出推进类确认」：项目终止时待确认的认可修订失效（dev_key_confirm 在失效表），/my/confirmations 不列；重开后 PM 改发接上（重新解析当前负责人），负责人认可；已认可的不受终止影响；开发方负责人更换后改发给新负责人`, async () => {
    const s = await mkScene();
    const e = await regDevOk(U.x2, s.pid);
    const done = await regDevOk(U.x1, s.pid, { title: '已自认可' });
    const t = await devTask(e.id);
    assert.strictEqual((await setStatus(s.pid, 'terminated')).status, 200);
    const lapsed = await devTask(e.id);
    assert.deepStrictEqual([lapsed.status, lapsed.reason], ['invalid', '项目已终止']);
    assert.strictEqual((await detail(U.pm, e.id)).dev_confirm.status, 'lapsed');
    assert.strictEqual((await detail(U.pm, done.id)).dev_confirm.status, 'approved', '已认可的不受终止影响');
    assert.strictEqual((await pendingDev(U.x1, s.pid)).length, 0, '终止后不列');
    // 终止期间不能决策 / 改发 / 代录（accept / maintain 类）
    const o = await get(U.x1, `/sysbuild/confirm-tasks/${t.tid}`);
    assert.strictEqual(o.status, 200);
    expectErr(await post(U.x1, `/sysbuild/confirm-tasks/${t.tid}/decide`, decideBody(lapsed.rid, e.id, 'confirm')), 409, 'SYSBUILD_PROJECT_READONLY', '终止期间决策');
    expectErr(await post(U.pm, `/sysbuild/confirm-tasks/${t.tid}/reissue`, { reason: '终止期间' }), 409, 'SYSBUILD_PROJECT_READONLY', '终止期间改发');
    // 重开 → PM 改发 → 负责人认可
    assert.strictEqual((await setStatus(s.pid, 'active')).status, 200);
    const rs = await post(U.pm, `/sysbuild/confirm-tasks/${t.tid}/reissue`, { reason: '项目重开，重新发起认可' });
    assert.strictEqual(rs.status, 200, rs.text);
    assert.deepStrictEqual([rs.body.revision.rev_no, rs.body.revision.status, rs.body.revision.required_member_id], [2, 'pending', s.mOwn]);
    assert.strictEqual((await detail(U.pm, e.id)).dev_confirm.status, 'pending');
    expectErr(await post(U.x3, `/sysbuild/confirm-tasks/${t.tid}/reissue`, { reason: 'x' }), 403, 'SYSBUILD_FORBIDDEN', '非 PM 不能改发');
    // 负责人更换：旧负责人任职结束，新任职 x3 → 改发给新负责人
    await sqlRun("UPDATE sysbuild_appointments SET status = 'ended', ended_at = '2026-10-30 10:00:00', end_reason = '换人' WHERE id = ?", [s.apt]);
    await sqlRun("UPDATE sysbuild_delegations SET status = 'revoked', revoked_at = '2026-10-30 10:00:00', revoke_reason = '换人' WHERE party_id = ? AND status = 'active'", [s.D]);
    const m3 = await sqlGet('SELECT id FROM sysbuild_members WHERE project_id = ? AND user_id = ? AND removed_at IS NULL', [s.pid, U.x3]);
    await addAppointment(s.D, m3.id, 'active');
    const rs2 = await post(U.pm, `/sysbuild/confirm-tasks/${t.tid}/reissue`, { reason: '负责人更换' });
    assert.strictEqual(rs2.status, 200, rs2.text);
    assert.deepStrictEqual([rs2.body.revision.rev_no, rs2.body.revision.required_member_id], [3, m3.id], '改发给新的现任负责人');
    await get(U.x3, `/sysbuild/confirm-tasks/${t.tid}`);
    const cur = await devTask(e.id);
    const fin = await post(U.x3, `/sysbuild/confirm-tasks/${t.tid}/decide`, decideBody(cur.rid, e.id, 'confirm'));
    assert.strictEqual(fin.status, 200, fin.text);
    assert.strictEqual((await detail(U.pm, e.id)).dev_confirm.status, 'approved');
  });

  // ═══════════════════════ 6 代录 ═══════════════════════
  test(`${T_PROXY}——开发方负责人没有平台账号：认可任务只能由 PM 代录（凭据附件 + 外部确认日期 + 实际确认人 + 身份依据），有异议 400（只认可 / 不认可），平台决策不可；已终止 409；代录确认计入「已认可」`, async () => {
    const s = await mkScene({ noAccountOwner: true });
    const e = await regDevOk(U.x2, s.pid);
    const t = await devTask(e.id);
    assert.strictEqual(t.uid, null, '必需确认人是无账号成员');
    const prx = async (decision, extra) => Object.assign({
      revision_id: t.rid, object_version_id: e.id, decision, external_date: OK_DATE, actual_confirmer: '无账号开发负责人', identity_basis: '开发方负责人，邮件确认记录', attachment_ids: [await stageAtt(s.pid, U.pm, '8')],
    }, decision === 'confirm' ? {} : { reason: '与实际不符' }, extra || {});
    await backdate(t.rid);
    const gd = await get(U.pm, `/sysbuild/confirm-tasks/${t.tid}`);
    assert.deepStrictEqual([gd.body.actions.proxy, gd.body.actions.decide, gd.body.revision.proxy_only], [true, false, true]);
    expectErr(await post(U.pm, `/sysbuild/confirm-tasks/${t.tid}/proxy`, await prx('object')), 400, 'SYSBUILD_INVALID_INPUT', '代录有异议');
    expectErr(await post(U.x2, `/sysbuild/confirm-tasks/${t.tid}/proxy`, await prx('confirm')), 403, 'SYSBUILD_FORBIDDEN', '非 PM 不能代录');
    // 已终止 409（accept 类）
    assert.strictEqual((await setStatus(s.pid, 'terminated')).status, 200);
    assert.strictEqual((await setStatus(s.pid, 'active')).status, 200);
    const t2 = await devTask(e.id);
    assert.strictEqual(t2.status, 'invalid', '终止时已失效');
    const rs = await post(U.pm, `/sysbuild/confirm-tasks/${t.tid}/reissue`, { reason: '重新发起' });
    assert.strictEqual(rs.status, 200, rs.text);
    const t3 = await devTask(e.id);
    await backdate(t3.rid);
    assert.strictEqual((await setStatus(s.pid, 'terminated')).status, 200);
    expectErr(await post(U.pm, `/sysbuild/confirm-tasks/${t.tid}/proxy`, await prx('confirm', { revision_id: t3.rid })), 409, 'SYSBUILD_PROJECT_READONLY', '已终止代录');
    assert.strictEqual((await setStatus(s.pid, 'active')).status, 200);
    const rs2 = await post(U.pm, `/sysbuild/confirm-tasks/${t.tid}/reissue`, { reason: '再次重新发起' });
    assert.strictEqual(rs2.status, 200, rs2.text);
    const t4 = await devTask(e.id);
    await backdate(t4.rid);
    const ok = await post(U.pm, `/sysbuild/confirm-tasks/${t.tid}/proxy`, await prx('confirm', { revision_id: t4.rid }));
    assert.strictEqual(ok.status, 200, ok.text);
    assert.deepStrictEqual([ok.body.method, ok.body.entry.dev_confirm, ok.body.decision], ['proxy', 'approved', 'confirm']);
    const cf = await sqlAll('SELECT method, decision, actor_user_id, actual_confirmer, external_date, proxy_by FROM sysbuild_confirmations WHERE task_revision_id = ?', [t4.rid]);
    assert.deepStrictEqual(cf.map((c) => [c.method, c.decision, c.actor_user_id, c.actual_confirmer, c.external_date, c.proxy_by]), [['proxy', 'confirm', null, '无账号开发负责人', OK_DATE, U.pm]]);
    // 不认可也可代录
    const e2 = await regDevOk(U.x2, s.pid);
    const u2 = await devTask(e2.id);
    await backdate(u2.rid);
    const rj = await post(U.pm, `/sysbuild/confirm-tasks/${u2.tid}/proxy`, await prx('reject', { revision_id: u2.rid, object_version_id: e2.id }));
    assert.strictEqual(rj.status, 200, rj.text);
    assert.strictEqual(rj.body.entry.dev_confirm, 'not_approved');
  });

  // ═══════════════════════ 7 修订重提 ═══════════════════════
  test(`${T_REVISE}——负责人未认可后修订重提 = 新登记 + revision_of_entry_id，旧登记保留（读接口 revised_by_entry_ids 指回）；只对「负责人未认可」的旧登记（待认可 / 已认可 / 不存在 / 别的项目 409 / 400），用途须一致；与异议对象 / 拆分来源互斥`, async () => {
    const s = await mkScene();
    const old = await regDevOk(U.x2, s.pid, { title: '第一版说明' });
    const to = await devTask(old.id);
    // 待认可 → 不能重提
    expectErr(await regDev(U.x2, s.pid, { revision_of_entry_id: old.id, title: '第二版说明' }), 409, 'SYSBUILD_STATE', '待认可不能重提');
    await get(U.x1, `/sysbuild/confirm-tasks/${to.tid}`);
    assert.strictEqual((await post(U.x1, `/sysbuild/confirm-tasks/${to.tid}/decide`, decideBody(to.rid, old.id, 'reject'))).status, 200);
    // 用途不一致 400；别项目 / 不存在 400；一般登记（无认可）409
    const other = await mkScene();
    const foreign = await regDevOk(U.x1, other.pid);
    expectErr(await regDev(U.x2, s.pid, { revision_of_entry_id: old.id, purpose: 'deliverable', attachment_ids: [await stageAtt(s.pid, U.x2, '9')] }), 400, 'SYSBUILD_INVALID_INPUT', '用途不一致');
    const fe = await regDev(U.x2, s.pid, { revision_of_entry_id: foreign.id });
    expectErr(fe, 400, 'SYSBUILD_INVALID_INPUT', '别项目的登记');
    assert.strictEqual(fe.body.field, 'revision_of_entry_id');
    expectErr(await regDev(U.x2, s.pid, { revision_of_entry_id: 99999999 }), 400, 'SYSBUILD_INVALID_INPUT', '不存在');
    const gen = await regOk(U.m1, s.pid);
    expectErr(await reg(U.m1, s.pid, { revision_of_entry_id: gen.id, purpose: 'general' }), 409, 'SYSBUILD_STATE', '没有认可记录的登记不能重提');
    // 与异议对象互斥：异议登记只认几个键，revision_of_entry_id 不在其中
    expectErr(await post(U.m1, `/sysbuild/projects/${s.pid}/entries`, { objects_entry_id: gen.id, revision_of_entry_id: old.id, body: 'x' }), 400, 'SYSBUILD_INVALID_INPUT', '异议与重提并存');
    // 修订重提：新登记自己建任务；旧登记保留且标记被修订
    const nv = await regDevOk(U.x2, s.pid, { revision_of_entry_id: old.id, title: '第二版说明' });
    assert.strictEqual(nv.revision_of_entry_id, old.id);
    assert.strictEqual((await devTask(nv.id)).status, 'pending', '新登记待认可');
    const od = await detail(U.pm, old.id);
    assert.deepStrictEqual([od.dev_confirm.status, od.dev_confirm.revised_by_entry_ids, od.voided, od.title], ['not_approved', [nv.id], false, '第一版说明'], '旧登记保留');
    assert.deepStrictEqual(await sqlGet('SELECT parent_entry_id AS p, objects_entry_id AS o, revision_of_entry_id AS r FROM sysbuild_entries WHERE id = ?', [nv.id]), { p: null, o: null, r: old.id });
    assert.deepStrictEqual((await payloads(s.pid, 'entry_created')).filter((p) => p.revision_of_entry_id === old.id).length, 1, '事件带 revision_of_entry_id');
    // 新版本被认可后，旧登记仍是「负责人未认可」；已认可的登记不能再重提
    await get(U.x1, `/sysbuild/confirm-tasks/${(await devTask(nv.id)).tid}`);
    const tn = await devTask(nv.id);
    assert.strictEqual((await post(U.x1, `/sysbuild/confirm-tasks/${tn.tid}/decide`, decideBody(tn.rid, nv.id, 'confirm'))).status, 200);
    expectErr(await regDev(U.x2, s.pid, { revision_of_entry_id: nv.id }), 409, 'SYSBUILD_STATE', '已认可不能重提');
  });

  // ═══════════════════════ 8 办理依据 ═══════════════════════
  test(`${T_BASIS}——登记结论可选办理依据 = 已认可的开发方处理说明登记（basis_kind dev_note_version + basis_ref）：未认可 / 已作废 409，别项目 / 不是处理说明 / 自己 400；被引用的处理说明不能作废`, async () => {
    const s = await mkScene();
    const other = await mkScene();
    const note = await regDevOk(U.x1, s.pid, { title: '处理说明（自认可）' }); // 本人提交并确认 = 已认可
    const pending = await regDevOk(U.x2, s.pid, { title: '待认可的说明' });
    const rejected = await regDevOk(U.x2, s.pid, { title: '不认可的说明' });
    const tr = await devTask(rejected.id);
    await get(U.x1, `/sysbuild/confirm-tasks/${tr.tid}`);
    assert.strictEqual((await post(U.x1, `/sysbuild/confirm-tasks/${tr.tid}/decide`, decideBody(tr.rid, rejected.id, 'reject'))).status, 200);
    const deliver = await regDevOk(U.x1, s.pid, { purpose: 'deliverable', attachment_ids: [await stageAtt(s.pid, U.x1, 'a')] });
    const foreign = await regDevOk(U.x1, other.pid);
    const voided = await regDevOk(U.x1, s.pid, { title: '作废的说明' });
    assert.strictEqual((await act(U.x1, voided.id, { action: 'void', reason: '写错了' })).status, 201);
    const CONC = (extra) => Object.assign({ action: 'conclude', conclusion_kind: 'handled', text: '已处理，见开发方说明' }, extra || {});
    const iss = await regOk(U.m1, s.pid, { type: 'issue' });
    // 未认可（待认可 / 不认可）/ 已作废 → 409；别项目 / 交付物 / 不存在 → 400
    for (const [id, label] of [[pending.id, '待认可'], [rejected.id, '负责人未认可'], [voided.id, '已作废']]) {
      const r = await act(U.pm, iss.id, CONC({ basis_dev_note_entry_id: id }));
      expectErr(r, 409, 'SYSBUILD_STATE', label);
      assert.ok(r.body.message.includes('办理依据未认可'), r.body.message);
    }
    for (const [id, label] of [[foreign.id, '别项目的登记'], [deliver.id, '正式交付物不是处理说明'], [99999999, '不存在']]) {
      const r = await act(U.pm, iss.id, CONC({ basis_dev_note_entry_id: id }));
      expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', label);
      assert.strictEqual(r.body.field, 'basis_dev_note_entry_id', label);
    }
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_entry_actions WHERE entry_id = ?', [iss.id]), 0, '被拒不留办理记录');
    // 成功：已认可的处理说明
    assert.ok((await detail(U.pm, note.id)).dev_confirm.status === 'approved');
    const ok = await act(U.pm, iss.id, CONC({ basis_dev_note_entry_id: note.id }));
    assert.strictEqual(ok.status, 201, ok.text);
    assert.deepStrictEqual([ok.body.entry.current_conclusion.basis_kind, ok.body.entry.current_conclusion.basis_ref], ['dev_note_version', note.id]);
    const row = await sqlGet("SELECT basis_kind, basis_ref FROM sysbuild_entry_actions WHERE entry_id = ? AND action = 'conclude'", [iss.id]);
    assert.deepStrictEqual([row.basis_kind, row.basis_ref], ['dev_note_version', note.id]);
    assert.strictEqual((await payloads(s.pid, 'entry_action_recorded')).filter((p) => p.basis_ref === note.id).length, 1);
    // 自己做依据 400（处理说明本身是办理类登记时）
    const selfNote = await regDevOk(U.x1, s.pid, { type: 'issue', title: '处理说明型问题' });
    const sr = await act(U.pm, selfNote.id, CONC({ basis_dev_note_entry_id: selfNote.id }));
    expectErr(sr, 400, 'SYSBUILD_INVALID_INPUT', '自己做依据');
    // 被引用的处理说明不能作废（登记人本人 / PM 都不行）；没被引用的可以作废
    expectErr(await act(U.x1, note.id, { action: 'void', reason: '想作废' }), 409, 'SYSBUILD_STATE', '被引用的处理说明不能作废');
    expectErr(await act(U.pm, note.id, { action: 'void', reason: '想作废' }), 409, 'SYSBUILD_STATE', 'PM 也不能');
    assert.strictEqual((await detail(U.pm, note.id)).actions.void, false, '标志同源');
    assert.strictEqual((await act(U.pm, selfNote.id, { action: 'void', reason: '没被引用的可以作废' })).status, 201);
    // 不带依据的结论照常
    const iss2 = await regOk(U.m1, s.pid, { type: 'issue' });
    assert.strictEqual((await act(U.pm, iss2.id, CONC())).status, 201);
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_entry_actions WHERE entry_id = ? AND basis_kind IS NOT NULL", [iss2.id]), 0);
  });

  // ═══════════════════════ 9 改期引用 ═══════════════════════
  test(`${T_SCHED}——POST /nodes/:nid/schedule 来源方为开发方时必须带 dev_key_entry_id（本项目、开发方来源、已认可、未作废的关键事项登记；不带 409、未认可 409、别项目 / 不存在 400），写入 schedule_records.dev_key_entry_id 并进事件；非开发方来源带它 400；草稿期（总体规划未生效）带它 400`, async () => {
    const s = await mkScene({ plan: true });
    const other = await mkScene({ plan: true });
    const dev = await nodeId(s.pid, 'b_dev');
    let day = 3;
    const plan = (extra) => {
      day += 1;
      return post(U.pm, `/sysbuild/nodes/${dev}/schedule`, Object.assign({ kind: 'plan', planned_start: '2026-11-02', planned_end: `2026-11-${String(day + 10).padStart(2, '0')}`, reason: '开发方提出顺延', no_written_evidence: true, no_evidence_reason: '口头电话确认了本次顺延安排' }, extra || {}));
    };
    const key = await regDevOk(U.x1, s.pid, { title: '延期说明（自认可）' });
    const pending = await regDevOk(U.x2, s.pid, { title: '待认可' });
    const voidedKey = await regDevOk(U.x1, s.pid, { title: '作废的关键事项' });
    assert.strictEqual((await act(U.x1, voidedKey.id, { action: 'void', reason: '写错了' })).status, 201);
    const demandEntry = await regOk(U.m1, s.pid);
    const foreignKey = await regDevOk(U.x1, other.pid);
    // 不带 → 409；未认可 → 409；已作废 → 409；非开发方来源的登记 → 409；别项目 / 不存在 → 400
    const miss = await plan({ source_party_id: s.D });
    expectErr(miss, 409, 'SYSBUILD_STATE', '开发方来源不带关键事项');
    assert.ok(miss.body.message.includes('dev_key_entry_id'), miss.body.message);
    const np = await plan({ source_party_id: s.D, dev_key_entry_id: pending.id });
    expectErr(np, 409, 'SYSBUILD_STATE', '关键事项未认可');
    assert.ok(np.body.message.includes('未认可'), np.body.message);
    expectErr(await plan({ source_party_id: s.D, dev_key_entry_id: voidedKey.id }), 409, 'SYSBUILD_STATE', '关键事项已作废');
    const dk = await plan({ source_party_id: s.D, dev_key_entry_id: demandEntry.id });
    expectErr(dk, 409, 'SYSBUILD_STATE', '关键事项不是开发方的登记');
    assert.ok(dk.body.message.includes('必须是本次提出方'), dk.body.message);
    const fk = await plan({ source_party_id: s.D, dev_key_entry_id: foreignKey.id });
    expectErr(fk, 400, 'SYSBUILD_INVALID_INPUT', '别项目的关键事项');
    assert.strictEqual(fk.body.field, 'dev_key_entry_id');
    expectErr(await plan({ source_party_id: s.D, dev_key_entry_id: 99999999 }), 400, 'SYSBUILD_INVALID_INPUT', '不存在');
    // 非开发方来源 / 没有来源方带 dev_key_entry_id → 400
    expectErr(await plan({ source_party_id: s.A, dev_key_entry_id: key.id }), 400, 'SYSBUILD_INVALID_INPUT', '需求方来源带关键事项');
    expectErr(await plan({ dev_key_entry_id: key.id }), 400, 'SYSBUILD_INVALID_INPUT', '没有来源方带关键事项');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_node_schedule_records WHERE node_id = ? AND kind = 'plan_change' AND dev_key_entry_id IS NOT NULL", [dev]), 0, '被拒不留记录');
    // 成功：已认可的关键事项 → 记录带 dev_key_entry_id，事件带 dev_key_entry_id
    const ok = await plan({ source_party_id: s.D, dev_key_entry_id: key.id });
    assert.strictEqual(ok.status, 201, ok.text);
    const rec = await sqlGet('SELECT source_party_id, dev_key_entry_id FROM sysbuild_node_schedule_records WHERE id = ?', [ok.body.record_id]);
    assert.deepStrictEqual([rec.source_party_id, rec.dev_key_entry_id], [s.D, key.id]);
    assert.strictEqual((await payloads(s.pid, 'node_rescheduled')).pop().dev_key_entry_id, key.id);
    const recs = (await get(U.pm, `/sysbuild/nodes/${dev}/schedule`)).body.records.filter((r) => r.kind === 'plan_change' && r.dev_key_entry_id !== null);
    assert.deepStrictEqual(recs.map((r) => r.dev_key_entry_id), [key.id], '读接口记录带 dev_key_entry_id');
    // 需求方来源照常（不带）；草稿期（总体规划未生效）带 dev_key_entry_id 400
    assert.strictEqual((await plan({ source_party_id: s.A })).status, 201);
    const draftPid = await newProject();
    const dnode = await nodeId(draftPid, 'b_req');
    const dr = await post(U.pm, `/sysbuild/nodes/${dnode}/schedule`, { kind: 'plan', planned_start: '2026-11-02', planned_end: '2026-11-20', dev_key_entry_id: key.id });
    expectErr(dr, 400, 'SYSBUILD_INVALID_INPUT', '草稿期带关键事项');
    assert.strictEqual(dr.body.field, 'body');
  });

  // ═══════════════════════ 10 涉及承诺 ═══════════════════════
  test(`${T_COMMIT}——来源方为开发方且带「涉及承诺」（初始或 PM 补标）的登记需要负责人认可：登记 / 补标时同一事务建任务（已有当前有效认可不重复）；PM 取消承诺 → 待确认的认可修订失效（「已取消涉及承诺」）；这类登记不可拆分（含混合分流 409）；开发方暂无负责人 409 回滚；处理说明 / 交付物的认可与承诺标记无关；需求方来源不建任务`, async () => {
    const s = await mkScene({ plan: true });
    // 初始带承诺：开发方一般成员登记 → 待认可；负责人本人登记 → 自认可；需求方成员带承诺 → 不建任务
    const ex = await regOk(U.x3, s.pid, Object.assign({}, COMMIT_EV, { commitment_flag: 1 }));
    assert.deepStrictEqual([ex.dev_confirm.required, ex.dev_confirm.status], [true, 'pending']);
    assert.strictEqual((await devTask(ex.id)).uid, U.x1);
    const own = await regOk(U.x1, s.pid, Object.assign({}, COMMIT_EV, { commitment_flag: 1 }));
    assert.strictEqual(own.dev_confirm.status, 'approved', '负责人本人登记 = 本人提交并确认');
    const dem = await regOk(U.m1, s.pid, Object.assign({}, COMMIT_EV, { commitment_flag: 1 }));
    assert.deepStrictEqual([dem.dev_confirm.required, dem.dev_confirm.status, await devTaskCount(dem.id)], [false, 'none', 0], '需求方来源不建任务');
    // PM 补标：登记时没有承诺 → 补标后同一事务建任务；取消 → 待确认修订失效；再补标 → 新任务
    const e = await regOk(U.x3, s.pid);
    assert.strictEqual(await devTaskCount(e.id), 0);
    const mk1 = await actOk(U.pm, e.id, { action: 'mark_commitment', reason: '补标：开发方口头承诺交付' });
    assert.strictEqual(await devTaskCount(e.id), 1);
    assert.deepStrictEqual([mk1.entry.dev_confirm.status, mk1.entry.dev_confirm.required], ['pending', true]);
    assert.ok((await payloads(s.pid, 'entry_action_recorded')).some((p) => p.dev_confirm_task_id !== null && p.dev_confirm_task_id !== undefined && p.action === 'mark_commitment'), '办理事件带建任务的编号');
    const um = await actOk(U.pm, e.id, { action: 'unmark_commitment', reason: '取消：开发方不再承诺' });
    const t1 = await devTask(e.id);
    assert.deepStrictEqual([t1.status, t1.reason, um.entry.dev_confirm.status, um.closed_revision_ids], ['invalid', '已取消涉及承诺', 'lapsed', [t1.rid]]);
    assert.strictEqual((await actOk(U.pm, e.id, { action: 'mark_commitment', reason: '再次补标' })).entry.dev_confirm.status, 'pending');
    assert.strictEqual(await devTaskCount(e.id), 2, '失效后再补标建新任务');
    // 已认可后取消 / 再补标：已认可不动、不重复建任务
    const t2 = await devTask(e.id);
    await get(U.x1, `/sysbuild/confirm-tasks/${t2.tid}`);
    assert.strictEqual((await post(U.x1, `/sysbuild/confirm-tasks/${t2.tid}/decide`, decideBody(t2.rid, e.id, 'confirm'))).status, 200);
    await actOk(U.pm, e.id, { action: 'unmark_commitment', reason: '取消' });
    assert.strictEqual((await detail(U.pm, e.id)).dev_confirm.status, 'approved', '已认可的不因取消承诺而失效');
    await actOk(U.pm, e.id, { action: 'mark_commitment', reason: '又补标' });
    assert.strictEqual(await devTaskCount(e.id), 2, '已有当前有效认可：不重复建任务');
    // 需求方来源的登记补标承诺：不建任务
    const de = await regOk(U.m1, s.pid);
    await actOk(U.pm, de.id, { action: 'mark_commitment', reason: '补标' });
    assert.strictEqual(await devTaskCount(de.id), 0);
    // 处理说明的认可与承诺标记无关：不认可后 PM 补标承诺不新建任务；取消承诺不让待认可修订失效
    const dn = await regDevOk(U.x2, s.pid, { type: 'feedback' });
    await actOk(U.pm, dn.id, { action: 'mark_commitment', reason: '补标' });
    assert.strictEqual(await devTaskCount(dn.id), 1, '处理说明的任务登记时已建，补标不重复');
    await actOk(U.pm, dn.id, { action: 'unmark_commitment', reason: '取消' });
    assert.strictEqual((await devTask(dn.id)).status, 'pending', '处理说明：取消承诺不让待认可修订失效');
    const dn2 = await regDevOk(U.x2, s.pid, { type: 'feedback' });
    const tdn = await devTask(dn2.id);
    await get(U.x1, `/sysbuild/confirm-tasks/${tdn.tid}`);
    assert.strictEqual((await post(U.x1, `/sysbuild/confirm-tasks/${tdn.tid}/decide`, decideBody(tdn.rid, dn2.id, 'reject'))).status, 200);
    await actOk(U.pm, dn2.id, { action: 'mark_commitment', reason: '补标' });
    assert.strictEqual(await devTaskCount(dn2.id), 1, '负责人未认可的处理说明：补标承诺不新建任务（出路是修订重提）');
    // 不可拆分：来源方为开发方且带承诺（需要认可）的登记，手动拆分 409、标志为假；对照：同样的登记不带承诺可以拆
    const o1 = await mkItem(s.pid);
    const o2 = await mkItem(s.pid);
    const mkTwo = (uid, extra) => regOk(uid, s.pid, Object.assign({ item_ids: [o1.id, o2.id] }, extra || {}));
    const plain = await mkTwo(U.x3);
    assert.strictEqual((await detail(U.pm, plain.id)).actions.split, true, '对照：不需要认可的登记可以拆');
    const needs = await mkTwo(U.x3, Object.assign({}, COMMIT_EV, { commitment_flag: 1 }));
    assert.strictEqual((await detail(U.pm, needs.id)).actions.split, false, '需要认可的登记不能拆（标志）');
    const sp = await act(U.pm, needs.id, { action: 'split', groups: [[o1.id], [o2.id]] });
    expectErr(sp, 409, 'SYSBUILD_STATE', '需要认可的登记不可拆分');
    assert.ok(sp.body.message.includes('开发方负责人认可'), sp.body.message);
    assert.strictEqual((await act(U.pm, plain.id, { action: 'split', groups: [[o1.id], [o2.id]] })).status, 201, '对照：拆分成功');
    // 混合分流（登记时）：已上线 + 未上线 → 对照受理并拆分；需要认可的登记 409 引导拆成两件事
    await golive(await defaultBatchId(s.pid));
    const live = (await sqlGet('SELECT item_id FROM sysbuild_item_versions WHERE id = ?', [s.eff.itemVersionId])).item_id;
    const inPlan2 = await (async () => {
      const it = await mkItem(s.pid);
      const b2 = (await sqlRun("INSERT INTO sysbuild_batches (project_id, seq, name, is_default, status) VALUES (?, 2, '第 2 批', 0, 'planning')", [s.pid])).lastID;
      await sqlRun("INSERT INTO sysbuild_package_item_revisions (package_version_id, item_version_id, committed_batch_id, op, created_by) VALUES (?, ?, ?, 'add', ?)", [s.eff.pv, it.versions[0].id, b2, U.pm]);
      return it.id;
    })();
    const mixCtl = await regOk(U.x3, s.pid, { item_ids: [live, inPlan2] });
    assert.strictEqual(mixCtl.conclusion_state, 'split_container', '对照：不带承诺的混合分流受理并拆分');
    const mix = await reg(U.x3, s.pid, Object.assign({ item_ids: [live, inPlan2] }, COMMIT_EV, { commitment_flag: 1 }));
    expectErr(mix, 409, 'SYSBUILD_STATE', '需要认可的登记混合分流');
    assert.strictEqual(mix.body.guide, 'sys_iteration');
    assert.deepStrictEqual(mix.body.live_items.map((x) => x.item_id), [live]);
    // 补选归属到混合去向（待判定 → in_plan 混合）：需要认可的登记同样 409
    const pend = await regOk(U.x3, s.pid, Object.assign({}, COMMIT_EV, { commitment_flag: 1 }));
    const asg = await act(U.pm, pend.id, { action: 'assign_items', basis_category: 'in_plan', text: '判定依据', item_ids: [live, inPlan2] });
    expectErr(asg, 409, 'SYSBUILD_STATE', '补选归属到混合去向');
    assert.strictEqual(asg.body.guide, 'sys_iteration');
    // 开发方暂无负责人：补标 / 初始带承诺都 409 且不留行
    const s2 = await mkScene({ noOwner: true });
    const e2 = await regOk(U.x3, s2.pid);
    const before = await countOf('SELECT COUNT(*) AS n FROM sysbuild_entry_actions WHERE entry_id = ?', [e2.id]);
    const nm = await act(U.pm, e2.id, { action: 'mark_commitment', reason: '补标' });
    expectErr(nm, 409, 'SYSBUILD_STATE', '补标时开发方暂无负责人');
    assert.ok(nm.body.message.includes('开发方暂无负责人'), nm.body.message);
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_entry_actions WHERE entry_id = ?', [e2.id]), before, '回滚：不留补标记录');
    expectErr(await reg(U.x3, s2.pid, Object.assign({}, COMMIT_EV, { commitment_flag: 1 })), 409, 'SYSBUILD_STATE', '登记时开发方暂无负责人');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE project_id = ?', [s2.pid]), 1, '回滚：只有前面那一条');
    // 已终止项目：补标 409（认可不能作出）；取消承诺照常
    const e3 = await regOk(U.x3, s.pid);
    assert.strictEqual((await setStatus(s.pid, 'terminated')).status, 200);
    expectErr(await act(U.pm, e3.id, { action: 'mark_commitment', reason: '补标' }), 409, 'SYSBUILD_PROJECT_READONLY', '终止后补标');
    assert.strictEqual(await devTaskCount(e3.id), 0);
  });

  // ═══════════════════════ 11 不进分流 ═══════════════════════
  test(`${T_ROUTE}——用途为处理说明 / 交付物的登记不进分流（不判定、不留快照、不拆分、不进待判定；关联已上线条目照常受理），归属 / 拆分 409、标志为假；类型为办理类的仍按结论判（阻塞节点收口）`, async () => {
    const s = await mkScene({ plan: true });
    const batch = await defaultBatchId(s.pid);
    const live = (await sqlGet('SELECT item_id FROM sysbuild_item_versions WHERE id = ?', [s.eff.itemVersionId])).item_id;
    await golive(batch);
    // 对照：一般意见与反馈关联已上线条目 → 409 引导系统迭代
    expectErr(await reg(U.x3, s.pid, { item_ids: [live] }), 409, 'SYSBUILD_STATE', '对照：一般登记 + 已上线');
    // 处理说明（办理类型）关联已上线条目：照常受理，没有分流
    const dn = await regDevOk(U.x2, s.pid, { type: 'feedback', item_ids: [live] });
    assert.deepStrictEqual([dn.routing, dn.conclusion_state, dn.split_children, dn.items.length], [null, 'none', [], 1]);
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_routing_snapshots WHERE entry_id = ?', [dn.id]), 0, '没有判定快照');
    assert.deepStrictEqual([dn.actions.assign_items, dn.actions.split], [false, false], '标志为假');
    const r = await act(U.pm, dn.id, { action: 'assign_items', basis_category: 'in_plan', text: '依据', item_ids: [live] });
    expectErr(r, 409, 'SYSBUILD_STATE', '归属');
    assert.ok(r.body.message.includes('不进分流'), r.body.message);
    const dn2 = await regDevOk(U.x1, s.pid, { type: 'issue', item_ids: [live, (await mkItem(s.pid)).id] });
    expectErr(await act(U.pm, dn2.id, { action: 'split', groups: [[live], [dn2.items[1].item_id]] }), 409, 'SYSBUILD_STATE', '拆分');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE parent_entry_id IN (?, ?)', [dn.id, dn2.id]), 0, '没有子项');
    assert.strictEqual((await get(U.pm, `/sysbuild/projects/${s.pid}/entries?routing=pending`)).body.entries.filter((x) => x.id === dn.id || x.id === dn2.id).length, 0, '不进待判定列表');
    // 类型为办理类的仍按结论判：挂节点、节点进行中 → 收口前置阻塞（ENTRY_UNRESOLVED）
    const nid = await nodeId(s.pid, 'b_dev');
    assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${nid}/start`)).status, 200);
    const nodeEntry = await regDevOk(U.x2, s.pid, { type: 'feedback', node_id: nid });
    const view = (await get(U.pm, `/sysbuild/projects/${s.pid}/plan`)).body.nodes.find((n) => n.id === nid);
    const blk = view.close_blockers.find((b) => b.code === 'ENTRY_UNRESOLVED');
    assert.ok(blk && blk.entry_ids.includes(nodeEntry.id), `处理说明（办理类型）未结，阻塞节点收口：${JSON.stringify(view.close_blockers)}`);
    // 非办理类型的处理说明不阻塞
    const note = await regDevOk(U.x2, s.pid, { type: 'note', node_id: nid });
    const view2 = (await get(U.pm, `/sysbuild/projects/${s.pid}/plan`)).body.nodes.find((n) => n.id === nid);
    assert.ok(!view2.close_blockers.some((b) => b.code === 'ENTRY_UNRESOLVED' && b.entry_ids.includes(note.id)), '知悉类型不阻塞');
  });

  // ═══════════════════════ 12 作废 ═══════════════════════
  test(`${T_VOID}——作废待认可的开发方关键事项：待确认的认可修订同一事务失效（登记已作废），之后不能再决策；作废后一切办理 409`, async () => {
    const s = await mkScene();
    const e = await regDevOk(U.x2, s.pid);
    const t = await devTask(e.id);
    await get(U.x1, `/sysbuild/confirm-tasks/${t.tid}`);
    const v = await actOk(U.x2, e.id, { action: 'void', reason: '写错了' });
    assert.deepStrictEqual([v.entry.voided, v.closed_revision_ids], [true, [t.rid]]);
    const t2 = await devTask(e.id);
    assert.deepStrictEqual([t2.status, t2.reason], ['invalid', '登记已作废']);
    assert.strictEqual(v.entry.dev_confirm.status, 'lapsed');
    expectErr(await post(U.x1, `/sysbuild/confirm-tasks/${t.tid}/decide`, decideBody(t.rid, e.id, 'confirm')), 409, 'SYSBUILD_STATE', '已失效的修订不能决策');
    assert.strictEqual((await pendingDev(U.x1, s.pid)).length, 0);
    expectErr(await act(U.pm, e.id, { action: 'correct', text: '更正' }), 409, 'SYSBUILD_STATE', '作废后办理');
    // 改发：作废后任务所在对象 voided → 不能改发
    expectErr(await post(U.pm, `/sysbuild/confirm-tasks/${t.tid}/reissue`, { reason: '想改发' }), 409, 'SYSBUILD_STATE', '作废后改发');
    // 已认可的处理说明（没有被引用）可以作废；认可记录保留
    const ok = await regDevOk(U.x1, s.pid, { title: '自认可' });
    assert.strictEqual((await act(U.x1, ok.id, { action: 'void', reason: '没用了' })).status, 201);
    assert.strictEqual((await devTask(ok.id)).status, 'confirmed', '已确认的修订不动');
  });

  // ═══════════════════════ 13 rules 纯函数 ═══════════════════════
  test(`${T_RULES}——手写判定矩阵：entry_create_dev（谁 × 项目状态 accept 行）、entry_split / entry_assign_items 对开发用途与需要认可的登记、entry_void 对被引用的处理说明、confirm_reissue 对 dev_entry`, async () => {
    const R = T.getMods().rules;
    const idn = (o) => Object.assign({ isPm: false, isAdmin: false, isReadonly: false, userId: 50, ownerOfParties: [], delegateOfParties: [] }, o);
    const chk = (op, i, st, t) => R.checkOp(op, i, { id: 1, status: st || 'active', pm_user_id: 7 }, t || {});
    const code = (v) => (v === null ? null : `${v.status}:${v.code}`);
    // entry_create_dev
    const ok = (i, t, st) => code(chk('entry_create_dev', i, st, t || { devPartyId: 9 }));
    assert.strictEqual(ok(idn({ isPm: true })), null, 'PM 代登');
    assert.strictEqual(ok(idn({ ownerOfParties: [9] })), null, '开发方负责人');
    assert.strictEqual(ok(idn({ delegateOfParties: [9] })), null, '开发方代表人');
    assert.strictEqual(ok(idn({ ownerOfParties: [8] })), '403:SYSBUILD_FORBIDDEN', '别的参与方的负责人');
    assert.strictEqual(ok(idn({ delegateOfParties: [8] })), '403:SYSBUILD_FORBIDDEN', '别的参与方的代表人');
    assert.strictEqual(ok(idn({ isMember: true })), '403:SYSBUILD_FORBIDDEN', '一般成员');
    assert.strictEqual(ok(idn({ isAdmin: true })), '403:SYSBUILD_FORBIDDEN', 'admin 未接管');
    assert.strictEqual(ok(idn({ isPm: true, isReadonly: true })), '403:SYSBUILD_FORBIDDEN', '只读 PM');
    assert.strictEqual(ok(idn({ ownerOfParties: [9], isReadonly: true })), '403:SYSBUILD_FORBIDDEN', '只读负责人');
    assert.strictEqual(ok(idn({ ownerOfParties: [9] }), { devPartyId: null }), '403:SYSBUILD_FORBIDDEN', '没有开发方参与方：非 PM 403');
    assert.strictEqual(ok(idn({ ownerOfParties: [9] }), {}), '403:SYSBUILD_FORBIDDEN', '事实没取到按拒绝');
    assert.strictEqual(ok(idn({ isPm: true }), { devPartyId: null }), null, 'PM 不依赖开发方参与方（来源方校验在端点里）');
    for (const [st, allow] of [['active', true], ['paused', true], ['terminated', false], ['closed', false]]) {
      assert.strictEqual(ok(idn({ ownerOfParties: [9] }), undefined, st), allow ? null : '409:SYSBUILD_PROJECT_READONLY', `accept 行 × ${st}`);
    }
    // entry_split / entry_assign_items：开发用途与需要认可的登记
    const pm = idn({ isPm: true, isMember: true });
    const base = { isRegistrant: false, registrantWasPm: false, voided: false, type: 'feedback', conclusionState: 'none', commitmentCurrent: false, commitmentInitial: false, refObjectedEver: false, riskCurrent: false,
      confirmer: 'delegate', confirmerProxyOnly: false, owner: 'ok', projectStatus: 'active', isChild: false, distinctItemCount: 2, route: 'pending', basisCategory: 'undetermined', purpose: 'general', needsDevConfirm: false, usedAsBasis: false,
      devConfirmStatus: 'none', markNeedsDevTask: false };
    const T0 = (o) => Object.assign({}, base, o || {});
    assert.strictEqual(chk('entry_split', pm, 'active', T0()), null, '对照：一般登记可拆');
    // 修订批 3 N1：负责人未认可（not_approved）的登记不能拆分（即使已取消承诺、needsDevConfirm 为假）；其余认可状态不影响；事实没取到 fail-closed
    const nsp = chk('entry_split', pm, 'active', T0({ devConfirmStatus: 'not_approved' }));
    assert.strictEqual(code(nsp), '409:SYSBUILD_STATE', '未认可不可拆分');
    assert.strictEqual(nsp.message, R.ENTRY_DEV_NOT_APPROVED_SPLIT_MESSAGE);
    assert.strictEqual(nsp.message, '开发方负责人未认可的登记不能拆分，请修订重提');
    for (const st of ['none', 'pending', 'approved', 'lapsed']) assert.strictEqual(chk('entry_split', pm, 'active', T0({ devConfirmStatus: st })), null, `认可状态 ${st} 不影响拆分`);
    for (const bad of [undefined, null, 0]) assert.strictEqual(code(chk('entry_split', pm, 'active', T0({ devConfirmStatus: bad }))), '409:SYSBUILD_STATE', `认可状态事实 ${String(bad)} 缺失 / 非法：fail-closed`);
    // 修订批 3 H2：entry_mark_commitment 对「补标会建认可任务」的登记（markNeedsDevTask）按项目状态 accept 类判：已终止 / 已结项 409（PROJECT_READONLY），进行中 / 已暂停放行；不会建任务的登记不受影响；事实没取到 fail-closed
    for (const [st, allow] of [['active', true], ['paused', true], ['terminated', false], ['closed', false]]) {
      const v = chk('entry_mark_commitment', pm, st, T0({ markNeedsDevTask: true, projectStatus: st }));
      assert.strictEqual(code(v), allow ? null : '409:SYSBUILD_PROJECT_READONLY', `补标（会建认可任务）× ${st}`);
      if (!allow) assert.strictEqual(v.message, '项目已终止 / 已结项，开发方关键事项不能再提交认可');
      assert.strictEqual(chk('entry_mark_commitment', pm, st, T0({ markNeedsDevTask: false, projectStatus: st })), null, `补标（不建任务）× ${st} 照常`);
    }
    assert.strictEqual(R.devConfirmProjectBlock('active'), null);
    assert.strictEqual(R.devConfirmProjectBlock('paused'), null);
    for (const st of ['terminated', 'closed', 'bogus', undefined]) assert.strictEqual(R.devConfirmProjectBlock(st).code, 'SYSBUILD_PROJECT_READONLY', `项目状态 ${String(st)} 不能提交认可（含未知状态）`);
    assert.strictEqual(code(chk('entry_mark_commitment', pm, 'active', T0({ markNeedsDevTask: undefined }))), '409:SYSBUILD_STATE', '补标会不会建任务的事实没取到：fail-closed');
    assert.strictEqual(code(chk('entry_mark_commitment', pm, 'terminated', T0({ markNeedsDevTask: true, projectStatus: undefined }))), '409:SYSBUILD_PROJECT_READONLY', '项目状态事实缺失按拒绝');
    for (const purpose of ['dev_note', 'deliverable']) {
      assert.strictEqual(code(chk('entry_split', pm, 'active', T0({ purpose }))), '409:SYSBUILD_STATE', `拆分 × ${purpose}`);
      assert.strictEqual(code(chk('entry_assign_items', pm, 'active', T0({ purpose }))), '409:SYSBUILD_STATE', `归属 × ${purpose}`);
    }
    assert.strictEqual(code(chk('entry_split', pm, 'active', T0({ needsDevConfirm: true }))), '409:SYSBUILD_STATE', '需要认可的登记不可拆分');
    assert.strictEqual(chk('entry_assign_items', pm, 'active', T0()), null, '对照：待判定的一般登记可归属');
    // entry_void：被引用为办理依据的处理说明不能作废
    assert.strictEqual(chk('entry_void', pm, 'active', T0()), null);
    assert.strictEqual(code(chk('entry_void', pm, 'active', T0({ usedAsBasis: true }))), '409:SYSBUILD_STATE', '被引用的处理说明');
    // confirm_reissue 对 dev_entry 放行（对象状态 pending、修订待确认 / 已失效），对象已 settled / voided 拒绝
    const rt = (o) => chk('confirm_reissue', pm, 'active', Object.assign({ objectType: 'dev_entry', objectStatus: 'pending', revisionStatus: 'pending', batchStatus: undefined, reissueBlocked: null, historyConflict: null }, o || {}));
    assert.strictEqual(rt(), null);
    assert.strictEqual(rt({ revisionStatus: 'invalid' }), null);
    assert.strictEqual(code(rt({ objectStatus: 'settled', revisionStatus: 'rejected' })), '409:SYSBUILD_STATE');
    assert.strictEqual(code(rt({ objectStatus: 'voided' })), '409:SYSBUILD_STATE');
    assert.strictEqual(code(rt({ objectType: 'bogus' })), '409:SYSBUILD_STATE', '别的对象类型仍不支持');
    assert.deepStrictEqual(R.ENTRY_DEV_PURPOSES.slice(), ['dev_note', 'deliverable']);
  });

  // ═══════════════════════ 预筛第 3 轮 ═══════════════════════
  test(`${T_Z_REG}——知会异议 / 异议登记的「原登记人」依据要求登记时身份非 PM：PM 代登的登记，PM 对自己标的仅供参考不能提异议（标志同源为假）；非 PM 登记的登记人本人仍可`, async () => {
    const s = await mkScene();
    // PM 代登（来源方甲部）→ PM 给仅供参考 → 知会给甲部代表人
    const e = await regOk(U.pm, s.pid, { source_party_id: s.A });
    assert.strictEqual(e.operator_identity.is_pm, true);
    await actOk(U.pm, e.id, { action: 'for_reference' });
    const n = await sqlGet("SELECT id FROM sysbuild_notices WHERE ref_type = 'entry' AND ref_id = ?", [e.id]);
    const mine = (await get(U.pm, '/sysbuild/my/notices')).body.items.find((i) => i.id === n.id);
    assert.deepStrictEqual([mine.as, mine.actions.object], ['registrant', false], '列表里 PM 是登记人，但标志为假');
    expectErr(await post(U.pm, `/sysbuild/notices/${n.id}/object`, { reason: 'PM 对自己标的仅供参考提异议' }), 403, 'SYSBUILD_FORBIDDEN', 'PM 不能对自己代登的仅供参考提异议');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_notice_objections WHERE notice_id = ?', [n.id]), 0);
    // 对照：非 PM 登记（甲部成员 m1，来源方甲部）→ PM 标仅供参考 → m1 作为登记人可以提异议
    const e2 = await regOk(U.m1, s.pid);
    await actOk(U.pm, e2.id, { action: 'for_reference' });
    const n2 = await sqlGet("SELECT id FROM sysbuild_notices WHERE ref_type = 'entry' AND ref_id = ?", [e2.id]);
    const r = await post(U.m1, `/sysbuild/notices/${n2.id}/object`, { reason: '登记人对仅供参考有异议' });
    assert.strictEqual(r.status, 201, r.text);
  });

  test(`${T_Z_SPLIT}——拆分给子项补写的「随原登记取消」办理记录同样发 entry_action_recorded 事件（挂在子项上，payload.via = split_cancel，带动作编号 / 原登记编号）`, async () => {
    const s = await mkScene({ plan: true });
    const o1 = await mkItem(s.pid);
    const o2 = await mkItem(s.pid);
    const e = await regOk(U.m1, s.pid, Object.assign({ type: 'issue', is_risk: 1, item_ids: [o1.id, o2.id] }, COMMIT_EV, { commitment_flag: 1 })); // 登记人是甲部成员 m1，办理（取消标记、拆分）的是 PM：区分「执行人」与「登记人」
    await actOk(U.pm, e.id, { action: 'unmark_commitment', reason: '取消承诺' });
    await actOk(U.pm, e.id, { action: 'unmark_risk', reason: '取消风险' });
    const sp = await actOk(U.pm, e.id, { action: 'split', groups: [[o1.id], [o2.id]] });
    assert.strictEqual(sp.children.length, 2);
    for (const k of sp.children) {
      const rows = await sqlAll("SELECT id, action, text, created_by FROM sysbuild_entry_actions WHERE entry_id = ? ORDER BY id", [k.entry_id]);
      assert.deepStrictEqual(rows.map((x) => [x.action, x.text, x.created_by]), [['unmark_commitment', '随原登记取消', U.pm], ['unmark_risk', '随原登记取消', U.pm]]);
      const evs = (await sqlAll("SELECT payload_json, operator_id FROM sysbuild_events WHERE object_type = 'entry' AND object_id = ? AND event_type = 'entry_action_recorded' ORDER BY id", [k.entry_id]));
      assert.strictEqual(evs.length, 2, `子项 ${k.entry_id}：每条补写的办理记录各一个事件`);
      const ps = evs.map((x) => JSON.parse(x.payload_json));
      assert.deepStrictEqual(ps.map((p) => [p.action_id, p.action, p.via, p.parent_entry_id, p.task_id, p.closed_revision_ids]), rows.map((x) => [x.id, x.action, 'split_cancel', e.id, null, []]));
      assert.ok(evs.every((x) => x.operator_id === U.pm), '事件操作人 = 执行拆分的 PM');
    }
  });

  test(`${T_Z_NOTICE}——/my/notices 的来源方负责人 / 来源方代表人 / 原登记人三个来源查询只列仅供参考知会（kind = for_reference）：别的类型的知会（C6 的改期知会等）即使 ref 指向登记也不列`, async () => {
    const s = await mkScene();
    const e = await regOk(U.m1, s.pid);
    await actOk(U.pm, e.id, { action: 'for_reference' });
    const real = await sqlGet("SELECT id FROM sysbuild_notices WHERE kind = 'for_reference' AND ref_type = 'entry' AND ref_id = ?", [e.id]);
    const mInt = await sqlGet('SELECT id FROM sysbuild_members WHERE project_id = ? AND user_id = ?', [s.pid, U.cand]);
    const fake = (await sqlRun("INSERT INTO sysbuild_notices (project_id, kind, ref_type, ref_id, recipient_member_id, created_by) VALUES (?, 'schedule_change', 'entry', ?, ?, ?)", [s.pid, e.id, mInt.id, U.pm])).lastID; // 夹具：C6 才有生产路径
    for (const [uid, label, as] of [[U.m1, '原登记人', 'registrant'], [U.del, '来源方代表人（也是接收人）', 'recipient'], [U.own, '来源方负责人', 'party_owner']]) {
      const items = (await get(uid, '/sysbuild/my/notices')).body.items;
      assert.deepStrictEqual(items.filter((i) => i.id === real.id).map((i) => i.as), [as], `${label}：列出仅供参考知会`);
      assert.ok(!items.some((i) => i.id === fake), `${label}：不列别的类型的知会`);
    }
    // 来源方代表人不是接收人时（改由 x 一类成员接收）：换一个代表人场景证明代表人来源查询同样过滤
    await sqlRun("UPDATE sysbuild_notices SET recipient_member_id = ? WHERE id = ?", [mInt.id, real.id]);
    const dl = (await get(U.del, '/sysbuild/my/notices')).body.items;
    assert.deepStrictEqual(dl.filter((i) => i.id === real.id).map((i) => i.as), ['source_party'], '来源方代表人（非接收人）：列出仅供参考知会');
    assert.ok(!dl.some((i) => i.id === fake), '来源方代表人（非接收人）：不列别的类型的知会');
  });

  test(`${T_Z_ADJ}——裁定通过是最终态：之后再给结论 409、作废 409、再交裁定 409；原结论 / 裁定的确认人在裁定通过后的提异议资格只认当前有效裁定`, async () => {
    const s = await mkScene();
    const e = await regOk(U.m1, s.pid);
    await actOk(U.pm, e.id, { action: 'conclude', conclusion_kind: 'handled', text: '已处理' });
    const c1 = await sqlGet("SELECT id FROM sysbuild_confirm_tasks WHERE object_type = 'conclusion' AND object_id = ?", [e.id]);
    assert.strictEqual((await openAndDecide(U.del, c1.id, 'object', { reason: '不同意' })).status, 200);
    await actOk(U.pm, e.id, { action: 'escalate' });
    const a1 = await sqlGet("SELECT id FROM sysbuild_confirm_tasks WHERE object_type = 'adjudication' AND object_id = ?", [e.id]);
    assert.strictEqual((await openAndDecide(U.own, a1.id, 'confirm')).status, 200);
    assert.strictEqual((await detail(U.pm, e.id)).conclusion_state, 'adjudicated');
    const actions = await countOf('SELECT COUNT(*) AS n FROM sysbuild_entry_actions WHERE entry_id = ?', [e.id]);
    expectErr(await act(U.pm, e.id, { action: 'conclude', conclusion_kind: 'adopted', text: '换个结论' }), 409, 'SYSBUILD_STATE', '裁定通过后再给结论');
    expectErr(await act(U.pm, e.id, { action: 'void', reason: '想作废' }), 409, 'SYSBUILD_STATE', '裁定通过后作废');
    expectErr(await act(U.m1, e.id, { action: 'void', reason: '登记人也不能作废' }), 409, 'SYSBUILD_STATE', '登记人作废');
    expectErr(await act(U.pm, e.id, { action: 'escalate' }), 409, 'SYSBUILD_STATE', '再交裁定');
    expectErr(await act(U.pm, e.id, { action: 'for_reference' }), 409, 'SYSBUILD_STATE', '再标仅供参考');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_entry_actions WHERE entry_id = ?', [e.id]), actions, '被拒不留办理记录');
    const d = await detail(U.pm, e.id);
    assert.deepStrictEqual([d.conclusion_state, d.actions.conclude, d.actions.void, d.actions.escalate], ['adjudicated', false, false, false]);
    // 裁定确认人（负责人 own）在裁定通过后仍有资格对该结论提异议（confirmer 依据）；原结论的确认人（代表人 del）已提过异议，不是当前有效结论的确认人，但作为来源方代表人仍有 source_party 资格
    assert.strictEqual((await detail(U.own, e.id)).actions.object, true, '裁定确认人：有资格');
    assert.strictEqual((await detail(U.m1, e.id)).actions.object, true, '登记人：有资格');
  });

  // ═══════════════════════ 预筛 4 轮（#113 C5 S-S1c 预筛修订批）═══════════════════════
  const decideAs = async (uid, e) => {
    const t = await devTask(e.id);
    const o = await get(uid, `/sysbuild/confirm-tasks/${t.tid}`);
    assert.strictEqual(o.status, 200, o.text);
    return post(uid, `/sysbuild/confirm-tasks/${t.tid}/decide`, decideBody(t.rid, e.id, 'confirm'));
  };
  const COMMIT_DEV = (s) => Object.assign({ source_party_id: s.D, commitment_flag: 1 }, COMMIT_EV);

  test(`${T_Y_REISSUE}——认可改发只在「失效原因 = 项目已终止且登记仍需认可」且是本登记最新任务时放行：取消涉及承诺失效的修订改发 409（认可不复活，重新标记另建任务，旧任务改发 409）；终止期间取消承诺后重开改发 409；仍需认可的终止重开改发 200；已认可后再取消承诺，认可仍有效、仍可作改期引用`, async () => {
    const s = await mkScene({ plan: true });
    // ① 取消承诺失效 → 改发 409，标志同源为假；认可不复活
    const e = await regOk(U.pm, s.pid, COMMIT_DEV(s));
    assert.strictEqual(e.dev_confirm.status, 'pending');
    const t = await devTask(e.id);
    await actOk(U.pm, e.id, { action: 'unmark_commitment', reason: '取消承诺' });
    const lapsed = await devTask(e.id);
    assert.deepStrictEqual([lapsed.status, lapsed.reason], ['invalid', '已取消涉及承诺']);
    assert.strictEqual((await get(U.pm, `/sysbuild/confirm-tasks/${t.tid}`)).body.actions.reissue, false, '标志同源为假');
    const rr = await post(U.pm, `/sysbuild/confirm-tasks/${t.tid}/reissue`, { reason: '想让认可复活' });
    expectErr(rr, 409, 'SYSBUILD_STATE', '取消承诺后改发');
    assert.ok(rr.body.message.includes('已失效'), rr.body.message);
    assert.strictEqual((await detail(U.pm, e.id)).dev_confirm.status, 'lapsed', '认可不复活');
    assert.strictEqual(await devTaskCount(e.id), 1);
    // ② 重新标记涉及承诺 → 另建任务；旧任务不是最新任务，改发 409
    await actOk(U.pm, e.id, { action: 'mark_commitment', reason: '重新标记' });
    const t2 = await devTask(e.id);
    assert.notStrictEqual(t2.tid, t.tid, '重新标记另建任务');
    const old = await post(U.pm, `/sysbuild/confirm-tasks/${t.tid}/reissue`, { reason: '旧任务' });
    expectErr(old, 409, 'SYSBUILD_STATE', '旧任务改发');
    assert.ok(old.body.message.includes('取代'), old.body.message);
    assert.strictEqual((await get(U.pm, `/sysbuild/confirm-tasks/${t.tid}`)).body.actions.reissue, false, '旧任务标志同源为假');
    assert.strictEqual((await post(U.pm, `/sysbuild/confirm-tasks/${t2.tid}/reissue`, { reason: '对照：最新任务（待确认）可改发' })).status, 200, '对照：最新任务可改发');
    // ③ 终止期间取消承诺，重开后改发 409（登记已不需要认可）；仍带承诺的终止重开改发 200
    const e2 = await regOk(U.pm, s.pid, COMMIT_DEV(s));
    const e3 = await regOk(U.pm, s.pid, COMMIT_DEV(s));
    const t3 = await devTask(e2.id);
    const t4 = await devTask(e3.id);
    assert.strictEqual((await setStatus(s.pid, 'terminated')).status, 200);
    assert.deepStrictEqual([(await devTask(e2.id)).status, (await devTask(e2.id)).reason], ['invalid', '项目已终止']);
    await actOk(U.pm, e2.id, { action: 'unmark_commitment', reason: '终止期间取消承诺' });
    assert.strictEqual((await setStatus(s.pid, 'active')).status, 200);
    const r3 = await post(U.pm, `/sysbuild/confirm-tasks/${t3.tid}/reissue`, { reason: '重开后想改发' });
    expectErr(r3, 409, 'SYSBUILD_STATE', '终止期间取消承诺后改发');
    assert.ok(r3.body.message.includes('已不需要'), r3.body.message);
    assert.strictEqual((await get(U.pm, `/sysbuild/confirm-tasks/${t3.tid}`)).body.actions.reissue, false);
    assert.strictEqual((await get(U.pm, `/sysbuild/confirm-tasks/${t4.tid}`)).body.actions.reissue, true, '对照：仍带承诺的标志为真');
    const r4 = await post(U.pm, `/sysbuild/confirm-tasks/${t4.tid}/reissue`, { reason: '重开，重新发起认可' });
    assert.strictEqual(r4.status, 200, r4.text);
    assert.deepStrictEqual([r4.body.revision.rev_no, r4.body.revision.status], [2, 'pending']);
    // ④ 已认可后再取消承诺：认可仍有效（devApprovalUsable 不改），仍可作开发方改期引用
    const e5 = await regOk(U.pm, s.pid, COMMIT_DEV(s));
    assert.strictEqual((await decideAs(U.x1, e5)).status, 200);
    assert.strictEqual((await detail(U.pm, e5.id)).dev_confirm.status, 'approved');
    await actOk(U.pm, e5.id, { action: 'unmark_commitment', reason: '已认可后取消承诺' });
    assert.strictEqual((await detail(U.pm, e5.id)).dev_confirm.status, 'approved', '已认可的不因取消承诺失效');
    const dev = await nodeId(s.pid, 'b_dev');
    const sch = await post(U.pm, `/sysbuild/nodes/${dev}/schedule`, { kind: 'plan', planned_start: '2026-11-02', planned_end: '2026-11-23', reason: '开发方提出顺延', source_party_id: s.D, dev_key_entry_id: e5.id, no_written_evidence: true, no_evidence_reason: '口头电话确认了本次顺延安排' });
    assert.strictEqual(sch.status, 201, `已认可后取消承诺：仍可作关键事项引用 ${sch.text}`);
  });

  test(`${T_Y_WASH}——「负责人未认可」不能靠取消再补标洗掉：不认可后取消承诺、再补标 → 承诺标记照常写入（201），但不建新认可任务、认可状态保持「负责人未认可」（与处理说明用途同口径，修订批 3 L5：原 409 改为不建任务）；出路是修订重提`, async () => {
    const s = await mkScene();
    const e = await regOk(U.pm, s.pid, COMMIT_DEV(s));
    const t = await devTask(e.id);
    await get(U.x1, `/sysbuild/confirm-tasks/${t.tid}`);
    const rj = await post(U.x1, `/sysbuild/confirm-tasks/${t.tid}/decide`, decideBody(t.rid, e.id, 'reject'));
    assert.strictEqual(rj.status, 200, rj.text);
    assert.strictEqual((await detail(U.pm, e.id)).dev_confirm.status, 'not_approved');
    await actOk(U.pm, e.id, { action: 'unmark_commitment', reason: '取消承诺' });
    const rm = await act(U.pm, e.id, { action: 'mark_commitment', reason: '再补标，认可状态不能因此回来' });
    assert.strictEqual(rm.status, 201, rm.text);
    assert.strictEqual(await devTaskCount(e.id), 1, '不建新任务');
    const d = await detail(U.pm, e.id);
    assert.deepStrictEqual([d.commitment_current, d.dev_confirm.status, d.dev_confirm.label], [true, 'not_approved', '负责人未认可'], '承诺标记写入，认可状态保持未认可');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_entry_actions WHERE entry_id = ? AND action = 'mark_commitment'", [e.id]), 1, '补标办理记录照常写');
    assert.strictEqual((await devTask(e.id)).status, 'rejected', '唯一一条任务的修订仍是不认可');
    // 出路 = 修订重提（新登记引用旧登记）
    const rv = await regOk(U.pm, s.pid, Object.assign(COMMIT_DEV(s), { revision_of_entry_id: e.id }));
    assert.strictEqual(rv.revision_of_entry_id, e.id);
    assert.strictEqual(rv.dev_confirm.status, 'pending');
  });

  test(`${T_Y_SELFTEXT}——本人提交并确认须带固定确认文案：开发方现任负责人本人登记需认可的事项，self_confirm_text 缺失 / 不等 / 非文本 → 400（整笔回滚）；等于固定文案 → 通过，确认记录写实际提交的文案；非本人提交（代表人 / PM 代登）不要求`, async () => {
    const s = await mkScene();
    for (const [extra, label] of [[{ self_confirm_text: undefined }, '缺失'], [{ self_confirm_text: '确认' }, '不等'], [{ self_confirm_text: '' }, '空文本'], [{ self_confirm_text: `${CB_CONFIRM} ` }, '多一个空格'], [{ self_confirm_text: 1 }, '非文本']]) {
      const r = await regDev(U.x1, s.pid, extra);
      expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', `处理说明 × ${label}`);
      assert.strictEqual(r.body.field, 'self_confirm_text', label);
    }
    const g = await reg(U.x1, s.pid, Object.assign({ self_confirm_text: undefined, commitment_flag: 1 }, COMMIT_EV));
    expectErr(g, 400, 'SYSBUILD_INVALID_INPUT', '一般登记带承诺 × 缺失');
    assert.strictEqual(g.body.field, 'self_confirm_text');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE project_id = ?', [s.pid]), 0, '被拒不留登记');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE project_id = ?', [s.pid]), 0, '被拒不留任务');
    const ok = await regDevOk(U.x1, s.pid);
    assert.strictEqual(ok.dev_confirm.status, 'approved');
    const cf = await sqlGet("SELECT checkbox_text, method, decision FROM sysbuild_confirmations WHERE object_type = 'dev_entry' AND object_version_id = ?", [ok.id]);
    assert.deepStrictEqual([cf.checkbox_text, cf.method, cf.decision], [CB_CONFIRM, 'platform', 'confirm'], '确认记录写提交的文案');
    // 非本人提交：开发方代表人 / PM 代登不要求文案
    assert.strictEqual((await regDev(U.x2, s.pid, { self_confirm_text: undefined })).status, 201, '代表人登记不要求');
    assert.strictEqual((await regDev(U.pm, s.pid, { source_party_id: s.D, self_confirm_text: undefined })).status, 201, 'PM 代登不要求');
    assert.strictEqual((await regDev(U.x2, s.pid, { self_confirm_text: '随便写' })).status, 201, '代表人带了也忽略');
  });

  test(`${T_Y_VOIDKEY}——被开发方改期引用的关键事项不能作废（改期记录的依据不能消失）：引用后作废 409（actions.void 同源为假）；没被引用的同类登记仍可作废`, async () => {
    const s = await mkScene({ plan: true });
    const key = await regDevOk(U.x1, s.pid, { title: '延期说明（自认可）' });
    const spare = await regDevOk(U.x1, s.pid, { title: '没被引用的说明' });
    assert.strictEqual((await detail(U.x1, key.id)).actions.void, true, '对照：引用前可作废（标志）');
    const dev = await nodeId(s.pid, 'b_dev');
    const sch = await post(U.pm, `/sysbuild/nodes/${dev}/schedule`, { kind: 'plan', planned_start: '2026-11-02', planned_end: '2026-11-24', reason: '开发方提出顺延', source_party_id: s.D, dev_key_entry_id: key.id, no_written_evidence: true, no_evidence_reason: '口头电话确认了本次顺延安排' });
    assert.strictEqual(sch.status, 201, sch.text);
    const vr = await act(U.x1, key.id, { action: 'void', reason: '想作废被引用的关键事项' });
    expectErr(vr, 409, 'SYSBUILD_STATE', '被改期引用后作废');
    assert.ok(vr.body.message.includes('改期依据'), vr.body.message);
    expectErr(await act(U.pm, key.id, { action: 'void', reason: 'PM 也不能作废' }), 409, 'SYSBUILD_STATE', 'PM 作废被引用的关键事项');
    assert.strictEqual((await detail(U.x1, key.id)).actions.void, false, '标志同源为假');
    assert.strictEqual((await detail(U.x1, key.id)).voided, false);
    assert.strictEqual((await act(U.x1, spare.id, { action: 'void', reason: '没被引用，可以作废' })).status, 201, '对照：没被引用的仍可作废');
  });

  test(`${T_Y_REVSRC}——修订重提的来源方必须与被修订的登记一致：来源方不同 / 为空 → 400 来源方；相同 → 201`, async () => {
    const s = await mkScene();
    const old = await regOk(U.pm, s.pid, COMMIT_DEV(s));
    const t = await devTask(old.id);
    await get(U.x1, `/sysbuild/confirm-tasks/${t.tid}`);
    assert.strictEqual((await post(U.x1, `/sysbuild/confirm-tasks/${t.tid}/decide`, decideBody(t.rid, old.id, 'reject'))).status, 200);
    assert.strictEqual((await detail(U.pm, old.id)).dev_confirm.status, 'not_approved');
    const before = await countOf('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE project_id = ?', [s.pid]);
    const other = await reg(U.pm, s.pid, Object.assign({ source_party_id: s.A, revision_of_entry_id: old.id, commitment_flag: 1 }, COMMIT_EV));
    expectErr(other, 400, 'SYSBUILD_INVALID_INPUT', '来源方不同');
    assert.strictEqual(other.body.field, 'source_party_id');
    assert.ok(other.body.message.includes('来源方'), other.body.message);
    const none = await reg(U.pm, s.pid, Object.assign({ revision_of_entry_id: old.id, commitment_flag: 1 }, COMMIT_EV));
    expectErr(none, 400, 'SYSBUILD_INVALID_INPUT', '来源方为空');
    assert.strictEqual(none.body.field, 'source_party_id');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE project_id = ?', [s.pid]), before, '被拒不留登记');
    const ok = await reg(U.pm, s.pid, Object.assign({ source_party_id: s.D, revision_of_entry_id: old.id, commitment_flag: 1 }, COMMIT_EV));
    assert.strictEqual(ok.status, 201, ok.text);
    assert.strictEqual(ok.body.entry.revision_of_entry_id, old.id);
  });

  // ═══════════════════════ 修订批 3（codex 26 H1 / H2，预筛快看 N1 / L5）═══════════════════════
  test(`${T_W_REISSUE}——负责人已作出决定的认可任务不能改发（P131）：不认可后 PM 直接改发 409（actions.reissue 同源为假，不新增修订、认可状态仍是未认可）；认可后同样 409；对照：待确认的任务（换人）仍可改发`, async () => {
    const s = await mkScene();
    const revCount = (tid) => countOf('SELECT COUNT(*) AS n FROM sysbuild_confirm_task_revisions WHERE task_id = ?', [tid]);
    // ① 不认可 → 直接改发 409
    const e = await regDevOk(U.x2, s.pid);
    const t = await devTask(e.id);
    await get(U.x1, `/sysbuild/confirm-tasks/${t.tid}`);
    assert.strictEqual((await post(U.x1, `/sysbuild/confirm-tasks/${t.tid}/decide`, decideBody(t.rid, e.id, 'reject'))).status, 200);
    assert.strictEqual((await detail(U.pm, e.id)).dev_confirm.status, 'not_approved');
    assert.strictEqual((await get(U.pm, `/sysbuild/confirm-tasks/${t.tid}`)).body.actions.reissue, false, '不认可后：标志同源为假');
    const rr = await post(U.pm, `/sysbuild/confirm-tasks/${t.tid}/reissue`, { reason: '想让负责人再认可一次' });
    expectErr(rr, 409, 'SYSBUILD_STATE', '不认可后直接改发');
    assert.strictEqual(await revCount(t.tid), 1, '不新增修订');
    const d1 = await detail(U.pm, e.id);
    assert.deepStrictEqual([d1.dev_confirm.status, (await devTask(e.id)).status], ['not_approved', 'rejected'], '认可状态仍是未认可');
    // ② 认可后改发 409
    const e2 = await regDevOk(U.x2, s.pid, { title: '另一条说明' });
    assert.strictEqual((await decideAs(U.x1, e2)).status, 200);
    const t2 = await devTask(e2.id);
    assert.strictEqual(t2.status, 'confirmed');
    assert.strictEqual((await get(U.pm, `/sysbuild/confirm-tasks/${t2.tid}`)).body.actions.reissue, false, '认可后：标志同源为假');
    expectErr(await post(U.pm, `/sysbuild/confirm-tasks/${t2.tid}/reissue`, { reason: '已认可还改发' }), 409, 'SYSBUILD_STATE', '认可后改发');
    assert.strictEqual(await revCount(t2.tid), 1);
    // ③ 对照：待确认的任务（修订待确认，换人场景）标志为真、改发成功
    const e3 = await regDevOk(U.x2, s.pid, { title: '待确认的说明' });
    const t3 = await devTask(e3.id);
    assert.strictEqual((await get(U.pm, `/sysbuild/confirm-tasks/${t3.tid}`)).body.actions.reissue, true, '对照：待确认标志为真');
    const ok = await post(U.pm, `/sysbuild/confirm-tasks/${t3.tid}/reissue`, { reason: '对照：待确认可改发' });
    assert.strictEqual(ok.status, 200, ok.text);
    assert.deepStrictEqual([ok.body.revision.rev_no, ok.body.revision.status], [2, 'pending']);
    // 出路是修订重提：旧登记保留，新登记引用它
    const rv = await regDevOk(U.x2, s.pid, { revision_of_entry_id: e.id });
    assert.strictEqual(rv.revision_of_entry_id, e.id);
  });

  test(`${T_W_GATE}——需要开发方认可的登记 = 作出推进类确认：项目已终止 / 已结项时登记 409「项目已终止 / 已结项，开发方关键事项不能再提交认可」并整笔回滚（负责人本人提交并确认、代表人、一般成员、PM 代登的一般用途带承诺补充登记都一样，不留登记 / 任务 / 浏览记录 / 确认记录）；进行中 / 已暂停放行；PM 对开发方来源登记补标涉及承诺同样 409（读接口 actions.mark_commitment 同源为假），需求方来源 / 处理说明用途的补标不受影响；项目重开后恢复`, async () => {
    const s = await mkScene();
    const counts = async (pid) => ({
      entries: await countOf('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE project_id = ?', [pid]),
      tasks: await countOf('SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE project_id = ?', [pid]),
      revisions: await countOf('SELECT COUNT(*) AS n FROM sysbuild_confirm_task_revisions r JOIN sysbuild_confirm_tasks t ON t.id = r.task_id WHERE t.project_id = ?', [pid]),
      confirmations: await countOf('SELECT COUNT(*) AS n FROM sysbuild_confirmations c JOIN sysbuild_confirm_task_revisions r ON r.id = c.task_revision_id JOIN sysbuild_confirm_tasks t ON t.id = r.task_id WHERE t.project_id = ?', [pid]),
      views: await countOf("SELECT COUNT(*) AS n FROM sysbuild_views WHERE object_type = 'dev_entry' AND object_version_id IN (SELECT id FROM sysbuild_entries WHERE project_id = ?)", [pid]),
      events: await countOf('SELECT COUNT(*) AS n FROM sysbuild_events WHERE project_id = ?', [pid]),
    });
    const withCommit = (extra) => Object.assign({}, COMMIT_EV, { commitment_flag: 1 }, extra || {});
    // 进行中 / 已暂停：放行（对照）
    const a1 = await regOk(U.x1, s.pid, withCommit());
    assert.strictEqual(a1.dev_confirm.status, 'approved', '进行中：负责人本人提交并确认');
    assert.strictEqual((await setStatus(s.pid, 'paused')).status, 200);
    assert.strictEqual((await regOk(U.x3, s.pid, withCommit())).dev_confirm.status, 'pending', '已暂停：放行');
    assert.strictEqual((await setStatus(s.pid, 'active')).status, 200);
    // 夹具：终止前登记好几条（开发方来源一般登记 e / 需求方来源 d / 处理说明 dn / 开发方来源但已有承诺 ec）
    const e = await regOk(U.x3, s.pid);
    const d = await regOk(U.m1, s.pid);
    const dn = await regDevOk(U.x2, s.pid, { type: 'feedback' });
    assert.strictEqual((await detail(U.pm, e.id)).actions.mark_commitment, true, '对照：进行中开发方来源登记可补标（标志）');
    assert.strictEqual((await setStatus(s.pid, 'terminated')).status, 200);
    // 已终止：登记 409，整笔回滚
    const before = await counts(s.pid);
    for (const [uid, extra, label] of [[U.x1, {}, '负责人本人（本人提交并确认）'], [U.x2, {}, '代表人'], [U.x3, {}, '一般成员'], [U.pm, { source_party_id: s.D }, 'PM 代登']]) {
      const r = await reg(uid, s.pid, withCommit(extra));
      expectErr(r, 409, 'SYSBUILD_PROJECT_READONLY', `已终止 × ${label}`);
      assert.ok(r.body.message.includes('项目已终止 / 已结项，开发方关键事项不能再提交认可'), r.body.message);
      assert.deepStrictEqual(await counts(s.pid), before, `${label}：整笔回滚，不留登记 / 任务 / 浏览记录 / 确认记录 / 事件`);
    }
    // 对照：已终止下不需要认可的补充登记照常（需求方来源带承诺 / 开发方来源不带承诺）
    assert.strictEqual((await regOk(U.m1, s.pid, withCommit())).dev_confirm.status, 'none', '对照：需求方来源带承诺不建任务');
    assert.strictEqual((await regOk(U.x3, s.pid)).dev_confirm.status, 'none', '对照：开发方来源不带承诺');
    // PM 补标：开发方来源的一般登记 409 + 标志为假；需求方来源 / 处理说明用途照常
    const ac = await counts(s.pid);
    assert.strictEqual((await detail(U.pm, e.id)).actions.mark_commitment, false, '已终止：开发方来源登记补标标志为假（读接口同源）');
    const mk = await act(U.pm, e.id, { action: 'mark_commitment', reason: '终止后补标' });
    expectErr(mk, 409, 'SYSBUILD_PROJECT_READONLY', '已终止补标');
    assert.ok(mk.body.message.includes('开发方关键事项不能再提交认可'), mk.body.message);
    assert.deepStrictEqual(await counts(s.pid), ac, '补标被拒不留办理记录 / 任务 / 事件');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_entry_actions WHERE entry_id = ? AND action = 'mark_commitment'", [e.id]), 0);
    assert.strictEqual((await detail(U.pm, d.id)).actions.mark_commitment, true, '需求方来源：标志为真');
    assert.strictEqual((await act(U.pm, d.id, { action: 'mark_commitment', reason: '补标' })).status, 201, '需求方来源补标照常');
    assert.strictEqual((await detail(U.pm, dn.id)).actions.mark_commitment, true, '处理说明用途：补标不建任务，标志为真');
    assert.strictEqual((await act(U.pm, dn.id, { action: 'mark_commitment', reason: '补标' })).status, 201, '处理说明用途补标照常');
    // 重开后恢复
    assert.strictEqual((await setStatus(s.pid, 'active')).status, 200);
    assert.strictEqual((await detail(U.pm, e.id)).actions.mark_commitment, true, '重开后标志恢复');
    assert.strictEqual((await act(U.pm, e.id, { action: 'mark_commitment', reason: '重开后补标' })).status, 201);
    assert.strictEqual((await regOk(U.x3, s.pid, withCommit())).dev_confirm.status, 'pending', '重开后登记恢复');
    // 已结项（C6 才有生产写入口，夹具直接改状态）：同样 409
    const s2 = await mkScene();
    const e2 = await regOk(U.x3, s2.pid);
    await sqlRun("UPDATE sysbuild_projects SET status = 'closed' WHERE id = ?", [s2.pid]);
    const before2 = await counts(s2.pid);
    const rc = await reg(U.x1, s2.pid, withCommit());
    expectErr(rc, 409, 'SYSBUILD_PROJECT_READONLY', '已结项登记');
    assert.ok(rc.body.message.includes('开发方关键事项不能再提交认可'), rc.body.message);
    assert.deepStrictEqual(await counts(s2.pid), before2, '已结项：整笔回滚');
    assert.strictEqual((await detail(U.pm, e2.id)).actions.mark_commitment, false, '已结项：补标标志为假');
    expectErr(await act(U.pm, e2.id, { action: 'mark_commitment', reason: '结项后补标' }), 409, 'SYSBUILD_PROJECT_READONLY', '已结项补标');
    assert.strictEqual((await regOk(U.m1, s2.pid, withCommit())).dev_confirm.status, 'none', '对照：已结项需求方来源带承诺照常');
  });

  test(`${T_W_SPLIT}——预筛快看 N1：开发方负责人未认可（not_approved）的登记，PM 取消涉及承诺后也不能拆分（不再「需要认可」但拆分会洗掉未认可）：手动拆分 409（actions.split 同源为假）、补选归属到混合去向的自动拆分 409（带系统迭代引导）；不留子项 / 办理记录；对照：已认可的同类登记取消承诺后可拆、可补选混合去向；补标后（状态仍是未认可）依旧不可拆`, async () => {
    const s = await mkScene({ plan: true });
    const o1 = await mkItem(s.pid);
    const o2 = await mkItem(s.pid);
    const rejectIt = async (e) => {
      const t = await devTask(e.id);
      await get(U.x1, `/sysbuild/confirm-tasks/${t.tid}`);
      const r = await post(U.x1, `/sysbuild/confirm-tasks/${t.tid}/decide`, decideBody(t.rid, e.id, 'reject'));
      assert.strictEqual(r.status, 200, r.text);
      assert.strictEqual((await detail(U.pm, e.id)).dev_confirm.status, 'not_approved');
    };
    const kids = (eid) => countOf('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE parent_entry_id = ?', [eid]);
    // ① 手动拆分
    const e = await regOk(U.x3, s.pid, Object.assign({ item_ids: [o1.id, o2.id] }, COMMIT_EV, { commitment_flag: 1 }));
    await rejectIt(e);
    await actOk(U.pm, e.id, { action: 'unmark_commitment', reason: '取消承诺' });
    const d = await detail(U.pm, e.id);
    assert.deepStrictEqual([d.dev_confirm.required, d.dev_confirm.status, d.commitment_current], [false, 'not_approved', false], '前置：已不需要认可，但状态是未认可');
    assert.strictEqual(d.actions.split, false, '标志同源为假');
    const sp = await act(U.pm, e.id, { action: 'split', groups: [[o1.id], [o2.id]] });
    expectErr(sp, 409, 'SYSBUILD_STATE', '未认可的登记取消承诺后拆分');
    assert.strictEqual(sp.body.message, '开发方负责人未认可的登记不能拆分，请修订重提');
    assert.strictEqual(await kids(e.id), 0, '不留子项');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_entry_actions WHERE entry_id = ? AND action = 'split'", [e.id]), 0, '不留拆分办理记录');
    // 补标后（认可状态仍是未认可）依旧不可拆（这时走「需要认可」的判定）
    await actOk(U.pm, e.id, { action: 'mark_commitment', reason: '再补标' });
    expectErr(await act(U.pm, e.id, { action: 'split', groups: [[o1.id], [o2.id]] }), 409, 'SYSBUILD_STATE', '补标后仍不可拆');
    assert.strictEqual(await kids(e.id), 0);
    // ② 补选归属到混合去向（既有未上线又有已上线）
    await golive(await defaultBatchId(s.pid));
    const live = (await sqlGet('SELECT item_id FROM sysbuild_item_versions WHERE id = ?', [s.eff.itemVersionId])).item_id;
    const inPlan2 = await (async () => {
      const it = await mkItem(s.pid);
      const b2 = (await sqlRun("INSERT INTO sysbuild_batches (project_id, seq, name, is_default, status) VALUES (?, 2, '第 2 批', 0, 'planning')", [s.pid])).lastID;
      await sqlRun("INSERT INTO sysbuild_package_item_revisions (package_version_id, item_version_id, committed_batch_id, op, created_by) VALUES (?, ?, ?, 'add', ?)", [s.eff.pv, it.versions[0].id, b2, U.pm]);
      return it.id;
    })();
    const pend = await regOk(U.x3, s.pid, Object.assign({}, COMMIT_EV, { commitment_flag: 1 }));
    await rejectIt(pend);
    await actOk(U.pm, pend.id, { action: 'unmark_commitment', reason: '取消承诺' });
    const asg = await act(U.pm, pend.id, { action: 'assign_items', basis_category: 'in_plan', text: '判定依据', item_ids: [live, inPlan2] });
    expectErr(asg, 409, 'SYSBUILD_STATE', '未认可的登记混合补选');
    assert.strictEqual(asg.body.message, '开发方负责人未认可的登记不能拆分，请修订重提');
    assert.strictEqual(asg.body.guide, 'sys_iteration');
    assert.deepStrictEqual(asg.body.live_items.map((x) => x.item_id), [live]);
    assert.strictEqual(await kids(pend.id), 0, '不留子项');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_entry_items WHERE entry_id = ?", [pend.id]), 0, '回滚：不留关联条目');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_entry_actions WHERE entry_id = ? AND action = 'assign_items'", [pend.id]), 0, '回滚：不留归属办理记录');
    // ③ 对照：已认可的同类登记取消承诺后可以拆、可以补选混合去向
    const ok1 = await regOk(U.x3, s.pid, Object.assign({ item_ids: [o1.id, o2.id] }, COMMIT_EV, { commitment_flag: 1 }));
    assert.strictEqual((await decideAs(U.x1, ok1)).status, 200);
    await actOk(U.pm, ok1.id, { action: 'unmark_commitment', reason: '取消承诺' });
    assert.strictEqual((await detail(U.pm, ok1.id)).actions.split, true, '对照：已认可后取消承诺，标志为真');
    assert.strictEqual((await act(U.pm, ok1.id, { action: 'split', groups: [[o1.id], [o2.id]] })).status, 201, '对照：已认可的可拆');
    const ok2 = await regOk(U.x3, s.pid, Object.assign({}, COMMIT_EV, { commitment_flag: 1 }));
    assert.strictEqual((await decideAs(U.x1, ok2)).status, 200);
    await actOk(U.pm, ok2.id, { action: 'unmark_commitment', reason: '取消承诺' });
    const mix = await act(U.pm, ok2.id, { action: 'assign_items', basis_category: 'in_plan', text: '判定依据', item_ids: [live, inPlan2] });
    assert.strictEqual(mix.status, 201, mix.text);
    assert.strictEqual(mix.body.children.length, 2, '对照：已认可的混合补选自动拆成两个处理项');
  });
}

// ── 变异 ───────────────────────────────────────────────────────────────────────────────────────
const dm = (id, expect, file, from, to) => ({ id: `${P}${id}`, expect, edits: [{ file, from, to }] });
const zm = (id, expect, file, from, to) => ({ id: `${Z}${id}`, expect, edits: [{ file, from, to }] });
const DEVKEY_MUTATIONS = [
  // ── rules.js ──
  dm('写关键事项对开发方成员一律放行', [T_WHO, T_RULES], 'rules.js', 'return ownsParty(identity, dp) || (Array.isArray(identity.delegateOfParties) && identity.delegateOfParties.includes(dp));', 'return true;'),
  dm('开发方代表人不能写关键事项', [T_WHO, T_RULES], 'rules.js', ' || (Array.isArray(identity.delegateOfParties) && identity.delegateOfParties.includes(dp));\n    },\n    state: noStateLimit,', ';\n    },\n    state: noStateLimit,'),
  dm('开发方负责人不能写关键事项', [T_WHO, T_RULES, T_SELF], 'rules.js', 'return ownsParty(identity, dp) || (Array.isArray(identity.delegateOfParties)', 'return false || (Array.isArray(identity.delegateOfParties)'),
  dm('PM 不能代登关键事项', [T_WHO, T_RULES], 'rules.js', 'if (identity.isReadonly) return false;\n      if (identity.isPm) return true;', 'if (identity.isReadonly) return false;'),
  dm('只读账号可写关键事项（只读否决去掉）', [T_RULES], 'rules.js', 'if (identity.isReadonly) return false;\n      if (identity.isPm) return true;', 'if (identity.isPm) return true;'),
  // 修订批 3 改写：写关键事项在已终止 / 已结项下另被 entries-core.requestDevConfirm 的项目状态判定（H2，建认可任务的唯一落点）挡住，单放宽 entry_create_dev 的类别被它遮蔽（同一个 409），
  //   所以这条两处一起放开才复现「已终止还能写开发方关键事项」；规则表本身的类别由 T_RULES 的手写矩阵单独钉住（见本文件末尾「修订批 3」段的单拆变异）
  { id: `${P}写关键事项项目状态类别放宽成 resolve`, expect: [T_WHO, T_RULES], edits: [
    { file: 'rules.js', from: "entry_create_dev: 'accept',", to: "entry_create_dev: 'resolve'," },
    { file: 'entries-core.js', from: 'if (projectBlock) throw makeError(409, projectBlock.code, projectBlock.message);', to: '' },
  ] },
  dm('开发用途的登记可以拆分', [T_RULES], 'rules.js', "if (ENTRY_DEV_PURPOSES.includes(t.purpose)) return '开发方处理说明 / 正式交付物用途的登记不进分流，不能拆分';", ''),
  dm('需要认可的登记可以拆分', [T_COMMIT, T_RULES], 'rules.js', "if (t.needsDevConfirm === true) return '需要开发方负责人认可的登记不能拆分';", ''),
  dm('开发用途的登记可以补选归属', [T_ROUTE, T_RULES], 'rules.js', "if (ENTRY_DEV_PURPOSES.includes(t.purpose)) return '开发方处理说明 / 正式交付物用途的登记不进分流，不需要归属'; // C5 S-S1c（派单 0b 冲突 5）", ''),
  dm('被引用的处理说明可以作废', [T_BASIS, T_RULES], 'rules.js', "if (t.usedAsBasis === true) return '该登记已被引用为办理依据，不能作废';", ''),
  dm('改发不支持开发方关键事项任务', [T_TERM, T_RULES], 'rules.js', "['package_version', 'item_version', 'dev_entry', 'handover'].includes(t.objectType)", "['package_version', 'item_version', 'handover'].includes(t.objectType)"),
  zm('裁定通过后不算有效结论', [T_Z_ADJ], 'rules.js', "const EFFECTIVE_CONCLUSION_STATES = Object.freeze(['settled_no_confirm', 'confirmed', 'adjudicated', 'for_reference']);", "const EFFECTIVE_CONCLUSION_STATES = Object.freeze(['settled_no_confirm', 'confirmed', 'for_reference']);"),
  // ── entries-core.js ──
  zm('原登记人依据不看登记时身份', [T_Z_REG], 'entries-core.js', "if (Number(entry.operator_user_id) === me && parseSnapshot(entry).is_pm === false) return 'registrant';", "if (Number(entry.operator_user_id) === me) return 'registrant';"),
  dm('开发方来源带承诺的登记不算需要认可', [T_COMMIT], 'entries-core.js', 'return commitmentCurrent === true && (await isDevParty(q, entry.source_party_id));', 'return false;'),
  dm('不认可的修订算已认可', [T_DECIDE, T_BASIS], 'entries-core.js', "rejected: 'not_approved', objected: 'not_approved'", "rejected: 'approved', objected: 'not_approved'"),
  dm('已确认的修订算待认可', [T_SELF, T_DECIDE], 'entries-core.js', "{ pending: 'pending', confirmed: 'approved',", "{ pending: 'pending', confirmed: 'pending',"),
  dm('失效的修订算不认可', [T_TERM, T_VOID], 'entries-core.js', "invalid: 'lapsed', superseded: 'lapsed' });\n// 该登记最近一条认可任务", "invalid: 'not_approved', superseded: 'lapsed' });\n// 该登记最近一条认可任务"),
  dm('已有当前有效认可也重复建任务', [T_COMMIT], 'entries-core.js', "if (cur.status === 'pending' || cur.status === 'approved') return { created: false,", "if (false) return { created: false,"),
  dm('开发方暂无负责人也建任务', [T_WHO, T_COMMIT], 'entries-core.js', "if (!owner) throw stateError('开发方暂无负责人，请先完成任职');", ''),
  dm('建认可任务不冻结登记附件', [T_TASK], 'entries-core.js', 'await ensureEntryFrozen(q, attachmentHelpers, user, entry);\n  const t = await core.createTaskWithRevision', 'const t = await core.createTaskWithRevision'),
  dm('登记人是负责人也不自认可', [T_SELF, T_COMMIT], 'entries-core.js', 'return !!m && m.user_id !== null && Number(m.user_id) === Number(user.id) && Number(operatorUserId) === Number(user.id);', 'return false;'),
  dm('自认可的浏览记录来源写成 page', [T_SELF], 'entries-core.js', "VALUES (?, 'dev_entry', ?, 'self_submit', ?)", "VALUES (?, 'dev_entry', ?, 'page', ?)"),
  dm('自认可的确认记录不写勾选文案', [T_SELF], 'entries-core.js', "[t.revisionId, entry.id, uid, opts.selfConfirmText, v.lastID]", "[t.revisionId, entry.id, uid, 'x', v.lastID]"), // 预筛 Q2：文案取请求提交值
  dm('作废的关键事项也能作依据 / 改期引用', [T_BASIS, T_SCHED], 'entries-core.js', "if (await entryVoidedOf(q, entry.id)) return { ok: false, reason: '该登记已作废' };", ''),
  dm('待认可的关键事项也能作依据 / 改期引用', [T_BASIS, T_SCHED], 'entries-core.js', "if (dc.status === 'approved') return { ok: true, reason: null };", "if (dc.status === 'approved' || dc.status === 'pending') return { ok: true, reason: null };"),
  dm('是否被引用为依据恒为假', [T_BASIS], 'entries-core.js', "const usedAsBasis = entry.purpose === 'dev_note'", "const usedAsBasis = false && entry.purpose === 'dev_note'"),
  dm('认可任务查询不限本登记', [T_COMMIT, T_TASK], 'entries-core.js', "WHERE object_type = 'dev_entry' AND object_id = ? ORDER BY id DESC LIMIT 1\",\n    [entry.id]", "WHERE object_type = 'dev_entry' ORDER BY id DESC LIMIT 1\",\n    []"),
  // ── entries.js ──
  dm('开发用途不查写入权限', [T_WHO], 'entries.js', "if (rules.ENTRY_DEV_PURPOSES.includes(input.purpose)) rules.assertOp('entry_create_dev'", "if (false) rules.assertOp('entry_create_dev'"),
  dm('关键事项来源方不必是开发方', [T_WHO], 'entries.js', "if (!(await entries.isDevParty(q, sourcePartyId))) throw invalid(", 'if (false) throw invalid('),
  dm('正式交付物可以没有附件', [T_WHO], 'entries.js', "if (input.purpose === 'deliverable' && input.attachmentIds.length === 0) throw makeError(", 'if (false) throw makeError('),
  dm('修订重提不要求旧登记负责人未认可', [T_REVISE], 'entries.js', "if ((await entries.devConfirmOf(q, old)).status !== 'not_approved') throw stateError(", 'if (false) throw stateError('),
  dm('修订重提不要求用途一致', [T_REVISE], 'entries.js', 'if (old.purpose !== input.purpose) throw invalid(', 'if (false) throw invalid('),
  dm('修订重提不校验旧登记归属', [T_REVISE], 'entries.js', "if (!old) throw invalid('被修订的登记不存在或不属于本项目', 'revision_of_entry_id');", ''),
  dm('开发用途的登记也分流', [T_ROUTE], 'entries.js', "if (rules.ENTRY_HANDLED_TYPES.includes(input.type) && input.purpose === 'general') {", 'if (rules.ENTRY_HANDLED_TYPES.includes(input.type)) {'),
  dm('需要认可的登记混合分流不拦', [T_COMMIT], 'entries.js', 'if (parts.length > 1 && needsDev) {', 'if (false) {'),
  dm('登记时不建认可任务', [T_TASK, T_SELF, T_COMMIT], 'entries.js', 'if (needsDev) {\n      const row0', 'if (false) {\n      const row0'),
  dm('办理依据可以是未认可的登记', [T_BASIS], 'entries.js', 'if (!ap.ok) throw stateError(', 'if (false) throw stateError('),
  dm('办理依据不要求是处理说明', [T_BASIS], 'entries.js', "if (be.id === entry.id || be.purpose !== 'dev_note') throw invalid(", 'if (false) throw invalid('),
  dm('办理依据不存', [T_BASIS], 'entries.js', "input.basisEntryId === null ? null : 'dev_note_version', input.basisEntryId, uid]", 'null, null, uid]'),
  dm('conclude 不收办理依据字段', [T_BASIS], 'entries.js', "'change_id', 'basis_dev_note_entry_id']),", "'change_id']),"),
  dm('补标涉及承诺不建认可任务', [T_COMMIT], 'entries.js', 'devRequest = await entries.requestDevConfirm(q, user, attachmentHelpers, entry, { registrantIsPm: true });', 'devRequest = null;'),
  dm('取消涉及承诺不让待确认修订失效', [T_COMMIT], 'entries.js', 'closed = await entries.invalidatePendingDevRevisions(q, user, entry, entries.DEV_CANCELLED_COMMITMENT_REASON);', ''),
  dm('作废不让待认可修订失效', [T_VOID], 'entries.js', 'closed = closed.concat(await entries.invalidatePendingDevRevisions(q, user, entry, entries.DEV_VOIDED_REASON));', ''),
  dm('补标 / 取消承诺对处理说明也生效', [T_COMMIT], 'entries.js', "if (entry.purpose === 'general' && (await entries.isDevParty(q, entry.source_party_id))) {", 'if ((await entries.isDevParty(q, entry.source_party_id))) {'),
  // 修订批 3 改写：原锚点（entries.js 补标分支里的一行 accept 判定）已移到 rules entry_mark_commitment（读接口同源）+ entries-core.requestDevConfirm（建任务唯一落点）两道，
  //   补标执行被两道同时挡住，所以「补标也建任务」要两处一起去掉才复现（单去一处另一道仍拦）；各自单拆的变异见本文件末尾「修订批 3」段
  { id: `${P}已终止项目补标也建认可任务`, expect: [T_COMMIT, T_W_GATE], edits: [
    { file: 'rules.js', from: '        const blocked = devConfirmProjectBlock(t.projectStatus);\n        if (blocked) return blocked;\n', to: '' },
    { file: 'entries-core.js', from: 'if (projectBlock) throw makeError(409, projectBlock.code, projectBlock.message);', to: '' },
  ] },
  dm('读接口不带认可状态', [T_TASK, T_SELF], 'entries.js', 'dev_confirm: devConfirm,', 'dev_confirm: null,'),
  dm('补选归属不禁止需要认可的登记拆分', [T_COMMIT], 'entries.js', 'noSplit: target.needsDevConfirm === true', 'noSplit: false'),
  // ── entries-routing.js（0c）──
  zm('拆分子项取消记录不发事件', [T_Z_SPLIT], 'entries-routing.js', "objectId: id, eventType: 'entry_action_recorded',", "objectId: id, eventType: 'entry_split',"),
  zm('拆分子项取消记录事件缺来源标记', [T_Z_SPLIT], 'entries-routing.js', "closed_revision_ids: [], via: 'split_cancel', parent_entry_id: parent.id }", 'closed_revision_ids: [] }'),
  zm('混合补选的 409 不带系统迭代清单', ['C5 分流：待判定归属——assign_items', T_COMMIT], 'entries-routing.js', '{ extra: { guide: \'sys_iteration\', live_items: await describeLiveItems(q, classified) } });\n    }\n    return {', '{ extra: {} });\n    }\n    return {'),
  // ── entries.js（0c：我的知会）──
  zm('来源方负责人知会查询不限仅供参考', [T_Z_NOTICE], 'entries.js', "JOIN sysbuild_members m ON m.id = a.member_id JOIN sysbuild_projects p ON p.id = n.project_id\n          WHERE n.kind = 'for_reference' AND m.user_id = ?", "JOIN sysbuild_members m ON m.id = a.member_id JOIN sysbuild_projects p ON p.id = n.project_id\n          WHERE m.user_id = ?"),
  zm('来源方代表人知会查询不限仅供参考', [T_Z_NOTICE], 'entries.js', "JOIN sysbuild_members m ON m.id = d.member_id JOIN sysbuild_projects p ON p.id = n.project_id\n          WHERE n.kind = 'for_reference' AND m.user_id = ?", "JOIN sysbuild_members m ON m.id = d.member_id JOIN sysbuild_projects p ON p.id = n.project_id\n          WHERE m.user_id = ?"),
  zm('原登记人知会查询不限仅供参考', [T_Z_NOTICE], 'entries.js', "WHERE n.kind = 'for_reference' AND e.operator_user_id = ?", 'WHERE e.operator_user_id = ?'),
  // ── confirm.js / confirm-core.js ──
  dm('开发方关键事项认可不能代录', [T_PROXY], 'confirm.js', "'conclusion_confirm', 'dev_key_confirm', 'handover_accept_issue', 'handover_no_further']);", "'conclusion_confirm', 'handover_accept_issue', 'handover_no_further']);"), // C6a：清单加了两个交接确认用途，锚点随之改写
  dm('开发方关键事项认可可以有异议', [T_DECIDE, T_PROXY], 'confirm.js', "dev_key_confirm: Object.freeze(['confirm', 'reject']),\n  handover_accept_issue", "dev_key_confirm: Object.freeze(['confirm', 'reject', 'object']),\n  handover_accept_issue"),
  dm('认可任务不校验决策取值', [T_DECIDE, T_PROXY], 'confirm.js', 'if (!hasKey(ENTRY_TASK_DECISIONS, task.purpose)) return;', 'if (!isEntryTask(task)) return;'), // C6a：判定改为查决策取值表（交接确认也在表里），锚点随之改写
  dm('认可任务改发不重新解析负责人', [T_TERM], 'confirm.js', "if (c.task.object_type === 'dev_entry') {\n      // 预筛 L1", "if (false) {\n      // 预筛 L1"), // 预筛修订：改发分支前加了 L1 / M4 校验，锚点随之改写
  dm('认可任务的冻结清单不取登记附件', [T_DECIDE], 'confirm-core.js', "|| task.object_type === 'adjudication' || task.object_type === 'dev_entry' || task.object_type === 'handover') return { objectType: 'entry'", "|| task.object_type === 'adjudication' || task.object_type === 'handover') return { objectType: 'entry'"),
  // ── plan.js ──
  dm('开发方改期不要求关键事项', [T_SCHED], 'plan.js', "if (devKeyEntryId === null) throw stateError('开发方提出的改期须引用开发方负责人已认可的关键事项（dev_key_entry_id）');", ''),
  dm('改期引用的关键事项不要求是提出方的登记', [T_SCHED], 'plan.js', 'if (ke.source_party_id !== sourcePartyId) throw stateError(', 'if (false) throw stateError('),
  dm('改期引用的关键事项不要求已认可', [T_SCHED], 'plan.js', 'if (!ap.ok) throw stateError(`引用的关键事项未认可：${ap.reason}`);', ''),
  dm('改期记录不存关键事项引用', [T_SCHED], 'plan.js', 'reason, sourcePartyId, devKeyEntryId, noEvidence ? 1 : 0,', 'reason, sourcePartyId, null, noEvidence ? 1 : 0,'),
  dm('需求方来源带关键事项引用不拒', [T_SCHED], 'plan.js', "        } else if (devKeyEntryId !== null) {\n          throw invalid('只有开发方提出的改期需要引用关键事项', 'dev_key_entry_id');", "        } else if (false) {\n          throw invalid('只有开发方提出的改期需要引用关键事项', 'dev_key_entry_id');"),
  dm('没有来源方带关键事项引用不拒', [T_SCHED], 'plan.js', "      } else if (devKeyEntryId !== null) {\n        throw invalid('只有开发方提出的改期需要引用关键事项', 'dev_key_entry_id');", "      } else if (false) {\n        throw invalid('只有开发方提出的改期需要引用关键事项', 'dev_key_entry_id');"),
  dm('草稿期带关键事项引用不拒', [T_SCHED], 'plan.js', 'if (sourcePartyId !== null || devKeyEntryId !== null || attachmentIds.length > 0', 'if (sourcePartyId !== null || attachmentIds.length > 0'),
  // ── 预筛修订批（M4 / M5 / L1 / L2 / L3 / Q2）──
  dm('已失效的认可改发不看失效原因', [T_Y_REISSUE], 'confirm.js', "if (c.latest.status_reason !== core.PROJECT_TERMINATED_REASON) return { isDelegate: false, cur: null, blocked: '该认可已失效（取消涉及承诺 / 登记作废），不能改发；需要时请重新标记涉及承诺或修订重提', historyConflict: null };", ''),
  dm('终止失效的认可改发不看登记是否仍需认可', [T_Y_REISSUE], 'confirm.js', "if (c.obj.de.needsDevConfirm !== true) return { isDelegate: false, cur: null, blocked: '该登记已不需要开发方负责人认可（已取消涉及承诺），不能改发', historyConflict: null };", ''),
  dm('旧的认可任务也能改发', [T_Y_REISSUE], 'confirm.js', "if (c.obj.de.isLatest !== true) return { isDelegate: false, cur: null, blocked: '该认可任务已被本登记新的认可任务取代，不能改发', historyConflict: null };", ''),
  dm('认可任务对象的「仍需认可」事实恒为真', [T_Y_REISSUE], 'entries-core.js', '(await loadEntryFacts(q, entry, { skipChildren: true })).derived.commitment_current === true', '(await loadEntryFacts(q, entry, { skipChildren: true })).derived.commitment_current !== undefined'),
  dm('认可任务对象的「最新任务」事实恒为真', [T_Y_REISSUE], 'entries-core.js', 'pending: !voided && isLatest, isLatest, needsDevConfirm,', 'pending: !voided && isLatest, isLatest: true, needsDevConfirm,'),
  // 修订批 3 L5 改写：原锚点（not_approved 抛 409）改为「不建任务、早返回」；两条：去掉早返回（补标重新发起认可）、改回抛 409（补标被拒）
  dm('未认可的登记补标承诺可重新发起认可', [T_Y_WASH], 'entries-core.js', "if (cur.status === 'not_approved') return { created: false, taskId: cur.task.id, revisionId: cur.revision.id, requiredMemberId: cur.revision.required_member_id, selfSubmit: false };", ''),
  dm('未认可的登记补标承诺被拒（原预筛 M5 的 409 写法）', [T_Y_WASH], 'entries-core.js', "if (cur.status === 'not_approved') return { created: false, taskId: cur.task.id, revisionId: cur.revision.id, requiredMemberId: cur.revision.required_member_id, selfSubmit: false };", "if (cur.status === 'not_approved') throw stateError('开发方负责人未认可，请修订重提');"),
  dm('改期引用的关键事项可以作废', [T_Y_VOIDKEY], 'rules.js', "if (t.usedAsScheduleKey === true) return '该登记已被引用为改期依据（关键事项），不能作废';", ''),
  dm('改期引用事实不查改期记录', [T_Y_VOIDKEY], 'entries-core.js', "const usedAsScheduleKey = !!(await q.get('SELECT id FROM sysbuild_node_schedule_records WHERE dev_key_entry_id = ? LIMIT 1', [entry.id]));", 'const usedAsScheduleKey = false;'),
  dm('修订重提不核来源方', [T_Y_REVSRC], 'entries.js', "if ((old.source_party_id === null || old.source_party_id === undefined ? null : old.source_party_id) !== sourcePartyId) throw invalid('修订重提的来源方必须与被修订的登记一致', 'source_party_id'); // 预筛 L3", ''),
  dm('本人提交并确认不校验确认文案', [T_Y_SELFTEXT], 'entries-core.js', "if (selfSubmit && (!opts || opts.selfConfirmText !== core.CHECKBOX_TEXTS.confirm)) {", 'if (false) {'),
  dm('确认文案取固定值而不是请求提交的值', [T_Y_SELFTEXT], 'entries-core.js', '[t.revisionId, entry.id, uid, opts.selfConfirmText, v.lastID]', '[t.revisionId, entry.id, uid, core.CHECKBOX_TEXTS.object, v.lastID]'),
  dm('登记键白名单漏掉确认文案', [T_Y_SELFTEXT, T_SELF], 'entries.js', "'objects_entry_id', 'revision_of_entry_id', 'self_confirm_text',\n]);", "'objects_entry_id', 'revision_of_entry_id',\n]);"),
  dm('登记请求不收确认文案', [T_Y_SELFTEXT, T_SELF], 'entries.js', "const selfConfirmText = typeof body.self_confirm_text === 'string' ? body.self_confirm_text : null;", 'const selfConfirmText = null;'),
  // ── 修订批 3（codex 26 H1 / H2、预筛快看 N1 / L5）──
  //   H1：认可改发的「已作出决定」判定与 rules.confirm_reissue 的「对象已不是待确认」（对象状态由 loadDevTaskObject 派生）互为两道防线，单拆一道另一道仍拦——所以这条两处一起拆（模拟「对象状态没拦住」时显式判定是否独立成立）
  { id: `${W}认可改发不拒已作出决定的修订（对象状态防线一并拆）`, expect: [T_W_REISSUE], edits: [
    { file: 'confirm.js', from: "if (c.latest.status !== 'pending' && c.latest.status !== 'invalid') return { isDelegate: false, cur: null, blocked: '开发方负责人已作出认可 / 不认可，不能改发；不认可的出路是修订重提', historyConflict: null };", to: '' },
    { file: 'entries-core.js', from: "else if (own && (own.status === 'pending' || own.status === 'invalid')) status = 'pending';", to: "else status = 'pending';" },
  ] },
  //   H2：建任务唯一落点（requestDevConfirm）、读接口 / 补标规则、判定函数、两个目标事实各一条
  dm('登记需要认可的事项不核项目状态（建任务落点）', [T_W_GATE], 'entries-core.js', 'if (projectBlock) throw makeError(409, projectBlock.code, projectBlock.message);', ''),
  dm('补标规则不核项目状态（读接口标志与执行的规则判定）', [T_W_GATE, T_RULES], 'rules.js', '        const blocked = devConfirmProjectBlock(t.projectStatus);\n        if (blocked) return blocked;\n', ''),
  dm('提交认可的项目状态判定放宽成 resolve 类（已终止 / 已结项都放行）', [T_W_GATE, T_RULES], 'rules.js', "return projectAllowsWrite(projectStatus, 'accept') ? null :", "return projectAllowsWrite(projectStatus, 'resolve') ? null :"),
  dm('补标规则对「会不会建任务」事实缺失放行', [T_RULES], 'rules.js', '      } else if (t.markNeedsDevTask !== false) return PROXY_FACT_UNKNOWN_MESSAGE;\n', '      }\n'),
  dm('写关键事项的项目状态类别放宽成 resolve（规则表单拆：执行被建任务落点遮蔽，只由规则矩阵钉住）', [T_RULES], 'rules.js', "entry_create_dev: 'accept',", "entry_create_dev: 'resolve',"),
  dm('补标会建任务的事实恒为假', [T_W_GATE], 'entries-core.js', "const markNeedsDevTask = entry.purpose === 'general' && (await isDevParty(q, entry.source_party_id));", 'const markNeedsDevTask = false;'),
  dm('补标会建任务的事实不限一般用途', [T_W_GATE], 'entries-core.js', "const markNeedsDevTask = entry.purpose === 'general' && (await isDevParty(q, entry.source_party_id));", 'const markNeedsDevTask = (await isDevParty(q, entry.source_party_id));'),
  dm('建任务时项目状态读成恒进行中', [T_W_GATE], 'entries-core.js', "const proj = await q.get('SELECT status FROM sysbuild_projects WHERE id = ?', [entry.project_id]);\n  if (!proj) throw internalError('项目不存在，无法建开发方认可任务');", "const proj = { status: 'active' };"),
  // ── N1 ──
  dm('拆分不拦负责人未认可的登记', [T_W_SPLIT, T_RULES], 'rules.js', "if (t.devConfirmStatus === 'not_approved') return ENTRY_DEV_NOT_APPROVED_SPLIT_MESSAGE;", ''),
  dm('拆分对认可状态事实缺失放行', [T_RULES], 'rules.js', "if (typeof t.devConfirmStatus !== 'string') return PROXY_FACT_UNKNOWN_MESSAGE;", ''),
  dm('补选混合去向不拦负责人未认可的登记', [T_W_SPLIT], 'entries-routing.js', 'if (opts && opts.noSplitNotApproved === true) {', 'if (false) {'),
  dm('补选归属不传负责人未认可事实', [T_W_SPLIT], 'entries.js', ", noSplitNotApproved: target.devConfirmStatus === 'not_approved' })", ' })'),
  dm('认可状态事实恒为 none', [T_W_SPLIT], 'entries-core.js', 'const devConfirmStatus = (await devConfirmOf(q, entry)).status;', "const devConfirmStatus = 'none';"),
];

module.exports = { defineDevKeyCases, DEVKEY_MUTATIONS };
