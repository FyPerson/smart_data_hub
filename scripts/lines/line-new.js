/**
 * line new（#106 多线并行改造 · S2b · 方案 W2「line new 步骤」「依赖规则」；修复批 1）
 *
 * 入口：lineNew(ctx, args)。ctx = { controlRoot, linesRoot, mainRoot, out?, stateOpts?, lineLockTimeoutMs?, testHooks? }（三个根路径由调用方解析好；测试显式覆盖，不经环境变量）；
 *       args = { name, module, surface, ackOverlap?, noConfigKey? }。testHooks.afterStep(stepName) 仅测试用（步骤成功之后调用，可 async）。
 *
 * 整个操作包在线级锁 withLineLock(controlRoot, name, …) 里；之后所有 updateLine 都带 expectGeneration（createLine 返回的代次），
 * 所以两个并发操作互斥，删后同名重建的新线不会被旧操作改到。
 *
 * 步骤与失败步骤名（failed_step）：
 *   0 （无）               读主 .env 并初始化脱敏器（任何业务输出之前，createLine 之前）；.env 读不了 → 报错退出，什么都没建
 *   1 （无）               状态锁内：校验线名 → 同模块闸门（createLine 的同步 guard）→ 预留槽位，lifecycle=creating，记下代次
 *   1b reserve             槽位预留之后的第一批输出（预留提示、同模块确认提示）也在 try 里：输出通道失败同样落到 failed，不让记录停在 creating
 *   2 precheck             修改之前的路径预检：线目录根 / worktree 目标的真实路径，排除主工作区与其他已登记检出
 *   3 worktree             git worktree add -b line/<线名> <线目录根>/<线名> refs/heads/<集成分支>；目录或分支已存在即失败（不复用、不覆盖）
 *   4 owner_record         立刻写归属凭据：先核实刚建出的 worktree 的私有管理目录（<git 公共目录>/worktrees/<id>/，互相指向），再写控制根 owners/<代次>.json（含管理目录 id / 路径）
 *                          与管理目录里的标记文件 sdh-line-owner.json；worktree 根不放任何本工具的文件。写失败**不回滚**：不删任何东西，lifecycle=failed，
 *                          输出写明 worktree / 分支 / 管理目录位置与只读现场清单（不生成任何改动类命令，只有两条只读 reflog 查看命令；清理交在场人员按 CLAUDE.md 规则处理）；之后 line remove 因归属无法证明只清登记、资源保留
 *   5 node_modules_junction 两级 node_modules 目录联接指向主工作区（每个目标先做祖先链预检）
 *   6 identity_file        先写 wbs-server/.sdh-instance（createIsolatedDb 的防呆要求目标上溯的检出目录有它）
 *   7 create_db            createIsolatedDb：来源 = 主库，目标 = 线库，身份 = 线名，父 = main，来源键 = 主 .env 的 DB_ENCRYPTION_KEY（只在内存里传递）
 *   8 copy_runtime         先拍库快照（第 7 步）、后复制 uploads / archive / private / periodic-results / 对账附件目录；遇链接拒绝
 *   9 （不阻断）           线库上只读、逐行流式查附件文件是否存在，缺失只告警
 *  10 env_file             线 .env：JWT_SECRET 每条线随机生成；其余按显式白名单（LINE_ENV_WHITELIST）从主 .env 拷贝；绝不含 DB_ENCRYPTION_KEY / PORT / SDH_*
 *  11 final_verify / ready_commit  用 instance-mode 与库内身份再核一遍线服务会怎么判定；lifecycle=ready，打印开线单
 *                          （最后一步叫 ready_commit，不叫 finalize：finalize 是 line remove 的步骤名，line remove 的放宽重试只认自己的步骤）
 * 第 2–11 步任一步失败：lifecycle=failed、failed_step=<步骤名>，已建出的东西原样保留，提示用 line remove <线名> --discard 清理
 *   （例外 owner_record：归属凭据没写成，line remove 证明不了归属，只清登记，资源原样保留，交在场人员按 CLAUDE.md 规则处理）。
 * 创建不做任何回滚：不删 worktree、不删分支（worktree add 之后到失败那一刻之间可能已有别人写入的内容）。
 *
 * 保密：来源键与主 .env 各值只在内存里；输出与错误消息统一经同一脱敏函数（主 .env 里长度 >= 8 的值替换）；开线单只打键名与原因，不打值。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('./line-common');
const S = require('./state');
const instanceDb = require(path.join(C.REPO_ROOT, 'wbs-server', 'utils', 'instance-db.js'));   // 以属性方式调用（instanceDb.createIsolatedDb），测试可在同进程内包一层
const instanceMode = require(path.join(C.REPO_ROOT, 'wbs-server', 'utils', 'instance-mode.js'));

const { LineError } = C;

/**
 * 线 .env 从主 .env 拷贝的显式白名单（代码常量，值原样）。其余一律不拷贝（含任何以 SDH_ 开头的键、DB_ENCRYPTION_KEY、PORT）。
 * JWT_SECRET 不在此列：每条线随机生成（crypto.randomBytes(32).toString('hex')），线上签发的令牌不被主工作区认可，也少一处机密拷贝。
 * reader = 读取该键的代码位置（file:line，本批开工时核过）；why = 保留理由。
 */
const LINE_ENV_WHITELIST = Object.freeze([
    Object.freeze({ key: 'SYS_FASTLANE_ENABLE', reader: 'wbs-server/server.js:22172', why: '系统迭代快车道授权开关（=== \'1\' 才启用），线服务行为须与主工作区一致' }),
    Object.freeze({ key: 'LOG_LEVEL', reader: 'wbs-server/server.js:110', why: '日志级别，非机密，行为一致' }),
    Object.freeze({ key: 'NODE_ENV', reader: 'wbs-server/server.js:22648,22679; wbs-server/routes/it-ledger/index.js:2168', why: '=== \'development\' 才在错误响应里带堆栈 / 明细，线服务错误响应形态须与主工作区一致' }),
]);
/** 线内随机生成的键（reader：server.js:134-139，缺失 / 占位值时服务拒启）。 */
const LINE_ENV_GENERATED = Object.freeze(['JWT_SECRET']);
/** 明确不拷贝的读取点（报告用，同时是守卫：白名单里不得出现这些键）。 */
const LINE_ENV_NEVER = Object.freeze({
    JWT_SECRET: 'server.js:134：每条线随机生成，不拷贝主工作区的值',
    DB_ENCRYPTION_KEY: 'server.js:2977：隔离模式固定用隔离专用键，线不得持有真键',
    PORT: 'server.js:53：端口由启动器经进程环境变量传入，.env 里的 PORT 从未生效，不让它在线里生效',
    WEBHOOK_SECRET: 'server.js:404：生产入站 webhook 的鉴权密钥，线不接收外部回调，不扩散机密',
    SYS_TEST_HOOKS: 'routes/sys-iteration/index.js:3322：测试钩子开关，由测试进程自己显式设置',
});

/**
 * 线库里要核对附件文件是否存在的表与列。root 指相对哪个目录（线内对应目录）：
 *   uploads = UPLOAD_DIR；inspection = 巡检单照片目录（private/it-inspection-sheets）；periodic = periodic-results；reconcile = 对账附件目录；archive = ARCHIVE_DIR。
 * kind：plain（列值就是相对路径）/ json_stored_name（列值是 JSON，取 stored_name）/ periodic_abs（列值是主工作区结果目录下的绝对路径）/ task_pool（按 status 选 uploads 或 archive）。
 */
const ATTACHMENT_SOURCES = Object.freeze([
    Object.freeze({ table: 'task_attachments', column: 'file_name', root: 'uploads', kind: 'plain', writer: 'wbs-server/server.js:5305-5310,5356-5360（建表 :1175）' }),
    Object.freeze({ table: 'issue_attachments', column: 'file_name', root: 'uploads', kind: 'plain', writer: 'wbs-server/server.js:13210,13227-13230（建表 :1916）' }),
    Object.freeze({ table: 'issue_lite_attachments', column: 'file_name', root: 'uploads', kind: 'plain', writer: 'wbs-server/server.js:15436,15453（建表 :2063）' }),
    Object.freeze({ table: 'collab_attachments', column: 'file_name', root: 'uploads', kind: 'plain', writer: 'wbs-server/utils/collab-attachment-versioning.js:603-604,743-757; wbs-server/server.js:20328-20332（建表 :2275）' }),
    Object.freeze({ table: 'sys_quick_log_attachments', column: 'file_name', root: 'uploads', kind: 'plain', writer: 'wbs-server/routes/quick-log/index.js:417,435（建表 server.js:2168）' }),
    Object.freeze({ table: 'sys_issue_attachments', column: 'file_name', root: 'uploads', kind: 'plain', writer: 'wbs-server/routes/sys-iteration/index.js:15684,15688-15691（建表 :999）' }),
    Object.freeze({ table: 'correction_attachments', column: 'file_name', root: 'uploads', kind: 'plain', writer: 'wbs-server/routes/corrections.js:2566,2570-2573（建表 :265）' }),
    Object.freeze({ table: 'it_inspection_sheet_photos', column: 'stored_name', root: 'inspection', kind: 'plain', writer: 'wbs-server/routes/it-ledger/inspection-photo-files.js:44-46（safeFilePath）; inspection-sheets.js:142（建表）' }),
    Object.freeze({ table: 'periodic_task_runs', column: 'result_file_path', root: 'periodic', kind: 'periodic_abs', where: "result_file_path IS NOT NULL AND result_file_path != ''", writer: 'wbs-server/routes/periodic-fetch/index.js:978（写）、runner.js:73-79,83-92（绝对路径与读取校验）; 建表 index.js:181' }),
    Object.freeze({ table: 'it_reconciles', column: 'source_meta', root: 'reconcile', kind: 'json_stored_name', writer: 'wbs-server/routes/it-ledger/reconciles.js:100,299,369-375; 建表 routes/it-ledger/index.js:1398-1402' }),
    Object.freeze({ table: 'task_pool', column: 'file_path', root: 'uploads', kind: 'task_pool', where: "file_path IS NOT NULL AND file_path != ''", writer: 'wbs-server/server.js:6094-6102（status=ARCHIVED 相对 ARCHIVE_DIR，否则相对 UPLOAD_DIR）; 迁移 :1186' }),
]);
const MISSING_PRINT_LIMIT = 20;

class StepFailure extends Error {
    constructor(step, cause) {
        super(cause && cause.message ? cause.message : String(cause));
        this.step = step;
        this.cause = cause;
    }
}

const normModule = (m) => String(m).trim().toLowerCase();

/**
 * 不跟随地列出 root 之下最外层的联接 / 符号链接 / 其他重解析点（只读，什么都不改）。返回 { ok, error, links: [{ p, kind: 'dir'|'file'|'unknown' }] }。
 * 复用 C.scanTree（lstat，遇链接只记录、不进入；已在另一个链接之下的不会出现）；root 本身是链接时不扫描（readdir 会穿过它），只报它自己。
 * 扫描自身失败（读不了目录等）→ ok=false，调用方改给人工只读检查办法。
 */
function outermostLinks(root) {
    const kindOf = (p) => {
        try { const s = fs.statSync(p); return s.isDirectory() ? 'dir' : 'file'; } catch (_) { return 'unknown'; }
    };
    try {
        const st = C.lstatOrNull(root);
        if (st === null) return { ok: false, error: `${root} 不存在`, links: [] };
        if (st.isSymbolicLink()) return { ok: true, error: null, links: [{ p: root, kind: kindOf(root) }] };
        const scan = C.scanTree(fs.realpathSync.native(root), []);
        const links = scan.unexpectedLinks.map((p) => ({ p, kind: kindOf(p) }));
        for (const p of scan.mismatches) links.push({ p, kind: 'dir' });   // 目录项但真实路径对不上 = 卷挂载点等重解析点：同样只能非递归拆
        return { ok: true, error: null, links };
    } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e), links: [] };
    }
}

/**
 * owner_record 失败的现场清单全文（U14 裁定 = A，取代修复批 3b 的「命令生成」）。**只读清单，不生成任何会改动东西的命令**：
 *   上一版生成拆联接 / 复核 / git worktree remove / git branch -d / line remove 命令，codex 连续两轮报 HIGH（按提示做会丢只存在 reflog 里的提交；
 *   生成的命令放进外层 PowerShell 双引号会展开 $ 与反引号；路径含单引号时缺复核命令）。命令生成这一层整个删掉：
 *   只列位置、最外层联接（路径与类型，不附命令）、两条不含任何路径的 reflog 只读命令，清理交在场人员按 CLAUDE.md「建线中断（owner_record 失败）的现场处理」一节处理。
 * 消息里不出现 Delete( / git worktree remove|prune / git branch / Remove-Item / rmdir / --force / -Recurse / node -e / powershell - 等改动类写法。
 */
function ownerRecordFailureMessage(p) {
    const scan = outermostLinks(p.scanRoot);
    const L = [];
    L.push(`${p.reason}`);
    L.push('归属凭据没有写成：已建出的资源原样保留，工具不删、不回滚；归属无法证明，之后 line remove ' + p.name + ' 只会清登记、不会删除它们。位置：');
    L.push(`  worktree 目录：${p.wtPath}`);
    L.push(`  分支：${p.branch}`);
    L.push(`  git 管理目录：${p.adminDir || '（未能核实）'}`);
    L.push('现场清单（只读，供在场人员核对）：');
    if (scan.ok) {
        if (scan.links.length === 0) {
            L.push('  worktree 里没有发现联接 / 符号链接（不跟随扫描）');
        } else {
            L.push(`  最外层联接 / 符号链接 ${scan.links.length} 个：`);
            for (const l of scan.links) L.push(`  ${l.p}（${l.kind === 'dir' ? '目录型' : l.kind === 'file' ? '文件型' : '目标读不到'}）`);
        }
    } else {
        L.push(`  无法自动列出 worktree 里的联接（${scan.error}），在场人员须先人工只读检查`);
    }
    L.push('  在主工作区执行（线分支 reflog）：');
    L.push(`  git reflog show --date=iso refs/heads/${p.branch}`);
    L.push('  在 worktree 目录里执行（worktree 的 HEAD reflog）：');
    L.push('  git reflog show --date=iso HEAD');
    L.push('  reflog 文件位置（供核对，纯路径）：');
    if (p.adminDir) L.push(`  ${path.join(p.adminDir, 'logs', 'HEAD')}`);
    if (p.mainRoot) L.push(`  ${path.join(p.mainRoot, '.git', 'logs', 'refs', 'heads', ...String(p.branch).split('/'))}`);
    L.push('现场原样保留，不要自行删除任何东西（不要拆 worktree、不要删分支、不要删目录）；交在场人员按 CLAUDE.md「建线中断（owner_record 失败）的现场处理」一节处理。');
    L.push('以上是现场清单');   // 最后一行必须是说明句：上层会在消息末尾追加一句话
    return L.join('\n');
}

function validateArgs(args) {
    const a = args || {};
    if (!C.isNonEmptyString(a.name)) throw new LineError('LINE_BAD_ARGS', '缺少线名');
    const problem = S.checkLineName(a.name);
    if (problem) throw new LineError('LINE_BAD_ARGS', `线名 ${JSON.stringify(a.name)} 非法：${problem}`);
    if (!C.isNonEmptyString(a.module) || a.module.trim() === '') throw new LineError('LINE_BAD_ARGS', '缺少 --module <模块>');
    if (a.module.length > 64 || /[\\/:*?"<>|\u0000-\u001f]/.test(a.module) || a.module.trim() === '.' || a.module.trim() === '..' || a.module.trim().startsWith('.')) {
        throw new LineError('LINE_BAD_ARGS', `模块名 ${JSON.stringify(a.module)} 不合法（用作 docs/local/<模块>/ 目录名：不得含路径分隔符 / 通配符 / 控制字符，不得以 . 开头，长度 <= 64）`);
    }
    if (!C.isNonEmptyString(a.surface) || a.surface.trim() === '') throw new LineError('LINE_BAD_ARGS', '缺少 --surface "<预计改动面>"');
    return { name: a.name, module: a.module.trim(), surface: a.surface.trim(), ackOverlap: !!a.ackOverlap, noConfigKey: !!a.noConfigKey };
}

/**
 * 线库上只读检查附件文件是否存在（逐行流式，不把整张表载入内存）。
 * roots = { uploads, archive, inspection, periodic, reconcile, mainPeriodic }（线内对应目录；mainPeriodic 是主工作区结果目录，仅用于解析 periodic_abs 的绝对路径）。
 * 返回 { checked, missingCount, missing: 前 20 条 [{table,id,file_name,reason}], tablesAbsent, perTable: { 表名: {checked, missing} }, errors }。
 */
async function checkAttachments(dbFile, roots) {
    const sqlite3 = C.requireWbs('sqlite3');
    const db = await new Promise((resolve, reject) => {
        const d = new sqlite3.Database(dbFile, sqlite3.OPEN_READONLY, (err) => (err ? reject(err) : resolve(d)));
    });
    const all = (sql, params) => new Promise((resolve, reject) => db.all(sql, params || [], (err, rows) => (err ? reject(err) : resolve(rows))));
    const result = { checked: 0, missingCount: 0, missing: [], tablesAbsent: [], perTable: {}, errors: [] };
    const record = (src, id, shown, reason) => {
        result.missingCount += 1;
        result.perTable[src.table].missing += 1;
        if (result.missing.length < MISSING_PRINT_LIMIT) result.missing.push({ table: src.table, id, file_name: shown, reason });
    };
    const judge = (src, row) => {
        result.checked += 1;
        result.perTable[src.table].checked += 1;
        const f = row.f;
        let base;
        let rel;
        if (src.kind === 'json_stored_name') {
            let meta = null;
            try { meta = JSON.parse(String(f)); } catch (_) { meta = null; }
            rel = meta && typeof meta === 'object' ? meta.stored_name : undefined;
            base = roots.reconcile;
        } else if (src.kind === 'periodic_abs') {
            if (typeof f !== 'string' || f.trim() === '') { record(src, row.id, f === null ? '' : String(f), '路径为空'); return; }
            const abs = path.resolve(f);
            if (!C.isInside(roots.mainPeriodic, abs)) { record(src, row.id, f, '路径不在主工作区结果目录之内'); return; }
            rel = path.relative(path.resolve(roots.mainPeriodic), abs);
            base = roots.periodic;
        } else if (src.kind === 'task_pool') {
            rel = f;
            base = String(row.status).toUpperCase() === 'ARCHIVED' ? roots.archive : roots.uploads;
        } else {
            rel = f;
            base = roots[src.root];
        }
        if (typeof rel !== 'string' || rel.trim() === '') { record(src, row.id, f === null || f === undefined ? '' : String(f), '路径为空'); return; }
        const root = path.resolve(base);
        const full = path.resolve(root, rel);
        if (!C.isInside(root, full)) { record(src, row.id, rel, '路径越界'); return; }
        let ok = false;
        try { ok = fs.statSync(full).isFile(); } catch (_) { ok = false; }
        if (!ok) record(src, row.id, rel, '文件不存在');
    };
    try {
        db.configure('busyTimeout', 5000);
        for (const src of ATTACHMENT_SOURCES) {
            const has = await all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [src.table]);
            if (has.length !== 1) { result.tablesAbsent.push(src.table); continue; }
            result.perTable[src.table] = { checked: 0, missing: 0 };
            const extra = src.kind === 'task_pool' ? ', status' : '';
            const sql = `SELECT id, ${src.column} AS f${extra} FROM ${src.table}${src.where ? ` WHERE ${src.where}` : ''}`;
            try {
                await new Promise((resolve, reject) => {
                    db.each(sql, [], (err, row) => { if (!err) judge(src, row); }, (err) => (err ? reject(err) : resolve()));
                });
            } catch (e) {
                result.errors.push(`${src.table}: ${e && e.message}`);
            }
        }
    } finally {
        await new Promise((resolve) => db.close(() => resolve()));
    }
    return result;
}

/** 从主 .env 按白名单取键值；返回 { entries: [{key,value}], dropped: [键名...] }。win32 上环境变量名不分大小写，白名单匹配也不分大小写，写出用规范大写名；同名多份先出现者保留。 */
function pickEnvEntries(mainEnv) {
    const entries = [];
    const dropped = [];
    const seen = new Set();
    for (const k of Object.keys(mainEnv)) {
        const hit = LINE_ENV_WHITELIST.find((w) => (C.isWin ? w.key.toLowerCase() === k.toLowerCase() : w.key === k));
        if (hit && !seen.has(hit.key)) { seen.add(hit.key); entries.push({ key: hit.key, value: mainEnv[k] }); } else dropped.push(k);
    }
    entries.sort((a, b) => LINE_ENV_WHITELIST.findIndex((w) => w.key === a.key) - LINE_ENV_WHITELIST.findIndex((w) => w.key === b.key));
    return { entries, dropped };
}

function renderEnvFile(entries) {
    const body = entries.map((e) => `${e.key}=${C.formatEnvValue(e.value)}`).join('\n');
    return `# generated by line new (#106): JWT_SECRET is random per line; other keys are an explicit whitelist copied from the main workspace .env\n${body}\n`;
}

/** 真实路径解析：已存在的部分取 realpath，不存在的尾部原样接回。 */
function realOfLoose(p) {
    let cur = path.resolve(p);
    const tail = [];
    for (;;) {
        try {
            const real = fs.realpathSync.native(cur);
            return tail.length ? path.join(real, ...tail.reverse()) : real;
        } catch (_) {
            const up = path.dirname(cur);
            if (up === cur) return path.resolve(p);
            tail.push(path.basename(cur));
            cur = up;
        }
    }
}

/** worktree 目标的规范真实路径（线目录根的真实路径 + 线名）不得等于 / 位于 / 包含任何已登记的检出（含主工作区）。 */
function assertNotOtherCheckout(wtExpectedReal, mainRoot, ownKey) {
    const wtKey = C.fold(wtExpectedReal);
    const keys = new Set(C.registeredWorktreeKeys(mainRoot));
    keys.add(C.pathKey(mainRoot));
    for (const k of keys) {
        if (ownKey && k === ownKey) continue;
        if (k === wtKey || C.isInside(k, wtKey) || C.isInside(wtKey, k)) {
            throw new LineError('LINE_UNSAFE_PATH', `worktree 目标 ${wtExpectedReal} 与已登记的检出 ${k} 相同或互相包含，拒绝`);
        }
    }
}

async function lineNew(ctx, rawArgs) {
    const args = validateArgs(rawArgs);
    const { controlRoot, linesRoot, mainRoot } = ctx;
    for (const [k, v] of [['controlRoot', controlRoot], ['linesRoot', linesRoot], ['mainRoot', mainRoot]]) {
        if (!C.isNonEmptyString(v)) throw new LineError('LINE_BAD_ARGS', `内部错误：缺少 ${k}`);
    }
    // 0. 读主 .env、建脱敏器：任何业务输出之前（含同模块闸门报错）
    let redact = (t) => String(t);
    try {
        const loaded = C.loadMainEnv(mainRoot);
        redact = loaded.redact;
        return await runNew(ctx, args, loaded.env, redact);
    } catch (e) {
        throw C.scrubError(e, redact);
    }
}

async function runNew(ctx, args, mainEnv, redact) {
    const { controlRoot, linesRoot, mainRoot } = ctx;
    const stateOpts = ctx.stateOpts || {};
    const hooks = ctx.testHooks || {};
    const sink = typeof ctx.out === 'function' ? ctx.out : (s) => console.log(s);
    const say = (s) => sink(redact(s));
    const name = args.name;
    const branch = `line/${name}`;
    const branchRef = `refs/heads/${branch}`;
    const wtPath = path.join(path.resolve(linesRoot), name);
    const mainWbs = path.join(mainRoot, 'wbs-server');
    const mainDb = path.join(mainWbs, 'task_pool.db');

    const st0 = await S.readState(controlRoot, stateOpts);
    const integ = st0.config.integration_branch || 'main';
    if (integ.startsWith('-')) throw new LineError('LINE_BAD_ARGS', `集成分支名不合法：${integ}`);
    const integRef = `refs/heads/${integ}`;

    return S.withLineLock(controlRoot, name, async () => {
        // ---- 1. 状态锁内：同模块闸门 + 预留槽位（lifecycle=creating）----
        //   闸门拒绝 / 线名重复 / 无空闲槽位等：登记表没有变化，错误原样抛出（不进入 failed）
        let overlapped = [];
        const rec = await S.createLine(controlRoot, name, { module: args.module, branch, worktree: wtPath, surface: args.surface, deps_mode: 'shared' }, Object.assign({}, stateOpts, {
            guard(others) {
                const same = others.filter((o) => o.module !== null && normModule(o.module) === normModule(args.module));
                if (same.length === 0) return;
                if (!args.ackOverlap) {
                    const lines = same.map((o) => `  线 ${o.name}（${o.lifecycle}）预计改动面：${C.surfaceText(o.surface)}`);
                    throw new LineError('LINE_MODULE_OVERLAP', `模块 ${args.module} 已有未删除的线，请先与对方确认改动面不重叠，确认后加 --ack-overlap 重试：\n${lines.join('\n')}`, { others: same });
                }
                overlapped = same;
            },
        }));
        const generation = rec.generation;
        const upd = (patch) => S.updateLine(controlRoot, name, patch, Object.assign({}, stateOpts, { expectGeneration: generation }));
        const step = async (stepName, fn) => {
            let r;
            try {
                r = await fn();
                if (typeof hooks.afterStep === 'function') await hooks.afterStep(stepName);
            } catch (e) { throw new StepFailure(stepName, e); }
            return r;
        };
        const result = { record: null, generation, configRewritten: [], configDropped: [], missingAttachments: { count: 0, first: [] }, attachmentCheck: null, envDropped: [], runtime: [], overlapped, integrationBranch: integ, warnings: [] };
        let wtReal = null;
        let adminInfo = null;   // 刚建出的 worktree 的私有管理目录 { id, dir }
        try {
            // 槽位已预留：此后任何一步（含输出）失败都要落到 failed，不能让记录停在 creating
            await step('reserve', async () => {
                say(`已预留槽位 ${rec.slot}（端口 ${rec.port}），lifecycle=creating`);
                for (const o of overlapped) say(`【同模块提示】已用 --ack-overlap 确认：线 ${o.name}（${o.lifecycle}）预计改动面：${C.surfaceText(o.surface)}`);
            });
            const keyName = Object.keys(mainEnv).find((k) => (C.isWin ? k.toLowerCase() === 'db_encryption_key' : k === 'DB_ENCRYPTION_KEY'));
            const sourceKey = !args.noConfigKey && keyName !== undefined && typeof mainEnv[keyName] === 'string' && mainEnv[keyName] !== '' ? mainEnv[keyName] : null;
            const baseOid = { v: null };
            let realLines = null;

            // 2. 修改之前的路径预检
            await step('precheck', async () => {
                realLines = realOfLoose(linesRoot);
                const expected = path.join(realLines, name);
                assertNotOtherCheckout(expected, mainRoot, null);
                const st = C.lstatOrNull(wtPath);
                if (st !== null && st.isSymbolicLink()) throw new LineError('LINE_UNSAFE_PATH', `worktree 目标 ${wtPath} 是链接，拒绝`);
            });

            // 3. worktree（失败 = 目录 / 分支已存在等，什么都没建）
            await step('worktree', async () => {
                if (C.lstatOrNull(wtPath) !== null) throw new Error(`目录已存在，不复用、不覆盖：${wtPath}`);
                if (C.gitTry(mainRoot, ['rev-parse', '--verify', '--quiet', branchRef]).status === 0) throw new Error(`分支已存在，不复用：${branch}`);
                const b = C.gitTry(mainRoot, ['rev-parse', '--verify', '--quiet', integRef]);
                if (b.status !== 0) throw new Error(`集成分支 ${integ} 不存在`);
                baseOid.v = b.stdout.trim();
                fs.mkdirSync(path.resolve(linesRoot), { recursive: true });
                realLines = fs.realpathSync.native(path.resolve(linesRoot));
                C.git(mainRoot, ['worktree', 'add', '-b', branch, wtPath, integRef]);
            });
            say(`worktree：${wtPath}（分支 ${branch}，自 ${integ}）`);

            // 4. 归属凭据（立刻写）。写失败**不回滚**：worktree add 之后到此刻之间有 await 边界与检出钩子，
            //    用户或后台工具可能已在新 worktree 里写了文件或提交，「刚创建」不等于「内容没变」；这里不删任何东西，把位置和只读现场清单告诉用户（清理交在场人员按 CLAUDE.md 规则处理）
            await step('owner_record', async () => {
                try {
                    wtReal = fs.realpathSync.native(wtPath);
                    if (C.fold(wtReal) !== C.fold(path.join(realLines, name))) throw new LineError('LINE_UNSAFE_PATH', `worktree 的真实路径 ${wtReal} 不是预期的 ${path.join(realLines, name)}`);
                    assertNotOtherCheckout(wtReal, mainRoot, C.pathKey(wtReal));
                    adminInfo = C.findWorktreeAdmin(mainRoot, wtReal);
                    const branchOid = C.git(mainRoot, ['rev-parse', '--verify', branchRef]).trim();
                    C.writeOwnerRecord(controlRoot, {
                        name, generation, branch, branch_oid: branchOid, worktree: wtReal, base_branch: integ, base_oid: baseOid.v,
                        admin_id: adminInfo.id, admin_dir: adminInfo.dir, created_at: new Date().toISOString(),
                    });
                    C.writeAdminMarker(adminInfo.dir, { name, generation, branch, worktree: wtReal });
                } catch (e) {
                    throw new Error(ownerRecordFailureMessage({ reason: e && e.message, name, branch, wtPath, mainRoot, adminDir: adminInfo ? adminInfo.dir : null, scanRoot: wtPath }));   // 扫 wtPath 本身（不是 wtReal）：wtPath 自己是链接时 outermostLinks 只报它，不穿过去
                }
            });
            const lineWbs = path.join(wtReal, 'wbs-server');
            const lineDb = path.join(lineWbs, 'task_pool.db');
            const safe = (rel, o) => {
                if (C.fold(fs.realpathSync.native(wtPath)) !== C.fold(wtReal)) throw new LineError('LINE_UNSAFE_PATH', `worktree 根 ${wtPath} 的真实路径已变化，拒绝继续`);
                C.assertChainSafe(wtReal, rel, o);
            };

            // 5. 两级 node_modules 联接
            await step('node_modules_junction', async () => {
                for (const rel of ['node_modules', path.join('wbs-server', 'node_modules')]) {
                    safe(rel);
                    C.makeJunction(path.join(mainRoot, rel), path.join(wtReal, rel));
                }
            });
            say('node_modules：两级目录联接已建（仓库根、wbs-server），指向主工作区');

            // 6. 先写 .sdh-instance
            const idFile = path.join(lineWbs, '.sdh-instance');
            await step('identity_file', async () => {
                safe(path.join('wbs-server', '.sdh-instance'));
                fs.writeFileSync(idFile, `${name}\n`, { encoding: 'utf8', flag: 'wx' });
                const cfg = instanceMode.resolveInstanceConfig({ env: {}, checkoutDir: lineWbs });
                if (cfg.refuse || cfg.mode !== 'isolated' || cfg.kind !== 'line' || cfg.instance !== name) {
                    throw new Error(`.sdh-instance 写入后按 instance-mode 判定不是线服务：${JSON.stringify(cfg.refuse ? { code: cfg.code, message: cfg.message } : { mode: cfg.mode, kind: cfg.kind, instance: cfg.instance })}`);
                }
            });
            say(`身份文件：${idFile}`);

            // 7. 建线库
            const dbRes = await step('create_db', async () => {
                safe(path.join('wbs-server', 'task_pool.db'));
                try {
                    return await instanceDb.createIsolatedDb({ sourceDbPath: mainDb, targetDbPath: lineDb, instanceId: name, parent: 'main', from: 'line-new', sourceEncryptionKey: sourceKey });
                } catch (e) {
                    let msg = e && e.message ? e.message : String(e);
                    if (e && e.code === 'SOURCE_KEY_MISMATCH') msg += '。确认主工作区 wbs-server/.env 的 DB_ENCRYPTION_KEY 正确，或加 --no-config-key 显式放弃这 7 个配置键';
                    const err = new Error(msg);
                    err.code = e && e.code;
                    throw err;
                }
            });
            result.configRewritten = dbRes.configRewritten.slice();
            result.configDropped = dbRes.configDropped.map((d) => ({ key: d.key, reason: d.reason }));
            say(`线库：${lineDb}`);
            say(`配置改写（来源键解密、隔离键重加密）：${result.configRewritten.length ? result.configRewritten.join('、') : '（无）'}`);
            say(`配置丢弃：${result.configDropped.length ? result.configDropped.map((d) => `${d.key}(${d.reason})`).join('、') : '（无）'}`);
            if (sourceKey === null) {
                say('【注意】没有来源键（主 .env 无 DB_ENCRYPTION_KEY，或用了 --no-config-key）：非钉钉的 7 个配置键已全部丢弃，线服务这些开关取默认值，与主工作区行为不同');
            }

            // 8. 复制运行期文件（库快照已在第 7 步拍好）
            const lineCfg = instanceMode.resolveInstanceConfig({ env: {}, checkoutDir: lineWbs });
            await step('copy_runtime', async () => {
                const plan = [
                    { key: 'uploads', src: path.join(mainWbs, 'uploads'), dst: lineCfg.uploadDir },
                    { key: 'archive', src: path.join(mainWbs, 'archive'), dst: lineCfg.archiveDir },
                    { key: 'private', src: path.join(mainWbs, 'private'), dst: path.join(lineCfg.dataRoot, 'private') },
                    { key: 'periodic-results', src: path.join(mainWbs, 'periodic-results'), dst: lineCfg.periodicResultsDir },
                    // 主工作区读 routes/it-ledger/uploads/it-reconcile（reconciles.js:15 的默认），线读 itReconcileDir（instance-mode.js:276）
                    { key: 'it-reconcile', src: path.join(mainWbs, 'routes', 'it-ledger', 'uploads', 'it-reconcile'), dst: lineCfg.itReconcileDir },
                ];
                const realMain = fs.realpathSync.native(mainRoot);
                for (const p of plan) {
                    if (!C.isInside(lineWbs, p.dst)) throw new Error(`内部错误：复制目标 ${p.dst} 不在线的 wbs-server 之内`);
                    safe(path.relative(wtReal, p.dst));
                    if (C.lstatOrNull(p.src) === null) { result.runtime.push({ key: p.key, skipped: true, from: p.src, to: p.dst }); continue; }
                    const stats = C.copyTreeNoFollow(p.src, p.dst, { srcBase: realMain });   // 来源根的祖先链与每个来源子目录都做重解析点检查
                    result.runtime.push({ key: p.key, skipped: false, from: p.src, to: p.dst, files: stats.files, bytes: stats.bytes });
                }
            });
            for (const r of result.runtime) say(r.skipped ? `运行期文件 ${r.key}：来源不存在，已跳过（${r.from}）` : `运行期文件 ${r.key}：${r.files} 个文件 / ${r.bytes} 字节 → ${r.to}`);

            // 9. 附件存在性（只告警）
            try {
                const att = await checkAttachments(lineDb, {
                    uploads: lineCfg.uploadDir, archive: lineCfg.archiveDir, inspection: lineCfg.itInspectionSheetDir,
                    periodic: lineCfg.periodicResultsDir, reconcile: lineCfg.itReconcileDir, mainPeriodic: path.join(mainWbs, 'periodic-results'),
                });
                result.attachmentCheck = att;
                result.missingAttachments = { count: att.missingCount, first: att.missing };
                say(`附件检查：核对 ${att.checked} 条，缺失 ${att.missingCount} 条（只告警，不阻断）`);
                for (const m of att.missing) say(`  缺失 ${m.table}#${m.id} ${m.file_name}（${m.reason}）`);
                if (att.missingCount > att.missing.length) say(`  ……另有 ${att.missingCount - att.missing.length} 条未列出`);
                for (const er of att.errors) { result.warnings.push(`附件检查 ${er}`); say(`【注意】附件检查未能完成某张表（不阻断）：${er}`); }
            } catch (e) {
                result.warnings.push(`附件检查未能完成：${e && e.message}`);
                say(`【注意】附件检查未能完成（不阻断）：${e && e.message}`);
            }

            // 10. 线 .env
            const picked = pickEnvEntries(mainEnv);
            const jwt = crypto.randomBytes(32).toString('hex');
            const envEntries = [{ key: 'JWT_SECRET', value: jwt }, ...picked.entries];
            await step('env_file', async () => {
                for (const w of LINE_ENV_WHITELIST) if (Object.prototype.hasOwnProperty.call(LINE_ENV_NEVER, w.key) || /^sdh_/i.test(w.key)) throw new Error(`内部错误：白名单含禁拷键 ${w.key}`);
                safe(path.join('wbs-server', '.env'));
                const text = renderEnvFile(envEntries);
                const envFile = path.join(lineWbs, '.env');
                fs.writeFileSync(envFile, text, { encoding: 'utf8', flag: 'wx' });
                const back = C.readEnvFile(envFile);
                const want = {};
                for (const e of envEntries) want[e.key] = e.value;
                const same = JSON.stringify(Object.keys(back).sort()) === JSON.stringify(Object.keys(want).sort()) && Object.keys(want).every((k) => back[k] === want[k]);
                if (!same) throw new Error('线 .env 写入后回读与预期不一致（值含 dotenv 无法原样往返的字符）');
                if (Object.keys(back).some((k) => /^sdh_/i.test(k) || /^(DB_ENCRYPTION_KEY|PORT)$/i.test(k))) throw new Error('内部错误：线 .env 含禁拷键');
            });
            result.envDropped = picked.dropped.slice();
            say(`线 .env：JWT_SECRET 本线随机生成；从主 .env 拷贝 ${picked.entries.length ? picked.entries.map((e) => e.key).join('、') : '（无）'}；未拷贝的主 .env 键名：${picked.dropped.length ? picked.dropped.join('、') : '（无）'}`);

            // 11. 终核 + 转 ready
            await step('final_verify', async () => {
                const cfg = instanceMode.resolveInstanceConfig({ env: {}, checkoutDir: lineWbs });
                if (cfg.refuse || cfg.mode !== 'isolated' || cfg.kind !== 'line' || cfg.instance !== name || path.resolve(cfg.dbFile) !== path.resolve(lineDb)) {
                    throw new Error(`终核：线服务的运行模式判定不符合预期：${JSON.stringify(cfg.refuse ? { code: cfg.code, message: cfg.message } : { mode: cfg.mode, kind: cfg.kind, instance: cfg.instance, dbFile: cfg.dbFile })}`);
                }
                const id = await instanceDb.checkInstanceIdentity(lineDb, { expectedInstance: name, expectedParent: 'main' });
                if (!id.ok) throw new Error(`终核：线库身份核对失败（${id.code}）：${id.message}`);
            });
            // 步骤名不能叫 finalize：那是 line-remove 的最终登记步骤，line remove 的「删除已开始 → 放宽重试检查」只认它自己的步骤名（RELAXED_STEPS）
            result.record = await step('ready_commit', async () => upd((r) => { r.lifecycle = 'ready'; }));
        } catch (e) {
            const failedStep = e instanceof StepFailure ? e.step : 'unknown';
            const cause = e instanceof StepFailure ? e.cause : e;
            let stateNote = '';
            try {
                await upd((r) => { r.lifecycle = 'failed'; r.failed_step = failedStep; });
            } catch (e2) {
                stateNote = `（另：把线标为 failed 时登记表写入也失败：${e2 && e2.message}）`;
            }
            const tail = failedStep === 'owner_record'
                ? '。登记已标 failed（owner_record）；line remove 因归属无法证明只清登记、不删上述资源；现场交在场人员按 CLAUDE.md「建线中断（owner_record 失败）的现场处理」处理'
                : `。已建出的东西原样保留；清理请用：line remove ${name} --discard`;
            const msg = redact(`line new ${name} 失败于步骤 ${failedStep}：${cause && cause.message ? cause.message : String(cause)}${stateNote}${tail}`);
            throw new LineError('LINE_NEW_FAILED', msg, { step: failedStep, lineName: name, generation });
        }

        // ---- 开线单 ----
        const r = result.record;
        const lineDbOut = path.join(wtReal, 'wbs-server', 'task_pool.db');
        say('');
        say(`===== 开线单：${r.name} =====`);
        say(`分支：${r.branch}（自 ${integ}）`);
        say(`worktree：${r.worktree}`);
        say(`槽位 / 端口：${r.slot} / ${r.port}`);
        say(`线库：${lineDbOut}`);
        say(`模块：${r.module}`);
        say(`预计改动面：${C.surfaceText(r.surface)}`);
        say(`配置改写：${result.configRewritten.length ? result.configRewritten.join('、') : '（无）'}`);
        say(`配置丢弃：${result.configDropped.length ? result.configDropped.map((d) => `${d.key}(${d.reason})`).join('、') : '（无）'}`);
        say(`缺失附件数：${result.missingAttachments.count}`);
        say(`锚点位置：${path.join(mainRoot, 'docs', 'local', r.module)}${path.sep}`);
        say('禁区：不得改依赖（线内禁止装包）；不得用 3000 端口；不得登录生产');
        return result;
    }, { lockTimeoutMs: ctx.lineLockTimeoutMs });
}

module.exports = {
    lineNew, LINE_ENV_WHITELIST, LINE_ENV_GENERATED, LINE_ENV_NEVER, ATTACHMENT_SOURCES,
    checkAttachments, pickEnvEntries, renderEnvFile, validateArgs, realOfLoose, assertNotOtherCheckout,
};
