// #213 L1：结构化登记、开发评估门、送审范围、草稿放弃；与真实实例及进程内变异共用。
// 期望值手写。直接 SQL 只用于身份/附件夹具与历史异常载荷，业务动作均走 HTTP。
'use strict';
const assert = require('assert');
const path = require('path');
const P = 'L1 留痕：';
// C5 起：需求变更申请与开发评估两张表单、开发评估门、放弃变更草稿随 #212 第一步 C5 删除；本文件只保留换载体后的保留行为：
//   N-FORM（表单字段 / 互斥 / 勘误 / 不可读登记，载体 = 三张保留表单与普通登记）、N-SPLIT（带表单信封的登记不可拆分，夹具写信封）、
//   N-SCOPE（送审范围摘要与材料遮蔽，载体 = 总体规划包 / 立项包草稿）、N-DEVKEY（不可读开发方说明不能作办理依据）、撤回条件更新探针。
const reportRequest = (extra) => ({ kind: 'report_request', due_on: '2099-01-01', reason: '请开发方补充本周接口联调进展说明', ...(extra || {}) });
const reportCycle = () => ({ kind: 'report_cycle', cycle: 'weekly', first_due_on: '2099-01-01', note: '每周例行汇报' });
const progress = () => ({ kind: 'progress_report', due_on: null, done: '已完成接口联调的第一阶段工作', next: '继续推进第二阶段联调工作', risks: null, milestone_impact: false });

function defineTraceL1Cases(T) {
  const { test, U, api, sqlRun, sqlGet, sqlAll, expectErr, addMember, addParty, addAppointment, addDelegation, confirm: H } = T;
  const post = (uid, url, body) => api(uid, 'POST', url, body || {});
  const get = (uid, url) => api(uid, 'GET', url);
  const patch = (url, body) => api(U.pm, 'PATCH', url, body);
  const reg = (uid, pid, form, extra) => post(uid, `/sysbuild/projects/${pid}/entries`, Object.assign({ form }, extra || {}));
  const plain = (uid, pid, extra) => post(uid, `/sysbuild/projects/${pid}/entries`, Object.assign({ type: 'feedback', title: '普通意见登记', body: '一条没有表单的普通登记' }, extra || {}));
  const act = (eid, action, extra) => post(U.pm, `/sysbuild/entries/${eid}/actions`, Object.assign({ action, [action === 'void' || action.startsWith('mark_') || action.startsWith('unmark_') ? 'reason' : 'text']: '核查后按登记原意进行勘误说明' }, extra || {}));
  const detail = async (eid) => { const r = await get(U.pm, `/sysbuild/entries/${eid}`); assert.strictEqual(r.status, 200, r.text); return r.body.entry; };
  async function scene(withDev = true) {
    const pid = await H.newProject();
    const eff = await H.produceEffectiveOverall(pid);
    await addMember(pid, U.m1, { party: eff.party });
    const s = { pid, eff, batch: await H.defaultBatchId(pid) };
    if (withDev) {
      s.dev = await addParty(pid, '研发方', 'dev');
      s.owner = await addMember(pid, U.x1, { party: s.dev });
      s.apt = await addAppointment(s.dev, s.owner, 'active');
      s.delegate = await addMember(pid, U.x2, { party: s.dev });
      await addDelegation(s.dev, s.delegate, s.apt, 'active');
      await addMember(pid, U.x3, { party: s.dev });
    }
    return s;
  }
  const scopeMod = () => require(path.join(T.getModuleDir(), 'submission-scope.js'));
  // 夹具（C5）：总体规划已有生效版本时不能经正式入口建草稿，直接写库造一个草稿版本；返回 { vid, pkid }。
  async function overallDraft(s) {
    const eff = await sqlGet('SELECT package_id AS pk, form FROM sysbuild_package_versions WHERE id = ?', [s.eff.pv]);
    const max = await sqlGet('SELECT MAX(version_no) AS n FROM sysbuild_package_versions WHERE package_id = ?', [eff.pk]);
    const vid = (await sqlRun("INSERT INTO sysbuild_package_versions (package_id, version_no, form, status, snapshot_json, created_by) VALUES (?, ?, ?, 'draft', '{}', ?)", [eff.pk, max.n + 1, eff.form, U.pm])).lastID;
    return { vid, pkid: eff.pk };
  }
  async function scope(c, all = sqlAll) {
    const ver = await sqlGet('SELECT * FROM sysbuild_package_versions WHERE id = ?', [c.vid]);
    const pkg = await sqlGet('SELECT * FROM sysbuild_packages WHERE id = ?', [ver.package_id]);
    return scopeMod().readSubmissionScope({ get: sqlGet, all }, pkg, ver);
  }
  const rawForm = (eid, value) => sqlRun('UPDATE sysbuild_entries SET routing_json = ? WHERE id = ?', [JSON.stringify(value), eid]);
  const FORM_KINDS = ['progress_report', 'report_cycle', 'report_request'];

  // ── N-FORM：三张保留表单的字段 / 互斥 / 勘误 / 不可读 ─────────────────────────────────────────────
  test(`${P}表单字段反例——三种保留表单的缺失类型长度范围取值、多余及派生键（逐条核 field，字段校验被放宽时落到后续节点校验会判红）`, async () => {
    const s = await scene();
    const bases = { request: reportRequest(), cycle: reportCycle(), progress: progress() };
    const cases = [];
    for (const f of [null, [], 'form']) cases.push([f, 'form']);
    for (const f of [{ ...reportRequest(), kind: 'other' }, { kind: 'change_request' }, { kind: 'dev_assessment' }]) cases.push([f, 'form.kind']);
    const required = { request: ['due_on', 'reason'], cycle: ['cycle', 'first_due_on'], progress: ['done'] };
    for (const [name, base] of Object.entries(bases)) {
      for (const key of ['extra', 'scope_digest', 'package_version_id']) cases.push([{ ...base, [key]: 1 }, `form.${key}`]);
      for (const key of required[name]) { const f = { ...base }; delete f[key]; cases.push([f, `form.${key}`]); }
    }
    cases.push([{ ...bases.request, reason: '短' }, 'form.reason'], [{ ...bases.request, reason: 'x'.repeat(501) }, 'form.reason'], [{ ...bases.progress, done: '短' }, 'form.done'], [{ ...bases.progress, milestone_impact: 'yes' }, 'form.milestone_impact'], [{ ...bases.cycle, cycle: 'daily' }, 'form.cycle']);
    cases.push([{ ...bases.progress, next: 1 }, 'form.next'], [{ ...bases.progress, next: '字'.repeat(2001) }, 'form.next']);
    const before = (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE project_id = ?', [s.pid])).n;
    for (const [f, field] of cases) {
      const r = await reg(U.pm, s.pid, f, { source_party_id: s.dev });
      expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', JSON.stringify(f).slice(0, 130));
      assert.strictEqual(r.body.field, field, `${JSON.stringify(f).slice(0, 100)} 的 field`);
    }
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_entries WHERE project_id = ?', [s.pid])).n, before, '反例整笔不落登记');
  });

  test(`${P}互斥与类型用途——请求键存在即拒绝，退出键（objects_entry_id / revision_of_entry_id / commitment_flag）出现即拒，类型用途与表单定义一致（逐条核 field）`, async () => {
    const s = await scene();
    for (const f of [reportRequest(), reportCycle(), progress()]) {
      for (const key of ['title', 'body', 'objects_entry_id', 'revision_of_entry_id']) for (const val of [null, '', 1]) {
        const r = await reg(U.pm, s.pid, f, { source_party_id: s.dev, [key]: val });
        expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', key); assert.strictEqual(r.body.field, key, `${key} 的 field`);
      }
      for (const [extra, field] of [[{ type: 'issue' }, 'type'], [{ purpose: 'deliverable' }, 'purpose'], [{ commitment_flag: 1 }, 'commitment_flag'], [{ commitment_flag: true }, 'commitment_flag']]) {
        const r = await reg(U.pm, s.pid, f, { source_party_id: s.dev, ...extra });
        expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', JSON.stringify(extra)); assert.strictEqual(r.body.field, field, `${JSON.stringify(extra)} 的 field`);
      }
    }
  });

  test(`${P}勘误只追加——字段和存储不变，列表详情带勘误（载体：临时汇报要求登记）`, async () => {
    const s = await scene();
    const node = await sqlGet("SELECT id FROM sysbuild_nodes WHERE project_id = ? AND template_key = 'b_dev'", [s.pid]);
    // 夹具：开发节点进行中且有计划，临时汇报要求才可登记；这里直接用普通登记写入保留表单信封（与 N-SPLIT 同一载体写法）
    const r = await plain(U.pm, s.pid, { node_id: node.id });
    assert.strictEqual(r.status, 201, r.text);
    const eid = r.body.entry.id;
    const form = reportRequest({ due_on: '2099-01-01' });
    await rawForm(eid, { v: 1, form });
    const before = await sqlGet('SELECT routing_json FROM sysbuild_entries WHERE id = ?', [eid]);
    const c = await act(eid, 'correct', { text: '汇报事由笔误，更正为接口联调进展' });
    assert.strictEqual(c.status, 201, c.text);
    const d = await detail(eid);
    assert.deepStrictEqual(d.form, form); assert.strictEqual(d.has_correction, true); assert.strictEqual(d.corrections[0].text, '汇报事由笔误，更正为接口联调进展');
    assert.deepStrictEqual(await sqlGet('SELECT routing_json FROM sysbuild_entries WHERE id = ?', [eid]), before, '勘误不改表单存储');
    const list = await get(U.pm, `/sysbuild/projects/${s.pid}/entries`);
    assert.strictEqual(list.status, 200, list.text);
    const item = list.body.entries.find((v) => v.id === eid);
    assert.strictEqual(item.has_correction, true); assert.deepStrictEqual(item.form, form);
  });

  test(`${P}不可读登记——读取容错，除作废外所有动作拒绝，安全作废保留事件原因`, async () => {
    const s = await scene(false);
    // 回填 3：routing_json 有 json_valid 约束，不可读载荷只能写合法 JSON（未知信封版本 / 未知表单种类 / 已删表单种类）
    for (const payload of [[], 1, { v: 9 }, { v: 2, form: reportRequest() }, { v: 1, form: { kind: 'other' } }, { v: 1, form: { kind: 'report_request' } }, { v: 1, form: { kind: 'change_request' } }, { v: 1, form: { kind: 'dev_assessment' } }]) {
      const r = await plain(U.m1, s.pid); assert.strictEqual(r.status, 201, r.text); const eid = r.body.entry.id;
      await rawForm(eid, payload);
      const d = await detail(eid); assert.strictEqual(d.form_unreadable, true); assert.strictEqual(d.form, null);
      assert.strictEqual(d.title, '普通意见登记', '标题断言核该 feedback 登记自己的标题（不是表单生成的标题）');
      // C6：actions 只剩 correct / void 两个键。遍历只对返回的键逐个核假，服务端漏发 correct 时遍历不判红，所以先手写全等（不可读登记 PM 视角：correct 假、void 真）
      assert.deepStrictEqual(d.actions, { correct: false, void: true }, '不可读登记 PM 视角的 actions 全等');
      for (const [name, allowed] of Object.entries(d.actions)) if (name !== 'void') assert.strictEqual(allowed, false, `不可读 ${name}`);
      for (const name of ['correct']) expectErr(await act(eid, name), 409, 'SYSBUILD_STATE', `不可读 ${name}`);
      assert.strictEqual(d.actions.void, true);
      const v = await act(eid, 'void'); assert.strictEqual(v.status, 201, v.text);
      assert.ok(await sqlGet('SELECT id FROM sysbuild_entries WHERE id = ?', [eid]), '不可读登记作废后原行仍在（接替随删的 trace-l1:143 同类断言）');
      const ev = await sqlGet("SELECT payload_json FROM sysbuild_events WHERE object_type = 'entry' AND object_id = ? AND event_type = 'entry_action_recorded' ORDER BY id DESC LIMIT 1", [eid]);
      assert.ok(ev.payload_json.includes('表单不可读') || JSON.parse(ev.payload_json).form_unreadable === true, '作废事件标明表单不可读');
    }
  });

  // ── N-SCOPE：送审范围（总体规划包 / 立项包草稿）──────────────────────────────────────────────────
  test(`${P}scope只读——读取不写事件 / 任务 / 冻结行、不改版本行；返回快照对象、形态父版本、全部节点计划与附件来源，没有送审摘要（#212 C7：digestInput / scope_digest 随条目集合重核删除）（载体：总体规划包草稿）`, async () => {
    const s = await scene(false); const c = await overallDraft(s);
    const before = await sqlGet('SELECT (SELECT COUNT(*) FROM sysbuild_events) AS events, (SELECT COUNT(*) FROM sysbuild_confirm_tasks) AS tasks, (SELECT COUNT(*) FROM sysbuild_frozen_attachments) AS frozen');
    const verBefore = await sqlGet('SELECT * FROM sysbuild_package_versions WHERE id = ?', [c.vid]);
    const x = await scope(c);
    assert.deepStrictEqual(Object.keys(x).sort(), ['attachmentSources', 'materials', 'snapshot'], '送审只读材料与冻结来源，职责快照及形态事实由各自的共同入口取得');
    assert.deepStrictEqual(await sqlGet('SELECT * FROM sysbuild_package_versions WHERE id = ?', [c.vid]), verBefore);
    assert.deepStrictEqual(await sqlGet('SELECT (SELECT COUNT(*) FROM sysbuild_events) AS events, (SELECT COUNT(*) FROM sysbuild_confirm_tasks) AS tasks, (SELECT COUNT(*) FROM sysbuild_frozen_attachments) AS frozen'), before);
    // 手写固定结构（不从服务端取值）：快照对象、形态与父版本、全部节点计划（planAllNodes 统一写入的固定日期）、附件来源只有包版本自己（没有附件）
    assert.deepStrictEqual(x.snapshot, {});
    assert.deepStrictEqual(x.attachmentSources.map((a) => [a.ownerType, a.ownerId, a.rows.length]), [['package_version', c.vid, 0]]);
    assert.deepStrictEqual(x.materials, []);
    // 非空父版本（F1 = A：父版本过期判定整组保留到 C9）：总体规划包的父版本恒为空，所以另用挂批次的验收包草稿当载体——它的父版本 = 现行生效的总体规划版本（手写期望 s.eff.pv），
    //   形态父版本里必须带上这个编号；实现若保留该键却把父版本一律置空，上面的总体规划样本发现不了，这条才能判红
    const accVid = await H.mkPreparedVersion(await H.mkPackage(s.pid, 'batch_accept', s.batch));
    assert.strictEqual((await sqlGet('SELECT parent_overall_version_id AS p FROM sysbuild_package_versions WHERE id = ?', [accVid])).p, s.eff.pv, '夹具：验收包草稿的父版本 = 现行生效的总体规划版本');
    const ax = await scope({ vid: accVid });
    assert.strictEqual(ax.materials[0].material_key, 'acceptance-record');
    assert.deepStrictEqual(ax.attachmentSources.map((a) => [a.ownerType, a.ownerId, a.rows.length]), [['package_version', accVid, 0]]);
  });

  async function twoSources() {
    const s = await scene(false); const c = await overallDraft(s);
    const pa = await H.stageAtt(s.pid, U.pm, 'c'); const ma = await H.stageAtt(s.pid, U.pm, 'd');
    await sqlRun('INSERT INTO sysbuild_attachment_bindings (attachment_id, owner_type, owner_id, bound_by) VALUES (?, ?, ?, ?)', [pa, 'package_version', c.vid, U.pm]);
    const n = await sqlGet("SELECT id FROM sysbuild_nodes WHERE project_id = ? AND template_key = 'p_overall'", [s.pid]);
    const m = await post(U.pm, `/sysbuild/nodes/${n.id}/materials/requirements-document/versions`, { body: '范围时的冻结材料', attachment_ids: [ma] }); assert.strictEqual(m.status, 201, m.text);
    const mid = m.body.version.id;
    assert.strictEqual((await patch(`/sysbuild/package-versions/${c.vid}`, { snapshot_json: { text: '附件来源核对正文', z: 1, material_version_ids: [mid], a: { z: 2, b: 3 } } })).status, 200);
    return { s, c, pa, ma, mid };
  }
  test(`${P}scope四来源附件——来源清单（包版本绑定）与材料冻结行、冻结编号散列一致（标题沿用；#212 C7 起条目版本来源没有了，只剩包版本与材料版本两个来源）`, async () => {
    const { c, pa, ma, mid } = await twoSources(); const x = await scope(c);
    assert.deepStrictEqual(x.attachmentSources.map((a) => [a.ownerType, a.ownerId, a.rows.map((r) => [r.attachment_id, r.sha256])]), [['package_version', c.vid, [[pa, 'c'.repeat(64)]]]], '附件来源：包版本绑定的附件');
    assert.deepStrictEqual(x.materials.map((m) => [m.id, m.frozen.map((r) => [r.attachment_id, r.sha256])]), [[mid, [[ma, 'd'.repeat(64)]]]], '材料版本的冻结行');
    assert.deepStrictEqual(x.snapshot, { text: '附件来源核对正文', z: 1, material_version_ids: [mid], a: { z: 2, b: 3 } }, '快照取原对象');
    const sub = await post(U.pm, `/sysbuild/package-versions/${c.vid}/submit`);
    assert.strictEqual(sub.status, 200, sub.text);
    const frozen = await sqlAll("SELECT attachment_id, sha256 FROM sysbuild_frozen_attachments WHERE object_type = 'package_version' AND object_version_id = ? ORDER BY attachment_id", [c.vid]);
    assert.deepStrictEqual(frozen, [[pa, 'c'], [ma, 'd']].sort((a, b) => a[0] - b[0]).map(([attachment_id, h]) => ({ attachment_id, sha256: h.repeat(64) })));

    // 两条路径读取同一附件。只在包侧读取时模拟不一致，材料侧的预检和所冻结的散列保持真实。
    const { s: sharedProject, c: shared, ma: sharedAttachment, mid: sharedMaterial } = await twoSources();
    await sqlRun(
      "INSERT INTO sysbuild_attachment_refs (project_id, attachment_id, owner_type, owner_id, ref_by) VALUES (?, ?, 'package_version', ?, ?)",
      [sharedProject.pid, sharedAttachment, shared.vid, U.pm]
    );
    const sameHash = await scope(shared);
    const materialHash = sameHash.materials.find((m) => m.id === sharedMaterial).frozen[0].sha256;
    assert.strictEqual(sameHash.attachmentSources[0].rows.find((r) => r.attachment_id === sharedAttachment).sha256, materialHash, '同一附件的两条来源都已命中，散列一致时可读');
    let changedRows = 0;
    const skewPackageRead = async (sql, params = []) => {
      const rows = await sqlAll(sql, params);
      if (params[0] !== 'package_version' || params[1] !== shared.vid || params[2] !== 'package_version' || params[3] !== shared.vid) return rows;
      return rows.map((r) => {
        if (r.attachment_id !== sharedAttachment) return r;
        changedRows += 1;
        return { ...r, sha256: 'e'.repeat(64) };
      });
    };
    await assert.rejects(() => scope(shared, skewPackageRead), (err) => err.code === 'SYSBUILD_INTERNAL'
      && err.message === '内部错误：内容包重复附件的冻结hash不一致', '拒绝发生在跨来源比较，保留材料清单独立校验');
    assert.strictEqual(changedRows, 1, '只有包侧查询的一条结果被改写');
  });

  test(`${P}scope材料删除遮蔽——禁止过滤后继续提交，原样报出材料拒绝（51号HIGH-1）且冻结散列不改（载体：立项包草稿，材料拒绝只在立项包提交判）`, async () => {
    const s = await scene(false);
    const n = await sqlGet("SELECT id FROM sysbuild_nodes WHERE project_id = ? AND template_key = 'p_initiation'", [s.pid]);
    const ma = await H.stageAtt(s.pid, U.pm, 'd');
    const m = await post(U.pm, `/sysbuild/nodes/${n.id}/materials/l1-evidence/versions`, { name: '立项依据', body: '立项时的冻结材料', attachment_ids: [ma] }); assert.strictEqual(m.status, 201, m.text);
    const mid = m.body.version.id;
    const iniPk = (await sqlGet("SELECT id FROM sysbuild_packages WHERE project_id = ? AND type = 'initiation'", [s.pid])).id;
    const dv = await post(U.pm, `/sysbuild/packages/${iniPk}/versions`, {}); assert.strictEqual(dv.status, 201, dv.text);
    const vid = dv.body.version.id;
    assert.strictEqual((await patch(`/sysbuild/package-versions/${vid}`, { snapshot_json: { material_version_ids: [mid] } })).status, 200);
    for (const kind of ['deleted', 'masked']) {
      if (kind === 'deleted') await sqlRun("UPDATE sysbuild_attachments SET deleted_at = datetime('now','localtime'), deleted_by = ? WHERE id = ?", [U.pm, ma]);
      else await sqlRun("UPDATE sysbuild_attachments SET masked_at = datetime('now','localtime'), masked_by = ?, mask_reason = '受控材料' WHERE id = ?", [U.pm, ma]);
      await assert.rejects(() => scope({ vid }), (err) => err.code === 'SYSBUILD_INVALID_INPUT' && err.message.includes('已删除或已遮蔽'));
      const r = await post(U.pm, `/sysbuild/package-versions/${vid}/submit`); expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', `${kind} 材料拒绝原样报出`);
      assert.ok(r.body.message.includes('已删除或已遮蔽'), r.text);
      assert.ok(!r.body.message.includes('请选入立项节点下带附件的立项依据'), `${kind}：先报送审内容被拒的原始原因，不是立项依据缺失（scopeRejection 先于 initiationBasis）`);
      assert.strictEqual((await get(U.pm, `/sysbuild/package-versions/${vid}`)).body.actions.submit, false, `${kind}：提交标志同源为假`);
      expectErr(await post(U.m1, `/sysbuild/package-versions/${vid}/submit`), 403, 'SYSBUILD_FORBIDDEN', `${kind}：权限先于送审内容`);
      await sqlRun('UPDATE sysbuild_attachments SET deleted_at = NULL, deleted_by = NULL, masked_at = NULL, masked_by = NULL, mask_reason = NULL WHERE id = ?', [ma]);
    }
    assert.strictEqual((await sqlGet("SELECT sha256 FROM sysbuild_frozen_attachments WHERE object_type = 'material_version' AND object_version_id = ? AND attachment_id = ?", [mid, ma])).sha256, 'd'.repeat(64));
  });

  // 撤回条件更新探针（原「放弃条件更新探针」）已迁到 sysbuild-api-suite-c5.js 的「C5：撤回条件更新探针」（包装真实库，真实影响行数决定响应；M2043 与 N18 的 expect 都指向它）。
}

const mu = (id, expect, file, from, to) => ({ id: `L1 ${id}`, expect: [`${P}${expect}`], edits: [{ file, from, to }] });
const TRACE_L1_MUTATIONS = [
  mu('校验漏字段白名单', '表单字段反例', 'entry-forms.js', 'if (!allowed.includes(key)) throw invalid(', 'if (false) throw invalid('),
  mu('表单文本不核长度', '表单字段反例', 'entry-forms.js', 'length < min || length > max || rules.hasControlChar(value)', 'rules.hasControlChar(value)'),
  mu('互斥键遗漏', '互斥与类型用途', 'entry-forms.js', "['title', 'body']", '[]'), // #212 C6（A.4 M2001）：互斥键清单去 objects_entry_id / revision_of_entry_id（二者随 R9 成为退出键，onlyKeys 先拒）
  mu('不核类型用途', '互斥与类型用途', 'entry-forms.js', 'hasKey(body, key) && body[key] !== def[key]', 'false'),
  mu('不可读降级普通', '不可读登记', 'entry-forms.js', 'return Object.assign({}, empty, { form_unreadable: true });', 'return empty;'),
  mu('不可读动作放开', '不可读登记', 'rules.js', "op.startsWith('entry_') && op !== 'entry_void' && t.formUnreadable === true", 'false'),
  mu('勘误丢失', '勘误只追加', 'entry-forms.js', "(actions || []).filter((a) => a.action === 'correct')", '[]'),
  // 51 号修复批：HIGH-1（送审内容被拒原样报出）、LOW-2（放弃后改发文案）、LOW-4（确认展示与归档单）
  mu('送审拒绝状态码一律409', 'scope材料删除遮蔽', 'rules.js', 'status: [400, 500].includes(msg.status) ? msg.status : 409, code: msg.code', 'status: 409, code: msg.code'),
  {"id":"L1 scope漏包附件来源","expect":["L1 留痕：scope四来源附件"],"edits":[{"file":"submission-scope.js","from":"const rows = await readAttachmentSet(q, { ...owner, projectId: pkg.project_id });","to":"const rows = [];"}]},
  {"id":"L1 scope漏材料附件来源","expect":["L1 留痕：scope四来源附件"],"edits":[{"file":"submission-scope.js","from":"[...rows, ...materials.flatMap((m) => m.frozen)]","to":"rows"}]},
  {"id":"L1 scope材料不可用仍通过","expect":["L1 留痕：scope材料删除遮蔽"],"edits":[{"file":"submission-scope.js","from":"const materials = await materialsCore.selectedMaterials(q, pkg.project_id, snapshot, { usable: true });","to":"const materials = await materialsCore.selectedMaterials(q, pkg.project_id, snapshot, { usable: false });"}]},
  // M2043（撤回的零行拒绝）：expect 改挂 sysbuild-api-suite-c5.js 的探针用例（A.5）；id 不变（`L1 放弃版本零行未拒绝`）
  { id: 'L1 放弃版本零行未拒绝', expect: ['C5：撤回条件更新探针'], edits: [{ file: 'confirm.js', from: "if (up.changes === 0) throw stateError('版本状态已变化，请刷新后重试');\n      const revs", to: 'const revs' }] },
];
module.exports = { defineTraceL1Cases, TRACE_L1_MUTATIONS };
