'use strict';
const assert = require('assert');
function defineStage8Cases(T) {
    const { test, U, api, sqlGet, sqlAll, sqlRun, confirm: C, SKIP, getReadInterleaveKit, stageFile } = T;
    const call = async (uid, method, route, body, expected) => {
        const res = await api(uid, method, '/sysbuild' + route, body);
        assert.strictEqual(res.status, expected === undefined ? 200 : expected, method + ' ' + route + ': ' + res.text);
        return res.body;
    };
    const post = (uid, route, body, expected) => call(uid, 'POST', route, body === undefined ? {} : body, expected);
    const viewCount = async () => (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_views', [])).n;
    test('C8 材料版本：只追加与本材料附件沿用，冻结hash不变，跨项目 / 只读 / 非PM / 收口节点拒绝', async () => {
        const pid = await C.newProject();
        const batch = await C.defaultBatchId(pid);
        const added = await post(U.pm, '/batches/' + batch + '/nodes', { name: '材料验证节点' }, 201);
        const nodeId = added.node.id;
        const attachmentId = await C.stageAtt(pid, U.pm, 'c');
        const first = await post(U.pm, '/nodes/' + nodeId + '/materials/design/versions', { name: '设计说明', body: '第一版正文', attachment_ids: [attachmentId] }, 201);
        assert.strictEqual(first.version.version_no, 1);
        const second = await post(U.pm, '/nodes/' + nodeId + '/materials/design/versions', { body: '第二版正文', ref_attachment_ids: [attachmentId] }, 201);
        assert.strictEqual(second.material.id, first.material.id);
        assert.strictEqual(second.version.version_no, 2);
        const old = await call(U.ro, 'GET', '/material-versions/' + first.version.id);
        const current = await call(U.pm, 'GET', '/material-versions/' + second.version.id);
        assert.strictEqual(old.version.body, '第一版正文');
        assert.strictEqual(current.version.body, '第二版正文');
        assert.strictEqual(current.version.attachments[0].sha256, 'c'.repeat(64));
        const frozen = await sqlAll("SELECT object_version_id, attachment_id, sha256 FROM sysbuild_frozen_attachments WHERE object_type = 'material_version' AND object_version_id IN (?, ?) ORDER BY object_version_id", [first.version.id, second.version.id]);
        assert.deepStrictEqual(frozen, [first.version.id, second.version.id].map((id) => ({ object_version_id: id, attachment_id: attachmentId, sha256: 'c'.repeat(64) })));
        const count = (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_material_versions', [])).n;
        const events = (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_events', [])).n;
        for (const uid of [U.ro, U.admin]) await post(uid, '/nodes/' + nodeId + '/materials/design/versions', { body: '不应产生的版本' }, 403);
        await post(U.out, '/nodes/' + nodeId + '/materials/design/versions', { body: '不应探测项目' }, 404);
        await post(U.pm, '/nodes/' + nodeId + '/materials/other/versions', { name: '另一材料', body: '不能借用别的材料附件', ref_attachment_ids: [attachmentId] }, 400);
        assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_material_versions', [])).n, count);
        assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_events', [])).n, events);
        await post(U.pm, '/nodes/' + nodeId + '/start');
        await post(U.pm, '/nodes/' + nodeId + '/close');
        const supplement = await post(U.pm, '/nodes/' + nodeId + '/materials/design/versions', { body: '收口后的补传' }, 201);
        assert.strictEqual(supplement.version.version_no, 3);
        const otherPid = await C.newProject();
        const otherPackage = await C.mkPackage(otherPid, 'initiation');
        const otherVersion = await C.mkVersion(otherPackage);
        await call(U.pm, 'PATCH', '/package-versions/' + otherVersion, { snapshot_json: { text: '不能串项目', material_version_ids: [first.version.id] } }, 400);
        const otherSaved = await call(U.pm, 'GET', '/package-versions/' + otherVersion);
        assert.deepStrictEqual(otherSaved.snapshot_json, { text: '本次需要确认的内容及依据' });
    });
    test('C8 材料引用：普通提交与生效保留指定版本及原冻结hash，后续候选新版不替换确认正文', async () => {
        const pid = await C.newProject();
        await C.seedParty(pid, '材料确认需求方', U.own, U.del);
        const plan = await call(U.pm, 'GET', '/projects/' + pid + '/plan');
        const node = plan.nodes.find((n) => n.template_key === 'p_initiation');
        const att = await C.stageAtt(pid, U.pm, 'd');
        const literal = '负责人应看到的第一版正文 <svg onload="window.c8Bad=1"> & "原文"';
        const material = await post(U.pm, '/nodes/' + node.id + '/materials/initiation-basis/versions', { body: literal, attachment_ids: [att] }, 201);
        const pk = await C.mkPackage(pid, 'initiation');
        const vid = await C.mkVersion(pk);
        await call(U.pm, 'PATCH', '/package-versions/' + vid, { snapshot_json: { text: '立项全文', material_version_ids: [material.version.id] } });
        await post(U.pm, '/package-versions/' + vid + '/submit');
        const tasks = await C.tasksOf(vid);
        assert.strictEqual(tasks.length, 1);
        const before = await call(U.own, 'GET', '/confirm-tasks/' + tasks[0].task_id);
        assert.strictEqual(before.object.materials[0].id, material.version.id);
        assert.strictEqual(before.object.materials[0].body, literal);
        assert.strictEqual(before.frozen_attachments.find((a) => a.attachment_id === att).sha256, 'd'.repeat(64));
        await post(U.pm, '/nodes/' + node.id + '/materials/initiation-basis/versions', { body: '后续候选第二版' }, 201);
        const after = await call(U.own, 'GET', '/confirm-tasks/' + tasks[0].task_id);
        assert.strictEqual(after.object.materials[0].body, literal);
        await C.confirmAll(vid);
        const effective = await call(U.pm, 'GET', '/package-versions/' + vid);
        assert.strictEqual(effective.version.status, 'effective');
        assert.strictEqual(effective.materials[0].id, material.version.id);
        const uses = await call(U.pm, 'GET', '/material-versions/' + material.version.id);
        assert.ok(uses.version.uses.some((use) => use.package_version_id === vid && use.status === 'effective'));
        const views = await viewCount();
        const sheet = await api(U.pm, 'GET', '/sysbuild/package-versions/' + vid + '/confirmation-sheet');
        assert.strictEqual(sheet.status, 200, sheet.text);
        assert.ok(sheet.text.includes('id="sec-materials"'));
        assert.ok(sheet.text.includes('data-material-version-id="' + material.version.id + '"'));
        assert.ok(sheet.text.includes('&lt;svg onload=&quot;window.c8Bad=1&quot;&gt; &amp; &quot;原文&quot;'));
        assert.ok(!sheet.text.includes('<svg onload='));
        assert.ok(!sheet.text.includes('后续候选第二版'));
        assert.ok(sheet.text.includes('d'.repeat(64)));
        assert.strictEqual(await viewCount(), views, '导出仍是纯读，不写本人浏览');
    });
    test('C8 通知修订：定位纯读，旧修订GET不写新版浏览，当前修订显示人名 / 决策，同一页面改发绑定旧修订', async () => {
        const pid = await C.newProject();
        await C.seedParty(pid, '修订需求方', U.own, U.del);
        const pk = await C.mkPackage(pid, 'initiation');
        const vid = await C.mkVersion(pk);
        // L2 fixture：通知修订用例需要成功提交的立项包，显式补声明；材料正例与反例不动。
        await C.declareInitiationBasis(vid);
        await post(U.pm, '/package-versions/' + vid + '/submit');
        const first = (await C.tasksOf(vid))[0];
        const before = await viewCount();
        const locate = await call(U.own, 'GET', '/confirm-task-revisions/' + first.rev_id);
        assert.deepStrictEqual(locate, { revision_id: first.rev_id, task_id: first.task_id, project_id: pid, rev_no: 1, status: 'pending', is_current: true, current_revision_id: first.rev_id });
        assert.strictEqual(await viewCount(), before);
        await call(U.out, 'GET', '/confirm-task-revisions/' + first.rev_id, undefined, 404);
        const newer = await post(U.pm, '/confirm-tasks/' + first.task_id + '/reissue', { reason: '核对后重新发起本项', revision_id: first.rev_id });
        const old = await call(U.own, 'GET', '/confirm-task-revisions/' + first.rev_id);
        assert.strictEqual(old.is_current, false);
        assert.strictEqual(old.current_revision_id, newer.revision.id);
        for (const uid of [U.own, U.pm, U.ro]) await call(uid, 'GET', '/confirm-tasks/' + first.task_id + '?revision_id=' + first.rev_id, undefined, 409);
        assert.strictEqual(await viewCount(), before);
        const opened = await call(U.own, 'GET', '/confirm-tasks/' + first.task_id + '?revision_id=' + newer.revision.id);
        assert.strictEqual(await viewCount(), before + 1);
        assert.ok(opened.revision.required_name);
        assert.ok(opened.project.system_name);
        assert.deepStrictEqual(opened.allowed_decisions, ['confirm', 'object', 'reject']);
        assert.strictEqual(opened.actions.export_sheet, true);
        await post(U.pm, '/confirm-tasks/' + first.task_id + '/reissue', { reason: '不能凭旧页面再次改发', revision_id: first.rev_id }, 409);
        const rows = await sqlAll('SELECT id FROM sysbuild_confirm_task_revisions WHERE task_id = ?', [first.task_id]);
        assert.strictEqual(rows.length, 2);
    });
    test('C8 通知读写交错：第一次读锁后改发，第二次写锁必须拒绝旧修订且不写新版浏览', async () => {
        const kit = typeof getReadInterleaveKit === 'function' ? getReadInterleaveKit() : null;
        if (!kit) return SKIP;
        const pid = await C.newProject();
        await C.seedParty(pid, '锁内复核需求方', U.own, U.del);
        const pk = await C.mkPackage(pid, 'initiation');
        const vid = await C.mkVersion(pk);
        // L2 fixture：先置立项门前置，随后仍按原交错读取时点验证旧修订被拒。
        await C.declareInitiationBasis(vid);
        await post(U.pm, '/package-versions/' + vid + '/submit');
        const first = (await C.tasksOf(vid))[0];
        const before = await viewCount();
        let changed = null;
        const restore = kit.install(async () => {
            changed = await post(U.pm, '/confirm-tasks/' + first.task_id + '/reissue', { reason: '发生在两次锁之间的改发', revision_id: first.rev_id });
        });
        try { await call(U.own, 'GET', '/confirm-tasks/' + first.task_id + '?revision_id=' + first.rev_id, undefined, 409); }
        finally { restore(); }
        assert.ok(changed && changed.revision.id !== first.rev_id);
        assert.strictEqual(await viewCount(), before, '竞态中不得把新版记作已读');
        const current = await call(U.own, 'GET', '/confirm-tasks/' + first.task_id + '?revision_id=' + changed.revision.id);
        assert.strictEqual(current.revision.id, changed.revision.id);
        assert.strictEqual(await viewCount(), before + 1);
    });
    test('C8 材料引用校验：预留字段形态 / 同材料单版本 / 遮蔽新引用受控，失败不更改草稿', async () => {
        const pid = await C.newProject();
        const node = (await call(U.pm, 'GET', '/projects/' + pid + '/plan')).nodes[0];
        const att = await C.stageAtt(pid, U.pm, 'e');
        const v1 = await post(U.pm, '/nodes/' + node.id + '/materials/check/versions', { name: '校验材料', body: '原文一', attachment_ids: [att] }, 201);
        const v2 = await post(U.pm, '/nodes/' + node.id + '/materials/check/versions', { body: '原文二' }, 201);
        const pk = await C.mkPackage(pid, 'initiation');
        const vid = await C.mkVersion(pk);
        const initial = { text: '保留本版草稿文字' };
        await call(U.pm, 'PATCH', '/package-versions/' + vid, { snapshot_json: initial });
        const foreignPid = await C.newProject();
        const foreignNode = (await call(U.pm, 'GET', '/projects/' + foreignPid + '/plan')).nodes[0];
        const foreign = await post(U.pm, '/nodes/' + foreignNode.id + '/materials/plain/versions', { name: '外项目无附件材料', body: '即使没有附件也不能被串项目引用' }, 201);
        await call(U.pm, 'PATCH', '/package-versions/' + vid, { snapshot_json: { text: '不允许串入纯文字材料', material_version_ids: [foreign.version.id] } }, 400);
        assert.deepStrictEqual((await call(U.pm, 'GET', '/package-versions/' + vid)).snapshot_json, initial);
        for (const bad of [null, '1', {}, [0], [-1], [1.5], ['1'], [v1.version.id, v1.version.id], [v1.version.id, v2.version.id]]) {
            await call(U.pm, 'PATCH', '/package-versions/' + vid, { snapshot_json: { text: '不应保存', material_version_ids: bad } }, 400);
            assert.deepStrictEqual((await call(U.pm, 'GET', '/package-versions/' + vid)).snapshot_json, initial);
        }
        await post(U.pm, '/attachments/' + att + '/mask', { reason: '此附件含应受控处理的内容' });
        await call(U.pm, 'PATCH', '/package-versions/' + vid, { snapshot_json: { text: '不能新引用遮蔽附件', material_version_ids: [v1.version.id] } }, 400);
        await post(U.pm, '/nodes/' + node.id + '/materials/check/versions', { body: '不可沿用遮蔽附件', ref_attachment_ids: [att] }, 400);
        const read = await call(U.ro, 'GET', '/material-versions/' + v1.version.id);
        const masked = read.version.attachments[0];
        assert.strictEqual(masked.name, null);
        assert.strictEqual(masked.original_name, null);
        assert.strictEqual(masked.mask_reason, '此附件含应受控处理的内容');
        assert.strictEqual(masked.masked_by, U.pm);
        assert.ok(masked.masked_by_name && masked.masked_at);
        assert.strictEqual(masked.sha256, 'e'.repeat(64));
    });
    test('C8 材料冻结兜底：被篡改为缺少材料冻结附件时，最后确认回滚且版本不生效（夹具）', async () => {
        const pid = await C.newProject();
        await C.seedParty(pid, '冻结防御需求方', U.own, U.del);
        const node = (await call(U.pm, 'GET', '/projects/' + pid + '/plan')).nodes[0];
        const att = await C.stageAtt(pid, U.pm, 'f');
        const material = await post(U.pm, '/nodes/' + node.id + '/materials/initiation-basis/versions', { body: '完整原文', attachment_ids: [att] }, 201);
        const pk = await C.mkPackage(pid, 'initiation');
        const vid = await C.mkVersion(pk);
        await call(U.pm, 'PATCH', '/package-versions/' + vid, { snapshot_json: { text: '需要完整冻结的版本', material_version_ids: [material.version.id] } });
        await post(U.pm, '/package-versions/' + vid + '/submit');
        const task = (await C.tasksOf(vid))[0];
        // 正常API无法删除冻结行；此夹具只验证同一生效闸门的防御性拒绝和整笔回滚。
        await sqlRun("DELETE FROM sysbuild_frozen_attachments WHERE object_type = 'package_version' AND object_version_id = ? AND attachment_id = ?", [vid, att]);
        const opened = await call(U.own, 'GET', '/confirm-tasks/' + task.task_id);
        await post(U.own, '/confirm-tasks/' + task.task_id + '/decide', { revision_id: opened.revision.id, object_version_id: vid, decision: 'confirm', checkbox_text: '我已阅读以上全部内容，确认无误' }, 500);
        assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id = ?', [vid])).status, 'pending');
        assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_confirm_task_revisions WHERE id = ?', [task.rev_id])).status, 'pending');
        assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_confirmations WHERE task_revision_id = ?', [task.rev_id])).n, 0);
    });
    test('C8 登记与条目元数据：来源显式选项、用途恒为通用且无本人确认配置（#212 C7 起条目元数据、提出人任务与浏览记录部分随需求条目流程删除，标题沿用）', async () => {
        const pid = await C.newProject();
        const party = (await post(U.pm, '/projects/' + pid + '/parties', {
            side: 'dev', name: '开发合作方', leader_user_id: U.own, representative_user_id: U.del,
        }, 201)).party.id;
        await post(U.pm, '/projects/' + pid + '/members', { user_id: U.m1, party_id: party }, 201);
        const meta = async (uid) => (await call(uid, 'GET', '/projects/' + pid + '/entries')).registration;
        const pm = await meta(U.pm);
        const owner = await meta(U.own);
        const representative = await meta(U.del);
        const ordinary = await meta(U.m1);
        assert.ok(pm.source_choices.some((source) => source.id === null) && pm.source_choices.some((source) => source.id === party));
        assert.strictEqual(owner.source_choices, null);
        // C6（P-R6E / P-R9 = A）：registration 不再有 self_confirm 对象，用途恒为 ['general']（PM / 负责人 / 代表人 / 一般成员四种身份同值）
        for (const [who, reg] of [['PM', pm], ['负责人', owner], ['代表人', representative], ['一般成员', ordinary]]) {
            assert.ok(!('self_confirm' in reg), `${who}：registration 没有 self_confirm`);
            assert.deepStrictEqual(reg.purposes, ['general'], `${who}：purposes 恒为 general`);
        }
    });
}
const mu = (id, expect, file, from, to) => ({ id: 'C8 ' + id, expect: Array.isArray(expect) ? expect : [expect], edits: [{ file, from, to }] });
const STAGE8_MUTATIONS = [
  {"id":"C8 材料权限放开非PM","expect":["C8 材料版本"],"edits":[{"file":"rules.js","from":"material_version_create: Object.freeze({\n    can: canActAsPm,","to":"material_version_create: Object.freeze({\n    can: () => true,"}]},
    mu('材料版本号跳号', 'C8 材料版本', 'materials.js', 'const versionNo = last.n + 1;', 'const versionNo = last.n + 2;'),
    mu('材料正文误存', 'C8 材料版本', 'materials.js', '[material.id, versionNo, text, Number(user.id)]', "[material.id, versionNo, '错误正文', Number(user.id)]"),
    mu('材料跨项沿用附件', 'C8 材料版本', 'materials.js', "if (!bound && !ref) throw invalid('附件不存在或不可沿用', 'ref_attachment_ids');", "if (false) throw invalid('附件不存在或不可沿用', 'ref_attachment_ids');"),
    mu('材料保存不冻结附件', 'C8 材料版本', 'materials.js', "await attachmentHelpers.freezeAttachmentSet(q, { objectType: 'material_version', objectVersionId: version.lastID, ownerType: 'material_version', ownerId: version.lastID, projectId: c.node.project_id, operatorId: uid, operatorName });", 'void version.lastID;'),
    mu('材料引用可串项目', 'C8 材料引用校验', 'materials-core.js', "if (!record || record.project_id !== projectId) throw invalid('材料版本不存在或不属于本项目');", "if (!record) throw invalid('材料版本不存在或不属于本项目');"),
    mu('同材料可选两版', 'C8 材料引用校验', 'materials-core.js', "if (materialIds.has(record.material_id)) throw invalid('同一材料在一个内容包版本中只能引用一版');", "if (false) throw invalid('同一材料在一个内容包版本中只能引用一版');"),
    // 重复同一版本同时违反「编号不重复」与「同材料一版」。两个互为后备的校验一起撤掉，验证对外行为，避免绑定报错文案以区分等效防御。
    { id: 'C8 重复材料ID绕过两处校验', expect: ['C8 材料引用校验'], edits: [
        { file: 'materials-core.js', from: "if (new Set(ids).size !== ids.length) throw invalid('材料版本编号不能重复');", to: "if (false) throw invalid('材料版本编号不能重复');" },
        { file: 'materials-core.js', from: "if (materialIds.has(record.material_id)) throw invalid('同一材料在一个内容包版本中只能引用一版');", to: "if (false) throw invalid('同一材料在一个内容包版本中只能引用一版');" },
    ] },
    mu('新引用接受遮蔽材料', 'C8 材料引用校验', 'materials-core.js', "if (options && options.usable && bound.some((a) => a.deleted_at || a.masked_at)) throw invalid('材料含已删除或已遮蔽的附件，不能新增引用，请建立可复核的新版本');", "if (false) throw invalid('材料含已删除或已遮蔽的附件，不能新增引用，请建立可复核的新版本');"),
    mu('材料确认正文缺失', 'C8 材料引用', 'confirm.js', 'materials: await materialsCore.selectedMaterials(q, pkg.project_id, ver.snapshot_json, { usable: false }),', 'materials: [],'),
    mu('材料详情引用缺失', 'C8 材料引用', 'packages.js', 'materials: await materialsCore.selectedMaterials(q, pkg.project_id, ver.snapshot_json, { usable: false }),', 'materials: [],'),
    mu('普通提交漏冻结材料', 'C8 材料引用', 'confirm.js', 'await materialsCore.freezeMaterialRows(q, { projectId: pid, versionId: vid, operatorId: opId, operatorName: opName }, scope.materials);', 'void vid;'),
  {"id":"C8 材料生效漏核冻结完整性","expect":["C8 材料冻结兜底"],"edits":[{"file":"confirm-core.js","from":"async function applyPackageEffect(q, user, projectId, pkg, ver) {\n  await materialsCore.assertMaterialFreezes(q, projectId, ver);","to":"async function applyPackageEffect(q, user, projectId, pkg, ver) {"}]},
    mu('旧通知任务GET不核修订', 'C8 通知修订', 'confirm.js', "if (expectedRevision !== null && expectedRevision !== undefined && expectedRevision !== c.latest.id) throw makeError(409, 'SYSBUILD_TASK_SUPERSEDED', '任务修订已变化，请明确重新打开当前任务');", "if (false) throw makeError(409, 'SYSBUILD_TASK_SUPERSEDED', '任务修订已变化，请明确重新打开当前任务');"),
    mu('通知只核第一次读锁', 'C8 通知读写交错', 'confirm.js', 'if (expectedRevision !== null && expectedRevision !== undefined && expectedRevision !== c.latest.id)', 'if (!record && expectedRevision !== null && expectedRevision !== undefined && expectedRevision !== c.latest.id)'),
    mu('旧页面改发不核修订', 'C8 通知修订', 'confirm.js', "if (expectedRevision !== null && expectedRevision !== c.latest.id) throw makeError(409, 'SYSBUILD_TASK_SUPERSEDED', '任务修订已变化，请重新打开后再改发');", "if (false) throw makeError(409, 'SYSBUILD_TASK_SUPERSEDED', '任务修订已变化，请重新打开后再改发');"),
    mu('通知定位伪称当前', 'C8 通知修订', 'confirm.js', 'is_current: revision.id === c.latest.id,', 'is_current: true,'),
    mu('确认遗漏必需确认人名', 'C8 通知修订', 'confirm.js', 'required_name: current.required_name', 'required_name: null'),
    mu('确认误给决策选项', 'C8 通知修订', 'confirm.js', 'allowed_decisions: Object.keys(DECISIONS),', "allowed_decisions: ['confirm'],"),
    mu('确认遗漏导出能力', 'C8 通知修订', 'confirm.js', "body.actions.export_sheet = c.obj.kind === 'package_version' && rules.canExportConfirmationSheet(c.access, c.obj.ver);", 'body.actions.export_sheet = false;'),
    mu('确认单漏材料正文', 'C8 材料引用', 'confirmation-sheet.js', "${m.materials.length ? section('sec-materials', '引用材料版本全文', m.materials.map(renderMaterial)) : ''}", ''),
    mu('登记来源选项遗漏PM本人', 'C8 登记与条目元数据', 'entries.js', "[{ id: null, label: identity.isPm === true ? 'PM 本人登记' : '管理员本人登记' }, ...", '[...'),
    // #212 C6：详情路由的 identity 取数随知会异议删除（entries.js 现写 `const { access } = await loadProjectCtx(…)`），from / to 随之改写；expect 改挂到 frontend 套件的知会详情可见性用例（原 C8 用例里的非成员 404 读取随 :238–246 删；该用例拒绝循环里 U.ro / U.m1 / U.x1 / U.out 的 404 来自详情路由自带的接收人 / PM / admin 校验，不是项目可见性守卫，判红靠用例末尾「已移出项目的接收人读详情 404」一格：接收人校验的 SQL 不看 removed_at，只有项目可见性会拦）
    mu('知会详情绕过项目可见性', 'C7 S-1 改期知会详情可见性', 'entries.js', 'const { access } = await loadProjectCtx(q, notice.project_id, req.user);', 'const access = await rules.loadProjectAccess(q, notice.project_id, req.user, accessOpts());'),
    mu('材料维护类别误作身份类', 'rules：OP_KIND 与状态表', 'rules.js', "material_version_create: 'maintain',", "material_version_create: 'membership',"),
];
module.exports = { defineStage8Cases, STAGE8_MUTATIONS };
