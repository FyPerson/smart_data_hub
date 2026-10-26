/**
 * 测试入口助手（#106 S3b · W3「测试入口助手」）
 *
 * 方案 SSOT = docs/local/多线并行/多线并行改造_方案_20261015_v1.3.md 的 W3 小节；派单 = docs/local/多线并行/派单/S3b_派单_测试入口助手与代表脚本_20261018.md。
 * 用途：测试脚本在任何写库、网络请求、浏览器操作之前 `await testEnv.ready()`，拿到「被测服务的地址 / 实例库 / 实例密钥」。永不回落到 3000、永不指向业务库。
 *
 * 三种运行形态（由环境变量决定，互斥）：
 *   ① 变量组形态：TEST_INSTANCE / TEST_BASE_URL / TEST_DB_PATH / TEST_JWT_SECRET **全部提供**（批跑器或父脚本已起好实例，本脚本是它的子进程）。ready() 依次核对：
 *        a. TEST_BASE_URL 是 **http**（不接受 https：服务身份核对只会 http.get，接受了也永远连不上）回环地址（localhost / 127.0.0.1 / ::1），端口不得是 3000（永不回落 3000），不带路径 / 查询 / 凭证；TEST_INSTANCE 以 test- 开头；
 *           TEST_DB_PATH 在 Windows 下任一路径段以 . 或空格结尾 → TE_BAD_VALUE（Node 的 fs 走 \\?\ 命名空间认不出 `task_pool.db.`，而 SQLite 的 CreateFileW 会做 Win32 规范化后打开业务库，路径核对与实际打开的文件会不一致；不做规范化，直接拒绝）；
 *        b. TEST_DB_PATH 规范化（realpath + 大小写折叠）后不等于本检出的业务库（含线检出的线库），且不与业务库是同一物理文件——**这一项先于打开任何库**，业务库从不被本模块打开；
 *        c. GET <TEST_BASE_URL>/api/version 的 instance 等于 TEST_INSTANCE 且 mode === 'isolated'（服务身份）；
 *        d. 只读打开 TEST_DB_PATH，`_sdh_instance.instance_id` 等于 TEST_INSTANCE（库身份，instance-db.checkInstanceIdentity）。
 *      **与方案「依次核对三项」的差异**：方案写的顺序是 服务身份 → 库身份 → 路径；这里把路径核对（b）提前到服务与库之前，理由是不打开业务库（主工作区 / 生产的业务库没有 _sdh_instance，库身份核对对它们必然失败，
 *      但「失败」之前已经打开过它一次）；四项核对的合取不变，各自仍独立判红（verify-test-env 用「服务身份与库身份都正确、只有路径指向业务库」的用例证明路径核对不依赖库身份核对）。
 *   ② 全部缺省：调用 test-instance.startTestInstance(options) 自起一个临时实例（options 原样透传）；进程退出 / 未捕获异常 / SIGINT / SIGTERM 时收掉实例；teardown() 供显式收尾。
 *        自然结束（S3b 修复批 1）：启动器在把句柄交给调用方之后对服务子进程 unref()，脚本什么都不做、自然结束（没有 teardown()、没有 process.exit()）时进程会在有界时间内退出，
 *        退出时由启动器的 'exit' 钩子同步终止服务，本模块的 syncExitCleanup 再等服务进程真的退出（procLib.isAlive，靠启动器仍持有的子进程句柄防 PID 复用）后删数据根；
 *        创建时间（start_time）只在兜底路径 killIfIdentity 里用：服务进程在 400 毫秒内还没退出时按「PID + 创建时间」精确终止（实测 12 毫秒量级，见 S3b 修复批 1 报告）；脚本仍应显式 await teardown()（异步路径，有重入保护）。
 *   **退出码兜底（S3b 修复批 2a，用户裁定 U4 = A：保留自起，加兜底）**——三种形态（自起 / 变量组 / live）一律适用，ready() 首次成功后装上：
 *        「静默退出码 0」是自起带来的新失败形态：脚本卡在永不落定的 promise、或全绿后自然返回却没走收尾，事件循环排空，进程以退出码 0 退出——单独运行或按退出码判定的场景会把「没跑完」记成通过。
 *        判定（S3b 收口小批：用「是否显式退出过」，不再靠 immediate 时序）：进程因事件循环自然排空而退出（'beforeExit' 触发过）、teardown() 从未被调用过、**从未显式调用过 process.exit**、
 *        当前退出码为 0 或未设置 → 在 'exit' 监听里把 process.exitCode 改为 EXIT_CODE_NO_TEARDOWN（70），并向 stderr 写一行原因（不含任何秘密值）。
 *        「显式调用过 process.exit」靠装兜底时包一层 process.exit 记标记（参数与返回行为原样透传）：**任何显式 process.exit(…)——有参或无参、在 beforeExit 监听器之前或之后注册的监听器里、
 *        同步 / nextTick / 微任务 / setImmediate / setTimeout 里调用——都视为脚本自己决定的退出码，兜底不介入**（无参 process.exit() 沿用当时的 process.exitCode，未设置即 0）。
 *        已经非零的退出码保持原值；teardown() 之后自然结束不触发 70。**例外（S4-x 收口小批）**：teardown() 被调用过、但最近一次 teardown 失败（被 .catch 吞掉后自然结束），退出码仍为 0 或未设置 →
 *        改为 1 并向 stderr 写一行原因（与 finish(0) 遇到失败的 teardown 同口径）；不碰显式 process.exit(…) 的语义；ready 后不 teardown 仍是 70（优先级不变）。兜底监听器在清理监听器之后注册且自带 try/catch，清理不会被它跳过。
 *        **S4 迁移约定**：已迁移的脚本必须以 `await teardown()`（经 fx.teardown() / testEnv.teardown()）或 `process.exit(code)` 收尾；只靠自然结束的脚本会得到退出码 70。成功路径的收尾推荐 `await teardown()` 之后调用 finish(code)（见下面导出里的 finish 一节：fetch 之后立即 process.exit 在 Windows 上会崩溃）。
 *        **入口调用链的 `.catch` 必须以非零退出**（`process.exit(非零)` / 设非零 `process.exitCode` / 重新抛出）：ready() 失败时兜底还没装上（用户裁定的契约是「ready() 成功后注册」），
 *        入口 `.catch` 只打印就自然结束会得到退出码 0；静态守卫（verify-test-env 的 R7）检查入口链上 catch 回调的顶层语句里有这一条。
 *   ③ TEST_TARGET=live + TEST_LIVE_URL：真实环境核对。只允许在正常模式的检出里使用（instance-mode 判定为 normal）；不起实例，不接受 TEST_INSTANCE 等四个变量；
 *      dbPath / jwtSecret / signToken 一律不可用（访问即抛 TE_LIVE_NO_DB / TE_LIVE_NO_TOKEN）。
 *   只给了变量组的一部分 → 立即失败（TE_PARTIAL_VARS）。空串也算「给了」（空值 → TE_BAD_VALUE）。
 *
 * 导出：
 *   ready(options)      幂等（同一进程只建一次，永远返回同一个 Promise；失败后再调用得到同一个拒绝）。options 只对形态②有意义（透传给启动器）；形态①③忽略。
 *                       第二次及以后的 ready(options) 的 options 与首次不一致（按规范化后的 JSON 比较：键序无关、undefined 键忽略；不传 = 与首次一致）→ 拒绝 TE_OPTIONS_CONFLICT，
 *                       不再静默忽略（否则后一个调用点声明的 resources 等选项悄悄不生效）。
 *   teardown()          收掉自起的实例（幂等；形态①③是空操作）。
 *   finish(code)        收尾助手（S4-x）：在 `await teardown()` 落定之后调用，替代成功路径上的 `process.exit(code)`。
 *                       为什么存在：Node v24.11.1 / Windows 上，fetch 刚完成就 process.exit() 会以 libuv 断言崩溃（`!(handle->flags & UV_HANDLE_CLOSING), src\win\async.c line 76`），
 *                       退出码被崩溃盖掉，成功的脚本报成失败。批跑器共享实例模式下 teardown() 不停实例、立即返回，延时不再掩盖它。
 *                       对照实验（共享实例上每组 3–5 次，结果稳定）：fetch 两次后 process.exit(0) = 全红；同上 + 关 undici 全局 dispatcher = 全红；同上 + exit 前 setImmediate 两次 = 全红；
 *                       不 fetch 直接 ready→teardown→process.exit(0) = 全绿；exit 前等 200ms = 全绿；不调 process.exit、只设 process.exitCode 让事件循环自然结束 = 全绿（约 150ms）。
 *                       行为：process.exitCode = code，再设一个 unref() 的兜底计时器（默认 10000ms）到时 process.exit(code)——事件循环被别的未关句柄拖住时不会挂到批跑器的 20 分钟超时。
 *                       **finish 只设退出码、不终止执行**：调用点之后必须是 return 或函数结束（之后继续跑的代码照常执行，包括再发请求）；**finish 之后不要再改 process.exitCode**（不加监听，改了就以最后一次为准）。
 *                       参数必须是 0–255 的整数（TE_BAD_FINISH_CODE）；必须已调用过 teardown() 且它已落定（成功或失败都算落定）（TE_FINISH_BEFORE_TEARDOWN）——finish 不替你调 teardown，不吞它的错误；
 *                       落定按「尝试」代次记账：只有 teardownCore 开始一次新的尝试（真的去停实例）才清「已落定」，复用已完成的结果（`await teardown(); teardown(); finish(0)`）不误抛；
 *                       teardown() 返回派生 promise：原 promise 的拒绝由内部处理器接收，并在返回的派生 promise 中原样重新抛出；调用方不消费派生 promise 时仍产生未处理拒绝（裸调 teardown() 且失败，退出码非零）。
 *                       每次调用返回新的派生 promise，各自需处理——只处理其中一个，另一个失败时仍是未处理的拒绝。
 *                       最近一次 teardown 失败时 `finish(0)` 不抛错，而是把实际退出码改为 1 并向 stderr 写一行原因；`finish(1)` 等非 0 的 code 不受影响。
 *                       重复调用同一 code（按调用方传入的值比）幂等，不同 code 抛 TE_FINISH_CONFLICT。
 *                       与退出码哨兵：teardown() 一调用就记 teardownCalled（此后 sentinelOnExit 不再报 70；最近一次 teardown 失败且退出码为 0 时改为 1），所以 finish 之后事件循环自然结束不会被改成 70，退出码取 process.exitCode；finish 没有削弱哨兵（没 teardown 就抛，哨兵条件仍成立）。
 *                       **入口调用链的 `.catch` 路径继续用 `process.exit(1)`**：失败路径即使崩溃，退出码也非零，结论不变。
 *   env()               当前解析结果 { baseUrl, dbPath, instance, jwtSecret, dataDir, logFile, live, selfStarted, startupRaceRetries }；ready() 完成之前调用抛 TE_NOT_READY。
 *                       dataDir：自起 = 数据根；变量组形态 = TEST_DB_PATH 所在目录且其 sdh-instance.json 的 instance 与 TEST_INSTANCE 一致，否则 null。logFile 只有自起才有。
 *   signToken(userId)   从实例库只读取 users 行，用实例密钥签 1 小时 token（与 _test-fixture.signAs 同形态）。
 *   childEnv()          返回供子进程 / 浏览器测试透传的环境变量：四个 TEST_*（live 形态为 TEST_TARGET + TEST_LIVE_URL）。
 *   isReady()           ready() 是否已成功完成（不抛）。
 *   TestEnvError、VAR_NAMES、_internals（自检用：resolveEnvironment / resetForTest）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3');

const instanceMode = require('../../utils/instance-mode');
const instanceDb = require('../../utils/instance-db');
const testInstance = require('./test-instance');
const procLib = require('../../../scripts/lines/line-proc');

const WBS_DIR = path.resolve(__dirname, '..', '..');
const VAR_NAMES = Object.freeze(['TEST_INSTANCE', 'TEST_BASE_URL', 'TEST_DB_PATH', 'TEST_JWT_SECRET']);
const LIVE_VARS = Object.freeze(['TEST_TARGET', 'TEST_LIVE_URL']);
const TEST_NAME_RE = /^test-[A-Za-z0-9][A-Za-z0-9._-]{0,58}$/;
const LOOPBACK_HOSTS = Object.freeze(['localhost', '127.0.0.1', '[::1]']);
const VERSION_IDLE_TIMEOUT_MS = 5000;    // 套接字空闲超时（对端不再发数据）
const VERSION_TOTAL_TIMEOUT_MS = 5000;   // 从请求开始计时的总截止（对端每隔不到空闲超时就滴一小块正文，空闲超时永远不触发，只有这个能结束请求）
const VERSION_MAX_BYTES = 1024 * 1024;
const SIGNAL_TEARDOWN_BOUND_MS = 20000;
/** 退出码兜底的固定非零值（契约：事件循环自然排空 + 从未 teardown() + 退出码本为 0 → 改成它；取 sysexits 的 EX_SOFTWARE，避开 1 / 2 / 3（脚本与监督进程）、97（套件辅助进程）、130 / 143（信号）） */
const EXIT_CODE_NO_TEARDOWN = 70;

class TestEnvError extends Error {
    constructor(code, message, extra) {
        super(message);
        this.name = 'TestEnvError';
        this.code = code;
        if (extra && typeof extra === 'object') Object.assign(this, extra);
    }
}

// ---------------------------------------------------------------- 路径比较

const fold = (p) => (process.platform === 'win32' ? String(p).toLowerCase() : String(p));

/** 已存在的部分走 realpath（解开 junction / 符号链接），不存在的尾部原样接回（与 utils/instance-db.js 的 realOf 同口径） */
function realOf(p) {
    const abs = path.resolve(p);
    const tail = [];
    let cur = abs;
    for (;;) {
        try {
            const real = fs.realpathSync.native(cur);
            return tail.length ? path.join(real, ...tail.reverse()) : real;
        } catch (_) {
            const up = path.dirname(cur);
            if (up === cur) return abs;
            tail.push(path.basename(cur));
            cur = up;
        }
    }
}

/** 同一物理文件（dev + ino，bigint）：硬链接绕过 realpath 的情形 */
function sameInode(a, b) {
    try {
        const sa = fs.statSync(a, { bigint: true });
        const sb = fs.statSync(b, { bigint: true });
        return sa.isFile() && sb.isFile() && sa.dev === sb.dev && sa.ino === sb.ino && sa.ino !== 0n;
    } catch (_) { return false; }
}

/**
 * 本检出的「业务库」候选路径：<wbs>/task_pool.db（正常模式即业务库本体；线检出里它是线库的默认位置）+ instance-mode 解出的 dbFile（线库 / SDH_DB_FILE）。
 * 判定被拒绝（refuse）时 fail-closed：不知道本检出该是什么模式，就不放行。
 */
function businessDbPaths(wbsDir, env, readFile) {
    const cfg = instanceMode.resolveInstanceConfig({ env, checkoutDir: wbsDir, readFile });
    if (cfg.refuse) throw new TestEnvError('TE_MODE_REFUSED', `本检出的运行模式判定被拒绝（${cfg.code}）：${cfg.message}`);
    const set = new Set([path.join(wbsDir, 'task_pool.db')]);
    if (cfg.dbFile) set.add(cfg.dbFile);
    return { cfg, paths: Array.from(set) };
}

// ---------------------------------------------------------------- 取值与校验

function readVars(env) {
    const out = {};
    for (const k of [...VAR_NAMES, ...LIVE_VARS]) out[k] = Object.prototype.hasOwnProperty.call(env, k) && env[k] !== undefined ? env[k] : undefined;
    return out;
}

/**
 * TEST_BASE_URL / TEST_LIVE_URL → 规范化的 origin；不带凭证 / 路径 / 查询 / 片段。
 * opts.httpOnly（变量组的 TEST_BASE_URL 用）：只收 http——服务身份核对（fetchVersion）只会 http.get，接受 https 等于接受一个永远连不上的地址；TEST_LIVE_URL 不受此限（真实环境核对是 https 也无妨）。
 */
function parseOrigin(name, value, opts) {
    let u;
    try { u = new URL(String(value)); } catch (_) { throw new TestEnvError('TE_BAD_VALUE', `${name} 不是合法 URL：${JSON.stringify(String(value).slice(0, 80))}`); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new TestEnvError('TE_BAD_VALUE', `${name} 只接受 http(s)：${u.protocol}`);
    if (opts && opts.httpOnly && u.protocol !== 'http:') throw new TestEnvError('TE_BAD_VALUE', `${name} 只接受 http（隔离实例是本机明文服务，服务身份核对不走 TLS）：${u.protocol}`);
    if (u.username || u.password) throw new TestEnvError('TE_BAD_VALUE', `${name} 不得带用户名 / 口令`);
    if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) throw new TestEnvError('TE_BAD_VALUE', `${name} 只接受 origin（协议://主机[:端口]），不接受路径 / 查询 / 片段：${JSON.stringify(String(value).slice(0, 80))}`);
    return { origin: u.origin, hostname: u.hostname, port: u.port, protocol: u.protocol };
}

/** 路径里第一个以 . 或空格结尾的段（空段、`.`、`..` 除外）；没有 → null */
function trailingDotOrSpaceSegment(p) {
    for (const seg of String(p).split(/[\\/]+/)) {
        if (seg === '' || seg === '.' || seg === '..') continue;
        if (/[. ]$/.test(seg)) return seg;
    }
    return null;
}
function requireLoopback(parsed) {
    if (!LOOPBACK_HOSTS.includes(parsed.hostname)) {
        throw new TestEnvError('TE_NOT_LOOPBACK', `TEST_BASE_URL 的主机必须是本机回环（localhost / 127.0.0.1 / ::1），收到 ${JSON.stringify(parsed.hostname)}`);
    }
}

/**
 * GET <origin>/api/version（不跟随重定向，正文上限 1MB，不复用连接）→ 解析后的普通对象；任何异常 → TE_SERVICE_UNREACHABLE。
 * 两道截止：套接字空闲超时（timing.idleMs，默认 5 秒）+ **从请求开始计时的总截止**（timing.totalMs，默认 5 秒）。只有空闲超时时，对端每隔不到空闲超时就滴一小块正文即可让请求永远不结束（S3b 修复批 1，codex 13 M3）。
 * 成功、失败、超时一律走同一个收口：清总截止计时器、销毁响应与请求（非 200 分支同样销毁，不再 res.resume() 后任连接留着）。timing 仅自检用。
 */
function fetchVersion(origin, timing) {
    const idleMs = timing && timing.idleMs !== undefined ? timing.idleMs : VERSION_IDLE_TIMEOUT_MS;
    const totalMs = timing && timing.totalMs !== undefined ? timing.totalMs : VERSION_TOTAL_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
        let settled = false;
        let req = null;
        let resp = null;
        let totalTimer = null;
        const release = () => {
            clearTimeout(totalTimer);
            try { if (resp) resp.destroy(); } catch (_) { /* 已关闭 */ }
            try { if (req) req.destroy(); } catch (_) { /* 已关闭 */ }
        };
        const fail = (why) => { if (settled) return; settled = true; release(); reject(new TestEnvError('TE_SERVICE_UNREACHABLE', `读取 ${origin}/api/version 失败：${why}`)); };
        const succeed = (j) => { if (settled) return; settled = true; release(); resolve(j); };
        totalTimer = setTimeout(() => fail(`超过 ${totalMs}ms 总截止`), totalMs);
        try {
            req = http.get(`${origin}/api/version`, { agent: false, timeout: idleMs, headers: { Accept: 'application/json', Connection: 'close' } }, (res) => {
                resp = res;
                if (res.statusCode !== 200) return fail(`HTTP ${res.statusCode}`);
                const chunks = [];
                let size = 0;
                res.on('data', (c) => {
                    size += c.length;
                    if (size > VERSION_MAX_BYTES) return fail('响应体超过 1MB');
                    chunks.push(c);
                });
                res.on('end', () => {
                    if (settled) return;
                    let j = null;
                    try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { return fail('响应不是 JSON'); }
                    if (j === null || typeof j !== 'object' || Array.isArray(j)) return fail('响应不是 JSON 对象');
                    succeed(j);
                });
                res.on('error', (e) => fail(e && e.code ? e.code : 'response error'));
                res.on('close', () => { if (!res.complete) fail('响应在正文传输中断开'); });
            });
        } catch (e) { return fail(e && e.message); }
        req.on('timeout', () => fail(`空闲超过 ${idleMs}ms`));
        req.on('error', (e) => fail(e && e.code ? e.code : (e && e.message)));
    });
}

function deriveDataDir(dbPath, instance) {
    try {
        const dir = path.dirname(dbPath);
        const m = JSON.parse(fs.readFileSync(path.join(dir, instanceMode.MANIFEST_FILE), 'utf8').replace(/^﻿/, ''));
        return m && m.instance === instance ? dir : null;
    } catch (_) { return null; }
}

// ---------------------------------------------------------------- 解析（可注入依赖，不带进程级记忆）

/**
 * 核心解析。deps（仅自检用）：{ env, wbsDir, readFile, startTestInstance, fetchVersion }；生产路径只传 options。
 * 返回环境对象（不含 handle 之外的任何敏感打印）。
 */
async function resolveEnvironment(options, deps) {
    const d = deps || {};
    const env = d.env || process.env;
    const wbsDir = d.wbsDir || WBS_DIR;
    const readFile = d.readFile || ((p) => fs.readFileSync(p, 'utf8'));
    const doStart = d.startTestInstance || testInstance.startTestInstance;
    const doFetchVersion = d.fetchVersion || fetchVersion;
    const v = readVars(env);
    const given = VAR_NAMES.filter((k) => v[k] !== undefined);
    const live = v.TEST_TARGET !== undefined || v.TEST_LIVE_URL !== undefined;

    // ---- ③ live ----
    if (live) {
        if (v.TEST_TARGET !== 'live') throw new TestEnvError('TE_BAD_VALUE', `TEST_TARGET 只接受 live（真实环境核对），收到 ${JSON.stringify(v.TEST_TARGET)}${v.TEST_TARGET === undefined ? '（只给了 TEST_LIVE_URL）' : ''}`);
        if (v.TEST_LIVE_URL === undefined || v.TEST_LIVE_URL === '') throw new TestEnvError('TE_BAD_VALUE', 'TEST_TARGET=live 必须同时给 TEST_LIVE_URL（真实环境地址，不回落任何默认值）');
        if (given.length > 0) throw new TestEnvError('TE_LIVE_CONFLICT', `TEST_TARGET=live 与变量组 ${given.join(' / ')} 互斥：真实环境核对不使用隔离实例的变量`);
        const { cfg } = businessDbPaths(wbsDir, env, readFile);
        if (cfg.mode !== 'normal') throw new TestEnvError('TE_LIVE_NOT_NORMAL', `TEST_TARGET=live 只允许在正常模式的检出里使用（本检出判定为 ${cfg.mode}，kind=${cfg.kind}）`);
        const o = parseOrigin('TEST_LIVE_URL', v.TEST_LIVE_URL);
        return makeEnv({ baseUrl: o.origin, instance: null, live: true, selfStarted: false, liveUrl: o.origin });
    }

    // ---- ① 变量组 ----
    if (given.length > 0) {
        if (given.length !== VAR_NAMES.length) {
            const missing = VAR_NAMES.filter((k) => v[k] === undefined);
            throw new TestEnvError('TE_PARTIAL_VARS', `${VAR_NAMES.join(' / ')} 必须全部提供或全部缺省；已给 ${given.join('、')}，缺 ${missing.join('、')}`);
        }
        for (const k of VAR_NAMES) if (typeof v[k] !== 'string' || v[k] === '') throw new TestEnvError('TE_BAD_VALUE', `${k} 不得为空`);
        const instance = v.TEST_INSTANCE;
        if (!TEST_NAME_RE.test(instance)) throw new TestEnvError('TE_INSTANCE_NOT_TEST', `TEST_INSTANCE 必须是 test- 开头的测试实例身份（${TEST_NAME_RE}），收到 ${JSON.stringify(instance.slice(0, 80))}`);
        const o = parseOrigin('TEST_BASE_URL', v.TEST_BASE_URL, { httpOnly: true });
        requireLoopback(o);
        // 永不回落 3000（正常模式的生产 / 本机主服务端口）：变量组指向 3000 一律拒绝，且在发出任何请求之前
        if (o.port === '3000') throw new TestEnvError('TE_BAD_VALUE', `TEST_BASE_URL 的端口不得是 3000（永不回落 3000：隔离实例用随机端口，3000 是正常模式的主服务）：${JSON.stringify(String(v.TEST_BASE_URL).slice(0, 80))}`);
        if (!path.isAbsolute(v.TEST_DB_PATH)) throw new TestEnvError('TE_BAD_VALUE', `TEST_DB_PATH 必须是绝对路径：${JSON.stringify(v.TEST_DB_PATH.slice(0, 120))}`);
        const dbPath = path.resolve(v.TEST_DB_PATH);
        // Win32 尾点 / 尾空格（S3b 预筛 MED-1）：Node 的 fs 走 \\?\ 命名空间，`task_pool.db.` 的 stat / realpath 报 ENOENT，下面的路径核对认不出；SQLite 的 CreateFileW 却会做 Win32 规范化，
        //   实际打开的就是业务库。不做规范化（规范化规则本身可能漏），任一路径段以 . 或空格结尾（原值与 path.resolve 之后各查一遍；. 与 .. 本身除外）一律拒绝，先于任何路径比较与打开。
        if (process.platform === 'win32') {
            const bad = trailingDotOrSpaceSegment(v.TEST_DB_PATH) || trailingDotOrSpaceSegment(dbPath);
            if (bad !== null) throw new TestEnvError('TE_BAD_VALUE', `TEST_DB_PATH 的路径段 ${JSON.stringify(bad)} 以 . 或空格结尾：Windows 会把它规范化成另一个名字，路径核对与实际打开的文件可能不是同一个，拒绝（业务库同名绕过）`);
        }

        // b. 路径核对（先于打开任何库）
        const { paths } = businessDbPaths(wbsDir, env, readFile);
        const realDb = fold(realOf(dbPath));
        for (const bp of paths) {
            if (realDb === fold(realOf(bp)) || sameInode(dbPath, bp)) {
                throw new TestEnvError('TE_DB_IS_BUSINESS', `TEST_DB_PATH 指向本检出的业务库（${bp}）：拒绝（测试写不进业务库）`);
            }
        }
        // c. 服务身份
        const ver = await doFetchVersion(o.origin);
        if (ver.instance !== instance || ver.mode !== 'isolated') {
            throw new TestEnvError('TE_SERVICE_IDENTITY', `${o.origin}/api/version 的身份不符：instance=${JSON.stringify(ver.instance === undefined ? null : ver.instance)} mode=${JSON.stringify(ver.mode === undefined ? null : ver.mode)}，期望 ${instance} / isolated`);
        }
        // d. 库身份（只读）
        const idr = await instanceDb.checkInstanceIdentity(dbPath, { expectedInstance: instance });
        if (!idr.ok) throw new TestEnvError('TE_DB_IDENTITY', `TEST_DB_PATH 的库内身份核对失败（${idr.code}）：${idr.message}`);
        return makeEnv({ baseUrl: o.origin, dbPath, instance, jwtSecret: v.TEST_JWT_SECRET, dataDir: deriveDataDir(dbPath, instance), live: false, selfStarted: false });
    }

    // ---- ② 自起 ----
    const handle = await doStart(options === undefined ? {} : options);
    return makeEnv({
        baseUrl: handle.baseUrl, dbPath: handle.dbPath, instance: handle.instance, jwtSecret: handle.jwtSecret, dataDir: handle.dataDir, logFile: handle.logFile,
        live: false, selfStarted: true, startupRaceRetries: handle.startupRaceRetries, handle,
    });
}

function makeEnv(f) {
    const e = {
        baseUrl: f.baseUrl,
        instance: f.instance === undefined ? null : f.instance,
        live: !!f.live,
        selfStarted: !!f.selfStarted,
        dataDir: f.dataDir === undefined ? null : f.dataDir,
        logFile: f.logFile === undefined ? null : f.logFile,
        startupRaceRetries: f.startupRaceRetries === undefined ? 0 : f.startupRaceRetries,
    };
    if (f.live) {
        // live：库与密钥一律不可用——访问即抛（不可枚举，展开 / JSON 序列化不会触发）
        Object.defineProperty(e, 'dbPath', { enumerable: false, get() { throw new TestEnvError('TE_LIVE_NO_DB', 'TEST_TARGET=live 不提供实例库路径（dbPath 不可用）'); } });
        Object.defineProperty(e, 'jwtSecret', { enumerable: false, get() { throw new TestEnvError('TE_LIVE_NO_TOKEN', 'TEST_TARGET=live 不提供实例密钥（jwtSecret 不可用，不能签 token）'); } });
        Object.defineProperty(e, 'liveUrl', { enumerable: true, value: f.liveUrl });
    } else {
        e.dbPath = f.dbPath;
        e.jwtSecret = f.jwtSecret;
    }
    if (f.handle) Object.defineProperty(e, '_handle', { enumerable: false, value: f.handle });
    return e;
}

// ---------------------------------------------------------------- 进程级状态

const state = { promise: null, optionsKey: null, env: null, failed: null, tornDown: false, teardownPromise: null, hooksInstalled: false, deps: null };
/** 退出码兜底的进程级记忆：installed = 监听器已装（一个进程只装一次）；naturalDrain = 'beforeExit' 触发过（事件循环排空过）；teardownCalled = teardown() 被调用过（含失败重试、含 ready() 进行中的调用）；
 *  explicitExit = 装兜底之后有人显式调用过 process.exit（包装函数记的标记，不看调用时机） */
const sentinel = { installed: false, naturalDrain: false, teardownCalled: false, explicitExit: false, teardownSettled: false, teardownFailed: false, teardownGen: 0 };
// teardown 落定记账（finish 的前置，S4-x 修复批 1）：teardownGen = 「尝试」代次，teardownCore 每开始一次新的尝试（真的去停实例）才 +1 并清 settled / failed；
//   teardownSettled = 当前代次的尝试已落定（成功或失败）；teardownFailed = 当前代次的尝试失败了。只有「当前代次」的落定回调能更新这两项；resetForTest 也 +1，让旧回调失效。
/** finish(code) 的进程级记忆：requested = 调用方传入的 code（null = 还没调用；幂等 / 冲突按它比）；code = 实际设定的退出码（teardown 失败时 finish(0) 会被改成 1）；timer = 兜底计时器 */
const finishState = { requested: null, code: null, timer: null };
/** finish 的测试接缝（默认值即生产值）：fallbackMs 兜底时长；setTimeout 计时器函数（返回带 unref 的句柄）；exit 到时调用的退出函数（惰性取 process.exit，所以走哨兵的包装） */
const FINISH_FALLBACK_MS = 10000;
const finishDeps = { fallbackMs: FINISH_FALLBACK_MS, setTimeout: (fn, ms) => setTimeout(fn, ms), exit: (c) => process.exit(c) };

/** options 的规范化 JSON：键序无关、值为 undefined 的键忽略、数组保持顺序；undefined 按 {} 算。无法序列化（循环引用等）→ TE_BAD_VALUE */
function canonicalOptions(options) {
    const norm = (v, depth) => {
        if (depth > 16) throw new Error('嵌套过深');
        if (Array.isArray(v)) return v.map((x) => norm(x, depth + 1));
        if (v !== null && typeof v === 'object') {
            const o = {};
            for (const k of Object.keys(v).sort()) if (v[k] !== undefined) o[k] = norm(v[k], depth + 1);
            return o;
        }
        return v;
    };
    try { return JSON.stringify(norm(options === undefined ? {} : options, 0)); } catch (e) {
        throw new TestEnvError('TE_BAD_VALUE', `ready(options) 的 options 必须是可序列化的普通数据：${e && e.message}`);
    }
}

/** 两份规范化选项（canonicalOptions 的输出）里取值不同的顶层键名，按字典序；只返回键名，不含值。 */
function optionDiffKeys(aKey, bKey) {
    let a; let b;
    try { a = JSON.parse(aKey); b = JSON.parse(bKey); } catch (_) { return ['（无法解析）']; }
    const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    if (!isObj(a) || !isObj(b)) return ['（整体形态不同）'];
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    const diff = keys.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
    return diff.length ? diff : ['（结构不同）'];
}

/** 退出路径（同步）：Node 的 'exit' 里只能做同步事。启动器的 exit 钩子先 child.kill()；这里等进程真的退出（有界），必要时按精确身份终止，再删数据根；删不掉留给 sweep。 */
function syncExitCleanup() {
    const h = state.env && state.env._handle;
    if (!h || state.tornDown) return;
    try {
        const waitDead = (ms) => {
            const end = Date.now() + ms;
            const cell = new Int32Array(new SharedArrayBuffer(4));
            while (Date.now() < end) {
                if (!procLib.isAlive(h.pid)) return true;
                Atomics.wait(cell, 0, 0, 50);
            }
            return !procLib.isAlive(h.pid);
        };
        if (!waitDead(400)) {
            if (h.startTime) { try { procLib.killIfIdentity({ pid: h.pid, start_time: h.startTime }); } catch (_) { /* 下面按是否已退出判定 */ } }
            waitDead(5000);
        }
        if (!procLib.isAlive(h.pid)) {
            const left = testInstance._internals.removeDataRoot(h.dataDir);
            if (left) process.stderr.write(`[test-env] 退出清理未完成，留给 sweepStaleTestInstances：${left}\n`);
        } else {
            process.stderr.write(`[test-env] 服务进程 ${h.pid} 退出时仍存活，数据根保留：${h.dataDir}\n`);
        }
    } catch (e) {
        process.stderr.write(`[test-env] 退出清理异常：${e && e.message}\n`);
    }
}

function installHooks() {
    if (state.hooksInstalled) return;
    state.hooksInstalled = true;
    process.on('exit', syncExitCleanup);
    process.on('SIGINT', () => { shutdownOnSignal('SIGINT'); });
    process.on('SIGTERM', () => { shutdownOnSignal('SIGTERM'); });
}

/**
 * 退出码兜底（见文件头「退出码兜底」）。ready() 首次成功后装上，三种形态一律适用。
 *   process.exit 包装：记 explicitExit = true 后用原参数、原 this 调用原函数，返回行为（不返回）原样。不再靠 setImmediate 复位之类的时序猜测（S3b 收口小批，codex 13-R2 M / 预筛 LOW-1：
 *   那种做法对「ready 之前注册的 beforeExit 监听器用 setImmediate 调 exit(0)」「ready 之后注册的监听器同步 / nextTick / 微任务调 exit(0)」会误报 70）。
 *   beforeExit：事件循环自然排空时触发（process.exit() / 未捕获异常不触发）→ 记 naturalDrain；不复位、不依赖监听器注册先后。
 *   exit：naturalDrain 且从未显式 process.exit 且退出码为 0 / 未设置：teardown() 从未被调用 → 退出码改为 EXIT_CODE_NO_TEARDOWN 并写一行原因；teardown() 被调用过但最近一次失败 → 退出码改为 1 并写一行原因。整个监听器 try/catch 包住，永不抛出（后注册，清理监听器先跑）。
 *   局限（登记）：装兜底之前就取走 process.exit 引用的代码（const { exit } = process）绕过标记；它们的退出会被当成「自然退出」——只在同时满足 beforeExit 触发过时才可能误报。
 */
function sentinelBeforeExit() {
    sentinel.naturalDrain = true;
}
function sentinelOnExit(code) {
    try {
        if (!sentinel.naturalDrain || sentinel.explicitExit) return;
        const pc = process.exitCode;
        const zero = (code === 0 || code === undefined) && (pc === undefined || pc === null || Number(pc) === 0);
        if (!zero) return;
        if (sentinel.teardownCalled) {
            // 已调用过 teardown()：不是「没收尾」。但最近一次 teardown 失败（被 .catch 吞掉后自然结束）退出码仍是 0 → 改成 1 并写一行原因（与 finish(0) 遇到失败的 teardown 同口径）
            if (sentinel.teardownFailed) {
                process.exitCode = 1;
                const fmsg = '[test-env] 退出码兜底：最近一次 teardown 失败，脚本因事件循环排空而退出，退出码 0 被改为 1。\n';
                try { fs.writeSync(2, fmsg); } catch (_) { try { process.stderr.write(fmsg); } catch (_2) { /* 无处可写：退出码已改 */ } }
            }
            return;
        }
        process.exitCode = EXIT_CODE_NO_TEARDOWN;
        const msg = `[test-env] 退出码兜底：脚本因事件循环排空而退出（自然结束或卡在永不落定的 promise），既没有 await teardown() 也没有 process.exit()，退出码 0 被改为 ${EXIT_CODE_NO_TEARDOWN}。已迁移脚本必须以 await teardown() 或 process.exit(code) 收尾。\n`;
        try { fs.writeSync(2, msg); } catch (_) { try { process.stderr.write(msg); } catch (_2) { /* 无处可写：退出码已改 */ } }
    } catch (_) { /* 兜底监听器不得抛出 */ }
}
function installSentinel() {
    if (sentinel.installed) return;
    sentinel.installed = true;
    const realExit = process.exit;
    process.exit = function exit(...a) {
        sentinel.explicitExit = true;
        return realExit.apply(this, a);
    };
    process.on('beforeExit', sentinelBeforeExit);
    process.on('exit', sentinelOnExit);
}

/**
 * 收到 SIGINT / SIGTERM：先 teardown（有界 SIGNAL_TEARDOWN_BOUND_MS），再以 130 / 143 退出。exitFn 仅供自检注入（默认 process.exit）。
 * 注：Windows 上跨进程的 child.kill('SIGINT') 走 TerminateProcess，不经 JS 监听器；中断路径的自检直接调用本函数。
 */
function shutdownOnSignal(sig, exitFn) {
    const exit = typeof exitFn === 'function' ? exitFn : process.exit;
    let timer = null;
    const bound = new Promise((r) => { timer = setTimeout(r, SIGNAL_TEARDOWN_BOUND_MS); if (timer.unref) timer.unref(); });
    return Promise.race([teardown().catch(() => {}), bound]).then(() => { clearTimeout(timer); exit(sig === 'SIGINT' ? 130 : 143); });
}

// ---------------------------------------------------------------- 公开 API

function ready(options) {
    let key;
    try { key = canonicalOptions(options); } catch (e) { return Promise.reject(e); }
    if (state.promise !== null && options !== undefined && key !== state.optionsKey) {
        // 第二次及以后的 ready(options) 与首次不一致：不静默忽略（不传 options 视为与首次一致，上面的 options !== undefined 已排除）。拒绝只发给本次调用方，首次的 Promise 与实例不受影响
        //   只报不一致的选项名、不回显选项值（sourceEncryptionKey 等机密会随 options 进来；47R4a M3）
        return Promise.reject(new TestEnvError('TE_OPTIONS_CONFLICT', `ready(options) 的 options 与首次调用不一致：本进程只建一次实例，后到的选项不会生效。不一致的选项：${optionDiffKeys(state.optionsKey, key).join('、')}（不回显选项值）`));
    }
    if (state.promise === null) {
        // 新的启动周期：此前没有实例时调用的空 teardown() 不算本实例的收尾，否则「先 teardown 再 ready、之后卡住」会以 0 退出（47R4a M1）
        sentinel.teardownCalled = false; sentinel.teardownSettled = false; sentinel.teardownFailed = false;
        state.optionsKey = key;
        state.promise = resolveEnvironment(options, state.deps).then((e) => {
            state.env = e;
            if (e.selfStarted) installHooks();   // 先装清理监听器，后装兜底监听器：exit 时清理先跑
            installSentinel();
            return e;
        }, (err) => {
            state.failed = err;
            throw err;
        });
        state.promise.catch(() => {});   // 失败也不触发「未处理的拒绝」：调用方各自 await 时会收到同一个拒绝
    }
    return state.promise;
}

function isReady() { return state.env !== null && !state.tornDown; }

function env() {
    if (state.env === null) {
        throw new TestEnvError('TE_NOT_READY', state.failed ? `test-env 就绪失败：${state.failed.message}` : 'test-env 尚未就绪：先 await testEnv.ready()');
    }
    if (state.tornDown) throw new TestEnvError('TE_TORN_DOWN', 'test-env 的实例已经 teardown');
    return state.env;
}

function teardown() {
    sentinel.teardownCalled = true;   // 「已显式收尾」：调用即记（此后不再报 70；最近一次 teardown 失败且退出码为 0 时由哨兵改为 1）
    // 落定记账（finish 的前置）：原 promise 的拒绝由内部处理器接收，并在返回的派生 promise 中原样重新抛出（同一个错误对象）；调用方不消费派生 promise 时仍产生未处理拒绝
    //   （脚本里裸调 teardown()（不 await 不 catch）且它失败，进程退出码非零；S4-x 修复批 1，预筛 H1）。每次调用返回新的派生 promise，各自需处理——
    //   只处理其中一个，另一个失败时仍是未处理的拒绝。
    //   代次：只有当前代次的落定回调能更新状态（旧回调——例如复用同一个 promise 的更早调用、resetForTest 之前的调用——落定得更晚也不会把重试进行中的状态改回「已落定」）。
    //   这里的 then 先于调用方的 await / .catch 注册，所以 `await teardown()` 之后同步调用 finish() 时标记已置。
    const p = teardownCore();
    const gen = sentinel.teardownGen;
    return p.then((v) => { if (gen === sentinel.teardownGen) { sentinel.teardownSettled = true; sentinel.teardownFailed = false; } return v; },
        (e) => { if (gen === sentinel.teardownGen) { sentinel.teardownSettled = true; sentinel.teardownFailed = true; } throw e; });
}

function teardownCore() {
    if (state.teardownPromise !== null) return state.teardownPromise;   // 复用已有的尝试（进行中或已完成）：不开新代次，不清「已落定」
    if (state.promise === null) return Promise.resolve();   // 从没调用过 ready()：没有实例要收，也不锁存（之后的 ready() 照常工作）
    sentinel.teardownGen += 1; sentinel.teardownSettled = false; sentinel.teardownFailed = false;   // 开始一次新的尝试
    const myGen = sentinel.teardownGen;   // 本次尝试的代次：await 之后若代次已变（目前只有 resetForTest 会让代次在尝试进行中变化），旧尝试不再读写 state（不碰新场景的 env 句柄 / tornDown / teardownPromise）
    state.teardownPromise = (async () => {
        // 就绪还在进行中：等它落定再收（自起的实例此时可能刚好起来）
        try { await state.promise; } catch (_) { /* 就绪失败：没有实例要收 */ }
        if (myGen !== sentinel.teardownGen) return;
        const h = state.env && state.env._handle;
        if (h) {
            try { await h.stop(); } catch (e) { if (myGen === sentinel.teardownGen) state.teardownPromise = null; throw e; }   // 失败允许重试
        }
        if (myGen !== sentinel.teardownGen) return;
        state.tornDown = true;
    })();
    return state.teardownPromise;
}

/**
 * 收尾助手（见文件头 finish(code) 一节：为什么存在 + 对照实验）。顺序：参数校验 → teardown 前置 → 重复调用判定 → 设退出码 + 装 unref 兜底计时器。
 * 不调用 teardown（职责单一，不吞 teardown 的错误）；不调用 process.exit（兜底计时器到时才调）。
 */
function finish(code) {
    if (typeof code !== 'number' || !Number.isInteger(code) || code < 0 || code > 255) {
        throw new TestEnvError('TE_BAD_FINISH_CODE', `finish(code) 的 code 必须是 0–255 的整数，收到 ${typeof code === 'number' ? code : typeof code}`);
    }
    if (!sentinel.teardownCalled || !sentinel.teardownSettled) {
        throw new TestEnvError('TE_FINISH_BEFORE_TEARDOWN', sentinel.teardownCalled
            ? 'finish(code) 要等 teardown() 落定之后调用：teardown() 还在进行中（先 await teardown()）'
            : 'finish(code) 要在 await teardown() 之后调用：teardown() 从未被调用（finish 不替你收尾）');
    }
    if (finishState.requested !== null) {
        if (finishState.requested === code) return;   // 同一 code 幂等：不重复装计时器
        throw new TestEnvError('TE_FINISH_CONFLICT', `finish(code) 已用 ${finishState.requested} 调用过，不能再用不同的 ${code} 调用`);
    }
    // 最近一次 teardown 失败却要报成功（finish(0)）：实际退出码改为 1，stderr 写一行原因；不抛错（预筛 H2：失败的收尾不能被 finish(0) 悄悄洗成 0）
    let eff = code;
    if (code === 0 && sentinel.teardownFailed) {
        eff = 1;
        const msg = '[test-env] test-env.finish: 最近一次 teardown 失败，退出码由 0 改为 1\n';
        try { fs.writeSync(2, msg); } catch (_) { try { process.stderr.write(msg); } catch (_2) { /* 无处可写：退出码已改 */ } }
    }
    finishState.requested = code;
    finishState.code = eff;
    process.exitCode = eff;
    const timer = finishDeps.setTimeout(() => { finishDeps.exit(eff); }, finishDeps.fallbackMs);
    if (timer && typeof timer.unref === 'function') timer.unref();   // 不阻止进程自然退出：兜底只在事件循环被别的句柄拖住时才起作用
    finishState.timer = timer;
}

async function signToken(userId) {
    const e = env();
    if (e.live) throw new TestEnvError('TE_LIVE_NO_TOKEN', 'TEST_TARGET=live 不提供实例密钥，不能签 token');
    const dbPath = e.dbPath;
    const jwtSecret = e.jwtSecret;
    const user = await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (oe) => {
            if (oe) return reject(oe);
            db.get('SELECT id, username, display_name, role FROM users WHERE id=?', [userId], (err, row) => { db.close(() => (err ? reject(err) : resolve(row))); });
        });
    });
    if (!user) throw new TestEnvError('TE_USER_NOT_FOUND', `实例库里没有 user id=${userId}`);
    return jwt.sign({ id: user.id, username: user.username, display_name: user.display_name, role: user.role }, jwtSecret, { expiresIn: '1h' });
}

function childEnv() {
    const e = env();
    if (e.live) return { TEST_TARGET: 'live', TEST_LIVE_URL: e.liveUrl };
    return { TEST_INSTANCE: e.instance, TEST_BASE_URL: e.baseUrl, TEST_DB_PATH: e.dbPath, TEST_JWT_SECRET: e.jwtSecret };
}

/** 仅供自检：清掉进程级记忆；deps 非空时 ready() 用它替换环境 / 检出目录 / 启动器（生产代码不调用） */
function resetForTest(deps) {
    state.promise = null; state.optionsKey = null; state.env = null; state.failed = null; state.tornDown = false; state.teardownPromise = null;
    state.deps = deps || null;
    sentinel.teardownCalled = false; sentinel.teardownSettled = false; sentinel.teardownFailed = false;
    sentinel.teardownGen += 1;   // 单调递增（不归零）：让 reset 之前发出的 teardown 的落定回调失效
    // finish 的进程级记忆与测试接缝一并复位（清掉已装的兜底计时器；接缝回到生产默认值）
    try { if (finishState.timer) clearTimeout(finishState.timer); } catch (_) { /* 注入的替身句柄：忽略 */ }
    finishState.requested = null; finishState.code = null; finishState.timer = null;
    finishDeps.fallbackMs = FINISH_FALLBACK_MS;
    finishDeps.setTimeout = (fn, ms) => setTimeout(fn, ms);
    finishDeps.exit = (c) => process.exit(c);
}

module.exports = {
    ready, teardown, finish, env, signToken, childEnv, isReady,
    TestEnvError, VAR_NAMES, LIVE_VARS, EXIT_CODE_NO_TEARDOWN, FINISH_FALLBACK_MS,
    _internals: { resolveEnvironment, resetForTest, businessDbPaths, realOf, sameInode, parseOrigin, fetchVersion, syncExitCleanup, shutdownOnSignal, canonicalOptions, trailingDotOrSpaceSegment, state, sentinel, testInstance, finishState, finishDeps },
};
