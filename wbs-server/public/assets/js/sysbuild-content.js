/* 候选材料；现行依据消费服务端明确引用的版本。 */
(function () {
    'use strict';
    const A = window.SysBuildUI;
    const versionStates = { draft: '草稿', pending: '待确认', effective: '已生效', superseded: '已被替代' };
    const packageTypes = { initiation: '立项', overall: '总体规划', batch_accept: '批次验收', closing: '整体验收结项' };
    const prose = (s) => A.el('div', 'sbui-longtext', s || '未填写');
    const uniqueAttachments = (versions) => Array.from(new Map(versions.flatMap((v) => v.attachments || []).map((att) => [att.attachment_id, att])).values());
    function newMaterialKey() {
        return 'm-' + Date.now().toString(36) + '-' + Array.from(window.crypto.getRandomValues(new Uint32Array(2)), (n) => n.toString(36)).join('-');
    }
    function materialForm(detail, data, material, c, card, inlineBasis = false) {
        A.assertCurrent(c);
        const previous = material && material.versions[material.versions.length - 1];
        const usable = (a) => !a.masked && !a.deleted && (!inlineBasis || !a.missing);
        const attachments = material ? uniqueAttachments(material.versions).filter(usable) : [];
        const defs = material || card ? [] : [
            { name: 'node_id', label: '所属节点', required: true, options: [['', '请选择可维护材料的节点'], ...data.nodes.filter((n) => n.actions.create_version).map((n) => [n.id, n.name])] },
            { name: 'name', label: '材料名称', max: 100, required: true },
        ];
        defs.push({ name: 'body', label: inlineBasis ? '立项依据补充说明' : '本版材料正文', type: 'textarea', max: 12000, full: true, value: previous && previous.body || '', hint: '正文或附件至少一项；保存后只追加，不覆盖旧版。' }, { name: 'files', label: inlineBasis ? '立项依据附件' : '本版材料附件 / 截图', type: 'file', multiple: true, full: true });
        if (material) defs.push({ name: 'ref_attachment_ids', label: inlineBasis ? '沿用立项依据旧版附件' : '沿用本材料旧版附件', type: 'checklist', options: attachments.map((a) => [a.attachment_id, a.name || a.original_name || '附件 #' + a.attachment_id]), value: (previous?.attachments || []).filter(usable).map((a) => a.attachment_id), full: true });
        const key = card?.key ?? (material ? material.material_key : newMaterialKey());
        const save = async (v, cc) => {
            const body = { body: v.body || null, attachment_ids: await A.stageFiles(detail.project.id, v.files, cc), ref_attachment_ids: (v.ref_attachment_ids || []).map(A.id) };
            const nodeId = card?.node_id ?? (material ? material.node_id : A.id(v.node_id));
            if (!material && (!card || inlineBasis)) body.name = inlineBasis ? card.name : v.name;
            const result = await A.request('/nodes/' + nodeId + '/materials/' + key + '/versions', { method: 'POST', body }, cc);
            if (card) await A.render();
            else A.navigate({ project: detail.project.id, tab: 'materials', material_version: result.version.id });
        };
        if (inlineBasis) return A.form(defs, save, '保存立项依据版本', c);
        const form = A.dialog(card ? card.name + ' · 上传材料' : material ? material.name + ' · 追加版本' : '建立候选材料', defs, save, '保存候选材料版本');
        form.prepend(A.hint('本版附件会一并冻结以便复核。新增候选版不代表内容包已采纳；执行依据仍由生效内容包引用的版本决定。'));
    }
    function markMaterialCard(card, c) {
        A.assertCurrent(c);
        const isBasis = card.key === 'initiation-basis';
        const title = isBasis ? '填写无书面依据原因' : '标为不适用';
        A.dialog(title, [{ name: 'reason', label: isBasis ? '无书面依据原因' : '不适用原因', required: true, max: 500, type: 'textarea', value: card.declaration?.reason || '' }], async (value, cc) => {
            await A.request('/nodes/' + card.node_id + '/materials/' + card.key + '/not-applicable', { method: 'POST', body: { reason: value.reason } }, cc);
            await A.render();
        }, title, c);
    }
    function stageCardView(detail, node, data, packageData, initiationDraft, c, cardKey) {
        const panels = [];
        for (const card of data.cards.filter((item) => item.node_id === node.id)) {
            if (cardKey && card.key !== cardKey) continue;
            const basis = card.key === 'initiation-basis';
            const declarationStatus = basis ? '已声明无书面依据' : '不适用';
            const initiationEffective = basis && packageData.packages.some((item) => item.type === 'initiation' && item.versions.some((v) => v.status === 'effective'));
            const status = card.complete ? (card.declaration && !initiationEffective ? declarationStatus : '已完成') : card.required ? (card.kind === 'material' ? '待补材料' : '未完成') : '推荐';
            const content = [];
            if (card.kind === 'material') {
                content.push(A.hint(status));
                const material = data.materials.find((item) => item.id === card.material_id);
                for (const v of (material?.versions || []).slice().reverse()) {
                    const label = 'v' + v.version_no + (card.after_confirmation_version_ids.includes(v.id) ? ' · 确认之后的版本' : '');
                    const link = A.link(label, { project: detail.project.id, tab: 'materials', material_version: v.id });
                    if (!basis) content.push(link);
                    else if (cardKey) content.push(A.disclosure(card.name + ' ' + label, A.append(A.el('div'), [link, prose(v.body), A.attachmentList(v.attachments, c)])));
                }
                if (card.actions.upload) {
                    if (basis && cardKey) content.push(materialForm(detail, data, material, c, card, true));
                    // 立项依据的上传表单在卡片详情页里；阶段页的卡片上给一个直达入口，和其它材料卡片的「上传材料」对齐。
                    if (basis && !cardKey) content.push(A.link(material?.versions.length ? '再传一版立项依据' : '上传立项依据', { project: detail.project.id, tab: 'plan', node: node.id, card: card.key }));
                    if (!basis) content.push(A.button(material?.versions.length ? '再传一版' : '上传材料', () => materialForm(detail, data, material, c, card)));
                }
                if (card.actions.mark_not_applicable) content.push(A.command(basis ? '填写无书面依据原因' : '标为不适用', (cc) => markMaterialCard(card, cc), '', c));
                if (card.declaration) content.push(prose(card.declaration.reason));
            } else if (card.kind === 'confirmation') {
                const pkg = packageData.packages.find((item) => item.type === card.key && item.batch_id === card.batch_id);
                const open = pkg?.versions.find((v) => ['draft', 'pending'].includes(v.status));
                const effective = pkg?.versions.find((v) => v.status === 'effective');
                const draft = initiationDraft?.version.id === open?.id ? initiationDraft : null;
                if (open?.status === 'draft' && (!effective || cardKey)) {
                    const blocked = draft?.submit_block?.message;
                    content.push(A.hint(draft?.actions.submit === true ? '草稿 · 可提交' : blocked ? '草稿 · 当前不能发起确认：' + blocked : '草稿'));
                    content.push(A.link('进入确认草稿', { project: detail.project.id, tab: 'packages', version: open.id }));
                } else if (open?.status === 'pending' && (!effective || cardKey)) {
                    content.push(A.hint('待确认'));
                    content.push(A.link('查看待确认版本', { project: detail.project.id, tab: 'packages', version: open.id }));
                }
                if (effective) content.push(A.hint('已生效'), A.link('查看确认记录', { project: detail.project.id, tab: 'packages', version: effective.id }));
                if (!open && !effective) content.push(A.hint(status));
                if (pkg ? pkg.actions.new_version : packageData.actions.create_package_types.includes(card.key)) {
                    if (effective && ['initiation', 'batch_accept', 'closing'].includes(card.key)) {
                        if (cardKey) content.push(A.command('重新发起确认', (cc) => A.createPackageDraft(detail, card, pkg, cc), '', c));
                    } else {
                        content.push(A.command('建立确认草稿', (cc) => A.createPackageDraft(detail, card, pkg, cc), '', c));
                    }
                }
            } else content.push(A.hint(status));
            const open = cardKey ? null : A.link('查看卡片', { project: detail.project.id, tab: 'plan', node: node.id, card: card.key });
            const panel = A.panel(card.name, content, open);
            panel.classList.add('sbui-stage-card');
            if (!card.required) panel.classList.add('recommended');
            panels.push(panel);
        }
        if (!cardKey && data.nodes.find((item) => item.id === node.id)?.actions.create_card) panels.push(A.command('自建必做材料卡片', (cc) => {
            A.dialog('自建必做材料卡片', [{ name: 'name', label: '材料名称', max: 100, required: true }], async (value, lease) => {
                await A.request('/nodes/' + node.id + '/material-cards', { method: 'POST', body: { name: value.name } }, lease);
                await A.render();
            }, '建立卡片', cc);
        }, '', c));
        return panels;
    }
    async function stageCardDetail(detail, node, materials, key, c) {
        if (!materials.cards.some((card) => card.node_id === node.id && card.key === key)) throw new Error('该卡片不属于当前阶段');
        const packages = await A.request('/projects/' + detail.project.id + '/packages', null, c);
        const draft = key === 'initiation'
            ? packages.packages.find((pkg) => pkg.type === 'initiation')?.versions.find((version) => version.status === 'draft') : null;
        const draftView = draft ? await A.request('/package-versions/' + draft.id, null, c) : null;
        return A.append(A.el('div'), stageCardView(detail, node, materials, packages, draftView, c, key));
    }
    async function materialsTab(detail, params, c) {
        const data = A.state.materials;
        const host = A.el('div');
        const ops = A.row();
        if (data.nodes.some((n) => n.actions.create_version === true)) ops.appendChild(A.button('建立候选材料', () => materialForm(detail, data, null, c)));
        host.appendChild(A.panel('材料版本与采纳依据', [A.hint('各版内容与附件分别保留。下方列出哪些内容包引用了该版；候选最新版不会自动取代已确认内容。')], ops));
        const selected = params.has('material_version') ? A.id(params.get('material_version')) : null;
        const cardMaterials = new Set(data.cards.map((card) => card.material_id));
        const items = selected ? data.materials.filter((m) => m.versions.some((v) => v.id === selected)) : data.materials.filter((m) => !cardMaterials.has(m.id));
        if (selected && !items.length) throw new Error('该材料版本不属于当前项目');
        if (selected) host.appendChild(A.row(A.link('查看全部材料', { project: detail.project.id, tab: 'materials' })));
        for (const material of items) {
            const node = data.nodes.find((n) => n.id === material.node_id);
            const part = A.panel(material.name + ' · ' + (node ? node.name : '所属节点'), null, material.actions.new_version === true && !cardMaterials.has(material.id) ? A.button('追加候选版本', () => materialForm(detail, data, material, c)) : null);
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
    A.registerTab('materials', '材料版本', materialsTab);
    A.stageCardView = stageCardView;
    A.stageCardDetail = stageCardDetail;
}());
