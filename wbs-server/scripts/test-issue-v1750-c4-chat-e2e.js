/**
 * v1.75.0 commit C — C4 需求拉群 create-chat 进程内 e2e（对齐 collab create-chat e2e 范式）
 *
 * 用法：本地 server 已启动（localhost:3000）后 node scripts/test-issue-v1750-c4-chat-e2e.js
 *
 * 验证前置校验路径（不碰钉钉真连——本地无钉钉配置，成功路径走 Commit D 真机）：
 *   T1 id 非法（abc）→ 400 INVALID_ID
 *   T2 需求不存在 → 404
 *   T3 viewer 调 → 403（requireNonViewer 中间件挡）
 *   T4 user 非本单关系人 → 403 NOT_ALLOWED
 *   T5 user 是本单 assigned_to → 过权限校验（无钉钉配置则 500 NO_DINGTALK_CONFIG，证明过了权限）
 *   T6 admin 任意单 → 过权限校验（同上）
 *   T7 已有群幂等（手动塞 dingtalk_open_conversation_id）→ 200 idempotent=true（不碰钉钉）
 *   T8 v1.75.0 readiness 已就绪（migration 跑过）→ 不返 ISSUE_V1750_SCHEMA_NOT_READY
 *   T9 codex 35 H-1 空白串口径（dingtalk_open_conversation_id='   ' 不应被当已建群）
 *  T10 codex 39 #1 + 40 #1/#2/#3 + 41 #1/#3 静态验 8 条代码结构（recheck/UPDATE 乐观锁/nullable-aware）
 *
 * 钉钉真连成功路径不在 e2e 内（每跑真建群且无 disband API），由生产真实业务验证。
 */
'use strict';

const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fx = require('./_test-fixture');

const BASE = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');

const ADMIN_ID = 1, VIEWER_ID = 2, DEV_ID = 8;  // 与 _test-fixture 对齐
const createdIssueIds = [];

function dbRun(sql, params) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH);
        db.run(sql, params, function (err) { db.close(); err ? reject(err) : resolve({ lastID: this.lastID, changes: this.changes }); });
    });
}

let pass = 0, fail = 0;
function assert(cond, label) { if (cond) { console.log(`  ✅ ${label}`); pass++; } else { console.log(`  ❌ ${label}`); fail++; } }

async function api(method, url, token, body) {
    const res = await fetch(BASE + url, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch (_) {}
    return { status: res.status, body: json };
}

// 造一个需求单（admin POST），返回 id
async function createIssue(adminToken, overrides = {}) {
    const res = await api('POST', '/api/issues', adminToken, {
        title: overrides.title || 'C4-e2e测试单',
        type: '数据应用需求', source: '业务方', requester_dept: '市场营销部',
        requester_name: '测试业务方', priority: 'P2',
        ...overrides,
    });
    if (res.status !== 200 || !res.body?.id) throw new Error('造单失败：' + JSON.stringify(res));
    createdIssueIds.push(res.body.id);
    return res.body.id;
}

async function main() {
    console.log('\n══════ v1.75.0 commit C — C4 create-chat 进程内 e2e（前置校验路径）══════');
    const adminToken = await fx.signAs(ADMIN_ID);
    const viewerToken = await fx.signAs(VIEWER_ID);
    const devToken = await fx.signAs(DEV_ID);

    try {
        // T1 id 非法
        const t1 = await api('POST', '/api/issues/abc/create-chat', adminToken, {});
        assert(t1.status === 400 && t1.body?.code === 'INVALID_ID', `T1 id 非法 → 400 INVALID_ID（实际 ${t1.status}/${t1.body?.code}）`);

        // T2 需求不存在
        const t2 = await api('POST', '/api/issues/99999999/create-chat', adminToken, {});
        assert(t2.status === 404, `T2 需求不存在 → 404（实际 ${t2.status}）`);

        // 造单（admin 创建，assigned_to=DEV_ID）
        const issueId = await createIssue(adminToken);
        await dbRun('UPDATE issues SET assigned_to = ?, assigned_to_name = ? WHERE id = ?', [DEV_ID, 'dev测试', issueId]);

        // T3 viewer 调 → 403（requireNonViewer）
        const t3 = await api('POST', `/api/issues/${issueId}/create-chat`, viewerToken, {});
        assert(t3.status === 403, `T3 viewer 调 → 403（实际 ${t3.status}）`);

        // T4 user 非本单关系人 → 403 NOT_ALLOWED（造一个 assigned_to/created_by 都不是 DEV 的单）
        const otherId = await createIssue(adminToken, { title: 'C4-e2e他人单' });
        await dbRun('UPDATE issues SET assigned_to = 99, created_by = 1 WHERE id = ?', [otherId]);
        const t4 = await api('POST', `/api/issues/${otherId}/create-chat`, devToken, {});
        assert(t4.status === 403 && t4.body?.code === 'NOT_ALLOWED', `T4 user 路人 → 403 NOT_ALLOWED（实际 ${t4.status}/${t4.body?.code}）`);

        // T5 user 是本单 assigned_to → 过权限（无钉钉配置则 500 NO_DINGTALK_CONFIG，证明过了权限校验）
        const t5 = await api('POST', `/api/issues/${issueId}/create-chat`, devToken, {});
        const t5PassedPerm = t5.body?.code === 'NO_DINGTALK_CONFIG' || t5.status === 502 || t5.status === 200;
        assert(t5PassedPerm && t5.body?.code !== 'NOT_ALLOWED', `T5 本单负责人过权限校验（实际 ${t5.status}/${t5.body?.code}，非 NOT_ALLOWED 即证明过权限）`);

        // T6 admin 任意单 → 过权限（同上）
        const t6 = await api('POST', `/api/issues/${otherId}/create-chat`, adminToken, {});
        assert(t6.body?.code !== 'NOT_ALLOWED' && t6.body?.code !== 'ISSUE_V1750_SCHEMA_NOT_READY', `T6 admin 任意单过权限（实际 ${t6.status}/${t6.body?.code}）`);

        // T7 已有群幂等（手动塞 open_conversation_id）→ 200 idempotent
        await dbRun('UPDATE issues SET dingtalk_open_conversation_id = ?, dingtalk_chat_id = ? WHERE id = ?', ['cidEXISTING', 'chatEXISTING', issueId]);
        const t7 = await api('POST', `/api/issues/${issueId}/create-chat`, adminToken, {});
        assert(t7.status === 200 && t7.body?.idempotent === true, `T7 已有群幂等 → 200 idempotent（实际 ${t7.status}/idempotent=${t7.body?.idempotent}）`);

        // T8 readiness 已就绪（migration 跑过）→ 不返 v1.75.0 NOT_READY
        assert(t6.body?.code !== 'ISSUE_V1750_SCHEMA_NOT_READY' && t6.body?.code !== 'ISSUE_V1750_SCHEMA_INITIALIZING', `T8 v1.75.0 readiness 已就绪（T6 未返 NOT_READY）`);

        // T9 codex 35 审 H-1：空字符串/空白 dingtalk_open_conversation_id 应被当"未建群"（trim 后空），
        //   进入建群流程；旧 bug 是判 truthy 当未建群但 UPDATE IS NULL 不匹配→孤儿群，修后空串口径与 UPDATE 一致
        const dirtyId = await createIssue(adminToken, { title: 'C4-e2e空串幂等单' });
        await dbRun('UPDATE issues SET assigned_to = ?, dingtalk_open_conversation_id = ? WHERE id = ?', [DEV_ID, '   ', dirtyId]);
        const t9 = await api('POST', `/api/issues/${dirtyId}/create-chat`, adminToken, {});
        // 空白串应被判"未建群"→ 进入建群流程（本地无钉钉配置则 500 NO_DINGTALK_CONFIG）→ 不应返 200 idempotent
        assert(!(t9.status === 200 && t9.body?.idempotent === true), `T9 空白串不应被当已建群（实际 ${t9.status}/idempotent=${t9.body?.idempotent}）`);

        // T10 codex 39 #1 + 40 #1/#2/#3 + 41 #1/#3 静态防误删（8 条独立断言）
        //   严格 e2e 需进程内 hook 在两次 SELECT 间注入改派（本项目无 mock 框架），
        //   改用独立 includes/regex 分别匹配关键代码结构（codex 40 #3 + 41 #3：哨兵局限——
        //   注释中关键词无法避免，故关键项用正则锚定 UPDATE SQL 模板上下文 + 代码结构特征）
        const fs = require('fs');
        const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
        assert(serverSrc.includes('const recheck = await dbGetAsync'),
            'T10a server.js 含建群前 recheck SELECT 调用（const recheck = await dbGetAsync）');
        assert(serverSrc.includes("code: 'ASSIGNEE_CHANGED_BEFORE_CHAT'"),
            'T10b server.js 含 ASSIGNEE_CHANGED_BEFORE_CHAT 错误码字面量');
        assert(serverSrc.includes("code: 'ISSUE_DELETED_BEFORE_CHAT'"),
            'T10c server.js 含 ISSUE_DELETED_BEFORE_CHAT 错误码字面量（codex 40 #2 recheck 返空兜底）');
        // codex 41 #3：T10d 改正则要求 AND assigned_to IS ? 出现在 UPDATE issues SQL 模板内
        //   旧版 includes('AND assigned_to IS ?') 会被代码注释里的同字符串命中（无法防 SQL 真删）；
        //   新正则锚定到 UPDATE issues + dingtalk_open_conversation_id 守卫之后，注释段不会同时含三段
        assert(/UPDATE issues[\s\S]{0,800}dingtalk_open_conversation_id[\s\S]{0,200}AND assigned_to IS \?/.test(serverSrc),
            'T10d server.js UPDATE issues 模板含 dingtalk_open_conversation_id 守卫 + AND assigned_to IS ? 乐观锁（codex 40 #1 治本，codex 41 #3 收紧）');
        // codex 41 #1：比较从 Number(recheck.assigned_to) !== Number(issue.assigned_to) 改为 nullable-aware
        //   recheckAssignedTo !== issueAssignedTo（两侧都已 nullable-aware 归一化）
        assert(serverSrc.includes('recheckAssignedTo !== issueAssignedTo'),
            'T10e server.js 含建群前 recheckAssignedTo !== issueAssignedTo（nullable-aware 比较口径与 UPDATE 乐观锁一致）');
        assert(serverSrc.includes('const initialAssignedTo'),
            'T10f server.js 含初始 assigned_to 快照变量供 UPDATE 乐观锁使用');
        // codex 41 #1：验 nullable-aware 快照（防 Number(null)=0 vs SQLite IS NULL 不匹配致孤儿群）
        assert(/initialAssignedTo\s*=\s*issue\.assigned_to\s*==\s*null\s*\?\s*null\s*:\s*Number/.test(serverSrc),
            'T10g server.js initialAssignedTo 用 nullable-aware 模式（issue.assigned_to == null ? null : Number(...)）');
        assert(/refreshedAssignedTo\s*=\s*refreshed[\s\S]{0,80}!=\s*null\s*\?\s*Number/.test(serverSrc),
            'T10h server.js refreshedAssignedTo 用 nullable-aware 模式（refreshed && refreshed.assigned_to != null ? Number ...）');

    } catch (e) {
        console.log('  ❌ e2e 异常：' + e.message);
        fail++;
    } finally {
        // 清理测试单（删 issue + 子表，对齐 DELETE endpoint 行为；直接删库）
        for (const id of createdIssueIds) {
            await dbRun('DELETE FROM issue_comments WHERE issue_id = ?', [id]).catch(() => {});
            await dbRun('DELETE FROM issue_status_history WHERE issue_id = ?', [id]).catch(() => {});
            await dbRun('DELETE FROM issue_attachments WHERE issue_id = ?', [id]).catch(() => {});
            await dbRun('DELETE FROM issues WHERE id = ?', [id]).catch(() => {});
        }
        console.log(`  （已清理 ${createdIssueIds.length} 条测试单）`);
    }

    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    console.log(fail === 0 ? '  🎉 v1.75.0 commit C C4 前置校验 e2e 全部通过\n' : '  🚫 存在失败项\n');
    process.exit(fail === 0 ? 0 : 1);
}

main();
