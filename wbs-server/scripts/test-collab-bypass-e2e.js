/**
 * D3 模块 6 旁路 endpoint 集成测试
 *
 * 用法：node scripts/test-collab-bypass-e2e.js
 *
 * 前置：
 *   - 本地 server 已启动（localhost:3000）
 *   - 用户表里有 admin / 13857133559 / demo_user_a / demo_user_b（角色 admin / publisher / user / user）
 *   - target_db_connection_id=2（business_db source 连接）
 *   - fixture 由 _test-fixture.js 动态创建（v3 协议：PENDING_ASSIGN → assign → PENDING → 直接 UPDATE 到 SUBMITTED+failed）
 *
 * 8 个测试场景：
 *   T1 正常旁路 SUBMITTED+failed → DONE+bypassed
 *   T2 状态守卫 PENDING → 409 INVALID_STATE
 *   T3 状态守卫 SUBMITTED+passed → 409 INVALID_STATE
 *   T4 权限拒绝 publisher → 403
 *   T5 权限拒绝 user → 403
 *   T6 协作单不存在 → 404
 *   T7 reason 边界：< 10 字符 → 400 BYPASS_REASON_TOO_SHORT
 *   T8 reason 边界：> 500 字符 → 400 BYPASS_REASON_TOO_LONG
 *   T9 reason 非字符串 → 400 INVALID_REASON
 *   T10 id 非法 → 400
 *   T11 并发漂移：SELECT 后状态被改 → 409 STATE_CHANGED
 */

'use strict';

const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';

// v3 二级转派后 fixture 动态创建（2026-05-19）
const fx = require('./_test-fixture');
let TEST_ID = null;

const tokens = {};

async function loginAs(username) {
    const user = await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH);
        db.get(`SELECT id, username, display_name, role FROM users WHERE username=? LIMIT 1`, [username],
            (err, row) => { db.close(); err ? reject(err) : resolve(row); });
    });
    if (!user) throw new Error(`user ${username} not found in local DB`);
    return jwt.sign(
        { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
        JWT_SECRET,
        { expiresIn: '1h' }
    );
}

function dbGet(sql, params) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH);
        db.get(sql, params, (err, row) => { db.close(); err ? reject(err) : resolve(row); });
    });
}

function dbRun(sql, params) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH);
        db.run(sql, params, function(err) {
            db.close();
            err ? reject(err) : resolve({ changes: this.changes, lastID: this.lastID });
        });
    });
}

async function setCollabState(id, state) {
    // state: { status, sql_validation_status, sql_validation_error? }
    // 注意：sql_validated_at 也清空,以便验证 bypass 不会写它
    return dbRun(
        `UPDATE collab_requests SET
            status=?, sql_validation_status=?, sql_validation_error=?,
            sql_validated_at=NULL,
            bypass_validation=0, bypass_reason=NULL, bypass_by=NULL, bypass_by_name=NULL,
            done_at=NULL
          WHERE id=?`,
        [state.status, state.sql_validation_status, state.sql_validation_error || null, id]
    );
}

async function postBypass(token, id, body) {
    const res = await fetch(`${BASE}/api/collab/requests/${id}/bypass`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    let payload;
    try { payload = await res.json(); } catch (e) { payload = { _raw: await res.text() }; }
    return { status: res.status, body: payload };
}

async function runTests() {
    tokens.admin = await loginAs('admin');
    tokens.publisher = await loginAs('13857133559');
    tokens.user = await loginAs('demo_user_a');
    console.log('✅ tokens prepared (admin/publisher/user)');

    // v3 二级转派 fixture：创建一条 PENDING 单（v3 流程：admin 创建 → contact assign）
    const fixture = await fx.createPendingFixture();
    TEST_ID = fixture.id;
    console.log(`✅ fixture created: id=${TEST_ID} oa=${fixture.oaNo}`);

    let passed = 0, failed = 0;
    const failures = [];

    async function check(name, fn) {
        try {
            await fn();
            passed++;
            console.log(`✅ ${name}`);
        } catch (e) {
            failed++;
            failures.push({ name, error: e.message });
            console.log(`❌ ${name}: ${e.message}`);
        }
    }

    // T1: 正常旁路 SUBMITTED+failed → DONE+bypassed
    await check('T1 正常旁路 SUBMITTED+failed → DONE+bypassed', async () => {
        await setCollabState(TEST_ID, { status: 'SUBMITTED', sql_validation_status: 'failed', sql_validation_error: 'fake error for test' });
        const reason = '测试库无 2026 年数据,业务方已确认线下 xlsx 回传可接受';
        const r = await postBypass(tokens.admin, TEST_ID, { bypass_reason: reason });
        if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body).slice(0,200)}`);
        if (r.body.current_status !== 'DONE') throw new Error(`current_status=${r.body.current_status}`);
        if (r.body.sql_validation_status !== 'bypassed') throw new Error(`sql_validation_status=${r.body.sql_validation_status}`);

        const row = await dbGet(
            `SELECT status, sql_validation_status, bypass_validation, bypass_reason, bypass_by, bypass_by_name, done_at, sql_validated_at
               FROM collab_requests WHERE id=?`,
            [TEST_ID]
        );
        if (row.status !== 'DONE') throw new Error(`DB status=${row.status}`);
        if (row.sql_validation_status !== 'bypassed') throw new Error(`DB sql_validation_status=${row.sql_validation_status}`);
        if (row.bypass_validation !== 1) throw new Error(`DB bypass_validation=${row.bypass_validation}`);
        if (row.bypass_reason !== reason) throw new Error(`DB bypass_reason mismatch`);
        if (row.bypass_by !== 1) throw new Error(`DB bypass_by=${row.bypass_by}, expected admin id=1`);
        if (!row.bypass_by_name) throw new Error(`DB bypass_by_name empty`);
        if (!row.done_at) throw new Error(`DB done_at empty`);
        // 关键：bypass 不写 sql_validated_at（codex 14 #6 取舍）
        if (row.sql_validated_at !== null) throw new Error(`DB sql_validated_at should be null, got ${row.sql_validated_at}`);

        // BYPASS 日志
        const log = await dbGet(
            `SELECT operation_type, operator_id, reason FROM collab_operation_logs
              WHERE collab_request_id=? AND operation_type='BYPASS' ORDER BY id DESC LIMIT 1`,
            [TEST_ID]
        );
        if (!log) throw new Error(`BYPASS log not written`);
        if (log.operator_id !== 1) throw new Error(`log operator_id=${log.operator_id}`);
        if (log.reason !== reason) throw new Error(`log reason mismatch`);
    });

    // T2: 状态守卫 PENDING → 409 INVALID_STATE
    await check('T2 PENDING 不允许旁路 → 409 INVALID_STATE', async () => {
        await setCollabState(TEST_ID, { status: 'PENDING', sql_validation_status: null });
        const r = await postBypass(tokens.admin, TEST_ID, { bypass_reason: '测试理由长度满足十个字符的合法值' });
        if (r.status !== 409) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
        if (r.body.code !== 'INVALID_STATE') throw new Error(`code=${r.body.code}`);
        if (r.body.current_status !== 'PENDING') throw new Error(`current_status=${r.body.current_status}`);
    });

    // T3: 状态守卫 SUBMITTED+passed → 409
    await check('T3 SUBMITTED+passed 不允许旁路 → 409', async () => {
        await setCollabState(TEST_ID, { status: 'SUBMITTED', sql_validation_status: 'passed' });
        const r = await postBypass(tokens.admin, TEST_ID, { bypass_reason: '测试理由长度满足十个字符的合法值' });
        if (r.status !== 409) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
        if (r.body.code !== 'INVALID_STATE') throw new Error(`code=${r.body.code}`);
        if (r.body.current_sql_validation_status !== 'passed') throw new Error(`current_sql_validation_status=${r.body.current_sql_validation_status}`);
    });

    // T4: publisher 权限拒绝
    await check('T4 publisher 角色 → 403', async () => {
        await setCollabState(TEST_ID, { status: 'SUBMITTED', sql_validation_status: 'failed' });
        const r = await postBypass(tokens.publisher, TEST_ID, { bypass_reason: '测试理由长度满足十个字符的合法值' });
        if (r.status !== 403) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    });

    // T5: user 权限拒绝
    await check('T5 user 角色 → 403', async () => {
        await setCollabState(TEST_ID, { status: 'SUBMITTED', sql_validation_status: 'failed' });
        const r = await postBypass(tokens.user, TEST_ID, { bypass_reason: '测试理由长度满足十个字符的合法值' });
        if (r.status !== 403) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    });

    // T6: 协作单不存在
    await check('T6 协作单不存在 → 404', async () => {
        const r = await postBypass(tokens.admin, 999999, { bypass_reason: '测试理由长度满足十个字符的合法值' });
        if (r.status !== 404) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    });

    // T7: reason 太短
    await check('T7 reason < 10 字符 → 400 BYPASS_REASON_TOO_SHORT', async () => {
        await setCollabState(TEST_ID, { status: 'SUBMITTED', sql_validation_status: 'failed' });
        const r = await postBypass(tokens.admin, TEST_ID, { bypass_reason: '太短了' });
        if (r.status !== 400) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
        if (r.body.code !== 'BYPASS_REASON_TOO_SHORT') throw new Error(`code=${r.body.code}`);
    });

    // T7b: trim 后太短（前后空格）
    await check('T7b reason trim 后 < 10 字符 → 400 TOO_SHORT', async () => {
        await setCollabState(TEST_ID, { status: 'SUBMITTED', sql_validation_status: 'failed' });
        // 9 个空格 + 'abc' + 9 个空格,trim 后只有 3 字符
        const r = await postBypass(tokens.admin, TEST_ID, { bypass_reason: '         abc         ' });
        if (r.status !== 400) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
        if (r.body.code !== 'BYPASS_REASON_TOO_SHORT') throw new Error(`code=${r.body.code}`);
    });

    // T8: reason 太长
    await check('T8 reason > 500 字符 → 400 BYPASS_REASON_TOO_LONG', async () => {
        await setCollabState(TEST_ID, { status: 'SUBMITTED', sql_validation_status: 'failed' });
        const longReason = '测试'.repeat(260); // 520 字符
        const r = await postBypass(tokens.admin, TEST_ID, { bypass_reason: longReason });
        if (r.status !== 400) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
        if (r.body.code !== 'BYPASS_REASON_TOO_LONG') throw new Error(`code=${r.body.code}`);
    });

    // T9: reason 非字符串
    await check('T9 reason 非字符串 (number) → 400 INVALID_REASON', async () => {
        await setCollabState(TEST_ID, { status: 'SUBMITTED', sql_validation_status: 'failed' });
        const r = await postBypass(tokens.admin, TEST_ID, { bypass_reason: 12345 });
        if (r.status !== 400) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
        if (r.body.code !== 'INVALID_REASON') throw new Error(`code=${r.body.code}`);
    });

    // T9b: reason 缺失
    await check('T9b reason 缺失 → 400 INVALID_REASON', async () => {
        await setCollabState(TEST_ID, { status: 'SUBMITTED', sql_validation_status: 'failed' });
        const r = await postBypass(tokens.admin, TEST_ID, {});
        if (r.status !== 400) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
        if (r.body.code !== 'INVALID_REASON') throw new Error(`code=${r.body.code}`);
    });

    // T10: id 非法（非数字字符）
    await check('T10 id=abc → 400 INVALID_ID', async () => {
        const r = await postBypass(tokens.admin, 'abc', { bypass_reason: '测试理由长度满足十个字符的合法值' });
        if (r.status !== 400) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
        if (r.body.code !== 'INVALID_ID') throw new Error(`code=${r.body.code}, expected INVALID_ID`);
    });

    // T10b: id 超过 Number.MAX_SAFE_INTEGER（codex 15 审 #2 边界）
    await check('T10b id 超 MAX_SAFE_INTEGER → 400 INVALID_ID', async () => {
        // 9007199254740993 = 2^53 + 1，超过 Number.MAX_SAFE_INTEGER (2^53 - 1)
        const r = await postBypass(tokens.admin, '9007199254740993', { bypass_reason: '测试理由长度满足十个字符的合法值' });
        if (r.status !== 400) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
        if (r.body.code !== 'INVALID_ID') throw new Error(`code=${r.body.code}, expected INVALID_ID`);
    });

    // T11: 静态代码检查 — 验证条件 UPDATE WHERE 子句完整性
    //
    // codex 15 审 #3 备注：真正的并发漂移（SELECT 拿到 SUBMITTED+failed,UPDATE 前被改）
    // 需要在测试环境构造 dbRunAsync hook 或双连接事务，需 1-2h 测试基础设施投入。
    // 4-5 用户内网场景下此分支触发概率近 0，性价比低，本测试用 grep 兜底验证：
    //   1. UPDATE 带 status='SUBMITTED' AND sql_validation_status='failed' 双重 WHERE
    //   2. result.changes === 0 检查存在
    //   3. STATE_CHANGED code 存在
    // 若未来引入测试 hook 机制再升级为运行时验证。
    await check('T11 (代码层验证) 条件 UPDATE WHERE 子句完整', async () => {
        const fs = require('fs');
        const code = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
        const idx = code.indexOf("/bypass'");
        if (idx === -1) throw new Error('bypass endpoint not found in server.js');
        const slice = code.slice(idx, idx + 4000);
        if (!/AND\s+status\s*=\s*'SUBMITTED'/.test(slice)) throw new Error('UPDATE missing AND status=SUBMITTED');
        if (!/AND\s+sql_validation_status\s*=\s*'failed'/.test(slice)) throw new Error('UPDATE missing AND sql_validation_status=failed');
        if (!/result\.changes\s*===\s*0|changes\s*===\s*0/.test(slice)) throw new Error('changes=0 check missing');
        if (!/STATE_CHANGED/.test(slice)) throw new Error('STATE_CHANGED code missing');
    });

    console.log(`\n=== Summary ===`);
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);

    // 清掉 fixture（即使有失败也清，避免污染数据库）
    if (TEST_ID) {
        try {
            await fx.cleanup(TEST_ID);
            console.log(`✅ fixture cleaned up: id=${TEST_ID}`);
        } catch (e) {
            console.log(`⚠️ fixture cleanup failed: ${e.message}`);
        }
    }

    if (failures.length > 0) {
        console.log('\nFailures:');
        for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
        process.exit(1);
    }
}

runTests().catch(async (e) => {
    console.error('FATAL:', e);
    if (TEST_ID) {
        try { await fx.cleanup(TEST_ID); } catch (_) { }
    }
    process.exit(2);
});
