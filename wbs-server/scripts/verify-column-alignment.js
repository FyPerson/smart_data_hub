// 验证脚本：取数交付质量记录 v3.0 Commit B — 两个纯 helper
// 用法：node scripts/verify-column-alignment.js
// 覆盖：归一化规则（trim/全半角/大小写/去空/去重）+ compareColumns（齐全/缺列/多列/边界）
//       + readXlsxHeader（真实模板/合并单元格/空表头/零数据行）
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const XLSX = require('xlsx');
const { normalizeColumnName, compareColumns } = require('../utils/column-alignment-checker');
const { readXlsxHeader } = require('../utils/xlsx-header-reader');

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ✓ ${msg}`); };

// ============ 第一部分：normalizeColumnName ============
function testNormalize() {
    console.log('[normalizeColumnName]');
    assert.strictEqual(normalizeColumnName('  结算ID  '), '结算id', 'trim + 英文 lowercase');
    ok('trim 首尾空格 + 英文 lowercase（结算ID → 结算id）');

    assert.strictEqual(normalizeColumnName('ＩＤ'), 'id', '全角 ID → 半角 lowercase');
    ok('全角 → 半角（ＩＤ → id）');

    assert.strictEqual(normalizeColumnName('金额（元）'), '金额(元)', '全角括号 → 半角');
    ok('全角括号 → 半角（金额（元） → 金额(元)）');

    assert.strictEqual(normalizeColumnName(null), '', 'null → 空串');
    assert.strictEqual(normalizeColumnName('   '), '', '纯空格 → 空串');
    assert.strictEqual(normalizeColumnName('　'), '', '全角空格 → 空串');
    ok('空值/纯空格/全角空格 → 空串');

    assert.strictEqual(normalizeColumnName(123), '123', '数字列名转字符串');
    ok('数字列名转字符串（123 → "123"）');

    // [M-1] 不可见脏字符清理（用 \u 转义构造，避免字面不可见字符）
    assert.strictEqual(normalizeColumnName('​金额​'), '金额', '零宽空格应删除');
    assert.strictEqual(normalizeColumnName('﻿结算ID'), '结算id', 'BOM 应删除');
    assert.strictEqual(normalizeColumnName('客户‍ID'), '客户id', '零宽连接符应删除');
    ok('M-1 零宽字符/BOM 删除（\\u200B金额\\u200B → 金额）');

    // [M-1] 空白归一：NBSP / 换行 / 制表 / 连续空白 → 单个半角空格
    assert.strictEqual(normalizeColumnName('客户 ID'), '客户 id', 'NBSP 应转半角空格');
    assert.strictEqual(normalizeColumnName('客户\nID'), '客户 id', '换行应转空格');
    assert.strictEqual(normalizeColumnName('客户\tID'), '客户 id', '制表应转空格');
    assert.strictEqual(normalizeColumnName('客户  ID'), '客户 id', '连续空白应归一为单空格');
    ok('M-1 空白归一（NBSP/换行/制表/连续空白 → 单个半角空格）');

    // [M-1] 空白归一保留语义边界：'客户ID' 与 '客户 ID' 仍不同（不是删空格）
    assert.notStrictEqual(normalizeColumnName('客户ID'), normalizeColumnName('客户 ID'), '客户ID ≠ 客户 ID');
    ok('M-1 语义边界：客户ID ≠ 客户 ID（归一非删空格）');

    // [M-1] 纯不可见字符 → 空串
    assert.strictEqual(normalizeColumnName('​﻿ '), '', '纯不可见字符应为空串');
    ok('M-1 纯不可见字符 → 空串（调用方过滤）');
}

// ============ 第二部分：compareColumns ============
function testCompare() {
    console.log('[compareColumns]');

    // [齐全] T ⊆ S
    let r = compareColumns(['结算ID', '金额'], ['结算ID', '金额', '部门']);
    assert.strictEqual(r.complete, true, '齐全应 complete=true');
    assert.deepStrictEqual(r.missing, [], '齐全 missing 应为空');
    ok('齐全：T⊆S（多出的"部门"放行不报警）');

    // [缺列] T ⊄ S
    r = compareColumns(['结算ID', '金额', '收款人'], ['结算ID', '金额']);
    assert.strictEqual(r.complete, false, '缺列应 complete=false');
    assert.deepStrictEqual(r.missing, ['收款人'], 'missing 应含收款人');
    ok('缺列：缺"收款人"被精确报出');

    // [大小写不敏感] 模板 ID vs SQL id
    r = compareColumns(['ID', 'Name'], ['id', 'name', 'extra']);
    assert.strictEqual(r.complete, true, '大小写不敏感应齐全');
    ok('大小写不敏感：模板 ID/Name 命中 SQL id/name');

    // [全半角] 模板全角 vs SQL 半角
    r = compareColumns(['ＩＤ', '金额（元）'], ['id', '金额(元)']);
    assert.strictEqual(r.complete, true, '全半角归一后应齐全');
    ok('全半角：模板全角命中 SQL 半角');

    // [空格] 模板带空格 vs SQL 不带
    r = compareColumns(['  结算ID  ', '金额 '], ['结算ID', '金额']);
    assert.strictEqual(r.complete, true, 'trim 后应齐全');
    ok('空格：模板列首尾空格 trim 后命中');

    // [重复列名去重] 模板有重复列
    r = compareColumns(['金额', '金额', '部门'], ['金额', '部门']);
    assert.strictEqual(r.complete, true, '重复列去重后应齐全');
    assert.strictEqual(r.templateCount, 2, '模板去重后应 2 列');
    ok('重复列名去重：模板"金额×2+部门"去重为 2 列后齐全');

    // [空列名忽略] 模板含空列
    r = compareColumns(['结算ID', '', null, '金额'], ['结算ID', '金额']);
    assert.strictEqual(r.complete, true, '空列名忽略后应齐全');
    assert.strictEqual(r.templateCount, 2, '忽略空列后应 2 列');
    ok('空列名忽略：模板含空串/null 列被过滤');

    // [边界] 模板为空 → 空集是子集 → 齐全
    r = compareColumns([], ['结算ID']);
    assert.strictEqual(r.complete, true, '空模板应齐全（无需求列=不缺列）');
    ok('边界：空模板列 → complete=true（无模板要求=不缺列）');

    // [边界] SQL 为空 + 模板非空 → 全缺
    r = compareColumns(['结算ID', '金额'], []);
    assert.strictEqual(r.complete, false, 'SQL 空应缺列');
    assert.strictEqual(r.missing.length, 2, '应缺 2 列');
    ok('边界：SQL 列为空 + 模板非空 → 全部缺列');

    // [非数组容错]
    r = compareColumns(null, null);
    assert.strictEqual(r.complete, true, 'null 输入应不崩（空集⊆空集）');
    ok('容错：null 输入不崩（视为空集）');
}

// ============ 第三部分：readXlsxHeader ============
function testXlsxHeader() {
    console.log('[readXlsxHeader]');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-xlsx-'));

    // [基础] 构造一个带表头的 xlsx
    const wb1 = XLSX.utils.book_new();
    const ws1 = XLSX.utils.aoa_to_sheet([
        ['结算ID', '申请部门', '金额'],
        [1, '财务部', 100],
        [2, '市场部', 200],
    ]);
    XLSX.utils.book_append_sheet(wb1, ws1, 'Sheet1');
    const f1 = path.join(tmpDir, 'basic.xlsx');
    XLSX.writeFile(wb1, f1);
    const r1 = readXlsxHeader(f1);
    assert.deepStrictEqual(r1.header, ['结算ID', '申请部门', '金额'], '基础表头读取失败');
    assert.strictEqual(r1.sheetName, 'Sheet1', 'sheetName 应返回（M-3）');
    ok('基础：读出 3 列表头 + sheetName=Sheet1（M-3）');

    // [零数据行] 只有表头无数据
    const wb2 = XLSX.utils.book_new();
    const ws2 = XLSX.utils.aoa_to_sheet([['列A', '列B']]);
    XLSX.utils.book_append_sheet(wb2, ws2, 'Sheet1');
    const f2 = path.join(tmpDir, 'header-only.xlsx');
    XLSX.writeFile(wb2, f2);
    assert.deepStrictEqual(readXlsxHeader(f2).header, ['列A', '列B'], '零数据行表头读取失败');
    ok('零数据行：只有表头也能读出（列对齐命根子）');

    // [尾部空列] 表头后有空列撑宽
    const wb3 = XLSX.utils.book_new();
    const ws3 = XLSX.utils.aoa_to_sheet([['列A', '列B', null, null]]);
    XLSX.utils.book_append_sheet(wb3, ws3, 'Sheet1');
    const f3 = path.join(tmpDir, 'trailing.xlsx');
    XLSX.writeFile(wb3, f3);
    assert.deepStrictEqual(readXlsxHeader(f3).header, ['列A', '列B'], '尾部空列未剥离');
    ok('尾部空列：撑宽的尾部空列被剥离');

    // [空表头] 第一行全空（不是把第二行当表头！blankrows bug 回归测试）
    const wb4 = XLSX.utils.book_new();
    const ws4 = XLSX.utils.aoa_to_sheet([[null, null], ['有数据', '行']]);
    XLSX.utils.book_append_sheet(wb4, ws4, 'Sheet1');
    const f4 = path.join(tmpDir, 'empty-header.xlsx');
    XLSX.writeFile(wb4, f4);
    assert.deepStrictEqual(readXlsxHeader(f4).header, [], '空表头应返回空数组（不可把第二行当表头）');
    ok('空表头：第一行全空 → 返回 []（不误把第二行当表头）');

    // [合并单元格] 合并的表头取左上格
    const wb5 = XLSX.utils.book_new();
    const ws5 = XLSX.utils.aoa_to_sheet([['合并标题', null, '独立列'], [1, 2, 3]]);
    ws5['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];  // A1:B1 合并
    XLSX.utils.book_append_sheet(wb5, ws5, 'Sheet1');
    const f5 = path.join(tmpDir, 'merged.xlsx');
    XLSX.writeFile(wb5, f5);
    const h5 = readXlsxHeader(f5).header;
    assert.strictEqual(h5[0], '合并标题', '合并单元格应取左上格值');
    assert.strictEqual(h5[2], '独立列', '合并后独立列应正常');
    ok('合并单元格：取左上格值（合并标题 + 独立列）');

    // [文件不存在] 应抛错 + code 断言（L-3：调用方依赖 code 做跳过策略）
    assert.throws(
        () => readXlsxHeader(path.join(tmpDir, 'nonexistent.xlsx')),
        e => e.code === 'XLSX_READ_FAILED' && /不存在/.test(e.message),
        '文件不存在应抛 XLSX_READ_FAILED');
    ok('异常：文件不存在抛 err.code=XLSX_READ_FAILED（L-3 锁住契约）');

    // [非法入参] 应抛错 + code 断言（L-3）
    assert.throws(
        () => readXlsxHeader(null),
        e => e.code === 'XLSX_READ_FAILED' && /必填/.test(e.message),
        'null 入参应抛 XLSX_READ_FAILED');
    ok('异常：null 入参抛 err.code=XLSX_READ_FAILED（L-3）');

    // [损坏 xlsx] 截断的 zip 应抛 XLSX_READ_FAILED（L-3：覆盖 XLSX.readFile 解析失败分支）
    //   探针实证 SheetJS 行为：纯文本/空文件不抛错（当单 sheet 读，空文件 !ref 空→header:[]）；
    //   截断的有效 zip 头（PK\x03\x04 后损坏）才真正抛 "Unsupported ZIP file"。
    const f6 = path.join(tmpDir, 'corrupt.xlsx');
    fs.writeFileSync(f6, Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]));
    assert.throws(
        () => readXlsxHeader(f6),
        e => e.code === 'XLSX_READ_FAILED',
        '损坏 xlsx 应抛 XLSX_READ_FAILED');
    ok('异常：损坏 xlsx（截断 zip）抛 err.code=XLSX_READ_FAILED（L-3 解析失败分支）');

    // 清理临时文件
    fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ============ 第四部分：真实生产模板（如存在）============
function testRealTemplate() {
    console.log('[真实生产模板]');
    const real = path.join(__dirname, '..', '..', '生产协作附件备份');
    if (!fs.existsSync(real)) {
        console.log('  ⊘ 跳过（无生产附件备份目录）');
        return;
    }
    // 找一个真实 xlsx
    let found = null;
    const walk = (dir) => {
        for (const name of fs.readdirSync(dir)) {
            const p = path.join(dir, name);
            const st = fs.statSync(p);
            if (st.isDirectory()) { walk(p); if (found) return; }
            else if (name.endsWith('.xlsx') && !found) found = p;
        }
    };
    try { walk(real); } catch (e) { /* 忽略遍历错误 */ }
    if (!found) { console.log('  ⊘ 跳过（未找到真实 xlsx）'); return; }

    const { header, sheetName } = readXlsxHeader(found);
    assert.ok(Array.isArray(header) && header.length > 0, '真实模板应读出表头');
    ok(`真实模板：读出 ${header.length} 列表头 + sheetName=${sheetName}（${path.basename(found)}）`);

    // 真实模板自比对应齐全
    const r = compareColumns(header, header);
    assert.strictEqual(r.complete, true, '模板自比对应齐全');
    ok('真实模板：自比对 complete=true');
}

function main() {
    testNormalize();
    testCompare();
    testXlsxHeader();
    testRealTemplate();
    console.log(`\n[全部通过] ${passed}/${passed} ✓ Commit B helper 验证通过`);
}

try {
    main();
} catch (e) {
    console.error('\n[失败]', e.message, '\n', e.stack);
    process.exit(1);
}
