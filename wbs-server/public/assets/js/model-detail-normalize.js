/* model-detail-normalize.js — 模型中心 详情抽屉 C2 normalize 适配层 + 安全渲染工具
   命名空间：window.ModelDetailKit.*（禁止新增裸全局函数名——对齐 unify-helpers.js 约定）。
   规格：模型详情抽屉方案 v1.4 §5.1（DTO/映射表/§5.1a ODS 类型格式化）+ §5.2（安全渲染白名单）。
   UMD：浏览器挂 window.ModelDetailKit；Node（scripts/verify-model-drawer-normalize.js）require 同一实现。
   安全渲染（dom.*）依赖 document，仅浏览器可用；normalize 部分纯数据无 DOM 依赖。
*/
;(function (root, factory) {
    'use strict';
    var api = factory();
    if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
    if (root) { root.ModelDetailKit = api; }
}(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    // 版本印记：必须与 Model_Center.html 引用本文件的 ?v=..._<KIT_VERSION> 后缀一致。
    // 改本文件 → 同时改这里和 HTML 缓存串。页面启动时会比对，不一致直接在 console 报错，
    // 把「改了共享 JS 却忘了 bump 缓存串、用户拿到旧版」从静默失败变成看得见的错误。
    // （2026-07-24 实际踩坑：C6/C8 改了本文件未 bump，用户界面来源系统/源表/行数全显示「—」）
    var KIT_VERSION = 'mdc4';

    // ===== warnings 闭集（§5.1 DTO）=====
    var WARN = {
        CONFIG: 'CONFIG_UNPARSEABLE_OR_MISSING',
        FIELDS_EMPTY: 'FIELDS_EMPTY',
        METADATA_UNAVAILABLE: 'METADATA_UNAVAILABLE'
    };

    function normStr(v) {
        if (v === null || v === undefined) { return null; }
        var s = String(v).trim();
        return s === '' ? null : s;
    }

    function isPlainObject(v) {
        return !!v && typeof v === 'object' && !Array.isArray(v);
    }

    // ===== kind 判定（§5.1，优先级从上到下）=====
    function resolveKind(model, cfg) {
        if ((model && model.companion_of) || (isPlainObject(cfg) && cfg.parentModelId)) { return 'companion'; }
        if (model && model.config_mode === 'custom') { return 'custom'; }
        var layer = (model && model.layer ? String(model.layer) : '').toUpperCase();
        if (layer === 'DWD') { return 'dwd'; }
        if (layer === 'DIM') { return 'dim'; }
        if (layer === 'ODS') { return 'ods'; }
        return 'generic';
    }

    // 安全整数判定（审 12）：Number.isSafeInteger 的本地兜底，保持本文件 ES5 风格与 Node/浏览器双端一致
    function isSafeInt(n) {
        return typeof n === 'number' && isFinite(n) && Math.floor(n) === n && Math.abs(n) <= 9007199254740991;
    }

    // 数值归一化（C2 审 M-1）：接受 number 与纯数字字符串（含 "-1"），其余（NaN/空/损坏）按缺失处理
    function toFiniteInt(v) {
        if (typeof v === 'number' && isFinite(v)) { return Math.trunc(v); }
        if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) { return parseInt(v.trim(), 10); }
        return null;
    }

    // ===== §5.1a ODS 类型格式化（sys.columns.max_length 是字节数）=====
    function formatOdsType(col) {
        if (!isPlainObject(col)) { return ''; }
        var t = (normStr(col.data_type) || '').toLowerCase();
        if (!t) { return ''; }
        var maxLen = toFiniteInt(col.max_length);
        if (t === 'nvarchar' || t === 'nchar') {
            if (maxLen === -1) { return t + '(MAX)'; }
            if (maxLen !== null && maxLen > 0) { return t + '(' + (maxLen / 2) + ')'; }
            return t;
        }
        if (t === 'varchar' || t === 'char' || t === 'varbinary') {
            if (maxLen === -1) { return t + '(MAX)'; }
            if (maxLen !== null && maxLen > 0) { return t + '(' + maxLen + ')'; }
            return t;
        }
        if (t === 'decimal' || t === 'numeric') {
            var prec = toFiniteInt(col.precision);
            if (prec !== null) {
                var scale = toFiniteInt(col.scale);
                return t + '(' + prec + ', ' + (scale !== null ? scale : 0) + ')';
            }
            return t;
        }
        return t; // int/datetime/bit/… 裸类型名，不附加长度
    }

    // ===== 主键匹配（小写比对；businessKey 可逗号分隔多字段）=====
    // DIM businessKey 存的是源字段名（如 OfficialCustomerID），而 fields[].name 是目标字段名
    // （official_customer_id）——按方案字面"比对 name"会漏匹配，故 name/source 双路比对（工程补全）。
    function buildKeySet(raw) {
        var set = {};
        (Array.isArray(raw) ? raw : String(raw || '').split(','))
            .map(function (k) { return String(k || '').trim().toLowerCase(); })
            .filter(Boolean)
            .forEach(function (k) { set[k] = true; });
        return set;
    }

    function matchKey(keySet, field) {
        var name = String(field.name || '').toLowerCase();
        var src = String(field.source || '').toLowerCase();
        // source 可能带表别名前缀（c.ContractID）——去别名后也参与比对（对齐 loadSelectedFieldsToUI 先例）
        var srcNoAlias = src.indexOf('.') >= 0 ? src.slice(src.indexOf('.') + 1) : src;
        return !!(keySet[name] || keySet[src] || keySet[srcNoAlias]);
    }

    // ===== 各 kind 字段抽取（§5.1 映射表，键名=生产 dim_config 实际键）=====

    function mapDerived(list) {
        return (Array.isArray(list) ? list : []).map(function (f) {
            return {
                name: normStr(f && f.name) || '',
                type: normStr(f && f.type) || '',
                comment: normStr(f && f.comment) || '',
                source: normStr(f && f.source) || '',
                isPk: false,
                isDerived: true,
                addedAt: normStr(f && f.addedAt)
            };
        });
    }

    // 空字段名过滤（C2 审 M-2）：三类 kind 统一在返回前滤掉 name 为空的行；过滤后 0 才触发 FIELDS_EMPTY
    function dropUnnamed(fields) {
        return fields.filter(function (f) { return !!f.name; });
    }

    function extractDwdFields(cfg) {
        var pkSet = buildKeySet(isPlainObject(cfg.dwdConfig) ? cfg.dwdConfig.primaryKeys : []);
        var selected = (Array.isArray(cfg.selectedFields) ? cfg.selectedFields : []).map(function (f) {
            var field = {
                name: normStr(f && f.targetField) || '',
                type: normStr(f && f.dataType) || '',
                comment: normStr(f && f.comment) || '',
                source: normStr(f && f.srcField) || '',
                isPk: false,
                isDerived: false,
                addedAt: normStr(f && f.addedAt)
            };
            field.isPk = matchKey(pkSet, field);
            return field;
        });
        return dropUnnamed(selected.concat(mapDerived(cfg.derivedFields)));
    }

    function extractDimFields(cfg) {
        var scd = isPlainObject(cfg.scdConfig) ? cfg.scdConfig : {};
        var keySet = buildKeySet(scd.businessKey);
        var base;
        if (Array.isArray(scd.fieldMappings) && scd.fieldMappings.length > 0) {
            base = scd.fieldMappings.map(function (m) {
                var field = {
                    name: normStr(m && m.targetField) || '',
                    type: normStr(m && m.dataType) || '',
                    comment: normStr(m && m.comment) || '',
                    // 双键兼容：sourceField（旧）/ srcField（新）——Model_Center.html loadSelectedFieldsToUI 先例
                    source: normStr(m && (m.sourceField || m.srcField)) || '',
                    isPk: false,
                    isDerived: false,
                    addedAt: normStr(m && m.addedAt)
                };
                field.isPk = matchKey(keySet, field);
                return field;
            });
        } else if (Array.isArray(scd.trackFields) && scd.trackFields.length > 0) {
            // 旧数据仅字段名（generateDimETLFromConfig 回落先例）；type 允许空
            base = scd.trackFields.map(function (f) {
                var name = normStr(f) || '';
                var field = { name: name, type: '', comment: '', source: name, isPk: false, isDerived: false, addedAt: null };
                field.isPk = matchKey(keySet, field);
                return field;
            });
        } else {
            base = [];
        }
        var all = dropUnnamed(base.concat(mapDerived(scd.derivedFields)));
        // 去重按 name 小写（保留首个）
        var seen = {};
        return all.filter(function (f) {
            var k = f.name.toLowerCase();
            if (seen[k]) { return false; }
            seen[k] = true;
            return true;
        });
    }

    function extractOdsFields(metadata) {
        var meta = isPlainObject(metadata) && isPlainObject(metadata.metadata) ? metadata.metadata : null;
        if (!meta || !Array.isArray(meta.columns)) { return null; } // null=metadata 不可用（≠空表）
        var pkSet = buildKeySet(Array.isArray(meta.primaryKeys) ? meta.primaryKeys : []);
        return dropUnnamed(meta.columns.map(function (c) {
            var field = {
                name: normStr(c && c.column_name) || '',
                type: formatOdsType(c),
                comment: '',            // metadata 无注释（D4：无 addedAt，「新」徽章不适用）
                source: '',
                isPk: false,
                isDerived: false,
                addedAt: null
            };
            field.isPk = matchKey(pkSet, field);
            return field;
        }));
    }

    // ===== logic / scd / parent 块 =====

    // C8：高级 SQL 分段抽取。生产实测三种形态——
    //   type='CTE'   仅 cteContent（dim_org：432 字符递归 CTE）
    //   type='APPLY' 且 types=['APPLY','CTE'] → applyContent **与** cteContent 并存（dim_official_customer）
    //   type='NONE'  显式关闭（即使残留 content 也不展示，尊重开关语义）
    // 旧实现只读 applyContent，导致前者全丢、后者丢 CTE 段。此处按内容实际存在与否收集，不依赖 types 数组。
    // 顺序 CTE→APPLY：对齐 SQL 阅读顺序（WITH 在前，OUTER APPLY 在 FROM 之后）。
    function extractSqlParts(sqlObj) {
        if (!isPlainObject(sqlObj)) { return []; }
        if ((normStr(sqlObj.type) || '').toUpperCase() === 'NONE') { return []; }
        var parts = [];
        var cte = normStr(sqlObj.cteContent);
        if (cte) { parts.push({ kind: 'CTE', content: cte }); }
        var apply = normStr(sqlObj.applyContent);
        if (apply) { parts.push({ kind: 'APPLY', content: apply }); }
        return parts;
    }

    function extractLogic(cfg) {
        var dwdCfg = isPlainObject(cfg.dwdConfig) ? cfg.dwdConfig : {};
        var sqlObj = isPlainObject(cfg.advancedSql) ? cfg.advancedSql : null;
        var sqlParts = extractSqlParts(sqlObj); // C8 单一真相源，视图不再直读 applyContent
        var logic = {
            filterCondition: normStr(dwdCfg.filterCondition),
            advancedSql: sqlObj, // 原始结构对象透传（审 03 H-02.1）
            sqlParts: sqlParts,
            // 审 16 M-1：description 必须跟随 sqlParts 一起隐藏。否则 type='NONE'（高级 SQL 已关闭）
            // 且有 JOIN/filter 撑起「加工逻辑」段时，会孤零零显示一句已关闭功能的说明文案。
            sqlDescription: (sqlObj && sqlParts.length) ? normStr(sqlObj.description) : null,
            grain: normStr(dwdCfg.dataGranularity)
        };
        return (logic.filterCondition || logic.advancedSql || logic.grain) ? logic : null;
    }

    // DWD 元信息（C4 审 M-1：更新策略/hash 收进 normalize 单一真相源，视图层不再直读 raw model.dim_config）
    function extractDwdMeta(cfg) {
        var dwdCfg = isPlainObject(cfg.dwdConfig) ? cfg.dwdConfig : {};
        return {
            updateStrategy: normStr(dwdCfg.updateStrategy),
            hashEnabled: !!(isPlainObject(dwdCfg.hashConfig) && dwdCfg.hashConfig.enabled === true)
        };
    }

    function extractScd(cfg, fields) {
        var scd = isPlainObject(cfg.scdConfig) ? cfg.scdConfig : null;
        if (!scd) { return null; }
        var trackFieldCount = fields.filter(function (f) { return !f.isDerived; }).length; // 去重后业务字段数（审 03 H-02.1）
        // C8 DIM 加厚：scdConfig.options 里存着大量生产真实配置，此前一条都没展示
        //（dim_org：etlStrategy=TRUNCATE_INSERT / schedule=T+1 每日 / 12 个 monitoredFields；
        //  dim_official_customer：versionKey=ChangeID / stateFilter / effDtExpr / 5 个附加索引）
        var opts = isPlainObject(scd.options) ? scd.options : {};
        var monitored = (Array.isArray(scd.monitoredFields) ? scd.monitoredFields : [])
            .map(function (f) { return normStr(f); }).filter(Boolean);
        var idxCount = Array.isArray(opts.additionalIndexes) ? opts.additionalIndexes.length : 0;
        return {
            scdType: normStr(scd.scdType),
            businessKey: normStr(scd.businessKey),
            trackFieldCount: trackFieldCount,
            versionKey: normStr(scd.versionKey),
            monitoredFields: monitored,
            etlStrategy: normStr(opts.etlStrategy),
            schedule: normStr(opts.schedule),
            description: normStr(opts.description),
            stateFilter: normStr(opts.stateFilter),
            effDtExpr: normStr(opts.effDtExpr),
            auditTable: normStr(opts.auditTable),
            indexCount: idxCount,
            // ⚠️ DTO 契约（审 18 L）：flags 是**生效值**（effective flags，含平台默认补齐），
            //    **不可**用它反推「用户是否显式配置过」——auditLog:true 既可能是用户勾的、也可能是缺失补的默认。
            //    需要判断配置来源的消费方，请读原始 dim_config.scdConfig.options。
            // 四个检测/审计开关，取生效值，视图层据此判断「是否偏离默认」。
            // 前三项表单默认不勾（缺失=false，严格 === true 才算开）；
            // auditLog 表单默认勾选（Model_Center.html:648 `<input id="scdOptAudit" checked>`），
            // 故 **缺失/undefined/null 必须补成 true**，否则「没有 options 的裸配置 DIM」会被误判成「显式关闭审计」
            // 而渲染出一段只有灰开关的空壳（审 17 M-1 实证：与 M-2 的修复意图正好相反）。
            // 脏值（字符串 "true" 等）一律按关闭处理 → 会被判为偏离默认而展示，保守方向安全。
            flags: {
                deleteDetection: opts.deleteDetection === true,
                modifyDetection: opts.modifyDetection === true,
                consistencyAlert: opts.consistencyAlert === true,
                auditLog: (opts.auditLog === undefined || opts.auditLog === null) ? true : opts.auditLog === true
            }
        };
    }

    function extractSources(cfg) {
        return (Array.isArray(cfg.sourceTables) ? cfg.sourceTables : []).map(function (t) {
            return {
                name: normStr(t && t.name) || '',
                alias: normStr(t && t.alias) || '',
                isPrimary: !!(t && t.isPrimary),
                joinType: normStr(t && t.joinType),
                joinCondition: normStr(t && t.joinCondition)
            };
        });
    }

    // ===== 主入口（§5.1）：normalizeModelDetail(model, metadata?) -> Detail =====
    // model = GET /api/models/:id 返回（dim_config 已由服务端解析为对象；无配置/损坏统一 null——前端不可区分）
    // metadata = GET /api/models/:id/metadata 返回（仅 ODS 传入）
    function normalizeModelDetail(model, metadata) {
        model = isPlainObject(model) ? model : {};
        // dim_config 类型守卫：非普通对象（字符串化/数组/null）一律视为不可解析（对齐 H0 validateDimConfigShape 语义）
        var cfg = isPlainObject(model.dim_config) ? model.dim_config : null;
        var kind = resolveKind(model, cfg);
        var warnings = [];

        var detail = {
            kind: kind,
            identity: {
                id: model.id,
                tableName: normStr(model.table_name) || '',
                tableComment: normStr(model.table_comment) || '',
                layer: (normStr(model.layer) || '').toUpperCase(),
                domain: normStr(model.domain),
                status: normStr(model.status),
                techOwner: normStr(model.tech_owner),
                updateCycle: normStr(model.update_cycle),
                configMode: normStr(model.config_mode),
                // C6 贴源标识（data_models.source_system / source_table，GET /api/models/:id 走 SELECT * 已带回）：
                // ODS 视图展示「来源系统 / 源表」；DIM/DWD 该两列生产普遍为空，故仅 ODS 分支渲染。
                sourceSystem: normStr(model.source_system),
                sourceTable: normStr(model.source_table)
            },
            sources: [],
            fields: [],
            logic: null,
            scd: null,
            parent: null,
            dwdMeta: null,   // 仅 dwd（C4 审 M-1：updateStrategy/hashEnabled）
            odsMeta: null,   // 仅 ods（C6：rowCount 近似行数，metadata 懒加载后才有值）
            warnings: warnings
        };

        if (kind === 'companion') {
            detail.parent = {
                parentModelId: (cfg && cfg.parentModelId) || model.companion_of || null,
                parentTableName: (cfg && normStr(cfg.parentTableName)) || null
            };
            return detail; // 不解析字段（视图=伴生身份+主模型链接+脚本入口）
        }
        if (kind === 'custom' || kind === 'generic') {
            return detail; // 不解析字段
        }

        if (kind === 'ods') {
            // C6：近似行数与 columns 同批返回；后端查询失败时为 null（前端显示「—」，不报错态——
            // 行数是增强信息，不可因它缺失污染字段区的 METADATA_UNAVAILABLE 语义）
            var odsRawMeta = isPlainObject(metadata) && isPlainObject(metadata.metadata) ? metadata.metadata : null;
            // 审 12（双方 LOW）：不沿用 toFiniteInt 的宽松边界——它给 max_length/precision 那类小整数用，
            // parseInt('9'.repeat(21)) 会得到 1e21 且 isFinite 为真，行数直接显示成天文数字。故加 isSafeInteger 收口。
            var rc = odsRawMeta ? toFiniteInt(odsRawMeta.rowCount) : null;
            detail.odsMeta = { rowCount: (rc !== null && rc >= 0 && isSafeInt(rc)) ? rc : null };
            // ODS：fields 来自 metadata（dim_config 与 ODS 字段无关，不报 CONFIG warning）
            var odsFields = extractOdsFields(metadata);
            if (odsFields === null) {
                warnings.push(WARN.METADATA_UNAVAILABLE);
            } else if (odsFields.length === 0) {
                warnings.push(WARN.FIELDS_EMPTY);
            } else {
                detail.fields = odsFields;
            }
            return detail;
        }

        // dwd / dim：需要 dim_config
        if (!cfg) {
            warnings.push(WARN.CONFIG); // 「配置缺失或不可解析」（服务端统一 null，前端不可区分）
            return detail;
        }
        detail.sources = extractSources(cfg);
        detail.logic = extractLogic(cfg);
        if (kind === 'dwd') {
            detail.fields = extractDwdFields(cfg);
            detail.dwdMeta = extractDwdMeta(cfg);
        } else {
            detail.fields = extractDimFields(cfg);
            detail.scd = extractScd(cfg, detail.fields);
        }
        if (detail.fields.length === 0) {
            warnings.push(WARN.FIELDS_EMPTY);
        }
        return detail;
    }

    // ===== §5.2 安全渲染工具（仅浏览器；数据经 createElement/textContent 落 DOM）=====
    // 属性白名单：title / aria-* / 数值 data-model-id——仅此三类承载数据；
    // className 只接受代码字面量（调用方自律，不得拼入数据）；href/src/style/on* 一律不提供。
    var dom = null;
    if (typeof document !== 'undefined') {
        dom = {
            el: function (tag, opts) {
                opts = opts || {};
                var node = document.createElement(tag);
                if (opts.className) { node.className = opts.className; }
                if (opts.text !== undefined && opts.text !== null) { node.textContent = String(opts.text); }
                if (opts.title !== undefined && opts.title !== null) { node.title = String(opts.title); }
                if (opts.aria && typeof opts.aria === 'object') {
                    Object.keys(opts.aria).forEach(function (k) {
                        // C2 审 L-1：收紧 key 校验（拒绝空串/前导连字符等无意义 aria- 属性）
                        if (/^[a-z][a-z0-9-]*$/.test(k)) { node.setAttribute('aria-' + k, String(opts.aria[k])); }
                    });
                }
                if (opts.modelId !== undefined && opts.modelId !== null) {
                    var idNum = Number(opts.modelId);
                    if (Number.isInteger(idNum)) { node.setAttribute('data-model-id', String(idNum)); }
                }
                if (Array.isArray(opts.children)) {
                    opts.children.forEach(function (c) { if (c) { node.appendChild(c); } });
                }
                return node;
            },
            text: function (s) { return document.createTextNode(s === null || s === undefined ? '' : String(s)); },
            clear: function (node) { while (node && node.firstChild) { node.removeChild(node.firstChild); } }
        };
    }

    return {
        KIT_VERSION: KIT_VERSION,
        WARN: WARN,
        normalizeModelDetail: normalizeModelDetail,
        formatOdsType: formatOdsType,
        resolveKind: resolveKind,
        dom: dom
    };
}));
