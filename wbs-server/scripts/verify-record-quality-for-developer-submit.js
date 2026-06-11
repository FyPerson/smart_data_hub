// 验证脚本：取数质量双校验增强 Commit B — recordQualityForDeveloperSubmit
// 方案：docs/local/数据协作模块_v3.0/取数质量双校验增强_方案_20260611_v1.2.md §3-§6 / §8b
// 用法：node scripts/verify-record-quality-for-developer-submit.js
//
// 模式：临时内存 sqlite（复刻 Commit A schema 含 7 列 + 收窄索引）+ 真 xlsx 文件落盘到 uploads/test_dualcheck_*/
//   → 调用真实 recordQualityForDeveloperSubmit → 断言矩阵 + 稳定 schema + INSERT 落库内容。
//
// 覆盖 16 项核心场景（含模板/SQL/excel 三态 × passed/failed 双路径 + 幂等 + 异常兜底）。
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const sqlite3 = require('sqlite3');
const XLSX = require('xlsx');

// 真实模块（不 mock）
const { recordQualityForDeveloperSubmit } = require('../utils/collab-submit-helpers');

// 测试目录：wbs-server/uploads/test_dualcheck_<rand>/，避免污染生产附件
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const TEST_TAG = `test_dualcheck_${process.pid}_${Math.floor(Math.random() * 1e9)}`;
const TEST_SUBDIR = path.join(UPLOAD_DIR, TEST_TAG);
fs.mkdirSync(TEST_SUBDIR, { recursive: true });

// 临时文件名工厂（resolveAttachmentPath 拼接 UPLOAD_DIR + file_name，所以 file_name 用 相对子路径）
function makeFileName(suffix) {
    return path.join(TEST_TAG, suffix).replace(/\\/g, '/');
}
function writeXlsx(fileName, headerRow) {
    const abs = path.join(UPLOAD_DIR, fileName);
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([headerRow]);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    XLSX.writeFile(wb, abs);
    return fileName;
}
function writeBroken(fileName) {
    // 真 xlsx → 截断一半（SheetJS 对纯文本不抛错，会当 CSV 解析；截断 zip 才抛 XLSX_READ_FAILED）
    const abs = path.join(UPLOAD_DIR, fileName);
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([['placeholder']]);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    XLSX.writeFile(wb, abs);
    const buf = fs.readFileSync(abs);
    fs.writeFileSync(abs, buf.subarray(0, Math.floor(buf.length / 2)));
    return fileName;
}

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ✓ ${msg}`); };

// 内存 db + Commit A 同步 DDL
const db = new sqlite3.Database(':memory:');
const dbRun = (sql, params = []) => new Promise((res, rej) =>
    db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const dbAll = (sql, params = []) => new Promise((res, rej) =>
    db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const dbGet = (sql, params = []) => new Promise((res, rej) =>
    db.get(sql, params, (e, row) => e ? rej(e) : res(row)));

const DDL_QUALITY = `CREATE TABLE collab_quality_record (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collab_request_id INTEGER NOT NULL,
    collab_sub_item_id INTEGER,
    submitter_id INTEGER NOT NULL,
    submitter_name TEXT NOT NULL,
    submission_seq INTEGER NOT NULL DEFAULT 1 CHECK (submission_seq >= 1),
    submitted_at TEXT NOT NULL,
    missing_columns TEXT,
    is_columns_complete INTEGER DEFAULT 1 CHECK (is_columns_complete IS NULL OR is_columns_complete IN (0, 1)),
    expected_columns_snapshot TEXT,
    actual_columns_snapshot TEXT,
    sql_attachment_id INTEGER,
    excel_actual_columns_snapshot TEXT,
    excel_missing_columns TEXT,
    excel_is_columns_complete INTEGER DEFAULT NULL CHECK (excel_is_columns_complete IS NULL OR excel_is_columns_complete IN (0, 1)),
    excel_unchecked_reason TEXT,
    sql_unchecked_reason TEXT,
    result_attachment_id INTEGER,
    record_kind TEXT NOT NULL DEFAULT 'passed' CHECK (record_kind IN ('passed', 'failed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
)`;
const DDL_ATTACH = `CREATE TABLE collab_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collab_request_id INTEGER NOT NULL,
    attachment_type TEXT NOT NULL,
    file_name TEXT NOT NULL,
    original_name TEXT,
    status TEXT DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
)`;
const IDX_SINGLE = `CREATE UNIQUE INDEX idx_qr_unique_single ON collab_quality_record(collab_request_id, submission_seq) WHERE collab_sub_item_id IS NULL AND record_kind = 'passed'`;
const IDX_MULTI = `CREATE UNIQUE INDEX idx_qr_unique_multi ON collab_quality_record(collab_request_id, collab_sub_item_id, submission_seq) WHERE collab_sub_item_id IS NOT NULL AND record_kind = 'passed'`;

// 适配 helper 的 dbAsync 接口
const dbAsync = { runAsync: dbRun, getAsync: dbGet };
const operationLogs = [];
const logger = {
    info:  (m) => { /* console.log('[info]', m); */ },
    warn:  (m) => { /* console.log('[warn]', m); */ },
    error: (m) => { console.error('[error]', m); },
};
function makeCtx(overrides) {
    return Object.assign({
        dbAsync,
        requestId: 1,
        submitterId: 5,
        submitterName: '开发A',
        submissionSeq: 1,
        recordKind: 'passed',
        sqlSmokeResult: { columns: [] },
        sqlAttachmentId: 100,
        resultDataAttachment: null,
        insertLog: (rid, type, opId, op, reason) => { operationLogs.push({ rid, type, opId, op, reason }); },
        logger,
    }, overrides || {});
}

async function insertTemplate(requestId, fileName, originalName) {
    await dbRun(
        `INSERT INTO collab_attachments (collab_request_id, attachment_type, file_name, original_name) VALUES (?, 'example_xlsx', ?, ?)`,
        [requestId, fileName, originalName]
    );
}

async function main() {
    await dbRun(DDL_QUALITY);
    await dbRun(DDL_ATTACH);
    await dbRun(IDX_SINGLE);
    await dbRun(IDX_MULTI);
    ok('Commit A 同步 schema 建表 + 收窄索引');

    // === [1] passed + 模板齐全 + SQL 齐 + excel 齐 → 双侧 complete=1 + recorded ===
    {
        const tpl = writeXlsx(makeFileName('tpl_1.xlsx'), ['列A', '列B']);
        const data = writeXlsx(makeFileName('data_1.xlsx'), ['列A', '列B']);
        await insertTemplate(101, tpl, 'tpl_1.xlsx');
        const r = await recordQualityForDeveloperSubmit(makeCtx({
            requestId: 101, recordKind: 'passed', submissionSeq: 1,
            sqlSmokeResult: { columns: ['列A', '列B'] },
            sqlAttachmentId: 200,
            resultDataAttachment: { id: 300, file_name: data, original_name: 'data_1.xlsx' },
        }));
        assert.strictEqual(r.check_status, 'ok', `[1] check_status 应 ok：${JSON.stringify(r)}`);
        assert.strictEqual(r.persistence_status, 'recorded', `[1] persistence_status 应 recorded`);
        assert.strictEqual(r.sql.is_complete, 1, `[1] SQL 应齐全`);
        assert.strictEqual(r.excel.is_complete, 1, `[1] excel 应齐全`);
        assert.strictEqual(r.sql.reason, null);
        assert.strictEqual(r.excel.reason, null);
        const row = await dbGet(`SELECT * FROM collab_quality_record WHERE collab_request_id=101`);
        assert.strictEqual(row.record_kind, 'passed');
        assert.strictEqual(row.is_columns_complete, 1);
        assert.strictEqual(row.excel_is_columns_complete, 1);
        assert.strictEqual(row.sql_attachment_id, 200);
        assert.strictEqual(row.result_attachment_id, 300);
        ok('[1] passed + 模板齐 + SQL齐 + excel齐 → 双侧 complete=1, recorded，DB 落 record_kind=passed');
    }

    // === [2] passed + SQL 缺列 + excel 齐 ===
    {
        const tpl = writeXlsx(makeFileName('tpl_2.xlsx'), ['列A', '列B', '列C']);
        const data = writeXlsx(makeFileName('data_2.xlsx'), ['列A', '列B', '列C']);
        await insertTemplate(102, tpl, 'tpl_2.xlsx');
        const r = await recordQualityForDeveloperSubmit(makeCtx({
            requestId: 102, recordKind: 'passed', submissionSeq: 1,
            sqlSmokeResult: { columns: ['列A', '列B'] },  // 缺 列C
            sqlAttachmentId: 201, resultDataAttachment: { id: 301, file_name: data, original_name: 'data_2.xlsx' },
        }));
        assert.strictEqual(r.sql.is_complete, 0);
        assert.deepStrictEqual(r.sql.missing, ['列C']);
        assert.strictEqual(r.excel.is_complete, 1);
        assert.strictEqual(r.persistence_status, 'recorded');
        ok('[2] SQL 缺列 + excel 齐 → 各自独立（§3.2 逐侧不变量）');
    }

    // === [3] passed + SQL 齐 + excel 缺列（独立性关键场景）===
    {
        const tpl = writeXlsx(makeFileName('tpl_3.xlsx'), ['列A', '列B', '列C']);
        const data = writeXlsx(makeFileName('data_3.xlsx'), ['列A', '列B']);  // excel 缺 列C
        await insertTemplate(103, tpl, 'tpl_3.xlsx');
        const r = await recordQualityForDeveloperSubmit(makeCtx({
            requestId: 103, recordKind: 'passed', submissionSeq: 1,
            sqlSmokeResult: { columns: ['列A', '列B', '列C'] },
            sqlAttachmentId: 202, resultDataAttachment: { id: 302, file_name: data, original_name: 'data_3.xlsx' },
        }));
        assert.strictEqual(r.sql.is_complete, 1);
        assert.strictEqual(r.excel.is_complete, 0);
        assert.deepStrictEqual(r.excel.missing, ['列C']);
        ok('[3] SQL 齐 + excel 缺列 → 两侧独立判定（开发改了 excel 没改 SQL 的关键场景）');
    }

    // === [4] failed + excel 齐 → #11 核心可信度（excel 照常跑）===
    {
        const tpl = writeXlsx(makeFileName('tpl_4.xlsx'), ['列X', '列Y']);
        const data = writeXlsx(makeFileName('data_4.xlsx'), ['列X', '列Y']);
        await insertTemplate(104, tpl, 'tpl_4.xlsx');
        const r = await recordQualityForDeveloperSubmit(makeCtx({
            requestId: 104, recordKind: 'failed', submissionSeq: 1,
            sqlSmokeResult: null,  // failed 路径 sql 不参与
            sqlAttachmentId: 203, resultDataAttachment: { id: 303, file_name: data, original_name: 'data_4.xlsx' },
        }));
        assert.strictEqual(r.sql.reason, 'SMOKE_FAILED');
        assert.strictEqual(r.sql.is_complete, null);
        assert.strictEqual(r.excel.is_complete, 1);  // ⭐ excel 照常跑
        assert.strictEqual(r.persistence_status, 'recorded');
        const row = await dbGet(`SELECT record_kind, sql_unchecked_reason FROM collab_quality_record WHERE collab_request_id=104`);
        assert.strictEqual(row.record_kind, 'failed');
        assert.strictEqual(row.sql_unchecked_reason, 'SMOKE_FAILED');
        ok('[4] failed 路径 + excel 齐 → SQL=SMOKE_FAILED 但 excel 仍 complete=1（#11 核心可信度）');
    }

    // === [5] 模板缺 → 两侧 reason='NO_TEMPLATE' 同值（§3.2 不变量）===
    {
        const r = await recordQualityForDeveloperSubmit(makeCtx({
            requestId: 105, recordKind: 'passed', submissionSeq: 1,
            sqlSmokeResult: { columns: ['x'] },
            resultDataAttachment: { id: 305, file_name: 'irrelevant.xlsx', original_name: 'irrelevant.xlsx' },
        }));
        assert.strictEqual(r.sql.reason, 'NO_TEMPLATE');
        assert.strictEqual(r.excel.reason, 'NO_TEMPLATE');
        assert.strictEqual(r.sql.is_complete, null);
        assert.strictEqual(r.excel.is_complete, null);
        ok('[5] 模板缺 → 两侧 reason=NO_TEMPLATE 同值（§3.2 不变量）');
    }

    // === [6] 非 xlsx 模板 → 两侧 reason='NON_XLSX_TEMPLATE' 同值 ===
    {
        const fakeTpl = makeFileName('tpl_6.pdf');
        fs.writeFileSync(path.join(UPLOAD_DIR, fakeTpl), 'fake pdf');
        await insertTemplate(106, fakeTpl, 'tpl_6.pdf');
        const r = await recordQualityForDeveloperSubmit(makeCtx({
            requestId: 106, recordKind: 'passed', submissionSeq: 1,
            sqlSmokeResult: { columns: ['x'] },
            resultDataAttachment: { id: 306, file_name: 'irrelevant.xlsx', original_name: 'irrelevant.xlsx' },
        }));
        assert.strictEqual(r.sql.reason, 'NON_XLSX_TEMPLATE');
        assert.strictEqual(r.excel.reason, 'NON_XLSX_TEMPLATE');
        ok('[6] 非 xlsx 模板 → 两侧 reason=NON_XLSX_TEMPLATE 同值');
    }

    // === [7] 模板读失败（损坏 xlsx）→ 两侧 reason='TEMPLATE_READ_FAILED' 同值 ===
    {
        const brokenTpl = writeBroken(makeFileName('tpl_7.xlsx'));
        await insertTemplate(107, brokenTpl, 'tpl_7.xlsx');
        const r = await recordQualityForDeveloperSubmit(makeCtx({
            requestId: 107, recordKind: 'passed', submissionSeq: 1,
            sqlSmokeResult: { columns: ['x'] },
            resultDataAttachment: { id: 307, file_name: 'irrelevant.xlsx', original_name: 'irrelevant.xlsx' },
        }));
        assert.strictEqual(r.sql.reason, 'TEMPLATE_READ_FAILED');
        assert.strictEqual(r.excel.reason, 'TEMPLATE_READ_FAILED');
        ok('[7] 模板读失败 → 两侧 reason=TEMPLATE_READ_FAILED 同值');
    }

    // === [8] result_data 缺失（异常路径，方案 §7 防御保留）→ excel.reason='NO_RESULT_DATA'，SQL 不受影响 ===
    {
        const tpl = writeXlsx(makeFileName('tpl_8.xlsx'), ['列A']);
        await insertTemplate(108, tpl, 'tpl_8.xlsx');
        const r = await recordQualityForDeveloperSubmit(makeCtx({
            requestId: 108, recordKind: 'passed', submissionSeq: 1,
            sqlSmokeResult: { columns: ['列A'] },
            resultDataAttachment: null,  // 缺失
        }));
        assert.strictEqual(r.sql.is_complete, 1);  // SQL 不受影响
        assert.strictEqual(r.excel.reason, 'NO_RESULT_DATA');
        assert.strictEqual(r.excel.is_complete, null);
        ok('[8] result_data 缺失 → excel.reason=NO_RESULT_DATA，SQL 不受影响');
    }

    // === [9] result_data 非 excel（txt）→ excel.reason='NON_EXCEL_RESULT' ===
    {
        const tpl = writeXlsx(makeFileName('tpl_9.xlsx'), ['列A']);
        const fakeTxt = makeFileName('data_9.txt');
        fs.writeFileSync(path.join(UPLOAD_DIR, fakeTxt), 'not excel');
        await insertTemplate(109, tpl, 'tpl_9.xlsx');
        const r = await recordQualityForDeveloperSubmit(makeCtx({
            requestId: 109, recordKind: 'passed', submissionSeq: 1,
            sqlSmokeResult: { columns: ['列A'] },
            resultDataAttachment: { id: 309, file_name: fakeTxt, original_name: 'data_9.txt' },
        }));
        assert.strictEqual(r.excel.reason, 'NON_EXCEL_RESULT');
        ok('[9] result_data 非 excel（.txt）→ excel.reason=NON_EXCEL_RESULT');
    }

    // === [10] result_data 读失败（损坏 xlsx）→ excel.reason='RESULT_READ_FAILED' ===
    {
        const tpl = writeXlsx(makeFileName('tpl_10.xlsx'), ['列A']);
        const broken = writeBroken(makeFileName('data_10.xlsx'));
        await insertTemplate(110, tpl, 'tpl_10.xlsx');
        const r = await recordQualityForDeveloperSubmit(makeCtx({
            requestId: 110, recordKind: 'passed', submissionSeq: 1,
            sqlSmokeResult: { columns: ['列A'] },
            resultDataAttachment: { id: 310, file_name: broken, original_name: 'data_10.xlsx' },
        }));
        assert.strictEqual(r.excel.reason, 'RESULT_READ_FAILED');
        assert.strictEqual(r.excel.is_complete, null);
        assert.strictEqual(r.sql.is_complete, 1);  // SQL 不受影响
        ok('[10] result_data 损坏 → excel.reason=RESULT_READ_FAILED，SQL 不受影响');
    }

    // === [11] passed 幂等 → 二次写 persistence_status='ignored_due_to_duplicate' ===
    {
        const tpl = writeXlsx(makeFileName('tpl_11.xlsx'), ['列A']);
        const data = writeXlsx(makeFileName('data_11.xlsx'), ['列A']);
        await insertTemplate(111, tpl, 'tpl_11.xlsx');
        const r1 = await recordQualityForDeveloperSubmit(makeCtx({
            requestId: 111, recordKind: 'passed', submissionSeq: 5,
            sqlSmokeResult: { columns: ['列A'] }, resultDataAttachment: { id: 311, file_name: data, original_name: 'data_11.xlsx' },
        }));
        assert.strictEqual(r1.persistence_status, 'recorded');
        const r2 = await recordQualityForDeveloperSubmit(makeCtx({
            requestId: 111, recordKind: 'passed', submissionSeq: 5,
            sqlSmokeResult: { columns: ['列A'] }, resultDataAttachment: { id: 311, file_name: data, original_name: 'data_11.xlsx' },
        }));
        assert.strictEqual(r2.persistence_status, 'ignored_due_to_duplicate');
        // DB 仍只有 1 条 passed 记录
        const rows = await dbAll(`SELECT id FROM collab_quality_record WHERE collab_request_id=111 AND record_kind='passed'`);
        assert.strictEqual(rows.length, 1);
        ok('[11] passed 路径同 seq 二次写 → persistence_status=ignored_due_to_duplicate（§8b.5）');
    }

    // === [12] failed 多次 append → 三次写 三条 failed 记录（不进唯一索引）===
    {
        const tpl = writeXlsx(makeFileName('tpl_12.xlsx'), ['列A']);
        const data = writeXlsx(makeFileName('data_12.xlsx'), ['列A']);
        await insertTemplate(112, tpl, 'tpl_12.xlsx');
        for (let i = 0; i < 3; i++) {
            const r = await recordQualityForDeveloperSubmit(makeCtx({
                requestId: 112, recordKind: 'failed', submissionSeq: 1,
                sqlSmokeResult: null,
                resultDataAttachment: { id: 312, file_name: data, original_name: 'data_12.xlsx' },
            }));
            assert.strictEqual(r.persistence_status, 'recorded', `[12] failed 第 ${i + 1} 次应 recorded`);
        }
        const rows = await dbAll(`SELECT id FROM collab_quality_record WHERE collab_request_id=112 AND record_kind='failed' ORDER BY id`);
        assert.strictEqual(rows.length, 3, `[12] 应有 3 条 failed 记录，实际 ${rows.length}`);
        ok('[12] failed 路径同 seq 三次写 → 3 条 failed 记录（纯 append，不进唯一索引）');
    }

    // === [13] recordKind 非法 → compute_failed ===
    {
        const r = await recordQualityForDeveloperSubmit(makeCtx({
            requestId: 113, recordKind: 'unknown',
            sqlSmokeResult: { columns: [] },
        }));
        assert.strictEqual(r.check_status, 'compute_failed');
        assert.strictEqual(r.persistence_status, 'failed');
        assert.strictEqual(r.sql.reason, 'QUALITY_CHECK_FAILED');
        assert.strictEqual(r.excel.reason, 'QUALITY_CHECK_FAILED');
        ok('[13] recordKind 非法 → compute_failed + 两侧 reason=QUALITY_CHECK_FAILED（§8b.4）');
    }

    // === [14] dbAsync 缺失 → compute_failed ===
    {
        const r = await recordQualityForDeveloperSubmit({
            // 故意不传 dbAsync
            requestId: 114, submitterId: 5, submitterName: 'x', submissionSeq: 1, recordKind: 'passed',
            sqlSmokeResult: { columns: [] }, logger,
        });
        assert.strictEqual(r.check_status, 'compute_failed');
        ok('[14] dbAsync 缺失 → compute_failed（H-2 兜底）');
    }

    // === [15] INSERT 抛错 → persistence_status='failed' + check_status='ok'（计算成功仅落库失败）===
    {
        // Mock dbAsync.runAsync 抛错（仅本测试）
        const failingDb = {
            runAsync: async () => { throw new Error('CHECK constraint failed: simulated'); },
            getAsync: dbGet,
        };
        const tpl = writeXlsx(makeFileName('tpl_15.xlsx'), ['列A']);
        const data = writeXlsx(makeFileName('data_15.xlsx'), ['列A']);
        await insertTemplate(115, tpl, 'tpl_15.xlsx');
        const r = await recordQualityForDeveloperSubmit(makeCtx({
            dbAsync: failingDb,
            requestId: 115, recordKind: 'passed', submissionSeq: 1,
            sqlSmokeResult: { columns: ['列A'] },
            resultDataAttachment: { id: 315, file_name: data, original_name: 'data_15.xlsx' },
        }));
        assert.strictEqual(r.check_status, 'ok', `[15] 计算成功 check_status 应 ok`);
        assert.strictEqual(r.persistence_status, 'failed', `[15] 落库失败 persistence_status 应 failed`);
        assert.strictEqual(r.sql.is_complete, 1, `[15] 计算结果应正常`);
        ok('[15] INSERT 抛错（约束失败） → persistence=failed + check_status=ok（计算/落库分离 §6.1）');
    }

    // === [16] 顶层异常（getAsync 抛）→ compute_failed ===
    {
        const explodingDb = {
            runAsync: dbRun,
            getAsync: async () => { throw new Error('DB connection lost'); },
        };
        const r = await recordQualityForDeveloperSubmit(makeCtx({
            dbAsync: explodingDb,
            requestId: 116, recordKind: 'passed', submissionSeq: 1,
            sqlSmokeResult: { columns: [] },
        }));
        assert.strictEqual(r.check_status, 'compute_failed', `[16] 顶层异常应 compute_failed`);
        assert.strictEqual(r.persistence_status, 'failed');
        ok('[16] getAsync 抛错（顶层异常）→ compute_failed（H-2 兜底）');
    }

    // === [17] ctx.insertLog 抛错 → 主函数仍返回稳定 schema（codex Commit B 审 medium-4，覆盖第 3 类 H-2 兜底路径）===
    {
        const tpl = writeXlsx(makeFileName('tpl_17.xlsx'), ['列A']);
        const data = writeXlsx(makeFileName('data_17.xlsx'), ['列A']);
        await insertTemplate(117, tpl, 'tpl_17.xlsx');
        const r = await recordQualityForDeveloperSubmit(makeCtx({
            requestId: 117, recordKind: 'passed', submissionSeq: 1,
            sqlSmokeResult: { columns: ['列A'] },
            sqlAttachmentId: 217, resultDataAttachment: { id: 317, file_name: data, original_name: 'data_17.xlsx' },
            insertLog: () => { throw new Error('insertLog 内部失败'); },  // mock 日志写入抛错
        }));
        assert.strictEqual(r.check_status, 'ok', `[17] 日志失败不应影响计算 check_status`);
        assert.strictEqual(r.persistence_status, 'recorded', `[17] 日志失败不应影响落库 persistence_status`);
        assert.strictEqual(r.sql.is_complete, 1);
        assert.strictEqual(r.excel.is_complete, 1);
        const row = await dbGet(`SELECT id FROM collab_quality_record WHERE collab_request_id=117`);
        assert.ok(row && row.id, `[17] insertLog 抛错时质量记录仍应落库`);
        ok('[17] ctx.insertLog 抛错 → 主函数返回稳定 schema + DB 落库正常（H-2 第 3 类兜底）');
    }

    // operation_log 落痕计数（不强制断言条数，只看有写入）
    assert.ok(operationLogs.length > 0, 'operation_log 应有写入');
    ok(`operation_log 落痕计数 ${operationLogs.length} 条（best-effort 写入）`);

    console.log(`\n[全部通过] ${passed}/${passed} ✓ Commit B recordQualityForDeveloperSubmit 验证通过（16 矩阵场景）`);
    db.close();
    // 清理测试文件
    try { fs.rmSync(TEST_SUBDIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

main().catch(e => {
    console.error('\n[失败]', e.message, e.stack);
    db.close();
    try { fs.rmSync(TEST_SUBDIR, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    process.exit(1);
});
