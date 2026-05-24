/**
 * v1.71.0 附件按人锁 DELETE 闸门 e2e（方案 §2.2 + v0.1 D5 B1-锁）
 *
 * 验证：
 *   T1: admin 删别人上传的附件 → 200（admin 越权 OK）
 *   T2: 上传人本人删自己上传的附件 → 200
 *   T3: 非 admin / 非上传人（dev1 删 contact 上传的） → 403 ATTACHMENT_OWNER_LOCKED
 *   T4: publisher 删别人上传的附件 → 403 ATTACHMENT_OWNER_LOCKED（v1.71.0 收权关键）
 *   T5: publisher 删自己上传的附件 → 200（publisher 本人仍可删）
 *   T6: 闸门优先于业务分支 — failed 附件 + 非 admin 他人 → 403 ATTACHMENT_OWNER_LOCKED（不是 FAILED_KEEP_FOR_AUDIT）
 *   T7: 软删除守卫优先于闸门 — PARENT_SOFT_ARCHIVED 即使是 admin 也拒（409）
 *   T8: 闸门优先于 isFinalArchived — ARCHIVED + 非 owner 非 admin → 403 ATTACHMENT_OWNER_LOCKED（不是 PARENT_ARCHIVED_LOCKED）
 *        与 T6/T7 形成"闸门相对各业务分支优先级"三件套（软删除 > 闸门 > failed/ARCHIVED 分支）
 *
 * 注：T1-T5 使用 PENDING 状态 + 各类型 attachment，避开 DONE/ARCHIVED 后的精细化分支
 *     T6 验证闸门在 failed 分支前生效（publisher 收权落地的关键证据）
 *     T7 验证软删除守卫还在闸门前（高优先级硬约束不能被闸门绕过）
 *
 * fixture 独立，运行后 cleanup。
 */
'use strict';

const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fx = require('./_test-fixture');

const BASE = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');

const createdFixtureIds = [];

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
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH);
        db.run(sql, params, function (err) {
            db.close();
            err ? reject(err) : resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function dbGet(sql, params) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH);
        db.get(sql, params, (err, row) => {
            db.close();
            err ? reject(err) : resolve(row);
        });
    });
}

let passed = 0;
let failed = 0;

function assert(cond, label) {
    if (cond) {
        console.log(`  ✓ ${label}`);
        passed++;
    } else {
        console.log(`  ✗ ${label}`);
        failed++;
    }
}

async function insertAttachment(collabId, uploadedById, uploadedByName, type = 'screenshot', status = 'active') {
    const fileName = `collab/test/owner-lock-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`;
    const res = await dbRun(
        `INSERT INTO collab_attachments (collab_request_id, attachment_type, file_name, original_name, uploaded_by, uploaded_by_name, status, submission_version)
         VALUES (?, ?, ?, 'owner-lock.png', ?, ?, ?, 0)`,
        [collabId, type, fileName, uploadedById, uploadedByName, status]
    );
    return res.lastID;
}

async function runTests() {
    const publisherToken = await fx.signAs(fx.PUBLISHER_ID);

    console.log('\n=== T1: admin 删 contact (id=3) 上传的附件 → 200（admin 越权 OK）===');
    {
        const ctx = await fx.createPendingFixture();
        createdFixtureIds.push(ctx.id);
        const attId = await insertAttachment(ctx.id, fx.CONTACT_ID, '示例用户A');
        const res = await apiCall('DELETE', `/api/collab/attachments/${attId}`, ctx.adminToken);
        assert(res.status === 200, `T1 status=200, got ${res.status} body=${JSON.stringify(res.body).slice(0, 200)}`);
        const row = await dbGet('SELECT id FROM collab_attachments WHERE id=?', [attId]);
        assert(!row, `T1 db 行已删`);
    }

    console.log('\n=== T2: 上传人本人 (contact id=3) 删自己上传的附件 → 200 ===');
    {
        const ctx = await fx.createPendingFixture();
        createdFixtureIds.push(ctx.id);
        const attId = await insertAttachment(ctx.id, fx.CONTACT_ID, '示例用户A');
        const res = await apiCall('DELETE', `/api/collab/attachments/${attId}`, ctx.contactToken);
        assert(res.status === 200, `T2 status=200, got ${res.status} body=${JSON.stringify(res.body).slice(0, 200)}`);
    }

    console.log('\n=== T3: 非 admin / 非上传人 (dev1 id=19) 删 contact 上传的 → 403 ATTACHMENT_OWNER_LOCKED ===');
    {
        const ctx = await fx.createPendingFixture();
        createdFixtureIds.push(ctx.id);
        const attId = await insertAttachment(ctx.id, fx.CONTACT_ID, '示例用户A');
        const res = await apiCall('DELETE', `/api/collab/attachments/${attId}`, ctx.dev1Token);
        assert(res.status === 403, `T3 status=403, got ${res.status}`);
        assert(res.body && res.body.code === 'ATTACHMENT_OWNER_LOCKED', `T3 code=ATTACHMENT_OWNER_LOCKED, got ${res.body && res.body.code}`);
    }

    console.log('\n=== T4: publisher (id=7) 删 contact 上传的 → 403 ATTACHMENT_OWNER_LOCKED（v1.71.0 收权关键）===');
    {
        const ctx = await fx.createPendingFixture();
        createdFixtureIds.push(ctx.id);
        const attId = await insertAttachment(ctx.id, fx.CONTACT_ID, '示例用户A');
        const res = await apiCall('DELETE', `/api/collab/attachments/${attId}`, publisherToken);
        assert(res.status === 403, `T4 status=403, got ${res.status}`);
        assert(res.body && res.body.code === 'ATTACHMENT_OWNER_LOCKED', `T4 code=ATTACHMENT_OWNER_LOCKED, got ${res.body && res.body.code}`);
        const row = await dbGet('SELECT id FROM collab_attachments WHERE id=?', [attId]);
        assert(row && row.id === attId, `T4 db 行未被删（publisher 收权落地证据）`);
    }

    console.log('\n=== T5: publisher 删自己上传的 → 200（publisher 本人仍可删）===');
    {
        const ctx = await fx.createPendingFixture();
        createdFixtureIds.push(ctx.id);
        const attId = await insertAttachment(ctx.id, fx.PUBLISHER_ID, '示例发布者');
        const res = await apiCall('DELETE', `/api/collab/attachments/${attId}`, publisherToken);
        assert(res.status === 200, `T5 status=200, got ${res.status} body=${JSON.stringify(res.body).slice(0, 200)}`);
    }

    console.log('\n=== T6: failed 附件 + dev1 删 contact 上传的 → 403 ATTACHMENT_OWNER_LOCKED（闸门先于业务分支）===');
    {
        const ctx = await fx.createPendingFixture();
        createdFixtureIds.push(ctx.id);
        const attId = await insertAttachment(ctx.id, fx.CONTACT_ID, '示例用户A', 'result_script', 'failed');
        // 把 failed_attempt_seq 补上避免约束错
        await dbRun(`UPDATE collab_attachments SET failed_attempt_seq=1 WHERE id=?`, [attId]);
        const res = await apiCall('DELETE', `/api/collab/attachments/${attId}`, ctx.dev1Token);
        assert(res.status === 403, `T6 status=403, got ${res.status}`);
        assert(res.body && res.body.code === 'ATTACHMENT_OWNER_LOCKED',
            `T6 code=ATTACHMENT_OWNER_LOCKED（不是 FAILED_KEEP_FOR_AUDIT，证明闸门先生效）, got ${res.body && res.body.code}`);
    }

    console.log('\n=== T8: ARCHIVED + dev1 删 contact 上传的 → 403 ATTACHMENT_OWNER_LOCKED（闸门先于 isFinalArchived）===');
    {
        // codex 35 审 L-2 采纳：与 T6/T7 形成优先级三件套
        // - T6: failed 分支前 → 闸门优先返 OWNER_LOCKED 而非 FAILED_KEEP_FOR_AUDIT
        // - T7: 软删除守卫 → 优先于闸门，admin 也被拦
        // - T8: 归档锁定分支前 → 非 owner 走闸门 OWNER_LOCKED 而非 PARENT_ARCHIVED_LOCKED
        const ctx = await fx.createPendingFixture();
        createdFixtureIds.push(ctx.id);
        const attId = await insertAttachment(ctx.id, fx.CONTACT_ID, '示例用户A');
        // 推 ARCHIVED 终态（v1.67.1 isFinalArchived = status='ARCHIVED'）
        await fx.setCollabState(ctx.id, { status: 'ARCHIVED' });
        const res = await apiCall('DELETE', `/api/collab/attachments/${attId}`, ctx.dev1Token);
        assert(res.status === 403, `T8 status=403, got ${res.status}`);
        assert(res.body && res.body.code === 'ATTACHMENT_OWNER_LOCKED',
            `T8 code=ATTACHMENT_OWNER_LOCKED（不是 PARENT_ARCHIVED_LOCKED，证明闸门先生效）, got ${res.body && res.body.code}`);
    }

    console.log('\n=== T7: PARENT_SOFT_ARCHIVED + admin 删 → 409（软删除守卫先于闸门）===');
    {
        const ctx = await fx.createPendingFixture();
        createdFixtureIds.push(ctx.id);
        const attId = await insertAttachment(ctx.id, fx.CONTACT_ID, '示例用户A');
        // 仅设 archived_at = 软删除（v1.66.2 isSoftArchived 看 archived_at；status 留 PENDING）
        // 不能用 fx.setCollabState（allowedFields 不含 archived_at），直接 UPDATE
        await new Promise((resolve, reject) => {
            const db = new sqlite3.Database(DB_PATH);
            db.run(`UPDATE collab_requests SET archived_at=?, archived_reason=?, archived_by=? WHERE id=?`,
                [new Date().toISOString(), 'e2e test soft archive', 1, ctx.id],
                (e) => { db.close(); e ? reject(e) : resolve(); });
        });
        const res = await apiCall('DELETE', `/api/collab/attachments/${attId}`, ctx.adminToken);
        assert(res.status === 409, `T7 status=409, got ${res.status}`);
        assert(res.body && res.body.code === 'PARENT_SOFT_ARCHIVED',
            `T7 code=PARENT_SOFT_ARCHIVED（不是 ATTACHMENT_OWNER_LOCKED，证明软删除守卫先生效）, got ${res.body && res.body.code}`);
    }
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
        console.log(`\n== Summary: ${passed} pass / ${failed} fail ==`);
        process.exit(failed === 0 ? 0 : 1);
    }
})();
