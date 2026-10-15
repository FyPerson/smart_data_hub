'use strict';

/**
 * 实现对象（#77 C2b-1，方案 v0.9 §4.3）：model_impl_objects / model_impl_links 两表的 API、输入校验、
 * 权限、整组替换的互斥与事务、config_rev 递增与变更留痕。
 *
 * 不在本文件范围（C2b-2 / C2b-3）：norm_v1 规范化、三端一致性核验、每日任务、徽章、/relations、列表关系计数。
 *
 * 结构：
 *   · 纯函数校验器（无 IO，ctx 缺失一律 fail-closed）——module.exports.validators，供验证脚本直接断言；
 *   · 模块级互斥锁 implWriteMutex + 锁内 BEGIN IMMEDIATE 事务（照 server.js dbConnectionsWriteMutex 先例）；
 *   · createImplObjects(deps)：工厂，返回 { router, removeLinksForDeletedModel }。
 *
 * 递增规则（方案 §4.1.1 A 表，原句）：
 *   「实现对象挂接 / 解挂 → 被挂模型 → 关系集合实际变化」——只比 object_id 集合；role / sort_no 变化不递增。
 *   「已挂接对象的登记源码变化 → 所有挂接该对象的模型 → reg_hash 由非空值变为另一非空值（首次登记不触发）」。
 *   文档上报（doc_hash 变化）不递增（A 表未列）。
 *
 * 哈希（C2b-2）：reg_hash / doc_hash 一律是 normalizeSqlDefinition（norm_v1，见 sql-normalize.js）规范化后的 SHA-256，hash_algo 写 'norm_v1'。
 *   C2b-1 的占位算法 raw_v0 在服务启动时幂等重算一次（recomputeNormHashes）：重算本身不是「源码变化」，不递增 config_rev、不写变更日志。
 *   源码变化的比较口径 = 规范化后的哈希：只改空白 / 换行风格 / 对象头大小写的重登记不递增。
 * 三端核验（C2b-2）：见 impl-verify.js；PUT source / PUT doc 成功后各触发一次、不阻塞响应；另有手动端点 POST /model-impl-objects/:id/verify；
 *   每日 07:30 对全部 PROC / VIEW / TRIGGER 串行核验（daily-sweep.js）。GET 列表 / 详情附带读时计算的 badges。
 */

const nodePath = require('path');
const express = require('express');
const { bumpConfigRev } = require('./config-rev');
const { normalizeSqlDefinition, findGoSeparatorLine, GO_REJECT_MESSAGE, ALGO } = require('./sql-normalize');
const { createImplVerify, createSqlServerDefinitionReader, computeBadges, civilNow } = require('./impl-verify');
const { createDailySweep } = require('./daily-sweep');

// ───────────────────────────── 常量 ─────────────────────────────
const OBJ_TYPES = Object.freeze(['PROC', 'VIEW', 'TRIGGER', 'FDL_TASK', 'TABLE']);
const SOURCE_TYPES = Object.freeze(['PROC', 'VIEW', 'TRIGGER']);       // 可登记源码 / 上报文档的类型
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_SUMMARY_CHARS = 500;
const MAX_ROLE_CHARS = 100;
const MAX_FDL_NAME_CHARS = 200;
const MAX_DOC_PATH_CHARS = 500;
const MAX_TEXT_BYTES = 1024 * 1024;           // reg_source / 文档原文各 ≤ 1MB（UTF-8 字节）
const MAX_LINKS_PER_REPLACE = 500;            // 方案未规定；整组替换一次校验对象存在用 IN 查询，设上限避免超 SQLite 变量个数上限并约束锁内耗时
const HASH_ALGO = ALGO;                       // 'norm_v1'
const DAILY_VERIFY_HOUR = 7;
const DAILY_VERIFY_MINUTE = 30;
const MANUAL_VERIFY_WAIT_MS = 20000;   // 手动核验端点最多等多久（R4）：超时返回 202，核验继续在队列里执行
// 名称 / 职责：一律拒绝 C0（含换行、TAB）、DEL、C1（U+0080–U+009F）、行 / 段分隔符 U+2028 / U+2029、双向控制符 U+202A–U+202E 与 U+2066–U+2069
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/;
const CONTROL_EXCEPT_NEWLINE_RE = /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/;   // summary：只放行 LF / CR，其余同 CONTROL_RE
const CONTROL_EXCEPT_WS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;        // 源码 / 文档原文：只放行 TAB / LF / CR

const codePoints = (s) => Array.from(s).length;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isBlank = (v) => v === undefined || v === null || v === '';
// 旧算法行判定（收口批 2 LOW-3）：与启动重算的选取条件逐字同口径——hash_algo IS NOT norm_v1，且 reg_source / reg_hash / doc_hash / hash_algo 至少一项 IS NOT NULL
//   （这里用 != null，空串也算「非空」，与 SQL 的 IS NOT NULL 一致；不用 isBlank）。没有任何哈希材料的 NULL 算法行不算旧算法行
const hasHashMaterial = (o) => o.reg_source != null || o.reg_hash != null || o.doc_hash != null || o.hash_algo != null;
const isStaleAlgoRow = (o) => o.hash_algo !== HASH_ALGO && hasHashMaterial(o);
const isWellFormedString = (s) => (typeof s.isWellFormed === 'function' ? s.isWellFormed() : true);

function fail(code, field, message, extra) { return Object.assign({ ok: false, code, field, message }, extra || {}); }
function okv(value) { return { ok: true, value }; }

// ───────────────────────────── 纯函数校验器 ─────────────────────────────

/** 通用字符串检查：类型、成对代理项、控制字符；返回错误或 null */
function checkText(v, field, controlRe) {
    if (typeof v !== 'string') return fail('FIELD_TYPE_INVALID', field, `${field} 必须是字符串`);
    if (!isWellFormedString(v)) return fail('INVALID_UNICODE', field, `${field} 含不成对的代理项字符`);
    if (controlRe.test(v)) return fail('CONTROL_CHAR', field, `${field} 含不允许的控制字符`);
    return null;
}

/** summary：可空；trim 后 ≤500 字；换行只允许出现在这里（LF / CR），其余控制字符一律拒绝；空串规范为 null */
function validateSummary(v) {
    if (v === undefined || v === null) return okv(null);
    const bad = checkText(v, 'summary', CONTROL_EXCEPT_NEWLINE_RE);
    if (bad) return bad;
    const t = v.trim();
    if (codePoints(t) > MAX_SUMMARY_CHARS) return fail('FIELD_TOO_LONG', 'summary', `summary 不得超过 ${MAX_SUMMARY_CHARS} 字`);
    return okv(t === '' ? null : t);
}

/** role：必填，trim 后 1–100 字，拒绝一切控制字符（含换行） */
function validateRole(v) {
    if (v === undefined || v === null) return fail('ROLE_INVALID', 'role', 'role 必填');
    const bad = checkText(v, 'role', CONTROL_RE);
    if (bad) return bad;
    const t = v.trim();
    const n = codePoints(t);
    if (n < 1 || n > MAX_ROLE_CHARS) return fail('ROLE_INVALID', 'role', `role 须为 1–${MAX_ROLE_CHARS} 字（trim 后）`);
    return okv(t);
}

/** sort_no：0–999 的整数；缺省 → 0（表列默认值） */
function validateSortNo(v) {
    if (v === undefined) return okv(0);
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 999) return fail('SORT_NO_INVALID', 'sort_no', 'sort_no 须为 0–999 的整数');
    return okv(v);
}

/**
 * 对象身份与说明字段的语法 / 组合校验（不需要上下文；连接行校验见 validateObjectConnection）。
 * 输入只取 obj_type / db_connection_id / schema_name / obj_name / summary；
 * reg_source / 文档原文走专门端点，本函数遇到非空的 reg_source / doc_source 直接拒绝（一个请求只带一个大字段）。
 */
function validateObjectFields(input) {
    if (!isPlainObject(input)) return fail('INVALID_BODY', null, '请求体必须是 JSON 对象');
    const t = input.obj_type;
    if (typeof t !== 'string' || !OBJ_TYPES.includes(t)) return fail('OBJ_TYPE_INVALID', 'obj_type', `obj_type 须为 ${OBJ_TYPES.join(' / ')} 之一`);
    for (const k of ['reg_source', 'doc_source', 'doc_path']) {
        if (hasOwn(input, k) && !isBlank(input[k])) return fail('FIELD_COMBINATION_INVALID', k, `${k} 不能随对象新建提交：源码用 PUT /api/model-impl-objects/:id/source，文档用 PUT …/:id/doc`);
    }
    const summary = validateSummary(input.summary);
    if (!summary.ok) return summary;

    // 名称字段
    let schemaName = null;
    if (!isBlank(input.schema_name)) {
        const bad = checkText(input.schema_name, 'schema_name', CONTROL_RE);
        if (bad) return bad;
        schemaName = input.schema_name;
    } else if (input.schema_name === '') schemaName = null;
    const nameBad = checkText(input.obj_name, 'obj_name', CONTROL_RE);
    if (nameBad) return nameBad.code === 'FIELD_TYPE_INVALID' ? fail('IDENTIFIER_INVALID', 'obj_name', 'obj_name 必填且为字符串') : nameBad;
    const objName = input.obj_name;

    if (t === 'FDL_TASK') {
        if (!isBlank(input.db_connection_id)) return fail('FIELD_COMBINATION_INVALID', 'db_connection_id', 'FDL_TASK 的 db_connection_id 必须为空');
        if (schemaName !== null) return fail('FIELD_COMBINATION_INVALID', 'schema_name', 'FDL_TASK 的 schema_name 必须为空');
        if (objName !== objName.trim()) return fail('IDENTIFIER_INVALID', 'obj_name', 'FDL_TASK 的 obj_name 首尾不得有空白');
        const n = codePoints(objName);
        if (n < 1 || n > MAX_FDL_NAME_CHARS) return fail('IDENTIFIER_INVALID', 'obj_name', `FDL_TASK 的 obj_name 须为 1–${MAX_FDL_NAME_CHARS} 字`);
        return okv({ obj_type: t, db_connection_id: null, schema_name: null, obj_name: objName, summary: summary.value });
    }

    // PROC / VIEW / TRIGGER / TABLE
    const cid = input.db_connection_id;
    if (typeof cid !== 'number' || !Number.isInteger(cid) || cid <= 0) return fail('FIELD_COMBINATION_INVALID', 'db_connection_id', `${t} 的 db_connection_id 必填，须为正整数`);
    if (!IDENT_RE.test(objName)) return fail('IDENTIFIER_INVALID', 'obj_name', 'obj_name 须匹配 ^[A-Za-z_][A-Za-z0-9_]{0,127}$');
    if (schemaName === null) {
        // 库级 DDL 触发器（ON DATABASE）没有 schema：TRIGGER 且 schema_name 为空即视为库级触发器，允许（方案 §6.1 C2b ②）
        if (t !== 'TRIGGER') return fail('FIELD_COMBINATION_INVALID', 'schema_name', `${t} 的 schema_name 必填`);
    } else if (!IDENT_RE.test(schemaName)) {
        return fail('IDENTIFIER_INVALID', 'schema_name', 'schema_name 须匹配 ^[A-Za-z_][A-Za-z0-9_]{0,127}$');
    }
    return okv({ obj_type: t, db_connection_id: cid, schema_name: schemaName, obj_name: objName, summary: summary.value });
}

/**
 * 连接行校验——fail-closed：非 FDL_TASK 必须给出 ctx.connection（行对象，或 null 表示「按 id 查无此行」）。
 * ctx / ctx.connection 缺失（undefined）一律判失败，不是「给了才校验」。
 * 合格条件：行存在、id 与请求一致、type === 'sqlserver'（外部源占位行 type = 'external'、mysql 等一律不合格）。
 */
function validateObjectConnection(fields, ctx) {
    if (!fields || typeof fields !== 'object') return fail('CTX_MISSING', null, '缺少对象字段，无法校验连接');
    if (fields.obj_type === 'FDL_TASK') return okv(null);
    if (!ctx || typeof ctx !== 'object' || ctx.connection === undefined) return fail('CTX_MISSING', 'db_connection_id', '缺少连接行上下文，拒绝（fail-closed）');
    const c = ctx.connection;
    if (c === null) return fail('DB_CONNECTION_NOT_FOUND', 'db_connection_id', 'db_connection_id 指向的连接不存在');
    if (!isPlainObject(c) || c.id !== fields.db_connection_id) return fail('DB_CONNECTION_NOT_FOUND', 'db_connection_id', '连接行与请求的 db_connection_id 不一致');
    if (c.type !== 'sqlserver') return fail('DB_CONNECTION_TYPE_NOT_ALLOWED', 'db_connection_id', '只能选择 type = sqlserver 的连接（外部源占位行与其他类型一律拒绝）');
    return okv(null);
}

/** 组合：语法 / 组合校验 + 连接行校验 */
function validateObjectInput(input, ctx) {
    const f = validateObjectFields(input);
    if (!f.ok) return f;
    const c = validateObjectConnection(f.value, ctx);
    if (!c.ok) return c;
    return f;
}

/** 大文本（reg_source / 文档原文）：非空字符串、成对代理项、除 TAB / LF / CR 外无控制字符、≤1MB（按 UTF-8 字节计）。返回 { ok, value: { text, bytes } } */
function validateLargeText(v, field) {
    if (typeof v !== 'string') return fail('FIELD_TYPE_INVALID', field, `${field} 必须是字符串`);
    if (!isWellFormedString(v)) return fail('INVALID_UNICODE', field, `${field} 含不成对的代理项字符`);
    if (CONTROL_EXCEPT_WS_RE.test(v)) return fail('CONTROL_CHAR', field, `${field} 含 TAB / LF / CR 以外的控制字符`);
    if (v.trim() === '') return fail('FIELD_EMPTY', field, `${field} 不能为空`);
    const bytes = Buffer.byteLength(v, 'utf8');
    if (bytes > MAX_TEXT_BYTES) return fail('FIELD_TOO_LARGE', field, `${field} 超过 1MB（按 UTF-8 字节计：${bytes}）`);
    // 方案 §4.4「文档端约定」：登记源码与文档原文都只提交对象所在批次；独占一行的 GO（不区分大小写）即拒绝（按行判断，不做词法分析，有意保守）
    const goLine = findGoSeparatorLine(v);
    if (goLine > 0) return fail('GO_SEPARATOR_FOUND', field, GO_REJECT_MESSAGE, { line: goLine });
    return okv({ text: v, bytes });
}

/**
 * doc_path：规范化后的仓库相对路径（≤500 字）。拒绝：非字符串 / 空 / 控制字符（含 NUL）/ 绝对路径 / 盘符 / URL（含 scheme）/
 * UNC / 规范化后越出根目录的 `..` / 规范化后为空或 '.'。反斜杠先统一成 '/'。返回规范化后的路径。
 */
function normalizeDocPath(v) {
    if (typeof v !== 'string') return fail('DOC_PATH_INVALID', 'doc_path', 'doc_path 必须是字符串');
    if (!isWellFormedString(v) || CONTROL_RE.test(v)) return fail('DOC_PATH_INVALID', 'doc_path', 'doc_path 含控制字符 / NUL / 非法字符');
    if (v.trim() === '') return fail('DOC_PATH_INVALID', 'doc_path', 'doc_path 不能为空');
    if (v !== v.trim()) return fail('DOC_PATH_INVALID', 'doc_path', 'doc_path 首尾不得有空白');
    if (codePoints(v) > MAX_DOC_PATH_CHARS) return fail('DOC_PATH_INVALID', 'doc_path', `doc_path 不得超过 ${MAX_DOC_PATH_CHARS} 字`);
    const s = v.replace(/\\/g, '/');
    if (/^[A-Za-z]:/.test(s)) return fail('DOC_PATH_INVALID', 'doc_path', 'doc_path 不能含盘符');
    if (/^[A-Za-z][A-Za-z0-9+.\-]*:/.test(s)) return fail('DOC_PATH_INVALID', 'doc_path', 'doc_path 不能是 URL');
    if (s.startsWith('/')) return fail('DOC_PATH_INVALID', 'doc_path', 'doc_path 必须是相对路径（不能以 / 或 \\ 开头，含 UNC）');
    const n = nodePath.posix.normalize(s);
    if (n === '.' || n === '' || n === '..' || n.startsWith('../') || n.startsWith('/')) return fail('DOC_PATH_INVALID', 'doc_path', 'doc_path 规范化后为空或越出根目录');
    if (n.endsWith('/')) return fail('DOC_PATH_INVALID', 'doc_path', 'doc_path 必须指向文件，不能以 / 结尾');
    return okv(n);
}

/**
 * 挂接整组替换的请求体：{ links: [{ object_id, role, sort_no }] }。
 * links 必须是数组（可空数组 = 解挂全部）、≤500 条；object_id 为正整数且同一请求内不重复；role / sort_no 按各自规则。
 */
function validateLinksInput(body) {
    if (!isPlainObject(body)) return fail('INVALID_BODY', null, '请求体必须是 JSON 对象');
    if (!Array.isArray(body.links)) return fail('INVALID_BODY', 'links', 'links 必须是数组');
    if (body.links.length > MAX_LINKS_PER_REPLACE) return fail('INVALID_BODY', 'links', `links 一次最多 ${MAX_LINKS_PER_REPLACE} 条`);
    const seen = new Set();
    const out = [];
    for (let i = 0; i < body.links.length; i++) {
        const it = body.links[i];
        if (!isPlainObject(it)) return fail('INVALID_BODY', `links[${i}]`, `links[${i}] 必须是对象`);
        const oid = it.object_id;
        if (typeof oid !== 'number' || !Number.isInteger(oid) || oid <= 0) return fail('OBJECT_ID_INVALID', `links[${i}].object_id`, `links[${i}].object_id 须为正整数`);
        if (seen.has(oid)) return fail('DUPLICATE_OBJECT_ID', `links[${i}].object_id`, `同一请求内 object_id 重复：${oid}`);
        seen.add(oid);
        const role = validateRole(it.role);
        if (!role.ok) return Object.assign({}, role, { field: `links[${i}].role` });
        const sortNo = validateSortNo(it.sort_no);
        if (!sortNo.ok) return Object.assign({}, sortNo, { field: `links[${i}].sort_no` });
        out.push({ object_id: oid, role: role.value, sort_no: sortNo.value });
    }
    return okv(out);
}

/** 规范化后求哈希（norm_v1）：源码 / 文档原文的唯一哈希入口 */
const normHash = (text) => normalizeSqlDefinition(text).hash;

// ───────────────────────────── 模块级互斥锁 ─────────────────────────────
// 〔照 server.js dbConnectionsWriteMutex 先例，同款 IIFE 闭包 acquire / release；5 秒等锁超时 → 调用方返回 503〕
//
// ⚠️ 平台风险说明（与 dbConnectionsWriteMutex 注释同源，原因相同，此处照实重述）：
//   server.js 全文件只有一个共享 sqlite 连接（非连接池）。本模块在这条连接上开显式事务（BEGIN IMMEDIATE … COMMIT / ROLLBACK）
//   时，**其他模块在事务期间同时发出的语句会被这条连接插进未提交事务、成为其一部分**——本事务一旦 ROLLBACK，
//   会连带撤销他们本应独立生效的语句。本锁只能保证「本模块自己的多语句写入不交错」（两个整组替换不会撞出
//   「cannot start a transaction within a transaction」，也不会交错成混合集合），挡不住其他模块的语句被卷入。
//   P52 = C（用户裁定「事务里只剩写入，不再有业务性回滚」），范围＝`txn = true` 的四处（source / delete / links / purge-account）：它们所有可因业务原因失败的检查（对象 / 模型存在性、类型、权限、目标状态复核）都在取得本锁之后、BEGIN IMMEDIATE 之前执行
//   （withWriteLock 的锁内预检阶段，读的是锁内最新行）；预检失败直接释放锁，不发 BEGIN、不发 ROLLBACK，所以业务失败不会撤销同一时刻别的模块写进共享连接的语句（含脚本端点的 config_rev 递增）。
//   `txn = false` 的 create / summary / doc 不开事务，业务错误（409 / 400 / 404）仍在 `fn` 里抛出——没有 BEGIN，也就没有 ROLLBACK，同样不会撤销他人写入。
//   例外（P57①）：links 与 purge-account 的事务体里还有「带目标状态条件的写语句」——预检之后模型状态又变、条件不满足时，在事务体内停止后续写语句并**照常 COMMIT**，
//   由路由映射成 409 MODEL_STATE_CHANGED（links）或返回 { skipped: 'TARGET_CHANGED' }（purge-account）。这是事务体内出现的业务结果，但不是回滚（不发 ROLLBACK），不违背「业务失败不撤销他人写入」。
//   ⚠️ 登记残余：事务体里仍可能失败的只剩数据库错误（磁盘 / 约束 / 触发器注入的失败）与内部不变量错误（IMPL_INVARIANT：预检读过最新行、本模块之外不写 model_impl_objects，
//   事务体里 UPDATE 的 changes 为 0 不可能发生，发生即表示有锁外写入）；这类失败仍整体 ROLLBACK，此时被卷入同一未提交事务的他人写入仍会随之回滚。
//   缓解：① 锁内事务体只含数据库语句、不含任何文件 / 网络 / 其他慢操作，耗时毫秒级，卷入窗口极小；
//        ② 本模块全部对 model_impl_* 的写与 bumpConfigRev 调用都在锁内（含单语句写：它们若在他人事务里执行同样会被一起回滚）；
//        ③ 事务绑定在工厂捕获的连接（deps.db）上，BEGIN / COMMIT / ROLLBACK 与事务体语句全部走同一个连接对象。
//   这是平台层既有风险（方案 §4.1.1「原子性靠单条语句，不开显式事务」一段的例外：对象软删除连带删关系与整组替换天然是多语句），
//   不是本模块新引入；根治方案是平台改独立连接 / 连接池，不在本批范围。
//
// ⚠️ 风险的另一个方向（C2b-1 修复 1 补）：他模块在本事务期间执行 BEGIN 会失败（「cannot start a transaction within a transaction」），
//   若其 catch 里无条件 ROLLBACK，滚掉的是**本模块的事务**。server.js 的 POST /api/create/batch 与 POST /api/models/batch 已改为
//   「BEGIN 成功才 ROLLBACK」（transactionActive，同 12477 / 14248 先例）；其余仍无条件 ROLLBACK 的他模块写法不在本批范围。
//   本模块的应对：① BEGIN 失败 ⇒ 不 ROLLBACK，返回 503 IMPL_TX_BUSY（可重试）；② COMMIT / ROLLBACK 报「no transaction is active」
//   ⇒ 记 ERROR，返回 503 IMPL_TX_LOST（结果未知：可能部分落库，先 GET 核对再决定是否重放）。丢失之前的写入已被撤销，丢失之后的写入可能已按自动提交落库——
//   所以不要假定「全无」或「全有」，以 GET 到的当前集合为准。平台级根治（独立连接或统一事务锁）不在本批范围。
const implWriteMutex = (() => {
    let locked = false;
    const waiters = [];

    function acquire(timeoutMs = 5000) {
        return new Promise((resolve, reject) => {
            const node = { resolve, timer: null, acquired: false };
            if (!locked) {
                locked = true;
                node.acquired = true;
                return resolve(makeRelease(node));
            }
            waiters.push(node);
            node.timer = setTimeout(() => {
                if (node.acquired) return;
                const idx = waiters.indexOf(node);
                if (idx >= 0) waiters.splice(idx, 1);
                const e = new Error('IMPL_OBJECTS_MUTEX_WAIT_TIMEOUT');
                e.code = 'IMPL_OBJECTS_MUTEX_WAIT_TIMEOUT';
                reject(e);
            }, timeoutMs);
        });
    }

    function makeRelease(node) {
        let released = false;
        return function release() {
            if (released) return;
            released = true;
            while (waiters.length > 0) {
                const next = waiters.shift();
                if (next.acquired) continue;
                if (next.timer) clearTimeout(next.timer);
                next.acquired = true;
                return next.resolve(makeRelease(next));
            }
            locked = false;
        };
    }

    return { acquire };
})();

/** 锁内预检的「无事可做」返回值：withWriteLock 看到它就不开事务、直接返回 value（见 withWriteLock 注释） */
const SKIP_TXN = Symbol('impl-objects.skipTxn');
const skipTxn = (value) => ({ [SKIP_TXN]: true, value });

/** 业务错误：`txn = true` 的四处路由（source / delete / links / purge-account）在锁内预检阶段（BEGIN 之前）抛出——不发 BEGIN、不发 ROLLBACK；这四处事务体内只有数据库错误与内部不变量错误（IMPL_INVARIANT）才会触发 ROLLBACK。
 *  `txn = false` 的 create / summary / doc 在 `fn` 里抛业务错误（无 BEGIN，故无 ROLLBACK）。由路由层映射成 HTTP 响应 */
class ApiError extends Error {
    constructor(status, code, message, extra) {
        super(message);
        this.status = status;
        this.code = code;
        this.extra = extra || null;
    }
}
const apiErrorFromValidation = (v) => new ApiError(v.code === 'FIELD_TOO_LARGE' ? 413 : 400, v.code, v.message,
    v.field ? Object.assign({ field: v.field }, v.line ? { line: v.line } : {}) : null);

// ───────────────────────────── 工厂 ─────────────────────────────
function createImplObjects(deps) {
    const { db: conn, logger, authenticateToken, requireAdmin, requireNonViewer, canEditModel } = deps;
    // 可选的观察钩子（只能经工厂参数注入；server.js 正式挂载不传，不读任何环境变量）：验证脚本在进程内构造本模块时，
    //   用它们精确安排「预检通过 → 排队等锁 → 他人持锁 → 放行 → 锁内复核」与「本模块事务已开」的先后（确定性同步点，不靠毫秒延迟）。钩子可返回 Promise，本模块会等它。
    //   onLockQueued(label)：已准备好占锁、尚未取得锁（锁外预检已完成）；onLockAcquired(label)：刚取得锁、尚未做锁内预检、尚未 BEGIN；
    //   onPrechecked(label)：锁内预检已通过（只有带预检的调用才触发）、尚未 BEGIN；onTxBegun(label)：BEGIN IMMEDIATE 已成功。事件顺序：queued → acquired → prechecked → txBegun。
    const { onLockQueued, onLockAcquired, onPrechecked, onTxBegun } = deps;
    for (const [k, v] of Object.entries({ db: conn, logger, authenticateToken, requireAdmin, requireNonViewer, canEditModel })) {
        if (!v) throw new Error(`impl-objects：缺少依赖 ${k}`);
    }
    // 钩子在初始化时校验类型（C2b-2·codex 25-R LOW）：必须是函数或 undefined；其他值（含 null、字符串）一律抛错，
    //   避免把拼错的钩子悄悄当成「没传」或等到第一次占锁才以 TypeError 暴露。
    for (const [k, v] of Object.entries({ onLockQueued, onLockAcquired, onPrechecked, onTxBegun })) {
        if (v !== undefined && typeof v !== 'function') throw new Error(`impl-objects：钩子 ${k} 必须是函数或 undefined`);
    }
    const router = express.Router();

    // 一律走工厂捕获的连接 conn；事务边界与事务体语句同连接
    const run = (sql, params = []) => new Promise((resolve, reject) => {
        conn.run(sql, params, function (err) { if (err) reject(err); else resolve({ changes: this.changes, lastID: this.lastID }); });
    });
    const get = (sql, params = []) => new Promise((resolve, reject) => { conn.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))); });
    const all = (sql, params = []) => new Promise((resolve, reject) => { conn.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))); });

    /**
     * 占锁执行 fn。txn = true 时锁内 BEGIN IMMEDIATE … COMMIT，出错 ROLLBACK（ROLLBACK 自身失败只记日志、不重新抛出）。
     * 等锁超时 → 抛 ApiError(503)。无论成功 / 异常 / 提前抛出，finally 一律释放锁。
     *
     * 锁内预检（P52 = C，用户裁定「事务里只剩写入，不再有业务性回滚」；范围＝txn = true 的四处 source / delete / links / purge-account，txn = false 的 create / summary / doc 在 fn 里抛业务错误、无 BEGIN 故无 ROLLBACK）：
     *   precheck 是可选的第四个参数，在取得 implWriteMutex 之后、BEGIN IMMEDIATE 之前执行，
     *   读的是锁内最新行；它的返回值作为 fn 的参数传入事务体。这四处所有「可因业务原因失败」的检查（对象 / 模型存在性、类型、权限、目标状态复核）都放在预检里：
     *   预检抛错 ⇒ 直接 finally 释放锁，**不发 BEGIN、不发 ROLLBACK**，别人（共享连接上同时发出的）写入因此不会被本请求的业务失败撤销。
     *   预检也可以返回 skipTxn(value) 表示「无事可做」：不开事务，withWriteLock 直接返回 value（不再开一个空事务）。
     */
    async function withWriteLock(label, txn, fn, precheck) {
        let release;
        if (onLockQueued) await onLockQueued(label);
        try {
            release = await implWriteMutex.acquire(5000);
        } catch (e) {
            logger.warn(`[impl-objects:${label}] 等待 implWriteMutex 超时: ${e.message}`);
            throw new ApiError(503, 'IMPL_OBJECTS_MUTEX_BUSY', '系统繁忙，请稍后重试');
        }
        let active = false;
        try {
            if (onLockAcquired) await onLockAcquired(label);
            let pre;
            if (precheck) {
                pre = await precheck();
                if (onPrechecked) await onPrechecked(label);
                if (pre && pre[SKIP_TXN] === true) return pre.value;
            }
            if (txn) {
                // BEGIN 失败（撞上他模块已开的事务 / SQLITE_BUSY）：本请求没有开成事务，绝不能 ROLLBACK（会滚掉别人的事务）；
                //   报可重试的 503 IMPL_TX_BUSY（整组替换幂等，重放安全）。其他错误照常抛出。
                try { await run('BEGIN IMMEDIATE'); } catch (beginErr) {
                    if (/within a transaction|SQLITE_BUSY|database is locked/i.test((beginErr && (beginErr.code + ' ' + beginErr.message)) || '')) {
                        logger.warn(`[impl-objects:${label}] BEGIN IMMEDIATE 失败（他模块事务或库被占用）: ${beginErr.message}`);
                        throw new ApiError(503, 'IMPL_TX_BUSY', '系统繁忙（数据库事务被占用），请稍后重试');
                    }
                    throw beginErr;
                }
                active = true;
                if (onTxBegun) await onTxBegun(label);
            }
            const out = await fn(pre);
            if (active) {
                try { await run('COMMIT'); } catch (commitErr) {
                    if (/no transaction is active/i.test(commitErr && commitErr.message)) {
                        // 本事务期间他模块执行了无条件 ROLLBACK（其 BEGIN 撞上本事务失败后的 catch），本事务已被滚掉；
                        //   事务体里在丢失之前的写入已撤销，之后的写入可能已按自动提交落库——结果未知，调用方须先 GET 核对当前集合再决定是否重放。
                        active = false;
                        logger.error(`[impl-objects:${label}] COMMIT 报 no transaction is active：事务被他模块的 ROLLBACK 滚掉（IMPL_TX_LOST）`);
                        throw new ApiError(503, 'IMPL_TX_LOST', '结果未知：本次写入可能部分落库，请先 GET 核对当前集合再决定是否重放');
                    }
                    throw commitErr;
                }
                active = false;
            }
            return out;
        } catch (err) {
            if (active) {
                try { await run('ROLLBACK'); } catch (rbErr) {
                    logger.warn(`[impl-objects:${label}] ROLLBACK 失败: ${rbErr.message}`);
                    if (/no transaction is active/i.test(rbErr && rbErr.message)) {
                        logger.error(`[impl-objects:${label}] ROLLBACK 报 no transaction is active：事务已被他模块的 ROLLBACK 滚掉（IMPL_TX_LOST）`);
                        if (!(err instanceof ApiError)) err = new ApiError(503, 'IMPL_TX_LOST', '结果未知：本次写入可能部分落库，请先 GET 核对当前集合再决定是否重放');
                    }
                }
                active = false;
            }
            throw err;
        } finally {
            release();
        }
    }

    function sendError(res, label, err) {
        if (err instanceof ApiError) {
            return res.status(err.status).json(Object.assign({ error: err.message, code: err.code }, err.extra || {}));
        }
        logger.error(`[impl-objects:${label}] ${err && err.message}`);
        return res.status(500).json({ error: '服务器内部错误', code: 'IMPL_OBJECTS_INTERNAL' });
    }

    const userLabel = (u) => (u && (u.display_name || u.username)) || '';
    const parseId = (raw) => (/^\d+$/.test(String(raw || '')) && Number(raw) > 0 && Number.isSafeInteger(Number(raw)) ? Number(raw) : null);

    // ───────────── 三端核验（C2b-2）：显式开关 deps.verifyEnabled === true（仿 sys-iteration 的 expirySweepEnabled：只有严格等于 true 才启用，缺省关闭）。
    //   生产开启：server.js 挂载处传 verifyEnabled: true（已传）。本地副本关闭：把 server.js 挂载处的 verifyEnabled 改成 false 或删掉这一行
    //   ——关闭后不触发即时核验、不排定每日任务、手动端点 503 VERIFY_DISABLED；验证脚本在进程内构造本模块时不传它，天然关闭，不引入额外占锁事件。
    //   启用时还需要读取器：注入了 readDefinition，或同时注入 getMssqlPool + decryptPassword（server.js 的正式挂载）。
    //   badgeNow（可选，测试注入）：返回 'YYYY-MM-DD HH:MM:SS' 公民时间；缺省取本机时钟。
    if (deps.readDefinition !== undefined && typeof deps.readDefinition !== 'function') throw new Error('impl-objects：readDefinition 必须是函数或 undefined');
    if (deps.badgeNow !== undefined && typeof deps.badgeNow !== 'function') throw new Error('impl-objects：badgeNow 必须是函数或 undefined');
    let readDefinition = deps.readDefinition;
    if (!readDefinition && typeof deps.getMssqlPool === 'function' && typeof deps.decryptPassword === 'function') {
        readDefinition = createSqlServerDefinitionReader({
            getConnectionRow: (cid) => get('SELECT id, type, host, port, database, username, password FROM db_connections WHERE id = ?', [cid]),
            getMssqlPool: deps.getMssqlPool, decryptPassword: deps.decryptPassword,
        });
    }
    if (deps.verifyStopWaitMs !== undefined && (typeof deps.verifyStopWaitMs !== 'number' || !(deps.verifyStopWaitMs >= 0))) throw new Error('impl-objects：verifyStopWaitMs 必须是非负数或 undefined');
    if (deps.manualVerifyTimers !== undefined && (!deps.manualVerifyTimers || typeof deps.manualVerifyTimers.setTimer !== 'function' || typeof deps.manualVerifyTimers.clearTimer !== 'function')) throw new Error('impl-objects：manualVerifyTimers 必须是 { setTimer, clearTimer } 或 undefined');
    const verifier = (deps.verifyEnabled === true && readDefinition) ? createImplVerify({ db: conn, logger, withWriteLock, readDefinition, ...(deps.verifyStopWaitMs !== undefined ? { stopWaitMs: deps.verifyStopWaitMs } : {}) }) : null;
    const badgeNow = () => (deps.badgeNow ? deps.badgeNow() : civilNow());
    /** 不阻塞响应的即时核验：走核验串行队列（同一对象等待中的请求合并）；失败只记日志（读取失败本身已由 verifyObject 落进 last_error） */
    function triggerVerify(objectId) {
        if (!verifier) return null;
        return verifier.verifyObject(objectId)
            .catch((e) => { logger.error(`[impl-objects:verify] 对象 ${objectId} 核验落库失败: ${e && e.message}`); });
    }

    // norm_v1 启动重算（C2b-2）：把 hash_algo != 'norm_v1' 的行按 norm_v1 重算 reg_hash。幂等；在模块锁内、单语句逐行 UPDATE；
    //   重算本身不是「源码变化」：不递增 config_rev、不写变更日志、不动 updated_at。
    //   文档原文不落库（只存 doc_hash），旧算法的 doc_hash 无从重算 ⇒ 置空，需要数仓重新上报（徽章回到「未登记」，不会显示成假的「不一致」）。
    //   正在重算时 PUT source / doc 先等重算结束（normGate）；即使 PUT 抢在重算之前落在 raw_v0 行上，PUT 也在同一把锁、同一条 UPDATE 里顺带处理另一半哈希
    //   （PUT doc 现算 reg_hash，PUT source 把旧算法的 doc_hash 置空），不会留下旧算法的哈希。
    //   单行失败（例如 reg_source 是 BLOB）只记日志并跳过，其余行照常重算。
    //   ⚠️ 算法改版同时清空 prod_hash / prod_missing / verified_at / last_attempt_at / last_error（R3，同一条 UPDATE）：prod_hash 是按旧算法算的，不清空会新旧算法互比，
    //   徽章回到「未核验」，等下一次核验重建（见 impl-verify.js 头注释）。
    let normGate = null;
    async function recomputeNormHashes() {
        const run1 = (async () => {
            const ids = (await all(
                `SELECT id FROM model_impl_objects WHERE hash_algo IS NOT ? AND (reg_source IS NOT NULL OR reg_hash IS NOT NULL OR doc_hash IS NOT NULL OR hash_algo IS NOT NULL) ORDER BY id`, [HASH_ALGO])).map((r) => r.id);
            let updated = 0;
            const failed = [];
            for (const rid of ids) {
                try {
                    await withWriteLock('norm-recalc', false, async () => {
                        const row = await get('SELECT id, reg_source FROM model_impl_objects WHERE id = ? AND hash_algo IS NOT ?', [rid, HASH_ALGO]);
                        if (!row) return;
                        const regHash = isBlank(row.reg_source) ? null : normHash(row.reg_source);
                        const r = await run('UPDATE model_impl_objects SET reg_hash = ?, doc_hash = NULL, hash_algo = ?, prod_hash = NULL, prod_missing = 0, verified_at = NULL, last_attempt_at = NULL, last_error = NULL WHERE id = ? AND hash_algo IS NOT ?', [regHash, HASH_ALGO, rid, HASH_ALGO]);
                        updated += r.changes;
                    });
                } catch (e) {
                    failed.push(rid);
                    logger.error(`[impl-objects] norm_v1 重算：对象 ${rid} 失败，已跳过：${e && e.message}`);
                }
            }
            return { scanned: ids.length, updated, failed };
        })();
        normGate = run1.then(() => undefined, () => undefined);
        try { return await run1; } finally { normGate = null; }
    }

    // 每日 07:30 核验任务（复制自 sys-iteration/expiry-sweep.js 并参数化，见 daily-sweep.js）
    let dailySweep = null;
    let sweepReady = false;
    function startDailyVerify() {
        if (!verifier) return false;
        if (!dailySweep) {
            const timers = deps.dailyVerifyTimers || {};
            dailySweep = createDailySweep({
                label: '模型中心 实现对象每日核验', atHour: DAILY_VERIFY_HOUR, atMinute: DAILY_VERIFY_MINUTE,
                isReady: () => sweepReady,
                readNow: deps.dailyVerifyClock || (async () => (await get("SELECT datetime('now','localtime') AS t")).t),
                listCandidates: verifier.listCandidateIds, processOne: verifier.verifyObject, logger,
                isTerminal: () => !verifier.isAccepting(),   // 核验队列已永久停止接收 ⇒ 每日任务收到 stopped 后进入终态，不依赖 stopService 先后顺序
                setTimer: timers.setTimer, clearTimer: timers.clearTimer,
            });
        }
        sweepReady = true;
        return dailySweep.start();
    }
    /** 停止每日任务与核验队列（stopService 调用）：队列停止接收新任务并等在途任务完成，整体最多等 3 秒，不让关机卡在慢连接上 */
    async function stopDailyVerify() {
        sweepReady = false;
        if (!verifier) return;
        let t;
        await Promise.race([
            Promise.all([dailySweep ? dailySweep.stop() : Promise.resolve(), verifier.stop()]),
            new Promise((resolve) => { t = setTimeout(resolve, 3000); if (t.unref) t.unref(); }),
        ]);
        if (t) clearTimeout(t);
    }
    /** 服务启动序列（server.js 在 db 打开回调里调用）：等表建好 → norm_v1 重算 → 排定每日核验；任何一步失败只记日志，不阻断服务 */
    async function startBackground() {
        try {
            for (let i = 0; ; i++) {
                const t = await get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'model_impl_objects'");
                if (t) break;
                if (i >= 40) throw new Error('model_impl_objects 表迟迟未建好');
                await new Promise((resolve) => { const h = setTimeout(resolve, 500); if (h.unref) h.unref(); });
            }
            try {
                const r = await recomputeNormHashes();
                if (r.updated > 0 || r.failed.length) logger.info(`[impl-objects] norm_v1 重算完成：扫描 ${r.scanned} 行，更新 ${r.updated} 行，失败 ${r.failed.length} 行`);
            } catch (e) { logger.error(`[impl-objects] norm_v1 重算整体失败（不阻断每日核验的排定）: ${e && e.message}`); }
            startDailyVerify();   // 不依赖重算是否成功
        } catch (e) { logger.error(`[impl-objects] 启动序列失败（不阻断服务）: ${e && e.message}`); }
    }

    /** 写受影响模型的变更日志（锁内、与递增同事务）。before / after 记对象 id 与 reg_hash。 */
    async function writeChangeLog(modelId, modelName, summary, before, after, user) {
        await run(
            `INSERT INTO model_change_logs (model_id, model_name, action, change_type, before_value, after_value, change_summary, operator_id, operator_name)
             VALUES (?, ?, 'UPDATE', 'impl_object', ?, ?, ?, ?, ?)`,
            [modelId, modelName, JSON.stringify(before), JSON.stringify(after), summary, user && user.id != null ? user.id : null, userLabel(user)]
        );
    }

    // 读取一律过滤「对象已删除」或「模型已删除」的关系（方案 §4.3 末条）：别名约定 o = model_impl_objects、m = data_models。
    //   「模型行不存在」靠对 data_models 的内连接天然过滤。所有读关系的查询（对象列表 / 对象详情 / 模型的对象明细 / 关系计数）共用这两个谓词。
    const LIVE_OBJECT_PRED = 'o.is_deleted = 0';
    //   「模型存活」只有这一种写法（is_deleted 可为 NULL，按存活）：读取谓词（别名前缀 'm.'）与写语句自带的目标状态条件（无前缀，见 impl-links / purge-account）同源。
    const liveModelPred = (prefix) => `(${prefix}is_deleted = 0 OR ${prefix}is_deleted IS NULL)`;
    const LIVE_MODEL_PRED = liveModelPred('m.');

    /** 当前挂接了该对象的、未删除模型（id + 表名），按 id 升序 */
    const liveModelsOfObject = (objectId) => all(
        `SELECT m.id AS id, m.table_name AS table_name
           FROM model_impl_links l JOIN data_models m ON m.id = l.model_id
          WHERE l.object_id = ? AND ${LIVE_MODEL_PRED}
          ORDER BY m.id`, [objectId]);

    const OBJECT_COLS = `id, obj_type, db_connection_id, schema_name, obj_name, summary, reg_hash, hash_algo, doc_path, doc_hash, doc_reported_at,
        prod_hash, prod_missing, verified_at, last_attempt_at, last_error, created_at, updated_at, created_by, updated_by`;

    /** 某模型的有效实现对象（含对该模型的职责 role / sort_no 与徽章），供 GET /api/models/:id/relations；按 sort_no、对象 id 排序 */
    async function listModelObjects(modelId) {
        const rows = await all(
            `SELECT ${OBJECT_COLS.split(',').map((c) => 'o.' + c.trim()).join(', ')},
                    (o.reg_source IS NOT NULL) AS has_reg_source, l.role AS role, l.sort_no AS sort_no
               FROM model_impl_links l
               JOIN model_impl_objects o ON o.id = l.object_id
               JOIN data_models m ON m.id = l.model_id
              WHERE l.model_id = ? AND ${LIVE_OBJECT_PRED} AND ${LIVE_MODEL_PRED}
              ORDER BY l.sort_no, o.id`, [modelId]);
        const now = badgeNow();
        return rows.map((r) => Object.assign({}, r, { badges: computeBadges(r, now) }));
    }

    /** 每个模型的有效实现对象数（一条聚合 SQL）→ Map<model_id, n>；无有效对象的模型不在 Map 里 */
    async function countObjectsByModel() {
        const rows = await all(
            `SELECT l.model_id AS model_id, COUNT(*) AS n
               FROM model_impl_links l
               JOIN model_impl_objects o ON o.id = l.object_id
               JOIN data_models m ON m.id = l.model_id
              WHERE ${LIVE_OBJECT_PRED} AND ${LIVE_MODEL_PRED}
              GROUP BY l.model_id`);
        return new Map(rows.map((r) => [Number(r.model_id), Number(r.n)]));
    }

    /**
     * 每个模型的有效实现对象显示名（一条 SQL）→ Map<model_id, string[]>；无有效对象的模型不在 Map 里；不去重。
     * 顺序与 /relations 的 objects 一致（模型内按 sort_no、对象 id）；显示名在 JS 里拼（schema_name 为真值 → schema.obj_name，否则 obj_name；
     * 不在 SQL 里用 || 拼：NULL 会吞掉整串）。供列表的 impl_obj_names（#77 C4-api）。
     */
    async function listObjectNamesByModel() {
        const rows = await all(
            `SELECT l.model_id AS model_id, o.schema_name AS schema_name, o.obj_name AS obj_name
               FROM model_impl_links l
               JOIN model_impl_objects o ON o.id = l.object_id
               JOIN data_models m ON m.id = l.model_id
              WHERE ${LIVE_MODEL_PRED} AND ${LIVE_OBJECT_PRED}
              ORDER BY l.model_id, l.sort_no, l.object_id`);
        const map = new Map();
        for (const r of rows) {
            const key = Number(r.model_id);
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(r.schema_name ? `${r.schema_name}.${r.obj_name}` : r.obj_name);
        }
        return map;
    }

    // ─────────── GET 列表（登录用户）───────────
    router.get('/model-impl-objects', authenticateToken, async (req, res) => {
        try {
            const unowned = String(req.query.unowned || '') === '1';
            const rows = await all(
                `SELECT ${OBJECT_COLS.split(',').map((c) => 'o.' + c.trim()).join(', ')},
                        (o.reg_source IS NOT NULL) AS has_reg_source,
                        (SELECT COUNT(*) FROM model_impl_links l JOIN data_models m ON m.id = l.model_id
                          WHERE l.object_id = o.id AND ${LIVE_MODEL_PRED}) AS link_count
                   FROM model_impl_objects o
                  WHERE ${LIVE_OBJECT_PRED}
                    ${unowned ? `AND NOT EXISTS (SELECT 1 FROM model_impl_links l JOIN data_models m ON m.id = l.model_id
                                                  WHERE l.object_id = o.id AND ${LIVE_MODEL_PRED})` : ''}
                  ORDER BY o.id`);
            const now = badgeNow();
            res.json(rows.map((r) => Object.assign({}, r, { badges: computeBadges(r, now) })));
        } catch (e) { sendError(res, 'list', e); }
    });

    // ─────────── GET 详情（登录用户）：对象 + 有效关系（过滤已删模型；对象已删则 404）───────────
    router.get('/model-impl-objects/:id', authenticateToken, async (req, res) => {
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ error: '对象 id 非法', code: 'ID_INVALID' });
        try {
            const obj = await get(`SELECT ${OBJECT_COLS}, reg_source FROM model_impl_objects WHERE id = ? AND is_deleted = 0`, [id]);
            if (!obj) return res.status(404).json({ error: '实现对象不存在或已删除', code: 'OBJECT_NOT_FOUND' });
            const links = await all(
                `SELECT l.model_id AS model_id, m.table_name AS table_name, m.layer AS layer, l.role AS role, l.sort_no AS sort_no, l.created_at AS created_at, l.created_by AS created_by
                   FROM model_impl_links l JOIN data_models m ON m.id = l.model_id
                  WHERE l.object_id = ? AND ${LIVE_MODEL_PRED}
                  ORDER BY l.sort_no, l.model_id`, [id]);
            res.json(Object.assign({}, obj, { links, badges: computeBadges(obj, badgeNow()) }));
        } catch (e) { sendError(res, 'detail', e); }
    });

    // ─────────── POST 新建对象（admin）───────────
    router.post('/model-impl-objects', authenticateToken, requireAdmin, async (req, res) => {
        const f = validateObjectFields(req.body);
        if (!f.ok) return sendError(res, 'create', apiErrorFromValidation(f));
        const v = f.value;
        try {
            const out = await withWriteLock('create', false, async () => {
                // 连接行与身份唯一性都在锁内取，紧贴 INSERT（连接管理端点不占本锁，不能提前缓存）
                const connection = v.obj_type === 'FDL_TASK' ? null : ((await get('SELECT id, type FROM db_connections WHERE id = ?', [v.db_connection_id])) || null);
                const c = validateObjectConnection(v, { connection });
                if (!c.ok) throw apiErrorFromValidation(c);
                const dup = await get(
                    `SELECT id FROM model_impl_objects WHERE is_deleted = 0 AND obj_type = ? AND IFNULL(db_connection_id,0) = IFNULL(?,0)
                        AND IFNULL(schema_name,'') = IFNULL(?,'') COLLATE NOCASE AND obj_name = ? COLLATE NOCASE`, [v.obj_type, v.db_connection_id, v.schema_name, v.obj_name]);
                if (dup) throw new ApiError(409, 'OBJECT_IDENTITY_CONFLICT', '同身份的实现对象已存在', { existing_id: dup.id });
                let r;
                try {
                    r = await run(
                        `INSERT INTO model_impl_objects (obj_type, db_connection_id, schema_name, obj_name, summary, is_deleted, created_at, updated_at, created_by, updated_by)
                         VALUES (?, ?, ?, ?, ?, 0, datetime('now','localtime'), datetime('now','localtime'), ?, ?)`,
                        [v.obj_type, v.db_connection_id, v.schema_name, v.obj_name, v.summary, userLabel(req.user), userLabel(req.user)]);
                } catch (e) {
                    // 部分唯一索引兜底（预检与 INSERT 之间若有他路写入）
                    if (e && /UNIQUE/i.test(e.message || '')) throw new ApiError(409, 'OBJECT_IDENTITY_CONFLICT', '同身份的实现对象已存在');
                    throw e;
                }
                return r.lastID;
            });
            res.json({ id: out, message: '实现对象已创建' });
        } catch (e) { sendError(res, 'create', e); }
    });

    // ─────────── PUT 改 summary（admin）：身份字段不可改，改身份 = 删了重建 ───────────
    router.put('/model-impl-objects/:id', authenticateToken, requireAdmin, async (req, res) => {
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ error: '对象 id 非法', code: 'ID_INVALID' });
        const body = req.body;
        if (!isPlainObject(body)) return sendError(res, 'summary', new ApiError(400, 'INVALID_BODY', '请求体必须是 JSON 对象'));
        for (const k of ['obj_type', 'db_connection_id', 'schema_name', 'obj_name']) {
            if (hasOwn(body, k)) return sendError(res, 'summary', new ApiError(400, 'IDENTITY_IMMUTABLE', `对象身份字段 ${k} 不可修改（要改身份请删除后重建）`, { field: k }));
        }
        if (!hasOwn(body, 'summary')) return sendError(res, 'summary', new ApiError(400, 'INVALID_BODY', '缺少 summary', { field: 'summary' }));
        const s = validateSummary(body.summary);
        if (!s.ok) return sendError(res, 'summary', apiErrorFromValidation(s));
        try {
            await withWriteLock('summary', false, async () => {
                const r = await run(
                    `UPDATE model_impl_objects SET summary = ?, updated_at = datetime('now','localtime'), updated_by = ? WHERE id = ? AND is_deleted = 0`,
                    [s.value, userLabel(req.user), id]);
                if (r.changes === 0) throw new ApiError(404, 'OBJECT_NOT_FOUND', '实现对象不存在或已删除');
            });
            res.json({ message: '已更新' });
        } catch (e) { sendError(res, 'summary', e); }
    });

    // ─────────── PUT 登记源码（admin，只 PROC / VIEW / TRIGGER）───────────
    router.put('/model-impl-objects/:id/source', authenticateToken, requireAdmin, async (req, res) => {
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ error: '对象 id 非法', code: 'ID_INVALID' });
        if (!isPlainObject(req.body)) return sendError(res, 'source', new ApiError(400, 'INVALID_BODY', '请求体必须是 JSON 对象'));
        const t = validateLargeText(req.body.reg_source, 'reg_source');
        if (!t.ok) return sendError(res, 'source', apiErrorFromValidation(t));
        const newHash = normHash(t.value.text);   // norm_v1：规范化后求哈希（比较口径也是它：只改空白 / 换行 / 对象头大小写不算源码变化）
        try {
            if (normGate) await normGate;
            const out = await withWriteLock('source', true, async (obj) => {
                // 旧哈希：算法已是 norm_v1 取存值；否则（启动重算尚未轮到这一行的窗口）从旧源码现算，保证两端同口径，不拿 raw_v0 的值去比
                const oldHash = obj.hash_algo === HASH_ALGO ? obj.reg_hash : (isBlank(obj.reg_source) ? null : normHash(obj.reg_source));
                // 旧算法行（重算尚未轮到）：同一条 UPDATE 顺带把旧算法的 doc_hash 置空（无原文无从重算），不让 hash_algo 变成 norm_v1 后还留着 raw_v0 的另一半
                //   末次合并审 M1 + 收口批 2 LOW-3：判定与启动重算（:443）完全同口径——算法不等 norm_v1，且 reg_source / reg_hash / doc_hash / hash_algo 至少一项非空（IS NOT NULL 语义）。
                //   无哈希材料的 NULL 算法行（新建后只被每日核验扫过、带着核验数据的行）不是旧算法行，首次登记不能清掉它的核验数据
                const staleAlgo = isStaleAlgoRow(obj) ? 1 : 0;
                const r = await run(
                    `UPDATE model_impl_objects SET reg_source = ?, reg_hash = ?, hash_algo = ?, doc_hash = CASE WHEN ? = 1 THEN NULL ELSE doc_hash END,
                            prod_hash = CASE WHEN ? = 1 THEN NULL ELSE prod_hash END, prod_missing = CASE WHEN ? = 1 THEN 0 ELSE prod_missing END,
                            verified_at = CASE WHEN ? = 1 THEN NULL ELSE verified_at END, last_attempt_at = CASE WHEN ? = 1 THEN NULL ELSE last_attempt_at END,
                            last_error = CASE WHEN ? = 1 THEN NULL ELSE last_error END,
                            updated_at = datetime('now','localtime'), updated_by = ?
                      WHERE id = ? AND is_deleted = 0`,
                    [t.value.text, newHash, HASH_ALGO, staleAlgo, staleAlgo, staleAlgo, staleAlgo, staleAlgo, staleAlgo, userLabel(req.user), id]);
                // 内部不变量（不是业务判断）：预检在同一把 implWriteMutex 里读过最新行，本模块（及同锁的核验写入，它们不改 is_deleted）之外没有人写 model_impl_objects，所以这里不可达；
                //   走到即表示有锁外写入，按 500 IMPL_INVARIANT 报错并整体回滚
                if (r.changes === 0) throw new ApiError(500, 'IMPL_INVARIANT', '内部不变量被破坏：锁内预检读到的实现对象在更新时已不存在（有锁外写入）');
                // 方案 §4.1.1 A 表原句：reg_hash 由非空值变为另一非空值才递增（首次登记 / 同值重放不递增）
                let bumped = [];
                if (!isBlank(oldHash) && oldHash !== newHash) {
                    const models = await liveModelsOfObject(id);
                    if (models.length) {
                        await bumpConfigRev(conn, models.map((m) => m.id));
                        for (const m of models) {
                            await writeChangeLog(m.id, m.table_name, '实现对象登记源码变化',
                                [{ object_id: id, reg_hash: oldHash }], [{ object_id: id, reg_hash: newHash }], req.user);
                        }
                        bumped = models.map((m) => m.id);
                    }
                }
                return { bumped, changed: oldHash !== newHash };
            }, async () => {
                // 锁内预检（BEGIN 之前）：读最新对象行；不存在 404、类型不允许 400——失败不发 BEGIN / ROLLBACK
                const obj = await get('SELECT id, obj_type, reg_hash, reg_source, doc_hash, hash_algo FROM model_impl_objects WHERE id = ? AND is_deleted = 0', [id]);
                if (!obj) throw new ApiError(404, 'OBJECT_NOT_FOUND', '实现对象不存在或已删除');
                if (!SOURCE_TYPES.includes(obj.obj_type)) throw new ApiError(400, 'FIELD_COMBINATION_INVALID', `${obj.obj_type} 不能登记源码（只限 PROC / VIEW / TRIGGER）`, { field: 'reg_source' });
                return obj;
            });
            res.json({ message: '源码已登记', reg_hash: newHash, hash_algo: HASH_ALGO, changed: out.changed, bumped_model_ids: out.bumped });
            triggerVerify(id);   // 登记成功后立即核验一次（不阻塞响应，失败只落 last_error）
        } catch (e) { sendError(res, 'source', e); }
    });

    // ─────────── PUT 文档上报（admin，只 PROC / VIEW / TRIGGER）：存 doc_hash + doc_path + doc_reported_at；不存原文，不递增 config_rev ───────────
    router.put('/model-impl-objects/:id/doc', authenticateToken, requireAdmin, async (req, res) => {
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ error: '对象 id 非法', code: 'ID_INVALID' });
        if (!isPlainObject(req.body)) return sendError(res, 'doc', new ApiError(400, 'INVALID_BODY', '请求体必须是 JSON 对象'));
        const p = normalizeDocPath(req.body.doc_path);
        if (!p.ok) return sendError(res, 'doc', apiErrorFromValidation(p));
        const t = validateLargeText(req.body.doc_source, 'doc_source');
        if (!t.ok) return sendError(res, 'doc', apiErrorFromValidation(t));
        const docHash = normHash(t.value.text);   // 同 reg_hash：norm_v1
        try {
            if (normGate) await normGate;
            await withWriteLock('doc', false, async () => {
                const obj = await get('SELECT id, obj_type, reg_source, reg_hash, doc_hash, hash_algo FROM model_impl_objects WHERE id = ? AND is_deleted = 0', [id]);
                if (!obj) throw new ApiError(404, 'OBJECT_NOT_FOUND', '实现对象不存在或已删除');
                if (!SOURCE_TYPES.includes(obj.obj_type)) throw new ApiError(400, 'FIELD_COMBINATION_INVALID', `${obj.obj_type} 不能上报文档（只限 PROC / VIEW / TRIGGER）`, { field: 'doc_source' });
                // 旧算法行（重算尚未轮到）：同一条 UPDATE 顺带按 norm_v1 现算另一半 reg_hash（取旧源码），不让 hash_algo 变成 norm_v1 后还留着 raw_v0 的 reg_hash
                //   末次合并审 M1 + 收口批 2 LOW-3：同上，与启动重算完全同口径（isStaleAlgoRow：算法不等且有哈希材料）
                const staleAlgo = isStaleAlgoRow(obj) ? 1 : 0;
                const regHashNow = staleAlgo && !isBlank(obj.reg_source) ? normHash(obj.reg_source) : null;
                const r = await run(
                    `UPDATE model_impl_objects SET doc_path = ?, doc_hash = ?, hash_algo = ?, doc_reported_at = datetime('now','localtime'),
                            reg_hash = CASE WHEN ? = 1 THEN ? ELSE reg_hash END,
                            prod_hash = CASE WHEN ? = 1 THEN NULL ELSE prod_hash END, prod_missing = CASE WHEN ? = 1 THEN 0 ELSE prod_missing END,
                            verified_at = CASE WHEN ? = 1 THEN NULL ELSE verified_at END, last_attempt_at = CASE WHEN ? = 1 THEN NULL ELSE last_attempt_at END,
                            last_error = CASE WHEN ? = 1 THEN NULL ELSE last_error END,
                            updated_at = datetime('now','localtime'), updated_by = ?
                      WHERE id = ? AND is_deleted = 0`,
                    [p.value, docHash, HASH_ALGO, staleAlgo, regHashNow, staleAlgo, staleAlgo, staleAlgo, staleAlgo, staleAlgo, userLabel(req.user), id]);
                if (r.changes === 0) throw new ApiError(404, 'OBJECT_NOT_FOUND', '实现对象不存在或已删除');
            });
            res.json({ message: '文档已上报', doc_path: p.value, doc_hash: docHash, hash_algo: HASH_ALGO });
            triggerVerify(id);   // 上报成功后立即核验一次（不阻塞响应，失败只落 last_error）
        } catch (e) { sendError(res, 'doc', e); }
    });

    // ─────────── POST 手动触发核验（admin，只 PROC / VIEW / TRIGGER）：等核验结束返回结果与最新徽章 ───────────
    router.post('/model-impl-objects/:id/verify', authenticateToken, requireAdmin, async (req, res) => {
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ error: '对象 id 非法', code: 'ID_INVALID' });
        if (!verifier) return sendError(res, 'verify', new ApiError(503, 'VERIFY_DISABLED', '三端核验未启用'));
        try {
            const obj = await get('SELECT id, obj_type FROM model_impl_objects WHERE id = ? AND is_deleted = 0', [id]);
            if (!obj) throw new ApiError(404, 'OBJECT_NOT_FOUND', '实现对象不存在或已删除');
            if (!SOURCE_TYPES.includes(obj.obj_type)) throw new ApiError(400, 'FIELD_COMBINATION_INVALID', `${obj.obj_type} 不参与三端核验（只限 PROC / VIEW / TRIGGER）`);
            // 最多等 MANUAL_VERIFY_WAIT_MS（R4）：队列很长时不让请求一直挂着；超时返回 202 { queued: true }，核验仍在队列里继续执行。
            //   ⚠️ 停服期间已排队的核验可能被取消（不引入任务系统），以对象详情里的最终核验时间（verified_at / last_attempt_at）为准。
            const mt = deps.manualVerifyTimers || {};
            const setT = mt.setTimer || setTimeout;
            const clearT = mt.clearTimer || clearTimeout;
            let timer = null;
            const TIMEOUT = Symbol('manual-verify-timeout');
            const vp = verifier.verifyObject(id);
            vp.catch(() => {});   // 超时返回 202 之后若落库失败，不产生未处理的拒绝（失败已由队列任务自己处理 / 记日志）
            const outcome = await Promise.race([
                vp,
                new Promise((resolve) => { timer = setT(() => resolve(TIMEOUT), MANUAL_VERIFY_WAIT_MS); if (timer && typeof timer.unref === 'function') timer.unref(); }),
            ]);
            clearT(timer);
            if (outcome !== TIMEOUT && outcome.outcome === 'stopped') throw new ApiError(503, 'VERIFY_STOPPED', '服务正在停止，本次核验未执行');   // V3：队列已停止接收，不再返回「核验完成」
            if (outcome === TIMEOUT) return res.status(202).json({ message: '核验已排队，稍后在对象详情查看结果；停服期间已排队的核验可能被取消，以对象详情里的最终核验时间为准', queued: true });
            const row = await get(`SELECT ${OBJECT_COLS} FROM model_impl_objects WHERE id = ?`, [id]);
            res.json({ message: '核验完成', outcome: outcome.outcome, error: outcome.error || null, badges: computeBadges(row, badgeNow()) });
        } catch (e) { sendError(res, 'verify', e); }
    });

    // ─────────── DELETE 软删除（admin）：同事务删其全部关系；对原挂接的（未删除）模型递增 + 留痕 ───────────
    router.delete('/model-impl-objects/:id', authenticateToken, requireAdmin, async (req, res) => {
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ error: '对象 id 非法', code: 'ID_INVALID' });
        try {
            const out = await withWriteLock('delete', true, async (obj) => {
                const models = await liveModelsOfObject(id);
                await run('DELETE FROM model_impl_links WHERE object_id = ?', [id]);      // 含指向已删模型的历史脏关系
                const r = await run(
                    `UPDATE model_impl_objects SET is_deleted = 1, updated_at = datetime('now','localtime'), updated_by = ? WHERE id = ? AND is_deleted = 0`,
                    [userLabel(req.user), id]);
                // 内部不变量（不是业务判断）：同 source，预检在同一把锁里读过最新行，这里不可达；走到即表示有锁外写入，500 IMPL_INVARIANT 并整体回滚
                if (r.changes === 0) throw new ApiError(500, 'IMPL_INVARIANT', '内部不变量被破坏：锁内预检读到的实现对象在软删除时已不存在（有锁外写入）');
                if (models.length) {
                    await bumpConfigRev(conn, models.map((m) => m.id));
                    for (const m of models) {
                        await writeChangeLog(m.id, m.table_name, '实现对象被删除，已解挂',
                            [{ object_id: id, reg_hash: obj.reg_hash || null }], [], req.user);
                    }
                }
                return models.map((m) => m.id);
            }, async () => {
                // 锁内预检（BEGIN 之前）：读最新对象行，不存在 404——失败不发 BEGIN / ROLLBACK
                const obj = await get('SELECT id, reg_hash FROM model_impl_objects WHERE id = ? AND is_deleted = 0', [id]);
                if (!obj) throw new ApiError(404, 'OBJECT_NOT_FOUND', '实现对象不存在或已删除');
                return obj;
            });
            res.json({ message: '实现对象已删除', bumped_model_ids: out });
        } catch (e) { sendError(res, 'delete', e); }
    });

    // ─────────── PUT /api/models/:id/impl-links 整组替换（admin 或该模型的 canEditModel）───────────
    router.put('/models/:id/impl-links', authenticateToken, requireNonViewer, async (req, res) => {
        const modelId = parseId(req.params.id);
        if (!modelId) return res.status(400).json({ error: '模型 id 非法', code: 'ID_INVALID' });
        const lv = validateLinksInput(req.body);
        if (!lv.ok) return sendError(res, 'links', apiErrorFromValidation(lv));
        const wanted = lv.value;
        // 模型存在 / 删除态 / 权限判定：先在锁外做一次（无权限或不存在的请求不占锁、不开事务），进锁后再按最新的行重做一次
        // （模型在等锁期间可能被软删除或改了负责人；与模型软删除的「删关系」同锁串行，见 removeLinksForDeletedModel）。
        const assertEditable = async () => {
            const model = await get('SELECT * FROM data_models WHERE id = ?', [modelId]);
            if (!model) throw new ApiError(400, 'MODEL_NOT_FOUND', '模型不存在');
            if (model.is_deleted === 1) throw new ApiError(400, 'MODEL_DELETED', '模型已删除，不能挂接实现对象');
            if (!canEditModel(req.user, model)) throw new ApiError(403, 'FORBIDDEN', '权限不足：只有管理员、该模型的技术负责人或创建者可以维护实现对象挂接');
            // 方案 §3：伴生表的对象登记在主模型下，伴生表自身不持有关系（也避免软删除 / 恢复路径上关系复活，见 purgeLinksOfModel）
            if (model.companion_of != null) throw new ApiError(400, 'COMPANION_NOT_LINKABLE', '伴生表不能挂接实现对象，请挂在其主表下');
            return model;
        };
        try {
            await assertEditable();
            const out = await withWriteLock('links', true, async (model) => {
                const current = await all('SELECT object_id, role, sort_no FROM model_impl_links WHERE model_id = ?', [modelId]);
                const curMap = new Map(current.map((r) => [r.object_id, r]));
                const newMap = new Map(wanted.map((w) => [w.object_id, w]));
                const removed = current.filter((r) => !newMap.has(r.object_id)).map((r) => r.object_id);
                const added = wanted.filter((w) => !curMap.has(w.object_id));
                const kept = wanted.filter((w) => curMap.has(w.object_id));
                // 保留的关系只在 role / sort_no 变化时 UPDATE（不动 created_at / created_by）；整组替换 = DELETE 去掉的 + UPDATE 变化的 + INSERT 新增的，同一事务
                const by = userLabel(req.user);
                // 写语句自带目标状态条件（P57①·codex 49A-astra HIGH）：本模块的锁只护本模块的表，server.js 里改 data_models 归属 / 删除态的写语句都不持这把锁，
                //   所以预检（assertEditable）读到「模型存在、未删除、不是伴生表」之后、下面每条关系写语句之前，模型仍可能被软删除或转成伴生表。
                //   因此「模型存在、未删除、不是伴生表」这个条件写进每一条关系写语句本身（DELETE / UPDATE 的 AND EXISTS，INSERT 改成 INSERT … SELECT … WHERE EXISTS）。
                //   所有写 model_impl_links 的路径都持本模块锁，链接集合在锁内稳定，所以每条语句期望 changes === 1；任一条为 0 ⇒ 判定「模型状态已变」，立即停止后续写语句，**照常 COMMIT、不 ROLLBACK**。
                //   状态谓词与读取谓词同源（liveModelPred，与 LIVE_MODEL_PRED 同一写法：is_deleted = 0 OR is_deleted IS NULL，NULL 按存活）；再加 companion_of IS NULL（伴生表不持有关系）。
                //   记账按**实际生效的语句**：实际删掉的 + 实际插入的 changes 之和 > 0 ⇒ 关系集合真的变了 ⇒ 照常 bumpConfigRev + writeChangeLog（before = 原集合，after = 事务内重读的实际集合，不取 wanted）；
                //   一条都没生效（首条写语句之前就翻转）⇒ 不递增、不留痕。只有 role / sort_no 变化不递增（不变）。两种情形都返回 409 MODEL_STATE_CHANGED，已生效部分的带 partial: true 与实际 links。
                //   不回滚的依据：共享连接上 ROLLBACK 会撤掉别的模块同期写入（见 P52）；中途已写入的几条关系挂在「已删除 / 已转伴生」的模型上，读取路径过滤已删模型的关系（见 liveModelPred / LIVE_MODEL_PRED 处注释），
                //   删除路径之后会排队调用 removeLinksForDeletedModel、转伴生路径之后会排队调用 purgeLinksOfModel(account)，二者都要拿本模块锁，所以一定在本事务之后执行并清掉这些关系
                //   （转伴生那条还会递增并留痕——它留痕的 before 集与上面这次按实际变化写的 after 集衔接）。登记残余：转伴生后到清理执行前，残留关系在 /relations、列表关系计数里可见
                //   （LIVE_MODEL_PRED 只过滤删除态，不过滤 companion_of）；清理是不等结果的排队调用，等锁超时（5 秒）时残留会持续到下一次清理。
                //   不把权限列（tech_owner / created_by_id）放进条件：权限中途变化时若部分语句被挡，会在仍有效的独立模型上留下「改了关系却没递增 / 没留痕」的状态，
                //   比「权限刚撤销的用户多写一次」更坏；权限检查保留在锁内预检，作为线性化点。登记残余：预检之后、写入之前权限被撤销的那一次请求仍会写入（诚实使用下窗口为毫秒级）。
                //   bumpConfigRev 不加条件、不新增 UPDATE data_models 写点（写点分类守卫只登记 config-rev.js 一条）；writeChangeLog 同理。
                const MODEL_STATE_OK = `EXISTS (SELECT 1 FROM data_models WHERE id = ? AND ${liveModelPred('')} AND companion_of IS NULL)`;
                let delN = 0, insN = 0, effective = 0, stateChanged = false;
                const step = async (sql, params, kind) => {
                    const r = await run(sql, params);
                    if (r.changes === 0) { stateChanged = true; return false; }
                    effective += 1;
                    if (kind === 'del') delN += r.changes;
                    if (kind === 'ins') insN += r.changes;
                    return true;
                };
                const writeAll = async () => {
                    for (const oid of removed) {
                        if (!(await step(`DELETE FROM model_impl_links WHERE model_id = ? AND object_id = ? AND ${MODEL_STATE_OK}`, [modelId, oid, modelId], 'del'))) return;
                    }
                    for (const w of kept) {
                        const c = curMap.get(w.object_id);
                        if (c.role !== w.role || c.sort_no !== w.sort_no) {
                            if (!(await step(`UPDATE model_impl_links SET role = ?, sort_no = ? WHERE model_id = ? AND object_id = ? AND ${MODEL_STATE_OK}`, [w.role, w.sort_no, modelId, w.object_id, modelId], 'upd'))) return;
                        }
                    }
                    for (const w of added) {
                        if (!(await step(`INSERT INTO model_impl_links (model_id, object_id, role, sort_no, created_at, created_by)
                                          SELECT ?, ?, ?, ?, datetime('now','localtime'), ? WHERE ${MODEL_STATE_OK}`,
                            [modelId, w.object_id, w.role, w.sort_no, by, modelId], 'ins'))) return;
                    }
                };
                await writeAll();
                if (stateChanged) logger.warn(`[impl-objects:links] 模型 ${modelId} 在预检之后、写入过程中已被删除或转为伴生表（MODEL_STATE_CHANGED）：已生效 ${effective} 条语句，停止后续写入，事务照常提交`);
                // 方案 §4.1.1 A 表原句「挂接 / 解挂 → 关系集合实际变化」：按实际生效的 DELETE / INSERT 判断，role / sort_no 变化不递增
                const setChanged = delN > 0 || insN > 0;
                const finalRows = await all('SELECT object_id, role, sort_no FROM model_impl_links WHERE model_id = ? ORDER BY sort_no, object_id', [modelId]);
                if (setChanged) {
                    await bumpConfigRev(conn, [modelId]);
                    const hashOf = async (oids) => {
                        if (!oids.length) return new Map();
                        const rows = await all(`SELECT id, reg_hash FROM model_impl_objects WHERE id IN (${oids.map(() => '?').join(',')})`, oids);
                        return new Map(rows.map((r) => [r.id, r.reg_hash || null]));
                    };
                    const hashes = await hashOf([...new Set([...current.map((r) => r.object_id), ...finalRows.map((r) => r.object_id)])]);
                    const snap = (oids) => oids.slice().sort((a, b) => a - b).map((oid) => ({ object_id: oid, reg_hash: hashes.has(oid) ? hashes.get(oid) : null }));
                    await writeChangeLog(modelId, model.table_name, `实现对象挂接变更：新增 ${insN}、解挂 ${delN}${stateChanged ? '（中途模型状态变化，仅部分生效）' : ''}`,
                        snap(current.map((r) => r.object_id)), snap(finalRows.map((r) => r.object_id)), req.user);
                }
                if (stateChanged) return { stateChanged: true, partial: effective > 0, changed: setChanged, links: finalRows };
                return { changed: setChanged, links: finalRows };
            }, async () => {
                // 锁内预检（BEGIN 之前）：按最新的行重做一次模型存在 / 删除态 / 权限 / 伴生判定，再核对待挂接对象都存在且未删除——失败不发 BEGIN / ROLLBACK。
                //   （锁外那一次 assertEditable 保留：无权限或不存在的请求不占锁）
                const model = await assertEditable();
                if (wanted.length) {
                    const ids = wanted.map((w) => w.object_id);
                    const live = await all(`SELECT id FROM model_impl_objects WHERE is_deleted = 0 AND id IN (${ids.map(() => '?').join(',')})`, ids);
                    const liveSet = new Set(live.map((r) => r.id));
                    const missing = ids.filter((x) => !liveSet.has(x));
                    if (missing.length) throw new ApiError(400, 'OBJECT_NOT_FOUND', `实现对象不存在或已删除：${missing.join(',')}`, { object_ids: missing });
                }
                return model;
            });
            if (out.stateChanged === true) {
                // 事务体已照常 COMMIT（见上文「不回滚的依据」）；这里只把「模型状态已变」映射成 409。
                //   partial: true ⇒ 中途翻转前已有语句生效（带实际 links）；partial: false ⇒ 首条写语句之前就翻转，零写入
                //   文案按 partial 区分（codex 50A LOW）：部分生效时不能说「未保存」
                return sendError(res, 'links', new ApiError(409, 'MODEL_STATE_CHANGED',
                    out.partial ? '模型状态已变化（已删除或已转为伴生表），部分挂接变更已生效，请刷新后查看' : '模型状态已变化（已删除或已转为伴生表），挂接未保存，请刷新后重试',
                    out.partial ? { partial: true, links: out.links } : { partial: false }));
            }
            res.json({ message: '挂接已更新', changed: out.changed, links: out.links });
        } catch (e) { sendError(res, 'links', e); }
    });

    /**
     * 模型软删除后删关系（方案 §4.3：模型软删除只删关系、不删对象；模型恢复不自动恢复关系）。
     * 由 server.js 的 DELETE /api/models/:id 在软删除 UPDATE 成功之后调用，传入被删模型 id（含其级联软删除的伴生表）。
     * 单条 DELETE，占本模块锁（避免被他人事务卷入的同源风险见 implWriteMutex 注释）；不递增 config_rev（已删模型不参与判定；恢复时恒递增）。
     * 写语句自带目标状态条件（P57①）：本函数是排队等锁之后才执行的，期间该模型可能已被恢复并重新挂接，无条件 DELETE 会误删合法关系，
     *   所以第一部分只在该模型此刻确为已删除（is_deleted = 1）时才删；第二部分（其已删伴生表）原本就带 is_deleted = 1 条件。
     * 与模型软删除 UPDATE 不是同一事务（两者在共享连接上无法原子合并）：本函数失败时只留下指向已删模型的脏关系，
     * 所有读取路径都过滤「模型已删除」的关系，不可见；调用方应只记日志、不让删除响应失败。
     */
    async function removeLinksForDeletedModel(modelId) {
        const id = Number(modelId);
        if (!Number.isInteger(id) || id <= 0) return { changes: 0 };
        return withWriteLock('model-delete', false, async () => run(
            `DELETE FROM model_impl_links WHERE (model_id = ? AND EXISTS (SELECT 1 FROM data_models WHERE id = ? AND is_deleted = 1))
                OR model_id IN (SELECT id FROM data_models WHERE companion_of = ? AND is_deleted = 1)`, [id, id, id]));
    }

    /**
     * 清掉某模型的全部实现对象关系——恢复路径的单点收口（C2b-1 修复 1 W2）：模型软删除后若「删关系」失败留下脏关系，
     * 恢复（is_deleted 改回 0）会让它们复活；所以在每个把 is_deleted 改回 0 的点之前先调本函数。
     * 单条 DELETE，占本模块锁；失败时**抛出**，由调用方决定 fail-closed（POST /restore ⇒ 500 拒绝恢复；companion-restore ⇒ 跳过恢复）。
     * opts.onlyIfDeleted：只在该模型当前确为已删除时才清（恢复路径用：对已处于恢复状态的模型重复调用 restore 不得清掉其有效关系）；
     * opts.companionsOnly：传入的是主表 id，只清它的伴生子表（companion_of = id）的关系，不动主表自己的关系（取消变更追踪软删伴生表的收尾用）。
     * opts.account（+ opts.user）：带记账——有关系才清，并递增 config_rev、写 impl_object 变更日志（转伴生路径用）。
     * 其余调用（清洁性收口：同名重注册物理 DELETE、已有模型被转成伴生表）失败只记日志，由调用方处理。
     */
    async function purgeLinksOfModel(modelId, opts) {
        const id = Number(modelId);
        if (!Number.isInteger(id) || id <= 0) throw new Error('purgeLinksOfModel：模型 id 非法');
        const o = opts || {};
        let sql, params;
        if (o.onlyIfDeleted) { sql = 'DELETE FROM model_impl_links WHERE model_id = ? AND EXISTS (SELECT 1 FROM data_models WHERE id = ? AND is_deleted = 1)'; params = [id, id]; }
        else if (o.companionsOnly) { sql = 'DELETE FROM model_impl_links WHERE model_id IN (SELECT id FROM data_models WHERE companion_of = ?)'; params = [id]; }
        else { sql = 'DELETE FROM model_impl_links WHERE model_id = ?'; params = [id]; }
        if (o.account) {
            // 带记账的清理（转伴生路径的并发窗口兜底，codex 25 X1）：锁内事务里先查现存关系；非空才 DELETE + bumpConfigRev + 写一条 impl_object 变更日志
            //   （before 为原集合，after 为空集）；集合为空什么都不做。清关系是「关系集合实际变化」，必须与 impl-links 解挂同样递增并留痕。
            //   目标状态复核（C2b-2·codex 25-R MED）：转换 UPDATE 的 changes 只说明「那一刻」行被改成了伴生表，清理是之后异步执行的，
            //   期间该模型可能被改回独立模型 / 被删除。所以在同一把锁、同一个事务里先确认它此刻仍是 expectedParentId 的伴生表且未删除，
            //   不满足就跳过（不清关系、不递增、不留痕），返回 { skipped: 'NOT_COMPANION_OF_PARENT' } 并记日志。
            const expectedParentId = Number(o.expectedParentId);
            if (!Number.isInteger(expectedParentId) || expectedParentId <= 0) throw new Error('purgeLinksOfModel：account 模式必须传入 expectedParentId（主表 id）');
            //   写语句自带目标状态条件（P57①·codex 49A-astra HIGH）：本模块的锁只护本模块的表，server.js 里改 data_models 归属 / 删除态的写语句都不持这把锁，
            //   所以预检读到「仍是 expectedParentId 的未删除伴生表」之后、下面的 DELETE 之前，目标仍可能被改挂 / 被软删除 / 被改回独立模型。
            //   因此「目标仍是 expectedParentId 的未删除伴生表」这个条件必须写进 DELETE 语句本身（EXISTS 子查询与删除在同一条语句里原子判定），
            //   不能只靠预检。条件不满足 ⇒ changes === 0 ⇒ { skipped: 'TARGET_CHANGED' }：不递增、不留痕，事务照常 COMMIT（不 ROLLBACK：共享连接上回滚会撤掉别的模块同期写入，见 P52）。
            //   与预检里的 NOT_COMPANION_OF_PARENT 的区别：NOT_COMPANION_OF_PARENT = 预检那一刻目标就不满足（不开事务）；
            //   TARGET_CHANGED = 预检通过之后、写语句之前目标变了（已开事务，但事务里什么都没写）。
            //   残余：条件通过之后到 COMMIT 之间目标再变，只影响一个已被清掉关系的模型的版本号与日志，无害（转伴生 / 删除路径本身会再排队清理，见 server.js 调用点）。
            return withWriteLock('purge-account', true, async (pre) => {
                const r = await run(
                    `DELETE FROM model_impl_links WHERE model_id = ?
                        AND EXISTS (SELECT 1 FROM data_models WHERE id = ? AND companion_of = ? AND ${liveModelPred('')})`,
                    [id, id, expectedParentId]);
                if (r.changes === 0) {
                    logger.warn(`[impl-objects:purge-account] 跳过清理（TARGET_CHANGED）：预检之后、写入之前模型 ${id} 已不是主表 ${expectedParentId} 的未删除伴生表，未清关系、未递增、未留痕`);
                    return { changes: 0, accounted: false, skipped: 'TARGET_CHANGED' };
                }
                if (r.changes !== pre.rows.length) {
                    logger.warn(`[impl-objects:purge-account] 清除条数 ${r.changes} 与预检读到的关系数 ${pre.rows.length} 不一致（模型 ${id}，主表 ${expectedParentId}）：链接集合在锁内应稳定，仍按实际清除记账`);
                }
                await bumpConfigRev(conn, [id]);
                await writeChangeLog(id, pre.table_name, '转为伴生表，伴生表不持有实现对象：已清除其实现对象关系',
                    pre.rows.map((x) => ({ object_id: x.object_id, reg_hash: x.reg_hash || null })), [], o.user || null);
                return { changes: r.changes, accounted: true };
            }, async () => {
                // 锁内预检（BEGIN 之前）：目标状态复核——不满足 / 没有关系可清 ⇒ skipTxn（不开事务，什么都不写）
                const target = await get('SELECT companion_of, is_deleted, table_name FROM data_models WHERE id = ?', [id]);
                if (!target || target.companion_of !== expectedParentId || target.is_deleted === 1) {
                    logger.warn(`[impl-objects:purge-account] 跳过清理：模型 ${id} 此刻不是主表 ${expectedParentId} 的未删除伴生表（companion_of=${target ? target.companion_of : '无此行'}，is_deleted=${target ? target.is_deleted : '无此行'}）`);
                    return skipTxn({ changes: 0, accounted: false, skipped: 'NOT_COMPANION_OF_PARENT' });
                }
                const rows = await all(
                    `SELECT l.object_id AS object_id, o.reg_hash AS reg_hash FROM model_impl_links l LEFT JOIN model_impl_objects o ON o.id = l.object_id
                      WHERE l.model_id = ? ORDER BY l.object_id`, [id]);
                if (!rows.length) return skipTxn({ changes: 0, accounted: false });
                return { table_name: target.table_name === undefined ? null : target.table_name, rows };
            });
        }
        return withWriteLock('purge', false, async () => run(sql, params));
    }

    return {
        router, removeLinksForDeletedModel, purgeLinksOfModel,
        // C2b-3：/relations 与列表 rel 计数复用本模块的「有效关系」过滤
        listModelObjects, countObjectsByModel, listObjectNamesByModel,
        // C2b-2：核验 / 重算 / 每日任务（server.js 调 startBackground / stopDailyVerify；其余供验证脚本进程内直调）
        startBackground, stopDailyVerify, recomputeNormHashes, startDailyVerify,
        verifyObject: (objectId) => (verifier ? verifier.verifyObject(objectId) : Promise.reject(new Error('三端核验未启用'))),
        idleVerifies: () => (verifier ? verifier.idle() : Promise.resolve()),
        _internals: { get dailySweep() { return dailySweep; }, get verifier() { return verifier; } },
    };
}

module.exports = createImplObjects;
module.exports.validators = {
    validateObjectFields, validateObjectConnection, validateObjectInput, validateSummary, validateRole, validateSortNo,
    validateLargeText, normalizeDocPath, validateLinksInput, normHash,
};
module.exports.constants = { OBJ_TYPES, SOURCE_TYPES, MAX_TEXT_BYTES, MAX_LINKS_PER_REPLACE, HASH_ALGO };
