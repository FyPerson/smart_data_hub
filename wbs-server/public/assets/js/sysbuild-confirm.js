/* 项目管理确认页：固定任务修订、对象版本与本人声明，打开全文后才记录浏览。 */
(function () {
    'use strict';
    const A = window.SysBuildUI;
    const purposes = { package_confirm: '内容包确认', proposer_confirm: '提出人确认', conclusion_confirm: '办理结论确认', adjudicate: '负责人裁定', dev_key_confirm: '开发方关键事项认可', handover_accept_issue: '接受带此问题上线', handover_no_further: '业务确认不再处理', handover_accept: '交接接收', accept_invitation: '接受邀请', delegation_grant: '批准授权', delegation_accept: '接受授权' };
    const packageNames = { initiation: '立项与授权', overall: '总体范围与批次规划', batch_req: '批次需求', batch_accept: '批次验收', change: '正式变更', closing: '整体验收结项' };
    const states = { pending: '待确认', confirmed: '已确认', objected: '有异议', rejected: '不认可', invalid: '已失效', superseded: '已被替代', draft: '草稿', effective: '已生效' };
    const methods = { platform: '平台本人确认', card: '钉钉卡片', proxy: '凭据代录', history: '历史补录' };
    const decisions = { confirm: '确认', object: '有异议', reject: '不认可' };
    const label = (map, key) => map[key] || key || '—';
    const prose = (text) => A.el('div', 'sbui-longtext', text == null || text === '' ? '未填写' : String(text));
    function snapshotView(snapshot) {
        const names = { text: '确认内容', scope: '范围', goal: '目标', acceptance: '验收原则', out_of_scope: '不做的范围', notes: '说明', title: '标题', body: '正文', schedule: '排期', plans: '计划' };
        const render = (value, depth) => {
            if (depth > 32) return A.hint('原文层级过深，请查看归档确认单。');
            if (value === null || typeof value !== 'object') return prose(value);
            const entries = Array.isArray(value) ? value.map((v, i) => [String(i + 1), v]) : Object.entries(value).filter(([key]) => key !== 'material_version_ids');
            const node = A.el('div', 'sbui-stack');
            entries.forEach(([key, val]) => node.appendChild(A.panel(names[key] || key, [render(val, depth + 1)])));
            if (!entries.length) node.appendChild(A.hint('无附加文字'));
            return node;
        };
        return render(snapshot || {}, 0);
    }
    function evidenceDeclaration(record) {
        return record && record.no_written_evidence ? A.panel('无书面证据声明', [prose(record.no_evidence_reason)]) : null;
    }
    function entryOriginal(entry) {
        return A.panel('登记原文 · #' + entry.id + ' ' + entry.title, [
            A.facts([['业务日期', entry.business_date], ['登记时段', entry.period === 'supplement' ? '补充登记 · 收口后 ' + (entry.days_after_close == null ? '—' : entry.days_after_close) + ' 天' : '过程登记'], ['涉及承诺', entry.commitment_current ? '是' : '否'], ['风险标记', entry.risk_current ? '是' : '否']]),
            prose(entry.body), evidenceDeclaration(entry),
        ]);
    }
    function objectContent(data, c) {
        const o = data.object;
        const host = A.el('div', 'sbui-stack');
        if (o.type === 'package_version') {
            if (o.change) host.appendChild(A.panel('本次正式变更 · ' + o.change.title, [prose(o.change.body), A.disclosure('变更影响说明', snapshotView(o.change.affects)), evidenceDeclaration(o.change)]));
            host.appendChild(A.panel(label(packageNames, o.package.type) + ' · v' + o.version.version_no, [snapshotView(o.snapshot_json)]));
            const ownParty = Number(data.task.party_id);
            const items = (o.items || []).map((item, index) => ({ item, index })).sort((a, b) => Number(Number(b.item.proposer_party_id) === ownParty) - Number(Number(a.item.proposer_party_id) === ownParty) || a.index - b.index);
            items.forEach(({ item }) => host.appendChild(A.panel(item.code + ' · v' + item.version_no + (ownParty && Number(item.proposer_party_id) === ownParty ? ' · 本部门' : ''), [
                prose(item.content), A.facts([['提出人', item.proposer_name || item.proposer_display_name], ['提出场合', item.occasion], ['提出日期', item.proposed_on]]),
                item.quote_text ? A.panel('原话', [prose(item.quote_text)]) : null, evidenceDeclaration(item),
            ])));
            if ((o.node_plans || []).length) host.appendChild(A.panel('本版提交时的节点计划', [A.table(['节点', '所属层级', '计划开始', '计划结束'], o.node_plans.map((n) => [n.name, n.batch_name || '项目层', n.planned_start, n.planned_end]))]));
            (o.materials || []).forEach((m) => host.appendChild(A.panel('引用材料 · ' + m.name + ' v' + m.version_no, [prose(m.body), A.attachmentList(m.attachments, c)])));
        } else if (o.type === 'item_version') {
            const v = o.version;
            host.appendChild(A.panel(o.item.code + ' · v' + v.version_no, [prose(v.content), A.facts([['提出人', v.proposer_name || v.proposer_display_name], ['提出场合', v.occasion], ['提出日期', v.proposed_on]]), v.quote_text ? A.panel('原话', [prose(v.quote_text)]) : null, evidenceDeclaration(v)]));
        } else if (o.entry) {
            host.appendChild(entryOriginal(o.entry));
            if (o.conclusion) host.appendChild(A.panel('本次结论原文', [prose(o.conclusion.text), A.facts([['结论', o.conclusion.kind_label || label(A.entryConclusions || {}, o.conclusion.kind)], ['迭代单引用', o.conclusion.sys_issue_no], ['后续责任人', o.conclusion.assignee_text]])]));
            if (o.escalation) host.appendChild(A.panel('提交负责人裁定的说明', [prose(o.escalation.text)]));
            if (o.current_reply) host.appendChild(A.panel('PM 对上次决定的答复 · 本次请一并核对', [prose(o.current_reply.text), A.hint((o.current_reply.by_name || 'PM') + ' · ' + o.current_reply.at)]));
            if ((o.reply_history || []).length) host.appendChild(A.disclosure('历次交接答复', o.reply_history.map((r) => A.panel(r.at + ' · ' + (r.by_name || 'PM'), [prose(r.text)]))));
            if ((o.objections || []).length) host.appendChild(A.disclosure('此前异议', o.objections.map((r) => A.panel(r.created_at, [prose(r.reason)]))));
        }
        host.appendChild(A.panel('本版冻结附件', [A.attachmentList(data.frozen_attachments, c)]));
        return host;
    }
    function confirmationHistory(data, c) {
        const host = A.el('div', 'sbui-stack');
        const confirmed = new Map((data.confirmations || []).map((r) => [r.revision_id, r]));
        host.appendChild(A.table(['任务修订', '当时必需确认人', '修订状态', '确认方式', '确认人 / 代录人', '日期与时间'], (data.revisions || []).map((r) => {
            const cf = confirmed.get(r.id);
            return ['第 ' + r.rev_no + ' 次', r.required_name || '成员 #' + r.required_member_id, label(states, r.status), cf ? label(methods, cf.method) : '尚无确认记录', cf ? (cf.actual_confirmer || cf.actor_name || '—') + (cf.proxy_by_name ? '；代录：' + cf.proxy_by_name : '') : '—', cf ? (cf.external_date ? '外部日期 ' + cf.external_date + '；' : '') + '记入 ' + cf.created_at : r.created_at];
        })));
        (data.confirmations || []).forEach((cf) => host.appendChild(A.disclosure(label(methods, cf.method) + ' · ' + label(decisions, cf.decision) + ' · ' + cf.created_at, [prose(cf.reason || '确认无异议'), cf.identity_basis ? A.panel('当时身份依据', [prose(cf.identity_basis)]) : null, A.attachmentList(cf.attachments, c)])));
        if ((data.history_confirmations || []).length) host.appendChild(A.panel('历史补录 · 与本次任务确认分开记录', data.history_confirmations.map((cf) => A.panel((cf.actual_confirmer || '历史确认人') + ' · 原日期 ' + cf.external_date, [A.hint('由 ' + (cf.proxy_by_name || cf.proxy_by || '—') + ' 于 ' + cf.created_at + ' 记入'), prose(cf.identity_basis), prose(cf.reason || '确认无异议'), A.attachmentList(cf.attachments, c)]))));
        return host;
    }
    function decisionForm(data, c) {
        const allowed = data.allowed_decisions;
        if (!Array.isArray(allowed) || !allowed.length || allowed.some((d) => !decisions[d] || !data.checkbox_texts[d])) throw new Error('确认选项不完整，请刷新后重试');
        const form = A.form([
            { name: 'decision', label: '本人的决定', required: true, options: [['', '请明确选择'], ...allowed.map((d) => [d, decisions[d]])] },
            { name: 'reason', label: '原因说明', type: 'textarea', max: 500, full: true, hint: '有异议或不认可时必填。' },
            { name: 'acknowledged', label: '请先选择决定，再阅读并勾选相应声明', type: 'checkbox', required: true, full: true },
        ], async (v, cc) => {
            if (!allowed.includes(v.decision) || v.acknowledged !== true) throw new Error('请核对本版全文并勾选声明');
            try {
                await A.request('/confirm-tasks/' + data.task.id + '/decide', { method: 'POST', body: { revision_id: data.revision.id, object_version_id: data.task.object_version_id, decision: v.decision, checkbox_text: data.checkbox_texts[v.decision], reason: v.reason || null } }, cc);
            } catch (err) {
                if (err.status === 409) A.notice('本次决定未提交。任务版本或资格已变化，请明确重新打开后再决定。', true);
                throw err;
            }
            A.navigate({ task: data.task.id });
        }, '提交本人的决定', c);
        const selection = form.querySelector('[name="decision"]');
        const reason = form.querySelector('[name="reason"]');
        const checkbox = form.querySelector('[name="acknowledged"]');
        const submit = form.querySelector('button[type="submit"]');
        const updateSubmit = () => { submit.disabled = !allowed.includes(selection.value) || checkbox.checked !== true; };
        checkbox.addEventListener('change', updateSubmit);
        selection.addEventListener('change', () => {
            A.assertCurrent(c);
            checkbox.checked = false;
            checkbox.closest('label').querySelector('.sbui-label').textContent = data.checkbox_texts[selection.value] || '请先选择决定，再阅读并勾选相应声明';
            reason.required = selection.value !== '' && selection.value !== 'confirm';
            updateSubmit();
        });
        updateSubmit();
        return form;
    }
    function proxyForm(data, c) {
        const allowed = data.allowed_decisions;
        if (!Array.isArray(allowed) || !allowed.length) throw new Error('代录选项不完整');
        return A.form([
            { name: 'decision', label: '凭据中的决定', required: true, options: [['', '请按凭据选择'], ...allowed.map((d) => [d, decisions[d]])] },
            { name: 'reason', label: '异议 / 不认可的原因', type: 'textarea', max: 500, full: true },
            { name: 'external_date', label: '外部实际确认日期', type: 'date', required: true },
            { name: 'actual_confirmer', label: '实际确认人', value: data.revision.required_name || '', max: 100, required: true },
            { name: 'identity_basis', label: '当时的任职或授权依据', type: 'textarea', max: 500, required: true, full: true },
            { name: 'files', label: '原始确认凭据', type: 'file', multiple: true, required: true, full: true },
        ], async (v, cc) => {
            if (!allowed.includes(v.decision)) throw new Error('请选择凭据中的决定');
            const attachment_ids = await A.stageFiles(data.task.project_id, v.files, cc);
            await A.request('/confirm-tasks/' + data.task.id + '/proxy', { method: 'POST', body: { revision_id: data.revision.id, object_version_id: data.task.object_version_id, decision: v.decision, reason: v.reason || null, external_date: v.external_date, actual_confirmer: v.actual_confirmer, identity_basis: v.identity_basis, attachment_ids } }, cc);
            A.navigate({ task: data.task.id });
        }, '按原始凭据提交代录', c);
    }
    async function taskPage(params, c, expectedRevision) {
        const tid = A.id(params.get('task'));
        const expected = expectedRevision || (params.has('revision_id') ? A.id(params.get('revision_id')) : null);
        // 用户明确打开才调用；携带旧通知的修订号，后端在读和写浏览两个锁内都重核。
        let data;
        try { data = await A.request('/confirm-tasks/' + tid + (expected ? '?revision_id=' + expected : ''), null, c); }
        catch (err) {
            if (expected && err.status === 409) return A.panel('这条通知对应的任务修订已变化', [A.hint('未把这次打开记为阅读新版。请重新核对当前任务后再决定。'), A.link('明确打开当前任务', { task: tid }), A.link('返回我的待办', { todo: '1' })]);
            throw err;
        }
        const host = A.el('div', 'sbui-confirmation');
        host.appendChild(A.panel(label(purposes, data.task.purpose), [
            A.facts([['项目', data.project && data.project.system_name || '项目 #' + data.task.project_id], ['对象版本', data.object.version && data.object.version.version_no ? 'v' + data.object.version.version_no : '#' + data.task.object_version_id], ['任务修订', '第 ' + data.revision.rev_no + ' 次'], ['必需确认人', data.revision.required_name || '成员 #' + data.revision.required_member_id], ['状态', label(states, data.revision.status)]]),
            A.hint(data.revision.proxy_only ? '本修订的必需确认人没有平台账号，只能凭原始凭据代录；不生成本人浏览证据。' : '请核对下方原文、版本和冻结附件后再决定。每次决定固定绑定本页所示修订与对象版本。'),
            A.row(A.link('返回项目', { project: data.task.project_id }), A.link('我的待办', { todo: '1' })),
        ]));
        if (data.object.type === 'invitation' || data.object.type === 'delegation') {
            host.appendChild(A.panel('请核对邀请或授权后本人处理', [A.link('进入本人接受页面', data.object.type === 'invitation' ? { invitation: data.task.object_id } : { delegation: data.task.object_id })]));
            return host;
        }
        host.appendChild(objectContent(data, c));
        host.appendChild(A.panel('各次修订与确认记录', [confirmationHistory(data, c)]));
        if (data.actions.decide === true) host.appendChild(A.panel('本人作出决定', [decisionForm(data, c)]));
        else host.appendChild(A.panel('当前没有可提交的本人决定', [A.hint('请查看修订状态与必需确认人。已确认的决定不会因重复打开再次提交。')]));
        if (data.actions.proxy === true) host.appendChild(A.disclosure('PM 按原始凭据代录', [A.hint('代录须有实际确认人、外部日期、身份依据和原始附件，不冒充平台本人阅读与勾选。'), proxyForm(data, c)]));
        if (data.actions.reissue === true) host.appendChild(A.disclosure('PM 改发给当前具备资格的人', A.form([{ name: 'reason', label: '改发原因', type: 'textarea', max: 500, required: true, full: true }], async (v, cc) => {
            await A.request('/confirm-tasks/' + tid + '/reissue', { method: 'POST', body: { reason: v.reason, revision_id: data.revision.id } }, cc);
            A.navigate({ task: tid });
        }, '改发并保留旧修订', c)));
        if (data.object.type === 'package_version' && data.actions.export_sheet === true) {
            const sheetHost = A.el('div');
            host.appendChild(A.panel('归档确认单', [A.command('加载确认单预览', async (cc) => {
                const sheet = await A.confirmationSheetFrame(data.task.object_version_id, cc);
                A.assertCurrent(cc); sheetHost.replaceChildren(sheet);
            }, '', c), sheetHost]));
        }
        return host;
    }
    async function revisionPage(params, c) {
        const rid = A.id(params.get('rev'));
        const found = await A.request('/confirm-task-revisions/' + rid, null, c);
        if (found.is_current !== true) return A.panel('旧通知 · 任务修订已被替代', [A.hint('这条通知指向第 ' + found.rev_no + ' 次修订，不会自动读取或确认当前版本。'), A.link('明确打开当前任务', { task: found.task_id }), A.link('返回我的待办', { todo: '1' })]);
        return taskPage(new URLSearchParams({ task: found.task_id }), c, rid);
    }
    A.snapshotView = snapshotView;
    A.registerRoute('task', taskPage);
    A.registerRoute('revision', revisionPage);
}());
