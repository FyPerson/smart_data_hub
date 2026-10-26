/**
 * #106 S3b 套件：测试入口助手 scripts/lib/test-env.js + 共享夹具 scripts/_test-fixture.js + 已改造脚本的静态守卫
 *
 * 由 verify-test-env.js（薄入口）经共享监督进程 lines-test-supervisor.js 运行；也可直接 node 运行（无超时回收保护，仅调试用）。
 *
 * 安全约束（本套件自己的）：
 *   - 只用自建的合成库与合成「检出」目录（私有临时根 PRIV）；测试密钥自己生成；不读任何 .env、不打开任何 task_pool.db：
 *     套件进程在加载被测模块之前就给 sqlite3.Database 装了路径守卫（只放行私有根 PRIV 内的库，越界立即抛错并记录；每次打开都记账——路径与打开标志，供「业务库从未被打开」「身份核对 / 签 token 只读打开」的断言使用）；
 *   - 辅助子进程（helper.js）同样在加载被测模块之前经 node --require 装上共享预加载片段 test-reap-preload.js（sqlite3 路径守卫 + 私有根外 .env 读取守卫 + 启动器句柄立即登记），违规追加到 per-run 记录文件并抛错，
 *     父进程读回、汇总进 Z.1 / Z.2 判红；辅助进程的环境先清掉宿主的 TEST_INSTANCE / TEST_BASE_URL / TEST_DB_PATH / TEST_JWT_SECRET / TEST_TARGET / TEST_LIVE_URL（不分大小写）再注入本用例的值；
 *     套件进程自己的环境也在启动时做同样的清理（否则宿主残留的变量组会让「全部缺省」的用例悄悄走变量组形态）；
 *   - 变量组形态的用例一律注入合成的检出目录（deps.wbsDir）与环境（deps.env），所以 test-env 不会去读本检出的 .env；
 *   - 自起实例的用例通过 serverJs 选项启动私有根里的桩服务（只应答 /api/version、/api/health/ready、回显路径），来源库是合成的小库；
 *   - 套件进程把 TEMP / TMP 指向 PRIV/tmp：所有 sdh-test-* 数据根都落在私有根里，不碰本机其他会话的临时目录；
 *   - 终止进程只终止自己用 spawn 起的子进程（句柄在手），或按「PID + 精确创建时间」核对后终止（killIfIdentity）；
 *   - 回收与删除闸门全部走共享回收模块 lib/test-reap.js（修复批 2b，13T-R H1 / H2；模块归 S3c，本套件只使用）：
 *       · 登记：套件主进程里启动器交出的每一个服务（含并发 / 非幂等 / 中途失败的）经包在 startTestInstance 外面的包装 + 每次 ready() 的返回值，用 reaper.trackInstance 写进私有根里的登记文件；
 *         套件自己 spawn 的辅助进程 / 监督进程用 reaper.trackChild 登记（PID + 精确创建时间 + 归属）；
 *       · 辅助进程 `--require` 共享预加载片段 lib/test-reap-preload.js：它在加载被测模块之前装库路径守卫与 `.env` 读取守卫（替换了本套件原来的辅助进程守卫，覆盖面只多不少），
 *         并包住启动器，句柄一返回就写登记（不等 ready() 返回），所以辅助进程被父进程超时杀掉、或异常退出时，它起的服务照样能按身份回收（F.24 原样启动器、F.25 服务 detached 的孤儿）；
 *       · 最外层收尾：等待未落定的启动 → reapAll（有截止；按「句柄 / PID + 创建时间」回收，数据根确认进程消失后才删）→ finalGate（终检新鲜读登记、逐项核身份；额外输入见 gateExtraReasons：局部登记来源、辅助进程登记失败、违规记录文件问题、主流程 / 收尾阶段异常）→ 判安全才删私有根，否则判红并保留现场、打印路径（Z.5）。
 *         **私有根整根删除的唯一出口是 deleteRootIfSafe**（另有 3 处 removeDataRoot 删的是实例数据根，各以该实例的服务身份已消失为前提）。
 *         Z.3 / Z.4 / F.15 的口径是 left / forced / verify。节 R 用诱饵证明闸门判不安全时目录保留、判安全时才删；`--force-unsafe` 接缝在最外层造一个回收之后才出现的登记进程，Z.6 要求私有根因此保留；
 *       · 监督层（节 T）：入口启用 reap: true；登记同步镜像到监督进程的登记文件。替身套件起辅助进程、辅助进程起服务后被杀、替身套件挂起并被独立监督进程超时强杀——服务成了树终止够不到的孤儿，由监督进程按登记回收。
 *
 *   - 修复批 2a：退出码兜底（F.20–F.23：辅助进程走真实注册的 beforeExit / exit 监听器，五种收尾 × 自起 / 变量组 / live 三种形态）；耗时一律用单调时钟（performance.now），F.17b / F.17c 借启动器的终止等待截止注入接缝
 *     （辅助进程里设成 30 秒）区分「遗留计时器」与正常，阈值 10 秒；静态守卫的 ready() 位置改为硬规则（模块顶层只有声明与一个入口调用，`await ready()` 是入口函数里第一条有副作用的语句）；
 *   - 收口小批（S3b 最后一批）：
 *       · 退出码兜底靠「是否显式调用过 process.exit」判定（F.23b–F.23d：别家 beforeExit 监听器注册在 ready() 前 / 后 × 同步·nextTick·微任务·setImmediate·setTimeout(0)，无参 process.exit()）；
 *       · 最外层闸门的输入补全（13T-R2 H1 / H2 / M3）：节 R 的诱饵同时登记到主回收器；节 R / 节 T 的局部登记来源「开了就必须关」（终检通过 / 读取无 problems 并入主回收器才关），没关上 = 判不安全；
 *         节 T 的读取与并入走必经的 finally；辅助进程的登记写失败、违规记录文件的读取 / 解析失败都是持久的闸门原因；私有根建好后立即有异常边界（被测模块延后到 main() 里加载），收尾各阶段独立捕获并累计；
 *       · 节 S 把本套件当子进程再跑一遍，带 --seam=<名字> 造一种「不安全 / 收尾出错」的局面，要求私有根保留 + 点名原因 + 汇总行照常输出（对 pendingStarts / pendingTimedOut 的接线各有一个只让它单独成立的场景）；
 *       · 静态守卫（节 H）：入口函数参数默认值必须纯、ready() 只认 test-env / _test-fixture 的导入绑定、H.19 按「await teardown() 或 process.exit(…)」二选一并查实际调用关系、顶层同名函数声明 R6、
 *         .verbose() 限定 sqlite3、入口链 .catch 必须以非零退出（D-1，R7）。
 *
 * 参数：--only=<节,节>（setup 总是跑；节名 A B C D E F G H R S T）、--test-env=<被测 test-env.js 绝对路径>、--fixture=<被测 _test-fixture.js 绝对路径>、--summary-file=<汇总 JSON 路径>、
 *   --reap=<回收模块>、--preload=<预加载片段>、--ti=<辅助进程里预加载片段要包的启动器>、--entry=<薄入口>、--force-unsafe、--seam=<接缝名>（节 S 的子进程用，见 SEAMS）。
 *   这些都是变异自证用的接缝，正常运行不传。
 * 输出：每条断言一行 `CHECK <编号> PASS|FAIL <标题>`；末行 `verify-test-env PASS=<n> FAIL=<n>`。退出码 0 = 全绿。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { performance } = require('perf_hooks');

const WBS = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const argVal = (p) => { const a = args.find((x) => x.startsWith(p)); return a ? a.slice(p.length) : null; };

// 受控挂起夹具（监督进程自检用）：分支必须在创建任何东西之前。
if (argVal('--hang-fixture=') !== null) {
    require('./lines-test-supervisor.js').runHangFixture(argVal('--hang-fixture='));
}

const TE_PATH = argVal('--test-env=') || path.join(__dirname, 'lib', 'test-env.js');
const FX_PATH = argVal('--fixture=') || path.join(__dirname, '_test-fixture.js');
const SUMMARY_FILE = argVal('--summary-file=');
const REAP_PATH = argVal('--reap=') || path.join(__dirname, 'lib', 'test-reap.js');
const PRELOAD_PATH = argVal('--preload=') || path.join(__dirname, 'lib', 'test-reap-preload.js');
const TI_PATH = argVal('--ti=') || path.join(__dirname, 'lib', 'test-instance.js');   // 辅助进程里预加载片段要包的启动器（变异自证时是启动器副本，与被测 test-env 副本 require 的是同一份）
const ENTRY_PATH = argVal('--entry=') || path.join(__dirname, 'verify-test-env.js');
const FORCE_UNSAFE = args.includes('--force-unsafe');   // 变异自证接缝（见最终删除闸门）；正常运行不传
const ONLY = argVal('--only=') ? argVal('--only=').split(',').map((s) => s.trim()).filter(Boolean) : null;
const want = (sec) => ONLY === null || ONLY.includes(sec);
/** 反例自证接缝（--seam=<名字>）：节 S 把本套件自己当子进程再跑一遍，带上接缝，在最外层收尾里造一种「不安全」的局面，要求私有根保留 + 点名原因（见节 S）。正常运行不传。 */
const SEAM = argVal('--seam=');
const SEAMS = Object.freeze(['pending-never', 'pending-late-added', 'pending-timeout-only', 'local-reap-fail', 't-corrupt', 't-throw', 'helper-reg-fail', 'viol-corrupt', 'tail-query-throw']);
const PENDING_WAIT_MS = SEAM !== null && SEAM.startsWith('pending-') ? 400 : 20000;   // 等待未落定启动的截止：生产值 20 秒；pending-* 接缝缩短，免得每个场景白等 20 秒

// ---------------------------------------------------------------- 私有临时根（必须最先做）
const REAL_TMP = os.tmpdir();
const PRIV = fs.mkdtempSync(path.join(REAL_TMP, 'sdh-te-suite-'));
// 最外层异常边界（收口小批，13T-R2 M3）：私有根一建好就装。之后任何一处没被收尾捕获的初始化异常（模块顶层的 require、守卫安装、同步建目录…）都在这里打印、保留私有根、以非零退出——
// 不留下「没人报告的目录」。被测模块（TE_PATH）的加载不走这里：它延后到 main() 里 require（见 loadUnderTest），失败走完整的收尾（停桩服务、终检、闸门、汇总行）。
process.on('uncaughtException', (e) => {
    try {
        console.log(`CHECK Z.0 FAIL 套件初始化阶段异常（私有根已建，保留现场）\n         ${(e && e.stack) || String(e)}`);
        console.log(`NOTE 现场保留：${PRIV}`);
    } catch (_) { /* 无处可写：退出码仍是非零 */ }
    process.exit(1);
});
const TMP = path.join(PRIV, 'tmp');
fs.mkdirSync(TMP);
process.env.TEMP = TMP;
process.env.TMP = TMP;
const REGISTRY_FILE = path.join(PRIV, 'reap-registry.jsonl');   // 共享回收模块的登记文件（私有根内）：套件、辅助进程（预加载片段）、替身套件都往里追加

// 宿主残留的变量组 / live 变量：清掉（不分大小写）。不清的话 te.ready(SELF()) 这类「全部缺省」的用例会悄悄走变量组 / live 形态。只记名字，不记值。
const TEST_VAR_RE = /^TEST_(?:INSTANCE|BASE_URL|DB_PATH|JWT_SECRET|TARGET|LIVE_URL)$/i;
const SCRUBBED_VARS = [];
for (const k of Object.keys(process.env)) { if (TEST_VAR_RE.test(k)) { SCRUBBED_VARS.push(k); delete process.env[k]; } }

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 耗时一律用单调时钟（performance.now，毫秒，带小数）：墙钟（Date.now）会被校时 / 夏令时拨动，耗时判定不依赖它。截止计算（deadline）仍用 Date.now，那是「到点就放弃」不是「量耗时」。 */
const now = () => performance.now();
const fold = (p) => String(p).toLowerCase();
const J = (v) => JSON.stringify(v);

// ---------------------------------------------------------------- 数据库路径守卫（在加载任何被测模块之前）
const sqlite3 = require('sqlite3');
const OPENED = [];            // 套件进程里每次 new sqlite3.Database(<文件>) 的绝对路径
const OPENED_FLAGS = [];      // 与 OPENED 同下标：打开标志（省略时按 sqlite3 默认 = 读写 + 创建）
const GUARD_VIOLATIONS = [];  // 越界打开
{
    const RealDatabase = sqlite3.Database;
    const privFold = fold(fs.realpathSync.native(PRIV));
    function GuardedDatabase(file, ...rest) {
        if (typeof file === 'string' && file !== '' && file !== ':memory:' && !file.startsWith('file:')) {
            const abs = path.resolve(file);
            OPENED.push(abs);
            OPENED_FLAGS.push(typeof rest[0] === 'number' ? rest[0] : (sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE));
            let real = abs;
            try { real = fs.realpathSync.native(abs); } catch (_) { try { real = path.join(fs.realpathSync.native(path.dirname(abs)), path.basename(abs)); } catch (_2) { real = abs; } }
            if (!fold(real).startsWith(privFold + path.sep)) {
                GUARD_VIOLATIONS.push(abs);
                throw new Error(`GUARD_TRIPPED: 套件进程试图打开私有根之外的库 ${abs}`);
            }
        }
        return new RealDatabase(file, ...rest);
    }
    GuardedDatabase.prototype = RealDatabase.prototype;
    sqlite3.Database = GuardedDatabase;
}
// .env 读取守卫：套件进程里任何对「私有根之外的 .env」的 fs.readFileSync 都立即抛错并记录（被测代码万一走到默认来源路径——比如 options 被丢掉时启动器会去读本检出的 .env——也读不到）
const ENV_VIOLATIONS = [];
{
    const realRead = fs.readFileSync;
    const privFold = fold(fs.realpathSync.native(PRIV));
    fs.readFileSync = function guardedReadFileSync(p, ...rest) {
        if (typeof p === 'string' && path.basename(p).toLowerCase() === '.env') {
            let abs = path.resolve(p);
            try { abs = fs.realpathSync.native(abs); } catch (_) { /* 文件不存在：按字面路径 */ }
            if (!fold(abs).startsWith(privFold + path.sep)) {
                ENV_VIOLATIONS.push(path.resolve(p));
                throw new Error(`GUARD_TRIPPED: 套件进程试图读取私有根之外的 .env：${path.resolve(p)}`);
            }
        }
        return realRead.call(this, p, ...rest);
    };
}
const jwt = require('jsonwebtoken');
const common = require('../../scripts/lines/line-common');
const procLib = require('../../scripts/lines/line-proc');
const instanceDb = require('../utils/instance-db');
// 共享回收模块：登记文件在被测模块加载之前就建好（建失败不在这里抛：记下原因，由 main() 抛进统一收尾，私有根保留）；回收器是本套件唯一的回收器
const reapLib = require(REAP_PATH);
const REGISTRY_INIT_ERROR = reapLib.initRegistry(REGISTRY_FILE);
const REAPER = reapLib.createReaper({ file: REGISTRY_FILE, owner: 'suite' });   // 监督进程的登记文件取环境变量 S2C_TEST_REGISTRY（入口启用 reap: true 时有）
// 被测模块延后到 main() 里加载（loadUnderTest）：加载失败（语法错误、依赖缺失）走完整的收尾——报告 Z.0、停桩服务、终检、闸门、汇总行——不再在模块顶层抛出而留下没人报告的私有根（13T-R2 M3）
let te = null;
function loadUnderTest() {
    try { te = require(TE_PATH); } catch (e) {
        throw new Error(`被测模块加载失败（${TE_PATH}）：${(e && e.message) || String(e)}`);
    }
}
const ti = require('./lib/test-instance');
const { listenOnSafePort } = require('./lib/listen-safe-port');

const isReadOnlyFlags = (f) => typeof f === 'number' && (f & sqlite3.OPEN_READONLY) !== 0 && (f & (sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE)) === 0;
const openedSince = (before) => OPENED.slice(before).map((p, i) => ({ path: p, flags: OPENED_FLAGS[before + i] }));

// ---------------------------------------------------------------- 断言
let pass = 0;
let fail = 0;
const results = [];
function check(id, title, cond, detail) {
    const ok = !!cond;
    if (ok) pass += 1; else fail += 1;
    results.push({ id, title, ok });
    console.log(`CHECK ${id} ${ok ? 'PASS' : 'FAIL'} ${title}${!ok && detail !== undefined ? `\n         ${typeof detail === 'string' ? detail : J(detail)}` : ''}`);
    return ok;
}
const errCode = (e) => (e && e.code) || null;

// ---------------------------------------------------------------- sqlite 助手（只用于套件自建的库）
function dbOpen(file, flags) { return new Promise((res, rej) => { const d = new sqlite3.Database(file, flags === undefined ? (sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE) : flags, (e) => (e ? rej(e) : res(d))); }); }
function dbExec(d, sql) { return new Promise((res, rej) => d.exec(sql, (e) => (e ? rej(e) : res()))); }
function dbAll(d, sql, p) { return new Promise((res, rej) => d.all(sql, p || [], (e, r) => (e ? rej(e) : res(r)))); }
function dbClose(d) { return new Promise((res) => d.close(() => res())); }
async function withDb(file, flags, fn) { const d = await dbOpen(file, flags); try { return await fn(d); } finally { await dbClose(d); } }

/** 最外层收尾已开始（节 S 的 tail-query-throw 接缝只在收尾阶段让文件查询抛错） */
let TAIL_PHASE = false;
const seamQueryThrow = () => { if (SEAM === 'tail-query-throw' && TAIL_PHASE) { const e = new Error('seam: 收尾阶段文件查询抛错（EACCES，接缝注入）'); e.code = 'EACCES'; throw e; } };
const lstatOrNull = (p) => { seamQueryThrow(); try { return fs.lstatSync(p); } catch (e) { if (e && e.code === 'ENOENT') return null; throw e; } };
const tmpInstanceDirs = () => { seamQueryThrow(); return fs.readdirSync(TMP).filter((n) => /^sdh-test-/.test(n)).sort(); };
const identityState = (pid, start) => { try { return procLib.checkIdentity({ pid, start_time: start }).state; } catch (e) { return `ERR ${e && e.code}`; } };
const gone = (pid, start) => ['dead', 'reused'].includes(identityState(pid, start));

function httpGet(port, urlPath, headers) {
    return new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', headers: headers || {}, timeout: 8000 }, (res) => {
            let b = '';
            res.on('data', (c) => { b += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) { /* 非 JSON */ } resolve({ status: res.statusCode, json: j, raw: b }); });
        });
        req.on('error', (e) => resolve({ status: 0, json: null, raw: String(e && e.code ? e.code : e.message) }));
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.end();
    });
}

// ---------------------------------------------------------------- 登记（共享回收模块 lib/test-reap.js）
/** 套件自己 spawn 的子进程（辅助进程 / 监督进程）：返回前立即登记（PID + 精确创建时间 + 归属，句柄在手）；登记写失败 → 按句柄杀掉这个刚起的子进程（不留未登记的孤儿）再抛错 */
function track(label, child, owner) {
    try { return REAPER.trackChild(label, child, owner ? { owner } : undefined); } catch (e) { try { child.kill(); } catch (_) { /* 句柄在手：杀不掉就由调用方的错误路径报告 */ } throw e; }
}

// ---------------------------------------------------------------- 套件主进程里启动器交出的服务：登记经共享回收模块（reaper.trackInstance），REG 只是场景断言用的视图
const REG = [];   // { label, pid, start, dataDir, stop }
function registerHandle(label, h) {
    if (!h || !Number.isSafeInteger(h.pid)) return;
    const start = h.startTime || null;
    if (REG.some((r) => r.pid === h.pid && r.start === start)) return;
    REAPER.trackInstance(label, h);   // 写登记文件（并镜像到监督进程的登记文件）；写失败即抛，不吞
    REG.push({ label, pid: h.pid, start, dataDir: h.dataDir || null, stop: typeof h.stop === 'function' ? h.stop.bind(h) : null });
}
const regEnv = (label, e) => { if (e && e._handle) registerHandle(label, e._handle); return e; };
const PENDING_STARTS = new Set();   // 还没落定的启动（主流程中途异常退出时，回收器要先等它们落定再收，否则晚到的实例会漏掉）
{
    // 包在 startTestInstance 外面：不管是 te.ready() 的哪一次调用、并发还是非幂等，只要启动器交出了句柄就登记（resolveEnvironment 每次调用时才取这个属性）。
    // 登记写失败 → 先 stop() 这个刚起的实例再抛错（与预加载片段在辅助进程里的行为一致），不留孤儿。
    const origStart = ti.startTestInstance;
    ti.startTestInstance = function registeringStart(...a) {
        const p = (async () => {
            const h = await origStart.apply(this, a);
            try { registerHandle('launcher', h); } catch (e) { try { await h.stop(); } catch (_) { /* 最外层回收按身份兜底 */ } throw e; }
            return h;
        })();
        PENDING_STARTS.add(p);
        p.then(() => PENDING_STARTS.delete(p), () => PENDING_STARTS.delete(p));
        return p;
    };
}
const REAP_BOUND_MS = 60000;
/** 回收器确认消失的实例：数据根由套件删（回收器不删数据根）；返回没删掉的原因 */
function removeRoots(goneItems) {
    const left = [];
    for (const g of goneItems) {
        try {
            if (g.kind === 'instance' && g.dataDir && lstatOrNull(g.dataDir) !== null) {
                const l = ti._internals.removeDataRoot(g.dataDir);
                if (l) left.push(l);
            }
        } catch (e) { left.push(String(e && e.message)); }   // 文件查询 / 删除抛错也计入没删掉的原因（不中断后面的实例，不中断收尾）
    }
    return left;
}

// ---------------------------------------------------------------- 最外层闸门的额外输入（13T-R2 H1 / H2 / M3）
// 主回收器的登记集合只是「登记过的」；下面这些是「登记集合可能不完整」的持久原因，一律让最外层闸门判不安全、保留私有根：
const LOCAL_SOURCES = [];                    // 节 R / 节 T / 节 S 的局部登记来源 { label, closed }：没关闭 = 它里面的进程不一定都进了主登记
const LOCAL_PROBLEMS = [];                   // 局部来源的持久问题（终检未通过 / 登记文件读取失败·损坏·末行没写完 / 并入主回收器失败）
const HELPER_REG_FAILURES = [];              // 辅助进程的登记写失败（预加载片段记的 kind=reg 违规）：它起的服务可能不在登记里——不受 runHelper 的 expectViolations 影响
const HELPER_VIOLATION_FILE_ERRORS = [];     // 辅助进程违规记录文件的非预期读取 / 解析失败（ENOENT 是正常的：没有违规就没有文件）
const TAIL_ERRORS = [];                      // 最外层收尾各阶段的异常（每个阶段独立捕获，累计到这里）
const SEAM_PROCS = [];                       // 接缝造的进程（句柄在手，接缝善后按句柄终止）
/** 局部登记来源：开 → 用完关。只有关上才算「这个来源里的进程全部有退出证据 / 全部并入了主登记」 */
function openLocalSource(label) { const s = { label, closed: false }; LOCAL_SOURCES.push(s); return s; }
/** 关闭一个有自己回收器的局部来源：终检（新鲜读登记 + 逐项核身份）全部有退出证据、回收器没有登记写失败才关闭；否则记持久问题，来源保持打开 */
function closeLocalSource(s, reaper) {
    try {
        const v = reaper.verifyAllGone();
        if (v.ok && reaper.failures.length === 0) { s.closed = true; return true; }
        LOCAL_PROBLEMS.push(`${s.label}：终检未通过（仍存活 / 无退出证据：${v.bad.map((b) => b.label).join('、') || '无'}；登记问题：${v.problems.join('；') || '无'}；登记写失败 ${reaper.failures.length} 次）`);
    } catch (e) { LOCAL_PROBLEMS.push(`${s.label}：终检抛错：${(e && e.message) || String(e)}`); }
    return false;
}
/**
 * 把一个局部登记文件（节 T 的独立监督进程那一份）并入主回收器：读取 problems（读取失败 / 缺表头 / 损坏行 / 末行没写完）进持久问题；每条记录经 REAPER.register（登记写失败进 REAPER.failures）；
 * 全部并入且没有 problems 才关闭来源。不抛。
 */
function mergeLocalRegistry(src, file) {
    let ok = true;
    let r = null;
    try { r = reapLib.readRegistryFile(file); } catch (e) { LOCAL_PROBLEMS.push(`${src.label}：登记文件读取抛错：${(e && e.message) || String(e)}`); return false; }
    for (const p of r.problems) { LOCAL_PROBLEMS.push(`${src.label}：${p}`); ok = false; }
    for (const rec of r.records) {
        try { REAPER.register({ kind: rec.kind, pid: rec.pid, startTime: rec.startTime, label: `${rec.label}@t`, owner: rec.owner, dataDir: rec.dataDir, instance: rec.instance }); } catch (e) { LOCAL_PROBLEMS.push(`${src.label}：并入主登记失败（${rec.label} pid ${rec.pid}）：${(e && e.message) || String(e)}`); ok = false; }
    }
    if (ok) src.closed = true;
    return ok;
}
/** 局部登记文件的读取与并入放进必经的 finally：body 中途抛错（或被套件超时、断言抛错打断）也并入 */
async function withMergedRegistry(label, file, body) {
    const src = openLocalSource(label);
    try { return await body(); } finally { mergeLocalRegistry(src, file); }
}
/** 最外层闸门的额外不安全原因（evalDeleteGate 的 extra 输入）。bootError：主流程是否中途异常 */
function gateExtraReasons(bootError) {
    const r = [];
    if (REAPER.failures.length > 0) r.push('登记写入失败（回收器 failures 非空）');
    if (REGISTRY_INIT_ERROR) r.push('登记文件初始化失败');
    if (HELPER_REG_FAILURES.length > 0) r.push(`辅助进程登记写失败 ${HELPER_REG_FAILURES.length} 次（${HELPER_REG_FAILURES.map((v) => v.mode).join('、')}）：辅助进程起的服务可能不在登记里，终检的登记集合不完整`);
    if (HELPER_VIOLATION_FILE_ERRORS.length > 0) r.push(`辅助进程违规记录文件读取 / 解析失败 ${HELPER_VIOLATION_FILE_ERRORS.length} 处（违规与登记失败的记录可能丢失）：${HELPER_VIOLATION_FILE_ERRORS.slice(0, 2).join('；')}`);
    const open = LOCAL_SOURCES.filter((s) => !s.closed);
    if (open.length > 0) r.push(`局部登记来源未关闭：${open.map((s) => s.label).join('、')}（来源里的进程不一定都进了主登记）`);
    if (LOCAL_PROBLEMS.length > 0) r.push(`局部登记来源有问题 ${LOCAL_PROBLEMS.length} 条：${LOCAL_PROBLEMS.slice(0, 2).join('；')}`);
    if (bootError) r.push('套件主流程异常中断（登记集合与收尾状态可能不完整）');
    if (TAIL_ERRORS.length > 0) r.push(`收尾阶段异常 ${TAIL_ERRORS.length} 处：${TAIL_ERRORS.slice(0, 3).join('；')}`);
    return r;
}
/**
 * 私有根整根删除的唯一出口（13T-R H2；收口小批措辞：「唯一」只指私有根整根——另有 3 处 removeDataRoot 删实例数据根，各以该实例的服务身份已消失为前提）：
 * gate.safe 为真才删（deleteTreeNoFollow：链接只拆链接本身；不用 fs.rmSync），否则什么都不碰、保留现场。
 * 返回 { deleted, error }。最外层收尾与节 R 的诱饵用例都走这个函数。
 */
function deleteRootIfSafe(root, gate) {
    if (!gate || gate.safe !== true) return { deleted: false, error: null };
    try {
        common.deleteTreeNoFollow(fs.realpathSync.native(root), []);
        fs.rmdirSync(root);
        return { deleted: true, error: null };
    } catch (e) { return { deleted: false, error: (e && e.message) || String(e) }; }
}

// ---------------------------------------------------------------- 合成夹具：来源库 / 合成检出 / 桩服务
const SRC_DIR = path.join(PRIV, '来源 目录');
const SRC = path.join(SRC_DIR, 'src.db');
const INST_DIR = path.join(PRIV, '实例 目录');
const SYN = path.join(PRIV, '检出 syn', 'wbs');           // 合成「正常模式检出」（没有 .sdh-instance，没有 server.js）；路径段含中文 + 空格
const SYN2 = path.join(PRIV, '检出 syn2', 'wbs');         // 另一个合成正常检出（对照组：业务库路径不同）
const LINE_WBS = path.join(PRIV, '线 检出', 'wbs');       // 合成「线检出」（.sdh-instance = rd）
const LINE_BAD_WBS = path.join(PRIV, '坏 检出', 'wbs');   // 合成「身份文件非法」检出（.sdh-instance = main → 判定被拒绝）
const BIZ_DB = path.join(SYN, 'task_pool.db');
const GOOD_DB = path.join(INST_DIR, 'good.db');
const OTHER_DB = path.join(INST_DIR, 'other.db');
const NOID_DB = path.join(INST_DIR, 'noid.db');
const LINE_DB = path.join(PRIV, '线 检出', 'line.db');
const GOOD_ID = 'test-good1';
const SECRET = `suite-secret-${crypto.randomBytes(8).toString('hex')}`;
const STUB_JS = path.join(PRIV, 'stub-server.js');
const HELPER_JS = path.join(PRIV, 'helper.js');
const STANDIN_JS = path.join(PRIV, 'sup-standin.js');   // 节 T 的替身套件
const DETACH_JS = path.join(PRIV, 'detach-spawn.js');   // 辅助进程的预加载补丁：把它起的子进程都改成 detached（见 writeStubFiles）
const STOPFAIL_JS = path.join(PRIV, 'stopfail-start.js');   // 辅助进程的预加载补丁（节 S 的 helper-reg-fail 接缝）：启动器交出的句柄 stop() 被注入失败，并打印服务的精确身份供父进程善后
let SRC_SHA = null;

const STUB = { server: null, port: null, hits: 0, state: { instance: GOOD_ID, mode: 'isolated', mutate: null } };

/** Win32 规范化：每个路径段去掉尾部的 . 与空格（SQLite 的 CreateFileW 会这么做），再折叠大小写——「业务库被打开」的判定要看规范化之后 */
const winNormPath = (p) => fold(String(p).split(/[\\/]+/).map((s) => (s === '.' || s === '..' ? s : s.replace(/[. ]+$/, ''))).join(path.sep));
const isBizPath = (p) => winNormPath(p) === winNormPath(BIZ_DB) || winNormPath(p) === winNormPath(LINE_DB);
const BIZ_OPENED = (since) => OPENED.slice(since || 0).filter(isBizPath);

async function buildSources() {
    for (const d of [SRC_DIR, INST_DIR, SYN, SYN2, LINE_WBS, LINE_BAD_WBS]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(LINE_WBS, '.sdh-instance'), 'rd');
    fs.writeFileSync(path.join(LINE_BAD_WBS, '.sdh-instance'), 'main');
    await withDb(SRC, undefined, async (d) => {
        await dbExec(d, instanceDb.SYSTEM_CONFIGS_DDL);
        await dbExec(d, "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, display_name TEXT, role TEXT DEFAULT 'user', status TEXT DEFAULT 'active')");
        await dbExec(d, "INSERT INTO users (username, password, display_name, role) VALUES ('ti-admin', 'x', '管理员 甲', 'admin'), ('ti-user', 'x', '用户 乙', 'user')");
        await dbExec(d, 'CREATE TABLE collab_requests (id INTEGER PRIMARY KEY, status TEXT, friction_note TEXT)');
        await dbExec(d, "INSERT INTO collab_requests (id, status) VALUES (1, 'PENDING'), (2, 'PENDING')");
    });
    SRC_SHA = sha256(fs.readFileSync(SRC));
    const mk = (target, id) => instanceDb.createIsolatedDb({ sourceDbPath: SRC, targetDbPath: target, instanceId: id, parent: 'main', from: 'test-env-suite', sourceEncryptionKey: null });
    await mk(BIZ_DB, 'test-biz1');
    await mk(GOOD_DB, GOOD_ID);
    await mk(OTHER_DB, 'test-other1');
    await mk(LINE_DB, 'test-linedb1');
    fs.copyFileSync(SRC, NOID_DB);
}

function writeStubFiles() {
    fs.writeFileSync(STUB_JS, `'use strict';
const http = require('http');
const port = Number(process.env.PORT);
const instance = process.env.SDH_INSTANCE;
http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/api/version') return res.end(JSON.stringify({ version: 'stub', mode: 'isolated', instance }));
  if (req.url === '/api/health/ready') return res.end(JSON.stringify({ ok: true, instance, mode: 'isolated', modules: { core: { ready: true, code: null } } }));
  res.end(JSON.stringify({ path: req.url, auth: req.headers.authorization || null, instance }));
}).listen(port, '127.0.0.1');
`);
    // 辅助进程的守卫与启动器句柄的立即登记全部来自共享预加载片段 lib/test-reap-preload.js（node --require，在加载被测模块之前安装），本套件不再自带一份。
    // 把辅助进程里 spawn 出的子进程都改成 detached。为什么：Windows 上 libuv 给「非 detached」的子进程套一个 KILL_ON_JOB_CLOSE 作业对象，父进程被 TerminateProcess 杀掉时这些子进程会一起没
    // （启动器起的服务就是这样，探针实测：非 detached 孙进程随中间进程消失、detached 的存活）。要造出「辅助进程已死、服务还活着」的孤儿——13T-R H1 担心的情形——只能让服务脱离作业对象。
    // 必须先于启动器模块加载（启动器在模块顶层解构 spawn），所以作为第一个 --require。
    fs.writeFileSync(DETACH_JS, String.raw`'use strict';
const cp = require('child_process');
const real = cp.spawn;
cp.spawn = function detachedSpawn(command, args, options) {
  const hasArgs = Array.isArray(args);
  const opts = Object.assign({}, hasArgs ? options : args, { detached: true });
  return hasArgs ? real.call(this, command, args, opts) : real.call(this, command, opts);
};
`);
    // 节 S 的 helper-reg-fail 接缝：先于预加载片段加载，包住启动器——句柄一返回就把服务的精确身份打印出来（父进程善后用），并把 stop() 换成必定失败的版本。
    //   预加载片段随后包在它外面：登记写失败（登记文件路径被换成不存在的）→ 预加载片段 stop() 这个刚起的实例 → stop() 失败 → 服务既不在任何登记里、也没被停掉：「辅助进程登记失败且 stop 失败」。
    fs.writeFileSync(STOPFAIL_JS, String.raw`'use strict';
const ti = require(process.env.SDH_REAP_TI);
const real = ti.startTestInstance;
ti.startTestInstance = async function stopFailStart(...a) {
  const h = await real.apply(this, a);
  process.stdout.write(JSON.stringify({ svc: { pid: h.pid, startTime: h.startTime, dataDir: h.dataDir } }) + '\n');
  h.stop = async function failingStop() { process.stdout.write(JSON.stringify({ stopCalled: true }) + '\n'); throw new Error('stop 被注入失败'); };
  return h;
};
`);
    // 节 T 的替身套件（由独立监督进程运行）：起一个装了预加载片段的辅助进程（hang 模式：启动器交出句柄后永久等待）→ 看到 hanging 信号后先杀掉辅助进程
    // （模拟套件的局部超时：服务成了父进程已死的孤儿，进程树终止够不到）→ 记下服务身份 → 同步挂起，等监督进程超时强杀。登记不上就在派生辅助进程之前以 86 退出。
    fs.writeFileSync(STANDIN_JS, String.raw`'use strict';
const fs = require('fs');
const { spawn } = require('child_process');
const arg = (p) => { const a = process.argv.slice(2).find((x) => x.startsWith(p)); return a ? a.slice(p.length) : null; };
const pidFile = arg('--pid-file=');
const lib = require(process.env.STANDIN_REAP_LIB);
let reaper; let child;
try {
  reaper = lib.createReaper({ file: process.env.SDH_REAP_REGISTRY, owner: 'standin' });   // 监督进程的登记文件取环境变量 S2C_TEST_REGISTRY（独立监督进程设）
  const pre = process.env.STANDIN_PATCH ? ['--require', process.env.STANDIN_PATCH] : [];   // 先于预加载片段：让辅助进程起的服务成为 detached（孤儿才存活）
  child = spawn(process.execPath, [...pre, '--require', process.env.STANDIN_PRELOAD, process.env.STANDIN_HELPER, 'hang'], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  reaper.trackChild('standin-helper', child);
} catch (e) { console.error('STANDIN_SETUP_FAILED: ' + e.message); try { if (child) child.kill(); } catch (_) { /* 句柄在手 */ } process.exit(86); }
let buf = ''; let done = false;
child.stdout.on('data', (c) => {
  buf += c;
  const m = /\{"hanging":true[^\n]*\}/.exec(buf);
  if (!m || done) return;
  done = true;
  const info = JSON.parse(m[0]);
  child.once('exit', () => {
    fs.writeFileSync(pidFile, JSON.stringify({ helperPid: child.pid, service: { pid: info.pid, start: info.startTime, dataDir: info.dataDir, instance: info.instance } }));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2147483647);
  });
  child.kill();
});
setInterval(() => {}, 1000);
`);
    // 辅助进程主体。输出一律经 process.stdout.write(…, 回调)：回调里才继续 / 退出（console.log 之后立即 process.exit 会丢管道里没写完的输出）
    fs.writeFileSync(HELPER_JS, String.raw`'use strict';
const mode = process.argv[2];
const te = require(process.env.HELPER_TE);
if (process.env.HELPER_WBS) te._internals.resetForTest({ wbsDir: process.env.HELPER_WBS });
const emit = (obj) => new Promise((resolve) => { process.stdout.write(JSON.stringify(obj) + '\n', () => resolve()); });
const SELF = () => ({ sourceDbPath: process.env.HELPER_SRC, sourceEncryptionKey: null, serverJs: process.env.HELPER_STUB });
// 启动器的终止等待截止注入接缝（只供自检；套件传 HELPER_WAIT_MS 时设成长截止，用来把「遗留计时器」与正常区分开）
const tiHooks = te._internals.testInstance._internals._hooks;
if (process.env.HELPER_WAIT_MS) tiHooks.terminateWaitMs = Number(process.env.HELPER_WAIT_MS);
(async () => {
  if (mode === 'envdump') { await emit({ keys: Object.keys(process.env).filter((k) => /^TEST_/i.test(k)) }); return; }
  if (mode === 'waitdefault') {   // 不注入时的默认值（生产默认必须仍是 8000）：接缝的当前值与默认常量
    await emit({ seam: tiHooks.terminateWaitMs, dflt: te._internals.testInstance._internals.TERMINATE_WAIT_DEFAULT_MS });
    return;
  }
  if (mode === 'hang') {
    // 13T-R H1 的反例：启动器已经把句柄交出来、ready() 还没返回——这里永久等待并持有活动句柄（setInterval）。登记由预加载片段包在启动器里（orig 里面）做，
    // 所以到 hanging 信号发出时登记已经写好；父进程随后杀掉本进程（Windows 上 child.kill() 是 TerminateProcess，JS 退出钩子不会跑），服务成了孤儿。
    const ti = te._internals.testInstance;
    const orig = ti.startTestInstance;
    ti.startTestInstance = async function hangingStart(...a) {
      const h = await orig.apply(this, a);
      await emit({ hanging: true, pid: h.pid, startTime: h.startTime, dataDir: h.dataDir, instance: h.instance });
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    };
  }
  if (mode === 'provided') {
    const e = await te.ready();
    await emit({ baseUrl: e.baseUrl, instance: e.instance, dbPath: e.dbPath, selfStarted: e.selfStarted, jwtSecret: e.jwtSecret });
    await te.teardown();   // 已迁移脚本的约定：以 await teardown() 收尾（否则退出码兜底会把退出码改成非零）
    return;
  }
  if (mode === 'sent') {
    // 退出码兜底的五种收尾 × 三种形态。形态由父进程注入的环境决定（self = 全部缺省自起 / group = 变量组 / live = TEST_TARGET=live）；situation 由 argv[3] 给出
    const sit = process.argv[3];
    const form = process.argv[4];
    // 收口小批：别的 beforeExit 监听器注册在 ready() 之前（bef*）或之后（aft*），用同步 / nextTick / 微任务 / setImmediate / setTimeout(0) 调 process.exit(0)——显式退出，兜底不得介入（退出码 0）
    const WHEN = { Sync: (f) => f(), Tick: (f) => process.nextTick(f), Micro: (f) => { Promise.resolve().then(f); }, Imm: (f) => setImmediate(f), T0: (f) => setTimeout(f, 0) };
    const exitM = /^(bef|aft)(Sync|Tick|Micro|Imm|T0)$/.exec(sit || '');
    if (sit === 'preTdStuck') await te.teardown();                 // 47R4a M1：ready() 之前先调一次空 teardown()，不得让之后的实例被当成「已收尾」
    const hookExit = () => { let done = false; process.on('beforeExit', () => { if (done) return; done = true; WHEN[exitM[2]](() => process.exit(0)); }); };
    if (exitM && exitM[1] === 'bef') hookExit();
    const e = await te.ready(form === 'self' ? SELF() : undefined);
    const base = { ready: true, form, selfStarted: e.selfStarted, live: e.live };
    await emit(form === 'self' ? Object.assign(base, { pid: e._handle.pid, startTime: e._handle.startTime, dataDir: e.dataDir }) : base);
    if (sit === 'natural') return;                                   // 自然结束、没有 teardown()、没有 process.exit()
    if (sit === 'exit0') process.exit(0);                            // 显式 process.exit(0)
    if (sit === 'exitNoArg') process.exit();                         // 无参 process.exit()，之前没设过 exitCode：显式退出，退出码 0
    if (sit === 'exitNoArg3') { process.exitCode = 3; process.exit(); }   // 之前设了 exitCode = 3，无参 process.exit() 沿用它：3
    if (exitM) { if (exitM[1] === 'aft') hookExit(); return; }       // bef*：监听器已在 ready() 之前注册；aft*：此刻（ready() 之后）才注册。随后自然结束，由别家的监听器显式 process.exit(0)
    if (sit === 'stuck' || sit === 'preTdStuck') { await new Promise(() => {}); await emit({ reached: true }); process.exit(1); }   // 卡在永不落定的 promise（到不了后面两行）
    if (sit === 'teardown') { await te.teardown(); return; }         // teardown() 之后自然结束
    if (sit === 'exitcode1') { process.exitCode = 1; return; }       // 已设 process.exitCode = 1，自然结束
    if (sit === 'resched0' || sit === 'reschedNat') {                // 另一个 beforeExit 监听器把事件循环重新拉起来（定时器），随后显式 process.exit(0)（resched0）或自然结束（reschedNat）
      let once = false;
      process.on('beforeExit', () => { if (once) return; once = true; setTimeout(() => { if (sit === 'resched0') process.exit(0); }, 40); });
      return;
    }
    await emit({ unknownSituation: sit }); process.exit(98);
  }
  const e = await te.ready(mode === 'dropsource' ? {} : SELF());
  const info = { pid: e._handle.pid, startTime: e._handle.startTime, dataDir: e.dataDir, port: e._handle.port };
  await emit(info);
  if (mode === 'exit') process.exit(0);
  if (mode === 'throw') { setImmediate(() => { throw new Error('boom'); }); return; }
  if (mode === 'teardownend') { await te.teardown(); await emit({ tornDown: true }); return; }   // 显式 teardown 之后什么都不做，自然结束（不调 process.exit）
  if (mode === 'sigint' || mode === 'sigterm') {
    const sig = mode === 'sigint' ? 'SIGINT' : 'SIGTERM';
    const handled = process.emit(sig);   // 经真实注册的监听器；没有监听器时 emit 返回 false
    if (!handled) { await emit({ noListener: sig }); process.exit(97); }
    setInterval(() => {}, 1000);          // 等处理器自己 process.exit(130 / 143)
    return;
  }
  // 'natural'：什么都不做，自然结束（没有 teardown()、没有 process.exit()）
})().catch(async (e) => { await emit({ error: { code: e && e.code, message: String(e && e.message).slice(0, 300) } }); process.exit(3); });
`);
}

async function startStub() {
    const server = http.createServer((req, res) => {
        STUB.hits += 1;
        const st = STUB.state;
        if (st.mutate) return st.mutate(req, res);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ version: 'stub', mode: st.mode, instance: st.instance }));
    });
    await listenOnSafePort(server);
    STUB.server = server;
    STUB.port = server.address().port;
}
/** 桩服务收尾（有界）：先掐掉所有还开着的连接再 close——被测实现不销毁请求 / 响应时，对端连接会一直开着，光 close() 会永远等下去（套件不能被有缺陷的实现挂住） */
async function stopStub() {
    if (!STUB.server) return;
    try { STUB.server.closeAllConnections(); } catch (_) { /* 尽力 */ }
    await Promise.race([new Promise((r) => STUB.server.close(() => r())), sleep(5000)]);
}
const stubUrl = () => `http://127.0.0.1:${STUB.port}`;
function stubReset() { STUB.state = { instance: GOOD_ID, mode: 'isolated', mutate: null }; STUB.hits = 0; }

const SELF = () => ({ sourceDbPath: SRC, sourceEncryptionKey: null, serverJs: STUB_JS });
const goodVars = (over) => Object.assign({ TEST_INSTANCE: GOOD_ID, TEST_BASE_URL: stubUrl(), TEST_DB_PATH: GOOD_DB, TEST_JWT_SECRET: SECRET }, over || {});
async function resolveWith(envVars, o) {
    const opts = o || {};
    const deps = { env: envVars, wbsDir: opts.wbsDir || SYN };
    if (opts.fetchVersion) deps.fetchVersion = opts.fetchVersion;
    if (opts.startTestInstance) deps.startTestInstance = opts.startTestInstance;
    try { return { value: await te._internals.resolveEnvironment(opts.options, deps), error: null }; } catch (e) { return { value: null, error: e }; }
}
const spyFetch = (answer) => { const f = async (origin) => { f.calls.push(origin); return answer || { version: 'x', mode: 'isolated', instance: GOOD_ID }; }; f.calls = []; return f; };

// ================================================================ 节 A：变量组形态 · 全部正确
async function sectionA() {
    console.log('\n== 节 A：变量组形态 · 三项核对全部通过 ==');
    stubReset();
    const before = OPENED.length;
    const r = await resolveWith(goodVars());
    const v = r.value;
    check('A.1', '变量组全部给出且正确 → 解析成功：baseUrl / instance / dbPath / jwtSecret 原样，live=false、selfStarted=false', v && v.baseUrl === stubUrl() && v.instance === GOOD_ID && fold(v.dbPath) === fold(GOOD_DB) && v.jwtSecret === SECRET && v.live === false && v.selfStarted === false, r.error && r.error.message);
    check('A.2', '核对只发了 1 次 /api/version 请求，且只打开了实例库（业务库从未被打开）', STUB.hits === 1 && OPENED.slice(before).every((p) => fold(p) === fold(GOOD_DB)) && BIZ_OPENED().length === 0, { hits: STUB.hits, opened: OPENED.slice(before) });
    const openedA = openedSince(before);
    check('A.2b', '库身份核对以只读方式打开实例库（直接观测打开标志）：至少打开一次，每次的标志含 OPEN_READONLY、不含 OPEN_READWRITE / OPEN_CREATE', openedA.length >= 1 && openedA.every((o) => isReadOnlyFlags(o.flags)), openedA);
    check('A.3', 'dataDir：库所在目录没有 sdh-instance.json 时为 null（不猜）', v && v.dataDir === null);

    // 公开 API：ready() 幂等 / env() / signToken / childEnv / teardown
    te._internals.resetForTest({ env: goodVars(), wbsDir: SYN });
    const p1 = te.ready();
    const p2 = te.ready();
    const p3 = te.ready(undefined);
    const e1 = await p1;
    check('A.4', 'ready() 幂等：同一进程多次调用（不传 options）得到同一个 Promise（不重复建）', p1 === p2 && p2 === p3 && (await p2) === e1 && te.isReady() === true && te.env() === e1);
    let optErr = null;
    try { await te.ready({ ignored: true }); } catch (e) { optErr = e; }
    check('A.4b', '变量组形态下后到的 ready(options) 与首次不一致同样拒绝 TE_OPTIONS_CONFLICT（不静默忽略），且不影响首次的 Promise', errCode(optErr) === 'TE_OPTIONS_CONFLICT' && te.ready() === p1 && te.env() === e1, optErr && optErr.message);
    let secretErr = null;
    const SECRET_OPT = 'SENTINEL-KEY-47R4a-M3';
    try { await te.ready({ sourceDbPath: 'x.db', sourceEncryptionKey: SECRET_OPT }); } catch (e) { secretErr = e; }
    const secretText = secretErr ? `${secretErr.message}\n${secretErr.stack || ''}` : '';
    check('A.4c', '选项冲突的错误只报不一致的选项名、不回显选项值（47R4a M3）：消息含 sourceEncryptionKey / sourceDbPath 两个键名，消息与堆栈都不含传入的密钥值', errCode(secretErr) === 'TE_OPTIONS_CONFLICT' && /sourceEncryptionKey/.test(secretText) && /sourceDbPath/.test(secretText) && !secretText.includes(SECRET_OPT) && te.ready() === p1, secretErr && secretErr.message);
    const beforeTok = OPENED.length;
    const tok = await te.signToken(2);
    const openedTok = openedSince(beforeTok);
    let claims = null;
    try { claims = jwt.verify(tok, SECRET); } catch (_) { claims = null; }
    check('A.5', 'signToken(2)：用实例密钥签出的 token 可被该密钥验证，载荷是实例库 users 行（id / username / display_name / role），有效期 1 小时', claims && claims.id === 2 && claims.username === 'ti-user' && claims.display_name === '用户 乙' && claims.role === 'user' && claims.exp - claims.iat === 3600, claims);
    check('A.5b', 'signToken 以只读方式打开实例库（直接观测打开标志）：恰好打开 1 次实例库，标志含 OPEN_READONLY、不含 OPEN_READWRITE / OPEN_CREATE', openedTok.length === 1 && fold(openedTok[0].path) === fold(GOOD_DB) && isReadOnlyFlags(openedTok[0].flags), openedTok);
    let nf = null;
    try { await te.signToken(999); } catch (e) { nf = e; }
    check('A.6', 'signToken(不存在的用户) → TE_USER_NOT_FOUND', errCode(nf) === 'TE_USER_NOT_FOUND', nf && nf.message);
    check('A.7', 'childEnv() 恰好是四个 TEST_* 且与 env() 一致', J(te.childEnv()) === J({ TEST_INSTANCE: GOOD_ID, TEST_BASE_URL: stubUrl(), TEST_DB_PATH: path.resolve(GOOD_DB), TEST_JWT_SECRET: SECRET }), te.childEnv());
    const hitsPre = STUB.hits;
    await te.teardown();
    let torn = null;
    try { te.env(); } catch (e) { torn = e; }
    check('A.8', '变量组形态的 teardown() 是空操作（不动外部服务，不再发请求），之后 env() 抛 TE_TORN_DOWN、isReady() 为 false', errCode(torn) === 'TE_TORN_DOWN' && te.isReady() === false && STUB.hits === hitsPre, { hitsPre, hits: STUB.hits });
    te._internals.resetForTest();
}

// ================================================================ 节 B：输入校验（部分变量 / 空值 / 主机 / 形态）
async function sectionB() {
    console.log('\n== 节 B：变量组输入校验 ==');
    stubReset();
    const names = ['TEST_INSTANCE', 'TEST_BASE_URL', 'TEST_DB_PATH', 'TEST_JWT_SECRET'];
    const full = goodVars();
    const bad = [];
    let combos = 0;
    for (let mask = 1; mask < 15; mask += 1) {   // 非空真子集：14 个
        const e = {};
        names.forEach((n, i) => { if (mask & (1 << i)) e[n] = full[n]; });
        const spy = spyFetch();
        const r = await resolveWith(e, { fetchVersion: spy });
        combos += 1;
        const missing = names.filter((n) => !(n in e));
        if (errCode(r.error) !== 'TE_PARTIAL_VARS' || spy.calls.length !== 0 || !missing.every((n) => r.error.message.includes(n))) bad.push({ given: Object.keys(e), code: errCode(r.error), spyCalls: spy.calls.length });
    }
    check('B.1', `只给部分变量（四个变量的 ${combos} 个非空真子集）一律立即失败 TE_PARTIAL_VARS，消息点出缺哪些，且没有发出任何网络请求`, combos === 14 && bad.length === 0, bad);

    const rEmpty = await resolveWith(goodVars({ TEST_JWT_SECRET: '' }), { fetchVersion: spyFetch() });
    check('B.2', '变量给了空串 → TE_BAD_VALUE（空串也算「给了」，不当作缺省）', errCode(rEmpty.error) === 'TE_BAD_VALUE', rEmpty.error && rEmpty.error.message);

    const rInst = await resolveWith(goodVars({ TEST_INSTANCE: 'rd' }), { fetchVersion: spyFetch() });
    check('B.3', 'TEST_INSTANCE 不是 test- 开头（比如线名）→ TE_INSTANCE_NOT_TEST', errCode(rInst.error) === 'TE_INSTANCE_NOT_TEST', rInst.error && rInst.error.message);

    const nonLoop = ['http://192.0.2.1:3999', 'http://example.invalid', 'http://localhost.evil.invalid:3999', 'http://0.0.0.0:3999', 'http://[::ffff:127.0.0.1]:3999', 'http://192.168.1.100:3000'];
    const badHosts = [];
    for (const u of nonLoop) {
        const spy = spyFetch();
        const r = await resolveWith(goodVars({ TEST_BASE_URL: u }), { fetchVersion: spy });
        if (errCode(r.error) !== 'TE_NOT_LOOPBACK' || spy.calls.length !== 0) badHosts.push({ u, code: errCode(r.error), calls: spy.calls.length });
    }
    check('B.4', `TEST_BASE_URL 的主机不是本机回环（${nonLoop.length} 个：含生产地址、全零地址、映射地址、以 localhost 开头的外部域名）→ TE_NOT_LOOPBACK，且不发请求`, badHosts.length === 0, badHosts);

    // 变量组只接受 http（S3b 修复批 1）：服务身份核对只会 http.get，接受 https 等于接受一个永远连不上的地址（旧版 B.5 用替身掩盖了这一点）
    const okHosts = ['http://localhost:3999', 'http://127.0.0.1:3999', 'http://[::1]:3999'];
    const badOk = [];
    for (const u of okHosts) {
        const spy = spyFetch();
        const r = await resolveWith(goodVars({ TEST_BASE_URL: u }), { fetchVersion: spy });
        if (r.error || !r.value || spy.calls.length !== 1) badOk.push({ u, err: r.error && r.error.message });
    }
    const httpsForms = ['https://127.0.0.1:3999', 'https://localhost:3999', 'https://[::1]:3999', 'HTTPS://127.0.0.1:3999'];
    const badHttps = [];
    for (const u of httpsForms) {
        const spy = spyFetch();
        const r = await resolveWith(goodVars({ TEST_BASE_URL: u }), { fetchVersion: spy });
        if (errCode(r.error) !== 'TE_BAD_VALUE' || spy.calls.length !== 0 || !/http/.test(r.error.message)) badHttps.push({ u, code: errCode(r.error), calls: spy.calls.length });
    }
    check('B.5', `回环主机的三种写法（localhost / 127.0.0.1 / ::1）用 http 都被接受（对照组：B.4 的拒绝不是因为一律拒绝）；https（${httpsForms.length} 种写法）一律 TE_BAD_VALUE，且不发请求`, badOk.length === 0 && badHttps.length === 0, { badOk, badHttps });

    const badShapes = ['ftp://127.0.0.1:3999', 'http://user:pw@127.0.0.1:3999', 'http://127.0.0.1:3999/api', 'http://127.0.0.1:3999/?x=1', 'not a url', 'http://127.0.0.1:3999/#f'];
    const badShape = [];
    for (const u of badShapes) {
        const spy = spyFetch();
        const r = await resolveWith(goodVars({ TEST_BASE_URL: u }), { fetchVersion: spy });
        if (errCode(r.error) !== 'TE_BAD_VALUE' || spy.calls.length !== 0) badShape.push({ u, code: errCode(r.error), calls: spy.calls.length });
    }
    check('B.6', `TEST_BASE_URL 形态不合法（非 http(s) / 带凭证 / 带路径 / 带查询 / 带片段 / 非 URL）→ TE_BAD_VALUE`, badShape.length === 0, badShape);

    const rRel = await resolveWith(goodVars({ TEST_DB_PATH: 'relative/good.db' }), { fetchVersion: spyFetch() });
    check('B.7', 'TEST_DB_PATH 是相对路径 → TE_BAD_VALUE', errCode(rRel.error) === 'TE_BAD_VALUE', rRel.error && rRel.error.message);

    // 永不回落 3000：变量组指向 3000 一律拒绝，不发任何请求
    const p3000 = ['http://127.0.0.1:3000', 'http://localhost:3000', 'http://[::1]:3000', 'http://127.0.0.1:03000'];
    const bad3000 = [];
    for (const u of p3000) {
        const spy = spyFetch();
        const r = await resolveWith(goodVars({ TEST_BASE_URL: u }), { fetchVersion: spy });
        if (errCode(r.error) !== 'TE_BAD_VALUE' || spy.calls.length !== 0 || !/3000/.test(r.error.message)) bad3000.push({ u, code: errCode(r.error), calls: spy.calls.length });
    }
    const near = ['http://127.0.0.1:3001', 'http://127.0.0.1:30000', 'http://127.0.0.1:2999', 'http://127.0.0.1:13000'];
    const badNear = [];
    for (const u of near) {
        const spy = spyFetch();
        const r = await resolveWith(goodVars({ TEST_BASE_URL: u }), { fetchVersion: spy });
        if (r.error || !r.value || spy.calls.length !== 1) badNear.push({ u, err: r.error && r.error.message });
    }
    check('B.8', `TEST_BASE_URL 端口为 3000（${p3000.length} 种写法，含前导零）→ TE_BAD_VALUE，不发任何请求；对照组：相邻端口（3001 / 30000 / 2999 / 13000）被接受`, bad3000.length === 0 && badNear.length === 0, { bad3000, badNear });
}

// ================================================================ 节 C：路径核对（TEST_DB_PATH 指向业务库）
async function sectionC() {
    console.log('\n== 节 C：TEST_DB_PATH 指向业务库 ==');
    stubReset();
    STUB.state.instance = 'test-biz1';      // 服务身份「正确」：与 TEST_INSTANCE 一致
    const bizVars = (over) => goodVars(Object.assign({ TEST_INSTANCE: 'test-biz1', TEST_DB_PATH: BIZ_DB }, over || {}));
    const openedBefore = OPENED.length;
    const spy = spyFetch({ version: 'x', mode: 'isolated', instance: 'test-biz1' });
    const r = await resolveWith(bizVars(), { fetchVersion: spy });
    check('C.1', '服务身份正确 + 业务库里的库身份也恰好正确，只有 TEST_DB_PATH 指向本检出的业务库 → TE_DB_IS_BUSINESS（路径核对独立判红）', errCode(r.error) === 'TE_DB_IS_BUSINESS', r.error && r.error.message);
    check('C.2', '路径核对先于服务与库：被拒绝时没有发 /api/version 请求，业务库从未被打开', spy.calls.length === 0 && OPENED.slice(openedBefore).length === 0, { calls: spy.calls.length, opened: OPENED.slice(openedBefore) });
    const rCtl = await resolveWith(bizVars(), { fetchVersion: spyFetch({ version: 'x', mode: 'isolated', instance: 'test-biz1' }), wbsDir: SYN2 });
    check('C.3', '对照组：同样的变量，只把「本检出」换成另一个合成检出（业务库路径不同）→ 解析成功（C.1 的拒绝只来自路径比对）', !rCtl.error && rCtl.value && rCtl.value.instance === 'test-biz1', rCtl.error && rCtl.error.message);

    const upper = BIZ_DB.replace(/task_pool\.db$/, 'TASK_POOL.DB');
    const rUp = await resolveWith(bizVars({ TEST_DB_PATH: upper }), { fetchVersion: spyFetch({ version: 'x', mode: 'isolated', instance: 'test-biz1' }) });
    check('C.4', '换大小写写法（Windows 路径不分大小写）仍被识别 → TE_DB_IS_BUSINESS', errCode(rUp.error) === 'TE_DB_IS_BUSINESS', rUp.error && rUp.error.message);

    const LINK = path.join(PRIV, '联接 目录');
    fs.symlinkSync(SYN, LINK, 'junction');
    const rJ = await resolveWith(bizVars({ TEST_DB_PATH: path.join(LINK, 'task_pool.db') }), { fetchVersion: spyFetch({ version: 'x', mode: 'isolated', instance: 'test-biz1' }) });
    check('C.5', '经目录联接（junction）指到业务库 → realpath 后相同 → TE_DB_IS_BUSINESS', errCode(rJ.error) === 'TE_DB_IS_BUSINESS', rJ.error && rJ.error.message);
    common.removeLinkChecked(LINK);

    const HARD = path.join(INST_DIR, 'hardlink.db');
    let hardOk = true;
    try { fs.linkSync(BIZ_DB, HARD); } catch (_) { hardOk = false; }
    const rH = hardOk ? await resolveWith(bizVars({ TEST_DB_PATH: HARD }), { fetchVersion: spyFetch({ version: 'x', mode: 'isolated', instance: 'test-biz1' }) }) : { error: null };
    check('C.6', '经硬链接指到业务库（realpath 不同、同一物理文件）→ 按 dev + ino 识别 → TE_DB_IS_BUSINESS', hardOk && errCode(rH.error) === 'TE_DB_IS_BUSINESS', hardOk ? (rH.error && rH.error.message) : '本机 NTFS 硬链接创建失败');
    if (hardOk) fs.unlinkSync(HARD);

    // 业务库文件根本不存在时，dev + ino 无从判定，只能靠路径规范化（realpath + 大小写折叠）比较
    const SYN3 = path.join(PRIV, '检出 syn3', 'wbs');
    fs.mkdirSync(SYN3, { recursive: true });
    const bizMissing = path.join(SYN3, 'task_pool.db');
    const okSvc = () => spyFetch({ version: 'x', mode: 'isolated', instance: 'test-biz1' });
    const rUp3 = await resolveWith(bizVars({ TEST_DB_PATH: bizMissing.replace(/task_pool\.db$/, 'TASK_POOL.DB') }), { fetchVersion: okSvc(), wbsDir: SYN3 });
    check('C.4b', '业务库文件不存在（inode 判定无从下手）：换大小写写法 → 仍按路径规范化识别为业务库 TE_DB_IS_BUSINESS', errCode(rUp3.error) === 'TE_DB_IS_BUSINESS', rUp3.error && rUp3.error.message);
    const LINK3 = path.join(PRIV, '联接 目录3');
    fs.symlinkSync(SYN3, LINK3, 'junction');
    const rJ3 = await resolveWith(bizVars({ TEST_DB_PATH: path.join(LINK3, 'task_pool.db') }), { fetchVersion: okSvc(), wbsDir: SYN3 });
    check('C.5b', '业务库文件不存在：经目录联接指过去 → realpath 后相同 → TE_DB_IS_BUSINESS', errCode(rJ3.error) === 'TE_DB_IS_BUSINESS', rJ3.error && rJ3.error.message);
    common.removeLinkChecked(LINK3);
    const rCtl3 = await resolveWith(bizVars({ TEST_DB_PATH: bizMissing }), { fetchVersion: okSvc(), wbsDir: SYN });
    check('C.6b', '对照组：同一个（不存在的）路径，本检出换成 SYN 时它不是业务库 → 不报 TE_DB_IS_BUSINESS，而是走到库身份核对（TE_DB_IDENTITY）', errCode(rCtl3.error) === 'TE_DB_IDENTITY', rCtl3.error && rCtl3.error.message);

    // 线检出：线库也是「本检出的业务库」
    const lineEnv = (over) => goodVars(Object.assign({ TEST_INSTANCE: 'test-linedb1', TEST_DB_PATH: LINE_DB }, over || {}));
    // 线检出还要 SDH_DB_FILE（线库的位置），所以这里单独构造 deps
    const rLine2 = await (async () => {
        try { return { value: await te._internals.resolveEnvironment(undefined, { env: Object.assign({ SDH_DB_FILE: LINE_DB }, lineEnv()), wbsDir: LINE_WBS, fetchVersion: spyFetch({ version: 'x', mode: 'isolated', instance: 'test-linedb1' }) }), error: null }; } catch (e) { return { value: null, error: e }; }
    })();
    check('C.7', '线检出（.sdh-instance=rd，SDH_DB_FILE=线库）：TEST_DB_PATH 指向线库 → TE_DB_IS_BUSINESS', errCode(rLine2.error) === 'TE_DB_IS_BUSINESS', rLine2.error && rLine2.error.message);
    const rLineCtl = await (async () => {
        try { return { value: await te._internals.resolveEnvironment(undefined, { env: lineEnv(), wbsDir: SYN, fetchVersion: spyFetch({ version: 'x', mode: 'isolated', instance: 'test-linedb1' }) }), error: null }; } catch (e) { return { value: null, error: e }; }
    })();
    check('C.8', '对照组：同一变量在正常检出下解析成功（C.7 的拒绝来自线库路径）', !rLineCtl.error && !!rLineCtl.value, rLineCtl.error && rLineCtl.error.message);

    const rBad = await (async () => {
        try { return { value: await te._internals.resolveEnvironment(undefined, { env: goodVars(), wbsDir: LINE_BAD_WBS, fetchVersion: spyFetch() }), error: null }; } catch (e) { return { value: null, error: e }; }
    })();
    check('C.9', '本检出的运行模式判定被拒绝（.sdh-instance 内容非法）→ fail-closed：TE_MODE_REFUSED，不放行', errCode(rBad.error) === 'TE_MODE_REFUSED', rBad.error && rBad.error.message);

    // Win32 尾点 / 尾空格（S3b 预筛 MED-1）：业务库带合法 test- 身份、服务身份也正确，让「路径段尾点 / 尾空格」检查成为唯一防线；Node 的 fs 认不出 `task_pool.db.`（ENOENT），SQLite 的 CreateFileW 却会规范化后打开业务库
    const biz3 = [
        ['尾点 task_pool.db.', `${BIZ_DB}.`],
        ['尾空格 task_pool.db␠', `${BIZ_DB} `],
        ['中间段带点 wbs.\\task_pool.db', path.join(path.dirname(SYN), 'wbs.', 'task_pool.db')],
    ];
    for (const [i, [label, p]] of biz3.entries()) {
        const before = OPENED.length;
        const sp = okSvc();
        const rr = await resolveWith(bizVars({ TEST_DB_PATH: p }), { fetchVersion: sp });
        check(`C.${10 + i}`, `Win32 路径规范化绕过（${label}）：业务库带合法 test- 身份、服务身份正确，只有路径段检查可拦 → TE_BAD_VALUE，不发请求，业务库没有被打开（守卫记录规范化后无业务库）`,
            errCode(rr.error) === 'TE_BAD_VALUE' && /以 \. 或空格结尾/.test(rr.error.message) && sp.calls.length === 0 && OPENED.slice(before).length === 0 && BIZ_OPENED(before).length === 0,
            { code: errCode(rr.error), msg: rr.error && rr.error.message, calls: sp.calls.length, opened: OPENED.slice(before) });
    }
    // 对照组必须真的带着 `.` / `..` 段进去：path.join 会把它们规范化掉（旧版 C.13 的输入里一个 .. 也没有，等于没测）——这里用字符串拼接构造原始路径，先断言输入确实含这些段，再断言解析成功
    const rawDD = `${INST_DIR}${path.sep}..${path.sep}${path.basename(INST_DIR)}${path.sep}.${path.sep}good.db`;
    const ddSegs = rawDD.split(/[\\/]+/);
    const spyDD = spyFetch();
    const rDD = await resolveWith(goodVars({ TEST_DB_PATH: rawDD }), { fetchVersion: spyDD });
    check('C.13', '对照组：原始路径里真的含 `..` 与 `.` 段（字符串拼接构造、先断言输入含这些段；规范化后指向实例库）不被当作「尾点」误拒 → 解析成功、dbPath 是规范化后的实例库、发了 1 次服务身份请求',
        ddSegs.includes('..') && ddSegs.includes('.') && ddSegs.filter((s) => s === '..').length === 1 && te._internals.trailingDotOrSpaceSegment(rawDD) === null
        && !rDD.error && !!rDD.value && fold(rDD.value.dbPath) === fold(GOOD_DB) && spyDD.calls.length === 1,
        { rawDD, segs: ddSegs, err: rDD.error && rDD.error.message });
}

// ================================================================ 节 D：服务身份 / 库身份
async function sectionD() {
    console.log('\n== 节 D：服务身份 / 库身份 ==');
    stubReset();
    const openedBefore = OPENED.length;
    STUB.state.instance = 'test-notgood';
    const rSvc = await resolveWith(goodVars());
    check('D.1', '服务身份不符：/api/version 的 instance 不是 TEST_INSTANCE（库身份与路径都正确）→ TE_SERVICE_IDENTITY', errCode(rSvc.error) === 'TE_SERVICE_IDENTITY', rSvc.error && rSvc.error.message);
    check('D.2', '服务身份不符时库一个都没打开（服务核对先于库核对）', OPENED.slice(openedBefore).length === 0, OPENED.slice(openedBefore));
    stubReset(); STUB.state.mode = 'normal';
    const rMode = await resolveWith(goodVars());
    check('D.3', '服务身份：instance 对但 mode 是 normal（不是 isolated）→ TE_SERVICE_IDENTITY', errCode(rMode.error) === 'TE_SERVICE_IDENTITY', rMode.error && rMode.error.message);
    stubReset(); STUB.state.mutate = (req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ version: 'stub', mode: 'isolated' })); };
    const rNoInst = await resolveWith(goodVars());
    check('D.4', '服务身份：应答里没有 instance 字段 → TE_SERVICE_IDENTITY', errCode(rNoInst.error) === 'TE_SERVICE_IDENTITY', rNoInst.error && rNoInst.error.message);

    stubReset();
    const rDb = await resolveWith(goodVars({ TEST_DB_PATH: OTHER_DB }));
    check('D.5', '库身份不符：服务身份正确、TEST_DB_PATH 是另一个实例的库（_sdh_instance.instance_id 不同）→ TE_DB_IDENTITY（INSTANCE_MISMATCH）', errCode(rDb.error) === 'TE_DB_IDENTITY' && /INSTANCE_MISMATCH/.test(rDb.error.message), rDb.error && rDb.error.message);
    const rNo = await resolveWith(goodVars({ TEST_DB_PATH: NOID_DB }));
    check('D.6', '库身份：库里没有 _sdh_instance 表（业务库形态）→ TE_DB_IDENTITY（TABLE_MISSING）', errCode(rNo.error) === 'TE_DB_IDENTITY' && /TABLE_MISSING/.test(rNo.error.message), rNo.error && rNo.error.message);
    const missing = path.join(INST_DIR, 'missing.db');
    const rMiss = await resolveWith(goodVars({ TEST_DB_PATH: missing }));
    check('D.7', '库身份：文件不存在 → TE_DB_IDENTITY，且核对没有顺手建出空库', errCode(rMiss.error) === 'TE_DB_IDENTITY' && lstatOrNull(missing) === null, rMiss.error && rMiss.error.message);
    stubReset();
    const rOk = await resolveWith(goodVars());
    check('D.8', '对照组：D.1–D.7 的变量只换掉各自的一项后恢复原样 → 解析成功', !rOk.error && !!rOk.value, rOk.error && rOk.error.message);

    // 服务不可达 / 应答异常
    const closed = await listenOnSafePort(http.createServer());
    const closedPort = closed.address().port;
    await new Promise((r) => closed.close(r));
    const rClosed = await resolveWith(goodVars({ TEST_BASE_URL: `http://127.0.0.1:${closedPort}` }));
    check('D.9', '服务不可达（端口无人监听）→ TE_SERVICE_UNREACHABLE', errCode(rClosed.error) === 'TE_SERVICE_UNREACHABLE', rClosed.error && rClosed.error.message);
    const variants = [
        ['HTTP 500', (req, res) => { res.statusCode = 500; res.end('{}'); }],
        ['非 JSON 正文', (req, res) => { res.end('<html>'); }],
        ['JSON 数组', (req, res) => { res.end('[]'); }],
        ['302 重定向（不跟随）', (req, res) => { res.statusCode = 302; res.setHeader('Location', '/elsewhere'); res.end(); }],
        ['正文超过 1MB', (req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(`{"x":"${'a'.repeat(1100 * 1024)}"}`); }],
    ];
    const badVar = [];
    for (const [label, fn] of variants) {
        stubReset(); STUB.state.mutate = fn;
        const r = await resolveWith(goodVars());
        if (errCode(r.error) !== 'TE_SERVICE_UNREACHABLE') badVar.push({ label, code: errCode(r.error) });
    }
    check('D.10', `服务应答异常（${variants.map((v) => v[0]).join(' / ')}）一律 TE_SERVICE_UNREACHABLE，不当作身份通过`, badVar.length === 0, badVar);
    stubReset(); STUB.state.mutate = () => { /* 永不应答 */ };
    const t0 = now();
    const rHang = await resolveWith(goodVars());
    const dt = now() - t0;
    check('D.11', '服务只接受连接不应答 → 5 秒左右的截止后 TE_SERVICE_UNREACHABLE（不挂起；单调时钟，上界放宽到 12 秒只为挡「永不结束」）', errCode(rHang.error) === 'TE_SERVICE_UNREACHABLE' && dt >= 4500 && dt < 12000, { code: errCode(rHang.error), ms: dt });
    stubReset();

    // D.12 总截止：桩每隔 300ms（远小于 5 秒空闲超时）滴一小块正文，14 秒后才正常收尾——只有空闲超时的实现要等到 14 秒（且拿到一个没有 instance 的应答），总截止的实现在 5 秒左右失败。
    //   桩的计时器与连接独立收尾：连接关闭时清自己的计时器；用例结束时清掉所有遗留。
    const drip = { timers: new Set(), sockets: new Set(), closedAt: null };
    const dripCleanup = () => { for (const t of drip.timers) { clearInterval(t); clearTimeout(t); } drip.timers.clear(); for (const s of drip.sockets) { try { s.destroy(); } catch (_) { /* 已关闭 */ } } drip.sockets.clear(); };
    stubReset();
    STUB.state.mutate = (req, res) => {
        drip.sockets.add(req.socket);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"x":"');
        const iv = setInterval(() => { if (res.destroyed || res.writableEnded) { clearInterval(iv); return; } res.write('a'); }, 300);
        const stop = setTimeout(() => { clearInterval(iv); if (!res.destroyed && !res.writableEnded) res.end('"}'); }, 14000);
        drip.timers.add(iv); drip.timers.add(stop);
        res.on('close', () => { clearInterval(iv); clearTimeout(stop); drip.timers.delete(iv); drip.timers.delete(stop); drip.closedAt = now(); });
    };
    const td0 = now();
    const rDrip = await resolveWith(goodVars());
    const dtd = now() - td0;
    for (let i = 0; i < 20 && drip.closedAt === null; i += 1) await sleep(100);   // 客户端销毁连接后，桩应当在片刻内看到关闭
    check('D.12', '总截止：对端持续滴正文（间隔 300ms < 5 秒空闲超时）→ 5 秒左右 TE_SERVICE_UNREACHABLE（不等到对端 14 秒后收尾；上界 10 秒，明显早于 14 秒）；客户端销毁了连接（桩看到关闭，不是等桩自己收尾）',
        errCode(rDrip.error) === 'TE_SERVICE_UNREACHABLE' && dtd >= 4500 && dtd < 10000 && drip.closedAt !== null && drip.closedAt - td0 < 10000, { code: errCode(rDrip.error), ms: dtd, closedAtMs: drip.closedAt === null ? null : drip.closedAt - td0 });
    dripCleanup();
    stubReset();

    // D.13 非 200 分支同样销毁：500 + 持续滴正文——失败应在首个响应头到达后立即发生，并且客户端销毁响应（桩马上看到关闭）
    const non200 = { closedAt: null, timers: new Set() };
    STUB.state.mutate = (req, res) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.write('{"err":"');
        const iv = setInterval(() => { if (res.destroyed || res.writableEnded) { clearInterval(iv); return; } res.write('x'); }, 200);
        const stop = setTimeout(() => { clearInterval(iv); if (!res.destroyed && !res.writableEnded) res.end('"}'); }, 6000);
        non200.timers.add(iv); non200.timers.add(stop);
        res.on('close', () => { clearInterval(iv); clearTimeout(stop); non200.closedAt = now(); });
    };
    const tn0 = now();
    const rN = await resolveWith(goodVars());
    for (let i = 0; i < 40 && non200.closedAt === null; i += 1) await sleep(100);   // 最多再等 4 秒（桩自己 6 秒后才收尾：没有销毁的实现要到那时桩才看到关闭）
    check('D.13', '非 200 分支同样销毁：对端 500 且持续滴正文 → 立即 TE_SERVICE_UNREACHABLE，且桩在 3.5 秒内看到连接关闭（明显早于桩自己 6 秒后的收尾；不是 res.resume() 之后任连接留着；单调时钟）',
        errCode(rN.error) === 'TE_SERVICE_UNREACHABLE' && /HTTP 500/.test(rN.error.message) && non200.closedAt !== null && non200.closedAt - tn0 < 3500, { code: errCode(rN.error), msg: rN.error && rN.error.message, closedAtMs: non200.closedAt === null ? null : non200.closedAt - tn0 });
    for (const t of non200.timers) { clearInterval(t); clearTimeout(t); }
    stubReset();
}

// ================================================================ 节 E：live 形态 / 永不回落 3000
async function sectionE() {
    console.log('\n== 节 E：live 形态与「永不回落 3000」 ==');
    stubReset();
    const liveEnv = (over) => Object.assign({ TEST_TARGET: 'live', TEST_LIVE_URL: stubUrl() }, over || {});
    let started = 0;
    const startSpy = async () => { started += 1; throw new Error('不应该起实例'); };
    const r = await resolveWith(liveEnv(), { startTestInstance: startSpy });
    const v = r.value;
    let dbErr = null; let secErr = null;
    try { void v.dbPath; } catch (e) { dbErr = e; }
    try { void v.jwtSecret; } catch (e) { secErr = e; }
    check('E.1', 'live（正常模式检出 + TEST_TARGET=live + TEST_LIVE_URL）：live=true、baseUrl 为给定地址、不起实例、不发任何请求', v && v.live === true && v.selfStarted === false && v.baseUrl === stubUrl() && started === 0 && STUB.hits === 0, r.error && r.error.message);
    check('E.2', 'live 的 dbPath / jwtSecret 访问即抛（TE_LIVE_NO_DB / TE_LIVE_NO_TOKEN），且不可枚举：展开 / JSON 序列化不触发', errCode(dbErr) === 'TE_LIVE_NO_DB' && errCode(secErr) === 'TE_LIVE_NO_TOKEN' && !('dbPath' in Object.assign({}, v)) && typeof J(v) === 'string', { db: dbErr && dbErr.code, sec: secErr && secErr.code });

    te._internals.resetForTest({ env: liveEnv(), wbsDir: SYN, startTestInstance: startSpy });
    await te.ready();
    let tokErr = null;
    try { await te.signToken(1); } catch (e) { tokErr = e; }
    let dbErr2 = null;
    try { void te.env().dbPath; } catch (e) { dbErr2 = e; }
    check('E.3', 'live 经公开 API：signToken 抛 TE_LIVE_NO_TOKEN、env().dbPath 抛 TE_LIVE_NO_DB、childEnv() 是 TEST_TARGET + TEST_LIVE_URL', errCode(tokErr) === 'TE_LIVE_NO_TOKEN' && errCode(dbErr2) === 'TE_LIVE_NO_DB' && J(te.childEnv()) === J({ TEST_TARGET: 'live', TEST_LIVE_URL: stubUrl() }), te.childEnv());
    te._internals.resetForTest();

    const conflicts = [];
    for (const k of ['TEST_INSTANCE', 'TEST_BASE_URL', 'TEST_DB_PATH', 'TEST_JWT_SECRET']) {
        const r2 = await resolveWith(liveEnv({ [k]: goodVars()[k] }), { startTestInstance: startSpy });
        if (errCode(r2.error) !== 'TE_LIVE_CONFLICT') conflicts.push({ k, code: errCode(r2.error) });
    }
    check('E.4', 'TEST_TARGET=live 与四个变量中的任何一个并存 → TE_LIVE_CONFLICT（互斥）', conflicts.length === 0, conflicts);

    const shapes = [
        [{ TEST_TARGET: 'live' }, 'live 缺 TEST_LIVE_URL'],
        [{ TEST_TARGET: 'live', TEST_LIVE_URL: '' }, 'TEST_LIVE_URL 为空串'],
        [{ TEST_LIVE_URL: stubUrl() }, '只给 TEST_LIVE_URL 没有 TEST_TARGET'],
        [{ TEST_TARGET: 'prod', TEST_LIVE_URL: stubUrl() }, 'TEST_TARGET 不是 live'],
        [{ TEST_TARGET: 'live', TEST_LIVE_URL: `${stubUrl()}/api` }, 'TEST_LIVE_URL 带路径'],
    ];
    const badShape = [];
    for (const [e, label] of shapes) {
        const r2 = await resolveWith(e, { startTestInstance: startSpy });
        if (errCode(r2.error) !== 'TE_BAD_VALUE') badShape.push({ label, code: errCode(r2.error) });
    }
    check('E.5', `live 的输入不合法（${shapes.map((s) => s[1]).join(' / ')}）→ TE_BAD_VALUE，不回落任何默认地址`, badShape.length === 0 && started === 0, badShape);

    const rLine = await (async () => {
        try { return { value: await te._internals.resolveEnvironment(undefined, { env: liveEnv(), wbsDir: LINE_WBS, startTestInstance: startSpy }), error: null }; } catch (e) { return { value: null, error: e }; }
    })();
    check('E.6', 'live 只允许正常模式检出：线检出里 → TE_LIVE_NOT_NORMAL', errCode(rLine.error) === 'TE_LIVE_NOT_NORMAL', rLine.error && rLine.error.message);

    // 永不回落 3000
    const failStart = async () => { const e = new Error('启动器失败（桩）'); e.code = 'TI_STUB_FAIL'; throw e; };
    const rFail = await resolveWith({}, { startTestInstance: failStart });
    check('E.7', '变量全部缺省且自起失败 → 原样抛出启动器的错误，不回落任何默认地址（尤其不是 3000）', errCode(rFail.error) === 'TI_STUB_FAIL' && rFail.value === null, rFail.error && rFail.error.message);
    const fakeHandle = { baseUrl: 'http://127.0.0.1:41234', dbPath: path.join(PRIV, 'x.db'), instance: 'test-fake1', jwtSecret: 's', dataDir: PRIV, logFile: null, startupRaceRetries: 1, stop: async () => {} };
    let seenOptions = null;
    const rStart = await resolveWith({}, { startTestInstance: async (o) => { seenOptions = o; return fakeHandle; }, options: { resources: ['uploads'] } });
    check('E.8', '变量全部缺省 → 调用启动器（options 原样透传），env 取启动器返回的地址 / 库 / 密钥，selfStarted=true、startupRaceRetries 透传', rStart.value && rStart.value.selfStarted === true && rStart.value.baseUrl === fakeHandle.baseUrl && !/:3000(?!\d)/.test(rStart.value.baseUrl) && rStart.value.startupRaceRetries === 1 && J(seenOptions) === J({ resources: ['uploads'] }), rStart.error && rStart.error.message);

    // 变量组只接受 http 不影响 live：TEST_LIVE_URL 可以是 https（真实环境核对）
    const rLiveHttps = await resolveWith(liveEnv({ TEST_LIVE_URL: 'https://example.invalid' }), { startTestInstance: startSpy });
    check('E.9', 'TEST_LIVE_URL 不受「变量组只接受 http」限制：https 地址被接受（live=true，baseUrl 为该 origin），仍不起实例、不发请求', rLiveHttps.value && rLiveHttps.value.live === true && rLiveHttps.value.baseUrl === 'https://example.invalid' && started === 0 && STUB.hits === 0, rLiveHttps.error && rLiveHttps.error.message);
}

// ================================================================ 节 F：自起实例（真启动器 + 桩服务）

/**
 * 起一个 node 辅助进程（helper.js），`--require` 共享预加载片段 test-reap-preload.js（库路径守卫 + `.env` 读取守卫 + 启动器句柄立即登记，登记写进套件的同一份登记文件，归属 = owner），
 * 等它关闭（close，输出已排空）；返回 { owner, json, lines, stdout, stderr, code, exited, killedByTimeout, killedOnLine, spawnError, violations, readyAt, closedAt }。
 * 辅助进程自己返回前就登记进回收器（PID + 精确创建时间 + 归属）；它起的服务不靠它打印的 info 行登记，由预加载片段在启动器交出句柄时登记。
 * opts.killOnLine：stdout 里一出现这段文字，父进程就按句柄杀掉辅助进程（F.24 的「局部超时」：不等整段超时）。
 */
let helperSeq = 0;
const HELPER_UNEXPECTED_VIOLATIONS = [];   // 非预期的辅助进程守卫违规（Z.1 / Z.2 汇总）
/**
 * 读辅助进程的违规记录文件（13T-R2 H2）：不存在 = 没有违规（正常，ENOENT）；其他读取失败、解析失败的行都记持久问题进最外层闸门（HELPER_VIOLATION_FILE_ERRORS），不再整体降成「没有违规」；
 * 辅助进程登记写失败（kind=reg）持久记进 HELPER_REG_FAILURES——不受 runHelper 的 expectViolations 影响。返回解析成功的违规记录。
 */
function readViolations(label, vfile) {
    const violations = [];
    let text = '';
    try { text = fs.readFileSync(vfile, 'utf8'); } catch (e) { if (!(e && e.code === 'ENOENT')) HELPER_VIOLATION_FILE_ERRORS.push(`${label}：读取 ${path.basename(vfile)} 失败（${(e && e.code) || (e && e.message)}）`); }
    for (const l of text.split(/\r?\n/).filter(Boolean)) {
        try { violations.push(JSON.parse(l)); } catch (_) { HELPER_VIOLATION_FILE_ERRORS.push(`${label}：${path.basename(vfile)} 里有无法解析的一行 ${J(l.slice(0, 40))}`); }
    }
    for (const v of violations) if (v && v.kind === 'reg') HELPER_REG_FAILURES.push(Object.assign({ mode: label }, v));
    return violations;
}
function helperEnv(extraEnv, vfile, owner) {
    const env = {};
    for (const k of Object.keys(process.env)) { if (!TEST_VAR_RE.test(k)) env[k] = process.env[k]; }   // 先清宿主的变量组 / live 变量（不分大小写），再显式注入本用例的值
    return Object.assign(env, {
        NODE_PATH: path.join(WBS, 'node_modules'), HELPER_TE: TE_PATH, HELPER_SRC: SRC, HELPER_STUB: STUB_JS,
        SDH_REAP_PRIV: PRIV, SDH_REAP_REGISTRY: REGISTRY_FILE, SDH_REAP_OWNER: owner, SDH_REAP_VIOLATIONS: vfile, SDH_REAP_TI: TI_PATH, SDH_REAP_LIB: REAP_PATH,
    }, extraEnv || {});
}
async function runHelper(mode, extraEnv, opts) {
    const o = opts || {};
    helperSeq += 1;
    const owner = `helper-${helperSeq}-${mode}`;
    const vfile = path.join(PRIV, `helper-violations-${helperSeq}.jsonl`);
    const pre = (o.preRequire || []).flatMap((p) => ['--require', p]);   // 先于预加载片段加载（DETACH_JS：让启动器起的服务成为 detached）
    const child = spawn(process.execPath, [...pre, '--require', PRELOAD_PATH, HELPER_JS, mode, ...(o.args || [])], { cwd: PRIV, env: helperEnv(extraEnv, vfile, owner), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    track(`helper-${mode}`, child, owner);
    let stdout = ''; let stderr = ''; let spawnError = null; let readyAt = null; let closedAt = null; let killedOnLine = false;   // readyAt / closedAt：单调时钟（now()）
    child.stdout.on('data', (c) => {
        stdout += c;
        if (readyAt === null && stdout.includes('\n')) readyAt = now();
        if (o.killOnLine && !killedOnLine && stdout.includes(o.killOnLine)) { killedOnLine = true; try { child.kill(); } catch (_) { /* 下面等 close；仍不退出则走超时路径 */ } }
    });
    child.stderr.on('data', (c) => { stderr += c; });
    child.once('error', (e) => { spawnError = e; });
    const closed = await new Promise((resolve) => {
        let done = false;
        const fin = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
        const timer = setTimeout(() => fin(false), o.timeoutMs || 60000);
        child.once('close', () => { closedAt = now(); fin(true); });
        child.once('error', () => fin(true));   // spawn 失败不会有 close
    });
    let killedByTimeout = false;
    if (!closed) {
        killedByTimeout = true;
        try { child.kill(); } catch (_) { /* 下面有界等待关闭 */ }
        await new Promise((r) => { const t = setTimeout(r, 5000); child.once('close', () => { clearTimeout(t); r(); }); });
    }
    const lines = [];
    for (const l of stdout.split(/\r?\n/)) { if (l.startsWith('{')) { try { lines.push(JSON.parse(l)); } catch (_) { /* 半截行不算 */ } } }
    const json = lines.find((x) => x && x.pid) || lines[0] || null;
    const info = lines.find((x) => x && x.pid);   // 注意：reached:true 之类不带 pid 的行不算 info（服务的登记不靠它：由预加载片段在启动器交出句柄时写）
    if (o.corruptViolations) { try { fs.appendFileSync(vfile, '{"kind":"db","path":\n'); } catch (_) { /* 接缝写不进去：下面照常读 */ } }   // 节 S 的 viol-corrupt 接缝：违规记录文件里混进一行损坏的 JSON
    const violations = readViolations(`helper-${mode}`, vfile);
    if (violations.length && !o.expectViolations) HELPER_UNEXPECTED_VIOLATIONS.push(...violations.map((v) => Object.assign({ mode }, v)));
    return { owner, json, info: info || null, lines, stdout, stderr, code: child.exitCode, signal: child.signalCode, exited: closed, killedByTimeout, killedOnLine, spawnError, violations, readyAt, closedAt };
}

async function sectionF() {
    console.log('\n== 节 F：全部缺省 → 自起临时实例 ==');
    stubReset();
    te._internals.resetForTest();
    const dirsBefore = tmpInstanceDirs();
    // 三次调用都带（各自新建的）合成来源选项：幂等失效时会多起实例，但绝不会走到「默认来源」（默认来源要读本检出的 .env 和业务库）
    const p1 = te.ready(SELF());
    const p2 = te.ready(Object.assign({ serverJs: STUB_JS }, { sourceEncryptionKey: null, sourceDbPath: SRC }));   // 键序不同、内容相同
    const p3 = te.ready(SELF());
    const [e1, e2, e3] = await Promise.all([p1, p2, p3]);
    regEnv('F-main', e1); regEnv('F-main', e2); regEnv('F-main', e3);
    // 不传 options 的后续调用（= 与首次一致）：只在幂等成立时才调用——幂等失效时 ready() 不带来源选项会走到启动器的默认来源（本检出的 .env + 业务库），守卫虽会拦下，但没必要去碰
    const idempotent = p1 === p2 && p2 === p3 && e1 === e2 && e2 === e3;
    const p4 = idempotent ? te.ready() : null;
    check('F.1', '全部缺省 → 自起实例成功；并发三次 ready()（options 内容相同键序不同）与之后不传 options 的 ready() 得到同一个 Promise / 同一个结果，只建了一个实例', idempotent && p4 === p1 && tmpInstanceDirs().length === dirsBefore.length + 1, { dirs: tmpInstanceDirs() });
    let conflictA = null; let conflictB = null;
    try { await te.ready(Object.assign(SELF(), { readyTimeoutMs: 30000 })); } catch (e) { conflictA = e; }
    try { await te.ready({ resources: ['uploads'] }); } catch (e) { conflictB = e; }
    check('F.1b', 'ready(options) 选项冲突：第二次起的 options 与首次不一致（多了 readyTimeoutMs / 换成 resources）→ 拒绝 TE_OPTIONS_CONFLICT，不再静默忽略；首次的 Promise 与实例不受影响，没有多起实例',
        idempotent && errCode(conflictA) === 'TE_OPTIONS_CONFLICT' && errCode(conflictB) === 'TE_OPTIONS_CONFLICT' && te.ready() === p1 && te.env() === e1 && tmpInstanceDirs().length === dirsBefore.length + 1, { a: conflictA && conflictA.message, b: conflictB && conflictB.message });
    const port = Number(new URL(e1.baseUrl).port);
    check('F.2', '自起实例：baseUrl 是 127.0.0.1 上 20000–49999 的随机端口（不是 3000）、selfStarted=true、live=false、实例身份 test- 开头、logFile 在数据根里', e1.selfStarted === true && e1.live === false && port >= 20000 && port <= 49999 && port !== 3000 && /^test-/.test(e1.instance) && e1.logFile && fold(path.dirname(e1.logFile)) === fold(e1.dataDir), e1);
    const idr = await instanceDb.checkInstanceIdentity(e1.dbPath, { expectedInstance: e1.instance });
    check('F.3', '自起实例的库：库内身份等于实例身份；库在数据根里、不是来源库；来源库字节未变（sha256 前后一致）', idr.ok && fold(path.dirname(e1.dbPath)) === fold(e1.dataDir) && fold(e1.dbPath) !== fold(SRC) && sha256(fs.readFileSync(SRC)) === SRC_SHA, idr);
    const ver = await httpGet(port, '/api/version');
    check('F.4', '实例在应答：/api/version 的 instance 等于 env().instance', ver.status === 200 && ver.json && ver.json.instance === e1.instance, ver);
    const tok = await te.signToken(1);
    let claims = null; try { claims = jwt.verify(tok, e1.jwtSecret); } catch (_) { claims = null; }
    check('F.5', '自起实例的 signToken(1)：用实例密钥可验证、载荷来自实例库的 users 行', claims && claims.id === 1 && claims.username === 'ti-admin' && claims.role === 'admin', claims);
    const ce = te.childEnv();
    check('F.6', 'childEnv()：四个 TEST_*，取自自起的实例', ce.TEST_INSTANCE === e1.instance && ce.TEST_BASE_URL === e1.baseUrl && fold(ce.TEST_DB_PATH) === fold(e1.dbPath) && ce.TEST_JWT_SECRET === e1.jwtSecret && Object.keys(ce).length === 4, ce);

    // 变量组向子进程传递：子进程在变量组形态下核对同一个实例
    const kid = await runHelper('provided', Object.assign({}, ce, { HELPER_WBS: SYN }));
    check('F.7', '把 childEnv() 传给子进程：子进程走变量组形态，三项核对通过，拿到同一个地址 / 库 / 密钥，selfStarted=false（不再起第二个实例）；辅助进程守卫无违规', kid.json && kid.json.baseUrl === e1.baseUrl && kid.json.instance === e1.instance && fold(kid.json.dbPath) === fold(e1.dbPath) && kid.json.jwtSecret === e1.jwtSecret && kid.json.selfStarted === false && tmpInstanceDirs().length === dirsBefore.length + 1 && kid.violations.length === 0, kid);

    // 辅助进程环境隔离：宿主残留的 TEST_* 不泄漏进辅助进程（宿主变量组会改变辅助进程的运行形态）。临时在套件进程里放 6 个（含小写写法），跑完立即删除
    const leakNames = ['TEST_INSTANCE', 'TEST_BASE_URL', 'TEST_DB_PATH', 'TEST_JWT_SECRET', 'test_target', 'Test_Live_Url'];
    for (const k of leakNames) process.env[k] = 'host-leak';
    const dump = await runHelper('envdump', {});
    for (const k of leakNames) delete process.env[k];
    check('F.7c', '辅助进程环境隔离：宿主环境里的 TEST_INSTANCE / TEST_BASE_URL / TEST_DB_PATH / TEST_JWT_SECRET / TEST_TARGET / TEST_LIVE_URL（含小写写法）一个都没带进辅助进程', dump.json && Array.isArray(dump.json.keys) && dump.json.keys.length === 0 && dump.code === 0, dump.json);

    const handle = e1._handle;
    const pid = handle.pid; const start = handle.startTime; const dir = e1.dataDir;
    await te.teardown();
    const t2 = te.teardown();
    await t2;
    const after = await httpGet(port, '/api/version');
    let torn = null; try { te.env(); } catch (e) { torn = e; }
    check('F.8', 'teardown()：服务进程已消失（PID + 创建时间）、端口不再应答、数据根已删；重复调用幂等；之后 env() 抛 TE_TORN_DOWN', !!start && gone(pid, start) && after.status === 0 && lstatOrNull(dir) === null && errCode(torn) === 'TE_TORN_DOWN' && te.isReady() === false, { id: identityState(pid, start), after: after.status, dir: !!lstatOrNull(dir) });
    check('F.9', '收尾后 TMP 下没有遗留的 sdh-test-* 目录', tmpInstanceDirs().length === dirsBefore.length, tmpInstanceDirs());

    // 退出路径：process.exit / 未捕获异常
    for (const mode of ['exit', 'throw']) {
        const h = await runHelper(mode, {});
        const j = h.info;
        const dead = j && gone(j.pid, j.startTime);
        check(`F.10${mode}`, `脚本以 ${mode === 'exit' ? 'process.exit(0)' : '未捕获异常'} 结束（没有调用 teardown）：服务进程随之消失，数据根被删；辅助进程守卫无违规`, j && h.exited && dead && lstatOrNull(j.dataDir) === null && h.violations.length === 0, { out: h.stdout.slice(0, 200), exited: h.exited, state: j && identityState(j.pid, j.startTime), dir: j && !!lstatOrNull(j.dataDir), code: h.code, err: h.stderr.slice(-300), violations: h.violations });
    }

    // 自然结束（S3b 修复批 1，codex 13 H1）：自起实例后什么都不做——没有 teardown()、没有 process.exit()——进程必须在有界时间内自行退出，服务按身份消失，数据根删除。
    //   修复批 2a：退出码兜底生效——这种收尾的退出码是 EXIT_CODE_NO_TEARDOWN（70）并带一行原因，不再是静默的 0。
    //   墙钟去敏（13T-R L）：辅助进程里把启动器的终止等待截止注入成 30 秒（HELPER_WAIT_MS）。「遗留计时器」会让进程多活到 30 秒，正常是百毫秒量级，判定阈值 10 秒（耗时用单调时钟）——
    //   机器再慢也不会把正常误判成遗留，遗留也不会被 3 秒这类阈值的抖动掩盖。
    const WAIT_INJECT = { HELPER_WAIT_MS: '30000' };
    const nat = await runHelper('natural', WAIT_INJECT, { timeoutMs: 60000 });
    const nj = nat.info;
    const natMs = nat.closedAt !== null && nat.readyAt !== null ? nat.closedAt - nat.readyAt : null;
    check('F.17', '自起实例的脚本什么都不做、自然结束（没有 teardown()、没有 process.exit()）：辅助进程在 60 秒截止内自行退出（不是被超时终止）、退出码是兜底的 70 且 stderr 有原因行（不再是静默的 0）、服务身份已消失（dead / reused）、数据根已删、守卫无违规',
        !!nj && nat.exited && !nat.killedByTimeout && nat.code === te.EXIT_CODE_NO_TEARDOWN && te.EXIT_CODE_NO_TEARDOWN === 70 && /退出码兜底/.test(nat.stderr) && gone(nj.pid, nj.startTime) && lstatOrNull(nj.dataDir) === null && nat.violations.length === 0,
        { exited: nat.exited, killedByTimeout: nat.killedByTimeout, code: nat.code, readyToCloseMs: natMs, state: nj && identityState(nj.pid, nj.startTime), dir: nj && !!lstatOrNull(nj.dataDir), out: nat.stdout.slice(0, 400), err: nat.stderr.slice(-300) });
    check('F.17b', '自然结束是「有界」的：从 ready 到进程退出不到 10 秒（单调时钟；启动器终止等待截止已注入成 30 秒，正常是百毫秒量级，遗留计时器会拖到 30 秒）',
        natMs !== null && natMs < 10000, { naturalMs: natMs });
    const tde = await runHelper('teardownend', WAIT_INJECT, { timeoutMs: 60000 });
    const tj = tde.info;
    const tdeMs = tde.closedAt !== null && tde.readyAt !== null ? tde.closedAt - tde.readyAt : null;
    check('F.17c', '显式 await teardown() 之后自然结束（不调 process.exit）：辅助进程自行退出（退出码 0：teardown 过了，兜底不介入）、从 ready 到退出不到 10 秒（终止等待截止注入成 30 秒：启动器 waitExit 赢了竞速不清计时器就会拖到 30 秒）、服务已消失、数据根已删',
        !!tj && tde.exited && !tde.killedByTimeout && tde.code === 0 && tdeMs !== null && tdeMs < 10000 && gone(tj.pid, tj.startTime) && lstatOrNull(tj.dataDir) === null && tde.violations.length === 0,
        { exited: tde.exited, code: tde.code, readyToCloseMs: tdeMs, state: tj && identityState(tj.pid, tj.startTime), dir: tj && !!lstatOrNull(tj.dataDir), out: tde.stdout.slice(0, 400), err: tde.stderr.slice(-300) });
    console.log(`NOTE F.17b/c 实测（单调时钟，只记录不断言）：自然结束 ready→退出 ${natMs === null ? 'n/a' : Math.round(natMs)}ms；teardown 后自然结束 ${tdeMs === null ? 'n/a' : Math.round(tdeMs)}ms`);
    // 接缝不得改变生产默认值：不注入时，被测 test-env 实际使用的那份启动器里，终止等待截止仍是 8000（接缝当前值与默认常量都是）
    const wd = await runHelper('waitdefault', {}, { timeoutMs: 30000 });
    check('F.17d', '启动器终止等待截止的测试接缝不改变生产默认值：不注入时接缝当前值与默认常量都是 8000（辅助进程里从被测 test-env 引用的启动器上读出）',
        !!wd.json && wd.json.seam === 8000 && wd.json.dflt === 8000 && wd.code === 0 && wd.violations.length === 0, { json: wd.json, code: wd.code, err: wd.stderr.slice(-200) });

    // 退出码兜底（S3b 修复批 2a，用户裁定 U4 = A）：辅助进程走真实注册的监听器（beforeExit / exit），五种收尾 × 三种形态，断言退出码与 stderr 原因行。
    //   五种：自然结束未 teardown → 70 + 原因行；显式 process.exit(0) → 0；卡在永不落定的 promise → 70（到不了后面的行）；teardown 后自然结束 → 0；已设 process.exitCode = 1 → 1（保持原值）。
    //   三种形态：self（全部缺省自起，套件的桩服务）/ group（TEST_* 变量组指向套件的桩服务与合成实例库）/ live（TEST_TARGET=live + TEST_LIVE_URL）。
    //   自起形态另核对：服务按身份消失、数据根已删（清理监听器没被兜底监听器跳过）。
    stubReset();
    const formEnv = {
        self: {},
        group: Object.assign(goodVars(), { HELPER_WBS: SYN }),
        live: { TEST_TARGET: 'live', TEST_LIVE_URL: stubUrl(), HELPER_WBS: SYN },
    };
    const SENT_SITS = [['natural', 70, true], ['exit0', 0, false], ['stuck', 70, true], ['preTdStuck', 70, true], ['teardown', 0, false], ['exitcode1', 1, false]];
    const sentSeq = { self: 'F.20', group: 'F.21', live: 'F.22' };
    for (const form of ['self', 'group', 'live']) {
        const rows = [];
        for (const [sit, wantCode, wantReason] of SENT_SITS) {
            const h = await runHelper('sent', formEnv[form], { args: [sit, form], timeoutMs: 60000 });
            const hasReason = /退出码兜底/.test(h.stderr);
            const ok = h.exited && !h.killedByTimeout && h.code === wantCode && hasReason === wantReason && !h.lines.some((x) => x && (x.reached || x.unknownSituation))
                && h.lines.some((x) => x && x.ready === true && x.form === form && x.live === (form === 'live') && x.selfStarted === (form === 'self')) && h.violations.length === 0
                && (form !== 'self' || (!!h.info && gone(h.info.pid, h.info.startTime) && lstatOrNull(h.info.dataDir) === null));
            rows.push({ sit, ok, code: h.code, wantCode, hasReason, wantReason, exited: h.exited, killed: h.killedByTimeout, lines: h.lines.length, out: ok ? undefined : h.stdout.slice(0, 300), err: ok ? undefined : h.stderr.slice(-200) });
        }
        check(sentSeq[form], `退出码兜底 · ${form === 'self' ? '自起' : form === 'group' ? '变量组' : 'live'} 形态（真实注册的监听器）：自然结束未 teardown → 70 + 原因行；process.exit(0) → 0；卡在永不落定的 promise → 70（不执行其后的行）；teardown 后自然结束 → 0；已设 exitCode = 1 → 1；${form === 'self' ? '服务按身份消失、数据根已删；' : ''}原因行只在 70 的两例出现`,
            rows.every((r) => r.ok), rows.filter((r) => !r.ok));
    }
    // 兜底不误报：另一个 beforeExit 监听器把事件循环重新拉起，随后显式 process.exit(0) → 0；重新拉起后自然结束 → 70
    const rs0 = await runHelper('sent', formEnv.group, { args: ['resched0', 'group'], timeoutMs: 60000 });
    const rsN = await runHelper('sent', formEnv.group, { args: ['reschedNat', 'group'], timeoutMs: 60000 });
    check('F.23', '兜底不误报：另一个 beforeExit 监听器把事件循环重新拉起（定时器）后显式 process.exit(0) → 退出码 0、无原因行；重新拉起后自然结束 → 70 + 原因行',
        rs0.exited && rs0.code === 0 && !/退出码兜底/.test(rs0.stderr) && rsN.exited && rsN.code === 70 && /退出码兜底/.test(rsN.stderr) && rs0.violations.length === 0 && rsN.violations.length === 0,
        { rs0: { code: rs0.code, err: rs0.stderr.slice(-200) }, rsN: { code: rsN.code, err: rsN.stderr.slice(-200) } });

    // 收口小批（13-R2 M / 预筛 LOW-1）：兜底靠「是否显式调用过 process.exit」判定（装兜底时包一层 process.exit 记标记），不靠 beforeExit 与 immediate 的时序。
    //   别家的 beforeExit 监听器注册在 ready() 之前（bef*）/ 之后（aft*），用同步 / nextTick / 微任务 / setImmediate / setTimeout(0) 调 process.exit(0) → 全部 0、无原因行；
    //   无参 process.exit()（之前没设过 exitCode）→ 0；之前设了 exitCode = 3 再无参 process.exit() → 沿用 3。老实现（immediate 复位）对 befImm 与 aftSync / aftTick / aftMicro 都会误报 70（预筛探针实测）。
    const sentWhen = ['Sync', 'Tick', 'Micro', 'Imm', 'T0'];
    const sentExitSits = [].concat(...['bef', 'aft'].map((side) => sentWhen.map((w) => `${side}${w}`)));
    const sentRow = (h, form, sit, wantCode) => ({
        sit, code: h.code, wantCode, hasReason: /退出码兜底/.test(h.stderr), exited: h.exited, killed: h.killedByTimeout,
        ok: h.exited && !h.killedByTimeout && h.code === wantCode && !/退出码兜底/.test(h.stderr) && !h.lines.some((x) => x && (x.reached || x.unknownSituation))
            && h.lines.some((x) => x && x.ready === true && x.form === form) && h.violations.length === 0 && (form !== 'self' || (!!h.info && gone(h.info.pid, h.info.startTime) && lstatOrNull(h.info.dataDir) === null)),
        err: h.stderr.slice(-160),
    });
    const sentBatch = async (form, specs) => {
        const rows = [];
        for (let i = 0; i < specs.length; i += 4) {
            const part = specs.slice(i, i + 4);
            const hs = await Promise.all(part.map(([sit]) => runHelper('sent', formEnv[form], { args: [sit, form], timeoutMs: 60000 })));
            hs.forEach((h, j) => rows.push(sentRow(h, form, part[j][0], part[j][1])));
        }
        return rows;
    };
    const grpRows = await sentBatch('group', [...sentExitSits.map((s) => [s, 0]), ['exitNoArg', 0], ['exitNoArg3', 3]]);
    check('F.23b', `兜底按「显式调用过 process.exit」判定 · 变量组形态：别家 beforeExit 监听器注册在 ready() 之前 / 之后 × 同步·nextTick·微任务·setImmediate·setTimeout(0) 调 exit(0)（${sentExitSits.length} 例）→ 全部退出码 0 且无原因行；无参 process.exit()（未设 exitCode）→ 0；exitCode = 3 后无参 process.exit() → 3`,
        grpRows.length === sentExitSits.length + 2 && grpRows.every((r) => r.ok), grpRows.filter((r) => !r.ok));
    const selfRows = await sentBatch('self', [['befImm', 0], ['aftSync', 0], ['aftTick', 0], ['exitNoArg', 0]]);
    check('F.23c', '兜底按「显式调用过 process.exit」判定 · 自起形态：ready 前注册 + setImmediate、ready 后注册 + 同步 / nextTick、无参 process.exit() → 退出码 0 且无原因行；服务按身份消失、数据根已删（清理监听器仍先于兜底跑）',
        selfRows.length === 4 && selfRows.every((r) => r.ok), selfRows.filter((r) => !r.ok));
    const liveRows = await sentBatch('live', [['befImm', 0], ['aftMicro', 0], ['exitNoArg', 0]]);
    check('F.23d', '兜底按「显式调用过 process.exit」判定 · live 形态：ready 前注册 + setImmediate、ready 后注册 + 微任务、无参 process.exit() → 退出码 0 且无原因行',
        liveRows.length === 3 && liveRows.every((r) => r.ok), liveRows.filter((r) => !r.ok));

    // 真实注册的信号监听器（S3b 修复批 1，codex 13T M6）：辅助进程 ready() 后 process.emit('SIGINT' / 'SIGTERM')，经 installHooks 注册的监听器 → shutdownOnSignal → 先 teardown 再以 130 / 143 退出
    for (const [mode, sig, want143] of [['sigint', 'SIGINT', 130], ['sigterm', 'SIGTERM', 143]]) {
        const hs = await runHelper(mode, {}, { timeoutMs: 60000 });
        const sj = hs.info;
        check(`F.${mode === 'sigint' ? '18' : '19'}`, `真实注册的 ${sig} 监听器：辅助进程 ready() 后经 process.emit('${sig}') 触发，先 teardown（服务身份消失、数据根删除）再以 ${want143} 退出（没装监听器时 emit 返回 false → 辅助进程以 97 退出，这里判红）`,
            !!sj && hs.exited && !hs.killedByTimeout && hs.code === want143 && !hs.lines.some((x) => x && x.noListener) && gone(sj.pid, sj.startTime) && lstatOrNull(sj.dataDir) === null && hs.violations.length === 0,
            { code: hs.code, exited: hs.exited, lines: hs.lines.map((x) => Object.keys(x)), state: sj && identityState(sj.pid, sj.startTime), dir: sj && !!lstatOrNull(sj.dataDir), err: hs.stderr.slice(-300) });
    }

    // SIGINT / SIGTERM 处理函数（函数级）：先 teardown 再以 130 / 143 退出
    te._internals.resetForTest();
    const e4 = regEnv('F-sig', await te.ready(SELF()));
    const pid4 = e4._handle.pid; const start4 = e4._handle.startTime; const dir4 = e4.dataDir;
    let exitCode = null;
    await te._internals.shutdownOnSignal('SIGINT', (c) => { exitCode = c; });
    check('F.11', '收到 SIGINT（函数级直接调用 shutdownOnSignal）：先 teardown（服务进程消失、数据根删除）再以 130 退出；SIGTERM 为 143', exitCode === 130 && gone(pid4, start4) && lstatOrNull(dir4) === null, { exitCode, state: identityState(pid4, start4) });
    let code2 = null;
    te._internals.resetForTest();
    await te._internals.shutdownOnSignal('SIGTERM', (c) => { code2 = c; });
    check('F.12', '没有实例时收到 SIGTERM 也正常退出 143（不抛、不挂）', code2 === 143);

    // 启动失败
    te._internals.resetForTest();
    const dirsB2 = tmpInstanceDirs();
    const bad = () => ({ sourceDbPath: path.join(PRIV, '不存在 目录', 'nope.db'), sourceEncryptionKey: null, serverJs: STUB_JS });
    const pf1 = te.ready(bad());
    let ef1 = null; try { await pf1; } catch (e) { ef1 = e; }
    const pf2 = te.ready(bad());   // 同样的 options：得到同一个拒绝，不重试、不回落
    let ef2 = null; try { await pf2; } catch (e) { ef2 = e; }
    let ef3 = null; try { await te.ready(SELF()); } catch (e) { ef3 = e; }   // 换了 options：选项冲突，不是重试
    let envErr = null; try { te.env(); } catch (e) { envErr = e; }
    check('F.13', '自起失败（来源库不存在）→ 拒绝并带启动器错误码；再次 ready()（相同 options）得到同一个拒绝，不重试、不回落；换了 options 得到 TE_OPTIONS_CONFLICT（不是悄悄重试）；env() 抛 TE_NOT_READY；没有遗留实例目录',
        errCode(ef1) === 'TI_SOURCE_MISSING' && pf1 === pf2 && ef2 === ef1 && errCode(ef3) === 'TE_OPTIONS_CONFLICT' && errCode(envErr) === 'TE_NOT_READY' && te.isReady() === false && tmpInstanceDirs().length === dirsB2.length, { c1: errCode(ef1), same: pf1 === pf2, c3: errCode(ef3), envErr: errCode(envErr), dirs: tmpInstanceDirs() });

    // 选项透传 + ready 进行中 teardown
    te._internals.resetForTest();
    const pu = te.ready(Object.assign(SELF(), { modules: ['no_such_module'] }));
    let eu = null; try { await pu; } catch (e) { eu = e; }
    check('F.14', 'options 原样透传给启动器：请求等待一个桩服务里不存在的模块 → TI_UNKNOWN_MODULE', errCode(eu) === 'TI_UNKNOWN_MODULE', eu && eu.message);
    te._internals.resetForTest();
    const dirsB3 = tmpInstanceDirs();
    const regB3 = REG.length;
    const pr = te.ready(SELF());
    const td = te.teardown();      // ready 还没落定就 teardown：等 ready 落定再收
    await Promise.all([pr.then((e) => regEnv('F-15', e), () => {}), td]);
    const newRegs = REG.slice(regB3);
    const regRecsB3 = REAPER.collect().entries.map((e) => e.rec).filter((r) => r.kind === 'instance');
    check('F.15', 'ready() 进行中调用 teardown()：等就绪落定后再收，不留下实例——新起的每个服务（经共享回收模块登记，登记文件里有它：PID / 创建时间 / 数据根一致）按 PID + 创建时间都已消失，数据根都已删，目录数不变',
        tmpInstanceDirs().length === dirsB3.length && newRegs.length >= 1 && newRegs.every((r) => r.start && gone(r.pid, r.start) && (!r.dataDir || lstatOrNull(r.dataDir) === null) && regRecsB3.some((g) => g.pid === r.pid && g.startTime === r.start && g.dataDir === r.dataDir)),
        { dirs: tmpInstanceDirs(), regs: newRegs.map((r) => ({ pid: r.pid, state: r.start ? identityState(r.pid, r.start) : 'no-start', dir: r.dataDir && !!lstatOrNull(r.dataDir), inRegistry: regRecsB3.some((g) => g.pid === r.pid && g.startTime === r.start && g.dataDir === r.dataDir) })) });
    te._internals.resetForTest();

    // 辅助进程里的实现误丢来源选项：守卫（--require 装在加载被测模块之前）必须在读取真实来源之前拦下，违规传回套件。
    //   这条用例的「违规」是预期的（不计入 Z.1 / Z.2）：期望看到守卫记录，且辅助进程没有起任何实例。
    const dropped = await runHelper('dropsource', {}, { expectViolations: true, timeoutMs: 60000 });
    check('F.16', '反例：辅助进程里的实现误丢来源选项（ready({})）→ 走到启动器的默认来源，在读取真实 .env / 打开真实库之前被辅助进程的守卫拦下（违规传回套件）；辅助进程失败退出、没有起任何实例',
        dropped.exited && dropped.code !== 0 && dropped.violations.length >= 1 && dropped.violations.every((v) => v.kind === 'env' || v.kind === 'db') && !dropped.info && tmpInstanceDirs().length === dirsB3.length && !!dropped.json && !!dropped.json.error,
        { code: dropped.code, violations: dropped.violations, json: dropped.json, err: dropped.stderr.slice(-300) });

    // 13T-R H1：辅助进程在启动器交出句柄之后、ready() 返回之前永久等待（持有活动句柄）→ 父进程杀掉辅助进程 → 服务必须按身份消失、数据根必须删除。
    //   hang 模式：辅助进程里的包装在预加载片段的登记包装外面，句柄一返回就发 hanging 信号（带服务身份，只供核对，不是登记来源）然后挂起；父进程看到信号就按句柄杀掉辅助进程
    //   （Windows 上是 TerminateProcess：辅助进程的 JS 退出钩子不会跑，不能指望它自己回收服务）。辅助进程从没打印过 ready 之后的 info 行，所以靠「打印 info 再登记」一定漏。
    //   两种形态：F.24 = 原样启动器（服务是辅助进程的非 detached 子进程：libuv 的 KILL_ON_JOB_CLOSE 作业对象让服务随辅助进程一起没，留下的是数据根——没有登记就删不掉）；
    //   F.25 = DETACH_JS 补丁让服务 detached（服务脱离作业对象，辅助进程死后服务仍活着，才是真正的孤儿服务）。两种都要求：登记在辅助进程被杀之前就写好、父进程按登记回收到服务消失且数据根删除。
    //   回收只针对这个辅助进程名下的登记（reapAll 的 skip 把其余条目排除，不处理也不计数）；善后（核对之后）：登记不上时按 hanging 信号里的精确身份杀掉服务、删数据根，不留孤儿。
    for (const [sec, detach] of [['F.24', false], ['F.25', true]]) {
        const dirsH = tmpInstanceDirs();
        const hang = await runHelper('hang', {}, { killOnLine: '"hanging":true', timeoutMs: 90000, preRequire: detach ? [DETACH_JS] : [] });
        const hl = hang.lines.find((x) => x && x.hanging === true) || null;
        const hangRecs = REAPER.collect().entries.map((e) => e.rec).filter((r) => r.owner === hang.owner && r.kind === 'instance');
        const hangReg = hl ? hangRecs.find((r) => r.pid === hl.pid && r.startTime === hl.startTime && r.dataDir === hl.dataDir) || null : null;
        const aliveBefore = !!hl && identityState(hl.pid, hl.startTime) === 'match';
        const rootBefore = !!hl && lstatOrNull(hl.dataDir) !== null;
        const rpH = await REAPER.reapAll({ deadlineMs: 60000, skip: (e) => e.rec.owner !== hang.owner });
        const rootsLeftH = removeRoots(rpH.gone);
        const goneH = !!hl && gone(hl.pid, hl.startTime);
        const itemH = hl ? rpH.gone.find((g) => g.kind === 'instance' && g.pid === hl.pid && g.startTime === hl.startTime) || null : null;
        const dirsAfterH = tmpInstanceDirs();
        check(sec, `反例前提（${detach ? '服务 detached：辅助进程死后服务仍在运行' : '原样启动器：服务随辅助进程的作业对象一起没，数据根留在盘上'}）：辅助进程在启动器交出句柄后永久等待——被父进程按句柄杀掉（killOnLine，没有打印过 ready 之后的 info 行），数据根在盘上${detach ? '，服务当时仍在运行（身份 match；这个前提不成立则下面两条是空话）' : ''}；辅助进程守卫无违规`,
            !!hl && hang.killedOnLine && hang.exited && !hang.lines.some((x) => x && (x.baseUrl || x.ready || x.selfStarted !== undefined)) && rootBefore && (!detach || aliveBefore) && hang.violations.length === 0,
            { hanging: hl, killedOnLine: hang.killedOnLine, exited: hang.exited, code: hang.code, signal: hang.signal, aliveBefore, rootBefore, lines: hang.lines.map((x) => Object.keys(x)), err: hang.stderr.slice(-300), violations: hang.violations });
        check(`${sec}b`, '辅助进程被杀之前服务就已登记：登记文件里有归属为这个辅助进程的 kind=instance 记录，PID / 精确创建时间 / 数据根与 hanging 信号里的一致（登记点是预加载片段包住启动器，不是辅助进程打印的行）',
            !!hangReg, { hanging: hl, owner: hang.owner, recs: hangRecs });
        check(`${sec}c`, `父进程按登记回收：这个实例有退出证据（gone）${detach ? '，且是「回收时仍活着、被回收器按身份终止」（forced）' : ''}、没有 left、没有超截止、登记文件无问题；服务按身份消失（dead / reused）、数据根已删（回收后目录数回到起点）、辅助进程自己也已有退出证据`,
            !!itemH && (!detach || rpH.forced.some((f) => !!hl && f.pid === hl.pid)) && rpH.left.length === 0 && !rpH.timedOut && rpH.problems.length === 0 && goneH && rootsLeftH.length === 0 && !!hl && lstatOrNull(hl.dataDir) === null && dirsAfterH.length === dirsH.length
            && rpH.gone.some((g) => g.kind === 'proc' && g.owner === hang.owner),
            { itemH, forced: rpH.forced.map((f) => `${f.label}#${f.pid}`), left: rpH.left, timedOut: rpH.timedOut, problems: rpH.problems, goneH, rootsLeftH, dirsBefore: dirsH, dirsAfter: dirsAfterH, gone: rpH.gone.map((g) => `${g.kind}:${g.label}#${g.pid}`) });
        if (hl) {   // 善后（被测机制失效时不留孤儿）：按 hanging 信号里的精确身份终止、确认消失后删数据根
            if (!goneH) {
                try { procLib.killIfIdentity({ pid: hl.pid, start_time: hl.startTime }); } catch (_) { /* 最外层回收与终检会再报 */ }
                await sleep(500);
            }
            if (hl.dataDir && lstatOrNull(hl.dataDir) !== null && gone(hl.pid, hl.startTime)) { try { ti._internals.removeDataRoot(hl.dataDir); } catch (_) { /* Z.4 会报 */ } }
        }
    }
}

// ================================================================ 节 G：_test-fixture.js 基于 test-env
async function sectionG() {
    console.log('\n== 节 G：_test-fixture.js ==');
    stubReset();
    te._internals.resetForTest();
    delete require.cache[require.resolve(FX_PATH)];
    const fx = require(FX_PATH);
    const hitsBefore = STUB.hits;
    const probes = {};
    for (const k of ['BASE', 'DB_PATH', 'JWT_SECRET']) { try { void fx[k]; probes[k] = null; } catch (e) { probes[k] = e; } }
    check('G.1', 'ready() 完成之前读取 fx.BASE / fx.DB_PATH / fx.JWT_SECRET 立即抛 FX_NOT_READY，文案指明「先 await fx.ready()」，没有任何网络请求', ['BASE', 'DB_PATH', 'JWT_SECRET'].every((k) => probes[k] && probes[k].code === 'FX_NOT_READY' && /先 await fx\.ready\(\)/.test(probes[k].message)) && STUB.hits === hitsBefore, Object.fromEntries(Object.entries(probes).map(([k, e]) => [k, e && e.message])));
    let assignErr = null; try { fx.BASE = 'http://localhost:3000'; } catch (e) { assignErr = e; }
    let assignErr2 = null; try { fx.DB_PATH = 'x'; } catch (e) { assignErr2 = e; }
    check('G.2', '给 fx.BASE / fx.DB_PATH 赋值抛错（旧脚本运行期改写 BASE 会立即失败而不是静默无效）', !!assignErr && !!assignErr2 && /只读/.test(assignErr.message), assignErr && assignErr.message);

    // G.3 异步助手不隐式 ready（预筛 HIGH-1）：ready() 之前调用每个异步助手都抛 FX_NOT_READY；没有实例被启动（私有根无新数据根、没有新进程）、没有网络请求、没有开任何库。
    //   隐式 ready 会走到 deps.startTestInstance（桩：记数并抛错）——所以变异（任一助手恢复隐式 ready）会让 started > 0 且错误码不再是 FX_NOT_READY。
    let startedG3 = 0;
    te._internals.resetForTest({ env: {}, wbsDir: SYN, startTestInstance: async () => { startedG3 += 1; throw new Error('隐式 ready 不应该起实例'); } });
    const dirsG3 = tmpInstanceDirs(); const openedG3 = OPENED.length; const hitsG3 = STUB.hits; const regG3 = REG.length;
    const helperCalls = [
        ['signAs', () => fx.signAs(1)],
        ['apiCall', () => fx.apiCall('GET', '/x', 'tok')],
        ['createPendingFixture', () => fx.createPendingFixture()],
        ['setCollabState', () => fx.setCollabState(1, { status: 'DONE' })],
        ['cleanup', () => fx.cleanup(1)],
    ];
    const g3bad = [];
    for (const [name, call] of helperCalls) {
        let err = null;
        try { await call(); } catch (e) { err = e; }
        if (!err || err.code !== 'FX_NOT_READY' || !/先 await fx\.ready\(\)/.test(err.message)) g3bad.push({ name, code: err && err.code, msg: err && String(err.message).slice(0, 120) });
    }
    check('G.3', `异步助手不隐式 ready：ready() 之前调用 ${helperCalls.map((c) => c[0]).join(' / ')} 都抛 FX_NOT_READY（「先 await fx.ready()」），没有实例被启动（启动器桩 0 次调用、私有根无新数据根、没有新进程）、没有网络请求、没有开任何库、test-env 仍未就绪`,
        g3bad.length === 0 && startedG3 === 0 && tmpInstanceDirs().length === dirsG3.length && REG.length === regG3 && STUB.hits === hitsG3 && OPENED.length === openedG3 && te.isReady() === false, { g3bad, startedG3, dirs: tmpInstanceDirs(), opened: OPENED.length - openedG3, hits: STUB.hits - hitsG3 });
    te._internals.resetForTest();

    const p = fx.ready(SELF());
    check('G.4', 'fx.ready() 转调 test-env.ready()：同一个 Promise（幂等）', p === te.ready(SELF()));
    const E = regEnv('G', await p);
    check('G.5', 'ready() 之后 fx.BASE / fx.DB_PATH / fx.JWT_SECRET 取 test-env 的值', fx.BASE === E.baseUrl && fx.DB_PATH === E.dbPath && fx.JWT_SECRET === E.jwtSecret && fx.BASE !== 'http://localhost:3000');
    const tok = await fx.signAs(fx.ADMIN_ID);
    let claims = null; try { claims = jwt.verify(tok, E.jwtSecret); } catch (_) { claims = null; }
    check('G.6', 'fx.signAs：用实例密钥签 token（实例库 users 行）', claims && claims.id === 1 && claims.role === 'admin', claims);
    let echo = null; let echoErr = null;
    try { echo = await fx.apiCall('GET', '/echo/路径', tok); } catch (e) { echoErr = e; }
    check('G.7', 'fx.apiCall 打的是 test-env 的服务（桩回显的 instance 等于自起实例身份，路径与 Authorization 原样），不是 3000', !echoErr && echo.status === 200 && echo.body && echo.body.instance === E.instance && echo.body.path === encodeURI('/echo/路径') && echo.body.auth === `Bearer ${tok}`, echoErr ? String(echoErr.message) : echo);
    let writeErr = null;
    const openedG8 = OPENED.length;
    try { await fx.cleanup(1); await fx.setCollabState(2, { status: 'DONE', friction_note: '备注' }); } catch (e) { writeErr = e; }
    const fxOpens = openedSince(openedG8);   // 夹具写库的打开记录（读取校验在这之后才开始）
    let inst = null; let src = null;
    try {
        inst = await withDb(E.dbPath, sqlite3.OPEN_READONLY, (d) => dbAll(d, 'SELECT id, status, friction_note FROM collab_requests ORDER BY id'));
        src = await withDb(SRC, sqlite3.OPEN_READONLY, (d) => dbAll(d, 'SELECT id, status, friction_note FROM collab_requests ORDER BY id'));
    } catch (e) { writeErr = writeErr || e; }
    check('G.8', 'fx.cleanup / fx.setCollabState 只写 test-env 给出的实例库：实例库里行 1 被删、行 2 被更新；来源库内容与字节都没变', !writeErr && J(inst) === J([{ id: 2, status: 'DONE', friction_note: '备注' }]) && J(src) === J([{ id: 1, status: 'PENDING', friction_note: null }, { id: 2, status: 'PENDING', friction_note: null }]) && sha256(fs.readFileSync(SRC)) === SRC_SHA, writeErr ? String(writeErr.message) : { inst, src });
    check('G.9', '用户 id 常量不变（ADMIN 1 / CONTACT 3 / DEV1 19 / PUBLISHER 7 / EXPORTER 8 / VIEWER 2 / VIEWER2 4 / TARGET_DB_CONN 2）', [fx.ADMIN_ID, fx.CONTACT_ID, fx.DEV1_ID, fx.PUBLISHER_ID, fx.EXPORTER_ID, fx.VIEWER_ID, fx.VIEWER2_ID, fx.TARGET_DB_CONN_ID].join() === '1,3,19,7,8,2,4,2');
    const e8dbPath = E.dbPath;
    await fx.teardown();
    te._internals.resetForTest();

    // 夹具开库不带 OPEN_CREATE（预筛 LOW-6）：① 直接观测打开标志——上面 G.8 里 cleanup / setCollabState 各打开一次实例库，标志含 OPEN_READWRITE、不含 OPEN_CREATE、不含 OPEN_READONLY；
    //   ② 行为证明——实例库路径不存在时写库助手失败，并且没有悄悄建出空库（带 OPEN_CREATE 的实现会建出一个空文件）。
    const missingFx = path.join(INST_DIR, 'fx-missing.db');
    te._internals.resetForTest({ env: {}, wbsDir: SYN, startTestInstance: async () => ({ baseUrl: 'http://127.0.0.1:41235', dbPath: missingFx, instance: 'test-fxmiss1', jwtSecret: 's', dataDir: PRIV, logFile: null, startupRaceRetries: 0, stop: async () => {} }) });
    await fx.ready();
    let missCleanErr = null; let missSetErr = null;
    try { await fx.cleanup(1); } catch (e) { missCleanErr = e; }
    try { await fx.setCollabState(1, { status: 'DONE' }); } catch (e) { missSetErr = e; }
    check('G.8b', '夹具开库不带 OPEN_CREATE：cleanup / setCollabState 打开实例库的标志含 OPEN_READWRITE、不含 OPEN_CREATE / OPEN_READONLY（恰好 2 次打开）；实例库不存在时两个助手都失败，且没有悄悄建出空库',
        fxOpens.length === 2 && fxOpens.every((o) => fold(o.path) === fold(e8dbPath) && typeof o.flags === 'number' && (o.flags & sqlite3.OPEN_READWRITE) !== 0 && (o.flags & sqlite3.OPEN_CREATE) === 0 && (o.flags & sqlite3.OPEN_READONLY) === 0)
        && !!missCleanErr && !!missSetErr && lstatOrNull(missingFx) === null,
        { fxOpens, cleanErr: missCleanErr && missCleanErr.message, setErr: missSetErr && missSetErr.message, created: lstatOrNull(missingFx) !== null });
    te._internals.resetForTest();

    // live：fixture 的库助手必须失败且不写任何库
    te._internals.resetForTest({ env: { TEST_TARGET: 'live', TEST_LIVE_URL: stubUrl() }, wbsDir: SYN });
    await fx.ready();
    let dbErr = null; try { void fx.DB_PATH; } catch (e) { dbErr = e; }
    let cleanErr = null; try { await fx.cleanup(1); } catch (e) { cleanErr = e; }
    let signErr = null; try { await fx.signAs(1); } catch (e) { signErr = e; }
    check('G.10', 'live 形态下：fx.BASE 可读；fx.DB_PATH 抛 TE_LIVE_NO_DB；fx.cleanup / fx.signAs 失败（TE_LIVE_NO_DB / TE_LIVE_NO_TOKEN），不写任何库', fx.BASE === stubUrl() && errCode(dbErr) === 'TE_LIVE_NO_DB' && errCode(cleanErr) === 'TE_LIVE_NO_DB' && errCode(signErr) === 'TE_LIVE_NO_TOKEN', { db: errCode(dbErr), clean: errCode(cleanErr), sign: errCode(signErr) });
    te._internals.resetForTest();
}

// ================================================================ 节 H：静态守卫
/** S3b 的 9 个代表脚本里**已迁移的 8 个**（verify-model-list-extras.js 只评估未改，不在此列）：本节用例以它们的真实源码为样本。S4a 起，全目录的迁移登记表是 lib/test-isolation-registry.js 的 MIGRATED（H.1b 核对这 8 个都在其中）；S4 批量迁移往登记表追加，不往这里加 */
const S3B_REPRESENTATIVES = [
    'verify-issue-lite-archive-keeps-completion.js', 'verify-collab-attach-archive.js', 'test-codex-perm-e2e.js',
    'test-requester-done-creator-visibility-playwright.js', 'test-sys-config-hide-playwright.js', 'verify-correction-creator-e2e.js',
    'verify-issue-lite-d4.js', 'verify-dingtalk-file-helper.js',
];
// 登记表（含「豁免必须调用 ready()」的 EXEMPT_NO_READY：原在本套件，S4a 起搬到登记表模块，这里引用）与静态分析器（原在本套件 1337–1866 行，S4a 起搬到共享模块）
const { MIGRATED: REGISTRY_MIGRATED, EXEMPT_NO_READY } = require('./lib/test-isolation-registry');
const { analyzeScript, analyzeClosers, parseSource, walk } = require('./lib/test-script-guard');

/**
 * public 下 html / js 里**生成** `data-collab-id=` 属性的出现处（相对路径:行号）——C1 选择器唯一性的静态依据。
 * 属性生成点 = `data-collab-id=` 前面是空白（标签里的属性）；`[data-collab-id=` 是 CSS 属性选择器（只读取，不生成），不计。
 */
function collabIdOccurrences() {
    const out = [];
    const walkDir = (dir, depth) => {
        if (depth > 6) return;
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) { if (ent.name !== 'node_modules') walkDir(full, depth + 1); continue; }
            if (!/\.(?:html|js|mjs)$/i.test(ent.name)) continue;
            const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
            lines.forEach((l, i) => { if (/\sdata-collab-id\s*=/.test(l)) out.push(`${path.relative(path.join(WBS, 'public'), full).split(path.sep).join('/')}:${i + 1}`); });
        }
    };
    walkDir(path.join(WBS, 'public'), 0);
    return out;
}

// ---- 代表脚本里两处行为修复的单元级证明（不实跑脚本：从源码里按 AST 抽出函数在套件里求值）
function extractFn(src, name) {
    const { ast } = parseSource(src);
    let found = null;
    walk(ast, [], (n) => { if (n.type === 'FunctionDeclaration' && n.id && n.id.name === name) found = n; });
    return found ? src.slice(found.start, found.end) : null;
}
const evalFn = (text, name, ...argNames) => new Function(...argNames, `${text}\nreturn ${name};`);

/** test-codex-perm-e2e.js 的 SKIP 闸门（13-R M）：纯函数 classifyCollabList 表驱动 + 调用处结构（FAIL → finish(1)、SKIP → finish(0) + SKIP 日志，SKIP 日志只出现一次）。返回问题列表（空 = 通过） */
function checkPermGate(src) {
    const problems = [];
    const text = extractFn(src, 'classifyCollabList');
    if (!text) return ['缺少纯函数 classifyCollabList'];
    let fn;
    try { fn = evalFn(text, 'classifyCollabList')(); } catch (e) { return [`classifyCollabList 无法求值：${e.message}`]; }
    const table = [
        [{ status: 200, body: [] }, 'SKIP'], [{ status: 200, body: [{ id: 1 }] }, 'OK'],
        [{ status: 200, body: null }, 'FAIL'], [{ status: 200, body: {} }, 'FAIL'], [{ status: 200, body: 'x' }, 'FAIL'], [{ status: 200, body: { length: 0 } }, 'FAIL'], [{ status: 200 }, 'FAIL'],
        [{ status: 401, body: [] }, 'FAIL'], [{ status: 403, body: [{ id: 1 }] }, 'FAIL'], [{ status: 500, body: { error: 'x' } }, 'FAIL'], [{ status: 0, body: null }, 'FAIL'], [null, 'FAIL'], [undefined, 'FAIL'],
    ];
    for (const [res, want] of table) {
        let got;
        try { got = fn(res); } catch (e) { got = 'THROW'; }
        if (got !== want) problems.push(`classifyCollabList(${J(res)}) = ${J(got)}，期望 ${J(want)}`);
    }
    const compact = (s) => s.replace(/\s+/g, '');
    const { ast } = parseSource(src);
    const ifs = [];
    walk(ast, [], (n) => { if (n.type === 'IfStatement') ifs.push(n); });
    const testText = (n) => compact(src.slice(n.test.start, n.test.end));
    const hasFinish = (node, arg) => { let ok = false; walk(node, [], (n) => { if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'finish' && n.arguments.length === 1 && n.arguments[0].type === 'Literal' && n.arguments[0].value === arg) ok = true; }); return ok; };
    const hasSkipLog = (node) => { let ok = false; walk(node, [], (n) => { if (n.type === 'Literal' && typeof n.value === 'string' && n.value.startsWith('SKIP: 当前无协作单')) ok = true; }); return ok; };
    if (!/constallRes=awaitapiCall\('GET','\/api\/collab\/requests\?my_role=admin',adminTok\)/.test(compact(src))) problems.push('没有 `const allRes = await apiCall(GET …my_role=admin …)`');
    if (!/constgate=classifyCollabList\(allRes\)/.test(compact(src))) problems.push('调用处没有 `const gate = classifyCollabList(allRes)`');
    const failIf = ifs.find((i) => testText(i) === "gate==='FAIL'");
    const skipIf = ifs.find((i) => testText(i) === "gate==='SKIP'");
    if (!failIf || !hasFinish(failIf.consequent, 1)) problems.push("没有 `if (gate === 'FAIL')` 分支或它不以 finish(1) 收尾");
    if (!skipIf || !hasFinish(skipIf.consequent, 0) || !hasSkipLog(skipIf.consequent)) problems.push("没有 `if (gate === 'SKIP')` 分支，或它不以 finish(0) 收尾 / 没有 SKIP 日志");
    let skipLogs = 0;
    walk(ast, [], (n) => { if (n.type === 'Literal' && typeof n.value === 'string' && n.value.startsWith('SKIP: 当前无协作单')) skipLogs += 1; });
    if (skipLogs !== 1) problems.push(`「SKIP: 当前无协作单」日志出现 ${skipLogs} 次（应恰 1 次，且在 SKIP 分支里）`);
    return problems;
}

/** verify-correction-creator-e2e.js 的请求封装（13-R M）：结构（http.request(new URL(…), { method, headers }, cb)，不再拿 u.hostname 当 host）+ 行为（真实服务上的 IPv4 与 IPv6 回环） */
const LEGACY_REQ = `function req(token, method, p, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(testEnv.env().baseUrl);
    const r = http.request({ host: u.hostname, port: u.port, method, path: p,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    r.on('error', e => resolve({ status: 0, error: e.message }));
    if (data) r.write(data); r.end();
  });
}`;
async function withEchoServer(host, fn) {
    const server = http.createServer((req, res) => {
        let b = '';
        req.on('data', (c) => { b += c; });
        req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ method: req.method, path: req.url, auth: req.headers.authorization || null, body: b })); });
    });
    let listenErr = null;
    try { await listenOnSafePort(server, host); } catch (e) { listenErr = e; }   // 工程规则：不 listen(0)，走 listenOnSafePort（20000–49999 随机端口）
    if (listenErr) { try { server.close(); } catch (_) { /* 未监听 */ } return { unavailable: listenErr.code || listenErr.message }; }
    try { return { value: await fn(server.address().port) }; } finally {
        try { server.closeAllConnections(); } catch (_) { /* 尽力 */ }
        await Promise.race([new Promise((r) => server.close(() => r())), sleep(3000)]);
    }
}
async function reqBehavior(reqText) {
    const out = { ipv4: null, ipv6: null, ipv6Unavailable: null };
    for (const [key, host, mk] of [['ipv4', '127.0.0.1', (p) => `http://127.0.0.1:${p}`], ['ipv6', '::1', (p) => `http://[::1]:${p}`]]) {
        const r = await withEchoServer(host, async (port) => {
            const reqFn = evalFn(reqText, 'req', 'http', 'testEnv')(http, { env: () => ({ baseUrl: mk(port) }) });
            const resp = await reqFn('tok', 'POST', '/api/x/1?y=2', { a: 1 });
            let j = null; try { j = JSON.parse(resp.body); } catch (_) { /* 非 JSON */ }
            return { status: resp.status, ok: resp.status === 200 && !!j && j.path === '/api/x/1?y=2' && j.auth === 'Bearer tok' && j.method === 'POST' && j.body === J({ a: 1 }) };
        });
        if (r.unavailable) { if (key === 'ipv6') out.ipv6Unavailable = r.unavailable; else out.ipv4 = { status: -1, ok: false }; } else out[key] = r.value;
    }
    return out;
}

async function sectionH() {
    console.log('\n== 节 H：静态守卫（已改造脚本 + 夹具） ==');
    const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/\r\n/g, '\n');   // 检出的行尾可能是 CRLF（autocrlf）：锚点按 LF 写
    const sources = {};
    for (const f of S3B_REPRESENTATIVES) sources[f] = read(f);
    const fxSrc = fs.readFileSync(FX_PATH, 'utf8').replace(/\r\n/g, '\n');

    const dirty = {};
    for (const f of S3B_REPRESENTATIVES) { const v = analyzeScript(f, sources[f], { exemptNoReady: !!EXEMPT_NO_READY[f] }); if (v.length) dirty[f] = v; }
    check('H.1', `已迁移的 ${S3B_REPRESENTATIVES.length} 个代表脚本（受本守卫保护；第 9 个 verify-model-list-extras.js 只评估未改、不在此列）全部干净：无写死 3000 / 真实库路径 / dotenv / 自 spawn server.js；硬规则：模块顶层只有声明与一个入口调用，入口函数里 \`await ready()\` 是第一条有副作用的语句（豁免 ${Object.keys(EXEMPT_NO_READY).length} 个，见 EXEMPT_NO_READY）`, Object.keys(dirty).length === 0, dirty);
    const notRegistered = S3B_REPRESENTATIVES.filter((f) => !Object.prototype.hasOwnProperty.call(REGISTRY_MIGRATED, f));
    check('H.1b', `S4a：这 ${S3B_REPRESENTATIVES.length} 个 S3b 代表脚本都在全目录登记表 lib/test-isolation-registry.js 的 MIGRATED 里（本节用例的样本与全目录守卫保护的已迁移集合一致；EXEMPT_NO_READY 的键必须属于 MIGRATED 由全目录守卫核对，这里不限定它只能是这 8 个）`, notRegistered.length === 0 && S3B_REPRESENTATIVES.length === 8, { notRegistered });
    const fxV = analyzeScript('_test-fixture.js', fxSrc, { exemptNoReady: true }).filter((v) => v.rule !== 'R4');
    check('H.2', '_test-fixture.js 本身：无写死 3000 / 真实库路径 / dotenv / process.env.JWT_SECRET', fxV.length === 0, fxV);

    // 反例 1：加回写死 3000 —— 对已迁移的 8 个脚本逐个注入，守卫必须判红 R1
    const injected = {};
    const missed = [];
    for (const f of S3B_REPRESENTATIVES) {
        const mutated = `${sources[f]}\nconst __LEGACY_BASE = 'http://localhost:3000';\n`;
        const v = analyzeScript(f, mutated, { exemptNoReady: !!EXEMPT_NO_READY[f] });
        injected[f] = v;
        if (!v.some((x) => x.rule === 'R1')) missed.push(f);
    }
    check('H.3', `方案反例 1（加回写死 3000）：向每个已迁移脚本（${S3B_REPRESENTATIVES.length} 个）注入一行 localhost:3000 → 守卫判红 R1（逐个都红）`, missed.length === 0 && S3B_REPRESENTATIVES.length === 8, missed);
    const portForms = ["const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';", 'const PORT = 3000;', 'const u = `http://127.0.0.1:3000/api`;', "const BASE_URL = process.env.BASE_URL || 'http://[::1]:3000';",
        'const PORT = process.env.PORT || 3000;', 'const cfg = { port: 3000 };', "const h = 'localhost:3000';",
        // 修复批 2a：端口识别正则改 /(?:^|_)port$/i，并识别「3000 绑定的标识符拼进 URL 端口位置」与字符串拼接
        'const TEST_PORT = 3000;', 'const SERVER_PORT = 3000;', 'const P = 3000;\nconst u2 = `http://127.0.0.1:${P}/api`;', "const u3 = 'http://localhost:' + 3000;",
        "const P2 = 3000;\nconst u4 = 'http://127.0.0.1:' + P2 + '/api';", 'const cfg2 = { TEST_PORT: 3000 };', 'const u5 = `http://localhost:${3000}`;'];
    const badForms = portForms.filter((line) => !analyzeScript('x.js', `${sources['test-codex-perm-e2e.js']}\n${line}\n`).some((x) => x.rule === 'R1'));
    check('H.4', `写死 3000 的 ${portForms.length} 种写法（回落式 / PORT 常量 / 模板串 / ::1 / PORT 回落 / port 属性 / 裸 host:port 串 / TEST_PORT·SERVER_PORT 常量 / 绑定 3000 的标识符拼进模板串·字符串拼接 / 'http://localhost:' + 3000 / TEST_PORT 属性 / 模板串里直接 \${3000}）都判红 R1`, badForms.length === 0, badForms);
    const ctl = analyzeScript('x.js', `${sources['test-codex-perm-e2e.js']}\nconst T = { timeout: 3000, big: 30001, other: 13000 };\n`).filter((x) => x.rule === 'R1');
    const ctlCompact = analyzeScript('x.js', `${sources['test-codex-perm-e2e.js']}\nconst T2 = {timeout:3000, delay:3000}; const s = 'timeout:3000'; const w = setTimeout(f,3000);\n`).filter((x) => x.rule === 'R1');
    const ctlBound = analyzeScript('x.js', `${sources['test-codex-perm-e2e.js']}\nconst D2 = 3000; const w2 = setTimeout(f, D2); const m = \`\${D2}ms\`; const msg = 'wait ' + 3000; const portal = 3000; const t3 = { portfolio: 3000 };\n`).filter((x) => x.rule === 'R1');
    check('H.5', '对照组：作为毫秒数 / 其他数字出现的 3000（timeout: 3000、30001、13000，紧凑写法 {timeout:3000, delay:3000}、字符串 \'timeout:3000\'、setTimeout(f,3000)，以及绑定 3000 的标识符用作毫秒数 setTimeout(f, D2) / `${D2}ms`、\'wait \' + 3000、名字以 portal / portfolio 开头）不误报', ctl.length === 0 && ctlCompact.length === 0 && ctlBound.length === 0, { ctl, ctlCompact, ctlBound });

    const realDb = analyzeScript('x.js', `${sources['test-codex-perm-e2e.js']}\nconst P = require('path').join(__dirname, '..', 'task_pool.db');\n`);
    const dot = analyzeScript('x.js', `require('dotenv').config();\n${sources['test-codex-perm-e2e.js']}`);
    const spawnSrv = analyzeScript('x.js', `${sources['verify-issue-lite-d4.js']}\nconst { spawn } = require('child_process'); const cc = spawn('node', ['server.js']);\n`);
    check('H.6', '注入真实库路径 / dotenv / 自 spawn server.js 各判红 R2 / R2 / R3', realDb.some((x) => x.rule === 'R2') && dot.some((x) => x.rule === 'R2') && spawnSrv.some((x) => x.rule === 'R3'), { realDb, dot, spawnSrv });
    const cmtOnly = analyzeScript('x.js', `// 旧版: http://localhost:3000 与 task_pool.db 与 require('dotenv')\n/* PORT = 3000 */\n${sources['test-codex-perm-e2e.js']}`);
    check('H.7', '对照组：只出现在注释里的 3000 / task_pool.db / dotenv 不误报（注释先剥离）', cmtOnly.length === 0, cmtOnly);

    // ready 顺序
    const swapSrc = sources['test-requester-done-creator-visibility-playwright.js'];
    const A = "    await fx.ready();   // 先于任何写库 / 网络请求 / 浏览器操作\n    const adminToken = await fx.signAs(fx.ADMIN_ID);";
    const swapped = swapSrc.includes(A) ? swapSrc.replace(A, "    const adminToken = await fx.signAs(fx.ADMIN_ID);\n    await fx.ready();") : null;
    const vSwap = swapped ? analyzeScript('x.js', swapped) : [];
    check('H.8', '方案守卫「首次网络 / 写库前调用 ready()」：把 ready() 挪到 signAs 之后 → 判红 R5（锚点命中一次）', swapped !== null && vSwap.some((x) => x.rule === 'R5'), { anchor: swapSrc.includes(A), vSwap });
    const noReadySrc = sources['test-sys-config-hide-playwright.js'].replace("  await testEnv.ready();   // 先于任何网络请求 / 浏览器操作\n  console.log('=== 系统迭代 建单弹窗 config-hide 验证 ===\\n');\n  BASE_URL = testEnv.env().baseUrl;\n", "  console.log('=== 系统迭代 建单弹窗 config-hide 验证 ===\\n');\n  BASE_URL = 'x';\n");
    const vNo = analyzeScript('x.js', noReadySrc);
    check('H.9', '删掉 ready() 调用 → 判红 R4（没有 ready）', noReadySrc !== sources['test-sys-config-hide-playwright.js'] && vNo.some((x) => x.rule === 'R4'), vNo);
    const topIo = analyzeScript('x.js', sources['verify-correction-creator-e2e.js'].replace('let db = null;', "const db0 = new sqlite3.Database('x.db');\nlet db = null;"));
    check('H.10', '顶层（函数外）直接打开库 → 判红 R5（加载时执行，早于入口函数里的 ready()）', topIo.some((x) => x.rule === 'R5'), topIo);
    const helperIo = analyzeScript('verify-dingtalk-file-helper.js', `${sources['verify-dingtalk-file-helper.js']}\n(async () => { await fetch('http://127.0.0.1:1/x'); })();\n`, { exemptNoReady: true });
    check('H.11', '豁免清单里的脚本一旦出现 I/O → 判红 R4（豁免理由必须成立）', helperIo.some((x) => x.rule === 'R4'), helperIo);
    const exemptExec = {
        bareExec: `${sources['verify-dingtalk-file-helper.js']}\nconst { exec } = require('child_process');\nexec('node worker.js');\n`,
        cpExec: `${sources['verify-dingtalk-file-helper.js']}\nconst cp = require('child_process');\ncp.exec('node worker.js');\n`,
    };
    const execRes = Object.entries(exemptExec).map(([k, s]) => ({ k, r4: analyzeScript('verify-dingtalk-file-helper.js', s, { exemptNoReady: true }).some((x) => x.rule === 'R4') }));
    const regexExec = analyzeScript('verify-dingtalk-file-helper.js', `${sources['verify-dingtalk-file-helper.js']}\nconst m = /a(b)/.exec('ab');\nvoid m;\n`, { exemptNoReady: true });
    const regexExecCp = analyzeScript('verify-dingtalk-file-helper.js', `${sources['verify-dingtalk-file-helper.js']}\nconst cp = require('child_process');\nvoid cp;\nconst m = /a(b)/.exec('ab');\nvoid m;\n`, { exemptNoReady: true });
    check('H.11b', '豁免脚本调用 exec（解构出的裸 exec / child_process 对象上的 .exec）→ 判红 R4；对照：正则字面量的 .exec 不算 I/O——没 require child_process 时、require 了 child_process 时都不算（47R4b M2 / 47R4bc-R L）', execRes.every((x) => x.r4) && !regexExec.some((x) => x.rule === 'R4') && !regexExecCp.some((x) => x.rule === 'R4'), { execRes, regexExec, regexExecCp });
    const helperClean = Object.keys(EXEMPT_NO_READY).filter((f) => f === 'verify-dingtalk-file-helper.js').every((f) => analyzeScript(f, sources[f], { exemptNoReady: true }).length === 0);
    check('H.12', '豁免脚本 verify-dingtalk-file-helper.js 实际无 I/O、无 ready()，且已向外部调用闸注入正常模式配置（源码含 _setConfigProviderForTest）', helperClean && /_setConfigProviderForTest/.test(sources['verify-dingtalk-file-helper.js']));

    // 必经路径（S3b 修复批 1，codex 13T M3）：三个反例夹具 + 辅助函数转调 + try 的 catch 里有 I/O；每个夹具都从已迁移脚本的真实源码上做一处改动，锚点必须恰命中一次
    const base = sources['verify-issue-lite-archive-keeps-completion.js'];
    const READY_LINE = '    await fx.ready();   // 先于任何写库 / 网络请求：自起隔离实例（或核对 TEST_* 变量组）\n';
    const anchorOnce = base.split(READY_LINE).length === 2;
    const noAwait = base.replace(READY_LINE, '    fx.ready();\n');
    const inIf = base.replace(READY_LINE, '    if (process.argv.length > 1000) { await fx.ready(); }\n');
    const inIfBare = base.replace(READY_LINE, '    if (process.argv.length > 1000) await fx.ready();\n');
    const inUncalled = `${base.replace(READY_LINE, '')}\nasync function __neverCalledInit() { await fx.ready(); }\n`;
    const viaHelper = `async function __initViaHelper() { await fx.ready(); }\n${base.replace(READY_LINE, '    await __initViaHelper();\n')}`;
    const vNoAwait = analyzeScript('x.js', noAwait); const vIf = analyzeScript('x.js', inIf); const vUncalled = analyzeScript('x.js', inUncalled); const vHelper = analyzeScript('x.js', viaHelper);
    check('H.13a', '反例：删掉 await（fx.ready(); 只触发不等待，后面的 I/O 不会等就绪）→ 判红 R6（锚点命中一次）', anchorOnce && noAwait !== base && vNoAwait.some((x) => x.rule === 'R6'), { anchorOnce, vNoAwait });
    check('H.13b', '反例：ready() 放进 if 分支（条件不成立就不执行；带花括号与不带花括号两种写法）→ 判红 R6', anchorOnce && vIf.some((x) => x.rule === 'R6') && analyzeScript('x.js', inIfBare).some((x) => x.rule === 'R6'), { anchorOnce, vIf });
    check('H.13c', '反例：ready() 放进从未被调用的函数 → 判红 R6', anchorOnce && vUncalled.some((x) => x.rule === 'R6'), { anchorOnce, vUncalled });
    check('H.13d', '反例：ready() 挪进更早定义的辅助函数、入口函数只 await 辅助函数（无法确定必经）→ 判红 R6，要求人工豁免', anchorOnce && vHelper.some((x) => x.rule === 'R6'), { anchorOnce, vHelper });
    // 撤销「顶层 try 首条」放宽（修复批 2a）：ready() 必须是入口函数体里第一条有副作用的语句，try 里的 ready 一律不认。六个反例夹具（预筛 v2 的 G1 / G3 / G4 / Y1 / G6 / G7 / G5），均判红
    const d4 = sources['verify-issue-lite-d4.js'];
    const FX_REQ = "const fx = require('./_test-fixture');\n";
    const afterFx = (src, extra) => src.replace(FX_REQ, `${FX_REQ}${extra}\n`);   // 声明插在 require 之后（'use strict' 指令保持在文件最前面）
    const IO_FN = "async function __io() { await fetch('http://127.0.0.1:3100/io'); }";
    const fxA = anchorOnce && base.split(FX_REQ).length === 2 ? [
        ['H.13e1', 'catch 吞掉 ready 失败后，try 外做网络 I/O（G1）', base.replace(READY_LINE, "    try { await fx.ready(); } catch (e) { console.error(e); }\n    await fetch('http://127.0.0.1:3100/x');\n"), /含 ready\(\) 但不是独立/],
        ['H.13e2', 'catch / finally 调本模块函数做 I/O（G3 / G4：catch 与 finally 各调一次本模块的 I/O 函数）', afterFx(base.replace(READY_LINE, '    try { await fx.ready(); } catch (e) { await __io(); } finally { await __io(); }\n'), IO_FN), /含 ready\(\) 但不是独立/],
        ['H.13e3', 'finally 里直接 I/O（Y1）', base.replace(READY_LINE, "    try { await fx.ready(); } finally { await fetch('http://127.0.0.1:3100/y'); }\n"), /含 ready\(\) 但不是独立/],
        ['H.13e4', '第二个 IIFE 做 I/O', `${base}\n(async () => { await fetch('http://127.0.0.1:3100/warm'); })();\n`, /恰有一个入口调用.*实际 2 个/],
        ['H.13e5', 'ready 之前调一个会做 I/O 的辅助函数（G7）', afterFx(base.replace(READY_LINE, `    await __seed();\n${READY_LINE}`), 'async function __seed() { return fx.createPendingFixture(); }'), /第一条有副作用的语句.*不是 `await ready\(\)`/],
        ['H.13e6', '解构出 signAs 后在 ready 前调用（G5）', afterFx(base.replace(READY_LINE, `    const __t = await signAs(1);\n${READY_LINE}`), 'const { signAs } = fx;'), /第一条有副作用的语句.*不是 `await ready\(\)`/],
        ['H.13e7', '模块顶层有非声明的可执行语句（顶层 process.on）', `${base}\nprocess.on('unhandledRejection', () => {});\n`, /模块顶层有可执行语句/],
    ] : [];
    const e1Res = fxA.map(([id, label, src, why]) => { const v = analyzeScript('x.js', src); return { id, label, v, red: v.some((x) => (x.rule === 'R5' || x.rule === 'R6') && why.test(x.detail)) }; });
    check('H.13e', `撤销「顶层 try 首条」放宽——${fxA.length} 个反例夹具（每个都从已迁移脚本真实源码上改一处，锚点命中一次）均判红，且红在预期的原因上：${fxA.map((f) => f[1]).join(' / ')}`,
        anchorOnce && fxA.length === 7 && e1Res.every((r) => r.red), e1Res.filter((r) => !r.red).map((r) => ({ id: r.id, v: r.v })));
    const d4Old = d4.replace("    await fx.ready();   // 先于任何写库 / 网络请求：自起隔离实例（或核对 TEST_* 变量组）；test-env 已等到全部模块（含 issue_lite）就绪\n    let ready = false;\n    try {\n",
        "    let ready = false;\n    try {\n        await fx.ready();   // 先于任何写库 / 网络请求：自起隔离实例（或核对 TEST_* 变量组）；test-env 已等到全部模块（含 issue_lite）就绪\n");
    check('H.13g', '对照组与回退：未改动的 verify-issue-lite-d4.js（ready 挪到 try 之前、IIFE 带 .catch）判绿；把 ready 退回 try 首条的旧形态判红 R6（修复批 1 认可的放宽已撤销）',
        d4Old !== d4 && analyzeScript('verify-issue-lite-d4.js', d4).length === 0 && analyzeScript('x.js', d4Old).some((x) => x.rule === 'R6'), { d4Green: analyzeScript('verify-issue-lite-d4.js', d4), d4OldRed: analyzeScript('x.js', d4Old) });
    const goodCtl = analyzeScript('x.js', base);
    check('H.13f', '对照组：未改动的 verify-issue-lite-archive-keeps-completion.js（IIFE 顶层语句 await fx.ready()）判绿', goodCtl.length === 0, goodCtl);

    // fx.BASE / fx.DB_PATH 成员读取（预筛 LOW-1 X4）：ready() 之前读取、顶层读取、解构读取都判红；ready() 之后读取不误报
    const memberBefore = base.replace(READY_LINE, `    const __b = fx.BASE;\n${READY_LINE}`);
    const memberTop = `${base}\nconst __top = fx.DB_PATH;\n`;
    const memberDestruct = base.replace(READY_LINE, `    const { BASE: __b2 } = fx;\n${READY_LINE}`);
    const memberAfter = base.replace(READY_LINE, `${READY_LINE}    const __ok = fx.BASE;\n`);
    const vMB = analyzeScript('x.js', memberBefore); const vMT = analyzeScript('x.js', memberTop); const vMD = analyzeScript('x.js', memberDestruct); const vMA = analyzeScript('x.js', memberAfter);
    check('H.14', '预筛 X4：fx.BASE / fx.DB_PATH 成员读取算 I/O——入口函数里 ready() 之前读取、顶层读取、解构读取（const { BASE } = fx）都判红 R5；对照组：ready() 之后读取判绿',
        anchorOnce && vMB.some((x) => x.rule === 'R5') && vMT.some((x) => x.rule === 'R5') && vMD.some((x) => x.rule === 'R5') && vMA.length === 0, { vMB, vMT, vMD, vMA });
    const aliasSrc = base.replace("const fx = require('./_test-fixture');", "const F = require('./_test-fixture');\nconst fx = F;").replace(READY_LINE, `    const __a = F.BASE;\n${READY_LINE}`);
    check('H.15', '夹具对象换名（const F = require(\'./_test-fixture\')）后 F.BASE 在 ready() 之前读取同样判红 R5', aliasSrc !== base && analyzeScript('x.js', aliasSrc).some((x) => x.rule === 'R5'), analyzeScript('x.js', aliasSrc));

    // C1 选择器唯一性的静态依据（S3b 修复批 1 第 4 项）：data-collab-id= 在整个 public 里只出现一处（Data_Collab.html 的按钮生成点）；requester-done 脚本的 C1 断言匹配数恰为 1
    const occ = collabIdOccurrences();
    const reqSrc = sources['test-requester-done-creator-visibility-playwright.js'];
    check('H.16', 'C1 选择器唯一性：public 下 html / js 里生成 data-collab-id= 属性的地方只有 1 处且在 Data_Collab.html（按钮生成点；CSS 选择器里的 [data-collab-id= 不计）；requester-done 脚本用 querySelectorAll 计数并断言 c1.matches === 1、注释写明来源',
        occ.length === 1 && /^Data_Collab\.html:\d+$/.test(occ[0]) && /querySelectorAll\(`\.u-nb-btn\[data-collab-id=/.test(reqSrc) && /c1\.matches === 1/.test(reqSrc) && /Data_Collab\.html:2481/.test(reqSrc), { occ });

    // 13-R M：test-codex-perm-e2e.js 的 SKIP 闸门。非 200 与响应结构异常一律失败，只有「200 且确为数组且长度 0」才 SKIP——纯函数表驱动 + 调用处结构；不实跑脚本
    const permSrc = sources['test-codex-perm-e2e.js'];
    const permNow = checkPermGate(permSrc);
    const FAIL_LINE = "if (!res || res.status !== 200 || !Array.isArray(res.body)) return 'FAIL';";
    const permAnchor = permSrc.split(FAIL_LINE).length === 2 && permSrc.split("if (gate === 'FAIL') {").length === 2 && permSrc.split("if (gate === 'SKIP') {").length === 2;
    const permNeg = [
        ['非 200 也算 SKIP/OK（去掉 status 判定）', permSrc.replace(FAIL_LINE, "if (!res || !Array.isArray(res.body)) return 'FAIL';")],
        ['响应不是数组也往下走（去掉 Array.isArray 判定）', permSrc.replace(FAIL_LINE, "if (!res || res.status !== 200) return 'FAIL';")],
        ['FAIL 分支被短路（if (false)）', permSrc.replace("if (gate === 'FAIL') {", 'if (false) {')],
        ['SKIP 分支放宽成「不是 OK 就 SKIP」', permSrc.replace("if (gate === 'SKIP') {", "if (gate !== 'OK') {")],
    ].map(([label, s]) => ({ label, changed: s !== permSrc, problems: checkPermGate(s) }));
    check('H.17', '13-R M：test-codex-perm-e2e.js 的 SKIP 闸门——抽出纯函数 classifyCollabList 做表驱动（13 行：200+[] → SKIP、200+非空数组 → OK，非 200 / 响应不是数组（null·对象·字符串·{length:0}·缺失）/ 没有响应 → FAIL）+ 调用处结构（FAIL → finish(1)，SKIP → finish(0) + SKIP 日志且只一处）通过；四个回退夹具各自判红',
        permNow.length === 0 && permAnchor && permNeg.every((n) => n.changed && n.problems.length > 0), { permNow, permAnchor, permNeg: permNeg.map((n) => ({ label: n.label, changed: n.changed, problems: n.problems.length })) });

    // 13-R M：verify-correction-creator-e2e.js 的请求封装传完整 URL，IPv6 回环 [::1] 正常
    const ccSrc = sources['verify-correction-creator-e2e.js'];
    const ccReq = extractFn(ccSrc, 'req');
    const reqStruct = (t) => !!t && /http\.request\(\s*new URL\(p,\s*testEnv\.env\(\)\.baseUrl\)\s*,\s*\{\s*method\b/.test(t) && !/\bhost:\s*u\.hostname\b/.test(t);
    const ccStruct = reqStruct(ccReq);
    const ccNow = ccReq ? await reqBehavior(ccReq) : null;
    const ccLegacy = await reqBehavior(LEGACY_REQ);
    // 实测（Node v24.11.1）：旧写法 host: u.hostname（带方括号）在本机 Node 上连 IPv6 回环也能通，所以行为用例本身分不出新旧——新旧的区分靠结构检查（旧写法结构判红）；
    //   新写法把主机与端口交给 Node 按 URL 解析，不依赖「带括号的 host 是否被某个 Node 版本接受」。
    if (ccNow && ccNow.ipv6Unavailable !== null) console.log(`NOTE H.18：本机没有 IPv6 回环（${ccNow.ipv6Unavailable}），IPv6 行为用例降级为结构检查 + IPv4 行为`);
    check('H.18', `13-R M：verify-correction-creator-e2e.js 的请求封装 http.request(new URL(p, baseUrl), { method, headers }, cb) 传完整 URL——结构正确（不再把 u.hostname 当 host）；行为：真实回显服务上 IPv4 回环与 IPv6 回环 [::1]（本机无 IPv6 回环时降级为结构 + IPv4 并打印 NOTE）都得到 200、路径 / 查询 / 方法 / 鉴权头 / 正文原样；回退夹具：旧写法（host: u.hostname）的结构检查判红（行为用例本身分不出新旧：本机 Node 上旧写法连 IPv6 回环也通）`,
        ccStruct && !!ccNow && ccNow.ipv4 && ccNow.ipv4.ok === true && (ccNow.ipv6Unavailable !== null || (ccNow.ipv6 && ccNow.ipv6.ok === true))
        && reqStruct(LEGACY_REQ) === false && ccLegacy.ipv4 && ccLegacy.ipv4.ok === true,
        { ccStruct, ccNow, legacyStruct: reqStruct(LEGACY_REQ), ccLegacy });

    // 退出约定（用户裁定，13T-R2 M6）：已迁移的 7 个使用 ready() 的脚本都以「`await teardown()` 或 `process.exit(…)`」二选一收尾（否则退出码兜底会把退出码改成 70）。
    //   静态证据是**实际调用关系**（analyzeClosers / findClosers）：从入口函数和入口链上成功路径的回调（.finally / .then）出发，沿顶层命名函数的直接调用走，找被 await 的 teardown() 与 process.exit(…)；
    //   只定义函数不调用不算；没有 await 的裸 teardown() 不算；process.exitCode = … 不算 process.exit()。
    const closers = S3B_REPRESENTATIVES.filter((f) => !EXEMPT_NO_READY[f]);
    const closerRows = closers.map((f) => ({ f, c: analyzeClosers(sources[f]) }));
    const openEnded = closerRows.filter((r) => !(r.c.teardown || r.c.exit));
    check('H.19', `退出约定：${closers.length} 个使用 ready() 的已迁移脚本都有「被 await 的 teardown()」或「process.exit(…)」收尾，且在入口函数 / 入口链成功路径 / 它们直接调用的顶层函数里可达（豁免脚本 ${Object.keys(EXEMPT_NO_READY).join(' / ')} 不用 test-env）`,
        closers.length === 7 && openEnded.length === 0, openEnded);
    const TD_LINE = "    await fx.teardown().catch((e) => { console.error('teardown 失败：' + e.message); fail++; });\n";
    // S4-x：被测脚本成功路径的收尾由 process.exit(…) 改成 fx.finish(…)（Windows 上 fetch 之后立即 process.exit 会崩溃）。EXIT_LINE 是现在的锚点（finish 行），EXIT_PROC 是「只有 process.exit」对照用的替换行
    const EXIT_LINE = /^    fx\.finish\(fail > 0 \? 1 : 0\);.*\n/m.exec(base) ? /^    fx\.finish\(fail > 0 \? 1 : 0\);.*\n/m.exec(base)[0] : '    fx.finish(fail > 0 ? 1 : 0);\n';
    const EXIT_PROC = '    process.exit(fail > 0 ? 1 : 0);\n';
    const closerAnchor = base.split(TD_LINE).length === 2 && base.split(EXIT_LINE).length === 2;
    const closerVar = (name, src) => { const c = analyzeClosers(src); return { name, c, rules: analyzeScript('x.js', src).map((v) => v.rule) }; };
    const vBoth = closerVar('原样（teardown + finish）', base);
    const vTdOnly = closerVar('只有 await teardown()（对照）', base.replace(EXIT_LINE, ''));
    const vExitOnly = closerVar('只有 process.exit(…)（对照）', base.replace(TD_LINE, '').replace(EXIT_LINE, EXIT_PROC));
    const vHelperTd = closerVar('teardown 在入口直接调用的顶层函数里（对照：实际调用关系可达）', `${base.replace(TD_LINE, '    await closeAll();\n').replace(EXIT_LINE, '')}\nasync function closeAll() { await fx.teardown(); }\n`);
    const vCloseNoAwait = closerVar('去掉 await（裸 teardown()）且无 exit', base.replace(TD_LINE, "    fx.teardown().catch((e) => { console.error('teardown 失败：' + e.message); fail++; });\n").replace(EXIT_LINE, ''));
    const vDefOnly = closerVar('去掉收尾调用但保留函数定义（定义里有 await teardown() 与 process.exit，入口不调用它）', `${base.replace(TD_LINE, '').replace(EXIT_LINE, '')}\nasync function __neverCalledClose() { await fx.teardown(); process.exit(0); }\n`);
    const vExitCodeOnly = closerVar('process.exitCode = … 不等同于 process.exit()（且无 teardown）', base.replace(TD_LINE, '').replace(EXIT_LINE, '    process.exitCode = fail > 0 ? 1 : 0;\n'));
    const vNestedCb = closerVar('teardown 只在嵌套回调里（setTimeout 里的 await，不保证被调用）且无 exit', base.replace(TD_LINE, '    setTimeout(async () => { await fx.teardown(); }, 0);\n').replace(EXIT_LINE, ''));
    const closeOk = (v) => v.c.teardown || v.c.exit;
    check('H.19b', '退出约定的对照与反例（从 verify-issue-lite-archive-keeps-completion.js 真实源码上改一处，锚点命中一次）：原样 / 只有 await teardown() / 只有 process.exit() / teardown 在入口调用的顶层函数里 → 判绿且守卫无违规；去掉 await / 去掉收尾调用但保留函数定义 / 只有 process.exitCode / teardown 只在嵌套回调里 → 判红',
        closerAnchor && [vBoth, vTdOnly, vExitOnly, vHelperTd].every((v) => closeOk(v) && v.rules.length === 0) && vTdOnly.c.teardown && !vTdOnly.c.exit && vExitOnly.c.exit && !vExitOnly.c.teardown && vHelperTd.c.teardown
        && [vCloseNoAwait, vDefOnly, vExitCodeOnly, vNestedCb].every((v) => !closeOk(v)),
        { closerAnchor, rows: [vBoth, vTdOnly, vExitOnly, vHelperTd, vCloseNoAwait, vDefOnly, vExitCodeOnly, vNestedCb].map((v) => ({ name: v.name, c: v.c, rules: v.rules })) });

    // ---- 收口小批 · 静态守卫的结构盲区（13T-R2 M4 / M5，预筛 LOW-2 / LOW-3 / LOW-4 MY1 MY2）：模板脚本 + 逐处改动；每个模板先证明「对照组判绿」，锚点命中一次 ----
    const GOOD = "'use strict';\nconst fx = require('./_test-fixture');\n(async () => {\n  await fx.ready();\n  await fx.teardown();\n  process.exit(0);\n})().catch((e) => { console.error(e); process.exit(1); });\n";
    const MAINS = "'use strict';\nconst fx = require('./_test-fixture');\nasync function main() {\n  await fx.ready();\n  await fx.teardown();\n  process.exit(0);\n}\nmain().catch((e) => { console.error(e); process.exit(1); });\n";
    const rep1 = (src, from, to) => { const p = src.split(from); return p.length === 2 ? p.join(to) : null; };   // 锚点必须恰命中一次；否则 null（用例判红，不静默）
    const verdict = (src) => analyzeScript('x.js', src);
    const goodTplV = verdict(GOOD); const mainsTplV = verdict(MAINS);
    check('H.20a', '静态守卫模板的对照组：GOOD（IIFE + await ready + await teardown + process.exit + .catch 非零退出）与 MAINS（顶层命名函数入口）判绿（下面所有反例都从它们改一处）', goodTplV.length === 0 && mainsTplV.length === 0, { goodTplV, mainsTplV });

    // H.20：入口函数参数的默认表达式 / 解构计算键必须纯（13T-R2 M4）
    const FX_REQ_LINE = "const fx = require('./_test-fixture');\n";
    const withDecl = (src, decl) => rep1(src, FX_REQ_LINE, `${FX_REQ_LINE}${decl}`);   // 声明插在 require 之后（'use strict' 指令保持在文件最前面）
    const WARM = "function warmUp() { return fetch('http://127.0.0.1:3100/w'); }\n";
    const paramCases = [
        ['默认参数调 fetch（IIFE）', rep1(GOOD, '(async () => {', "(async (warm = fetch('http://127.0.0.1:3100/warm')) => {"), 'R5'],
        ['默认参数调夹具助手（fx.signAs）', rep1(GOOD, '(async () => {', '(async (t = fx.signAs(1)) => {'), 'R5'],
        ['默认参数调普通辅助函数', rep1(withDecl(GOOD, WARM), '(async () => {', '(async (w = warmUp()) => {'), 'R6'],
        ['默认参数读 fx.BASE（顶层命名函数入口）', rep1(MAINS, 'async function main() {', 'async function main(base = fx.BASE) {'), 'R5'],
        ['解构的计算键里调辅助函数', rep1(withDecl(GOOD, WARM), '(async () => {', '(async ({ [warmUp()]: k } = {}) => {'), 'R6'],
    ];
    const paramRes = paramCases.map(([label, src, rule]) => { const v = src === null ? [] : verdict(src); return { label, anchored: src !== null, red: v.some((x) => x.rule === rule && /入口函数的参数/.test(x.detail)), rules: v.map((x) => x.rule) }; });
    const pureParamCtl = verdict(rep1(GOOD, '(async () => {', '(async (a = 1, { b = [], c: [d] = [2], e = `x${1}` } = {}, ...rest) => {'));
    check('H.20', `13T-R2 M4：入口函数参数默认值必须纯——${paramCases.map((c) => c[0]).join(' / ')} 都判红（R5 有 I/O、R6 无法判定，原因都点名「入口函数的参数」）；对照组：纯默认值（字面量 / 数组 / 模板串 / 解构默认）判绿`,
        paramRes.every((r) => r.anchored && r.red) && pureParamCtl.length === 0, { paramRes, pureParamCtl });

    // H.21：ready() 的来源绑定（13T-R2 M5 / 预筛 LOW-2）
    const TAIL = "  await fetch('http://127.0.0.1:3100/api');\n  process.exit(0);\n})().catch((e) => { console.error(e); process.exit(1); });\n";
    const srcCases = [
        ['本地 function ready(){}', `'use strict';\nfunction ready() { return Promise.resolve(); }\n(async () => {\n  await ready();\n${TAIL}`],
        ['别的模块对象的 srv.ready()', `'use strict';\nconst srv = require('./lib/sql-select-boundary');\n(async () => {\n  await srv.ready();\n${TAIL}`],
        ['导入的 ready 被同名本地函数遮蔽（声明点 2 个）', `'use strict';\nconst { ready } = require('./lib/test-env');\nasync function helper() { function ready() { return 1; } return ready(); }\n(async () => {\n  await ready();\n${TAIL}`],
        ['从别的模块解构出的 ready', `'use strict';\nconst { ready } = require('./lib/sql-select-boundary');\n(async () => {\n  await ready();\n${TAIL}`],
    ];
    const srcRes = srcCases.map(([label, src]) => ({ label, rules: verdict(src).map((x) => x.rule) }));
    const aliasOk = [
        ['const T = require(test-env); await T.ready()', "'use strict';\nconst T = require('./lib/test-env');\n(async () => {\n  await T.ready();\n  await T.teardown();\n  process.exit(0);\n})().catch((e) => { console.error(e); process.exit(1); });\n"],
        ['const { ready, teardown } = require(test-env)', "'use strict';\nconst { ready, teardown } = require('./lib/test-env');\n(async () => {\n  await ready();\n  await teardown();\n  process.exit(0);\n})().catch((e) => { console.error(e); process.exit(1); });\n"],
        ['const { ready: r0 } = require(_test-fixture)', "'use strict';\nconst { ready: r0 } = require('./_test-fixture');\n(async () => {\n  await r0();\n  process.exit(0);\n})().catch((e) => { console.error(e); process.exit(1); });\n"],
        ['const F = require(_test-fixture); const fx2 = F; await fx2.ready()', "'use strict';\nconst F = require('./_test-fixture');\nconst fx2 = F;\n(async () => {\n  await fx2.ready();\n  process.exit(0);\n})().catch((e) => { console.error(e); process.exit(1); });\n"],
        ['await require(_test-fixture).ready()', "'use strict';\n(async () => {\n  await require('./_test-fixture').ready();\n  process.exit(0);\n})().catch((e) => { console.error(e); process.exit(1); });\n"],
        ['const { ready } = fx（从绑定对象解构）', "'use strict';\nconst fx = require('./_test-fixture');\nconst { ready } = fx;\n(async () => {\n  await ready();\n  process.exit(0);\n})().catch((e) => { console.error(e); process.exit(1); });\n"],
    ];
    const aliasRes = aliasOk.map(([label, src]) => ({ label, v: verdict(src) }));
    check('H.21', `13T-R2 M5：ready() 只认 test-env / _test-fixture 的导入绑定——${srcCases.map((c) => c[0]).join(' / ')} 都判红 R4（没有合法的 ready() 调用）；合法别名对照（${aliasOk.length} 种：模块别名 / 解构 / { ready: r } / 一层 const 别名 / 内联 require().ready() / 从绑定对象解构）判绿`,
        srcRes.every((r) => r.rules.includes('R4')) && aliasRes.every((r) => r.v.length === 0), { srcRes, aliasRes: aliasRes.map((r) => ({ label: r.label, v: r.v })) });

    // H.22：D-1——入口调用链上的 .catch 回调必须以非零退出（R7）
    const CATCH = '.catch((e) => { console.error(e); process.exit(1); })';
    const catchBad = [
        ['catch 里只打印', rep1(GOOD, CATCH, '.catch((e) => { console.error(e); })')],
        ['catch 里 process.exit(0)', rep1(GOOD, CATCH, '.catch((e) => { console.error(e); process.exit(0); })')],
        ['catch 里 process.exitCode = 0', rep1(GOOD, CATCH, '.catch((e) => { console.error(e); process.exitCode = 0; })')],
        ['catch 先 return 再 exit（到不了）', rep1(GOOD, CATCH, '.catch((e) => { console.error(e); return; process.exit(1); })')],
        ['catch 只在 if 分支里退出（不是顶层语句）', rep1(GOOD, CATCH, '.catch((e) => { if (e) { process.exit(1); } })')],
        ['catch 退出码是变量（无法证明非零）', rep1(GOOD, CATCH, '.catch((e) => { process.exit(e.code); })')],
        ['.then(ok, err) 的 err 只打印', rep1(GOOD, CATCH, '.then(() => {}, (e) => { console.error(e); })')],
        ['顶层命名函数入口 + catch 只打印', rep1(MAINS, CATCH, '.catch((e) => { console.error(e); })')],
    ];
    const catchOk = [
        ['catch 里 process.exit(1)（原样）', GOOD],
        ['catch 里 process.exitCode = 1', rep1(GOOD, CATCH, '.catch((e) => { console.error(e); process.exitCode = 1; })')],
        ['catch 里重新抛出', rep1(GOOD, CATCH, '.catch((e) => { console.error(e); throw e; })')],
        ['catch 是表达式体箭头 (e) => process.exit(2)', rep1(GOOD, CATCH, '.catch((e) => process.exit(2))')],
        ['catch 引用顶层命名函数（函数体里 process.exit(1)）', rep1(withDecl(GOOD, 'function report(e) { console.error(e); process.exit(1); }\n'), CATCH, '.catch(report)')],
        ['没有 .catch（ready 失败即未处理拒绝，Node 以非零退出）', rep1(GOOD, `.catch((e) => { console.error(e); process.exit(1); })`, '')],
        ['.then(ok, err) 的 err 以非零退出', rep1(GOOD, CATCH, '.then(() => {}, (e) => { console.error(e); process.exit(1); })')],
    ];
    const catchBadRes = catchBad.map(([label, src]) => ({ label, anchored: src !== null, v: src === null ? [] : verdict(src) }));
    const catchOkRes = catchOk.map(([label, src]) => ({ label, anchored: src !== null, v: src === null ? [{ rule: 'ANCHOR' }] : verdict(src) }));
    const unresolvedCatch = verdict(rep1(GOOD, CATCH, '.catch(handlers.onError)') || '');
    check('H.22', `D-1（主会话裁定方案 a）：入口调用链上的 .catch 回调必须以非零退出——${catchBad.map((c) => c[0]).join(' / ')} 都判红 R7；${catchOk.length} 个合法写法（含无 .catch）判绿；回调解析不到（handlers.onError）判红 R6；8 个已迁移脚本仍判绿（H.1）`,
        catchBadRes.every((r) => r.anchored && r.v.some((x) => x.rule === 'R7')) && catchOkRes.every((r) => r.anchored && r.v.length === 0) && unresolvedCatch.some((x) => x.rule === 'R6'), { catchBadRes: catchBadRes.filter((r) => !r.anchored || !r.v.some((x) => x.rule === 'R7')), catchOkRes: catchOkRes.filter((r) => !r.anchored || r.v.length), unresolvedCatch });

    // H.23：其余结构盲区——顶层同名函数声明、.verbose() 限定 sqlite3、ready() 实参纯度（MY1）、入口链实参纯度（MY2）
    const dupMain = rep1(MAINS, 'async function main() {', "async function main() {\n  await fetch('http://127.0.0.1:3100/first');\n  await fx.ready();\n}\nasync function main() {");
    const dupHelper = rep1(GOOD, "(async () => {\n  await fx.ready();", 'function aux() { return 1; }\nfunction aux() { return 2; }\n(async () => {\n  await fx.ready();');
    const funcVar = rep1(GOOD, "(async () => {\n  await fx.ready();", 'function aux() { return 1; }\nvar aux = 2;\n(async () => {\n  await fx.ready();');
    const distinct = rep1(GOOD, "(async () => {\n  await fx.ready();", 'function aux() { return 1; }\nfunction aux2() { return 2; }\n(async () => {\n  await fx.ready();');
    const verboseOther = rep1(GOOD, "const fx = require('./_test-fixture');\n", "const fx = require('./_test-fixture');\nconst v = require('./_test-fixture').verbose();\n");
    const verboseSqlite = rep1(GOOD, "const fx = require('./_test-fixture');\n", "const fx = require('./_test-fixture');\nconst sq = require('sqlite3').verbose();\n");
    const readyArgs = rep1(GOOD, 'await fx.ready();', 'await fx.ready(buildOpts());');
    const readyArgsDecl = (s) => (s === null ? null : rep1(s, "const fx = require('./_test-fixture');\n", "const fx = require('./_test-fixture');\nfunction buildOpts() { return {}; }\n"));
    const readyArgsPure = rep1(GOOD, 'await fx.ready();', "await fx.ready({ resources: ['uploads'] });");
    const chainArgs = rep1(GOOD, CATCH, '.catch(report(x))');
    const chainArgsDecl = chainArgs === null ? null : rep1(chainArgs, "const fx = require('./_test-fixture');\n", "const fx = require('./_test-fixture');\nconst x = 1;\nfunction report(v) { return (e) => { console.error(e, v); process.exit(1); }; }\n");
    const oneRule = (src, rule, re) => src !== null && verdict(src).some((x) => x.rule === rule && (!re || re.test(x.detail)));
    check('H.23a', '预筛 LOW-3b：顶层同名函数声明一律判红 R6——入口 main 声明了两次 / 辅助函数 aux 声明了两次 / 函数声明与顶层 var 同名；对照组：名字不同判绿',
        oneRule(dupMain, 'R6', /同名声明 main 出现 2 次/) && oneRule(dupHelper, 'R6', /同名声明 aux 出现 2 次/) && oneRule(funcVar, 'R6', /同名声明 aux 出现 2 次/) && distinct !== null && verdict(distinct).length === 0,
        { dupMain: dupMain && verdict(dupMain), dupHelper: dupHelper && verdict(dupHelper), funcVar: funcVar && verdict(funcVar), distinct: distinct && verdict(distinct) });
    check('H.23b', '预筛 LOW-3c：`.verbose()` 白名单限定模块名为 sqlite3——require(\'./_test-fixture\').verbose() 判红 R6（顶层不是纯初始值）；对照组：require(\'sqlite3\').verbose() 判绿',
        oneRule(verboseOther, 'R6', /模块顶层有可执行语句/) && verboseSqlite !== null && verdict(verboseSqlite).length === 0, { verboseOther: verboseOther && verdict(verboseOther), verboseSqlite: verboseSqlite && verdict(verboseSqlite) });
    check('H.23c', '预筛 MY1：ready() 的实参必须纯——`await fx.ready(buildOpts())` 判红 R6（含 ready() 但不是独立的 await ready() 语句）；对照组：`await fx.ready({ resources: [\'uploads\'] })` 判绿',
        oneRule(readyArgsDecl(readyArgs), 'R6', /含 ready\(\) 但不是独立/) && readyArgsPure !== null && verdict(readyArgsPure).length === 0, { readyArgs: readyArgsDecl(readyArgs) && verdict(readyArgsDecl(readyArgs)), readyArgsPure: readyArgsPure && verdict(readyArgsPure) });
    check('H.23d', '预筛 MY2：入口调用链上的实参必须纯——`(async () => {…})().catch(report(x))` 判红 R6（链上实参含有副作用）；对照组：`.catch(report)`（引用顶层命名函数）判绿（H.22）',
        oneRule(chainArgsDecl, 'R6', /链上实参含有副作用/), { chainArgs: chainArgsDecl && verdict(chainArgsDecl) });
}

// ================================================================ 节 R：最终删私有根的闸门接线（共享模块 evalDeleteGate 的九个条件由 S3c 的套件逐个覆盖；这里证明本套件的最外层以正确的方式用它）
async function sectionR() {
    console.log('\n== 节 R：回收与删除闸门接线 ==');
    // 局部回收器（登记文件 + 回收器）都是「局部登记来源」：开了就必须关（终检通过才关）；没关上 / 终检未通过 = 最外层闸门判不安全（13T-R2 H1）。本节在 finally 里统一关闭。
    const locals = [];
    const mkLocal = (tag) => {
        const f = path.join(PRIV, `r-${tag}.jsonl`);
        const prep = reapLib.initRegistry(f);
        const src = openLocalSource(`r-${tag}`);
        if (prep !== null) LOCAL_PROBLEMS.push(`r-${tag}：${prep}`);
        const l = { prep, src, reaper: reapLib.createReaper({ file: f, owner: `r-${tag}`, supervisorRegistry: null, recheckMs: 2000, childWaitMs: 2000 }) };
        locals.push(l);
        return l;
    };
    try {
    const mkRoot = (tag) => {
        const d = path.join(PRIV, `闸门 根 ${tag}`);   // 中文 + 空格
        fs.mkdirSync(path.join(d, '子 目录'), { recursive: true });
        fs.writeFileSync(path.join(d, '子 目录', 'x.txt'), tag);
        return d;
    };
    const gateOf = (reaper, reap, over) => reaper.finalGate(Object.assign({ pendingStarts: 0, pendingTimedOut: false, reap, reapErr: null, sweep: { kept: [], failed: [] } }, over || {}));
    const EMPTY_REAP = { total: 0, gone: [], forced: [], left: [], problems: [], timedOut: false };

    // R.1 / R.2：诱饵——一个回收之后才出现（回收时被 skip 掉）的登记进程，只有终检（新鲜读登记 + 逐项核身份）看得到；闸门必须判不安全、目录保留；诱饵被回收后才判安全并删除
    const a = mkLocal('a');
    const decoy = spawn(process.execPath, ['-e', 'setInterval(function(){},1000)'], { stdio: 'ignore', windowsHide: true });
    let r1 = null; let r2 = null;
    try {
        a.reaper.trackChild('r-decoy', decoy);
        // 诱饵同时登记到主回收器（13T-R2 H1）：局部回收器（下面 R.2 的 a.reaper.reapAll）万一没收掉它，最外层闸门的终检也看得到；登记写失败进 REAPER.failures → 最外层闸门判不安全
        REAPER.trackChild('r-decoy', decoy);
        check('R.5', '节 R 的诱饵同时登记到主回收器（登记文件里有 label=r-decoy、PID 一致、归属为套件）：局部回收失败时最外层闸门的终检仍看得到它', REAPER.collect().entries.some((e) => e.rec.label === 'r-decoy' && e.rec.pid === decoy.pid && e.rec.owner === 'suite'), REAPER.collect().entries.map((e) => `${e.rec.label}#${e.rec.pid}`));
        const rootA = mkRoot('a');
        const rpA = await a.reaper.reapAll({ deadlineMs: 8000, skip: (e) => e.rec.label === 'r-decoy' });
        const gA = gateOf(a.reaper, rpA);
        const delA = deleteRootIfSafe(rootA, gA);
        const decoyAlive = identityState(decoy.pid, procLib.getStartTime(decoy.pid)) === 'match';
        r1 = { rpTotal: rpA.total, gate: gA, deleted: delA.deleted, rootStill: fs.existsSync(path.join(rootA, '子 目录', 'x.txt')), decoyAlive, verifyBad: a.reaper.verifyAllGone().bad.map((b) => b.label) };
        check('R.1', '删除闸门拦下诱饵：登记里有一个回收漏掉的存活进程 → reapAll 没处理它（gone / forced / left 都空），但终检发现它仍存活 → finalGate 判不安全且原因里有「终检」→ deleteRootIfSafe 不删目录（里面的文件还在）',
            a.prep === null && rpA.gone.length === 0 && rpA.forced.length === 0 && rpA.left.length === 0 && gA.safe === false && gA.reasons.some((x) => /终检/.test(x)) && delA.deleted === false && delA.error === null && r1.rootStill && decoyAlive && r1.verifyBad.includes('r-decoy'), r1);
        if (SEAM === 'local-reap-fail') {
            // 接缝（节 S）：局部回收失败——不回收诱饵，finally 里也不杀它；局部来源 r-a 的终检因此过不了，来源保持打开（最外层闸门必须因此保留私有根）。诱饵由主回收器（句柄）在最外层回收
        } else {
            const rpA2 = await a.reaper.reapAll({ deadlineMs: 15000 });
            const gA2 = gateOf(a.reaper, rpA2);
            const delA2 = deleteRootIfSafe(rootA, gA2);
            r2 = { forced: rpA2.forced.map((x) => x.label), left: rpA2.left, gate: gA2, deleted: delA2.deleted, error: delA2.error, rootGone: !fs.existsSync(rootA) };
            check('R.2', '诱饵被回收（句柄终止、复核有退出证据）之后：finalGate 判安全 → deleteRootIfSafe 删除整个目录（含中文 + 空格的子目录）', rpA2.forced.length === 1 && rpA2.left.length === 0 && gA2.safe === true && delA2.deleted === true && r2.rootGone, r2);
        }
    } finally {
        // 抛错 / 断言中断时也要杀诱饵并等它真的退出（有界），不再只发 kill 就走：之后的局部来源终检与最外层终检都看退出证据
        if (SEAM !== 'local-reap-fail' && decoy.exitCode === null && decoy.signalCode === null) {
            try { decoy.kill(); } catch (_) { /* 句柄在手；主回收器与局部终检会再核 */ }
            await Promise.race([new Promise((r) => decoy.once('exit', r)), sleep(5000)]);
        }
    }

    // R.3：其余闸门输入各自单独不满足时，deleteRootIfSafe 都不动目录（对照：基线安全时才删）。表驱动，每行一个全新的目录
    const b = mkLocal('b');
    const flips = [
        ['待启动集合非空', { pendingStarts: 1 }], ['放弃的批跑没落定', { pendingTimedOut: true }],
        ['回收后仍有没有退出证据的条目', { reap: Object.assign({}, EMPTY_REAP, { left: [{ label: 'x', reason: 'no-start-time' }] }) }],
        ['回收超截止', { reap: Object.assign({}, EMPTY_REAP, { timedOut: true }) }], ['登记文件有读取失败 / 损坏行', { reap: Object.assign({}, EMPTY_REAP, { problems: ['登记文件第 3 行不是合法 JSON'] }) }],
        ['回收抛错', { reapErr: new Error('x') }], ['遗留清理有保留项', { sweep: { kept: [{ dir: 'd', reason: 'PROCESS_ALIVE(server)' }], failed: [] } }],
        ['遗留清理有失败项', { sweep: { kept: [], failed: [{ dir: 'd', error: 'e' }] } }], ['额外原因（登记写失败等）', { extra: ['登记写失败'] }],
    ];
    const kept = []; const wrongDelete = [];
    for (const [i, [name, over]] of flips.entries()) {
        const root = mkRoot(`b${i}`);
        const g = gateOf(b.reaper, over.reap || EMPTY_REAP, over);
        const d = deleteRootIfSafe(root, g);
        if (g.safe !== false || d.deleted !== false || !fs.existsSync(path.join(root, '子 目录', 'x.txt'))) wrongDelete.push({ name, safe: g.safe, deleted: d.deleted });
        else kept.push(name);
    }
    const rootBase = mkRoot('b-base');
    const gBase = gateOf(b.reaper, EMPTY_REAP);
    const dBase = deleteRootIfSafe(rootBase, gBase);
    check('R.3', `其余 ${flips.length} 个闸门输入（待启动集合非空 / 批跑未落定 / 回收有 left / 超截止 / 登记文件损坏 / 回收抛错 / 遗留清理有保留项或失败项 / 额外原因）各自单独不满足 → 目录保留；对照：全部满足 → 删除`,
        b.prep === null && wrongDelete.length === 0 && kept.length === flips.length && gBase.safe === true && dBase.deleted === true && !fs.existsSync(rootBase), { wrongDelete, kept: kept.length, gBase, dBase });

    // R.4：最外层收尾的结构——等待启动落定 → reapAll → finalGate → deleteRootIfSafe；整份套件里只有 deleteRootIfSafe 一处真正删目录树（不再有无条件的整根删除）
    const src = fs.readFileSync(process.argv[1], 'utf8').replace(/\r\n/g, '\n');   // 套件自身在线 worktree 里是 CRLF 检出（autocrlf）：下面 R.6 的多行锚点按 LF 写，先归一
    const iWait = src.search(/Promise\.allSettled\(\[\.\.\.PENDING_STARTS\]\)/g);
    const iReap = src.search(/await REAPER\.reapAll\(\{ deadlineMs: REAP_BOUND_MS/);
    const iGate = src.search(/REAPER\.finalGate\(/);
    const iDel = src.search(/deleteRootIfSafe\(PRIV, gate\)/);
    const treeDeletes = (src.match(/common\.deleteTreeNoFollow\(/g) || []).length;
    check('R.4', '最外层收尾的结构：等待未落定的启动 → 回收器 reapAll（有截止）→ 回收器 finalGate → 以 PRIV 和该闸门结果调用 deleteRootIfSafe，顺序正确；私有根整根删除的唯一出口是 deleteRootIfSafe（整份套件只有它里面一处 common.deleteTreeNoFollow；另有 3 处 removeDataRoot 删的是实例数据根，各以该实例的服务身份已消失为前提）',
        iWait > 0 && iReap > iWait && iGate > iReap && iDel > iGate && treeDeletes === 1 && (src.match(/ti\._internals\.removeDataRoot\(/g) || []).length === 3, { iWait, iReap, iGate, iDel, treeDeletes, removeDataRoot: (src.match(/ti\._internals\.removeDataRoot\(/g) || []).length });

    // R.6：节 T 的局部登记文件读取与并入走 withMergedRegistry（必经的 finally）——T 太慢，不能在子进程场景里重跑，所以这里查结构；withMergedRegistry 本身的行为由节 S 的 t-throw / t-corrupt 场景证明
    const tBody = /async function sectionT\(\) \{([\s\S]*?)\n\}\n/.exec(src);
    const wmBody = /async function withMergedRegistry\(label, file, body\) \{([\s\S]*?)\n\}\n/.exec(src);
    check('R.6', '节 T 的局部登记读取与并入走 withMergedRegistry（body 里跑完整个监督层场景）；withMergedRegistry 把 mergeLocalRegistry 放在 finally 里（中途抛错也并入，读取 problems 进最外层闸门）',
        !!tBody && /await withMergedRegistry\('t-sup', regFile, async \(\) => \{/.test(tBody[1]) && !/REAPER\.register\(/.test(tBody[1]) && !!wmBody && /\} finally \{ mergeLocalRegistry\(src, file\); \}/.test(wmBody[1]), { tBody: !!tBody, wmBody: wmBody && wmBody[1] });
    } finally {
        for (const l of locals) closeLocalSource(l.src, l.reaper);   // 局部来源统一在 finally 里关闭（终检通过才关上；诱饵没收掉 / 登记写失败 → 来源保持打开 + 持久问题 → 最外层闸门判不安全）
    }
}

// ================================================================ 节 T：监督层（入口启用 reap: true）：辅助进程起服务后被杀、套件被强杀
async function sectionT() {
    console.log('\n== 节 T：监督层回收（辅助进程起服务后被杀，套件随后被强杀）==');
    const TOUT = 30000;
    const regFile = path.join(PRIV, 't-sup.jsonl');
    const prep = reapLib.initRegistry(regFile);
    if (prep !== null) LOCAL_PROBLEMS.push(`t-sup：${prep}`);
    const pidFile = path.join(PRIV, 't-sup-pids.json');
    const vfile = path.join(PRIV, 't-sup-violations.jsonl');
    const env = Object.assign({}, helperEnv({}, vfile, 'standin'), { SDH_REAP_REGISTRY: regFile, STANDIN_REAP_LIB: REAP_PATH, STANDIN_PRELOAD: PRELOAD_PATH, STANDIN_HELPER: HELPER_JS, STANDIN_PATCH: DETACH_JS });
    // 局部登记文件的读取与并入放进必经的 finally（withMergedRegistry）：本节中途抛错 / 被打断也并入主回收器，读取 problems 进最外层闸门（13T-R2 H1）；T.* 断言在 body 里
    await withMergedRegistry('t-sup', regFile, async () => {
    const sup = spawn(process.execPath, [ENTRY_PATH, '--skip-selftest', `--test-suite=${STANDIN_JS}`, `--timeout-ms=${TOUT}`, '--kill-deadline-ms=15000', '--reap-deadline-ms=30000', `--pid-file=${pidFile}`], { cwd: PRIV, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    track('sup-t', sup);
    let out = '';
    sup.stdout.on('data', (c) => { out += c; });
    sup.stderr.on('data', (c) => { out += c; });
    const closed = new Promise((resolve) => { sup.once('close', () => resolve(true)); sup.once('error', () => resolve(true)); });
    const done = await Promise.race([closed, sleep(TOUT + 90000).then(() => false)]);
    if (!done) { try { sup.kill(); } catch (_) { /* 下面确认 */ } await Promise.race([closed, sleep(5000)]); }
    let ph = null;
    try { ph = JSON.parse(fs.readFileSync(pidFile, 'utf8')); } catch (_) { ph = null; }
    const svc = ph && ph.service && Number.isSafeInteger(ph.service.pid) ? ph.service : null;
    const stateAtExit = svc ? identityState(svc.pid, svc.start) : null;   // 监督进程退出时的状态，先于套件自己的任何善后
    const reapM = /SUPERVISOR_REAP：进程登记 (\d+) 条；套件结束后仍存活并被监督进程按身份终止 (\d+) 个(?:（PID ([\d,]+)）)?/.exec(out);
    const reapInfo = reapM ? { total: Number(reapM[1]), killed: Number(reapM[2]), pids: (reapM[3] || '').split(',').filter(Boolean).map(Number) } : null;
    const tRecs = reapLib.readRegistryFile(regFile).records;
    const instRec = svc ? tRecs.find((r) => r.kind === 'instance' && r.pid === svc.pid && r.startTime === svc.start) || null : null;
    check('T.0', '监督层夹具初始化完成（替身套件起了辅助进程、辅助进程的服务已登记并发出 hanging 信号、替身套件已杀掉辅助进程并写出服务身份）——与下面「按身份回收」分开报告', prep === null && !!svc && !!ph.helperPid, { prep, ph, out: out.slice(-400) });
    check('T.1', '辅助进程起服务后被杀、替身套件挂起并被独立监督进程超时强杀（退出码 2）：服务成了父进程已死的孤儿（进程树终止够不到），监督进程按登记文件的「PID + 精确创建时间」回收了它——SUPERVISOR_REAP 报告终止 ≥ 1 个且 PID 里有这个服务，监督进程退出时服务按身份已消失；登记里有预加载片段写的这个实例（数据根一致）',
        done && sup.exitCode === 2 && /SUPERVISOR_TIMEOUT/.test(out) && !!svc && ['dead', 'reused'].includes(stateAtExit) && !!reapInfo && reapInfo.total >= 2 && reapInfo.killed >= 1 && reapInfo.pids.includes(svc.pid) && !!instRec && instRec.dataDir === svc.dataDir,
        { code: sup.exitCode, stateAtExit, reap: reapInfo, instRec, svc, out: out.slice(-600) });
    const entrySrc = fs.readFileSync(ENTRY_PATH, 'utf8');
    check('T.2', '薄入口 verify-test-env.js 启用登记回收（reap: true），套件路径指向本套件', /require\('\.\/lines-test-supervisor\.js'\)/.test(entrySrc) && /main\(\{[^}]*verify-test-env-suite\.js[^}]*\}\)/.test(entrySrc) && /main\(\{[^}]*\breap:\s*true\b/.test(entrySrc), entrySrc.slice(-300));
    // 善后：被测机制失效时不留孤儿——按精确身份终止、确认消失后删数据根；再把这一轮的登记并入套件自己的回收器（最外层闸门也要覆盖）
    if (svc && stateAtExit === 'match') {
        try { procLib.killIfIdentity({ pid: svc.pid, start_time: svc.start }); } catch (_) { /* 最外层回收与终检会再报 */ }
        await sleep(500);
    }
    if (svc && svc.dataDir && lstatOrNull(svc.dataDir) !== null && gone(svc.pid, svc.start)) { try { ti._internals.removeDataRoot(svc.dataDir); } catch (_) { /* Z.4 会报 */ } }
    readViolations('standin-helper', vfile);   // 替身套件起的辅助进程的违规记录：登记写失败 / 记录文件损坏同样进最外层闸门
    });
}

// ================================================================ 节 S：最外层收尾的异常边界与闸门接线（13T-R2 H1 / H2 / M3，收口小批）
/**
 * 为什么用子进程：最外层闸门只在套件收尾时算一次，套件自己的断言是「全绿」才算过，没法在同一次运行里故意造一个不安全的局面再要求「私有根保留」。
 * 所以节 S 把本套件当子进程再跑一遍（process.argv[1]，带上本次运行的 --test-env= / --fixture= / --reap= / --preload= / --ti= / --entry= 接缝，变异副本因此也被同样地检验），
 * 带 --seam=<名字> 在最外层收尾前造一种「登记集合可能不完整 / 收尾自身出错」的局面，要求子进程：判不安全（Z.5 红是设计内的）、点名原因、保留私有根（路径存在）、汇总行照常输出。
 * 原因文字取自子进程 Z.5 的 JSON 细节里的 reasons 数组（不是整段输出：Z.5 的标题里也有同样的词）。子进程保留的私有根在本套件的私有根里面（TEMP 指向 PRIV/tmp），由最后的闸门一并删除。
 */
async function sectionS() {
    console.log('\n== 节 S：最外层收尾的异常边界与闸门接线（子套件进程 + 接缝）==');
    const passthrough = args.filter((a) => /^--(?:test-env|fixture|reap|preload|ti|entry)=/.test(a));
    const brokenTe = path.join(PRIV, 'broken-test-env.js');
    fs.writeFileSync(brokenTe, "'use strict';\nmodule.exports = {;\n");   // 语法错误：被测模块加载失败
    const brokenReap = path.join(PRIV, 'broken-test-reap.js');
    fs.writeFileSync(brokenReap, "'use strict';\nmodule.exports = {;\n");   // 语法错误：共享回收模块在模块顶层加载失败（早于 main()，只有 uncaughtException 边界能接住）
    const runChild = async (name, o) => {
        const childArgs = [process.argv[1], `--only=${o.only || 'NONE'}`, ...passthrough.filter((a) => !(o.testEnv && a.startsWith('--test-env=')) && !(o.reap && a.startsWith('--reap='))), ...(o.testEnv ? [`--test-env=${o.testEnv}`] : []), ...(o.reap ? [`--reap=${o.reap}`] : []), ...(o.seam ? [`--seam=${o.seam}`] : [])];
        const child = spawn(process.execPath, childArgs, { cwd: PRIV, env: Object.assign({}, process.env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        track(`s-${name}`, child);
        let out = '';
        child.stdout.on('data', (c) => { out += c; });
        child.stderr.on('data', (c) => { out += c; });
        const closed = new Promise((resolve) => { child.once('close', () => resolve(true)); child.once('error', () => resolve(true)); });
        const done = await Promise.race([closed, sleep(150000).then(() => false)]);
        if (!done) { try { child.kill(); } catch (_) { /* 下面有界等待 */ } await Promise.race([closed, sleep(5000)]); }
        const z5 = /CHECK Z\.5 FAIL[^\n]*\n\s+(\{[^\n]*\})/.exec(out);
        let reasons = null;
        try { reasons = z5 ? JSON.parse(z5[1]).reasons : null; } catch (_) { reasons = null; }
        const kept = /NOTE 现场保留：([^\r\n]+)/.exec(out);
        return { name, done, code: child.exitCode, out, reasons, kept: kept ? kept[1].trim() : null, summary: /verify-test-env PASS=(\d+) FAIL=(\d+)/.exec(out) };
    };
    const SCEN = [
        { id: 'S.1', seam: 'pending-never', title: '还有一个永不落定的启动（item 6：往 PENDING_STARTS 放一个永不落定的启动）→ 等待截止后「还有未落定的启动」与「放弃的批跑没有落定」两条原因都在，私有根保留', need: [/还有未落定的启动/, /放弃的批跑在等待截止内没有落定/], forbid: [] },
        { id: 'S.2', seam: 'pending-late-added', title: '等待结束之后才冒出一个永不落定的启动（pendingTimedOut 为假）→ 只有「还有未落定的启动」一条（证明最外层闸门的 pendingStarts 接的是 PENDING_STARTS.size），私有根保留', need: [/还有未落定的启动/], forbid: [/放弃的批跑在等待截止内没有落定/] },
        { id: 'S.3', seam: 'pending-timeout-only', title: '一个启动超过等待截止才落定（落定后集合为空）→ 只有「放弃的批跑没有落定」一条（证明 pendingTimedOut 接的是等待结果），私有根保留', need: [/放弃的批跑在等待截止内没有落定/], forbid: [/还有未落定的启动/] },
        { id: 'S.4', seam: 'local-reap-fail', only: 'R', title: '局部回收失败（节 R 的局部回收器没收掉诱饵）→ 局部登记来源 r-a 关不上，原因点名它，私有根保留', need: [/局部登记来源未关闭：.*r-a/], forbid: [] },
        { id: 'S.5', seam: 't-corrupt', title: '节 T 的局部登记文件末行损坏（没写完）→ 并入时读到 problems，进持久问题，私有根保留', need: [/局部登记来源有问题/, /末行没有换行结尾/], forbid: [] },
        { id: 'S.6', seam: 't-throw', title: '节 T 中途抛错（登记里已有一个无创建时间、无句柄的存活进程）→ finally 仍把登记并入主回收器（回收后该条目没有退出证据），且主流程异常本身也让闸门判不安全，私有根保留', need: [/套件主流程异常中断/, /登记进程回收后仍有没有退出证据的条目/], forbid: [] },
        { id: 'S.7', seam: 'helper-reg-fail', title: '辅助进程登记失败且 stop 失败（登记文件路径不存在 + 句柄 stop 被注入失败）→ 持久进闸门，私有根保留', need: [/辅助进程登记写失败 1 次/], forbid: [], extraOut: [/stop 被调用并失败 true/] },
        { id: 'S.8', seam: 'viol-corrupt', title: '辅助进程的违规记录文件里混进损坏的一行 → 解析失败进持久问题（不再整体降成「没有违规」），私有根保留', need: [/辅助进程违规记录文件读取 \/ 解析失败/], forbid: [] },
        { id: 'S.9', seam: 'tail-query-throw', title: '收尾阶段的文件查询抛错（列数据根目录 / 查数据根）→ 各阶段独立捕获累计成不安全原因，仍然停桩服务、终检、输出汇总行与保留路径', need: [/收尾阶段异常/], forbid: [] },
        { id: 'S.10', testEnv: brokenTe, title: '被测模块加载失败（语法错误）→ 报 Z.0（点名加载失败），仍走完整的收尾并输出汇总行，不留没人报告的目录：闸门判不安全、私有根保留并打印路径', need: [/套件主流程异常中断/], forbid: [], extraOut: [/被测模块加载失败/] },
        { id: 'S.11', reap: brokenReap, uncaught: true, title: '私有根建好之后、main() 之前的模块顶层加载失败（共享回收模块语法错误）→ 最外层 uncaughtException 边界接住：报 Z.0（初始化阶段异常）、打印并保留私有根、以非零退出，不留没人报告的目录', need: [], forbid: [], extraOut: [/CHECK Z\.0 FAIL 套件初始化阶段异常/] },
    ];
    const results = [];
    for (let i = 0; i < SCEN.length; i += 5) {
        const part = SCEN.slice(i, i + 5);
        results.push(...await Promise.all(part.map((s) => runChild(s.id, s))));
    }
    SCEN.forEach((s, i) => {
        const r = results[i];
        const text = r.reasons ? r.reasons.join('\n') : '';
        const keptExists = !!r.kept && lstatOrNull(r.kept) !== null;
        const ok = s.uncaught
            ? r.done && r.code === 1 && keptExists && (s.extraOut || []).every((re) => re.test(r.out))   // 初始化阶段异常：只有边界打印的 Z.0 与保留的路径，没有收尾、没有汇总行
            : r.done && !!r.summary && r.code === 1 && !!r.reasons && keptExists && s.need.every((re) => re.test(text)) && s.forbid.every((re) => !re.test(text)) && (s.extraOut || []).every((re) => re.test(r.out));
        check(s.id, s.title, ok, { done: r.done, code: r.code, summary: !!r.summary, reasons: r.reasons, kept: r.kept, keptExists, tail: r.out.slice(-500) });
    });
}

// 接缝场景的主体（只在 --seam=<名字> 时跑）：在最外层收尾之前造一种局面，节 S 的子进程据此验证闸门
async function sectionSeam() {
    console.log(`\n== 接缝场景：${SEAM} ==`);
    if (SEAM === 'helper-reg-fail') {
        const rf = await runHelper('regfail', { SDH_REAP_REGISTRY: path.join(PRIV, 'no-such-registry.jsonl') }, { preRequire: [STOPFAIL_JS], expectViolations: true, timeoutMs: 60000 });
        const sv = rf.lines.find((x) => x && x.svc);
        // 善后：服务没进任何登记（这正是这个反例），只能按 STOPFAIL_JS 打印的精确身份终止、确认消失后删数据根
        if (sv) {
            try { procLib.killIfIdentity({ pid: sv.svc.pid, start_time: sv.svc.startTime }); } catch (_) { /* 下面按是否消失判定 */ }
            await sleep(800);
            if (gone(sv.svc.pid, sv.svc.startTime)) removeRoots([{ kind: 'instance', dataDir: sv.svc.dataDir }]);
        }
        console.log(`NOTE helper-reg-fail：辅助进程退出码 ${rf.code}，违规 ${J(rf.violations.map((v) => v.kind))}，服务身份 ${sv ? `pid ${sv.svc.pid}` : '无'}，stop 被调用并失败 ${rf.lines.some((x) => x && x.stopCalled === true)}`);   // stop 被调用并失败：预加载片段在登记写失败后确实试过 stop()，而 stop() 被注入失败（S.7 要求）
    } else if (SEAM === 'viol-corrupt') {
        await runHelper('envdump', {}, { corruptViolations: true });
    } else if (SEAM === 't-corrupt' || SEAM === 't-throw') {
        const f = path.join(PRIV, 'seam-t.jsonl');
        const prep = reapLib.initRegistry(f);
        if (prep !== null) throw new Error(`接缝登记文件初始化失败：${prep}`);
        if (SEAM === 't-corrupt') {
            await withMergedRegistry('t-seam', f, async () => { fs.appendFileSync(f, '{"kind":"proc","pid":'); });   // 末行没写完（没有换行结尾）
        } else {
            const d = spawn(process.execPath, ['-e', 'setInterval(function(){},1000)'], { stdio: 'ignore', windowsHide: true });
            SEAM_PROCS.push(d);
            fs.appendFileSync(f, `${J({ kind: 'proc', pid: d.pid, startTime: null, label: 'seam-t-decoy', owner: 'seam' })}\n`);   // 局部登记里有一个存活进程：没有创建时间、主回收器手里也没有句柄
            await withMergedRegistry('t-seam', f, async () => { throw new Error('seam: 节 T 中途抛错'); });
        }
    }
}

// ================================================================ 主流程
async function main() {
    if (REGISTRY_INIT_ERROR) throw new Error(`回收登记文件初始化失败：${REGISTRY_INIT_ERROR}`);
    if (SEAM !== null && !SEAMS.includes(SEAM)) throw new Error(`未知接缝 --seam=${SEAM}（可用：${SEAMS.join(' / ')}）`);
    loadUnderTest();
    await buildSources();
    writeStubFiles();
    await startStub();
    if (want('A')) await sectionA();
    if (want('B')) await sectionB();
    if (want('C')) await sectionC();
    if (want('D')) await sectionD();
    if (want('E')) await sectionE();
    if (want('F')) await sectionF();
    if (want('G')) await sectionG();
    if (want('H')) await sectionH();
    if (want('R')) await sectionR();
    if (want('S')) await sectionS();
    if (SEAM !== null) await sectionSeam();
    if (want('T')) await sectionT();
}

(async () => {
    let bootError = null;
    try { await main(); } catch (e) { bootError = e; }
    if (bootError) check('Z.0', '套件主流程无异常', false, bootError && bootError.stack || String(bootError));
    // 守卫记录无论主流程是否中途异常都要核对（被测代码万一走到默认来源路径，守卫拦下后主流程会异常结束）
    const helperDb = HELPER_UNEXPECTED_VIOLATIONS.filter((v) => v.kind === 'db');
    const helperEnv2 = HELPER_UNEXPECTED_VIOLATIONS.filter((v) => v.kind === 'env');
    const helperReg = HELPER_UNEXPECTED_VIOLATIONS.filter((v) => v.kind === 'reg');
    check('Z.1', '套件进程与（非预期情形下的）辅助进程从未试图打开私有根之外的库（两层数据库路径守卫记录都为空）', GUARD_VIOLATIONS.length === 0 && helperDb.length === 0, { suite: GUARD_VIOLATIONS, helpers: helperDb });
    check('Z.2', '套件进程与（非预期情形下的）辅助进程从未试图读取私有根之外的 .env（两层 .env 读取守卫记录都为空）；登记没有写失败（回收器 failures 为空、辅助进程没有 reg 违规）', ENV_VIOLATIONS.length === 0 && helperEnv2.length === 0 && helperReg.length === 0 && REAPER.failures.length === 0,
        { suite: ENV_VIOLATIONS, helpers: helperEnv2, reg: helperReg, reaperFailures: REAPER.failures.map((e) => e.message) });
    // 最外层收尾（13T-R H2；收口小批 13T-R2 M3：各阶段独立捕获，错误累计成不安全原因，后面的阶段照常尝试）：
    //   等待未落定的启动 → reapAll（有截止；按句柄 / PID + 创建时间回收，登记文件 ∪ 内存）→ 确认消失的实例才删数据根 → 遗留清理 → finalGate（终检新鲜读登记、逐项核身份；额外输入见 gateExtraReasons）→ 判安全才删私有根，否则判红并保留现场
    TAIL_PHASE = true;
    const tailStage = async (label, fn, dflt) => { try { return await fn(); } catch (e) { TAIL_ERRORS.push(`${label}：${(e && e.message) || String(e)}`); return dflt; } };
    let pendingTimedOut = false;
    if (SEAM === 'pending-never') PENDING_STARTS.add(new Promise(() => {}));   // 接缝：一个永不落定的启动
    let lateStart = null;
    if (SEAM === 'pending-timeout-only') { lateStart = new Promise((r) => setTimeout(r, PENDING_WAIT_MS * 2)); PENDING_STARTS.add(lateStart); lateStart.then(() => PENDING_STARTS.delete(lateStart)); }   // 接缝：超过等待截止才落定的启动
    try {
        if (PENDING_STARTS.size > 0) {
            const r = await Promise.race([Promise.allSettled([...PENDING_STARTS]).then(() => 'settled'), sleep(PENDING_WAIT_MS).then(() => 'timeout')]);
            pendingTimedOut = r === 'timeout';
        }
    } catch (e) { pendingTimedOut = true; TAIL_ERRORS.push(`等待未落定的启动：${(e && e.message) || String(e)}`); }
    if (lateStart) await lateStart;   // 接缝 pending-timeout-only：等它落定（集合因此为空，只剩「等待超时」这一个原因）
    if (SEAM === 'pending-late-added') PENDING_STARTS.add(new Promise(() => {}));   // 接缝：等待结束之后才冒出来的、永不落定的启动（等待结果为「已落定」，只剩「集合非空」这一个原因）
    // --force-unsafe 接缝：造一个「回收之后才出现」的登记进程（回收时被跳过，只有终检能发现），闸门必须因此保留私有根（Z.6）
    let decoy = null;
    if (FORCE_UNSAFE) {
        try { decoy = spawn(process.execPath, ['-e', 'setInterval(function(){},1000)'], { stdio: 'ignore', windowsHide: true }); track('seam-decoy', decoy); } catch (e) { decoy = null; }
    }
    let reap = { total: 0, gone: [], forced: [], left: [], problems: [], timedOut: false };
    let reapErr = null;
    try { reap = await REAPER.reapAll({ deadlineMs: REAP_BOUND_MS, skip: (e) => e.rec.label === 'seam-decoy' }); } catch (e) { reapErr = e; }
    const ver = await tailStage('终检', () => REAPER.verifyAllGone(), { ok: false, bad: [], problems: ['终检没有执行 / 抛错'], total: 0 });   // 终检（不终止）：新鲜读登记 + 逐项核身份
    const rootsLeft = await tailStage('删除已确认消失的实例数据根', () => removeRoots(reap.gone), ['删除数据根的阶段抛错']);   // 确认消失的实例，数据根由套件删（失败计入 rootsLeft）
    await tailStage('重置被测模块状态', () => { if (te) te._internals.resetForTest(); }, null);
    await tailStage('停桩服务', () => stopStub(), null);
    const regNote = (arr) => arr.map((x) => `${x.label}(pid ${x.pid}${x.reason ? `, ${x.reason}` : ''})`);
    check('Z.3', `套件登记的全部进程（共 ${reap.total} 条：套件主进程里启动器交出的实例、辅助进程及其起的服务、监督层夹具，独立于 test-env 状态）在最外层回收之前都已有退出证据（句柄 exit 或身份 dead / reused）——没有一个需要被回收器强制终止（forced 空），回收后没有 left、没有超截止、登记文件没有损坏，终检（verify）覆盖 ${ver.total} 条且全部有退出证据`,
        reap.forced.length === 0 && reap.left.length === 0 && !reap.timedOut && reap.problems.length === 0 && !reapErr && !pendingTimedOut && ver.bad.filter((b) => b.label !== 'seam-decoy').length === 0 && ver.problems.length === 0,   // seam-decoy 是 --force-unsafe 接缝故意留给终检的（Z.5 / Z.6 负责），不算在 Z.3 头上
        { forced: regNote(reap.forced), left: regNote(reap.left), timedOut: reap.timedOut, problems: reap.problems, reapErr: reapErr && reapErr.message, pendingTimedOut, verifyBad: regNote(ver.bad), verifyProblems: ver.problems });
    const dirsLeft = await tailStage('列出遗留的 sdh-test-* 数据根', () => tmpInstanceDirs(), ['(列目录失败)']);
    check('Z.4', '私有临时根里没有遗留的 sdh-test-* 数据根（含回收器确认消失后套件删数据根时的失败）', dirsLeft.length === 0 && rootsLeft.length === 0, { dirs: dirsLeft, rootsLeft });
    const sweep = await tailStage('遗留清理（sweepStaleTestInstances）', () => ti.sweepStaleTestInstances({ tmpRoot: TMP }), { removed: [], kept: [{ dir: TMP, reason: 'SWEEP_ERROR 遗留清理阶段抛错' }], failed: [] });
    const gate = await tailStage('终检与删除闸门', () => REAPER.finalGate({ pendingStarts: PENDING_STARTS.size, pendingTimedOut, reap, reapErr, sweep, extra: gateExtraReasons(bootError) }), { safe: false, reasons: ['闸门计算阶段抛错（无法证明可以删除）'] });
    let kept = false;
    if (!gate.safe) {
        kept = true;
        const verifyBad = await tailStage('列出终检未通过的条目', () => regNote(REAPER.verifyAllGone().bad), ['(终检阶段抛错)']);
        check('Z.5', '私有临时根的删除闸门：登记进程未全部确认消失 / 还有未落定的启动 / 有保留项或登记写失败 / 局部登记来源未关闭 / 收尾阶段异常——不删私有根，保留现场供人工按身份核对', false,
            { priv: PRIV, reasons: gate.reasons, pendingStarts: PENDING_STARTS.size, left: regNote(reap.left), timedOut: reap.timedOut, problems: reap.problems, sweepKept: sweep.kept, sweepFailed: sweep.failed, verifyBad });
    } else {
        const del = deleteRootIfSafe(PRIV, gate);
        if (!del.deleted) { kept = true; check('Z.5', '私有临时根已清理', false, del.error); }
    }
    if (FORCE_UNSAFE) check('Z.6', '（变异自证接缝 --force-unsafe）一个回收之后才出现的登记进程（只有终检看得到）必须让闸门判不安全、私有根保留：私有根仍在磁盘上', kept && lstatOrNull(PRIV) !== null, { kept, priv: PRIV });
    for (const p of [decoy, ...SEAM_PROCS]) {   // 接缝自己的善后：句柄在手，按句柄终止
        if (!p) continue;
        try { p.kill(); } catch (_) { /* 有界等待 */ }
        await Promise.race([new Promise((r) => { if (p.exitCode !== null || p.signalCode !== null) r(); else p.once('exit', r); }), sleep(5000)]);
    }
    if (kept) console.log(`NOTE 现场保留：${PRIV}`);
    if (SCRUBBED_VARS.length) console.log(`NOTE 启动时清掉了宿主环境里的 ${SCRUBBED_VARS.length} 个测试变量（只记名字）：${SCRUBBED_VARS.join(', ')}`);
    console.log(`\nverify-test-env PASS=${pass} FAIL=${fail}`);
    if (SUMMARY_FILE) { try { fs.writeFileSync(SUMMARY_FILE, J({ pass, fail, results })); } catch (_) { /* 汇总文件写不了不影响退出码 */ } }
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    // 最外层收尾自己抛出（上面各阶段已独立捕获，走到这里说明捕获之外还有异常）：不再静默崩溃——报红、保留私有根、仍然输出汇总行，退出码非零
    try {
        check('Z.8', '最外层收尾自身无异常', false, (e && e.stack) || String(e));
        console.log(`NOTE 现场保留：${PRIV}`);
        console.log(`\nverify-test-env PASS=${pass} FAIL=${fail}`);
        if (SUMMARY_FILE) fs.writeFileSync(SUMMARY_FILE, J({ pass, fail, results }));
    } catch (_) { /* 无处可写：退出码仍是非零 */ }
    process.exit(1);
});
