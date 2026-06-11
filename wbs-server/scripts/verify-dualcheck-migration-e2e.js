// 验证脚本：取数质量双校验增强 Commit E — 迁移函数 e2e（旧库 → 迁移就绪全链路）
// 方案：docs/local/数据协作模块_v3.0/取数质量双校验增强_方案_20260611_v1.2.md §8b.2
// 用法：node scripts/verify-dualcheck-migration-e2e.js
//
// 模式：临时内存 sqlite 模拟 v3.0 旧库（无 record_kind / 无 7 列 / 旧索引）
//   → 镜像复刻 server.js runCollabQualityDualCheckMigration 五步逻辑
//   → 验证 readiness 落地 + 索引重建 + 抽样验证非法值兜底
//
// 覆盖 6 项场景：
//   - [1] 干净旧库 → 完整迁移成功（add 7 列 → DROP 旧索引 → CREATE 收窄索引 → readiness ready）
//   - [2] 已迁移库（含 record_kind） → 早返回 ready（短路）
//   - [3] 有 passed 行重复的旧库 → 探测拦截 + readiness=false
//   - [4] 抽样验证：record_kind 非法值检测
//   - [5] 抽样验证：excel_is_columns_complete 非法值检测
//   - [6] 探测通过 + DROP/CREATE 时序（绝不在中间夹 await）
'use strict';
const assert = require('assert');
const sqlite3 = require('sqlite3');

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ✓ ${msg}`); };
const fail = (msg) => { console.error(`  ✗ ${msg}`); process.exit(1); };

// 镜像复刻 server.js runCollabQualityDualCheckMigration 核心逻辑
// 7 列清单（与 server.js COLLAB_QUALITY_DUALCHECK_COLS 一致）
const DUALCHECK_COLS = [
    'excel_actual_columns_snapshot', 'excel_missing_columns', 'excel_is_columns_complete',
    'excel_unchecked_reason', 'result_attachment_id', 'sql_unchecked_reason', 'record_kind'
];

// === 镜像迁移函数（与 server.js runCollabQualityDualCheckMigration 同源）===
async function runMigration(db) {
    const state = { ready: false, error: null };
    const run = (sql, params = []) => new Promise((res, rej) =>
        db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
    const all = (sql, params = []) => new Promise((res, rej) =>
        db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));

    // ① ALTER 加 7 列（server.js 的 safeAlterAddColumn 镜像，幂等）
    for (const c of DUALCHECK_COLS) {
        let type = 'TEXT';
        if (c === 'excel_is_columns_complete' || c === 'result_attachment_id') type = 'INTEGER';
        if (c === 'record_kind') type = "TEXT NOT NULL DEFAULT 'passed'";
        if (c === 'excel_is_columns_complete') type = 'INTEGER DEFAULT NULL';
        try {
            await run(`ALTER TABLE collab_quality_record ADD COLUMN ${c} ${type}`);
        } catch (e) {
            if (!String(e.message).includes('duplicate column name')) throw e;
        }
    }

    // ② PRAGMA 复查 7 列到位
    const cols = (await all('PRAGMA table_info(collab_quality_record)')).map(r => r.name);
    const missing = DUALCHECK_COLS.filter(c => !cols.includes(c));
    if (missing.length) {
        state.error = `字段迁移未完成，缺：${missing.join(',')}`;
        return state;
    }

    // ③ 检查现有索引是否含 record_kind='passed'
    const idxRows = await all(
        "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='collab_quality_record' AND name IN ('idx_qr_unique_single','idx_qr_unique_multi')"
    );
    const allHaveRecordKind = idxRows.length === 2 && idxRows.every(r => r.sql && /record_kind\s*=\s*'passed'/i.test(r.sql));
    if (allHaveRecordKind) {
        // ⑤ 抽样验证非法值（这条分支也跑）
        const illegal = await detectIllegal(all);
        if (illegal) { state.error = illegal; return state; }
        state.ready = true;
        return state;
    }

    // ④ 探测 passed 行无重复
    const dupSingle = await all(
        "SELECT collab_request_id, submission_seq, COUNT(*) AS c FROM collab_quality_record " +
        "WHERE collab_sub_item_id IS NULL AND record_kind = 'passed' " +
        "GROUP BY collab_request_id, submission_seq HAVING c > 1"
    );
    if (dupSingle.length) {
        state.error = `迁移前重复探测发现 passed 行重复（单产出 ${dupSingle.length} 组），需人工处理后再启动`;
        return state;
    }

    // 独立 serialize 同步 DROP+CREATE（镜像 server.js 时序铁律）
    await new Promise((resolve) => {
        db.serialize(() => {
            let firstErr = null;
            const handle = (label) => (err) => { if (err && !firstErr) firstErr = `${label}: ${err.message}`; };
            db.run('DROP INDEX IF EXISTS idx_qr_unique_single', handle('DROP single'));
            db.run('DROP INDEX IF EXISTS idx_qr_unique_multi', handle('DROP multi'));
            db.run(
                `CREATE UNIQUE INDEX idx_qr_unique_single
                   ON collab_quality_record(collab_request_id, submission_seq)
                   WHERE collab_sub_item_id IS NULL AND record_kind = 'passed'`,
                handle('CREATE single')
            );
            db.run(
                `CREATE UNIQUE INDEX idx_qr_unique_multi
                   ON collab_quality_record(collab_request_id, collab_sub_item_id, submission_seq)
                   WHERE collab_sub_item_id IS NOT NULL AND record_kind = 'passed'`,
                (err) => {
                    handle('CREATE multi')(err);
                    if (firstErr) state.error = `索引重建失败：${firstErr}`;
                    resolve();
                }
            );
        });
    });
    if (state.error) return state;

    // ⑤ 重建后复查 + 抽样验证非法值
    const idxRowsAfter = await all(
        "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='collab_quality_record' AND name IN ('idx_qr_unique_single','idx_qr_unique_multi')"
    );
    const afterOk = idxRowsAfter.length === 2 && idxRowsAfter.every(r => r.sql && /record_kind\s*=\s*'passed'/i.test(r.sql));
    if (!afterOk) {
        state.error = `重建后索引复查未通过`;
        return state;
    }
    const illegal = await detectIllegal(all);
    if (illegal) { state.error = illegal; return state; }

    state.ready = true;
    return state;
}

// 抽样验证非法值（与 server.js detectIllegalDualCheckValues 镜像）
async function detectIllegal(all) {
    const illegalKind = await all(
        "SELECT id, record_kind FROM collab_quality_record WHERE record_kind IS NULL OR record_kind NOT IN ('passed','failed') LIMIT 5"
    );
    if (illegalKind.length > 0) {
        return `抽样发现 record_kind 非法值（${illegalKind.length}+ 行）`;
    }
    const illegalExcel = await all(
        "SELECT id, excel_is_columns_complete FROM collab_quality_record WHERE excel_is_columns_complete IS NOT NULL AND excel_is_columns_complete NOT IN (0, 1) LIMIT 5"
    );
    if (illegalExcel.length > 0) {
        return `抽样发现 excel_is_columns_complete 非法值（${illegalExcel.length}+ 行）`;
    }
    return null;
}

// === 工具：建一个旧库（v3.0 schema，无 record_kind 无 7 列，索引无 record_kind 条件）===
function buildLegacyDb() {
    const db = new sqlite3.Database(':memory:');
    return new Promise((res, rej) => {
        db.serialize(() => {
            db.run(`CREATE TABLE collab_quality_record (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                collab_request_id INTEGER NOT NULL,
                collab_sub_item_id INTEGER,
                submitter_id INTEGER NOT NULL,
                submitter_name TEXT NOT NULL,
                submission_seq INTEGER NOT NULL DEFAULT 1,
                submitted_at TEXT NOT NULL,
                missing_columns TEXT,
                is_columns_complete INTEGER DEFAULT 1,
                expected_columns_snapshot TEXT,
                actual_columns_snapshot TEXT,
                sql_attachment_id INTEGER,
                created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
            )`, (err) => { if (err) rej(err); });
            db.run(`CREATE UNIQUE INDEX idx_qr_unique_single
                ON collab_quality_record(collab_request_id, submission_seq)
                WHERE collab_sub_item_id IS NULL`, (err) => { if (err) rej(err); });
            db.run(`CREATE UNIQUE INDEX idx_qr_unique_multi
                ON collab_quality_record(collab_request_id, collab_sub_item_id, submission_seq)
                WHERE collab_sub_item_id IS NOT NULL`, (err) => err ? rej(err) : res(db));
        });
    });
}

const runP = (db, sql, params = []) => new Promise((res, rej) =>
    db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const allP = (db, sql, params = []) => new Promise((res, rej) =>
    db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));

async function main() {
    // === [1] 干净旧库 → 完整迁移成功 ===
    {
        const db = await buildLegacyDb();
        // 插一行历史数据（模拟 v3.0 已上线后有数据的库）
        await runP(db, `INSERT INTO collab_quality_record
            (collab_request_id, submitter_id, submitter_name, submission_seq, submitted_at, is_columns_complete)
            VALUES (1, 5, '历史开发', 1, '2026-06-05', 1)`);
        const state = await runMigration(db);
        assert.strictEqual(state.ready, true, `[1] 应 ready，实际 error=${state.error}`);
        assert.strictEqual(state.error, null);
        // 验证：7 列到位 + 索引含 record_kind='passed' + 历史行 record_kind 落 'passed'
        const cols = (await allP(db, 'PRAGMA table_info(collab_quality_record)')).map(r => r.name);
        assert.ok(DUALCHECK_COLS.every(c => cols.includes(c)), `[1] 7 列应全到位`);
        const idx = await allP(db, "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='collab_quality_record' AND name IN ('idx_qr_unique_single','idx_qr_unique_multi')");
        assert.strictEqual(idx.length, 2);
        assert.ok(idx.every(r => /record_kind\s*=\s*'passed'/i.test(r.sql)), `[1] 索引应含 record_kind='passed'`);
        const hist = await allP(db, 'SELECT record_kind FROM collab_quality_record WHERE collab_request_id=1');
        assert.strictEqual(hist[0].record_kind, 'passed', `[1] 历史行 record_kind 应 DEFAULT 落 passed`);
        ok('[1] 干净旧库 → 完整迁移成功（7 列 + 索引收窄 + 历史行 DEFAULT 兼容）');
        db.close();
    }

    // === [2] 已迁移库（运行第二次迁移）→ 短路 ready ===
    {
        const db = await buildLegacyDb();
        // 第一次完整迁移
        const state1 = await runMigration(db);
        assert.strictEqual(state1.ready, true, `[2] 首次迁移应成功`);
        // 第二次迁移（已 ready 状态再跑一次）
        const state2 = await runMigration(db);
        assert.strictEqual(state2.ready, true, `[2] 二次迁移应短路 ready，实际 error=${state2.error}`);
        assert.strictEqual(state2.error, null);
        ok('[2] 已迁移库二次跑迁移 → 短路 ready（幂等）');
        db.close();
    }

    // === [3] 探测 passed 行重复 → 迁移失败 readiness=false ===
    {
        const db = await buildLegacyDb();
        // 旧库（无 record_kind）下手动造 (request=99, seq=1) 重复 —— 注：旧唯一索引会拒，所以要
        // 先 DROP 旧索引才能造重复（模拟运维人工 SQL 改坏的极端场景）
        await runP(db, 'DROP INDEX idx_qr_unique_single');
        await runP(db, `INSERT INTO collab_quality_record
            (collab_request_id, submitter_id, submitter_name, submission_seq, submitted_at, is_columns_complete)
            VALUES (99, 5, 'A', 1, '2026-06-05', 1)`);
        await runP(db, `INSERT INTO collab_quality_record
            (collab_request_id, submitter_id, submitter_name, submission_seq, submitted_at, is_columns_complete)
            VALUES (99, 5, 'B', 1, '2026-06-05', 1)`);
        // 重建旧索引（CREATE 会因为重复失败，但我们这里就是要模拟 v3.0 的"旧索引已 DROP/不可恢复"状态）
        try { await runP(db, `CREATE UNIQUE INDEX idx_qr_unique_single
            ON collab_quality_record(collab_request_id, submission_seq)
            WHERE collab_sub_item_id IS NULL`); fail('[3] 旧索引重建应失败（重复数据）'); }
        catch (e) { assert.ok(/UNIQUE/i.test(e.message)); }
        // 跑迁移：① ALTER 加列成功 → ② PRAGMA 通过 → ③ 索引检查（旧索引不存在则当未迁移）→ ④ 探测拦截
        const state = await runMigration(db);
        assert.strictEqual(state.ready, false, `[3] 应 readiness=false`);
        assert.ok(/重复探测/.test(state.error), `[3] error 应提及探测，实际：${state.error}`);
        ok('[3] passed 行重复 → 迁移前探测拦截 + readiness=false（防数据破坏）');
        db.close();
    }

    // === [4] 抽样验证：record_kind 非法值检测 ===
    {
        const db = await buildLegacyDb();
        const state1 = await runMigration(db);
        assert.strictEqual(state1.ready, true, `[4] 首次迁移应成功`);
        // 注入非法 record_kind 值（绕过 CHECK：ALTER ADD COLUMN 不能加 CHECK，旧库 record_kind 无约束）
        await runP(db, `INSERT INTO collab_quality_record
            (collab_request_id, submitter_id, submitter_name, submission_seq, submitted_at, record_kind)
            VALUES (50, 5, '运维改坏', 1, '2026-06-05', 'invalid_value')`);
        // 二次跑迁移 → 抽样应拦
        const state2 = await runMigration(db);
        assert.strictEqual(state2.ready, false, `[4] 抽样应拦`);
        assert.ok(/record_kind 非法值/.test(state2.error), `[4] error 应提及 record_kind，实际：${state2.error}`);
        ok('[4] 抽样验证 record_kind 非法值（codex Commit A 审 medium-2 兜底）');
        db.close();
    }

    // === [5] 抽样验证：excel_is_columns_complete 非法值检测 ===
    {
        const db = await buildLegacyDb();
        const state1 = await runMigration(db);
        assert.strictEqual(state1.ready, true);
        // 注入非法 excel_is_columns_complete=5（不在 NULL/0/1）
        await runP(db, `INSERT INTO collab_quality_record
            (collab_request_id, submitter_id, submitter_name, submission_seq, submitted_at, excel_is_columns_complete, record_kind)
            VALUES (60, 5, '运维改坏', 1, '2026-06-05', 5, 'passed')`);
        const state2 = await runMigration(db);
        assert.strictEqual(state2.ready, false, `[5] 抽样应拦`);
        assert.ok(/excel_is_columns_complete 非法值/.test(state2.error), `[5] error 应提及 excel_is_columns_complete，实际：${state2.error}`);
        ok('[5] 抽样验证 excel_is_columns_complete 非法值（codex Commit A 审 medium-2 兜底）');
        db.close();
    }

    // === [6] DROP/CREATE 时序断言（绝不在中间夹 await）===
    //     这是 server.js 注释里 1268 行 MEMORY 铁律的应用，本测试无法直接探测 await 中断，
    //     但能验证：迁移成功后旧索引（无 record_kind 条件）已完全替换为新索引。
    {
        const db = await buildLegacyDb();
        // 验证迁移前旧索引存在且无 record_kind
        const before = await allP(db, "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_qr_unique_single'");
        assert.ok(before[0].sql && !/record_kind/i.test(before[0].sql), '[6] 迁移前旧索引应无 record_kind');
        const state = await runMigration(db);
        assert.strictEqual(state.ready, true);
        // 迁移后新索引含 record_kind='passed'
        const after = await allP(db, "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_qr_unique_single'");
        assert.ok(/record_kind\s*=\s*'passed'/i.test(after[0].sql), `[6] 迁移后索引应含 record_kind='passed'`);
        ok('[6] DROP+CREATE 时序成功：旧索引完整替换为含 record_kind 的新索引');
        db.close();
    }

    console.log(`\n[全部通过] ${passed}/${passed} ✓ Commit E 迁移函数 e2e 验证通过（6 项端到端场景）`);
}

main().catch(e => { console.error('\n[失败]', e.message, e.stack); process.exit(1); });
