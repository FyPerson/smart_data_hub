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
        await post(U.pm, '/nodes/' + nodeId + '/materials/design/versions', { body: '收口后不直接追加' }, 409);
        const otherPid = await C.newProject();
        const otherPackage = await C.mkPackage(otherPid, 'initiation');
        const otherVersion = await C.mkVersion(otherPackage);
        await call(U.pm, 'PATCH', '/package-versions/' + otherVersion, { snapshot_json: { text: '不能串项目', material_version_ids: [first.version.id] } }, 400);
        const otherSaved = await call(U.pm, 'GET', '/package-versions/' + otherVersion);
        assert.deepStrictEqual(otherSaved.snapshot_json, {});
    });
    test('C8 材料引用：普通提交与生效保留指定版本及原冻结hash，后续候选新版不替换确认正文', async () => {
        const pid = await C.newProject();
        await C.seedParty(pid, '材料确认需求方', U.own, U.del);
        const plan = await call(U.pm, 'GET', '/projects/' + pid + '/plan');
        const node = plan.nodes.find((n) => n.template_key === 'p_initiation');
        const att = await C.stageAtt(pid, U.pm, 'd');
        const literal = '负责人应看到的第一版正文 <svg onload="window.c8Bad=1"> & "原文"';
        const material = await post(U.pm, '/nodes/' + node.id + '/materials/initiation/versions', { name: '立项原始材料', body: literal, attachment_ids: [att] }, 201);
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
        await post(U.pm, '/nodes/' + node.id + '/materials/initiation/versions', { body: '后续候选第二版' }, 201);
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
        const material = await post(U.pm, '/nodes/' + node.id + '/materials/freeze/versions', { name: '冻结防御材料', body: '完整原文', attachment_ids: [att] }, 201);
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
    test('C8 确认对象可见性：待接受授权的已代录批准任务及其凭据，不得绕过成员页；生效后仍能复核', async () => {
        const pid = await C.newProject();
        const party = (await post(U.pm, '/projects/' + pid + '/parties', { side: 'demand', name: '线下任职授权部门' }, 201)).party.id;
        const ordinary = await post(U.pm, '/projects/' + pid + '/members', { user_id: U.m1 }, 201);
        await post(U.m1, '/my/invitations/' + ordinary.invitation.id + '/accept');
        const owner = (await post(U.pm, '/projects/' + pid + '/members', { party_id: party, person_name: '无账号负责人' }, 201)).member.id;
        const delegate = (await post(U.pm, '/projects/' + pid + '/members', { party_id: party, person_name: '无账号候选代表人' }, 201)).member.id;
        const appointment = (await post(U.pm, '/parties/' + party + '/appointments', { member_id: owner }, 201)).appointment.id;
        const date = (await sqlGet('SELECT substr(created_at, 1, 10) AS day FROM sysbuild_appointments WHERE id = ?', [appointment])).day;
        const evidence = async (name) => ({ external_date: date, actual_confirmer: name, identity_basis: '该部门原始签字任职及授权凭据中的身份依据', attachment_ids: [await stageFile(U.pm, pid)] });
        await post(U.pm, '/appointments/' + appointment + '/proxy-accept', await evidence('无账号负责人'));
        const delegation = (await post(U.pm, '/parties/' + party + '/delegations', { member_id: delegate }, 201)).delegation.id;
        const grant = await evidence('无账号负责人');
        await post(U.pm, '/delegations/' + delegation + '/proxy', { ...grant, expected_step: 'grant' });
        const task = await sqlGet("SELECT t.id AS task_id, r.id AS revision_id FROM sysbuild_confirm_tasks t JOIN sysbuild_confirm_task_revisions r ON r.task_id = t.id WHERE t.object_type = 'delegation' AND t.object_id = ? AND t.purpose = 'delegation_grant'", [delegation]);
        assert.ok(task);
        const detail = await call(U.m1, 'GET', '/projects/' + pid);
        assert.ok(!detail.delegations.some((d) => d.id === delegation));
        const observed = [];
        const paths = [
            ['任务', '/confirm-tasks/' + task.task_id], ['修订定位', '/confirm-task-revisions/' + task.revision_id],
            ['凭据记录', '/attachments/' + grant.attachment_ids[0]],
            ['凭据下载', '/attachments/' + grant.attachment_ids[0] + '/download'], ['凭据预览', '/attachments/' + grant.attachment_ids[0] + '/preview'],
        ];
        for (const uid of [U.m1, U.ro]) for (const [kind, path] of paths) {
            const response = await api(uid, 'GET', '/sysbuild' + path);
            observed.push({ role: uid === U.ro ? '只读' : '普通成员', kind, status: response.status });
        }
        console.log('待接受授权读侧状态：' + JSON.stringify(observed));
        assert.deepStrictEqual(observed.map((r) => r.status), Array(10).fill(404));
        await call(U.pm, 'GET', '/confirm-tasks/' + task.task_id);
        const managed = await call(U.pm, 'GET', '/attachments/' + grant.attachment_ids[0]);
        assert.strictEqual(managed.attachment.actions.mask, true);
        assert.strictEqual(managed.attachment.actions.delete, false);
        await call(U.pm, 'GET', '/attachments/' + grant.attachment_ids[0] + '/download');
        await post(U.pm, '/delegations/' + delegation + '/proxy', { ...await evidence('无账号候选代表人'), expected_step: 'accept' });
        const active = await call(U.m1, 'GET', '/projects/' + pid);
        assert.ok(active.delegations.some((d) => d.id === delegation && d.status === 'active'));
        await call(U.m1, 'GET', '/confirm-tasks/' + task.task_id);
        await call(U.ro, 'GET', '/confirm-task-revisions/' + task.revision_id);
        const record = await call(U.m1, 'GET', '/attachments/' + grant.attachment_ids[0]);
        assert.strictEqual(record.attachment.actions.mask, false);
        assert.ok(!('file_name' in record.attachment));
        await call(U.m1, 'GET', '/attachments/' + grant.attachment_ids[0] + '/download');
    });
    test('C8 历史材料导入：历史生效使用相同材料冻结闸门，导出保留原版本与历史标记且不生成当前确认', async () => {
        const pid = await C.newProject();
        await C.seedParty(pid, '历史材料需求方', U.own, U.del);
        await post(U.pm, '/projects/' + pid + '/history-window', { action: 'open', attachment_ids: [await C.stageAtt(pid, U.pm, '1')] });
        const node = (await call(U.pm, 'GET', '/projects/' + pid + '/plan')).nodes.find((n) => n.template_key === 'p_initiation');
        const att = await C.stageAtt(pid, U.pm, '2');
        const material = await post(U.pm, '/nodes/' + node.id + '/materials/legacy/versions', { name: '历史原件材料', body: '历史确认时原件全文', attachment_ids: [att] }, 201);
        const pk = await C.mkPackage(pid, 'initiation');
        const vid = await C.mkVersion(pk);
        await call(U.pm, 'PATCH', '/package-versions/' + vid, { snapshot_json: { text: '历史立项事实', material_version_ids: [material.version.id] } });
        await post(U.pm, '/projects/' + pid + '/history-imports', { fact_type: 'package_effective', object_id: vid, actual_confirmer: '原部门负责人', identity_basis: '历史原件中的负责人签字及当时任职文件', original_date: '2020-01-02', attachment_ids: [await C.stageAtt(pid, U.pm, '3')] }, 201);
        const saved = await call(U.pm, 'GET', '/package-versions/' + vid);
        assert.strictEqual(saved.version.status, 'effective');
        const expectedName = await sqlGet('SELECT COALESCE(display_name, username) AS name FROM users WHERE id = ?', [U.pm]);
        const imported = await call(U.pm, 'GET', '/projects/' + pid + '/history-imports');
        assert.strictEqual(imported.history_imports[0].imported_by_name, expectedName.name);
        await post(U.pm, '/projects/' + pid + '/history-confirmations', { object_type: 'package_version', object_version_id: vid, decision: 'confirm', external_date: '2020-01-02', actual_confirmer: '原部门负责人', identity_basis: '历史签字原件记载的当时负责人身份依据', attachment_ids: [await C.stageAtt(pid, U.pm, '7')] }, 201);
        const confirmed = await call(U.pm, 'GET', '/projects/' + pid + '/history-confirmations');
        assert.strictEqual(confirmed.history_confirmations[0].proxy_by_name, expectedName.name);
        assert.strictEqual(saved.materials[0].id, material.version.id);
        const frozen = await sqlGet("SELECT sha256 FROM sysbuild_frozen_attachments WHERE object_type = 'package_version' AND object_version_id = ? AND attachment_id = ?", [vid, att]);
        assert.strictEqual(frozen.sha256, '2'.repeat(64));
        assert.strictEqual((await C.tasksOf(vid)).length, 0);
        const beforeViews = await viewCount();
        const sheet = await api(U.ro, 'GET', '/sysbuild/package-versions/' + vid + '/confirmation-sheet');
        assert.strictEqual(sheet.status, 200, sheet.text);
        assert.ok(sheet.text.includes('data-history-import="1"') && sheet.text.includes('历史确认时原件全文'));
        assert.strictEqual(await viewCount(), beforeViews);
    });
    test('C8 变更材料链：变更生效派生完整总体版本，指定材料及冻结hash同时沿用，旧总体保留原文', async () => {
        const pid = await C.newProject();
        await C.seedParty(pid, '变更材料需求方', U.own, U.del);
        await C.produceEffectiveInitiation(pid);
        await C.planAllNodes(pid);
        const plan = await call(U.pm, 'GET', '/projects/' + pid + '/plan');
        const node = plan.nodes.find((n) => n.template_key === 'p_overall');
        const att = await C.stageAtt(pid, U.pm, '4');
        const m1 = await post(U.pm, '/nodes/' + node.id + '/materials/scope/versions', { name: '总体范围材料', body: '原总体材料正文', attachment_ids: [att] }, 201);
        const item = await C.mkItem(pid);
        const pk = await C.mkPackage(pid, 'overall');
        const vid = await C.mkVersion(pk);
        await C.addToSet(vid, item.versions[0].id, await C.defaultBatchId(pid));
        await call(U.pm, 'PATCH', '/package-versions/' + vid, { snapshot_json: { text: '原总体确认文字', material_version_ids: [m1.version.id] } });
        await post(U.pm, '/package-versions/' + vid + '/submit'); await C.confirmAll(vid);
        const change = await post(U.pm, '/projects/' + pid + '/changes', { title: '调整材料表达', body: '保留需求范围，明确新的材料版本', no_written_evidence: true, no_evidence_reason: '当面核对后口头明确本次材料表达的变更依据' }, 201);
        const m2 = await post(U.pm, '/nodes/' + node.id + '/materials/scope/versions', { body: '变更后采用的第二版材料', ref_attachment_ids: [att] }, 201);
        await call(U.pm, 'PATCH', '/package-versions/' + change.version.id, { snapshot_json: { text: '变更后完整规划文字', material_version_ids: [m2.version.id] } });
        await post(U.pm, '/changes/' + change.change.id + '/submit'); await C.confirmAll(change.version.id);
        const latest = await sqlGet("SELECT v.id FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id WHERE p.project_id = ? AND p.type = 'overall' AND v.status = 'effective'", [pid]);
        assert.notStrictEqual(latest.id, vid);
        const current = await call(U.pm, 'GET', '/package-versions/' + latest.id);
        const old = await call(U.pm, 'GET', '/package-versions/' + vid);
        assert.strictEqual(current.snapshot_json.text, '变更后完整规划文字');
        assert.deepStrictEqual(current.snapshot_json.material_version_ids, [m2.version.id]);
        assert.strictEqual(current.materials[0].body, '变更后采用的第二版材料');
        assert.strictEqual(old.materials[0].body, '原总体材料正文');
        const frozen = await sqlGet("SELECT sha256 FROM sysbuild_frozen_attachments WHERE object_type = 'package_version' AND object_version_id = ? AND attachment_id = ?", [latest.id, att]);
        assert.strictEqual(frozen.sha256, '4'.repeat(64));
        const sheet = await api(U.pm, 'GET', '/sysbuild/package-versions/' + latest.id + '/confirmation-sheet');
        assert.strictEqual(sheet.status, 200, sheet.text);
        assert.ok(sheet.text.includes('变更后采用的第二版材料') && !sheet.text.includes('原总体材料正文'));
    });
    test('C8 窗口凭据读面：只返回本项目三种窗口事实与原始附件，读不写，遮蔽后状态与管理员复核一致', async () => {
        const pid = await C.newProject();
        const att = await stageFile(U.pm, pid);
        await post(U.pm, '/projects/' + pid + '/history-window', { action: 'open', reason: '核对历史原件后开放补录', attachment_ids: [att] });
        const other = await C.newProject();
        await post(U.pm, '/projects/' + other + '/history-window', { action: 'open', attachment_ids: [await C.stageAtt(other, U.pm, '5')] });
        const eventsBefore = (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_events', [])).n;
        const viewsBefore = await viewCount();
        const opened = await call(U.pm, 'GET', '/projects/' + pid + '/history-window/events');
        assert.strictEqual(opened.history_window, 'open');
        assert.strictEqual(opened.items.length, 1);
        assert.strictEqual(opened.items[0].reason, '核对历史原件后开放补录');
        assert.strictEqual(opened.items[0].attachments[0].attachment_id, att);
        assert.strictEqual(opened.actions.close, true);
        assert.strictEqual(opened.actions.confirm, true);
        const ro = await call(U.ro, 'GET', '/projects/' + pid + '/history-window/events');
        assert.deepStrictEqual(Object.values(ro.actions), Array(6).fill(false));
        assert.deepStrictEqual(ro.items, opened.items);
        assert.ok(!JSON.stringify(ro).includes('payload_json') && !JSON.stringify(ro).includes('file_name'));
        await call(U.out, 'GET', '/projects/' + pid + '/history-window/events', undefined, 404);
        assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_events', [])).n, eventsBefore);
        assert.strictEqual(await viewCount(), viewsBefore);
        await post(U.admin, '/projects/' + pid + '/status', { to: 'paused', reason: '核对暂停状态的历史能力' });
        const paused = await call(U.pm, 'GET', '/projects/' + pid + '/history-window/events');
        assert.strictEqual(paused.actions.import, true);
        assert.strictEqual(paused.actions.import_golive, false);
        await post(U.pm, '/projects/' + pid + '/history-window', { action: 'close', reason: '本轮补录已归档', attachment_ids: [await C.stageAtt(pid, U.pm, '6')] });
        await post(U.admin, '/projects/' + pid + '/history-window', { action: 'reopen', reason: '发现需要补齐的历史原件', attachment_ids: [await C.stageAtt(pid, U.admin, '7')] });
        await post(U.pm, '/attachments/' + att + '/mask', { reason: '窗口原始凭据含受控字段' });
        const masked = await call(U.ro, 'GET', '/projects/' + pid + '/history-window/events');
        assert.deepStrictEqual(masked.items.map((row) => row.action), ['reopen', 'close', 'open']);
        const evidence = masked.items.find((row) => row.action === 'open').attachments[0];
        assert.strictEqual(evidence.name, null);
        assert.strictEqual(evidence.mask_reason, '窗口原始凭据含受控字段');
        assert.strictEqual(evidence.masked_by, U.pm);
        assert.ok(evidence.masked_by_name && evidence.masked_at);
        const record = await call(U.admin, 'GET', '/attachments/' + att);
        assert.strictEqual(record.attachment.name, null);
        assert.strictEqual(record.attachment.actions.download, true);
        assert.strictEqual(record.attachment.actions.delete, false);
        const download = await api(U.admin, 'GET', '/sysbuild/attachments/' + att + '/download');
        assert.strictEqual(download.status, 200);
        assert.ok(download.headers.get('content-disposition').includes('attachment-' + att));
        assert.ok(!download.headers.get('content-disposition').includes('evidence'));
    });
    test('C8 登记与条目元数据：来源显式选项、本人提交固定声明、修订动作、提出人任务与知会详情同源', async () => {
        const pid = await C.newProject();
        const party = (await post(U.pm, '/projects/' + pid + '/parties', { side: 'dev', name: '开发合作方' }, 201)).party.id;
        const members = {};
        for (const uid of [U.own, U.del, U.m1]) {
            const joined = await post(U.pm, '/projects/' + pid + '/members', { user_id: uid, party_id: party }, 201);
            await post(uid, '/my/invitations/' + joined.invitation.id + '/accept'); members[uid] = joined.member.id;
        }
        const appointment = await post(U.pm, '/parties/' + party + '/appointments', { member_id: members[U.own] }, 201);
        await post(U.own, '/my/invitations/' + appointment.invitation.id + '/accept');
        const delegation = (await post(U.own, '/parties/' + party + '/delegations', { member_id: members[U.del] }, 201)).delegation.id;
        await post(U.del, '/delegations/' + delegation + '/accept');
        const meta = async (uid) => (await call(uid, 'GET', '/projects/' + pid + '/entries')).registration;
        const pm = await meta(U.pm);
        const owner = await meta(U.own);
        const representative = await meta(U.del);
        const ordinary = await meta(U.m1);
        assert.ok(pm.source_choices.some((source) => source.id === null) && pm.source_choices.some((source) => source.id === party));
        assert.strictEqual(pm.self_confirm.enabled, false);
        assert.strictEqual(owner.source_choices, null);
        assert.strictEqual(owner.self_confirm.enabled, true);
        assert.strictEqual(owner.self_confirm.text, '我已阅读以上全部内容，确认无误');
        assert.deepStrictEqual(owner.purposes, ['general', 'dev_note', 'deliverable']);
        assert.strictEqual(representative.self_confirm.enabled, false);
        assert.deepStrictEqual(ordinary.purposes, ['general']);
        const count = (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_entries', [])).n;
        const body = { type: 'note', purpose: 'dev_note', title: '负责人处理说明', body: '本版处理说明原文', no_written_evidence: true, no_evidence_reason: '当面提交的处理说明未另行形成独立书面材料' };
        await post(U.own, '/projects/' + pid + '/entries', body, 400);
        assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_entries', [])).n, count);
        const created = await post(U.own, '/projects/' + pid + '/entries', Object.assign({}, body, { self_confirm_text: owner.self_confirm.text }), 201);
        const ownEntry = (await call(U.own, 'GET', '/entries/' + created.entry.id)).entry;
        assert.strictEqual(ownEntry.dev_confirm.status, 'approved');
        const selfViews = await sqlAll("SELECT id FROM sysbuild_views WHERE source = 'self_submit' AND object_type = 'dev_entry' AND object_version_id = ?", [created.entry.id]);
        assert.strictEqual(selfViews.length, 1);
        const proposed = await post(U.del, '/projects/' + pid + '/entries', Object.assign({}, body, { title: '代表人提交的处理说明' }), 201);
        const pending = (await call(U.pm, 'GET', '/entries/' + proposed.entry.id)).entry;
        const task = await call(U.own, 'GET', '/confirm-tasks/' + pending.dev_confirm.task_id);
        assert.deepStrictEqual(task.allowed_decisions, ['confirm', 'reject']);
        await post(U.own, '/confirm-tasks/' + task.task.id + '/decide', { revision_id: task.revision.id, object_version_id: task.task.object_version_id, decision: 'reject', checkbox_text: '我已阅读以上全部内容，不认可（原因见下）', reason: '本版处理说明还需修订' });
        assert.strictEqual((await call(U.del, 'GET', '/entries/' + proposed.entry.id)).entry.actions.revise, true);
        assert.strictEqual((await call(U.m1, 'GET', '/entries/' + proposed.entry.id)).entry.actions.revise, false);
        const item = await post(U.pm, '/projects/' + pid + '/items', { content: '需要提出人核对的需求', proposer_member_id: members[U.own], no_written_evidence: true, no_evidence_reason: '来自当面讨论尚未形成独立书面原始材料' }, 201);
        const beforeViews = await viewCount();
        const list = await call(U.ro, 'GET', '/projects/' + pid + '/items');
        const version = list.items.find((row) => row.id === item.item.id).versions[0];
        assert.ok(version.proposer_display_name);
        assert.strictEqual(version.confirm_tasks.length, 1);
        assert.strictEqual(version.confirm_tasks[0].required_member_id, members[U.own]);
        assert.strictEqual(await viewCount(), beforeViews);
        const reference = await post(U.pm, '/projects/' + pid + '/entries', { type: 'feedback', title: '开发方一般反馈', body: '供后续讨论参考的意见', source_party_id: party }, 201);
        await post(U.pm, '/entries/' + reference.entry.id + '/actions', { action: 'for_reference', text: '暂作为讨论参考，保留异议入口' }, 201);
        const detail = (await call(U.pm, 'GET', '/entries/' + reference.entry.id)).entry;
        assert.strictEqual(detail.notices.length, 1);
        const notice = await call(U.del, 'GET', '/notices/' + detail.notices[0].id);
        assert.strictEqual(notice.notice.entry.title, '开发方一般反馈');
        assert.strictEqual(notice.notice.actions.object, true);
        await call(U.out, 'GET', '/notices/' + detail.notices[0].id, undefined, 404);
        assert.strictEqual(await viewCount(), beforeViews);
    });
}
const mu = (id, expect, file, from, to) => ({ id: 'C8 ' + id, expect: Array.isArray(expect) ? expect : [expect], edits: [{ file, from, to }] });
const STAGE8_MUTATIONS = [
    mu('材料权限放开非PM', 'C8 材料版本', 'rules.js', 'material_version_create: Object.freeze({ can: canActAsPm,', 'material_version_create: Object.freeze({ can: () => true,'),
    mu('材料收口状态放开', 'C8 材料版本', 'rules.js', "state: withFrozenBatch((t) => ['not_started', 'in_progress'].includes(t.nodeStatus) ? null : '节点已收口或取消，不能直接追加候选材料版本，请先按权限重开节点')", 'state: () => null'),
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
    mu('普通提交漏冻结材料', 'C8 材料引用', 'confirm.js', 'await materialsCore.freezeSelectedMaterials(q, { projectId: pid, versionId: vid, operatorId: opId, operatorName: opName });', 'void vid;'),
    mu('材料生效漏核冻结完整性', 'C8 材料冻结兜底', 'confirm-core.js', 'async function applyPackageEffect(q, user, projectId, pkg, ver, o) {\n  await materialsCore.assertMaterialFreezes(q, projectId, ver);', 'async function applyPackageEffect(q, user, projectId, pkg, ver, o) {'),
    mu('旧通知任务GET不核修订', 'C8 通知修订', 'confirm.js', "if (expectedRevision !== null && expectedRevision !== undefined && expectedRevision !== c.latest.id) throw makeError(409, 'SYSBUILD_TASK_SUPERSEDED', '任务修订已变化，请明确重新打开当前任务');", "if (false) throw makeError(409, 'SYSBUILD_TASK_SUPERSEDED', '任务修订已变化，请明确重新打开当前任务');"),
    mu('通知只核第一次读锁', 'C8 通知读写交错', 'confirm.js', 'if (expectedRevision !== null && expectedRevision !== undefined && expectedRevision !== c.latest.id)', 'if (!record && expectedRevision !== null && expectedRevision !== undefined && expectedRevision !== c.latest.id)'),
    mu('旧页面改发不核修订', 'C8 通知修订', 'confirm.js', "if (expectedRevision !== null && expectedRevision !== c.latest.id) throw makeError(409, 'SYSBUILD_TASK_SUPERSEDED', '任务修订已变化，请重新打开后再改发');", "if (false) throw makeError(409, 'SYSBUILD_TASK_SUPERSEDED', '任务修订已变化，请重新打开后再改发');"),
    mu('通知定位伪称当前', 'C8 通知修订', 'confirm.js', 'is_current: revision.id === c.latest.id,', 'is_current: true,'),
    mu('确认遗漏必需确认人名', 'C8 通知修订', 'confirm.js', 'required_name: await entriesCore.memberNameOf(q, c.latest.required_member_id)', 'required_name: null'),
    mu('确认误给决策选项', 'C8 通知修订', 'confirm.js', 'allowed_decisions: hasKey(ENTRY_TASK_DECISIONS, c.task.purpose) ? ENTRY_TASK_DECISIONS[c.task.purpose] : Object.keys(DECISIONS),', "allowed_decisions: ['confirm'],"),
    mu('确认遗漏导出能力', 'C8 通知修订', 'confirm.js', "body.actions.export_sheet = c.obj.kind === 'package_version' && rules.canExportConfirmationSheet(c.access, c.obj.ver);", 'body.actions.export_sheet = false;'),
    mu('任务读漏身份对象可见性', 'C8 确认对象可见性', 'confirm.js', 'if (!(await visibility.taskVisible(q, identity, task))) throw rules.notFound();', 'if (false) throw rules.notFound();'),
    mu('原始凭据下载预览漏父对象可见性', 'C8 确认对象可见性', 'attachments.js', 'if (!(await visibility.attachmentVisible(q, identity, att.project_id, att.id))) throw rules.notFound();\n      if (att.deleted_at)', 'if (false) throw rules.notFound();\n      if (att.deleted_at)'),
    mu('原始凭据记录漏父对象可见性', 'C8 确认对象可见性', 'attachments.js', 'if (!(await visibility.attachmentVisible(q, identity, att.project_id, att.id))) throw rules.notFound();\n      const frozen', 'if (false) throw rules.notFound();\n      const frozen'),
    mu('未接受授权对所有成员可见', 'C8 确认对象可见性', 'membership-visibility.js', "row.status === 'active' || (mineOf(identity, row) && row.status === 'pending_accept') || ownerSees", "row.status === 'active' || row.status === 'pending_accept' || ownerSees"),
    mu('确认单漏材料正文', 'C8 材料引用', 'confirmation-sheet.js', "${m.materials.length ? section('sec-materials', '引用材料版本全文', m.materials.map(renderMaterial)) : ''}", ''),
    mu('历史生效漏冻结材料', 'C8 历史材料导入', 'history.js', 'await materialsCore.freezeSelectedMaterials(q, { projectId: pid, versionId: ver.id, operatorId: uid, operatorName: opName });', 'void ver.id;'),
    mu('历史确认漏录入人姓名', 'C8 历史材料导入', 'confirm-core.js', '(SELECT COALESCE(u.display_name, u.username) FROM users u WHERE u.id = c.proxy_by) AS proxy_by_name', 'NULL AS proxy_by_name'),
    mu('历史导入漏录入人姓名', 'C8 历史材料导入', 'confirm-core.js', '(SELECT COALESCE(u.display_name, u.username) FROM users u WHERE u.id = h.imported_by) AS imported_by_name', 'NULL AS imported_by_name'),
    mu('变更派生漏材料快照', 'C8 变更材料链', 'confirm-core.js', '[overallPkg.id, maxNo.n + 1, oldEff.form, verRow.effective_at, verRow.snapshot_json, Number(user.id)]', "[overallPkg.id, maxNo.n + 1, oldEff.form, verRow.effective_at, '{}', Number(user.id)]"),
    mu('变更派生漏冻结复制', 'C8 变更材料链', 'confirm-core.js', "await q.run('INSERT INTO sysbuild_frozen_attachments (object_type, object_version_id, attachment_id, sha256) VALUES (?, ?, ?, ?)', ['package_version', newId, f.attachment_id, f.sha256]);", 'void f.attachment_id;'),
    mu('窗口凭据跨项目返回', 'C8 窗口凭据读面', 'history.js', "WHERE project_id = ? AND event_type IN ('history_window_opened'", "WHERE (project_id = ? OR 1 = 1) AND event_type IN ('history_window_opened'"),
    mu('窗口读漏原始凭据', 'C8 窗口凭据读面', 'history.js', 'attachments: await core.attachmentView(q, bound)', 'attachments: []'),
    mu('暂停项目仍标可导入上线', 'C8 窗口凭据读面', 'history.js', 'import_golive: canImport && rules.goliveImportProjectBlock(project.status) === null', 'import_golive: canImport'),
    mu('登记来源选项遗漏PM本人', 'C8 登记与条目元数据', 'entries.js', "[{ id: null, label: 'PM 本人登记' }, ...", '[...'),
    mu('登记遗漏本人确认提示', 'C8 登记与条目元数据', 'entries.js', 'enabled: selfConfirm,', 'enabled: false,'),
    mu('登记固定声明文案错误', 'C8 登记与条目元数据', 'entries.js', "text: core.checkboxTextsOf('dev_key_confirm').confirm", "text: '错误的声明'"),
    mu('登记不提供修订动作', 'C8 登记与条目元数据', 'entries.js', "actions.revise = devConfirm.status === 'not_approved' && sourceMatches && canCreate && purposeAllowed;", 'actions.revise = false;'),
    mu('条目元数据漏提出人任务', 'C8 登记与条目元数据', 'items.js', 'confirm_tasks: proposerTasks.map((task) => ({ task_id: task.task_id, revision_id: task.revision_id, rev_no: task.rev_no, status: task.status, required_member_id: task.required_member_id, required_name: task.required_name, proxy_only: task.required_user_id === null })),', 'confirm_tasks: [],'),
    mu('知会详情绕过项目可见性', 'C8 登记与条目元数据', 'entries.js', 'const { access, identity } = await loadProjectCtx(q, notice.project_id, req.user);', 'const access = await rules.loadProjectAccess(q, notice.project_id, req.user, accessOpts()); const identity = await rules.completeIdentity(q, access, req.user);'),
    mu('材料维护类别误作身份类', 'rules：OP_KIND 与状态表', 'rules.js', "material_version_create: 'maintain',", "material_version_create: 'membership',"),
];
module.exports = { defineStage8Cases, STAGE8_MUTATIONS };
