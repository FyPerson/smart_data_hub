/* model-script-gen.js — 模型中心 脚本生成器（DIM / DWD / ODS 的 DDL、全量 / 增量 ETL、FDL 节点、质量规则、ODS 同步后置脚本）
   命名空间：window.ModelScriptGen.*（禁止新增裸全局函数名）。
   来源：#77 C3a，从 Model_Center.html 按函数名原样抽出（函数体零改写；仅 generateDimDDL 把读页面全局的
         getAllSourceTables() / loadedFields 改为末尾两个显式参数 sourceTables / loadedFields）。
         两份 DIM DDL 实现（generateDimDDLFromConfig = 目录页版；generateDimDDL = 配置台实时版）各自保留，输出不同。
   UMD：浏览器挂 window.ModelScriptGen；Node 走 module.exports。
   外部依赖：仅 Date、以及宿主全局 formatDateTimeUnified（app.js 定义；ODS 两处在调用时取用）。
         Node 侧使用方须先注入 globalThis.formatDateTimeUnified。不要把 app.js 的实现复制进本文件。
   注意：函数体内多行模板字符串的缩进即输出内容，禁止整体平移缩进或重排格式。
*/
;(function (root, factory) {
    var api = factory();
    if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
    if (root) { root.ModelScriptGen = api; }
}(typeof window !== 'undefined' ? window : null, function () {
    // 版本印记：改本文件 → 同时 bump Model_Center.html 引用处的 ?v=..._<KIT_VERSION> 后缀。
    var KIT_VERSION = 'msg1';

    // 宿主全局 formatDateTimeUnified（app.js）：调用时才取，缺失时给出可读报错
    function formatDateTimeUnified() {
        var f = (typeof globalThis !== 'undefined' ? globalThis : {}).formatDateTimeUnified;
        if (typeof f !== 'function') { throw new Error('ModelScriptGen：缺少宿主全局 formatDateTimeUnified（app.js）'); }
        return f.apply(this, arguments);
    }

        // 驼峰转下划线（用于默认目标字段名）
        // 处理连续大写字母：ChangeID → change_id, ApprovalStaffIDs → approval_staff_ids
        const toSnakeCase = (str) => {
            return str
                // 先处理小写/数字后跟大写：changeId → change_Id
                .replace(/([a-z\d])([A-Z])/g, '$1_$2')
                // 再处理连续大写后跟小写（保持2字母缩写+单小写尾完整，如 IDs 不拆分）
                .replace(/([A-Z]{2,})([A-Z][a-z])/g, (match, p1, p2) => {
                    if (p1.length === 1 && p2.length === 2) return match;
                    return p1 + '_' + p2;
                })
                .toLowerCase();
        };

        // 根据表达式配置生成 SQL
        function generateExpressionSQL(exprType, exprConfig) {
            const result = _generateExpressionSQLInner(exprType, exprConfig);
            return result || 'NULL';
        }

        function _generateExpressionSQLInner(exprType, exprConfig) {
            switch (exprType) {
                case 'REF':
                    return exprConfig.expression || '';

                case 'CASE':
                    // 支持多分支和旧格式兼容
                    let caseBranches = exprConfig.branches || [];
                    // 兼容旧的单分支格式
                    if (caseBranches.length === 0 && exprConfig.field) {
                        caseBranches = [{ field: exprConfig.field, whenValue: exprConfig.whenValue, thenValue: exprConfig.thenValue }];
                    }
                    if (caseBranches.length === 0) return '';

                    // 智能处理 SQL 字符串值：避免重复添加引号
                    const toSqlValue = (val) => {
                        if (val === null || val === undefined || val === '') return 'NULL';
                        // 如果是数字，直接返回
                        if (!isNaN(val) && val !== '') return val;
                        // 如果已经有引号包裹（N'...' 或 '...'），直接返回
                        if (/^N?'.*'$/i.test(val)) return val;
                        // 否则添加 N'' 引号
                        return `N'${val}'`;
                    };

                    const whenClauses = caseBranches.map(b => {
                        if (!b.field) return null;
                        const wVal = toSqlValue(b.whenValue);
                        const tVal = toSqlValue(b.thenValue);
                        return `WHEN ${b.field} = ${wVal} THEN ${tVal}`;
                    }).filter(Boolean);

                    if (whenClauses.length === 0) return '';
                    const elseVal = exprConfig.elseValue ? toSqlValue(exprConfig.elseValue) : 'NULL';
                    // 多分支时换行格式化，单分支保持单行
                    if (whenClauses.length <= 2) {
                        return `CASE ${whenClauses.join(' ')} ELSE ${elseVal} END`;
                    } else {
                        return `CASE\n        ${whenClauses.join('\n        ')}\n        ELSE ${elseVal}\n    END`;
                    }

                case 'COALESCE':
                    // 支持多字段，兼容旧格式
                    let coalesceArr = exprConfig.fields || [];
                    if (coalesceArr.length === 0 && exprConfig.primary) {
                        coalesceArr = [exprConfig.primary];
                        if (exprConfig.fallback) coalesceArr.push(exprConfig.fallback);
                    }
                    // 添加默认值（如果有）
                    const coalesceDefault = exprConfig.defaultValue;
                    if (coalesceDefault) {
                        coalesceArr = [...coalesceArr, coalesceDefault];
                    }
                    if (coalesceArr.length === 0) return '';
                    return `COALESCE(${coalesceArr.join(', ')})`;

                case 'DATE_CONVERT':
                    if (!exprConfig.sourceField) return '';
                    const format = exprConfig.targetFormat || 'DATE';
                    if (format === 'YEAR') return `YEAR(${exprConfig.sourceField})`;
                    if (format === 'MONTH') return `MONTH(${exprConfig.sourceField})`;
                    if (format === 'YEARMONTH') return `FORMAT(${exprConfig.sourceField}, 'yyyyMM')`;
                    return `CAST(${exprConfig.sourceField} AS ${format})`;

                case 'DEFAULT_VALUE':
                    if (!exprConfig.field) return '';
                    // 智能处理默认值
                    const toSqlDefaultVal = (val) => {
                        if (val === null || val === undefined || val === '') return "N''";
                        if (!isNaN(val) && val !== '') return val;
                        if (/^N?'.*'$/i.test(val)) return val;
                        return `N'${val}'`;
                    };
                    return `ISNULL(${exprConfig.field}, ${toSqlDefaultVal(exprConfig.defaultValue)})`;

                case 'CASE_WHEN': {
                    // 兼容 {conditions: [{when, then}], else} 格式
                    const conds = exprConfig.conditions || [];
                    if (conds.length === 0) return '';
                    const clauses = conds.map(c => `WHEN ${c.when} THEN ${c.then}`).filter(Boolean);
                    if (clauses.length === 0) return '';
                    const elseClause = exprConfig.else || 'NULL';
                    if (clauses.length <= 2) {
                        return `CASE ${clauses.join(' ')} ELSE ${elseClause} END`;
                    } else {
                        return `CASE\n        ${clauses.join('\n        ')}\n        ELSE ${elseClause}\n    END`;
                    }
                }

                case 'CUSTOM':
                    return exprConfig.expression || exprConfig.sqlExpression || '';

                case 'EXPRESSION':
                    return exprConfig.expression || '';

                case 'RAW':
                    return exprConfig.expression || '';

                default:
                    return '';
            }
        }

        // 从保存的配置生成DDL（与generateDimDDL类似，但使用保存的源表信息）
        function generateDimDDLFromConfig(tableName, tableComment, scdConfig, sourceTables) {
            const { scdType, businessKey, trackFields, fieldMappings, derivedFields, options } = scdConfig;
            const isHybridOrScd2 = scdType === 'SCD2' || scdType === 'HYBRID';

            // 将驼峰转下划线（处理连续大写字母，保持 IDs 等缩写完整）
            const toSnakeCase = (str) => str
                .replace(/([a-z\d])([A-Z])/g, '$1_$2')
                .replace(/([A-Z]{2,})([A-Z][a-z])/g, (match, p1, p2) => {
                    if (p1.length === 1 && p2.length === 2) return match;
                    return p1 + '_' + p2;
                })
                .toLowerCase();

            // 业务键统一转为 snake_case
            const businessKeySnake = toSnakeCase(businessKey);

            // 需要排除的字段（业务键和 change_id，避免重复定义）
            const excludeFields = new Set([
                businessKey.toLowerCase(),
                businessKeySnake,
                'change_id',
                'changeid'
            ]);

            // 源表注释
            const sourceTablesComment = sourceTables && sourceTables.length > 0
                ? sourceTables.map(t => `${t.isPrimary ? '(主)' : '    '} ${t.name}`).join('\n  ')
                : '未配置';

            // 派生字段注释（包含来源说明）
            const derivedFieldsComment = derivedFields && derivedFields.length > 0
                ? '\n  ' + derivedFields.map(f => {
                    const sourceInfo = f.source ? ` [来源: ${f.source}]` : '';
                    return `- ${f.name} (${f.type})${sourceInfo}`;
                }).join('\n  ')
                : '无';

            // 基础字段
            let ddl = `/*
================================================================================
  ${tableComment || tableName} - ${tableName}

  SCD 类型: ${scdType}
  业务标识: ${businessKey}
  跟踪字段: ${trackFields ? trackFields.join(', ') : '无'}
  派生字段: ${derivedFieldsComment}
  高级选项: ${options.deleteDetection ? '删除检测 ' : ''}${options.modifyDetection ? '修改检测 ' : ''}${options.consistencyAlert ? '一致性告警 ' : ''}${options.auditLog ? '审计日志' : ''}

  源表:
  ${sourceTablesComment}

  创建日期: ${new Date().toISOString().split('T')[0]}
================================================================================
*/

IF OBJECT_ID('dbo.${tableName}', 'U') IS NOT NULL
    DROP TABLE dbo.${tableName};
GO

CREATE TABLE dbo.${tableName} (
`;

            if (isHybridOrScd2) {
                // SCD2/HYBRID 代理键（使用 snake_case 业务键生成）
                ddl += `    -- 代理键
    sk_${businessKeySnake.replace(/_id$/, '')}    BIGINT IDENTITY(1,1) PRIMARY KEY,

    -- 业务键
    ${businessKeySnake}    INT NOT NULL,
`;
                // 如果启用删除检测或修改检测，需要 change_id
                if (options.deleteDetection || options.modifyDetection) {
                    ddl += `    change_id    INT NULL,    -- 变更记录ID（用于删除/修改检测）

`;
                }
            } else {
                // SCD1 直接用业务键做主键
                ddl += `    -- 业务键
    ${businessKeySnake}    INT PRIMARY KEY,

`;
            }

            // 业务字段（使用字段映射信息，排除业务键和 change_id）
            ddl += `    -- 业务字段（从主表加载）\n`;
            if (fieldMappings && fieldMappings.length > 0) {
                // 使用新的字段映射信息（包含数据类型），排除已定义的字段
                fieldMappings.forEach(mapping => {
                    // 排除业务键和 change_id
                    if (excludeFields.has(mapping.targetField.toLowerCase())) {
                        return;
                    }
                    const dataType = normalizeDataType(mapping.dataType, mapping.targetField);
                    // 添加字段注释：优先使用用户输入的注释，否则显示源字段名（如果不同）
                    let comment = '';
                    if (mapping.comment) {
                        comment = `  -- ${mapping.comment}`;
                    } else if (mapping.srcField && mapping.srcField !== mapping.targetField) {
                        comment = `  -- ${mapping.srcField}`;
                    }
                    comment += buildChangeTag(mapping);
                    ddl += `    ${mapping.targetField}    ${dataType},${comment}\n`;
                });
            } else if (trackFields && trackFields.length > 0) {
                // 向后兼容：旧数据只有 trackFields 没有 fieldMappings
                trackFields.forEach(field => {
                    const snakeField = toSnakeCase(field);
                    // 排除业务键和 change_id
                    if (excludeFields.has(snakeField)) {
                        return;
                    }
                    // 添加字段注释：显示原始字段名（如果与 snake_case 不同）
                    const comment = field !== snakeField ? `  -- ${field}` : '';
                    ddl += `    ${snakeField}    NVARCHAR(128),${comment}\n`;
                });
            }

            // 派生字段（手动添加）
            if (derivedFields && derivedFields.length > 0) {
                ddl += `\n    -- 派生字段（从关联表派生）\n`;
                derivedFields.forEach(field => {
                    // 将多行 source 压缩为单行，避免 SQL 单行注释(--) 只能注释到行尾导致语法错误
                    const sourceComment = (field.source ? `  -- ${field.source.replace(/\s*\r?\n\s*/g, ' ').trim()}` : '') + buildChangeTag(field);
                    ddl += `    ${field.name}    ${field.type || 'NVARCHAR(200)'},${sourceComment}\n`;
                });
            }

            if (isHybridOrScd2) {
                // SCD2/HYBRID 控制字段
                ddl += `
    -- SCD2 控制字段
    dw_eff_dt    DATE NOT NULL,                          -- 生效日期
    dw_exp_dt    DATE NULL DEFAULT '9999-12-31',         -- 失效日期
    dw_is_current_flg    INT NOT NULL DEFAULT 1,         -- 是否当前版本(1=是,0=否)
    dw_is_initial_flg    INT NOT NULL DEFAULT 0,         -- 是否期初版本(1=是,0=否)

`;
            }

            // 审计字段
            ddl += `    -- 审计字段
    dw_load_ts    DATETIME NOT NULL DEFAULT GETDATE(),   -- 数据加载时间
    dw_update_ts    DATETIME NULL,                       -- 数据更新时间
    dw_src_sys    VARCHAR(50) NOT NULL DEFAULT 'BMS',    -- 来源系统
    dw_batch_id    VARCHAR(50) NULL                      -- ETL批次号
);
GO

-- 创建索引
CREATE INDEX IX_${tableName}_biz_key ON dbo.${tableName}(${businessKeySnake});
`;

            if (isHybridOrScd2) {
                ddl += `CREATE INDEX IX_${tableName}_current ON dbo.${tableName}(dw_is_current_flg) WHERE dw_is_current_flg = 1;
CREATE INDEX IX_${tableName}_eff_date ON dbo.${tableName}(dw_eff_dt, dw_exp_dt);
`;
            }

            // 附加索引
            if (options?.additionalIndexes && options.additionalIndexes.length > 0) {
                ddl += `-- 附加索引\n`;
                options.additionalIndexes.forEach(idx => {
                    if (idx.where) {
                        ddl += `CREATE INDEX ${idx.name} ON dbo.${tableName}(${idx.columns}) WHERE ${idx.where};\n`;
                    } else {
                        ddl += `CREATE INDEX ${idx.name} ON dbo.${tableName}(${idx.columns});\n`;
                    }
                });
            }

            ddl += `GO

-- 添加表注释
EXEC sp_addextendedproperty
    @name = N'MS_Description',
    @value = N'${tableComment || tableName}',
    @level0type = N'SCHEMA', @level0name = N'dbo',
    @level1type = N'TABLE', @level1name = N'${tableName}';
GO

`;

            // 收集所有需要添加注释的字段
            const fieldComments = [];

            // 代理键和业务键注释（固定）
            if (isHybridOrScd2) {
                fieldComments.push({ field: `sk_${businessKeySnake.replace(/_id$/, '')}`, comment: '代理键（自增主键）' });
            }
            fieldComments.push({ field: businessKeySnake, comment: `${businessKey}（业务键）` });

            // 业务字段注释
            if (fieldMappings && fieldMappings.length > 0) {
                fieldMappings.forEach(mapping => {
                    if (excludeFields.has(mapping.targetField.toLowerCase())) return;
                    if (mapping.comment) {
                        fieldComments.push({ field: mapping.targetField, comment: mapping.comment });
                    }
                });
            }

            // 派生字段注释
            if (derivedFields && derivedFields.length > 0) {
                derivedFields.forEach(field => {
                    if (field.comment) {
                        fieldComments.push({ field: field.name, comment: field.comment });
                    }
                });
            }

            // SCD2/HYBRID 控制字段注释（固定）
            if (isHybridOrScd2) {
                fieldComments.push({ field: 'dw_eff_dt', comment: '生效日期' });
                fieldComments.push({ field: 'dw_exp_dt', comment: '失效日期（9999-12-31表示当前有效）' });
                fieldComments.push({ field: 'dw_is_current_flg', comment: '是否当前版本（1=是, 0=否）' });
                fieldComments.push({ field: 'dw_is_initial_flg', comment: '是否期初版本（1=是, 0=否）' });
            }

            // 审计字段注释（固定）
            fieldComments.push({ field: 'dw_load_ts', comment: '数据加载时间' });
            fieldComments.push({ field: 'dw_update_ts', comment: '数据更新时间' });
            fieldComments.push({ field: 'dw_src_sys', comment: '来源系统' });
            fieldComments.push({ field: 'dw_batch_id', comment: 'ETL批次号' });

            // 生成字段注释语句
            if (fieldComments.length > 0) {
                ddl += `-- 添加字段注释\n`;
                fieldComments.forEach(fc => {
                    // 转义单引号
                    const safeComment = fc.comment.replace(/'/g, "''");
                    ddl += `EXEC sp_addextendedproperty @name=N'MS_Description', @value=N'${safeComment}',
    @level0type=N'SCHEMA', @level0name=N'dbo', @level1type=N'TABLE', @level1name=N'${tableName}',
    @level2type=N'COLUMN', @level2name=N'${fc.field}';
`;
                });
                ddl += `GO\n`;
            }

            return ddl;
        }

        // 标准化数据类型（将源表类型转换为 DDL 友好格式）
        // 参数 fieldName 可选，用于根据字段名推断合适的长度
        // 字段变更时间戳标记（DDL 注释用）
        function buildChangeTag(field) {
            const tags = [];
            if (field.addedAt) tags.push(`新增 ${field.addedAt}`);
            if (field.modifiedAt) tags.push(`修改 ${field.modifiedAt}`);
            return tags.length ? ` [${tags.join(', ')}]` : '';
        }

        // ETL 字段源表达式解析（支持 sourceAlias）
        function resolveFieldExpr(m, defaultAlias) {
            const a = m.sourceAlias || defaultAlias;
            return m.srcField.includes('.') ? m.srcField : `${a}.${m.srcField}`;
        }

        function normalizeDataType(dataType, fieldName = '') {
            if (!dataType) return 'NVARCHAR(256)';
            const t = dataType.toLowerCase();
            const fn = (fieldName || '').toLowerCase();

            // 整数类型
            if (t.includes('bigint')) return 'BIGINT';
            if (t.includes('smallint')) return 'SMALLINT';
            if (t.includes('tinyint')) return 'TINYINT';
            if (t.includes('int')) return 'INT';
            if (t.includes('bit')) return 'BIT';

            // 精确数值
            if (t.includes('decimal') || t.includes('numeric')) return dataType.toUpperCase();
            if (t.includes('float')) return 'FLOAT';
            if (t.includes('real')) return 'REAL';
            if (t.includes('money')) return 'MONEY';

            // 日期时间
            if (t.includes('date') && !t.includes('datetime')) return 'DATE';
            if (t.includes('datetime2')) return 'DATETIME2';
            if (t.includes('datetime')) return 'DATETIME';
            if (t.includes('time')) return 'TIME';

            // 文本类型 - 保留原始长度，但对特殊字段名做保护
            if (t.includes('nvarchar') || t.includes('nchar')) {
                // 如果是 memo/content/remark 等长文本字段，确保至少 1024
                if (fn.includes('memo') || fn.includes('content') || fn.includes('remark') || fn.includes('desc')) {
                    const match = t.match(/\((\d+|max)\)/i);
                    if (match) {
                        const len = match[1].toLowerCase() === 'max' ? 'MAX' : parseInt(match[1]);
                        if (len !== 'MAX' && len < 1024) return 'NVARCHAR(1024)';
                    }
                }
                return dataType.toUpperCase();
            }
            if (t.includes('varchar') || t.includes('char')) {
                // 如果是 memo/content/remark 等长文本字段，确保至少 2000
                if (fn.includes('memo') || fn.includes('content') || fn.includes('remark') || fn.includes('desc')) {
                    const match = t.match(/\((\d+|max)\)/i);
                    if (match) {
                        const len = match[1].toLowerCase() === 'max' ? 'MAX' : parseInt(match[1]);
                        if (len !== 'MAX' && len < 2000) return 'VARCHAR(MAX)';
                    }
                }
                return dataType.toUpperCase();
            }

            // 大文本
            if (t.includes('text') || t.includes('ntext')) return 'NVARCHAR(MAX)';

            // 其他
            if (t.includes('uniqueidentifier')) return 'UNIQUEIDENTIFIER';
            if (t.includes('varbinary') || t.includes('binary')) return dataType.toUpperCase();
            if (t.includes('image')) return 'VARBINARY(MAX)';

            return dataType.toUpperCase();
        }

        // 生成DDL语句
        function generateDimDDL(tableName, tableComment, scdConfig, sourceTables, loadedFields) {
            const { scdType, businessKey, trackFields, fieldMappings, derivedFields, options } = scdConfig;
            const isHybridOrScd2 = scdType === 'SCD2' || scdType === 'HYBRID';

            // 业务键统一转为 snake_case
            const businessKeySnake = toSnakeCase(businessKey);

            // 需要排除的字段（业务键和 change_id，避免重复定义）
            const excludeFields = new Set([
                businessKey.toLowerCase(),
                businessKeySnake,
                'change_id',
                'changeid'
            ]);

            // 获取源表信息
            // sourceTables / loadedFields 由调用方显式传入且必须是数组（原先读页面全局 getAllSourceTables() / loadedFields，二者恒为数组）
            const sourceTablesComment = sourceTables.length > 0
                ? sourceTables.map(t => `${t.isPrimary ? '(主)' : '    '} ${t.name}`).join('\n  ')
                : '未配置';

            // 派生字段注释（包含来源说明）
            const derivedFieldsComment = derivedFields && derivedFields.length > 0
                ? '\n  ' + derivedFields.map(f => {
                    const sourceInfo = f.source ? ` [来源: ${f.source}]` : '';
                    return `- ${f.name} (${f.type})${sourceInfo}`;
                }).join('\n  ')
                : '无';

            // 字段映射注释
            const fieldMappingsComment = fieldMappings && fieldMappings.length > 0
                ? fieldMappings.map(m => `${m.srcField} → ${m.targetField}`).join(', ')
                : trackFields.join(', ');

            // 基础字段
            let ddl = `/*
================================================================================
  ${tableComment} - ${tableName}

  SCD 类型: ${scdType}
  业务标识: ${businessKey}
  字段映射: ${fieldMappingsComment}
  派生字段: ${derivedFieldsComment}
  高级选项: ${options.deleteDetection ? '删除检测 ' : ''}${options.modifyDetection ? '修改检测 ' : ''}${options.consistencyAlert ? '一致性告警 ' : ''}${options.auditLog ? '审计日志' : ''}

  源表:
  ${sourceTablesComment}

  创建日期: ${new Date().toISOString().split('T')[0]}
================================================================================
*/

IF OBJECT_ID('dbo.${tableName}', 'U') IS NOT NULL
    DROP TABLE dbo.${tableName};
GO

CREATE TABLE dbo.${tableName} (
`;

            if (isHybridOrScd2) {
                // SCD2/HYBRID 代理键（使用 snake_case 业务键生成）
                ddl += `    -- 代理键
    sk_${businessKeySnake.replace(/_id$/, '')}    BIGINT IDENTITY(1,1) PRIMARY KEY,

    -- 业务键
    ${businessKeySnake}    INT NOT NULL,
`;
                // 如果启用删除检测或修改检测，需要 change_id
                if (options.deleteDetection || options.modifyDetection) {
                    ddl += `    change_id    INT NULL,    -- 变更记录ID（用于删除/修改检测）

`;
                }
            } else {
                // SCD1 直接用业务键做主键
                ddl += `    -- 业务键
    ${businessKeySnake}    INT PRIMARY KEY,

`;
            }

            // 业务字段（使用字段映射信息，排除业务键和 change_id）
            ddl += `    -- 业务字段（从主表加载）\n`;
            if (fieldMappings && fieldMappings.length > 0) {
                // 使用新的字段映射信息，排除已定义的字段
                fieldMappings.forEach(mapping => {
                    // 排除业务键和 change_id
                    if (excludeFields.has(mapping.targetField.toLowerCase())) {
                        return;
                    }
                    const dataType = normalizeDataType(mapping.dataType, mapping.targetField);
                    // 添加字段注释：优先使用用户输入的注释，否则显示源字段名（如果不同）
                    let comment = '';
                    if (mapping.comment) {
                        comment = `  -- ${mapping.comment}`;
                    } else if (mapping.srcField && mapping.srcField !== mapping.targetField) {
                        comment = `  -- ${mapping.srcField}`;
                    }
                    comment += buildChangeTag(mapping);
                    ddl += `    ${mapping.targetField}    ${dataType},${comment}\n`;
                });
            } else {
                // 向后兼容：使用旧的 trackFields
                trackFields.forEach(field => {
                    const snakeField = toSnakeCase(field);
                    // 排除业务键和 change_id
                    if (excludeFields.has(snakeField)) {
                        return;
                    }
                    const srcField = loadedFields.find(f => f.column_name === field);
                    let dataType = 'NVARCHAR(256)';
                    if (srcField) {
                        dataType = normalizeDataType(srcField.data_type, snakeField);
                    }
                    // 添加字段注释：显示原始字段名
                    const comment = field !== snakeField ? `  -- ${field}` : '';
                    ddl += `    ${snakeField}    ${dataType},${comment}\n`;
                });
            }

            // 派生字段（手动添加）
            if (derivedFields && derivedFields.length > 0) {
                ddl += `\n    -- 派生字段（从关联表派生）\n`;
                derivedFields.forEach(field => {
                    // 将多行 source 压缩为单行，避免 SQL 单行注释(--) 只能注释到行尾导致语法错误
                    const sourceComment = (field.source ? `  -- ${field.source.replace(/\s*\r?\n\s*/g, ' ').trim()}` : '') + buildChangeTag(field);
                    ddl += `    ${field.name}    ${field.type || 'NVARCHAR(200)'},${sourceComment}\n`;
                });
            }

            if (isHybridOrScd2) {
                // SCD2/HYBRID 控制字段
                ddl += `
    -- SCD2 控制字段
    dw_eff_dt    DATE NOT NULL,                          -- 生效日期
    dw_exp_dt    DATE NULL DEFAULT '9999-12-31',         -- 失效日期
    dw_is_current_flg    INT NOT NULL DEFAULT 1,         -- 是否当前版本(1=是,0=否)
    dw_is_initial_flg    INT NOT NULL DEFAULT 0,         -- 是否期初版本(1=是,0=否)

`;
            }

            // 审计字段
            ddl += `    -- 审计字段
    dw_load_ts    DATETIME NOT NULL DEFAULT GETDATE(),   -- 数据加载时间
    dw_update_ts    DATETIME NULL,                       -- 数据更新时间
    dw_src_sys    VARCHAR(50) NOT NULL DEFAULT 'BMS',    -- 来源系统
    dw_batch_id    VARCHAR(50) NULL                      -- ETL批次号
);
GO

-- 创建索引
CREATE INDEX IX_${tableName}_biz_key ON dbo.${tableName}(${businessKeySnake});
`;

            if (isHybridOrScd2) {
                ddl += `CREATE INDEX IX_${tableName}_current ON dbo.${tableName}(dw_is_current_flg) WHERE dw_is_current_flg = 1;
CREATE INDEX IX_${tableName}_eff_date ON dbo.${tableName}(dw_eff_dt, dw_exp_dt);
`;
            }

            // 附加索引
            if (options?.additionalIndexes && options.additionalIndexes.length > 0) {
                ddl += `-- 附加索引\n`;
                options.additionalIndexes.forEach(idx => {
                    if (idx.where) {
                        ddl += `CREATE INDEX ${idx.name} ON dbo.${tableName}(${idx.columns}) WHERE ${idx.where};\n`;
                    } else {
                        ddl += `CREATE INDEX ${idx.name} ON dbo.${tableName}(${idx.columns});\n`;
                    }
                });
            }

            ddl += `GO

-- 添加表注释
EXEC sp_addextendedproperty
    @name = N'MS_Description',
    @value = N'${tableComment}',
    @level0type = N'SCHEMA', @level0name = N'dbo',
    @level1type = N'TABLE', @level1name = N'${tableName}';
GO

`;

            // 收集所有需要添加注释的字段
            const fieldComments = [];

            // 代理键和业务键注释（固定）
            if (isHybridOrScd2) {
                fieldComments.push({ field: `sk_${businessKeySnake.replace(/_id$/, '')}`, comment: '代理键（自增主键）' });
            }
            fieldComments.push({ field: businessKeySnake, comment: `${businessKey}（业务键）` });

            // 业务字段注释
            if (fieldMappings && fieldMappings.length > 0) {
                fieldMappings.forEach(mapping => {
                    if (excludeFields.has(mapping.targetField.toLowerCase())) return;
                    if (mapping.comment) {
                        fieldComments.push({ field: mapping.targetField, comment: mapping.comment });
                    }
                });
            }

            // 派生字段注释
            if (derivedFields && derivedFields.length > 0) {
                derivedFields.forEach(field => {
                    if (field.comment) {
                        fieldComments.push({ field: field.name, comment: field.comment });
                    }
                });
            }

            // SCD2/HYBRID 控制字段注释（固定）
            if (isHybridOrScd2) {
                fieldComments.push({ field: 'dw_eff_dt', comment: '生效日期' });
                fieldComments.push({ field: 'dw_exp_dt', comment: '失效日期（9999-12-31表示当前有效）' });
                fieldComments.push({ field: 'dw_is_current_flg', comment: '是否当前版本（1=是, 0=否）' });
                fieldComments.push({ field: 'dw_is_initial_flg', comment: '是否期初版本（1=是, 0=否）' });
            }

            // 审计字段注释（固定）
            fieldComments.push({ field: 'dw_load_ts', comment: '数据加载时间' });
            fieldComments.push({ field: 'dw_update_ts', comment: '数据更新时间' });
            fieldComments.push({ field: 'dw_src_sys', comment: '来源系统' });
            fieldComments.push({ field: 'dw_batch_id', comment: 'ETL批次号' });

            // 生成字段注释语句
            if (fieldComments.length > 0) {
                ddl += `-- 添加字段注释\n`;
                fieldComments.forEach(fc => {
                    // 转义单引号
                    const safeComment = fc.comment.replace(/'/g, "''");
                    ddl += `EXEC sp_addextendedproperty @name=N'MS_Description', @value=N'${safeComment}',
    @level0type=N'SCHEMA', @level0name=N'dbo', @level1type=N'TABLE', @level1name=N'${tableName}',
    @level2type=N'COLUMN', @level2name=N'${fc.field}';
`;
                });
                ddl += `GO\n`;
            }

            return ddl;
        }

        // ==================== ETL 脚本生成 ====================

        // 生成 FROM 子句（包含多表 JOIN + 高级 SQL 配置，支持多类型共存）
        function buildFromClause(sourceTables, advancedSqlConfig) {
            // 获取启用的类型列表（兼容新旧格式）
            const types = advancedSqlConfig?.types ||
                (advancedSqlConfig?.type && advancedSqlConfig.type !== 'NONE' ? [advancedSqlConfig.type] : []);

            // 如果使用自定义 FROM，直接返回（但不影响 CTE）
            if (types.includes('CUSTOM_FROM') && advancedSqlConfig.customFromContent) {
                return advancedSqlConfig.customFromContent;
            }

            const primaryTable = sourceTables.find(t => t.isPrimary);
            if (!primaryTable) return 'ods_source_table src';

            let fromClause = `${primaryTable.name} ${primaryTable.alias || 'src'}`;

            // 添加 JOIN 子句
            const joinTables = sourceTables.filter(t => !t.isPrimary && t.joinCondition);
            joinTables.forEach(t => {
                fromClause += `\n    ${t.joinType} ${t.name} ${t.alias}\n        ON ${t.joinCondition}`;
            });

            // 添加 APPLY 子句（支持多类型共存）
            if (types.includes('APPLY') && advancedSqlConfig.applyContent) {
                fromClause += `\n    ${advancedSqlConfig.applyContent}`;
            }

            return fromClause;
        }

        // 生成 CTE 前缀（如果配置了 CTE，支持多类型共存）
        function buildCtePrefix(advancedSqlConfig) {
            // 获取启用的类型列表（兼容新旧格式）
            const types = advancedSqlConfig?.types ||
                (advancedSqlConfig?.type && advancedSqlConfig.type !== 'NONE' ? [advancedSqlConfig.type] : []);

            if (types.includes('CTE') && advancedSqlConfig.cteContent) {
                const raw = advancedSqlConfig.cteContent.trim();
                // 确保 CTE 以 ;WITH 开头（SQL Server 语法要求）
                if (/^;?\s*WITH\s/i.test(raw)) {
                    return raw + '\n';
                }
                return ';WITH ' + raw + '\n';
            }
            return '';
        }

        // 生成全量初始化脚本（优化版：支持派生字段表达式）
        function generateFullLoadScript(tableName, tableComment, scdConfig, sourceTables, advancedSqlConfig) {
            const { scdType, businessKey, trackFields, fieldMappings, derivedFields, options } = scdConfig;
            const isHybridOrScd2 = scdType === 'SCD2' || scdType === 'HYBRID';
            const primaryTable = sourceTables.find(t => t.isPrimary);
            const primaryAlias = primaryTable?.alias || 'src';

            // 生成代理键名：dim_official_customer → sk_official_customer
            const skName = tableName.replace(/^dim_/, 'sk_');

            // 构建 FROM 子句（含高级 SQL 配置）
            const fromClause = buildFromClause(sourceTables, advancedSqlConfig);
            const hasJoins = sourceTables.filter(t => !t.isPrimary && t.joinCondition).length > 0;
            const types = advancedSqlConfig?.types || [];
            const hasAdvancedSql = types.length > 0;

            // 构建 CTE 前缀
            const ctePrefix = buildCtePrefix(advancedSqlConfig);

            // 构建源表注释
            const sourceTablesComment = sourceTables.map(t => {
                if (t.isPrimary) {
                    return `- ${t.name} AS ${t.alias} (主表)`;
                } else {
                    return `- ${t.name} AS ${t.alias} (${t.joinType || 'LEFT JOIN'})`;
                }
            }).join('\n    ');

            // 高级配置注释
            let advancedComment = '';
            if (types.includes('APPLY')) advancedComment += 'OUTER APPLY ';
            if (types.includes('CTE')) advancedComment += 'CTE ';
            if (types.includes('CUSTOM_FROM')) advancedComment += '自定义FROM ';

            // 派生字段注释
            const derivedFieldsComment = derivedFields && derivedFields.length > 0
                ? derivedFields.map(f => `- ${f.name}: ${f.source || '表达式'}`).join('\n    ')
                : '无';

            // 业务键转 snake_case
            const businessKeySnake = toSnakeCase(businessKey);

            // 找到业务键对应的源字段
            const businessKeyMapping = fieldMappings?.find(m =>
                m.targetField.toLowerCase() === businessKeySnake ||
                m.srcField.toLowerCase() === businessKey.toLowerCase()
            );
            const businessKeySrcField = businessKeyMapping
                ? `${primaryAlias}.${businessKeyMapping.srcField}`
                : `${primaryAlias}.${businessKey}`;

            // === 版本链配置（SCD2 多版本表支持）===
            const versionKey = scdConfig.versionKey || '';
            const hasVersionKey = versionKey && versionKey.trim() !== '';
            const versionKeySnake = hasVersionKey ? toSnakeCase(versionKey) : null;
            const versionKeyMapping = hasVersionKey ? fieldMappings?.find(m =>
                m.targetField.toLowerCase() === versionKeySnake?.toLowerCase() ||
                m.srcField.toLowerCase() === versionKey.toLowerCase()
            ) : null;
            const versionKeySrcField = hasVersionKey ? (versionKeyMapping?.srcField || versionKey) : null;

            const stateFilter = options?.stateFilter;
            // stateFilter 字符串中 c. 是 FDL 惯例别名，初始化脚本需替换为实际主表别名
            const stateFilterExpr = typeof stateFilter === 'string'
                ? stateFilter.replace(/\bc\./g, `${primaryAlias}.`)
                : (stateFilter?.field ? `${primaryAlias}.${stateFilter.field} = ${stateFilter.value}` : '');

            const versionOrderField = options?.versionOrderField;
            const effDtExpression = options?.effDtExpr || 'CAST(GETDATE() AS DATE)';

            // 是否需要构建版本链（有 versionKey 或 versionOrderField 时启用）
            const needsVersionChain = isHybridOrScd2 && (hasVersionKey || versionOrderField);

            // ========== 构建 version_chain CTE（多版本 SCD2）==========
            let versionChainCte = '';
            if (needsVersionChain) {
                const orderExpr = versionOrderField
                    ? `${primaryAlias}.${versionOrderField}`
                    : businessKeySrcField;

                let vcSelectLines = [];
                // 业务键
                vcSelectLines.push(`        ${businessKeySrcField}`);
                // 版本键
                if (hasVersionKey && versionKeySrcField) {
                    vcSelectLines.push(`        ${primaryAlias}.${versionKeySrcField}`);
                }
                // 业务字段
                if (fieldMappings && fieldMappings.length > 0) {
                    fieldMappings.forEach(m => {
                        if (m.targetField.toLowerCase() !== businessKeySnake &&
                            !(hasVersionKey && m.targetField.toLowerCase() === versionKeySnake?.toLowerCase())) {
                            const srcAlias = m.sourceTable || primaryAlias;
                            vcSelectLines.push(`        ${srcAlias}.${m.srcField}`);
                        }
                    });
                }
                // 派生字段
                if (derivedFields && derivedFields.length > 0) {
                    derivedFields.forEach(f => {
                        let exprSql = '';
                        if (f.exprType && f.exprConfig) exprSql = generateExpressionSQL(f.exprType, f.exprConfig);
                        else if (f.source) exprSql = f.source;
                        vcSelectLines.push(`        ${exprSql || 'NULL'} AS ${f.name}`);
                    });
                }
                // 生效日期
                vcSelectLines.push(`        ${effDtExpression} AS EffectiveTime`);
                // 窗口函数
                const partitionBy = businessKeySrcField;
                vcSelectLines.push(`        ROW_NUMBER() OVER (PARTITION BY ${partitionBy} ORDER BY ${orderExpr}) AS rn`);
                vcSelectLines.push(`        ROW_NUMBER() OVER (PARTITION BY ${partitionBy} ORDER BY ${orderExpr} DESC) AS rn_desc`);
                vcSelectLines.push(`        LEAD(${effDtExpression}) OVER (PARTITION BY ${partitionBy} ORDER BY ${orderExpr}) AS NextEffectiveTime`);

                const vcWhere = stateFilterExpr ? `\n    WHERE ${stateFilterExpr}` : '';
                versionChainCte = `version_chain AS (\n    SELECT\n${vcSelectLines.join(',\n')}\n    FROM ${fromClause}${vcWhere}\n)\n`;
            }

            // ========== 合并 CTE 前缀 ==========
            let fullCtePrefix = '';
            if (needsVersionChain) {
                if (ctePrefix) {
                    fullCtePrefix = ctePrefix.trimEnd() + ',\n' + versionChainCte;
                } else {
                    fullCtePrefix = ';WITH ' + versionChainCte;
                }
            } else {
                fullCtePrefix = ctePrefix;
            }

            // ========== 构建 INSERT 字段列表 ==========
            let insertFields = [];

            // 1. 业务键
            insertFields.push(`    ${businessKeySnake}`);

            // 2. 业务字段（排除业务键）
            if (fieldMappings && fieldMappings.length > 0) {
                fieldMappings.forEach(m => {
                    if (m.targetField.toLowerCase() !== businessKeySnake) {
                        insertFields.push(`    ${m.targetField}`);
                    }
                });
            }

            // 3. 派生字段
            if (derivedFields && derivedFields.length > 0) {
                derivedFields.forEach(f => {
                    insertFields.push(`    ${f.name}`);
                });
            }

            // 4. SCD2/HYBRID 控制字段
            if (isHybridOrScd2) {
                insertFields.push(`    dw_eff_dt`);
                insertFields.push(`    dw_exp_dt`);
                insertFields.push(`    dw_is_current_flg`);
                insertFields.push(`    dw_is_initial_flg`);
            }

            // 5. 审计字段
            insertFields.push(`    dw_load_ts`);
            insertFields.push(`    dw_update_ts`);
            insertFields.push(`    dw_src_sys`);
            insertFields.push(`    dw_batch_id`);

            // ========== 构建 SELECT 字段列表 ==========
            let selectFields = [];

            if (needsVersionChain) {
                // --- 从 version_chain vc 取字段 ---
                // 1. 业务键
                selectFields.push(`    vc.${businessKeyMapping?.srcField || businessKey} AS ${businessKeySnake}`);
                // 2. 版本键
                if (hasVersionKey && versionKeySrcField) {
                    selectFields.push(`    vc.${versionKeySrcField} AS ${versionKeySnake}`);
                }
                // 3. 业务字段
                if (fieldMappings && fieldMappings.length > 0) {
                    fieldMappings.forEach(m => {
                        if (m.targetField.toLowerCase() !== businessKeySnake &&
                            !(hasVersionKey && m.targetField.toLowerCase() === versionKeySnake?.toLowerCase())) {
                            selectFields.push(`    vc.${m.srcField} AS ${m.targetField}`);
                        }
                    });
                }
                // 4. 派生字段
                if (derivedFields && derivedFields.length > 0) {
                    derivedFields.forEach(f => {
                        selectFields.push(`    vc.${f.name}`);
                    });
                }
                // 5. SCD2 控制字段（从窗口函数结果计算）
                selectFields.push(`    CAST(vc.EffectiveTime AS DATE) AS dw_eff_dt`);
                selectFields.push(`    ISNULL(CAST(vc.NextEffectiveTime AS DATE), '9999-12-31') AS dw_exp_dt`);
                selectFields.push(`    CASE WHEN vc.rn_desc = 1 THEN 1 ELSE 0 END AS dw_is_current_flg`);
                selectFields.push(`    CASE WHEN vc.rn = 1 THEN 1 ELSE 0 END AS dw_is_initial_flg`);
            } else {
                // --- 原有逻辑：直接从源表取字段 ---
                // 1. 业务键
                selectFields.push(`    ${businessKeySrcField} AS ${businessKeySnake}`);
                // 2. 业务字段
                if (fieldMappings && fieldMappings.length > 0) {
                    fieldMappings.forEach(m => {
                        if (m.targetField.toLowerCase() !== businessKeySnake) {
                            const srcAlias = m.sourceTable || primaryAlias;
                            selectFields.push(`    ${srcAlias}.${m.srcField} AS ${m.targetField}`);
                        }
                    });
                }
                // 3. 派生字段
                if (derivedFields && derivedFields.length > 0) {
                    derivedFields.forEach(f => {
                        let exprSql = '';
                        if (f.exprType && f.exprConfig) {
                            exprSql = generateExpressionSQL(f.exprType, f.exprConfig);
                        } else if (f.source) {
                            exprSql = f.source;
                        }
                        selectFields.push(exprSql ? `    ${exprSql} AS ${f.name}` : `    NULL AS ${f.name}`);
                    });
                }
                // 4. SCD2/HYBRID 控制字段（简单模式）
                if (isHybridOrScd2) {
                    selectFields.push(`    CAST(GETDATE() AS DATE) AS dw_eff_dt`);
                    selectFields.push(`    CAST('9999-12-31' AS DATE) AS dw_exp_dt`);
                    selectFields.push(`    1 AS dw_is_current_flg`);
                    selectFields.push(`    1 AS dw_is_initial_flg`);
                }
            }

            // 审计字段（两种模式共用）
            selectFields.push(`    GETDATE() AS dw_load_ts`);
            selectFields.push(`    GETDATE() AS dw_update_ts`);
            selectFields.push(`    'BMS' AS dw_src_sys`);
            selectFields.push(`    @batch_id AS dw_batch_id`);

            // ========== 生成完整脚本 ==========
            let script = `/*
================================================================================
  ${tableComment || tableName} - 全量初始化 ETL 脚本

  用途：首次加载数据到 ${tableName} 表
  执行方式：手动执行一次（建表后）

  目标表: dbo.${tableName}
  代理键: ${skName}（IDENTITY 自增，INSERT 时自动生成）
  SCD类型: ${scdType}
  业务标识: ${businessKey}
  跟踪字段: ${trackFields ? trackFields.join(', ') : '无'}

  源表:
    ${sourceTablesComment}
  ${advancedComment ? `高级配置: ${advancedComment}` : ''}
  派生字段:
    ${derivedFieldsComment}

  生成日期: ${new Date().toISOString().split('T')[0]}
  生成工具: 智数协同平台 - 模型中心
================================================================================
*/

-- 声明批次号
DECLARE @batch_id VARCHAR(50) = 'INIT_' + FORMAT(GETDATE(), 'yyyyMMddHHmmss');

PRINT '========================================';
PRINT '开始执行 ${tableName} 全量初始化';
PRINT '批次号: ' + @batch_id;
PRINT '执行时间: ' + CONVERT(VARCHAR, GETDATE(), 120);
PRINT '========================================';

-- ============================================================================
-- Step 1: 清空目标表
-- ============================================================================

PRINT '';
PRINT 'Step 1: 清空目标表';

TRUNCATE TABLE dbo.${tableName};

PRINT '  - 目标表已清空';

-- ============================================================================
-- Step 2: 全量加载
-- ============================================================================

PRINT '';
PRINT 'Step 2: 全量加载数据';

${fullCtePrefix}INSERT INTO dbo.${tableName} (
${insertFields.join(',\n')}
)
SELECT
${selectFields.join(',\n')}
FROM ${needsVersionChain ? 'version_chain vc' : fromClause}${needsVersionChain ? ';' : `
WHERE 1=1;  -- 可添加过滤条件`}

DECLARE @load_count INT = @@ROWCOUNT;
PRINT '  - 加载记录数: ' + CAST(@load_count AS VARCHAR);

-- ============================================================================
-- Step 3: 数据验证
-- ============================================================================

PRINT '';
PRINT 'Step 3: 数据验证';

${needsVersionChain ? `SELECT
    '总版本数' AS metric,
    COUNT(*) AS value
FROM dbo.${tableName}
UNION ALL
SELECT
    '${hasVersionKey ? '客户' : '业务键去重'}数',
    COUNT(DISTINCT ${businessKeySnake})
FROM dbo.${tableName}
UNION ALL
SELECT
    '当前有效版本数',
    COUNT(*)
FROM dbo.${tableName}
WHERE dw_is_current_flg = 1
UNION ALL
SELECT
    '历史版本数',
    COUNT(*)
FROM dbo.${tableName}
WHERE dw_is_current_flg = 0
UNION ALL
SELECT
    '期初版本数',
    COUNT(*)
FROM dbo.${tableName}
WHERE dw_is_initial_flg = 1;

-- 版本分布统计
PRINT '';
PRINT '版本分布统计:';

SELECT
    version_count AS '版本数',
    COUNT(*) AS '${hasVersionKey ? '客户' : '实体'}数'
FROM (
    SELECT
        ${businessKeySnake},
        COUNT(*) AS version_count
    FROM dbo.${tableName}
    GROUP BY ${businessKeySnake}
) t
GROUP BY version_count
ORDER BY version_count;` : `SELECT
    '总记录数' AS metric,
    COUNT(*) AS value
FROM dbo.${tableName}
UNION ALL
SELECT
    '业务键去重数',
    COUNT(DISTINCT ${businessKeySnake})
FROM dbo.${tableName};`}

PRINT '';
PRINT '========================================';
PRINT '全量初始化执行完成';
PRINT '========================================';
`;

            return script;
        }

        // 生成增量加载脚本（SCD2 增量 ETL）
        function generateIncrementalScript(tableName, tableComment, scdConfig, sourceTables, advancedSqlConfig) {
            const { scdType, businessKey, trackFields, fieldMappings, derivedFields, options } = scdConfig;
            const isHybridOrScd2 = scdType === 'SCD2' || scdType === 'HYBRID';
            // HYBRID 模式：按 scdStrategy 分组字段
            const scd2Fields = scdType === 'HYBRID'
                ? (fieldMappings || []).filter(m => (m.scdStrategy || 'SCD2') === 'SCD2')
                : (fieldMappings || []);
            const scd1Fields = scdType === 'HYBRID'
                ? (fieldMappings || []).filter(m => m.scdStrategy === 'SCD1')
                : [];
            const primaryTable = sourceTables.find(t => t.isPrimary);
            const primaryAlias = primaryTable?.alias || 'src';
            const primaryTableName = primaryTable?.name || 'ods_source_table';

            // 生成代理键名：dim_official_customer → sk_official_customer
            const skName = tableName.replace(/^dim_/, 'sk_');

            // 构建 FROM 子句（含高级 SQL 配置）
            const fromClause = buildFromClause(sourceTables, advancedSqlConfig);
            const types = advancedSqlConfig?.types || [];
            const hasAdvancedSql = types.length > 0;

            // 构建 CTE 前缀
            const ctePrefix = buildCtePrefix(advancedSqlConfig);

            // 构建源表注释
            const sourceTablesComment = sourceTables.map(t => {
                if (t.isPrimary) {
                    return `- ${t.name} AS ${t.alias} (主表)`;
                } else {
                    return `- ${t.name} AS ${t.alias} (${t.joinType || 'LEFT JOIN'})`;
                }
            }).join('\n    ');

            // 高级配置注释
            let advancedComment = '';
            if (types.includes('APPLY')) advancedComment += 'OUTER APPLY ';
            if (types.includes('CTE')) advancedComment += 'CTE ';
            if (types.includes('CUSTOM_FROM')) advancedComment += '自定义FROM ';

            // 派生字段注释
            const derivedFieldsComment = derivedFields && derivedFields.length > 0
                ? derivedFields.map(f => `- ${f.name}: ${f.exprType || '表达式'}`).join('\n    ')
                : '无';

            // 业务键转 snake_case
            const businessKeySnake = toSnakeCase(businessKey);

            // 找到业务键对应的源字段
            const businessKeyMapping = fieldMappings?.find(m =>
                m.targetField.toLowerCase() === businessKeySnake ||
                m.srcField.toLowerCase() === businessKey.toLowerCase()
            );
            const businessKeySrcField = businessKeyMapping
                ? `${primaryAlias}.${businessKeyMapping.srcField}`
                : `${primaryAlias}.${businessKey}`;

            // 构建跟踪字段比较表达式（用于检测变化）
            // HYBRID 模式：只对 SCD2 字段做变更检测
            let compareFields = '';
            const effectiveTrackFields = scdType === 'HYBRID'
                ? (trackFields || []).filter(tf => {
                    const mapping = fieldMappings?.find(m => m.srcField === tf);
                    return !mapping || (mapping.scdStrategy || 'SCD2') === 'SCD2';
                })
                : trackFields;
            if (effectiveTrackFields && effectiveTrackFields.length > 0) {
                compareFields = effectiveTrackFields.map(tf => {
                    // trackFields 存的是源字段 PascalCase（如 ChangeID），按 srcField 匹配
                    const mapping = fieldMappings?.find(m => m.srcField === tf);
                    const srcAlias = mapping?.sourceTable || primaryAlias;
                    const srcField = mapping?.srcField || tf;
                    const targetField = mapping?.targetField || toSnakeCase(tf);
                    return `ISNULL(CAST(tgt.${targetField} AS NVARCHAR(MAX)), '') <> ISNULL(CAST(${srcAlias}.${srcField} AS NVARCHAR(MAX)), '')`;
                }).join('\n            OR ');
            } else if (fieldMappings && fieldMappings.length > 0) {
                // 没有配置跟踪字段时，使用所有字段映射
                compareFields = fieldMappings.map(m => {
                    const srcAlias = m.sourceTable || primaryAlias;
                    return `ISNULL(CAST(tgt.${m.targetField} AS NVARCHAR(MAX)), '') <> ISNULL(CAST(${srcAlias}.${m.srcField} AS NVARCHAR(MAX)), '')`;
                }).join('\n            OR ');
            }

            // ========== 构建 INSERT 字段列表 ==========
            let insertFields = [];

            // 1. 业务键
            insertFields.push(`    ${businessKeySnake}`);

            // 2. 业务字段（排除业务键）
            if (fieldMappings && fieldMappings.length > 0) {
                fieldMappings.forEach(m => {
                    if (m.targetField.toLowerCase() !== businessKeySnake) {
                        insertFields.push(`    ${m.targetField}`);
                    }
                });
            }

            // 3. 派生字段
            if (derivedFields && derivedFields.length > 0) {
                derivedFields.forEach(f => {
                    insertFields.push(`    ${f.name}`);
                });
            }

            // 4. SCD2/HYBRID 控制字段
            if (isHybridOrScd2) {
                insertFields.push(`    dw_eff_dt`);
                insertFields.push(`    dw_exp_dt`);
                insertFields.push(`    dw_is_current_flg`);
                insertFields.push(`    dw_is_initial_flg`);
            }

            // 5. 审计字段
            insertFields.push(`    dw_load_ts`);
            insertFields.push(`    dw_update_ts`);
            insertFields.push(`    dw_src_sys`);
            insertFields.push(`    dw_batch_id`);

            // ========== 构建 SELECT 字段列表 ==========
            let selectFields = [];

            // 1. 业务键
            selectFields.push(`    ${businessKeySrcField} AS ${businessKeySnake}`);

            // 2. 业务字段
            if (fieldMappings && fieldMappings.length > 0) {
                fieldMappings.forEach(m => {
                    if (m.targetField.toLowerCase() !== businessKeySnake) {
                        const srcAlias = m.sourceTable || primaryAlias;
                        selectFields.push(`    ${srcAlias}.${m.srcField} AS ${m.targetField}`);
                    }
                });
            }

            // 3. 派生字段（使用表达式）
            if (derivedFields && derivedFields.length > 0) {
                derivedFields.forEach(f => {
                    let exprSql = '';
                    if (f.exprType && f.exprConfig) {
                        exprSql = generateExpressionSQL(f.exprType, f.exprConfig);
                    } else if (f.source) {
                        exprSql = f.source;
                    }

                    if (exprSql) {
                        selectFields.push(`    ${exprSql} AS ${f.name}`);
                    } else {
                        selectFields.push(`    NULL AS ${f.name} /* TODO: 配置表达式 */`);
                    }
                });
            }

            // 4. SCD2/HYBRID 控制字段
            if (isHybridOrScd2) {
                selectFields.push(`    CAST(@load_ts AS DATE) AS dw_eff_dt`);
                selectFields.push(`    CAST('9999-12-31' AS DATE) AS dw_exp_dt`);
                selectFields.push(`    1 AS dw_is_current_flg`);
                selectFields.push(`    0 AS dw_is_initial_flg`);
            }

            // 5. 审计字段
            selectFields.push(`    @load_ts AS dw_load_ts`);
            selectFields.push(`    @load_ts AS dw_update_ts`);
            selectFields.push(`    'BMS' AS dw_src_sys`);
            selectFields.push(`    @batch_id AS dw_batch_id`);

            // ========== 生成完整脚本 ==========
            let script = `/*
================================================================================
  ${tableComment || tableName} - 增量 ETL 脚本

  用途：日常增量更新 ${tableName} 表 (SCD2)
  执行方式：调度系统定时执行

  目标表: dbo.${tableName}
  SCD类型: ${scdType}
  业务标识: ${businessKey}
  跟踪字段: ${trackFields ? trackFields.join(', ') : '全部字段'}

  源表:
    ${sourceTablesComment}
  ${advancedComment ? `高级配置: ${advancedComment}` : ''}

  派生字段:
    ${derivedFieldsComment}

  处理逻辑:
    1. 检测变更：比对跟踪字段，找出有变化的记录
    2. 关闭旧版本：将变更记录的当前版本设为失效
    3. 插入新版本：插入变更后的新版本 + 全新记录
    ${options?.deleteDetection ? '4. 删除检测：检测源表已删除的记录并关闭' : ''}

  生成日期: ${new Date().toISOString().split('T')[0]}
================================================================================
*/

DECLARE @batch_id VARCHAR(50) = 'INCR_' + FORMAT(GETDATE(), 'yyyyMMddHHmmss');
DECLARE @load_ts DATETIME = GETDATE();
DECLARE @updated INT = 0, @inserted INT = 0;

PRINT '========================================';
PRINT '开始执行 ${tableName} 增量 ETL';
PRINT '批次号: ' + @batch_id;
PRINT '执行时间: ' + CONVERT(VARCHAR, GETDATE(), 120);
PRINT '========================================';

`;

            if (isHybridOrScd2) {
                script += `-- ============================================================================
-- Step 1: 关闭已变更记录的当前版本
-- ============================================================================

PRINT '';
PRINT 'Step 1: 关闭变更记录的旧版本';

${ctePrefix}UPDATE tgt
SET
    dw_exp_dt = CAST(@load_ts AS DATE),
    dw_is_current_flg = 0,
    dw_update_ts = @load_ts
FROM dbo.${tableName} tgt
INNER JOIN (
    SELECT ${businessKeySrcField} AS bk
    FROM ${fromClause}
) src_data ON tgt.${businessKeySnake} = src_data.bk
WHERE tgt.dw_is_current_flg = 1
    AND EXISTS (
        SELECT 1
        FROM ${fromClause}
        WHERE ${businessKeySrcField} = tgt.${businessKeySnake}
            AND (
                ${compareFields || '1=0  -- 请配置跟踪字段'}
            )
    );

SET @updated = @@ROWCOUNT;
PRINT '  - 关闭旧版本记录: ' + CAST(@updated AS VARCHAR) + ' 条';


-- ============================================================================
-- Step 2: 插入新版本（变更记录 + 新增记录）
-- ============================================================================

PRINT '';
PRINT 'Step 2: 插入新版本记录';

${ctePrefix}INSERT INTO dbo.${tableName} (
${insertFields.join(',\n')}
)
SELECT
${selectFields.join(',\n')}
FROM ${fromClause}
WHERE NOT EXISTS (
    -- 排除已存在且无变化的记录
    SELECT 1 FROM dbo.${tableName} tgt
    WHERE tgt.${businessKeySnake} = ${businessKeySrcField}
        AND tgt.dw_is_current_flg = 1
        AND NOT (
            ${compareFields || '1=0  -- 请配置跟踪字段'}
        )
);

SET @inserted = @@ROWCOUNT;
PRINT '  - 插入新版本记录: ' + CAST(@inserted AS VARCHAR) + ' 条';
`;

                // 删除检测
                if (options?.deleteDetection) {
                    script += `

-- ============================================================================
-- Step 3: 删除检测（源表中已删除的记录）
-- ============================================================================

PRINT '';
PRINT 'Step 3: 删除检测';

UPDATE tgt
SET
    dw_exp_dt = CAST(@load_ts AS DATE),
    dw_is_current_flg = 0,
    dw_update_ts = @load_ts
FROM dbo.${tableName} tgt
WHERE tgt.dw_is_current_flg = 1
    AND NOT EXISTS (
        SELECT 1
        FROM ${fromClause}
        WHERE ${businessKeySrcField} = tgt.${businessKeySnake}
    );

PRINT '  - 删除检测关闭记录: ' + CAST(@@ROWCOUNT AS VARCHAR) + ' 条';
`;
                }

                // 审计日志
                if (options?.auditLog) {
                    script += `

-- ============================================================================
-- Step ${options?.deleteDetection ? '4' : '3'}: 写入审计日志
-- ============================================================================

PRINT '';
PRINT 'Step ${options?.deleteDetection ? '4' : '3'}: 写入审计日志';

INSERT INTO dbo.dw_audit_log (table_name, data_layer, audit_type, audit_level, affected_count, batch_id, created_at)
VALUES
    ('${tableName}', 'DIM', 'CLOSE_VERSION', 'INFO', @updated, @batch_id, @load_ts),
    ('${tableName}', 'DIM', 'INSERT_VERSION', 'INFO', @inserted, @batch_id, @load_ts);

PRINT '  - 审计日志已写入';
`;
                }

                // HYBRID 模式：SCD1 字段从主表覆盖更新
                // 排除：业务键（JOIN 条件）、版本键（变更表独有）、一致性排除字段（主表不存在）
                const versionKeySrc = scdConfig.versionKey || '';
                const incrExcludeFields = options?.consistencyExcludeFields || [];
                const incrScd1ExcludeSet = new Set([
                    businessKey.toLowerCase(),
                    ...(versionKeySrc ? [versionKeySrc.toLowerCase()] : []),
                    ...incrExcludeFields.map(f => f.toLowerCase())
                ]);
                const scd1FieldsForUpdate = scd1Fields.filter(m =>
                    !incrScd1ExcludeSet.has(m.srcField.toLowerCase())
                );
                if (scd1FieldsForUpdate.length > 0) {
                    const scd1CompareFields = scd1FieldsForUpdate.map(m => {
                        const srcAlias = m.sourceTable || primaryAlias;
                        return `ISNULL(CAST(tgt.${m.targetField} AS NVARCHAR(MAX)), '') <> ISNULL(CAST(${srcAlias}.${m.srcField} AS NVARCHAR(MAX)), '')`;
                    }).join('\n            OR ');
                    const scd1UpdateSet = scd1FieldsForUpdate.map(m => {
                        const srcAlias = m.sourceTable || primaryAlias;
                        return `    tgt.${m.targetField} = ${srcAlias}.${m.srcField}`;
                    }).join(',\n');

                    script += `

-- ============================================================================
-- Step SCD1: 非关键字段从主表覆盖更新（不触发新版本）
-- ============================================================================

PRINT '';
PRINT 'Step SCD1: 非关键字段覆盖更新';

${ctePrefix}UPDATE tgt
SET
${scd1UpdateSet},
    tgt.dw_update_ts = @load_ts,
    tgt.dw_batch_id = @batch_id
FROM dbo.${tableName} tgt
INNER JOIN ${fromClause.split(/\s+(LEFT|INNER|RIGHT|OUTER|CROSS)\s+JOIN/i)[0].trim()} ON tgt.${businessKeySnake} = ${businessKeySrcField}
WHERE tgt.dw_is_current_flg = 1
    AND (
        ${scd1CompareFields}
    );

PRINT '  - SCD1 字段覆盖更新: ' + CAST(@@ROWCOUNT AS VARCHAR) + ' 条';
`;
                }

            } else {
                // SCD1 增量加载（MERGE）
                script += `-- ============================================================================
-- SCD1 增量加载逻辑（MERGE）
-- ============================================================================

${ctePrefix}MERGE INTO dbo.${tableName} AS tgt
USING (
    SELECT
${selectFields.join(',\n')}
    FROM ${fromClause}
) AS src
    ON tgt.${businessKeySnake} = src.${businessKeySnake}

WHEN MATCHED AND (
    ${compareFields || '1=0  -- 请配置跟踪字段'}
) THEN
    UPDATE SET
${fieldMappings && fieldMappings.length > 0 ? fieldMappings.filter(m => m.targetField.toLowerCase() !== businessKeySnake).map(m => `        tgt.${m.targetField} = src.${m.targetField}`).join(',\n') : '        -- 无字段映射'}${derivedFields && derivedFields.length > 0 ? ',\n' + derivedFields.map(f => `        tgt.${f.name} = src.${f.name}`).join(',\n') : ''},
        tgt.dw_update_ts = @load_ts,
        tgt.dw_batch_id = @batch_id

WHEN NOT MATCHED BY TARGET THEN
    INSERT (
${insertFields.join(',\n')}
    )
    VALUES (
${insertFields.map(f => `        src.${f.trim()}`).join(',\n')}
    )`;

                // SCD1 删除检测
                if (options?.deleteDetection) {
                    script += `

WHEN NOT MATCHED BY SOURCE THEN
    DELETE`;
                }

                script += `;

SET @updated = @@ROWCOUNT;
PRINT 'MERGE 操作完成，影响记录: ' + CAST(@updated AS VARCHAR) + ' 条';
`;

                // 审计日志
                if (options?.auditLog) {
                    script += `
-- 写入审计日志
INSERT INTO dbo.dw_audit_log (table_name, data_layer, audit_type, audit_level, affected_count, batch_id, created_at)
VALUES ('${tableName}', 'DIM', 'MERGE', 'INFO', @updated, @batch_id, @load_ts);
`;
                }
            }

            script += `

-- ============================================================================
-- 执行统计
-- ============================================================================

PRINT '';
PRINT '========================================';
PRINT '增量 ETL 执行完成';
PRINT '关闭旧版本: ' + CAST(@updated AS VARCHAR) + ' 条';
PRINT '插入新版本: ' + CAST(@inserted AS VARCHAR) + ' 条';
PRINT '========================================';
`;

            return script;
        }

        // ==================== FDL 审计日志 Helper 函数 ====================

        /**
         * 构建 record_key JSON 字符串（支持 businessKey + 可选 versionKey 复合键）
         */
        function buildRecordKey(alias, businessKeySnake, versionKeySnake) {
            if (versionKeySnake) {
                return `'{"${businessKeySnake}":' + CAST(${alias}.${businessKeySnake} AS VARCHAR) + ',"${versionKeySnake}":' + CAST(${alias}.${versionKeySnake} AS VARCHAR) + '}'`;
            }
            return `'{"${businessKeySnake}":' + CAST(${alias}.${businessKeySnake} AS VARCHAR) + '}'`;
        }

        /**
         * 生成审计日志 FOR JSON 的完整字段列表（替代 .slice(0,5) 截断）
         * @param {string} alias - 表别名 (d/c/m/nc)
         * @param {Array} fieldMappings - 字段映射数组
         * @param {Array} derivedFields - 派生字段数组
         * @param {string} businessKeySnake - 业务键 snake_case
         * @param {boolean} includeControlFields - 是否包含 SCD2 控制字段
         * @returns {string} SQL SELECT 字段列表
         */
        function buildAuditJsonSnapshot(alias, fieldMappings, derivedFields, businessKeySnake, includeControlFields) {
            const lines = [];
            lines.push(`            ${alias}.${businessKeySnake}`);
            if (fieldMappings && fieldMappings.length > 0) {
                fieldMappings.forEach(m => {
                    if (m.targetField.toLowerCase() !== businessKeySnake) {
                        lines.push(`            ${alias}.${m.targetField}`);
                    }
                });
            }
            if (derivedFields && derivedFields.length > 0) {
                derivedFields.forEach(f => {
                    lines.push(`            ${alias}.${f.name}`);
                });
            }
            if (includeControlFields) {
                lines.push(`            ${alias}.dw_eff_dt`);
                lines.push(`            ${alias}.dw_exp_dt`);
                lines.push(`            ${alias}.dw_is_current_flg`);
            }
            return lines.join(',\n');
        }

        /**
         * 生成 MODIFIED/INCONSISTENT 审计的 before/after JSON SELECT 列表
         * @param {string} dimAlias - DIM 表别名 (d)
         * @param {string} srcAlias - 源表别名 (c/m)
         * @param {Array} fieldMappings - 字段映射数组
         * @param {string} businessKeySnake - 业务键
         * @param {string} labelBefore - before 标签 ('before' 或 'dim')
         * @param {string} labelAfter - after 标签 ('after' 或 'source')
         * @returns {{before: string, after: string}}
         */
        function buildAuditBeforeAfter(dimAlias, srcAlias, fieldMappings, businessKeySnake, labelBefore, labelAfter) {
            const beforeLines = [];
            const afterLines = [];
            beforeLines.push(`            '${labelBefore || 'before'}' AS change_type`);
            afterLines.push(`            '${labelAfter || 'after'}' AS change_type`);
            if (fieldMappings && fieldMappings.length > 0) {
                fieldMappings.forEach(m => {
                    if (m.targetField.toLowerCase() !== businessKeySnake) {
                        beforeLines.push(`            ${dimAlias}.${m.targetField}`);
                        afterLines.push(`            ${srcAlias}.${m.srcField} AS ${m.targetField}`);
                    }
                });
            }
            return {
                before: beforeLines.join(',\n'),
                after: afterLines.join(',\n')
            };
        }

        /**
         * 生成扁平对偶格式的审计 JSON（Step 5 一致性告警用）
         * 输出格式：dim_name/master_name 交替排列，单个 SELECT FOR JSON
         */
        function buildAuditFlatPairs(dimAlias, srcAlias, fieldMappings, businessKeySnake) {
            const lines = [];
            lines.push(`            ${dimAlias}.${businessKeySnake}`);
            if (fieldMappings && fieldMappings.length > 0) {
                fieldMappings.forEach(m => {
                    if (m.targetField.toLowerCase() !== businessKeySnake) {
                        const label = m.diffLabel || m.targetField;
                        lines.push(`            ${dimAlias}.${m.targetField} AS dim_${label}`);
                        lines.push(`            ${srcAlias}.${m.srcField} AS master_${label}`);
                    }
                });
            }
            return lines.join(',\n');
        }

        /**
         * 生成 STUFF() diff_fields 表达式（列出所有变更字段名）
         * @param {string} dimAlias - DIM 表别名
         * @param {string} srcAlias - 源表别名
         * @param {Array} fieldMappings - 字段映射数组
         * @param {string} businessKeySnake - 业务键
         * @returns {string} STUFF() SQL 表达式
         */
        function buildDiffFieldsStuff(dimAlias, srcAlias, fieldMappings, businessKeySnake) {
            if (!fieldMappings || fieldMappings.length === 0) return "''";
            const diffParts = fieldMappings
                .filter(m => m.targetField.toLowerCase() !== businessKeySnake)
                .map(m => {
                    const dataType = (m.dataType || '').toLowerCase();
                    const isStringByType = dataType.startsWith('nvarchar') || dataType.startsWith('varchar') || dataType === 'ntext' || dataType === 'text';
                    const isStringByName = ['name', 'code', 'memo', 'address', 'tel', 'paragraph', 'license', 'fields', 'man', 'ids', 'union'].some(k => m.targetField.toLowerCase().includes(k));
                    const defaultVal = (isStringByType || isStringByName) ? "''" : '0';
                    return `        ISNULL(CASE WHEN ISNULL(${dimAlias}.${m.targetField}, ${defaultVal}) <> ISNULL(${srcAlias}.${m.srcField}, ${defaultVal})\n             THEN ', ${m.diffLabel || m.targetField}' END, '')`;
                });
            if (diffParts.length === 0) return "''";
            return `STUFF(\n${diffParts.join(' +\n')},\n        1, 2, ''  -- 去掉开头的 ', '\n    )`;
        }

        // 生成 FDL 节点配置脚本（FineDataLink 数据开发版）
        function generateFdlNodeScript(tableName, tableComment, scdConfig, sourceTables, advancedSqlConfig) {
            const { scdType, businessKey, versionKey, trackFields, fieldMappings, derivedFields, options } = scdConfig;
            const isHybridOrScd2 = scdType === 'SCD2' || scdType === 'HYBRID';
            // HYBRID 模式：按 scdStrategy 分组字段
            const scd2Fields = scdType === 'HYBRID'
                ? (fieldMappings || []).filter(m => (m.scdStrategy || 'SCD2') === 'SCD2')
                : (fieldMappings || []);
            const scd1Fields = scdType === 'HYBRID'
                ? (fieldMappings || []).filter(m => m.scdStrategy === 'SCD1')
                : [];
            const primaryTable = sourceTables.find(t => t.isPrimary);
            const primaryAlias = primaryTable?.alias || 'src';
            const primaryTableName = primaryTable?.name || 'ods_source_table';

            // FDL 高级选项
            const stateFilter = options?.stateFilter;  // WHERE 表达式字符串，如 "c.State = 3"
            const versionOrderField = options?.versionOrderField;  // 源表字段名（将转 snake_case）
            const consistencySrc = options?.consistencySourceTable;  // { name, alias, joinField }
            const consistencyExcludeFields = options?.consistencyExcludeFields || [];

            // 业务键转 snake_case
            const businessKeySnake = toSnakeCase(businessKey);

            // 找到业务键对应的源字段
            const businessKeyMapping = fieldMappings?.find(m =>
                m.targetField.toLowerCase() === businessKeySnake ||
                m.srcField.toLowerCase() === businessKey.toLowerCase()
            );
            const businessKeySrcField = businessKeyMapping?.srcField || businessKey;

            // 版本键（多版本 SCD2：一个 businessKey 对应多行，versionKey 唯一标识每行）
            const hasVersionKey = versionKey && versionKey.trim() !== '';
            const versionKeySnake = hasVersionKey ? toSnakeCase(versionKey) : null;
            const versionKeyMapping = hasVersionKey ? fieldMappings?.find(m =>
                m.targetField.toLowerCase() === versionKeySnake?.toLowerCase() ||
                m.srcField.toLowerCase() === versionKey.toLowerCase()
            ) : null;
            const versionKeySrcField = hasVersionKey ? (versionKeyMapping?.srcField || versionKey) : null;
            const joinKeySnake = versionKeySnake || businessKeySnake;
            const joinKeySrcField = versionKeySrcField || businessKeySrcField;

            // 状态过滤条件（Step 1/2/3 WHERE 附加）
            // 状态过滤条件（Step 1/2/3 WHERE 附加），兼容旧格式 { field, value } 和新格式字符串
            const stateFilterExpr = typeof stateFilter === 'string'
                ? stateFilter
                : (stateFilter?.field ? `c.${stateFilter.field} = ${stateFilter.value}` : '');
            const stateFilterClause = stateFilterExpr ? `\n  AND ${stateFilterExpr}` : '';

            // 版本链排序字段（Step 3 ROW_NUMBER, Step 4 LEAD/ROW_NUMBER）
            const versionOrderSnake = versionOrderField ? toSnakeCase(versionOrderField) : null;
            const versionOrderAsc = versionOrderSnake
                ? `d.${versionOrderSnake}, d.dw_eff_dt, d.dw_load_ts`
                : 'd.dw_eff_dt, d.dw_load_ts';
            const versionOrderDesc = versionOrderSnake
                ? `d.${versionOrderSnake} DESC, d.dw_eff_dt DESC, d.dw_load_ts DESC`
                : 'd.dw_eff_dt DESC, d.dw_load_ts DESC';
            // Step 3 源表排序（用源表字段名）
            const step3OrderBy = versionOrderField
                ? `c.${versionOrderField}, c.${businessKeySrcField}`
                : `c.${businessKeySrcField}`;

            // 一致性对比源表（Step 5）
            const consistencyTableName = consistencySrc?.name || primaryTableName;
            const consistencyAlias = consistencySrc?.alias || 'm';
            const consistencyJoinField = consistencySrc?.joinField || businessKeySrcField;

            // dw_eff_dt 生效日期表达式（Step 3 INSERT，将主表别名替换为 c）
            const effDtExprRaw = options?.effDtExpr || 'CAST(GETDATE() AS DATE)';
            const effDtExpression = primaryAlias !== 'c' && options?.effDtExpr
                ? effDtExprRaw.replace(new RegExp(`\\b${primaryAlias}\\.`, 'g'), 'c.')
                : effDtExprRaw;
            const effDtIsCustom = !!options?.effDtExpr;
            const effDtCteAlias = 'eff_dt_calc';

            // 构建源表注释
            const sourceTablesComment = sourceTables.map(t => {
                if (t.isPrimary) {
                    return `- ${t.name} AS ${t.alias} (主表)`;
                } else {
                    return `- ${t.name} AS ${t.alias} (${t.joinType || 'LEFT JOIN'})`;
                }
            }).join('\n    ');

            // 生成代理键名：dim_official_customer → sk_official_customer
            const skName = tableName.replace(/^dim_/, 'sk_');

            // 构建字段比较表达式（用于检测变化）- FDL 版本使用 d 和 c 作为别名
            // HYBRID 模式：只对 SCD2 字段做变更检测（SCD1 字段在 Step 2b 单独处理）
            let compareFieldsForUpdate = '';
            let compareFieldsForWhere = '';
            const trackedFields = scdType === 'HYBRID'
                ? scd2Fields.map(m => m.srcField)
                : (trackFields && trackFields.length > 0 ? trackFields : (fieldMappings || []).map(m => m.targetField));

            if (trackedFields.length > 0) {
                compareFieldsForWhere = trackedFields.map(tf => {
                    // trackFields 存的是源字段 PascalCase（如 ChangeID），按 srcField 匹配
                    const mapping = fieldMappings?.find(m => m.srcField === tf);
                    const srcField = mapping?.srcField || tf;
                    const targetField = mapping?.targetField || toSnakeCase(tf);
                    // 判断字段类型决定默认值：优先用 dataType，回退到字段名关键字匹配
                    const dataType = (mapping?.dataType || '').toLowerCase();
                    const isStringByType = dataType.startsWith('nvarchar') || dataType.startsWith('varchar') || dataType === 'ntext' || dataType === 'text';
                    const isStringByName = ['name', 'code', 'memo', 'address', 'tel', 'paragraph', 'license', 'fields', 'man', 'ids', 'union'].some(k => targetField.toLowerCase().includes(k));
                    const isStringField = isStringByType || isStringByName;
                    const defaultVal = isStringField ? "''" : '0';
                    return `ISNULL(d.${targetField}, ${defaultVal}) <> ISNULL(c.${srcField}, ${defaultVal})`;
                }).join('\n      OR ');
            }

            // 一致性排除字段过滤（Step 5 使用：排除变更表独有、主表无此字段的字段）
            // 版本键自动排除：versionKey 是变更表独有字段，主表不存在
            // HYBRID 模式：SCD1 字段自动排除（由 Step 2b 覆盖更新，无需一致性告警）
            const excludeSet = new Set([
                ...consistencyExcludeFields.map(f => f.toLowerCase()),
                ...(hasVersionKey ? [versionKey.toLowerCase()] : []),
                ...scd1Fields.map(m => m.srcField.toLowerCase())
            ]);
            const consistencyFieldMappings = excludeSet.size > 0
                ? (fieldMappings || []).filter(m => !excludeSet.has(m.srcField.toLowerCase()))
                : fieldMappings;
            const compareFieldsForConsistency = excludeSet.size > 0
                ? trackedFields.filter(tf => !excludeSet.has(tf.toLowerCase())).map(tf => {
                    const mapping = fieldMappings?.find(m => m.srcField === tf);
                    const srcField = mapping?.srcField || tf;
                    const targetField = mapping?.targetField || toSnakeCase(tf);
                    const dataType = (mapping?.dataType || '').toLowerCase();
                    const isStringByType = dataType.startsWith('nvarchar') || dataType.startsWith('varchar') || dataType === 'ntext' || dataType === 'text';
                    const isStringByName = ['name', 'code', 'memo', 'address', 'tel', 'paragraph', 'license', 'fields', 'man', 'ids', 'union'].some(k => targetField.toLowerCase().includes(k));
                    const defaultVal = (isStringByType || isStringByName) ? "''" : '0';
                    return `ISNULL(d.${targetField}, ${defaultVal}) <> ISNULL(c.${srcField}, ${defaultVal})`;
                }).join('\n      OR ')
                : compareFieldsForWhere;

            // 构建 UPDATE SET 子句（排除业务键，业务键是 JOIN 条件不需要更新）
            const updateSetFields = (fieldMappings || [])
                .filter(m => m.targetField.toLowerCase() !== businessKeySnake)
                .map(m => {
                    return `    d.${m.targetField} = c.${m.srcField}`;
                });

            // 添加派生字段的 UPDATE SET（需要关联字典表）
            const derivedUpdateFields = (derivedFields || []).map(f => {
                if (f.exprType === 'REF' && f.exprConfig?.expression) {
                    // 提取别名和字段名
                    const expr = f.exprConfig.expression;
                    return `    d.${f.name} = ${expr.replace(/^[a-z]+\./, match => match)}`;
                }
                return null;
            }).filter(Boolean);

            // 构建 INSERT 字段列表
            const insertFields = [
                `    -- 业务键`,
                `    ${businessKeySnake}`,
            ];
            if (fieldMappings && fieldMappings.length > 0) {
                insertFields.push(`    -- 业务字段`);
                fieldMappings.forEach(m => {
                    if (m.targetField.toLowerCase() !== businessKeySnake) {
                        insertFields.push(`    ${m.targetField}`);
                    }
                });
            }
            if (derivedFields && derivedFields.length > 0) {
                insertFields.push(`    -- 派生字段`);
                derivedFields.forEach(f => {
                    insertFields.push(`    ${f.name}`);
                });
            }
            insertFields.push(`    -- SCD2 控制字段`);
            insertFields.push(`    dw_eff_dt`);
            insertFields.push(`    dw_exp_dt`);
            insertFields.push(`    dw_is_current_flg`);
            insertFields.push(`    dw_is_initial_flg`);
            insertFields.push(`    -- 审计字段`);
            insertFields.push(`    dw_load_ts`);
            insertFields.push(`    dw_src_sys`);
            insertFields.push(`    dw_batch_id`);

            // 构建 SELECT 字段列表
            const selectFields = [
                `    nc.${businessKeySrcField}`,
            ];
            if (fieldMappings && fieldMappings.length > 0) {
                fieldMappings.forEach(m => {
                    if (m.targetField.toLowerCase() !== businessKeySnake) {
                        selectFields.push(`    nc.${m.srcField}`);
                    }
                });
            }

            // 主表别名替换工具（将 joinCondition/applyContent 中的主表别名替换为指定别名）
            const replacePrimaryAlias = (str, targetAlias) => {
                if (primaryAlias === targetAlias) return str;
                return str.replace(new RegExp(`\\b${primaryAlias}\\.`, 'g'), `${targetAlias}.`);
            };

            // 派生字段 SELECT
            if (derivedFields && derivedFields.length > 0) {
                derivedFields.forEach(f => {
                    let exprSql = '';
                    if (f.exprType && f.exprConfig) {
                        exprSql = generateExpressionSQL(f.exprType, f.exprConfig);
                        // 替换主表别名前缀为 nc（new_records CTE 别名）
                        exprSql = replacePrimaryAlias(exprSql, 'nc');
                    }
                    if (exprSql) {
                        selectFields.push(`    ${exprSql}`);
                    } else {
                        selectFields.push(`    NULL /* ${f.name}: TODO */`);
                    }
                });
            }

            // 构建 JOIN 子句（保留原始别名，使用时按需替换）
            const joinClauses = sourceTables.filter(t => !t.isPrimary && t.joinCondition).map(t => {
                return `LEFT JOIN ${t.name} ${t.alias} ON ${t.joinCondition}`;
            });

            // 构建 CTE（如果有）
            let cteSection = '';
            const types = advancedSqlConfig?.types || [];
            if (types.includes('CTE') && advancedSqlConfig?.cteContent) {
                cteSection = advancedSqlConfig.cteContent;
            }

            // 构建 OUTER APPLY（如果有）
            let applySection = '';
            if (types.includes('APPLY') && advancedSqlConfig?.applyContent) {
                applySection = advancedSqlConfig.applyContent;
            }

            // ========== 生成完整的 FDL 脚本 ==========
            // batch_id 统一使用 INCR_ 前缀 + 紧凑时间戳格式
            const batchIdExpr = `'INCR_' + REPLACE(REPLACE(REPLACE('\${cyctime}', '-', ''), ' ', ''), ':', '')`;

            let script = `/*
================================================================================
  ${tableComment || tableName} - FineDataLink 数据开发版 ETL 脚本

  用途：在 FineDataLink 数据开发任务中执行 SCD2 增量加载
  方案：6 个 SQL 脚本节点，使用内置参数 '\${cyctime}' 生成 INCR_ 前缀批次号

  配置方式：
    1. 创建数据开发任务（不是管道）
    2. 添加 6 个 SQL 脚本节点
    3. 按顺序连接各节点
    4. 所有节点连接到同一个数仓数据源
    5. 在任务属性中添加自定义参数: cyctime = $cyctime（内置调度时间）

  节点结构：
    [Step 1] → [Step 2] → [Step 3] → [Step 4] → [Step 5] → [Step 6]

  参数说明：
    - '\${cyctime}': FDL 内置参数，格式如 2026-01-24 10:30:00
    - 批次号格式: INCR_ + 紧凑时间戳（如 INCR_20260124103000）

  目标表: dbo.${tableName}
  SCD类型: ${scdType}
  业务标识: ${businessKey}
  跟踪字段: ${trackFields ? trackFields.join(', ') : '全部字段'}

  源表:
    ${sourceTablesComment}

  生成日期: ${new Date().toISOString().split('T')[0]}
================================================================================
*/


-- ============================================================================
-- 【节点 1】SQL脚本 - Step 1 删除检测
-- 说明：源表已删除的记录，从 dim 表删除，并记录审计日志
-- ============================================================================
/*
节点类型: SQL脚本
节点名称: Step 1 - 删除检测
数据源: 数仓连接
复制以下 SQL：
*/

-- 1.1 记录待删除的记录到审计表
INSERT INTO dw_audit_log (
    table_name,
    data_layer,
    record_key,
    audit_type,
    audit_level,
    audit_detail,
    source_table,
    batch_id
)
SELECT
    '${tableName}',
    'DIM',
    ${buildRecordKey('d', businessKeySnake, versionKeySnake)},
    'DELETED',
    'WARN',
    (
        SELECT
${buildAuditJsonSnapshot('d', fieldMappings, derivedFields, businessKeySnake, true)}
        FOR JSON PATH, WITHOUT_ARRAY_WRAPPER
    ),
    '${primaryTableName}',
    ${batchIdExpr}
FROM ${tableName} d
WHERE ${hasVersionKey ? `d.${joinKeySnake} IS NOT NULL\n  AND ` : ''}NOT EXISTS (
    SELECT 1
    FROM ${primaryTableName} c
    WHERE c.${joinKeySrcField} = d.${joinKeySnake}${stateFilterClause}
);

-- 1.2 执行删除
DELETE d
FROM ${tableName} d
WHERE ${hasVersionKey ? `d.${joinKeySnake} IS NOT NULL\n  AND ` : ''}NOT EXISTS (
    SELECT 1
    FROM ${primaryTableName} c
    WHERE c.${joinKeySrcField} = d.${joinKeySnake}${stateFilterClause}
);


-- ============================================================================
-- 【节点 2】SQL脚本 - Step 2 修改检测
-- 说明：源表中业务字段发生变化，更新 dim 表
-- ============================================================================
/*
节点类型: SQL脚本
节点名称: Step 2 - 修改检测
数据源: 数仓连接
复制以下 SQL：
*/

-- 2.1 记录待更新的记录到审计表（记录变更前后对比）
INSERT INTO dw_audit_log (
    table_name,
    data_layer,
    record_key,
    audit_type,
    audit_level,
    audit_detail,
    diff_fields,
    source_table,
    batch_id
)
SELECT
    '${tableName}',
    'DIM',
    ${buildRecordKey('d', businessKeySnake, versionKeySnake)},
    'MODIFIED',
    'INFO',
    (
        SELECT
${(() => { const ba = buildAuditBeforeAfter('d', 'c', fieldMappings, businessKeySnake, 'before', 'after'); return ba.before; })()}
        FOR JSON PATH, WITHOUT_ARRAY_WRAPPER
    ) + ',' + (
        SELECT
${(() => { const ba = buildAuditBeforeAfter('d', 'c', fieldMappings, businessKeySnake, 'before', 'after'); return ba.after; })()}
        FOR JSON PATH, WITHOUT_ARRAY_WRAPPER
    ),
    ${buildDiffFieldsStuff('d', 'c', fieldMappings, businessKeySnake)},
    '${primaryTableName}',
    ${batchIdExpr}
FROM ${tableName} d
INNER JOIN ${primaryTableName} c
    ON d.${joinKeySnake} = c.${joinKeySrcField}
WHERE ${hasVersionKey ? '' : 'd.dw_is_current_flg = 1\n  AND '}${stateFilterExpr ? stateFilterExpr + '\n  AND ' : ''}(
      ${compareFieldsForWhere || `1=0  -- TODO: 配置跟踪字段比较条件`}
  );

-- 2.2 执行更新
${cteSection ? `;WITH\n${cteSection}\n` : ''}UPDATE d
SET
${updateSetFields.length > 0 ? updateSetFields.join(',\n') : '    -- TODO: 配置字段更新'}${derivedUpdateFields.length > 0 ? ',\n' + derivedUpdateFields.join(',\n') : ''},
    -- 审计字段
    d.dw_update_ts = GETDATE(),
    d.dw_batch_id = ${batchIdExpr}
FROM ${tableName} d
INNER JOIN ${primaryTableName} c ON d.${joinKeySnake} = c.${joinKeySrcField}
${joinClauses.length > 0 ? joinClauses.map(j => replacePrimaryAlias(j, 'c')).join('\n') : '-- TODO: 添加字典表 JOIN'}
${applySection ? replacePrimaryAlias(applySection, 'c') + '\n' : ''}WHERE ${hasVersionKey ? '' : 'd.dw_is_current_flg = 1\n  AND '}${stateFilterExpr ? stateFilterExpr + '\n  AND ' : ''}(
      ${compareFieldsForWhere || `1=0  -- TODO: 配置跟踪字段比较条件`}
  );

${(() => {
    // HYBRID 模式 Step 2b：SCD1 字段从主表（一致性源表）覆盖更新（不触发新版本）
    // 排除：业务键（JOIN 条件）、版本键（变更表独有）、一致性排除字段（主表不存在的字段）
    const scd1ExcludeSet = new Set([
        businessKeySrcField.toLowerCase(),
        ...(versionKeySrcField ? [versionKeySrcField.toLowerCase()] : []),
        ...consistencyExcludeFields.map(f => f.toLowerCase())
    ]);
    const scd1FieldsForUpdate = scd1Fields.filter(m =>
        !scd1ExcludeSet.has(m.srcField.toLowerCase())
    );
    if (scd1FieldsForUpdate.length === 0 || !consistencyTableName) return '';

    // 判断字段是否为字符串类型（复用 trackedFields 的判断逻辑）
    const getDefaultVal = (m) => {
        const dt = (m.dataType || '').toLowerCase();
        const isStr = dt.startsWith('nvarchar') || dt.startsWith('varchar') || dt === 'ntext' || dt === 'text';
        const isStrByName = ['name', 'code', 'memo', 'address', 'tel', 'paragraph', 'license', 'fields', 'man', 'ids', 'union'].some(k => m.targetField.toLowerCase().includes(k));
        return (isStr || isStrByName) ? "''" : '0';
    };

    const scd1CompareFields = scd1FieldsForUpdate.map(m =>
        `ISNULL(d.${m.targetField}, ${getDefaultVal(m)}) <> ISNULL(${consistencyAlias}.${m.srcField}, ${getDefaultVal(m)})`
    ).join('\n      OR ');

    const scd1UpdateSet = scd1FieldsForUpdate.map(m =>
        `    d.${m.targetField} = ${consistencyAlias}.${m.srcField}`
    ).join(',\n');

    return `

-- ============================================================================
-- 【节点 2b】SQL脚本 - Step 2b SCD1 字段覆盖更新
-- 说明：非关键字段从主表直接取最新值覆盖，不触发新版本
-- ============================================================================
/*
节点类型: SQL脚本
节点名称: Step 2b - SCD1 字段覆盖更新
数据源: 数仓连接
复制以下 SQL：
*/

UPDATE d
SET
${scd1UpdateSet},
    -- 审计字段
    d.dw_update_ts = GETDATE(),
    d.dw_batch_id = ${batchIdExpr}
FROM ${tableName} d
INNER JOIN ${consistencyTableName} ${consistencyAlias}
    ON d.${businessKeySnake} = ${consistencyAlias}.${consistencyJoinField}
WHERE d.dw_is_current_flg = 1
  AND (
      ${scd1CompareFields}
  );
`;
})()}
-- ============================================================================
-- 【节点 3】SQL脚本 - Step 3 新增检测
-- 说明：源表新增的记录，插入 dim 表
-- ============================================================================
/*
节点类型: SQL脚本
节点名称: Step 3 - 新增检测
数据源: 数仓连接
复制以下 SQL：
*/

${cteSection ? `;WITH\n${cteSection},\n` : ';WITH\n'}all_source AS (
    SELECT
        c.${businessKeySrcField},
${fieldMappings && fieldMappings.length > 0 ? fieldMappings.filter(m => m.targetField.toLowerCase() !== businessKeySnake).map(m => `        c.${m.srcField}`).join(',\n') : '        -- TODO: 添加源字段'},${effDtIsCustom ? `\n        ${effDtExpression} AS ${effDtCteAlias},` : ''}
        ROW_NUMBER() OVER (PARTITION BY c.${businessKeySrcField} ORDER BY ${step3OrderBy}) AS rn
    FROM ${primaryTableName} c
    ${applySection ? replacePrimaryAlias(applySection, 'c') : '-- TODO: 添加 OUTER APPLY（如需要）'}${stateFilterExpr ? `\n    WHERE ${stateFilterExpr}` : ''}
),

new_records AS (
    SELECT ac.*
    FROM all_source ac
    WHERE NOT EXISTS (
        SELECT 1 FROM ${tableName} d
        WHERE d.${joinKeySnake} = ac.${joinKeySrcField}
    )
)

INSERT INTO ${tableName} (
${insertFields.join(',\n')}
)
SELECT
${selectFields.join(',\n')},
    -- SCD2 控制字段
    ${effDtIsCustom ? 'nc.' + effDtCteAlias : effDtExpression},
    '9999-12-31',
    1,
    CASE WHEN nc.rn = 1 THEN 1 ELSE 0 END,
    -- 审计字段
    GETDATE(),
    'BMS',
    ${batchIdExpr}
FROM new_records nc
${joinClauses.length > 0 ? joinClauses.map(j => replacePrimaryAlias(j, 'nc')).join('\n') : '-- TODO: 添加字典表 JOIN'};


-- ============================================================================
-- 【节点 4】SQL脚本 - Step 4 版本链重建
-- 说明：对所有记录重新计算 dw_eff_dt, dw_exp_dt, dw_is_current_flg
-- ============================================================================
/*
节点类型: SQL脚本
节点名称: Step 4 - 版本链重建
数据源: 数仓连接
复制以下 SQL：
*/

${options?.auditLog ? `-- 4.1 记录版本链修复到审计表（在 UPDATE 之前）
;WITH version_chain AS (
    SELECT
        d.${skName},
        d.${businessKeySnake},${versionOrderSnake ? `\n        d.${versionOrderSnake},` : ''}
        d.dw_eff_dt,
        d.dw_exp_dt,
        d.dw_is_current_flg,
        d.dw_is_initial_flg,
        LEAD(d.dw_eff_dt) OVER (
            PARTITION BY d.${businessKeySnake}
            ORDER BY ${versionOrderAsc}
        ) AS next_eff_dt,
        ROW_NUMBER() OVER (
            PARTITION BY d.${businessKeySnake}
            ORDER BY ${versionOrderDesc}
        ) AS rn_desc,
        ROW_NUMBER() OVER (
            PARTITION BY d.${businessKeySnake}
            ORDER BY ${versionOrderAsc}
        ) AS rn_asc
    FROM ${tableName} d
),
rebuild_records AS (
    SELECT
        vc.${businessKeySnake},
        COUNT(*) AS affected_versions,
        (
            SELECT
                ${versionOrderSnake ? `v.${versionOrderSnake},` : ''}
                v.dw_exp_dt AS old_exp_dt,
                ISNULL(v.next_eff_dt, '9999-12-31') AS new_exp_dt,
                v.dw_is_current_flg AS old_is_current,
                CASE WHEN v.rn_desc = 1 THEN 1 ELSE 0 END AS new_is_current,
                v.dw_is_initial_flg AS old_is_initial,
                CASE WHEN v.rn_asc = 1 THEN 1 ELSE 0 END AS new_is_initial
            FROM version_chain v
            WHERE v.${businessKeySnake} = vc.${businessKeySnake}
              AND (v.dw_exp_dt <> ISNULL(v.next_eff_dt, '9999-12-31')
                   OR v.dw_is_current_flg <> CASE WHEN v.rn_desc = 1 THEN 1 ELSE 0 END
                   OR v.dw_is_initial_flg <> CASE WHEN v.rn_asc = 1 THEN 1 ELSE 0 END)
            FOR JSON PATH
        ) AS fixed_versions_json
    FROM version_chain vc
    WHERE vc.dw_exp_dt <> ISNULL(vc.next_eff_dt, '9999-12-31')
       OR vc.dw_is_current_flg <> CASE WHEN vc.rn_desc = 1 THEN 1 ELSE 0 END
       OR vc.dw_is_initial_flg <> CASE WHEN vc.rn_asc = 1 THEN 1 ELSE 0 END
    GROUP BY vc.${businessKeySnake}
)
INSERT INTO dw_audit_log (
    table_name,
    data_layer,
    record_key,
    audit_type,
    audit_level,
    audit_detail,
    affected_count,
    batch_id
)
SELECT
    '${tableName}',
    'DIM',
    '{"${businessKeySnake}":' + CAST(rr.${businessKeySnake} AS VARCHAR) + '}',
    'REBUILD',
    'INFO',
    '{"reason":"版本链自动修复","fixed_versions":' + ISNULL(rr.fixed_versions_json, '[]') + '}',
    rr.affected_versions,
    ${batchIdExpr}
FROM rebuild_records rr;

-- 4.2 执行版本链重建
` : ''};WITH version_chain AS (
    SELECT
        d.${skName},
        d.${businessKeySnake},
        d.dw_eff_dt,
        LEAD(d.dw_eff_dt) OVER (
            PARTITION BY d.${businessKeySnake}
            ORDER BY ${versionOrderAsc}
        ) AS next_eff_dt,
        ROW_NUMBER() OVER (
            PARTITION BY d.${businessKeySnake}
            ORDER BY ${versionOrderDesc}
        ) AS rn_desc,
        ROW_NUMBER() OVER (
            PARTITION BY d.${businessKeySnake}
            ORDER BY ${versionOrderAsc}
        ) AS rn_asc
    FROM ${tableName} d
)
UPDATE d
SET
    d.dw_exp_dt = ISNULL(vc.next_eff_dt, '9999-12-31'),
    d.dw_is_current_flg = CASE WHEN vc.rn_desc = 1 THEN 1 ELSE 0 END,
    d.dw_is_initial_flg = CASE WHEN vc.rn_asc = 1 THEN 1 ELSE 0 END,
    d.dw_update_ts = GETDATE()
FROM ${tableName} d
INNER JOIN version_chain vc ON d.${skName} = vc.${skName}
WHERE d.dw_exp_dt <> ISNULL(vc.next_eff_dt, '9999-12-31')
   OR d.dw_is_current_flg <> CASE WHEN vc.rn_desc = 1 THEN 1 ELSE 0 END
   OR d.dw_is_initial_flg <> CASE WHEN vc.rn_asc = 1 THEN 1 ELSE 0 END;


-- ============================================================================
-- 【节点 5】SQL脚本 - Step 5 一致性告警（可选）
-- 说明：检测 dim 表当前版本与主表是否一致
-- ============================================================================
/*
节点类型: SQL脚本
节点名称: Step 5 - 一致性告警
数据源: 数仓连接
复制以下 SQL：
*/

INSERT INTO dw_audit_log (
    table_name,
    data_layer,
    record_key,
    audit_type,
    audit_level,
    audit_detail,
    diff_fields,
    source_table,
    batch_id
)
SELECT
    '${tableName}',
    'DIM',
    '{"${businessKeySnake}":' + CAST(d.${businessKeySnake} AS VARCHAR) + '}',
    'INCONSISTENT',
    'ERROR',
    (
        SELECT
${buildAuditFlatPairs('d', consistencyAlias, consistencyFieldMappings, businessKeySnake)}
        FOR JSON PATH, WITHOUT_ARRAY_WRAPPER
    ),
    ${buildDiffFieldsStuff('d', consistencyAlias, consistencyFieldMappings, businessKeySnake)},
    '${consistencyTableName}',
    ${batchIdExpr}
FROM ${tableName} d
JOIN ${consistencyTableName} ${consistencyAlias}
    ON d.${businessKeySnake} = ${consistencyAlias}.${consistencyJoinField}
WHERE d.dw_is_current_flg = 1
  AND (
      ${compareFieldsForConsistency ? compareFieldsForConsistency.replace(/\bc\./g, consistencyAlias + '.') : `1=0  -- TODO: 配置一致性检测条件`}
  )
  AND NOT EXISTS (
      SELECT 1
      FROM dw_audit_log a
      WHERE a.table_name = '${tableName}'
        AND a.audit_type = 'INCONSISTENT'
        AND a.is_resolved = 0
        AND a.record_key = '{"${businessKeySnake}":' + CAST(d.${businessKeySnake} AS VARCHAR) + '}'
  );


-- ============================================================================
-- 【节点 6】SQL脚本 - Step 6 数据质量检查 → 写入 dw_etl_check_log
-- 说明：质检指标持久化到公共质检表，可追溯历史趋势
-- ============================================================================
/*
节点类型: SQL脚本
节点名称: Step 6 - 数据质量检查
数据源: 数仓连接
复制以下 SQL：
*/

-- 总行数（含历史版本）
INSERT INTO dbo.dw_etl_check_log (table_name, data_layer, check_type, metric_name, metric_value, batch_id)
SELECT '${tableName}', 'DIM', 'ROW_COUNT', 'total_rows', CAST(COUNT(*) AS NVARCHAR(20)),
       ${batchIdExpr}
FROM dbo.${tableName};

-- 当前版本行数
INSERT INTO dbo.dw_etl_check_log (table_name, data_layer, check_type, metric_name, metric_value, batch_id)
SELECT '${tableName}', 'DIM', 'ROW_COUNT', 'current_rows', CAST(COUNT(*) AS NVARCHAR(20)),
       ${batchIdExpr}
FROM dbo.${tableName} WHERE dw_is_current_flg = 1;

-- 代理键唯一性
INSERT INTO dbo.dw_etl_check_log (table_name, data_layer, check_type, metric_name, metric_value, batch_id)
SELECT '${tableName}', 'DIM', 'SUMMARY', 'pk_uniqueness',
       CASE WHEN COUNT(*) = COUNT(DISTINCT sk_${businessKeySnake.replace(/_id$/, '')}) THEN 'PASS'
            ELSE 'FAIL: ' + CAST(COUNT(*) - COUNT(DISTINCT sk_${businessKeySnake.replace(/_id$/, '')}) AS NVARCHAR(20)) + ' duplicates' END,
       ${batchIdExpr}
FROM dbo.${tableName};

-- 业务键当前版本唯一性（同一业务键不应有多条 current=1）
INSERT INTO dbo.dw_etl_check_log (table_name, data_layer, check_type, metric_name, metric_value, batch_id)
SELECT '${tableName}', 'DIM', 'SUMMARY', 'current_flg_duplicate',
       CASE WHEN COUNT(*) = 0 THEN 'PASS'
            ELSE 'FAIL: ' + CAST(COUNT(*) AS NVARCHAR(20)) + ' business keys with multiple current' END,
       ${batchIdExpr}
FROM (SELECT ${businessKeySnake} FROM dbo.${tableName} WHERE dw_is_current_flg = 1 GROUP BY ${businessKeySnake} HAVING COUNT(*) > 1) dup;

-- 本批次审计记录数
INSERT INTO dbo.dw_etl_check_log (table_name, data_layer, check_type, metric_name, metric_value, batch_id)
SELECT '${tableName}', 'DIM', 'ROW_COUNT', 'audit_record_count',
       CAST(COUNT(*) AS NVARCHAR(20)),
       ${batchIdExpr}
FROM dbo.dw_audit_log
WHERE table_name = '${tableName}'
  AND batch_id = ${batchIdExpr};

`;

            return script;
        }

        // --- DWD 哈希辅助 ---
        function buildDwdHashExpression(fieldMappings, derivedFields, excludeFields, useAlias) {
            const exclude = new Set((excludeFields || []).map(f => f.toLowerCase()));
            const hashFields = [];
            (fieldMappings || []).forEach(m => {
                const target = m.targetField || toSnakeCase(m.srcField);
                if (!exclude.has(target.toLowerCase())) hashFields.push(target);
            });
            (derivedFields || []).forEach(f => {
                if (!exclude.has((f.name || '').toLowerCase())) hashFields.push(f.name);
            });
            if (hashFields.length === 0) return 'NULL';
            // 使用 + 连接代替 CONCAT_WS，兼容 SQL Server 2016 及更早版本
            // 先转换为 NVARCHAR(MAX) 连接，再转为 VARBINARY(MAX) 避免 HASHBYTES 8000字节限制
            const parts = hashFields.map(f => `ISNULL(CAST(${f} AS NVARCHAR(MAX)), '')`);
            const concatExpr = parts.join(" + N'|' + ");
            return `CONVERT(VARCHAR(64), HASHBYTES('SHA2_256', CAST(${concatExpr} AS VARBINARY(MAX))), 2)`;
        }

        function getPrimarySourceAlias(sourceTables) {
            const primary = (sourceTables || []).find(t => t.isPrimary);
            return primary ? (primary.alias || 'src') : 'src';
        }

        // 智能排序字段：将 _id 和对应的 _name 字段配对排列
        function sortFieldsWithNamePairing(fieldMappings, derivedFields, pkSet) {
            const result = [];
            const usedFields = new Set();
            const allFields = [];

            // 收集所有字段（业务字段 + 派生字段）
            (fieldMappings || []).forEach(m => {
                const target = m.targetField || toSnakeCase(m.srcField);
                if (!pkSet.has(target.toLowerCase())) {
                    allFields.push({ type: 'mapping', field: target, data: m });
                }
            });
            (derivedFields || []).forEach(f => {
                allFields.push({ type: 'derived', field: f.name, data: f });
            });

            // 构建字段名到数据的映射
            const fieldMap = new Map();
            allFields.forEach(item => {
                fieldMap.set(item.field.toLowerCase(), item);
            });

            // 遍历所有字段，寻找配对
            allFields.forEach(item => {
                const fieldName = item.field.toLowerCase();
                if (usedFields.has(fieldName)) return;

                // 添加当前字段
                result.push(item);
                usedFields.add(fieldName);

                // 尝试找到对应的 _name 字段
                let nameField = null;
                if (fieldName.endsWith('_id')) {
                    // customer_id -> customer_name, customer_id -> customer_category_name 等
                    const baseName = fieldName.slice(0, -3); // 去掉 _id
                    const possibleNames = [
                        baseName + '_name',           // customer_id -> customer_name
                        baseName + '_std',            // contract_type -> contract_type_std (虽然不是_id结尾)
                    ];
                    for (const pn of possibleNames) {
                        if (fieldMap.has(pn) && !usedFields.has(pn)) {
                            nameField = fieldMap.get(pn);
                            break;
                        }
                    }
                } else if (fieldName.endsWith('_type') || fieldName.endsWith('_status') || fieldName.endsWith('_category')) {
                    // contract_type -> contract_type_std, status -> status_name
                    const possibleNames = [
                        fieldName + '_std',
                        fieldName + '_name',
                        fieldName.replace(/_type$/, '_type_std'),
                        fieldName.replace(/_status$/, '_status_name'),
                    ];
                    for (const pn of possibleNames) {
                        if (fieldMap.has(pn) && !usedFields.has(pn)) {
                            nameField = fieldMap.get(pn);
                            break;
                        }
                    }
                }

                // 如果找到配对的 name 字段，紧跟着添加
                if (nameField) {
                    result.push(nameField);
                    usedFields.add(nameField.field.toLowerCase());
                }
            });

            return result;
        }

        // --- Phase 1: DDL ---
        function generateDwdDDL(tableName, tableComment, dwdConfig, fieldMappings, derivedFields, sourceTables) {
            const primaryKeys = dwdConfig.primaryKeys || ['id'];
            const updateStrategy = dwdConfig.updateStrategy || 'FULL_OVERWRITE';
            const isIncremental = updateStrategy === 'INCREMENTAL_APPEND';
            const granularity = dwdConfig.dataGranularity || '';
            const pkSet = new Set(primaryKeys.map(k => k.toLowerCase()));
            const sourceTablesComment = (sourceTables || []).length > 0
                ? sourceTables.map(t => `${t.isPrimary ? '(主)' : '    '} ${t.name}${t.alias ? ' AS ' + t.alias : ''}`).join('\n  ') : '未配置';
            const strategyLabel = { 'FULL_OVERWRITE': '每日全量覆盖', 'INCREMENTAL_APPEND': '增量追加', 'PARTITION_OVERWRITE': '分区覆盖' }[updateStrategy] || updateStrategy;

            const versionTag = dwdConfig.version ? `\n  配置版本: ${dwdConfig.version}` : '';
            let ddl = `/*\n================================================================================\n  ${tableComment || tableName} - ${tableName}\n\n  数据粒度: ${granularity}\n  主键字段: ${primaryKeys.join(', ')}\n  更新策略: ${strategyLabel}\n\n  源表:\n  ${sourceTablesComment}\n\n  创建日期: ${new Date().toISOString().split('T')[0]}${versionTag}\n================================================================================\n*/\n\nIF OBJECT_ID('dbo.${tableName}', 'U') IS NOT NULL\n    DROP TABLE dbo.${tableName};\nGO\n\nCREATE TABLE dbo.${tableName} (\n`;

            ddl += `    -- 主键字段\n`;
            primaryKeys.forEach(pk => {
                const mapping = (fieldMappings || []).find(m => (m.targetField || '').toLowerCase() === pk.toLowerCase());
                // 对于增量追加表的 change_date 主键，强制使用 DATE 类型
                let dataType;
                if (pk.toLowerCase() === 'change_date' && isIncremental) {
                    dataType = 'DATE';
                } else {
                    dataType = mapping ? normalizeDataType(mapping.dataType, pk) : 'INT';
                }
                ddl += `    ${pk}    ${dataType} NOT NULL,\n`;
            });

            // 使用智能排序：将 _id 字段与对应的 _name 字段配对排列
            const sortedFields = sortFieldsWithNamePairing(fieldMappings, derivedFields, pkSet);

            ddl += `\n    -- 业务字段（已按 ID/Name 配对排序）\n`;
            sortedFields.forEach(item => {
                if (item.type === 'mapping') {
                    const m = item.data;
                    const target = m.targetField || toSnakeCase(m.srcField);
                    // 添加字段注释：优先使用用户输入的注释，否则显示源字段名（如果不同）
                    let comment = '';
                    if (m.comment) {
                        comment = `  -- ${m.comment}`;
                    } else if (m.srcField && m.srcField !== target) {
                        comment = `  -- ${m.srcField}`;
                    }
                    comment += buildChangeTag(m);
                    // 传入目标字段名，用于智能判断长度
                    ddl += `    ${target}    ${normalizeDataType(m.dataType, target)},${comment}\n`;
                } else if (item.type === 'derived') {
                    const f = item.data;
                    // 派生字段：如果用户指定了类型则使用，否则根据字段名智能推断
                    // CASE 表达式生成的文本字段默认使用 NVARCHAR(500)
                    let fieldType = f.type || f.dataType;
                    if (!fieldType) {
                        const fn = (f.name || '').toLowerCase();
                        // 根据字段名后缀推断类型
                        if (fn.includes('_id') || fn.endsWith('id')) {
                            fieldType = 'INT';
                        } else if (fn.includes('_date') || fn.includes('_time') || fn.endsWith('date') || fn.endsWith('time')) {
                            fieldType = 'DATETIME';
                        } else if (fn.includes('_amt') || fn.includes('amount') || fn.includes('money') || fn.includes('price')) {
                            fieldType = 'DECIMAL(18,2)';
                        } else if (fn.includes('_flag') || fn.startsWith('is_') || fn.startsWith('has_')) {
                            fieldType = 'NVARCHAR(50)';
                        } else {
                            // 默认文本类型，CASE 表达式可能生成较长文本
                            fieldType = 'NVARCHAR(500)';
                        }
                    }
                    const derivedComment = (f.comment ? '    -- ' + f.comment : '') + buildChangeTag(f);
                    ddl += `    ${f.name}    ${fieldType},${derivedComment}\n`;
                }
            });

            // 增量追加策略需要变更追踪字段
            if (isIncremental) {
                ddl += `\n    -- 变更追踪字段\n`;
                ddl += `    change_date     DATE NOT NULL,           -- 变更发现日期\n`;
                ddl += `    change_type     VARCHAR(10) NOT NULL,    -- INSERT/UPDATE/DELETE\n`;
                ddl += `    change_reason   VARCHAR(50) NULL,        -- 变更原因\n`;
            }
            ddl += `\n    -- 审计字段\n    dw_create_ts    DATETIME NOT NULL DEFAULT GETDATE(),\n    dw_update_ts    DATETIME NULL,\n    dw_hash_val     VARCHAR(64) NULL,\n    dw_etl_job      VARCHAR(100) NOT NULL DEFAULT '${tableName}',\n    dw_load_ts      DATETIME NOT NULL DEFAULT GETDATE(),\n    dw_src_sys      VARCHAR(50) NOT NULL DEFAULT 'BMS',\n    dw_batch_id     VARCHAR(50) NULL,\n\n    CONSTRAINT pk_${tableName} PRIMARY KEY (${primaryKeys.join(', ')})\n);\nGO\n`;

            if (dwdConfig.hashConfig?.enabled) ddl += `\nCREATE INDEX IX_${tableName}_hash ON dbo.${tableName}(dw_hash_val);\nGO\n`;
            // 增量追加表添加 change_date 索引
            if (isIncremental) ddl += `\nCREATE INDEX IX_${tableName}_change_date ON dbo.${tableName}(change_date);\nGO\n`;

            ddl += `\n-- 字段注释\n`;
            const addComment = (col, desc) => { ddl += `EXEC sp_addextendedproperty @name=N'MS_Description', @value=N'${(desc || '').replace(/'/g, "''")}',\n    @level0type=N'SCHEMA', @level0name=N'dbo', @level1type=N'TABLE', @level1name=N'${tableName}', @level2type=N'COLUMN', @level2name=N'${col}';\n`; };
            primaryKeys.forEach(pk => { const m = (fieldMappings || []).find(x => (x.targetField || '').toLowerCase() === pk.toLowerCase()); addComment(pk, m?.comment || '主键'); });
            (fieldMappings || []).forEach(m => { const t = m.targetField || toSnakeCase(m.srcField); if (!pkSet.has(t.toLowerCase()) && m.comment) addComment(t, m.comment); });
            (derivedFields || []).forEach(f => { if (f.comment) addComment(f.name, f.comment); });
            // 变更追踪字段注释
            if (isIncremental) {
                ['change_date:变更发现日期（ETL执行日期）', 'change_type:变更类型（INSERT/UPDATE/DELETE）', 'change_reason:变更原因'].forEach(pair => { const [c, d] = pair.split(':'); addComment(c, d); });
            }
            ['dw_create_ts:DWD首次加载时间', 'dw_update_ts:DWD最后更新时间', 'dw_hash_val:业务字段SHA-256哈希', 'dw_etl_job:ETL作业名称', 'dw_load_ts:数据加载时间', 'dw_src_sys:来源系统标识', 'dw_batch_id:ETL批次号'].forEach(pair => { const [c, d] = pair.split(':'); addComment(c, d); });
            ddl += `GO\n`;
            return ddl;
        }

        // --- 伴生表 DDL 生成 ---
        function generateCompanionDDL(parentTableName, parentComment, dwdConfig, fieldMappings, derivedFields) {
            const ctName = dwdConfig.changeTracking?.changeTableName || parentTableName.replace(/_df$/, '_change_di');
            const primaryKeys = dwdConfig.primaryKeys || ['id'];
            const pkSet = new Set(primaryKeys.map(k => k.toLowerCase()));

            let ddl = `\n/*\n================================================================================\n  ${parentComment || parentTableName} - 变更追踪伴生表\n  伴生于: ${parentTableName}\n  说明: 记录主表每次 ETL 执行时检测到的 INSERT/UPDATE/DELETE 变更\n  创建日期: ${new Date().toISOString().split('T')[0]}\n================================================================================\n*/\n\nIF OBJECT_ID('dbo.${ctName}', 'U') IS NOT NULL\n    DROP TABLE dbo.${ctName};\nGO\n\nCREATE TABLE dbo.${ctName} (\n`;

            // 主键字段（伴生表中不设主键约束，同一记录可多次出现）
            ddl += `    -- 业务字段（与主表 ${parentTableName} 一致）\n`;
            primaryKeys.forEach(pk => {
                const mapping = (fieldMappings || []).find(m => (m.targetField || '').toLowerCase() === pk.toLowerCase());
                const dataType = mapping ? normalizeDataType(mapping.dataType, pk) : 'INT';
                ddl += `    ${pk}    ${dataType} NOT NULL,\n`;
            });

            const sortedFields = sortFieldsWithNamePairing(fieldMappings, derivedFields, pkSet);
            sortedFields.forEach(item => {
                if (item.type === 'mapping') {
                    const m = item.data;
                    const target = m.targetField || toSnakeCase(m.srcField);
                    let comment = m.comment ? `  -- ${m.comment}` : (m.srcField && m.srcField !== target ? `  -- ${m.srcField}` : '');
                    ddl += `    ${target}    ${normalizeDataType(m.dataType, target)},${comment}\n`;
                } else if (item.type === 'derived') {
                    const f = item.data;
                    let fieldType = f.type || f.dataType;
                    if (!fieldType) {
                        const fn = (f.name || '').toLowerCase();
                        if (fn.includes('_id') || fn.endsWith('id')) fieldType = 'INT';
                        else if (fn.includes('_date') || fn.includes('_time')) fieldType = 'DATETIME';
                        else if (fn.includes('_amt') || fn.includes('amount') || fn.includes('price')) fieldType = 'DECIMAL(18,2)';
                        else fieldType = 'NVARCHAR(500)';
                    }
                    ddl += `    ${f.name}    ${fieldType},${f.comment ? '    -- ' + f.comment : ''}\n`;
                }
            });

            // 变更追踪字段
            ddl += `\n    -- 变更追踪字段\n`;
            ddl += `    change_date     DATE NOT NULL,           -- 变更发现日期（ETL执行日期）\n`;
            ddl += `    change_type     VARCHAR(10) NOT NULL,    -- INSERT/UPDATE/DELETE\n`;
            ddl += `    change_reason   VARCHAR(50) NULL,        -- 变更原因\n`;

            // 审计字段（伴生表只追加不更新，无 dw_create_ts / dw_update_ts）
            ddl += `\n    -- 审计字段\n`;
            ddl += `    dw_hash_val     VARCHAR(64) NULL,\n`;
            ddl += `    dw_etl_job      VARCHAR(100) NOT NULL DEFAULT '${ctName}',\n`;
            ddl += `    dw_load_ts      DATETIME NOT NULL DEFAULT GETDATE(),\n`;
            ddl += `    dw_src_sys      VARCHAR(50) NOT NULL DEFAULT 'BMS',\n`;
            ddl += `    dw_batch_id     VARCHAR(50) NULL\n`;
            ddl += `);\nGO\n`;

            // 索引
            ddl += `\n-- 伴生表索引\n`;
            ddl += `CREATE INDEX IX_${ctName}_change_date ON dbo.${ctName}(change_date);\nGO\n`;
            ddl += `CREATE INDEX IX_${ctName}_change_type ON dbo.${ctName}(change_date, change_type);\nGO\n`;
            ddl += `CREATE INDEX IX_${ctName}_pk ON dbo.${ctName}(${primaryKeys[0]}, change_date);\nGO\n`;

            // 字段注释
            ddl += `\n-- 伴生表字段注释\n`;
            const addComment = (col, desc) => { ddl += `EXEC sp_addextendedproperty @name=N'MS_Description', @value=N'${(desc || '').replace(/'/g, "''")}',\n    @level0type=N'SCHEMA', @level0name=N'dbo', @level1type=N'TABLE', @level1name=N'${ctName}', @level2type=N'COLUMN', @level2name=N'${col}';\n`; };
            ['change_date:变更发现日期（ETL执行日期）', 'change_type:变更类型（INSERT/UPDATE/DELETE）', 'change_reason:变更原因', 'dw_hash_val:业务字段SHA-256哈希', 'dw_etl_job:ETL作业名称', 'dw_load_ts:数据加载时间', 'dw_src_sys:来源系统标识', 'dw_batch_id:ETL批次号'].forEach(pair => { const [c, d] = pair.split(':'); addComment(c, d); });
            ddl += `GO\n`;
            return ddl;
        }

        // --- Phase 2: 全量初始化 ---
        function generateDwdFullLoadScript(tableName, tableComment, dwdConfig, fieldMappings, derivedFields, sourceTables, advancedSqlConfig) {
            const primaryKeys = dwdConfig.primaryKeys || ['id'];
            const pkSet = new Set(primaryKeys.map(k => k.toLowerCase()));
            const hashExclude = dwdConfig.hashConfig?.excludeFields || ['dw_create_ts', 'dw_update_ts', 'dw_hash_val', 'dw_etl_job', 'dw_load_ts', 'dw_src_sys', 'dw_batch_id'];
            const targetFields = [], selectFields = [];
            const alias = getPrimarySourceAlias(sourceTables);

            // 主键字段：优先从 fieldMappings 找源字段名，否则假设源字段名与主键名相同（带别名）
            // 如果源字段已包含 . 则不再添加别名前缀
            primaryKeys.forEach(pk => {
                const m = (fieldMappings || []).find(x => (x.targetField || '').toLowerCase() === pk.toLowerCase());
                targetFields.push(pk);
                if (m) {
                    const srcExpr = resolveFieldExpr(m, alias);
                    selectFields.push(`${srcExpr} AS ${pk}`);
                } else {
                    selectFields.push(`${alias}.${pk} AS ${pk}`);
                }
            });
            // 使用智能排序：将 _id 字段与对应的 _name 字段配对排列
            const sortedFields = sortFieldsWithNamePairing(fieldMappings, derivedFields, pkSet);
            sortedFields.forEach(item => {
                if (item.type === 'mapping') {
                    const m = item.data;
                    const t = m.targetField || toSnakeCase(m.srcField);
                    targetFields.push(t);
                    const srcExpr = resolveFieldExpr(m, alias);
                    selectFields.push(`${srcExpr} AS ${t}`);
                } else if (item.type === 'derived') {
                    const f = item.data;
                    targetFields.push(f.name);
                    // 如果有 exprConfig，优先重新生成表达式；否则回退到 source
                    const expr = (f.exprType && f.exprConfig) ? generateExpressionSQL(f.exprType, f.exprConfig) : (f.sqlExpression || f.source || '');
                    selectFields.push(`${expr} AS ${f.name}`);
                }
            });
            // 审计字段
            targetFields.push('dw_create_ts', 'dw_update_ts', 'dw_hash_val', 'dw_etl_job', 'dw_load_ts', 'dw_src_sys', 'dw_batch_id');
            selectFields.push('GETDATE() AS dw_create_ts', 'GETDATE() AS dw_update_ts', 'NULL AS dw_hash_val', `'${tableName}' AS dw_etl_job`, 'GETDATE() AS dw_load_ts', "'BMS' AS dw_src_sys", '@batch_id AS dw_batch_id');

            const ctePrefix = buildCtePrefix(advancedSqlConfig);
            const fromClause = buildFromClause(sourceTables, advancedSqlConfig);
            const where = dwdConfig.filterCondition ? `\nWHERE ${dwdConfig.filterCondition}` : '';

            const versionTag = dwdConfig.version ? `\n  配置版本: ${dwdConfig.version}` : '';
            let s = `/*
================================================================================
  ${tableComment || tableName} - 全量初始化 ETL 脚本
  执行方式: 手动执行一次（建表后）
  创建日期: ${new Date().toISOString().split('T')[0]}${versionTag}
================================================================================
*/

DECLARE @batch_id VARCHAR(50) = 'INIT_' + FORMAT(GETDATE(), 'yyyyMMddHHmmss');
DECLARE @start_ts DATETIME = GETDATE();
DECLARE @loaded INT = 0;
DECLARE @hash_updated INT = 0;

PRINT '========== ${tableName} 全量初始化开始 ==========';

-- Step 1: 清空目标表
TRUNCATE TABLE dbo.${tableName};

-- Step 2: 全量加载
${ctePrefix}INSERT INTO dbo.${tableName} (
    ${targetFields.join(',\n    ')}
)
SELECT
    ${selectFields.join(',\n    ')}
FROM ${fromClause}${where};

SET @loaded = @@ROWCOUNT;
PRINT '全量加载完成: ' + CAST(@loaded AS VARCHAR) + ' 条记录';
`;

            if (dwdConfig.hashConfig?.enabled) {
                s += `
-- Step 3: 计算业务字段哈希
UPDATE dbo.${tableName}
SET dw_hash_val = ${buildDwdHashExpression(fieldMappings, derivedFields, hashExclude, true)};

SET @hash_updated = @@ROWCOUNT;
PRINT '哈希计算完成: ' + CAST(@hash_updated AS VARCHAR) + ' 条';
`;
            }
            s += `
-- 执行摘要 + 数据验证（合并为一个结果集，方便查看）
SELECT '${tableName}' AS table_name, 'records_loaded' AS metric, @loaded AS value, @batch_id AS batch_id
UNION ALL SELECT '${tableName}', 'hash_updated', ${dwdConfig.hashConfig?.enabled ? '@hash_updated' : '0'}, NULL
UNION ALL SELECT '${tableName}', 'elapsed_seconds', DATEDIFF(SECOND, @start_ts, GETDATE()), NULL
UNION ALL SELECT '${tableName}', 'record_count', cnt, NULL FROM (SELECT COUNT(*) AS cnt FROM dbo.${tableName}) t
UNION ALL SELECT '${tableName}', 'pk_distinct', cnt, NULL FROM (SELECT COUNT(DISTINCT ${primaryKeys[0]}) AS cnt FROM dbo.${tableName}) t;
`;
            return s;
        }

        // --- Phase 3: 增量 ETL ---
        function generateDwdIncrementalScript(tableName, tableComment, dwdConfig, fieldMappings, derivedFields, sourceTables, advancedSqlConfig) {
            const primaryKeys = dwdConfig.primaryKeys || ['id'];
            const pkSet = new Set(primaryKeys.map(k => k.toLowerCase()));
            const hashExclude = dwdConfig.hashConfig?.excludeFields || ['dw_create_ts', 'dw_update_ts', 'dw_hash_val', 'dw_etl_job', 'dw_load_ts', 'dw_src_sys', 'dw_batch_id'];
            const ct = dwdConfig.changeTracking?.enabled || false;
            const ctName = dwdConfig.changeTracking?.changeTableName || tableName.replace(/_df$/, '_change_di');
            const alias = getPrimarySourceAlias(sourceTables);
            const targetFields = [], selectFields = [];

            // 主键字段：如果源字段已包含 . 则不再添加别名前缀
            primaryKeys.forEach(pk => {
                const m = (fieldMappings || []).find(x => (x.targetField || '').toLowerCase() === pk.toLowerCase());
                targetFields.push(pk);
                if (m) {
                    const srcExpr = resolveFieldExpr(m, alias);
                    selectFields.push(`${srcExpr} AS ${pk}`);
                } else {
                    selectFields.push(`${alias}.${pk} AS ${pk}`);
                }
            });
            // 使用智能排序：将 _id 字段与对应的 _name 字段配对排列
            const sortedFields = sortFieldsWithNamePairing(fieldMappings, derivedFields, pkSet);
            sortedFields.forEach(item => {
                if (item.type === 'mapping') {
                    const m = item.data;
                    const t = m.targetField || toSnakeCase(m.srcField);
                    targetFields.push(t);
                    const srcExpr = resolveFieldExpr(m, alias);
                    selectFields.push(`${srcExpr} AS ${t}`);
                } else if (item.type === 'derived') {
                    const f = item.data;
                    targetFields.push(f.name);
                    const expr = (f.exprType && f.exprConfig) ? generateExpressionSQL(f.exprType, f.exprConfig) : (f.sqlExpression || f.source || '');
                    selectFields.push(`${expr} AS ${f.name}`);
                }
            });

            const ctePrefix = buildCtePrefix(advancedSqlConfig);
            const fromClause = buildFromClause(sourceTables, advancedSqlConfig);
            const where = dwdConfig.filterCondition ? `\nWHERE ${dwdConfig.filterCondition}` : '';
            const hashExpr = buildDwdHashExpression(fieldMappings, derivedFields, hashExclude, true);
            const pkJoin = primaryKeys.map(pk => `s.${pk} = d.${pk}`).join(' AND ');
            const pk0 = primaryKeys[0];

            const versionTag = dwdConfig.version ? `\n  配置版本: ${dwdConfig.version}` : '';
            let s = `/*
================================================================================
  ${tableComment || tableName} - 增量 ETL 脚本（哈希比对 + 变更快照）
  执行方式: 每日调度执行
  目标表: dbo.${tableName}${ct ? '\n  变更表: dbo.' + ctName : ''}
  创建日期: ${new Date().toISOString().split('T')[0]}${versionTag}
================================================================================
*/

DECLARE @batch_id VARCHAR(50) = 'INCR_' + FORMAT(GETDATE(), 'yyyyMMddHHmmss');
DECLARE @load_ts DATETIME = GETDATE();
DECLARE @change_date DATE = CAST(@load_ts AS DATE);
DECLARE @inserted INT = 0, @updated INT = 0, @deleted INT = 0;

PRINT '========== ${tableName} 增量 ETL 开始 ==========';

-- Step 1: 构建 ODS 快照
${ctePrefix}SELECT
    ${selectFields.join(',\n    ')}
INTO #ods_snapshot
FROM ${fromClause}${where};

ALTER TABLE #ods_snapshot ADD new_hash VARCHAR(64) NULL;
UPDATE #ods_snapshot SET new_hash = ${hashExpr};
PRINT 'ODS 快照: ' + CAST(@@ROWCOUNT AS VARCHAR) + ' 条';

-- Step 2: 检测变更
SELECT s.${pk0}, 'INSERT' AS change_type INTO #changes
FROM #ods_snapshot s LEFT JOIN dbo.${tableName} d ON ${pkJoin}
WHERE d.${pk0} IS NULL;
SET @inserted = @@ROWCOUNT;

INSERT INTO #changes SELECT s.${pk0}, 'UPDATE'
FROM #ods_snapshot s INNER JOIN dbo.${tableName} d ON ${pkJoin}
WHERE s.new_hash <> ISNULL(d.dw_hash_val, '');
SET @updated = @@ROWCOUNT;

INSERT INTO #changes SELECT d.${pk0}, 'DELETE'
FROM dbo.${tableName} d LEFT JOIN #ods_snapshot s ON ${pkJoin}
WHERE s.${pk0} IS NULL;
SET @deleted = @@ROWCOUNT;

PRINT '变更检测 — INSERT:' + CAST(@inserted AS VARCHAR) + ' UPDATE:' + CAST(@updated AS VARCHAR) + ' DELETE:' + CAST(@deleted AS VARCHAR);
`;

            if (ct) {
                s += `
-- Step 3: 写入变更表
IF (@inserted + @updated + @deleted) > 0
BEGIN
    INSERT INTO dbo.${ctName} (
        ${targetFields.join(',\n        ')},
        dw_hash_val, dw_etl_job, dw_load_ts, dw_src_sys, dw_batch_id, change_date, change_type, change_reason
    )
    SELECT
        ${targetFields.map(f => 's.' + f).join(',\n        ')},
        s.new_hash, '${ctName}', @load_ts, 'BMS', @batch_id, @change_date, ch.change_type, 'normal'
    FROM #ods_snapshot s INNER JOIN #changes ch ON s.${pk0} = ch.${pk0}
    WHERE ch.change_type IN ('INSERT', 'UPDATE');

    INSERT INTO dbo.${ctName} (
        ${targetFields.join(',\n        ')},
        dw_hash_val, dw_etl_job, dw_load_ts, dw_src_sys, dw_batch_id, change_date, change_type, change_reason
    )
    SELECT
        ${targetFields.map(f => 'd.' + f).join(',\n        ')},
        d.dw_hash_val, '${ctName}', @load_ts, 'BMS', @batch_id, @change_date, 'DELETE', 'normal'
    FROM dbo.${tableName} d INNER JOIN #changes ch ON d.${pk0} = ch.${pk0}
    WHERE ch.change_type = 'DELETE';
    PRINT '变更已写入 ${ctName}';
END
`;
            }

            const allTarget = targetFields.concat(['dw_create_ts', 'dw_update_ts', 'dw_hash_val', 'dw_etl_job', 'dw_load_ts', 'dw_src_sys', 'dw_batch_id']);
            const allSelect = targetFields.map(f => 's.' + f).concat(['@load_ts', '@load_ts', 's.new_hash', `'${tableName}'`, '@load_ts', "'BMS'", '@batch_id']);
            s += `
-- Step 4: 全量覆盖主表
TRUNCATE TABLE dbo.${tableName};
INSERT INTO dbo.${tableName} (
    ${allTarget.join(',\n    ')}
)
SELECT
    ${allSelect.join(',\n    ')}
FROM #ods_snapshot s;

DECLARE @total_loaded INT = @@ROWCOUNT;
PRINT '主表覆盖: ' + CAST(@total_loaded AS VARCHAR) + ' 条';

DROP TABLE #ods_snapshot;
DROP TABLE #changes;

-- 执行摘要（通过 SELECT 返回，方便查看）
SELECT '${tableName}' AS table_name, 'inserted' AS metric, @inserted AS value, @batch_id AS batch_id
UNION ALL SELECT '${tableName}', 'updated', @updated, NULL
UNION ALL SELECT '${tableName}', 'deleted', @deleted, NULL
UNION ALL SELECT '${tableName}', 'total_loaded', @total_loaded, NULL;
`;
            return s;
        }

        // --- Phase 4: FDL 4 节点 ---
        function generateDwdFdlScript(tableName, tableComment, dwdConfig, fieldMappings, derivedFields, sourceTables, advancedSqlConfig) {
            const primaryKeys = dwdConfig.primaryKeys || ['id'];
            const pkSet = new Set(primaryKeys.map(k => k.toLowerCase()));
            const hashExclude = dwdConfig.hashConfig?.excludeFields || ['dw_create_ts', 'dw_update_ts', 'dw_hash_val', 'dw_etl_job', 'dw_load_ts', 'dw_src_sys', 'dw_batch_id'];
            const ct = dwdConfig.changeTracking?.enabled || false;
            const ctName = dwdConfig.changeTracking?.changeTableName || tableName.replace(/_df$/, '_change_di');
            const alias = getPrimarySourceAlias(sourceTables);
            const targetFields = [], selectFields = [];

            // 主键字段：如果源字段已包含 . 则不再添加别名前缀
            primaryKeys.forEach(pk => {
                const m = (fieldMappings || []).find(x => (x.targetField || '').toLowerCase() === pk.toLowerCase());
                targetFields.push(pk);
                if (m) {
                    const srcExpr = resolveFieldExpr(m, alias);
                    selectFields.push(`${srcExpr} AS ${pk}`);
                } else {
                    selectFields.push(`${alias}.${pk} AS ${pk}`);
                }
            });
            // 使用智能排序：将 _id 字段与对应的 _name 字段配对排列
            const sortedFields = sortFieldsWithNamePairing(fieldMappings, derivedFields, pkSet);
            sortedFields.forEach(item => {
                if (item.type === 'mapping') {
                    const m = item.data;
                    const t = m.targetField || toSnakeCase(m.srcField);
                    targetFields.push(t);
                    const srcExpr = resolveFieldExpr(m, alias);
                    selectFields.push(`${srcExpr} AS ${t}`);
                } else if (item.type === 'derived') {
                    const f = item.data;
                    targetFields.push(f.name);
                    const expr = (f.exprType && f.exprConfig) ? generateExpressionSQL(f.exprType, f.exprConfig) : (f.sqlExpression || f.source || '');
                    selectFields.push(`${expr} AS ${f.name}`);
                }
            });

            const ctePrefix = buildCtePrefix(advancedSqlConfig);
            const fromClause = buildFromClause(sourceTables, advancedSqlConfig);
            const where = dwdConfig.filterCondition ? `\nWHERE ${dwdConfig.filterCondition}` : '';
            const hashExpr = buildDwdHashExpression(fieldMappings, derivedFields, hashExclude, true);
            const pkJoin = primaryKeys.map(pk => `s.${pk} = d.${pk}`).join(' AND ');
            const pk0 = primaryKeys[0];
            const allTarget = targetFields.concat(['dw_create_ts', 'dw_update_ts', 'dw_hash_val', 'dw_etl_job', 'dw_load_ts', 'dw_src_sys', 'dw_batch_id']);
            const allSelect = targetFields.map(f => 's.' + f).concat(['@load_ts', '@load_ts', 's.new_hash', `'${tableName}'`, '@load_ts', "'BMS'", '@batch_id']);

            // FDL 每个节点独立执行，变量和临时表不跨节点，因此：
            // 节点 1: 参数初始化
            // 节点 2: 完整 ETL（快照 + 变更检测 + 伴生表 + 主表覆盖）
            // 节点 3: 数据质量检查 → 写入 dw_etl_check_log
            const primaryTable = (sourceTables || []).find(t => t.isPrimary);
            const ptn = primaryTable ? primaryTable.name : 'ods_source_table';

            const versionTag = dwdConfig.version ? `\n  配置版本: ${dwdConfig.version}` : '';
            let s = `/*
================================================================================
  ${tableComment || tableName} - FDL 数据开发任务脚本（3 节点）
  创建日期: ${new Date().toISOString().split('T')[0]}${versionTag}
  调度参数: \${cyctime} = 调度运行时间 (yyyy-mm-dd hh:mm:ss)
  注意: FDL 每个节点独立执行，变量和临时表不跨节点传递
================================================================================
*/

---------- 节点 1: 参数初始化 ----------

-- FDL 按分号逐条执行，DECLARE 变量不跨语句。改用临时表传递参数，临时表在同节点内跨语句可见。
IF OBJECT_ID('tempdb..#etl_params') IS NOT NULL DROP TABLE #etl_params;

SELECT
    '${dwdConfig.updateStrategy === 'FULL_OVERWRITE' ? 'FULL' : 'INCR'}_' + REPLACE(REPLACE(REPLACE('\${cyctime}', '-', ''), ' ', ''), ':', '') AS batch_id,
    GETDATE() AS load_ts,
    CAST(GETDATE() AS DATE) AS change_date
INTO #etl_params;

SELECT * FROM #etl_params;

---------- 节点 2: 数据加载（${ct ? '快照→变更检测→伴生表→主表覆盖' : '快照→主表覆盖'}） ----------

-- 节点独立执行，需重新初始化参数（临时表不跨节点）
IF OBJECT_ID('tempdb..#etl_params') IS NOT NULL DROP TABLE #etl_params;

SELECT
    '${dwdConfig.updateStrategy === 'FULL_OVERWRITE' ? 'FULL' : 'INCR'}_' + REPLACE(REPLACE(REPLACE('\${cyctime}', '-', ''), ' ', ''), ':', '') AS batch_id,
    GETDATE() AS load_ts,
    CAST(GETDATE() AS DATE) AS change_date
INTO #etl_params;

-- 清理可能残留的临时表（上次执行异常中断时）
IF OBJECT_ID('tempdb..#ods_snapshot') IS NOT NULL DROP TABLE #ods_snapshot;
IF OBJECT_ID('tempdb..#changes') IS NOT NULL DROP TABLE #changes;
IF OBJECT_ID('tempdb..#audit_raw') IS NOT NULL DROP TABLE #audit_raw;

-- Step 1: ODS 快照
${ctePrefix}SELECT
    ${selectFields.join(',\n    ')}
INTO #ods_snapshot
FROM ${fromClause}${where}
OPTION (MAXDOP 1);

-- Step 2: Hash 计算
ALTER TABLE #ods_snapshot ADD new_hash VARCHAR(64) NULL;

UPDATE #ods_snapshot SET new_hash = ${hashExpr};

-- Step 3: 变更检测
IF OBJECT_ID('tempdb..#changes') IS NOT NULL DROP TABLE #changes;

SELECT s.${pk0}, 'INSERT' AS change_type INTO #changes
FROM #ods_snapshot s LEFT JOIN dbo.${tableName} d ON ${pkJoin} WHERE d.${pk0} IS NULL
OPTION (MAXDOP 1);

INSERT INTO #changes SELECT s.${pk0}, 'UPDATE'
FROM #ods_snapshot s INNER JOIN dbo.${tableName} d ON ${pkJoin}
WHERE s.new_hash <> ISNULL(d.dw_hash_val, '')
OPTION (MAXDOP 1);

INSERT INTO #changes SELECT d.${pk0}, 'DELETE'
FROM dbo.${tableName} d LEFT JOIN #ods_snapshot s ON ${pkJoin} WHERE s.${pk0} IS NULL
OPTION (MAXDOP 1);
`;

            if (ct) {
                // 非主键业务字段（用于逐字段比对）
                const bizFields = targetFields.filter(f => !pkSet.has(f.toLowerCase()));

                // 生成逐字段比对的 diff_fields SQL 片段
                // 每个字段产生: CASE WHEN 旧<>新 THEN 'field:旧值→新值, ' ELSE '' END
                // 值截取前80字符，避免 diff_fields 超长（nvarchar(500) 限制）
                // datetime 类型用 CONVERT(..., 120) 输出 yyyy-MM-dd HH:mm:ss 格式
                const dateTimePatterns = ['date', 'time', 'datetime', 'smalldatetime'];
                const diffParts = bizFields.map(f => {
                    const m = (fieldMappings || []).find(x => (x.targetField || '').toLowerCase() === f.toLowerCase());
                    const dt = (m?.dataType || '').toLowerCase();
                    const isDateTime = dateTimePatterns.some(p => dt.includes(p));
                    const castOld = isDateTime ? `CONVERT(NVARCHAR(80), d.${f}, 120)` : `LEFT(CAST(d.${f} AS NVARCHAR(80)),80)`;
                    const castNew = isDateTime ? `CONVERT(NVARCHAR(80), s.${f}, 120)` : `LEFT(CAST(s.${f} AS NVARCHAR(80)),80)`;
                    return `CASE WHEN ISNULL(CAST(d.${f} AS NVARCHAR(MAX)),N'') <> ISNULL(CAST(s.${f} AS NVARCHAR(MAX)),N'') THEN N'${f}:'+ISNULL(${castOld},N'NULL')+N'→'+ISNULL(${castNew},N'NULL')+N', ' ELSE N'' END`;
                });

                // 生成变更字段名列表（用于 audit_detail，仅记录字段名，不记录值）
                // audit_detail 存变更字段名数组，完整新旧值可从伴生表快照获取
                const changedFieldsParts = bizFields.map(f =>
                    `CASE WHEN ISNULL(CAST(d.${f} AS NVARCHAR(MAX)),N'') <> ISNULL(CAST(s.${f} AS NVARCHAR(MAX)),N'') THEN N'"${f}",' ELSE N'' END`
                );

                // 将数组分批拼接，避免单条 SQL 表达式过长
                // SQL Server 字符串拼接: part1 + part2 + ...
                const diffExpr = diffParts.join('\n        + ');
                const detailExpr = changedFieldsParts.join('\n        + ');

                s += `
-- Step 4: 伴生表写入（仅当有变更时）
INSERT INTO dbo.${ctName}(
    ${targetFields.join(',\n    ')},
    dw_hash_val,dw_etl_job,dw_load_ts,dw_src_sys,dw_batch_id,change_date,change_type,change_reason
)
SELECT
    ${targetFields.map(f => 's.' + f).join(',\n    ')},
    s.new_hash,'${ctName}',p.load_ts,'BMS',p.batch_id,p.change_date,ch.change_type,'normal'
FROM #ods_snapshot s INNER JOIN #changes ch ON s.${pk0}=ch.${pk0} CROSS JOIN #etl_params p WHERE ch.change_type IN('INSERT','UPDATE');

INSERT INTO dbo.${ctName}(
    ${targetFields.join(',\n    ')},
    dw_hash_val,dw_etl_job,dw_load_ts,dw_src_sys,dw_batch_id,change_date,change_type,change_reason
)
SELECT
    ${targetFields.map(f => 'd.' + f).join(',\n    ')},
    d.dw_hash_val,'${ctName}',p.load_ts,'BMS',p.batch_id,p.change_date,'DELETE','normal'
FROM dbo.${tableName} d INNER JOIN #changes ch ON d.${pk0}=ch.${pk0} CROSS JOIN #etl_params p WHERE ch.change_type='DELETE';

-- Step 4.1: 审计日志 - UPDATE 变更明细（拼接 diff 字符串）
-- diff_fields: 人可读摘要（field:旧值→新值），audit_detail: 变更字段名列表
-- 完整新旧值可通过 record_key 关联伴生表快照查询
-- 注意: FDL 按分号逐条执行，不能用 IF/BEGIN/END 块
SELECT
    s.${pk0} AS _pk,
    ${diffExpr} AS _diff_raw,
    ${detailExpr} AS _detail_raw
INTO #audit_raw
FROM #ods_snapshot s
INNER JOIN dbo.${tableName} d ON ${pkJoin}
INNER JOIN #changes ch ON s.${pk0} = ch.${pk0}
WHERE ch.change_type = 'UPDATE';

-- Step 4.1b: 审计日志 - UPDATE 写入 dw_audit_log
INSERT INTO dbo.dw_audit_log(table_name,data_layer,record_key,audit_type,audit_level,audit_detail,diff_fields,source_table,affected_count,is_resolved,batch_id,created_at)
SELECT
    '${ctName}','DWD',
    '{"${pk0}":' + CAST(a._pk AS VARCHAR(50)) + '}',
    'MODIFIED','INFO',
    N'{"changed_fields":[' + CASE WHEN DATALENGTH(a._detail_raw) >= 2 THEN LEFT(a._detail_raw, DATALENGTH(a._detail_raw)/2 - 1) ELSE N'' END + N']}',
    LEFT(CASE WHEN DATALENGTH(a._diff_raw) >= 4 THEN LEFT(a._diff_raw, DATALENGTH(a._diff_raw)/2 - 2) ELSE a._diff_raw END, 500),
    '${tableName}',1,0,p.batch_id,p.load_ts
FROM #audit_raw a CROSS JOIN #etl_params p;

DROP TABLE #audit_raw;

-- Step 4.2: 审计日志 - INSERT/DELETE 写入 dw_audit_log
INSERT INTO dbo.dw_audit_log(table_name,data_layer,record_key,audit_type,audit_level,audit_detail,diff_fields,source_table,affected_count,is_resolved,batch_id,created_at)
SELECT
    '${ctName}','DWD',
    '{"${pk0}":' + CAST(ch.${pk0} AS VARCHAR(50)) + '}',
    CASE ch.change_type WHEN 'INSERT' THEN 'INSERTED' ELSE 'DELETED' END,
    'INFO',
    '{"change_type":"' + ch.change_type + '"}',
    ch.change_type,
    '${tableName}',1,0,p.batch_id,p.load_ts
FROM #changes ch CROSS JOIN #etl_params p
WHERE ch.change_type IN ('INSERT','DELETE');
`;
            }

            // 主表 INSERT 中引用参数也改用 CROSS JOIN #etl_params
            const allSelectFdl = targetFields.map(f => 's.' + f).concat(['p.load_ts', 'p.load_ts', 's.new_hash', `'${tableName}'`, 'p.load_ts', "'BMS'", 'p.batch_id']);

            s += `
-- Step ${ct ? '5' : '4'}: 全量覆盖主表
TRUNCATE TABLE dbo.${tableName};

INSERT INTO dbo.${tableName}(
    ${allTarget.join(',\n    ')}
)
SELECT
    ${allSelectFdl.join(',\n    ')}
FROM #ods_snapshot s CROSS JOIN #etl_params p
OPTION (MAXDOP 1);

-- 变更统计
SELECT
    (SELECT COUNT(*) FROM #changes WHERE change_type='INSERT') AS inserted,
    (SELECT COUNT(*) FROM #changes WHERE change_type='UPDATE') AS updated,
    (SELECT COUNT(*) FROM #changes WHERE change_type='DELETE') AS deleted,
    (SELECT COUNT(*) FROM dbo.${tableName}) AS total_loaded;

DROP TABLE #ods_snapshot;

DROP TABLE #changes;

---------- 节点 3: 数据质量检查 → 写入 dw_etl_check_log ----------

-- 总行数
INSERT INTO dbo.dw_etl_check_log (table_name, data_layer, check_type, metric_name, metric_value, batch_id)
SELECT '${tableName}', 'DWD', 'ROW_COUNT', 'total_rows', CAST(COUNT(*) AS NVARCHAR(20)),
       (SELECT TOP 1 dw_batch_id FROM dbo.${tableName})
FROM dbo.${tableName};

-- 主键唯一性
INSERT INTO dbo.dw_etl_check_log (table_name, data_layer, check_type, metric_name, metric_value, batch_id)
SELECT '${tableName}', 'DWD', 'SUMMARY', 'pk_uniqueness',
       CASE WHEN COUNT(*) = COUNT(DISTINCT ${pk0}) THEN 'PASS'
            ELSE 'FAIL: ' + CAST(COUNT(*) - COUNT(DISTINCT ${pk0}) AS NVARCHAR(20)) + ' duplicates' END,
       (SELECT TOP 1 dw_batch_id FROM dbo.${tableName})
FROM dbo.${tableName};

-- ODS vs DWD 数量对比
INSERT INTO dbo.dw_etl_check_log (table_name, data_layer, check_type, metric_name, metric_value, batch_id)
SELECT '${tableName}', 'DWD', 'SUMMARY', 'ods_dwd_count_compare',
       (SELECT
            (SELECT COUNT(*) FROM dbo.${ptn}) AS ods_count,
            (SELECT COUNT(*) FROM dbo.${tableName}) AS dwd_count
        FOR JSON PATH, WITHOUT_ARRAY_WRAPPER),
       (SELECT TOP 1 dw_batch_id FROM dbo.${tableName});
${ct ? `
-- 伴生表变更记录数
INSERT INTO dbo.dw_etl_check_log (table_name, data_layer, check_type, metric_name, metric_value, batch_id)
SELECT '${tableName}', 'DWD', 'ROW_COUNT', 'change_di_total',
       CAST(COUNT(*) AS NVARCHAR(20)),
       (SELECT TOP 1 dw_batch_id FROM dbo.${tableName})
FROM dbo.${ctName};
` : ''}
`;
            return s;
        }

        // --- Phase 5: 质量规则 ---
        function generateDwdQualityRules(tableName, tableComment, dwdConfig, fieldMappings, derivedFields, sourceTables) {
            const primaryKeys = dwdConfig.primaryKeys || ['id'];
            const primaryTable = (sourceTables || []).find(t => t.isPrimary);
            const ptn = primaryTable ? primaryTable.name : 'ods_source_table';
            const ct = dwdConfig.changeTracking?.enabled || false;
            const ctName = dwdConfig.changeTracking?.changeTableName || tableName.replace(/_df$/, '_change_di');
            const amountFields = (fieldMappings || []).filter(m => { const dt = (m.dataType || '').toUpperCase(); return dt.includes('DECIMAL') || dt.includes('MONEY'); }).map(m => ({ target: m.targetField || toSnakeCase(m.srcField), src: m.srcField }));
            const nameFields = (derivedFields || []).filter(f => f.exprType === 'REF' || (f.name || '').endsWith('_name')).map(f => f.name);

            const versionTag = (dwdConfig || {}).version ? `\n  配置版本: ${dwdConfig.version}` : '';
            let s = `/*
================================================================================
  ${tableComment || tableName} - 数据质量检查脚本
  创建日期: ${new Date().toISOString().split('T')[0]}${versionTag}
================================================================================
*/

-- 1. 数据量对比
SELECT 'ODS' AS source, COUNT(*) AS cnt FROM dbo.${ptn}
UNION ALL
SELECT 'DWD', COUNT(*) FROM dbo.${tableName};

-- 2. 主键唯一性
SELECT ${primaryKeys.join(', ')}, COUNT(*) AS cnt
FROM dbo.${tableName}
GROUP BY ${primaryKeys.join(', ')}
HAVING COUNT(*) > 1;

`;

            const nullFields = [...primaryKeys, ...nameFields.slice(0, 5), ...amountFields.slice(0, 3).map(f => f.target)];
            if (nullFields.length > 0) {
                s += `-- 3. 关键字段空值率
SELECT COUNT(*) AS total,
${nullFields.map(f => `    SUM(CASE WHEN ${f} IS NULL THEN 1 ELSE 0 END) AS [${f}_null],
    CAST(SUM(CASE WHEN ${f} IS NULL THEN 1 ELSE 0 END)*100.0/NULLIF(COUNT(*),0) AS DECIMAL(5,2)) AS [${f}_pct]`).join(',\n')}
FROM dbo.${tableName};

`;
            }
            if (amountFields.length > 0) {
                s += `-- 4. 金额汇总对比
`;
                amountFields.forEach(f => {
                    s += `SELECT 'ODS_${f.src}' AS metric, SUM(${f.src}) AS val FROM dbo.${ptn} UNION ALL SELECT 'DWD_${f.target}', SUM(${f.target}) FROM dbo.${tableName};
`;
                });
                s += '\n';
            }
            if (dwdConfig.hashConfig?.enabled) {
                s += `-- 5. 哈希完整性
SELECT SUM(CASE WHEN dw_hash_val IS NULL THEN 1 ELSE 0 END) AS hash_null,
    SUM(CASE WHEN LEN(dw_hash_val)<>64 THEN 1 ELSE 0 END) AS hash_invalid,
    COUNT(*) AS total
FROM dbo.${tableName};

`;
            }
            if (ct) {
                s += `-- 6. 变更追踪统计
SELECT change_type, COUNT(*) AS cnt
FROM dbo.${ctName}
WHERE change_date = CAST(GETDATE() AS DATE)
GROUP BY change_type;
`;
            }
            return s;
        }

        // 生成 ODS 层 DDL (SQL Server)
        function generateODSDDL(model) {
            const tableName = model.table_name || 'ods_table_name';
            const tableComment = model.table_comment || '表描述';
            const sourceSystem = model.source_system || 'UNKNOWN';
            const sourceTable = model.source_table || '';

            // 根据规范生成 DDL 模板
            const ddl = `-- ============================================================
-- ODS 层 DDL 脚本 (SQL Server)
-- 表名: ${tableName}
-- 描述: ${tableComment}
-- 源系统: ${sourceSystem}
-- 源表: ${sourceTable || '(未指定)'}
-- 生成时间: ${formatDateTimeUnified(new Date())}
-- ============================================================

-- 先删后建（ODS层为贴源快照，重建保证结构与源表一致）
IF OBJECT_ID(N'dbo.${tableName}', N'U') IS NOT NULL
BEGIN
    DROP TABLE dbo.${tableName};
    PRINT '已删除旧表 [dbo.${tableName}]';
END
GO

CREATE TABLE dbo.${tableName} (
    -- ========== 业务字段 (请根据源表结构补充) ==========
    -- TODO: 从源表 [${sourceTable || 'source_table'}] 复制字段定义
    -- 示例:
    -- id                  BIGINT              NOT NULL,
    -- name                NVARCHAR(100)       NULL,
    -- status              INT                 NULL,
    -- created_time        DATETIME            NULL,

    -- ========== 标准审计字段 (必填) ==========
    dw_load_ts          DATETIME            NOT NULL DEFAULT GETDATE(),   -- 数据加载时间
    dw_src_sys          VARCHAR(50)         NOT NULL DEFAULT '${sourceSystem}',  -- 来源系统标识
    dw_batch_id         VARCHAR(50)         NULL                           -- ETL批次号
);

-- 添加表注释
EXEC sp_addextendedproperty
    @name = N'MS_Description',
    @value = N'${tableComment}',
    @level0type = N'SCHEMA', @level0name = N'dbo',
    @level1type = N'TABLE',  @level1name = N'${tableName}';

PRINT '表 [dbo.${tableName}] 创建成功';
GO`;

            return ddl;
        }

        // 生成带完整字段的 ODS 层 DDL（符合ODS规范，先删后建）
        function generateODSDDLWithColumns(model, columns, sourceTableComment) {
            const tableName = model.table_name || 'ods_table_name';
            // 优先使用源表注释，其次使用模型配置的注释
            const tableComment = sourceTableComment || model.table_comment || '表描述';
            const sourceSystem = model.source_system || 'UNKNOWN';
            const sourceTable = model.source_table || '';
            // M-1′：SQL 字符串字面量单引号转义（注释 SQL 里的列名来自源系统，可能含 '）。
            // 注：tableName 是平台生成的受控 ods_ 名（标识符位置，L-3′ 约束名同源受控），故不在每处 escape。
            const sqlStr = (v) => String(v == null ? '' : v).replace(/'/g, "''");
            // M-1″：SQL 行注释（-- ...）清洗——删 CR/LF（防换行后内容脱离行注释）+ 去控制字符（源列注释为自由文本可能含换行）。
            const sqlLineComment = (v) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

            // 找出主键字段
            const primaryKeyColumns = columns.filter(col => col.is_primary_key);
            const hasPrimaryKey = primaryKeyColumns.length > 0;

            // 生成字段定义（ODS规范：移除IDENTITY，保留数据类型）
            const columnDefs = columns.map(col => {
                let dataType = col.data_type.toUpperCase();

                // 处理字符类型长度
                if (['VARCHAR', 'NVARCHAR', 'CHAR', 'NCHAR'].includes(dataType)) {
                    const len = col.max_length === -1 ? 'MAX' : col.max_length;
                    dataType = `${dataType}(${len})`;
                } else if (['DECIMAL', 'NUMERIC'].includes(dataType)) {
                    dataType = `${dataType}(${col.precision || 18}, ${col.scale || 0})`;
                }

                // ODS规范：IDENTITY字段在ODS层不使用IDENTITY（数据是同步过来的）
                // 但保留NOT NULL约束
                const nullable = col.is_nullable === 'YES' ? 'NULL' : 'NOT NULL';

                // 添加注释（包含IDENTITY标记提示）
                let comment = col.column_comment ? col.column_comment : '';
                if (col.is_identity) {
                    comment = comment ? `${comment} [源表IDENTITY]` : '[源表IDENTITY]';
                }
                const commentStr = comment ? `  -- ${sqlLineComment(comment)}` : '';

                // 格式化对齐（M-4：列名统一方括号转义 ]→]]，防保留字/特殊字符/中文列名生成非法 DDL）
                const safeColName = `[${String(col.column_name).replace(/]/g, ']]')}]`;
                const colName = safeColName.padEnd(26) + (safeColName.length >= 26 ? ' ' : '');
                const colType = dataType.padEnd(20);

                return `        ${colName}${colType}${nullable},${commentStr}`;
            }).join('\n');

            // 生成主键约束（使用ODS规范命名）
            let primaryKeyConstraint = '';
            if (hasPrimaryKey) {
                const pkColumns = primaryKeyColumns.map(col => `[${String(col.column_name).replace(/]/g, ']]')}]`).join(', ');
                // H-1：约束串以逗号起头，使前一行 dw_batch_id 与表级约束之间有分隔（无主键时为空串、不留逗号）
                primaryKeyConstraint = `,
        -- ========== 主键约束 ==========
        CONSTRAINT [PK_${tableName}] PRIMARY KEY CLUSTERED (${pkColumns})`;
            }

            // 生成幂等的表注释语句
            const tableCommentSQL = `
-- 添加/更新表注释（幂等）
IF NOT EXISTS (SELECT 1 FROM sys.extended_properties WHERE major_id = OBJECT_ID(N'dbo.${tableName}') AND minor_id = 0 AND name = N'MS_Description')
    EXEC sp_addextendedproperty @name=N'MS_Description', @value=N'${tableComment.replace(/'/g, "''")}', @level0type=N'SCHEMA', @level0name=N'dbo', @level1type=N'TABLE', @level1name=N'${tableName}';
ELSE
    EXEC sp_updateextendedproperty @name=N'MS_Description', @value=N'${tableComment.replace(/'/g, "''")}', @level0type=N'SCHEMA', @level0name=N'dbo', @level1type=N'TABLE', @level1name=N'${tableName}';
GO`;

            // 生成幂等的字段注释语句（仅对有注释的字段）
            const columnComments = columns
                .filter(col => col.column_comment)
                .map(col => {
                    const escapedComment = col.column_comment.replace(/'/g, "''");
                    return `-- ${sqlLineComment(col.column_name)}
IF NOT EXISTS (SELECT 1 FROM sys.extended_properties WHERE major_id = OBJECT_ID(N'dbo.${tableName}') AND minor_id = (SELECT column_id FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.${tableName}') AND name = N'${sqlStr(col.column_name)}') AND name = N'MS_Description')
    EXEC sp_addextendedproperty @name=N'MS_Description', @value=N'${escapedComment}', @level0type=N'SCHEMA', @level0name=N'dbo', @level1type=N'TABLE', @level1name=N'${tableName}', @level2type=N'COLUMN', @level2name=N'${sqlStr(col.column_name)}';
ELSE
    EXEC sp_updateextendedproperty @name=N'MS_Description', @value=N'${escapedComment}', @level0type=N'SCHEMA', @level0name=N'dbo', @level1type=N'TABLE', @level1name=N'${tableName}', @level2type=N'COLUMN', @level2name=N'${sqlStr(col.column_name)}';
GO`;
                }).join('\n\n');

            // 审计字段注释（幂等）
            const auditFields = [
                { name: 'dw_load_ts', comment: '数据加载时间' },
                { name: 'dw_src_sys', comment: '来源系统标识' },
                { name: 'dw_batch_id', comment: 'ETL批次号' }
            ];
            const auditComments = auditFields.map(field => {
                return `-- ${field.name}
IF NOT EXISTS (SELECT 1 FROM sys.extended_properties WHERE major_id = OBJECT_ID(N'dbo.${tableName}') AND minor_id = (SELECT column_id FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.${tableName}') AND name = N'${field.name}') AND name = N'MS_Description')
    EXEC sp_addextendedproperty @name=N'MS_Description', @value=N'${field.comment}', @level0type=N'SCHEMA', @level0name=N'dbo', @level1type=N'TABLE', @level1name=N'${tableName}', @level2type=N'COLUMN', @level2name=N'${field.name}';
ELSE
    EXEC sp_updateextendedproperty @name=N'MS_Description', @value=N'${field.comment}', @level0type=N'SCHEMA', @level0name=N'dbo', @level1type=N'TABLE', @level1name=N'${tableName}', @level2type=N'COLUMN', @level2name=N'${field.name}';
GO`;
            }).join('\n\n');

            // 统计信息
            const identityCount = columns.filter(col => col.is_identity).length;
            const identityNote = identityCount > 0 ? `\n-- 注意: 已移除 ${identityCount} 个 IDENTITY 属性（ODS层数据从源系统同步，不使用自增）` : '';

            const ddl = `-- ============================================================
-- ODS 层 DDL 脚本 (SQL Server) - 先删后建，可重复执行
-- ============================================================
-- 表名: ${tableName}
-- 描述: ${sqlLineComment(tableComment)}
-- 源系统: ${sourceSystem}
-- 源表: ${sourceTable || '(未指定)'}
-- 生成时间: ${formatDateTimeUnified(new Date())}
-- 字段来源: 自动从源表获取 (${columns.length} 个业务字段 + 3 个审计字段)
-- ============================================================
-- ODS层设计原则:
--   1. 结构贴源: 字段名、字段类型与源表一致
--   2. 移除IDENTITY: 数据从源系统同步，主键值已存在
--   3. 移除业务DEFAULT: 只保留审计字段的DEFAULT
--   4. 移除FK/CHECK: ODS层不做参照完整性校验
--   5. 审计增强: 添加 dw_load_ts, dw_src_sys, dw_batch_id
-- ============================================================${identityNote}

-- ============================================================
-- 第一部分: 先删后建（ODS层为贴源快照，重建保证结构与源表一致）
-- ============================================================
IF OBJECT_ID(N'dbo.${tableName}', N'U') IS NOT NULL
BEGIN
    DROP TABLE dbo.${tableName};
    PRINT '已删除旧表 [dbo.${tableName}]';
END
GO

CREATE TABLE dbo.${tableName} (
    -- ========== 业务字段 (从源表 [${sourceTable}] 获取) ==========
${columnDefs}

    -- ========== 标准审计字段 ==========
    dw_load_ts          DATETIME            NOT NULL DEFAULT GETDATE(),
    dw_src_sys          VARCHAR(50)         NOT NULL DEFAULT '${sqlStr(sourceSystem)}',
    dw_batch_id         VARCHAR(50)         NULL${primaryKeyConstraint}
);
PRINT '表 [dbo.${tableName}] 创建成功';
GO

-- ============================================================
-- 第二部分: 表注释（幂等，可重复执行）
-- ============================================================
${tableCommentSQL}

-- ============================================================
-- 第三部分: 字段注释（幂等，可重复执行）
-- ============================================================
${columnComments}

-- ========== 审计字段注释 ==========
${auditComments}

PRINT '所有注释添加/更新完成';
GO`;

            return ddl;
        }

        // 生成同步后置脚本
        function generateSyncScript(tableName) {
            return `-- 数据同步完成后执行（更新批次号）
UPDATE [dbo].[${tableName}]
SET dw_batch_id = REPLACE(REPLACE(REPLACE('\${cyctime}', '-', ''), ' ', ''), ':', '');`;
        }

        return {
            KIT_VERSION: KIT_VERSION,
            toSnakeCase: toSnakeCase,
            normalizeDataType: normalizeDataType,
            buildChangeTag: buildChangeTag,
            resolveFieldExpr: resolveFieldExpr,
            generateDimDDLFromConfig: generateDimDDLFromConfig,
            generateDimDDL: generateDimDDL,
            generateExpressionSQL: generateExpressionSQL,
            _generateExpressionSQLInner: _generateExpressionSQLInner,
            buildFromClause: buildFromClause,
            buildCtePrefix: buildCtePrefix,
            generateFullLoadScript: generateFullLoadScript,
            generateIncrementalScript: generateIncrementalScript,
            generateFdlNodeScript: generateFdlNodeScript,
            buildRecordKey: buildRecordKey,
            buildAuditJsonSnapshot: buildAuditJsonSnapshot,
            buildAuditBeforeAfter: buildAuditBeforeAfter,
            buildAuditFlatPairs: buildAuditFlatPairs,
            buildDiffFieldsStuff: buildDiffFieldsStuff,
            buildDwdHashExpression: buildDwdHashExpression,
            getPrimarySourceAlias: getPrimarySourceAlias,
            sortFieldsWithNamePairing: sortFieldsWithNamePairing,
            generateDwdDDL: generateDwdDDL,
            generateCompanionDDL: generateCompanionDDL,
            generateDwdFullLoadScript: generateDwdFullLoadScript,
            generateDwdIncrementalScript: generateDwdIncrementalScript,
            generateDwdFdlScript: generateDwdFdlScript,
            generateDwdQualityRules: generateDwdQualityRules,
            generateODSDDL: generateODSDDL,
            generateODSDDLWithColumns: generateODSDDLWithColumns,
            generateSyncScript: generateSyncScript
        };
    }));
