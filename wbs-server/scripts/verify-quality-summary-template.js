// 验证脚本：取数交付质量记录 v3.0 Commit E — 后端两纯逻辑
//   ① buildQualitySummary（交付时长 M-7 + 提交/打回/返工计数 + 最新列对齐）
//   ② checkTemplateReadable（模板上传列对齐可读性预检，源头防线）
// 用法：node scripts/verify-quality-summary-template.js
// 模式：纯函数 + assert + 真实临时 xlsx fixture（checkTemplateReadable 读文件）。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { buildQualitySummary, checkTemplateReadable } = require('../utils/collab-submit-helpers');

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ✓ ${msg}`); };

// fixture 写到 uploads 根下（checkTemplateReadable → resolveAttachmentPath 拼 uploads + 越界校验）
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const FIX_REL = 'collab/_e_verify_tmp';
const FIX_ABS = path.join(UPLOAD_DIR, 'collab', '_e_verify_tmp');
function ensureDir() { fs.mkdirSync(FIX_ABS, { recursive: true }); }
function writeXlsx(name, headerRow) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headerRow]), 'S1');
    XLSX.writeFile(wb, path.join(FIX_ABS, name));
    return `${FIX_REL}/${name}`;
}
function writeRaw(name, buf) {
    fs.writeFileSync(path.join(FIX_ABS, name), buf);
    return `${FIX_REL}/${name}`;
}
function cleanup() { try { fs.rmSync(FIX_ABS, { recursive: true, force: true }); } catch (e) {} }

function main() {
    ensureDir();

    // ============ buildQualitySummary ============
    console.log('[buildQualitySummary：交付时长 M-7 + 计数]');

    // [1] 完整：contact_read_at → submitted_at（无归档）
    {
        const req = { contact_read_at: '2026-06-08 10:00:00', submitted_at: '2026-06-08 12:30:00', archived_at: null };
        const qrs = [{ submission_seq: 1, is_columns_complete: 1, missing_columns: '[]' }];
        const s = buildQualitySummary(req, qrs, []);
        assert.strictEqual(s.delivery_duration_minutes, 150, '10:00→12:30 应 150 分钟');
        assert.strictEqual(s.submit_count, 1);
        assert.strictEqual(s.latest_is_columns_complete, 1);
        ok('交付时长 contact_read_at→submitted_at（150分）+ 提交次数 + 列对齐齐全');
    }

    // [2] 完成归档优先：有 archived_final_at 用它作终点（codex 76 M-1：非 archived_at）
    {
        const req = { contact_read_at: '2026-06-08 09:00:00', submitted_at: '2026-06-08 10:00:00', archived_final_at: '2026-06-08 11:00:00' };
        const s = buildQualitySummary(req, [], []);
        assert.strictEqual(s.delivery_duration_minutes, 120, 'archived_final_at 优先 → 09:00→11:00 = 120 分钟');
        ok('终点 archived_final_at（完成归档）优先于 submitted_at（M-7 口径，codex 76 M-1）');
    }

    // [2b] archived_at（软删除/作废）不作终点——作废≠完成（codex 76 M-1）。无 done_at/archived_final_at → 落 submitted_at
    {
        const req = { contact_read_at: '2026-06-08 09:00:00', submitted_at: '2026-06-08 10:00:00',
                      archived_at: '2026-06-08 15:00:00', archived_final_at: null, done_at: null };
        const s = buildQualitySummary(req, [], []);
        assert.strictEqual(s.delivery_duration_minutes, 60, 'archived_at 作废不算终点 + 无 done_at → 落 submitted_at 09:00→10:00=60 分');
        ok('archived_at（作废）不作交付时长终点，无 done_at 时落 submitted_at（codex 76 M-1）');
    }

    // [2c] done_at（验收完成）优先 submitted_at（codex 77 复审 M-1：交付完成耗时算到验收完成）
    {
        const req = { contact_read_at: '2026-06-08 09:00:00', submitted_at: '2026-06-08 10:00:00',
                      done_at: '2026-06-08 10:30:00', archived_final_at: null };
        const s = buildQualitySummary(req, [], []);
        assert.strictEqual(s.delivery_duration_minutes, 90, 'done_at 优先 → 09:00→10:30 = 90 分钟（非 submitted_at 的 60）');
        ok('终点 done_at（验收完成）优先于 submitted_at（codex 77 复审 M-1）');
    }

    // [2d] 三级 fallback：archived_final_at > done_at > submitted_at
    {
        const req = { contact_read_at: '2026-06-08 09:00:00', submitted_at: '2026-06-08 10:00:00',
                      done_at: '2026-06-08 10:30:00', archived_final_at: '2026-06-08 11:00:00' };
        const s = buildQualitySummary(req, [], []);
        assert.strictEqual(s.delivery_duration_minutes, 120, 'archived_final_at 最优先 → 09:00→11:00 = 120 分钟');
        ok('三级 fallback 终点：archived_final_at > done_at > submitted_at');
    }

    // [3] contact_read_at 空 → null（不计算）
    {
        const s = buildQualitySummary({ contact_read_at: null, submitted_at: '2026-06-08 10:00:00' }, [], []);
        assert.strictEqual(s.delivery_duration_minutes, null, 'contact_read_at 空 → null');
        ok('contact_read_at 空 → delivery_duration_minutes=null（前端展示"—"）');
    }

    // [4] 异常时序（终点早于起点）→ null（不展示负数）
    {
        const s = buildQualitySummary({ contact_read_at: '2026-06-08 12:00:00', submitted_at: '2026-06-08 10:00:00' }, [], []);
        assert.strictEqual(s.delivery_duration_minutes, null, '终点早于起点 → null');
        ok('异常时序（终点<起点）→ null（不展示负数/NaN）');
    }

    // [5] 打回 + 返工计数：4 reason_type 仅 DEV_QUALITY 算返工
    {
        const rrs = [
            { reason_type: 'DEV_QUALITY' }, { reason_type: 'DEV_QUALITY' },
            { reason_type: 'REQ_CHANGE' }, { reason_type: 'ENV_ISSUE' }, { reason_type: 'BIZ_ADJUST' },
        ];
        const s = buildQualitySummary({ contact_read_at: null }, [], rrs);
        assert.strictEqual(s.return_count, 5, '打回总数 5');
        assert.strictEqual(s.rework_count, 2, '返工仅 2 个 DEV_QUALITY（M-5）');
        ok('打回 5 次 / 返工仅 2 次 DEV_QUALITY（M-5 口径）');
    }

    // [6] 最新列对齐取 submission_seq 末尾（升序）+ 缺列
    {
        const qrs = [
            { submission_seq: 1, is_columns_complete: 0, missing_columns: '["税额"]' },
            { submission_seq: 2, is_columns_complete: 1, missing_columns: '[]' },
        ];
        const s = buildQualitySummary({ contact_read_at: null }, qrs, []);
        assert.strictEqual(s.submit_count, 2);
        assert.strictEqual(s.latest_is_columns_complete, 1, '取最新（seq=2）齐全');
        ok('最新列对齐取 submission_seq 末尾（多次提交取末次）');
    }

    // [7] 无任何记录 → 全 0/null 不崩
    {
        const s = buildQualitySummary({}, null, undefined);
        assert.strictEqual(s.submit_count, 0);
        assert.strictEqual(s.return_count, 0);
        assert.strictEqual(s.rework_count, 0);
        assert.strictEqual(s.latest_is_columns_complete, null);
        assert.strictEqual(s.delivery_duration_minutes, null);
        ok('无记录 + null/undefined 入参 → 全 0/null 不崩');
    }

    // [8] 未比对态（is_columns_complete=null）正确透传
    {
        const qrs = [{ submission_seq: 1, is_columns_complete: null, missing_columns: null }];
        const s = buildQualitySummary({ contact_read_at: null }, qrs, []);
        assert.strictEqual(s.latest_is_columns_complete, null, '未比对透传 null');
        assert.strictEqual(s.latest_missing_columns, null);
        ok('未比对态 is_columns_complete=null 正确透传（不误判齐全/缺列）');
    }

    // ============ checkTemplateReadable ============
    console.log('\n[checkTemplateReadable：模板上传可读性预检]');

    // [9] 正常 xlsx → ok + header_preview
    {
        const fn = writeXlsx('e_ok.xlsx', ['订单号', '金额', '部门']);
        const r = checkTemplateReadable(fn, 'e_ok.xlsx');
        assert.strictEqual(r.ok, true, '正常 xlsx 应 ok');
        assert.strictEqual(r.reason, 'OK');
        assert.deepStrictEqual(r.header_preview, ['订单号', '金额', '部门'], 'header_preview 给表头');
        ok('正常 xlsx → ok=true / reason=OK / header_preview 表头预览');
    }

    // [10] 非 xlsx（.pdf）→ NON_XLSX（admin 有意传，前端不打扰）
    {
        const fn = writeRaw('e_doc.pdf', Buffer.from('%PDF-1.4', 'utf8'));
        const r = checkTemplateReadable(fn, 'e_doc.pdf');
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.reason, 'NON_XLSX', '非 xlsx → NON_XLSX');
        ok('非 xlsx 模板（.pdf）→ ok=false / reason=NON_XLSX（不试读）');
    }

    // [11] 空表头 xlsx → EMPTY_HEADER
    {
        const fn = writeXlsx('e_empty.xlsx', [null, null, '']);
        const r = checkTemplateReadable(fn, 'e_empty.xlsx');
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.reason, 'EMPTY_HEADER', '空表头 → EMPTY_HEADER');
        ok('空表头 xlsx → ok=false / reason=EMPTY_HEADER');
    }

    // [12] 损坏 xlsx（截断 zip）→ READ_FAILED
    {
        const fn = writeRaw('e_broken.xlsx', Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]));
        const r = checkTemplateReadable(fn, 'e_broken.xlsx');
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.reason, 'READ_FAILED', '损坏 → READ_FAILED');
        ok('损坏 xlsx（截断 zip）→ ok=false / reason=READ_FAILED');
    }

    // [13] 文件不存在 → READ_FAILED（resolveAttachmentPath 通过但 readXlsxHeader 抛）
    {
        const r = checkTemplateReadable(`${FIX_REL}/not_exist.xlsx`, 'not_exist.xlsx');
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.reason, 'READ_FAILED', '文件不存在 → READ_FAILED');
        ok('文件不存在 → ok=false / reason=READ_FAILED（永不抛）');
    }

    console.log(`\n✅ 全部通过：${passed} 项`);
}

try {
    main();
    cleanup();
    process.exit(0);
} catch (e) {
    cleanup();
    console.error('❌ 验证失败：', e.message, '\n', e.stack);
    process.exit(1);
}
