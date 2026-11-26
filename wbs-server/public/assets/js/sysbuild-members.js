/* 人员指定、有效任职和授权及历史。操作入口使用服务端返回的 actions。 */
(function () {
    'use strict';
    const A = window.SysBuildUI;
    const labels = Object.freeze({ joined: '已加入', removed: '已移出', active: '已生效', ended: '已结束', revoked: '已撤销' });
    const statusText = (status) => labels[status] || String(status || '—');
    const reason = () => ({ name: 'reason', label: '原因', type: 'textarea', required: true, max: 500 });
    const usersOptions = (users) => [['', '请选择平台账号'], ...users.map((user) => [user.id, user.display_name || user.username])];
    const nullableId = (value) => value ? A.id(value) : null;
    const leaderLabel = (side) => side === 'dev' ? '开发方领导' : '需求方领导';
    const representativeLabel = (side) => side === 'dev' ? '开发负责人' : '需求方负责人';

    async function save(path, values, c, method) {
        await A.request(path, { method: method || 'POST', body: values }, c);
        await A.render();
    }
    function reasonAction(label, path) {
        A.dialog(label, [reason()], (values, c) => save(path, values, c), label);
    }
    function stamp(label, member) {
        return A.append(A.el('div', 'sbui-stamp'), [
            A.el('small', '', label), A.el('strong', '', member ? member.name : '待指定'),
            member ? A.el('small', '', member.effective_at) : null,
        ]);
    }
    function pairFields(side, options, leader, representative, requireRepresentative = side === 'demand') {
        return [
            { name: 'leader_user_id', label: leaderLabel(side), required: true, value: leader || '', options },
            { name: 'representative_user_id', label: representativeLabel(side), required: requireRepresentative, value: representative || '', options },
        ];
    }
    const pairValues = (values) => ({
        leader_user_id: nullableId(values.leader_user_id), representative_user_id: nullableId(values.representative_user_id),
    });

    function initialDemandField(options) {
        return {
            name: 'demand_parties',
            required: true,
            label: '需求部门',
            render(c) {
                const group = A.el('fieldset', 'sbui-full');
                group.name = 'demand_parties';
                const rows = A.el('div');
                const fields = [];
                const update = () => {
                    fields.forEach(({ row, title, remove }, index) => {
                        title.textContent = '需求部门 ' + (index + 1);
                        remove.hidden = fields.length === 1;
                        row.dataset.index = String(index);
                    });
                };
                const add = () => {
                    A.assertCurrent(c);
                    const row = A.el('fieldset');
                    const title = A.el('legend', '', '');
                    const name = A.el('input');
                    name.name = 'demand_name'; name.required = true; name.maxLength = 50;
                    const leader = A.el('select');
                    leader.name = 'demand_leader_user_id'; leader.required = true;
                    const representative = A.el('select');
                    representative.name = 'demand_representative_user_id'; representative.required = true;
                    for (const select of [leader, representative]) {
                        for (const [value, caption] of options) {
                            const option = A.el('option', '', caption);
                            option.value = String(value);
                            select.appendChild(option);
                        }
                    }
                    const input = (label, control) => A.append(A.el('label'), [A.el('span', 'sbui-label', label), control]);
                    const remove = A.button('移除这组需求部门', () => {
                        A.assertCurrent(c);
                        const index = fields.findIndex((item) => item.row === row);
                        if (index < 0 || fields.length === 1) return;
                        fields.splice(index, 1);
                        row.remove();
                        update();
                    });
                    A.append(row, [title, A.append(A.el('div', 'sbui-form-grid'), [
                        input('部门名称', name), input('需求方领导', leader), input('需求方负责人', representative),
                    ]), remove]);
                    rows.appendChild(row);
                    fields.push({ row, title, remove, name, leader, representative });
                    update();
                };
                A.append(group, [A.el('legend', 'sbui-label', '需求部门（必填）'), rows, A.button('再添加一个需求部门', add)]);
                add();
                return { label: group, control: group, def: this, readValue: () => fields.map(({ name, leader, representative }) => ({
                    name: name.value, leader_user_id: nullableId(leader.value), representative_user_id: nullableId(representative.value),
                })) };
            },
        };
    }
    function initialPeopleFields(options) {
        return [
            initialDemandField(options),
            { name: 'dev_name', label: '开发方名称', max: 50, hint: '开发方可以稍后填写。填写时请选开发方领导。' },
            { name: 'dev_leader_user_id', label: '开发方领导', options },
            { name: 'dev_representative_user_id', label: '开发负责人', options },
        ];
    }
    async function addParty(detail, side, c) {
        const lease = A.reserveDialog(c);
        const options = usersOptions(await A.request('/users/active', { platform: true }, lease));
        A.assertCurrent(lease);
        const title = side === 'dev' ? '添加开发方' : '添加需求部门';
        A.dialog(title, [
            { name: 'name', label: side === 'dev' ? '开发方名称' : '需求部门名称', required: true, max: 50 },
            ...pairFields(side, options),
        ], (values, cc) => save('/projects/' + detail.project.id + '/parties', { side, name: values.name, ...pairValues(values) }, cc), title, lease);
    }
    async function assignPeople(party, c) {
        const lease = A.reserveDialog(c);
        const options = usersOptions(await A.request('/users/active', { platform: true }, lease));
        A.assertCurrent(lease);
        const title = party.name + ' · 指定或更换人员';
        const form = A.dialog(title, [
            ...pairFields(party.side, options, party.owner?.user_id, party.delegate?.user_id, party.side === 'demand' || !!party.delegate),
            reason(),
        ], (values, cc) => save('/parties/' + party.id + '/people', {
            ...pairValues(values), reason: values.reason,
            expected_appointment_id: party.owner?.appointment_id ?? null,
            expected_delegation_id: party.delegate?.delegation_id ?? null,
        }, cc, 'PUT'), '保存人员', lease);
        form.prepend(A.hint('更换领导后，旧任职和授权会结束。沿用原负责人时，仍需改发该负责人尚待确认的任务。'));
    }
    async function addDeveloper(detail, c, party) {
        const lease = A.reserveDialog(c);
        const users = await A.request('/users/active', { platform: true }, lease);
        A.assertCurrent(lease);
        const current = new Set(detail.members.filter((member) => member.status !== 'removed').map((member) => member.user_id));
        A.dialog('添加开发人员', [{ name: 'user_id', label: '平台账号', required: true, options: usersOptions(users.filter((user) => !current.has(user.id))) }],
            (values, cc) => save('/projects/' + detail.project.id + '/members', { party_id: party.id, user_id: A.id(values.user_id) }, cc), '添加人员', lease);
    }
    function historyCell(row, end, why) {
        return A.append(A.el('div'), [A.text(row.effective_at), row[end] ? A.hint(row[end]) : null, row[why] ? A.hint(row[why]) : null]);
    }
    function historyAction(allowed, label, path, c) {
        return allowed ? A.button(label, () => { A.assertCurrent(c); reasonAction(label, path); }, 'danger') : '';
    }
    async function members(detail, params, c) {
        const host = A.el('div');
        const controls = A.row();
        for (const side of detail.actions.party_sides || []) {
            const label = side === 'dev' ? '添加开发方' : '添加需求部门';
            controls.appendChild(A.command(label, () => addParty(detail, side, c), '', c));
        }
        host.appendChild(A.panel('项目人员', null, controls));
        for (const party of detail.parties) {
            const ops = A.row();
            const act = party.actions || {};
            if (act.rename === true) ops.appendChild(A.button('改名', () => {
                A.assertCurrent(c);
                A.dialog('修改参与方名称', [{ name: 'name', label: '名称', value: party.name, required: true, max: 50 }],
                    (values, cc) => save('/parties/' + party.id, values, cc, 'PATCH'));
            }));
            if (act.assign_people === true) ops.appendChild(A.command('指定或更换人员', () => assignPeople(party, c), '', c));
            if (party.side === 'dev' && detail.actions.add_member === true) ops.appendChild(A.command('添加开发人员', () => addDeveloper(detail, c, party), '', c));
            const part = A.panel((party.side === 'demand' ? '需求方 · ' : '开发方 · ') + party.name, null, ops);
            part.appendChild(A.append(A.el('div', 'sbui-chain'), [stamp(leaderLabel(party.side), party.owner), stamp(representativeLabel(party.side), party.delegate)]));
            const appointments = detail.appointments.filter((row) => row.party_id === party.id);
            const delegations = detail.delegations.filter((row) => row.party_id === party.id);
            part.appendChild(A.table(['任职 / 授权', '姓名', '状态', '生效 / 结束时间', '操作'], [
                ...appointments.map((row) => ['领导任职 #' + row.id, row.name, statusText(row.status), historyCell(row, 'ended_at', 'end_reason'),
                    historyAction(row.actions.end, '结束领导任职', '/appointments/' + row.id + '/end', c)]),
                ...delegations.map((row) => ['负责人授权 #' + row.id, row.name, statusText(row.status), historyCell(row, 'revoked_at', 'revoke_reason'),
                    historyAction(row.actions.revoke, '撤销负责人授权', '/delegations/' + row.id + '/revoke', c)]),
            ]));
            host.appendChild(part);
        }
        const partyNames = new Map(detail.parties.map((party) => [party.id, party.name]));
        const memberRows = detail.members.map((member) => [
            member.name, partyNames.get(member.party_id) || '信息技术部内部成员', statusText(member.status),
            A.append(A.el('div'), [A.text(member.joined_at), member.removed_reason ? A.hint('移出原因：' + member.removed_reason) : null]),
            historyAction(member.actions && member.actions.remove, '移出 ' + member.name, '/members/' + member.id + '/remove', c),
        ]);
        const all = A.panel('成员名录');
        all.appendChild(A.table(['姓名', '所属参与方', '加入状态', '时间 / 原因', '操作'], memberRows));
        host.appendChild(all);
        return host;
    }

    A.personOptions = usersOptions;
    A.initialPeopleFields = initialPeopleFields;
    A.membersView = members;
    A.registerTab('members', '成员与授权', members);
}());
