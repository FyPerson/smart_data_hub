/**
 * D3 模块 7 协作摩擦 endpoint 集成测试
 *
 * 用法：node scripts/test-collab-friction-e2e.js
 *
 * 前置：入口 ready() 自起隔离实例，或核对批跑器给的 TEST_* 变量组（四个必须同时给）+ fixture 由 _test-fixture.js 动态创建
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


// v3 二级转派后 fixture 动态创建（2026-05-19）
const fx = require('./_test-fixture');

// [#106 S4c-A1] 被测服务 / 实例库 / 签名来自 test-env：BASE / DB_PATH 在 ready() 之后才赋值；
//   不再写死 3000、业务库路径，不再加载 .env 与自己 jwt.sign。
let BASE = null;
let DB_PATH = null;
let TEST_ID = null;
const tokens = {};

// [#106 S4c-1 修复批 1] 与原脚本语义一致：按 users.username 在实例库里取行，再经 fx.signAs(id) 签发（不再用固定 id 映射）；
//   查不到即抛错。dbGet / DB_PATH 在入口 ready() 之后才被调用。
async function loginAs(username) {
    const user = await dbGet(`SELECT id, username, display_name, role FROM users WHERE username=? LIMIT 1`, [username]);
    if (!user) throw new Error(`user ${username} not found in instance DB`);
    return fx.signAs(user.id);
}

async function dbGet(sql, params) {
    const db = await fx.openInstanceDb(DB_PATH);
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            // 等 close 回调再落定：关库错误不丢，resolve 时句柄已关闭（语句错误优先）
            db.close((cerr) => { const e = err || cerr; e ? reject(e) : resolve(row); });
        });
    });
}

async function dbRun(sql, params) {
    const db = await fx.openInstanceDb(DB_PATH);
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            const out = err ? null : { changes: this.changes };
            db.close((cerr) => { const e = err || cerr; e ? reject(e) : resolve(out); });
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
    tokens.publisher = await loginAs('19900000003');
    tokens.user = await loginAs('demo_user_a');
    console.log('✅ tokens prepared');

    // v3 二级转派 fixture
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

    // T3: PENDING 状态（v1.70.4 codex 30 审 #3 反转：从 409 INVALID_STATE 改为 200 允许）
    await check('T3 v1.70.4 PENDING 状态 → 200 允许（admin 协作过程中即可填）', async () => {
        await setCollabStatus(TEST_ID, 'PENDING');
        const r = await postFriction(tokens.admin, TEST_ID, { friction_cause_category: 'other', friction_note: 'PENDING 阶段填摩擦 v1.70.4' });
        if (r.status !== 200) throw new Error(`HTTP ${r.status} body=${JSON.stringify(r.body)}`);
    });

    // T4: SUBMITTED 状态（v1.70.4 codex 30 审 #3 反转：从 409 INVALID_STATE 改为 200 允许）
    await check('T4 v1.70.4 SUBMITTED 状态 → 200 允许', async () => {
        await setCollabStatus(TEST_ID, 'SUBMITTED');
        const r = await postFriction(tokens.admin, TEST_ID, { friction_cause_category: 'other', friction_note: 'SUBMITTED 阶段填摩擦 v1.70.4' });
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    });

    // T4b: ARCHIVED 状态仍拒（v1.70.4 新增）
    await check('T4b v1.70.4 ARCHIVED 状态 → 409 ARCHIVED_PROTECTED', async () => {
        await setCollabStatus(TEST_ID, 'ARCHIVED');
        const r = await postFriction(tokens.admin, TEST_ID, { friction_cause_category: 'other', friction_note: 'ARCHIVED 应被拒' });
        if (r.status !== 409) throw new Error(`HTTP ${r.status}`);
        if (r.body.code !== 'ARCHIVED_PROTECTED') throw new Error(`code=${r.body.code}`);
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

    if (TEST_ID) {
        try {
            await fx.cleanup(TEST_ID);
            console.log(`✅ fixture cleaned up: id=${TEST_ID}`);
            TEST_ID = null;   // 已清理：入口的异常兜底不再重复清
        } catch (e) {
            console.log(`⚠️ fixture cleanup failed（TEST_ID 保留，入口 finally 再试一次，仍失败才计失败）: ${e.message}`);
        }
    }

    if (failures.length > 0) {
        for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
    }
    // helper 不再 process.exit：返回失败数，由入口在 teardown 之后 finish
    return failures.length;
}

(async () => {
    // ready() 在 try 之外、入口函数的第一条有副作用的语句：失败直接落到末尾 .catch（非零退出）
    await fx.ready();   // 先于任何写库 / 网络请求：自起隔离实例（或核对 TEST_* 变量组）
    let code = 1;
    try {
        BASE = fx.BASE;
        DB_PATH = fx.DB_PATH;
        const nFailed = await runTests();
        code = nFailed > 0 ? 1 : 0;
    } catch (e) {
        console.error('FATAL:', e);
    } finally {
        // [#106 S4c 收口] 夹具还在（runTests 里清理失败，或中途抛异常）就再试一次；仍失败必须计失败（code = 1），且不跳过 teardown
        if (TEST_ID) {
            await new Promise((r) => setTimeout(r, 200));   // [#106 S4c 送审前小修] 与 runTests 内第一次清理之间等 200ms（防事务外异步回写偶发 SQLITE_BUSY）
            try { await fx.cleanup(TEST_ID); TEST_ID = null; } catch (e) { console.error(`夹具清理失败 id=${TEST_ID}：${e.message}`); code = 1; }
        }
        try { await fx.teardown(); } catch (e) { console.error(`teardown 失败：${e.message}`); code = 1; }
    }
    fx.finish(code);   // teardown 已落定；只设退出码（见 lib/test-env.js finish），不在 finally 里调
})().catch(async (e) => {
    console.error('friction e2e 启动失败：', e && e.stack || e);
    try { await fx.teardown(); } catch (_) { /* 已在报错路径 */ }
    process.exit(1);
});
