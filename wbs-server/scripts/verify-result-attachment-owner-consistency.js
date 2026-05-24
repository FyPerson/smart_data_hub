// v1.71.0 Commit B 长期监控（codex 35 审 rec 2 + M-1 部分采纳产物）
//
// 目的：检测"result_data / result_script 附件的 uploaded_by 与协作单 developer_id 不一致"的情况。
//
// 业务背景：v1.71.0 引入"附件按人锁"前置闸门后，非 admin 用户只能删/重传自己上传的附件。
// 如果历史 result_* 由 admin 代传（如 v1.70.5 行政闭环 ADMIN_SUBMIT_ON_BEHALF），
// developer 想回头修正交付物时会被 ATTACHMENT_OWNER_LOCKED 拦截，只能找 admin。
//
// 已知合理 mismatch 场景（不算 bug）：
//   - ADMIN_SUBMIT_ON_BEHALF（v1.70.5 行政闭环兜底）：admin 代传 result_data
//   - 旧版迁移数据：history 数据可能 uploaded_by=admin 但 developer_id 是真实开发
//
// 运行节奏：建议每月初跑一次，记录 mismatch 数量趋势；如发现新增 mismatch 不属于 ADMIN_SUBMIT_ON_BEHALF
// 场景（即 dev 自己 SUBMIT 却被记为 admin 上传），是产品逻辑 bug 需要排查。
//
// 跑法：
//   本地：cd wbs-server && node scripts/verify-result-attachment-owner-consistency.js
//   生产：scp 到 E:/Task_Pool/wbs-server/ 后 ssh 跑（参考 docs/CLAUDE.md SSH 配置）

'use strict';

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(process.cwd(), 'task_pool.db');
if (!fs.existsSync(DB_PATH)) {
    console.error(`task_pool.db 不存在：${DB_PATH}`);
    console.error('请在 wbs-server 目录下运行，或 cd 到生产 E:/Task_Pool/wbs-server/');
    process.exit(2);
}

const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY);

function q(sql, mode = 'all') {
    return new Promise((res, rej) => {
        db[mode](sql, [], (e, r) => e ? rej(e) : res(r));
    });
}

(async () => {
    try {
        console.log('\n=== v1.71.0 Commit B: result_* 附件 owner 一致性核查 ===');
        console.log('数据库：', DB_PATH);
        console.log('运行时间：', new Date().toISOString());

        // 1. 总数概览
        const total = await q(
            "SELECT COUNT(*) AS total, SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active FROM collab_attachments",
            'get');
        console.log('\n[1] collab_attachments 总数：', JSON.stringify(total));

        // 2. result_* mismatch 统计（排除 developer_id=0 占位 / NULL）
        const mismatchCount = await q(
            `SELECT COUNT(*) AS cnt FROM collab_attachments a
             JOIN collab_requests c ON a.collab_request_id = c.id
             WHERE a.attachment_type IN ('result_data','result_script')
               AND a.status = 'active'
               AND c.developer_id IS NOT NULL AND c.developer_id != 0
               AND a.uploaded_by != c.developer_id`,
            'get');
        console.log('\n[2] result_* uploaded_by != developer_id 总数（active，排除占位）：', JSON.stringify(mismatchCount));

        if (mismatchCount.cnt === 0) {
            console.log('    ✅ 无 mismatch，按人锁闸门对所有现有 developer 都通畅');
            return;
        }

        // 3. mismatch 明细
        const detail = await q(
            `SELECT a.id AS att_id, a.attachment_type, a.uploaded_by, a.uploaded_by_name,
                    c.id AS collab_id, c.developer_id, c.developer_name, c.oa_request_no,
                    c.status, c.archived_at
             FROM collab_attachments a
             JOIN collab_requests c ON a.collab_request_id = c.id
             WHERE a.attachment_type IN ('result_data','result_script')
               AND a.status = 'active'
               AND c.developer_id IS NOT NULL AND c.developer_id != 0
               AND a.uploaded_by != c.developer_id
             ORDER BY a.id`);
        console.log('\n[3] mismatch 明细：');
        detail.forEach(x => console.log('   ', JSON.stringify(x)));

        // 4. 关联 ADMIN_SUBMIT_ON_BEHALF 操作日志（判断是否属合理 mismatch）
        const adminBehalf = await q(
            `SELECT DISTINCT l.collab_request_id, l.operator_id, l.created_at
             FROM collab_operation_logs l
             WHERE l.operation_type = 'ADMIN_SUBMIT_ON_BEHALF'
               AND l.collab_request_id IN (${detail.map(x => x.collab_id).join(',')})
             ORDER BY l.collab_request_id`);
        console.log('\n[4] 上述 mismatch 协作单中有 ADMIN_SUBMIT_ON_BEHALF 记录的（属合理 mismatch）：');
        if (adminBehalf.length === 0) {
            console.log('    (无 — ⚠️ mismatch 不属 v1.70.5 行政闭环兜底场景，需排查产品逻辑)');
        } else {
            adminBehalf.forEach(x => console.log('   ', JSON.stringify(x)));
        }

        // 5. 给出建议
        console.log('\n[5] 排障建议：');
        const adminBehalfIds = new Set(adminBehalf.map(x => x.collab_request_id));
        const explained = detail.filter(x => adminBehalfIds.has(x.collab_id));
        const unexplained = detail.filter(x => !adminBehalfIds.has(x.collab_id));
        console.log(`    已解释（ADMIN_SUBMIT_ON_BEHALF 兜底）：${explained.length} 条`);
        console.log(`    未解释（需排查产品逻辑或历史数据）：${unexplained.length} 条`);

        if (unexplained.length > 0) {
            console.log('\n    ⚠️ 未解释 mismatch 协作单列表：');
            unexplained.forEach(x => {
                console.log(`        OA=${x.oa_request_no} att_id=${x.att_id} dev=${x.developer_name}(id=${x.developer_id}) uploaded_by=${x.uploaded_by_name}(id=${x.uploaded_by})`);
            });
            console.log('\n    动作：通知示例用户A + admin 排查这些单是否需要数据修正');
            process.exitCode = 1;
        } else {
            console.log('    ✅ 所有 mismatch 均由 ADMIN_SUBMIT_ON_BEHALF 兜底引入，是产品设计的合理结果');
            console.log('    动作：无需修数据；如对应 developer 想改 result_*，请告知"由 admin 重传"');
        }
    } catch (e) {
        console.error('核查异常：', e.message, e.stack);
        process.exitCode = 2;
    } finally {
        db.close();
        console.log('\n=== 核查完成 ===');
    }
})();
