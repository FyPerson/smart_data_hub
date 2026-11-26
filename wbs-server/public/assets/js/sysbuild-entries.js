/* 登记、办理与改期知会。所有动作入口消费服务端 actions。 */
(function () {
    'use strict';
    const A = window.SysBuildUI;
    const types = { note: '补充说明', material: '补交材料', lesson: '经验教训', benefit: '使用与效益', feedback: '意见与反馈', issue: '问题与处理', correction: '更正' };
    const purposes = { general: '一般登记' };
    const actions = { correct: '追加更正', void: '作废登记' };
    const label = (map, key) => map[key] || key || '—';
    const prose = (s) => A.el('div', 'sbui-longtext', s || '未填写');
    function noEvidenceFields() { return [
        { name: 'files', label: '原始附件 / 截图', type: 'file', multiple: true, full: true },
        { name: 'no_written_evidence', label: '确无书面证据', type: 'checkbox' },
        { name: 'no_evidence_reason', label: '无书面证据的原因', type: 'textarea', max: 500, full: true, hint: '勾选声明时至少10个字；与本次证据附件二选一。补交材料必须有附件，声明不能替代。' },
    ]; }
    const formNames = { progress_report: '进度汇报', report_cycle: '汇报节奏', report_request: '临时汇报要求' };
    const formFields = {
        progress_report: [['due_on', '对应应交日'], ['done', '本期进展'], ['next', '下期计划'], ['risks', '风险'], ['milestone_impact', '是否影响里程碑']],
        report_cycle: [['cycle', '周期'], ['first_due_on', '首次应交日'], ['note', '说明']],
        report_request: [['due_on', '应交日'], ['reason', '事由']],
    };
    function entryCorrectionsView(entry) {
        if (!entry) return null;
        const host = A.el('div', 'sbui-stack');
        if (entry.has_correction === true || (entry.corrections || []).length) host.appendChild(A.panel('勘误说明', [
            A.hint('以下为后续追加的勘误，原表单字段不变；开始门、提交门与应交事项仍按原字段判断。'),
            ...(entry.corrections || []).map((r) => A.append(A.el('div'), [prose(r.text), A.hint((r.created_by_name || '登记人 #' + r.created_by) + ' · ' + r.created_at)])),
        ]));
        return host.childNodes.length ? host : null;
    }
    function entryFormView(entry) {
        if (!entry || (!entry.form && entry.form_unreadable !== true)) return null;
        const host = A.el('div', 'sbui-stack');
        if (entry.form_unreadable === true) host.appendChild(A.hint('表单字段无法读取，请查看登记原文与勘误说明。'));
        else {
            const f = entry.form;
            const valueOf = (key) => {
                if (key === 'cycle') return label({ weekly: '每周', biweekly: '每两周', monthly: '每月' }, f[key]);
                if (key === 'milestone_impact') return f[key] ? '是' : '否';
                if (key === 'due_on' && !f[key] && f.kind === 'progress_report') return '主动汇报（不抵应交）';
                return f[key] == null || f[key] === '' ? '—' : String(f[key]);
            };
            host.appendChild(A.panel(entry.form_label || formNames[f.kind] || '登记表单', [A.facts((formFields[f.kind] || []).map(([key, title]) => [title, prose(valueOf(key))]))]));
        }
        const corrections = entryCorrectionsView(entry);
        if (corrections) host.appendChild(corrections);
        return host;
    }
    async function openEntryForm(detail, kind, options, c) {
        const opts = options || {};
        const lease = A.reserveDialog(c);
        const data = await A.request('/projects/' + detail.project.id + '/entries', null, lease);
        const meta = data.registration;
        const definition = meta && (meta.forms || []).find((f) => f.kind === kind);
        A.assertCurrent(lease);
        if (!definition || definition.allowed !== true) throw new Error(definition && definition.conditions || '当前没有此表单的登记入口，请刷新后核对权限。');
        const reporting = ['progress_report', 'report_cycle', 'report_request'].includes(kind);
        const plan = reporting ? await A.request('/projects/' + detail.project.id + '/plan', null, lease) : A.state.plan;
        const nodes = plan.nodes.filter((n) => reporting ? n.report !== null && n.report !== undefined : n.status !== 'cancelled');
        const defs = [{ name: 'node_id', label: reporting ? '关联开发节点' : '挂靠位置', required: reporting, value: opts.node_id || '', options: [[ '', reporting ? '请选择开发节点' : '项目整体' ], ...nodes.map((n) => [n.id, n.name])] }, { name: 'business_date', label: '业务发生日期', type: 'date' }];
        if (Array.isArray(meta.source_choices)) {
            const devOnly = kind === 'progress_report';
            const choices = meta.source_choices.filter((source) => !devOnly || detail.parties.some((p) => p.id === source.id && p.side === 'dev'));
            defs.push({ name: 'source_party', required: true, label: '本次登记的真实来源', value: devOnly && choices.length === 1 ? choices[0].id : ['report_cycle', 'report_request'].includes(kind) ? 'self' : '', options: [['', '请明确选择来源'], ...choices.map((p) => [p.id === null ? 'self' : p.id, p.label])], hint: devOnly ? 'PM 代登须明确为开发方来源。' : '选择 PM 本人登记时，不代表任何参与方作出意见。' });
        }
        if (kind === 'progress_report') defs.push(
            { name: 'due_on', label: '对应应交日', value: opts.due_on || '', options: [['', '主动汇报（不抵应交）']], hint: '清单来自当前节点的服务端应交事项；一份汇报满足同一天的全部来源。' },
            { name: 'done', label: '本期进展', type: 'textarea', required: true, max: 2000, full: true, hint: '至少10个字。' },
            { name: 'next', label: '下期计划', type: 'textarea', max: 2000, full: true },
            { name: 'risks', label: '风险', type: 'textarea', max: 1000, full: true },
            { name: 'milestone_impact', label: '本次汇报影响里程碑', type: 'checkbox', full: true });
        else if (kind === 'report_cycle') defs.push(
            { name: 'cycle', label: '汇报周期', required: true, options: [['weekly', '每周'], ['biweekly', '每两周'], ['monthly', '每月']] },
            { name: 'first_due_on', label: '首次应交日', type: 'date', required: true },
            { name: 'note', label: '节奏说明', type: 'textarea', max: 500, full: true });
        else if (kind === 'report_request') defs.push({ name: 'due_on', label: '应交日', type: 'date', required: true }, { name: 'reason', label: '汇报事由', type: 'textarea', required: true, max: 500, full: true, hint: '至少10个字；应交日为今天至未来31天内。' });
        if (kind === 'progress_report') defs.push(...noEvidenceFields());
        else defs.push({ name: 'files', label: '原始附件 / 截图（可选）', type: 'file', multiple: true, full: true });
        A.assertCurrent(lease);
        const form = A.dialog(formNames[kind], defs, async (v, cc) => {
            const f = Object.assign({ kind }, Object.fromEntries(formFields[kind].map(([key]) => [key, v[key]])));
            if (kind === 'progress_report') f.due_on = v.due_on || null;
            const direction = kind === 'progress_report' && v.milestone_impact === true;
            if (direction && v.no_written_evidence && v.files.length) throw new Error('证据附件与无书面证据声明应二选一');
            const body = { form: f, node_id: v.node_id ? A.id(v.node_id) : null, business_date: v.business_date || null, attachment_ids: await A.stageFiles(detail.project.id, v.files, cc) };
            if (direction) Object.assign(body, A.evidencePayload(v));
            if (Array.isArray(meta.source_choices)) body.source_party_id = v.source_party === 'self' ? null : A.id(v.source_party);
            const result = await A.request('/projects/' + detail.project.id + '/entries', { method: 'POST', body }, cc);
            if (reporting) {
                const route = location.hash;
                await A.render();
                const warning = [result.no_recipient === true ? '开发方没有可接收待办的人，请线下通知' : null, result.milestone_warning].filter(Boolean);
                if (warning.length && location.hash === route && cc.session === A.state.session && cc.userId === A.state.userId && cc.token === A.state.token && localStorage.getItem('token') === cc.token) A.notice(warning.join('；'));
            } else A.navigate({ project: detail.project.id, tab: 'entries', entry: result.entry.id });
        }, '保存' + formNames[kind], lease);
        form.prepend(A.hint(definition.conditions), A.hint('标题与正文由服务端生成。表单字段保存后不再改变；更正只追加勘误说明，业务判断仍使用原字段。'));
        if (kind === 'progress_report') {
            const nodeControl = form.querySelector('[name="node_id"]');
            const dueControl = form.querySelector('[name="due_on"]');
            const syncDue = () => {
                const node = nodes.find((n) => String(n.id) === nodeControl.value);
                dueControl.replaceChildren(...[['', '主动汇报（不抵应交）'], ...(node && node.report ? node.report.due_items : []).map((item) => [item.due_on, item.due_on + (item.submitted ? ' · 已交' : item.overdue ? ' · 逾期未交' : ' · 待交')])].map(([value, title]) => { const option = A.el('option', '', title); option.value = value; return option; }));
                if (opts.due_on && Array.from(dueControl.options).some((option) => option.value === opts.due_on)) dueControl.value = opts.due_on;
            };
            nodeControl.addEventListener('change', syncDue); syncDue();
            const milestone = form.querySelector('[name="milestone_impact"]');
            const syncMilestone = () => {
                const declaration = form.querySelector('[name="no_written_evidence"]');
                const reason = form.querySelector('[name="no_evidence_reason"]');
                declaration.closest('label').hidden = !milestone.checked; reason.closest('label').hidden = !milestone.checked;
                if (!milestone.checked) { declaration.checked = false; reason.required = false; reason.disabled = true; }
            };
            milestone.addEventListener('change', syncMilestone); syncMilestone();
        }
        return form;
    }
    async function register(detail, meta, c, initial) {
        const preset = initial || {};
        const lease = A.reserveDialog(c);
        A.assertCurrent(lease);
        if (!meta || !Array.isArray(meta.types) || !Array.isArray(meta.purposes)) throw new Error('登记选项未就绪，请刷新后重试');
        const defs = [
            { name: 'type', label: '登记类型', value: preset.type || 'note', required: true, options: meta.types.map((t) => [t, label(types, t)]) },
            { name: 'purpose', label: '用途', value: 'general', required: true, options: meta.purposes.map((p) => [p, label(purposes, p)]) },
            { name: 'node_id', label: '挂靠位置', value: preset.node_id || '', options: [['', '项目整体'], ...A.state.plan.nodes.filter((n) => n.status !== 'cancelled').map((n) => [n.id, n.name])] },
            { name: 'business_date', label: '业务发生日期', type: 'date' },
        ];
        if (Array.isArray(meta.source_choices)) defs.push({ name: 'source_party', label: '本次登记的真实来源', required: true, options: [['', '请明确选择本人登记或代登来源方'], ...meta.source_choices.map((p) => [p.id === null ? 'self' : p.id, p.label])], hint: '选择 PM 本人登记时，不代表任何参与方作出意见。' });
        defs.push(
            { name: 'title', label: '标题', value: '', max: 100, required: true, full: true },
            { name: 'body', label: '事实、意见或处理说明', value: '', type: 'textarea', max: 4000, required: true, full: true },
            ...noEvidenceFields(),
        );
        const form = A.dialog('追加登记', defs, async (v, cc) => {
            if (v.no_written_evidence && v.files.length) throw new Error('证据附件与无书面证据声明应二选一');
            const attachment_ids = await A.stageFiles(detail.project.id, v.files, cc);
            const body = { node_id: v.node_id ? A.id(v.node_id) : null, type: v.type, purpose: v.purpose, title: v.title, body: v.body, business_date: v.business_date || null, attachment_ids, ...A.evidencePayload(v) };
            if (Array.isArray(meta.source_choices)) body.source_party_id = v.source_party === 'self' ? null : A.id(v.source_party);
            const result = await A.request('/projects/' + detail.project.id + '/entries', { method: 'POST', body }, cc);
            A.navigate({ project: detail.project.id, tab: 'entries', entry: result.entry.id });
        }, '保存登记', lease);
        const typeControl = form.querySelector('[name="type"]');
        const fileControl = form.querySelector('[name="files"]');
        const requireFile = () => { fileControl.required = typeControl.value === 'material'; };
        typeControl.addEventListener('change', requireFile); requireFile();
    }
    async function act(detail, e, action, c) {
        const lease = A.reserveDialog(c);
        const defs = [];
        if (action === 'void') defs.push({ name: 'reason', label: '原因', type: 'textarea', required: true, max: 500, full: true });
        else defs.push({ name: 'text', label: '更正内容（保留原文）', type: 'textarea', required: true, max: 2000, full: true });
        const form = A.dialog(label(actions, action) + ' · 登记 #' + e.id, defs, async (v, cc) => {
            const body = { action };
            if ('reason' in v) body.reason = v.reason; else body.text = v.text || null;
            await A.request('/entries/' + e.id + '/actions', { method: 'POST', body }, cc);
            await A.render();
        }, label(actions, action), lease);
        if (action === 'correct' && e.form) form.prepend(A.hint('本次更正只追加勘误说明，原表单字段不变，相关业务判断仍按原字段；需要改变业务含义时另行登记并引用原编号。'));
    }
    function card(e, detail, c) {
        const ops = A.row(A.link('打开登记 #' + e.id, { project: detail.project.id, tab: 'entries', entry: e.id }));
        const sourceParty = detail.parties.find((party) => party.id === e.source_party_id);
        const source = e.source_party_id === null ? e.source_name || '本人登记（未代登参与方）' : (sourceParty ? sourceParty.name : '参与方 #' + e.source_party_id) + (e.source_name ? ' · ' + e.source_name : '');
        const node = A.panel(e.title, [A.facts([['登记类型', label(types, e.type)], ['来源', source], ['录入人', e.operator_name], ['登记时段', e.period === 'supplement' ? '补充登记 · 收口后 ' + (e.days_after_close == null ? '—' : e.days_after_close) + ' 天' : '过程登记']]), prose(e.body),
            A.row(e.voided ? A.text('已作废') : null, e.no_written_evidence ? A.text('无书面证据') : null),
            entryFormView(e),
        ], ops);
        node.classList.add(e.period === 'supplement' ? 'sbui-entry-supplement' : 'sbui-entry-process');
        return node;
    }
    async function entryDetail(detail, eid, c) {
        const data = await A.request('/entries/' + eid, null, c);
        const e = data.entry;
        if (Number(e.project_id) !== Number(detail.project.id)) throw new Error('该登记不属于当前项目');
        const host = A.el('div');
        host.appendChild(A.row(A.link('返回登记列表', { project: detail.project.id, tab: 'entries' })));
        host.appendChild(card(e, detail, c));
        if (e.no_written_evidence) host.appendChild(A.panel('无书面证据原因', [prose(e.no_evidence_reason)]));
        host.appendChild(A.panel('附件与原始凭据', [A.attachmentList(e.attachments, c)]));
        const ops = A.row();
        Object.keys(actions).forEach((key) => { if (e.actions[key] === true) ops.appendChild(A.command(actions[key], () => act(detail, e, key, c), ['void'].includes(key) ? 'danger' : '', c)); });
        host.appendChild(A.panel('办理', [A.hint('更正只追加内容、保留原文；作废后该登记不能再办理。'), ops]));
        host.appendChild(A.panel('办理记录 · 保留原文', [A.table(['时间', '动作', '内容', '操作人'], e.records.map((r) => [r.created_at, label(actions, r.action), prose(r.text), r.created_by_name]))]));
        return host;
    }
    async function entriesTab(detail, params, c) {
        if (params.has('entry')) return entryDetail(detail, A.id(params.get('entry')), c);
        const filters = new URLSearchParams();
        ['node', 'period', 'type', 'party'].forEach((key) => { const v = params.get('entry_' + key); if (v) filters.set(key, v); });
        const data = await A.request('/projects/' + detail.project.id + '/entries?' + filters.toString(), null, c);
        const host = A.el('div');
        const ops = data.actions.create_entry === true ? A.command('追加登记', () => register(detail, data.registration, c), 'primary', c) : null;
        const controls = A.row(ops);
        host.appendChild(A.panel('登记与办理', [A.hint('时段由系统按登记时的节点状态固化。补充登记不直接改动冻结内容。')], controls));
        host.appendChild(A.panel('筛选', [A.form([
            { name: 'node', label: '挂靠节点', value: filters.get('node') || '', options: [['', '全部'], ...A.state.plan.nodes.map((n) => [n.id, n.name])] },
            { name: 'period', label: '登记时段', value: filters.get('period') || '', options: [['', '全部'], ['process', '过程登记'], ['supplement', '补充登记']] },
            { name: 'type', label: '类型', value: filters.get('type') || '', options: [['', '全部'], ...Object.entries(types)] },
            { name: 'party', label: '来源参与方', value: filters.get('party') || '', options: [['', '全部'], ...detail.parties.map((p) => [p.id, p.name])] },
        ], (v) => {
            const next = { project: detail.project.id, tab: 'entries', ...Object.fromEntries(Object.entries(v).filter(([, value]) => value).map(([key, value]) => ['entry_' + key, value])) };
            A.navigate(next);
        }, '应用筛选', c)]));
        if (!data.entries.length) host.appendChild(A.panel('暂无符合条件的登记', [A.hint('可调整筛选条件。')]));
        data.entries.forEach((e) => host.appendChild(card(e, detail, c)));
        return host;
    }
    async function noticePage(params, c) {
        const data = await A.request('/notices/' + A.id(params.get('notice')), null, c);
        const n = data.notice;
        const host = A.panel('改期知会', [A.facts([['项目', n.system_name], ['接收人', n.recipient_name], ['知会时间', n.created_at]]), A.link('返回项目', { project: n.project_id })]);
        if (n.schedule) host.appendChild(A.panel('本次改期事实', [A.facts([['节点', n.schedule.node_name], ['改前计划', n.schedule.before ? n.schedule.before.start + ' → ' + n.schedule.before.end : '无'], ['改后计划', n.schedule.after.start + ' → ' + n.schedule.after.end]]), prose(n.schedule.reason), A.hint('第一期没有“已处理”或销除动作。')]));
        return host;
    }
    A.registerTab('entries', '登记与办理', entriesTab);
    A.openEntryForm = openEntryForm;
    A.entryFormView = entryFormView;
    A.entryCorrectionsView = entryCorrectionsView;
    A.registerRoute('notice', noticePage);
}());
