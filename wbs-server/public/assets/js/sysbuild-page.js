/* 项目管理：项目列表、新建三步、详情框架、身份卡与一页帮助。 */
(function () {
    'use strict';
    const A = window.SysBuildUI;
    const projectLabels = Object.freeze({ active: '进行中', paused: '已暂停', terminated: '已终止', closed: '已结项' });
    const nodeLabels = Object.freeze({ not_started: '未开始', in_progress: '进行中', closed: '已收口', cancelled: '已取消' });
    const buildLabels = Object.freeze({ outsource: '外包开发', procurement: '采购实施', inhouse: '自研' });
    const purposeLabels = Object.freeze({ package_confirm: '内容包确认', proposer: '提出人确认', entry_conclusion: '办理结论确认', entry_adjudicate: '负责人裁定', dev_entry: '开发方关键事项认可', handover_accept_issue: '接受带问题上线', handover_no_further: '交接不再处理' });
    const labelOf = (dict, value) => Object.prototype.hasOwnProperty.call(dict, value) ? dict[value] : String(value == null ? '—' : value);
    const optional = (s) => s === '' ? null : s;
    function heading(title, subtitle, actions) {
        return A.append(A.el('header', 'sbui-heading'), [A.append(A.el('div'), [A.el('h1', '', title), subtitle ? A.el('p', 'sbui-subtitle', subtitle) : null]), actions || null]);
    }
    function todoCounters(todo) {
        const counts = todo.counts || {};
        return A.append(A.el('div', 'sbui-todo'), [
            A.append(A.el('div', 'sbui-todo-item'), [A.el('strong', '', counts.badge || 0), A.link('待我确认 / 接受', { todo: 'confirm' })]),
            A.append(A.el('div', 'sbui-todo-item'), [A.el('strong', '', counts.handle || 0), A.link('待我办理', { todo: 'handle' })]),
            A.append(A.el('div', 'sbui-todo-item'), [A.el('strong', '', counts.routing || 0), A.link('待判定', { todo: 'routing' })]),
        ]);
    }
    async function list(params, c) {
        const scope = params.get('scope') === 'all' ? 'all' : 'mine';
        const [data, todo] = await Promise.all([A.request('/projects?scope=' + scope, null, c), A.request('/my/todo', null, c)]);
        const host = A.el('div');
        const ops = A.row();
        if (data.actions && data.actions.create === true) ops.appendChild(A.link('新建项目', { new: '1' }, 'primary'));
        host.appendChild(heading(scope === 'all' ? '全部项目' : '我参与的项目', '每一期建设留一份完整档案；确认绑定版本，办理保留原文。', ops));
        host.appendChild(todoCounters(todo));
        const switcher = A.row(A.link('我参与的', {}));
        if (data.actions && data.actions.list_all === true) switcher.appendChild(A.link('全部项目', { scope: 'all' }));
        const search = A.el('input'); search.type = 'search'; search.placeholder = '搜索系统、期次或 PM'; search.setAttribute('aria-label', '搜索项目');
        const status = A.el('select'); status.setAttribute('aria-label', '筛选项目状态');
        for (const [v, label] of [['', '全部状态'], ...Object.entries(projectLabels)]) { const option = A.el('option', '', label); option.value = v; status.appendChild(option); }
        switcher.appendChild(A.append(A.el('label'), [A.el('span', 'sbui-label', '搜索'), search]));
        switcher.appendChild(A.append(A.el('label'), [A.el('span', 'sbui-label', '项目状态'), status]));
        const listPanel = A.panel('项目档案', [switcher]);
        const results = A.el('div');
        function filter() {
            if (!A.valid(c)) return;
            const q = search.value.trim().toLocaleLowerCase();
            const rows = data.projects.filter((p) => (!status.value || p.status === status.value) && (!q || [p.system_name, p.phase_name, p.pm_name].some((v) => String(v || '').toLocaleLowerCase().includes(q))));
            results.replaceChildren(A.table(['系统 / 期次', '建设方式', 'PM', '状态', '建项时间', '操作'], rows.map((p) => [
                A.append(A.el('div'), [A.link(p.system_name, { project: p.id }), p.phase_name ? A.hint(p.phase_name) : null]),
                labelOf(buildLabels, p.build_type), p.pm_name, labelOf(projectLabels, p.status), p.created_at, A.link('打开档案', { project: p.id }),
            ])));
            if (!rows.length) results.appendChild(A.el('p', 'sbui-state', data.projects.length ? '没有符合筛选条件的项目。' : '暂无参与的项目。收到邀请后，请先到「我的待办」接受加入。'));
        }
        search.addEventListener('input', filter); status.addEventListener('change', filter);
        filter(); listPanel.appendChild(results); host.appendChild(listPanel);
        return host;
    }
    function basicFields(project) {
        const p = project || {};
        return [
            { name: 'system_name', label: '系统名称', value: p.system_name || '', required: true, max: 100 },
            { name: 'phase_name', label: '期次', value: p.phase_name || '', max: 50 },
            { name: 'goal', label: '建设目标 / 立项说明', value: p.goal || '', type: 'textarea', max: 2000, full: true },
            { name: 'oa_number', label: 'OA 单号', value: p.oa_number || '', max: 20 },
            { name: 'initiated_on', label: '立项日期', value: p.initiated_on || '', type: 'date' },
        ];
    }
    async function newProject(params, c) {
        const capabilities = await A.request('/projects?scope=mine', null, c);
        if (!capabilities.actions || capabilities.actions.create !== true) return A.panel('新建项目', [A.hint('当前账号不能新建项目。'), A.link('返回项目列表', {})]);
        const defs = basicFields();
        defs.splice(2, 0, { name: 'build_type', label: '建设方式', required: true, options: [['', '请选择建设方式'], ...Object.entries(buildLabels)], hint: '保存后不可更改，将按此方式带出默认批次与节点。' });
        if (capabilities.actions.create_pm_required === true) {
            const users = await A.request('/users/active', { platform: true }, c);
            defs.push({ name: 'pm_user_id', label: '项目负责人（PM）', required: true, options: [['', '请选择 PM'], ...users.map((u) => [u.id, u.display_name || u.username])], hint: '管理员代建须指定 PM。代建不会让管理员自动成为项目成员。' });
        }
        const host = A.el('div');
        host.appendChild(heading('新建项目', '第 1 步：保存项目基本信息。之后逐项添加需求方与成员，再核对立项确认。'));
        host.appendChild(stepper(1));
        host.appendChild(A.panel('项目基本信息', [A.form(defs, async (v, cc) => {
            const body = { system_name: v.system_name, phase_name: optional(v.phase_name), build_type: v.build_type, goal: optional(v.goal), oa_number: optional(v.oa_number), initiated_on: optional(v.initiated_on) };
            if (v.pm_user_id) body.pm_user_id = A.id(v.pm_user_id);
            const result = await A.request('/projects', { method: 'POST', body }, cc);
            A.navigate({ project: result.project.id, tab: 'setup', step: '2' });
        }, '保存并设置需求方', c)]));
        host.appendChild(A.panel('首次登记须知', [
            A.hint('每一步成功后都已保存在项目档案中；中途退出可从列表重新打开，不会自动撤销已经发出的邀请。'),
            A.hint('加入项目、接受负责人任职、负责人批准授权、代表人接受授权分别留痕。本人接受前不能由 PM 自动置为生效。'),
            A.hint('PM 不得兼任本项目任何参与方的负责人或代表人。开发方可以以后再加入。'),
        ]));
        return host;
    }
    function stepper(step) {
        return A.append(A.el('div', 'sbui-stepper'), [['1', '项目基本信息', '保存后生成档案'], ['2', '需求方与成员', '本人接受后生效'], ['3', '核对 G0 立项确认', '缺人时先补齐任职']].map(([i, title, note]) => {
            const n = A.append(A.el('div', 'sbui-step'), [A.el('strong', '', i + ' · ' + title), A.el('small', '', note)]);
            if (Number(i) === step) n.setAttribute('aria-current', 'step');
            return n;
        }));
    }
    function identityCard(detail) {
        const me = detail.me;
        const lines = [];
        if (me.is_readonly) lines.push('你使用领导只读账号。可以查看档案，并按本人当前资格完成确认与接受；登记、维护等写入由服务端拒绝。');
        if (me.is_admin) lines.push(me.is_readonly ? '你拥有管理员的项目查看范围，当前账号的只读限制仍然生效。' : me.is_pm ? '你是平台管理员，并担任本项目 PM。' : '你是平台管理员。可查看全部项目、管理成员、暂停或重开项目；需要履行 PM 职责时先接管。');
        if (me.is_pm) lines.push(me.is_readonly ? '你在本项目登记为 PM，当前账号只读，登记与维护限制仍然生效。' : '你是本项目 PM。负责整理推进事实、维护材料与计划、办理登记、发起确认和核对收口；不能代替他人自动同意。');
        for (const partyId of me.owner_of_parties || []) {
            const p = detail.parties.find((x) => x.id === partyId);
            if (p) lines.push('你是' + p.name + '的现任负责人。' + (p.side === 'dev' ? '负责认可本方处理说明、交付物及涉及承诺的登记，并授权本方代表人。' : '承担立项、范围与验收中负责人的确认职责，并授权本部门代表人；代表人专属事项仍由生效代表人处理。'));
        }
        for (const partyId of me.delegate_of_parties || []) {
            const p = detail.parties.find((x) => x.id === partyId);
            if (p) lines.push('你是' + p.name + '的生效代表人。' + (p.side === 'dev' ? me.is_readonly ? '按本人当前资格处理本方确认；涉及开发方承诺的事项仍须负责人认可，当前账号不提供登记权限。' : '代表开发方登记处理说明与交付物，按本方任务确认办理结论；涉及承诺的事项仍须负责人认可。' : me.is_readonly ? '按生效授权处理本部门需求、验收、办理结论和交接确认，当前账号不提供登记权限。' : '按生效授权确认本部门需求、验收、办理结论和交接，并登记本方意见。'));
        }
        if (me.roles.includes('member')) lines.push(me.is_readonly ? '你是已加入的只读成员。可以查看项目历史，并按本人资格完成确认；当前账号不提供登记与维护权限。' : '你是已加入的项目成员。可以查看项目历史、登记事实与个人意见，并确认本人提出的需求条目；个人意见不自动构成本方正式承诺。');
        return A.append(A.el('div', 'sbui-identity'), [A.el('h2', '', '我在本项目中的身份'), ...lines.map(A.hint)]);
    }
    async function editBasics(detail, c) {
        A.assertCurrent(c);
        A.dialog('修改项目基本信息', basicFields(detail.project), async (v, cc) => {
            await A.request('/projects/' + detail.project.id, { method: 'PATCH', body: Object.fromEntries(Object.entries(v).map(([k, val]) => [k, k === 'system_name' ? val : optional(val)])) }, cc);
            await A.render();
        });
    }
    async function changePm(detail, c, takeover) {
        A.assertCurrent(c);
        const lease = A.reserveDialog(c);
        const users = takeover ? [] : await A.request('/users/active', { platform: true }, lease);
        A.assertCurrent(lease);
        const defs = [];
        if (!takeover) defs.push({ name: 'pm_user_id', label: '新 PM', required: true, options: [['', '请选择'], ...users.map((u) => [u.id, u.display_name || u.username])] });
        defs.push({ name: 'reason', label: takeover ? '接管原因' : '更换原因', type: 'textarea', required: true, max: 500 });
        A.dialog(takeover ? '接管为本项目 PM' : '更换项目 PM', defs, async (v, cc) => {
            await A.request('/projects/' + detail.project.id + '/pm', { method: 'POST', body: { pm_user_id: takeover ? A.state.userId : A.id(v.pm_user_id), reason: v.reason } }, cc);
            await A.render();
        }, '保存', lease);
    }
    async function project(params, c) {
        const id = A.id(params.get('project'));
        const [detail, plan, todo] = await Promise.all([A.request('/projects/' + id, null, c), A.request('/projects/' + id + '/plan', null, c), A.request('/my/todo', null, c)]);
        A.assertCurrent(c);
        A.state.detail = detail; A.state.plan = plan;
        const host = A.el('div');
        const ops = A.row(A.link('返回项目列表', {}));
        if (detail.actions.edit_basics === true) ops.appendChild(A.button('修改基本信息', () => editBasics(detail, c).catch((err) => A.fail(err, c))));
        if (detail.actions.change_pm === true) ops.appendChild(A.command('更换 PM', () => changePm(detail, c, false), '', c));
        if (detail.actions.takeover === true) ops.appendChild(A.command('接管', () => changePm(detail, c, true), '', c));
        if (detail.actions.change_status === true) for (const target of detail.actions.status_targets) {
            const targetLabel = { active: detail.project.status === 'paused' ? '恢复项目' : '重开项目', paused: '暂停项目', terminated: '终止项目' }[target] || target;
            ops.appendChild(A.button(targetLabel, () => { A.assertCurrent(c); A.dialog(targetLabel, [{ name: 'reason', label: '原因', type: 'textarea', required: true, max: 500 }], async (v, cc) => { await A.request('/projects/' + id + '/status', { method: 'POST', body: { to: target, reason: v.reason } }, cc); await A.render(); }); }, target === 'terminated' ? 'danger' : ''));
        }
        host.appendChild(heading(detail.project.system_name + (detail.project.phase_name ? ' · ' + detail.project.phase_name : ''), '项目 #' + id + ' · ' + labelOf(projectLabels, detail.project.status) + ' · ' + labelOf(buildLabels, detail.project.build_type) + ' · PM：' + detail.project.pm_name, ops));
        const card = A.panel(); card.appendChild(identityCard(detail));
        card.appendChild(A.disclosure('项目基本信息 · PM、目标、OA 与日期', A.facts([['PM', detail.project.pm_name], ['建设目标', detail.project.goal], ['OA 单号', detail.project.oa_number], ['立项日期', detail.project.initiated_on], ['历史补录窗口', labelOf({ never: '未开启', open: '历史补录中', closed: '已关闭' }, detail.project.history_window)], ['创建时间', detail.project.created_at]])));
        host.appendChild(card);
        const mine = (todo.items.confirm || []).filter((x) => Number(x.project_id) === id);
        const handling = (todo.items.handle || []).filter((x) => Number(x.project_id) === id);
        const complete = todo.counts.confirm === todo.items.confirm.length && todo.counts.handle === todo.items.handle.length;
        const pending = A.row(A.el('strong', '', '当前待办'));
        pending.classList.add('sbui-notice');
        if (mine.length) pending.appendChild(A.link('查看本项目待我确认', { todo: 'confirm', project_filter: id }));
        if (handling.length) pending.appendChild(A.link('查看本项目待我办理', { todo: 'handle', project_filter: id }));
        if (todo.counts.accept > 0) pending.appendChild(A.link('我的待办中有待接受的邀请 / 授权', { todo: 'accept' }));
        if (!mine.length && !handling.length && todo.counts.accept === 0) pending.appendChild(A.text(complete ? '暂时不需要你操作。' : '当前摘要未显示本项目事项。每类最多 50 条，请到「我的待办」核对。'));
        host.appendChild(pending);
        const tab = params.get('tab') || (params.get('view') === 'send-intents' ? 'notifications' : 'overview');
        const tabNav = A.el('nav', 'sbui-tabs'); tabNav.setAttribute('aria-label', '项目详情视图');
        const tabEntries = Array.from(A.tabs.entries()).sort(([a], [b]) => a === 'overview' ? -1 : b === 'overview' ? 1 : 0);
        for (const [key, spec] of tabEntries) {
            if (spec.visible && spec.visible(detail) !== true) continue;
            const l = A.link(spec.label, { project: id, tab: key });
            if (key === tab) l.setAttribute('aria-current', 'page');
            tabNav.appendChild(l);
        }
        host.appendChild(tabNav);
        if (tab === 'setup') host.appendChild(await setup(detail, params, c));
        else {
            const selected = A.tabs.get(tab);
            if (!selected) throw new Error('该项目视图不存在');
            host.appendChild(await selected.render(detail, params, c));
        }
        return host;
    }
    async function overview(detail) {
        const plan = A.state.plan;
        const host = A.el('div');
        const nodes = A.panel('节点与材料');
        nodes.appendChild(A.table(['节点', 'G 环节', '状态', '当前计划', '实际', '未结异议'], plan.nodes.map((n) => [
            n.name, n.g_stage, labelOf(nodeLabels, n.status), n.current_plan ? n.current_plan.start + ' → ' + n.current_plan.end : '未设计划',
            (n.actual_start || '—') + ' → ' + (n.actual_end || '—'), String(n.post_close_objections_open || 0),
        ])));
        host.appendChild(nodes);
        host.appendChild(A.panel('首次登记', [A.hint('成员加入、负责人任职与代表人授权须分别生效。立项确认只要求需求方负责人，开发方可后续加入。'), A.link('继续需求方设置与 G0 核对', { project: detail.project.id, tab: 'setup', step: '2' })]));
        return host;
    }
    async function setup(detail, params, c) {
        const host = A.el('div');
        const step = params.get('step') === '3' ? 3 : 2;
        host.appendChild(stepper(step));
        if (step === 2) {
            host.appendChild(await A.membersView(detail, params, c));
            host.appendChild(A.row(A.link('核对 G0 立项确认', { project: detail.project.id, tab: 'setup', step: '3' }, 'primary')));
            return host;
        }
        const data = await A.request('/projects/' + detail.project.id + '/packages', null, c);
        const p = data.packages.find((x) => x.type === 'initiation');
        const preview = A.panel('G0 立项确认准备');
        preview.appendChild(A.append(A.el('div', 'sbui-panel-body'), [A.hint('下表为当前准备情况；已发起的确认任务仍以提交时绑定的必需确认人为准。')]));
        preview.appendChild(A.table(['需求部门', '当前生效负责人', '当前代表人', '当前准备情况'], detail.parties.filter((x) => x.side === 'demand').map((x) => [x.name, x.owner ? x.owner.name : '尚未生效', x.delegate ? x.delegate.name : '尚未授权', x.owner ? '负责人已就绪' : '请先完成加入与任职接受'])));
        preview.appendChild(A.append(A.el('div', 'sbui-panel-body'), [A.hint('负责人尚未生效时，请先回成员与授权完成本人接受；不会自动代为同意。确认任务按提交时的现任资格生成。')]));
        const actions = A.row(A.link('返回需求方设置', { project: detail.project.id, tab: 'setup', step: '2' }));
        if (!p && data.actions.create_package_types.includes('initiation')) actions.appendChild(A.command('建立立项草稿', async (cc) => {
            const created = await A.request('/projects/' + detail.project.id + '/packages', { method: 'POST', body: { type: 'initiation' } }, cc);
            await A.request('/packages/' + created.package.id + '/versions', { method: 'POST', body: {} }, cc);
            await A.render();
        }, 'primary', c));
        if (p && p.actions.new_version === true) actions.appendChild(A.command('新建立项草稿版本', async (cc) => { await A.request('/packages/' + p.id + '/versions', { method: 'POST', body: {} }, cc); await A.render(); }, 'primary', c));
        if (p) for (const version of p.versions) {
            const v = await A.request('/package-versions/' + version.id, null, c);
            const versionState = labelOf({ draft: '草稿', pending: '待确认', effective: '已生效', superseded: '已被替代' }, version.status);
            const stateHint = version.status === 'pending' ? '本版已发起，等待必需确认人处理。' : version.status === 'effective' ? '本版已生效。' : version.status === 'draft' ? '如需提交，请先补齐需求方现任负责人及服务端列明的前置条件。' : '本版已结束；后续操作请以当前有效版本为准。';
            const savedText = v.snapshot_json && v.snapshot_json.text || '';
            const editForm = v.actions.edit === true ? A.form([{ name: 'text', label: '立项确认内容', type: 'textarea', required: true, max: 12000, value: savedText || detail.project.goal || '', hint: '编辑后须先保存，发起确认使用上方已保存的版本快照。' }], async (values, cc) => { await A.request('/package-versions/' + version.id, { method: 'PATCH', body: { snapshot_json: { ...v.snapshot_json, text: values.text } } }, cc); await A.render(); }, '保存本版立项内容', c, '') : null;
            function assertSavedInitiation() {
                if (editForm && (editForm.dataset.submitting === 'true' || editForm.querySelector('[name="text"]').value !== savedText)) throw new Error('有未保存的改动，请先保存本版立项内容，或放弃改动后再发起确认。');
            }
            preview.appendChild(A.panel('立项包 v' + version.version_no + ' · ' + versionState, [
                A.hint('确认内容为下列版本快照。草稿只有明确保存后才会提交；发起后不会自动过门。'),
                A.disclosure('查看版本快照', A.el('pre', '', JSON.stringify(v.snapshot_json, null, 2))),
                editForm,
                v.actions.submit === true ? A.command('发起本版 G0 确认', async (cc) => { assertSavedInitiation(); await A.request('/package-versions/' + version.id + '/submit', { method: 'POST', body: {} }, cc); await A.render(); }, 'primary', c) : A.hint(stateHint),
            ]));
        }
        preview.appendChild(A.append(A.el('div', 'sbui-panel-body'), [actions]));
        host.appendChild(preview);
        return host;
    }
    async function todo(params, c) {
        const data = await A.request('/my/todo', null, c);
        const host = A.el('div'); host.appendChild(heading('我的待办', '列表展示待办摘要；只有你明确打开确认任务时才记录浏览。'));
        host.appendChild(todoCounters(data));
        const filterId = params.get('project_filter') ? A.id(params.get('project_filter')) : null;
        const names = { confirm: '待我确认', accept: '待我接受', handle: '待我办理', routing: '待判定', notice: '知会', objection: '改期知会异议', send_failed: '通知发送失败', needs_offline: '需线下通知', overdue: '超过三天待确认' };
        for (const [kind, title] of Object.entries(names)) {
            const rows = data.items[kind] || [];
            const visible = filterId ? rows.filter((r) => Number(r.project_id) === filterId) : rows;
            const p = A.panel(title + ' · ' + (data.counts[kind] || 0));
            p.appendChild(A.table(['项目 / 内容', '时间', '操作'], visible.map((r) => {
                const ops = A.row();
                if (kind === 'accept' && r.kind === 'invitation') ops.appendChild(A.link('查看邀请', { invitation: r.id }));
                else if (kind === 'accept' && r.kind === 'delegation') {
                    if (r.actions.accept === true) ops.appendChild(A.command('本人接受授权', async (cc) => { await A.request('/delegations/' + r.id + '/accept', { method: 'POST', body: {} }, cc); await A.render(); }, '', c));
                    if (r.actions.decline === true) ops.appendChild(A.command('拒绝授权', async (cc) => { await A.request('/delegations/' + r.id + '/decline', { method: 'POST', body: {} }, cc); await A.render(); }, '', c));
                } else if (r.task_id) ops.appendChild(A.link('打开确认', { task: r.task_id, ...(r.revision_id ? { revision_id: r.revision_id } : {}) }));
                else if (r.notice_id || kind === 'notice') ops.appendChild(A.link('打开知会', { notice: r.notice_id || r.id }));
                else if (kind === 'send_failed' || kind === 'needs_offline') ops.appendChild(A.link('查看通知处理', { project: r.project_id, tab: 'notifications' }));
                else if (r.project_id) ops.appendChild(A.link('打开项目', { project: r.project_id, tab: r.entry_id ? 'entries' : 'overview', ...(r.entry_id ? { entry: r.entry_id } : {}) }));
                return [A.append(A.el('div'), [A.text(r.system_name || r.project && r.project.system_name), A.hint(r.title || r.permission_note || labelOf(purposeLabels, r.purpose) || r.reason || ''), r.role && r.role.party_name ? A.hint('参与方：' + r.role.party_name) : null]), r.created_at || r.invited_at || r.proposed_at || r.decided_at || '', ops];
            })));
            p.appendChild(A.append(A.el('div', 'sbui-panel-body'), [A.hint('计数为全部待办，本页每类最多展示 50 条。' + (kind === 'needs_offline' ? '此类需线下通知，点击补发不能消除。' : kind === 'objection' ? '改期异议转 PM，不阻塞已完成的改期；第一期没有销除动作。' : ''))]));
            host.appendChild(p);
        }
        return host;
    }
    function help() {
        const host = A.el('div');
        host.appendChild(heading('项目管理帮助', '把推进事实、原始凭据和对应人的确认放在同一份项目档案中。'));
        host.appendChild(A.panel('三个关键词', [
            A.el('h3', '', '定稿'), A.hint('开发方按平台当前已确认版本执行；冻结的范围、条目或验收标准发生变化时走正式变更。纯日期调整走排期。'),
            A.el('h3', '', '登记'), A.hint('过程登记发生在节点收口前，补充登记发生在收口后，时段由系统确定。办理类登记要有明确结论；仅供参考不能用于问题与处理或涉及承诺的登记。'),
            A.el('h3', '', '确认'), A.hint('先看全文、版本和冻结附件，再按当前任务修订作决定。有异议不算确认，不设逾期自动同意。新版本不会继承旧版本确认。'),
        ]));
        host.appendChild(A.panel('各身份职责', [A.hint('PM：整理材料、维护计划、办理登记、发起确认和核对收口。负责人：确认职责内的事项并授权本方代表人。代表人：按生效授权完成本方业务确认。一般成员：登记事实和个人意见，确认本人提出的需求。管理员：代建、成员管理、暂停或重开、接管；领导只读账号：查看与本人的确认类动作。')]));
        host.appendChild(A.panel('为什么要附证据', [A.hint('证据说明事实来源，确认说明对具体版本的决定。方向类记录至少附一份证据，确无书面材料时勾选并写明原因；代录、历史补录和历史事实导入必须有原始凭据。'), A.hint('本人确认由本人操作并保存浏览与声明；代录保留实际确认人、外部日期、身份依据、原始凭据和录入人，不伪造本人浏览记录。')]));
        host.appendChild(A.panel('补充登记、正式变更与上线分界', [A.hint('补充登记把收口后的事实补进档案，不直接改动冻结内容。需要修改范围或验收标准时，由 PM 发起正式变更。收口后异议涉及冻结内容时，应评估转正式变更。'), A.hint('正式上线后，新功能问题走系统迭代受理渠道，项目里只记单号与链接；项目成员不一定有权限打开迭代单。第一期不提供评论、多批次界面或首次引导弹层。')]));
        return host;
    }
    async function timeline(detail, params, c) {
        const labels = Object.freeze({
            project_created: '建立项目', project_updated: '修改项目基本信息', project_status_changed: '变更项目状态', project_pm_changed: '更换 PM / 接管',
            party_created: '添加参与方', party_renamed: '修改参与方名称', member_added: '添加成员', member_invited: '发送加入邀请', member_joined: '本人接受加入', member_removed: '移出成员',
            invitation_accepted: '本人接受邀请', invitation_declined: '本人拒绝邀请', invitation_withdrawn: '撤回邀请',
            appointment_proposed: '提议负责人任职', appointment_activated: '负责人任职生效', appointment_ended: '结束负责人任职', appointment_rejected: '拒绝负责人任职', appointment_withdrawn: '撤回任职提议',
            delegation_proposed: '发起代表人授权', delegation_approved: '负责人批准授权', delegation_rejected: '拒绝授权', delegation_activated: '代表人授权生效', delegation_revoked: '撤销代表人授权', delegation_withdrawn: '撤回授权提议',
            node_created: '带出 / 新增节点', node_started: '开始节点', node_closed: '收口节点', node_reopened: '重开节点', node_cancelled: '取消节点', node_plan_set: '设定节点计划', node_rescheduled: '调整节点排期', node_actual_corrected: '更正实际日期',
            package_version_submitted: '提交内容包确认', package_version_effective: '内容包生效', package_version_withdrawn: '撤回内容包确认', confirmation_recorded: '记录本人确认决定', confirm_proxy_recorded: '记录代录确认',
            entry_created: '新增登记', entry_action_recorded: '追加办理记录', routing_decided: '记录分流判定', entry_split: '拆分处理项',
            history_window_opened: '开启历史补录窗口', history_window_closed: '关闭历史补录窗口', history_window_reopened: '重开历史补录窗口', history_confirmation_recorded: '补录历史确认', history_fact_imported: '导入历史事实',
            golive_recorded: '记录正式上线', golive_revoked: '撤销正式上线', handover_requested: '发起交接确认', handover_replied: '答复交接异议',
            attachment_staged: '暂存附件', attachment_bound: '绑定附件', attachment_frozen: '冻结确认附件清单', attachment_masked: '受控遮蔽附件', attachment_deleted: '软删除附件',
            send_intent_attempted: '记录通知发送尝试', send_intents_resent: '补发通知', notice_created: '生成知会', notice_objected: '对知会提出异议',
        });
        const host = A.panel('全项目时间线', [A.hint('时间倒序。这里展示谁在何时对哪个对象做了操作；正文、确认方式和原始凭据请打开对应对象核对。')]);
        const holder = A.el('div');
        const all = [];
        let cursor = null;
        let first = true;
        const more = A.command('加载更早记录', async (cc) => { await load(cc); }, '', c);
        function target(e) {
            if (e.object_type === 'entry') return { project: detail.project.id, tab: 'entries', entry: e.object_id };
            if (e.object_type === 'package_version') return { project: detail.project.id, tab: 'packages', version: e.object_id };
            if (e.object_type === 'confirm_task') return { task: e.object_id };
            if (['member', 'appointment', 'delegation', 'party', 'invitation'].includes(e.object_type)) return { project: detail.project.id, tab: 'members' };
            return { project: detail.project.id, tab: 'overview' };
        }
        async function load(cc) {
            const result = await A.request('/projects/' + detail.project.id + '/events?limit=50' + (!first && cursor ? '&before=' + cursor : ''), null, cc);
            A.assertCurrent(cc);
            first = false;
            all.push(...result.items);
            cursor = result.next_before;
            holder.replaceChildren(A.table(['时间', '发生了什么', '操作人', '相关记录'], all.map((e) => [e.created_at, labelOf(labels, e.event_type) === e.event_type ? '追加项目推进事实' : labels[e.event_type], e.operator_name, A.link('查看相关记录 #' + e.object_id, target(e))])));
            more.hidden = cursor === null;
        }
        await load(c);
        host.appendChild(holder);
        host.appendChild(A.append(A.el('div', 'sbui-panel-body'), [more]));
        return host;
    }
    A.registerRoute('list', list); A.registerRoute('new', newProject); A.registerRoute('project', project); A.registerRoute('todo', todo); A.registerRoute('help', help);
    A.registerTab('overview', '节点与材料', overview);
    A.registerTab('timeline', '全项目时间线', timeline);
    A.heading = heading; A.labelOf = labelOf; A.projectLabels = projectLabels; A.nodeLabels = nodeLabels;
}());
