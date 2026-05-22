/**
 * v1.70.2 一次性数据修复：误置 superseded 的 example_xlsx / screenshot 恢复 active
 *
 * 背景：
 *   activateNewVersion §3.6 步骤 b 原 SQL：
 *     UPDATE collab_attachments SET status='superseded'
 *       WHERE collab_request_id=? AND status='active' AND submission_version=?
 *   WHERE 没限 attachment_type → 开发首次提交时把 admin 同期上传的
 *   example_xlsx（数据模板）+ screenshot（原始单据截图）一锅端置 superseded。
 *
 *   v1.70.2 已修主代码 WHERE 加 attachment_type IN ('result_data', 'result_script')。
 *   本脚本修历史被误判的行：把 (example_xlsx / screenshot) AND status='superseded' 的行恢复 active。
 *
 * 识别规则（v1.70.2 codex 28 审 #2 收窄）：
 *   - attachment_type IN ('example_xlsx', 'screenshot')
 *   - status='superseded'
 *   - submission_version = 0  ← codex 28 审 #2 新增守卫
 *   - 上述同时满足 → 历史误判 → 恢复为 status='active' AND superseded_at=NULL
 *
 * ⚠️ 安全前提：
 *   - admin 上传的 example_xlsx / screenshot 业务上没有"新旧版本"语义，
 *     不会有合法的 superseded 状态（除非 admin 通过 PUT 显式替换，但项目当前无此 endpoint）
 *   - 已知误置的触发条件：开发首次 smoke 通过 → activateNewVersion oldVer=0 → 误超 submission_version=0 的所有 active 行
 *   - 因此加 submission_version=0 守卫，避免未来若有手工数据 / 异常路径产生的非 0 版本 superseded 行被误恢复
 *
 * 用法：
 *   DRY_RUN（默认，仅列出）：node scripts/fix-misclassified-superseded.js
 *   REAL_RUN（实际更新）：    MODE=real node scripts/fix-misclassified-superseded.js
 *
 * 部署执行：
 *   1. /deploy v1.70.2 上线
 *   2. SSH 到生产 Administrator@192.168.1.100
 *   3. cd E:/Task_Pool/wbs-server
 *   4. 跑 DRY_RUN 看影响行数
 *   5. 确认后跑 MODE=real
 *   6. 验证 OA-364265（已 DONE）详情页能看到"数据模板"+"原始单据截图"
 *
 * 幂等：跑多次安全（已恢复 active 的行不再命中 WHERE status='superseded'）
 *
 * codex 27 审 #3 同款：部分失败 → ROLLBACK + exit 2，避免半状态
 */

'use strict';

const path = require('path');
const sqlite3 = require('sqlite3');

const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const MODE = (process.env.MODE || 'dry').toLowerCase();
const IS_REAL = MODE === 'real';

console.log(`\n=== 误置 superseded 的 example_xlsx / screenshot 修复脚本 (${IS_REAL ? 'REAL_RUN' : 'DRY_RUN'}) ===`);
console.log(`DB: ${DB_PATH}\n`);

const db = new sqlite3.Database(DB_PATH, IS_REAL ? sqlite3.OPEN_READWRITE : sqlite3.OPEN_READONLY, (err) => {
    if (err) {
        console.error('打开 DB 失败:', err.message);
        process.exit(1);
    }
});

// 拉所有被误判的行（codex 28 审 #2：加 submission_version=0 守卫精确锁定误置范围）
db.all(
    `SELECT id, collab_request_id, attachment_type, file_name, original_name, status, superseded_at, submission_version, uploaded_by, uploaded_by_name
       FROM collab_attachments
      WHERE attachment_type IN ('example_xlsx', 'screenshot')
        AND status = 'superseded'
        AND submission_version = 0
      ORDER BY collab_request_id, id`,
    (err, rows) => {
        if (err) {
            console.error('查询失败:', err.message);
            db.close();
            process.exit(1);
        }

        console.log(`待修复行数: ${rows.length}\n`);

        if (rows.length === 0) {
            console.log('✅ 无需修复，所有 example_xlsx / screenshot 已是 active 状态');
            db.close();
            return;
        }

        // 按 collab_request_id 分组统计
        const byReqId = new Map();
        for (const r of rows) {
            if (!byReqId.has(r.collab_request_id)) byReqId.set(r.collab_request_id, []);
            byReqId.get(r.collab_request_id).push(r);
        }
        console.log(`涉及协作单数: ${byReqId.size}\n`);

        console.log('待修复行预览（前 20 条）:');
        console.log('attId | rid | attachment_type | uploaded_by_name | original_name | superseded_at');
        console.log('-'.repeat(110));
        for (const r of rows.slice(0, 20)) {
            const name = (r.original_name || r.file_name || '').slice(0, 30);
            const uploader = (r.uploaded_by_name || `user#${r.uploaded_by}`).slice(0, 12);
            console.log(`${r.id} | ${r.collab_request_id} | ${r.attachment_type} | ${uploader} | ${name} | ${r.superseded_at || '-'}`);
        }
        if (rows.length > 20) {
            console.log(`... (省略 ${rows.length - 20} 行)`);
        }

        if (!IS_REAL) {
            console.log(`\n⚠️ DRY_RUN 模式，未实际更新。`);
            console.log(`如确认无误，跑：MODE=real node scripts/fix-misclassified-superseded.js`);
            db.close();
            return;
        }

        // REAL_RUN: 事务批量更新（codex 28 审 #1：BEGIN 改回调式 + 失败立即退出不进入更新循环）
        console.log(`\n开始 REAL_RUN 更新 ${rows.length} 行...`);
        db.run('BEGIN IMMEDIATE TRANSACTION', (beginErr) => {
            if (beginErr) {
                console.error(`BEGIN IMMEDIATE TRANSACTION 失败: ${beginErr.message}`);
                console.error('未进入更新循环，无需 ROLLBACK；请排查锁/IO 问题后重跑');
                db.close();
                process.exit(1);
                return;
            }
            // BEGIN 成功后才 prepare + 执行 UPDATE 循环
            let okCount = 0;
            let failCount = 0;
            // UPDATE WHERE 守卫与 SELECT WHERE 完全对齐（含 submission_version=0），防止 SELECT/UPDATE 之间状态变化误改
            const stmt = db.prepare(`
                UPDATE collab_attachments
                   SET status='active', superseded_at=NULL
                 WHERE id = ?
                   AND attachment_type IN ('example_xlsx', 'screenshot')
                   AND status='superseded'
                   AND submission_version=0
            `);
            for (const r of rows) {
                stmt.run([r.id], function (e) {
                    if (e) {
                        console.error(`  ❌ attId=${r.id} (rid=${r.collab_request_id}) UPDATE 失败: ${e.message}`);
                        failCount++;
                    } else if (this.changes === 0) {
                        console.error(`  ⚠️ attId=${r.id} (rid=${r.collab_request_id}) 0 行影响 — 可能已被其他流程修改`);
                        failCount++;
                    } else {
                        okCount++;
                    }
                });
            }
            stmt.finalize((e) => {
                if (e) {
                    console.error('finalize 失败:', e.message);
                    db.run('ROLLBACK', () => { db.close(); process.exit(1); });
                    return;
                }
                // codex 27 审 #3 同款：部分失败 ROLLBACK + exit 2
                if (failCount > 0) {
                    console.error(`\n❌ REAL_RUN 部分失败: 成功 ${okCount} / 失败 ${failCount} / 总计 ${rows.length}`);
                    console.error('为防生产数据混合修复半状态，整体 ROLLBACK；请排查失败原因后重跑');
                    db.run('ROLLBACK', (rb) => {
                        if (rb) console.error('ROLLBACK 失败:', rb.message);
                        db.close();
                        process.exit(2);
                    });
                    return;
                }
                db.run('COMMIT', (e2) => {
                    if (e2) {
                        console.error('COMMIT 失败:', e2.message);
                        db.run('ROLLBACK', () => { db.close(); process.exit(1); });
                        return;
                    }
                    console.log(`\n✅ REAL_RUN 完成: 成功 ${okCount} / 失败 ${failCount} / 总计 ${rows.length}`);
                    console.log(`涉及协作单 ${byReqId.size} 个；DONE 状态详情页"数据模板"/"原始单据截图"应恢复显示`);
                    db.close();
                });
            });
        });
    }
);
