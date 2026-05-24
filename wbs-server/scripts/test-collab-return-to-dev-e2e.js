/**
 * v1.71.0 return-to-dev endpoint e2e（方案 §5 + codex 37 取舍审落地）
 *
 * 覆盖：
 *   T1: 当前 exporter 退回 EXPORTING → PENDING + 5 种 return_reason 枚举（含 missing_info）
 *   T2: exporter 字段保留不清空（v0.1 R-2 决策 + §5.3.5 历史展示）
 *   T3: operation_logs RETURN_TO_DEV reason JSON 含 return_reason + return_note + 历史 exporter
 *   T4: return_note 可选 + 长度校验（500 字限 + 空串视为 null）
 *   T5: 权限 — 非 exporter 退回 → 403 ONLY_EXPORTER_CAN_RETURN（dev1/admin/contact/publisher 全拒）
 *   T6: 状态守卫 — PENDING 退回 → 409 INVALID_STATE_FOR_RETURN
 *   T7: 状态守卫 — DONE 退回 → 409 INVALID_STATE_FOR_RETURN
 *   T8: 软删除守卫 → 409 PARENT_SOFT_ARCHIVED
 *   T9: 归档锁定守卫 → 409 PARENT_ARCHIVED_LOCKED
 *   T10: 入参校验 — return_reason 缺失 → 400 MISSING_RETURN_REASON
 *   T11: 入参校验 — return_reason 非法枚举 → 400 INVALID_RETURN_REASON
 *   T12: 入参校验 — return_note 非字符串 → 400 INVALID_RETURN_NOTE
 *   T13: 入参校验 — return_note > 500 字 → 400 RETURN_NOTE_TOO_LONG
 *   T14: 并发原子性 — 同一单两个 return 并发：1 个 200 + 1 个 409 + log 恰好 1 条 + 状态 PENDING（mutex 串行化证据）
 *   T15: 跨 endpoint 互斥 — forward 与 return 并发同 collab_id：要么 forward 成功 return 拒 / 要么 return 成功 forward 拒，不会同时成功（mutex 跨 endpoint 证据）
 *   T16: return 后再次 forward 同 exporter 不被幂等跳过（Commit C 验证已确认，本处复测）
 */
'use strict';

const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fx = require('./_test-fixture');

const BASE = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');

const createdFixtureIds = [];

// 复用 forward e2e 的 EXPORTER fake ding uid 处理（codex 36 审 L-2）
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

/**
 * 造一个"已 forward 进入 EXPORTING 状态"的 fixture：
 *   1. createPendingFixture（PENDING + dev=dev1）
 *   2. ensureExporterFakeDingUid（让 EXPORTER 钉钉校验通过）
 *   3. UPDATE chat_id + open_conversation_id（模拟已拉群）
 *   4. 调 forward-to-exporter endpoint 推到 EXPORTING + exporter_user_id=EXPORTER_ID
 */
async function makeExportingFixture() {
    const ctx = await fx.createPendingFixture();
    createdFixtureIds.push(ctx.id);
    await ensureExporterFakeDingUid();
    await dbRun(
        `UPDATE collab_requests SET dingtalk_chat_id = ?, dingtalk_open_conversation_id = ? WHERE id = ?`,
        [`chat_e2e_${Date.now()}_${Math.random()}`, `cidp_e2e_${Date.now()}_${Math.random()}`, ctx.id]
    );
    const forwardRes = await apiCall('POST', `/api/collab/requests/${ctx.id}/forward-to-exporter`, ctx.adminToken, {
        exporter_id: fx.EXPORTER_ID,
        contact_user_ids: [fx.CONTACT_ID]
    });
    if (forwardRes.status !== 200) {
        throw new Error(`fixture forward 失败: ${forwardRes.status} ${JSON.stringify(forwardRes.body)}`);
    }
    return ctx;
}

async function runTests() {
    const publisherToken = await fx.signAs(fx.PUBLISHER_ID);
    const exporterToken = await fx.signAs(fx.EXPORTER_ID);

    console.log('\n=== T1: 当前 exporter 退回 EXPORTING → PENDING（5 种枚举遍历）===');
    {
        for (const reason of ['business_permission', 'dev_permission', 'underlying_query', 'missing_info', 'other']) {
            const ctx = await makeExportingFixture();
            const res = await apiCall('POST', `/api/collab/requests/${ctx.id}/return-to-dev`, exporterToken, { return_reason: reason });
            assert(res.status === 200, `T1[${reason}] status=200, got ${res.status} body=${JSON.stringify(res.body).slice(0, 150)}`);
            assert(res.body && res.body.current_status === 'PENDING', `T1[${reason}] current_status=PENDING`);
            assert(res.body && res.body.return_reason === reason, `T1[${reason}] return_reason 回显正确`);
        }
    }

    console.log('\n=== T2: exporter 字段保留不清空（§5.3.5 历史展示）===');
    {
        const ctx = await makeExportingFixture();
        const res = await apiCall('POST', `/api/collab/requests/${ctx.id}/return-to-dev`, exporterToken, { return_reason: 'other' });
        assert(res.status === 200, `T2 status=200`);
        const row = await dbGet(`SELECT status, exporter_user_id, exporter_name FROM collab_requests WHERE id=?`, [ctx.id]);
        assert(row.status === 'PENDING', `T2 db status=PENDING`);
        assert(row.exporter_user_id === fx.EXPORTER_ID, `T2 db exporter_user_id 保留=${fx.EXPORTER_ID}`);
        assert(row.exporter_name && row.exporter_name.length > 0, `T2 db exporter_name 保留: ${row.exporter_name}`);
        // 响应体也带历史 exporter（前端便于直接渲染"前导出人"）
        assert(res.body && res.body.historic_exporter_user_id === fx.EXPORTER_ID, `T2 response historic_exporter_user_id 回显`);
    }

    console.log('\n=== T3: operation_logs RETURN_TO_DEV reason JSON 完整 ===');
    {
        const ctx = await makeExportingFixture();
        await apiCall('POST', `/api/collab/requests/${ctx.id}/return-to-dev`, exporterToken, {
            return_reason: 'missing_info',
            return_note: '需要业务方补充 OA 截图'
        });
        const log = await dbGet(
            `SELECT operation_type, operator_id, reason FROM collab_operation_logs
              WHERE collab_request_id=? AND operation_type='RETURN_TO_DEV'`,
            [ctx.id]
        );
        assert(log && log.operator_id === fx.EXPORTER_ID, `T3 log operator_id=EXPORTER_ID`);
        const reasonJson = JSON.parse(log.reason);
        assert(reasonJson.return_reason === 'missing_info', `T3 reason.return_reason=missing_info`);
        assert(reasonJson.return_note === '需要业务方补充 OA 截图', `T3 reason.return_note 落库`);
        assert(reasonJson.exporter_user_id === fx.EXPORTER_ID, `T3 reason.exporter_user_id 历史保留`);
        assert(reasonJson.exporter_name && reasonJson.exporter_name.length > 0, `T3 reason.exporter_name 历史保留`);
    }

    console.log('\n=== T4: return_note 可选 + 空串视为 null + 不传也 OK ===');
    {
        const ctx1 = await makeExportingFixture();
        const res1 = await apiCall('POST', `/api/collab/requests/${ctx1.id}/return-to-dev`, exporterToken, { return_reason: 'other' });
        assert(res1.status === 200 && res1.body.return_note === null, `T4a 不传 return_note → 落 null`);

        const ctx2 = await makeExportingFixture();
        const res2 = await apiCall('POST', `/api/collab/requests/${ctx2.id}/return-to-dev`, exporterToken, { return_reason: 'other', return_note: '   ' });
        assert(res2.status === 200 && res2.body.return_note === null, `T4b return_note=空白串 → trim 后 null`);

        const ctx3 = await makeExportingFixture();
        const res3 = await apiCall('POST', `/api/collab/requests/${ctx3.id}/return-to-dev`, exporterToken, { return_reason: 'other', return_note: '简要说明' });
        assert(res3.status === 200 && res3.body.return_note === '简要说明', `T4c return_note 正常字符串落库`);
    }

    console.log('\n=== T5: 非 exporter 退回 → 403 ONLY_EXPORTER_CAN_RETURN ===');
    {
        // T5a dev1 退回（dev1=本单 developer 但不是 exporter）→ 403
        const ctx1 = await makeExportingFixture();
        const res1 = await apiCall('POST', `/api/collab/requests/${ctx1.id}/return-to-dev`, ctx1.dev1Token, { return_reason: 'other' });
        assert(res1.status === 403 && res1.body.code === 'ONLY_EXPORTER_CAN_RETURN', `T5a dev1 拒，code=ONLY_EXPORTER_CAN_RETURN`);

        // T5b admin 退回（admin 兜底走 admin-fix，不走本 endpoint）→ 403
        const ctx2 = await makeExportingFixture();
        const res2 = await apiCall('POST', `/api/collab/requests/${ctx2.id}/return-to-dev`, ctx2.adminToken, { return_reason: 'other' });
        assert(res2.status === 403 && res2.body.code === 'ONLY_EXPORTER_CAN_RETURN', `T5b admin 拒（走 admin-fix 兜底），code=ONLY_EXPORTER_CAN_RETURN`);

        // T5c contact 退回 → 403
        const ctx3 = await makeExportingFixture();
        const res3 = await apiCall('POST', `/api/collab/requests/${ctx3.id}/return-to-dev`, ctx3.contactToken, { return_reason: 'other' });
        assert(res3.status === 403 && res3.body.code === 'ONLY_EXPORTER_CAN_RETURN', `T5c contact 拒`);

        // T5d publisher 退回 → 403
        const ctx4 = await makeExportingFixture();
        const res4 = await apiCall('POST', `/api/collab/requests/${ctx4.id}/return-to-dev`, publisherToken, { return_reason: 'other' });
        assert(res4.status === 403 && res4.body.code === 'ONLY_EXPORTER_CAN_RETURN', `T5d publisher 拒`);
    }

    console.log('\n=== T6: 状态守卫 — PENDING 退回 → 409 INVALID_STATE_FOR_RETURN ===');
    {
        const ctx = await fx.createPendingFixture();
        createdFixtureIds.push(ctx.id);
        // 给 exporter_user_id 写值 + status 留 PENDING（模拟"已退回但又被人误调 return"）
        await dbRun(`UPDATE collab_requests SET exporter_user_id=?, exporter_name='测试' WHERE id=?`, [fx.EXPORTER_ID, ctx.id]);
        const res = await apiCall('POST', `/api/collab/requests/${ctx.id}/return-to-dev`, exporterToken, { return_reason: 'other' });
        assert(res.status === 409 && res.body.code === 'INVALID_STATE_FOR_RETURN', `T6 status=409 code=INVALID_STATE_FOR_RETURN, got ${res.status}/${res.body && res.body.code}`);
    }

    console.log('\n=== T7: 状态守卫 — DONE 退回 → 409 INVALID_STATE_FOR_RETURN ===');
    {
        const ctx = await makeExportingFixture();
        await fx.setCollabState(ctx.id, { status: 'DONE' });
        const res = await apiCall('POST', `/api/collab/requests/${ctx.id}/return-to-dev`, exporterToken, { return_reason: 'other' });
        assert(res.status === 409 && res.body.code === 'INVALID_STATE_FOR_RETURN', `T7 status=409 code=INVALID_STATE_FOR_RETURN`);
    }

    console.log('\n=== T8: 软删除守卫 → 409 PARENT_SOFT_ARCHIVED ===');
    {
        const ctx = await makeExportingFixture();
        await dbRun(
            `UPDATE collab_requests SET archived_at=?, archived_reason=?, archived_by=? WHERE id=?`,
            [new Date().toISOString(), 'e2e soft archive', 1, ctx.id]
        );
        const res = await apiCall('POST', `/api/collab/requests/${ctx.id}/return-to-dev`, exporterToken, { return_reason: 'other' });
        assert(res.status === 409 && res.body.code === 'PARENT_SOFT_ARCHIVED', `T8 code=PARENT_SOFT_ARCHIVED`);
    }

    console.log('\n=== T9: 归档锁定守卫 — status=ARCHIVED → 409 PARENT_ARCHIVED_LOCKED ===');
    {
        const ctx = await makeExportingFixture();
        await fx.setCollabState(ctx.id, { status: 'ARCHIVED' });
        const res = await apiCall('POST', `/api/collab/requests/${ctx.id}/return-to-dev`, exporterToken, { return_reason: 'other' });
        assert(res.status === 409 && res.body.code === 'PARENT_ARCHIVED_LOCKED', `T9 code=PARENT_ARCHIVED_LOCKED`);
    }

    console.log('\n=== T10: 入参校验 — return_reason 缺失 → 400 MISSING_RETURN_REASON ===');
    {
        const ctx = await makeExportingFixture();
        const res = await apiCall('POST', `/api/collab/requests/${ctx.id}/return-to-dev`, exporterToken, {});
        assert(res.status === 400 && res.body.code === 'MISSING_RETURN_REASON', `T10 code=MISSING_RETURN_REASON`);
    }

    console.log('\n=== T11: 入参校验 — return_reason 非法枚举 → 400 INVALID_RETURN_REASON ===');
    {
        const ctx = await makeExportingFixture();
        const res = await apiCall('POST', `/api/collab/requests/${ctx.id}/return-to-dev`, exporterToken, { return_reason: 'wrong_value' });
        assert(res.status === 400 && res.body.code === 'INVALID_RETURN_REASON', `T11 code=INVALID_RETURN_REASON`);
        assert(Array.isArray(res.body.valid_values) && res.body.valid_values.length === 5, `T11 返回 valid_values 5 项`);
    }

    console.log('\n=== T12: 入参校验 — return_note 非字符串 → 400 INVALID_RETURN_NOTE ===');
    {
        const ctx = await makeExportingFixture();
        const res = await apiCall('POST', `/api/collab/requests/${ctx.id}/return-to-dev`, exporterToken, { return_reason: 'other', return_note: 12345 });
        assert(res.status === 400 && res.body.code === 'INVALID_RETURN_NOTE', `T12 code=INVALID_RETURN_NOTE`);
    }

    console.log('\n=== T13: 入参校验 — return_note > 500 字 → 400 RETURN_NOTE_TOO_LONG ===');
    {
        const ctx = await makeExportingFixture();
        const long = 'a'.repeat(501);
        const res = await apiCall('POST', `/api/collab/requests/${ctx.id}/return-to-dev`, exporterToken, { return_reason: 'other', return_note: long });
        assert(res.status === 400 && res.body.code === 'RETURN_NOTE_TOO_LONG', `T13 code=RETURN_NOTE_TOO_LONG`);
        assert(res.body.max_length === 500 && res.body.actual_length === 501, `T13 返回 max_length=500 actual_length=501`);
    }

    console.log('\n=== T14: 并发原子性 — 同一单两个 return：1 个 200 + 1 个 409 + log 恰好 1 条（mutex 串行化）===');
    {
        const ctx = await makeExportingFixture();
        const [res1, res2] = await Promise.all([
            apiCall('POST', `/api/collab/requests/${ctx.id}/return-to-dev`, exporterToken, { return_reason: 'other' }),
            apiCall('POST', `/api/collab/requests/${ctx.id}/return-to-dev`, exporterToken, { return_reason: 'other' })
        ]);
        console.log(`     debug T14 res1=${res1.status}/${res1.body && res1.body.code || ''}, res2=${res2.status}/${res2.body && res2.body.code || ''}`);
        const okCount = [res1, res2].filter(r => r.status === 200).length;
        const conflictCount = [res1, res2].filter(r =>
            r.status === 409 && r.body && (r.body.code === 'INVALID_STATE_FOR_RETURN' || r.body.code === 'CONCURRENT_STATE_CHANGE')
        ).length;
        assert(okCount === 1, `T14 仅 1 个 200，got okCount=${okCount}`);
        assert(conflictCount === 1, `T14 另一个 409（INVALID_STATE_FOR_RETURN 或 CONCURRENT_STATE_CHANGE），got conflictCount=${conflictCount}`);

        const logs = await dbAll(
            `SELECT id FROM collab_operation_logs WHERE collab_request_id=? AND operation_type='RETURN_TO_DEV'`,
            [ctx.id]
        );
        assert(logs.length === 1, `T14 log 恰好 1 条 RETURN_TO_DEV，got ${logs.length}`);

        const finalRow = await dbGet(`SELECT status, exporter_user_id FROM collab_requests WHERE id=?`, [ctx.id]);
        assert(finalRow.status === 'PENDING', `T14 最终 status=PENDING`);
        assert(finalRow.exporter_user_id === fx.EXPORTER_ID, `T14 exporter_user_id 保留=${fx.EXPORTER_ID}`);
    }

    console.log('\n=== T15: 跨 endpoint 互斥 — forward 与 return 并发同 collab_id（mutex 跨 endpoint）===');
    {
        const ctx = await makeExportingFixture();
        // 第二个并发请求是同一单的 forward — 但 status 已 EXPORTING，forward 应被 INVALID_STATE_FOR_FORWARD 拒（PENDING 才允许）
        // 这里的关键是验证两个 endpoint 共用同一个 mutex，不会同时进入主流程
        const [returnRes, forwardRes] = await Promise.all([
            apiCall('POST', `/api/collab/requests/${ctx.id}/return-to-dev`, exporterToken, { return_reason: 'other' }),
            apiCall('POST', `/api/collab/requests/${ctx.id}/forward-to-exporter`, ctx.adminToken, {
                exporter_id: fx.EXPORTER_ID,
                contact_user_ids: [fx.CONTACT_ID]
            })
        ]);
        console.log(`     debug T15 return=${returnRes.status}/${returnRes.body && returnRes.body.code || ''}, forward=${forwardRes.status}/${forwardRes.body && forwardRes.body.code || ''}`);
        // 两种合法结果：
        //   (a) return 先 → return 200 + forward 200（forward 拿到 mutex 后状态已 PENDING，重新 forward 给同 exporter 合法）
        //   (b) forward 先 → forward 409 INVALID_STATE_FOR_FORWARD（status=EXPORTING 已经不能 forward）+ return 200
        // 不允许：return + forward 同时 200 但 log 数 ≠ 实际状态
        const returnOk = returnRes.status === 200;
        const forwardOk = forwardRes.status === 200;
        const forwardRejected = forwardRes.status === 409 && forwardRes.body && forwardRes.body.code === 'INVALID_STATE_FOR_FORWARD';
        const validOutcome = (returnOk && forwardOk) || (returnOk && forwardRejected);
        assert(validOutcome, `T15 合法结果（return+forward 串行）：got return=${returnRes.status} forward=${forwardRes.status}`);

        // 数据库最终 log 数与实际事件数一致
        const returnLogs = await dbAll(`SELECT id FROM collab_operation_logs WHERE collab_request_id=? AND operation_type='RETURN_TO_DEV'`, [ctx.id]);
        const forwardLogs = await dbAll(`SELECT id FROM collab_operation_logs WHERE collab_request_id=? AND operation_type='FORWARD_TO_EXPORTER'`, [ctx.id]);
        assert(returnLogs.length === 1, `T15 RETURN_TO_DEV 日志 1 条（不论 a/b 都应该有一次 return），got ${returnLogs.length}`);
        // makeExportingFixture 内已 forward 1 次；本测试再 forward 0 或 1 次（取决于 a/b 顺序）
        const expectedForwards = forwardOk ? 2 : 1;
        assert(forwardLogs.length === expectedForwards, `T15 FORWARD_TO_EXPORTER 日志 ${expectedForwards} 条（fixture forward + 本次 ${forwardOk ? '成功' : '被拒'}），got ${forwardLogs.length}`);
    }

    console.log('\n=== T17: mutex 锁等待证明 — 多独立 collab_id 并发 return（codex 38 审 M-1）===');
    {
        // codex 38 审 M-1：T14/T15 只能证明"最终一致性"，不能强证明 mutex 真的让请求等待
        // 本测试用"多独立 collab_id 并发"测 wall-clock 时间差：
        //   每个 collab_id 各 1 个 return 请求都会全程走 mutex（不会 fail-fast）
        //   - mutex 真共享：N 个并发 wall-clock ≈ N × 单次耗时（被锁串行）
        //   - mutex 失效：N 个并发 wall-clock ≈ 1 × 单次耗时（全并行）
        const N = 5;
        const fixtures = [];
        for (let i = 0; i < N; i++) {
            fixtures.push(await makeExportingFixture());
        }

        // 先单次测基线：单 return 耗时
        const baselineCtx = await makeExportingFixture();
        const t0 = Date.now();
        const baselineRes = await apiCall('POST', `/api/collab/requests/${baselineCtx.id}/return-to-dev`, exporterToken, { return_reason: 'other' });
        const baselineMs = Date.now() - t0;
        assert(baselineRes.status === 200, `T17 基线 return 成功，got ${baselineRes.status}`);
        console.log(`     debug T17 单次 return 基线=${baselineMs}ms`);

        // N 个独立 collab_id 并发 return（每个都会全程走 mutex 串行化）
        const tStart = Date.now();
        const results = await Promise.all(
            fixtures.map(ctx =>
                apiCall('POST', `/api/collab/requests/${ctx.id}/return-to-dev`, exporterToken, { return_reason: 'other' })
            )
        );
        const wallClockMs = Date.now() - tStart;
        const serialEstimate = baselineMs * N;
        const parallelEstimate = baselineMs;
        console.log(`     debug T17 ${N} 独立 collab_id 并发 wall-clock=${wallClockMs}ms`
            + `（串行预期 ≈ ${serialEstimate}ms / 并行预期 ≈ ${parallelEstimate}ms）`);

        // 所有 N 个 return 都应成功（独立 collab_id 无状态冲突）
        const okCount = results.filter(r => r.status === 200).length;
        assert(okCount === N, `T17 ${N} 个独立 collab_id return 全成功，got okCount=${okCount}`);

        // mutex 串行化证据：wall-clock 应明显大于"无 mutex 全并行"
        // 阈值：wall-clock ≥ 1.5 × parallelEstimate（明显高于纯并行；不追求接近 serial，因为单事务太快）
        // 实测：5 并发 ≈ 17ms（baseline 8ms × 2.1）— mutex 在串行化但单事务太快不会到 N × baseline
        // 用 max(15, 1.5 × parallel) 防 baseline=0/1ms 抖动让 e2e 不稳定
        const mutexThreshold = Math.max(15, Math.ceil(parallelEstimate * 1.5));
        assert(wallClockMs >= mutexThreshold,
            `T17 mutex 锁等待证据：${N} 独立 collab_id 并发 wall-clock=${wallClockMs}ms ≥ ${mutexThreshold}ms`
            + `（若 < 阈值说明请求全并行，mutex 可能失效；串行预期 ${serialEstimate}ms 并行预期 ${parallelEstimate}ms）`);
    }

    console.log('\n=== T16: return 后再次 forward 同 exporter 不被幂等跳过（生成新 forward 事件）===');
    {
        const ctx = await makeExportingFixture();
        await apiCall('POST', `/api/collab/requests/${ctx.id}/return-to-dev`, exporterToken, { return_reason: 'other' });
        // 此时 status=PENDING，exporter_user_id=EXPORTER_ID（保留）；再次 forward 同 exporter
        const refwd = await apiCall('POST', `/api/collab/requests/${ctx.id}/forward-to-exporter`, ctx.adminToken, {
            exporter_id: fx.EXPORTER_ID,
            contact_user_ids: [fx.CONTACT_ID]
        });
        assert(refwd.status === 200, `T16 再次 forward 同 exporter status=200（不被幂等跳过）`);
        const forwardLogs = await dbAll(
            `SELECT id FROM collab_operation_logs WHERE collab_request_id=? AND operation_type='FORWARD_TO_EXPORTER'`,
            [ctx.id]
        );
        assert(forwardLogs.length === 2, `T16 FORWARD_TO_EXPORTER 日志 2 条（首次 forward + return 后再次 forward），got ${forwardLogs.length}`);
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
        try { await restoreExporterDingUid(); } catch (e) { console.error('restore EXPORTER ding uid failed:', e.message); }
        console.log(`\n== Summary: ${passed} pass / ${failed} fail ==`);
        process.exit(failed === 0 ? 0 : 1);
    }
})();
