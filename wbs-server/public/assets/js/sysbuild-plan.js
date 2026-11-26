/* 排期、节点收口与上线；前置条件由服务端提供并在提交时重核。 */
(function () {
    'use strict';
    const A = window.SysBuildUI;
    const stageStates = { not_started: '未开始', in_progress: '进行中', closed: '已完成', cancelled: '已取消' };
    const recordKinds = { baseline: '确认形成的基线', plan_change: '计划 / 改期记录', actual_start: '实际开始', actual_end: '实际结束', actual_correct: '更正实际日期' };
    const span = (p) => p ? p.start + ' → ' + p.end : '未设置';
    function completionFields(nodes) {
        if (!nodes || !nodes.length) return [];
        return [{ name: 'complete_node_ids', label: '一并完成（可选）', type: 'checklist', full: true,
            options: nodes.map((n) => [n.id, n.name + ' · ' + (stageStates[n.status] || n.status)]),
            hint: '仅完成选中的阶段，记录当天的实际结束。' }];
    }
    function blockers(rows, projectId) {
        if (!rows || !rows.length) return A.hint('服务端当前检查：前置条件已满足。提交时将重新核对。');
        return A.append(A.el('ul', 'sbui-checklist'), rows.map((r) => {
            const item = A.el('li', 'sbui-error');
            item.appendChild(A.text(r.message || r));
            if (projectId) {
                const ids = (values) => Array.from(new Set(values || [])).filter((id) => Number.isSafeInteger(id) && id > 0);
                item.appendChild(A.row(...ids(r.node_ids).map((id) => {
                    const stage = A.state.plan?.nodes?.find((node) => node.id === id);
                    const link = A.link('查看阶段', { project: projectId, tab: 'plan', node: id });
                    const label = stage?.name || '阶段 #' + id;
                    link.title = label;
                    link.setAttribute('aria-label', '查看阶段：' + label);
                    return link;
                })));
                if (r.pending_work?.length) item.appendChild(A.row(...r.pending_work.map((workItem) => A.work.itemLink(projectId, workItem))));
            }
            return item;
        }));
    }
    async function closeNode(detail, node, c) {
        const lease = A.reserveDialog(c);
        const plan = await A.request('/projects/' + detail.project.id + '/plan', null, lease);
        A.assertCurrent(lease);
        const fresh = plan.nodes.find((n) => n.id === node.id);
        if (!fresh || fresh.actions.close !== true) throw new Error('该阶段当前不能完成，请刷新后核对');
        const form = A.dialog('完成阶段 · ' + fresh.name, [
            { name: 'checked', label: fresh.template_key === 'p_closing' ? '已核对前置，确认本次同时将项目标为已结项' : '已核对当前前置，确认完成并记录实际结束', type: 'checkbox', required: true, full: true },
            ...completionFields(fresh.completion_candidates),
        ], async (v, cc) => {
            if (!v.checked) throw new Error('请先核对阶段完成条件');
            await A.request('/nodes/' + fresh.id + '/close', { method: 'POST', body: { complete_node_ids: (v.complete_node_ids || []).map(A.id) } }, cc); await A.render();
        }, '确认完成', lease);
        form.prepend(A.panel('阶段完成条件', [blockers(fresh.close_blockers, detail.project.id)]));
        if (fresh.close_blockers.length) {
            form.querySelector('button[type="submit"]').disabled = true;
            form.appendChild(A.hint('请先处理以上事项，再重新打开检查清单。'));
        }
    }
    async function planChange(detail, node, c) {
        const lease = A.reserveDialog(c);
        const mode = node.plan_write_mode;
        if (!['draft', 'reschedule'].includes(mode)) throw new Error('计划写入方式未就绪，请刷新后重试');
        A.assertCurrent(lease);
        const defs = [
            { name: 'planned_start', label: '新的计划开始', type: 'date', required: true, value: node.current_plan && node.current_plan.start || '' },
            { name: 'planned_end', label: '新的计划结束', type: 'date', required: true, value: node.current_plan && node.current_plan.end || '' },
            { name: 'reason', label: mode === 'draft' ? '本次计划说明（可选）' : '改期原因', type: 'textarea', max: 500, required: mode === 'reschedule', full: true },
        ];
        if (mode === 'reschedule') defs.push(
            { name: 'source_party_id', label: '改期提出方', required: true, options: [['', '请明确选择'], ['self', 'PM 本人提出'], ...detail.parties.map((p) => [p.id, p.name])] },
            { name: 'files', label: '改期证据 / 截图', type: 'file', multiple: true, full: true },
            { name: 'no_written_evidence', label: '确无书面证据', type: 'checkbox' },
            { name: 'no_evidence_reason', label: '无书面证据原因', type: 'textarea', max: 500, full: true, hint: '与证据附件二选一，原因至少10个字。' },
        );
        const form = A.dialog((mode === 'draft' ? '草稿期计划 · ' : '改期 · ') + node.name, defs, async (v, cc) => {
            const body = { kind: 'plan', planned_start: v.planned_start, planned_end: v.planned_end, reason: v.reason || null };
            if (mode === 'reschedule') {
                body.source_party_id = v.source_party_id === 'self' ? null : A.id(v.source_party_id);
                if (v.no_written_evidence && v.files.length) throw new Error('证据附件与无书面证据声明应二选一');
                body.attachment_ids = await A.stageFiles(detail.project.id, v.files, cc);
                Object.assign(body, A.evidencePayload(v));
            }
            await A.request('/nodes/' + node.id + '/schedule', { method: 'POST', body }, cc); await A.render();
        }, mode === 'draft' ? '保存草稿期计划' : '追加改期记录', lease);
        form.prepend(A.hint(mode === 'draft' ? '保存此次计划。基线随总体规划确认生效形成。' : '填写改期原因后追加计划记录。'));
        if (mode === 'reschedule') {
            const evidenceHint = A.el('p', 'sbui-hint');
            const end = form.querySelector('[name="planned_end"]');
            const showEvidenceNeed = () => {
                const required = node.batch_id === null && node.template_key === 'p_closing' && node.current_plan && end.value > node.current_plan.end;
                evidenceHint.textContent = required ? '推迟结项计划结束日期须附证据，或声明无书面证据并填写原因。' : '证据可选。';
            };
            end.addEventListener('input', showEvidenceNeed);
            showEvidenceNeed();
            form.prepend(evidenceHint);
        }
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
        const title = action === 'reopen' ? '重开阶段' : '取消阶段';
        const form = A.dialog(title + ' · ' + node.name, [{ name: 'reason', label: '原因', type: 'textarea', max: 500, required: true, full: true }], async (v, cc) => { await A.request('/nodes/' + node.id + '/' + action, { method: 'POST', body: { reason: v.reason } }, cc); await A.render(); }, title);
        if (action === 'reopen') form.prepend(A.hint('本次只重开当前阶段，已有登记的过程与补充时段保留。'));
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
    async function startNode(detail, node, c) {
        const start = async (body, cc) => {
            await A.request('/nodes/' + node.id + '/start', { method: 'POST', body }, cc);
            await A.render();
        };
        if (!node.allow_start_note) return start({}, c);
        const lease = A.reserveDialog(c);
        const form = A.dialog('开始阶段 · ' + node.name, [
            { name: 'start_note', label: '开工说明', type: 'textarea', full: true, max: 2000 },
            { name: 'files', label: '沟通记录', type: 'file', multiple: true, full: true },
        ], async (v, cc) => {
            const note = v.start_note.trim();
            if (!note && v.files.length) throw new Error('附沟通记录时请填写开工说明');
            const attachment_ids = await A.stageFiles(detail.project.id, v.files, cc);
            await start({ start_note: note, attachment_ids }, cc);
        }, '确认开始', lease);
        form.prepend(A.hint('范围尚未确认。可补充开工说明及沟通记录。'));
    }
    function nodeOperations(detail, node, c) {
        const ops = A.row(A.command('查看排期记录', () => scheduleHistory(node, c), '', c));
        if (node.actions.start === true) ops.appendChild(A.command('开始阶段', (cc) => startNode(detail, node, cc), '', c));
        if (node.actions.close === true) ops.appendChild(A.command('完成阶段', () => closeNode(detail, node, c), 'primary', c));
        if (node.actions.reopen === true) ops.appendChild(A.button('重开阶段', () => reasonNode(node, 'reopen', c)));
        if (node.actions.cancel === true) ops.appendChild(A.button('取消阶段', () => reasonNode(node, 'cancel', c), 'danger'));
        if (node.actions.schedule_plan === true) ops.appendChild(A.command(node.plan_write_mode === 'draft' ? '设置草稿计划' : '改期', () => planChange(detail, node, c), '', c));
        if (node.actions.correct_actual_start === true) ops.appendChild(A.button('更正实际开始', () => correctActual(node, 'actual_start', c)));
        if (node.actions.correct_actual_end === true) ops.appendChild(A.button('更正实际结束', () => correctActual(node, 'actual_end', c)));
        if (node.actions.rename === true) ops.appendChild(A.button('修改阶段名', () => { A.assertCurrent(c); A.dialog('修改阶段名', [{ name: 'name', label: '名称', value: node.name, max: 60, required: true }], async (v, cc) => { await A.request('/nodes/' + node.id, { method: 'PATCH', body: v }, cc); await A.render(); }, '确认修改'); }));
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
    const expandedReports = new Set();
    function reportPanel(detail, node, registration, sourceEntries, c) {
        const report = node.report;
        if (!report) return null;
        const ops = A.row();
        const definitions = registration && registration.forms || [];
        for (const [kind, title] of [['report_cycle', '设定汇报节奏'], ['report_request', '登记临时汇报要求'], ['progress_report', '提交进度汇报']]) {
            const definition = definitions.find((f) => f.kind === kind);
            if (definition && definition.allowed === true) ops.appendChild(A.command(title, () => A.openEntryForm(detail, kind, { node_id: node.id }, c), '', c));
        }
        const asOf = A.state.plan.project.estimated_completion?.as_of;
        const due = (report.due_items || []).filter((item) => !item.submitted);
        const upcoming = asOf ? (due.find((item) => item.due_on >= asOf) || due.at(-1)) : due[0];
        const delivered = (report.due_items || []).filter((item) => item.submitted).length;
        const overdue = (report.due_items || []).filter((item) => item.overdue).length;
        const gap = upcoming && asOf ? Math.round((Date.parse(upcoming.due_on + 'T00:00:00Z') - Date.parse(asOf + 'T00:00:00Z')) / 86400000) : NaN;
        const gapText = gap < 0 ? ' · 逾期 ' + Math.abs(gap) + ' 天' : gap === 0 ? ' · 今天应交' : gap > 0 ? ' · 剩 ' + gap + ' 天' : '';
        const cycleLabels = { weekly: '每周', biweekly: '每两周', monthly: '每月' };
        const cycle = report.current_cycle
            ? A.hint('登记周期：' + (cycleLabels[report.current_cycle.form.cycle] || report.current_cycle.form.cycle))
            : report.default_cycle ? A.hint('默认周期：' + (report.default_cycle.cycle === 'weekly' ? '每周' : '每两周') + '，首次应交 ' + report.default_cycle.first_due_on) : null;
        const line = detail.project.status === 'paused' ? [A.text('项目已暂停')]
            : node.status === 'not_started' ? [A.text('未开始'), cycle || (report.warning ? null : A.hint('当前没有汇报节奏。'))]
            : [cycle || (report.warning ? null : A.hint('当前没有汇报节奏。')),
                upcoming ? A.el('span', gap < 0 ? 'sbui-report-late' : '', '本期应交 ' + upcoming.due_on + gapText) : null,
                A.text('已交 ' + delivered + ' 期'), A.el('span', overdue ? 'sbui-report-late' : '', '逾期 ' + overdue + ' 期')];
        if (report.warning) line.push(A.el('span', 'sbui-error', report.warning));
        const part = A.panel('进度汇报', [A.append(A.el('div', 'sbui-report-summary'), line)], ops);
        const introductions = [
            A.hint('应交事项由服务端按当前节奏、临时要求与节点开工事实生成，截止至 ' + (report.cutoff || '无法读取') + '。'),
            A.hint('改节奏会清掉旧节奏下未交的应交日，历史登记仍保留；影响里程碑的汇报不替代改期。'),
            report.current_cycle ? A.panel('当前汇报节奏 · 登记 #' + report.current_cycle.entry_id, [A.entryFormView(report.current_cycle), A.link('查看节奏登记', { project: detail.project.id, tab: 'entries', entry: report.current_cycle.entry_id })]) : null,
        ];
        const body = A.el('div', 'sbui-panel-body');
        // 55 号 LOW-1（用户 2026-11-17 定）：同一来源的勘误在本面板只整段显示一次（「当前汇报节奏」或该来源首次出现的行），其后的行只给标记。
        // 57 号 MEDIUM：节奏面板（/plan）与来源行（/entries）是两次读取，按每条勘误的 action_id 记已显示，来源里有未显示过的勘误就整段显示。
        const shownCorrectionIds = new Set();
        const correctionIds = (entry) => (entry.corrections || []).map((r) => Number(r.action_id)).filter(Number.isSafeInteger);
        if (report.current_cycle) correctionIds(report.current_cycle).forEach((x) => shownCorrectionIds.add(x));
        const sourceCorrections = (id) => {
            const entry = sourceEntries.get(id);
            if (!entry) return A.hint('该来源登记的勘误信息未能读取，请打开原登记核对。');
            const ids = correctionIds(entry);
            if (!ids.length && entry.has_correction !== true) return null;
            if (ids.length && ids.every((x) => shownCorrectionIds.has(x))) return A.hint('有勘误说明，见上方登记 #' + id + ' 处。');
            const fresh = (entry.corrections || []).filter((r) => !shownCorrectionIds.has(Number(r.action_id)));
            ids.forEach((x) => shownCorrectionIds.add(x));
            return A.entryCorrectionsView(ids.length ? Object.assign({}, entry, { corrections: fresh }) : entry);
        };
        const source = (item) => A.append(A.el('div'), (item.sources || []).map((s) => s.kind === 'default_cycle' ? A.hint('默认周期') : A.append(A.el('div', 'sbui-report-source'), [
            A.link((s.kind === 'cycle' ? '周期要求' : '临时要求') + ' #' + s.entry_id, { project: detail.project.id, tab: 'entries', entry: s.entry_id }), s.reason ? A.hint(s.reason) : null,
            sourceCorrections(Number(s.entry_id)),
        ])));
        body.appendChild(A.table(['应交日', '全部来源', '提交情况', '汇报登记'], (report.due_items || []).map((item) => [
            item.due_on, source(item), item.submitted ? '已交' : item.overdue ? '逾期未交' : '待交',
            A.row(...(item.report_entry_ids || []).map((id) => A.link('汇报 #' + id, { project: detail.project.id, tab: 'entries', entry: id }))),
        ])));
        if (!(report.due_items || []).length) body.appendChild(A.hint('当前没有应交事项；主动汇报仍按服务端登记条件处理。'));
        for (const [key, title] of [['unreadable_request_ids', '无法读取的临时汇报要求'], ['unreadable_report_ids', '无法读取的进度汇报'], ['unreadable_entry_ids', '无法读取的登记']]) {
            if ((report[key] || []).length) body.appendChild(A.panel(title, [A.hint(key === 'unreadable_request_ids' ? '无法确定应交日，本次不生成提醒；可查看原登记。' : key === 'unreadable_report_ids' ? '不可读汇报不计为已交，请核对原登记。' : '请核对登记原文；节奏未知时可新登一条节奏恢复。'), A.row(...report[key].map((id) => A.link('登记 #' + id, { project: detail.project.id, tab: 'entries', entry: id })))]));
        }
        body.appendChild(report.latest_report ? A.panel('最近一次汇报 · 登记 #' + report.latest_report.entry_id, [A.entryFormView(report.latest_report), A.link('查看汇报原文', { project: detail.project.id, tab: 'entries', entry: report.latest_report.entry_id })]) : A.hint('尚无进度汇报。'));
        definitions.filter((f) => ['progress_report', 'report_cycle', 'report_request'].includes(f.kind)).forEach((f) => body.appendChild(A.hint(f.label + '：' + f.conditions)));
        const deep = A.disclosure('汇报明细与历史', A.append(A.el('div'), [...introductions, body]));
        deep.classList.add('sbui-report-details');
        const reportKey = String(A.state.userId) + ':' + node.id;
        deep.open = expandedReports.has(reportKey);
        deep.addEventListener('toggle', () => {
            if (deep.open) expandedReports.add(reportKey);
            else expandedReports.delete(reportKey);
        });
        part.appendChild(deep);
        return part;
    }
    function devStartHint(node) {
        if (node.status !== 'not_started' || node.actions.start === true || node.dev_start_ready === 'not_dev_node') return null;
        if (node.dev_start_ready === 'ok') return null;
        return A.hint('开发节点开始条件无法读取，请刷新后重试');
    }
    function stageRecords(detail, node, entryData, data) {
        const pid = detail.project.id;
        const rows = entryData.entries.filter((entry) => entry.node_id === node.id && !entry.form_kind && !['feedback', 'issue'].includes(entry.type)).map((entry) => [
            A.link(entry.title, { project: pid, tab: 'entries', entry: entry.id }), '记录', entry.created_at,
        ]);
        const registered = new Set(data.cards.filter((card) => card.node_id === node.id).map((card) => card.material_id));
        for (const material of data.materials.filter((item) => item.node_id === node.id && !registered.has(item.id))) {
            const version = material.versions.at(-1);
            if (version) rows.push([A.link(material.name, { project: pid, tab: 'materials', material_version: version.id }), '材料', version.created_at]);
        }
        const entry = A.link('查看本阶段全部记录', { project: pid, tab: 'entries', entry_node: node.id });
        return A.panel('本阶段记录', [A.table(['记录', '来源', '时间'], rows)], entry);
    }
    async function planTab(detail, params, c) {
        const plan = A.state.plan;
        // 未附筛选的 entries 接口返回本项目全部登记及勘误；与角色元数据共用本次读取。
        const [entryData, materials, packages, workData] = await Promise.all([
            A.request('/projects/' + detail.project.id + '/entries', null, c),
            A.state.materials,
            A.request('/projects/' + detail.project.id + '/packages', null, c),
            A.request('/projects/' + detail.project.id + '/tasks', null, c),
        ]);
        const registration = entryData.registration;
        const sourceEntries = new Map(entryData.entries.map((entry) => [Number(entry.id), entry]));
        const showInitiation = params.get('stage') === 'initiation' && !params.has('node');
        const initiation = plan.nodes.find((n) => n.template_key === 'p_initiation' && n.batch_id === null);
        const selected = params.has('node') ? A.id(params.get('node')) : showInitiation ? initiation?.id : null;
        if (selected && !plan.nodes.some((n) => n.id === selected)) throw new Error('该节点不属于当前项目');
        const draft = initiation && (!selected || selected === initiation.id)
            ? packages.packages.find((p) => p.type === 'initiation')?.versions.find((v) => v.status === 'draft') : null;
        const initiationDraft = draft ? await A.request('/package-versions/' + draft.id, null, c) : null;
        const host = A.el('div');
        if (!selected) host.appendChild(A.panel('全部阶段', [A.hint('可在阶段中查计划或更正实际日期。')]));
        if (showInitiation && !initiation) host.appendChild(A.hint('未找到立项节点，请刷新后核对项目结构。'));
        if (selected) host.appendChild(A.row(A.link('查看全部阶段', { project: detail.project.id, tab: 'plan' })));
        const groups = [{ id: null, name: '项目层', actions: {} }, ...plan.batches];
        groups.forEach((group) => {
            const allNodes = plan.nodes.filter((n) => n.batch_id === group.id);
            const nodes = selected ? allNodes.filter((n) => n.id === selected) : allNodes;
            if (selected && !nodes.length) return;
            if (!selected) host.appendChild(A.panel(group.id === null ? '项目层阶段' : group.name + ' · 交付阶段', group.id === null ? null : [batchOperations(detail, group, allNodes, c)]));
            for (const n of nodes) {
                const stage = A.panel(n.name + ' · ' + (stageStates[n.status] || n.status), [
                    A.facts([['环节', n.g_stage], ['确认基线', span(n.baseline)], ['当前计划', span(n.current_plan)], ['实际', (n.actual_start || '—') + ' → ' + (n.actual_end || '—')], ['相对基线', n.diff_days == null ? '暂无基线' : n.diff_days + ' 天'], ['逾期', n.overdue_days + ' 天']]),
                    n.close_blockers.length ? blockers(n.close_blockers, detail.project.id) : null, devStartHint(n),
                ], nodeOperations(detail, n, c));
                const cards = A.stageCardView(detail, n, materials, packages, initiationDraft, c);
                A.append(host, [stage, reportPanel(detail, n, registration, sourceEntries, c),
                    cards.length ? A.append(A.el('div', 'sbui-stage-cards'), cards) : null,
                    selected || workData.tasks.some((task) => task.node_id === n.id) ? A.work.taskPanel(detail, n, workData, c) : null,
                    selected ? stageRecords(detail, n, entryData, materials) : null]);
            }
        });
        return host;
    }
    async function handoverTab(detail, params, c) {
        const host = A.el('div');
        host.appendChild(A.panel('上线与交接'));
        for (const batch of A.state.plan.batches) {
            const data = await A.request('/batches/' + batch.id + '/handover', null, c);
            const part = A.panel(batch.name, [blockers(data.blockers, detail.project.id)]);
            if (data.actions.golive === true) part.appendChild(A.append(A.el('div', 'sbui-panel-body'), [A.button('确认试运行结束并正式上线', () => {
                A.assertCurrent(c);
                A.dialog('确认正式上线 · ' + batch.name, [
                    { name: 'checked', label: '已核对上线前置，确认试运行结束', type: 'checkbox', required: true, full: true },
                    ...completionFields(data.completion_candidates),
                    { name: 'files', label: '上线凭据（可选，至多10个）', type: 'file', multiple: true, full: true },
                ], async (v, cc) => {
                    if (!v.checked) throw new Error('请核对后勾选');
                    const attachment_ids = await A.stageFiles(detail.project.id, v.files, cc);
                    await A.request('/batches/' + batch.id + '/golive', { method: 'POST', body: { attachment_ids, complete_node_ids: (v.complete_node_ids || []).map(A.id) } }, cc);
                    await A.render();
                }, '记录正式上线');
            }, 'primary')]));
            if (data.actions.revoke_golive === true) part.appendChild(A.append(A.el('div', 'sbui-panel-body'), [A.button('撤销正式上线', () => {
                A.assertCurrent(c);
                A.dialog('撤销正式上线 · ' + batch.name, [{ name: 'reason', label: '撤销原因', type: 'textarea', required: true, max: 500, full: true }, { name: 'files', label: '撤销上线凭据（可选，至多10个）', type: 'file', multiple: true, full: true }], async (v, cc) => { const attachment_ids = await A.stageFiles(detail.project.id, v.files, cc); await A.request('/batches/' + batch.id + '/revoke-golive', { method: 'POST', body: { reason: v.reason, attachment_ids } }, cc); await A.render(); }, '记录撤销上线');
            }, 'danger')]));
            const event = data.batch.last_golive_event;
            part.appendChild(A.panel('最近一次上线事件与凭据', event ? [A.facts([['事件', event.kind === 'revoke' ? '撤销上线' : '正式上线'], ['发生时间', event.at], ['原因', event.reason]]), A.attachmentList(event.attachments || [], c)] : [A.hint('尚无上线事件。')]));
            host.appendChild(part);
        }
        return host;
    }
    A.registerTab('plan', '排期与节点', planTab);
    A.registerTab('handover', '上线与交接', handoverTab);
}());
