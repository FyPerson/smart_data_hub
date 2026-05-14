/**
 * D3 模块 7 协作摩擦 endpoint 集成测试
 *
 * 用法：node scripts/test-collab-friction-e2e.js
 *
 * 前置：本地 server 已启动（localhost:3000） + task_pool.db 有 id=3 协作单
 *
 * 测试场景：
 *   T1 admin DONE 状态首次记录 → 200 + DB 字段写入 + FRICTION_RECORD 日志
 *   T2 admin 覆盖式更新 → 200 + 旧值在日志 reason 中
 *   T3 状态守卫 PENDING → 409 INVALID_STATE
 *   T4 状态守卫 SUBMITTED → 409 INVALID_STATE
 *   T5 publisher 角色 → 403
 *   T6 user 角色 → 403
 *   T7 protocol 不存在 → 404
 *   T8 category 枚举外值 → 400 INVALID_CATEGORY
 *   T9 category 缺失 → 400 INVALID_CATEGORY
 *   T10 note 必填（空字符串）→ 400 FRICTION_NOTE_REQUIRED
 *   T11 note trim 后为空 → 400 FRICTION_NOTE_REQUIRED
 *   T12 note > 1000 字符 → 400 FRICTION_NOTE_TOO_LONG
 *   T13 note 非字符串 → 400 INVALID_NOTE
 *   T14 id 非法 → 400 INVALID_ID
 *   T15 id 超 MAX_SAFE_INTEGER → 400 INVALID_ID
 */

'use strict';

const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';

const TEST_ID = 3;
const tokens = {};

async function loginAs(username) {
    const user = await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH);
        db.get(`SELECT id, username, display_name, role FROM users WHERE username=? LIMIT 1`, [username],
            (err, row) => { db.close(); err ? reject(err) : resolve(row); });
    });
    if (!user) throw new Error(`user ${username} not found`);
    return jwt.sign(
        { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
        JWT_SECRET, { expiresIn: '1h' }
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
            err ? reject(err) : resolve({ changes: this.changes });
        });
    });
}

async function setCollabStatus(id, status) {
    return dbRun(
        `UPDATE collab_requests SET status=?,
            friction_occurred=0, friction_recorded_at=NULL,
            friction_cause_category=NULL, friction_note=NULL
          WHERE id=?`,
        [status, id]
    );
}

async function postFriction(token, id, body) {
    const res = await fetch(`${BASE}/api/collab/requests/${id}/friction-record`, {
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
    console.log('✅ tokens prepared');

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

    // T1: 首次记录
    await check('T1 admin DONE 首次记录 → 200 + DB 字段 + 日志', async () => {
        await setCollabStatus(TEST_ID, 'DONE');
        const body = { friction_cause_category: 'requirement_unclear', friction_note: '业务方拿到结果后说字段口径不对,实际要的是最近 30 天而非月初到当天' };
        const r = await postFriction(tokens.admin, TEST_ID, body);
        if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
        if (r.body.friction_cause_category !== 'requirement_unclear') throw new Error(`category=${r.body.friction_cause_category}`);

        const row = await dbGet(`SELECT friction_occurred, friction_cause_category, friction_note, friction_recorded_at FROM collab_requests WHERE id=?`, [TEST_ID]);
        if (row.friction_occurred !== 1) throw new Error(`DB friction_occurred=${row.friction_occurred}`);
        if (row.friction_cause_category !== 'requirement_unclear') throw new Error(`DB cat=${row.friction_cause_category}`);
        if (!row.friction_note.includes('30 天')) throw new Error(`DB note mismatch`);
        if (!row.friction_recorded_at) throw new Error(`DB friction_recorded_at empty`);

        const log = await dbGet(
            `SELECT operation_type, reason FROM collab_operation_logs WHERE collab_request_id=? AND operation_type='FRICTION_RECORD' ORDER BY id DESC LIMIT 1`,
            [TEST_ID]
        );
        if (!log) throw new Error(`FRICTION_RECORD log not written`);
        if (!log.reason.includes('旧[空|]') || !log.reason.includes('新[requirement_unclear|')) throw new Error(`log reason mismatch: ${log.reason}`);
    });

    // T2: 覆盖式更新
    await check('T2 admin 覆盖式更新 → 旧值在日志 reason', async () => {
        const body = { friction_cause_category: 'tech_misunderstanding', friction_note: '开发理解错了 BMS 业务类型枚举,A 类被当成 D 类聚合' };
        const r = await postFriction(tokens.admin, TEST_ID, body);
        if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);

        const log = await dbGet(
            `SELECT reason FROM collab_operation_logs WHERE collab_request_id=? AND operation_type='FRICTION_RECORD' ORDER BY id DESC LIMIT 1`,
            [TEST_ID]
        );
        if (!log.reason.includes('旧[requirement_unclear|')) throw new Error(`旧值丢失: ${log.reason}`);
        if (!log.reason.includes('新[tech_misunderstanding|')) throw new Error(`新值缺失: ${log.reason}`);
    });

    // T3: PENDING 状态
    await check('T3 PENDING 状态 → 409 INVALID_STATE', async () => {
        await setCollabStatus(TEST_ID, 'PENDING');
        const r = await postFriction(tokens.admin, TEST_ID, { friction_cause_category: 'other', friction_note: 'test note ok' });
        if (r.status !== 409) throw new Error(`HTTP ${r.status}`);
        if (r.body.code !== 'INVALID_STATE') throw new Error(`code=${r.body.code}`);
        if (r.body.current_status !== 'PENDING') throw new Error(`current_status=${r.body.current_status}`);
    });

    // T4: SUBMITTED 状态
    await check('T4 SUBMITTED 状态 → 409 INVALID_STATE', async () => {
        await setCollabStatus(TEST_ID, 'SUBMITTED');
        const r = await postFriction(tokens.admin, TEST_ID, { friction_cause_category: 'other', friction_note: 'test note ok' });
        if (r.status !== 409) throw new Error(`HTTP ${r.status}`);
        if (r.body.code !== 'INVALID_STATE') throw new Error(`code=${r.body.code}`);
    });

    // T5/T6: 权限拒绝
    await check('T5 publisher → 403', async () => {
        await setCollabStatus(TEST_ID, 'DONE');
        const r = await postFriction(tokens.publisher, TEST_ID, { friction_cause_category: 'other', friction_note: 'test note ok' });
        if (r.status !== 403) throw new Error(`HTTP ${r.status}`);
    });
    await check('T6 user → 403', async () => {
        const r = await postFriction(tokens.user, TEST_ID, { friction_cause_category: 'other', friction_note: 'test note ok' });
        if (r.status !== 403) throw new Error(`HTTP ${r.status}`);
    });

    // T7: 不存在
    await check('T7 协作单不存在 → 404', async () => {
        const r = await postFriction(tokens.admin, 999999, { friction_cause_category: 'other', friction_note: 'test note ok' });
        if (r.status !== 404) throw new Error(`HTTP ${r.status}`);
    });

    // T8/T9: category
    await check('T8 category 枚举外 → 400 INVALID_CATEGORY', async () => {
        const r = await postFriction(tokens.admin, TEST_ID, { friction_cause_category: 'invalid_xxx', friction_note: 'test note ok' });
        if (r.status !== 400) throw new Error(`HTTP ${r.status}`);
        if (r.body.code !== 'INVALID_CATEGORY') throw new Error(`code=${r.body.code}`);
    });
    await check('T9 category 缺失 → 400 INVALID_CATEGORY', async () => {
        const r = await postFriction(tokens.admin, TEST_ID, { friction_note: 'test note ok' });
        if (r.status !== 400) throw new Error(`HTTP ${r.status}`);
        if (r.body.code !== 'INVALID_CATEGORY') throw new Error(`code=${r.body.code}`);
    });

    // T10/T11: note 必填
    await check('T10 note 空字符串 → 400 FRICTION_NOTE_REQUIRED', async () => {
        const r = await postFriction(tokens.admin, TEST_ID, { friction_cause_category: 'other', friction_note: '' });
        if (r.status !== 400) throw new Error(`HTTP ${r.status}`);
        if (r.body.code !== 'FRICTION_NOTE_REQUIRED') throw new Error(`code=${r.body.code}`);
    });
    await check('T11 note trim 后为空 → 400 FRICTION_NOTE_REQUIRED', async () => {
        const r = await postFriction(tokens.admin, TEST_ID, { friction_cause_category: 'other', friction_note: '   ' });
        if (r.status !== 400) throw new Error(`HTTP ${r.status}`);
        if (r.body.code !== 'FRICTION_NOTE_REQUIRED') throw new Error(`code=${r.body.code}`);
    });

    // T12: note 超长
    await check('T12 note > 1000 字符 → 400 FRICTION_NOTE_TOO_LONG', async () => {
        const longNote = '测试'.repeat(510); // 1020 字符
        const r = await postFriction(tokens.admin, TEST_ID, { friction_cause_category: 'other', friction_note: longNote });
        if (r.status !== 400) throw new Error(`HTTP ${r.status}`);
        if (r.body.code !== 'FRICTION_NOTE_TOO_LONG') throw new Error(`code=${r.body.code}`);
    });

    // T13: note 非字符串
    await check('T13 note 非字符串 → 400 INVALID_NOTE', async () => {
        const r = await postFriction(tokens.admin, TEST_ID, { friction_cause_category: 'other', friction_note: 12345 });
        if (r.status !== 400) throw new Error(`HTTP ${r.status}`);
        if (r.body.code !== 'INVALID_NOTE') throw new Error(`code=${r.body.code}`);
    });

    // T14/T15: id 边界
    await check('T14 id=abc → 400 INVALID_ID', async () => {
        const r = await postFriction(tokens.admin, 'abc', { friction_cause_category: 'other', friction_note: 'test note ok' });
        if (r.status !== 400) throw new Error(`HTTP ${r.status}`);
        if (r.body.code !== 'INVALID_ID') throw new Error(`code=${r.body.code}`);
    });
    await check('T15 id 超 MAX_SAFE_INTEGER → 400 INVALID_ID', async () => {
        const r = await postFriction(tokens.admin, '9007199254740993', { friction_cause_category: 'other', friction_note: 'test note ok' });
        if (r.status !== 400) throw new Error(`HTTP ${r.status}`);
        if (r.body.code !== 'INVALID_ID') throw new Error(`code=${r.body.code}`);
    });

    console.log(`\n=== Summary ===`);
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);
    if (failures.length > 0) {
        for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
        process.exit(1);
    }
}

runTests().catch(e => { console.error('FATAL:', e); process.exit(2); });
