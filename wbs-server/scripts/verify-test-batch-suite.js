/**
 * #106 S3c 套件：批跑核心 scripts/lib/test-batch.js + 通用入口 scripts/run-test-batch.js + run-verify-family.js 的接入 + 共享回收模块 scripts/lib/test-reap.js
 *
 * 由 verify-test-batch.js（薄入口）经共享监督进程 lines-test-supervisor.js 运行（启用登记回收与 detached 夹具自检）；也可直接 node 运行（无超时回收保护，仅调试用）。
 *
 * 安全约束（本套件自己的）：
 *   - 只用自建的合成来源库、合成资源根、桩服务（私有根里的 stub-server.js，只应答 /api/version、/api/health/ready 与几个控制路径）与桩成员脚本（member.js）；
 *     不读任何 .env、不打开任何 task_pool.db：套件进程与所有辅助进程在加载被测模块之前就装了同一个预加载文件 lib/test-reap-preload.js——
 *     sqlite3 路径守卫（只放行私有根内的库；`file:` URI 解析出真实路径再核，解析不了就拒绝）+ `.env` 读取守卫（readFileSync / readFile / promises.readFile / open 系，
 *     字符串 / Buffer / URL 路径）+ 启动器 startTestInstance 的立即登记（句柄一返回就追加写登记文件）。越界在真正打开 / 读取之前抛错并记录；
 *   - 套件进程把 TEMP / TMP 指向 PRIV/tmp：所有 sdh-test-* 数据根都落在私有根里；
 *   - 终止进程只终止自己用 spawn 起的子进程（句柄在手），或按「PID + 精确创建时间」核对后终止；
 *   - **回收只有一份**：lib/test-reap.js 的登记文件（私有根内追加写 JSONL，kind=instance|proc；同时镜像到监督进程的登记文件）。套件进程、辅助进程、桩成员、孙进程都往同一份里登记；
 *     最外层 reapAll 对每条要求明确的退出证据（句柄 exit 或身份 dead / reused），其余一律 left；**最终删私有根的闸门**（evalDeleteGate）还要新鲜读登记做终检，覆盖实例 / 辅助进程 / 成员 / 孙进程全部条目，
 *     任何一项没有退出证据就判红并保留现场（S3b 13T-R H2、S3c 14T H1 的教训）；
 *   - 私有根建好之后的一切（守卫安装、被测模块 require、来源构建、各节）都在同一个异常收尾里：任何一步抛错都不会绕过回收与闸门（14T M3）。
 *
 * 参数：--only=<节,节>（setup 总是跑；节名 A B C D E F G H I J K L N P Q R S T U）、--summary-file=<汇总 JSON 路径>、--hang-timeout-ms=<毫秒>（H 节挂起夹具的截止，默认 12000）。
 *   变异自证接缝（正常运行不传）：--batch=<被测 test-batch.js>、--family=<被测 run-verify-family.js>、--cli=<被测 run-test-batch.js>、--reap=<被测 test-reap.js>、
 *   --preload=<被测 test-reap-preload.js>、--entry=<被测 verify-test-batch.js 薄入口>、--force-unsafe（制造一个回收之后才出现的登记进程，闸门必须保留私有根）、
 *   --inject-fault=init|violations|lstat|gate|tail|sfixture（在初始化 / 最终流程 / S 节夹具的对应位置制造一次异常，证明收尾不被打断，修复批 2 · 14T-R M3 / M4）；
 *   收口小批第 6 项再加三个（都会先造出真实夹具进程，再在对应位置抛错，由外部驱动断言夹具进程都已退出）：pre-reap（正常回收之前抛错：violations() 返回了异常值）、
 *   drain（安全台账善后抛错，之后的回收仍要执行）、z6（配合 --force-unsafe：Z.6 的检查抛错，decoy 仍要在最外层 finally 里被终止）。
 * 输出：每条断言一行 `CHECK <编号> PASS|FAIL <标题>`；末行 `verify-test-batch PASS=<n> FAIL=<n>`。退出码 0 = 全绿。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const WBS = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const argVal = (p) => { const a = args.find((x) => x.startsWith(p)); return a ? a.slice(p.length) : null; };
const mono = () => performance.now();   // 单调时钟（耗时一律用它，不用 Date.now()）

// 受控挂起夹具（监督进程自检用）：分支必须在创建任何东西之前。
if (argVal('--hang-fixture=') !== null) {
    require('./lines-test-supervisor.js').runHangFixture(argVal('--hang-fixture='));
}
// 「中间启动器退出、detached 服务存活、套件同步挂起」夹具（监督进程的 detached 自检用）：启动器起一个 detached 服务后立即退出，服务用共享回收模块的 registerSelfFromEnv
// 登记自己（写监督进程的登记文件）并把 PID 写进 pid 文件，套件随即同步挂起。登记不上就在派生长寿子进程之前以 86 退出。必须在创建任何东西之前。
if (argVal('--detach-fixture=') !== null) {
    const pidFile = argVal('--detach-fixture=');
    const lib = path.join(__dirname, 'lib', 'test-reap.js');
    const serviceSrc = `const lib = require(${JSON.stringify(lib)}); try { lib.registerSelfFromEnv('detach-fixture-service', { owner: 'fixture' }); } catch (e) { console.error('SELF_REGISTER_FAILED: ' + e.message); process.exit(86); } require('fs').writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ service: process.pid })); setInterval(function () {}, 1000);`;
    const launcherSrc = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(serviceSrc)}], { detached: true, stdio: 'ignore', windowsHide: true }).unref();`;
    spawn(process.execPath, ['-e', launcherSrc], { stdio: 'ignore', windowsHide: true });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2147483647);
    process.exit(0);
}

const BATCH_PATH = argVal('--batch=') || path.join(__dirname, 'lib', 'test-batch.js');
const FAMILY_PATH = argVal('--family=') || path.join(__dirname, 'run-verify-family.js');
const CLI_PATH = argVal('--cli=') || path.join(__dirname, 'run-test-batch.js');
const REAP_PATH = argVal('--reap=') || path.join(__dirname, 'lib', 'test-reap.js');
const PRELOAD_PATH = argVal('--preload=') || path.join(__dirname, 'lib', 'test-reap-preload.js');
const ENTRY_PATH = argVal('--entry=') || path.join(__dirname, 'verify-test-batch.js');
const TI_PATH = path.join(__dirname, 'lib', 'test-instance.js');
const SUMMARY_FILE = argVal('--summary-file=');
const HANG_TIMEOUT_MS = Number(argVal('--hang-timeout-ms=') || 12000);   // 挂起夹具的截止：要给夹具初始化（取创建时间、起孙进程、登记）留足余量
const FORCE_UNSAFE = args.includes('--force-unsafe');   // 变异自证接缝（见最终删除闸门）；正常运行不传
/** 变异自证接缝：--inject-fault=init|violations|lstat|gate|tail|sfixture|pre-reap|drain|z6，在初始化 / 最终流程的对应位置制造一次异常，证明收尾不被打断（14T-R M3、14T-R2 M1）；正常运行不传 */
const INJECT_FAULT = argVal('--inject-fault=');
const ONLY = argVal('--only=') ? argVal('--only=').split(',').map((s) => s.trim()).filter(Boolean) : null;
const want = (sec) => ONLY === null || ONLY.includes(sec);

// ---------------------------------------------------------------- 私有临时根（必须最先做）
const REAL_TMP = os.tmpdir();
const PRIV = fs.mkdtempSync(path.join(REAL_TMP, 'sdh-tb-suite-'));   // 从这一行成功起，私有根存在：之后的一切（含下面的初始化）都在统一收尾保护之内（14T-R M3）
const TMP = path.join(PRIV, 'tmp');
const REGISTRY_FILE = path.join(PRIV, 'reap-registry.jsonl');
let INIT_ERROR = null;   // 私有根内的初始化（建 tmp、改 TEMP / TMP）抛错：不在这里崩，留给统一收尾记 Z.0、回收、过闸门
try {
    if (INJECT_FAULT === 'init') throw new Error('INJECTED_INIT_FAULT');
    fs.mkdirSync(TMP);
    process.env.TEMP = TMP;
    process.env.TMP = TMP;
} catch (e) { INIT_ERROR = e; }

// 宿主残留的变量组 / live 变量：清掉（不分大小写）。只记名字，不记值。
const TEST_VAR_RE = /^TEST_(?:INSTANCE|BASE_URL|DB_PATH|JWT_SECRET|TARGET|LIVE_URL)$/i;
const SCRUBBED_VARS = [];
for (const k of Object.keys(process.env)) { if (TEST_VAR_RE.test(k)) { SCRUBBED_VARS.push(k); delete process.env[k]; } }
// 桩成员需要的路径（不以 TEST_ 开头，不会被批跑器剔除）
process.env.STUB_PROC = path.resolve(WBS, '..', 'scripts', 'lines', 'line-proc.js');
process.env.STUB_REAP_LIB = REAP_PATH;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fold = (p) => String(p).toLowerCase();
const J = (v) => JSON.stringify(v);

// ---------------------------------------------------------------- 被测模块与守卫：私有根建好之后才加载，全部在 boot() 里（抛错进统一收尾，不绕过回收与闸门）
let sqlite3 = null;
let common = null;
let procLib = null;
let instanceDb = null;
let ti = null;
let batch = null;
let reapLib = null;
let PRE = null;       // 预加载片段的 API（守卫违规记录、reaper）
let REAPER = null;    // 本套件唯一的回收器（登记文件在 PRIV 内）

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

// ---------------------------------------------------------------- 独立安全台账（不依赖被测回收器；14T-R H2）
// 凡是「只交给被测回收器 / 被测代码处置」的真实进程（R.7 的 idle 进程等），spawn 之后先在这里留一份原始 ChildProcess。被测代码自己出错（漏登记、没终止、抛错）时，
// 由这里按句柄有界终止并等退出；善后失败（进程仍在）记入 SAFETY_FAILS，挡住删除私有根（最终闸门的 extra），并打印 ORPHAN_ALIVE 行供人工按身份核对。
const SAFETY = [];          // { label, child, start }
const SAFETY_FAILS = [];    // 善后失败的描述
const SAFETY_ATTEMPTED = []; // 确认仍活着、套件对它调用了终止的（尝试终止；不含「身份已确认消失、只是 exit 事件还没派发」的）
const SAFETY_REAPED = [];   // 确认仍活着、由安全台账终止并确认退出的（被测代码没收干净）：R.2c / R.7 的「安全台账没有出手」断言用它
const SAFETY_EXIT_WAIT_MS = 1500;   // 先有界等待原始句柄的退出通知
const FLOW_ERRORS = [];     // 收尾流程里任何步骤抛出的异常（文字）：非空 = 锁定删除闸门为不安全（保留现场）
const lockFlow = (what, e) => { FLOW_ERRORS.push(`${what}：${e && e.message ? e.message : String(e)}`); };
const DECOYS = [];          // 接缝 decoy 的独立台账（spawn 后立即入账，最外层 finally 按句柄有界终止）
const SEAM_PROCS = [];      // 接缝造出的全部真实夹具进程 { label, child, start }：退出前由 seamAtExit 按身份打印状态，外部驱动据此断言「都已退出」（Windows 上非 detached 子进程会随父进程退出连带结束，所以不能事后再查）
const OUTSIDE_FAILS = [];   // 私有根之外夹具（S 节的联接目标目录等）善后失败的具体路径：挡住删除私有根
const describeFsErr = (e) => `${e && e.code ? `${e.code}: ` : ''}${e && e.message ? e.message : String(e)}`;
const childRunning = (c) => !!c && c.exitCode === null && c.signalCode === null;
function waitExitBounded(child, ms) {
    if (!childRunning(child)) return Promise.resolve(true);
    return new Promise((resolve) => {
        let t = null;
        const done = (v) => { clearTimeout(t); resolve(v); };
        t = setTimeout(() => done(!childRunning(child)), ms);
        child.once('exit', () => done(true));
    });
}
function safetyAdd(label, child) {
    let start = null;
    try { if (procLib && child && Number.isSafeInteger(child.pid)) start = procLib.getStartTime(child.pid); } catch (_) { start = null; }
    SAFETY.push({ label, child, start });
}
/**
 * 有界终止台账里「确认仍活着」的进程（only = 只处理这个 label）；返回本次由台账终止并确认退出的 label 列表。终止后仍在 → SAFETY_FAILS。
 * 判定顺序（收口小批第 7 项 / 14T-R2 M2）：① 句柄已退出 → 跳过；② **先有界等待原始句柄的退出通知**——被测回收器凭身份 dead / reused 判成功时，进程在操作系统里已经不在，
 * 但 Node 的 exit 事件可能要到下一轮事件循环才派发，此刻 exitCode 仍是 null，不能凭它就记「代收」；③ 通知没来：用**独立保存的创建时间**核身份，已确认消失（dead / reused）→ 不记代收、不终止；
 * ④ 确认仍活着（身份 match，或无法核身份而 Node 认为句柄仍在运行——PID 被句柄钉住）才终止：先记「尝试终止」（SAFETY_ATTEMPTED），退出确认后才记「由台账收掉」（SAFETY_REAPED）。
 */
async function safetyDrain(only) {
    const reaped = [];
    for (const s of SAFETY) {
        if (only !== undefined && s.label !== only) continue;
        if (!childRunning(s.child)) continue;
        if (await waitExitBounded(s.child, SAFETY_EXIT_WAIT_MS)) continue;   // 退出通知到了：被测代码已经收干净
        const st = s.start && procLib ? identityState(s.child.pid, s.start) : 'no-start';
        if (st === 'dead' || st === 'reused') { await waitExitBounded(s.child, SAFETY_EXIT_WAIT_MS); continue; }   // 身份已确认消失（只是 exit 事件还没派发）：不是代收
        SAFETY_ATTEMPTED.push(s.label);
        try { s.child.kill(); } catch (_) { /* 下面按是否退出判定 */ }
        let ok = await waitExitBounded(s.child, 5000);
        if (!ok && s.start && procLib) {
            try { procLib.killIfIdentity({ pid: s.child.pid, start_time: s.start }); } catch (_) { /* 下面按是否退出判定 */ }
            ok = await waitExitBounded(s.child, 5000);
        }
        if (ok) { reaped.push(s.label); SAFETY_REAPED.push(s.label); } else {
            SAFETY_FAILS.push(`${s.label} pid ${s.child.pid} 终止后仍存活`);
            console.log(`ORPHAN_ALIVE pid=${s.child.pid} start=${s.start}`);
        }
    }
    return reaped;
}

// ---------------------------------------------------------------- sqlite 助手（只用于套件自建的库；经守卫过的 sqlite3.Database）
function dbOpen(file) { return new Promise((res, rej) => { const d = new sqlite3.Database(file, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (e) => (e ? rej(e) : res(d))); }); }
function dbExec(d, sql) { return new Promise((res, rej) => d.exec(sql, (e) => (e ? rej(e) : res()))); }
function dbClose(d) { return new Promise((res) => d.close(() => res())); }
async function withDb(file, fn) { const d = await dbOpen(file); try { return await fn(d); } finally { await dbClose(d); } }

const lstatOrNull = (p) => { try { return fs.lstatSync(p); } catch (e) { if (e && e.code === 'ENOENT') return null; throw e; } };
const tmpInstanceDirs = () => { try { return fs.readdirSync(TMP).filter((n) => /^sdh-test-/.test(n)).sort(); } catch (e) { if (e && e.code === 'ENOENT') return []; throw e; } };   // TMP 都没建起来（初始化失败）= 没有数据根
const identityState = (pid, start) => { try { return procLib.checkIdentity({ pid, start_time: start }).state; } catch (e) { return `ERR ${e && e.code}`; } };
const gone = (pid, start) => ['dead', 'reused'].includes(identityState(pid, start));
function readJsonl(file) {
    try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; }
}
async function waitFor(fn, ms, stepMs) {
    const end = mono() + ms;
    for (;;) {
        let v = null;
        try { v = fn(); } catch (_) { v = null; }
        if (v) return v;
        if (mono() >= end) return null;
        await sleep(stepMs || 200);
    }
}

// ---------------------------------------------------------------- 登记（共享回收模块 lib/test-reap.js；预加载片段已让启动器每交出一个句柄就写登记文件）
/** 套件自己 spawn 的辅助进程：返回前立即登记（PID + 精确创建时间 + 归属）；取不到创建时间也登记（退出证据只能来自句柄），登记写失败抛错 */
function track(label, child, owner) { return REAPER.trackChild(label, child, owner ? { owner } : undefined); }
/** 登记表里按条件取记录（登记文件 ∪ 内存，新鲜读） */
function regRecords(pred) { return REAPER.collect().entries.map((e) => e.rec).filter(pred || (() => true)); }

// 套件主进程里启动器交出的服务：场景断言用的视图（带真实 stop）；回收与闸门以登记文件为准，不依赖这个数组
const REG = [];   // { label, pid, start, dataDir, instance, stop }
function registerHandle(label, h) {
    if (!h || !Number.isSafeInteger(h.pid)) return;
    const start = h.startTime || null;
    if (REG.some((r) => r.pid === h.pid && r.start === start)) return;
    REG.push({ label, pid: h.pid, start, dataDir: h.dataDir || null, instance: h.instance || null, stop: typeof h.stop === 'function' ? h.stop.bind(h) : null });
}
const PENDING_STARTS = new Set();     // 还没落定的启动
const PENDING_BATCHES = new Set();    // 套件等不及而放弃的批跑（可能仍在后台跑）
const START_CALLS = [];               // 启动器每次被调用的记录（资源与来源）
const INJECT = { failStopOnce: false };
/** 套件自己的启动器包装（记录调用、待启动集合、注入停止失败）。必须先于 require(BATCH_PATH) 安装（14T 建议）；它包在预加载片段的登记包装外面，所以登记在句柄返回给调用方之前就已经写了 */
function installSuiteStartWrapper() {
    const origStart = ti.startTestInstance;
    ti.startTestInstance = function suiteStart(...a) {
        START_CALLS.push({ resources: a[0] && a[0].resources ? a[0].resources.slice() : null, sourceDbPath: a[0] && a[0].sourceDbPath });
        const p = (async () => {
            const h = await origStart.apply(this, a);
            registerHandle('batch', h);
            if (INJECT.failStopOnce) {
                INJECT.failStopOnce = false;
                h.stop = () => Promise.reject(new Error('INJECTED_STOP_FAILURE'));   // 登记里存的是替换前的真实 stop，供套件事后收口
            }
            return h;
        })();
        PENDING_STARTS.add(p);
        p.then(() => PENDING_STARTS.delete(p), () => PENDING_STARTS.delete(p));
        return p;
    };
}
const REAP_BOUND_MS = 60000;
/** 一批登记项是否全部「进程按身份消失 + 数据根已删」；返回 { ok, bad: [...] } */
function cleanOf(regs) {
    const bad = [];
    for (const r of regs) {
        const st = r.start ? identityState(r.pid, r.start) : 'no-start';
        if (!['dead', 'reused'].includes(st)) bad.push(`${r.label}#${r.instance}: 进程 ${r.pid} ${st}`);
        if (r.dataDir && lstatOrNull(r.dataDir) !== null) bad.push(`${r.label}#${r.instance}: 数据根仍在 ${r.dataDir}`);
    }
    return { ok: bad.length === 0, bad };
}
const SCN_ALL = [];   // 所有场景的登记（I.0 汇总核对）


// ---------------------------------------------------------------- 引导：私有根建好之后的一切加载都在这里（抛错进统一收尾）
async function boot() {
    reapLib = require(REAP_PATH);
    const prep = reapLib.initRegistry(REGISTRY_FILE);
    if (prep) throw new Error(`登记文件初始化失败：${prep}`);
    Object.assign(process.env, { SDH_REAP_PRIV: PRIV, SDH_REAP_REGISTRY: REGISTRY_FILE, SDH_REAP_OWNER: 'suite', SDH_REAP_TI: TI_PATH, SDH_REAP_LIB: REAP_PATH });
    delete process.env.SDH_REAP_VIOLATIONS;
    // 守卫 + 启动器立即登记：在加载任何被测模块之前（预加载片段与辅助进程 --require 的是同一个文件）
    PRE = require(PRELOAD_PATH);
    REAPER = PRE.reaper;
    sqlite3 = require('sqlite3');
    process.env.PROBE_SQLITE3 = require.resolve('sqlite3');
    common = require('../../scripts/lines/line-common');
    procLib = require('../../scripts/lines/line-proc');
    instanceDb = require('../utils/instance-db');
    ti = require(TI_PATH);
    installSuiteStartWrapper();   // 先于 require(BATCH_PATH)：被测模块即使提前捕获了启动器函数引用，也已经是登记过的版本
    batch = require(BATCH_PATH);
}

// ---------------------------------------------------------------- 合成夹具：来源库 / 资源根 / 桩服务 / 桩成员
const SRC_DIR = path.join(PRIV, '来源 目录');
const SRC = path.join(SRC_DIR, 'src.db');
const SRC_GHOST = path.join(SRC_DIR, 'src-ghost.db');
const RES_ROOT = path.join(PRIV, '资源 根');
const OUT_DIR = path.join(PRIV, 'out');
const STUB_JS = path.join(PRIV, 'stub-server.js');
const MEMBER_JS = path.join(PRIV, 'member.js');
const HELPER_JS = path.join(PRIV, 'batch-helper.js');
const PROBE_JS = path.join(PRIV, 'guard-probe.js');
const REAPFAST_JS = path.join(PRIV, 'reap-fast-helper.js');
const STUB_TI_JS = path.join(PRIV, 'stub-ti.js');
const REGFAIL_JS = path.join(PRIV, 'reg-fail-driver.js');
const STANDIN_JS = path.join(PRIV, 'sup-standin.js');
const ENVDEF_JS = path.join(PRIV, 'env-default-probe.js');
const SCRIPTS_DIR = path.join(PRIV, 'scripts');
let SRC_SHA = null;

async function buildSources() {
    for (const d of [SRC_DIR, OUT_DIR, SCRIPTS_DIR]) fs.mkdirSync(d, { recursive: true });
    for (const [rel, text] of [['uploads/a.txt', 'A'], ['archive/b.txt', 'B'], ['private/p.txt', 'P'], ['periodic-results/r.txt', 'R'], ['routes/it-ledger/uploads/it-reconcile/c.txt', 'C']]) {
        const f = path.join(RES_ROOT, ...rel.split('/'));
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, text);
    }
    const mkSrc = async (file, ghost) => withDb(file, async (d) => {
        await dbExec(d, instanceDb.SYSTEM_CONFIGS_DDL);
        await dbExec(d, "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, display_name TEXT, role TEXT DEFAULT 'user', status TEXT DEFAULT 'active')");
        await dbExec(d, "INSERT INTO users (username, password, display_name, role) VALUES ('tb-admin', 'x', '管理员 甲', 'admin')");
        if (ghost) {
            // 引用 uploads 目录里并不存在的文件：启动器开始前的资源引用存在性检查应报告 1 条缺失
            await dbExec(d, 'CREATE TABLE task_attachments (id INTEGER PRIMARY KEY, file_name TEXT)');
            await dbExec(d, "INSERT INTO task_attachments (id, file_name) VALUES (1, 'ghost.bin'), (2, 'a.txt')");
        }
    });
    await mkSrc(SRC, false);
    await mkSrc(SRC_GHOST, true);
    SRC_SHA = sha256(fs.readFileSync(SRC));
}

function writeStubFiles() {
    // 桩服务：应答 /api/version、/api/health/ready；/__die 让进程自己退出（模拟成员把实例弄死）；
    //   /__set?instance=&mode= 让之后的 /api/version 返回别的身份 / 模式（进程继续监听）；/__script?seq=fail,fail,ok 让接下来的 /api/version 请求依次「断开连接 / 正常」（模拟暂时失败后恢复）。
    fs.writeFileSync(STUB_JS, String.raw`'use strict';
const http = require('http');
const port = Number(process.env.PORT);
const instance = process.env.SDH_INSTANCE;
const ov = { instance: null, mode: null };
let seq = [];
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://stub');
  res.setHeader('Content-Type', 'application/json');
  if (u.pathname === '/api/version') {
    const step = seq.length ? seq.shift() : 'ok';
    if (step === 'fail') { req.socket.destroy(); return; }
    return res.end(JSON.stringify({ version: 'stub', mode: ov.mode || 'isolated', instance: ov.instance || instance }));
  }
  if (u.pathname === '/api/health/ready') return res.end(JSON.stringify({ ok: true, instance, mode: 'isolated', modules: { core: { ready: true, code: null } } }));
  if (u.pathname === '/__die') { res.end(JSON.stringify({ bye: true })); setTimeout(() => process.exit(0), 50); return; }
  if (u.pathname === '/__set') { ov.instance = u.searchParams.get('instance'); ov.mode = u.searchParams.get('mode'); return res.end(JSON.stringify({ set: true })); }
  if (u.pathname === '/__script') { seq = (u.searchParams.get('seq') || '').split(',').filter(Boolean); return res.end(JSON.stringify({ seq })); }
  res.end(JSON.stringify({ path: req.url, instance }));
}).listen(port, '127.0.0.1');
`);
    // 桩成员：按模式运行。第一行输出 STUB_OUTPUT <模式>（失败时批跑器要把输出带出来）；fail 模式同时往 stderr 写 STUB_STDERR 标记；
    //   每次运行把快照（环境里的 TEST_* 名与值、数据根列表、服务应答的身份）追加写到 argv[3]（'-' = 不写）。
    //   进程类模式（hang / orphan / hold-pipes / idle-reg）先建孙进程、先登记（自己用 registerSelfFromEnv，孙进程在自己的第一步登记自己），再做别的事。
    fs.writeFileSync(MEMBER_JS, String.raw`'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const mode = process.argv[2] || process.env.STUB_MODE || 'report';
const out = process.argv[3] && process.argv[3] !== '-' ? process.argv[3] : (process.env.STUB_OUT || null);
const extra = process.argv.slice(4);
console.log('STUB_OUTPUT ' + mode);
if (mode === 'fail') console.error('STUB_STDERR ' + mode);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function get(port, urlPath) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, agent: false, timeout: 3000 }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) { j = null; } resolve({ status: res.statusCode, json: j }); });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
    req.on('timeout', () => req.destroy());
  });
}
const portOf = () => { const m = /:(\d+)$/.exec(process.env.TEST_BASE_URL || ''); return m ? Number(m[1]) : null; };
function registerSelf(label) {
  try { return require(process.env.STUB_REAP_LIB).registerSelfFromEnv(label); } catch (e) { console.error('SELF_REGISTER_FAILED: ' + e.message); process.exit(86); }
}
async function snapshot() {
  const testEnv = {};
  for (const k of Object.keys(process.env)) { if (/^TEST_/i.test(k)) testEnv[k] = process.env[k]; }
  const rec = { mode, pid: process.pid, cwd: process.cwd(), argv: process.argv.slice(2), testEnv, hasPath: Object.keys(process.env).some((k) => k.toUpperCase() === 'PATH') };
  const dbp = process.env.TEST_DB_PATH || null;
  if (dbp) {
    const dir = path.dirname(dbp);
    rec.dataDir = dir;
    try { rec.dataDirEntries = fs.readdirSync(dir).sort(); } catch (e) { rec.dataDirEntries = null; }
    try { rec.uploadsFiles = fs.readdirSync(path.join(dir, 'uploads')).sort(); } catch (e) { rec.uploadsFiles = null; }
  }
  const port = portOf();
  if (port) { const r = await get(port, '/api/version'); rec.versionStatus = r.status; rec.versionInstance = r.json ? r.json.instance : null; }
  return rec;
}
// 孙进程先建、先登记：孙进程在自己的第一步登记自己（idle-reg），成员等它出现在登记文件里再继续（有界）
async function spawnRegisteredGrandchild(labelBase, o) {
  const lib = require(process.env.STUB_REAP_LIB);
  const regFile = process.env.SDH_REAP_REGISTRY;
  // 只认 spawn 之后追加、label 对得上的记录：登记文件整份套件累积，PID 会被复用，只按 PID 找可能拿到早已退出的同 PID 旧记录（startTime 可能为 null）
  const seen = lib.readRegistryFile(regFile).records.length;
  const g = spawn(process.execPath, [__filename, 'idle-reg', '-', labelBase + ':grandchild'], { stdio: o.stdio, windowsHide: true, detached: o.detached });
  if (o.detached) g.unref();
  const end = Date.now() + 25000;
  let rec = null;
  while (Date.now() < end) {
    const r = lib.readRegistryFile(regFile);
    rec = r.records.slice(seen).find((x) => x.pid === g.pid && x.label === labelBase + ':grandchild') || null;
    if (rec) break;
    await sleep(100);
  }
  return { g, rec };
}
(async () => {
  if (mode === 'idle') { setInterval(() => {}, 1000); return; }
  if (mode === 'idle-reg') { registerSelf(extra[0] || 'idle-reg'); setInterval(() => {}, 1000); return; }
  if (mode === 'hang' || mode === 'orphan') {
    // extra = [就绪文件, 'detached'|'attached', 标签前缀]：先建孙进程（默认 detached：不在成员的作业对象里，只杀成员自己时它会幸存）、先登记，再写就绪文件；
    //   hang = 之后挂住等被杀；orphan = 写完就绪文件立即退出（孙进程成了孤儿）
    const labelBase = extra[2] || 'stub';
    const { g, rec } = await spawnRegisteredGrandchild(labelBase, { stdio: 'ignore', detached: extra[1] !== 'attached' });
    const me = registerSelf(labelBase + ':member');
    fs.writeFileSync(extra[0], JSON.stringify({ pid: process.pid, start: me.startTime, gpid: g.pid, gstart: rec ? rec.startTime : null, ready: !!rec }));
    if (mode === 'orphan') return;
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === 'hold-pipes') {
    // 起一个继承了本成员 stdout / stderr 管道的 detached 孙进程，登记后写就绪文件（含退出时刻）并正常退出 0：管道被孙进程占着
    const labelBase = extra[2] || 'stub';
    const { g, rec } = await spawnRegisteredGrandchild(labelBase, { stdio: 'inherit', detached: true });
    const me = registerSelf(labelBase + ':member');
    fs.writeFileSync(extra[0], JSON.stringify({ pid: process.pid, start: me.startTime, gpid: g.pid, gstart: rec ? rec.startTime : null, ready: !!rec, exitAt: Date.now() }));
    return;
  }
  if (mode === 'kill-from-report') {
    // 不需服务的成员：从另一个成员的报告文件里读出服务端口，把那个实例弄死（模拟实例在两个成员之间被别的东西弄死）
    const rec = JSON.parse(fs.readFileSync(extra[0], 'utf8').split(/\r?\n/).filter(Boolean)[0]);
    const m = /:(\d+)$/.exec(rec.testEnv.TEST_BASE_URL || '');
    const port = m ? Number(m[1]) : null;
    await get(port, '/__die');
    for (let i = 0; i < 50; i += 1) { const r = await get(port, '/api/version'); if (r.status === 0) break; await sleep(200); }
    return;
  }
  const rec = await snapshot();
  if (out) fs.appendFileSync(out, JSON.stringify(rec) + '\n');
  if (mode === 'report') return;
  if (mode === 'fail') process.exit(1);
  if (mode === 'exit') process.exit(Number(extra[0] || 0));
  if (mode === 'sleep') { await sleep(Number(extra[0] || 1000)); return; }
  if (mode === 'kill-instance') {
    const port = portOf();
    await get(port, '/__die');
    for (let i = 0; i < 50; i += 1) { const r = await get(port, '/api/version'); if (r.status === 0) break; await sleep(200); }
    return;
  }
  if (mode === 'spoof') { await get(portOf(), '/__set?' + (extra[0] === 'mode' ? 'mode=shared' : 'instance=spoofed-instance')); return; }
  if (mode === 'flaky') { await get(portOf(), '/__script?seq=' + extra[0]); return; }
  if (mode === 'flood') {
    // 输出超过 64MB 上限（同步批跑的 spawnSync 会 ENOBUFS）
    const chunk = Buffer.alloc(1024 * 1024, 65);
    for (let i = 0; i < Number(extra[0] || 70); i += 1) { try { fs.writeSync(1, chunk); } catch (e) { if (e && e.code === 'EAGAIN') { i -= 1; continue; } break; } }
    return;
  }
})();
`);
    // FAMILY 自检用的桩守卫脚本（run-verify-family 的守卫按 scripts/<名字>.js 在 cwd 下找）
    fs.writeFileSync(path.join(SCRIPTS_DIR, 'J-g1.js'), "'use strict';\nconsole.log('GUARD_STUB_OK');\n");
    fs.writeFileSync(path.join(SCRIPTS_DIR, 'J-g2.js'), "'use strict';\nconsole.log('GUARD_STUB_RED_OUTPUT');\nprocess.exit(3);\n");
    // 辅助进程：在装了预加载片段的进程里跑一份成员表，结果完成时打印 HELPER_DONE <json> 后**自然结束**（不调 process.exit）。
    //   argv[2] = 被测 test-batch.js，argv[3] = JSON 文件 { members, instanceOptions, cwd, defaultTimeoutMs }
    fs.writeFileSync(HELPER_JS, String.raw`'use strict';
const fs = require('fs');
const { performance } = require('perf_hooks');
// 同进程单调计时（14T-R M6）：在加载批跑核心之前包住 child_process.spawn（批跑核心加载时解构的就是包装后的版本），记下每个成员子进程的 exit 时刻；
// onResult 回调记下该成员收尾完成的时刻——「成员退出 → onResult」就是管道宽限（加存活核对），与实例收尾（onResult → 全部结束）分开。
const cp = require('child_process');
const realSpawn = cp.spawn;
const memberExits = [];
cp.spawn = function patchedSpawn(...a) {
  const c = realSpawn.apply(this, a);
  c.once('exit', () => { memberExits.push(performance.now()); });
  return c;
};
const batch = require(process.argv[2]);
const cfg = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const t0 = performance.now();
const onResultAt = [];
batch.runBatch(cfg.members, { instanceOptions: cfg.instanceOptions, cwd: cfg.cwd, defaultTimeoutMs: cfg.defaultTimeoutMs, log: () => {}, onResult: () => { onResultAt.push(performance.now()); } }).then((r) => {
  const tEnd = performance.now();
  const graceMs = memberExits.length && onResultAt.length ? Math.round(onResultAt[0] - memberExits[0]) : null;
  const finishMs = onResultAt.length ? Math.round(tEnd - onResultAt[onResultAt.length - 1]) : null;
  const rec = { doneAt: Date.now(), ms: Math.round(tEnd - t0), graceMs, finishMs, ok: r.ok, results: r.results.map((x) => ({ label: x.label, ok: x.ok, timedOut: x.timedOut, ms: x.ms, notes: x.notes })), errors: r.errors };
  process.stdout.write('HELPER_DONE ' + JSON.stringify(rec) + '\n');
}, (e) => { process.stdout.write('HELPER_ERROR ' + JSON.stringify({ message: String(e && e.message), code: e && e.code }) + '\n'); });
`);
    // 守卫探针：在被测守卫的进程里逐个尝试越界打开 / 读取，报告每一项是否被守卫拒绝（GUARD_TRIPPED）。只碰不存在的路径（outsideDir 不存在），守卫失效时也只会得到 ENOENT / CANTOPEN，不会读到或建出任何东西。
    fs.writeFileSync(PROBE_JS, String.raw`'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const fwd = (p) => p.replace(/\\/g, '/');
async function runProbes(cfg) {
  const sqlite3 = require(process.env.PROBE_SQLITE3 || 'sqlite3');
  const O = cfg.outsideDir;
  const I = cfg.insideDir;
  const res = [];
  const tripped = (e) => !!e && /^GUARD_TRIPPED/.test(String(e.message));
  const openDb = (id, file, flags, expectTrip, useCached) => new Promise((resolve) => {
    const done = (v) => { res.push(Object.assign({ id, expectTrip, kind: 'db' }, v)); resolve(); };
    try {
      const cb = (e) => { done({ tripped: false, err: e ? String(e.message).slice(0, 80) : null }); if (!e) db.close(); };
      const db = useCached ? sqlite3.cached.Database(file, flags, cb) : new sqlite3.Database(file, flags, cb);
    } catch (e) { done({ tripped: tripped(e), err: String(e.message).slice(0, 120) }); }
  });
  const URI_RO = sqlite3.OPEN_READONLY | sqlite3.OPEN_URI;
  const URI_RW = sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE | sqlite3.OPEN_URI;
  const PLAIN_RO = sqlite3.OPEN_READONLY;
  const dbOutside = [
    ['db.plain', O + '\\x.db', PLAIN_RO],
    ['db.uri-3slash', 'file:///' + fwd(O) + '/x.db', URI_RO],
    ['db.uri-localhost', 'file://localhost/' + fwd(O) + '/x.db', URI_RO],
    ['db.uri-noslash', 'file:' + fwd(O) + '/x.db', URI_RO],
    ['db.uri-relative', 'file:../' + (cfg.relName || 'sdh-guard-probe-outside.db'), URI_RO],
    // 内存库放行已删（硬门）：查询串里的 mode=memory 不参与任何放行判断，按路径部分核。重复 mode 的反例（真实 SQLite 的最终模式可以不是内存）必须在打开前被拦
    ['db.uri-dup-mode-memory-rwc', 'file:///' + fwd(O) + '/x.db?mode=memory&mode=rwc', URI_RW],
    ['db.uri-dup-mode-memory-ro', 'file:///' + fwd(O) + '/x.db?mode=memory&mode=ro', URI_RO],
    ['db.uri-mode-memory-only', 'file:///' + fwd(O) + '/x.db?mode=memory', URI_RW],
    ['db.uri-percent', 'file:///' + fwd(O) + '/x%2Edb', URI_RO],
    ['db.uri-query', 'file:///' + fwd(O) + '/x.db?mode=ro', URI_RO],
    ['db.uri-bad-authority', 'file://evil-host/share/x.db', URI_RO],
    ['db.uri-bad-percent', 'file:%ZZ.db', URI_RO],
    ['db.uri-empty', 'file:', URI_RO],
    ['db.non-string', Buffer.from(O + '\\x.db'), PLAIN_RO],
  ];
  for (const [id, f, fl] of dbOutside) await openDb(id, f, fl, true);
  // sqlite3.cached.Database 不经 sqlite3.Database 的包装：单独包住，同样在打开前拒绝
  await openDb('db.cached-plain', O + '\\x.db', PLAIN_RO, true, true);
  await openDb('db.cached-uri', 'file:///' + fwd(O) + '/x.db', URI_RO, true, true);
  await openDb('db.ctl-cached-inside', path.join(I, 'ctl-cached.db'), sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, false, true);
  await openDb('db.ctl-memory', ':memory:', URI_RW, false);
  await openDb('db.ctl-uri-memory', 'file::memory:', URI_RW, false);
  await openDb('db.ctl-inside-plain', path.join(I, 'ctl-plain.db'), sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, false);
  await openDb('db.ctl-inside-uri', 'file:///' + fwd(path.join(I, 'ctl-uri.db')) + '?mode=rwc', URI_RW, false);
  // .env 读取：字符串 / Buffer / URL × 同步 / 回调 / promises（以及 openSync / createReadStream）
  const E = path.join(O, '.env');
  const forms = { str: E, buf: Buffer.from(E), url: pathToFileURL(E) };
  const envRes = (id, expectTrip, v) => res.push(Object.assign({ id, expectTrip, kind: 'env' }, v));
  const syncTry = (fn) => { try { fn(); return { tripped: false, err: null }; } catch (e) { return { tripped: tripped(e), err: String(e.message).slice(0, 100) }; } };
  for (const [k, p] of Object.entries(forms)) {
    envRes('env.readFileSync.' + k, true, syncTry(() => fs.readFileSync(p)));
    envRes('env.readFile.' + k, true, syncTry(() => fs.readFile(p, () => {})));
    let pr;
    try { await fs.promises.readFile(p); pr = { tripped: false, err: 'no-reject' }; } catch (e) { pr = { tripped: tripped(e), err: String(e.message).slice(0, 100) }; }
    envRes('env.promises.readFile.' + k, true, pr);
  }
  envRes('env.openSync.str', true, syncTry(() => fs.openSync(E, 'r')));
  envRes('env.createReadStream.str', true, syncTry(() => { const s = fs.createReadStream(E); s.on('error', () => {}); }));
  envRes('env.dotenv-variant.str', true, syncTry(() => fs.readFileSync(path.join(O, '.env.local'))));
  // process.loadEnvFile 不经 fs 的 JS 包装：单独包住。只用根外不存在的显式路径（不给路径时读 cwd 下的 .env，探针里绝不调用）
  if (typeof process.loadEnvFile === 'function') {
    envRes('env.loadEnvFile.str', true, syncTry(() => process.loadEnvFile(E)));
    envRes('env.loadEnvFile.url', true, syncTry(() => process.loadEnvFile(pathToFileURL(E))));
  }
  // 对照：私有根内的 .env 三种 API 都能读；私有根外但不是 .env 的路径不被守卫拦（得到 ENOENT）
  const IE = path.join(I, '.env');
  fs.writeFileSync(IE, 'K=V');
  envRes('env.ctl-inside.readFileSync', false, syncTry(() => fs.readFileSync(IE)));
  let a = { tripped: false, err: null };
  await new Promise((r) => fs.readFile(IE, (e) => { a = { tripped: tripped(e), err: e ? String(e.message).slice(0, 80) : null }; r(); }));
  envRes('env.ctl-inside.readFile', false, a);
  let b;
  try { await fs.promises.readFile(IE); b = { tripped: false, err: null }; } catch (e) { b = { tripped: tripped(e), err: String(e.message).slice(0, 80) }; }
  envRes('env.ctl-inside.promises.readFile', false, b);
  envRes('env.ctl-outside-nonenv', false, syncTry(() => fs.readFileSync(path.join(O, 'notenv.txt'))));
  if (typeof process.loadEnvFile === 'function') {
    const LE = path.join(I, '.env.probe-loadenv');
    fs.writeFileSync(LE, 'SDH_GUARD_PROBE_LOADENV=1\n');
    envRes('env.ctl-inside.loadEnvFile', false, syncTry(() => process.loadEnvFile(LE)));
    delete process.env.SDH_GUARD_PROBE_LOADENV;
  }
  // 联接逃逸：私有根内的联接指向私有根外的一个空目录——字面路径在私有根内，真实路径在外面（守卫必须 realpath 之后再核）
  if (cfg.junctionDir) {
    const JD = cfg.junctionDir;
    await openDb('db.junction-plain', path.join(JD, 'x.db'), PLAIN_RO, true);
    await openDb('db.junction-uri', 'file:///' + fwd(path.join(JD, 'x.db')), URI_RO, true);
    envRes('env.junction.readFileSync', true, syncTry(() => fs.readFileSync(path.join(JD, '.env'))));
    let jp;
    try { await fs.promises.readFile(path.join(JD, '.env')); jp = { tripped: false, err: null }; } catch (e) { jp = { tripped: tripped(e), err: String(e.message).slice(0, 100) }; }
    envRes('env.junction.promises.readFile', true, jp);
  }
  return res;
}
module.exports = { runProbes };
if (require.main === module) {
  const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  runProbes(cfg).then((r) => { process.stdout.write('PROBE_RESULT ' + JSON.stringify(r) + '\n'); }, (e) => { process.stdout.write('PROBE_ERROR ' + String(e && e.stack) + '\n'); });
}
`);
    // 真实回收模块的快速 stop 路径（辅助进程）：实例 stop() 立即完成（argv[2] = 'reject' 时是「先让身份变成已退出、然后立即 reject」），全部默认等待上限（stopWaitMs 20 秒）。
    //   完成后打印 REAP_DONE 并**自然结束**（不调 process.exit）：遗留的 stop 等待计时器会把进程拖慢到 20 秒（成功路径与 reject 路径各一个用例，收口小批第 9 项）
    fs.writeFileSync(REAPFAST_JS, String.raw`'use strict';
const lib = require(process.env.STUB_REAP_LIB);
const T0 = '2026-01-01T00:00:00.1234567Z';
let alive = true;
const proc = { getStartTime: () => T0, checkIdentity: () => ({ state: alive ? 'match' : 'dead' }), killIfIdentity: () => ({ killed: false, state: 'match' }), killTree: () => true };
const reaper = lib.createReaper({ file: null, owner: 'fast', supervisorRegistry: null, proc });
const stop = process.argv[2] === 'reject' ? async () => { alive = false; throw new Error('STOP_REJECTS'); } : async () => { alive = false; };
reaper.trackInstance('fast-stop', { pid: 9999999, startTime: T0, instance: 'test-fast', stop });
reaper.reapAll({ deadlineMs: 60000 }).then((r) => {
  process.stdout.write('REAP_DONE ' + JSON.stringify({ gone: r.gone.length, left: r.left.length, forced: r.forced.length }) + '\n');
});
`);
    // process.loadEnvFile 默认路径判别探针（收口小批第 4 项）：辅助进程以套件自建的目录为 cwd，目录里有一个**合成** .env（只含一个假标记变量）。
    //   依次调 loadEnvFile() / loadEnvFile(null) / loadEnvFile(undefined)：报告每一次是否 GUARD_TRIPPED、合成标记变量有没有被加载进 process.env。只读 cwd 下的 .env，不碰别处。
    fs.writeFileSync(ENVDEF_JS, String.raw`'use strict';
const MARK = 'SDH_SYNTHETIC_ENV_MARKER';
const rows = [];
if (typeof process.loadEnvFile !== 'function') { process.stdout.write('ENVDEF_RESULT ' + JSON.stringify({ supported: false, rows }) + '\n'); } else {
  for (const [id, call] of [['noarg', () => process.loadEnvFile()], ['null', () => process.loadEnvFile(null)], ['undefined', () => process.loadEnvFile(undefined)]]) {
    delete process.env[MARK];
    let tripped = false; let err = null;
    try { call(); } catch (e) { tripped = /^GUARD_TRIPPED/.test(String(e && e.message)); err = String(e && e.message).slice(0, 100); }
    rows.push({ id, tripped, err, loaded: process.env[MARK] === 'synthetic' });
  }
  process.stdout.write('ENVDEF_RESULT ' + JSON.stringify({ supported: true, cwd: process.cwd(), rows }) + '\n');
}
`);
    // 预加载包装的「登记写失败 + stop 也失败」用例：启动器替身（SDH_REAP_TI 指向它，预加载片段包住它的 startTestInstance）起一个真实服务替身进程（先自登记到套件的登记文件，作为最外层兜底），
    //   交出的句柄 stop() 永远失败；辅助进程自己的登记文件路径不存在（登记必然写失败）。驱动在辅助进程里看：调用抛什么、回收器内存里还有没有这条实例、reapAll 能否把服务收掉、闸门放不放行。
    fs.writeFileSync(STUB_TI_JS, String.raw`'use strict';
const { spawn } = require('child_process');
const lib = require(process.env.STUB_REAP_LIB);
exports.startTestInstance = async function startTestInstance() {
  const env = Object.assign({}, process.env, { SDH_REAP_REGISTRY: process.env.STUB_SUITE_REG, SDH_REAP_OWNER: 'regfail-stub' });
  // 只认 spawn 之后追加、label 对得上的记录（套件登记文件累积，PID 复用时只按 PID 找会拿到同 PID 旧记录，startTime 可能为 null）
  const seen = lib.readRegistryFile(process.env.STUB_SUITE_REG).records.length;
  const child = spawn(process.execPath, [process.env.STUB_MEMBER_JS, 'idle-reg', '-', 'regfail-stub-service'], { stdio: 'ignore', windowsHide: true, env });
  const end = Date.now() + 25000;
  let rec = null;
  while (Date.now() < end) {
    const r = lib.readRegistryFile(process.env.STUB_SUITE_REG);
    rec = r.records.slice(seen).find((x) => x.pid === child.pid && x.label === 'regfail-stub-service') || null;
    if (rec) break;
    await new Promise((res) => setTimeout(res, 100));
  }
  if (!rec) throw new Error('stub service did not self-register');
  const stop = async () => {
    if (process.env.STUB_STOP_OK !== '1') throw new Error('STOP_ALWAYS_FAILS');
    child.kill();
    await new Promise((res) => { if (child.exitCode !== null || child.signalCode !== null) res(); else child.once('exit', res); });
  };
  return { pid: child.pid, startTime: rec.startTime, dataDir: process.env.STUB_DATA_DIR, instance: 'test-regfail', stop };
};
`);
    fs.writeFileSync(REGFAIL_JS, String.raw`'use strict';
const PRE = globalThis.__sdhReapPreload;
const stub = require(process.env.SDH_REAP_TI);
(async () => {
  if (process.env.DRV_MODE === 'label') {
    // 登记 label：启动器句柄登记进回收器时用的 label（缺省 batch，SDH_REAP_LABEL 可改）
    const h = await stub.startTestInstance({});
    const recs = PRE.reaper.collect().entries.map((e) => e.rec);
    const lab = { label: recs[0] ? recs[0].label : null, n: recs.length, configLabel: PRE.config.label };
    await h.stop();
    process.stdout.write('LABEL_RESULT ' + JSON.stringify(lab) + '\n');
    return;
  }
  const out = {};
  try { await stub.startTestInstance({}); out.returned = true; } catch (e) { out.returned = false; out.code = e.code || null; out.stopError = e.stopError || null; }
  const r = PRE.reaper;
  out.failures = r.failures.length;
  out.entries = r.collect().entries.map((e) => ({ kind: e.rec.kind, pid: e.rec.pid, start: e.rec.startTime, hasStop: typeof e.stop === 'function' }));
  const v0 = r.verifyAllGone();
  out.verifyOkBefore = v0.ok;
  out.verifyBadBefore = v0.bad.length;
  const rp = await r.reapAll({ deadlineMs: 60000 });
  out.reap = { total: rp.total, gone: rp.gone.length, forced: rp.forced.length, left: rp.left.length };
  const g = r.finalGate({ pendingStarts: 0, pendingTimedOut: false, reap: rp, reapErr: null, sweep: { kept: [], failed: [] } });
  out.gate = { safe: g.safe, reasons: g.reasons, verifyOk: g.verify.ok };
  process.stdout.write('REGFAIL_RESULT ' + JSON.stringify(out) + '\n');
})().catch((e) => { process.stdout.write('REGFAIL_ERROR ' + String(e && e.stack) + '\n'); });
`);
    // 监督层用例的替身套件（由独立监督进程当套件运行）：成员是不需服务的桩成员（spawnSync 阻塞套件事件循环）；成员退出（orphan）后套件同步挂起，等监督进程超时杀进程树
    fs.writeFileSync(STANDIN_JS, String.raw`'use strict';
const batch = require(process.env.STANDIN_BATCH);
const [mode, pidFile, labelBase] = process.argv.slice(2);
const members = [{ label: 'T.member', rel: process.env.STUB_MEMBER_JS, args: [mode, '-', pidFile, 'detached', labelBase] }];
batch.runBatch(members, { cwd: process.env.STANDIN_CWD, log: () => {} }).then(() => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2147483647);
  process.exit(0);
});
`);
}

// ---------------------------------------------------------------- 场景助手
const OUTS = new Map();
/** 桩成员：label = <场景>.<名字>；args = [模式, 报告文件, ...extra]；extra 成员字段（needsService / resources / exclusive / timeoutMs）合并进去 */
function mk(scn, name, mode, fields, modeArgs) {
    const label = `${scn}.${name}`;
    const out = path.join(OUT_DIR, `${label}.jsonl`);
    OUTS.set(label, out);
    return Object.assign({ label, rel: MEMBER_JS, args: [mode, out, ...(modeArgs || [])] }, fields || {});
}
const reports = (m) => readJsonl(OUTS.get(m.label));
const rep = (m) => reports(m)[0] || null;
const keysOf = (r) => (r && r.testEnv ? Object.keys(r.testEnv).sort() : null);

const IO = () => ({ sourceDbPath: SRC, sourceEncryptionKey: null, serverJs: STUB_JS, resourceRoot: RES_ROOT, readyTimeoutMs: 30000, startupRaceRetries: 0 });
const INSTANCES_LINE = (o) => `TEST_INSTANCES shared=${o.shared || 0} exclusive=${o.exclusive || 0} restarts=${o.restarts || 0} raceRetries=${o.raceRetries || 0} missingResources=${o.missingResources || 0}`;

/** 跑一个场景：包一层截止（被测实现挂住时套件不跟着挂），收集每个成员的结果、启动器调用与新登记的实例 */
async function runScn(members, o) {
    const opt = o || {};
    const regBefore = REG.length;
    const callsBefore = START_CALLS.length;
    const rs = [];
    const logs = [];
    const t0 = mono();
    const p = batch.runBatch(members, {
        instanceOptions: opt.instanceOptions || IO(), cwd: WBS, log: opt.log || ((l) => logs.push(l)), defaultTimeoutMs: opt.defaultTimeoutMs,
        onResult: (r, m) => { rs.push(r); if (opt.onResult) opt.onResult(r, m); },
    });
    const settled = await Promise.race([p.then((v) => ({ v }), (e) => ({ e })), sleep(opt.deadlineMs || 120000).then(() => ({ late: true }))]);
    if (settled.late) PENDING_BATCHES.add(p.catch(() => {}));
    const scn = { batch: settled.v || null, error: settled.e || null, late: !!settled.late, results: rs, logs, ms: Math.round(mono() - t0), regs: REG.slice(regBefore), calls: START_CALLS.slice(callsBefore) };
    scn.by = (label) => rs.find((r) => r.label === label) || null;
    SCN_ALL.push(...scn.regs);
    return scn;
}
const okAll = (scn, ...ms) => ms.every((m) => { const r = scn.by(m.label); return r && r.ok; });


// ================================================================ 节 A：纯函数与成员校验
async function sectionA() {
    console.log('\n== 节 A：纯函数与成员校验 ==');
    const h = { instance: 'test-abc123', baseUrl: 'http://127.0.0.1:23456', dbPath: path.join(PRIV, 'x y', 'instance.db'), jwtSecret: 'jwt-secret-x' };
    const v = batch.testVarsFromHandle(h);
    check('A.1', 'testVarsFromHandle：恰好四个变量 TEST_INSTANCE / TEST_BASE_URL / TEST_DB_PATH / TEST_JWT_SECRET，取值来自句柄（库路径规范化为绝对路径）',
        J(Object.keys(v).sort()) === J(['TEST_BASE_URL', 'TEST_DB_PATH', 'TEST_INSTANCE', 'TEST_JWT_SECRET']) && v.TEST_INSTANCE === h.instance && v.TEST_BASE_URL === h.baseUrl && fold(v.TEST_DB_PATH) === fold(path.resolve(h.dbPath)) && v.TEST_JWT_SECRET === h.jwtSecret, v);
    const badH = [];
    for (const k of ['instance', 'baseUrl', 'dbPath', 'jwtSecret']) {
        for (const bad of [undefined, '']) {
            const hh = Object.assign({}, h, { [k]: bad });
            let e = null;
            try { batch.testVarsFromHandle(hh); } catch (x) { e = x; }
            if (errCode(e) !== 'TB_BAD_HANDLE') badH.push({ k, bad: String(bad), code: errCode(e) });
        }
    }
    check('A.1b', 'testVarsFromHandle 句柄缺任何一个字段（缺失或空串，共 8 种）→ TB_BAD_HANDLE（fail-closed，不把 undefined 传成字符串）', badH.length === 0, badH);

    const src = { Path: 'p', TEST_INSTANCE: 'a', test_base_url: 'b', Test_Db_Path: 'c', TEST_JWT_SECRET: 'd', TEST_TARGET: 'live', test_live_url: 'u', TEST_KEEP: '1', X_OK: 'x', GONE: undefined };
    const snap = J(src);
    const st = batch.stripTestVars(src);
    check('A.2', 'stripTestVars：六个测试变量名（含大小写变体）全部剔除；其余键（含别的 TEST_ 前缀的 TEST_KEEP）原样保留；undefined 值丢弃；不改入参',
        J(Object.keys(st).sort()) === J(['Path', 'TEST_KEEP', 'X_OK']) && st.TEST_KEEP === '1' && J(src) === snap, st);

    const callsBefore = START_CALLS.length;
    const bads = [
        ['成员表不是数组', 'x', 'TB_BAD_MEMBER'],
        ['成员不是对象', [null], 'TB_BAD_MEMBER'],
        ['缺 label', [{ rel: 'a.js' }], 'TB_BAD_MEMBER'],
        ['缺 rel', [{ label: 'a' }], 'TB_BAD_MEMBER'],
        ['未知字段（needService 笔误）', [{ label: 'a', rel: 'a.js', needService: true }], 'TB_BAD_MEMBER'],
        ['args 不是字符串数组', [{ label: 'a', rel: 'a.js', args: [1] }], 'TB_BAD_MEMBER'],
        ['needsService 不是布尔', [{ label: 'a', rel: 'a.js', needsService: 'yes' }], 'TB_BAD_MEMBER'],
        ['exclusive 不是布尔', [{ label: 'a', rel: 'a.js', exclusive: 1 }], 'TB_BAD_MEMBER'],
        ['exclusive: true 与 needsService: false 并写', [{ label: 'a', rel: 'a.js', exclusive: true, needsService: false }], 'TB_BAD_MEMBER'],
        ['resources 含未知资源名', [{ label: 'a', rel: 'a.js', needsService: true, resources: ['nope'] }], 'TB_BAD_MEMBER'],
        ['resources 不是数组', [{ label: 'a', rel: 'a.js', needsService: true, resources: 'uploads' }], 'TB_BAD_MEMBER'],
        ['不需服务的成员声明了 resources', [{ label: 'a', rel: 'a.js', resources: ['uploads'] }], 'TB_BAD_MEMBER'],
        ['label 重复', [{ label: 'a', rel: 'a.js' }, { label: 'a', rel: 'b.js' }], 'TB_BAD_MEMBER'],
        ['timeoutMs 为 0', [{ label: 'a', rel: 'a.js', timeoutMs: 0 }], 'TB_BAD_MEMBER'],
        ['timeoutMs 为小数', [{ label: 'a', rel: 'a.js', timeoutMs: 1.5 }], 'TB_BAD_MEMBER'],
        ['timeoutMs 为字符串', [{ label: 'a', rel: 'a.js', timeoutMs: '5' }], 'TB_BAD_MEMBER'],
    ];
    const badRes = [];
    for (const [name, members, code] of bads) {
        let e = null;
        try { await batch.runBatch(members, { instanceOptions: IO(), log: () => {} }); } catch (x) { e = x; }
        if (errCode(e) !== code) badRes.push({ name, got: errCode(e) });
    }
    check('A.3', `成员表校验：${bads.length} 种不合法写法全部在执行任何成员、启动任何实例之前以 TB_BAD_MEMBER 拒绝`, badRes.length === 0 && START_CALLS.length === callsBefore, { badRes, started: START_CALLS.length - callsBefore });
    const optBad = [];
    for (const [name, opts] of [['instanceOptions 含 resources', { instanceOptions: { resources: ['uploads'] } }], ['未知选项', { nope: 1 }], ['defaultTimeoutMs 非法', { defaultTimeoutMs: 0 }], ['onResult 不是函数', { onResult: 1 }]]) {
        let e = null;
        try { await batch.runBatch([], opts); } catch (x) { e = x; }
        if (errCode(e) !== 'TB_BAD_OPTIONS') optBad.push({ name, got: errCode(e) });
    }
    check('A.3b', 'runBatch 选项校验：instanceOptions 带 resources / 未知选项 / defaultTimeoutMs 非法 / onResult 不是函数 → TB_BAD_OPTIONS', optBad.length === 0, optBad);

    const nm = batch.normalizeMembers([{ label: 'a', rel: 'x.js', needsService: true, resources: ['reconcile', 'it-reconcile', 'uploads', 'uploads'] }, { label: 'b', rel: 'y.js', exclusive: true, timeoutMs: 5 }, { label: 'c', rel: 'z.js' }], { timeoutMs: 77 });
    check('A.4', '成员规范化：reconcile 与 it-reconcile 同义名合并去重（["it-reconcile","uploads"]）；exclusive 蕴含 needsService；timeoutMs 缺省取默认、显式值保留；不需服务成员默认 needsService=false',
        J(nm[0].resources) === J(['it-reconcile', 'uploads']) && nm[0].timeoutMs === 77 && nm[1].needsService === true && nm[1].exclusive === true && nm[1].timeoutMs === 5 && nm[2].needsService === false && nm[2].exclusive === false, nm);
    check('A.5', '成员缺省截止是 20 分钟（DEFAULT_MEMBER_TIMEOUT_MS = 1200000）', batch.DEFAULT_MEMBER_TIMEOUT_MS === 20 * 60 * 1000, batch.DEFAULT_MEMBER_TIMEOUT_MS);
    // 47R4c L：超时超过 setTimeout 上限（2^31 - 1）会被缩成约 1 毫秒 → 成员 timeoutMs 与 defaultTimeoutMs 都拒绝；恰为上限放行
    const tmBig = 2147483648;
    let tmMemErr = null; try { batch.normalizeMembers([{ label: 'a', rel: 'x.js', timeoutMs: tmBig }], { timeoutMs: 77 }); } catch (x) { tmMemErr = x; }
    let tmMaxOk = true; try { batch.normalizeMembers([{ label: 'a', rel: 'x.js', timeoutMs: tmBig - 1 }], { timeoutMs: 77 }); } catch (_) { tmMaxOk = false; }
    let tmDefErr = null; try { await batch.runBatch([], { defaultTimeoutMs: tmBig, log: () => {} }); } catch (x) { tmDefErr = x; }
    check('A.5b', '超时上限（47R4c L）：成员 timeoutMs = 2^31 → TB_BAD_MEMBER；defaultTimeoutMs = 2^31 → TB_BAD_OPTIONS；恰为 2^31 - 1 放行', errCode(tmMemErr) === 'TB_BAD_MEMBER' && errCode(tmDefErr) === 'TB_BAD_OPTIONS' && tmMaxOk, { mem: errCode(tmMemErr), def: errCode(tmDefErr), tmMaxOk });
    const empty = await batch.runBatch([], { instanceOptions: IO(), log: () => {} });
    check('A.6', '空成员表：ok、不起实例、没有 TEST_INSTANCES 行', empty.ok === true && empty.instancesLine === null && START_CALLS.length === callsBefore, empty);
}

// ================================================================ 节 B：① 没有需服务成员 → 不起实例
async function sectionB() {
    console.log('\n== 节 B：① 没有需服务成员 → 不起实例 ==');
    const n1 = mk('B', 'n1', 'report');
    const n2 = mk('B', 'n2', 'report');
    const s0 = await runScn([n1, n2]);
    check('B.1', '全部是不需服务的成员 → 启动器一次都没被调用，没有登记任何实例', s0.calls.length === 0 && s0.regs.length === 0 && !s0.error && !s0.late, { calls: s0.calls.length, regs: s0.regs.length, err: s0.error && s0.error.message });
    check('B.2', '成员都通过且环境里没有任何 TEST_* 变量（对照：它们确实运行了）', okAll(s0, n1, n2) && rep(n1) && rep(n2) && J(keysOf(rep(n1))) === '[]' && J(keysOf(rep(n2))) === '[]', { n1: rep(n1), n2: rep(n2) });
    check('B.3', '汇总：instancesLine 为 null（不打印 TEST_INSTANCES 行），attempted=0，ok=true', s0.batch && s0.batch.instancesLine === null && s0.batch.instances.attempted === 0 && s0.batch.ok === true, s0.batch && s0.batch.instances);
    // 对照：加一个需服务成员 → 恰好起一次（B.1 的「没起」不是因为起不来）
    const c1 = mk('B', 'c1', 'report');
    const c2 = mk('B', 'c2', 'report', { needsService: true });
    const s1 = await runScn([c1, c2]);
    check('B.4', '对照：同样的成员表加一个需服务成员 → 启动器恰好被调用 1 次，该成员拿到四个变量', s1.calls.length === 1 && okAll(s1, c1, c2) && J(keysOf(rep(c2))) === J(['TEST_BASE_URL', 'TEST_DB_PATH', 'TEST_INSTANCE', 'TEST_JWT_SECRET']), { calls: s1.calls.length, rep: rep(c2) });
}

// ================================================================ 节 C：② 共享实例与资源并集
async function sectionC() {
    console.log('\n== 节 C：② 两个需服务成员共用同一个实例，资源 = 并集 ==');
    const s1 = mk('C', 's1', 'report', { needsService: true, resources: ['uploads'] });
    const n = mk('C', 'n', 'report');
    const s2 = mk('C', 's2', 'report', { needsService: true, resources: ['archive'] });
    const s3 = mk('C', 's3', 'report', { needsService: true, resources: ['reconcile'] });
    const s4 = mk('C', 's4', 'report', { needsService: true, resources: ['it-reconcile', 'uploads'] });
    const scn = await runScn([s1, n, s2, s3, s4]);
    const r1 = rep(s1); const r2 = rep(s2); const r3 = rep(s3); const r4 = rep(s4); const rn = rep(n);
    check('C.1', '四个需服务成员共用一个实例：启动器恰好被调用 1 次、登记 1 个实例；全部通过', scn.calls.length === 1 && scn.regs.length === 1 && okAll(scn, s1, n, s2, s3, s4) && !scn.late, { calls: scn.calls.length, regs: scn.regs.length, results: scn.results.map((r) => [r.label, r.ok]) });
    const same = r1 && [r2, r3, r4].every((r) => r && r.testEnv.TEST_INSTANCE === r1.testEnv.TEST_INSTANCE && r.testEnv.TEST_BASE_URL === r1.testEnv.TEST_BASE_URL && fold(r.testEnv.TEST_DB_PATH) === fold(r1.testEnv.TEST_DB_PATH) && r.testEnv.TEST_JWT_SECRET === r1.testEnv.TEST_JWT_SECRET);
    check('C.2', '四个成员拿到同一组 TEST_INSTANCE / TEST_BASE_URL / TEST_DB_PATH / TEST_JWT_SECRET；身份是 test- 开头；基址是 127.0.0.1 上的非 3000 端口', !!same && /^test-/.test(r1.testEnv.TEST_INSTANCE) && /^http:\/\/127\.0\.0\.1:\d+$/.test(r1.testEnv.TEST_BASE_URL) && !/:3000$/.test(r1.testEnv.TEST_BASE_URL), { r1, r2 });
    check('C.3', '成员确实够得着服务：每个成员请求 /api/version 得到的 instance 等于自己的 TEST_INSTANCE', [r1, r2, r3, r4].every((r) => r && r.versionStatus === 200 && r.versionInstance === r.testEnv.TEST_INSTANCE), [r1, r2, r3, r4].map((r) => r && [r.versionStatus, r.versionInstance]));
    const entries = r1 ? r1.dataDirEntries : [];
    check('C.4', '资源 = 并集：数据根里有 uploads / archive / it-reconcile 三个资源目录，没有 private / periodic-results（成员没声明的不复制）；uploads 里复制进了来源的 a.txt',
        Array.isArray(entries) && ['uploads', 'archive', 'it-reconcile'].every((e) => entries.includes(e)) && !entries.includes('private') && !entries.includes('periodic-results') && Array.isArray(r1.uploadsFiles) && r1.uploadsFiles.includes('a.txt'), { entries, uploads: r1 && r1.uploadsFiles });
    check('C.4b', '同义名：成员写 reconcile、另一个写 it-reconcile，并集只交给启动器一次（启动器的唯一一次调用的资源是 ["uploads","archive","it-reconcile"]，没有因重复被 TI_BAD_OPTIONS 拒绝）', scn.calls.length === 1 && J(scn.calls[0].resources) === J(['uploads', 'archive', 'it-reconcile']), scn.calls);
    check('C.5', '不需服务的成员（夹在中间）运行了、环境里没有 TEST_* 变量', !!rn && J(keysOf(rn)) === '[]' && scn.by(n.label).service === null, rn);
    check('C.6', `汇总行恰好是「${INSTANCES_LINE({ shared: 1 })}」`, scn.batch && scn.batch.instancesLine === INSTANCES_LINE({ shared: 1 }), scn.batch && scn.batch.instancesLine);
    const cl = cleanOf(scn.regs);
    check('C.7', '批跑结束后共享实例的进程按身份（PID + 创建时间）已消失、数据根已删', cl.ok && scn.regs.length === 1, cl.bad);
}

// ================================================================ 节 D：③ 独占成员
async function sectionD() {
    console.log('\n== 节 D：③ 独占成员单独起实例、只带自己的资源、跑完即停 ==');
    const d1 = mk('D', 'd1', 'report', { needsService: true, resources: ['uploads'] });
    const d2 = mk('D', 'd2', 'report', { exclusive: true, resources: ['archive'] });
    const d3 = mk('D', 'd3', 'report', { needsService: true, resources: ['uploads'] });
    const d4 = mk('D', 'd4', 'report', { exclusive: true, resources: ['private'] });
    const hookSeen = {};
    const scn = await runScn([d1, d2, d3, d4], {
        onResult: (r) => {
            if (r.label !== d2.label && r.label !== d4.label) return;
            const rp = reports(r.label === d2.label ? d2 : d4)[0];
            const id = rp && rp.testEnv && rp.testEnv.TEST_INSTANCE;
            const reg = REG.find((x) => x.instance === id);
            hookSeen[r.label] = reg ? cleanOf([reg]) : { ok: false, bad: ['没找到该实例的登记'] };
        },
    });
    const a1 = rep(d1); const a2 = rep(d2); const a3 = rep(d3); const a4 = rep(d4);
    check('D.1', '独占成员各拿一个独立实例：d2 / d4 的 TEST_INSTANCE 与共享实例（d1 / d3）互不相同、彼此也不同；d1 与 d3 仍是同一个共享实例；全部通过',
        okAll(scn, d1, d2, d3, d4) && a1 && a2 && a3 && a4 && a1.testEnv.TEST_INSTANCE === a3.testEnv.TEST_INSTANCE && new Set([a1, a2, a4].map((r) => r.testEnv.TEST_INSTANCE)).size === 3 && scn.calls.length === 3,
        { ids: [a1, a2, a3, a4].map((r) => r && r.testEnv.TEST_INSTANCE), calls: scn.calls.length });
    const e1 = a1 ? a1.dataDirEntries : []; const e2 = a2 ? a2.dataDirEntries : []; const e4 = a4 ? a4.dataDirEntries : [];
    check('D.2', '独占实例只带自己的资源（d2 只有 archive，d4 只有 private）；共享实例的并集只含共享成员声明的 uploads，不含独占成员的 archive / private',
        Array.isArray(e1) && Array.isArray(e2) && Array.isArray(e4) && e1.includes('uploads') && !e1.includes('archive') && !e1.includes('private') && e2.includes('archive') && !e2.includes('uploads') && !e2.includes('private') && e4.includes('private') && !e4.includes('archive') && !e4.includes('uploads'), { e1, e2, e4 });
    check('D.3', '跑完即停：d2 / d4 的结果回调到达时（onResult 在成员全部收尾之后才调用），各自实例的进程已按身份消失、数据根已删；此时共享实例还没停（d1 / d3 之间复用同一个）',
        hookSeen[d2.label] && hookSeen[d2.label].ok && hookSeen[d4.label] && hookSeen[d4.label].ok, hookSeen);
    check('D.4', `汇总行恰好是「${INSTANCES_LINE({ shared: 1, exclusive: 2 })}」`, scn.batch && scn.batch.instancesLine === INSTANCES_LINE({ shared: 1, exclusive: 2 }), scn.batch && scn.batch.instancesLine);
    const cl = cleanOf(scn.regs);
    check('D.5', '结束后三个实例都已按身份消失、数据根都已删', cl.ok && scn.regs.length === 3, cl.bad);
}

// ================================================================ 节 E：④ 环境剔除
async function sectionE() {
    console.log('\n== 节 E：④ 不需服务的成员看不到 TEST_*；继承来的（含大小写变体）被剔除 ==');
    const leak = ['TEST_INSTANCE', 'test_base_url', 'Test_Db_Path', 'TEST_JWT_SECRET', 'TEST_TARGET', 'test_live_url'];
    const saved = {};
    for (const k of leak) { saved[k] = process.env[k]; process.env[k] = 'host-leak'; }
    process.env.TEST_BATCH_CONTROL = 'keep';
    let scn = null;
    const n1 = mk('E', 'n1', 'report');
    const s1 = mk('E', 's1', 'report', { needsService: true });
    const x1 = mk('E', 'x1', 'report', { exclusive: true });
    try { scn = await runScn([n1, s1, x1]); } finally {
        for (const k of leak) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
        delete process.env.TEST_BATCH_CONTROL;
    }
    const rn = rep(n1); const rs = rep(s1); const rx = rep(x1);
    check('E.1', '不需服务的成员：宿主环境里的六个测试变量（含 test_base_url / Test_Db_Path / test_live_url 这类大小写变体）一个都没带进去；别的 TEST_ 前缀变量（TEST_BATCH_CONTROL）与 PATH 原样保留（不是一刀切）',
        !!rn && J(keysOf(rn)) === J(['TEST_BATCH_CONTROL']) && rn.testEnv.TEST_BATCH_CONTROL === 'keep' && rn.hasPath === true, rn);
    const want4 = ['TEST_BASE_URL', 'TEST_BATCH_CONTROL', 'TEST_DB_PATH', 'TEST_INSTANCE', 'TEST_JWT_SECRET'];
    check('E.2', '共享需服务成员：恰好四个测试变量（每个名字只出现一次，大小写变体没有残留）+ 控制变量；TEST_TARGET / TEST_LIVE_URL 不在；值是实例的，不是宿主的 host-leak',
        !!rs && J(keysOf(rs)) === J(want4) && Object.values(rs.testEnv).filter((v) => v === 'host-leak').length === 0 && /^test-/.test(rs.testEnv.TEST_INSTANCE), rs);
    check('E.3', '独占需服务成员同样：恰好四个测试变量 + 控制变量，没有宿主的 host-leak，也没有 TEST_TARGET / TEST_LIVE_URL', !!rx && J(keysOf(rx)) === J(want4) && Object.values(rx.testEnv).filter((v) => v === 'host-leak').length === 0, rx);
    check('E.4', '共享成员与独占成员各是自己的实例（不是把宿主的 TEST_INSTANCE 当成实例）；全部通过；服务确实以实例身份应答', okAll(scn, n1, s1, x1) && rs.testEnv.TEST_INSTANCE !== rx.testEnv.TEST_INSTANCE && rs.versionInstance === rs.testEnv.TEST_INSTANCE && rx.versionInstance === rx.testEnv.TEST_INSTANCE, { rs: rs && rs.versionInstance, rx: rx && rx.versionInstance });
}

// ================================================================ 节 F：⑤ 共享实例起不来
async function sectionF() {
    console.log('\n== 节 F：⑤ 共享实例起不来 → 依赖它的成员判红、其他成员照跑、退出码非零 ==');
    const badIO = () => Object.assign(IO(), { sourceDbPath: path.join(PRIV, '不存在 目录', 'nope.db') });
    const n1 = mk('F', 'n1', 'report');
    const s1 = mk('F', 's1', 'report', { needsService: true });
    const s2 = mk('F', 's2', 'report', { needsService: true });
    const n2 = mk('F', 'n2', 'report');
    const scn = await runScn([n1, s1, s2, n2], { instanceOptions: badIO() });
    const r1 = scn.by(s1.label); const r2 = scn.by(s2.label);
    check('F.1', '依赖共享实例的两个成员都判红（ok=false，executed=false，不是跳过），原因里带启动器错误码 TI_SOURCE_MISSING；它们没有被运行（没有报告）',
        r1 && r2 && !r1.ok && !r2.ok && !r1.executed && !r2.executed && /TI_SOURCE_MISSING/.test(r1.notes.join('|')) && /TI_SOURCE_MISSING/.test(r2.notes.join('|')) && rep(s1) === null && rep(s2) === null, { r1, r2 });
    check('F.2', '其他成员照跑：起不来之前的 n1 与之后的 n2 都运行并通过', okAll(scn, n1, n2) && rep(n1) && rep(n2), scn.results.map((r) => [r.label, r.ok]));
    check('F.3', '批跑整体失败（ok=false，failed 恰为两个依赖成员），退出码语义非零', scn.batch && scn.batch.ok === false && J(scn.batch.failed) === J([s1.label, s2.label]) && scn.batch.fail === 2 && scn.batch.pass === 2, scn.batch && { ok: scn.batch.ok, failed: scn.batch.failed });
    check('F.4', '起不来只尝试一次：启动器恰好被调用 1 次（不为每个依赖成员重试）；没有登记任何实例', scn.calls.length === 1 && scn.regs.length === 0, { calls: scn.calls.length, regs: scn.regs.length });
    check('F.5', '汇总行 shared=0（起过但没起来）：TEST_INSTANCES shared=0 exclusive=0 restarts=0 raceRetries=0 missingResources=0', scn.batch && scn.batch.instancesLine === INSTANCES_LINE({}), scn.batch && scn.batch.instancesLine);
    const x1 = mk('F', 'x1', 'report', { exclusive: true });
    const n3 = mk('F', 'n3', 'report');
    const scn2 = await runScn([x1, n3], { instanceOptions: badIO() });
    check('F.6', '独占实例起不来：该独占成员判红且未执行，后面的成员照跑；批跑整体失败', scn2.by(x1.label) && !scn2.by(x1.label).ok && !scn2.by(x1.label).executed && /TI_SOURCE_MISSING/.test(scn2.by(x1.label).notes.join('|')) && okAll(scn2, n3) && scn2.batch.ok === false, { x: scn2.by(x1.label) });
}

// ================================================================ 节 G：⑥ 成员把实例弄死
async function sectionG() {
    console.log('\n== 节 G：⑥ 成员把实例弄死 → 该成员判红，下一个成员拿到新实例 ==');
    const s1 = mk('G', 's1', 'report', { needsService: true });
    const k = mk('G', 'k', 'kill-instance', { needsService: true });
    const s2 = mk('G', 's2', 'report', { needsService: true });
    const s3 = mk('G', 's3', 'report', { needsService: true });
    const scn = await runScn([s1, k, s2, s3]);
    const a = rep(s1); const rk = rep(k); const b = rep(s2); const c = rep(s3);
    check('G.1', '弄死实例的成员自己退出码是 0，但被判红（ok=false，原因里写明实例不再应答）；它之前的 s1 通过', scn.by(k.label) && scn.by(k.label).status === 0 && scn.by(k.label).ok === false && /不再应答/.test(scn.by(k.label).notes.join('|')) && okAll(scn, s1), scn.by(k.label));
    check('G.2', '下一个成员拿到新实例：s2 的 TEST_INSTANCE 与 s1 / k 的不同，s2 通过且服务以新身份应答', okAll(scn, s2) && a && b && rk && rk.testEnv.TEST_INSTANCE === a.testEnv.TEST_INSTANCE && b.testEnv.TEST_INSTANCE !== a.testEnv.TEST_INSTANCE && b.versionInstance === b.testEnv.TEST_INSTANCE, { a: a && a.testEnv.TEST_INSTANCE, b: b && b.testEnv.TEST_INSTANCE });
    check('G.3', '新实例继续共享：s3 与 s2 是同一个实例（只重起一次）', okAll(scn, s3) && b && c && b.testEnv.TEST_INSTANCE === c.testEnv.TEST_INSTANCE && scn.calls.length === 2, { calls: scn.calls.length });
    check('G.4', `重起计数：汇总行恰好是「${INSTANCES_LINE({ shared: 1, restarts: 1 })}」，批跑整体失败（failed 恰为弄死实例的成员）`, scn.batch && scn.batch.instancesLine === INSTANCES_LINE({ shared: 1, restarts: 1 }) && scn.batch.ok === false && J(scn.batch.failed) === J([k.label]), scn.batch && { line: scn.batch.instancesLine, failed: scn.batch.failed });
    const dead = scn.regs.find((r) => a && r.instance === a.testEnv.TEST_INSTANCE);
    check('G.5', '被弄死的旧实例已退役：登记的 2 个实例按身份都已消失、数据根都已删（旧实例的数据根没有遗留）', scn.regs.length === 2 && !!dead && cleanOf(scn.regs).ok, cleanOf(scn.regs).bad);
    const q1 = mk('G', 'q1', 'report', { needsService: true });
    const q2 = mk('G', 'q2', 'kill-instance', { needsService: true });
    const scn2 = await runScn([q1, q2]);
    check('G.6', '弄死实例的成员是最后一个共享成员：判红，但不为不存在的后续成员重起实例（启动器只调用 1 次，restarts=0）；实例已清理', scn2.by(q2.label) && !scn2.by(q2.label).ok && okAll(scn2, q1) && scn2.calls.length === 1 && scn2.batch.instances.restarts === 0 && cleanOf(scn2.regs).ok, { calls: scn2.calls.length, inst: scn2.batch && scn2.batch.instances, clean: cleanOf(scn2.regs).bad });
}


// ================================================================ 节 H：⑦ 成员超时
const readJsonFile = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
/** 挂起夹具的身份：成员与孙进程的 PID + 精确创建时间（成员自己写进就绪文件；孙进程的创建时间来自它自己的登记记录） */
const hangIds = (ph) => (ph && ph.ready === true ? { member: { pid: ph.pid, start: ph.start }, grand: { pid: ph.gpid, start: ph.gstart } } : null);
async function sectionH() {
    console.log('\n== 节 H：⑦ 成员超时 → 按句柄终止进程树、判红、后续成员照跑 ==');
    const pf1 = path.join(OUT_DIR, 'H-hang1.json');
    const pf2 = path.join(OUT_DIR, 'H-hang2.json');
    const s1 = mk('H', 's1', 'report', { needsService: true });
    const hg = mk('H', 'hang', 'hang', { needsService: true, timeoutMs: HANG_TIMEOUT_MS }, [pf1, 'detached', 'H.hang']);
    const s2 = mk('H', 's2', 'report', { needsService: true });
    const n3 = mk('H', 'n3', 'sleep', { timeoutMs: 300 }, ['1500']);
    const scn = await runScn([s1, hg, s2, n3], { deadlineMs: 70000 });
    const ph = readJsonFile(pf1);
    const ids = hangIds(ph);
    const rh = scn.by(hg.label);
    check('H.0', `挂起夹具在 ${HANG_TIMEOUT_MS} 毫秒截止内完成了初始化（孙进程先建先登记、成员已登记、就绪文件已写）——「夹具没起来」与下面「进程树回收失败」分开报告，慢机上夹具来不及初始化不会冒充成被测实现的缺陷`, !!ids, { cause: 'fixture-not-initialized', ph, rh: rh && { ms: rh.ms, timedOut: rh.timedOut } });
    check('H.1', '超时成员判红：timedOut=true、ok=false，原因写明超过截止并已终止进程树；批跑整体失败', !!rh && rh.timedOut === true && rh.ok === false && new RegExp(`超过 ${HANG_TIMEOUT_MS} 毫秒`).test(rh.notes.join('|')) && scn.batch && scn.batch.ok === false && J(scn.batch.failed) === J([hg.label]), rh);
    check('H.2', `到点就杀、不干等：批跑在套件的截止内返回（没有挂起）；超时成员耗时（单调时钟）落在 [截止, 截止 + 20 秒) 内`, !scn.late && !!rh && rh.ms >= HANG_TIMEOUT_MS - 100 && rh.ms < HANG_TIMEOUT_MS + 20000, { late: scn.late, ms: rh && rh.ms });
    const memberState = ids ? identityState(ids.member.pid, ids.member.start) : 'no-fixture';
    const grandState = ids ? identityState(ids.grand.pid, ids.grand.start) : 'no-fixture';
    check('H.3', '进程树按身份确认消失：超时成员自己与它派生的 detached 孙进程（不在成员的作业对象里，只杀成员自己时它会幸存）按 PID + 创建时间都是 dead / reused（身份由成员 / 孙进程自己登记，证明它们起来过）',
        !!ids && ['dead', 'reused'].includes(memberState) && ['dead', 'reused'].includes(grandState), ids ? { cause: 'tree-not-reclaimed', memberState, grandState } : { cause: 'fixture-not-initialized', ph });
    const a = rep(s1); const b = rep(s2);
    check('H.4', '后续成员照跑且共享实例没有被重起：超时前后的 s1 / s2 都通过、是同一个实例，restarts=0（超时后核对实例仍在）', okAll(scn, s1, s2) && a && b && a.testEnv.TEST_INSTANCE === b.testEnv.TEST_INSTANCE && scn.batch.instances.restarts === 0 && scn.calls.length === 1, { a: a && a.testEnv.TEST_INSTANCE, b: b && b.testEnv.TEST_INSTANCE, inst: scn.batch && scn.batch.instances });
    const rn = scn.by(n3.label);
    check('H.5', '不需服务的成员保持 spawnSync 语义（无超时）：睡 1.5 秒、timeoutMs=300 的成员照样跑完并通过（timeoutMs 对它被忽略）', !!rn && rn.ok === true && rn.timedOut === false && rn.ms >= 1400, rn && { ok: rn.ok, ms: rn.ms, timedOut: rn.timedOut });
    check('H.5b', '超时后共享实例已清理：结束后实例按身份消失、数据根已删', cleanOf(scn.regs).ok && scn.regs.length === 1, cleanOf(scn.regs).bad);

    const x = mk('H', 'xhang', 'hang', { exclusive: true, timeoutMs: HANG_TIMEOUT_MS }, [pf2, 'detached', 'H.xhang']);
    const s3 = mk('H', 's3', 'report', { needsService: true });
    const scn2 = await runScn([x, s3], { deadlineMs: 60000 });
    const ids2 = hangIds(readJsonFile(pf2));
    const rx = scn2.by(x.label);
    check('H.6', '独占成员超时：判红、进程树（成员与孙进程）按身份消失、它的独占实例已停（登记的两个实例都已消失、数据根都已删）；后面的共享成员照跑并通过',
        !!rx && rx.timedOut === true && rx.ok === false && !!ids2 && gone(ids2.member.pid, ids2.member.start) && gone(ids2.grand.pid, ids2.grand.start) && okAll(scn2, s3) && scn2.regs.length === 2 && cleanOf(scn2.regs).ok,
        { cause: ids2 ? 'tree-or-instance-not-reclaimed' : 'fixture-not-initialized', rx, ids2, clean: cleanOf(scn2.regs).bad });
}


// ================================================================ 节 I：⑧ 停止失败要报出来
async function sectionI() {
    console.log('\n== 节 I：⑧ 收尾 stop() 失败要报出来、退出码非零 ==');
    const s1 = mk('I', 's1', 'report', { needsService: true });
    INJECT.failStopOnce = true;
    const scn = await runScn([s1]);
    INJECT.failStopOnce = false;
    const reg = scn.regs[0];
    check('I.1', '共享实例收尾 stop() 失败（注入）：成员本身通过，但批跑整体失败（ok=false），errors 里写明实例与失败原因，且 errors 非空会让 FAMILY 退出码非零（见 J 节）',
        okAll(scn, s1) && scn.batch && scn.batch.ok === false && scn.batch.errors.length === 1 && /INJECTED_STOP_FAILURE/.test(scn.batch.errors[0]) && scn.batch.errors[0].includes(reg ? reg.instance : '@@'), scn.batch && scn.batch.errors);
    const stoppedBy = reg && reg.stop ? await reg.stop().then(() => 'ok', (e) => String(e && e.message)) : 'no-reg';
    check('I.1b', '套件事后用登记的真实 stop() 收口：实例按身份消失、数据根已删（注入的失败没有真的留下孤儿）', stoppedBy === 'ok' && cleanOf(scn.regs).ok, { stoppedBy, bad: cleanOf(scn.regs).bad });
    const x1 = mk('I', 'x1', 'report', { exclusive: true });
    INJECT.failStopOnce = true;
    const scn2 = await runScn([x1]);
    INJECT.failStopOnce = false;
    const reg2 = scn2.regs[0];
    check('I.2', '独占实例 stop() 失败（注入）：该独占成员判红（原因写明独占实例停止失败），errors 里有一条', !!scn2.by(x1.label) && !scn2.by(x1.label).ok && /停止失败/.test(scn2.by(x1.label).notes.join('|')) && scn2.batch.errors.length === 1 && scn2.batch.ok === false, { r: scn2.by(x1.label), errors: scn2.batch && scn2.batch.errors });
    if (reg2 && reg2.stop) await reg2.stop().catch(() => {});
    check('I.2b', '独占失败场景同样事后收口干净', cleanOf(scn2.regs).ok, cleanOf(scn2.regs).bad);
}


// ================================================================ 节 J：⑨ FAMILY 汇总行格式
async function sectionJ() {
    console.log('\n== 节 J：⑨ run-verify-family.js 的输出格式 ==');
    delete require.cache[require.resolve(FAMILY_PATH)];
    const fam = require(FAMILY_PATH);
    // io.runBatch 是 run-verify-family.js 的测试接缝：把被测批跑核心（--batch= 指向的那份，变异自证时是副本）接进来，这样批跑核心的变异在 J 节里也看得到
    const run = async (members, banner, guards, extra) => {
        const lines = [];
        const regBefore = REG.length;
        const code = await fam.runFamily({ members, bannerLabels: new Set(banner || []), guards }, { print: (l) => lines.push(String(l)), runBatch: batch.runBatch, batchOptions: Object.assign({ instanceOptions: IO(), cwd: PRIV }, extra || {}) });
        const regs = REG.slice(regBefore);
        SCN_ALL.push(...regs);
        return { lines, code, regs };
    };
    const FAMILY_RE = /^FAMILY PASS=\d+ FAIL=\d+( FAILED: .+)?$/;
    const ok1 = mk('J', 'ok1', 'report');
    const bad = mk('J', 'bad', 'fail');
    const ok2 = mk('J', 'ok2', 'report');
    const r1 = await run([ok1, bad, ok2], [bad.label], ['J-g1', 'J-g2']);
    const fi = r1.lines.findIndex((l) => FAMILY_RE.test(l));
    const gi = r1.lines.findIndex((l) => l.startsWith('GUARD '));
    check('J.1', '有失败成员：汇总行恰好是「FAMILY PASS=2 FAIL=1 FAILED: J.bad」；失败成员先打印 ===== RED J.bad (exit=1) ===== 横幅与它的输出（stdout 标记 STUB_OUTPUT 与 stderr 标记 STUB_STDERR 都在）；FAMILY 行在所有 GUARD 行之前',
        fi >= 0 && r1.lines[fi] === 'FAMILY PASS=2 FAIL=1 FAILED: J.bad' && r1.lines.some((l, i) => i < fi && l === '\n===== RED J.bad (exit=1) =====') && r1.lines.some((l, i) => i < fi && /STUB_OUTPUT fail/.test(l) && /STUB_STDERR fail/.test(l)) && gi > fi, { lines: r1.lines });
    check('J.2', '守卫行：绿的 `GUARD J-g1 OK`，红的 `GUARD J-g2 RED (exit=3)` 且紧跟其输出；成员红 + 守卫红 → 退出码 1', r1.lines.includes('GUARD J-g1 OK') && r1.lines.includes('GUARD J-g2 RED (exit=3)') && r1.lines.some((l, i) => i > r1.lines.indexOf('GUARD J-g2 RED (exit=3)') && /GUARD_STUB_RED_OUTPUT/.test(l)) && r1.code === 1, r1.lines);
    const r2 = await run([ok1, ok2], [], ['J-g1']);
    check('J.3', '全绿：汇总行恰好是「FAMILY PASS=2 FAIL=0」（行尾没有多余内容）、守卫 OK、退出码 0、没有 TEST_INSTANCES 行', r2.lines.includes('FAMILY PASS=2 FAIL=0') && r2.lines.includes('GUARD J-g1 OK') && r2.code === 0 && !r2.lines.some((l) => l.startsWith('TEST_INSTANCES')), r2);
    const r3 = await run([ok1, ok2], [], ['J-g1', 'J-g2']);
    check('J.4', '成员全绿但守卫红：FAMILY 行仍是 FAIL=0，退出码 1（退出码契约不变）', r3.lines.includes('FAMILY PASS=2 FAIL=0') && r3.code === 1, r3);
    const sv = mk('J', 'sv', 'report', { needsService: true });
    const sv2 = mk('J', 'sv2', 'report', { needsService: true });
    const r4 = await run([ok1, sv, sv2], [], ['J-g1']);
    const f4 = r4.lines.findIndex((l) => FAMILY_RE.test(l));
    check('J.5', `起过实例：FAMILY 行格式不变（FAMILY PASS=3 FAIL=0），紧接着另起一行恰好是「${INSTANCES_LINE({ shared: 1 })}」，且在 GUARD 行之前`, f4 >= 0 && r4.lines[f4] === 'FAMILY PASS=3 FAIL=0' && r4.lines[f4 + 1] === INSTANCES_LINE({ shared: 1 }) && f4 + 1 < r4.lines.findIndex((l) => l.startsWith('GUARD ')) && r4.code === 0, r4.lines);
    const sv3 = mk('J', 'sv3', 'report', { needsService: true });
    INJECT.failStopOnce = true;
    const r5 = await run([sv3], [], ['J-g1']);
    INJECT.failStopOnce = false;
    const last = r5.regs;
    for (const x of last) { if (x.stop) await x.stop().catch(() => {}); }
    const f5 = r5.lines.find((l) => FAMILY_RE.test(l));
    check('J.6', '批跑核心自身的失败（实例停止失败）：计入 FAIL（FAMILY PASS=1 FAIL=1 FAILED: test-batch(...)），退出码 1', /^FAMILY PASS=1 FAIL=1 FAILED: test-batch\(/.test(f5 || '') && r5.code === 1, r5.lines);
    check('J.6b', '事后收口干净（注入的停止失败不留孤儿）', cleanOf(last).ok, cleanOf(last).bad);
    // J.7：失败的**需服务**成员走异步路径，它的 stdout / stderr 两个标记同样要带出来（预筛 MED-1）
    const svf = mk('J', 'svfail', 'fail', { needsService: true });
    const r7 = await run([ok1, svf], [], ['J-g1']);
    const f7 = r7.lines.findIndex((l) => FAMILY_RE.test(l));
    check('J.7', '失败的需服务成员（异步路径）：汇总行恰好是「FAMILY PASS=1 FAIL=1 FAILED: J.svfail」；它的 stdout 标记与 stderr 标记都出现在 FAMILY 行之前；退出码 1',
        f7 >= 0 && r7.lines[f7] === 'FAMILY PASS=1 FAIL=1 FAILED: J.svfail' && r7.lines.some((l, i) => i < f7 && /STUB_OUTPUT fail/.test(l) && /STUB_STDERR fail/.test(l)) && r7.code === 1, r7.lines);
    // J.8（预筛 X1F）：**不传 io.runBatch**，走 run-verify-family.js 的默认接线（它自己 require 的 lib/test-batch.js）。上面各例都用 io.runBatch 把被测核心接进来，
    //   默认接线本身（require 的是哪个核心、有没有把 stderr 带出来）是它们够不到的；这里只传 print 与 batchOptions，同步失败成员与异步（需服务）失败成员各一个
    {
        const lines8 = [];
        const regBefore8 = REG.length;
        const okd = mk('J', 'defok', 'report');
        const bad8 = mk('J', 'defbad', 'fail');
        const svb8 = mk('J', 'defsvbad', 'fail', { needsService: true });
        const code8 = await fam.runFamily({ members: [okd, bad8, svb8], bannerLabels: new Set(), guards: [] }, { print: (l) => lines8.push(String(l)), batchOptions: { instanceOptions: IO(), cwd: PRIV } });
        SCN_ALL.push(...REG.slice(regBefore8));
        const f8 = lines8.findIndex((l) => FAMILY_RE.test(l));
        const withBoth = lines8.filter((l, i) => i < f8 && /STUB_OUTPUT fail/.test(l) && /STUB_STDERR fail/.test(l)).length;
        check('J.8', '默认接线（不传 io.runBatch）：同步失败成员与异步（需服务）失败成员的 stdout 标记与 stderr 标记都出现在 FAMILY 行之前（两条输出各带两个标记）；汇总行恰好是「FAMILY PASS=1 FAIL=2 FAILED: J.defbad J.defsvbad」；退出码 1',
            f8 >= 0 && lines8[f8] === 'FAMILY PASS=1 FAIL=2 FAILED: J.defbad J.defsvbad' && withBoth === 2 && code8 === 1, { withBoth, lines: lines8 });
    }
}


// ================================================================ 节 K：缺失资源只报告不判红
async function sectionK() {
    console.log('\n== 节 K：missingResources 非空 → 打印清单、计入汇总、不判红 ==');
    const s1 = mk('K', 's1', 'report', { needsService: true, resources: ['uploads'] });
    const scn = await runScn([s1], { instanceOptions: Object.assign(IO(), { sourceDbPath: SRC_GHOST }) });
    const dump = scn.logs.join('\n');
    check('K.1', '来源库引用了 uploads 里不存在的 ghost.bin：打印了缺失清单（含 task_attachments.file_name 与 ghost.bin；存在的 a.txt 不在清单里）', /TEST_BATCH_MISSING_RESOURCES/.test(dump) && /task_attachments\.file_name/.test(dump) && /ghost\.bin/.test(dump) && !/a\.txt/.test(dump) && /total=1/.test(dump), scn.logs);
    check('K.2', `缺失只报告不判红：成员通过、批跑 ok；汇总行恰好是「${INSTANCES_LINE({ shared: 1, missingResources: 1 })}」`, okAll(scn, s1) && scn.batch.ok === true && scn.batch.instancesLine === INSTANCES_LINE({ shared: 1, missingResources: 1 }), scn.batch && { ok: scn.batch.ok, line: scn.batch.instancesLine });
    const scn0 = await runScn([mk('K', 's0', 'report', { needsService: true, resources: ['uploads'] })]);
    check('K.3', '对照：来源库没有缺失引用 → 不打印清单、missingResources=0', scn0.logs.length === 0 && scn0.batch.instances.missingResources === 0, scn0.logs);
}


// ================================================================ 辅助进程（通用入口 / 批跑辅助 / 守卫探针共用）
let helperSeq = 0;
const HELPER_UNEXPECTED_VIOLATIONS = [];
/**
 * 起一个装了预加载片段（--require）的辅助进程：同样的 sqlite3 路径守卫 + .env 读取守卫 + 启动器句柄立即登记（登记到套件的同一份登记文件，归属 = owner）。
 * 返回前就把辅助进程自己登记进回收器；环境里先清掉六个测试变量。违规记录写到该辅助进程专属的文件；opts.expectViolations = 守卫自检时违规是预期的。
 */
function startHelper(scriptPath, argv, opts) {
    const o = opts || {};
    helperSeq += 1;
    const owner = o.owner || `helper-${helperSeq}`;
    const vfile = path.join(PRIV, `violations-${owner}.jsonl`);
    fs.writeFileSync(vfile, '');
    const env = {};
    for (const k of Object.keys(process.env)) { if (!TEST_VAR_RE.test(k)) env[k] = process.env[k]; }
    Object.assign(env, { NODE_PATH: path.join(WBS, 'node_modules'), SDH_REAP_OWNER: owner, SDH_REAP_VIOLATIONS: vfile }, o.extraEnv || {});
    const child = spawn(process.execPath, ['--require', PRELOAD_PATH, scriptPath, ...argv], { cwd: o.cwd || PRIV, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    track(owner, child);
    let stdout = ''; let stderr = '';
    const seen = {};
    let exitAt = null;
    child.stdout.on('data', (c) => {
        stdout += c;
        for (const tag of (o.markers || [])) { if (seen[tag] === undefined && stdout.includes(tag)) seen[tag] = mono(); }
    });
    child.stderr.on('data', (c) => { stderr += c; });
    child.once('exit', () => { exitAt = mono(); });
    const closed = new Promise((resolve) => { child.once('close', () => resolve(true)); child.once('error', () => resolve(true)); });
    const instRegs = () => regRecords((r) => r.owner === owner && r.kind === 'instance').map((r) => ({ pid: r.pid, start: r.startTime, dataDir: r.dataDir || null, instance: r.instance || null }));
    return {
        child, owner, vfile, regs: instRegs, out: () => stdout, err: () => stderr,
        markerAt: (tag) => (seen[tag] === undefined ? null : seen[tag]), exitAt: () => exitAt,
        async wait(ms) {
            const done = await Promise.race([closed, sleep(ms || o.timeoutMs || 90000).then(() => false)]);
            let killed = false;
            if (!done) { killed = true; try { child.kill(); } catch (_) { /* 下面有界等待 */ } await Promise.race([closed, sleep(5000)]); }
            const violations = readJsonl(vfile);
            if (violations.length && !o.expectViolations) HELPER_UNEXPECTED_VIOLATIONS.push(...violations);
            return { code: child.exitCode, signal: child.signalCode, stdout, stderr, killedByTimeout: killed, exited: done, violations };
        },
    };
}
/** 通用入口：被测批跑核心通过 --test-batch-core 接缝接进来（变异自证时是副本） */
function startCli(argv, extraEnv, opts) {
    const o = Object.assign({}, opts || {});
    o.extraEnv = Object.assign({}, extraEnv || {}, o.extraEnv || {});
    return startHelper(CLI_PATH, [`--test-batch-core=${BATCH_PATH}`, ...argv], Object.assign({ owner: `cli-${helperSeq + 1}` }, o));
}

// ================================================================ 节 L：通用入口（辅助进程 + 守卫 + 立即登记）
async function sectionL() {
    console.log('\n== 节 L：通用入口 run-test-batch.js ==');
    const ioFile = path.join(PRIV, 'cli-io.json');
    fs.writeFileSync(ioFile, J({ sourceDbPath: SRC, sourceEncryptionKey: null, serverJs: STUB_JS, resourceRoot: RES_ROOT, readyTimeoutMs: 30000, startupRaceRetries: 0 }));
    const m = (name, mode, fields, modeArgs) => { const x = mk('L', name, mode, fields, modeArgs); return x; };
    // L.1 清单文件，全部通过
    const a = m('n', 'report'); const b = m('s1', 'report', { needsService: true, resources: ['uploads'] }); const c = m('s2', 'report', { needsService: true, resources: ['archive'] });
    const mf1 = path.join(PRIV, 'cli-ok.json');
    fs.writeFileSync(mf1, J([a, b, c]));
    const c1 = startCli([`--manifest=${mf1}`, `--instance-options-file=${ioFile}`], {});
    const r1 = await c1.wait();
    const reg1 = c1.regs();
    check('L.1', '清单文件 + 实例选项文件：退出码 0；输出每个成员一行 PASS、末行 `BATCH PASS=3 FAIL=0`、再一行 TEST_INSTANCES（shared=1）；辅助进程守卫无违规',
        r1.exited && r1.code === 0 && /^PASS L\.n /m.test(r1.stdout) && /^BATCH PASS=3 FAIL=0$/m.test(r1.stdout) && r1.stdout.includes(INSTANCES_LINE({ shared: 1 })) && r1.violations.length === 0, { code: r1.code, out: r1.stdout.slice(-400), err: r1.stderr.slice(-300), v: r1.violations });
    const x1 = rep(b); const x2 = rep(c);
    check('L.2', '入口里的两个需服务成员共用启动器立即登记的那一个实例（登记文件里该入口名下恰好 1 个实例，身份与成员拿到的 TEST_INSTANCE 一致）；入口退出后该实例按身份消失、数据根已删',
        reg1.length === 1 && x1 && x2 && x1.testEnv.TEST_INSTANCE === reg1[0].instance && x2.testEnv.TEST_INSTANCE === reg1[0].instance && gone(reg1[0].pid, reg1[0].start) && lstatOrNull(reg1[0].dataDir) === null, { reg1, x1: x1 && x1.testEnv.TEST_INSTANCE });
    // L.3 失败成员 → 退出码 1；stdout 与 stderr 两个标记都要带出来，且都在 BATCH 行之前（预筛 MED-1）
    const bad = m('bad', 'fail'); const ok = m('ok', 'report');
    const mf2 = path.join(PRIV, 'cli-bad.json');
    fs.writeFileSync(mf2, J({ members: [bad, ok] }));
    const c2 = startCli([`--manifest=${mf2}`], {});
    const r2 = await c2.wait();
    const batchLineAt = r2.stdout.search(/^BATCH PASS=/m);
    const markerAt = (re) => { const mm = re.exec(r2.stdout); return mm ? mm.index : -1; };
    check('L.3', '有失败成员：退出码 1；输出 `FAIL L.bad`、其 stdout 标记 STUB_OUTPUT fail 与 stderr 标记 STUB_STDERR fail（都在 BATCH 行之前）、末行 `BATCH PASS=1 FAIL=1 FAILED: L.bad`；没有起实例（输出里没有 TEST_INSTANCES 行）',
        r2.exited && r2.code === 1 && /^FAIL L\.bad /m.test(r2.stdout) && batchLineAt > 0 && markerAt(/STUB_OUTPUT fail/) >= 0 && markerAt(/STUB_OUTPUT fail/) < batchLineAt && markerAt(/STUB_STDERR fail/) >= 0 && markerAt(/STUB_STDERR fail/) < batchLineAt
        && /^BATCH PASS=1 FAIL=1 FAILED: L\.bad$/m.test(r2.stdout) && !/TEST_INSTANCES/.test(r2.stdout) && c2.regs().length === 0, { code: r2.code, out: r2.stdout.slice(-300) });
    // L.3b 失败的需服务成员走异步路径：stderr 标记同样要带出来
    const svf = m('svfail', 'fail', { needsService: true });
    const mf2b = path.join(PRIV, 'cli-svfail.json');
    fs.writeFileSync(mf2b, J([svf]));
    const c2b = startCli([`--manifest=${mf2b}`, `--instance-options-file=${ioFile}`], {});
    const r2b = await c2b.wait();
    const bl = r2b.stdout.search(/^BATCH PASS=/m);
    const mkAt = (re) => { const mm = re.exec(r2b.stdout); return mm ? mm.index : -1; };
    check('L.3b', '失败的需服务成员（异步路径）：退出码 1；其 stdout 标记与 stderr 标记都出现在 BATCH 行之前；末行 `BATCH PASS=0 FAIL=1 FAILED: L.svfail`；实例随后消失',
        r2b.exited && r2b.code === 1 && bl > 0 && mkAt(/STUB_OUTPUT fail/) >= 0 && mkAt(/STUB_OUTPUT fail/) < bl && mkAt(/STUB_STDERR fail/) >= 0 && mkAt(/STUB_STDERR fail/) < bl && /^BATCH PASS=0 FAIL=1 FAILED: L\.svfail$/m.test(r2b.stdout)
        && c2b.regs().length === 1 && gone(c2b.regs()[0].pid, c2b.regs()[0].start), { code: r2b.code, out: r2b.stdout.slice(-400) });
    // L.4 参数形态
    const out4 = path.join(OUT_DIR, 'L-positional.jsonl');
    const c3 = startCli(['--service', '--resources=uploads', `--instance-options-file=${ioFile}`, MEMBER_JS], { STUB_MODE: 'report', STUB_OUT: out4 });
    const r3 = await c3.wait();
    const p4 = readJsonl(out4)[0];
    check('L.4', '参数形态（位置参数 + --service --resources=uploads）：退出码 0，成员拿到四个变量与 uploads 资源；实例随后消失', r3.exited && r3.code === 0 && !!p4 && J(Object.keys(p4.testEnv).sort()) === J(['TEST_BASE_URL', 'TEST_DB_PATH', 'TEST_INSTANCE', 'TEST_JWT_SECRET']) && Array.isArray(p4.dataDirEntries) && p4.dataDirEntries.includes('uploads') && c3.regs().length === 1 && gone(c3.regs()[0].pid, c3.regs()[0].start), { code: r3.code, out: r3.stdout.slice(-300), p4 });
    // L.5 用法错误
    const c4 = startCli([], {});
    const r4 = await c4.wait();
    const c5 = startCli(['--nope', MEMBER_JS], {});
    const r5 = await c5.wait();
    check('L.5', '用法错误（没有成员 / 未知选项）：退出码非零，stderr 里有用法说明，不起实例', r4.exited && r4.code === 1 && r5.exited && r5.code === 1 && /用法/.test(r4.stderr) && /用法/.test(r5.stderr) && c4.regs().length === 0 && c5.regs().length === 0, { r4: [r4.code, r4.stderr.slice(0, 120)], r5: [r5.code, r5.stderr.slice(0, 120)] });
    // L.6 批跑器被强杀：实例与成员（含孙进程）靠作业对象一并结束；登记在入口被杀前就已经写进登记文件（立即登记）
    const pf = path.join(OUT_DIR, 'L-hang.json');
    const hg = m('hang', 'hang', { needsService: true, timeoutMs: 600000 }, [pf, 'attached', 'L.hang']);
    const mf3 = path.join(PRIV, 'cli-hang.json');
    fs.writeFileSync(mf3, J([hg]));
    const c6 = startCli([`--manifest=${mf3}`, `--instance-options-file=${ioFile}`], {});
    const ready = await waitFor(() => c6.regs().length >= 1 && (readJsonFile(pf) || {}).ready === true, 60000, 250);
    const ph = readJsonFile(pf);
    const regSeen = c6.regs();
    const beforeKill = regSeen[0] ? identityState(regSeen[0].pid, regSeen[0].start) : 'no-reg';
    try { c6.child.kill(); } catch (_) { /* 下面按身份确认 */ }
    const r6 = await c6.wait(15000);
    const goneAll = await waitFor(() => regSeen[0] && ph && gone(regSeen[0].pid, regSeen[0].start) && gone(ph.pid, ph.start) && gone(ph.gpid, ph.gstart), 30000, 500);
    check('L.6', '批跑器被强杀（句柄终止入口进程）：启动器交出实例时已立即登记（强杀前登记文件已有该实例且服务在跑）；强杀后服务、成员及其（attached）孙进程按身份都消失（作业对象）',
        !!ready && !!ph && regSeen.length === 1 && beforeKill === 'match' && !!goneAll, { ready: !!ready, regSeen, beforeKill, ph, stillAlive: regSeen[0] && [identityState(regSeen[0].pid, regSeen[0].start), ph && identityState(ph.pid, ph.start), ph && identityState(ph.gpid, ph.gstart)], code: r6.code, signal: r6.signal });
    // 强杀后数据根留给遗留清理：只在进程全部确认消失后才删
    const swept = await ti.sweepStaleTestInstances({ tmpRoot: TMP });
    check('L.7', '强杀遗留的数据根由遗留清理（只认 PID + 创建时间，进程已消失才删）清掉：sweep 删了登记的那个数据根，没有保留项、没有失败项', !!regSeen[0] && swept.removed.some((d) => fold(d) === fold(regSeen[0].dataDir)) && swept.kept.length === 0 && swept.failed.length === 0 && lstatOrNull(regSeen[0].dataDir) === null, swept);
}


// ================================================================ 节 N：修复批 1 · 批跑核心行为
const boom = () => { throw new Error('LOG_BOOM'); };
async function sectionN() {
    console.log('\n== 节 N：修复批 1 · 独占存活检查 / 收尾 / 运行前核对 / ENOBUFS / 迁移登记 ==');
    // N.1（14 H1 / 14T M5）：独占成员弄死自己的服务后退出码 0 → 判红
    const x1 = mk('N', 'x1', 'kill-instance', { exclusive: true });
    const n1 = mk('N', 'n1', 'report');
    const s1 = mk('N', 's1', 'report', { needsService: true });
    const scn1 = await runScn([x1, n1, s1]);
    const rx1 = scn1.by(x1.label);
    check('N.1', '独占成员弄死自己的服务后退出码 0：判红（原因写明独占实例不再应答），独占实例照常收尾；后面的不需服务成员与共享成员照跑并通过；批跑整体失败（failed 恰为该成员）',
        !!rx1 && rx1.status === 0 && rx1.ok === false && /独占实例/.test(rx1.notes.join('|')) && /不再应答/.test(rx1.notes.join('|')) && okAll(scn1, n1, s1) && scn1.batch && scn1.batch.ok === false && J(scn1.batch.failed) === J([x1.label]), { rx1, failed: scn1.batch && scn1.batch.failed });
    check('N.1b', '该独占实例被弄死后仍收尾干净：登记的两个实例（独占 + 共享）按身份都已消失、数据根都已删；汇总行恰好是「' + INSTANCES_LINE({ shared: 1, exclusive: 1 }) + '」', scn1.regs.length === 2 && cleanOf(scn1.regs).ok && scn1.batch.instancesLine === INSTANCES_LINE({ shared: 1, exclusive: 1 }), { bad: cleanOf(scn1.regs).bad, line: scn1.batch && scn1.batch.instancesLine });

    // N.2（14 H2）：独占实例拿到句柄后，登记回调（log）同步抛错 → 服务按身份消失、数据根已删（runBatch 以该错误拒绝，成员没来得及运行）
    const x2 = mk('N', 'x2', 'report', { exclusive: true, resources: ['uploads'] });   // 要带 uploads 资源，来源库里的幽灵引用才会让 account 调用 log
    const scn2 = await runScn([x2], { instanceOptions: Object.assign(IO(), { sourceDbPath: SRC_GHOST }), log: boom, deadlineMs: 60000 });
    check('N.2', '独占实例起来后 log 同步抛错：runBatch 以 LOG_BOOM 拒绝；独占服务按身份已消失、数据根已删（不漏收尾）；成员没有运行', !scn2.late && !!scn2.error && scn2.error.message === 'LOG_BOOM' && scn2.regs.length === 1 && cleanOf(scn2.regs).ok && rep(x2) === null, { err: scn2.error && scn2.error.message, regs: scn2.regs.length, bad: cleanOf(scn2.regs).bad, ran: rep(x2) !== null });

    // N.3（预筛 L5 后半 / 修复批第 17 项）：共享实例 log 抛错不被误判成「共享实例不可用」，而是原样拒绝，实例由最外层 finally 收掉
    const s3 = mk('N', 's3', 'report', { needsService: true, resources: ['uploads'] });
    const scn3 = await runScn([s3], { instanceOptions: Object.assign(IO(), { sourceDbPath: SRC_GHOST }), log: boom, deadlineMs: 60000 });
    check('N.3', '共享实例起来后 log 抛错：runBatch 以 LOG_BOOM 原样拒绝（不是把成员判成「共享实例不可用」后正常返回）；共享实例按身份已消失、数据根已删', !scn3.late && !!scn3.error && scn3.error.message === 'LOG_BOOM' && scn3.batch === null && scn3.regs.length === 1 && cleanOf(scn3.regs).ok, { err: scn3.error && scn3.error.message, batch: scn3.batch && scn3.batch.failed, bad: cleanOf(scn3.regs).bad });

    // N.4（主会话裁定 预筛待裁 1）：共享成员运行前也核实例——实例在两个成员之间被别的东西弄死，下一个成员不背锅
    const a = mk('N', 'a', 'report', { needsService: true });
    const nk = mk('N', 'nk', 'kill-from-report', null, [OUTS.get(a.label)]);
    const b = mk('N', 'b', 'report', { needsService: true });
    const scn4 = await runScn([a, nk, b]);
    const ra = rep(a); const rb = rep(b);
    check('N.4', '一个不需服务的成员在两个共享成员之间把共享实例弄死：下一个共享成员判绿（不背锅）、拿到新实例；备注写明运行前核对发现实例不在并重起；批跑整体通过',
        okAll(scn4, a, nk, b) && !!ra && !!rb && ra.testEnv.TEST_INSTANCE !== rb.testEnv.TEST_INSTANCE && rb.versionInstance === rb.testEnv.TEST_INSTANCE && /运行前/.test(scn4.by(b.label).notes.join('|')) && scn4.batch.ok === true,
        { notes: scn4.by(b.label) && scn4.by(b.label).notes, a: ra && ra.testEnv.TEST_INSTANCE, b: rb && rb.testEnv.TEST_INSTANCE, failed: scn4.batch && scn4.batch.failed });
    check('N.4b', `重起计数：启动器被调用 2 次，汇总行恰好是「${INSTANCES_LINE({ shared: 1, restarts: 1 })}」；两个实例都已消失、数据根都已删`, scn4.calls.length === 2 && scn4.batch.instancesLine === INSTANCES_LINE({ shared: 1, restarts: 1 }) && scn4.regs.length === 2 && cleanOf(scn4.regs).ok, { calls: scn4.calls.length, line: scn4.batch && scn4.batch.instancesLine, bad: cleanOf(scn4.regs).bad });

    // N.5（预筛 L4 / 修复批第 15 项）：spawnSync 带 error 仍判红（严格判定），但 ENOBUFS 单独提示输出超限，不说「没能启动」
    const fl = mk('N', 'flood', 'flood', null, ['70']);
    const after = mk('N', 'after', 'report');
    const scn5 = await runScn([fl, after]);
    const rf = scn5.by(fl.label);
    const noteText = rf ? rf.notes.join('|') : '';
    check('N.5', '成员输出超过 64MB：仍判红（严格判定）；备注写明「输出超过 64MB 上限」（ENOBUFS），不说「没能启动」；后面的成员照跑', !!rf && rf.ok === false && /ENOBUFS/.test(noteText) && /64MB/.test(noteText) && !/没能启动/.test(noteText) && okAll(scn5, after), { notes: rf && rf.notes, status: rf && rf.status });
    const sn = batch._internals.spawnErrorNote;
    check('N.5b', '对照：别的 spawn 错误（ENOENT）仍说「没能启动」，不被 ENOBUFS 文案吞掉', typeof sn === 'function' && /没能启动/.test(sn({ code: 'ENOENT', message: 'x' })) && !/ENOBUFS/.test(sn({ code: 'ENOENT', message: 'x' })) && /64MB/.test(sn({ code: 'ENOBUFS', message: 'y' })), typeof sn === 'function' ? [sn({ code: 'ENOENT', message: 'x' }), sn({ code: 'ENOBUFS', message: 'y' })] : 'no-fn');
    // N.5c（47R4c M）：需服务成员走异步分支，输出超过 64MB 后即使退出码 0 也判红，备注写明超限；后面的成员照跑
    const flS = mk('N', 'floodsvc', 'flood', { needsService: true }, ['70']);
    const afterS = mk('N', 'aftersvc', 'report', { needsService: true });
    const scn5c = await runScn([flS, afterS]);
    const rfs = scn5c.by(flS.label);
    const noteS = rfs ? rfs.notes.join('|') : '';
    check('N.5c', '需服务成员（异步分支）输出超过 64MB：退出码 0 也判红，备注写明「超过 64MB 上限」；后面的需服务成员照跑判绿（47R4c M）', !!rfs && rfs.status === 0 && rfs.ok === false && /64MB/.test(noteS) && okAll(scn5c, afterS), { notes: rfs && rfs.notes, status: rfs && rfs.status, ok: rfs && rfs.ok });

    // N.6（修复批第 5 项 / 14 L）：SERVICE_MEMBERS 按 label 原位置替换需服务属性
    delete require.cache[require.resolve(FAMILY_PATH)];
    const fam = require(FAMILY_PATH);
    const t1 = mk('N', 't1', 'report'); const t2 = mk('N', 't2', 'report'); const t3 = mk('N', 't3', 'report');
    const applied = fam.applyServiceMembers([t1, t2, t3], [{ label: t2.label, needsService: true, resources: ['uploads'] }]);
    check('N.6', '迁移登记（桩成员表）：按 label 在原位置替换需服务属性——成员数不变、顺序不变、t2 有 needsService 与 resources、t1 / t3 不变；入参不被修改', applied.length === 3 && J(applied.map((x) => x.label)) === J([t1.label, t2.label, t3.label]) && applied[1].needsService === true && J(applied[1].resources) === J(['uploads']) && applied[1].rel === t2.rel && applied[0].needsService === undefined && applied[2].needsService === undefined && t2.needsService === undefined, applied);
    const lines6 = [];
    const regBefore6 = REG.length;
    const code6 = await fam.runFamily({ members: applied, bannerLabels: new Set(), guards: [] }, { print: (l) => lines6.push(String(l)), runBatch: batch.runBatch, batchOptions: { instanceOptions: IO(), cwd: PRIV } });
    SCN_ALL.push(...REG.slice(regBefore6));
    check('N.6b', '迁移后的成员只跑一次且拿到变量组（t2 的报告恰 1 条、四个变量；t1 / t3 没有 TEST_*）；FAMILY 行恰好是「FAMILY PASS=3 FAIL=0」，随后一行 TEST_INSTANCES shared=1；退出码 0',
        code6 === 0 && reports(t2).length === 1 && J(keysOf(rep(t2))) === J(['TEST_BASE_URL', 'TEST_DB_PATH', 'TEST_INSTANCE', 'TEST_JWT_SECRET']) && reports(t1).length === 1 && J(keysOf(rep(t1))) === '[]' && reports(t3).length === 1 && lines6.includes('FAMILY PASS=3 FAIL=0') && lines6.includes(INSTANCES_LINE({ shared: 1 })), { code6, lines6 });
    const built = fam.buildFamilyMembers(WBS);
    const lab0 = built.members.map((x) => x.label);
    const mig = fam.buildFamilyMembers(WBS, [{ label: lab0[0], needsService: true }]);
    check('N.6c', '自动扫描成员（verify-sys-*）同样可以迁移：登记后成员表标签序列逐项相同、只有第一个成员多了 needsService、rel 不变', J(mig.members.map((x) => x.label)) === J(lab0) && mig.members[0].needsService === true && mig.members[0].rel === built.members[0].rel && mig.members.slice(1).every((x) => !x.needsService) && mig.bannerLabels.has(lab0[0]), { n: lab0.length });
    const throwsWith = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(String(e.message)); } };
    check('N.6d', '迁移登记写错一律报错（整批不执行）：label 不存在 / 带 rel 字段 / 同一 label 登记两次 / 不是对象', throwsWith(() => fam.applyServiceMembers([t1], [{ label: 'nope', needsService: true }]), /不在成员表/)
        && throwsWith(() => fam.applyServiceMembers([t1], [{ label: t1.label, rel: 'x.js', needsService: true }]), /不接受的字段/) && throwsWith(() => fam.applyServiceMembers([t1], [{ label: t1.label, needsService: true }, { label: t1.label, exclusive: true }]), /登记了两次/)
        && throwsWith(() => fam.applyServiceMembers([t1], [null]), /必须是对象/));
}

// ================================================================ 节 P：成员正常退出后遗留孙进程 / 计时器（辅助进程里测，不用 process.exit）
/** 在装了预加载片段的辅助进程里跑一份成员表，结果完成后辅助进程**自然结束**；返回结果 JSON 与「完成标记 → 进程退出」的间隔（单调时钟，毫秒） */
async function runBatchHelper(tag, members, o) {
    const opt = o || {};
    const cfgFile = path.join(PRIV, `bh-${tag}.json`);
    fs.writeFileSync(cfgFile, J({ members, instanceOptions: IO(), cwd: WBS, defaultTimeoutMs: opt.defaultTimeoutMs }));
    const h = startHelper(HELPER_JS, [BATCH_PATH, cfgFile], { owner: `bh-${tag}`, markers: ['HELPER_DONE'] });
    const r = await h.wait(opt.limitMs || 45000);
    const mm = /HELPER_DONE (\{.*\})/.exec(r.stdout);
    const marker = h.markerAt('HELPER_DONE');
    const exitAt = h.exitAt();
    return { h, r, done: mm ? JSON.parse(mm[1]) : null, gapMs: marker !== null && exitAt !== null ? Math.round(exitAt - marker) : null };
}
async function sectionP() {
    console.log('\n== 节 P：管道与计时器（辅助进程自然退出）==');
    // P.1（14T M7）：只跑一个会超时的需服务成员；批跑返回后辅助进程自然结束，完成标记到进程退出 < 3 秒（遗留的 10 秒 / 5 秒等待计时器会拖慢）
    const sl = mk('P', 'sleep', 'sleep', { needsService: true, timeoutMs: 1500 }, ['60000']);
    const p1 = await runBatchHelper('timeout', [sl]);
    const r1 = p1.done && p1.done.results[0];
    check('P.1', '只跑一个会超时的需服务成员：成员判红且 timedOut；批跑返回后辅助进程自然结束（没有被强杀）、完成标记到进程退出的间隔 < 3000 毫秒（waitExit 的计时器退出或到期后都清除）',
        !!r1 && r1.timedOut === true && r1.ok === false && !p1.r.killedByTimeout && p1.r.code === 0 && p1.gapMs !== null && p1.gapMs < 3000, { done: p1.done && p1.done.results, gapMs: p1.gapMs, killed: p1.r.killedByTimeout, code: p1.r.code, out: p1.r.stdout.slice(-300), err: p1.r.stderr.slice(-200) });
    check('P.1b', '该辅助进程起的实例已按身份消失、数据根已删', p1.h.regs().length === 1 && cleanOf(p1.h.regs().map((x) => Object.assign({ label: 'bh-timeout' }, x))).ok, p1.h.regs());

    // P.2 / P.3 / P.4（14 H3 + 预筛 L3）：成员启动一个继承管道的 detached 孙进程后正常退出
    const pf = path.join(OUT_DIR, 'P-hold.json');
    const hp = mk('P', 'hold', 'hold-pipes', { needsService: true }, [pf, 'detached', 'P.hold']);
    const p2 = await runBatchHelper('hold', [hp], { limitMs: 40000 });
    const ph = readJsonFile(pf);
    const grand = ph && ph.ready === true ? { pid: ph.gpid, start: ph.gstart } : null;
    const grandAliveAtDone = grand ? identityState(grand.pid, grand.start) === 'match' : null;
    // 管道宽限的观测点是该成员的 onResult 回调（辅助进程里，同进程单调时钟：成员子进程 exit → onResult）；实例收尾（onResult → 批跑全部结束）另测、另给预算（14T-R M6）
    const delay = p2.done && typeof p2.done.graceMs === 'number' ? p2.done.graceMs : null;
    const finishMs = p2.done && typeof p2.done.finishMs === 'number' ? p2.done.finishMs : null;
    const rr = p2.done && p2.done.results[0];
    const G = batch._internals.CLOSE_GRACE_MS;
    check('P.0', '夹具初始化完成（孙进程已先建先登记、继承了成员的管道）——与下面「批跑器行为」分开报告', !!grand, { cause: 'fixture-not-initialized', ph });
    check('P.2', `成员正常退出（退出码 0）后孙进程仍握着管道：批跑在宽限（${G} 毫秒）加余量内放行该成员——辅助进程内单调时钟量得的「成员退出 → onResult」∈ [${G - 300}, ${G + 3000}] 毫秒（不含实例收尾）；成员判绿且备注写明「管道仍被占用」（不让批跑无界挂起）`,
        !!grand && !!rr && rr.ok === true && /管道仍被占用/.test(rr.notes.join('|')) && delay !== null && delay >= G - 300 && delay <= G + 3000, { delay, rr, doneNull: p2.done === null, killed: p2.r.killedByTimeout });
    check('P.2b', '实例收尾另给预算：onResult 之后到批跑全部结束（停共享实例、删数据根）≤ 30000 毫秒（辅助进程内单调时钟；与管道宽限的断言互不混入）', finishMs !== null && finishMs >= 0 && finishMs <= 30000, { finishMs });
    check('P.3', '批跑返回后辅助进程自然结束：没有被强杀、退出码 0、完成标记到进程退出 < 3000 毫秒（宽限到期时销毁了父侧 stdout / stderr 管道，读取句柄不再拖住事件循环）', !!p2.done && !p2.r.killedByTimeout && p2.r.code === 0 && p2.gapMs !== null && p2.gapMs < 3000, { gapMs: p2.gapMs, killed: p2.r.killedByTimeout, code: p2.r.code, out: p2.r.stdout.slice(-300) });
    check('P.4', '对照（证明夹具有效）：批跑返回时孙进程确实还活着（按身份 match）——成员正常退出后遗留的孙进程不由批跑器回收（维持的残余），由套件按身份回收', grandAliveAtDone === true, { grand, grandAliveAtDone });
    // 套件按身份回收这个孙进程
    let reclaimed = false;
    if (grand) {
        try { procLib.killIfIdentity({ pid: grand.pid, start_time: grand.start }); } catch (_) { /* 下面按身份确认 */ }
        reclaimed = (await waitFor(() => gone(grand.pid, grand.start), 15000, 300)) !== null;
    }
    check('P.5', '遗留孙进程由套件按「PID + 创建时间」回收并确认消失；辅助进程起的实例已消失、数据根已删', (!grand || reclaimed) && cleanOf(p2.h.regs().map((x) => Object.assign({ label: 'bh-hold' }, x))).ok, { grand, reclaimed, bad: cleanOf(p2.h.regs().map((x) => Object.assign({ label: 'bh-hold' }, x))).bad });

    // P.6（14-R M / 14T-R M7）：真实回收模块走快速 stop 路径（stop() 立即完成），打印完成标记后辅助进程自然结束；reapOne 的 stop 等待计时器（默认 20 秒）退出后必须清除，完成标记到进程退出 < 3000 毫秒
    const fastH = startHelper(REAPFAST_JS, [], { owner: 'reapfast', markers: ['REAP_DONE'] });
    const fr = await fastH.wait(40000);
    const fMarker = fastH.markerAt('REAP_DONE');
    const fExit = fastH.exitAt();
    const fGap = fMarker !== null && fExit !== null ? Math.round(fExit - fMarker) : null;
    check('P.6', '真实回收模块的快速 stop 路径：打印 REAP_DONE（gone 1 / forced 1 / left 0）后辅助进程自然结束——没有被强杀、退出码 0、完成标记到进程退出的间隔 < 3000 毫秒（stop 等待的计时器竞速结束后已清除，没有残留的 20 秒等待）',
        /REAP_DONE \{"gone":1,"left":0,"forced":1\}/.test(fr.stdout) && !fr.killedByTimeout && fr.code === 0 && fGap !== null && fGap < 3000, { gapMs: fGap, killed: fr.killedByTimeout, code: fr.code, out: fr.stdout.slice(-300), err: fr.stderr.slice(-200) });
    // P.6b（收口小批第 9 项 / 预筛 v3 L6）：stop() 立即 reject 的分支——「只在成功路径清计时器」的实现会在 reject 路径上留下 20 秒的等待。同样的辅助进程，stop 先让身份变成已退出再 reject
    const rejH = startHelper(REAPFAST_JS, ['reject'], { owner: 'reapfast-reject', markers: ['REAP_DONE'] });
    const rr6 = await rejH.wait(40000);
    const rMarker = rejH.markerAt('REAP_DONE');
    const rExit = rejH.exitAt();
    const rGap = rMarker !== null && rExit !== null ? Math.round(rExit - rMarker) : null;
    check('P.6b', '真实回收模块的 stop() 立即 reject 分支：身份已退出、reapAll 仍判 gone 1 / forced 1 / left 0；打印 REAP_DONE 后辅助进程自然结束——没有被强杀、退出码 0、完成标记到进程退出的间隔 < 3000 毫秒（reject 路径上 stop 等待的计时器也已清除）',
        /REAP_DONE \{"gone":1,"left":0,"forced":1\}/.test(rr6.stdout) && !rr6.killedByTimeout && rr6.code === 0 && rGap !== null && rGap < 3000, { gapMs: rGap, killed: rr6.killedByTimeout, code: rr6.code, out: rr6.stdout.slice(-300), err: rr6.stderr.slice(-200) });
}

// ================================================================ 节 Q：存活检查核身份（14T M6）
async function sectionQ() {
    console.log('\n== 节 Q：存活检查核对身份并区分「暂时失败」==');
    // Q.1：成员执行后服务继续监听，但返回错误 instance → 判红、旧实例退役、后续成员拿到新实例
    const a = mk('Q', 'a', 'report', { needsService: true });
    const sp = mk('Q', 'sp', 'spoof', { needsService: true }, ['instance']);
    const b = mk('Q', 'b', 'report', { needsService: true });
    const scn = await runScn([a, sp, b]);
    const ra = rep(a); const rb = rep(b);
    check('Q.1', '成员让服务继续监听但返回错误 instance：该成员判红（备注写明「身份变了」）；旧实例退役；下一个共享成员拿到新实例并通过；重起计数 1', scn.by(sp.label) && scn.by(sp.label).ok === false && /身份变了/.test(scn.by(sp.label).notes.join('|')) && okAll(scn, a, b) && !!ra && !!rb && ra.testEnv.TEST_INSTANCE !== rb.testEnv.TEST_INSTANCE && scn.batch.instances.restarts === 1 && scn.calls.length === 2,
        { sp: scn.by(sp.label), restarts: scn.batch && scn.batch.instances.restarts });
    check('Q.1b', '被冒名的旧实例已退役：登记的两个实例按身份都已消失、数据根都已删', scn.regs.length === 2 && cleanOf(scn.regs).ok, cleanOf(scn.regs).bad);
    // Q.2：错误 mode
    const a2 = mk('Q', 'a2', 'report', { needsService: true });
    const sp2 = mk('Q', 'sp2', 'spoof', { needsService: true }, ['mode']);
    const b2 = mk('Q', 'b2', 'report', { needsService: true });
    const scn2 = await runScn([a2, sp2, b2]);
    check('Q.2', '服务继续监听但 mode 不是 isolated：同样判红、旧实例退役、下一个成员拿到新实例', scn2.by(sp2.label) && scn2.by(sp2.label).ok === false && /身份变了/.test(scn2.by(sp2.label).notes.join('|')) && okAll(scn2, a2, b2) && scn2.batch.instances.restarts === 1 && cleanOf(scn2.regs).ok, { sp2: scn2.by(sp2.label), bad: cleanOf(scn2.regs).bad });
    // Q.3：暂时失败后恢复（断开、断开、正常）→ 重试不误判，成员判绿，不重起
    const f1 = mk('Q', 'f1', 'flaky', { needsService: true }, ['fail,fail,ok']);
    const f2 = mk('Q', 'f2', 'report', { needsService: true });
    const scn3 = await runScn([f1, f2]);
    check('Q.3', '暂时失败后恢复（接下来两次 /api/version 断开、第三次正常）：重试不误判——成员判绿、没有重起、两个成员同一个实例', okAll(scn3, f1, f2) && scn3.batch.instances.restarts === 0 && scn3.calls.length === 1 && rep(f1).testEnv.TEST_INSTANCE === rep(f2).testEnv.TEST_INSTANCE, { restarts: scn3.batch && scn3.batch.instances.restarts, notes: scn3.by(f1.label) && scn3.by(f1.label).notes });
    // Q.4：连续三次都断开 → 判不在（恰好三次探测，不多不少）
    const g1 = mk('Q', 'g1', 'flaky', { needsService: true }, ['fail,fail,fail']);
    const g2 = mk('Q', 'g2', 'report', { needsService: true });
    const scn4 = await runScn([g1, g2]);
    check('Q.4', '连续三次断开：判不在（备注「不再应答（3 次探测）」）、该成员判红、旧实例退役、下一个成员拿到新实例', scn4.by(g1.label) && scn4.by(g1.label).ok === false && /不再应答（3 次探测/.test(scn4.by(g1.label).notes.join('|')) && okAll(scn4, g2) && scn4.batch.instances.restarts === 1 && cleanOf(scn4.regs).ok, { g1: scn4.by(g1.label) && scn4.by(g1.label).notes, restarts: scn4.batch && scn4.batch.instances.restarts });
}


// ================================================================ 节 R：共享回收模块 lib/test-reap.js（每个「不确定」分支一个用例）
const T0 = '2026-01-01T00:00:00.1234567Z';
/** 可替换的进程工具（DI）：start / identity / kill / killTree / isAlive 各自可注入行为（isAlive 缺省 = 该 PID 不存在，替身 PID 都是编的） */
function fakeProc(o) {
    const f = o || {};
    return {
        getStartTime: f.start || (() => T0),
        isAlive: f.isAlive || (() => false),
        checkIdentity: f.identity || (() => ({ state: 'match' })),
        killIfIdentity: f.kill || (() => ({ killed: true, state: 'match' })),
        killTree: f.killTree || (() => true),
    };
}
/** 句柄替身：pid + exitCode / signalCode / kill / once；diesOnKill = kill() 之后视为已退出 */
function fakeChild(pid, o) {
    const c = { pid, exitCode: null, signalCode: null, killed: 0, kill() { c.killed += 1; if (o && o.diesOnKill) c.exitCode = 0; return true; }, once() { /* 替身不发事件 */ } };
    return c;
}
let unitSeq = 0;
function unitReaper(proc, extra) {
    unitSeq += 1;
    const f = path.join(PRIV, `r-unit-${unitSeq}.jsonl`);
    const p = reapLib.initRegistry(f);
    if (p) throw new Error(`单元登记文件初始化失败：${p}`);
    return { file: f, reaper: reapLib.createReaper(Object.assign({ file: f, owner: 'unit', supervisorRegistry: null, proc, recheckMs: 250, childWaitMs: 100, stopWaitMs: 200 }, extra || {})) };
}
const CLEAN_GATE = (reaper, reap) => reaper.finalGate({ pendingStarts: 0, pendingTimedOut: false, reap, reapErr: null, sweep: { kept: [], failed: [] } });
const EMPTY_REAP = { left: [], timedOut: false, problems: [] };
async function sectionR() {
    console.log('\n== 节 R：共享回收模块（登记协议 / 按身份回收 / 删除闸门）==');
    // R.1 登记文件协议
    const f1 = path.join(PRIV, 'r-proto.jsonl');
    const initP = reapLib.initRegistry(f1);
    const initAgain = reapLib.initRegistry(f1);
    reapLib.appendRecord(f1, { kind: 'instance', pid: 4242, startTime: T0, dataDir: path.join(PRIV, 'd'), instance: 'test-x', label: 'proto', owner: 'o1' });
    reapLib.appendRecord(f1, { kind: 'proc', pid: 4243, startTime: null, label: 'proto2', owner: 'o2' });
    reapLib.appendRecord(f1, { kind: 'instance', pid: 4242, startTime: T0, label: 'proto-dup', owner: 'o1' });
    const back = reapLib.readRegistryFile(f1);
    check('R.1', '登记文件协议：表头 + 追加写 JSONL；记录字段 { kind, pid, startTime（或 null）, dataDir?, instance?, label, owner } 读回一致；同 PID + 创建时间去重；重复创建（wx）报问题', initP === null && typeof initAgain === 'string' && back.problems.length === 0 && back.records.length === 2
        && back.records[0].kind === 'instance' && back.records[0].pid === 4242 && back.records[0].startTime === T0 && back.records[0].dataDir === path.join(PRIV, 'd') && back.records[0].instance === 'test-x' && back.records[0].label === 'proto' && back.records[0].owner === 'o1'
        && back.records[1].kind === 'proc' && back.records[1].startTime === null, { initP, initAgain, back });
    const badRecs = [['kind 不对', { kind: 'x', pid: 1, label: 'a', owner: 'o' }], ['pid 不是正整数', { kind: 'proc', pid: 0, label: 'a', owner: 'o' }], ['startTime 格式不对', { kind: 'proc', pid: 1, startTime: '2026-01-01', label: 'a', owner: 'o' }], ['缺 label', { kind: 'proc', pid: 1, owner: 'o' }], ['缺 owner', { kind: 'proc', pid: 1, label: 'a' }]];
    const badMiss = [];
    for (const [name, r] of badRecs) { let e = null; try { reapLib.appendRecord(f1, r); } catch (x) { e = x; } if (errCode(e) !== 'REAP_BAD_RECORD') badMiss.push({ name, got: errCode(e) }); }
    check('R.1b', '不合法记录（kind / pid / startTime 格式 / 缺 label / 缺 owner）一律在写入前以 REAP_BAD_RECORD 拒绝', badMiss.length === 0, badMiss);

    // R.2 写失败即抛（不吞）
    const dirAsFile = path.join(PRIV, 'r-dir-registry');
    fs.mkdirSync(dirAsFile);
    let eAppend = null; try { reapLib.appendRecord(dirAsFile, { kind: 'proc', pid: 5, startTime: T0, label: 'w', owner: 'o' }); } catch (x) { eAppend = x; }
    const { reaper: rWrite } = unitReaper(fakeProc(), { file: dirAsFile });
    let eReg = null; try { rWrite.register({ kind: 'proc', pid: 5, startTime: T0, label: 'w' }); } catch (x) { eReg = x; }
    const missingFile = path.join(PRIV, 'r-missing-registry.jsonl');
    let eMissing = null; try { reapLib.appendRecord(missingFile, { kind: 'proc', pid: 5, startTime: T0, label: 'w', owner: 'o' }); } catch (x) { eMissing = x; }
    check('R.2', '登记写失败即抛 REAP_REGISTRY_WRITE_FAILED（不吞）：登记路径是目录 / 登记文件不存在（被删后不悄悄新建）；经 reaper.register 同样抛，并记入 failures', errCode(eAppend) === 'REAP_REGISTRY_WRITE_FAILED' && errCode(eReg) === 'REAP_REGISTRY_WRITE_FAILED' && errCode(eMissing) === 'REAP_REGISTRY_WRITE_FAILED' && !fs.existsSync(missingFile) && rWrite.failures.length === 1, { eAppend: errCode(eAppend), eReg: errCode(eReg), eMissing: errCode(eMissing) });

    // R.2b（14-R H1 / 14T-R H1）：登记写失败不丢回收能力——合法记录与句柄先进内存，再落盘；写失败仍抛，但外层 reapAll / verifyAllGone / finalGate 从内存看得到。登记文件只读（可读不可写）
    {
        const alivePids = new Set([9601, 9602]);
        const fp = fakeProc({ identity: (q) => ({ state: alivePids.has(q.pid) ? 'match' : 'dead' }), kill: (q) => { alivePids.delete(q.pid); return { killed: true, state: 'match' }; } });
        const { file: fRo, reaper: rRo } = unitReaper(fp);
        fs.chmodSync(fRo, 0o444);
        let eReg2 = null; let eTrk2 = null; let col2 = null; let ver2 = null; let rp2 = null; let g2 = null;
        const kid = fakeChild(9602, { diesOnKill: true });
        try {
            try { rRo.register({ kind: 'proc', pid: 9601, startTime: T0, label: 'm-reg' }); } catch (x) { eReg2 = x; }
            try { rRo.trackChild('m-track', kid); } catch (x) { eTrk2 = x; }
            col2 = rRo.collect();
            ver2 = rRo.verifyAllGone();
            rp2 = await rRo.reapAll({ deadlineMs: 3000 });
            g2 = CLEAN_GATE(rRo, rp2);
        } finally { fs.chmodSync(fRo, 0o644); }
        check('R.2b', '登记文件只读（写必失败、读正常）：register / trackChild 都抛 REAP_REGISTRY_WRITE_FAILED 并记入 failures；但两条合法记录仍在回收器内存里（collect 的 entries = 2、文件读取无问题）、终检因此不 ok（看得见存活进程）、reapAll 把它们收掉（按身份终止 + 句柄终止，forced 2、left 0）；全部收掉之后闸门仍不放行（登记失败 ≥ 1）',
            errCode(eReg2) === 'REAP_REGISTRY_WRITE_FAILED' && errCode(eTrk2) === 'REAP_REGISTRY_WRITE_FAILED' && rRo.failures.length === 2 && !!col2 && col2.entries.length === 2 && col2.problems.length === 0 && ver2.ok === false && ver2.bad.length === 2
            && rp2.left.length === 0 && rp2.gone.length === 2 && rp2.forced.length === 2 && kid.killed === 1 && g2.safe === false && g2.reasons.some((r) => /登记失败/.test(r)) && !!g2.verify && g2.verify.ok === true,
            { eReg2: errCode(eReg2), eTrk2: errCode(eTrk2), failures: rRo.failures.length, entries: col2 && col2.entries.length, problems: col2 && col2.problems, ver2: ver2 && ver2.bad.length, rp2: rp2 && { gone: rp2.gone.length, left: rp2.left.length, forced: rp2.forced.length }, g2 });
    }

    // R.2c（预筛 P6 的复现）：真实进程 + 只读登记文件。register / trackChild 抛错 → 闸门不放行 → 外层仍能按身份 / 句柄把进程收掉
    {
        const { file: f6, reaper: r6 } = unitReaper(procLib);
        const idle6 = spawn(process.execPath, [MEMBER_JS, 'idle', '-'], { stdio: 'ignore', windowsHide: true });
        safetyAdd('R.2c-idle', idle6);   // 独立安全台账：被测回收器出错也不留孤儿
        let start6 = null; let e6a = null; let e6b = null; let before6 = null; let gateBefore6 = null; let rp6 = null; let after6 = null; let gateAfter6 = null; let exited6 = false;
        try {
            start6 = procLib.getStartTime(idle6.pid);
            fs.chmodSync(f6, 0o444);
            try { r6.register({ kind: 'proc', pid: idle6.pid, startTime: start6, label: 'p6-register' }); } catch (x) { e6a = x; }
            try { r6.trackChild('p6-track', idle6); } catch (x) { e6b = x; }
            before6 = r6.verifyAllGone();
            gateBefore6 = CLEAN_GATE(r6, EMPTY_REAP);
            rp6 = await r6.reapAll({ deadlineMs: 20000 });
            after6 = r6.verifyAllGone();
            gateAfter6 = CLEAN_GATE(r6, rp6);
        } finally {
            try { fs.chmodSync(f6, 0o644); } catch (_) { /* 私有根删除前的善后；失败由闸门（删不掉）体现 */ }
            await safetyDrain('R.2c-idle');
            exited6 = !childRunning(idle6);
        }
        check('R.2c', '真实进程 + 登记文件只读：register / trackChild 抛 REAP_REGISTRY_WRITE_FAILED；回收前终检不 ok（进程在跑）、闸门不放行；reapAll 终止它并拿到退出证据（forced 1、left 0、按身份消失）；回收后终检 ok，但闸门仍不放行（原因含「登记失败」）；安全台账没有出手（回收器自己收干净）',
            errCode(e6a) === 'REAP_REGISTRY_WRITE_FAILED' && errCode(e6b) === 'REAP_REGISTRY_WRITE_FAILED' && !!before6 && before6.ok === false && !!gateBefore6 && gateBefore6.safe === false && !!rp6 && rp6.left.length === 0 && rp6.forced.length === 1 && gone(idle6.pid, start6)
            && !!after6 && after6.ok === true && !!gateAfter6 && gateAfter6.safe === false && gateAfter6.reasons.some((r) => /登记失败/.test(r)) && exited6 && !SAFETY_REAPED.includes('R.2c-idle'),
            { e6a: errCode(e6a), e6b: errCode(e6b), before6: before6 && before6.ok, gateBefore6: gateBefore6 && gateBefore6.safe, rp6: rp6 && { left: rp6.left, forced: rp6.forced.length }, after6: after6 && after6.ok, gateAfter6, safetyReaped: SAFETY_REAPED.slice() });
    }

    // R.2d（14-R H1 / 修复批第 3 项）：预加载包装——登记写失败且 stop() 也失败。辅助进程里：调用抛 REAP_REGISTRY_WRITE_FAILED（带 stopError），实例条目仍在回收器内存（带 stop），
    //   reapAll 重试 stop 失败后按身份终止服务，闸门不放行（登记失败）。服务替身先自登记到套件的登记文件（最外层兜底）
    {
        // 辅助进程自己的登记文件：只读（可读不可写）——登记必然写失败，但读取没有问题（不让「登记文件读取失败」的 problems 混进这条用例）
        const roReg = path.join(PRIV, 'regfail-readonly.jsonl');
        reapLib.initRegistry(roReg);
        fs.chmodSync(roReg, 0o444);
        let rF = null;
        try {
            const hF = startHelper(REGFAIL_JS, [], {
                owner: 'regfail', markers: ['REGFAIL_RESULT'], expectViolations: true,
                extraEnv: { SDH_REAP_TI: STUB_TI_JS, SDH_REAP_REGISTRY: roReg, STUB_SUITE_REG: REGISTRY_FILE, STUB_MEMBER_JS: MEMBER_JS, STUB_DATA_DIR: path.join(PRIV, 'regfail-data') },
            });
            rF = await hF.wait(90000);
        } finally { fs.chmodSync(roReg, 0o644); }
        const mF = /REGFAIL_RESULT (\{.*\})/.exec(rF.stdout);
        const jF = mF ? JSON.parse(mF[1]) : null;
        const ent = jF && jF.entries && jF.entries[0];
        check('R.2d', '预加载包装 · 登记写失败 + stop() 也失败：启动器调用抛 REAP_REGISTRY_WRITE_FAILED 且带 stopError；回收器内存里仍有这条实例（kind=instance、带 stop）；回收前终检不 ok；reapAll 重试 stop 失败后按身份终止，forced 1、left 0；闸门不放行（原因含「登记失败」）；服务按身份已消失',
            !!jF && jF.returned === false && jF.code === 'REAP_REGISTRY_WRITE_FAILED' && jF.stopError === 'STOP_ALWAYS_FAILS' && jF.failures >= 1 && jF.entries.length === 1 && !!ent && ent.kind === 'instance' && ent.hasStop === true
            && jF.verifyOkBefore === false && jF.reap.forced === 1 && jF.reap.gone === 1 && jF.reap.left === 0 && jF.gate.safe === false && jF.gate.reasons.some((r) => /登记失败/.test(r)) && jF.gate.verifyOk === true && gone(ent.pid, ent.start) && rF.violations.some((v) => v.kind === 'reg'),
            { jF, code: rF.code, out: rF.stdout.slice(-400), err: rF.stderr.slice(-300), violations: rF.violations });
    }

    // R.2e（预加载片段的 label 前缀，S3b 对接）：缺省 batch；SDH_REAP_LABEL 可改
    {
        const labelCase = async (tag, extra) => {
            const f = path.join(PRIV, `label-reg-${tag}.jsonl`);
            const p = reapLib.initRegistry(f);
            const hL = startHelper(REGFAIL_JS, [], { owner: `label-${tag}`, markers: ['LABEL_RESULT'], expectViolations: true,
                extraEnv: Object.assign({ DRV_MODE: 'label', STUB_STOP_OK: '1', SDH_REAP_TI: STUB_TI_JS, SDH_REAP_REGISTRY: f, STUB_SUITE_REG: REGISTRY_FILE, STUB_MEMBER_JS: MEMBER_JS, STUB_DATA_DIR: path.join(PRIV, 'label-data') }, extra) });
            const r = await hL.wait(90000);
            const m = /LABEL_RESULT (\{.*\})/.exec(r.stdout);
            return { prep: p, res: m ? JSON.parse(m[1]) : null, code: r.code, out: r.stdout.slice(-300), err: r.stderr.slice(-200), fileRecs: reapLib.readRegistryFile(f).records };
        };
        const l1 = await labelCase('default', {});
        const l2 = await labelCase('custom', { SDH_REAP_LABEL: 's3b-env' });
        check('R.2e', '预加载片段的实例登记 label：缺省仍是 batch（回收器记录与登记文件都是）；设了 SDH_REAP_LABEL=s3b-env 则用它（config.label 同步）',
            l1.prep === null && !!l1.res && l1.res.label === 'batch' && l1.res.configLabel === 'batch' && l1.fileRecs.some((r) => r.label === 'batch' && r.kind === 'instance')
            && l2.prep === null && !!l2.res && l2.res.label === 's3b-env' && l2.res.configLabel === 's3b-env' && l2.fileRecs.some((r) => r.label === 's3b-env' && r.kind === 'instance'), { l1, l2 });
    }

    // R.2f（修复批第 6 项）：创建时间只接受约定的七位小数 ISO；其他精度拒绝登记并计入失败，不补零当精确身份
    {
        const badStarts = ['2026-01-01T00:00:00.123Z', '2026-01-01T00:00:00.123456Z', '2026-01-01T00:00:00.12345678Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00.1234567+08:00'];
        const fBad = path.join(PRIV, 'r-prec.jsonl');
        reapLib.initRegistry(fBad);
        const missNorm = [];
        for (const s of badStarts) {
            let e = null; try { reapLib.normalizeRecord({ kind: 'proc', pid: 4, startTime: s, label: 'a', owner: 'o' }, 'o'); } catch (x) { e = x; }
            if (errCode(e) !== 'REAP_BAD_RECORD') missNorm.push(s);
            let e2 = null; try { reapLib.appendRecord(fBad, { kind: 'proc', pid: 4, startTime: s, label: 'a', owner: 'o' }); } catch (x) { e2 = x; }
            if (errCode(e2) !== 'REAP_BAD_RECORD') missNorm.push(`append ${s}`);
        }
        const fileAfter = reapLib.readRegistryFile(fBad);
        // 读时：别的写入者写进去的三位毫秒记录是问题行，不当成精确身份
        const fRead = path.join(PRIV, 'r-prec-read.jsonl');
        fs.writeFileSync(fRead, `${reapLib.REGISTRY_HEADER}\n${J({ kind: 'proc', pid: 7, startTime: '2026-01-01T00:00:00.123Z', label: 'g', owner: 'o' })}\n`);
        const readBad = reapLib.readRegistryFile(fRead);
        // 回收器层：register / trackChild / trackInstance 都拒绝，计入 failures；不向身份查询传补零值；句柄 / stop 仍在内存
        const idQ = [];
        const { file: fU, reaper: rU } = unitReaper(fakeProc({ start: () => '2026-01-01T00:00:00.123Z', identity: (q) => { idQ.push(q.start_time); return { state: 'match' }; } }));
        let eA = null; let eB = null; let eC = null;
        const kidU = fakeChild(9611, { diesOnKill: true });
        let stopped = 0;
        try { rU.register({ kind: 'proc', pid: 9610, startTime: '2026-01-01T00:00:00.123Z', label: 'prec-register' }); } catch (x) { eA = x; }
        try { rU.trackChild('prec-track', kidU); } catch (x) { eB = x; }
        try { rU.trackInstance('prec-inst', { pid: 9612, startTime: '2026-01-01T00:00:00.123Z', stop: async () => { stopped += 1; } }); } catch (x) { eC = x; }
        const filedU = reapLib.readRegistryFile(fU);
        const entU = rU.collect().entries;
        const rpU = await rU.reapAll({ deadlineMs: 3000 });
        const gU = CLEAN_GATE(rU, rpU);
        check('R.2f', '创建时间精度：三位毫秒 / 六位 / 八位 / 无小数 / 带时区偏移 五种写法在 normalizeRecord 与 appendRecord 一律以 REAP_BAD_RECORD 拒绝，登记文件里一条都没有；读时三位毫秒记录是问题行；回收器的 register / trackChild / trackInstance 同样拒绝并计入 failures（3 次），'
            + '没有向身份查询传任何值（不补零当精确身份），句柄 / stop 仍留在内存可回收（句柄终止 + 实例 stop 调用各 1 次）；闸门不放行；对照：七位小数通过',
            missNorm.length === 0 && fileAfter.records.length === 0 && fileAfter.problems.length === 0 && readBad.problems.length === 1 && readBad.records.length === 0
            && errCode(eA) === 'REAP_BAD_RECORD' && errCode(eB) === 'REAP_BAD_RECORD' && errCode(eC) === 'REAP_BAD_RECORD' && rU.failures.length === 3 && filedU.records.length === 0 && idQ.length === 0
            && entU.length >= 2 && entU.every((e) => e.rec.startTime === null) && kidU.killed === 1 && stopped === 1 && gU.safe === false && gU.reasons.some((r) => /登记失败/.test(r))
            && reapLib.ISO_RE.test(T0) && !reapLib.ISO_RE.test('2026-01-01T00:00:00.123Z'),
            { missNorm, fileAfter, readBad: readBad.problems, errs: [errCode(eA), errCode(eB), errCode(eC)], failures: rU.failures.length, filed: filedU.records.length, idQ, entU: entU.map((e) => [e.rec.kind, e.rec.startTime]), killed: kidU.killed, stopped, gU });
    }

    // R.3 读时损坏行计入失败报告（每种单独一例）
    const readCase = (name, text) => { const f = path.join(PRIV, `r-read-${name}.jsonl`); fs.writeFileSync(f, text); return reapLib.readRegistryFile(f); };
    const H = `${reapLib.REGISTRY_HEADER}\n`;
    const good = `${J({ kind: 'proc', pid: 7, startTime: T0, label: 'g', owner: 'o' })}\n`;
    const cases = {
        'garbage-line': readCase('garbage', `${H}this is not json\n${good}`),
        'bad-record': readCase('badrec', `${H}${J({ kind: 'proc', pid: -1, label: 'g', owner: 'o' })}\n`),
        'no-header': readCase('nohdr', good),
        'unterminated-tail': readCase('tail', `${H}${good.trimEnd()}`),
        empty: readCase('empty', ''),
        unreadable: reapLib.readRegistryFile(path.join(PRIV, 'r-read-nonexistent.jsonl')),
    };
    const caseBad = Object.entries(cases).filter(([, r]) => r.problems.length === 0).map(([k]) => k);
    const okRead = readCase('ok', `${H}${good}`);
    check('R.3', '读时问题全部计入 problems（不当成空登记）：损坏行 / 不合法记录 / 缺表头 / 末行没写完 / 空文件 / 读取失败各一例；对照：正常文件 problems 为空且读到 1 条', caseBad.length === 0 && okRead.problems.length === 0 && okRead.records.length === 1 && cases['garbage-line'].records.length === 1, { caseBad });
    // R.3b：损坏行让 reaper 的 verify / gate 不安全
    const { file: fCorrupt, reaper: rCorrupt } = unitReaper(fakeProc());
    fs.appendFileSync(fCorrupt, 'corrupted line\n');
    const vC = rCorrupt.verifyAllGone();
    const reapC = await rCorrupt.reapAll({ deadlineMs: 2000 });
    check('R.3b', '登记文件里有一行损坏记录：verifyAllGone 不 ok（problems 非空）、reapAll 报告 problems、闸门判不安全（只有登记文件完好才可能放行）', vC.ok === false && vC.problems.length === 1 && reapC.problems.length === 1 && CLEAN_GATE(rCorrupt, reapC).safe === false, { vC, reapC: reapC.problems });

    // R.3c 登记时取不到创建时间的进程也必须写进登记文件（startTime=null）：另一个回收器（只读登记文件，没有内存里的句柄）读到它，终检不 ok、闸门不放行——不能因为「没有创建时间」就漏登
    {
        const { file: fN, reaper: rA } = unitReaper(fakeProc());
        rA.register({ kind: 'proc', pid: 9501, startTime: null, label: 'null-start-proc' });
        const rB = reapLib.createReaper({ file: fN, owner: 'other', supervisorRegistry: null, proc: fakeProc(), recheckMs: 100 });
        const vB = rB.verifyAllGone();
        const fileRecs = reapLib.readRegistryFile(fN).records;
        check('R.3c', '取不到创建时间的进程也写进登记文件（startTime=null）：只读登记文件的另一个回收器读到它，终检不 ok（原因 no-start-time）、闸门不放行', fileRecs.length === 1 && fileRecs[0].startTime === null && vB.ok === false && /no-start-time/.test(String(vB.bad[0] && vB.bad[0].reason)) && CLEAN_GATE(rB, EMPTY_REAP).safe === false, { fileRecs, vB });
    }

    // R.4 有退出证据的分支（对照组）：dead / reused / 句柄已 exit（即使没有创建时间）
    const evid = [];
    for (const [name, mkp, mkChild, regStart] of [
        ['dead', fakeProc({ identity: () => ({ state: 'dead' }) }), null, T0],
        ['reused', fakeProc({ identity: () => ({ state: 'reused' }) }), null, T0],
        ['handle-exit-no-start', fakeProc({ start: () => { throw new Error('no start'); } }), () => { const c = fakeChild(9101); c.exitCode = 0; return c; }, null],
    ]) {
        const { reaper } = unitReaper(mkp);
        if (mkChild) reaper.trackChild(`ev-${name}`, mkChild()); else reaper.register({ kind: 'proc', pid: 9100, startTime: regStart, label: `ev-${name}` });
        const rp = await reaper.reapAll({ deadlineMs: 2000 });
        const gate = CLEAN_GATE(reaper, rp);
        if (!(rp.left.length === 0 && rp.gone.length === 1 && rp.forced.length === 0 && reaper.verifyAllGone().ok && gate.safe)) evid.push({ name, rp, gate });
    }
    check('R.4', '有明确退出证据的三种情形都不进 left、闸门放行（对照）：身份 dead / 身份 reused / 句柄已 exit（即使取不到创建时间）', evid.length === 0, evid);

    // R.5 每个「不确定」分支都进 left 并挡住删除（= 14T H1 建议的三个闸门用例：创建时间获取失败、身份查询异常、终止失败，外加未知状态 / 终止抛错 / 终止后仍 match / 截止）
    const uncertain = [];
    const expectLeft = async (name, setup, reasonRe, reapOpt) => {
        const { reaper } = unitReaper(setup.proc, setup.extra);
        setup.register(reaper);
        const rp = await reaper.reapAll(reapOpt || { deadlineMs: 5000 });
        const v = reaper.verifyAllGone();
        const gate = CLEAN_GATE(reaper, rp);
        const okLeft = rp.left.length === 1 && reasonRe.test(String(rp.left[0].reason)) && rp.gone.length === 0;
        if (!(okLeft && v.ok === false && gate.safe === false)) uncertain.push({ name, left: rp.left, verifyOk: v.ok, safe: gate.safe, reasons: gate.reasons });
        return rp;
    };
    const regNoStart = (r) => r.register({ kind: 'proc', pid: 9201, startTime: null, label: 'u-no-start' });
    await expectLeft('创建时间缺失且没有句柄', { proc: fakeProc(), register: regNoStart }, /no-start-time/);
    await expectLeft('创建时间获取失败（trackChild 取不到）且句柄说仍在运行、终止也没成功', { proc: fakeProc({ start: () => { throw new Error('CIM down'); }, killTree: () => true }), register: (r) => r.trackChild('u-start-fail', fakeChild(9202)) }, /still-alive-after-kill/);
    await expectLeft('身份查询抛错', { proc: fakeProc({ identity: () => { const e = new Error('query boom'); e.code = 'LINE_PROC_QUERY_FAILED'; throw e; } }), register: (r) => r.register({ kind: 'proc', pid: 9203, startTime: T0, label: 'u-query' }) }, /identity-query-failed/);
    await expectLeft('身份状态未知（不是 match / dead / reused）', { proc: fakeProc({ identity: () => ({ state: 'zombie' }) }), register: (r) => r.register({ kind: 'proc', pid: 9204, startTime: T0, label: 'u-unknown' }) }, /unknown-state/);
    await expectLeft('终止失败（终止命令报告失败，身份一直 match）', { proc: fakeProc({ kill: () => ({ killed: false, state: 'match', failed: true }) }), register: (r) => r.register({ kind: 'proc', pid: 9205, startTime: T0, label: 'u-kill-failed' }) }, /kill-failed/);
    await expectLeft('终止抛错', { proc: fakeProc({ kill: () => { throw new Error('kill boom'); } }), register: (r) => r.register({ kind: 'proc', pid: 9206, startTime: T0, label: 'u-kill-threw' }) }, /kill-threw/);
    await expectLeft('终止报告成功但复核仍 match', { proc: fakeProc({ kill: () => ({ killed: true, state: 'match' }) }), register: (r) => r.register({ kind: 'proc', pid: 9207, startTime: T0, label: 'u-still-match' }) }, /still-alive-after-kill/);
    const rpDead = await expectLeft('回收总截止已到（未处理）', { proc: fakeProc(), register: (r) => r.register({ kind: 'proc', pid: 9208, startTime: T0, label: 'u-deadline' }) }, /deadline/, { deadlineMs: 0 });
    await expectLeft('实例的 stop() 一直不返回（受 stopWaitMs 限时）且身份一直 match', { proc: fakeProc(), register: (r) => r.trackInstance('u-stop-hang', { pid: 9209, startTime: T0, dataDir: path.join(PRIV, 'none'), instance: 'test-h', stop: () => new Promise(() => {}) }) }, /still-alive-after-kill|kill-failed/);
    check('R.5', '每个「不确定」分支都计入 left、终检不 ok、闸门判不安全：创建时间缺失 / 创建时间获取失败 / 身份查询抛错 / 未知状态 / 终止失败 / 终止抛错 / 终止后仍 match / 回收截止 / stop 挂住（共 9 例）', uncertain.length === 0 && rpDead.timedOut === true, { uncertain, deadlineTimedOut: rpDead.timedOut });

    // R.6 终止成功的路径（对照）：先 stop()、句柄终止、按身份终止 都能拿到退出证据，记入 forced
    const okPaths = [];
    {
        let alive = true;
        const { reaper } = unitReaper(fakeProc({ identity: () => ({ state: alive ? 'match' : 'dead' }) }));
        reaper.trackInstance('p-stop', { pid: 9301, startTime: T0, instance: 'test-s', stop: async () => { alive = false; } });
        const rp = await reaper.reapAll({ deadlineMs: 3000 });
        if (!(rp.left.length === 0 && rp.gone.length === 1 && rp.forced.length === 1 && reaper.verifyAllGone().ok)) okPaths.push({ name: 'stop()', rp });
    }
    {
        const c = fakeChild(9302, { diesOnKill: true });
        const { reaper } = unitReaper(fakeProc({ start: () => { throw new Error('no start'); } }));
        reaper.trackChild('p-handle', c);
        const rp = await reaper.reapAll({ deadlineMs: 3000 });
        if (!(c.killed === 1 && rp.left.length === 0 && rp.forced.length === 1 && rp.gone[0].evidence === 'handle-exit')) okPaths.push({ name: '句柄终止', rp, killed: c.killed });
    }
    {
        let alive = true; let killedWith = null;
        const { reaper } = unitReaper(fakeProc({ identity: () => ({ state: alive ? 'match' : 'dead' }), kill: (p) => { killedWith = p; alive = false; return { killed: true, state: 'match' }; } }));
        reaper.register({ kind: 'proc', pid: 9303, startTime: T0, label: 'p-identity' });
        const rp = await reaper.reapAll({ deadlineMs: 3000 });
        if (!(killedWith && killedWith.pid === 9303 && killedWith.start_time === T0 && rp.left.length === 0 && rp.forced.length === 1)) okPaths.push({ name: '按身份终止', rp, killedWith });
    }
    check('R.6', '终止成功的路径都拿到退出证据并记入 forced（被测代码没收干净）：实例 stop() / 句柄 kill（取不到创建时间时） / 按「PID + 精确创建时间」killIfIdentity', okPaths.length === 0, okPaths);

    // R.7 真实进程：句柄在手的辅助进程被回收；终检随后全绿
    {
        const { reaper } = unitReaper(procLib);
        const idle = spawn(process.execPath, [MEMBER_JS, 'idle', '-'], { stdio: 'ignore', windowsHide: true });
        // 独立安全台账（14T-R H2）：在调用被测回收器之前就留下原始 ChildProcess；被测回收器漏登记 / 没终止 / 抛错时，finally 有界终止并等退出，善后失败挡住删除私有根
        safetyAdd('R.7-idle', idle);
        let rec = null; let before = null; let rp = null; let after = null; let r7err = null;
        try {
            rec = reaper.trackChild('real-idle', idle);
            before = reaper.verifyAllGone();
            rp = await reaper.reapAll({ deadlineMs: 20000 });
            after = reaper.verifyAllGone();
        } catch (e) { r7err = e; } finally { await safetyDrain('R.7-idle'); }
        check('R.7', '真实进程：登记时取到精确创建时间；回收前终检不 ok（进程在跑）；reapAll 终止它并拿到退出证据（forced 1、left 0）；回收后终检 ok、按身份消失；被测回收器没出错时独立安全台账没有出手',
            !r7err && !!rec && ISO_OK(rec.startTime) && !!before && before.ok === false && !!rp && rp.forced.length === 1 && rp.left.length === 0 && !!after && after.ok === true && gone(rec.pid, rec.startTime) && !SAFETY_REAPED.includes('R.7-idle'),
            { err: r7err && r7err.message, rec, before: before && before.bad, rp: rp && rp.left, after: after && after.bad, safetyReaped: SAFETY_REAPED.slice() });
    }

    // R.7b（收口小批第 7 项 / 14T-R2 M2）：安全台账不把「身份已确认消失、exit 事件延后」误记成「代收」。三个对象，都挂在独立安全台账上：
    //   deferred = 真实进程，已按身份终止（确认消失），句柄替身的 exit 事件延后到 300 毫秒之后才派发（造出「进程已不在、Node 还认为它在运行」的窗口）→ 不记尝试、不记代收；
    //   never    = 同上，但 exit 事件始终不来（只有独立保存的创建时间能证明它已不在）→ 同样不记；
    //   alive    = 真实活着的进程，没有任何人回收它 → 确认仍活着，由台账终止并确认退出：记尝试、记代收（对照：台账没有变成什么都不记）
    {
        const startOf = async (child) => waitFor(() => procLib.getStartTime(child.pid), 5000, 200);
        const mkReal = () => spawn(process.execPath, [MEMBER_JS, 'idle', '-'], { stdio: 'ignore', windowsHide: true });
        const realD = mkReal(); const realN = mkReal(); const realE = mkReal(); const realA = mkReal();
        // 句柄替身（带真实 pid）：kill 是空操作（真实进程由下面的身份终止收掉）；exit 事件由 fire() 手动派发
        const mkHandle = (real) => { const h = { pid: real.pid, exitCode: null, signalCode: null, cbs: [], kill() { return true; }, once(ev, cb) { if (ev === 'exit') h.cbs.push(cb); }, fire() { h.exitCode = 0; for (const f of h.cbs.splice(0)) f(); } }; return h; };
        const hD = mkHandle(realD); const hN = mkHandle(realN); const hE = mkHandle(realE);
        safetyAdd('R.7b-alive', realA);
        safetyAdd('R.7b-real-deferred', realD);   // 真实进程本身也挂在台账上（最终的全量善后会看到它们；下面的 deferred / never / deferred-nostart 台账项挂的是句柄替身）
        safetyAdd('R.7b-real-never', realN);
        safetyAdd('R.7b-real-nostart', realE);
        let startD = null; let startN = null; let startE = null; let startA = null; let windowD = null; let windowN = null; let windowE = null; let goneD = false; let goneN = false; let goneE = false; let goneA = false;
        try {
            startD = await startOf(realD); startN = await startOf(realN); startE = await startOf(realE); startA = await startOf(realA);
            SAFETY.push({ label: 'R.7b-deferred', child: hD, start: startD });
            SAFETY.push({ label: 'R.7b-never', child: hN, start: startN });
            SAFETY.push({ label: 'R.7b-deferred-nostart', child: hE, start: null });   // 台账里没有创建时间（无法独立核身份）：只有「先等退出通知」能避免误记
            for (const [real, st] of [[realD, startD], [realN, startN], [realE, startE]]) { try { procLib.killIfIdentity({ pid: real.pid, start_time: st }); } catch (_) { /* 下面按身份确认 */ } }
            goneD = (await waitFor(() => gone(realD.pid, startD), 15000, 200)) !== null;
            goneN = (await waitFor(() => gone(realN.pid, startN), 15000, 200)) !== null;
            goneE = (await waitFor(() => gone(realE.pid, startE), 15000, 200)) !== null;
            windowD = childRunning(hD); windowN = childRunning(hN); windowE = childRunning(hE);   // 对照：句柄替身此刻仍认为进程在运行
            setTimeout(() => hD.fire(), 300);   // deferred：exit 事件延后到之后才来
            setTimeout(() => hE.fire(), 300);
            await safetyDrain('R.7b-deferred');
            await safetyDrain('R.7b-deferred-nostart');
            await safetyDrain('R.7b-never');
            await safetyDrain('R.7b-alive');
            goneA = startA ? gone(realA.pid, startA) : false;
        } finally {
            hD.fire(); hN.fire(); hE.fire();   // 替身事件补发，让最终闸门看到「台账里没有仍在运行的进程」
            await safetyDrain('R.7b-alive');
            for (const [real, st] of [[realD, startD], [realN, startN], [realE, startE]]) { if (st && !gone(real.pid, st)) { try { procLib.killIfIdentity({ pid: real.pid, start_time: st }); } catch (_) { /* 下面按句柄兜底 */ } } }
            for (const real of [realD, realN, realE]) { if (childRunning(real)) { try { real.kill(); } catch (_) { /* 真实句柄在手：PID 被句柄钉住，退出后事件自然派发 */ } } }
        }
        const notCollected = (label) => !SAFETY_ATTEMPTED.includes(label) && !SAFETY_REAPED.includes(label);
        check('R.7b', '安全台账区分「身份已确认消失」与「确认仍活着」：真实进程已按身份终止、句柄替身的 exit 事件延后 300 毫秒（deferred，台账有创建时间；deferred-nostart，台账没有创建时间）或始终不来（never，只有独立保存的创建时间能证明它已不在）→ 都不记尝试、不记代收，台账没有善后失败；'
            + '对照：真实活着、没人回收的进程（alive）→ 记尝试并记代收、按身份已消失；替身此刻确实仍认为进程在运行（夹具造出了窗口）',
            windowD === true && windowN === true && windowE === true && goneD && goneN && goneE && startD && startN && startE && notCollected('R.7b-deferred') && notCollected('R.7b-never') && notCollected('R.7b-deferred-nostart')
            && SAFETY_ATTEMPTED.includes('R.7b-alive') && SAFETY_REAPED.includes('R.7b-alive') && goneA && SAFETY_FAILS.length === 0,
            { windowD, windowN, windowE, goneD, goneN, goneE, goneA, attempted: SAFETY_ATTEMPTED.slice(), reaped: SAFETY_REAPED.slice(), fails: SAFETY_FAILS.slice() });
    }

    // R.8 与监督进程的登记协议一致（第 7 项）：镜像写 { pid, start }，监督进程自己的读取函数读得懂；不含创建时间的不镜像；监督登记文件不存在 → 抛错
    {
        const SUP = require('./lines-test-supervisor.js');
        const supFile = path.join(PRIV, 'r-sup-registry.jsonl');
        const prep = SUP.prepareRegistry(supFile);
        const f = path.join(PRIV, 'r-mirror.jsonl');
        reapLib.initRegistry(f);
        const reaper = reapLib.createReaper({ file: f, owner: 'unit', supervisorRegistry: supFile, proc: fakeProc() });
        reaper.register({ kind: 'proc', pid: 9401, startTime: T0, label: 'm1' });
        reaper.register({ kind: 'instance', pid: 9402, startTime: T0, dataDir: path.join(PRIV, 'x'), label: 'm2' });
        const supRead = SUP.readRegistry(supFile);
        const noSup = reapLib.createReaper({ file: f, owner: 'unit', supervisorRegistry: path.join(PRIV, 'r-sup-missing.jsonl'), proc: fakeProc() });
        let eSup = null; try { noSup.register({ kind: 'proc', pid: 9404, startTime: T0, label: 'm4' }); } catch (x) { eSup = x; }
        check('R.8', '监督进程协议统一：本模块登记时同步镜像 { pid, start } 到监督进程的登记文件，监督进程自己的 readRegistry 读到 2 条且无问题；监督登记文件不存在时登记抛 REAP_SUPERVISOR_REGISTRY_WRITE_FAILED，不悄悄新建',
            prep === null && supRead.problems.length === 0 && supRead.entries.length === 2 && supRead.entries[0].pid === 9401 && supRead.entries[0].start === T0 && supRead.entries[1].pid === 9402 && errCode(eSup) === 'REAP_SUPERVISOR_REGISTRY_WRITE_FAILED' && !fs.existsSync(path.join(PRIV, 'r-sup-missing.jsonl')), { prep, supRead, eSup: errCode(eSup) });

        // R.8b（预筛 L4 / 修复批第 5 项）：配了监督登记文件却没有精确创建时间的记录不再静默跳过——抛 REAP_SUPERVISOR_NO_START_TIME、计入登记失败；本模块登记文件里仍有这条记录、内存里也有，监督登记文件里没有
        let eNull = null; try { reaper.register({ kind: 'proc', pid: 9403, startTime: null, label: 'm3-no-start' }); } catch (x) { eNull = x; }
        const supAfter = SUP.readRegistry(supFile);
        const localRecs = reapLib.readRegistryFile(f).records;
        check('R.8b', '监督镜像遇到没有精确创建时间的记录：抛 REAP_SUPERVISOR_NO_START_TIME 并计入 failures（不再静默跳过）；监督登记文件里仍只有前 2 条；本模块登记文件与内存里有这条记录（先写本模块文件，镜像在后）；闸门因登记失败不放行',
            errCode(eNull) === 'REAP_SUPERVISOR_NO_START_TIME' && reaper.failures.length === 1 && supAfter.entries.length === 2 && localRecs.some((r) => r.pid === 9403 && r.startTime === null) && reaper.collect().entries.some((e) => e.rec.pid === 9403) && CLEAN_GATE(reaper, EMPTY_REAP).safe === false,
            { eNull: errCode(eNull), failures: reaper.failures.length, sup: supAfter.entries.length });

        // R.8c（预筛 Y2）：先写本模块登记文件、后写监督镜像的**顺序**。镜像失败时本模块文件里必须已有这条记录（P5）；本模块文件写失败时监督登记文件里必须没有它（镜像在后，不会留下「监督进程认得、本模块不认得」的半登记）
        const fMir = path.join(PRIV, 'r-order-mirror.jsonl');
        reapLib.initRegistry(fMir);
        const rMirFail = reapLib.createReaper({ file: fMir, owner: 'unit', supervisorRegistry: path.join(PRIV, 'r-order-no-sup.jsonl'), proc: fakeProc() });
        let eM = null; try { rMirFail.register({ kind: 'proc', pid: 9411, startTime: T0, label: 'order-mirror-fail' }); } catch (x) { eM = x; }
        const supOrder = path.join(PRIV, 'r-order-sup.jsonl');
        SUP.prepareRegistry(supOrder);
        const fRo = path.join(PRIV, 'r-order-readonly.jsonl');
        reapLib.initRegistry(fRo);
        fs.chmodSync(fRo, 0o444);
        const rFileFail = reapLib.createReaper({ file: fRo, owner: 'unit', supervisorRegistry: supOrder, proc: fakeProc() });
        let eF = null; try { rFileFail.register({ kind: 'proc', pid: 9412, startTime: T0, label: 'order-file-fail' }); } catch (x) { eF = x; } finally { fs.chmodSync(fRo, 0o644); }
        check('R.8c', '登记顺序：镜像失败时本模块登记文件里已有这条记录；本模块文件写失败时监督登记文件里一条都没有（先写本模块文件，后写监督镜像）',
            errCode(eM) === 'REAP_SUPERVISOR_REGISTRY_WRITE_FAILED' && reapLib.readRegistryFile(fMir).records.some((r) => r.pid === 9411) && errCode(eF) === 'REAP_REGISTRY_WRITE_FAILED' && SUP.readRegistry(supOrder).entries.length === 0,
            { eM: errCode(eM), eF: errCode(eF), local: reapLib.readRegistryFile(fMir).records.length, sup: SUP.readRegistry(supOrder).entries.length });

        // R.8d：trackChild 的免镜像例外要**两步判定**（收口小批第 1 项 / 预筛 v3 L1）——创建时间查询答复 null **且** proc.isAlive(pid) === false（子进程在登记前已退出，例如用法错误的入口一闪而过）才不要求镜像、不算登记失败；
        //   查询抛错（不能当成已退出）、查询答复 null 但 isAlive 说还活着（CIM 在进程活着时也可能静默返回空）、isAlive 抛错、isAlive 返回非布尔值 → 都 fail-closed，抛 REAP_SUPERVISOR_NO_START_TIME、计入 failures、句柄仍留在内存。
        //   这是 R.8b 的 fail-closed 在真实运行里碰到的合法例外（cli 入口秒退）
        const supG = path.join(PRIV, 'r-gone-sup.jsonl');
        SUP.prepareRegistry(supG);
        const mkGone = (tag, startFn, aliveFn) => { const ff = path.join(PRIV, `r-gone-${tag}.jsonl`); reapLib.initRegistry(ff); return reapLib.createReaper({ file: ff, owner: 'unit', supervisorRegistry: supG, proc: fakeProc({ start: startFn, isAlive: aliveFn }), childWaitMs: 100 }); };
        const rGone = mkGone('a', () => null, () => false);
        const kidG = fakeChild(9421); kidG.exitCode = 0;
        let eGone = null; try { rGone.trackChild('gone-child', kidG); } catch (x) { eGone = x; }
        const rQ = mkGone('b', () => { throw new Error('CIM down'); });
        const kidQ = fakeChild(9422, { diesOnKill: true });
        let eQ = null; try { rQ.trackChild('query-failed-child', kidQ); } catch (x) { eQ = x; }
        // 两步判定的反例：start 为 null 但进程还活着 / isAlive 抛错 / isAlive 返回 undefined（只有严格 false 才算已不存在）
        const aliveCases = [['alive-true', () => true], ['alive-throws', () => { throw new Error('isAlive boom'); }], ['alive-undefined', () => undefined]].map(([tag, aliveFn], k) => {
            const rA = mkGone(`c-${tag}`, () => null, aliveFn);
            const kidA = fakeChild(9430 + k, { diesOnKill: true });
            let eA = null; try { rA.trackChild(`null-start-${tag}`, kidA); } catch (x) { eA = x; }
            return { tag, code: errCode(eA), failures: rA.failures.length, entries: rA.collect().entries.length };
        });
        check('R.8d', '子进程登记前已退出（创建时间查询答复 null 且 isAlive 为 false）：不要求监督镜像、不算登记失败（监督登记文件里没有它）；创建时间查询抛错（不能当成已退出）：抛 REAP_SUPERVISOR_NO_START_TIME 并计入 failures，句柄仍留在内存；'
            + '查询答复 null 但 isAlive 为 true / isAlive 抛错 / isAlive 返回 undefined：同样抛 REAP_SUPERVISOR_NO_START_TIME、failures 1、句柄留在内存（免镜像例外要两步判定，isAlive 不确定按未退出处理）',
            eGone === null && rGone.failures.length === 0 && errCode(eQ) === 'REAP_SUPERVISOR_NO_START_TIME' && rQ.failures.length === 1 && rQ.collect().entries.length === 1 && SUP.readRegistry(supG).entries.length === 0
            && aliveCases.length === 3 && aliveCases.every((c) => c.code === 'REAP_SUPERVISOR_NO_START_TIME' && c.failures === 1 && c.entries === 1),
            { eGone: errCode(eGone), goneFailures: rGone.failures.length, eQ: errCode(eQ), qFailures: rQ.failures.length, sup: SUP.readRegistry(supG).entries.length, aliveCases });

        // R.8e（收口小批第 10 项 / 预筛 v3 L7）：trackInstance 把实例句柄镜像到监督登记（{ pid, start }）——S3c 自己断言，不再靠 S3b 的 T.1 跨套件覆盖。
        //   实例句柄没有「已退出」的免镜像例外：创建时间缺失 → 抛 REAP_SUPERVISOR_NO_START_TIME 并计入 failures
        const supI = path.join(PRIV, 'r-inst-sup.jsonl');
        SUP.prepareRegistry(supI);
        const fI = path.join(PRIV, 'r-inst-mirror.jsonl');
        reapLib.initRegistry(fI);
        const rI = reapLib.createReaper({ file: fI, owner: 'unit', supervisorRegistry: supI, proc: fakeProc() });
        rI.trackInstance('m-inst', { pid: 9441, startTime: T0, dataDir: path.join(PRIV, 'inst-data'), instance: 'test-minst', stop: async () => {} });
        const supIRead = SUP.readRegistry(supI);
        let eINull = null; try { rI.trackInstance('m-inst-nostart', { pid: 9442, startTime: null, stop: async () => {} }); } catch (x) { eINull = x; }
        const supIAfter = SUP.readRegistry(supI);
        check('R.8e', 'trackInstance 把实例句柄镜像到监督登记：{ pid: 9441, start: T0 } 在监督登记文件里（监督进程自己的 readRegistry 读到 1 条、无问题）、本模块登记文件里是 kind=instance 且带 dataDir；'
            + '没有创建时间的实例句柄不享受免镜像例外：抛 REAP_SUPERVISOR_NO_START_TIME、计入 failures，监督登记文件仍只有那 1 条',
            supIRead.problems.length === 0 && supIRead.entries.length === 1 && supIRead.entries[0].pid === 9441 && supIRead.entries[0].start === T0
            && reapLib.readRegistryFile(fI).records.some((r) => r.kind === 'instance' && r.pid === 9441 && r.dataDir === path.join(PRIV, 'inst-data'))
            && errCode(eINull) === 'REAP_SUPERVISOR_NO_START_TIME' && rI.failures.length === 1 && supIAfter.entries.length === 1,
            { supIRead, eINull: errCode(eINull), failures: rI.failures.length, supAfter: supIAfter.entries.length });

        // R.8f（预筛 v3 G5 的真实进程复现）：真实活着的进程 + CIM 被遮蔽成静默空（getStartTime 返回 null、isAlive 为 true）——不能被免镜像例外放过：抛 REAP_SUPERVISOR_NO_START_TIME、计入 failures、闸门不放行；句柄仍在内存，reapAll 按句柄收掉
        {
            const supC = path.join(PRIV, 'r-cimempty-sup.jsonl');
            SUP.prepareRegistry(supC);
            const { reaper: rC } = unitReaper(procLib, { supervisorRegistry: supC, childWaitMs: 3000, recheckMs: 3000 });
            const liveC = spawn(process.execPath, [MEMBER_JS, 'idle', '-'], { stdio: 'ignore', windowsHide: true });
            safetyAdd('R.8f-idle', liveC);   // 独立安全台账：被测回收器出错也不留孤儿
            const savedPrelude = procLib._test.psPrelude;
            let sC = 'unset'; let eC = null; let aliveC = null; let gateC = null; let rpC = null; let goneC = false; let startC = null;
            try {
                try {
                    startC = await waitFor(() => procLib.getStartTime(liveC.pid), 5000, 200);   // 遮蔽之前取一次真实创建时间，只用来事后核身份（刚 spawn 时 CIM 偶尔还看不到它，有界重试）
                    procLib._test.psPrelude = 'function Get-CimInstance { }';
                    try { sC = procLib.getStartTime(liveC.pid); } catch (x) { sC = 'ERR ' + errCode(x); }
                    try { rC.trackChild('r8f-cim-empty', liveC); } catch (x) { eC = x; }
                } finally { procLib._test.psPrelude = savedPrelude; }
                aliveC = procLib.isAlive(liveC.pid);
                gateC = CLEAN_GATE(rC, EMPTY_REAP);
                rpC = await rC.reapAll({ deadlineMs: 20000 });
                goneC = startC ? gone(liveC.pid, startC) : false;
            } finally { await safetyDrain('R.8f-idle'); }
            check('R.8f', '真实进程 + CIM 被遮蔽成静默空（getStartTime 返回 null、isAlive 为 true）：trackChild 抛 REAP_SUPERVISOR_NO_START_TIME 并计入 failures（不被免镜像例外放过）、监督登记文件里没有它；闸门不放行；reapAll 按句柄收掉（forced 1、left 0）、按身份已消失；安全台账没有出手',
                sC === null && aliveC === true && errCode(eC) === 'REAP_SUPERVISOR_NO_START_TIME' && rC.failures.length === 1 && SUP.readRegistry(supC).entries.length === 0 && !!gateC && gateC.safe === false && !!rpC && rpC.forced.length === 1 && rpC.left.length === 0 && goneC && !SAFETY_REAPED.includes('R.8f-idle'),
                { sC, aliveC, eC: errCode(eC), failures: rC.failures.length, sup: SUP.readRegistry(supC).entries.length, gateC, rpC: rpC && { forced: rpC.forced.length, left: rpC.left.length }, goneC, safetyReaped: SAFETY_REAPED.slice() });
        }
    }

    // R.9 子进程自登记：没有任何登记文件 → 抛 REAP_NO_REGISTRY（不悄悄成功）；有 SDH_REAP_REGISTRY 的成功路径由 H / P / T 节的桩成员实测
    {
        const saved = { a: process.env.SDH_REAP_REGISTRY, b: process.env.S2C_TEST_REGISTRY };
        delete process.env.SDH_REAP_REGISTRY; delete process.env.S2C_TEST_REGISTRY;
        let e = null;
        try { reapLib.registerSelfFromEnv('self-none'); } catch (x) { e = x; } finally { if (saved.a !== undefined) process.env.SDH_REAP_REGISTRY = saved.a; if (saved.b !== undefined) process.env.S2C_TEST_REGISTRY = saved.b; }
        check('R.9', 'registerSelfFromEnv：没有可用的登记文件时抛 REAP_NO_REGISTRY（调用方应在派生任何长寿子进程之前退出）', errCode(e) === 'REAP_NO_REGISTRY', e && e.message);
    }

    // R.10 预加载片段包住的启动器：登记写失败 → 先 stop() 刚起的实例再抛错（不留孤儿），成员判红且未执行；登记失败记入 reaper.failures（写失败不吞）
    {
        const away = `${REGISTRY_FILE}.away`;
        const dirsBefore = tmpInstanceDirs().length;
        const rf = mk('R', 'rf', 'report', { needsService: true });
        // 预置一条「R.10 之前已有的真实登记失败」（哨兵）：R.10 只许撤销它自己造成的失败（记下调用前的长度、之后 splice），不许整体清空（收口小批第 8 项 / 预筛 v3 L5）
        const preexisting = new reapLib.ReapError('REAP_REGISTRY_WRITE_FAILED', 'R.10 预置的登记失败哨兵（模拟 R.10 之前已有的一条真实登记失败）');
        REAPER.failures.push(preexisting);
        const failsBefore = REAPER.failures.length;
        try {
            fs.renameSync(REGISTRY_FILE, away);   // 登记文件「被删」：此刻没有别的写入者（场景串行）
            let scn = null;
            try { scn = await PRE.withProbe(() => runScn([rf], { deadlineMs: 60000 })); } finally { fs.renameSync(away, REGISTRY_FILE); }
            const r = scn.by(rf.label);
            const failsSeen = REAPER.failures.length - failsBefore;
            REAPER.failures.splice(failsBefore, failsSeen);   // 这次写失败是本用例故意造的：只撤销它自己造成的那几条，末尾 Z.2 仍要求套件真正的登记没有失败（闸门读的也是这个数组）
            check('R.10', '登记写失败（登记文件被删）：启动器刚交出的实例被先 stop()（私有根里没有多出数据根、没有登记到任何实例），成员判红且未执行，原因带 REAP_REGISTRY_WRITE_FAILED；失败记入 reaper.failures（恰好新增 1 条）',
                !!r && r.ok === false && r.executed === false && /REAP_REGISTRY_WRITE_FAILED/.test(r.notes.join('|')) && tmpInstanceDirs().length === dirsBefore && scn.regs.length === 0 && rep(rf) === null && failsSeen === 1, { r, dirs: tmpInstanceDirs(), regs: scn.regs.length, failsSeen });
            // R.10b：R.10 之前已有的那条真实登记失败在 R.10 撤销自己的失败之后仍在，闸门因此不放行（原因含「登记失败 1 次」）
            const gateKept = REAPER.finalGate({ pendingStarts: 0, pendingTimedOut: false, reap: EMPTY_REAP, reapErr: null, sweep: { kept: [], failed: [] } });
            check('R.10b', 'R.10 只撤销它自己造成的那条失败：R.10 之前已有的一条登记失败在 R.10 之后仍在 reaper.failures 里，闸门不放行且原因含「登记失败 1 次」',
                REAPER.failures.includes(preexisting) && REAPER.failures.length === failsBefore && gateKept.safe === false && gateKept.reasons.some((x) => /登记失败 1 次/.test(x)), { failures: REAPER.failures.length, failsBefore, kept: REAPER.failures.includes(preexisting), reasons: gateKept.reasons });
        } finally {
            const at = REAPER.failures.indexOf(preexisting);
            if (at >= 0) REAPER.failures.splice(at, 1);   // 哨兵是本用例预置的，用完撤掉：末尾 Z.2 / 闸门仍要求套件真正的登记没有失败
        }
    }

    // R.11（第十条闸门 + 对接小项）：finalGate 自动带上登记失败；返回值带 verify（不必再调一次终检）；reapAll 的 total 不含被 skip 的条目
    {
        let idCalls = 0;
        const fpG = fakeProc({ identity: () => { idCalls += 1; return { state: 'dead' }; } });
        const { reaper: rg } = unitReaper(fpG);
        rg.register({ kind: 'proc', pid: 9701, startTime: T0, label: 'g1' });
        rg.register({ kind: 'proc', pid: 9702, startTime: T0, label: 'g2' });
        const rpG = await rg.reapAll({ deadlineMs: 3000 });
        idCalls = 0;
        const g0 = rg.finalGate({ pendingStarts: 0, pendingTimedOut: false, reap: rpG, reapErr: null, sweep: { kept: [], failed: [] } });
        const callsOneGate = idCalls;
        const g1 = rg.finalGate({ pendingStarts: 0, pendingTimedOut: false, reap: rpG, reapErr: null, sweep: { kept: [], failed: [] }, registrationFailures: 2 });
        const { reaper: rf } = unitReaper(fpG);
        rf.register({ kind: 'proc', pid: 9703, startTime: T0, label: 'f1' });
        try { rf.register({ kind: 'proc', pid: 9704, startTime: 'bad', label: 'f2' }); } catch (_) { /* 登记失败记入 failures */ }
        const rpF = await rf.reapAll({ deadlineMs: 3000 });
        const gF = CLEAN_GATE(rf, rpF);
        check('R.11', 'finalGate：全部登记进程已有退出证据且无登记失败 → 放行；调用方传 registrationFailures: 2 → 不放行且恰好一条原因；回收器自己有 1 次登记失败（进程都已消失）→ 不放行且恰好一条原因（自动带上 failures.length）；'
            + '返回值带 verify（ok / bad / total=2），一次 finalGate 只做 2 次身份查询（每个条目一次，没有第二遍终检）',
            g0.safe === true && g0.reasons.length === 0 && !!g0.verify && g0.verify.ok === true && g0.verify.total === 2 && Array.isArray(g0.verify.bad) && callsOneGate === 2
            && g1.safe === false && g1.reasons.length === 1 && /登记失败 2 次/.test(g1.reasons[0]) && gF.safe === false && gF.reasons.length === 1 && /登记失败 1 次/.test(gF.reasons[0]) && !!gF.verify && gF.verify.ok === true,
            { g0, callsOneGate, g1, gF });
        const { reaper: rs } = unitReaper(fakeProc({ identity: () => ({ state: 'dead' }) }));
        for (const p of [9721, 9722, 9723]) rs.register({ kind: 'proc', pid: p, startTime: T0, label: `s${p}` });
        const rpS = await rs.reapAll({ deadlineMs: 3000, skip: (e) => e.rec.pid === 9722 });
        check('R.12', 'reapAll 的 total 只计本次处理的条目、不含被 skip 的（与注释一致）：3 条登记、skip 1 条 → total 2 = gone 2 + left 0，新增字段 skipped = 1；不带 skip 时 skipped = 0 且 total = 全部', rpS.total === 2 && rpS.skipped === 1 && rpS.gone.length + rpS.left.length === rpS.total && rpG.skipped === 0 && rpG.total === 2, { rpS: { total: rpS.total, skipped: rpS.skipped, gone: rpS.gone.length, left: rpS.left.length }, rpG: { total: rpG.total, skipped: rpG.skipped } });
    }

    // R.13（收口小批第 2 项 / 14-R2 L / 预筛 v3 L3）：闸门的数值输入 fail-closed——
    //   ① evalDeleteGate：registrationFailures 给了但不是非负安全整数（字符串 / 布尔 / NaN / Infinity / 负数 / 小数 / null）→ 一律不放行且恰好一条原因；不给或给合法的 0 → 放行；合法的 3 → 不放行（原因含「登记失败 3 次」）；
    //   ② finalGate：外部计数不能抵消本回收器自己的失败（本地 1 + 外部 -1 / 外部 0 / 外部字符串 → 都不放行），本回收器没有失败时外部非法值仍不放行；调用方传的 ownRegistrationFailures 覆盖不了本回收器的失败
    {
        const base13 = { pendingStarts: 0, pendingTimedOut: false, reap: { left: [], timedOut: false, problems: [] }, reapErr: null, sweep: { kept: [], failed: [] }, verify: { ok: true, bad: [], problems: [] } };
        const odd = [['字符串 "1"', '1'], ['字符串 "0"', '0'], ['布尔 true', true], ['布尔 false', false], ['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity], ['负数 -1', -1], ['小数 1.5', 1.5], ['null', null], ['对象', {}], ['数组 [1]', [1]], ['超出安全整数', Number.MAX_SAFE_INTEGER + 2]];
        const oddBad = [];
        for (const [name, v] of odd) { const g = reapLib.evalDeleteGate(Object.assign({}, base13, { registrationFailures: v })); if (g.safe !== false || g.reasons.length !== 1 || !/登记失败/.test(g.reasons[0])) oddBad.push({ name, g }); }
        const ownOdd = reapLib.evalDeleteGate(Object.assign({}, base13, { ownRegistrationFailures: -1 }));
        const ctlZero = reapLib.evalDeleteGate(Object.assign({}, base13, { registrationFailures: 0, ownRegistrationFailures: 0 }));
        const ctlThree = reapLib.evalDeleteGate(Object.assign({}, base13, { registrationFailures: 3 }));
        const ctlSum = reapLib.evalDeleteGate(Object.assign({}, base13, { registrationFailures: 2, ownRegistrationFailures: 1 }));
        const gateAs = (reaper, over) => reaper.finalGate(Object.assign({ pendingStarts: 0, pendingTimedOut: false, reap: EMPTY_REAP, reapErr: null, sweep: { kept: [], failed: [] } }, over || {}));
        const { reaper: r13a } = unitReaper(fakeProc({ identity: () => ({ state: 'dead' }) }));
        try { r13a.register({ kind: 'proc', pid: 9751, startTime: 'bad', label: 'r13-local-failure' }); } catch (_) { /* 本回收器记下 1 次登记失败 */ }
        const { reaper: r13b } = unitReaper(fakeProc({ identity: () => ({ state: 'dead' }) }));
        const local1 = [['外部 -1', -1], ['外部 0', 0], ['外部 "3"', '3'], ['外部 NaN', NaN], ['外部 true', true], ['不给', undefined]].map(([name, v]) => ({ name, g: gateAs(r13a, v === undefined ? {} : { registrationFailures: v }) }));
        const local1Bad = local1.filter((x) => x.g.safe !== false || x.g.reasons.length !== 1 || !/登记失败/.test(x.g.reasons[0]));
        const spoofOwn = gateAs(r13a, { ownRegistrationFailures: 0 });
        const cleanLocal = [gateAs(r13b, {}), gateAs(r13b, { registrationFailures: 0 })];
        const dirtyExt = [['外部 -1', -1], ['外部 "1"', '1'], ['外部 NaN', NaN], ['外部 Infinity', Infinity], ['外部 true', true]].map(([name, v]) => ({ name, g: gateAs(r13b, { registrationFailures: v }) }));
        const dirtyExtBad = dirtyExt.filter((x) => x.g.safe !== false || x.g.reasons.length !== 1 || !/登记失败/.test(x.g.reasons[0]));
        check('R.13', `闸门数值输入 fail-closed：evalDeleteGate 对 ${odd.length} 种非法 registrationFailures 一律不放行且恰好一条原因；非法 ownRegistrationFailures 同样不放行；对照：0 / 0 放行、3 → 不放行（含「登记失败 3 次」）、2 + 1 → 「登记失败 3 次」；`
            + 'finalGate：本回收器有 1 次登记失败时，外部 -1 / 0 / "3" / NaN / true / 不给 → 全部不放行（外部计数不能抵消），调用方传 ownRegistrationFailures: 0 也覆盖不了；本回收器没有失败时外部 0 / 不给放行，外部 -1 / "1" / NaN / Infinity / true 不放行',
            oddBad.length === 0 && ownOdd.safe === false && ownOdd.reasons.length === 1 && ctlZero.safe === true && ctlThree.safe === false && /登记失败 3 次/.test(ctlThree.reasons[0]) && ctlSum.safe === false && /登记失败 3 次/.test(ctlSum.reasons[0])
            && r13a.failures.length === 1 && local1Bad.length === 0 && spoofOwn.safe === false && /登记失败 1 次/.test(spoofOwn.reasons[0])
            && r13b.failures.length === 0 && cleanLocal.every((g) => g.safe === true) && dirtyExtBad.length === 0,
            { oddBad, ownOdd, ctlZero, ctlThree, ctlSum, local1Bad, spoofOwn, cleanLocal: cleanLocal.map((g) => g.safe), dirtyExtBad });
    }

    // R.14（收口小批第 3 项 / 预筛 v3 L4）：trackInstance 收到没有 pid 的句柄 → 抛 REAP_BAD_RECORD **且先记入 failures**，直接调 API 闸门也不放行（原先抛错但不计失败）
    {
        const { reaper: r14 } = unitReaper(fakeProc({ identity: () => ({ state: 'dead' }) }));
        const errs = [];
        for (const [name, h] of [['没有 pid', { stop: async () => {} }], ['null', null], ['pid 是字符串', { pid: '12', stop: async () => {} }], ['pid 是 NaN', { pid: NaN }]]) {
            const before = r14.failures.length;
            let e = null; try { r14.trackInstance(`r14-${name}`, h); } catch (x) { e = x; }
            errs.push({ name, code: errCode(e), grew: r14.failures.length - before });
        }
        const rp14 = await r14.reapAll({ deadlineMs: 2000 });
        const g14 = CLEAN_GATE(r14, rp14);
        check('R.14', 'trackInstance 收到没有 pid 的句柄（缺 pid / null / 字符串 pid / NaN）：每次都抛 REAP_BAD_RECORD 且 failures 恰好 +1（先记失败再抛）；全部登记失败累计 4 次，闸门不放行且原因含「登记失败 4 次」（没有任何进程条目，不是靠回收失败挡住的）',
            errs.every((x) => x.code === 'REAP_BAD_RECORD' && x.grew === 1) && r14.failures.length === 4 && rp14.total === 0 && g14.safe === false && g14.reasons.length === 1 && /登记失败 4 次/.test(g14.reasons[0]), { errs, failures: r14.failures.length, rp14: rp14.total, g14 });
    }
}
const ISO_OK = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/.test(s);

// ================================================================ 节 S：守卫覆盖（14T M4）：file: URI / 异步读取 / Buffer / URL；两层守卫都在真正读取前拒绝
async function sectionS() {
    console.log('\n== 节 S：sqlite 路径守卫与 .env 读取守卫的覆盖 ==');
    // S.1 解析函数（纯）
    const P = (f) => PRE.parseSqliteTarget(f);
    const rs = path.resolve;
    const table = [
        ['空串', '', { kind: 'memory' }], [':memory:', ':memory:', { kind: 'memory' }], ['file::memory:', 'file::memory:', { kind: 'memory' }],
        // 内存库只认上面三个字面串（硬门，不加智能放行）：mode=memory（含重复 mode）、file::memory:?cache=shared 都按路径部分核
        ['mode=memory 不再放行', 'file:x.db?mode=memory', { kind: 'path', abs: rs('x.db') }], ['重复 mode=memory&mode=rwc', 'file:///C:/z/a.db?mode=memory&mode=rwc', { kind: 'path', abs: rs('C:/z/a.db') }],
        ['mode=ro&mode=memory', 'file:///C:/z/a.db?mode=ro&mode=memory', { kind: 'path', abs: rs('C:/z/a.db') }], ['file::memory: 带查询串', 'file::memory:?cache=shared', { kind: 'path', abs: rs(':memory:') }],
        ['普通路径', 'C:\\z\\a.db', { kind: 'path', abs: rs('C:\\z\\a.db') }], ['file:/// 盘符', 'file:///C:/z/a.db', { kind: 'path', abs: rs('C:/z/a.db') }], ['file://localhost/', 'file://localhost/C:/z/a.db', { kind: 'path', abs: rs('C:/z/a.db') }],
        ['file: 无斜杠', 'file:C:/z/a.db', { kind: 'path', abs: rs('C:/z/a.db') }], ['百分号解码', 'file:///C:/z/a%20b.db', { kind: 'path', abs: rs('C:/z/a b.db') }], ['带查询串', 'file:///C:/z/a.db?mode=ro&cache=shared', { kind: 'path', abs: rs('C:/z/a.db') }],
        ['带片段', 'file:///C:/z/a.db#frag', { kind: 'path', abs: rs('C:/z/a.db') }], ['相对路径', 'file:rel/a.db', { kind: 'path', abs: rs('rel/a.db') }],
        ['非 localhost authority', 'file://evil-host/share/a.db', { kind: 'reject' }], ['坏的百分号编码', 'file:%ZZ.db', { kind: 'reject' }], ['空路径', 'file:', { kind: 'reject' }], ['路径含 NUL', 'file:///C:/z/%00.db', { kind: 'reject' }],
        ['Buffer', Buffer.from('C:\\z\\a.db'), { kind: 'reject' }], ['undefined', undefined, { kind: 'reject' }],
    ];
    const tbad = [];
    for (const [name, input, want] of table) {
        const got = P(input);
        const same = got.kind === want.kind && (want.kind !== 'path' || fold(got.abs) === fold(want.abs));
        if (!same) tbad.push({ name, got, want });
    }
    check('S.1', `sqlite 文件名解析（纯函数，${table.length} 种写法）：内存库 / 普通路径 / file: URI（三斜杠、localhost、无斜杠、百分号解码、查询串、片段、相对路径）解析出真实路径；非 localhost authority / 坏编码 / 空路径 / NUL / 非字符串一律拒绝`, tbad.length === 0, tbad);

    // 守卫探针：只碰不存在的路径
    const uniq = crypto.randomBytes(4).toString('hex');
    const outsideDir = path.join(REAL_TMP, `sdh-guard-probe-nonexistent-${uniq}`);
    const relName = `sdh-guard-probe-rel-${uniq}.db`;   // 相对 URI 探针的唯一文件名（每层按各自 cwd 解析）
    const relSuite = path.resolve('..', relName);
    const relHelper = path.resolve(PRIV, '..', relName);   // 辅助进程的 cwd 是私有根
    const insideDir = path.join(PRIV, 'probe-in');
    fs.mkdirSync(insideDir, { recursive: true });
    const cfgFile = path.join(PRIV, 'probe-cfg.json');
    // 联接逃逸夹具：私有根内的联接 → 私有根外一个新建的空目录（用完 rmdirSync 联接再 rmdirSync 目标，不用 rmSync）。
    // 目标目录与联接各自 try / finally，记录是否创建成功；善后只删本次创建的联接与已确认为空的目标目录，清理失败记具体路径（挡住删除私有根）
    const jTarget = path.join(REAL_TMP, `sdh-guard-probe-jtarget-${uniq}`);
    const jLink = path.join(insideDir, 'jx');
    let jTargetMade = false;
    let jLinkMade = false;
    let jTargetEmpty = null;
    const foreignDecoy = path.join(REAL_TMP, `sdh-guard-probe-foreign-${uniq}`);
    let foreignMade = false;
    let suiteRows = null; let sa = null; let probesBefore = 0; let violationsBefore = 0; let hr = null; let helperRows = null; let ha = null;
    const probe = require(PROBE_JS);
    const analyze = (rows) => {
        const wrongTrip = rows.filter((r) => r.expectTrip && !r.tripped).map((r) => ({ id: r.id, err: r.err }));
        const wrongCtl = rows.filter((r) => !r.expectTrip && r.tripped).map((r) => ({ id: r.id, err: r.err }));
        const ctlInsideBroken = rows.filter((r) => /^(db\.ctl-|env\.ctl-inside)/.test(r.id) && r.err !== null).map((r) => ({ id: r.id, err: r.err }));
        return { wrongTrip, wrongCtl, ctlInsideBroken, trips: rows.filter((r) => r.tripped).length, n: rows.length, db: rows.filter((r) => r.kind === 'db'), env: rows.filter((r) => r.kind === 'env') };
    };
    // 「别人的」探针残留：TEMP 里放一个同前缀但不是本次生成的文件，S.7 只核本次生成的路径，不能被它干扰（并行的另一份套件 / 保留的失败现场就是这种情形）。它在 S.7 判定之后才删
    try {
        fs.writeFileSync(foreignDecoy, 'foreign');
        foreignMade = true;
    } catch (e) { OUTSIDE_FAILS.push(`别人的探针残留替身 ${foreignDecoy} 创建失败：${describeFsErr(e)}`); }
    try {
        try {
            fs.mkdirSync(jTarget);
            jTargetMade = true;
            fs.symlinkSync(jTarget, jLink, 'junction');
            jLinkMade = true;
            if (INJECT_FAULT === 'sfixture') throw new Error('INJECTED_S_FIXTURE_FAULT');
            fs.writeFileSync(cfgFile, J({ outsideDir, insideDir, junctionDir: jLink, relName }));
            // 第一层：套件进程（同一个预加载片段）
            probesBefore = PRE.probes().length;
            violationsBefore = PRE.violations().length;
            suiteRows = await PRE.withProbe(() => probe.runProbes({ outsideDir, insideDir, junctionDir: jLink, relName }));
            sa = analyze(suiteRows);
            const envTrips = 14 + (typeof process.loadEnvFile === 'function' ? 2 : 0);
            check('S.2', `第一层（套件进程）· sqlite：${sa.db.filter((r) => r.expectTrip).length} 种越界写法（普通路径、file:/// 绝对、localhost、无斜杠、相对、百分号编码、带查询串、重复 mode=memory&mode=rwc / mode=memory&mode=ro / 只有 mode=memory、非法 authority / 编码 / 空、非字符串、sqlite3.cached.Database 的普通路径与 URI、私有根内联接指向根外目录的普通路径与 URI）全部在打开之前被拒绝（GUARD_TRIPPED）；对照：内存库 / file::memory: / 私有根内的普通路径与 URI / cached.Database 打开私有根内的库 照常打开`,
                sa.db.every((r) => (r.expectTrip ? r.tripped : (!r.tripped && r.err === null))) && sa.db.length >= 15 && ['db.uri-dup-mode-memory-rwc', 'db.uri-dup-mode-memory-ro', 'db.uri-mode-memory-only', 'db.cached-plain', 'db.cached-uri'].every((id) => sa.db.some((r) => r.id === id && r.tripped)), sa.db.filter((r) => (r.expectTrip ? !r.tripped : (r.tripped || r.err !== null))));
            check('S.3', '第一层（套件进程）· .env：readFileSync / readFile（回调）/ promises.readFile × 字符串 / Buffer / file: URL 共 9 种，外加 openSync、createReadStream、.env.local 变体、process.loadEnvFile（字符串 / URL）、私有根内联接指向根外目录里的 .env（同步 / promises），全部在读取之前被拒绝；对照：私有根内的 .env 三种 API 与 loadEnvFile 都能读，私有根外的非 .env 路径不被拦（得到 ENOENT）',
                sa.env.every((r) => (r.expectTrip ? r.tripped : !r.tripped)) && sa.env.filter((r) => r.expectTrip).length === envTrips && sa.ctlInsideBroken.length === 0, sa.env.filter((r) => (r.expectTrip ? !r.tripped : r.tripped)).concat(sa.ctlInsideBroken));
            check('S.4', '第一层的违规记录走探针通道（probes）而不是 violations：探针新增了与越界写法数相等的 probes，套件的 violations 没有增加（末尾 Z.1 / Z.2 仍要求为空）', PRE.probes().length - probesBefore === sa.trips && PRE.violations().length === violationsBefore, { probes: PRE.probes().length - probesBefore, trips: sa.trips, violations: PRE.violations().length - violationsBefore });
            // 第二层：装了同一个预加载片段的辅助进程
            const hp = startHelper(PROBE_JS, [cfgFile], { owner: 'probe-helper', markers: ['PROBE_RESULT'], expectViolations: true });
            hr = await hp.wait(60000);
            const mm = /PROBE_RESULT (\[.*\])/.exec(hr.stdout);
            helperRows = mm ? JSON.parse(mm[1]) : null;
            ha = helperRows ? analyze(helperRows) : null;
            check('S.5', '第二层（辅助进程，node --require 同一个预加载片段）· 同样的 sqlite 与 .env 探针：越界全部被拒绝、对照全部放行（两层守卫都在真正打开 / 读取之前拒绝）',
                !!ha && hr.code === 0 && helperRows.every((r) => (r.expectTrip ? r.tripped : !r.tripped)) && ha.ctlInsideBroken.length === 0 && helperRows.length === suiteRows.length, ha ? { wrongTrip: ha.wrongTrip, wrongCtl: ha.wrongCtl, ctl: ha.ctlInsideBroken, code: hr.code } : { out: hr.stdout.slice(-300), err: hr.stderr.slice(-300) });
            const hv = hr.violations;
            check('S.6', '第二层的违规写到该辅助进程专属的违规记录文件里：条数等于被拒绝的探针数，db 与 env 两类都有（父进程能读到）', !!ha && hv.length === ha.trips && hv.some((v) => v.kind === 'db') && hv.some((v) => v.kind === 'env'), { violations: hv.length, trips: ha && ha.trips });
            jTargetEmpty = fs.readdirSync(jTarget).length === 0;   // 联接目标目录在探针期间必须仍是空的——守卫失效也没有建出任何文件
        } finally {
            // 善后：只删本次创建的联接（rmdirSync 联接本身，不跟随）与已确认为空的目标目录；失败记具体路径，挡住删除私有根
            if (jLinkMade) {
                try { fs.rmdirSync(jLink); } catch (e) { OUTSIDE_FAILS.push(`联接 ${jLink} 删除失败：${describeFsErr(e)}`); }
            }
            if (jTargetMade) {
                try {
                    if (fs.readdirSync(jTarget).length === 0) fs.rmdirSync(jTarget);
                    else OUTSIDE_FAILS.push(`根外目标目录 ${jTarget} 不是空的（不删，需人工核对）`);
                } catch (e) { OUTSIDE_FAILS.push(`根外目标目录 ${jTarget} 删除失败：${describeFsErr(e)}`); }
            }
        }
        check('S.7', '守卫失效时也不会碰真实文件、夹具善后干净：只核本次生成的路径（唯一名）——越界目录没有被建出来，联接指向的根外空目录探针期间仍是空的，联接与根外目标目录已删，两层相对 URI 探针的目标文件都不存在；善后没有失败项（不扫整个 TEMP）',
            !fs.existsSync(outsideDir) && jTargetEmpty === true && !fs.existsSync(relSuite) && !fs.existsSync(relHelper) && !fs.existsSync(jTarget) && lstatOrNull(jLink) === null && OUTSIDE_FAILS.length === 0,
            { outsideExists: fs.existsSync(outsideDir), jTargetEmpty, relSuite: fs.existsSync(relSuite), relHelper: fs.existsSync(relHelper), jTargetStill: fs.existsSync(jTarget), outsideFails: OUTSIDE_FAILS.slice() });
    } finally {
        if (foreignMade) {
            try { fs.unlinkSync(foreignDecoy); } catch (e) { OUTSIDE_FAILS.push(`别人的探针残留替身 ${foreignDecoy} 删除失败：${describeFsErr(e)}`); }
        }
    }

    // S.8 / S.9（收口小批第 4 项 / 14T-R2 M3 / 预筛 v3 L2）：process.loadEnvFile 的**默认路径**判别用例。上面的探针只调显式字符串 / URL，漏掉 p === undefined / p == null 分支时两层探针仍会全绿。
    //   做法：在套件自建的私有根外空目录（cwd）里造一个**合成** .env（内容是假的标记变量），辅助进程以该目录为 cwd，守卫的私有根设成另一个受控子目录（PRIV/envdef-priv）；
    //   分别调 loadEnvFile() / loadEnvFile(null) / loadEnvFile(undefined)，要求全部 GUARD_TRIPPED 且合成变量没被加载进辅助进程。对照：cwd 在守卫私有根内、里面有合成 .env → 三种调用都读得到。
    //   全程不碰任何真实 .env：cwd 必须是本用例自建的目录；spawn 之前和善后之后各断言一次 cwd 不在任何检出（向上没有 .git，也不在本套件所在的检出之内）。
    if (typeof process.loadEnvFile !== 'function') console.log('NOTE S.8 / S.9 当前 Node 没有 process.loadEnvFile，跳过默认路径判别用例');
    else {
        const envCwd = path.join(REAL_TMP, `sdh-guard-probe-envcwd-${crypto.randomBytes(4).toString('hex')}`);
        const altPriv = path.join(PRIV, 'envdef-priv');
        const MARK_LINE = 'SDH_SYNTHETIC_ENV_MARKER=synthetic\n';
        const notInCheckout = (dir) => {
            const repoRoot = path.resolve(WBS, '..');
            const abs = path.resolve(dir);
            if (fold(abs).startsWith(fold(repoRoot) + path.sep) || fold(abs) === fold(repoRoot)) return { ok: false, why: `在本套件所在的检出 ${repoRoot} 之内` };
            for (let d = abs; ;) {
                if (fs.existsSync(path.join(d, '.git'))) return { ok: false, why: `${d} 下有 .git（在某个检出里）` };
                const up = path.dirname(d);
                if (up === d) break;
                d = up;
            }
            return { ok: true, why: null };
        };
        const outsideFailsBefore = OUTSIDE_FAILS.length;
        let cwdMade = false; let envFileMade = false;
        let pre = { ok: false, why: '未检查' }; let post = { ok: false, why: '未检查' };
        let outR = null; let inR = null; let outRows = null; let inRows = null; let outCwd = null; let inCwd = null;
        const parseRes = (r) => { const m = /ENVDEF_RESULT (\{.*\})/.exec(r.stdout); return m ? JSON.parse(m[1]) : null; };
        const realOrSelf = (p) => { try { return fs.realpathSync.native(p); } catch (_) { return p; } };
        try {
            fs.mkdirSync(envCwd); cwdMade = true;
            fs.writeFileSync(path.join(envCwd, '.env'), MARK_LINE); envFileMade = true;
            fs.mkdirSync(altPriv);
            fs.writeFileSync(path.join(altPriv, '.env'), MARK_LINE);
            pre = notInCheckout(envCwd);
            if (pre.ok) {
                const ho = startHelper(ENVDEF_JS, [], { cwd: envCwd, owner: 'envdef-out', markers: ['ENVDEF_RESULT'], expectViolations: true, extraEnv: { SDH_REAP_PRIV: altPriv } });
                outR = await ho.wait(60000);
                const jo = parseRes(outR);
                outRows = jo && jo.rows; outCwd = jo && jo.cwd;
                const hi = startHelper(ENVDEF_JS, [], { cwd: altPriv, owner: 'envdef-in', markers: ['ENVDEF_RESULT'], extraEnv: { SDH_REAP_PRIV: altPriv } });
                inR = await hi.wait(60000);
                const ji = parseRes(inR);
                inRows = ji && ji.rows; inCwd = ji && ji.cwd;
            }
        } catch (e) { OUTSIDE_FAILS.push(`S.8 夹具异常：${describeFsErr(e)}`); } finally {
            if (envFileMade) { try { fs.unlinkSync(path.join(envCwd, '.env')); } catch (e) { OUTSIDE_FAILS.push(`合成 .env ${path.join(envCwd, '.env')} 删除失败：${describeFsErr(e)}`); } }
            if (cwdMade) { try { fs.rmdirSync(envCwd); } catch (e) { OUTSIDE_FAILS.push(`默认路径判别用例的 cwd 目录 ${envCwd} 删除失败：${describeFsErr(e)}`); } }
            post = notInCheckout(envCwd);
        }
        const names = ['noarg', 'null', 'undefined'];
        const rowsOk = (rows) => Array.isArray(rows) && rows.length === 3 && names.every((n, i) => rows[i].id === n);
        check('S.8', 'process.loadEnvFile 默认路径（cwd 在守卫私有根之外、里面有合成 .env）：loadEnvFile() / loadEnvFile(null) / loadEnvFile(undefined) 三种调用都 GUARD_TRIPPED，合成标记变量没被加载；辅助进程的违规记录恰好 3 条 env；cwd 在 spawn 之前与善后之后都不在任何检出里，辅助进程报告的 cwd 就是本用例自建的目录',
            pre.ok && post.ok && !!outR && outR.code === 0 && rowsOk(outRows) && outRows.every((r) => r.tripped === true && r.loaded === false) && outR.violations.length === 3 && outR.violations.every((v) => v.kind === 'env') && !!outCwd && fold(realOrSelf(outCwd)) === fold(realOrSelf(envCwd)) && OUTSIDE_FAILS.length === outsideFailsBefore,
            { pre, post, code: outR && outR.code, rows: outRows, violations: outR && outR.violations, outCwd, envCwd, outsideFails: OUTSIDE_FAILS.slice(), out: outR && outR.stdout.slice(-300), err: outR && outR.stderr.slice(-300) });
        check('S.9', '对照：cwd 在守卫私有根内（里面有合成 .env）时 loadEnvFile() / loadEnvFile(null) / loadEnvFile(undefined) 三种调用都不被拦、合成标记变量被加载，没有违规记录（证明 S.8 的拦截来自「cwd 在根外」而不是调用本身被一律拒绝）',
            !!inR && inR.code === 0 && rowsOk(inRows) && inRows.every((r) => r.tripped === false && r.loaded === true && r.err === null) && inR.violations.length === 0 && !!inCwd && fold(realOrSelf(inCwd)) === fold(realOrSelf(altPriv)),
            { code: inR && inR.code, rows: inRows, violations: inR && inR.violations, inCwd, altPriv, out: inR && inR.stdout.slice(-300), err: inR && inR.stderr.slice(-300) });
    }
}

// ================================================================ 节 T：监督层（修复批第 7 项）：孙进程启动后强杀套件 / 成员先退出后强杀套件
async function runSupervised(tag, mode, timeoutMs) {
    const regFile = path.join(PRIV, `t-${tag}.jsonl`);
    const prep = reapLib.initRegistry(regFile);
    const pidFile = path.join(OUT_DIR, `T-${tag}.json`);
    const env = Object.assign({}, process.env, { SDH_REAP_REGISTRY: regFile, SDH_REAP_OWNER: `t-${tag}`, STANDIN_BATCH: BATCH_PATH, STUB_MEMBER_JS: MEMBER_JS, STANDIN_CWD: WBS, STUB_REAP_LIB: REAP_PATH });
    delete env.SDH_REAP_VIOLATIONS;
    delete env.SDH_REAP_TI;
    const sup = spawn(process.execPath, [ENTRY_PATH, '--skip-selftest', `--test-suite=${STANDIN_JS}`, `--timeout-ms=${timeoutMs}`, '--kill-deadline-ms=15000', '--reap-deadline-ms=30000', mode, pidFile, `T.${tag}`], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    track(`sup-${tag}`, sup);
    let out = '';
    sup.stdout.on('data', (c) => { out += c; });
    sup.stderr.on('data', (c) => { out += c; });
    const closed = new Promise((resolve) => { sup.once('close', () => resolve(true)); sup.once('error', () => resolve(true)); });
    const done = await Promise.race([closed, sleep(timeoutMs + 90000).then(() => false)]);
    let killed = false;
    if (!done) { killed = true; try { sup.kill(); } catch (_) { /* 下面确认 */ } await Promise.race([closed, sleep(5000)]); }
    const ph = readJsonFile(pidFile);
    const ids = hangIds(ph);
    // 在善后之前先记下状态，再由套件按身份回收（被测机制失效时不留孤儿）
    const before = ids ? { member: identityState(ids.member.pid, ids.member.start), grand: identityState(ids.grand.pid, ids.grand.start) } : null;
    const leftover = [];
    if (ids) {
        for (const [role, id] of [['member', ids.member], ['grand', ids.grand]]) {
            if (identityState(id.pid, id.start) === 'match') {
                leftover.push(role);
                try { procLib.killIfIdentity({ pid: id.pid, start_time: id.start }); } catch (_) { /* 最外层回收兜底 */ }
            }
        }
    }
    // 把子进程登记进套件自己的回收器（它们登记在隔离的登记文件里，最外层闸门也要覆盖）
    // 登记失败不吞：REAPER.register 先把记录放进回收器内存再落盘，写失败时抛错并记入 REAPER.failures——条目仍在内存里供最外层 reapAll 回收，
    // 而 failures 非空会让 Z.2 判红、最终闸门（finalGate 自动带上 failures.length，第十条）不放行。这里的 catch 只是不让一次登记失败打断后面的登记。
    for (const rec of reapLib.readRegistryFile(regFile).records) { try { REAPER.register({ kind: rec.kind, pid: rec.pid, startTime: rec.startTime, label: `${rec.label}@${tag}`, owner: rec.owner }); } catch (_) { /* 已记入 REAPER.failures，最终闸门不放行 */ } }
    return { out, code: sup.exitCode, signal: sup.signalCode, exited: done, killed, ids, before, leftover, prep, regRecords: reapLib.readRegistryFile(regFile).records };
}
async function sectionT() {
    console.log('\n== 节 T：监督层回收（强杀套件之后按身份回收）==');
    const TOUT = 20000;
    const goneBoth = (r) => !!r.ids && r.before && ['dead', 'reused'].includes(r.before.member) && ['dead', 'reused'].includes(r.before.grand);
    const reapLine = (out) => { const m = /SUPERVISOR_REAP：进程登记 (\d+) 条；套件结束后仍存活并被监督进程按身份终止 (\d+) 个(?:（PID ([\d,]+)）)?/.exec(out); return m ? { total: Number(m[1]), killed: Number(m[2]), pids: (m[3] || '').split(',').filter(Boolean).map(Number) } : null; };
    // T.1 孙进程启动后强杀套件（成员仍活着）
    const t1 = await runSupervised('t1', 'hang', TOUT);
    const l1 = reapLine(t1.out);
    check('T.0', '监督层夹具初始化完成（成员与 detached 孙进程都已先登记，就绪文件已写）——与下面「按身份回收」分开报告', !!t1.ids, { cause: 'fixture-not-initialized', out: t1.out.slice(-300) });
    check('T.1', '孙进程启动后强杀套件（监督进程超时，退出码 2）：成员与 detached 孙进程按身份都已消失（不需要套件事后善后）；两者的登记（PID + 精确创建时间）都在登记文件里，监督进程报告登记 ≥ 2 条',
        t1.exited && t1.code === 2 && /SUPERVISOR_TIMEOUT/.test(t1.out) && goneBoth(t1) && t1.leftover.length === 0 && !!l1 && l1.total >= 2 && t1.regRecords.some((r) => /:member$/.test(r.label)) && t1.regRecords.some((r) => /:grandchild$/.test(r.label)),
        { code: t1.code, before: t1.before, leftover: t1.leftover, reap: l1, labels: t1.regRecords.map((r) => r.label), out: t1.out.slice(-500) });
    // T.2 成员先退出后强杀套件：detached 孙进程成了孤儿，进程树终止够不到它，只有按登记回收才行
    const t2 = await runSupervised('t2', 'orphan', TOUT);
    const l2 = reapLine(t2.out);
    check('T.2', '成员先退出（退出码 0）后强杀套件：detached 孙进程是孤儿（树终止够不到），监督进程按登记文件的「PID + 精确创建时间」把它回收了——SUPERVISOR_REAP 报告终止 ≥ 1 个且 PID 里有这个孙进程；成员与孙进程按身份都已消失',
        t2.exited && t2.code === 2 && !!t2.ids && goneBoth(t2) && t2.leftover.length === 0 && !!l2 && l2.killed >= 1 && l2.pids.includes(t2.ids.grand.pid), { code: t2.code, ids: t2.ids, before: t2.before, leftover: t2.leftover, reap: l2, out: t2.out.slice(-500) });
}


// ================================================================ 节 U：静态接线
async function sectionU() {
    console.log('\n== 节 U：静态接线 ==');
    const batchSrc = fs.readFileSync(BATCH_PATH, 'utf8');
    check('U.1', 'test-batch.js 不 require test-env（变量名自己生成）、不用 fs.rmSync / cpSync、通过 ti.startTestInstance 属性调用启动器（套件的登记包装才对它生效）、实例收尾显式 stop()',
        !/require\(\s*['"][^'"]*test-env['"]\s*\)/.test(batchSrc) && !/rmSync|cpSync/.test(batchSrc) && /ti\.startTestInstance\(/.test(batchSrc) && /\.stop\(\)/.test(batchSrc));
    const reapSrc = fs.readFileSync(REAP_PATH, 'utf8');
    const preSrc = fs.readFileSync(PRELOAD_PATH, 'utf8');
    check('U.1b', '共享回收模块与预加载片段：不用 fs.rmSync / cpSync；终止只走 killIfIdentity（身份）/ 句柄 kill / 句柄在手时的 killTree，没有按裸 PID 的 process.kill / taskkill；预加载片段先于被测模块装守卫并包住启动器',
        !/rmSync|cpSync/.test(reapSrc) && !/rmSync|cpSync/.test(preSrc) && !/process\.kill\(|taskkill/.test(reapSrc) && /killIfIdentity/.test(reapSrc) && /ti\.startTestInstance\s*=/.test(preSrc) && /sqlite3\.Database\s*=/.test(preSrc));
    delete require.cache[require.resolve(FAMILY_PATH)];
    const fam = require(FAMILY_PATH);
    const built = fam.buildFamilyMembers(WBS);
    const labels = built.members.map((x) => x.label);
    const missingFiles = built.members.filter((x) => !fs.existsSync(path.join(WBS, x.rel))).map((x) => x.rel);
    let normOk = true; let normErr = null;
    try { batch.normalizeMembers(built.members, { timeoutMs: 1000 }); } catch (e) { normOk = false; normErr = e.message; }
    const svcLabels6b = built.members.filter((x) => x.needsService || x.exclusive).map((x) => x.label);   // #106 S6b：需服务成员恰为 verify-html-fingerprint-e2e 一个（共享实例、只读）
    check('U.2', '真实 FAMILY 成员表：label 不重复、通过批跑核心的成员校验、每个成员脚本都存在；需服务登记恰一项（SERVICE_MEMBERS 全等 [{ label: verify-html-fingerprint-e2e, needsService: true }]，成员表里带 needsService / exclusive 的只有它，且不 exclusive）；含 verify-test-batch 与 S3b 的 verify-test-env；第一个成员是 verify-sys-* 自动扫描项',
        new Set(labels).size === labels.length && normOk && missingFiles.length === 0 && J(fam.SERVICE_MEMBERS) === J([{ label: 'verify-html-fingerprint-e2e', needsService: true }]) && J(svcLabels6b) === J(['verify-html-fingerprint-e2e']) && built.members.every((x) => !x.exclusive) && labels.includes('verify-test-batch') && labels.includes('verify-test-env') && labels.includes('verify-it-ledger --matrix') && /verify-sys-/.test(labels[0]) && built.bannerLabels.has(labels[0]),
        { dup: labels.length - new Set(labels).size, normErr, missingFiles, n: labels.length });
    check('U.3', '真实守卫表是七个静态守卫（前六个与旧版一致，第七个 verify-test-isolation-static 为 #106 S4a 新增；名单全等，不允许多或少）', J(fam.GUARDS) === J(['verify-unify-static', 'verify-badge-alias', 'verify-shared-css-cache-bust', 'verify-collab-validation-status-coverage', 'verify-db-connections-writers', 'verify-it-ledger-panel-static', 'verify-test-isolation-static']), fam.GUARDS);
    const base = { pendingStarts: 0, pendingTimedOut: false, reap: { left: [], timedOut: false, problems: [] }, reapErr: null, sweep: { kept: [], failed: [] }, verify: { ok: true, bad: [], problems: [] } };
    const flips = [
        ['待启动集合非空', { pendingStarts: 1 }], ['放弃的批跑没落定', { pendingTimedOut: true }], ['回收后仍有没有退出证据的条目', { reap: { left: [{ label: 'x', reason: 'no-start-time' }], timedOut: false, problems: [] } }],
        ['回收超截止', { reap: { left: [], timedOut: true, problems: [] } }], ['登记文件有读取失败 / 损坏行', { reap: { left: [], timedOut: false, problems: ['登记文件第 3 行不是合法 JSON'] } }], ['回收抛错', { reapErr: new Error('x') }],
        ['遗留清理有保留项', { sweep: { kept: [{ dir: 'd', reason: 'PROCESS_ALIVE(server)' }], failed: [] } }], ['遗留清理有失败项', { sweep: { kept: [], failed: [{ dir: 'd', error: 'e' }] } }],
        ['终检：登记进程没有全部按身份确认消失', { verify: { ok: false, bad: [{ label: 'x', reason: 'still-alive' }], problems: [] } }],
        ['登记失败（第十条，修复批 2）', { registrationFailures: 1 }],
        ['登记失败计数输入不合法（第十条 fail-closed，收口小批第 2 项）：负数', { registrationFailures: -1 }],
        ['登记失败计数输入不合法：字符串', { registrationFailures: '0' }],
    ];
    const gateBad = [];
    if (reapLib.evalDeleteGate(base).safe !== true) gateBad.push('baseline');
    for (const [name, over] of flips) { const g = reapLib.evalDeleteGate(Object.assign({}, base, over)); if (g.safe !== false || g.reasons.length !== 1) gateBad.push({ name, g }); }
    if (reapLib.evalDeleteGate(Object.assign({}, base, { registrationFailures: 0 })).safe !== true) gateBad.push('registrationFailures=0');
    check('U.5', '最终删私有根的闸门（共享模块 evalDeleteGate，S3b 13T-R H2 / S3c 14T H1 的教训）：基线安全（不给 registrationFailures 即默认 0，给 0 同样安全）；十个条件（含第十条「登记失败」，及其计数输入不合法的两种代表写法）各自单独不满足时都判不安全并给出恰好一条原因', gateBad.length === 0, gateBad);
    // U.6：引导顺序——守卫与登记包装（预加载片段、套件自己的启动器包装）先于 require(BATCH_PATH) 安装（14T 建议；读正在运行的套件文件本身）
    const suiteSrc = fs.readFileSync(process.argv[1], 'utf8');
    const iPre = suiteSrc.indexOf('PRE = require(PRELOAD_PATH);');
    const iWrap = suiteSrc.search(/^\s+installSuiteStartWrapper\(\);/m);   // 未被注释掉的那一次调用
    const iBatch = suiteSrc.search(/^\s+batch = require\(BATCH_PATH\);/m);
    check('U.6', '引导顺序：预加载片段（守卫 + 启动器立即登记）→ 套件的启动器包装 → 最后才 require 被测批跑核心（被测模块即使提前捕获了启动器函数引用，也已经是登记过的版本）', iPre > 0 && iWrap > iPre && iBatch > iWrap, { iPre, iWrap, iBatch });
    // U.7：存活检查注释与实现一致（预筛 L2）——「无应答连续 3 次判不在；身份不符立即判定」，旧的「连续 3 次都不满足才算不在」已删
    check('U.7', 'checkInstanceAlive 的注释与实现一致：写明「无应答连续 3 次判不在」「身份不符立即判定」，旧表述「连续 3 次都不满足才算不在」已删', /无应答[^\n]*连续 ALIVE_ATTEMPTS 次判不在[^\n]*身份不符[^\n]*立即判定/.test(batchSrc) && /无应答连续 3 次/.test(batchSrc) && !/连续 3 次都不满足才算不在/.test(batchSrc) && !/连续 ALIVE_ATTEMPTS 次都不满足/.test(batchSrc));
    // U.8：预加载片段的注释精度（收口小批第 5 项）——「外层 reapAll 会重试」只对调用了 reapAll 的进程成立；没调 reapAll 的辅助进程里留下的实例，靠启动器 detached: false 的作业对象收场（保证由启动器承担）
    check('U.8', '预加载片段注释精度：写明外层 reapAll 重试回收「只对调用了 reapAll 的进程成立」，没调 reapAll 的辅助进程留下的实例只靠启动器 spawn 的 detached: false 随辅助进程结束（保证由启动器承担、本文件不验证）',
        /只对调用了 reapAll 的进程成立/.test(preSrc) && /没有调用 reapAll 的辅助进程|没调 reapAll 的辅助进程/.test(preSrc) && /detached: false/.test(preSrc) && /由启动器承担/.test(preSrc));
    const entrySrc = fs.readFileSync(ENTRY_PATH, 'utf8');
    check('U.4', 'verify-test-batch.js 是共享监督进程的薄入口（require lines-test-supervisor、套件路径指向本套件），并启用登记回收（reap: true）与 detached 夹具自检（detachedSelfTest: true）', /require\('\.\/lines-test-supervisor\.js'\)/.test(entrySrc) && /verify-test-batch-suite\.js/.test(entrySrc) && /reap:\s*true/.test(entrySrc) && /detachedSelfTest:\s*true/.test(entrySrc));
}

// ================================================================ 主流程
async function main() {
    await buildSources();
    writeStubFiles();
    if (want('A')) await sectionA();
    if (want('B')) await sectionB();
    if (want('C')) await sectionC();
    if (want('D')) await sectionD();
    if (want('E')) await sectionE();
    if (want('F')) await sectionF();
    if (want('G')) await sectionG();
    if (want('H')) await sectionH();
    if (want('I')) await sectionI();
    if (want('J')) await sectionJ();
    if (want('K')) await sectionK();
    if (want('L')) await sectionL();
    if (want('N')) await sectionN();
    if (want('P')) await sectionP();
    if (want('Q')) await sectionQ();
    if (want('R')) await sectionR();
    if (want('S')) await sectionS();
    if (want('T')) await sectionT();
    if (want('U')) await sectionU();
}

/** 单项核对：条件求值抛错只记这一项失败、不中断后面的回收与闸门（14T M3） */
function checkSafe(id, title, fn) {
    let cond = false; let detail;
    try { const r = fn(); cond = !!r.ok; detail = r.detail; } catch (e) { cond = false; detail = `核对本身抛错：${e && e.stack ? e.stack : e}`; }
    return check(id, title, cond, detail);
}

let KEPT = false;            // 私有根已按闸门保留（现场保留）
let SUMMARY_PRINTED = false;
function printSummary() {
    if (SUMMARY_PRINTED) return;
    SUMMARY_PRINTED = true;
    console.log(`\nverify-test-batch PASS=${pass} FAIL=${fail}`);
    if (SUMMARY_FILE) { try { fs.writeFileSync(SUMMARY_FILE, J({ pass, fail, results })); } catch (_) { /* 汇总文件写不了不影响退出码 */ } }
}

/** 收尾状态：阶段 A（分析）写入、阶段 B（进程善后）与阶段 C（闸门）读取。阶段 A 中途抛错时这些保持初值，不影响阶段 B / C */
const FIN = {
    suiteViol: [], violErr: null, suiteReg: [], helperReg: [], pendingTimedOut: false,
    reap: { total: 0, skipped: 0, gone: [], forced: [], left: [], problems: [], timedOut: false }, reapErr: null, rootsLeft: [],
};
const regNote = (arr) => arr.map((x) => `${x.label}(pid ${x.pid}${x.reason ? `, ${x.reason}` : ''})`);
/** 单步护栏：这一步抛错只锁定闸门（FLOW_ERRORS）、不打断后面的善后步骤 */
async function guardStep(what, fn) { try { return await fn(); } catch (e) { lockFlow(what, e); return undefined; } }

/** 接缝（pre-reap / drain）：造两个真实夹具进程——一个登记进回收器（最外层 reapAll 应把它收掉），一个只挂在独立安全台账（safetyDrain 应把它收掉）；打印身份供外部驱动核对「都已退出」 */
async function seamSpawnFixtures() {
    const mkIdle = () => spawn(process.execPath, [MEMBER_JS, 'idle', '-'], { stdio: 'ignore', windowsHide: true });
    const regFix = mkIdle();
    const safFix = mkIdle();
    safetyAdd('seam-safety-fixture', safFix);   // 先入独立台账（spawn 后立即）
    const regStart = await waitFor(() => procLib.getStartTime(regFix.pid), 5000, 200);   // 先取到创建时间再登记：登记记录要带精确身份
    const safStart = SAFETY[SAFETY.length - 1].start || await waitFor(() => procLib.getStartTime(safFix.pid), 5000, 200);
    SAFETY[SAFETY.length - 1].start = safStart;
    track('seam-reg-fixture', regFix);
    SEAM_PROCS.push({ label: 'seam-reg-fixture', child: regFix, start: regStart }, { label: 'seam-safety-fixture', child: safFix, start: safStart });
    console.log(`SEAM_FIXTURE label=seam-reg-fixture pid=${regFix.pid} start=${regStart}`);
    console.log(`SEAM_FIXTURE label=seam-safety-fixture pid=${safFix.pid} start=${safStart}`);
}

/**
 * 阶段 A（分析）：引导与主流程、守卫记录核对（Z.1 / Z.1b / Z.2）。可能抛错（接缝 pre-reap 就让这里抛）——抛错由 finalFlow 记 Z.9 + 锁定闸门，阶段 B 的进程善后在 finally 里照常执行。
 */
async function analysisStage() {
    let bootError = INIT_ERROR;
    if (!bootError) { try { await boot(); await main(); } catch (e) { bootError = e; } }
    if (bootError) check('Z.0', '套件引导与主流程无异常', false, bootError && bootError.stack || String(bootError));
    if ((INJECT_FAULT === 'pre-reap' || INJECT_FAULT === 'drain') && REAPER && procLib) await seamSpawnFixtures();
    // 守卫记录无论主流程是否中途异常都要核对（单项抛错只记失败）
    try {
        if (INJECT_FAULT === 'violations') throw new Error('INJECTED_VIOLATIONS_FAULT');
        FIN.suiteViol = PRE ? PRE.violations() : [];
    } catch (e) { FIN.violErr = e; }
    if (INJECT_FAULT === 'pre-reap') FIN.suiteViol = null;   // 接缝：violations() 返回了异常值——下面的 .filter 不在任何单项护栏里，整个分析阶段抛错
    const { suiteViol, violErr } = FIN;
    const helperDb = HELPER_UNEXPECTED_VIOLATIONS.filter((v) => v.kind === 'db');
    const helperEnv = HELPER_UNEXPECTED_VIOLATIONS.filter((v) => v.kind === 'env');
    const helperReg = HELPER_UNEXPECTED_VIOLATIONS.filter((v) => v.kind === 'reg');
    const suiteReg = suiteViol.filter((v) => v.kind === 'reg');
    FIN.suiteReg = suiteReg;
    FIN.helperReg = helperReg;
    checkSafe('Z.1', '套件进程与辅助进程从未试图打开私有根之外的库（两层数据库路径守卫记录都为空）', () => {
        if (violErr) throw violErr;
        const suiteDb = suiteViol.filter((v) => v.kind === 'db');
        return { ok: suiteDb.length === 0 && helperDb.length === 0, detail: { suite: suiteDb, helpers: helperDb } };
    });
    // 来源库字节未变：区分「来源尚未创建」（跳过，Z.0 已经记了失败）与「来源被修改 / 读不了」
    if (SRC_SHA === null) console.log('NOTE Z.1b 来源库尚未创建（引导或来源构建没走到那一步），跳过「来源字节未变」核对');
    else checkSafe('Z.1b', '来源库字节未变', () => { const now = sha256(fs.readFileSync(SRC)); return { ok: now === SRC_SHA, detail: { before: SRC_SHA, after: now } }; });
    checkSafe('Z.2', '套件进程与辅助进程从未试图读取私有根之外的 .env（两层 .env 读取守卫记录都为空）；启动器句柄的立即登记没有写失败', () => {
        if (violErr) throw violErr;
        const suiteEnv = suiteViol.filter((v) => v.kind === 'env');
        return { ok: suiteEnv.length === 0 && helperEnv.length === 0 && suiteReg.length === 0 && helperReg.length === 0 && (!REAPER || REAPER.failures.length === 0), detail: { suite: suiteEnv, helpers: helperEnv, reg: [...suiteReg, ...helperReg], reaperFailures: REAPER ? REAPER.failures.map((e) => e.message) : [] } };
    });
}

/**
 * 阶段 B（进程善后）：放弃的批跑落定 → I.0 → 独立安全台账善后 → Z.7 → （接缝 decoy）→ 最外层 reapAll → 数据根 → Z.3 / Z.4。
 * 由 finalFlow 放在分析阶段的 finally 里调用——分析阶段无论怎么抛错，这里都会执行；本函数**自己不抛**：每一步各自捕获（guardStep / 原有的局部 try），
 * 步骤抛错只记入 FLOW_ERRORS / SAFETY_FAILS / reapErr，后面的善后照常执行，最终闸门因此判不安全（14T-R2 M1）。
 */
async function cleanupStage() {
    // 放弃的批跑（被测实现挂住时）先等它落定，再回收
    await guardStep('等待放弃的批跑落定', async () => {
        try {
            if (PENDING_BATCHES.size > 0) {
                const r = await Promise.race([Promise.allSettled([...PENDING_BATCHES]).then(() => 'settled'), sleep(30000).then(() => 'timeout')]);
                FIN.pendingTimedOut = r === 'timeout';
            }
            if (PENDING_STARTS.size > 0) await Promise.race([Promise.allSettled([...PENDING_STARTS]), sleep(20000)]);
        } catch (e) { FIN.pendingTimedOut = true; }
    });
    // I.0：所有场景（含失败 / 超时 / 注入停止失败 / 强杀）登记的实例，在最外层回收之前就已经按身份消失、数据根已删（批跑器自己收干净）
    await guardStep('I.0', async () => {
        if (SCN_ALL.length > 0) checkSafe('I.0', `全部场景（共登记 ${SCN_ALL.length} 个实例，含失败 / 超时 / 注入停止失败的情形）在最外层回收之前：实例进程按身份已消失、数据根已删`, () => { const cl = cleanOf(SCN_ALL); return { ok: cl.ok, detail: cl.bad }; });
    });
    // 独立安全台账（R.7 等「只交给被测回收器处置」的真实进程）：各自的 finally 已经善后过；这里再兜一次（某一节中途抛错时 finally 之外还有漏网的），善后失败进闸门的 extra
    try {
        await safetyDrain();
        if (INJECT_FAULT === 'drain') throw new Error('INJECTED_DRAIN_FAULT');   // 接缝：台账善后之后抛错——后面的 reapAll 仍要执行
    } catch (e) { SAFETY_FAILS.push(`安全台账善后抛错：${e && e.message}`); }
    await guardStep('Z.7', async () => {
        checkSafe('Z.7', `独立安全台账里的真实进程（共 ${SAFETY.length} 个）都有退出证据，善后没有失败项（失败会挡住删除私有根）`, () => ({ ok: SAFETY.every((s) => !childRunning(s.child)) && SAFETY_FAILS.length === 0, detail: { fails: SAFETY_FAILS.slice(), running: SAFETY.filter((s) => childRunning(s.child)).map((s) => `${s.label}(pid ${s.child.pid}, start ${s.start})`) } }));
    });
    // --force-unsafe 接缝：造一个「回收之后才出现」的登记进程（回收时被跳过，只有终检能发现），闸门必须因此保留私有根。
    // spawn 后**立即**入独立的 decoy 台账（先于登记）：登记抛错也不会丢句柄；阶段 C 之后的最外层 finally（terminateDecoys）按句柄有界终止
    if (FORCE_UNSAFE && REAPER) {
        await guardStep('接缝 decoy', async () => {
            const d = spawn(process.execPath, [MEMBER_JS, 'idle', '-'], { stdio: 'ignore', windowsHide: true });
            const entry = { child: d, start: null };
            DECOYS.push(entry);
            const seamEntry = { label: 'seam-decoy', child: d, start: null };
            SEAM_PROCS.push(seamEntry);
            const rec = track('seam-decoy', d);
            entry.start = rec && rec.startTime ? rec.startTime : null;
            seamEntry.start = entry.start;
            console.log(`SEAM_FIXTURE label=seam-decoy pid=${d.pid} start=${entry.start}`);   // 外部驱动按身份核对：套件退出后它必须已经不在
        });
    }
    if (REAPER) {
        try { FIN.reap = await REAPER.reapAll({ deadlineMs: REAP_BOUND_MS, skip: (e) => e.rec.label === 'seam-decoy' }); } catch (e) { FIN.reapErr = e; }
    }
    // 确认消失的实例：数据根由回收器删（失败 / 检查抛错都计入 rootsLeft，不打断后面的步骤）
    for (const g of FIN.reap.gone) {
        if (g.kind !== 'instance' || !g.dataDir || !ti) continue;
        try {
            if (INJECT_FAULT === 'lstat') throw new Error('INJECTED_LSTAT_FAULT');
            if (lstatOrNull(g.dataDir) !== null) { const left = ti._internals.removeDataRoot(g.dataDir); if (left) FIN.rootsLeft.push(left); }
        } catch (e) { FIN.rootsLeft.push(`${g.dataDir}：${describeFsErr(e)}`); }
    }
    const { reap, reapErr, pendingTimedOut, rootsLeft } = FIN;
    await guardStep('Z.3 / Z.4', async () => {
        checkSafe('Z.3', `套件登记的全部进程（共 ${reap.total} 条：套件主进程里启动器交出的实例、辅助进程、桩成员、孙进程，独立于被测实现的状态）在最外层回收之前都已有退出证据（句柄 exit 或身份 dead / reused）——没有一个需要被回收器强制终止，回收后没有 left、没有超截止、登记文件没有损坏`,
            () => ({ ok: reap.forced.length === 0 && reap.left.length === 0 && !reap.timedOut && reap.problems.length === 0 && !reapErr && !pendingTimedOut, detail: { forced: regNote(reap.forced), left: regNote(reap.left), timedOut: reap.timedOut, problems: reap.problems, reapErr: reapErr && reapErr.message, pendingTimedOut } }));
        checkSafe('Z.4', '私有临时根里没有遗留的 sdh-test-* 数据根（含回收器删数据根时的失败）', () => { const dirsLeft = tmpInstanceDirs(); return { ok: dirsLeft.length === 0 && rootsLeft.length === 0, detail: { dirs: dirsLeft, rootsLeft } }; });
    });
}

/** 退出前（顶层，**不抛**）：按身份（PID + 创建时间）查接缝夹具进程此刻的状态并打印 SEAM_AT_EXIT；没有创建时间的打印 state=no-start（外部驱动按「仍不确定」处理） */
function seamAtExit() {
    for (const s of SEAM_PROCS) {
        let state = 'no-start';
        try { if (s.start && procLib) state = procLib.checkIdentity({ pid: s.child.pid, start_time: s.start }).state; } catch (e) { state = `ERR-${e && e.code}`; }
        try { console.log(`SEAM_AT_EXIT label=${s.label} pid=${s.child.pid} state=${state}`); } catch (_) { /* 只是诊断输出 */ }
    }
}

/** 接缝 decoy 的善后（最外层 finally 调用，**不抛**）：按句柄有界终止、等退出；终止后仍在 → 按身份兜底一次，再不行打印 ORPHAN_ALIVE 并记一条失败 */
async function terminateDecoys() {
    for (const d of DECOYS) {
        try {
            if (childRunning(d.child)) { try { d.child.kill(); } catch (_) { /* 下面按是否退出判定 */ } }
            let ok = await waitExitBounded(d.child, 5000);
            if (!ok && d.start && procLib) {
                try { procLib.killIfIdentity({ pid: d.child.pid, start_time: d.start }); } catch (_) { /* 下面按是否退出判定 */ }
                ok = await waitExitBounded(d.child, 5000);
            }
            if (!ok) {
                console.log(`ORPHAN_ALIVE pid=${d.child.pid} start=${d.start}`);
                check('Z.8', '接缝 decoy 已终止', false, `decoy pid ${d.child.pid} 终止后仍存活`);
            }
        } catch (e) { try { fail += 1; console.log(`CHECK Z.8 FAIL 接缝 decoy 善后抛错：${e && e.message}`); } catch (_) { /* 只剩计数 */ } }
    }
}

/**
 * 阶段 C（闸门）：遗留清理 → 删除闸门（待启动集合为空、放弃的批跑已落定、回收没有 left / 超截止 / 抛错、登记文件完好、遗留清理没有保留项、没有登记失败、终检（新鲜读登记）覆盖全部条目都有退出证据）→ Z.5 / 删私有根 → Z.6；
 * 否则判红并保留现场。收尾流程里任何步骤抛过错（FLOW_ERRORS）也锁定闸门。
 */
async function gateStage() {
    const { reap, reapErr, pendingTimedOut, rootsLeft, suiteReg, helperReg, violErr } = FIN;
    let sweep = { removed: [], kept: [], failed: [] };
    if (ti) {
        try { sweep = await ti.sweepStaleTestInstances({ tmpRoot: TMP }); } catch (e) { sweep = { removed: [], kept: [{ dir: TMP, reason: `SWEEP_ERROR ${e && e.message}` }], failed: [] }; }
    }   // ti 都没加载起来 = 没有启动过任何实例，没有遗留清理可做
    const gateExtra = [...SAFETY_FAILS.map((x) => `独立安全台账善后失败：${x}`), ...OUTSIDE_FAILS.map((x) => `私有根外夹具善后失败：${x}`), ...FLOW_ERRORS.map((x) => `收尾步骤抛错：${x}`)];
    for (const s of SAFETY) { if (childRunning(s.child)) gateExtra.push(`独立安全台账里的进程仍在运行：${s.label} pid ${s.child.pid}（不依赖善后函数是否记了失败）`); }
    if (rootsLeft.length > 0) gateExtra.push(`数据根清理失败 / 检查抛错 ${rootsLeft.length} 项`);
    if (violErr) gateExtra.push(`违规记录读取抛错：${violErr.message}`);
    let gate;
    if (REAPER) {
        try {
            if (INJECT_FAULT === 'gate') throw new Error('INJECTED_GATE_FAULT');
            // registrationFailures：套件进程与辅助进程里预加载片段记下的登记类违规；回收器自己的 failures.length 由 finalGate 自动带上
            gate = REAPER.finalGate({ pendingStarts: PENDING_STARTS.size, pendingTimedOut, reap, reapErr, sweep, registrationFailures: suiteReg.length + helperReg.length, extra: gateExtra });
        } catch (e) {
            gate = { safe: false, reasons: [`终检无法完成（finalGate 抛错：${e && e.message}）：判红，保留现场`], verify: null };
        }
    } else gate = { safe: true, reasons: gateExtra };   // 回收器都没建起来 = 套件没来得及启动过任何进程，没有需要等的东西（安全台账 / 根外夹具的善后失败仍挡住）
    if (!REAPER && gateExtra.length > 0) gate.safe = false;
    if (!gate.safe) {
        KEPT = true;
        let verifyBad = [];
        if (gate.verify && Array.isArray(gate.verify.bad)) verifyBad = regNote(gate.verify.bad);
        check('Z.5', '私有临时根的删除闸门：登记进程未全部确认消失或还有未落定的启动 / 保留项 / 登记失败 / 善后失败——不删私有根，保留现场供人工按身份核对', false,
            { priv: PRIV, reasons: gate.reasons, pendingStarts: PENDING_STARTS.size, left: regNote(reap.left), timedOut: reap.timedOut, problems: reap.problems, sweepKept: sweep.kept, sweepFailed: sweep.failed, verifyBad });
    } else {
        try {
            (common || require('../../scripts/lines/line-common')).deleteTreeNoFollow(fs.realpathSync.native(PRIV), []);
            fs.rmdirSync(PRIV);
        } catch (e) { KEPT = true; check('Z.5', '私有临时根已清理', false, e && e.message); }
    }
    if (FORCE_UNSAFE) check('Z.6', '（变异自证接缝 --force-unsafe）一个回收之后才出现的登记进程（只有终检看得到）必须让闸门判不安全、私有根保留：私有根仍在磁盘上', (() => { if (INJECT_FAULT === 'z6') throw new Error('INJECTED_Z6_FAULT'); return KEPT && lstatOrNull(PRIV) !== null; })(), { kept: KEPT, priv: PRIV });
}

/**
 * 最终流程（私有根建成功之后的一切收尾）。三个阶段，**进程善后必达**（收口小批第 6 项 / 14T-R2 M1）：
 *   阶段 A 分析（引导 / 主流程 / 守卫记录）→ 无论 A 是否抛错，阶段 B 进程善后（独立安全台账 → 最外层 reapAll → 数据根，各步分别捕获）都在 finally 里执行 → 阶段 C 闸门与删私有根；
 *   整段套在最外层 try/finally 里：阶段 C 里的任何抛错（例如 Z.6 的检查）也不会跳过接缝 decoy 的善后（独立的 decoy 台账，句柄有界终止）。
 * 任何收尾异常都锁定闸门为不安全（FLOW_ERRORS 进闸门的 extra）并保留现场；异常本身记 Z.9（顶层兜底不让收尾以未处理拒绝退出，14T-R M3）。
 */
async function finalFlow() {
    try {
        try {
            await analysisStage();
        } catch (e) {
            lockFlow('收尾分析阶段', e);
            try { check('Z.9', '收尾流程无未处理异常（分析阶段）', false, e && e.stack ? e.stack : String(e)); } catch (_) { fail += 1; }
        } finally {
            await cleanupStage();
        }
        await gateStage();
    } finally {
        await terminateDecoys();
    }
    if (SCRUBBED_VARS.length) console.log(`NOTE 启动时清掉了宿主环境里的 ${SCRUBBED_VARS.length} 个测试变量（只记名字）：${SCRUBBED_VARS.join(', ')}`);
    if (INJECT_FAULT === 'tail') throw new Error('INJECTED_TAIL_FAULT');
}

(async () => {
    try { await finalFlow(); } catch (e) {
        // 顶层兜底：最终流程里任何没被各步捕获的异常——判红、保留现场（私有根还在就不再动它）、照常输出汇总，不以未处理拒绝退出
        try { check('Z.9', '收尾流程无未处理异常', false, e && e.stack ? e.stack : String(e)); } catch (_) { fail += 1; }
        try { if (fs.existsSync(PRIV)) KEPT = true; } catch (_) { KEPT = true; }
    }
    if (KEPT) console.log(`NOTE 现场保留：${PRIV}`);
    seamAtExit();
    printSummary();
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    console.log(`CHECK Z.9 FAIL 收尾流程无未处理异常\n         ${e && e.stack ? e.stack : e}`);
    fail += 1;
    printSummary();
    process.exit(1);
});
