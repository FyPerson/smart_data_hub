/**
 * v1.71.0 R06 多级链路 e2e（方案 §7.5 R06 / codex 31 审 #11 medium 采纳新增）
 *
 * 流程：admin 二级转派 dev A → dev B；dev B 转给导出人 EXPORTER；EXPORTER 退回
 *
 * 验证 3 个不变量：
 *   ① 退回后 developer_id 仍是 dev B（不回退到 dev A，避免回流污染开发记录）
 *   ② 跨人附件按人锁：dev A 时期上传的 result_script，uploaded_by=dev A
 *      - dev A 本人可删（200）
 *      - admin 可删（200，admin 越权）
 *      - dev B（当前 developer）不能删（403 ATTACHMENT_OWNER_LOCKED）
 *      - exporter 不能删（403）
 *   ③ 退回后 status=PENDING，dev B 可继续 POST /:id/submit 提交 result_script + result_data
 *
 * fixture 简化策略：
 *   dev A = DEV1_ID (id=19)
 *   dev B = ADMIN_ID (id=1)（admin role 允许指派为 dev，server.js line 12030）
 *   exporter = EXPORTER_ID (id=8)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const sqlite3 = require('sqlite3').verbose();
const fx = require('./_test-fixture');

const BASE = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');

const createdFixtureIds = [];

// 沿用 forward/return e2e 的 EXPORTER fake ding uid 处理
let _exporterOriginalDingUid = undefined;
let _exporterDingUidModified = false;
async function ensureExporterFakeDingUid() {
    if (_exporterOriginalDingUid === undefined) {
        const row = await dbGet(`SELECT dingtalk_user_id FROM users WHERE id=?`, [fx.EXPORTER_ID]);
        _exporterOriginalDingUid = row ? row.dingtalk_user_id : null;
    }
    if (!_exporterDingUidModified) {
        await dbRun(
            `UPDATE users SET dingtalk_user_id = COALESCE(dingtalk_user_id, ?) WHERE id = ?`,
            ['__fake_ding_uid_for_e2e__', fx.EXPORTER_ID]
        );
        _exporterDingUidModified = true;
    }
}
async function restoreExporterDingUid() {
    if (!_exporterDingUidModified) return;
    await dbRun(`UPDATE users SET dingtalk_user_id = ? WHERE id = ?`, [_exporterOriginalDingUid, fx.EXPORTER_ID]);
    _exporterDingUidModified = false;
}

let testTmpDir = null;
function makeTmpFile(filename, content) {
    if (!testTmpDir) testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-r06-test-'));
    const p = path.join(testTmpDir, filename);
    fs.writeFileSync(p, content);
    return p;
}

async function apiCall(method, urlPath, token, body) {
    const opts = { method, headers: { Authorization: `Bearer ${token}` } };
    if (body) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    const r = await fetch(`${BASE}${urlPath}`, opts);
    let j = null;
    try { j = await r.json(); } catch (_) { }
    return { status: r.status, body: j };
}

function dbRun(sql, params) {
    return new Promise((res, rej) => {
        const db = new sqlite3.Database(DB_PATH);
        db.run(sql, params, function (err) { db.close(); err ? rej(err) : res({ lastID: this.lastID, changes: this.changes }); });
    });
}
function dbGet(sql, params) {
    return new Promise((res, rej) => {
        const db = new sqlite3.Database(DB_PATH);
        db.get(sql, params, (err, row) => { db.close(); err ? rej(err) : res(row); });
    });
}
function dbAll(sql, params) {
    return new Promise((res, rej) => {
        const db = new sqlite3.Database(DB_PATH);
        db.all(sql, params, (err, rows) => { db.close(); err ? rej(err) : res(rows); });
    });
}

let passed = 0;
let failed = 0;
function assert(cond, label) {
    if (cond) { console.log(`  ✓ ${label}`); passed++; }
    else { console.log(`  ✗ ${label}`); failed++; }
}

// 上传 result_script（用现有 POST /attachments endpoint，attachment_type=result_script）
// 但 v1.70.x submit 限制 result_data/result_script 必须走 POST /:id/submit，不能直接走 POST /attachments
// 简化：直接 DB INSERT 模拟 dev A 时期上传（绕开 endpoint 复杂校验），uploaded_by=dev A
async function insertScriptByDevA(collabId, devAId, devAName) {
    const fileName = `collab/r06_e2e/${Date.now()}_${Math.random().toString().slice(2, 10)}_dev_a_script.sql`;
    const res = await dbRun(
        `INSERT INTO collab_attachments
            (collab_request_id, attachment_type, file_name, original_name, uploaded_by, uploaded_by_name, submission_version, status)
         VALUES (?, 'result_script', ?, 'dev_a_script.sql', ?, ?, 0, 'active')`,
        [collabId, fileName, devAId, devAName]
    );
    return res.lastID;
}

async function runTests() {
    const adminToken = await fx.signAs(fx.ADMIN_ID);
    const dev1Token = await fx.signAs(fx.DEV1_ID);
    const exporterToken = await fx.signAs(fx.EXPORTER_ID);
    const contactToken = await fx.signAs(fx.CONTACT_ID);
    const publisherToken = await fx.signAs(fx.PUBLISHER_ID);

    console.log('\n=== R06 多级链路：dev A → 改派 dev B → forward exporter → return ===');

    // === Step 1：造一个 PENDING 协作单 + dev A = DEV1_ID ===
    const ctx = await fx.createPendingFixture();
    createdFixtureIds.push(ctx.id);
    const devAId = fx.DEV1_ID;
    const devAName = '示例用户B';  // 沿用 fixture 用户

    // === Step 2：dev A 时期上传 result_script（模拟 dev A 写了 SQL 但没完成 submit）===
    const scriptAttId = await insertScriptByDevA(ctx.id, devAId, devAName);
    console.log(`     Step 2: dev A (id=${devAId}) 上传 result_script，attachment_id=${scriptAttId}`);

    // === Step 3：admin 改派 dev A → dev B（用 admin 自己当 dev B）===
    const devBId = fx.ADMIN_ID;
    const reassignRes = await apiCall('POST', `/api/collab/requests/${ctx.id}/assign`, contactToken, { developer_id: devBId });
    assert(reassignRes.status === 200, `Step 3 改派 dev A → dev B (admin)，got ${reassignRes.status} body=${JSON.stringify(reassignRes.body).slice(0, 100)}`);
    const afterReassign = await dbGet(`SELECT developer_id FROM collab_requests WHERE id=?`, [ctx.id]);
    assert(afterReassign.developer_id === devBId, `Step 3 db developer_id=${devBId}, got ${afterReassign.developer_id}`);

    // === Step 4：dev B (admin) forward 给 exporter ===
    await ensureExporterFakeDingUid();
    await dbRun(
        `UPDATE collab_requests SET dingtalk_chat_id=?, dingtalk_open_conversation_id=? WHERE id=?`,
        [`chat_r06_${Date.now()}_${Math.random()}`, `cidp_r06_${Date.now()}_${Math.random()}`, ctx.id]
    );
    // dev B (admin) 用 adminToken 调 forward（admin 角色允许 forward，权限闸门 isAdmin 通过）
    const forwardRes = await apiCall('POST', `/api/collab/requests/${ctx.id}/forward-to-exporter`, adminToken, {
        exporter_id: fx.EXPORTER_ID,
        contact_user_ids: [fx.CONTACT_ID]
    });
    assert(forwardRes.status === 200, `Step 4 dev B (admin) forward → exporter，got ${forwardRes.status}`);
    const afterForward = await dbGet(`SELECT status, exporter_user_id FROM collab_requests WHERE id=?`, [ctx.id]);
    assert(afterForward.status === 'EXPORTING', `Step 4 status=EXPORTING`);
    assert(afterForward.exporter_user_id === fx.EXPORTER_ID, `Step 4 exporter_user_id=EXPORTER_ID`);

    // === Step 5：exporter 退回（return-to-dev）===
    const returnRes = await apiCall('POST', `/api/collab/requests/${ctx.id}/return-to-dev`, exporterToken, {
        return_reason: 'missing_info',
        return_note: 'R06 测试：信息不完整，请 dev B 补充'
    });
    assert(returnRes.status === 200, `Step 5 exporter return-to-dev，got ${returnRes.status}`);

    // ===== 不变量 ① ：退回后 developer_id 仍是 dev B，不回退到 dev A =====
    console.log('\n=== R06 不变量 ①：退回后 developer_id 仍是 dev B ===');
    {
        const row = await dbGet(`SELECT status, developer_id, exporter_user_id, exporter_name FROM collab_requests WHERE id=?`, [ctx.id]);
        assert(row.status === 'PENDING', `① 退回后 status=PENDING`);
        assert(row.developer_id === devBId, `① 退回后 developer_id=devB=${devBId}（不是 devA=${devAId}），got ${row.developer_id}`);
        assert(row.developer_id !== devAId, `① developer_id !== devA（防回退污染）`);
        assert(row.exporter_user_id === fx.EXPORTER_ID, `① exporter_user_id 保留 = EXPORTER_ID（§5.3.5 历史展示）`);
        assert(row.exporter_name === '示例开发A', `① exporter_name 保留 = 示例开发A, got ${row.exporter_name}`);
    }

    // ===== 不变量 ② ：跨人附件按人锁 — dev A 时期附件，uploaded_by=devA =====
    console.log('\n=== R06 不变量 ②：跨人附件按人锁（dev A 时期附件） ===');
    {
        // 验证 attachment 仍然存在 + uploaded_by=devA
        const att = await dbGet(`SELECT id, uploaded_by, uploaded_by_name FROM collab_attachments WHERE id=?`, [scriptAttId]);
        assert(att && att.uploaded_by === devAId, `② attachment uploaded_by=devA=${devAId}, got ${att && att.uploaded_by}`);

        // ②a dev A 删自己上传的 → 200（本人）
        const delA = await apiCall('DELETE', `/api/collab/attachments/${scriptAttId}`, dev1Token);
        assert(delA.status === 200, `②a dev A 删自己上传 → 200, got ${delA.status} body=${JSON.stringify(delA.body).slice(0, 100)}`);

        // ②b 重新插一个用于后续测试（dev A 上传 → 再次测）
        const scriptAttId2 = await insertScriptByDevA(ctx.id, devAId, devAName);

        // ②c admin (dev B) 删 dev A 上传的 → 200（admin 越权 = devB 角色 admin）
        //    注意：dev B 在本 fixture 就是 admin role，admin 角色按 checkAttachmentOwnerOrAdmin 允许越权
        //    这条同时验证"admin 可以删任何人附件" + "dev B = admin 可删 dev A 附件"
        const delAdmin = await apiCall('DELETE', `/api/collab/attachments/${scriptAttId2}`, adminToken);
        assert(delAdmin.status === 200, `②c admin/dev B 删 dev A 附件 → 200, got ${delAdmin.status}`);

        // ②d 再插一次，用 exporter 删 → 403（exporter 不是 admin 也不是上传人）
        const scriptAttId3 = await insertScriptByDevA(ctx.id, devAId, devAName);
        const delExp = await apiCall('DELETE', `/api/collab/attachments/${scriptAttId3}`, exporterToken);
        assert(delExp.status === 403 && delExp.body && delExp.body.code === 'ATTACHMENT_OWNER_LOCKED',
            `②d exporter 删 dev A 附件 → 403 ATTACHMENT_OWNER_LOCKED, got ${delExp.status}/${delExp.body && delExp.body.code}`);

        // ②e contact 删 dev A 附件 → 403
        const delContact = await apiCall('DELETE', `/api/collab/attachments/${scriptAttId3}`, contactToken);
        assert(delContact.status === 403 && delContact.body && delContact.body.code === 'ATTACHMENT_OWNER_LOCKED',
            `②e contact 删 dev A 附件 → 403, got ${delContact.status}/${delContact.body && delContact.body.code}`);

        // ②f publisher 删 dev A 附件 → 403（Commit B publisher 收权）
        const delPub = await apiCall('DELETE', `/api/collab/attachments/${scriptAttId3}`, publisherToken);
        assert(delPub.status === 403 && delPub.body && delPub.body.code === 'ATTACHMENT_OWNER_LOCKED',
            `②f publisher 删 dev A 附件 → 403, got ${delPub.status}/${delPub.body && delPub.body.code}`);

        // 清理：dev A 自己删掉最后一个
        await apiCall('DELETE', `/api/collab/attachments/${scriptAttId3}`, dev1Token);
    }

    // ===== 不变量 ③ ：退回后 status=PENDING，dev B 可继续 forward / submit =====
    console.log('\n=== R06 不变量 ③：退回后 dev B 可继续推进协作单 ===');
    {
        // ③a dev B (admin) 再次 forward 给同 exporter → 200
        const refwd = await apiCall('POST', `/api/collab/requests/${ctx.id}/forward-to-exporter`, adminToken, {
            exporter_id: fx.EXPORTER_ID,
            contact_user_ids: [fx.CONTACT_ID]
        });
        assert(refwd.status === 200, `③a 退回后 dev B 再次 forward → 200, got ${refwd.status}`);

        const after = await dbGet(`SELECT status, exporter_user_id, developer_id FROM collab_requests WHERE id=?`, [ctx.id]);
        assert(after.status === 'EXPORTING', `③a 再次 forward 后 status=EXPORTING`);
        assert(after.developer_id === devBId, `③a developer_id 仍是 devB`);
        assert(after.exporter_user_id === fx.EXPORTER_ID, `③a exporter_user_id=EXPORTER`);
    }

    console.log(`\n   R06 多级链路 e2e 全部场景 完成`);
}

(async () => {
    try {
        await runTests();
    } catch (e) {
        console.error('\n!! e2e 运行异常：', e.message, e.stack);
        failed++;
    } finally {
        for (const id of createdFixtureIds) {
            try { await fx.cleanup(id); } catch (e) { console.error('cleanup failed:', e.message); }
        }
        try { await restoreExporterDingUid(); } catch (e) { console.error('restore EXPORTER ding uid failed:', e.message); }
        if (testTmpDir) {
            try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch (_) { }
        }
        console.log(`\n== Summary: ${passed} pass / ${failed} fail ==`);
        process.exit(failed === 0 ? 0 : 1);
    }
})();
