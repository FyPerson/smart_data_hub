/**
 * 数据协作·多文件上传 M2 verify（一）—— groupUploadedDeliveryFiles 分组逻辑（纯单测，无 server/DB）
 *
 * 方案：数据协作模块_多文件上传_方案_20260625_v1.1.2.md §B/§五.4 + §七 verify-collab-multifile-grouping
 *
 * 覆盖：≥1+≥1 通过 / 缺任一类拒 / 各类 >5 拒 / 非法扩展名拒 / 空文件拒 /
 *       per-type 大小拒（脚本 >1MB，注入 validateRule）/
 *       ⭐ 混排 script,data,script,data → orderedFiles 严格保序 + typeOrdinal=rs:1/rd:1/rs:2/rd:2（RC2-M1/M2）
 *
 * 用法：node scripts/verify-collab-multifile-grouping.js
 */
'use strict';

const { groupUploadedDeliveryFiles } = require('../utils/collab-submit-helpers');
// 附件压缩包支持方案 D7：result_extra 扩展名/大小镜像规则改 require 真相源，不手写字面量
// （data/script 两类大小上限仍是本文件独立复刻——server.js 未把它们导出成常量，见下方 ⚠️ 漂移看门）。
const { ARCHIVE_EXTS, ARCHIVE_MAX_SIZE } = require('../utils/attachment-archive');

// 测试用 validateRule：镜像 server 端 COLLAB_ATTACHMENT_RULES 的 per-type 大小（result_script 1MB / result_data 100MB /
// result_extra 50MB=ARCHIVE_MAX_SIZE 真相源）
// （刻意复刻而非 require server.js——后者会起服务；限值简单稳定，测的是"拒绝机制"非精确字节）
// ⚠️ 漂移看门（ultracode 视角⑤ low）：若改 server.js:12261-12262 的 result_data/result_script defaultSize，须同步此处；
//   result_extra 已 require 真相源，天然不漂移。
const SIZE_LIMIT = { result_script: 1 * 1024 * 1024, result_data: 100 * 1024 * 1024, result_extra: ARCHIVE_MAX_SIZE };
function fakeValidateRule(type, name, size) {
    const lim = SIZE_LIMIT[type];
    if (typeof size === 'number' && size > lim) {
        return { ok: false, error: `${type} 文件大小超限：${(size / 1024 / 1024).toFixed(1)}MB > ${(lim / 1024 / 1024).toFixed(0)}MB` };
    }
    return { ok: true };
}
// 附件压缩包支持方案 D7：分类器第三个参数 normalizeExt——本文件的 f() 造的文件名本就干净（无控制字符/
//   首尾空白需要 trim），传一个与生产同构但简化的实现即可（trim + 小写扩展名），验证「分类器接受注入函数」
//   这件事本身，不重复测 normalizeAttachmentExt 的归一化细节（那是 server.js 层职责，本文件是纯单测）。
function fakeNormalizeExt(name) {
    return require('path').extname(String(name || '').trim()).toLowerCase();
}

// 造 multer 风格 file 对象
function f(name, size = 100) { return { originalname: name, size, path: `/tmp/_pending/${name}` }; }

let passed = 0, failed = 0;
function assert(cond, label) {
    if (cond) { console.log(`  ✓ ${label}`); passed++; }
    else { console.log(`  ✗ ${label}`); failed++; }
}

// T1: 1 data + 1 script → ok
console.log('\n=== T1: 1 data + 1 script → ok（最小合法）===');
{
    const r = groupUploadedDeliveryFiles([f('a.xlsx'), f('b.sql')], fakeValidateRule, fakeNormalizeExt);
    assert(r.ok === true, `T1 ok=true, got ${r.ok} (${r.code})`);
    assert(r.result_data.length === 1 && r.result_script.length === 1, `T1 各 1`);
    assert(r.orderedFiles.length === 2, `T1 orderedFiles=2`);
    // Y（单文件零回归）：同类型仅 1 个 → typeOrdinal 清为 undefined（落盘名无 _01，与改前逐字节相同）
    assert(r.orderedFiles[0].attachment_type === 'result_data' && r.orderedFiles[0].typeOrdinal === undefined, `T1 单 data typeOrdinal=undefined（不编号）`);
    assert(r.orderedFiles[1].attachment_type === 'result_script' && r.orderedFiles[1].typeOrdinal === undefined, `T1 单 script typeOrdinal=undefined（不编号）`);
}

// T2: 3 data + 2 script → ok，各 typeOrdinal 独立 1..n
console.log('\n=== T2: 3 data + 2 script → ok + typeOrdinal 各类独立递增 ===');
{
    const r = groupUploadedDeliveryFiles(
        [f('d1.xlsx'), f('d2.xls'), f('d3.xlsx'), f('s1.sql'), f('s2.txt')], fakeValidateRule, fakeNormalizeExt);
    assert(r.ok === true, `T2 ok=true, got ${r.ok} (${r.code})`);
    assert(r.result_data.length === 3 && r.result_script.length === 2, `T2 data=3 script=2`);
    const ords = r.orderedFiles.map(o => `${o.attachment_type}#${o.typeOrdinal}`).join(',');
    assert(ords === 'result_data#1,result_data#2,result_data#3,result_script#1,result_script#2', `T2 typeOrdinal: ${ords}`);
}

// T3: 缺 result_data → RESULT_DATA_REQUIRED
console.log('\n=== T3: 仅 script → RESULT_DATA_REQUIRED ===');
{
    const r = groupUploadedDeliveryFiles([f('b.sql'), f('c.txt')], fakeValidateRule, fakeNormalizeExt);
    assert(r.ok === false && r.code === 'RESULT_DATA_REQUIRED', `T3 code=RESULT_DATA_REQUIRED, got ${r.code}`);
}

// T4: 缺 result_script → RESULT_SCRIPT_REQUIRED
console.log('\n=== T4: 仅 data → RESULT_SCRIPT_REQUIRED ===');
{
    const r = groupUploadedDeliveryFiles([f('a.xlsx')], fakeValidateRule, fakeNormalizeExt);
    assert(r.ok === false && r.code === 'RESULT_SCRIPT_REQUIRED', `T4 code=RESULT_SCRIPT_REQUIRED, got ${r.code}`);
}

// T5: 6 data → RESULT_DATA_TOO_MANY
console.log('\n=== T5: 6 data + 1 script → RESULT_DATA_TOO_MANY ===');
{
    const files = [f('d1.xlsx'), f('d2.xlsx'), f('d3.xlsx'), f('d4.xlsx'), f('d5.xlsx'), f('d6.xlsx'), f('s.sql')];
    const r = groupUploadedDeliveryFiles(files, fakeValidateRule, fakeNormalizeExt);
    assert(r.ok === false && r.code === 'RESULT_DATA_TOO_MANY', `T5 code=RESULT_DATA_TOO_MANY, got ${r.code}`);
}

// T6: 6 script → RESULT_SCRIPT_TOO_MANY
console.log('\n=== T6: 1 data + 6 script → RESULT_SCRIPT_TOO_MANY ===');
{
    const files = [f('d.xlsx'), f('s1.sql'), f('s2.sql'), f('s3.sql'), f('s4.sql'), f('s5.sql'), f('s6.sql')];
    const r = groupUploadedDeliveryFiles(files, fakeValidateRule, fakeNormalizeExt);
    assert(r.ok === false && r.code === 'RESULT_SCRIPT_TOO_MANY', `T6 code=RESULT_SCRIPT_TOO_MANY, got ${r.code}`);
}

// T7: 非法扩展名 → RESULT_INVALID_TYPE
console.log('\n=== T7: .pdf 非法扩展名 → RESULT_INVALID_TYPE ===');
{
    const r = groupUploadedDeliveryFiles([f('a.xlsx'), f('b.sql'), f('c.pdf')], fakeValidateRule, fakeNormalizeExt);
    assert(r.ok === false && r.code === 'RESULT_INVALID_TYPE', `T7 code=RESULT_INVALID_TYPE, got ${r.code}`);
}

// T8: 空文件 → EMPTY_FILE
console.log('\n=== T8: size=0 空文件 → EMPTY_FILE ===');
{
    const r = groupUploadedDeliveryFiles([f('a.xlsx', 0), f('b.sql')], fakeValidateRule, fakeNormalizeExt);
    assert(r.ok === false && r.code === 'EMPTY_FILE', `T8 code=EMPTY_FILE, got ${r.code}`);
}

// T9: per-type 大小拒（脚本 >1MB）→ RESULT_FILE_INVALID
console.log('\n=== T9: result_script 1.5MB > 1MB → RESULT_FILE_INVALID（RC-M3）===');
{
    const r = groupUploadedDeliveryFiles([f('a.xlsx'), f('big.sql', 1.5 * 1024 * 1024)], fakeValidateRule, fakeNormalizeExt);
    assert(r.ok === false && r.code === 'RESULT_FILE_INVALID', `T9 code=RESULT_FILE_INVALID, got ${r.code}`);
    // 数据侧大文件（50MB ≤ 100MB）应通过——证明 per-type 区分
    const r2 = groupUploadedDeliveryFiles([f('big.xlsx', 50 * 1024 * 1024), f('b.sql')], fakeValidateRule, fakeNormalizeExt);
    assert(r2.ok === true, `T9 data 50MB ≤100MB 通过, got ${r2.ok} (${r2.code})`);
}

// T10: ⭐ 混排 script,data,script,data → orderedFiles 严格保序 + typeOrdinal（RC2-M2 核心）
console.log('\n=== T10: 混排 s,d,s,d → orderedFiles 保序 + typeOrdinal rs1/rd1/rs2/rd2（RC2-M2）===');
{
    const inS1 = f('s1.sql'), inD1 = f('d1.xlsx'), inS2 = f('s2.txt'), inD2 = f('d2.xls');
    const r = groupUploadedDeliveryFiles([inS1, inD1, inS2, inD2], fakeValidateRule, fakeNormalizeExt);
    assert(r.ok === true, `T10 ok=true, got ${r.ok} (${r.code})`);
    const seq = r.orderedFiles.map(o => `${o.attachment_type}#${o.typeOrdinal}`).join(',');
    assert(seq === 'result_script#1,result_data#1,result_script#2,result_data#2', `T10 orderedFiles 序: ${seq}`);
    // orderedFiles 唯一遍历源：每元素 file 引用 = 原输入对象（禁重组）
    assert(r.orderedFiles[0].file === inS1 && r.orderedFiles[1].file === inD1
        && r.orderedFiles[2].file === inS2 && r.orderedFiles[3].file === inD2, `T10 file 引用 = 原输入对象（保序不重组）`);
}

// T11: 空输入 → NO_FILES
console.log('\n=== T11: 空数组 → NO_FILES ===');
{
    const r = groupUploadedDeliveryFiles([], fakeValidateRule, fakeNormalizeExt);
    assert(r.ok === false && r.code === 'NO_FILES', `T11 code=NO_FILES, got ${r.code}`);
}

// T12: 不传 validateRule → 跳过 per-type 大小（仍按计数/类型校验）
console.log('\n=== T12: 不传 validateRule → 大文件不被大小拒（仅类型/计数校验）===');
{
    const r = groupUploadedDeliveryFiles([f('a.xlsx'), f('big.sql', 99 * 1024 * 1024)]);
    assert(r.ok === true, `T12 无 validateRule 时大脚本通过, got ${r.ok} (${r.code})`);
}

// T13: 混合单/多（2 data + 1 script）→ data 编号 1,2；script 单个不编号（Y 按类型独立判定）
console.log('\n=== T13: 2 data + 1 script → data typeOrdinal 1,2；script=undefined（Y 按类型独立）===');
{
    const r = groupUploadedDeliveryFiles([f('d1.xlsx'), f('d2.xlsx'), f('s.sql')], fakeValidateRule, fakeNormalizeExt);
    assert(r.ok === true, `T13 ok=true, got ${r.ok} (${r.code})`);
    const dataOrds = r.orderedFiles.filter(o => o.attachment_type === 'result_data').map(o => o.typeOrdinal);
    const scriptOrd = r.orderedFiles.find(o => o.attachment_type === 'result_script').typeOrdinal;
    assert(JSON.stringify(dataOrds) === '[1,2]', `T13 多 data 编号 [1,2], got ${JSON.stringify(dataOrds)}`);
    assert(scriptOrd === undefined, `T13 单 script typeOrdinal=undefined, got ${scriptOrd}`);
}

// T14（附件压缩包支持方案 D7·codex 06 F1 要求）：sql + xlsx + 三种压缩扩展名各一 → 显式三类映射，
//   zip/rar/7z 落 result_extra 桶（非二元 data/script 桶）；单个 extra → typeOrdinal=undefined（与 rd/rs
//   单文件同口径）。扩展名从真相源 ARCHIVE_EXTS 派生，不手写字面量。
console.log('\n=== T14: sql + xlsx + zip/rar/7z 各一 → result_extra 三类映射（非二元桶）===');
for (const archiveExt of ARCHIVE_EXTS) {
    const extraName = `extra${archiveExt}`;
    const inS = f('s.sql'), inD = f('d.xlsx'), inE = f(extraName);
    const r = groupUploadedDeliveryFiles([inS, inD, inE], fakeValidateRule, fakeNormalizeExt);
    assert(r.ok === true, `T14(${archiveExt}) ok=true, got ${r.ok} (${r.code})`);
    assert(Array.isArray(r.result_extra) && r.result_extra.length === 1 && r.result_extra[0] === inE,
        `T14(${archiveExt}) result_extra 恰含该压缩文件（非二元桶把它塞进 data/script）`);
    // 判别力核心：二元桶实现（"不是 data 就是 script"）会让 zip 落入 result_script 桶（多数分类器的
    //   else 分支），或触发假的 RESULT_INVALID_TYPE——下面两条断言任一改坏三类映射都会变红。
    assert(!r.result_script.includes(inE), `T14(${archiveExt}) result_script 不含压缩文件（防二元桶误落）`);
    assert(!r.result_data.includes(inE), `T14(${archiveExt}) result_data 不含压缩文件（防二元桶误落）`);
    const extraOrdinal = r.orderedFiles.find(o => o.file === inE).typeOrdinal;
    assert(extraOrdinal === undefined, `T14(${archiveExt}) 单 extra typeOrdinal=undefined（不编号），got ${extraOrdinal}`);
}

// T15: 6 个压缩包 → RESULT_EXTRA_TOO_MANY（与 rd/rs 同族码，独立于 data/script 计数）
console.log('\n=== T15: 1 data + 1 script + 6 extra → RESULT_EXTRA_TOO_MANY ===');
{
    const files = [f('d.xlsx'), f('s.sql'), f('e1.zip'), f('e2.zip'), f('e3.zip'), f('e4.zip'), f('e5.zip'), f('e6.zip')];
    const r = groupUploadedDeliveryFiles(files, fakeValidateRule, fakeNormalizeExt);
    assert(r.ok === false && r.code === 'RESULT_EXTRA_TOO_MANY', `T15 code=RESULT_EXTRA_TOO_MANY, got ${r.code}`);
}

// T16: extra 0 个（选填非必备）→ 仍 ok=true，result_extra=[]（与 D7「0..5」口径一致，不同于 rd/rs 的「≥1」）
console.log('\n=== T16: 0 个 extra（选填）→ ok=true，result_extra=[] ===');
{
    const r = groupUploadedDeliveryFiles([f('d.xlsx'), f('s.sql')], fakeValidateRule, fakeNormalizeExt);
    assert(r.ok === true && Array.isArray(r.result_extra) && r.result_extra.length === 0,
        `T16 无 extra 仍应通过且 result_extra=[]，got ok=${r.ok} result_extra=${JSON.stringify(r.result_extra)}`);
}

// T17: extra per-type 大小拒（>50MB）→ RESULT_FILE_INVALID（与 rd/rs 同错误码族，注入 validateRule 生效）
console.log('\n=== T17: result_extra 51MB > 50MB（ARCHIVE_MAX_SIZE）→ RESULT_FILE_INVALID ===');
{
    const r = groupUploadedDeliveryFiles([f('d.xlsx'), f('s.sql'), f('big.zip', ARCHIVE_MAX_SIZE + 1024)], fakeValidateRule, fakeNormalizeExt);
    assert(r.ok === false && r.code === 'RESULT_FILE_INVALID', `T17 code=RESULT_FILE_INVALID, got ${r.code}`);
}

console.log(`\n== Summary: ${passed} pass / ${failed} fail ==`);
process.exit(failed === 0 ? 0 : 1);
