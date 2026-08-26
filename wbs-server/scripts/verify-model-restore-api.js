'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { restoreModelRecord, ModelRestoreError } = require('../utils/model-restore');

function openDb() {
    const db = new sqlite3.Database(':memory:');
    return {
        db,
        run(sql, params = []) {
            return new Promise((resolve, reject) => {
                db.run(sql, params, function (err) {
                    if (err) reject(err);
                    else resolve(this);
                });
            });
        },
        get(sql, params = []) {
            return new Promise((resolve, reject) => {
                db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
            });
        }
    };
}

async function expectRestoreError(promise, code, status) {
    let caught = null;
    try { await promise; } catch (err) { caught = err; }
    assert(caught instanceof ModelRestoreError, `应抛出 ModelRestoreError，实际 ${caught}`);
    assert.strictEqual(caught.code, code);
    assert.strictEqual(caught.status, status);
}

async function main() {
    const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(
        serverSource,
        /app\.post\('\/api\/models\/:id\/restore', authenticateToken, requireAdmin/,
        '恢复接口必须同时启用登录与管理员权限中间件'
    );

    const { db, run, get } = openDb();
    try {
        await run(`CREATE TABLE data_models (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT NOT NULL,
            status TEXT,
            is_deleted INTEGER DEFAULT 0,
            deleted_at TEXT,
            deleted_by INTEGER,
            delete_reason TEXT,
            updated_at TEXT
        )`);
        await run(`CREATE TABLE model_change_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            model_id INTEGER,
            model_name TEXT,
            action TEXT NOT NULL,
            change_type TEXT,
            before_value TEXT,
            after_value TEXT,
            change_summary TEXT,
            operator_id INTEGER,
            operator_name TEXT,
            created_at TEXT DEFAULT (datetime('now', 'localtime'))
        )`);

        await run(
            `INSERT INTO data_models
             (id, table_name, status, is_deleted, deleted_at, deleted_by, delete_reason, updated_at)
             VALUES (151, 'ods_due_df', 'DEVELOPING', 1, '2026-08-24 11:09:11', 1, '范围调整', '2026-08-24 10:11:40')`
        );

        const restored = await restoreModelRecord({
            modelId: 151,
            operatorId: 1,
            operatorName: '测试管理员',
            dbRunAsync: run,
            dbGetAsync: get
        });
        assert.strictEqual(restored.alreadyRestored, false);
        assert.strictEqual(restored.model.id, 151, '必须保留原模型 ID');
        assert.strictEqual(restored.model.status, 'DEVELOPING', '不得改写模型业务状态');
        assert.strictEqual(restored.model.is_deleted, 0);
        assert.strictEqual(restored.model.deleted_at, null);
        assert.strictEqual(restored.model.deleted_by, null);
        assert.strictEqual(restored.model.delete_reason, null);

        const audit = await get('SELECT * FROM model_change_logs WHERE model_id = 151');
        assert.strictEqual(audit.action, 'RESTORE');
        assert.strictEqual(audit.change_type, 'restore');
        assert.strictEqual(audit.operator_id, 1);
        assert.strictEqual(JSON.parse(audit.before_value).is_deleted, 1);
        assert.strictEqual(JSON.parse(audit.after_value).is_deleted, 0);

        const retry = await restoreModelRecord({
            modelId: 151,
            operatorId: 1,
            operatorName: '测试管理员',
            dbRunAsync: run,
            dbGetAsync: get
        });
        assert.strictEqual(retry.alreadyRestored, true, '重复请求必须幂等');
        const auditCount = await get('SELECT COUNT(*) AS count FROM model_change_logs WHERE model_id = 151');
        assert.strictEqual(auditCount.count, 1, '幂等重试不得重复写审计');

        await run("INSERT INTO data_models (id, table_name, is_deleted) VALUES (156, 'ods_due_out_detail_df', 1)");
        await run("INSERT INTO data_models (id, table_name, is_deleted) VALUES (999, 'ods_due_out_detail_df', 0)");
        await expectRestoreError(
            restoreModelRecord({
                modelId: 156,
                operatorId: 1,
                operatorName: '测试管理员',
                dbRunAsync: run,
                dbGetAsync: get
            }),
            'MODEL_NAME_CONFLICT',
            409
        );
        const conflicted = await get('SELECT is_deleted FROM data_models WHERE id = 156');
        assert.strictEqual(conflicted.is_deleted, 1, '冲突时必须回滚，保持软删除状态');

        await expectRestoreError(
            restoreModelRecord({
                modelId: 404,
                operatorId: 1,
                operatorName: '测试管理员',
                dbRunAsync: run,
                dbGetAsync: get
            }),
            'MODEL_NOT_FOUND',
            404
        );

        console.log('[PASS] 模型恢复 API：原 ID 保留 / 审计 / 幂等 / 冲突回滚 / 不存在');
    } finally {
        await new Promise(resolve => db.close(resolve));
    }
}

main().catch(err => {
    console.error('[FAIL]', err);
    process.exit(1);
});
