/* 内容包版本、确认任务与归档确认单。 */
(function () {
    'use strict';
    const A = window.SysBuildUI;
    const names = { initiation: '立项与授权', overall: '总体范围与批次规划', batch_accept: '批次验收', closing: '整体验收结项' };
    const states = { draft: '草稿', pending: '待确认', effective: '已生效', superseded: '已被替代', withdrawn: '已撤回' };
    const revisionStates = { pending: '待确认', confirmed: '已确认', objected: '有异议', rejected: '不认可', invalid: '已失效', superseded: '已被替代' };
    const prose = (s) => A.el('div', 'sbui-longtext', s || '未填写');
    const usableMaterialVersion = (version) => (version.attachments || []).every((a) => !a.masked && !a.deleted && !a.missing);
    const latestUsableVersion = (material) => material && material.versions.filter((v) => v.attachments.length > 0 && usableMaterialVersion(v)).sort((a, b) => b.version_no - a.version_no)[0];
    function basisMaterial(materials) {
        const node = A.state.plan.nodes.find((n) => n.template_key === 'p_initiation' && n.batch_id === null);
        return node && materials.materials.find((m) => m.node_id === node.id && m.material_key === 'initiation-basis');
    }
    async function createInitiationVersion(detail, packageId, c) {
        const created = await A.request('/packages/' + packageId + '/versions', { method: 'POST', body: {} }, c);
        let warning = null;
        try {
            const [v, materials] = await Promise.all([A.request('/package-versions/' + created.version.id, null, c), A.request('/projects/' + detail.project.id + '/materials', null, c)]);
            const material = basisMaterial(materials);
            const latest = latestUsableVersion(material);
            if (latest) {
                const oldIds = new Set(material.versions.map((x) => x.id));
                const ids = (v.snapshot_json.material_version_ids || []).filter((id) => !oldIds.has(id));
                ids.push(latest.id);
                await A.request('/package-versions/' + v.version.id, { method: 'PATCH', body: { snapshot_json: { ...v.snapshot_json, material_version_ids: ids } } }, c);
            }
        } catch (err) {
            if (err.stale || err.name === 'AbortError' || !A.valid(c)) throw err;
            warning = '立项依据未能自动选入。已保留立项草稿，请在草稿中补选后保存。';
        }
        return { ...created, warning };
    }
    function initiationEditor(detail, v, materials, c) {
        const saved = v.snapshot_json || {};
        const chosen = (saved.material_version_ids || []).map(Number);
        const choices = materials.materials.flatMap((m) => m.versions.map((version) => [version.id, m.name + ' · v' + version.version_no + (!usableMaterialVersion(version) ? ' · 含不可用附件，请替换' : '')]));
        const offered = new Set(choices.map(([id]) => id));
        const preserved = chosen.filter((id) => !offered.has(id));
        const defs = [
            { name: 'text', label: '本版确认正文', type: 'textarea', max: 12000, full: true, value: saved.text || detail.project.goal || '' },
            { name: 'material_version_ids', label: '本版明确引用的材料版本', type: 'checklist', options: choices, value: chosen, full: true, hint: '选入结果以保存后的版本快照为准。同一材料只能选一版。' },
        ];
        const form = A.form(defs, async (values, cc) => {
            const snapshot = { ...v.snapshot_json, text: values.text, material_version_ids: [...preserved, ...(values.material_version_ids || []).map(A.id)] };
            delete snapshot.no_written_basis_reason;
            await A.request('/package-versions/' + v.version.id, { method: 'PATCH', body: { snapshot_json: snapshot } }, cc);
            await A.render();
        }, '保存本版草稿', c, '');
        if (v.basis_declaration) form.prepend(A.panel('无书面依据', [A.el('div', 'sbui-longtext', v.basis_declaration)]));
        if (!saved.text && detail.project.goal) form.prepend(A.hint('正文已预填项目目标，请核对并保存本版草稿。'));
        const normalize = (text, ids) => JSON.stringify({ text: String(text || ''), ids: Array.from(new Set(ids.map(Number))).sort((a, b) => a - b) });
        const savedState = normalize(saved.text, chosen);
        form.sbuiAssertSaved = () => {
            const selected = Array.from(form.querySelectorAll('[name="material_version_ids[]"]:checked')).map((input) => Number(input.value));
            const current = normalize(form.querySelector('[name="text"]').value, [...preserved, ...selected]);
            if (form.dataset.submitting === 'true' || current !== savedState) throw new Error('有未保存的改动，请先保存本版草稿，或放弃改动后再发起确认。');
        };
        const basis = basisMaterial(materials);
        const latest = latestUsableVersion(basis);
        if (latest && !basis.versions.some((x) => chosen.includes(x.id))) {
            const add = A.command('选入最新立项依据', async (cc) => {
                if (form.dataset.submitting === 'true') { A.notice('正在保存本版内容，请等待完成后再补选。'); return; }
                const input = form.querySelector('[name="material_version_ids[]"][value="' + latest.id + '"]');
                // 草稿未改动时直接补选并保存；已有编辑保留在表单里，仍由“保存”统一提交。
                const selected = Array.from(form.querySelectorAll('[name="material_version_ids[]"]:checked')).map((x) => Number(x.value));
                const current = normalize(form.querySelector('[name="text"]').value, [...preserved, ...selected]);
                if (current !== savedState) {
                    if (input) input.checked = true;
                    A.notice('已勾选最新立项依据，请保存本版内容后再发起确认。');
                    return;
                }
                const fresh = await A.request('/package-versions/' + v.version.id, null, cc);
                const ids = Array.from(new Set([...(fresh.snapshot_json.material_version_ids || []), latest.id]));
                await A.request('/package-versions/' + v.version.id, { method: 'PATCH', body: { snapshot_json: { ...fresh.snapshot_json, material_version_ids: ids } } }, cc);
                await A.render();
            }, '', c);
            form.querySelector('.sbui-form-actions').prepend(add);
        }
        return form;
    }
    async function createVersion(detail, packageId, type, c) {
        const result = type === 'initiation'
            ? await createInitiationVersion(detail, packageId, c)
            : await A.request('/packages/' + packageId + '/versions', { method: 'POST', body: {} }, c);
        A.assertCurrent(c);
        const params = { project: detail.project.id, tab: 'packages', version: result.version.id };
        if (!result.warning) { A.navigate(params); return; }
        // 在同一次渲染中保留草稿和自动选材失败提示。
        history.replaceState(null, '', '#' + new URLSearchParams(params).toString());
        const route = location.hash;
        await A.render();
        if (A.state.session === c.session && A.state.userId === c.userId && A.state.token === c.token && location.hash === route) A.notice(result.warning, true);
    }
    async function createPackageDraft(detail, card, pkg, c) {
        let packageId = pkg?.id;
        if (!packageId) {
            const body = { type: card.key };
            if (card.key === 'batch_accept') body.batch_id = card.batch_id;
            const created = await A.request('/projects/' + detail.project.id + '/packages', { method: 'POST', body }, c);
            packageId = created.package.id;
        }
        await createVersion(detail, packageId, card.key, c);
    }
    function withdrawVersion(data, c) {
        A.assertCurrent(c);
        const title = '撤回本版确认';
        A.dialog(title + ' · v' + data.version.version_no, [{ name: 'reason', label: '撤回原因', type: 'textarea', required: true, max: 500, full: true }], async (v, cc) => { await A.request('/package-versions/' + data.version.id + '/withdraw', { method: 'POST', body: { reason: v.reason } }, cc); await A.render(); }, title);
    }
    async function packageVersion(detail, versionId, c) {
        const data = await A.request('/package-versions/' + versionId, null, c);
        if (Number(data.package.project_id) !== Number(detail.project.id)) throw new Error('该内容包版本不属于当前项目');
        const host = A.el('div');
        host.appendChild(A.row(A.link('返回对方确认', { project: detail.project.id, tab: 'packages' }),
            data.package.type === 'initiation' ? A.link('返回立项阶段', { project: detail.project.id, tab: 'plan', stage: 'initiation' }) : null));
        const controls = A.row();
        let editForm = null;
        const savedText = data.snapshot_json.text || '';
        const savedMaterials = (data.snapshot_json.material_version_ids || []).map(String).sort();
        function assertSavedDraft() {
            if (!editForm) return;
            if (editForm.sbuiAssertSaved) { editForm.sbuiAssertSaved(); return; }
            const text = editForm.querySelector('[name="text"]').value;
            const materials = Array.from(editForm.querySelectorAll('[name="material_version_ids[]"]:checked')).map((input) => input.value).sort();
            if (editForm.dataset.submitting === 'true' || text !== savedText || JSON.stringify(materials) !== JSON.stringify(savedMaterials)) throw new Error('有未保存的改动，请先保存本版草稿，或放弃改动后再发起确认。');
        }
        if (data.actions.submit === true) controls.appendChild(A.command('发起本版确认', async (cc) => { assertSavedDraft(); await A.request('/package-versions/' + data.version.id + '/submit', { method: 'POST', body: {} }, cc); await A.render(); }, 'primary', c));
        // 55 号 D1：不能发起时展示读接口给出的原因原文（与 actions.submit 同一判定）；无权限时服务端不给原因，这里也不显示。
        else if (data.version.status === 'draft' && data.submit_block && typeof data.submit_block.message === 'string') controls.appendChild(A.hint('当前不能发起确认：' + data.submit_block.message));
        if (data.actions.withdraw === true) controls.appendChild(A.button('撤回本版确认', () => withdrawVersion(data, c)));
        host.appendChild(A.panel((names[data.package.type] || data.package.type) + ' v' + data.version.version_no + ' · ' + (states[data.version.status] || data.version.status), [A.facts([['形成时间', data.version.created_at], ['生效时间', data.version.effective_at], ['继承的总体版本', data.version.parent_overall_version_id ? '#' + data.version.parent_overall_version_id : '无']]), A.hint(data.version.status === 'draft' ? '先保存草稿，再发起本版确认。发起使用已保存的版本，不自动保存未提交的编辑。' : data.version.status === 'pending' ? '本版已提交，确认人按固定版本与冻结附件作决定。' : '保留该版原文与确认事实。后续新草稿不会覆盖此版。')], controls));
        host.appendChild(A.panel('本版确认内容', [A.snapshotView(data.snapshot_json)]));
        if (data.submit_block?.pending_work?.length) host.appendChild(A.panel('待处理任务和意见', [
            A.row(...data.submit_block.pending_work.map((item) => A.work.itemLink(detail.project.id, item))),
        ]));
        if (data.scope_adjustments) host.appendChild(A.panel('确认之后的调整', [
            data.scope_adjustments.length ? A.table(['意见', '调整', '记录时间'], data.scope_adjustments.map((item) => [
                A.work.itemLink(detail.project.id, { kind: 'opinion', id: item.opinion_id, title: item.title }),
                item.outcome === 'cut_agreed' ? '同意本期移出范围' : '本期做 · 需求调整',
                item.resolved_at,
            ])) : A.hint('暂无调整。'),
        ]));
        if (data.actions.edit === true) {
            const materials = await A.request('/projects/' + detail.project.id + '/materials', null, c);
            if (data.package.type === 'initiation') {
                editForm = initiationEditor(detail, data, materials, c);
                host.appendChild(A.panel('编辑本版草稿', [editForm]));
            } else {
            const choices = materials.materials.flatMap((m) => m.versions.map((v) => [v.id, m.name + ' · v' + v.version_no + (v.attachments.some((a) => a.masked || a.deleted) ? ' · 含不可新增引用的附件，请替换' : '')]));
            const fields = [
                { name: 'text', label: '本版确认正文', type: 'textarea', max: 12000, value: data.snapshot_json.text || '', full: true },
                { name: 'material_version_ids', label: '本版明确引用的材料版本', type: 'checklist', options: choices, value: data.snapshot_json.material_version_ids || [], full: true, hint: '最多100个。同一材料只能选一版；被遮蔽的旧引用须明确替换或移除，不会在保存时自动删掉。' },
            ];
            editForm = A.form(fields, async (v, cc) => {
                await A.request('/package-versions/' + data.version.id, { method: 'PATCH', body: { snapshot_json: { ...data.snapshot_json, text: v.text, material_version_ids: (v.material_version_ids || []).map(A.id) } } }, cc); await A.render();
            }, '保存本版草稿', c);
            host.appendChild(A.panel('编辑本版草稿', [editForm]));
            }
        }
        for (const m of data.materials || []) host.appendChild(A.panel('本版引用材料 · ' + m.name + ' v' + m.version_no, [prose(m.body), A.attachmentList(m.attachments, c)]));
        const tasks = await A.request('/package-versions/' + data.version.id + '/confirm-tasks', null, c);
        host.appendChild(A.panel('各方确认任务（打开前不记录浏览）', [A.table(['参与方', '必需确认人', '当前修订状态', '操作'], tasks.tasks.map((task) => [task.party_name || '—', task.required_name, revisionStates[task.current_revision.status] || task.current_revision.status, A.link('明确打开确认全文', { task: task.task_id, revision_id: task.current_revision.id })]))]));
        if (data.actions.export_sheet === true) {
            const sheetHost = A.el('div');
            host.appendChild(A.panel('归档确认单', [A.command('加载确认单预览', async (cc) => { const sheet = await A.confirmationSheetFrame(data.version.id, cc); A.assertCurrent(cc); sheetHost.replaceChildren(sheet); }, '', c), sheetHost]));
        }
        return host;
    }
    async function packagesTab(detail, params, c) {
        if (params.has('version')) return packageVersion(detail, A.id(params.get('version')), c);
        const data = await A.request('/projects/' + detail.project.id + '/packages', null, c);
        const host = A.el('div');
        host.appendChild(A.panel('对方确认', [A.hint('已保存的版本与确认记录在此查阅，发起新确认请进入对应阶段。')]));
        for (const pkg of data.packages) {
            const part = A.panel(names[pkg.type] || pkg.type);
            part.appendChild(A.table(['版本', '状态', '生效时间', '操作'], pkg.versions.slice().reverse().map((v) => ['v' + v.version_no, states[v.status] || v.status, v.effective_at || '—', A.link('查看该版原文与任务', { project: detail.project.id, tab: 'packages', version: v.id })])));
            host.appendChild(part);
        }
        return host;
    }
    async function overview(detail, params, c) {
        const data = await A.request('/projects/' + detail.project.id + '/packages', null, c);
        const host = A.el('div');
        host.appendChild(A.panel('当前已确认依据', [A.table(['内容包', '生效版本', '操作'], data.packages.flatMap((p) => p.versions.filter((v) => v.status === 'effective').map((v) => [names[p.type] || p.type, 'v' + v.version_no, A.link('查看生效原文', { project: detail.project.id, tab: 'packages', version: v.id })]))), A.row(A.link('核对材料版本', { project: detail.project.id, tab: 'materials' }), A.link('查看内容包', { project: detail.project.id, tab: 'packages' }))]));
        host.appendChild(A.panel('节点推进', [A.table(['节点', '环节', '状态', '当前计划', '操作'], A.state.plan.nodes.map((n) => [n.name, n.g_stage || '—', A.nodeLabels[n.status] || n.status, n.current_plan ? n.current_plan.start + ' → ' + n.current_plan.end : '未设计划', A.link('查看排期与收口', { project: detail.project.id, tab: 'plan', node: n.id })])), A.row(A.link('登记与办理', { project: detail.project.id, tab: 'entries' }), A.link('核对上线前置', { project: detail.project.id, tab: 'handover' }))]));
        return host;
    }
    A.registerTab('packages', '对方确认', packagesTab);
    A.createPackageDraft = createPackageDraft;
    A.registerTab('overview', '节点与材料', overview);
}());
