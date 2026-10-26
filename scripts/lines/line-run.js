/**
 * line start / stop / list / overlap / check-deps / recover（#106 多线并行改造 · S2c · 方案 W2「进程登记与停止」「命令」「依赖规则」；修复批 2）
 *
 * 只支持 Windows：start / stop 入口第一步 P.assertSupportedPlatform()，非 Windows 抛 LINE_PROC_UNSUPPORTED_PLATFORM（固定文案「本工具只支持 Windows」），不做任何其他事。
 *
 * 入口：lineStart / lineStop / lineList / lineOverlap / lineCheckDeps / lineRecover(ctx, args)，以及 dispatch(cmd, ctx, parsed) 供 line.js 分派。
 *   ctx = { controlRoot, linesRoot, mainRoot, out?, stateOpts?, lineLockTimeoutMs?, readyTimeoutMs?, stopTimeoutMs?, pollIntervalMs?, testHooks?, onSignalExit? }（根路径由调用方解析好；测试显式覆盖）。
 *
 * 修改登记的命令（start / stop / recover）全部包在 withLineLock(controlRoot, 线名, …) 里，所有 updateLine 带 expectGeneration（读到登记时的代次）。
 * list / overlap / check-deps 只读：登记在状态锁内读一次（readState），git 与文件系统命令在锁外。
 *
 * 登记的 process = { pid, start_time, cmd, instance, state }：state = 'starting'（已起子进程、尚未确认就绪）/ 'running'（就绪且监听进程核对通过）。状态层允许 process 带附加子键。
 *
 * 进程纪律：绝不按端口或进程名终止进程。
 *   stop：登记的 PID + 创建时间 + 命令行三者一致才终止（命令行不一致 → 拒绝）；服务可响应时再核 /api/version.instance（不符 → 拒绝）；
 *         只有响应里**明确给出字符串 instance 且不等于线名**才拒绝；HTTP 有响应但无法核身份（非 JSON / 正文中断 / 超限 / 超时 / JSON 里 instance 缺失、非字符串或空串）
 *         → 以命令行一致为准允许终止，输出里注明；不可响应（连不上 / 没收到响应头）→ 允许终止。
 *         PID 不存在或创建时间不一致 = PID 已死或被复用：不终止任何进程，只清空登记。查询失败（CIM 报错等）≠ 进程不存在：登记保留、不终止、明确报错。
 *   start：spawn 后取到创建时间就立即在线级锁内写 process={…, state:'starting'}（早登记），然后才轮询就绪；CLI 在轮询期间被终止（Ctrl+C / 窗口关闭 / 被强杀）时，
 *         信号处理只置中止状态并触发与主流程共享的一次性清理（收掉子进程、清登记），主流程在早登记前后与最终升级 running 之后都检查中止状态，离开线级锁前等待清理完成，中止后不输出「已启动」；
 *         被强杀时登记里留着 starting，之后 line stop 按身份终止。残余窗口：spawn 到取到创建时间之间约 0.5 秒。
 *         转发模式（从线检出调用，line.js 外层 spawnSync 转发给主工作区的 line.js）下，外层在转发期间挂空的 SIGINT / SIGBREAK / SIGHUP 监听，让外层不按默认处理直接退出（外层一退出，
 *         libuv 作业对象会立即杀掉内层，内层的信号清理就不会执行）；Ctrl+C 由内层自行收尾，外层透传退出码。
 *         失败路径只终止「自己刚起、仍持有句柄」的子进程（见 killOwn）。
 *
 * 子进程环境：当前进程环境去掉全部 SDH_*（不分大小写）、PORT、JWT_SECRET（无条件）、线 .env 里定义的全部键、禁拷键（DB_ENCRYPTION_KEY / WEBHOOK_SECRET / SYS_TEST_HOOKS），再设 PORT=<槽位端口>、SDH_INSTANCE=<线名>
 *   start 前要求线 wbs-server/.env 存在且含非空 JWT_SECRET，否则 LINE_ENV_JWT_MISSING 拒启（不 spawn）。
 *   （端口与身份只经进程环境变量传入，不写线的 .env；去掉线 .env 的键，是因为 dotenv 不覆盖已存在的环境变量，父进程里的同名变量会盖过每线随机的 JWT_SECRET 等）。
 *
 * 输出（含错误消息、日志尾部）统一经主 .env 的脱敏出口（line-common.loadMainEnv().redact）。
 *
 * 错误码（err.code，LineError）：LINE_BAD_ARGS / LINE_NO_SUCH_LINE / LINE_START_REFUSED / LINE_ENV_JWT_MISSING / LINE_ALREADY_RUNNING / LINE_DEPS_MISMATCH / LINE_PORT_BUSY / LINE_START_FAILED /
 *   LINE_STOP_REFUSED / LINE_STOP_FAILED / LINE_PROC_QUERY_FAILED / LINE_PROC_UNSUPPORTED_PLATFORM / LINE_RECOVER_REFUSED / LINE_RECOVER_BUSY / LINE_GIT_FAILED / LINE_UNSAFE_PATH。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const C = require('./line-common');
const S = require('./state');
const P = require('./line-proc');

const { LineError } = C;

const DEFAULT_READY_TIMEOUT_MS = 120000;
const DEFAULT_STOP_TIMEOUT_MS = 15000;
const DEFAULT_POLL_MS = 250;
const DEFAULT_RECOVER_LOCK_WAIT_MS = 3000;
const LOG_TAIL_LINES = 20;
const LOG_TAIL_BYTES = 65536;
/** 线 .env 不得拷贝的键（line-new.js 的禁拷名单）：即使线 .env 里没有，也不让父进程环境里的同名变量流入线服务。 */
const FORBIDDEN_ENV_KEYS = Object.freeze(['DB_ENCRYPTION_KEY', 'WEBHOOK_SECRET', 'SYS_TEST_HOOKS']);
/** 父进程环境里无条件剥离的键（不论线 .env 是否定义）：线服务的签名密钥只能来自线 .env（启动前要求它存在，见 LINE_ENV_JWT_MISSING）。 */
const ALWAYS_DROP_ENV_KEYS = Object.freeze(['JWT_SECRET']);
/** 依赖指纹文件（相对检出根；指纹口径见 depsFingerprint：排除法，package.json 只去掉顶层 version，其余参与；满足条件时整文件比对）。optional：根锁文件不受 git 跟踪（S0 A5），任一边没有就不比；必需文件任一边缺失即判「缺失」。 */
const DEPS_FILES = Object.freeze([
    Object.freeze({ rel: 'wbs-server/package.json', optional: false }),
    Object.freeze({ rel: 'wbs-server/package-lock.json', optional: false }),
    Object.freeze({ rel: 'package.json', optional: false }),
    Object.freeze({ rel: 'package-lock.json', optional: true }),
]);

// ---------------------------------------------------------------- 共用

function checkCtx(ctx) {
    for (const k of ['controlRoot', 'linesRoot', 'mainRoot']) {
        if (!C.isNonEmptyString(ctx && ctx[k])) throw new LineError('LINE_BAD_ARGS', `内部错误：缺少 ${k}`);
    }
}
function requireName(args) {
    const name = args && args.name;
    if (!C.isNonEmptyString(name)) throw new LineError('LINE_BAD_ARGS', '缺少线名');
    const problem = S.checkLineName(name);
    if (problem) throw new LineError('LINE_BAD_ARGS', `线名 ${JSON.stringify(name)} 非法：${problem}`);
    return name;
}
/** 读主 .env 建脱敏器后运行 fn(redact, say)；异常消息统一脱敏。 */
async function withRedact(ctx, fn) {
    let redact = (t) => String(t);
    try {
        const loaded = C.loadMainEnv(ctx.mainRoot);
        redact = loaded.redact;
        const sink = typeof ctx.out === 'function' ? ctx.out : (s) => console.log(s);
        return await fn(redact, (s) => sink(redact(s)));
    } catch (e) {
        throw C.scrubError(e, redact);
    }
}
function findRecord(state, name) {
    const key = Object.keys(state.lines).find((k) => k.toLowerCase() === String(name).toLowerCase());
    if (key === undefined) throw new LineError('LINE_NO_SUCH_LINE', `没有这条线：${name}`);
    return state.lines[key];
}
/** 登记表里的路径不可信任：worktree 必须就是 <线目录根>/<线名>，分支必须是 line/<线名>。返回 worktree 路径。 */
function expectedWorktree(ctx, rec) {
    const wtPath = path.join(path.resolve(ctx.linesRoot), rec.name);
    if (!C.isNonEmptyString(rec.worktree) || !C.samePath(rec.worktree, wtPath) || rec.branch !== `line/${rec.name}`) {
        throw new LineError('LINE_UNSAFE_PATH', `线 ${rec.name} 的登记路径 / 分支（${rec.worktree} / ${rec.branch}）与线目录根推导的 ${wtPath} / line/${rec.name} 不一致，拒绝（请人工核对登记表）`);
    }
    return wtPath;
}
const pidOf = (proc) => `pid ${proc.pid}`;

/**
 * 子进程环境：当前进程环境去掉全部 SDH_*、PORT、禁拷键、线 .env 里定义的全部键（均不分大小写），再设 PORT 与 SDH_INSTANCE。
 * lineEnvKeys = 线 .env 里的键名数组（由调用方读线 .env 得到）。
 */
function launchEnv(base, port, instance, lineEnvKeys) {
    // JWT_SECRET 无条件剥离（不论线 .env 里有没有）：线服务的签名密钥只能来自线自己的 .env，父环境的同名变量不得流入
    const drop = new Set(ALWAYS_DROP_ENV_KEYS.concat(FORBIDDEN_ENV_KEYS, Array.isArray(lineEnvKeys) ? lineEnvKeys : []).map((k) => String(k).toUpperCase()));
    const env = {};
    for (const k of Object.keys(base)) {
        const u = k.toUpperCase();
        if (u.startsWith('SDH_') || u === 'PORT' || drop.has(u)) continue;
        env[k] = base[k];
    }
    env.PORT = String(port);
    env.SDH_INSTANCE = instance;
    return env;
}

/** 日志末尾 N 行（只读末尾 64KB）。读不了返回说明文字。 */
function logTail(file, lines) {
    try {
        const st = fs.statSync(file);
        const start = Math.max(0, st.size - LOG_TAIL_BYTES);
        const fd = fs.openSync(file, 'r');
        try {
            const buf = Buffer.alloc(st.size - start);
            fs.readSync(fd, buf, 0, buf.length, start);
            const all = buf.toString('utf8').split(/\r?\n/);
            if (all.length && all[all.length - 1] === '') all.pop();
            return all.slice(-lines).join('\n');
        } finally { fs.closeSync(fd); }
    } catch (e) {
        return `（日志读取失败：${e && e.message}）`;
    }
}

/** 进程身份查询失败 → 统一报错：登记保留、没有终止任何进程。 */
function queryFailedError(err, lname, proc, what) {
    if (err && err.code === 'LINE_PROC_QUERY_FAILED') {
        return new LineError('LINE_PROC_QUERY_FAILED', `${what}：无法确认线 ${lname} 登记的进程（${pidOf(proc)}）的身份——${err.message}。登记保留，没有终止任何进程；请稍后重试或人工核对`, { cause: err });
    }
    return err;
}

// ---------------------------------------------------------------- 依赖指纹

/**
 * npm 安装根项目时会执行的生命周期脚本名：npm 的 lib/commands/install.js（preinstall / install / postinstall / prepublish / preprepare / prepare / postprepare）
 * 与 @npmcli/arborist 的 reify.js（predependencies / dependencies / postdependencies）。
 * package.json 的 scripts 里含其中任何一个事件（或 scripts 不是普通对象）时，安装会跑任意脚本，脚本可以读 version、config、调用其他 scripts、读环境，
 * 所以此时 package.json 整文件比对（去 CR、去 BOM）：version 也参与——代价是有这类脚本的仓库里 /deploy 改 version 会让各线 start 被拒，需各线 rebase；没有这类脚本时不受影响。
 * （整文件比对的全部触发条件见 depsFingerprint 的头注释。）
 */
const LIFECYCLE_SCRIPTS = Object.freeze(['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare', 'predependencies', 'dependencies', 'postdependencies']);

/**
 * 规范化序列化：对象键递归按字典序排序，数组保序，标量用 JSON.stringify。键顺序不同、内容相同 → 同一个串。
 * keepOrder=true 时对象键按声明顺序输出、不排序（整棵子树递归保持）：overrides 里规则的先后有语义（npm 按顺序匹配），交换顺序不能判相同。
 * 残余：类整数的键（"1"、"2"）JS 对象本来就按数值序枚举，声明顺序在 JSON.parse 之后已不可知；overrides 的键是包名，实际不会遇到。
 */
function canonicalJson(v, keepOrder) {
    if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x, keepOrder)).join(',')}]`;
    if (v !== null && typeof v === 'object') {
        const keys = keepOrder ? Object.keys(v) : Object.keys(v).sort();
        return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k], keepOrder)}`).join(',')}}`;
    }
    return JSON.stringify(v);
}
/**
 * package.json 的规范串（排除法）：整份对象去掉顶层 omitKey（只此一个键，调用方传 'version'），其余顶层键排序，其中 overrides 子树保序（其余子树照旧排序）。
 * 不另建拷贝对象（顶层键名可以是 __proto__ 之类，往普通对象上赋值会改原型）。
 */
function canonicalPackageJson(doc, omitKey) {
    return `{${Object.keys(doc).filter((k) => k !== omitKey).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(doc[k], k === 'overrides')}`).join(',')}}`;
}

/** 规范换行后的整文件 sha256：先剥开头的 UTF-8 BOM（EF BB BF），再去掉紧挨 LF 之前的 CR（CRLF → LF）。 */
function rawFingerprint(buf) {
    const start = (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) ? 3 : 0;
    const out = Buffer.allocUnsafe(buf.length - start);
    let n = 0;
    for (let i = start; i < buf.length; i += 1) {
        if (buf[i] === 0x0d && buf[i + 1] === 0x0a) continue;
        out[n] = buf[i];
        n += 1;
    }
    return crypto.createHash('sha256').update(out.subarray(0, n)).digest('hex');
}

/** 读文件；不存在（ENOENT / ENOTDIR）返回 null，其他读错误照常抛出。 */
function readOrNull(file) {
    try { return fs.readFileSync(file); } catch (e) { if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null; throw e; }
}
/** buf 按 UTF-8（去 BOM）解析成 JSON；不是合法 JSON、或顶层不是普通对象 → undefined。 */
function parseJsonObject(buf) {
    const text = buf.toString('utf8');
    let doc;
    try { doc = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); } catch (_) { return undefined; }
    return (doc !== null && typeof doc === 'object' && !Array.isArray(doc)) ? doc : undefined;
}
/** scripts 存在，且不是普通对象（含 null）或含任一安装生命周期事件。 */
function scriptsForceWhole(doc) {
    if (!Object.prototype.hasOwnProperty.call(doc, 'scripts')) return false;
    const sc = doc.scripts;
    return sc === null || typeof sc !== 'object' || Array.isArray(sc) || LIFECYCLE_SCRIPTS.some((ev) => Object.prototype.hasOwnProperty.call(sc, ev));
}
/**
 * 这个 package.json 自身是否触发整文件比对：返回原因数组（空数组 = 不触发）；文件不存在返回 null。
 * 原因：'unparsable'（不是合法 JSON 或顶层不是对象）/ 'scripts'（scripts 不是普通对象或含安装生命周期事件）/ 'binding.gyp'（同目录有 binding.gyp，npm 会隐式跑 node-gyp rebuild）。
 */
function pkgOwnWholeReasons(file) {
    const buf = readOrNull(file);
    if (buf === null) return null;
    const reasons = [];
    const doc = parseJsonObject(buf);
    if (doc === undefined) reasons.push('unparsable');
    else if (scriptsForceWhole(doc)) reasons.push('scripts');
    if (fs.existsSync(path.join(path.dirname(file), 'binding.gyp'))) reasons.push('binding.gyp');
    return reasons;
}
/** 检出根目录下的根 package.json 是否声明了 workspaces（或解析失败 / 顶层不是对象——读不懂就按声明了算）；文件不存在 → false（缺失由 computeDeps 判 missing）。 */
function rootDeclaresWorkspaces(dir) {
    const buf = readOrNull(path.join(dir, 'package.json'));
    if (buf === null) return false;
    const doc = parseJsonObject(buf);
    return doc === undefined || Object.prototype.hasOwnProperty.call(doc, 'workspaces');
}

/**
 * 依赖指纹（sha256）。口径：排除法——部署改 package.json 的 version 不算依赖变更（/deploy 每次都改，按整文件比对会让部署后所有线 start 被拒），其余内容一律参与。
 *   - package.json（按文件名）：
 *       默认（排除法）：JSON 解析后，整份对象只去掉顶层 version 这一个键，其余顶层键全部参与（不再挑「依赖相关」的字段：挑字段在 workspaces / 生命周期脚本 / overrides 顺序 / 脚本调用 / config /
 *         隐式 node-gyp / 工作区成员 name、bin 上连续三轮漏报），规范化序列化后哈希（各层键递归排序、数组保序；overrides 子树例外，保持声明顺序）；dependencies 等键的顺序不同不影响，
 *         代价：description / 非生命周期 scripts / keywords / config / name / bin 等改动也判不一致（从严误报，可接受）。
 *       整文件比对（去 CR、先剥开头的 UTF-8 BOM，version 也参与；任一条件成立即用，宁严勿松）：
 *         ① scripts 存在且不是普通对象（字符串 / 数组 / null / 数字），或含 LIFECYCLE_SCRIPTS 里任一安装生命周期事件；
 *         ② 该 package.json 同目录有 binding.gyp（npm 会隐式跑 node-gyp rebuild）；
 *         ③ 任一边检出的根 package.json 声明了 workspaces（或根 package.json 解析失败）——工作区成员的 name / version / bin 都影响链接，此时两个 package.json（根与 wbs-server）都整文件；
 *         ④ 该 package.json 本身解析失败 / 顶层不是对象（同下面的退路）。
 *       成对判定：整文件比对对「同一 rel 的两边」一致适用——任一边触发就两边都按整文件算（computeDeps 先求并集再各自计算，经 opts.wholeFile 传入；否则一边整文件、一边排除法，哈希必然不同但原因被掩盖）。
 *         depsFingerprint 单独调用且不带 opts 时，只按这个文件自己的条件（①②④）判定；③ 只有 computeDeps 能判（要读两边的根）。
 *   - package-lock.json（按文件名）：解析后删掉根的 version、name 与 packages[""] 里的 version、name（存在才删，它们跟着项目版本号走），其余整体规范化序列化后哈希；
 *     任何依赖包条目（版本 / resolved / integrity / 依赖关系）、lockfileVersion 的变化都会改变指纹。
 *   - 解析失败（不是合法 JSON，或顶层不是对象）：退回「去 BOM、去 CR 的整文件 sha256」——宁严勿松：合法的一边与坏的一边指纹不同，判不一致，绝不因为读不懂就放行；两边是同一份坏文本才算一致。
 *   - 开头的 UTF-8 BOM 解析前去掉（PowerShell 5.1 的 Set-Content -Encoding UTF8 会写 BOM，它不改变依赖内容）；整文件比对同样先剥 BOM。
 *   - 其他文件名：去 CR、去 BOM 的整文件 sha256。
 * 残余（不在比对范围，已知）：依赖包的安装脚本可以经 INIT_CWD 读到根 package.json（41-R L2）；.npmrc 不在比对范围。
 * 文件不存在（ENOENT / ENOTDIR）返回 null（computeDeps 据此判 missing / skipped）；其他读错误照常抛出。
 */
function depsFingerprint(file, opts) {
    const buf = readOrNull(file);
    if (buf === null) return null;
    const base = path.basename(file);
    if (base === 'package.json' || base === 'package-lock.json') {
        // 调用方（computeDeps 的成对判定）要求整文件，或本文件自己同目录有 binding.gyp：整文件比对
        if (base === 'package.json' && ((opts && opts.wholeFile === true) || fs.existsSync(path.join(path.dirname(file), 'binding.gyp')))) return rawFingerprint(buf);
        const doc = parseJsonObject(buf);
        if (doc !== undefined) {
            if (base === 'package.json') {
                // scripts 不是普通对象（含 null）：读不懂；是普通对象但含安装生命周期事件：整文件比对
                if (scriptsForceWhole(doc)) return rawFingerprint(buf);
                return crypto.createHash('sha256').update(canonicalPackageJson(doc, 'version')).digest('hex');
            }
            const picked = doc;
            delete picked.version;
            delete picked.name;
            const pk = picked.packages;
            if (pk !== null && typeof pk === 'object' && !Array.isArray(pk) && Object.prototype.hasOwnProperty.call(pk, '')) {
                const root = pk[''];
                if (root !== null && typeof root === 'object' && !Array.isArray(root)) { delete root.version; delete root.name; }
            }
            return crypto.createHash('sha256').update(canonicalJson(picked)).digest('hex');
        }
    }
    return rawFingerprint(buf);
}
/**
 * 比对本线与主工作区的依赖指纹。独立依赖模式不比对。返回 { independent, files: [{ rel, main, line, status, wholeFile, wholeReasons }], mismatches: [rel] }。
 * status：same / different / skipped（可选文件任一边没有）/ missing（必需文件任一边没有，含两边都没有）。mismatches 含 different 与 missing。
 * wholeFile / wholeReasons：这个文件是否按整文件比对（package.json 才可能为 true）及原因（'unparsable' / 'scripts' / 'binding.gyp' / 'workspaces'，两边的并集）；check-deps 据此标明。
 */
function computeDeps(mainRoot, wtPath, depsMode) {
    if (depsMode === 'independent') return { independent: true, files: [], mismatches: [] };
    // 任一边的根 package.json 声明了 workspaces：根与 wbs-server 两个 package.json 都整文件（只读一次）
    const wsDeclared = rootDeclaresWorkspaces(mainRoot) || rootDeclaresWorkspaces(wtPath);
    const files = DEPS_FILES.map((f) => {
        const wholeReasons = [];
        if (path.basename(f.rel) === 'package.json') {
            // 成对判定：两边各自的触发原因取并集，任一边触发两边都整文件
            for (const rs of [pkgOwnWholeReasons(path.join(mainRoot, f.rel)), pkgOwnWholeReasons(path.join(wtPath, f.rel))]) {
                for (const x of rs || []) if (!wholeReasons.includes(x)) wholeReasons.push(x);
            }
            if (wsDeclared) wholeReasons.push('workspaces');
        }
        const wholeFile = wholeReasons.length > 0;
        const main = depsFingerprint(path.join(mainRoot, f.rel), { wholeFile });
        const line = depsFingerprint(path.join(wtPath, f.rel), { wholeFile });
        let status;
        if (f.optional && (main === null || line === null)) status = 'skipped';
        else if (!f.optional && (main === null || line === null)) status = 'missing';
        else status = main === line ? 'same' : 'different';
        return { rel: f.rel, main, line, status, wholeFile, wholeReasons };
    });
    return { independent: false, files, mismatches: files.filter((f) => f.status === 'different' || f.status === 'missing').map((f) => f.rel) };
}

// ---------------------------------------------------------------- start

async function lineStart(ctx, rawArgs) {
    P.assertSupportedPlatform();   // 只支持 Windows：非 Windows 在做任何其他事之前先拒
    checkCtx(ctx);
    const name = requireName(rawArgs);
    return withRedact(ctx, (redact, say) => runStart(ctx, name, redact, say));
}

async function runStart(ctx, name, redact, say) {
    const { controlRoot } = ctx;
    const stateOpts = ctx.stateOpts || {};
    return S.withLineLock(controlRoot, name, async () => {
        const st0 = await S.readState(controlRoot, stateOpts);
        const rec = findRecord(st0, name);
        const lname = rec.name;
        const generation = rec.generation;
        const upd = (patch) => S.updateLine(controlRoot, lname, patch, Object.assign({}, stateOpts, { expectGeneration: generation }));
        if (rec.lifecycle !== 'ready') throw new LineError('LINE_START_REFUSED', `线 ${lname} 的 lifecycle=${rec.lifecycle}，只有 ready 的线能启动`);

        // 已登记进程：活着（PID + 创建时间一致）→ 拒绝；已死或 PID 被复用 → 清空登记后继续；身份查询失败 → 保留登记、报错
        if (rec.process !== null) {
            let id;
            try { id = P.checkIdentity(rec.process); } catch (e) { throw queryFailedError(e, lname, rec.process, 'line start'); }
            if (id.state === 'match') {
                const starting = rec.process.state === 'starting' ? '；登记状态为 starting（上一次 start 没走完确认，或启动它的命令行已被终止）' : '';
                throw new LineError('LINE_ALREADY_RUNNING', `线 ${lname} 已在运行（${pidOf(rec.process)}，端口 ${rec.port}${starting}）；要重启请先 line stop ${lname}`);
            }
            await upd((r) => { r.process = null; });
            say(`线 ${lname}：登记的进程（${pidOf(rec.process)}）已不存在（${id.state === 'reused' ? 'PID 已被其他进程复用' : '进程已退出'}），已清空登记`);
        }

        const wtPath = expectedWorktree(ctx, rec);
        const wbs = path.join(wtPath, 'wbs-server');
        const serverJs = path.join(wbs, 'server.js');
        const stF = C.lstatOrNull(serverJs);
        if (stF === null || !stF.isFile()) throw new LineError('LINE_START_REFUSED', `线 ${lname} 的检出里没有 wbs-server/server.js：${serverJs}`);
        let idText = null;
        try { idText = fs.readFileSync(path.join(wbs, '.sdh-instance'), 'utf8').trim(); } catch (_) { idText = null; }
        if (idText !== lname) throw new LineError('LINE_START_REFUSED', `线 ${lname} 的 wbs-server/.sdh-instance 内容（${JSON.stringify(idText)}）与线名不符，拒绝启动`);

        // 依赖检查（共享依赖不一致或必需文件缺失 → 拒绝；独立依赖不比对）
        const deps = computeDeps(ctx.mainRoot, wtPath, rec.deps_mode);
        if (deps.mismatches.length > 0) {
            throw new LineError('LINE_DEPS_MISMATCH', `线 ${lname} 是共享依赖模式，但与主工作区的依赖指纹不一致或必需依赖文件缺失：${deps.mismatches.join('、')}。线内不得改依赖；确需改依赖请在本线锚点登记，交用户在场处理`);
        }

        // 端口
        const pa = await P.portAvailable(rec.port);
        if (!pa.ok) {
            const owners = P.portOwners(rec.port);
            throw new LineError('LINE_PORT_BUSY', `端口 ${rec.port} 已被占用或不可用（${pa.reason}${owners.length ? `；监听进程 PID：${owners.join('、')}` : ''}）：不会终止任何进程，请人工处理后重试`);
        }

        // 子进程环境（去掉线 .env 定义的全部键，线 .env 才能生效）
        let lineEnvKeys;
        let lineEnv;
        try {
            lineEnv = C.readEnvFile(path.join(wbs, '.env'));
            lineEnvKeys = lineEnv === null ? [] : Object.keys(lineEnv);
        } catch (e) {
            throw new LineError('LINE_START_REFUSED', `线 ${lname} 的 wbs-server/.env 读取失败：${e && e.message}`);
        }
        // 线 .env 必须存在且含非空 JWT_SECRET（line new 为每条线生成）：父环境的 JWT_SECRET 一律不流入线服务（launchEnv 无条件剥离），
        // 线 .env 缺它就没有任何来源（server.js 自 #76 起 fail-closed，缺密钥直接拒启）——一律在这里拒启，不 spawn
        if (lineEnv === null || typeof lineEnv.JWT_SECRET !== 'string' || lineEnv.JWT_SECRET.trim() === '') {
            throw new LineError('LINE_ENV_JWT_MISSING', `线 ${lname} 的 wbs-server/.env 缺 JWT_SECRET（${lineEnv === null ? '文件不存在' : '没有这个键或值为空'}）：line new 应已生成，检查是否被改动。拒绝启动，未起任何进程。`
                + '恢复：往线 wbs-server/.env 写一个新的随机 JWT_SECRET（这条线之前签发的令牌随之失效），或 line remove 后重新 line new');
        }
        const env = launchEnv(process.env, rec.port, lname, lineEnvKeys);
        const logsDir = path.join(path.resolve(controlRoot), 'logs');
        fs.mkdirSync(logsDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[-:.]/g, '');
        const logFile = path.join(logsDir, `${lname}-${stamp}.log`);
        const fd = fs.openSync(logFile, 'wx');
        const exitInfo = { exited: false, code: null, signal: null, error: null };
        let child;
        try {
            // 脚本路径用绝对路径：登记的 cmd 与现场命令行才能整串比对（stop 的第三重核对）
            child = spawn(process.execPath, [serverJs], { cwd: wbs, env, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
        } finally {
            fs.closeSync(fd);
        }
        child.on('exit', (code, signal) => { exitInfo.exited = true; exitInfo.code = code; exitInfo.signal = signal; });
        child.on('error', (e) => { exitInfo.error = e; });
        const pid = child.pid;
        const cmd = `${process.execPath} ${serverJs}`;

        const hooks = ctx.testHooks || {};   // 仅测试用的接缝
        const stopMs = Number.isFinite(ctx.stopTimeoutMs) && ctx.stopTimeoutMs > 0 ? ctx.stopTimeoutMs : DEFAULT_STOP_TIMEOUT_MS;
        let startTime = null;       // 取到创建时间后才有值
        let registered = false;     // 早登记（starting）已写入成功
        let registerFailure = null; // 早登记写入失败的错误（registered 为 false 且这里有值 = 登记没有写成）
        let aborted = null;         // 收到的终止信号名
        let cleaned = false;        // fail() 已经带着清理结果报过错（catch 里不再重复追加）

        /**
         * 收掉自己起的子进程。返回 { gone, notes }。
         * 子进程尚未被 Node 认定退出（exitInfo.exited 为 false）：Node 仍持有它的进程句柄，PID 被句柄钉住不会被复用——此时不依赖可能失败的身份复核，
         *   直接对该 PID 做 taskkill /T（先杀树，根进程还在才找得到子孙），再 child.kill()（TerminateProcess）兜底。
         *   实测依据（修复批 1 预筛 probe_h_pid_pinned.js）：子进程已退出但 Node 仍持有其句柄（exited 仍为 false）时，PID 在 8000 次进程创建内都不会被复用；句柄关闭后 107 次内就复用。
         * 子进程已被 Node 认定退出：句柄已释放，PID 可能被复用，不能再按 PID 终止任何东西，直接判 gone（不调用 killIfIdentity：对已退出的根进程它只会得到 dead / reused，
         *   永远终止不了「应终止的东西」，查询失败时还会得出「仍未退出」这种与事实不符的提示）。根进程已退出时其遗留子孙无从按 PID 找到，登记为残余（见报告）。
         */
        const killOwn = async () => {
            const notes = [];
            if (!pid) return { gone: true, notes };
            if (hooks.killOwnFails === true) return { gone: false, notes: ['（测试注入：终止失败）'] };   // 仅测试用：模拟终止失败
            if (!exitInfo.exited) {
                P.killTree(pid);
                try { child.kill(); } catch (e) { notes.push(`child.kill 失败：${e && e.message}`); }
                return { gone: await P.waitGone(pid, stopMs), notes };
            }
            return { gone: true, notes };
        };
        /** 清空本次启动写下的登记：登记里的 pid 等于本次 pid 才清（幂等；不以 registered 为前提——早登记写入与信号清理可以交错）。返回错误或 null。 */
        const clearRegistration = async () => {
            try {
                await upd((r) => { if (r.process !== null && r.process.pid === pid) r.process = null; });
                return null;
            } catch (e) { return e; }
        };
        /** 清理本体：杀自己的子进程；确认已退出后清登记（没退出则保留登记，留给 line stop 按身份终止）。 */
        const cleanupImpl = async () => {
            const k = await killOwn();
            if (typeof hooks.cleanupDelayMs === 'number' && hooks.cleanupDelayMs > 0) await P.sleep(hooks.cleanupDelayMs);   // 仅测试用：让清理明显慢于主流程，验证主流程确实等它做完才离开线级锁
            let regErr = null;
            if (k.gone) regErr = await clearRegistration();
            try { child.unref(); } catch (_) { /* 已释放 */ }
            return { gone: k.gone, notes: k.notes, regErr };
        };
        /** 信号路径与主流程共享的一次性清理：只执行一次，所有调用方拿到同一个 Promise（主流程在离开线级锁之前 await 它）。 */
        let cleanupPromise = null;
        const cleanupOnce = () => {
            if (cleanupPromise === null) cleanupPromise = cleanupImpl();
            return cleanupPromise;
        };
        const noteText = (c) => (c.notes.length ? `；${c.notes.join('；')}` : '');
        const leftoverText = (c) => {
            if (c.gone) {
                if (!registered) return '（自己起的进程已终止；登记里没有本次启动写下的进程，登记未改）';
                return `（自己起的进程已终止${c.regErr ? `；清登记失败：${c.regErr.message}，请用 line stop ${lname} 或人工核对` : '，登记已清空'}）`;
            }
            if (registered) return `（自己起的进程 ${pid} 仍未退出，残留 PID ${pid}；登记保留为 starting，可 line stop ${lname} 按身份终止${noteText(c)}）`;
            // 登记没有写成：line stop 看不到这个进程，不能承诺它接手；写出完整进程身份，让人工处理。
            //   人工恢复不教「先核对再按裸 PID 终止」：CLI 退出后没有句柄钉住 PID，核对完成到执行之间进程退出、PID 被复用，会终止无关进程。
            //   给的是一条现成命令：同一个 PowerShell 里持句柄 → 核精确创建时间 → 再终止（创建时间不符不终止）；没取到创建时间就生成不了，如实说明且不给任何按 PID 终止的写法。
            const head = `（自己起的进程 ${pid} 仍未退出，而且登记没有写成${registerFailure ? `（早登记失败：${registerFailure.message}）` : ''}，line stop 无法接手。`
                + `进程身份：PID ${pid}，创建时间 ${startTime === null ? '（没取到）' : startTime}，命令行 ${cmd}。`;
            if (startTime === null) {
                return `${head}没取到创建时间，生成不了带身份核对的终止命令；不要按 PID 直接终止（PID 可能已被复用），请按上面的命令行在任务管理器里人工定位该进程后再处理${noteText(c)}）`;
            }
            const manual = P.buildManualKillCommand(pid, startTime);
            return `${head}人工处理：下面这一条命令在同一个 PowerShell 里持句柄、核对创建时间后才终止（创建时间不符 = PID 已被复用，不会终止），整行复制执行即可：\n`
                + `  ${manual.command}\n`
                + `该命令的脚本内容（供核对；退出码 0 已终止 / 3 进程已不存在 / 5 创建时间不符，未动 / 4 查询失败 / 6 终止失败）：\n`
                + `${manual.script.split('\n').map((l) => `    ${l}`).join('\n')}${noteText(c)}\n）`;
        };
        const fail = async (reason) => {
            cleaned = true;
            const c = await cleanupOnce();
            const tail = logTail(logFile, LOG_TAIL_LINES);
            throw new LineError('LINE_START_FAILED', `line start ${lname} 失败：${reason}${leftoverText(c)}\n日志 ${logFile} 末尾 ${LOG_TAIL_LINES} 行：\n${redact(tail)}`, { lineName: lname, logFile });
        };

        // 信号处理：CLI 在启动期间收到 Ctrl+C / Ctrl+Break / 窗口关闭时，只置中止状态并触发共享的一次性清理（被强杀没有信号，靠登记里的 starting 由 line stop 收拾）；
        //   主流程在各检查点发现中止状态后 await 同一个清理 Promise，离开线级锁前清理已完成；清理做完后才调用退出函数
        const exitProcess = typeof ctx.onSignalExit === 'function' ? ctx.onSignalExit : (code) => process.exit(code);
        const SIGNALS = ['SIGINT', 'SIGBREAK', 'SIGHUP'];
        const onSignal = (sig) => {
            aborted = sig;
            cleanupOnce().then(() => exitProcess(130), () => exitProcess(130));
        };
        const signalHandlers = SIGNALS.map((s) => { const h = () => onSignal(s); process.on(s, h); return [s, h]; });
        const removeSignalHandlers = () => { for (const [s, h] of signalHandlers) process.removeListener(s, h); };

        const proc = { pid, start_time: null, cmd, instance: lname, state: 'starting' };
        try {
            if (!pid) await fail(`spawn 没有得到 PID${exitInfo.error ? `：${exitInfo.error.message}` : ''}`);
            try { startTime = P.getStartTime(pid); } catch (e) { await fail(`取进程创建时间失败：${e && e.message}`); }
            if (startTime === null) {
                await P.sleep(200);   // 取创建时间是同步外部命令，期间事件循环被阻塞：让 exit 事件有机会派发，错误消息才带得上退出码
                await fail(exitInfo.exited ? `进程提前退出（退出码 ${exitInfo.code}${exitInfo.signal ? `，信号 ${exitInfo.signal}` : ''}）` : '进程在取创建时间之前已不存在');
            }
            if (aborted) await fail(`收到终止信号 ${aborted}`);

            // 早登记：取到创建时间就写 starting 登记，之后才轮询就绪
            proc.start_time = startTime;
            const hookInfo = { pid, startTime };   // 仅测试用的接缝都带上本次子进程的身份（测试里子进程可能在写日志之前就被收掉，取不到 PID）
            try {
                if (typeof hooks.beforeEarlyRegister === 'function') await hooks.beforeEarlyRegister(hookInfo);   // 仅测试用：早登记之前的接缝
                await upd((r) => {
                    r.process = Object.assign({}, proc);
                    if (typeof hooks.duringEarlyRegister === 'function') hooks.duringEarlyRegister(hookInfo);   // 仅测试用：补丁里（持状态锁、早登记尚未落盘）的同步接缝
                });
                registered = true;
            } catch (e) { registerFailure = e; throw e; }
            if (typeof hooks.afterEarlyRegister === 'function') await hooks.afterEarlyRegister(hookInfo);   // 仅测试用：早登记之后的接缝
            if (aborted) await fail(`收到终止信号 ${aborted}`);   // 早登记写入期间收到信号：此处才看得到，清理（含清登记）由共享的一次性清理完成

            const readyMs = Number.isFinite(ctx.readyTimeoutMs) && ctx.readyTimeoutMs > 0 ? ctx.readyTimeoutMs : DEFAULT_READY_TIMEOUT_MS;
            const pollMs = Number.isFinite(ctx.pollIntervalMs) && ctx.pollIntervalMs > 0 ? ctx.pollIntervalMs : DEFAULT_POLL_MS;
            const deadline = Date.now() + readyMs;
            let seen = '（尚无响应）';
            for (;;) {
                if (aborted) await fail(`收到终止信号 ${aborted}`);
                if (exitInfo.error) await fail(`子进程出错：${exitInfo.error.message}`);
                if (exitInfo.exited) await fail(`进程提前退出（退出码 ${exitInfo.code}${exitInfo.signal ? `，信号 ${exitInfo.signal}` : ''}）`);
                const v = await P.httpGetJson(rec.port, '/api/version', Math.max(300, Math.min(2000, deadline - Date.now())));
                if (v.kind === 'ok' && v.json.instance === lname && v.json.mode === 'isolated') break;
                seen = v.kind === 'ok' ? `/api/version 返回 mode=${JSON.stringify(v.json.mode)} instance=${JSON.stringify(v.json.instance)}`
                    : (v.kind === 'badbody' ? `HTTP ${v.status} 但不是 JSON 对象` : (v.kind === 'broken' ? `HTTP ${v.status} 响应不完整（${v.error}）` : `连接失败（${v.error}）`));
                if (Date.now() >= deadline) await fail(`等待就绪超时（${readyMs}ms 内 /api/version 没有返回 instance=${lname} 且 mode=isolated；最后一次：${seen}）`);
                await P.sleep(pollMs);
            }
            if (aborted) await fail(`收到终止信号 ${aborted}`);
            // 就绪响应必须来自本次启动的子进程：端口的监听进程必须恰好是子进程自己（端口被别的进程抢占后冒充同名同模式的响应，仅凭 HTTP 内容分不出来）。不终止监听该端口的其他进程。
            if (exitInfo.exited) await fail(`收到就绪响应时本次启动的子进程已退出（退出码 ${exitInfo.code}）：响应不是它发出的`);
            const owners = P.portListeners(rec.port);
            if (owners === null) await fail(`无法核实端口 ${rec.port} 的监听进程（netstat / lsof 失败），不能确认就绪响应来自本次启动的子进程`);
            if (!(owners.length === 1 && owners[0] === pid)) {
                await fail(`就绪响应不是本次启动的子进程发出的：端口 ${rec.port} 的监听进程 PID = [${owners.join('、')}]，本次子进程 PID = ${pid}（疑似端口被其他进程抢占后冒充；也可能是同端口其他地址上的监听者）；没有终止监听该端口的进程`);
            }

            if (typeof hooks.beforeRegister === 'function') await hooks.beforeRegister(hookInfo);   // 仅测试用：就绪确认、登记升级 running 之前的接缝
            await upd((r) => {
                if (r.process === null || r.process.pid !== pid) throw new LineError('LINE_START_FAILED', `线 ${lname} 的登记在启动期间被改动（process 已不是本次启动写下的 pid ${pid}），不升级为 running`);
                r.process = Object.assign({}, r.process, { state: 'running' });
                if (typeof hooks.duringRunningUpgrade === 'function') hooks.duringRunningUpgrade(hookInfo);   // 仅测试用：补丁里（持状态锁、升级尚未落盘）的同步接缝
            });
            proc.state = 'running';
            // 最终登记之后再查一次中止状态：信号在最后一次登记写入期间到达时，前面的检查点都已通过；此处发现则走共享清理（含清登记），不输出「已启动」
            if (aborted) await fail(`收到终止信号 ${aborted}`);
        } catch (e) {
            // 任何异常（含 fail() 抛出的）都等共享的一次性清理做完再离开（线级锁在清理完成之后才释放）；fail() 已带着清理结果报过错的不再重复追加
            const c = await cleanupOnce();
            if (!cleaned && e && typeof e.message === 'string') e.message = `${e.message}${aborted ? `（同时收到了终止信号 ${aborted}）` : ''}${leftoverText(c)}`;
            removeSignalHandlers();
            throw e;
        }
        removeSignalHandlers();
        child.unref();
        say(`线 ${lname} 已启动：${pidOf(proc)}，端口 ${rec.port}，创建时间 ${startTime}`);
        say(`日志：${logFile}`);
        return { name: lname, pid, port: rec.port, startTime, logFile };
    }, { lockTimeoutMs: ctx.lineLockTimeoutMs });
}

// ---------------------------------------------------------------- stop

async function lineStop(ctx, rawArgs) {
    P.assertSupportedPlatform();   // 只支持 Windows：非 Windows 在做任何其他事之前先拒
    checkCtx(ctx);
    const name = requireName(rawArgs);
    return withRedact(ctx, (redact, say) => runStop(ctx, name, say));
}

async function runStop(ctx, name, say) {
    const { controlRoot } = ctx;
    const stateOpts = ctx.stateOpts || {};
    return S.withLineLock(controlRoot, name, async () => {
        const st0 = await S.readState(controlRoot, stateOpts);
        const rec = findRecord(st0, name);
        const lname = rec.name;
        const upd = (patch) => S.updateLine(controlRoot, lname, patch, Object.assign({}, stateOpts, { expectGeneration: rec.generation }));
        if (rec.process === null) {
            say(`线 ${lname} 未运行（登记里没有进程）`);
            return { name: lname, stopped: false, cleared: false, reason: 'not-running' };
        }
        const proc = rec.process;
        const clearStale = async (why) => {
            await upd((r) => { r.process = null; });
            say(`线 ${lname}：登记的进程已不存在，已清空登记（${pidOf(proc)}：${why}）；没有终止任何进程`);
            return { name: lname, stopped: false, cleared: true, reason: why };
        };
        // 1. PID + 创建时间（查询失败 → 登记保留、不终止、报错）
        let id;
        try { id = P.checkIdentity(proc); } catch (e) { throw queryFailedError(e, lname, proc, 'line stop'); }
        if (id.state !== 'match') return clearStale(id.state === 'reused' ? 'PID 已被其他进程复用（创建时间不一致）' : '进程已退出');
        // 2. 命令行：与登记的 cmd（线检出的 node 与 server.js 路径）整串比对，所有路径都核，不依赖 HTTP
        if (!P.cmdMatches(proc.cmd, id.info)) {
            throw new LineError('LINE_STOP_REFUSED', `${pidOf(proc)} 的现场命令行（${JSON.stringify(id.info && id.info.cmdline)}）与登记的命令（${JSON.stringify(proc.cmd)}）不一致，拒绝终止；登记未改，请人工核对`);
        }
        // 3. 服务可响应时核实例身份：连接层失败 / 没收到响应头 = 不可响应，允许终止；响应里**明确给出字符串 instance 且不等于线名** = 拒绝；
        //    有 HTTP 响应但无法核身份（非 JSON / 正文中断 / 超限 / 超时，或合法 JSON 但 instance 缺失 / 非字符串 / 空串，如 {} 或 {"error":"…"}）= 命令行一致已核过，按进程身份终止并注明
        const v = await P.httpGetJson(rec.port, '/api/version', 3000);
        if (v.kind === 'ok') {
            const inst = v.json.instance;
            if (typeof inst === 'string' && inst !== '') {
                if (inst !== lname) {
                    throw new LineError('LINE_STOP_REFUSED', `端口 ${rec.port} 上的服务返回的实例身份（${JSON.stringify(inst)}）与线名 ${lname} 不符，拒绝终止 ${pidOf(proc)}；登记未改，请人工核对`);
                }
            } else {
                say(`线 ${lname}：端口 ${rec.port} 的服务响应里没有可用的实例身份（instance 缺失、不是字符串或为空），无法核实例身份；${pidOf(proc)} 的创建时间与命令行均与登记一致，按进程身份终止`);
            }
        }
        if (v.kind === 'badbody' || v.kind === 'broken') {
            say(`线 ${lname}：端口 ${rec.port} 的服务响应异常（${v.kind === 'badbody' ? `HTTP ${v.status} 但不是 JSON 对象` : `HTTP ${v.status} 响应不完整：${v.error}`}），无法核实例身份；${pidOf(proc)} 的创建时间与命令行均与登记一致，按进程身份终止`);
        }
        // 4. 终止前同句柄再核一次身份并终止进程树
        let k;
        try { k = P.killIfIdentity(proc); } catch (e) { throw queryFailedError(e, lname, proc, 'line stop'); }
        if (!k.killed) {
            if (k.state === 'match') throw new LineError('LINE_STOP_FAILED', `对 ${pidOf(proc)} 的终止命令（taskkill）报告失败；登记保留，请人工核对`);
            return clearStale(k.state === 'reused' ? 'PID 已被其他进程复用（创建时间不一致）' : '进程已退出');
        }
        const gone = await P.waitGone(proc.pid, Number.isFinite(ctx.stopTimeoutMs) && ctx.stopTimeoutMs > 0 ? ctx.stopTimeoutMs : DEFAULT_STOP_TIMEOUT_MS);
        if (!gone) throw new LineError('LINE_STOP_FAILED', `已对 ${pidOf(proc)} 发出终止，但它仍未退出；登记保留，请人工核对`);
        await upd((r) => { r.process = null; });
        say(`线 ${lname} 已停止（${pidOf(proc)}），登记已清空`);
        return { name: lname, stopped: true, cleared: true, reason: 'stopped' };
    }, { lockTimeoutMs: ctx.lineLockTimeoutMs });
}

// ---------------------------------------------------------------- git 事实（list / overlap 共用）

/**
 * 取一条线相对集成分支的 git 事实。不抛 git 错误：取不到的字段为 null，原因写进 notes。
 * complete：已提交改动与未提交改动两个来源都取到了。任一来源未知时 files 只是部分数据，overlap 必须标「数据不完整」。
 */
function gitFacts(mainRoot, rec, integ, wtKeys) {
    const facts = { ahead: null, behind: null, uncommitted: null, uncommittedFiles: null, committedFiles: null, mergeBase: null, files: null, complete: false, notes: [] };
    const integRef = `refs/heads/${integ}`;
    const branchRef = C.isNonEmptyString(rec.branch) ? `refs/heads/${rec.branch}` : null;
    const hasRef = (ref) => ref !== null && C.gitTry(mainRoot, ['rev-parse', '--verify', '--quiet', ref]).status === 0;
    const haveBranch = hasRef(branchRef);
    const haveInteg = hasRef(integRef);
    if (!haveBranch) facts.notes.push(`分支 ${rec.branch || '（未登记）'} 不存在`);
    if (!haveInteg) facts.notes.push(`集成分支 ${integ} 不存在`);
    if (haveBranch && haveInteg) {
        const rl = C.gitTry(mainRoot, ['rev-list', '--left-right', '--count', `${integRef}...${branchRef}`, '--']);
        const m = /^(\d+)\s+(\d+)$/.exec(rl.stdout.trim());
        if (rl.status === 0 && m) { facts.behind = Number(m[1]); facts.ahead = Number(m[2]); } else facts.notes.push(`领先落后数取不到：${rl.stderr.trim()}`);
        const mb = C.gitTry(mainRoot, ['merge-base', integRef, branchRef]);
        if (mb.status === 0 && /^[0-9a-f]{40}$/.test(mb.stdout.trim())) {
            facts.mergeBase = mb.stdout.trim();
            const d = C.gitTry(mainRoot, ['diff', '--name-only', '-z', '--no-renames', facts.mergeBase, branchRef, '--']);
            if (d.status === 0) facts.committedFiles = d.stdout.split('\0').filter((s) => s !== '');
            else facts.notes.push(`提交改动文件取不到：${d.stderr.trim()}`);
        } else facts.notes.push('merge-base 取不到（线分支与集成分支没有共同祖先？）');
    }
    // 未提交改动：只在 worktree 是已登记的检出时才跑 status（路径不在 git worktree list 里就不跑，防止 git 向上找到别的仓库）
    if (C.isNonEmptyString(rec.worktree) && C.lstatOrNull(rec.worktree) !== null && wtKeys.includes(C.pathKey(rec.worktree))) {
        const s = C.gitTry(rec.worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']);
        if (s.status === 0) {
            const files = [];
            for (const ent of s.stdout.split('\0')) {
                if (ent.length < 4) continue;
                const p = ent.slice(3);
                if (p === C.OWNER_MARKER) continue;
                files.push(p);
            }
            facts.uncommittedFiles = files;
            facts.uncommitted = files.length;
        } else facts.notes.push(`未提交改动取不到：${s.stderr.trim()}`);
    } else facts.notes.push('worktree 不存在或不是已登记的检出，未提交改动未知');
    if (facts.committedFiles !== null || facts.uncommittedFiles !== null) {
        facts.files = Array.from(new Set([...(facts.committedFiles || []), ...(facts.uncommittedFiles || [])])).sort();
    }
    facts.complete = facts.committedFiles !== null && facts.uncommittedFiles !== null;
    return facts;
}

const sortedUnique = (a) => Array.from(new Set(a)).sort();

// ---------------------------------------------------------------- list

function procFacts(proc) {
    if (proc === null) return { state: 'none', label: '未运行', pid: null };
    try {
        const id = P.checkIdentity(proc);
        if (id.state === 'match') {
            if (proc.state === 'starting') return { state: 'starting', label: '启动中（登记 starting，进程存活）', pid: proc.pid };
            return { state: 'running', label: '运行中', pid: proc.pid };
        }
        return { state: 'stale', label: '登记失效', pid: proc.pid, detail: id.state === 'reused' ? 'PID 已被复用' : '进程已退出' };
    } catch (e) {
        return { state: 'unknown', label: '无法确认', pid: proc.pid, detail: e && e.message };
    }
}

async function lineList(ctx, rawArgs) {
    checkCtx(ctx);
    const json = !!(rawArgs && rawArgs.json);
    return withRedact(ctx, async (redact, say) => {
        const st = await S.readState(ctx.controlRoot, ctx.stateOpts || {});   // 锁内读一次；之后全部在锁外
        const integ = st.config.integration_branch || 'main';
        const wtKeys = C.registeredWorktreeKeys(ctx.mainRoot);
        const recs = Object.values(st.lines).sort((a, b) => a.slot - b.slot);
        const rows = recs.map((rec) => {
            const f = gitFacts(ctx.mainRoot, rec, integ, wtKeys);
            return {
                name: rec.name, lifecycle: rec.lifecycle, failed_step: rec.failed_step, integration: rec.integration, yield_request: rec.yield_request,
                module: rec.module, branch: rec.branch, slot: rec.slot, port: rec.port, deps_mode: rec.deps_mode,
                ahead: f.ahead, behind: f.behind, uncommitted: f.uncommitted, changed_files: f.files, changed_files_complete: f.complete, process: procFacts(rec.process), notes: f.notes,
            };
        });
        const result = { integration_branch: integ, integration_ref: `refs/heads/${integ}`, lines: rows };
        if (json) { say(JSON.stringify(result, null, 2)); return result; }
        if (rows.length === 0) { say('（没有线）'); return result; }
        for (const r of rows) {
            const ig = r.integration && r.integration.state ? r.integration.state : '?';
            say(`线 ${r.name}  [${r.lifecycle}${r.failed_step ? `:${r.failed_step}` : ''}]  集成：${ig}  让行请求：${r.yield_request ? '有' : '无'}  槽位/端口：${r.slot}/${r.port}  依赖：${r.deps_mode}`);
            say(`  分支 ${r.branch}（相对 refs/heads/${integ}）领先 ${r.ahead === null ? '?' : r.ahead} 落后 ${r.behind === null ? '?' : r.behind}  未提交改动 ${r.uncommitted === null ? '?' : r.uncommitted}`);
            say(`  进程：${r.process.label}${r.process.pid ? `（pid ${r.process.pid}）` : ''}${r.process.detail ? `  ${r.process.detail}` : ''}`);
            say(`  已改文件${r.changed_files === null ? '：?' : `（${r.changed_files.length}${r.changed_files_complete ? '' : '，数据不完整'}）：${r.changed_files.length ? r.changed_files.join('、') : '（无）'}`}`);
            for (const n of r.notes) say(`  【注意】${n}`);
        }
        return result;
    });
}

// ---------------------------------------------------------------- overlap

const intersect = (a, b) => { const s = new Set(b); return a.filter((x) => s.has(x)); };

async function lineOverlap(ctx, rawArgs) {
    checkCtx(ctx);
    const name = requireName(rawArgs);
    const json = !!(rawArgs && rawArgs.json);
    return withRedact(ctx, async (redact, say) => {
        const st = await S.readState(ctx.controlRoot, ctx.stateOpts || {});
        const rec = findRecord(st, name);
        const integ = st.config.integration_branch || 'main';
        const wtKeys = C.registeredWorktreeKeys(ctx.mainRoot);
        const own = gitFacts(ctx.mainRoot, rec, integ, wtKeys);
        if (own.files === null || own.mergeBase === null) {
            throw new LineError('LINE_GIT_FAILED', `取不到线 ${rec.name} 的改动文件：${own.notes.join('；')}`);
        }
        if (own.uncommittedFiles === null) own.notes.push('未提交改动未知，交集可能不完整');
        const integRef = `refs/heads/${integ}`;
        const di = C.gitTry(ctx.mainRoot, ['diff', '--name-only', '-z', '--no-renames', own.mergeBase, integRef, '--']);
        if (di.status !== 0) throw new LineError('LINE_GIT_FAILED', `取集成分支自 merge-base 以来的改动失败：${di.stderr.trim()}`);
        const integFiles = sortedUnique(di.stdout.split('\0').filter((s) => s !== ''));
        const result = {
            name: rec.name, integration_ref: integRef, merge_base: own.mergeBase, own_files: own.files, own_complete: own.complete,
            with_integration: { changed: integFiles, overlap: intersect(own.files, integFiles), incomplete: !own.complete },
            with_lines: [], notes: own.notes.slice(),
        };
        for (const other of Object.values(st.lines)) {
            if (other.name === rec.name) continue;
            const f = gitFacts(ctx.mainRoot, other, integ, wtKeys);
            if (f.files === null) {
                result.with_lines.push({ name: other.name, lifecycle: other.lifecycle, changed: null, overlap: null, incomplete: true, notes: f.notes });
                continue;
            }
            // 任一来源未知（提交 / 未提交）时 changed 只是部分数据：overlap 照算但标 incomplete，不能呈现成确定的零重叠
            result.with_lines.push({ name: other.name, lifecycle: other.lifecycle, changed: f.files, overlap: intersect(own.files, f.files), incomplete: !f.complete || !own.complete, notes: f.notes });
        }
        if (json) { say(JSON.stringify(result, null, 2)); return result; }
        const warn = (incomplete) => (incomplete ? '（数据不完整，见下方注意）' : '');
        say(`线 ${rec.name} 的改动文件 ${own.files.length} 个（提交 + 未提交）：${own.files.length ? own.files.join('、') : '（无）'}`);
        const wi = result.with_integration;
        say(`与集成分支 ${integRef}（自 merge-base ${own.mergeBase.slice(0, 10)} 以来改了 ${wi.changed.length} 个文件）重叠 ${wi.overlap.length} 个${warn(wi.incomplete)}${wi.overlap.length ? `：\n${wi.overlap.map((f) => `  ${f}`).join('\n')}` : ''}`);
        if (result.with_lines.length === 0) say('没有其他未删除的线');
        for (const o of result.with_lines) {
            if (o.overlap === null) say(`与线 ${o.name}（${o.lifecycle}）：无法取得其改动（${o.notes.join('；')}）`);
            else say(`与线 ${o.name}（${o.lifecycle}，改了 ${o.changed.length} 个文件）重叠 ${o.overlap.length} 个${warn(o.incomplete)}${o.overlap.length ? `：\n${o.overlap.map((f) => `  ${f}`).join('\n')}` : ''}`);
            for (const n of o.notes) say(`  【注意】线 ${o.name}：${n}`);
        }
        for (const n of result.notes) say(`【注意】${n}`);
        return result;
    });
}

// ---------------------------------------------------------------- check-deps

async function lineCheckDeps(ctx, rawArgs) {
    checkCtx(ctx);
    const name = requireName(rawArgs);
    return withRedact(ctx, async (redact, say) => {
        const st = await S.readState(ctx.controlRoot, ctx.stateOpts || {});
        const rec = findRecord(st, name);
        if (rec.deps_mode === 'independent') {
            say(`线 ${rec.name} 是独立依赖模式（deps_mode=independent）：不与主工作区比对`);
            return { name: rec.name, independent: true, files: [], mismatches: [] };
        }
        const wtPath = expectedWorktree(ctx, rec);
        if (C.lstatOrNull(wtPath) === null) throw new LineError('LINE_UNSAFE_PATH', `线 ${rec.name} 的 worktree 不存在：${wtPath}`);
        const deps = computeDeps(ctx.mainRoot, wtPath, rec.deps_mode);
        const short = (h) => (h === null ? '（无）' : h.slice(0, 12));
        const label = { same: '一致', skipped: '跳过（根锁文件不受 git 跟踪，任一边没有就不比）', different: '不一致', missing: '缺失（必需依赖文件，任一边没有都不能共享依赖）' };
        const REASON = { unparsable: '解析失败或顶层不是对象', scripts: '含安装生命周期脚本或 scripts 不是普通对象', 'binding.gyp': '同目录有 binding.gyp', workspaces: '根 package.json 声明了 workspaces（或解析失败）' };
        for (const f of deps.files) {
            const kind = f.wholeFile
                ? `整文件指纹（原因：${f.wholeReasons.map((x) => REASON[x] || x).join('；')}；去 CR、去 BOM，version 也参与）`
                : (path.basename(f.rel) === 'package.json' ? '依赖口径指纹（排除法：整份去掉顶层 version，其余全部参与）' : '依赖口径指纹（锁文件去掉根 name / version）');
            say(`  ${f.rel}：${kind}  主 ${short(f.main)}  线 ${short(f.line)}  ${label[f.status]}`);
        }
        if (deps.mismatches.length > 0) {
            throw new LineError('LINE_DEPS_MISMATCH', `线 ${rec.name} 与主工作区的依赖指纹不一致或必需依赖文件缺失：${deps.mismatches.join('、')}`, { mismatches: deps.mismatches });
        }
        say(`线 ${rec.name}：依赖指纹与主工作区一致`);
        return { name: rec.name, independent: false, files: deps.files, mismatches: [] };
    });
}

// ---------------------------------------------------------------- recover

/**
 * 只处理 lifecycle=creating 的线：能拿到该线的线级锁，就证明建线进程已不在 → 转 failed，failed_step='interrupted'，
 * 之后可用 line remove <线名> --discard 清理。拿不到锁（等待 ctx.lineLockTimeoutMs，默认 3 秒）→ 报「建线仍在进行」，什么都不改。
 *
 * 依赖的不变量：凡是写 lifecycle='creating' 的操作，在整个 creating 期间都持有该线的线级锁（目前只有 line new 的 createLine 这一处）。
 *   以后若新增另一处写 creating 的操作而没有在 creating 期间持锁，「拿到锁 = 创建进程已不在」就不再成立，recover 会误改一个仍在进行的操作；新增者必须同步改这里。
 */
async function lineRecover(ctx, rawArgs) {
    checkCtx(ctx);
    const name = requireName(rawArgs);
    return withRedact(ctx, (redact, say) => runRecover(ctx, name, say));
}

async function runRecover(ctx, name, say) {
    const { controlRoot } = ctx;
    const stateOpts = ctx.stateOpts || {};
    const body = async () => {
        const st0 = await S.readState(controlRoot, stateOpts);
        const rec = findRecord(st0, name);
        if (rec.lifecycle !== 'creating') throw new LineError('LINE_RECOVER_REFUSED', `线 ${rec.name} 的 lifecycle=${rec.lifecycle}：recover 只处理 creating（建线被中断留下的残留）`);
        await S.updateLine(controlRoot, rec.name, (r) => { r.lifecycle = 'failed'; r.failed_step = 'interrupted'; }, Object.assign({}, stateOpts, { expectGeneration: rec.generation }));
        say(`线 ${rec.name}：建线已中断（拿到了线级锁，说明建线进程已不在），lifecycle=failed，failed_step=interrupted；清理请用：line remove ${rec.name} --discard`);
        return { name: rec.name, recovered: true };
    };
    try {
        return await S.withLineLock(controlRoot, name, body, { lockTimeoutMs: Number.isFinite(ctx.lineLockTimeoutMs) ? ctx.lineLockTimeoutMs : DEFAULT_RECOVER_LOCK_WAIT_MS });
    } catch (e) {
        if (e && e.code === 'STATE_LINE_BUSY') throw new LineError('LINE_RECOVER_BUSY', `建线仍在进行（线 ${name} 的线级锁被占用，持有者仍活着），不处理`, { cause: e });
        throw e;
    }
}

// ---------------------------------------------------------------- 分派

const HANDLERS = Object.freeze({ start: lineStart, stop: lineStop, list: lineList, overlap: lineOverlap, 'check-deps': lineCheckDeps, recover: lineRecover });
const COMMANDS = Object.freeze(Object.keys(HANDLERS));

/** line.js 的分派入口：parsed = { cmd, name, opts }。 */
async function dispatch(cmd, ctx, parsed) {
    const handler = HANDLERS[cmd];
    if (!handler) throw new LineError('LINE_BAD_ARGS', `未知子命令：${cmd}`);
    const opts = parsed.opts || {};
    const c = Object.assign({}, ctx);
    if (opts.readyTimeoutSec !== undefined) c.readyTimeoutMs = opts.readyTimeoutSec * 1000;
    return handler(c, { name: parsed.name, json: !!opts.json });
}

module.exports = {
    lineStart, lineStop, lineList, lineOverlap, lineCheckDeps, lineRecover, dispatch, COMMANDS,
    launchEnv, depsFingerprint, computeDeps, gitFacts, logTail, DEPS_FILES, FORBIDDEN_ENV_KEYS,
};
