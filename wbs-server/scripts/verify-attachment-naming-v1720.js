/**
 * v1.72.0 落盘文件名统一 OA 格式 - helper 边界 case 验证脚本
 *
 * 验证：
 *   T1-T5：基础场景（rd/rs/sc/ex/failed）
 *   T6-T9：字符净化（OA 含 / _ 空格 / 姓名含 emoji + 长度）
 *   T10-T12：异常路径（OA 为空 / createdAt 异常 / 未知 type）
 *   T13-T15：边界（seq 0 / seq 1000 + / display_name 空 fallback）
 *
 * 用法：node scripts/verify-attachment-naming-v1720.js
 */
'use strict';

const assert = require('assert');
const v = require('../utils/collab-attachment-versioning');

let pass = 0, fail = 0;
function check(name, actual, expected) {
    try {
        assert.strictEqual(actual, expected);
        console.log(`  ✅ ${name}: ${actual}`);
        pass++;
    } catch (e) {
        console.log(`  ❌ ${name}: 期望 "${expected}" 但得到 "${actual}"`);
        fail++;
    }
}
function checkThrow(name, fn, expectedCode) {
    try {
        fn();
        console.log(`  ❌ ${name}: 期望 throw ${expectedCode} 但未 throw`);
        fail++;
    } catch (e) {
        if (e.code === expectedCode) {
            console.log(`  ✅ ${name}: throw ${e.code}`);
            pass++;
        } else {
            console.log(`  ❌ ${name}: 期望 throw ${expectedCode} 但得到 ${e.code || e.message}`);
            fail++;
        }
    }
}

console.log('=== v1.72.0 落盘命名 helper 验证 ===\n');

console.log('--- 基础场景 T1-T5 ---');
check('T1 rd active',
    v.buildFinalAttachmentName({oaRequestNo: 'OA-364265', createdAt: '2026-05-22 10:30:00', seq: 1, attachmentType: 'result_data', isFailed: false, displayName: '示例用户A', username: 'demo_user_a', ext: '.xlsx'}),
    'OA-364265_20260522_001_rd_示例用户A.xlsx');

check('T2 rs active',
    v.buildFinalAttachmentName({oaRequestNo: 'OA-364265', createdAt: '2026-05-22 10:30:00', seq: 1, attachmentType: 'result_script', isFailed: false, displayName: '示例用户A', username: 'demo_user_a', ext: '.sql'}),
    'OA-364265_20260522_001_rs_示例用户A.sql');

check('T3 sc (screenshot)',
    v.buildFinalAttachmentName({oaRequestNo: 'OA-364265', createdAt: '2026-05-22 10:30:00', seq: 5, attachmentType: 'screenshot', isFailed: false, displayName: '管理员', username: 'admin', ext: '.png'}),
    'OA-364265_20260522_005_sc_管理员.png');

check('T4 ex (example_xlsx)',
    v.buildFinalAttachmentName({oaRequestNo: 'OA-365212', createdAt: '2026-05-25 14:00:00', seq: 1, attachmentType: 'example_xlsx', isFailed: false, displayName: '管理员', username: 'admin', ext: '.xlsx'}),
    'OA-365212_20260525_001_ex_管理员.xlsx');

check('T5 rd failed',
    v.buildFinalAttachmentName({oaRequestNo: 'OA-364265', createdAt: '2026-05-22 10:30:00', seq: 3, attachmentType: 'result_data', isFailed: true, displayName: '示例用户A', username: 'demo_user_a', ext: '.xlsx'}),
    'OA-364265_20260522_003_rd_failed_示例用户A.xlsx');

console.log('\n--- 字符净化 T6-T9 ---');
check('T6 OA 含 / 空格 _',
    v.buildFinalAttachmentName({oaRequestNo: 'TEST/OA 123_456', createdAt: '2026-05-22 10:30:00', seq: 1, attachmentType: 'result_data', isFailed: false, displayName: '示例用户A', username: 'fy', ext: '.xlsx'}),
    'TEST-OA-123-456_20260522_001_rd_示例用户A.xlsx');

check('T7 姓名截前 10 字符',
    v.buildFinalAttachmentName({oaRequestNo: 'OA-364265', createdAt: '2026-05-22 10:30:00', seq: 1, attachmentType: 'result_data', isFailed: false, displayName: '甄妮你你你你你你你你你长', username: 'fy', ext: '.xlsx'}),
    'OA-364265_20260522_001_rd_甄妮你你你你你你你你.xlsx');

check('T8 扩展名 toLowerCase',
    v.buildFinalAttachmentName({oaRequestNo: 'OA-364265', createdAt: '2026-05-22 10:30:00', seq: 1, attachmentType: 'screenshot', isFailed: false, displayName: '示例用户A', username: 'fy', ext: '.PNG'}),
    'OA-364265_20260522_001_sc_示例用户A.png');

check('T9 姓名含 Windows 禁止字符（10 字符截前 10 全留）',
    v.buildFinalAttachmentName({oaRequestNo: 'OA-364265', createdAt: '2026-05-22 10:30:00', seq: 1, attachmentType: 'result_data', isFailed: false, displayName: '冯/云*?<>|"\\', username: 'fy', ext: '.xlsx'}),
    'OA-364265_20260522_001_rd_冯_云_______.xlsx');

console.log('\n--- 异常路径 T10-T12 ---');
checkThrow('T10 OA 为空 throw OA_REQUEST_NO_REQUIRED',
    () => v.buildFinalAttachmentName({oaRequestNo: '', createdAt: '2026-05-22 10:30:00', seq: 1, attachmentType: 'result_data', isFailed: false, displayName: '示例用户A', username: 'fy', ext: '.xlsx'}),
    'OA_REQUEST_NO_REQUIRED');

checkThrow('T11 createdAt 异常 throw INVALID_CREATED_AT',
    () => v.buildFinalAttachmentName({oaRequestNo: 'OA-364265', createdAt: 'not-a-date', seq: 1, attachmentType: 'result_data', isFailed: false, displayName: '示例用户A', username: 'fy', ext: '.xlsx'}),
    'INVALID_CREATED_AT');

checkThrow('T12 未知 attachmentType throw UNKNOWN_ATTACHMENT_TYPE',
    () => v.buildFinalAttachmentName({oaRequestNo: 'OA-364265', createdAt: '2026-05-22 10:30:00', seq: 1, attachmentType: 'delivery', isFailed: false, displayName: '示例用户A', username: 'fy', ext: '.xlsx'}),
    'UNKNOWN_ATTACHMENT_TYPE');

console.log('\n--- 边界 T13-T15 ---');
checkThrow('T13 seq 0 throw INVALID_SEQ',
    () => v.buildFinalAttachmentName({oaRequestNo: 'OA-364265', createdAt: '2026-05-22 10:30:00', seq: 0, attachmentType: 'result_data', isFailed: false, displayName: '示例用户A', username: 'fy', ext: '.xlsx'}),
    'INVALID_SEQ');

check('T14 seq 1000+ 不截断',
    v.buildFinalAttachmentName({oaRequestNo: 'OA-364265', createdAt: '2026-05-22 10:30:00', seq: 1234, attachmentType: 'result_data', isFailed: false, displayName: '示例用户A', username: 'fy', ext: '.xlsx'}),
    'OA-364265_20260522_1234_rd_示例用户A.xlsx');

check('T15 display_name 空时 fallback username',
    v.buildFinalAttachmentName({oaRequestNo: 'OA-364265', createdAt: '2026-05-22 10:30:00', seq: 1, attachmentType: 'result_data', isFailed: false, displayName: '', username: 'demo_user_a', ext: '.xlsx'}),
    'OA-364265_20260522_001_rd_demo_user_a.xlsx');

console.log('\n--- 类型缩写映射 ---');
console.log(`  ATTACHMENT_TYPE_TO_ABBR: ${JSON.stringify(v.ATTACHMENT_TYPE_TO_ABBR)}`);

console.log(`\n=== 总计: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
