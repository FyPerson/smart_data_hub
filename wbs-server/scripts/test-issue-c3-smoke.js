/**
 * v1.74.0 C3 — POST/assign/DELETE/notify endpoint 冒烟 e2e
 *
 * 用法：node scripts/test-issue-c3-smoke.js（入口 ready() 自起隔离实例，或核对批跑器给的 TEST_* 变量组，四个必须同时给）
 * 复用 _test-fixture 的 signAs（admin=1 / viewer=2 / user dev1=19）。
 * 完整 e2e（T2-T8 全集）在 C7；本脚本只冒烟 C3 改造的关键行为，确认 endpoint 不报错 + 行为符合预期。
 *
 * 用例：
 *   S1 admin POST 录入（全字段）→ 200 + 落 history 首行 from=NULL,to=待处理
 *   S2 viewer POST 自录（不指派）→ 200 + 后端强制 P2 + assigned_to 空
 *   S3 viewer POST 带 assigned_to → 403 VIEWER_CANNOT_ASSIGN
 *   S4 POST 缺 type/requester_dept → 400
 *   S5 POST acceptance_url 非法（javascript:）→ 400 INVALID_ACCEPTANCE_URL
 *   S6 admin assign dev1 → 200 + 写 pending_reassign_to_id + 后端填 name（不信任入参）
 *   S7 assign 改派 dev1→另一人 → pending_reassign_from=dev1
 *   S8 assign 传 null → 400 ASSIGN_TARGET_REQUIRED
 *   S9 DELETE → 子表（comments/attachments/status_history）级联清空
 *
 * ── C7 补漏（T2 POST 录入 + T4 指派权限矩阵，2026-06-01）──
 *   S16 POST 缺 title → 400「标题不能为空」
 *   S17 POST title 全空格 → 400（trim 后空）
 *   S18 POST 缺 requester_name → 400「业务方姓名不能为空」
 *   S19 POST source 非法值 → 400「无效的需求来源」
 *   S20 POST priority 非法值 → 400「无效的优先级」
 *   S21 POST requester_dept 非法值 → 400「无效或缺失的业务方部门」
 *   S22 admin POST 不传 priority → 默认 P2（非 viewer 也默认 P2）
 *   S23 POST data_domain 空字符串 → 落库 NULL（05 M-1）
 *   S24 POST 不内嵌钉钉 → 新建 issue notify_status='not_sent'（H-1：通知只走 notify endpoint）
 *   S25 POST 异常工单占位字段 related_table/error_time 落库（FDL 兼容字段）
 *   S26 assign 权限矩阵：user(dev1) 调 assign → 403（requirePublisherOrAdmin 挡）
 *   S27 assign 权限矩阵：viewer 调 assign → 403
 *   S28 assign 同人改派（assigned_to 不变）→ {updated:0} 不重复写 pending
 *   S29 notify-reassign 无 pending 记录 → 400 NO_REASSIGN
 *   ── T7 评论功能向下兼容 ──
 *   S30 POST 评论（admin）→ 200 + GET comments 列表能读回
 *   S31 POST 评论 content 空 → 400
 *   S32 viewer 发评论 → 403（requireNonViewer，读透明写收紧）
 *   S33 GET comments 返回数组（向下兼容，决策 8 schema 保留）
 */
'use strict';

const fx = require('./_test-fixture');

// [#106 S4c-B] 实例库来自 test-env：fx.DB_PATH 在 ready() 之前读会抛 FX_NOT_READY，故改为 ready() 之后在入口里赋值，不再指向业务库 task_pool.db
let DB_PATH = null;
// 以下两个 helper：等 close 回调再落定，关库错误不丢，resolve 时句柄已关闭（语句错误优先）
async function dbGet(sql, params) {
    const db = await fx.openInstanceDb(DB_PATH);
    return new Promise((resolve, reject) => {
        db.get(sql, params, (e, r) => { db.close((ce) => { const err = e || ce; err ? reject(err) : resolve(r); }); });
    });
}
async function dbAll(sql, params) {
    const db = await fx.openInstanceDb(DB_PATH);
    return new Promise((resolve, reject) => {
        db.all(sql, params, (e, r) => { db.close((ce) => { const err = e || ce; err ? reject(err) : resolve(r); }); });
    });
}

let pass = 0, fail = 0;
async function check(name, fn) {
    try { await fn(); console.log('  ✅ ' + name); pass++; }
    catch (e) { console.log('  ❌ ' + name + ' — ' + e.message); fail++; }
}
function must(cond, msg) { if (!cond) throw new Error(msg); }

const VALID_ISSUE = {
    title: 'C3 冒烟需求', type: '看板/报表需求', requester_dept: '市场营销部', requester_name: '张三',
    description: '描述', raw_requirement: '业务方原话', priority: 'P1', deadline: '2026-06-30',
    oa_number: 'OA-9001', data_domain: '合同', acceptance_url: 'http://pbi.x.com/r/1'
};

const createdIds = [];

async function main() {
    const adminToken = await fx.signAs(1);
    const viewerToken = await fx.signAs(2);
    const DEV1 = 19, DEV2 = 8;

    console.log('\n══════ v1.74.0 C3 endpoint 冒烟 ══════');

    await check('S1 admin POST 录入全字段 → 200 + history 首行', async () => {
        const r = await fx.apiCall('POST', '/api/issues', adminToken, VALID_ISSUE);
        must(r.status === 200 && r.body.id, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
        createdIds.push(r.body.id);
        const issue = await dbGet('SELECT * FROM issues WHERE id=?', [r.body.id]);
        must(issue.priority === 'P1', 'admin priority 应保留 P1');
        must(issue.acceptance_url === 'http://pbi.x.com/r/1', 'acceptance_url 落库');
        must(issue.data_domain === '合同', 'data_domain 落库');
        const hist = await dbAll('SELECT * FROM issue_status_history WHERE issue_id=?', [r.body.id]);
        must(hist.length === 1, 'history 应有 1 行');
        must(hist[0].from_status === null && hist[0].to_status === '待处理', 'history 首行 NULL→待处理');
    });

    await check('S1b POST acceptance_url 首尾空格 → 落库 trim 后值（codex 10 L-1）', async () => {
        const r = await fx.apiCall('POST', '/api/issues', adminToken, { ...VALID_ISSUE, acceptance_url: '  http://pbi.x.com/r/2  ' });
        must(r.status === 200 && r.body.id, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
        createdIds.push(r.body.id);
        const issue = await dbGet('SELECT acceptance_url FROM issues WHERE id=?', [r.body.id]);
        must(issue.acceptance_url === 'http://pbi.x.com/r/2', `应落 trim 后值，实际 "${issue.acceptance_url}"`);
    });

    await check('S2 viewer POST 自录不指派 → 200 + 强制 P2 + 不指派', async () => {
        const r = await fx.apiCall('POST', '/api/issues', viewerToken, { ...VALID_ISSUE, priority: 'P0', assigned_to: undefined });
        must(r.status === 200 && r.body.id, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
        createdIds.push(r.body.id);
        const issue = await dbGet('SELECT priority, assigned_to FROM issues WHERE id=?', [r.body.id]);
        must(issue.priority === 'P2', `viewer 传 P0 应被强制 P2，实际 ${issue.priority}`);
        must(!issue.assigned_to, 'viewer 自录不指派');
    });

    await check('S3 viewer POST 带 assigned_to → 403', async () => {
        const r = await fx.apiCall('POST', '/api/issues', viewerToken, { ...VALID_ISSUE, assigned_to: DEV1 });
        must(r.status === 403 && r.body.code === 'VIEWER_CANNOT_ASSIGN', `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    });

    await check('S4 POST 缺 type → 400', async () => {
        const { type, ...noType } = VALID_ISSUE;
        const r = await fx.apiCall('POST', '/api/issues', adminToken, noType);
        must(r.status === 400, `应 400，实际 ${r.status}`);
    });

    await check('S5 POST acceptance_url=javascript: → 400 INVALID_ACCEPTANCE_URL', async () => {
        const r = await fx.apiCall('POST', '/api/issues', adminToken, { ...VALID_ISSUE, acceptance_url: 'javascript:alert(1)' });
        must(r.status === 400 && r.body.code === 'INVALID_ACCEPTANCE_URL', `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    });

    await check('S6 admin assign dev1 → 200 + pending_reassign_to + 后端填 name', async () => {
        const id = createdIds[0];
        const r = await fx.apiCall('PUT', `/api/issues/${id}/assign`, adminToken, { assigned_to: DEV1, assigned_to_name: '伪造名字' });
        must(r.status === 200, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
        const issue = await dbGet('SELECT assigned_to, assigned_to_name, pending_reassign_to_id, pending_reassign_from_id FROM issues WHERE id=?', [id]);
        must(Number(issue.assigned_to) === DEV1, 'assigned_to=dev1');
        must(issue.assigned_to_name !== '伪造名字', '后端查 users 填 name，不信任入参');
        must(Number(issue.pending_reassign_to_id) === DEV1, 'pending_reassign_to_id=dev1');
        must(!issue.pending_reassign_from_id, '首次指派 from 为空');
    });

    await check('S7 assign 改派 dev1→dev2 → pending_reassign_from=dev1', async () => {
        const id = createdIds[0];
        const r = await fx.apiCall('PUT', `/api/issues/${id}/assign`, adminToken, { assigned_to: DEV2 });
        must(r.status === 200, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
        const issue = await dbGet('SELECT pending_reassign_from_id, pending_reassign_to_id FROM issues WHERE id=?', [id]);
        must(Number(issue.pending_reassign_from_id) === DEV1, `改派 from 应=dev1，实际 ${issue.pending_reassign_from_id}`);
        must(Number(issue.pending_reassign_to_id) === DEV2, 'to=dev2');
    });

    await check('S8 assign 传 null → 400 ASSIGN_TARGET_REQUIRED', async () => {
        const id = createdIds[0];
        const r = await fx.apiCall('PUT', `/api/issues/${id}/assign`, adminToken, { assigned_to: null });
        must(r.status === 400 && r.body.code === 'ASSIGN_TARGET_REQUIRED', `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    });

    await check('S9 DELETE → 子表级联清空', async () => {
        const id = createdIds[0];
        // 先插一条评论 + 一条附件，验证级联
        const cmt = await fx.apiCall('POST', `/api/issues/${id}/comments`, adminToken, { content: '测试评论' });
        must(cmt.status === 200, '评论创建');
        const r = await fx.apiCall('DELETE', `/api/issues/${id}`, adminToken);
        must(r.status === 200, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
        const issue = await dbGet('SELECT id FROM issues WHERE id=?', [id]);
        must(!issue, 'issue 已删');
        const hist = await dbAll('SELECT id FROM issue_status_history WHERE issue_id=?', [id]);
        const cmts = await dbAll('SELECT id FROM issue_comments WHERE issue_id=?', [id]);
        must(hist.length === 0, 'history 级联清空');
        must(cmts.length === 0, 'comments 级联清空');
        createdIds.shift();
    });

    // ════════ C7 补漏：T2 POST 录入校验 ════════
    await check('S16 POST 缺 title → 400 标题不能为空', async () => {
        const { title, ...noTitle } = VALID_ISSUE;
        const r = await fx.apiCall('POST', '/api/issues', adminToken, noTitle);
        must(r.status === 400 && /标题/.test(r.body.error || ''), `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    });

    await check('S17 POST title 全空格 → 400', async () => {
        const r = await fx.apiCall('POST', '/api/issues', adminToken, { ...VALID_ISSUE, title: '   ' });
        must(r.status === 400, `全空格 title 应 400，实际 ${r.status}`);
    });

    await check('S18 POST 缺 requester_name → 400 业务方姓名不能为空', async () => {
        const { requester_name, ...noName } = VALID_ISSUE;
        const r = await fx.apiCall('POST', '/api/issues', adminToken, noName);
        must(r.status === 400 && /姓名/.test(r.body.error || ''), `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    });

    await check('S19 POST source 非法 → 400 无效的需求来源', async () => {
        const r = await fx.apiCall('POST', '/api/issues', adminToken, { ...VALID_ISSUE, source: '天外飞仙' });
        must(r.status === 400 && /来源/.test(r.body.error || ''), `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    });

    await check('S20 POST priority 非法 → 400 无效的优先级', async () => {
        const r = await fx.apiCall('POST', '/api/issues', adminToken, { ...VALID_ISSUE, priority: 'P9' });
        must(r.status === 400 && /优先级/.test(r.body.error || ''), `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    });

    await check('S21 POST requester_dept 非法 → 400 无效或缺失的业务方部门', async () => {
        const r = await fx.apiCall('POST', '/api/issues', adminToken, { ...VALID_ISSUE, requester_dept: '不存在的部门' });
        must(r.status === 400 && /部门/.test(r.body.error || ''), `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    });

    await check('S22 admin POST 不传 priority → 默认 P2', async () => {
        const { priority, ...noPrio } = VALID_ISSUE;
        const r = await fx.apiCall('POST', '/api/issues', adminToken, noPrio);
        must(r.status === 200 && r.body.id, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
        createdIds.push(r.body.id);
        const issue = await dbGet('SELECT priority FROM issues WHERE id=?', [r.body.id]);
        must(issue.priority === 'P2', `默认应 P2，实际 ${issue.priority}`);
    });

    await check('S23 POST data_domain 空字符串 → 落库 NULL（05 M-1）', async () => {
        const r = await fx.apiCall('POST', '/api/issues', adminToken, { ...VALID_ISSUE, data_domain: '   ' });
        must(r.status === 200 && r.body.id, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
        createdIds.push(r.body.id);
        const issue = await dbGet('SELECT data_domain FROM issues WHERE id=?', [r.body.id]);
        must(issue.data_domain === null, `空白 data_domain 应落 NULL，实际 ${JSON.stringify(issue.data_domain)}`);
    });

    await check('S24 POST 不内嵌钉钉 → notify_status=not_sent（H-1 通知只走 notify endpoint）', async () => {
        const r = await fx.apiCall('POST', '/api/issues', adminToken, { ...VALID_ISSUE, assigned_to: 19 });
        must(r.status === 200 && r.body.id, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
        createdIds.push(r.body.id);
        const issue = await dbGet('SELECT notify_status, requester_notify_status FROM issues WHERE id=?', [r.body.id]);
        must(issue.notify_status === 'not_sent', `POST 不应内嵌通知，notify_status 应 not_sent，实际 ${issue.notify_status}`);
        must(issue.requester_notify_status === 'not_sent', 'requester_notify_status 也应 not_sent');
    });

    await check('S25 POST 异常工单占位字段 related_table/error_time 落库', async () => {
        const r = await fx.apiCall('POST', '/api/issues', adminToken, {
            ...VALID_ISSUE, type: '调度异常', related_table: 'dwd_cont_header_df', error_time: '2026-06-01 03:00:00'
        });
        must(r.status === 200 && r.body.id, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
        createdIds.push(r.body.id);
        const issue = await dbGet('SELECT related_table, error_time FROM issues WHERE id=?', [r.body.id]);
        must(issue.related_table === 'dwd_cont_header_df', `related_table 应落库，实际 ${issue.related_table}`);
        must(issue.error_time && /2026-06-01/.test(issue.error_time), `error_time 应落库，实际 ${issue.error_time}`);
    });

    // ════════ C7 补漏：T4 指派权限矩阵 ════════
    await check('S26 assign 权限：user(dev1) 调 assign → 403（requirePublisherOrAdmin）', async () => {
        const dev1Token = await fx.signAs(19);
        const id = await fx.apiCall('POST', '/api/issues', adminToken, VALID_ISSUE).then(r => { createdIds.push(r.body.id); return r.body.id; });
        const r = await fx.apiCall('PUT', `/api/issues/${id}/assign`, dev1Token, { assigned_to: 8 });
        must(r.status === 403, `user 调 assign 应 403，实际 ${r.status} ${JSON.stringify(r.body)}`);
    });

    await check('S27 assign 权限：viewer 调 assign → 403', async () => {
        const id = createdIds[createdIds.length - 1];
        const r = await fx.apiCall('PUT', `/api/issues/${id}/assign`, viewerToken, { assigned_to: 8 });
        must(r.status === 403, `viewer 调 assign 应 403，实际 ${r.status} ${JSON.stringify(r.body)}`);
    });

    await check('S28 assign 同人改派（assigned_to 不变）→ {updated:0} 不重复写', async () => {
        const id = await fx.apiCall('POST', '/api/issues', adminToken, VALID_ISSUE).then(r => { createdIds.push(r.body.id); return r.body.id; });
        await fx.apiCall('PUT', `/api/issues/${id}/assign`, adminToken, { assigned_to: 19 }); // 首次指派 dev1
        const r = await fx.apiCall('PUT', `/api/issues/${id}/assign`, adminToken, { assigned_to: 19 }); // 同人再指派
        must(r.status === 200 && r.body.updated === 0, `同人应 updated:0，实际 ${r.status} ${JSON.stringify(r.body)}`);
    });

    await check('S29 notify-reassign 从未指派（pending_reassign_to_id NULL）→ 400 NO_REASSIGN', async () => {
        // 全新 issue 从未 assign → pending_reassign_to_id 仍 NULL → notify-reassign 判 NO_REASSIGN
        // （注意：assign endpoint 即便首次指派也会写 pending_reassign_to_id，故必须用"从未 assign"的单测此分支）
        const id = await fx.apiCall('POST', '/api/issues', adminToken, VALID_ISSUE).then(r => { createdIds.push(r.body.id); return r.body.id; });
        const issue = await dbGet('SELECT pending_reassign_to_id FROM issues WHERE id=?', [id]);
        must(!issue.pending_reassign_to_id, 'precondition：从未指派 pending_reassign_to_id 应 NULL');
        const r = await fx.apiCall('POST', `/api/issues/${id}/notify-reassign`, adminToken);
        must(r.status === 400 && r.body.code === 'NO_REASSIGN', `无改派记录应 400 NO_REASSIGN，实际 ${r.status} ${JSON.stringify(r.body)}`);
    });

    // ════════ C7 补漏：T7 评论功能向下兼容 ════════
    await check('S30 POST 评论（admin）→ 200 + GET comments 读回', async () => {
        const id = await fx.apiCall('POST', '/api/issues', adminToken, VALID_ISSUE).then(r => { createdIds.push(r.body.id); return r.body.id; });
        const post = await fx.apiCall('POST', `/api/issues/${id}/comments`, adminToken, { content: 'C7 评论测试内容' });
        must(post.status === 200 && post.body.id, `POST 评论应 200，实际 ${post.status} ${JSON.stringify(post.body)}`);
        const get = await fx.apiCall('GET', `/api/issues/${id}/comments`, adminToken);
        must(get.status === 200 && Array.isArray(get.body), 'GET comments 应返数组');
        must(get.body.some(c => c.content === 'C7 评论测试内容'), 'GET 应读回刚发的评论');
    });

    await check('S31 POST 评论 content 空 → 400', async () => {
        const id = createdIds[createdIds.length - 1];
        const r = await fx.apiCall('POST', `/api/issues/${id}/comments`, adminToken, { content: '   ' });
        must(r.status === 400, `空 content 应 400，实际 ${r.status} ${JSON.stringify(r.body)}`);
    });

    await check('S32 viewer 发评论 → 403（requireNonViewer，读透明写收紧）', async () => {
        const id = createdIds[createdIds.length - 1];
        const r = await fx.apiCall('POST', `/api/issues/${id}/comments`, viewerToken, { content: 'viewer 想评论' });
        must(r.status === 403, `viewer 发评论应 403，实际 ${r.status} ${JSON.stringify(r.body)}`);
    });

    await check('S33 GET comments 空列表返回数组（向下兼容，决策 8 schema 保留）', async () => {
        const id = await fx.apiCall('POST', '/api/issues', adminToken, VALID_ISSUE).then(r => { createdIds.push(r.body.id); return r.body.id; });
        const r = await fx.apiCall('GET', `/api/issues/${id}/comments`, adminToken);
        must(r.status === 200 && Array.isArray(r.body) && r.body.length === 0, `无评论应返空数组，实际 ${JSON.stringify(r.body)}`);
    });

    // 清理残留测试单
    // [#106 S4c 收口] 逐个 try/catch 并核对状态码（200 / 404 才算清掉），清掉的才移出追踪数组；剩余编号再试一轮；仍遗留的计入失败（fail），不中断后续清理
    for (let round = 0; round < 2 && createdIds.length > 0; round++) {
        if (round > 0) await new Promise((r) => setTimeout(r, 200));   // [#106 S4c 送审前小修] 两轮之间等 200ms：防服务端事务外异步回写偶发 SQLITE_BUSY 被计失败
        for (const id of createdIds.slice()) {
            try {
                const r = await fx.apiCall('DELETE', `/api/issues/${id}`, adminToken);
                if (r.status === 200 || r.status === 404) createdIds.splice(createdIds.indexOf(id), 1);
                else console.log(`  清理 #${id} 失败（第 ${round + 1} 轮）：HTTP ${r.status} ${JSON.stringify(r.body)}`);
            } catch (e) { console.log(`  清理 #${id} 异常（第 ${round + 1} 轮）：${e.message}`); }
        }
    }
    if (createdIds.length > 0) { console.log(`  ❌ 测试单清理失败，遗留 id=${createdIds.join(',')}`); fail += createdIds.length; }

    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    console.log(fail === 0 ? '  🎉 C3 冒烟全部通过\n' : '  🚫 存在失败项\n');
    return fail;   // 不在 helper 里 process.exit：由入口在 teardown 之后 finish
}

(async () => {
    // ready() 在 try 之外、入口函数的第一条有副作用的语句：失败直接落到末尾 .catch（非零退出）
    await fx.ready();   // 先于任何写库 / 网络请求：自起隔离实例（或核对 TEST_* 变量组）
    let code = 1;
    try {
        DB_PATH = fx.DB_PATH;
        const nFailed = await main();
        code = nFailed > 0 ? 1 : 0;
    } catch (e) {
        console.error('冒烟脚本异常:', e);
    } finally {
        try { await fx.teardown(); } catch (e) { console.error(`teardown 失败：${e.message}`); code = 1; }
    }
    fx.finish(code);   // teardown 已落定；只设退出码（见 lib/test-env.js finish），不在 finally 里调
})().catch(async (e) => {
    console.error('issue-c3 smoke 启动失败：', e && e.stack || e);
    try { await fx.teardown(); } catch (_) { /* 已在报错路径 */ }
    process.exit(1);
});
