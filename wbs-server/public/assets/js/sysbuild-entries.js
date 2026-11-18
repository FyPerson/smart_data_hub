/* 登记、办理、待判定与知会。所有动作入口消费服务端 actions。 */
(function () {
    'use strict';
    const A = window.SysBuildUI;
    const types = { note: '补充说明', material: '补交材料', lesson: '经验教训', benefit: '使用与效益', feedback: '意见与反馈', issue: '问题与处理', correction: '更正' };
    const purposes = { general: '一般登记', dev_note: '开发方处理说明', deliverable: '正式交付物提交' };
    const conclusions = { handled: '已处理', adopted: '已采纳并入定稿材料', not_adopted: '不采纳', deferred: '留待后续', to_change: '转正式变更', to_sys_iteration: '转系统迭代', no_further: '业务确认不再处理', project_terminated: '项目已终止', for_reference: '仅供参考' };
    const states = { none: '待办理', settled_no_confirm: '结论已确定（无需另行确认）', pending_confirm: '待结论确认', confirmed: '结论已确认', objected: '结论有异议', escalated: '负责人裁定中', adjudicated: '裁定通过', adjudication_rejected: '裁定不认可', for_reference: '仅供参考', for_reference_objected: '仅供参考被异议', voided: '已作废', to_change_lapsed: '关联变更已撤回，原结论失效', terminated_conclusion_lapsed: '项目已重开，原终止结论失效', split: '已拆分为处理项' };
    const actions = { correct: '追加更正', void: '作废登记', conclude: '给出办理结论', for_reference: '记为仅供参考', mark_commitment: '补标涉及承诺', unmark_commitment: '取消涉及承诺', mark_risk: '补标风险', unmark_risk: '取消风险', escalate: '交负责人裁定', split: '拆分处理项', assign_items: '判定归属', link_sys_issue: '补记系统迭代单号', link_change: '关联正式变更' };
    const bases = { in_plan: '已生效规划内', planned_detail: '规划内尚未细化', out_of_plan: '规划外', undetermined: '尚未判定' };
    const routes = { project: '留在项目办理', sys_iteration: '转系统迭代', pending: '待判定' };
    const revisionStates = { pending: '待确认', confirmed: '已确认', objected: '有异议', rejected: '不认可', invalid: '已失效', superseded: '已被替代' };
    const confirmationMethods = { platform: '平台本人确认', card: '钉钉卡片', proxy: '凭据代录', history: '历史补录' };
    const label = (map, key) => map[key] || key || '—';
    const prose = (s) => A.el('div', 'sbui-longtext', s || '未填写');
    const itemOptions = (items) => items.map((it) => [it.id, it.code + ' · ' + ((it.versions || []).slice(-1)[0] || {}).content?.slice(0, 60)]);
    const ids = (values) => (values || []).map(A.id);
    function noEvidenceFields() { return [
        { name: 'files', label: '原始附件 / 截图', type: 'file', multiple: true, full: true },
        { name: 'no_written_evidence', label: '确无书面证据', type: 'checkbox' },
        { name: 'no_evidence_reason', label: '无书面证据的原因', type: 'textarea', max: 500, full: true, hint: '勾选声明时至少10个字；与本次证据附件二选一。补交材料和正式交付物必须有附件，声明不能替代。' },
    ]; }
    const formNames = { change_request: '需求变更申请', dev_assessment: '开发评估', progress_report: '进度汇报', report_cycle: '汇报节奏', report_request: '临时汇报要求' };
    const formFields = {
        change_request: [['change_kind', '变更种类'], ['content', '变更内容'], ['reason', '原因'], ['problem', '要解决的问题']],
        dev_assessment: [['about_change_id', '正式变更编号'], ['feasible', '能否做'], ['extra_person_days', '增加工时（人日）'], ['schedule_impact_days', '工期影响（天）'], ['impact_note', '工期影响与受影响节点'], ['premise', '前提与风险']],
        progress_report: [['due_on', '对应应交日'], ['done', '已完成'], ['next', '下一步'], ['risks', '风险'], ['milestone_impact', '是否影响里程碑']],
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
                if (key === 'change_kind') return label({ add: '新增', modify: '修改', cancel: '取消' }, f[key]);
                if (key === 'feasible') return label({ yes: '能做', partial: '部分能做', no: '不能做' }, f[key]);
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
            const devOnly = ['dev_assessment', 'progress_report'].includes(kind);
            const choices = meta.source_choices.filter((source) => !devOnly || detail.parties.some((p) => p.id === source.id && p.side === 'dev'));
            defs.push({ name: 'source_party', required: true, label: '本次登记的真实来源', value: devOnly && choices.length === 1 ? choices[0].id : ['report_cycle', 'report_request'].includes(kind) ? 'self' : '', options: [['', '请明确选择来源'], ...choices.map((p) => [p.id === null ? 'self' : p.id, p.label])], hint: devOnly ? 'PM 代登须明确为开发方来源。' : '选择 PM 本人登记时，不代表任何参与方作出意见。' });
        }
        if (kind === 'change_request') {
            const items = await A.request('/projects/' + detail.project.id + '/items', null, lease);
            defs.push({ name: 'change_kind', label: '变更种类', required: true, options: [['add', '新增'], ['modify', '修改'], ['cancel', '取消']] },
                { name: 'content', label: '变更内容', type: 'textarea', required: true, max: 2000, full: true },
                { name: 'reason', label: '原因', type: 'textarea', required: true, max: 1000, full: true, hint: '至少10个字。' },
                { name: 'problem', label: '要解决的问题', type: 'textarea', required: true, max: 1000, full: true, hint: '至少10个字。' },
                { name: 'item_ids', label: '关联需求条目', type: 'checklist', options: itemOptions(items.items), full: true, hint: '修改或取消须关联至少一个条目；混合归属请分开登记。' });
        } else if (kind === 'dev_assessment') {
            if (!opts.about_change_id) {
                const changes = await A.request('/projects/' + detail.project.id + '/changes', null, lease);
                defs.push({ name: 'about_change_id', label: '正式变更草稿', required: true, options: [['', '请选择本次评估的变更'], ...changes.changes.filter((ch) => ch.versions.some((v) => v.status === 'draft')).map((ch) => [ch.id, '#' + ch.id + ' ' + ch.title])] });
            }
            defs.push({ name: 'feasible', label: '能否做', required: true, options: [['yes', '能做'], ['partial', '部分能做'], ['no', '不能做']] },
                { name: 'extra_person_days', label: '增加工时（人日）', type: 'number', required: true, min: 0, value: '0', hint: '0–9999，至多一位小数。' },
                { name: 'schedule_impact_days', label: '工期影响（天）', type: 'number', required: true, min: 0, value: '0', hint: '0–3650 的整数。' },
                { name: 'impact_note', label: '工期影响与受影响节点', type: 'textarea', max: 1000, full: true, hint: '有工期影响，或部分能做 / 不能做时至少10个字。' },
                { name: 'premise', label: '前提与风险', type: 'textarea', max: 1000, full: true });
        } else if (kind === 'progress_report') defs.push(
            { name: 'due_on', label: '对应应交日', value: opts.due_on || '', options: [['', '主动汇报（不抵应交）']], hint: '清单来自当前节点的服务端应交事项；一份汇报满足同一天的全部来源。' },
            { name: 'done', label: '已完成', type: 'textarea', required: true, max: 2000, full: true, hint: '至少10个字。' },
            { name: 'next', label: '下一步', type: 'textarea', required: true, max: 2000, full: true, hint: '至少10个字。' },
            { name: 'risks', label: '风险', type: 'textarea', max: 1000, full: true },
            { name: 'milestone_impact', label: '本次汇报影响里程碑', type: 'checkbox', full: true });
        else if (kind === 'report_cycle') defs.push(
            { name: 'cycle', label: '汇报周期', required: true, options: [['weekly', '每周'], ['biweekly', '每两周'], ['monthly', '每月']] },
            { name: 'first_due_on', label: '首次应交日', type: 'date', required: true },
            { name: 'note', label: '节奏说明', type: 'textarea', max: 500, full: true });
        else if (kind === 'report_request') defs.push({ name: 'due_on', label: '应交日', type: 'date', required: true }, { name: 'reason', label: '汇报事由', type: 'textarea', required: true, max: 500, full: true, hint: '至少10个字；应交日为今天至未来31天内。' });
        if (kind === 'change_request' || kind === 'progress_report') defs.push(...noEvidenceFields());
        else defs.push({ name: 'files', label: '原始附件 / 截图（可选）', type: 'file', multiple: true, full: true });
        if (meta.self_confirm && meta.self_confirm.enabled === true && ['dev_assessment', 'progress_report'].includes(kind)) defs.push({ name: 'self_ack', label: meta.self_confirm.text, type: 'checkbox', full: true });
        A.assertCurrent(lease);
        const form = A.dialog(formNames[kind], defs, async (v, cc) => {
            const f = Object.assign({ kind }, Object.fromEntries(formFields[kind].map(([key]) => [key, v[key]])));
            if (kind === 'dev_assessment') { f.about_change_id = A.id(opts.about_change_id || v.about_change_id); f.extra_person_days = Number(v.extra_person_days); f.schedule_impact_days = Number(v.schedule_impact_days); }
            if (kind === 'progress_report') f.due_on = v.due_on || null;
            const selfNeeded = meta.self_confirm && meta.self_confirm.enabled === true && (kind === 'dev_assessment' || kind === 'progress_report' && v.milestone_impact === true);
            if (selfNeeded && v.self_ack !== true) throw new Error('本次提交同时构成开发方负责人本人认可，请阅读并勾选声明');
            const direction = kind === 'change_request' || kind === 'progress_report' && v.milestone_impact === true;
            if (direction && v.no_written_evidence && v.files.length) throw new Error('证据附件与无书面证据声明应二选一');
            const body = { form: f, node_id: v.node_id ? A.id(v.node_id) : null, business_date: v.business_date || null, attachment_ids: await A.stageFiles(detail.project.id, v.files, cc) };
            if (kind === 'change_request') body.item_ids = ids(v.item_ids);
            if (direction) Object.assign(body, A.evidencePayload(v));
            if (Array.isArray(meta.source_choices)) body.source_party_id = v.source_party === 'self' ? null : A.id(v.source_party);
            if (selfNeeded) body.self_confirm_text = meta.self_confirm.text;
            const result = await A.request('/projects/' + detail.project.id + '/entries', { method: 'POST', body }, cc);
            if (reporting) {
                const route = location.hash;
                await A.render();
                const warning = [result.no_recipient === true ? '开发方没有可接收待办的人，请线下通知' : null, result.milestone_warning].filter(Boolean);
                if (warning.length && location.hash === route && cc.session === A.state.session && cc.userId === A.state.userId && cc.token === A.state.token && localStorage.getItem('token') === cc.token) A.notice(warning.join('；'));
            } else A.navigate({ project: detail.project.id, tab: 'entries', entry: result.entry.id });
        }, '保存' + formNames[kind], lease);
        form.prepend(A.hint(definition.conditions), A.hint('标题与正文由服务端生成。表单字段保存后不再改变；更正只追加勘误说明，业务判断仍使用原字段。'));
        if (kind === 'dev_assessment') {
            if (opts.about_change_id) form.prepend(A.hint('本次评估针对正式变更 #' + opts.about_change_id + ' 的当前草稿；认可评估不构成实施授权。'));
            form.querySelector('[name="extra_person_days"]').step = '0.1';
            form.querySelector('[name="extra_person_days"]').max = '9999';
            form.querySelector('[name="schedule_impact_days"]').max = '3650';
            const syncImpact = () => { form.querySelector('[name="impact_note"]').required = form.querySelector('[name="feasible"]').value !== 'yes' || Number(form.querySelector('[name="schedule_impact_days"]').value) > 0; };
            form.querySelector('[name="feasible"]').addEventListener('change', syncImpact); form.querySelector('[name="schedule_impact_days"]').addEventListener('input', syncImpact); syncImpact();
        }
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
                const ack = form.querySelector('[name="self_ack"]');
                if (ack) { ack.required = milestone.checked; ack.closest('label').hidden = !milestone.checked; ack.checked = false; }
            };
            milestone.addEventListener('change', syncMilestone); syncMilestone();
        } else if (kind === 'dev_assessment' && form.querySelector('[name="self_ack"]')) form.querySelector('[name="self_ack"]').required = true;
        return form;
    }
    async function register(detail, meta, c, old, initial) {
        const preset = initial || {};
        const lease = A.reserveDialog(c);
        const list = await A.request('/projects/' + detail.project.id + '/items', null, lease);
        A.assertCurrent(lease);
        if (!meta || !Array.isArray(meta.types) || !Array.isArray(meta.purposes)) throw new Error('登记选项未就绪，请刷新后重试');
        const defs = [
            { name: 'type', label: '登记类型', value: old && old.type || preset.type || 'note', required: true, options: meta.types.map((t) => [t, label(types, t)]) },
            { name: 'purpose', label: '用途', value: old && old.purpose || 'general', required: true, options: meta.purposes.map((p) => [p, label(purposes, p)]) },
            { name: 'node_id', label: '挂靠位置', value: old && old.node_id || preset.node_id || '', options: [['', '项目整体'], ...A.state.plan.nodes.filter((n) => n.status !== 'cancelled').map((n) => [n.id, n.name])] },
            { name: 'business_date', label: '业务发生日期', type: 'date' },
        ];
        if (Array.isArray(meta.source_choices)) defs.push({ name: 'source_party', label: '本次登记的真实来源', required: true, options: [['', '请明确选择本人登记或代登来源方'], ...meta.source_choices.map((p) => [p.id === null ? 'self' : p.id, p.label])], hint: '选择 PM 本人登记时，不代表任何参与方作出意见。' });
        defs.push(
            { name: 'title', label: '标题', value: old && old.title || '', max: 100, required: true, full: true },
            { name: 'body', label: '事实、意见或处理说明', value: old && old.body || '', type: 'textarea', max: 4000, required: true, full: true },
            { name: 'item_ids', label: '关联需求条目', type: 'checklist', options: itemOptions(list.items), value: old && old.items ? old.items.map((item) => item.item_id) : [], full: true, hint: '未选择时先记为尚未判定；分流与登记时段均由服务端按当前事实固化。' },
            { name: 'commitment_flag', label: '涉及本方承诺', type: 'checkbox', value: old && old.commitment_current === true },
            { name: 'is_risk', label: '标记为风险', type: 'checkbox', value: old && old.risk_current === true },
            ...noEvidenceFields(),
        );
        if (meta.self_confirm && meta.self_confirm.enabled === true) defs.push({ name: 'self_ack', label: meta.self_confirm.text, type: 'checkbox', full: true });
        const form = A.dialog(old ? '修订重提 · 原登记 #' + old.id : '追加登记', defs, async (v, cc) => {
            const selfNeeded = meta.self_confirm && meta.self_confirm.enabled === true && (meta.self_confirm.purposes.includes(v.purpose) || v.commitment_flag === true);
            if (selfNeeded && v.self_ack !== true) throw new Error('本次提交同时构成开发方负责人本人认可，请阅读并勾选声明');
            if (v.no_written_evidence && v.files.length) throw new Error('证据附件与无书面证据声明应二选一');
            const attachment_ids = await A.stageFiles(detail.project.id, v.files, cc);
            const body = { node_id: v.node_id ? A.id(v.node_id) : null, type: v.type, purpose: v.purpose, title: v.title, body: v.body, business_date: v.business_date || null, item_ids: ids(v.item_ids), commitment_flag: v.commitment_flag, is_risk: v.is_risk, attachment_ids, ...A.evidencePayload(v) };
            if (Array.isArray(meta.source_choices)) body.source_party_id = v.source_party === 'self' ? null : A.id(v.source_party);
            if (selfNeeded) body.self_confirm_text = meta.self_confirm.text;
            if (old) body.revision_of_entry_id = old.id;
            const result = await A.request('/projects/' + detail.project.id + '/entries', { method: 'POST', body }, cc);
            A.navigate({ project: detail.project.id, tab: 'entries', entry: result.entry.id });
        }, old ? '保存为新的修订登记' : '保存登记', lease);
        const typeControl = form.querySelector('[name="type"]');
        const purposeControl = form.querySelector('[name="purpose"]');
        const fileControl = form.querySelector('[name="files"]');
        const requireFile = () => { fileControl.required = typeControl.value === 'material' || purposeControl.value === 'deliverable'; };
        typeControl.addEventListener('change', requireFile); purposeControl.addEventListener('change', requireFile); requireFile();
        const ack = form.querySelector('[name="self_ack"]');
        if (ack) {
            const purpose = form.querySelector('[name="purpose"]');
            const commitment = form.querySelector('[name="commitment_flag"]');
            const update = () => {
                const required = meta.self_confirm.purposes.includes(purpose.value) || commitment.checked;
                ack.required = required; ack.closest('label').hidden = !required; ack.checked = false;
            };
            purpose.addEventListener('change', update); commitment.addEventListener('change', update); update();
        }
    }
    function objectToEntry(detail, e, c) {
        A.assertCurrent(c);
        A.dialog('对已有结论提出异议 · #' + e.id, [
            { name: 'type', label: '异议类型', options: [['feedback', '意见与反馈'], ['issue', '问题与处理']], required: true },
            { name: 'title', label: '标题', max: 100, value: '对登记 #' + e.id + ' 的异议', required: true, full: true },
            { name: 'body', label: '异议事实与理由', type: 'textarea', max: 4000, required: true, full: true }, ...noEvidenceFields(),
        ], async (v, cc) => {
            const attachment_ids = await A.stageFiles(detail.project.id, v.files, cc);
            const result = await A.request('/projects/' + detail.project.id + '/entries', { method: 'POST', body: { objects_entry_id: e.id, type: v.type, title: v.title, body: v.body, attachment_ids, ...A.evidencePayload(v) } }, cc);
            A.navigate({ project: detail.project.id, tab: 'entries', entry: result.entry.id });
        }, '追加异议登记');
    }
    async function act(detail, e, action, c) {
        const lease = A.reserveDialog(c);
        const defs = [];
        let candidates = null;
        if (['conclude', 'link_change', 'assign_items'].includes(action)) {
            const [items, changes, entries] = await Promise.all([
                A.request('/projects/' + detail.project.id + '/items', null, lease),
                A.request('/projects/' + detail.project.id + '/changes', null, lease),
                A.request('/projects/' + detail.project.id + '/entries', null, lease),
            ]);
            A.assertCurrent(lease); candidates = { items, changes, entries };
        }
        if (['void', 'mark_commitment', 'unmark_commitment', 'mark_risk', 'unmark_risk'].includes(action)) defs.push({ name: 'reason', label: '原因', type: 'textarea', required: true, max: 500, full: true });
        else defs.push({ name: 'text', label: action === 'correct' ? '更正内容（保留原文）' : action === 'assign_items' ? '判定依据' : '说明', type: 'textarea', required: ['correct', 'conclude', 'assign_items'].includes(action), max: 2000, full: true });
        if (action === 'conclude') defs.unshift({ name: 'conclusion_kind', label: '结论类别', required: true, options: [['', '请选择当前允许的结论'], ...e.actions.conclude_kinds.map((k) => [k, label(conclusions, k)])] });
        if (['conclude', 'link_change'].includes(action)) defs.push({ name: 'change_id', label: '关联正式变更', required: action === 'link_change', options: [['', '请选择已建立的正式变更'], ...candidates.changes.changes.filter((ch) => ch.status !== 'withdrawn').map((ch) => [ch.id, '#' + ch.id + ' ' + ch.title])] });
        if (action === 'conclude') defs.push(
            { name: 'assignee_text', label: '承接人 / 后续节点说明', max: 100 },
            { name: 'sys_issue_no', label: '系统迭代单号', max: 32 },
            { name: 'basis_dev_note_entry_id', label: '引用已获认可的开发方处理说明（可选）', options: [['', '不引用开发方说明，由 PM 核实'], ...candidates.entries.entries.filter((v) => v.purpose === 'dev_note' && v.dev_confirm.status === 'approved' && !v.voided).map((v) => [v.id, '#' + v.id + ' ' + v.title])] },
        );
        if (action === 'link_sys_issue') defs.push({ name: 'sys_issue_no', label: '系统迭代单号', max: 32, required: true });
        if (action === 'assign_items') defs.push(
            { name: 'basis_category', label: '判定依据类别', required: true, options: [['', '请选择'], ...['in_plan', 'planned_detail', 'out_of_plan'].map((k) => [k, bases[k]])] },
            { name: 'item_ids', label: '关联需求条目', type: 'checklist', options: itemOptions(candidates.items.items), full: true },
            { name: 'route', label: '规划外事项去向', options: [['', '仅规划外需要明确选择'], ['project', routes.project], ['sys_iteration', routes.sys_iteration]] },
        );
        const splitItems = action === 'split' ? Array.from(new Map((e.items || []).map((item) => [item.item_id, item])).values()) : [];
        if (action === 'split') splitItems.forEach((item) => defs.push({ name: 'group_' + item.item_id, label: item.code + ' 归入处理组', required: true, options: splitItems.map((_, index) => [index + 1, '处理组 ' + (index + 1)]) }));
        const form = A.dialog(label(actions, action) + ' · 登记 #' + e.id, defs, async (v, cc) => {
            const body = { action };
            if ('reason' in v) body.reason = v.reason; else body.text = v.text || null;
            if (action === 'conclude') {
                body.conclusion_kind = v.conclusion_kind;
                if (['deferred', 'to_sys_iteration'].includes(v.conclusion_kind)) body.assignee_text = v.assignee_text;
                if (v.conclusion_kind === 'to_sys_iteration') body.sys_issue_no = v.sys_issue_no;
                if (v.conclusion_kind === 'to_change') body.change_id = A.id(v.change_id);
                if (v.basis_dev_note_entry_id) body.basis_dev_note_entry_id = A.id(v.basis_dev_note_entry_id);
            }
            if (action === 'link_change') body.change_id = A.id(v.change_id);
            if (action === 'link_sys_issue') body.sys_issue_no = v.sys_issue_no;
            if (action === 'assign_items') {
                body.basis_category = v.basis_category;
                body.item_ids = v.basis_category === 'out_of_plan' ? [] : ids(v.item_ids);
                if (v.basis_category === 'out_of_plan') body.route = v.route;
            }
            if (action === 'split') {
                const groups = new Map();
                splitItems.forEach((item) => { const key = v['group_' + item.item_id]; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(item.item_id); });
                body.groups = Array.from(groups.values());
                if (body.groups.length < 2) throw new Error('至少分成两个非空处理组');
            }
            await A.request('/entries/' + e.id + '/actions', { method: 'POST', body }, cc);
            await A.render();
        }, label(actions, action), lease);
        if (action === 'conclude') {
            form.prepend(A.panel('结论需要附材料时', [
                A.hint('请先补交材料，再回到本登记填写结论并引用材料登记编号。补交材料只是可查的材料索引，不进入本轮结论确认的冻结清单，也不因文字引用而受作废保护，不能作为提出方已看过并确认的凭据。'),
                A.command('先补交材料', () => register(detail, candidates.entries.registration, c, null, { type: 'material', node_id: e.node_id }), '', c),
            ]));
            const kind = form.querySelector('[name="conclusion_kind"]');
            const update = () => {
                const visible = { change_id: kind.value === 'to_change', assignee_text: ['deferred', 'to_sys_iteration'].includes(kind.value), sys_issue_no: kind.value === 'to_sys_iteration' };
                Object.entries(visible).forEach(([name, show]) => { const control = form.querySelector('[name="' + name + '"]'); control.closest('label').hidden = !show; control.required = show; });
            };
            kind.addEventListener('change', update); update();
        }
        if (action === 'correct' && e.form) form.prepend(A.hint('本次更正只追加勘误说明，原表单字段不变，相关业务判断仍按原字段；需要改变业务含义时另行登记并引用原编号。'));
    }
    function card(e, detail, c) {
        const ops = A.row(A.link('打开登记 #' + e.id, { project: detail.project.id, tab: 'entries', entry: e.id }));
        const sourceParty = detail.parties.find((party) => party.id === e.source_party_id);
        const source = e.source_party_id === null ? e.source_name || '本人登记（未代登参与方）' : (sourceParty ? sourceParty.name : '参与方 #' + e.source_party_id) + (e.source_name ? ' · ' + e.source_name : '');
        const node = A.panel(e.title, [A.facts([['登记类型', label(types, e.type)], ['来源', source], ['录入人', e.operator_name], ['状态', e.voided ? '已作废' : label(states, e.conclusion_state)], ['登记时段', e.period === 'supplement' ? '补充登记 · 收口后 ' + (e.days_after_close == null ? '—' : e.days_after_close) + ' 天' : '过程登记'], ['归属', e.routing ? label(bases, e.routing.basis_category) + ' · ' + label(routes, e.routing.route) : '无当前归属']]), prose(e.body),
            A.row(e.commitment_current ? A.text('涉及承诺') : null, e.risk_current ? A.text('风险') : null, e.no_written_evidence ? A.text('无书面证据') : null, e.dev_confirm && e.dev_confirm.required ? A.text(e.dev_confirm.label) : null),
            entryFormView(e),
            e.current_conclusion ? A.panel('当前结论 · ' + label(conclusions, e.current_conclusion.kind), [prose(e.current_conclusion.text)]) : null,
        ], ops);
        node.classList.add(e.period === 'supplement' ? 'sbui-entry-supplement' : 'sbui-entry-process');
        return node;
    }
    async function entryDetail(detail, eid, c, meta) {
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
        if (e.actions.object === true) ops.appendChild(A.button('对已有结论提异议', () => objectToEntry(detail, e, c)));
        if (e.actions.revise === true) ops.appendChild(A.command('修订重提给开发方负责人', () => register(detail, meta, c, e), '', c));
        host.appendChild(A.panel('办理', [A.hint('已确认的结论不能改成“已处理”绕过原决定。收口后异议若涉及冻结范围或验收标准，应评估转正式变更；由 PM 按实际内容判断。'), ops]));
        if (e.dev_confirm && e.dev_confirm.task_id) host.appendChild(A.panel('开发方关键事项认可', [A.hint(e.dev_confirm.label + '；必需确认人：' + (e.dev_confirm.required_name || '—')), A.link('打开认可任务', { task: e.dev_confirm.task_id })]));
        if (e.items.length) host.appendChild(A.panel('当前关联条目', [A.table(['条目', '关联版本'], e.items.map((item) => [item.code, 'v' + item.version_no]))]));
        if (e.split_children.length) host.appendChild(A.panel('拆分后的处理项', [A.row(...e.split_children.map((child) => A.link('处理项 #' + child.id + (child.resolved ? ' · 已结' : ' · 未结'), { project: detail.project.id, tab: 'entries', entry: child.id })))]));
        host.appendChild(A.panel('办理记录 · 保留原文', [A.table(['时间', '动作', '内容', '操作人'], e.records.map((r) => [r.created_at, label(actions, r.action) + (r.conclusion_kind ? ' · ' + label(conclusions, r.conclusion_kind) : ''), prose(r.text), r.created_by_name]))]));
        e.confirm_tasks.forEach((t) => host.appendChild(A.panel('确认任务 #' + t.task_id, [A.link('明确打开任务全文', { task: t.task_id }), A.table(['修订', '当时必需确认人', '状态', '确认方式 / 原因'], t.revisions.map((r) => ['第 ' + r.rev_no + ' 次', r.required_name + (r.proxy_only ? ' · 仅凭据代录' : ''), label(revisionStates, r.status), r.confirmation ? label(confirmationMethods, r.confirmation.method) + ' · ' + (r.confirmation.reason || label({ confirm: '确认', object: '有异议', reject: '不认可' }, r.confirmation.decision)) : r.status_reason || '尚无记录']))])));
        e.notices.forEach((n) => host.appendChild(A.panel('知会 #' + n.id, [A.text(n.recipient_name), n.objection ? prose(n.objection.reason) : A.hint('暂无异议记录'), n.actions.object ? A.button('对本条知会提异议', () => objectNotice(n.id, c)) : null])));
        host.appendChild(A.disclosure('归属判定历史', A.table(['判定时间', '依据类别', '去向', '当时总体版本 / 条目版本'], e.routing_snapshots.map((s) => [s.decided_at, label(bases, s.basis_category), label(routes, s.route), '#' + (s.overall_package_version_id || '—') + ' / #' + (s.item_version_id || '—')]))));
        return host;
    }
    async function entriesTab(detail, params, c) {
        const filters = new URLSearchParams();
        ['node', 'period', 'type', 'party', 'routing'].forEach((key) => { const v = params.get('entry_' + key); if (v) filters.set(key, v); });
        const data = await A.request('/projects/' + detail.project.id + '/entries?' + filters.toString(), null, c);
        if (params.has('entry')) return entryDetail(detail, A.id(params.get('entry')), c, data.registration);
        const host = A.el('div');
        const ops = data.actions.create_entry === true ? A.command('追加登记', () => register(detail, data.registration, c), 'primary', c) : null;
        const controls = A.row(ops);
        const changeForm = (data.registration.forms || []).find((f) => f.kind === 'change_request');
        if (changeForm && changeForm.allowed === true) controls.appendChild(A.command('需求变更申请', () => openEntryForm(detail, 'change_request', {}, c), '', c));
        host.appendChild(A.panel('登记与办理', [A.hint('时段由系统按登记时的节点状态固化。补充登记不直接改动冻结内容，正式变更须另行确认。'), changeForm ? A.hint('需求变更申请：' + changeForm.conditions) : null], controls));
        host.appendChild(A.panel('筛选', [A.form([
            { name: 'node', label: '挂靠节点', value: filters.get('node') || '', options: [['', '全部'], ...A.state.plan.nodes.map((n) => [n.id, n.name])] },
            { name: 'period', label: '登记时段', value: filters.get('period') || '', options: [['', '全部'], ['process', '过程登记'], ['supplement', '补充登记']] },
            { name: 'type', label: '类型', value: filters.get('type') || '', options: [['', '全部'], ...Object.entries(types)] },
            { name: 'party', label: '来源参与方', value: filters.get('party') || '', options: [['', '全部'], ...detail.parties.map((p) => [p.id, p.name])] },
            { name: 'routing', label: '归属状态', value: filters.get('routing') || '', options: [['', '全部'], ['pending', '待判定（PM看全项目，其他人看本人）']] },
        ], (v) => {
            const next = { project: detail.project.id, tab: 'entries', ...Object.fromEntries(Object.entries(v).filter(([, value]) => value).map(([key, value]) => ['entry_' + key, value])) };
            A.navigate(next);
        }, '应用筛选', c)]));
        if (!data.entries.length) host.appendChild(A.panel('暂无符合条件的登记', [A.hint('可调整筛选条件。')]));
        data.entries.forEach((e) => host.appendChild(card(e, detail, c)));
        return host;
    }
    function objectNotice(id, c) {
        A.assertCurrent(c);
        A.dialog('对知会提出异议', [{ name: 'reason', label: '异议原因', type: 'textarea', required: true, max: 500, full: true }], async (v, cc) => {
            await A.request('/notices/' + id + '/object', { method: 'POST', body: { reason: v.reason } }, cc); await A.render();
        }, '提交异议');
    }
    async function noticePage(params, c) {
        const data = await A.request('/notices/' + A.id(params.get('notice')), null, c);
        const n = data.notice;
        const host = A.panel(n.kind === 'schedule_change' ? '改期知会' : '仅供参考知会', [A.facts([['项目', n.system_name], ['接收人', n.recipient_name], ['知会时间', n.created_at]]), A.link('返回项目', { project: n.project_id })]);
        if (n.schedule) host.appendChild(A.panel('本次改期事实', [A.facts([['节点', n.schedule.node_name], ['改前计划', n.schedule.before ? n.schedule.before.start + ' → ' + n.schedule.before.end : '无'], ['改后计划', n.schedule.after.start + ' → ' + n.schedule.after.end]]), prose(n.schedule.reason), A.hint('知会异议转 PM，不阻塞已经完成的改期。第一期没有“已处理”或销除动作。')]));
        if (n.entry) host.appendChild(A.panel(n.entry.title, [prose(n.entry.body), n.entry.current_conclusion ? prose(n.entry.current_conclusion.text) : null, A.link('打开原登记与办理记录', { project: n.project_id, tab: 'entries', entry: n.entry.id })]));
        if (n.objection) host.appendChild(A.panel('已记录的异议', [prose(n.objection.reason), A.hint(n.objection.created_at)]));
        if (n.actions.object === true) host.appendChild(A.button('对本条知会提异议', () => objectNotice(n.id, c)));
        return host;
    }
    A.registerTab('entries', '登记与办理', entriesTab);
    A.openEntryForm = openEntryForm;
    A.entryFormView = entryFormView;
    A.entryCorrectionsView = entryCorrectionsView;
    A.entryConclusions = conclusions;
    A.registerRoute('notice', noticePage);
}());
