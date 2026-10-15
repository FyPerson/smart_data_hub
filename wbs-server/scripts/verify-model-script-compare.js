'use strict';

/**
 * #77 C1a：save-scripts 脚本内容比较（routes/model-center/script-compare.js）验证。
 * 每种头部生成信息行（来源 public/Model_Center.html 各脚本生成器）：
 *   同一脚本两个不同时间戳 / 版本 => 归一化后相等；业务 SQL 有一处差异 => 不相等；CRLF / LF 混用 => 相等。
 * 变异：node scripts/verify-model-script-compare.js --module=<被改动的副本> 应判红。
 */

const path = require('path');

const moduleArg = process.argv.find(a => a.startsWith('--module='));
const modulePath = moduleArg
    ? path.resolve(moduleArg.slice('--module='.length))
    : path.join(__dirname, '..', 'routes', 'model-center', 'script-compare.js');
const { normalizeForCompare } = require(modulePath);

let checks = 0;
const failures = [];
function ok(cond, label) {
    checks++;
    if (!cond) { failures.push(label); console.log(`[FAIL] ${label}`); }
}

// 每种头部行：[名称, 来源, 生成函数(时间戳/版本参数) => 脚本全文]
const BODY = "IF OBJECT_ID('dbo.t', 'U') IS NOT NULL\n    DROP TABLE dbo.t;\nGO\nCREATE TABLE dbo.t (id INT);\n";
const SAMPLES = [
    ['创建日期（DWD/DIM ETL 头注释）', 'model-script-gen.js:generateDimDDLFromConfig/generateDimDDL/generateDwdDDL/generateCompanionDDL/generateDwdFullLoadScript/generateDwdIncrementalScript/generateDwdFdlScript/generateDwdQualityRules',
        d => `/*\n====\n  t - 全量初始化 ETL 脚本\n  创建日期: ${d}\n====\n*/\n${BODY}`, ['2026-09-30', '2026-10-01']],
    ['生成日期（DIM/DWD 尾部头注释）', 'model-script-gen.js:generateFullLoadScript/generateIncrementalScript/generateFdlNodeScript',
        d => `/*\n====\n  派生字段:\n    x\n\n  生成日期: ${d}\n  生成工具: 智数协同平台 - 模型中心\n====\n*/\n${BODY}`, ['2026-09-30', '2026-10-01']],
    ['生成时间（ODS DDL / 同步脚本）', 'model-script-gen.js:generateODSDDL/generateODSDDLWithColumns',
        d => `-- ============\n-- ODS 层 DDL 脚本 (SQL Server)\n-- 表名: t\n-- 源表: s\n-- 生成时间: ${d}\n-- ============\n${BODY}`, ['2026-09-30 08:00:00', '2026-10-01 17:45:09']],
    ['生成时间（无 -- 前缀的行）', 'script-compare.js 规则',
        d => `生成时间: ${d}\n${BODY}`, ['2026-09-30 08:00:00', '2026-10-01 17:45:09']],
    ['配置版本 vN（DWD 头注释）', 'model-script-gen.js:generateDwdDDL/generateDwdFullLoadScript/generateDwdIncrementalScript/generateDwdFdlScript/generateDwdQualityRules',
        v => `/*\n  t\n  创建日期: 2026-09-30\n  配置版本: ${v}\n*/\n${BODY}`, ['v1', 'v23']],
    ['配置版本 非 vN 形态', 'model-script-gen.js:generateDwdDDL 等（dwdConfig.version 任意值）',
        v => `/*\n  t\n  配置版本: ${v}\n*/\n${BODY}`, ['1.2', '2026-10 草稿']],
    ['最后同步（历史头部行）', '原规则保留',
        d => `/*\n  t\n  最后同步: ${d}\n*/\n${BODY}`, ['2026-09-30 08:00:00', '2026-10-01 09:00:00 by someone']]
];

for (const [name, src, gen, [a, b]] of SAMPLES) {
    const sa = gen(a);
    const sb = gen(b);
    ok(sa !== sb, `夹具自检 ${name}：两份原文确实不同`);
    ok(normalizeForCompare(sa) === normalizeForCompare(sb), `${name}（${src}）：不同时间戳 / 版本归一化后应相等`);
    // 业务 SQL 有一处差异 => 不相等
    const changed = sb.replace('id INT', 'id BIGINT');
    ok(changed !== sb, `夹具自检 ${name}：业务差异夹具确实改了`);
    ok(normalizeForCompare(sa) !== normalizeForCompare(changed), `${name}：业务 SQL 差异必须保持不相等`);
    // CRLF / LF 混用 => 相等
    const crlf = sa.replace(/\n/g, '\r\n');
    const mixed = sa.split('\n').map((l, i) => (i % 2 ? l + '\r' : l)).join('\n');
    ok(normalizeForCompare(sa) === normalizeForCompare(crlf), `${name}：CRLF 与 LF 归一化后应相等`);
    ok(normalizeForCompare(sa) === normalizeForCompare(mixed), `${name}：CRLF/LF 混用归一化后应相等`);
}

// 综合：一份脚本里所有头部行同时换时间戳
{
    const full = (d, t, v) => `/*\n  创建日期: ${d}\n  生成日期: ${d}\n  配置版本: ${v}\n*/\n-- 生成时间: ${t}\n${BODY}`;
    ok(normalizeForCompare(full('2026-09-30', '2026-09-30 08:00:00', 'v1')) === normalizeForCompare(full('2026-10-01', '2026-10-01 09:10:11', 'v7')),
        '综合：全部头部行同时变化仍相等');
}

// 不误剔业务 SQL：正文里出现类似字样（非行首标签）必须保留
{
    const a = `SELECT '生成时间: 固定文本A' AS c FROM t;\n`;
    const b = `SELECT '生成时间: 固定文本B' AS c FROM t;\n`;
    ok(normalizeForCompare(a) !== normalizeForCompare(b), '业务 SQL 字符串里的「生成时间:」不得被剔除');
    const c = `SELECT 配置版本 FROM cfg WHERE 配置版本 = 'v1';\n`;
    const d = `SELECT 配置版本 FROM cfg WHERE 配置版本 = 'v2';\n`;
    ok(normalizeForCompare(c) !== normalizeForCompare(d), '业务 SQL 里的「配置版本」列名引用不得被吞掉');
    // 预筛 LOW-c（2026-10-01）：标签出现在业务 SQL 字符串中间（非行首）时不得被剔除
    ok(normalizeForCompare(`UPDATE t SET remark='创建日期: 2026-01-01';\n`) !== normalizeForCompare(`UPDATE t SET remark='创建日期: 2026-02-01';\n`), '业务 SQL 字符串里的「创建日期:」不得被吞掉');
    ok(normalizeForCompare(`PRINT '最后同步: ' + CAST(@a AS varchar);\n`) !== normalizeForCompare(`PRINT '最后同步: ' + CAST(@b AS varchar);\n`), '业务 SQL 行中的「最后同步:」不得吞掉行尾差异');
    ok(normalizeForCompare(`SELECT '生成日期: 2026-01-01' AS x;\n`) !== normalizeForCompare(`SELECT '生成日期: 2026-02-01' AS x;\n`), '业务 SQL 字符串里的「生成日期:」不得被吞掉');
    // 预筛 LOW-b：小数形态的配置版本整行剔除（旧规则先删 vN 留下尾巴）
    ok(normalizeForCompare(`/*\n  配置版本: v3.1\n*/\nSELECT 1;`) === normalizeForCompare(`/*\n  配置版本: v3.2\n*/\nSELECT 1;`), '配置版本 v3.1 / v3.2 归一化后相等');
    ok(normalizeForCompare('  x  \r\n') === 'x', 'trim + CRLF 归一');
    ok(normalizeForCompare(null) === '' && normalizeForCompare(undefined) === '', '空入参安全');
}

if (failures.length) {
    console.log(`[FAIL] verify-model-script-compare：${failures.length} 条失败 / ${checks} 条断言；首条：${failures[0]}`);
    process.exit(1);
}
console.log(`[PASS] verify-model-script-compare：${checks} 条断言全绿（7 种头部行 × 时间戳变化 / 业务差异 / CRLF 混用 + 综合 + 防误剔）`);
