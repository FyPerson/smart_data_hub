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

/**
 * 默认业务库白名单（向后兼容 v2.0 D3 早期 sqlserver 单方言决策）
 *
 * v1.68.0（路由式多方言）：validateAndTransform 接收 dialect + allowedDb 参数，
 * 此常量仅用于"未传 allowedDb 时的 sqlserver 默认值"兜底，新调用方应显式传参。
 */
const ALLOWED_DATABASE = 'business_db';

/**
 * 跨库只读白名单（v1.77.0，生产 #10 OA-372051 驱动）
 *
 * 业务背景：legacy_system→business_db 系统迁移后，2022 年及以前的历史结算数据留在 legacy_db 库，
 *   跨库查历史是真实且反复出现的取数需求。
 *
 * 安全前提（2026-06-10 F1 探针实证，生产 readonly_user 账号）：
 *   - 对 legacy_db 库级权限仅 CONNECT + SELECT（无 INSERT/UPDATE/DELETE）
 *   - 负向：跨库 UPDATE 被拒（"The UPDATE permission was denied"）
 *   → 放开白名单不需要 DBA 改权限，账号侧本就只读安全
 *
 * 映射语义：key=主业务库（调用方传入的 allowedDb），value=该主库下额外允许 SELECT 的只读库集合。
 *   layer2 校验时把"主库 + 附加只读库"合成允许集合，集合内的三段名跨库引用放行，集合外仍拒。
 *   常量方案（②）：内网仅此一个跨库场景，避免过度设计为 admin UI 可配；
 *   未来再加历史库 → 改本常量即可（带 codex 审）。库名大写归一后比较。
 */
const CROSS_DB_ALLOWLIST = {
    'business_db': ['legacy_db'],
};

/** TOP N / LIMIT N 注入值（方案 §6.1）*/
const TOP_LIMIT = 100;

/**
 * 支持的方言枚举（路由式多方言，v1.68.0 引入）
 *   - sqlserver：T-SQL（node-sql-parser dialect 'transactsql'，含 [ ] 标识符 / TOP N / xp_*）
 *   - mysql：MySQL 8.x（node-sql-parser dialect 'mysql'，含反引号标识符 / LIMIT / LOAD_FILE）
 */
const SUPPORTED_DIALECTS = new Set(['sqlserver', 'mysql']);
const DIALECT_TO_PARSER = {
    sqlserver: 'transactsql',
    mysql: 'mysql',
};

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
 * 无条件拒绝的危险关键字 token（层 0 词法层扫描）— SQL Server / T-SQL 方言
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

/**
 * 无条件拒绝的危险关键字 token — MySQL 方言（v1.68.0）
 *
 * 约定（codex 十九审 low #2）：
 *   - 非 SELECT/WITH 语句类关键字（CREATE/DROP/INSERT/UPDATE/DELETE/GRANT/LOAD DATA/FLUSH/SHOW 等）
 *     依赖 layer 0 首 token 白名单 + layer 1 parser 拒绝，**不列入本名单**。
 *   - 本名单只维护 SELECT/WITH 内可嵌入的风险 token。
 *
 * F1 探针验证（2026-05-20）：fy 账号无 FILE 权限，LOAD_FILE 返回 NULL 不报错、
 * INTO OUTFILE 报权限拒绝。应用层仍兜底拒绝（防御纵深，避免账号意外被授权）。
 */
const DANGEROUS_MYSQL_KEYWORDS = new Set([
    // 文件 I/O 系列（FILE 权限相关）
    'OUTFILE',          // SELECT ... INTO OUTFILE '/tmp/x'
    'DUMPFILE',         // SELECT ... INTO DUMPFILE '/tmp/x'
    'LOAD_FILE',        // SELECT LOAD_FILE('/etc/passwd')（v1.68.0 自测发现漏列，F1 探针 fy 账号无权限返 NULL，应用层必须拒）
    // 时间盲注 / 资源消耗
    'SLEEP',            // SELECT SLEEP(10)（函数式时间盲注）
    'BENCHMARK',        // SELECT BENCHMARK(1000000, MD5('x'))（CPU 消耗）
    'GET_LOCK',         // 命名锁，可能造成长时间阻塞
    // 复制等待 / 主从同步（codex 十九审 medium #3，函数名兜底拒）
    'MASTER_POS_WAIT',  // 等待主库 binlog 位点
    'SOURCE_POS_WAIT',  // MySQL 8.0.22+ 重命名
    // 系统变量 / 配置探测
    'PERFORMANCE_SCHEMA',  // 系统库（已由跨库检查覆盖，词法层兜底）
    // 注：FOR UPDATE / LOCK IN SHARE MODE 不在本名单（UPDATE/SHARE 是常用列名前缀如 update_time，整 token 静态拒会大面积误杀）。
    // 取舍：依赖 20s timeout 兜底锁等待场景，应用层不静态拒。codex 十九审 medium #3 已 acknowledge 此风险。
]);

/**
 * 应用层补充：MySQL 跨库拒绝的库名（fy 账号可见但 D3 不允许）
 * F1 探针发现 fy 账号可见：information_schema / newinterface / performance_schema
 * 应用层 ALLOWED_DATABASE='newhrd'，任何其他库的引用都被层 2 拒绝。
 */

/**
 * v1.70.0 Step 2（方案 §1.4）：临时表静态拦截
 *
 * 动机：D3 smoke test 真跑业务库时只验证"SQL 能不能跑通"，不能创建临时表持久化数据。
 *   - SQL Server：#tmp 是会话级临时表（tempdb），##tmp 是全局临时表 — 都会占 tempdb 资源
 *   - MySQL：CREATE TEMPORARY TABLE 是会话级，连接断开自动 drop，但 smoke test 复用业务库连接池
 *     可能引入持久副作用
 *
 * 设计：layer 0 词法层之后、layer 1 parser 之前做正则拦截（layer 0.5）
 *   - 比 layer 1 parser 更快失败（无需建 AST）
 *   - 比 layer 0 词法状态机简单（不需要区分字符串/注释，正则误判风险极低 — # 符号只在临时表名出现）
 *   - SQL Server #/## 是非标准 token，node-sql-parser 的 transactsql 方言可能直接 parse 失败
 *     提前拦截让用户看到清晰错误"smoke test 不支持临时表"而非"SQL parse 错误"
 *
 * 取舍（不静态拦截 CREATE TEMPORARY TABLE 的子句变体）：
 *   - MySQL CREATE TEMPORARY 走 layer 0 首 token 白名单已被拒（SELECT/WITH only）
 *   - 但 MySQL 允许嵌入 ... INTO ... 不带 TEMPORARY 但仍创建表的场景几乎不存在；
 *     仅本 helper 兜底 `TEMPORARY TABLE` 关键字两边有空白的情况
 */
// codex 25 审 #1：补 SQL Server 方括号 quoted identifier 形式 [#tmp] / [##tmp]
// 每个关键字后允许两种形式：裸名 #{1,2}\w+ 或方括号包裹 \[#{1,2}[^\]]+\]
const SQLSERVER_TEMP_TABLE_PATTERNS = [
    /\bINTO\s+(?:#{1,2}\w+|\[#{1,2}[^\]]+\])/i,    // SELECT ... INTO #tmp / [#tmp] / ##tmp / [##tmp]
    /\bFROM\s+(?:#{1,2}\w+|\[#{1,2}[^\]]+\])/i,    // FROM #tmp / [#tmp]
    /\bJOIN\s+(?:#{1,2}\w+|\[#{1,2}[^\]]+\])/i,    // JOIN #tmp / [#tmp]
    /\bUPDATE\s+(?:#{1,2}\w+|\[#{1,2}[^\]]+\])/i,  // UPDATE #tmp / [#tmp]
];
const MYSQL_TEMP_TABLE_PATTERN = /\bTEMPORARY\s+TABLE\b/i;

/**
 * 检查 SQL 是否含临时表引用。
 *
 * @param {string} sql 原始 SQL（layer 0 通过后传入，仍保留注释/字符串原文）
 * @param {string} dialect 'sqlserver' / 'mysql'
 * @returns {{ ok: true } | { ok: false, reason: string, code: 'TEMP_TABLE_NOT_ALLOWED' }}
 *
 * ⚠️ 已知误判风险（codex 25 审 #2，知情接受）：
 *   - 字符串内含 `FROM #tmp` / `INTO #tmp` 等会被误拒（如 `SELECT 'FROM #tmp' AS msg FROM t`）
 *   - 行注释 / 块注释内含同样模式也会误拒
 *   - 真要修：复用 layer 0 tokenize 结果重建去字符串/注释的扫描串（≥1h，影响所有 layer 0 行为）
 *   - 当前取舍：保持正则简单 + 用户能立刻从错误消息定位到改 SQL（删引号 5 秒能过），
 *     4-5 用户内网场景误判概率极低，留待未来需要时升级
 *   - 测试用例 NEG-1/2/3 显式留痕这些误判（已知接受的限制）
 */
function checkTempTable(sql, dialect) {
    if (dialect === 'sqlserver') {
        for (const pattern of SQLSERVER_TEMP_TABLE_PATTERNS) {
            if (pattern.test(sql)) {
                return {
                    ok: false,
                    reason: 'smoke test 不支持临时表（#tmp / ##tmp），请改用 CTE 或子查询',
                    code: 'TEMP_TABLE_NOT_ALLOWED',
                };
            }
        }
    } else if (dialect === 'mysql') {
        if (MYSQL_TEMP_TABLE_PATTERN.test(sql)) {
            return {
                ok: false,
                reason: 'smoke test 不支持 TEMPORARY TABLE，请改用 CTE 或子查询',
                code: 'TEMP_TABLE_NOT_ALLOWED',
            };
        }
    }
    return { ok: true };
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 校验并改写 SQL（4 层防御一次跑完）
 *
 * v1.68.0 路由式多方言改造（2026-05-20）：
 *   - 新增 dialect 参数：'sqlserver' / 'mysql'
 *   - 新增 allowedDb 参数：业务库白名单（sqlserver 默认 business_db / mysql 调用方需显式传如 'newhrd'）
 *   - 旧调用方（仅传 SQL 单参数）默认走 sqlserver + ALLOWED_DATABASE='business_db'，向后兼容
 *
 * @param {string} originalSql 用户提交的 SQL 文本
 * @param {object} [options] 路由参数（向后兼容，可省略）
 * @param {string} [options.dialect='sqlserver'] 方言：'sqlserver' / 'mysql'
 * @param {string} [options.allowedDb] 业务库白名单；省略时按 dialect 默认（sqlserver=business_db）
 * @returns {{ ok: true, smokeSql: string } | { ok: false, layer: number, reason: string, detail?: string, code?: string }}
 *
 * 成功：ok=true，smokeSql 是注入 TOP/LIMIT 100 后的待执行 SQL
 * 失败：ok=false，layer 标记被哪一层拒绝，reason 是给用户看的简短描述
 *       code 字段用于区分同 layer 内的不同拒绝来源（如临时表拦截走 layer 0 但带 code='TEMP_TABLE_NOT_ALLOWED'）
 */
function validateAndTransform(originalSql, options) {
    if (typeof originalSql !== 'string' || originalSql.trim().length === 0) {
        return { ok: false, layer: 0, reason: 'SQL 为空' };
    }

    // 路由参数解析（默认 sqlserver + business_db，向后兼容）
    const dialect = (options && options.dialect) || 'sqlserver';
    if (!SUPPORTED_DIALECTS.has(dialect)) {
        return { ok: false, layer: 0, reason: `不支持的方言：${dialect}（仅支持 ${Array.from(SUPPORTED_DIALECTS).join('/')}）` };
    }
    const allowedDb = (options && options.allowedDb) || (dialect === 'sqlserver' ? ALLOWED_DATABASE : null);
    if (!allowedDb) {
        return { ok: false, layer: 0, reason: `${dialect} 方言必须提供 allowedDb 业务库白名单` };
    }

    // 层 0：词法状态机（按 dialect 选不同的危险关键字集 + 反引号标识符支持）
    const layer0 = layer0_lexerScan(originalSql, dialect);
    if (!layer0.ok) return { ok: false, layer: 0, ...layer0 };

    // v1.79.0：layer0 通过后剥掉合法的单个前导分号，再喂给 parser
    //   动机：node-sql-parser 不认前导分号（`;WITH...` 会 parse error），但 `;WITH` 是 T-SQL 标准写法。
    //   安全性：layer0 已保证"要么无前导分号，要么单个前导分号 + 紧跟 SELECT/WITH"
    //     （;;SELECT / ;DROP / ;SELECT;DROP 都已在 layer0 被拒），故此处只会删掉那个合法的保护性分号。
    //   codex 审 medium-1：按 layer0 透出的 token 位置删字符（非独立正则），与 layer0 校验同一判断——
    //     正则 `^\s*;` 遇前导注释 `/* x */ ;WITH` 不匹配会漏剥致 parser 仍失败；位置法消除此不一致。
    //   后续 layer0.5/1/2/3 全部基于 parseSql。
    const pos = layer0.leadingSemicolonStart;
    const parseSql = (pos != null)
        ? (originalSql.slice(0, pos) + originalSql.slice(pos + 1))
        : originalSql;

    // 层 0.5：临时表静态拦截（v1.70.0 Step 2 方案 §1.4）
    //   - 比 layer 1 parser 更快失败，错误消息更友好（"smoke test 不支持临时表"而非"SQL parse 错误"）
    //   - 复用 layer 0 的拒绝码（layer: 0），调用方按 layer 0 错误处理即可
    const tempTableCheck = checkTempTable(parseSql, dialect);
    if (!tempTableCheck.ok) return { ok: false, layer: 0, ...tempTableCheck };

    // 层 1：parser 解析（按 dialect 选 transactsql / mysql）
    const layer1 = layer1_parse(parseSql, dialect);
    if (!layer1.ok) return { ok: false, layer: 1, ...layer1 };

    // 层 2：AST walker 递归检查（按 dialect + allowedDb 检查跨库引用）
    const layer2 = layer2_astCheck(layer1.ast, dialect, allowedDb);
    if (!layer2.ok) return { ok: false, layer: 2, ...layer2 };

    // 层 3：TOP 100 / LIMIT 100 AST 注入（按 dialect 分支）
    const layer3 = layer3_injectTop(layer1.ast, dialect);
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

        // 反引号标识符 `xxx`（含 `` 转义） — MySQL 标准标识符引用（v1.68.0）
        // SQL Server 不用反引号，但词法层统一识别不区分方言（识别后不参与危险关键字扫描即可）
        if (ch === '`') {
            const start = i;
            i++;
            let closed = false;
            const inner = [];
            while (i < n) {
                if (sql[i] === '`') {
                    if (sql[i + 1] === '`') { inner.push('`'); i += 2; continue; }
                    i++; closed = true; break;
                }
                inner.push(sql[i]);
                i++;
            }
            if (!closed) {
                return { ok: false, reason: '未闭合的反引号标识符 `...`', detail: `start=${start}` };
            }
            tokens.push({ type: 'BACKTICK_ID', value: inner.join(''), start });
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

function layer0_lexerScan(sql, dialect) {
    // 默认 sqlserver（向后兼容旧调用方）
    dialect = dialect || 'sqlserver';
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
    // v1.79.0：放行单个前导分号——`;WITH` / `;SELECT` 是 T-SQL 标准防御性写法
    //   （WITH/CTE 前加 ; 防上一句漏分号导致 WITH 歧义，微软官方推荐；生产 #11 OA-372151 误伤）
    //   只剥"一个"前导分号：`;;SELECT`（剥一个后仍是 SEMICOLON→下方拒）/ `;DROP`（剥后非 SELECT/WITH→下方拒）。
    //   剥掉的前导分号不计入第 4 步分号统计，故 `;SELECT 1; DROP` 的中间分号仍触发多语句拒绝。
    //
    //   codex 审 medium-2：**仅 sqlserver 放行**——;WITH 是 T-SQL 特有惯例，MySQL CTE 无此写法，
    //     非 sqlserver 方言前导分号无正当理由，继续拒绝（最小放行面）。
    //   codex 审 medium-1/low-2：剥离时把被剥分号在原始 SQL 的字符位置（token.start）透出为
    //     leadingSemicolonStart，让 validateAndTransform 按"同一位置"删字符喂 parser——
    //     消除 token 级剥离 vs 主函数正则的两套判断不一致（前导注释场景 `/* x */ ;WITH` 也能一致放行）。
    let scan = effective;
    let leadingSemicolonStart = null;
    if (dialect === 'sqlserver' && scan[0].type === 'SEMICOLON') {
        leadingSemicolonStart = scan[0].start;
        scan = scan.slice(1);
        if (scan.length === 0) {
            return { ok: false, reason: 'SQL 仅含分号（无有效语句）' };
        }
    }
    const first = scan[0];
    if (first.type !== 'WORD' || (first.valueUpper !== 'SELECT' && first.valueUpper !== 'WITH')) {
        return {
            ok: false,
            reason: `首关键字必须是 SELECT 或 WITH，实际：${first.type === 'WORD' ? first.valueUpper : first.type}`,
        };
    }

    // 4. 分号统计：除最后一个 token 是 ; 外，不允许任何其他分号
    //    （SELECT 1; OK；SELECT 1;; 拒；SELECT 1; DROP TABLE foo; 拒）
    //    v1.79.0：前导分号已在第 3 步剥离（用 scan），此处只统计剥离后的剩余 token——
    //    保证 `;SELECT 1; DROP` 的中间分号仍被识别为多语句而拒绝。
    const semicolons = scan.filter(t => t.type === 'SEMICOLON');
    if (semicolons.length > 1) {
        return { ok: false, reason: '检测到多个分号（疑似多语句）' };
    }
    if (semicolons.length === 1) {
        const last = scan[scan.length - 1];
        if (last.type !== 'SEMICOLON') {
            return { ok: false, reason: '分号位置非法（仅允许作为单语句的尾部分号）' };
        }
    }

    // 5. 危险关键字 token 扫描（按方言选不同集合）
    //    sqlserver：DANGEROUS_KEYWORDS + xp_* 整族 + DANGEROUS_SP_PROCS 名单
    //    mysql：DANGEROUS_MYSQL_KEYWORDS（OUTFILE / DUMPFILE / SLEEP / BENCHMARK 等）
    //    BRACKET_ID / DQUOTE_ID / BACKTICK_ID / STRING 的内容不参与扫描（用户主动用了标识符引用）。
    for (const t of effective) {
        if (t.type !== 'WORD') continue;
        const upper = t.valueUpper;
        const lower = t.value.toLowerCase();

        if (dialect === 'sqlserver') {
            if (DANGEROUS_KEYWORDS.has(upper)) {
                return { ok: false, reason: `检测到禁用关键字：${upper}` };
            }
            if (lower.startsWith('xp_')) {
                return { ok: false, reason: `检测到扩展存储过程：${t.value}（xp_* 系列不允许）` };
            }
            if (lower.startsWith('sp_') && DANGEROUS_SP_PROCS.has(lower)) {
                return { ok: false, reason: `检测到高危系统过程：${t.value}` };
            }
        } else if (dialect === 'mysql') {
            if (DANGEROUS_MYSQL_KEYWORDS.has(upper)) {
                return { ok: false, reason: `检测到 MySQL 禁用关键字：${upper}（涉及文件 I/O / 时间盲注 / 资源消耗 / 系统库）` };
            }
        }
    }

    // v1.79.0 codex 审 medium-1/low-2：透出被剥前导分号的原始字符位置（null=无前导分号）
    // 让 validateAndTransform 按同一位置删字符喂 parser，避免与正则两套判断不一致
    return { ok: true, leadingSemicolonStart };
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
function layer1_parse(sql, dialect) {
    dialect = dialect || 'sqlserver';
    const parserDb = DIALECT_TO_PARSER[dialect];
    let ast;
    try {
        ast = parser.astify(sql, { database: parserDb });
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

function layer2_astCheck(ast, dialect, allowedDb) {
    dialect = dialect || 'sqlserver';
    allowedDb = allowedDb || ALLOWED_DATABASE;
    const allowedNorm = allowedDb.toUpperCase();

    // v1.77.0：允许库集合 = 主业务库 + 该主库映射的跨库只读白名单（CROSS_DB_ALLOWLIST）
    //   仅 sqlserver 走跨库白名单（legacy_system 历史库场景）；mysql 无此需求，集合恒只含主库自身
    //   集合内库名全大写归一，与 dbNorm 比较一致
    const allowedDbSet = new Set([allowedNorm]);
    if (dialect === 'sqlserver') {
        const extra = CROSS_DB_ALLOWLIST[allowedDb] || CROSS_DB_ALLOWLIST[allowedNorm] || [];
        for (const db of extra) allowedDbSet.add(String(db).toUpperCase());
    }
    const isAllowedDb = (dbNorm) => allowedDbSet.has(dbNorm);

    let realIntoFound = null;
    let crossDbRef = null;        // 跨库引用（db 不在允许集合内）
    let ambiguousTwoPart = null;  // T-SQL 两段名歧义（仅 sqlserver 用）

    walkSelectNodes(ast, (selectNode) => {
        // INTO 检测：递归所有 select 节点（codex M5 — INTO 也可能在 CTE 内部）
        if (isRealInto(selectNode.into)) {
            if (!realIntoFound) {
                realIntoFound = { expr: selectNode.into.expr };
            }
        }

        // 表引用检测（v1.68.0 按方言分支）
        // T-SQL 两段名（如 sys.tables / dbo.crm_bid / master.syslogins）在语法上有歧义：
        //    可能是 schema.table（省 db），也可能是 db.table（省 schema）。
        //    我们的策略：sqlserver **一刀切拒绝两段名**，要求单段名或完整三段名 business_db.dbo.xxx。
        // MySQL 两段名（如 newhrd.staff）语义明确 = db.table（无歧义），允许通过但 db 必须 = allowedDb。
        const refs = collectTableRefs(selectNode);
        for (const r of refs) {
            const dbNorm = normalizeIdent(r.db);
            const schemaNorm = normalizeIdent(r.schema);

            if (dbNorm === null) {
                // 单段名（schema 也应为 null）— 通过
                continue;
            }

            if (dialect === 'sqlserver') {
                if (schemaNorm === null) {
                    // v1.77.0（生产 #10 误伤修复）：dbo.table 放行——dbo 是 T-SQL 默认 schema 保留名，
                    //   SQL Server 语义两段名恒为 schema.table（跨库必须三段），且即便按 db 解释也不存在
                    //   名为 dbo 的业务库，零歧义零跨库面；dbo.xxx 是 SSMS 开发最常见标准写法，
                    //   一刀切拒绝会误伤合法主流脚本（2026-06-10 #10 OA-372051 饶高成踩中）
                    if (dbNorm === 'DBO') {
                        continue;
                    }
                    // 其余两段名歧义 db=X / schema=null — 维持拒绝（防 master.xxx / 别库名.xxx
                    //   被 parser 解析歧义绕过跨库检测）
                    if (!ambiguousTwoPart) {
                        ambiguousTwoPart = { db: r.db, table: r.table };
                    }
                    continue;
                }
                // 三段名 db=X / schema=Y — 检查 db 必须在允许集合内（主库 + 跨库只读白名单 v1.77.0）
                if (!isAllowedDb(dbNorm)) {
                    if (!crossDbRef) {
                        crossDbRef = { db: r.db, schema: r.schema, table: r.table };
                    }
                }
            } else if (dialect === 'mysql') {
                // MySQL：node-sql-parser 把 `db.table` 解析为 db=X, schema=null, table=Y
                // 两段名直接 = db.table，无歧义；db 必须在允许集合内（mysql 集合恒只含主库自身）
                if (!isAllowedDb(dbNorm)) {
                    if (!crossDbRef) {
                        crossDbRef = { db: r.db, schema: r.schema, table: r.table };
                    }
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
            reason: `检测到两段表引用 ${ambiguousTwoPart.db}.${ambiguousTwoPart.table}，存在歧义（无法区分 schema.table 与 db.table）。请改写为单段表名（如 ${ambiguousTwoPart.table}）或完整三段名（如 ${allowedDb}.dbo.${ambiguousTwoPart.table}）`,
            detail: `ambiguous two-part name: ${ambiguousTwoPart.db}.${ambiguousTwoPart.table}`,
        };
    }

    if (crossDbRef) {
        // v1.77.0：允许库不止主库时，文案列出全部允许库（主库 + 跨库只读白名单）
        const allowedList = Array.from(allowedDbSet).join(' / ');
        return {
            ok: false,
            reason: `跨库引用不允许，仅允许以下库内的表：${allowedList}`,
            detail: `检测到 ${crossDbRef.db}${crossDbRef.schema ? '.' + crossDbRef.schema : ''}.${crossDbRef.table}`,
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
function layer3_injectTop(ast, dialect) {
    dialect = dialect || 'sqlserver';

    // UNION 检测：顶层 select 含 _next 链（探针 case 6 确认）
    // sqlify 时 TOP/LIMIT 只作用第一个分支，无法限制 UNION 总行数 → 直接拒绝
    if (ast._next) {
        return {
            ok: false,
            reason: 'UNION 查询 smoke test 暂不支持（无法精确限制总行数），请改写为单 SELECT',
        };
    }

    if (dialect === 'sqlserver') {
        // SQL Server: 注入 TOP（覆盖式：仅当用户没写 TOP 时才设 100）
        if (ast.top == null) {
            ast.top = { value: TOP_LIMIT, percent: null };
        }
        // 若用户已写 TOP N，沿用其 N（哪怕 N > 100；理由：用户主动控制行数，是合法意图）
    } else if (dialect === 'mysql') {
        // MySQL: 注入 LIMIT 100（覆盖式：仅当用户没写 LIMIT 时才设）
        // node-sql-parser MySQL AST limit 结构：{ seperator: '', value: [{ type: 'number', value: 100 }] }
        // 若用户已写 LIMIT N，沿用其 N
        if (ast.limit == null || !ast.limit.value || ast.limit.value.length === 0) {
            ast.limit = {
                seperator: '',
                value: [{ type: 'number', value: TOP_LIMIT }],
            };
        }
    }

    let smokeSql;
    try {
        smokeSql = parser.sqlify(ast, { database: DIALECT_TO_PARSER[dialect] });
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

    // ⭐ v1.80.2 hotfix：修复 node-sql-parser transactsql sqlify bug —— `<type>(MAX)` 被错误输出成 `<type>max`
    //   生产 #12 饶高成报错根因：SQL Server 收到 `VARCHARmax` 报 "Type VARCHARmax is not a defined system type"
    //   AST 里 length='max'（字符串而非数字），sqlify 直接拼到 dataType 后面丢括号
    //   影响范围：VARCHAR/NVARCHAR/VARBINARY 三种 (MAX) 类型，CHAR(MAX)/NCHAR(MAX) 在 SQL Server 也不合法
    //   修复：sqlify 后字符串还原。\b 词边界天然挡掉字符串字面量内部（'someVARCHARmax' 不会被误伤）
    //   仅 sqlserver dialect 生效（MySQL 没有 MAX 类型）
    if (dialect === 'sqlserver') {
        smokeSql = smokeSql.replace(/\b(VARCHAR|NVARCHAR|VARBINARY)max\b/gi, '$1(MAX)');
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
    CROSS_DB_ALLOWLIST,
    TOP_LIMIT,
    SUPPORTED_DIALECTS,
    DIALECT_TO_PARSER,
    // 内部 helper 暴露（仅测试用）
    _internal: {
        layer0_lexerScan,
        layer1_parse,
        layer2_astCheck,
        layer3_injectTop,
        DANGEROUS_KEYWORDS,
        DANGEROUS_SP_PROCS,
        DANGEROUS_MYSQL_KEYWORDS,
        // v1.70.0 Step 2 临时表静态拦截
        checkTempTable,
        SQLSERVER_TEMP_TABLE_PATTERNS,
        MYSQL_TEMP_TABLE_PATTERN,
    },
};
