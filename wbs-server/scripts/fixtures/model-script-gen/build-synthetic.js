#!/usr/bin/env node
/**
 * #77 C3a-0：合成夹具生成器（只生成 config，不写 expected；expected 由
 * `node scripts/verify-model-script-gen-golden.js --record` 在 HEAD 上写入）。
 *
 * 合成夹具全部手写、不含任何真实业务名（表名 / 字段名 / 说明均为通用占位词），可直接入库。
 * 用法：node scripts/fixtures/model-script-gen/build-synthetic.js   （重写 syn-*.json；之后须重新 --record）
 * 注意：C3a 之后不得再重新生成 / 重新录制（那会把改后的输出固化成期望）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const OUT = __dirname;
const clone = (o) => JSON.parse(JSON.stringify(o));

const DTYPES = ['int', 'bigint', 'smallint', 'tinyint', 'bit', 'decimal(18,2)', 'numeric(10,4)', 'float', 'real', 'money', 'datetime', 'datetime2', 'smalldatetime', 'date', 'time', 'varchar(64)', 'nvarchar(max)', 'nvarchar(200)', 'char(10)', 'nchar(5)', 'text', 'ntext', 'uniqueidentifier', 'varbinary(max)', 'xml', 'image', 'timestamp', 'sql_variant', 'nvarchar(512)', 'varchar(1500)', 'nvarchar(50)', 'binary(16)'];

// 派生字段：覆盖全部表达式形态（REF / CASE 多分支与旧单分支 / COALESCE fields 与旧 primary+fallback / DATE_CONVERT 四种 / DEFAULT_VALUE 含空值 / CASE_WHEN 两种长度 / CUSTOM / EXPRESSION / RAW）
const EXPRS = [
  ['dv_ref', 'REF', { expression: 'c.ItemName' }],
  ['dv_case_many', 'CASE', { branches: [{ field: 'c.Kind', whenValue: '1', thenValue: '是' }, { field: 'c.Kind', whenValue: '0', thenValue: "N'否'" }, { field: 'c.Other', whenValue: 'x', thenValue: '' }, { field: '', whenValue: 'y', thenValue: 'z' }], elseValue: '未知' }],
  ['dv_case_single', 'CASE', { field: 'c.Kind', whenValue: '1', thenValue: 'a' }],
  ['dv_case_none', 'CASE', {}],
  ['dv_case_null_else', 'CASE', { branches: [{ field: 'c.Kind', whenValue: '1', thenValue: 'a' }] }],
  ['dv_coalesce_fields', 'COALESCE', { fields: ['d.val1', 'e.val2'], defaultValue: "''" }],
  ['dv_coalesce_old', 'COALESCE', { primary: 'd.val1', fallback: 'e.val2' }],
  ['dv_coalesce_old_nofb', 'COALESCE', { primary: 'd.val1' }],
  ['dv_coalesce_empty', 'COALESCE', {}],
  ['dv_date_year', 'DATE_CONVERT', { sourceField: 'c.CreateDate', targetFormat: 'YEAR' }],
  ['dv_date_month', 'DATE_CONVERT', { sourceField: 'c.CreateDate', targetFormat: 'MONTH' }],
  ['dv_date_ym', 'DATE_CONVERT', { sourceField: 'c.CreateDate', targetFormat: 'YEARMONTH' }],
  ['dv_date_date', 'DATE_CONVERT', { sourceField: 'c.CreateDate', targetFormat: 'DATE' }],
  ['dv_date_default', 'DATE_CONVERT', { sourceField: 'c.CreateDate' }],
  ['dv_date_nosrc', 'DATE_CONVERT', {}],
  ['dv_default_num', 'DEFAULT_VALUE', { field: 'c.Amount', defaultValue: '0' }],
  ['dv_default_empty', 'DEFAULT_VALUE', { field: 'c.Amount', defaultValue: '' }],
  ['dv_default_quoted', 'DEFAULT_VALUE', { field: 'c.Amount', defaultValue: "N'abc'" }],
  ['dv_default_text', 'DEFAULT_VALUE', { field: 'c.Amount', defaultValue: 'abc' }],
  ['dv_default_nofield', 'DEFAULT_VALUE', {}],
  ['dv_casewhen_two', 'CASE_WHEN', { conditions: [{ when: 'c.Amount > 1', then: '1' }, { when: 'c.Amount < 0', then: '2' }], else: '9' }],
  ['dv_casewhen_three', 'CASE_WHEN', { conditions: [{ when: 'c.Amount > 1', then: '1' }, { when: 'c.Amount < 0', then: '2' }, { when: 'c.Amount = 0', then: '3' }] }],
  ['dv_casewhen_empty', 'CASE_WHEN', {}],
  ['dv_custom_a', 'CUSTOM', { sqlExpression: 'GETDATE()' }],
  ['dv_custom_b', 'CUSTOM', { expression: 'GETDATE()' }],
  ['dv_custom_empty', 'CUSTOM', {}],
  ['dv_expression', 'EXPRESSION', { expression: 'c.Amount + c.Kind' }],
  ['dv_expression_empty', 'EXPRESSION', {}],
  ['dv_raw', 'RAW', { expression: 'NEWID()' }],
  ['dv_unknown', 'MYSTERY', { expression: 'x' }],
];
const SMALL_IDX = [0, 1, 5, 9, 15, 20, 23, 27, 29];
const derivedSmall = () => derivedBase().filter((_, i) => SMALL_IDX.includes(i));
const derivedBase = () => EXPRS.map(([name, exprType, exprConfig], i) => ({ name, type: 'NVARCHAR(64)', comment: '派生' + i, exprType, exprConfig, source: i % 5 === 0 ? 'src ' + name : '' }));
// 派生字段的其他形态：无 exprConfig 仅 source / 什么都没有 / 带变更标签 / 无类型（DWD DDL 按名字后缀推断）
const derivedOddities = () => [
  { name: 'dv_src_only', type: 'NVARCHAR(32)', comment: '仅来源表达式', source: 'c.NoteA' },
  { name: 'dv_nothing', type: 'NVARCHAR(32)', comment: '', source: '' },
  { name: 'dv_tagged', type: 'INT', comment: '带变更标签', addedAt: '2026-01-01', modifiedAt: '2026-02-01', exprType: 'RAW', exprConfig: { expression: '1' } },
  { name: 'dv_added_only', type: 'INT', comment: '只有新增', addedAt: '2026-01-01', exprType: 'RAW', exprConfig: { expression: '2' } },
  { name: 'item_id', exprType: 'REF', exprConfig: { expression: 'c.ItemRef' } },
  { name: 'item_date', exprType: 'REF', exprConfig: { expression: 'c.ItemDate' } },
  { name: 'item_time', comment: 'time 后缀', exprType: 'REF', exprConfig: { expression: 'c.ItemTime' } },
  { name: 'item_amt', exprType: 'REF', exprConfig: { expression: 'c.ItemAmt' } },
  { name: 'overall_amount', exprType: 'REF', exprConfig: { expression: 'c.OverallAmount' } },
  { name: 'list_price', exprType: 'REF', exprConfig: { expression: 'c.ListPrice' } },
  { name: 'cash_money', exprType: 'REF', exprConfig: { expression: 'c.CashMoney' } },
  { name: 'is_valid', exprType: 'REF', exprConfig: { expression: 'c.IsValid' } },
  { name: 'has_child', exprType: 'REF', exprConfig: { expression: 'c.HasChild' } },
  { name: 'done_flag', exprType: 'REF', exprConfig: { expression: 'c.DoneFlag' } },
  { name: 'plain_text', exprType: 'REF', exprConfig: { expression: 'c.PlainText' } },
  { name: 'kind_name', exprType: 'REF', exprConfig: { expression: 'd.KindName' } },
  { name: 'kind_type_std', exprType: 'RAW', exprConfig: { expression: 'c.KindTypeStd' } },
];

// normalizeDataType 的全部分支（含长文本字段名保护：memo / content / remark / desc 与长度阈值 1024 / 2000 / MAX；无类型回退）
const NORMALIZE_PAIRS = [
  ['f_int', 'int'], ['f_big', 'bigint'], ['f_small', 'smallint'], ['f_tiny', 'tinyint'], ['f_bit', 'bit'], ['f_dec', 'decimal(18,2)'], ['f_num', 'numeric(10,4)'],
  ['f_float', 'float'], ['f_real', 'real'], ['f_money', 'money'], ['f_date', 'date'], ['f_dt', 'datetime'], ['f_dt2', 'datetime2'], ['f_sdt', 'smalldatetime'], ['f_time', 'time'],
  ['f_nv_plain', 'nvarchar(64)'], ['c_memo_nv_narrow', 'nvarchar(200)'], ['c_content_nv_max', 'nvarchar(max)'], ['c_remark_nv_wide', 'nvarchar(2000)'], ['c_desc_nchar', 'nchar(10)'],
  ['f_v_plain', 'varchar(64)'], ['c_memo_v_narrow', 'varchar(1500)'], ['c_content_v_wide', 'varchar(3000)'], ['c_remark_v_max', 'varchar(max)'], ['c_desc_char', 'char(10)'], ['c_memo_v_nolen', 'varchar'],
  ['f_char', 'char(10)'], ['f_text', 'text'], ['f_ntext', 'ntext'], ['f_guid', 'uniqueidentifier'], ['f_varbin', 'varbinary(max)'], ['f_bin', 'binary(16)'], ['f_image', 'image'],
  ['f_ts', 'timestamp'], ['f_variant', 'sql_variant'], ['f_xml', 'xml'], ['f_empty', ''], ['f_undef', undefined],
];
const SRC_TABLES = () => [
  { name: 'dbo.src_main', isPrimary: true, alias: 'c' },
  { name: 'dbo.src_dict', isPrimary: false, alias: 'd', joinType: 'LEFT JOIN', joinCondition: 'd.id = c.dict_id' },
  { name: 'dbo.src_extra', isPrimary: false, alias: 'e', joinCondition: 'e.id = c.extra_id -- 无 joinType 走默认' },
  { name: 'dbo.src_third', isPrimary: false, alias: 'f', joinType: 'INNER JOIN', joinCondition: 'f.id = c.third_id' },
];
const ADV = {
  none: {},
  NONE: { type: 'NONE' },
  CUSTOM_FROM: { types: ['CUSTOM_FROM'], customFromContent: 'dbo.src_main c\n    LEFT JOIN dbo.src_dict d ON d.id = c.dict_id' },
  'APPLY+CTE': { type: 'APPLY', types: ['APPLY', 'CTE'], applyContent: 'OUTER APPLY (SELECT TOP 1 x.val FROM dbo.src_x x WHERE x.id = c.id ORDER BY x.val DESC) ap', cteContent: 'cte_a AS (SELECT 1 AS a)', cteAlias: 'cte_a' },
  'CTE-with-prefix': { types: ['CTE'], cteContent: ';WITH cte_b AS (SELECT 2 AS b)', cteAlias: 'cte_b' },
  'CTE-with-WITH': { types: ['CTE'], cteContent: 'WITH cte_c AS (SELECT 3 AS c)', cteAlias: 'cte_c' },
  'APPLY-only': { types: ['APPLY'], applyContent: 'CROSS APPLY (SELECT 1 AS z) ap2' },
  'type-only-legacy': { type: 'CUSTOM_FROM', customFromContent: 'dbo.src_main c' },
};

// ---------------- DIM ----------------
function dimScd(scdType, auditLog, extra = {}, full = false) {
  const allFields = ['ChangeID', 'OwnerID', 'OwnerName', 'BriefCode', 'ItemMemo', 'ItemContent', 'Remark', 'Descr', 'Amount', 'CreateDate', 'UpdateTime', 'IsValid', 'KindID', 'ImageData', 'ItemGuid', 'MemoText'];
  // 精简档（默认）取前 8 个字段 + 9 个代表性派生字段，控制期望文件体量；完整档（full）全字段 + 全部派生形态
  const trackFields = full ? allFields : allFields.slice(0, 8);
  const fieldMappings = trackFields.map((t, i) => ({
    srcField: t, targetField: t.replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase(), dataType: DTYPES[i % DTYPES.length], comment: i % 4 === 0 ? "含'引号'的说明" : '说明' + i,
    scdStrategy: i % 3 === 0 ? 'SCD1' : 'SCD2', ...(i === 3 ? { sourceTable: 'd' } : {}), ...(i === 5 ? { addedAt: '2026-01-02' } : {}), ...(i === 6 ? { modifiedAt: '2026-01-03' } : {}),
  }));
  const options = {
    deleteDetection: auditLog, modifyDetection: auditLog, consistencyAlert: auditLog, auditLog,
    stateFilter: 'c.Phase = 3', versionOrderField: 'ChangeID', effDtExpr: 'CAST(c.CreateDate AS DATE)',
    consistencySourceTable: { name: 'ods_main_df', alias: 'm', joinField: 'OwnerID' },
    additionalIndexes: [{ name: 'IX_syn_a', columns: 'owner_id', where: '' }, { name: 'IX_syn_b', columns: 'kind_id, dw_eff_dt', where: 'is_valid = 1' }],
    consistencyExcludeFields: ['KindID'],
    ...extra,
  };
  if (!auditLog) { options.deleteDetection = false; options.modifyDetection = false; options.consistencyAlert = false; }
  return {
    scdType, businessKey: 'OwnerID', versionKey: scdType === 'SCD1' ? '' : 'ChangeID', trackFields, fieldMappings,
    derivedFields: full ? derivedBase() : derivedSmall(), options,
  };
}
const dimCase = (name, scd, adv, extra = {}) => ({
  name, config: { tableName: 'dim_syn_item', tableComment: '合成维度', scdConfig: scd, sourceTables: SRC_TABLES(), advancedSql: adv, live: { sourceTables: SRC_TABLES(), loadedFields: (scd.trackFields || []).map((t, i) => ({ column_name: t, data_type: DTYPES[(i + 3) % DTYPES.length], column_comment: '' })) }, ...extra },
});
function buildDim() {
  const cases = [];
  for (const scdType of ['SCD1', 'SCD2', 'HYBRID']) for (const audit of [true, false]) for (const advKey of ['none', 'NONE', 'CUSTOM_FROM', 'APPLY+CTE']) {
    cases.push(dimCase(`dim-${scdType}-${audit ? 'audit' : 'noaudit'}-${advKey}`, dimScd(scdType, audit), ADV[advKey]));
  }
  // 高级 SQL 其他形态
  for (const advKey of ['CTE-with-prefix', 'CTE-with-WITH', 'APPLY-only', 'type-only-legacy']) cases.push(dimCase(`dim-HYBRID-audit-${advKey}`, dimScd('HYBRID', true), ADV[advKey]));
  // 仅有 trackFields、没有 fieldMappings（旧数据回退）+ 无派生 + 实时版取 loadedFields 类型
  {
    const s = dimScd('SCD2', true); delete s.fieldMappings; s.derivedFields = [];
    cases.push(dimCase('dim-legacy-trackfields-only', s, ADV.none));
    const s1 = dimScd('SCD1', false); delete s1.fieldMappings; s1.derivedFields = derivedOddities().slice(0, 4); s1.trackFields = ['ChangeID', 'OwnerID', 'kind_id', 'ItemMemo', 'Amount']; s1.businessKey = 'owner_id';
    const c1 = dimCase('dim-legacy-trackfields-snake', s1, ADV.none); c1.config.live.loadedFields = [{ column_name: 'kind_id', data_type: 'int' }, { column_name: 'ItemMemo', data_type: 'nvarchar(100)' }, { column_name: 'Amount', data_type: 'decimal(18,2)' }];
    cases.push(c1);
  }
  // 只有 fieldMappings、没有 trackFields
  { const s = dimScd('HYBRID', true); s.trackFields = []; cases.push(dimCase('dim-mappings-without-trackfields', s, ADV.none)); }
  { const s = dimScd('SCD2', true); delete s.trackFields; cases.push(dimCase('dim-mappings-trackfields-undefined', s, ADV.none)); }
  { const s = dimScd('HYBRID', true); delete s.trackFields; cases.push(dimCase('dim-HYBRID-trackfields-undefined', s, ADV.none)); }
  // 版本键 / 状态过滤 / 一致性 / 选项缺省
  { const s = dimScd('SCD2', true, { stateFilter: { field: 'Phase', value: 3 } }); cases.push(dimCase('dim-SCD2-statefilter-object', s, ADV.none)); }
  { const s = dimScd('SCD2', true, { stateFilter: '' }); cases.push(dimCase('dim-SCD2-statefilter-empty', s, ADV.none)); }
  { const s = dimScd('SCD2', true, { stateFilter: undefined, versionOrderField: undefined, effDtExpr: undefined, consistencySourceTable: undefined, additionalIndexes: undefined, consistencyExcludeFields: undefined }); cases.push(dimCase('dim-SCD2-options-minimal', s, ADV.none)); }
  { const s = dimScd('HYBRID', true); s.options = { auditLog: true }; cases.push(dimCase('dim-HYBRID-options-only-auditlog', s, ADV.none)); }
  { const s = dimScd('SCD2', true); s.versionKey = 'ChangeID'; s.fieldMappings = s.fieldMappings.filter(m => m.srcField !== 'ChangeID'); cases.push(dimCase('dim-SCD2-versionkey-without-mapping', s, ADV.none)); }
  { const s = dimScd('SCD2', true); s.businessKey = 'OwnerID'; s.fieldMappings = s.fieldMappings.filter(m => m.srcField !== 'OwnerID'); cases.push(dimCase('dim-SCD2-businesskey-without-mapping', s, ADV.none)); }
  // 派生字段形态
  { const s = dimScd('HYBRID', true); s.derivedFields = derivedOddities(); cases.push(dimCase('dim-HYBRID-derived-oddities', s, ADV.none)); }
  { const s = dimScd('SCD1', true); s.derivedFields = derivedOddities(); cases.push(dimCase('dim-SCD1-derived-oddities', s, ADV['APPLY+CTE'])); }
  { const s = dimScd('SCD2', false); s.derivedFields = undefined; cases.push(dimCase('dim-SCD2-derived-undefined', s, ADV.none)); }
  // 表描述回退 / 空源表 / 无主表
  { const c = dimCase('dim-empty-comment-fallback', dimScd('HYBRID', true), ADV.none); c.config.tableComment = ''; cases.push(c); }
  { const c = dimCase('dim-no-source-tables', dimScd('SCD2', true), ADV.none); c.config.sourceTables = []; c.config.live.sourceTables = []; cases.push(c); }
  { const c = dimCase('dim-no-primary-source', dimScd('SCD2', true), ADV.none); c.config.sourceTables = SRC_TABLES().map(t => ({ ...t, isPrimary: false })); c.config.live.sourceTables = c.config.sourceTables; cases.push(c); }
  { const c = dimCase('dim-primary-without-alias', dimScd('SCD2', true), ADV.none); c.config.sourceTables = [{ name: 'dbo.src_main', isPrimary: true }, { name: 'dbo.src_dict', isPrimary: false, joinCondition: 'x.id = y.id' }]; c.config.live.sourceTables = c.config.sourceTables; cases.push(c); }
  // 完整档：全字段 + 全部派生形态（每种 SCD 一组）
  for (const scdType of ['SCD1', 'SCD2', 'HYBRID']) cases.push(dimCase(`dim-${scdType}-full-profile`, dimScd(scdType, true, {}, true), ADV['APPLY+CTE']));
  // normalizeDataType 矩阵：每种类型各一个字段，含长文本字段名保护分支
  { const s = dimScd('SCD1', false); s.trackFields = NORMALIZE_PAIRS.map(p => p[0]); s.fieldMappings = NORMALIZE_PAIRS.map(([n, t]) => ({ srcField: n, targetField: n.toLowerCase(), dataType: t, comment: t === undefined ? '无类型' : t, scdStrategy: 'SCD1' })); s.derivedFields = []; s.businessKey = 'f_int'; cases.push(dimCase('dim-normalize-datatype-matrix', s, ADV.none)); }
  // 完全空配置（真实夹具 60/62/65 的变体：业务键为空、有 / 无选项）
  cases.push({ name: 'dim-empty-scd1', config: { tableName: 'dim_syn_empty', tableComment: '', scdConfig: { scdType: 'SCD1', businessKey: '', versionKey: '', trackFields: [], fieldMappings: [], derivedFields: [], options: { auditLog: true } }, sourceTables: [], advancedSql: {}, live: { sourceTables: [], loadedFields: [] } } });
  cases.push({ name: 'dim-empty-hybrid-noaudit', config: { tableName: 'dim_syn_empty2', tableComment: '空', scdConfig: { scdType: 'HYBRID', businessKey: '', versionKey: '', trackFields: [], fieldMappings: [], derivedFields: [], options: { auditLog: false } }, sourceTables: [], advancedSql: { type: 'NONE' }, live: { sourceTables: [], loadedFields: [] } } });
  // 版本键为空但有版本排序字段（版本链仍成立）、字段映射缺省项（scdStrategy / dataType）、旧数据只有 trackFields 的各 SCD 形态、仅有业务键的映射
  for (const scdType of ['SCD2', 'HYBRID']) { const s = dimScd(scdType, true); s.versionKey = ''; cases.push(dimCase(`dim-${scdType}-versionorder-without-versionkey`, s, ADV.none)); }
  for (const scdType of ['SCD1', 'SCD2', 'HYBRID']) { const s = dimScd(scdType, true); s.fieldMappings.forEach(m => { delete m.scdStrategy; }); cases.push(dimCase(`dim-${scdType}-mappings-without-scdstrategy`, s, ADV.none)); }
  { const s = dimScd('HYBRID', true); s.fieldMappings.forEach(m => { delete m.dataType; }); cases.push(dimCase('dim-HYBRID-mappings-without-datatype', s, ADV.none)); }
  for (const scdType of ['SCD1', 'HYBRID']) { const s = dimScd(scdType, true); delete s.fieldMappings; s.derivedFields = []; s.trackFields = ['ChangeID', 'OwnerID', 'HTTPStatusCode', 'XMLDocName', 'ItemMemo', 'kind_id']; cases.push(dimCase(`dim-${scdType}-legacy-trackfields-acronym`, s, ADV.none)); }
  for (const scdType of ['SCD1', 'SCD2']) { const s = dimScd(scdType, true); s.trackFields = []; cases.push(dimCase(`dim-${scdType}-mappings-without-trackfields`, s, ADV.none)); }
  { const s = dimScd('HYBRID', true); s.fieldMappings = [{ srcField: 'OwnerID', targetField: 'owner_id', dataType: 'int', scdStrategy: 'SCD1' }]; s.trackFields = ['OwnerID']; s.derivedFields = []; cases.push(dimCase('dim-HYBRID-only-businesskey-mapping', s, ADV.none)); }
  { const s = dimScd('SCD2', true); s.derivedFields = [{ name: 'dv_case_nofield', type: 'NVARCHAR(10)', exprType: 'CASE', exprConfig: { branches: [{ field: '', whenValue: '1', thenValue: 'a' }] } }, { name: 'dv_raw_empty', type: 'NVARCHAR(10)', exprType: 'RAW', exprConfig: {} }]; cases.push(dimCase('dim-SCD2-derived-empty-expressions', s, ADV.none)); }
  // 配置台实时版 DDL（liveDdl）只在 advancedSql 为空的矩阵组与专项组上录（它与高级 SQL 无关，避免重复体量）
  cases.forEach(c => { if (/^dim-(SCD1|SCD2|HYBRID)-(audit|noaudit)-(NONE|CUSTOM_FROM|APPLY+CTE)$/.test(c.name)) delete c.config.live; });
  return { name: 'syn-dim', kind: 'dim', description: '合成 DIM 夹具：SCD1/SCD2/HYBRID × 审计开关 × 高级 SQL（24 组）+ 缺省 / 回退 / 派生字段形态', cases };
}

// ---------------- DWD ----------------
function dwdBase(strategy, hash, ct, adv, extra = {}, full = false) {
  const allSelected = [
    ['EntityID', 'entity_id', 'int'], ['EntityCode', 'entity_code', 'varchar(64)'], ['MainEntityID', 'main_entity_id', 'int'],
    ['KindID', 'kind_id', 'int'], ['KindName', 'kind_name', 'nvarchar(100)'], ['CreateDate', 'create_date', 'datetime'],
    ['OverallAmount', 'overall_amount', 'decimal(18,2)'], ['ListPrice', 'list_price', 'money'], ['Remark', 'remark', 'nvarchar(512)'],
    ['IsValid', 'is_valid', 'bit'], ['ChangeDate', 'change_date', 'date'], ['MemoText', 'memo_text', 'text'],
  ].map(([s, t, d], i) => ({ srcField: s, targetField: t, dataType: d, comment: i % 3 === 0 ? "说明'带引号'" : '说明' + i, scdStrategy: 'SCD1', ...(i === 4 ? { addedAt: '2026-01-05' } : {}) }));
  // 精简档（默认）取 7 个字段 + 12 个派生；完整档（full）全字段 + 全部派生形态
  const selectedFields = full ? allSelected : [0, 1, 3, 4, 5, 6, 10].map(i => allSelected[i]);
  const dwdConfig = {
    dataGranularity: '一行一份', updateStrategy: strategy, primaryKeys: ['entity_id'],
    hashConfig: { enabled: hash, excludeFields: ['dw_create_ts', 'dw_update_ts', 'dw_hash_val', 'dw_etl_job', 'dw_load_ts', 'dw_src_sys', 'dw_batch_id'], userExcludeFields: hash ? ['remark'] : [] },
    changeTracking: { enabled: ct, changeTableName: ct ? 'dwd_syn_entity_change_di' : '' },
    filterCondition: strategy === 'INCREMENTAL_APPEND' ? "c.UpdateTime >= '2020-01-01'" : '', version: strategy === 'FULL_OVERWRITE' ? 'v3' : 'v2.1',
    ...extra,
  };
  return { tableName: 'dwd_syn_entity_df', tableComment: '合成明细', dwdConfig, selectedFields, derivedFields: full ? derivedBase().concat(derivedOddities()) : derivedSmall().concat(derivedOddities().filter((_, i) => [0, 2, 4, 8, 11, 15].includes(i))), sourceTables: SRC_TABLES(), advancedSql: adv };
}
function buildDwd() {
  const cases = [];
  for (const strat of ['FULL_OVERWRITE', 'INCREMENTAL_APPEND', 'PARTITION_OVERWRITE']) for (const hash of [true, false]) for (const ct of [true, false]) for (const advKey of ['none', 'CTE-with-WITH', 'CUSTOM_FROM']) {
    cases.push({ name: `dwd-${strat}-${hash ? 'hash' : 'nohash'}-${ct ? 'ct' : 'noct'}-${advKey}`, config: dwdBase(strat, hash, ct, ADV[advKey]) });
  }
  // 缺省与回退
  { const c = dwdBase('FULL_OVERWRITE', true, false, ADV.none); delete c.dwdConfig.primaryKeys; cases.push({ name: 'dwd-primarykeys-missing-default-id', config: c }); }
  { const c = dwdBase('FULL_OVERWRITE', true, true, ADV.none); delete c.dwdConfig.primaryKeys; cases.push({ name: 'dwd-primarykeys-missing-with-companion', config: c }); }
  { const c = dwdBase('FULL_OVERWRITE', true, false, ADV.none); c.dwdConfig.primaryKeys = []; cases.push({ name: 'dwd-primarykeys-empty', config: c }); }
  { const c = dwdBase('FULL_OVERWRITE', true, true, ADV.none); c.dwdConfig.primaryKeys = ['entity_id', 'entity_code']; cases.push({ name: 'dwd-composite-primarykeys', config: c }); }
  { const c = dwdBase('INCREMENTAL_APPEND', true, true, ADV.none); c.dwdConfig.primaryKeys = ['entity_id', 'change_date']; cases.push({ name: 'dwd-incremental-change-date-pk', config: c }); }
  { const c = dwdBase('FULL_OVERWRITE', true, false, ADV.none); c.dwdConfig.primaryKeys = ['not_mapped_pk']; cases.push({ name: 'dwd-pk-without-mapping', config: c }); }
  { const c = dwdBase('INCREMENTAL_APPEND', true, true, ADV.none); c.dwdConfig.primaryKeys = ['not_mapped_pk']; cases.push({ name: 'dwd-incremental-pk-without-mapping', config: c }); }
  { const c = dwdBase('FULL_OVERWRITE', true, true, ADV.none); c.dwdConfig.updateStrategy = 'CUSTOM_STRATEGY'; cases.push({ name: 'dwd-unknown-updatestrategy', config: c }); }
  { const c = dwdBase('FULL_OVERWRITE', true, true, ADV.none); delete c.dwdConfig.updateStrategy; cases.push({ name: 'dwd-strategy-missing', config: c }); }
  { const c = dwdBase('FULL_OVERWRITE', true, false, ADV.none); delete c.dwdConfig.hashConfig; cases.push({ name: 'dwd-hashconfig-missing', config: c }); }
  { const c = dwdBase('FULL_OVERWRITE', true, false, ADV.none); delete c.dwdConfig.hashConfig.excludeFields; cases.push({ name: 'dwd-hash-excludefields-missing', config: c }); }
  { const c = dwdBase('INCREMENTAL_APPEND', true, true, ADV.none); delete c.dwdConfig.version; cases.push({ name: 'dwd-version-missing', config: c }); }
  { const c = dwdBase('FULL_OVERWRITE', true, true, ADV.none); c.dwdConfig.filterCondition = "c.Kind = 1 AND c.Remark <> ''"; cases.push({ name: 'dwd-full-with-filter', config: c }); }
  { const c = dwdBase('FULL_OVERWRITE', false, false, ADV.none); c.selectedFields = c.selectedFields.map(m => { const { targetField, ...r } = m; return r; }); cases.push({ name: 'dwd-mappings-without-targetfield', config: c }); }
  { const c = dwdBase('INCREMENTAL_APPEND', true, true, ADV.none); c.selectedFields = c.selectedFields.map(m => { const { targetField, ...r } = m; return r; }); cases.push({ name: 'dwd-mappings-without-targetfield-companion', config: c }); }
  { const c = dwdBase('FULL_OVERWRITE', true, true, ADV.none); c.selectedFields = c.selectedFields.map((m, i) => (i % 2 ? { ...m, comment: '' } : { ...m, comment: '', srcField: m.targetField })); cases.push({ name: 'dwd-mappings-no-comments', config: c }); }
  { const c = dwdBase('FULL_OVERWRITE', true, true, ADV.none); c.derivedFields = derivedOddities(); cases.push({ name: 'dwd-derived-oddities-only', config: c }); }
  { const c = dwdBase('FULL_OVERWRITE', true, true, ADV.none); c.derivedFields = []; cases.push({ name: 'dwd-no-derived', config: c }); }
  { const c = dwdBase('FULL_OVERWRITE', true, true, ADV.none); c.derivedFields = undefined; c.selectedFields = undefined; c.sourceTables = undefined; cases.push({ name: 'dwd-fields-undefined', config: c }); }
  { const c = dwdBase('FULL_OVERWRITE', true, true, ADV.none); c.sourceTables = []; cases.push({ name: 'dwd-no-source-tables', config: c }); }
  { const c = dwdBase('FULL_OVERWRITE', true, true, ADV.none); c.sourceTables = [{ name: 'dbo.src_main', isPrimary: true }, { name: 'dbo.src_dict', isPrimary: false, joinCondition: 'a.id = b.id' }]; cases.push({ name: 'dwd-source-tables-no-alias', config: c }); }
  { const c = dwdBase('FULL_OVERWRITE', true, true, ADV.none); c.sourceTables = SRC_TABLES().map(t => ({ ...t, isPrimary: false })); cases.push({ name: 'dwd-no-primary-source', config: c }); }
  { const c = dwdBase('FULL_OVERWRITE', true, true, ADV.none); c.tableComment = ''; cases.push({ name: 'dwd-empty-comment-fallback', config: c }); }
  { const c = dwdBase('FULL_OVERWRITE', true, true, ADV.none); c.selectedFields = c.selectedFields.map((m, i) => ({ ...m, dataType: DTYPES[(i * 5) % DTYPES.length] })); cases.push({ name: 'dwd-datatype-variety', config: c }); }
  { const c = dwdBase('FULL_OVERWRITE', true, true, ADV.none); c.derivedFields = derivedBase().slice(0, 3).map(f => ({ ...f, name: f.name.replace('dv_', 'name_') + '_name' })).concat([{ name: 'amount_code', exprType: 'REF', exprConfig: { expression: 'c.A' } }]); cases.push({ name: 'dwd-name-pairing-fields', config: c }); }
  // 完整档与数据类型矩阵
  for (const strat of ['FULL_OVERWRITE', 'INCREMENTAL_APPEND', 'PARTITION_OVERWRITE']) cases.push({ name: `dwd-${strat}-full-profile`, config: dwdBase(strat, true, true, ADV['APPLY+CTE'], {}, true) });
  { const c = dwdBase('FULL_OVERWRITE', true, true, ADV.none); c.dwdConfig.primaryKeys = ['f_int']; c.selectedFields = NORMALIZE_PAIRS.map(([n, t]) => ({ srcField: n, targetField: n.toLowerCase(), dataType: t, comment: String(t) })); cases.push({ name: 'dwd-normalize-datatype-matrix', config: c }); }
  // 空配置（真实夹具 59 的变体）
  cases.push({ name: 'dwd-empty-config', config: { tableName: 'dwd_syn_empty_df', tableComment: '', dwdConfig: { updateStrategy: 'FULL_OVERWRITE', primaryKeys: [], hashConfig: { enabled: true, excludeFields: [] }, changeTracking: { enabled: false } }, selectedFields: [], derivedFields: [], sourceTables: [], advancedSql: {} } });
  cases.push({ name: 'dwd-empty-config-no-dwdconfig-keys', config: { tableName: 'dwd_syn_empty2_df', tableComment: '空', dwdConfig: {}, selectedFields: [], derivedFields: [], sourceTables: [], advancedSql: {} } });
  return { name: 'syn-dwd', kind: 'dwd', description: '合成 DWD 夹具：更新策略 × 哈希 × 变更追踪 × 高级 SQL（36 组）+ 缺省 / 回退 / 名称配对 / 空配置', cases };
}

// ---------------- ODS ----------------
function buildOds() {
  const cols20 = DTYPES.slice(0, 20).map((t, i) => ({ column_name: 'c' + i, data_type: t.replace(/\(.*\)/, ''), max_length: i % 3 === 0 ? -1 : 50, precision: 12, scale: 3, is_nullable: i % 2 ? 'YES' : 'NO', is_primary_key: i < 2, is_identity: i === 0, column_comment: i % 4 === 0 ? "it's\nmultiline\u0001ctl" : '' }));
  const mk = (name, model, columns, comment) => ({ name, config: { model, columns, comment } });
  const full = { table_name: 'ods_syn_item_df', table_comment: '合成 ODS', source_system: 'SYS_A', source_table: 'syn_item' };
  const cases = [
    mk('ods-20-columns-full-model', full, cols20, ''),
    mk('ods-20-columns-source-comment', full, cols20, "源表'说明'"),
    mk('ods-no-primary-key', { table_name: 'ods_syn_nopk_df' }, cols20.map(c => ({ ...c, is_primary_key: false, is_identity: false })), 'cmt'),
    mk('ods-no-source-system-or-table', { table_name: 'ods_syn_nosrc_df', table_comment: '无来源' }, cols20.slice(0, 3), ''),
    mk('ods-empty-model-no-columns', {}, [], ''),
    mk('ods-null-comment-and-source', { table_name: 'ods_syn_null_df', table_comment: null, source_system: null, source_table: null }, [{ column_name: 'n1', data_type: 'int', is_nullable: 'YES', column_comment: null }, { column_name: 'n2', data_type: 'varchar', max_length: 10, is_nullable: 'YES' }], null),
    mk('ods-long-column-name', full, [{ column_name: 'a_very_long_column_name_over_twenty_six_chars', data_type: 'varchar', max_length: 20, is_nullable: 'NO', is_primary_key: true }, { column_name: 'x', data_type: 'DECIMAL', precision: null, scale: null, is_nullable: 'YES', column_comment: '十进制默认精度' }, { column_name: 'y', data_type: 'numeric', precision: 10, scale: 2, is_nullable: 'YES' }, { column_name: 'z', data_type: 'datetime2', is_nullable: 'YES', column_comment: 'a\r\nb' }], ''),
    mk('ods-identity-and-comment-note', full, [{ column_name: 'id', data_type: 'int', is_nullable: 'NO', is_primary_key: true, is_identity: true, column_comment: '主键' }, { column_name: 'v', data_type: 'nvarchar', max_length: -1, is_nullable: 'YES', is_identity: true }], ''),
  ];
  return { name: 'syn-ods', kind: 'ods', description: '合成 ODS 夹具：20 列（含主键 / identity / max_length=-1 / decimal 精度 / 含引号与换行的注释）、无主键、无来源、空模型', cases };
}

for (const fx of [buildDim(), buildDwd(), buildOds()]) {
  fx.cases.forEach(c => { c.expected = {}; });
  fs.writeFileSync(path.join(OUT, fx.name + '.json'), JSON.stringify(fx, null, 1) + '\n');
  console.log(`wrote ${fx.name}.json：${fx.cases.length} 组`);
}
