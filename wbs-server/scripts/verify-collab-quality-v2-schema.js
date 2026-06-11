// 验证脚本：取数质量双校验增强 Commit A — 7 列 + 三态 CHECK + record_kind + 索引收窄
// 方案：docs/local/数据协作模块_v3.0/取数质量双校验增强_方案_20260611_v1.2.md §3-§4.4 / §8b.2
// 用法：node scripts/verify-collab-quality-v2-schema.js
// 模式：临时内存 sqlite，复刻 server.js 新版 DDL，验证字段/约束/索引收窄/旧库迁移路径。不碰生产 db。
const assert = require('assert');
const sqlite3 = require('sqlite3');

const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) =>
    db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) =>
    db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) =>
    db.get(sql, params, (e, row) => e ? rej(e) : res(row)));

// === 与 server.js Commit A 同步的新 DDL（含双校验 7 列 + 收窄索引）===
const DDL_QUALITY_DUALCHECK = `CREATE TABLE collab_quality_record (
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
const IDX_SINGLE_DUALCHECK = `CREATE UNIQUE INDEX idx_qr_unique_single
    ON collab_quality_record(collab_request_id, submission_seq)
    WHERE collab_sub_item_id IS NULL AND record_kind = 'passed'`;
const IDX_MULTI_DUALCHECK = `CREATE UNIQUE INDEX idx_qr_unique_multi
    ON collab_quality_record(collab_request_id, collab_sub_item_id, submission_seq)
    WHERE collab_sub_item_id IS NOT NULL AND record_kind = 'passed'`;

// 旧 DDL（v3.0 Commit A 当时的索引，无 record_kind 条件）—— 用于模拟旧库迁移路径
const IDX_SINGLE_V1 = `CREATE UNIQUE INDEX idx_qr_unique_single_v1
    ON collab_quality_record(collab_request_id, submission_seq)
    WHERE collab_sub_item_id IS NULL`;

const DUALCHECK_NEW_COLS = ['excel_actual_columns_snapshot', 'excel_missing_columns', 'excel_is_columns_complete',
    'excel_unchecked_reason', 'result_attachment_id', 'sql_unchecked_reason', 'record_kind'];

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ✓ ${msg}`); };

async function main() {
    await run(DDL_QUALITY_DUALCHECK);
    await run(IDX_SINGLE_DUALCHECK);
    await run(IDX_MULTI_DUALCHECK);
    ok('新版建表 + 两收窄唯一索引建立成功');

    // [1] 双校验 7 列齐全
    const cols = (await all('PRAGMA table_info(collab_quality_record)')).map(r => r.name);
    const missing = DUALCHECK_NEW_COLS.filter(c => !cols.includes(c));
    assert.strictEqual(missing.length, 0, `双校验新列缺失: ${missing.join(',')}`);
    ok(`双校验新增 7 列齐全：${DUALCHECK_NEW_COLS.join(' / ')}`);

    // [2] excel_is_columns_complete 三态 CHECK（同 is_columns_complete 范式）
    // 2a：NULL 允许
    await run(`INSERT INTO collab_quality_record (collab_request_id, submitter_id, submitter_name, submission_seq, submitted_at, excel_is_columns_complete) VALUES (1, 5, '开发', 1, '2026-06-12', NULL)`);
    const row1 = await get(`SELECT excel_is_columns_complete FROM collab_quality_record WHERE collab_request_id=1`);
    assert.strictEqual(row1.excel_is_columns_complete, null, 'excel_is_columns_complete=NULL 应允许');
    ok('excel_is_columns_complete=NULL 可写（未比对态）');
    // 2b：0/1 允许
    await run(`INSERT INTO collab_quality_record (collab_request_id, submitter_id, submitter_name, submission_seq, submitted_at, excel_is_columns_complete) VALUES (2, 5, '开发', 1, '2026-06-12', 0)`);
    await run(`INSERT INTO collab_quality_record (collab_request_id, submitter_id, submitter_name, submission_seq, submitted_at, excel_is_columns_complete) VALUES (3, 5, '开发', 1, '2026-06-12', 1)`);
    ok('excel_is_columns_complete=0/1 可写');
    // 2c：2 被拒
    await assert.rejects(
        run(`INSERT INTO collab_quality_record (collab_request_id, submitter_id, submitter_name, submission_seq, submitted_at, excel_is_columns_complete) VALUES (4, 5, '开发', 1, '2026-06-12', 2)`),
        /CHECK/, 'excel_is_columns_complete CHECK IN(0,1) 未生效');
    ok('CHECK：excel_is_columns_complete=2 被拒');

    // [3] record_kind 默认 'passed' + CHECK + 非法值被拒
    // 3a：默认值
    const dflt = await get(`SELECT record_kind FROM collab_quality_record WHERE collab_request_id=1`);
    assert.strictEqual(dflt.record_kind, 'passed', `record_kind 默认应为 'passed'，实际 ${dflt.record_kind}`);
    ok(`record_kind DEFAULT 'passed' 生效（历史行自动兼容）`);
    // 3b：显式 failed 允许
    await run(`INSERT INTO collab_quality_record (collab_request_id, submitter_id, submitter_name, submission_seq, submitted_at, record_kind) VALUES (5, 5, '开发', 1, '2026-06-12', 'failed')`);
    ok(`record_kind='failed' 可写`);
    // 3c：非法值被拒
    await assert.rejects(
        run(`INSERT INTO collab_quality_record (collab_request_id, submitter_id, submitter_name, submission_seq, submitted_at, record_kind) VALUES (6, 5, '开发', 1, '2026-06-12', 'invalid')`),
        /CHECK/, 'record_kind CHECK IN(passed,failed) 未生效');
    ok(`CHECK：record_kind='invalid' 被拒`);

    // [4] 唯一索引收窄到 record_kind='passed' —— 关键不变量
    // 4a：sqlite_master.sql 含 record_kind='passed' 字串
    const idxRows = await all("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='collab_quality_record' AND name IN ('idx_qr_unique_single','idx_qr_unique_multi')");
    assert.strictEqual(idxRows.length, 2, '两个唯一索引应都存在');
    for (const r of idxRows) {
        assert.ok(/record_kind\s*=\s*'passed'/i.test(r.sql), `索引 ${r.name} WHERE 应含 record_kind='passed'，实际 ${r.sql}`);
    }
    ok(`两个唯一索引 WHERE 含 record_kind='passed' 条件（方案 §4.4）`);

    // 4b：单产出 passed 重复（同 request+seq+sub_item NULL）被拒
    await run(`INSERT INTO collab_quality_record (collab_request_id, submitter_id, submitter_name, submission_seq, submitted_at, record_kind) VALUES (100, 5, '开发', 1, '2026-06-12', 'passed')`);
    await assert.rejects(
        run(`INSERT INTO collab_quality_record (collab_request_id, submitter_id, submitter_name, submission_seq, submitted_at, record_kind) VALUES (100, 5, '开发', 1, '2026-06-12', 'passed')`),
        /UNIQUE/, '单产出 passed 重复未被唯一索引拒');
    ok(`单产出唯一约束：passed+passed 同 (request,seq) 被拒`);

    // 4c：单产出 failed 多次 append 不冲突（第十人视角简化的核心：failed 不进唯一索引）
    await run(`INSERT INTO collab_quality_record (collab_request_id, submitter_id, submitter_name, submission_seq, submitted_at, record_kind) VALUES (100, 5, '开发', 1, '2026-06-12 10:00', 'failed')`);
    await run(`INSERT INTO collab_quality_record (collab_request_id, submitter_id, submitter_name, submission_seq, submitted_at, record_kind) VALUES (100, 5, '开发', 1, '2026-06-12 10:01', 'failed')`);
    await run(`INSERT INTO collab_quality_record (collab_request_id, submitter_id, submitter_name, submission_seq, submitted_at, record_kind) VALUES (100, 5, '开发', 1, '2026-06-12 10:02', 'failed')`);
    const failedRows = await all(`SELECT id FROM collab_quality_record WHERE collab_request_id=100 AND record_kind='failed' ORDER BY id`);
    assert.strictEqual(failedRows.length, 3, `单产出 failed 应允许 3 次 append，实际 ${failedRows.length}`);
    ok(`单产出 failed 纯 append：3 次 (request=100, seq=1, failed) 全落 + 不撞 passed`);

    // 4d：passed + failed 共存（同 request+seq，1 passed + N failed）—— 方案 §8b.1 必须能支持
    const allKinds = await all(`SELECT record_kind FROM collab_quality_record WHERE collab_request_id=100 AND submission_seq=1 ORDER BY record_kind, id`);
    const kinds = allKinds.map(r => r.record_kind);
    assert.deepStrictEqual(kinds, ['failed', 'failed', 'failed', 'passed'], `passed+failed 共存矩阵不符：${kinds}`);
    ok(`关键矩阵：同 (request=100, seq=1) 1 passed + 3 failed 共存（读路径 §8b.1 需过滤 record_kind）`);

    // 4e：多产出唯一约束：同 request+sub_item+seq+passed 重复被拒，failed 不参与
    await run(`INSERT INTO collab_quality_record (collab_request_id, collab_sub_item_id, submitter_id, submitter_name, submission_seq, submitted_at, record_kind) VALUES (200, 300, 5, '开发', 1, '2026-06-12', 'passed')`);
    await assert.rejects(
        run(`INSERT INTO collab_quality_record (collab_request_id, collab_sub_item_id, submitter_id, submitter_name, submission_seq, submitted_at, record_kind) VALUES (200, 300, 5, '开发', 1, '2026-06-12', 'passed')`),
        /UNIQUE/, '多产出 passed 重复未被唯一索引拒');
    // failed append-only
    await run(`INSERT INTO collab_quality_record (collab_request_id, collab_sub_item_id, submitter_id, submitter_name, submission_seq, submitted_at, record_kind) VALUES (200, 300, 5, '开发', 1, '2026-06-12', 'failed')`);
    await run(`INSERT INTO collab_quality_record (collab_request_id, collab_sub_item_id, submitter_id, submitter_name, submission_seq, submitted_at, record_kind) VALUES (200, 300, 5, '开发', 1, '2026-06-12', 'failed')`);
    ok(`多产出唯一约束：passed 重复被拒 + failed 2 次 append 不冲突`);

    // [5] 旧库迁移路径模拟：清空到干净 passed 数据 → 建无 record_kind 条件的旧索引 → DROP → 复查
    //     注：旧索引（无 record_kind 条件）若直接在含 mixed-kind 数据的表上建会违反唯一约束，
    //     因为它把同 (request,seq) 下的 1 passed + N failed 看成 N+1 个"重复"——这恰恰是 §4.4 新索引
    //     收窄到 record_kind='passed' 的根本理由。本测试仅用于验证 DROP/CREATE 命令本身的迁移机制。
    await run('DELETE FROM collab_quality_record');
    await run(`INSERT INTO collab_quality_record (collab_request_id, submitter_id, submitter_name, submission_seq, submitted_at, record_kind) VALUES (500, 5, '开发', 1, '2026-06-12', 'passed')`);
    await run(IDX_SINGLE_V1);
    const v1Row = await get("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_qr_unique_single_v1'");
    assert.ok(!/record_kind/i.test(v1Row.sql), '旧索引 SQL 不应含 record_kind（用于模拟）');
    ok(`旧索引建立（模拟未迁移状态）：${v1Row.sql.replace(/\s+/g, ' ').slice(0, 80)}...`);
    await run('DROP INDEX idx_qr_unique_single_v1');
    const v1Gone = await get("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_qr_unique_single_v1'");
    assert.strictEqual(v1Gone, undefined, '旧索引 DROP 后应不存在');
    ok(`迁移路径：旧索引 DROP IF EXISTS → 不存在`);

    // [6] 重复探测 SQL 在干净数据上无重复返回
    const dups = await all(
        "SELECT collab_request_id, submission_seq, COUNT(*) AS c FROM collab_quality_record " +
        "WHERE collab_sub_item_id IS NULL AND record_kind = 'passed' " +
        "GROUP BY collab_request_id, submission_seq HAVING c > 1"
    );
    assert.strictEqual(dups.length, 0, `passed 行不应有 (request,seq) 重复，实际 ${dups.length} 组`);
    ok(`迁移前探测 SQL（passed 行 (request,seq) 无重复）契约成立`);

    // [7] passed 写入时若漏 record_kind 显式值，自动落 'passed'（保护 v1 老调用路径）
    await run(`INSERT INTO collab_quality_record (collab_request_id, submitter_id, submitter_name, submission_seq, submitted_at) VALUES (999, 5, '老调用', 1, '2026-06-12')`);
    const oldStyle = await get(`SELECT record_kind FROM collab_quality_record WHERE collab_request_id=999`);
    assert.strictEqual(oldStyle.record_kind, 'passed', `v1 老调用未传 record_kind 应回退 'passed'，实际 ${oldStyle.record_kind}`);
    ok(`兼容性：v1 老 INSERT（不传 record_kind）自动落 'passed'`);

    // [8] 旧表 ALTER 历史行 dup 探测能命中（codex Commit A 审 medium-5：固化 SQLite ADD COLUMN DEFAULT 虚拟默认值契约）
    //     场景：建无 record_kind 列的旧表 → 插历史 v3.0 行（故意造 2 条 (request=777, seq=1)）→ ALTER ADD record_kind DEFAULT 'passed'
    //     → 跑迁移前 dup 探测 SQL → 应能找到那 1 组重复。
    //     这条 verify 固化了"DEFAULT 对 ADD COLUMN 之前已存在的行返回虚拟默认值"的 SQLite 行为契约。
    await new Promise((resolveLegacy) => {
        const legacyDb = new sqlite3.Database(':memory:');
        const legacyRun = (sql) => new Promise((res, rej) =>
            legacyDb.run(sql, function (e) { e ? rej(e) : res(this); }));
        const legacyAll = (sql) => new Promise((res, rej) =>
            legacyDb.all(sql, (e, rows) => e ? rej(e) : res(rows)));
        (async () => {
            try {
                // 旧表（v3.0 原始 schema，无 record_kind）
                await legacyRun(`CREATE TABLE collab_quality_record (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    collab_request_id INTEGER NOT NULL,
                    collab_sub_item_id INTEGER,
                    submitter_id INTEGER NOT NULL,
                    submitter_name TEXT NOT NULL,
                    submission_seq INTEGER NOT NULL DEFAULT 1,
                    submitted_at TEXT NOT NULL
                )`);
                // 故意造 2 条 (request=777, seq=1) 重复（生产正常不会有，但用户人工 SQL 改坏可能产生）
                await legacyRun(`INSERT INTO collab_quality_record (collab_request_id, submitter_id, submitter_name, submission_seq, submitted_at) VALUES (777, 5, '历史A', 1, '2026-06-01')`);
                await legacyRun(`INSERT INTO collab_quality_record (collab_request_id, submitter_id, submitter_name, submission_seq, submitted_at) VALUES (777, 5, '历史B', 1, '2026-06-02')`);
                // 模拟 Commit A 迁移：ALTER ADD record_kind DEFAULT 'passed'（不回填，历史行靠虚拟默认值）
                await legacyRun(`ALTER TABLE collab_quality_record ADD COLUMN record_kind TEXT NOT NULL DEFAULT 'passed'`);
                // 验证 ① 历史行 record_kind 读出为 'passed'（虚拟默认值生效）
                const legacyRows = await legacyAll('SELECT id, record_kind FROM collab_quality_record WHERE collab_request_id=777 ORDER BY id');
                assert.strictEqual(legacyRows.length, 2, '历史行应有 2 条');
                assert.ok(legacyRows.every(r => r.record_kind === 'passed'), `ALTER ADD COLUMN DEFAULT 后历史行 record_kind 应为 'passed'，实际 ${JSON.stringify(legacyRows)}`);
                ok(`SQLite 契约：ALTER ADD COLUMN DEFAULT 'passed' 后，历史行虚拟默认值读出为 'passed'`);
                // 验证 ② 迁移前 dup 探测 SQL 能命中那组历史重复
                const legacyDups = await legacyAll(
                    "SELECT collab_request_id, submission_seq, COUNT(*) AS c FROM collab_quality_record " +
                    "WHERE collab_sub_item_id IS NULL AND record_kind = 'passed' " +
                    "GROUP BY collab_request_id, submission_seq HAVING c > 1"
                );
                assert.strictEqual(legacyDups.length, 1, `迁移前 dup 探测应找到 1 组重复，实际 ${legacyDups.length}`);
                assert.strictEqual(legacyDups[0].collab_request_id, 777, '重复组 request_id 应为 777');
                assert.strictEqual(legacyDups[0].c, 2, '重复组计数应为 2');
                ok(`迁移前 dup 探测 SQL 能命中 ALTER 后历史行重复（(request=777, seq=1) → 2 条）`);
                legacyDb.close();
                resolveLegacy();
            } catch (e) {
                legacyDb.close();
                throw e;
            }
        })().catch(e => { console.error('\n[失败][8]', e.message); process.exit(1); });
    });

    console.log(`\n[全部通过] ${passed}/${passed} ✓ Commit A 双校验 schema 验证通过（7 列 + 三态 + record_kind + 收窄索引 + 迁移路径 + 旧表 dup 探测）`);
    db.close();
}

main().catch(e => { console.error('\n[失败]', e.message); db.close(); process.exit(1); });
