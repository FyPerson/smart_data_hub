/**
 * 模型中心 C2 · normalize 适配层 独立验证（2026-07-24）
 *
 * 用法：node scripts/verify-model-drawer-normalize.js
 * 规格：模型详情抽屉方案 v1.4 §5.1（DTO/6 fixtures/断言通则）+ §5.1a（ODS 类型格式化）
 * 断言通则：预期字段数>0 时才断言首字段；预期=0 时断言空数组（审 03 修正）。
 * fixtures：scripts/fixtures/model-drawer/*.json（本地库真实快照+两个派生构造，_note 说明来源）。
 *   方案 fixture1 原锚生产模型 85（29 字段）——生产访问受限改本地 #52 同形态快照，断言按样本实际值。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const kit = require('../public/assets/js/model-detail-normalize.js');

let pass = 0, fail = 0;
function expect(cond, msg, detail) {
    if (cond) { console.log(`  ✓ ${msg}`); pass++; }
    else { console.log(`  ✗ ${msg}${detail !== undefined ? '  got=' + JSON.stringify(detail) : ''}`); fail++; }
}

const FIX_DIR = path.join(__dirname, 'fixtures', 'model-drawer');
function loadFixture(name) {
    return JSON.parse(fs.readFileSync(path.join(FIX_DIR, name), 'utf8')).model;
}

console.log('=== C2 normalize 适配层验证 ===\n');

// ---------- fixture 1：DWD 标准（#52 快照：selectedFields=100 + derivedFields=8） ----------
console.log('F1. DWD 标准');
{
    const d = kit.normalizeModelDetail(loadFixture('01-dwd-standard.json'));
    expect(d.kind === 'dwd', 'kind=dwd', d.kind);
    expect(d.fields.length === 108, 'fields 数量=108（100 selected + 8 derived）', d.fields.length);
    expect(!!(d.fields[0].name && d.fields[0].type), '首字段 name/type 非空', d.fields[0]);
    expect(d.fields[0].name === 'contract_id' && d.fields[0].source === 'ContractID', '首字段映射 targetField/srcField', d.fields[0]);
    expect(d.fields[0].isPk === true, '首字段 contract_id 命中 primaryKeys', d.fields[0].isPk);
    expect(d.fields.filter(f => f.isPk).length === 1, '主键仅 1 个（dwdConfig.primaryKeys=[contract_id]）');
    expect(d.fields.filter(f => f.isDerived).length === 8, '派生字段 8 个 isDerived=true');
    expect(d.warnings.length === 0, 'warnings=[]', d.warnings);
    expect(d.sources.length > 0 && d.sources[0].isPrimary && d.sources[0].name === 'ods_contract_df', 'sources 主表=ods_contract_df', d.sources[0]);
    expect(d.sources.some(s => !s.isPrimary && s.joinType && s.joinCondition), '非主表带 joinType/joinCondition');
    expect(d.logic !== null && d.logic.grain === '一行一份合同', 'logic.grain=dataGranularity', d.logic && d.logic.grain);
    expect(d.logic.filterCondition === null, 'filterCondition 空串→null', d.logic.filterCondition);
    expect(d.logic.advancedSql !== null && typeof d.logic.advancedSql === 'object' && 'applyContent' in d.logic.advancedSql, 'advancedSql 原始结构对象透传');
    expect(d.scd === null, 'DWD 无 scd 块', d.scd);
    expect(d.parent === null, 'DWD 无 parent 块', d.parent);
    expect(d.dwdMeta !== null && d.dwdMeta.updateStrategy === 'FULL_OVERWRITE', 'dwdMeta.updateStrategy=FULL_OVERWRITE（C4 审 M-1）', d.dwdMeta);
    expect(d.dwdMeta.hashEnabled === true, 'dwdMeta.hashEnabled=true（hashConfig.enabled）', d.dwdMeta);
    expect(d.identity.id === 52 && d.identity.tableName === 'dwd_contract_header_df' && d.identity.layer === 'DWD', 'identity 基础字段', d.identity);
}

// ---------- fixture 2：DIM fieldMappings 形态（#50：fieldMappings=41 + scdConfig.derivedFields=9） ----------
console.log('F2. DIM fieldMappings');
{
    const d = kit.normalizeModelDetail(loadFixture('02-dim-fieldmappings.json'));
    expect(d.kind === 'dim', 'kind=dim', d.kind);
    expect(d.fields.length > 0, 'fields 数量>0', d.fields.length);
    expect(d.fields.length === 50, 'fields=50（41 mappings + 9 derived，无重名）', d.fields.length);
    expect(!!(d.fields[0].name && d.fields[0].type), '首字段 name/type 非空', d.fields[0]);
    const pkField = d.fields.find(f => f.isPk);
    expect(!!pkField && pkField.source === 'OfficialCustomerID', 'businessKey(源字段名)双路匹配命中 isPk', pkField && pkField.source);
    expect(d.scd !== null && d.scd.scdType === 'HYBRID' && d.scd.businessKey === 'OfficialCustomerID', 'scd 块 scdType/businessKey', d.scd);
    expect(d.dwdMeta === null, 'DIM 无 dwdMeta（仅 dwd）', d.dwdMeta);
    expect(d.scd.trackFieldCount === 41, 'trackFieldCount=41（去重后 isDerived=false 数量）', d.scd.trackFieldCount);
    expect(d.fields.filter(f => f.isDerived).length === 9, 'scdConfig.derivedFields 9 个合入');
    expect(d.warnings.length === 0, 'warnings=[]', d.warnings);
}

// ---------- fixture 3：DIM trackFields 旧形态（#50 派生：仅 trackFields=41 纯字段名） ----------
console.log('F3. DIM trackFields 旧形态');
{
    const d = kit.normalizeModelDetail(loadFixture('03-dim-trackfields-legacy.json'));
    expect(d.kind === 'dim', 'kind=dim', d.kind);
    expect(d.fields.length === 41, 'fields=41（回落 trackFields）', d.fields.length);
    expect(!!d.fields[0].name, '首字段 name 非空（type 允许空——旧数据仅字段名）', d.fields[0]);
    expect(d.fields[0].type === '', '首字段 type 为空串', d.fields[0].type);
    const pkLegacy = d.fields.find(f => f.isPk);
    expect(!!pkLegacy && pkLegacy.name === 'OfficialCustomerID', '旧形态 businessKey 按原名命中 isPk', pkLegacy && pkLegacy.name);
    expect(d.warnings.length === 0, 'warnings=[]', d.warnings);
}

// ---------- fixture 4：custom（#58：config_mode=custom，不解析字段） ----------
console.log('F4. custom');
{
    const d = kit.normalizeModelDetail(loadFixture('04-custom.json'));
    expect(d.kind === 'custom', 'kind=custom', d.kind);
    expect(Array.isArray(d.fields) && d.fields.length === 0, 'fields 空数组（不解析）', d.fields.length);
    expect(d.warnings.length === 0, 'warnings=[]（不解析≠异常）', d.warnings);
}

// ---------- fixture 5：companion（#53：companion_of=52） ----------
console.log('F5. companion');
{
    const d = kit.normalizeModelDetail(loadFixture('05-companion.json'));
    expect(d.kind === 'companion', 'kind=companion', d.kind);
    expect(Array.isArray(d.fields) && d.fields.length === 0, 'fields 空数组（不解析）', d.fields.length);
    expect(d.parent !== null && d.parent.parentModelId === 52 && d.parent.parentTableName === 'dwd_contract_header_df', 'parent 块非空且指向主模型', d.parent);
    expect(d.warnings.length === 0, 'warnings=[]', d.warnings);
}

// ---------- fixture 6：dim_config=null（#52 派生：DWD 层无配置） ----------
console.log('F6. dim_config=null');
{
    const d = kit.normalizeModelDetail(loadFixture('06-null-config.json'));
    expect(d.kind === 'dwd', 'kind=dwd（按 layer）', d.kind);
    expect(Array.isArray(d.fields) && d.fields.length === 0, 'fields 空数组', d.fields.length);
    expect(d.warnings.length === 1 && d.warnings[0] === 'CONFIG_UNPARSEABLE_OR_MISSING', "warnings=['CONFIG_UNPARSEABLE_OR_MISSING']", d.warnings);
    expect(d.identity.tableName === 'dwd_contract_header_df', 'identity 主体仍可显示（配置缺失不影响 identity+足迹）', d.identity.tableName);
}

// ---------- 补充：kind 判定边界 + dim_config 类型守卫 ----------
console.log('B. 边界用例');
{
    // 字符串化 dim_config（H0 M1 三层绕过形态）→ 视为不可解析
    const strCfg = loadFixture('01-dwd-standard.json');
    strCfg.dim_config = JSON.stringify(strCfg.dim_config);
    const d1 = kit.normalizeModelDetail(strCfg);
    expect(d1.fields.length === 0 && d1.warnings.includes('CONFIG_UNPARSEABLE_OR_MISSING'), '字符串化 dim_config→CONFIG warning（类型守卫）', d1.warnings);

    // generic：DWS 层
    const d2 = kit.normalizeModelDetail({ id: 999, table_name: 'dws_x', layer: 'dws', config_mode: 'standard', dim_config: null });
    expect(d2.kind === 'generic', 'DWS 层→generic', d2.kind);
    expect(d2.warnings.length === 0, 'generic 不报 CONFIG warning', d2.warnings);

    // companion 优先级最高（即使 config_mode=custom）
    const d3 = kit.normalizeModelDetail({ id: 998, table_name: 't', layer: 'dwd', config_mode: 'custom', companion_of: 52, dim_config: null });
    expect(d3.kind === 'companion', 'companion 优先于 custom', d3.kind);

    // ODS：无 metadata → METADATA_UNAVAILABLE
    const odsModel = { id: 997, table_name: 'ods_t', layer: 'ods', config_mode: 'standard', dim_config: null };
    const d4 = kit.normalizeModelDetail(odsModel);
    expect(d4.kind === 'ods' && d4.warnings.length === 1 && d4.warnings[0] === 'METADATA_UNAVAILABLE', 'ODS 无 metadata→METADATA_UNAVAILABLE', d4.warnings);

    // ODS：columns=[] → FIELDS_EMPTY
    const d5 = kit.normalizeModelDetail(odsModel, { metadata: { columns: [], primaryKeys: [] } });
    expect(d5.warnings.length === 1 && d5.warnings[0] === 'FIELDS_EMPTY', 'ODS columns=[]→FIELDS_EMPTY', d5.warnings);

    // ODS：正常 columns + 主键匹配
    const d6 = kit.normalizeModelDetail(odsModel, { metadata: {
        columns: [
            { column_name: 'ID', data_type: 'int', is_nullable: 'NO', max_length: 4, precision: 10, scale: 0 },
            { column_name: 'Name', data_type: 'nvarchar', is_nullable: 'YES', max_length: 100, precision: 0, scale: 0 }
        ],
        primaryKeys: ['ID']
    } });
    expect(d6.fields.length === 2 && d6.fields[0].isPk === true && d6.fields[1].isPk === false, 'ODS columns 映射+主键命中', d6.fields.map(f => f.isPk));
    expect(d6.fields[0].comment === '' && d6.fields[0].addedAt === null, 'ODS comment 恒空+addedAt 恒无（D4）');
}

// ---------- C2 审 M-1/M-2/L-2 边界补充（内联小 fixture） ----------
console.log('E. 审后边界（数值字符串/空字段名/双键/畸形 metadata）');
{
    const f = kit.formatOdsType;
    // M-1：字符串数值归一化
    expect(f({ data_type: 'nvarchar', max_length: '100' }) === 'nvarchar(50)', '字符串 "100" 归一化 ÷2', f({ data_type: 'nvarchar', max_length: '100' }));
    expect(f({ data_type: 'varchar', max_length: '-1' }) === 'varchar(MAX)', '字符串 "-1"→MAX');
    expect(f({ data_type: 'decimal', precision: '18', scale: '2' }) === 'decimal(18, 2)', '字符串 precision/scale');
    expect(f({ data_type: 'nvarchar', max_length: 'abc' }) === 'nvarchar', '非数字串按缺失→裸类型');

    // M-2：空字段名过滤（DWD）
    const dwdEmptyName = {
        id: 900, table_name: 'dwd_t', layer: 'dwd', config_mode: 'standard',
        dim_config: { dwdConfig: { primaryKeys: ['a'] }, selectedFields: [
            { srcField: 'A', targetField: 'a', dataType: 'int', comment: '' },
            { srcField: 'B', targetField: '', dataType: 'int', comment: '' },   // 空 targetField
            { srcField: '', targetField: null, dataType: 'int', comment: '' }   // null targetField
        ], derivedFields: [] }
    };
    const dE = kit.normalizeModelDetail(dwdEmptyName);
    expect(dE.fields.length === 1 && dE.fields[0].name === 'a', 'DWD 空 name 行被过滤', dE.fields.length);
    // M-2：全空名 → FIELDS_EMPTY
    dwdEmptyName.dim_config.selectedFields = [{ srcField: 'X', targetField: '', dataType: 'int' }];
    const dE2 = kit.normalizeModelDetail(dwdEmptyName);
    expect(dE2.fields.length === 0 && dE2.warnings.includes('FIELDS_EMPTY'), '过滤后 0 字段→FIELDS_EMPTY', dE2.warnings);
    // M-2：ODS 空 column_name 过滤
    const dE3 = kit.normalizeModelDetail(
        { id: 901, table_name: 'ods_t', layer: 'ods', config_mode: 'standard', dim_config: null },
        { metadata: { columns: [{ column_name: '', data_type: 'int' }, { column_name: 'ok', data_type: 'int' }], primaryKeys: [] } });
    expect(dE3.fields.length === 1 && dE3.fields[0].name === 'ok', 'ODS 空 column_name 被过滤', dE3.fields.length);

    // L-2：DIM sourceField（旧键）单独可用
    const dimOldKey = {
        id: 902, table_name: 'dim_t', layer: 'dim', config_mode: 'standard',
        dim_config: { scdConfig: { scdType: 'SCD1', businessKey: 'K1', trackFields: [],
            fieldMappings: [{ sourceField: 'K1', targetField: 'k1', dataType: 'int', comment: '' }] } }
    };
    const dOld = kit.normalizeModelDetail(dimOldKey);
    expect(dOld.fields.length === 1 && dOld.fields[0].source === 'K1' && dOld.fields[0].isPk === true, 'sourceField 旧键兼容+isPk 命中', dOld.fields[0]);

    // L-2：metadata 外层形态异常（metadata.metadata 缺失/非对象）→ METADATA_UNAVAILABLE
    const odsM = { id: 903, table_name: 'ods_m', layer: 'ods', config_mode: 'standard', dim_config: null };
    expect(kit.normalizeModelDetail(odsM, {}).warnings[0] === 'METADATA_UNAVAILABLE', 'metadata.metadata 缺失→UNAVAILABLE');
    expect(kit.normalizeModelDetail(odsM, { metadata: 'broken' }).warnings[0] === 'METADATA_UNAVAILABLE', 'metadata.metadata 非对象→UNAVAILABLE');
    expect(kit.normalizeModelDetail(odsM, { metadata: { columns: 'broken' } }).warnings[0] === 'METADATA_UNAVAILABLE', 'columns 非数组→UNAVAILABLE');
}

// ---------- §5.1a ODS 类型格式化规则 ----------
console.log('T. formatOdsType（§5.1a）');
{
    const f = kit.formatOdsType;
    expect(f({ data_type: 'nvarchar', max_length: 100 }) === 'nvarchar(50)', 'nvarchar 字节数÷2', f({ data_type: 'nvarchar', max_length: 100 }));
    expect(f({ data_type: 'nvarchar', max_length: -1 }) === 'nvarchar(MAX)', 'nvarchar -1→MAX');
    expect(f({ data_type: 'nchar', max_length: 20 }) === 'nchar(10)', 'nchar ÷2');
    expect(f({ data_type: 'varchar', max_length: 64 }) === 'varchar(64)', 'varchar 原值');
    expect(f({ data_type: 'varchar', max_length: -1 }) === 'varchar(MAX)', 'varchar -1→MAX');
    expect(f({ data_type: 'char', max_length: 2 }) === 'char(2)', 'char 原值');
    expect(f({ data_type: 'varbinary', max_length: -1 }) === 'varbinary(MAX)', 'varbinary -1→MAX');
    expect(f({ data_type: 'decimal', precision: 18, scale: 2 }) === 'decimal(18, 2)', 'decimal (p,s)');
    expect(f({ data_type: 'numeric', precision: 10, scale: 0 }) === 'numeric(10, 0)', 'numeric (p,0)');
    expect(f({ data_type: 'int', max_length: 4 }) === 'int', 'int 裸类型不附长度');
    expect(f({ data_type: 'datetime', max_length: 8 }) === 'datetime', 'datetime 裸类型');
    expect(f({ data_type: 'bit', max_length: 1 }) === 'bit', 'bit 裸类型');
}

// ---------- C6：贴源标识（identity.sourceSystem/sourceTable）+ ODS 近似行数 ----------
console.log('U. C6 贴源标识 + 行数（identity/odsMeta）');
{
    const odsBase = { id: 910, table_name: 'ods_crm_bid_df', layer: 'ods', config_mode: 'standard', dim_config: null };
    const cols = { metadata: { columns: [{ column_name: 'a', data_type: 'int' }], primaryKeys: [] } };

    // 贴源两字段：有值 / 空串归一 null / 缺失归一 null（三态一致，视图统一显示「—」）
    const dS1 = kit.normalizeModelDetail(Object.assign({}, odsBase, { source_system: 'BMS', source_table: 'crm_bid' }), cols);
    expect(dS1.identity.sourceSystem === 'BMS' && dS1.identity.sourceTable === 'crm_bid', 'C6 source_system/source_table 透传', [dS1.identity.sourceSystem, dS1.identity.sourceTable]);
    const dS2 = kit.normalizeModelDetail(Object.assign({}, odsBase, { source_system: '  ', source_table: '' }), cols);
    expect(dS2.identity.sourceSystem === null && dS2.identity.sourceTable === null, 'C6 空串/空白→null', [dS2.identity.sourceSystem, dS2.identity.sourceTable]);
    expect(kit.normalizeModelDetail(odsBase, cols).identity.sourceSystem === null, 'C6 字段缺失→null');
    // 中文源表名（server.js:96 明确允许非 ASCII，如 BMS「内部交易客户」表）不被误伤
    expect(kit.normalizeModelDetail(Object.assign({}, odsBase, { source_table: '内部交易客户' }), cols).identity.sourceTable === '内部交易客户', 'C6 中文源表名保留');
    // 非 ODS 也解析（DIM/DWD 生产虽普遍为空，normalize 不做 kind 门槛——渲染层决定是否显示）
    const dwdS = kit.normalizeModelDetail({ id: 911, table_name: 'dwd_t', layer: 'dwd', config_mode: 'standard', source_system: 'BMS', dim_config: { selectedFields: [{ targetField: 'x', dataType: 'int' }] } });
    expect(dwdS.identity.sourceSystem === 'BMS', 'C6 非 ODS kind 同样解析贴源字段');

    // odsMeta.rowCount：数值 / 字符串数值 / 0 / 缺失 / 非法 / 负数
    const rc = (v) => kit.normalizeModelDetail(odsBase, { metadata: { columns: cols.metadata.columns, primaryKeys: [], rowCount: v } }).odsMeta.rowCount;
    expect(rc(37469123) === 37469123, 'C6 rowCount 数值透传', rc(37469123));
    expect(rc('37469123') === 37469123, 'C6 rowCount 数字串归一（mssql SUM(bigint) 可能回 string）', rc('37469123'));
    expect(rc(0) === 0, 'C6 rowCount=0 保留（空表 ≠ 未知）', rc(0));
    expect(rc(undefined) === null, 'C6 rowCount 缺失→null');
    expect(rc('broken') === null, 'C6 rowCount 非法→null');
    expect(rc(-5) === null, 'C6 rowCount 负数→null（脏值不显示）', rc(-5));
    // 审 12（grok/gpt 双方 LOW）：超安全整数不得静默舍入成「看似精确的错数」
    expect(rc('9'.repeat(21)) === null, 'C6 rowCount 极大整数串→null（不显示 1e21 行）', rc('9'.repeat(21)));
    expect(rc(9007199254740993) === null, 'C6 rowCount 超 2^53→null', rc(9007199254740993));
    expect(rc(9007199254740991) === 9007199254740991, 'C6 rowCount 恰为 MAX_SAFE 保留（边界内）', rc(9007199254740991));
    expect(rc('123.7') === null, 'C6 rowCount 小数串→null（toFiniteInt 只收纯整数串）', rc('123.7'));
    // number 型小数沿用 toFiniteInt 既有 Math.trunc 语义（不为 rowCount 单开一套规则）：
    // SUM(bigint) 本就必为整数，且行数已标注「近似」，截断无实际影响；字符串小数则由正则挡在门外（上一条）
    expect(rc(37469123.5) === 37469123, 'C6 rowCount number 型小数按既有语义截断', rc(37469123.5));
    // 行数缺失不得污染字段区语义：仍应正常出字段、不产生 warning
    const dNoRc = kit.normalizeModelDetail(odsBase, cols);
    expect(dNoRc.odsMeta.rowCount === null && dNoRc.fields.length === 1 && dNoRc.warnings.length === 0, 'C6 行数缺失不影响字段区/不加 warning', dNoRc.warnings);
    // metadata 完全不可用时 odsMeta 仍成型（视图直接读 .rowCount 不炸）
    const dUnavail = kit.normalizeModelDetail(odsBase);
    expect(dUnavail.odsMeta && dUnavail.odsMeta.rowCount === null, 'C6 metadata 不可用时 odsMeta 仍成型', dUnavail.odsMeta);
    // 非 ODS kind 不产生 odsMeta（视图层 kind 分支据此不渲染行数行）
    expect(dwdS.odsMeta === null, 'C6 非 ODS kind odsMeta 恒 null');
}

// ---------- C8：高级 SQL 分段（sqlParts）+ DIM SCD 加厚 ----------
console.log('V. C8 sqlParts（三种生产形态）');
{
    const mk = (adv) => kit.normalizeModelDetail({
        id: 920, table_name: 'dim_t', layer: 'dim', config_mode: 'standard',
        dim_config: { scdConfig: { scdType: 'SCD1', businessKey: 'K', fieldMappings: [{ targetField: 'k', dataType: 'int' }] }, advancedSql: adv }
    }).logic;

    // 形态① type=CTE 仅 cteContent —— 旧实现只读 applyContent 会整段丢失（dim_org 432 字符递归 CTE）
    const cteOnly = mk({ type: 'CTE', types: ['CTE'], applyContent: '', cteContent: 'org_tree AS (SELECT 1)' });
    expect(cteOnly.sqlParts.length === 1 && cteOnly.sqlParts[0].kind === 'CTE', 'C8 type=CTE 仅 cteContent → 1 段 CTE', cteOnly.sqlParts);
    expect(cteOnly.sqlParts[0].content === 'org_tree AS (SELECT 1)', 'C8 CTE 内容透传');

    // 形态② type=APPLY 但 applyContent 与 cteContent 并存（dim_official_customer 真实形态）
    const both = mk({ type: 'APPLY', types: ['APPLY', 'CTE'], applyContent: 'OUTER APPLY (SELECT 1) x', cteContent: 'c AS (SELECT 2)' });
    expect(both.sqlParts.length === 2, 'C8 APPLY+CTE 并存 → 2 段（旧实现丢 CTE 段）', both.sqlParts.map(p => p.kind));
    expect(both.sqlParts[0].kind === 'CTE' && both.sqlParts[1].kind === 'APPLY', 'C8 顺序 CTE→APPLY（对齐 SQL 阅读顺序）', both.sqlParts.map(p => p.kind));

    // 形态③ type=NONE 显式关闭：即使残留 content 也不展示
    const none = mk({ type: 'NONE', types: [], applyContent: '残留', cteContent: '残留' });
    expect(none.sqlParts.length === 0, 'C8 type=NONE → 不展示（尊重开关，即使残留内容）', none.sqlParts);

    // 边界：无 advancedSql / 非对象 —— logic 整体为 null 是既有语义（视图层 mdcRenderLogicSection 已有 logic && 守卫）
    expect(mk(null) === null, 'C8 无任何逻辑内容 → logic 整体 null（既有语义未变）', mk(null));
    expect(mk('broken') === null, 'C8 advancedSql 非对象且无其他逻辑 → logic null');
    // 有 filterCondition 撑起 logic 时，单独验 sqlParts 的空值行为
    const withFilter = (adv) => kit.normalizeModelDetail({
        id: 923, table_name: 'dwd_t', layer: 'dwd', config_mode: 'standard',
        dim_config: { dwdConfig: { filterCondition: 'a=1' }, selectedFields: [{ targetField: 'a', dataType: 'int' }], advancedSql: adv }
    }).logic;
    expect(withFilter(null).sqlParts.length === 0, 'C8 logic 存在但无 advancedSql → sqlParts 空数组（非 undefined）', withFilter(null).sqlParts);
    expect(withFilter('broken').sqlParts.length === 0, 'C8 advancedSql 非对象 → sqlParts 空数组');
    expect(withFilter({ type: 'CTE', cteContent: '   ' }).sqlParts.length === 0, 'C8 内容全空白 → 空数组（normStr 归一）');
    expect(withFilter({ types: ['CTE'], cteContent: 'x AS (1)' }).sqlParts.length === 1, 'C8 缺 type 但有内容 → 仍展示（不依赖 types 数组）');
    // description 透传
    expect(mk({ type: 'CTE', cteContent: 'a', description: '递归构建路径' }).sqlDescription === '递归构建路径', 'C8 sqlDescription 透传');
    // 审 16 M-1：type=NONE 时 description 必须一起隐藏。构造「有 filterCondition 撑起 logic 段」的场景，
    // 否则 logic 整体为 null 测不出泄漏。
    const noneWithDesc = kit.normalizeModelDetail({
        id: 924, table_name: 'dwd_t', layer: 'dwd', config_mode: 'standard',
        dim_config: {
            dwdConfig: { filterCondition: 'a=1' }, selectedFields: [{ targetField: 'a', dataType: 'int' }],
            advancedSql: { type: 'NONE', types: [], applyContent: '残留', cteContent: '残留', description: '已关闭却残留的说明' }
        }
    }).logic;
    expect(noneWithDesc !== null && noneWithDesc.sqlParts.length === 0, 'C8 NONE+filter：logic 存在但 sqlParts 空', noneWithDesc && noneWithDesc.sqlParts);
    expect(noneWithDesc.sqlDescription === null, '审16 M-1 type=NONE 时 sqlDescription 一并隐藏（不泄漏已关闭功能的说明）', noneWithDesc.sqlDescription);
    // 反向：有内容时 description 正常跟随
    const activeWithDesc = kit.normalizeModelDetail({
        id: 925, table_name: 'dwd_t', layer: 'dwd', config_mode: 'standard',
        dim_config: {
            dwdConfig: { filterCondition: 'a=1' }, selectedFields: [{ targetField: 'a', dataType: 'int' }],
            advancedSql: { type: 'CTE', cteContent: 'x AS (1)', description: '说明' }
        }
    }).logic;
    expect(activeWithDesc.sqlDescription === '说明', 'C8 有 SQL 段时 description 正常显示（未误伤）');
    // 审 17 L：raw advancedSql 在 type=NONE 时仍透传是既有契约（审 03 H-02.1）。
    // 钉死语义：判断「高级 SQL 是否启用」一律用 sqlParts.length，不得用 logic.advancedSql 是否存在。
    expect(noneWithDesc.advancedSql !== null, '审17 L type=NONE 时 raw advancedSql 仍透传（既有契约）');
    expect(noneWithDesc.advancedSql.applyContent === '残留' && noneWithDesc.sqlParts.length === 0,
        '审17 L raw 里残留内容 ≠ 启用：启用判据只认 sqlParts.length', { raw: !!noneWithDesc.advancedSql.applyContent, parts: noneWithDesc.sqlParts.length });
}

console.log('W. C8 DIM SCD 加厚（options/monitoredFields/versionKey）');
{
    const mkScd = (scdExtra) => kit.normalizeModelDetail({
        id: 921, table_name: 'dim_t', layer: 'dim', config_mode: 'standard',
        dim_config: { scdConfig: Object.assign({ scdType: 'SCD1', businessKey: 'OrgID', fieldMappings: [{ targetField: 'org_id', dataType: 'int' }] }, scdExtra) }
    }).scd;

    // dim_org 真实形态
    const org = mkScd({
        monitoredFields: ['org_name', 'parent_id', ''],
        options: { etlStrategy: 'TRUNCATE_INSERT', schedule: 'T+1 每日', auditTable: 'dw_audit_log', description: 'SCD1全量覆盖', deleteDetection: false, modifyDetection: true, consistencyAlert: false, auditLog: true }
    });
    expect(org.etlStrategy === 'TRUNCATE_INSERT' && org.schedule === 'T+1 每日', 'C8 etlStrategy/schedule 抽取', [org.etlStrategy, org.schedule]);
    expect(org.monitoredFields.length === 2, 'C8 monitoredFields 过滤空串', org.monitoredFields);
    expect(org.flags.modifyDetection === true && org.flags.deleteDetection === false, 'C8 四开关按 === true 判定', org.flags);
    expect(org.auditTable === 'dw_audit_log' && org.description === 'SCD1全量覆盖', 'C8 auditTable/description 抽取');

    // dim_official_customer 真实形态
    const cust = mkScd({
        versionKey: 'ChangeID',
        options: { stateFilter: 'c.State = 3', effDtExpr: 'COALESCE(CAST(x AS DATE), y)', additionalIndexes: [1, 2, 3, 4, 5], consistencyAlert: true }
    });
    expect(cust.versionKey === 'ChangeID', 'C8 versionKey 抽取', cust.versionKey);
    expect(cust.stateFilter === 'c.State = 3' && /COALESCE/.test(cust.effDtExpr), 'C8 stateFilter/effDtExpr 抽取');
    expect(cust.indexCount === 5, 'C8 additionalIndexes 计数', cust.indexCount);

    // 缺 options 时不炸、字段归一为 null/空
    const bare = mkScd({});
    expect(bare.etlStrategy === null && bare.indexCount === 0 && bare.monitoredFields.length === 0, 'C8 无 options → 全部安全默认值', bare);

    // 审 17 M-1：auditLog 表单默认勾选，故「缺失」必须补成 true，否则裸配置 DIM 会被误判成「显式关闭」
    // 而渲染出空壳 SCD 段（与 C8 M-2 的修复意图相反）。四种门槛形态逐一钉死：
    const FLAG_DEFAULTS = { deleteDetection: false, modifyDetection: false, consistencyAlert: false, auditLog: true };
    const deviates = (flags) => Object.keys(FLAG_DEFAULTS).some(k => flags[k] !== FLAG_DEFAULTS[k]); // 复刻视图层判据
    expect(bare.flags.auditLog === true, '审17 ① options 缺失 → auditLog 补默认 true', bare.flags.auditLog);
    expect(deviates(bare.flags) === false, '审17 ① options 缺失 → 不偏离默认（不渲染 SCD 段）', bare.flags);
    const emptyOpts = mkScd({ options: {} });
    expect(deviates(emptyOpts.flags) === false, '审17 ② options={} → 不偏离默认', emptyOpts.flags);
    const noAudit = mkScd({ options: { deleteDetection: false } }); // 有 options 但没写 auditLog
    expect(noAudit.flags.auditLog === true && deviates(noAudit.flags) === false, '审17 ③ options 有但 auditLog 缺失 → 补 true 且不偏离', noAudit.flags);
    const auditOff = mkScd({ options: { auditLog: false } });
    expect(auditOff.flags.auditLog === false && deviates(auditOff.flags) === true, '审17 ④ auditLog 显式 false → 偏离默认（渲染段：审计缺失是要紧信息）', auditOff.flags);
    const auditOnlyTrue = mkScd({ options: { auditLog: true } });
    expect(deviates(auditOnlyTrue.flags) === false, '审17 ⑤ 仅 auditLog=true（平台默认）→ 不偏离，不渲染空壳段', auditOnlyTrue.flags);
    expect(deviates(mkScd({ options: { modifyDetection: true } }).flags) === true, '审17 ⑥ 任一非默认开关开启 → 偏离默认');
    // 非法类型不炸
    const dirty = mkScd({ monitoredFields: 'not-array', options: { additionalIndexes: 'not-array', modifyDetection: 'true' } });
    expect(dirty.monitoredFields.length === 0 && dirty.indexCount === 0, 'C8 非数组脏值 → 安全降级', [dirty.monitoredFields, dirty.indexCount]);
    expect(dirty.flags.modifyDetection === false, 'C8 字符串 "true" 不算开启（严格 === true）', dirty.flags.modifyDetection);
    // DWD 不产生 scd
    expect(kit.normalizeModelDetail({ id: 922, table_name: 'dwd_t', layer: 'dwd', config_mode: 'standard', dim_config: { selectedFields: [{ targetField: 'a', dataType: 'int' }] } }).scd === null, 'C8 DWD kind 无 scd 段');
}

console.log(`\n结果: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
