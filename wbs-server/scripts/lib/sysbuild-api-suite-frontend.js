'use strict';
const assert = require('assert');
const CASE_CAPS = 'C7 页面入口能力';
const CASE_EVENTS = 'C7 时间线元数据';
const CASE_EVENT_VIS = 'C7 时间线对象可见性';
const CASE_SCHEDULE_VIS = 'C7 S-1 改期知会详情可见性';
function defineFrontendCases(T) {
    const { test, U, api, sqlGet, sqlAll, setRole, mkProject, addMember, expectErr } = T;
    test(CASE_SCHEDULE_VIS + '：接收人、PM、管理员200；只读、其他成员、其他需求部门负责人404；异议原文与接收人不泄露', async () => {
        const call = async (uid, method, url, body, status = 200) => {
            const response = await api(uid, method, '/sysbuild' + url, body);
            assert.strictEqual(response.status, status, response.text); return response.body;
        };
        const post = (uid, url, body, status) => call(uid, 'POST', url, body || {}, status);
        const pid = (await post(U.pm, '/projects', { system_name: '改期异议读面', build_type: 'inhouse' }, 201)).project.id;
        for (const [uid, delegate] of [[U.own, U.del], [U.x1, U.x2]]) {
            const party = (await post(U.pm, '/projects/' + pid + '/parties', { side: 'demand', name: '需求方' + uid }, 201)).party.id;
            const added = await post(U.pm, '/projects/' + pid + '/members', { user_id: uid, party_id: party }, 201);
            await post(uid, '/my/invitations/' + added.invitation.id + '/accept');
            const appt = await post(U.pm, '/parties/' + party + '/appointments', { member_id: added.member.id }, 201);
            await post(uid, '/my/invitations/' + appt.invitation.id + '/accept');
            const representative = await post(U.pm, '/projects/' + pid + '/members', { user_id: delegate, party_id: party }, 201);
            await post(delegate, '/my/invitations/' + representative.invitation.id + '/accept');
            const delegation = (await post(uid, '/parties/' + party + '/delegations', { member_id: representative.member.id }, 201)).delegation.id;
            await post(delegate, '/delegations/' + delegation + '/accept');
        }
        await addMember(pid, U.m1);
        async function submitAndConfirm(type, item, batch) {
            const pkg = (await post(U.pm, '/projects/' + pid + '/packages', { type }, 201)).package.id;
            const vid = (await post(U.pm, '/packages/' + pkg + '/versions', {}, 201)).version.id;
            if (item) await post(U.pm, '/package-versions/' + vid + '/items', { op: 'add', item_version_id: item, committed_batch_id: batch }, 201);
            await post(U.pm, '/package-versions/' + vid + '/submit');
            const tasks = (await call(U.pm, 'GET', '/package-versions/' + vid + '/confirm-tasks')).tasks;
            for (const task of tasks) {
                const member = await sqlGet('SELECT user_id FROM sysbuild_members WHERE id = ?', [task.current_revision.required_member_id]);
                const opened = await call(member.user_id, 'GET', '/confirm-tasks/' + task.task_id);
                await post(member.user_id, '/confirm-tasks/' + task.task_id + '/decide', { revision_id: opened.revision.id, object_version_id: vid, decision: 'confirm', checkbox_text: opened.checkbox_texts.confirm });
            }
        }
        await submitAndConfirm('initiation');
        const plan = await call(U.pm, 'GET', '/projects/' + pid + '/plan');
        for (const node of plan.nodes) await post(U.pm, '/nodes/' + node.id + '/schedule', { kind: 'plan', planned_start: '2026-11-02', planned_end: '2026-11-30' }, 201);
        const item = (await post(U.pm, '/projects/' + pid + '/items', { content: '改期知会所依规划需求', proposer_name: '线下提出人', no_written_evidence: true, no_evidence_reason: '当面沟通形成的需求没有书面原始材料' }, 201)).item;
        await submitAndConfirm('overall', item.versions[0].id, plan.batches[0].id);
        const milestone = plan.nodes.find((n) => n.is_golive_milestone);
        await post(U.pm, '/nodes/' + milestone.id + '/schedule', { kind: 'plan', planned_start: '2026-11-02', planned_end: '2026-12-15', reason: '需求部门提出推迟上线时间', no_written_evidence: true, no_evidence_reason: '本次会议讨论形成改期安排尚无书面原始材料' }, 201);
        const notice = await sqlGet("SELECT n.id FROM sysbuild_notices n JOIN sysbuild_members m ON m.id = n.recipient_member_id WHERE n.project_id = ? AND n.kind = 'schedule_change' AND m.user_id = ?", [pid, U.own]);
        assert.ok(notice, '必须生成发给第一需求部门负责人的改期知会');
        await post(U.own, '/notices/' + notice.id + '/object', { reason: '本部门仍有资源冲突，请PM协调后再安排' }, 201);
        for (const uid of [U.own, U.pm, U.admin]) {
            const detail = (await call(uid, 'GET', '/notices/' + notice.id)).notice;
            assert.strictEqual(detail.objection.reason, '本部门仍有资源冲突，请PM协调后再安排');
            assert.strictEqual(detail.objection.actor_user_id, U.own);
        }
        const absent = await api(U.ro, 'GET', '/sysbuild/notices/999999999');
        for (const uid of [U.ro, U.m1, U.x1, U.out]) {
            const denied = await api(uid, 'GET', '/sysbuild/notices/' + notice.id);
            expectErr(denied, 404, 'SYSBUILD_NOT_FOUND');
            assert.deepStrictEqual(denied.body, absent.body, '其他可见者不能枚举异议详情');
        }
    });
    test(CASE_CAPS + '：返回建项 / 全部项目 / 代建指定 PM 的服务端能力，三字段与手写身份矩阵逐项全等；viewer 与只读 admin 不获建项权限；只读查询不写事件或浏览', async () => {
        const projectCount = (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_projects', [])).n;
        const eventCount = (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_events', [])).n;
        const viewCount = (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_views', [])).n;
        const expected = [
            [U.pm, { create: true, list_all: false, create_pm_required: false }],
            [U.out, { create: true, list_all: false, create_pm_required: false }],
            [U.admin, { create: true, list_all: true, create_pm_required: true }],
            [U.ro, { create: false, list_all: true, create_pm_required: false }],
        ];
        for (const [uid, capabilities] of expected) {
            const response = await api(uid, 'GET', '/sysbuild/projects?scope=mine');
            assert.strictEqual(response.status, 200, response.text);
            assert.deepStrictEqual(response.body.actions, capabilities);
            if (capabilities.list_all) {
                const all = await api(uid, 'GET', '/sysbuild/projects?scope=all');
                assert.strictEqual(all.status, 200, all.text);
                assert.deepStrictEqual(all.body.actions, capabilities);
            }
        }
        const roles = await sqlAll('SELECT id, role FROM users WHERE id IN (?, ?)', [U.x3, U.ro]);
        try {
            await setRole(U.x3, 'viewer');
            await setRole(U.ro, 'admin');
            const viewer = await api(U.x3, 'GET', '/sysbuild/projects');
            assert.deepStrictEqual(viewer.body.actions, { create: false, list_all: false, create_pm_required: false });
            const readonlyAdmin = await api(U.ro, 'GET', '/sysbuild/projects');
            assert.deepStrictEqual(readonlyAdmin.body.actions, { create: false, list_all: true, create_pm_required: true });
        } finally {
            for (const row of roles) await setRole(row.id, row.role);
        }
        assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_projects', [])).n, projectCount);
        assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_events', [])).n, eventCount);
        assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_views', [])).n, viewCount);
    });
    test(CASE_EVENTS + '：仅项目可见者读取，游标分页不重复、不串项目，只给事实元数据，不带 payload / 文件名；读取不写事件或浏览', async () => {
        const pid = await mkProject(U.pm);
        await addMember(pid, U.m1);
        await addMember(pid, U.x1, { pending: true });
        await addMember(pid, U.x2, { removed: true });
        for (const goal of ['第一条事实', '第二条事实', '第三条事实']) assert.strictEqual((await api(U.pm, 'PATCH', '/sysbuild/projects/' + pid, { goal })).status, 200);
        const other = await mkProject(U.pm);
        await api(U.pm, 'PATCH', '/sysbuild/projects/' + other, { goal: '不应串进本项目' });
        const expected = await sqlAll('SELECT id, project_id, object_type, object_id, event_type, operator_id, operator_name, created_at FROM sysbuild_events WHERE project_id = ? ORDER BY id DESC', [pid]);
        const eventCount = (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_events', [])).n;
        const viewCount = (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_views', [])).n;
        for (const uid of [U.pm, U.m1, U.admin, U.ro]) {
            const got = [];
            let cursor = null;
            do {
                const result = await api(uid, 'GET', '/sysbuild/projects/' + pid + '/events?limit=1' + (cursor ? '&before=' + cursor : ''));
                assert.strictEqual(result.status, 200, result.text);
                assert.strictEqual(result.body.project_id, pid);
                assert.strictEqual(result.body.items.length, 1, '每页只返回请求的条数');
                for (const event of result.body.items) {
                    assert.deepStrictEqual(Object.keys(event).sort(), ['id', 'project_id', 'object_type', 'object_id', 'event_type', 'operator_id', 'operator_name', 'created_at'].sort());
                    assert.strictEqual(event.project_id, pid);
                    assert.strictEqual(event.event_type, 'project_updated');
                    assert.strictEqual(event.operator_id, U.pm);
                    assert.ok(typeof event.operator_name === 'string' && event.operator_name);
                    assert.ok(typeof event.created_at === 'string' && event.created_at);
                    assert.deepStrictEqual(event, expected.find((row) => row.id === event.id), '时间线事实须逐字段等于权威事件行，不能误配操作人、时刻或对象');
                    assert.ok(!got.includes(event.id), '游标分页不能重复');
                    got.push(event.id);
                }
                cursor = result.body.next_before;
            } while (cursor !== null && got.length < expected.length + 1);
            assert.strictEqual(cursor, null);
            assert.deepStrictEqual(got, expected.map((e) => e.id));
        }
        const absent = await api(U.out, 'GET', '/sysbuild/projects/999999999/events');
        for (const uid of [U.out, U.x1, U.x2]) {
            const denied = await api(uid, 'GET', '/sysbuild/projects/' + pid + '/events');
            expectErr(denied, 404, 'SYSBUILD_NOT_FOUND');
            assert.deepStrictEqual(denied.body, absent.body);
        }
        for (const query of ['limit=0', 'limit=101', 'limit=-1', 'limit=x', 'limit=1.5', 'limit[]=1', 'before=', 'before=0', 'before=-1', 'before=x', 'before[]=1']) expectErr(await api(U.out, 'GET', '/sysbuild/projects/' + pid + '/events?' + query), 400, 'SYSBUILD_INVALID_INPUT');
        assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_events', [])).n, eventCount);
        assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_views', [])).n, viewCount);
    });
    test(CASE_EVENT_VIS + '：成员页不可见的未接受 / 拒绝加入与未生效授权不得从事件旁路读取；本人和本方负责人按详情范围读取；生效后及撤销后的授权历史仍可见', async () => {
        const post = async (uid, url, body, status) => {
            const response = await api(uid, 'POST', '/sysbuild' + url, body || {});
            assert.strictEqual(response.status, status || 200, response.text);
            return response.body;
        };
        const pid = (await post(U.pm, '/projects', { system_name: '时间线权限对照', build_type: 'inhouse' }, 201)).project.id;
        const party = (await post(U.pm, '/projects/' + pid + '/parties', { side: 'demand', name: '授权方' }, 201)).party.id;
        const members = {};
        for (const uid of [U.m1, U.own, U.del, U.out]) {
            const added = await post(U.pm, '/projects/' + pid + '/members', { user_id: uid, party_id: uid === U.out ? null : party }, 201);
            members[uid] = added;
            if (uid !== U.out) await post(uid, '/my/invitations/' + added.invitation.id + '/accept');
        }
        const detail = async (uid) => (await api(uid, 'GET', '/sysbuild/projects/' + pid)).body;
        const timeline = async (uid) => {
            const result = await api(uid, 'GET', '/sysbuild/projects/' + pid + '/events?limit=100');
            assert.strictEqual(result.status, 200, result.text);
            assert.strictEqual(result.body.next_before, null, '本用例不超过 100 个可见事件');
            return result.body.items;
        };
        const hidden = await sqlAll("SELECT id FROM sysbuild_events WHERE project_id = ? AND ((object_type = 'member' AND object_id = ?) OR (object_type = 'invitation' AND object_id = ?))", [pid, members[U.out].member.id, members[U.out].invitation.id]);
        assert.ok(!(await detail(U.m1)).members.some((m) => m.id === members[U.out].member.id));
        assert.ok((await timeline(U.pm)).some((e) => hidden.some((h) => h.id === e.id)), 'PM 可以管理未接受意图');
        for (const uid of [U.m1, U.ro]) assert.ok(!(await timeline(uid)).some((e) => hidden.some((h) => h.id === e.id)), '普通成员 / 只读账号不能借时间线看到未接受加入意图');
        await post(U.out, '/my/invitations/' + members[U.out].invitation.id + '/decline');
        assert.ok(!(await timeline(U.m1)).some((e) => e.operator_id === U.out), '未加入者拒绝邀请的名字也不能从操作人字段泄漏');
        // 正常生产路径造出超过一批的隐藏意图，确认过滤不能截断更早的可见事实。
        for (let i = 0; i < 24; i += 1) {
            const added = await post(U.pm, '/projects/' + pid + '/members', { user_id: U.out }, 201);
            await post(U.out, '/my/invitations/' + added.invitation.id + '/decline');
        }
        const afterHidden = await timeline(U.m1);
        assert.ok(afterHidden.some((e) => e.event_type === 'project_created' && e.object_id === pid), '跨过隐藏事件的原始分片后仍须读到早期项目建立事实');
        assert.ok(!afterHidden.some((e) => e.operator_id === U.out));
        const appointment = await post(U.pm, '/parties/' + party + '/appointments', { member_id: members[U.own].member.id }, 201);
        await post(U.own, '/my/invitations/' + appointment.invitation.id + '/accept');
        const first = (await post(U.pm, '/parties/' + party + '/delegations', { member_id: members[U.del].member.id }, 201)).delegation.id;
        const eventsOfDelegation = async (id) => sqlAll("SELECT id FROM sysbuild_events WHERE project_id = ? AND object_type = 'delegation' AND object_id = ?", [pid, id]);
        const pendingEvents = await eventsOfDelegation(first);
        assert.ok(!(await detail(U.m1)).delegations.some((d) => d.id === first));
        assert.ok(!(await timeline(U.m1)).some((e) => pendingEvents.some((h) => h.id === e.id)));
        assert.ok((await timeline(U.own)).some((e) => pendingEvents.some((h) => h.id === e.id)), '本方负责人可读自己待批准的提议');
        await post(U.own, '/delegations/' + first + '/approve');
        assert.ok((await timeline(U.del)).some((e) => pendingEvents.some((h) => h.id === e.id)), '被授权人可读待本人接受的提议');
        await post(U.del, '/delegations/' + first + '/decline');
        const rejectedEvents = await eventsOfDelegation(first);
        assert.ok(!(await timeline(U.m1)).some((e) => rejectedEvents.some((h) => h.id === e.id)));
        const second = (await post(U.own, '/parties/' + party + '/delegations', { member_id: members[U.del].member.id }, 201)).delegation.id;
        await post(U.del, '/delegations/' + second + '/accept');
        const activeEvents = await eventsOfDelegation(second);
        assert.ok((await timeline(U.m1)).some((e) => activeEvents.some((h) => h.id === e.id)), '正式生效授权可见');
        await post(U.own, '/delegations/' + second + '/revoke', { reason: '人员调整，保留历史' });
        assert.ok((await detail(U.m1)).delegations.some((d) => d.id === second && d.status === 'revoked'));
        assert.ok((await timeline(U.m1)).some((e) => activeEvents.some((h) => h.id === e.id)), '撤销后的正式授权历史仍可见');
    });
}
const FRONTEND_MUTATIONS = [
    { id: 'C7 S-1 改期知会详情放行其他项目可见者', expect: [CASE_SCHEDULE_VIS], edits: [{ file: 'entries.js', from: "if (!access.isPm && !access.isAdmin && (!recipient || Number(recipient.user_id) !== uid)) throw rules.notFound();", to: 'void recipient;' }] },
    { id: 'C7 S-1 改期知会详情误拦接收人', expect: [CASE_SCHEDULE_VIS], edits: [{ file: 'entries.js', from: "if (!access.isPm && !access.isAdmin && (!recipient || Number(recipient.user_id) !== uid)) throw rules.notFound();", to: 'if (!access.isPm && !access.isAdmin) throw rules.notFound();' }] },
    { id: 'C7 建项能力绕过统一判定', expect: [CASE_CAPS], edits: [{ file: 'projects.js', from: 'create: rules.canCreateProject(platform),', to: 'create: true,' }] },
    { id: 'C7 全部项目入口能力恒假', expect: [CASE_CAPS], edits: [{ file: 'projects.js', from: 'list_all: rules.canListAll(platform),', to: 'list_all: false,' }] },
    { id: 'C7 admin 代建不要求选择 PM', expect: [CASE_CAPS], edits: [{ file: 'projects.js', from: 'create_pm_required: platform.isAdmin === true,', to: 'create_pm_required: false,' }] },
    { id: 'C7 时间线漏可见性', expect: [CASE_EVENTS], edits: [{ file: 'projects.js', from: 'const detail = await projectDetailView(q, pid, req.user);', to: 'const detail = { me: { is_pm: false, is_admin: false }, members: [], appointments: [], delegations: [] };' }] },
    { id: 'C7 时间线串项目', expect: [CASE_EVENTS], edits: [{ file: 'projects.js', from: 'FROM sysbuild_events WHERE project_id = ? AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?', to: 'FROM sysbuild_events WHERE ? IS NOT NULL AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?' }] },
    { id: 'C7 时间线游标包含上一页末项', expect: [CASE_EVENTS], edits: [{ file: 'projects.js', from: 'FROM sysbuild_events WHERE project_id = ? AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?', to: 'FROM sysbuild_events WHERE project_id = ? AND (? IS NULL OR id <= ?) ORDER BY id DESC LIMIT ?' }] },
    { id: 'C7 时间线不继续分页', expect: [CASE_EVENTS], edits: [{ file: 'projects.js', from: 'next_before: hasMore && items.length ? items[items.length - 1].id : null', to: 'next_before: null' }] },
    { id: 'C7 时间线多给一项', expect: [CASE_EVENTS], edits: [{ file: 'projects.js', from: 'const items = visibleRows.slice(0, limit);', to: 'const items = visibleRows;' }] },
    { id: 'C7 时间线不按对象可见性过滤', expect: [CASE_EVENT_VIS], edits: [{ file: 'projects.js', from: 'if (await visibleTimelineEvent(event)) visibleRows.push(event);', to: 'visibleRows.push(event);' }] },
    { id: 'C7 时间线丢弃已撤销授权历史', expect: [CASE_EVENT_VIS], edits: [{ file: 'projects.js', from: 'new Set(detail.delegations.map((d) => d.id))', to: "new Set(detail.delegations.filter((d) => d.status !== 'revoked').map((d) => d.id))" }] },
    { id: 'C7 时间线过滤后只看第一批原始事件', expect: [CASE_EVENT_VIS], edits: [{ file: 'projects.js', from: 'if (visibleRows.length > limit || rows.length < 100) break;', to: 'if (true) break;' }] },
    { id: 'C7 时间线泄露任意事件载荷', expect: [CASE_EVENTS], edits: [{ file: 'projects.js', from: 'SELECT id, project_id, object_type, object_id, event_type, operator_id, operator_name, created_at', to: 'SELECT id, project_id, object_type, object_id, event_type, operator_id, operator_name, created_at, payload_json' }] },
    { id: 'C7 时间线放行非法游标', expect: [CASE_EVENTS], edits: [{ file: 'projects.js', from: "if (query.before !== undefined && before === null) throw invalid('分页游标不合法', 'before');", to: 'void before;' }] },
    { id: 'C7 时间线不限制条数', expect: [CASE_EVENTS], edits: [{ file: 'projects.js', from: "if (!limit || limit > 100) throw invalid('每页条数须为 1–100', 'limit');", to: 'void limit;' }] },
    { id: 'C7 时间线误配操作人名字', expect: [CASE_EVENTS], edits: [{ file: 'projects.js', from: 'SELECT id, project_id, object_type, object_id, event_type, operator_id, operator_name, created_at', to: "SELECT id, project_id, object_type, object_id, event_type, operator_id, '错误操作者' AS operator_name, created_at" }] },
    { id: 'C7 时间线误配事件时刻', expect: [CASE_EVENTS], edits: [{ file: 'projects.js', from: 'SELECT id, project_id, object_type, object_id, event_type, operator_id, operator_name, created_at', to: "SELECT id, project_id, object_type, object_id, event_type, operator_id, operator_name, '2000-01-01 00:00:00' AS created_at" }] },
    { id: 'C7 时间线误配关联对象', expect: [CASE_EVENTS], edits: [{ file: 'projects.js', from: 'SELECT id, project_id, object_type, object_id, event_type, operator_id, operator_name, created_at', to: 'SELECT id, project_id, object_type, object_id + 1000000 AS object_id, event_type, operator_id, operator_name, created_at' }] },
];
module.exports = { defineFrontendCases, FRONTEND_MUTATIONS };
