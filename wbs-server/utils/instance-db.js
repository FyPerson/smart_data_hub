/**
 * 库内实例身份（#106 多线并行改造 · S1a · W1「库内身份绑定」）
 *
 * 隔离用的库（线库、测试临时库）在创建时写入单例表 _sdh_instance：
 *   id INTEGER PRIMARY KEY CHECK (id = 1) —— 固定一行；
 *   instance_id / created_at / source 三列非空，source 为 JSON {"parent":…,"from":…}。
 * 隔离模式启动时，先以只读方式打开库核对这张表（表在、恰好一行、字段非空、instance_id = 运行身份），通过后才允许 initTable
 * 与各模块初始化写入。线的服务因此打不开主工作区或别的线的库。正常模式不读这张表。
 *
 * 导出（隔离库的**唯一公开入口是 createIsolatedDb**；不再公开导出 writeInstanceIdentity，它只在 _internal 上供测试夹具使用）：
 *   checkInstanceIdentity(dbPath, { expectedInstance, expectedParent })   只读核对，返回 { ok, code, message }
 *   checkInstanceIdentitySync(dbPath, opts)                        server.js 启动期用：子进程跑 instance-db-check.js，同步拿结果
 *   createIsolatedDb({ sourceDbPath, targetDbPath, instanceId, parent, from, sourceEncryptionKey })   （S1b / S2-0）VACUUM INTO 拍快照到一个原先不存在的目标，再同一事务：身份 + 隔离键加密的虚拟钉钉凭证 + 非钉钉配置白名单重写 + 清外部库口令（W2 / W3 建库的唯一入口）
 *   ISOLATED_CONFIG_WHITELIST   （S2-0）非钉钉 system_configs 白名单（7 键 → 值形态校验）；verify-instance-config-keys 守卫据此核对代码读取的键集合
 *
 * sqlite3 是异步 API，而 server.js 的 db 是模块级常量；所以启动期用子进程同步核对，不改 server.js 的建库结构。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { execFileSync } = require('child_process');
const sqlite3 = require('sqlite3');
const { ISOLATED_ENCRYPTION_KEY, encryptWithKey, decryptWithKey } = require('./aes-password');

const TABLE = '_sdh_instance';

function openDb(file, mode) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(file, mode, (err) => (err ? reject(err) : resolve(db)));
    });
}
function runSql(db, sql, params) {
    return new Promise((resolve, reject) => db.run(sql, params || [], function onRun(err) { return err ? reject(err) : resolve(this); }));
}
function allSql(db, sql, params) {
    return new Promise((resolve, reject) => db.all(sql, params || [], (err, rows) => (err ? reject(err) : resolve(rows))));
}
function closeDb(db) {
    return new Promise((resolve) => db.close(() => resolve()));
}

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * 写入（替换）库内身份。同一事务里：建表（若无）→ 删旧行 → 插入一行。库文件不存在时由 sqlite 创建。
 * 已经是隔离库（带旧身份）时是「替换」不是「追加」。仅经 _internal 暴露（测试夹具造“有身份的库”用）；生产路径一律走 createIsolatedDb（它在隔离化事务里调用 replaceIdentityRow）。
 */
async function writeInstanceIdentity(dbPath, { instanceId, parent, from } = {}) {
    if (!isNonEmptyString(dbPath)) throw new Error('writeInstanceIdentity：缺少 dbPath');
    if (!isNonEmptyString(instanceId)) throw new Error('writeInstanceIdentity：instanceId 必须是非空字符串');
    if (!isNonEmptyString(parent)) throw new Error('writeInstanceIdentity：parent（父检出身份，主工作区记 main）必须是非空字符串');
    const db = await openDb(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);
    try {
        await runSql(db, 'PRAGMA busy_timeout = 5000');
        await runSql(db, 'BEGIN IMMEDIATE');
        try {
            await replaceIdentityRow(db, { instanceId, parent, from });
            await runSql(db, 'COMMIT');
        } catch (e) {
            try { await runSql(db, 'ROLLBACK'); } catch (_) { /* 事务可能已被 sqlite 自行回滚 */ }
            throw e;
        }
    } finally {
        await closeDb(db);
    }
}

/** 事务内：建表（若无）→ 删旧行 → 插入一行。_internal.writeInstanceIdentity 与 prepareIsolatedDb 共用，调用方负责 BEGIN / COMMIT。 */
async function replaceIdentityRow(db, { instanceId, parent, from }) {
    const source = JSON.stringify({ parent, from: from === undefined ? null : from });
    await runSql(db, `CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        instance_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        source TEXT NOT NULL
    )`);
    await runSql(db, `DELETE FROM ${TABLE}`);
    await runSql(db, `INSERT INTO ${TABLE} (id, instance_id, created_at, source) VALUES (1, ?, ?, ?)`,
        [instanceId, new Date().toISOString(), source]);
}

// ---- 隔离库准备（#106 S1b · 偏差 B1）----
// 虚拟钉钉凭证：用隔离专用键加密写进 system_configs，使业务层的「凭证已配置」前置校验照常通过、请求走到钉钉闸门（替身）。
//   值是故意写死的虚拟串（不是机密）；测试据此核对「脱敏后日志里搜不到它们」。
const VIRTUAL_DINGTALK_CONFIG = Object.freeze({
    dingtalk_app_key: 'sdh-stub-appkey',
    dingtalk_app_secret: 'sdh-stub-appsecret-not-a-real-secret',
    dingtalk_robot_code: 'sdh-stub-robotcode',
    platform_base_url: 'http://sdh-isolated.invalid',
});
// 与 server.js initTable 里 system_configs 的建表语句同一份（verify-instance-external 有守卫对拍）：库里还没有这张表时先建出来，避免虚拟凭证写不进去
const SYSTEM_CONFIGS_DDL = `CREATE TABLE IF NOT EXISTS system_configs (
            config_key TEXT PRIMARY KEY,
            config_value_encrypted TEXT,
            updated_by INTEGER,
            updated_by_name TEXT,
            updated_at DATETIME DEFAULT (datetime('now','localtime'))
        )`;

// ---- 非钉钉配置白名单（#106 S2-0 · W1 / W2「line new 步骤 5」）----
// 来源库（主工作区业务库）里的 system_configs 是真键密文，隔离实例用固定隔离键解不开。建库时：
//   钉钉四键 → 覆盖为虚拟值（从不解密）；下面 7 键 → 用来源键解密、过值形态校验、用隔离键重新加密写回（线服务行为与主工作区一致）；
//   其余一切键 → 删除（从不解密）。
// 7 键 = 代码（server.js / routes / utils）里 readSystemConfig 实际读取的全部非钉钉键；verify-instance-config-keys 守卫用 acorn 扫描源码，
// 要求「读取键集合 = 本白名单 ∪ VIRTUAL_DINGTALK_CONFIG 的键」，所以新增读取点必须同步登记到这里（并写明形态依据）。
// 形态校验的依据是消费方的解析代码：值不合法时消费方本来就回落默认，所以「删除该行」与「写回非法值」对线服务**行为**等价（都落到默认），
// 但**诊断输出**不同：主工作区的消费方会显示「配置项非法」或告警，线服务因为行已被删除只会显示「未配置」。
// 校验的作用是挡住「用错键解密、CBC 恰好通过填充校验而解出乱码」这类值被当成配置写回。
// 判定口径（S2-0 修复批 1 / 2）：每个键先按**消费方自己的规范化**（trim、逐项 trim、JSON.parse 允许的空白等）处理，再判定；口径 = 「消费方会把它当作已配置的合法值」或空值。
//   与消费方不等价的地方**恰好两处**，都是声明的差异：
//   ① 总长度上限 CONFIG_VALUE_MAX_LEN = 2048 个 UTF-16 码元（消费方没有上限）。理由：合法值不可能这么长（最长的 sys_single_commit_group_systems 也就百余字符），乱码检测需要一个上界。
//   ② 三个列表键（issue_lite_notify_target_ids / sys_release_default_executor_ids 两个编号逗号串，以及 sys_single_commit_group_systems 系统清单）：
//      任一项含 U+FFFD 或控制字符，则**整串删除**（编号逗号串的消费方会忽略不合法的编号项、保留其余项；系统清单的消费方不过滤字符，这里是额外加的内容限制，会删掉消费方原本保留的系统名）。理由：真实配置不会含这类字符，它是错键解出乱码的特征，宁可整串丢弃也不把半截乱码写回。
//      开关键与整数键没有“只违反控制字符”的值（开关只能是 on / off / 空，整数只能是十进制 / 十六进制数字串，带控制字符的值本来就违反各自的形态），所以不存在对应的差异。
//   两个编号逗号串键其余部分与消费方一致：逐项 trim、过滤空项后，**至少一项是合法编号即接受**（原串原样改写，非法编号项由消费方自己照旧忽略）；
//   一项合法编号都没有的非空串，消费方会回落默认，这里按 invalid_shape 删除。系统清单不限字符集（消费方没有限制），只做内容单元检查。
// 内容检查只有两类（U+FFFD——utf8 解码遇到非法字节的替换符，乱码的典型特征；规范化之后仍存在的控制字符 C0 / DEL / C1），在规范化**之后**、对消费方真正当作内容的单元做（unitOk）：
//   首尾空白被消费方 trim 掉，所以 'on\n'、'\t42' 合法；逗号串逐项 trim 之后检查每一项；JSON 数组只检查解码后的各元素（数组里的换行缩进是 JSON 空白，合法）。
// 说明（日志口径）：server.js 顶部有全局 sqlite3.verbose()，写库出错时 stack 会带上 SQL 参数；本模块写进 SQL 参数的只有「隔离键加密后的密文」（按设计非机密）和行号，
//   来源键与解出的明文从不进 SQL 参数；错误包装不改。
const CONFIG_VALUE_MAX_LEN = 2048;
const CONFIG_CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/;
const REPLACEMENT_CHAR = String.fromCharCode(0xFFFD);
function commonConfigShapeOk(v) {
    return typeof v === 'string' && v.length <= CONFIG_VALUE_MAX_LEN;
}
/** 规范化之后的内容单元：不含 U+FFFD、不含控制字符。 */
const unitOk = (s) => typeof s === 'string' && !s.includes(REPLACEMENT_CHAR) && !CONFIG_CONTROL_CHARS_RE.test(s);
const isPositiveSafeInt = (s) => { const n = Number(s); return Number.isSafeInteger(n) && n > 0; };
/** 开关值：消费方 trim + 小写；合法 = on / off / 空（空 = 未配置）。其他写法（y / true / onn）消费方一律按「关 / 真发」处理，等同于没配置。 */
const switchShapeOk = (v) => { const t = v.trim().toLowerCase(); return unitOk(t) && ['on', 'off', ''].includes(t); };
/** 单个正整数（users.id）：消费方 toInt——空（trim 后）→ 默认；否则 Number(v) 为 > 0 的安全整数才采用。Number() 自己会去首尾空白，与 trim 同一空白集。 */
const positiveIntShapeOk = (v) => { const t = v.trim(); return t === '' || (unitOk(t) && isPositiveSafeInt(t)); };
/**
 * users.id 逗号串：消费方按 ',' 拆、逐项 trim；空项被过滤（executor_ids 用 filter(Boolean)，target_ids 里 Number('') = 0 被过滤）；非法项被忽略，合法项保留。
 * 合法 = 空，或「各项都过 unitOk、且至少一项是 > 0 的安全整数」。无项数上限（消费方没有）。例：'10,abc' / '23,0' 合法（消费方取 10 / 23）；'abc' / '0' / ',' 非法（消费方回落默认）。
 */
const idListTokens = (v) => v.split(',').map((s) => s.trim()).filter((s) => s !== '');
const idListShapeOk = (v) => {
    if (v.trim() === '') return true;
    const tokens = idListTokens(v);
    return tokens.every(unitOk) && tokens.some(isPositiveSafeInt);
};
/**
 * 单组版本号系统清单：消费方 loadSingleCommitGroupSystemSet 的规范化与判定——trim；空 → 默认；JSON.parse 成功 → 须是「每个元素都是 trim 后非空的字符串」的数组，否则当空（回落默认）；
 * parse 失败且以 [ 或 { 开头 → 回落默认；其余按 ',' 拆、逐项 trim、过滤空项。系统名在消费方没有字符集限制，所以这里也不限制，只做 unitOk（乱码 / 控制字符）。
 */
const systemListShapeOk = (v) => {
    const t = v.trim();
    if (t === '') return true;
    let parsed;
    let parseOk = false;
    try { parsed = JSON.parse(t); parseOk = true; } catch (_) { parseOk = false; }
    if (parseOk) {
        return Array.isArray(parsed) && parsed.every((x) => typeof x === 'string' && x.trim() !== '' && unitOk(x.trim()));
    }
    if (t[0] === '[' || t[0] === '{') return false;
    return idListTokens(t).every(unitOk);
};
/**
 * 内容单元：消费方规范化之后真正当作内容的片段，供“干净解密”判定用（只看有没有 U+FFFD / 控制字符，不看形态）。
 *   开关 / 整数 = trim 后整串；编号逗号串 = 逐项 trim 且过滤空项；系统清单 = JSON 数组的各字符串元素（trim）/ 逗号串各项 / 不可解析的 [ 或 { 开头串整体；其他 JSON 值没有内容单元。
 */
const wholeTrimmedUnits = (v) => [v.trim()];
const systemListUnits = (v) => {
    const t = v.trim();
    if (t === '') return [];
    let parsed;
    try { parsed = JSON.parse(t); } catch (_) { return (t[0] === '[' || t[0] === '{') ? [t] : idListTokens(t); }
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string').map((x) => x.trim()) : [];
};
const ISOLATED_CONFIG_WHITELIST = Object.freeze({
    // consumer: server.js:11404 isNotifyAdminOnSubmitEnabled（trim + 小写 === 'on' 才开）；writer: 无代码写入点，运维手工写库（server.js:11400 注释）
    collab_notify_admin_on_submit: Object.freeze({ shape: 'on | off | 空', accepts: switchShapeOk, units: wholeTrimmedUnits }),
    // consumer: server.js:14217-14223 getIssueLiteIdentities.toInt（空 → 默认；Number(v) 为 > 0 安全整数才采用）；writer: 无代码写入点，手工写库
    issue_lite_developer_id: Object.freeze({ shape: '空 | 正整数（users.id）', accepts: positiveIntShapeOk, units: wholeTrimmedUnits }),
    issue_lite_chat_owner_id: Object.freeze({ shape: '空 | 正整数（users.id）', accepts: positiveIntShapeOk, units: wholeTrimmedUnits }),
    // consumer: server.js:14224-14229（逗号拆分，逐项 Number 取 > 0 安全整数，一项都没有则回落默认）；writer: 无代码写入点，手工写库
    issue_lite_notify_target_ids: Object.freeze({ shape: '空 | users.id 逗号串', accepts: idListShapeOk, units: idListTokens }),
    // consumer: routes/sys-iteration/index.js:18798-18803、:21578-21587（trim + 小写，on 才演练；非 on/off/空只告警）；writer: scripts/_set-sys-notify-dry-run.js:53,57-66（写 trim + 小写后的 on/off；本地脚本，未入库——.gitignore:131 忽略）
    sys_notify_dry_run: Object.freeze({ shape: 'on | off | 空', accepts: switchShapeOk, units: wholeTrimmedUnits }),
    // consumer: routes/sys-iteration/index.js:17448-17476（逗号拆分，逐项须为 > 0 安全整数，非法项只进 skipped_defaults）；writer: 无代码写入点，部署日手工写库（index.js:17446-17447 注释）
    sys_release_default_executor_ids: Object.freeze({ shape: '空 | users.id 逗号串', accepts: idListShapeOk, units: idListTokens }),
    // consumer: routes/sys-iteration/index.js:10351-10387 loadSingleCommitGroupSystemSet（经常量 SINGLE_COMMIT_GROUP_CONFIG_KEY，:10323 声明、:10353 读取）；writer: scripts/_set-sys-single-commit-group.js:96,146,188-197（逗号串；该脚本已入库）
    sys_single_commit_group_systems: Object.freeze({ shape: '空 | 逗号串系统名 | JSON 字符串数组', accepts: systemListShapeOk, units: systemListUnits }),
});
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
/** 白名单键的明文是否合法：通用前置 + 该键自己的形态。 */
function whitelistedValueOk(key, plain) {
    return commonConfigShapeOk(plain) && ISOLATED_CONFIG_WHITELIST[key].accepts(plain);
}
/**
 * 「干净解密」：解密未抛错，且明文按该键规范化后的每个内容单元都不含 U+FFFD 与控制字符。只看内容、不看形态与长度——
 * 键对时，哪怕值手误成了 'yes' 或 'abc'，解出的仍是干净文本；键错时，解出的几乎总是乱码（含 U+FFFD / 控制字符）或根本解不开。SOURCE_KEY_MISMATCH 据此判键错。
 */
function isCleanDecrypt(key, plain) {
    return typeof plain === 'string' && ISOLATED_CONFIG_WHITELIST[key].units(plain).every(unitOk);
}
// 解密函数钩子：默认就是 decryptWithKey；仅 _internal.setDecryptHookForTest 可换（测试据此记录“哪些键被解密过”、注入乱码）。
//   结构上只有 sanitizeSystemConfigs 的白名单分支调用它——钉钉四键与非白名单键在走到解密之前就已分流。
let decryptConfigValue = decryptWithKey;

/**
 * 事务内（调用方负责 BEGIN / COMMIT）：对 system_configs 的每一行做白名单处理。
 *   钉钉四键       → 跳过（由调用方随后用虚拟值 upsert 覆盖），从不解密；
 *   白名单 7 键    → 有解密键时解密 → 通用 + 形态校验通过 → 用隔离键重新加密，只 UPDATE 密文列（其余列保持）；NULL / 解密抛错 / 校验不过 / 没有解密键 → 删除该行；
 *   其他一切键     → 删除该行，从不解密。
 * 行用 rowid 定位（config_key 是 TEXT 主键，可为 NULL / 奇怪值；键比较一律 hasOwnProperty，防 constructor / __proto__ 之类原型链上的名字被当成白名单）。
 * 返回值里只有键名与固定枚举的原因，没有明文、没有任何密钥。
 * @returns {Promise<{ rewritten: string[], dropped: Array<{ key: string, reason: string }>, nonNullWhitelist: number, cleanDecrypts: number, undecryptable: number, dirty: number }>}
 *   nonNullWhitelist：来源里「白名单键且密文非 NULL / 非空」的行数；
 *   cleanDecrypts：其中「干净解密」的行数（解密未抛错，且明文按该键规范化后不含 U+FFFD 与控制字符，见 isCleanDecrypt；与形态是否合法无关）——调用方据此判断“给了键却一行都解不干净”= 键错；
 *   undecryptable / dirty：没能干净解密的两类各多少行（解密抛错 / 解出乱码或含控制字符），只用于错误消息里的计数。
 */
async function sanitizeSystemConfigs(db, decryptKey) {
    const rows = await allSql(db, 'SELECT rowid AS rid, config_key, config_value_encrypted FROM system_configs');
    const rewritten = [];
    const dropped = [];
    let nonNullWhitelist = 0;
    let cleanDecrypts = 0;
    let undecryptable = 0;
    let dirty = 0;
    const dropRow = async (rid, key, reason) => {
        await runSql(db, 'DELETE FROM system_configs WHERE rowid = ?', [rid]);
        dropped.push({ key: String(key), reason });
    };
    for (const row of rows) {
        const key = row.config_key;
        if (typeof key === 'string' && hasOwn(VIRTUAL_DINGTALK_CONFIG, key)) continue;
        if (typeof key !== 'string' || !hasOwn(ISOLATED_CONFIG_WHITELIST, key)) { await dropRow(row.rid, key, 'not_whitelisted'); continue; }
        const cipher = row.config_value_encrypted;
        if (!cipher) { await dropRow(row.rid, key, 'null_value'); continue; }
        nonNullWhitelist += 1;
        if (decryptKey === null) { await dropRow(row.rid, key, 'no_source_key'); continue; }
        let plain;
        try { plain = decryptConfigValue(decryptKey, cipher, key); } catch (_) { undecryptable += 1; await dropRow(row.rid, key, 'undecryptable'); continue; }
        if (isCleanDecrypt(key, plain)) cleanDecrypts += 1; else dirty += 1;
        if (!whitelistedValueOk(key, plain)) { await dropRow(row.rid, key, 'invalid_shape'); continue; }
        await runSql(db, 'UPDATE system_configs SET config_value_encrypted = ? WHERE rowid = ?', [encryptWithKey(ISOLATED_ENCRYPTION_KEY, plain), row.rid]);
        rewritten.push(key);
    }
    rewritten.sort();
    dropped.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0)));
    return { rewritten, dropped, nonNullWhitelist, cleanDecrypts, undecryptable, dirty };
}

// 路径真实化：已存在的部分走 realpath（解开符号链接 / junction），尚不存在的尾部原样接回；win32 比较时大小写折叠（fold）。
function realOf(p) {
    const abs = path.resolve(p);
    const tail = [];
    let cur = abs;
    for (;;) {
        try {
            const real = fs.realpathSync(cur);
            return tail.length ? path.join(real, ...tail.reverse()) : real;
        } catch (_) {
            const up = path.dirname(cur);
            if (up === cur) return abs;   // 到盘符根仍解析不了：按 path.resolve 的结果
            tail.push(path.basename(cur));
            cur = up;
        }
    }
}
const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

/**
 * 防呆（卫生检查）：不在「某个检出的 wbs-server 目录（含 server.js 与 package.json）里、且该检出没有 .sdh-instance」建隔离库——
 * 主工作区 / 生产检出下的任何位置（task_pool.db、task_pool.db.backup_*、任意子目录）都在此列。
 * 看的是「目标所在位置」，与调用方模块自己躺在哪个检出里无关；**两组祖先链都查**：
 *   ① path.resolve(目标) 的原样路径祖先（即使目录是 junction / 符号链接指到检出之外，原样路径里的检出目录也会命中）；
 *   ② realOf(目标) 的真实路径祖先（原样路径看不出、但真实位置在检出里的情形）。
 * 任一级目录含 server.js 与 package.json 且没有 .sdh-instance 即拒绝。另保留「本模块所在检出的 task_pool.db」比对（冗余但无害）。
 * 注意：这只是卫生检查，防「业务库被覆盖」的主防线是 createIsolatedDb 的「目标必须原先不存在」。必须在创建任何文件之前调用。
 */
function assertNotBusinessDb(dbPath) {
    const wbsDir = path.resolve(__dirname, '..');
    const rawTarget = path.resolve(dbPath);
    const realTarget = realOf(dbPath);
    const isBusiness = fold(realTarget) === fold(realOf(path.join(wbsDir, 'task_pool.db')));
    if (isBusiness && !fs.existsSync(path.join(wbsDir, '.sdh-instance'))) {
        throw new Error(`createIsolatedDb：拒绝对本检出（无 .sdh-instance，即主工作区 / 生产形态）的业务库 ${dbPath} 执行`);
    }
    for (const [label, start] of [['原样路径', rawTarget], ['真实路径', realTarget]]) {
        let dir = path.dirname(start);
        for (;;) {
            if (fs.existsSync(path.join(dir, 'server.js')) && fs.existsSync(path.join(dir, 'package.json')) && !fs.existsSync(path.join(dir, '.sdh-instance'))) {
                throw new Error(`createIsolatedDb：拒绝在 ${dbPath} 建库——其${label}位于检出目录 ${dir} 之内（该目录含 server.js 与 package.json、没有 .sdh-instance，即主工作区 / 生产形态）`);
            }
            const up = path.dirname(dir);
            if (up === dir) break;
            dir = up;
        }
    }
}

/**
 * 【模块内部函数，不对外导出（仅 _internal 供测试）】在一个「由 createIsolatedDb 刚创建的独立副本」上做隔离化：同一事务里
 *   ⓪ 决定解密键（见下）；
 *   ① 写 / 替换 _sdh_instance（身份）；
 *   ② system_configs 逐行处理（sanitizeSystemConfigs）：钉钉四键不解密、随后用隔离专用键加密的虚拟值覆盖；白名单 7 键（ISOLATED_CONFIG_WHITELIST）
 *      用解密键解开、过形态校验、用隔离键重新加密写回；其余一切键删除、从不解密。存储格式与 server.js writeSystemConfig 一致；
 *   ③ 清空 db_connections 的口令列（password NOT NULL，故置空串；空串解密必抛错，外部库口令因此不可能被误解出；外部库口令从不解密）。
 * 解密键：快照里有 _sdh_instance 表（来源本身是隔离库）→ 先校验身份行（恰好一行、id = 1、三个必填字段非空，不合法抛 code = 'SOURCE_IDENTITY_INVALID'，无目标、临时目录清干净）→ 隔离键，
 *   此时若传了字符串 sourceEncryptionKey → 事务回滚并抛 code = 'SOURCE_KEY_UNEXPECTED'（undefined / null 都用隔离键）；
 *   **残余**：经 _internal.writeInstanceIdentity 或手工 SQL 造出的「有合法身份行、但并未隔离化」的库，会被当作隔离库——它的白名单配置是真键密文，用隔离键解不开，
 *   所以会按 undecryptable / invalid_shape 被删除（不泄漏，只是丢配置）；
 *   来源不是隔离库 → sourceEncryptionKey 必须显式：非空字符串（用它解密）或 null（明确表示不解，白名单行按 no_source_key 删除）；undefined（含属性缺失）抛 code = 'SOURCE_KEY_REQUIRED'。
 *   键错检测：传了字符串键、来源里至少有 1 个值非 NULL 的白名单行、而「干净解密」的行数为 0 → 抛 code = 'SOURCE_KEY_MISMATCH'（整体回滚；消息只列各原因的行数，不含键与明文，并提示确认键正确时可显式传 null 放弃这些配置）。
 *   干净解密 = 解密未抛错，且明文按该键规范化后不含 U+FFFD 与控制字符（与形态是否合法无关）；只要有 1 行干净解密就认定键正确，形态不合法的行照常按 invalid_shape 删除。
 *   已知的无法区分的情形：来源里**唯一**一行非空白名单配置是轮换前的旧键加密的（用现键解不开）——与键错表现一样，同样抛 SOURCE_KEY_MISMATCH；确认键没错、只想放弃这行配置时显式传 null。
 *   正确键下同样会抛的另外两种情形（真实数据里不会出现）：来源里所有非空白名单行在规范化后内容都含控制字符或 U+FFFD；密文列里存的不是密文。
 * system_configs 不存在时先建表；db_connections 不存在时跳过（没有口令可清）。任一步失败整体回滚。
 * 来源键只在本函数作用域里流转，不挂到返回值、错误对象或模块级对象上；返回值与错误消息里没有配置明文，也没有来源键。
 * 注意这不是安全边界本身：真实凭证靠 dingtalk 闸门与 EXTERNAL_DISABLED 挡住，这里是第二道。
 *
 * 调用约束与保证范围：
 *   - 只能对「本模块刚创建、未被其他连接使用的独立副本」调用（目标由 createIsolatedDb 保证原先不存在、并核对过不是链接）；本函数自己不做路径防呆；
 *   - 保证的是：库内逻辑清空 + 库文件内被覆盖页不留旧内容（secure_delete = ON）；若库是 WAL 模式，提交后再做 wal_checkpoint(TRUNCATE) 并要求 busy = 0，否则抛错。
 *     不保证：文件系统层的残留（已删除的回滚日志文件、复制过程留下的伴随文件、磁盘上已释放的旧块）——那些不在本函数的范围内。
 *   - 不核对「目标里已有身份」：测试实例从线库派生时合法地把线身份替换成 test- 身份，强制核对会误拒。
 * @returns {Promise<{ dbConnectionsCleared: number, configKeys: string[], configRewritten: string[], configDropped: Array<{ key: string, reason: string }> }>}
 *   configRewritten：被改写（来源键解密 → 隔离键重新加密）的白名单键，排序；
 *   configDropped：被删除的行，按键排序，reason 固定枚举：not_whitelisted（不在白名单且不是钉钉四键）/ null_value（白名单键但密文为 NULL 或空）/
 *   no_source_key（没有解密键）/ undecryptable（解密抛错）/ invalid_shape（解出的明文没过通用或形态校验）。钉钉四键被虚拟值覆盖，不出现在两个数组里（见 configKeys）。
 */
async function prepareIsolatedDb(dbPath, { instanceId, parent, from, sourceEncryptionKey } = {}) {
    if (!isNonEmptyString(dbPath)) throw new Error('prepareIsolatedDb：缺少 dbPath');
    if (!isNonEmptyString(instanceId)) throw new Error('prepareIsolatedDb：instanceId 必须是非空字符串');
    if (!isNonEmptyString(parent)) throw new Error('prepareIsolatedDb：parent（父检出身份，主工作区记 main）必须是非空字符串');
    if (sourceEncryptionKey !== undefined && sourceEncryptionKey !== null && (typeof sourceEncryptionKey !== 'string' || sourceEncryptionKey === '')) throw new Error('prepareIsolatedDb：sourceEncryptionKey 只能是非空字符串、null 或 undefined');
    // 以读写方式打开、不带 OPEN_CREATE：目标是 createIsolatedDb 刚 VACUUM INTO 出来的文件，必然已存在；传了不存在的路径应报错，而不是悄悄建出一个空库
    const db = await openDb(dbPath, sqlite3.OPEN_READWRITE);
    try {
        await runSql(db, 'PRAGMA busy_timeout = 5000');
        await runSql(db, 'PRAGMA secure_delete = ON');   // 被覆盖 / 清空的页不在库文件内留旧内容（保证口径见函数头注释）
        await runSql(db, 'BEGIN IMMEDIATE');
        let result;
        try {
            // ⓪ 解密键必须在 replaceIdentityRow 之前决定：那一步会（重新）建出 _sdh_instance，之后就分不清来源是不是隔离库了
            const isolatedSource = (await allSql(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? COLLATE NOCASE", [TABLE])).length === 1;
            if (isolatedSource) {
                // 有身份表就必须是一张**合法**的身份表（恰好一行、id = 1、三个必填字段非空）——复用 evaluateIdentityRows；表结构不兼容（读不出这些列）同样按非法处理。
                let idRows = null;
                try { idRows = await allSql(db, `SELECT id, instance_id, created_at, source FROM ${TABLE}`); } catch (_) { idRows = null; }
                const verdict = idRows === null
                    ? { ok: false, message: `${TABLE} 表结构不兼容（读不出 id / instance_id / created_at / source）` }
                    : evaluateIdentityRows(1, idRows, { expectedInstance: idRows.length === 1 ? idRows[0].instance_id : undefined });
                if (!verdict.ok) {
                    const e = new Error(`createIsolatedDb：来源带 ${TABLE} 表，但身份行不合法（${verdict.message}），拒绝把它当作隔离库`);
                    e.code = 'SOURCE_IDENTITY_INVALID';
                    throw e;
                }
            }
            if (isolatedSource && typeof sourceEncryptionKey === 'string') {
                const e = new Error('createIsolatedDb：来源已是隔离库（带 _sdh_instance 身份表），其配置用隔离键加密——不得再传 sourceEncryptionKey');
                e.code = 'SOURCE_KEY_UNEXPECTED';
                throw e;
            }
            if (!isolatedSource && sourceEncryptionKey === undefined) {
                const e = new Error('createIsolatedDb：来源不是隔离库，sourceEncryptionKey 必须显式传入（非空字符串，或 null 表示不解密、白名单配置全部丢弃）');
                e.code = 'SOURCE_KEY_REQUIRED';
                throw e;
            }
            const decryptKey = isolatedSource ? ISOLATED_ENCRYPTION_KEY : sourceEncryptionKey;
            await replaceIdentityRow(db, { instanceId, parent, from });
            await runSql(db, SYSTEM_CONFIGS_DDL);
            const cfg = await sanitizeSystemConfigs(db, decryptKey);
            if (typeof sourceEncryptionKey === 'string' && !isolatedSource && cfg.nonNullWhitelist > 0 && cfg.cleanDecrypts === 0) {
                const e = new Error(`createIsolatedDb：传入的来源键没能干净解密任何一行白名单配置（来源里有 ${cfg.nonNullWhitelist} 行非空的白名单配置：解密失败 ${cfg.undecryptable} 行，解出乱码或含控制字符 ${cfg.dirty} 行），疑似来源键不对（或这些配置是轮换前的旧键加密的）；已整体回滚。确认键正确、只是想放弃这些配置时，请显式传 null`);
                e.code = 'SOURCE_KEY_MISMATCH';
                throw e;
            }
            const keys = Object.keys(VIRTUAL_DINGTALK_CONFIG);
            for (const key of keys) {
                await runSql(db,
                    `INSERT INTO system_configs (config_key, config_value_encrypted, updated_by, updated_by_name, updated_at)
                     VALUES (?, ?, ?, ?, datetime('now','localtime'))
                     ON CONFLICT(config_key) DO UPDATE SET
                       config_value_encrypted = excluded.config_value_encrypted,
                       updated_by = excluded.updated_by,
                       updated_by_name = excluded.updated_by_name,
                       updated_at = excluded.updated_at`,
                    [key, encryptWithKey(ISOLATED_ENCRYPTION_KEY, VIRTUAL_DINGTALK_CONFIG[key]), null, 'sdh-isolated']);
            }
            let cleared = 0;
            const hasConn = await allSql(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'db_connections'");
            if (hasConn.length === 1) {
                const r = await runSql(db, "UPDATE db_connections SET password = ''");
                cleared = r.changes;
            }
            await runSql(db, 'COMMIT');
            result = { dbConnectionsCleared: cleared, configKeys: keys, configRewritten: cfg.rewritten, configDropped: cfg.dropped };
        } catch (e) {
            try { await runSql(db, 'ROLLBACK'); } catch (_) { /* 事务可能已被 sqlite 自行回滚 */ }
            throw e;
        }
        // 提交之后：WAL 模式的库，被清空的旧内容可能还躺在 -wal 里；做一次 TRUNCATE 检查点并要求没有被占用（busy = 0），否则抛错（调用方据此丢弃这个库）
        // 当前唯一入口（createIsolatedDb）走不到这个分支——VACUUM INTO 的产物恒为回滚日志模式；保留作纵深防御，测试在 _internal 上覆盖。
        const jm = await allSql(db, 'PRAGMA journal_mode');
        if (jm.length === 1 && String(jm[0].journal_mode).toLowerCase() === 'wal') {
            const cp = await allSql(db, 'PRAGMA wal_checkpoint(TRUNCATE)');
            if (cp.length !== 1 || cp[0].busy !== 0) {
                throw new Error(`prepareIsolatedDb：WAL 检查点未完成（${JSON.stringify(cp)}）：库正被其他连接使用，被清空的旧内容可能还留在 -wal 里，请丢弃该库并在独立副本上重做`);
            }
        }
        return result;
    } finally {
        await closeDb(db);
    }
}

const SIDE_SUFFIXES = ['', '-journal', '-wal', '-shm'];

/** 目标及其三个伴随路径里第一个已存在的（lstat，不跟随链接）；都不存在返回 null。ENOENT 以外的错误照抛。 */
function firstExistingOf(targetDbPath) {
    for (const s of SIDE_SUFFIXES) {
        try { fs.lstatSync(targetDbPath + s); return targetDbPath + s; } catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
    }
    return null;
}
// ---- 逐项删除辅助（F9）：**不得使用 fs.rmSync**——Node v24.11.1 上 fs.rmSync 对含中文的路径既不报错也不删除（主会话已复现）。
//   做法：unlinkSync / rmdirSync，删后 lstat 确认路径已不存在，仍在的收集为残留返回，由调用方写进错误消息。
function pathGone(p) {
    try { fs.lstatSync(p); return false; } catch (e) { return !!(e && e.code === 'ENOENT'); }
}
/** 删单个文件；ENOENT 视为已不存在。返回仍存在的路径数组（空数组 = 已删净）。 */
function removeFileChecked(p) {
    try { fs.unlinkSync(p); } catch (_) { /* 是否真的删掉，以下面的 lstat 为准 */ }
    return pathGone(p) ? [] : [p];
}
/** 删本次 mkdtemp 创建的临时目录：里面只会有文件，逐项 unlink 再 rmdir；遇到子目录不递归，列为残留。返回残留路径数组。 */
function removeTempDirChecked(dir) {
    const left = [];
    let names = null;
    try { names = fs.readdirSync(dir); } catch (e) { return pathGone(dir) ? [] : [dir]; }
    for (const n of names) {
        const p = path.join(dir, n);
        let st = null;
        try { st = fs.lstatSync(p); } catch (_) { /* 下面按残留处理 */ }
        if (!st || st.isDirectory()) { left.push(p); continue; }
        left.push(...removeFileChecked(p));
    }
    try { fs.rmdirSync(dir); } catch (_) { /* 以 lstat 为准 */ }
    if (!pathGone(dir)) left.push(dir);
    return left;
}
function targetExistsError(p, targetDbPath) {
    const err = new Error(`createIsolatedDb：${p === targetDbPath ? '目标' : '目标的伴随路径'} ${p} 已存在（空文件 / 符号链接 / 硬链接 / 目录一律拒绝，目标及其 -journal / -wal / -shm 必须原先都不存在）`);
    err.code = 'TARGET_EXISTS';
    return err;
}

/**
 * 创建隔离库（W2 建线库 / W3 派生测试库的唯一入口）：从来源库用 VACUUM INTO 拍一份快照，在这份新文件上做隔离化
 * （同一事务写身份 / 虚拟钉钉配置 / 清外部库口令，见内部函数 prepareIsolatedDb），最后原子地发布到目标路径。
 * 结构上取消了「对一个任意已有文件就地清口令」：目标及其 -journal / -wal / -shm 必须原先都不存在（lstat；空文件、符号链接、硬链接、目录一律拒绝，
 * code = 'TARGET_EXISTS'），所以目标不可能是业务库或其任何别名。来源只以 OPEN_READONLY 打开，VACUUM INTO 不改来源主文件；
 * 来源为 WAL 模式时，只读连接执行 VACUUM INTO 可能在来源旁生成 -wal / -shm（业务库是回滚日志模式，不涉及）。
 * 来源旁有未回滚的 -journal（上次异常退出）时 VACUUM INTO 报 SQLITE_READONLY，本函数包装成 code = 'SOURCE_HOT_JOURNAL' 的可操作提示
 * （提示要求：用读写连接打开来源库、执行一次读取后关闭再重试——只开关连接不保证触发热日志恢复）。
 * 非钉钉配置（#106 S2-0）：快照里的 system_configs 是来源库真键的密文。同一隔离化事务里，钉钉四键覆盖为虚拟值（从不解密）；白名单 7 键
 * （ISOLATED_CONFIG_WHITELIST）用解密键解开、过形态校验、用隔离键重新加密写回；其余一切键删除（从不解密）；外部库口令（db_connections.password）从不解密、只清空。
 * 解密键规则：快照里有 _sdh_instance 表（来源是隔离库，如从线库派生测试库；先校验身份行，不合法 → code = 'SOURCE_IDENTITY_INVALID'）→ 隔离键，此时传了字符串 sourceEncryptionKey 一律拒绝
 * （code = 'SOURCE_KEY_UNEXPECTED'，不生成目标、临时目录清干净；undefined / null 均可）；来源不是隔离库 → sourceEncryptionKey **必须显式**：非空字符串（用它解密），
 * 或 null（明确表示不解密，白名单行按 no_source_key 全部删除）；undefined（含属性缺失）→ code = 'SOURCE_KEY_REQUIRED'；其他类型 / 空串 → 参数错误。
 * 传了字符串键、来源里至少有 1 个值非 NULL 的白名单行、却一行都没能干净解密（解密抛错 / 解出乱码或含控制字符；形态不合法但文本干净的算干净）→ code = 'SOURCE_KEY_MISMATCH'（整体回滚、无目标、无残留；消息列各原因的行数）。
 * 返回值 configRewritten / configDropped 只有键名与固定枚举的原因；返回值、错误消息、日志里没有配置明文，也没有来源键
 * （来源键只在函数作用域里传递，不挂到返回值、错误对象或模块级对象上）。
 * 清理里**不使用 fs.rmSync**（Node v24.11.1 上它对含中文的路径既不报错也不删除），一律逐项 unlinkSync / rmdirSync 并用 lstat 确认。
 * 步骤：参数校验 → assertNotBusinessDb（卫生检查）→ lstat 目标与三个伴随路径（任一存在即拒绝，**不进入任何清理分支**）→ 目标目录须已存在（不代建）→
 *       来源须是普通文件 → 在目标所在目录下 mkdtemp 一个独占临时目录（同目录 = 同卷）→ 只读打开来源，VACUUM INTO ? 到临时目录里的文件 →
 *       核对生成物是普通文件、非链接、nlink === 1 → 隔离化（临时目录里不得残留 -journal / -wal / -shm）→ 发布前再 lstat 一次目标及三个伴随路径 →
 *       fs.linkSync(临时文件, 目标)（目标已存在则失败、不覆盖；刻意不用 rename，rename 在 Windows 与 POSIX 上都可能覆盖已有文件）→ 删临时文件与临时目录 → 核对目标 nlink === 1。
 * 清理归属（07-R2 H1）：失败清理**只删本次 mkdtemp 独占创建的临时目录**，绝不按路径删目标或其伴随路径——那些路径在本函数里从来不是“本次创建”的，
 * 按“检查时不存在”推断归属会误删（例如来源库恰好叫「目标-shm」）。唯一例外在发布成功之后：link 成功即证明 targetDbPath 是本次创建的，
 * 此后若删临时文件 / 临时目录 / 核对 nlink 失败，就删掉这个刚 link 出来的目标再抛错。清理失败时残留的路径写进错误消息。
 * 残余：「第一次 lstat」到「发布前复查」之间出现的伴随路径由复查拦住；复查之后到 link 之间的极短窗口不在保证内。link 本身不会覆盖已存在的目标。
 *   另：link 成功只证明发布那一刻目标路径归本次所有；若发布后收尾失败、而在此之前目标已被别的进程整体替换，按路径删除会作用于替换后的条目
 *   （需并发进程在微秒级窗口内对同一路径操作，codex 07-R3 认可为竞态残余）。
 * @returns {Promise<{ dbConnectionsCleared: number, configKeys: string[], configRewritten: string[], configDropped: Array<{ key: string, reason: string }> }>}
 */
async function createIsolatedDb({ sourceDbPath, targetDbPath, instanceId, parent, from, sourceEncryptionKey } = {}) {
    for (const [k, v] of [['sourceDbPath', sourceDbPath], ['targetDbPath', targetDbPath], ['instanceId', instanceId], ['parent', parent]]) {
        if (!isNonEmptyString(v)) throw new Error(`createIsolatedDb：${k} 必须是非空字符串`);
    }
    if (sourceEncryptionKey !== undefined && sourceEncryptionKey !== null && (typeof sourceEncryptionKey !== 'string' || sourceEncryptionKey === '')) {
        throw new Error('createIsolatedDb：sourceEncryptionKey 只能是非空字符串、null 或 undefined');
    }
    assertNotBusinessDb(targetDbPath);
    const existing = firstExistingOf(targetDbPath);
    if (existing) throw targetExistsError(existing, targetDbPath);   // 拒绝不进入清理分支
    const dir = path.dirname(path.resolve(targetDbPath));
    let dirStat = null;
    try { dirStat = fs.statSync(dir); } catch (_) { /* 下面统一报 */ }
    if (!dirStat || !dirStat.isDirectory()) throw new Error(`createIsolatedDb：目标所在目录不存在（不代建）：${dir}`);
    let srcStat = null;
    try { srcStat = fs.statSync(sourceDbPath); } catch (_) { /* 下面统一报 */ }
    if (!srcStat || !srcStat.isFile()) throw new Error(`createIsolatedDb：来源 ${sourceDbPath} 不存在或不是普通文件`);

    const tmpDir = fs.mkdtempSync(path.join(dir, '.sdh-create-'));   // 独占：mkdtemp 保证这个目录是本次创建的
    const tmpFile = path.join(tmpDir, 'db.sqlite');
    // 删本次独占创建的临时目录（逐项 unlink + rmdir，不用 rmSync）；残留的路径写进传入的错误消息
    const removeTmpDir = (e) => {
        const left = removeTempDirChecked(tmpDir);
        if (left.length && e) e.message = `${e.message}（清理失败，残留：${left.join('、')}）`;
        return left.length === 0;
    };
    let result;
    try {
        const src = await openDb(sourceDbPath, sqlite3.OPEN_READONLY);
        try {
            src.configure('busyTimeout', 5000);
            try {
                await runSql(src, 'VACUUM INTO ?', [tmpFile]);
            } catch (e) {
                // 来源旁有未回滚的 journal（上次异常退出）：只读连接无法回滚，VACUUM INTO 报 SQLITE_READONLY。只在两个条件同时成立时包装，其余原样抛
                if (e && e.code === 'SQLITE_READONLY' && fs.existsSync(sourceDbPath + '-journal')) {
                    const w = new Error(`createIsolatedDb：来源库有未回滚的 journal（上次异常退出），请先用读写连接打开来源库、执行一次读取（如 SELECT count(*) FROM sqlite_master）后关闭，再重试（只开关连接不保证触发热日志恢复；原错误：${e.message}）`);
                    w.code = 'SOURCE_HOT_JOURNAL';
                    throw w;
                }
                throw e;
            }
        } finally {
            await closeDb(src);
        }
        const st = fs.lstatSync(tmpFile);
        if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) {
            throw new Error(`createIsolatedDb：VACUUM INTO 生成的 ${tmpFile} 不是独立的普通文件（isFile=${st.isFile()} symlink=${st.isSymbolicLink()} nlink=${st.nlink}）`);
        }
        result = await prepareIsolatedDb(tmpFile, { instanceId, parent, from, sourceEncryptionKey });
        const side = ['-journal', '-wal', '-shm'].map((s) => tmpFile + s).filter((p) => fs.existsSync(p));
        if (side.length) throw new Error(`createIsolatedDb：隔离化之后临时目录里仍有伴随文件：${side.join('、')}`);
        // 发布前复查：期间出现的陈旧 journal / wal 会被新库当成热日志，宁可放弃
        const late = firstExistingOf(targetDbPath);
        if (late) throw targetExistsError(late, targetDbPath);
        try {
            fs.linkSync(tmpFile, targetDbPath);   // 目标已存在时失败，不覆盖
        } catch (e) {
            if (e && e.code === 'EEXIST') throw targetExistsError(targetDbPath, targetDbPath);
            throw e;
        }
    } catch (e) {
        removeTmpDir(e);   // 失败只删本次独占创建的临时目录
        throw e;
    }
    // 已发布：link 成功即证明 targetDbPath 是本次创建的。此后任何收尾失败，删掉这个刚 link 出来的目标（唯一允许按路径删目标的地方）再抛错
    try {
        const leftFile = removeFileChecked(tmpFile);
        if (leftFile.length) throw new Error(`createIsolatedDb：发布后删除临时文件失败，残留：${leftFile.join('、')}`);
        const leftDir = removeTempDirChecked(tmpDir);
        if (leftDir.length) throw new Error(`createIsolatedDb：发布后删除临时目录失败，残留：${leftDir.join('、')}`);
        const fin = fs.lstatSync(targetDbPath);
        if (!fin.isFile() || fin.isSymbolicLink() || fin.nlink !== 1) {
            throw new Error(`createIsolatedDb：发布后的目标 ${targetDbPath} 不是独立的普通文件（isFile=${fin.isFile()} symlink=${fin.isSymbolicLink()} nlink=${fin.nlink}）`);
        }
    } catch (e) {
        const leftTarget = removeFileChecked(targetDbPath);   // 唯一允许按路径删目标的地方（link 成功证明它是本次创建的）
        if (leftTarget.length) e.message = `${e.message}（清理失败，残留目标：${leftTarget.join('、')}）`;
        removeTmpDir(e);
        throw e;
    }
    return result;
}

/** 以只读方式读出 _sdh_instance 的表存在性与全部行。打不开库时抛带 phase = 'open' 的错误。 */
async function readIdentityRowsReadonly(target, flags) {
    let db;
    try {
        db = await openDb(target, flags);
    } catch (e) {
        e.phase = 'open';
        throw e;
    }
    try {
        db.configure('busyTimeout', 3000);
        const tables = await allSql(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? COLLATE NOCASE", [TABLE]);
        const rows = tables.length === 1 ? await allSql(db, `SELECT id, instance_id, created_at, source FROM ${TABLE}`) : [];
        return { tableCount: tables.length, rows };
    } finally {
        await closeDb(db);
    }
}

/**
 * 只读核对库内身份。绝不写库、绝不创建文件（库文件不存在即失败）。
 * @returns {Promise<{ ok: boolean, code: string, message: string }>}
 */
async function checkInstanceIdentity(dbPath, { expectedInstance, expectedParent } = {}) {
    const fail = (code, message) => ({ ok: false, code, message });
    if (!isNonEmptyString(dbPath)) return fail('BAD_ARGS', '缺少 dbPath');
    if (!isNonEmptyString(expectedInstance)) return fail('BAD_ARGS', '缺少 expectedInstance');
    try {
        let read;
        try {
            read = await readIdentityRowsReadonly(dbPath, sqlite3.OPEN_READONLY);
        } catch (e) {
            if (e && e.code === 'SQLITE_READONLY' && !e.phase && fs.existsSync(dbPath + '-journal')) {
                // 上次异常退出留下未回滚的 hot journal：只读连接无法回滚，会报 SQLITE_READONLY。
                // 身份表只在建库时写一次、之后不会被改，所以改用 immutable=1 的只读 URI 读主库文件（忽略 journal，不加锁、不写）；
                // 真正的回滚留给服务启动后的读写连接，由 SQLite 自动完成。通过判定的条件不变（仍须身份表正确）。
                try {
                    read = await readIdentityRowsReadonly(pathToFileURL(dbPath).href + '?immutable=1', sqlite3.OPEN_READONLY | sqlite3.OPEN_URI);
                } catch (e2) {
                    return fail(e2 && e2.phase === 'open' ? 'DB_OPEN_FAILED' : 'CHECK_ERROR', `库有未回滚的 journal，且 immutable 只读核对也失败：${e2 && e2.message}`);
                }
            } else if (e && e.phase === 'open') {
                return fail('DB_OPEN_FAILED', `无法以只读方式打开库 ${dbPath}：${e && e.message}`);
            } else {
                throw e;
            }
        }
        return evaluateIdentityRows(read.tableCount, read.rows, { expectedInstance, expectedParent });
    } catch (e) {
        return fail('CHECK_ERROR', `库内身份核对出错：${e && e.message}`);
    }
}

/** 纯判定：给定表存在数与全部行，核对身份。 */
function evaluateIdentityRows(tableCount, rows, { expectedInstance, expectedParent } = {}) {
    const fail = (code, message) => ({ ok: false, code, message });
    if (tableCount !== 1) return fail('TABLE_MISSING', `库内没有 ${TABLE} 表：这不是隔离库（线库 / 测试库创建时才写入身份）`);
    if (rows.length !== 1) return fail('ROW_COUNT', `${TABLE} 必须恰好一行，实际 ${rows.length} 行`);
    const row = rows[0];
    if (row.id !== 1) return fail('ID_INVALID', `${TABLE}.id 必须为 1，实际 ${JSON.stringify(row.id)}`);
    if (!isNonEmptyString(row.instance_id) || !isNonEmptyString(row.created_at) || !isNonEmptyString(row.source)) {
        return fail('FIELD_EMPTY', `${TABLE} 的 instance_id / created_at / source 必须全部非空`);
    }
    if (row.instance_id !== expectedInstance) {
        return fail('INSTANCE_MISMATCH', `库内身份 ${JSON.stringify(row.instance_id)} 与运行身份 ${JSON.stringify(expectedInstance)} 不一致：这个库不属于本实例`);
    }
    if (isNonEmptyString(expectedParent)) {
        let parsed;
        try { parsed = JSON.parse(row.source); } catch (_) { parsed = null; }
        if (!parsed || typeof parsed !== 'object') return fail('SOURCE_INVALID', `${TABLE}.source 不是合法 JSON 对象`);
        if (parsed.parent !== expectedParent) {
            return fail('PARENT_MISMATCH', `库内记录的父检出身份 ${JSON.stringify(parsed.parent)} 与期望 ${JSON.stringify(expectedParent)} 不一致`);
        }
    }
    return { ok: true, code: 'OK', message: `库内身份核对通过：${expectedInstance}` };
}

/**
 * 同步版（server.js 启动期用）：子进程运行 instance-db-check.js，只读打开库，输出 JSON 结果。
 * 子进程异常 / 超时 / 输出无法解析一律按失败处理（fail-closed）。
 * _checkScript 仅供验证脚本注入替身核对脚本（生产调用方 server.js 不传）。
 */
function checkInstanceIdentitySync(dbPath, { expectedInstance, expectedParent, _checkScript } = {}) {
    const args = [_checkScript || path.join(__dirname, 'instance-db-check.js'), '--db', String(dbPath), '--instance', String(expectedInstance)];
    if (isNonEmptyString(expectedParent)) args.push('--parent', expectedParent);
    let stdout = '';
    let threw = false;
    try {
        stdout = execFileSync(process.execPath, args, { encoding: 'utf8', timeout: 20000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
        // 退出码非 0（或超时）时 execFileSync 抛错，但结果 JSON 仍在 e.stdout；这条路径只接受解析出的 ok:false，绝不接受 ok:true
        threw = true;
        stdout = e && e.stdout ? String(e.stdout) : '';
        if (!stdout) return { ok: false, code: 'CHECK_PROCESS_FAILED', message: `库内身份核对子进程失败：${e && e.message}` };
    }
    try {
        const r = JSON.parse(stdout);
        if (r && typeof r === 'object' && typeof r.ok === 'boolean') {
            if (threw && r.ok) return { ok: false, code: 'CHECK_PROCESS_FAILED', message: '库内身份核对子进程异常退出，却输出了 ok:true，按失败处理' };
            return { ok: r.ok, code: String(r.code || ''), message: String(r.message || '') };
        }
    } catch (_) { /* 落到下面的失败 */ }
    return { ok: false, code: 'CHECK_OUTPUT_INVALID', message: `库内身份核对子进程输出无法解析：${stdout.slice(0, 200)}` };
}

module.exports = {
    TABLE, checkInstanceIdentity, checkInstanceIdentitySync,
    createIsolatedDb, assertNotBusinessDb, VIRTUAL_DINGTALK_CONFIG, SYSTEM_CONFIGS_DDL, ISOLATED_CONFIG_WHITELIST,
    // 仅供测试：内部函数 prepareIsolatedDb（对一个已存在的独立副本做隔离化）与解密钩子（fn(decryptKey, cipherText, configKey) → 明文；传 null 恢复默认 decryptWithKey）。生产代码一律走 createIsolatedDb，不得使用。
    _internal: {
        prepareIsolatedDb,
        writeInstanceIdentity,
        setDecryptHookForTest(fn) {
            if (fn !== null && typeof fn !== 'function') throw new TypeError('setDecryptHookForTest：参数必须是函数或 null');
            decryptConfigValue = fn === null ? decryptWithKey : fn;
        },
    },
};
