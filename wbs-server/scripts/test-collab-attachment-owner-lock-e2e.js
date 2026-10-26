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

const fx = require('./_test-fixture');

// [#106 S4c-A1] 被测服务 / 实例库来自 test-env：在 ready() 之后才赋值，不再写死 3000 与业务库路径
let BASE = null;
let DB_PATH = null;

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

async function dbRun(sql, params) {
    const db = await fx.openInstanceDb(DB_PATH);
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            const out = err ? null : { lastID: this.lastID, changes: this.changes };
            // 等 close 回调再落定：关库错误不丢，resolve 时句柄已关闭（语句错误优先）
            db.close((cerr) => { const e = err || cerr; e ? reject(e) : resolve(out); });
        });
    });
}

async function dbGet(sql, params) {
    const db = await fx.openInstanceDb(DB_PATH);
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            db.close((cerr) => { const e = err || cerr; e ? reject(e) : resolve(row); });
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
        const softDb = await fx.openInstanceDb(DB_PATH);   // [#106 S4c 收口] 带打开回调、不建空库（同 fx.openInstanceDb）
        await new Promise((resolve, reject) => {
            const db = softDb;
            db.run(`UPDATE collab_requests SET archived_at=?, archived_reason=?, archived_by=? WHERE id=?`,
                [new Date().toISOString(), 'e2e test soft archive', 1, ctx.id],
                (e) => { db.close((cerr) => { const err = e || cerr; err ? reject(err) : resolve(); }); });
        });
        const res = await apiCall('DELETE', `/api/collab/attachments/${attId}`, ctx.adminToken);
        assert(res.status === 409, `T7 status=409, got ${res.status}`);
        assert(res.body && res.body.code === 'PARENT_SOFT_ARCHIVED',
            `T7 code=PARENT_SOFT_ARCHIVED（不是 ATTACHMENT_OWNER_LOCKED，证明软删除守卫先生效）, got ${res.body && res.body.code}`);
    }
}

(async () => {
    // ready() 在 try 之外、入口函数的第一条有副作用的语句：失败直接落到末尾 .catch（非零退出）
    await fx.ready();   // 先于任何写库 / 网络请求：自起隔离实例（或核对 TEST_* 变量组）
    try {
        BASE = fx.BASE;
        DB_PATH = fx.DB_PATH;
        await runTests();
    } catch (e) {
        console.error('\n!! e2e 运行异常：', e.message, e.stack);
        failed++;
    } finally {
        // [#106 S4c 收口] 夹具清理逐个 try/catch：只移除清理成功的编号，剩余编号再试一轮；仍遗留的每个计 1 次失败，不中断后续清理与 teardown
        for (let round = 0; round < 2 && createdFixtureIds.length > 0; round++) {
            if (round > 0) await new Promise((r) => setTimeout(r, 200));   // [#106 S4c 送审前小修] 两轮之间等 200ms：防服务端事务外异步回写偶发 SQLITE_BUSY 被计失败
            for (const id of createdFixtureIds.slice()) {
                try { await fx.cleanup(id); createdFixtureIds.splice(createdFixtureIds.indexOf(id), 1); } catch (e) { console.error(`cleanup ${id} failed (第 ${round + 1} 轮): ${e.message}`); }
            }
        }
        if (createdFixtureIds.length > 0) { console.error(`夹具清理失败，遗留协作单 id=${createdFixtureIds.join(',')}`); failed += createdFixtureIds.length; }
        try { await fx.teardown(); } catch (e) { console.error(`teardown 失败：${e.message}`); failed++; }
    }
    console.log(`\n== Summary: ${passed} pass / ${failed} fail ==`);
    fx.finish(failed === 0 ? 0 : 1);   // teardown 已落定；只设退出码（见 lib/test-env.js finish），不在 finally 里调
})().catch(async (e) => {
    console.error('owner-lock e2e 启动失败：', e && e.stack || e);
    try { await fx.teardown(); } catch (_) { /* 已在报错路径 */ }
    process.exit(1);
});
