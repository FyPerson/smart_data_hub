/**
 * v1.70.0 方案 §1.2 撞墙附件保留 e2e 测试
 *
 * 用法：node scripts/test-collab-failed-retention-e2e.js
 *
 * 前置：
 *   - 本地 server 已启动（localhost:3000）
 *   - 本地数据库已 ALTER 加 failed_at/failed_reason/failed_attempt_seq 三字段 + UNIQUE 部分索引
 *
 * 5 个测试场景：
 *   T1 smoke 失败 1 次 → 业务错 + failed 行 INSERT + 物理文件保留
 *   T2 smoke 失败 2 次 → failed_attempt_seq=1,2 + UNIQUE 不冲突
 *   T3 GET attachments 返 failed_at/failed_reason/failed_attempt_seq 字段齐全
 *   T4 admin DELETE failed 附件（PENDING 状态）→ 删 DB 行 + 删物理文件
 *   T5 BEGIN IMMEDIATE 并发：两个 fixture 并发触发 smoke 失败 → 各自 failed_attempt_seq=1（不串）
 *
 * v1.70.0 改造点对照：
 *   - activateNewVersion SMOKE_TEST_FAILED 分支不删文件，走 insertFailedAttachments
 *   - server.js endpoint 返回 failed_attempt_seq + failed_attachments
 *   - DELETE attachment endpoint 加 failed 跨状态分支
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { tmpdir } = require('os');
const sqlite3 = require('sqlite3').verbose();

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fx = require('./_test-fixture');
const BASE = fx.BASE;
const DB_PATH = fx.DB_PATH;

const createdFixtureIds = [];
let testTmpDir = null;

function makeTmpFile(filename, content) {
    if (!testTmpDir) testTmpDir = fs.mkdtempSync(path.join(tmpdir(), 'collab-failed-retention-'));
    const p = path.join(testTmpDir, filename);
    fs.writeFileSync(p, content);
    return p;
}

async function postSubmit(reqId, token, files) {
    const fd = new FormData();
    for (const { name, content } of files) {
        const filePath = makeTmpFile(name + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), content);
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

async function getAttachments(reqId, token) {
    const res = await fetch(`${BASE}/api/collab/requests/${reqId}/attachments`, {
        headers: { authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    return { status: res.status, body };
}

async function deleteAttachment(attId, token) {
    const res = await fetch(`${BASE}/api/collab/attachments/${attId}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
    });
    let body;
    try { body = await res.json(); } catch (_) { body = {}; }
    return { status: res.status, body };
}

function dbAll(sql, params) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH);
        db.all(sql, params, (err, rows) => {
            db.close();
            err ? reject(err) : resolve(rows || []);
        });
    });
}

async function freshFixture() {
    const ctx = await fx.createPendingFixture();
    createdFixtureIds.push(ctx.id);
    return ctx;
}

const BAD_SQL = 'SELECT ContTotalSum FROM crm_bid';  // 字段不存在，会撞墙
const GOOD_SQL = 'SELECT 1 AS health_check';

async function runTests() {
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

    // T1: smoke 失败 1 次 → business_error + failed 行 INSERT + 物理文件保留
    await check('T1 smoke 失败 1 次 → failed 行 INSERT + 物理文件保留', async () => {
        const ctx = await freshFixture();
        const r = await postSubmit(ctx.id, ctx.dev1Token, [
            { name: 'result.xlsx', content: 'fake xlsx' },
            { name: 'script.sql', content: BAD_SQL },
        ]);
        if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
        if (!r.body.business_error) throw new Error(`expected business_error=true, got: ${JSON.stringify(r.body)}`);
        if (r.body.failed_attempt_seq !== 1) throw new Error(`expected failed_attempt_seq=1, got ${r.body.failed_attempt_seq}`);
        if (!Array.isArray(r.body.failed_attachments) || r.body.failed_attachments.length !== 2) {
            throw new Error(`expected failed_attachments=2 个, got ${JSON.stringify(r.body.failed_attachments)}`);
        }

        // DB 校验 status='failed' 行存在
        const rows = await dbAll(
            `SELECT id, attachment_type, file_name, status, failed_attempt_seq, failed_reason, failed_at
               FROM collab_attachments WHERE collab_request_id=? AND status='failed'`,
            [ctx.id]
        );
        if (rows.length !== 2) throw new Error(`DB failed 行数 ${rows.length}，期望 2`);
        for (const r2 of rows) {
            if (r2.failed_attempt_seq !== 1) throw new Error(`failed_attempt_seq=${r2.failed_attempt_seq}，期望 1`);
            if (!r2.failed_at) throw new Error('failed_at 缺失');
            if (!r2.failed_reason || !/ContTotalSum/i.test(r2.failed_reason)) {
                throw new Error(`failed_reason 应含 ContTotalSum: ${r2.failed_reason}`);
            }
            // 物理文件应保留
            // file_name 形如 'collab/{rid}_xxx/{ts}_{rand}_name.ext'（activateNewVersion §3.6 relPath 已含 collab/ 前缀）
            // 用 collab-submit-helpers.resolveAttachmentPath 走和生产同样的拼接逻辑
            const helpers = require('../utils/collab-submit-helpers');
            const fullPath = helpers.resolveAttachmentPath(r2.file_name);
            if (!fs.existsSync(fullPath)) {
                throw new Error(`物理文件应保留但不存在: ${fullPath} (DB file_name: ${r2.file_name})`);
            }
        }
    });

    // T2: smoke 失败 2 次 → failed_attempt_seq=1, 2 + UNIQUE 不冲突
    await check('T2 smoke 失败 2 次 → seq=1,2 UNIQUE 不冲突', async () => {
        const ctx = await freshFixture();

        // 第一次失败
        const r1 = await postSubmit(ctx.id, ctx.dev1Token, [
            { name: 'result.xlsx', content: 'fake xlsx 1' },
            { name: 'script.sql', content: BAD_SQL },
        ]);
        if (!r1.body.business_error || r1.body.failed_attempt_seq !== 1) {
            throw new Error(`第 1 次失败异常: seq=${r1.body.failed_attempt_seq}`);
        }

        // 第二次失败
        const r2 = await postSubmit(ctx.id, ctx.dev1Token, [
            { name: 'result.xlsx', content: 'fake xlsx 2' },
            { name: 'script.sql', content: BAD_SQL },
        ]);
        if (!r2.body.business_error || r2.body.failed_attempt_seq !== 2) {
            throw new Error(`第 2 次失败异常: seq=${r2.body.failed_attempt_seq}`);
        }

        // DB 校验 4 行 failed（2 attempt × 2 attachment_type）
        const rows = await dbAll(
            `SELECT attachment_type, failed_attempt_seq FROM collab_attachments
              WHERE collab_request_id=? AND status='failed' ORDER BY failed_attempt_seq, attachment_type`,
            [ctx.id]
        );
        if (rows.length !== 4) throw new Error(`期望 4 行 failed，实际 ${rows.length}`);
        const seqs = rows.map(r => `${r.attachment_type}#${r.failed_attempt_seq}`).sort();
        const expect = ['result_data#1', 'result_data#2', 'result_script#1', 'result_script#2'];
        if (JSON.stringify(seqs) !== JSON.stringify(expect)) {
            throw new Error(`期望 ${JSON.stringify(expect)}, 实际 ${JSON.stringify(seqs)}`);
        }
    });

    // T3: GET attachments 返 failed_at/failed_reason/failed_attempt_seq 字段齐全
    await check('T3 GET attachments 返 failed_* 字段齐全', async () => {
        const ctx = await freshFixture();
        await postSubmit(ctx.id, ctx.dev1Token, [
            { name: 'result.xlsx', content: 'fake' },
            { name: 'script.sql', content: BAD_SQL },
        ]);
        const r = await getAttachments(ctx.id, ctx.dev1Token);
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        const failedRows = r.body.filter(a => a.status === 'failed');
        if (failedRows.length !== 2) throw new Error(`GET 返 ${failedRows.length} failed 行，期望 2`);
        for (const fr of failedRows) {
            if (!fr.failed_at) throw new Error('GET 返 failed_at 缺失');
            if (!fr.failed_reason) throw new Error('GET 返 failed_reason 缺失');
            if (fr.failed_attempt_seq !== 1) throw new Error(`GET 返 failed_attempt_seq=${fr.failed_attempt_seq}`);
        }
    });

    // T4: admin DELETE failed 附件（PENDING 状态）→ 删 DB 行 + 删物理文件
    await check('T4 admin DELETE failed 附件 → DB+文件双删', async () => {
        const ctx = await freshFixture();
        const r = await postSubmit(ctx.id, ctx.dev1Token, [
            { name: 'result.xlsx', content: 'fake' },
            { name: 'script.sql', content: BAD_SQL },
        ]);
        const targetAttId = r.body.failed_attachments[0].id;
        const targetFileName = r.body.failed_attachments[0].file_name;
        const helpers = require('../utils/collab-submit-helpers');
        const fullPath = helpers.resolveAttachmentPath(targetFileName);
        if (!fs.existsSync(fullPath)) throw new Error(`前置：物理文件不存在 ${fullPath} (DB file_name: ${targetFileName})`);

        const delRes = await deleteAttachment(targetAttId, ctx.adminToken);
        if (delRes.status !== 200) throw new Error(`DELETE HTTP ${delRes.status}: ${JSON.stringify(delRes.body)}`);

        // DB 行已删
        const rows = await dbAll(`SELECT id FROM collab_attachments WHERE id=?`, [targetAttId]);
        if (rows.length !== 0) throw new Error(`DB 行未删除`);
        // 物理文件已删
        if (fs.existsSync(fullPath)) throw new Error(`物理文件未删除 ${fullPath}`);
    });

    // T5: BEGIN IMMEDIATE 并发：两个 fixture 并发触发 smoke 失败 → 各自 seq=1（不串）
    // 注：这里测的是"跨协作单不串"，单协作单内并发由 globalSmokeTestMutex 串行化（runRealSmokeTest 包装）
    await check('T5 跨协作单并发 smoke 失败 → 各自 seq=1 不串', async () => {
        const ctx1 = await freshFixture();
        const ctx2 = await freshFixture();
        const [r1, r2] = await Promise.all([
            postSubmit(ctx1.id, ctx1.dev1Token, [
                { name: 'result.xlsx', content: 'fake1' },
                { name: 'script.sql', content: BAD_SQL },
            ]),
            postSubmit(ctx2.id, ctx2.dev1Token, [
                { name: 'result.xlsx', content: 'fake2' },
                { name: 'script.sql', content: BAD_SQL },
            ]),
        ]);
        if (!r1.body.business_error || r1.body.failed_attempt_seq !== 1) {
            throw new Error(`ctx1 异常: seq=${r1.body.failed_attempt_seq}, body=${JSON.stringify(r1.body)}`);
        }
        if (!r2.body.business_error || r2.body.failed_attempt_seq !== 1) {
            throw new Error(`ctx2 异常: seq=${r2.body.failed_attempt_seq}, body=${JSON.stringify(r2.body)}`);
        }
        // DB 各自 2 行 failed seq=1
        for (const cid of [ctx1.id, ctx2.id]) {
            const rows = await dbAll(
                `SELECT failed_attempt_seq FROM collab_attachments WHERE collab_request_id=? AND status='failed'`,
                [cid]
            );
            if (rows.length !== 2) throw new Error(`ctx ${cid} 应有 2 行 failed，实际 ${rows.length}`);
            for (const r of rows) {
                if (r.failed_attempt_seq !== 1) throw new Error(`ctx ${cid} seq=${r.failed_attempt_seq}，期望 1`);
            }
        }
    });

    // T6: v1.70.2 ⑥ 修复验证 — 开发 smoke 通过后，admin 同期上传的 example_xlsx + screenshot 仍 active 不被误 superseded
    await check('T6 ⑥ 开发首次 smoke 通过 → admin 同期 example_xlsx/screenshot 仍 active（v1.70.2 修 superseded WHERE）', async () => {
        const ctx = await freshFixture();
        // 模拟 admin 创建时上传 1 个 example_xlsx + 1 个 screenshot（直接 DB INSERT，跳过 multer 复杂度）
        // 这两类附件 submission_version=0 status='active' 是真实业务场景
        await new Promise((resolve, reject) => {
            const db = new sqlite3.Database(path.join(__dirname, '..', 'task_pool.db'));
            db.serialize(() => {
                const stmt = db.prepare(`
                    INSERT INTO collab_attachments
                        (collab_request_id, attachment_type, file_name, original_name,
                         uploaded_by, uploaded_by_name, submission_version, status, superseded_at)
                    VALUES (?, ?, ?, ?, ?, ?, 0, 'active', NULL)
                `);
                stmt.run([ctx.id, 'example_xlsx', `collab/${ctx.id}_e2e/template.xlsx`, 'template.xlsx', 5, 'admin']);
                stmt.run([ctx.id, 'screenshot', `collab/${ctx.id}_e2e/oa.png`, 'oa.png', 5, 'admin']);
                stmt.finalize((e) => { db.close(); e ? reject(e) : resolve(); });
            });
        });

        // 开发提交健康 SQL → smoke 通过 → activateNewVersion 走 supersede 路径
        const r = await postSubmit(ctx.id, ctx.dev1Token, [
            { name: 'result.xlsx', content: 'fake xlsx' },
            { name: 'script.sql', content: GOOD_SQL },
        ]);
        if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
        if (r.body.business_error) throw new Error(`期望 smoke 通过，实际 business_error: ${JSON.stringify(r.body)}`);

        // 核心断言：example_xlsx + screenshot 应仍 active（未被误 superseded）
        const rows = await dbAll(
            `SELECT attachment_type, status, superseded_at
               FROM collab_attachments
              WHERE collab_request_id = ?
                AND attachment_type IN ('example_xlsx', 'screenshot')`,
            [ctx.id]
        );
        if (rows.length !== 2) throw new Error(`期望 2 行（example_xlsx + screenshot），实际 ${rows.length}`);
        for (const r2 of rows) {
            if (r2.status !== 'active') {
                throw new Error(`${r2.attachment_type} 应 status='active'，实际 '${r2.status}'（v1.70.2 superseded WHERE 修复未生效）`);
            }
            if (r2.superseded_at != null) {
                throw new Error(`${r2.attachment_type} 应 superseded_at=NULL，实际 '${r2.superseded_at}'`);
            }
        }

        // 第一次提交 oldVer=0 没有旧 result_* 行，supersede 路径无目标 — 反向断言留 T6b

        // T6b: codex 28 审 #3 补 — 第 2 次成功提交时 supersede 路径仍正确（v1 result_* → superseded, v2 → active, admin 附件仍 active）
        // 第 1 次提交后 collab 状态已 DONE，需推回 PENDING 才能第 2 次提交（v1.67.1 DONE→重新上传走 submitDeliveryModal）
        // 直接 setCollabState 推回让开发能再次 submit
        await fx.setCollabState(ctx.id, {
            status: 'PENDING',
            sql_validation_status: null,
            sql_validation_error: null
        });

        // 第 2 次提交健康 SQL → smoke 通过 → activateNewVersion oldVer=1 → supersede v1 result_* + INSERT v2 active result_*
        const r2 = await postSubmit(ctx.id, ctx.dev1Token, [
            { name: 'result_v2.xlsx', content: 'fake xlsx v2' },
            { name: 'script_v2.sql', content: GOOD_SQL },
        ]);
        if (r2.status !== 200) throw new Error(`v2 HTTP ${r2.status}: ${JSON.stringify(r2.body).slice(0, 200)}`);
        if (r2.body.business_error) throw new Error(`期望 v2 smoke 通过，实际 business_error: ${JSON.stringify(r2.body)}`);

        // 核心反向断言 — 4 个状态都要对：
        //   v1 result_data + result_script: superseded（被正确 supersede）
        //   v2 result_data + result_script: active（新版本上位）
        //   admin example_xlsx + screenshot: 仍 active（不被误超）
        const allRows = await dbAll(
            `SELECT attachment_type, status, submission_version, superseded_at
               FROM collab_attachments
              WHERE collab_request_id = ?
              ORDER BY submission_version, attachment_type`,
            [ctx.id]
        );

        // 期望 6 行：v0 example_xlsx active / v0 screenshot active / v1 result_data superseded / v1 result_script superseded / v2 result_data active / v2 result_script active
        if (allRows.length !== 6) throw new Error(`期望 6 行附件，实际 ${allRows.length}：${JSON.stringify(allRows)}`);

        const summary = allRows.map(r => `v${r.submission_version} ${r.attachment_type}=${r.status}`).join(' | ');

        // v0 admin 附件（example_xlsx + screenshot）必须 active
        const adminAttachments = allRows.filter(r => r.submission_version === 0);
        if (adminAttachments.length !== 2) throw new Error(`v0 admin 附件期望 2 行，实际 ${adminAttachments.length}（${summary}）`);
        for (const r of adminAttachments) {
            if (r.status !== 'active') throw new Error(`v0 ${r.attachment_type} 期望 active，实际 ${r.status}（${summary}）`);
        }

        // v1 result_* 必须 superseded
        const v1Results = allRows.filter(r => r.submission_version === 1);
        if (v1Results.length !== 2) throw new Error(`v1 result_* 期望 2 行，实际 ${v1Results.length}（${summary}）`);
        for (const r of v1Results) {
            if (r.status !== 'superseded') throw new Error(`v1 ${r.attachment_type} 期望 superseded（被新版本覆盖），实际 ${r.status}（${summary}）`);
            if (r.superseded_at == null) throw new Error(`v1 ${r.attachment_type} superseded_at 不应为 NULL`);
        }

        // v2 result_* 必须 active
        const v2Results = allRows.filter(r => r.submission_version === 2);
        if (v2Results.length !== 2) throw new Error(`v2 result_* 期望 2 行，实际 ${v2Results.length}（${summary}）`);
        for (const r of v2Results) {
            if (r.status !== 'active') throw new Error(`v2 ${r.attachment_type} 期望 active，实际 ${r.status}（${summary}）`);
        }
    });

    console.log(`\n=== v1.70.0 撞墙附件保留 e2e ===`);
    console.log(`总数: ${passed + failed}, 通过: ${passed}, 失败: ${failed}`);

    // cleanup
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

    if (testTmpDir) {
        try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch (_) { }
    }
}

runTests().catch(async (e) => {
    console.error('测试执行异常:', e);
    for (const id of createdFixtureIds) {
        try { await fx.cleanup(id); } catch (_) { }
    }
    process.exit(1);
});
