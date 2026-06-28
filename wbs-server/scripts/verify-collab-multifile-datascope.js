/**
 * 数据协作·多文件上传 M1 verify —— 建单·数据范围（data_scope）多文件放开
 *
 * 方案：数据协作模块_多文件上传_方案_20260625_v1.1.2.md §A + §七
 *
 * 验证（POST /api/collab/requests/:id/attachments，attachment_type=data_scope）：
 *   T1 单文件（1 个）→ 200，入库 1 行（既有行为不回归，单文件仍可上传）
 *   T2 多文件（5 个，上限）→ 200，入库 5 行，attachment_seq 连续递增、上传序=入库序（D1）
 *   T3 超量（6 个）→ 400，错误文案以 multer LIMIT_FILE_COUNT 为准「单次最多上传 5 个文件」
 *      （RC-M4 验收口径：超量对外文案以 multer 为准；array('files',5) 在第 6 个文件即前置拦截，
 *       应用层 >5 分支为防御性兜底，本路由下不会被独立触发，故不对其单独断言）
 *   T4 非 data_scope（screenshot 多文件）不受本次改动影响 → 仍可多文件入库（隔离回归）
 *
 * 前置：本地 server 已启动（localhost:3000）。fixture 独立，运行后 cleanup（DB + 落盘文件）。
 * 用法：node scripts/verify-collab-multifile-datascope.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { tmpdir } = require('os');
const sqlite3 = require('sqlite3').verbose();
const fx = require('./_test-fixture');

const BASE = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const COLLAB_PENDING = path.join(UPLOAD_DIR, 'collab', '_pending');

const createdFixtureIds = [];
let testTmpDir = null;

function makeTmpFile(filename, content) {
    if (!testTmpDir) testTmpDir = fs.mkdtempSync(path.join(tmpdir(), 'collab-multifile-ds-'));
    const p = path.join(testTmpDir, filename);
    fs.writeFileSync(p, content);
    return p;
}

/** multipart 上传 N 个文件到 attachments endpoint */
async function uploadAttachments(reqId, token, attachmentType, files) {
    const fd = new FormData();
    fd.append('attachment_type', attachmentType);
    for (const { name, content } of files) {
        const buf = fs.readFileSync(makeTmpFile(name, content));
        fd.append('files', new Blob([buf]), name);
    }
    const r = await fetch(`${BASE}/api/collab/requests/${reqId}/attachments`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: fd,
    });
    let j = null;
    try { j = await r.json(); } catch (_) { }
    return { status: r.status, body: j };
}

function dbAll(sql, params) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH);
        db.all(sql, params, (err, rows) => { db.close(); err ? reject(err) : resolve(rows); });
    });
}

/** 测试后清理落盘文件（DB 行由 fx.cleanup 经 FK CASCADE 删除，物理文件需手动清） */
async function cleanupDisk(reqId) {
    try {
        const rows = await dbAll(
            'SELECT file_name FROM collab_attachments WHERE collab_request_id=?', [reqId]);
        for (const r of rows) {
            try { fs.unlinkSync(path.join(UPLOAD_DIR, r.file_name)); } catch (_) { }
        }
    } catch (_) { }
    // 超量上传被 multer 拦截时 _pending/{id}/ 可能残留临时文件
    try { fs.rmSync(path.join(COLLAB_PENDING, String(reqId)), { recursive: true, force: true }); } catch (_) { }
}

let passed = 0, failed = 0;
function assert(cond, label) {
    if (cond) { console.log(`  ✓ ${label}`); passed++; }
    else { console.log(`  ✗ ${label}`); failed++; }
}

function mkFiles(n, prefix, ext = '.txt') {
    return Array.from({ length: n }, (_, i) =>
        ({ name: `${prefix}_${i + 1}${ext}`, content: `${prefix} content ${i + 1}\n` }));
}

async function runTests() {
    console.log('\n=== T1: data_scope 单文件 → 200 入库 1 行（单文件不回归）===');
    {
        const ctx = await fx.createPendingFixture();
        createdFixtureIds.push(ctx.id);
        const res = await uploadAttachments(ctx.id, ctx.adminToken, 'data_scope', mkFiles(1, 'ds1'));
        assert(res.status === 200, `T1 status=200, got ${res.status} body=${JSON.stringify(res.body).slice(0, 200)}`);
        assert(res.body && Array.isArray(res.body.attachments) && res.body.attachments.length === 1,
            `T1 返回 attachments=1, got ${res.body && res.body.attachments && res.body.attachments.length}`);
        const rows = await dbAll(
            `SELECT id, attachment_seq FROM collab_attachments WHERE collab_request_id=? AND attachment_type='data_scope' ORDER BY id ASC`, [ctx.id]);
        assert(rows.length === 1, `T1 db data_scope 行=1, got ${rows.length}`);
    }

    console.log('\n=== T2: data_scope 5 文件 → 200 入库 5 行 + seq 连续递增（D1 保序）===');
    {
        const ctx = await fx.createPendingFixture();
        createdFixtureIds.push(ctx.id);
        const res = await uploadAttachments(ctx.id, ctx.adminToken, 'data_scope', mkFiles(5, 'ds5'));
        assert(res.status === 200, `T2 status=200, got ${res.status} body=${JSON.stringify(res.body).slice(0, 200)}`);
        assert(res.body && res.body.attachments && res.body.attachments.length === 5,
            `T2 返回 attachments=5, got ${res.body && res.body.attachments && res.body.attachments.length}`);
        // codex L-2：核对用户可见返回体（res.body.attachments）顺序 = 上传序（inserted 数组按上传序 push）
        const respOrderOk = res.body.attachments.every((a, i) => a.original_name === `ds5_${i + 1}.txt`);
        assert(respOrderOk, `T2 返回体顺序=上传序 (${res.body.attachments.map(a => a.original_name).join(',')})`);
        const rows = await dbAll(
            `SELECT id, attachment_seq, original_name FROM collab_attachments WHERE collab_request_id=? AND attachment_type='data_scope' ORDER BY id ASC`, [ctx.id]);
        assert(rows.length === 5, `T2 db data_scope 行=5, got ${rows.length}`);
        // seq 连续递增（baseSeq + i），上传序 = 入库 id 序 = original_name 序
        const seqOk = rows.every((r, i) => r.attachment_seq === rows[0].attachment_seq + i);
        assert(seqOk, `T2 attachment_seq 连续递增 (${rows.map(r => r.attachment_seq).join(',')})`);
        const orderOk = rows.every((r, i) => r.original_name === `ds5_${i + 1}.txt`);
        assert(orderOk, `T2 上传序=入库序 (${rows.map(r => r.original_name).join(',')})`);
    }

    console.log('\n=== T3: data_scope 6 文件 → 400 multer LIMIT_FILE_COUNT 友好文案（RC-M4）===');
    {
        const ctx = await fx.createPendingFixture();
        createdFixtureIds.push(ctx.id);
        const res = await uploadAttachments(ctx.id, ctx.adminToken, 'data_scope', mkFiles(6, 'ds6'));
        assert(res.status === 400, `T3 status=400, got ${res.status} body=${JSON.stringify(res.body).slice(0, 200)}`);
        assert(res.body && /单次最多上传 5 个文件/.test(res.body.error || ''),
            `T3 文案=「单次最多上传 5 个文件」(multer 层), got ${res.body && res.body.error}`);
        // 超量被前置拦截 → 一行都不入库
        const rows = await dbAll(
            `SELECT id FROM collab_attachments WHERE collab_request_id=? AND attachment_type='data_scope'`, [ctx.id]);
        assert(rows.length === 0, `T3 超量拦截后 0 行入库, got ${rows.length}`);
    }

    console.log('\n=== T4: screenshot 多文件不受 data_scope 改动影响（隔离回归）===');
    {
        const ctx = await fx.createPendingFixture();
        createdFixtureIds.push(ctx.id);
        const res = await uploadAttachments(ctx.id, ctx.adminToken, 'screenshot',
            mkFiles(3, 'sc3', '.png'));
        assert(res.status === 200, `T4 status=200, got ${res.status} body=${JSON.stringify(res.body).slice(0, 200)}`);
        assert(res.body && res.body.attachments && res.body.attachments.length === 3,
            `T4 screenshot 多文件仍入库 3 行, got ${res.body && res.body.attachments && res.body.attachments.length}`);
    }
}

(async () => {
    try {
        await runTests();
    } catch (e) {
        console.error('\n!! verify 运行异常：', e.message, e.stack);
        failed++;
    } finally {
        for (const id of createdFixtureIds) {
            await cleanupDisk(id);
            try { await fx.cleanup(id); } catch (e) { console.error('cleanup failed:', e.message); }
        }
        if (testTmpDir) { try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch (_) { } }
        console.log(`\n== Summary: ${passed} pass / ${failed} fail ==`);
        process.exit(failed === 0 ? 0 : 1);
    }
})();
