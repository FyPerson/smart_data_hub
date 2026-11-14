/* 排期、节点收口与上线交接；前置条件由服务端提供并在提交时重核。 */
(function () {
    'use strict';
    const A = window.SysBuildUI;
    const nodeStates = { not_started: '未开始', in_progress: '进行中', closed: '已收口', cancelled: '已取消' };
    const confirmStates = { none: '未发起', pending: '待确认', confirmed: '已确认', declined: '不认可，待答复或重新办理', stale: '原确认已失效', invalid: '已失效', objected: '有异议', rejected: '不认可', superseded: '已被替代' };
    const recordKinds = { baseline: '确认形成的基线', plan_change: '计划 / 改期记录', actual_start: '实际开始', actual_end: '实际结束', actual_correct: '更正实际日期' };
    const needKinds = { accept_issue: '接受带此问题上线', no_further: '业务确认不再处理' };
    const span = (p) => p ? p.start + ' → ' + p.end : '未设置';
    const prose = (s) => A.el('div', 'sbui-longtext', s || '—');
    function blockers(rows, projectId) {
        if (!rows || !rows.length) return A.hint('服务端当前检查：前置条件已满足。提交时将重新核对。');
        return A.append(A.el('ul', 'sbui-checklist'), rows.map((r) => {
            const item = A.el('li', 'sbui-error');
            item.appendChild(A.text(r.message || r));
            if (projectId) {
                const ids = (values) => Array.from(new Set(values || [])).filter((id) => Number.isSafeInteger(id) && id > 0);
                item.appendChild(A.row(...ids(r.entry_ids).map((id) => A.link('办理登记 #' + id, { project: projectId, tab: 'entries', entry: id })), ...ids(r.node_ids).map((id) => A.link('查看节点 #' + id, { project: projectId, tab: 'plan', node: id }))));
            }
            return item;
        }));
    }
    async function closeNode(detail, node, c) {
        const lease = A.reserveDialog(c);
        const plan = await A.request('/projects/' + detail.project.id + '/plan', null, lease);
        A.assertCurrent(lease);
        const fresh = plan.nodes.find((n) => n.id === node.id);
        if (!fresh || fresh.actions.close !== true) throw new Error('该节点当前不能收口，请刷新后核对');
        const form = A.dialog('核对收口前置 · ' + fresh.name, [
            { name: 'checked', label: fresh.template_key === 'p_closing' ? '已核对前置，确认本次同时将项目标为已结项' : '已核对当前前置，确认收口并记录实际结束', type: 'checkbox', required: true, full: true },
        ], async (v, cc) => {
            if (!v.checked) throw new Error('请先核对收口前置');
            await A.request('/nodes/' + fresh.id + '/close', { method: 'POST', body: {} }, cc); await A.render();
        }, '确认收口', lease);
        form.prepend(A.panel('服务端收口前置检查', [blockers(fresh.close_blockers, detail.project.id)]));
        if (fresh.close_blockers.length) {
            form.querySelector('button[type="submit"]').disabled = true;
            form.appendChild(A.hint('请先处理以上事项，再重新打开检查清单。'));
        }
    }
    async function planChange(detail, node, c) {
        const lease = A.reserveDialog(c);
        const mode = node.plan_write_mode;
        if (!['draft', 'reschedule'].includes(mode)) throw new Error('计划写入方式未就绪，请刷新后重试');
        const entries = mode === 'reschedule' ? await A.request('/projects/' + detail.project.id + '/entries', null, lease) : null;
        A.assertCurrent(lease);
        const defs = [
            { name: 'planned_start', label: '新的计划开始', type: 'date', required: true, value: node.current_plan && node.current_plan.start || '' },
            { name: 'planned_end', label: '新的计划结束', type: 'date', required: true, value: node.current_plan && node.current_plan.end || '' },
            { name: 'reason', label: mode === 'draft' ? '本次计划说明（可选）' : '改期原因', type: 'textarea', max: 500, required: mode === 'reschedule', full: true },
        ];
        if (mode === 'reschedule') defs.push(
            { name: 'source_party_id', label: '改期提出方', required: true, options: [['', '请明确选择'], ['self', 'PM 本人提出'], ...detail.parties.map((p) => [p.id, p.name])] },
            { name: 'dev_key_entry_id', label: '开发方已认可的关键事项登记', options: [['', '开发方提出时须选择'], ...entries.entries.filter((e) => e.dev_confirm && e.dev_confirm.status === 'approved').map((e) => [e.id, '#' + e.id + ' ' + e.title])], hint: '来源方为开发方时，须引用本节点已获认可的改期事项。' },
            { name: 'files', label: '改期证据 / 截图', type: 'file', multiple: true, full: true },
            { name: 'no_written_evidence', label: '确无书面证据', type: 'checkbox' },
            { name: 'no_evidence_reason', label: '无书面证据原因', type: 'textarea', max: 500, full: true, hint: '与证据附件二选一，原因至少10个字。' },
        );
        const form = A.dialog((mode === 'draft' ? '草稿期计划 · ' : '改期 · ') + node.name, defs, async (v, cc) => {
            const body = { kind: 'plan', planned_start: v.planned_start, planned_end: v.planned_end, reason: v.reason || null };
            if (mode === 'reschedule') {
                body.source_party_id = v.source_party_id === 'self' ? null : A.id(v.source_party_id);
                const source = detail.parties.find((p) => p.id === body.source_party_id);
                if (source && source.side === 'dev') body.dev_key_entry_id = A.id(v.dev_key_entry_id);
                if (v.no_written_evidence && v.files.length) throw new Error('证据附件与无书面证据声明应二选一');
                body.attachment_ids = await A.stageFiles(detail.project.id, v.files, cc);
                Object.assign(body, A.evidencePayload(v));
            }
            await A.request('/nodes/' + node.id + '/schedule', { method: 'POST', body }, cc); await A.render();
        }, mode === 'draft' ? '保存草稿期计划' : '追加改期记录', lease);
        form.prepend(A.hint(mode === 'draft' ? '草稿期修改不形成基线；基线在总体规划确认生效时形成。' : node.has_baseline ? '保留原基线，追加当前计划与改期依据。' : '本节点尚无基线，但总体规划已生效，本次仍须按改期附原因与证据，不直接写成基线。'));
    }
    function correctActual(node, kind, c) {
        A.assertCurrent(c);
        A.dialog('更正实际' + (kind === 'actual_start' ? '开始' : '结束') + ' · ' + node.name, [
            { name: 'actual_date', label: '正确的实际日期', type: 'date', required: true, value: kind === 'actual_start' ? node.actual_start || '' : node.actual_end || '' },
            { name: 'reason', label: '更正原因', type: 'textarea', max: 500, required: true, full: true },
        ], async (v, cc) => { await A.request('/nodes/' + node.id + '/schedule', { method: 'POST', body: { kind: 'actual_correct', corrects: kind, actual_date: v.actual_date, reason: v.reason } }, cc); await A.render(); }, '追加实际日期更正');
    }
    function reasonNode(node, action, c) {
        A.assertCurrent(c);
        const title = action === 'reopen' ? '重开节点' : '取消节点';
        const form = A.dialog(title + ' · ' + node.name, [{ name: 'reason', label: '原因', type: 'textarea', max: 500, required: true, full: true }], async (v, cc) => { await A.request('/nodes/' + node.id + '/' + action, { method: 'POST', body: { reason: v.reason } }, cc); await A.render(); }, title);
        if (action === 'reopen') form.prepend(A.hint('同层后续已收口节点会随之重开；下游含正式上线里程碑时须先按权限撤销上线。已有登记的过程 / 补充时段不会被改写。'));
    }
    async function scheduleHistory(node, c) {
        const lease = A.reserveDialog(c);
        const data = await A.request('/nodes/' + node.id + '/schedule', null, lease);
        A.assertCurrent(lease);
        const form = A.dialog('排期与实际记录 · ' + node.name, [], async () => {}, '查看完毕', lease);
        form.querySelector('button[type="submit"]').remove();
        data.records.forEach((r) => form.appendChild(A.panel((recordKinds[r.kind] || r.kind) + ' · ' + r.created_at, [
            A.facts([['计划', r.planned_start ? r.planned_start + ' → ' + r.planned_end : '—'], ['实际日期', r.actual_date], ['操作人', r.created_by_name || '#' + r.created_by], ['原因', r.reason]]),
            r.no_written_evidence ? A.hint('无书面证据：' + r.no_evidence_reason) : null,
            A.attachmentList(r.attachments, lease),
        ])));
    }
    function nodeOperations(detail, node, c) {
        const ops = A.row(A.command('查看排期记录', () => scheduleHistory(node, c), '', c));
        if (node.actions.start === true) ops.appendChild(A.command('开始节点', async (cc) => { await A.request('/nodes/' + node.id + '/start', { method: 'POST', body: {} }, cc); await A.render(); }, '', c));
        if (node.actions.close === true) ops.appendChild(A.command('核对收口', () => closeNode(detail, node, c), 'primary', c));
        if (node.actions.reopen === true) ops.appendChild(A.button('重开节点', () => reasonNode(node, 'reopen', c)));
        if (node.actions.cancel === true) ops.appendChild(A.button('取消节点', () => reasonNode(node, 'cancel', c), 'danger'));
        if (node.actions.schedule_plan === true) ops.appendChild(A.command(node.plan_write_mode === 'draft' ? '设置草稿计划' : '改期', () => planChange(detail, node, c), '', c));
        if (node.actions.correct_actual_start === true) ops.appendChild(A.button('更正实际开始', () => correctActual(node, 'actual_start', c)));
        if (node.actions.correct_actual_end === true) ops.appendChild(A.button('更正实际结束', () => correctActual(node, 'actual_end', c)));
        if (node.actions.rename === true) ops.appendChild(A.button('修改节点名', () => { A.assertCurrent(c); A.dialog('修改节点名', [{ name: 'name', label: '名称', value: node.name, max: 60, required: true }], async (v, cc) => { await A.request('/nodes/' + node.id, { method: 'PATCH', body: v }, cc); await A.render(); }); }));
        return ops;
    }
    function batchOperations(detail, batch, nodes, c) {
        const ops = A.row();
        if (batch.actions.update === true) ops.appendChild(A.button('设置开发承接人', () => {
            A.assertCurrent(c);
            const devIds = detail.parties.filter((p) => p.side === 'dev').map((p) => p.id);
            const members = detail.members.filter((m) => m.status === 'joined' && devIds.includes(m.party_id));
            A.dialog('交付安排 · ' + batch.name, [{ name: 'name', label: '交付名称', max: 60, required: true, value: batch.name }, { name: 'dev_assignee_member_id', label: '开发承接人', value: batch.dev_assignee_member_id || '', options: [['', '暂不指定'], ...members.map((m) => [m.id, m.name])] }], async (v, cc) => { await A.request('/batches/' + batch.id, { method: 'PATCH', body: { name: v.name, dev_assignee_member_id: v.dev_assignee_member_id ? A.id(v.dev_assignee_member_id) : null } }, cc); await A.render(); });
        }));
        if (batch.actions.add_node === true) ops.appendChild(A.button('添加自定义节点', () => {
            A.assertCurrent(c);
            A.dialog('追加节点', [{ name: 'name', label: '名称', max: 60, required: true }, { name: 'g_stage', label: '对应环节（可选）', options: [['', '无'], ...['G0', 'CONTRACT', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6'].map((g) => [g, g])] }], async (v, cc) => { await A.request('/batches/' + batch.id + '/nodes', { method: 'POST', body: { name: v.name, g_stage: v.g_stage || null } }, cc); await A.render(); });
        }));
        if (batch.actions.reorder === true) ops.appendChild(A.button('调整节点顺序', () => {
            A.assertCurrent(c);
            A.dialog('调整节点顺序', nodes.map((n, index) => ({ name: 'order_' + n.id, label: n.name, value: index + 1, required: true, options: nodes.map((_, rank) => [rank + 1, '第 ' + (rank + 1) + ' 位']) })), async (v, cc) => {
                const ranked = nodes.map((n) => ({ id: n.id, rank: Number(v['order_' + n.id]) }));
                if (new Set(ranked.map((r) => r.rank)).size !== nodes.length) throw new Error('每个节点的位置必须不同');
                const node_ids = ranked.sort((a, b) => a.rank - b.rank).map((r) => r.id);
                await A.request('/batches/' + batch.id + '/node-order', { method: 'POST', body: { node_ids } }, cc); await A.render();
            }, '保存顺序');
        }));
        return ops;
    }
    async function planTab(detail, params, c) {
        const plan = A.state.plan;
        const selected = params.has('node') ? A.id(params.get('node')) : null;
        if (selected && !plan.nodes.some((n) => n.id === selected)) throw new Error('该节点不属于当前项目');
        const host = A.el('div');
        host.appendChild(A.panel('排期与节点', [A.hint('基线只由内容包确认生效形成；改期与实际日期更正只追加记录。下列动作由服务端按当前资格与状态提供。')]));
        if (selected) host.appendChild(A.row(A.link('查看全部节点', { project: detail.project.id, tab: 'plan' })));
        const groups = [{ id: null, name: '项目层', actions: {} }, ...plan.batches];
        groups.forEach((group) => {
            const allNodes = plan.nodes.filter((n) => n.batch_id === group.id);
            const nodes = selected ? allNodes.filter((n) => n.id === selected) : allNodes;
            if (selected && !nodes.length) return;
            host.appendChild(A.panel(group.id === null ? '项目层节点' : group.name + ' · 交付节点', group.id === null ? null : [batchOperations(detail, group, allNodes, c)]));
            nodes.forEach((n) => host.appendChild(A.panel(n.name + ' · ' + (nodeStates[n.status] || n.status), [
                A.facts([['环节', n.g_stage], ['确认基线', span(n.baseline)], ['当前计划', span(n.current_plan)], ['实际', (n.actual_start || '—') + ' → ' + (n.actual_end || '—')], ['相对基线', n.diff_days == null ? '暂无基线' : n.diff_days + ' 天'], ['逾期', n.overdue_days + ' 天'], ['收口后未结异议', n.post_close_objections_open + ' 条']]),
                n.close_blockers.length ? blockers(n.close_blockers, detail.project.id) : null, nodeOperations(detail, n, c),
            ])));
        });
        return host;
    }
    async function handoverTab(detail, params, c) {
        const host = A.el('div');
        host.appendChild(A.panel('收口与上线交接', [A.hint('是否已清、是否需代表人确认、是否必须答复均以服务端当前交接集合为准。发起后不自动确认。')]));
        for (const batch of A.state.plan.batches) {
            const data = await A.request('/batches/' + batch.id + '/handover', null, c);
            const summary = data.summary;
            const part = A.panel(batch.name, [A.facts([['交接事项', summary.total + ' 项'], ['已清', summary.cleared + ' 项'], ['未清', summary.uncleared + ' 项'], ['需要确认 / 已确认', summary.need_confirm + ' / ' + summary.confirmed]]), blockers(data.blockers, detail.project.id)]);
            if (data.actions.golive === true) part.appendChild(A.append(A.el('div', 'sbui-panel-body'), [A.button('确认试运行结束并正式上线', () => {
                A.assertCurrent(c);
                A.dialog('确认正式上线 · ' + batch.name, [{ name: 'checked', label: '已核对交接事项，确认试运行结束', type: 'checkbox', required: true, full: true }], async (v, cc) => { if (!v.checked) throw new Error('请核对后勾选'); await A.request('/batches/' + batch.id + '/golive', { method: 'POST', body: {} }, cc); await A.render(); }, '记录正式上线');
            }, 'primary')]));
            if (data.actions.revoke_golive === true) part.appendChild(A.append(A.el('div', 'sbui-panel-body'), [A.button('撤销正式上线', () => {
                A.assertCurrent(c);
                A.dialog('撤销正式上线 · ' + batch.name, [{ name: 'reason', label: '撤销原因', type: 'textarea', required: true, max: 500, full: true }], async (v, cc) => { await A.request('/batches/' + batch.id + '/revoke-golive', { method: 'POST', body: { reason: v.reason } }, cc); await A.render(); }, '记录撤销上线');
            }, 'danger')]));
            host.appendChild(part);
            for (const item of data.items) {
                const ops = A.row(A.link('打开登记与办理', { project: detail.project.id, tab: 'entries', entry: item.entry_id }));
                if (item.actions.handover_request === true) ops.appendChild(A.button(item.reply_required ? '答复后重新发起确认' : '发起交接确认', () => {
                    A.assertCurrent(c);
                    const defs = item.reply_required ? [{ name: 'reply', label: 'PM 对上次不认可 / 异议的答复', type: 'textarea', max: 500, required: true, full: true, hint: '至少10个字；答复将与新修订关联，供代表人重新决定。' }] : [];
                    const form = A.dialog(item.reply_required ? '答复并发起新修订' : '发起交接确认', defs, async (v, cc) => {
                        const body = { entry_id: item.entry_id };
                        if (item.reply_required) body.reply = v.reply;
                        await A.request('/batches/' + batch.id + '/handover/requests', { method: 'POST', body }, cc); await A.render();
                    }, item.reply_required ? '保存答复并发起' : '发起确认');
                    form.prepend(A.hint('本次要求：' + (needKinds[item.need_confirm] || item.need_confirm) + '。不会沿用旧决定自动确认。'));
                }));
                host.appendChild(A.panel('#' + item.entry_id + ' · ' + item.title, [
                    A.facts([['当前是否已清', item.cleared ? '已清' : '未清'], ['风险', item.risk_current ? '是' : '否'], ['确认要求', item.need_confirm ? needKinds[item.need_confirm] || item.need_confirm : '无本类确认要求'], ['确认状态', confirmStates[item.confirm.state] || item.confirm.state]]),
                    blockers(item.reasons, detail.project.id), item.last_reply ? A.panel('最近一次 PM 答复', [prose(item.last_reply.text), A.hint((item.last_reply.by_name || 'PM') + ' · ' + item.last_reply.at)]) : null,
                    A.table(['需求部门', '本次修订状态', '操作'], item.confirm.tasks.map((t) => [t.party_name, confirmStates[t.status] || t.status, A.link('明确打开确认全文', { task: t.task_id, revision_id: t.revision_id })])),
                    ops,
                ]));
            }
        }
        return host;
    }
    A.registerTab('plan', '排期与节点', planTab);
    A.registerTab('handover', '收口与交接', handoverTab);
}());
