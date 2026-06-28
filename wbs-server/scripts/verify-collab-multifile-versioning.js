/**
 * 数据协作·多文件上传 M2 verify（二）—— activateNewVersion + 文件名唯一 + failed seq（半集成）
 *
 * 方案：数据协作模块_多文件上传_方案_20260625_v1.1.2.md §B/§五.2-3 + §七 activate/firstpick/fileunique
 *
 * 半集成（临时 sqlite + 临时 fs + mock smoke，不依赖 warehouse 真连）覆盖 M2 核心高风险：
 *   T-A passed（H-1 + RC-H1 + M-4）：2 data + 2 script → 全 active 同版本(H-1 放宽)
 *        + 4 个磁盘物理文件**互不覆盖**(RC-H1 typeOrdinal) + smoke 收到**第一份**上传脚本(M-4 取首非最后)
 *   T-B supersede：v1→v2 → 旧版本 4 行全 superseded、新版本 active（多文件版本切换不变量）
 *   T-C failed（H-2 + RC-H1 failed）：2 data + 2 script + mock smoke 失败 → SMOKE_TEST_FAILED
 *        + failed_attempt_seq 每类型逐文件 1,2 不撞唯一索引(H-2) + 4 个 failed 磁盘文件互不覆盖(RC-H1 failed)
 *        + failedAttachments 返回 original_name
 *   T-D naming：buildFinalAttachmentName typeOrdinal active/failed × ordinal 1/2 四名互异（函数级 RC-H1）
 *
 * 用法：node scripts/verify-collab-multifile-versioning.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const sqlite3 = require('sqlite3').verbose();
const ver = require('../utils/collab-attachment-versioning');

let passed = 0, failed = 0;
function assert(cond, label) {
    if (cond) { console.log(`  ✓ ${label}`); passed++; }
    else { console.log(`  ✗ ${label}`); failed++; }
}

// ── 临时环境 ──────────────────────────────────────────────
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-mf-ver-'));
const collabRoot = path.join(tmpRoot, 'uploads', 'collab');
fs.mkdirSync(collabRoot, { recursive: true });
const dbPath = path.join(tmpRoot, 'test.db');
const db = new sqlite3.Database(dbPath);

const dbAsync = {
    runAsync: (sql, params = []) => new Promise((res, rej) =>
        db.run(sql, params, function (e) { e ? rej(e) : res({ lastID: this.lastID, changes: this.changes }); })),
    getAsync: (sql, params = []) => new Promise((res, rej) =>
        db.get(sql, params, (e, row) => e ? rej(e) : res(row))),
    allAsync: (sql, params = []) => new Promise((res, rej) =>
        db.all(sql, params, (e, rows) => e ? rej(e) : res(rows))),
};

async function initSchema() {
    await dbAsync.runAsync(`CREATE TABLE collab_requests (
        id INTEGER PRIMARY KEY, submission_version INTEGER DEFAULT 0, status TEXT,
        sql_validation_status TEXT, sql_validation_error TEXT, sql_validated_at TEXT,
        done_at TEXT, attachment_dir TEXT, description TEXT, oa_request_no TEXT, created_at TEXT)`);
    // NOT NULL / status DEFAULT 对齐生产 schema（server.js:1619 起），让"漏填 NOT NULL 列"类回归在测试就暴露（ultracode 视角⑤ low）
    await dbAsync.runAsync(`CREATE TABLE collab_attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collab_request_id INTEGER NOT NULL, attachment_type TEXT NOT NULL,
        file_name TEXT NOT NULL, original_name TEXT NOT NULL,
        uploaded_by INTEGER NOT NULL, uploaded_by_name TEXT NOT NULL,
        submission_version INTEGER, status TEXT DEFAULT 'active', superseded_at TEXT,
        failed_at TEXT, failed_reason TEXT, failed_attempt_seq INTEGER,
        created_at TEXT DEFAULT (datetime('now','localtime')))`);
    // 与生产同口径 failed 唯一部分索引（H-2 撞索引验证靠它）
    await dbAsync.runAsync(`CREATE UNIQUE INDEX idx_collab_att_failed_seq_unique
        ON collab_attachments(collab_request_id, failed_attempt_seq, attachment_type) WHERE status='failed'`);
}

// 造一条 collab_requests + _pending 真实文件，返回 uploadedFiles（orderedFiles 形态 + typeOrdinal）
async function seedRequest(rid, oldVer, fileSpecs) {
    await dbAsync.runAsync(
        `INSERT INTO collab_requests (id, submission_version, status, description, oa_request_no, created_at)
         VALUES (?, ?, 'PENDING', ?, ?, '2026-06-28 10:00:00')`,
        [rid, oldVer, 'mf test', `OA-MF-${rid}`]);
    const pendingDir = path.join(collabRoot, '_pending', String(rid));
    fs.mkdirSync(pendingDir, { recursive: true });
    // 按类型计 typeOrdinal（模拟 groupUploadedDeliveryFiles 输出）
    const counter = {};
    return fileSpecs.map((spec, i) => {
        const srcPath = path.join(pendingDir, `${i}_${spec.name}`);
        fs.writeFileSync(srcPath, spec.content || `content-${i}`);
        counter[spec.type] = (counter[spec.type] || 0) + 1;
        return {
            attachment_type: spec.type,
            source_path: srcPath,
            original_name: spec.name,
            uploaded_by: 19,
            uploaded_by_name: '示例用户B',
            typeOrdinal: counter[spec.type],
        };
    });
}

function activateParams(rid, oldVer, uploadedFiles, runSmokeTest) {
    return {
        db, dbAsync, requestId: rid, oldVer, collabRoot,
        description: 'mf test', attachmentDir: null,
        oaRequestNo: `OA-MF-${rid}`, collabCreatedAt: '2026-06-28 10:00:00',
        uploadedFiles, runSmokeTest, logger: { info() {}, warn() {}, error() {} },
    };
}

async function run() {
    await initSchema();

    // ── T-A passed: H-1 放宽 + RC-H1 文件名唯一 + M-4 firstScript ──
    console.log('\n=== T-A passed: 2 data + 2 script → 全 active 同版本 + 4 物理文件互不覆盖 + smoke 取首脚本 ===');
    {
        const rid = 1;
        const uf = await seedRequest(rid, 0, [
            { type: 'result_data', name: 'd1.xlsx' },
            { type: 'result_script', name: 's1.sql', content: 'SELECT 1 -- first' },
            { type: 'result_data', name: 'd2.xlsx' },
            { type: 'result_script', name: 's2.sql', content: 'SELECT 2 -- second' },
        ]);
        const firstScriptName = 's1.sql';  // 上传序第一个脚本
        let capturedScriptPath = null;
        const smoke = async (scriptPath) => { capturedScriptPath = scriptPath; return { ok: true, validatedAt: new Date(), rowCount: 1 }; };
        const r = await ver.activateNewVersion(activateParams(rid, 0, uf, smoke));
        assert(r.newVer === 1, `T-A newVer=1, got ${r.newVer}`);
        const rows = await dbAsync.allAsync(
            `SELECT attachment_type, file_name, original_name, submission_version, status FROM collab_attachments WHERE collab_request_id=? ORDER BY id ASC`, [rid]);
        assert(rows.length === 4, `T-A 入库 4 行, got ${rows.length}`);
        assert(rows.every(r => r.status === 'active' && r.submission_version === 1), `T-A 全 active 同版本 v1（H-1 放宽）`);
        // RC-H1：4 个 file_name 互异 + 磁盘 4 个物理文件都在
        const names = rows.map(r => path.basename(r.file_name));
        assert(new Set(names).size === 4, `T-A 4 file_name 互异（RC-H1）: ${names.join(' | ')}`);
        const onDisk = names.filter(n => fs.existsSync(path.join(collabRoot, path.dirname(rows[0].file_name).replace(/^collab\//, ''), n)));
        assert(onDisk.length === 4, `T-A 磁盘 4 物理文件都在（不互相覆盖）, got ${onDisk.length}`);
        // M-4：smoke 收到第一份脚本（typeOrdinal=1 的 result_script，文件名含 rs_01 + 原名 s1）
        assert(capturedScriptPath && /_rs_01_/.test(path.basename(capturedScriptPath)), `T-A smoke 收到首个脚本(rs_01), got ${capturedScriptPath && path.basename(capturedScriptPath)}`);
        // 交叉验证：首个脚本内容 = 'SELECT 1 -- first'（确实是上传序第一个，非最后一个 s2）
        const captured = capturedScriptPath ? fs.readFileSync(capturedScriptPath, 'utf8') : '';
        assert(/first/.test(captured) && !/second/.test(captured), `T-A smoke 入参脚本内容=首份(${firstScriptName}) 非最后份, got "${captured}"`);
        // M-3（ultracode 视角⑤）：执行级回放 server.js DONE 路径取首 SELECT（同 WHERE + ORDER BY id ASC），
        //   断言 .find 命中的是「第一份上传」d1/s1（非 d2/s2）——把 route 取首从"间接推断"升级为执行级断言，闭合测试真空段
        const routeRows = await dbAsync.allAsync(
            `SELECT id, attachment_type, original_name FROM collab_attachments
              WHERE collab_request_id=? AND submission_version=?
                AND attachment_type IN ('result_data','result_script')
                AND (status='active' OR status IS NULL)
              ORDER BY id ASC`, [rid, 1]);
        const firstData = routeRows.find(r => r.attachment_type === 'result_data');
        const firstScript = routeRows.find(r => r.attachment_type === 'result_script');
        assert(firstData && firstData.original_name === 'd1.xlsx', `T-A route SELECT 取首 result_data=d1（首份非 d2）, got ${firstData && firstData.original_name}`);
        assert(firstScript && firstScript.original_name === 's1.sql', `T-A route SELECT 取首 result_script=s1（首份非 s2）, got ${firstScript && firstScript.original_name}`);
        // M-B（codex）：显式锁定自增 id 序 = 上传序（混排 d,s,d,s），防未来改批量/分组插入退化取首契约
        const idOrderNames = rows.map(r => r.original_name);
        assert(JSON.stringify(idOrderNames) === JSON.stringify(['d1.xlsx', 's1.sql', 'd2.xlsx', 's2.sql']),
            `T-A id 升序=上传序 d1,s1,d2,s2: ${idOrderNames.join(',')}`);
    }

    // ── T-B supersede: v1 → v2 旧版本全 superseded ──
    console.log('\n=== T-B supersede: 对 #1 再提交 v2 → v1 的 4 行全 superseded、v2 active ===');
    {
        const rid = 1;
        const uf = await seedRequest2(rid, 1, [
            { type: 'result_data', name: 'd3.xlsx' },
            { type: 'result_script', name: 's3.sql', content: 'SELECT 3' },
        ]);
        const smoke = async () => ({ ok: true, validatedAt: new Date(), rowCount: 1 });
        const r = await ver.activateNewVersion(activateParams(rid, 1, uf, smoke));
        assert(r.newVer === 2, `T-B newVer=2, got ${r.newVer}`);
        const v1 = await dbAsync.allAsync(`SELECT status FROM collab_attachments WHERE collab_request_id=? AND submission_version=1`, [rid]);
        assert(v1.length === 4 && v1.every(x => x.status === 'superseded'), `T-B v1 的 4 行全 superseded`);
        const v2 = await dbAsync.allAsync(`SELECT status FROM collab_attachments WHERE collab_request_id=? AND submission_version=2`, [rid]);
        assert(v2.length === 2 && v2.every(x => x.status === 'active'), `T-B v2 的 2 行 active`);
    }

    // ── T-C failed: H-2 failed seq 逐文件自增 + RC-H1 failed 文件名唯一 ──
    console.log('\n=== T-C failed: 2 data + 2 script + smoke 失败 → failed seq 1,2 不撞索引 + 4 failed 文件互异 ===');
    {
        const rid = 2;
        const uf = await seedRequest(rid, 0, [
            { type: 'result_data', name: 'fd1.xlsx' },
            { type: 'result_data', name: 'fd2.xlsx' },
            { type: 'result_script', name: 'fs1.sql' },
            { type: 'result_script', name: 'fs2.sql' },
        ]);
        const smoke = async () => ({ ok: false, error: 'mock smoke fail' });
        let thrown = null;
        try { await ver.activateNewVersion(activateParams(rid, 0, uf, smoke)); }
        catch (e) { thrown = e; }
        assert(thrown && thrown.code === 'SMOKE_TEST_FAILED', `T-C 抛 SMOKE_TEST_FAILED, got ${thrown && thrown.code}`);
        const fr = await dbAsync.allAsync(
            `SELECT attachment_type, failed_attempt_seq, file_name FROM collab_attachments WHERE collab_request_id=? AND status='failed' ORDER BY id ASC`, [rid]);
        assert(fr.length === 4, `T-C 4 failed 行入库（未撞唯一索引）, got ${fr.length}`);
        const dataSeqs = fr.filter(x => x.attachment_type === 'result_data').map(x => x.failed_attempt_seq).sort();
        const scriptSeqs = fr.filter(x => x.attachment_type === 'result_script').map(x => x.failed_attempt_seq).sort();
        assert(JSON.stringify(dataSeqs) === '[1,2]', `T-C result_data failed_seq=[1,2]（H-2 逐文件自增）, got ${JSON.stringify(dataSeqs)}`);
        assert(JSON.stringify(scriptSeqs) === '[1,2]', `T-C result_script failed_seq=[1,2], got ${JSON.stringify(scriptSeqs)}`);
        const fnames = fr.map(x => path.basename(x.file_name));
        assert(new Set(fnames).size === 4, `T-C 4 failed file_name 互异（RC-H1 failed 全路径）: ${fnames.join(' | ')}`);
        // failedAttachments 返回 original_name（RC-M2/M-2）
        assert(Array.isArray(thrown.failedAttachments) && thrown.failedAttachments.every(a => !!a.original_name),
            `T-C failedAttachments 带 original_name`);
    }

    // ── T-D naming: buildFinalAttachmentName typeOrdinal 四名互异（函数级 RC-H1）──
    console.log('\n=== T-D naming: active/failed × ordinal 1/2 四名互异 + 不传 typeOrdinal 兼容旧名 ===');
    {
        const base = { oaRequestNo: 'OA-1', createdAt: '2026-06-28 10:00:00', seq: 1, attachmentType: 'result_data', displayName: '示例用户B', username: '示例用户B', ext: '.xlsx' };
        const n1 = ver.buildFinalAttachmentName({ ...base, isFailed: false, typeOrdinal: 1 });
        const n2 = ver.buildFinalAttachmentName({ ...base, isFailed: false, typeOrdinal: 2 });
        const f1 = ver.buildFinalAttachmentName({ ...base, isFailed: true, typeOrdinal: 1 });
        const f2 = ver.buildFinalAttachmentName({ ...base, isFailed: true, typeOrdinal: 2 });
        assert(new Set([n1, n2, f1, f2]).size === 4, `T-D 四名互异: ${[n1, n2, f1, f2].join(' | ')}`);
        assert(/_rd_01_/.test(n1) && /_rd_02_/.test(n2), `T-D active ordinal 拼 rd_01/rd_02`);
        assert(/_rd_01_failed_/.test(f1), `T-D failed 名含 rd_01_failed`);
        // 不传 typeOrdinal → 旧名格式（无 _0x，零回归）
        const old = ver.buildFinalAttachmentName({ ...base, isFailed: false });
        assert(/_rd_示例用户B\.xlsx$/.test(old) && !/_0\d_/.test(old), `T-D 不传 typeOrdinal 保持旧名: ${old}`);
    }

    // ── T-E: 单文件提交端到端零回归（Y）：1 data + 1 script + typeOrdinal=undefined → 落盘名无 _NN 序号 ──
    console.log('\n=== T-E: 单文件 activate（typeOrdinal=undefined，模拟 grouping 单文件清编号）→ 落盘旧名无 _NN ===');
    {
        const rid = 3;
        const uf = await seedRequest(rid, 0, [
            { type: 'result_data', name: 'only.xlsx' },
            { type: 'result_script', name: 'only.sql' },
        ]);
        uf.forEach(x => { x.typeOrdinal = undefined; });  // grouping 对单文件清 typeOrdinal
        const smoke = async () => ({ ok: true, validatedAt: new Date(), rowCount: 1 });
        await ver.activateNewVersion(activateParams(rid, 0, uf, smoke));
        const rows = await dbAsync.allAsync(`SELECT file_name FROM collab_attachments WHERE collab_request_id=? AND submission_version=1`, [rid]);
        assert(rows.length === 2, `T-E 入库 2 行, got ${rows.length}`);
        const hasOrdinal = rows.some(r => /_(rd|rs)_\d{2}_/.test(path.basename(r.file_name)));
        assert(!hasOrdinal, `T-E 单文件落盘名无 _NN 序号（零回归）: ${rows.map(r => path.basename(r.file_name)).join(' | ')}`);
        assert(rows.some(r => /_rd_/.test(path.basename(r.file_name))) && rows.some(r => /_rs_/.test(path.basename(r.file_name))), `T-E 旧名格式含 _rd_/_rs_`);
    }

    // ── T-F（M-C codex/ultracode）：同单连续 2 次 smoke 失败 → 两轮 failed 物理文件都在不覆盖（_rN 去重）──
    console.log('\n=== T-F: 同单连续 2 次 smoke 失败 → 4 failed 物理文件都保留（跨重试不覆盖）===');
    {
        const rid = 4;
        const smokeFail = async () => ({ ok: false, error: 'fail' });
        // 第 1 次失败（version 不晋升，oldVer 恒 0）
        const uf1 = await seedRequest(rid, 0, [{ type: 'result_data', name: 'rt.xlsx' }, { type: 'result_script', name: 'rt.sql' }]);
        uf1.forEach(x => { x.typeOrdinal = undefined; });
        try { await ver.activateNewVersion(activateParams(rid, 0, uf1, smokeFail)); } catch (_) { }
        // 第 2 次失败（重新 seed _pending，oldVer 仍 0）
        const uf2 = await seedRequest2(rid, 0, [{ type: 'result_data', name: 'rt.xlsx' }, { type: 'result_script', name: 'rt.sql' }]);
        uf2.forEach(x => { x.typeOrdinal = undefined; });
        try { await ver.activateNewVersion(activateParams(rid, 0, uf2, smokeFail)); } catch (_) { }
        const fr = await dbAsync.allAsync(`SELECT file_name FROM collab_attachments WHERE collab_request_id=? AND status='failed' ORDER BY id ASC`, [rid]);
        assert(fr.length === 4, `T-F 4 failed 行入库, got ${fr.length}`);
        const fnames = fr.map(r => r.file_name);
        assert(new Set(fnames).size === 4, `T-F 4 failed file_name 互异（跨重试不撞名）: ${fr.map(r => path.basename(r.file_name)).join(' | ')}`);
        const allExist = fnames.every(fn => fs.existsSync(path.join(collabRoot, fn.replace(/^collab\//, ''))));
        assert(allExist, `T-F 4 failed 物理文件都在磁盘（_rN 去重防覆盖生效）`);
        assert(fnames.some(fn => /_r2\./.test(path.basename(fn))), `T-F 第 2 轮含 _r2 去重后缀`);
    }
}

// supersede 测试要给同 rid 再造 _pending 文件，但 collab_requests 行已存在，单独 seed 文件
async function seedRequest2(rid, oldVer, fileSpecs) {
    const pendingDir = path.join(collabRoot, '_pending', String(rid));
    fs.mkdirSync(pendingDir, { recursive: true });
    const counter = {};
    return fileSpecs.map((spec, i) => {
        const srcPath = path.join(pendingDir, `v2_${i}_${spec.name}`);
        fs.writeFileSync(srcPath, spec.content || `content-${i}`);
        counter[spec.type] = (counter[spec.type] || 0) + 1;
        return { attachment_type: spec.type, source_path: srcPath, original_name: spec.name, uploaded_by: 19, uploaded_by_name: '示例用户B', typeOrdinal: counter[spec.type] };
    });
}

(async () => {
    try {
        await run();
    } catch (e) {
        console.error('\n!! verify 运行异常：', e.message, e.stack);
        failed++;
    } finally {
        db.close();
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) { }
        console.log(`\n== Summary: ${passed} pass / ${failed} fail ==`);
        process.exit(failed === 0 ? 0 : 1);
    }
})();
