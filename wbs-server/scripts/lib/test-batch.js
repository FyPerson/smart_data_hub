/**
 * 批跑核心（#106 S3c · W3「批跑器」）
 *
 * 方案 SSOT = docs/local/多线并行/多线并行改造_方案_20261015_v1.3.md 的 W3 小节「批跑器」（第 275–278 行）；派单 = docs/local/多线并行/派单/S3c_派单_批跑器共享实例_20261018.md。
 * 用途：把一批脚本（成员）按顺序跑完；成员里登记了「需要服务」的，由本模块按需起临时实例（scripts/lib/test-instance.js 启动器），把四个 TEST_* 变量传给成员，结束时停掉。
 * 本模块不 require test-env（S3b 待裁部分）：四个变量的名字与 test-env 读取的一致，由 testVarsFromHandle 生成。
 *
 * 导出：
 *   runBatch(members, options)      → Promise<{ results, ok, pass, fail, failed, errors, instances, instancesLine }>
 *   testVarsFromHandle(handle)      → { TEST_INSTANCE, TEST_BASE_URL, TEST_DB_PATH, TEST_JWT_SECRET }（纯函数）
 *   stripTestVars(env)              → 去掉继承来的 TEST_INSTANCE / TEST_BASE_URL / TEST_DB_PATH / TEST_JWT_SECRET / TEST_TARGET / TEST_LIVE_URL（不分大小写）后的环境副本（纯函数，不改入参）
 *   formatInstancesLine(instances)  → 'TEST_INSTANCES shared=<n> exclusive=<n> restarts=<n> raceRetries=<n> missingResources=<n>'
 *   normalizeMembers / TestBatchError / DEFAULT_MEMBER_TIMEOUT_MS / TEST_VAR_NAMES；_internals 给自检用
 *
 * 成员 = { label, rel, args?, needsService?, resources?, exclusive?, timeoutMs? }（未知字段一律拒绝，防止把 needService 之类的笔误当成「不需要服务」）：
 *   label          显示名，批内唯一（FAMILY 汇总行的 FAILED 列表用它）
 *   rel            脚本路径（相对 options.cwd，默认 wbs-server 根；也可以是绝对路径），用当前 node 运行
 *   args           命令行参数数组（默认 []）
 *   needsService   默认 false；true = 成员要一个真服务，批跑器给它四个 TEST_* 变量
 *   resources      命名资源集合（uploads / archive / private / periodic-results / reconcile，同义名 it-reconcile），只对需服务成员有意义（不需服务的成员写了 resources 即拒绝）。
 *                  规范化为启动器的内部名后取并集（reconcile 与 it-reconcile 是同一个资源，不会重复交给启动器）
 *   exclusive      true = 资源状态不能与别的成员共享（例如会删除或改写附件），单独起实例、只带自己的资源、跑完即停。exclusive 蕴含 needsService（needsService: false 与 exclusive: true 同时写则拒绝）
 *   timeoutMs      只对需服务成员生效（默认 20 分钟）。不需服务的成员保持 spawnSync 语义（无超时），timeoutMs 对它被忽略
 *
 * 行为：
 *   - 本批有任何 needsService 且非 exclusive 的成员 → 起**一个**共享实例，资源 = 这些成员资源的并集；没有就不起。实例在第一个用到它的成员之前才起（懒启动）。
 *   - 共享实例起不来 → 依赖它的成员全部判红（不执行，不是跳过），不重试；其他成员照跑；batch.ok 为 false。
 *   - 核实例（checkInstanceAlive）：GET /api/version 的 instance 等于启动时身份且 mode = isolated。无应答连续 3 次才判不在（防一次抖动）；应答了但身份不符（instance / mode 不对）立即判定，不重试。
 *   - 每个共享成员**运行前**先核实例：不在 → 退役旧实例（stop()）、重起新实例（restarts 计数），该成员用新实例运行，**不背锅**（不因此判红，备注里写明）。
 *   - 每个需服务成员（共享 / 独占）**跑完后**核实例：不在 → 该成员判红。共享实例：旧实例按 stop() 收口，下一个需要共享实例的成员前重起一个新实例（之后没有共享成员了就不重起）；
 *     独占实例：成员判红后照常 stop()。
 *   - 子进程环境：所有成员先剔除继承来的六个测试变量名（不分大小写），需服务成员再加四个 TEST_*；不做「所有 TEST_ 前缀」的一刀切（仓库里只有这六个名字在用，别的 TEST_ 变量不动）。
 *   - 需服务成员用异步 spawn + 截止：超时 → 按句柄 killTree 整棵进程树（只在 Node 未认定其退出时，PID 被句柄钉住），判红，继续下一个成员，并照常核实例。
 *     成员结束（exit）后最多再等 CLOSE_GRACE_MS 让管道排空；宽限到期时移除读取监听并销毁父侧 stdout / stderr（批跑器自身因此一定能退出），
 *     结果 notes 注明「成员退出时管道仍被占用（可能遗留子进程）」。成员正常退出后遗留的孙进程**不回收**（残余，由调用方按身份处理）。等待退出的计时器退出或到期后都清除，不拖慢进程自然退出。
 *   - 收尾：所有实例显式 stop()（不依赖启动器的 unref 与否）；stop 失败不重试，记入 errors，batch.ok 为 false。批跑器被强杀时，服务靠启动器的作业对象一并结束。
 *   - missingResources（启动器开始前的资源引用存在性检查）非空：用 options.log 打印清单（最多 20 条）、计入汇总，不判红。
 *   - onResult(result, member)：每个成员的全部收尾（含 exclusive 实例的 stop、共享实例的核对与退役）完成之后才调用。
 *
 * 成员间数据污染：共享实例上的成员**不得假设库是干净的**。成员造数一律用唯一名字（S4 迁移口径）；本批只给机制，不改成员。
 *
 * options（全部可选）：
 *   instanceOptions    传给 startTestInstance 的选项（来源库 / serverJs / resourceRoot / readyTimeoutMs 等；不得含 resources，资源由成员声明）；默认 {}（= 启动器的默认来源）
 *   cwd                成员的工作目录（默认 wbs-server 根）
 *   env                成员环境的基底（默认 process.env）
 *   defaultTimeoutMs   需服务成员的缺省截止（默认 DEFAULT_MEMBER_TIMEOUT_MS）
 *   onResult / log     回调 / 日志行输出（默认 console.log）
 *
 * result = { label, rel, ok, status, signal, out, timedOut, reclaimFailed, ms, service: null|'shared'|'exclusive', instance, executed, notes: [] }
 *   out = stdout 与 stderr 依次拼接（与旧的 runOne 同口径）；ok = 退出码 0 且没有超时、没有核实例失败、没有 stop 失败。
 */
'use strict';

const path = require('path');
const { spawn, spawnSync } = require('child_process');
const ti = require('./test-instance');
const procLib = require('../../../scripts/lines/line-proc');

const WBS_DIR = path.resolve(__dirname, '..', '..');

/** 测试变量名（不分大小写匹配）：test-env 读取的四个 + live 模式的两个 */
const TEST_VAR_NAMES = Object.freeze(['TEST_INSTANCE', 'TEST_BASE_URL', 'TEST_DB_PATH', 'TEST_JWT_SECRET', 'TEST_TARGET', 'TEST_LIVE_URL']);
const TEST_VAR_RE = /^TEST_(?:INSTANCE|BASE_URL|DB_PATH|JWT_SECRET|TARGET|LIVE_URL)$/i;
const DEFAULT_MEMBER_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/** setTimeout 的最大延迟（2^31 - 1 毫秒）；超过会被 Node 缩成约 1 毫秒，所以超时参数一律不得超过它（47R4c L） */
const MAX_TIMER_MS = 2147483647;
const MEMBER_KEYS = Object.freeze(['label', 'rel', 'args', 'needsService', 'resources', 'exclusive', 'timeoutMs']);
const OPTION_KEYS = Object.freeze(['instanceOptions', 'cwd', 'env', 'defaultTimeoutMs', 'onResult', 'log']);
const MISSING_PRINT_LIMIT = 20;
const ALIVE_ATTEMPTS = 3;
const ALIVE_RETRY_MS = 400;
const KILL_EXIT_WAIT_MS = 10000;
const KILL_FALLBACK_WAIT_MS = 5000;
const CLOSE_GRACE_MS = 2000;

class TestBatchError extends Error {
    constructor(code, message, extra) {
        super(message);
        this.name = 'TestBatchError';
        this.code = code;
        if (extra && typeof extra === 'object') Object.assign(this, extra);
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const describeError = (e) => `${e && e.code ? `${e.code}: ` : ''}${e && e.message ? e.message : String(e)}`;

// ---------------------------------------------------------------- 纯函数

/** 实例句柄 → 四个 TEST_* 变量（命名与 test-env 一致）。句柄缺字段即抛错（fail-closed：不把 undefined 传成字符串） */
function testVarsFromHandle(handle) {
    const need = (k) => {
        if (!handle || typeof handle[k] !== 'string' || handle[k] === '') throw new TestBatchError('TB_BAD_HANDLE', `实例句柄缺少 ${k}（或不是非空字符串），无法生成 TEST_* 变量`);
        return handle[k];
    };
    return {
        TEST_INSTANCE: need('instance'),
        TEST_BASE_URL: need('baseUrl'),
        TEST_DB_PATH: path.resolve(need('dbPath')),
        TEST_JWT_SECRET: need('jwtSecret'),
    };
}

/** 环境副本：去掉六个测试变量名（不分大小写），其余原样。不改入参 */
function stripTestVars(env) {
    const out = {};
    for (const k of Object.keys(env)) {
        if (env[k] === undefined) continue;
        if (TEST_VAR_RE.test(k)) continue;
        out[k] = env[k];
    }
    return out;
}

function canonResource(r) {
    return Object.prototype.hasOwnProperty.call(ti.RESOURCE_ALIASES, r) ? ti.RESOURCE_ALIASES[r] : r;
}

/** 资源名数组 → 规范化（同义名映射成启动器内部名）、去重、保持首次出现顺序 */
function canonResources(list) {
    const out = [];
    for (const r of list) {
        const c = canonResource(r);
        if (!out.includes(c)) out.push(c);
    }
    return out;
}

function normalizeMembers(raw, defaults) {
    const bad = (msg) => new TestBatchError('TB_BAD_MEMBER', msg);
    if (!Array.isArray(raw)) throw bad('成员表必须是数组');
    const seen = new Set();
    const out = [];
    raw.forEach((m, i) => {
        const where = `成员 #${i}${m && typeof m === 'object' && typeof m.label === 'string' ? `（${m.label}）` : ''}`;
        if (m === null || typeof m !== 'object' || Array.isArray(m)) throw bad(`${where} 必须是对象`);
        for (const k of Object.keys(m)) {
            if (!MEMBER_KEYS.includes(k)) throw bad(`${where} 有未知字段 ${JSON.stringify(k)}（已知：${MEMBER_KEYS.join(' / ')}）`);
        }
        if (typeof m.label !== 'string' || m.label === '') throw bad(`${where} 缺少 label（非空字符串）`);
        if (typeof m.rel !== 'string' || m.rel === '') throw bad(`${where} 缺少 rel（非空字符串）`);
        if (seen.has(m.label)) throw bad(`${where} 的 label 与前面的成员重复`);
        seen.add(m.label);
        const args = m.args === undefined ? [] : m.args;
        if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) throw bad(`${where} 的 args 必须是字符串数组`);
        if (m.needsService !== undefined && typeof m.needsService !== 'boolean') throw bad(`${where} 的 needsService 必须是布尔值`);
        if (m.exclusive !== undefined && typeof m.exclusive !== 'boolean') throw bad(`${where} 的 exclusive 必须是布尔值`);
        if (m.exclusive === true && m.needsService === false) throw bad(`${where} 同时写了 exclusive: true 与 needsService: false（独占成员一定要服务）`);
        const exclusive = m.exclusive === true;
        const needsService = m.needsService === true || exclusive;
        const resourcesIn = m.resources === undefined ? [] : m.resources;
        const isKnown = (r) => ti.RESOURCE_NAMES.includes(r) || Object.prototype.hasOwnProperty.call(ti.RESOURCE_ALIASES, r);
        if (!Array.isArray(resourcesIn) || !resourcesIn.every((r) => typeof r === 'string' && isKnown(r))) {
            throw bad(`${where} 的 resources 必须是 ${ti.RESOURCE_NAMES.join(' / ')}（同义名 ${Object.keys(ti.RESOURCE_ALIASES).join(' / ')}）的数组`);
        }
        if (!needsService && resourcesIn.length > 0) throw bad(`${where} 不需要服务却声明了 resources（资源只对需服务成员有意义；漏写 needsService 会让成员在没有服务的情况下运行）`);
        if (m.timeoutMs !== undefined && !(Number.isSafeInteger(m.timeoutMs) && m.timeoutMs > 0 && m.timeoutMs <= MAX_TIMER_MS)) throw bad(`${where} 的 timeoutMs 必须是 1–${MAX_TIMER_MS} 的整数（毫秒）`);
        out.push({
            label: m.label, rel: m.rel, args: args.slice(), needsService, exclusive,
            resources: canonResources(resourcesIn),
            timeoutMs: m.timeoutMs === undefined ? defaults.timeoutMs : m.timeoutMs,
        });
    });
    return out;
}

/** 同步成员 spawnSync 带 error 一律判红（严格判定）；文案按原因区分：ENOBUFS 是输出超过上限，不是没能启动 */
function spawnErrorNote(err) {
    if (err && err.code === 'ENOBUFS') return `成员输出超过 ${MAX_OUTPUT_BYTES / (1024 * 1024)}MB 上限（ENOBUFS），按失败处理（成员已被终止）：${describeError(err)}`;
    return `成员没能启动：${describeError(err)}`;
}

function formatInstancesLine(s) {
    return `TEST_INSTANCES shared=${s.shared} exclusive=${s.exclusive} restarts=${s.restarts} raceRetries=${s.raceRetries} missingResources=${s.missingResources}`;
}

// ---------------------------------------------------------------- 子进程

/** 不需服务的成员：spawnSync 语义不变（无超时），环境先剔除测试变量 */
function runSync(member, env, cwd) {
    const r = spawnSync(process.execPath, [member.rel, ...member.args], { cwd, env, encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES });
    return { status: r.status, signal: r.signal || null, out: `${r.stdout || ''}${r.stderr || ''}`, timedOut: false, reclaimFailed: false, spawnError: r.error || null, pipeHeld: false };
}

/**
 * 需服务的成员：异步 spawn + 截止。超时 → 按句柄 killTree（Node 未认定退出时 PID 被句柄钉住）→ 等退出 → 句柄 kill 兜底 → 仍不退出则 reclaimFailed。
 * 'exit' 之后最多再等 CLOSE_GRACE_MS 让管道排空（孙进程继承了管道时不会无限等）。
 */
function runAsync(member, env, cwd, timeoutMs) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(process.execPath, [member.rel, ...member.args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        } catch (e) {
            resolve({ status: null, signal: null, out: '', timedOut: false, reclaimFailed: false, spawnError: e, pipeHeld: false });
            return;
        }
        const outChunks = [];
        const errChunks = [];
        let bytes = 0;
        let truncated = false;
        const take = (arr) => (d) => { if (bytes >= MAX_OUTPUT_BYTES) { truncated = true; return; } bytes += d.length; arr.push(d); };
        const onOut = take(outChunks);
        const onErr = take(errChunks);
        child.stdout.on('data', onOut);
        child.stderr.on('data', onErr);
        let status = null;
        let signal = null;
        let exited = false;
        let closed = false;
        let timedOut = false;
        let reclaimFailed = false;
        let spawnError = null;
        let done = false;
        let deadlineTimer = null;
        let graceTimer = null;
        let resolveExit = null;
        const exitPromise = new Promise((r) => { resolveExit = r; });
        /** 移除读取监听并销毁父侧管道：孙进程继承了管道时，不销毁的话父进程里的读取句柄会让事件循环一直活着（14 H3） */
        const releasePipes = () => {
            for (const [s, fn] of [[child.stdout, onOut], [child.stderr, onErr]]) {
                if (!s) continue;
                try { s.removeListener('data', fn); } catch (_) { /* 已销毁 */ }
                try { s.destroy(); } catch (_) { /* 已销毁 */ }
            }
        };
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(deadlineTimer);
            clearTimeout(graceTimer);
            const pipeHeld = exited && !closed && !reclaimFailed;   // 成员已退出但管道没在宽限内关闭：有进程还握着它
            releasePipes();
            const out = `${Buffer.concat(outChunks).toString('utf8')}${Buffer.concat(errChunks).toString('utf8')}${truncated ? '\n[输出超过 64MB 上限，已截断]' : ''}`;
            resolve({ status, signal, out, timedOut, reclaimFailed, spawnError, pipeHeld, truncated });
        };
        child.once('error', (e) => { spawnError = e; if (!child.pid) { exited = true; resolveExit(); finish(); } });
        child.once('exit', (code, sig) => {
            exited = true; status = code; signal = sig || null;
            clearTimeout(deadlineTimer);
            resolveExit();
            graceTimer = setTimeout(finish, CLOSE_GRACE_MS);
        });
        child.once('close', () => { closed = true; finish(); });
        /** 等成员退出，最多 ms；已退出就不建计时器，退出或到期后都清除计时器（遗留的引用计时器会把进程自然退出拖慢 5–10 秒） */
        const waitExit = (ms) => {
            if (exited) return Promise.resolve();
            let t = null;
            const timeout = new Promise((r) => { t = setTimeout(r, ms); });
            return Promise.race([exitPromise, timeout]).then(() => clearTimeout(t));
        };
        deadlineTimer = setTimeout(async () => {
            if (exited || done) return;
            timedOut = true;
            if (child.exitCode === null && child.signalCode === null && Number.isSafeInteger(child.pid)) {
                try { procLib.killTree(child.pid); } catch (_) { /* 下面按是否退出判定 */ }
            }
            await waitExit(KILL_EXIT_WAIT_MS);
            if (!exited) {
                try { child.kill(); } catch (_) { /* 下面按是否退出判定 */ }
                await waitExit(KILL_FALLBACK_WAIT_MS);
            }
            if (!exited) { reclaimFailed = true; finish(); }
        }, timeoutMs);
    });
}

/** 实例是否还在：GET /api/version 的 instance 等于启动时身份且 mode = isolated。无应答（连不上 / 非 200）连续 ALIVE_ATTEMPTS 次判不在；身份不符（应答了但 instance / mode 不对）立即判定、不重试 */
async function checkInstanceAlive(h) {
    let last = '没有应答';
    for (let i = 0; i < ALIVE_ATTEMPTS; i += 1) {
        const r = await procLib.httpGetJson(h.port, ti.VERSION_PATH, 3000);
        if (r.kind === 'ok' && r.status === 200) {
            const v = r.json;
            if (v.instance === h.instance && v.mode === 'isolated') return { ok: true };
            return { ok: false, reason: `身份变了（instance=${JSON.stringify(v.instance === undefined ? null : v.instance)} mode=${JSON.stringify(v.mode === undefined ? null : v.mode)}，期望 ${h.instance} / isolated）` };
        }
        last = r.kind === 'ok' ? `应答 HTTP ${r.status}` : `没有可用应答（${r.kind}）`;
        if (i < ALIVE_ATTEMPTS - 1) await sleep(ALIVE_RETRY_MS);
    }
    return { ok: false, reason: `不再应答（${ALIVE_ATTEMPTS} 次探测：${last}）` };
}

// ---------------------------------------------------------------- 批跑

async function runBatch(rawMembers, rawOptions) {
    const options = rawOptions === undefined ? {} : rawOptions;
    if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new TestBatchError('TB_BAD_OPTIONS', 'options 必须是对象');
    for (const k of Object.keys(options)) {
        if (!OPTION_KEYS.includes(k)) throw new TestBatchError('TB_BAD_OPTIONS', `未知选项 ${JSON.stringify(k)}（已知：${OPTION_KEYS.join(' / ')}）`);
    }
    const instanceOptions = options.instanceOptions === undefined ? {} : options.instanceOptions;
    if (instanceOptions === null || typeof instanceOptions !== 'object' || Array.isArray(instanceOptions)) throw new TestBatchError('TB_BAD_OPTIONS', 'instanceOptions 必须是对象');
    if (Object.prototype.hasOwnProperty.call(instanceOptions, 'resources')) throw new TestBatchError('TB_BAD_OPTIONS', 'instanceOptions 不得含 resources：资源由成员声明（取并集 / 独占成员各带各的）');
    const cwd = options.cwd === undefined ? WBS_DIR : options.cwd;
    if (typeof cwd !== 'string' || cwd === '') throw new TestBatchError('TB_BAD_OPTIONS', 'cwd 必须是非空字符串');
    const baseEnv = options.env === undefined ? process.env : options.env;
    const defaultTimeoutMs = options.defaultTimeoutMs === undefined ? DEFAULT_MEMBER_TIMEOUT_MS : options.defaultTimeoutMs;
    if (!(Number.isSafeInteger(defaultTimeoutMs) && defaultTimeoutMs > 0 && defaultTimeoutMs <= MAX_TIMER_MS)) throw new TestBatchError('TB_BAD_OPTIONS', `defaultTimeoutMs 必须是 1–${MAX_TIMER_MS} 的整数（毫秒）`);
    const onResult = options.onResult === undefined ? null : options.onResult;
    const log = options.log === undefined ? ((line) => console.log(line)) : options.log;
    if ((onResult !== null && typeof onResult !== 'function') || typeof log !== 'function') throw new TestBatchError('TB_BAD_OPTIONS', 'onResult / log 必须是函数');

    const members = normalizeMembers(rawMembers, { timeoutMs: defaultTimeoutMs });
    const sharedMembers = members.filter((m) => m.needsService && !m.exclusive);
    const sharedResources = canonResources(sharedMembers.flatMap((m) => m.resources));

    const stats = { attempted: 0, shared: 0, exclusive: 0, restarts: 0, raceRetries: 0, missingResources: 0 };
    const errors = [];
    const results = [];
    const st = { shared: null, error: null, everStarted: false };

    const startInstance = (resources) => ti.startTestInstance(Object.assign({}, instanceOptions, { resources }));
    const account = (h) => {
        stats.raceRetries += Number.isSafeInteger(h.startupRaceRetries) ? h.startupRaceRetries : 0;
        const miss = h.missingResources;
        if (miss && Number.isSafeInteger(miss.missingTotal) && miss.missingTotal > 0) {
            stats.missingResources += miss.missingTotal;
            log(`TEST_BATCH_MISSING_RESOURCES instance=${h.instance} total=${miss.missingTotal}（只报告，不判红）`);
            for (const x of (miss.missing || []).slice(0, MISSING_PRINT_LIMIT)) log(`  - ${x.resource} ${x.table}.${x.column} rowid=${x.rowId} ${x.ref}`);
            if (miss.missingTotal > MISSING_PRINT_LIMIT) log(`  ……其余 ${miss.missingTotal - MISSING_PRINT_LIMIT} 条略`);
        }
    };
    const stopHandle = async (h, tag) => {
        try { await h.stop(); } catch (e) { errors.push(`${tag}：实例 ${h.instance} 停止失败（${describeError(e)}）`); }
    };
    const startShared = async () => {
        stats.attempted += 1;
        let h;
        try {
            h = await startInstance(sharedResources);
        } catch (e) {
            st.error = e;
            return;
        }
        if (st.everStarted) stats.restarts += 1; else stats.shared += 1;
        st.everStarted = true;
        st.shared = h;
        account(h);   // 在 try 之外：log 抛错不会被误判成「共享实例不可用」；st.shared 已赋值，抛出后由最外层 finally 收尾
    };
    const baseResult = (m) => ({ label: m.label, rel: m.rel, ok: false, status: null, signal: null, out: '', timedOut: false, reclaimFailed: false, ms: 0, service: null, instance: null, executed: false, notes: [] });
    const fill = (res, run, ms) => {
        res.executed = true;
        res.status = run.status; res.signal = run.signal; res.out = run.out; res.timedOut = run.timedOut; res.reclaimFailed = run.reclaimFailed; res.ms = ms;
        res.ok = run.status === 0 && !run.timedOut && !run.reclaimFailed && !run.spawnError && !run.truncated;
        if (run.spawnError) res.notes.push(spawnErrorNote(run.spawnError));
        // 异步分支输出超限：与同步分支（ENOBUFS）同口径判红（47R4c M）
        if (run.truncated) res.notes.push(`成员输出超过 ${MAX_OUTPUT_BYTES / (1024 * 1024)}MB 上限，超出部分已丢弃，按失败处理`);
        if (run.pipeHeld) res.notes.push('成员退出时管道仍被占用（可能遗留子进程；批跑器不回收成员正常退出后遗留的孙进程）');
        if (run.timedOut) res.notes.push(`成员超过 ${res.timeoutMs} 毫秒仍未结束，已按句柄终止其进程树`);
        if (run.reclaimFailed) {
            res.notes.push('成员超时后进程没能收掉（需要人工按 PID + 创建时间核对清理）');
            errors.push(`${res.label}：超时后进程没能收掉`);
        }
    };

    try {
        for (const m of members) {
            const res = baseResult(m);
            res.timeoutMs = m.timeoutMs;
            if (!m.needsService) {
                const t0 = performance.now();
                const run = runSync(m, stripTestVars(baseEnv), cwd);
                fill(res, run, Math.round(performance.now() - t0));
                delete res.timeoutMs;   // 不需服务的成员没有截止（spawnSync 语义）
            } else if (m.exclusive) {
                res.service = 'exclusive';
                stats.attempted += 1;
                let h = null;
                try { h = await startInstance(m.resources); } catch (e) { res.notes.push(`独占实例没能启动，成员未执行：${describeError(e)}`); }
                if (h !== null) {
                    stats.exclusive += 1;
                    // 拿到句柄后的一切（登记 / 生成环境 / 运行 / 核存活）都在 try 里，finally 一定 stop()：log 之类的回调同步抛错也不会漏收尾（14 H2）
                    try {
                        account(h);
                        res.instance = h.instance;
                        const t0 = performance.now();
                        const run = await runAsync(m, Object.assign(stripTestVars(baseEnv), testVarsFromHandle(h)), cwd, m.timeoutMs);
                        fill(res, run, Math.round(performance.now() - t0));
                        // 独占成员同样核实例：成员把自己的服务弄死后退出码 0 也不能判绿（14 H1）；判红后照常 stop()，独占实例不重起
                        const chk = await checkInstanceAlive(h);
                        if (!chk.ok) {
                            res.ok = false;
                            res.notes.push(`成员结束后独占实例 ${h.instance} ${chk.reason}`);
                        }
                    } finally {
                        const before = errors.length;
                        await stopHandle(h, m.label);
                        if (errors.length > before) { res.ok = false; res.notes.push('独占实例停止失败'); }
                    }
                }
            } else {
                res.service = 'shared';
                if (st.shared === null && st.error === null) {
                    await startShared();
                } else if (st.shared !== null) {
                    // 运行前也核实例（实例可能在两个成员之间被别的东西弄死，不能让下一个成员背锅）：不在 → 退役旧实例、重起新实例，本成员不判红
                    const pre = await checkInstanceAlive(st.shared);
                    if (!pre.ok) {
                        const old = st.shared;
                        st.shared = null;
                        res.notes.push(`运行前共享实例 ${old.instance} ${pre.reason}；已退役并重起新实例（本成员不因此判红）`);
                        await stopHandle(old, m.label);
                        await startShared();
                    }
                }
                if (st.error !== null) {
                    res.notes.push(`共享实例不可用，成员未执行：${describeError(st.error)}`);
                } else {
                    const h = st.shared;
                    res.instance = h.instance;
                    const t0 = performance.now();
                    const run = await runAsync(m, Object.assign(stripTestVars(baseEnv), testVarsFromHandle(h)), cwd, m.timeoutMs);
                    fill(res, run, Math.round(performance.now() - t0));
                    const chk = await checkInstanceAlive(h);
                    if (!chk.ok) {
                        res.ok = false;
                        res.notes.push(`成员结束后共享实例 ${h.instance} ${chk.reason}；该实例退役，之后需要共享实例的成员用新实例`);
                        st.shared = null;
                        await stopHandle(h, m.label);
                    }
                }
            }
            results.push(res);
            if (onResult !== null) onResult(res, m);
        }
    } finally {
        if (st.shared !== null) {
            const h = st.shared;
            st.shared = null;
            await stopHandle(h, '收尾');
        }
    }

    const failed = results.filter((r) => !r.ok).map((r) => r.label);
    const pass = results.length - failed.length;
    return {
        results, ok: failed.length === 0 && errors.length === 0, pass, fail: failed.length, failed, errors,
        instances: Object.assign({}, stats),
        instancesLine: stats.attempted > 0 ? formatInstancesLine(stats) : null,
    };
}

module.exports = {
    runBatch, testVarsFromHandle, stripTestVars, formatInstancesLine, normalizeMembers, TestBatchError,
    DEFAULT_MEMBER_TIMEOUT_MS, TEST_VAR_NAMES,
    _internals: { canonResources, checkInstanceAlive, runAsync, runSync, spawnErrorNote, TEST_VAR_RE, CLOSE_GRACE_MS, MAX_OUTPUT_BYTES },
};
