/**
 * 数据开发 issue_lite · 建单人编辑权限（E2）权限矩阵 e2e（2026-07-23）
 *
 * 用法：node scripts/verify-issue-lite-creator-edit.js
 * 前置：入口 ready() 自起隔离实例，或核对批跑器给的 TEST_* 变量组（四个必须同时给）
 *
 * 覆盖（PUT /api/issue-lite/:id）：
 *   1. 建单人(user)编辑自己的单 → 200 + issue_lite_edit_logs 留痕 + 持久化 + 详情返回 can_edit/edit_logs
 *   2. 非建单人(user) → 403；viewer → 403（requireNonViewer 中间件）
 *   3. OA 三态：改真号生效 / 清空('')归一 datadev-{id} 占位 / 非法值 400
 *   4. 终态锁：已归档 409 / 已作废 409（admin 也不例外）
 *   5. admin 编辑他人非终态单 → 200
 *   6. 输入面：数组 body 400 / title:null 400 / description:null 清空 / 无更新字段 400
 *   7. WHERE 复校守卫静态断言（三件套）
 *   8. H-1 比对制（codex E2 审拍板）：单字段编辑留痕单标签 / 全同值 updated:0 无新留痕不刷 updated_at /
 *      datadev-999 归一本单占位 / number OA 400（M-3 只收 string）/ 历史部门单改标题可过（M-2）/
 *      已归档 can_edit=false 投影
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
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
}

(async () => {
    // ready() 在 try 之外、入口函数的第一条有副作用的语句：失败直接落到末尾 .catch（非零退出）。库句柄也挪到 ready 之后才打开（原先在最前面就打开业务库）
    await fx.ready();   // 先于任何写库 / 网络请求：自起隔离实例（或核对 TEST_* 变量组）
    BASE = fx.BASE;
    console.log('=== 数据开发 issue_lite 建单人编辑权限（E2）权限矩阵 e2e ===\n');
    const db = await fx.openInstanceDb(fx.DB_PATH);   // [#106 S4c 收口] 带打开回调、不建空库；打开失败落到末尾 .catch（teardown 后非零退出）
    const created = [];
    try {
        const userToken = await fx.signAs(fx.CONTACT_ID);      // id=3 user（建单人）
        const otherToken = await fx.signAs(fx.DEV1_ID);        // id=19 user（非建单人）
        const viewerToken = await fx.signAs(fx.VIEWER_ID);     // id=2 viewer
        const adminToken = await fx.signAs(fx.ADMIN_ID);       // id=1 admin

        // [#106 S4c-B] 原此处 `GET /api/issue-lite/config/depts` 是死调用：服务端没有这个路由（git grep "issue-lite/config" 全仓只命中本文件这一行），
        //   返回值 deptRes 也从未被使用，已删除。
        const dept = '信息技术部';   // 平台部门白名单恒含

        const mk = { title: 'E2-测试单', requester_name: 'E2业务方', requester_dept: dept, requester_phone: '13800000000' };

        // ---- 1. 建单人编辑自己的单 + 留痕 + 投影 ----
        console.log('1. 建单人编辑自己的单');
        let r = await api('POST', '/api/issue-lite', userToken, mk);
        expect(r.status === 200 && r.json.success, `user 建单成功（${r.status}）`);
        const idA = r.json.issue && r.json.issue.id; created.push(idA);
        r = await api('PUT', `/api/issue-lite/${idA}`, userToken, { title: 'E2-已编辑', description: '编辑后的补充说明' });
        expect(r.status === 200, `建单人编辑自己的单 → 200（实际 ${r.status}：${r.json.error || 'ok'}）`);
        const p1 = await dbGet(db, 'SELECT title, description FROM issue_lite WHERE id = ?', [idA]);
        expect(p1.title === 'E2-已编辑' && p1.description === '编辑后的补充说明', '编辑字段持久化');
        const log1 = await dbGet(db, 'SELECT editor_id, editor_name, changed_fields FROM issue_lite_edit_logs WHERE issue_lite_id = ? ORDER BY id DESC LIMIT 1', [idA]);
        expect(!!log1 && Number(log1.editor_id) === fx.CONTACT_ID && log1.changed_fields.includes('需求描述') && log1.changed_fields.includes('补充说明'), `edit_logs 留痕（实际：${log1 && log1.changed_fields}）`);
        r = await api('GET', `/api/issue-lite/${idA}`, userToken);
        expect(r.json.can_edit === true && Array.isArray(r.json.edit_logs) && r.json.edit_logs.length >= 1, '详情返回 can_edit=true + edit_logs');

        // ---- 2. 越权 ----
        console.log('\n2. 越权拒绝');
        r = await api('PUT', `/api/issue-lite/${idA}`, otherToken, { title: 'hack' });
        expect(r.status === 403, `非建单人 user → 403（实际 ${r.status}）`);
        r = await api('PUT', `/api/issue-lite/${idA}`, viewerToken, { title: 'hack' });
        expect(r.status === 403, `viewer → 403（requireNonViewer，实际 ${r.status}）`);

        // ---- 3. OA 三态 ----
        console.log('\n3. OA 号编辑三态');
        r = await api('PUT', `/api/issue-lite/${idA}`, userToken, { oa_number: '654321' });
        expect(r.status === 200, `改真 OA 号 → 200（实际 ${r.status}）`);
        let oaRow = await dbGet(db, 'SELECT oa_number FROM issue_lite WHERE id = ?', [idA]);
        expect(oaRow.oa_number === '654321', `真 OA 号生效（实际 ${oaRow.oa_number}）`);
        r = await api('PUT', `/api/issue-lite/${idA}`, userToken, { oa_number: '' });
        expect(r.status === 200, `清空 OA → 200（实际 ${r.status}）`);
        oaRow = await dbGet(db, 'SELECT oa_number FROM issue_lite WHERE id = ?', [idA]);
        expect(oaRow.oa_number === `datadev-${idA}`, `清空归一 datadev-{id} 占位（实际 ${oaRow.oa_number}）`);
        r = await api('PUT', `/api/issue-lite/${idA}`, userToken, { oa_number: '12a4' });
        expect(r.status === 400 && r.json.code === 'OA_NUMBER_INVALID', `非法 OA → 400（实际 ${r.status}/${r.json.code}）`);

        // ---- 4. 终态锁 ----
        console.log('\n4. 终态锁');
        await dbRun(db, `UPDATE issue_lite SET status = '已归档' WHERE id = ?`, [idA]);
        r = await api('PUT', `/api/issue-lite/${idA}`, userToken, { title: 'after-archive' });
        expect(r.status === 409 && r.json.code === 'TERMINAL_STATE_LOCKED', `已归档 → 409（实际 ${r.status}/${r.json.code}）`);
        r = await api('PUT', `/api/issue-lite/${idA}`, adminToken, { title: 'admin-after-archive' });
        expect(r.status === 409, `admin 编辑已归档 → 409（issue_lite 无 manager 例外，实际 ${r.status}）`);
        await dbRun(db, `UPDATE issue_lite SET status = '待处理', voided_at = datetime('now','localtime') WHERE id = ?`, [idA]);
        r = await api('PUT', `/api/issue-lite/${idA}`, userToken, { title: 'after-void' });
        expect(r.status === 409 && r.json.code === 'VOIDED_LOCKED', `已作废 → 409（实际 ${r.status}/${r.json.code}）`);
        await dbRun(db, `UPDATE issue_lite SET voided_at = NULL WHERE id = ?`, [idA]);

        // ---- 5. admin 编辑他人非终态单 ----
        console.log('\n5. admin 通道');
        r = await api('PUT', `/api/issue-lite/${idA}`, adminToken, { title: 'E2-admin-edited' });
        expect(r.status === 200, `admin 编辑他人非终态单 → 200（实际 ${r.status}）`);
        const log2 = await dbGet(db, 'SELECT editor_id FROM issue_lite_edit_logs WHERE issue_lite_id = ? ORDER BY id DESC LIMIT 1', [idA]);
        expect(!!log2 && Number(log2.editor_id) === fx.ADMIN_ID, 'admin 编辑同样留痕');

        // ---- 6. 输入面 ----
        console.log('\n6. 输入面防线');
        r = await api('PUT', `/api/issue-lite/${idA}`, userToken, [1]);
        expect(r.status === 400, `数组 body → 400（实际 ${r.status}）`);
        r = await api('PUT', `/api/issue-lite/${idA}`, userToken, { title: null });
        expect(r.status === 400, `title:null → 400（必填拒 null，实际 ${r.status}）`);
        r = await api('PUT', `/api/issue-lite/${idA}`, userToken, { description: null });
        expect(r.status === 200, `description:null 清空 → 200（实际 ${r.status}）`);
        const p6 = await dbGet(db, 'SELECT description FROM issue_lite WHERE id = ?', [idA]);
        expect(p6.description === null, 'description 已清空持久化');
        r = await api('PUT', `/api/issue-lite/${idA}`, userToken, {});
        expect(r.status === 400, `无更新字段 → 400（实际 ${r.status}）`);

        // ---- 8. H-1 比对制 ----
        console.log('\n8. 比对制留痕真实性（H-1/M-2/M-3）');
        // 单字段编辑 → 留痕仅一个标签
        r = await api('PUT', `/api/issue-lite/${idA}`, userToken, { title: 'E2-单字段', requester_name: 'E2业务方', requester_dept: dept, requester_phone: '13800000000' });
        expect(r.status === 200, `全字段提交但仅 title 变化 → 200（实际 ${r.status}）`);
        const lg1 = await dbGet(db, 'SELECT changed_fields FROM issue_lite_edit_logs WHERE issue_lite_id = ? ORDER BY id DESC LIMIT 1', [idA]);
        expect(lg1.changed_fields === '需求描述', `留痕仅记真变更字段（实际：${lg1.changed_fields}）`);
        // 全同值 → updated:0 + 无新留痕 + updated_at 不变
        const cntBefore = await dbGet(db, 'SELECT COUNT(*) n FROM issue_lite_edit_logs WHERE issue_lite_id = ?', [idA]);
        const upBefore = await dbGet(db, 'SELECT updated_at FROM issue_lite WHERE id = ?', [idA]);
        r = await api('PUT', `/api/issue-lite/${idA}`, userToken, { title: 'E2-单字段', requester_name: 'E2业务方' });
        expect(r.status === 200 && r.json.updated === 0, `全同值 → 200 updated:0（实际 ${r.status}/${r.json.updated}）`);
        const cntAfter = await dbGet(db, 'SELECT COUNT(*) n FROM issue_lite_edit_logs WHERE issue_lite_id = ?', [idA]);
        const upAfter = await dbGet(db, 'SELECT updated_at FROM issue_lite WHERE id = ?', [idA]);
        expect(cntAfter.n === cntBefore.n && upAfter.updated_at === upBefore.updated_at, '全同值不写留痕、不刷 updated_at');
        // datadev-999 归一本单占位（先设真号再提交异单占位）
        await dbRun(db, `UPDATE issue_lite SET oa_number = '111222' WHERE id = ?`, [idA]);
        r = await api('PUT', `/api/issue-lite/${idA}`, userToken, { oa_number: 'datadev-999' });
        expect(r.status === 200, `提交异单占位号 → 200（实际 ${r.status}）`);
        const oa8 = await dbGet(db, 'SELECT oa_number FROM issue_lite WHERE id = ?', [idA]);
        expect(oa8.oa_number === `datadev-${idA}`, `datadev-999 归一为本单占位（实际 ${oa8.oa_number}）`);
        // M-3：number OA → 400（只收 string）
        r = await api('PUT', `/api/issue-lite/${idA}`, userToken, { oa_number: 12345678901234567890 });
        expect(r.status === 400 && r.json.code === 'OA_NUMBER_INVALID', `number OA → 400（防精度舍入，实际 ${r.status}）`);
        // M-2：历史部门（不在白名单）+ 只改标题 → 200 不被阻断
        await dbRun(db, `UPDATE issue_lite SET requester_dept = '已裁撤部门X' WHERE id = ?`, [idA]);
        r = await api('PUT', `/api/issue-lite/${idA}`, userToken, { title: 'E2-历史部门下改标题', requester_dept: '已裁撤部门X' });
        expect(r.status === 200, `历史部门未变+改标题 → 200 不被白名单阻断（实际 ${r.status}：${r.json.error || 'ok'}）`);
        // 已归档 can_edit=false 投影
        await dbRun(db, `UPDATE issue_lite SET status = '已归档' WHERE id = ?`, [idA]);
        r = await api('GET', `/api/issue-lite/${idA}`, userToken);
        expect(r.json.can_edit === false, '已归档详情 can_edit=false 投影');
        await dbRun(db, `UPDATE issue_lite SET status = '待处理' WHERE id = ?`, [idA]);

        // ---- 9. L-6（复审拍板）：req_date 空白两态 + 历史超长 description 不拦 ----
        console.log('\n9. 归一化边界（L-6）');
        await dbRun(db, `UPDATE issue_lite SET req_date = NULL WHERE id = ?`, [idA]);
        const c9a = await dbGet(db, 'SELECT COUNT(*) n FROM issue_lite_edit_logs WHERE issue_lite_id = ?', [idA]);
        r = await api('PUT', `/api/issue-lite/${idA}`, userToken, { req_date: '   ' });
        const c9b = await dbGet(db, 'SELECT COUNT(*) n FROM issue_lite_edit_logs WHERE issue_lite_id = ?', [idA]);
        expect(r.status === 200 && r.json.updated === 0 && c9b.n === c9a.n, `req_date 空白+现值 null → updated:0 不留痕（实际 ${r.status}/${r.json.updated}）`);
        await dbRun(db, `UPDATE issue_lite SET req_date = '2026-08-01' WHERE id = ?`, [idA]);
        r = await api('PUT', `/api/issue-lite/${idA}`, userToken, { req_date: '  ' });
        const rd9 = await dbGet(db, 'SELECT req_date FROM issue_lite WHERE id = ?', [idA]);
        expect(r.status === 200 && rd9.req_date === null, `req_date 空白+现值有值 → 清 null（实际 ${rd9.req_date}）`);
        const longDesc = 'x'.repeat(2500);
        await dbRun(db, `UPDATE issue_lite SET description = ? WHERE id = ?`, [longDesc, idA]);
        r = await api('PUT', `/api/issue-lite/${idA}`, userToken, { title: 'E2-超长desc下改标题', description: longDesc });
        const lg9 = await dbGet(db, 'SELECT changed_fields FROM issue_lite_edit_logs WHERE issue_lite_id = ? ORDER BY id DESC LIMIT 1', [idA]);
        expect(r.status === 200 && !lg9.changed_fields.includes('补充说明'), `历史超长说明未变+改标题 → 200 且留痕不含补充说明（M-5，实际 ${r.status}/${lg9.changed_fields}）`);

        // ---- 10. 手机号变更通知重置（末次合并审 MED，镜像 correction E3 范式）----
        console.log('\n10. 手机号变更 → N-est/N2 通知态重置');
        await dbRun(db, `UPDATE issue_lite SET est_notify_status='sent', est_notify_at='2026-07-23T09:00:00Z', est_notify_message_key='mk-est', est_notify_read_at='2026-07-23T09:10:00Z',
            req_notify_status='sent', req_notify_at='2026-07-23T09:05:00Z', req_notify_message_key='mk-req', req_notify_read_at='2026-07-23T09:15:00Z' WHERE id = ?`, [idA]);
        r = await api('PUT', `/api/issue-lite/${idA}`, userToken, { title: 'E2-仅改标题不动号' });
        let np = await dbGet(db, 'SELECT est_notify_status, req_notify_status FROM issue_lite WHERE id = ?', [idA]);
        expect(r.status === 200 && np.est_notify_status === 'sent' && np.req_notify_status === 'sent', '仅改标题不重置通知态（收件人锚=手机号）');
        // 六审 LOW：补「仅改业务方姓名」负例（同人改名≠换收件人，不重置；与手机号变更形成对照）
        r = await api('PUT', `/api/issue-lite/${idA}`, userToken, { requester_name: 'E2-仅改名不动号' });
        np = await dbGet(db, 'SELECT est_notify_status, req_notify_status FROM issue_lite WHERE id = ?', [idA]);
        expect(r.status === 200 && np.est_notify_status === 'sent' && np.req_notify_status === 'sent', '仅改业务方姓名不重置通知态（同人改名不重发）');
        r = await api('PUT', `/api/issue-lite/${idA}`, userToken, { requester_phone: '13866666666' });
        expect(r.status === 200, `改手机号 → 200（实际 ${r.status}：${r.json.error || 'ok'}）`);
        np = await dbGet(db, 'SELECT requester_phone, est_notify_status, est_notify_at, est_notify_message_key, est_notify_read_at, req_notify_status, req_notify_at, req_notify_message_key, req_notify_read_at FROM issue_lite WHERE id = ?', [idA]);
        expect(np.requester_phone === '13866666666'
            && np.est_notify_status == null && np.est_notify_at == null && np.est_notify_message_key == null && np.est_notify_read_at == null
            && np.req_notify_status == null && np.req_notify_at == null && np.req_notify_message_key == null && np.req_notify_read_at == null,
            'N-est/N2 两套四件套+已读全重置（旧通知不归属新号）');

        // ---- 7. 三件套静态断言 ----
        console.log('\n7. WHERE 复校守卫');
        const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
        expect(src.includes(`WHERE id = ? AND created_by = ? AND voided_at IS NULL AND status != '已归档'`), '非 admin 通道 UPDATE 带 created_by+非终态复校（静态断言）');
        // 末次合并审 MED：est/req 回写收件人乐观锁静态守卫（helper 带 phoneSnapshot guard + 两调用方传快照）
        expect(src.includes(`AND COALESCE(requester_phone,'') = ?`) && src.split(`persistIssueLiteNotifyResult(id, 'req_', attemptAt, result, res, rec.requester_phone`).length === 2
            && src.split(`persistIssueLiteNotifyResult(id, 'est_', attemptAt, result, res, rec.requester_phone`).length === 2,
            'est/req 通知回写带收件人快照锁（helper guard + N-est/N2 双调用方传参，静态断言）');
    } catch (e) {
        console.log('  ✗ e2e 异常：' + (e && e.stack || e));   // 原先异常会变成未处理拒绝；现计失败，仍走下面的清理与收尾
        fail++;
    } finally {
        // [#106 S4c 收口] 每个单的三条 DELETE 放在同一个 try/catch：任一条失败该编号留在待清理列表里（不再 .catch(() => {}) 吞掉），剩余编号再试一轮；
        //   仍遗留的每个计 1 次失败（fail），不中断后续清理、关库与 teardown
        const pendingIds = created.filter(Boolean);
        for (let round = 0; round < 2 && pendingIds.length > 0; round++) {
            if (round > 0) await new Promise((r) => setTimeout(r, 200));   // [#106 S4c 送审前小修] 两轮之间等 200ms：防服务端事务外异步回写偶发 SQLITE_BUSY 被计失败
            for (const id of pendingIds.slice()) {
                try {
                    await dbRun(db, 'DELETE FROM issue_lite_edit_logs WHERE issue_lite_id = ?', [id]);
                    await dbRun(db, 'DELETE FROM issue_lite_attachments WHERE issue_lite_id = ?', [id]);
                    await dbRun(db, 'DELETE FROM issue_lite WHERE id = ?', [id]);
                    pendingIds.splice(pendingIds.indexOf(id), 1);
                } catch (e) { console.error(`清理 issue_lite #${id} 失败（第 ${round + 1} 轮）：${e.message}`); }
            }
        }
        if (pendingIds.length > 0) { console.error(`测试单清理失败，遗留 id=${pendingIds.join(',')}`); fail += pendingIds.length; }
        await new Promise((resolve) => { db.close((cerr) => { if (cerr) { console.error(`关库失败：${cerr.message}`); fail++; } resolve(); }); });
        try { await fx.teardown(); } catch (e) { console.error(`teardown 失败：${e.message}`); fail++; }
    }
    console.log(`\n== Summary: ${pass} pass / ${fail} fail ==`);
    fx.finish(fail > 0 ? 1 : 0);   // teardown 已落定；只设退出码（见 lib/test-env.js finish），不在 finally 里调
})().catch(async (e) => {
    console.error('issue-lite-creator-edit verify 启动失败：', e && e.stack || e);
    try { await fx.teardown(); } catch (_) { /* 已在报错路径 */ }
    process.exit(1);
});
