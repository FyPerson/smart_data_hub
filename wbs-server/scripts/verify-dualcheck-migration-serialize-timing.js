// 验证脚本：取数质量双校验 v1.80.1 hotfix — serialize 队列 vs migration PRAGMA 时序竞态
// 用法：node scripts/verify-dualcheck-migration-serialize-timing.js
//
// 背景：v1.80.0 生产 hotfix 根因——server.js 1920 行的 runCollabQualityDualCheckMigration() 在
// serialize 块**外**立即触发，PRAGMA 比 ALTER 队列先消耗，导致 readiness 永久 false。
// 表现：饶高成 14:18 重新上传被 503 拒；PM2 日志显示 ALTER 全部成功 + 列巡检通过，但 readiness=false。
//
// 修复（v1.80.1）：把迁移触发放进 serialize 块内最后一个 db.run 的 callback，保证它在 7 个 ALTER 排队消耗完后才跑。
//
// 本测试用真实 sqlite3 Database + db.serialize 模拟生产竞态场景：
//   - [1] 模拟 BUG 路径（serialize 块外触发）：PRAGMA 看到 0 列、readiness=false
//   - [2] 模拟 FIX 路径（serialize 块内 SELECT 1 callback 触发）：PRAGMA 看到 7 列、readiness=true
'use strict';
const assert = require('assert');
const sqlite3 = require('sqlite3');

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ✓ ${msg}`); };

const NEW_COLS = ['excel_actual_columns_snapshot', 'excel_missing_columns', 'excel_is_columns_complete',
    'excel_unchecked_reason', 'result_attachment_id', 'sql_unchecked_reason', 'record_kind'];

// 旧库（v3.0 schema，无 7 列）
function buildLegacyDb() {
    const db = new sqlite3.Database(':memory:');
    return new Promise((res, rej) => {
        db.run(`CREATE TABLE collab_quality_record (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            collab_request_id INTEGER NOT NULL,
            collab_sub_item_id INTEGER,
            submitter_id INTEGER NOT NULL,
            submitter_name TEXT NOT NULL,
            submission_seq INTEGER NOT NULL DEFAULT 1,
            submitted_at TEXT NOT NULL,
            is_columns_complete INTEGER DEFAULT 1
        )`, (err) => err ? rej(err) : res(db));
    });
}

// 模拟 server.js 的 ALTER 段（在 db.serialize 里发 7 个 safeAlterAddColumn 等价的 ALTER）
function fireSerializeAlters(db) {
    db.serialize(() => {
        for (const c of NEW_COLS) {
            let type = 'TEXT';
            if (c === 'excel_is_columns_complete') type = 'INTEGER DEFAULT NULL';
            if (c === 'result_attachment_id') type = 'INTEGER';
            if (c === 'record_kind') type = "TEXT NOT NULL DEFAULT 'passed'";
            db.run(`ALTER TABLE collab_quality_record ADD COLUMN ${c} ${type}`);
        }
    });
}

// 模拟 runCollabQualityDualCheckMigration 第一步 PRAGMA + readiness 判定
async function pretendMigration(db) {
    const state = { ready: false, error: null };
    const cols = await new Promise((resolve) => {
        db.all('PRAGMA table_info(collab_quality_record)', (err, rows) => {
            resolve(err ? null : (rows ? rows.map(r => r.name) : []));
        });
    });
    if (cols === null) {
        state.error = 'PRAGMA 失败';
        return state;
    }
    const missing = NEW_COLS.filter(c => !cols.includes(c));
    if (missing.length) {
        state.error = `字段迁移未完成，缺：${missing.join(',')}`;
        return state;
    }
    state.ready = true;
    return state;
}

async function main() {
    // === [1] BUG 路径：serialize 块外立即触发 → PRAGMA 与 ALTER 队列竞态 ===
    {
        const db = await buildLegacyDb();
        fireSerializeAlters(db);             // 7 个 ALTER 入队（异步串行执行）
        const state = await pretendMigration(db);  // 立即 PRAGMA（不等队列）
        assert.strictEqual(state.ready, false, '[1] BUG 路径应触发 readiness=false');
        assert.ok(state.error && state.error.includes('字段迁移未完成'),
            `[1] error 应提及"字段迁移未完成"，实际：${state.error}`);
        // 多列缺（≥5，本地通常 6 列缺；生产 PRAGMA 跑更早可能 7 列全缺——都是同源竞态）
        const missingMatch = state.error.match(/缺：(.+)$/);
        const missingCount = missingMatch ? missingMatch[1].split(',').length : 0;
        assert.ok(missingCount >= 5,
            `[1] 应有 ≥5 列缺失证明竞态，实际 ${missingCount} 列：${state.error}`);
        ok(`[1] BUG 路径复现：serialize 外立即 PRAGMA → ${missingCount} 列缺 readiness=false（饶高成 14:18 报错根因，生产是 7 列全缺）`);
        db.close();
    }

    // === [2] FIX 路径：serialize 块内 SELECT 1 callback 触发 → PRAGMA 在 ALTER 队列消耗完之后 ===
    {
        const db = await buildLegacyDb();
        let migrationState;
        await new Promise((resolve) => {
            db.serialize(() => {
                // ALTER 7 列入队
                for (const c of NEW_COLS) {
                    let type = 'TEXT';
                    if (c === 'excel_is_columns_complete') type = 'INTEGER DEFAULT NULL';
                    if (c === 'result_attachment_id') type = 'INTEGER';
                    if (c === 'record_kind') type = "TEXT NOT NULL DEFAULT 'passed'";
                    db.run(`ALTER TABLE collab_quality_record ADD COLUMN ${c} ${type}`);
                }
                // FIX：dummy SELECT 1 入队，callback 里触发 migration
                db.run('SELECT 1', async () => {
                    migrationState = await pretendMigration(db);
                    resolve();
                });
            });
        });
        assert.strictEqual(migrationState.ready, true,
            `[2] FIX 路径应 ready=true，实际 error=${migrationState.error}`);
        assert.strictEqual(migrationState.error, null);
        ok('[2] FIX 路径：serialize 内 SELECT 1 callback 触发 → ALTER 队列消耗完后 PRAGMA → 7 列齐全 readiness=true');
        db.close();
    }

    // === [3] 反复 BUG/FIX 多次验证时序稳定性（防"偶然 PASS"）===
    {
        let bugCount = 0;
        let fixCount = 0;
        for (let i = 0; i < 5; i++) {
            // BUG 路径
            const db1 = await buildLegacyDb();
            fireSerializeAlters(db1);
            const s1 = await pretendMigration(db1);
            if (!s1.ready) bugCount++;
            db1.close();
            // FIX 路径
            const db2 = await buildLegacyDb();
            let s2;
            await new Promise((resolve) => {
                db2.serialize(() => {
                    for (const c of NEW_COLS) {
                        let type = 'TEXT';
                        if (c === 'excel_is_columns_complete') type = 'INTEGER DEFAULT NULL';
                        if (c === 'result_attachment_id') type = 'INTEGER';
                        if (c === 'record_kind') type = "TEXT NOT NULL DEFAULT 'passed'";
                        db2.run(`ALTER TABLE collab_quality_record ADD COLUMN ${c} ${type}`);
                    }
                    db2.run('SELECT 1', async () => {
                        s2 = await pretendMigration(db2);
                        resolve();
                    });
                });
            });
            if (s2.ready) fixCount++;
            db2.close();
        }
        assert.strictEqual(bugCount, 5, `[3] BUG 路径应 5/5 触发竞态，实际 ${bugCount}/5`);
        assert.strictEqual(fixCount, 5, `[3] FIX 路径应 5/5 ready，实际 ${fixCount}/5`);
        ok(`[3] 反复 5 次：BUG 路径 5/5 触发竞态 + FIX 路径 5/5 ready（时序稳定性证据）`);
    }

    console.log(`\n[全部通过] ${passed}/${passed} ✓ v1.80.1 hotfix serialize 时序竞态验证通过`);
}

main().catch(e => { console.error('\n[失败]', e.message, e.stack); process.exit(1); });
