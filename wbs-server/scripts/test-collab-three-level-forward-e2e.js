/**
 * v1.71.0 三级转发 forward-to-exporter endpoint e2e（方案 §3 + §4 列表 + §5.3.5 可见性）
 *
 * 覆盖：
 *   T1: 成功转发 PENDING → EXPORTING（admin 触发）+ DB 字段落库 + operation_logs FORWARD_TO_EXPORTER + chat 已建
 *   T2: 当前 developer 转发 → 200（权限闸门 isCurrentDeveloper 通过）
 *   T3: 对接人 contact 转发 → 200（权限闸门 isContactPerson 通过）
 *   T4: 非 admin/非 dev/非 contact（publisher 越权）→ 403 NOT_FORWARDER
 *   T5: 状态守卫 — PENDING_ASSIGN 转发 → 409 INVALID_STATE_FOR_FORWARD
 *   T6: 状态守卫 — DONE 转发 → 409 INVALID_STATE_FOR_FORWARD
 *   T7: 不能转给自己（developer == exporter）→ 400 CANNOT_FORWARD_TO_SELF
 *   T8: 群未建（dingtalk_chat_id IS NULL）→ 409 CHAT_NOT_EXISTS
 *   T9: 软删除守卫 — archived_at 非空 → 409 PARENT_SOFT_ARCHIVED
 *   T10: 归档锁定守卫 — status=ARCHIVED → 409 PARENT_ARCHIVED_LOCKED
 *   T11: 入参校验 — exporter_id 非正整数 → 400 INVALID_EXPORTER_ID
 *   T12: 入参校验 — contact_user_ids 空数组 → 400 INVALID_CONTACT_USER_IDS
 *   T13: exporter 用户不存在 → 400 EXPORTER_NOT_FOUND
 *   T14: contact 用户不存在 → 400 CONTACT_USERS_NOT_FOUND
 *   T15: 列表 my_role=exporter → exporter 看到自己的 EXPORTING 单
 *   T16: 详情页可见性 — exporter 可读自己的 EXPORTING 单
 *   T17: 详情页可见性 — exporter 不可读非自己的单 → 403
 *   T18: 事务原子性 — UPDATE 失败时 INSERT log 也不落
 *   T19: 沟通对象含已停用用户 → 400 CONTACT_USERS_INACTIVE（方案 §7.3 F03）
 *
 * 注：钉钉副作用在本地无 dingtalk_user_id/phone 会失败，但因 try/catch 包裹不阻塞主流程
 *     T1/T2/T3 仅验证主流程（DB 状态 + 日志），钉钉副作用日志不强断言
 */
'use strict';

const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fx = require('./_test-fixture');

const BASE = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');

const createdFixtureIds = [];

// codex 36 审 L-2 修复：保存 EXPORTER 原始 dingtalk_user_id，cleanup 时按 user id 精确恢复
// 避免"测试中断 / 真实环境同名占位值"等场景下污染或误删数据
let _exporterOriginalDingUid = undefined;  // undefined = 未读取；null = 原本就是 NULL
let _exporterDingUidModified = false;       // 标记是否修改过（避免重复 save/恢复）

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
    if (!_exporterDingUidModified) return;  // 没改过，跳过
    // 精确恢复原值（无论原值是 NULL 还是真实值）
    await dbRun(`UPDATE users SET dingtalk_user_id = ? WHERE id = ?`, [_exporterOriginalDingUid, fx.EXPORTER_ID]);
    _exporterDingUidModified = false;
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
        db.run(sql, params, function (err) {
            db.close();
            err ? rej(err) : res({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function dbGet(sql, params) {
    return new Promise((res, rej) => {
        const db = new sqlite3.Database(DB_PATH);
        db.get(sql, params, (err, row) => {
            db.close();
            err ? rej(err) : res(row);
        });
    });
}

function dbAll(sql, params) {
    return new Promise((res, rej) => {
        const db = new sqlite3.Database(DB_PATH);
        db.all(sql, params, (err, rows) => {
            db.close();
            err ? rej(err) : res(rows);
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

/**
 * 造一个"具备 forward 前置条件"的 fixture：
 *   - createPendingFixture（PENDING + dev=dev1）
 *   - 临时给 EXPORTER 写一个假 dingtalk_user_id（让前置校验通过；钉钉副作用失败不阻塞）
 *   - UPDATE dingtalk_chat_id + dingtalk_open_conversation_id（模拟用户已点拉群）
 */
async function makeForwardableFixture() {
    const ctx = await fx.createPendingFixture();
    createdFixtureIds.push(ctx.id);
    await ensureExporterFakeDingUid();
    // 模拟用户已拉群
    const fakeChatId = `chat_e2e_${Date.now()}`;
    const fakeOpenConvId = `cidp_e2e_${Date.now()}`;
    await dbRun(
        `UPDATE collab_requests
            SET dingtalk_chat_id = ?, dingtalk_open_conversation_id = ?
          WHERE id = ?`,
        [fakeChatId, fakeOpenConvId, ctx.id]
    );
    return { ...ctx, fakeChatId };
}

async function makeFixtureWithoutChat() {
    const ctx = await fx.createPendingFixture();
    createdFixtureIds.push(ctx.id);
    await ensureExporterFakeDingUid();
    return ctx;
}

async function runTests() {
    const publisherToken = await fx.signAs(fx.PUBLISHER_ID);
    const exporterToken = await fx.signAs(fx.EXPORTER_ID);

    console.log('\n=== T1: admin 转发 PENDING → EXPORTING ===');
    {
        const ctx = await makeForwardableFixture();
        const res = await apiCall('POST', `/api/collab/requests/${ctx.id}/forward-to-exporter`, ctx.adminToken, {
            exporter_id: fx.EXPORTER_ID,
            contact_user_ids: [fx.CONTACT_ID]
        });
        assert(res.status === 200, `T1 status=200, got ${res.status} body=${JSON.stringify(res.body).slice(0, 200)}`);
        assert(res.body && res.body.current_status === 'EXPORTING', `T1 返回 current_status=EXPORTING`);
        assert(res.body && res.body.exporter_id === fx.EXPORTER_ID, `T1 返回 exporter_id=${fx.EXPORTER_ID}`);

        const row = await dbGet(
            `SELECT status, exporter_user_id, exporter_name, exporter_assigned_at, forwarded_to_exporter_at
               FROM collab_requests WHERE id=?`,
            [ctx.id]
        );
        assert(row.status === 'EXPORTING', `T1 db status=EXPORTING`);
        assert(row.exporter_user_id === fx.EXPORTER_ID, `T1 db exporter_user_id=${fx.EXPORTER_ID}`);
        assert(row.exporter_name && row.exporter_name.length > 0, `T1 db exporter_name 非空: ${row.exporter_name}`);
        assert(row.exporter_assigned_at !== null, `T1 db exporter_assigned_at 落库`);
        assert(row.forwarded_to_exporter_at !== null, `T1 db forwarded_to_exporter_at 落库`);

        const log = await dbGet(
            `SELECT operation_type, operator_id, reason FROM collab_operation_logs
              WHERE collab_request_id=? AND operation_type='FORWARD_TO_EXPORTER'`,
            [ctx.id]
        );
        assert(log && log.operator_id === fx.ADMIN_ID, `T1 log FORWARD_TO_EXPORTER 落库 by admin`);
        const reasonJson = JSON.parse(log.reason);
        assert(reasonJson.exporter_id === fx.EXPORTER_ID
            && Array.isArray(reasonJson.contact_user_ids)
            && reasonJson.contact_user_ids.includes(fx.CONTACT_ID),
            `T1 log reason JSON 含 exporter_id + contact_user_ids`);
    }

    console.log('\n=== T2: 当前 developer (dev1) 转发 → 200 ===');
    {
        const ctx = await makeForwardableFixture();
        const res = await apiCall('POST', `/api/collab/requests/${ctx.id}/forward-to-exporter`, ctx.dev1Token, {
            exporter_id: fx.EXPORTER_ID,
            contact_user_ids: [fx.CONTACT_ID]
        });
        assert(res.status === 200, `T2 status=200, got ${res.status} body=${JSON.stringify(res.body).slice(0, 200)}`);
    }

    console.log('\n=== T3: 对接人 contact 转发 → 200 ===');
    {
        const ctx = await makeForwardableFixture();
        const res = await apiCall('POST', `/api/collab/requests/${ctx.id}/forward-to-exporter`, ctx.contactToken, {
            exporter_id: fx.EXPORTER_ID,
            contact_user_ids: [fx.DEV1_ID]
        });
        assert(res.status === 200, `T3 status=200, got ${res.status} body=${JSON.stringify(res.body).slice(0, 200)}`);
    }

    console.log('\n=== T4: publisher 越权转发 → 403 NOT_FORWARDER ===');
    {
        const ctx = await makeForwardableFixture();
        const res = await apiCall('POST', `/api/collab/requests/${ctx.id}/forward-to-exporter`, publisherToken, {
            exporter_id: fx.EXPORTER_ID,
            contact_user_ids: [fx.CONTACT_ID]
        });
        assert(res.status === 403, `T4 status=403, got ${res.status}`);
        assert(res.body && res.body.code === 'NOT_FORWARDER', `T4 code=NOT_FORWARDER`);
    }

    console.log('\n=== T5: 状态守卫 — PENDING_ASSIGN 转发 → 409 INVALID_STATE_FOR_FORWARD ===');
    {
        const ctx = await fx.createPendingFixture();
        createdFixtureIds.push(ctx.id);
        await ensureExporterFakeDingUid();
        // 推回 PENDING_ASSIGN（默认 createPendingFixture 已 assign 到 PENDING）
        await fx.setCollabState(ctx.id, { status: 'PENDING_ASSIGN' });
        // 设 chat 以排除 CHAT_NOT_EXISTS 干扰
        await dbRun(
            `UPDATE collab_requests SET dingtalk_chat_id = ?, dingtalk_open_conversation_id = ? WHERE id = ?`,
            [`chat_e2e_${Date.now()}`, `cidp_e2e_${Date.now()}`, ctx.id]
        );
        const res = await apiCall('POST', `/api/collab/requests/${ctx.id}/forward-to-exporter`, ctx.adminToken, {
            exporter_id: fx.EXPORTER_ID,
            contact_user_ids: [fx.CONTACT_ID]
        });
        assert(res.status === 409, `T5 status=409, got ${res.status}`);
        assert(res.body && res.body.code === 'INVALID_STATE_FOR_FORWARD', `T5 code=INVALID_STATE_FOR_FORWARD, got ${res.body && res.body.code}`);
    }

    console.log('\n=== T6: 状态守卫 — DONE 转发 → 409 INVALID_STATE_FOR_FORWARD ===');
    {
        const ctx = await makeForwardableFixture();
        await fx.setCollabState(ctx.id, { status: 'DONE' });
        const res = await apiCall('POST', `/api/collab/requests/${ctx.id}/forward-to-exporter`, ctx.adminToken, {
            exporter_id: fx.EXPORTER_ID,
            contact_user_ids: [fx.CONTACT_ID]
        });
        assert(res.status === 409, `T6 status=409, got ${res.status}`);
        assert(res.body && res.body.code === 'INVALID_STATE_FOR_FORWARD', `T6 code=INVALID_STATE_FOR_FORWARD`);
    }

    console.log('\n=== T7: 不能转给自己（developer == exporter）→ 400 CANNOT_FORWARD_TO_SELF ===');
    {
        const ctx = await makeForwardableFixture();
        // ctx.dev1Token = dev id=19；让 exporter_id = developer_id
        const res = await apiCall('POST', `/api/collab/requests/${ctx.id}/forward-to-exporter`, ctx.dev1Token, {
            exporter_id: fx.DEV1_ID,  // 即 dev1
            contact_user_ids: [fx.CONTACT_ID]
        });
        assert(res.status === 400, `T7 status=400, got ${res.status}`);
        assert(res.body && res.body.code === 'CANNOT_FORWARD_TO_SELF', `T7 code=CANNOT_FORWARD_TO_SELF`);
    }

    console.log('\n=== T8: 群未建（dingtalk_chat_id IS NULL）→ 409 CHAT_NOT_EXISTS ===');
    {
        const ctx = await makeFixtureWithoutChat();
        const res = await apiCall('POST', `/api/collab/requests/${ctx.id}/forward-to-exporter`, ctx.adminToken, {
            exporter_id: fx.EXPORTER_ID,
            contact_user_ids: [fx.CONTACT_ID]
        });
        assert(res.status === 409, `T8 status=409, got ${res.status}`);
        assert(res.body && res.body.code === 'CHAT_NOT_EXISTS', `T8 code=CHAT_NOT_EXISTS`);
    }

    console.log('\n=== T9: 软删除守卫 — archived_at 非空 → 409 PARENT_SOFT_ARCHIVED ===');
    {
        const ctx = await makeForwardableFixture();
        await dbRun(
            `UPDATE collab_requests SET archived_at=?, archived_reason=?, archived_by=? WHERE id=?`,
            [new Date().toISOString(), 'e2e soft archive', 1, ctx.id]
        );
        const res = await apiCall('POST', `/api/collab/requests/${ctx.id}/forward-to-exporter`, ctx.adminToken, {
            exporter_id: fx.EXPORTER_ID,
            contact_user_ids: [fx.CONTACT_ID]
        });
        assert(res.status === 409, `T9 status=409, got ${res.status}`);
        assert(res.body && res.body.code === 'PARENT_SOFT_ARCHIVED', `T9 code=PARENT_SOFT_ARCHIVED`);
    }

    console.log('\n=== T10: 归档锁定守卫 — status=ARCHIVED → 409 PARENT_ARCHIVED_LOCKED ===');
    {
        const ctx = await makeForwardableFixture();
        await fx.setCollabState(ctx.id, { status: 'ARCHIVED' });
        const res = await apiCall('POST', `/api/collab/requests/${ctx.id}/forward-to-exporter`, ctx.adminToken, {
            exporter_id: fx.EXPORTER_ID,
            contact_user_ids: [fx.CONTACT_ID]
        });
        assert(res.status === 409, `T10 status=409, got ${res.status}`);
        assert(res.body && res.body.code === 'PARENT_ARCHIVED_LOCKED', `T10 code=PARENT_ARCHIVED_LOCKED`);
    }

    console.log('\n=== T11: 入参校验 — exporter_id 非正整数 → 400 INVALID_EXPORTER_ID ===');
    {
        const ctx = await makeForwardableFixture();
        const res = await apiCall('POST', `/api/collab/requests/${ctx.id}/forward-to-exporter`, ctx.adminToken, {
            exporter_id: 'abc',
            contact_user_ids: [fx.CONTACT_ID]
        });
        assert(res.status === 400, `T11 status=400, got ${res.status}`);
        assert(res.body && res.body.code === 'INVALID_EXPORTER_ID', `T11 code=INVALID_EXPORTER_ID`);
    }

    console.log('\n=== T12: 入参校验 — contact_user_ids 空数组 → 400 INVALID_CONTACT_USER_IDS ===');
    {
        const ctx = await makeForwardableFixture();
        const res = await apiCall('POST', `/api/collab/requests/${ctx.id}/forward-to-exporter`, ctx.adminToken, {
            exporter_id: fx.EXPORTER_ID,
            contact_user_ids: []
        });
        assert(res.status === 400, `T12 status=400, got ${res.status}`);
        assert(res.body && res.body.code === 'INVALID_CONTACT_USER_IDS', `T12 code=INVALID_CONTACT_USER_IDS`);
    }

    console.log('\n=== T13: exporter 用户不存在 → 400 EXPORTER_NOT_FOUND ===');
    {
        const ctx = await makeForwardableFixture();
        const res = await apiCall('POST', `/api/collab/requests/${ctx.id}/forward-to-exporter`, ctx.adminToken, {
            exporter_id: 999999,
            contact_user_ids: [fx.CONTACT_ID]
        });
        assert(res.status === 400, `T13 status=400, got ${res.status}`);
        assert(res.body && res.body.code === 'EXPORTER_NOT_FOUND', `T13 code=EXPORTER_NOT_FOUND`);
    }

    console.log('\n=== T14: contact 用户不存在 → 400 CONTACT_USERS_NOT_FOUND ===');
    {
        const ctx = await makeForwardableFixture();
        const res = await apiCall('POST', `/api/collab/requests/${ctx.id}/forward-to-exporter`, ctx.adminToken, {
            exporter_id: fx.EXPORTER_ID,
            contact_user_ids: [999998]
        });
        assert(res.status === 400, `T14 status=400, got ${res.status}`);
        assert(res.body && res.body.code === 'CONTACT_USERS_NOT_FOUND', `T14 code=CONTACT_USERS_NOT_FOUND`);
    }

    console.log('\n=== T15: 列表 my_role=exporter → exporter 看到自己的 EXPORTING 单 ===');
    {
        const ctx = await makeForwardableFixture();
        // 先转发让单进入 EXPORTING
        await apiCall('POST', `/api/collab/requests/${ctx.id}/forward-to-exporter`, ctx.adminToken, {
            exporter_id: fx.EXPORTER_ID,
            contact_user_ids: [fx.CONTACT_ID]
        });
        // 用 exporter token 调列表
        const listRes = await apiCall('GET', '/api/collab/requests?my_role=exporter', exporterToken, null);
        assert(listRes.status === 200, `T15 list status=200, got ${listRes.status}`);
        const ours = (listRes.body || []).find(r => r.id === ctx.id);
        assert(ours, `T15 列表含本次 fixture id=${ctx.id}`);
        assert(ours && ours.status === 'EXPORTING', `T15 列表中本单 status=EXPORTING`);
        assert(ours && ours.exporter_user_id === fx.EXPORTER_ID, `T15 列表中 exporter_user_id 正确`);
    }

    console.log('\n=== T16: 详情页可见性 — exporter 可读自己的 EXPORTING 单 ===');
    {
        const ctx = await makeForwardableFixture();
        await apiCall('POST', `/api/collab/requests/${ctx.id}/forward-to-exporter`, ctx.adminToken, {
            exporter_id: fx.EXPORTER_ID,
            contact_user_ids: [fx.CONTACT_ID]
        });
        const detailRes = await apiCall('GET', `/api/collab/requests/${ctx.id}`, exporterToken, null);
        assert(detailRes.status === 200, `T16 detail status=200, got ${detailRes.status}`);
        assert(detailRes.body && detailRes.body.id === ctx.id, `T16 详情含本单 id`);
    }

    console.log('\n=== T17: 详情页可见性 — exporter 不可读非自己的单 → 403 ===');
    {
        const ctx = await fx.createPendingFixture();
        createdFixtureIds.push(ctx.id);
        // 此单未 forward，exporter_user_id IS NULL，exporter 不在权限内
        const detailRes = await apiCall('GET', `/api/collab/requests/${ctx.id}`, exporterToken, null);
        assert(detailRes.status === 403, `T17 detail status=403, got ${detailRes.status}`);
        assert(detailRes.body && detailRes.body.code === 'FORBIDDEN', `T17 code=FORBIDDEN`);
    }

    console.log('\n=== T18: 并发原子性 — collabExporterTransitionMutex 串行化（codex 36 H-1 + 37 H-1 改名）===');
    {
        // codex 36 审 H-1 修复后稳定预期：
        //   - 1 个 200 success → status=EXPORTING + log 1 条
        //   - 1 个 409 CONCURRENT_STATE_CHANGE（mutex 释放后第二请求重新读到已 EXPORTING 走状态守卫拒）
        //   - 日志恰好 1 条 FORWARD_TO_EXPORTER（事务原子性 + mutex 串行化）
        const ctx = await makeForwardableFixture();
        const [res1, res2] = await Promise.all([
            apiCall('POST', `/api/collab/requests/${ctx.id}/forward-to-exporter`, ctx.adminToken, {
                exporter_id: fx.EXPORTER_ID,
                contact_user_ids: [fx.CONTACT_ID]
            }),
            apiCall('POST', `/api/collab/requests/${ctx.id}/forward-to-exporter`, ctx.adminToken, {
                exporter_id: fx.EXPORTER_ID,
                contact_user_ids: [fx.CONTACT_ID]
            })
        ]);
        console.log(`     debug T18 res1=${res1.status}/${res1.body && res1.body.code || ''}, res2=${res2.status}/${res2.body && res2.body.code || ''}`);

        // 强断言 1：1 个 200 + 1 个 409 INVALID_STATE_FOR_FORWARD
        // （注：mutex 释放后第二请求重新走状态守卫，此时 status 已是 EXPORTING，走 INVALID_STATE_FOR_FORWARD 而非 CONCURRENT_STATE_CHANGE）
        const okCount = [res1, res2].filter(r => r.status === 200).length;
        const conflictCount = [res1, res2].filter(r =>
            r.status === 409 && r.body && (r.body.code === 'INVALID_STATE_FOR_FORWARD' || r.body.code === 'CONCURRENT_STATE_CHANGE')
        ).length;
        assert(okCount === 1, `T18 并发 2 个 forward 仅 1 个 200 成功（mutex 串行化），got okCount=${okCount}`);
        assert(conflictCount === 1, `T18 另一个返 409（INVALID_STATE_FOR_FORWARD 或 CONCURRENT_STATE_CHANGE），got conflictCount=${conflictCount}`);

        // 强断言 2：日志恰好 1 条 FORWARD_TO_EXPORTER（事务原子性证据）
        const logs = await dbAll(
            `SELECT id FROM collab_operation_logs WHERE collab_request_id=? AND operation_type='FORWARD_TO_EXPORTER'`,
            [ctx.id]
        );
        assert(logs.length === 1, `T18 日志恰好 1 条 FORWARD_TO_EXPORTER（mutex + 事务原子性），got ${logs.length}`);

        // 强断言 3：最终状态 EXPORTING + exporter_user_id 落库（一致性证据）
        const finalRow = await dbGet(
            `SELECT status, exporter_user_id FROM collab_requests WHERE id=?`,
            [ctx.id]
        );
        assert(finalRow.status === 'EXPORTING', `T18 最终 status=EXPORTING，got ${finalRow.status}`);
        assert(finalRow.exporter_user_id === fx.EXPORTER_ID, `T18 最终 exporter_user_id=${fx.EXPORTER_ID}，got ${finalRow.exporter_user_id}`);
    }

    console.log('\n=== T19: 沟通对象含已停用用户 → 400 CONTACT_USERS_INACTIVE（方案 §7.3 F03）===');
    {
        // 步骤：① 临时把一个 user disable ② 用其 id 作为 contact ③ 还原
        // 选 PUBLISHER_ID（id=7）做临时 disable（不影响其他 e2e，因 forward fixture 不依赖 publisher 状态）
        const targetUid = fx.PUBLISHER_ID;
        const before = await dbGet(`SELECT status FROM users WHERE id=?`, [targetUid]);
        await dbRun(`UPDATE users SET status='disabled' WHERE id=?`, [targetUid]);
        try {
            const ctx = await fx.createPendingFixture();
            createdFixtureIds.push(ctx.id);
            await ensureExporterFakeDingUid();
            await dbRun(
                `UPDATE collab_requests SET dingtalk_chat_id=?, dingtalk_open_conversation_id=? WHERE id=?`,
                [`chat_e2e_${Date.now()}_${Math.random()}`, `cidp_e2e_${Date.now()}_${Math.random()}`, ctx.id]
            );
            const res = await apiCall('POST', `/api/collab/requests/${ctx.id}/forward-to-exporter`, ctx.adminToken, {
                exporter_id: fx.EXPORTER_ID,
                contact_user_ids: [fx.CONTACT_ID, targetUid]  // CONTACT_ID 是 active，targetUid 已 disabled
            });
            assert(res.status === 400, `T19 status=400, got ${res.status}`);
            assert(res.body && res.body.code === 'CONTACT_USERS_INACTIVE', `T19 code=CONTACT_USERS_INACTIVE, got ${res.body && res.body.code}`);
        } finally {
            // 还原状态（无论测试成功失败都要还原，避免污染其他 e2e）
            await dbRun(`UPDATE users SET status=? WHERE id=?`, [before.status, targetUid]);
        }
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
        // codex 36 审 L-2 修复：按 user id 精确恢复 EXPORTER 原始 dingtalk_user_id
        try { await restoreExporterDingUid(); } catch (e) { console.error('restore EXPORTER ding uid failed:', e.message); }
        console.log(`\n== Summary: ${passed} pass / ${failed} fail ==`);
        process.exit(failed === 0 ? 0 : 1);
    }
})();
