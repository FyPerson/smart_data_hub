/* 历史补录窗口、历史确认与事实导入；写动作均明确提交原始凭据。 */
(function () {
    'use strict';
    const A = window.SysBuildUI;
    const windowNames = { never: '尚未开启', open: '历史补录中', closed: '已关闭' };
    const actions = { open: '开启历史补录窗口', close: '关闭历史补录窗口', reopen: '管理员重开历史补录窗口' };
    const facts = { appointment: '负责人任职已生效', delegation: '代表人授权已生效', package_effective: '内容包已生效', node_closed: '节点已收口', golive: '已正式上线' };
    const packages = { initiation: '立项包', overall: '总体规划包', closing: '结项包', batch_accept: '验收包', change: '变更包' };
    const decisions = { confirm: '确认', object: '有异议', reject: '不认可' };
    const prose = (s) => A.el('div', 'sbui-longtext', s || '未填写');
    function evidenceFields(dateName, name) { return [
        { name: dateName, label: name, type: 'date', required: true },
        { name: 'actual_confirmer', label: '原始事实中的实际确认人', max: 100, required: true },
        { name: 'identity_basis', label: '当时的任职或授权依据', type: 'textarea', max: 500, required: true, full: true },
        { name: 'files', label: '原始凭据附件 / 截图', type: 'file', multiple: true, required: true, full: true },
    ]; }
    function windowAction(detail, action, c) {
        A.assertCurrent(c);
        const form = A.dialog(actions[action], [{ name: 'reason', label: action === 'reopen' ? '重开原因' : '说明（可选）', type: 'textarea', max: 500, required: action === 'reopen', full: true }, { name: 'files', label: '本次窗口操作的原始凭据', type: 'file', required: true, multiple: true, full: true }], async (v, cc) => {
            const attachment_ids = await A.stageFiles(detail.project.id, v.files, cc);
            await A.request('/projects/' + detail.project.id + '/history-window', { method: 'POST', body: { action, reason: v.reason || null, attachment_ids } }, cc); await A.render();
        }, actions[action]);
        form.prepend(A.hint(action === 'close' ? '关闭只收窄补录能力，不会撤销已留存的历史事实。' : '只在有原始历史凭据时开启。当前确认与历史事实分开记录，不能把历史补录当作当前人的确认。'));
    }
    function fillOptions(select, rows) {
        select.replaceChildren();
        [['', '请选择确切对象与版本'], ...rows].forEach(([id, text]) => { const option = A.el('option', '', text); option.value = String(id); select.appendChild(option); });
    }
    function candidates(detail, data, kind) {
        if (kind === 'appointment') return detail.appointments.filter((a) => a.status === 'pending').map((a) => [a.id, '任职 #' + a.id + ' · ' + a.name]);
        if (kind === 'delegation') return detail.delegations.filter((d) => ['pending_owner', 'pending_accept'].includes(d.status)).map((d) => [d.id, '授权 #' + d.id + ' · ' + d.name]);
        if (kind === 'package_effective') return data.packages.packages.filter((p) => data.window.options.import_package_types.includes(p.type)).flatMap((p) => p.versions.filter((v) => v.status === 'draft').map((v) => [v.id, (packages[p.type] || p.type) + ' v' + v.version_no]));
        if (kind === 'node_closed') return A.state.plan.nodes.filter((n) => !['closed', 'cancelled'].includes(n.status)).map((n) => [n.id, n.name]);
        if (kind === 'golive') return A.state.plan.batches.map((b) => [b.id, b.name]);
        if (kind === 'package_version') return data.packages.packages.flatMap((p) => p.versions.filter((v) => v.status !== 'draft').map((v) => [v.id, (packages[p.type] || p.type) + ' v' + v.version_no]));
        if (kind === 'item_version') return data.items.items.flatMap((item) => item.versions.map((v) => [v.id, item.code + ' v' + v.version_no]));
        return [];
    }
    function historyForm(detail, data, importing, c) {
        A.assertCurrent(c);
        const kindName = importing ? 'fact_type' : 'object_type';
        const objectName = importing ? 'object_id' : 'object_version_id';
        const kinds = importing ? data.window.options.fact_types.filter((kind) => kind !== 'golive' || data.window.actions.import_golive === true) : data.window.options.confirmation_object_types;
        const labels = importing ? facts : { package_version: '某一内容包版本', item_version: '某一需求条目版本' };
        const defs = [
            { name: kindName, label: importing ? '历史事实类型' : '确认对象类型', required: true, options: [['', '请明确选择'], ...kinds.map((kind) => [kind, labels[kind] || kind])] },
            { name: objectName, label: '确切对象 / 版本', required: true, options: [['', '先选择上方类型']] },
        ];
        if (!importing) defs.push({ name: 'decision', label: '历史凭据中的决定', required: true, options: [['', '请按原件选择'], ...data.window.options.decisions.map((decision) => [decision, decisions[decision]])] }, { name: 'reason', label: '原始异议 / 不认可原因', type: 'textarea', max: 500, full: true });
        defs.push(...evidenceFields(importing ? 'original_date' : 'external_date', importing ? '原事实发生日期' : '外部实际确认日期'));
        const form = A.dialog(importing ? '导入已有的历史事实' : '补录历史确认（不改当前状态）', defs, async (v, cc) => {
            const body = { actual_confirmer: v.actual_confirmer, identity_basis: v.identity_basis, attachment_ids: await A.stageFiles(detail.project.id, v.files, cc) };
            if (importing) { body.fact_type = v.fact_type; body.object_id = A.id(v.object_id); body.original_date = v.original_date; }
            else { body.object_type = v.object_type; body.object_version_id = A.id(v.object_version_id); body.decision = v.decision; body.reason = v.reason || null; body.external_date = v.external_date; }
            await A.request('/projects/' + detail.project.id + (importing ? '/history-imports' : '/history-confirmations'), { method: 'POST', body }, cc); await A.render();
        }, importing ? '按原始凭据恢复历史事实' : '只记录历史确认事实');
        form.prepend(A.hint(importing ? '导入会按原始日期恢复相应生效 / 收口 / 上线事实。前置、冲突和日期自洽均在提交时重核，不跳过规划与交接闸门。' : '仅补记历史上发生过的确认，不改变当前任务修订、提出人状态，也不让内容包自动生效。'));
        const kind = form.querySelector('[name="' + kindName + '"]');
        const object = form.querySelector('[name="' + objectName + '"]');
        kind.addEventListener('change', () => { A.assertCurrent(c); fillOptions(object, candidates(detail, data, kind.value)); });
        if (!importing) {
            const selection = form.querySelector('[name="decision"]');
            const reason = form.querySelector('[name="reason"]');
            selection.addEventListener('change', () => { reason.required = selection.value !== '' && selection.value !== 'confirm'; });
        }
    }
    async function historyTab(detail, params, c) {
        const base = '/projects/' + detail.project.id;
        const [windowData, imports, confirms, packageData, items] = await Promise.all([
            A.request(base + '/history-window/events', null, c), A.request(base + '/history-imports', null, c), A.request(base + '/history-confirmations', null, c), A.request(base + '/packages', null, c), A.request(base + '/items', null, c),
        ]);
        const data = { window: windowData, packages: packageData, items };
        const host = A.el('div');
        const ops = A.row();
        ['open', 'close', 'reopen'].forEach((action) => { if (windowData.actions[action] === true) ops.appendChild(A.button(actions[action], () => windowAction(detail, action, c))); });
        if (windowData.actions.confirm === true) ops.appendChild(A.button('补录历史确认', () => historyForm(detail, data, false, c)));
        if (windowData.actions.import === true) ops.appendChild(A.button('导入已有历史事实', () => historyForm(detail, data, true, c), 'primary'));
        host.appendChild(A.panel('历史补录 · ' + (windowNames[windowData.history_window] || windowData.history_window), [A.hint('补录历史确认与导入历史生效是两种不同操作。前者只留事实，后者按严格前置恢复状态，均必须有原始凭据。')], ops));
        host.appendChild(A.panel('窗口操作记录与原始凭据', windowData.items.length ? windowData.items.map((row) => A.panel(actions[row.action] + ' · ' + row.created_at, [A.facts([['操作人', row.operator_name], ['窗口变化', (windowNames[row.from] || row.from) + ' → ' + (windowNames[row.to] || row.to)], ['原因', row.reason]]), A.attachmentList(row.attachments, c)])) : [A.hint('暂无窗口操作记录')]));
        host.appendChild(A.panel('历史确认 · 只记录事实', confirms.history_confirmations.length ? confirms.history_confirmations.map((row) => A.panel((row.actual_confirmer || '历史确认人') + ' · 原日期 ' + row.external_date, [A.facts([['原决定', decisions[row.decision] || row.decision], ['对象', (row.object_type === 'package_version' ? '内容包版本 #' : '条目版本 #') + row.object_version_id], ['录入人', row.proxy_by_name || row.proxy_by], ['记入时间', row.created_at]]), prose(row.identity_basis), row.reason ? prose(row.reason) : null, A.attachmentList(row.attachments, c)])) : [A.hint('暂无历史确认记录')]));
        host.appendChild(A.panel('已导入的历史事实', imports.history_imports.length ? imports.history_imports.map((row) => A.panel((facts[row.fact_type] || '历史事实') + ' · 原日期 ' + row.original_date, [A.facts([['实际确认人', row.actual_confirmer], ['录入人', row.imported_by_name || row.imported_by], ['记入时间', row.imported_at]]), prose(row.identity_basis), A.attachmentList(row.attachments, c)])) : [A.hint('暂无历史事实导入记录')]));
        return host;
    }
    A.registerTab('history', '历史补录', historyTab);
}());
