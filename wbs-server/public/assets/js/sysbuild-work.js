(function () {
    'use strict';
    const A = window.SysBuildUI;
    const categories = { requirement: '需求调整', problem: '问题', improvement: '优化建议', cut: '砍需求' };
    const opinionStates = { triage: '待 PM 初判', assessment: '待开发给意见与工时', disposition: '待 PM 定去向', cut_approval: '待需求方负责人同意' };
    const outcomes = { now: '本期做', next: '留到下一期', no: '不做', cut_agreed: '同意本期移出范围', scope_kept: '维持原范围' };
    const taskStates = { pending: '待办', done: '已完成', cancelled: '已取消' };
    const evidence = { name: 'files', label: '附件', type: 'file', multiple: true, full: true };
    const hours = { name: 'estimated_hours', label: '工时（小时）', type: 'number', min: 0, required: true };
    const opinionPath = (id) => '/opinions/' + id;
    const actionPath = (id) => opinionPath(id) + '/actions';
    const href = (project, opinion) => ({ project, tab: 'opinions', opinion });
    const taskHref = (project, node, workTask) => ({ project, tab: 'plan', node, work_task: workTask });
    const textField = (name, label, max, required = false) => ({ name, label, max, required, type: 'textarea', full: true });
    const prose = (text) => A.el('div', 'sbui-pre', text || '—');
    const opinionState = (opinion) => opinionStates[opinion.status] || outcomes[opinion.outcome];

    function waitingFor(opinion) {
        const waiting = opinion.waiting_for;
        if (!waiting) return '—';
        if (waiting.role === 'demand') {
            return A.append(A.el('ul', 'sbui-opinion-waiters'), waiting.parties.map((p) => A.el('li', '', p.party_name + ' · ' + (p.name || '待指定'))));
        }
        return (waiting.role === 'pm' ? 'PM' : '开发负责人') + ' · ' + (waiting.name || '待指定');
    }
    function proposedAt(opinion, nodes) {
        const name = nodes.find((node) => node.id === opinion.node_id)?.name;
        return name ? name + ' #' + opinion.node_id : '—';
    }

    function enableDecimal(form) {
        const input = form.querySelector('[name="estimated_hours"]');
        if (input) input.step = 'any';
        return form;
    }
    async function propose(detail, c) {
        const pid = detail.project.id;
        const lease = A.reserveDialog(c);
        const data = await A.request('/projects/' + pid + '/opinions', null, lease);
        A.assertCurrent(lease);
        if (data.actions.create !== true) throw new Error('当前账号不能提出意见');
        const self = data.actions.self_assess === true;
        enableDecimal(A.dialog('提意见或需求', [
            { name: 'title', label: '标题', max: 100, required: true, full: true },
            textField('body', '内容', 4000, true),
            ...(self ? [hours] : []), evidence,
        ], async (v, cc) => {
            const body = { title: v.title, body: v.body, attachment_ids: await A.stageFiles(pid, v.files, cc) };
            if (self) body.estimated_hours = Number(v.estimated_hours);
            const result = await A.request('/projects/' + pid + '/opinions', { method: 'POST', body }, cc);
            A.navigate(href(pid, result.opinion.id));
        }, '提交意见', lease));
    }
    function proposalButton(detail, c) {
        return detail.actions.create_opinion === true
            ? A.command('提意见或需求', (cc) => propose(detail, cc), 'primary', c)
            : null;
    }
    function triage(opinion, c) {
        const choices = Object.entries(categories).filter(([key]) => key !== 'cut' || opinion.author_side === 'dev');
        const form = A.dialog('PM 初判', [
            { name: 'category', label: '分类', required: true, options: choices,
                hint: opinion.author_side === 'dev' ? '已经确认的范围可归为砍需求。范围尚未确认时按需求调整处理。' : null },
            { name: 'decision', label: '初判结果', options: [['continue', '继续办理'], ['no', '不做，答复提出人']], required: true },
            textField('text', '初判意见', 4000, true),
            { name: 'needs_assessment', label: '需要开发评估', options: [['yes', '需要'], ['no', '不需要']] },
            textField('skip_reason', '跳过开发评估的原因', 500),
        ], async (v, cc) => {
            const body = { action: 'triage', category: v.category, text: v.text, decision: v.decision };
            if (v.category !== 'cut' && v.decision === 'continue' && v.needs_assessment === 'no') {
                body.needs_assessment = false;
                body.skip_reason = v.skip_reason;
            }
            await A.request(actionPath(opinion.id), { method: 'POST', body }, cc);
            await A.render();
        }, '保存初判', A.reserveDialog(c));
        const field = (name) => form.querySelector('[name="' + name + '"]');
        function refreshOptions() {
            const show = field('category').value !== 'cut' && field('decision').value === 'continue';
            field('needs_assessment').closest('label').hidden = !show;
            field('skip_reason').closest('label').hidden = !show || field('needs_assessment').value !== 'no';
        }
        form.addEventListener('change', refreshOptions);
        refreshOptions();
    }
    function assess(detail, opinion, c) {
        const proxy = opinion.actions.assess_mode === 'proxy';
        enableDecimal(A.dialog(proxy ? '代录开发意见与工时' : '填写开发意见与工时', [
            textField('text', '开发意见', 4000, true), hours,
            { ...evidence, label: proxy ? '开发方意见截图' : '附件', required: proxy },
        ], async (v, cc) => {
            const attachment_ids = await A.stageFiles(detail.project.id, v.files, cc);
            await A.request(actionPath(opinion.id), { method: 'POST', body: { action: 'assess', text: v.text, estimated_hours: Number(v.estimated_hours), attachment_ids } }, cc);
            await A.render();
        }, '提交开发意见', A.reserveDialog(c)));
    }
    function dispose(opinion, c) {
        A.dialog('PM 定去向', [
            { name: 'outcome', label: '去向', required: true, options: Object.entries(outcomes).slice(0, 3) },
            textField('text', '结论', 4000, true),
        ], async (v, cc) => {
            await A.request(actionPath(opinion.id), { method: 'POST', body: { action: 'dispose', ...v } }, cc);
            await A.render();
        }, '保存去向', A.reserveDialog(c));
    }
    function decideCut(opinion, row, c) {
        A.dialog('需求方负责人本人表态', [
            { name: 'decision', label: row.party_name, required: true, options: [['', '请选择'], ['agree', '同意本期移出范围'], ['object', '不同意，维持原范围']] },
            textField('text', '说明', 500),
        ], async (v, cc) => {
            await A.request(actionPath(opinion.id), { method: 'POST', body: { action: 'cut_decide', party_id: row.party_id, ...v } }, cc);
            await A.render();
        }, '提交本人表态', A.reserveDialog(c));
    }
    function withdrawCut(opinion, c) {
        A.dialog('撤回同意请求，维持原范围', [textField('text', '撤回原因', 500, true)], async (v, cc) => {
            await A.request(actionPath(opinion.id), { method: 'POST', body: { action: 'cut_withdraw', text: v.text } }, cc);
            await A.render();
        }, '确认撤回', A.reserveDialog(c));
    }
    async function opinionDetail(detail, id, c, back) {
        const pid = detail.project.id;
        const { opinion: o } = await A.request(opinionPath(id), null, c);
        if (Number(o.project_id) !== Number(pid)) throw new Error('该意见不属于当前项目');
        const state = opinionState(o);
        const host = A.el('div');
        host.appendChild(A.panel(o.title, [
            A.facts([['分类', categories[o.category] || '待归类'], ['状态', state], ['提出时阶段', proposedAt(o, A.state.plan.nodes)], ['提出人', o.author_name], ['提出时间', o.created_at]]),
            prose(o.body), A.attachmentList(o.attachments, c),
        ], A.row(A.link('返回意见', back))));
        const actions = A.row();
        if (o.actions.triage === true) actions.appendChild(A.command('PM 初判', (cc) => triage(o, cc), 'primary', c));
        if (o.actions.assess === true) actions.appendChild(A.command(o.actions.assess_mode === 'proxy' ? '代录开发意见与工时' : '填写开发意见与工时', (cc) => assess(detail, o, cc), 'primary', c));
        if (o.actions.dispose === true) actions.appendChild(A.command('PM 定去向', (cc) => dispose(o, cc), 'primary', c));
        if (o.actions.cut_withdraw === true) actions.appendChild(A.command('撤回同意请求', (cc) => withdrawCut(o, cc), '', c));
        if (actions.childElementCount) host.appendChild(actions);
        if (o.triage_text) host.appendChild(A.panel('PM 初判', [prose(o.triage_text), o.skip_reason ? A.hint('跳过评估：' + o.skip_reason) : null]));
        if (o.assessment_source) host.appendChild(A.panel('开发意见与工时', [
            A.facts([['记录来源', o.assessment_source === 'proxy' ? (o.assessed_for_user_id ? 'PM 代录' : 'PM 代录，开发负责人待指定') : '开发负责人本人'], ['工时', o.assessment_hours + ' 小时']]),
            prose(o.assessment_text), A.attachmentList(o.assessment_attachments, c),
        ]));
        if (o.approvals?.length) host.appendChild(A.panel('需求部门表态', [A.table(['需求部门', '表态', '说明', '操作'], o.approvals.map((row) => [
            row.party_name,
            row.status === 'agree' ? '已同意' : row.status === 'object' ? '不同意' : o.status === 'concluded' ? '未答复，已结束' : '待同意',
            row.decision_text || '—',
            row.can_decide === true ? A.command('本人表态', (cc) => decideCut(o, row, cc), 'primary', c) : null,
        ]))]));
        if (o.outcome) host.appendChild(A.panel('结论 · ' + outcomes[o.outcome], [prose(o.outcome_text),
            o.task ? A.link('查看已生成任务', taskHref(pid, o.task.node_id, o.task.id)) : null]));
        return host;
    }
    async function opinionTab(detail, params, c, back) {
        const pid = detail.project.id;
        if (params.has('opinion')) return opinionDetail(detail, A.id(params.get('opinion')), c, back);
        const all = params.get('opinions') === 'all';
        const ops = A.row(A.link('未办结', { project: pid, tab: 'opinions' }), A.link('全部意见', { project: pid, tab: 'opinions', opinions: 'all' }));
        ops.children[all ? 1 : 0].setAttribute('aria-current', 'page');
        const opinions = A.state.opinions.opinions.filter((item) => all || item.is_pending);
        const rows = opinions.map((o) => [
            '#' + o.id, categories[o.category] || '待归类',
            A.link(o.title, { ...href(pid, o.id), ...(all ? { opinions: 'all' } : {}) }),
            proposedAt(o, A.state.plan.nodes), opinionState(o), waitingFor(o),
        ]);
        return A.panel('意见', [rows.length
            ? A.table(['编号', '类型', '标题', '提出时阶段', '当前步骤', '等谁'], rows)
            : A.hint(all ? '暂无意见。' : '暂无未办结意见。')], ops);
    }
    function newTask(node, data, c) {
        A.dialog('新增任务 · ' + node.name, [
            { name: 'title', label: '任务标题', max: 100, full: true, required: true },
            { name: 'assignee_user_id', label: '负责人', options: data.assignees.map((u) => [u.id, u.name]), required: true },
            { name: 'planned_on', label: '计划完成日', type: 'date' },
        ], async (v, cc) => {
            await A.request('/nodes/' + node.id + '/tasks', { method: 'POST', body: { ...v, assignee_user_id: A.id(v.assignee_user_id) } }, cc);
            await A.render();
        }, '新增任务', A.reserveDialog(c));
    }
    function taskPanel(detail, node, data, c) {
        const tasks = data.tasks.filter((task) => task.node_id === node.id);
        if (!tasks.length && data.actions.create !== true) return null;
        const create = data.actions.create === true ? A.command('新增任务', (cc) => newTask(node, data, cc), '', c) : null;
        return A.panel('任务', [tasks.length ? A.table(['任务', '负责人', '计划完成', '状态'], tasks.map((t) => [
            A.link(t.title, taskHref(detail.project.id, node.id, t.id)), t.assignee_name || '—', t.planned_on || '待排', taskStates[t.status],
        ])) : A.hint('暂无任务。')], create);
    }
    function taskResult(detail, task, status, c) {
        const cancelled = status === 'cancelled';
        const title = cancelled ? '取消任务' : '标为完成';
        A.dialog(title, [textField('text', cancelled ? '取消原因' : '完成说明', 500, cancelled), evidence], async (v, cc) => {
            const attachment_ids = await A.stageFiles(detail.project.id, v.files, cc);
            await A.request('/tasks/' + task.id + '/result', { method: 'POST', body: { status, text: v.text, attachment_ids } }, cc);
            await A.render();
        }, title, A.reserveDialog(c));
    }
    async function taskView(detail, id, selected, c, back) {
        const { task } = await A.request('/tasks/' + id, null, c);
        const pid = detail.project.id;
        if (Number(task.project_id) !== Number(pid) || (selected && selected !== task.node_id)) throw new Error('该任务不属于当前项目阶段');
        const buttons = A.row(A.link('返回阶段', back));
        if (task.actions.write_result === true) {
            buttons.appendChild(A.command('标为完成', (cc) => taskResult(detail, task, 'done', cc), 'primary', c));
            buttons.appendChild(A.command('取消任务', (cc) => taskResult(detail, task, 'cancelled', cc), '', c));
        }
        return A.panel(task.title, [
            A.facts([['状态', taskStates[task.status]], ['负责人', task.assignee_name], ['计划完成', task.planned_on || '待排']]),
            task.source_opinion_id ? A.link('查看来源意见', href(pid, task.source_opinion_id)) : null,
            task.result_text ? prose(task.result_text) : null,
            A.attachmentList(task.attachments, c),
        ], buttons);
    }
    function itemLink(pid, item) {
        return A.link(item.title, item.kind === 'task' ? taskHref(pid, item.node_id, item.id) : href(pid, item.id));
    }

    A.work = { proposalButton, taskPanel, taskView, itemLink };
    A.registerTab('opinions', '意见', opinionTab);
})();
