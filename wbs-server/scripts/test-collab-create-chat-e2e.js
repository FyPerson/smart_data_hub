/**
 * 协作单拉起钉钉沟通群端到端测试（v1.69.0）
 *
 * 验证范围：前置校验路径（404 / 403 / 409 / 400）
 *   T1：admin 触发已归档单 → 409 ALREADY_ARCHIVED_FINAL
 *   T2：admin 触发已作废单 → 409 ALREADY_SOFT_ARCHIVED
 *   T3：路人（dev1 不在协作单上）触发 → 403 NOT_ALLOWED
 *   T4：id 非法 → 400 INVALID_ID
 *   T5：协作单不存在 → 404
 *   T6：已有群幂等（手动塞 dingtalk_open_conversation_id 后再调）→ 200 + idempotent=true
 *
 * 钉钉真连成功路径不在 e2e 内（每跑一次会真建一个群且无 disband API），
 * 由手动脚本 probe-dingtalk-chat-create.js + 生产真实业务触发验证。
 */
'use strict';

const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fx = require('./_test-fixture');

const BASE = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');

const createdFixtureIds = [];

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
    console.log('\n=== T1: 已归档单（ARCHIVED）触发拉群 → 409 ALREADY_ARCHIVED_FINAL ===');
    {
        const ctx = await makeDoneFixture();
        // 推到 ARCHIVED
        await fx.apiCall('POST', `/api/collab/requests/${ctx.id}/archive-final`, ctx.adminToken, {});
        const res = await fx.apiCall('POST', `/api/collab/requests/${ctx.id}/create-chat`, ctx.adminToken, {});
        assert(res.status === 409, `T1 status=409, got ${res.status}`);
        assert(res.body && res.body.code === 'ALREADY_ARCHIVED_FINAL', `T1 code=ALREADY_ARCHIVED_FINAL, got ${res.body && res.body.code}`);
    }

    console.log('\n=== T2: 已作废单（archived_at）触发拉群 → 409 ALREADY_SOFT_ARCHIVED ===');
    {
        const ctx = await fx.createPendingFixture();
        createdFixtureIds.push(ctx.id);
        await dbRun('UPDATE collab_requests SET archived_at = datetime(\'now\',\'localtime\'), archived_reason = \'test\' WHERE id = ?', [ctx.id]);
        const res = await fx.apiCall('POST', `/api/collab/requests/${ctx.id}/create-chat`, ctx.adminToken, {});
        assert(res.status === 409, `T2 status=409, got ${res.status}`);
        assert(res.body && res.body.code === 'ALREADY_SOFT_ARCHIVED', `T2 code=ALREADY_SOFT_ARCHIVED, got ${res.body && res.body.code}`);
    }

    console.log('\n=== T3: 路人触发（dev1 不是当前协作单的 developer 也不是对接人）→ 403 ===');
    {
        // 构造一个 dev1 不参与的协作单（不指派 dev1，状态停 PENDING_ASSIGN）
        const adminToken = await fx.signAs(fx.ADMIN_ID);
        const oaNo = `OA_PERM_${Date.now()}`;
        const createRes = await fx.apiCall('POST', '/api/collab/requests', adminToken, {
            oa_request_no: oaNo,
            requester_dept: '市场营销部',
            requester_name: 'perm-test',
            description: 'perm test no dev1',
            deadline: '2026-12-31 18:00:00',
            contact_person_id: fx.CONTACT_ID,  // 示例用户A对接，但 dev1 不参与
            target_db_connection_id: fx.TARGET_DB_CONN_ID
        });
        const id = createRes.body && createRes.body.id;
        if (!id) {
            console.log('  ✗ T3 创建协作单失败:', JSON.stringify(createRes.body).slice(0, 200));
            failed++;
            return;
        }
        createdFixtureIds.push(id);
        const dev1Token = await fx.signAs(fx.DEV1_ID);
        const res = await fx.apiCall('POST', `/api/collab/requests/${id}/create-chat`, dev1Token, {});
        assert(res.status === 403, `T3 status=403, got ${res.status} body=${JSON.stringify(res.body).slice(0, 150)}`);
        assert(res.body && res.body.code === 'NOT_ALLOWED', `T3 code=NOT_ALLOWED`);
    }

    console.log('\n=== T4: id 非法 → 400 INVALID_ID ===');
    {
        const adminToken = await fx.signAs(fx.ADMIN_ID);
        const res = await fx.apiCall('POST', `/api/collab/requests/abc/create-chat`, adminToken, {});
        assert(res.status === 400, `T4 status=400, got ${res.status}`);
        assert(res.body && res.body.code === 'INVALID_ID', `T4 code=INVALID_ID`);
    }

    console.log('\n=== T5: 协作单不存在 → 404 ===');
    {
        const adminToken = await fx.signAs(fx.ADMIN_ID);
        const res = await fx.apiCall('POST', `/api/collab/requests/9999999/create-chat`, adminToken, {});
        assert(res.status === 404, `T5 status=404, got ${res.status}`);
    }

    console.log('\n=== T6: 幂等（已有群）→ 200 + idempotent=true ===');
    {
        const ctx = await fx.createPendingFixture();
        createdFixtureIds.push(ctx.id);
        // 直接塞个伪 chatid + openConvId（模拟此前已成功建群）
        await dbRun(
            `UPDATE collab_requests
                SET dingtalk_chat_id = ?,
                    dingtalk_open_conversation_id = ?,
                    dingtalk_chat_created_at = datetime('now','localtime'),
                    dingtalk_chat_created_by = ?,
                    dingtalk_chat_name = ?
              WHERE id = ?`,
            ['fake_chatid_xxx', 'fake_openconv_xxx', 1, '[OA-test] fx', ctx.id]
        );
        const res = await fx.apiCall('POST', `/api/collab/requests/${ctx.id}/create-chat`, ctx.adminToken, {});
        assert(res.status === 200, `T6 status=200, got ${res.status}`);
        assert(res.body && res.body.idempotent === true, `T6 idempotent=true`);
        assert(res.body && res.body.chat_id === 'fake_chatid_xxx', `T6 返回旧 chatid`);
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
        console.log(`\n=== 总计: ${passed} passed, ${failed} failed ===`);
        process.exit(failed > 0 ? 1 : 0);
    }
})();
