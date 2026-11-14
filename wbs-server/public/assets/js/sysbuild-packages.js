/* 内容包版本、条目集合、正式变更、确认任务与归档确认单。 */
(function () {
    'use strict';
    const A = window.SysBuildUI;
    const names = { initiation: '立项与授权', overall: '总体范围与批次规划', batch_req: '批次需求', batch_accept: '批次验收', change: '正式变更', closing: '整体验收结项' };
    const states = { draft: '草稿', pending: '待确认', effective: '已生效', superseded: '已被替代', withdrawn: '已撤回' };
    const revisionStates = { pending: '待确认', confirmed: '已确认', objected: '有异议', rejected: '不认可', invalid: '已失效', superseded: '已被替代' };
    const prose = (s) => A.el('div', 'sbui-longtext', s || '未填写');
    function defaultBatch() {
        const batch = A.state.plan.batches.find((b) => b.is_default === true);
        if (!batch) throw new Error('默认交付安排未就绪，请先核对项目结构');
        return batch;
    }
    async function createPackage(detail, type, c) {
        const body = { type };
        if (type === 'batch_accept') body.batch_id = defaultBatch().id;
        const created = await A.request('/projects/' + detail.project.id + '/packages', { method: 'POST', body }, c);
        const result = await A.request('/packages/' + created.package.id + '/versions', { method: 'POST', body: {} }, c);
        A.navigate({ project: detail.project.id, tab: 'packages', version: result.version.id });
    }
    function changeForm(detail, entries, c) {
        A.assertCurrent(c);
        const form = A.dialog('建立正式变更', [
            { name: 'title', label: '变更标题', required: true, max: 100, full: true },
            { name: 'body', label: '为什么改、改什么', type: 'textarea', required: true, max: 4000, full: true },
            { name: 'scope', label: '对范围的影响', type: 'textarea', max: 2000, full: true },
            { name: 'schedule', label: '对排期的影响', type: 'textarea', max: 2000, full: true },
            { name: 'acceptance', label: '对验收的影响', type: 'textarea', max: 2000, full: true },
            { name: 'from_entry_ids', label: '引用的意见 / 问题登记（可选）', type: 'checklist', options: entries.filter((e) => ['feedback', 'issue'].includes(e.type)).map((e) => [e.id, '#' + e.id + ' ' + e.title]), full: true },
            { name: 'files', label: '变更依据附件 / 截图', type: 'file', multiple: true, full: true },
            { name: 'no_written_evidence', label: '确无书面证据', type: 'checkbox' },
            { name: 'no_evidence_reason', label: '无书面证据原因', type: 'textarea', max: 500, full: true, hint: '与证据附件二选一，原因至少10个字。' },
        ], async (v, cc) => {
            if (v.no_written_evidence && v.files.length) throw new Error('证据附件与无书面证据声明应二选一');
            const attachment_ids = await A.stageFiles(detail.project.id, v.files, cc);
            const affects = Object.fromEntries(['scope', 'schedule', 'acceptance'].filter((key) => v[key].trim()).map((key) => [key, v[key]]));
            const body = { title: v.title, body: v.body, affects, from_entry_ids: (v.from_entry_ids || []).map(A.id), attachment_ids, ...A.evidencePayload(v) };
            const made = await A.request('/projects/' + detail.project.id + '/changes', { method: 'POST', body }, cc);
            A.navigate({ project: detail.project.id, tab: 'packages', version: made.version.id });
        }, '建立变更与草稿');
        form.prepend(A.hint('变更从现行总体规划继承完整条目集合。建立后仍须编辑草稿、发起确认并全部通过，才会形成新的执行依据。'));
    }
    async function addItemToVersion(detail, data, c) {
        const lease = A.reserveDialog(c);
        const items = await A.request('/projects/' + detail.project.id + '/items', null, lease);
        A.assertCurrent(lease);
        const existing = new Set(data.items.map((item) => item.item_id));
        const choices = items.items.filter((item) => !existing.has(item.id)).flatMap((item) => item.versions.map((version) => [version.id, item.code + ' · v' + version.version_no + ' · ' + version.content.slice(0, 80)]));
        if (!choices.length) throw new Error('没有可加入的条目版本；如需换版，请先移出原条目，再加入指定的新版本');
        A.dialog('向本版加入需求条目', [{ name: 'item_version_id', label: '明确选择条目版本', required: true, options: [['', '请选择本次拟确认的版本'], ...choices] }], async (v, cc) => {
            await A.request('/package-versions/' + data.version.id + '/items', { method: 'POST', body: { op: 'add', item_version_id: A.id(v.item_version_id), committed_batch_id: defaultBatch().id } }, cc);
            await A.render();
        }, '加入本版集合', lease);
    }
    function withdrawVersion(data, c) {
        A.assertCurrent(c);
        A.dialog('撤回本版确认 · v' + data.version.version_no, [{ name: 'reason', label: '撤回原因', type: 'textarea', required: true, max: 500, full: true }], async (v, cc) => { await A.request('/package-versions/' + data.version.id + '/withdraw', { method: 'POST', body: { reason: v.reason } }, cc); await A.render(); }, '撤回本版确认');
    }
    async function packageVersion(detail, versionId, c) {
        const data = await A.request('/package-versions/' + versionId, null, c);
        if (Number(data.package.project_id) !== Number(detail.project.id)) throw new Error('该内容包版本不属于当前项目');
        const host = A.el('div');
        host.appendChild(A.row(A.link('返回内容包与正式变更', { project: detail.project.id, tab: 'packages' })));
        const controls = A.row();
        let editForm = null;
        const savedText = data.snapshot_json.text || '';
        const savedMaterials = (data.snapshot_json.material_version_ids || []).map(String).sort();
        function assertSavedDraft() {
            if (!editForm) return;
            const text = editForm.querySelector('[name="text"]').value;
            const materials = Array.from(editForm.querySelectorAll('[name="material_version_ids[]"]:checked')).map((input) => input.value).sort();
            if (editForm.dataset.submitting === 'true' || text !== savedText || JSON.stringify(materials) !== JSON.stringify(savedMaterials)) throw new Error('有未保存的改动，请先保存本版草稿，或放弃改动后再发起确认。');
        }
        if (data.actions.submit === true) controls.appendChild(A.command('发起本版确认', async (cc) => { assertSavedDraft(); await A.request('/package-versions/' + data.version.id + '/submit', { method: 'POST', body: {} }, cc); await A.render(); }, 'primary', c));
        if (data.actions.withdraw === true) controls.appendChild(A.button('撤回本版确认', () => withdrawVersion(data, c)));
        if (data.actions.new_version === true) controls.appendChild(A.command('基于包的最新内容建立新草稿', async (cc) => { const made = await A.request('/packages/' + data.package.id + '/versions', { method: 'POST', body: {} }, cc); A.navigate({ project: detail.project.id, tab: 'packages', version: made.version.id }); }, '', c));
        host.appendChild(A.panel((names[data.package.type] || data.package.type) + ' v' + data.version.version_no + ' · ' + (states[data.version.status] || data.version.status), [A.facts([['形成时间', data.version.created_at], ['生效时间', data.version.effective_at], ['继承的总体版本', data.version.parent_overall_version_id ? '#' + data.version.parent_overall_version_id : '无']]), A.hint(data.version.status === 'draft' ? '先保存草稿，再发起本版确认。发起使用已保存的版本，不自动保存未提交的编辑。' : data.version.status === 'pending' ? '本版已提交，确认人按固定版本与冻结附件作决定。' : '保留该版原文与确认事实。后续新草稿不会覆盖此版。')], controls));
        host.appendChild(A.panel('本版确认内容', [A.snapshotView(data.snapshot_json)]));
        if (data.actions.edit === true) {
            const materials = await A.request('/projects/' + detail.project.id + '/materials', null, c);
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
        const items = A.panel('本版条目集合', [A.hint('条目版本与承诺交付安排在服务端提交时重核。替换版本须先移出旧版，再明确加入新版本。')], data.actions.add_item === true ? A.command('加入需求条目', () => addItemToVersion(detail, data, c), '', c) : null);
        items.appendChild(A.table(['条目', '明确引用版本', '操作'], data.items.map((item) => [item.code, 'v' + item.version_no, data.actions.remove_item === true ? A.command('从本版移出', async (cc) => { await A.request('/package-versions/' + data.version.id + '/items', { method: 'POST', body: { op: 'remove', item_version_id: item.item_version_id } }, cc); await A.render(); }, '', c) : '—'])));
        host.appendChild(items);
        for (const m of data.materials || []) host.appendChild(A.panel('本版引用材料 · ' + m.name + ' v' + m.version_no, [prose(m.body), A.attachmentList(m.attachments, c)]));
        const tasks = await A.request('/package-versions/' + data.version.id + '/confirm-tasks', null, c);
        host.appendChild(A.panel('各方确认任务（打开前不记录浏览）', [A.table(['参与方', '必需确认人', '当前修订状态', '操作'], tasks.tasks.map((task) => [task.party_name || '—', task.required_name + (task.proxy_only ? ' · 仅凭据代录' : ''), revisionStates[task.current_revision.status] || task.current_revision.status, A.link('明确打开确认全文', { task: task.task_id, revision_id: task.current_revision.id })]))]));
        if (data.actions.export_sheet === true) {
            const sheetHost = A.el('div');
            host.appendChild(A.panel('归档确认单', [A.command('加载确认单预览', async (cc) => { const sheet = await A.confirmationSheetFrame(data.version.id, cc); A.assertCurrent(cc); sheetHost.replaceChildren(sheet); }, '', c), sheetHost]));
        }
        if ((data.history_confirmations || []).length) host.appendChild(A.disclosure('历史补录确认（不代替当前任务）', data.history_confirmations.map((r) => A.panel((r.actual_confirmer || '历史确认人') + ' · ' + r.external_date, [prose(r.identity_basis), A.attachmentList(r.attachments, c)]))));
        if ((data.history_imports || []).length) host.appendChild(A.disclosure('历史事实导入记录', data.history_imports.map((r) => A.panel((r.fact_type_label || '已导入历史事实') + ' · ' + r.original_date, [prose(r.identity_basis), A.attachmentList(r.attachments, c)]))));
        return host;
    }
    async function packagesTab(detail, params, c) {
        if (params.has('version')) return packageVersion(detail, A.id(params.get('version')), c);
        const [data, changes, entries] = await Promise.all([
            A.request('/projects/' + detail.project.id + '/packages', null, c), A.request('/projects/' + detail.project.id + '/changes', null, c), A.request('/projects/' + detail.project.id + '/entries', null, c),
        ]);
        const host = A.el('div');
        const controls = A.row(...data.actions.create_package_types.filter((type) => type !== 'batch_req').map((type) => A.command('建立' + (names[type] || type) + '草稿', (cc) => createPackage(detail, type, cc), '', c)));
        if (changes.actions.create_change === true) controls.appendChild(A.button('建立正式变更', () => changeForm(detail, entries.entries, c), 'primary'));
        host.appendChild(A.panel('内容包与正式变更', [A.hint('当前执行内容以生效总体规划及其明确引用的条目、材料版本为准；候选新版本等待确认后才生效。'), A.hint('正式上线后，第一期已上线条目不能新增、替换版本或移入。即使条目集合未改变，变更生效仍会生成新的总体规划版本，并要求验收、结项重新确认。')], controls));
        for (const pkg of data.packages.filter((p) => p.type !== 'change')) {
            const part = A.panel(names[pkg.type] || pkg.type, null, pkg.actions.new_version === true ? A.command('建立新草稿版本', async (cc) => { const made = await A.request('/packages/' + pkg.id + '/versions', { method: 'POST', body: {} }, cc); A.navigate({ project: detail.project.id, tab: 'packages', version: made.version.id }); }, '', c) : null);
            part.appendChild(A.table(['版本', '状态', '生效时间', '操作'], pkg.versions.slice().reverse().map((v) => ['v' + v.version_no, states[v.status] || v.status, v.effective_at || '—', A.link('查看该版原文与任务', { project: detail.project.id, tab: 'packages', version: v.id })])));
            host.appendChild(part);
        }
        for (const ch of changes.changes) {
            const controls = A.row();
            if (ch.actions.new_version === true) controls.appendChild(A.button('基于现行规划重建变更草稿', () => { A.assertCurrent(c); const form = A.dialog('重建变更草稿 · #' + ch.id, [{ name: 'reason', label: '重建原因', type: 'textarea', required: true, max: 500, full: true }], async (v, cc) => { const made = await A.request('/changes/' + ch.id + '/new-version', { method: 'POST', body: { reason: v.reason } }, cc); A.navigate({ project: detail.project.id, tab: 'packages', version: made.version.id }); }, '保留旧版并重建草稿'); form.prepend(A.hint('新草稿从此刻生效的总体规划继承完整内容，不沿用被异议的旧草稿。')); }));
            const part = A.panel('正式变更 #' + ch.id + ' · ' + ch.title + ' · ' + (states[ch.status] || ch.status), [prose(ch.body), A.disclosure('本次影响说明', A.snapshotView(ch.affects)), ch.no_written_evidence ? A.hint('无书面证据：' + ch.no_evidence_reason) : null, A.attachmentList(ch.attachments, c), A.row(...ch.from_entry_ids.map((id) => A.link('来源登记 #' + id, { project: detail.project.id, tab: 'entries', entry: id })))], controls);
            part.appendChild(A.table(['变更版本', '状态', '操作'], ch.versions.slice().reverse().map((v) => ['v' + v.version_no, states[v.status] || v.status, A.link('查看本版、保存草稿或发起确认', { project: detail.project.id, tab: 'packages', version: v.id })])));
            host.appendChild(part);
        }
        return host;
    }
    async function overview(detail, params, c) {
        const data = await A.request('/projects/' + detail.project.id + '/packages', null, c);
        const host = A.el('div');
        host.appendChild(A.panel('当前已确认依据', [A.table(['内容包', '生效版本', '操作'], data.packages.flatMap((p) => p.versions.filter((v) => v.status === 'effective').map((v) => [names[p.type] || p.type, 'v' + v.version_no, A.link('查看生效原文', { project: detail.project.id, tab: 'packages', version: v.id })]))), A.row(A.link('整理需求条目', { project: detail.project.id, tab: 'items' }), A.link('核对材料版本', { project: detail.project.id, tab: 'materials' }), A.link('查看内容包与正式变更', { project: detail.project.id, tab: 'packages' }))]));
        host.appendChild(A.panel('节点推进', [A.table(['节点', '环节', '状态', '当前计划', '操作'], A.state.plan.nodes.map((n) => [n.name, n.g_stage || '—', A.nodeLabels[n.status] || n.status, n.current_plan ? n.current_plan.start + ' → ' + n.current_plan.end : '未设计划', A.link('查看排期与收口', { project: detail.project.id, tab: 'plan', node: n.id })])), A.row(A.link('登记与办理', { project: detail.project.id, tab: 'entries' }), A.link('核对上线交接', { project: detail.project.id, tab: 'handover' }), A.link('继续需求方设置与 G0 核对', { project: detail.project.id, tab: 'setup', step: '2' }))]));
        return host;
    }
    A.registerTab('packages', '内容包与变更', packagesTab);
    A.registerTab('overview', '节点与材料', overview);
}());
