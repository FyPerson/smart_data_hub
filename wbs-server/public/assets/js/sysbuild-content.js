/* 需求条目与候选材料；现行依据消费服务端明确引用的版本。 */
(function () {
    'use strict';
    const A = window.SysBuildUI;
    const proposerStates = { pending: '待提出人确认', confirmed: '提出人已确认', proxy_confirmed: '凭据代录确认', denied: '提出人否认' };
    const versionStates = { draft: '草稿', pending: '待确认', effective: '已生效', superseded: '已被替代' };
    const packageTypes = { initiation: '立项', overall: '总体规划', batch_req: '批次需求', batch_accept: '批次验收', closing: '整体验收结项', change: '正式变更' };
    const prose = (s) => A.el('div', 'sbui-longtext', s || '未填写');
    const uniqueAttachments = (versions) => Array.from(new Map(versions.flatMap((v) => v.attachments || []).map((att) => [att.attachment_id, att])).values());
    function evidenceFields(previous, versions) {
        const attachments = uniqueAttachments(versions || []);
        return [
            { name: 'files', label: '新上传的原始证据 / 截图', type: 'file', multiple: true, full: true },
            ...(versions ? [{ name: 'ref_attachment_ids', label: '从旧版本沿用的附件', type: 'checklist', value: (previous.attachments || []).filter((a) => !a.masked && !a.deleted).map((a) => a.attachment_id), options: attachments.filter((a) => !a.masked && !a.deleted).map((a) => [a.attachment_id, a.name || a.original_name || '附件 #' + a.attachment_id]), full: true }] : []),
            { name: 'no_written_evidence', label: '确无书面证据', type: 'checkbox', value: previous && previous.no_written_evidence === true },
            { name: 'no_evidence_reason', label: '无书面证据原因', type: 'textarea', max: 500, value: previous && previous.no_evidence_reason || '', full: true, hint: '证据附件与声明二选一；声明原因至少10个字。' },
        ];
    }
    async function itemForm(detail, data, item, c) {
        A.assertCurrent(c);
        const previous = item ? item.versions[item.versions.length - 1] : {};
        const defs = [
            { name: 'content', label: '本版需求全文', type: 'textarea', required: true, max: 4000, value: previous.content || '', full: true },
            { name: 'quote_text', label: '提出人原话要点', type: 'textarea', max: 2000, value: previous.quote_text || '', full: true },
            { name: 'proposer_mode', label: '提出人记录方式', value: item ? 'inherit' : '', required: true, options: [['', '请明确选择'], ...(item ? [['inherit', '沿用上版提出人事实']] : []), ['member', '选择本项目已加入成员'], ['name', '记录无账号提出人的姓名']] },
            { name: 'proposer_member_id', label: '提出人成员', options: [['', '请选择'], ...detail.members.filter((m) => m.status === 'joined').map((m) => [m.id, m.name])] },
            { name: 'proposer_name', label: '无账号提出人姓名', max: 60 },
            { name: 'proposer_party_id', label: '无账号提出人所属方（可选）', options: [['', '未记录'], ...detail.parties.map((p) => [p.id, p.name])] },
            { name: 'occasion', label: '提出场合', max: 200, value: previous.occasion || '' },
            { name: 'proposed_on', label: '提出日期', type: 'date', value: previous.proposed_on || '' },
        ];
        if (!item) defs.push({ name: 'module_id', label: '所属模块（可选）', options: [['', '尚未归属模块'], ...data.modules.map((m) => [m.id, m.name])] });
        defs.push(...evidenceFields(previous, item ? item.versions : null));
        const form = A.dialog(item ? item.code + ' 追加新版本' : '登记需求条目', defs, async (v, cc) => {
            const refIds = (v.ref_attachment_ids || []).map(A.id);
            if (v.no_written_evidence && v.files.length + refIds.length > 0) throw new Error('证据附件与无书面证据声明应二选一');
            const attachment_ids = await A.stageFiles(detail.project.id, v.files, cc);
            const body = { content: v.content, quote_text: v.quote_text || null, occasion: v.occasion || null, proposed_on: v.proposed_on || null, attachment_ids, ...A.evidencePayload(v) };
            if (!item) body.module_id = v.module_id ? A.id(v.module_id) : null;
            if (item) body.ref_attachment_ids = refIds;
            if (v.proposer_mode === 'member') body.proposer_member_id = A.id(v.proposer_member_id);
            else if (v.proposer_mode === 'name') { body.proposer_name = v.proposer_name; if (v.proposer_party_id) body.proposer_party_id = A.id(v.proposer_party_id); }
            else if (!item || v.proposer_mode !== 'inherit') throw new Error('请明确选择提出人记录方式');
            const result = await A.request(item ? '/items/' + item.id + '/versions' : '/projects/' + detail.project.id + '/items', { method: 'POST', body }, cc);
            A.navigate({ project: detail.project.id, tab: 'items', item: result.item.id });
        }, item ? '保存新版本并保留旧版' : '保存条目');
        form.prepend(A.hint('保存后按提出人资格生成相应任务；保存本身不代表提出人已确认。新版本不会直接替换生效总体规划中的执行依据。'));
        const mode = form.querySelector('[name="proposer_mode"]');
        const update = () => {
            const map = { proposer_member_id: mode.value === 'member', proposer_name: mode.value === 'name', proposer_party_id: mode.value === 'name' };
            Object.entries(map).forEach(([key, shown]) => { const input = form.querySelector('[name="' + key + '"]'); input.closest('label').hidden = !shown; input.required = shown && key !== 'proposer_party_id'; });
        };
        mode.addEventListener('change', update); update();
    }
    async function itemsTab(detail, params, c) {
        const data = await A.request('/projects/' + detail.project.id + '/items', null, c);
        const host = A.el('div');
        const ops = A.row();
        if (data.actions.create_item === true) ops.appendChild(A.button('登记需求条目', () => itemForm(detail, data, null, c)));
        if (data.actions.create_module === true) ops.appendChild(A.button('添加模块', () => { A.assertCurrent(c); A.dialog('添加需求模块', [{ name: 'name', label: '模块名称', required: true, max: 60 }], async (v, cc) => { await A.request('/projects/' + detail.project.id + '/modules', { method: 'POST', body: v }, cc); await A.render(); }); }));
        host.appendChild(A.panel('需求条目与提出人确认', [A.hint(data.overall_version_id ? '现行条目以生效总体规划引用为准。之后的候选版保留待处理。' : '尚无生效总体规划；已登记条目目前均为候选内容。')], ops));
        host.appendChild(A.panel('模块', [A.table(['模块', '操作'], data.modules.map((m) => [m.name, m.actions.rename === true ? A.button('修改模块名', () => { A.assertCurrent(c); A.dialog('修改模块名', [{ name: 'name', label: '模块名称', required: true, max: 60, value: m.name }], async (v, cc) => { await A.request('/modules/' + m.id, { method: 'PATCH', body: v }, cc); await A.render(); }); }) : '—']))]));
        const selected = params.has('item') ? A.id(params.get('item')) : null;
        const items = selected ? data.items.filter((item) => item.id === selected) : data.items;
        if (selected && !items.length) throw new Error('该条目不属于当前项目');
        if (selected) host.appendChild(A.row(A.link('查看全部需求条目', { project: detail.project.id, tab: 'items' })));
        for (const item of items) {
            const controls = A.row();
            if (item.actions.new_version === true) controls.appendChild(A.button('追加新版本', () => itemForm(detail, data, item, c)));
            if (item.actions.set_module === true) controls.appendChild(A.button('调整所属模块', () => { A.assertCurrent(c); A.dialog('调整所属模块', [{ name: 'module_id', label: '模块', value: item.module_id || '', options: [['', '尚未归属'], ...data.modules.map((m) => [m.id, m.name])] }], async (v, cc) => { await A.request('/items/' + item.id, { method: 'PATCH', body: { module_id: v.module_id ? A.id(v.module_id) : null } }, cc); await A.render(); }); }));
            const part = A.panel(item.code + (item.in_effective_plan ? ' · 已在生效总体规划中' : ' · 尚未纳入生效总体规划'), [A.hint('当前执行版本：' + (item.current_version_id ? 'v' + item.versions.find((v) => v.id === item.current_version_id).version_no : '无'))], controls);
            for (const version of item.versions.slice().reverse()) {
                const current = item.current_version_id === version.id;
                const status = current ? '当前执行依据' : item.pending_version_ids.includes(version.id) ? '待处理候选版' : item.current_version_id ? '历史版本' : '候选版本';
                const tasks = version.confirm_tasks || [];
                part.appendChild(A.panel('v' + version.version_no + ' · ' + status, [prose(version.content), A.facts([['提出人', version.proposer_display_name || version.proposer_name], ['提出场合', version.occasion], ['提出日期', version.proposed_on], ['提出人状态', proposerStates[version.proposer_status] || version.proposer_status]]), version.quote_text ? A.panel('原话要点', [prose(version.quote_text)]) : null, version.deny_reason ? A.hint('否认原因：' + version.deny_reason) : null,
                    version.no_written_evidence ? A.hint('无书面证据：' + version.no_evidence_reason) : null,
                    A.attachmentList(version.attachments, c),
                    A.row(...tasks.map((task) => A.link('打开提出人确认 · ' + (task.required_name || '必需确认人'), { task: task.task_id, revision_id: task.revision_id }))),
                ]));
            }
            host.appendChild(part);
        }
        if (!items.length) host.appendChild(A.panel('暂无需求条目', [A.hint('条目可在规划确认前整理；各版原文与提出人确认分别保留。')]));
        return host;
    }
    function newMaterialKey() {
        return 'm-' + Date.now().toString(36) + '-' + Array.from(window.crypto.getRandomValues(new Uint32Array(2)), (n) => n.toString(36)).join('-');
    }
    function materialForm(detail, data, material, c) {
        A.assertCurrent(c);
        const previous = material && material.versions[material.versions.length - 1];
        const attachments = material ? uniqueAttachments(material.versions).filter((a) => !a.masked && !a.deleted) : [];
        const defs = material ? [] : [
            { name: 'node_id', label: '所属节点', required: true, options: [['', '请选择可维护材料的节点'], ...data.nodes.filter((n) => n.actions.create_version).map((n) => [n.id, n.name])] },
            { name: 'name', label: '材料名称', max: 100, required: true },
        ];
        defs.push({ name: 'body', label: '本版材料正文', type: 'textarea', max: 12000, full: true, value: previous && previous.body || '', hint: '正文或附件至少一项；保存后只追加，不覆盖旧版。' }, { name: 'files', label: '本版材料附件 / 截图', type: 'file', multiple: true, full: true });
        if (material) defs.push({ name: 'ref_attachment_ids', label: '沿用本材料旧版附件', type: 'checklist', options: attachments.map((a) => [a.attachment_id, a.name || a.original_name || '附件 #' + a.attachment_id]), value: (previous.attachments || []).filter((a) => !a.masked && !a.deleted).map((a) => a.attachment_id), full: true });
        const key = material ? material.material_key : newMaterialKey();
        const form = A.dialog(material ? material.name + ' · 追加版本' : '建立候选材料', defs, async (v, cc) => {
            const body = { body: v.body || null, attachment_ids: await A.stageFiles(detail.project.id, v.files, cc), ref_attachment_ids: (v.ref_attachment_ids || []).map(A.id) };
            const nodeId = material ? material.node_id : A.id(v.node_id);
            if (!material) body.name = v.name;
            const result = await A.request('/nodes/' + nodeId + '/materials/' + key + '/versions', { method: 'POST', body }, cc);
            A.navigate({ project: detail.project.id, tab: 'materials', material_version: result.version.id });
        }, '保存候选材料版本');
        form.prepend(A.hint('本版附件会一并冻结以便复核。新增候选版不代表内容包已采纳；执行依据仍由生效内容包引用的版本决定。'));
    }
    async function materialsTab(detail, params, c) {
        const data = await A.request('/projects/' + detail.project.id + '/materials', null, c);
        const host = A.el('div');
        const ops = A.row();
        if (data.nodes.some((n) => n.actions.create_version === true)) ops.appendChild(A.button('建立候选材料', () => materialForm(detail, data, null, c)));
        host.appendChild(A.panel('材料版本与采纳依据', [A.hint('各版内容与附件分别保留。下方列出哪些内容包引用了该版；候选最新版不会自动取代已确认内容。')], ops));
        const selected = params.has('material_version') ? A.id(params.get('material_version')) : null;
        const items = selected ? data.materials.filter((m) => m.versions.some((v) => v.id === selected)) : data.materials;
        if (selected && !items.length) throw new Error('该材料版本不属于当前项目');
        if (selected) host.appendChild(A.row(A.link('查看全部材料', { project: detail.project.id, tab: 'materials' })));
        for (const material of items) {
            const node = data.nodes.find((n) => n.id === material.node_id);
            const part = A.panel(material.name + ' · ' + (node ? node.name : '所属节点'), null, material.actions.new_version === true ? A.button('追加候选版本', () => materialForm(detail, data, material, c)) : null);
            for (const version of material.versions.slice().reverse()) {
                if (selected && version.id !== selected) continue;
                const uses = version.uses || [];
                part.appendChild(A.panel('v' + version.version_no + ' · ' + (uses.some((use) => use.status === 'effective') ? '已有生效包引用' : '候选 / 历史材料'), [
                    A.facts([['建立人', version.created_by_name], ['建立时间', version.created_at]]), prose(version.body), A.attachmentList(version.attachments, c),
                    A.table(['引用的内容包', '包版本状态', '操作'], uses.map((use) => [(packageTypes[use.package_type] || use.package_type) + ' v' + use.version_no, versionStates[use.status] || use.status, A.link('查看引用版本', { project: detail.project.id, tab: 'packages', version: use.package_version_id })])),
                ]));
            }
            host.appendChild(part);
        }
        if (!items.length) host.appendChild(A.panel('暂无材料版本', [A.hint('PM 可在允许维护的节点下建立候选材料。')]));
        return host;
    }
    A.registerTab('items', '需求条目', itemsTab);
    A.registerTab('materials', '材料版本', materialsTab);
}());
