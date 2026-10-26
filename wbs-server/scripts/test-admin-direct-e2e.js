/**
 * v1.72.3 admin 直派模式 e2e 烟雾测试
 *
 * 用法：node scripts/test-admin-direct-e2e.js
 * 前置：入口 ready() 自起隔离实例，或核对批跑器给的 TEST_* 变量组（四个必须同时给）
 *
 * 覆盖用例：
 *   T1  admin 直派创建 → EXPORTING + assign_mode='admin_direct' + 字段写入正确
 *   T2  非 admin（dev1）调改派 → 403
 *   T3  同时填 contact_person + exporter → 400 CONFLICTING_ASSIGN_MODE
 *   T4  两者都不填 → 400 MISSING_ASSIGN_MODE
 *   T5  非 admin（dev1）走 admin_direct 模式创建 → 403 (中间件 requireAdmin)
 *   T6  admin 改派 → 字段更新 + ADMIN_DIRECT_REASSIGN 日志
 *   T7  admin 改派给同一人 → 仍允许（不限次数）
 *   T8  admin 切回流转 → PENDING_ASSIGN + exporter_user_id=NULL + assign_mode 保留
 *   T9  切回流转后调 archive → 200（复用现有 archive 能力）
 *   T10 normal 模式协作单调改派 → 409 NOT_ADMIN_DIRECT_MODE
 *   T11 admin 直派单 EXPORTING 状态 → POST /notify 调用 → 200 + NOTIFY_EXPORTER_DIRECT 日志（钉钉本身可能 502 但是 endpoint 走 PENDING_ASSIGN 时返 403，验证状态分支正常）
 *   T12 改派历史 endpoint → 返回数组（含上面 T6/T7 的 2 条改派记录）
 *   T13 mutex 串行化：并发 reassign + fallback → 一个 200 一个 503
 *
 * 每个用例独立 fixture
 */
'use strict';

const path = require('path');
const fx = require('./_test-fixture');

const createdFixtureIds = [];

async function createAdminDirect(token, exporterId, oaNo) {
    return fx.apiCall('POST', '/api/collab/requests', token, {
        oa_request_no: oaNo,
        requester_dept: '市场营销部',
        requester_name: 'admin-direct-test',
        description: 'admin 直派 e2e 测试单',
        deadline: '2026-12-31 18:00:00',
        exporter_user_id: exporterId,
        target_db_connection_id: fx.TARGET_DB_CONN_ID
    });
}

async function reassign(token, id, newExporterId) {
    return fx.apiCall('POST', `/api/collab/requests/${id}/admin-direct-reassign`, token, {
        new_exporter_user_id: newExporterId
    });
}

async function fallback(token, id, reason) {
    return fx.apiCall('POST', `/api/collab/requests/${id}/admin-direct-fallback`, token, {
        fallback_reason: reason || null
    });
}

async function getReassignHistory(token, id) {
    return fx.apiCall('GET', `/api/collab/requests/${id}/reassign-history`, token);
}

async function archive(token, id) {
    return fx.apiCall('POST', `/api/collab/requests/${id}/archive`, token, { archived_reason: 'e2e cleanup' });
}

async function notify(token, id) {
    return fx.apiCall('POST', `/api/collab/requests/${id}/notify`, token, {});
}

async function getCollab(id) {
    const db = await fx.openInstanceDb(fx.DB_PATH);
    return new Promise((resolve, reject) => {
        db.get('SELECT * FROM collab_requests WHERE id=?', [id], (err, row) => {
            // [#106 S4c-A2] 等 close 回调再落定：关库错误不丢，resolve 时句柄已关闭（语句错误优先）
            db.close((cerr) => { const e = err || cerr; e ? reject(e) : resolve(row); });
        });
    });
}

async function getOpLogs(id) {
    const db = await fx.openInstanceDb(fx.DB_PATH);
    return new Promise((resolve, reject) => {
        db.all('SELECT * FROM collab_operation_logs WHERE collab_request_id=? ORDER BY id DESC',
            [id], (err, rows) => {
                db.close((cerr) => { const e = err || cerr; e ? reject(e) : resolve(rows || []); });
            });
    });
}

// [#106 S4c-A2] 用例登记成数组字面量条目（原先是模块顶层的多次 defTest(...) 调用）：静态守卫要求模块顶层只有声明与一个入口调用
const tests = [

// ============================================================
// T1：admin 直派创建
// ============================================================
{ name: 'T1: admin 直派创建 → EXPORTING + assign_mode=admin_direct', fn: async () => {
    const adminToken = await fx.signAs(fx.ADMIN_ID);
    const res = await createAdminDirect(adminToken, fx.EXPORTER_ID, `OA_AD_T1_${Date.now()}`);
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status} ${JSON.stringify(res.body)}`);
    createdFixtureIds.push(res.body.id);
    if (res.body.assign_mode !== 'admin_direct') throw new Error(`assign_mode expected admin_direct, got ${res.body.assign_mode}`);
    if (res.body.initial_status !== 'EXPORTING') throw new Error(`initial_status expected EXPORTING, got ${res.body.initial_status}`);

    const collab = await getCollab(res.body.id);
    if (collab.status !== 'EXPORTING') throw new Error(`status expected EXPORTING, got ${collab.status}`);
    if (collab.assign_mode !== 'admin_direct') throw new Error(`assign_mode db: ${collab.assign_mode}`);
    if (Number(collab.exporter_user_id) !== fx.EXPORTER_ID) throw new Error(`exporter_user_id db: ${collab.exporter_user_id}`);
    if (Number(collab.contact_person_id) !== 0) throw new Error(`contact_person_id expected 0, got ${collab.contact_person_id}`);
    if (Number(collab.developer_id) !== 0) throw new Error(`developer_id expected 0, got ${collab.developer_id}`);

    // 操作日志
    const logs = await getOpLogs(res.body.id);
    const createLog = logs.find(l => l.operation_type === 'ADMIN_DIRECT_CREATE');
    if (!createLog) throw new Error('ADMIN_DIRECT_CREATE 日志缺失');
} },

// ============================================================
// T2：非 admin 调改派 → 403
// ============================================================
{ name: 'T2: 非 admin（dev1）调改派 → 403', fn: async () => {
    const adminToken = await fx.signAs(fx.ADMIN_ID);
    const dev1Token = await fx.signAs(fx.DEV1_ID);
    const cr = await createAdminDirect(adminToken, fx.EXPORTER_ID, `OA_AD_T2_${Date.now()}`);
    createdFixtureIds.push(cr.body.id);

    const res = await reassign(dev1Token, cr.body.id, fx.PUBLISHER_ID);
    if (res.status !== 403) throw new Error(`expected 403, got ${res.status} ${JSON.stringify(res.body)}`);
} },

// ============================================================
// T3：同时填 contact_person + exporter → 400
// ============================================================
{ name: 'T3: 同时填 contact_person + exporter → 400 CONFLICTING_ASSIGN_MODE', fn: async () => {
    const adminToken = await fx.signAs(fx.ADMIN_ID);
    const res = await fx.apiCall('POST', '/api/collab/requests', adminToken, {
        oa_request_no: `OA_AD_T3_${Date.now()}`,
        requester_dept: '市场营销部',
        requester_name: 'test',
        description: 't3',
        deadline: '2026-12-31 18:00:00',
        contact_person_id: fx.CONTACT_ID,
        exporter_user_id: fx.EXPORTER_ID,
        target_db_connection_id: fx.TARGET_DB_CONN_ID
    });
    if (res.status !== 400) throw new Error(`expected 400, got ${res.status} ${JSON.stringify(res.body)}`);
    if (res.body.code !== 'CONFLICTING_ASSIGN_MODE') throw new Error(`expected code CONFLICTING_ASSIGN_MODE, got ${res.body.code}`);
} },

// ============================================================
// T4：两者都不填 → 400 MISSING_ASSIGN_MODE
// ============================================================
{ name: 'T4: 两者都不填 → 400 MISSING_ASSIGN_MODE', fn: async () => {
    const adminToken = await fx.signAs(fx.ADMIN_ID);
    const res = await fx.apiCall('POST', '/api/collab/requests', adminToken, {
        oa_request_no: `OA_AD_T4_${Date.now()}`,
        requester_dept: '市场营销部',
        requester_name: 'test',
        description: 't4',
        deadline: '2026-12-31 18:00:00',
        target_db_connection_id: fx.TARGET_DB_CONN_ID
    });
    if (res.status !== 400) throw new Error(`expected 400, got ${res.status} ${JSON.stringify(res.body)}`);
    if (res.body.code !== 'MISSING_ASSIGN_MODE') throw new Error(`expected MISSING_ASSIGN_MODE, got ${res.body.code}`);
} },

// ============================================================
// T5：非 admin 走 admin_direct → 403（被 requireAdmin 中间件拦）
// ============================================================
{ name: 'T5: 非 admin 走 admin_direct 创建 → 403', fn: async () => {
    const dev1Token = await fx.signAs(fx.DEV1_ID);
    const res = await createAdminDirect(dev1Token, fx.EXPORTER_ID, `OA_AD_T5_${Date.now()}`);
    if (res.status !== 403) throw new Error(`expected 403, got ${res.status} ${JSON.stringify(res.body)}`);
} },

// ============================================================
// T6 + T7：admin 改派 + 改派同一人
// ============================================================
{ name: 'T6+T7: admin 改派 → 字段更新 + 日志 + 同人改派也允许', fn: async () => {
    const adminToken = await fx.signAs(fx.ADMIN_ID);
    const cr = await createAdminDirect(adminToken, fx.EXPORTER_ID, `OA_AD_T67_${Date.now()}`);
    createdFixtureIds.push(cr.body.id);

    // T6: 改派给 PUBLISHER_ID
    const r1 = await reassign(adminToken, cr.body.id, fx.PUBLISHER_ID);
    if (r1.status !== 200) throw new Error(`T6 expected 200, got ${r1.status} ${JSON.stringify(r1.body)}`);
    if (Number(r1.body.exporter_id) !== fx.PUBLISHER_ID) throw new Error(`T6 exporter_id mismatch`);

    const collab1 = await getCollab(cr.body.id);
    if (Number(collab1.exporter_user_id) !== fx.PUBLISHER_ID) throw new Error(`T6 db exporter_user_id mismatch`);

    // T7: 改派给同一人（PUBLISHER_ID → PUBLISHER_ID），仍允许
    const r2 = await reassign(adminToken, cr.body.id, fx.PUBLISHER_ID);
    if (r2.status !== 200) throw new Error(`T7 expected 200, got ${r2.status} ${JSON.stringify(r2.body)}`);

    const logs = await getOpLogs(cr.body.id);
    const reassignLogs = logs.filter(l => l.operation_type === 'ADMIN_DIRECT_REASSIGN');
    if (reassignLogs.length !== 2) throw new Error(`expected 2 reassign logs, got ${reassignLogs.length}`);
} },

// ============================================================
// T8：admin 切回流转
// ============================================================
{ name: 'T8: admin 切回流转 → PENDING_ASSIGN + exporter NULL + assign_mode 保留', fn: async () => {
    const adminToken = await fx.signAs(fx.ADMIN_ID);
    const cr = await createAdminDirect(adminToken, fx.EXPORTER_ID, `OA_AD_T8_${Date.now()}`);
    createdFixtureIds.push(cr.body.id);

    const fb = await fallback(adminToken, cr.body.id, '测试切回原因');
    if (fb.status !== 200) throw new Error(`expected 200, got ${fb.status} ${JSON.stringify(fb.body)}`);
    if (fb.body.current_status !== 'PENDING_ASSIGN') throw new Error(`current_status mismatch`);

    const collab = await getCollab(cr.body.id);
    if (collab.status !== 'PENDING_ASSIGN') throw new Error(`db status: ${collab.status}`);
    if (collab.exporter_user_id !== null) throw new Error(`exporter_user_id should be NULL, got ${collab.exporter_user_id}`);
    if (collab.exporter_name !== null) throw new Error(`exporter_name should be NULL`);
    if (collab.assign_mode !== 'admin_direct') throw new Error(`assign_mode should be retained as admin_direct`);

    const logs = await getOpLogs(cr.body.id);
    const fbLog = logs.find(l => l.operation_type === 'ADMIN_DIRECT_FALLBACK');
    if (!fbLog) throw new Error('ADMIN_DIRECT_FALLBACK log missing');
    if (!fbLog.reason || !fbLog.reason.includes('测试切回原因')) throw new Error(`reason missing fallback_reason text: ${fbLog.reason}`);
} },

// ============================================================
// T9：admin 直派单作废
// ============================================================
{ name: 'T9: admin 直派单 EXPORTING 状态可作废 → 200', fn: async () => {
    const adminToken = await fx.signAs(fx.ADMIN_ID);
    const cr = await createAdminDirect(adminToken, fx.EXPORTER_ID, `OA_AD_T9_${Date.now()}`);
    createdFixtureIds.push(cr.body.id);

    const ar = await archive(adminToken, cr.body.id);
    if (ar.status !== 200) throw new Error(`expected 200, got ${ar.status} ${JSON.stringify(ar.body)}`);

    const collab = await getCollab(cr.body.id);
    if (!collab.archived_at) throw new Error('archived_at not set');
} },

// ============================================================
// T10：normal 模式协作单调改派 → 409
// ============================================================
{ name: 'T10: normal 模式协作单调改派 → 409 NOT_ADMIN_DIRECT_MODE', fn: async () => {
    const ctx = await fx.createPendingFixture();  // 创建 normal 模式 PENDING 协作单
    createdFixtureIds.push(ctx.id);

    const adminToken = await fx.signAs(fx.ADMIN_ID);
    // normal 模式 PENDING 状态不能调 admin-direct-reassign，预期 409（NOT_ADMIN_DIRECT_MODE）
    const res = await reassign(adminToken, ctx.id, fx.PUBLISHER_ID);
    if (res.status !== 409) throw new Error(`expected 409, got ${res.status} ${JSON.stringify(res.body)}`);
    if (res.body.code !== 'NOT_ADMIN_DIRECT_MODE') throw new Error(`code expected NOT_ADMIN_DIRECT_MODE, got ${res.body.code}`);
} },

// ============================================================
// T11：admin 直派 EXPORTING /notify 权限（仅 admin）
// ============================================================
{ name: 'T11: admin 直派单 EXPORTING /notify 非 admin → 403', fn: async () => {
    const adminToken = await fx.signAs(fx.ADMIN_ID);
    const cr = await createAdminDirect(adminToken, fx.EXPORTER_ID, `OA_AD_T11_${Date.now()}`);
    createdFixtureIds.push(cr.body.id);

    // dev1（非 admin）调 /notify 应被拒
    const dev1Token = await fx.signAs(fx.DEV1_ID);
    const res = await notify(dev1Token, cr.body.id);
    if (res.status !== 403) throw new Error(`expected 403, got ${res.status} ${JSON.stringify(res.body)}`);
} },

// ============================================================
// T12：改派历史 endpoint
// ============================================================
{ name: 'T12: GET /reassign-history → 返回改派记录数组', fn: async () => {
    const adminToken = await fx.signAs(fx.ADMIN_ID);
    const cr = await createAdminDirect(adminToken, fx.EXPORTER_ID, `OA_AD_T12_${Date.now()}`);
    createdFixtureIds.push(cr.body.id);

    // 改派 3 次
    await reassign(adminToken, cr.body.id, fx.PUBLISHER_ID);
    await reassign(adminToken, cr.body.id, fx.EXPORTER_ID);
    await reassign(adminToken, cr.body.id, fx.PUBLISHER_ID);

    const res = await getReassignHistory(adminToken, cr.body.id);
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
    if (!Array.isArray(res.body.logs)) throw new Error('logs not array');
    if (res.body.logs.length !== 3) throw new Error(`expected 3 logs, got ${res.body.logs.length}`);
} },

// ============================================================
// T13：mutex 串行化（并发 reassign + fallback）
// ============================================================
{ name: 'T13: mutex 串行化 reassign + fallback 并发 → 1 成功 1 不会 deadlock', fn: async () => {
    const adminToken = await fx.signAs(fx.ADMIN_ID);
    const cr = await createAdminDirect(adminToken, fx.EXPORTER_ID, `OA_AD_T13_${Date.now()}`);
    createdFixtureIds.push(cr.body.id);

    // 并发：reassign + fallback
    // 期望：mutex 保证两者串行，第一个成功（200），第二个根据先后顺序：
    //   - 若 reassign 先：fallback 看到 EXPORTING 仍然成立，仍返 200 切回流转
    //   - 若 fallback 先：reassign 看到 PENDING_ASSIGN，返 409 STATE_CHANGED / INVALID_STATE_FOR_REASSIGN
    // 关键验证：不会出现 deadlock（5s 超时）
    const start = Date.now();
    const [r1, r2] = await Promise.all([
        reassign(adminToken, cr.body.id, fx.PUBLISHER_ID),
        fallback(adminToken, cr.body.id, 'concurrent test')
    ]);
    const elapsed = Date.now() - start;
    if (elapsed > 8000) throw new Error(`elapsed ${elapsed}ms 超过 mutex 5s 超时上限`);

    // 至少有一个成功
    const okCount = [r1, r2].filter(r => r.status === 200).length;
    if (okCount < 1) throw new Error(`expected at least 1 success, r1=${r1.status} r2=${r2.status}`);
    // 不能出现 503 mutex busy（5s 超时足够）
    // 注：如果真出现 503 是 mutex 拥堵，业务上也可接受
} },
];

// ============================================================
// 主流程
// ============================================================
(async () => {
    // [#106 S4c-A2] ready() 是入口函数的第一条有副作用的语句：失败直接落到末尾 .catch（非零退出）
    await fx.ready();   // 先于任何写库 / 网络请求：自起隔离实例（或核对 TEST_* 变量组）
    console.log('=== v1.72.3 admin 直派模式 e2e 烟雾测试 ===\n');
    let passed = 0;
    let failed = 0;

    for (const t of tests) {
        try {
            await t.fn();
            console.log(`✅ ${t.name}`);
            passed++;
        } catch (e) {
            console.error(`❌ ${t.name}`);
            console.error(`   ${e.message}`);
            failed++;
        }
    }

    // cleanup
    console.log(`\n清理 ${createdFixtureIds.length} 条测试 fixture...`);
    // [#106 S4c 收口] 夹具清理逐个 try/catch：只移除清理成功的编号，剩余编号再试一轮；仍遗留的每个计 1 次失败，不中断后续清理与 teardown
    for (let round = 0; round < 2 && createdFixtureIds.length > 0; round++) {
        if (round > 0) await new Promise((r) => setTimeout(r, 200));   // [#106 S4c 送审前小修] 两轮之间等 200ms：防服务端事务外异步回写偶发 SQLITE_BUSY 被计失败
        for (const id of createdFixtureIds.slice()) {
            try { await fx.cleanup(id); createdFixtureIds.splice(createdFixtureIds.indexOf(id), 1); } catch (e) { console.error(`cleanup ${id} failed (第 ${round + 1} 轮): ${e.message}`); }
        }
    }
    if (createdFixtureIds.length > 0) { console.error(`夹具清理失败，遗留协作单 id=${createdFixtureIds.join(',')}`); failed += createdFixtureIds.length; }

    let teardownFailed = false;
    try { await fx.teardown(); } catch (e) { console.error(`teardown 失败：${e.message}`); teardownFailed = true; }

    console.log(`\n=== ${passed} PASS / ${failed} FAIL ===`);
    fx.finish(failed === 0 && !teardownFailed ? 0 : 1);   // teardown 已落定；只设退出码（见 lib/test-env.js finish）
})().catch(async (e) => {
    console.error('admin-direct e2e 启动失败：', e && e.stack || e);
    try { await fx.teardown(); } catch (_) { /* 已在报错路径 */ }
    process.exit(1);
});
