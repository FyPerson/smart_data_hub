/**
 * 需求跟踪 · 建单人编辑权限（E1）后端权限矩阵 e2e（2026-07-23）
 *
 * 用法：node scripts/verify-issue-creator-edit.js
 * 前置：入口 ready() 自起隔离实例，或核对批跑器给的 TEST_* 变量组（四个必须同时给）
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
const fx = require('./_test-fixture');

// [#106 S4c-B] 被测服务来自 test-env：fx.BASE 在 ready() 之前读会抛 FX_NOT_READY，故改为 ready() 之后在入口里赋值；
//   原 `process.env.TEST_BASE_URL || 3000` 与指向业务库 task_pool.db 的 DB_PATH 都已删除（库句柄在入口里用 fx.DB_PATH 打开）。
let BASE = null;

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
    // ready() 在 try 之外、入口函数的第一条有副作用的语句：失败直接落到末尾 .catch（非零退出）。库句柄也挪到 ready 之后才打开（原先在最前面就打开业务库）
    await fx.ready();   // 先于任何写库 / 网络请求：自起隔离实例（或核对 TEST_* 变量组）
    BASE = fx.BASE;
    console.log('=== 需求跟踪 建单人编辑权限（E1）权限矩阵 e2e ===\n');
    const db = await fx.openInstanceDb(fx.DB_PATH);   // [#106 S4c 收口] 带打开回调、不建空库；打开失败落到末尾 .catch（teardown 后非零退出）
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
    } catch (e) {
        console.log('  ✗ e2e 异常：' + (e && e.stack || e));   // 原先异常会变成未处理拒绝；现计失败，仍走下面的清理与收尾
        fail++;
    } finally {
        // 清理测试单据（评论/历史/附件级联行一并删）
        // [#106 S4c 收口] 每个单的四条 DELETE 放在同一个 try/catch：任一条失败该编号留在待清理列表里（不再 .catch(() => {}) 吞掉），剩余编号再试一轮；
        //   仍遗留的每个计 1 次失败（fail），不中断后续清理、关库与 teardown
        const pendingIds = created.filter(Boolean);
        for (let round = 0; round < 2 && pendingIds.length > 0; round++) {
            if (round > 0) await new Promise((r) => setTimeout(r, 200));   // [#106 S4c 送审前小修] 两轮之间等 200ms：防服务端事务外异步回写偶发 SQLITE_BUSY 被计失败
            for (const id of pendingIds.slice()) {
                try {
                    await dbRun(db, 'DELETE FROM issue_comments WHERE issue_id = ?', [id]);
                    await dbRun(db, 'DELETE FROM issue_status_history WHERE issue_id = ?', [id]);
                    await dbRun(db, 'DELETE FROM issue_attachments WHERE issue_id = ?', [id]);
                    await dbRun(db, 'DELETE FROM issues WHERE id = ?', [id]);
                    pendingIds.splice(pendingIds.indexOf(id), 1);
                } catch (e) { console.error(`清理需求 #${id} 失败（第 ${round + 1} 轮）：${e.message}`); }
            }
        }
        if (pendingIds.length > 0) { console.error(`测试单清理失败，遗留 id=${pendingIds.join(',')}`); fail += pendingIds.length; }
        await new Promise((resolve) => { db.close((cerr) => { if (cerr) { console.error(`关库失败：${cerr.message}`); fail++; } resolve(); }); });
        try { await fx.teardown(); } catch (e) { console.error(`teardown 失败：${e.message}`); fail++; }
    }
    console.log(`\n== Summary: ${pass} pass / ${fail} fail ==`);
    fx.finish(fail > 0 ? 1 : 0);   // teardown 已落定；只设退出码（见 lib/test-env.js finish），不在 finally 里调
})().catch(async (e) => {
    console.error('issue-creator-edit verify 启动失败：', e && e.stack || e);
    try { await fx.teardown(); } catch (_) { /* 已在报错路径 */ }
    process.exit(1);
});
