'use strict';

/**
 * 实现对象三端一致性核验（#77 C2b-2，方案 v0.9 §4.4 / §6.1 C2b ②③⑦）。
 *
 * 本文件三块：
 *   1. createSqlServerDefinitionReader：读生产定义。SQL 一律是下面的常量字面量，schema / 名称只经 request.input 传入，不拼接；
 *   2. createImplVerify：核验函数 verifyObject——串行队列（同一对象等待中的请求合并）、连库与读取在锁外、落库的那一条 UPDATE 在模块锁内且带「对象仍未删除」条件；
 *   3. computeBadges：徽章读时计算（不落库状态值），严格按方案八行顺序表。
 *
 * 读定义的 SQL 常量必须是不含 JS 拼接 / 模板插值的单行字面量（验证脚本对本文件做静态断言，并用假连接池核对「名称只出现在 input 里」）。
 *
 * 落库的 last_error 只存分类文案（ERROR_KINDS 枚举），错误原文（主机 / 端口 / 登录名等）只写服务端日志，不落库、不出现在任何响应里。
 *
 * 生产账号权限（R1）：只有「缺失判定」需要数据库级 VIEW DEFINITION；对象行已存在时，对象级权限即可正常核验（读到定义 / 类型）。
 *   元数据不可见时 sys.objects / sys.triggers 查不到行，与对象真缺失无法区分，
 *   所以两条读定义 SQL 都附带 HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'VIEW DEFINITION') AS can_view：只有确认具备该权限（can_view = 1）时才把「无对象行」
 *   判为缺失（prod_missing）；无对象行且 can_view 不等于 1 ⇒ 记错误「无权读取定义」，绝不记 prod_missing。
 *
 * 时区（R5）：徽章「7 天未核验 ⇒ 待重核」按「本机公民时间」计算（verified_at 是 SQLite localtime 字符串，now 取本机时钟）。
 *   平台部署在北京时间（UTC+8，无夏令时），所以公民时间差恒等于真实时间差；若部署时区改成有夏令时的时区，7 天边界会随之偏移最多 1 小时，须重新评估。
 *
 * ⚠️ 算法改版须知：reg_hash / doc_hash 的算法（hash_algo）一旦改版，除全量重算 reg_hash 外，必须同时清空 prod_hash / verified_at / last_attempt_at / last_error
 *   （prod_hash 是按旧算法对生产定义算的，不清空会拿新旧算法的哈希互相比较，徽章给出假「不一致」）；清空后徽章回到「未核验」，待下一次核验重建。
 */

const { normalizeSqlDefinition } = require('./sql-normalize');

const SOURCE_TYPES = Object.freeze(['PROC', 'VIEW', 'TRIGGER']);
const STALE_MS = 7 * 86400000;
const STOP_WAIT_MS = 3000;

// ───────────────────────────── 读生产定义的 SQL（参数化，常量字面量）─────────────────────────────
// 存在性、定义与权限合并为一条（always one row：LEFT JOIN 保证即使对象无行也能带回 can_view）（方案 §6.1 ③「定义为 NULL 不等于缺失」仍成立：无行 = 对象不存在；有行而 def 为 NULL = 无权读取定义）。
// PROC / VIEW / DML 触发器：有 schema，走 OBJECT_ID(QUOTENAME(@s) + '.' + QUOTENAME(@n))。
const SQL_READ_BY_SCHEMA = "SELECT p.can_view AS can_view, q.otype AS otype, q.def AS def FROM (SELECT HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'VIEW DEFINITION') AS can_view) AS p LEFT JOIN (SELECT o.type AS otype, OBJECT_DEFINITION(o.object_id) AS def FROM sys.objects AS o WHERE o.object_id = OBJECT_ID(QUOTENAME(@s) + N'.' + QUOTENAME(@n))) AS q ON 1 = 1";
// 库级 DDL 触发器（ON DATABASE，无 schema）：sys.triggers WHERE parent_class = 0 AND name = @n，左关联 sys.sql_modules。
const SQL_READ_DB_TRIGGER = "SELECT p.can_view AS can_view, q.otype AS otype, q.def AS def FROM (SELECT HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'VIEW DEFINITION') AS can_view) AS p LEFT JOIN (SELECT t.type AS otype, m.definition AS def FROM sys.triggers AS t LEFT JOIN sys.sql_modules AS m ON m.object_id = t.object_id WHERE t.parent_class = 0 AND t.name = @n) AS q ON 1 = 1";

// 登记类型 → 生产 sys.objects.type 的可接受取值。PC / X / RF / TA（CLR、扩展、复制过滤、CLR 触发器）没有 T-SQL 定义，单列。
// RF（复制过滤过程）有 T-SQL 定义，按 PROC 接受；PC / X（CLR / 扩展过程）与 TA（CLR 触发器）没有 T-SQL 定义，单列。
const OBJECT_TYPE_CODES = Object.freeze({ PROC: ['P', 'RF'], VIEW: ['V'], TRIGGER: ['TR'] });
const NO_TSQL_DEFINITION_TYPES = Object.freeze(['PC', 'X', 'TA']);

// last_error 落库的唯一取值集合
const ERROR_KINDS = Object.freeze(['连接失败', '登录失败', '超时', '查询出错', '类型不符', '无权读取定义', '未知错误']);

/** 带分类的错误（读取器自己抛的）：kind 必须在 ERROR_KINDS 内，detail 只进服务端日志 */
function kindError(kind, detail) {
    const e = new Error(detail || kind);
    e.verifyKind = kind;
    return e;
}

/** 错误原文（仅供服务端日志；控制字符压成空格、截断） */
function cleanError(e) {
    const m = String((e && e.message) || e || '未知错误').replace(/[\u0000-\u001F\u007F]+/g, ' ').trim();
    return (m || '未知错误').slice(0, 500);
}

/** 把任意错误归到 ERROR_KINDS 之一（落库只存这个文案） */
function classifyError(e) {
    if (e && ERROR_KINDS.includes(e.verifyKind)) return e.verifyKind;
    const text = `${(e && e.code) || ''} ${(e && e.message) || ''}`;
    if (/ELOGIN|login failed/i.test(text)) return '登录失败';
    if (/ETIMEOUT|ETIMEDOUT|timeout|timed out/i.test(text)) return '超时';
    if (/ECONNREFUSED|ECONNRESET|ESOCKET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EINSTLOOKUP|ECONNCLOSED|ENOTOPEN|connect/i.test(text)) return '连接失败';
    if (/EREQUEST|RequestError|query|syntax/i.test(text)) return '查询出错';
    return '未知错误';
}

/**
 * 解读读定义查询的那一行（R1）：
 *   · 没有返回行 / 无法确认权限（can_view 不等于 1）且无对象行 ⇒ 抛「无权读取定义」（fail-closed，不当缺失）；
 *   · 无对象行（otype 为空）且 can_view = 1 ⇒ { exists: false }（确认有元数据可见权限才算缺失）；
 *   · 有对象行 ⇒ 校验类型（matchType 为登记类型时校验与登记一致；库级触发器传 null 只排除无 T-SQL 定义的类型）；def 为 NULL ⇒ { exists: true, definition: null }。
 */
function interpretRow(hit, matchType) {
    if (!hit) throw kindError('无权读取定义', '读定义查询没有返回行，无法确认元数据可见权限');
    if (hit.otype === null || hit.otype === undefined) {
        if (Number(hit.can_view) === 1) return { exists: false, definition: null };
        throw kindError('无权读取定义', '无对象行且当前账号没有数据库级 VIEW DEFINITION 权限，无法区分对象缺失与元数据不可见');
    }
    const otype = String(hit.otype).trim();
    if (NO_TSQL_DEFINITION_TYPES.includes(otype)) throw kindError('类型不符', `该类型对象无 T-SQL 定义（生产类型 ${otype}）`);
    if (matchType && !(OBJECT_TYPE_CODES[matchType] || []).includes(otype)) throw kindError('类型不符', `生产对象类型（${otype || '未知'}）与登记类型 ${matchType} 不符`);
    return { exists: true, definition: hit.def === undefined ? null : hit.def };
}

/**
 * 默认读取器工厂（生产用）：getConnectionRow(id) 返回 db_connections 行（含 type / host / port / database / username / password）；
 * getMssqlPool 与 decryptPassword 是 server.js 既有函数。返回 async read(obj) → { exists, definition }（连库 / 查询出错时抛错）。
 */
function createSqlServerDefinitionReader({ getConnectionRow, getMssqlPool, decryptPassword }) {
    for (const [k, v] of Object.entries({ getConnectionRow, getMssqlPool, decryptPassword })) {
        if (typeof v !== 'function') throw new Error(`createSqlServerDefinitionReader：缺少 ${k}`);
    }
    return async function readDefinition(obj) {
        const row = await getConnectionRow(obj.db_connection_id);
        if (!row) throw kindError('连接失败', '登记的数据库连接不存在');
        if (row.type !== 'sqlserver') throw kindError('连接失败', '登记的数据库连接不是 SQL Server');
        let password;
        try { password = decryptPassword(row.password); } catch (_) { throw kindError('连接失败', '数据库连接密码解密失败'); }
        const pool = await getMssqlPool({ host: row.host, port: row.port, database: row.database, username: row.username, password });
        const dbLevel = obj.obj_type === 'TRIGGER' && (obj.schema_name === null || obj.schema_name === undefined || obj.schema_name === '');
        const req = pool.request();
        if (dbLevel) {
            req.input('n', obj.obj_name);
            const r = await req.query(SQL_READ_DB_TRIGGER);
            return interpretRow(r.recordset && r.recordset[0], null);
        }
        req.input('s', obj.schema_name);
        req.input('n', obj.obj_name);
        const r = await req.query(SQL_READ_BY_SCHEMA);
        return interpretRow(r.recordset && r.recordset[0], obj.obj_type);
    };
}

// ───────────────────────────── 核验 ─────────────────────────────
// 落库规则（方案 §4.4 表）：每种结果一条 UPDATE；时间列由 SQLite 在语句内生成（同一语句内 'now' 恒定，两列同值同格式）；
// 都带 is_deleted = 0 条件（核验期间对象被删则不写）。
const SQL_WRITE_OK = `UPDATE model_impl_objects SET prod_hash = ?, prod_missing = 0, verified_at = datetime('now','localtime'), last_attempt_at = datetime('now','localtime'), last_error = NULL WHERE id = ? AND is_deleted = 0`;
const SQL_WRITE_MISSING = `UPDATE model_impl_objects SET prod_hash = NULL, prod_missing = 1, verified_at = datetime('now','localtime'), last_attempt_at = datetime('now','localtime'), last_error = NULL WHERE id = ? AND is_deleted = 0`;
const SQL_WRITE_FAILURE = `UPDATE model_impl_objects SET last_attempt_at = datetime('now','localtime'), last_error = ? WHERE id = ? AND is_deleted = 0`;

function createImplVerify({ db: conn, logger, withWriteLock, readDefinition, normalize = normalizeSqlDefinition, stopWaitMs = STOP_WAIT_MS }) {
    for (const [k, v] of Object.entries({ db: conn, logger, withWriteLock, readDefinition, normalize })) {
        if (!v) throw new Error(`impl-verify：缺少依赖 ${k}`);
    }
    const get = (sql, params = []) => new Promise((resolve, reject) => { conn.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))); });
    const run = (sql, params = []) => new Promise((resolve, reject) => {
        conn.run(sql, params, function (err) { if (err) reject(err); else resolve({ changes: this.changes }); });
    });
    const all = (sql, params = []) => new Promise((resolve, reject) => { conn.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))); });

    // 最后那一条 UPDATE 在模块锁内（单语句，不开事务）
    // 进锁后、执行 SQL 之前再查一次 writable（Q1）：等写锁期间停服超时的话，拿到锁后也不能再写
    const STOPPED_MARK = Symbol('impl-verify-stopped');
    const write = (sql, params) => withWriteLock('verify', false, async () => {
        if (!writable) return STOPPED_MARK;
        return run(sql, params);
    });

    /**
     * 核验一个对象：读生产定义（锁外）→ 一条 UPDATE 落库（锁内）。
     * 返回 { outcome: 'ok' | 'missing' | 'error' | 'skipped', error? }；读取失败只落 last_error（分类文案）、不抛；落库自身失败才抛。
     */
    async function runOne(objectId) {
        const obj = await get('SELECT id, obj_type, db_connection_id, schema_name, obj_name FROM model_impl_objects WHERE id = ? AND is_deleted = 0', [objectId]);
        if (!obj || !SOURCE_TYPES.includes(obj.obj_type)) return { outcome: 'skipped' };
        // 统一的「写前检查」（R2 / L-a）：队列已停止接收（停服）后，在途项稍后才读完时不再写库（连接可能已关），库里的旧结论保持不变；
        //   成功 / 缺失 / 失败三条写库路径都只经这一个出口，且每种结果恰好一条 UPDATE、在模块锁内
        const commit = async (sql, params, outcome) => {
            if (!writable) return { outcome: 'stopped' };
            const w = await write(sql, params);
            if (w === STOPPED_MARK) return { outcome: 'stopped' };
            return outcome;
        };
        const fail = async (kind, raw) => {
            if (raw !== undefined) logger.warn(`[impl-verify] 对象 ${obj.id} 核验失败（${kind}）：${raw}`);   // 错误原文只进服务端日志
            return commit(SQL_WRITE_FAILURE, [kind, obj.id], { outcome: 'error', error: kind });
        };
        let res;
        try { res = await readDefinition(obj); } catch (e) { return fail(classifyError(e), cleanError(e)); }
        if (!res || typeof res.exists !== 'boolean') return fail('查询出错', '读取生产定义返回了无法识别的结果');
        if (!res.exists) return commit(SQL_WRITE_MISSING, [obj.id], { outcome: 'missing' });
        // 对象存在但定义为 NULL：多半是无权读取，不等于缺失（方案 §6.1 ③）
        if (res.definition === null || res.definition === undefined) return fail('无权读取定义');
        if (typeof res.definition !== 'string') return fail('查询出错', '生产定义不是文本');
        let prodHash;
        try { prodHash = normalize(res.definition).hash; } catch (e) { return fail('未知错误', cleanError(e)); }
        return commit(SQL_WRITE_OK, [prodHash, obj.id], { outcome: 'ok' });
    }

    // ── 串行队列：即时核验 / 手动端点 / 每日任务的单对象处理一律走这里 ──
    //   同一时刻最多一个在途；同一对象已在队列里「等待」时，新请求合并进去（共享同一个 promise，等它真正开始时才读生产，
    //   所以读到的一定是最新状态）；已经在途的那个不合并（它可能读到了旧状态），新请求另排一个等待项。
    //   这样连接池不会被并发核验泄漏，旧读取也不会覆盖新读取（落库顺序 = 读取顺序）。
    let chain = Promise.resolve();
    let accepting = true;   // 是否接收新任务（stop 一开始就置 false）
    let writable = true;    // 是否还允许落库（stop 的等待上限到了才置 false：等待期内完成的在途项照常落库，超时之后才结束的不再写）
    const waiting = new Map();
    function enqueue(objectId) {
        if (!accepting) return Promise.resolve({ outcome: 'stopped' });
        if (waiting.has(objectId)) return waiting.get(objectId);
        const p = chain.then(async () => {
            waiting.delete(objectId);
            if (!accepting) return { outcome: 'stopped' };
            return runOne(objectId);
        });
        waiting.set(objectId, p);
        chain = p.catch(() => {});
        return p;
    }
    const verifyObject = (objectId) => enqueue(objectId);
    /** 当前已排队 / 在途的核验全部结束（含结束期间新排的） */
    async function idle() { let c; do { c = chain; await c; } while (c !== chain); }
    /** 停止接收新任务，等在途任务完成，最多等 3 秒（停服用） */
    async function stop() {
        accepting = false;
        let t;
        await Promise.race([idle(), new Promise((resolve) => { t = setTimeout(resolve, stopWaitMs); if (t.unref) t.unref(); })]);
        if (t) clearTimeout(t);
        writable = false;
    }

    /** 每日核验的候选：全部未删除的 PROC / VIEW / TRIGGER（按 id 升序，串行处理） */
    async function listCandidateIds() {
        const rows = await all(`SELECT id FROM model_impl_objects WHERE is_deleted = 0 AND obj_type IN ('PROC','VIEW','TRIGGER') ORDER BY id`);
        return rows.map((r) => r.id);
    }

    /** 队列是否还接收新任务（stop 之后永远为 false：永久停止，每日任务据此进入终态） */
    const isAccepting = () => accepting;
    return { verifyObject, listCandidateIds, idle, stop, isAccepting };
}

// ───────────────────────────── 徽章（读时计算）─────────────────────────────
// 稳定的英文 code（供前端映射文案）；BADGE_LABELS 是 code → 方案 §4.4 表里的中文文案（C4 前端用）
const LABEL = Object.freeze({
    UNVERIFIED: 'unverified',
    FAILED: 'verify_failed',
    STALE: 'stale',
    PROD_MISSING: 'prod_missing',
    UNREGISTERED: 'unregistered',
    CONSISTENT: 'consistent',
    INCONSISTENT: 'inconsistent',
});
const BADGE_LABELS = Object.freeze({
    unverified: '未核验',
    verify_failed: '核验失败',
    stale: '待重核',
    prod_missing: '生产缺失',
    unregistered: '未登记',
    consistent: '一致',
    inconsistent: '不一致',
});

/** 本机当前的公民时间（与 SQLite datetime('now','localtime') 同格式 / 同时区） */
function civilNow(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
// 严格解析（V2）：格式合法后，把解析出的年月日时分秒逐项回读，与原字符串比对；不一致（2026-02-30、月份 13、小时 24、分钟 60 会被 Date 滚动成别的日期时间）一律视为非法 ⇒ NaN
function civilMs(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)) return NaN;
    const t = Date.parse(v.replace(' ', 'T') + 'Z');
    if (!Number.isFinite(t)) return NaN;
    const iso = new Date(t).toISOString();
    const readbackOk = iso.slice(0, 10) === v.slice(0, 10) && iso.slice(11, 19) === v.slice(11, 19);
    return readbackOk ? t : NaN;
}
const nonEmpty = (v) => v !== null && v !== undefined && v !== '';

/**
 * 方案 §4.4「徽章状态读时计算」八行顺序表，按顺序取第一个成立的。
 * 返回 { doc, reg, failure? }：doc / reg 为英文 code（见 LABEL / BADGE_LABELS），FDL_TASK / TABLE 两类为 null（不显示徽章）；
 * verify_failed 时 failure = { at: last_attempt_at, error: last_error }（失败时间与悬停错误）。
 * now：'YYYY-MM-DD HH:MM:SS' 公民时间字符串，缺省取本机时钟；测试里注入。
 */
function computeBadges(obj, now) {
    if (!obj || !SOURCE_TYPES.includes(obj.obj_type)) return { doc: null, reg: null };           // 1
    const nowText = now === undefined ? civilNow() : now;
    const hasVerified = nonEmpty(obj.verified_at);
    const hasError = nonEmpty(obj.last_error);
    if (!hasVerified && !hasError) return { doc: LABEL.UNVERIFIED, reg: LABEL.UNVERIFIED };      // 2
    // 3：last_error 非空 ⇒ 核验失败。成功落库必清空 last_error，所以 last_error 非空本身就说明最近一次是失败，
    //   不再比较 last_attempt_at 与 verified_at（秒级时间列同一秒内先成功后失败时，比较会漏判；自决项，见交付说明）
    if (hasError) {
        return { doc: LABEL.FAILED, reg: LABEL.FAILED, failure: { at: obj.last_attempt_at || null, error: obj.last_error } };
    }
    // 4：now - verified_at > 7 天（严格大于，方案原句）；任一时间无法解析（NaN）⇒ fail-closed 按 stale 处理
    const age = civilMs(nowText) - civilMs(obj.verified_at);
    if (!Number.isFinite(age) || age > STALE_MS) return { doc: LABEL.STALE, reg: LABEL.STALE };
    if (obj.prod_missing === 1) return { doc: LABEL.PROD_MISSING, reg: LABEL.PROD_MISSING };    // 5
    const side = (peer) => {
        if (!nonEmpty(peer)) return LABEL.UNREGISTERED;                                          // 6
        return obj.prod_hash === peer ? LABEL.CONSISTENT : LABEL.INCONSISTENT;                   // 7 / 8
    };
    return { doc: side(obj.doc_hash), reg: side(obj.reg_hash) };
}

module.exports = {
    createSqlServerDefinitionReader, createImplVerify, computeBadges, civilNow, cleanError, classifyError, ERROR_KINDS,
    SQL: { SQL_READ_BY_SCHEMA, SQL_READ_DB_TRIGGER, SQL_WRITE_OK, SQL_WRITE_MISSING, SQL_WRITE_FAILURE },
    LABEL, BADGE_LABELS, SOURCE_TYPES, STALE_MS, STOP_WAIT_MS,
};
