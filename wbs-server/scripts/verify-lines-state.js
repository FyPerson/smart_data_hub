/**
 * #106 S2a 验证：线路登记表与唯一状态更新入口（scripts/lines/state.js）。
 * 只用 os.tmpdir() 下新建的临时目录（含一层「中文 + 空格」子目录，模拟真实控制根的中文路径）；不读写真实控制根、不碰业务库、不起 server。
 * 测试自建的临时 git 仓库里才执行 git 命令。清理不用 fs.rmSync（Node v24 对中文路径静默不删）：逐项 unlinkSync / rmdirSync 并 lstat 确认，残留判红。
 *
 * 覆盖：1 控制根解析（含 junction cwd / 小写盘符 / GIT_DIR 环境变量 / 不存在的 cwd）  2 并发不丢（整表全等）  3 持有者被强杀（含 rename 前强杀）
 *       4 活着的持有者不被接管（显式释放信号；锁内读）  5 补丁函数返回 Promise / 抛错  6 登记表损坏不重置（含记录级损坏夹具、版本、BOM、读失败）  7 线名
 *       8 槽位与 history（固定时钟，整表全等）  8b 测试端口表（H1：设置函数拒绝非法表、分配与校验读测试表、不写进登记表）  9 状态转换  9b 进程登记不变量  10 中文 + 空格控制根  11 清理
 *       12 确定性争用  13 并发建线  14 实现项：14a 短写 / 写失败  14b 关闭 / COMMIT / ROLLBACK 失败  14c 假值异常  14d async 补丁  14e 非法输入  14f 排队超时
 *       14g createLine 的 guard  14h 时间戳在锁内取  14i–14m 修复批 2 项（不确定标记 / stateWritten / init 快照 / 跨上下文 Promise / openSync）  15 / 15b 线级锁与代次
 *       修复批 3：14n 不确定标记按控制根隔离  14o 已入队调用出队后复查  15c 重入判定（独立链排队 / 令牌失效 / 嵌套共享 / 持有截止与时间系数）  15d 线级锁收尾错误不吞  15e 代次检查在锁内且早于补丁
 *
 * 子进程纪律：全部子进程被跟踪，每个等待都有父进程截止时间（超时记失败、taskkill /F 强杀、等 close）；finally 先回收所有存活子进程再清理临时目录；
 *   输出在 close 事件之后解析；处理 error 事件与无效结果；子进程用 process.exitCode 自然退出。
 * 守卫挂起必须非零退出：入口先 process.exitCode = 1，只有跑到汇总且 FAIL=0 才置 0；beforeExit 兜底；进程内的锁调用都有有界超时（首个卡死后其余快速失败）；另有全局看门狗。
 * 每一节独立 try/catch：一节异常不跳过后续各节。
 *
 * 运行：node scripts/verify-lines-state.js
 * 变异自证用：传 --module=<被测 state.js 副本的绝对路径>（或设置环境变量 LINES_STATE_MODULE），子进程同样加载副本；--deadline-ms=<毫秒> 调小子进程截止时间（演示用）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const vm = require('vm');
const { EventEmitter } = require('events');

const IS_WORKER = process.argv[2] === '--worker';
const MODULE_ARG = process.argv.find((a) => a.startsWith('--module=')) || null;
const MODULE_PATH = MODULE_ARG ? MODULE_ARG.slice('--module='.length) : process.env.LINES_STATE_MODULE;
const STATE_MODULE = MODULE_PATH ? path.resolve(MODULE_PATH) : path.join(__dirname, '..', '..', 'scripts', 'lines', 'state.js');
// 时间系数：所有「卡死截止」类的毫秒数统一乘它（--time-scale=<倍数>，默认 1，慢机可放大）。正确性不再依赖实际耗时，耗时只用于独立宽松的卡死截止。
const SCALE_ARG = process.argv.find((a) => a.startsWith('--time-scale='));
const TS = SCALE_ARG ? Number(SCALE_ARG.slice('--time-scale='.length)) : 1;
const sc = (n) => Math.round(n * TS);   // scale：卡死截止类毫秒数乘时间系数
const DEADLINE_ARG = process.argv.find((a) => a.startsWith('--deadline-ms='));
const DEADLINE_OVERRIDE = DEADLINE_ARG ? Number(DEADLINE_ARG.slice('--deadline-ms='.length)) : null;   // 统一覆盖子进程截止时间；只在演示「误实现判红而不挂起」时调小
const RAW = require(STATE_MODULE);
const SET_HOOKS = RAW._internal.setTestHooks;
const resetHooks = () => SET_HOOKS(null);

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sleepAsync = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (p, ms, label) => new Promise((resolve, reject) => {
    const t = setTimeout(() => { const e = new Error(`${label} 超过 ${ms}ms 没有完成`); e.hang = true; reject(e); }, ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

// 进程内的锁调用都有界：超过 INPROC_MS 判卡死；首个卡死之后其余调用快速失败，整套不会挂起也不会拖成几十分钟
const INPROC_MS = sc(45000);
let poisoned = null;
const OPTS_INDEX = { readState: 1, updateLine: 3, updateConfig: 2, createLine: 3, removeLineRecord: 2 };
const DEFAULT_TEST_LOCK_MS = sc(8000);   //没显式给 lockTimeoutMs 的调用用 8 秒（模块默认 15 秒），卡死的队列不会让整套拖到看门狗
const bounded = (name) => (...a) => {
    if (poisoned) return Promise.reject(new Error(`进程内锁调用已判卡死（${poisoned}），后续调用快速失败`));
    const i = OPTS_INDEX[name];
    const explicit = !!(a[i] && a[i].lockTimeoutMs !== undefined);
    if (!explicit) { a[i] = Object.assign({}, a[i] || {}, { lockTimeoutMs: DEFAULT_TEST_LOCK_MS }); }
    // 没给显式上限的调用不该等到锁超时：一旦发生，说明前面的调用没有释放队列 / 锁，判卡死，其余调用快速失败
    return within(RAW[name](...a), INPROC_MS, `S.${name}`).catch((e) => {
        if (!poisoned && e && (e.hang || (!explicit && e.code === 'STATE_LOCK_TIMEOUT'))) poisoned = `${name}${e.hang ? ' 无响应' : ' 在默认上限内取不到锁'}`;
        throw e;
    });
};
const S = Object.assign({}, RAW, { readState: bounded('readState'), updateLine: bounded('updateLine'), updateConfig: bounded('updateConfig'), createLine: bounded('createLine'), removeLineRecord: bounded('removeLineRecord') });

// 固定时钟：整表全等比较用
const T = (n) => `2026-03-01T00:00:0${n}.000Z`;
const T0 = T(0); const T1 = T(1); const T2 = T(2); const T3 = T(3); const T4 = T(4); const T5 = T(5); const T6 = T(6); const T7 = T(7); const T8 = T(8);
const at = (iso) => ({ now: () => new Date(iso) });

// ================================================================ 子进程角色

function syncWaitFor(file, capMs) {
    const t0 = Date.now();
    while (!fs.existsSync(file)) {
        if (Date.now() - t0 > capMs) throw new Error(`等待信号文件超时：${file}`);
        sleepSync(20);
    }
}

async function workerMain(spec) {
    const out = (o) => process.stdout.write(`RESULT:${JSON.stringify(o)}\n`);
    const opts = (extra) => Object.assign({ lockTimeoutMs: spec.timeoutMs }, spec.now ? { now: () => new Date(spec.now) } : {}, extra || {});
    try {
        if (spec.role === 'incr') {
            for (let i = 0; i < spec.count; i++) {
                await RAW.updateLine(spec.controlRoot, spec.name, (r) => {
                    if (spec.kind === 'yield') r.yield_request = { n: ((r.yield_request && r.yield_request.n) || 0) + 1 };
                    else r.module = String(Number(r.module || 0) + 1);
                }, opts());
            }
            out({ ok: true });
        } else if (spec.role === 'hold-config') {
            // 持锁期间同步阻塞：先写标记文件，再等父进程的显式释放信号（release 文件）；forever = 一直挂着等被强杀（安全上限 spec.capMs，父进程传入的已按 --time-scale 放大的值）
            await RAW.updateConfig(spec.controlRoot, (cfg) => {
                cfg.integration_branch = spec.value;
                fs.writeFileSync(spec.marker, 'held');
                if (spec.forever) { const t0 = Date.now(); while (Date.now() - t0 < spec.capMs) sleepSync(250); throw new Error('forever 持有者没被强杀'); }
                syncWaitFor(spec.release, spec.capMs);
            }, opts());
            out({ ok: true });
        } else if (spec.role === 'hold-line') {
            await RAW.updateLine(spec.controlRoot, spec.name, (r) => {
                fs.writeFileSync(spec.marker, 'held');
                syncWaitFor(spec.release, spec.capMs);
                r[spec.field] = spec.value;
            }, opts());
            out({ ok: true });
        } else if (spec.role === 'hang-rename') {
            // 临时文件已写完、rename 之前挂住（经测试接缝），等被强杀
            SET_HOOKS({ renameSync: () => { fs.writeFileSync(spec.marker, 'at-rename'); syncWaitFor(spec.release, spec.capMs); throw new Error('本角色只用于被强杀'); } });
            await RAW.updateConfig(spec.controlRoot, (cfg) => { cfg[spec.key] = spec.value; }, opts());
            out({ ok: true });
        } else if (spec.role === 'set-config') {
            const t0 = Date.now();
            await RAW.updateConfig(spec.controlRoot, (cfg) => { cfg[spec.key] = spec.value; }, opts());
            out({ ok: true, ms: Date.now() - t0 });
        } else if (spec.role === 'line-hold') {
            // 线级锁持有者：跨 await 持有（异步等父进程的释放信号文件；持有截止 = spec.capMs，父进程传入的已按 --time-scale 放大的值；forever 同样有上限），期间写标记文件
            await RAW.withLineLock(spec.controlRoot, spec.name, async () => {
                fs.writeFileSync(spec.marker, 'held');
                const t0 = Date.now();
                while (spec.forever || !fs.existsSync(spec.release)) {
                    if (Date.now() - t0 > spec.capMs) throw new Error('线级锁持有者等待超时（没被强杀 / 没收到释放信号）');
                    await new Promise((r) => setTimeout(r, 20));
                }
            }, opts());
            out({ ok: true });
        } else if (spec.role === 'echo') {
            // 回显收到的时间预算：验证父进程把已放大的截止传进了子进程
            out({ ok: true, capMs: spec.capMs, timeoutMs: spec.timeoutMs });
        } else if (spec.role === 'recycle') {
            // 删除归档 + 同名重建（调用前线已在 removing）：另一进程在目标操作暂停于 BEGIN 期间完成
            await RAW.removeLineRecord(spec.controlRoot, spec.name, opts());
            const rec = await RAW.createLine(spec.controlRoot, spec.name, { module: spec.module }, opts());
            out({ ok: true, generation: rec.generation });
        } else if (spec.role === 'line-try') {
            // 线级锁等待者：先写 waiting 标记再去取锁，取到后写 entered 标记；超时则输出错误码
            fs.writeFileSync(spec.waitingFile, '1');
            try {
                await RAW.withLineLock(spec.controlRoot, spec.name, async () => { fs.writeFileSync(spec.enteredFile, '1'); }, opts());
                out({ ok: true });
            } catch (e) {
                out({ ok: false, code: e && e.code, message: e && e.message });
            }
        } else if (spec.role === 'create') {
            // 起跑线：写就绪文件，等父进程写起跑文件，4 个进程同时开始
            fs.writeFileSync(spec.readyFile, '1');
            const t0 = Date.now();
            while (!fs.existsSync(spec.goFile)) {
                if (Date.now() - t0 > spec.capMs) throw new Error('等待起跑信号超时');
                sleepSync(1);
            }
            try {
                const rec = await RAW.createLine(spec.controlRoot, spec.name, undefined, opts());
                out({ ok: true, name: rec.name, slot: rec.slot, port: rec.port });
            } catch (e) {
                out({ ok: false, code: e && e.code, message: e && e.message });
            }
        } else {
            out({ ok: false, code: 'BAD_ROLE' });
            process.exitCode = 2;
        }
    } catch (e) {
        out({ ok: false, code: e && e.code, message: e && e.message });
        process.exitCode = 3;
    }
}

// ================================================================ 主进程

let pass = 0;
let fail = 0;
let baseDir = null;
let summaryPrinted = false;
const ok = (m) => { pass++; console.log(`  [OK] ${m}`); };
const bad = (m, d) => { fail++; console.log(`  [FAIL] ${m}${d ? '\n         ' + d : ''}`); };
const must = (cond, m, d) => (cond ? ok(m) : bad(m, d));
const section = (t) => console.log(`\n== ${t} ==`);
const jstr = (v) => { try { return JSON.stringify(v); } catch (_) { return String(v); } };
/** 稳定序列化（键排序），整表全等比较用。 */
const canon = (v) => {
    if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
    // generation 是运行时随机 UUID：整表全等比较时按占位符处理（它的格式 / 唯一性 / 不可改 / 同名重建换新在 15b 节单独断言）
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${k === 'generation' ? '"<GEN>"' : canon(v[k])}`).join(',')}}`;
    return JSON.stringify(v);
};
const eq = (a, b) => canon(a) === canon(b);
const errOf = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
/** 区分「没抛」与「抛了 null / undefined / 0 / false / ''」。 */
const caught = async (fn) => { try { await fn(); return { threw: false }; } catch (value) { return { threw: true, value }; } };
/** 每一节独立 try/catch：一节异常不跳过后续各节；节末复位测试接缝。 */
async function sec(title, fn) {
    section(title);
    try { await fn(); } catch (e) { bad(`节「${title}」未预期异常`, e && e.stack); } finally { resetHooks(); }
}

// ---- 子进程：全部跟踪；每个等待有父进程截止时间；超时强杀并等 close；输出在 close 之后解析
const liveWorkers = new Set();
let timedOutWorkers = 0;
function killHard(pid) {
    if (!pid) return;
    if (process.platform === 'win32') execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    else process.kill(pid, 'SIGKILL');
}
// 两个状态分开：w.done = 「等待结果已结算」（close 到了，或截止后放弃等待）；w.closed = 「进程已 close，或确认从未启动」。
//   只有 closed 才移出存活集合；强杀失败 / 缺 close 的记录留到最后，reapAll 报告它们的 PID。
// deadlineMs 默认 2 分钟（乘时间系数）；完整工作量大的 worker（200 次落盘循环）调用处显式给更大的值
function startWorker(specIn, deadlineMs = sc(120000)) {
    if (DEADLINE_OVERRIDE !== null) deadlineMs = DEADLINE_OVERRIDE;
    // 子进程里所有「协调 / 防卡死」类的截止都由父进程传入并随 --time-scale 放大：capMs = 持有 / 等信号的安全上限（调用处可显式覆盖，覆盖值不再放大），
    //   timeoutMs = 子进程里每次锁调用的等待预算（调用处写未放大的数，这里统一乘系数）。验证超时语义的明确小预算（600ms 等）在父进程里直接传给锁调用，不经这里。
    const spec = Object.assign({}, specIn, { capMs: specIn.capMs !== undefined ? specIn.capMs : sc(60000) });
    if (spec.timeoutMs !== undefined) spec.timeoutMs = sc(spec.timeoutMs);
    const args = [__filename, '--worker', Buffer.from(JSON.stringify(spec), 'utf8').toString('base64')];
    if (MODULE_ARG) args.push(MODULE_ARG);
    const w = { done: false, closed: false, timedOut: false, spawnError: null, pid: null, child: null };
    w.closedP = new Promise((res) => { w.markClosed = () => { w.closed = true; liveWorkers.delete(w); res(); }; });
    let stdout = '';
    let stderr = '';
    w.exited = new Promise((resolve) => {
        let timer = null;
        let settled = false;
        const finish = (code, signal, closed) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            w.done = true;
            if (w.timedOut) timedOutWorkers++;
            const lines = stdout.split('\n').filter((l) => l.startsWith('RESULT:'));
            let result = null;
            let parseError = null;
            if (lines.length) { try { result = JSON.parse(lines[lines.length - 1].slice('RESULT:'.length)); } catch (e) { parseError = e.message; } }
            resolve({ code, signal, result, parseError, stdout, stderr, timedOut: w.timedOut, spawnError: w.spawnError && w.spawnError.message, closed });
        };
        let child;
        try {
            child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: process.env });
        } catch (e) {
            w.spawnError = e;
            finish(null, null, false);
            w.markClosed();   // 确认从未启动
            return;
        }
        w.child = child;
        w.pid = child.pid;
        liveWorkers.add(w);
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', (e) => { w.spawnError = e; if (child.pid === undefined) { finish(null, null, false); w.markClosed(); } });
        child.on('close', (code, signal) => { w.markClosed(); finish(code, signal, true); });
        timer = setTimeout(() => {
            w.timedOut = true;
            try { killHard(child.pid); } catch (_) { /* 已经退出 */ }
            timer = setTimeout(() => finish(null, null, false), 10000);   // 强杀后再等 10 秒的 close；仍无 close 就放弃等待（结果已结算），但留在存活集合里，不当作已回收
        }, deadlineMs);
    });
    w.kill = () => { try { killHard(w.pid); } catch (_) { /* 已经退出 */ } };
    return w;
}
/** finally 里先回收所有存活子进程；返回仍未 close 的 PID 清单（空数组 = 全部回收）。 */
async function reapAll() {
    const ws = [...liveWorkers].filter((w) => !w.closed);
    for (const w of ws) w.kill();
    await Promise.race([Promise.all(ws.map((w) => w.closedP)), sleepAsync(sc(15000))]);
    return [...liveWorkers].filter((w) => !w.closed).map((w) => w.pid);
}
const exitedOk = (x) => !!x && x.code === 0 && !x.timedOut && x.closed && !x.spawnError && !x.parseError && !!x.result && x.result.ok === true;
const exitInfo = (x) => jstr({ code: x && x.code, signal: x && x.signal, timedOut: x && x.timedOut, spawnError: x && x.spawnError, parseError: x && x.parseError, result: x && x.result, stderr: x && x.stderr && x.stderr.slice(0, 300) });

async function waitForFile(file, ms, w) {
    const t0 = Date.now();
    const limit = sc(ms);   // 卡死截止，乘时间系数
    while (Date.now() - t0 < limit) {
        if (fs.existsSync(file)) return true;
        if (w && w.done) return fs.existsSync(file);
        await sleepAsync(25);
    }
    return false;
}

// 逐项删除（不用 fs.rmSync；不跟随符号链接 / junction；只读文件先改权限）。返回仍存在的路径。
function delTree(dir, left) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        let st = null;
        try { st = fs.lstatSync(p); } catch (_) { continue; }
        if (st.isSymbolicLink()) {
            try { fs.unlinkSync(p); } catch (_) { try { fs.rmdirSync(p); } catch (__) { left.push(p); } }
            try { fs.lstatSync(p); left.push(p); } catch (_) { /* 已不存在 */ }
            continue;
        }
        if (st.isDirectory()) { delTree(p, left); continue; }
        try { fs.chmodSync(p, 0o666); } catch (_) { /* ignore */ }
        try { fs.unlinkSync(p); } catch (_) { /* 以下面的 lstat 为准 */ }
        try { fs.lstatSync(p); left.push(p); } catch (_) { /* 已不存在 */ }
    }
    try { fs.rmdirSync(dir); } catch (_) { /* 以 lstat 为准 */ }
    try { fs.lstatSync(dir); left.push(dir); } catch (_) { /* 已不存在 */ }
}

// 全局看门狗：任何误实现（死锁、队列卡死）都判红而不挂起。主线程被同步循环占住时帮不上（同步循环由各自的有界上限负责）
const WATCHDOG_MS = sc(900000);
function startWatchdog() {
    setTimeout(() => {
        console.log(`\n  [FAIL] 看门狗：整套验证超过 ${WATCHDOG_MS}ms 没有结束（判红，强杀全部子进程并清理）`);
        for (const w of liveWorkers) w.kill();
        const alive = [...liveWorkers].filter((w) => !w.closed).map((w) => w.pid);
        if (baseDir && alive.length === 0) { const left = []; delTree(baseDir, left); console.log(`  清理残留：${jstr(left)}`); }
        else if (baseDir) console.log(`  仍有子进程未确认退出（PID ${jstr(alive)}），不清理目录 ${baseDir}`);
        summaryPrinted = true;
        console.log(`\nverify-lines-state PASS=${pass} FAIL=${fail + 1}`);
        process.exit(1);
    }, WATCHDOG_MS).unref();
}

// ---- 手写期望：一条线的默认记录（字段全列，不引用实现里的任何常量）
const PORT_OF = { 1: 3100, 2: 3200, 3: 3300 };
const REC = (name, slot, over) => Object.assign({
    name, generation: '<GEN>', lifecycle: 'creating', failed_step: null, integration: { state: 'idle' }, yield_request: null,
    module: null, branch: null, worktree: null, slot, port: PORT_OF[slot], surface: null, deps_mode: 'shared', process: null,
    created_at: T0, updated_at: T0,
}, over || {});
const CFG = (over) => Object.assign({ integration_branch: null, integration_workspace: null, mode: 'normal' }, over || {});
const TABLE = (config, lines, history) => ({ version: 1, config, lines, history: history || [] });
const PROC = { pid: 4242, start_time: '2026-03-01T00:00:00.000Z', cmd: 'node server.js', instance: 'inst-1' };

async function main() {
    console.log(`被测模块：${STATE_MODULE}${MODULE_PATH ? '（变异副本）' : ''}`);
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sdh-s2a-'));
    baseDir = base;
    const cjk = path.join(base, '中文 目录');
    fs.mkdirSync(cjk);
    const ctl = (name) => path.join(cjk, name, '_state');
    const linesFile = (root) => path.join(root, 'lines.json');
    const bytes = (root) => fs.readFileSync(linesFile(root));
    const sameBytes = (a, b) => Buffer.compare(a, b) === 0;
    const hasCjkSpace = (p) => /[一-鿿]/.test(p) && p.includes(' ');
    const tmpLeft = (root) => (fs.existsSync(root) ? fs.readdirSync(root).filter((n) => n.startsWith('lines.json.tmp-')) : []);
    /** 一个用例 / 夹具单独 try：一处异常不遮住同节其余断言。 */
    const guarded = async (label, fn) => {
        try { await fn(); } catch (e) { bad(`${label}：用例内未预期异常`, e && e.stack); }
    };
    /** 执行 fn 期间收集进程警告（'warning' 事件经 nextTick 异步发出，所以多等一小会儿）；返回 { v: fn 的返回值, ws: ['名字:消息', …] }。 */
    const withWarnings = async (fn) => {
        const ws = [];
        const on = (w) => { ws.push(`${w.name}:${w.message}`); };
        process.on('warning', on);
        try { const v = await fn(); await sleepAsync(50); return { v, ws }; } finally { process.removeListener('warning', on); }
    };
    console.log(`临时目录：${base}`);
    try {
        // ======================= 1 控制根解析 =======================
        await sec('1 控制根解析：主工作区与 linked worktree 相同；传 controlRoot 不执行 git；junction / 小写盘符 / GIT_DIR 环境变量', async () => {
            const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
            const repo = path.join(cjk, '主 仓库');
            fs.mkdirSync(repo);
            git(repo, 'init', '-q');
            git(repo, 'commit', '--allow-empty', '-q', '-m', 'init');
            const wt = path.join(cjk, '线 工作树');
            git(repo, 'worktree', 'add', '-q', wt, '-b', 'wt-branch');
            fs.mkdirSync(path.join(repo, 'sub dir'));
            const expected = path.join(fs.realpathSync.native(repo), 'docs', 'local', '多线并行', '_state');   // 手写口径：主工作区根 + docs/local/多线并行/_state
            const fromMain = S.resolveControlRoot({ cwd: repo });
            const fromWt = S.resolveControlRoot({ cwd: wt });
            const fromSub = S.resolveControlRoot({ cwd: path.join(repo, 'sub dir') });
            must(fromMain === expected, '从主工作区解析：= <主工作区根>/docs/local/多线并行/_state', `${fromMain} vs ${expected}`);
            must(fromWt === expected && fromSub === expected && fromWt === fromMain, '从 linked worktree 与主工作区子目录解析：与主工作区结果完全相同', jstr({ fromMain, fromWt, fromSub }));
            let calls = 0;
            SET_HOOKS({ execFileSync: (...a) => { calls++; return execFileSync(...a); } });
            const explicit = S.resolveControlRoot({ cwd: repo, controlRoot: path.join(cjk, '显式 控制根') });
            const explicit2 = S.resolveControlRoot({ cwd: path.join(cjk, '根本 不存在的 目录'), controlRoot: path.join(cjk, '显式 控制根') });
            must(explicit === path.join(cjk, '显式 控制根') && explicit2 === explicit && calls === 0, '传了 controlRoot：直接用，没有执行 git（调用计数 0）；cwd 即使是不存在的目录也不碰', jstr({ explicit, explicit2, calls }));
            const seen = [];
            SET_HOOKS({ execFileSync: (file, args, o) => { seen.push({ file, args, cwd: o.cwd, shell: o.shell }); return execFileSync(file, args, o); } });
            S.resolveControlRoot({ cwd: repo });
            must(seen.length === 1 && seen[0].file === 'git' && jstr(seen[0].args) === jstr(['rev-parse', '--git-common-dir']) && seen[0].cwd === repo && !seen[0].shell, '未传 controlRoot：恰好执行一次 git rev-parse --git-common-dir（execFile 形态，不经 shell，cwd 为传入的 cwd）', jstr(seen));
            resetHooks();
            const nonGit = path.join(cjk, '非 仓库');
            fs.mkdirSync(nonGit);
            const eNg = await errOf(() => S.resolveControlRoot({ cwd: nonGit }));
            must(eNg && eNg.code === 'STATE_NO_GIT', '不在 git 仓库里：STATE_NO_GIT', jstr(eNg && { c: eNg.code, m: eNg.message }));
            const eBad = await errOf(() => S.resolveControlRoot({}));
            must(eBad && eBad.code === 'STATE_BAD_ARGS', '既无 cwd 也无 controlRoot：STATE_BAD_ARGS');
            // junction cwd：路径里带 junction，必须解析回真实主工作区（realpath）
            const junc = path.join(cjk, '主仓库 junction');
            fs.symlinkSync(repo, junc, 'junction');
            const viaJunction = S.resolveControlRoot({ cwd: junc });
            must(viaJunction === expected, '经 junction 的 cwd：解析结果仍是真实主工作区下的控制根（去掉 realpath 会判红）', `${viaJunction} vs ${expected}`);
            if (process.platform === 'win32') {
                const lower = repo.replace(/^[A-Z]:/, (m) => m.toLowerCase());
                const viaLower = S.resolveControlRoot({ cwd: lower });
                must(lower !== repo && viaLower === expected, '小写盘符的 cwd：解析结果与大写盘符完全相同（去掉 realpath 会判红）', `${lower} -> ${viaLower} vs ${expected}`);
            }
            // 环境变量里的 GIT_DIR 等指向另一个仓库：解析结果不变，且传给 git 的 env 不含这些变量
            const other = path.join(cjk, '别的 仓库');
            fs.mkdirSync(other);
            git(other, 'init', '-q');
            const saved = {};
            const names = ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'];
            for (const k of names) saved[k] = process.env[k];
            const envSeen = [];
            try {
                process.env.GIT_DIR = path.join(other, '.git');
                process.env.GIT_COMMON_DIR = path.join(other, '.git');
                process.env.GIT_WORK_TREE = other;
                process.env.GIT_INDEX_FILE = path.join(other, '.git', 'index');
                SET_HOOKS({ execFileSync: (file, args, o) => { envSeen.push(Object.keys(o.env || {}).filter((k) => names.includes(k.toUpperCase()))); return execFileSync(file, args, o); } });
                const withEnv = S.resolveControlRoot({ cwd: wt });
                must(withEnv === expected && envSeen.length === 1 && envSeen[0].length === 0, '环境里 GIT_DIR / GIT_COMMON_DIR / GIT_WORK_TREE / GIT_INDEX_FILE 指向另一仓库：解析结果不变，传给 git 的 env 已去掉这四个变量', jstr({ withEnv, envSeen }));
            } finally {
                for (const k of names) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
                resetHooks();
            }
        });

        // ======================= 2 并发不丢 =======================
        await sec('2 并发不丢（方案验收第 1 条）：多进程读改写互斥；固定时钟，整表手写期望全等', async () => {
            const root = ctl('conc');
            must(hasCjkSpace(root), '前提：控制根含「中文 + 空格」路径', root);
            await S.updateConfig(root, (c) => { c.integration_branch = 'integ/main'; c.integration_workspace = 'E:/ws 工作区'; c.mode = 'drill'; }, at(T0));
            await S.createLine(root, 'alpha', { module: 'mod-a', branch: 'feat/a', worktree: 'E:/sdh-lines/alpha', surface: ['s1', 's2'], deps_mode: 'independent' }, at(T0));
            await S.createLine(root, 'beta', { module: '100', branch: 'feat/b', surface: 'sb' }, at(T0));
            await S.createLine(root, 'gamma', { module: 'g-mod', worktree: 'E:/sdh-lines/gamma' }, at(T0));
            const cfgExpect = CFG({ integration_branch: 'integ/main', integration_workspace: 'E:/ws 工作区', mode: 'drill' });
            const alpha0 = { module: 'mod-a', branch: 'feat/a', worktree: 'E:/sdh-lines/alpha', surface: ['s1', 's2'], deps_mode: 'independent' };
            const beta0 = { module: '100', branch: 'feat/b', surface: 'sb' };
            const gamma0 = { module: 'g-mod', worktree: 'E:/sdh-lines/gamma' };
            must(eq(await S.readState(root), TABLE(cfgExpect, { alpha: REC('alpha', 1, alpha0), beta: REC('beta', 2, beta0), gamma: REC('gamma', 3, gamma0) })), '前提：预置的非默认 config 与线路字段与手写整表全等');
            const t0 = Date.now();
            // 完整工作量 = 200 次落盘循环（空闲机器约 1.5 秒）；截止时间取 5 分钟（乘时间系数）：只作卡死截止，远大于单次取锁预算之和的合理上界
            const wa = startWorker({ role: 'incr', controlRoot: root, name: 'alpha', kind: 'yield', count: 200, timeoutMs: 120000, now: T1 }, sc(300000));
            const wb = startWorker({ role: 'incr', controlRoot: root, name: 'beta', kind: 'module', count: 200, timeoutMs: 120000, now: T1 }, sc(300000));
            const [ra, rb] = await Promise.all([wa.exited, wb.exited]);
            must(exitedOk(ra) && exitedOk(rb), '两个子进程都正常结束（未超时、close 后拿到有效结果）', jstr({ a: exitInfo(ra), b: exitInfo(rb) }));
            const st = await S.readState(root);
            must(eq(st, TABLE(cfgExpect, {
                alpha: REC('alpha', 1, Object.assign({}, alpha0, { yield_request: { n: 200 }, updated_at: T1 })),
                beta: REC('beta', 2, Object.assign({}, beta0, { module: '300', updated_at: T1 })),
                gamma: REC('gamma', 3, gamma0),
            })), '两进程分别对不同线路的不同字段各更新 200 次：整表与手写期望全等（alpha.yield_request.n = 200，beta.module = "300"，其余字段与无关线路不变）', canon(st));
            console.log(`  （两进程各 200 次，用时 ${Date.now() - t0}ms）`);
            const t1 = Date.now();
            const ws = [1, 2, 3, 4].map(() => startWorker({ role: 'incr', controlRoot: root, name: 'gamma', kind: 'yield', count: 100, timeoutMs: 120000, now: T1 }, sc(300000)));
            const rs = await Promise.all(ws.map((w) => w.exited));
            must(rs.every(exitedOk), '四个子进程都正常结束', jstr(rs.map(exitInfo)));
            const st2 = await S.readState(root);
            must(eq(st2, TABLE(cfgExpect, {
                alpha: REC('alpha', 1, Object.assign({}, alpha0, { yield_request: { n: 200 }, updated_at: T1 })),
                beta: REC('beta', 2, Object.assign({}, beta0, { module: '300', updated_at: T1 })),
                gamma: REC('gamma', 3, Object.assign({}, gamma0, { yield_request: { n: 400 }, updated_at: T1 })),
            })), '四个子进程对同一线同一计数字段各加 100 次：gamma.yield_request.n = 400（读改写互斥），第一轮结果仍在，整表全等', canon(st2));
            must(tmpLeft(root).length === 0, '控制根里没有残留的临时文件', jstr(tmpLeft(root)));
            console.log(`  （四进程各 100 次，用时 ${Date.now() - t1}ms）`);
        });

        // ======================= 3 持有者死亡自动释放 =======================
        await sec('3 持有者被强杀：锁由操作系统释放，另一进程在等待上限内取到锁并写入，登记表没有半写入', async () => {
            const root = ctl('kill');
            must(hasCjkSpace(root), '前提：控制根含「中文 + 空格」路径', root);
            await S.updateConfig(root, (c) => { c.integration_branch = 'before-kill'; }, at(T0));
            await S.createLine(root, 'keeper', { module: 'k', branch: 'feat/k', surface: ['a'] }, at(T0));
            const before = bytes(root);
            const marker = path.join(root, 'held.marker');
            const holder = startWorker({ role: 'hold-config', controlRoot: root, marker, forever: true, value: 'HALF-WRITTEN', timeoutMs: 20000 });
            const held = await waitForFile(marker, 30000, holder);
            must(held, '子进程取到锁并在持锁期间挂住（标记文件已写出）');
            let killErr = null;
            try { killHard(holder.pid); } catch (e) { killErr = e; }
            const hx = await holder.exited;
            must(!killErr && hx.result === null && !hx.timedOut && hx.closed, '子进程被强杀（taskkill /F /PID），没有正常收尾', jstr({ killErr: killErr && killErr.message, hx: exitInfo(hx) }));
            must(sameBytes(bytes(root), before), '强杀之后、新写入之前：登记表字节与强杀前最后一次成功写入的结果逐字节相同（持有者改到一半的 HALF-WRITTEN 没落盘）');
            const waiter = startWorker({ role: 'set-config', controlRoot: root, key: 'integration_workspace', value: 'after-kill', timeoutMs: 20000, now: T1 });
            const wx = await waiter.exited;
            must(exitedOk(wx), '另一进程在等待上限（20 秒预算）内取到锁并写入成功（成功本身即证明锁已释放；不再断言耗时）', exitInfo(wx));
            const st = await S.readState(root);
            must(eq(st, TABLE(CFG({ integration_branch: 'before-kill', integration_workspace: 'after-kill' }), { keeper: REC('keeper', 1, { module: 'k', branch: 'feat/k', surface: ['a'] }) })),
                '最终登记表整表 = 强杀前的内容 + 新写入（没有 HALF-WRITTEN；keeper 线原样）', canon(st));
            must(tmpLeft(root).length === 0, '没有残留临时文件', jstr(tmpLeft(root)));

            // 临时文件已写完、rename 之前被强杀：登记表字节不变；留下的临时文件由下一次持锁写入清掉
            const root2 = ctl('kill-tmp');
            await S.updateConfig(root2, (c) => { c.integration_branch = 'stable'; }, at(T0));
            const stable = bytes(root2);
            const marker2 = path.join(root2, 'at-rename.marker');
            const release2 = path.join(root2, 'never.signal');
            const inflight = startWorker({ role: 'hang-rename', controlRoot: root2, marker: marker2, release: release2, key: 'integration_workspace', value: 'in-flight', timeoutMs: 20000, now: T1 });
            must(await waitForFile(marker2, 30000, inflight), 'rename 之前挂住的子进程已把临时文件写完（标记文件已写出）');
            const tmps = tmpLeft(root2);
            let tmpBody = null;
            try { tmpBody = tmps.length === 1 ? JSON.parse(fs.readFileSync(path.join(root2, tmps[0]), 'utf8')) : null; } catch (_) { /* 下面断言 */ }
            must(tmps.length === 1 && tmpBody && tmpBody.config.integration_workspace === 'in-flight' && sameBytes(bytes(root2), stable), 'rename 前：临时文件已存在且内容完整，但登记表字节仍是旧内容', jstr({ tmps }));
            // 锁必须覆盖到原子替换完成：子进程还挂在 rename 钩子里时，父进程取锁必须超时（「先释放锁再写盘」的实现在这里每次判红）
            const eHeld = await errOf(() => S.updateConfig(root2, (c) => { c.mode = 'drill'; }, { lockTimeoutMs: 600 }));
            must(eHeld && eHeld.code === 'STATE_LOCK_TIMEOUT' && sameBytes(bytes(root2), stable), '子进程挂在 rename 钩子期间（临时文件已写、尚未替换）：父进程 updateConfig（上限 600ms）必须报 STATE_LOCK_TIMEOUT，登记表字节不变（锁覆盖到原子替换完成）', jstr(eHeld && { c: eHeld.code, m: eHeld.message }));
            inflight.kill();
            const ix = await inflight.exited;
            must(!ix.timedOut && ix.closed && ix.result === null, 'rename 前强杀子进程：没有正常收尾', exitInfo(ix));
            must(sameBytes(bytes(root2), stable) && tmpLeft(root2).length === 1, '强杀之后：登记表字节仍是旧内容（in-flight 没落盘），临时文件残留一个');
            const waiter2 = startWorker({ role: 'set-config', controlRoot: root2, key: 'mode', value: 'drill', timeoutMs: 20000, now: T2 });
            const w2x = await waiter2.exited;
            const st2 = await S.readState(root2);
            must(exitedOk(w2x) && eq(st2, TABLE(CFG({ integration_branch: 'stable', mode: 'drill' }), {})) && tmpLeft(root2).length === 0, '下一次写入取到锁成功：结果 = 旧内容 + 新写入（没有 in-flight），崩溃遗留的临时文件已被清掉', jstr({ w2x: exitInfo(w2x), st2: canon(st2), tmp: tmpLeft(root2) }));
        });

        // ======================= 4 活着的持有者不被接管 =======================
        await sec('4 活着的持有者：持锁时间超过等待上限 → 等待方以 STATE_LOCK_TIMEOUT 退出，登记表未被等待方改动；读也在锁内', async () => {
            const root = ctl('alive');
            await S.updateConfig(root, (c) => { c.integration_branch = 'base'; }, at(T0));
            const before = bytes(root);
            const marker = path.join(root, 'held.marker');
            const release = path.join(root, 'release.signal');
            const holder = startWorker({ role: 'hold-config', controlRoot: root, marker, release, value: 'holder-wrote', timeoutMs: 20000, now: T1 });
            must(await waitForFile(marker, 30000, holder), '持有者取到锁（标记文件已写出），并等待父进程的释放信号');
            const t0 = Date.now();
            const e = await errOf(() => S.updateConfig(root, (c) => { c.mode = 'drill'; }, { lockTimeoutMs: 600 }));
            const waited = Date.now() - t0;
            must(e && e.code === 'STATE_LOCK_TIMEOUT', '等待方超时后抛 STATE_LOCK_TIMEOUT', jstr(e && { c: e.code, m: e.message }));
            must(waited >= 420 && waited < sc(60000), '等待方至少等了上限的大部分（下界 ≥ 70%）才退出，且没有无限等待（宽松卡死上界 60 秒 × 时间系数）；没有被放行', `waited=${waited}ms`);
            const tr = Date.now();
            const eRead = await errOf(() => S.readState(root, { lockTimeoutMs: 600 }));
            const readWaited = Date.now() - tr;
            must(eRead && eRead.code === 'STATE_LOCK_TIMEOUT' && readWaited >= 420, 'readState 在锁内读：持有者持锁时读同样等待并以 STATE_LOCK_TIMEOUT 退出（不是无锁读到旧内容）', jstr({ code: eRead && eRead.code, readWaited }));
            must(sameBytes(bytes(root), before), '持有者仍持锁（释放信号还没发）：登记表字节没有被改动');
            fs.writeFileSync(release, 'go');
            const hx = await holder.exited;
            must(exitedOk(hx), '释放信号发出后持有者正常完成（没有被等待方接管或打断）', exitInfo(hx));
            const st = await S.readState(root);
            must(eq(st, TABLE(CFG({ integration_branch: 'holder-wrote' }), {})), '最终只有持有者的写入，等待方的 mode = drill 没有落盘', canon(st));
        });

        // ======================= 5 补丁函数返回 Promise / 抛错 =======================
        await sec('5 补丁函数：返回 Promise 抛错放弃写入；自己抛错原样抛出、锁已释放', async () => {
            const root = ctl('patch');
            await S.createLine(root, 'alpha');
            const before = bytes(root);
            const e1 = await errOf(() => S.updateLine(root, 'alpha', async (r) => { r.module = 'x'; }));
            must(e1 && e1.code === 'STATE_PATCH_ASYNC' && sameBytes(bytes(root), before), '补丁是 async 函数：STATE_PATCH_ASYNC，登记表字节未变', jstr(e1 && e1.code));
            const e2 = await errOf(() => S.updateLine(root, 'alpha', (r) => { r.module = 'x'; return Promise.resolve(r); }));
            must(e2 && e2.code === 'STATE_PATCH_ASYNC' && sameBytes(bytes(root), before), '补丁返回 Promise：STATE_PATCH_ASYNC，登记表字节未变');
            let patchThenCalls = 0;
            const e3 = await errOf(() => S.updateConfig(root, (c) => ({ then() { patchThenCalls++; } })));
            await sleepAsync(10);
            await new Promise((r) => setImmediate(r));
            await new Promise((r) => setImmediate(r));
            must(e3 && e3.code === 'STATE_PATCH_ASYNC' && sameBytes(bytes(root), before), '补丁返回 thenable：STATE_PATCH_ASYNC，登记表字节未变');
            must(patchThenCalls === 0, '补丁返回带调用计数的 thenable：若干个事件循环轮次之后 then 仍从未被调用（普通 thenable 不被吸收 / 调用）', `then 被调用 ${patchThenCalls} 次`);
            const boom = new Error('boom');
            const e4 = await errOf(() => S.updateLine(root, 'alpha', (r) => { r.module = 'half'; throw boom; }));
            must(e4 === boom && sameBytes(bytes(root), before), '补丁先改拷贝后抛错：原错误原样抛出，登记表字节未变', jstr(e4 && e4.message));
            const okRec = await S.updateLine(root, 'alpha', (r) => { r.module = 'after'; }, { lockTimeoutMs: sc(20000) });
            must(okRec.module === 'after', '抛错之后锁已释放：下一次写在宽松预算（20 秒 × 时间系数）内成功（锁没释放会以 STATE_LOCK_TIMEOUT 失败；不再断言耗时）');
            let seenKeys = null;
            await S.updateLine(root, 'alpha', (r) => { seenKeys = Object.keys(r).sort(); });
            must(jstr(seenKeys) === jstr(['branch', 'created_at', 'deps_mode', 'failed_step', 'generation', 'integration', 'lifecycle', 'module', 'name', 'port', 'process', 'slot', 'surface', 'updated_at', 'worktree', 'yield_request']),
                '补丁函数拿到的只是该线记录的字段（拿不到 lines / history / config / 其他线）', jstr(seenKeys));
            const b1 = bytes(root);
            const eImm = await errOf(() => S.updateLine(root, 'alpha', (r) => { r.slot = 2; r.port = 3200; }));
            must(eImm && eImm.code === 'STATE_FIELD_IMMUTABLE' && sameBytes(bytes(root), b1), '补丁改 slot / port：STATE_FIELD_IMMUTABLE，字节未变', jstr(eImm && eImm.code));
            const eBadVal = await errOf(() => S.updateLine(root, 'alpha', (r) => { r.module = 5; }));
            const eUnknown = await errOf(() => S.updateLine(root, 'alpha', (r) => { r.lifecyle = 'ready'; }));
            const eMissing = await errOf(() => S.updateLine(root, 'nope', (r) => { r.module = 'x'; }));
            must(eBadVal && eBadVal.code === 'STATE_INVALID_PATCH' && eUnknown && eUnknown.code === 'STATE_INVALID_PATCH' && eMissing && eMissing.code === 'STATE_NO_SUCH_LINE' && sameBytes(bytes(root), b1),
                '补丁写出非法取值 / 未知字段：STATE_INVALID_PATCH；线不存在：STATE_NO_SUCH_LINE；字节均未变', jstr([eBadVal && eBadVal.code, eUnknown && eUnknown.code, eMissing && eMissing.code]));
            // integration 取值合法性
            const igOk = [];
            for (const ig of [{ state: 'verifying' }, { state: 'verified', B: 'b1', H: 'h1' }, { state: 'conflict', reason: 'x' }, { state: 'merging' }, { state: 'merged' }, { state: 'idle' }]) {
                igOk.push(!(await errOf(() => S.updateLine(root, 'alpha', (r) => { r.integration = ig; }))));
            }
            const igBad = [];
            for (const ig of [{ state: 'bogus' }, { state: 'verified' }, { state: 'verified', B: 'b' }, { state: 'conflict' }, 'idle', null]) {
                const e = await errOf(() => S.updateLine(root, 'alpha', (r) => { r.integration = ig; }));
                igBad.push(!!e && e.code === 'STATE_INVALID_PATCH');
            }
            must(igOk.every(Boolean) && igBad.every(Boolean), 'integration：六个合法取值（verified 附 B、H，conflict 附原因）全部接受；六种非法形态全部以 STATE_INVALID_PATCH 拒绝', jstr({ igOk, igBad }));
        });

        // ======================= 6 登记表损坏 =======================
        await sec('6 登记表损坏：读与写都报错，文件内容原样保留（逐字节）；记录级损坏夹具、版本、BOM、读失败', async () => {
            const goodConfig = '"config":{"integration_branch":null,"integration_workspace":null,"mode":"normal"}';
            const variants = [
                ['不是 JSON', '{not json', 'STATE_CORRUPT'],
                ['空文件', '', 'STATE_CORRUPT'],
                ['JSON 但不是对象', '[1,2,3]', 'STATE_CORRUPT'],
                ['版本号高于本代码（2）', `{"version":2,${goodConfig},"lines":{},"history":[]}`, 'STATE_VERSION_NEWER'],
                ['版本号高于本代码（99）', `{"version":99,${goodConfig},"lines":{},"history":[]}`, 'STATE_VERSION_NEWER'],
                ['版本号低于本代码（0）', `{"version":0,${goodConfig},"lines":{},"history":[]}`, 'STATE_VERSION_OLDER'],
                ['版本号低于本代码（-3）', `{"version":-3,${goodConfig},"lines":{},"history":[]}`, 'STATE_VERSION_OLDER'],
                ['版本号是字符串', `{"version":"1",${goodConfig},"lines":{},"history":[]}`, 'STATE_CORRUPT'],
                ['版本号是 null', `{"version":null,${goodConfig},"lines":{},"history":[]}`, 'STATE_CORRUPT'],
                ['版本号是小数', `{"version":1.5,${goodConfig},"lines":{},"history":[]}`, 'STATE_CORRUPT'],
                ['缺版本号', `{${goodConfig},"lines":{},"history":[]}`, 'STATE_CORRUPT'],
                ['线记录不是对象', `{"version":1,${goodConfig},"lines":{"x":1},"history":[]}`, 'STATE_CORRUPT'],
                ['config.mode 取值非法', '{"version":1,"config":{"integration_branch":null,"integration_workspace":null,"mode":"weird"},"lines":{},"history":[]}', 'STATE_CORRUPT'],
                ['缺 history', `{"version":1,${goodConfig},"lines":{}}`, 'STATE_CORRUPT'],
                ['两个 BOM', `﻿﻿{"version":1,${goodConfig},"lines":{},"history":[]}`, 'STATE_CORRUPT'],
            ];
            const allFail = async (root, nameOfExisting, code) => {
                const eR = await errOf(() => S.readState(root));
                const eW = await errOf(() => S.updateConfig(root, (c) => { c.mode = 'drill'; }));
                const eC = await errOf(() => S.createLine(root, 'zzz'));
                const eL = await errOf(() => S.updateLine(root, nameOfExisting, (r) => { r.module = 'x'; }));
                return { es: [eR, eW, eC, eL], all: [eR, eW, eC, eL].every((e) => e && e.code === code) };
            };
            for (let i = 0; i < variants.length; i++) {
                const [label, text, code] = variants[i];
                await guarded(`损坏（${label}）`, async () => {
                    const root = ctl(`corrupt-${i}`);
                    fs.mkdirSync(root, { recursive: true });
                    fs.writeFileSync(linesFile(root), text);
                    const orig = bytes(root);
                    const r = await allFail(root, 'alpha', code);
                    must(r.all && sameBytes(bytes(root), orig), `损坏（${label}）：readState / updateConfig / createLine / updateLine 都抛 ${code}，文件逐字节未变`, jstr(r.es.map((e) => e && e.code)));
                });
            }
            await guarded('版本号高于本代码的消息', async () => {
                const rNew = ctl('corrupt-3');
                const eNew = await errOf(() => S.readState(rNew));
                must(eNew && /主工作区/.test(eNew.message), '版本号高于本代码：消息提示用主工作区的线路工具', jstr(eNew && eNew.message));
            });
            await guarded('文件不存在视为空表', async () => {
                const missingRoot = ctl('never-written');
                const stEmpty = await S.readState(missingRoot);
                must(stEmpty.version === 1 && jstr(stEmpty.lines) === '{}' && jstr(stEmpty.history) === '[]' && !fs.existsSync(missingRoot), '文件不存在：视为空表（首次使用），读取不为读而创建目录', jstr(stEmpty));
            });

            // BOM：开头一个 BOM 的合法登记表可读可写，写回后不带 BOM
            await guarded('带 BOM 的登记表', async () => {
            const bomRoot = ctl('bom-ok');
            fs.mkdirSync(bomRoot, { recursive: true });
            fs.writeFileSync(linesFile(bomRoot), `﻿{"version":1,${goodConfig},"lines":{},"history":[]}`);
            const bomRead = await S.readState(bomRoot);
            await S.updateConfig(bomRoot, (c) => { c.integration_branch = 'bom-written'; }, at(T1));
            const afterBom = bytes(bomRoot);
            must(bomRead.version === 1 && !(afterBom[0] === 0xEF && afterBom[1] === 0xBB && afterBom[2] === 0xBF) && afterBom[0] === 0x7B && eq((await S.readState(bomRoot)).config, CFG({ integration_branch: 'bom-written' })),
                '带 BOM 的合法登记表：可读可写，写回后文件开头是 { 而不是 BOM', jstr([...afterBom.slice(0, 4)]));
            });

            // 读失败（lines.json 是目录）：STATE_READ_FAILED，与 STATE_CORRUPT 区分
            await guarded('读失败（lines.json 是目录）', async () => {
            const rfRoot = ctl('read-failed');
            fs.mkdirSync(linesFile(rfRoot), { recursive: true });
            const eRf1 = await errOf(() => S.readState(rfRoot));
            const eRf2 = await errOf(() => S.updateConfig(rfRoot, (c) => { c.mode = 'drill'; }));
            const eRf3 = await errOf(() => S.createLine(rfRoot, 'alpha'));
            must([eRf1, eRf2, eRf3].every((e) => e && e.code === 'STATE_READ_FAILED') && fs.lstatSync(linesFile(rfRoot)).isDirectory(), '非 ENOENT 的读错误（lines.json 是目录）：readState / updateConfig / createLine 都报 STATE_READ_FAILED（不是 STATE_CORRUPT），目录原样', jstr([eRf1, eRf2, eRf3].map((e) => e && e.code)));
            });

            // ---- 记录级损坏夹具：从合法登记表（a ready / c failed / history b）分别构造单点损坏
            const goodRoot = ctl('fixture-good');
            await S.createLine(goodRoot, 'a', { module: 'ma' }, at(T0));
            await S.createLine(goodRoot, 'b', {}, at(T0));
            await S.createLine(goodRoot, 'c', {}, at(T0));
            await S.updateLine(goodRoot, 'a', (r) => { r.lifecycle = 'ready'; }, at(T1));
            await S.updateLine(goodRoot, 'b', (r) => { r.lifecycle = 'ready'; }, at(T1));
            await S.updateLine(goodRoot, 'b', (r) => { r.lifecycle = 'removing'; }, at(T2));
            await S.removeLineRecord(goodRoot, 'b', at(T3));
            await S.updateLine(goodRoot, 'c', (r) => { r.lifecycle = 'failed'; r.failed_step = 'worktree'; }, at(T4));
            const goodText = fs.readFileSync(linesFile(goodRoot), 'utf8');
            const gp = JSON.parse(goodText);
            must(gp.lines.a.lifecycle === 'ready' && gp.history.length === 1 && gp.lines.c.lifecycle === 'failed' && !(await errOf(() => S.readState(goodRoot))), '前提：夹具基准登记表合法（a ready、c failed、history 里有 b），readState 成功');
            const mutations = [
                ['缺必填字段（a.module）', (s) => { delete s.lines.a.module; }],
                ['未知字段（a.extra）', (s) => { s.lines.a.extra = 1; }],
                ['槽位与端口不匹配（a.slot=1,port=3200）', (s) => { s.lines.a.port = 3200; }],
                ['两线同槽（c.slot=1,port=3100 与 a 同槽）', (s) => { s.lines.c.slot = 1; s.lines.c.port = 3100; }],
                // 复制出来的记录必须换新 generation：否则整条复制连代次也复制了，会被「代次整表唯一」校验先判 STATE_CORRUPT，遮住真正要测的「大小写重名」校验（变异 nocasedupval 会存活）
                ['大小写重名（A 与 a 并存，A 用新代次）', (s) => { s.lines.A = Object.assign({}, s.lines.a, { name: 'A', slot: 2, port: 3200, generation: '11111111-1111-4111-8111-111111111111' }); }],
                ['大小写重名（Foo 与 foo 并存，各用新代次）', (s) => { const a = s.lines.a; delete s.lines.a; s.lines.Foo = Object.assign({}, a, { name: 'Foo', generation: '22222222-2222-4222-8222-222222222222' }); s.lines.foo = Object.assign({}, a, { name: 'foo', slot: 2, port: 3200, generation: '33333333-3333-4333-8333-333333333333' }); }],
                ['failed_step 与 lifecycle 不匹配（ready 却带 failed_step）', (s) => { s.lines.a.failed_step = 'x'; }],
                ['failed_step 与 lifecycle 不匹配（failed 却 failed_step=null）', (s) => { s.lines.c.failed_step = null; }],
                ['lines 里出现 removed 记录', (s) => { s.lines.a.lifecycle = 'removed'; }],
                ['非法 history（lifecycle 不是 removed）', (s) => { s.history[0].lifecycle = 'ready'; }],
                ['非法 history（缺 removed_at）', (s) => { delete s.history[0].removed_at; }],
                ['非法 history（未知字段）', (s) => { s.history[0].extra = true; }],
                ['非法 history（槽位 7）', (s) => { s.history[0].slot = 7; }],
                ['非法 history（元素不是对象）', (s) => { s.history[0] = 'x'; }],
                ['integration 为 verified 却缺 B/H', (s) => { s.lines.a.integration = { state: 'verified' }; }],
                ['name 与键名不一致', (s) => { s.lines.a.name = 'zz'; }],
                ['removing 的线登记着 process', (s) => { s.lines.a.lifecycle = 'removing'; s.lines.a.process = { pid: 4242, start_time: 't', cmd: 'node', instance: 'i' }; }],
                ['history 里的 removed 记录带着 process', (s) => { s.history[0].process = { pid: 4242, start_time: 't', cmd: 'node', instance: 'i' }; }],
                ['generation 缺失', (s) => { delete s.lines.a.generation; }],
                ['generation 不是 UUID', (s) => { s.lines.a.generation = 'not-a-uuid'; }],
                ['generation 与 history 里的记录重复', (s) => { s.lines.a.generation = s.history[0].generation; }],
                ['两条线共用同一 generation', (s) => { s.lines.c.generation = s.lines.a.generation; }],
                ['顶层未知字段', (s) => { s.extra = 1; }],
            ];
            for (let i = 0; i < mutations.length; i++) {
                const [label, mut] = mutations[i];
                await guarded(`记录级损坏（${label}）`, async () => {
                    const s = JSON.parse(goodText);
                    mut(s);
                    const root = ctl(`fixture-${i}`);
                    fs.mkdirSync(root, { recursive: true });
                    fs.writeFileSync(linesFile(root), JSON.stringify(s, null, 2));
                    const orig = bytes(root);
                    const r = await allFail(root, mutations[i][0].startsWith('大小写重名（Foo') ? 'Foo' : 'a', 'STATE_CORRUPT');
                    must(r.all && sameBytes(bytes(root), orig), `记录级损坏（${label}）：读与三种写都抛 STATE_CORRUPT，文件逐字节未变`, jstr(r.es.map((e) => e && e.code)));
                });
            }
            // 两个「大小写重名」夹具只能因为重名校验被拒：整表校验的问题清单恰好一条且是重名（防止被别的校验先拦、遮住重名校验）
            await guarded('大小写重名夹具只因重名被拒', async () => {
                for (const [label, mut] of mutations.filter(([l]) => l.startsWith('大小写重名'))) {
                    const s = JSON.parse(goodText);
                    mut(s);
                    const ps = S.validateState(s);
                    must(ps.length === 1 && /重名（不分大小写）/.test(ps[0]), `夹具「${label}」的整表校验问题清单恰好一条且是「重名（不分大小写）」（没有被代次重复 / 槽位 / 端口等其他校验先拦）`, jstr(ps));
                }
            });
        });

        // ======================= 7 线名 =======================
        await sec('7 线名规则（手写表）与不分大小写的重名', async () => {
            const valid = ['a', 'A', '1', 'alpha', 'Alpha-Beta-9', 'line-1', 'a-b', '0abc', 'testx', 'contest', 'com10', 'com0', 'lpt0', 'mainline', 'a--b', `a${'b'.repeat(30)}c`, 'a'.repeat(32)];
            const invalid = ['', ' ', 'main', 'MAIN', 'Main', 'test-x', 'Test-x', 'TEST-', 'test-', 'con', 'CON', 'Con', 'nul', 'prn', 'aux', 'com1', 'COM9', 'lpt1', 'lpt9', 'LPT9', '-a', 'a-', '-', '--', 'a_b', 'a b', 'a.b', '线路', 'abc线', 'é', 'a'.repeat(33), 'a'.repeat(64), null, undefined, 123, {}, ['a']];
            const vBad = valid.filter((n) => S.checkLineName(n) !== null);
            const iBad = invalid.filter((n) => S.checkLineName(n) === null);
            must(vBad.length === 0, `合法线名表（${valid.length} 条）全部接受`, jstr(vBad));
            must(iBad.length === 0, `非法线名表（${invalid.length} 条，含 MAIN / Test-x / con / lpt9 / 首尾连字符 / 超长 / 非 ASCII / 空串 / 非字符串）全部拒绝`, jstr(iBad));
            const root = ctl('names');
            await S.createLine(root, 'Foo');
            const before = bytes(root);
            const dups = [];
            for (const n of ['foo', 'FOO', 'fOo']) { const e = await errOf(() => S.createLine(root, n)); dups.push(e && e.code); }
            must(dups.every((c) => c === 'STATE_LINE_EXISTS') && sameBytes(bytes(root), before), '不分大小写的重名被拒（foo / FOO / fOo 对已有的 Foo）：STATE_LINE_EXISTS，字节未变', jstr(dups));
            const eBadName = await errOf(() => S.createLine(root, 'MAIN'));
            must(eBadName && eBadName.code === 'STATE_BAD_NAME' && sameBytes(bytes(root), before), 'createLine 拒绝非法线名：STATE_BAD_NAME，字节未变');
            const rec = await S.updateLine(root, 'FOO', (r) => { r.module = 'm'; });
            const st = await S.readState(root);
            must(rec.name === 'Foo' && st.lines.Foo.module === 'm' && Object.keys(st.lines).length === 1, '按不同大小写寻址同一条线（FOO → Foo），不会新增记录', jstr(Object.keys(st.lines)));

            // 补例：换行 / 回车 / 内嵌控制字符 / 设备名大小写变体（JS 正则无 m 标志时 $ 不匹配末尾换行前，这里把现状固定下来）
            const nasty = [
                'alpha\n', 'alpha\r', 'alpha\r\n', '\nalpha', '\r\nalpha', 'al\npha', 'a\u0000b', 'a\tb', 'a\u001fb', 'a\u007fb', 'alpha\u2028', 'alpha\u0085', 'alpha\u200b',
                'main\n', 'MAIN\r\n', 'Main\r', 'test-x\n', 'con\n',
                'PRN', 'prn', 'Prn', 'aux', 'AUX', 'Aux', 'Nul', 'NUL', 'nUl', 'COM9', 'com9', 'Com5', 'cOm1', 'lpt1', 'LPT1', 'Lpt9', 'lPt5', 'CON', 'cOn',
            ];
            const nastyRoot = ctl('names-nasty');
            await S.createLine(nastyRoot, 'keep');
            const nb = bytes(nastyRoot);
            const accepted = nasty.filter((n) => S.checkLineName(n) === null);
            const codes = [];
            for (const n of nasty) { const e = await errOf(() => S.createLine(nastyRoot, n)); codes.push(e && e.code); }
            must(accepted.length === 0 && codes.every((c) => c === 'STATE_BAD_NAME') && sameBytes(bytes(nastyRoot), nb),
                `补例 ${nasty.length} 条（末尾 \\n / \\r / \\r\\n、内嵌控制字符、main\\n、PRN/aux/Nul/COM9/lpt1 大小写变体）：checkLineName 全部拒绝，createLine 全部 STATE_BAD_NAME，登记表字节不变`, jstr({ accepted, bad: nasty.filter((n, i) => codes[i] !== 'STATE_BAD_NAME') }));
            const emptyRoot = ctl('names-nasty-empty');
            for (const n of nasty) await errOf(() => S.createLine(emptyRoot, n));
            must(!fs.existsSync(emptyRoot), '非法线名在空控制根上也被拒：没有创建控制根目录，没有写任何文件');
        });

        // ======================= 8 槽位与 history =======================
        await sec('8 槽位：1/2/3 ↔ 3100/3200/3300；removed 释放；failed 仍占槽；固定时钟下整表全等', async () => {
            const root = ctl('slots');
            const initA = { module: 'm1', branch: 'feat/a', surface: ['x', 'y'], deps_mode: 'independent' };
            const initB = { worktree: 'E:/sdh-lines/b', module: 'mb' };
            const a = await S.createLine(root, 'a', initA, at(T0));
            const b = await S.createLine(root, 'b', initB, at(T0));
            const c = await S.createLine(root, 'c', {}, at(T0));
            must(jstr([a.slot, a.port, b.slot, b.port, c.slot, c.port]) === jstr([1, 3100, 2, 3200, 3, 3300]), '连续建 3 条线：槽位 1/2/3，端口 3100/3200/3300', jstr([a, b, c].map((r) => [r.slot, r.port])));
            must(eq(await S.readState(root), TABLE(CFG(), { a: REC('a', 1, initA), b: REC('b', 2, initB), c: REC('c', 3) })), '建线后整表与手写期望全等（新线初值：creating / idle / yield_request、process = null / init 字段生效 / deps_mode 缺省 shared）');
            const before = bytes(root);
            const e4 = await errOf(() => S.createLine(root, 'd', {}, at(T4)));
            must(e4 && e4.code === 'STATE_NO_FREE_SLOT' && sameBytes(bytes(root), before), '第 4 条被拒：STATE_NO_FREE_SLOT，字节未变', jstr(e4 && e4.code));
            // 删除槽位 2 的线：creating → ready → removing → removed
            await S.updateLine(root, 'b', (r) => { r.lifecycle = 'ready'; }, at(T1));
            await S.updateLine(root, 'b', (r) => { r.lifecycle = 'removing'; }, at(T2));
            const e4b = await errOf(() => S.createLine(root, 'd', {}, at(T4)));
            must(e4b && e4b.code === 'STATE_NO_FREE_SLOT', 'removing 中的线仍占槽：新建仍被拒');
            const preRemove = (await S.readState(root)).lines.b;
            const removed = await S.removeLineRecord(root, 'b', at(T3));
            let st = await S.readState(root);
            const histB = REC('b', 2, Object.assign({}, initB, { lifecycle: 'removed', created_at: T0, updated_at: T3, removed_at: T3 }));
            must(eq(st, TABLE(CFG(), { a: REC('a', 1, initA), c: REC('c', 3) }, [histB])), '槽位 2 的线转 removed：记录移入 history，整表（lines 只剩 a、c；history 一条 b）与手写期望全等', canon(st));
            must(eq(st.history[0], Object.assign({}, preRemove, { lifecycle: 'removed', updated_at: T3, removed_at: T3 })) && eq(removed, st.history[0]),
                '归档时 history 记录与原记录逐字段全等，只有 lifecycle / updated_at / removed_at 三处变化；返回值 = history 记录', canon(st.history[0]));
            const d = await S.createLine(root, 'd', {}, at(T4));
            must(d.slot === 2 && d.port === 3200, '再建一条得到槽位 2（端口 3200）', jstr(d));
            // 同名重建：b 的旧记录已在 history，d 占着 2，先让 a 走完删除流程释放槽位 1 再重建 b
            await S.updateLine(root, 'a', (r) => { r.lifecycle = 'ready'; }, at(T5));
            await S.updateLine(root, 'a', (r) => { r.lifecycle = 'removing'; }, at(T6));
            await S.removeLineRecord(root, 'a', at(T7));
            const b2 = await S.createLine(root, 'b', {}, at(T8));
            st = await S.readState(root);
            const histA = REC('a', 1, Object.assign({}, initA, { lifecycle: 'removed', created_at: T0, updated_at: T7, removed_at: T7 }));
            must(b2.slot === 1 && eq(st, TABLE(CFG(), { b: REC('b', 1, { created_at: T8, updated_at: T8 }), c: REC('c', 3), d: REC('d', 2, { created_at: T4, updated_at: T4 }) }, [histB, histA])),
                '旧记录 removed 后同名线可重建，得到最小空闲槽位 1；history 保留 b、a 两条旧记录；整表与手写期望全等', canon(st));
            const eNotRemoving = await errOf(() => S.removeLineRecord(root, 'c'));
            must(eNotRemoving && eNotRemoving.code === 'STATE_BAD_TRANSITION', 'removeLineRecord 对非 removing 的线：STATE_BAD_TRANSITION（creating → removed 不合法）', jstr(eNotRemoving && eNotRemoving.code));

            const root2 = ctl('slots-failed');
            await S.createLine(root2, 'x');
            await S.createLine(root2, 'y');
            await S.createLine(root2, 'z');
            await S.updateLine(root2, 'y', (r) => { r.lifecycle = 'failed'; r.failed_step = 'worktree'; });
            const ew = await errOf(() => S.createLine(root2, 'w'));
            const stF = await S.readState(root2);
            must(ew && ew.code === 'STATE_NO_FREE_SLOT' && stF.lines.y.lifecycle === 'failed' && stF.lines.y.failed_step === 'worktree', 'failed 的线仍占槽：新建被拒，failed_step 已记录', jstr(ew && ew.code));
            await S.updateLine(root2, 'y', (r) => { r.lifecycle = 'removing'; r.failed_step = null; });
            await S.removeLineRecord(root2, 'y');
            const w = await S.createLine(root2, 'w');
            must(w.slot === 2, 'failed → removing → removed 之后槽位 2 释放，新线得到槽位 2', jstr(w.slot));
            // 最小空闲：释放槽位 1 时新线取 1，而不是顺序递增
            await S.updateLine(root2, 'x', (r) => { r.lifecycle = 'failed'; r.failed_step = 's'; });
            await S.updateLine(root2, 'x', (r) => { r.lifecycle = 'removing'; r.failed_step = null; });
            await S.removeLineRecord(root2, 'x');
            const v = await S.createLine(root2, 'v');
            must(v.slot === 1, '释放槽位 1 之后新线取最小空闲槽位 1', jstr(v.slot));
        });

        // ======================= 8b 测试端口表（H1）=======================
        await sec('8b 测试端口表（H1）：设置函数拒绝非法表；合法表下分配 / 校验读测试表；不写进登记表；不设时仍是 3100/3200/3300', async () => {
            const SET = RAW._internal.setSlotPortsForTest;
            const setOf = async (t) => errOf(async () => SET(t));
            try {
                must(typeof SET === 'function', '前提：state.js 的 _internal 导出了测试专用设置函数 setSlotPortsForTest');
                // 不设测试表：分配的是生产缺省（只验登记值，不监听任何端口）。期望值手写
                const rDef = ctl('ports-default');
                const d1 = await S.createLine(rDef, 'p1');
                const d2 = await S.createLine(rDef, 'p2');
                const d3 = await S.createLine(rDef, 'p3');
                must(jstr([d1.slot, d1.port, d2.slot, d2.port, d3.slot, d3.port]) === jstr([1, 3100, 2, 3200, 3, 3300]), '不设测试表：新线登记槽位 1/2/3 ↔ 端口 3100/3200/3300（生产缺省不变）', jstr([d1, d2, d3].map((r) => [r.slot, r.port])));
                must(jstr(Object.values(S.SLOT_PORTS)) === jstr([3100, 3200, 3300]), '导出的 SLOT_PORTS 常量仍是生产缺省 3100/3200/3300', jstr(S.SLOT_PORTS));

                // 20 条非法表（8 类；手写清单；每条都必须 STATE_BAD_ARGS）。「拒绝不改当前表」这样证明：先设一张已知合法表，逐个跑非法表、中间不还原，
                //   之后直接观测当前表仍是那张已知表（不经过任何 SET(null) 还原；若实现先赋值后校验，当前表会停在最后一条非法输入上，观测处判红）
                const GEN_OBS = '00000000-0000-4000-8000-0000000000a1';   // 手写的合法 UUID：validateState 观测用，不落盘
                const OBS = (port) => TABLE(CFG(), { obs: REC('obs', 1, { generation: GEN_OBS, port }) });
                const KNOWN = [20101, 20102, 20103];
                SET(KNOWN);
                const ILLEGAL = [
                    ['少槽（2 个）', [20001, 20002]], ['少槽（空数组）', []], ['多槽（4 个）', [20001, 20002, 20003, 20004]], ['多槽（4 个但只有 3 个不同值）', [20001, 20002, 20003, 20001]], ['不是数组（逗号串）', '20001,20002,20003'], ['不是数组（对象）', { 1: 20001, 2: 20002, 3: 20003 }],
                    ['重复（前两个相同）', [20001, 20001, 20003]], ['重复（首尾相同）', [20001, 20002, 20001]],
                    ['含 3000（槽位 1）', [3000, 20002, 20003]], ['含 3000（槽位 3）', [20001, 20002, 3000]],
                    ['含 3100', [3100, 20002, 20003]], ['含 3200（中间）', [20001, 3200, 20003]], ['含 3300（槽位 3）', [20001, 20002, 3300]],
                    ['越界（1023）', [1023, 20002, 20003]], ['越界（0）', [0, 20002, 20003]], ['越界（65536）', [20001, 65536, 20003]], ['越界（负数）', [20001, -20002, 20003]],
                    ['非整数（小数）', [20001.5, 20002, 20003]], ['非整数（数字字符串）', ['20001', 20002, 20003]], ['非整数（NaN）', [NaN, 20002, 20003]],
                ];
                const verdicts = [];
                for (const [label, t] of ILLEGAL) { const e = await setOf(t); verdicts.push([label, e && e.code]); }
                must(verdicts.length === 20 && verdicts.every(([, code]) => code === 'STATE_BAD_ARGS'), `${ILLEGAL.length} 条非法测试端口表（8 类：少槽 / 多槽 / 非数组 / 重复 / 含 3000 / 含 3100–3300 之一 / 越界 / 非整数）全部被 STATE_BAD_ARGS 拒绝`, jstr(verdicts.filter(([, code]) => code !== 'STATE_BAD_ARGS')));
                // 观测 1（落盘）：全部拒绝之后、没有任何还原，新控制根建线，端口仍按已知表 20101 / 20102 / 20103
                const rKept = ctl('ports-kept-known');
                const kept = [];
                const eKept = await errOf(async () => { for (const nm of ['k1', 'k2', 'k3']) kept.push(await S.createLine(rKept, nm)); });
                must(eKept === null && jstr(kept.map((r) => [r.slot, r.port])) === jstr([[1, 20101], [2, 20102], [3, 20103]]), '20 条非法表被拒之后（中间没有还原）当前表仍是已知表 [20101,20102,20103]：新线端口 20101 / 20102 / 20103', jstr({ err: eKept && eKept.code, kept: kept.map((r) => [r.slot, r.port]) }));
                // 观测 2（不落盘）：validateState 校验手写记录，端口 20101 通过、端口 3100 被指出「槽位 1 应为 20101」
                const psOk = S.validateState(OBS(20101));
                const psOld = S.validateState(OBS(3100));
                must(psOk.length === 0 && psOld.length === 1 && /port 与槽位不对应（槽位 1 应为 20101）/.test(psOld[0]), '同一时刻 validateState 校验手写记录：端口 20101 合法；端口 3100 恰好一条问题「槽位 1 应为 20101」（校验读的仍是已知表）', jstr({ psOk, psOld }));
                // 边界对照：1024 与 65535 合法（防把范围写成开区间）；设置成功后再观测一次，确认合法设置确实生效
                const eEdge = await setOf([1024, 65535, 20003]);
                must(eEdge === null, '边界合法：1024 与 65535 可以设置', jstr(eEdge && eEdge.code));
                const psEdge = S.validateState(OBS(1024));
                must(psEdge.length === 0, '边界表生效：槽位 1 ↔ 端口 1024 的手写记录通过 validateState', jstr(psEdge));
                // 缺省表同样：还原为缺省后再跑一遍 20 条非法表（中间不还原），当前表仍是生产缺省 3100
                SET(null);
                for (const [, t] of ILLEGAL) await setOf(t);
                const rAfterBad = ctl('ports-after-bad');
                let x1 = null;
                const eX1 = await errOf(async () => { x1 = await S.createLine(rAfterBad, 'x1'); });
                const psDef = S.validateState(OBS(3100));
                must(eX1 === null && x1.port === 3100 && psDef.length === 0, '缺省表下 20 条非法表被拒之后（没有还原）当前表仍是生产缺省：新线端口 3100，手写记录端口 3100 通过 validateState', jstr({ err: eX1 && [eX1.code, eX1.message], x1, psDef }));

                // 合法测试表：分配与校验都读它；不写进登记表
                SET([20101, 20102, 20103]);
                const rT = ctl('ports-test-table');
                const made = [];
                const eMake = await errOf(async () => { for (const nm of ['t1', 't2', 't3']) made.push(await S.createLine(rT, nm, {}, at(T0))); });
                must(eMake === null && jstr(made.map((r) => [r.slot, r.port])) === jstr([[1, 20101], [2, 20102], [3, 20103]]), '设了测试表 [20101,20102,20103]：新线登记槽位 1/2/3 ↔ 端口 20101/20102/20103', jstr({ err: eMake && eMake.code, made: made.map((r) => [r.slot, r.port]) }));
                if (eMake !== null) return;   // 分配没读测试表：后面依赖这三条线的断言没有意义
                const stT = await S.readState(rT);
                must(!(await errOf(() => S.readState(rT))) && stT.lines.t1.port === 20101, '测试表下读登记表通过校验（槽位 ↔ 端口按测试表核对）');
                // port 字段受 STATE_FIELD_IMMUTABLE 保护，不能经 updateLine 改：直接改文件字节再读，读完还原
                const origText = fs.readFileSync(linesFile(rT), 'utf8');
                const tampered = JSON.parse(origText);
                tampered.lines.t1.port = 3100;
                fs.writeFileSync(linesFile(rT), JSON.stringify(tampered, null, 2));
                const eOldPort = await errOf(() => S.readState(rT));
                fs.writeFileSync(linesFile(rT), origText);
                must(eOldPort && eOldPort.code === 'STATE_CORRUPT', '测试表下把 t1.port 改成生产缺省 3100（直接改文件）：读时校验拒绝（STATE_CORRUPT），校验读的是测试表', jstr(eOldPort && eOldPort.code));
                must(!(await errOf(() => S.readState(rT))), '还原文件字节后测试表下读登记表恢复正常');
                const rawT = JSON.parse(fs.readFileSync(linesFile(rT), 'utf8'));
                // 不用字符串子串判断（UUID / 时间戳里可能碰巧含 3100）：解析后逐条记录核对 port；期望端口按槽位手写
                const T_PORT = { 1: 20101, 2: 20102, 3: 20103 };
                const recsT = Object.values(rawT.lines).concat(rawT.history);
                must(jstr(Object.keys(rawT).sort()) === jstr(['config', 'history', 'lines', 'version']) && jstr(Object.keys(rawT.config).sort()) === jstr(['integration_branch', 'integration_workspace', 'mode'])
                    && recsT.length === 3 && recsT.every((r) => r.port !== 3100 && r.port === T_PORT[r.slot]),
                    '测试端口表不写进 lines.json：顶层键仍是 version / config / lines / history，config 键不变，lines 与 history 里共 3 条记录的 port 都是测试端口（槽位 1/2/3 ↔ 20101/20102/20103），没有一条是生产端口 3100', jstr({ keys: Object.keys(rawT), recs: recsT.map((r) => [r.slot, r.port]) }));
                SET(null);
                const eBack = await errOf(() => S.readState(rT));
                must(eBack && eBack.code === 'STATE_CORRUPT', '还原为缺省后再读测试表下写的登记表：按生产缺省校验，端口 20101 与槽位 1 不对应 → STATE_CORRUPT（再次证明校验读当前表）', jstr(eBack && eBack.code));
                const rBack = ctl('ports-restored');
                const b1 = await S.createLine(rBack, 'b1');
                must(b1.port === 3100, '还原后新建的线端口回到 3100', jstr(b1));

                // history 也按当前表校验：测试表下把一条线走完 creating → ready → removing → removed（进 history），lines 为空，唯一的记录在 history 里
                SET(KNOWN);
                const rH = ctl('ports-history');
                const eHSetup = await errOf(async () => {
                    await S.createLine(rH, 'h1', {}, at(T0));
                    await S.updateLine(rH, 'h1', (r) => { r.lifecycle = 'ready'; }, at(T1));
                    await S.updateLine(rH, 'h1', (r) => { r.lifecycle = 'removing'; }, at(T2));
                    await S.removeLineRecord(rH, 'h1', at(T3));   // 写入时对「变更后的整表」的校验也要把进 history 的记录按测试表校验
                });
                must(eHSetup === null, '测试表下一条线走完 creating → ready → removing → removed（移入 history）的四次写入都成功（写入时的整表校验把 history 记录按测试表核对）', jstr(eHSetup && [eHSetup.code, eHSetup.message]));
                if (eHSetup !== null) return;
                const eHist = await errOf(() => S.readState(rH));
                const stH = eHist === null ? await S.readState(rH) : null;
                must(eHist === null && jstr(stH.lines) === '{}' && stH.history.length === 1 && stH.history[0].name === 'h1' && stH.history[0].lifecycle === 'removed' && stH.history[0].port === 20101,
                    '测试表下线走到 removed 进 history（lines 为空，history 里 h1 的 port = 20101）：readState 正常（history 按测试表校验）', jstr({ err: eHist && eHist.code, st: stH }));
                const rawH = JSON.parse(fs.readFileSync(linesFile(rH), 'utf8'));
                SET(null);
                const eHistBack = await errOf(() => S.readState(rH));
                const psHistBack = S.validateState(rawH);
                must(eHistBack && eHistBack.code === 'STATE_CORRUPT' && psHistBack.length === 1 && /port 与槽位不对应（槽位 1 应为 3100）/.test(psHistBack[0]),
                    '还原为缺省后读同一份只含 history 记录的登记表：STATE_CORRUPT，整表校验恰好一条问题「槽位 1 应为 3100」（history 记录同样读当前表，不是固定按生产表）', jstr({ err: eHistBack && eHistBack.code, ps: psHistBack }));
            } finally {
                if (typeof SET === 'function') SET(null);
            }
        });

        // ======================= 9 状态转换 =======================
        await sec('9 lifecycle 状态转换（手写表）', async () => {
            const L = ['creating', 'ready', 'removing', 'removed', 'failed'];
            const legal = new Set(['creating>ready', 'creating>failed', 'ready>removing', 'failed>removing', 'failed>creating', 'removing>removed', 'removing>failed']);   // 派单 1.3 的七条
            const wrong = [];
            for (const f of L) for (const t of L) {
                const expect = f === t || legal.has(`${f}>${t}`);
                if (S.checkLifecycleTransition(f, t) !== expect) wrong.push(`${f}>${t}`);
            }
            must(wrong.length === 0, '25 个 (from, to) 组合：只有七条合法转换（及同态）被接受', jstr(wrong));
            must(S.checkLifecycleTransition('bogus', 'ready') === false && S.checkLifecycleTransition('ready', 'bogus') === false, '未知 lifecycle 取值一律不合法');
            const root = ctl('trans');
            await S.createLine(root, 'a');
            const flow = [];
            const step = async (patch, label) => { const e = await errOf(() => S.updateLine(root, 'a', patch)); flow.push([label, e ? e.code : 'OK']); return e; };
            // 非法：creating → removing / removed
            await step((r) => { r.lifecycle = 'removing'; }, 'creating>removing');
            await step((r) => { r.lifecycle = 'removed'; }, 'creating>removed');
            await step((r) => { r.lifecycle = 'ready'; }, 'creating>ready');
            await step((r) => { r.lifecycle = 'creating'; }, 'ready>creating');
            await step((r) => { r.lifecycle = 'failed'; r.failed_step = 's'; }, 'ready>failed');
            await step((r) => { r.lifecycle = 'removing'; }, 'ready>removing');
            await step((r) => { r.lifecycle = 'ready'; }, 'removing>ready');
            await step((r) => { r.lifecycle = 'failed'; }, 'removing>failed(缺 failed_step)');
            await step((r) => { r.lifecycle = 'failed'; r.failed_step = 'stop-instance'; }, 'removing>failed');
            await step((r) => { r.lifecycle = 'creating'; }, 'failed>creating(未清 failed_step)');
            await step((r) => { r.lifecycle = 'creating'; r.failed_step = null; }, 'failed>creating');
            await step((r) => { r.lifecycle = 'failed'; r.failed_step = 'again'; }, 'creating>failed');
            await step((r) => { r.lifecycle = 'removing'; r.failed_step = null; }, 'failed>removing');
            await step((r) => { r.lifecycle = 'removed'; }, 'removing>removed');   // 经 updateLine 转 removed 也移入 history
            const expectFlow = [
                ['creating>removing', 'STATE_BAD_TRANSITION'], ['creating>removed', 'STATE_BAD_TRANSITION'], ['creating>ready', 'OK'], ['ready>creating', 'STATE_BAD_TRANSITION'], ['ready>failed', 'STATE_BAD_TRANSITION'],
                ['ready>removing', 'OK'], ['removing>ready', 'STATE_BAD_TRANSITION'], ['removing>failed(缺 failed_step)', 'STATE_INVALID_PATCH'], ['removing>failed', 'OK'],
                ['failed>creating(未清 failed_step)', 'STATE_INVALID_PATCH'], ['failed>creating', 'OK'], ['creating>failed', 'OK'], ['failed>removing', 'OK'], ['removing>removed', 'OK'],
            ];
            must(jstr(flow) === jstr(expectFlow), '依次经 updateLine 走合法与非法转换：结果逐条等于手写期望', jstr(flow));
            const st = await S.readState(root);
            must(jstr(st.lines) === '{}' && st.history.length === 1 && st.history[0].lifecycle === 'removed', '经 updateLine 转 removed：记录同样移入 history、槽位释放');
        });

        await sec('9b 进程登记不变量：process 未清空不得转 removing / removed；转 removed 同一次写清空 yield_request', async () => {
            const root = ctl('proc-invariant');
            await S.createLine(root, 'x', { module: 'mx' }, at(T0));
            await S.updateLine(root, 'x', (r) => { r.lifecycle = 'ready'; r.process = Object.assign({}, PROC); }, at(T1));
            const before = bytes(root);
            const e1 = await errOf(() => S.updateLine(root, 'x', (r) => { r.lifecycle = 'removing'; }, at(T2)));
            must(e1 && e1.code === 'STATE_PROCESS_REGISTERED' && sameBytes(bytes(root), before), 'ready 且 process 非空 → removing：STATE_PROCESS_REGISTERED，字节未变', jstr(e1 && e1.code));
            // failed → removing 同理
            await S.updateLine(root, 'x', (r) => { r.lifecycle = 'removing'; r.process = null; }, at(T2));   // 同一次写里先清 process 再转：允许
            let st = await S.readState(root);
            must(st.lines.x.lifecycle === 'removing' && st.lines.x.process === null, '同一次写里清空 process 并转 removing：允许（判的是写入后的记录）');
            // 状态不变量（2d）：已经是 removing 的线（同态，没有转换）也不能再登记进程
            const mid = bytes(root);
            const e2 = await errOf(() => S.updateLine(root, 'x', (r) => { r.process = Object.assign({}, PROC); }, at(T3)));
            must(e2 && e2.code === 'STATE_PROCESS_REGISTERED' && sameBytes(bytes(root), mid), '已是 removing 的线写入 process（没有 lifecycle 转换）：STATE_PROCESS_REGISTERED，字节未变（不变量不依赖转换）', jstr(e2 && e2.code));
            const e2b = await errOf(() => S.updateLine(root, 'x', (r) => { r.process = Object.assign({}, PROC); r.lifecycle = 'removed'; }, at(T4)));
            must(e2b && e2b.code === 'STATE_PROCESS_REGISTERED' && sameBytes(bytes(root), mid), 'removing → removed 同时带着 process：同样被拦，字节未变', jstr(e2b && e2b.code));
            const e2c = await errOf(() => S.updateLine(root, 'x', (r) => { r.module = 'still-ok'; }, at(T3)));
            must(!e2c, 'removing 的线 process 为 null 时其他字段照常可改（不变量只管 process）', jstr(e2c && e2c.code));
            const root2 = ctl('proc-invariant-failed');
            await S.createLine(root2, 'y');
            await S.updateLine(root2, 'y', (r) => { r.lifecycle = 'failed'; r.failed_step = 'start'; r.process = Object.assign({}, PROC); }, at(T1));
            const b2 = bytes(root2);
            const e3 = await errOf(() => S.updateLine(root2, 'y', (r) => { r.lifecycle = 'removing'; r.failed_step = null; }, at(T2)));
            must(e3 && e3.code === 'STATE_PROCESS_REGISTERED' && sameBytes(bytes(root2), b2), 'failed 且 process 非空 → removing：STATE_PROCESS_REGISTERED，字节未变', jstr(e3 && e3.code));

            // 转 removed 同一次写清空 yield_request
            const root3 = ctl('removed-clears-yield');
            await S.createLine(root3, 'z', { module: 'mz' }, at(T0));
            await S.updateLine(root3, 'z', (r) => { r.lifecycle = 'ready'; r.yield_request = { reason: 'wait-for-b', n: 3 }; }, at(T1));
            await S.updateLine(root3, 'z', (r) => { r.lifecycle = 'removing'; }, at(T2));
            const stMid = await S.readState(root3);
            const removed = await S.removeLineRecord(root3, 'z', at(T3));
            st = await S.readState(root3);
            must(eq(stMid.lines.z.yield_request, { reason: 'wait-for-b', n: 3 }) && removed.yield_request === null && st.history.length === 1 && st.history[0].yield_request === null && eq(st, TABLE(CFG(), {}, [REC('z', 1, { module: 'mz', lifecycle: 'removed', created_at: T0, updated_at: T3, removed_at: T3 })])),
                '转 removed：removing 时还留着的 yield_request 在同一次写里清空，history 记录整表与手写期望全等', canon(st));
        });

        // ======================= 原子替换重试 =======================
        await sec('原子替换：EPERM 有界重试；最终失败删临时文件、登记表保持旧内容', async () => {
            const root = ctl('replace');
            await S.updateConfig(root, (c) => { c.integration_branch = 'v1'; });
            const before = bytes(root);
            let n = 0;
            SET_HOOKS({ renameSync: (a, b) => { n++; if (n <= 3) { const e = new Error('EPERM simulated'); e.code = 'EPERM'; throw e; } return fs.renameSync(a, b); } });
            await S.updateConfig(root, (c) => { c.integration_branch = 'v2'; });
            resetHooks();
            must(n === 4 && (await S.readState(root)).config.integration_branch === 'v2' && tmpLeft(root).length === 0, '前 3 次 EPERM、第 4 次成功：写入成功（共尝试 4 次），无临时文件残留', jstr({ n, tmp: tmpLeft(root) }));
            const v2 = bytes(root);
            let m = 0;
            SET_HOOKS({ renameSync: () => { m++; const e = new Error('EBUSY simulated'); e.code = 'EBUSY'; throw e; } });
            const t0 = Date.now();
            const eAlways = await errOf(() => S.updateConfig(root, (c) => { c.integration_branch = 'v3'; }));
            resetHooks();
            must(eAlways && eAlways.code === 'STATE_REPLACE_FAILED' && m === 12 && sameBytes(bytes(root), v2) && tmpLeft(root).length === 0 && Date.now() - t0 < sc(60000), '一直 EBUSY：尝试 12 次后 STATE_REPLACE_FAILED，临时文件已删，登记表保持旧内容', jstr({ m, code: eAlways && eAlways.code, tmp: tmpLeft(root), ms: Date.now() - t0 }));
            let k = 0;
            SET_HOOKS({ renameSync: () => { k++; const e = new Error('ENOENT simulated'); e.code = 'ENOENT'; throw e; } });
            const eOther = await errOf(() => S.updateConfig(root, (c) => { c.integration_branch = 'v4'; }));
            resetHooks();
            must(eOther && eOther.code === 'STATE_REPLACE_FAILED' && k === 1 && sameBytes(bytes(root), v2) && tmpLeft(root).length === 0, '非瞬时错误（ENOENT）不重试：尝试 1 次即失败，临时文件已删', jstr({ k, tmp: tmpLeft(root) }));
            must(!sameBytes(before, v2), '前提：v1 与 v2 的内容不同（上面的字节比较有意义）');
            // 崩溃遗留的临时文件由下一次写入清掉
            fs.writeFileSync(path.join(root, 'lines.json.tmp-9999-1-dead'), 'stale');
            await S.updateConfig(root, (c) => { c.integration_branch = 'v5'; });
            must(tmpLeft(root).length === 0, '崩溃遗留的 lines.json.tmp-* 在下一次持锁写入时被清掉', jstr(tmpLeft(root)));
        });

        // ======================= 12 确定性争用 =======================
        await sec('12 确定性争用：A 持锁暂停 → 父进程在 A 持锁期间发起 updateLine（必然进入等待）→ A 改另一字段、提交、释放 → 结果同时含两处修改', async () => {
            const rounds = [
                { a: ['module', 'from-A'], p: ['surface', 'from-parent'] },
                { a: ['branch', 'feat/from-A'], p: ['worktree', 'E:/from-parent'] },
                { a: ['yield_request', { n: 1 }], p: ['deps_mode', 'independent'] },
            ];
            const init = { module: 'm0', branch: 'feat/init', worktree: 'E:/init', surface: 'init-s', deps_mode: 'shared' };
            for (let r = 0; r < rounds.length; r++) {
                const { a, p } = rounds[r];
                const root = ctl(`contend-${r}`);
                await S.createLine(root, 'alpha', init, at(T0));
                const marker = path.join(root, 'held.marker');
                const release = path.join(root, 'release.signal');
                const holder = startWorker({ role: 'hold-line', controlRoot: root, name: 'alpha', marker, release, field: a[0], value: a[1], timeoutMs: 30000, now: T1 });
                // 每轮 try/finally：无论中途怎样，都保证发出释放信号（或强杀持有者）并等它 close，不会留下持锁子进程，也不会因提前失败留下未处理拒绝
                let released = false;
                const doRelease = () => { if (!released) { released = true; try { fs.writeFileSync(release, 'go'); } catch (_) { /* 目录不在了就算了 */ } } };
                try {
                    const held = await waitForFile(marker, 30000, holder);
                    must(held, `第 ${r + 1} 轮：A 取到锁并暂停（标记文件已写出）`);
                    let busyResolve;
                    const busySeen = new Promise((res) => { busyResolve = res; });
                    SET_HOOKS({ beforeBegin: () => { resetHooks(); busyResolve(true); } });
                    let settled = false;
                    // 创建时立刻把成功 / 失败都转成普通结果对象：中间没有任何未处理的拒绝
                    const pendingP = S.updateLine(root, 'alpha', (rec) => { rec[p[0]] = p[1]; }, Object.assign({ lockTimeoutMs: sc(30000) }, at(T2)))
                        .then((v) => { settled = true; return { ok: true, v }; }, (e) => { settled = true; return { ok: false, e }; });
                    const reached = await Promise.race([busySeen, sleepAsync(sc(10000)).then(() => false)]);
                    await sleepAsync(200);   // 余量：让父进程的 BEGIN EXCLUSIVE 真正发出并阻塞；这里不是正确性前提，下面的 settled 断言才是
                    const stillWaiting = !settled;
                    doRelease();
                    resetHooks();
                    const res = await pendingP;
                    const hx = await holder.exited;
                    must(reached !== false && stillWaiting, `第 ${r + 1} 轮：A 持锁期间父进程的写确实进入等待（取锁前钩子已触发，且 A 释放前父进程的调用未完成）`, jstr({ reached, stillWaiting }));
                    must(exitedOk(hx) && res.ok, `第 ${r + 1} 轮：A 与父进程的写都成功完成`, jstr({ hx: exitInfo(hx), err: !res.ok && res.e && res.e.message }));
                    const st = await S.readState(root);
                    must(res.ok && eq(st, TABLE(CFG(), { alpha: REC('alpha', 1, Object.assign({}, init, { [a[0]]: a[1], [p[0]]: p[1], updated_at: T2 })) })),
                        `第 ${r + 1} 轮：最终整表同时含 A 的修改（${a[0]}）与父进程的修改（${p[0]}），updated_at 为后写者的固定时钟`, canon(st));
                } finally {
                    doRelease();
                    resetHooks();
                    await Promise.race([holder.exited, sleepAsync(sc(30000))]);
                    if (!holder.done) holder.kill();
                    await Promise.race([holder.closedP, sleepAsync(sc(15000))]);
                }
            }
        });

        // ======================= 13 并发建线 =======================
        await sec('13 并发建线：4 个进程同步起跑', async () => {
            const runGroup = async (root, names) => {
                fs.mkdirSync(root, { recursive: true });
                const goFile = path.join(root, 'go.signal');
                const ws = names.map((name, i) => startWorker({ role: 'create', controlRoot: root, name, readyFile: path.join(root, `ready-${i}`), goFile, timeoutMs: 60000, now: T1 }));
                const readies = await Promise.all(names.map((_, i) => waitForFile(path.join(root, `ready-${i}`), 30000, ws[i])));
                fs.writeFileSync(goFile, 'go');
                const xs = await Promise.all(ws.map((w) => w.exited));
                return { readies, xs };
            };
            const root = ctl('create-race');
            const names = ['n1', 'n2', 'n3', 'n4'];
            const { readies, xs } = await runGroup(root, names);
            const procOk = xs.every((x) => x.code === 0 && !x.timedOut && x.closed && x.result);
            must(readies.every(Boolean) && procOk, '4 个进程都就绪、同时起跑并正常结束', jstr(xs.map(exitInfo)));
            const oks = xs.filter((x) => x.result && x.result.ok);
            const errs = xs.filter((x) => x.result && !x.result.ok);
            must(oks.length === 3 && errs.length === 1 && errs[0].result.code === 'STATE_NO_FREE_SLOT', '空表上 4 个进程建 4 条不同名称的线：恰 3 个成功、1 个 STATE_NO_FREE_SLOT', jstr(xs.map((x) => x.result)));
            must(eq(oks.map((x) => x.result.slot).sort(), [1, 2, 3]) && eq(oks.map((x) => x.result.port).sort(), [3100, 3200, 3300]) && oks.every((x) => x.result.port === PORT_OF[x.result.slot]), '成功者的槽位恰为 {1,2,3}、端口恰为 {3100,3200,3300}，且一一对应', jstr(oks.map((x) => x.result)));
            const st = await S.readState(root);
            const expectLines = {};
            for (const x of oks) expectLines[x.result.name] = REC(x.result.name, x.result.slot, { created_at: T1, updated_at: T1 });
            must(eq(st, TABLE(CFG(), expectLines)), '最终登记表整表：恰这 3 条线，槽位与端口精确对应，无多余记录', canon(st));
            const root2 = ctl('create-race-case');
            const group2 = await runGroup(root2, ['Same', 'SAME', 'same', 'sAmE']);
            const oks2 = group2.xs.filter((x) => x.result && x.result.ok);
            const errs2 = group2.xs.filter((x) => x.result && !x.result.ok);
            must(group2.readies.every(Boolean) && group2.xs.every((x) => x.code === 0 && !x.timedOut && x.closed && x.result), '大小写不同的同名线：4 个进程都就绪并正常结束', jstr(group2.xs.map(exitInfo)));
            must(oks2.length === 1 && errs2.length === 3 && errs2.every((x) => x.result.code === 'STATE_LINE_EXISTS'), '并发建大小写不同的同名线：恰 1 个成功，其余 3 个 STATE_LINE_EXISTS', jstr(group2.xs.map((x) => x.result)));
            const st2 = await S.readState(root2);
            must(oks2.length === 1 && eq(st2, TABLE(CFG(), { [oks2[0].result.name]: REC(oks2[0].result.name, 1, { created_at: T1, updated_at: T1 }) })), '最终登记表只有成功者那一条线（槽位 1）', canon(st2));
        });

        // ======================= 14 修复批 1 的实现项 =======================
        await sec('14a 完整写入：短写补写 / 零进展 / 写报错（注入 writeSync）', async () => {
            const root = ctl('impl-write');
            await S.createLine(root, 'alpha', { module: 'm0' }, at(T0));
            const realWrite = fs.writeSync;
            let calls = 0;
            SET_HOOKS({ writeSync: (fd, buf, off, len, pos) => { calls++; return realWrite(fd, buf, off, Math.min(len, 7), pos); } });
            const rec = await S.updateLine(root, 'alpha', (r) => { r.module = 'short-write-ok'; r.surface = ['一二三', 'abc']; }, at(T1));
            resetHooks();
            const text = fs.readFileSync(linesFile(root), 'utf8');
            let parsed = null;
            try { parsed = JSON.parse(text); } catch (_) { /* 下面断言 */ }
            must(calls > 5 && parsed && text === `${JSON.stringify(parsed, null, 2)}\n` && rec.module === 'short-write-ok' && parsed.lines.alpha.module === 'short-write-ok' && eq(parsed.lines.alpha.surface, ['一二三', 'abc']),
                `writeSync 每次最多写 7 字节（共 ${calls} 次调用）：循环补写直到写满，登记表是完整合法 JSON 且内容正确`, `calls=${calls} text.length=${text.length}`);
            const after1 = bytes(root);
            let zeroCalls = 0;
            SET_HOOKS({ writeSync: () => { zeroCalls++; if (zeroCalls > 1000) throw new Error('测试防死循环：零进展调用超过 1000 次'); return 0; } });
            const eZero = await errOf(() => S.updateLine(root, 'alpha', (r) => { r.module = 'zero'; }));
            resetHooks();
            must(eZero && eZero.code === 'STATE_WRITE_FAILED' && zeroCalls <= 3 && sameBytes(bytes(root), after1) && tmpLeft(root).length === 0, `writeSync 零进展：不死循环，STATE_WRITE_FAILED（调用 ${zeroCalls} 次），登记表字节不变，临时文件已删`, jstr({ code: eZero && eZero.code, zeroCalls, tmp: tmpLeft(root) }));
            let throwCalls = 0;
            SET_HOOKS({ writeSync: (fd, buf, off, len, pos) => { throwCalls++; if (throwCalls === 1) return realWrite(fd, buf, off, Math.min(len, 3), pos); const e = new Error('EIO simulated'); e.code = 'EIO'; throw e; } });
            const eThrow = await errOf(() => S.updateLine(root, 'alpha', (r) => { r.module = 'throw'; }));
            resetHooks();
            must(eThrow && eThrow.code === 'STATE_WRITE_FAILED' && sameBytes(bytes(root), after1) && tmpLeft(root).length === 0, '先写 3 字节再报 EIO：STATE_WRITE_FAILED，登记表字节不变，临时文件已删（fd 已关，Windows 上否则删不掉）', jstr({ code: eThrow && eThrow.code, tmp: tmpLeft(root) }));
            // fsync 失败同样删临时文件再抛
            const realFsync = fs.fsyncSync;
            fs.fsyncSync = () => { const e = new Error('fsync EIO simulated'); e.code = 'EIO'; throw e; };
            let eSync;
            try { eSync = await errOf(() => S.updateLine(root, 'alpha', (r) => { r.module = 'fsync-fail'; })); } finally { fs.fsyncSync = realFsync; }
            must(eSync && eSync.code === 'STATE_WRITE_FAILED' && sameBytes(bytes(root), after1) && tmpLeft(root).length === 0, 'fsync 失败：删临时文件、STATE_WRITE_FAILED，登记表字节不变', jstr({ code: eSync && eSync.code, tmp: tmpLeft(root) }));
            const okAfter = await S.updateLine(root, 'alpha', (r) => { r.module = 'next'; }, { lockTimeoutMs: sc(20000) });
            must(okAfter.module === 'next', '失败之后锁已释放，下一次写正常成功');
        });

        await sec('14b 连接关闭 / COMMIT / ROLLBACK 失败：错误不吞、业务异常保留、队列不卡死；COMMIT 在 rename 之后失败按成功返回', async () => {
            const root = ctl('impl-close');
            await S.createLine(root, 'alpha', {}, at(T0));
            const closeFail = (msg) => (db, real) => real(db).then(() => { throw new Error(msg); });
            // Q3：COMMIT 成功、close 失败 -> 事务已结束、锁已释放：成功返回 + 警告（写明关闭失败与是否真写入）
            SET_HOOKS({ dbClose: closeFail('inject close #1') });
            const w1 = await withWarnings(() => caught(() => S.updateLine(root, 'alpha', (r) => { r.module = 'written'; })));
            resetHooks();
            must(!w1.v.threw && (await S.readState(root)).lines.alpha.module === 'written' && w1.ws.length === 1 && /^StateLockCleanupWarning:.*登记表已写入.*关闭连接失败：inject close #1/.test(w1.ws[0]),
                'COMMIT 成功但关闭连接失败：事务已结束，按成功返回（登记表已写入）+ 一条 StateLockCleanupWarning（写明关闭失败）', jstr({ threw: w1.v.threw, ws: w1.ws }));
            const okA = await S.updateLine(root, 'alpha', (r) => { r.module = 'after-close-fail'; }, { lockTimeoutMs: sc(20000) });
            must(okA.module === 'after-close-fail', '关闭失败之后队列未卡死、锁已释放：下一次写在宽松预算（20 秒 × 时间系数）内成功（不再断言耗时）');
            // 业务异常 + 关闭失败：保留原始业务异常，附清理失败信息
            SET_HOOKS({ dbClose: closeFail('inject close #2') });
            const boom = new Error('business boom');
            const before = bytes(root);
            const e2 = await caught(() => S.updateLine(root, 'alpha', (r) => { r.module = 'half'; throw boom; }));
            resetHooks();
            must(e2.threw && e2.value === boom && Array.isArray(boom.cleanupErrors) && boom.cleanupErrors.length === 1 && /inject close #2/.test(boom.cleanupErrors[0].message) && sameBytes(bytes(root), before),
                '业务异常 + 关闭失败：原始业务异常原样抛出，并附带 cleanupErrors（关闭失败信息），登记表未变', jstr({ same: e2.value === boom, ce: boom.cleanupErrors && boom.cleanupErrors.map((x) => x.message) }));
            // COMMIT 失败：登记表已 rename 成功 -> 记警告、补 ROLLBACK、照常 close、按成功返回
            const sqlLog = [];
            const warnings = [];
            const onWarn = (w) => { warnings.push(`${w.name}:${w.message}`); };
            process.on('warning', onWarn);
            let r3;
            try {
                SET_HOOKS({ dbRun: (db, sql, real) => { sqlLog.push(sql); return sql === 'COMMIT' ? Promise.reject(new Error('inject commit')) : real(db, sql); } });
                r3 = await caught(() => S.updateConfig(root, (c) => { c.integration_branch = 'commit-fail'; }));
                resetHooks();
                await sleepAsync(50);   // 'warning' 事件经 nextTick 异步发出
            } finally { process.removeListener('warning', onWarn); }
            const stAfter = await S.readState(root);
            must(!r3.threw && stAfter.config.integration_branch === 'commit-fail' && jstr(sqlLog) === jstr(['BEGIN EXCLUSIVE', 'COMMIT', 'ROLLBACK']) && warnings.some((w) => /^StateLockCommitWarning:.*inject commit/.test(w)),
                'rename 成功后 COMMIT 失败：按成功返回（登记表已写入），记 StateLockCommitWarning，SQL 序列 BEGIN EXCLUSIVE → COMMIT → ROLLBACK', jstr({ threw: r3.threw, sqlLog, warnings }));
            const okB = await S.updateConfig(root, (c) => { c.integration_workspace = 'after-commit-fail'; }, { lockTimeoutMs: sc(20000) });
            must(okB.integration_workspace === 'after-commit-fail', 'COMMIT 失败之后锁已释放，下一次写成功');
            // 业务异常 + ROLLBACK 失败 + 关闭失败：原异常保留，两条清理失败都附上
            // 这个场景会把控制根标记为「锁状态不确定」（修复批 2）：用单独的控制根，不影响本节后面的用例
            const rootU = ctl('impl-close-rollback-and-close');
            await S.createLine(rootU, 'alpha', {}, at(T0));
            SET_HOOKS({ dbRun: (db, sql, real) => (sql === 'ROLLBACK' ? Promise.reject(new Error('inject rollback')) : real(db, sql)), dbClose: closeFail('inject close #3') });
            const boom2 = new Error('business boom 2');
            const e4 = await caught(() => S.updateLine(rootU, 'alpha', () => { throw boom2; }));
            resetHooks();
            must(e4.threw && e4.value === boom2 && boom2.cleanupErrors && boom2.cleanupErrors.length === 2 && /inject rollback/.test(boom2.cleanupErrors[0].message) && /inject close #3/.test(boom2.cleanupErrors[1].message),
                '业务异常 + ROLLBACK 失败 + 关闭失败：原异常原样保留，cleanupErrors 带两条清理失败', jstr(boom2.cleanupErrors && boom2.cleanupErrors.map((x) => x.message)));
            // 排在失败调用后面的调用不被拖死
            let closes = 0;
            SET_HOOKS({ dbClose: (db, real) => { closes++; return closes === 1 ? real(db).then(() => { throw new Error('inject close #5'); }) : real(db); } });
            const pQ1 = errOf(() => S.updateLine(root, 'alpha', (r) => { r.module = 'q1'; }));
            const pQ2 = S.updateLine(root, 'alpha', (r) => { r.branch = 'q2'; }, { lockTimeoutMs: sc(20000) });
            const [eQ1, rQ2] = await Promise.all([pQ1, pQ2]);
            resetHooks();
            must(eQ1 === null && rQ2.branch === 'q2' && closes >= 2, '排在「关闭失败」调用后面的调用照常完成（第一个调用按成功返回，队列没有卡）', jstr({ eQ1: eQ1 && eQ1.code, rQ2: rQ2 && rQ2.branch, closes }));
            // Q1：COMMIT 与 ROLLBACK 都失败、close 成功 -> 锁已释放：成功返回 + 警告写 ROLLBACK 失败
            const rootQ1 = ctl('impl-close-q1');
            await S.createLine(rootQ1, 'alpha', {}, at(T0));
            SET_HOOKS({ dbRun: (db, sql, real) => ((sql === 'COMMIT' || sql === 'ROLLBACK') ? Promise.reject(new Error(`inject ${sql.toLowerCase()}`)) : real(db, sql)) });
            const wq1 = await withWarnings(() => caught(() => S.updateLine(rootQ1, 'alpha', (r) => { r.module = 'q1-written'; })));
            resetHooks();
            const okQ1 = await S.updateLine(rootQ1, 'alpha', (r) => { r.branch = 'after-q1'; }, { lockTimeoutMs: sc(20000) });
            must(!wq1.v.threw && wq1.ws.length === 1 && /^StateLockCommitWarning:.*登记表已写入.*COMMIT 失败：inject commit.*ROLLBACK 失败：inject rollback/.test(wq1.ws[0]) && okQ1.branch === 'after-q1',
                'COMMIT 与 ROLLBACK 都失败、close 成功（锁已释放）：按成功返回，警告写明 COMMIT 与 ROLLBACK 失败和「登记表已写入」；之后的调用照常成功', jstr({ threw: wq1.v.threw, ws: wq1.ws }));
        });

        await sec('14c 假值异常：throw null / undefined / 0 / false / \'\' 都 ROLLBACK 并原样重抛', async () => {
            const root = ctl('impl-falsy');
            await S.createLine(root, 'alpha', {}, at(T0));
            const before = bytes(root);
            const sqlLog = [];
            SET_HOOKS({ dbRun: (db, sql, real) => { sqlLog.push(sql); return real(db, sql); } });
            for (const [label, v] of [['null', null], ['undefined', undefined], ['0', 0], ['false', false], ["''", '']]) {
                sqlLog.length = 0;
                const r = await caught(() => S.updateLine(root, 'alpha', (rec) => { rec.module = 'half'; throw v; }));
                must(r.threw && Object.is(r.value, v) && jstr(sqlLog) === jstr(['BEGIN EXCLUSIVE', 'ROLLBACK']) && sameBytes(bytes(root), before),
                    `补丁 throw ${label}：原值原样重抛，SQL 序列 BEGIN EXCLUSIVE → ROLLBACK（没有 COMMIT），登记表字节不变`, jstr({ threw: r.threw, sqlLog }));
                const okRec = await S.updateConfig(root, (c) => { c.mode = c.mode; }, { lockTimeoutMs: sc(20000) });
                must(!!okRec, `throw ${label} 之后锁已释放：下一次调用在宽松预算内成功（不再断言耗时）`);
            }
            sqlLog.length = 0;
            const rc = await caught(() => S.updateConfig(root, () => { throw null; }));
            must(rc.threw && rc.value === null && jstr(sqlLog) === jstr(['BEGIN EXCLUSIVE', 'ROLLBACK']), 'updateConfig 的补丁 throw null：同样原样重抛并 ROLLBACK', jstr(sqlLog));
        });

        await sec('14d async 补丁与 async guard：不留未处理拒绝', async () => {
            const root = ctl('impl-async');
            await S.createLine(root, 'alpha', {}, at(T0));
            const before = bytes(root);
            const seenRejections = [];
            const onRej = (reason) => { seenRejections.push(reason && reason.message ? reason.message : String(reason)); };
            process.on('unhandledRejection', onRej);
            try {
                const cases = [
                    ['原生 async 函数（体内 throw）', () => S.updateLine(root, 'alpha', async () => { throw new Error('late-async'); })],
                    ['非 async 函数返回已拒绝的 Promise', () => S.updateLine(root, 'alpha', () => Promise.reject(new Error('late-reject')))],
                    ['返回稍后才拒绝的 Promise', () => S.updateLine(root, 'alpha', () => new Promise((_, rej) => { setTimeout(() => rej(new Error('late-timer')), 30); }))],
                    ['updateConfig 的 async 补丁', () => S.updateConfig(root, async () => { throw new Error('late-config'); })],
                    ['updateConfig 返回已拒绝的 Promise', () => S.updateConfig(root, () => Promise.reject(new Error('late-config-2')))],
                    ['createLine 的 guard 返回已拒绝的 Promise', () => S.createLine(root, 'beta', {}, { guard: () => Promise.reject(new Error('late-guard')) })],
                ];
                const codes = [];
                for (const [, run] of cases) { const e = await errOf(run); codes.push(e && e.code); }
                await sleepAsync(250);   // 给 Node 触发 unhandledRejection 的时间窗（缺失型断言必须等一个窗口）
                must(codes.every((c) => c === 'STATE_PATCH_ASYNC'), `${cases.length} 种 async 补丁 / guard 形态全部以 STATE_PATCH_ASYNC 拒绝`, jstr(codes));
                must(seenRejections.length === 0, 'unhandledRejection 监听到 0 次（补丁返回的 Promise 的拒绝已被吃掉）', jstr(seenRejections));
                must(sameBytes(bytes(root), before), '登记表字节不变');
            } finally { process.removeListener('unhandledRejection', onRej); }
        });

        await sec('14e 非法输入在 JSON 往返之前被拒（NaN / undefined / 函数 / Symbol / BigInt / toJSON / 非纯对象 / 空位 / 存取器 / 环）', async () => {
            const root = ctl('impl-input');
            await S.createLine(root, 'alpha', {}, at(T0));
            const before = bytes(root);
            class Klass { constructor() { this.n = 1; } }
            const circular = {}; circular.self = circular;
            const withGetter = Object.defineProperty({}, 'g', { get() { return 1; }, enumerable: true });
            const hidden = Object.defineProperty({}, 'h', { value: 1, enumerable: false });
            const bads = [
                ['NaN', () => ({ n: NaN })], ['Infinity', () => ({ n: Infinity })], ['-Infinity', () => ({ n: -Infinity })], ['-0', () => ({ n: -0 })],
                ['对象里的 undefined 值', () => ({ n: undefined })], ['数组里的 undefined', () => ({ a: [1, undefined] })], ['数组空位', () => ({ a: [1, , 3] })],
                ['函数', () => ({ f() { return 1; } })], ['Symbol 值', () => ({ s: Symbol('s') })], ['BigInt', () => ({ b: 10n })],
                ['带 toJSON 的对象', () => ({ toJSON() { return { n: 1 }; } })], ['嵌套里带 toJSON', () => ({ inner: { toJSON() { return 1; } } })],
                ['Date', () => ({ d: new Date(0) })], ['Map', () => ({ m: new Map([[1, 2]]) })], ['类实例', () => ({ k: new Klass() })], ['数组上的多余属性', () => ({ a: Object.assign([1], { extra: 1 }) })],
                ['存取器属性', () => withGetter], ['不可枚举属性', () => hidden], ['Symbol 键', () => ({ [Symbol('k')]: 1 })], ['循环引用', () => circular],
            ];
            for (const [label, build] of bads) {
                const e = await errOf(() => S.updateLine(root, 'alpha', (r) => { r.yield_request = build(); }));
                must(e && e.code === 'STATE_INVALID_PATCH' && sameBytes(bytes(root), before), `补丁结果含「${label}」：STATE_INVALID_PATCH，登记表字节不变`, jstr(e && { c: e.code, m: e.message }));
            }
            const eUnk = await errOf(() => S.updateLine(root, 'alpha', (r) => { r.extra_field = undefined; }));
            must(eUnk && eUnk.code === 'STATE_INVALID_PATCH' && sameBytes(bytes(root), before), '未知字段的值为 undefined（往返会把键丢掉而蒙混过关）：STATE_INVALID_PATCH，字节不变', jstr(eUnk && eUnk.code));
            const eRet = await errOf(() => S.updateLine(root, 'alpha', (r) => Object.assign({}, r, { yield_request: { n: NaN } })));
            must(eRet && eRet.code === 'STATE_INVALID_PATCH' && sameBytes(bytes(root), before), '补丁以返回值方式给出含 NaN 的新记录：同样 STATE_INVALID_PATCH', jstr(eRet && eRet.code));
            const eCfg = await errOf(() => S.updateConfig(root, (c) => { c.extra_field = undefined; }));
            const eCfg2 = await errOf(() => S.updateConfig(root, (c) => ({ integration_branch: null, integration_workspace: null, mode: 'normal', extra: NaN })));
            must(eCfg && eCfg.code === 'STATE_INVALID_PATCH' && eCfg2 && eCfg2.code === 'STATE_INVALID_PATCH' && sameBytes(bytes(root), before), 'updateConfig：未知字段为 undefined / 为 NaN 同样拒绝，字节不变', jstr([eCfg && eCfg.code, eCfg2 && eCfg2.code]));
            const inits = [['init 值为 undefined', { module: undefined }], ['init 数组含 undefined', { surface: ['x', undefined] }], ['init 含 NaN', { surface: [NaN] }], ['init 含函数', { module: () => 1 }], ['init 的 deps_mode 为 undefined', { deps_mode: undefined }]];
            for (const [label, init] of inits) {
                const e = await errOf(() => S.createLine(root, 'beta', init));
                must(e && e.code === 'STATE_BAD_ARGS' && sameBytes(bytes(root), before), `createLine ${label}：STATE_BAD_ARGS，登记表字节不变`, jstr(e && { c: e.code, m: e.message }));
            }
            // 对照：合法的纯数据全部通过（含 null 原型对象、嵌套数组、中文、布尔、null）
            const good = Object.assign(Object.create(null), { n: 1, list: [1, 'a', null, true, { k: '中文' }], s: '中文 text', z: null, t: false });
            const okRec = await S.updateLine(root, 'alpha', (r) => { r.yield_request = good; });
            must(eq(okRec.yield_request, { n: 1, list: [1, 'a', null, true, { k: '中文' }], s: '中文 text', z: null, t: false }), '对照：null 原型对象 / 嵌套数组 / 中文 / 布尔 / null 的纯数据全部通过校验并原样落盘', canon(okRec.yield_request));
            const okInit = await S.createLine(root, 'gamma', { surface: ['s1', 's2'], module: 'ok' });
            must(okInit.module === 'ok' && eq(okInit.surface, ['s1', 's2']), '对照：合法 init 仍可建线');
        });

        await sec('14f 排队时间计入超时：第二个调用按自己的上限报 STATE_LOCK_TIMEOUT，队列顺序不破坏', async () => {
            const root = ctl('impl-queue');
            await S.createLine(root, 'alpha', {}, at(T0));
            // A 在 COMMIT 阶段等显式释放信号（阶段信号，不靠固定睡眠）：确认 B 超时且 B 的补丁没执行之后才释放 A
            let releaseA;
            const aGate = new Promise((res) => { releaseA = res; });
            let aAtCommit;
            const aReachedCommit = new Promise((res) => { aAtCommit = res; });
            let held = false;
            const seen = [];   // 每次取锁前钩子：{ remaining: 传给 sqlite busyTimeout 的剩余预算, at: 钩子触发时刻 }；B 在进程内队列里就超时，不会到这一步，所以依次是 A、C
            SET_HOOKS({
                beforeBegin: (m) => { seen.push({ remaining: m, at: Date.now() }); },
                dbRun: (db, sql, real) => {
                    if (sql === 'COMMIT' && !held) { held = true; aAtCommit(); return aGate.then(() => real(db, sql)); }
                    return real(db, sql);
                },
            });
            // 三个调用的引用放在 try 之外：创建时立刻把成功 / 失败都转成普通结果对象（提前拒绝没有未处理的窗口），finally 先释放 A、再等已发起的调用结算、最后复位钩子
            let pA = null;
            let pB = null;
            let pC = null;
            const toResult = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
            try {
                const log = [];
                const budgetA = sc(20000);
                const budgetC = sc(20000);
                const tA0 = Date.now();
                pA = toResult(S.updateConfig(root, (c) => { log.push('A-patch'); c.integration_branch = 'A'; }, Object.assign({ lockTimeoutMs: budgetA }, at(T1))).then((v) => { log.push('A-done'); return v; }));
                const reachedCommit = await Promise.race([aReachedCommit.then(() => true), sleepAsync(sc(30000)).then(() => false)]);
                must(reachedCommit, 'A 已持锁并停在 COMMIT 阶段（阶段信号）');
                if (!reachedCommit) return;
                const t0 = Date.now();
                pB = S.updateConfig(root, (c) => { log.push('B-patch'); c.mode = 'drill'; }, { lockTimeoutMs: 1000 }).then(() => ({ ok: true, ms: Date.now() - t0 }), (e) => ({ ok: false, e, ms: Date.now() - t0 }));
                const tC0 = Date.now();
                pC = toResult(S.updateConfig(root, (c) => { log.push('C-patch'); c.integration_workspace = 'C'; }, Object.assign({ lockTimeoutMs: budgetC }, at(T2))).then((v) => { log.push('C-done'); return v; }));
                const rB = await Promise.race([pB, sleepAsync(sc(20000)).then(() => ({ ok: false, e: { code: 'TEST_B_STILL_WAITING' }, ms: -1 }))]);
                const logAtB = log.slice();
                releaseA();
                const [rA, rC] = await Promise.all([pA, pC]);
                resetHooks();
                must(!rB.ok && rB.e && rB.e.code === 'STATE_LOCK_TIMEOUT', '排在 A 后面、上限 1000ms 的 B：A 仍持锁时按自己的上限报 STATE_LOCK_TIMEOUT（没有等到 A 结束再重新计时）', jstr({ ok: rB.ok, code: rB.e && rB.e.code, ms: rB.ms }));
                must(rB.ms >= 900 && jstr(logAtB) === jstr(['A-patch']), 'B 超时当时：A 还没完成（日志只有 A-patch），B 的补丁没有执行；B 至少等了自己上限的 90%（下界；不断言上界）', jstr({ ms: rB.ms, logAtB }));
                must(rA.ok && rC.ok && jstr(log) === jstr(['A-patch', 'A-done', 'C-patch', 'C-done']), 'B 的补丁从未执行；C 在 A 完成之后才执行（队列顺序未被排队超时者破坏）', jstr({ log, rA: rA.ok, rC: rC.ok }));
                // 剩余预算：每个调用用自己的已耗时间核对（发起时刻 → 它自己的取锁前钩子触发时刻），不拿 A 的采样当 C 的基准：
                //   剩余 = 自己的总预算 − 自己已经过去的时间（含进程内排队）。钩子与模块取时间在同一同步段，容差 150ms 只吸收时钟抖动。
                const elapsedA = seen.length >= 1 ? seen[0].at - tA0 : NaN;
                const elapsedC = seen.length >= 2 ? seen[1].at - tC0 : NaN;
                must(seen.length === 2 && Math.abs(seen[0].remaining - (budgetA - elapsedA)) <= 150, '传给 sqlite busyTimeout 的是剩余预算（A）：= A 自己的总预算 − A 自己发起到取锁前钩子的已耗时间（±150ms）', jstr({ seen, budgetA, elapsedA }));
                must(seen.length === 2 && elapsedC >= 900 && Math.abs(seen[1].remaining - (budgetC - elapsedC)) <= 150, '传给 sqlite busyTimeout 的是剩余预算（C）：C 在 B 的 1000ms 上限内一直排队（自己已耗 ≥ 900ms），剩余 = C 自己的总预算 − C 自己的已耗时间（±150ms）；排队时间计入预算', jstr({ seen, budgetC, elapsedC }));
                const st = await S.readState(root);
                must(eq(st.config, CFG({ integration_branch: 'A', integration_workspace: 'C' })), '最终 config：A 与 C 的修改都在，B 的 mode = drill 没落盘', canon(st.config));
            } finally {
                releaseA();                                                  // 1 先释放 A
                const started = [pA, pB, pC].filter(Boolean);
                await Promise.race([Promise.all(started), sleepAsync(sc(30000))]);   // 2 再等已发起的调用结算（都已转成结果对象，不会抛）
                resetHooks();                                                // 3 最后复位钩子
            }
        });

        await sec('14g createLine 的 guard(others)：锁内同步执行；抛错即放弃写入；others 是只读深拷贝', async () => {
            const root = ctl('impl-guard');
            await S.createLine(root, 'a', { module: 'm1', surface: ['x'] }, at(T0));
            await S.createLine(root, 'b', { module: 'm2' }, at(T0));
            await S.createLine(root, 'c', { module: 'm3' }, at(T0));
            await S.updateLine(root, 'b', (r) => { r.lifecycle = 'failed'; r.failed_step = 'start'; }, at(T1));
            await S.updateLine(root, 'c', (r) => { r.lifecycle = 'ready'; }, at(T1));
            await S.updateLine(root, 'c', (r) => { r.lifecycle = 'removing'; }, at(T2));
            await S.removeLineRecord(root, 'c', at(T3));   // c 进 history，槽位 3 空出
            const before = bytes(root);
            let seenOthers = null;
            const sqlLog = [];
            SET_HOOKS({ dbRun: (db, sql, real) => { sqlLog.push(sql); return real(db, sql); } });
            const boom = new Error('同模块已有线');
            let sqlAtGuard = null;
            const r1 = await caught(() => S.createLine(root, 'd', { module: 'm1' }, { guard: (others) => { seenOthers = others; sqlAtGuard = sqlLog.slice(); if (others.some((o) => o.module === 'm1')) throw boom; } }));
            resetHooks();
            must(r1.threw && r1.value === boom && sameBytes(bytes(root), before), '同模块存在时 guard 抛错：原样抛出，登记表字节不变', jstr(r1.threw));
            must(eq(seenOthers, [
                { name: 'a', module: 'm1', surface: ['x'], lifecycle: 'creating' },
                { name: 'b', module: 'm2', surface: null, lifecycle: 'failed' },
            ]), 'guard 收到其他未 removed 线（含 failed、不含 history 里的 removed），每项只有 name / module / surface / lifecycle 四个字段', canon(seenOthers));
            must(jstr(sqlAtGuard) === jstr(['BEGIN EXCLUSIVE']), 'guard 在锁内执行：此时已 BEGIN EXCLUSIVE、尚未 COMMIT', jstr(sqlAtGuard));
            const noSlotTaken = await S.createLine(root, 'e', { module: 'm9' }, Object.assign({ guard: (others) => { others[0].module = 'HACKED'; others[0].surface[0] = 'HACKED-ELEM'; others[0].surface.push('PUSHED'); others.push({ name: 'fake' }); } }, at(T4)));
            const stE = await S.readState(root);
            must(noSlotTaken.slot === 3 && stE.lines.a.module === 'm1' && !stE.lines.fake, 'guard 抛错没有占槽（下一条线仍得到槽位 3）；guard 里改 others 不影响登记表（深拷贝）', jstr({ slot: noSlotTaken.slot, a: stE.lines.a.module }));
            must(eq(stE.lines.a.surface, ['x']), '成功建线的 guard 里改 others[0].surface 的数组元素并 push：落盘后原线路 surface 仍全等 ["x"]（嵌套数组也是深拷贝，不是共享引用）', canon(stE.lines.a.surface));
            const bf = bytes(root);
            const eNotFn = await errOf(() => S.createLine(root, 'f', {}, { guard: 'nope' }));
            const eAsync = await errOf(() => S.createLine(root, 'f', {}, { guard: async () => {} }));
            let guardThenCalls = 0;
            const eThenable = await errOf(() => S.createLine(root, 'f', {}, { guard: () => ({ then() { guardThenCalls++; } }) }));
            await sleepAsync(10);
            await new Promise((r) => setImmediate(r));
            await new Promise((r) => setImmediate(r));
            must(eNotFn && eNotFn.code === 'STATE_BAD_ARGS' && eAsync && eAsync.code === 'STATE_PATCH_ASYNC' && eThenable && eThenable.code === 'STATE_PATCH_ASYNC' && sameBytes(bytes(root), bf), 'guard 不是函数：STATE_BAD_ARGS；async / 返回 thenable：STATE_PATCH_ASYNC；字节均未变', jstr([eNotFn && eNotFn.code, eAsync && eAsync.code, eThenable && eThenable.code]));
            must(guardThenCalls === 0, '返回带调用计数的 thenable：STATE_PATCH_ASYNC，且若干个事件循环轮次之后 then 仍从未被调用（普通 thenable 不被吸收）', `then 被调用 ${guardThenCalls} 次`);
        });

        await sec('14h 时间戳在锁内取：排队等待不会让后写者的 updated_at 早于前一个写者的写入', async () => {
            const root = ctl('impl-now');
            await S.createLine(root, 'alpha', {}, at(T0));
            const log = [];
            const pA = S.updateConfig(root, (c) => { log.push('A-patch'); c.integration_branch = 'A'; }, { now: () => { log.push('A-now'); return new Date(T1); } }).then((v) => { log.push('A-done'); return v; });
            const pB = S.updateConfig(root, (c) => { log.push('B-patch'); c.mode = 'drill'; }, { now: () => { log.push('B-now'); return new Date(T2); } }).then((v) => { log.push('B-done'); return v; });
            await Promise.all([pA, pB]);
            must(jstr(log) === jstr(['A-now', 'A-patch', 'A-done', 'B-now', 'B-patch', 'B-done']), 'opts.now 在持锁之后才调用：B 排队期间没有取时间，A 完成之后 B 才取', jstr(log));
        });

        // ======================= 修复批 2 的实现项 =======================
        await sec('14i 回滚与关闭都失败：保留连接引用，控制根标记为「锁状态不确定」，之后的调用立即报 STATE_LOCK_UNCERTAIN', async () => {
            const root = ctl('impl-uncertain');
            const other = ctl('impl-uncertain-other');
            await S.createLine(root, 'alpha', {}, at(T0));
            await S.createLine(other, 'alpha', {}, at(T0));
            let leaked = null;   // 注入的「关闭失败」没有真的关：连接仍开着、仍持有 BEGIN EXCLUSIVE 的事务锁；测试末尾用真正的 close 释放
            try {
                SET_HOOKS({
                    dbRun: (db, sql, real) => (sql === 'ROLLBACK' ? Promise.reject(new Error('inject rollback')) : real(db, sql)),
                    dbClose: (db, real) => { leaked = { db, real }; return Promise.reject(new Error('inject close (connection stays open)')); },
                });
                const boom = new Error('business boom (uncertain)');
                const r1 = await caught(() => S.updateLine(root, 'alpha', () => { throw boom; }));
                resetHooks();
                must(r1.threw && r1.value === boom && boom.lockUncertain === true && Array.isArray(boom.cleanupErrors) && boom.cleanupErrors.length === 2 && !!leaked,
                    '业务异常 + ROLLBACK 失败 + 关闭失败：原异常原样抛出，带 lockUncertain 标记与两条 cleanupErrors，连接引用被保留', jstr({ same: r1.value === boom, u: boom.lockUncertain }));
                const sqlLog = [];
                SET_HOOKS({ dbRun: (db, sql, real) => { sqlLog.push(sql); return real(db, sql); } });
                const explicit = { lockTimeoutMs: 1500 };   // 显式给短上限：没有标记时只是 STATE_LOCK_TIMEOUT，不会拖慢整套
                const errs = [
                    await errOf(() => S.updateConfig(root, (c) => { c.mode = 'drill'; }, explicit)),
                    await errOf(() => S.readState(root, explicit)),
                    await errOf(() => S.createLine(root, 'beta', {}, explicit)),
                    await errOf(() => S.updateLine(root, 'alpha', (r) => { r.module = 'x'; }, explicit)),
                    await errOf(() => S.removeLineRecord(root, 'alpha', explicit)),
                ];
                resetHooks();
                must(errs.every((e) => e && e.code === 'STATE_LOCK_UNCERTAIN' && /重启/.test(e.message)) && sqlLog.length === 0,
                    '之后本进程对同一控制根的五个入口都立即报 STATE_LOCK_UNCERTAIN（消息提示重启进程），没有再尝试取锁（锁库 SQL 序列为空）', jstr({ codes: errs.map((e) => e && e.code), sqlLog }));
                const otherOk = await S.updateConfig(other, (c) => { c.mode = 'drill'; });
                must(otherOk.mode === 'drill', '别的控制根不受影响，照常读写');
            } finally {
                resetHooks();
                if (leaked) { try { await leaked.real(leaked.db); } catch (_) { /* 进程退出时由系统释放 */ } }
            }
        });

        await sec('14j stateWritten 只反映真实写入（STATE_LOCK_UNCERTAIN 成功路径）；收尾警告文字按是否写入区分', async () => {
            // 业务成功但 COMMIT / ROLLBACK / close 都失败 -> STATE_LOCK_UNCERTAIN（带 stateWritten）。三个入口各用独立控制根（每个都会被标记为不确定）。
            const leaks = [];
            try {
                const cases = [
                    ['readState', 'impl-written-read', (root) => S.readState(root), false],
                    ['无变化补丁', 'impl-written-noop', (root) => S.updateConfig(root, () => {}), false],
                    ['真实写入', 'impl-written-write', (root) => S.updateConfig(root, (c) => { c.mode = 'drill'; }), true],
                ];
                for (const [label, rootName, run, expectWritten] of cases) {
                    const root = ctl(rootName);
                    await S.createLine(root, 'alpha', {}, at(T0));
                    SET_HOOKS({
                        dbRun: (db, sql, real) => ((sql === 'COMMIT' || sql === 'ROLLBACK') ? Promise.reject(new Error(`inject ${sql.toLowerCase()}`)) : real(db, sql)),
                        dbClose: (db, real) => { leaks.push({ db, real }); return Promise.reject(new Error('inject close (connection stays open)')); },
                    });
                    const err = await errOf(() => run(root));
                    resetHooks();
                    must(err && err.code === 'STATE_LOCK_UNCERTAIN' && err.lockUncertain === true && err.stateWritten === expectWritten && (expectWritten ? /登记表已写入/ : /本次没有写登记表/).test(err.message),
                        `${label} 在 COMMIT / ROLLBACK / 关闭都失败的注入下：STATE_LOCK_UNCERTAIN，stateWritten === ${expectWritten}，消息${expectWritten ? '写「登记表已写入」' : '写「本次没有写登记表」'}`, jstr(err && { c: err.code, w: err.stateWritten, m: err.message }));
                }
            } finally {
                resetHooks();
                for (const l of leaks) { try { await l.real(l.db); } catch (_) { /* 进程退出时由系统释放 */ } }
            }
            // 事务已结束（COMMIT 失败但 ROLLBACK 成功）：成功返回，警告写明是否真写入
            const root = ctl('impl-written-warn');
            await S.createLine(root, 'alpha', {}, at(T0));
            SET_HOOKS({ dbRun: (db, sql, real) => (sql === 'COMMIT' ? Promise.reject(new Error('inject commit')) : real(db, sql)) });
            const wNoop = await withWarnings(() => caught(() => S.updateConfig(root, () => {})));   // 无变化：不写盘
            const wWrite = await withWarnings(() => caught(() => S.updateConfig(root, (c) => { c.integration_branch = 'w'; })));   // 真写入
            resetHooks();
            must(!wNoop.v.threw && !wWrite.v.threw && wNoop.ws.length === 1 && wWrite.ws.length === 1 && /本次没有写登记表/.test(wNoop.ws[0]) && /登记表已写入/.test(wWrite.ws[0]), 'COMMIT 失败（ROLLBACK 成功）的警告文字：无变化路径写「本次没有写登记表」，真写入路径写「登记表已写入」，都按成功返回', jstr({ n: wNoop.ws, w: wWrite.ws }));
            SET_HOOKS({ dbClose: (db, real) => real(db).then(() => { throw new Error('inject close'); }) });
            const wRead = await withWarnings(() => caught(() => S.readState(root)));
            resetHooks();
            must(!wRead.v.threw && wRead.ws.length === 1 && /^StateLockCleanupWarning:.*本次没有写登记表.*关闭连接失败/.test(wRead.ws[0]), 'readState 遇到关闭失败（事务已结束）：按成功返回，警告写「本次没有写登记表」（读路径不再谎称已写入）', jstr(wRead.ws));
        });

        await sec('14k createLine 的 init 在等锁之前快照：发起后立刻改原对象，落盘内容仍是原值', async () => {
            const root = ctl('impl-snapshot');
            const init = { module: 'm-snap', surface: ['x'], branch: 'feat/snap' };
            const p = S.createLine(root, 'snap', init, at(T0)).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
            init.module = NaN;            // 序列化会变成合法的 null
            init.surface.push(undefined); // 嵌套数组里加 undefined
            init.extra = undefined;       // 值为 undefined 的未知字段会被 JSON 往返丢掉
            init.deps_mode = undefined;
            init.branch = () => 1;
            const res = await p;
            const st = await S.readState(root);
            must(res.ok && eq(st, TABLE(CFG(), { snap: REC('snap', 1, { module: 'm-snap', surface: ['x'], branch: 'feat/snap' }) })), '发起 createLine 后立刻把 init 改成 NaN / 加 undefined 字段 / 嵌套数组 push：落盘整表仍是调用时的原值', jstr({ ok: res.ok, err: !res.ok && res.e && res.e.message, st: canon(st) }));
        });

        await sec('14l 其他执行上下文创建的 Promise（vm）：STATE_PATCH_ASYNC 且不留未处理拒绝', async () => {
            const root = ctl('impl-foreign');
            await S.createLine(root, 'alpha', {}, at(T0));
            const mk = () => vm.runInNewContext('Promise.reject(new Error("foreign-reject"))');
            const probe = mk();
            probe.catch(() => {});
            must(!(probe instanceof Promise) && require('util').types.isPromise(probe), '前提：vm 里造的 Promise 不是本上下文 Promise 的实例（instanceof 为 false），但 util.types.isPromise 为 true');
            const before = bytes(root);
            const seen = [];
            const onRej = (reason) => { seen.push(reason && reason.message ? reason.message : String(reason)); };
            process.on('unhandledRejection', onRej);
            try {
                const e1 = await errOf(() => S.updateLine(root, 'alpha', () => mk()));
                const e2 = await errOf(() => S.updateConfig(root, () => mk()));
                const e3 = await errOf(() => S.createLine(root, 'beta', {}, { guard: () => mk() }));
                await sleepAsync(250);   // 缺失型断言：等一个窗口
                must([e1, e2, e3].every((e) => e && e.code === 'STATE_PATCH_ASYNC') && sameBytes(bytes(root), before), '补丁（线 / 配置）与 guard 返回跨上下文的拒绝 Promise：STATE_PATCH_ASYNC，登记表字节不变', jstr([e1, e2, e3].map((e) => e && e.code)));
                must(seen.length === 0, 'unhandledRejection 监听到 0 次（跨上下文 Promise 的拒绝也已处理）', jstr(seen));
            } finally { process.removeListener('unhandledRejection', onRej); }
        });

        await sec('14m 写入前置步骤失败（创建临时文件 openSync 失败）也统一报 STATE_WRITE_FAILED，底层错误作 cause', async () => {
            const root = ctl('impl-open');
            await S.createLine(root, 'alpha', {}, at(T0));
            const before = bytes(root);
            SET_HOOKS({ openSync: () => { const e = new Error('ENOSPC simulated'); e.code = 'ENOSPC'; throw e; } });
            const e = await errOf(() => S.updateLine(root, 'alpha', (r) => { r.module = 'x'; }));
            resetHooks();
            must(e && e.code === 'STATE_WRITE_FAILED' && e.cause && e.cause.code === 'ENOSPC' && sameBytes(bytes(root), before) && tmpLeft(root).length === 0, 'openSync 报 ENOSPC：STATE_WRITE_FAILED（不泄露底层错误码），cause.code = ENOSPC，登记表字节不变，无临时文件', jstr(e && { c: e.code, cause: e.cause && e.cause.code, tmp: tmpLeft(root) }));
            const okAfter = await S.updateLine(root, 'alpha', (r) => { r.module = 'after-open-fail'; }, { lockTimeoutMs: sc(20000) });
            must(okAfter.module === 'after-open-fail', '失败之后锁已释放，下一次写成功');
        });

        // ======================= 2c 线级操作锁与记录代次 =======================
        await sec('15 线级操作锁 withLineLock：跨进程互斥、不同线并行、持有者被强杀后释放、超时 STATE_LINE_BUSY、重入 / 锁顺序报错', async () => {
            const root = ctl('linelock');
            fs.mkdirSync(root, { recursive: true });
            const WL = (name, fn, opts) => within(S.withLineLock(root, name, fn, opts), sc(60000), `withLineLock(${name})`);
            await S.createLine(root, 'alpha', {}, at(T0));
            // ---- 跨进程互斥：子进程 A 持有 alpha 线级锁（跨 await），父进程与子进程 B 都进不去
            const marker = path.join(root, 'line-held.marker');
            const release = path.join(root, 'line-release.signal');
            const waitingFile = path.join(root, 'b-waiting.marker');
            const enteredFile = path.join(root, 'b-entered.marker');
            const holder = startWorker({ role: 'line-hold', controlRoot: root, name: 'alpha', marker, release, timeoutMs: 30000 });
            let wB = null;
            let released = false;
            const doRelease = () => { if (!released) { released = true; try { fs.writeFileSync(release, 'go'); } catch (_) { /* ignore */ } } };
            try {
                must(await waitForFile(marker, 30000, holder), '子进程 A 取到 alpha 的线级锁并跨 await 持有（标记文件已写出）');
                let ran = false;
                const e1 = await errOf(() => WL('alpha', async () => { ran = true; }, { lockTimeoutMs: 600 }));
                const e1b = await errOf(() => WL('ALPHA', async () => { ran = true; }, { lockTimeoutMs: 600 }));
                must(e1 && e1.code === 'STATE_LINE_BUSY' && e1b && e1b.code === 'STATE_LINE_BUSY' && !ran, 'A 持锁期间父进程取 alpha（含大小写变体 ALPHA）：上限 600ms 内取不到，报 STATE_LINE_BUSY，asyncFn 没有执行', jstr([e1 && e1.code, e1b && e1b.code, ran]));
                let ranBeta = false;
                await WL('beta', async () => { ranBeta = true; }, { lockTimeoutMs: sc(20000) });
                const createdWhileHeld = await S.createLine(root, 'beta', {}, at(T1));
                must(ranBeta && createdWhileHeld.name === 'beta', '不同线并行：A 持有 alpha 时 beta 的线级锁照常取到；状态锁（createLine）也不受线级锁阻塞');
                wB = startWorker({ role: 'line-try', controlRoot: root, name: 'alpha', waitingFile, enteredFile, timeoutMs: 30000 });
                must(await waitForFile(waitingFile, 30000, wB), '子进程 B 开始取 alpha 的线级锁（等待中标记已写出）');
                await sleepAsync(300);   // 缺失型断言：给 B 一个"本该进来却没进来"的观察窗口
                must(!fs.existsSync(enteredFile), 'A 持锁期间 B 没有进入临界区（两进程同线串行）');
                doRelease();
                const bx = await wB.exited;
                const ax = await holder.exited;
                must(exitedOk(bx) && fs.existsSync(enteredFile) && exitedOk(ax), 'A 释放后 B 取到锁并进入临界区，两个子进程都正常结束', jstr({ b: exitInfo(bx), a: exitInfo(ax) }));
            } finally {
                doRelease();
                if (wB) { await Promise.race([wB.exited, sleepAsync(sc(30000))]); if (!wB.done) wB.kill(); }
                await Promise.race([holder.exited, sleepAsync(sc(30000))]);
                if (!holder.done) holder.kill();
                await Promise.race([Promise.all([holder.closedP, wB ? wB.closedP : Promise.resolve()]), sleepAsync(sc(15000))]);
            }
            // ---- 持有者被强杀：线级锁由系统释放
            const marker2 = path.join(root, 'line-held2.marker');
            const holder2 = startWorker({ role: 'line-hold', controlRoot: root, name: 'gamma', marker: marker2, release: path.join(root, 'never.signal'), forever: true, timeoutMs: 30000 });
            try {
                must(await waitForFile(marker2, 30000, holder2), '子进程持有 gamma 的线级锁并挂住');
                holder2.kill();
                const hx2 = await holder2.exited;
                let ranG = false;
                await WL('gamma', async () => { ranG = true; }, { lockTimeoutMs: sc(20000) });
                must(!hx2.timedOut && ranG, '持有者被强杀（taskkill /F /PID）后：线级锁由系统释放，另一进程在宽松预算内取到并执行', exitInfo(hx2));
            } finally {
                if (!holder2.done) holder2.kill();
                await Promise.race([holder2.closedP, sleepAsync(sc(15000))]);
            }
            // ---- 同进程：重入报错、不同线可嵌套、别的调用链 FIFO 排队
            const eRe = await errOf(() => WL('delta', async () => { await S.withLineLock(root, 'DELTA', async () => {}, { lockTimeoutMs: 500 }); }, { lockTimeoutMs: sc(20000) }));
            must(eRe && eRe.code === 'STATE_LINE_REENTRANT', '同一调用链内对同一线重入（含大小写变体）：STATE_LINE_REENTRANT', jstr(eRe && eRe.code));
            let nested = false;
            await WL('delta', async () => { await S.withLineLock(root, 'epsilon', async () => { nested = true; }, { lockTimeoutMs: sc(20000) }); }, { lockTimeoutMs: sc(20000) });
            must(nested, '不同线可以嵌套持有');
            const order = [];
            const p1 = WL('zeta', async () => { order.push('1-in'); await sleepAsync(100); order.push('1-out'); }, { lockTimeoutMs: sc(20000) });
            const p2 = WL('zeta', async () => { order.push('2-in'); order.push('2-out'); }, { lockTimeoutMs: sc(20000) });
            await Promise.all([p1, p2]);
            must(jstr(order) === jstr(['1-in', '1-out', '2-in', '2-out']), '同进程里别的调用链对同一线 FIFO 排队：第二个在第一个完成之后才进入', jstr(order));
            const eq2 = await errOf(() => WL('theta', async () => { throw new Error('op failed'); }, { lockTimeoutMs: sc(20000) }));
            let afterThrow = false;
            await WL('theta', async () => { afterThrow = true; }, { lockTimeoutMs: sc(20000) });
            must(eq2 && eq2.message === 'op failed' && afterThrow, 'asyncFn 抛错：原错误原样抛出，锁已释放（下一次取锁成功）');
            const ret = await WL('iota', async () => 42, { lockTimeoutMs: sc(20000) });
            must(ret === 42, '返回 asyncFn 的返回值');
            // ---- 线级锁里可以调用状态读写入口（锁顺序 线级锁 → 状态锁）
            const inner = await WL('alpha', async () => S.updateLine(root, 'alpha', (r) => { r.module = 'inside-line-lock'; }), { lockTimeoutMs: sc(20000) });
            must(inner.module === 'inside-line-lock', '线级锁内可以调用 updateLine（锁顺序 线级锁 → 状态锁）');
            // ---- 持状态锁的同步段里不得等线级锁
            // 锁顺序违规同步抛出：补丁里误调用时补丁本身抛错 -> ROLLBACK、不写盘；调用方拿到 STATE_LOCK_ORDER；不留未处理的被拒绝 Promise
            const unhandled = [];
            const onUnhandled = (reason) => { unhandled.push(reason && reason.code ? reason.code : String(reason)); };
            process.on('unhandledRejection', onUnhandled);
            try {
                const bOrder = bytes(root);
                let lockRan = 0;
                const eOrder = await errOf(() => S.updateLine(root, 'alpha', (r) => { r.branch = 'order-test'; S.withLineLock(root, 'kappa', async () => { lockRan++; }, { lockTimeoutMs: 500 }); }));
                const eOrderCfg = await errOf(() => S.updateConfig(root, (c) => { c.mode = 'drill'; S.withLineLock(root, 'kappa', async () => { lockRan++; }, { lockTimeoutMs: 500 }); }));
                const eOrderGuard = await errOf(() => S.createLine(root, 'newone', {}, { guard: () => { S.withLineLock(root, 'kappa', async () => { lockRan++; }, { lockTimeoutMs: 500 }); } }));
                await sleepAsync(250);   // 缺失型断言：等一个窗口，看有没有未处理拒绝
                must([eOrder, eOrderCfg, eOrderGuard].every((e) => e && e.code === 'STATE_LOCK_ORDER') && sameBytes(bytes(root), bOrder) && lockRan === 0 && unhandled.length === 0,
                    '在持有状态锁的同步段（updateLine 补丁 / updateConfig 补丁 / createLine 的 guard）里调用 withLineLock：调用方拿到 STATE_LOCK_ORDER（同步抛出使补丁本身抛错），登记表字节不变，asyncFn 未执行，没有未处理的被拒绝 Promise', jstr({ codes: [eOrder, eOrderCfg, eOrderGuard].map((e) => e && e.code), lockRan, unhandled }));
            } finally { process.removeListener('unhandledRejection', onUnhandled); }
            // ---- 参数
            const eBadName = await errOf(() => S.withLineLock(root, 'MAIN', async () => {}));
            const eBadFn = await errOf(() => S.withLineLock(root, 'alpha', 'nope'));
            must(eBadName && eBadName.code === 'STATE_BAD_NAME' && eBadFn && eBadFn.code === 'STATE_BAD_ARGS', '线名不合法：STATE_BAD_NAME；asyncFn 不是函数：STATE_BAD_ARGS', jstr([eBadName && eBadName.code, eBadFn && eBadFn.code]));
        });

        await sec('15b 记录代次 generation：UUID、唯一、不可改、expectGeneration 不符拒绝且字节不变、同名重建换新、history 保留旧代次', async () => {
            const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
            const root = ctl('generation');
            const a1 = await S.createLine(root, 'alpha', { module: 'm0' }, at(T0));
            const b1 = await S.createLine(root, 'beta', {}, at(T0));
            must(UUID.test(a1.generation) && UUID.test(b1.generation) && a1.generation !== b1.generation, 'createLine 返回的记录带 UUID 代次，不同线的代次不同', jstr([a1.generation, b1.generation]));
            must((await S.readState(root)).lines.alpha.generation === a1.generation, '代次落盘');
            const upd = await S.updateLine(root, 'alpha', (r) => { r.module = 'm1'; }, { expectGeneration: a1.generation });
            must(upd.module === 'm1' && upd.generation === a1.generation, 'expectGeneration 与当前代次相符：更新成功，代次不变');
            const bytesOk = bytes(root);
            const WRONG = '00000000-0000-4000-8000-000000000000';
            const eMis = await errOf(() => S.updateLine(root, 'alpha', (r) => { r.module = 'x'; }, { expectGeneration: WRONG }));
            must(eMis && eMis.code === 'STATE_GENERATION_MISMATCH' && sameBytes(bytes(root), bytesOk), 'expectGeneration 不符：STATE_GENERATION_MISMATCH，登记表字节不变', jstr(eMis && eMis.code));
            const eImm = await errOf(() => S.updateLine(root, 'alpha', (r) => { r.generation = WRONG; }));
            must(eImm && eImm.code === 'STATE_FIELD_IMMUTABLE' && sameBytes(bytes(root), bytesOk), '补丁改 generation：STATE_FIELD_IMMUTABLE，字节不变', jstr(eImm && eImm.code));
            const eNotStr = await errOf(() => S.updateLine(root, 'alpha', (r) => { r.module = 'y'; }, { expectGeneration: 123 }));
            must(eNotStr && eNotStr.code === 'STATE_BAD_ARGS' && sameBytes(bytes(root), bytesOk), 'expectGeneration 不是字符串：STATE_BAD_ARGS，字节不变');
            // 删 alpha：先走 ready → removing，removeLineRecord 的代次检查
            await S.updateLine(root, 'alpha', (r) => { r.lifecycle = 'ready'; }, { expectGeneration: a1.generation });
            await S.updateLine(root, 'alpha', (r) => { r.lifecycle = 'removing'; }, { expectGeneration: a1.generation });
            const bytesRm = bytes(root);
            const eRmMis = await errOf(() => S.removeLineRecord(root, 'alpha', { expectGeneration: WRONG }));
            must(eRmMis && eRmMis.code === 'STATE_GENERATION_MISMATCH' && sameBytes(bytes(root), bytesRm), 'removeLineRecord 的 expectGeneration 不符：STATE_GENERATION_MISMATCH，字节不变', jstr(eRmMis && eRmMis.code));
            const removed = await S.removeLineRecord(root, 'alpha', { expectGeneration: a1.generation });
            const st1 = await S.readState(root);
            must(removed.generation === a1.generation && st1.history.length === 1 && st1.history[0].generation === a1.generation, 'removeLineRecord 代次相符：成功，history 里保留旧代次', jstr(st1.history.map((h) => h.generation)));
            // 同名重建 = 新代次；旧操作拿旧代次动新线被挡下（S2b 的并发删线 / 重建场景）
            const a2 = await S.createLine(root, 'alpha', { module: 'new-alpha' });
            must(UUID.test(a2.generation) && a2.generation !== a1.generation, '同名重建得到新的代次');
            const bytesNew = bytes(root);
            const eStale = await errOf(() => S.updateLine(root, 'alpha', (r) => { r.module = 'stale-op'; }, { expectGeneration: a1.generation }));
            const eStaleRm = await errOf(() => S.removeLineRecord(root, 'alpha', { expectGeneration: a1.generation }));
            const st2 = await S.readState(root);
            must(eStale && eStale.code === 'STATE_GENERATION_MISMATCH' && eStaleRm && eStaleRm.code === 'STATE_GENERATION_MISMATCH' && sameBytes(bytes(root), bytesNew) && st2.lines.alpha.module === 'new-alpha' && st2.history[0].generation === a1.generation,
                '旧代次的 updateLine / removeLineRecord 对同名重建后的新线：STATE_GENERATION_MISMATCH，新线不受影响，history 仍是旧代次', jstr([eStale && eStale.code, eStaleRm && eStaleRm.code]));
        });

        // ======================= 修复批 3（收口批）=======================
        await sec('14n 锁状态不确定按控制根隔离：线级锁 / 状态锁任一收尾失败，该控制根的所有公开入口（含 readState 快捷分支、withLineLock）立即报 STATE_LOCK_UNCERTAIN', async () => {
            const leaks = [];   // 注入的「关闭失败」没有真的关：连接仍开着、仍持有 BEGIN EXCLUSIVE 的事务锁；节末用真正的 close 释放
            const failAll = () => SET_HOOKS({
                dbRun: (db, sql, real) => ((sql === 'COMMIT' || sql === 'ROLLBACK') ? Promise.reject(new Error(`inject ${sql.toLowerCase()}`)) : real(db, sql)),
                dbClose: (db, real) => { leaks.push({ db, real }); return Promise.reject(new Error('inject close (connection stays open)')); },
            });
            const isUnc = (e) => !!e && e.code === 'STATE_LOCK_UNCERTAIN' && /重启/.test(e.message);
            const explicit = { lockTimeoutMs: 1500 };   // 显式给短上限：没有标记时只会 STATE_LOCK_TIMEOUT / 读到空表，不会拖慢整套
            try {
                // ---- (a) 线级锁收尾失败 -> 整个控制根不确定；这个控制根上从未建过 state.lock，readState 走「锁文件不存在」的快捷分支
                const rootL = ctl('iso-line');
                failAll();
                const eL = await caught(() => S.withLineLock(rootL, 'alpha', async () => 'done', { lockTimeoutMs: sc(8000) }));
                resetHooks();
                must(eL.threw && eL.value && eL.value.code === 'STATE_LOCK_UNCERTAIN' && eL.value.lockUncertain === true && fs.existsSync(path.join(rootL, 'locks', 'line-alpha.lock')) && !fs.existsSync(path.join(rootL, 'locks', 'state.lock')),
                    '前提：线级锁（alpha）在 COMMIT / ROLLBACK / 关闭都失败的注入下报 STATE_LOCK_UNCERTAIN；这个控制根上没有 state.lock（readState 会走快捷分支）', jstr(eL.threw && eL.value && { c: eL.value.code, m: eL.value.message }));
                const sqlLog = [];
                let ran = 0;
                SET_HOOKS({ dbRun: (db, sql, real) => { sqlLog.push(sql); return real(db, sql); } });
                const spelled = [rootL, `${rootL.replace(/\\/g, '/')}/`].concat(process.platform === 'win32' ? [rootL.toLowerCase()] : []);
                const readErrs = [];
                for (const r of spelled) readErrs.push(await errOf(() => S.readState(r, explicit)));
                const errs = [
                    await errOf(() => S.updateConfig(rootL, (c) => { c.mode = 'drill'; }, explicit)),
                    await errOf(() => S.createLine(rootL, 'beta', {}, explicit)),
                    await errOf(() => S.updateLine(rootL, 'alpha', (r) => { r.module = 'x'; }, explicit)),
                    await errOf(() => S.removeLineRecord(rootL, 'alpha', explicit)),
                    await errOf(() => S.withLineLock(rootL, 'beta', async () => { ran++; }, explicit)),
                    await errOf(() => S.withLineLock(rootL, 'alpha', async () => { ran++; }, explicit)),
                ];
                resetHooks();
                must(readErrs.every(isUnc), `readState（含快捷分支；控制根的 ${spelled.length} 种写法：原样 / 正斜杠加尾斜杠${process.platform === 'win32' ? ' / 全小写' : ''}）：线级锁不确定之后立即 STATE_LOCK_UNCERTAIN，不是读到空表`, jstr(readErrs.map((e) => e && e.code)));
                must(errs.every(isUnc) && ran === 0 && sqlLog.length === 0, '线级锁不确定之后，同一控制根的 updateConfig / createLine / updateLine / removeLineRecord / 另一条线与同一条线的 withLineLock 都立即 STATE_LOCK_UNCERTAIN（asyncFn 没执行，锁库 SQL 序列为空）', jstr({ codes: errs.map((e) => e && e.code), ran, sqlLog }));

                // ---- (b) 状态锁收尾失败 -> withLineLock 也立即失败（不再进入 asyncFn 去做会因登记状态失败的外部操作）
                const rootS = ctl('iso-state');
                await S.createLine(rootS, 'alpha', {}, at(T0));
                failAll();
                const boom = new Error('boom iso-state');
                const eS = await caught(() => S.updateConfig(rootS, () => { throw boom; }, { lockTimeoutMs: sc(8000) }));
                resetHooks();
                let ran2 = 0;
                const sqlLog2 = [];
                SET_HOOKS({ dbRun: (db, sql, real) => { sqlLog2.push(sql); return real(db, sql); } });
                const eLL1 = await errOf(() => S.withLineLock(rootS, 'alpha', async () => { ran2++; }, explicit));
                const eLL2 = await errOf(() => S.withLineLock(rootS, 'zeta', async () => { ran2++; }, explicit));
                resetHooks();
                must(eS.threw && eS.value === boom && boom.lockUncertain === true && isUnc(eLL1) && isUnc(eLL2) && ran2 === 0 && sqlLog2.length === 0,
                    '状态锁不确定之后：withLineLock（同一条线 / 另一条线）立即 STATE_LOCK_UNCERTAIN，asyncFn 没执行，没有再尝试取锁', jstr({ same: eS.value === boom, c1: eLL1 && eLL1.code, c2: eLL2 && eLL2.code, ran2, sqlLog2 }));
                // 别的控制根不受影响
                const rootO = ctl('iso-other');
                const okL = await S.withLineLock(rootO, 'alpha', async () => 7, { lockTimeoutMs: sc(8000) });
                const okR = await S.updateConfig(rootO, (c) => { c.mode = 'drill'; });
                must(okL === 7 && okR.mode === 'drill', '别的控制根不受影响，线级锁与状态锁照常读写');
            } finally {
                resetHooks();
                for (const l of leaks) { try { await l.real(l.db); } catch (_) { /* 进程退出时由系统释放 */ } }
            }
        });

        await sec('14o 已入队的调用遇到前驱刚设的不确定标记：出队后复查，立即 STATE_LOCK_UNCERTAIN，补丁 / asyncFn 不执行，没有新增 BEGIN', async () => {
            const leaks = [];
            const toRes = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
            try {
                // ---- 状态锁：首个调用（补丁抛业务异常）的关闭失败钩子里设屏障；趁它尚未标记不确定时第二个调用入队
                {
                    const root = ctl('queued-uncertain-state');
                    await S.createLine(root, 'alpha', {}, at(T0));
                    let closeEntered;
                    const closeEnteredP = new Promise((res) => { closeEntered = res; });
                    let closeGate;
                    const closeGateP = new Promise((res) => { closeGate = res; });
                    const sqlLog = [];
                    SET_HOOKS({
                        dbRun: (db, sql, real) => { sqlLog.push(sql); return sql === 'ROLLBACK' ? Promise.reject(new Error('inject rollback')) : real(db, sql); },
                        dbClose: (db, real) => { leaks.push({ db, real }); closeEntered(); return closeGateP.then(() => { throw new Error('inject close (connection stays open)'); }); },
                    });
                    const boom = new Error('first call fails (state)');
                    let p1 = null;
                    let p2 = null;
                    let patch2 = 0;
                    try {
                        p1 = toRes(S.updateConfig(root, () => { throw boom; }, { lockTimeoutMs: sc(8000) }));
                        const entered = await Promise.race([closeEnteredP.then(() => true), sleepAsync(sc(20000)).then(() => false)]);
                        must(entered, '前提（状态锁）：首个调用已停在关闭连接钩子里，控制根此刻尚未被标记不确定');
                        p2 = toRes(S.updateConfig(root, (c) => { patch2++; c.mode = 'drill'; }, { lockTimeoutMs: sc(3000) }));   // 入口检查通过 -> 入队
                        closeGate();
                        const [r1, r2] = await Promise.all([p1, p2]);
                        const begins = sqlLog.filter((s) => s === 'BEGIN EXCLUSIVE').length;
                        must(!r1.ok && r1.e === boom && boom.lockUncertain === true, '首个调用：业务异常原样抛出，带 lockUncertain 标记');
                        must(!r2.ok && r2.e && r2.e.code === 'STATE_LOCK_UNCERTAIN' && patch2 === 0 && begins === 1, '已入队的第二个调用：出队后立即 STATE_LOCK_UNCERTAIN，补丁未执行，BEGIN EXCLUSIVE 总数仍为 1（没有去取锁）', jstr({ code: r2.e && r2.e.code, patch2, begins, sqlLog }));
                    } finally {
                        closeGate();
                        await Promise.race([Promise.all([p1, p2].filter(Boolean)), sleepAsync(sc(20000))]);
                        resetHooks();
                    }
                }
                // ---- 线级锁：同一机制
                {
                    const root = ctl('queued-uncertain-line');
                    let closeEntered;
                    const closeEnteredP = new Promise((res) => { closeEntered = res; });
                    let closeGate;
                    const closeGateP = new Promise((res) => { closeGate = res; });
                    const sqlLog = [];
                    SET_HOOKS({
                        dbRun: (db, sql, real) => { sqlLog.push(sql); return (sql === 'COMMIT' || sql === 'ROLLBACK') ? Promise.reject(new Error(`inject ${sql.toLowerCase()}`)) : real(db, sql); },
                        dbClose: (db, real) => { leaks.push({ db, real }); closeEntered(); return closeGateP.then(() => { throw new Error('inject close (connection stays open)'); }); },
                    });
                    const boom = new Error('first call fails (line)');
                    let p1 = null;
                    let p2 = null;
                    let ran2 = 0;
                    try {
                        p1 = toRes(S.withLineLock(root, 'alpha', async () => { throw boom; }, { lockTimeoutMs: sc(8000) }));
                        const entered = await Promise.race([closeEnteredP.then(() => true), sleepAsync(sc(20000)).then(() => false)]);
                        must(entered, '前提（线级锁）：首个调用已停在关闭连接钩子里，控制根此刻尚未被标记不确定');
                        p2 = toRes(S.withLineLock(root, 'alpha', async () => { ran2++; }, { lockTimeoutMs: sc(3000) }));
                        closeGate();
                        const [r1, r2] = await Promise.all([p1, p2]);
                        const begins = sqlLog.filter((s) => s === 'BEGIN EXCLUSIVE').length;
                        must(!r1.ok && r1.e === boom && boom.lockUncertain === true, '首个调用：业务异常原样抛出，带 lockUncertain 标记');
                        must(!r2.ok && r2.e && r2.e.code === 'STATE_LOCK_UNCERTAIN' && ran2 === 0 && begins === 1, '已入队的第二个线级锁调用：出队后立即 STATE_LOCK_UNCERTAIN，asyncFn 未执行，BEGIN EXCLUSIVE 总数仍为 1', jstr({ code: r2.e && r2.e.code, ran2, begins, sqlLog }));
                    } finally {
                        closeGate();
                        await Promise.race([Promise.all([p1, p2].filter(Boolean)), sleepAsync(sc(20000))]);
                        resetHooks();
                    }
                }
            } finally {
                resetHooks();
                for (const l of leaks) { try { await l.real(l.db); } catch (_) { /* 进程退出时由系统释放 */ } }
            }
        });

        await sec('15c 线级锁重入判定（修复批 3）：独立调用链排队不报重入；令牌随操作结束失效；嵌套共享祖先令牌；持有截止与时间系数', async () => {
            const root = ctl('linelock-als');
            fs.mkdirSync(root, { recursive: true });
            const LO = () => ({ lockTimeoutMs: sc(20000) });
            // withLineLock 的参数 / 锁顺序 / 重入检查是同步抛出：回调里调用时包一层，同步抛出也变成被拒绝的 Promise（否则误实现会让定时器里的同步抛错变成未捕获异常、弄死整个进程）
            const tryLock = (name, fn, o) => { try { return S.withLineLock(root, name, fn, o); } catch (e) { return Promise.reject(e); } };
            const WL = (name, fn, o) => within(tryLock(name, fn, o || LO()), sc(60000), `withLineLock(${name})`);
            const toRes = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
            // ---- (1) 第一个回调进入后发信号并等显式释放；父链收到信号后，从另一条独立调用链发起第二次取锁 -> 排队（不报重入），释放后按序进入
            {
                let enteredRes;
                const enteredP = new Promise((r) => { enteredRes = r; });
                let gateRes;
                const gateP = new Promise((r) => { gateRes = r; });
                const order = [];
                let p1 = null;
                let p2 = null;
                let p2Settled = false;
                try {
                    p1 = toRes(WL('eta', async () => { order.push('1-in'); enteredRes(); await gateP; order.push('1-out'); }));
                    const entered = await Promise.race([enteredP.then(() => true), sleepAsync(sc(20000)).then(() => false)]);
                    must(entered, '前提：第一个回调已进入线级锁并发出信号（它正持有 eta）');
                    // 这里是测试自己的调用链：不在第一个回调的异步上下文里
                    p2 = toRes(WL('eta', async () => { order.push('2-in'); order.push('2-out'); }));
                    p2.then(() => { p2Settled = true; });
                    await sleepAsync(200);
                    const stillQueued = !p2Settled;
                    const orderMid = order.slice();
                    gateRes();
                    const [r1, r2] = await Promise.all([p1, p2]);
                    must(stillQueued && jstr(orderMid) === jstr(['1-in']) && r1.ok && r2.ok && jstr(order) === jstr(['1-in', '1-out', '2-in', '2-out']),
                        '第一个回调持锁期间，独立调用链发起的第二次取锁：排队（不报 STATE_LINE_REENTRANT），第一个释放后才按序进入', jstr({ stillQueued, orderMid, order, r2: r2.ok || (r2.e && r2.e.code) }));
                } finally {
                    gateRes();
                    await Promise.race([Promise.all([p1, p2].filter(Boolean)), sleepAsync(sc(20000))]);
                }
            }
            // ---- (2) 令牌随操作结束失效：外层 asyncFn 已结束后才运行的延迟回调再取同线锁，不报重入
            {
                let deferred = null;
                let doneRes;
                const doneP = new Promise((r) => { doneRes = r; });
                await WL('lambda', async () => {
                    setTimeout(() => {
                        tryLock('lambda', async () => 'x', { lockTimeoutMs: sc(8000) }).then((v) => { deferred = { ok: true, v }; doneRes(); }, (e) => { deferred = { ok: false, code: e && e.code }; doneRes(); });
                    }, 100);
                });
                await Promise.race([doneP, sleepAsync(sc(20000))]);
                must(deferred && deferred.ok === true && deferred.v === 'x', '外层线级锁操作已退出之后才运行的延迟回调（继承了外层的异步上下文）再取同一条线的锁：成功，不报 STATE_LINE_REENTRANT（令牌已失效）', jstr(deferred));
            }
            // ---- (3) 嵌套上下文共享祖先令牌：嵌套内对外层线仍是重入；两层都退出后的延迟回调对两条线都不报重入
            {
                const seen = {};
                let deferred2 = null;
                let doneRes;
                const doneP = new Promise((r) => { doneRes = r; });
                await WL('mu', async () => {
                    await WL('nu', async () => {
                        const e1 = await errOf(() => tryLock('MU', async () => {}, { lockTimeoutMs: 500 }));
                        const e2 = await errOf(() => tryLock('nu', async () => {}, { lockTimeoutMs: 500 }));
                        seen.reMu = e1 && e1.code;
                        seen.reNu = e2 && e2.code;
                        setTimeout(() => {
                            Promise.all([
                                tryLock('mu', async () => 1, { lockTimeoutMs: sc(8000) }),
                                tryLock('nu', async () => 2, { lockTimeoutMs: sc(8000) }),
                            ]).then((v) => { deferred2 = { ok: true, v }; doneRes(); }, (e) => { deferred2 = { ok: false, code: e && e.code }; doneRes(); });
                        }, 150);
                    });
                });
                await Promise.race([doneP, sleepAsync(sc(20000))]);
                must(seen.reMu === 'STATE_LINE_REENTRANT' && seen.reNu === 'STATE_LINE_REENTRANT', '嵌套持有 mu → nu：嵌套内对外层线（含大小写变体 MU）与对自己的线都是重入（嵌套沿用祖先的活动令牌）', jstr(seen));
                must(deferred2 && deferred2.ok === true && jstr(deferred2.v) === jstr([1, 2]), '两层都退出之后才运行的延迟回调对 mu、nu 都能取到锁（两个令牌都已失效，没有复制出过期键）', jstr(deferred2));
            }
            // ---- (3b) 锁内建的各种异步源在锁释放之后触发，再取同一线必须成功（四种情形 + 对照组）；持锁期间触发的同链回调仍报重入；三项检查同步抛出
            {
                const labels = ['对照：锁外建的定时器', '锁内建的 setTimeout', '锁内建的未 await Promise 链', '锁内建的 EventEmitter（由锁内建的定时器触发）', '锁内起的子进程的 exit 回调'];
                const out = {};
                let remaining = labels.length;
                let allDoneRes;
                const allDone = new Promise((r) => { allDoneRes = r; });
                const tl = (label) => {
                    const fin = (code) => { out[label] = code; if (--remaining === 0) allDoneRes(); };
                    tryLock('omega', async () => 'ok', { lockTimeoutMs: sc(8000) }).then(() => fin('OK'), (e) => fin(e && e.code));
                };
                const outsideTimer = setTimeout(() => tl(labels[0]), 600);
                let child = null;
                try {
                    await WL('omega', async () => {
                        setTimeout(() => tl(labels[1]), 600);
                        sleepAsync(600).then(() => tl(labels[2]));
                        const ee = new EventEmitter();
                        ee.on('later', () => tl(labels[3]));
                        setTimeout(() => ee.emit('later'), 600);
                        child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)'], { stdio: 'ignore', windowsHide: true });
                        child.on('exit', () => tl(labels[4]));
                    });   // asyncFn 立刻返回：锁很快释放，上面这些回调都在锁释放之后才触发
                    await Promise.race([allDone, sleepAsync(sc(30000))]);
                    must(labels.every((l) => out[l] === 'OK'), '锁内建的 setTimeout / 未 await 的 Promise 链 / EventEmitter / 子进程 exit 回调，在锁释放之后取同一条线：全部成功（含锁外建定时器的对照组），不报 STATE_LINE_REENTRANT', jstr(out));
                } finally {
                    clearTimeout(outsideTimer);
                    if (child && child.exitCode === null && child.signalCode === null) { try { killHard(child.pid); } catch (_) { /* 已经退出 */ } }
                }
                // 持锁期间触发的同链回调仍然是重入
                const eIn = await errOf(() => WL('psi', async () => {
                    await new Promise((res, rej) => { setTimeout(() => { tryLock('psi', async () => {}, { lockTimeoutMs: 500 }).then(res, rej); }, 100); });
                }));
                must(eIn && eIn.code === 'STATE_LINE_REENTRANT', '持锁期间（asyncFn 还在 await）由锁内建的定时器触发的同链回调再取同一条线：仍报 STATE_LINE_REENTRANT', jstr(eIn && eIn.code));
                // 参数 / 锁顺序 / 重入三项检查同步抛出（withLineLock 不是 async 函数）
                let syncReentrant = null;
                await WL('chi', async () => { try { const r = S.withLineLock(root, 'CHI', async () => {}, { lockTimeoutMs: 500 }); syncReentrant = 'no-throw'; if (r && r.catch) r.catch(() => {}); } catch (e) { syncReentrant = e && e.code; } });
                const sync = {};
                for (const [k, f] of [['badName', () => S.withLineLock(root, 'MAIN', async () => {})], ['badFn', () => S.withLineLock(root, 'alpha', 'nope')]]) {
                    try { const r = f(); sync[k] = `no-throw:${typeof r}`; if (r && r.catch) r.catch(() => {}); } catch (e) { sync[k] = e && e.code; }
                }
                must(syncReentrant === 'STATE_LINE_REENTRANT' && sync.badName === 'STATE_BAD_NAME' && sync.badFn === 'STATE_BAD_ARGS', 'withLineLock 的重入 / 线名 / 参数三项检查同步抛出（调用表达式本身抛，不返回被拒绝的 Promise）', jstr({ syncReentrant, sync }));
            }
            // ---- (4) 持有截止经参数传入：显式小截止 -> 持有者按它自己的截止退出，不再是写死的 60 秒
            {
                const w = startWorker({ role: 'line-hold', controlRoot: root, name: 'capline', marker: path.join(root, 'cap.marker'), release: path.join(root, 'cap-never.signal'), capMs: 1500, timeoutMs: 20000 }, sc(30000));
                const wx = await w.exited;
                must(wx.closed && !wx.timedOut && wx.result && wx.result.ok === false && /等待超时/.test(wx.result.message || ''), 'line-hold 的持有截止来自参数（capMs = 1500ms）：没人释放时它按自己的截止退出，而不是写死 60 秒', exitInfo(wx));
            }
            // ---- (5) 协调 / 防卡死的截止随 --time-scale 放大后传进子进程
            {
                const w = startWorker({ role: 'echo', timeoutMs: 12345 });
                const x = await w.exited;
                must(exitedOk(x) && x.result.capMs === sc(60000) && x.result.timeoutMs === sc(12345), `子进程收到的持有截止 = sc(60000) = ${sc(60000)}、锁等待预算 = sc(12345) = ${sc(12345)}（--time-scale=${TS}）`, exitInfo(x));
            }
        });

        await sec('15d 线级锁收尾错误不吞（修复批 3）：业务异常 + 收尾失败 -> cleanupErrors 附着 / 警告；锁不确定时标记控制根并写明需重启；BEGIN 失败后的关闭错误附到取锁错误', async () => {
            const leaks = [];
            const WLr = (root, name, fn) => S.withLineLock(root, name, fn, { lockTimeoutMs: sc(8000) });
            const closeFailReal = (msg) => (db, real) => real(db).then(() => { throw new Error(msg); });   // 真关闭后报错：锁已释放
            const leakClose = (db, real) => { leaks.push({ db, real }); return Promise.reject(new Error('inject close (connection stays open)')); };
            const failCR = (db, sql, real) => ((sql === 'COMMIT' || sql === 'ROLLBACK') ? Promise.reject(new Error(`inject ${sql.toLowerCase()}`)) : real(db, sql));
            try {
                await guarded('1 业务异常 + 仅关闭失败', async () => {
                    const root = ctl('ll-clean-1');
                    const boom = new Error('boom L1');
                    SET_HOOKS({ dbClose: closeFailReal('inject close L1') });
                    const r = await caught(() => WLr(root, 'alpha', async () => { throw boom; }));
                    resetHooks();
                    const again = await WLr(root, 'alpha', async () => 5);
                    must(r.threw && r.value === boom && Array.isArray(boom.cleanupErrors) && boom.cleanupErrors.length === 1 && /inject close L1/.test(boom.cleanupErrors[0].message) && boom.lockUncertain === undefined && again === 5,
                        '业务异常 + 关闭失败（COMMIT 已成功，事务已结束）：原异常原样抛出并附 cleanupErrors（关闭失败），不算锁不确定，下一次取锁成功', jstr({ same: r.value === boom, ce: boom.cleanupErrors && boom.cleanupErrors.map((x) => x.message), u: boom.lockUncertain, again }));
                });
                await guarded('2 业务异常 + COMMIT / ROLLBACK / 关闭都失败', async () => {
                    const root = ctl('ll-clean-2');
                    const boom = new Error('boom L2');
                    SET_HOOKS({ dbRun: failCR, dbClose: leakClose });
                    const r = await caught(() => WLr(root, 'alpha', async () => { throw boom; }));
                    resetHooks();
                    const nxt = await errOf(() => WLr(root, 'beta', async () => {}));
                    must(r.threw && r.value === boom && Array.isArray(boom.cleanupErrors) && boom.cleanupErrors.length === 3 && boom.lockUncertain === true && nxt && nxt.code === 'STATE_LOCK_UNCERTAIN',
                        '业务异常 + COMMIT / ROLLBACK / 关闭都失败：原异常原样抛出，cleanupErrors 带三条失败，lockUncertain = true，控制根被标记（下一次别的线的 withLineLock 立即 STATE_LOCK_UNCERTAIN）', jstr({ same: r.value === boom, n: boom.cleanupErrors && boom.cleanupErrors.length, u: boom.lockUncertain, nxt: nxt && nxt.code }));
                });
                await guarded('3 throw null + 仅关闭失败', async () => {
                    const root = ctl('ll-clean-3');
                    SET_HOOKS({ dbClose: closeFailReal('inject close L3') });
                    const w = await withWarnings(() => caught(() => WLr(root, 'alpha', async () => { throw null; })));
                    resetHooks();
                    must(w.v.threw && w.v.value === null && w.ws.length === 1 && /^StateLockCleanupWarning:线级锁清理失败.*inject close L3/.test(w.ws[0]) && !/重启/.test(w.ws[0]),
                        'throw null + 关闭失败：null 原样抛出（挂不上附加信息），改发一条警告（写明线级锁与关闭失败，不提重启）', jstr(w));
                });
                await guarded('4 throw 0 + 锁不确定', async () => {
                    const root = ctl('ll-clean-4');
                    SET_HOOKS({ dbRun: failCR, dbClose: leakClose });
                    const w = await withWarnings(() => caught(() => WLr(root, 'alpha', async () => { throw 0; })));
                    resetHooks();
                    const nxt = await errOf(() => S.readState(root, { lockTimeoutMs: 1500 }));
                    must(w.v.threw && Object.is(w.v.value, 0) && w.ws.length === 1 && /^StateLockCleanupWarning:线级锁清理失败.*inject commit.*inject rollback.*inject close.*重启/.test(w.ws[0]) && nxt && nxt.code === 'STATE_LOCK_UNCERTAIN',
                        'throw 0 + COMMIT / ROLLBACK / 关闭都失败（锁不确定）：0 原样抛出，警告写明三条失败并要求重启，控制根已标记（readState 立即 STATE_LOCK_UNCERTAIN）', jstr({ ws: w.ws, nxt: nxt && nxt.code }));
                });
                await guarded('5 冻结的业务异常 + 关闭失败', async () => {
                    const root = ctl('ll-clean-5');
                    const frozen = Object.freeze(new Error('frozen L5'));
                    SET_HOOKS({ dbClose: closeFailReal('inject close L5') });
                    const w = await withWarnings(() => caught(() => WLr(root, 'alpha', async () => { throw frozen; })));
                    resetHooks();
                    must(w.v.threw && w.v.value === frozen && frozen.cleanupErrors === undefined && w.ws.length === 1 && /^StateLockCleanupWarning:线级锁清理失败.*inject close L5/.test(w.ws[0]),
                        '冻结的业务异常 + 关闭失败：同一个冻结对象原样抛出，挂不上 cleanupErrors，改发警告', jstr(w));
                });
                await guarded('6 BEGIN 失败 + 关闭失败', async () => {
                    const root = ctl('ll-clean-6');
                    let ran = 0;
                    SET_HOOKS({ dbRun: (db, sql, real) => (sql === 'BEGIN EXCLUSIVE' ? Promise.reject(new Error('inject begin')) : real(db, sql)), dbClose: closeFailReal('inject close L6') });
                    const e = await errOf(() => WLr(root, 'alpha', async () => { ran++; }));
                    resetHooks();
                    must(e && e.code === 'STATE_LOCK_FAILED' && ran === 0 && Array.isArray(e.cleanupErrors) && e.cleanupErrors.length === 1 && /inject close L6/.test(e.cleanupErrors[0].message),
                        'BEGIN 失败 + 关闭失败：取锁错误（STATE_LOCK_FAILED）带 cleanupErrors（关闭失败），asyncFn 未执行', jstr(e && { c: e.code, ce: e.cleanupErrors && e.cleanupErrors.map((x) => x.message), ran }));
                });
                await guarded('7 asyncFn 成功 + COMMIT / ROLLBACK / 关闭都失败', async () => {
                    const root = ctl('ll-clean-7');
                    SET_HOOKS({ dbRun: failCR, dbClose: leakClose });
                    const e = await errOf(() => WLr(root, 'alpha', async () => 'ok'));
                    resetHooks();
                    must(e && e.code === 'STATE_LOCK_UNCERTAIN' && e.lockUncertain === true && Array.isArray(e.cleanupErrors) && e.cleanupErrors.length === 3 && /inject commit/.test(e.cause && e.cause.message),
                        'asyncFn 成功但收尾三步都失败：STATE_LOCK_UNCERTAIN（带 cleanupErrors 三条，cause = COMMIT 失败）', jstr(e && { c: e.code, n: e.cleanupErrors && e.cleanupErrors.length, cause: e.cause && e.cause.message }));
                });
            } finally {
                resetHooks();
                for (const l of leaks) { try { await l.real(l.db); } catch (_) { /* 进程退出时由系统释放 */ } }
            }
        });

        await sec('15e 代次检查在锁内且早于补丁（修复批 3）：不匹配时补丁执行数为 0；等锁期间改 opts 取消不了；目标暂停于 BEGIN 期间另一进程删除归档并同名重建', async () => {
            const WRONG = '00000000-0000-4000-8000-000000000000';
            const toRes = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
            // ---- (1) 不匹配：补丁执行计数 0
            await guarded('代次不匹配：补丁没执行', async () => {
                const root = ctl('gen-count');
                await S.createLine(root, 'alpha', {}, at(T0));
                const before = bytes(root);
                let ran = 0;
                const e = await errOf(() => S.updateLine(root, 'alpha', (r) => { ran++; r.module = 'x'; }, { expectGeneration: WRONG }));
                must(e && e.code === 'STATE_GENERATION_MISMATCH' && ran === 0 && sameBytes(bytes(root), before), 'expectGeneration 不符：STATE_GENERATION_MISMATCH，补丁执行计数 = 0，字节不变', jstr({ c: e && e.code, ran }));
            });
            // ---- (2) 入口快照：A 持锁停在 COMMIT，B / C 排队期间把调用方的 opts.expectGeneration 改成 undefined -> 仍按入口的值检查
            await guarded('入口快照', async () => {
                const root = ctl('gen-snapshot');
                await S.createLine(root, 'alpha', {}, at(T0));
                await S.createLine(root, 'beta', {}, at(T0));
                await S.updateLine(root, 'beta', (r) => { r.lifecycle = 'ready'; }, at(T1));
                await S.updateLine(root, 'beta', (r) => { r.lifecycle = 'removing'; }, at(T2));
                const before = bytes(root);
                let releaseA;
                const aGate = new Promise((res) => { releaseA = res; });
                let aAtCommit;
                const aReachedCommit = new Promise((res) => { aAtCommit = res; });
                let held = false;
                SET_HOOKS({ dbRun: (db, sql, real) => { if (sql === 'COMMIT' && !held) { held = true; aAtCommit(); return aGate.then(() => real(db, sql)); } return real(db, sql); } });
                let pA = null;
                let pB = null;
                let pC = null;
                let ran = 0;
                try {
                    pA = toRes(S.updateConfig(root, () => {}, { lockTimeoutMs: sc(20000) }));
                    const reached = await Promise.race([aReachedCommit.then(() => true), sleepAsync(sc(30000)).then(() => false)]);
                    must(reached, '前提：A 已持锁并停在 COMMIT 阶段');
                    const o1 = { lockTimeoutMs: sc(20000), expectGeneration: WRONG };
                    const o2 = { lockTimeoutMs: sc(20000), expectGeneration: WRONG };
                    pB = toRes(S.updateLine(root, 'alpha', (r) => { ran++; r.module = 'should-not-run'; }, o1));
                    pC = toRes(S.removeLineRecord(root, 'beta', o2));
                    o1.expectGeneration = undefined;   // 等锁期间取消代次保护
                    o2.expectGeneration = undefined;
                    releaseA();
                    const [, rB, rC] = await Promise.all([pA, pB, pC]);
                    must(!rB.ok && rB.e && rB.e.code === 'STATE_GENERATION_MISMATCH' && ran === 0, 'updateLine 等锁期间调用方把 opts.expectGeneration 改成 undefined：仍按入口的值检查，STATE_GENERATION_MISMATCH，补丁未执行', jstr({ c: rB.e && rB.e.code, ran }));
                    must(!rC.ok && rC.e && rC.e.code === 'STATE_GENERATION_MISMATCH' && sameBytes(bytes(root), before), 'removeLineRecord 同样：等锁期间取消不了，beta 没有被移入 history，字节不变', jstr({ c: rC.e && rC.e.code }));
                } finally {
                    releaseA();
                    await Promise.race([Promise.all([pA, pB, pC].filter(Boolean)), sleepAsync(sc(30000))]);
                    resetHooks();
                }
            });
            // ---- (3) 目标暂停在实际 BEGIN 之前；另一进程完成删除归档 + 同名重建；再放行
            const pauseAtBegin = () => {
                let reached;
                const reachedP = new Promise((r) => { reached = r; });
                let gate;
                const gateP = new Promise((r) => { gate = r; });
                let paused = false;
                SET_HOOKS({ dbRun: (db, sql, real) => { if (sql === 'BEGIN EXCLUSIVE' && !paused) { paused = true; reached(); return gateP.then(() => real(db, sql)); } return real(db, sql); } });
                return { reachedP, release: gate };
            };
            const jsonOf = (root) => JSON.parse(bytes(root).toString('utf8'));
            const variants = [
                ['updateLine', 'gen-recycle-update', 'rebuilt-u', (root, gen, count) => S.updateLine(root, 'alpha', (r) => { count.n++; r.module = 'stale-op'; }, { expectGeneration: gen, lockTimeoutMs: sc(20000) })],
                ['removeLineRecord', 'gen-recycle-remove', 'rebuilt-r', (root, gen) => S.removeLineRecord(root, 'alpha', { expectGeneration: gen, lockTimeoutMs: sc(20000) })],
            ];
            for (const [label, rootName, rebuiltModule, runTarget] of variants) {
                await guarded(`${label} 暂停于 BEGIN`, async () => {
                    const root = ctl(rootName);
                    const a1 = await S.createLine(root, 'alpha', { module: 'old' }, at(T0));
                    await S.updateLine(root, 'alpha', (r) => { r.lifecycle = 'ready'; }, at(T1));
                    await S.updateLine(root, 'alpha', (r) => { r.lifecycle = 'removing'; }, at(T2));
                    const count = { n: 0 };
                    const pz = pauseAtBegin();
                    let p = null;
                    let w = null;
                    try {
                        p = toRes(runTarget(root, a1.generation, count));
                        const reached = await Promise.race([pz.reachedP.then(() => true), sleepAsync(sc(20000)).then(() => false)]);
                        must(reached, `${label}：目标操作已暂停在它自己的 BEGIN EXCLUSIVE 之前（尚未持锁）`);
                        w = startWorker({ role: 'recycle', controlRoot: root, name: 'alpha', module: rebuiltModule, timeoutMs: 20000, now: T4 });
                        const wx = await w.exited;
                        const mid = bytes(root);
                        const ms = jsonOf(root);
                        must(exitedOk(wx) && ms.lines.alpha.module === rebuiltModule && ms.lines.alpha.generation !== a1.generation && wx.result.generation === ms.lines.alpha.generation && ms.history.length === 1 && ms.history[0].generation === a1.generation,
                            `${label}：目标暂停期间另一进程完成了删除归档与同名重建（新代次落盘，旧代次进 history）`, jstr({ wx: exitInfo(wx), alpha: ms.lines.alpha && ms.lines.alpha.generation, hist: ms.history.map((h) => h.generation) }));
                        pz.release();
                        const r = await p;
                        const after = bytes(root);
                        const as = jsonOf(root);
                        must(!r.ok && r.e && r.e.code === 'STATE_GENERATION_MISMATCH' && count.n === 0 && sameBytes(after, mid) && as.lines.alpha.generation === ms.lines.alpha.generation && as.history.length === 1,
                            `${label}：放行后报 STATE_GENERATION_MISMATCH，补丁未执行${label === 'updateLine' ? '（执行计数 0）' : ''}，新记录与 history 字节不变`, jstr({ c: r.e && r.e.code, n: count.n, same: sameBytes(after, mid) }));
                    } finally {
                        pz.release();
                        if (w) { await Promise.race([w.exited, sleepAsync(sc(30000))]); if (!w.done) w.kill(); await Promise.race([w.closedP, sleepAsync(sc(15000))]); }
                        if (p) await Promise.race([p, sleepAsync(sc(30000))]);
                        resetHooks();
                    }
                });
            }
        });
    } catch (e) {
        bad('未预期异常（节之外）', e && e.stack);
    } finally {
        resetHooks();
        // ======================= 11 清理 =======================
        section('11 清理：先回收所有存活子进程，再逐项删除临时目录（不用 fs.rmSync），lstat 确认');
        const unreaped = await reapAll();
        must(unreaped.length === 0, '所有子进程都已 close 回收（无存活、无 close 缺失）', `未回收的子进程 PID：${jstr(unreaped)}`);
        must(timedOutWorkers === 0, '没有子进程触发父进程截止时间（超时记失败）', `超时 ${timedOutWorkers} 个`);
        must(poisoned === null, '没有进程内锁调用被判卡死', String(poisoned));
        if (unreaped.length > 0) {
            // 仍可能写入的子进程没确认退出：不清理它用的目录，明确留给人工
            bad('存在未确认退出的子进程：不清理临时目录（避免与仍在写入的子进程争用）', `目录 ${base}，PID ${jstr(unreaped)}`);
        } else {
            const left = [];
            delTree(base, left);
            must(left.length === 0 && !fs.existsSync(base), '临时目录已清理干净，无残留', jstr(left));
        }
        summaryPrinted = true;
        console.log(`\nverify-lines-state PASS=${pass} FAIL=${fail}`);
        process.exitCode = fail ? 1 : 0;
        process.exit(process.exitCode);
    }
}

if (IS_WORKER) {
    workerMain(JSON.parse(Buffer.from(process.argv[3], 'base64').toString('utf8'))).catch((e) => {
        process.stdout.write(`RESULT:${JSON.stringify({ ok: false, code: 'WORKER_CRASH', message: e && e.message })}\n`);
        process.exitCode = 4;
    });
} else {
    // 守卫挂起 / 异常退出必须非零：先置 1，只有跑到汇总且 FAIL=0 才置 0；beforeExit 兜底
    process.exitCode = 1;
    process.on('beforeExit', () => {
        if (!summaryPrinted) {
            summaryPrinted = true;
            console.log('\n  [FAIL] 守卫没有跑到汇总就退出了（事件循环空了，疑似卡死的 await）');
            console.log(`\nverify-lines-state PASS=${pass} FAIL=${fail + 1}`);
            process.exitCode = 1;
        }
    });
    startWatchdog();
    main().catch((e) => {
        console.log(`\n  [FAIL] main 异常退出：${e && e.stack}`);
        console.log(`\nverify-lines-state PASS=${pass} FAIL=${fail + 1}`);
        summaryPrinted = true;
        process.exit(1);
    });
}
