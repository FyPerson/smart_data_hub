/**
 * #106 S2b / S2c 共享的测试监督进程（修复批 2 · U3 裁定：两份监督进程合成一份）
 *
 * 入口是两个薄文件：verify-lines-new-remove.js（S2b）与 verify-lines-run.js（S2c），各自只传 { 套件路径、是否启用登记回收、要跑的自检 }。
 * 本文件名不以 verify- 开头：run-verify-family.js 按 verify- 前缀收集成员，共享模块不能被当成成员跑。
 *
 * 为什么要有监督进程：套件本体与被测代码在同一个事件循环里，被测代码里任何一个同步调用（execFileSync、spawnSync、Atomics.wait、死循环）一旦阻塞，进程内的看门狗定时器根本不会触发——
 * 错误实现会让套件挂起，而不是判红。这里由另一个进程运行套件：
 *   1. 先跑自检夹具，自检不过整套判失败（超时 / 回收机制本身不可信）：
 *        A 正常：起一个会同步阻塞、还带一个孙进程的子进程，超时后监督进程杀掉整棵进程树，核对非零退出、子进程与孙进程都已回收、耗时在预期内；
 *        B 终止命令失败：把终止命令换成一个必然失败的命令，监督进程必须检查 taskkill 的结果、改用后备终止（杀直接子进程），并在独立的终止截止时间内返回；回收情况如实报告；
 *        C 终止全部失败：外层运行一个**独立的监督进程**（入口文件 + 受控旋钮），终止命令与后备都被禁用，夹具子进程不会死——独立监督进程必须在终止截止到达后输出
 *          SUPERVISOR_RECLAIM_FAILED 并以退出码 3 真正退出；
 *        D 终止命令持续阻塞：同样用独立监督进程，终止命令 60 秒不返回——单次终止命令按剩余截止限时，实际退出耗时不超过 超时 + 截止 + 余量；
 *        P 平台：非 Windows（受控旋钮 --test-platform）直接非零退出并说明「本工具只支持 Windows」，不运行套件；
 *        （启用登记回收的入口再跑）
 *        R 登记回收的身份纪律（进程内单元）：PID 相同、创建时间差 2 秒的记录不得终止该进程（只认 PID + 精确创建时间）；精确匹配的记录被终止；PowerShell 查询失败 ≠ 进程不存在
 *          （注入 Get-Process 报错 → 记录保留、报告失败，进程不被终止）；明确「找不到该进程」才判不存在；
 *        E 登记通道失效即判红（独立监督进程 + 替身套件）：登记路径预置为目录 → 套件启动前就非零退出；套件写入一行损坏记录 → 非零退出并保留登记文件；套件删掉登记文件 → 非零退出；
 *          正常的替身套件 → 0（对照）；
 *        D2 「中间启动器退出、detached 服务存活、套件同步挂起」夹具：杀进程树够不到那个服务（负向对照），按登记文件回收才行。
 *        （收口小批新增）
 *        F 夹具清理只认精确身份：夹具（runHangFixture）在 pid 文件里记下自己与孙进程的 CIM 精确创建时间；清理时直接子进程优先用 ChildProcess 句柄，其余一律经 reapEntry
 *          （同句柄核精确创建时间后终止）；取不到原身份 → 报告清理失败，禁止退回裸 PID 树杀。「PID 对得上但创建时间错」的存活诱饵不得被终止（对照：精确身份 / 句柄才终止）；
 *        G 登记回收纳入总截止（--reap-deadline-ms，默认 30 秒）：套件挂起 + 树终止失败 + 登记查询持续阻塞（--test-ps-prelude 注入 Start-Sleep）三者叠加，独立监督进程的实际 OS 退出时间
 *          不得超过 超时 + 终止截止 + 回收截止 + 余量，退出码非零，输出未处理的身份，保留登记文件；
 *        H 自检失败路径显式退出：自检里 A 的终止命令失败（--test-selftest-kill-bin）且夹具清理的终止动作也失败（--test-cleanup-fails）→ 独立监督进程必须输出
 *          SUPERVISOR_LEFTOVER（未回收进程的身份）并实际退出（OS 进程 exit 事件）、退出码非零；残留进程由本场景按输出里的身份善后。
 *      所有失败出口（自检失败、登记通道失效、回收失败、超时、非 Windows、套件非零退出）共用同一个显式非零退出函数 fatalExit。
 *   2. 再用同样的机制运行套件，默认 20 分钟超时；超时则杀进程树并非零退出，输出 SUPERVISOR_TIMEOUT。终止阶段有独立的截止（默认 20 秒）：截止前每秒重试一次终止命令，
 *      第二次起同时用后备终止；截止后仍未回收则输出 SUPERVISOR_RECLAIM_FAILED，退出码 3。
 *   3. 启用登记回收的入口：监督进程启动套件前创建并验证登记文件（环境变量 S2C_TEST_REGISTRY）；套件登记的进程与替身服务自己（启动时用 CIM 取**自己的精确创建时间**再登记，取不到就在派生任何
 *      长寿子进程前退出）都往里追加。套件结束（无论正常、超时还是异常）后按这份登记回收：只按「PID + 精确创建时间」匹配（没有近似匹配），同一个 PowerShell 里
 *      Get-Process 取对象 → 访问 .Handle 钉住 PID → CIM 核精确创建时间 → taskkill /T /F，检查退出码；每个条目最多试 3 次，终止失败的在输出里列出（SUPERVISOR_REAP）并判失败。
 *      登记文件读取失败 / 损坏记录 / 缺表头视为监督失败：非零退出，输出 SUPERVISOR_REGISTRY_FAILED 并保留登记文件路径。套件正常退出（退出码 0）后仍有存活的登记进程也判失败（套件自己的收尾漏了）。
 * 只支持 Windows：进程树回收用 taskkill /PID <pid> /T /F（检查退出码）；后备：child.kill('SIGKILL')（只杀直接子进程）。非 Windows 一律拒绝（见 P）。
 *
 * 命令行（两个入口一致）：[--lines-dir=<被测 scripts/lines 目录的绝对路径>] [--only=1,5] [--timeout-ms=<毫秒>] [--skip-selftest]，其余参数原样传给套件。
 *   可调：--reap-deadline-ms=<毫秒>（登记回收阶段总截止，默认 30000）
 *   受控旋钮（仅供本文件自检用「独立监督进程」夹具；正常运行不传）：--kill-deadline-ms= / --test-kill-bin= / --test-kill-args= / --test-no-fallback / --test-platform= / --test-suite= / --test-registry-path=
 *     / --test-ps-prelude= / --test-selftest-kill-bin= / --test-selftest-kill-deadline-ms= / --test-cleanup-fails
 * 退出码：0 = 自检与套件都通过；1 = 其他（含自检失败、登记通道失效、非 Windows）；2 = 超时（已杀进程树）；3 = 终止阶段回收失败（超时后仍有进程没被收掉）或登记回收总截止耗尽。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REGISTRY_ENV = 'S2C_TEST_REGISTRY';
const REGISTRY_HEADER = '{"registry":"lines-test","v":1}';
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/;

/** 仅测试用（套件 / 自检的单元测试）：psPrelude 拼进回收脚本开头（例如用同名函数遮蔽 Get-Process 制造查询失败）。 */
const _test = { psPrelude: '' };

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 终止（进程树）

/**
 * 一次终止尝试：返回 { ok, detail }。killBin / killArgs 仅供受控夹具把终止命令换成必然失败（或持续阻塞）的命令。
 * 单次命令的限时 = min(15 秒, 剩余截止时间 timeoutMs)：同步终止命令不得把调用越过终止截止。
 */
function killTreeOnce(pid, killBin, timeoutMs, killArgs) {
    const limit = Math.max(1, Math.min(15000, timeoutMs === undefined ? 15000 : timeoutMs));
    const r = spawnSync(killBin || 'taskkill', killArgs || ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: limit, stdio: 'ignore' });
    const ok = !r.error && r.status === 0;
    return { ok, detail: r.error ? `error=${r.error.code || r.error.message}` : `status=${r.status}` };
}

/**
 * 运行子进程并监督：返回 { code, signal, timedOut, ms, pid, child（ChildProcess 句柄，自检夹具清理时优先用它终止直接子进程）, reclaimFailed, killLog }。stdio 透传（inherit）或静默。
 * 超时后进入终止阶段：截止（o.killDeadlineMs，默认 20 秒）之前每秒重试一次终止命令；第二次起同时用后备终止（child.kill，除非 o.noFallback）；
 * 子进程 exit 即回收成功（再核对 o.extraAlive() 里的额外 pid 是否也已回收）；截止后仍没 exit → 放弃等待，reclaimFailed = true。
 * o = { killBin, killArgs, noFallback, killDeadlineMs, extraAlive, env }。
 * 单次终止命令的限时 = 剩余截止时间（见 killTreeOnce）；截止到达后输出诊断并由主入口显式 process.exit(3)（不依赖事件循环自然排空：仍存活的子进程会让 Node 一直等）。
 */
function supervise(childArgs, timeoutMs, quiet, o) {
    const opt = o || {};
    return new Promise((resolve) => {
        const t0 = Date.now();
        const child = spawn(process.execPath, childArgs, { stdio: quiet ? 'ignore' : 'inherit', windowsHide: true, env: Object.assign({}, process.env, opt.env || {}) });
        let timedOut = false;
        let settled = false;
        const killLog = [];
        const finish = (extra) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(Object.assign({ code: null, signal: null, timedOut, ms: Date.now() - t0, pid: child.pid, child, reclaimFailed: false, killLog }, extra));
        };
        const startReclaim = () => {
            const deadline = Date.now() + (opt.killDeadlineMs || DEFAULT_KILL_DEADLINE_MS);
            let attempt = 0;
            const tick = () => {
                if (settled) return;
                const remaining = deadline - Date.now();
                if (remaining <= 0) { finish({ reclaimFailed: true, code: null, signal: 'KILL_DEADLINE' }); return; }
                attempt += 1;
                const r = killTreeOnce(child.pid, opt.killBin, remaining, opt.killArgs);   // 单次终止命令按剩余截止限时，截止后不再启动新尝试
                killLog.push(`#${attempt} ${r.ok ? 'ok' : 'FAIL'} ${r.detail}`);
                if (!r.ok && attempt >= 2 && !opt.noFallback) {
                    try { child.kill('SIGKILL'); killLog.push(`#${attempt} fallback child.kill`); } catch (e) { killLog.push(`#${attempt} fallback FAIL ${e && e.message}`); }
                }
                // 下一次检查最迟排在截止点（至少让出 50ms 给事件循环处理子进程的 exit 事件）
                setTimeout(tick, Math.max(50, Math.min(1000, deadline - Date.now())));
            };
            tick();
        };
        const timer = setTimeout(() => { timedOut = true; startReclaim(); }, timeoutMs);
        child.on('exit', (code, signal) => {
            const extra = opt.extraAlive ? opt.extraAlive().filter(alive) : [];
            finish({ code, signal, reclaimFailed: extra.length > 0 || alive(child.pid), killLog });
        });
        child.on('error', (e) => finish({ code: -1, error: String(e) }));
    });
}
const DEFAULT_KILL_DEADLINE_MS = 20000;

// ---------------------------------------------------------------- 登记回收（监督侧独立实现，不依赖被测代码与套件）

/** 单次 PowerShell 调用的限时 = min(60 秒, 调用方给的剩余预算 timeoutMs)：同步外部命令不得把调用方的总截止顶过去。 */
function psRun(lines, timeoutMs) {
    const script = [_test.psPrelude || '', ...lines].join('\n');
    const enc = Buffer.from(script, 'utf16le').toString('base64');
    const limit = Math.max(1, Math.min(60000, timeoutMs === undefined ? 60000 : timeoutMs));
    return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { encoding: 'utf8', windowsHide: true, timeout: limit, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** 取不到进程对象时的统一处理（脚本片段）：只有 NoProcessFoundForGivenId（明确「找不到该进程」）才退出码 3，其余一律 4（查询失败）。 */
const GET_PROCESS_LINE = pid => `try { $p = Get-Process -Id ${pid} -ErrorAction Stop } catch { if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*') { exit 3 } else { [Console]::Error.Write($_.Exception.Message); exit 4 } }`;

/**
 * 回收一个登记项的 PowerShell 脚本行：同一个 PowerShell 里 Get-Process 取对象 → 访问 .Handle 钉住 PID → CIM 核**精确**创建时间 → taskkill /T /F。
 * 退出码：0 已终止 / 3 进程不存在 / 4 查询失败 / 5 创建时间不符（PID 已被复用，不碰）/ 6 taskkill 失败。导出给静态守卫（.Handle 必须出现在 taskkill 之前）。
 */
function buildReapScript(e) {
    return [
        GET_PROCESS_LINE(e.pid),
        'try { $h = $p.Handle } catch { [Console]::Error.Write($_.Exception.Message); exit 4 }',
        'if ($null -eq $h -or $h -eq [IntPtr]::Zero) { [Console]::Error.Write("拿不到进程句柄"); exit 4 }',
        `try { $c = Get-CimInstance Win32_Process -Filter "ProcessId=${e.pid}" -ErrorAction Stop } catch { [Console]::Error.Write($_.Exception.Message); exit 4 }`,
        'if ($null -eq $c) { if ($p.HasExited) { exit 3 } else { [Console]::Error.Write("CIM 查不到该进程，但进程仍存活"); exit 4 } }',
        `if ($c.CreationDate.ToUniversalTime().ToString("o") -ne '${e.start}') { exit 5 }`,
        `& taskkill.exe /PID ${e.pid} /T /F | Out-Null`,
        'if ($LASTEXITCODE -ne 0) { exit 6 }',
        'exit 0',
    ];
}

/** 对一个登记项做一次回收尝试。返回 { outcome: 'killed' | 'gone' | 'reused' | 'kill-failed' | 'query-failed', code, stderr }。 */
function reapEntry(e, timeoutMs) {
    const r = psRun(buildReapScript(e), timeoutMs);
    if (r.error) return { outcome: 'query-failed', code: -1, stderr: String(r.error.message) };
    const stderr = String(r.stderr || '').replace(/#< CLIXML[\s\S]*$/, '').trim().slice(0, 200);
    const map = { 0: 'killed', 3: 'gone', 5: 'reused', 6: 'kill-failed' };
    return { outcome: map[r.status] || 'query-failed', code: r.status, stderr };
}

/** 取进程的精确创建时间（CIM，与被测代码同口径）。返回 { kind: 'ok', start } / { kind: 'gone' } / { kind: 'failed', why }。 */
function queryStart(pid) {
    const r = psRun([
        GET_PROCESS_LINE(pid),
        `try { $c = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction Stop } catch { [Console]::Error.Write($_.Exception.Message); exit 4 }`,
        'if ($null -eq $c) { if ($p.HasExited) { exit 3 } else { exit 4 } }',
        '[Console]::Out.Write($c.CreationDate.ToUniversalTime().ToString("o"))',
    ]);
    if (r.error) return { kind: 'failed', why: String(r.error.message) };
    if (r.status === 3) return { kind: 'gone' };
    const text = String(r.stdout || '').trim();
    if (r.status !== 0 || !ISO_RE.test(text)) return { kind: 'failed', why: `退出码 ${r.status}，输出 ${JSON.stringify(text.slice(0, 100))}` };
    return { kind: 'ok', start: text };
}

/**
 * 严格读登记文件。返回 { entries, problems }：problems 非空 = 登记通道失效（读取失败 / 缺表头 / 损坏记录 / 未写完整的末行 / 带近似时间的旧格式记录），
 * 调用方判监督失败并保留登记文件，绝不把它当成空登记。条目 { pid, start }，按 pid + 精确创建时间去重。
 */
function readRegistry(file) {
    const problems = [];
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { entries: [], problems: [`登记文件读取失败：${e && e.code ? e.code : e && e.message}`] }; }
    if (text === '') return { entries: [], problems: ['登记文件是空的（连表头都没有）'] };
    const lines = text.split('\n');
    if (lines[lines.length - 1] !== '') problems.push('登记文件末行没有换行结尾（最后一次写入不完整）');
    else lines.pop();
    if (lines[0] !== REGISTRY_HEADER) problems.push('登记文件缺少表头（或表头被改动）');
    const seen = new Set();
    const entries = [];
    for (let i = 1; i < lines.length; i += 1) {
        const raw = lines[i].replace(/\r$/, '');
        if (raw.trim() === '') continue;
        let e;
        try { e = JSON.parse(raw); } catch (_) { problems.push(`登记文件第 ${i + 1} 行不是合法 JSON：${JSON.stringify(raw.slice(0, 80))}`); continue; }
        if (!(e && typeof e === 'object' && !Array.isArray(e) && Number.isSafeInteger(e.pid) && e.pid > 0 && typeof e.start === 'string' && ISO_RE.test(e.start))) {
            problems.push(`登记文件第 ${i + 1} 行不是 { pid, start（精确创建时间）} 记录：${JSON.stringify(raw.slice(0, 80))}`);
            continue;
        }
        const key = `${e.pid}|${e.start}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({ pid: e.pid, start: e.start });
    }
    return { entries, problems };
}

/**
 * 创建并验证登记文件：全新创建（wx：路径已存在——含被预置成目录——即失败）、写表头、读回表头核对、再以追加方式打开一次（空写）核对可追加。
 * 返回 null（成功）或问题文字。
 */
function prepareRegistry(file) {
    try {
        fs.writeFileSync(file, `${REGISTRY_HEADER}\n`, { flag: 'wx' });
        fs.appendFileSync(file, '');
        const back = readRegistry(file);
        if (back.problems.length) return `登记文件创建后读回校验不通过：${back.problems.join('；')}`;
        return null;
    } catch (e) {
        return `登记文件创建 / 写入 / 读回失败：${e && e.code ? e.code : e && e.message}（${file}）`;
    }
}

const DEFAULT_REAP_DEADLINE_MS = 30000;

/**
 * 回收登记文件里仍存活的进程，整段有总截止（opts.budgetMs，默认 30 秒，与终止阶段截止同量级）：每次 PowerShell 调用只拿剩余预算（见 psRun），
 * 预算耗尽立即停止新尝试，尚未处理的存活条目列入 unprocessed，已尝试但没收掉的列入 failed，exhausted = true；登记文件由调用方保留。
 * 返回 { total, killed: [pid], failed: [{ pid, start, outcome, code }], unprocessed: [{ pid, start }], exhausted, problems }。
 */
async function reapRegistry(file, opts) {
    const budget = opts && Number.isFinite(opts.budgetMs) ? opts.budgetMs : DEFAULT_REAP_DEADLINE_MS;
    const deadline = Date.now() + budget;
    const left = () => deadline - Date.now();
    const { entries, problems } = readRegistry(file);
    const killedSet = new Set();
    const failed = [];
    const unprocessed = [];
    let exhausted = false;
    for (const e of entries) {
        if (!alive(e.pid)) continue;                        // 已退出：不用起 PowerShell（登记里绝大多数条目是早已退出的）
        if (left() <= 0) { exhausted = true; unprocessed.push({ pid: e.pid, start: e.start }); continue; }   // 预算耗尽：不再起新尝试，只报告
        let last = null;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            if (left() <= 0) { exhausted = true; break; }
            last = reapEntry(e, left());
            if (last.outcome === 'gone' || last.outcome === 'reused') break;   // 已不存在 / 不是登记的那个进程（PID 已被复用，不碰）
            if (last.outcome === 'killed') {
                killedSet.add(e.pid);
                const end = Math.min(Date.now() + 8000, deadline);
                while (alive(e.pid) && Date.now() < end) await sleep(100);
                if (!alive(e.pid)) { last = { outcome: 'gone', code: 3 }; break; }
                continue;                                   // 仍存活：下一轮重新核对身份（可能已被复用 → reused，或仍是它 → 再终止）
            }
            await sleep(Math.max(0, Math.min(300, left())));   // 查询失败 / 终止失败：保留记录，稍后重试
        }
        if (last === null) { unprocessed.push({ pid: e.pid, start: e.start }); continue; }
        if (last.outcome !== 'gone' && last.outcome !== 'reused') failed.push({ pid: e.pid, start: e.start, outcome: last.outcome, code: last.code });
    }
    return { total: entries.length, killed: Array.from(killedSet), failed, unprocessed, exhausted, problems };
}

// ---------------------------------------------------------------- 自检

const tmpName = (tag, ext) => path.join(os.tmpdir(), `lines-supervisor-${tag}-${process.pid}-${Date.now()}.${ext || 'json'}`);
function readPids(pidFile) { try { return JSON.parse(fs.readFileSync(pidFile, 'utf8')); } catch (_) { return null; } }

/** 自检里没能回收的进程的身份：{ where, role, pid, start（可能为 null）, why }。自检失败时逐条以 SUPERVISOR_LEFTOVER 行输出，供人工按身份处理。 */
const LEFTOVERS = [];
/** 仅受控夹具旋钮（正常运行不设）：cleanupFails = 夹具清理的终止动作必然失败；selftestKillBin / selftestKillDeadlineMs = 自检场景 A 的终止命令换成必然失败的命令。 */
const TEST = { cleanupFails: false, selftestKillBin: null, selftestKillDeadlineMs: null };

/**
 * 清理自检夹具泄漏的一个进程，**只认原身份**：
 *   手里有 ChildProcess 句柄且 Node 仍认为它在运行（PID 被句柄钉住）→ 句柄终止；Node 已认定它退出 → PID 上的是别的进程，不碰；
 *   否则必须有夹具自己记下的 CIM 精确创建时间，经 reapEntry（同一个 PowerShell 里持句柄、核精确创建时间、再终止；创建时间不符 = PID 已被复用，不碰）；
 *   取不到原身份（没有创建时间）→ 登记为清理失败，**禁止退回裸 PID 树杀**。有界重试；没收掉的进入 LEFTOVERS。
 */
async function cleanupIdentity(where, role, pid, start, handle) {
    if (!pid || !alive(pid)) return;
    if (handle) {
        if (handle.exitCode !== null || handle.signalCode !== null) return;   // Node 已认定它退出：现在占着这个 PID 的是别的进程
        if (!TEST.cleanupFails) {
            try { handle.kill('SIGKILL'); } catch (_) { /* 下面按身份再试 */ }
            const end = Date.now() + 5000;
            while (alive(pid) && Date.now() < end) await sleep(100);
            if (!alive(pid)) return;
        }
    }
    if (typeof start !== 'string' || !ISO_RE.test(start)) {
        LEFTOVERS.push({ where, role, pid, start: null, why: '夹具没有记录自己的精确创建时间，取不到原身份；不按裸 PID 终止' });
        return;
    }
    let last = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        last = TEST.cleanupFails ? { outcome: 'kill-failed', code: -2 } : reapEntry({ pid, start }, 15000);
        if (last.outcome === 'gone' || last.outcome === 'reused') return;     // 已不存在 / 不是原来那个进程（PID 已被复用，不碰）
        if (last.outcome === 'killed') {
            const end = Date.now() + 5000;
            while (alive(pid) && Date.now() < end) await sleep(100);
            if (!alive(pid)) return;
            continue;
        }
        await sleep(300);
    }
    LEFTOVERS.push({ where, role, pid, start, why: `按身份终止失败（${last.outcome}${last.stderr ? `：${last.stderr}` : ''}）` });
}
/** 清理自检夹具（pid 文件内容 { child, grandchild, childStart, grandchildStart }）；handles = { child: ChildProcess } 时直接子进程优先用句柄。 */
async function cleanupFixture(where, pids, handles) {
    if (!pids) return;
    for (const role of ['child', 'grandchild']) await cleanupIdentity(where, role, pids[role], pids[`${role}Start`], handles && handles[role]);
}

/**
 * 受控挂起夹具主体（两个套件的 --hang-fixture 共用）：起一个孙进程，把自己与孙进程的 **CIM 精确创建时间** 一并写进 pid 文件（清理只认这个原身份），然后同步阻塞。
 * 取不到创建时间就不写 pid 文件、退出码 87（自检会如实报告夹具没跑起来）。
 */
function runHangFixture(pidFile) {
    const grand = spawn(process.execPath, ['-e', 'setInterval(function(){}, 1000)'], { stdio: 'ignore', windowsHide: true });
    const own = queryStart(process.pid);
    const g = queryStart(grand.pid);
    if (own.kind !== 'ok' || g.kind !== 'ok') { try { grand.kill(); } catch (_) { /* */ } process.exit(87); }
    fs.writeFileSync(pidFile, JSON.stringify({ child: process.pid, grandchild: grand.pid, childStart: own.start, grandchildStart: g.start }));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2147483647);   // 同步阻塞：进程内看门狗在这里永远不会执行
    process.exit(0);
}
const unlinkQuiet = (f) => { try { fs.unlinkSync(f); } catch (_) { /* */ } };

/** 夹具 pid 文件里自己（child）与孙进程（grandchild）的 CIM 精确创建时间都在（ISO 7 位小数格式）。 */
const hasExactStarts = (pids) => !!(pids && ISO_RE.test(String(pids.childStart)) && ISO_RE.test(String(pids.grandchildStart)));

/** 场景 A、B：进程内监督（套件的挂起夹具）。 */
async function selfTestAB(cfg, problems) {
    const pfA = tmpName('A');
    // 受控旋钮（--test-selftest-kill-bin）：A 的终止命令换成必然失败的命令，验证「自检里的真实清理也失败」时监督进程仍显式非零退出（场景 H）
    const rA = await supervise([cfg.suiteFile, `--hang-fixture=${pfA}`], 6000, true, TEST.selftestKillBin ? { killBin: TEST.selftestKillBin, noFallback: true, killDeadlineMs: TEST.selftestKillDeadlineMs || 5000 } : undefined);
    const pidsA = readPids(pfA);
    const endA = Date.now() + (rA.reclaimFailed ? 0 : 10000);
    while (pidsA && (alive(pidsA.child) || alive(pidsA.grandchild)) && Date.now() < endA) await sleep(200);
    const leftA = pidsA ? [pidsA.child, pidsA.grandchild].filter(alive) : [];
    if (!pidsA) problems.push('A 挂起夹具没有写出 pid 文件（夹具没跑起来）');
    else if (!hasExactStarts(pidsA)) problems.push('A 挂起夹具的 pid 文件里没有自己与孙进程的精确创建时间（夹具清理只认原身份）');
    if (!rA.timedOut) problems.push('A 夹具在超时前自己退出了（应该被挂起并被监督进程超时杀掉）');
    if (rA.code === 0) problems.push('A 被杀的夹具退出码为 0（必须非零）');
    if (leftA.length) problems.push(`A 超时后仍有进程存活：${leftA.join(',')}（进程树没有回收）`);
    if (rA.reclaimFailed) problems.push('A 正常终止却被报告回收失败');
    if (rA.ms > 20000) problems.push(`A 超时到回收耗时 ${rA.ms}ms，超出预期`);
    await cleanupFixture('A', pidsA, { child: rA.child });
    unlinkQuiet(pfA);
    if (LEFTOVERS.length) return { rA, rB: null };   // 清理失败：环境已被污染，不再往下跑（由 selfTest 输出身份并显式非零退出）

    // 场景 B：终止命令必然失败（把 taskkill 换成 node 自己：`node /PID ...` 找不到模块，退出码非 0）。必须检查结果、用后备终止、在独立截止内返回，孙进程回收不了要如实报告
    const pfB = tmpName('B');
    const rB = await supervise([cfg.suiteFile, `--hang-fixture=${pfB}`], 4000, true, { killBin: process.execPath, killDeadlineMs: 10000, extraAlive: () => { const p = readPids(pfB); return p ? [p.grandchild] : []; } });
    const pidsB = readPids(pfB);
    if (!rB.killLog.some((l) => /FAIL/.test(l))) problems.push(`B 终止命令失败没有被检查出来（killLog=${rB.killLog.join('|')}）`);
    if (!rB.killLog.some((l) => /fallback child\.kill/.test(l))) problems.push('B 没有改用后备终止');
    if (rB.ms > 4000 + 10000 + 8000) problems.push(`B 超出终止截止仍未返回（${rB.ms}ms）`);
    if (!rB.timedOut) problems.push('B 没有走超时分支');
    if (pidsB && !hasExactStarts(pidsB)) problems.push('B 挂起夹具的 pid 文件里没有自己与孙进程的精确创建时间（夹具清理只认原身份）');
    // Windows 上 libuv 把子进程放进「父进程关闭即杀」的 job，所以后备终止杀掉夹具子进程后，它自己起的孙进程会随之回收：此时 reclaimFailed 必须为假；
    // 若有进程没回收则必须如实报告（见场景 C）
    const leftB = pidsB ? [pidsB.child, pidsB.grandchild].filter(alive) : [];
    if (leftB.length && !rB.reclaimFailed) problems.push(`B 仍有进程存活（${leftB.join(',')}）却没有报告回收失败`);
    if (!leftB.length && rB.reclaimFailed) problems.push('B 进程都已回收却报告回收失败');
    if (pidsB && alive(pidsB.child)) problems.push('B 后备终止之后直接子进程仍存活');
    await cleanupFixture('B', pidsB, { child: rB.child });
    unlinkQuiet(pfB);
    return { rA, rB };
}

/**
 * 运行一个**独立的监督进程**（入口文件自己 + 受控旋钮），核实它在 limitMs 内退出（以 OS 进程 exit 事件为准，不看管道是否关闭——存活的夹具子进程会继续持有继承来的 stdout）。
 * 返回 { exited, code, ms, out }。超过 limitMs 仍未退出则用真终止命令杀掉它。
 */
function runStandalone(cfg, extraArgs, limitMs, opts) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        const child = spawn(process.execPath, [cfg.entryFile, ...(opts && opts.selftest ? [] : ['--skip-selftest']), ...extraArgs], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });
        let done = false;
        let guardFired = false;
        const fin = (v) => { if (!done) { done = true; clearTimeout(guard); clearTimeout(guard2); resolve(Object.assign({ out }, v)); } };
        let guard2 = null;
        const guard = setTimeout(() => {
            // 超过上限仍没退出：兜底终止它（我们持有它的 ChildProcess 句柄，PID 被句柄钉住，Node 认为它已退出就不再碰）。
            // 终止之后有界等 exit 事件；仍没退出 = 兜底终止失败：登记它的身份（连同创建时间）进 LEFTOVERS，不再无限等
            guardFired = true;
            if (child.exitCode === null && child.signalCode === null) {
                try { child.kill('SIGKILL'); } catch (_) { /* */ }
                try { killTreeOnce(child.pid, undefined); } catch (_) { /* */ }
            }
            guard2 = setTimeout(() => {
                if (child.exitCode === null && child.signalCode === null) {
                    const q = queryStart(child.pid);
                    LEFTOVERS.push({ where: 'standalone', role: 'supervisor', pid: child.pid, start: q.kind === 'ok' ? q.start : null, why: `独立监督进程超过 ${limitMs}ms 没退出，兜底终止也没能让它退出` });
                }
                fin({ exited: false, code: null, ms: Date.now() - t0 });
            }, 5000);
        }, limitMs);
        child.on('exit', (code) => fin({ exited: !guardFired, code, ms: Date.now() - t0 }));
        child.on('error', () => fin({ exited: false, code: -1, ms: Date.now() - t0 }));
    });
}

/** 场景 C、D：全部终止失败 / 终止命令持续阻塞（独立监督进程 + 套件的挂起夹具）。 */
async function selfTestCD(cfg, problems) {
    const standalone = async (tag, extra, timeoutMs, deadlineMs, limitMs) => {
        const pf = tmpName(tag);
        const res = await runStandalone(cfg, [`--timeout-ms=${timeoutMs}`, `--kill-deadline-ms=${deadlineMs}`, '--test-no-fallback', ...extra, `--hang-fixture=${pf}`], limitMs);
        const pids = readPids(pf);
        const stillAlive = !!(pids && alive(pids.child));
        await cleanupFixture(tag, pids);
        unlinkQuiet(pf);
        return Object.assign(res, { stillAlive });
    };
    const rC = await standalone('C', ['--test-kill-bin=' + process.execPath], 3000, 4000, 3000 + 4000 + 6000);
    if (!rC.exited) problems.push(`C 独立监督进程在 ${rC.ms}ms 内没有退出（终止全部失败时必须在截止后显式退出，不能被存活的子进程拖住）`);
    if (rC.exited && rC.code !== 3) problems.push(`C 独立监督进程退出码 ${rC.code}（应为 3）`);
    if (!/SUPERVISOR_RECLAIM_FAILED/.test(rC.out)) problems.push('C 没有输出 SUPERVISOR_RECLAIM_FAILED 诊断');
    if (!/#1 FAIL/.test(rC.out) || /fallback child\.kill/.test(rC.out)) problems.push('C 诊断里应有终止命令失败记录且没有后备终止（证明确实走了「杀不死」分支）');
    const rD = await standalone('D', ['--test-kill-bin=' + process.execPath, '--test-kill-args=' + JSON.stringify(['-e', 'setTimeout(function(){}, 60000)'])], 3000, 4000, 3000 + 4000 + 6000);
    if (!rD.exited) problems.push(`D 终止命令持续阻塞时独立监督进程在 ${rD.ms}ms 内没有退出（单次终止命令必须按剩余截止限时）`);
    if (rD.exited && rD.ms > 3000 + 4000 + 3000) problems.push(`D 实际退出耗时 ${rD.ms}ms 超出 超时 + 截止 + 余量(3000ms)`);
    if (rD.exited && rD.code !== 3) problems.push(`D 独立监督进程退出码 ${rD.code}（应为 3）`);
    if (!/SUPERVISOR_RECLAIM_FAILED/.test(rD.out)) problems.push('D 没有输出 SUPERVISOR_RECLAIM_FAILED 诊断');
    return { rC, rD };
}

/** 替身套件（登记通道自检用）：由监督进程当套件运行。模式 ok = 什么都不做；corrupt = 往登记文件追加一行损坏记录；delete = 删掉登记文件。第二个参数给了就写一个「我被运行了」的标记文件。 */
const STAND_IN_SRC = [
    "'use strict';",
    "const fs = require('fs');",
    "const mode = process.argv[2] || 'ok';",
    "const marker = process.argv[3] || null;",
    "const reg = process.env.S2C_TEST_REGISTRY;",
    "if (marker && mode !== 'hangreg') fs.writeFileSync(marker, 'ran');",
    "if (mode === 'corrupt') fs.appendFileSync(reg, 'this is not json\\n');",
    "if (mode === 'delete') fs.unlinkSync(reg);",
    // hangreg：用共享模块的 queryStart 取自己的精确创建时间，登记到登记文件、把原身份写进 marker（pid 文件），然后同步挂起（场景 G）
    `if (mode === 'hangreg') { const SUP = require(${JSON.stringify(__filename)}); const q = SUP.queryStart(process.pid); if (q.kind !== 'ok') process.exit(87); fs.appendFileSync(reg, JSON.stringify({ pid: process.pid, start: q.start }) + '\\n'); fs.writeFileSync(marker, JSON.stringify({ child: process.pid, childStart: q.start })); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2147483647); }`,
    "process.exit(0);",
    '',
].join('\n');

/** 场景 P：非 Windows 直接非零退出并说明，不运行套件。 */
async function selfTestPlatform(cfg, problems) {
    const sf = tmpName('standin-P', 'js');
    const marker = tmpName('marker-P', 'txt');
    fs.writeFileSync(sf, STAND_IN_SRC);
    const r = await runStandalone(cfg, ['--test-platform=linux', `--test-suite=${sf}`, 'ok', marker], 20000);
    const ran = fs.existsSync(marker);
    unlinkQuiet(sf); unlinkQuiet(marker);
    if (!r.exited) problems.push(`P 非 Windows 的独立监督进程在 ${r.ms}ms 内没有退出`);
    if (r.exited && r.code === 0) problems.push('P 非 Windows 却以退出码 0 结束（必须非零）');
    if (!/本工具只支持 Windows/.test(r.out)) problems.push(`P 非 Windows 的输出里没有说明「本工具只支持 Windows」：${JSON.stringify(r.out.slice(0, 200))}`);
    if (ran) problems.push('P 非 Windows 却运行了套件');
    return r;
}

/** 场景 E：登记通道失效即判红（独立监督进程 + 替身套件）。 */
async function selfTestRegistry(cfg, problems) {
    const run = async (tag, mode, extra) => {
        const sf = tmpName(`standin-${tag}`, 'js');
        const marker = tmpName(`marker-${tag}`, 'txt');
        fs.writeFileSync(sf, STAND_IN_SRC);
        const regPath = tmpName(`reg-${tag}`, 'jsonl');
        const res = await runStandalone(cfg, [`--test-suite=${sf}`, `--test-registry-path=${extra && extra.registryIsDir ? extra.dirPath : regPath}`, mode, marker], 60000);
        const ran = fs.existsSync(marker);
        const regRetained = fs.existsSync(regPath);
        unlinkQuiet(sf); unlinkQuiet(marker); unlinkQuiet(regPath);
        return Object.assign(res, { ran, regRetained, regPath });
    };
    // 对照：登记通道正常、替身套件什么都不做 → 0
    const okRun = await run('ok', 'ok');
    if (!okRun.exited || okRun.code !== 0) problems.push(`E0 对照（登记通道正常）应退出码 0，实际 ${okRun.exited ? okRun.code : '未退出'}：${JSON.stringify(okRun.out.slice(0, 300))}`);
    if (!okRun.ran) problems.push('E0 对照里替身套件没有被运行');
    // E1 登记路径预置为目录：套件启动前就非零退出，不运行套件
    const dirPath = tmpName('reg-dir', 'dir');
    fs.mkdirSync(dirPath);
    const e1 = await run('dir', 'ok', { registryIsDir: true, dirPath });
    try { fs.rmdirSync(dirPath); } catch (_) { /* */ }
    if (!e1.exited) problems.push('E1 登记路径是目录：独立监督进程没有退出');
    else if (e1.code === 0) problems.push('E1 登记路径是目录却以退出码 0 结束（必须非零）');
    if (!/SUPERVISOR_REGISTRY_FAILED/.test(e1.out)) problems.push('E1 没有输出 SUPERVISOR_REGISTRY_FAILED');
    if (e1.ran) problems.push('E1 登记通道不可用却仍运行了套件');
    // E2 套件写入一行损坏记录：非零，输出登记文件路径，登记文件保留
    const e2 = await run('corrupt', 'corrupt');
    if (!e2.exited) problems.push('E2 损坏记录：独立监督进程没有退出');
    else if (e2.code === 0) problems.push('E2 登记里有损坏记录却以退出码 0 结束（必须非零）');
    if (!/SUPERVISOR_REGISTRY_FAILED/.test(e2.out)) problems.push('E2 没有输出 SUPERVISOR_REGISTRY_FAILED');
    if (!e2.out.includes(e2.regPath)) problems.push('E2 输出里没有登记文件路径');
    if (!e2.regRetained) problems.push('E2 登记文件没有保留供排查');
    // E3 套件删掉登记文件（读取失败）：非零
    const e3 = await run('delete', 'delete');
    if (!e3.exited) problems.push('E3 登记文件被删：独立监督进程没有退出');
    else if (e3.code === 0) problems.push('E3 登记文件读取失败却以退出码 0 结束（必须非零）');
    if (!/SUPERVISOR_REGISTRY_FAILED/.test(e3.out)) problems.push('E3 没有输出 SUPERVISOR_REGISTRY_FAILED');
    return { okRun, e1, e2, e3 };
}

/** 场景 R：登记回收的身份纪律（进程内单元）。 */
async function selfTestReapIdentity(problems) {
    const regFile = tmpName('reg-R', 'jsonl');
    const prep = prepareRegistry(regFile);
    if (prep) { problems.push(`R 前置：${prep}`); return; }
    const spawnIdle = () => spawn(process.execPath, ['-e', 'setInterval(function(){}, 1000)'], { stdio: 'ignore', windowsHide: true });
    const kids = [];
    const waitStart = async (child) => {
        const end = Date.now() + 30000;
        for (;;) {
            const q = queryStart(child.pid);
            if (q.kind === 'ok') return q.start;
            if (q.kind === 'failed' || Date.now() > end) return null;
            await sleep(200);
        }
    };
    const append = (e) => fs.appendFileSync(regFile, `${JSON.stringify(e)}\n`);
    const reset = () => fs.writeFileSync(regFile, `${REGISTRY_HEADER}\n`);
    try {
        // R1 PID 相同、创建时间差 2 秒 → 不得终止（只认精确创建时间）
        const k1 = spawnIdle(); kids.push(k1);
        const s1 = await waitStart(k1);
        if (s1 === null) { problems.push('R1 前置：取不到夹具进程的创建时间'); return; }
        reset();
        append({ pid: k1.pid, start: new Date(Date.parse(s1) + 2000).toISOString() });
        const r1 = await reapRegistry(regFile);
        if (!alive(k1.pid)) problems.push('R1 登记的创建时间与进程相差 2 秒，却把进程终止了（只能按 PID + 精确创建时间）');
        if (r1.killed.length) problems.push(`R1 报告终止了 ${r1.killed.join(',')}（创建时间不符的记录不得终止任何进程）`);
        if (r1.failed.length) problems.push(`R1 创建时间不符应判「PID 已被复用」而不是失败：${JSON.stringify(r1.failed)}`);
        // R2 精确匹配 → 终止（对照）
        reset();
        append({ pid: k1.pid, start: s1 });
        const r2 = await reapRegistry(regFile);
        const endR2 = Date.now() + 10000;
        while (alive(k1.pid) && Date.now() < endR2) await sleep(100);
        if (alive(k1.pid)) problems.push('R2 登记的创建时间精确匹配，进程却没有被终止（对照失败）');
        if (!r2.killed.includes(k1.pid)) problems.push(`R2 报告里没有这个进程（killed=${JSON.stringify(r2.killed)}）`);
        if (r2.failed.length) problems.push(`R2 精确匹配的回收出现失败项：${JSON.stringify(r2.failed)}`);
        // R3 PowerShell 查询失败 ≠ 进程不存在：Get-Process 报「非找不到」的错误 → 记录保留、报告失败，进程不被终止
        const k3 = spawnIdle(); kids.push(k3);
        const s3 = await waitStart(k3);
        if (s3 === null) { problems.push('R3 前置：取不到夹具进程的创建时间'); return; }
        reset();
        append({ pid: k3.pid, start: s3 });
        _test.psPrelude = "function Get-Process { [CmdletBinding()] param($Id) Write-Error 'injected Get-Process failure' }";
        let r3;
        try { r3 = await reapRegistry(regFile); } finally { _test.psPrelude = ''; }
        if (!alive(k3.pid)) problems.push('R3 Get-Process 查询失败时进程被终止了（查询失败不得终止）');
        if (r3.failed.length !== 1 || r3.failed[0].outcome !== 'query-failed') problems.push(`R3 查询失败应保留记录并报告失败（query-failed）：${JSON.stringify(r3.failed)}`);
        // R4 明确「找不到该进程」才判不存在：一个已退出进程的记录
        const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true });
        await new Promise((resolve) => dead.once('exit', resolve));
        const r4 = reapEntry({ pid: dead.pid, start: '2001-01-01T00:00:00.0000000Z' });
        if (r4.outcome !== 'gone') problems.push(`R4 已退出的进程应判 gone（明确找不到），实际 ${r4.outcome}（stderr ${r4.stderr}）`);
        // 终止 k3（R3 之后恢复正常再回收）
        reset();
        append({ pid: k3.pid, start: s3 });
        await reapRegistry(regFile);
    } finally {
        for (const k of kids) { if (alive(k.pid)) { try { k.kill(); } catch (_) { /* 夹具自己的子进程，句柄在手 */ } } }
        unlinkQuiet(regFile);
    }
}

/** 场景 F：夹具清理只认精确身份（进程内单元）：PID 对得上但创建时间错的存活诱饵不得被终止；取不到原身份报告清理失败（不退回裸 PID）；精确身份 / 句柄才终止。 */
async function selfTestFixtureIdentity(problems) {
    const spawnIdle = () => spawn(process.execPath, ['-e', 'setInterval(function(){}, 1000)'], { stdio: 'ignore', windowsHide: true });
    const kids = [];
    const base = LEFTOVERS.length;
    try {
        const d = spawnIdle(); kids.push(d);
        let s = null;
        const end = Date.now() + 30000;
        for (;;) {
            const q = queryStart(d.pid);
            if (q.kind === 'ok') { s = q.start; break; }
            if (q.kind === 'failed' || Date.now() > end) break;
            await sleep(200);
        }
        if (s === null) { problems.push('F 前置：取不到诱饵进程的创建时间'); return; }
        // F1 PID 对得上、创建时间错 2 秒、没有句柄 → 不得终止，也不算清理失败（那已不是原来的进程）
        await cleanupFixture('F1', { child: d.pid, childStart: new Date(Date.parse(s) + 2000).toISOString() });
        if (!alive(d.pid)) problems.push('F1 夹具兜底终止了「PID 对得上但创建时间不符」的诱饵（只认精确身份，不得按裸 PID 终止）');
        if (LEFTOVERS.length !== base) problems.push(`F1 创建时间不符应判「已不是原进程」，不是清理失败：${JSON.stringify(LEFTOVERS.slice(base))}`);
        LEFTOVERS.length = base;
        // F2 夹具没有记录创建时间（取不到原身份）、没有句柄 → 不终止，报告清理失败
        await cleanupFixture('F2', { child: d.pid });
        if (!alive(d.pid)) problems.push('F2 取不到原身份时夹具兜底仍终止了进程（禁止退回裸 PID 树杀）');
        if (LEFTOVERS.length !== base + 1 || LEFTOVERS[base].pid !== d.pid) problems.push(`F2 取不到原身份应报告清理失败（含 PID）：${JSON.stringify(LEFTOVERS.slice(base))}`);
        LEFTOVERS.length = base;
        // F3 精确身份 → 终止（对照）
        await cleanupFixture('F3', { child: d.pid, childStart: s });
        const e3 = Date.now() + 10000;
        while (alive(d.pid) && Date.now() < e3) await sleep(100);
        if (alive(d.pid)) problems.push('F3 创建时间精确匹配，夹具清理却没有终止进程（对照失败）');
        if (LEFTOVERS.length !== base) problems.push(`F3 精确匹配的清理不应有失败：${JSON.stringify(LEFTOVERS.slice(base))}`);
        LEFTOVERS.length = base;
        // F4 手里有句柄（直接子进程）→ 优先用句柄终止，哪怕没有记录创建时间
        const d4 = spawnIdle(); kids.push(d4);
        await sleep(300);
        await cleanupFixture('F4', { child: d4.pid }, { child: d4 });
        const e4 = Date.now() + 10000;
        while (alive(d4.pid) && Date.now() < e4) await sleep(100);
        if (alive(d4.pid)) problems.push('F4 手里有 ChildProcess 句柄时，夹具清理没有用句柄终止直接子进程');
        LEFTOVERS.length = base;
    } finally {
        for (const k of kids) { if (k.exitCode === null && k.signalCode === null) { try { k.kill(); } catch (_) { /* 夹具自己的子进程，句柄在手 */ } } }
        LEFTOVERS.length = base;
    }
}

/**
 * 场景 G：登记回收纳入总截止（独立监督进程 + 替身套件）。套件挂起、树终止失败、登记查询持续阻塞（PowerShell 层注入 Start-Sleep）三者叠加：
 * 以 OS 进程 exit 事件为准，实际退出时间不得超过 超时 + 终止截止 + 回收截止 + 余量，退出码非零，输出未处理的身份，登记文件保留。
 */
async function selfTestReapBudget(cfg, problems) {
    const sf = tmpName('standin-G', 'js');
    const marker = tmpName('marker-G', 'json');
    const regPath = tmpName('reg-G', 'jsonl');
    fs.writeFileSync(sf, STAND_IN_SRC);
    const TO = 2000; const KD = 3000; const RD = 3000; const MARGIN = 3000;
    const res = await runStandalone(cfg, [`--test-suite=${sf}`, `--test-registry-path=${regPath}`, `--timeout-ms=${TO}`, `--kill-deadline-ms=${KD}`, '--test-no-fallback', `--test-kill-bin=${process.execPath}`,
        `--reap-deadline-ms=${RD}`, '--test-ps-prelude=Start-Sleep -Seconds 120', 'hangreg', marker], TO + KD + RD + MARGIN + 6000);
    const pids = readPids(marker);
    const regRetained = fs.existsSync(regPath);
    await cleanupFixture('G', pids);
    unlinkQuiet(sf); unlinkQuiet(marker); unlinkQuiet(regPath);
    if (!pids) problems.push('G 替身套件没有写出原身份（没跑起来）');
    if (!res.exited) problems.push(`G 套件挂起 + 树终止失败 + 登记查询持续阻塞：独立监督进程在 ${res.ms}ms 内没有退出（登记回收必须有总截止）`);
    else {
        if (res.ms > TO + KD + RD + MARGIN) problems.push(`G 实际退出耗时 ${res.ms}ms 超出 超时 ${TO} + 终止截止 ${KD} + 回收截止 ${RD} + 余量 ${MARGIN}`);
        if (res.code === 0 || res.code === null) problems.push(`G 退出码 ${res.code}（必须显式非零）`);
    }
    if (!/SUPERVISOR_REAP_BUDGET_EXHAUSTED/.test(res.out)) problems.push('G 没有输出 SUPERVISOR_REAP_BUDGET_EXHAUSTED');
    if (pids && !res.out.includes(`"pid":${pids.child}`)) problems.push(`G 输出里没有未回收进程的身份（pid ${pids.child}）`);
    if (!regRetained) problems.push('G 登记文件没有保留');
    return res;
}

/**
 * 场景 H：自检失败路径显式退出。独立监督进程（带自检）里让 A 的终止命令失败、夹具清理的终止动作也失败（注入）：
 * 监督进程必须输出未回收进程的身份（SUPERVISOR_LEFTOVER）并**实际退出**（OS 进程 exit 事件，不是 Promise 返回）、退出码非零；残留进程由本场景按输出里的身份清掉。
 */
async function selfTestAbortExit(cfg, problems) {
    const A = 6000; const KD = 3000;
    const res = await runStandalone(cfg, [`--test-selftest-kill-bin=${process.execPath}`, `--test-selftest-kill-deadline-ms=${KD}`, '--test-cleanup-fails'], A + KD + 8000, { selftest: true });
    const left = [];
    for (const l of res.out.split(/\r?\n/)) {
        const m = /^SUPERVISOR_LEFTOVER (\{.*\})$/.exec(l);
        if (m) { try { left.push(JSON.parse(m[1])); } catch (_) { /* */ } }
    }
    // 按输出里的身份清掉残留（本场景自己的善后；不是被测的清理）
    const before = LEFTOVERS.length;
    for (const l of left) await cleanupIdentity('H-outer', l.role, l.pid, l.start, null);
    if (LEFTOVERS.length !== before) problems.push(`H 善后：按输出里的身份没能清掉残留进程：${JSON.stringify(LEFTOVERS.slice(before))}`);
    if (!res.exited) problems.push(`H 自检里 A 的终止命令与夹具清理都失败：独立监督进程在 ${res.ms}ms 内没有实际退出（自检失败路径必须经显式退出函数结束）`);
    else if (res.code === 0 || res.code === null) problems.push(`H 退出码 ${res.code}（必须显式非零）`);
    if (!left.length) problems.push(`H 输出里没有 SUPERVISOR_LEFTOVER（未回收进程的身份）：${JSON.stringify(res.out.slice(0, 300))}`);
    return res;
}

/** 场景 D2：中间启动器退出、detached 服务存活、套件同步挂起：进程树回收够不到服务（负向对照），按登记文件回收才行。 */
async function selfTestDetached(cfg) {
    const stamp = `${process.pid}-${Date.now()}`;
    const pidFile = path.join(os.tmpdir(), `lines-supervisor-detach-${stamp}.json`);
    const regFile = path.join(os.tmpdir(), `lines-supervisor-detach-${stamp}.jsonl`);
    const prep = prepareRegistry(regFile);
    const problems = [];
    if (prep) {
        console.log(`SUPERVISOR_SELFTEST_DETACHED FAIL：${prep}`);
        return false;
    }
    const r = await supervise([cfg.suiteFile, `--detach-fixture=${pidFile}`], 8000, true, { env: { [REGISTRY_ENV]: regFile } });
    let svc = null;
    try { svc = JSON.parse(fs.readFileSync(pidFile, 'utf8')).service; } catch (_) { svc = null; }
    if (!Number.isSafeInteger(svc)) problems.push('detached 服务没有写出 pid 文件（夹具没跑起来）');
    if (!r.timedOut) problems.push('夹具套件在超时前自己退出了（应该同步挂起并被监督进程超时杀掉）');
    const aliveAfterTree = Number.isSafeInteger(svc) && alive(svc);
    if (Number.isSafeInteger(svc) && !aliveAfterTree) problems.push('进程树回收之后 detached 服务已经不在了（夹具无效：它本应是树杀够不到的）');
    const rep = await reapRegistry(regFile);
    if (Number.isSafeInteger(svc)) {
        const deadline = Date.now() + 10000;
        while (alive(svc) && Date.now() < deadline) await sleep(100);
        if (alive(svc)) problems.push(`按登记文件回收之后 detached 服务 ${svc} 仍然存活（请人工核对并清理该 PID；监督进程不按裸 PID 终止）`);
        if (!rep.killed.includes(svc)) problems.push(`回收报告里没有这个服务（killed=${JSON.stringify(rep.killed)}）`);
    }
    if (rep.failed.length) problems.push(`回收报告有终止失败项：${JSON.stringify(rep.failed)}`);
    if (rep.problems.length) problems.push(`登记文件有问题：${rep.problems.join('；')}`);
    if (!problems.length) { unlinkQuiet(regFile); }
    unlinkQuiet(pidFile);
    if (problems.length) {
        console.log(`SUPERVISOR_SELFTEST_DETACHED FAIL：${problems.join('；')}（登记文件 ${regFile}）`);
        return false;
    }
    console.log(`SUPERVISOR_SELFTEST_DETACHED OK：套件挂起 ${r.ms}ms 后被杀；树杀之后 detached 服务 ${svc} 仍存活（负向对照成立），按登记文件回收后已退出（登记 ${rep.total} 条，终止 ${rep.killed.length} 个，失败 0 个）`);
    return true;
}

/**
 * 自检。任何失败（含清理失败）都输出问题与未回收进程的身份（SUPERVISOR_LEFTOVER），返回 false，由主流程经显式退出函数 fatalExit 非零结束。
 * 有进程没能回收（LEFTOVERS 非空）时立即停止后续场景：环境已被污染，继续跑只会放大。
 */
async function selfTest(cfg, platform) {
    const problems = [];
    const polluted = () => LEFTOVERS.length > 0;
    const nested = TEST.cleanupFails || TEST.selftestKillBin !== null;
    const report = () => {
        console.log(`SUPERVISOR_SELFTEST FAIL：${problems.join('；') || '自检夹具遗留进程没能回收'}`);
        for (const l of LEFTOVERS) console.log(`SUPERVISOR_LEFTOVER ${JSON.stringify(l)}`);
        if (LEFTOVERS.length) console.log('SUPERVISOR_LEFTOVER_HINT：以上进程没能回收，请按 PID + 创建时间人工核对并清理（不要只按 PID 终止）');
        return false;
    };
    const ab = await selfTestAB(cfg, problems);
    if (polluted()) return report();
    const { rA, rB } = ab;
    const { rC, rD } = await selfTestCD(cfg, problems);
    if (polluted()) return report();
    await selfTestPlatform(cfg, problems);
    await selfTestFixtureIdentity(problems);
    if (polluted()) return report();
    if (cfg.reap) {
        await selfTestReapIdentity(problems);
        await selfTestRegistry(cfg, problems);
        if (!nested) await selfTestReapBudget(cfg, problems);
        if (polluted()) return report();
    }
    // 嵌套保护：H 里被注入故障的那个独立监督进程自己不再跑 G / H（否则故障没生效时会递归）
    const rH = nested ? { ms: 0, code: null } : await selfTestAbortExit(cfg, problems);
    if (problems.length || polluted()) return report();
    console.log(`SUPERVISOR_SELFTEST OK：A 正常终止 ${rA.ms}ms 回收整棵进程树；B 终止命令失败（${rB.killLog.length} 次尝试，检出失败并改用后备）${rB.ms}ms 内返回、回收情况如实报告（reclaimFailed=${rB.reclaimFailed}）；C 独立监督进程在全部终止失败时 ${rC.ms}ms 退出（退出码 ${rC.code}）；D 终止命令持续阻塞时 ${rD.ms}ms 退出（退出码 ${rD.code}）；P 非 Windows 拒绝；F 夹具清理只认精确身份${cfg.reap ? '；R 登记回收只认精确创建时间且查询失败不终止；E 登记通道失效判红；G 登记回收有总截止' : ''}；H 自检里清理也失败时 ${rH.ms}ms 实际退出（退出码 ${rH.code}）`);
    if (cfg.reap && cfg.detachedSelfTest) return selfTestDetached(cfg);
    return true;
}

// ---------------------------------------------------------------- 主流程

/**
 * cfg = { entryFile（入口脚本的绝对路径，独立监督进程自检要再运行它）, suiteFile（套件绝对路径）, reap（启用登记回收）, detachedSelfTest（启用 detached 夹具自检，需要套件支持 --detach-fixture） }。
 */
async function main(cfg) {
    const args = process.argv.slice(2);
    const argVal = (prefix) => { const a = args.find((x) => x.startsWith(prefix)); return a ? a.slice(prefix.length) : null; };
    const timeoutArg = argVal('--timeout-ms=');
    const TIMEOUT_MS = timeoutArg !== null ? Number(timeoutArg) : 20 * 60 * 1000;
    const SKIP_SELFTEST = args.includes('--skip-selftest');
    // 受控夹具旋钮（仅供本文件自检用「独立监督进程」夹具；正常运行不传）
    const KILL_DEADLINE_ARG = argVal('--kill-deadline-ms=');
    const TEST_KILL_BIN = argVal('--test-kill-bin=');
    const TEST_KILL_ARGS = argVal('--test-kill-args=');
    const TEST_NO_FALLBACK = args.includes('--test-no-fallback');
    const TEST_PLATFORM = argVal('--test-platform=');
    const TEST_SUITE = argVal('--test-suite=');
    const TEST_REGISTRY_PATH = argVal('--test-registry-path=');
    const REAP_DEADLINE_ARG = argVal('--reap-deadline-ms=');
    const TEST_PS_PRELUDE = argVal('--test-ps-prelude=');
    const SELFTEST_KILL_BIN = argVal('--test-selftest-kill-bin=');
    const SELFTEST_KILL_DEADLINE = argVal('--test-selftest-kill-deadline-ms=');
    const KNOB_PREFIXES = ['--timeout-ms=', '--kill-deadline-ms=', '--test-kill-bin=', '--test-kill-args=', '--test-platform=', '--test-suite=', '--test-registry-path=', '--reap-deadline-ms=', '--test-ps-prelude=', '--test-selftest-kill-bin=', '--test-selftest-kill-deadline-ms='];
    const passArgs = args.filter((a) => !KNOB_PREFIXES.some((p) => a.startsWith(p)) && a !== '--skip-selftest' && a !== '--test-no-fallback' && a !== '--test-cleanup-fails');
    const KILL_DEADLINE_MS = KILL_DEADLINE_ARG !== null ? Number(KILL_DEADLINE_ARG) : DEFAULT_KILL_DEADLINE_MS;   // 终止阶段的独立截止：超时之后最多再等这么久
    const REAP_DEADLINE_MS = REAP_DEADLINE_ARG !== null ? Number(REAP_DEADLINE_ARG) : DEFAULT_REAP_DEADLINE_MS;      // 登记回收阶段的总截止（终止阶段结束之后最多再用这么久）
    if (TEST_PS_PRELUDE !== null) _test.psPrelude = TEST_PS_PRELUDE;
    if (SELFTEST_KILL_BIN !== null) { TEST.selftestKillBin = SELFTEST_KILL_BIN; TEST.selftestKillDeadlineMs = SELFTEST_KILL_DEADLINE !== null ? Number(SELFTEST_KILL_DEADLINE) : null; }
    if (args.includes('--test-cleanup-fails')) TEST.cleanupFails = true;

    process.exitCode = 1;
    const platform = TEST_PLATFORM !== null ? TEST_PLATFORM : process.platform;
    if (platform !== 'win32') {
        return fatalExit(1, `SUPERVISOR_UNSUPPORTED_PLATFORM：本工具只支持 Windows（当前平台 ${platform}）。非 Windows 没有「句柄钉住 PID」的终止手段，进程回收可能误杀无关进程，所以不提供；没有运行套件`);
    }
    if (!SKIP_SELFTEST) {
        const ok = await selfTest(cfg, platform);
        if (!ok) return fatalExit(1, 'SUPERVISOR_EXIT：自检失败（有界清理已完成，未回收的进程见上面的 SUPERVISOR_LEFTOVER 行），监督进程显式非零退出，没有运行套件');
    }
    // 登记文件：启动套件前创建并验证；失败即不运行套件
    let regFile = null;
    if (cfg.reap) {
        regFile = TEST_REGISTRY_PATH !== null ? TEST_REGISTRY_PATH : path.join(os.tmpdir(), `lines-registry-${process.pid}-${Date.now()}.jsonl`);
        const prep = prepareRegistry(regFile);
        if (prep) {
            return fatalExit(1, `SUPERVISOR_REGISTRY_FAILED：${prep}。登记通道不可用，没有运行套件（判失败）`);
        }
    }
    const knobs = { killBin: TEST_KILL_BIN || undefined, killArgs: TEST_KILL_ARGS ? JSON.parse(TEST_KILL_ARGS) : undefined, noFallback: TEST_NO_FALLBACK, killDeadlineMs: KILL_DEADLINE_MS, env: regFile !== null ? { [REGISTRY_ENV]: regFile } : {} };
    const r = await supervise([TEST_SUITE !== null ? TEST_SUITE : cfg.suiteFile, ...passArgs], TIMEOUT_MS, false, knobs);

    let rep = null;
    let registryBad = false;
    if (regFile !== null) {
        rep = await reapRegistry(regFile, { budgetMs: REAP_DEADLINE_MS });   // 登记回收有总截止：预算耗尽即停止新尝试
        console.log(`SUPERVISOR_REAP：进程登记 ${rep.total} 条；套件结束后仍存活并被监督进程按身份终止 ${rep.killed.length} 个${rep.killed.length ? `（PID ${rep.killed.join(',')}）` : ''}；终止失败 ${rep.failed.length} 个${rep.failed.length ? `（${JSON.stringify(rep.failed)}）` : ''}`);
        if (rep.problems.length) {
            console.log(`SUPERVISOR_REGISTRY_FAILED：登记通道失效：${rep.problems.join('；')}。登记文件已保留：${regFile}（判失败）`);
        }
        if (rep.exhausted) {
            console.log(`SUPERVISOR_REAP_BUDGET_EXHAUSTED：登记回收在 ${REAP_DEADLINE_MS}ms 总截止内没做完，已停止新尝试；终止失败的身份 ${JSON.stringify(rep.failed)}；未处理的身份 ${JSON.stringify(rep.unprocessed)}；登记文件已保留：${regFile}（判失败，请按「PID + 创建时间」人工核对清理）`);
        }
        registryBad = rep.problems.length > 0 || rep.failed.length > 0 || rep.unprocessed.length > 0 || rep.exhausted;
        if (!registryBad) unlinkQuiet(regFile);
    }
    if (r.timedOut && r.reclaimFailed) {
        // 显式退出：仍存活的子进程 / 句柄会让 Node 在事件循环里一直等，process.exitCode 不够。
        return fatalExit(3, `SUPERVISOR_RECLAIM_FAILED：套件超过 ${TIMEOUT_MS}ms 未结束，终止阶段在 ${KILL_DEADLINE_MS}ms 截止内没能回收进程（killLog=${r.killLog.join('|')}），请人工检查并清理遗留的 node 进程（判失败）`);
    }
    if (rep !== null && rep.exhausted) return fatalExit(3, `SUPERVISOR_EXIT：登记回收总截止耗尽，退出码 3（判失败）`);
    if (registryBad) return fatalExit(1, 'SUPERVISOR_EXIT：登记回收有失败项或登记通道失效，退出码 1（判失败）');
    if (r.timedOut) {
        return fatalExit(2, `SUPERVISOR_TIMEOUT：套件超过 ${TIMEOUT_MS}ms 未结束，已杀进程树（判失败，不是通过）`);
    }
    if (r.code === null) return fatalExit(1, `SUPERVISOR：套件被信号 ${r.signal} 终止（判失败）`);
    if (r.code === 0 && rep !== null && rep.killed.length > 0) return fatalExit(1, 'SUPERVISOR：套件自称通过，但结束后仍有登记的进程存活（套件自己的收尾漏了）——判失败');
    if (r.code !== 0) return fatalExit(1, `SUPERVISOR：套件退出码 ${r.code}（判失败）`);
    process.exitCode = 0;
}

/**
 * 唯一的显式非零退出函数（所有失败出口共用）：写完诊断（回调里）再退出，另设兜底定时器。
 * 不依赖事件循环自然排空：存活的子进程 / 句柄会让 Node 一直等，process.exitCode 不够。
 */
function fatalExit(code, text) {
    setTimeout(() => process.exit(code), 1500);
    process.stdout.write(`${text}\n`, () => process.exit(code));
}

module.exports = { main, supervise, killTreeOnce, buildReapScript, reapEntry, reapRegistry, readRegistry, prepareRegistry, queryStart, runHangFixture, fatalExit, REGISTRY_ENV, REGISTRY_HEADER, _test };
