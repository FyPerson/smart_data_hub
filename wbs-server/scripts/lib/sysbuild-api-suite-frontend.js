'use strict';
const assert = require('assert');
const CASE_CAPS = 'C7 页面入口能力';
const CASE_EVENTS = 'C7 时间线元数据';
const CASE_EVENT_VIS = 'C7 时间线对象可见性';
const CASE_SCHEDULE_VIS = 'C7 S-1 改期知会详情可见性';
function defineFrontendCases(T) {
    const { test, U, api, sqlGet, sqlAll, setRole, mkProject, addMember, expectErr } = T;
    test(CASE_SCHEDULE_VIS + '：接收人、PM、管理员200；只读、其他成员、其他需求部门负责人404；详情无 objection 键、不写浏览记录、不泄露接收人', async () => {
        const call = async (uid, method, url, body, status = 200) => {
            const response = await api(uid, method, '/sysbuild' + url, body);
            assert.strictEqual(response.status, status, response.text); return response.body;
        };
        const post = (uid, url, body, status) => call(uid, 'POST', url, body || {}, status);
        const pid = (await post(U.pm, '/projects', {
            system_name: '改期异议读面', build_type: 'inhouse',
            demand_parties: [[U.own, U.del], [U.x1, U.x2]].map(([leader, representative]) => ({
                name: '需求方' + leader, leader_user_id: leader, representative_user_id: representative,
            })),
        }, 201)).project.id;
        await addMember(pid, U.m1);
        async function submitAndConfirm(type) {
            const pkg = (await post(U.pm, '/projects/' + pid + '/packages', { type }, 201)).package.id;
            const vid = (await post(U.pm, '/packages/' + pkg + '/versions', {}, 201)).version.id;
            // L2 fixture：此成功确认链先明确满足立项门；保留原改期知会可见性断言。
            if (type === 'initiation') await T.confirm.declareInitiationBasis(vid);
            else await T.confirm.prepareBasisVersion(vid);
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
        await submitAndConfirm('overall');
        const milestone = plan.nodes.find((n) => n.is_golive_milestone);
        await post(U.pm, '/nodes/' + milestone.id + '/schedule', { kind: 'plan', planned_start: '2026-11-02', planned_end: '2026-12-15', reason: '需求部门提出推迟上线时间', no_written_evidence: true, no_evidence_reason: '本次会议讨论形成改期安排尚无书面原始材料' }, 201);
        const notice = await sqlGet("SELECT n.id FROM sysbuild_notices n JOIN sysbuild_members m ON m.id = n.recipient_member_id WHERE n.project_id = ? AND n.kind = 'schedule_change' AND m.user_id = ?", [pid, U.own]);
        assert.ok(notice, '必须生成发给第一需求部门负责人的改期知会');
        // C6：知会异议随 S7 删除——不再提异议、详情没有 objection 键；读知会详情与读 /my/notices 列表都不写浏览记录（接替 stage8.js:246 与 entries.js:733 的两条保留断言：前后各取一次 sysbuild_views 行数，覆盖成功读与非成员 404 读）
        const viewCount = async () => (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_views', [])).n;
        const viewsBefore = await viewCount();
        for (const uid of [U.own, U.pm, U.admin]) {
            const detail = (await call(uid, 'GET', '/notices/' + notice.id)).notice;
            assert.ok(!('objection' in detail), '详情没有 objection 键（C6-RC54）');
            assert.strictEqual(detail.kind, 'schedule_change');
            assert.strictEqual((await api(uid, 'GET', '/sysbuild/my/notices')).status, 200, '读 /my/notices 列表');
        }
        const absent = await api(U.ro, 'GET', '/sysbuild/notices/999999999');
        for (const uid of [U.ro, U.m1, U.x1, U.out]) {
            const denied = await api(uid, 'GET', '/sysbuild/notices/' + notice.id);
            expectErr(denied, 404, 'SYSBUILD_NOT_FOUND');
            assert.deepStrictEqual(denied.body, absent.body, '其他可见者不能枚举知会详情');
        }
        assert.deepStrictEqual((await call(U.out, 'GET', '/my/notices')).items, [], '非成员读 /my/notices 为空（接替 entries.js:733）');
        assert.strictEqual(await viewCount(), viewsBefore, '读知会详情与 /my/notices 列表（含非成员 404 读）不写浏览记录');
        // 已移出项目的接收人读不到详情：上面的拒绝循环（U.ro / U.m1 / U.x1 / U.out）靠详情路由自带的「接收人 / PM / admin」校验就是 404，打不到项目可见性这道门；
        // 唯一的差异样本是已被移出的接收人（接收人校验的 SQL 不看 removed_at，只有项目可见性会拦）。移出成员不碰知会表，知会行仍在（#212 C6 CA5g M1993）
        const ownMemberId = (await sqlGet('SELECT id FROM sysbuild_members WHERE project_id = ? AND user_id = ? AND removed_at IS NULL', [pid, U.own])).id;
        await post(U.pm, '/members/' + ownMemberId + '/remove', { reason: '移出改期知会接收人' });
        assert.ok(await sqlGet('SELECT id FROM sysbuild_notices WHERE id = ?', [notice.id]), '前置：移出成员后知会行仍在');
        const gone = await api(U.own, 'GET', '/sysbuild/notices/' + notice.id);
        expectErr(gone, 404, 'SYSBUILD_NOT_FOUND');
        assert.deepStrictEqual(gone.body, absent.body, '已移出项目的接收人读不到知会详情（项目可见性）');
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
    test(CASE_EVENT_VIS + '：已移出人员不从时间线旁路可见；跨过隐藏记录后仍能读取早期项目；生效及撤销后的授权历史可读', async () => {
        const post = async (uid, url, body, status = 200) => {
            const response = await api(uid, 'POST', '/sysbuild' + url, body);
            assert.strictEqual(response.status, status, response.text);
            return response.body;
        };
        const pid = (await post(U.pm, '/projects', {
            system_name: '时间线权限对照', build_type: 'inhouse',
            demand_parties: [{ name: '授权方', leader_user_id: U.own, representative_user_id: U.del }],
        }, 201)).project.id;
        await post(U.pm, '/projects/' + pid + '/members', { user_id: U.m1 }, 201);
        const detail = async (uid) => (await api(uid, 'GET', '/sysbuild/projects/' + pid)).body;
        const timeline = async (uid) => {
            const result = await api(uid, 'GET', '/sysbuild/projects/' + pid + '/events?limit=100');
            assert.strictEqual(result.status, 200, result.text);
            return result.body.items;
        };
        const original = await detail(U.pm);
        const lastIds = [];
        for (let i = 0; i < 52; i += 1) {
            const added = (await post(U.pm, '/projects/' + pid + '/members', { user_id: U.out }, 201)).member;
            lastIds.push(added.id);
            await post(U.pm, '/members/' + added.id + '/remove', { reason: '成员已离开' });
        }
        assert.ok((await timeline(U.pm)).some((row) => row.object_type === 'member' && lastIds.includes(row.object_id)));
        for (const uid of [U.m1, U.ro]) {
            assert.ok(!(await detail(uid)).members.some((row) => lastIds.includes(row.id)));
            const visible = await timeline(uid);
            assert.ok(!visible.some((row) => row.object_type === 'member' && lastIds.includes(row.object_id)));
            assert.ok(visible.some((row) => row.event_type === 'project_created' && row.object_id === pid), '跨过隐藏事件后仍读到项目建立');
        }
        const id = original.parties[0].delegate.delegation_id;
        const visible = async () => (await timeline(U.m1)).filter((row) => row.object_type === 'delegation' && row.object_id === id);
        assert.deepStrictEqual((await visible()).map((row) => row.event_type), ['delegation_activated']);
        await post(U.pm, '/delegations/' + id + '/revoke', { reason: '人员调整，保留历史' });
        assert.ok((await detail(U.m1)).delegations.some((row) => row.id === id && row.status === 'revoked'));
        assert.deepStrictEqual((await visible()).map((row) => row.event_type), ['delegation_revoked', 'delegation_activated']);
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
  {"id":"C7 时间线多给一项","expect":["C7 时间线元数据"],"edits":[{"file":"projects.js","from":"visibleRows.slice(0, limit).map","to":"visibleRows.slice(0, limit + 1).map"}]},
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
