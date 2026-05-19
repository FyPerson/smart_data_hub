/**
 * D3 模块 4 提交 endpoint 集成测试
 *
 * 用法：node scripts/test-collab-submit-e2e.js
 *
 * 前置：
 *   - 本地 server 已启动（localhost:3000）
 *   - fixture 由 _test-fixture.js 动态创建（v3 协议）
 *
 * 6 个测试场景（对照 codex 九审归档的状态 × 结果对照表）：
 *   T1 健康 SQL 首次提交 → DONE
 *   T2 错字段 SQL → SUBMITTED + sql_validation_status=failed
 *   T3 危险 SQL（xp_）→ SUBMITTED + sql_validation_status=failed（layer 0）
 *   T4 多语句 → SUBMITTED + sql_validation_status=failed（layer 0）
 *   T5 非法 id（abc）→ 400
 *   T6 协作单不存在 → 404
 *
 * 每个测试：
 *   1. fixture 造一条 PENDING 协作单（admin 创建 + contact 指派 dev1）
 *   2. dev1 token POST /:id/submit 含 multipart files
 *   3. 校验 HTTP code + JSON 关键字段
 *   4. 查 task_pool.db 看状态字段是否符合预期
 *   5. cleanup fixture
 *
 * v3 二级转派改造（2026-05-19）：
 *   - admin 不能代提交（codex 十六审决策 #4），改用 dev1 身份提交
 *   - 每个测试独立 fixture（避免状态串扰，submit 推到 DONE/SUBMITTED 后不能复用）
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { tmpdir } = require('os');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');

// 必须先 require dotenv，让 .env 的 JWT_SECRET 加载到 process.env
// 否则用 fallback 签出的 token 跟 server 校验对不上（feedback_playwright_jwt_inject 踩坑）
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';

// v3 二级转派后 fixture 动态创建（2026-05-19）
const fx = require('./_test-fixture');

let token = null;        // dev1 token（v3 后 admin 不能代提交）
let testTmpDir = null;
const createdFixtureIds = [];  // 待 cleanup 的 fixture id 列表

function makeTmpFile(filename, content) {
    if (!testTmpDir) testTmpDir = fs.mkdtempSync(path.join(tmpdir(), 'collab-submit-test-'));
    const p = path.join(testTmpDir, filename);
    fs.writeFileSync(p, content);
    return p;
}

async function postSubmit(reqId, files) {
    const fd = new FormData();
    for (const { name, content } of files) {
        const filePath = makeTmpFile(name, content);
        const buf = fs.readFileSync(filePath);
        fd.append('files', new Blob([buf]), name);
    }
    const res = await fetch(`${BASE}/api/collab/requests/${reqId}/submit`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: fd,
    });
    let body;
    try { body = await res.json(); } catch (e) { body = { _raw: await res.text() }; }
    return { status: res.status, body };
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

// v3 改造：每个测试创建独立 fixture，避免状态串扰
// 返回 PENDING 状态的 collab id（dev1 已被指派）
async function freshFixture() {
    const ctx = await fx.createPendingFixture();
    createdFixtureIds.push(ctx.id);
    if (!token) token = ctx.dev1Token;  // 首次设置 dev1 token
    return ctx.id;
}

// === 6 个测试 ===

async function runTests() {
    // v3：先造一个 fixture 拿到 dev1Token（admin 不能代提交，必须用 developer 本人 token）
    const probe = await fx.createPendingFixture();
    token = probe.dev1Token;
    createdFixtureIds.push(probe.id);
    console.log(`✅ tokens prepared (dev1) + probe fixture id=${probe.id}`);

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

    // T1: 健康 SQL 首次提交 → DONE
    await check('T1 健康 SQL 首次提交 → DONE', async () => {
        const id = await freshFixture();
        const r = await postSubmit(id, [
            { name: 'result.xlsx', content: 'fake xlsx binary content not validated' },
            { name: 'script.sql', content: 'SELECT 1 AS health_check' },
        ]);
        if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body).slice(0,200)}`);
        if (r.body.business_error) throw new Error(`unexpected business_error: ${JSON.stringify(r.body)}`);
        if (r.body.current_status !== 'DONE') throw new Error(`current_status=${r.body.current_status}, expected DONE`);
        if (r.body.sql_validation_status !== 'passed') throw new Error(`sql_validation_status=${r.body.sql_validation_status}`);

        // DB 校验
        const row = await dbGet(`SELECT status, submission_version, sql_validation_status FROM collab_requests WHERE id=?`, [id]);
        if (row.status !== 'DONE') throw new Error(`DB status=${row.status}`);
        if (row.submission_version !== 1) throw new Error(`DB submission_version=${row.submission_version}, expected 1`);
        if (row.sql_validation_status !== 'passed') throw new Error(`DB sql_validation_status=${row.sql_validation_status}`);
    });

    // T2: 错字段 SQL → SUBMITTED + failed
    await check('T2 错字段 SQL → SUBMITTED + failed', async () => {
        const id = await freshFixture();
        const r = await postSubmit(id, [
            { name: 'result.xlsx', content: 'fake xlsx' },
            { name: 'script.sql', content: 'SELECT ContTotalSum FROM crm_bid' },
        ]);
        if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body).slice(0,200)}`);
        if (!r.body.business_error) throw new Error(`expected business_error=true`);
        if (r.body.sql_validation_status !== 'failed') throw new Error(`expected failed, got ${r.body.sql_validation_status}`);
        if (!/ContTotalSum/i.test(r.body.sql_validation_error || '')) throw new Error(`error 应含 ContTotalSum: ${r.body.sql_validation_error}`);

        const row = await dbGet(`SELECT status, sql_validation_status, sql_validation_error FROM collab_requests WHERE id=?`, [id]);
        if (row.status !== 'SUBMITTED') throw new Error(`DB status=${row.status}, expected SUBMITTED`);
        if (row.sql_validation_status !== 'failed') throw new Error(`DB sql_validation_status=${row.sql_validation_status}`);
    });

    // T3: 危险 SQL (xp_) → SUBMITTED + failed at layer 0
    await check('T3 危险 SQL xp_ → SUBMITTED + failed', async () => {
        const id = await freshFixture();
        const r = await postSubmit(id, [
            { name: 'result.xlsx', content: 'fake xlsx' },
            { name: 'script.sql', content: "EXEC xp_dirtree 'C:\\'" },
        ]);
        if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body).slice(0,200)}`);
        if (!r.body.business_error) throw new Error(`expected business_error=true`);
        if (!/layer 0/i.test(r.body.sql_validation_error || '')) throw new Error(`expected layer 0 error: ${r.body.sql_validation_error}`);
    });

    // T4: 多语句 → SUBMITTED + failed at layer 0
    await check('T4 多语句 → SUBMITTED + failed', async () => {
        const id = await freshFixture();
        const r = await postSubmit(id, [
            { name: 'result.xlsx', content: 'fake xlsx' },
            { name: 'script.sql', content: 'SELECT 1; DROP TABLE foo;' },
        ]);
        if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body).slice(0,200)}`);
        if (!r.body.business_error) throw new Error(`expected business_error=true`);
    });

    // T5: 非法 id（abc）→ 400
    await check('T5 非法 id → 400', async () => {
        const r = await postSubmit('abc', [
            { name: 'result.xlsx', content: 'fake' },
            { name: 'script.sql', content: 'SELECT 1' },
        ]);
        if (r.status !== 400) throw new Error(`HTTP ${r.status}, expected 400`);
    });

    // T6: 不存在的协作单 → 404
    await check('T6 协作单不存在 → 404', async () => {
        const r = await postSubmit(99999, [
            { name: 'result.xlsx', content: 'fake' },
            { name: 'script.sql', content: 'SELECT 1' },
        ]);
        if (r.status !== 404) throw new Error(`HTTP ${r.status}, expected 404`);
    });

    console.log(`\n=== D3 模块 4 集成测试 ===`);
    console.log(`总数: ${passed + failed}, 通过: ${passed}, 失败: ${failed}`);

    // 清理 fixture（v3 改造，每个测试独立单需统一清掉）
    let cleanedCount = 0;
    for (const id of createdFixtureIds) {
        try { await fx.cleanup(id); cleanedCount++; } catch (e) {
            console.log(`⚠️ cleanup id=${id} 失败: ${e.message}`);
        }
    }
    console.log(`✅ fixtures cleaned up: ${cleanedCount}/${createdFixtureIds.length}`);

    if (failures.length > 0) {
        console.log('\n失败详情:');
        failures.forEach(f => console.log(`  ❌ ${f.name}: ${f.error}`));
        process.exit(1);
    }
    console.log('\n全部通过 ✅');

    // 清理 tmp 目录
    if (testTmpDir) {
        try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch {}
    }
}

runTests().catch(async (e) => {
    console.error('测试执行异常:', e);
    for (const id of createdFixtureIds) {
        try { await fx.cleanup(id); } catch (_) { }
    }
    process.exit(1);
});
