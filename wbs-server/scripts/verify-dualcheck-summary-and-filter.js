// 验证脚本：取数质量双校验增强 Commit D — buildQualitySummary 双侧字段 + 读路径过滤 record_kind='passed'
// 方案：docs/local/数据协作模块_v3.0/取数质量双校验增强_方案_20260611_v1.2.md §6.3 / §8b.1
// 用法：node scripts/verify-dualcheck-summary-and-filter.js
//
// 模式：临时内存 sqlite（Commit A 同步 schema）+ 真实 collab_quality_record 数据 + 真实 buildQualitySummary
//   覆盖 11 项关键场景：
//   - buildQualitySummary 双校验字段（excel 侧/SQL 侧 reason）
//   - v3.0 老单兼容（excel 字段 null）
//   - 读路径过滤 record_kind='passed'（同 seq 有 1 passed + N failed 时只展示 passed）
//   - SMOKE_FAILED 透传供前端展示 SQL failed 文案
'use strict';
const assert = require('assert');
const sqlite3 = require('sqlite3');
const { buildQualitySummary } = require('../utils/collab-submit-helpers');

const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) =>
    db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) =>
    db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));

// Commit A 同步 schema（含 7 列 + 收窄索引）
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
    excel_actual_columns_snapshot TEXT,
    excel_missing_columns TEXT,
    excel_is_columns_complete INTEGER DEFAULT NULL CHECK (excel_is_columns_complete IS NULL OR excel_is_columns_complete IN (0, 1)),
    excel_unchecked_reason TEXT,
    sql_unchecked_reason TEXT,
    result_attachment_id INTEGER,
    record_kind TEXT NOT NULL DEFAULT 'passed' CHECK (record_kind IN ('passed', 'failed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
)`;

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ✓ ${msg}`); };

// 模拟 request 行（带 contact_read_at + done_at 算交付时长）
const REQ_BASE = {
    contact_read_at: '2026-06-12 10:00:00',
    done_at: '2026-06-12 11:30:00',  // 90 分钟
};

async function main() {
    await run(DDL_QUALITY);
    ok('Commit A 同步 schema 建表');

    // === [1] 双校验新单 passed + SQL齐全 + excel齐全 → summary 含两侧字段 ===
    {
        await run(`INSERT INTO collab_quality_record
            (collab_request_id, submitter_id, submitter_name, submission_seq, submitted_at,
             is_columns_complete, missing_columns,
             excel_is_columns_complete, excel_missing_columns,
             record_kind)
            VALUES (1, 5, '开发', 1, '2026-06-12 10:30',
                    1, '[]', 1, '[]', 'passed')`);
        const qrs = await all(`SELECT * FROM collab_quality_record WHERE collab_request_id=1 AND record_kind='passed'`);
        const summary = buildQualitySummary(REQ_BASE, qrs, []);
        assert.strictEqual(summary.latest_is_columns_complete, 1, '[1] SQL 侧齐全');
        assert.strictEqual(summary.latest_excel_is_columns_complete, 1, '[1] excel 侧齐全');
        assert.strictEqual(summary.latest_record_kind, 'passed', '[1] record_kind 透传');
        assert.strictEqual(summary.latest_sql_unchecked_reason, null, '[1] SQL reason null（已比对）');
        assert.strictEqual(summary.latest_excel_unchecked_reason, null, '[1] excel reason null（已比对）');
        ok('[1] 新单 passed + 双侧齐全 → summary 含两侧字段 + reason 为 null');
    }

    // === [2] passed + SQL齐全 + excel缺列 → summary 体现独立 ===
    {
        await run(`INSERT INTO collab_quality_record
            (collab_request_id, submitter_id, submitter_name, submission_seq, submitted_at,
             is_columns_complete, missing_columns,
             excel_is_columns_complete, excel_missing_columns,
             record_kind)
            VALUES (2, 5, '开发', 1, '2026-06-12 10:30',
                    1, '[]', 0, '["列C"]', 'passed')`);
        const qrs = await all(`SELECT * FROM collab_quality_record WHERE collab_request_id=2 AND record_kind='passed'`);
        const summary = buildQualitySummary(REQ_BASE, qrs, []);
        assert.strictEqual(summary.latest_is_columns_complete, 1, '[2] SQL 齐全');
        assert.strictEqual(summary.latest_excel_is_columns_complete, 0, '[2] excel 缺列');
        assert.strictEqual(summary.latest_excel_missing_columns, '["列C"]', '[2] excel 缺列 JSON');
        ok('[2] passed + SQL齐 + excel缺列 → 两侧独立判定');
    }

    // === [3] passed 模板缺 → 两侧 reason='NO_TEMPLATE' 同值（§3.2 不变量）===
    {
        await run(`INSERT INTO collab_quality_record
            (collab_request_id, submitter_id, submitter_name, submission_seq, submitted_at,
             is_columns_complete, sql_unchecked_reason,
             excel_is_columns_complete, excel_unchecked_reason,
             record_kind)
            VALUES (3, 5, '开发', 1, '2026-06-12 10:30',
                    NULL, 'NO_TEMPLATE', NULL, 'NO_TEMPLATE', 'passed')`);
        const qrs = await all(`SELECT * FROM collab_quality_record WHERE collab_request_id=3 AND record_kind='passed'`);
        const summary = buildQualitySummary(REQ_BASE, qrs, []);
        assert.strictEqual(summary.latest_is_columns_complete, null);
        assert.strictEqual(summary.latest_excel_is_columns_complete, null);
        assert.strictEqual(summary.latest_sql_unchecked_reason, 'NO_TEMPLATE');
        assert.strictEqual(summary.latest_excel_unchecked_reason, 'NO_TEMPLATE');
        ok('[3] 模板缺 → 两侧 reason=NO_TEMPLATE 同值（§3.2 不变量传到前端展示层）');
    }

    // === [4] v3.0 老单兼容：只有 SQL 侧字段（excel 字段 NULL）→ summary excel 字段 null ===
    {
        await run(`INSERT INTO collab_quality_record
            (collab_request_id, submitter_id, submitter_name, submission_seq, submitted_at,
             is_columns_complete, missing_columns)
            VALUES (4, 5, '老开发', 1, '2026-06-05 10:30',
                    1, '[]')`);
        const qrs = await all(`SELECT * FROM collab_quality_record WHERE collab_request_id=4 AND record_kind='passed'`);
        const summary = buildQualitySummary(REQ_BASE, qrs, []);
        assert.strictEqual(summary.latest_is_columns_complete, 1, '[4] v3.0 老单 SQL 齐全');
        assert.strictEqual(summary.latest_excel_is_columns_complete, null, '[4] v3.0 老单 excel 字段 null');
        assert.strictEqual(summary.latest_excel_unchecked_reason, null);
        assert.strictEqual(summary.latest_record_kind, 'passed', '[4] DEFAULT 自动落 passed');
        ok('[4] v3.0 老单兼容（excel 字段 NULL）→ 前端 hasExcelData=false 不展示 excel 行');
    }

    // === [5] 读路径过滤 record_kind='passed'：同 seq 有 1 passed + 3 failed 时只展示 passed ===
    {
        // 1 passed
        await run(`INSERT INTO collab_quality_record
            (collab_request_id, submitter_id, submitter_name, submission_seq, submitted_at,
             is_columns_complete, missing_columns, record_kind)
            VALUES (5, 5, '开发', 2, '2026-06-12 11:00', 1, '[]', 'passed')`);
        // 3 failed（同 seq）
        for (let i = 0; i < 3; i++) {
            await run(`INSERT INTO collab_quality_record
                (collab_request_id, submitter_id, submitter_name, submission_seq, submitted_at,
                 sql_unchecked_reason, record_kind)
                VALUES (5, 5, '开发', 2, '2026-06-12 10:${30 + i}',
                        'SMOKE_FAILED', 'failed')`);
        }
        // 模拟详情 GET 12481 实际 SELECT（已加 record_kind='passed' 过滤）
        const qrsPassed = await all(
            "SELECT * FROM collab_quality_record WHERE collab_request_id = ? AND record_kind = 'passed' ORDER BY submission_seq ASC, id ASC",
            [5]
        );
        // 对比：不加过滤的全量查询
        const qrsAll = await all(
            'SELECT * FROM collab_quality_record WHERE collab_request_id = ? ORDER BY submission_seq ASC, id ASC',
            [5]
        );
        assert.strictEqual(qrsPassed.length, 1, '[5] 过滤后只 1 条 passed');
        assert.strictEqual(qrsAll.length, 4, '[5] 不过滤时 4 条（1 passed + 3 failed）');
        assert.strictEqual(qrsPassed[0].record_kind, 'passed');
        const summary = buildQualitySummary(REQ_BASE, qrsPassed, []);
        assert.strictEqual(summary.submit_count, 1, '[5] submit_count 只数 passed');
        assert.strictEqual(summary.latest_is_columns_complete, 1, '[5] latest 是 passed 行');
        ok('[5] ⭐ 读路径过滤 record_kind=passed（§8b.1 最易漏）→ 同 seq 1passed+3failed 只展示 passed');
    }

    // === [6] failed 路径单独查询：record_kind='failed' 能拿到所有 failed 留痕 ===
    {
        const failed = await all(
            "SELECT * FROM collab_quality_record WHERE collab_request_id = ? AND record_kind = 'failed' ORDER BY id ASC",
            [5]
        );
        assert.strictEqual(failed.length, 3, '[6] failed 留痕应可单独查到 3 条');
        assert.ok(failed.every(r => r.sql_unchecked_reason === 'SMOKE_FAILED'));
        ok('[6] failed 留痕单独查询可用（未来 debug endpoint，本期不暴露）');
    }

    // === [7] 防御历史脏数据/异常汇总输入：record_kind='passed' + SMOKE_FAILED 异常组合
    //     codex Commit D 审 low-7：注释从"理论不存在"改为"防御性测试"——
    //     确保前端文案稳定（SMOKE_FAILED + Excel 可见 → 引导文案；不可见 → 降级文案）===
    {
        await run(`INSERT INTO collab_quality_record
            (collab_request_id, submitter_id, submitter_name, submission_seq, submitted_at,
             is_columns_complete, sql_unchecked_reason,
             excel_is_columns_complete, excel_missing_columns,
             record_kind)
            VALUES (7, 5, '开发', 1, '2026-06-12 11:00',
                    NULL, 'SMOKE_FAILED', 1, '[]', 'passed')`);
        const qrs = await all(`SELECT * FROM collab_quality_record WHERE collab_request_id=7 AND record_kind='passed'`);
        const summary = buildQualitySummary(REQ_BASE, qrs, []);
        assert.strictEqual(summary.latest_sql_unchecked_reason, 'SMOKE_FAILED');
        assert.strictEqual(summary.latest_excel_is_columns_complete, 1);
        ok('[7] SMOKE_FAILED + Excel 可见组合：summary 字段透传供前端引导文案"请看 excel 校验结果"');
    }

    // === [7b] SMOKE_FAILED + Excel 不可见组合（v3.0 老单的极端异常脏数据）→ summary 字段仍稳定 ===
    //     codex Commit D 审 low-4 落地：验证前端 isNewDualCheck=false 时 SMOKE_FAILED 走降级文案路径
    //     buildQualitySummary 不做文案判定（前端 buildColTextDetail 用 hasExcelView 参数决定），
    //     本断言确认汇总层字段稳定不崩；具体降级文案由前端 verify 时人工或浏览器实测覆盖
    {
        await run(`INSERT INTO collab_quality_record
            (collab_request_id, submitter_id, submitter_name, submission_seq, submitted_at,
             is_columns_complete, sql_unchecked_reason)
            VALUES (8, 5, '老开发', 1, '2026-06-05 10:30',
                    NULL, 'SMOKE_FAILED')`);
        const qrs = await all(`SELECT * FROM collab_quality_record WHERE collab_request_id=8 AND record_kind='passed'`);
        const summary = buildQualitySummary(REQ_BASE, qrs, []);
        assert.strictEqual(summary.latest_sql_unchecked_reason, 'SMOKE_FAILED');
        // v3.0 老单：excel 字段全 null → 前端 isNewDualCheck=false → SMOKE_FAILED 走降级文案
        assert.strictEqual(summary.latest_excel_is_columns_complete, null);
        assert.strictEqual(summary.latest_excel_unchecked_reason, null);
        assert.strictEqual(summary.latest_excel_missing_columns, null);
        assert.strictEqual(summary.latest_record_kind, 'passed');  // DEFAULT 兜底
        ok('[7b] SMOKE_FAILED + 老单（excel 字段全 null）→ summary 稳定，前端走降级文案路径');
    }

    // === [8] 空 qualityRecords → summary 字段全 null（不崩）===
    {
        const summary = buildQualitySummary(REQ_BASE, [], []);
        assert.strictEqual(summary.submit_count, 0);
        assert.strictEqual(summary.latest_is_columns_complete, null);
        assert.strictEqual(summary.latest_excel_is_columns_complete, null);
        assert.strictEqual(summary.latest_record_kind, null);
        ok('[8] 空 qualityRecords → summary 字段全 null（不崩）');
    }

    // === [9] 多条 passed 取最新（按 submission_seq DESC, id DESC）===
    {
        await run(`INSERT INTO collab_quality_record
            (collab_request_id, submitter_id, submitter_name, submission_seq, submitted_at,
             is_columns_complete, missing_columns, record_kind)
            VALUES (9, 5, '开发', 1, '2026-06-12 10:00', 0, '["旧缺"]', 'passed')`);
        await run(`INSERT INTO collab_quality_record
            (collab_request_id, submitter_id, submitter_name, submission_seq, submitted_at,
             is_columns_complete, missing_columns, record_kind)
            VALUES (9, 5, '开发', 2, '2026-06-12 11:00', 1, '[]', 'passed')`);
        const qrs = await all(`SELECT * FROM collab_quality_record WHERE collab_request_id=9 AND record_kind='passed'`);
        const summary = buildQualitySummary(REQ_BASE, qrs, []);
        assert.strictEqual(summary.submit_count, 2);
        assert.strictEqual(summary.latest_is_columns_complete, 1, '[9] latest 取最新 seq=2');
        ok('[9] 多次 passed 提交 → summary.latest_* 取最新 seq（缺列 → 齐全的进步）');
    }

    // === [10] returnRecords reworkCount 统计（仅 DEV_QUALITY）===
    {
        const returns = [
            { reason_type: 'DEV_QUALITY' },
            { reason_type: 'REQ_CHANGE' },
            { reason_type: 'DEV_QUALITY' },
            { reason_type: 'ENV_ISSUE' },
        ];
        const summary = buildQualitySummary(REQ_BASE, [], returns);
        assert.strictEqual(summary.return_count, 4);
        assert.strictEqual(summary.rework_count, 2, '[10] 仅 DEV_QUALITY 计返工');
        ok('[10] 打回统计：return_count=4 / rework_count=2 (仅 DEV_QUALITY)');
    }

    // === [11] 交付时长（contact_read_at → done_at）90 分钟 ===
    {
        const summary = buildQualitySummary(REQ_BASE, [], []);
        assert.strictEqual(summary.delivery_duration_minutes, 90, '[11] 90 分钟');
        ok('[11] 交付时长 contact_read_at(10:00) → done_at(11:30) = 90 分钟');
    }

    console.log(`\n[全部通过] ${passed}/${passed} ✓ Commit D buildQualitySummary 双侧字段 + 读过滤 验证通过`);
    db.close();
}

main().catch(e => { console.error('\n[失败]', e.message, e.stack); db.close(); process.exit(1); });
