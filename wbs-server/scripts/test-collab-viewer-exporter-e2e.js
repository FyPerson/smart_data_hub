/**
 * v1.72.5 viewer 角色 admin 直派收单 e2e 烟雾测试
 *
 * 用法：node scripts/test-collab-viewer-exporter-e2e.js
 * 前置：本地 server 已启动（localhost:3000）+ 本地 DB 至少 2 个 viewer 用户（沈倩静 id=2 / 甄妮 id=4）
 *
 * 覆盖用例（5 个）：
 *   V1  admin 直派给 viewer（沈倩静） → submit-export 成功 200 + 状态 SUBMITTED
 *   V2  viewer A 试图 submit-export viewer B 的协作单 → 403 VIEWER_NOT_EXPORTER
 *   V3  admin 直派给 viewer → return-to-dev 成功 200 + 状态 PENDING_ASSIGN
 *   V4  viewer 试图调 /notify → 403（保持 requireNonViewer）
 *   V5  viewer 试图调通用 /attachments → 403（保持 requireNonViewer，D2 决策"viewer 仅一次性 submit-export，不放开多次追加"）
 *
 * 每个用例独立 fixture
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const sqlite3 = require('sqlite3').verbose();
const fx = require('./_test-fixture');

const BASE = fx.BASE;
const DB_PATH = fx.DB_PATH;
const createdFixtureIds = [];

function makeTmpFile(name, buf) {
    const tmpPath = path.join(os.tmpdir(), `viewer-e2e-${Date.now()}-${name}`);
    fs.writeFileSync(tmpPath, buf);
    return tmpPath;
}

async function createAdminDirect(token, exporterId, oaNo) {
    return fx.apiCall('POST', '/api/collab/requests', token, {
        oa_request_no: oaNo,
        requester_dept: '市场营销部',
        requester_name: 'viewer-e2e',
        description: 'v1.72.5 viewer admin 直派 e2e 测试单',
        deadline: '2026-12-31 18:00:00',
        exporter_user_id: exporterId,
        target_db_connection_id: fx.TARGET_DB_CONN_ID
    });
}

async function postSubmitExport(reqId, token) {
    const fd = new FormData();
    const dataBuf = Buffer.from('viewer e2e data ' + Date.now());
    const shotBuf = Buffer.from('viewer e2e screenshot ' + Date.now());
    fd.append('result_data', new Blob([dataBuf]), 'result.xlsx');
    fd.append('result_data_screenshot', new Blob([shotBuf]), 'screenshot.png');
    fd.append('export_summary', 'viewer e2e submit');

    const r = await fetch(`${BASE}/api/collab/requests/${reqId}/submit-export`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd
    });
    let j = null;
    try { j = await r.json(); } catch (_) { }
    return { status: r.status, body: j };
}

async function returnToDev(token, id) {
    return fx.apiCall('POST', `/api/collab/requests/${id}/return-to-dev`, token, {
        return_reason: 'missing_info',
        return_note: 'viewer e2e 携带退回备注（codex 49 L-3 修订：覆盖 viewer 真实场景）'
    });
}

async function notify(token, id) {
    return fx.apiCall('POST', `/api/collab/requests/${id}/notify`, token, {});
}

async function postGenericAttachment(reqId, token) {
    const fd = new FormData();
    const buf = Buffer.from('viewer e2e attachment ' + Date.now());
    fd.append('files', new Blob([buf]), 'extra.png');
    fd.append('attachment_type', 'original_screenshot');

    const r = await fetch(`${BASE}/api/collab/requests/${reqId}/attachments`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd
    });
    let j = null;
    try { j = await r.json(); } catch (_) { }
    return { status: r.status, body: j };
}

async function getCollab(id) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH);
        db.get('SELECT * FROM collab_requests WHERE id=?', [id], (err, row) => {
            db.close();
            err ? reject(err) : resolve(row);
        });
    });
}

const tests = [];
function defTest(name, fn) { tests.push({ name, fn }); }

// ============================================================
// V1: admin 直派给 viewer → viewer submit-export 成功
// ============================================================
defTest('V1: admin 直派给 viewer(沈倩静) → viewer submit-export 200 + SUBMITTED', async () => {
    const adminToken = await fx.signAs(fx.ADMIN_ID);
    const viewerToken = await fx.signAs(fx.VIEWER_ID);
    const cr = await createAdminDirect(adminToken, fx.VIEWER_ID, `OA_VW_V1_${Date.now()}`);
    if (cr.status !== 200) throw new Error(`create failed ${cr.status} ${JSON.stringify(cr.body)}`);
    createdFixtureIds.push(cr.body.id);

    const res = await postSubmitExport(cr.body.id, viewerToken);
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status} ${JSON.stringify(res.body)}`);

    const collab = await getCollab(cr.body.id);
    if (collab.status !== 'SUBMITTED') throw new Error(`status expected SUBMITTED, got ${collab.status}`);
    if (Number(collab.exporter_user_id) !== fx.VIEWER_ID) throw new Error(`exporter_user_id mismatch: ${collab.exporter_user_id}`);
});

// ============================================================
// V2: viewer A 跨单越权 submit-export viewer B 的单 → 403
// ============================================================
defTest('V2: viewer A 试图 submit-export viewer B 的单 → 403 VIEWER_NOT_EXPORTER', async () => {
    const adminToken = await fx.signAs(fx.ADMIN_ID);
    const viewerA = await fx.signAs(fx.VIEWER_ID);   // 沈倩静
    // 直派给 viewer B（甄妮）
    const cr = await createAdminDirect(adminToken, fx.VIEWER2_ID, `OA_VW_V2_${Date.now()}`);
    if (cr.status !== 200) throw new Error(`create failed ${cr.status}`);
    createdFixtureIds.push(cr.body.id);

    // viewer A 试图提交 → 403
    const res = await postSubmitExport(cr.body.id, viewerA);
    if (res.status !== 403) throw new Error(`expected 403, got ${res.status} ${JSON.stringify(res.body)}`);
    if (res.body && res.body.code !== 'VIEWER_NOT_EXPORTER') {
        throw new Error(`expected code VIEWER_NOT_EXPORTER, got ${res.body && res.body.code}`);
    }
});

// ============================================================
// V3: admin 直派给 viewer → viewer return-to-dev 成功
// ============================================================
defTest('V3: admin 直派给 viewer → viewer return-to-dev 200 + PENDING', async () => {
    const adminToken = await fx.signAs(fx.ADMIN_ID);
    const viewerToken = await fx.signAs(fx.VIEWER_ID);
    const cr = await createAdminDirect(adminToken, fx.VIEWER_ID, `OA_VW_V3_${Date.now()}`);
    if (cr.status !== 200) throw new Error(`create failed ${cr.status}`);
    createdFixtureIds.push(cr.body.id);

    const res = await returnToDev(viewerToken, cr.body.id);
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status} ${JSON.stringify(res.body)}`);

    const collab = await getCollab(cr.body.id);
    if (collab.status !== 'PENDING') throw new Error(`status expected PENDING, got ${collab.status}`);
});

// ============================================================
// V4: viewer 调 /notify → 403（保持 requireNonViewer，不放开）
// ============================================================
defTest('V4: viewer 调 /notify → 403（保持 requireNonViewer，D3 决策不放开）', async () => {
    const adminToken = await fx.signAs(fx.ADMIN_ID);
    const viewerToken = await fx.signAs(fx.VIEWER_ID);
    const cr = await createAdminDirect(adminToken, fx.VIEWER_ID, `OA_VW_V4_${Date.now()}`);
    createdFixtureIds.push(cr.body.id);

    const res = await notify(viewerToken, cr.body.id);
    if (res.status !== 403) throw new Error(`expected 403, got ${res.status} ${JSON.stringify(res.body)}`);
});

// ============================================================
// V5: viewer 调通用 /attachments → 403（保持 requireNonViewer，D2 决策不放开多次追加）
// ============================================================
defTest('V5: viewer 调通用 /attachments → 403（保持 requireNonViewer，D2 决策一次性提交）', async () => {
    const adminToken = await fx.signAs(fx.ADMIN_ID);
    const viewerToken = await fx.signAs(fx.VIEWER_ID);
    const cr = await createAdminDirect(adminToken, fx.VIEWER_ID, `OA_VW_V5_${Date.now()}`);
    createdFixtureIds.push(cr.body.id);

    const res = await postGenericAttachment(cr.body.id, viewerToken);
    if (res.status !== 403) throw new Error(`expected 403, got ${res.status} ${JSON.stringify(res.body)}`);
});

// ============================================================
// V6: viewer 调 admin-direct-reassign / admin-direct-fallback → 403（requireAdmin 拦截，未被本次改动放开）
// codex 49 Rec 4 采纳新增
// ============================================================
defTest('V6: viewer 调 admin-direct-reassign / admin-direct-fallback → 403（requireAdmin 未放开）', async () => {
    const adminToken = await fx.signAs(fx.ADMIN_ID);
    const viewerToken = await fx.signAs(fx.VIEWER_ID);
    const cr = await createAdminDirect(adminToken, fx.VIEWER_ID, `OA_VW_V6_${Date.now()}`);
    createdFixtureIds.push(cr.body.id);

    // V6a: viewer 调 admin-direct-reassign → 403
    const reassignRes = await fx.apiCall('POST', `/api/collab/requests/${cr.body.id}/admin-direct-reassign`, viewerToken, {
        new_exporter_user_id: fx.VIEWER2_ID
    });
    if (reassignRes.status !== 403) {
        throw new Error(`reassign expected 403, got ${reassignRes.status} ${JSON.stringify(reassignRes.body)}`);
    }

    // V6b: viewer 调 admin-direct-fallback → 403
    const fallbackRes = await fx.apiCall('POST', `/api/collab/requests/${cr.body.id}/admin-direct-fallback`, viewerToken, {
        fallback_reason: 'viewer 不应能切回流转'
    });
    if (fallbackRes.status !== 403) {
        throw new Error(`fallback expected 403, got ${fallbackRes.status} ${JSON.stringify(fallbackRes.body)}`);
    }
});

// ============================================================
// V7: viewer return-to-dev 后 PENDING 状态再次 submit-export → 状态冲突（409 INVALID_STATE_FOR_EXPORT_SUBMIT）
// codex 49 Rec 4 采纳新增：确认中间件放行后 endpoint 状态守卫仍生效，不存在权限绕过
// ============================================================
defTest('V7: viewer return-to-dev 后 PENDING 状态再次 submit-export → 409 状态冲突而非绕过', async () => {
    const adminToken = await fx.signAs(fx.ADMIN_ID);
    const viewerToken = await fx.signAs(fx.VIEWER_ID);
    const cr = await createAdminDirect(adminToken, fx.VIEWER_ID, `OA_VW_V7_${Date.now()}`);
    if (cr.status !== 200) throw new Error(`create failed ${cr.status}`);
    createdFixtureIds.push(cr.body.id);

    // 先 return-to-dev → PENDING
    const ret = await returnToDev(viewerToken, cr.body.id);
    if (ret.status !== 200) throw new Error(`return-to-dev failed: ${ret.status} ${JSON.stringify(ret.body)}`);

    // 再次 submit-export → 应返 409 INVALID_STATE_FOR_EXPORT_SUBMIT（state 是 PENDING 不是 EXPORTING）
    // 关键：viewer 仍是 exporter_user_id（字段保留 §5.3.5），中间件放行
    //       但 endpoint 内层状态守卫拦住 → 不存在权限绕过
    const res = await postSubmitExport(cr.body.id, viewerToken);
    if (res.status !== 409) {
        throw new Error(`expected 409, got ${res.status} ${JSON.stringify(res.body)}`);
    }
    if (res.body && res.body.code !== 'INVALID_STATE_FOR_EXPORT_SUBMIT') {
        throw new Error(`expected code INVALID_STATE_FOR_EXPORT_SUBMIT, got ${res.body && res.body.code}`);
    }
});

// ============================================================
// 主流程
// ============================================================
(async () => {
    console.log('=== v1.72.5 viewer 角色 admin 直派收单 e2e 烟雾测试 ===\n');
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

    console.log(`\n清理 ${createdFixtureIds.length} 条测试 fixture...`);
    for (const id of createdFixtureIds) {
        try { await fx.cleanup(id); } catch (e) { /* ignore */ }
    }

    console.log(`\n=== ${passed} PASS / ${failed} FAIL ===`);
    process.exit(failed === 0 ? 0 : 1);
})();
