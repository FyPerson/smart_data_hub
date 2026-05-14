/**
 * SQL Smoke Test 校验器（Deploy 3 模块 3）
 *
 * 设计来源：docs/local/数据协作模块_方案_v2.0.md §6
 * codex 八审拍板（10 条全采纳）：docs/local/codex审查记录/数据协作模块/09-D3-模块3-4层防御-取舍审-20260513.md
 *
 * ============================================================================
 * 4 层防御体系
 * ============================================================================
 *
 * [层 0] 词法状态机（lexer）— 在 parser 之前的 token 级扫描
 *   - 跳过字符串字面量 / 注释 / 方括号标识符 / 双引号标识符
 *   - 统计有效分号（除可选尾分号，多于 0 个即拒）
 *   - 扫描"无条件拒绝 token"（高危关键字 + 高危过程名）
 *   - 未闭合字符串/注释 → 拒绝（防绕过）
 *
 * [层 1] node-sql-parser astify 解析
 *   - 解析失败 → 拒绝（多数危险语法天然失败：OPENROWSET / EXEC / WAITFOR）
 *   - 返回 array（多语句）→ 拒绝
 *   - AST 顶层 type 必须 === 'select'（CTE 顶层在 node-sql-parser 也是 select）
 *
 * [层 2] AST walker 递归检查 — parser 解析成功但语义危险
 *   - 检测真 INTO（select.into.expr 非空，区分空占位 {position}）
 *   - 检测跨库三段名（multipart name: 任何 from/join 的 db 字段非空且 ≠ business_db）
 *   - 递归遍历 with[i].stmt.ast / from / _next（UNION 链）/ 子查询
 *
 * [层 3] TOP 100 注入（AST 层）— 仅当层 0-2 全通过
 *   - 在 AST 上设置 top: { value: 100, percent: null }（覆盖式，不重复）
 *   - sqlify 回 SQL 字符串
 *   - sqlify 失败或边界 case → 直接拒绝（不字符串包外层 fallback）
 *
 * [层 4] 实际执行（由 server.js 调用方负责，不在本模块）
 *   - mssql 库 request.timeout = 20s
 *   - 只读账号 readonly_user @ business_db
 *   - 全局互斥（同时只跑一条 smoke test，方案 §6.4-A）
 *
 * ============================================================================
 * 危险关键字分类（codex M2）
 * ============================================================================
 *
 * 类 A — 无条件拒绝 token（层 0 词法层兜底）
 *   EXEC / EXECUTE      （所有 EXEC 调用，含 xp_/sp_ 系统过程）
 *   WAITFOR             （时间盲注）
 *   OPENROWSET          （外部数据源读取）
 *   OPENDATASOURCE      （同上）
 *   OPENQUERY           （链接服务器查询）
 *   BULK                （大容量加载，含 OPENROWSET(BULK)）
 *   xp_<任意>           （扩展存储过程，PUBLIC 角色默认可调）
 *   高危 sp_<名单>      （sp_executesql / sp_oacreate 等，见 DANGEROUS_PROCS）
 *
 * 类 B — 由层 1 parser 解析失败覆盖（不在层 0 显式列出）
 *   CREATE / DROP / ALTER / INSERT / UPDATE / DELETE / TRUNCATE / GRANT / REVOKE
 *   BACKUP / RESTORE / KILL
 *   （这些首 token 进入 parser 后会按 transactsql 语法报错或解析为非 select 类型）
 *
 * 类 C — 由层 2 AST 检查覆盖
 *   SELECT INTO           （AST 上 into.expr 非空）
 *   master.dbo.xxx 等     （AST 上 db !== 'business_db'）
 *
 * ============================================================================
 * 安全边界（codex M4）
 * ============================================================================
 *
 * TOP 100 + 20s 超时 ≠ 资源消耗上限。
 * 复杂 JOIN / 排序 / 函数计算仍可拖垮业务库。
 * 真正的 DoS 防御依赖：
 *   - DBA 配置 readonly_user 只读 + 固定库（F1 已验，F2 待 D3 上线前完成）
 *   - 全局 smoke test 互斥（同时只跑一条，方案 §6.4-A，由调用方实现）
 *   - 业务库本身的 query plan / 资源监控（不在平台职责内）
 *
 * 本模块仅保证 SQL 静态层面的"形态安全"，不保证"执行成本可控"。
 */

'use strict';

const { Parser } = require('node-sql-parser');
const parser = new Parser();

// ============================================================================
// 常量定义
// ============================================================================

/** 当前业务库白名单（v2.0 单方言决策仅 SQL Server business_db）*/
const ALLOWED_DATABASE = 'business_db';

/** TOP N 注入值（方案 §6.1）*/
const TOP_LIMIT = 100;

/**
 * 高危过程名单（codex C2 Claude 扩展版）
 *
 * xp_* 一族：PUBLIC 角色默认可调（F1 验收已确认）。整族无条件拒绝。
 *
 * sp_* 一族：业务方真实场景下可能创建 sp_ 开头的存储过程，不全量拒绝；
 * 只拒绝以下高危名单：
 */
const DANGEROUS_SP_PROCS = new Set([
    'sp_executesql',         // 动态 SQL 执行（首要拒绝）
    'sp_oacreate',           // OLE 自动化对象创建
    'sp_oadestroy',          // OLE 自动化对象销毁
    'sp_oamethod',           // OLE 自动化方法调用
    'sp_oasetproperty',      // OLE 自动化属性设置
    'sp_oagetproperty',      // OLE 自动化属性读取
    'sp_addextendedproc',    // 扩展存储过程注册
    'sp_dropextendedproc',   // 扩展存储过程卸载
    'sp_makewebtask',        // 旧版 Web 任务（已弃用但仍可能存在）
    'sp_send_dbmail',        // 数据库邮件（可滥用做数据外发）
]);

/**
 * 无条件拒绝的危险关键字 token（层 0 词法层扫描）
 *
 * 这些 token 一旦在词法层识别到（已排除字符串/注释/标识符），直接拒绝。
 */
const DANGEROUS_KEYWORDS = new Set([
    'EXEC', 'EXECUTE',
    'WAITFOR',
    'OPENROWSET',
    'OPENDATASOURCE',
    'OPENQUERY',
    'BULK',
]);

// ============================================================================
// 主入口
// ============================================================================

/**
 * 校验并改写 SQL（4 层防御一次跑完）
 *
 * @param {string} originalSql 用户提交的 SQL 文本
 * @returns {{ ok: true, smokeSql: string } | { ok: false, layer: number, reason: string, detail?: string }}
 *
 * 成功：ok=true，smokeSql 是注入 TOP 100 后的待执行 SQL
 * 失败：ok=false，layer 标记被哪一层拒绝，reason 是给用户看的简短描述
 */
function validateAndTransform(originalSql) {
    if (typeof originalSql !== 'string' || originalSql.trim().length === 0) {
        return { ok: false, layer: 0, reason: 'SQL 为空' };
    }

    // 层 0：词法状态机
    const layer0 = layer0_lexerScan(originalSql);
    if (!layer0.ok) return { ok: false, layer: 0, ...layer0 };

    // 层 1：parser 解析
    const layer1 = layer1_parse(originalSql);
    if (!layer1.ok) return { ok: false, layer: 1, ...layer1 };

    // 层 2：AST walker 递归检查
    const layer2 = layer2_astCheck(layer1.ast);
    if (!layer2.ok) return { ok: false, layer: 2, ...layer2 };

    // 层 3：TOP 100 AST 注入
    const layer3 = layer3_injectTop(layer1.ast);
    if (!layer3.ok) return { ok: false, layer: 3, ...layer3 };

    return { ok: true, smokeSql: layer3.smokeSql };
}

// ============================================================================
// 层 0：词法状态机
// ============================================================================

/**
 * Token 类型
 *   WORD          - 标识符或关键字（[A-Za-z_@#][A-Za-z0-9_@#]*）
 *   NUMBER        - 数字字面量
 *   STRING        - 单引号字符串 'xxx' 或 N'xxx'（含 '' 转义）
 *   BRACKET_ID    - 方括号标识符 [xxx]（含 ]] 转义）
 *   DQUOTE_ID     - 双引号标识符 "xxx"（QUOTED_IDENTIFIER ON）
 *   COMMENT_LINE  - 单行注释 -- ...
 *   COMMENT_BLOCK - 多行注释 /* ... *\/
 *   SEMICOLON     - ;
 *   PUNCT         - 其他单字符（运算符、括号、逗号、点、星号等）
 *
 * 错误条件（直接拒绝）：
 *   - 未闭合字符串 / 未闭合方括号 / 未闭合双引号 / 未闭合块注释
 *   - 含控制字符（除常见空白 \t \n \r）
 */
function tokenize(sql) {
    const tokens = [];
    let i = 0;
    const n = sql.length;

    while (i < n) {
        const ch = sql[i];

        // 空白
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }

        // 控制字符（除常见空白）
        if (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7F) {
            return { ok: false, reason: `SQL 含非法控制字符（code=${ch.charCodeAt(0)}）` };
        }

        // 单行注释 --
        if (ch === '-' && sql[i + 1] === '-') {
            i += 2;
            while (i < n && sql[i] !== '\n') i++;
            tokens.push({ type: 'COMMENT_LINE', start: i });
            continue;
        }

        // 块注释 /* ... */
        if (ch === '/' && sql[i + 1] === '*') {
            const start = i;
            i += 2;
            let closed = false;
            while (i < n - 1) {
                if (sql[i] === '*' && sql[i + 1] === '/') { i += 2; closed = true; break; }
                i++;
            }
            if (!closed) {
                return { ok: false, reason: '未闭合的块注释 /* */', detail: `start=${start}` };
            }
            tokens.push({ type: 'COMMENT_BLOCK', start });
            continue;
        }

        // 单引号字符串 'xxx' 或 N'xxx'（含 '' 转义）
        if (ch === "'" || (ch === 'N' && sql[i + 1] === "'") || (ch === 'n' && sql[i + 1] === "'")) {
            const start = i;
            if (ch !== "'") i++; // 跳过 N
            i++; // 跳过开头 '
            let closed = false;
            while (i < n) {
                if (sql[i] === "'") {
                    if (sql[i + 1] === "'") { i += 2; continue; } // '' 转义
                    i++; closed = true; break;
                }
                i++;
            }
            if (!closed) {
                return { ok: false, reason: "未闭合的字符串字面量 '...'", detail: `start=${start}` };
            }
            tokens.push({ type: 'STRING', start });
            continue;
        }

        // 方括号标识符 [xxx]（含 ]] 转义）
        if (ch === '[') {
            const start = i;
            i++; // 跳过 [
            let closed = false;
            const inner = [];
            while (i < n) {
                if (sql[i] === ']') {
                    if (sql[i + 1] === ']') { inner.push(']'); i += 2; continue; }
                    i++; closed = true; break;
                }
                inner.push(sql[i]);
                i++;
            }
            if (!closed) {
                return { ok: false, reason: '未闭合的方括号标识符 [...]', detail: `start=${start}` };
            }
            tokens.push({ type: 'BRACKET_ID', value: inner.join(''), start });
            continue;
        }

        // 双引号标识符 "xxx"
        if (ch === '"') {
            const start = i;
            i++;
            let closed = false;
            const inner = [];
            while (i < n) {
                if (sql[i] === '"') {
                    if (sql[i + 1] === '"') { inner.push('"'); i += 2; continue; }
                    i++; closed = true; break;
                }
                inner.push(sql[i]);
                i++;
            }
            if (!closed) {
                return { ok: false, reason: '未闭合的双引号标识符 "..."', detail: `start=${start}` };
            }
            tokens.push({ type: 'DQUOTE_ID', value: inner.join(''), start });
            continue;
        }

        // 分号
        if (ch === ';') {
            tokens.push({ type: 'SEMICOLON', start: i });
            i++; continue;
        }

        // 数字
        if (ch >= '0' && ch <= '9') {
            const start = i;
            while (i < n && /[0-9.]/.test(sql[i])) i++;
            tokens.push({ type: 'NUMBER', value: sql.slice(start, i), start });
            continue;
        }

        // 标识符 / 关键字（支持 @ @@ # 前缀，及中文标识符）
        // ⚠️ while 条件必须把非 ASCII（中文等）也算入标识符延续字符，否则中文标识符会死循环：
        //    外层 if 接受了 ch（如中文'客'），但 while 不接受 → i 不增长 → 死循环
        if (/[A-Za-z_@#]/.test(ch) || ch.charCodeAt(0) > 0x7F) {
            const start = i;
            // @@ 双 @（SQL Server 全局变量前缀）
            if (ch === '@' && sql[i + 1] === '@') { i += 2; }
            while (i < n) {
                const c = sql[i];
                if (/[A-Za-z0-9_@#$]/.test(c) || c.charCodeAt(0) > 0x7F) { i++; continue; }
                break;
            }
            // 防御性：本分支必须至少消费 1 个字符，否则一定是漏处理某种字符
            if (i === start) {
                return { ok: false, reason: `lexer 内部错误：未消费的字符 code=${ch.charCodeAt(0)}` };
            }
            const value = sql.slice(start, i);
            tokens.push({ type: 'WORD', value, valueUpper: value.toUpperCase(), start });
            continue;
        }

        // 其他单字符
        tokens.push({ type: 'PUNCT', value: ch, start: i });
        i++;
    }

    return { ok: true, tokens };
}

function layer0_lexerScan(sql) {
    // 1. 词法切分（含未闭合检测）
    const tk = tokenize(sql);
    if (!tk.ok) return tk;
    const tokens = tk.tokens;

    // 2. 提取有效 token（去注释）用于关键字检查 + 分号统计 + 首 token 白名单
    const effective = tokens.filter(t => t.type !== 'COMMENT_LINE' && t.type !== 'COMMENT_BLOCK');

    // 3. 首关键字白名单：第一个有效 token 必须是 WORD 且 valueUpper ∈ {SELECT, WITH}
    if (effective.length === 0) {
        return { ok: false, reason: 'SQL 仅含注释或空白' };
    }
    const first = effective[0];
    if (first.type !== 'WORD' || (first.valueUpper !== 'SELECT' && first.valueUpper !== 'WITH')) {
        return {
            ok: false,
            reason: `首关键字必须是 SELECT 或 WITH，实际：${first.type === 'WORD' ? first.valueUpper : first.type}`,
        };
    }

    // 4. 分号统计：除最后一个 token 是 ; 外，不允许任何其他分号
    //    （SELECT 1; OK；SELECT 1;; 拒；SELECT 1; DROP TABLE foo; 拒；; SELECT 1 拒）
    const semicolons = effective.filter(t => t.type === 'SEMICOLON');
    if (semicolons.length > 1) {
        return { ok: false, reason: '检测到多个分号（疑似多语句）' };
    }
    if (semicolons.length === 1) {
        const last = effective[effective.length - 1];
        if (last.type !== 'SEMICOLON') {
            return { ok: false, reason: '分号位置非法（仅允许作为单语句的尾部分号）' };
        }
    }

    // 5. 危险关键字 token 扫描
    //    WORD token 的 valueUpper 与 DANGEROUS_KEYWORDS 比较；
    //    xp_* 整族 → 任一以 xp_ 开头的 WORD（不区分大小写）；
    //    sp_* → 只匹配 DANGEROUS_SP_PROCS 名单。
    //    BRACKET_ID / DQUOTE_ID / STRING 的内容不参与扫描（用户主动用了标识符引用，不可能是 SQL Server 自带过程名）。
    for (const t of effective) {
        if (t.type !== 'WORD') continue;
        const upper = t.valueUpper;
        const lower = t.value.toLowerCase();

        if (DANGEROUS_KEYWORDS.has(upper)) {
            return { ok: false, reason: `检测到禁用关键字：${upper}` };
        }
        if (lower.startsWith('xp_')) {
            return { ok: false, reason: `检测到扩展存储过程：${t.value}（xp_* 系列不允许）` };
        }
        if (lower.startsWith('sp_') && DANGEROUS_SP_PROCS.has(lower)) {
            return { ok: false, reason: `检测到高危系统过程：${t.value}` };
        }
    }

    return { ok: true };
}

// ============================================================================
// 层 1：parser 解析
// ============================================================================

/**
 * 调 node-sql-parser astify 解析 SQL，返回 AST。
 *
 * 拒绝条件：
 *   - parser 抛错（多数危险语法如 OPENROWSET / EXEC / WAITFOR 在此自然失败）
 *   - 返回 array（多语句）
 *   - AST 顶层 type !== 'select'（DDL/DML 等其他 statement type）
 *
 * 注：层 0 已经在词法层拦了多数危险关键字，本层主要是：
 *   1. 把 SQL 转成 AST（供层 2 walker 用）
 *   2. 兜底拦截层 0 漏过的语法问题
 */
function layer1_parse(sql) {
    let ast;
    try {
        ast = parser.astify(sql, { database: 'transactsql' });
    } catch (e) {
        return {
            ok: false,
            reason: 'SQL 形态超出 smoke test 支持范围，请改写为标准 SELECT/WITH 查询',
            detail: `parser error: ${String(e.message || e).split('\n')[0]}`,
        };
    }

    // 多语句：parser 返回 array
    if (Array.isArray(ast)) {
        if (ast.length === 0) {
            return { ok: false, reason: 'SQL 解析为空语句' };
        }
        if (ast.length > 1) {
            return {
                ok: false,
                reason: `检测到 ${ast.length} 条语句，仅允许 1 条`,
                detail: `types: ${ast.map(x => x?.type).join(',')}`,
            };
        }
        ast = ast[0]; // 单元素 array 也展平
    }

    if (!ast || typeof ast !== 'object') {
        return { ok: false, reason: 'AST 解析结果异常（非对象）' };
    }

    // 顶层 type 白名单：CTE / UNION 在 node-sql-parser 顶层都是 'select'
    if (ast.type !== 'select') {
        return {
            ok: false,
            reason: `仅允许 SELECT/WITH 查询，AST 顶层 type = ${ast.type}`,
        };
    }

    return { ok: true, ast };
}

// ============================================================================
// 层 2：AST walker 递归检查（C3/M5）
// ============================================================================

/**
 * 把 multipart name（DB / SCHEMA / TABLE）归一化：
 *   - 去方括号 [business_db] → business_db
 *   - 去双引号 "business_db" → business_db
 *   - 大小写归一（SQL Server 默认 case-insensitive）
 */
function normalizeIdent(name) {
    if (name === null || name === undefined) return null;
    let s = String(name).trim();
    if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
    if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
    return s.toUpperCase();
}

/**
 * 检测 select 节点的 INTO 字段是不是"真 INTO 建表"（区分空占位）。
 *
 * 探针发现：每个 select AST 都有 into 字段
 *   - 空占位（普通 SELECT）：into = { position }  仅 1 个 key
 *   - 真 INTO 建表：       into = { type, expr, position }  含 expr
 */
function isRealInto(intoNode) {
    return !!(intoNode && typeof intoNode === 'object' && 'expr' in intoNode && intoNode.expr != null);
}

/**
 * 递归遍历 AST，对每个 select 节点调用 visitor(selectNode)。
 *
 * 遍历范围（codex M5）：
 *   - with[i].stmt.ast（CTE 内部 select）
 *   - from[i]（表引用，含 join、子查询 expr.ast）
 *   - _next（UNION 链下一个 select）
 *   - 其他可能含子查询的字段（where / having / columns 里的表达式）
 *
 * 注：node-sql-parser 的 AST 在子查询位置一般是 { expr: { ast: <selectNode>, ... } } 结构，
 *    我们用通用 walk 把所有"type === 'select' 的对象"都送给 visitor。
 */
function walkSelectNodes(root, visitor) {
    const seen = new WeakSet();
    function walk(node) {
        if (!node || typeof node !== 'object') return;
        if (seen.has(node)) return;
        seen.add(node);
        if (Array.isArray(node)) {
            for (const item of node) walk(item);
            return;
        }
        if (node.type === 'select') {
            visitor(node);
        }
        for (const value of Object.values(node)) {
            walk(value);
        }
    }
    walk(root);
}

/**
 * 收集 AST 中所有表引用（from / join / 子查询里的 from）。
 *
 * 探针发现 from 数组里每个元素结构：
 *   { db: 'business_db'|null, schema: 'dbo'|null, table: 'bms_xxx', as: 'alias'|null, ... }
 */
function collectTableRefs(selectNode) {
    const refs = [];
    if (selectNode.from && Array.isArray(selectNode.from)) {
        for (const t of selectNode.from) {
            if (t && (t.table != null || t.db != null || t.schema != null)) {
                refs.push({
                    db: t.db ?? null,
                    schema: t.schema ?? null,
                    table: t.table ?? null,
                    as: t.as ?? null,
                });
            }
        }
    }
    return refs;
}

function layer2_astCheck(ast) {
    let realIntoFound = null;
    let crossDbRef = null;        // 三段名 + db ≠ business_db
    let ambiguousTwoPart = null;  // 两段名歧义（db 非空 + schema 为空）

    walkSelectNodes(ast, (selectNode) => {
        // INTO 检测：递归所有 select 节点（codex M5 — INTO 也可能在 CTE 内部）
        if (isRealInto(selectNode.into)) {
            if (!realIntoFound) {
                realIntoFound = { expr: selectNode.into.expr };
            }
        }

        // 表引用检测
        // ⚠️ T-SQL 两段名（如 sys.tables / dbo.crm_bid / master.syslogins）在语法上有歧义：
        //    可能是 schema.table（省 db），也可能是 db.table（省 schema）。
        //    node-sql-parser 统一解析成 db=X, schema=null, table=Y，自身无法区分。
        //    我们的策略：**一刀切拒绝两段名**，要求用户写单段名（推荐）或完整三段名 business_db.dbo.xxx。
        //    这样既避免误杀 sys.tables 类合法形态，也防止 master.syslogins 类绕过攻击。
        const refs = collectTableRefs(selectNode);
        for (const r of refs) {
            const dbNorm = normalizeIdent(r.db);
            const schemaNorm = normalizeIdent(r.schema);
            const allowedNorm = ALLOWED_DATABASE.toUpperCase();

            if (dbNorm === null) {
                // 单段名（schema 也应为 null）— 通过
                continue;
            }
            if (schemaNorm === null) {
                // 两段名歧义 db=X / schema=null — 拒绝
                if (!ambiguousTwoPart) {
                    ambiguousTwoPart = { db: r.db, table: r.table };
                }
                continue;
            }
            // 三段名 db=X / schema=Y — 检查 db 必须是 business_db
            if (dbNorm !== allowedNorm) {
                if (!crossDbRef) {
                    crossDbRef = { db: r.db, schema: r.schema, table: r.table };
                }
            }
        }
    });

    if (realIntoFound) {
        return {
            ok: false,
            reason: '检测到 SELECT INTO 建表，smoke test 不允许 DDL 操作',
            detail: `INTO target = ${JSON.stringify(realIntoFound.expr).slice(0, 100)}`,
        };
    }

    if (ambiguousTwoPart) {
        return {
            ok: false,
            reason: `检测到两段表引用 ${ambiguousTwoPart.db}.${ambiguousTwoPart.table}，存在歧义（无法区分 schema.table 与 db.table）。请改写为单段表名（如 ${ambiguousTwoPart.table}）或完整三段名（如 ${ALLOWED_DATABASE}.dbo.${ambiguousTwoPart.table}）`,
            detail: `ambiguous two-part name: ${ambiguousTwoPart.db}.${ambiguousTwoPart.table}`,
        };
    }

    if (crossDbRef) {
        return {
            ok: false,
            reason: `跨库引用不允许，仅允许 ${ALLOWED_DATABASE} 库内的表`,
            detail: `检测到 ${crossDbRef.db}.${crossDbRef.schema}.${crossDbRef.table}`,
        };
    }

    return { ok: true };
}

// ============================================================================
// 层 3：TOP 100 AST 注入（C4）
// ============================================================================

/**
 * 在 AST 上注入 TOP 100：
 *   - 若顶层 select.top 已有（用户写了 TOP N）→ 不覆盖，沿用用户的 N
 *     （理由：用户主动限制 N 行，smoke test 跑 N 行就够；TOP 5 比 TOP 100 还少）
 *   - 若顶层 select.top 为 null → 设 top = { value: 100, percent: null }
 *   - 若是 UNION（顶层 select 含 _next 链）→ 拒绝，因为 sqlify 只能把 TOP 注入到第一个分支
 *     UNION 总行数不被限制，存在 DoS 风险（codex C4 直接拒绝原则）
 *
 * sqlify 失败 → 拒绝（codex C4：不字符串包外层 fallback）
 *
 * @param {object} ast 经过层 1/2 校验的 AST（顶层 type === 'select'）
 * @returns {{ ok: true, smokeSql: string } | { ok: false, reason: string, detail?: string }}
 */
function layer3_injectTop(ast) {
    // UNION 检测：顶层 select 含 _next 链（探针 case 6 确认）
    // sqlify 时 TOP 只作用第一个分支，无法限制 UNION 总行数 → 直接拒绝
    if (ast._next) {
        return {
            ok: false,
            reason: 'UNION 查询 smoke test 暂不支持（无法精确限制总行数），请改写为单 SELECT',
        };
    }

    // 注入 TOP（覆盖式：仅当用户没写 TOP 时才设 100）
    if (ast.top == null) {
        ast.top = { value: TOP_LIMIT, percent: null };
    }
    // 若用户已写 TOP N，沿用其 N（哪怕 N > 100；理由：用户主动控制行数，是合法意图）

    let smokeSql;
    try {
        smokeSql = parser.sqlify(ast, { database: 'transactsql' });
    } catch (e) {
        return {
            ok: false,
            reason: 'SQL 改写失败，可能含 smoke test 不支持的语法形态',
            detail: `sqlify error: ${String(e.message || e).split('\n')[0]}`,
        };
    }

    if (typeof smokeSql !== 'string' || smokeSql.trim().length === 0) {
        return { ok: false, reason: 'SQL 改写返回空字符串' };
    }

    return { ok: true, smokeSql };
}

// ============================================================================
// 导出
// ============================================================================

module.exports = {
    validateAndTransform,
    // 常量暴露（调用方/测试用）
    ALLOWED_DATABASE,
    TOP_LIMIT,
    // 内部 helper 暴露（仅测试用）
    _internal: {
        layer0_lexerScan,
        layer1_parse,
        layer2_astCheck,
        layer3_injectTop,
        DANGEROUS_KEYWORDS,
        DANGEROUS_SP_PROCS,
    },
};
