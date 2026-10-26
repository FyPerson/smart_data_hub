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
 * 前置：入口 ready() 自起隔离实例，或核对批跑器给的 TEST_* 变量组（四个必须同时给）。fixture 独立，运行后 cleanup（DB + 落盘文件）。
 * 用法：node scripts/verify-collab-multifile-datascope.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const fx = require('./_test-fixture');
const testEnv = require('./lib/test-env');   // 仅用 env().dataDir；ready / teardown / finish 一律走 fx

// [#106 S4c-A1] 被测服务 / 实例库 / 实例上传目录来自 test-env：在 ready() 之后才赋值，不再写死 3000、业务库路径与检出里的 uploads。
//   UPLOAD_DIR = <实例数据根>/uploads（server.js 启动时创建）；数据根取不到（变量组形态下 sdh-instance.json 与实例不一致）时抛错，不静默跳过物理文件清理。
let BASE = null;
let DB_PATH = null;
let UPLOAD_DIR = null;
let COLLAB_PENDING = null;

const createdFixtureIds = [];

/** multipart 上传 N 个文件到 attachments endpoint（内容直接用内存 Buffer，不再落临时文件，因此也没有临时目录要删） */
async function uploadAttachments(reqId, token, attachmentType, files) {
    const fd = new FormData();
    fd.append('attachment_type', attachmentType);
    for (const { name, content } of files) {
        fd.append('files', new Blob([Buffer.from(content)]), name);
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

async function dbAll(sql, params) {
    const db = await fx.openInstanceDb(DB_PATH);
    return new Promise((resolve, reject) => {
        // 等 close 回调再落定：关库错误不丢，resolve 时句柄已关闭（语句错误优先）
        db.all(sql, params, (err, rows) => { db.close((cerr) => { const e = err || cerr; e ? reject(e) : resolve(rows); }); });
    });
}

/** 删目录树：逐项 lstat，链接只删链接本身不进入，文件 unlink、目录递归后 rmdir（不用 fs.rmSync：Node v24 对含中文路径静默不删）；目录不存在视为已清 */
function removeTreeChecked(dir) {
    let st;
    try { st = fs.lstatSync(dir); } catch (e) { if (e && e.code === 'ENOENT') return; throw e; }
    if (st.isSymbolicLink()) {
        try { fs.unlinkSync(dir); } catch (e) { if (e && (e.code === 'EPERM' || e.code === 'EISDIR')) fs.rmdirSync(dir); else throw e; }
        return;
    }
    if (st.isDirectory()) {
        for (const name of fs.readdirSync(dir)) removeTreeChecked(path.join(dir, name));
        fs.rmdirSync(dir);
    } else {
        fs.unlinkSync(dir);
    }
    try { fs.lstatSync(dir); } catch (e) { if (e && e.code === 'ENOENT') return; throw e; }
    throw new Error(`删除后仍存在：${dir}`);
}

/** 测试后清理落盘文件（DB 行由 fx.cleanup 经 FK CASCADE 删除，物理文件需手动清）。返回错误描述数组（文件已不存在不算错误） */
async function cleanupDisk(reqId) {
    const errs = [];
    try {
        const rows = await dbAll(
            'SELECT file_name FROM collab_attachments WHERE collab_request_id=?', [reqId]);
        for (const r of rows) {
            try { fs.unlinkSync(path.join(UPLOAD_DIR, r.file_name)); } catch (e) { if (!e || e.code !== 'ENOENT') errs.push(`unlink ${r.file_name}: ${e && e.message}`); }
        }
    } catch (e) { errs.push(`查附件行失败: ${e && e.message}`); }
    // 超量上传被 multer 拦截时 _pending/{id}/ 可能残留临时文件
    try { removeTreeChecked(path.join(COLLAB_PENDING, String(reqId))); } catch (e) { errs.push(`删 _pending/${reqId}: ${e && e.message}`); }
    return errs;
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
    // ready() 在 try 之外、入口函数的第一条有副作用的语句：失败直接落到末尾 .catch（非零退出）
    await fx.ready();   // 先于任何写库 / 网络请求：自起隔离实例（或核对 TEST_* 变量组）
    try {
        BASE = fx.BASE;
        DB_PATH = fx.DB_PATH;
        const dataDir = testEnv.env().dataDir;
        if (!dataDir) throw new Error('取不到实例数据根（env().dataDir 为 null）：无法确定实例的 uploads 目录，物理文件无法清理，拒绝继续');
        UPLOAD_DIR = path.join(dataDir, 'uploads');
        COLLAB_PENDING = path.join(UPLOAD_DIR, 'collab', '_pending');
        await runTests();
    } catch (e) {
        console.error('\n!! verify 运行异常：', e.message, e.stack);
        failed++;
    } finally {
        // [#106 S4c 收口] 夹具清理：每个编号单独 try/catch，落盘文件与库行都清掉才从追踪数组移除；落盘清理失败时先不删库行（后一轮还要靠附件行定位文件），
        //   剩余编号再试一轮；仍遗留的每个计 1 次失败，不中断后续清理与 teardown
        for (let round = 0; round < 2 && createdFixtureIds.length > 0; round++) {
            if (round > 0) await new Promise((r) => setTimeout(r, 200));   // [#106 S4c 送审前小修] 两轮之间等 200ms：防服务端事务外异步回写偶发 SQLITE_BUSY 被计失败
            for (const id of createdFixtureIds.slice()) {
                try {
                    const diskErrs = await cleanupDisk(id);
                    if (diskErrs.length) { console.error(`  ✗ 清理落盘文件失败 #${id}（第 ${round + 1} 轮）：${diskErrs.join('；')}`); continue; }
                    await fx.cleanup(id);
                    createdFixtureIds.splice(createdFixtureIds.indexOf(id), 1);
                } catch (e) { console.error(`cleanup ${id} failed (第 ${round + 1} 轮): ${e.message}`); }
            }
        }
        if (createdFixtureIds.length > 0) { console.error(`夹具清理失败，遗留协作单 id=${createdFixtureIds.join(',')}`); failed += createdFixtureIds.length; }
        try { await fx.teardown(); } catch (e) { console.error(`teardown 失败：${e.message}`); failed++; }
    }
    console.log(`\n== Summary: ${passed} pass / ${failed} fail ==`);
    fx.finish(failed === 0 ? 0 : 1);   // teardown 已落定；只设退出码（见 lib/test-env.js finish），不在 finally 里调
})().catch(async (e) => {
    console.error('multifile-datascope verify 启动失败：', e && e.stack || e);
    try { await fx.teardown(); } catch (_) { /* 已在报错路径 */ }
    process.exit(1);
});
