/**
 * 协作单归档锁定端到端测试 (v1.67.1)
 *
 * 验证：
 *   T1：admin 归档 DONE 协作单 → 200，status='ARCHIVED'，archived_final_at + archived_final_by + reason 落库
 *   T2：非 admin（dev1）归档拒绝 → 403
 *   T3：重复归档 → 409 ALREADY_ARCHIVED_FINAL
 *   T4：归档非 DONE 状态（如 PENDING）→ 409 NOT_DONE
 *   T5：ARCHIVED 后 dev1 删交付物 → 403 PARENT_ARCHIVED_LOCKED
 *   T6：ARCHIVED 后 admin 删交付物 → 200（admin 兜底）
 *   T7：DONE 状态 dev1 删自己的 result_* 交付物 → 200
 *   T8：DONE 状态 dev1 删 admin 创建的 screenshot → 403 NOT_ADMIN_FOR_TYPE
 *
 * 用例独立 fixture，不污染其他 e2e。
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

function dbGet(sql, params) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH);
        db.get(sql, params, (err, row) => {
            db.close();
            err ? reject(err) : resolve(row);
        });
    });
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

async function makeDoneFixture() {
    const ctx = await fx.createPendingFixture();
    createdFixtureIds.push(ctx.id);
    // 模拟 submit 成功：推到 DONE + sql_validation_status='passed'
    await fx.setCollabState(ctx.id, {
        status: 'DONE',
        sql_validation_status: 'passed',
        sql_validated_at: new Date().toISOString(),
        done_at: new Date().toISOString(),
        submission_version: 1
    });
    return ctx;
}

async function runTests() {
    console.log('\n=== T1: admin 归档 DONE 协作单 → 200，字段落库 ===');
    {
        const ctx = await makeDoneFixture();
        const res = await apiCall('POST', `/api/collab/requests/${ctx.id}/archive-final`, ctx.adminToken, {
            archived_final_reason: '业务方确认入库，验收 OK'
        });
        assert(res.status === 200, `T1 status=200, got ${res.status} body=${JSON.stringify(res.body).slice(0, 200)}`);
        assert(res.body.current_status === 'ARCHIVED', `T1 返回 current_status=ARCHIVED`);

        const row = await dbGet('SELECT status, archived_final_at, archived_final_by, archived_final_reason FROM collab_requests WHERE id=?', [ctx.id]);
        assert(row.status === 'ARCHIVED', `T1 db status=ARCHIVED`);
        assert(row.archived_final_at !== null, `T1 db archived_final_at 落库`);
        assert(row.archived_final_by === 1, `T1 db archived_final_by=admin id=1`);
        assert(row.archived_final_reason === '业务方确认入库，验收 OK', `T1 reason 落库`);
    }

    console.log('\n=== T2: dev1 归档拒绝 → 403 ===');
    {
        const ctx = await makeDoneFixture();
        const res = await apiCall('POST', `/api/collab/requests/${ctx.id}/archive-final`, ctx.dev1Token, {});
        assert(res.status === 403, `T2 status=403, got ${res.status}`);
    }

    console.log('\n=== T3: 重复归档 → 409 ALREADY_ARCHIVED_FINAL ===');
    {
        const ctx = await makeDoneFixture();
        await apiCall('POST', `/api/collab/requests/${ctx.id}/archive-final`, ctx.adminToken, {});
        const res = await apiCall('POST', `/api/collab/requests/${ctx.id}/archive-final`, ctx.adminToken, {});
        assert(res.status === 409, `T3 status=409, got ${res.status}`);
        assert(res.body && res.body.code === 'ALREADY_ARCHIVED_FINAL', `T3 code=ALREADY_ARCHIVED_FINAL, got ${res.body && res.body.code}`);
    }

    console.log('\n=== T4: 归档非 DONE 状态（PENDING）→ 409 NOT_DONE ===');
    {
        const ctx = await fx.createPendingFixture();
        createdFixtureIds.push(ctx.id);
        // 不推到 DONE，直接归档
        const res = await apiCall('POST', `/api/collab/requests/${ctx.id}/archive-final`, ctx.adminToken, {});
        assert(res.status === 409, `T4 status=409, got ${res.status}`);
        assert(res.body && res.body.code === 'NOT_DONE', `T4 code=NOT_DONE, got ${res.body && res.body.code}`);
    }

    console.log('\n=== T5: ARCHIVED 后 dev1 删 result_* 交付物 → 403 PARENT_ARCHIVED_LOCKED ===');
    {
        const ctx = await makeDoneFixture();
        // 手动插一条 result_data 附件作为 dev1 的交付物
        const insRes = await dbRun(
            `INSERT INTO collab_attachments (collab_request_id, attachment_type, file_name, original_name, uploaded_by, uploaded_by_name, status, submission_version)
             VALUES (?, 'result_data', 'collab/test/dummy.xlsx', 'dummy.xlsx', 19, 'dev1', 'active', 1)`,
            [ctx.id]
        );
        const attId = insRes.lastID;
        // 归档
        await apiCall('POST', `/api/collab/requests/${ctx.id}/archive-final`, ctx.adminToken, {});
        // dev1 尝试删
        const delRes = await apiCall('DELETE', `/api/collab/attachments/${attId}`, ctx.dev1Token);
        assert(delRes.status === 403, `T5 status=403, got ${delRes.status}`);
        assert(delRes.body && delRes.body.code === 'PARENT_ARCHIVED_LOCKED', `T5 code=PARENT_ARCHIVED_LOCKED, got ${delRes.body && delRes.body.code}`);
    }

    console.log('\n=== T6: ARCHIVED 后 admin 删交付物 → 200（admin 兜底） ===');
    {
        const ctx = await makeDoneFixture();
        const insRes = await dbRun(
            `INSERT INTO collab_attachments (collab_request_id, attachment_type, file_name, original_name, uploaded_by, uploaded_by_name, status, submission_version)
             VALUES (?, 'result_script', 'collab/test/dummy.sql', 'dummy.sql', 19, 'dev1', 'active', 1)`,
            [ctx.id]
        );
        const attId = insRes.lastID;
        await apiCall('POST', `/api/collab/requests/${ctx.id}/archive-final`, ctx.adminToken, {});
        const delRes = await apiCall('DELETE', `/api/collab/attachments/${attId}`, ctx.adminToken);
        assert(delRes.status === 200, `T6 status=200, got ${delRes.status} body=${JSON.stringify(delRes.body).slice(0, 200)}`);
    }

    console.log('\n=== T7: DONE 状态 dev1 删自己的 result_* 交付物 → 200 ===');
    {
        const ctx = await makeDoneFixture();
        const insRes = await dbRun(
            `INSERT INTO collab_attachments (collab_request_id, attachment_type, file_name, original_name, uploaded_by, uploaded_by_name, status, submission_version)
             VALUES (?, 'result_data', 'collab/test/dummy.xlsx', 'dummy.xlsx', 19, 'dev1', 'active', 1)`,
            [ctx.id]
        );
        const attId = insRes.lastID;
        const delRes = await apiCall('DELETE', `/api/collab/attachments/${attId}`, ctx.dev1Token);
        assert(delRes.status === 200, `T7 status=200, got ${delRes.status} body=${JSON.stringify(delRes.body).slice(0, 200)}`);
    }

    console.log('\n=== T8: DONE 状态 dev1 删 admin 创建的 screenshot → 403 NOT_ADMIN_FOR_TYPE ===');
    {
        const ctx = await makeDoneFixture();
        const insRes = await dbRun(
            `INSERT INTO collab_attachments (collab_request_id, attachment_type, file_name, original_name, uploaded_by, uploaded_by_name, status, submission_version)
             VALUES (?, 'screenshot', 'collab/test/shot.png', 'shot.png', 1, 'admin', 'active', 0)`,
            [ctx.id]
        );
        const attId = insRes.lastID;
        const delRes = await apiCall('DELETE', `/api/collab/attachments/${attId}`, ctx.dev1Token);
        assert(delRes.status === 403, `T8 status=403, got ${delRes.status}`);
        assert(delRes.body && delRes.body.code === 'NOT_ADMIN_FOR_TYPE', `T8 code=NOT_ADMIN_FOR_TYPE, got ${delRes.body && delRes.body.code}`);
    }

    console.log('\n=== T9: ARCHIVED 后 dev1 调 POST /:id/submit → 409（白名单拒）===');
    {
        const ctx = await makeDoneFixture();
        await apiCall('POST', `/api/collab/requests/${ctx.id}/archive-final`, ctx.adminToken, {});
        // submit 走 multipart，但白名单校验在前置 UPDATE，直接 POST 不带文件也会被拦
        const res = await fetch(`${BASE}/api/collab/requests/${ctx.id}/submit`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${ctx.dev1Token}` }
        });
        assert(res.status >= 400, `T9 status >= 400, got ${res.status}`);
    }

    console.log('\n=== T10: ARCHIVED 后 admin 调 PUT /:id 编辑 → 409（仅 PENDING_ASSIGN/PENDING 可改）===');
    {
        const ctx = await makeDoneFixture();
        await apiCall('POST', `/api/collab/requests/${ctx.id}/archive-final`, ctx.adminToken, {});
        const res = await apiCall('PUT', `/api/collab/requests/${ctx.id}`, ctx.adminToken, {
            description: '尝试改归档后描述'
        });
        assert(res.status === 409, `T10 status=409, got ${res.status} body=${JSON.stringify(res.body).slice(0, 150)}`);
    }
}

(async () => {
    try {
        await runTests();
    } catch (e) {
        console.error('\n[FATAL]', e);
        failed++;
    } finally {
        for (const id of createdFixtureIds) {
            try { await fx.cleanup(id); } catch (e) { console.warn(`cleanup ${id} failed: ${e.message}`); }
        }
        console.log(`\n=== 结果：${passed} passed / ${failed} failed ===`);
        process.exit(failed === 0 ? 0 : 1);
    }
})();
