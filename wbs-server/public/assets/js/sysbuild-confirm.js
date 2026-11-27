/* 项目管理确认页：固定任务修订、对象版本与本人声明，打开全文后才记录浏览。 */
(function () {
    'use strict';
    const A = window.SysBuildUI;
    const purposes = { package_confirm: '内容包确认' };
    const packageNames = { initiation: '立项与授权', overall: '总体范围与批次规划', batch_accept: '批次验收', closing: '整体验收结项' };
    const states = { pending: '待确认', confirmed: '已确认', objected: '有异议', rejected: '不认可', invalid: '已失效', superseded: '已被替代', draft: '草稿', effective: '已生效' };
    const methods = { platform: '平台本人确认', card: '钉钉卡片' };
    const decisions = { confirm: '确认', object: '有异议', reject: '不认可' };
    const label = (map, key) => map[key] || key || '—';
    // 平台管理员代办的确认不写成「本人确认」：操作人一栏是管理员，方式标「平台管理员代办」。
    const methodLabel = (cf) => cf.by_admin_proxy === true ? '平台管理员代办' : label(methods, cf.method);
    const prose = (text) => A.el('div', 'sbui-longtext', text == null || text === '' ? '未填写' : String(text));
    function snapshotView(snapshot) {
        const names = { text: '确认内容', scope: '范围', goal: '目标', acceptance: '验收原则', out_of_scope: '不做的范围', notes: '说明', title: '标题', body: '正文', schedule: '排期', plans: '计划', no_written_basis_reason: '无书面依据原因' };
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
    function initiationBasis(o, initiationNodeIds, c) {
        const materials = (o.materials || []).filter((m) => initiationNodeIds.includes(m.node_id));
        const body = [];
        const reason = o.snapshot_json && o.snapshot_json.no_written_basis_reason;
        if (reason) body.push(A.panel('无书面依据', [prose(reason)]));
        materials.forEach((m) => body.push(A.panel(m.name + ' · v' + m.version_no, [prose(m.body), A.hint('本版选入的材料及冻结附件，不随材料后续版本变化。'), A.attachmentList(m.attachments, c)])));
        if (!materials.length) body.push(A.hint('本版未选入立项节点材料。'));
        const panel = A.panel('立项依据', body); panel.dataset.l3Basis = 'true';
        return panel;
    }
    function objectContent(data, c, initiationNodeIds) {
        const o = data.object;
        const host = A.el('div', 'sbui-stack');
        if (o.type === 'package_version') {
            host.appendChild(A.panel(label(packageNames, o.package.type) + ' · v' + o.version.version_no, [snapshotView(o.snapshot_json)]));
            if (o.package.type === 'initiation') host.appendChild(initiationBasis(o, initiationNodeIds, c));
            const roleNames = { acceptance: '验收', golive: '正式上线', closing: '结项' };
            if ((o.node_plans || []).length) host.appendChild(A.panel('本版提交时的节点计划', [A.table(['节点', '职责', '所属层级', '计划开始', '计划结束'], o.node_plans.map((n) => [n.name, n.roles.map((role) => roleNames[role]).join('和'), n.batch_name || '项目层', n.planned_start, n.planned_end]))]));
            (o.materials || []).forEach((m) => host.appendChild(A.panel('引用材料 · ' + m.name + ' v' + m.version_no, [prose(m.body), A.attachmentList(m.attachments, c)])));
        }
        host.appendChild(A.panel('本版冻结附件', [A.attachmentList(data.frozen_attachments, c)]));
        return host;
    }
    function assignmentLabel(task, revision) {
        return revision.direct_assignment_role ? '以' + (task.party_name || '本方') + revision.direct_assignment_role + '身份确认 · 直接指定，未经本人接受' : '';
    }
    function confirmationHistory(data, c) {
        const host = A.el('div', 'sbui-stack');
        const confirmed = new Map((data.confirmations || []).map((r) => [r.revision_id, r]));
        host.appendChild(A.table(['任务修订', '当时必需确认人', '修订状态', '确认方式', '确认人', '日期与时间'], (data.revisions || []).map((r) => {
            const cf = confirmed.get(r.id);
            return ['第 ' + r.rev_no + ' 次', A.append(A.el('div'), [A.text(r.required_name || '成员 #' + r.required_member_id), assignmentLabel(data.task, r) ? A.hint(assignmentLabel(data.task, r)) : null]), label(states, r.status), cf ? methodLabel(cf) : '尚无确认记录', cf ? (cf.actor_name || '—') : '—', cf ? '记入 ' + cf.created_at : r.created_at];
        })));
        (data.confirmations || []).forEach((cf) => host.appendChild(A.disclosure(methodLabel(cf) + ' · ' + label(decisions, cf.decision) + ' · ' + cf.created_at, [prose(cf.reason || '确认无异议')])));
        return host;
    }
    function decisionForm(data, c) {
        const allowed = data.allowed_decisions;
        if (!Array.isArray(allowed) || !allowed.length || allowed.some((d) => !decisions[d] || !data.checkbox_texts[d])) throw new Error('确认选项不完整，请刷新后重试');
        const proxy = data.actions.decide_mode === 'admin';
        const form = A.form([
            { name: 'decision', label: proxy ? '代办的决定' : '本人的决定', required: true, options: [['', '请明确选择'], ...allowed.map((d) => [d, decisions[d]])] },
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
        }, proxy ? '提交代办的决定' : '提交本人的决定', c);
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
    async function taskPage(params, c, expectedRevision) {
        const tid = A.id(params.get('task'));
        const expected = expectedRevision || (params.has('revision_id') ? A.id(params.get('revision_id')) : null);
        // 用户明确打开才调用；携带旧通知的修订号，后端在读和写浏览两个锁内都重核。
        let data;
        try { data = await A.request('/confirm-tasks/' + tid + (expected ? '?revision_id=' + expected : ''), null, c); }
        catch (err) {
            if (expected && err.status === 409) return A.panel('这条通知对应的任务修订已变化', [A.hint('未把这次打开记为阅读新版。请重新核对当前任务后再决定。'), A.link('明确打开当前任务', { task: tid }), A.link('返回「等我处理」', { todo: '1' })]);
            throw err;
        }
        const host = A.el('div', 'sbui-confirmation');
        host.appendChild(A.panel(label(purposes, data.task.purpose), [
            A.facts([['项目', data.project && data.project.system_name || '项目 #' + data.task.project_id], ['对象版本', data.object.version && data.object.version.version_no ? 'v' + data.object.version.version_no : '#' + data.task.object_version_id], ['任务修订', '第 ' + data.revision.rev_no + ' 次'], ['必需确认人', data.revision.required_name || '成员 #' + data.revision.required_member_id], ['状态', label(states, data.revision.status)]]),
            assignmentLabel(data.task, data.revision) ? A.hint(assignmentLabel(data.task, data.revision)) : null,
            A.hint('请核对下方原文、版本和冻结附件后再决定。每次决定固定绑定本页所示修订与对象版本。'),
            A.row(A.link('返回项目', { project: data.task.project_id }), A.link('返回「等我处理」', { todo: '1' })),
        ]));
        // 材料视图已返回固定版本与冻结附件；仅用既有计划读接口定位立项节点，不重新取最新版材料。
        let initiationNodeIds = [];
        if (data.object.type === 'package_version' && data.object.package.type === 'initiation') {
            const plan = await A.request('/projects/' + data.task.project_id + '/plan', null, c);
            initiationNodeIds = plan.nodes.filter((node) => node.template_key === 'p_initiation').map((node) => node.id);
        }
        host.appendChild(objectContent(data, c, initiationNodeIds));
        host.appendChild(A.panel('各次修订与确认记录', [confirmationHistory(data, c)]));
        if (data.actions.decide === true && data.actions.decide_mode === 'admin') host.appendChild(A.panel('管理员代办确认', [
            A.hint('你不是这项确认的必需确认人（' + (data.revision.required_name || '成员 #' + data.revision.required_member_id) + '）。提交后记录的操作人是你，并标为「管理员代办」。'),
            decisionForm(data, c),
        ]));
        else if (data.actions.decide === true) host.appendChild(A.panel('本人作出决定', [decisionForm(data, c)]));
        else host.appendChild(A.panel('当前没有可提交的本人决定', [A.hint('请查看修订状态与必需确认人。已确认的决定不会因重复打开再次提交。')]));
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
        if (found.is_current !== true) return A.panel('旧通知 · 任务修订已被替代', [A.hint('这条通知指向第 ' + found.rev_no + ' 次修订，不会自动读取或确认当前版本。'), A.link('明确打开当前任务', { task: found.task_id }), A.link('返回「等我处理」', { todo: '1' })]);
        return taskPage(new URLSearchParams({ task: found.task_id }), c, rid);
    }
    A.snapshotView = snapshotView;
    A.registerRoute('task', taskPage);
    A.registerRoute('revision', revisionPage);
}());
