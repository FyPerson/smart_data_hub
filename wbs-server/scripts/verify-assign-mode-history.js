/**
 * v1.72.3 admin 直派模式 — 历史数据兼容性 verify 脚本
 *
 * 用途：部署后 scp 到生产 → 跑探查 → 即用即删（F1 探针模式）
 *
 * 检查项：
 *   1. 所有 collab_requests 行 assign_mode 应为 'normal' 或 'admin_direct'，不存在 NULL
 *   2. v1.72.2 前（2026-05-28 前）的历史行 assign_mode 应全部为 'normal'
 *   3. idx_collab_assign_mode 索引存在
 */

'use strict';

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '..', 'task_pool.db');
const db = new sqlite3.Database(dbPath);

let exitCode = 0;

function checkAssignModeLegal() {
    return new Promise((resolve) => {
        db.all(
            `SELECT id, oa_request_no, assign_mode
               FROM collab_requests
              WHERE assign_mode NOT IN ('normal', 'admin_direct')
                 OR assign_mode IS NULL`,
            (err, rows) => {
                if (err) {
                    console.error('❌ 检查 1 查询失败:', err.message);
                    exitCode = 1;
                    return resolve();
                }
                if (rows.length > 0) {
                    console.error(`❌ 检查 1 失败：发现 ${rows.length} 行 assign_mode 非法:`);
                    rows.forEach(r => console.error(`  #${r.id} OA-${r.oa_request_no} assign_mode=${r.assign_mode}`));
                    exitCode = 1;
                } else {
                    console.log('✅ 检查 1 PASS：所有 collab_requests 行 assign_mode 合法（normal / admin_direct）');
                }
                resolve();
            }
        );
    });
}

function checkHistoryRowsNormal() {
    return new Promise((resolve) => {
        db.all(
            `SELECT COUNT(*) AS cnt
               FROM collab_requests
              WHERE assign_mode = 'admin_direct'
                AND created_at < '2026-05-28'`,
            (err, rows) => {
                if (err) {
                    console.error('❌ 检查 2 查询失败:', err.message);
                    exitCode = 1;
                    return resolve();
                }
                if (rows[0].cnt > 0) {
                    console.warn(`⚠️  检查 2 警告：发现 ${rows[0].cnt} 行 admin_direct 创建于 2026-05-28 前（部署前异常）`);
                } else {
                    console.log('✅ 检查 2 PASS：v1.72.2 前历史行 assign_mode 全为 normal');
                }
                resolve();
            }
        );
    });
}

function checkIndexExists() {
    return new Promise((resolve) => {
        db.all(
            `SELECT name FROM sqlite_master
              WHERE type='index' AND name='idx_collab_assign_mode'`,
            (err, rows) => {
                if (err) {
                    console.error('❌ 检查 3 查询失败:', err.message);
                    exitCode = 1;
                    return resolve();
                }
                if (rows.length === 0) {
                    console.error('❌ 检查 3 失败：idx_collab_assign_mode 索引缺失');
                    exitCode = 1;
                } else {
                    console.log('✅ 检查 3 PASS：idx_collab_assign_mode 索引存在');
                }
                resolve();
            }
        );
    });
}

function printDistribution() {
    return new Promise((resolve) => {
        db.all(
            `SELECT assign_mode, COUNT(*) AS cnt
               FROM collab_requests
              GROUP BY assign_mode
              ORDER BY assign_mode`,
            (err, rows) => {
                if (err) {
                    console.error('查询 assign_mode 分布失败:', err.message);
                    return resolve();
                }
                console.log('\n📊 assign_mode 分布：');
                rows.forEach(r => console.log(`  ${r.assign_mode}: ${r.cnt} 行`));
                resolve();
            }
        );
    });
}

(async () => {
    console.log('=== v1.72.3 admin 直派模式 — 历史数据 verify ===\n');
    await checkAssignModeLegal();
    await checkHistoryRowsNormal();
    await checkIndexExists();
    await printDistribution();
    db.close();
    console.log(`\n=== 检查完成，退出码 ${exitCode} ===`);
    process.exit(exitCode);
})();
