/**
 * 进程身份助手（#106 多线并行改造 · S2c · 方案 W2「进程登记与停止」；修复批 2）
 *
 * **只支持 Windows**（修复批 2，11-R H1 / M6）：身份查询（getProcInfo）、终止（killTree / killIfIdentity）、端口监听者查询（portListeners）在非 Windows 一律抛
 *   LINE_PROC_UNSUPPORTED_PLATFORM（固定文案「本工具只支持 Windows」）。非 Windows 的终止只能「查询后按数值 PID 发信号」，没有句柄保护，PID 复用会误杀无关进程，且从未运行过，所以不提供。
 *
 * 登记的进程由「PID + 进程创建时间 + 命令行 + 实例身份」标识。本文件只提供不改登记表的底层能力：
 *   getProcInfo(pid)        一次 CIM 查询取 { start_time, exe, cmdline }（创建时间 ISO 字符串 UTC 7 位小数；ExecutablePath；CommandLine）；
 *                           进程不存在返回 null；查询本身失败（PowerShell 起不来 / CIM 报错 / 超时 / 输出非法）抛 LINE_PROC_QUERY_FAILED —— 查询失败绝不等于进程不存在
 *   getStartTime(pid)       getProcInfo(pid).start_time 的简写
 *   isAlive(pid)            进程是否存在（process.kill(pid, 0)；EPERM 也算存在）
 *   checkIdentity(proc)     登记的 { pid, start_time } 与现场对照：{ state: 'match' | 'dead' | 'reused', actual, info }；
 *                           isAlive 为真而 CIM 查不到时再查一次，仍查不到就抛 LINE_PROC_QUERY_FAILED，绝不判 dead
 *   cmdMatches(cmd, info)   登记的命令行（「node 路径 + 空格 + server.js 绝对路径」）与现场 ExecutablePath / CommandLine 比对（去引号、斜杠归一、Windows 不分大小写，整串全等）
 *   killTree(pid)           按 PID 终止进程树（taskkill /PID <pid> /T /F）。只给「调用方持有 ChildProcess 句柄的自己刚起的子进程」用
 *   killIfIdentity(proc)    同句柄核对并终止：一次 PowerShell 里 Get-Process 取对象 → 先访问 .Handle 钉住 PID → 核对创建时间（与登记同口径：CIM CreationDate）→ 同一 PowerShell 里 taskkill /T /F；
 *                           CIM 静默返回空时：进程已退出才判不存在，仍存活则按查询失败（与 checkIdentity 同口径）
 *   buildKillScript(pid, want)  killIfIdentity 的 PowerShell 脚本行（导出给静态守卫：.Handle 必须出现在 taskkill 之前）
 *   buildManualKillCommand(pid, start)  人工恢复指引用的现成命令（同一份脚本 + 精确创建时间，整行可执行）
 *   waitGone(pid, ms)       等进程消失（有界）
 *   httpGetJson(port, path, totalMs)  回环 HTTP GET，整请求绝对截止；结果：ok / badbody（有完整 HTTP 响应但不是 JSON 对象）/ broken（收到响应头之后失败：正文中断 / 超时 / 超限）/ unreachable（没收到响应头：连接失败 / 超时）
 *   portAvailable(port)     能否在该端口监听（绑定探测 + 回环连接探测）
 *   portListeners(port)     监听该端口的 PID 数组；查不到返回 null（调用方须 fail-closed）；portOwners(port) 同义但查不到返回 []（只用于提示，绝不据此终止）
 *
 * 纪律：绝不按端口或进程名终止进程；终止只走 killIfIdentity（或调用方持有 ChildProcess 句柄的自己刚起的子进程）。
 * 所有外部命令用 spawnSync（不经 shell 字符串拼接），设超时。
 *
 * killIfIdentity 的残余窗口：taskkill /T 枚举子孙进程到逐个终止之间新派生的子进程会漏掉。根进程已被句柄钉住，PID 不会被复用，所以根进程不会误杀；子孙进程存在可忽略的理论窗口
 *   （实测：PowerShell 退出后 839 次进程创建内 PID 即被复用，所以句柄只钉得住根进程，钉不住 taskkill 枚举到的子孙）。
 * 实测依据（修复批 1 预筛）：taskkill /T 不会沿陈旧的父 PID 波及更早创建的无关进程（probe_c2_taskkill_tree.js）。
 */
'use strict';

const http = require('http');
const net = require('net');
const { spawnSync } = require('child_process');
const { LineError } = require('./line-common');

const QUERY_TIMEOUT_MS = 30000;
const HTTP_BODY_LIMIT = 1024 * 1024;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/;

/**
 * 仅测试用：psPrelude 会被拼进每个 PowerShell 脚本的开头（例如用同名函数遮蔽 Get-CimInstance 来制造查询失败）；platform 覆盖 process.platform（验证非 Windows 一律拒绝）。生产代码不设。
 */
const _test = { psPrelude: '', platform: null };

const platformName = () => (_test.platform !== null ? _test.platform : process.platform);
/** 非 Windows 一律抛 LINE_PROC_UNSUPPORTED_PLATFORM（固定文案）。身份查询 / 终止 / 端口监听者查询的第一行都先调它。 */
function assertSupportedPlatform() {
    if (platformName() !== 'win32') throw new LineError('LINE_PROC_UNSUPPORTED_PLATFORM', '本工具只支持 Windows');
}

function assertPid(pid) {
    if (!(Number.isSafeInteger(pid) && pid > 0)) throw new LineError('LINE_BAD_ARGS', `非法 PID：${String(pid)}`);
}

function runPs(lines) {
    const script = ['$ProgressPreference = \'SilentlyContinue\'', _test.psPrelude || '', ...lines].join('\n');
    const enc = Buffer.from(script, 'utf16le').toString('base64');
    return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { encoding: 'utf8', windowsHide: true, timeout: QUERY_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
}
const cleanErr = (r) => JSON.stringify(String(r.stderr || '').replace(/#< CLIXML[\s\S]*$/, '').trim().slice(0, 200));
const queryFailed = (pid, why) => new LineError('LINE_PROC_QUERY_FAILED', `查询进程 ${pid} 失败：${why}`);

/**
 * 一次 CIM 查询取创建时间、可执行路径、命令行。进程不存在（查询成功且结果为空）返回 null；
 * 查询本身失败抛 LINE_PROC_QUERY_FAILED（CIM 查询带 -ErrorAction Stop：没有它，查询失败只是非终止错误，$p 为空，会被误当成「进程不存在」）。
 */
function getProcInfo(pid) {
    assertSupportedPlatform();
    assertPid(pid);
    const r = runPs([
        `try { $p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction Stop } catch { [Console]::Error.Write($_.Exception.Message); exit 4 }`,
        'if ($null -eq $p) { exit 3 }',
        '$t = $p.CreationDate.ToUniversalTime().ToString("o")',
        '$e = [string]$p.ExecutablePath',
        '$c = [string]$p.CommandLine',
        '$b = { param($s) [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s)) }',
        '[Console]::Out.Write($t + "|" + (& $b $e) + "|" + (& $b $c))',
    ]);
    if (r.error) throw queryFailed(pid, `PowerShell 起不来或超时：${r.error.message}`);
    if (r.status === 3) return null;
    const text = String(r.stdout || '').trim();
    const m = /^([^|]+)\|([A-Za-z0-9+/=]*)\|([A-Za-z0-9+/=]*)$/.exec(text);
    if (r.status !== 0 || !m || !ISO_RE.test(m[1])) {
        throw queryFailed(pid, `退出码 ${r.status}，输出 ${JSON.stringify(text.slice(0, 200))}，stderr ${cleanErr(r)}`);
    }
    return { start_time: m[1], exe: Buffer.from(m[2], 'base64').toString('utf8'), cmdline: Buffer.from(m[3], 'base64').toString('utf8') };
}

function getStartTime(pid) {
    const info = getProcInfo(pid);
    return info === null ? null : info.start_time;
}

function isAlive(pid) {
    assertPid(pid);
    try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

/**
 * 登记的 proc = { pid, start_time }：现场没有这个 PID → dead；有但创建时间不同（PID 被复用）→ reused；一致 → match（actual / info 带现场值）。
 * 查询失败向上抛；isAlive 为真而 CIM 查不到不是 dead（可能是 CIM 出毛病）：再查一次，仍查不到就抛查询失败。
 */
function checkIdentity(proc) {
    if (!isAlive(proc.pid)) return { state: 'dead', actual: null, info: null };
    let info = getProcInfo(proc.pid);
    if (info === null) {
        if (!isAlive(proc.pid)) return { state: 'dead', actual: null, info: null };   // 两次探测之间刚好退出
        info = getProcInfo(proc.pid);
        if (info === null) {
            if (!isAlive(proc.pid)) return { state: 'dead', actual: null, info: null };
            throw queryFailed(proc.pid, '进程仍存活（process.kill(pid, 0) 成功），但 CIM 两次都查不到它：无法确认身份，不判进程已死');
        }
    }
    if (String(info.start_time) !== String(proc.start_time)) return { state: 'reused', actual: info.start_time, info };
    return { state: 'match', actual: info.start_time, info };
}

function normCmd(s) {
    return String(s).replace(/"/g, '').replace(/\//g, '\\').toLowerCase();   // 只支持 Windows：斜杠归一、不分大小写
}
/** 登记的 cmd 是「node 路径 + 空格 + server.js 绝对路径」。现场命令行（去引号、斜杠归一、Windows 不分大小写）必须与之整串全等，ExecutablePath 必须是 cmd 的前缀部分。 */
function cmdMatches(cmd, info) {
    if (typeof cmd !== 'string' || cmd === '' || !info || typeof info.cmdline !== 'string' || info.cmdline === '') return false;
    if (typeof info.exe === 'string' && info.exe !== '' && !normCmd(cmd).startsWith(`${normCmd(info.exe)} `)) return false;
    return normCmd(info.cmdline) === normCmd(cmd);
}

/** 终止进程树（只接受 PID：调用方持有自己刚起的子进程句柄，PID 被句柄钉住）。返回 taskkill / kill 是否报告成功。 */
function killTree(pid) {
    assertSupportedPlatform();
    assertPid(pid);
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: QUERY_TIMEOUT_MS, stdio: 'ignore' });
    return !r.error && r.status === 0;
}

/**
 * killIfIdentity 的 PowerShell 脚本行。.Handle 必须出现在 taskkill 之前（钉住 PID；回归守卫按位置先后断言，见套件 12 项）。
 * 退出码：0 已终止 / 3 进程不存在（只认 Get-Process 明确的「找不到该进程」，或 CIM 查不到且进程确已退出）/ 4 查询失败（含 Get-Process 其他错误、拿不到句柄、CIM 查不到但进程仍存活）/ 5 创建时间不一致 / 6 taskkill 失败。
 */
function buildKillScript(pid, want) {
    return [
        // Get-Process 取不到对象不等于进程不存在（与监督进程的 GET_PROCESS_LINE 同口径）：用终止型错误 + try/catch，只有明确的「找不到该进程」才 exit 3，其余一律 exit 4（查询失败：保留登记、不终止）
        `try { $p = Get-Process -Id ${pid} -ErrorAction Stop } catch { if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*') { exit 3 } else { [Console]::Error.Write($_.Exception.Message); exit 4 } }`,
        'if ($null -eq $p) { [Console]::Error.Write("Get-Process 没有返回进程对象"); exit 4 }',
        '$h = $p.Handle',
        'if ($null -eq $h -or $h -eq [IntPtr]::Zero) { [Console]::Error.Write("拿不到进程句柄"); exit 4 }',
        `try { $c = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction Stop } catch { [Console]::Error.Write($_.Exception.Message); exit 4 }`,
        // CIM 静默返回空（没有报错）：已持句柄，进程确已退出才算不存在；仍存活 = CIM 出毛病，按查询失败（与 checkIdentity 同口径，不得据此清登记）
        'if ($null -eq $c) { if ($p.HasExited) { exit 3 } else { [Console]::Error.Write("CIM 查不到该进程，但进程仍存活"); exit 4 } }',
        `if ($c.CreationDate.ToUniversalTime().ToString("o") -ne '${want}') { exit 5 }`,
        `& taskkill.exe /PID ${pid} /T /F | Out-Null`,
        'if ($LASTEXITCODE -ne 0) { exit 6 }',
        'exit 0',
    ];
}

/**
 * 人工恢复用的「现成可执行」命令（CLI 已退出、无法再持句柄时，登记没写成又没终止掉自己起的进程）：脚本就是 buildKillScript(pid, 精确创建时间)——
 * 一次 PowerShell 里 Get-Process 取对象 → 访问 .Handle 钉住 PID → 核对创建时间 → taskkill /T /F，创建时间不符（PID 已被复用）不终止。
 * 返回 { script（多行脚本文本，供核对）, command（powershell.exe -EncodedCommand …，整行复制即可在 cmd / PowerShell 里执行；退出码同 buildKillScript）}。
 * 不提供「只给 PID」的版本：没有精确创建时间就生成不了（调用方须另行处理）。
 */
function buildManualKillCommand(pid, startTime) {
    assertPid(pid);
    const want = String(startTime);
    if (!ISO_RE.test(want)) throw new LineError('LINE_BAD_ARGS', `非法创建时间：${want}`);
    const script = buildKillScript(pid, want).join('\n');
    const enc = Buffer.from(`$ProgressPreference = 'SilentlyContinue'\n${script}`, 'utf16le').toString('base64');
    return { script, command: `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${enc}` };
}

/**
 * 同句柄核对并终止进程树。返回 { killed, state, failed? }：state = 'match'（身份一致）/ 'dead' / 'reused'；killed 为 taskkill 是否成功。查询失败抛 LINE_PROC_QUERY_FAILED（不终止）。
 * 一次 PowerShell 里 Get-Process 取对象 → 访问 .Handle 钉住该 PID（句柄不关，PID 不会被复用）→ 用 CIM CreationDate（与登记同口径）核对 → 同一 PowerShell 里 taskkill /T /F。
 */
function killIfIdentity(proc) {
    assertSupportedPlatform();
    assertPid(proc.pid);
    const want = String(proc.start_time);
    if (!ISO_RE.test(want)) return { killed: false, state: 'reused' };   // 登记值不是本模块写出的格式：现场的创建时间必然与它不同
    const pid = proc.pid;
    const r = runPs(buildKillScript(pid, want));
    if (r.error) throw queryFailed(pid, `PowerShell 起不来或超时：${r.error.message}`);
    if (r.status === 0) return { killed: true, state: 'match' };
    if (r.status === 3) return { killed: false, state: 'dead' };
    if (r.status === 5) return { killed: false, state: 'reused' };
    if (r.status === 6) return { killed: false, state: 'match', failed: true };
    throw queryFailed(pid, `核对并终止时失败：退出码 ${r.status}，stderr ${cleanErr(r)}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等 PID 消失（有界）。返回是否已消失。 */
async function waitGone(pid, timeoutMs, intervalMs) {
    const deadline = Date.now() + timeoutMs;
    const step = intervalMs || 100;
    for (;;) {
        if (!isAlive(pid)) return true;
        if (Date.now() >= deadline) return false;
        await sleep(step);
    }
}

/**
 * 回环 HTTP GET，整请求绝对截止 totalMs（默认 3000，覆盖连接、响应头、正文全过程；到点销毁请求）。体积超过 1MB 立即拒绝并关闭。
 * 结果：{ kind:'ok', status, json } / { kind:'badbody', status, body } / { kind:'broken', status, error }（收到响应头之后失败）/ { kind:'unreachable', error }（没收到响应头）。
 */
function httpGetJson(port, urlPath, totalMs) {
    const limit = Number.isFinite(totalMs) && totalMs > 0 ? totalMs : 3000;
    return new Promise((resolve) => {
        let done = false;
        let status = null;
        let req = null;
        let resp = null;
        const finish = (v) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(v);
            try { if (resp) resp.destroy(); } catch (_) { /* 已关闭 */ }
            try { if (req) req.destroy(); } catch (_) { /* 已关闭 */ }
        };
        const fail = (msg) => finish(status === null ? { kind: 'unreachable', error: msg } : { kind: 'broken', status, error: msg });
        const timer = setTimeout(() => fail(`整请求超过 ${limit}ms 仍未完成`), limit);
        req = http.get({ host: '127.0.0.1', port, path: urlPath, agent: false, headers: { Connection: 'close' } }, (res) => {
            resp = res;
            status = res.statusCode;
            const chunks = [];
            let size = 0;
            res.on('data', (d) => {
                size += d.length;
                if (size > HTTP_BODY_LIMIT) { fail(`响应体超过 ${HTTP_BODY_LIMIT} 字节上限`); return; }
                chunks.push(d);
            });
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = JSON.parse(body); } catch (_) { json = null; }
                if (json !== null && typeof json === 'object' && !Array.isArray(json)) finish({ kind: 'ok', status, json });
                else finish({ kind: 'badbody', status, body: body.slice(0, 200) });
            });
            res.on('error', (e) => fail(`响应读取出错：${e.message}`));
            res.on('close', () => { if (!res.complete) fail('响应在正文传输中断开'); });
        });
        req.on('error', (e) => fail(e.message));
    });
}

/** 端口能否监听：先绑定探测（0.0.0.0 独占），再回环连接探测。任一方发现占用 / 不可用即 false，并给出原因。 */
async function portAvailable(port) {
    const bound = await new Promise((resolve) => {
        const srv = net.createServer();
        srv.once('error', (e) => resolve({ ok: false, reason: `绑定失败（${e && e.code}）` }));
        srv.listen({ port, host: '0.0.0.0', exclusive: true }, () => { srv.close(() => resolve({ ok: true })); });
    });
    if (!bound.ok) return bound;
    const connected = await new Promise((resolve) => {
        const s = net.connect({ port, host: '127.0.0.1' });
        s.setTimeout(2000);
        s.once('connect', () => { s.destroy(); resolve(true); });
        s.once('error', () => resolve(false));
        s.once('timeout', () => { s.destroy(); resolve(false); });
    });
    if (connected) return { ok: false, reason: '回环连接成功（有进程在监听）' };
    return { ok: true };
}

/** 监听该端口的 PID 数组（去重、升序）；查不到（命令失败）返回 null，调用方须 fail-closed。netstat -ano；非 Windows 抛 LINE_PROC_UNSUPPORTED_PLATFORM。 */
function portListeners(port) {
    assertSupportedPlatform();
    // 不带 -p：IPv4 与 IPv6 的监听都列出（Node 默认监听 ::，Windows 上双栈会同时出现 0.0.0.0 与 [::] 两行，同一个 PID）；UDP 行靠首列 TCP 过滤掉
    const r = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true, timeout: QUERY_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
    if (r.error || r.status !== 0) return null;
    const pids = new Set();
    for (const line of String(r.stdout).split(/\r?\n/)) {
        const m = line.trim().split(/\s+/);
        if (m.length >= 5 && m[0].toUpperCase() === 'TCP' && /^LISTENING$/i.test(m[3]) && m[1].endsWith(`:${port}`)) pids.add(Number(m[4]));
    }
    return Array.from(pids).filter((n) => Number.isSafeInteger(n) && n > 0).sort((a, b) => a - b);
}
/** 尽力列出在该端口监听的 PID，只用于提示，绝不据此终止。任何失败（含非 Windows）返回 []。 */
function portOwners(port) {
    try { return portListeners(port) || []; } catch (_) { return []; }
}

module.exports = {
    getProcInfo, getStartTime, isAlive, checkIdentity, cmdMatches, killTree, killIfIdentity, buildKillScript, buildManualKillCommand, waitGone, httpGetJson, portAvailable, portListeners, portOwners, sleep,
    assertSupportedPlatform, _test,
};
