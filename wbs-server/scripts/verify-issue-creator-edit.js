/**
 * 需求跟踪 · 建单人编辑权限（E1）后端权限矩阵 e2e（2026-07-23）
 *
 * 用法：node scripts/verify-issue-creator-edit.js
 * 前置：本地 server 已启动（默认 localhost:3000，可用 TEST_BASE_URL 覆盖，如 http://localhost:3100）
 *
 * 覆盖（PUT /api/issues/:id 双通道权限）：
 *   1. 建单人(user)编辑自己的单（待处理）→ 200 + 系统评论留痕（is_system=1，含字段清单）
 *   2. 非建单人非 manager(user) 编辑他人单 → 403
 *   3. viewer 建单人编辑自己的单 → 200；priority 变更被丢弃（镜像 POST 强制 P2 口径）
 *   4. 建单人编辑已关闭的单 → 409 TERMINAL_STATE_LOCKED（终态锁定）；已拒绝同理
 *   5. manager(publisher) 编辑已关闭的单 → 200（既有"全状态可编辑"语义保持不收窄）；
 *      publisher 兼建单人编辑自己已关闭的单 → 200（manager 通道优先）
 *   6. WHERE 非终态+created_by 复校守卫存在性（静态断言——TOCTOU 三件套）
 *   7. L-1 补充（codex E1 审拍板）：被指派非建单人 403 / viewer 纯 priority 请求 400 /
 *      混合请求返回 ignored_fields=['priority'] / 编辑字段持久化 / 非字符串 payload 400 类型闸
 */
'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fx = require('./_test-fixture');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');

let pass = 0, fail = 0;
function expect(cond, msg) { if (cond) { console.log(`  ✓ ${msg}`); pass++; } else { console.log(`  ✗ ${msg}`); fail++; } }

const dbGet = (db, sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
const dbRun = (db, sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));

async function api(method, urlPath, token, body) {
    const res = await fetch(`${BASE}${urlPath}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
}

(async () => {
    console.log('=== 需求跟踪 建单人编辑权限（E1）权限矩阵 e2e ===\n');
    const db = new sqlite3.Database(DB_PATH);
    const created = [];
    try {
        const userToken = await fx.signAs(fx.CONTACT_ID);      // id=3 user（建单人）
        const otherToken = await fx.signAs(fx.DEV1_ID);        // id=19 user（非建单人）
        const viewerToken = await fx.signAs(fx.VIEWER_ID);     // id=2 viewer
        const pubToken = await fx.signAs(fx.PUBLISHER_ID);     // id=7 publisher（manager）

        const mkIssue = { type: '看板/报表需求', requester_dept: '信息技术部', requester_name: 'E1测试', source: '业务方' };

        // ---- 1. 建单人(user)编辑自己的单 + 留痕 ----
        console.log('1. 建单人编辑自己的单（非终态）');
        let r = await api('POST', '/api/issues', userToken, { ...mkIssue, title: 'E1-creator-own' });
        expect(r.status === 200 || r.status === 201, `user 建单成功（${r.status}）`);
        const idA = r.json.id; created.push(idA);
        r = await api('PUT', `/api/issues/${idA}`, userToken, { title: 'E1-creator-own-edited', description: '建单人改描述' });
        expect(r.status === 200, `建单人编辑自己的单 → 200（实际 ${r.status}：${r.json.error || 'ok'}）`);
        const persisted = await dbGet(db, 'SELECT title, description FROM issues WHERE id = ?', [idA]);
        expect(persisted.title === 'E1-creator-own-edited' && persisted.description === '建单人改描述', '编辑字段实际持久化（L-1）');
        const cmt = await dbGet(db, `SELECT content, is_system, user_id FROM issue_comments WHERE issue_id = ? ORDER BY id DESC LIMIT 1`, [idA]);
        expect(!!cmt && cmt.is_system === 1 && String(cmt.content).includes('编辑了需求录入信息') && String(cmt.content).includes('标题'), `系统评论留痕（is_system=1 + 字段清单，实际：${cmt && cmt.content}）`);
        expect(!!cmt && Number(cmt.user_id) === fx.CONTACT_ID, '留痕 user_id 记操作者');
        // M-2 类型闸：非字符串 payload → 400 稳定错误（不悬挂）
        r = await api('PUT', `/api/issues/${idA}`, userToken, { title: 12345 });
        expect(r.status === 400 && r.json.code === 'INVALID_FIELD_TYPE', `非字符串 title → 400 类型闸（实际 ${r.status}/${r.json.code}）`);
        // H-4（复审）：null 必填字段 / 数组 body / null 可空字段清空（放留痕断言之后——deadline:null 成功编辑会新增留痕行）
        r = await api('PUT', `/api/issues/${idA}`, userToken, { title: null });
        expect(r.status === 400, `title:null → 400（实际 ${r.status}）`);
        r = await api('PUT', `/api/issues/${idA}`, userToken, { requester_name: null });
        expect(r.status === 400, `requester_name:null → 400（实际 ${r.status}）`);
        r = await api('PUT', `/api/issues/${idA}`, userToken, [1, 2]);
        expect(r.status === 400, `数组 body → 400（实际 ${r.status}）`);
        r = await api('PUT', `/api/issues/${idA}`, userToken, undefined);   // R-1（三轮审）：不发 body（json 中间件 → {} → 无更新字段）
        expect(r.status === 400, `无请求体 → 400（实际 ${r.status}）`);
        r = await api('PUT', `/api/issues/${idA}`, userToken, { deadline: null });
        expect(r.status === 200, `deadline:null 清空（可空字段语义保留，实际 ${r.status}）`);
        const clearedA = await dbGet(db, 'SELECT deadline FROM issues WHERE id = ?', [idA]);
        expect(clearedA.deadline === null, 'deadline 已清空持久化');

        // ---- 2. 非建单人非 manager → 403 ----
        console.log('\n2. 非建单人(user)编辑他人单');
        r = await api('PUT', `/api/issues/${idA}`, otherToken, { title: 'hack' });
        expect(r.status === 403, `非建单人 user → 403（实际 ${r.status}）`);
        // L-1：被指派人（非建单人）也无编辑权（编辑权≠处理权，不随指派放开）
        await dbRun(db, 'UPDATE issues SET assigned_to = ?, assigned_to_name = ? WHERE id = ?', [fx.DEV1_ID, 'E1被指派', idA]);
        r = await api('PUT', `/api/issues/${idA}`, otherToken, { title: 'hack-as-assignee' });
        expect(r.status === 403, `被指派非建单人 → 403（实际 ${r.status}）`);

        // ---- 3. viewer 建单人：可编辑但 priority 丢弃 ----
        console.log('\n3. viewer 建单人编辑 + priority 丢弃');
        r = await api('POST', '/api/issues', viewerToken, { ...mkIssue, title: 'E1-viewer-own', priority: 'P0' });
        expect(r.status === 200 || r.status === 201, `viewer 建单成功（${r.status}）`);
        const idB = r.json.id; created.push(idB);
        const beforeB = await dbGet(db, 'SELECT priority FROM issues WHERE id = ?', [idB]);
        r = await api('PUT', `/api/issues/${idB}`, viewerToken, { description: 'viewer 改描述', priority: 'P0' });
        expect(r.status === 200, `viewer 建单人编辑自己的单 → 200（实际 ${r.status}：${r.json.error || 'ok'}）`);
        expect(Array.isArray(r.json.ignored_fields) && r.json.ignored_fields.includes('priority'), `混合请求返回 ignored_fields 含 priority（M-3，实际 ${JSON.stringify(r.json.ignored_fields)}）`);
        const afterB = await dbGet(db, 'SELECT priority, description FROM issues WHERE id = ?', [idB]);
        expect(afterB.description === 'viewer 改描述', 'viewer 描述变更生效');
        expect(afterB.priority === beforeB.priority && afterB.priority !== 'P0', `viewer priority 变更被丢弃（保持 ${afterB.priority}）`);
        // L-1：viewer 纯 priority 请求 → 400 无更新字段（丢弃后零字段）
        r = await api('PUT', `/api/issues/${idB}`, viewerToken, { priority: 'P0' });
        expect(r.status === 400, `viewer 纯 priority 请求 → 400 无更新字段（实际 ${r.status}）`);
        // viewer 编辑他人单 → 403
        r = await api('PUT', `/api/issues/${idA}`, viewerToken, { title: 'hack2' });
        expect(r.status === 403, `viewer 编辑他人单 → 403（实际 ${r.status}）`);

        // ---- 4. 终态锁定：建单人编辑已关闭 → 409 ----
        console.log('\n4. 终态锁定');
        await dbRun(db, `UPDATE issues SET status = '已关闭' WHERE id = ?`, [idA]);
        r = await api('PUT', `/api/issues/${idA}`, userToken, { title: 'after-close' });
        expect(r.status === 409 && r.json.code === 'TERMINAL_STATE_LOCKED', `建单人编辑已关闭单 → 409 TERMINAL_STATE_LOCKED（实际 ${r.status}/${r.json.code}）`);

        // ---- 4b. 已拒绝终态同锁 ----
        await dbRun(db, `UPDATE issues SET status = '已拒绝' WHERE id = ?`, [idB]);
        r = await api('PUT', `/api/issues/${idB}`, viewerToken, { description: 'after-reject' });
        expect(r.status === 409 && r.json.code === 'TERMINAL_STATE_LOCKED', `建单人编辑已拒绝单 → 409（实际 ${r.status}/${r.json.code}）`);

        // ---- 5. manager 既有语义保持：publisher 编辑已关闭 → 200 ----
        console.log('\n5. manager 全状态可编辑（不收窄）');
        r = await api('PUT', `/api/issues/${idA}`, pubToken, { title: 'E1-manager-edit-closed' });
        expect(r.status === 200, `publisher 编辑已关闭单 → 200（既有语义保持，实际 ${r.status}：${r.json.error || 'ok'}）`);
        // L-1：publisher 兼建单人编辑自己已关闭的单 → 200（manager 通道优先于 creator 终态锁）
        r = await api('POST', '/api/issues', pubToken, { ...mkIssue, title: 'E1-pub-own' });
        const idC = r.json.id; created.push(idC);
        await dbRun(db, `UPDATE issues SET status = '已关闭' WHERE id = ?`, [idC]);
        r = await api('PUT', `/api/issues/${idC}`, pubToken, { title: 'E1-pub-own-edit-closed' });
        expect(r.status === 200, `publisher 兼建单人编辑自己已关闭单 → 200（manager 通道优先，实际 ${r.status}）`);

        // ---- 6. TOCTOU 守卫静态存在性 ----
        console.log('\n6. WHERE 非终态+created_by 守卫（三件套）');
        const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
        expect(src.includes(`AND created_by = ? AND status NOT IN ('已关闭', '已拒绝')`), '建单人通道 UPDATE 带非终态+created_by 复校守卫（静态断言）');
    } finally {
        // 清理测试单据（评论/历史/附件级联行一并删）
        for (const id of created.filter(Boolean)) {
            await dbRun(db, 'DELETE FROM issue_comments WHERE issue_id = ?', [id]).catch(() => {});
            await dbRun(db, 'DELETE FROM issue_status_history WHERE issue_id = ?', [id]).catch(() => {});
            await dbRun(db, 'DELETE FROM issue_attachments WHERE issue_id = ?', [id]).catch(() => {});
            await dbRun(db, 'DELETE FROM issues WHERE id = ?', [id]).catch(() => {});
        }
        db.close();
    }
    console.log(`\n== Summary: ${pass} pass / ${fail} fail ==`);
    process.exit(fail > 0 ? 1 : 0);
})();
