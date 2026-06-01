/**
 * v1.74.0 C4 — status 状态机 + history 事务冒烟 e2e
 *
 * 用法：本地 server 已启动后 node scripts/test-issue-c4-smoke.js
 * 复用 _test-fixture signAs（admin=1 / user dev1=19 / viewer=2）。
 * notify-requester-done / notify-read-status 依赖真实钉钉，本冒烟不测发送（留 C7 mock）；
 * 本脚本聚焦状态机转换 + 权限分流 + reason 必填 + closed_at + history 同事务落库。
 *
 * 用例：
 *   S1 admin 待处理→处理中（接手，无 reason）→ 200 + history 落行 from=待处理 to=处理中
 *   S2 admin 处理中→待验证 → 200 + closed_at 仍 NULL
 *   S3 admin 待验证→已关闭 缺 reason → 400 REASON_REQUIRED
 *   S4 admin 待验证→已关闭 带完成说明 → 200 + closed_at=now + history reason 落库
 *   S5 admin 已关闭→处理中（重开）→ 200 + closed_at 清空 + requester_notify_* 重置
 *   S6 非法转换 待处理→待验证 → 400 INVALID_TRANSITION
 *   S7 被指派人(dev1) 处理中→待验证 → 200（被指派人可做）
 *   S8 被指派人(dev1) 待验证→已关闭 → 403 ADMIN_ONLY_TRANSITION（终态仅 admin）
 *   S9 非被指派人(dev1 对别人的单) 待处理→处理中 → 403 NOT_ASSIGNEE
 *   S10 admin 待处理→已拒绝 带 reason → 200 + closed_at=now（已拒绝也落，用户拍板）
 *   S11 admin 待处理→已暂缓→待处理（激活）→ 暂缓 closed_at NULL + 激活后 closed_at NULL
 *   S12 待验证→处理中（退回）缺 reason → 400 REASON_REQUIRED（退回必填，靠 from 区分）
 *
 * ── C7 补漏（T3 状态机权限/非法矩阵 + T10 append-only，2026-06-01）──
 *   S16 viewer 调 status → 403（requireNonViewer 中间件挡 viewer）
 *   S17 非法转换 待处理→已关闭 → 400 INVALID_TRANSITION（待处理不能直接关闭）
 *   S18 非法转换 处理中→已拒绝 → 400（处理中只能→待验证/已暂缓）
 *   S19 非法转换 已拒绝→任意（终态空转换）→ 400
 *   S20 T10 append-only：两步流转后，旧 history 行逐字段不变（行只增不改写/不删）
 */
'use strict';
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fx = require('./_test-fixture');

const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
function dbGet(sql, params) {
    return new Promise((resolve, reject) => { const db = new sqlite3.Database(DB_PATH); db.get(sql, params, (e, r) => { db.close(); e ? reject(e) : resolve(r); }); });
}
function dbAll(sql, params) {
    return new Promise((resolve, reject) => { const db = new sqlite3.Database(DB_PATH); db.all(sql, params, (e, r) => { db.close(); e ? reject(e) : resolve(r); }); });
}
let pass = 0, fail = 0;
async function check(name, fn) { try { await fn(); console.log('  ✅ ' + name); pass++; } catch (e) { console.log('  ❌ ' + name + ' — ' + e.message); fail++; } }
function must(cond, msg) { if (!cond) throw new Error(msg); }

const VALID = { title: 'C4 状态机需求', type: '数据质量', requester_dept: '市场营销部', requester_name: '张三', description: 'x' };

async function createIssue(token, overrides) {
    const r = await fx.apiCall('POST', '/api/issues', token, { ...VALID, ...overrides });
    if (r.status !== 200) throw new Error('创建失败 ' + JSON.stringify(r.body));
    return r.body.id;
}
async function setStatus(token, id, status, reason) {
    const body = { status }; if (reason !== undefined) body.last_transition_reason = reason;
    return fx.apiCall('PUT', `/api/issues/${id}/status`, token, body);
}

const created = [];
async function main() {
    const adminToken = await fx.signAs(1);
    const dev1Token = await fx.signAs(19);
    const viewerToken = await fx.signAs(2);  // C7 补漏 S16：viewer 调 status 应被 requireNonViewer 挡
    const DEV1 = 19;
    console.log('\n══════ v1.74.0 C4 状态机冒烟 ══════');

    await check('S1 admin 待处理→处理中（接手，无 reason）→ 200 + history 落行', async () => {
        const id = await createIssue(adminToken); created.push(id);
        const r = await setStatus(adminToken, id, '处理中');
        must(r.status === 200, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
        const hist = await dbAll('SELECT * FROM issue_status_history WHERE issue_id=? ORDER BY id', [id]);
        must(hist.length === 2, `history 应 2 行（首行+本次），实际 ${hist.length}`);
        must(hist[1].from_status === '待处理' && hist[1].to_status === '处理中', 'history 第2行 待处理→处理中');
    });

    await check('S2 admin 处理中→待验证 → 200 + closed_at NULL', async () => {
        const id = created[0];
        const r = await setStatus(adminToken, id, '待验证');
        must(r.status === 200, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
        const issue = await dbGet('SELECT closed_at FROM issues WHERE id=?', [id]);
        must(!issue.closed_at, 'closed_at 应 NULL');
    });

    await check('S3 admin 待验证→已关闭 缺 reason → 400 REASON_REQUIRED', async () => {
        const r = await setStatus(adminToken, created[0], '已关闭');
        must(r.status === 400 && r.body.code === 'REASON_REQUIRED', `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    });

    await check('S4 admin 待验证→已关闭 带完成说明 → 200 + closed_at=now + history reason', async () => {
        const id = created[0];
        const r = await setStatus(adminToken, id, '已关闭', '交付了 PBI 看板，市场部已验收');
        must(r.status === 200, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
        const issue = await dbGet('SELECT closed_at, last_transition_reason FROM issues WHERE id=?', [id]);
        must(issue.closed_at, 'closed_at 应有值');
        must(issue.last_transition_reason.includes('PBI 看板'), 'last_transition_reason 落库');
        const hist = await dbAll("SELECT * FROM issue_status_history WHERE issue_id=? AND to_status='已关闭'", [id]);
        must(hist.length === 1 && hist[0].reason.includes('PBI 看板'), 'history 已关闭行 reason 落库');
    });

    await check('S5 admin 已关闭→处理中（重开）→ closed_at 清空 + requester_notify_* 重置', async () => {
        const id = created[0];
        // 先污染 requester_notify_status 验证重置
        const r = await setStatus(adminToken, id, '处理中', '发现遗漏需重新处理');
        must(r.status === 200, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
        const issue = await dbGet('SELECT closed_at, requester_notify_status FROM issues WHERE id=?', [id]);
        must(!issue.closed_at, '重开 closed_at 应清空');
        must(issue.requester_notify_status === 'not_sent', 'requester_notify_status 重置 not_sent');
    });

    await check('S6 非法转换 待处理→待验证 → 400 INVALID_TRANSITION', async () => {
        const id = await createIssue(adminToken); created.push(id);
        const r = await setStatus(adminToken, id, '待验证');
        must(r.status === 400 && r.body.code === 'INVALID_TRANSITION', `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    });

    await check('S7 被指派人 处理中→待验证 → 200', async () => {
        const id = await createIssue(adminToken, { assigned_to: DEV1 }); created.push(id);
        await setStatus(adminToken, id, '处理中');  // admin 先接手到处理中
        const r = await setStatus(dev1Token, id, '待验证');  // 被指派人完成
        must(r.status === 200, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    });

    await check('S8 被指派人 待验证→已关闭 → 403 ADMIN_ONLY_TRANSITION', async () => {
        const r = await setStatus(dev1Token, created[created.length - 1], '已关闭', 'x');
        must(r.status === 403 && r.body.code === 'ADMIN_ONLY_TRANSITION', `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    });

    await check('S9 非被指派人 待处理→处理中 → 403 NOT_ASSIGNEE', async () => {
        const id = await createIssue(adminToken); created.push(id);  // 未指派给 dev1
        const r = await setStatus(dev1Token, id, '处理中');
        must(r.status === 403 && r.body.code === 'NOT_ASSIGNEE', `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    });

    await check('S10 admin 待处理→已拒绝 带 reason → 200 + closed_at=now', async () => {
        const id = await createIssue(adminToken); created.push(id);
        const r = await setStatus(adminToken, id, '已拒绝', '不在数据治理范围');
        must(r.status === 200, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
        const issue = await dbGet('SELECT closed_at FROM issues WHERE id=?', [id]);
        must(issue.closed_at, '已拒绝 closed_at 应落（用户拍板对齐方案）');
    });

    await check('S11 admin 待处理→已暂缓（closed_at NULL）→待处理激活（closed_at NULL）', async () => {
        const id = await createIssue(adminToken); created.push(id);
        let r = await setStatus(adminToken, id, '已暂缓', '当前资源不足暂缓');
        must(r.status === 200, `暂缓 HTTP ${r.status} ${JSON.stringify(r.body)}`);
        let issue = await dbGet('SELECT closed_at FROM issues WHERE id=?', [id]);
        must(!issue.closed_at, '已暂缓 closed_at 应 NULL（暂缓非关闭）');
        r = await setStatus(adminToken, id, '待处理', '资源到位激活');
        must(r.status === 200, `激活 HTTP ${r.status} ${JSON.stringify(r.body)}`);
        issue = await dbGet('SELECT closed_at FROM issues WHERE id=?', [id]);
        must(!issue.closed_at, '激活后 closed_at NULL');
    });

    await check('S12 待验证→处理中（退回）缺 reason → 400 REASON_REQUIRED', async () => {
        const id = await createIssue(adminToken); created.push(id);
        await setStatus(adminToken, id, '处理中');
        await setStatus(adminToken, id, '待验证');
        const r = await setStatus(adminToken, id, '处理中');  // 退回，缺 reason
        must(r.status === 400 && r.body.code === 'REASON_REQUIRED', `退回应必填 reason，HTTP ${r.status} ${JSON.stringify(r.body)}`);
    });

    await check('S13 reason 非字符串 → 不崩 500（codex 12 M-2 类型归一）', async () => {
        const id = await createIssue(adminToken); created.push(id);
        // reason 传数字（非字符串）：归一为空 → 接手不必填 → 应 200，不应 500
        const r = await fx.apiCall('PUT', `/api/issues/${id}/status`, adminToken, { status: '处理中', last_transition_reason: 12345 });
        must(r.status === 200, `非字符串 reason 应归一不崩，HTTP ${r.status} ${JSON.stringify(r.body)}`);
    });

    await check('S14 reason 超长（非必填场景）→ 400 REASON_TOO_LONG（codex 12 M-2）', async () => {
        const id = await createIssue(adminToken); created.push(id);
        const r = await fx.apiCall('PUT', `/api/issues/${id}/status`, adminToken, { status: '处理中', last_transition_reason: 'x'.repeat(501) });
        must(r.status === 400 && r.body.code === 'REASON_TOO_LONG', `超长应拦，HTTP ${r.status} ${JSON.stringify(r.body)}`);
    });

    await check('S15 H-1 改派竞态守卫：被指派人在被改派后推进 → 403/409（codex 12 H-1）', async () => {
        // dev1 接手 → admin 改派给 dev2 → dev1 再推进应被守卫拦（assigned_to 已变）
        const id = await createIssue(adminToken, { assigned_to: DEV1 }); created.push(id);
        await setStatus(adminToken, id, '处理中');  // admin 接手到处理中
        // admin 改派给 dev2（DEV2=8）
        await fx.apiCall('PUT', `/api/issues/${id}/assign`, adminToken, { assigned_to: 8 });
        // dev1（已非负责人）尝试推进 处理中→待验证
        const r = await setStatus(dev1Token, id, '待验证');
        must(r.status === 403 || r.status === 409, `改派后原负责人应被拦，HTTP ${r.status} ${JSON.stringify(r.body)}`);
    });

    // ════════ C7 补漏：T3 权限/非法矩阵 + T10 append-only ════════
    await check('S16 viewer 调 status → 403（requireNonViewer 挡 viewer）', async () => {
        const id = await createIssue(adminToken); created.push(id);
        const r = await setStatus(viewerToken, id, '处理中');
        must(r.status === 403, `viewer 调 status 应 403，实际 ${r.status} ${JSON.stringify(r.body)}`);
    });

    await check('S17 非法转换 待处理→已关闭 → 400 INVALID_TRANSITION', async () => {
        const id = await createIssue(adminToken); created.push(id);
        const r = await setStatus(adminToken, id, '已关闭', '强行关闭');
        must(r.status === 400 && r.body.code === 'INVALID_TRANSITION', `待处理不能直接关闭，实际 ${r.status} ${JSON.stringify(r.body)}`);
    });

    await check('S18 非法转换 处理中→已拒绝 → 400 INVALID_TRANSITION', async () => {
        const id = await createIssue(adminToken); created.push(id);
        await setStatus(adminToken, id, '处理中');  // 先到处理中
        const r = await setStatus(adminToken, id, '已拒绝', '拒绝');
        must(r.status === 400 && r.body.code === 'INVALID_TRANSITION', `处理中不能→已拒绝，实际 ${r.status} ${JSON.stringify(r.body)}`);
    });

    await check('S19 非法转换 已拒绝→任意（终态空转换）→ 400', async () => {
        const id = await createIssue(adminToken); created.push(id);
        await setStatus(adminToken, id, '已拒绝', '不在范围');  // 待处理→已拒绝（合法）
        const r = await setStatus(adminToken, id, '处理中', '想重开');  // 已拒绝→处理中（终态不可激活）
        must(r.status === 400 && r.body.code === 'INVALID_TRANSITION', `已拒绝是终态应拒绝，实际 ${r.status} ${JSON.stringify(r.body)}`);
    });

    await check('S20 T10 append-only：两步流转后旧 history 行逐字段不变（只增不改）', async () => {
        const id = await createIssue(adminToken); created.push(id);
        // 第一步：待处理→处理中（接手）
        await setStatus(adminToken, id, '处理中');
        const after1 = await dbAll('SELECT id, from_status, to_status, reason, operator_id FROM issue_status_history WHERE issue_id=? ORDER BY id', [id]);
        must(after1.length === 2, `第一步后应 2 行（首行+接手），实际 ${after1.length}`);
        const snapshot = JSON.stringify(after1);  // 快照前两行
        // 第二步：处理中→待验证（完成）
        await setStatus(adminToken, id, '待验证');
        const after2 = await dbAll('SELECT id, from_status, to_status, reason, operator_id FROM issue_status_history WHERE issue_id=? ORDER BY id', [id]);
        must(after2.length === 3, `第二步后应 3 行（append 一行），实际 ${after2.length}`);
        // 关键断言：前两行逐字段未被改写（append-only，非 UPDATE/DELETE）
        must(JSON.stringify(after2.slice(0, 2)) === snapshot, 'append-only：旧 history 行不应被改写');
        must(after2[2].from_status === '处理中' && after2[2].to_status === '待验证', '新行 处理中→待验证');
    });

    // 清理
    for (const id of created) await fx.apiCall('DELETE', `/api/issues/${id}`, adminToken);

    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    console.log(fail === 0 ? '  🎉 C4 状态机冒烟全部通过\n' : '  🚫 存在失败项\n');
    process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error('冒烟脚本异常:', e); process.exit(1); });
