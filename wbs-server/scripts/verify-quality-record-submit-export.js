// 验证脚本：取数交付质量记录 v3.0 Commit C2 — submit-export 后列对齐旁路写入
// 用法：node scripts/verify-quality-record-submit-export.js
// 模式：临时内存 sqlite 复刻两表 DDL + collab_attachments，造真实临时 xlsx fixture，
//   对 recordQualityOnSubmit 做端到端验证。不碰生产 db。
//
// 覆盖 codex 72 取舍审 9 issue 落地点：
//   H-1 submitted_at 用本次提交时间（SQL datetime now，每条独立）
//   H-2 helper 永不抛 + 返回结构完整对象（dbAsync 缺失/异常都不崩）
//   M-1 未比对三态来源区分（NO_TEMPLATE / NON_XLSX_TEMPLATE / XLSX_READ_FAILED）
//   M-2 多模板取最新（ORDER BY created_at DESC, id DESC）
//   M-3 INSERT OR IGNORE 幂等（同 seq 二次跳过 SKIPPED_EXISTING）
//   L-1 missing_columns 纯数组 / 未比对存 NULL；snapshot 无法获取存 NULL
//   + 核心列对齐口径（T⊆S 齐全/缺列/多列放行）+ smokeColumns 防御 + seq 递增独立记录
const assert = require('assert');
const sqlite3 = require('sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');
const { recordQualityOnSubmit } = require('../utils/collab-submit-helpers');

const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) =>
    db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const get = (sql, params = []) => new Promise((res, rej) =>
    db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const all = (sql, params = []) => new Promise((res, rej) =>
    db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));

// helper 期望的 dbAsync 接口（runAsync 返回 this 含 changes；getAsync 返回行）
const dbAsync = { runAsync: run, getAsync: get };

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ✓ ${msg}`); };

// === DDL 复刻 server.js（Commit A）===
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
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
)`;
const IDX_SINGLE = `CREATE UNIQUE INDEX idx_qr_unique_single
    ON collab_quality_record(collab_request_id, submission_seq)
    WHERE collab_sub_item_id IS NULL`;
// collab_attachments 仅取 helper 查询用到的列
const DDL_ATTACH = `CREATE TABLE collab_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collab_request_id INTEGER NOT NULL,
    attachment_type TEXT NOT NULL,
    file_name TEXT NOT NULL,
    original_name TEXT NOT NULL,
    status TEXT,
    created_at DATETIME DEFAULT (datetime('now','localtime'))
)`;

// === fixture：xlsx 必须写到 uploads/ 根下（resolveAttachmentPath 拼 uploads 根 + 越界校验）===
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const FIXTURE_REL_DIR = 'collab/_c2_verify_tmp';   // 相对 uploads 的 POSIX 路径
const FIXTURE_ABS_DIR = path.join(UPLOAD_DIR, 'collab', '_c2_verify_tmp');

function ensureFixtureDir() {
    fs.mkdirSync(FIXTURE_ABS_DIR, { recursive: true });
}
// 写一个 xlsx，返回 { fileName(相对uploads), absPath }
function writeXlsxFixture(name, headerRow) {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([headerRow]);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const absPath = path.join(FIXTURE_ABS_DIR, name);
    XLSX.writeFile(wb, absPath);
    return { fileName: `${FIXTURE_REL_DIR}/${name}`, absPath };
}
// 写一个损坏的"xlsx"（截断 zip，SheetJS 解析抛错）
function writeBrokenXlsx(name) {
    const absPath = path.join(FIXTURE_ABS_DIR, name);
    fs.writeFileSync(absPath, Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]));
    return { fileName: `${FIXTURE_REL_DIR}/${name}`, absPath };
}
// 写一个非 xlsx 文件（.pdf 扩展名）
function writePdfFixture(name) {
    const absPath = path.join(FIXTURE_ABS_DIR, name);
    fs.writeFileSync(absPath, Buffer.from('%PDF-1.4 fake', 'utf8'));
    return { fileName: `${FIXTURE_REL_DIR}/${name}`, absPath };
}

// 插入一条 example_xlsx 附件，返回 attachment id
async function insertTemplate(reqId, fileName, originalName, status = 'active') {
    const r = await run(
        `INSERT INTO collab_attachments (collab_request_id, attachment_type, file_name, original_name, status)
         VALUES (?, 'example_xlsx', ?, ?, ?)`,
        [reqId, fileName, originalName, status]
    );
    return r.lastID;
}

// 静音 logger（避免 warn 刷屏，保留断言）
const quietLogger = { warn() {}, info() {}, error() {} };

// 收集 operation_log 调用（验证 M-1 reason 区分）
function makeLogCollector() {
    const logs = [];
    return { insertLog: (rid, op, oid, operator, reason) => logs.push({ rid, op, reason }), logs };
}

async function main() {
    await run(DDL_QUALITY);
    await run(IDX_SINGLE);
    await run(DDL_ATTACH);
    ensureFixtureDir();
    ok('内存库建表 + fixture 目录就绪');

    // ---------- 核心列对齐口径 ----------
    console.log('\n[核心列对齐：T ⊆ S]');

    // [1] 齐全：模板列 ⊆ SQL列
    {
        const reqId = 101;
        const { fileName } = writeXlsxFixture('t_complete.xlsx', ['订单号', '金额', '部门']);
        await insertTemplate(reqId, fileName, 't_complete.xlsx');
        const col = makeLogCollector();
        const r = await recordQualityOnSubmit({
            dbAsync, requestId: reqId, submitterId: 9, submitterName: '示例用户A',
            submissionSeq: 1, smokeColumns: ['订单号', '金额', '部门', '客户'],  // SQL 多查了"客户"
            insertLog: col.insertLog, logger: quietLogger,
        });
        assert.strictEqual(r.recorded, true, '应写入');
        assert.strictEqual(r.is_columns_complete, 1, '应齐全');
        assert.deepStrictEqual(r.missing_columns, [], 'missing 应空');
        assert.strictEqual(r.reason, 'OK', 'reason 应 OK');
        const row = await get('SELECT * FROM collab_quality_record WHERE collab_request_id=?', [reqId]);
        assert.strictEqual(row.is_columns_complete, 1);
        assert.strictEqual(row.missing_columns, '[]', 'missing_columns 应存 JSON 空数组（L-1）');
        assert.strictEqual(row.submission_seq, 1);
        ok('齐全 + 多列放行（S⊋T）→ complete=1 / missing=[] / reason=OK / 入库');
    }

    // [2] 缺列：模板有需求列不在 SQL 结果
    {
        const reqId = 102;
        const { fileName } = writeXlsxFixture('t_missing.xlsx', ['订单号', '金额', '税额']);
        await insertTemplate(reqId, fileName, 't_missing.xlsx');
        const r = await recordQualityOnSubmit({
            dbAsync, requestId: reqId, submitterId: 9, submitterName: '示例用户A',
            submissionSeq: 1, smokeColumns: ['订单号', '金额'],  // 缺"税额"
            logger: quietLogger,
        });
        assert.strictEqual(r.is_columns_complete, 0, '应缺列');
        assert.deepStrictEqual(r.missing_columns, ['税额'], 'missing 应含税额');
        assert.strictEqual(r.reason, 'MISSING_COLUMNS');
        const row = await get('SELECT * FROM collab_quality_record WHERE collab_request_id=?', [reqId]);
        assert.strictEqual(row.missing_columns, JSON.stringify(['税额']), 'missing_columns 入库为 JSON 数组');
        assert.strictEqual(row.expected_columns_snapshot, JSON.stringify(['订单号', '金额', '税额']), 'expected 快照');
        assert.strictEqual(row.actual_columns_snapshot, JSON.stringify(['订单号', '金额']), 'actual 快照');
        ok('缺列 → complete=0 / missing=[税额] / reason=MISSING_COLUMNS / 快照入库');
    }

    // ---------- 未比对三态（M-1 来源区分）----------
    console.log('\n[未比对三态：NULL 来源区分（codex 72 M-1）]');

    // [3] 无模板
    {
        const reqId = 103;
        const col = makeLogCollector();
        const r = await recordQualityOnSubmit({
            dbAsync, requestId: reqId, submitterId: 9, submitterName: '示例用户A',
            submissionSeq: 1, smokeColumns: ['a', 'b'],
            insertLog: col.insertLog, logger: quietLogger,
        });
        assert.strictEqual(r.recorded, true, '无模板也应留痕');
        assert.strictEqual(r.is_columns_complete, null, '应未比对 NULL');
        assert.strictEqual(r.reason, 'NO_TEMPLATE');
        const row = await get('SELECT * FROM collab_quality_record WHERE collab_request_id=?', [reqId]);
        assert.strictEqual(row.is_columns_complete, null, '入库 is_columns_complete=NULL');
        assert.strictEqual(row.missing_columns, null, '未比对 missing_columns 存 NULL（L-1）');
        assert.strictEqual(row.expected_columns_snapshot, null, '未比对 expected 存 NULL');
        assert.strictEqual(row.actual_columns_snapshot, JSON.stringify(['a', 'b']), 'actual 仍可取');
        assert.ok(col.logs.some(l => /NO_TEMPLATE/.test(l.reason)), 'operation_log 应记 NO_TEMPLATE');
        ok('无模板 → recorded=true / complete=NULL / reason=NO_TEMPLATE / missing&expected=NULL / log 区分');
    }

    // [4] 非 xlsx 模板（.pdf）
    {
        const reqId = 104;
        const { fileName } = writePdfFixture('t_doc.pdf');
        await insertTemplate(reqId, fileName, 't_doc.pdf');
        const r = await recordQualityOnSubmit({
            dbAsync, requestId: reqId, submitterId: 9, submitterName: '示例用户A',
            submissionSeq: 1, smokeColumns: ['a'], logger: quietLogger,
        });
        assert.strictEqual(r.is_columns_complete, null);
        assert.strictEqual(r.reason, 'NON_XLSX_TEMPLATE', '非 xlsx 应 reason=NON_XLSX_TEMPLATE');
        ok('非 xlsx 模板（.pdf）→ complete=NULL / reason=NON_XLSX_TEMPLATE（不试读，admin 有意传放行）');
    }

    // [5] 损坏 xlsx（截断 zip）
    {
        const reqId = 105;
        const { fileName } = writeBrokenXlsx('t_broken.xlsx');
        await insertTemplate(reqId, fileName, 't_broken.xlsx');
        const r = await recordQualityOnSubmit({
            dbAsync, requestId: reqId, submitterId: 9, submitterName: '示例用户A',
            submissionSeq: 1, smokeColumns: ['a'], logger: quietLogger,
        });
        assert.strictEqual(r.is_columns_complete, null, '读取失败应未比对 NULL（不当齐全，codex 69 M-4）');
        assert.strictEqual(r.reason, 'XLSX_READ_FAILED');
        ok('损坏 xlsx → complete=NULL / reason=XLSX_READ_FAILED（不伪装齐全）');
    }

    // ---------- 幂等（M-3 INSERT OR IGNORE）----------
    console.log('\n[幂等：INSERT OR IGNORE（codex 72 M-3）]');

    // [6] 同 request+seq 二次提交 → 跳过
    {
        const reqId = 106;
        const { fileName } = writeXlsxFixture('t_idem.xlsx', ['x']);
        await insertTemplate(reqId, fileName, 't_idem.xlsx');
        const args = {
            dbAsync, requestId: reqId, submitterId: 9, submitterName: '示例用户A',
            submissionSeq: 3, smokeColumns: ['x'], logger: quietLogger,
        };
        const r1 = await recordQualityOnSubmit(args);
        assert.strictEqual(r1.recorded, true, '首次应写入');
        const r2 = await recordQualityOnSubmit(args);   // 重复提交
        assert.strictEqual(r2.recorded, false, '二次应幂等跳过');
        assert.strictEqual(r2.reason, 'SKIPPED_EXISTING');
        const cnt = await get('SELECT COUNT(*) c FROM collab_quality_record WHERE collab_request_id=?', [reqId]);
        assert.strictEqual(cnt.c, 1, '同 request+seq 只 1 行（唯一索引兜底）');
        ok('同 request+seq 二次 → recorded=false / reason=SKIPPED_EXISTING / 仅 1 行');
    }

    // [7] submission_seq 递增 → 各自独立记录（DONE 重传场景）
    {
        const reqId = 107;
        const { fileName } = writeXlsxFixture('t_seq.xlsx', ['x']);
        await insertTemplate(reqId, fileName, 't_seq.xlsx');
        for (const seq of [1, 2, 3]) {
            await recordQualityOnSubmit({
                dbAsync, requestId: reqId, submitterId: 9, submitterName: '示例用户A',
                submissionSeq: seq, smokeColumns: ['x'], logger: quietLogger,
            });
        }
        const rows = await all('SELECT submission_seq, submitted_at FROM collab_quality_record WHERE collab_request_id=? ORDER BY submission_seq', [reqId]);
        assert.strictEqual(rows.length, 3, '3 次提交应 3 行');
        assert.deepStrictEqual(rows.map(r => r.submission_seq), [1, 2, 3]);
        rows.forEach(r => assert.ok(r.submitted_at && r.submitted_at.length >= 10, 'submitted_at 每条独立有值（H-1 非首次时间）'));
        ok('submission_seq 1/2/3 → 3 行独立 / 各有 submitted_at（H-1：每次提交独立时间）');
    }

    // ---------- M-2 多模板取最新 ----------
    console.log('\n[多模板取最新（codex 72 M-2 稳定排序）]');
    {
        const reqId = 108;
        // 先插旧模板（缺列），再插新模板（齐全）——取最新应判齐全
        const { fileName: f1 } = writeXlsxFixture('t_old.xlsx', ['订单号', '废弃列']);
        await insertTemplate(reqId, f1, 't_old.xlsx');
        await new Promise(r => setTimeout(r, 1100));  // 拉开 created_at（秒级）
        const { fileName: f2 } = writeXlsxFixture('t_new.xlsx', ['订单号']);
        await insertTemplate(reqId, f2, 't_new.xlsx');
        const r = await recordQualityOnSubmit({
            dbAsync, requestId: reqId, submitterId: 9, submitterName: '示例用户A',
            submissionSeq: 1, smokeColumns: ['订单号'], logger: quietLogger,
        });
        // 取最新模板 t_new（只要订单号）→ 齐全；若取了旧模板会因"废弃列"判缺列
        assert.strictEqual(r.is_columns_complete, 1, '应取最新模板判齐全');
        assert.strictEqual(r.reason, 'OK');
        ok('多模板 → 取最新（created_at DESC）判齐全，不取旧模板');
    }

    // ---------- H-2 异常隔离 + 防御 ----------
    console.log('\n[H-2 异常隔离 + smokeColumns 防御]');

    // [8] smokeColumns=undefined → 当 [] 不崩
    {
        const reqId = 109;
        const { fileName } = writeXlsxFixture('t_def.xlsx', ['a', 'b']);
        await insertTemplate(reqId, fileName, 't_def.xlsx');
        const r = await recordQualityOnSubmit({
            dbAsync, requestId: reqId, submitterId: 9, submitterName: '示例用户A',
            submissionSeq: 1, smokeColumns: undefined, logger: quietLogger,  // C1 透传可能 undefined
        });
        assert.strictEqual(r.is_columns_complete, 0, 'smokeColumns 空 + 模板有列 → 全缺列');
        assert.deepStrictEqual(r.missing_columns.sort(), ['a', 'b'], '应全部缺列');
        ok('smokeColumns=undefined → 视为 []（codex 71 M-2 多义）不崩 / 模板列全缺');
    }

    // [9] dbAsync 缺失 → 永不抛，返回结构完整 fail 对象（H-2）
    {
        const r = await recordQualityOnSubmit({
            requestId: 110, submitterId: 9, submitterName: '示例用户A',
            submissionSeq: 1, smokeColumns: ['a'], logger: quietLogger,
        });
        assert.strictEqual(r.recorded, false);
        assert.strictEqual(r.is_columns_complete, null);
        assert.deepStrictEqual(r.missing_columns, [], '失败也返回数组（不 undefined）');
        assert.strictEqual(r.reason, 'C2_FAILED');
        ok('dbAsync 缺失 → 永不抛 / 返回结构完整 {recorded:false, reason:C2_FAILED}（H-2）');
    }

    // [10] INSERT 异常（runAsync 抛）→ 隔离不抛，返回 C2_FAILED
    {
        const throwingDb = {
            getAsync: get,  // 查模板正常
            runAsync: () => { throw new Error('mock DB 写爆'); },
        };
        const reqId = 111;
        const { fileName } = writeXlsxFixture('t_throw.xlsx', ['a']);
        await insertTemplate(reqId, fileName, 't_throw.xlsx');  // 用真实 db 插模板
        const r = await recordQualityOnSubmit({
            dbAsync: throwingDb, requestId: reqId, submitterId: 9, submitterName: '示例用户A',
            submissionSeq: 1, smokeColumns: ['a'], logger: quietLogger,
        });
        assert.strictEqual(r.recorded, false, 'INSERT 抛 → 不记录');
        assert.strictEqual(r.reason, 'C2_FAILED', 'INSERT 异常 → reason=C2_FAILED');
        // 比对结果仍带回（complete=1 因为 a⊆a）——但 recorded=false
        assert.strictEqual(r.is_columns_complete, 1, '比对已完成结果仍带回');
        ok('INSERT 抛异常 → 隔离不抛 / recorded=false / reason=C2_FAILED / 比对结果仍带回');
    }

    console.log(`\n✅ 全部通过：${passed} 项`);
}

// 清理 fixture（无论成败）
function cleanup() {
    try {
        if (fs.existsSync(FIXTURE_ABS_DIR)) fs.rmSync(FIXTURE_ABS_DIR, { recursive: true, force: true });
    } catch (e) { /* ignore */ }
}

main()
    .then(() => { cleanup(); db.close(); process.exit(0); })
    .catch(e => { cleanup(); console.error('❌ 验证失败：', e.message, '\n', e.stack); db.close(); process.exit(1); });
