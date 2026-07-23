// H0 回归 - Part A：validateModelTableName 校验函数 + 四入口拒绝逻辑单元验证
// 方案 §0 回归面第 3 项（四入口负向）+ 第 5 项（合法边界）的纯函数层
// 运行：node scripts/verify-h0-tablename-validation.js

// 从 server.js 复制的被测逻辑（与 server.js 保持一致；改一处两处同步）
const MODEL_TABLE_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
function validateModelTableName(name) {
    return typeof name === 'string' && MODEL_TABLE_NAME_RE.test(name);
}
const SOURCE_TABLE_FORBIDDEN_RE = /['"`;\[\]]|--|[\x00-\x1F]/;
function validateSourceTable(name) {
    if (typeof name !== 'string' || !name) return { ok: false };
    if (SOURCE_TABLE_FORBIDDEN_RE.test(name)) return { ok: false };
    const parts = name.split('.');
    if (parts.length > 2) return { ok: false };
    const table = parts.length === 2 ? parts[1] : parts[0];
    const schema = parts.length === 2 ? parts[0] : null;
    if (!table || (schema !== null && !schema)) return { ok: false };
    if (parts.some(p => p.length > 128)) return { ok: false };
    return { ok: true, schema, table };
}
function quoteSqlServerIdent(schema, table) {
    const esc = s => s.replace(/\]/g, ']]');
    return schema ? `[${esc(schema)}].[${esc(table)}]` : `[${esc(table)}]`;
}
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function validateDimConfigShape(dimConfig) {
    if (dimConfig === undefined || dimConfig === null) return { ok: true };
    if (!isPlainObject(dimConfig)) return { ok: false };
    return { ok: true };
}
function validateChangeTableName(dimConfig) {
    const cts = [dimConfig?.dwdConfig?.changeTracking, dimConfig?.changeTracking];
    for (const ct of cts) {
        if (!isPlainObject(ct)) continue;
        const name = ct.changeTableName;
        if (name && !validateModelTableName(name)) return { ok: false };
    }
    return { ok: true };
}

let pass = 0, fail = 0;
function check(desc, actual, expected) {
    if (actual === expected) { pass++; }
    else { fail++; console.log(`  ✗ ${desc}: 期望 ${expected} 实得 ${actual}`); }
}

console.log('=== 合法边界（§0 回归第 5 项，必须全 true）===');
const LEGAL = [
    'ods_customer_visit_record_df',
    'dwd_customer_visit_df',
    'dim_official_customer',
    'dwd_customer_visit_record_detail_df',   // 长名
    'a',                                      // 单字母
    'A123',                                   // 大写+数字
    'x_1_2_3',                                // 多下划线
    'ods_hrd_person_profile_df',
];
LEGAL.forEach(n => check(`合法 ${n}`, validateModelTableName(n), true));

console.log('=== 注入/非法（§0 回归第 3 项，必须全 false）===');
const ILLEGAL = [
    "x'; DROP TABLE data_models;--",   // 经典注入
    "dbo.tbl",                          // 点号（schema 由连接提供，表名本体不含点）
    "tbl name",                         // 空格
    "tbl;select",                       // 分号
    "1tbl",                             // 数字开头
    "_tbl",                             // 下划线开头
    "tbl-df",                           // 连字符
    "表名",                             // 中文
    "tbl()",                            // 括号
    "",                                 // 空串
    "  ",                               // 纯空白
    "tbl\n",                            // 换行
    "OBJECT_ID('x')",                   // 含引号括号
];
ILLEGAL.forEach(n => check(`非法 ${JSON.stringify(n)}`, validateModelTableName(n), false));

console.log('=== 类型防御（非字符串必 false）===');
[null, undefined, 123, {}, [], true].forEach(v =>
    check(`非字符串 ${JSON.stringify(v)}`, validateModelTableName(v), false));

// ===== source_table 校验（黑名单口径：放行中文，拦注入元字符）=====
console.log('=== source_table 合法（含中文源表名，必须全 ok=true）===');
const SRC_LEGAL = [
    'ods_contract_df',
    'dbo.ods_contract_df',          // 含 schema
    '不计入报表主体',                // 生产真实中文源表（模型81）
    '内部交易客户',                  // 生产真实中文源表（模型102）
    'BMS.内部交易客户',              // 中文 + schema
    'tbl_中英文mix_2024',
];
SRC_LEGAL.forEach(n => check(`source合法 ${n}`, validateSourceTable(n).ok, true));

console.log('=== source_table 非法（注入元字符，必须全 ok=false）===');
const SRC_ILLEGAL = [
    "real; DROP TABLE t;--",         // 分号+注释
    "real'; DROP--",                 // 引号
    "t]; DROP TABLE x; --[",         // 方括号闭合逃逸
    "a.b.c",                         // 三段
    "a.",                            // 空段
    ".b",                            // 空段
    'tbl`x',                         // 反引号
    "tbl\tx",                        // 控制字符
    "",                              // 空串
];
SRC_ILLEGAL.forEach(n => check(`source非法 ${JSON.stringify(n)}`, validateSourceTable(n).ok, false));

console.log('=== SQL Server 分隔标识符 ]]转义 ===');
check("中文表名括号引用", quoteSqlServerIdent('dbo', '内部交易客户'), '[dbo].[内部交易客户]');
check("无 schema 引用", quoteSqlServerIdent(null, 'ods_x'), '[ods_x]');
// 防御：即便含 ] 也被转义（虽然校验会先拦，双保险）
check("] 转义为 ]]", quoteSqlServerIdent(null, 'a]b'), '[a]]b]');

// ===== M1（复审）：changeTableName 类型绕过——enabled 任意值下非空非法名都必须拦 =====
console.log('=== changeTableName 校验（不依赖 enabled，防 "true"/1/{} 绕过）===');
const injCt = "x; DROP TABLE important;--";
// 各种 enabled 值 + 非法 changeTableName，全部必须 ok=false
[true, "true", 1, {}, "yes", null, undefined].forEach(en => {
    const dc = { dwdConfig: { changeTracking: { enabled: en, changeTableName: injCt } } };
    check(`enabled=${JSON.stringify(en)} + 非法名 → 拦截`, validateChangeTableName(dc).ok, false);
});
// 合法 changeTableName 放行
check('合法 changeTableName 放行', validateChangeTableName({ dwdConfig: { changeTracking: { enabled: true, changeTableName: 'dwd_x_change_di' } } }).ok, true);
// 无 changeTracking / 无 changeTableName 放行
check('无 changeTracking 放行', validateChangeTableName({ dwdConfig: {} }).ok, true);
check('changeTableName 空 放行', validateChangeTableName({ dwdConfig: { changeTracking: { enabled: true } } }).ok, true);
// 顶层 changeTracking（非 dwdConfig 包裹）也覆盖
check('顶层 changeTracking 非法名拦截', validateChangeTableName({ changeTracking: { enabled: false, changeTableName: injCt } }).ok, false);

// ===== M1（三审）：dim_config 类型守卫 + 双写 + 字符串化绕过 =====
console.log('=== dim_config 类型守卫（字符串化 dim_config 必拦）===');
const injCfgStr = JSON.stringify({ dwdConfig: { changeTracking: { enabled: 'true', changeTableName: injCt } } });
check('字符串化 dim_config → shape 拦截', validateDimConfigShape(injCfgStr).ok, false);
check('数组 dim_config → shape 拦截', validateDimConfigShape([]).ok, false);
check('对象 dim_config → shape 放行', validateDimConfigShape({ dwdConfig: {} }).ok, true);
check('undefined dim_config → shape 放行', validateDimConfigShape(undefined).ok, true);
console.log('=== 双写位置都校验（三审 LOW）===');
// 顶层合法但 dwdConfig 内非法 → 拦
check('dwdConfig 内非法（顶层空）→ 拦', validateChangeTableName({ dwdConfig: { changeTracking: { changeTableName: injCt } } }).ok, false);
// 顶层非法但 dwdConfig 内合法 → 也要拦（|| 只选一个会漏）
check('顶层非法（dwdConfig 合法）→ 拦', validateChangeTableName({ dwdConfig: { changeTracking: { changeTableName: 'dwd_ok_di' } }, changeTracking: { changeTableName: injCt } }).ok, false);

// ===== L1（复审）：source_table 分段 128 =====
console.log('=== source_table 分段 128 上限 ===');
check('129 字符 schema 段 → 拦截', validateSourceTable('a'.repeat(129) + '.tbl').ok, false);
check('128 字符 table 段 → 放行', validateSourceTable('a'.repeat(128)).ok, true);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
