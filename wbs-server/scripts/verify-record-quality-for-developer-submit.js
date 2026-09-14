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
const dbAsync = { runAsync: dbRun, getAsync: dbGet, allAsync: dbAll };
const operationLogs = [];
// #68 codex 120-B M-3：warn 原为空实现 ⇒ 任何「守卫是否真的记名拦截」的断言都无从写起，
//   这正是 [68f] 最初没有判别力的根由。改为收集，供用例断言具体诊断文本。
const warnLogs = [];
const logger = {
    info:  (m) => { /* console.log('[info]', m); */ },
    warn:  (m) => { warnLogs.push(String(m)); },
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
            allAsync: dbAll,
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
            allAsync: async () => { throw new Error('DB connection lost'); },
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

    // === #68 D1：SQL 只中甲、Excel 只中乙 → 双侧仍过；快照跟 SQL 命中份 ===
    {
        const tplA = writeXlsx(makeFileName('tpl_68a.xlsx'), ['列A']);
        const tplB = writeXlsx(makeFileName('tpl_68b.xlsx'), ['列B']);
        const data = writeXlsx(makeFileName('data_68ab.xlsx'), ['列B']);
        await insertTemplate(168, tplA, 'tpl_68a.xlsx');
        await insertTemplate(168, tplB, 'tpl_68b.xlsx');
        const r = await recordQualityForDeveloperSubmit(makeCtx({
            requestId: 168, recordKind: 'passed', submissionSeq: 1,
            sqlSmokeResult: { columns: ['列A'] },
            sqlAttachmentId: 268,
            resultDataAttachment: { id: 368, file_name: data, original_name: 'data_68ab.xlsx' },
        }));
        assert.strictEqual(r.check_status, 'ok');
        assert.strictEqual(r.sql.is_complete, 1, '[68a] SQL 命中甲');
        assert.strictEqual(r.excel.is_complete, 1, '[68a] Excel 命中乙');
        const row = await dbGet(`SELECT expected_columns_snapshot, missing_columns FROM collab_quality_record WHERE collab_request_id=168`);
        assert.deepStrictEqual(JSON.parse(row.expected_columns_snapshot), ['列A'], '[68a] 快照跟 SQL 命中的甲');
        ok('[68a] SQL 只中甲 / Excel 只中乙 → 双侧齐全，快照为甲');
    }
    {
        const tplOld = writeXlsx(makeFileName('tpl_68old.xlsx'), ['列A']);
        const tplNew = writeXlsx(makeFileName('tpl_68new.xlsx'), ['列A', '列C']);
        const data = writeXlsx(makeFileName('data_68old.xlsx'), ['列A']);
        await insertTemplate(169, tplOld, 'tpl_68old.xlsx');
        await insertTemplate(169, tplNew, 'tpl_68new.xlsx');
        const r = await recordQualityForDeveloperSubmit(makeCtx({
            requestId: 169, recordKind: 'passed', submissionSeq: 1,
            sqlSmokeResult: { columns: ['列A'] },
            sqlAttachmentId: 269,
            resultDataAttachment: { id: 369, file_name: data, original_name: 'data_68old.xlsx' },
        }));
        assert.strictEqual(r.sql.is_complete, 1, '[68b] 旧齐全+新缺列 SQL 仍过');
        assert.strictEqual(r.excel.is_complete, 1, '[68b] Excel 同');
        ok('[68b] 旧齐全 + 新缺列 → any-match 双侧仍齐全（取最新会红）');
    }
    {
        const tplA = writeXlsx(makeFileName('tpl_68c_a.xlsx'), ['列A']);
        const tplB = writeXlsx(makeFileName('tpl_68c_b.xlsx'), ['列B']);
        const data = writeXlsx(makeFileName('data_68c.xlsx'), ['列C']);
        await insertTemplate(170, tplA, 'tpl_68c_a.xlsx');
        await insertTemplate(170, tplB, 'tpl_68c_b.xlsx');
        const r = await recordQualityForDeveloperSubmit(makeCtx({
            requestId: 170, recordKind: 'passed', submissionSeq: 1,
            sqlSmokeResult: { columns: ['列A'] },
            sqlAttachmentId: 270,
            resultDataAttachment: { id: 370, file_name: data, original_name: 'data_68c.xlsx' },
        }));
        assert.strictEqual(r.sql.is_complete, 1, '[68c] SQL 只中甲 → 齐全');
        assert.strictEqual(r.excel.is_complete, 0, '[68c] Excel 两侧都不中 → 缺列');
        ok('[68c] SQL 只中甲 / Excel 全不中 → 一侧过一侧不过');
    }
    {
        const tplA = writeXlsx(makeFileName('tpl_68d_a.xlsx'), ['列A', '列X']);
        const tplB = writeXlsx(makeFileName('tpl_68d_b.xlsx'), ['列A', '列Y']);
        const data = writeXlsx(makeFileName('data_68d.xlsx'), ['列A']);
        await insertTemplate(171, tplA, 'tpl_68d_a.xlsx');
        await insertTemplate(171, tplB, 'tpl_68d_b.xlsx');
        const r = await recordQualityForDeveloperSubmit(makeCtx({
            requestId: 171, recordKind: 'passed', submissionSeq: 1,
            sqlSmokeResult: { columns: ['列A'] },
            sqlAttachmentId: 271,
            resultDataAttachment: { id: 371, file_name: data, original_name: 'data_68d.xlsx' },
        }));
        assert.strictEqual(r.sql.is_complete, 0, '[68d] 全不中');
        const row = await dbGet(`SELECT expected_columns_snapshot, missing_columns FROM collab_quality_record WHERE collab_request_id=171`);
        assert.deepStrictEqual(JSON.parse(row.expected_columns_snapshot), ['列A', '列X'], '[68d] 缺列数并列 → 快照取 id 升序第一份');
        assert.deepStrictEqual(JSON.parse(row.missing_columns), ['列X'], '[68d] missing 与快照同源');
        ok('[68d] 全不中且缺列数并列 → 快照/缺列跟 id 升序第一份');
    }
    {
        const tplOk = writeXlsx(makeFileName('tpl_68e.xlsx'), ['列A']);
        await insertTemplate(172, 'note.pdf', '说明.pdf');
        await insertTemplate(172, tplOk, 'tpl_68e.xlsx');
        const data = writeXlsx(makeFileName('data_68e.xlsx'), ['列A']);
        const r = await recordQualityForDeveloperSubmit(makeCtx({
            requestId: 172, recordKind: 'passed', submissionSeq: 1,
            sqlSmokeResult: { columns: ['列A'] },
            sqlAttachmentId: 272,
            resultDataAttachment: { id: 372, file_name: data, original_name: 'data_68e.xlsx' },
        }));
        assert.strictEqual(r.sql.is_complete, 1, '[68e] 跳过 pdf，命中可读 xlsx');
        assert.strictEqual(r.excel.is_complete, 1);
        ok('[68e] 可读 + 不可读混合 → 跳过 pdf，按可读份 any-match');
    }
    // === codex 120-B M-4：[68d] 并列取 id 升序，分不出「按缺列数挑」与「永远取第一份」 ===
    //   本条让**后插的第二份缺列更少**，只有真按缺列数排序才会选它。
    {
        const tplFirst = writeXlsx(makeFileName('tpl_68h_1.xlsx'), ['列A', '列X', '列Y']);  // 缺 2
        const tplSecond = writeXlsx(makeFileName('tpl_68h_2.xlsx'), ['列A', '列Z']);        // 缺 1
        await insertTemplate(174, tplFirst, 'tpl_68h_1.xlsx');
        await insertTemplate(174, tplSecond, 'tpl_68h_2.xlsx');
        const data = writeXlsx(makeFileName('data_68h.xlsx'), ['列A']);
        const r = await recordQualityForDeveloperSubmit(makeCtx({
            requestId: 174, recordKind: 'passed', submissionSeq: 1,
            sqlSmokeResult: { columns: ['列A'] },
            sqlAttachmentId: 274,
            resultDataAttachment: { id: 374, file_name: data, original_name: 'data_68h.xlsx' },
        }));
        assert.strictEqual(r.sql.is_complete, 0, '[68h] 两份都不中 → 缺列');
        const row = await dbGet('SELECT expected_columns_snapshot, missing_columns FROM collab_quality_record WHERE collab_request_id=174');
        assert.deepStrictEqual(JSON.parse(row.expected_columns_snapshot), ['列A', '列Z'],
            '[68h] 快照应取**缺列更少的第二份**（若实现永远取第一份，这里会是 [列A,列X,列Y] → 红）');
        assert.deepStrictEqual(JSON.parse(row.missing_columns), ['列Z'], '[68h] missing 与快照同源');
        ok('[68h] 后插模板缺列更少 → 按缺列数挑而非永远取第一份（可判红）');
    }
    // === codex 120-B M-4：[68e] 只覆盖非 Excel，补「坏 Excel + 可读」「空表头 + 可读」 ===
    {
        const broken = writeBroken(makeFileName('tpl_68i_broken.xlsx'));
        const good = writeXlsx(makeFileName('tpl_68i_ok.xlsx'), ['列A']);
        await insertTemplate(175, broken, 'tpl_68i_broken.xlsx');
        await insertTemplate(175, good, 'tpl_68i_ok.xlsx');
        const data = writeXlsx(makeFileName('data_68i.xlsx'), ['列A']);
        const r = await recordQualityForDeveloperSubmit(makeCtx({
            requestId: 175, recordKind: 'passed', submissionSeq: 1,
            sqlSmokeResult: { columns: ['列A'] }, sqlAttachmentId: 275,
            resultDataAttachment: { id: 375, file_name: data, original_name: 'data_68i.xlsx' },
        }));
        assert.strictEqual(r.sql.is_complete, 1, '[68i] 坏 Excel 被跳过，命中可读份');
        assert.strictEqual(r.sql.reason, null, '[68i] 有可读份即正常比对，不得落 TEMPLATE_READ_FAILED');
        ok('[68i] 坏 Excel + 可读模板 → 跳过坏份按可读份 any-match（不整体判读失败）');
    }
    {
        const empty = writeXlsx(makeFileName('tpl_68j_empty.xlsx'), []);   // 空表头
        const good = writeXlsx(makeFileName('tpl_68j_ok.xlsx'), ['列A']);
        await insertTemplate(176, empty, 'tpl_68j_empty.xlsx');
        await insertTemplate(176, good, 'tpl_68j_ok.xlsx');
        const data = writeXlsx(makeFileName('data_68j.xlsx'), ['列A']);
        const r = await recordQualityForDeveloperSubmit(makeCtx({
            requestId: 176, recordKind: 'passed', submissionSeq: 1,
            sqlSmokeResult: { columns: ['列A'] }, sqlAttachmentId: 276,
            resultDataAttachment: { id: 376, file_name: data, original_name: 'data_68j.xlsx' },
        }));
        assert.strictEqual(r.sql.is_complete, 1, '[68j] 空表头份被跳过，命中可读份');
        assert.ok(warnLogs.some(m => m.includes('模板表头为空') && m.includes('非解析失败')),
            `[68j] 空表头应留下与读取异常可区分的诊断（L-2；实得 ${JSON.stringify(warnLogs.slice(-3))}）`);
        ok('[68j] 空表头 + 可读模板 → 跳过空份 + 留下专属诊断日志');
    }
    // === codex 120-B M-4：全不可读时的 reason 分档（多模板形态，非单模板的 [6]/[7]）===
    {
        const fakePdf = makeFileName('tpl_68k.pdf');
        fs.writeFileSync(path.join(UPLOAD_DIR, fakePdf), 'fake pdf');
        const broken = writeBroken(makeFileName('tpl_68k_broken.xlsx'));
        await insertTemplate(177, fakePdf, 'tpl_68k.pdf');
        await insertTemplate(177, broken, 'tpl_68k_broken.xlsx');
        const r = await recordQualityForDeveloperSubmit(makeCtx({
            requestId: 177, recordKind: 'passed', submissionSeq: 1,
            sqlSmokeResult: { columns: ['列A'] }, sqlAttachmentId: 277,
            resultDataAttachment: { id: 377, file_name: 'irrelevant.xlsx', original_name: 'irrelevant.xlsx' },
        }));
        // 冻结口径：只有非 Excel → NON_XLSX_TEMPLATE；**有** Excel 扩展名但全读不出 → TEMPLATE_READ_FAILED
        assert.strictEqual(r.sql.reason, 'TEMPLATE_READ_FAILED',
            '[68k] pdf + 坏 xlsx 混合：因存在 Excel 扩展名份，应落 TEMPLATE_READ_FAILED 而非 NON_XLSX_TEMPLATE');
        assert.strictEqual(r.excel.reason, 'TEMPLATE_READ_FAILED', '[68k] 两侧同值');
        ok('[68k] 全不可读且含 Excel 扩展名 → 分档到 TEMPLATE_READ_FAILED（与只有非 Excel 的 [6] 可区分）');
    }

    // === #68 契约守卫：dbAsync 三件必须传齐 ===
    //
    // 为什么要有这一节（2026-09-14 实际漏网）：#68 D1 把列对齐改成 any-match，helper 内部
    //   从 getAsync(LIMIT 1) 换成 **allAsync(列出全部)**。本文件的夹具 dbAsync 当场补了 allAsync
    //   于是 24/24 全绿，但 server.js 两处真调用点没跟着补 —— 生产上每次开发提交都会在
    //   _classifyActiveExampleXlsx 抛错 → 外层 catch → check_status='compute_failed'，
    //   而 helper 是 H-2 永不抛的，主流程照常成功、无告警，质量记录全部悄悄写成"未比对"。
    //   「测试为了跑通改夹具，改完忘了改真正的调用方」——夹具绿不代表调用方对，
    //   所以下面两条断言的对象**不是 helper，而是调用方**：
    //     [68f] 运行时：按生产形态（缺 allAsync）传 ctx，必须走显式守卫而不是含糊的兜底
    //     [68g] 静态：直接读 server.js 源码，核每个真调用点的 dbAsync 字面量
    {
        // ⚠️ codex 120-B M-3 指出本条最初没有判别力：只断 compute_failed + QUALITY_CHECK_FAILED 的话，
        //   把新增的入口守卫**整个删掉**，缺 allAsync 仍会在 _classifyActiveExampleXlsx 抛错、被外层
        //   catch 成一模一样的返回值 ⇒ 断言分不出「守卫拦住了」和「压根没守卫」。核实成立。
        //   改为断两件只有走守卫才成立的事：① 记名诊断文本 ② **一次 DB 调用都没发生**
        //   （守卫在最前面 return，若退化成内层抛错，allAsync 已被调用过）。
        warnLogs.length = 0;
        const calls = [];
        const spyDb = {
            runAsync: (...a) => { calls.push('runAsync'); return dbRun(...a); },
            getAsync: (...a) => { calls.push('getAsync'); return dbGet(...a); },
            // 故意不给 allAsync —— 即 2026-09-14 漏改时 server.js 的真实形态
        };
        const r = await recordQualityForDeveloperSubmit(makeCtx({
            dbAsync: spyDb,
            requestId: 173, recordKind: 'passed', submissionSeq: 1,
            sqlSmokeResult: { columns: ['列A'] },
        }));
        assert.strictEqual(r.check_status, 'compute_failed', '[68f] 缺 allAsync → compute_failed');
        assert.strictEqual(r.sql.reason, 'QUALITY_CHECK_FAILED', '[68f] 两侧走 compute_failed 归一化');
        assert.ok(warnLogs.some(m => m.includes('dbAsync 缺失') && m.includes('allAsync')),
            `[68f] 必须留下入口守卫的记名诊断（实得 warn：${JSON.stringify(warnLogs)}）`);
        assert.deepStrictEqual(calls, [],
            `[68f] 守卫应在任何 DB 调用之前 return（实得调用序列 ${JSON.stringify(calls)}）`);
        ok('[68f] 生产形态 ctx（缺 allAsync）→ 入口守卫记名拦截 + 零 DB 调用（删守卫即判红）');
    }
    {
        // 纯函数：给定源码文本，返回每个调用点的 dbAsync 键集合。抽出来是为了能在内存字符串上
        //   做变异自证（不触碰真实文件），对齐 verify-collab-validation-status-coverage 的③范式。
        // 结构锚非行号锚。
        //
        // ⚠️ 首版用「调用点后固定 600 字符窗口 + 非贪婪 [^}]* 取 dbAsync 字面量」，codex 120-B M-2
        //   指出三个假绿/漏扫口子，复核全部成立，已分别处置：
        //     ① 窗口不认调用边界 ⇒ 当前调用**没有** dbAsync 时，会借用窗口内**后一个**调用的完整
        //        dbAsync 判绿。→ 改为从实参 `{` 起**大括号配平**，严格限定在本次调用的实参对象内。
        //     ② 注释里出现 `allAsync:` 会被当成真属性。→ 扫描前先把行注释/块注释整体剥成空格
        //        （保留偏移量，报错位置仍准）。
        //     ③ 只认 `.helper({` ⇒ 解构导入后的 `helper({` 直接调用形式完全漏扫。→ 正则改为
        //        点号与词边界二选一。注：`count >= 2` 下界能发现"既有调用点全被改成漏扫形式"，
        //        但发现不了"新增调用点用漏扫形式写"，故这一条必须在扫描侧修，不能只靠下界。
        //   仍存在的边界（如实声明）：本函数按字符串/注释状态机剥注释，不识别正则字面量；
        //   `dbAsync` 由变量或展开符提供（`dbAsync: adapter` / `...deps`）时判为无字面量 → 红，
        //   属于"宁误报不漏报"的有意取舍。
        const HELPERS = ['recordQualityForDeveloperSubmit', 'recordQualityOnSubmit'];
        const REQUIRED_KEYS = ['runAsync', 'getAsync', 'allAsync'];

        // 把注释替换成等长空格（偏移量不变），字符串/模板串内的 // 和 /* 不当注释
        function stripComments(src) {
            const out = src.split('');
            let i = 0, q = null, inLine = false, inBlock = false;
            while (i < src.length) {
                const c = src[i], n = src[i + 1];
                if (inLine) {
                    if (c === '\n') inLine = false; else out[i] = ' ';
                    i++; continue;
                }
                if (inBlock) {
                    if (c === '*' && n === '/') { out[i] = ' '; out[i + 1] = ' '; i += 2; inBlock = false; continue; }
                    if (c !== '\n') out[i] = ' ';
                    i++; continue;
                }
                if (q) {
                    if (c === '\\') { i += 2; continue; }
                    if (c === q) q = null;
                    i++; continue;
                }
                if (c === '"' || c === "'" || c === '`') { q = c; i++; continue; }
                if (c === '/' && n === '/') { out[i] = ' '; out[i + 1] = ' '; i += 2; inLine = true; continue; }
                if (c === '/' && n === '*') { out[i] = ' '; out[i + 1] = ' '; i += 2; inBlock = true; continue; }
                i++;
            }
            return out.join('');
        }

        // 从 src[open] 处的 '{' 配平到对应 '}'，返回内部文本；不配平返回 null
        function balanced(src, open) {
            if (src[open] !== '{') return null;
            let depth = 0, q = null;
            for (let i = open; i < src.length; i++) {
                const c = src[i];
                if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
                if (c === '"' || c === "'" || c === '`') { q = c; continue; }
                if (c === '{') depth++;
                else if (c === '}') { depth--; if (depth === 0) return src.slice(open + 1, i); }
            }
            return null;
        }

        // 在对象字面量文本里取**顶层**（depth 0）某属性名的位置
        function topLevelPropPos(objText, prop) {
            const re = new RegExp(`\\b${prop}\\s*:`, 'g');
            let m;
            while ((m = re.exec(objText)) !== null) {
                let depth = 0, q = null;
                for (let i = 0; i < m.index; i++) {
                    const c = objText[i];
                    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
                    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
                    if (c === '{' || c === '[' || c === '(') depth++;
                    else if (c === '}' || c === ']' || c === ')') depth--;
                }
                if (depth === 0) return m.index + m[0].length;
            }
            return -1;
        }

        function scanCallSites(rawSrc) {
            const src = stripComments(rawSrc);
            const sites = [];
            for (const h of HELPERS) {
                // 点号调用 或 解构后的直接调用，二选一
                const re = new RegExp(`(?:\\.|\\b)${h}\\s*\\(\\s*(?=\\{)`, 'g');
                let m;
                while ((m = re.exec(src)) !== null) {
                    const open = src.indexOf('{', m.index + m[0].length - 1);
                    const argText = balanced(src, open);
                    if (argText === null) { sites.push({ helper: h, offset: m.index, keys: [], hasLiteral: false }); continue; }
                    const pos = topLevelPropPos(argText, 'dbAsync');
                    if (pos < 0) { sites.push({ helper: h, offset: m.index, keys: [], hasLiteral: false }); continue; }
                    const rest = argText.slice(pos);
                    const braceAt = rest.search(/\S/) >= 0 && rest[rest.search(/\S/)] === '{' ? rest.search(/\S/) : -1;
                    const dbText = braceAt >= 0 ? balanced(rest, braceAt) : null;
                    sites.push({
                        helper: h,
                        offset: m.index,
                        keys: dbText === null ? [] : REQUIRED_KEYS.filter(k => topLevelPropPos(dbText, k) >= 0),
                        hasLiteral: dbText !== null,
                    });
                }
            }
            return sites;
        }
        function evaluate(src) {
            const sites = scanCallSites(src);
            const bad = sites.filter(s => !s.hasLiteral || s.keys.length !== REQUIRED_KEYS.length);
            return { count: sites.length, bad };
        }

        // ① 真实 server.js
        const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
        const real = evaluate(serverSrc);
        assert.ok(real.count >= 2,
            `[68g] server.js 应至少扫到 2 个质量记录调用点（实得 ${real.count}）——若确已裁撤请同步下调此下界`);
        assert.deepStrictEqual(real.bad, [],
            `[68g] server.js 存在 dbAsync 未传齐 ${REQUIRED_KEYS.join('/')} 的调用点：`
            + JSON.stringify(real.bad.map(b => ({ helper: b.helper, offset: b.offset, keys: b.keys }))));
        ok(`[68g] server.js ${real.count} 个调用点 dbAsync 均传齐 runAsync/getAsync/allAsync`);

        // ② 变异自证：判绿的同时必须能判红，否则这条守卫等于没写
        const GOOD = `x.recordQualityForDeveloperSubmit({\n  dbAsync: { runAsync: a, getAsync: b, allAsync: c },\n  requestId: id,\n});`;
        assert.strictEqual(evaluate(GOOD).bad.length, 0, '★变异0) 完整形态应判绿');
        const MUT_NO_ALL = GOOD.replace(', allAsync: c', '');
        assert.strictEqual(evaluate(MUT_NO_ALL).bad.length, 1, '★变异1) 删 allAsync 应判红（复刻本次漏网）');
        const MUT_NO_GET = GOOD.replace(', getAsync: b', '');
        assert.strictEqual(evaluate(MUT_NO_GET).bad.length, 1, '★变异2) 删 getAsync 应判红');
        const MUT_NO_LITERAL = GOOD.replace(/dbAsync: \{[^}]*\},\n/, '');
        assert.strictEqual(evaluate(MUT_NO_LITERAL).bad.length, 1, '★变异3) 整个 dbAsync 字面量缺失应判红');
        const MUT_DECOY = `x.recordQualityForDeveloperSubmit({\n  dbAsync: { runAsync: a, getAsync: b },\n  requestId: id,\n});\nother({ allAsync: c });`;
        assert.strictEqual(evaluate(MUT_DECOY).bad.length, 1,
            '★变异4) allAsync 只出现在**别的**对象里不算数（防"窗口里搜到字样就算过"的假绿）');

        // —— 以下三组为 codex 120-B M-2 点名要求补的，正是首版固定窗口判不出的形态 ——
        const MUT_BORROW =
            `x.recordQualityOnSubmit({\n  requestId: id,\n});\n` +
            `x.recordQualityForDeveloperSubmit({\n  dbAsync: { runAsync: a, getAsync: b, allAsync: c },\n});`;
        const borrow = evaluate(MUT_BORROW);
        assert.strictEqual(borrow.count, 2, '★变异5) 借用形态应扫到 2 个调用点');
        assert.strictEqual(borrow.bad.length, 1,
            '★变异5) 前一个调用**整个没有 dbAsync**，不得借用后一个调用的完整 dbAsync 判绿（首版固定窗口会假绿）');
        assert.strictEqual(borrow.bad[0].helper, 'recordQualityOnSubmit', '★变异5) 判红的应是缺失的那一个');

        const MUT_COMMENT =
            `x.recordQualityForDeveloperSubmit({\n  // 这里以前有 allAsync: dbAllAsync，后来删了\n` +
            `  dbAsync: { runAsync: a, getAsync: b /* allAsync: c */ },\n});`;
        assert.strictEqual(evaluate(MUT_COMMENT).bad.length, 1,
            '★变异6) 注释里的 allAsync:（行注释与块注释各一处）不得被当成真属性');

        const MUT_DESTRUCTURED = `recordQualityForDeveloperSubmit({\n  dbAsync: { runAsync: a, getAsync: b },\n});`;
        const de = evaluate(MUT_DESTRUCTURED);
        assert.strictEqual(de.count, 1, '★变异7) 解构导入后的直接调用形式必须被扫到（首版只认 .helper( 会漏扫）');
        assert.strictEqual(de.bad.length, 1, '★变异7) 且其缺 allAsync 应判红');

        const MUT_NESTED_OK = `x.recordQualityForDeveloperSubmit({\n  dbAsync: { runAsync: a, getAsync: b, allAsync: c },\n  opts: { nested: { allAsync: 'decoy' } },\n});`;
        assert.strictEqual(evaluate(MUT_NESTED_OK).bad.length, 0, '★变异8) 嵌套对象里的同名键不影响正常判绿');

        ok('[68g] 变异自证 8 组：完整判绿 / 缺 allAsync·缺 getAsync·缺字面量·邻近诱饵·跨调用借用·注释伪造·解构调用 判红 + 嵌套诱饵不误报');
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
