# 脚本生成器基线：残留未覆盖行登记（#77 C3a-0）

口径：V8 精确覆盖率（`node scripts/verify-model-script-gen-golden.js --coverage`），范围 = 29 个生成器函数（含配置台实时版 `generateDimDDL`）共 2,930 个非空行；**不卡百分比**。
补夹具前（只有 9 个真实形态夹具）未覆盖 378 行（12.9%）；补合成夹具后未覆盖 36 行（1.2%）。以下 36 行逐条登记理由。
定位方式：**函数名 + 代码片段**，不写行号（C3a 把生成器搬进 `public/assets/js/model-script-gen.js` 后行号会变）。`--coverage` 的输出按同一格式给出「函数名 | 代码片段」，可直接对照。

分类：
- **死代码**：条件不可能成立；
- **区间边界**：V8 把代码块收尾的 `}` 行归入未覆盖区间，本身没有独立逻辑；
- **防御分支**：`x || []` / `x || ''` 的右操作数。生成器的两类调用方（目录页 `openDimDDLModal` / `openDimETLModal` / `openDwdDDLModal` / `openDwdScriptModal` / `openDDLModal` 与配置台 `openDdlPreviewModal`）恒传数组 / 字符串；
  本提交已实测：把 DWD 的 `selectedFields` / `derivedFields` / `sourceTables` 原样传 `undefined`（不经测试适配层的 `|| []`），生成器会在某处不带兜底的 `.find` 抛 TypeError（`Cannot read properties of undefined (reading 'find')`），所以这些右支在支持的输入范围内到不了。
  （夹具里的 `dwd-fields-undefined` 用例走的是测试适配层的 `|| []`，等价于空数组，不能算覆盖这些右支。）

## 一、死代码（2 条）

| 函数 | 代码片段 | 理由 |
|---|---|---|
| `generateDimDDLFromConfig`（函数内局部 snake_case 实现） | `if (p1.length === 1 && p2.length === 2) return match;` | 外层正则 `([A-Z]{2,})([A-Z][a-z])` 保证 `p1.length >= 2`，条件永假；该局部实现只在「只有 trackFields、没有 fieldMappings」的旧数据回退里用到，回调本身已被覆盖（`return p1 + '_' + p2` 那行有夹具命中） |
| `_generateExpressionSQLInner`（`CASE_WHEN`） | `if (clauses.length === 0) return '';` | `clauses` 来自 `conds.map(c => \`WHEN ... THEN ...\`).filter(Boolean)`，`map` 恒产出非空模板串；`conds.length === 0` 已在上一行返回，故 `clauses` 不可能为空 |

## 二、区间边界（2 条）

| 函数 | 代码片段 | 理由 |
|---|---|---|
| `_generateExpressionSQLInner` | `}`（`CASE_WHEN` 块收尾，出现 1 行） | V8 区间边界，无独立逻辑 |
| `_generateExpressionSQLInner` | `}`（`switch` 收尾，出现 1 行） | 同上 |

## 三、防御分支（32 条）

| 函数 | 代码片段 | 备注 |
|---|---|---|
| `normalizeDataType` | `const fn = (fieldName \|\| '').toLowerCase();` | 参数默认值 `''` 已兜底 `undefined`，只有显式 `null` 才走右支；全部调用点传字符串或不传 |
| `generateFdlNodeScript` | `: (trackFields && trackFields.length > 0 ? trackFields : (fieldMappings \|\| []).map(m => m.targetField` | 右支 `(fieldMappings \|\| [])` 只在 `fieldMappings` 为 `undefined` 且 `trackFields` 为空时到达；`.map(...)` 本身已被「有映射、无 trackFields」夹具覆盖 |
| `buildAuditBeforeAfter` | `beforeLines.push(\`... '${labelBefore \|\| 'before'}' AS change_type\`);` | 两个调用点（增量脚本与 FDL 脚本）都显式传 `'before'` / `'after'`，默认标签永不触发 |
| `buildAuditBeforeAfter` | `afterLines.push(\`... '${labelAfter \|\| 'after'}' AS change_type\`);` | 同上 |
| `buildDwdHashExpression` | `const exclude = new Set((excludeFields \|\| []).map(f => f.toLowerCase()));` | 调用点恒传 `hashExclude` 数组 |
| `buildDwdHashExpression` | `(fieldMappings \|\| []).forEach(m => {` | 调用点恒传数组 |
| `buildDwdHashExpression` | `(derivedFields \|\| []).forEach(f => {` | 同上 |
| `buildDwdHashExpression` | `if (!exclude.has((f.name \|\| '').toLowerCase())) hashFields.push(f.name);` | 派生字段恒有 `name`（配置台校验必填） |
| `getPrimarySourceAlias` | `const primary = (sourceTables \|\| []).find(t => t.isPrimary);` | 调用点恒传数组 |
| `sortFieldsWithNamePairing` | `(fieldMappings \|\| []).forEach(m => {` | 同上 |
| `sortFieldsWithNamePairing` | `(derivedFields \|\| []).forEach(f => {` | 同上 |
| `generateDwdDDL` | `const sourceTablesComment = (sourceTables \|\| []).length > 0` | 调用点恒传数组 |
| `generateDwdDDL` | `const mapping = (fieldMappings \|\| []).find(m => (m.targetField \|\| '').toLowerCase() === pk.toLowerCa...` | 同上；`m.targetField \|\| ''` 的右支亦然（`targetField` 缺省已由「映射无 targetField」夹具覆盖到 `toSnakeCase` 回退） |
| `generateDwdDDL` | `const fn = (f.name \|\| '').toLowerCase();` | 派生字段恒有 `name` |
| `generateDwdDDL` | `const addComment = (col, desc) => { ddl += \`EXEC sp_addextendedproperty ... ${(desc \|\| '').replace(...` | 调用点只在有注释时调用（`if (m.comment)` / `if (f.comment)`），`desc` 恒为非空串 |
| `generateDwdDDL` | `primaryKeys.forEach(pk => { const m = (fieldMappings \|\| []).find(x => (x.targetField \|\| '').toLowerCase() ...` | 调用点恒传数组 |
| `generateDwdDDL` | `(fieldMappings \|\| []).forEach(m => { const t = m.targetField \|\| toSnakeCase(m.srcField); if (!pkSet...` | 同上 |
| `generateDwdDDL` | `(derivedFields \|\| []).forEach(f => { if (f.comment) addComment(f.name, f.comment); });` | 同上 |
| `generateCompanionDDL` | `const mapping = (fieldMappings \|\| []).find(m => (m.targetField \|\| '').toLowerCase() === pk.toLowerCa...` | 调用点恒传数组 |
| `generateCompanionDDL` | `const fn = (f.name \|\| '').toLowerCase();` | 派生字段恒有 `name` |
| `generateCompanionDDL` | `const addComment = (col, desc) => { ddl += \`EXEC sp_addextendedproperty ...` | 同 `generateDwdDDL` 的 `addComment` |
| `generateDwdFullLoadScript` | `const m = (fieldMappings \|\| []).find(x => (x.targetField \|\| '').toLowerCase() === pk.toLowerCase());` | 调用点恒传数组 |
| `generateDwdIncrementalScript` | `const m = (fieldMappings \|\| []).find(x => (x.targetField \|\| '').toLowerCase() === pk.toLowerCase());` | 同上 |
| `generateDwdFdlScript` | `const m = (fieldMappings \|\| []).find(x => (x.targetField \|\| '').toLowerCase() === pk.toLowerCase());` | 同上 |
| `generateDwdFdlScript` | `const primaryTable = (sourceTables \|\| []).find(t => t.isPrimary);` | 同上 |
| `generateDwdFdlScript` | `const m = (fieldMappings \|\| []).find(x => (x.targetField \|\| '').toLowerCase() === f.toLowerCase());` | 同上 |
| `generateDwdQualityRules` | `const primaryTable = (sourceTables \|\| []).find(t => t.isPrimary);` | 同上 |
| `generateDwdQualityRules` | `const amountFields = (fieldMappings \|\| []).filter(m => { const dt = (m.dataType \|\| '').toUpperCase()...` | 同上；`m.dataType \|\| ''` 的右支由「映射无 dataType」夹具对 DIM 覆盖，DWD 侧未单列 |
| `generateDwdQualityRules` | `const nameFields = (derivedFields \|\| []).filter(f => f.exprType === 'REF' \|\| (f.name \|\| '').endsWith...` | 调用点恒传数组 |
| `generateDwdQualityRules` | `const versionTag = (dwdConfig \|\| {}).version ? \`\n  配置版本: ${dwdConfig.version}\` : '';` | `dwdConfig` 恒传对象（空配置传 `{}`） |
| `generateODSDDLWithColumns` | `const sqlStr = (v) => String(v == null ? '' : v).replace(/'/g, "''");` | 调用点传入值此前均已被 `\|\| '默认值'` 兜底成字符串，`v == null` 为真的分支到不了 |
| `generateODSDDLWithColumns` | `const sqlLineComment = (v) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').replace(/[\x00-\x0...` | 同上 |

## 四、说明

- 本清单是 HEAD（C3a-0）时点的结论。C3a 把生成器搬进共享文件后，用 `--coverage` 重新跑一遍，按「函数名 + 片段」逐条对照，**新增条目视为搬运引入的回归**。
- 「防御分支」一类若将来要补覆盖，需要先决定「生成器是否应容忍 `undefined` 入参」（现状是不容忍、依赖调用方）；这属于行为变更，不在 C3a-0 / C3a 范围。
