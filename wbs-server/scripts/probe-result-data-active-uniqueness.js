/**
 * 部署前检测脚本：result_data active 唯一性（codex 53 H-1 + codex 55 健壮性修订）
 *
 * 背景：导出通知业务方需求发文件时取"同一协作单的 active result_data"，方案假设恰好 1 个。
 *       codex 53 H-1 建议加全表 partial unique index，但本功能只读 result_data，
 *       不该为只读功能给全表加写约束（牵连 submit-export/admin-submit 所有写路径）。
 *       故改用"运行时查询防御（RESULT_DATA_AMBIGUOUS）+ 部署前检测脚本"。
 *
 * ⚠️ 边界（codex 55 M-1）：本脚本是某时间点的只读快照检查，只能发现"存量脏数据"，
 *    **不能阻止上线后 submit-export/admin-submit 再次写出多个 active**。增量唯一性
 *    仍依赖 Commit A/C 的运行时查询防御（RESULT_DATA_AMBIGUOUS）。不要把本探针当持久约束。
 *
 * 用途：上线前在生产跑一次，确认当前无"同一协作单多个 active result_data"存量脏数据。
 *   - 0 行 → 当前未发现存量脏数据（增量仍靠运行时防御）
 *   - > 0 行 → 先人工核对明细修复（supersede 多余的，保留最新），再上线
 *
 * 运行：node scripts/probe-result-data-active-uniqueness.js
 * 只读，不改任何数据。跑完即删（F1 探针即用即删模式）。
 */

'use strict';

const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB_FILE = path.join(__dirname, '..', 'task_pool.db');
const db = new sqlite3.Database(DB_FILE);

console.log('=== result_data active 唯一性检测 ===');
console.log(`DB_FILE: ${DB_FILE}\n`);   // codex 55 L-3：打印实际库路径，防误查

// codex 55 L-2：加 collab_request_id IS NOT NULL，防孤儿附件聚成 "#null" 组误报
db.all(
    `SELECT collab_request_id, COUNT(*) AS cnt
       FROM collab_attachments
      WHERE attachment_type = 'result_data' AND status = 'active'
        AND collab_request_id IS NOT NULL
      GROUP BY collab_request_id
     HAVING cnt > 1
      ORDER BY cnt DESC`,
    [],
    (err, rows) => {
        if (err) {
            console.error('查询失败:', err.message);
            db.close();
            process.exit(1);
        }
        if (rows.length === 0) {
            console.log('✅ 当前未发现存量脏数据（无"同一协作单多个 active result_data"）');
            console.log('   → 注意：增量唯一性仍依赖运行时防御（RESULT_DATA_AMBIGUOUS），本检测不是持久约束');
            db.close();
            return;
        }
        // codex 55 L-1：发现重复时输出明细（id/created_at/original_name），便于人工判断保留哪条
        console.log(`⚠️ 发现 ${rows.length} 个协作单存在多个 active result_data（需修复后再上线）：\n`);
        let pending = rows.length;
        rows.forEach(r => {
            db.all(
                `SELECT id, original_name, created_at, status
                   FROM collab_attachments
                  WHERE collab_request_id = ? AND attachment_type = 'result_data' AND status = 'active'
                  ORDER BY created_at DESC`,
                [r.collab_request_id],
                (e2, detail) => {
                    console.log(`协作单 #${r.collab_request_id}（${r.cnt} 个 active）：`);
                    if (e2) {
                        console.log(`   明细查询失败: ${e2.message}`);
                    } else {
                        detail.forEach((d, i) => {
                            const tag = i === 0 ? '（最新，建议保留）' : '（建议 supersede）';
                            console.log(`   - id=${d.id} | ${d.created_at} | ${d.original_name || '(无名)'} ${tag}`);
                        });
                    }
                    if (--pending === 0) {
                        console.log('\n   修复建议：人工核对后把多余的 supersede（保留最新一次提交的 active）');
                        db.close();
                    }
                }
            );
        });
    }
);
