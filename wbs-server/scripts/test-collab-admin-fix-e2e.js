/**
 * admin-fix endpoint e2e（v1.70.0 Step 3，方案 §3-A）
 *
 * 用法：node scripts/test-collab-admin-fix-e2e.js
 * 前置：本地 server 已启动（localhost:3000）
 *
 * 8 个用例：
 *   T1 admin 改 target_db_connection_id + reason → 200 + 字段变更 + sql_validation_error 清空
 *   T2 dev1（非 admin）调 admin-fix → 403
 *   T3 reason 太短 (< 10) → 400 REASON_TOO_SHORT
 *   T4 developer_id=0 → 400 FIELD_VALIDATION_FAILED（codex 二审 #7）
 *   T5 DONE 状态调 admin-fix → 409 TERMINAL_STATE_PROTECTED
 *   T6 改非白名单字段（status / submission_version）→ 400 FIELD_NOT_ALLOWED
 *   T7 PENDING_ASSIGN 改 developer_id → 409 FIELD_STATUS_NOT_ALLOWED
 *   T8 GET allowed-fields?status=SUBMITTED → 返 5 字段；?status=PENDING_ASSIGN → 返 4 字段（无 developer_id）
 *
 * 每个测试独立 fixture，避免状态串扰
 */

'use strict';

const fx = require('./_test-fixture');

const createdFixtureIds = [];

async function adminFix(token, id, body) {
    return fx.apiCall('POST', `/api/collab/requests/${id}/admin-fix`, token, body);
}

async function getAllowedFields(token, status) {
    return fx.apiCall('GET', `/api/collab/admin-fix/allowed-fields?status=${encodeURIComponent(status)}`, token);
}

// v1.70.3 archive endpoint helper（业务需求变更：admin 任何非 ARCHIVED 都可作废）
async function archive(token, id, body) {
    return fx.apiCall('POST', `/api/collab/requests/${id}/archive`, token, body || {});
}

const tests = [];

function test(name, fn) {
    tests.push({ name, fn });
}

// ============================================================================
// T1 admin 改 description + reason → 200 + 字段变更 + sql_error 清空
//    模拟 5/21 OA-364265 场景（SUBMITTED + failed），但改 description 而非 target_db
//    （生产环境 source 库通常只配 1 个 BMS，无法测改到另一个 id；改字段类型测试在 T1）
// ============================================================================
test('T1 admin 改 description → 200 + 字段变更 + sql_validation 清空', async () => {
    const ctx = await fx.createPendingFixture();
    createdFixtureIds.push(ctx.id);

    // 推到 SUBMITTED + failed（模拟 5/21 OA-364265 场景）
    await fx.setCollabState(ctx.id, {
        status: 'SUBMITTED',
        sql_validation_status: 'failed',
        sql_validation_error: '业务库连接失败：目标库不存在',
        submitted_at: '2026-05-22 14:00:00',
        submission_version: 1,
    });

    // admin-fix 改 description（业务字段不依赖 source 库存在）
    const newDesc = '管理员修正后的描述（含新业务范围说明）';
    const r = await adminFix(ctx.adminToken, ctx.id, {
        changes: { description: newDesc },
        reason: '业务方追加了新的描述细节，请开发按新描述重传',
    });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    if (!r.body.success) throw new Error(`success != true`);
    if (r.body.collab.description !== newDesc) throw new Error(`description 未变更：${r.body.collab.description}`);
    if (r.body.collab.sql_validation_error !== null) throw new Error(`sql_validation_error 未清空：${r.body.collab.sql_validation_error}`);
    if (r.body.collab.sql_validation_status !== null) throw new Error(`sql_validation_status 未清空：${r.body.collab.sql_validation_status}`);
    if (!r.body.cleared_sql_validation) throw new Error(`cleared_sql_validation != true（codex 26 审 #1 字段重命名）`);
});

// ============================================================================
// T1b admin 改 target_db_connection_id 到不存在的 ID → 400 BUSINESS_VALIDATION_FAILED
//      生产环境通常只有 1-2 个 source 库，无法 happy-path 测真改值，
//      改用 business 校验失败路径覆盖 target_db 字段的实际通路
// ============================================================================
test('T1b admin 改 target_db_connection_id 到 9999（不存在）→ 400 BUSINESS_VALIDATION_FAILED', async () => {
    const ctx = await fx.createPendingFixture();
    createdFixtureIds.push(ctx.id);

    const r = await adminFix(ctx.adminToken, ctx.id, {
        changes: { target_db_connection_id: 9999 },
        reason: '测试业务校验：不存在的目标库 ID 应被拒',
    });
    if (r.status !== 400) throw new Error(`期望 400 实际 ${r.status}: ${JSON.stringify(r.body)}`);
    if (r.body.code !== 'BUSINESS_VALIDATION_FAILED') throw new Error(`期望 code=BUSINESS_VALIDATION_FAILED 实际 ${r.body.code}`);
    if (!Array.isArray(r.body.detail) || !r.body.detail.some(m => /9999/.test(m))) {
        throw new Error(`detail 应含 9999，实际：${JSON.stringify(r.body.detail)}`);
    }
});

// ============================================================================
// T2 dev1（非 admin）调 → 403
// ============================================================================
test('T2 dev1（非 admin）调 admin-fix → 403', async () => {
    const ctx = await fx.createPendingFixture();
    createdFixtureIds.push(ctx.id);

    const r = await adminFix(ctx.dev1Token, ctx.id, {
        changes: { description: 'try to hack' },
        reason: '测试非 admin 权限拦截',
    });
    if (r.status !== 403) throw new Error(`期望 403 实际 ${r.status}: ${JSON.stringify(r.body)}`);
});

// ============================================================================
// T3 reason 太短 → 400 REASON_TOO_SHORT
// ============================================================================
test('T3 reason 太短 (< 10) → 400 REASON_TOO_SHORT', async () => {
    const ctx = await fx.createPendingFixture();
    createdFixtureIds.push(ctx.id);

    const r = await adminFix(ctx.adminToken, ctx.id, {
        changes: { description: 'new desc' },
        reason: '短',
    });
    if (r.status !== 400) throw new Error(`期望 400 实际 ${r.status}`);
    if (r.body.code !== 'REASON_TOO_SHORT') throw new Error(`期望 code=REASON_TOO_SHORT 实际 ${r.body.code}`);
});

// ============================================================================
// T4 developer_id=0 → 400 FIELD_VALIDATION_FAILED（codex 二审 #7 min:1）
// ============================================================================
test('T4 developer_id=0 → 400 FIELD_VALIDATION_FAILED（人员字段 min:1）', async () => {
    const ctx = await fx.createPendingFixture();
    createdFixtureIds.push(ctx.id);

    // PENDING 状态可改 developer_id
    const r = await adminFix(ctx.adminToken, ctx.id, {
        changes: { developer_id: 0 },
        reason: '测试人员字段 min:1 校验（不允许清空到 0）',
    });
    if (r.status !== 400) throw new Error(`期望 400 实际 ${r.status}`);
    if (r.body.code !== 'FIELD_VALIDATION_FAILED') throw new Error(`期望 code=FIELD_VALIDATION_FAILED 实际 ${r.body.code}`);
    if (!Array.isArray(r.body.detail) || !r.body.detail.some(m => /min|不能小于 1/.test(m))) {
        throw new Error(`detail 应含 min/不能小于 1 提示，实际：${JSON.stringify(r.body.detail)}`);
    }
});

// ============================================================================
// T5 DONE 状态 → 409 TERMINAL_STATE_PROTECTED
// ============================================================================
test('T5 DONE 状态调 admin-fix → 409 TERMINAL_STATE_PROTECTED', async () => {
    const ctx = await fx.createPendingFixture();
    createdFixtureIds.push(ctx.id);

    await fx.setCollabState(ctx.id, {
        status: 'DONE',
        sql_validation_status: 'passed',
        done_at: '2026-05-22 14:00:00',
    });

    // codex 26 审 #4 修订验证：reason 长度推后到业务校验前，先暴露 TERMINAL_STATE_PROTECTED 而非 REASON_TOO_SHORT
    // 故意用短 reason "测试终态" (4 字符 < 10) — 现在应先返 409 终态保护，证明改造生效
    const r = await adminFix(ctx.adminToken, ctx.id, {
        changes: { description: 'try modify after done' },
        reason: '测试终态',
    });
    if (r.status !== 409) throw new Error(`期望 409 实际 ${r.status}: ${JSON.stringify(r.body)}`);
    if (r.body.code !== 'TERMINAL_STATE_PROTECTED') throw new Error(`期望 code=TERMINAL_STATE_PROTECTED 实际 ${r.body.code}（reason 长度校验推后应优先暴露 TERMINAL）`);
});

// ============================================================================
// T6 改非白名单字段（status）→ 400 FIELD_NOT_ALLOWED
// ============================================================================
test('T6 改非白名单字段 status → 400 FIELD_NOT_ALLOWED', async () => {
    const ctx = await fx.createPendingFixture();
    createdFixtureIds.push(ctx.id);

    // codex 26 审 #4 修订验证：reason 长度推后到业务校验前，先暴露 FIELD_NOT_ALLOWED
    // 故意用短 reason "测试白名单" (5 字符 < 10) — 现在应先返 400 FIELD_NOT_ALLOWED，证明改造生效
    const r = await adminFix(ctx.adminToken, ctx.id, {
        changes: { status: 'DONE', submission_version: 99 },
        reason: '测试白名单',
    });
    if (r.status !== 400) throw new Error(`期望 400 实际 ${r.status}: ${JSON.stringify(r.body)}`);
    if (r.body.code !== 'FIELD_NOT_ALLOWED') throw new Error(`期望 code=FIELD_NOT_ALLOWED 实际 ${r.body.code}（reason 长度校验推后应优先暴露 FIELD_NOT_ALLOWED）`);
    if (!Array.isArray(r.body.allowed_fields) || !r.body.allowed_fields.includes('target_db_connection_id')) {
        throw new Error(`allowed_fields 应含 target_db_connection_id，实际：${JSON.stringify(r.body.allowed_fields)}`);
    }
});

// ============================================================================
// T7 PENDING_ASSIGN 改 developer_id → 409 FIELD_STATUS_NOT_ALLOWED
//    PENDING_ASSIGN 还没指派开发，改 developer 应走 assign endpoint 而非 admin-fix
// ============================================================================
test('T7 PENDING_ASSIGN 改 developer_id → 409 FIELD_STATUS_NOT_ALLOWED', async () => {
    // 不用 createPendingFixture（它已 assign 到 PENDING）；手工造 PENDING_ASSIGN
    const adminToken = await fx.signAs(fx.ADMIN_ID);
    const oaNo = `OA_FX_PA_${Date.now()}`;
    const createRes = await fx.apiCall('POST', '/api/collab/requests', adminToken, {
        oa_request_no: oaNo,
        requester_dept: '市场营销部',
        requester_name: 'fixture_pa',
        description: 'e2e fixture PA',
        deadline: '2026-12-31 18:00:00',
        contact_person_id: fx.CONTACT_ID,
        target_db_connection_id: fx.TARGET_DB_CONN_ID,
    });
    if (createRes.status !== 200) throw new Error(`PA fixture 创建失败 ${createRes.status}`);
    const id = createRes.body.id;
    createdFixtureIds.push(id);

    // 不 assign，保持 PENDING_ASSIGN 状态
    const r = await adminFix(adminToken, id, {
        changes: { developer_id: fx.DEV1_ID },
        reason: '测试 PENDING_ASSIGN 状态下 developer_id 字段拦截',
    });
    if (r.status !== 409) throw new Error(`期望 409 实际 ${r.status}: ${JSON.stringify(r.body)}`);
    if (r.body.code !== 'FIELD_STATUS_NOT_ALLOWED') throw new Error(`期望 code=FIELD_STATUS_NOT_ALLOWED 实际 ${r.body.code}`);
    if (r.body.field !== 'developer_id') throw new Error(`期望 field=developer_id 实际 ${r.body.field}`);
});

// ============================================================================
// T9 codex 26 审 #1 验证：sql_validation_status 单独残留（error 为空）admin-fix 也清空
// ============================================================================
test('T9 sql_validation_status=failed 但 sql_error 为空 → admin-fix 仍清空 status（codex 26 审 #1）', async () => {
    const ctx = await fx.createPendingFixture();
    createdFixtureIds.push(ctx.id);

    // 模拟历史数据异常：status=failed 但 error 为空
    await fx.setCollabState(ctx.id, {
        status: 'SUBMITTED',
        sql_validation_status: 'failed',
        sql_validation_error: null,  // 关键：故意置空，模拟历史异常
        submitted_at: '2026-05-22 14:00:00',
        submission_version: 1,
    });

    const r = await adminFix(ctx.adminToken, ctx.id, {
        changes: { description: '验证 #1 修订：status 单独残留场景也应被清空' },
        reason: '测试 codex 26 审 #1 改造：sql_validation_status 单独残留时也应清空',
    });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    if (r.body.collab.sql_validation_status !== null) {
        throw new Error(`期望 sql_validation_status=null 实际 ${r.body.collab.sql_validation_status}（codex 26 审 #1 改造未生效）`);
    }
    if (!r.body.cleared_sql_validation) {
        throw new Error(`期望 cleared_sql_validation=true 实际 ${r.body.cleared_sql_validation}`);
    }
});

// ============================================================================
// T10 codex 26 审 #7 验证：clear_sql_validation_error 非布尔类型 → 400
// ============================================================================
test('T10 clear_sql_validation_error="false" 字符串 → 400 FIELD_VALIDATION_FAILED（codex 26 审 #7）', async () => {
    const ctx = await fx.createPendingFixture();
    createdFixtureIds.push(ctx.id);

    const r = await adminFix(ctx.adminToken, ctx.id, {
        changes: { description: '测试 clear_sql_validation_error 类型校验' },
        reason: '测试 codex 26 审 #7：字符串 false 应被类型校验拒绝',
        clear_sql_validation_error: 'false',  // 字符串而非布尔
    });
    if (r.status !== 400) throw new Error(`期望 400 实际 ${r.status}`);
    if (r.body.code !== 'FIELD_VALIDATION_FAILED') throw new Error(`期望 code=FIELD_VALIDATION_FAILED 实际 ${r.body.code}`);
});

// ============================================================================
// T8 GET allowed-fields 不同状态返不同字段集
// ============================================================================
test('T8 GET allowed-fields 按状态返字段集', async () => {
    const adminToken = await fx.signAs(fx.ADMIN_ID);

    // v1.78.0：新增 deadline 后 SUBMITTED 6 字段 / PENDING_ASSIGN 5 字段（均含 deadline）
    const r1 = await getAllowedFields(adminToken, 'SUBMITTED');
    if (r1.status !== 200) throw new Error(`SUBMITTED HTTP ${r1.status}`);
    const submittedFields = r1.body.allowed_fields;
    const expectedSubmitted = ['target_db_connection_id', 'description', 'oa_request_no', 'contact_person_id', 'developer_id', 'deadline'];
    if (submittedFields.length !== 6) throw new Error(`SUBMITTED 期望 6 字段实际 ${submittedFields.length}: ${JSON.stringify(submittedFields)}`);
    for (const f of expectedSubmitted) {
        if (!submittedFields.includes(f)) throw new Error(`SUBMITTED 缺字段 ${f}`);
    }

    const r2 = await getAllowedFields(adminToken, 'PENDING_ASSIGN');
    if (r2.status !== 200) throw new Error(`PENDING_ASSIGN HTTP ${r2.status}`);
    const paFields = r2.body.allowed_fields;
    if (paFields.length !== 5) throw new Error(`PENDING_ASSIGN 期望 5 字段实际 ${paFields.length}: ${JSON.stringify(paFields)}`);
    if (paFields.includes('developer_id')) throw new Error(`PENDING_ASSIGN 不应含 developer_id`);
    if (!paFields.includes('deadline')) throw new Error(`PENDING_ASSIGN 应含 deadline`);

    const r3 = await getAllowedFields(adminToken, 'DONE');
    if (r3.status !== 200) throw new Error(`DONE HTTP ${r3.status}`);
    if (r3.body.allowed_fields.length !== 0) throw new Error(`DONE 期望 0 字段实际 ${r3.body.allowed_fields.length}`);
});

// ============================================================================
// T11 v1.70.3 业务需求变更：admin 在 DONE 状态作废 → 200 + archived_at set + 完成字段保留
// ============================================================================
test('T11 v1.70.3 admin 在 DONE 状态作废 → 200 + archived_at set + sql_validated_at/done_at 等保留', async () => {
    const ctx = await fx.createPendingFixture();
    createdFixtureIds.push(ctx.id);

    // 模拟协作单已完成（DONE + 已通过 smoke）
    await fx.setCollabState(ctx.id, {
        status: 'DONE',
        sql_validation_status: 'passed',
        sql_validated_at: '2026-05-22 15:45:47',
        done_at: '2026-05-22 15:45:47',
        submission_version: 1,
    });

    // admin 作废
    const r = await archive(ctx.adminToken, ctx.id, { archived_reason: 'v1.70.3 测试 DONE 后作废' });
    if (r.status !== 200) throw new Error(`期望 200 实际 ${r.status}: ${JSON.stringify(r.body)}`);

    // 验证 DB：archived_at 已 set + 完成字段保留（status/sql_validated_at/done_at/submission_version 不动）
    const row = await new Promise((resolve, reject) => {
        const sqlite3 = require('sqlite3');
        const path = require('path');
        const db = new sqlite3.Database(path.join(__dirname, '..', 'task_pool.db'), sqlite3.OPEN_READONLY);
        db.get(
            `SELECT status, sql_validation_status, sql_validated_at, done_at, submission_version, archived_at, archived_reason, archived_by
               FROM collab_requests WHERE id = ?`,
            [ctx.id],
            (e, r) => { db.close(); e ? reject(e) : resolve(r); }
        );
    });
    if (!row.archived_at) throw new Error('archived_at 未 set');
    if (row.archived_reason !== 'v1.70.3 测试 DONE 后作废') throw new Error(`archived_reason 不匹配：${row.archived_reason}`);
    if (row.status !== 'DONE') throw new Error(`status 应保持 DONE，实际 ${row.status}（v1.70.3 拍板：作废只标 archived_at 不动完成字段）`);
    if (row.sql_validation_status !== 'passed') throw new Error(`sql_validation_status 应保持 passed，实际 ${row.sql_validation_status}`);
    if (row.sql_validated_at !== '2026-05-22 15:45:47') throw new Error(`sql_validated_at 应保留历史值`);
    if (row.done_at !== '2026-05-22 15:45:47') throw new Error(`done_at 应保留历史值`);
    if (row.submission_version !== 1) throw new Error(`submission_version 应保留 1`);
});

// ============================================================================
// T12 v1.70.3：admin 在 ARCHIVED 终态作废 → 409 ARCHIVED_PROTECTED
// ============================================================================
test('T12 v1.70.3 admin 在 ARCHIVED 终态作废 → 409 ARCHIVED_PROTECTED（终态保护）', async () => {
    const ctx = await fx.createPendingFixture();
    createdFixtureIds.push(ctx.id);

    await fx.setCollabState(ctx.id, {
        status: 'ARCHIVED',
        sql_validation_status: 'passed',
        done_at: '2026-05-22 15:45:47',
        submission_version: 1,
    });

    const r = await archive(ctx.adminToken, ctx.id, { archived_reason: '尝试作废已归档单' });
    if (r.status !== 409) throw new Error(`期望 409 实际 ${r.status}: ${JSON.stringify(r.body)}`);
    if (r.body.code !== 'ARCHIVED_PROTECTED') throw new Error(`期望 code=ARCHIVED_PROTECTED 实际 ${r.body.code}`);
});

// ============================================================================
// T13 v1.70.3：非 admin 在 DONE 状态调 archive → 403
// ============================================================================
test('T13 v1.70.3 dev1（非 admin）在 DONE 状态调 archive → 403', async () => {
    const ctx = await fx.createPendingFixture();
    createdFixtureIds.push(ctx.id);

    await fx.setCollabState(ctx.id, {
        status: 'DONE',
        sql_validation_status: 'passed',
        submission_version: 1,
    });

    const r = await archive(ctx.dev1Token, ctx.id, { archived_reason: 'dev 尝试作废' });
    if (r.status !== 403) throw new Error(`期望 403 实际 ${r.status}: ${JSON.stringify(r.body)}`);
});

// ============================================================================
// T14 v1.70.3 codex 29 审 #2：admin 在 SUBMITTED+v1 状态作废 → 200（验证删 submission_version=0 守卫后中间态也可作废）
// ============================================================================
test('T14 v1.70.3 admin 在 SUBMITTED+v1 状态作废 → 200（验证删 submission_version=0 守卫）', async () => {
    const ctx = await fx.createPendingFixture();
    createdFixtureIds.push(ctx.id);

    await fx.setCollabState(ctx.id, {
        status: 'SUBMITTED',
        sql_validation_status: 'failed',
        sql_validation_error: 'mock smoke 失败',
        submitted_at: '2026-05-22 14:00:00',
        submission_version: 1,
    });

    const r = await archive(ctx.adminToken, ctx.id, { archived_reason: 'v1.70.3 验证 SUBMITTED+v1 可作废' });
    if (r.status !== 200) throw new Error(`期望 200 实际 ${r.status}: ${JSON.stringify(r.body)}`);
});

// ============================================================================
// T15 v1.70.3 codex 29 审 #2：admin 在 PENDING+v1 状态作废 → 200（原 submission_version=0 守卫会拒绝此用例）
// ============================================================================
test('T15 v1.70.3 admin 在 PENDING+v1 状态作废 → 200（原 submission_version=0 守卫直接相关回归点）', async () => {
    const ctx = await fx.createPendingFixture();
    createdFixtureIds.push(ctx.id);

    // PENDING+submission_version>0 = 开发提过又被 admin-fix 推回 PENDING 的中间态
    await fx.setCollabState(ctx.id, {
        status: 'PENDING',
        submission_version: 1,
    });

    const r = await archive(ctx.adminToken, ctx.id, { archived_reason: 'v1.70.3 验证 PENDING+v1 可作废（删 submission_version=0 守卫后）' });
    if (r.status !== 200) throw new Error(`期望 200 实际 ${r.status}: ${JSON.stringify(r.body)}（原 submission_version=0 守卫会拒此用例，本次应放行）`);
});

// ============================================================================
// T16 v1.78.0：admin 改 deadline → 200 + DB 写入归一化为 'YYYY-MM-DD HH:mm:ss'
// ============================================================================
test('T16 v1.78.0 admin 改 deadline（T 分隔无秒）→ 200 + DB 归一化空格分隔补秒', async () => {
    const ctx = await fx.createPendingFixture();
    createdFixtureIds.push(ctx.id);

    await fx.setCollabState(ctx.id, {
        status: 'SUBMITTED',
        submitted_at: '2026-06-11 14:00:00',
        submission_version: 1,
    });

    // 前端控件传 datetime-local 格式（T 分隔、分钟精度）
    const r = await adminFix(ctx.adminToken, ctx.id, {
        changes: { deadline: '2026-06-20T17:00' },
        reason: '业务方延期，截止时间顺延到 6-20 下午',
    });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    if (!r.body.success) throw new Error(`success != true`);

    // 核验 DB：deadline 归一化为空格分隔 + 补秒
    const row = await new Promise((resolve, reject) => {
        const sqlite3 = require('sqlite3');
        const path = require('path');
        const db = new sqlite3.Database(path.join(__dirname, '..', 'task_pool.db'), sqlite3.OPEN_READONLY);
        db.get(`SELECT deadline FROM collab_requests WHERE id = ?`, [ctx.id],
            (e, r) => { db.close(); e ? reject(e) : resolve(r); });
    });
    if (row.deadline !== '2026-06-20 17:00:00') {
        throw new Error(`deadline 应归一化为 '2026-06-20 17:00:00'，实际：'${row.deadline}'`);
    }
});

// ============================================================================
// T16b v1.78.0 codex 审 low-2：审计日志 changes.deadline 记归一化后落库值（与 DB 同源）
// ============================================================================
test('T16b v1.78.0 admin 改 deadline → 审计日志 changes.deadline 为归一化值（非原始 T 分隔入参）', async () => {
    const ctx = await fx.createPendingFixture();
    createdFixtureIds.push(ctx.id);
    await fx.setCollabState(ctx.id, { status: 'SUBMITTED', submission_version: 1 });

    const r = await adminFix(ctx.adminToken, ctx.id, {
        changes: { deadline: '2026-06-22T09:30' },  // T 分隔、无秒
        reason: '验证审计日志归一化与 DB 落库值同源',
    });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);

    // insertCollabLog 是 fire-and-forget，稍等异步写入
    await new Promise(res => setTimeout(res, 300));
    const log = await new Promise((resolve, reject) => {
        const sqlite3 = require('sqlite3');
        const path = require('path');
        const db = new sqlite3.Database(path.join(__dirname, '..', 'task_pool.db'), sqlite3.OPEN_READONLY);
        db.get(
            `SELECT reason FROM collab_operation_logs
              WHERE collab_request_id = ? AND operation_type = 'ADMIN_FIX'
              ORDER BY id DESC LIMIT 1`,
            [ctx.id],
            (e, row) => { db.close(); e ? reject(e) : resolve(row); }
        );
    });
    if (!log) throw new Error('未找到 ADMIN_FIX 审计日志');
    const parsed = JSON.parse(log.reason);
    if (!parsed.changes || parsed.changes.deadline !== '2026-06-22 09:30:00') {
        throw new Error(`审计日志 changes.deadline 应为归一化值 '2026-06-22 09:30:00'，实际：'${parsed.changes && parsed.changes.deadline}'`);
    }
});

// ============================================================================
// T17 v1.78.0：deadline 非法格式 → 400 FIELD_VALIDATION_FAILED
// ============================================================================
test('T17 v1.78.0 deadline 非法格式（2026-13-45）→ 400 FIELD_VALIDATION_FAILED', async () => {
    const ctx = await fx.createPendingFixture();
    createdFixtureIds.push(ctx.id);
    await fx.setCollabState(ctx.id, { status: 'SUBMITTED', submission_version: 1 });

    const r = await adminFix(ctx.adminToken, ctx.id, {
        changes: { deadline: '2026-13-45T17:00' },  // 月/日非法
        reason: '故意传非法日期测试校验拦截',
    });
    if (r.status !== 400) throw new Error(`期望 400 实际 ${r.status}: ${JSON.stringify(r.body)}`);
    if (r.body.code !== 'FIELD_VALIDATION_FAILED') throw new Error(`期望 code=FIELD_VALIDATION_FAILED 实际 ${r.body.code}`);
});

// ============================================================================
// T18 v1.78.0：deadline 空字符串 → 400（DATETIME NOT NULL 不允许清空）
// ============================================================================
test('T18 v1.78.0 deadline 空字符串 → 400 FIELD_VALIDATION_FAILED（不可清空）', async () => {
    const ctx = await fx.createPendingFixture();
    createdFixtureIds.push(ctx.id);
    await fx.setCollabState(ctx.id, { status: 'SUBMITTED', submission_version: 1 });

    const r = await adminFix(ctx.adminToken, ctx.id, {
        changes: { deadline: '   ' },  // 纯空白
        reason: '尝试清空截止时间应被拒绝',
    });
    if (r.status !== 400) throw new Error(`期望 400 实际 ${r.status}: ${JSON.stringify(r.body)}`);
    if (r.body.code !== 'FIELD_VALIDATION_FAILED') throw new Error(`期望 code=FIELD_VALIDATION_FAILED 实际 ${r.body.code}`);
});

// ============================================================================
// T19 v1.78.0：DONE 终态改 deadline → 409 TERMINAL_STATE_PROTECTED（终态保护对 deadline 同样生效）
// ============================================================================
test('T19 v1.78.0 DONE 状态改 deadline → 409 TERMINAL_STATE_PROTECTED', async () => {
    const ctx = await fx.createPendingFixture();
    createdFixtureIds.push(ctx.id);
    await fx.setCollabState(ctx.id, {
        status: 'DONE',
        sql_validation_status: 'passed',
        done_at: '2026-06-11 15:00:00',
        submission_version: 1,
    });

    const r = await adminFix(ctx.adminToken, ctx.id, {
        changes: { deadline: '2026-06-25T12:00' },
        reason: 'DONE 单不应允许改截止时间',
    });
    if (r.status !== 409) throw new Error(`期望 409 实际 ${r.status}: ${JSON.stringify(r.body)}`);
    if (r.body.code !== 'TERMINAL_STATE_PROTECTED') throw new Error(`期望 code=TERMINAL_STATE_PROTECTED 实际 ${r.body.code}`);
});

// ============================================================================
// 跑测
// ============================================================================
(async () => {
    let passed = 0, failed = 0;
    const failures = [];

    for (const t of tests) {
        try {
            await t.fn();
            console.log(`✅ ${t.name}`);
            passed++;
        } catch (e) {
            console.log(`❌ ${t.name}: ${e.message}`);
            failed++;
            failures.push({ name: t.name, error: e.message });
        }
    }

    console.log(`\n=== v1.70.0 Step 3 admin-fix e2e ===`);
    console.log(`总数: ${tests.length}, 通过: ${passed}, 失败: ${failed}`);

    // cleanup
    let cleaned = 0;
    for (const id of createdFixtureIds) {
        try { await fx.cleanup(id); cleaned++; }
        catch (e) { console.log(`⚠️ cleanup fail id=${id}: ${e.message}`); }
    }
    console.log(`✅ fixtures cleaned up: ${cleaned}/${createdFixtureIds.length}`);

    if (failures.length > 0) {
        console.log('\n失败详情:');
        for (const f of failures) console.log(`  ❌ ${f.name}: ${f.error}`);
        process.exit(1);
    }
    console.log('\n全部通过 ✅');
})();
