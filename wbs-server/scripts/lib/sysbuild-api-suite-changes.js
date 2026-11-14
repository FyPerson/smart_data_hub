// 验证脚本库：项目管理（系统建设记录）模块 C5 S-S1c——正式变更（范围变更包）与登记结论「转正式变更」/ 挂靠变更（#113 段 7 C5 S-S1c）的用例与变异
//   方案：docs/local/系统建设记录/系统建设记录_平台集成_方案_20261105_v1.4.md §2.2 不变量 2 / 10、§2.3、§4.1 表「正式变更」、§4.2「范围变更包」、§4.4、§4.5、§7「正式变更」
//   派单：docs/local/系统建设记录/送审准备/C5_S-S1c_正式变更_派单_20261106.md（§1 正式变更；0b 补充裁定；§3 测试清单与本文件的 T_* 常量逐项对应）
//
// 本文件只放用例与变异，由 sysbuild-api-suite.js 登记（同一套夹具、同一个变异自检）。期望值一律手写，不取自被测代码。
// 夹具规则：建项、建变更、集合修订、提交 / 撤回 / 出新版本、确认任务的打开与决策 / 改发 / 代录、登记与办理全部走生产端点；总体规划生效用 produceEffectiveOverall（生产路径）。只有这几类直接写库：
//   ① 需求方 / 开发方参与方、成员、任职、授权（seedParty / addMember）；② 附件行（暂存）；③ 第二个批次（SQL 插一行，造「承诺批次不是默认批次」）；
//   ④ 历史补录窗口状态与历史导入记录（P58 互斥的前置，窗口与导入的生产路径在 history 套件已覆盖）；⑤ 项目状态（暂停 / 终止走生产端点，结项走 SQL）；⑥ 构造「库内与现状不符」：生效时继承来源被篡改；⑦（修订批 3）附件现值被改（UPDATE sysbuild_attachments.sha256，证明冻结清单照抄冻结值而不读现值）、历史补录窗口夹具（SQL 置 closed / open，历史补录确认走生产端点）。
'use strict';
const assert = require('assert');

const P = 'C5 变更：';
const T_CREATE = `${P}建变更`;
const T_EDIT = `${P}集合修订`;
const T_SUBMIT = `${P}提交`;
const T_WITHDRAW = `${P}撤回`;
const T_OBJECT = `${P}出新版本（有异议）`;
const T_STALE = `${P}出新版本（过期草稿）`;
const T_EFFECT = `${P}生效`;
const T_BASELINE = `${P}基线`;
const T_FREEZE = `${P}排期冻结`;
const T_HISTORY = `${P}窗口互斥`;
const T_ENTRY = `${P}转变更与挂靠`;
const T_SHEET = `${P}确认单`;
const T_RULES = `${P}rules`;
const T_FLAGS = `${P}actions 同源`;
const T_REISSUE = `${P}改发与代录`;
const Y = 'C5 预筛4轮：';
const T_Y_IMPORT = `${Y}历史导入不接变更包`;
const T_Y_EVID = `${Y}变更证据提交时重核`;
const T_Y_WINDOW = `${Y}窗口互斥取并集`;
const T_Y_LIVE = `${Y}已上线条目不能移出规划`;
const T_Y_LAPSE = `${Y}转变更结论随变更撤回失效`;
const T_Y_LINK = `${Y}link_change 同源矩阵`;
const W = 'C5 修订批3：';
const T_W_FREEZE = `${W}派生总体版本冻结清单`;
const T_W_PLANS = `${W}派生总体版本节点计划快照`;
const T_W_SUBMITTED = `${W}曾提交按提交事件判定`;
const T_W_ADJ = `${W}裁定通过不随变更撤回失效`;
const T_W_REOPEN = `${W}重开窗口对变更包取并集`;

const EVID = { no_written_evidence: true, no_evidence_reason: '口头电话确认了本次变更内容' };
const CHG = Object.assign({ title: '新增批量导出', body: '范围变更：新增一项批量导出需求' }, EVID);

function defineChangeCases(T) {
  const { test, U, api, sqlRun, sqlGet, sqlAll, expectErr, eventsOf, addMember, addParty, addAppointment, addDelegation, confirm: H } = T;
  const { newProject, seedParty, stageAtt, openAndDecide, produceEffectiveOverall, mkItem, defaultBatchId, tasksOf, confirmAll } = H;
  const post = (uid, url, body) => api(uid, 'POST', url, body === undefined ? {} : body);
  const get = (uid, url) => api(uid, 'GET', url);
  const payloads = async (pid, type) => (await eventsOf(pid, type)).map((e) => JSON.parse(e.payload_json));
  const countOf = async (s, p) => (await sqlGet(s, p)).n;

  // ── 场景与助手 ─────────────────────────────────────────────────────────────────────────────
  // 标准场景：总体规划已经生产路径生效（甲部 own / del、一个条目 i1 在默认批次 batch1、六个节点都有计划与基线）；甲部一般成员 m1（登记人）。
  async function mkScene() {
    const pid = await newProject();
    const eff = await produceEffectiveOverall(pid);
    const batch1 = await defaultBatchId(pid);
    const i1 = (await sqlGet('SELECT item_id FROM sysbuild_item_versions WHERE id = ?', [eff.itemVersionId])).item_id;
    await addMember(pid, U.m1, { party: eff.party });
    return { pid, eff, A: eff.party, batch1, i1, i1v: eff.itemVersionId };
  }
  const mkChange = async (pid, extra) => {
    const r = await post(U.pm, `/sysbuild/projects/${pid}/changes`, Object.assign({}, CHG, extra || {}));
    assert.strictEqual(r.status, 201, r.text);
    return r.body;
  };
  const submitCh = (uid, cid) => post(uid, `/sysbuild/changes/${cid}/submit`);
  const withdraw = (uid, vid, reason) => post(uid, `/sysbuild/package-versions/${vid}/withdraw`, reason === undefined ? {} : { reason });
  const newVer = (uid, cid, reason) => post(uid, `/sysbuild/changes/${cid}/new-version`, reason === undefined ? {} : { reason });
  const chRow = (cid) => sqlGet('SELECT * FROM sysbuild_changes WHERE id = ?', [cid]);
  const chGet = async (uid, cid) => {
    const r = await get(uid, `/sysbuild/changes/${cid}`);
    assert.strictEqual(r.status, 200, r.text);
    return r.body.change;
  };
  const versOf = (cid) => sqlAll('SELECT v.* FROM sysbuild_package_versions v JOIN sysbuild_changes c ON c.package_id = v.package_id WHERE c.id = ? ORDER BY v.version_no', [cid]);
  const effOverall = (pid) => sqlGet("SELECT v.* FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id WHERE p.project_id = ? AND p.type = 'overall' AND v.status = 'effective'", [pid]);
  async function setOf(vid) {
    const rows = await sqlAll(
      'SELECT r.op AS op, r.item_version_id AS ivid, r.committed_batch_id AS b, iv.item_id AS item FROM sysbuild_package_item_revisions r JOIN sysbuild_item_versions iv ON iv.id = r.item_version_id WHERE r.package_version_id = ? ORDER BY r.id',
      [vid]
    );
    const m = {};
    for (const r of rows) { if (r.op === 'add') m[r.item] = [r.item, r.ivid, r.b]; else delete m[r.item]; }
    return Object.keys(m).map((k) => m[k]).sort((a, b) => a[0] - b[0]);
  }
  const addItemTo = (vid, ivid, batch) => post(U.pm, `/sysbuild/package-versions/${vid}/items`, Object.assign({ op: 'add', item_version_id: ivid }, batch ? { committed_batch_id: batch } : {}));
  const rmItemFrom = (vid, ivid) => post(U.pm, `/sysbuild/package-versions/${vid}/items`, { op: 'remove', item_version_id: ivid });
  const draftOf = async (cid) => (await versOf(cid)).find((v) => v.status === 'draft');
  const pendingOf = async (cid) => (await versOf(cid)).find((v) => v.status === 'pending');
  const frozenOf = (type, vid) => sqlAll('SELECT attachment_id, sha256 FROM sysbuild_frozen_attachments WHERE object_type = ? AND object_version_id = ? ORDER BY attachment_id', [type, vid]);
  const revisionsOf = (vid) => sqlAll(
    `SELECT r.status AS status, r.status_reason AS reason, m.user_id AS user_id FROM sysbuild_confirm_tasks t JOIN sysbuild_confirm_task_revisions r ON r.task_id = t.id JOIN sysbuild_members m ON m.id = r.required_member_id
      WHERE t.object_type = 'package_version' AND t.object_version_id = ? ORDER BY t.id, r.rev_no`, [vid]
  );
  const setStatus = (pid, to) => post(U.admin, `/sysbuild/projects/${pid}/status`, { to, reason: '变更用例' });
  const planOf = async (pid) => (await get(U.pm, `/sysbuild/projects/${pid}/plan`)).body;

  // ═══════════════════════ 1 建变更 ═══════════════════════
  test(`${T_CREATE}——POST /projects/:id/changes：PM 在总体规划已生效的项目建变更，同一事务建变更（draft）、变更包（type change，不挂批次）与第一版草稿（继承当前生效总体规划的条目集合 / snapshot / form，parent = 该生效版本）；方向类证据必有（附件绑定 owner_type = change，或无书面证据 + 原因 ≥ 10 字）；引用登记须是本项目办理类登记；总体规划未生效 409；权限 / 项目状态 / 参数校验；读接口与项目内列表`, async () => {
    const s = await mkScene();
    await sqlRun("UPDATE sysbuild_package_versions SET snapshot_json = ? WHERE id = ?", ['{"范围":"一期总体范围"}', s.eff.pv]); // 夹具：给现行总体规划版本一份 snapshot，核对继承
    const url = `/sysbuild/projects/${s.pid}/changes`;
    // 前提：总体规划已有生效版本——没有时 409，读接口 create_change 为假
    const p0 = await newProject();
    const r0 = await post(U.pm, `/sysbuild/projects/${p0}/changes`, CHG);
    expectErr(r0, 409, 'SYSBUILD_STATE', '总体规划未生效');
    assert.ok(r0.body.message.includes('直接修改总体规划草稿'), r0.body.message);
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_changes WHERE project_id = ?', [p0]), 0, '被拒不留变更');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_packages WHERE project_id = ? AND type = 'change'", [p0]), 0, '被拒不留变更包');
    assert.strictEqual((await get(U.pm, `/sysbuild/projects/${p0}/changes`)).body.actions.create_change, false, '总体规划未生效：create_change 为假');
    // 权限：一般成员 / 只读账号 / admin 未接管 403；非成员 404
    for (const [uid, label] of [[U.m1, '一般成员'], [U.ro, '只读账号'], [U.admin, 'admin 未接管']]) expectErr(await post(uid, url, CHG), 403, 'SYSBUILD_FORBIDDEN', label);
    expectErr(await post(U.out, url, CHG), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    // 参数：标题 / 内容必填与长度、键白名单、affects 须是对象、列表形态、数组体
    for (const [body, field, label] of [
      [{ title: undefined }, 'title', '缺标题'], [{ title: '   ' }, 'title', '标题空白'], [{ title: 'x'.repeat(101) }, 'title', '标题超长'],
      [{ body: undefined }, 'body', '缺内容'], [{ body: 'y'.repeat(4001) }, 'body', '内容超长'], [{ affects: [1] }, 'affects', 'affects 是数组'], [{ affects: 'x' }, 'affects', 'affects 是文本'],
      [{ from_entry_ids: 'x' }, 'from_entry_ids', '引用登记不是数组'], [{ from_entry_ids: [1, 1] }, 'from_entry_ids', '引用登记重复'], [{ bogus: 1 }, 'bogus', '多余键'],
      [{ title: '含\u0001控制字符' }, 'title', '控制字符'],
    ]) {
      const r = await post(U.pm, url, Object.assign({}, CHG, body));
      expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', label);
      assert.strictEqual(r.body.field, field, `${label}：field`);
    }
    expectErr(await api(U.pm, 'POST', url, [1]), 400, 'SYSBUILD_INVALID_INPUT', '数组体');
    // 方向类证据：都没有 400 EVIDENCE_REQUIRED；原因不足 10 字 400；附件与无书面证据互斥 400
    const noEv = { no_written_evidence: undefined, no_evidence_reason: undefined };
    expectErr(await post(U.pm, url, Object.assign({}, CHG, noEv)), 400, 'SYSBUILD_EVIDENCE_REQUIRED', '无证据');
    expectErr(await post(U.pm, url, Object.assign({}, CHG, { no_evidence_reason: '太短了' })), 400, 'SYSBUILD_INVALID_INPUT', '原因不足 10 字');
    const mutex = await stageAtt(s.pid, U.pm, 'e');
    const rMutex = await post(U.pm, url, Object.assign({}, CHG, { attachment_ids: [mutex] }));
    expectErr(rMutex, 400, 'SYSBUILD_INVALID_INPUT', '附件与无书面证据同时给');
    assert.strictEqual(rMutex.body.field, 'no_written_evidence');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_attachment_bindings WHERE attachment_id = ?', [mutex]), 0, '被拒不绑定附件');
    // 引用登记：别的项目 / 不存在 / 知悉类 → 400；本项目办理类登记通过
    const fb = (await post(U.m1, `/sysbuild/projects/${s.pid}/entries`, { type: 'feedback', title: '要加导出', body: '希望能批量导出' })).body.entry;
    const note = (await post(U.m1, `/sysbuild/projects/${s.pid}/entries`, { type: 'note', title: '说明', body: '补充说明' })).body.entry;
    const other = await mkScene();
    const foreignEntry = (await post(U.m1, `/sysbuild/projects/${other.pid}/entries`, { type: 'issue', title: '别项目', body: '别项目的问题' })).body.entry;
    for (const [ids, label] of [[[foreignEntry.id], '别的项目的登记'], [[99999999], '不存在的登记'], [[note.id], '知悉类登记'], [[fb.id, note.id], '一个合格一个不合格']]) {
      const r = await post(U.pm, url, Object.assign({}, CHG, { from_entry_ids: ids }));
      expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', label);
      assert.strictEqual(r.body.field, 'from_entry_ids', label);
    }
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_changes WHERE project_id = ?', [s.pid]), 0, '被拒的请求一律不留变更行');
    // 成功：附件版本
    const att = await stageAtt(s.pid, U.pm, 'f');
    const r = await post(U.pm, url, { title: '  新增批量导出  ', body: '范围变更：新增一项批量导出需求', affects: { 模块: ['导出'] }, from_entry_ids: [fb.id], attachment_ids: [att] });
    assert.strictEqual(r.status, 201, r.text);
    const c = r.body.change;
    assert.deepStrictEqual([c.status, c.title, c.affects, c.from_entry_ids, c.package_version_id, c.versions.length, c.no_written_evidence], ['draft', '新增批量导出', { 模块: ['导出'] }, [fb.id], null, 1, false]);
    const row = await chRow(c.id);
    assert.deepStrictEqual([row.status, row.project_id, row.package_version_id, row.no_written_evidence, row.no_evidence_reason, row.created_by], ['draft', s.pid, null, 0, null, U.pm]);
    assert.deepStrictEqual(JSON.parse(row.affects_json), { affects: { 模块: ['导出'] }, from_entry_ids: [fb.id] }, 'affects_json 存影响说明与引用登记');
    const pkg = await sqlGet('SELECT * FROM sysbuild_packages WHERE id = ?', [row.package_id]);
    assert.deepStrictEqual([pkg.project_id, pkg.batch_id, pkg.type, pkg.created_by], [s.pid, null, 'change', U.pm], '变更包：本项目、不挂批次');
    const vers = await versOf(c.id);
    assert.strictEqual(vers.length, 1);
    const v1 = vers[0];
    const effRow = await sqlGet('SELECT form, snapshot_json FROM sysbuild_package_versions WHERE id = ?', [s.eff.pv]);
    assert.deepStrictEqual([v1.version_no, v1.status, v1.parent_overall_version_id, v1.form, v1.snapshot_json, v1.created_by], [1, 'draft', s.eff.pv, effRow.form, '{"范围":"一期总体范围"}', U.pm], '第一版草稿：继承当前生效总体规划版本（parent / form / snapshot）');
    assert.strictEqual(effRow.form, 'overall_batch_req', '前置：单批项目的生效总体规划是合并形态');
    assert.deepStrictEqual(await setOf(v1.id), [[s.i1, s.i1v, s.batch1]], '条目集合 = 现行总体规划的集合');
    assert.deepStrictEqual(await setOf(v1.id), await setOf(s.eff.pv));
    const rev = await sqlAll('SELECT op, created_by FROM sysbuild_package_item_revisions WHERE package_version_id = ?', [v1.id]);
    assert.deepStrictEqual(rev.map((x) => [x.op, x.created_by]), [['add', U.pm]], '继承的集合逐条写 add 修订');
    assert.deepStrictEqual((await sqlAll("SELECT owner_type, owner_id FROM sysbuild_attachment_bindings WHERE attachment_id = ?", [att])).map((x) => [x.owner_type, x.owner_id]), [['change', c.id]], '证据附件绑定 owner_type = change');
    // 事件
    const ev = (await payloads(s.pid, 'change_created')).pop();
    assert.deepStrictEqual(ev, {
      change_id: c.id, package_id: row.package_id, version_id: v1.id, title: '新增批量导出', from_entry_ids: [fb.id], attachment_ids: [att], no_written_evidence: false,
      inherited_overall_version_id: s.eff.pv, copied_items: 1,
    });
    assert.ok((await payloads(s.pid, 'package_created')).some((p) => p.type === 'change'));
    assert.ok((await payloads(s.pid, 'package_version_created')).some((p) => p.change === true && p.package_id === row.package_id && p.parent_overall_version_id === s.eff.pv));
    // 无书面证据版本 + 项目状态：暂停可建，已终止 409
    const c2 = await mkChange(s.pid);
    assert.deepStrictEqual([c2.change.no_written_evidence, c2.change.no_evidence_reason], [true, '口头电话确认了本次变更内容']);
    assert.strictEqual((await setStatus(s.pid, 'paused')).status, 200);
    assert.strictEqual((await post(U.pm, url, CHG)).status, 201, '暂停可建');
    assert.strictEqual((await setStatus(s.pid, 'active')).status, 200);
    assert.strictEqual((await setStatus(s.pid, 'terminated')).status, 200);
    expectErr(await post(U.pm, url, CHG), 409, 'SYSBUILD_PROJECT_READONLY', '已终止');
    // 读接口：详情与项目内列表（最新在前）；非成员 404、只读账号可读；标志
    const d = await chGet(U.ro, c.id);
    assert.deepStrictEqual([d.id, d.status, d.package_id === row.package_id, d.attachments.length, d.current_version.id === v1.id, d.sheet_version_id], [c.id, 'draft', true, 1, true, null], '只读账号可读详情');
    assert.deepStrictEqual(d.actions, { submit: false, withdraw: false, new_version: false, edit_draft: false }, '只读账号标志全假');
    expectErr(await get(U.out, `/sysbuild/changes/${c.id}`), 404, 'SYSBUILD_NOT_FOUND', '非成员读详情');
    expectErr(await get(U.pm, '/sysbuild/changes/99999999'), 404, 'SYSBUILD_NOT_FOUND', '变更不存在');
    expectErr(await get(U.out, `/sysbuild/projects/${s.pid}/changes`), 404, 'SYSBUILD_NOT_FOUND', '非成员读列表');
    const list = (await get(U.pm, `/sysbuild/projects/${s.pid}/changes`)).body;
    assert.deepStrictEqual([list.changes.length, list.changes[0].id > list.changes[list.changes.length - 1].id, list.actions.create_change], [3, true, false], '列表三条、最新在前；已终止项目 PM 的 create_change 为假');
    assert.strictEqual((await get(U.ro, `/sysbuild/projects/${s.pid}/changes`)).status, 200, '只读账号可读列表');
    await setStatus(s.pid, 'active');
    assert.strictEqual((await get(U.pm, `/sysbuild/projects/${s.pid}/changes`)).body.actions.create_change, true, '重开后 PM 可建');
    assert.strictEqual((await get(U.m1, `/sysbuild/projects/${s.pid}/changes`)).body.actions.create_change, false, '一般成员不可建');
  });

  // ═══════════════════════ 2 集合修订 ═══════════════════════
  test(`${T_EDIT}——变更草稿沿用内容包的集合修订 / snapshot 编辑端点（对 change 开放）：add / remove 折叠，重复 add 409，承诺批次规则不变；变更包版本不能经通用建版本端点产生，change 包不能经建包端点创建；新变更的草稿继承当前生效总体规划而不是别的变更的草稿；提交后草稿编辑 409`, async () => {
    const s = await mkScene();
    const a = await mkChange(s.pid);
    const b = await mkChange(s.pid);
    const va = (await draftOf(a.change.id));
    const vb = (await draftOf(b.change.id));
    // 集合修订：加新条目到默认批次、把旧条目换成新版本（remove 旧版本 + add 新版本）
    const it2 = await mkItem(s.pid);
    const r1 = await addItemTo(va.id, it2.versions[0].id, s.batch1);
    assert.strictEqual(r1.status, 201, r1.text);
    assert.deepStrictEqual((await setOf(va.id)).map((x) => x[0]), [s.i1, it2.id]);
    expectErr(await addItemTo(va.id, it2.versions[0].id, s.batch1), 409, 'SYSBUILD_STATE', '重复 add');
    assert.strictEqual((await rmItemFrom(va.id, s.i1v)).status, 201);
    const nv = await post(U.pm, `/sysbuild/items/${s.i1}/versions`, { content: '需求：增强版', no_written_evidence: true, no_evidence_reason: '口头电话确认了本次需求内容' });
    assert.strictEqual(nv.status, 201, nv.text);
    const i1v2 = (await sqlGet('SELECT id FROM sysbuild_item_versions WHERE item_id = ? ORDER BY version_no DESC LIMIT 1', [s.i1])).id;
    assert.strictEqual((await addItemTo(va.id, i1v2, s.batch1)).status, 201);
    assert.deepStrictEqual(await setOf(va.id), [[s.i1, i1v2, s.batch1], [it2.id, it2.versions[0].id, s.batch1]], '换版本 = remove 旧版本 + add 新版本');
    expectErr(await rmItemFrom(va.id, s.i1v), 409, 'SYSBUILD_STATE', 'remove 不在集合里的版本');
    // 他变更的草稿不受影响：B 的草稿仍是现行总体规划的集合（继承来源是当前生效总体规划，不是 A 的草稿）
    assert.deepStrictEqual(await setOf(vb.id), [[s.i1, s.i1v, s.batch1]], '变更 B 的草稿 = 现行总体规划，不含 A 的修订');
    const c = await mkChange(s.pid);
    assert.deepStrictEqual(await setOf((await draftOf(c.change.id)).id), [[s.i1, s.i1v, s.batch1]], '新变更的草稿继承现行总体规划（不是已有变更的草稿）');
    // snapshot 编辑
    const sn = await api(U.pm, 'PATCH', `/sysbuild/package-versions/${va.id}`, { snapshot_json: { 变更范围: '新增导出' } });
    assert.strictEqual(sn.status, 200, sn.text);
    assert.strictEqual((await sqlGet('SELECT snapshot_json FROM sysbuild_package_versions WHERE id = ?', [va.id])).snapshot_json, '{"变更范围":"新增导出"}');
    // 权限：一般成员 / 只读账号 403（集合修订）；承诺批次校验不变：他项目批次 400
    expectErr(await post(U.m1, `/sysbuild/package-versions/${va.id}/items`, { op: 'add', item_version_id: it2.versions[0].id }), 403, 'SYSBUILD_FORBIDDEN', '一般成员');
    const o = await mkScene();
    expectErr(await addItemTo(vb.id, (await mkItem(s.pid)).versions[0].id, o.batch1), 400, 'SYSBUILD_INVALID_INPUT', '他项目批次');
    // 变更包版本只经正式变更产生：通用建版本端点 409；建包端点创建 change 409（原规则不变）
    const pkgId = (await chRow(a.change.id)).package_id;
    const rv = await post(U.pm, `/sysbuild/packages/${pkgId}/versions`);
    expectErr(rv, 409, 'SYSBUILD_STATE', '通用建版本端点');
    assert.ok(rv.body.message.includes('正式变更'), rv.body.message);
    expectErr(await post(U.pm, `/sysbuild/projects/${s.pid}/packages`, { type: 'change' }), 409, 'SYSBUILD_STATE', '建包端点');
    // 提交后草稿编辑 409
    const sub = await submitCh(U.pm, a.change.id);
    assert.strictEqual(sub.status, 200, sub.text);
    expectErr(await addItemTo(va.id, (await mkItem(s.pid)).versions[0].id, s.batch1), 409, 'SYSBUILD_STATE', '待确认版本不能再修订集合');
    expectErr(await api(U.pm, 'PATCH', `/sysbuild/package-versions/${va.id}`, { snapshot_json: { x: 1 } }), 409, 'SYSBUILD_STATE', '待确认版本不能改 snapshot');
  });

  // ═══════════════════════ 3 提交 ═══════════════════════
  test(`${T_SUBMIT}——POST /changes/:cid/submit：提交该变更当前草稿版本，必需确认人 = 每个需求部门现任负责人 + 生效代表人（与总体规划包相同）；集合重核（空集 / 承诺批次不是默认批次 = 第二期开放 409）；冻结变更证据与包附件；记提交时的节点计划；同一事务 changes.status draft → pending 并回填 package_version_id；同一时刻至多一个待确认变更；非 PM 403`, async () => {
    const s = await mkScene();
    const att = await stageAtt(s.pid, U.pm, '1');
    const ch = await mkChange(s.pid, { attachment_ids: [att], no_written_evidence: undefined, no_evidence_reason: undefined });
    const cid = ch.change.id;
    const vid = (await draftOf(cid)).id;
    expectErr(await submitCh(U.m1, cid), 403, 'SYSBUILD_FORBIDDEN', '一般成员');
    expectErr(await submitCh(U.out, cid), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    expectErr(await submitCh(U.pm, 99999999), 404, 'SYSBUILD_NOT_FOUND', '变更不存在');
    assert.strictEqual((await chGet(U.pm, cid)).actions.submit, true, '标志：可提交');
    assert.strictEqual((await chGet(U.m1, cid)).actions.submit, false, '一般成员标志为假');
    // 必需确认人缺人：乙部只有负责人、没有代表人 → 409 列出乙部；标志同源为假
    const B = await seedParty(s.pid, '乙部', U.x1, null);
    const miss = await submitCh(U.pm, cid);
    expectErr(miss, 409, 'SYSBUILD_STATE', '乙部缺代表人');
    assert.ok(miss.body.message.includes('乙部') && miss.body.message.includes('缺生效代表人'), miss.body.message);
    assert.strictEqual((await chGet(U.pm, cid)).actions.submit, false, '缺人：标志为假（同源）');
    assert.strictEqual((await chRow(cid)).status, 'draft', '被拒不改状态');
    const mBDel = await addMember(s.pid, U.x2, { party: B.party });
    await addDelegation(B.party, mBDel, B.apt, 'active');
    // 集合为空 409（空集不能提交）：另一个变更，把唯一条目移出
    const emptyCh = await mkChange(s.pid);
    const ve = await draftOf(emptyCh.change.id);
    assert.strictEqual((await rmItemFrom(ve.id, s.i1v)).status, 201);
    expectErr(await submitCh(U.pm, emptyCh.change.id), 409, 'SYSBUILD_STATE', '集合为空');
    // 第二期开放：承诺批次不是默认批次 → 409（本期变更不能改变批次结构）
    const batch2 = (await sqlRun("INSERT INTO sysbuild_batches (project_id, seq, name, is_default, status) VALUES (?, 2, '第 2 批', 0, 'planning')", [s.pid])).lastID;
    const structCh = await mkChange(s.pid);
    const vs = await draftOf(structCh.change.id);
    const itB = await mkItem(s.pid);
    assert.strictEqual((await addItemTo(vs.id, itB.versions[0].id, batch2)).status, 201);
    const st = await submitCh(U.pm, structCh.change.id);
    expectErr(st, 409, 'SYSBUILD_STATE', '承诺批次不是默认批次');
    assert.ok(st.body.message.includes('第二期开放'), st.body.message);
    // 成功
    const sub = await submitCh(U.pm, cid);
    assert.strictEqual(sub.status, 200, sub.text);
    assert.deepStrictEqual([sub.body.version.id, sub.body.version.status, sub.body.change_id, sub.body.tasks.length], [vid, 'pending', cid, 4], '返回版本、变更号与 4 个确认任务');
    const tasks = await tasksOf(vid);
    assert.deepStrictEqual(tasks.map((t) => t.user_id).sort((a, b) => a - b), [U.own, U.del, U.x1, U.x2].sort((a, b) => a - b), '必需确认人 = 甲部 / 乙部各自的负责人 + 代表人');
    assert.ok(tasks.every((t) => t.purpose === 'package_confirm' && t.rev_no === 1 && t.status === 'pending'));
    assert.deepStrictEqual(tasks.filter((t) => t.basis_delegation_id !== null).map((t) => t.user_id).sort((a, b) => a - b), [U.del, U.x2].sort((a, b) => a - b), '代表人任务依据授权');
    const row = await chRow(cid);
    assert.deepStrictEqual([row.status, row.package_version_id], ['pending', vid], 'changes.status draft → pending、回填 package_version_id');
    assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id = ?', [vid])).status, 'pending');
    const fz = await frozenOf('package_version', vid);
    assert.deepStrictEqual(fz.map((f) => f.attachment_id), [att], '冻结清单含变更的证据附件');
    assert.strictEqual(fz[0].sha256, '1'.repeat(64));
    const ev = (await payloads(s.pid, 'package_version_submitted')).pop();
    assert.strictEqual(ev.type, 'change');
    assert.strictEqual(ev.change_id, cid);
    assert.strictEqual(ev.form, 'overall_batch_req');
    assert.strictEqual(ev.node_plans.length, 6, '提交时记录的节点计划：六个节点');
    assert.deepStrictEqual(ev.frozen_attachment_ids, [att]);
    // 确认页对象带变更本身（标题 / 说明 / 影响 / 引用登记），确认人看到的是「为什么改、改什么」
    const ownTask = tasks.find((t) => t.user_id === U.own);
    const ob = await get(U.own, `/sysbuild/confirm-tasks/${ownTask.task_id}`);
    assert.strictEqual(ob.status, 200, ob.text);
    assert.deepStrictEqual([ob.body.object.type, ob.body.object.package.type, ob.body.object.change.title, ob.body.object.change.body, ob.body.object.change.from_entry_ids, ob.body.object.change.no_written_evidence],
      ['package_version', 'change', '新增批量导出', '范围变更：新增一项批量导出需求', [], false]);
    const cs = (await payloads(s.pid, 'change_submitted')).pop();
    assert.deepStrictEqual(cs, { change_id: cid, package_version_id: vid, version_no: 1, task_ids: sub.body.tasks.map((t) => t.task_id) });
    // 同一时刻至多一个待确认变更；已提交的变更不能再提交
    const second = await mkChange(s.pid);
    const s2 = await submitCh(U.pm, second.change.id);
    expectErr(s2, 409, 'SYSBUILD_STATE', '另一个变更待确认');
    assert.ok(s2.body.message.includes('待确认的变更'), s2.body.message);
    assert.strictEqual((await chGet(U.pm, second.change.id)).actions.submit, false, '另有待确认变更：标志为假（同源）');
    const again = await submitCh(U.pm, cid);
    expectErr(again, 409, 'SYSBUILD_STATE', '已提交的变更再提交');
    assert.ok(again.body.message.includes('草稿'), again.body.message);
    const dflags = await chGet(U.pm, cid);
    assert.deepStrictEqual([dflags.actions.submit, dflags.actions.withdraw, dflags.actions.edit_draft, dflags.status, dflags.package_version_id, dflags.sheet_version_id], [false, true, false, 'pending', vid, vid]);
    // 项目已终止：提交 409 PROJECT_READONLY（另一个草稿变更；先撤回待确认的那个让「待确认变更」不抢先报错）
    assert.strictEqual((await withdraw(U.pm, vid, '为终止用例撤回')).status, 200);
    assert.strictEqual((await setStatus(s.pid, 'terminated')).status, 200);
    expectErr(await submitCh(U.pm, second.change.id), 409, 'SYSBUILD_PROJECT_READONLY', '已终止');
  });

  // ═══════════════════════ 4 撤回 ═══════════════════════
  test(`${T_WITHDRAW}——撤回变更包版本（现有 withdraw 端点）：同一事务 changes.status → withdrawn、待确认修订失效；撤回后的变更不能再提交 / 出新版本（要再变更就新建一条）；通用 submit 端点对变更版本同样回写 changes.status；非 PM 403；非待确认版本 409`, async () => {
    const s = await mkScene();
    const a = await mkChange(s.pid);
    const va = await draftOf(a.change.id);
    expectErr(await withdraw(U.pm, va.id, '草稿不能撤回'), 409, 'SYSBUILD_STATE', '草稿不能撤回');
    assert.strictEqual((await submitCh(U.pm, a.change.id)).status, 200);
    expectErr(await withdraw(U.m1, va.id, '无权'), 403, 'SYSBUILD_FORBIDDEN', '一般成员');
    expectErr(await withdraw(U.pm, va.id), 400, 'SYSBUILD_INVALID_INPUT', '缺原因');
    const w = await withdraw(U.pm, va.id, '范围需要重新梳理');
    assert.strictEqual(w.status, 200, w.text);
    assert.strictEqual(w.body.invalidated_revision_ids.length, 2, '甲部两个待确认修订失效');
    const row = await chRow(a.change.id);
    assert.deepStrictEqual([row.status, row.package_version_id], ['withdrawn', va.id], '变更 → withdrawn');
    assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id = ?', [va.id])).status, 'superseded');
    assert.deepStrictEqual((await revisionsOf(va.id)).map((r) => [r.status, r.reason]), [['invalid', '范围需要重新梳理'], ['invalid', '范围需要重新梳理']]);
    assert.deepStrictEqual((await payloads(s.pid, 'change_withdrawn')).pop(), { change_id: a.change.id, package_version_id: va.id, reason: '范围需要重新梳理' });
    // 撤回后：不能再提交、不能出新版本；标志全假
    const re = await submitCh(U.pm, a.change.id);
    expectErr(re, 409, 'SYSBUILD_STATE', '撤回后再提交');
    assert.ok(re.body.message.includes('草稿'), re.body.message);
    const nvr = await newVer(U.pm, a.change.id, '想重来');
    expectErr(nvr, 409, 'SYSBUILD_STATE', '撤回后出新版本');
    assert.ok(nvr.body.message.includes('已撤回'), nvr.body.message);
    const gw = await chGet(U.pm, a.change.id);
    assert.deepStrictEqual([gw.status, gw.actions], ['withdrawn', { submit: false, withdraw: false, new_version: false, edit_draft: false }]);
    // 要再变更就新建一条：新变更继承现行总体规划，可正常提交
    const b = await mkChange(s.pid);
    const vb = await draftOf(b.change.id);
    // 通用 submit / withdraw 端点对变更版本同样回写 changes.status
    const gs = await post(U.pm, `/sysbuild/package-versions/${vb.id}/submit`);
    assert.strictEqual(gs.status, 200, gs.text);
    assert.deepStrictEqual([gs.body.change_id, (await chRow(b.change.id)).status], [b.change.id, 'pending'], '通用提交端点回写 changes.status');
    assert.strictEqual((await withdraw(U.pm, vb.id, '通用撤回')).status, 200);
    assert.strictEqual((await chRow(b.change.id)).status, 'withdrawn', '通用撤回端点回写 withdrawn');
  });

  // ═══════════════════════ 5 出新版本（有异议）═══════════════════════
  test(`${T_OBJECT}——「有异议：PM 答复或出新版本」：答复 = 现有改发；出新版本 = 同一事务让待确认版本退位（待确认修订失效、已有的有异议记录保留）、changes.status 回到 draft、在同一变更包上建新草稿，新草稿继承**当前生效的总体规划**（不是上一版变更草稿）；没有异议 / 非 PM / 不是待确认 → 拒绝；不认可（reject）同样算异议`, async () => {
    const s = await mkScene();
    const ch = await mkChange(s.pid);
    const cid = ch.change.id;
    const v1 = await draftOf(cid);
    const extra = await mkItem(s.pid);
    assert.strictEqual((await addItemTo(v1.id, extra.versions[0].id, s.batch1)).status, 201);
    assert.strictEqual((await submitCh(U.pm, cid)).status, 200);
    // 没有异议：出新版本 409，标志为假
    const none = await newVer(U.pm, cid, '没有异议也想出新版本');
    expectErr(none, 409, 'SYSBUILD_STATE', '没有异议');
    assert.ok(none.body.message.includes('没有收到异议'), none.body.message);
    assert.strictEqual((await chGet(U.pm, cid)).actions.new_version, false);
    // 甲部代表人提异议 → 变更仍待确认；出新版本标志为真
    const t = await tasksOf(v1.id);
    const delTask = t.find((x) => x.user_id === U.del);
    assert.strictEqual((await openAndDecide(U.del, delTask.task_id, 'object', { reason: '导出范围太大，请缩小' })).status, 200);
    const mid = await chGet(U.pm, cid);
    assert.deepStrictEqual([mid.status, mid.actions.new_version, mid.actions.withdraw, mid.actions.submit], ['pending', true, true, false]);
    assert.strictEqual((await chGet(U.m1, cid)).actions.new_version, false, '一般成员标志为假');
    // 权限 / 参数 / 非成员
    expectErr(await newVer(U.m1, cid, '无权'), 403, 'SYSBUILD_FORBIDDEN', '一般成员');
    expectErr(await newVer(U.out, cid, '非成员'), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    expectErr(await newVer(U.pm, cid), 400, 'SYSBUILD_INVALID_INPUT', '缺说明');
    expectErr(await post(U.pm, `/sysbuild/changes/${cid}/new-version`, { reason: 'x', bogus: 1 }), 400, 'SYSBUILD_INVALID_INPUT', '多余键');
    expectErr(await newVer(U.pm, 99999999, 'x'), 404, 'SYSBUILD_NOT_FOUND', '变更不存在');
    // 出新版本
    const nv = await newVer(U.pm, cid, '按意见缩小导出范围');
    assert.strictEqual(nv.status, 201, nv.text);
    const vers = await versOf(cid);
    assert.deepStrictEqual(vers.map((v) => [v.version_no, v.status]), [[1, 'superseded'], [2, 'draft']], '旧版本退位、新草稿');
    const v2 = vers[1];
    assert.deepStrictEqual([nv.body.version.id, nv.body.version.version_no, v2.parent_overall_version_id, nv.body.version.parent_overall_version_id], [v2.id, 2, s.eff.pv, s.eff.pv], '新草稿继承来源 = 当前生效总体规划');
    assert.deepStrictEqual(await setOf(v2.id), [[s.i1, s.i1v, s.batch1]], '新草稿的集合 = 现行总体规划，不含上一版草稿加的条目');
    assert.deepStrictEqual((await setOf(v1.id)).map((x) => x[0]), [s.i1, extra.id], '旧版本的集合保留');
    assert.deepStrictEqual((await revisionsOf(v1.id)).map((r) => [r.user_id, r.status, r.reason]).sort((a, b) => a[0] - b[0]),
      [[U.own, 'invalid', '按意见缩小导出范围'], [U.del, 'objected', null]].sort((a, b) => a[0] - b[0]), '待确认修订失效（原因 = 出新版本的说明）、已有的有异议记录保留');
    const row = await chRow(cid);
    assert.deepStrictEqual([row.status, row.package_version_id], ['draft', null], 'changes 回到 draft、不再指向待确认版本');
    assert.deepStrictEqual((await payloads(s.pid, 'change_new_version')).pop(), {
      change_id: cid, from_version_id: v1.id, from_status: 'pending', new_version_id: v2.id, version_no: 2, reason: '按意见缩小导出范围', inherited_overall_version_id: s.eff.pv,
      invalidated_revision_ids: nv.body.invalidated_revision_ids,
    });
    assert.strictEqual(nv.body.invalidated_revision_ids.length, 1);
    // 重新提交：新版本有自己的确认任务；旧版本的任务不受影响
    const sub2 = await submitCh(U.pm, cid);
    assert.strictEqual(sub2.status, 200, sub2.text);
    assert.deepStrictEqual([(await chRow(cid)).status, (await chRow(cid)).package_version_id], ['pending', v2.id]);
    expectErr(await newVer(U.pm, cid, '又没有异议'), 409, 'SYSBUILD_STATE', '新版本待确认且没有异议');
    // 不认可（reject）同样算异议
    const t2 = await tasksOf(v2.id);
    assert.strictEqual((await openAndDecide(U.own, t2.find((x) => x.user_id === U.own).task_id, 'reject', { reason: '不同意变更' })).status, 200);
    assert.strictEqual((await chGet(U.pm, cid)).actions.new_version, true, '不认可也算异议');
    // 答复 = 现有改发（PM 改发给同一人 → 新修订）：变更仍待确认
    const rt = (await tasksOf(v2.id)).find((x) => x.user_id === U.own);
    const rs = await post(U.pm, `/sysbuild/confirm-tasks/${rt.task_id}/reissue`, { reason: '已向负责人答复，请重新确认' });
    assert.strictEqual(rs.status, 200, rs.text);
    assert.strictEqual((await chRow(cid)).status, 'pending');
  });

  // ═══════════════════════ 6 出新版本（过期草稿）═══════════════════════
  test(`${T_STALE}——草稿所基于的总体规划版本已被别的变更生效替代：提交 409「请基于现行规划重建草稿」（提交标志同源为假）；出新版本 = 重建草稿（旧草稿退位、新草稿继承新的现行总体规划，含已生效变更的结果）；草稿未过期时出新版本 409`, async () => {
    const s = await mkScene();
    const a = await mkChange(s.pid);
    const b = await mkChange(s.pid);
    const vb = await draftOf(b.change.id);
    // 草稿未过期：出新版本 409
    const fresh = await newVer(U.pm, b.change.id, '草稿没过期');
    expectErr(fresh, 409, 'SYSBUILD_STATE', '草稿没过期');
    assert.ok(fresh.body.message.includes('仍基于现行总体规划'), fresh.body.message);
    // A 先生效：新增一个条目
    const va = await draftOf(a.change.id);
    const itA = await mkItem(s.pid);
    assert.strictEqual((await addItemTo(va.id, itA.versions[0].id, s.batch1)).status, 201);
    assert.strictEqual((await submitCh(U.pm, a.change.id)).status, 200);
    const last = await confirmAll(va.id);
    assert.strictEqual(last.body.effective, true, last.text);
    const v2 = await effOverall(s.pid);
    assert.strictEqual(v2.version_no, 2);
    // B 的草稿已过期：提交 409，标志为假；出新版本标志为真
    const stale = await submitCh(U.pm, b.change.id);
    expectErr(stale, 409, 'SYSBUILD_STATE', '过期草稿提交');
    assert.ok(stale.body.message.includes('请基于现行规划重建草稿'), stale.body.message);
    const gb = await chGet(U.pm, b.change.id);
    assert.deepStrictEqual([gb.actions.submit, gb.actions.new_version, gb.status], [false, true, 'draft']);
    assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id = ?', [vb.id])).status, 'draft', '被拒不改草稿');
    // 重建：旧草稿退位，新草稿继承新的现行总体规划（含 A 的结果）
    const nv = await newVer(U.pm, b.change.id, '总体规划已变，重建草稿');
    assert.strictEqual(nv.status, 201, nv.text);
    const vers = await versOf(b.change.id);
    assert.deepStrictEqual(vers.map((v) => [v.version_no, v.status]), [[1, 'superseded'], [2, 'draft']]);
    assert.deepStrictEqual([vers[1].parent_overall_version_id, nv.body.invalidated_revision_ids], [v2.id, []], '继承来源 = 新的现行总体规划；过期草稿没有待确认修订');
    assert.deepStrictEqual((await setOf(vers[1].id)).map((x) => x[0]), [s.i1, itA.id], '新草稿含已生效变更新增的条目');
    assert.deepStrictEqual([(await chRow(b.change.id)).status, (await chRow(b.change.id)).package_version_id], ['draft', null]);
    assert.strictEqual((await payloads(s.pid, 'change_new_version')).pop().from_status, 'draft');
    assert.strictEqual((await submitCh(U.pm, b.change.id)).status, 200, '重建后的草稿可提交');
  });

  // ═══════════════════════ 7 生效 ═══════════════════════
  test(`${T_EFFECT}——最后一条必需修订确认时同一事务：变更包版本 → effective；新建总体规划包版本（version_no + 1、effective、生效时刻同、form 照前一版、parent 空、snapshot = 变更包版本快照、条目集合 = 变更包版本折叠集合）；原生效总体版本 → superseded；changes.status → effective；事件 change_effective 含新旧版本号；不推进批次、不重形成已有基线；条目现行版本随之切换；第二次总体规划生效走生产路径；继承来源与现行不一致时 409 回滚`, async () => {
    const s = await mkScene();
    const ch = await mkChange(s.pid);
    const cid = ch.change.id;
    const v1 = await draftOf(cid);
    // 变更内容：把 i1 换成新版本、再加一个新条目；snapshot 记变更范围
    assert.strictEqual((await rmItemFrom(v1.id, s.i1v)).status, 201);
    assert.strictEqual((await post(U.pm, `/sysbuild/items/${s.i1}/versions`, { content: '需求：增强版', no_written_evidence: true, no_evidence_reason: '口头电话确认了本次需求内容' })).status, 201);
    const i1v2 = (await sqlGet('SELECT id FROM sysbuild_item_versions WHERE item_id = ? ORDER BY version_no DESC LIMIT 1', [s.i1])).id;
    assert.strictEqual((await addItemTo(v1.id, i1v2, s.batch1)).status, 201);
    const itNew = await mkItem(s.pid);
    assert.strictEqual((await addItemTo(v1.id, itNew.versions[0].id, s.batch1)).status, 201);
    assert.strictEqual((await api(U.pm, 'PATCH', `/sysbuild/package-versions/${v1.id}`, { snapshot_json: { 变更范围: '增强导出并新增条目' } })).status, 200);
    assert.strictEqual((await submitCh(U.pm, cid)).status, 200);
    const baselinesBefore = await sqlAll("SELECT r.node_id AS n, r.package_version_id AS pv FROM sysbuild_node_schedule_records r JOIN sysbuild_nodes n ON n.id = r.node_id WHERE n.project_id = ? AND r.kind = 'baseline' ORDER BY r.node_id", [s.pid]);
    assert.strictEqual(baselinesBefore.length, 6);
    const batchBefore = await sqlGet('SELECT status FROM sysbuild_batches WHERE id = ?', [s.batch1]);
    // 防御（夹具：继承来源被篡改成别的版本）：最后一条确认 409、整笔回滚，修订仍待确认
    const tasks = await tasksOf(v1.id);
    for (const t of tasks.slice(0, tasks.length - 1)) assert.strictEqual((await openAndDecide(t.user_id, t.task_id, 'confirm')).status, 200);
    const lastTask = tasks[tasks.length - 1];
    await sqlRun('UPDATE sysbuild_package_versions SET parent_overall_version_id = ? WHERE id = ?', [99999999, v1.id]);
    const bad = await openAndDecide(lastTask.user_id, lastTask.task_id, 'confirm');
    expectErr(bad, 409, 'SYSBUILD_STATE', '继承来源与现行总体规划不一致');
    assert.ok(bad.body.message.includes('已被替代'), bad.body.message);
    assert.strictEqual((await tasksOf(v1.id)).find((x) => x.task_id === lastTask.task_id).status, 'pending', '整笔回滚：最后一条修订仍待确认');
    assert.deepStrictEqual([(await chRow(cid)).status, (await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id = ?', [v1.id])).status, (await effOverall(s.pid)).id], ['pending', 'pending', s.eff.pv], '变更与总体规划都没有变');
    await sqlRun('UPDATE sysbuild_package_versions SET parent_overall_version_id = ? WHERE id = ?', [s.eff.pv, v1.id]);
    // 正常生效
    const done = await openAndDecide(lastTask.user_id, lastTask.task_id, 'confirm');
    assert.strictEqual(done.status, 200, done.text);
    assert.strictEqual(done.body.effective, true);
    const vNew = await effOverall(s.pid);
    assert.deepStrictEqual([done.body.new_overall_version_id, done.body.old_overall_version_id, vNew.id], [vNew.id, s.eff.pv, vNew.id], '响应带新旧总体规划版本编号');
    assert.deepStrictEqual([vNew.version_no, vNew.status, vNew.form, vNew.parent_overall_version_id, vNew.package_id], [2, 'effective', 'overall_batch_req', null, s.eff.pk], '新总体规划版本：version_no + 1、form 照前一版、parent 空、同一个总体规划包');
    const vChg = await sqlGet('SELECT * FROM sysbuild_package_versions WHERE id = ?', [v1.id]);
    assert.deepStrictEqual([vChg.status, vNew.effective_at === vChg.effective_at, vNew.snapshot_json], ['effective', true, '{"变更范围":"增强导出并新增条目"}'], '变更包版本生效；新总体版本生效时刻相同、snapshot = 变更包版本快照');
    assert.deepStrictEqual(await setOf(vNew.id), [[s.i1, i1v2, s.batch1], [itNew.id, itNew.versions[0].id, s.batch1]], '条目集合 = 变更包版本的折叠集合');
    assert.deepStrictEqual(await setOf(vNew.id), await setOf(v1.id));
    assert.deepStrictEqual((await sqlAll('SELECT op, created_by FROM sysbuild_package_item_revisions WHERE package_version_id = ?', [vNew.id])).map((x) => x.op), ['add', 'add'], '逐条写 add 修订');
    assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id = ?', [s.eff.pv])).status, 'superseded', '原生效总体版本 → superseded');
    const row = await chRow(cid);
    assert.deepStrictEqual([row.status, row.package_version_id], ['effective', v1.id], 'changes → effective');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_package_versions WHERE package_id = ? AND status = 'effective'", [s.eff.pk]), 1, '总体规划包只有一个生效版本');
    // 事件
    const ce = (await payloads(s.pid, 'change_effective')).pop();
    // 修订批 3 M2：事件另带变更提交时记录的节点计划（node_plans，与提交事件那份全等；旧断言按「没有 node_plans 键」写，随之改写）
    const submittedEv = (await payloads(s.pid, 'package_version_submitted')).filter((p) => p.change_id === cid).pop();
    assert.ok(Array.isArray(submittedEv.node_plans) && submittedEv.node_plans.length === 6, '前置：提交事件记了六个节点的计划');
    assert.deepStrictEqual(ce, {
      change_id: cid, change_version_id: v1.id, old_overall_version_id: s.eff.pv, old_overall_version_no: 1, new_overall_version_id: vNew.id, new_overall_version_no: 2, item_count: 2, baseline_node_ids: [],
      node_plans: submittedEv.node_plans,
    });
    assert.deepStrictEqual((await payloads(s.pid, 'package_version_superseded')).pop(), { package_id: s.eff.pk, replaced_by: vNew.id, via: 'change', change_id: cid });
    const pe = (await payloads(s.pid, 'package_version_effective')).pop();
    assert.deepStrictEqual([pe.package_id, pe.version_no, pe.replaced, pe.via, pe.change_id, pe.change_version_id, pe.item_count], [s.eff.pk, 2, [s.eff.pv], 'change', cid, v1.id, 2]);
    // 不推进批次、不重形成已有基线（六个节点的基线仍引用第一版总体规划）
    assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_batches WHERE id = ?', [s.batch1])).status, batchBefore.status, '不推进批次');
    assert.deepStrictEqual(await sqlAll("SELECT r.node_id AS n, r.package_version_id AS pv FROM sysbuild_node_schedule_records r JOIN sysbuild_nodes n ON n.id = r.node_id WHERE n.project_id = ? AND r.kind = 'baseline' ORDER BY r.node_id", [s.pid]), baselinesBefore, '已有基线不重形成');
    // 现行版本切换（resolveCurrentPlan 单一来源）：包列表的现行版本、新登记关联的条目版本都由新总体规划决定
    assert.strictEqual((await get(U.pm, `/sysbuild/projects/${s.pid}/packages`)).body.overall_version_id, vNew.id);
    const e = await post(U.m1, `/sysbuild/projects/${s.pid}/entries`, { type: 'feedback', title: '导出反馈', body: '导出不够用', item_ids: [s.i1] });
    assert.strictEqual(e.status, 201, e.text);
    assert.deepStrictEqual(e.body.entry.items.map((x) => [x.item_id, x.item_version_id]), [[s.i1, i1v2]], '新登记关联条目的现行版本 = 新总体规划里的版本');
    assert.deepStrictEqual(e.body.entry.routing.route, 'project');
    assert.strictEqual((await sqlGet('SELECT overall_package_version_id AS v FROM sysbuild_routing_snapshots WHERE entry_id = ?', [e.body.entry.id])).v, vNew.id, '分流快照引用新总体规划版本');
    // 第二次生效：同样走生产路径（再一条变更 → 第三版总体规划）；旧变更仍是 effective，不受影响
    const ch2 = await mkChange(s.pid);
    const w2 = await draftOf(ch2.change.id);
    assert.deepStrictEqual(await setOf(w2.id), await setOf(vNew.id), '第二条变更的草稿继承第二版总体规划');
    assert.strictEqual(w2.parent_overall_version_id, vNew.id);
    assert.strictEqual((await rmItemFrom(w2.id, itNew.versions[0].id)).status, 201);
    assert.strictEqual((await submitCh(U.pm, ch2.change.id)).status, 200);
    const last2 = await confirmAll(w2.id);
    assert.strictEqual(last2.body.effective, true, last2.text);
    const v3 = await effOverall(s.pid);
    assert.deepStrictEqual([v3.version_no, (await setOf(v3.id)).length, (await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id = ?', [vNew.id])).status, (await chRow(cid)).status], [3, 1, 'superseded', 'effective']);
    // 生效后的变更：不能再撤回 / 出新版本 / 提交
    expectErr(await withdraw(U.pm, v1.id, '已生效'), 409, 'SYSBUILD_STATE', '已生效不能撤回');
    const nvDone = await newVer(U.pm, cid, '已生效');
    expectErr(nvDone, 409, 'SYSBUILD_STATE', '已生效不能出新版本');
    assert.ok(nvDone.body.message.includes('已生效'), nvDone.body.message);
    expectErr(await submitCh(U.pm, cid), 409, 'SYSBUILD_STATE', '已生效不能再提交');
    assert.deepStrictEqual((await chGet(U.pm, cid)).actions, { submit: false, withdraw: false, new_version: false, edit_draft: false });
  });

  // ═══════════════════════ 8 基线 ═══════════════════════
  test(`${T_BASELINE}——变更生效时尚无基线的节点（总体规划生效后新增、已写计划）按变更提交时记录的节点计划形成基线（引用新总体规划版本，与记录逐项核对）；已有基线的节点不动；提交时记录的清单含该节点`, async () => {
    const s = await mkScene();
    const addNode = await post(U.pm, `/sysbuild/batches/${s.batch1}/nodes`, { name: '生效后新增的自定义节点' });
    assert.strictEqual(addNode.status, 201, addNode.text);
    const nid = addNode.body.node.id;
    const plan = await post(U.pm, `/sysbuild/nodes/${nid}/schedule`, { kind: 'plan', planned_start: '2026-12-05', planned_end: '2026-12-20', reason: '新增节点排期', no_written_evidence: true, no_evidence_reason: '电话沟通后已确认新增节点排期' });
    assert.strictEqual(plan.status, 201, plan.text);
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_node_schedule_records WHERE node_id = ? AND kind = 'baseline'", [nid]), 0, '前置：尚无基线');
    const ch = await mkChange(s.pid);
    assert.strictEqual((await submitCh(U.pm, ch.change.id)).status, 200);
    const vid = (await pendingOf(ch.change.id)).id;
    const sub = (await payloads(s.pid, 'package_version_submitted')).pop();
    assert.strictEqual(sub.node_plans.length, 7, '提交时记录的节点计划含新增节点');
    assert.deepStrictEqual(sub.node_plans.filter((x) => x.node_id === nid).map((x) => [x.name, x.layer, x.batch_id, x.planned_start, x.planned_end]), [['生效后新增的自定义节点', 'batch', s.batch1, '2026-12-05', '2026-12-20']]);
    const last = await confirmAll(vid);
    assert.strictEqual(last.body.effective, true, last.text);
    assert.deepStrictEqual(last.body.baseline_node_ids, [nid], '只有尚无基线的节点形成基线');
    const vNew = await effOverall(s.pid);
    const bl = await sqlAll("SELECT node_id, planned_start, planned_end, package_version_id FROM sysbuild_node_schedule_records WHERE node_id = ? AND kind = 'baseline'", [nid]);
    assert.deepStrictEqual(bl.map((b) => [b.planned_start, b.planned_end, b.package_version_id]), [['2026-12-05', '2026-12-20', vNew.id]], '基线 = 提交时记录的计划，引用新总体规划版本');
    assert.deepStrictEqual((await payloads(s.pid, 'change_effective')).pop().baseline_node_ids, [nid]);
    const closing = (await planOf(s.pid)).nodes.find((n) => n.template_key === 'p_closing');
    assert.strictEqual(closing.has_baseline, true);
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_node_schedule_records r JOIN sysbuild_nodes n ON n.id = r.node_id WHERE n.project_id = ? AND r.kind = 'baseline' AND r.package_version_id = ?", [s.pid, s.eff.pv]), 6, '原六个基线仍引用第一版');
  });

  // ═══════════════════════ 9 排期冻结 ═══════════════════════
  test(`${T_FREEZE}——变更待确认期间排期随包冻结（与总体规划包待确认同口径，P34）：任何节点设计划 / 改期、取消节点 409；撤回或生效后恢复（变更生效时形成基线要与提交记录核对，所以冻结）`, async () => {
    const s = await mkScene();
    const ch = await mkChange(s.pid);
    const dev = (await planOf(s.pid)).nodes.find((n) => n.template_key === 'b_dev'); // 提交前取节点：标志为真
    assert.strictEqual((await submitCh(U.pm, ch.change.id)).status, 200);
    const resched = (extra) => post(U.pm, `/sysbuild/nodes/${dev.id}/schedule`, Object.assign({ kind: 'plan', planned_start: '2026-11-03', planned_end: '2026-11-28', reason: '顺延', no_written_evidence: true, no_evidence_reason: '口头电话确认了本次顺延安排' }, extra || {}));
    const r = await resched();
    expectErr(r, 409, 'SYSBUILD_STATE', '待确认变更期间改期');
    assert.ok(r.body.message.includes('排期已随包冻结'), r.body.message);
    expectErr(await post(U.pm, `/sysbuild/nodes/${dev.id}/cancel`, { reason: '范围调整，不再做这个节点' }), 409, 'SYSBUILD_STATE', '待确认变更期间取消节点');
    assert.strictEqual(dev.actions.schedule_plan, true, '前置：快照前标志为真');
    const during = (await planOf(s.pid)).nodes.find((n) => n.id === dev.id);
    assert.deepStrictEqual([during.actions.schedule_plan, during.actions.cancel], [false, false], '读接口标志同源为假');
    const vid = (await pendingOf(ch.change.id)).id;
    assert.strictEqual((await withdraw(U.pm, vid, '撤回恢复排期')).status, 200);
    assert.strictEqual((await resched()).status, 201, '撤回后恢复');
  });

  // ═══════════════════════ 10 窗口互斥 ═══════════════════════
  test(`${T_HISTORY}——P58 历史补录窗口互斥：窗口开启期间总体规划包有历史导入 / 历史补录记录时，变更的提交 / 改发 / 代录 409（对象 = 总体规划包，变更生效会替换它的生效版本）；窗口关闭后恢复`, async () => {
    const s = await mkScene();
    const ch = await mkChange(s.pid);
    assert.strictEqual((await submitCh(U.pm, ch.change.id)).status, 200);
    const vid = (await pendingOf(ch.change.id)).id;
    const task = (await tasksOf(vid))[0];
    const evidence = async () => ({ revision_id: task.rev_id, object_version_id: vid, decision: 'confirm', external_date: '2026-10-25', actual_confirmer: '甲部负责人', identity_basis: '电话确认记录', attachment_ids: [await stageAtt(s.pid, U.pm, '2')] });
    // 夹具：窗口开启 + 总体规划包有历史导入记录
    await sqlRun("UPDATE sysbuild_projects SET history_window = 'open' WHERE id = ?", [s.pid]);
    await sqlRun("INSERT INTO sysbuild_history_imports (project_id, object_type, object_id, fact_type, actual_confirmer, identity_basis, original_date, imported_by) VALUES (?, 'package_version', ?, 'package_effective', '甲部负责人', '会议纪要', '2026-10-01', ?)", [s.pid, s.eff.pv, U.pm]);
    const rr = await post(U.pm, `/sysbuild/confirm-tasks/${task.task_id}/reissue`, { reason: '窗口期间改发' });
    expectErr(rr, 409, 'SYSBUILD_STATE', '改发被窗口互斥');
    assert.ok(rr.body.message.includes('历史补录中'), rr.body.message);
    const px = await post(U.pm, `/sysbuild/confirm-tasks/${task.task_id}/proxy`, await evidence());
    expectErr(px, 409, 'SYSBUILD_STATE', '代录被窗口互斥');
    assert.ok(px.body.message.includes('历史补录中'), px.body.message);
    const detail = await get(U.pm, `/sysbuild/confirm-tasks/${task.task_id}`);
    assert.deepStrictEqual([detail.body.actions.reissue, detail.body.actions.proxy], [false, false], '任务详情标志同源为假');
    // 提交：另一个草稿变更（先撤回待确认的）被互斥拦下，标志为假
    assert.strictEqual((await withdraw(U.pm, vid, '为提交用例撤回')).status, 200);
    const c2 = await mkChange(s.pid);
    const sb = await submitCh(U.pm, c2.change.id);
    expectErr(sb, 409, 'SYSBUILD_STATE', '提交被窗口互斥');
    assert.ok(sb.body.message.includes('历史补录中'), sb.body.message);
    assert.strictEqual((await chGet(U.pm, c2.change.id)).actions.submit, false, '提交标志同源为假');
    // 窗口关闭后恢复
    await sqlRun("UPDATE sysbuild_projects SET history_window = 'closed' WHERE id = ?", [s.pid]);
    assert.strictEqual((await submitCh(U.pm, c2.change.id)).status, 200, '窗口关闭后恢复');
  });

  // ═══════════════════════ 11 改发与代录 ═══════════════════════
  test(`${T_REISSUE}——变更确认任务沿用内容包的改发 / 代录：PM 改发（重新解析当前负责人 / 代表人，新修订待确认）；无账号代表人的任务只能由 PM 代录（凭据附件），代录确认计入通过并可使变更生效`, async () => {
    const s = await mkScene();
    // 甲部代表人换成无账号成员：撤销原授权，新建无账号成员 + 授权
    await sqlRun("UPDATE sysbuild_delegations SET status = 'revoked', revoked_at = '2026-10-20 10:00:00', revoke_reason = '换人' WHERE party_id = ? AND status = 'active'", [s.A]);
    const apt = await sqlGet("SELECT id FROM sysbuild_appointments WHERE party_id = ? AND status = 'active'", [s.A]);
    const noAcct = (await sqlRun("INSERT INTO sysbuild_members (project_id, party_id, user_id, person_name, joined_at, added_by) VALUES (?, ?, NULL, '无账号代表人', '2026-10-01 10:00:00', ?)", [s.pid, s.A, U.pm])).lastID;
    await addDelegation(s.A, noAcct, apt.id, 'active');
    const ch = await mkChange(s.pid);
    assert.strictEqual((await submitCh(U.pm, ch.change.id)).status, 200);
    const vid = (await pendingOf(ch.change.id)).id;
    const ts = await sqlAll(
      `SELECT t.id AS tid, r.id AS rid, r.required_member_id AS mid, m.user_id AS uid FROM sysbuild_confirm_tasks t JOIN sysbuild_confirm_task_revisions r ON r.task_id = t.id JOIN sysbuild_members m ON m.id = r.required_member_id
        WHERE t.object_type = 'package_version' AND t.object_version_id = ? ORDER BY t.id`, [vid]
    );
    assert.strictEqual(ts.length, 2);
    const proxyTask = ts.find((t) => t.uid === null);
    const ownTask = ts.find((t) => t.uid === U.own);
    assert.strictEqual(proxyTask.mid, noAcct, '代表人任务的必需确认人 = 无账号成员');
    // 改发：负责人任务重新解析（仍是 own）→ 新修订；旧修订 superseded
    const rs = await post(U.pm, `/sysbuild/confirm-tasks/${ownTask.tid}/reissue`, { reason: '重新发给负责人' });
    assert.strictEqual(rs.status, 200, rs.text);
    assert.deepStrictEqual([rs.body.revision.rev_no, rs.body.revision.status, rs.body.revision.required_member_id], [2, 'pending', ownTask.mid]);
    expectErr(await post(U.m1, `/sysbuild/confirm-tasks/${ownTask.tid}/reissue`, { reason: 'x' }), 403, 'SYSBUILD_FORBIDDEN', '一般成员不能改发');
    // 无账号代表人只能代录：PM 代录通过（外部确认日期不早于修订创建日：夹具把修订创建时间回拨）
    await sqlRun("UPDATE sysbuild_confirm_task_revisions SET created_at = '2026-10-20 09:00:00' WHERE id = ?", [proxyTask.rid]);
    const proxyBody = async () => ({ revision_id: proxyTask.rid, object_version_id: vid, decision: 'confirm', external_date: '2026-10-25', actual_confirmer: '无账号代表人', identity_basis: '电话确认记录', attachment_ids: [await stageAtt(s.pid, U.pm, '3')] });
    const px = await post(U.pm, `/sysbuild/confirm-tasks/${proxyTask.tid}/proxy`, await proxyBody());
    assert.strictEqual(px.status, 200, px.text);
    assert.strictEqual(px.body.effective, false, '还差负责人');
    const last = await openAndDecide(U.own, ownTask.tid, 'confirm');
    assert.strictEqual(last.status, 200, last.text);
    assert.strictEqual(last.body.effective, true, '代录确认计入通过，变更生效');
    assert.strictEqual((await chRow(ch.change.id)).status, 'effective');
  });

  // ═══════════════════════ 12 转变更与挂靠 ═══════════════════════
  test(`${T_ENTRY}——登记结论「转正式变更」必带 change_id（缺 400；不存在 / 不属本项目 / 已撤回 409；其余结论类别不许带），同一事务写 link_change 办理记录，结论照常经代表人确认；link_change 作为独立办理动作开放（PM，给已有结论的办理类登记补挂变更号，重复 409、无结论 / 作废 / 知悉类 409）`, async () => {
    const s = await mkScene();
    const other = await mkScene();
    const chA = await mkChange(s.pid);
    const chB = await mkChange(s.pid);
    const chForeign = await mkChange(other.pid);
    const reg = async (extra) => (await post(U.m1, `/sysbuild/projects/${s.pid}/entries`, Object.assign({ type: 'feedback', title: '要加导出', body: '希望能批量导出' }, extra || {}))).body.entry;
    const act = (uid, eid, body) => post(uid, `/sysbuild/entries/${eid}/actions`, body);
    const TC = (id, extra) => Object.assign({ action: 'conclude', conclusion_kind: 'to_change', text: '转正式变更处理' }, id === undefined ? {} : { change_id: id }, extra || {});
    const e = await reg();
    // conclude_kinds 按类别可用性列出 to_change（不带 change_id）
    assert.ok((await get(U.pm, `/sysbuild/entries/${e.id}`)).body.entry.actions.conclude_kinds.includes('to_change'));
    // 校验：缺 400、别项目 409、不存在 409、非转变更类别带 change_id 400
    const miss = await act(U.pm, e.id, TC());
    expectErr(miss, 400, 'SYSBUILD_INVALID_INPUT', '缺 change_id');
    assert.strictEqual(miss.body.field, 'change_id');
    expectErr(await act(U.pm, e.id, TC(chForeign.change.id)), 409, 'SYSBUILD_STATE', '别的项目的变更');
    expectErr(await act(U.pm, e.id, TC(99999999)), 409, 'SYSBUILD_STATE', '变更不存在');
    expectErr(await act(U.pm, e.id, { action: 'conclude', conclusion_kind: 'handled', text: 'x', change_id: chA.change.id }), 400, 'SYSBUILD_INVALID_INPUT', '非转变更类别带 change_id');
    // 已撤回的变更 409
    const wdv = (await draftOf(chB.change.id));
    assert.strictEqual((await submitCh(U.pm, chB.change.id)).status, 200);
    assert.strictEqual((await withdraw(U.pm, wdv.id, '撤回备用变更')).status, 200);
    expectErr(await act(U.pm, e.id, TC(chB.change.id)), 409, 'SYSBUILD_STATE', '已撤回的变更');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_entry_actions WHERE entry_id = ?', [e.id]), 0, '被拒不留办理记录');
    // 成功：结论带 change_id，同一事务写 link_change 记录；结论经甲部代表人确认
    const ok = await act(U.pm, e.id, TC(chA.change.id));
    assert.strictEqual(ok.status, 201, ok.text);
    assert.deepStrictEqual([ok.body.entry.current_conclusion.kind, ok.body.entry.current_conclusion.change_id, ok.body.entry.conclusion_state], ['to_change', chA.change.id, 'pending_confirm']);
    const rows = await sqlAll('SELECT action, conclusion_kind, change_id, text FROM sysbuild_entry_actions WHERE entry_id = ? ORDER BY id', [e.id]);
    assert.deepStrictEqual(rows.map((r) => [r.action, r.conclusion_kind, r.change_id, r.text]), [['conclude', 'to_change', chA.change.id, '转正式变更处理'], ['link_change', null, chA.change.id, '随转正式变更结论挂靠变更']]);
    const evs = (await payloads(s.pid, 'entry_action_recorded')).filter((p) => p.change_id === chA.change.id);
    assert.deepStrictEqual(evs.map((p) => p.action), ['conclude', 'link_change'], '两条办理记录各一个事件');
    assert.strictEqual(evs[1].via, 'conclude_to_change');
    const ctask = await sqlGet("SELECT id FROM sysbuild_confirm_tasks WHERE object_type = 'conclusion' AND object_id = ?", [e.id]);
    assert.strictEqual((await openAndDecide(U.del, ctask.id, 'confirm')).status, 200);
    assert.strictEqual((await get(U.pm, `/sysbuild/entries/${e.id}`)).body.entry.conclusion_state, 'confirmed');
    // link_change 独立动作：给已有结论的登记补挂另一个变更；重复挂靠 409；标志同源
    const chC = await mkChange(s.pid);
    assert.strictEqual((await get(U.pm, `/sysbuild/entries/${e.id}`)).body.entry.actions.link_change, true);
    expectErr(await act(U.pm, e.id, { action: 'link_change' }), 400, 'SYSBUILD_INVALID_INPUT', '缺 change_id');
    const lk = await act(U.pm, e.id, { action: 'link_change', change_id: chC.change.id, text: '补挂第二个变更' });
    assert.strictEqual(lk.status, 201, lk.text);
    assert.strictEqual(lk.body.entry.conclusion_state, 'confirmed', '只追加办理记录，不改结论状态');
    expectErr(await act(U.pm, e.id, { action: 'link_change', change_id: chC.change.id }), 409, 'SYSBUILD_STATE', '重复挂靠');
    expectErr(await act(U.pm, e.id, { action: 'link_change', change_id: chA.change.id }), 409, 'SYSBUILD_STATE', '结论已挂靠的变更再挂靠');
    expectErr(await act(U.pm, e.id, { action: 'link_change', change_id: chForeign.change.id }), 409, 'SYSBUILD_STATE', '别项目变更');
    expectErr(await act(U.m1, e.id, { action: 'link_change', change_id: chC.change.id }), 403, 'SYSBUILD_FORBIDDEN', '非 PM');
    assert.strictEqual((await get(U.m1, `/sysbuild/entries/${e.id}`)).body.entry.actions.link_change, false);
    // 无结论 / 作废 / 知悉类 → 409
    const noConc = await reg();
    const nc = await act(U.pm, noConc.id, { action: 'link_change', change_id: chC.change.id });
    expectErr(nc, 409, 'SYSBUILD_STATE', '无结论');
    assert.ok(nc.body.message.includes('还没有结论'), nc.body.message);
    assert.strictEqual((await get(U.pm, `/sysbuild/entries/${noConc.id}`)).body.entry.actions.link_change, false, '无结论：标志为假（同源）');
    const note = await reg({ type: 'note' });
    expectErr(await act(U.pm, note.id, { action: 'link_change', change_id: chC.change.id }), 409, 'SYSBUILD_STATE', '知悉类');
    const vd = await reg();
    assert.strictEqual((await act(U.pm, vd.id, { action: 'void', reason: '作废' })).status, 201);
    expectErr(await act(U.pm, vd.id, { action: 'link_change', change_id: chC.change.id }), 409, 'SYSBUILD_STATE', '已作废');
  });

  // ═══════════════════════ 13 确认单 ═══════════════════════
  test(`${T_SHEET}——需求确认单导出对变更版本：页头显示「范围变更包」+ 变更标题 / 说明 / 引用登记（HTML 转义），含节点计划快照（按变更提交记录）；草稿版本 409`, async () => {
    const s = await mkScene();
    const fb = (await post(U.m1, `/sysbuild/projects/${s.pid}/entries`, { type: 'feedback', title: '导出<b>反馈</b>', body: '希望能批量导出' })).body.entry;
    const ch = await mkChange(s.pid, { title: '新增<script>x</script>导出', body: '范围变更：新增一项批量导出\n第二行', from_entry_ids: [fb.id] });
    const vid = (await draftOf(ch.change.id)).id;
    expectErr(await get(U.pm, `/sysbuild/package-versions/${vid}/confirmation-sheet`), 409, 'SYSBUILD_STATE', '草稿版本');
    assert.strictEqual((await submitCh(U.pm, ch.change.id)).status, 200);
    const r = await get(U.pm, `/sysbuild/package-versions/${vid}/confirmation-sheet`);
    assert.strictEqual(r.status, 200, r.text);
    const h = String(r.text);
    assert.ok(h.includes('<th>内容包类型</th><td>范围变更包</td>'), '页头：范围变更包');
    assert.ok(h.includes('<th>变更标题</th>') && h.includes('新增&lt;script&gt;x&lt;/script&gt;导出'), '变更标题（转义）');
    assert.ok(h.includes('范围变更：新增一项批量导出\n第二行'), '变更说明');
    assert.ok(h.includes(`data-entry-id="${fb.id}"`) && h.includes(`第 ${fb.id} 条 · 导出&lt;b&gt;反馈&lt;/b&gt;`), '引用登记（转义）');
    assert.ok(!h.includes('<script>x</script>') && !h.includes('<b>反馈</b>'), '不输出未转义的用户内容');
    assert.ok(h.includes('id="sec-plans"') && h.includes('立项与授权') && h.includes('2026-11-02'), '节点计划快照（提交记录）');
    assert.ok(h.includes('data-version-status="pending"'), '版本状态待确认');
    // 总体规划包的确认单没有变更行
    const ov = await get(U.pm, `/sysbuild/package-versions/${s.eff.pv}/confirmation-sheet`);
    assert.strictEqual(ov.status, 200, ov.text);
    assert.ok(!String(ov.text).includes('变更标题') && String(ov.text).includes('总体规划包'));
  });

  // ═══════════════════════ 14 actions 同源 ═══════════════════════
  test(`${T_FLAGS}——变更读接口 actions 与执行同源：草稿 / 待确认无异议 / 待确认有异议 / 已撤回 / 已生效 × PM / 一般成员，标志手写；标志为真执行成功，为假执行 403 / 409`, async () => {
    const s = await mkScene();
    const exec = {
      submit: (uid, c) => submitCh(uid, c.id),
      withdraw: async (uid, c) => { const v = (await pendingOf(c.id)) || (await versOf(c.id)).slice(-1)[0]; return withdraw(uid, v.id, '同源用例'); },
      new_version: (uid, c) => newVer(uid, c.id, '同源用例'),
    };
    const flagsOf = async (uid, id) => { const a = (await chGet(uid, id)).actions; return { submit: a.submit, withdraw: a.withdraw, new_version: a.new_version }; };
    const check = async (label, id, want) => {
      assert.deepStrictEqual(await flagsOf(U.pm, id), want, `${label} × PM：标志手写`);
      assert.deepStrictEqual(await flagsOf(U.m1, id), { submit: false, withdraw: false, new_version: false }, `${label} × 一般成员：全假`);
      for (const name of ['submit', 'withdraw', 'new_version']) {
        const r = await exec[name](U.m1, { id });
        assert.strictEqual(r.status, 403, `${label} × 一般成员 × ${name}：403 ${r.text}`);
      }
    };
    // 草稿（未过期）：只能提交
    const c1 = await mkChange(s.pid);
    await check('草稿', c1.change.id, { submit: true, withdraw: false, new_version: false });
    for (const name of ['withdraw', 'new_version']) assert.ok([409].includes((await exec[name](U.pm, { id: c1.change.id })).status), `草稿 × PM × ${name}：标志为假 → 409`);
    // 待确认（无异议）：只能撤回
    assert.strictEqual((await exec.submit(U.pm, { id: c1.change.id })).status, 200, '草稿 × 提交：标志为真 → 200');
    await check('待确认无异议', c1.change.id, { submit: false, withdraw: true, new_version: false });
    for (const name of ['submit', 'new_version']) assert.strictEqual((await exec[name](U.pm, { id: c1.change.id })).status, 409, `待确认无异议 × PM × ${name}`);
    // 待确认（有异议）：可撤回、可出新版本
    const v1 = await pendingOf(c1.change.id);
    const t = (await tasksOf(v1.id)).find((x) => x.user_id === U.del);
    assert.strictEqual((await openAndDecide(U.del, t.task_id, 'object', { reason: '有意见' })).status, 200);
    await check('待确认有异议', c1.change.id, { submit: false, withdraw: true, new_version: true });
    assert.strictEqual((await exec.new_version(U.pm, { id: c1.change.id })).status, 201, '有异议 × 出新版本：标志为真 → 201');
    // 新草稿 → 撤回？草稿不能撤回；提交后撤回 → 已撤回
    assert.strictEqual((await exec.submit(U.pm, { id: c1.change.id })).status, 200);
    assert.strictEqual((await exec.withdraw(U.pm, { id: c1.change.id })).status, 200, '待确认 × 撤回：标志为真 → 200');
    await check('已撤回', c1.change.id, { submit: false, withdraw: false, new_version: false });
    for (const name of ['submit', 'withdraw', 'new_version']) assert.strictEqual((await exec[name](U.pm, { id: c1.change.id })).status, 409, `已撤回 × PM × ${name}`);
    // 已生效
    const c2 = await mkChange(s.pid);
    assert.strictEqual((await exec.submit(U.pm, { id: c2.change.id })).status, 200);
    assert.strictEqual((await confirmAll((await pendingOf(c2.change.id)).id)).body.effective, true);
    await check('已生效', c2.change.id, { submit: false, withdraw: false, new_version: false });
    for (const name of ['submit', 'withdraw', 'new_version']) assert.strictEqual((await exec[name](U.pm, { id: c2.change.id })).status, 409, `已生效 × PM × ${name}`);
  });

  // ═══════════════════════ 15 rules 纯函数 ═══════════════════════
  test(`${T_RULES}——手写判定矩阵：change_create / change_new_version / package_version_submit 的变更与批次需求包分支（继承来源已被替代 → 请基于现行规划重建草稿）/ package_version_create 与 package_item_add / remove 对变更包`, async () => {
    const R = T.getMods().rules;
    const idn = (o) => Object.assign({ isPm: false, isAdmin: false, isReadonly: false, userId: 50, ownerOfParties: [], delegateOfParties: [] }, o);
    const chk = (op, i, st, t) => R.checkOp(op, i, { id: 1, status: st || 'active', pm_user_id: 7 }, t || {});
    const code = (v) => (v === null ? null : `${v.status}:${v.code}`);
    const pm = idn({ isPm: true, isMember: true });
    // change_create：谁 × 总体规划是否生效 × 项目状态（maintain 行）
    assert.strictEqual(chk('change_create', pm, 'active', { overallEffective: true }), null);
    assert.strictEqual(code(chk('change_create', idn({ isMember: true }), 'active', { overallEffective: true })), '403:SYSBUILD_FORBIDDEN', '一般成员');
    assert.strictEqual(code(chk('change_create', idn({ isAdmin: true }), 'active', { overallEffective: true })), '403:SYSBUILD_FORBIDDEN', 'admin 未接管');
    assert.strictEqual(code(chk('change_create', idn({ isPm: true, isReadonly: true }), 'active', { overallEffective: true })), '403:SYSBUILD_FORBIDDEN', '只读 PM');
    for (const [st, ok] of [['active', true], ['paused', true], ['terminated', false], ['closed', false]]) {
      assert.strictEqual(code(chk('change_create', pm, st, { overallEffective: true })), ok ? null : '409:SYSBUILD_PROJECT_READONLY', `maintain 行 × ${st}`);
    }
    const nf = chk('change_create', pm, 'active', { overallEffective: false });
    assert.deepStrictEqual([code(nf), nf.message], ['409:SYSBUILD_STATE', '总体规划尚未生效，直接修改总体规划草稿']);
    assert.strictEqual(code(chk('change_create', pm, 'active', {})), '409:SYSBUILD_STATE', '事实没取到 fail-closed');
    // change_new_version：状态 × 事实
    const nv = (t) => code(chk('change_new_version', pm, 'active', t));
    assert.strictEqual(nv({ changeStatus: 'pending', hasObjection: true }), null);
    assert.strictEqual(nv({ changeStatus: 'pending', hasObjection: false }), '409:SYSBUILD_STATE');
    assert.strictEqual(nv({ changeStatus: 'pending' }), '409:SYSBUILD_STATE', '事实没取到');
    assert.strictEqual(nv({ changeStatus: 'draft', staleDraft: true }), null);
    assert.strictEqual(nv({ changeStatus: 'draft', staleDraft: false }), '409:SYSBUILD_STATE');
    assert.strictEqual(nv({ changeStatus: 'draft' }), '409:SYSBUILD_STATE', '事实没取到');
    for (const st of ['effective', 'withdrawn', 'bogus', undefined]) assert.strictEqual(nv({ changeStatus: st, hasObjection: true, staleDraft: true }), '409:SYSBUILD_STATE', `变更 ${String(st)} 不能出新版本`);
    assert.ok(chk('change_new_version', pm, 'active', { changeStatus: 'effective', hasObjection: true, staleDraft: true }).message.includes('已生效'), '已生效的文案');
    assert.ok(chk('change_new_version', pm, 'active', { changeStatus: 'withdrawn', hasObjection: true, staleDraft: true }).message.includes('已撤回'), '已撤回的文案');
    assert.strictEqual(code(chk('change_new_version', idn({ isMember: true }), 'active', { changeStatus: 'pending', hasObjection: true })), '403:SYSBUILD_FORBIDDEN');
    // package_version_submit：变更包分支
    const F = { confirmersMissing: null, historyConflict: null, parentSuperseded: false, changeEvidenceOk: true, otherPendingPackage: null }; // C6a：变更包同属待确认互斥的四类（事实 otherPendingPackage = null 表示没有别的待确认内容包）
    const sub = (o, st) => chk('package_version_submit', pm, st || 'active', Object.assign({ versionStatus: 'draft', packageType: 'change' }, F, o || {}));
    assert.strictEqual(sub({ changeStatus: 'draft', otherChangePending: false }), null);
    assert.strictEqual(code(sub({ changeStatus: 'pending', otherChangePending: false })), '409:SYSBUILD_STATE', '变更不是草稿');
    assert.strictEqual(code(sub({ changeStatus: undefined, otherChangePending: false })), '409:SYSBUILD_STATE', '变更状态没取到');
    assert.strictEqual(code(sub({ changeStatus: 'draft', otherChangePending: true })), '409:SYSBUILD_STATE', '另有待确认变更');
    assert.strictEqual(code(sub({ changeStatus: 'draft' })), '409:SYSBUILD_STATE', '另有待确认变更的事实没取到');
    assert.strictEqual(code(sub({ changeStatus: 'draft', otherChangePending: false, historyConflict: '历史补录中：该对象已有历史记录，关闭窗口后再发起' })), '409:SYSBUILD_STATE', '窗口互斥');
    assert.strictEqual(code(sub({ changeStatus: 'draft', otherChangePending: false, confirmersMissing: { noParty: false, missing: ['乙部（缺生效代表人）'] } })), '409:SYSBUILD_STATE', '缺人');
    // 预筛 M2：方向类证据提交时重核（事实 false = 不齐 → 带文案 409；事实没取到 fail-closed）
    const evBad = sub({ changeStatus: 'draft', otherChangePending: false, changeEvidenceOk: false });
    assert.deepStrictEqual([code(evBad), evBad.message.includes('方向类证据已不齐')], ['409:SYSBUILD_STATE', true], '证据不齐');
    assert.strictEqual(code(sub({ changeStatus: 'draft', otherChangePending: false, changeEvidenceOk: undefined })), '409:SYSBUILD_STATE', '证据事实没取到');
    for (const [st, ok] of [['active', true], ['paused', true], ['terminated', false], ['closed', false]]) {
      assert.strictEqual(code(sub({ changeStatus: 'draft', otherChangePending: false }, st)), ok ? null : '409:SYSBUILD_PROJECT_READONLY', `提交 × ${st}`);
    }
    // 变更包提交不要求 initiationEffective / planMissing（只对总体规划包判）
    assert.strictEqual(sub({ changeStatus: 'draft', otherChangePending: false, initiationEffective: false, planMissing: ['x'] }), null);
    // 继承来源已被替代（C4 / C5 交接）：批次需求包（第一期没有，类型本身不开放提交）与变更包 / 总体规划包共用，先于类型判定
    const sup = chk('package_version_submit', pm, 'active', { versionStatus: 'draft', packageType: 'batch_req', parentSuperseded: true });
    assert.deepStrictEqual([code(sup), sup.message.includes('请基于现行规划重建草稿')], ['409:SYSBUILD_STATE', true], '批次需求包：parent 已被替代');
    const notSup = chk('package_version_submit', pm, 'active', { versionStatus: 'draft', packageType: 'batch_req', parentSuperseded: false });
    assert.ok(notSup.message.includes('C5 / C6 起可用'), '批次需求包 parent 未被替代：仍是类型未开放的文案');
    assert.ok(chk('package_version_submit', pm, 'active', Object.assign({ versionStatus: 'draft', packageType: 'overall', initiationEffective: true, planMissing: null }, F, { parentSuperseded: true })).message.includes('请基于现行规划重建草稿'));
    assert.strictEqual(chk('package_version_submit', pm, 'active', Object.assign({ versionStatus: 'draft', packageType: 'overall', initiationEffective: true, planMissing: null }, F)), null, '总体规划包 parent 未被替代照常');
    assert.strictEqual(chk('package_version_submit', pm, 'active', Object.assign({ versionStatus: 'draft', packageType: 'initiation' }, F)), null);
    // package_version_create 对变更包 409；package_item_add / remove 对变更包放行、对别的类型仍拒绝
    const pc = chk('package_version_create', pm, 'active', { packageType: 'change', hasDraft: false, hasPending: false, hasEffective: false });
    assert.deepStrictEqual([code(pc), pc.message.includes('只经正式变更产生')], ['409:SYSBUILD_STATE', true]);
    for (const [type, ok] of [['overall', true], ['change', true], ['initiation', false], ['batch_req', false], ['closing', false]]) {
      assert.strictEqual(code(chk('package_item_add', pm, 'active', { versionStatus: 'draft', packageType: type, inSet: false, commitBatchStatus: 'planning' })), ok ? null : '409:SYSBUILD_STATE', `集合修订 add × ${type}`);
      assert.strictEqual(code(chk('package_item_remove', pm, 'active', { versionStatus: 'draft', packageType: type, inSet: true })), ok ? null : '409:SYSBUILD_STATE', `集合修订 remove × ${type}`);
    }
    assert.deepStrictEqual(R.SUBMITTABLE_PACKAGE_TYPES.slice(), ['overall', 'initiation', 'change', 'batch_accept', 'closing']); // C6a：加入批次验收包与结项包
  });

  // ═══════════════════════ 15 预筛修订批（#113 C5 S-S1c 预筛 4 轮）═══════════════════════
  const attDel = (aid, on) => sqlRun(on ? "UPDATE sysbuild_attachments SET deleted_at = '2026-10-30 10:00:00', deleted_by = 1 WHERE id = ?" : 'UPDATE sysbuild_attachments SET deleted_at = NULL, deleted_by = NULL WHERE id = ?', [aid]);
  const nodeIdOf = async (pid, key) => (await sqlGet('SELECT id FROM sysbuild_nodes WHERE project_id = ? AND template_key = ?', [pid, key])).id;

  test(`${T_Y_IMPORT}——历史导入包版本不接变更包：窗口开启时对变更包草稿版本导入 package_effective → 409「正式变更不支持历史生效导入」（不是 500），不写导入记录、不改版本与变更状态`, async () => {
    const s = await mkScene();
    const ch = await mkChange(s.pid);
    const vid = (await draftOf(ch.change.id)).id;
    await sqlRun("UPDATE sysbuild_projects SET history_window = 'open' WHERE id = ?", [s.pid]);
    const r = await post(U.pm, `/sysbuild/projects/${s.pid}/history-imports`, { fact_type: 'package_effective', object_id: vid, actual_confirmer: '甲部负责人', identity_basis: '会议纪要', original_date: '2026-10-25', attachment_ids: [await stageAtt(s.pid, U.pm, '5')] });
    expectErr(r, 409, 'SYSBUILD_STATE', '变更包历史导入');
    assert.ok(r.body.message.includes('正式变更不支持历史生效导入'), r.body.message);
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_history_imports WHERE project_id = ?', [s.pid]), 0, '不写导入记录');
    assert.deepStrictEqual([(await draftOf(ch.change.id)).status, (await chRow(ch.change.id)).status], ['draft', 'draft'], '版本与变更状态不变');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id WHERE p.project_id = ? AND p.type = 'overall' AND v.status = 'effective'", [s.pid]), 1, '总体规划的生效版本不变');
  });

  test(`${T_Y_EVID}——变更方向类证据提交时重核：建时有附件、提交前附件被软删除 → 提交 409（读接口 actions.submit 同源为假）；无书面证据的原因被改短同样 409；证据恢复后放行`, async () => {
    const s = await mkScene();
    const att = await stageAtt(s.pid, U.pm, '6');
    const ch = await mkChange(s.pid, { attachment_ids: [att], no_written_evidence: undefined, no_evidence_reason: undefined });
    const cid = ch.change.id;
    const taskCount = () => countOf("SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE project_id = ? AND object_type = 'package_version'", [s.pid]);
    const tasksBefore = await taskCount(); // 夹具里总体规划生效时已有确认任务
    assert.strictEqual((await chGet(U.pm, cid)).actions.submit, true, '对照：证据齐全时标志为真');
    await attDel(att, true);
    const r = await submitCh(U.pm, cid);
    expectErr(r, 409, 'SYSBUILD_STATE', '附件已被软删除');
    assert.ok(r.body.message.includes('方向类证据已不齐'), r.body.message);
    assert.strictEqual((await chGet(U.pm, cid)).actions.submit, false, '标志同源为假');
    assert.strictEqual((await chRow(cid)).status, 'draft', '被拒不改状态');
    assert.strictEqual(await taskCount(), tasksBefore, '被拒不建任务');
    // 无书面证据声明 + 原因（库内 CHECK 保证原因 ≥ 10 字，不能被改短）：不依赖附件，不受附件被删除的影响
    const ch2 = await mkChange(s.pid);
    assert.strictEqual((await chGet(U.pm, ch2.change.id)).actions.submit, true, '无书面证据声明：标志为真');
    // 附件恢复 → 放行
    await attDel(att, false);
    assert.strictEqual((await chGet(U.pm, cid)).actions.submit, true);
    assert.strictEqual((await submitCh(U.pm, cid)).status, 200, '证据恢复后放行');
  });

  test(`${T_Y_WINDOW}——P58 窗口互斥对变更包 = 变更包自身 ∪ 总体规划包（并集，不是替换）：总体规划包没有历史记录时，给变更版本自身补录历史确认后，改发 / 代录 / 同一变更出新版本后的提交都 409；窗口关闭后恢复`, async () => {
    const s = await mkScene();
    const ch = await mkChange(s.pid);
    assert.strictEqual((await submitCh(U.pm, ch.change.id)).status, 200);
    const vid = (await pendingOf(ch.change.id)).id;
    const tasks = await tasksOf(vid);
    const ownTask = tasks.find((t) => t.user_id === U.own);
    const delTask = tasks.find((t) => t.user_id === U.del);
    await sqlRun("UPDATE sysbuild_projects SET history_window = 'open' WHERE id = ?", [s.pid]);
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_history_imports WHERE project_id = ?', [s.pid]), 0, '夹具：总体规划包没有历史导入');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_confirmations c JOIN sysbuild_package_versions v ON v.id = c.object_version_id JOIN sysbuild_packages p ON p.id = v.package_id WHERE c.method = 'history' AND c.object_type = 'package_version' AND p.project_id = ?", [s.pid]), 0, '夹具：本项目没有任何历史补录记录');
    assert.strictEqual((await get(U.pm, `/sysbuild/confirm-tasks/${ownTask.task_id}`)).body.actions.reissue, true, '对照：窗口开启、没有任何历史记录时可改发');
    const ev = async () => ({ object_type: 'package_version', object_version_id: vid, decision: 'confirm', external_date: '2026-10-25', actual_confirmer: '甲部负责人', identity_basis: '电话确认记录', attachment_ids: [await stageAtt(s.pid, U.pm, '7')] });
    const hc = await post(U.pm, `/sysbuild/projects/${s.pid}/history-confirmations`, await ev());
    assert.strictEqual(hc.status, 201, hc.text);
    const rr = await post(U.pm, `/sysbuild/confirm-tasks/${ownTask.task_id}/reissue`, { reason: '窗口期间改发' });
    expectErr(rr, 409, 'SYSBUILD_STATE', '变更自身有历史记录：改发');
    assert.ok(rr.body.message.includes('历史补录中'), rr.body.message);
    const px = await post(U.pm, `/sysbuild/confirm-tasks/${ownTask.task_id}/proxy`, { revision_id: ownTask.rev_id, object_version_id: vid, decision: 'confirm', external_date: '2026-10-25', actual_confirmer: '甲部负责人', identity_basis: '电话确认记录', attachment_ids: [await stageAtt(s.pid, U.pm, '8')] });
    expectErr(px, 409, 'SYSBUILD_STATE', '变更自身有历史记录：代录');
    assert.ok(px.body.message.includes('历史补录中'), px.body.message);
    const det = await get(U.pm, `/sysbuild/confirm-tasks/${ownTask.task_id}`);
    assert.deepStrictEqual([det.body.actions.reissue, det.body.actions.proxy], [false, false], '任务详情标志同源为假');
    // 同一变更：甲部代表人提异议 → PM 出新版本 → 新草稿提交 409（变更包自身有历史记录），标志为假
    assert.strictEqual((await openAndDecide(U.del, delTask.task_id, 'object', { reason: '范围太大' })).status, 200);
    const nv = await newVer(U.pm, ch.change.id, '按意见调整');
    assert.strictEqual(nv.status, 201, nv.text);
    const sb = await submitCh(U.pm, ch.change.id);
    expectErr(sb, 409, 'SYSBUILD_STATE', '变更自身有历史记录：提交');
    assert.ok(sb.body.message.includes('历史补录中'), sb.body.message);
    assert.strictEqual((await chGet(U.pm, ch.change.id)).actions.submit, false, '提交标志同源为假');
    await sqlRun("UPDATE sysbuild_projects SET history_window = 'closed' WHERE id = ?", [s.pid]);
    assert.strictEqual((await submitCh(U.pm, ch.change.id)).status, 200, '窗口关闭后恢复');
  });

  test(`${T_Y_LIVE}——变更集合重核：现行规划里承诺批次已上线的条目不得从集合移出 → 提交 409「已上线条目不能移出规划，后续增强请建新条目」；批次未上线时同样的移出放行`, async () => {
    const s = await mkScene();
    const ch = await mkChange(s.pid);
    const vid = (await draftOf(ch.change.id)).id;
    const i2 = await mkItem(s.pid);
    assert.strictEqual((await addItemTo(vid, i2.versions[0].id, s.batch1)).status, 201, '夹具：加入另一个条目（集合不为空）');
    assert.strictEqual((await rmItemFrom(vid, s.i1v)).status, 201, '把现行规划里的 i1 移出');
    // 夹具：第 1 批已正式上线——C6a 起判据是上线事件（entries-core.batchLiveState：最后一条事件是 golive / regolive 且当前时刻严格晚于它），不再读 batches.status；
    //   这里只造「已上线」这个事实（上线前置不是本用例的对象），所以直接写事件，时刻写成一小时前；经生产端点上线的完整路径在 sysbuild-api-suite-golive.js。
    await sqlRun("INSERT INTO sysbuild_golive_events (batch_id, kind, handover_snapshot_json, created_by, created_at) VALUES (?, 'golive', '{}', ?, datetime('now','localtime','-1 hour'))", [s.batch1, U.pm]);
    const tasksBefore = await countOf("SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE project_id = ? AND object_type = 'package_version'", [s.pid]); // 夹具里总体规划生效时已有确认任务
    const r = await submitCh(U.pm, ch.change.id);
    expectErr(r, 409, 'SYSBUILD_STATE', '已上线条目移出');
    assert.ok(r.body.message.includes('已上线条目不能移出规划，后续增强请建新条目'), r.body.message);
    const code = (await sqlGet('SELECT code FROM sysbuild_items WHERE id = ?', [s.i1])).code;
    assert.ok(r.body.message.includes(code), `文案列出条目编号 ${code}：${r.body.message}`);
    assert.strictEqual((await chRow(ch.change.id)).status, 'draft', '被拒不改状态');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE project_id = ? AND object_type = 'package_version'", [s.pid]), tasksBefore, '被拒不建任务');
    // 对照：批次未上线时同样的移出放行（上线才是拦截条件）
    // 对照：撤销上线（追加一条 revoke 事件，最后一条事件是撤销 = 未上线）后，同样的移出放行
    await sqlRun("INSERT INTO sysbuild_golive_events (batch_id, kind, reason, created_by) VALUES (?, 'revoke', '用例夹具：撤销上线', ?)", [s.batch1, U.pm]);
    assert.strictEqual((await submitCh(U.pm, ch.change.id)).status, 200, '对照：批次未上线，移出放行');
  });

  test(`${T_Y_LAPSE}——登记结论「转正式变更」所挂变更被撤回 → 派生 to_change_lapsed（不属有效结论：conclude_kinds 非空、可再给结论、收口前置算未结；已确定 / 已确认两种有效结论都适用）；变更生效则结论保持有效`, async () => {
    const s = await mkScene();
    const nid = await nodeIdOf(s.pid, 'b_dev');
    assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${nid}/start`)).status, 200, '夹具：节点开工');
    const reg = async (uid, extra) => (await post(uid, `/sysbuild/projects/${s.pid}/entries`, Object.assign({ type: 'feedback', title: '要加导出', body: '希望能批量导出', node_id: nid }, extra || {}))).body.entry;
    const act = (uid, eid, body) => post(uid, `/sysbuild/entries/${eid}/actions`, body);
    const TC = (id) => ({ action: 'conclude', conclusion_kind: 'to_change', text: '转正式变更处理', change_id: id });
    const stateOf = async (eid) => (await get(U.pm, `/sysbuild/entries/${eid}`)).body.entry.conclusion_state;
    const blockedIds = async () => {
      const node = (await get(U.pm, `/sysbuild/projects/${s.pid}/plan`)).body.nodes.find((n) => n.id === nid);
      const b = node.close_blockers.find((x) => x.code === 'ENTRY_UNRESOLVED');
      return b ? b.entry_ids : [];
    };
    // ① 已确认的「转正式变更」结论：变更提交后撤回 → lapsed
    const chA = await mkChange(s.pid);
    const e = await reg(U.m1);
    assert.strictEqual((await act(U.pm, e.id, TC(chA.change.id))).status, 201);
    assert.strictEqual((await openAndDecide(U.del, (await sqlGet("SELECT id FROM sysbuild_confirm_tasks WHERE object_type = 'conclusion' AND object_id = ?", [e.id])).id, 'confirm')).status, 200);
    assert.strictEqual(await stateOf(e.id), 'confirmed');
    assert.ok(!(await blockedIds()).includes(e.id), '已确认的结论：不阻塞收口');
    const vA = (await draftOf(chA.change.id)).id;
    assert.strictEqual((await submitCh(U.pm, chA.change.id)).status, 200);
    assert.strictEqual(await stateOf(e.id), 'confirmed', '变更待确认期间结论仍有效');
    assert.strictEqual((await withdraw(U.pm, vA, '撤回变更')).status, 200);
    assert.strictEqual((await chRow(chA.change.id)).status, 'withdrawn');
    const d = (await get(U.pm, `/sysbuild/entries/${e.id}`)).body.entry;
    assert.strictEqual(d.conclusion_state, 'to_change_lapsed', '变更撤回后结论失效');
    assert.strictEqual(d.current_conclusion.kind, 'to_change', '办理记录里的旧结论保留');
    assert.ok(d.actions.conclude === true && d.actions.conclude_kinds.includes('handled'), 'lapsed：actions.conclude 为真、conclude_kinds 非空');
    assert.ok((await blockedIds()).includes(e.id), 'lapsed：收口前置算未结（阻塞节点收口）');
    assert.strictEqual(d.actions.link_change, true, '办理记录里仍有结论动作，link_change 标志照常');
    // 再给结论走正常确认，恢复为已确认并解除阻塞
    assert.strictEqual((await act(U.pm, e.id, { action: 'conclude', conclusion_kind: 'handled', text: '改为已处理' })).status, 201);
    assert.strictEqual(await stateOf(e.id), 'pending_confirm');
    const ct = await sqlGet("SELECT id FROM sysbuild_confirm_tasks WHERE object_type = 'conclusion' AND object_id = ? ORDER BY id DESC", [e.id]);
    assert.strictEqual((await openAndDecide(U.del, ct.id, 'confirm')).status, 200);
    assert.strictEqual(await stateOf(e.id), 'confirmed');
    assert.ok(!(await blockedIds()).includes(e.id), '再给结论确认后解除阻塞');
    // ② 已确定（不需确认，PM 本人登记）的「转正式变更」结论同样适用
    const chC = await mkChange(s.pid);
    const ePm = await reg(U.pm);
    assert.strictEqual((await act(U.pm, ePm.id, TC(chC.change.id))).body.entry.conclusion_state, 'settled_no_confirm');
    const vC = (await draftOf(chC.change.id)).id;
    assert.strictEqual((await submitCh(U.pm, chC.change.id)).status, 200);
    assert.strictEqual((await withdraw(U.pm, vC, '撤回变更')).status, 200);
    assert.strictEqual(await stateOf(ePm.id), 'to_change_lapsed', '已确定的结论也失效');
    assert.ok((await blockedIds()).includes(ePm.id));
    // ③ 变更生效 → 结论保持有效；草稿 / 待确认的变更不影响
    const chB = await mkChange(s.pid);
    const eB = await reg(U.m1);
    assert.strictEqual((await act(U.pm, eB.id, TC(chB.change.id))).status, 201);
    assert.strictEqual((await openAndDecide(U.del, (await sqlGet("SELECT id FROM sysbuild_confirm_tasks WHERE object_type = 'conclusion' AND object_id = ?", [eB.id])).id, 'confirm')).status, 200);
    const vB = (await draftOf(chB.change.id)).id;
    assert.strictEqual((await submitCh(U.pm, chB.change.id)).status, 200);
    assert.strictEqual((await confirmAll(vB)).body.effective, true, '变更生效');
    assert.strictEqual(await stateOf(eB.id), 'confirmed', '变更生效：结论保持有效');
    assert.ok(!(await blockedIds()).includes(eB.id));
  });

  test(`${T_Y_LINK}——link_change 的 actions 同源矩阵：登记状态（无结论 / 已有结论 / 已作废 / 已拆分容器 / 知悉类）× 角色（PM / 登记人 / 其他成员 / 只读账号 / admin 未接管）+ 已终止项目，标志手写；标志为真执行 201，为假执行 403 / 409`, async () => {
    const s = await mkScene();
    await addMember(s.pid, U.m2, { party: s.A });
    const o1 = await mkItem(s.pid);
    const o2 = await mkItem(s.pid);
    const reg = async (extra) => (await post(U.m1, `/sysbuild/projects/${s.pid}/entries`, Object.assign({ type: 'feedback', title: '要加导出', body: '希望能批量导出' }, extra || {}))).body.entry;
    const act = (uid, eid, body) => post(uid, `/sysbuild/entries/${eid}/actions`, body);
    const states = { none: await reg(), concluded: await reg(), voided: await reg(), container: await reg({ type: 'issue', item_ids: [o1.id, o2.id] }), note: await reg({ type: 'note' }) };
    assert.strictEqual((await act(U.pm, states.concluded.id, { action: 'conclude', conclusion_kind: 'handled', text: '已处理' })).status, 201);
    assert.strictEqual((await act(U.pm, states.voided.id, { action: 'conclude', conclusion_kind: 'handled', text: '先给结论（待确认）' })).status, 201); // 作废前有结论，区分「作废」与「没有结论」两道判定
    assert.strictEqual((await act(U.pm, states.voided.id, { action: 'void', reason: '作废' })).status, 201);
    assert.strictEqual((await act(U.pm, states.container.id, { action: 'split', groups: [[o1.id], [o2.id]] })).status, 201);
    assert.strictEqual((await get(U.pm, `/sysbuild/entries/${states.container.id}`)).body.entry.conclusion_state, 'split_container', '夹具：已拆分容器');
    const want = { none: false, concluded: true, voided: false, container: false, note: false }; // PM 的手写期望；其他角色一律假
    const flag = async (uid, eid) => (await get(uid, `/sysbuild/entries/${eid}`)).body.entry.actions.link_change;
    for (const [role, uid, isPm] of [['PM', U.pm, true], ['登记人', U.m1, false], ['其他成员', U.m2, false], ['只读账号', U.ro, false], ['admin 未接管', U.admin, false]]) {
      for (const [state, e] of Object.entries(states)) {
        const expected = isPm ? want[state] : false;
        assert.strictEqual(await flag(uid, e.id), expected, `${state} × ${role}：link_change 标志手写期望`);
        const c = await mkChange(s.pid);
        const r = await act(uid, e.id, { action: 'link_change', change_id: c.change.id });
        if (expected) assert.strictEqual(r.status, 201, `${state} × ${role}：标志为真应成功 ${r.text}`);
        else if (!isPm) assert.strictEqual(r.status, 403, `${state} × ${role}：没有权限 403（权限先于状态）${r.text}`);
        else assert.strictEqual(r.status, 409, `${state} × ${role}：标志为假应 409 ${r.text}`);
      }
    }
    // 已终止项目：resolve 类（四态都允许），已有结论的登记标志仍为真、仍可执行；无结论的仍为假
    const e2 = await reg();
    assert.strictEqual((await act(U.pm, e2.id, { action: 'conclude', conclusion_kind: 'handled', text: '已处理' })).status, 201);
    const cT = await mkChange(s.pid);
    const cT2 = await mkChange(s.pid);
    assert.strictEqual((await post(U.admin, `/sysbuild/projects/${s.pid}/status`, { to: 'terminated', reason: 'link_change 矩阵' })).status, 200);
    assert.strictEqual(await flag(U.pm, e2.id), true, '已终止：已有结论的登记标志仍为真');
    assert.strictEqual(await flag(U.pm, states.none.id), false, '已终止：无结论仍为假');
    assert.strictEqual((await act(U.pm, e2.id, { action: 'link_change', change_id: cT.change.id })).status, 201, '已终止：仍可挂靠');
    expectErr(await act(U.pm, states.none.id, { action: 'link_change', change_id: cT2.change.id }), 409, 'SYSBUILD_STATE', '已终止：无结论 409');
  });

  // ═══════════════════════ 修订批 3（codex 26 M1 / M2 / L1、预筛快看 L6 / L7）═══════════════════════
  const sheetOf = async (vid) => {
    const r = await get(U.pm, `/sysbuild/package-versions/${vid}/confirmation-sheet`);
    assert.strictEqual(r.status, 200, r.text);
    return String(r.text);
  };
  const secOf = (h, id) => {
    const a = h.indexOf(`<section id="${id}">`);
    assert.ok(a >= 0, `确认单缺少 ${id} 小节`);
    return h.slice(a, h.indexOf('</section>', a));
  };

  test(`${T_W_FREEZE}——M1：变更生效派生的新总体规划版本带冻结清单：同一事务把变更版本的冻结清单（条目附件、包附件、方向类证据）逐行复制到新版本（编号与 sha256 照抄冻结时的值，不读附件现值），冻结读取（frozenSetOf）与变更版本全等；导出新总体版本的确认单含这些冻结附件`, async () => {
    const s = await mkScene();
    const att = await stageAtt(s.pid, U.pm, 'f');
    const ch = await mkChange(s.pid, { attachment_ids: [att], no_written_evidence: undefined, no_evidence_reason: undefined }); // 方向类证据 = 附件（owner_type = change）
    const v1 = await draftOf(ch.change.id);
    assert.strictEqual((await submitCh(U.pm, ch.change.id)).status, 200);
    const frozenChange = await frozenOf('package_version', v1.id);
    assert.ok(frozenChange.some((f) => f.attachment_id === att && f.sha256 === 'f'.repeat(64)), `前置：变更版本冻结清单含方向类证据附件，实际 ${JSON.stringify(frozenChange)}`);
    assert.ok(frozenChange.length >= 1);
    // 附件现值在提交之后被改（模拟「现值与冻结时不同」）：复制必须照抄冻结值，不读现值
    await sqlRun('UPDATE sysbuild_attachments SET sha256 = ? WHERE id = ?', ['a'.repeat(64), att]);
    const last = await confirmAll(v1.id);
    assert.strictEqual(last.body.effective, true, last.text);
    const vNew = await effOverall(s.pid);
    assert.notStrictEqual(vNew.id, s.eff.pv);
    assert.deepStrictEqual(await frozenOf('package_version', vNew.id), frozenChange, '新总体规划版本的冻结清单与变更版本全等（编号与 sha256 照抄）');
    assert.strictEqual((await frozenOf('package_version', vNew.id)).find((f) => f.attachment_id === att).sha256, 'f'.repeat(64), '照抄冻结时的 sha256，不是附件现值');
    assert.deepStrictEqual(await frozenOf('package_version', v1.id), frozenChange, '变更版本自己的冻结清单不动');
    // 导出新总体规划版本的确认单：冻结附件清单含这些附件（按冻结 sha256 展示）
    const h = await sheetOf(vNew.id);
    const frozenSec = secOf(h, 'sec-frozen');
    for (const f of frozenChange) assert.ok(frozenSec.includes(`data-attachment-id="${f.attachment_id}"`) && frozenSec.includes(f.sha256), `确认单冻结附件清单含附件 ${f.attachment_id}`);
    assert.ok(frozenSec.includes('f'.repeat(64)));
    // 第二条变更生效：第三版总体规划同样带自己那份冻结清单（不串第一份）
    const att2 = await stageAtt(s.pid, U.pm, 'e');
    const ch2 = await mkChange(s.pid, { attachment_ids: [att2], no_written_evidence: undefined, no_evidence_reason: undefined });
    const w2 = await draftOf(ch2.change.id);
    assert.strictEqual((await submitCh(U.pm, ch2.change.id)).status, 200);
    const frozen2 = await frozenOf('package_version', w2.id);
    assert.ok(frozen2.some((f) => f.attachment_id === att2) && !frozen2.some((f) => f.attachment_id === att), '第二条变更的冻结清单只有自己的证据');
    assert.strictEqual((await confirmAll(w2.id)).body.effective, true);
    const v3 = await effOverall(s.pid);
    assert.deepStrictEqual(await frozenOf('package_version', v3.id), frozen2, '第三版总体规划的冻结清单 = 第二条变更版本的');
    assert.deepStrictEqual(await frozenOf('package_version', vNew.id), frozenChange, '第二版（已被替代）的冻结清单保留');
  });

  test(`${T_W_PLANS}——M2：变更生效派生的新总体规划版本带节点计划快照：change_effective 事件 payload 写 node_plans（= 变更提交时记录的那份），submittedNodePlans 对没有提交事件的派生版本按该事件回退读取（按新版本编号精确匹配）；导出新总体版本的确认单，计划快照与变更提交记录全等；第二条变更生效后第二版仍是自己的那份`, async () => {
    const s = await mkScene();
    const ch1 = await mkChange(s.pid);
    const v1 = await draftOf(ch1.change.id);
    assert.strictEqual((await submitCh(U.pm, ch1.change.id)).status, 200);
    const changeSheet1 = await sheetOf(v1.id);
    const plans1 = secOf(changeSheet1, 'sec-plans');
    assert.ok(plans1.includes('立项与授权') && plans1.includes('2026-11-02'), '前置：变更版本的确认单有节点计划快照');
    const sub1 = (await payloads(s.pid, 'package_version_submitted')).filter((p) => p.change_id === ch1.change.id).pop();
    assert.strictEqual(sub1.node_plans.length, 6);
    assert.strictEqual((await confirmAll(v1.id)).body.effective, true);
    const vNew1 = await effOverall(s.pid);
    const ce1 = (await payloads(s.pid, 'change_effective')).filter((p) => p.change_id === ch1.change.id).pop();
    assert.deepStrictEqual(ce1.node_plans, sub1.node_plans, '生效事件的 node_plans = 提交时记录的那份');
    assert.strictEqual(ce1.new_overall_version_id, vNew1.id);
    // 导出新总体规划版本：计划快照与变更提交记录全等（没有它自己的提交事件，靠生效事件回退）
    const newSheet1 = await sheetOf(vNew1.id);
    assert.strictEqual(secOf(newSheet1, 'sec-plans'), plans1, '新总体版本的计划快照与变更提交记录全等');
    assert.ok(secOf(newSheet1, 'sec-plans').includes('立项与授权'));
    // 第二条变更：先改一个节点的计划（本条变更提交时记下新计划），生效后第二版 / 第三版各是自己的那份（回退按新版本编号精确匹配，不取「最近一条生效事件」）
    const dev = (await planOf(s.pid)).nodes.find((n) => n.template_key === 'b_dev');
    const rs = await post(U.pm, `/sysbuild/nodes/${dev.id}/schedule`, { kind: 'plan', planned_start: '2026-11-04', planned_end: '2026-11-27', reason: '顺延', no_written_evidence: true, no_evidence_reason: '口头电话确认了本次顺延安排' });
    assert.strictEqual(rs.status, 201, rs.text);
    const ch2 = await mkChange(s.pid);
    const w2 = await draftOf(ch2.change.id);
    assert.strictEqual((await submitCh(U.pm, ch2.change.id)).status, 200);
    const plans2 = secOf(await sheetOf(w2.id), 'sec-plans');
    assert.notStrictEqual(plans2, plans1, '前置：改期后第二条变更提交时记的计划与第一条不同');
    assert.strictEqual((await confirmAll(w2.id)).body.effective, true);
    const vNew2 = await effOverall(s.pid);
    assert.notStrictEqual(vNew2.id, vNew1.id);
    assert.strictEqual(secOf(await sheetOf(vNew2.id), 'sec-plans'), plans2, '第三版（第二条变更生效）：自己的计划快照');
    assert.strictEqual(secOf(await sheetOf(vNew1.id), 'sec-plans'), plans1, '第二版（已被替代）：仍是第一条变更提交时的计划快照');
    // 没有来源的总体规划版本（第一版，经 produceEffectiveOverall 生效，有提交事件）不受影响
    assert.ok(secOf(await sheetOf(s.eff.pv), 'sec-plans').includes('立项与授权'));
  });

  test(`${T_W_SUBMITTED}——L1：变更读接口 sheet_version_id 按「提交事件」判定曾提交：从未提交的草稿因继承来源过期被置为已被替代后不算（重建草稿后 sheet_version_id 仍为空）；提交后撤回的版本照常算（仍可导出确认单）；待确认的版本取最近一次提交的`, async () => {
    const s = await mkScene();
    const a = await mkChange(s.pid);
    const b = await mkChange(s.pid);
    // A 先生效 → B 的草稿（从未提交）过期
    const va = await draftOf(a.change.id);
    const itA = await mkItem(s.pid);
    assert.strictEqual((await addItemTo(va.id, itA.versions[0].id, s.batch1)).status, 201);
    assert.strictEqual((await submitCh(U.pm, a.change.id)).status, 200);
    assert.strictEqual((await confirmAll(va.id)).body.effective, true);
    assert.strictEqual((await chGet(U.pm, b.change.id)).sheet_version_id, null, '前置：从未提交的草稿，sheet_version_id 为空');
    const nv = await newVer(U.pm, b.change.id, '总体规划已变，重建草稿');
    assert.strictEqual(nv.status, 201, nv.text);
    const vers = await versOf(b.change.id);
    assert.deepStrictEqual(vers.map((v) => [v.version_no, v.status]), [[1, 'superseded'], [2, 'draft']], '前置：旧草稿已被替代（但从未提交过）');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_events WHERE object_type = 'package_version' AND object_id = ? AND event_type = 'package_version_submitted'", [vers[0].id]), 0, '前置：旧草稿没有提交事件');
    const gb = await chGet(U.pm, b.change.id);
    assert.strictEqual(gb.sheet_version_id, null, '过期未提交草稿不算曾提交：重建草稿后 sheet_version_id 仍为空');
    const lst = (await get(U.pm, `/sysbuild/projects/${s.pid}/changes`)).body.changes.find((x) => x.id === b.change.id);
    assert.strictEqual(lst.sheet_version_id, null, '列表同源');
    // 对照：提交后撤回的版本算曾提交
    const c = await mkChange(s.pid);
    const vc = (await draftOf(c.change.id)).id;
    assert.strictEqual((await submitCh(U.pm, c.change.id)).status, 200);
    assert.strictEqual((await chGet(U.pm, c.change.id)).sheet_version_id, vc, '待确认：取该提交版本');
    assert.strictEqual((await withdraw(U.pm, vc, '撤回')).status, 200);
    assert.strictEqual((await chGet(U.pm, c.change.id)).sheet_version_id, vc, '提交后撤回的版本照常算曾提交');
    assert.ok((await sheetOf(vc)).includes('范围变更包'), '仍可导出确认单');
    // 对照：B 的新草稿提交后算
    assert.strictEqual((await submitCh(U.pm, b.change.id)).status, 200);
    const pendingB = await pendingOf(b.change.id);
    assert.strictEqual((await chGet(U.pm, b.change.id)).sheet_version_id, pendingB.id, '重建的草稿提交后取它');
  });

  test(`${T_W_ADJ}——L6（P135）：裁定通过的「转正式变更」结论不随变更撤回失效：负责人裁定通过后（adjudicated）所挂变更再被撤回，状态仍是裁定通过、不落到转变更失效、不能再给结论；对照：同样挂在被撤回变更上的已确认结论照旧失效`, async () => {
    const s = await mkScene();
    const regE = async () => (await post(U.m1, `/sysbuild/projects/${s.pid}/entries`, { type: 'feedback', title: '要加导出', body: '希望能批量导出' })).body.entry;
    const act = (uid, eid, body) => post(uid, `/sysbuild/entries/${eid}/actions`, body);
    const stateOf = async (eid) => (await get(U.pm, `/sysbuild/entries/${eid}`)).body.entry.conclusion_state;
    const taskOf = (eid, type) => sqlGet('SELECT id FROM sysbuild_confirm_tasks WHERE object_type = ? AND object_id = ? ORDER BY id DESC', [type, eid]);
    const TC = (id) => ({ action: 'conclude', conclusion_kind: 'to_change', text: '转正式变更处理', change_id: id });
    const chg = await mkChange(s.pid);
    const e = await regE();
    assert.strictEqual((await act(U.pm, e.id, TC(chg.change.id))).status, 201);
    assert.strictEqual((await openAndDecide(U.del, (await taskOf(e.id, 'conclusion')).id, 'object', { reason: '不同意转变更' })).status, 200);
    assert.strictEqual((await act(U.pm, e.id, { action: 'escalate' })).status, 201);
    assert.strictEqual((await openAndDecide(U.own, (await taskOf(e.id, 'adjudication')).id, 'confirm')).status, 200);
    assert.strictEqual(await stateOf(e.id), 'adjudicated', '前置：裁定通过');
    // 对照：另一条登记的已确认「转变更」结论，同样挂这条变更
    const e2 = await regE();
    assert.strictEqual((await act(U.pm, e2.id, TC(chg.change.id))).status, 201);
    assert.strictEqual((await openAndDecide(U.del, (await taskOf(e2.id, 'conclusion')).id, 'confirm')).status, 200);
    assert.strictEqual(await stateOf(e2.id), 'confirmed');
    // 变更提交后撤回
    const vid = (await draftOf(chg.change.id)).id;
    assert.strictEqual((await submitCh(U.pm, chg.change.id)).status, 200);
    assert.strictEqual(await stateOf(e.id), 'adjudicated', '变更待确认期间不变');
    assert.strictEqual((await withdraw(U.pm, vid, '撤回变更')).status, 200);
    assert.strictEqual((await chRow(chg.change.id)).status, 'withdrawn');
    const d = (await get(U.pm, `/sysbuild/entries/${e.id}`)).body.entry;
    assert.strictEqual(d.conclusion_state, 'adjudicated', '裁定通过不可逆：变更撤回后仍是裁定通过');
    assert.deepStrictEqual([d.current_conclusion.kind, d.actions.conclude, d.actions.for_reference, d.actions.void], ['to_change', false, false, false], '仍不能再给结论 / 仅供参考 / 作废');
    expectErr(await act(U.pm, e.id, { action: 'conclude', conclusion_kind: 'handled', text: '换结论' }), 409, 'SYSBUILD_STATE', '裁定通过后再给结论');
    assert.strictEqual(await stateOf(e2.id), 'to_change_lapsed', '对照：已确认的转变更结论随变更撤回失效');
  });

  test(`${T_W_REOPEN}——L7：重开历史补录窗口的冲突检查对变更包取「自身 ∪ 总体规划包」：待确认的变更版本，总体规划包有历史记录（变更自身没有）→ 重开 409 并列出该变更版本；撤回后可重开；对照：总体规划包没有历史记录时不拦`, async () => {
    const s = await mkScene();
    const reopen = async (pid) => post(U.admin, `/sysbuild/projects/${pid}/history-window`, { action: 'reopen', reason: '补录遗漏的历史确认', attachment_ids: [await stageAtt(pid, U.admin, 'b')] });
    const winOf = async (pid) => (await sqlGet('SELECT history_window AS w FROM sysbuild_projects WHERE id = ?', [pid])).w;
    const ch = await mkChange(s.pid);
    assert.strictEqual((await submitCh(U.pm, ch.change.id)).status, 200);
    const vid = (await pendingOf(ch.change.id)).id;
    // 夹具：窗口已关闭 + 总体规划包有历史导入记录（变更包自身没有）
    await sqlRun("UPDATE sysbuild_projects SET history_window = 'closed' WHERE id = ?", [s.pid]);
    await sqlRun("INSERT INTO sysbuild_history_imports (project_id, object_type, object_id, fact_type, actual_confirmer, identity_basis, original_date, imported_by) VALUES (?, 'package_version', ?, 'package_effective', '甲部负责人', '会议纪要', '2026-10-01', ?)", [s.pid, s.eff.pv, U.pm]);
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_history_imports h JOIN sysbuild_package_versions v ON v.id = h.object_id JOIN sysbuild_changes c ON c.package_id = v.package_id WHERE c.id = ?", [ch.change.id]), 0, '前置：变更包自身没有历史导入记录');
    const r = await reopen(s.pid);
    expectErr(r, 409, 'SYSBUILD_STATE', '总体规划包有历史记录 + 待确认变更');
    assert.ok(r.body.message.includes(`内容包版本 #${vid}`), `应列出待确认的变更版本，实际 ${r.body.message}`);
    assert.strictEqual(await winOf(s.pid), 'closed', '被拒不改窗口');
    assert.strictEqual((await eventsOf(s.pid, 'history_window_reopened')).length, 0);
    // 变更撤回（窗口已关闭，互斥不拦）→ 不再有待确认版本 → 可重开
    assert.strictEqual((await withdraw(U.pm, vid, '撤回变更')).status, 200);
    const ok = await reopen(s.pid);
    assert.strictEqual(ok.status, 200, ok.text);
    assert.strictEqual(await winOf(s.pid), 'open');
    // 对照：同样有待确认变更，但总体规划包没有历史记录 → 不拦
    const s2 = await mkScene();
    const ch2 = await mkChange(s2.pid);
    assert.strictEqual((await submitCh(U.pm, ch2.change.id)).status, 200);
    await sqlRun("UPDATE sysbuild_projects SET history_window = 'closed' WHERE id = ?", [s2.pid]);
    const ok2 = await reopen(s2.pid);
    assert.strictEqual(ok2.status, 200, `对照：没有历史记录不拦重开 ${ok2.text}`);
    // 另一类历史记录：总体规划包的历史补录确认（method = history，不挂任务，走生产端点）同样拦
    const s3 = await mkScene();
    const ch3 = await mkChange(s3.pid);
    assert.strictEqual((await submitCh(U.pm, ch3.change.id)).status, 200);
    const vid3 = (await pendingOf(ch3.change.id)).id;
    await sqlRun("UPDATE sysbuild_projects SET history_window = 'open' WHERE id = ?", [s3.pid]);
    const hc = await post(U.pm, `/sysbuild/projects/${s3.pid}/history-confirmations`, { object_type: 'package_version', object_version_id: s3.eff.pv, decision: 'confirm', external_date: '2026-10-25', actual_confirmer: '甲部负责人', identity_basis: '电话确认记录', attachment_ids: [await stageAtt(s3.pid, U.pm, '7')] });
    assert.strictEqual(hc.status, 201, hc.text);
    await sqlRun("UPDATE sysbuild_projects SET history_window = 'closed' WHERE id = ?", [s3.pid]);
    const r3 = await reopen(s3.pid);
    expectErr(r3, 409, 'SYSBUILD_STATE', '总体规划包有历史补录确认 + 待确认变更');
    assert.ok(r3.body.message.includes(`内容包版本 #${vid3}`), `应列出待确认的变更版本，实际 ${r3.body.message}`);
    assert.strictEqual(await winOf(s3.pid), 'closed');
  });
}

// ── 变异 ───────────────────────────────────────────────────────────────────────────────────────
// 每条 { id, expect: [用例名前缀], edits: [{ file, from, to }] }；锚点必须在副本里恰好出现一次（LF 归一后）。
const cm = (id, expect, file, from, to) => ({ id: `${P}${id}`, expect, edits: [{ file, from, to }] });
const CHANGE_MUTATIONS = [
  // ── rules.js ──
  cm('建变更不要求总体规划已生效（标志与执行不同源）', [T_CREATE, T_RULES], 'rules.js', "return t.overallEffective === false ? '总体规划尚未生效，直接修改总体规划草稿' : CHANGE_FACT_UNKNOWN_MESSAGE;", 'return null;'),
  cm('建变更对非 PM 放行', [T_CREATE, T_RULES], 'rules.js', 'change_create: Object.freeze({\n    can: canActAsPm,', 'change_create: Object.freeze({\n    can: () => true,'),
  cm('出新版本：待确认且没有异议也放行', [T_OBJECT, T_RULES, T_FLAGS], 'rules.js', "return t.hasObjection === false ? '没有收到异议，请等待确认或撤回变更' : CHANGE_FACT_UNKNOWN_MESSAGE;", 'return null;'),
  cm('出新版本：草稿没过期也放行', [T_STALE, T_RULES, T_FLAGS], 'rules.js', "return t.staleDraft === false ? '草稿仍基于现行总体规划，请直接在草稿上修改' : CHANGE_FACT_UNKNOWN_MESSAGE;", 'return null;'),
  cm('出新版本：已撤回的变更也放行', [T_WITHDRAW, T_RULES], 'rules.js', "if (t.changeStatus === 'withdrawn') return '该变更已撤回，不能再出新版本，请新建变更';", ''),
  cm('出新版本：已生效的变更也放行', [T_EFFECT, T_RULES], 'rules.js', "if (t.changeStatus === 'effective') return '该变更已生效，不能再出新版本';", ''),
  cm('提交：继承来源已被替代也放行', [T_STALE, T_RULES], 'rules.js', 'if (t.parentSuperseded === true && !PARENT_REWRITTEN_AT_SUBMIT_TYPES.includes(t.packageType)) return PARENT_SUPERSEDED_MESSAGE;', ''),
  cm('提交：变更不是草稿也放行', [T_RULES], 'rules.js', "if (t.changeStatus !== 'draft') return '该变更已不是草稿状态，不能提交确认';", ''),
  cm('提交：另有待确认变更也放行', [T_SUBMIT, T_RULES], 'rules.js', "if (t.otherChangePending !== false) return t.otherChangePending === true ? '本项目已有待确认的变更，请等待其处理完成或撤回后再提交' : CHANGE_FACT_UNKNOWN_MESSAGE;", ''),
  cm('变更包不再开放提交', [T_SUBMIT, T_RULES], 'rules.js', "Object.freeze(['overall', 'initiation', 'change', 'batch_accept', 'closing'])", "Object.freeze(['overall', 'initiation', 'batch_accept', 'closing'])"),
  cm('通用建版本端点对变更包放行', [T_EDIT, T_RULES], 'rules.js', "if (t.packageType === 'change') return '变更包版本只经正式变更产生，不能在这里创建';", ''),
  cm('集合修订 add 不对变更包开放', [T_EDIT, T_RULES], 'rules.js', "if (t.packageType !== 'overall' && t.packageType !== 'change') return '只有总体规划包和变更包的版本可以修订条目集合';\n      if (t.inSet === true)", "if (t.packageType !== 'overall') return '只有总体规划包和变更包的版本可以修订条目集合';\n      if (t.inSet === true)"),
  cm('集合修订 remove 不对变更包开放', [T_EDIT, T_EFFECT, T_RULES], 'rules.js', "if (t.packageType !== 'overall' && t.packageType !== 'change') return '只有总体规划包和变更包的版本可以修订条目集合';\n      return t.inSet === false", "if (t.packageType !== 'overall') return '只有总体规划包和变更包的版本可以修订条目集合';\n      return t.inSet === false"),
  cm('集合修订对任何类型放行', [T_RULES], 'rules.js', "if (t.packageType !== 'overall' && t.packageType !== 'change') return '只有总体规划包和变更包的版本可以修订条目集合';\n      if (t.inSet === true)", ''),
  cm('挂靠变更不要求已有结论', [T_ENTRY], 'rules.js', 'if (t.hasConclusion === true) return null;', 'return null;'),
  // ── packages.js ──
  cm('继承来源被替代的事实恒为假', [T_STALE], 'packages.js', "facts.parentSuperseded = !!p && p.status === 'superseded';", 'facts.parentSuperseded = false;'),
  cm('另有待确认变更的事实恒为假', [T_SUBMIT], 'packages.js', 'facts.otherChangePending = !!other;', 'facts.otherChangePending = false;'),
  cm('变更草稿继承上一版变更草稿而不是现行总体规划', [T_OBJECT, T_STALE], 'packages.js', 'for (const it of setList(await loadFoldedSet(q, parent))) {', "for (const it of setList(await loadFoldedSet(q, ((await q.get('SELECT id FROM sysbuild_package_versions WHERE package_id = ? AND id <> ? ORDER BY id DESC LIMIT 1', [pkg.id, ins.lastID])) || { id: parent }).id))) {"),
  cm('变更草稿不继承 snapshot', [T_CREATE], 'packages.js', '[pkg.id, versionNo, parent, form, base.snapshot_json, Number(user.id)]', "[pkg.id, versionNo, parent, form, '{}', Number(user.id)]"),
  cm('变更包的继承来源不取现行总体规划', [T_STALE, T_OBJECT], 'packages.js', 'return { form: eff ? eff.form : null, parent: eff ? eff.id : null };', 'return { form: eff ? eff.form : null, parent: null };'),
  // ── confirm-core.js ──
  cm('变更包的确认人不含代表人', [T_SUBMIT], 'confirm-core.js', 'if (DELEGATE_CONFIRM_PACKAGE_TYPES.includes(packageType)) {', "if (packageType === 'overall') {"),
  cm('生效时新总体规划版本不带 snapshot', [T_EFFECT], 'confirm-core.js', '[overallPkg.id, maxNo.n + 1, oldEff.form, verRow.effective_at, verRow.snapshot_json, Number(user.id)]', "[overallPkg.id, maxNo.n + 1, oldEff.form, verRow.effective_at, '{}', Number(user.id)]"),
  cm('生效时新总体规划版本不带条目集合', [T_EFFECT, T_STALE], 'confirm-core.js', 'for (const it of set) {\n    await q.run(\n      "INSERT INTO sysbuild_package_item_revisions', 'for (const it of []) {\n    await q.run(\n      "INSERT INTO sysbuild_package_item_revisions'),
  cm('生效时 form 不照前一版', [T_EFFECT], 'confirm-core.js', '[overallPkg.id, maxNo.n + 1, oldEff.form, verRow.effective_at,', "[overallPkg.id, maxNo.n + 1, 'overall', verRow.effective_at,"),
  cm('生效时不核继承来源', [T_EFFECT], 'confirm-core.js', 'if (ver.parent_overall_version_id !== oldEff.id) throw stateError(', 'if (false) throw stateError('),
  cm('生效后变更状态不写 effective', [T_EFFECT], 'confirm-core.js', "UPDATE sysbuild_changes SET status = 'effective', updated_at = datetime('now','localtime') WHERE id = ? AND status = 'pending'", "UPDATE sysbuild_changes SET status = 'pending', updated_at = datetime('now','localtime') WHERE id = ? AND status = 'pending'"),
  cm('基线引用变更包版本而不是新总体规划版本', [T_BASELINE], 'confirm-core.js', 'const baselineNodes = await formBaselines(q, user, projectId, newId, await submittedNodePlans(q, ver.id));', 'const baselineNodes = await formBaselines(q, user, projectId, ver.id, await submittedNodePlans(q, ver.id));'),
  cm('生效不形成基线', [T_BASELINE], 'confirm-core.js', 'const baselineNodes = await formBaselines(q, user, projectId, newId, await submittedNodePlans(q, ver.id));', 'const baselineNodes = [];'),
  cm('窗口互斥对象不取总体规划包', [T_HISTORY], 'confirm-core.js', "if (pkg.type !== 'change') return [pkg.id];", 'return [pkg.id];'),
  cm('窗口互斥对象只取总体规划包不取变更包自身', [T_Y_WINDOW], 'confirm-core.js', 'return o ? [pkg.id, o.id] : [pkg.id];', 'return o ? [o.id] : [pkg.id];'),
  // ── confirm.js ──
  cm('提交不冻结变更证据', [T_SUBMIT], 'confirm.js', "await attachmentHelpers.freezeAttachmentSet(q, { objectType: 'package_version', objectVersionId: vid, ownerType: 'change', ownerId: changeRow.id, operatorId: opId, operatorName: opName, projectId: pid });", ''),
  cm('提交不回写变更状态', [T_SUBMIT, T_WITHDRAW], 'confirm.js', "UPDATE sysbuild_changes SET status = 'pending', package_version_id = ?, updated_at = datetime('now','localtime') WHERE id = ? AND status = 'draft'", "UPDATE sysbuild_changes SET status = 'draft', package_version_id = ?, updated_at = datetime('now','localtime') WHERE id = ? AND status = 'draft'"),
  cm('撤回不回写变更状态', [T_WITHDRAW], 'confirm.js', "UPDATE sysbuild_changes SET status = 'withdrawn', updated_at = datetime('now','localtime') WHERE id = ? AND status = 'pending'", "UPDATE sysbuild_changes SET status = 'pending', updated_at = datetime('now','localtime') WHERE id = ? AND status = 'pending'"),
  cm('变更提交不记节点计划', [T_SUBMIT, T_BASELINE], 'confirm.js', "pkg.type === 'overall' || pkg.type === 'change' ? { node_plans: await core.currentNodePlans(q, pid) } : {}", "pkg.type === 'overall' ? { node_plans: await core.currentNodePlans(q, pid) } : {}"),
  cm('变更提交不重核条目集合', [T_SUBMIT], 'confirm.js', "const set = pkg.type === 'overall' || pkg.type === 'change' ? await recheckOverallSet(q, pkg, ver) : [];", "const set = pkg.type === 'overall' ? await recheckOverallSet(q, pkg, ver) : [];"),
  cm('承诺批次不是默认批次不拦', [T_SUBMIT], 'confirm.js', "else if (pkg.type === 'change' && (!defaultBatch || batch.id !== defaultBatch.id)) bad.structure.push(label);", ''),
  cm('代录 / 改发的窗口互斥对象不取总体规划包', [T_HISTORY], 'confirm.js', 'await core.historyPackageIdsOf(q, c.obj.pkg)', '[c.obj.pkg.id]'),
  cm('确认页不带变更内容', [T_SUBMIT], 'confirm.js', "if (pkg.type === 'change') {\n        const ch = await q.get('SELECT id, title, body, affects_json, no_written_evidence, no_evidence_reason FROM sysbuild_changes WHERE package_id = ?', [pkg.id]);", "if (false) {\n        const ch = await q.get('SELECT id, title, body, affects_json, no_written_evidence, no_evidence_reason FROM sysbuild_changes WHERE package_id = ?', [pkg.id]);"),
  // ── plan.js ──
  cm('变更待确认期间排期不冻结', [T_FREEZE], 'golive-core.js', "p.type IN ('overall', 'change') AND v.status = 'pending' LIMIT 1", "p.type IN ('overall') AND v.status = 'pending' LIMIT 1"),
  // ── changes.js ──
  cm('建变更不校验方向类证据', [T_CREATE], 'changes.js', "assertEvidence(attachmentIds.length, ev, 'direction');", ''),
  cm('引用登记不限办理类', [T_CREATE], 'changes.js', 'if (!e || !rules.ENTRY_HANDLED_TYPES.includes(e.type)) throw invalid(', 'if (!e) throw invalid('),
  cm('出新版本不让待确认修订失效', [T_OBJECT], 'changes.js', "for (const r of revs) await core.closePendingRevision(q, r.id, 'invalid', reason);", ''),
  cm('出新版本后变更状态不回 draft', [T_OBJECT, T_FLAGS], 'changes.js', "SET status = 'draft', package_version_id = NULL", "SET status = 'pending', package_version_id = NULL"),
  cm('读接口出新版本标志不看事实', [T_FLAGS, T_OBJECT], 'changes.js', "rules.opAllowed('change_new_version', access, access.project, await newVersionFacts(q, change, pkg, versions))", "rules.opAllowed('change_new_version', access, access.project, { changeStatus: change.status, hasObjection: true, staleDraft: true })"),
  cm('列表建变更标志恒真', [T_CREATE], 'changes.js', "create_change: rules.opAllowed('change_create', access, access.project, { overallEffective: (await packages.effectiveOverallVersionId(q, pid)) !== null }) },", 'create_change: true },'),
  cm('变更详情不带证据附件', [T_CREATE], 'changes.js', 'attachments: await attachmentsOfChange(q, change.id),', 'attachments: [],'),
  // ── entries.js：转变更 / 挂靠 ──
  cm('变更归属不校验', [T_ENTRY], 'entries.js', "if (!ch || ch.project_id !== entry.project_id) throw stateError('该变更不属于本项目');", ''),
  cm('已撤回的变更可转入 / 挂靠', [T_ENTRY], 'entries.js', "if (ch.status === 'withdrawn') throw stateError('该变更已撤回，不能转入或挂靠');", ''),
  cm('重复挂靠不拦', [T_ENTRY], 'entries.js', "if (input.action === 'link_change' && (await q.get(", "if (false && (await q.get("),
  cm('转变更结论不写 link_change 记录', [T_ENTRY], 'entries.js', "if (input.action === 'conclude' && input.kind === 'to_change') {\n        const lr", "if (false) {\n        const lr"),
  cm('非转变更类别带 change_id 不拒', [T_ENTRY], 'entries.js', "else if (body.change_id !== undefined && body.change_id !== null) throw invalid('变更编号只用于「转正式变更」', 'change_id');", ''),
  cm('读接口漏掉 link_change 标志', [T_ENTRY], 'entries.js', "'link_sys_issue', 'link_change', 'object']);", "'link_sys_issue', 'object']);"),
  cm('办理记录不存变更号', [T_ENTRY], 'entries.js', '[eid, input.action, input.kind, input.text, input.sysIssueNo, input.assigneeText, input.changeId, input.basisEntryId === null ? null : \'dev_note_version\', input.basisEntryId, uid]', '[eid, input.action, input.kind, input.text, input.sysIssueNo, input.assigneeText, null, input.basisEntryId === null ? null : \'dev_note_version\', input.basisEntryId, uid]'),
  // ── confirmation-sheet.js ──
  cm('确认单不带变更页头', [T_SHEET], 'confirmation-sheet.js', "${m.change === null ? '' : renderChangeRows(m.change)}", ''),
  cm('确认单变更包没有节点计划快照节', [T_SHEET], 'confirmation-sheet.js', "${m.pkg.type === 'overall' || m.pkg.type === 'change' ? section('sec-plans'", "${m.pkg.type === 'overall' ? section('sec-plans'"),
  cm('确认单变更包不取提交记录的节点计划', [T_SHEET], 'confirmation-sheet.js', "m.plans = pkg.type === 'overall' || pkg.type === 'change' ? await core.submittedNodePlans(q, vid) : null;", "m.plans = pkg.type === 'overall' ? await core.submittedNodePlans(q, vid) : null;"),
  // ── events.js ──
  cm('变更事件类型未登记', [T_CREATE], 'events.js', "'change_created', 'change_submitted', 'change_withdrawn', 'change_new_version', 'change_effective',", "'change_submitted', 'change_withdrawn', 'change_new_version', 'change_effective',"),
  // ── 预筛修订批（M2 / M3 / M6 / Q4）──
  cm('提交不重核变更的方向类证据', [T_Y_EVID, T_RULES], 'rules.js', "if (t.changeEvidenceOk !== true) return t.changeEvidenceOk === false ? '该变更的方向类证据已不齐（附件被删除或未声明无书面证据），请补充后再提交' : CHANGE_FACT_UNKNOWN_MESSAGE;", ''),
  cm('变更证据事实恒为齐全', [T_Y_EVID], 'packages.js', 'facts.changeEvidenceOk = n.n > 0 || reasonOk;', 'facts.changeEvidenceOk = true;'),
  cm('变更证据计数不排除软删除附件', [T_Y_EVID], 'packages.js', "WHERE a.deleted_at IS NULL\n            AND a.id IN (SELECT attachment_id FROM sysbuild_attachment_bindings WHERE owner_type = 'change'", "WHERE 1 = 1\n            AND a.id IN (SELECT attachment_id FROM sysbuild_attachment_bindings WHERE owner_type = 'change'"),
  cm('变更证据不认无书面证据声明', [T_Y_EVID], 'packages.js', 'facts.changeEvidenceOk = n.n > 0 || reasonOk;', 'facts.changeEvidenceOk = n.n > 0;'),
  cm('窗口互斥只取变更包自身的第一个对象', [T_HISTORY], 'confirm-core.js', 'const ids = Array.isArray(packageIds) ? packageIds : [packageIds];', 'const ids = Array.isArray(packageIds) ? [packageIds[0]] : [packageIds];'),
  cm('已上线条目移出规划不拦', [T_Y_LIVE], 'confirm.js', "if (liveRemoved.length > 0 && bad.project.length === 0 && bad.noBatch.length === 0 && bad.batchGone.length === 0 && bad.structure.length === 0 && bad.liveMove.length === 0) throw stateError(`已上线条目不能移出规划，后续增强请建新条目：${list(liveRemoved)}`);", ''),
  // C6a 修订批 2：冻结判定（含移出）抽到 entries-core.liveFreezeBreaches / isFrozenLiveBatch，两条锚点随之迁移
  cm('已上线判据不看批次状态', [T_Y_LIVE], 'entries-core.js', 'return (await batchLiveState(q, batchId)).live;', 'return false;'),
  cm('已上线条目移出规划只对总体规划包的集合判（变更包不判）', [T_Y_LIVE], 'confirm.js', "if (pkg.type === 'change') for (const id of breaches.removed) liveRemoved.push(await codeOfItem(id));", ''),
  cm('转变更结论的失效只认已确认', [T_Y_LAPSE], 'entries-core.js', "if ((state === 'settled_no_confirm' || state === 'confirmed') && current !== null", "if ((state === 'confirmed') && current !== null"),
  cm('转变更结论的失效只认已确定', [T_Y_LAPSE], 'entries-core.js', "if ((state === 'settled_no_confirm' || state === 'confirmed') && current !== null", "if ((state === 'settled_no_confirm') && current !== null"),
  cm('变更未撤回也让结论失效', [T_Y_LAPSE], 'entries-core.js', "changeStatusOf[current.change_id] === 'withdrawn') {", "changeStatusOf[current.change_id] !== 'effective') {"),
  cm('登记事实不取所挂变更的状态', [T_Y_LAPSE], 'entries-core.js', 'proj.status, changeStatusOf);', 'proj.status);'),
  cm('可再给结论的状态漏掉转变更失效', [T_Y_LAPSE], 'rules.js', "'terminated_conclusion_lapsed', 'to_change_lapsed']);\nconst FOR_REFERENCE_FROM_STATES", "'terminated_conclusion_lapsed']);\nconst FOR_REFERENCE_FROM_STATES"),
  cm('link_change 对作废登记放行', [T_Y_LINK], 'rules.js', "const v = entryNotVoided(t) || entryStateKnown(t);\n      if (v) return v;\n      if (!ENTRY_HANDLED_TYPES.includes(t.type)) return '只有意见与反馈、问题与处理可以挂靠变更';", "const v = entryStateKnown(t);\n      if (v) return v;\n      if (!ENTRY_HANDLED_TYPES.includes(t.type)) return '只有意见与反馈、问题与处理可以挂靠变更';"),
  cm('link_change 对没有结论的登记放行', [T_Y_LINK, T_ENTRY], 'rules.js', "if (t.hasConclusion === true) return null;\n      return t.hasConclusion === false ? '该登记还没有结论", "if (t.hasConclusion !== undefined) return null;\n      return t.hasConclusion === false ? '该登记还没有结论"),
  cm('link_change 对非 PM 放行', [T_Y_LINK, T_ENTRY], 'rules.js', "entry_link_change: Object.freeze({\n    can: (identity) => canActAsPm(identity),", "entry_link_change: Object.freeze({\n    can: () => true,"),
  // ── 修订批 3（codex 26 M1 / M2 / L1、预筛快看 L6 / L7）──
  cm('生效不复制冻结清单到新总体版本', [T_W_FREEZE], 'confirm-core.js', 'for (const f of frozenRows) {', 'for (const f of []) {'),
  cm('复制冻结清单时 sha256 不照抄冻结值', [T_W_FREEZE], 'confirm-core.js', "['package_version', newId, f.attachment_id, f.sha256]", "['package_version', newId, f.attachment_id, '0'.repeat(64)]"),
  cm('冻结清单取总体规划旧版本而不是变更版本', [T_W_FREEZE], 'confirm-core.js', "ORDER BY attachment_id', ['package_version', ver.id]);\n  for (const f of frozenRows)", "ORDER BY attachment_id', ['package_version', oldEff.id]);\n  for (const f of frozenRows)"),
  cm('冻结清单复制回变更版本自己', [T_W_FREEZE], 'confirm-core.js', "['package_version', newId, f.attachment_id, f.sha256]", "['package_version', ver.id, f.attachment_id, f.sha256]"),
  cm('生效事件不带节点计划', [T_EFFECT, T_W_PLANS], 'confirm-core.js', '}, submittedPlans === null ? {} : { node_plans: submittedPlans }));', '}, {}));'),
  cm('节点计划回退不读生效事件', [T_W_PLANS], 'confirm-core.js', 'if (p && p.new_overall_version_id === versionId) { ev = e; break; }', 'if (false) { ev = e; break; }'),
  cm('节点计划回退取最近一条生效事件而不按新版本编号匹配', [T_W_PLANS], 'confirm-core.js', 'if (p && p.new_overall_version_id === versionId) { ev = e; break; }', 'if (p) { ev = e; break; }'),
  cm('曾提交按版本状态判定（过期草稿被替代也算）', [T_W_SUBMITTED], 'changes.js', 'const submitted = [...versions].reverse().find((v) => submittedIds.has(v.id)) || null;', "const submitted = [...versions].reverse().find((v) => v.status !== 'draft') || null;"),
  cm('曾提交的提交事件判定恒无', [T_W_SUBMITTED], 'changes.js', 'submittedIds.add(v.id);', 'void 0;'),
  cm('转变更结论的失效含裁定通过', [T_W_ADJ], 'entries-core.js', "if ((state === 'settled_no_confirm' || state === 'confirmed') && current !== null", "if ((state === 'settled_no_confirm' || state === 'confirmed' || state === 'adjudicated') && current !== null"),
  cm('重开冲突对变更包只看自身', [T_W_REOPEN], 'history.js', "const ids = await core.historyPackageIdsOf(q, { id: r.package_id, type: 'change', project_id: pid });", 'const ids = [r.package_id];'),
  cm('重开冲突不单独查待确认的变更版本', [T_W_REOPEN], 'history.js', 'for (const r of chg) {\n      if (listedPk.has(r.id)) continue;', 'for (const r of []) {\n      if (listedPk.has(r.id)) continue;'),
  cm('重开冲突对变更包漏掉历史补录确认', [T_W_REOPEN], 'history.js', "|| (await q.get(`SELECT c.id AS id FROM sysbuild_confirmations c JOIN sysbuild_package_versions cfv ON cfv.id = c.object_version_id WHERE c.method = 'history' AND c.object_type = 'package_version' AND cfv.package_id IN (${marks}) LIMIT 1`, ids));", ';'),
  cm('重开冲突对变更包漏掉历史导入记录', [T_W_REOPEN], 'history.js', "const hist = (await q.get(`SELECT h.id AS id FROM sysbuild_history_imports h JOIN sysbuild_package_versions hv ON hv.id = h.object_id WHERE h.object_type = 'package_version' AND hv.package_id IN (${marks}) LIMIT 1`, ids))\n        ||", 'const hist = null\n        ||'),
];

module.exports = { defineChangeCases, CHANGE_MUTATIONS };
