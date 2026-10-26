/**
 * #106 S3a 套件：临时实例启动器 scripts/lib/test-instance.js + 汇总就绪接口 GET /api/health/ready
 *
 * 由 verify-test-instance.js（薄入口）经共享监督进程 lines-test-supervisor.js 运行；也可直接 node 运行（无超时回收保护，仅调试用）。
 *
 * 安全约束（本套件自己的）：
 *   - 只用自建的合成来源库：先用启动器自己从空库预热出一份「全部表已建好」的模板，再在拷贝上种合成数据；测试密钥自己生成；
 *     不打开任何 task_pool.db、不读任何真实 .env（启动器读真实库 / .env 的默认路径只用合成目录验证规划，不真正走）；
 *   - **所有真服务（A / B / X / E 与预热）都从套件自建的合成检出（PRIV/checkout：复制来的 server.js + routes/utils/public + 合成 .env；本检出是线时另写同一份 wbs-server/.sdh-instance）启动**，不从运行本套件的检出启动——
 *     套件在任何检出（包括有真实 .env 的主工作区）里运行，被测服务都读不到真实 .env；合成 .env 里带来源标记（白名单键 NODE_ENV=ti-synthetic-checkout），用例断言服务里实际生效的是它；
 *   - 套件进程启动时把 TEMP / TMP 指向私有临时根 PRIV/tmp：所有 sdh-test-* 数据根、遗留清理扫描都落在私有根里，不碰本机其他会话的临时目录；
 *   - **数据库路径守卫覆盖所有进程**：在加载启动器及其数据库依赖之前，先给套件进程自己装守卫（sqlite3 只放行私有根 PRIV 内的库，越界立即抛错并写标记）；K 节辅助进程同样 --require 守卫；
 *     服务子进程预加载同一份守卫（只放行实例根 PRIV/tmp 内的库、只放行本实例的 PORT、记录环境快照：键名 + 值的 sha256，不记值本身）；
 *   - 终止进程只终止自己用 spawn 起的子进程（句柄在手），或按「PID + 精确创建时间」核对后终止（killIfIdentity）；所有辅助进程（holder / kids / K 节 helper）一律经 spawnHelper 创建（立即挂 error 监听、记录 spawned / exited / closed / error，
 *     等 spawn 事件后才取创建时间，创建失败不抛）并统一登记，桩进程经 pid 文件登记身份；登记带归属（launcher / suite，见登记表注释），最外层 finally 独立回收：
 *     本应由启动器终止的服务（归属 launcher）到兜底回收时仍在运行 = 启动器漏杀，记入 failed（Z.5 判红），不让兜底把它掩盖掉。
 *
 * 参数（监督进程原样传入）：--only=<节,节>（setup 总是跑；节名 A B X E F W K U G）、--launcher=<被测启动器绝对路径>、--server-js=<被测 server.js 绝对路径（变异树）>、
 *   --health-util=<被测 health-ready.js 绝对路径>、--summary-file=<汇总 JSON 路径>。后三个是变异自证用的接缝，正常运行不传。
 * 输出：每条断言一行 `CHECK <编号> PASS|FAIL <标题>`；末行 `verify-test-instance PASS=<n> FAIL=<n>`。退出码 0 = 全绿。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const WBS = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const argVal = (p) => { const a = args.find((x) => x.startsWith(p)); return a ? a.slice(p.length) : null; };

// 受控挂起夹具（监督进程自检用）：同步阻塞 + 一个孙进程，证明超时后整棵进程树被回收。夹具主体在共享监督进程模块里；本分支必须在创建任何东西之前。
if (argVal('--hang-fixture=') !== null) {
    require('./lines-test-supervisor.js').runHangFixture(argVal('--hang-fixture='));
}

// ---------------------------------------------------------------- 私有临时根（必须最先做）
const REAL_TMP = os.tmpdir();
const PRIV = fs.mkdtempSync(path.join(REAL_TMP, 'sdh-ti-suite-'));
const TMP = path.join(PRIV, 'tmp');

/** 引导阶段的最小递归删除（只依赖 fs；链接只拆链接本身；不用 fs.rmSync）：引导失败时 common 可能还没加载 */
function rmTreeMin(dir) {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
        try { fs.unlinkSync(dir); } catch (_) { fs.rmdirSync(dir); }
        return;
    }
    for (const n of fs.readdirSync(dir)) rmTreeMin(path.join(dir, n));
    fs.rmdirSync(dir);
}

// --launcher= 变异接缝：启动器从自己所在位置往上两级求检出根并读那里的 wbs-server/.sdh-instance 写父身份；在线 worktree 里用 scratchpad 副本做变异自证时，副本树也要带同一份 .sdh-instance，否则每轮都 PARENT_MISMATCH、命中的不是目标用例
const LAUNCHER_PATH = argVal('--launcher=') || path.join(__dirname, 'lib', 'test-instance.js');
const SERVER_JS_ARG = argVal('--server-js=');
const SERVER_TREE = SERVER_JS_ARG ? path.dirname(SERVER_JS_ARG) : WBS;
const HEALTH_UTIL = argVal('--health-util=') || path.join(WBS, 'utils', 'health-ready.js');
const SUMMARY_FILE = argVal('--summary-file=');
const ONLY = argVal('--only=') ? argVal('--only=').split(',').map((s) => s.trim()).filter(Boolean) : null;
const want = (sec) => ONLY === null || ONLY.includes(sec);

// 本检出的身份：线 worktree 里 wbs-server/.sdh-instance 的内容（去 BOM、去首尾空白），主工作区没有这个文件 → 父身份 main。
//   启动器写进实例清单 / 实例库的父检出身份恒取本检出身份；合成检出里的 server.js 核对库内父身份时取的是合成检出自己的 .sdh-instance，
//   所以 buildCheckout 把同一份身份写进合成检出（合成检出模拟的就是本检出）。套件里「父身份是什么」的期望都读 EXPECTED_PARENT，不写死 main（线内跑会 PARENT_MISMATCH）。
//   这里独立读文件算期望，不调用被测的 readCheckoutIdentity。
const CHECKOUT_IDENTITY = (() => {
    let raw = null;
    try { raw = fs.readFileSync(path.join(WBS, '.sdh-instance'), 'utf8'); } catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
    if (raw === null) return null;
    const t = (raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw).trim();
    return t === '' ? null : t;
})();
const EXPECTED_PARENT = CHECKOUT_IDENTITY !== null ? CHECKOUT_IDENTITY : 'main';

const LINE_PROC_PATH = path.join(WBS, '..', 'scripts', 'lines', 'line-proc.js');
const GUARD = path.join(PRIV, '_guard.js');
const NOEXIT = path.join(PRIV, '_noexit.js');
const LATE_PROBE = path.join(PRIV, '_late-probe.js');
const INJECT = path.join(PRIV, '_inject-fail.js');
const GUARD_MARKER = path.join(PRIV, 'guard.marker');

// 引导阶段加载的依赖（失败 → BOOT_ERROR，由最外层统一报告并清理私有根）
let BOOT_ERROR = null;
const START_VIOLATIONS = [];
let sqlite3 = null; let common = null; let procLib = null; let instanceDb = null; let aes = null; let jwt = null; let lineNew = null; let acorn = null;
let ti = null; let healthUtil = null;
let GUARD_ENV = null; let GUARD_ARGS = null;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fwd = (p) => String(p).replace(/\\/g, '/');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); } };
const sameFile = (a, b) => path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();
const quoteOpt = (p) => '"' + fwd(p).replace(/"/g, '\\"') + '"';

// ---------------------------------------------------------------- 测试密钥与种子数据常量（不依赖任何被测模块）
const TEST_KEY = `tk-${crypto.randomBytes(18).toString('hex')}`;
const WRONG_KEY = `wk-${crypto.randomBytes(18).toString('hex')}`;
const WHITELIST_VALUES = Object.freeze({
    collab_notify_admin_on_submit: 'on',
    issue_lite_developer_id: '3',
    issue_lite_chat_owner_id: '4',
    issue_lite_notify_target_ids: '5,6',
    sys_notify_dry_run: 'off',
    sys_release_default_executor_ids: '7,8',
    sys_single_commit_group_systems: '系统甲,系统乙',
});
const REAL_DT = Object.freeze({ dingtalk_app_key: 'REAL-DT-APPKEY-0001', dingtalk_app_secret: 'REAL-DT-APPSECRET-0002', dingtalk_robot_code: 'REAL-DT-ROBOT-0003', platform_base_url: 'https://real.example.invalid' });
const EXTRA_SECRET = 'EXTRA-SECRET-VALUE-0004';
const EXTERNAL_PASSWORD = 'Pr0dPassw0rd-0005';
let DB_CONN_CIPHER = null;
const FILE_UUID_OK = '11111111-2222-3333-4444-555555555555.xlsx';
const FILE_UUID_GONE = '66666666-7777-8888-9999-aaaaaaaaaaaa.xlsx';
const PHOTO_OK = `${'a'.repeat(8)}-aaaa-aaaa-aaaa-${'a'.repeat(12)}.bin`;
const PHOTO_GONE = `${'b'.repeat(8)}-bbbb-bbbb-bbbb-${'b'.repeat(12)}.bin`;
/** 合成检出 .env：NODE_ENV 是白名单键（用作「实际加载的是合成 .env」的来源标记，值必须生效）；其余都是非白名单键（值必须被置空，真值一律不得出现在子进程里） */
const ENV_MARKER_VALUE = 'ti-synthetic-checkout';
const ENV_FILE_KEY = `envfile-${crypto.randomBytes(12).toString('hex')}`;
const ENV_FILE_ENTRIES = Object.freeze([
    ['NODE_ENV', ENV_MARKER_VALUE],
    ['SYS_TEST_HOOKS', '1'],
    ['WEBHOOK_SECRET', `x-synthetic-webhook-${crypto.randomBytes(6).toString('hex')}`],
    ['DB_ENCRYPTION_KEY', ENV_FILE_KEY],
    ['JWT_SECRET', `envfile-jwt-secret-should-not-win-${crypto.randomBytes(6).toString('hex')}`],
    ['TI_ENV_FILE_MARKER', 'loaded'],
    ['DINGTALK_APP_SECRET', `synthetic-dt-secret-${crypto.randomBytes(8).toString('hex')}`],
    ['GITHUB_TOKEN', `ghp_synthetic${crypto.randomBytes(10).toString('hex')}`],
]);
const ENV_NONWL_KEYS = ENV_FILE_ENTRIES.filter(([k]) => k !== 'NODE_ENV').map(([k]) => k);
const ENV_NONWL_VALUES = ENV_FILE_ENTRIES.filter(([k]) => k !== 'NODE_ENV').map(([, v]) => v);
/**
 * 合成 .env 里的系统键（修复批 2 第 9 项）：Path / TEMP / tz（故意大小写混合）。启动器对它们的口径是「子进程环境里已有（来自父环境）就不置空」——
 * 子进程的 PATH 必须与父进程相同、os.tmpdir() 仍在私有 TMP 下（否则 instance-mode 拒绝启动）；父环境没有的键（TZ 通常没有）照旧置空。
 * 它们的值不得出现在子进程里（dotenv 不覆盖已有键；空串也算存在），所以进「环境值泄漏」的哈希黑名单，但不进 ENV_NONWL_KEYS（那组键要求实际值为空串，系统键不是）。
 */
// TEMP 与 TMP 都放：只放 TEMP 时，去掉系统键豁免的误实现把 TEMP 置空后 os.tmpdir() 会回退到 TMP（仍是私有根），E1.6 的 tmpdir 子断言测不出（收口预筛 LOW-5）
const ENV_SYS_ENTRIES = Object.freeze([['Path', 'C:/ti-env-file-path-must-not-win'], ['TEMP', 'C:/ti-env-file-temp-must-not-win'], ['TMP', 'C:/ti-env-file-tmp-must-not-win'], ['tz', 'Asia/Tokyo']]);
const ENV_SYS_VALUES = ENV_SYS_ENTRIES.map(([, v]) => v);

// ---------------------------------------------------------------- 断言
let pass = 0;
let fail = 0;
const results = [];
function check(id, title, cond, detail) {
    const ok = !!cond;
    if (ok) pass += 1; else fail += 1;
    results.push({ id, title, ok });
    console.log(`CHECK ${id} ${ok ? 'PASS' : 'FAIL'} ${title}${!ok && detail !== undefined ? `\n         ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
    return ok;
}
let lstatOrNull = (p) => { try { return fs.lstatSync(p); } catch (e) { if (e && e.code === 'ENOENT') return null; throw e; } };
const tmpInstanceDirs = () => fs.readdirSync(TMP).filter((n) => /^sdh-test-/.test(n)).sort();

async function waitUntil(fn, ms, step) {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() >= end) return null;
        await sleep(step || 100);
    }
}

function httpJson(port, method, urlPath, body, token) {
    return new Promise((resolve) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        if (payload !== null) headers['Content-Length'] = Buffer.byteLength(payload);
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers, timeout: 10000 }, (res) => {
            let b = '';
            res.on('data', (c) => { b += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) { /* 非 JSON */ } resolve({ status: res.statusCode, json: j, raw: b }); });
        });
        req.on('error', (e) => resolve({ status: 0, json: null, raw: String(e.message) }));
        req.on('timeout', () => req.destroy(new Error('timeout')));
        if (payload !== null) req.write(payload);
        req.end();
    });
}

// ---------------------------------------------------------------- sqlite 助手（只用于套件自建的库）
function dbOpen(file, flags) { return new Promise((res, rej) => { const d = new sqlite3.Database(file, flags === undefined ? (sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE) : flags, (e) => (e ? rej(e) : res(d))); }); }
function dbExec(d, sql) { return new Promise((res, rej) => d.exec(sql, (e) => (e ? rej(e) : res()))); }
function dbAll(d, sql, p) { return new Promise((res, rej) => d.all(sql, p || [], (e, r) => (e ? rej(e) : res(r)))); }
function dbClose(d) { return new Promise((res) => d.close(() => res())); }
async function withDb(file, flags, fn) { const d = await dbOpen(file, flags); try { return await fn(d); } finally { await dbClose(d); } }
let RO = 1;   // sqlite3.OPEN_READONLY（引导后赋值）

// ---------------------------------------------------------------- 辅助进程统一登记与回收
/**
 * 登记表：套件自己起的辅助进程与启动器起的桩进程，统一登记「句柄 / PID + 精确创建时间 + 归属」，最外层 finally 里 reapAll() 独立回收。绝不按裸 PID 终止。
 *   - 套件自己 spawn 的辅助进程（F11b holder / W 节 kids / K 节 helper）一律经 spawnHelper 创建：返回前立即挂 error 监听，记录 spawned / exited / closed / error，等 spawn 事件（有界）后才取创建时间并登记；
 *   - 启动器 spawn 的桩进程经 pid 文件报告「pid|创建时间」，用 reapIds / registerIdentity 登记身份。
 * **归属 owner**（12T-R M2）：兜底回收不能掩盖启动器漏杀——
 *   'launcher' = 本应由启动器（或它的作业对象 / exit 处理器）终止的服务：全部桩进程（pid 文件里的每一条）、K / K6 的桩服务。到最外层回收时仍 match → 照常按身份终止，**同时记入 failed**（「启动器未终止」）；
 *   'suite'    = 套件自己起的辅助进程：holder、W 节 kids、K / K6 helper。它们本来就由套件在最外层回收，强制回收只记 forced。
 * 逐个登记点（标签 → 归属 → 理由）：
 *   F11b holder → suite（套件自己起来占目录的辅助进程）；W dead / W live → suite（sweep 夹具里的空转进程）；K helper / K6 helper → suite（调用启动器的辅助进程，不是被测对象）；
 *   K 桩服务 / K6 桩服务 → launcher（helper 被强杀 / emit exit 后，它起的服务必须由作业对象 / exit 处理器带走）；
 *   F5桩 / F8桩 / F9桩 / F10c桩 / F10d桩 / race-* 的桩（reapIds）→ launcher（启动器自己 spawn 的服务，失败收口 / stop() 必须终止）。
 */
const PROCS = [];
const OWNERS = Object.freeze(['launcher', 'suite']);
const HELPER_STATE = new WeakMap();
function attachHelperState(child) {
    const st = { spawned: false, exited: false, closed: false, error: null, messages: [] };
    child.on('error', (e) => { if (st.error === null) st.error = e; });   // 未处理的 error 事件会让套件进程直接崩溃：必须在 spawn 返回的同一个同步段里挂上
    child.on('message', (m) => { st.messages.push(m); });
    child.once('spawn', () => { st.spawned = true; });
    child.once('exit', () => { st.exited = true; });
    child.once('close', () => { st.closed = true; });
    HELPER_STATE.set(child, st);
    return st;
}
const childRunning = (c) => { const st = HELPER_STATE.get(c); return !!st && st.spawned && !st.exited && !st.closed && c.exitCode === null && c.signalCode === null; };
/**
 * 套件里所有辅助进程的统一创建封装。返回 { label, owner, child, pid, startTime, state, ok, error }，**永不抛**：
 *   创建失败（spawn 同步抛 / error 事件先到 / 10 秒内没有 spawn 事件）→ ok = false、error 非空，由调用方所在节判红并继续；
 *   成功 → 等 spawn 事件之后才取创建时间（PID 被句柄钉住）并登记进 PROCS。
 */
async function spawnHelper(label, cmd, args, opts, owner) {
    const own = owner === undefined ? 'suite' : owner;
    if (!OWNERS.includes(own)) throw new Error(`spawnHelper(${label}): 非法归属 ${String(own)}`);
    const out = { label, owner: own, child: null, pid: null, startTime: null, state: null, ok: false, error: null };
    let child = null;
    try { child = spawn(cmd, args, opts); } catch (e) { out.error = e; return out; }
    out.child = child;
    out.state = attachHelperState(child);
    const settled = await waitUntil(() => out.state.spawned || out.state.error !== null, 10000, 20);
    if (!settled || !out.state.spawned || out.state.error !== null) {
        out.error = out.state.error || new Error(`spawnHelper(${label}): 10 秒内没有收到 spawn 事件`);
        if (child.pid) PROCS.push({ label, child, pid: child.pid, startTime: null, owner: own });   // 进程若其实存在，交给最外层回收
        return out;
    }
    let startTime = null;
    try { startTime = procLib.getStartTime(child.pid); } catch (_) { startTime = null; }
    out.pid = child.pid;
    out.startTime = startTime;
    out.ok = true;
    PROCS.push({ label, child, pid: child.pid, startTime, owner: own });
    return out;
}
function registerIdentity(label, pid, startTime, owner) {
    if (!OWNERS.includes(owner)) throw new Error(`registerIdentity(${label}): 必须显式给出归属 launcher / suite，得到 ${String(owner)}`);
    PROCS.push({ label, child: null, pid, startTime, owner });
}
/** 等辅助进程退出：认 exit / close / error（已出错且未在运行 → 立即返回）；有界 */
function waitChildExit(c, ms) {
    if (!childRunning(c)) return Promise.resolve(true);
    return new Promise((resolve) => {
        let t = null;
        const done = (v) => { clearTimeout(t); resolve(v); };
        t = setTimeout(() => done(false), ms);
        c.once('exit', () => done(true));
        c.once('close', () => done(true));
        c.once('error', () => { if (!childRunning(c)) done(true); });   // kill 失败也会触发 error，此时进程可能还在：继续等
    });
}
const identityState = (pid, start) => { try { return procLib.checkIdentity({ pid, start_time: start }).state; } catch (e) { return `ERR ${e && e.code}`; } };
async function reapAll() {
    const out = { total: PROCS.length, forced: [], failed: [], forcedByOwner: { launcher: [], suite: [] } };
    const forced = (p) => { out.forced.push(p.label); out.forcedByOwner[p.owner].push(p.label); };
    const notTerminatedByLauncher = (p) => { if (p.owner === 'launcher') out.failed.push(`${p.label}(pid ${p.pid}：启动器未终止——兜底回收时仍在运行)`); };
    for (const p of PROCS) {
        if (p.child) {
            if (childRunning(p.child)) {
                forced(p);
                notTerminatedByLauncher(p);
                try { p.child.kill(); } catch (_) { /* 下面按是否退出判定 */ }
                if (!(await waitChildExit(p.child, 5000))) {
                    // 局部截止内没退出：按身份升级终止（没有创建时间就退回按句柄钉住的 PID 终止进程树）
                    try { if (p.startTime) procLib.killIfIdentity({ pid: p.pid, start_time: p.startTime }); else procLib.killTree(p.pid); } catch (_) { /* 下面确认 */ }
                    if (!(await waitChildExit(p.child, 5000))) out.failed.push(`${p.label}(pid ${p.pid})`);
                }
            }
        } else if (p.startTime) {
            const st = identityState(p.pid, p.startTime);
            if (st === 'match') {
                forced(p);
                notTerminatedByLauncher(p);
                try { procLib.killIfIdentity({ pid: p.pid, start_time: p.startTime }); } catch (_) { /* 下面确认 */ }
                const st2 = identityState(p.pid, p.startTime);
                if (st2 === 'match' || String(st2).startsWith('ERR')) out.failed.push(`${p.label}(pid ${p.pid})`);
            } else if (String(st).startsWith('ERR')) out.failed.push(`${p.label}(pid ${p.pid}：身份查询失败)`);
        } else {
            out.failed.push(`${p.label}(pid ${p.pid}：没有创建时间，无法按身份终止)`);
        }
    }
    return out;
}

/** 桩进程的 pid 文件：每行「pid|创建时间」（桩自己用 line-proc 取）。兜底回收只按身份终止；创建时间没取到的只能报告 */
function readIds(file) {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { const [p, s] = l.split('|'); return { pid: Number(p), start: s && s !== 'null' ? s : null }; });
}
const idsGone = (ids) => ids.length > 0 && ids.every((i) => i.start !== null && ['dead', 'reused'].includes(identityState(i.pid, i.start)));
/** 一组身份都已消失（dead / reused）；空组算消失。有界等待（启动器的失败收口是同步等到进程退出才返回，这里给 taskkill 之后的收尾一点余量） */
const idsAllGone = (ids) => ids.every((i) => i.start !== null && ['dead', 'reused'].includes(identityState(i.pid, i.start)));
const waitIdsGone = async (ids, ms) => (await waitUntil(() => idsAllGone(ids), ms === undefined ? 8000 : ms, 100)) !== null;
/** 桩进程的身份登记：全部归属 launcher（启动器自己 spawn 的服务，失败收口 / stop() 必须终止，兜底回收若还要杀它就是启动器漏杀） */
function reapIds(label, ids) { for (const i of ids) registerIdentity(`${label}#${i.pid}`, i.pid, i.start, 'launcher'); }

// ---------------------------------------------------------------- 守卫 / 桩 / 探针（写在私有根里的夹具文件）
function writeGuardFile() {
    fs.writeFileSync(GUARD, `
'use strict';
// 数据库路径守卫（经 --require / NODE_OPTIONS 加载；套件进程自己、K 节辅助进程、服务子进程都装）：
//   ① sqlite3 只放行 GUARD_ROOT 内的库（套件进程 / 辅助进程 = 私有根，服务子进程 = 实例根），越界：写标记并 —— GUARD_MODE=throw（套件 / 辅助进程）抛错，否则以 98 立即退出；
//   ② 只放行本实例的 PORT（GUARD_PORT_CHECK=1 时；含 3000 在内的其他端口 96）；③ 环境快照（键名 + 每个值的 sha256，不记值本身）写到数据根；④ GUARD_MODE=throw 时记录每次打开（文件 + 打开标志）。
if (globalThis.__tiGuardLoaded) return;
globalThis.__tiGuardLoaded = true;
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const realExit = process.exit.bind(process);
const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const rootReal = fold(fs.realpathSync(process.env.GUARD_ROOT));
function trip(what, code) {
  try { fs.writeFileSync(process.env.GUARD_MARKER, what + '\\n', { flag: 'a' }); } catch (_) {}
  if (process.env.GUARD_MODE === 'throw') throw new Error('GUARD_TRIPPED:' + what);
  realExit(code);
  throw new Error('GUARD_TRIPPED:' + what);
}
function realOf(p) { const abs = path.resolve(p); try { return fs.realpathSync(abs); } catch (_) { try { return path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs)); } catch (_2) { return abs; } } }
try {
  const dd = process.env.SDH_DATA_DIR;
  if (dd && fs.existsSync(dd)) {
    const sha = (v) => (v === undefined ? null : crypto.createHash('sha256').update(String(v)).digest('hex'));
    const pick = {};
    for (const k of ['INSTANCE', 'DB_FILE', 'DATA_DIR', 'EXTERNAL', 'BACKGROUND_JOBS']) pick[k] = process.env['SDH_' + k];
    const e3 = {};
    for (const k of ['WEBHOOK_SECRET', 'SYS_TEST_HOOKS', 'DB_ENCRYPTION_KEY']) { const v = process.env[k]; e3[k] = v === undefined ? null : (v === '' ? '' : '<non-empty>'); }
    const vals = {};
    for (const k of Object.keys(process.env)) vals[k] = sha(process.env[k]);
    fs.writeFileSync(path.join(dd, 'env-' + process.pid + '.json'), JSON.stringify({ pid: process.pid, argv1: process.argv[1] || null, keys: Object.keys(process.env), vals, port: process.env.PORT, jwtSha: sha(process.env.JWT_SECRET), sdh: pick, env3: e3 }));
  }
} catch (_) {}
const sqlite3 = require(process.env.GUARD_SQLITE3);
const Orig = sqlite3.Database;
if (process.env.GUARD_MODE === 'throw') globalThis.__tiOpenLog = [];
function Patched(filename, ...rest) {
  if (filename !== ':memory:' && filename !== '') {
    const r = fold(realOf(String(filename)));
    if (!(r === rootReal || r.startsWith(rootReal + path.sep))) trip('OPEN_OUTSIDE_TEST_ROOT:' + filename, 98);
    if (globalThis.__tiOpenLog) globalThis.__tiOpenLog.push({ file: realOf(String(filename)), mode: typeof rest[0] === 'number' ? rest[0] : 6 });
  }
  return new Orig(filename, ...rest);
}
Patched.prototype = Orig.prototype;
sqlite3.Database = Patched;
if (process.env.GUARD_PORT_CHECK === '1') {
  const net = require('net');
  const origListen = net.Server.prototype.listen;
  net.Server.prototype.listen = function () {
    const a = arguments[0];
    const got = a && typeof a === 'object' ? a.port : (typeof a === 'number' || typeof a === 'string' ? Number(a) : undefined);
    if (process.env.PORT && got !== Number(process.env.PORT)) trip('LISTEN_WRONG_PORT:' + got, 96);
    return origListen.apply(this, arguments);
  };
}
`);
}

function writeFixtures() {
    fs.writeFileSync(NOEXIT, "'use strict';\nconst realExit = process.exit;\nprocess.exit = function (code) { if (code) return undefined; return realExit.apply(process, arguments); };\n");
    // 晚探针：server.js 主模块加载完（顶部 dotenv 已执行）之后 3 秒，把子进程里「实际生效」的值写到数据根：三个被剔除键、合成 .env 里每个非白名单键（空 / 非空 / 不存在）、来源标记（NODE_ENV）、argv[1]。不记值本身（标记值除外）
    fs.writeFileSync(LATE_PROBE, `
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const t = setTimeout(() => {
  try {
    const e3 = {}; const own = {};
    for (const k of ['WEBHOOK_SECRET', 'SYS_TEST_HOOKS', 'DB_ENCRYPTION_KEY']) { const v = process.env[k]; e3[k] = v === undefined ? null : (v === '' ? '' : '<non-empty>'); own[k] = Object.prototype.hasOwnProperty.call(process.env, k); }
    const probeKeys = JSON.parse(process.env.GUARD_PROBE_KEYS || '[]');
    const nonwl = {};
    for (const k of probeKeys) nonwl[k] = process.env[k] === undefined ? null : (process.env[k] === '' ? '' : '<non-empty>');
    const sha = (v) => (v === undefined ? null : crypto.createHash('sha256').update(String(v)).digest('hex'));
    // 系统键（.env 里的 Path / TEMP / tz）：子进程里 PATH 的哈希、os.tmpdir() 的实际值、TZ 的实际值（不存在 = null）
    const sysKeys = { pathSha: sha(process.env.PATH), tmpdir: require('os').tmpdir(), tz: process.env.TZ === undefined ? null : process.env.TZ };
    fs.writeFileSync(path.join(process.env.SDH_DATA_DIR, 'late-env-' + process.pid + '.json'), JSON.stringify({ pid: process.pid, argv1: process.argv[1] || null, e3, own, nonwl, nodeEnv: process.env.NODE_ENV === undefined ? null : process.env.NODE_ENV, jwtSha: sha(process.env.JWT_SECRET), sys: sysKeys }));
  } catch (_) {}
}, 3000);
t.unref();
`);
    // 失败注入预加载：
    //   ① TI_INJECT_PATTERN（item 1 的用例）：SQL 匹配的 db.run 不真正执行，而是异步以带 code 的 Error 调其回调（没有回调的语句不注入）；
    //   ② TI_INJECT_QUERY（修复批 2 第 7 项）：JSON 规则数组，每条 { pattern, mode, arg } 作用于 db.all / db.get 的**回调形态**调用——
    //      mode = error（不执行，异步以 SQLITE_ERROR 调回调）| dropcol（真实执行 PRAGMA table_info，回调的行里去掉 name = arg 的列）| norow（不执行，回调 (null, undefined)）|
    //      rows（不执行，回调 (null, arg)）| patch（真实执行，回调的单行里 Object.assign(row, arg)）。
    //      **每次命中都往数据根的 inject-hits.log 追加一行（规则下标）**，用例要求至少命中一次——注入没生效时不能把「没失败」当成「没汇入」。
    fs.writeFileSync(INJECT, `
'use strict';
const fs = require('fs');
const path = require('path');
const sqlite3 = require(process.env.GUARD_SQLITE3);
const pat = process.env.TI_INJECT_PATTERN;
if (pat) {
  const re = new RegExp(pat);
  const origRun = sqlite3.Database.prototype.run;
  sqlite3.Database.prototype.run = function (sql, ...rest) {
    if (typeof sql === 'string' && re.test(sql)) {
      const cb = rest.length && typeof rest[rest.length - 1] === 'function' ? rest[rest.length - 1] : null;
      if (cb) {
        const err = Object.assign(new Error('SQLITE_ERROR: injected failure (test)'), { errno: 1, code: 'SQLITE_ERROR' });
        setImmediate(() => cb.call({}, err));
        return this;
      }
    }
    return origRun.call(this, sql, ...rest);
  };
}
const qrules = process.env.TI_INJECT_QUERY ? JSON.parse(process.env.TI_INJECT_QUERY) : null;
if (qrules) {
  const compiled = qrules.map((r) => Object.assign({}, r, { re: new RegExp(r.pattern) }));
  const hit = (i) => { try { fs.appendFileSync(path.join(process.env.SDH_DATA_DIR, 'inject-hits.log'), i + '\\n'); } catch (_) {} };
  for (const m of ['all', 'get']) {
    const orig = sqlite3.Database.prototype[m];
    sqlite3.Database.prototype[m] = function (sql, ...rest) {
      const cb = rest.length && typeof rest[rest.length - 1] === 'function' ? rest[rest.length - 1] : null;
      const idx = typeof sql === 'string' && cb ? compiled.findIndex((r) => r.re.test(sql)) : -1;
      if (idx < 0) return orig.call(this, sql, ...rest);
      const rule = compiled[idx];
      hit(idx);
      if (rule.mode === 'error') { setImmediate(() => cb.call({}, Object.assign(new Error('SQLITE_ERROR: injected query failure (test)'), { errno: 1, code: 'SQLITE_ERROR' }))); return this; }
      if (rule.mode === 'norow') { setImmediate(() => cb.call({}, null, undefined)); return this; }
      if (rule.mode === 'rows') { setImmediate(() => cb.call({}, null, rule.arg)); return this; }
      const wrapped = (err, res) => {
        if (err) return cb.call(this, err);
        if (rule.mode === 'dropcol') return cb.call(this, null, Array.isArray(res) ? res.filter((r) => r.name !== rule.arg) : res);
        if (rule.mode === 'patch') return cb.call(this, null, res && typeof res === 'object' ? Object.assign(res, rule.arg) : res);
        return cb.call(this, null, res);
      };
      return orig.call(this, sql, ...rest.slice(0, -1), wrapped);
    };
  }
}
`);
    const STUB_COMMON = `
'use strict';
const http = require('http');
const fs = require('fs');
const inst = process.env.SDH_INSTANCE;
const ver = (name) => ({ version: 'stub', name: 'stub', nameEn: 'stub', mode: 'isolated', instance: name === undefined ? inst : name, external: 'stub', background: 'off', commit: null });
if (process.env.STUB_PID_FILE) {
  let st = null;
  try { st = require(${JSON.stringify(LINE_PROC_PATH)}).getStartTime(process.pid); } catch (_) { st = null; }
  fs.appendFileSync(process.env.STUB_PID_FILE, process.pid + '|' + st + '\\n');
}
function serve(opts) {
  const t0 = Date.now();
  const srv = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/version') { res.end(JSON.stringify(ver(opts.instance))); return; }
    if (req.url === '/api/health/ready') {
      res.statusCode = opts.ready ? 200 : 503;
      const okm = { ready: true, code: null };
      // mixed：issue 一直是终态 INIT_FAILED，quick_log 启动后约 4.5 秒内是 NOT_READY（还在初始化）、之后就绪（窗口 > TERMINAL_STABLE_MS 1.5 秒 + 启动与轮询的余量，旧逻辑「任一终态即计时」必在 quick_log 就绪之前收尾）——「提前结束等待只在全部未就绪模块都是终态时触发」的判别夹具
      const mods = opts.ready ? { core: okm, issue: okm }
        : (opts.mixed ? { core: okm, issue: { ready: false, code: 'INIT_FAILED' }, quick_log: Date.now() - t0 < 4500 ? { ready: false, code: 'NOT_READY' } : okm }
          : (opts.failOnly ? { core: okm, issue: { ready: false, code: 'INIT_FAILED' } } : { core: okm, issue: { ready: false, code: 'INIT_FAILED' }, quick_log: { ready: false, code: 'NOT_READY' } }));
      res.end(JSON.stringify({ ok: !!opts.ready, instance: inst, mode: 'isolated', modules: mods }));
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
  const start = () => srv.listen(Number(process.env.PORT), '0.0.0.0');
  const delay = Number(process.env.STUB_LISTEN_DELAY_MS || 0);
  if (delay > 0) setTimeout(start, delay); else start();
  return srv;
}
`;
    const STUBS = {
        ok: `${STUB_COMMON}\nserve({ ready: true });\nsetInterval(() => {}, 1000);\n`,
        exit: "'use strict';\nconsole.error('stub exiting with 3');\nprocess.exit(3);\n",
        leak: "'use strict';\nconsole.error('LEAK jwt=' + process.env.JWT_SECRET + ' end');\nprocess.exit(5);\n",
        unready: `${STUB_COMMON}\nserve({ ready: false });\nsetInterval(() => {}, 1000);\n`,
        impostor: `${STUB_COMMON}\nserve({ ready: true, instance: 'test-someoneelse' });\nsetInterval(() => {}, 1000);\n`,
        // 启动期竞态桩：第一次启动（marker 文件不存在）按 STUB_MODE 失败，之后（第二次起）正常就绪。busy-* = 日志里有 SQLITE_BUSY 证据；plain-* = 同形失败但没有 BUSY 证据。
        //   busy-mixed  —— 第一次启动：日志有 BUSY 行；issue 一直 INIT_FAILED（终态），quick_log 启动后约 4.5 秒内 NOT_READY（非终态）、之后就绪 → 提前结束等待必须等到 quick_log 就绪（全部未就绪都终态）才触发，才能归因为竞态而重试；
        //   busy-always —— 每次启动都按 busy-ready 失败（不看 marker），直到启动次数超过 STUB_MAX_FAILS（默认 4，pid 文件行数）才放行一次成功——只为给「忽略重试上限」的错误实现一个有界的出口，不影响正确实现
        //                  （正确实现在 cap + 1 次启动后就失败返回）；
        //   noise-ready —— 每次启动都：issue INIT_FAILED，日志只有一行含「不影响启动」的 BUSY（代码作者声明不影响就绪）→ 不是竞态证据，不得重试。
        race: `${STUB_COMMON}
const marker = process.env.STUB_MARKER;
const first = !fs.existsSync(marker);
if (first) fs.writeFileSync(marker, 'x');
const mode = process.env.STUB_MODE;
const stamp = new Date().toISOString();
const startsSoFar = (() => { try { return fs.readFileSync(process.env.STUB_PID_FILE, 'utf8').split('\\n').filter(Boolean).length; } catch (_) { return 1; } })();
const valve = startsSoFar > Number(process.env.STUB_MAX_FAILS || 4);
if (first && mode === 'busy-ready') { console.error('[ERROR] ' + stamp + ' 建表 DDL 失败：SQLITE_BUSY: database is locked'); serve({ ready: false, failOnly: true }); }
else if (mode === 'busy-always' && !valve) { console.error('[ERROR] ' + stamp + ' 建表 DDL 失败：SQLITE_BUSY: database is locked'); serve({ ready: false, failOnly: true }); }
else if (first && mode === 'busy-mixed') { console.error('[ERROR] ' + stamp + ' 建表 DDL 失败：SQLITE_BUSY: database is locked'); serve({ ready: false, mixed: true }); }
else if (mode === 'noise-ready') { console.error('[ERROR] ' + stamp + ' [周期取数推送] M-2 僵尸 run 复位失败（不影响启动）：SQLITE_BUSY: database is locked'); serve({ ready: false, failOnly: true }); }
else if (first && mode === 'plain-ready') { console.error('[ERROR] ' + stamp + ' 建表 DDL 失败：boom'); serve({ ready: false, failOnly: true }); }
else if (first && mode === 'busy-crash') { console.error('[ERROR] ' + stamp + ' Uncaught Exception: [Error: SQLITE_BUSY: database is locked] {'); console.error('  errno: 5,'); console.error("  code: 'SQLITE_BUSY'"); console.error('}'); setTimeout(() => process.exit(1), 300); }
else if (first && mode === 'plain-crash') { console.error('[ERROR] ' + stamp + ' Uncaught Exception: [Error: boom] {'); console.error('  code: 5'); console.error('}'); setTimeout(() => process.exit(1), 300); }
else serve({ ready: true });
setInterval(() => {}, 1000);
`,
        hijack: `${STUB_COMMON}
const { spawn } = require('child_process');
const gc = spawn(process.execPath, ['-e', "const http=require('http');const fs=require('fs');let st=null;try{st=require(" + JSON.stringify(${JSON.stringify(LINE_PROC_PATH)}) + ").getStartTime(process.pid);}catch(_){}fs.appendFileSync(process.env.STUB_PID_FILE, process.pid+'|'+st+'\\\\n');const inst=process.env.SDH_INSTANCE;http.createServer((q,r)=>{r.setHeader('Content-Type','application/json');if(q.url==='/api/version'){r.end(JSON.stringify({version:'s',mode:'isolated',instance:inst}));return;}if(q.url==='/api/health/ready'){r.end(JSON.stringify({ok:true,instance:inst,mode:'isolated',modules:{core:{ready:true,code:null}}}));return;}r.statusCode=404;r.end('{}');}).listen(Number(process.env.PORT),'0.0.0.0');setTimeout(()=>process.exit(0),60000);"], { stdio: 'ignore', windowsHide: true });
setInterval(() => {}, 1000);
`,
    };
    for (const k of Object.keys(STUBS)) fs.writeFileSync(path.join(PRIV, `_stub-${k}.js`), STUBS[k]);
}
const stubPath = (k) => path.join(PRIV, `_stub-${k}.js`);

// ---------------------------------------------------------------- 引导（任何一步失败 → BOOT_ERROR，主流程第一件事就是报告并走统一清理）
try {
    fs.mkdirSync(TMP);
    process.env.TEMP = TMP;
    process.env.TMP = TMP;
    for (const k of Object.keys(process.env)) { if (/^sdh_/i.test(k)) delete process.env[k]; }   // 不分大小写：套件自己的环境先清干净
    for (const k of ['NODE_ENV', 'LOG_LEVEL', 'SYS_FASTLANE_ENABLE']) delete process.env[k];       // 合成 .env 的白名单键（来源标记）只能来自 .env，不能被调用方的环境盖住
    sqlite3 = require('sqlite3');
    RO = sqlite3.OPEN_READONLY;
    writeGuardFile();
    // 先装套件进程自己的守卫（在加载启动器及其数据库依赖之前）：只允许打开私有根 PRIV 内的合成库；越界抛错 + 写标记
    process.env.GUARD_ROOT = PRIV;
    process.env.GUARD_MARKER = GUARD_MARKER;
    process.env.GUARD_SQLITE3 = require.resolve('sqlite3');
    process.env.GUARD_MODE = 'throw';
    require(GUARD);
    common = require(path.join(WBS, '..', 'scripts', 'lines', 'line-common.js'));
    lstatOrNull = (p) => common.lstatOrNull(p);
    procLib = require(LINE_PROC_PATH);
    lineNew = require(path.join(WBS, '..', 'scripts', 'lines', 'line-new.js'));
    instanceDb = require(path.join(WBS, 'utils', 'instance-db.js'));
    aes = require(path.join(WBS, 'utils', 'aes-password.js'));
    jwt = require('jsonwebtoken');
    acorn = require('acorn');
    ti = require(LAUNCHER_PATH);
    // 套件里每一次启动都必须显式给私有根内的合成 server.js（合成检出或桩）：从运行套件的检出里启动就会读到那个检出的真实 .env。违反的记下来，Z.6 判红，并拒绝这次启动
    const rawStart = ti.startTestInstance;
    ti.startTestInstance = function startGuarded(opts) {
        const sj = opts && opts.serverJs;
        const inside = typeof sj === 'string' && path.resolve(sj).toLowerCase().startsWith(path.resolve(PRIV).toLowerCase() + path.sep);
        if (!inside) { START_VIOLATIONS.push(String(sj)); return Promise.reject(new Error(`套件拒绝启动：serverJs 不在私有根内（${String(sj)}）`)); }
        return rawStart.call(ti, opts);
    };
    healthUtil = require(HEALTH_UTIL);
    DB_CONN_CIPHER = aes.encryptWithKey(TEST_KEY, EXTERNAL_PASSWORD);
    writeFixtures();
    GUARD_ARGS = ['--require', GUARD];
    GUARD_ENV = {
        GUARD_ROOT: TMP, GUARD_MARKER, GUARD_SQLITE3: require.resolve('sqlite3'), GUARD_MODE: 'exit', GUARD_PORT_CHECK: '1', GUARD_PROBE_KEYS: JSON.stringify(ENV_NONWL_KEYS),
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require ${quoteOpt(GUARD)}`].filter(Boolean).join(' '),
    };
} catch (e) {
    BOOT_ERROR = e;
}

const RES_ROOT = path.join(PRIV, '资源 来源根');          // 路径段含中文 + 空格
const RES_FILES = [];                                       // { rel（相对 RES_ROOT）, buf }

/** 种一条带「真实形态密文」的外部库连接（单条 INSERT、一个字符串字面量——db_connections 直写登记守卫 verify-db-connections-writers 的约定）；地址用不可路由的 TEST-NET */
async function seedDbConnections(d, cipher) {
    await dbExec(d, `INSERT INTO db_connections (name, type, host, port, database, username, password, is_default, connection_type, source_system_code) VALUES ('ti-wh', 'sqlserver', '192.0.2.10', 1433, 'dw', 'sa', '${cipher}', 1, 'warehouse', NULL), ('ti-src', 'mysql', '192.0.2.11', 3306, 'hrd', 'ro', '${cipher}', 0, 'source', 'TI')`);
}

const ddlMin = () => [
    instanceDb.SYSTEM_CONFIGS_DDL,
    `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, display_name TEXT, role TEXT DEFAULT 'user', status TEXT DEFAULT 'active', created_at DATETIME DEFAULT (datetime('now', 'localtime')), phone TEXT, dingtalk_user_id TEXT, remark TEXT NOT NULL DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS db_connections (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, type TEXT DEFAULT 'sqlserver', host TEXT NOT NULL, port INTEGER DEFAULT 1433, database TEXT NOT NULL, default_schema TEXT DEFAULT 'dbo', username TEXT NOT NULL, password TEXT NOT NULL, is_default INTEGER DEFAULT 0, connection_type TEXT DEFAULT 'warehouse', source_system_code TEXT, created_at DATETIME DEFAULT (datetime('now', 'localtime')), updated_at DATETIME DEFAULT (datetime('now', 'localtime')))`,
];

/** 种子阶段实际写入的密文（按来源库文件分组）：钉钉四键 + 非白名单键的实际密文，A3.5 搜这些精确字节（加密用随机 IV，事后重新加密得到的不是写入的那份） */
const SEED_CIPHERS = new Map();
/** 往合成来源库里种「生产形态」配置：钉钉四键 + 白名单 7 键 + 一个非白名单键（都用测试密钥加密）+ 外部库口令；记下写入的密文 */
async function seedConfigs(d, file, opts) {
    await dbExec(d, 'DELETE FROM system_configs');
    const sink = [];
    const ins = async (k, v, track) => {
        const cipher = aes.encryptWithKey(TEST_KEY, v);
        if (track) sink.push({ label: k, text: cipher });
        await dbExec(d, `INSERT INTO system_configs (config_key, config_value_encrypted, updated_by_name) VALUES ('${k}', '${cipher}', 'ti-seed')`);
    };
    for (const k of Object.keys(REAL_DT)) await ins(k, REAL_DT[k], true);
    for (const k of Object.keys(WHITELIST_VALUES)) await ins(k, WHITELIST_VALUES[k], false);
    await ins('some_other_secret', EXTRA_SECRET, true);
    await seedDbConnections(d, opts && opts.connCipher !== undefined ? opts.connCipher : DB_CONN_CIPHER);
    SEED_CIPHERS.set(path.resolve(file).toLowerCase(), sink);
}
const seedCiphersOf = (file) => SEED_CIPHERS.get(path.resolve(file).toLowerCase()) || [];
/** 实例库字节里还搜得到的「写入来源库的旧密文 / 明文」（返回命中的标签；空 = 没有残留） */
function seedLeaks(dbBytes, ciphers) {
    const hits = [];
    for (const c of ciphers) if (dbBytes.includes(Buffer.from(c.text))) hits.push(c.label);
    for (const k of Object.keys(REAL_DT)) if (dbBytes.includes(Buffer.from(REAL_DT[k]))) hits.push(`${k}(plain)`);
    if (dbBytes.includes(Buffer.from(DB_CONN_CIPHER))) hits.push('db_connections.password');
    return hits;
}

/** 小型来源库（不起真实 server.js 的用例用）：只有 users / system_configs / db_connections */
async function buildMiniSource(file) {
    await withDb(file, undefined, async (d) => {
        for (const sql of ddlMin()) await dbExec(d, sql);
        await dbExec(d, "INSERT INTO users (username, password, display_name, role) VALUES ('ti-user', 'x', 'TI', 'user')");
        await seedConfigs(d, file);
    });
}

// ---------------------------------------------------------------- 资源来源根（合成）
function putRes(rel, buf) {
    const full = path.join(RES_ROOT, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, buf);
    RES_FILES.push({ rel: fwd(rel), buf });
}
// task_pool.file_path 的合成文件名（旧版单文件附件）：OPEN 行的文件在 uploads，ARCHIVED 行的文件在 archive；
//   「缺失」行的文件故意放在**另一个**目录里（OPEN-缺失 的在 archive、ARCHIVED-缺失 的在 uploads），这样把检查目录对调的错误实现会误判为「在」而被断言抓住
const TP_OPEN_OK = '7_1700000000_ok.sql';
const TP_OPEN_GONE = '7_1700000001_gone.sql';
const TP_ARCH_OK = '8_1700000002_arch-ok.sql';
const TP_ARCH_GONE = '8_1700000003_arch-gone.sql';
function buildResourceRoot() {
    putRes('uploads/ti-owner/1_title/a.sql', crypto.randomBytes(300));
    putRes('uploads/ti-owner/1_标题 空格/报告 一.xlsx', crypto.randomBytes(2048));
    putRes('uploads/ti-owner/empty.txt', Buffer.alloc(0));
    putRes(`uploads/${TP_OPEN_OK}`, Buffer.from('-- open ok\n'));
    putRes(`uploads/${TP_ARCH_GONE}`, Buffer.from('-- archived row but file only in uploads\n'));
    putRes('archive/docs-a.md', Buffer.from('# docs a\n中文\n'));
    putRes(`archive/${TP_ARCH_OK}`, Buffer.from('-- archived ok\n'));
    putRes(`archive/${TP_OPEN_GONE}`, Buffer.from('-- open row but file only in archive\n'));
    putRes('private/it-inspection-sheets/' + PHOTO_OK, crypto.randomBytes(512));
    putRes('periodic-results/aaa.xlsx', crypto.randomBytes(256));
    putRes('routes/it-ledger/uploads/it-reconcile/' + FILE_UUID_OK, crypto.randomBytes(256));
}
/** 往来源库（模板拷贝）里种引用资源文件的行：有的在、有的缺 */
async function seedResourceRefs(d) {
    await dbExec(d, "INSERT INTO task_attachments (task_id, attachment_type, file_name, original_name) VALUES (1, 'sql', 'ti-owner/1_title/a.sql', 'a.sql'), (1, 'sql', 'ti-owner/1_标题 空格/报告 一.xlsx', '报告 一.xlsx'), (1, 'sql', 'ti-owner/1_title/gone.sql', 'gone.sql')");
    const run = (file) => `INSERT INTO periodic_task_runs (task_id, rendered_script, task_name_snapshot, source_connection_snapshot, template_version_snapshot, triggered_by, date_range_start, date_range_end, started_at, status, result_file_path, file_status) VALUES (1, 's', 'n', 'c', 1, 1, '2026-01-01', '2026-02-01', '2026-02-01 00:00:00', 'success', '${file}', 'present')`;
    await dbExec(d, run('D:\\\\old-checkout\\\\periodic-results\\\\aaa.xlsx'));
    await dbExec(d, run('D:\\\\old-checkout\\\\periodic-results\\\\bbb.xlsx'));
    const meta = (n) => JSON.stringify({ filename: 'x.xlsx', stored_name: n });
    await dbExec(d, `INSERT INTO it_reconciles (title, status, source_meta, created_by) VALUES ('ok', 'open', '${meta(FILE_UUID_OK)}', 1), ('gone', 'open', '${meta(FILE_UUID_GONE)}', 1)`);
    // task_pool.file_path（旧版单文件附件）：非 ARCHIVED 的对 uploads 核，ARCHIVED 的对 archive 核；NULL / 空串不计
    await dbExec(d, `INSERT INTO task_pool (title, status, file_path) VALUES ('tp-open-ok', 'OPEN', '${TP_OPEN_OK}'), ('tp-open-gone', 'OPEN', '${TP_OPEN_GONE}'), ('tp-arch-ok', 'ARCHIVED', '${TP_ARCH_OK}'), ('tp-arch-gone', 'ARCHIVED', '${TP_ARCH_GONE}'), ('tp-arch-null', 'ARCHIVED', NULL), ('tp-open-empty', 'OPEN', '')`);
}

// ---------------------------------------------------------------- 全局清点
const startedHandles = [];
async function stopAll() {
    for (const h of startedHandles) { try { await h.stop(); } catch (_) { /* 兜底收口，失败由各用例自己的断言报告 */ } }
}

/** 取服务主进程的环境快照（守卫写在数据根里） */
function readSnapshots(dataDir) {
    const out = [];
    for (const n of fs.readdirSync(dataDir)) {
        if (/^env-\d+\.json$/.test(n)) { try { out.push(JSON.parse(fs.readFileSync(path.join(dataDir, n), 'utf8'))); } catch (_) { /* 半截写入 */ } }
    }
    return out;
}
const serverSnap = (dataDir, pid) => readSnapshots(dataDir).find((s) => s.pid === pid) || null;
function readLate(dataDir, pid) {
    const f = path.join(dataDir, `late-env-${pid}.json`);
    try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; } catch (_) { return null; }
}
const lateOf = (h) => waitUntil(() => readLate(h.dataDir, h.pid), 20000, 200);

/** 子进程环境快照里，哪些键的值的 sha256 等于敏感值的 sha256（来源键、钉钉真值、外部库口令、非白名单 .env 值……）。快照不存在 / 为空 → 返回 null（不能当「没有泄漏」） */
function envValueLeaks(snap) {
    if (!snap || !snap.vals || Object.keys(snap.vals).length < 10) return null;
    // 长度 < 8 的值（如 SYS_TEST_HOOKS=1）不进哈希比对：'1' 这类值与无关的环境变量（CLAUDECODE=1、SHLVL=1……）必然撞，改由逐键的「存在且为空串」断言（E1.2 / B4 / F15）负责
    const bad = new Set([TEST_KEY, WRONG_KEY, ...Object.values(REAL_DT), EXTRA_SECRET, EXTERNAL_PASSWORD, ENV_FILE_KEY, ...ENV_NONWL_VALUES, ...ENV_SYS_VALUES].filter((v) => String(v).length >= 8).map((v) => sha256(String(v))));
    return Object.entries(snap.vals).filter(([, h]) => bad.has(h)).map(([k]) => k);
}

// ---------------------------------------------------------------- 合成检出（所有真服务都从这里启动）
const TREE = path.join(PRIV, 'checkout');
function buildCheckout() {
    fs.mkdirSync(TREE);
    fs.copyFileSync(path.join(SERVER_TREE, 'server.js'), path.join(TREE, 'server.js'));
    fs.copyFileSync(path.join(WBS, 'package.json'), path.join(TREE, 'package.json'));
    for (const d of ['routes', 'utils', 'public']) common.copyTreeNoFollow(path.join(SERVER_TREE, d), path.join(TREE, d));
    fs.symlinkSync(fs.realpathSync.native(path.join(WBS, 'node_modules')), path.join(TREE, 'node_modules'), 'junction');   // 让合成检出里的 server.js 能解析依赖（工作树本身也是这么做的）
    fs.writeFileSync(path.join(TREE, '.env'), [...ENV_FILE_ENTRIES, ...ENV_SYS_ENTRIES].map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
    if (CHECKOUT_IDENTITY !== null) fs.writeFileSync(path.join(TREE, '.sdh-instance'), `${CHECKOUT_IDENTITY}\n`);   // 本检出是线时，合成检出也带同一份线身份（服务端核对库内父身份取它）
}
function removeCheckout() {
    if (lstatOrNull(TREE) === null) return;
    common.removeLinkChecked(path.join(TREE, 'node_modules'));
    common.deleteTreeNoFollow(fs.realpathSync.native(TREE), []);
    fs.rmdirSync(TREE);
}
const treeServerJs = () => path.join(TREE, 'server.js');
const realServerOpts = () => ({ serverJs: treeServerJs(), nodeArgs: [...GUARD_ARGS, '--require', LATE_PROBE], extraEnv: GUARD_ENV });
const stubOpts = (k, extra) => ({ serverJs: stubPath(k), nodeArgs: GUARD_ARGS, extraEnv: Object.assign({}, GUARD_ENV, extra || {}) });

/**
 * 起真服务（合成检出里的 server.js）。已知的既有问题（PROJECT_STATUS #122，启动期 SQLITE_BUSY 竞态）的有界重试在启动器里（startupRaceRetries，只在有 BUSY 证据时重试），
 * 套件不再自己重试；这里只统计「首次通过 / 重试后通过 / 失败」。
 */
const REAL_STARTS = { first: 0, retried: 0, failed: 0, retries: 0, detail: [] };
async function startReal(label, opts) {
    try {
        const h = await ti.startTestInstance(opts);
        if (h.startupRaceRetries > 0) { REAL_STARTS.retried += 1; REAL_STARTS.retries += h.startupRaceRetries; REAL_STARTS.detail.push({ label, retries: h.startupRaceRetries }); } else REAL_STARTS.first += 1;
        return h;
    } catch (e) {
        REAL_STARTS.failed += 1;
        throw e;
    }
}

async function captureStderr(fn) {
    const orig = process.stderr.write;
    let buf = '';
    process.stderr.write = function (chunk) { buf += String(chunk); return true; };
    try { return { value: await fn(), error: null, stderr: buf }; } catch (e) { return { value: null, error: e, stderr: buf }; } finally { process.stderr.write = orig; }
}

// ================================================================ 主流程
let TEMPLATE = null;
let SRC_FULL = null;          // 完整合成来源库（模板拷贝 + 种子）
let SRC_BROKEN = null;        // 同上但 issues 表被造成「有数据 + 缺关键列」→ issue 模块 INIT_FAILED、issue_v1750 NOT_READY
let SRC_COREIDX = null;       // 同 SRC_FULL 但 task_pool 唯一索引被删且数据违反它 → initTable 里建索引失败（只记日志后继续）→ core 不就绪
let SRC_MINI = null;

async function setup() {
    buildResourceRoot();
    SRC_MINI = path.join(PRIV, '来源 目录 mini', 'mini.db');
    fs.mkdirSync(path.dirname(SRC_MINI), { recursive: true });
    await buildMiniSource(SRC_MINI);
    if (!(want('A') || want('B') || want('X') || want('E'))) return;
    buildCheckout();
    // 预热：空库首启让 initTable 建完全部表（空库首启有既有竞态会触发 process.exit(1)，预加载 noExit 吞掉它，与 verify-instance-startup 同做法）
    const emptySrc = path.join(PRIV, '来源 目录 empty', 'empty.db');
    fs.mkdirSync(path.dirname(emptySrc), { recursive: true });
    await withDb(emptySrc, undefined, (d) => dbExec(d, 'CREATE TABLE t(x)'));
    let warm = null;
    try {
        // 空库首启有既有的启动竞态（ALTER 先于 CREATE TABLE、建索引先于加列……，见交付报告的探针清单）：这些语句失败后只记日志继续，现在如实汇入 core，所以预热不等 core
        //   （首启之后留下的模板库里表都已建好，后面所有用例都从模板拷贝出发，不再有这些失败）
        warm = await startReal('预热', Object.assign({ sourceDbPath: emptySrc, sourceEncryptionKey: null, readyTimeoutMs: 90000, modules: EXPECTED_MODULES.filter((m) => m !== 'core') }, realServerOpts(), { nodeArgs: [...GUARD_ARGS, '--require', NOEXIT] }));
        startedHandles.push(warm);
        check('S.1', '预热：空来源库经启动器起真服务（合成检出里的 server.js），除 core 外的 10 个模块全部就绪（空库首启的既有竞态让 core 如实报未就绪，不影响模板建表）', warm.modules && Object.keys(warm.modules).length === 11 && Object.entries(warm.modules).every(([n, m]) => n === 'core' || m.ready === true), warm.modules);
        TEMPLATE = path.join(PRIV, 'template.db');
        await withDb(warm.dbPath, RO, (d) => new Promise((res, rej) => d.run('VACUUM INTO ?', [TEMPLATE], (e) => (e ? rej(e) : res()))));
        let warmStopErr = null;
        try { await warm.stop(); } catch (e) { warmStopErr = e; }
        check('S.2', '预热实例已停止、数据根已删', warmStopErr === null && lstatOrNull(warm.dataDir) === null && !alive(warm.pid), warmStopErr && warmStopErr.message);
    } catch (e) {
        check('S.1', '预热：空来源库经启动器起真服务', false, `${e.code} ${e.message}\n${e.logTail || ''}`);
        throw e;
    }
    const tables = await withDb(TEMPLATE, RO, (d) => dbAll(d, "SELECT count(*) AS n FROM sqlite_master WHERE type='table'"));
    check('S.3', `模板库建出业务表（${tables[0].n} 张 > 50）`, tables[0].n > 50);
    // 完整合成来源：模板拷贝，去掉身份表（使其不是隔离库），种配置 / 外部库口令 / 资源引用
    SRC_FULL = path.join(PRIV, '来源 目录 full', 'full.db');
    fs.mkdirSync(path.dirname(SRC_FULL), { recursive: true });
    fs.copyFileSync(TEMPLATE, SRC_FULL);
    await withDb(SRC_FULL, undefined, async (d) => {
        await dbExec(d, 'DROP TABLE IF EXISTS _sdh_instance');
        await dbExec(d, 'DELETE FROM documents');   // Doc Sync 启动时没有大批「无回调 DELETE」可做（#122 的两个触发点之一，见交付报告）
        await seedConfigs(d, SRC_FULL);
        await seedResourceRefs(d);
    });
    const docRows = await withDb(SRC_FULL, RO, (d) => dbAll(d, 'SELECT count(*) AS n FROM documents'));
    check('S.4', '合成来源库的 documents 表是空的（Doc Sync 启动时不会对模板里的旧文档行逐条无回调 DELETE）', docRows[0].n === 0, docRows);
    if (want('X')) {
        SRC_BROKEN = path.join(PRIV, '来源 目录 broken', 'broken.db');
        fs.mkdirSync(path.dirname(SRC_BROKEN), { recursive: true });
        fs.copyFileSync(SRC_FULL, SRC_BROKEN);
        await withDb(SRC_BROKEN, undefined, async (d) => {
            await dbExec(d, 'DROP TABLE IF EXISTS issues');
            await dbExec(d, 'CREATE TABLE issues (id INTEGER PRIMARY KEY, title TEXT)');
            await dbExec(d, "INSERT INTO issues (title) VALUES ('seed row so the table counts as having data')");
        });
        SRC_COREIDX = path.join(PRIV, '来源 目录 coreidx', 'coreidx.db');
        fs.mkdirSync(path.dirname(SRC_COREIDX), { recursive: true });
        fs.copyFileSync(SRC_FULL, SRC_COREIDX);
        await withDb(SRC_COREIDX, undefined, async (d) => {
            await dbExec(d, 'DROP INDEX IF EXISTS idx_task_pool_one_active_per_model');
            await dbExec(d, "INSERT INTO task_pool (title, status, linked_model_id) VALUES ('dup-a', 'OPEN', 9001), ('dup-b', 'OPEN', 9001)");
        });
    }
}

// ---------------------------------------------------------------- 节 G：守卫自检（套件进程自己的数据库路径守卫）
async function sectionG() {
    console.log('\n== 节 G：数据库路径守卫自检（套件进程）==');
    const marker2 = path.join(PRIV, 'guard-selftest.marker');
    const savedMarker = process.env.GUARD_MARKER;
    process.env.GUARD_MARKER = marker2;   // 自检用单独的标记文件：不污染 Z.3「守卫从未触发」
    const outside = path.join(REAL_TMP, `sdh-guard-selftest-${crypto.randomBytes(5).toString('hex')}.db`);
    let errOut = null;
    let errMem = null;
    let insideOk = false;
    try {
        try { new sqlite3.Database(outside); } catch (e) { errOut = e; }
        const inside = path.join(PRIV, 'guard-inside.db');
        await withDb(inside, undefined, (d) => dbExec(d, 'CREATE TABLE t(x)'));
        insideOk = fs.existsSync(inside);
        try { await withDb(':memory:', undefined, (d) => dbExec(d, 'CREATE TABLE t(x)')); } catch (e) { errMem = e; }
    } finally {
        process.env.GUARD_MARKER = savedMarker;
    }
    check('G.1', '套件进程里试打开私有根之外的一个合成路径（真实临时目录下）→ 被拦（抛 GUARD_TRIPPED），且该文件没有被创建', errOut && /GUARD_TRIPPED:OPEN_OUTSIDE_TEST_ROOT/.test(errOut.message) && !fs.existsSync(outside), errOut && errOut.message);
    check('G.2', '守卫自检的标记写进了自检专用文件，没有碰 Z.3 的标记；私有根内的库、:memory: 照常放行', fs.existsSync(marker2) && /OPEN_OUTSIDE_TEST_ROOT/.test(fs.readFileSync(marker2, 'utf8')) && !fs.existsSync(GUARD_MARKER) && insideOk && errMem === null);
    try { if (fs.existsSync(outside)) fs.unlinkSync(outside); } catch (_) { /* 守卫失效时的善后 */ }
}

// ---------------------------------------------------------------- 节 A：正常启动 / 就绪接口 / 实例库 / 资源 / 停止
const EXPECTED_MODULES = ['collab_dualcheck', 'core', 'correction', 'issue', 'issue_lite', 'issue_v1750', 'it_ledger', 'legacy_archive', 'periodic', 'quick_log', 'sys_iteration'];

async function sectionA() {
    console.log('\n== 节 A：正常启动 / 汇总就绪接口 / 实例库 / 资源复制 / 停止 ==');
    const srcShaBefore = sha256(fs.readFileSync(SRC_FULL));
    const dirsBefore = tmpInstanceDirs();
    const A = await startReal('A', Object.assign({ sourceDbPath: SRC_FULL, sourceEncryptionKey: TEST_KEY, resources: ['uploads', 'archive', 'private', 'periodic-results', 'reconcile'], resourceRoot: RES_ROOT, readyTimeoutMs: 60000 }, realServerOpts()));
    startedHandles.push(A);
    const handleJson = JSON.stringify(A, (k, v) => (typeof v === 'function' ? undefined : v));

    // ---- A1 正常启动
    check('A1.1', '返回 baseUrl / port(20000–49999) / instance(test-<hex>) / dbPath / dataDir / pid / startTime / stop', A.baseUrl === `http://127.0.0.1:${A.port}` && A.port >= 20000 && A.port <= 49999 && /^test-[0-9a-f]{10}$/.test(A.instance)
        && fwd(A.dbPath).startsWith(fwd(A.dataDir)) && Number.isSafeInteger(A.pid) && A.pid > 0 && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(A.startTime) && typeof A.stop === 'function' && typeof A.jwtSecret === 'string' && A.jwtSecret.length >= 32, handleJson);
    check('A1.2', '数据根在 os.tmpdir() 下的 sdh-test-* 里', path.dirname(A.dataDir).toLowerCase() === TMP.toLowerCase() && /^sdh-test-/.test(path.basename(A.dataDir)) && !dirsBefore.includes(path.basename(A.dataDir)), A.dataDir);
    const ver = await httpJson(A.port, 'GET', '/api/version');
    check('A1.3', '/api/version：instance = 本次身份、mode = isolated、external = stub、background = off', ver.status === 200 && ver.json && ver.json.instance === A.instance && ver.json.mode === 'isolated' && ver.json.external === 'stub' && ver.json.background === 'off', ver.json);
    const adminToken = jwt.sign({ id: 1, username: 'admin', role: 'admin', display_name: '管理员' }, A.jwtSecret, { expiresIn: '10m' });
    const me = await httpJson(A.port, 'GET', '/api/auth/me', undefined, adminToken);
    const badToken = jwt.sign({ id: 1, username: 'admin', role: 'admin', display_name: '管理员' }, `${A.jwtSecret}-other`, { expiresIn: '10m' });
    const meBad = await httpJson(A.port, 'GET', '/api/auth/me', undefined, badToken);
    check('A1.4', '返回的 jwtSecret 签出的 token 被服务接受（/api/auth/me 200 且 id = 1）；换一把密钥签的被拒绝（对照）', me.status === 200 && me.json && me.json.id === 1 && meBad.status !== 200, { me: me.status, meBad: meBad.status });
    const man = JSON.parse(fs.readFileSync(path.join(A.dataDir, ti.MANIFEST_FILE), 'utf8'));
    check('A1.5', '实例清单：instance / parent / pid(启动器) / pidStartTime / createdAt / dir 齐全，且追加 serverPid = 返回的 pid、serverStartTime = 返回的 startTime', man.instance === A.instance && man.parent === EXPECTED_PARENT && man.pid === process.pid && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(man.pidStartTime)
        && typeof man.createdAt === 'string' && fwd(man.dir) === fwd(A.dataDir) && man.serverPid === A.pid && man.serverStartTime === A.startTime && man.port === A.port, man);
    const info = procLib.getProcInfo(A.pid);
    check('A1.6', '返回的 startTime 就是该 PID 现场的精确创建时间，命令行是 node + 合成检出里的 server.js', info && info.start_time === A.startTime && info.cmdline.replace(/"/g, '').replace(/\//g, '\\').toLowerCase().includes(treeServerJs().replace(/\//g, '\\').toLowerCase()), info);
    check('A1.7', '端口监听者恰好是服务子进程（netstat 两个协议栈）', JSON.stringify(procLib.portListeners(A.port)) === JSON.stringify([A.pid]), procLib.portListeners(A.port));
    check('A1.8', '检出 / 来源库 / 返回值：来源库 sha256 前后不变；返回值里没有来源键和明文配置', sha256(fs.readFileSync(SRC_FULL)) === srcShaBefore && !handleJson.includes(TEST_KEY) && !handleJson.includes(EXTRA_SECRET) && !handleJson.includes('Pr0dPassw0rd'));
    const lateA = await lateOf(A);
    check('A1.9', '来源标记：被测服务实际加载的是合成检出里的 server.js 与合成 .env（晚探针：argv[1] = 合成检出的 server.js；白名单键 NODE_ENV = 合成 .env 里的来源标记值，且调用方环境里本来没有它）', lateA && sameFile(lateA.argv1, treeServerJs()) && lateA.nodeEnv === ENV_MARKER_VALUE, lateA);

    // ---- A2 汇总就绪接口
    const h = await httpJson(A.port, 'GET', '/api/health/ready');
    const names = h.json && h.json.modules ? Object.keys(h.json.modules).sort() : [];
    check('A2.1', '/api/health/ready 未登录 200，结构 { ok, instance, mode, modules }', h.status === 200 && h.json && JSON.stringify(Object.keys(h.json).sort()) === JSON.stringify(['instance', 'mode', 'modules', 'ok']) && h.json.instance === A.instance && h.json.mode === 'isolated' && h.json.ok === true, h);
    check('A2.2', '模块名全集（11 个）', JSON.stringify(names) === JSON.stringify(EXPECTED_MODULES), names);
    check('A2.3', '每个模块 { ready: true, code: null } 且 ok 与各模块一致（含 core：正常启动时 ALTER 的 duplicate column 幂等失败不算失败）', names.length === 11 && names.every((n) => h.json.modules[n].ready === true && h.json.modules[n].code === null && JSON.stringify(Object.keys(h.json.modules[n]).sort()) === '["code","ready"]') && h.json.ok === names.every((n) => h.json.modules[n].ready));
    check('A2.4', '启动器返回的 modules 就是就绪时的汇总（全部 ready）', A.modules && Object.keys(A.modules).length === 11 && Object.values(A.modules).every((m) => m.ready === true));

    // ---- A3 实例库
    const idc = await instanceDb.checkInstanceIdentity(A.dbPath, { expectedInstance: A.instance, expectedParent: EXPECTED_PARENT });
    check('A3.1', '库内身份 = 本次身份，父检出身份 = 本检出身份（主工作区 main，线内是线名）', idc.ok, idc);
    const cfgRows = await withDb(A.dbPath, RO, (d) => dbAll(d, 'SELECT config_key, config_value_encrypted FROM system_configs'));
    const cfgMap = Object.fromEntries(cfgRows.map((r) => [r.config_key, r.config_value_encrypted]));
    const dec = (k) => { try { return aes.decryptWithKey(aes.ISOLATED_ENCRYPTION_KEY, cfgMap[k]); } catch (_) { return undefined; } };
    check('A3.2', '钉钉四键是虚拟值（隔离键可解），真值不在', Object.keys(instanceDb.VIRTUAL_DINGTALK_CONFIG).every((k) => dec(k) === instanceDb.VIRTUAL_DINGTALK_CONFIG[k]) && !Object.keys(REAL_DT).some((k) => dec(k) === REAL_DT[k]));
    const connRows = await withDb(A.dbPath, RO, (d) => dbAll(d, 'SELECT password FROM db_connections'));
    check('A3.3', 'db_connections 口令全部为空串（2 行）', connRows.length === 2 && connRows.every((r) => r.password === ''), connRows);
    check('A3.4', '白名单 7 键按隔离键可解且明文与来源一致；非白名单键已删', Object.keys(WHITELIST_VALUES).every((k) => dec(k) === WHITELIST_VALUES[k]) && !('some_other_secret' in cfgMap)
        && JSON.stringify(A.isolatedDb.configRewritten) === JSON.stringify(Object.keys(WHITELIST_VALUES).sort()) && A.isolatedDb.configDropped.some((x) => x.key === 'some_other_secret' && x.reason === 'not_whitelisted'), A.isolatedDb);
    const dbBytes = fs.readFileSync(A.dbPath);
    const seeds = seedCiphersOf(SRC_FULL);
    check('A3.5', `实例库文件里搜不到种子阶段**实际写入**的密文（钉钉四键 + 非白名单键共 ${seeds.length} 份精确字节）/ 钉钉明文 / 外部库口令密文（secure_delete）`, seeds.length === 5 && seedLeaks(dbBytes, seeds).length === 0, seedLeaks(dbBytes, seeds));
    // 反例：只保留旧配置密文、外部库口令已清的库——同一个断言必须判红（证明 A3.5 有判别力，且不靠「重新加密」得到不同字节）
    const doctored = path.join(PRIV, 'doctored-leak.db');
    await withDb(doctored, undefined, async (d) => {
        for (const sql of ddlMin()) await dbExec(d, sql);
        await seedConfigs(d, doctored, { connCipher: '' });   // 配置旧密文都在，外部库口令已是空串（走同一个登记过的 seedDbConnections）
    });
    const doctoredHits = seedLeaks(fs.readFileSync(doctored), seedCiphersOf(doctored));
    check('A3.5b', '反例（只保留旧配置密文、外部库口令已清的库）→ 同一断言函数报出残留：钉钉四键 + 非白名单键的 5 份密文都命中（即使口令已清）', ['dingtalk_app_key', 'dingtalk_app_secret', 'dingtalk_robot_code', 'platform_base_url', 'some_other_secret'].every((l) => doctoredHits.includes(l)), doctoredHits);
    const snapA = serverSnap(A.dataDir, A.pid);
    const leaksA = envValueLeaks(snapA);
    check('A3.6', '服务子进程环境（守卫在任何业务代码之前取的快照：全部环境值的 sha256）：DB_ENCRYPTION_KEY 存在且为空串；没有任何一个值的哈希等于来源键 / 钉钉真值 / 外部库口令 / 合成 .env 里任一非白名单值', snapA && snapA.env3 && snapA.env3.DB_ENCRYPTION_KEY === '' && leaksA !== null && leaksA.length === 0, { env3: snapA && snapA.env3, leaks: leaksA });
    check('A3.6b', '反例（环境值泄漏判定的判别力）：快照里有一个值的哈希等于来源键 → envValueLeaks 报出该键；无关值不报；快照缺失 / 为空返回 null（不当作「没泄漏」）', JSON.stringify(envValueLeaks({ vals: Object.assign(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`K${i}`, sha256(`harmless-${i}`)])), { TI_SRC_LEAK: sha256(TEST_KEY) }) })) === '["TI_SRC_LEAK"]' && envValueLeaks(null) === null && envValueLeaks({ vals: {} }) === null);

    // ---- A5 资源复制
    const tgt = ti._internals.targetResourceDirs(A.dataDir);
    const copied = RES_FILES.map((f) => {
        const top = f.rel.split('/')[0];
        const sub = f.rel.slice(top.length + 1);
        const base = top === 'routes' ? tgt['it-reconcile'] : tgt[top];
        const rel = top === 'routes' ? sub.replace(/^it-ledger\/uploads\/it-reconcile\//, '') : sub;
        return { f, full: path.join(base, rel) };
    });
    check('A5.1', '五类资源都复制到数据根对应位置（含中文 + 空格文件名与空文件；资源名用方案里的公开名 reconcile），内容 sha256 与来源一致', copied.every(({ f, full }) => fs.existsSync(full) && sha256(fs.readFileSync(full)) === sha256(f.buf)), copied.filter(({ f, full }) => !fs.existsSync(full)).map((c) => c.full));
    const walkLinks = (dir) => {
        const bad = [];
        const rec = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); const st = fs.lstatSync(p); if (st.isSymbolicLink()) bad.push(p); else if (st.isDirectory()) { if (fs.realpathSync.native(p).toLowerCase() !== path.join(fs.realpathSync.native(d), n).toLowerCase()) bad.push(p); rec(p); } } };
        rec(dir);
        return bad;
    };
    check('A5.2', '复制后的资源目录本身和里面都没有任何链接 / 重解析点（不是目录联接）', ['uploads', 'archive', 'private', 'periodic-results', 'it-reconcile'].every((r) => !fs.lstatSync(tgt[r]).isSymbolicLink() && fs.realpathSync.native(tgt[r]).toLowerCase() === path.join(fs.realpathSync.native(A.dataDir), path.basename(tgt[r])).toLowerCase() && walkLinks(tgt[r]).length === 0) && A.resources.length === 5 && A.resources.every((r) => r.sourceMissing === false && r.files >= 1), A.resources);
    const mr = A.missingResources;
    const missKey = (m) => `${m.resource}|${m.table}`;
    check('A5.3', '库里引用但文件缺失的恰好列在 missingResources.missing（uploads/task_attachments 1、periodic-results/periodic_task_runs 1、it-reconcile/it_reconciles 1、uploads/task_pool 1（OPEN 行的文件只在 archive 里）、archive/task_pool 1（ARCHIVED 行的文件只在 uploads 里）），在的不列', mr.missingTotal === 5
        && JSON.stringify(mr.missing.map(missKey).sort()) === JSON.stringify(['archive|task_pool', 'it-reconcile|it_reconciles', 'periodic-results|periodic_task_runs', 'uploads|task_attachments', 'uploads|task_pool'])
        && mr.missing.find((m) => m.table === 'task_attachments').ref === 'ti-owner/1_title/gone.sql'
        && mr.missing.find((m) => m.resource === 'uploads' && m.table === 'task_pool').ref === TP_OPEN_GONE && mr.missing.find((m) => m.resource === 'archive' && m.table === 'task_pool').ref === TP_ARCH_GONE, mr);
    const chk = (table, res) => mr.checked.find((c) => c.table === table && (res === undefined || c.resource === res));
    check('A5.4', '能查的表逐个列出（含行数）；task_pool 按 status 拆成 uploads（OPEN 2 行含 1 缺）/ archive（ARCHIVED 2 行含 1 缺，NULL / 空串不计）；表不存在的标 tableAbsent；archive 的「未建引用检查」文案不再说「没有引用 archive 的表」',
        chk('task_attachments') && chk('task_attachments').rows === 3 && chk('task_attachments').missing === 1 && chk('it_inspection_sheet_photos') && chk('it_inspection_sheet_photos').tableAbsent === true
        && chk('task_pool', 'uploads') && chk('task_pool', 'uploads').rows === 2 && chk('task_pool', 'uploads').missing === 1 && chk('task_pool', 'archive') && chk('task_pool', 'archive').rows === 2 && chk('task_pool', 'archive').missing === 1
        && mr.checked.length === 7 + 1 + 1 + 1 + 1 + 1 && mr.unchecked.some((u) => u.resource === 'archive' && /^未建引用检查/.test(u.reason) && /task_pool/.test(u.reason) && !/库中没有引用 archive 目录文件的表/.test(u.reason)) && mr.unchecked.some((u) => u.resource === 'private' && /未建引用检查/.test(u.reason)), mr);

    // ---- A6 停止与清理
    const decoyDir = path.join(PRIV, 'decoy');
    fs.mkdirSync(decoyDir);
    fs.writeFileSync(path.join(decoyDir, 'sentinel.txt'), 'must survive');
    fs.symlinkSync(decoyDir, path.join(A.dataDir, 'private', 'decoy-link'), 'junction');
    const portA = A.port; const pidA = A.pid; const startA = A.startTime; const dirA = A.dataDir;
    const sp1 = A.stop();
    const sp2 = A.stop();
    let stopErrA = null;
    try { await sp1; } catch (e) { stopErrA = e; }
    check('A6.1', 'stop() 成功，且幂等（第二次调用同一个 Promise 且同样成功；成功后再调用仍是那个缓存的成功结果）', stopErrA === null && sp1 === sp2 && (await sp2) === undefined && A.stop() === sp1, stopErrA && stopErrA.message);
    let idState = null;
    try { idState = procLib.checkIdentity({ pid: pidA, start_time: startA }).state; } catch (e) { idState = `ERR ${e.code}`; }
    check('A6.2', '进程消失（PID + 创建时间核对：dead 或 PID 已被复用）', idState === 'dead' || idState === 'reused', idState);
    check('A6.3', '端口上没有 LISTENING（netstat 两个协议栈）', Array.isArray(procLib.portListeners(portA)) && procLib.portListeners(portA).length === 0, procLib.portListeners(portA));
    check('A6.4', '数据根删除干净（lstat ENOENT）；数据根里的目录联接只拆链接本身，目标目录与里面的文件原样保留', lstatOrNull(dirA) === null && fs.existsSync(path.join(decoyDir, 'sentinel.txt')) && fs.readFileSync(path.join(decoyDir, 'sentinel.txt'), 'utf8') === 'must survive');
    check('A6.5', '守卫未触发（没有打开私有临时根之外的库 / 监听别的端口）', !fs.existsSync(GUARD_MARKER), fs.existsSync(GUARD_MARKER) ? fs.readFileSync(GUARD_MARKER, 'utf8') : '');
    // 资源引用清单与线工具同源：每个 ATTACHMENT_SOURCES 的表都有对应检查；task_pool 拆成 uploads / archive 两条
    const refs = ti.RESOURCE_REFERENCES;
    const flat = Object.entries(refs).flatMap(([res, list]) => list.map((r) => `${res}|${r.table}`));
    const expectFlat = lineNew.ATTACHMENT_SOURCES.filter((s) => s.table !== 'task_pool').map((s) => `${({ uploads: 'uploads', inspection: 'private', periodic: 'periodic-results', reconcile: 'it-reconcile' })[s.root]}|${s.table}`).concat(['uploads|task_pool', 'archive|task_pool']);
    check('A5.5', '启动器的资源引用清单与 scripts/lines/line-new.js 的 ATTACHMENT_SOURCES 逐项相等（task_pool 拆成 uploads / archive 两条）', JSON.stringify(flat.sort()) === JSON.stringify(expectFlat.sort()), { flat, expectFlat });
}

// ---------------------------------------------------------------- 节 B：环境剔除
async function sectionB() {
    console.log('\n== 节 B：子进程环境剔除 ==');
    const decoyDb = path.join(PRIV, 'decoy-db-should-not-exist', 'decoy.db');
    const saved = {};
    const set = (k, v) => { saved[k] = process.env[k]; process.env[k] = v; };
    set('sdh_db_file', decoyDb);                       // 小写：win32 上与 SDH_DB_FILE 是同一个变量名
    set('Sdh_Instance', 'test-impostor');
    set('SDH_data_dir', path.join(PRIV, 'decoy-data'));
    set('sdh_external', 'real');
    set('Sdh_Background_Jobs', 'on');
    set('PORT', '3000');
    set('JWT_SECRET', 'decoy-jwt-secret-for-env-test');
    set('Sdh_Extra_Flag', '1');                          // 不在启动器显式设置的 5 个键里：只有「按前缀、不分大小写整体剔除」才挡得住
    set('DB_ENCRYPTION_KEY', 'decoy-db-key-for-env-test-0123456789');
    set('Webhook_Secret', 'decoy-webhook');              // 大小写变体：win32 上与 WEBHOOK_SECRET 同名
    set('sys_test_hooks', '1');
    let B = null;
    try {
        B = await startReal('B', Object.assign({ sourceDbPath: SRC_FULL, sourceEncryptionKey: TEST_KEY, readyTimeoutMs: 60000 }, realServerOpts()));
        startedHandles.push(B);
    } finally {
        for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
        for (const k of Object.keys(process.env)) { if (/^sdh_/i.test(k)) delete process.env[k]; }
    }
    const ver = await httpJson(B.port, 'GET', '/api/version');
    check('B1', '父环境放大小写混合的 SDH_*（冒名 / 指向别处 / external=real / background=on）和 PORT=3000：子进程仍用本次身份、stub、off、本次端口', ver.json && ver.json.instance === B.instance && ver.json.mode === 'isolated' && ver.json.external === 'stub' && ver.json.background === 'off' && B.port !== 3000, ver.json);
    check('B2', '本次库就是实例库（身份核对通过），诱饵库路径没有被创建', (await instanceDb.checkInstanceIdentity(B.dbPath, { expectedInstance: B.instance, expectedParent: EXPECTED_PARENT })).ok && !fs.existsSync(path.dirname(decoyDb)) && !fs.existsSync(path.join(PRIV, 'decoy-data')));
    const snap = serverSnap(B.dataDir, B.pid);
    const sdhKeys = snap ? snap.keys.filter((k) => /^sdh_/i.test(k)).sort() : null;
    check('B3', '子进程环境（守卫在任何业务代码之前取的快照）：SDH_* 恰好是 5 个规范大写键，没有大小写变体', sdhKeys && JSON.stringify(sdhKeys) === JSON.stringify(['SDH_BACKGROUND_JOBS', 'SDH_DATA_DIR', 'SDH_DB_FILE', 'SDH_EXTERNAL', 'SDH_INSTANCE']), snap && snap.keys);
    check('B4', '子进程环境：DB_ENCRYPTION_KEY / WEBHOOK_SECRET / SYS_TEST_HOOKS 各只有一个键（不分大小写）且值为空串（不是父环境里的诱饵值）；PORT = 本次端口，JWT_SECRET = 返回的 jwtSecret（哈希相等）', snap && snap.keys.filter((k) => /^(DB_ENCRYPTION_KEY|WEBHOOK_SECRET|SYS_TEST_HOOKS)$/i.test(k)).length === 3 && snap.env3 && Object.values(snap.env3).every((v) => v === '') && snap.port === String(B.port) && snap.jwtSha === sha256(B.jwtSecret), snap && { port: snap.port, ok: snap.jwtSha === sha256(B.jwtSecret) });
    check('B5', '子进程 SDH_* 取值：INSTANCE / DB_FILE / DATA_DIR = 本次，EXTERNAL = stub，BACKGROUND_JOBS = off', snap && snap.sdh.INSTANCE === B.instance && fwd(snap.sdh.DB_FILE) === fwd(B.dbPath) && fwd(snap.sdh.DATA_DIR) === fwd(B.dataDir) && snap.sdh.EXTERNAL === 'stub' && snap.sdh.BACKGROUND_JOBS === 'off', snap && snap.sdh);
    const decoyTok = jwt.sign({ id: 1, username: 'admin', role: 'admin' }, 'decoy-jwt-secret-for-env-test', { expiresIn: '10m' });
    const goodTok = jwt.sign({ id: 1, username: 'admin', role: 'admin' }, B.jwtSecret, { expiresIn: '10m' });
    const r1 = await httpJson(B.port, 'GET', '/api/auth/me', undefined, decoyTok);
    const r2 = await httpJson(B.port, 'GET', '/api/auth/me', undefined, goodTok);
    check('B6', '用父环境里的 JWT_SECRET 签的 token 被拒绝，用返回的 jwtSecret 签的被接受', r1.status !== 200 && r2.status === 200, { decoy: r1.status, good: r2.status });
    const decoyHashes = ['decoy-jwt-secret-for-env-test', 'decoy-db-key-for-env-test-0123456789', 'decoy-webhook'].map(sha256);
    check('B7a', '子进程环境值的 sha256 里没有父环境诱饵值（JWT_SECRET / DB_ENCRYPTION_KEY / WEBHOOK_SECRET 的诱饵）、也没有来源键 / 合成 .env 非白名单值', snap && snap.vals && !Object.values(snap.vals).some((h) => decoyHashes.includes(h)) && envValueLeaks(snap) !== null && envValueLeaks(snap).length === 0, snap && envValueLeaks(snap));
    await B.stop();
    check('B7', '实例已停止、数据根已删、守卫未触发', lstatOrNull(B.dataDir) === null && !alive(B.pid) && !fs.existsSync(GUARD_MARKER));
}

// ---------------------------------------------------------------- 节 E：.env 回灌（合成检出 + 合成 .env + 真 server.js；所有真服务测试都走这棵合成检出，本节专门观测子进程里的实际生效值）
async function sectionE() {
    console.log('\n== 节 E：.env 白名单（合成检出的合成 .env，真 server.js 启动后观测子进程里的实际值）==');
    const E = await startReal('E1', Object.assign({ sourceDbPath: SRC_FULL, sourceEncryptionKey: TEST_KEY, readyTimeoutMs: 60000 }, realServerOpts()));
    startedHandles.push(E);
    const late = await lateOf(E);
    check('E1.1', '合成 .env 确实被子进程里的 dotenv 读了、且白名单键原值生效（NODE_ENV = 合成 .env 里的来源标记值；调用方环境里本来没有它）、跑的是合成检出里的 server.js——否则本节其余断言空转', late && late.nodeEnv === ENV_MARKER_VALUE && sameFile(late.argv1, treeServerJs()), late);
    check('E1.2', '.env 里的 SYS_TEST_HOOKS=1 / WEBHOOK_SECRET / DB_ENCRYPTION_KEY 没有回灌：子进程里三个键存在且实际值为空串；.env 里其余**每个**非白名单键（TI_ENV_FILE_MARKER / DINGTALK_APP_SECRET / GITHUB_TOKEN …）同样存在且为空串（观测的是子进程 process.env，不是 buildChildEnv 的返回对象）',
        late && late.own && Object.values(late.own).every((x) => x === true) && Object.values(late.e3).every((v) => v === '') && late.nonwl && ENV_NONWL_KEYS.filter((k) => k !== 'JWT_SECRET').every((k) => late.nonwl[k] === ''), late);
    check('E1.3', 'JWT_SECRET 仍是启动器给的（.env 里的不生效）：晚探针哈希 = 返回的 jwtSecret 的哈希', late && late.jwtSha === sha256(E.jwtSecret));
    check('E1.4', 'DB_ENCRYPTION_KEY 为空串时隔离模式 server.js 正常启动：全部 11 个模块就绪，/api/version 为隔离模式', E.modules && Object.keys(E.modules).length === 11 && Object.values(E.modules).every((m) => m.ready === true) && (await httpJson(E.port, 'GET', '/api/version')).json.mode === 'isolated', E.modules);
    const snapE = serverSnap(E.dataDir, E.pid);
    const leaksE = envValueLeaks(snapE);
    check('E1.5', '子进程快照与日志里没有 .env 的合成密钥；全部环境值的 sha256 里没有来源键 / 钉钉真值 / 外部库口令 / 合成 .env 非白名单值（含 .env 里 Path / TEMP / TMP / tz 的值）', leaksE !== null && leaksE.length === 0 && !JSON.stringify(readSnapshots(E.dataDir)).includes(ENV_FILE_KEY) && !fs.readFileSync(E.logFile, 'utf8').includes(ENV_FILE_KEY), leaksE);
    // E1.6 系统键（修复批 2 第 9 项）：合成 .env 里的 Path / TEMP / TMP / tz 四键——父环境已有的（PATH、TEMP、TMP）不被置空，子进程里 PATH 与父进程相同、os.tmpdir() 仍在私有 TMP 下（instance-mode 才没拒绝启动，上面 E1.4 的实例照常就绪即证）；
    //   父环境没有的（TZ 通常没有）照旧置空，.env 里的 Asia/Tokyo 不进来；父环境若恰好有 TZ，则保留父值
    const parentTz = process.env.TZ;
    check('E1.6', '.env 里的系统键 Path / TEMP / TMP / tz：子进程 PATH 的哈希 = 父进程 PATH 的哈希（没被置空，.env 里的值也没赢）；子进程 os.tmpdir() = 私有 TMP；TZ = 父值（父环境没有则为空串），不是 .env 里的 Asia/Tokyo',
        late && late.sys && late.sys.pathSha === sha256(process.env.PATH) && late.sys.pathSha !== sha256('') && sameFile(late.sys.tmpdir, TMP) && late.sys.tz === (parentTz === undefined ? '' : parentTz), { sys: late && late.sys, parentTz: parentTz === undefined ? null : parentTz });
    await E.stop();
}

// ---------------------------------------------------------------- 节 X：初始化失败的模块（真服务）
async function sectionX() {
    console.log('\n== 节 X：初始化失败的模块（造出 issue 模块 INIT_FAILED / issue_v1750 NOT_READY；core 前序失败）==');
    const failing = ['issue', 'issue_v1750'];
    const others = EXPECTED_MODULES.filter((m) => !failing.includes(m));
    const X1 = await startReal('X1', Object.assign({ sourceDbPath: SRC_BROKEN, sourceEncryptionKey: TEST_KEY, modules: others, readyTimeoutMs: 60000 }, realServerOpts()));
    startedHandles.push(X1);
    check('X1', 'modules 取子集（排除失败模块）时启动成功；返回的 modules 里 issue 未就绪', X1.modules && failing.every((m) => X1.modules[m] && X1.modules[m].ready === false) && others.every((m) => X1.modules[m] && X1.modules[m].ready === true), X1.modules);
    const h = await httpJson(X1.port, 'GET', '/api/health/ready');
    check('X2', '有模块未就绪时 503，body 同形：ok=false，issue 的 code = INIT_FAILED（状态里是中文长句，非对象 code），issue_v1750 = NOT_READY，其余 ready', h.status === 503 && h.json && h.json.ok === false && h.json.modules.issue.ready === false && h.json.modules.issue.code === 'INIT_FAILED' && h.json.modules.issue_v1750.code === 'NOT_READY'
        && others.every((m) => h.json.modules[m].ready === true && h.json.modules[m].code === null), h);
    const raw = h.raw;
    check('X3', '响应体里没有任何错误原文：搜不到「缺列」「各表计数」「issues=」「需人工迁移」，每个模块只有 ready / code 两个键', !/缺列|各表计数|issues=|需人工迁移|raw_requirement|主表结构/.test(raw) && Object.values(h.json.modules).every((m) => JSON.stringify(Object.keys(m).sort()) === '["code","ready"]') && Object.values(h.json.modules).every((m) => m.code === null || /^[A-Z][A-Z0-9_]{0,63}$/.test(m.code)), raw);
    const h2 = await httpJson(X1.port, 'GET', '/api/health/ready');
    check('X4', '未登录即可读，且读它不改变状态（两次读取一致）', h2.status === 503 && JSON.stringify(h2.json) === JSON.stringify(h.json));
    // 原有模块行为不变：需求跟踪的 503 中间件仍返回原有 code（不被汇总接口影响）
    const adminTok = jwt.sign({ id: 1, username: 'admin', role: 'admin', display_name: '管理员' }, X1.jwtSecret, { expiresIn: '10m' });
    const iss = await httpJson(X1.port, 'GET', '/api/issues', undefined, adminTok);
    check('X5', '既有模块的 503 行为不变：需求跟踪接口仍返回其原有 503（code = ISSUE_SCHEMA_NOT_READY，detail 仍带原文——汇总接口才不外露）', iss.status === 503 && iss.json && iss.json.code === 'ISSUE_SCHEMA_NOT_READY' && typeof iss.json.detail === 'string' && /issues/.test(iss.json.detail), iss);
    await X1.stop();
    check('X6', '实例已停止', lstatOrNull(X1.dataDir) === null && !alive(X1.pid));

    // 默认等待模块：等不齐 → 报未就绪模块清单；issue 报了不会自愈的终态码（INIT_FAILED）并稳定 → 提前结束等待（不干等满期限）；进程收掉、数据根删除
    const dirsBefore = tmpInstanceDirs();
    let err = null;
    const t0 = Date.now();
    try { await ti.startTestInstance(Object.assign({ sourceDbPath: SRC_BROKEN, sourceEncryptionKey: TEST_KEY, modules: ['issue'], readyTimeoutMs: 40000 }, realServerOpts())); } catch (e) { err = e; }
    const ms7 = Date.now() - t0;
    check('X7', '等不齐模块 → TI_READY_TIMEOUT，错误里有未就绪模块清单（issue / INIT_FAILED）和脱敏后的日志尾', err && err.code === 'TI_READY_TIMEOUT' && JSON.stringify(err.unreadyModules) === JSON.stringify([{ name: 'issue', code: 'INIT_FAILED' }]) && /issue\(INIT_FAILED\)/.test(err.message) && typeof err.logTail === 'string' && err.logTail.length > 0, err && { code: err.code, m: err.message, u: err.unreadyModules });
    check('X8', '超时后不留数据根（私有临时根里没有新增 sdh-test-*）', JSON.stringify(tmpInstanceDirs()) === JSON.stringify(dirsBefore) && ms7 < 70000, tmpInstanceDirs());
    check('X9', '终态码提前结束等待：err.earlyEnd = true、消息里写明「提前结束等待」，用时远小于 readyTimeoutMs（40 秒）之外的等待余量（总用时含服务启动，须 < 35 秒）', err && err.earlyEnd === true && /提前结束等待/.test(err.message) && ms7 < 35000, err && { earlyEnd: err.earlyEnd, ms: ms7 });

    // ---- core：initTable 前序「只记日志后继续」的失败也要汇入 core 就绪（等 collab_dualcheck 就绪 = initTable 的 serialize 队列已排空）
    //   等的是「core 以外的全部模块」就绪（含 collab_dualcheck：它在 serialize 队列排空之后才开始迁移）——只等 collab_dualcheck 时其余模块（周期取数 / 历史归档 / 资产台账 …）可能还在初始化，会让「其余模块照常就绪」的断言偶发
    const waitMods = EXPECTED_MODULES.filter((m) => m !== 'core');
    const coreCase = async (label, srcDb, extraEnv, expectCode, tag) => {
        const o = Object.assign({ sourceDbPath: srcDb, sourceEncryptionKey: TEST_KEY, modules: waitMods, readyTimeoutMs: 60000 }, realServerOpts());
        if (extraEnv) { o.nodeArgs = [...o.nodeArgs, '--require', INJECT]; o.extraEnv = Object.assign({}, o.extraEnv, extraEnv); }
        const H = await startReal(label, o);
        startedHandles.push(H);
        const settle = await waitUntil(async () => { const r = await httpJson(H.port, 'GET', '/api/health/ready'); return r.json && r.json.modules && r.json.modules.core && r.json.modules.core.ready === false ? r : null; }, 15000, 250);
        const r2 = await httpJson(H.port, 'GET', '/api/health/ready');
        const body = r2.json;
        const okShape = body && body.modules && body.modules.core && body.modules.core.ready === false && body.modules.core.code === expectCode && body.ok === false && r2.status === 503
            && EXPECTED_MODULES.filter((m) => m !== 'core').every((m) => body.modules[m].ready === true && body.modules[m].code === null);
        const noRaw = !/injected|UNIQUE constraint|idx_task_pool|task_pool|duplicate/i.test(r2.raw);
        check(tag, `core 前序失败 (${label}) → /api/health/ready 的 core 为未就绪（code = ${expectCode}）、整体 503、其余模块照常就绪、响应里没有错误原文；进程照旧运行`, settle !== null && okShape && noRaw && alive(H.pid), { settle: settle && settle.status, status: r2.status, core: body && body.modules && body.modules.core, raw: r2.raw.slice(0, 300) });
        await H.stop();
        return H;
    };
    await coreCase('task_pool 唯一索引建不出（数据违反）', SRC_COREIDX, null, 'SQLITE_CONSTRAINT', 'X10');
    await coreCase('safeAlterAddColumn 失败（注入 ALTER TABLE users ADD COLUMN phone）', SRC_FULL, { TI_INJECT_PATTERN: 'ALTER TABLE users ADD COLUMN phone' }, 'SQLITE_ERROR', 'X11');
    await coreCase('空回调 ALTER 失败（注入 ALTER TABLE task_pool ADD COLUMN hold_reason）', SRC_FULL, { TI_INJECT_PATTERN: 'ALTER TABLE task_pool ADD COLUMN hold_reason' }, 'SQLITE_ERROR', 'X12');

    // ---- verifyV2CollabSchema（启动后结构巡检）的失败也汇入 core（修复批 2 第 7 项）：经 INJECT 预加载按 SQL 片段改写 db.all / db.get 的结果（TI_INJECT_QUERY 规则），
    //   每条规则的每次命中都写进数据根的 inject-hits.log，**每条规则至少命中一次**才认这个用例（注入没生效就不能把「没失败」当成「没汇入」）。
    //   红灯用例：core 未就绪、整体 503、其余模块照常就绪、响应里没有错误原文（码是 SQLITE_ERROR 或 CORE_SCHEMA_INCOMPLETE）；
    //   绿灯用例（X16，不汇入的两处）：assign_mode 出现非法值（数据巡检）+ collab_quality_record 存在性查询返回「缺表」（归 collab_dualcheck）→ core 照常就绪、整体 200。
    const queryCase = async (tag, label, rules, expectCode) => {
        const green = expectCode === null;
        const o = Object.assign({ sourceDbPath: SRC_FULL, sourceEncryptionKey: TEST_KEY, modules: waitMods, readyTimeoutMs: 60000 }, realServerOpts());
        o.nodeArgs = [...o.nodeArgs, '--require', INJECT];
        o.extraEnv = Object.assign({}, o.extraEnv, { TI_INJECT_QUERY: JSON.stringify(rules) });
        const H = await startReal(tag, o);
        startedHandles.push(H);
        const settle = await waitUntil(async () => { const r = await httpJson(H.port, 'GET', '/api/health/ready'); const c = r.json && r.json.modules && r.json.modules.core; return c && c.ready === green ? r : null; }, 15000, 250);
        const r2 = await httpJson(H.port, 'GET', '/api/health/ready');
        const body = r2.json;
        const hitsFile = path.join(H.dataDir, 'inject-hits.log');
        const hitSet = new Set(fs.existsSync(hitsFile) ? fs.readFileSync(hitsFile, 'utf8').split('\n').filter(Boolean) : []);
        const allHit = rules.every((_, i) => hitSet.has(String(i)));
        const othersOk = body && body.modules && EXPECTED_MODULES.filter((m) => m !== 'core').every((m) => body.modules[m].ready === true && body.modules[m].code === null);
        const shape = green ? (body && body.modules.core.ready === true && body.modules.core.code === null && body.ok === true && r2.status === 200)
            : (body && body.modules.core.ready === false && body.modules.core.code === expectCode && body.ok === false && r2.status === 503);
        const noRaw = !/injected|collab_requests|collab_attachments|collab_return_record|system_configs|remark|bogus/i.test(r2.raw);
        check(tag, `${label} → ${green ? 'core 照常就绪、整体 200（不汇入）' : `core 未就绪（code = ${expectCode}）、整体 503`}、其余模块照常就绪、响应里没有错误原文；每条注入规则至少命中一次（命中 ${[...hitSet].sort().join(',') || '无'} / 共 ${rules.length} 条）；进程照旧运行`,
            settle !== null && allHit && shape && othersOk && noRaw && alive(H.pid), { settle: settle && settle.status, status: r2.status, core: body && body.modules && body.modules.core, hits: [...hitSet], raw: r2.raw.slice(0, 300) });
        await H.stop();
    };
    await queryCase('X13', 'PRAGMA table_info(collab_requests) 查询失败', [{ pattern: 'PRAGMA table_info\\(collab_requests\\)', mode: 'error' }], 'SQLITE_ERROR');
    await queryCase('X14', 'PRAGMA table_info(users) 返回的结构缺 remark 列', [{ pattern: 'PRAGMA table_info\\(users\\)', mode: 'dropcol', arg: 'remark' }], 'CORE_SCHEMA_INCOMPLETE');
    await queryCase('X15', 'system_configs 存在性查询返回「表不存在」', [{ pattern: "name='system_configs'", mode: 'norow' }], 'CORE_SCHEMA_INCOMPLETE');
    await queryCase('X16', 'assign_mode 巡检发现非法值 + collab_quality_record 存在性查询返回缺表（两处都是不汇入 core 的）', [{ pattern: 'assign_mode NOT IN', mode: 'rows', arg: [{ id: 7, oa_request_no: 'TI-BOGUS', assign_mode: 'bogus' }] }, { pattern: "name='collab_quality_record'", mode: 'patch', arg: { q: 0 } }], null);
    await queryCase('X17', 'assign_mode 巡检查询失败', [{ pattern: 'assign_mode NOT IN', mode: 'error' }], 'SQLITE_ERROR');
    await queryCase('X18', '两表存在性查询返回 collab_return_record 缺表', [{ pattern: "name='collab_quality_record'", mode: 'patch', arg: { r: 0 } }], 'CORE_SCHEMA_INCOMPLETE');
}

// ---------------------------------------------------------------- 节 F：失败路径（桩服务为主，不起真服务）
async function sectionF() {
    console.log('\n== 节 F：失败路径 / 选项校验 / 默认来源规划 ==');
    const noLeak = (before) => JSON.stringify(tmpInstanceDirs()) === JSON.stringify(before);
    const attempt = async (opts) => { const before = tmpInstanceDirs(); let err = null; let h = null; try { h = await ti.startTestInstance(opts); startedHandles.push(h); } catch (e) { err = e; } return { err, h, before }; };

    // F1 来源不存在
    let r = await attempt({ sourceDbPath: path.join(PRIV, 'no-such-source.db'), sourceEncryptionKey: null, ...stubOpts('ok') });
    check('F1', '来源库不存在 → TI_SOURCE_MISSING，不建数据根、不起进程', r.err && r.err.code === 'TI_SOURCE_MISSING' && noLeak(r.before), r.err && r.err.message);

    // F2 来源键错
    r = await attempt({ sourceDbPath: SRC_MINI, sourceEncryptionKey: WRONG_KEY, ...stubOpts('ok') });
    check('F2', '来源键错 → SOURCE_KEY_MISMATCH（createIsolatedDb 原错误码），数据根已清，错误消息里没有任何一把键', r.err && r.err.code === 'SOURCE_KEY_MISMATCH' && noLeak(r.before) && !r.err.message.includes(WRONG_KEY) && !r.err.message.includes(TEST_KEY) && !String(r.err.stack).includes(TEST_KEY), r.err && r.err.message);

    // F3 来源键缺失（来源不是隔离库）
    r = await attempt({ sourceDbPath: SRC_MINI, ...stubOpts('ok') });
    check('F3', '来源不是隔离库却没给 sourceEncryptionKey → SOURCE_KEY_REQUIRED，数据根已清', r.err && r.err.code === 'SOURCE_KEY_REQUIRED' && noLeak(r.before), r.err && r.err.message);

    // F4 服务提前退出
    r = await attempt({ sourceDbPath: SRC_MINI, sourceEncryptionKey: TEST_KEY, readyTimeoutMs: 20000, ...stubOpts('exit') });
    check('F4', '服务提前退出 → TI_SERVER_EXITED（退出码 3），错误里带日志尾，数据根已清', r.err && r.err.code === 'TI_SERVER_EXITED' && r.err.exitCode === 3 && /stub exiting with 3/.test(r.err.logTail || '') && noLeak(r.before), r.err && { c: r.err.code, e: r.err.exitCode, t: r.err.logTail });

    // F4b 日志尾脱敏：服务把 JWT_SECRET 打进了日志，错误里带的日志尾必须已脱敏
    r = await attempt({ sourceDbPath: SRC_MINI, sourceEncryptionKey: TEST_KEY, readyTimeoutMs: 20000, ...stubOpts('leak') });
    check('F4b', '服务日志里出现了本次 JWT_SECRET 明文 → 错误里的日志尾已脱敏（含 [已脱敏]，不含明文密钥），退出码 5', r.err && r.err.code === 'TI_SERVER_EXITED' && r.err.exitCode === 5 && /LEAK jwt=\[已脱敏\] end/.test(r.err.logTail || '') && !/LEAK jwt=[0-9a-f]{64}/.test(r.err.logTail || '') && noLeak(r.before), r.err && r.err.logTail);

    // F5 就绪失败（桩：身份对、模块永远不就绪；issue 报终态码 INIT_FAILED，quick_log 一直 NOT_READY（还在初始化）→ 不是「全部未就绪都是终态」→ 不提前结束，干等到期限）
    const pidFile5 = path.join(PRIV, 'f5.pids');
    const t5 = Date.now();
    r = await attempt({ sourceDbPath: SRC_MINI, sourceEncryptionKey: TEST_KEY, readyTimeoutMs: 6000, ...stubOpts('unready', { STUB_PID_FILE: pidFile5 }) });
    const ms5 = Date.now() - t5;
    const ids5 = readIds(pidFile5);
    const gone5 = ids5.length === 1 && (await waitUntil(() => idsGone(ids5), 5000)) !== null;
    check('F5', '模块未就绪 → TI_READY_TIMEOUT，未就绪清单 = issue(INIT_FAILED)、quick_log(NOT_READY)（core 已就绪不列）；桩进程已收掉（按 PID + 创建时间核对）、数据根已清', r.err && r.err.code === 'TI_READY_TIMEOUT' && JSON.stringify(r.err.unreadyModules.map((m) => `${m.name}:${m.code}`)) === JSON.stringify(['issue:INIT_FAILED', 'quick_log:NOT_READY']) && gone5 && noLeak(r.before), r.err && { c: r.err.code, u: r.err.unreadyModules, ids5, ms: ms5 });
    check('F5b', 'issue 已是终态（INIT_FAILED）但 quick_log 仍是 NOT_READY（非终态）→ **不**提前结束：错误不带 earlyEnd，失败用时 ≥ readyTimeoutMs（6 秒）× 0.9——只有「全部未就绪模块都已是终态」才提前结束', r.err && r.err.earlyEnd === false && ms5 >= 6000 * 0.9, r.err && { earlyEnd: r.err.earlyEnd, ms: ms5 });
    reapIds('F5桩', ids5);

    // F6 waitFor=identity：只等身份，不等模块（桩的模块永远不就绪）
    const f6 = await attempt({ sourceDbPath: SRC_MINI, sourceEncryptionKey: TEST_KEY, waitFor: 'identity', readyTimeoutMs: 8000, ...stubOpts('unready') });
    check('F6', "waitFor='identity' 只等身份：模块未就绪也成功返回（modules = null）", f6.h && f6.h.modules === null && f6.h.instance.startsWith('test-'), f6.err && f6.err.message);
    if (f6.h) await f6.h.stop();

    // F7 请求等待的模块名不存在
    r = await attempt({ sourceDbPath: SRC_MINI, sourceEncryptionKey: TEST_KEY, modules: ['no_such_module'], readyTimeoutMs: 8000, ...stubOpts('ok') });
    check('F7', '请求等待不存在的模块名 → TI_UNKNOWN_MODULE（不是干等到超时），数据根已清', r.err && r.err.code === 'TI_UNKNOWN_MODULE' && noLeak(r.before), r.err && r.err.message);

    // F8 实例冒名（端口上答的是别的身份；监听者就是本次子进程）
    const pidFile8 = path.join(PRIV, 'f8.pids');
    r = await attempt({ sourceDbPath: SRC_MINI, sourceEncryptionKey: TEST_KEY, readyTimeoutMs: 8000, ...stubOpts('impostor', { STUB_PID_FILE: pidFile8 }) });
    const ids8 = readIds(pidFile8);
    const gone8 = ids8.length === 1 && (await waitUntil(() => idsGone(ids8), 5000)) !== null;
    check('F8', '应答的 instance 不是本次身份且监听者就是本次子进程 → TI_IDENTITY_MISMATCH（立即判，不换端口重试，不等超时），进程已收（PID + 创建时间核对）、数据根已清', r.err && r.err.code === 'TI_IDENTITY_MISMATCH' && r.err.actual.instance === 'test-someoneelse' && gone8 && ids8.length === 1 && noLeak(r.before), r.err && r.err.message);
    reapIds('F8桩', ids8);

    // F9 端口被别的进程抢占（子进程监听的是孙进程）
    const pidFile9 = path.join(PRIV, 'f9.pids');
    r = await attempt({ sourceDbPath: SRC_MINI, sourceEncryptionKey: TEST_KEY, readyTimeoutMs: 15000, ...stubOpts('hijack', { STUB_PID_FILE: pidFile9 }) });
    const ids9 = readIds(pidFile9);
    const gone9 = ids9.length === 2 && (await waitUntil(() => idsGone(ids9), 8000)) !== null;
    check('F9', '端口监听者不是本次子进程（孙进程占着）→ TI_PORT_HIJACKED；子进程与孙进程都已收（PID + 创建时间核对）、数据根已清', r.err && r.err.code === 'TI_PORT_HIJACKED' && Array.isArray(r.err.listeners) && r.err.listeners.length === 1 && gone9 && noLeak(r.before), r.err && { c: r.err.code, l: r.err.listeners, ids9 });
    reapIds('F9桩', ids9);

    // F10 端口在 spawn 前被抢占 → 换端口重试
    const occupied = [];
    const hooks1 = { beforeSpawn: async ({ port, attempt: n }) => { if (n === 1) { const s = net.createServer((sock) => sock.destroy()); await new Promise((res, rej) => { s.once('error', rej); s.listen(port, '0.0.0.0', res); }); occupied.push({ s, port }); } } };
    r = await attempt({ sourceDbPath: SRC_MINI, sourceEncryptionKey: TEST_KEY, readyTimeoutMs: 15000, _hooks: hooks1, ...stubOpts('ok') });
    check('F10', '第一次端口被占（子进程 EADDRINUSE 退出）→ 换端口重试成功；返回的端口不是被占的那个', r.h && occupied.length === 1 && r.h.port !== occupied[0].port && (await httpJson(r.h.port, 'GET', '/api/version')).json.instance === r.h.instance, r.err && r.err.message);
    if (r.h) { await r.h.stop(); check('F10b', '重试成功的实例停止后进程消失、数据根删除', lstatOrNull(r.h.dataDir) === null && !alive(r.h.pid)); }
    for (const o of occupied) await new Promise((res) => o.s.close(() => res()));

    // F10c / F10d 端口被别的服务抢先回答 → 拒绝该应答 / 不采信，换端口重试，别人的服务毫发无损。
    //   两个夹具的同步握手（12T-R M3）：替身收到 /api/version 请求后，**先等 pid 文件里至少出现 1 行**（本次子进程已跑起来并登记了身份；有界 10 秒，轮询间隔 50 毫秒），再回答——
    //   这样启动器因替身的应答而收掉子进程时，子进程的身份一定已经登记，不会出现「子进程还没写身份文件就被终止」而让 ids 断言偶发失败。等待超时 → 照常回答并记 handshakeTimeout = true，断言要求它为 false。
    //   STUB_LISTEN_DELAY_MS 保留，但分工不同：它让子进程**晚点才去监听**，防的是子进程先撞 EADDRINUSE 退出（那会走「EADDRINUSE 退出 → 换端口」分支，绕开本夹具要测的「应答身份不符 / 形态不合法」分支）；
    //   握手保证的是**身份先登记**。两者缺一不可：只有延迟没有握手 = 身份登记仍靠时序碰运气。
    const impostorCase = async (tag, pidFile, makeBody) => {
        const imp = { server: null, port: 0, hits: 0, handshakeTimeout: false };
        const hooks = { beforeSpawn: async ({ port, attempt: n }) => {
            if (n !== 1) return;
            imp.server = http.createServer(async (q, s) => {
                imp.hits += 1;
                const seen = await waitUntil(() => readIds(pidFile).length >= 1, 10000, 50);
                if (!seen) imp.handshakeTimeout = true;
                s.setHeader('Content-Type', 'application/json');
                s.end(makeBody());
            });
            await new Promise((res, rej) => { imp.server.once('error', rej); imp.server.listen(port, '0.0.0.0', res); });
            imp.port = port;
        } };
        const rr = await attempt({ sourceDbPath: SRC_MINI, sourceEncryptionKey: TEST_KEY, readyTimeoutMs: 30000, _hooks: hooks, ...stubOpts('ok', { STUB_PID_FILE: pidFile, STUB_LISTEN_DELAY_MS: '3000' }) });
        const ids = readIds(pidFile);
        const impAfter = imp.port ? await httpJson(imp.port, 'GET', '/api/version') : null;
        const okInst = rr.h ? await httpJson(rr.h.port, 'GET', '/api/version') : null;
        return { rr, imp, ids, impAfter, okInst, tag };
    };
    const SAME_SHAPE_IMPOSTOR = () => JSON.stringify({ version: 'imp', name: 'imp', nameEn: 'imp', mode: 'isolated', instance: 'test-impostorsvc', external: 'stub', background: 'off', commit: null });
    const pidFile10 = path.join(PRIV, 'f10c.pids');
    const c10 = await impostorCase('F10c', pidFile10, SAME_SHAPE_IMPOSTOR);
    r = c10.rr;
    const ids10 = c10.ids;
    const gone10 = await waitIdsGone(ids10.slice(0, -1), 8000);   // 本例内：除成功并仍在运行的那个（最后一个）以外，全部已按身份消失
    check('F10c', '先起一个占着首选端口并回答同形身份的替身（握手：子进程身份先登记再回答）→ 启动器拒绝该应答、收掉本次子进程、换端口后成功；替身毫发无损（仍在监听并回答自己的身份）；握手没有超时',
        r.h && c10.imp.port > 0 && c10.imp.hits >= 1 && c10.imp.handshakeTimeout === false && r.h.port !== c10.imp.port && c10.okInst.json.instance === r.h.instance
        && c10.impAfter && c10.impAfter.json && c10.impAfter.json.instance === 'test-impostorsvc' && ids10.length >= 2 && ids10[ids10.length - 1].pid === r.h.pid, r.err ? r.err.message : { hits: c10.imp.hits, hs: c10.imp.handshakeTimeout, port: r.h && r.h.port, impPort: c10.imp.port, ids10 });
    check('F10c-p', '本例内（兜底回收之前）：pid 文件里除成功并仍在运行的那个以外的全部子进程身份已消失（被启动器收掉的第一个子进程按 PID + 创建时间核对）', ids10.length >= 2 && ids10.slice(0, -1).every((i) => i.start !== null) && gone10, ids10);
    if (r.h) await r.h.stop();
    if (c10.imp.server) await new Promise((res) => c10.imp.server.close(() => res()));
    reapIds('F10c桩', ids10);

    // F10d 同一场景，但占着端口的服务对 /api/version 回 200 + 正文 null（合法 JSON、不是对象）：line-proc 的 httpGetJson 把它归为 badbody（:243），waitIdentity 不采信、继续等；
    //   本次子进程随后因 EADDRINUSE 退出 → 启动器换端口重试并成功，替身毫发无损。这条守着 httpGetJson「kind ok 时 json 恒为非空普通对象」的契约（waitIdentity 读属性前没有再检查形态）。
    const pidFile10d = path.join(PRIV, 'f10d.pids');
    const c10d = await impostorCase('F10d', pidFile10d, () => 'null');
    r = c10d.rr;
    const ids10d = c10d.ids;
    const gone10d = await waitIdsGone(ids10d.slice(0, -1), 8000);
    check('F10d', '占着首选端口的替身对 /api/version 回 200 + 正文 null（握手同 F10c）→ 启动器不抛 TypeError、换端口后成功；替身毫发无损（仍回 200 + null）；握手没有超时；被放弃的第一个子进程已消失（它因 EADDRINUSE 自己退出）',
        r.h && c10d.imp.port > 0 && c10d.imp.hits >= 1 && c10d.imp.handshakeTimeout === false && r.h.port !== c10d.imp.port && c10d.okInst.json.instance === r.h.instance
        && c10d.impAfter && c10d.impAfter.status === 200 && c10d.impAfter.json === null && c10d.impAfter.raw === 'null' && ids10d.length >= 2 && ids10d[ids10d.length - 1].pid === r.h.pid && gone10d,
        r.err ? { c: r.err.code, name: r.err.name, m: r.err.message } : { hits: c10d.imp.hits, hs: c10d.imp.handshakeTimeout, port: r.h && r.h.port, impPort: c10d.imp.port, ids10d, aft: c10d.impAfter });
    if (r.h) await r.h.stop();
    if (c10d.imp.server) await new Promise((res) => c10d.imp.server.close(() => res()));
    reapIds('F10d桩', ids10d);

    // F11 端口一直被占 → 达到上限报 TI_PORT_EXHAUSTED，不留进程、不留数据根
    const occ2 = [];
    const hooks2 = { beforeSpawn: async ({ port }) => { const s = net.createServer((sock) => sock.destroy()); await new Promise((res, rej) => { s.once('error', rej); s.listen(port, '0.0.0.0', res); }); occ2.push(s); } };
    r = await attempt({ sourceDbPath: SRC_MINI, sourceEncryptionKey: TEST_KEY, readyTimeoutMs: 15000, maxPortAttempts: 2, _hooks: hooks2, ...stubOpts('ok') });
    check('F11', '每次尝试端口都被占 → TI_PORT_EXHAUSTED（上限 2 次），数据根已清', r.err && r.err.code === 'TI_PORT_EXHAUSTED' && occ2.length === 2 && noLeak(r.before), r.err && { c: r.err.code, m: r.err.message, n: occ2.length });
    for (const s of occ2) await new Promise((res) => s.close(() => res()));

    // F11b 停止时清理失败不静默：另一个进程把 cwd 放在数据根的子目录里（就绪信号确认占用成立）→ 删不掉 → stop() 抛 TI_CLEANUP_FAILED，现场路径保留；
    //   并发调用共享同一次清理；释放占用后再次 stop() 从当前状态继续并成功；成功后缓存成功结果
    r = await attempt({ sourceDbPath: SRC_MINI, sourceEncryptionKey: TEST_KEY, readyTimeoutMs: 15000, ...stubOpts('ok') });
    if (r.h) {
        const lockDir = path.join(r.h.dataDir, 'locked-subdir');
        fs.mkdirSync(lockDir);
        const holderRec = await spawnHelper('F11b holder', process.execPath, ['-e', 'process.send({ ready: true, cwd: process.cwd() }); setInterval(function(){}, 1000);'], { cwd: lockDir, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true }, 'suite');
        const holder = holderRec.child;
        // 就绪信号：封装在 spawn 返回前就开始缓存 IPC 消息（不会因为 await 期间到达而丢），这里有界等待 消息 / error / 提前退出 三者之一
        const sig = !holderRec.ok ? { error: String(holderRec.error && holderRec.error.message) }
            : await waitUntil(() => holderRec.state.messages[0] || (holderRec.state.error ? { error: holderRec.state.error.message } : null) || (holderRec.state.exited ? { exited: true } : null), 15000, 50) || { timeout: true };
        check('F11a', 'holder 经 spawnHelper 创建（创建失败不抛），完成初始化并确认 cwd（IPC 就绪信号，有超时、处理 error 与提前退出）后才继续：cwd = 数据根里的占用目录', holderRec.ok && sig && sig.ready === true && sameFile(sig.cwd, lockDir), sig);
        let stopErr = null;
        let stopErr2 = null;
        const sp1 = r.h.stop();
        const sp2 = r.h.stop();
        const sameWhilePending = sp1 === sp2;
        try { await sp1; } catch (e) { stopErr = e; }
        const stillThere = lstatOrNull(r.h.dataDir) !== null;
        check('F11b', '数据根里有别的进程占着的目录 → stop() 抛 TI_CLEANUP_FAILED（带数据根路径），现场保留；并发调用共享同一次清理（同一个 Promise）；服务进程本身已终止', stopErr && stopErr.code === 'TI_CLEANUP_FAILED' && stopErr.dataDir === r.h.dataDir && stillThere && sameWhilePending && !alive(r.h.pid), stopErr && { c: stopErr.code, m: stopErr.message });
        try { if (holder) holder.kill(); } catch (_) { /* 句柄在手 */ }
        const holderGone = holder ? await waitChildExit(holder, 10000) : true;
        let second = null;
        try { second = await r.h.stop(); } catch (e) { stopErr2 = e; }
        check('F11c', '占用释放后第二次 stop() 从当前状态继续并成功（失败后清空缓存，不再返回缓存的拒绝），数据根删干净；成功后缓存成功结果（再调用仍是同一个成功的 Promise）', holderGone && stopErr2 === null && second === undefined && lstatOrNull(r.h.dataDir) === null && r.h.stop() === r.h.stop(), stopErr2 && stopErr2.message);
    } else {
        check('F11b', '前置：桩实例应能启动', false, r.err && r.err.message);
    }

    // F12 选项校验：在建任何东西之前拒绝
    const bad = [
        ['未知选项', { sourceDbPath: SRC_MINI, sourceEncryptionKey: null, resorces: [] }],
        ['resources 不是子集', { sourceDbPath: SRC_MINI, sourceEncryptionKey: null, resources: ['uploads', 'nope'] }],
        ['resources 公开名与同义名重复', { sourceDbPath: SRC_MINI, sourceEncryptionKey: null, resources: ['reconcile', 'it-reconcile'] }],
        ['extraEnv 带 SDH_*（大小写变体）', { sourceDbPath: SRC_MINI, sourceEncryptionKey: null, extraEnv: { Sdh_Db_File: 'x' } }],
        ['extraEnv 带被剔除的键', { sourceDbPath: SRC_MINI, sourceEncryptionKey: null, extraEnv: { jwt_secret: 'x' } }],
        ['waitFor 非法', { sourceDbPath: SRC_MINI, sourceEncryptionKey: null, waitFor: 'soon' }],
        ['sourceEncryptionKey 单给', { sourceEncryptionKey: TEST_KEY }],
        ['parent 选项已移除（父检出身份恒取本检出身份）', { sourceDbPath: SRC_MINI, sourceEncryptionKey: null, parent: 'other' }],
        ['startupRaceRetries 为负', { sourceDbPath: SRC_MINI, sourceEncryptionKey: null, startupRaceRetries: -1 }],
        ['startupRaceRetries 过大', { sourceDbPath: SRC_MINI, sourceEncryptionKey: null, startupRaceRetries: 99 }],
        ['startupRaceRetries 不是整数', { sourceDbPath: SRC_MINI, sourceEncryptionKey: null, startupRaceRetries: '2' }],
    ];
    const before12 = tmpInstanceDirs();
    const codes12 = [];
    for (const [, o] of bad) { try { startedHandles.push(await ti.startTestInstance(Object.assign({ serverJs: stubPath('ok'), readyTimeoutMs: 8000 }, o))); codes12.push('NO_ERROR'); } catch (e) { codes12.push(e.code); } }
    check('F12', '非法选项一律 TI_BAD_OPTIONS，且没有建出任何数据根', codes12.every((c) => c === 'TI_BAD_OPTIONS') && noLeak(before12), codes12);

    // F13 默认来源规划（合成目录，不读真实 .env / 库）
    const plan = ti._internals.planDefaultSource;
    const mk = (name, files) => { const d = path.join(PRIV, `plan-${name}`); fs.mkdirSync(d); for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(d, n), t); return d; };
    const planKey = 'plan-test-key-0123456789abcdef';
    const dN = mk('normal', { '.env': `DB_ENCRYPTION_KEY=${planKey}\nJWT_SECRET=whatever\n` });
    const pN = plan(dN, { env: {} });
    check('F13.1', '默认规划·正常检出：来源 = <wbs>/task_pool.db、来源键取自 .env、父身份 main、资源取 <wbs> 下的正常模式目录（it-reconcile 在 routes/it-ledger/uploads 下）', pN.kind === 'normal' && pN.sourceDbPath === path.join(dN, 'task_pool.db') && pN.sourceEncryptionKey === planKey && pN.parent === 'main' && pN.resourceDirs.uploads === path.join(dN, 'uploads') && pN.resourceDirs.private === path.join(dN, 'private') && pN.resourceDirs['it-reconcile'] === path.join(dN, 'routes', 'it-ledger', 'uploads', 'it-reconcile') && !fs.existsSync(path.join(dN, 'task_pool.db')), pN);
    const dNoKey = mk('nokey', { '.env': 'JWT_SECRET=x\n' });
    let eNoKey = null; try { plan(dNoKey, { env: {} }); } catch (e) { eNoKey = e; }
    check('F13.2', '默认规划·正常检出缺来源键 → TI_SOURCE_KEY_UNAVAILABLE（不静默降级）', eNoKey && eNoKey.code === 'TI_SOURCE_KEY_UNAVAILABLE');
    const lineDb = path.join(PRIV, 'plan-line-data', 'line.db');
    const dLine = mk('line', { '.sdh-instance': 'lineA\n', '.env': `SDH_DB_FILE=${fwd(lineDb)}\nSDH_DATA_DIR=${fwd(path.join(PRIV, 'plan-line-data'))}\nDB_ENCRYPTION_KEY=${planKey}\n` });
    const pL = plan(dLine, { env: {} });
    check('F13.3', '默认规划·线检出：来源 = 线库、不传来源键（线库是隔离库）、父身份 = 线名、资源取线数据根', pL.kind === 'line' && pL.sourceDbPath === path.resolve(lineDb) && pL.sourceEncryptionKey === undefined && pL.parent === 'lineA' && pL.resourceDirs.uploads === path.join(path.resolve(path.join(PRIV, 'plan-line-data')), 'uploads') && pL.resourceDirs.private === path.join(path.resolve(path.join(PRIV, 'plan-line-data')), 'private'), pL);
    let eNest = null; try { plan(dN, { env: { SDH_INSTANCE: 'test-abc', SDH_DATA_DIR: path.join(PRIV, 'x') } }); } catch (e) { eNest = e; }
    let eRef = null; try { plan(dN, { env: { SDH_DB_FILE: 'C:/x.db' } }); } catch (e) { eRef = e; }
    check('F13.4', '默认规划·已是测试实例 → TI_NESTED_TEST_INSTANCE 或判定被拒（TI_MODE_REFUSED），正常模式混入隔离变量 → TI_MODE_REFUSED；错误消息里没有来源键', eNest && /^TI_(NESTED_TEST_INSTANCE|MODE_REFUSED)$/.test(eNest.code) && eRef && eRef.code === 'TI_MODE_REFUSED' && !String(eNest.message + eRef.message).includes(planKey), { n: eNest && eNest.code, r: eRef && eRef.code });
    const plannedPair = [pN.sourceDbPath, pL.sourceDbPath];
    check('F13.5', '规划只出路径，没有打开任何库（合成目录里没有 task_pool.db / line.db 文件被建出）', plannedPair.every((p) => !fs.existsSync(p)));

    // F14 资源：来源含链接 → 拒绝；来源目录缺失 → 建空目录并标 sourceMissing；check 对 private 照片表
    const linkRoot = path.join(PRIV, 'link-res-root');
    fs.mkdirSync(path.join(linkRoot, 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(linkRoot, 'uploads', 'real.txt'), 'x');
    const linkTarget = path.join(PRIV, 'link-target-dir');
    fs.mkdirSync(linkTarget);
    fs.writeFileSync(path.join(linkTarget, 'secret.txt'), 'must not be copied');
    fs.symlinkSync(linkTarget, path.join(linkRoot, 'uploads', 'evil-link'), 'junction');
    r = await attempt({ sourceDbPath: SRC_MINI, sourceEncryptionKey: TEST_KEY, resources: ['uploads'], resourceRoot: linkRoot, ...stubOpts('ok') });
    check('F14.1', '资源来源目录里有链接 / 目录联接 → 拒绝（LINE_LINK_REFUSED），不起进程、数据根已清，链接目标里的文件没被复制', r.err && r.err.code === 'LINE_LINK_REFUSED' && noLeak(r.before) && fs.existsSync(path.join(linkTarget, 'secret.txt')), r.err && { c: r.err.code, m: r.err.message });
    common.removeLinkChecked(path.join(linkRoot, 'uploads', 'evil-link'));
    const emptyRoot = path.join(PRIV, 'empty-res-root');
    fs.mkdirSync(emptyRoot);
    r = await attempt({ sourceDbPath: SRC_MINI, sourceEncryptionKey: TEST_KEY, resources: ['archive', 'it-reconcile'], resourceRoot: emptyRoot, ...stubOpts('ok') });
    check('F14.2', '资源来源目录不存在 → 在数据根建空目录并标 sourceMissing，不报错（同义名 it-reconcile 也接受）', r.h && r.h.resources.length === 2 && r.h.resources.every((x) => x.sourceMissing === true && x.files === 0) && fs.existsSync(path.join(r.h.dataDir, 'archive')) && fs.existsSync(path.join(r.h.dataDir, 'it-reconcile')), r.err && r.err.message);
    if (r.h) await r.h.stop();
    // private 照片表的引用检查：真实服务的库里没有该表，用独立小库验证检查器本体
    const photoDb = path.join(PRIV, 'photo-check.db');
    await withDb(photoDb, undefined, async (d) => {
        await dbExec(d, 'CREATE TABLE it_inspection_sheet_photos (id INTEGER PRIMARY KEY, stored_name TEXT NOT NULL)');
        await dbExec(d, `INSERT INTO it_inspection_sheet_photos (stored_name) VALUES ('${PHOTO_OK}'), ('${PHOTO_GONE}')`);
    });
    const fakeData = path.join(PRIV, 'photo-data');
    fs.mkdirSync(path.join(fakeData, 'private', 'it-inspection-sheets'), { recursive: true });
    fs.writeFileSync(path.join(fakeData, 'private', 'it-inspection-sheets', PHOTO_OK), 'x');
    const pr = await ti._internals.checkResourceReferences(photoDb, fakeData, ['private']);
    check('F14.3', 'private 的巡检照片引用检查：在的不列，缺的列出（stored_name 在 private/it-inspection-sheets 下核对）', pr.missingTotal === 1 && pr.missing[0].ref === PHOTO_GONE && pr.checked[0].rows === 2 && pr.checked[0].missing === 1 && pr.checked[0].tableAbsent === false, pr);

    // F15 .env 白名单（桩检出目录里放合成 .env）：白名单以外的键在子进程环境里存在且为空串，白名单键 / 启动器显式设值的键不受影响
    const envStubDir = path.join(PRIV, 'envstub');
    fs.mkdirSync(envStubDir);
    fs.copyFileSync(stubPath('ok'), path.join(envStubDir, 'server.js'));
    const fakeToken = `ghp_fake${crypto.randomBytes(8).toString('hex')}`;
    fs.writeFileSync(path.join(envStubDir, '.env'), `LOG_LEVEL=INFO\nSYS_FASTLANE_ENABLE=0\nFAKE_API_TOKEN=${fakeToken}\nAnother_Key=v2\nSdh_Odd_Flag=1\njwt_secret=lower-case-variant\nport=1111\nTZ=UTC\n`);
    r = await attempt({ sourceDbPath: SRC_MINI, sourceEncryptionKey: TEST_KEY, readyTimeoutMs: 15000, ...stubOpts('ok'), serverJs: path.join(envStubDir, 'server.js') });
    const snap15 = r.h ? serverSnap(r.h.dataDir, r.h.pid) : null;
    const k15 = snap15 ? snap15.keys : [];
    const count = (re) => k15.filter((k) => re.test(k)).length;
    check('F15', '.env 白名单：FAKE_API_TOKEN / Another_Key / Sdh_Odd_Flag / TZ（非白名单）在子进程环境里存在且值为空串（sha256 = 空串）；白名单键 LOG_LEVEL / SYS_FASTLANE_ENABLE 启动器不碰（不新增）；jwt_secret / port 的大小写变体不新增重复键，JWT_SECRET = 返回值、PORT = 本次端口',
        snap15 && ['FAKE_API_TOKEN', 'Another_Key', 'Sdh_Odd_Flag', 'TZ'].every((k) => snap15.vals[k] === sha256('')) && !k15.includes('LOG_LEVEL') && !k15.includes('SYS_FASTLANE_ENABLE')
        && count(/^jwt_secret$/i) === 1 && count(/^port$/i) === 1 && snap15.jwtSha === sha256(r.h.jwtSecret) && snap15.port === String(r.h.port) && !JSON.stringify(snap15).includes(fakeToken), snap15 && { keys: k15.filter((k) => /fake|another|odd|tz|log_level|jwt|port/i.test(k)) });
    if (r.h) await r.h.stop();
    // 读不了 .env 时不带着未知的 .env 启动：把 .env 换成目录（读它抛 EISDIR）
    const envBadDir = path.join(PRIV, 'envbad');
    fs.mkdirSync(envBadDir);
    fs.copyFileSync(stubPath('ok'), path.join(envBadDir, 'server.js'));
    fs.mkdirSync(path.join(envBadDir, '.env'));
    r = await attempt({ sourceDbPath: SRC_MINI, sourceEncryptionKey: TEST_KEY, readyTimeoutMs: 8000, ...stubOpts('ok'), serverJs: path.join(envBadDir, 'server.js') });
    check('F15b', '.env 读不了（非 ENOENT）→ TI_ENV_FILE_UNREADABLE，不建数据根、不起进程', r.err && r.err.code === 'TI_ENV_FILE_UNREADABLE' && noLeak(r.before), r.err && r.err.message);
    // F15c 系统键（纯函数，假父环境，不起进程）：.env 里的系统键名只要子进程环境里已有（父环境带来的，不分大小写）就不置空，父值与原大小写保持，且不新增大小写变体；父环境没有的系统键（TZ / APPDATA）照旧置空；
    //   非系统键即使父环境有同名键也置空（口径不变）。真服务端到端见 E1.6。
    const fakeParent = { Path: 'C:/parent/bin', Temp: 'C:/parent/tmp', USERPROFILE: 'C:/Users/parent', OTHER_SECRET: 'parent-copy-of-secret-0001' };
    const ce = ti._internals.buildChildEnv(fakeParent, { instance: 'test-sysenv0001', dbFile: 'C:/x/instance.db', dataDir: 'C:/x', port: 23456, jwtSecret: 'jwt-for-f15c' }, {}, ['PATH', 'temp', 'Userprofile', 'TZ', 'tz', 'APPDATA', 'other_secret', 'BRAND_NEW_SECRET']);
    const ceKeys = Object.keys(ce);
    check('F15c', '.env 里的系统键：父环境已有的 Path / Temp / USERPROFILE 保持父值与原大小写（不置空、不新增 PATH / TEMP / Userprofile 变体）；父环境没有的 TZ（含 tz 变体只出现一个键）/ APPDATA 照旧置空串；非系统键 OTHER_SECRET（父环境有同名）与 BRAND_NEW_SECRET 置空；JWT_SECRET / PORT 仍是启动器的值',
        ce.Path === 'C:/parent/bin' && ce.Temp === 'C:/parent/tmp' && ce.USERPROFILE === 'C:/Users/parent' && !ceKeys.includes('PATH') && !ceKeys.includes('TEMP') && !ceKeys.includes('Userprofile')
        && ce.TZ === '' && ceKeys.filter((k) => /^tz$/i.test(k)).length === 1 && ce.APPDATA === '' && ce.OTHER_SECRET === '' && ce.BRAND_NEW_SECRET === '' && ce.JWT_SECRET === 'jwt-for-f15c' && ce.PORT === '23456', ce);

    // F16 资源名：方案里的公开名 reconcile 与同义名 it-reconcile 都接受，复制到同一位置
    const place = async (name) => {
        const rr = await attempt({ sourceDbPath: SRC_MINI, sourceEncryptionKey: TEST_KEY, resources: [name], resourceRoot: RES_ROOT, readyTimeoutMs: 15000, ...stubOpts('ok') });
        const out = rr.h ? { ok: true, name: rr.h.resources[0].name, file: path.join(rr.h.dataDir, 'it-reconcile', FILE_UUID_OK), exists: fs.existsSync(path.join(rr.h.dataDir, 'it-reconcile', FILE_UUID_OK)), sha: fs.existsSync(path.join(rr.h.dataDir, 'it-reconcile', FILE_UUID_OK)) ? sha256(fs.readFileSync(path.join(rr.h.dataDir, 'it-reconcile', FILE_UUID_OK))) : null } : { ok: false, err: rr.err && rr.err.code };
        if (rr.h) await rr.h.stop();
        return out;
    };
    const p1 = await place('reconcile');
    const p2 = await place('it-reconcile');
    const want16 = sha256(RES_FILES.find((f) => f.rel.endsWith(FILE_UUID_OK)).buf);
    check('F16', "资源名：方案里的公开名 'reconcile' 与同义名 'it-reconcile' 都能启动并复制到同一位置（<数据根>/it-reconcile/…，内容 sha256 与来源一致）", p1.ok && p2.ok && p1.name === 'it-reconcile' && p2.name === 'it-reconcile' && p1.exists && p2.exists && p1.sha === want16 && p2.sha === want16, { p1, p2 });

    // F17 启动期 SQLITE_BUSY 竞态：只在有 BUSY 证据时有界重试（桩：第一次启动按 STUB_MODE 失败，之后正常就绪）
    //   每例都有两类断言：结果（重试次数 / 错误码 / STARTUP_RACE 行数 / 启动次数）和 **-p 进程断言（本例内、兜底回收之前）**——pid 文件里除「成功并仍在运行的那个实例」以外的全部身份已按 PID + 创建时间消失
    //   （全部失败的例子：全部身份已消失）。否则最外层的兜底回收可以把「启动器漏杀失败服务」的回归掩盖成全绿（12T-R M2）；登记表里桩进程归属 launcher，兜底回收若还要杀它，Z.5 判红。
    //   每例有独立截止（SUITE_DEADLINE_MS）：超时 → 该例判红并继续往下走（Promise.race + finally 清计时器，不挂起）；超时后仍在后台的启动尝试，成功的句柄由 stopAll 收，残留进程由登记表回收。
    const RACE_DEADLINE_MS = 60000;
    const withDeadline = (p, ms, label) => {
        let t = null;
        const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error(`${label}：超过独立截止 ${ms}ms 仍未返回（判红并继续，残留由登记表回收）`), { code: 'SUITE_DEADLINE' })), ms); });
        return Promise.race([p, timeout]).finally(() => clearTimeout(t));
    };
    const raceRun = async (tag, mode, extraOpts) => {
        const marker = path.join(PRIV, `race-${tag}.marker`);
        const pf = path.join(PRIV, `race-${tag}.pids`);
        const dirsBefore = tmpInstanceDirs();
        const cap = await captureStderr(() => {
            const pr = ti.startTestInstance(Object.assign({ sourceDbPath: SRC_MINI, sourceEncryptionKey: TEST_KEY, readyTimeoutMs: 20000 }, extraOpts || {}, stubOpts('race', { STUB_MODE: mode, STUB_MARKER: marker, STUB_PID_FILE: pf })));
            pr.then((h) => { startedHandles.push(h); }, () => { /* 失败由下面的 withDeadline 路径报告 */ });   // 无论是否已超时，成功的句柄都登记，stopAll 兜底停止
            return withDeadline(pr, RACE_DEADLINE_MS, `F17(${tag})`);
        });
        const ids = readIds(pf);
        reapIds(`race-${tag}`, ids);
        return { h: cap.value, err: cap.error, stderr: cap.stderr, ids, dirsBefore, dirsAfter: tmpInstanceDirs(), deadline: !!(cap.error && cap.error.code === 'SUITE_DEADLINE') };
    };
    const raceLines = (s) => s.split('\n').filter((l) => /^STARTUP_RACE /.test(l));
    const pCheck = async (id, title, run, expectSurvivor) => {
        // 成功例（expectSurvivor = true）：除最后一个（成功并仍在运行）外全部消失，且最后一个就是返回的实例；全部失败例：全部消失
        const watch = expectSurvivor ? run.ids.slice(0, -1) : run.ids;
        const gone = run.ids.length > 0 && run.ids.every((i) => i.start !== null) && await waitIdsGone(watch, 8000);
        const survivorOk = !expectSurvivor || (run.h && run.ids.length >= 1 && run.ids[run.ids.length - 1].pid === run.h.pid);
        check(id, title, gone && survivorOk, { ids: run.ids, survivor: expectSurvivor ? (run.h && run.h.pid) : null, err: run.err && run.err.message });
    };
    const e1 = await raceRun('busy-ready', 'busy-ready');
    check('F17a', '就绪失败（issue 报 INIT_FAILED）且日志里有 SQLITE_BUSY 证据 → 重试一次后成功：startupRaceRetries = 1，stderr 恰一行 STARTUP_RACE（含失败码 INIT_FAILED、不含日志原文），两次启动的身份都登记了（2 个）', e1.h && e1.h.startupRaceRetries === 1 && raceLines(e1.stderr).length === 1 && /INIT_FAILED/.test(raceLines(e1.stderr)[0]) && !/database is locked/.test(e1.stderr) && e1.ids.length === 2, e1.err ? e1.err.message : { retries: e1.h && e1.h.startupRaceRetries, stderr: e1.stderr, ids: e1.ids });
    await pCheck('F17a-p', '本例内（兜底回收之前）：第一次失败尝试的桩已按身份消失，只剩成功返回的那个实例仍在运行', e1, true);
    if (e1.h) await e1.h.stop();
    const e2 = await raceRun('plain-ready', 'plain-ready');
    check('F17b', '同形的就绪失败但日志里**没有** BUSY 证据 → 不重试直接失败（TI_READY_TIMEOUT，只启动过一次，没有 STARTUP_RACE 输出；唯一的未就绪模块是终态，提前结束等待 earlyEnd）', e2.err && e2.err.code === 'TI_READY_TIMEOUT' && e2.err.earlyEnd === true && e2.ids.length === 1 && raceLines(e2.stderr).length === 0, e2.h ? { retries: e2.h.startupRaceRetries } : { c: e2.err && e2.err.code, ids: e2.ids.length, stderr: e2.stderr });
    await pCheck('F17b-p', '本例内：失败的桩已按身份消失（全部失败，没有幸存者）', e2, false);
    const e3 = await raceRun('busy-crash', 'busy-crash');
    check('F17c', '服务崩溃退出（TI_SERVER_EXITED）且日志尾**同一行**同时有 Uncaught Exception 与 SQLITE_BUSY → 重试一次后成功（startupRaceRetries = 1，一行 STARTUP_RACE）', e3.h && e3.h.startupRaceRetries === 1 && raceLines(e3.stderr).length === 1 && /TI_SERVER_EXITED/.test(raceLines(e3.stderr)[0]) && e3.ids.length === 2, e3.err ? { c: e3.err.code, m: e3.err.message } : { retries: e3.h && e3.h.startupRaceRetries, stderr: e3.stderr });
    await pCheck('F17c-p', '本例内：崩溃退出的第一个桩已按身份消失，只剩成功返回的那个实例仍在运行', e3, true);
    if (e3.h) await e3.h.stop();
    const e4 = await raceRun('plain-crash', 'plain-crash');
    check('F17d', '崩溃退出但日志尾没有 SQLITE_BUSY（只有 Uncaught Exception）→ 不重试直接失败（TI_SERVER_EXITED，只启动过一次）', e4.err && e4.err.code === 'TI_SERVER_EXITED' && e4.ids.length === 1 && raceLines(e4.stderr).length === 0, e4.h ? { retries: e4.h.startupRaceRetries } : { c: e4.err && e4.err.code, ids: e4.ids.length });
    await pCheck('F17d-p', '本例内：失败的桩已按身份消失', e4, false);
    const e5 = await raceRun('zero', 'busy-ready', { startupRaceRetries: 0 });
    check('F17e', 'startupRaceRetries = 0（可配置为 0）：即使有 BUSY 证据也不重试，直接失败', e5.err && e5.err.code === 'TI_READY_TIMEOUT' && e5.ids.length === 1 && raceLines(e5.stderr).length === 0, e5.h ? { retries: e5.h.startupRaceRetries } : { c: e5.err && e5.err.code, ids: e5.ids.length });
    await pCheck('F17e-p', '本例内：失败的桩已按身份消失', e5, false);
    // F17f 提前结束等待只在「全部未就绪模块都已是终态」时触发：第一次启动 issue 终态 INIT_FAILED + quick_log 约 4.5 秒内 NOT_READY → 不能在 quick_log 还没就绪时就收尾
    //   （否则未就绪清单里混着 NOT_READY，classifyStartupRace 拒绝重试，本来能自愈的竞态直接失败）；等 quick_log 就绪、只剩 issue 终态后才结束，归因为竞态 → 重试一次成功
    const e6 = await raceRun('busy-mixed', 'busy-mixed');
    check('F17f', '混合状态（issue 终态 INIT_FAILED + quick_log 起初 NOT_READY、约 4.5 秒后就绪）：不提前结束，等到只剩终态模块才归因 → 重试一次后成功（startupRaceRetries = 1，恰一行 STARTUP_RACE），两次启动的身份都登记了（2 个）', e6.h && e6.h.startupRaceRetries === 1 && raceLines(e6.stderr).length === 1 && /INIT_FAILED/.test(raceLines(e6.stderr)[0]) && e6.ids.length === 2, e6.err ? { c: e6.err.code, m: e6.err.message, u: e6.err.unreadyModules, early: e6.err.earlyEnd, stderr: e6.stderr } : { retries: e6.h && e6.h.startupRaceRetries, stderr: e6.stderr, ids: e6.ids });
    await pCheck('F17f-p', '本例内：第一次失败尝试的桩已按身份消失，只剩成功返回的那个实例仍在运行', e6, true);
    if (e6.h) await e6.h.stop();
    // F17g / F17h 重试上限要测：桩每次启动都按 busy-ready 失败（直到启动次数超过 STUB_MAX_FAILS = 4 才放行——只给「忽略上限」的错误实现一个有界出口），startupRaceRetries = 1 / 2 → 恰好启动 2 / 3 次后失败
    const capCase = async (id, cap) => {
        const run = await raceRun(`always-${cap}`, 'busy-always', { startupRaceRetries: cap });
        const lines = raceLines(run.stderr);
        check(id, `重试上限 startupRaceRetries = ${cap}：每次启动都有 BUSY 证据 → 恰好启动 ${cap + 1} 次后失败（TI_READY_TIMEOUT），stderr 恰 ${cap} 行 STARTUP_RACE，没有触发独立截止，tmpInstanceDirs 前后不多出目录`,
            run.err && run.err.code === 'TI_READY_TIMEOUT' && !run.deadline && run.ids.length === cap + 1 && lines.length === cap && JSON.stringify(run.dirsAfter) === JSON.stringify(run.dirsBefore),
            run.h ? { unexpected_success: true, retries: run.h.startupRaceRetries, ids: run.ids.length } : { c: run.err && run.err.code, deadline: run.deadline, ids: run.ids.length, race: lines.length, before: run.dirsBefore, after: run.dirsAfter });
        await pCheck(`${id}-p`, `本例内：${cap + 1} 次失败尝试的桩（全部）已按 PID + 创建时间消失`, run, false);
        if (run.h) await run.h.stop();
    };
    await capCase('F17g', 1);
    await capCase('F17h', 2);
    // F17i 就绪失败形态的日志证据不计含「不影响启动」的 BUSY 行：issue 永远 INIT_FAILED，日志里只有一行「复位失败（不影响启动）：SQLITE_BUSY」→ 不是竞态证据 → 只启动 1 次、无 STARTUP_RACE
    const e7 = await raceRun('noise', 'noise-ready');
    check('F17i', '就绪失败 + 日志里只有一行含「不影响启动」的 BUSY → 不算竞态证据：只启动 1 次，无 STARTUP_RACE，直接失败（TI_READY_TIMEOUT）', e7.err && e7.err.code === 'TI_READY_TIMEOUT' && e7.ids.length === 1 && raceLines(e7.stderr).length === 0, e7.h ? { retries: e7.h.startupRaceRetries } : { c: e7.err && e7.err.code, ids: e7.ids.length, stderr: e7.stderr });
    await pCheck('F17i-p', '本例内：失败的桩已按身份消失', e7, false);

    // F18 WAL 来源夹具：来源库保持连接打开、关闭自动 checkpoint，只存在于 WAL 的已提交标记行；快照必须带上它；来源只读要直接观测打开标志
    const walFile = path.join(PRIV, '来源 WAL', 'wal.db');
    fs.mkdirSync(path.dirname(walFile), { recursive: true });
    await buildMiniSource(walFile);
    const keeper = await dbOpen(walFile);
    let walCase = null;
    try {
        await dbExec(keeper, 'PRAGMA journal_mode=WAL;');
        await dbExec(keeper, 'PRAGMA wal_autocheckpoint=0;');
        await dbExec(keeper, 'PRAGMA wal_checkpoint(TRUNCATE);');
        await dbExec(keeper, "INSERT INTO users (username, password, display_name, role) VALUES ('wal-marker-row', 'x', 'WAL', 'user')");
        const mainBytes = fs.readFileSync(walFile);
        const walBytes = fs.existsSync(`${walFile}-wal`) ? fs.readFileSync(`${walFile}-wal`) : Buffer.alloc(0);
        const onlyInWal = !mainBytes.includes(Buffer.from('wal-marker-row')) && walBytes.includes(Buffer.from('wal-marker-row'));
        const beforeUsers = await dbAll(keeper, 'SELECT username FROM users ORDER BY id');
        const beforeCfg = await dbAll(keeper, 'SELECT config_key FROM system_configs ORDER BY config_key');
        const mainShaBefore = sha256(mainBytes);
        const walSizeBefore = walBytes.length;
        globalThis.__tiOpenLog.length = 0;
        const w = await attempt({ sourceDbPath: walFile, sourceEncryptionKey: TEST_KEY, readyTimeoutMs: 15000, ...stubOpts('ok') });
        const opens = globalThis.__tiOpenLog.filter((o) => sameFile(o.file, walFile));
        walCase = { onlyInWal, w, opens, beforeUsers, beforeCfg, mainShaBefore, walSizeBefore };
        if (w.h) {
            const inst = await withDb(w.h.dbPath, RO, (d) => dbAll(d, 'SELECT username FROM users ORDER BY id'));
            const afterUsers = await dbAll(keeper, 'SELECT username FROM users ORDER BY id');
            const afterCfg = await dbAll(keeper, 'SELECT config_key FROM system_configs ORDER BY config_key');
            walCase.inst = inst; walCase.afterUsers = afterUsers; walCase.afterCfg = afterCfg;
            walCase.mainShaAfter = sha256(fs.readFileSync(walFile));
            walCase.walSizeAfter = fs.existsSync(`${walFile}-wal`) ? fs.statSync(`${walFile}-wal`).size : 0;
        }
    } finally {
        await dbClose(keeper);
    }
    const wc = walCase;
    check('F18a', 'WAL 夹具成立：标记行已提交但只存在于 WAL 文件（主文件字节里没有）', wc && wc.onlyInWal === true);
    check('F18b', '实例库里有只存在于来源 WAL 的那一行（快照不是只复制主文件）', wc && wc.w.h && wc.inst && wc.inst.some((u) => u.username === 'wal-marker-row'), wc && wc.w.err && wc.w.err.message);
    check('F18c', '来源逻辑数据不变（用户行、配置键与启动前一致）；来源主文件 sha256 与 WAL 大小也不变', wc && wc.afterUsers && JSON.stringify(wc.afterUsers) === JSON.stringify(wc.beforeUsers) && JSON.stringify(wc.afterCfg) === JSON.stringify(wc.beforeCfg) && wc.mainShaAfter === wc.mainShaBefore && wc.walSizeAfter === wc.walSizeBefore, wc && { mainSame: wc.mainShaAfter === wc.mainShaBefore, wal: [wc.walSizeBefore, wc.walSizeAfter] });
    // 注意（预筛 v2 LOW-d）：F18d 是 WAL 夹具**唯一**的判别点——「启动器先以读写方式打开来源库」（WAL2 变异）下 F18c（来源逻辑数据 / 主文件哈希 / WAL 大小不变）仍然绿，只有打开标志的直接观测能抓到。不要简化或合并掉它。
    const ro = sqlite3.OPEN_READONLY; const rwc = sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE;
    check('F18d', '来源库只读被直接观测到：启动期间对来源库的每一次打开都带 OPEN_READONLY 标志、没有 READWRITE / CREATE 位（守卫记录的打开标志），且至少观测到一次（不是空转）', wc && wc.opens.length >= 1 && wc.opens.every((o) => (o.mode & ro) === ro && (o.mode & rwc) === 0), wc && wc.opens);
    if (wc && wc.w.h) await wc.w.h.stop();

    // F19 removeDataRoot 对根的保护：根本身是目录联接时拒绝删除，链接目标原样（lstat 一道；真实路径 = 父真实路径 + 名字 是第二道，二者对联接根同时成立，见交付报告的取舍）
    const jTarget = path.join(PRIV, 'jroot-target');
    fs.mkdirSync(jTarget);
    fs.writeFileSync(path.join(jTarget, 'keep.txt'), 'keep');
    const jRoot = path.join(PRIV, 'jroot-link');
    fs.symlinkSync(jTarget, jRoot, 'junction');
    const rmMsg = ti._internals.removeDataRoot(jRoot);
    check('F19', 'removeDataRoot：根是目录联接 → 拒绝删除（返回原因），联接目标与里面的文件原样；对普通目录根仍然删干净', typeof rmMsg === 'string' && /拒绝删除/.test(rmMsg) && fs.existsSync(path.join(jTarget, 'keep.txt')) && (() => { common.removeLinkChecked(jRoot); const plain = path.join(PRIV, 'plain-root'); fs.mkdirSync(plain); fs.writeFileSync(path.join(plain, 'x'), 'x'); return ti._internals.removeDataRoot(plain) === null && lstatOrNull(plain) === null; })(), rmMsg);
}

// ---------------------------------------------------------------- 节 W：遗留清理 sweep
async function sectionW() {
    console.log('\n== 节 W：遗留清理 ==');
    const root = path.join(PRIV, 'sweep-root');
    fs.mkdirSync(root);
    const startIdle = async (label) => {
        const rec = await spawnHelper(label, process.execPath, ['-e', 'setInterval(function(){}, 1000)'], { stdio: 'ignore', windowsHide: true }, 'suite');
        const st = rec.ok ? (rec.startTime || await waitUntil(() => { try { return procLib.getStartTime(rec.pid); } catch (_) { return null; } }, 20000, 200)) : null;
        return { ok: rec.ok, error: rec.error, child: rec.child, pid: rec.pid, start: st };
    };
    const dead = await startIdle('W dead');
    const live = dead.ok ? await startIdle('W live') : { ok: false, error: dead.error };
    const idleOk = dead.ok && live.ok && !!dead.start && !!live.start;
    check('W0', 'W 节辅助进程（W dead / W live）经 spawnHelper 创建成功并取得精确创建时间；创建失败时本节判红并跳过，不抛未处理异常', idleOk, { dead: dead.error && dead.error.message, live: live.error && live.error.message, ds: dead.start, ls: live.start });
    if (!idleOk) return;
    dead.child.kill();
    await waitUntil(() => !alive(dead.pid), 10000);
    const me = { pid: process.pid, start: procLib.getStartTime(process.pid) };
    const shift = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();
    const mkdirIn = (rootDir, name, manifest, raw) => {
        const dir = path.join(rootDir, name);
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'payload.txt'), 'payload');
        if (manifest !== null) fs.writeFileSync(path.join(dir, 'sdh-instance.json'), raw !== undefined ? raw : JSON.stringify(Object.assign({ instance: `test-${name.slice(9)}`, parent: 'main', pid: dead.pid, createdAt: new Date().toISOString(), dir: fwd(dir) }, manifest)));
        return dir;
    };
    const mkdir = (name, manifest, raw) => mkdirIn(root, name, manifest, raw);
    const wrongStart = shift(live.start, 2000);
    const dDead = mkdir('sdh-test-dead', { serverPid: dead.pid, serverStartTime: dead.start, pidStartTime: dead.start });
    const dAlive = mkdir('sdh-test-alive', { serverPid: live.pid, serverStartTime: live.start });
    const dReused = mkdir('sdh-test-reused', { serverPid: live.pid, serverStartTime: wrongStart, pid: live.pid, pidStartTime: wrongStart });
    const dNoMan = mkdir('sdh-test-noman', null);
    const dCorrupt = mkdir('sdh-test-corrupt', {}, '{ this is not json');
    const dMismatch = mkdir('sdh-test-mismatch', { serverPid: dead.pid, serverStartTime: dead.start, dir: fwd(path.join(root, 'some-other-dir')) });
    const dLauncher = mkdir('sdh-test-launcher', { pid: me.pid, pidStartTime: me.start, serverPid: dead.pid, serverStartTime: dead.start });
    const dNoId = mkdir('sdh-test-noident', { pid: dead.pid });
    // 身份字段「存在但不合法」：服务还活着（serverPid = live.pid），但创建时间不是标准 ISO 串，启动器身份已死 → 必须保留（MANIFEST_INVALID），不能当成「没有服务身份」而删掉
    const dBadIso = mkdir('sdh-test-badiso', { serverPid: live.pid, serverStartTime: 'Sat Oct 18 2026 10:00:00', pidStartTime: dead.start });
    const dBadPid = mkdir('sdh-test-badpid', { serverPid: String(live.pid), serverStartTime: live.start, pidStartTime: dead.start });
    const dHalf = mkdir('sdh-test-halfid', { serverPid: live.pid, pidStartTime: dead.start });
    const dBadLauncher = mkdir('sdh-test-badlaunch', { serverPid: dead.pid, serverStartTime: dead.start, pidStartTime: 'not-a-time' });
    const dForeign = path.join(root, 'other-dir-not-ours');
    fs.mkdirSync(dForeign);
    fs.writeFileSync(path.join(dForeign, 'sdh-instance.json'), JSON.stringify({ instance: 'test-foreign', parent: 'main', pid: dead.pid, createdAt: new Date().toISOString(), dir: fwd(dForeign), serverPid: dead.pid, serverStartTime: dead.start }));
    const linkTargetDir = path.join(PRIV, 'sweep-link-target');
    fs.mkdirSync(linkTargetDir);
    fs.writeFileSync(path.join(linkTargetDir, 'keep.txt'), 'keep');
    fs.symlinkSync(linkTargetDir, path.join(root, 'sdh-test-link'), 'junction');
    const dChinese = mkdir('sdh-test-cjk', { serverPid: dead.pid, serverStartTime: dead.start, pidStartTime: dead.start });
    fs.mkdirSync(path.join(dChinese, '子目录 空格'));
    fs.writeFileSync(path.join(dChinese, '子目录 空格', '文件 一.txt'), 'x');

    const res = await ti.sweepStaleTestInstances({ tmpRoot: root });
    const removedNames = res.removed.map((p) => path.basename(p)).sort();
    const keptMap = Object.fromEntries(res.kept.map((k) => [path.basename(k.dir), k.reason]));
    check('W1', '清单里的进程已不存在（服务与启动器身份都 dead）→ 删除（含中文 + 空格的子目录）', removedNames.includes('sdh-test-dead') && removedNames.includes('sdh-test-cjk') && lstatOrNull(dDead) === null && lstatOrNull(dChinese) === null, res);
    check('W2', '清单里的 PID 存活且创建时间一致 → 保留（PROCESS_ALIVE(server)），内容原样', keptMap['sdh-test-alive'] === 'PROCESS_ALIVE(server)' && fs.existsSync(path.join(dAlive, 'payload.txt')), keptMap);
    check('W3', 'PID 被复用（PID 相同、创建时间差 2 秒）→ 删除，且没有终止那个进程', removedNames.includes('sdh-test-reused') && lstatOrNull(dReused) === null && alive(live.pid), removedNames);
    check('W4', '没有清单 → 保留（MANIFEST_MISSING）；清单损坏 → 保留（MANIFEST_INVALID）；清单 dir 与目录不符 → 保留（MANIFEST_DIR_MISMATCH）', keptMap['sdh-test-noman'] === 'MANIFEST_MISSING' && keptMap['sdh-test-corrupt'] === 'MANIFEST_INVALID' && keptMap['sdh-test-mismatch'] === 'MANIFEST_DIR_MISMATCH' && fs.existsSync(dNoMan) && fs.existsSync(dCorrupt) && fs.existsSync(dMismatch), keptMap);
    check('W5', '只有启动器自己还活着（服务已死）→ 保留（PROCESS_ALIVE(launcher)）；清单里没有任何带创建时间的身份 → 保留（NO_PROCESS_IDENTITY）', keptMap['sdh-test-launcher'] === 'PROCESS_ALIVE(launcher)' && keptMap['sdh-test-noident'] === 'NO_PROCESS_IDENTITY' && fs.existsSync(dLauncher) && fs.existsSync(dNoId), keptMap);
    check('W6', '名字不是 sdh-test-* 的目录从不触碰（即使有合法且已死的清单）；名字匹配但是链接的 → 保留（NOT_A_DIRECTORY），链接目标原样', fs.existsSync(path.join(dForeign, 'sdh-instance.json')) && !res.removed.includes(dForeign) && !res.kept.some((k) => k.dir === dForeign) && keptMap['sdh-test-link'] === 'NOT_A_DIRECTORY' && fs.existsSync(path.join(linkTargetDir, 'keep.txt')), { keptMap, scanned: res.scanned });
    check('W7', '返回值 scanned = 匹配 sdh-test-* 的目录数（14），failed 为空', res.scanned === 14 && res.failed.length === 0, res);
    check('W8', '身份字段存在但不合法（serverStartTime 非标准 ISO / serverPid 不是整数 / 只有 serverPid 没有创建时间 / pidStartTime 非标准 ISO）→ 全部保留（MANIFEST_INVALID），含「服务仍存活」的那个目录——不能当作没有身份而删掉', ['sdh-test-badiso', 'sdh-test-badpid', 'sdh-test-halfid', 'sdh-test-badlaunch'].every((n) => keptMap[n] === 'MANIFEST_INVALID') && [dBadIso, dBadPid, dHalf, dBadLauncher].every((d) => fs.existsSync(path.join(d, 'payload.txt'))) && alive(live.pid), keptMap);

    // W9 身份查询失败 → 保留（IDENTITY_QUERY_FAILED）：用 line-proc 的 _test.psPrelude 把 Get-CimInstance 遮蔽成抛错，让存活进程的身份查询失败
    const root2 = path.join(PRIV, 'sweep-root-qfail');
    fs.mkdirSync(root2);
    const dQ = mkdirIn(root2, 'sdh-test-qfail', { serverPid: live.pid, serverStartTime: live.start, pidStartTime: live.start });
    procLib._test.psPrelude = "function Get-CimInstance { throw 'injected CIM failure' }";
    let resQ = null;
    try { resQ = await ti.sweepStaleTestInstances({ tmpRoot: root2 }); } finally { procLib._test.psPrelude = ''; }
    check('W9', '身份查询失败（存活进程，CIM 被遮蔽成抛错）→ 保留（IDENTITY_QUERY_FAILED），不当作进程已死而删除；内容原样', resQ && resQ.removed.length === 0 && resQ.kept.length === 1 && /^IDENTITY_QUERY_FAILED\(/.test(resQ.kept[0].reason) && fs.existsSync(path.join(dQ, 'payload.txt')), resQ);
    // 清理：W 节的桩进程由登记表统一回收；这里先杀掉自己的（句柄在手），再拆联接
    for (const k of PROCS.filter((p) => /^W /.test(p.label) && p.child && childRunning(p.child))) { try { k.child.kill(); } catch (_) { /* 句柄在手 */ } await waitChildExit(k.child, 5000); }
    common.removeLinkChecked(path.join(root, 'sdh-test-link'));
}

// ---------------------------------------------------------------- 节 K：父进程被强杀
async function sectionK() {
    console.log('\n== 节 K：父进程被强杀 ==');
    const out = path.join(PRIV, 'k-out.json');
    const helper = path.join(PRIV, '_k-parent.js');
    const helperOpts = `{ nodeArgs: ${JSON.stringify(GUARD_ARGS)}, extraEnv: ${JSON.stringify(GUARD_ENV)}`;
    fs.writeFileSync(helper, `
'use strict';
const fs = require('fs');
const ti = require(${JSON.stringify(LAUNCHER_PATH)});
(async () => {
  const h = await ti.startTestInstance(Object.assign(${helperOpts} }, { sourceDbPath: ${JSON.stringify(SRC_MINI)}, sourceEncryptionKey: ${JSON.stringify(TEST_KEY)}, serverJs: ${JSON.stringify(stubPath('ok'))}, readyTimeoutMs: 20000 }));
  fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ parentPid: process.pid, serverPid: h.pid, serverStart: h.startTime, port: h.port, dataDir: h.dataDir }));
  setInterval(() => {}, 1000);
})().catch((e) => { fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ error: String(e && e.message) })); process.exit(1); });
`);
    const helperRec = await spawnHelper('K helper', process.execPath, ['--require', GUARD, helper], { stdio: 'ignore', windowsHide: true, env: Object.assign({}, process.env) }, 'suite');   // 辅助进程同样装数据库路径守卫（GUARD_ROOT = 私有根，越界抛错）
    const child = helperRec.child;
    const info = helperRec.ok ? await waitUntil(() => { try { return JSON.parse(fs.readFileSync(out, 'utf8')); } catch (_) { return null; } }, 40000, 200) : null;
    check('K1', '辅助进程（经 spawnHelper 创建，创建失败不抛）调用启动器起了实例（桩服务）', helperRec.ok && info && info.serverPid > 0 && !info.error, info || { spawnError: helperRec.error && helperRec.error.message });
    if (!info || !info.serverPid) { try { if (child) child.kill(); } catch (_) { /* */ } return; }
    registerIdentity('K 桩服务', info.serverPid, info.serverStart, 'launcher');   // 父进程被强杀后，服务必须由作业对象带走：归属 launcher
    check('K2', '被杀之前：服务在、清单里有服务与启动器身份', alive(info.serverPid) && fs.existsSync(path.join(info.dataDir, 'sdh-instance.json')));
    const t0 = Date.now();
    child.kill();                                              // TerminateProcess：不触发 exit 事件，不留清理机会
    await waitChildExit(child, 15000);
    const goneIn = await waitUntil(() => !alive(info.serverPid), 15000, 100);
    const idState = identityState(info.serverPid, info.serverStart);
    check('K3', '父进程被强杀后，服务进程在有界时间内消失（作业对象连带结束；PID + 创建时间核对 dead / reused）', goneIn !== null && (idState === 'dead' || idState === 'reused'), { ms: Date.now() - t0, idState });
    if (goneIn === null) { try { procLib.killIfIdentity({ pid: info.serverPid, start_time: info.serverStart }); } catch (_) { /* 兜底：按身份收自己起的桩 */ } }
    check('K4', '端口已释放，数据根留给 sweep（目录和清单都在）', Array.isArray(procLib.portListeners(info.port)) && procLib.portListeners(info.port).length === 0 && fs.existsSync(path.join(info.dataDir, 'sdh-instance.json')));
    const sw = await ti.sweepStaleTestInstances();
    check('K5', 'sweep（默认扫私有临时根）删掉它：启动器与服务的身份都已不存在', sw.removed.map((p) => path.basename(p)).includes(path.basename(info.dataDir)) && lstatOrNull(info.dataDir) === null, sw);

    // K6 进程 exit 事件里尽力同步终止服务：辅助进程触发 process 'exit' 处理器（process.emit，进程本身仍在、作业对象仍在），服务必须因处理器而消失；数据根留给 sweep
    const out2 = path.join(PRIV, 'k6-out.json');
    const helper2 = path.join(PRIV, '_k6-parent.js');
    fs.writeFileSync(helper2, `
'use strict';
const fs = require('fs');
const ti = require(${JSON.stringify(LAUNCHER_PATH)});
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); } };
(async () => {
  const h = await ti.startTestInstance(Object.assign(${helperOpts} }, { sourceDbPath: ${JSON.stringify(SRC_MINI)}, sourceEncryptionKey: ${JSON.stringify(TEST_KEY)}, serverJs: ${JSON.stringify(stubPath('ok'))}, readyTimeoutMs: 20000 }));
  const before = alive(h.pid);
  process.emit('exit', 0);
  const end = Date.now() + 8000;
  while (alive(h.pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  fs.writeFileSync(${JSON.stringify(out2)}, JSON.stringify({ aliveBefore: before, aliveAfterEmit: alive(h.pid), serverPid: h.pid, serverStart: h.startTime, dataDir: h.dataDir }));
  process.exit(0);
})().catch((e) => { fs.writeFileSync(${JSON.stringify(out2)}, JSON.stringify({ error: String(e && e.message) })); process.exit(1); });
`);
    const c2Rec = await spawnHelper('K6 helper', process.execPath, ['--require', GUARD, helper2], { stdio: 'ignore', windowsHide: true, env: Object.assign({}, process.env) }, 'suite');
    const c2 = c2Rec.child;
    const info2 = c2Rec.ok ? await waitUntil(() => { try { return JSON.parse(fs.readFileSync(out2, 'utf8')); } catch (_) { return null; } }, 40000, 200) : null;
    const c2gone = c2Rec.ok ? await waitChildExit(c2, 20000) : false;   // 局部截止：helper 迟迟不退出时由登记表回收，不无限等
    if (info2 && info2.serverPid && info2.serverStart) registerIdentity('K6 桩服务', info2.serverPid, info2.serverStart, 'launcher');   // exit 处理器必须带走服务：归属 launcher
    check('K6', "进程 'exit' 事件处理器同步终止仍在跑的服务（辅助进程 emit exit 后服务消失），数据根保留给 sweep", c2Rec.ok && c2gone && info2 && info2.aliveBefore === true && info2.aliveAfterEmit === false && fs.existsSync(path.join(info2.dataDir, 'sdh-instance.json')), info2 || { spawnError: c2Rec.error && c2Rec.error.message });
    if (info2 && info2.serverPid && alive(info2.serverPid)) { try { procLib.killIfIdentity({ pid: info2.serverPid, start_time: info2.serverStart }); } catch (_) { /* 兜底：按身份收自己起的桩 */ } }
    const sw2 = await ti.sweepStaleTestInstances();
    check('K7', 'sweep 删掉 K6 留下的数据根', info2 && sw2.removed.map((p) => path.basename(p)).includes(path.basename(info2.dataDir)) && lstatOrNull(info2.dataDir) === null, sw2);
}

// ---------------------------------------------------------------- 节 U：纯函数 / it-ledger 访问函数 / 静态核对
async function sectionU() {
    console.log('\n== 节 U：汇总判定纯函数 / it-ledger 访问函数 / 接线静态核对 ==');
    const { summarizeState, buildReport, codeOfError, normalizeEntry } = healthUtil;
    check('U1.1', 'summarizeState：就绪 → { ready: true, code: null }；未就绪无错误 → NOT_READY；错误是字符串（中文长句）→ INIT_FAILED，原文不出', JSON.stringify(summarizeState({ ready: true, error: null })) === '{"ready":true,"code":null}' && JSON.stringify(summarizeState({ ready: false, error: null })) === '{"ready":false,"code":"NOT_READY"}'
        && JSON.stringify(summarizeState({ ready: false, error: '需求跟踪表已有数据但 issues 主表结构不完整' })) === '{"ready":false,"code":"INIT_FAILED"}');
    check('U1.2', 'summarizeState：错误对象上形态合法的 code 原样给出；形态不合法（小写 / 含空格 / 超 64 位 / 非字符串）→ INIT_FAILED', summarizeState({ ready: false, error: { code: 'SOME_CODE_1', message: 'secret-detail' } }).code === 'SOME_CODE_1'
        && ['bad code', 'lower_case', 'X'.repeat(65), 5, null, '1ABC'].every((c) => summarizeState({ ready: false, error: { code: c, message: 'm' } }).code === 'INIT_FAILED') && codeOfError('plain string') === 'INIT_FAILED');
    check('U1.3', 'summarizeState：有 error 时即使 ready=true 也判未就绪（与各模块 503 中间件先判 error 同口径）；非对象 / 缺失 → NOT_READY', summarizeState({ ready: true, error: 'boom' }).ready === false && summarizeState(undefined).code === 'NOT_READY' && summarizeState(null).ready === false);
    check('U1.4', 'normalizeEntry：未就绪条目的 code 形态不合法（小写 / 含空格 / 超 64 位 / 非字符串 / 缺失）一律 INIT_FAILED；合法 code（含 NOT_READY）原样；非对象 → { false, INIT_FAILED }', ['lowercase leak', 'bad code', 'X'.repeat(65), 5, null, undefined].every((c) => normalizeEntry({ ready: false, code: c }).code === 'INIT_FAILED') && normalizeEntry({ ready: false }).code === 'INIT_FAILED'
        && normalizeEntry({ ready: false, code: 'NOT_READY' }).code === 'NOT_READY' && normalizeEntry({ ready: false, code: 'SQLITE_BUSY' }).code === 'SQLITE_BUSY' && JSON.stringify(normalizeEntry('x')) === '{"ready":false,"code":"INIT_FAILED"}');
    const rep = buildReport({ instance: 'test-x', mode: 'isolated', sources: {
        a: () => ({ ready: true, code: null }),
        b: () => { throw new Error('SECRET-DETAIL-should-not-leak'); },
        c: () => ({ ready: false, code: 'lowercase leak', extra: 'SECRET-EXTRA' }),
        d: () => summarizeState({ ready: false, error: 'SECRET-LONG-SENTENCE' }),
    } });
    const repText = JSON.stringify(rep);
    check('U2.1', 'buildReport：访问函数抛异常 / 返回形态不合法的 code / 状态里是中文长句 → 只出现稳定 code（INIT_FAILED），原文不出；任一未就绪 → ok=false、HTTP 503', rep.status === 503 && rep.body.ok === false && rep.body.modules.b.code === 'INIT_FAILED' && rep.body.modules.c.code === 'INIT_FAILED' && rep.body.modules.d.code === 'INIT_FAILED' && !/SECRET/.test(repText), repText);
    const okRep = buildReport({ instance: null, mode: 'normal', sources: { a: () => ({ ready: true, code: null }), b: () => ({ ready: true, code: 'IGNORED' }) } });
    check('U2.2', 'buildReport：全部就绪 → ok=true、HTTP 200，就绪项 code 恒为 null；模块集合为空不算就绪（503）', okRep.status === 200 && okRep.body.ok === true && okRep.body.modules.b.code === null && buildReport({ instance: null, mode: 'normal', sources: {} }).status === 503);
    check('U2.3', 'buildReport：ok 只在全部就绪时为真（逐个翻转一个模块，ok 必随之为假）', ['a', 'b', 'c'].every((flip) => {
        const s = {}; for (const n of ['a', 'b', 'c']) s[n] = () => ({ ready: n !== flip, code: n !== flip ? null : 'NOT_READY' });
        const r = buildReport({ instance: 'i', mode: 'isolated', sources: s });
        return r.body.ok === false && r.status === 503 && r.body.modules[flip].ready === false;
    }) && normalizeEntry({ ready: true, code: 'X' }).code === null);

    // it-ledger 访问函数：真工厂 + 临时库（私有根内），状态 ready / not-ready / draining
    const itLedgerFactory = require(path.join(SERVER_TREE, 'routes', 'it-ledger'));
    const ledgerDb = path.join(PRIV, 'ledger-unit.db');
    const logger = { info() {}, warn() {}, error() {}, debug() {} };
    const mod = itLedgerFactory({ logger, DB_FILE: ledgerDb, authenticateToken: (q, s, n) => n(), requireAdmin: (q, s, n) => n() });
    const g0 = mod.getReadiness();
    await mod.initSchema();
    const ready = await waitUntil(() => mod.getReadiness().ready === true, 30000, 100);
    const g1 = mod.getReadiness();
    await mod.shutdown();
    const g2 = mod.getReadiness();
    check('U3', 'it-ledger getReadiness：初始化前 { false, LEDGER_NOT_READY }；就绪后 { true, null }；shutdown 后 { false, LEDGER_DRAINING }（draining 先于 ready 判）', JSON.stringify(g0) === '{"ready":false,"code":"LEDGER_NOT_READY"}' && ready && JSON.stringify(g1) === '{"ready":true,"code":null}' && JSON.stringify(g2) === '{"ready":false,"code":"LEDGER_DRAINING"}', { g0, g1, g2 });

    // ---- 启动器纯函数（修复批 2）：提前结束等待的终态判定、竞态证据与分类
    const tm = ti._internals.terminalModules;
    const okm = { ready: true, code: null };
    const TERM = (code) => ({ ready: false, code });
    check('U5.1', 'terminalModules（提前结束等待的判定）：只有「全部未就绪模块都是终态」才返回它们——core=SQLITE_BUSY + it_ledger=LEDGER_NOT_READY（12-R M1 的原样）→ []；issue=INIT_FAILED + quick_log=NOT_READY → []；未就绪且没有码 → []；全部就绪 → []；只有终态的 → 列出；想等的子集之外的未就绪模块不计',
        tm({ core: TERM('SQLITE_BUSY'), it_ledger: TERM('LEDGER_NOT_READY') }, 'all').length === 0
        && tm({ core: TERM('SQLITE_BUSY'), it_ledger: okm }, 'all').join() === 'core'
        && tm({ issue: TERM('INIT_FAILED'), quick_log: TERM('NOT_READY') }, 'all').length === 0
        && tm({ issue: TERM('INIT_FAILED'), quick_log: { ready: false } }, 'all').length === 0
        && tm({ core: okm, issue: okm }, 'all').length === 0
        && tm({ issue: TERM('INIT_FAILED'), it_ledger: TERM('LEDGER_UNAVAILABLE') }, 'all').join() === 'issue,it_ledger'
        && tm({ issue: TERM('INIT_FAILED'), quick_log: TERM('NOT_READY') }, ['issue']).join() === 'issue'
        && tm({ issue: TERM('INIT_FAILED'), quick_log: TERM('NOT_READY') }, ['issue', 'quick_log']).length === 0);
    const cls = ti._internals.classifyStartupRace;
    const scan = ti._internals.scanRaceEvidence;
    const RE = (o) => Object.assign(new Error('x'), o);
    check('U5.2', 'classifyStartupRace：未就绪码里有 SQLITE_BUSY（core 直接带 sqlite 的 code，不写日志）本身就是证据——core=SQLITE_BUSY 且日志里 busyCount = 0 → 重试；INIT_FAILED 且 busyCount = 0 → 不重试（仍要日志证据）；core=SQLITE_CONSTRAINT 即使日志有 BUSY 也不重试；混着非竞态码（NOT_READY）→ 不重试（条件不放宽）',
        cls(RE({ code: 'TI_READY_TIMEOUT', unreadyModules: [{ name: 'core', code: 'SQLITE_BUSY' }], busyCount: 0, crashBusy: false })) !== null
        && cls(RE({ code: 'TI_READY_TIMEOUT', unreadyModules: [{ name: 'core', code: 'SQLITE_BUSY' }, { name: 'issue', code: 'INIT_FAILED' }], busyCount: 0, crashBusy: false })) !== null   // 任一未就绪码是 SQLITE_BUSY 即证据（不是「全部」；收口预筛 LOW-3 / OWN-1）
        && cls(RE({ code: 'TI_READY_TIMEOUT', unreadyModules: [{ name: 'issue', code: 'INIT_FAILED' }], busyCount: 0, crashBusy: false })) === null
        && cls(RE({ code: 'TI_READY_TIMEOUT', unreadyModules: [{ name: 'issue', code: 'INIT_FAILED' }], busyCount: 2, crashBusy: false })) !== null
        && cls(RE({ code: 'TI_READY_TIMEOUT', unreadyModules: [{ name: 'core', code: 'SQLITE_CONSTRAINT' }], busyCount: 5, crashBusy: false })) === null
        && cls(RE({ code: 'TI_READY_TIMEOUT', unreadyModules: [{ name: 'core', code: 'SQLITE_BUSY' }, { name: 'quick_log', code: 'NOT_READY' }], busyCount: 5, crashBusy: false })) === null);
    const noiseLog = ['[INFO] boot', '[ERROR] [周期取数推送] M-2 僵尸 run 复位失败（不影响启动）：SQLITE_BUSY: database is locked', '[ERROR] [需求跟踪 C1] issues 主表结构不完整'].join('\n');
    const realBusyLog = ['[INFO] boot', '[ERROR] 建表 DDL 失败：SQLITE_BUSY: database is locked'].join('\n');
    const evNoise = scan(noiseLog);
    const evReal = scan(realBusyLog);
    check('U5.3', '竞态证据只计真正的 BUSY 行：日志里只有一行含「不影响启动」的 BUSY → busyCount = 0 → issue=INIT_FAILED 不重试；一行普通 BUSY → busyCount = 1 → 重试（对照：过滤不是把 BUSY 全部清零）',
        evNoise.busyCount === 0 && evReal.busyCount === 1
        && cls(RE({ code: 'TI_READY_TIMEOUT', unreadyModules: [{ name: 'issue', code: 'INIT_FAILED' }], busyCount: evNoise.busyCount, crashBusy: evNoise.crashBusy })) === null
        && cls(RE({ code: 'TI_READY_TIMEOUT', unreadyModules: [{ name: 'issue', code: 'INIT_FAILED' }], busyCount: evReal.busyCount, crashBusy: evReal.crashBusy })) !== null, { evNoise, evReal });
    const crashSplit = ['[ERROR] Uncaught Exception: TypeError: Cannot read properties of undefined', '[ERROR] 复位失败：SQLITE_BUSY: database is locked'].join('\n');
    const crashSame = ['[INFO] boot', '[ERROR] Uncaught Exception: [Error: SQLITE_BUSY: database is locked] {', "  code: 'SQLITE_BUSY'", '}'].join('\n');
    check('U5.4', '崩溃形态必须**同一行**同时有 Uncaught Exception 与 SQLITE_BUSY：崩溃是 TypeError、另一行有 BUSY → crashBusy = false → TI_SERVER_EXITED 不重试；真实 #122 崩溃行（同一行）→ crashBusy = true → 重试',
        scan(crashSplit).crashBusy === false && scan(crashSame).crashBusy === true
        && cls(RE({ code: 'TI_SERVER_EXITED', busyCount: scan(crashSplit).busyCount, crashBusy: scan(crashSplit).crashBusy })) === null
        && cls(RE({ code: 'TI_SERVER_EXITED', busyCount: scan(crashSame).busyCount, crashBusy: scan(crashSame).crashBusy })) !== null, { split: scan(crashSplit), same: scan(crashSame) });

    // ---- spawnHelper 自检（12T-R M4）：创建一个不存在的可执行文件 → 返回错误、不抛、套件继续
    const badExe = path.join(PRIV, '不存在的 目录', 'no-such-executable.exe');
    let helperThrown = null;
    let badHelper = null;
    try { badHelper = await spawnHelper('U 不存在的可执行文件', badExe, [], { stdio: 'ignore', windowsHide: true }, 'suite'); } catch (e) { helperThrown = e; }
    const badExited = badHelper && badHelper.child ? await waitChildExit(badHelper.child, 2000) : true;
    check('U6.1', 'spawnHelper 启动一个不存在的可执行文件路径：不抛、返回 ok = false 与非空 error（ENOENT），状态 error 非空且 spawned = false，waitChildExit 立即返回（已出错且未运行），套件继续',
        helperThrown === null && badHelper && badHelper.ok === false && badHelper.error && badHelper.state && badHelper.state.error !== null && badHelper.state.spawned === false && badExited === true, helperThrown ? helperThrown.message : { ok: badHelper && badHelper.ok, err: badHelper && badHelper.error && badHelper.error.code, spawned: badHelper && badHelper.state && badHelper.state.spawned });

    // 接线静态核对（源码文本）：路由定义、模块名全集、每个模块的访问函数接的是自己的状态对象、不写库
    const serverSrc = fs.readFileSync(path.join(SERVER_TREE, 'server.js'), 'utf8');
    const rs = serverSrc.indexOf("app.get('/api/health/ready'");
    const re = serverSrc.indexOf('// 获取当前用户信息', rs);
    const handler = rs >= 0 && re > rs ? serverSrc.slice(rs, re) : '';
    check('U4.1', '路由 GET /api/health/ready 定义一次、无认证中间件（路径后面直接是处理函数）、响应带 Cache-Control: no-store', (serverSrc.match(/app\.get\('\/api\/health\/ready'/g) || []).length === 1 && /app\.get\('\/api\/health\/ready', \(req, res\) =>/.test(handler) && /Cache-Control', 'no-store'/.test(handler), handler.slice(0, 120));
    check('U4.2', '处理函数里没有任何写库 / 初始化调用（db.run / dbRunAsync / initSchema / INSERT / UPDATE / DELETE / ALTER / DROP / CREATE）', handler.length > 100 && !/\bdb\.(run|exec|serialize|prepare)\b|dbRunAsync|initSchema|\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/.test(handler.replace(/\/\/[^\n]*/g, '')), handler.length);
    const wiring = {
        core: 'healthReady.summarizeState(CORE_INIT_STATE)', issue: 'healthReady.summarizeState(ISSUE_SCHEMA_STATE)', issue_v1750: 'healthReady.summarizeState(ISSUE_V1750_SCHEMA_STATE)', issue_lite: 'healthReady.summarizeState(ISSUE_LITE_SCHEMA_STATE)',
        quick_log: 'healthReady.summarizeState(QUICK_LOG_SCHEMA_STATE)', collab_dualcheck: 'healthReady.summarizeState(COLLAB_QUALITY_DUALCHECK_SCHEMA_STATE)',
        correction: 'correctionModule.getReadiness()', sys_iteration: 'sysIterModule.getReadiness()', periodic: 'periodicFetchModule.getReadiness()', legacy_archive: 'legacyArchiveModule.getReadiness()', it_ledger: 'itLedgerModule.getReadiness()',
    };
    const wiringBad = Object.keys(wiring).filter((n) => !handler.includes(`${n}: () => ${wiring[n]},`));
    check('U4.3', '汇总的 11 个模块各自接对来源（名字 → 自己的状态对象 / 自己模块的 getReadiness），一个不多一个不少', wiringBad.length === 0 && (handler.match(/^\s{12}[a-z_0-9]+: \(\) =>/gm) || []).length === 11, wiringBad);
    const modFiles = {
        'routes/corrections.js': 'CORRECTION_SCHEMA_STATE', 'routes/sys-iteration/index.js': 'SYS_SCHEMA_STATE', 'routes/periodic-fetch/index.js': 'PERIODIC_SCHEMA_STATE', 'routes/legacy-archive/index.js': 'LEGACY_ARCHIVE_SCHEMA_STATE',
    };
    const modBad = [];
    for (const [rel, st] of Object.entries(modFiles)) {
        const src = fs.readFileSync(path.join(SERVER_TREE, rel), 'utf8');
        const okDef = new RegExp(`const getReadiness = \\(\\) => require\\('[./]+/utils/health-ready'\\)\\.summarizeState\\(${st}\\);`).test(src);
        const okExp = /return \{[^}]*\bgetReadiness\b/.test(src.slice(src.lastIndexOf('  return {')));
        if (!okDef || !okExp) modBad.push({ rel, okDef, okExp });
    }
    check('U4.4', '四个路由模块（corrections / sys-iteration / periodic-fetch / legacy-archive）的 getReadiness 折算的是各自的状态对象并随工厂导出', modBad.length === 0, modBad);
    // core 状态机（静态）：声明形态不变；ready=true 只在 initTable 队列收尾那条 SELECT 1 的回调里、且只在没有累计错误时置位；recordCoreInitFailure 只记首个错误并立刻 ready=false
    const coreSets = serverSrc.match(/CORE_INIT_STATE\.ready = true/g) || [];
    const cb = serverSrc.indexOf("db.run('SELECT 1', (coreErr) => {");
    const coreAt = serverSrc.indexOf('CORE_INIT_STATE.ready = true');
    const tailBlock = cb > 0 ? serverSrc.slice(cb, cb + 900) : '';
    const recFn = serverSrc.slice(serverSrc.indexOf('function recordCoreInitFailure(err) {'), serverSrc.indexOf('function coreAlterDone(err) {'));
    check('U4.5', 'core 就绪标志只在 initTable 末尾那条排在 serialize 队列最后的 SELECT 1 回调里置位（全文件只此一处），且仅当此前没有累计错误；recordCoreInitFailure 只记首个错误并置 ready=false', coreSets.length === 1 && cb > 0 && coreAt > cb && coreAt - cb < 900 && /const CORE_INIT_STATE = \{ ready: false, error: null \};/.test(serverSrc)
        && /if \(coreErr\) recordCoreInitFailure\(coreErr\);\s*else if \(CORE_INIT_STATE\.error === null\) CORE_INIT_STATE\.ready = true;/.test(tailBlock)
        && /if \(CORE_INIT_STATE\.error === null\) CORE_INIT_STATE\.error = /.test(recFn) && /CORE_INIT_STATE\.ready = false;/.test(recFn), { sets: coreSets.length, cb, coreAt, rec: recFn.slice(0, 200) });
    // 接线完整性（静态，AST）：initTable 里（需求跟踪 / 数据开发台账 / 零星事项台账三段除外——它们各有模块就绪标志）每个带回调的 db.run/get/all/exec/each，回调要么是 coreAlterDone，要么首句就把自己的 err 参数汇入 core
    const wired = (() => {
        const toks = {
            from: serverSrc.indexOf('// ==================== 需求跟踪模块（v1.74.0 升级：问题跟踪 → 需求跟踪）===================='),
            to: serverSrc.indexOf('// ==================== 数据协作模块（v1.0.1 一阶段）===================='),
        };
        const ast = acorn.parse(serverSrc, { ecmaVersion: 'latest', allowHashBang: true, sourceType: 'script', locations: true });
        let init = null;
        for (const n of ast.body) { if (n.type === 'FunctionDeclaration' && n.id.name === 'initTable') init = n; }
        const bad = []; let total = 0; let viaAlter = 0;
        const METHODS = new Set(['run', 'get', 'all', 'exec', 'each']);
        const walk = (node) => {
            if (!node || typeof node.type !== 'string') return;
            if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.object.type === 'Identifier' && node.callee.object.name === 'db' && !node.callee.computed && METHODS.has(node.callee.property.name)) {
                const last = node.arguments[node.arguments.length - 1];
                const inExcluded = node.start >= toks.from && node.start < toks.to;
                if (!inExcluded && last && (last.type === 'ArrowFunctionExpression' || last.type === 'FunctionExpression' || (last.type === 'Identifier' && last.name === 'coreAlterDone'))) {
                    total += 1;
                    if (last.type === 'Identifier') viaAlter += 1;
                    else if (last.type === 'ArrowFunctionExpression' || last.type === 'FunctionExpression') {
                        const p = last.params[0];
                        const body = serverSrc.slice(last.body.start + 1, last.body.end - 1).replace(/^(\s*\/\/[^\n]*\n)+/, '').trimStart();   // 体首的注释行不算
                        const okParam = p && p.type === 'Identifier' && (body.startsWith(`if (${p.name}) recordCoreInitFailure(${p.name});`) || body.startsWith(`coreAlterDone(${p.name});`));
                        if (!okParam) bad.push(`${node.loc.start.line}: ${serverSrc.slice(node.start, Math.min(node.end, node.start + 70)).replace(/\s+/g, ' ')}`);
                    }
                }
            }
            for (const k of Object.keys(node)) {
                const v = node[k];
                if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') walk(c); } else if (v && typeof v.type === 'string') walk(v);
            }
        };
        walk(init.body);
        const safeAlter = serverSrc.slice(serverSrc.indexOf('function safeAlterAddColumn('), serverSrc.indexOf('// ====', serverSrc.indexOf('function safeAlterAddColumn(')));

        // ---- 扫描面扩展（修复批 2 第 7 项）：initTable 子树里**直接调用的本文件顶层函数**逐个归类，每个要么被本守卫检查、要么显式豁免并写理由；新增一个被调函数而没归类 → 判红
        const topFns = new Set(ast.body.filter((n) => n.type === 'FunctionDeclaration').map((n) => n.id.name));
        const calledTop = new Set();
        const walkCalls = (node) => {
            if (!node || typeof node.type !== 'string') return;
            if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && topFns.has(node.callee.name)) calledTop.add(node.callee.name);
            for (const k of Object.keys(node)) {
                const v = node[k];
                if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') walkCalls(c); } else if (v && typeof v.type === 'string') walkCalls(v);
            }
        };
        walkCalls(init.body);
        const CALLED_CLASSIFIED = {
            recordCoreInitFailure: '汇入函数本身', coreAlterDone: '汇入函数本身（过滤 duplicate column 后调 recordCoreInitFailure）',
            safeAlterAddColumn: '本守卫单独检查其失败分支（safeAlterOk）',
            verifyV2CollabSchema: '本守卫逐个回调核对汇入次数（V2_SITES）',
            runCollabQualityDualCheckMigration: '豁免：自己有就绪标志 COLLAB_QUALITY_DUALCHECK_SCHEMA_STATE（collab_dualcheck 模块），其就绪校验同时覆盖 collab_quality_record 的存在性与 7 列，不跨模块重复汇入 core',
        };
        const calledNow = Array.from(calledTop).sort();
        const calledExpect = Object.keys(CALLED_CLASSIFIED).sort();
        // verifyV2CollabSchema：每个带回调的 db.all / db.get / db.run，回调体（去掉注释）里汇入调用（recordCoreInitFailure( / recordCoreSchemaIncomplete(）的次数必须**恰好等于**登记值（全等，不是「存在」）；
        //   0 = 显式豁免并写理由。整张表按第一个参数（SQL 文本）里的片段对号入座，没对上号的调用 = 新增了未归类的巡检 → 判红
        const V2_SITES = [
            { frag: 'PRAGMA table_info(collab_requests)', n: 2, why: '查询错误 + 缺列' },
            { frag: 'assign_mode NOT IN', n: 1, why: '只汇入查询错误；非法值是数据巡检，不汇入（豁免）' },
            { frag: 'PRAGMA table_info(collab_attachments)', n: 2, why: '查询错误 + 缺列' },
            { frag: 'PRAGMA table_info(users)', n: 2, why: '查询错误 + 缺列' },
            { frag: "name='system_configs'", n: 2, why: '查询错误 + 缺表' },
            { frag: "name='collab_quality_record'", n: 2, why: '两表存在性：查询错误 + collab_return_record 缺表（collab_quality_record 缺失归 collab_dualcheck，豁免）' },
            { frag: 'PRAGMA table_info(collab_quality_record)', n: 0, why: '豁免：7 列清单与 runCollabQualityDualCheckMigration 的就绪校验同源，归 collab_dualcheck 模块' },
            { frag: 'FROM collab_return_record WHERE reason_type', n: 0, why: '豁免：reason_type 非法值是数据巡检' },
        ];
        let v2Fn = null;
        for (const n of ast.body) { if (n.type === 'FunctionDeclaration' && n.id.name === 'verifyV2CollabSchema') v2Fn = n; }
        const v2Seen = [];
        const v2Bad = [];
        const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        const walkV2 = (node) => {
            if (!node || typeof node.type !== 'string') return;
            if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.object.type === 'Identifier' && node.callee.object.name === 'db' && !node.callee.computed && ['all', 'get', 'run', 'exec', 'each'].includes(node.callee.property.name)) {
                const last = node.arguments[node.arguments.length - 1];
                if (last && (last.type === 'ArrowFunctionExpression' || last.type === 'FunctionExpression')) {
                    const sqlText = serverSrc.slice(node.arguments[0].start, node.arguments[0].end);
                    const hit = V2_SITES.filter((s) => sqlText.includes(s.frag));
                    const cbText = stripComments(serverSrc.slice(last.start, last.end));
                    const count = (cbText.match(/\brecord(?:CoreInitFailure|CoreSchemaIncomplete)\(/g) || []).length;
                    if (hit.length !== 1) v2Bad.push(`${node.loc.start.line}: 没有（或多于一个）登记项对上号：${sqlText.slice(0, 60).replace(/\s+/g, ' ')}`);
                    else { v2Seen.push(hit[0].frag); if (count !== hit[0].n) v2Bad.push(`${node.loc.start.line}: ${hit[0].frag} 汇入次数 ${count}，登记 ${hit[0].n}（${hit[0].why}）`); }
                }
            }
            for (const k of Object.keys(node)) {
                const v = node[k];
                if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') walkV2(c); } else if (v && typeof v.type === 'string') walkV2(v);
            }
        };
        if (v2Fn) walkV2(v2Fn.body);
        const v2Missing = V2_SITES.filter((s) => !v2Seen.includes(s.frag)).map((s) => s.frag);
        return { bad, total, viaAlter, rangeOk: toks.from > 0 && toks.to > toks.from, safeAlterOk: /logger\.error\(`ALTER TABLE[^\n]*\n\s*recordCoreInitFailure\(err\);/.test(safeAlter), calledNow, calledExpect, calledOk: JSON.stringify(calledNow) === JSON.stringify(calledExpect), v2Found: !!v2Fn, v2Bad, v2Missing, v2Seen: v2Seen.length };
    })();
    check('U4.6', `initTable 的失败汇入完整（静态）：${wired.total} 个带回调的 sqlite 调用（排除三个有自己就绪标志的段）回调全部汇入 core（其中 ${wired.viaAlter} 个是 ALTER 的空回调改成 coreAlterDone），没有漏网的；safeAlterAddColumn 的失败分支也汇入；`
        + `扫描面扩到 initTable 直接调用的本文件函数（${wired.calledExpect.join(' / ')}，各自归类或显式豁免）：verifyV2CollabSchema 的 ${wired.v2Seen} 个回调调用，汇入次数与登记表全等（缺列 / 缺表 / 查询错误各一处），没有未归类的调用`,
        wired.rangeOk && wired.total >= 80 && wired.bad.length === 0 && wired.safeAlterOk && wired.calledOk && wired.v2Found && wired.v2Bad.length === 0 && wired.v2Missing.length === 0 && wired.v2Seen === 8, wired.bad.length ? wired.bad : wired);
}

// ================================================================ 入口
(async () => {
    let fatal = null;
    try {
        if (BOOT_ERROR) throw BOOT_ERROR;
        await setup();
        if (want('G')) await sectionG();
        if (want('U')) await sectionU();
        if (want('A')) await sectionA();
        if (want('B')) await sectionB();
        if (want('X')) await sectionX();
        if (want('E')) await sectionE();
        if (want('F')) await sectionF();
        if (want('W')) await sectionW();
        if (want('K')) await sectionK();
    } catch (e) {
        fatal = e;
        check('FATAL', `套件未预期异常：${e && e.stack}`, false, e && e.logTail ? `服务日志尾：\n${e.logTail}` : undefined);
    } finally {
        try { await stopAll(); } catch (_) { /* 逐个 stop 已各自兜底 */ }
        let reap = { total: 0, forced: [], failed: [], forcedByOwner: { launcher: [], suite: [] } };
        if (procLib) { try { reap = await reapAll(); } catch (e) { reap.failed.push(`reapAll 异常：${e && e.message}`); } }
        if (!BOOT_ERROR) {
            const leftovers = tmpInstanceDirs();
            check('Z.1', '收尾：私有临时根里没有残留 sdh-test-* 数据根（所有实例都已停止或按设计被 sweep 删除）', leftovers.length === 0, leftovers);
            check('Z.2', '收尾：所有启动过的服务进程都已退出', startedHandles.every((h) => !alive(h.pid) || (() => { try { return procLib.checkIdentity({ pid: h.pid, start_time: h.startTime }).state !== 'match'; } catch (_) { return false; } })()));
            check('Z.3', '收尾：守卫从未触发（没有越界开库 / 监听别的端口）', !fs.existsSync(GUARD_MARKER), fs.existsSync(GUARD_MARKER) ? fs.readFileSync(GUARD_MARKER, 'utf8') : '');
            check('Z.6', '收尾：套件里每一次启动都用的是私有根内的合成 server.js（合成检出 / 桩），没有一次从运行套件的检出里启动——被测服务读不到那个检出的真实 .env', START_VIOLATIONS.length === 0, START_VIOLATIONS);
            check('Z.5', `收尾：登记的进程（${reap.total} 个）全部确认消失；最外层回收时仍需强制终止的 ${reap.forced.length} 个——套件归属（holder / kids / helper，只记 forced）${reap.forcedByOwner.suite.length} 个（${reap.forcedByOwner.suite.join('、') || '无'}）；启动器归属（桩进程 / K 桩服务，本应由启动器终止，仍在运行 = 启动器漏杀，记入 failed）${reap.forcedByOwner.launcher.length} 个（${reap.forcedByOwner.launcher.join('、') || '无'}）`, reap.failed.length === 0, reap.failed);
        } else if (reap.failed.length) {
            check('Z.5', '收尾：登记的辅助进程全部确认消失', false, reap.failed);
        }
        // 清理合成检出与私有根（逐项删除 + lstat 确认；不用 fs.rmSync）
        let left = null;
        try {
            if (common) {
                try { removeCheckout(); } catch (_) { /* 下面整体删除 */ }
                common.deleteTreeNoFollow(fs.realpathSync.native(PRIV), []);
                fs.rmdirSync(PRIV);
            } else rmTreeMin(PRIV);
        } catch (e) {
            left = e && e.message;
            try { rmTreeMin(PRIV); } catch (_) { /* 下面按是否还在报告 */ }
        }
        left = fs.existsSync(PRIV) ? (left || '仍存在') : null;
        check('Z.4', '收尾：私有临时根已删除（含引导失败的情形）', left === null, left);
        console.log(`\nNOTE 真服务启动（经启动器，A/B/E/X 与预热）：首次通过 ${REAL_STARTS.first}、重试后通过 ${REAL_STARTS.retried}（累计重试 ${REAL_STARTS.retries} 次${REAL_STARTS.detail.length ? `：${JSON.stringify(REAL_STARTS.detail)}` : ''}）、失败 ${REAL_STARTS.failed}（既有问题 #122：启动期 SQLITE_BUSY 竞态，只在有 BUSY 证据时由启动器重试）`);
        console.log(`verify-test-instance PASS=${pass} FAIL=${fail}`);
        if (SUMMARY_FILE) { try { fs.writeFileSync(SUMMARY_FILE, JSON.stringify({ pass, fail, fatal: fatal ? String(fatal.message) : null, bootError: BOOT_ERROR ? String(BOOT_ERROR.message) : null, realStarts: REAL_STARTS, reap, checks: results })); } catch (_) { /* 汇总写不出由驱动判失败 */ } }
        process.exit(fail ? 1 : 0);
    }
})();
