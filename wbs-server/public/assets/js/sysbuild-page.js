/* 项目管理：弹窗建档、详情框架、身份卡与一页帮助。 */
(function () {
    'use strict';
    const A = window.SysBuildUI;
    const projectLabels = Object.freeze({ active: '进行中', paused: '已暂停', terminated: '已终止', closed: '已结项' });
    const nodeLabels = Object.freeze({ not_started: '未开始', in_progress: '进行中', closed: '已收口', cancelled: '已取消' });
    const buildLabels = Object.freeze({ outsource: '外包开发', procurement: '采购实施', inhouse: '自研' });
    const purposeLabels = Object.freeze({ package_confirm: '内容包确认' });
    const labelOf = (dict, value) => Object.prototype.hasOwnProperty.call(dict, value) ? dict[value] : String(value == null ? '—' : value);
    const optional = (s) => s === '' ? null : s;
    function heading(title, subtitle, actions) {
        return A.append(A.el('header', 'sbui-heading'), [A.append(A.el('div'), [A.el('h1', '', title), subtitle ? A.el('p', 'sbui-subtitle', subtitle) : null]), actions || null]);
    }
    function todoCounters(todo) {
        const counts = todo.counts || {};
        return A.append(A.el('div', 'sbui-todo'), [
            A.append(A.el('div', 'sbui-todo-item'), [A.el('strong', '', counts.badge || 0), A.link('待我确认', { todo: 'confirm' })]),
            A.append(A.el('div', 'sbui-todo-item'), [A.el('strong', '', counts.handle || 0), A.link('待我办理', { todo: 'handle' })]),
        ]);
    }
    const projectTones = { active: 'active', paused: 'hold', closed: 'done', terminated: 'archived' };
    const stageTones = { not_started: 'wait', in_progress: 'active', closed: 'done' };
    const stageLabels = { not_started: '未开始', in_progress: '进行中', closed: '已完成' };
    function projectStatus(project) {
        return A.el('span', 'u-status-badge sem-' + (projectTones[project.status] || 'wait'), labelOf(projectLabels, project.status));
    }
    function completionSummary(view) {
        if (!view || !view.date) return A.el('span', 'sbui-estimate', '未排期');
        const days = view.days_remaining;
        const text = days === null ? null : days < 0 ? '已过 ' + Math.abs(days) + ' 天' : days === 0 ? '今天到期' : '剩 ' + days + ' 天';
        return A.append(A.el('span', 'sbui-estimate'), [
            A.el('span', '', view.date),
            text ? A.el('span', 'sbui-countdown' + (view.tone ? ' ' + view.tone : ''), text) : null,
            view.delay_days ? A.el('span', 'sbui-delay', '顺延 ' + view.delay_days + ' 天') : null,
        ]);
    }
    function projectCard(project) {
        const info = project.card;
        const title = A.el('a', 'sbui-project-card-title', project.system_name + (project.phase_name ? ' · ' + project.phase_name : ''));
        title.href = '#project=' + project.id;
        const identities = [['PM', project.pm_name]];
        for (const side of [['demand', '需求方'], ['dev', '开发方']]) {
            const parties = info.parties.filter((party) => party.side === side[0]);
            identities.push([side[1] + '负责人', parties.map((party) => party.responsible).filter(Boolean).join('、') || '—']);
            identities.push([side[1] + '领导', parties.map((party) => party.leader).filter(Boolean).join('、') || '—']);
        }
        const stages = A.el('div', 'sbui-stage-segments');
        stages.setAttribute('aria-label', '阶段进度');
        for (const stage of info.stages) {
            const item = A.el('span', 'sbui-stage-segment ' + (stageTones[stage.status] || 'wait'));
            item.title = stage.name + ' · ' + labelOf(stageLabels, stage.status);
            item.setAttribute('aria-label', item.title);
            stages.appendChild(item);
        }
        const stage = info.current_stage
            ? A.link(info.current_stage.name, { project: project.id, tab: 'plan', node: info.current_stage.id })
            : A.text('全部阶段已完成');
        return A.append(A.el('article', 'sbui-project-card'), [
            A.append(A.el('header', 'sbui-project-card-header'), [title, projectStatus(project)]),
            A.el('div', 'sbui-card-build', labelOf(buildLabels, project.build_type)),
            A.facts(identities),
            stages,
            A.row(A.text('当前阶段'), stage),
            A.row(A.text('预计完成'), completionSummary(info.estimated_completion)),
            info.range_unconfirmed_started ? A.el('span', 'u-status-badge sem-failed', '范围未确认已开工') : null,
            A.append(A.el('footer', 'sbui-project-card-footer'), [
                A.text('必须做的事 ' + info.required.done + ' / ' + info.required.total),
                A.link('未办结意见 ' + info.pending_opinions, { project: project.id, tab: 'opinions' }),
                A.link('等我处理 ' + info.waiting.count + ' 件', { todo: '1', project_filter: project.id }),
                info.waiting.send_failed ? A.hint('含待补发通知') : null,
            ]),
        ]);
    }
    async function list(params, c) {
        const scope = params.get('scope') === 'all' ? 'all' : 'mine';
        const data = await A.request('/project-cards?scope=' + scope, null, c);
        A.assertCurrent(c);
        if (!params.toString() && data.default_view === 'todo') {
            history.replaceState(history.state, '', location.pathname + location.search + '#todo=1');
            await A.render();
            return null;
        }
        const host = A.el('div');
        const ops = A.row();
        if (data.actions && data.actions.create === true) ops.appendChild(A.command('新建项目', (cc) => openNewProject(data, cc), 'primary', c));
        host.appendChild(heading(scope === 'all' ? '全部项目' : '我参与的项目', null, ops));
        const switcher = A.row(A.link('我参与的', { scope: 'mine' }));
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
            const active = [];
            const compact = [];
            for (const project of rows) (project.card && ['active', 'paused'].includes(project.status) ? active : compact).push(project);
            results.replaceChildren();
            if (active.length) results.appendChild(A.append(A.el('div', 'sbui-project-grid'), active.map(projectCard)));
            if (compact.length) results.appendChild(A.panel('其他项目', [A.table(['系统 / 期次', '状态', '建设方式', 'PM', '预计完成'], compact.map((p) => [
                A.link(p.system_name + (p.phase_name ? ' · ' + p.phase_name : ''), { project: p.id }),
                projectStatus(p), labelOf(buildLabels, p.build_type), p.pm_name, p.card ? completionSummary(p.card.estimated_completion) : '—',
            ]))]));
            if (!rows.length) results.appendChild(A.el('p', 'sbui-state', data.projects.length ? '没有符合筛选条件的项目。' : '暂无参与的项目。'));
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
        if (!capabilities.actions || capabilities.actions.create !== true) return A.panel('新建项目', [A.hint('当前账号不能新建项目。'), A.link('返回项目列表', { scope: 'mine' })]);
        const host = await list(params, c);
        await openNewProject(capabilities, c);
        return host;
    }
    async function openNewProject(capabilities, c) {
        const lease = A.reserveDialog(c);
        const defs = basicFields().filter((field) => field.name !== 'goal');
        defs.splice(2, 0, { name: 'build_type', label: '建设方式', required: true, options: [['', '请选择建设方式'], ...Object.entries(buildLabels)], hint: '保存后不可更改，将按此方式带出默认批次与节点。' });
        const users = await A.request('/users/active', { platform: true }, lease);
        if (capabilities.actions.create_pm_required === true) {
            defs.push({ name: 'pm_user_id', label: '项目负责人（PM）', required: true, options: [['', '请选择 PM'], ...users.map((u) => [u.id, u.display_name || u.username])], hint: '管理员代建须指定 PM。代建不会让管理员自动成为项目成员。' });
        }
        defs.push(...A.initialPeopleFields(A.personOptions(users)));
        A.assertCurrent(lease);
        const f = A.dialog('新建项目', defs, async (v, cc) => {
            const body = { system_name: v.system_name, phase_name: optional(v.phase_name), build_type: v.build_type, oa_number: optional(v.oa_number), initiated_on: optional(v.initiated_on) };
            if (v.pm_user_id) body.pm_user_id = A.id(v.pm_user_id);
            body.demand_parties = v.demand_parties;
            if ((v.dev_name || '').trim() || v.dev_leader_user_id || v.dev_representative_user_id) {
                body.dev_party = { name: v.dev_name, leader_user_id: v.dev_leader_user_id ? A.id(v.dev_leader_user_id) : null };
                if (v.dev_representative_user_id) body.dev_party.representative_user_id = A.id(v.dev_representative_user_id);
            }
            const result = await A.request('/projects', { method: 'POST', body }, cc);
            A.navigate({ project: result.project.id, tab: 'plan', stage: 'initiation' });
        }, '保存', lease);
        A.$('sbuiDialog').classList.add('sbui-create-dialog');
        A.guardDialogUnsaved(f, lease);
        f.prepend(A.hint('指定的人员保存后立即加入。立项材料和确认在项目内办理。'));
    }
    function identityCard(detail) {
        const me = detail.me;
        const lines = [];
        if (me.is_readonly) lines.push('你使用领导只读账号。可以查看档案，并按本人当前资格完成本人的确认；登记、维护等写入由服务端拒绝。');
        if (me.is_admin) lines.push(me.is_readonly ? '你拥有管理员的项目查看范围，当前账号的只读限制仍然生效。' : me.is_pm ? '你是平台管理员，并担任本项目 PM。' : '你是平台管理员。可查看全部项目、暂停或重开项目。管理人员或履行 PM 职责前请先接管。');
        if (me.is_pm) lines.push(me.is_readonly ? '你在本项目登记为 PM，当前账号只读，登记与维护限制仍然生效。' : '你是本项目 PM。负责整理推进事实、维护材料与计划、办理登记、发起确认和核对收口；不能代替他人自动同意。');
        for (const partyId of me.owner_of_parties || []) {
            const p = detail.parties.find((x) => x.id === partyId);
            if (p) lines.push('你是' + p.name + '的现任领导。' + (p.side === 'dev' ? '按当前资格处理本方事项。' : '按当前资格完成立项、范围与验收中属于领导的确认。'));
        }
        for (const partyId of me.delegate_of_parties || []) {
            const p = detail.parties.find((x) => x.id === partyId);
            if (p) lines.push('你是' + p.name + '的生效负责人。' + (me.is_readonly ? '按当前资格处理本人的确认。' : '按当前资格处理本方确认和登记。'));
        }
        if (me.roles.includes('member')) lines.push(me.is_readonly ? '你是已加入的只读成员。可以查看项目历史，并按本人资格完成确认；当前账号不提供登记与维护权限。' : '你是已加入的项目成员。可以查看项目历史、登记事实与个人意见；个人意见不自动构成本方正式承诺。');
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
    function cardCounts(data, nodeId) {
        const required = data.cards.filter((card) => card.required && (nodeId === undefined || card.node_id === nodeId));
        return required.filter((card) => card.complete).length + ' / ' + required.length;
    }
    function tabIsVisible(key, detail) {
        const spec = A.tabs.get(key);
        return !!spec && (!spec.visible || spec.visible(detail) === true);
    }
    function projectHeader(detail, plan, materials, ops, c) {
        const p = detail.project;
        const name = p.system_name + (p.phase_name ? ' · ' + p.phase_name : '');
        const title = A.el('h1', 'sbui-project-name', name);
        title.title = name;
        function people(side, label) {
            const parties = detail.parties.filter((item) => item.side === side);
            const delegates = parties.map((item) => item.delegate?.name).filter(Boolean).join('、');
            const leaders = parties.map((item) => item.owner?.name).filter(Boolean).join('、');
            const node = A.el('span', 'sbui-head-person', label + ' ' + (delegates || '—'));
            node.title = label + '负责人 ' + (delegates || '待指定') + ' · 领导 ' + (leaders || '待指定');
            return node;
        }
        let more = null;
        if (ops.childElementCount) {
            more = A.append(A.el('details', 'sbui-project-more'), [A.el('summary', '', '更多'), ops]);
            ops.classList.add('sbui-project-menu');
        }
        const pm = A.el('span', 'sbui-head-person', 'PM ' + (p.pm_name || '—'));
        pm.title = pm.textContent;
        const back = A.link('返回', { scope: 'mine' }, 'sbui-head-back');
        back.setAttribute('aria-label', '返回项目列表');
        return A.append(A.el('header', 'sbui-project-header'), [
            back, title, projectStatus(p),
            A.el('span', 'sbui-head-build', labelOf(buildLabels, p.build_type)),
            pm, people('demand', '需求方'), people('dev', '开发方'),
            A.append(A.el('span', 'sbui-head-estimate'), [A.el('span', 'sbui-head-caption', '预计完成'), completionSummary(plan.project.estimated_completion)]),
            A.el('span', 'sbui-head-required', '必须做的事 ' + cardCounts(materials)),
            A.work.proposalButton(detail, c), more,
        ]);
    }
    function projectRail(detail, plan, materials, opinions, tab, params) {
        const p = detail.project.id;
        const selected = params.get('node') || (params.get('stage') === 'initiation'
            ? String(plan.nodes.find((node) => node.template_key === 'p_initiation' && node.batch_id === null)?.id || '') : '');
        const projectLinks = [
            ['overview', '概览'], ['opinions', '意见'], ['members', '成员'], ['timeline', '全项目时间线'],
            ['notifications', '通知处理'], ['records', '全部记录'],
        ];
        const nav = A.el('nav', 'sbui-project-rail');
        nav.setAttribute('aria-label', '项目导航');
        const links = A.el('div', 'sbui-rail-items');
        for (const [key, name] of projectLinks) {
            if (!tabIsVisible(key, detail)) continue;
            const link = A.link(name, { project: p, tab: key }, 'sbui-rail-link');
            if (key === 'opinions') link.appendChild(A.el('span', 'sbui-rail-count', opinions.opinions.filter((item) => item.is_pending).length));
            const active = tab === key || (key === 'records' && (['entries', 'materials', 'packages', 'handover'].includes(tab) || (tab === 'plan' && !selected)));
            if (active) link.setAttribute('aria-current', 'page');
            links.appendChild(link);
        }
        const stages = A.el('div', 'sbui-rail-items');
        const byId = new Map(plan.nodes.map((node) => [node.id, node]));
        for (const id of plan.display_stage_ids) {
            const n = byId.get(id);
            const link = A.link(n.name, { project: p, tab: 'plan', node: n.id }, 'sbui-rail-link');
            const dot = A.el('span', 'sbui-rail-dot ' + (stageTones[n.status] || 'wait'));
            dot.title = labelOf(stageLabels, n.status);
            link.prepend(dot);
            const amount = cardCounts(materials, n.id);
            link.appendChild(A.el('span', 'sbui-rail-count', amount));
            if (tab === 'plan' && String(n.id) === selected) link.setAttribute('aria-current', 'page');
            stages.appendChild(link);
        }
        return A.append(nav, [A.el('h2', '', '项目'), links, A.el('h2', '', '阶段'), stages]);
    }
    function allRecords(detail) {
        const p = detail.project.id;
        const destinations = [['plan', '全部阶段'], ['handover', '上线与交接'], ['entries', '记录'], ['packages', '对方确认'], ['materials', '材料']];
        const links = destinations.filter(([tab]) => tabIsVisible(tab, detail)).map(([tab, name]) => A.link(name, { project: p, tab }));
        return A.panel('全部记录', [A.row(...links)]);
    }
    async function projectTab(detail, plan, materials, tab, params, c) {
        const renderTab = A.tabs.get(tab).render;
        const keys = {
            packages: ['version', '确认内容'], materials: ['material_version', '材料版本'], entries: ['entry', '记录'],
            opinions: ['opinion', '意见'], plan: params.has('card') ? ['card', '必须做的事'] : ['work_task', '任务'],
        };
        const spec = keys[tab];
        if (!spec || !params.has(spec[0])) return renderTab(detail, params, c);
        const [key, title] = spec;
        const base = new URLSearchParams(params);
        for (const field of ['version', 'material_version', 'entry', 'opinion', 'card', 'work_task']) base.delete(field);
        base.set('tab', tab);
        const selected = params.has('node') ? A.id(params.get('node')) : null;
        const master = await renderTab(detail, base, c);
        let content;
        if (key === 'card') {
            const stage = plan.nodes.find((node) => node.id === selected);
            if (!stage) throw new Error('该阶段不属于当前项目');
            content = await A.stageCardDetail(detail, stage, materials, params.get('card'), c);
        } else if (key === 'work_task') {
            content = await A.work.taskView(detail, A.id(params.get(key)), selected, c, base);
        } else {
            content = await renderTab(detail, params, c, base);
        }
        A.assertCurrent(c);
        return A.append(A.el('div'), [master, A.drawer(content, title, base, c)]);
    }
    const retiredProjectTabs = new Set(['items', 'history']);
    function retiredProjectAddress(params, tab) {
        // 原三步入口发出的链接总带 step。识别其地址形状，继续回到概览。
        const retiredStep = !A.tabs.has(tab) && ['1', '2', '3'].includes(params.get('step'));
        return retiredStep || retiredProjectTabs.has(tab) || params.has('invitation') || params.has('delegation');
    }
    function requestedProjectTab(params) {
        const requestedTab = params.get('tab') || (params.get('view') === 'send-intents' ? 'notifications' : 'overview');
        if (retiredProjectAddress(params, requestedTab)) return 'overview';
        if (params.has('version')) return 'packages';
        if (params.has('material_version')) return 'materials';
        if (params.has('entry')) return 'entries';
        return A.tabs.has(requestedTab) ? requestedTab : 'overview';
    }
    async function project(params, c) {
        const id = A.id(params.get('project'));
        const [detail, plan, todo, materials, opinionData] = await Promise.all([
            A.request('/projects/' + id, null, c), A.request('/projects/' + id + '/plan', null, c), A.request('/my/todo', null, c),
            A.request('/projects/' + id + '/materials', null, c), A.request('/projects/' + id + '/opinions', null, c),
        ]);
        A.assertCurrent(c);
        A.state.detail = detail; A.state.plan = plan; A.state.materials = materials; A.state.opinions = opinionData;
        const host = A.el('div');
        const ops = A.row();
        if (detail.actions.edit_basics === true) ops.appendChild(A.button('修改基本信息', () => editBasics(detail, c).catch((err) => A.fail(err, c))));
        if (detail.actions.change_pm === true) ops.appendChild(A.command('更换 PM', () => changePm(detail, c, false), '', c));
        if (detail.actions.takeover === true) ops.appendChild(A.command('接管', () => changePm(detail, c, true), '', c));
        if (detail.actions.change_status === true) for (const target of detail.actions.status_targets) {
            const targetLabel = { active: detail.project.status === 'paused' ? '恢复项目' : '重开项目', paused: '暂停项目', terminated: '终止项目' }[target] || target;
            ops.appendChild(A.button(targetLabel, () => { A.assertCurrent(c); A.dialog(targetLabel, [{ name: 'reason', label: '原因', type: 'textarea', required: true, max: 500 }], async (v, cc) => { await A.request('/projects/' + id + '/status', { method: 'POST', body: { to: target, reason: v.reason } }, cc); await A.render(); }); }, target === 'terminated' ? 'danger' : ''));
        }
        host.appendChild(projectHeader(detail, plan, materials, ops, c));
        const mine = (todo.items.confirm || []).filter((x) => Number(x.project_id) === id);
        const handling = (todo.items.handle || []).filter((x) => Number(x.project_id) === id);
        const opinions = (todo.items.opinion || []).filter((x) => Number(x.project_id) === id);
        const tasks = (todo.items.work_task || []).filter((x) => Number(x.project_id) === id);
        const complete = ['confirm', 'handle', 'opinion', 'work_task'].every((kind) => (todo.counts[kind] || 0) === (todo.items[kind] || []).length);
        const pending = A.row(A.el('strong', '', '当前待办'));
        pending.classList.add('sbui-notice');
        if (mine.length) pending.appendChild(A.link('查看本项目待我确认', { todo: 'confirm', project_filter: id }));
        if (handling.length) pending.appendChild(A.link('查看本项目待我办理', { todo: 'handle', project_filter: id }));
        if (opinions.length) pending.appendChild(A.link('查看本项目意见待办', { todo: 'opinion', project_filter: id }));
        if (tasks.length) pending.appendChild(A.link('查看本项目未完成任务', { todo: 'work_task', project_filter: id }));
        if (!mine.length && !handling.length && !opinions.length && !tasks.length) pending.appendChild(A.text(complete ? '暂时不需要你操作。' : '当前摘要未显示本项目事项。每类最多 50 条，请到「等我处理」核对。'));
        host.appendChild(pending);
        const requestedTab = requestedProjectTab(params);
        const tab = tabIsVisible(requestedTab, detail) ? requestedTab : 'overview';
        if (requestedTab !== tab) host.appendChild(A.hint('当前账号不能查看该项目页签。'));
        const pane = A.el('section', 'sbui-project-pane');
        if (tab === 'overview') {
            const card = A.panel(null, [identityCard(detail)]);
            card.appendChild(A.disclosure('项目基本信息 · PM、目标、OA 与日期', A.facts([['PM', detail.project.pm_name], ['建设目标', detail.project.goal], ['OA 单号', detail.project.oa_number], ['立项日期', detail.project.initiated_on], ['创建时间', detail.project.created_at]])));
            pane.appendChild(card);
        }
        pane.appendChild(await projectTab(detail, plan, materials, tab, params, c));
        host.appendChild(A.append(A.el('div', 'sbui-project-layout'), [projectRail(detail, plan, materials, opinionData, tab, params), pane]));
        const layer = pane.querySelector('.sbui-drawer-layer');
        if (!layer) return host;
        host.inert = true;
        host.setAttribute('aria-hidden', 'true');
        return A.append(A.el('div'), [host, layer]);
    }
    async function todo(params, c) {
        const data = await A.request('/my/todo', null, c);
        const host = A.el('div'); host.appendChild(heading('等我处理', '打开确认任务时会记录本人浏览。'));
        host.appendChild(todoCounters(data));
        const filterId = params.get('project_filter') ? A.id(params.get('project_filter')) : null;
        const visibleRows = (kind) => (data.items[kind] || []).filter((r) => !filterId || Number(r.project_id) === filterId);
        // 待办只展示返回的可见行；按项目取一次原登记，让事由与后续勘误同屏。
        const reportProjects = Array.from(new Set(['report_due', 'report_overdue'].flatMap((kind) => visibleRows(kind)).filter((r) => (r.sources || []).length > 0).map((r) => Number(r.project_id))));
        const reportEntries = new Map(await Promise.all(reportProjects.map(async (projectId) => {
            const entries = await A.request('/projects/' + projectId + '/entries', null, c);
            return [projectId, new Map(entries.entries.map((entry) => [Number(entry.id), entry]))];
        })));
        A.assertCurrent(c);
        function reportSource(row, source) {
            if (source.kind === 'default_cycle') return A.hint('默认周期');
            const sourceEntry = reportEntries.get(Number(row.project_id))?.get(Number(source.entry_id));
            return A.append(A.el('div', 'sbui-stack'), [
                A.hint(source.kind === 'cycle' ? '周期汇报 · 登记 #' + source.entry_id : '临时要求 #' + source.entry_id + '：' + (source.reason || '')),
                sourceEntry ? A.entryCorrectionsView(sourceEntry) : A.hint('勘误信息暂时无法读取，请打开登记核对。'),
            ]);
        }
        const names = { confirm: '待我确认', handle: '待我办理', opinion: '待我处理的意见', work_task: '待完成的任务', report_due: '应交进度汇报', report_overdue: '逾期进度汇报', send_failed: '通知发送失败', overdue: '超过三天待确认' };
        for (const [kind, title] of Object.entries(names)) {
            const visible = visibleRows(kind);
            const p = A.panel(title + ' · ' + (data.counts[kind] || 0));
            p.appendChild(A.table(['项目 / 内容', '时间', '操作'], visible.map((r) => {
                const ops = A.row();
                if (r.task_id) ops.appendChild(A.link('打开确认', { task: r.task_id, ...(r.revision_id ? { revision_id: r.revision_id } : {}) }));
                else if (r.opinion_id) ops.appendChild(A.link('查看意见', { project: r.project_id, tab: 'opinions', opinion: r.opinion_id }));
                else if (r.work_task_id) ops.appendChild(A.link('查看任务', { project: r.project_id, tab: 'plan', node: r.node_id, work_task: r.work_task_id }));
                else if (kind === 'send_failed') ops.appendChild(A.link('查看通知处理', { project: r.project_id, tab: 'notifications' }));
                else if (['report_due', 'report_overdue'].includes(kind)) ops.appendChild(A.link('查看进度汇报', { project: r.project_id, tab: 'plan', node: r.node_id }));
                else if (r.project_id) ops.appendChild(A.link('打开项目', { project: r.project_id, tab: r.entry_id ? 'entries' : 'overview', ...(r.entry_id ? { entry: r.entry_id } : {}) }));
                return [A.append(A.el('div'), [A.text(r.system_name || r.project && r.project.system_name), A.hint(r.message || r.title || labelOf(purposeLabels, r.purpose) || r.reason || ''), ...(r.sources || []).map((s) => reportSource(r, s))]), r.due_on || r.created_at || r.decided_at || '', ops];
            })));
            p.appendChild(A.append(A.el('div', 'sbui-panel-body'), [A.hint('计数为全部待办，本页每类最多展示 50 条。')]));
            host.appendChild(p);
        }
        return host;
    }
    function help() {
        const host = A.el('div');
        host.appendChild(heading('项目管理帮助', '把推进事实、原始凭据和对应人的确认放在同一份项目档案中。'));
        host.appendChild(A.panel('留痕规定', [
            A.hint('一、未在平台登记并确认的功能或调整，开发方不安排；已经做了的，不作为验收、结算和工期顺延的依据。由此产生的问题，先补登记再排期；影响业务运行的故障按影响处理，处理后一个工作日内补登记。'),
            A.hint('二、需要留痕的范围：涉及范围、验收标准、工期或交付承诺的事项。开发方内部的技术实现调整不在此列。'),
            A.hint('三、「平台」包括项目管理与系统迭代：批次正式上线前在项目管理里登记，正式上线后在系统迭代里提单。'),
            A.hint('以上规定在本次功能上线后，由项目负责人通知各方生效；此前只作口头要求。第一条的补登记时限属于规定，不由平台自动强制。'),
        ]));
        host.appendChild(A.panel('当前操作方式', [
            A.hint('需求方、开发方和 PM 都可在项目中提意见或需求。用意见跟踪评估、去向和后续任务。'),
            A.hint('阶段可独立开始和完成。范围确认前也可以开始开发，项目会显示「范围未确认已开工」。涉及交付承诺的事项按对应关口确认。'),
            A.hint('开发阶段按登记节奏汇报。未登记时默认每周，自研默认每两周。PM 可登记临时汇报要求，逾期在汇报区和待办中提示。'),
        ]));
        host.appendChild(A.panel('四个关口', [
            A.hint('立项：PM 整理立项依据并发起确认，各需求部门的现任领导本人确认。'),
            A.hint('范围：各需求部门的现任负责人确认需求文档和验收、正式上线、结项的计划日期。自研使用正式上线、结项两个日期。确认生效后形成这些阶段的基线。'),
            A.hint('验收：各需求部门的现任负责人确认本次验收记录。范围和验收都生效后，PM 可记录正式上线。'),
            A.hint('结项：核对必须做的事均完成、意见有结论、任务有结果且已正式上线后，可发起结项确认。各需求部门的现任负责人确认后，由 PM 完成结项。'),
            A.hint('范围、验收和结项发起时通知需求方领导。负责人从「等我处理」打开确认正文，核对版本和冻结附件后本人作决定。'),
            A.hint('本人确认的阅读与声明可以在确认记录中核对。有异议不算确认，不设逾期自动同意。新版本不会继承旧版本确认。'),
        ]));
        host.appendChild(A.panel('意见、任务和汇报', [
            A.hint('从项目的「提意见或需求」开始。PM 初判，开发负责人给意见和工时，PM 定去向。PM 初判时可以跳过开发方给意见和工时这一步，填写原因后直接定去向。本期做会生成任务，留到下一期或不做会留下结论。PM 代录开发意见与工时时须附开发方意见截图。'),
            A.hint('开发方提出砍需求时，由原范围确认的各需求部门的现任负责人本人表态。同意后的范围调整在原确认的调整记录中查看。'),
            A.hint('从对应阶段看任务、写完成结果或取消原因。从开发阶段提交进度汇报，打开「汇报明细与历史」可核对期次来源和勘误。'),
        ]));
        host.appendChild(A.panel('材料和确认记录', [
            A.hint('在阶段的必须做的事卡片上传材料。需求文档和验收记录须有带可用附件的版本，且该版全部附件可用。立项依据没有合格版本时可填写无书面依据原因，提交确认时冻结该声明。'),
            A.hint('有合格版本时按材料办理。合同或订单、运维交接材料与自建必做材料卡，没有合格版本时可标为不适用。上传一版后，先前声明或不适用失效。仍没有合格版本时可重新填写。'),
            A.hint('确认保存对应版本和附件。新上传、补充登记和日期更正继续留痕。打开「全部记录」可查对方确认、材料和登记，已生效版本可按权限查看归档确认单。'),
        ]));
        host.appendChild(A.panel('在建项目和上线分界', [
            A.hint('在建项目照常建档，用阶段的「更正实际日期」补记真实日期。已有的书面凭据随材料上传。'),
            A.hint('正式上线后，新功能和问题走系统迭代受理渠道，项目可保留单号与链接。迭代单按系统迭代的权限查看。'),
        ]));
        return host;
    }
    async function timeline(detail, params, c) {
        const labels = Object.freeze({
            project_created: '建立项目', project_updated: '修改项目基本信息', project_status_changed: '变更项目状态', project_pm_changed: '更换 PM / 接管',
            party_created: '添加参与方', party_renamed: '修改参与方名称', member_added: '添加成员', member_removed: '移出成员',
            appointment_activated: '领导任职生效', appointment_ended: '结束领导任职',
            delegation_activated: '负责人授权生效', delegation_revoked: '撤销负责人授权',
            node_created: '带出 / 新增节点', node_started: '开始节点', node_closed: '收口节点', node_reopened: '重开节点', node_cancelled: '取消节点', node_plan_set: '设定节点计划', node_rescheduled: '调整节点排期', node_actual_corrected: '更正实际日期',
            package_version_submitted: '提交内容包确认', package_version_effective: '内容包生效', package_version_withdrawn: '撤回内容包确认', confirmation_recorded: '记录本人确认决定',
            entry_created: '新增登记', entry_action_recorded: '追加办理记录',
            golive_recorded: '记录正式上线', golive_revoked: '撤销正式上线',
            attachment_staged: '暂存附件', attachment_bound: '绑定附件', attachment_frozen: '冻结确认附件清单', attachment_masked: '受控遮蔽附件', attachment_deleted: '软删除附件',
            send_intent_attempted: '记录通知发送尝试', send_intents_resent: '补发通知', notice_created: '生成知会',
            opinion_created: '提出意见', opinion_triaged: '意见初判', opinion_assessed: '记录开发意见',
            opinion_concluded: '意见得到结论', opinion_cut_decided: '需求方本人表态', opinion_cut_withdrawn: '撤回同意请求',
            work_task_created: '新增阶段任务', work_task_resolved: '记录任务结果',
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
            if (e.object_type === 'opinion') return { project: detail.project.id, tab: 'opinions', opinion: e.object_id };
            if (e.object_type === 'work_task') return { project: detail.project.id, tab: 'plan', work_task: e.object_id };
            if (['member', 'appointment', 'delegation', 'party'].includes(e.object_type)) return { project: detail.project.id, tab: 'members' };
            return { project: detail.project.id, tab: 'overview' };
        }
        async function load(cc) {
            const result = await A.request('/projects/' + detail.project.id + '/events?limit=50' + (!first && cursor ? '&before=' + cursor : ''), null, cc);
            A.assertCurrent(cc);
            first = false;
            all.push(...result.items);
            cursor = result.next_before;
            holder.replaceChildren(A.table(['时间', '发生了什么', '操作人', '相关记录'], all.map((e) => [e.created_at, e.label || labels[e.event_type] || '追加项目推进事实', e.operator_name, A.link('查看相关记录 #' + e.object_id, target(e))])));
            more.hidden = cursor === null;
        }
        await load(c);
        host.appendChild(holder);
        host.appendChild(A.append(A.el('div', 'sbui-panel-body'), [more]));
        return host;
    }
    A.registerRoute('list', list); A.registerRoute('new', newProject); A.registerRoute('project', project); A.registerRoute('todo', todo); A.registerRoute('help', help);
    A.registerTab('timeline', '全项目时间线', timeline);
    A.registerTab('records', '全部记录', allRecords);
    A.heading = heading; A.labelOf = labelOf; A.projectLabels = projectLabels; A.nodeLabels = nodeLabels;
}());
