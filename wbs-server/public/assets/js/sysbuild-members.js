/* 成员、负责人任职、代表人授权。显示动作完全消费逐对象 actions。 */
(function () {
    'use strict';
    const A = window.SysBuildUI;
    const labels = Object.freeze({ joined: '已加入', pending: '待本人接受', removed: '已移出', active: '已生效', ended: '任期已结束', pending_owner: '待负责人批准', pending_accept: '待代表人接受', rejected: '已拒绝', withdrawn: '已撤回', revoked: '已撤销' });
    const nameOf = (x) => labels[x] || String(x || '—');
    const reason = (label) => ({ name: 'reason', label: label || '原因', type: 'textarea', required: true, max: 500 });
    const evidence = () => [
        { name: 'external_date', label: '实际确认日期', type: 'date', required: true },
        { name: 'actual_confirmer', label: '实际确认人', required: true, max: 100 },
        { name: 'identity_basis', label: '当时任职或授权依据', type: 'textarea', required: true, max: 2000 },
        { name: 'files', label: '原始凭据附件', type: 'file', multiple: true, required: true, hint: '至少一份能对应本次确认的原始凭据。附件暂存后 24 小时内须提交。' },
    ];
    async function save(path, values, c, method) {
        await A.request(path, { method: method || 'POST', body: values }, c);
        await A.render();
    }
    function reasonAction(label, path) {
        A.dialog(label, [reason()], (v, c) => save(path, v, c), label);
    }
    function proxyAction(label, projectId, path, expectedStep) {
        A.dialog(label, evidence(), async (v, c) => {
            const attachment_ids = await A.stageFiles(projectId, v.files, c);
            await save(path, { external_date: v.external_date, actual_confirmer: v.actual_confirmer, identity_basis: v.identity_basis, attachment_ids, ...(expectedStep ? { expected_step: expectedStep } : {}) }, c);
        }, '提交代录凭据');
    }
    function stamp(label, member) {
        const n = A.el('div', 'sbui-stamp');
        return A.append(n, [A.el('small', '', label), A.el('strong', '', member ? member.name : '暂无生效记录'), A.el('small', '', member ? member.effective_at : '请查看下方任职 / 授权记录')]);
    }
    async function addMember(detail, c, partyId) {
        const lease = A.reserveDialog(c);
        const users = await A.request('/users/active', { platform: true }, lease);
        A.assertCurrent(lease);
        const opts = [['', '请选择平台账号'], ...users.map((u) => [u.id, u.display_name || u.username])];
        A.dialog('添加成员 / 发加入邀请', [
            { name: 'party_id', label: '所属参与方', value: partyId || '', options: [['', '信息技术部内部成员'], ...detail.parties.map((p) => [p.id, p.name])] },
            { name: 'user_id', label: '平台账号', options: opts, hint: '有账号的人须本人接受后才加入。没有平台账号时留空，并在下一项填写姓名。' },
            { name: 'person_name', label: '无平台账号人员姓名', max: 100, hint: '平台账号与无账号姓名只填一项。无账号人员登记进名录后，其任职 / 授权仍须有原始凭据才可由 PM 代录生效。' },
        ], (v, cc) => {
            const body = { party_id: v.party_id ? A.id(v.party_id) : null };
            if (v.user_id) body.user_id = A.id(v.user_id);
            if (v.person_name.trim()) body.person_name = v.person_name;
            return save('/projects/' + detail.project.id + '/members', body, cc);
        }, '添加 / 发送邀请', lease);
    }
    function propose(detail, p, kind) {
        const title = kind === 'appointments' ? '提议负责人任职' : '发起代表人授权';
        const candidates = detail.members.filter((m) => m.party_id === p.id && m.status === 'joined');
        A.dialog(title, [{ name: 'member_id', label: p.name + '的已加入成员', required: true, options: [['', '请选择'], ...candidates.map((m) => [m.id, m.name])], hint: kind === 'appointments' ? '本人接受任职后才生效；更换负责人会结束原任职及其授权。' : '须由现任负责人批准、被授权人本人接受后才生效；负责人和代表人分设。' }], (v, c) => save('/parties/' + p.id + '/' + kind, { member_id: A.id(v.member_id) }, c), title);
    }
    function appointmentButtons(detail, a, c) {
        const actions = a.actions || {};
        const out = A.row();
        if (actions.accept === true && a.invitation_id) out.appendChild(A.link('查看并接受任职', { invitation: a.invitation_id }));
        if (actions.decline === true && a.invitation_id) out.appendChild(A.link('查看 / 拒绝', { invitation: a.invitation_id }));
        if (actions.withdraw === true) {
            const b = A.button('撤回任职提议', () => { A.assertCurrent(c); A.perform(b, '/appointments/' + a.id + '/withdraw', {}); });
            out.appendChild(b);
        }
        if (actions.end === true) out.appendChild(A.button('结束任职', () => { A.assertCurrent(c); reasonAction('结束负责人任职', '/appointments/' + a.id + '/end'); }, 'danger'));
        if (actions.proxy_accept === true) out.appendChild(A.button('代录接受任职', () => { A.assertCurrent(c); proxyAction('代录无账号负责人的任职接受', detail.project.id, '/appointments/' + a.id + '/proxy-accept'); }));
        return out;
    }
    function delegationButtons(detail, d, c) {
        const actions = d.actions || {};
        const out = A.row();
        const texts = { approve: '负责人批准授权', reject: '负责人拒绝授权', accept: '本人接受授权', decline: '本人拒绝授权', withdraw: '撤回授权提议' };
        for (const [key, label] of Object.entries(texts)) if (actions[key] === true) {
            const b = A.button(label, () => { A.assertCurrent(c); A.perform(b, '/delegations/' + d.id + '/' + key, {}); });
            out.appendChild(b);
        }
        if (actions.revoke === true) out.appendChild(A.button('撤销授权', () => { A.assertCurrent(c); reasonAction('撤销代表人授权', '/delegations/' + d.id + '/revoke'); }, 'danger'));
        if (actions.proxy === true && d.status === 'pending_owner') out.appendChild(A.button('代录负责人批准', () => { A.assertCurrent(c); proxyAction('代录无账号负责人的批准', detail.project.id, '/delegations/' + d.id + '/proxy', 'grant'); }));
        if (actions.proxy === true && d.status === 'pending_accept') out.appendChild(A.button('代录代表人接受', () => { A.assertCurrent(c); proxyAction('代录无账号代表人的接受', detail.project.id, '/delegations/' + d.id + '/proxy', 'accept'); }));
        return out;
    }
    async function members(detail, params, c) {
        const host = A.el('div');
        const controls = A.row();
        if (detail.actions.add_party === true) controls.appendChild(A.button('添加参与方', () => {
            A.assertCurrent(c);
            A.dialog('添加参与方', [
                { name: 'side', label: '类型', required: true, options: detail.actions.party_sides.map((s) => [s, s === 'demand' ? '需求部门' : '开发方']) },
                { name: 'name', label: '名称', required: true, max: 100 },
            ], (v, cc) => save('/projects/' + detail.project.id + '/parties', v, cc));
        }));
        if (detail.actions.add_member === true) controls.appendChild(A.command('添加成员', () => addMember(detail, c), '', c));
        host.appendChild(A.panel('成员与授权', [A.hint('加入、负责人任职、代表人授权分别生效。后加入者可看全部历史；负责人或授权更换后，以当前任职与授权决定下一步操作资格。')], controls));
        for (const p of detail.parties) {
            const ops = A.row();
            const act = p.actions || {};
            if (act.rename === true) ops.appendChild(A.button('改名', () => { A.assertCurrent(c); A.dialog('修改参与方名称', [{ name: 'name', label: '名称', value: p.name, required: true, max: 100 }], (v, cc) => save('/parties/' + p.id, v, cc, 'PATCH')); }));
            if (act.propose_appointment === true) ops.appendChild(A.button('指定负责人', () => { A.assertCurrent(c); propose(detail, p, 'appointments'); }));
            if (act.propose_delegation === true) ops.appendChild(A.button('授权代表人', () => { A.assertCurrent(c); propose(detail, p, 'delegations'); }));
            if (detail.actions.add_member === true) ops.appendChild(A.command('添加本方成员', () => addMember(detail, c, p.id), '', c));
            const part = A.panel((p.side === 'demand' ? '需求方 · ' : '开发方 · ') + p.name, null, ops);
            part.appendChild(A.append(A.el('div', 'sbui-chain'), [stamp('现任负责人', p.owner), A.hint('授权 → 本人接受'), stamp('生效代表人', p.delegate)]));
            const appts = detail.appointments.filter((a) => a.party_id === p.id);
            const dels = detail.delegations.filter((d) => d.party_id === p.id);
            part.appendChild(A.table(['任职 / 授权', '姓名', '状态', '生效 / 结束时间', '操作'], [
                ...appts.map((a) => ['负责人任职 #' + a.id, a.name, nameOf(a.status), A.append(A.el('div'), [A.text(a.effective_at), A.hint(a.ended_at || ''), a.end_reason ? A.hint(a.end_reason) : null]), appointmentButtons(detail, a, c)]),
                ...dels.map((d) => ['代表人授权 #' + d.id, d.name, nameOf(d.status), A.append(A.el('div'), [A.text(d.effective_at), A.hint(d.revoked_at || ''), d.revoke_reason ? A.hint(d.revoke_reason) : null]), delegationButtons(detail, d, c)]),
            ]));
            host.appendChild(part);
        }
        const partyName = (id) => { const p = detail.parties.find((x) => x.id === id); return p ? p.name : '信息技术部内部成员'; };
        const memberRows = detail.members.map((m) => {
            const ops = A.row();
            if (m.actions && m.actions.remove === true) ops.appendChild(A.button('移出', () => { A.assertCurrent(c); reasonAction('移出 ' + m.name, '/members/' + m.id + '/remove'); }, 'danger'));
            return [m.name, partyName(m.party_id), m.user_id === null ? '无平台账号' : '平台账号', nameOf(m.status), A.append(A.el('div'), [A.text(m.joined_at), m.removed_reason ? A.hint('移出原因：' + m.removed_reason) : null]), ops];
        });
        const all = A.panel('成员名录');
        all.appendChild(A.table(['姓名', '所属参与方', '账号', '加入状态', '时间 / 原因', '操作'], memberRows));
        host.appendChild(all);
        return host;
    }
    async function invitation(params, c) {
        const iid = A.id(params.get('invitation'));
        const response = await A.request('/my/invitations/' + iid, null, c);
        const data = response.invitation;
        const host = A.panel(data.kind === 'appointment' ? '接受负责人任职' : '接受加入项目', [
            A.facts([['项目', data.project.system_name], ['期次', data.project.phase_name], ['参与方', data.role.party_name], ['邀请人', data.invited_by_name], ['邀请时间', data.invited_at], ['状态', nameOf(data.status)]]),
            A.hint(data.permission_note),
            A.hint('接受之前仅展示本邀请的必要上下文；接受成功后才可查看项目历史。'),
        ]);
        const controls = A.row();
        if (data.actions.accept === true) {
            controls.appendChild(A.command(data.kind === 'appointment' ? '本人接受任职' : '本人接受加入', async (cc) => {
                const result = await A.request('/my/invitations/' + iid + '/accept', { method: 'POST', body: {} }, cc);
                A.navigate({ project: result.project_id });
            }, 'primary', c));
        }
        if (data.actions.decline === true) controls.appendChild(A.command('拒绝邀请', async (cc) => {
            await A.request('/my/invitations/' + iid + '/decline', { method: 'POST', body: {} }, cc);
            A.navigate({ todo: '1' });
        }, '', c));
        host.appendChild(A.append(A.el('div', 'sbui-panel-body'), [controls]));
        return host;
    }
    async function delegation(params, c) {
        const did = A.id(params.get('delegation'));
        const list = await A.request('/my/invitations', null, c);
        const d = list.delegations.find((x) => x.id === did);
        if (!d) return A.panel('授权已处理或当前不可见', [A.hint('请在我的待办查看当前可处理的授权。'), A.link('我的待办', { todo: '1' })]);
        const host = A.panel('本人接受代表人授权', [A.facts([['项目', d.project.system_name], ['期次', d.project.phase_name], ['参与方', d.role.party_name], ['发起人', d.proposed_by_name], ['发起时间', d.proposed_at], ['状态', nameOf(d.status)]]), A.hint(d.permission_note)]);
        const ops = A.row();
        if (d.actions.accept === true) ops.appendChild(A.command('本人接受授权', async (cc) => {
            const result = await A.request('/delegations/' + did + '/accept', { method: 'POST', body: {} }, cc);
            A.navigate({ project: result.project_id, tab: 'members' });
        }, 'primary', c));
        if (d.actions.decline === true) ops.appendChild(A.command('拒绝授权', async (cc) => {
            await A.request('/delegations/' + did + '/decline', { method: 'POST', body: {} }, cc);
            A.navigate({ todo: '1' });
        }, '', c));
        host.appendChild(A.append(A.el('div', 'sbui-panel-body'), [ops]));
        return host;
    }
    A.registerTab('members', '成员与授权', members);
    A.registerRoute('invitation', invitation);
    A.registerRoute('delegation', delegation);
    A.membersView = members;
    A.evidenceFields = evidence;
}());
