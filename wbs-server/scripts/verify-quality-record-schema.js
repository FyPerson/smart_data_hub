// 验证脚本：取数交付质量记录 v3.0 Commit A — schema + 两表 + 唯一约束 + CHECK
// 用法：node scripts/verify-quality-record-schema.js
// 模式：临时内存 sqlite，复刻 server.js 的两张新表 DDL，验证字段/约束/幂等。不碰生产 db。
const assert = require('assert');
const sqlite3 = require('sqlite3');

const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) =>
    db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) =>
    db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));

// === 与 server.js 同步的 DDL（Commit A）===
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
const DDL_RETURN = `CREATE TABLE collab_return_record (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collab_request_id INTEGER NOT NULL,
    collab_sub_item_id INTEGER,
    submission_seq INTEGER,
    returned_by INTEGER NOT NULL,
    returned_by_name TEXT NOT NULL,
    reason_type TEXT NOT NULL
        CHECK (reason_type IN ('DEV_QUALITY','REQ_CHANGE','ENV_ISSUE','BIZ_ADJUST')),
    reason_note TEXT,
    status_before TEXT,
    status_after TEXT,
    returned_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
)`;
const IDX_SINGLE = `CREATE UNIQUE INDEX idx_qr_unique_single
    ON collab_quality_record(collab_request_id, submission_seq)
    WHERE collab_sub_item_id IS NULL`;
const IDX_MULTI = `CREATE UNIQUE INDEX idx_qr_unique_multi
    ON collab_quality_record(collab_request_id, collab_sub_item_id, submission_seq)
    WHERE collab_sub_item_id IS NOT NULL`;

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ✓ ${msg}`); };

async function main() {
    await run(DDL_QUALITY);
    await run(DDL_RETURN);
    await run(IDX_SINGLE);
    await run(IDX_MULTI);
    ok('两表 + 两唯一索引建表成功');

    // [1] 字段齐全
    const qCols = (await all('PRAGMA table_info(collab_quality_record)')).map(r => r.name);
    const expectQ = ['id', 'collab_request_id', 'collab_sub_item_id', 'submitter_id', 'submitter_name',
        'submission_seq', 'submitted_at', 'missing_columns', 'is_columns_complete',
        'expected_columns_snapshot', 'actual_columns_snapshot', 'sql_attachment_id', 'created_at'];
    assert.deepStrictEqual(qCols, expectQ, `quality 字段不符: ${qCols}`);
    ok(`collab_quality_record 13 字段齐全`);

    const rCols = (await all('PRAGMA table_info(collab_return_record)')).map(r => r.name);
    const expectR = ['id', 'collab_request_id', 'collab_sub_item_id', 'submission_seq', 'returned_by',
        'returned_by_name', 'reason_type', 'reason_note', 'status_before', 'status_after', 'returned_at'];
    assert.deepStrictEqual(rCols, expectR, `return 字段不符: ${rCols}`);
    ok(`collab_return_record 11 字段齐全`);

    // [2] NOT NULL 生效（submitter_id 缺失应报错）
    await assert.rejects(
        run(`INSERT INTO collab_quality_record (collab_request_id, submitter_name, submitted_at) VALUES (1, 'x', '2026-06-05')`),
        /NOT NULL/, 'submitter_id NOT NULL 未生效');
    ok('NOT NULL 约束生效（submitter_id 缺失被拒）');

    // [3] 单产出（sub_item NULL）append-only：同 request 不同 seq 可多次插入
    await run(`INSERT INTO collab_quality_record (collab_request_id, submitter_id, submitter_name, submission_seq, submitted_at) VALUES (10, 5, '开发A', 1, '2026-06-05 10:00')`);
    await run(`INSERT INTO collab_quality_record (collab_request_id, submitter_id, submitter_name, submission_seq, submitted_at) VALUES (10, 5, '开发A', 2, '2026-06-05 11:00')`);
    const r10 = await all('SELECT submission_seq FROM collab_quality_record WHERE collab_request_id=10 ORDER BY submission_seq');
    assert.deepStrictEqual(r10.map(x => x.submission_seq), [1, 2], 'append-only 多 seq 失败');
    ok('单产出 append-only：同 request 多 seq 可追加');

    // [4] 单产出唯一约束：同 request + 同 seq + NULL sub_item 重复应被拒
    await assert.rejects(
        run(`INSERT INTO collab_quality_record (collab_request_id, submitter_id, submitter_name, submission_seq, submitted_at) VALUES (10, 5, '开发A', 1, '2026-06-05 10:05')`),
        /UNIQUE/, '单产出唯一约束未生效');
    ok('单产出唯一约束生效（request+seq 重复被拒，NULL sub_item）');

    // [5] 多产出：同 request 不同 sub_item 同 seq 不冲突（各记各的）
    await run(`INSERT INTO collab_quality_record (collab_request_id, collab_sub_item_id, submitter_id, submitter_name, submission_seq, submitted_at) VALUES (20, 100, 5, '开发A', 1, '2026-06-05')`);
    await run(`INSERT INTO collab_quality_record (collab_request_id, collab_sub_item_id, submitter_id, submitter_name, submission_seq, submitted_at) VALUES (20, 200, 5, '开发A', 1, '2026-06-05')`);
    ok('多产出：同 request 不同 sub_item 同 seq 不冲突');

    // [6] 多产出唯一约束：同 request + 同 sub_item + 同 seq 重复应被拒
    await assert.rejects(
        run(`INSERT INTO collab_quality_record (collab_request_id, collab_sub_item_id, submitter_id, submitter_name, submission_seq, submitted_at) VALUES (20, 100, 5, '开发A', 1, '2026-06-05')`),
        /UNIQUE/, '多产出唯一约束未生效');
    ok('多产出唯一约束生效（request+sub_item+seq 重复被拒）');

    // [7] is_columns_complete 默认 1
    const dflt = await all(`SELECT is_columns_complete FROM collab_quality_record WHERE collab_request_id=10 AND submission_seq=1`);
    assert.strictEqual(dflt[0].is_columns_complete, 1, 'is_columns_complete 默认非 1');
    ok('is_columns_complete 默认 1');

    // [7a] CHECK submission_seq >= 1（codex 68 M-2）：写 0/负数应被拒
    await assert.rejects(
        run(`INSERT INTO collab_quality_record (collab_request_id, submitter_id, submitter_name, submission_seq, submitted_at) VALUES (30, 5, '开发A', 0, '2026-06-05')`),
        /CHECK/, 'submission_seq CHECK(>=1) 未生效');
    ok('CHECK：submission_seq=0 被拒（M-2）');

    // [7b] CHECK is_columns_complete IN (0,1)（codex 68 M-2）：写 2 应被拒
    await assert.rejects(
        run(`INSERT INTO collab_quality_record (collab_request_id, submitter_id, submitter_name, submission_seq, submitted_at, is_columns_complete) VALUES (31, 5, '开发A', 1, '2026-06-05', 2)`),
        /CHECK/, 'is_columns_complete CHECK(IN 0,1) 未生效');
    ok('CHECK：is_columns_complete=2 被拒（M-2）');

    // [7c] is_columns_complete 允许 NULL（codex 69 M-4 三态：1=齐全/0=缺列/NULL=未比对）
    await run(`INSERT INTO collab_quality_record (collab_request_id, submitter_id, submitter_name, submission_seq, submitted_at, is_columns_complete) VALUES (32, 5, '开发A', 1, '2026-06-05', NULL)`);
    const nullRow = await all(`SELECT is_columns_complete FROM collab_quality_record WHERE collab_request_id=32`);
    assert.strictEqual(nullRow[0].is_columns_complete, null, 'is_columns_complete 应允许写 NULL');
    ok('M-4：is_columns_complete=NULL 可写（未比对态：模板读取异常兜底）');

    // [8] return_record CHECK 枚举：合法值通过
    for (const t of ['DEV_QUALITY', 'REQ_CHANGE', 'ENV_ISSUE', 'BIZ_ADJUST']) {
        await run(`INSERT INTO collab_return_record (collab_request_id, returned_by, returned_by_name, reason_type) VALUES (1, 3, '对接人', ?)`, [t]);
    }
    ok('return_record CHECK：4 个合法 reason_type 全通过');

    // [9] return_record CHECK：非法值被拒
    await assert.rejects(
        run(`INSERT INTO collab_return_record (collab_request_id, returned_by, returned_by_name, reason_type) VALUES (1, 3, '对接人', 'INVALID_TYPE')`),
        /CHECK/, 'reason_type CHECK 未生效');
    ok('return_record CHECK：非法 reason_type 被拒');

    console.log(`\n[全部通过] ${passed}/${passed} ✓ Commit A schema 验证通过`);
    db.close();
}

main().catch(e => { console.error('\n[失败]', e.message); db.close(); process.exit(1); });
