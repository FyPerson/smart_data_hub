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

// 测试用 validateRule：镜像 server 端 COLLAB_ATTACHMENT_RULES 的 per-type 大小（result_script 1MB / result_data 100MB）
// （刻意复刻而非 require server.js——后者会起服务；限值简单稳定，测的是"拒绝机制"非精确字节）
// ⚠️ 漂移看门（ultracode 视角⑤ low）：若改 server.js:12261-12262 的 result_data/result_script defaultSize，须同步此处。
const SIZE_LIMIT = { result_script: 1 * 1024 * 1024, result_data: 100 * 1024 * 1024 };
function fakeValidateRule(type, name, size) {
    const lim = SIZE_LIMIT[type];
    if (typeof size === 'number' && size > lim) {
        return { ok: false, error: `${type} 文件大小超限：${(size / 1024 / 1024).toFixed(1)}MB > ${(lim / 1024 / 1024).toFixed(0)}MB` };
    }
    return { ok: true };
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
    const r = groupUploadedDeliveryFiles([f('a.xlsx'), f('b.sql')], fakeValidateRule);
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
        [f('d1.xlsx'), f('d2.xls'), f('d3.xlsx'), f('s1.sql'), f('s2.txt')], fakeValidateRule);
    assert(r.ok === true, `T2 ok=true, got ${r.ok} (${r.code})`);
    assert(r.result_data.length === 3 && r.result_script.length === 2, `T2 data=3 script=2`);
    const ords = r.orderedFiles.map(o => `${o.attachment_type}#${o.typeOrdinal}`).join(',');
    assert(ords === 'result_data#1,result_data#2,result_data#3,result_script#1,result_script#2', `T2 typeOrdinal: ${ords}`);
}

// T3: 缺 result_data → RESULT_DATA_REQUIRED
console.log('\n=== T3: 仅 script → RESULT_DATA_REQUIRED ===');
{
    const r = groupUploadedDeliveryFiles([f('b.sql'), f('c.txt')], fakeValidateRule);
    assert(r.ok === false && r.code === 'RESULT_DATA_REQUIRED', `T3 code=RESULT_DATA_REQUIRED, got ${r.code}`);
}

// T4: 缺 result_script → RESULT_SCRIPT_REQUIRED
console.log('\n=== T4: 仅 data → RESULT_SCRIPT_REQUIRED ===');
{
    const r = groupUploadedDeliveryFiles([f('a.xlsx')], fakeValidateRule);
    assert(r.ok === false && r.code === 'RESULT_SCRIPT_REQUIRED', `T4 code=RESULT_SCRIPT_REQUIRED, got ${r.code}`);
}

// T5: 6 data → RESULT_DATA_TOO_MANY
console.log('\n=== T5: 6 data + 1 script → RESULT_DATA_TOO_MANY ===');
{
    const files = [f('d1.xlsx'), f('d2.xlsx'), f('d3.xlsx'), f('d4.xlsx'), f('d5.xlsx'), f('d6.xlsx'), f('s.sql')];
    const r = groupUploadedDeliveryFiles(files, fakeValidateRule);
    assert(r.ok === false && r.code === 'RESULT_DATA_TOO_MANY', `T5 code=RESULT_DATA_TOO_MANY, got ${r.code}`);
}

// T6: 6 script → RESULT_SCRIPT_TOO_MANY
console.log('\n=== T6: 1 data + 6 script → RESULT_SCRIPT_TOO_MANY ===');
{
    const files = [f('d.xlsx'), f('s1.sql'), f('s2.sql'), f('s3.sql'), f('s4.sql'), f('s5.sql'), f('s6.sql')];
    const r = groupUploadedDeliveryFiles(files, fakeValidateRule);
    assert(r.ok === false && r.code === 'RESULT_SCRIPT_TOO_MANY', `T6 code=RESULT_SCRIPT_TOO_MANY, got ${r.code}`);
}

// T7: 非法扩展名 → RESULT_INVALID_TYPE
console.log('\n=== T7: .pdf 非法扩展名 → RESULT_INVALID_TYPE ===');
{
    const r = groupUploadedDeliveryFiles([f('a.xlsx'), f('b.sql'), f('c.pdf')], fakeValidateRule);
    assert(r.ok === false && r.code === 'RESULT_INVALID_TYPE', `T7 code=RESULT_INVALID_TYPE, got ${r.code}`);
}

// T8: 空文件 → EMPTY_FILE
console.log('\n=== T8: size=0 空文件 → EMPTY_FILE ===');
{
    const r = groupUploadedDeliveryFiles([f('a.xlsx', 0), f('b.sql')], fakeValidateRule);
    assert(r.ok === false && r.code === 'EMPTY_FILE', `T8 code=EMPTY_FILE, got ${r.code}`);
}

// T9: per-type 大小拒（脚本 >1MB）→ RESULT_FILE_INVALID
console.log('\n=== T9: result_script 1.5MB > 1MB → RESULT_FILE_INVALID（RC-M3）===');
{
    const r = groupUploadedDeliveryFiles([f('a.xlsx'), f('big.sql', 1.5 * 1024 * 1024)], fakeValidateRule);
    assert(r.ok === false && r.code === 'RESULT_FILE_INVALID', `T9 code=RESULT_FILE_INVALID, got ${r.code}`);
    // 数据侧大文件（50MB ≤ 100MB）应通过——证明 per-type 区分
    const r2 = groupUploadedDeliveryFiles([f('big.xlsx', 50 * 1024 * 1024), f('b.sql')], fakeValidateRule);
    assert(r2.ok === true, `T9 data 50MB ≤100MB 通过, got ${r2.ok} (${r2.code})`);
}

// T10: ⭐ 混排 script,data,script,data → orderedFiles 严格保序 + typeOrdinal（RC2-M2 核心）
console.log('\n=== T10: 混排 s,d,s,d → orderedFiles 保序 + typeOrdinal rs1/rd1/rs2/rd2（RC2-M2）===');
{
    const inS1 = f('s1.sql'), inD1 = f('d1.xlsx'), inS2 = f('s2.txt'), inD2 = f('d2.xls');
    const r = groupUploadedDeliveryFiles([inS1, inD1, inS2, inD2], fakeValidateRule);
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
    const r = groupUploadedDeliveryFiles([], fakeValidateRule);
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
    const r = groupUploadedDeliveryFiles([f('d1.xlsx'), f('d2.xlsx'), f('s.sql')], fakeValidateRule);
    assert(r.ok === true, `T13 ok=true, got ${r.ok} (${r.code})`);
    const dataOrds = r.orderedFiles.filter(o => o.attachment_type === 'result_data').map(o => o.typeOrdinal);
    const scriptOrd = r.orderedFiles.find(o => o.attachment_type === 'result_script').typeOrdinal;
    assert(JSON.stringify(dataOrds) === '[1,2]', `T13 多 data 编号 [1,2], got ${JSON.stringify(dataOrds)}`);
    assert(scriptOrd === undefined, `T13 单 script typeOrdinal=undefined, got ${scriptOrd}`);
}

console.log(`\n== Summary: ${passed} pass / ${failed} fail ==`);
process.exit(failed === 0 ? 0 : 1);
