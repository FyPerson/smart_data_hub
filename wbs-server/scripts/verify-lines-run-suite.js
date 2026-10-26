/**
 * #106 S2c 验证（套件本体）：line start / stop / list / overlap / check-deps / recover（scripts/lines/line-run.js、line-proc.js、line.js）
 * 入口是同目录的 verify-lines-run.js（独立监督进程：超时杀进程树并非零退出）；本文件不要直接当入口跑。
 *
 * 全部在测试自建的临时 git 仓库里执行：os.tmpdir() 下建「中文 + 空格」目录，内含「主工作区」仓库（main 分支，替身 wbs-server/server.js）、线目录根、控制根。
 * 绝不启动真实仓库的 server.js；不读真实 .env、不开业务库；不碰 3000。
 * 端口（H1-B）：不再用真实线的槽位端口 3100 / 3200 / 3300，而是开头在 50060–65535 内随机取候选并探测可绑定（不用 listen(0)：静态守卫 verify-no-listen-zero 禁止），选出三个互不相同、不在 20000–49999（别的 FAMILY 成员随机监听用的段）、不是 3000 / 3100 / 3200 / 3300 的测试端口 TP，
 *   进程内经 state.js 的 setSlotPortsForTest(TP) 设为当前端口表，CLI 调用（rootsOf）追加 --slot-ports，建线工作进程经 spec 带同一张表；套件里所有端口断言的期望值都是 TP 变量，不取自被测输出。
 *   第 0 节核的是 TP 空闲（被占用即判红并报占用进程，不杀）。
 * 两种运行模式（H1-B 修复批 1，主会话裁定 MED-1=b）：
 *   缺省（FAMILY 与日常）：不碰真实槽位端口 3100 / 3200——整套期间不在它们上面起任何监听。理由：占位要持有整套几分钟，这期间任一真实线 line start 会因 LINE_PORT_BUSY 被挡
 *     （监听者是别的检出里的自检进程），S9 H1 要消除的「自检与真实线互相影响」就被反过来了。FAMILY 期间真实线占着槽位端口本身就是天然的零串扰回归（S10 演练正是这个形态）。
 *   --zero-crosstalk（显式开关，由监督进程原样传给套件）：零串扰回归。套件开头在真实槽位端口 3100 / 3200 上起占位监听（0.0.0.0）并持有到 Z 节，整套仍全绿，证明真实线占着槽位端口时自检不再误判。
 *     每个端口的结果分三类：占位成功（Z 节核在位与关闭）／端口上已有 LISTENING 监听者（真实占用，证明成立，记 PID，不强占）／绑定失败但没有监听者（动态端口段 1024–15000 内，端口可能被当作
 *     客户端源端口或处于 TIME_WAIT：这一轮对该端口什么都没证明）——后者短重试（最多 5 次、间隔 200ms），仍失败就在 0.ph0 判红，并在汇总前打出「零串扰未证明：端口 X」。
 *     入口时记下的外部监听者只是入口时刻的快照（真实线可能中途停掉）：每节结束与 Z 节都重查，监听者消失或 netstat 查询失败 → 该端口改记未证明，Z.1d 判红（原因写明入口 PID 与失效时点）；自持占位则全程由本进程持有（Z.1b）。
 * 替身 server.js：读 .sdh-instance 与 PORT，/api/version 返回 { mode:'isolated', instance, external:'stub', background:'off', commit }；
 *   行为由环境变量 STUB_CONTROL 指向的 JSON 文件控制（延迟就绪 / 永不就绪 / 退出 / 实例冒名 / 不响应 / 非 JSON），启动时把收到的环境变量名、PORT、SDH_INSTANCE、PID 写进日志供断言。
 * 清理与复制不用 fs.rmSync / fs.cpSync（Node v24 对中文路径不可靠）：逐项 unlinkSync / rmdirSync，链接只拆不跟随，残留判红。
 * 进程回收：测试里自己起的每个进程（线服务、诱饵、占端口者、建线工作进程）都按「PID + 精确创建时间（CIM，与被测代码同口径）」登记（测试侧独立实现；PID 复用的新身份照样登记，查询失败判红），
 *   每节在 finally 里回收（终止前复核身份、终止失败的记录保留到最终清理并报告）；终止与身份核对在**同一个 PowerShell 进程**里完成（Get-Process → 访问 .Handle 钉住 PID → CIM 核精确创建时间 → taskkill /T /F，检查退出码）；
 *   PowerShell 查询用终止型错误 + try/catch，只有明确「找不到该进程」才判不存在，其余是查询失败（保留记录并报告）；本节进程与测试端口没收净时停止后续节。
 *   另有一份独立于套件存活的进程登记文件（环境变量 S2C_TEST_REGISTRY，由监督进程创建并验证）：套件登记的进程与替身服务自己（启动时用 CIM 取自己的精确创建时间再写；取不到、写不进去就在派生任何长寿子进程前退出）都往里追加；
 *   套件的登记写入失败直接判红。套件超时 / 异常时监督进程按这份登记逐个按身份终止（含中间启动器已退出的 detached 服务）。
 *
 * 收口小批（U3=A，不再送 codex）增量：2.12i/2.12j 终止脚本里 Get-Process 查询失败 ≠ 不存在；8.1a2/8.1a3/8.1g 人工恢复指引是一条现成的同句柄命令（可直接执行）、不教裸 PID 终止；
 *   8.2a/8.2c 信号改在状态锁补丁返回之后由 setImmediate 发出；T.12e 人工恢复命令的 .Handle 先于 taskkill。监督进程侧的 F / G / H 自检见 lines-test-supervisor.js 头注释。
 *
 * 覆盖：
 *   0 测试端口选定 / 空闲 / 零串扰占位（--zero-crosstalk）   H 依赖指纹口径（H2，纯文件夹具，不占端口）   1 start   2 stop    3 删线联动    4 list / overlap / check-deps    5 recover    6 修复批 1 加固    7 修复批 2 加固（不起服务）    8 修复批 2 加固（起服务）    T 测试基础设施自检    9 CLI
 *
 * 运行（经监督进程）：node E:/tmp/wt-s2c/wbs-server/scripts/verify-lines-run.js [--lines-dir=<被测 scripts/lines 目录的绝对路径>] [--only=1,5] [--skip-selftest] [--zero-crosstalk]
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { execFileSync, spawn, spawnSync } = require('child_process');

const argOf = (prefix) => process.argv.find((a) => a.startsWith(prefix));
const LINES_DIR_ARG = argOf('--lines-dir=');
const LINES_DIR = path.resolve(LINES_DIR_ARG ? LINES_DIR_ARG.slice('--lines-dir='.length) : path.join(__dirname, '..', '..', 'scripts', 'lines'));
const ONLY_ARG = argOf('--only=');
const ONLY = ONLY_ARG ? new Set(ONLY_ARG.slice('--only='.length).split(',').map((s) => s.trim())) : null;
/** 零串扰回归开关（见头注释「两种运行模式」）：不带时整套不碰真实槽位端口 3100 / 3200。 */
const ZERO_XTALK = process.argv.includes('--zero-crosstalk');
const WORKER_ARG = argOf('--worker=');
const HANG_ARG = argOf('--hang-fixture=');
const DETACH_ARG = argOf('--detach-fixture=');
const lib = (n) => require(path.join(LINES_DIR, n));
/**
 * 独立于套件存活的进程登记文件（监督进程创建并验证；没经监督进程直接跑套件时为空，不登记）。每行一个 JSON：{ pid, start }，start = CIM 精确创建时间（与 line-proc 同口径）。
 * 登记写入失败直接判红（不吞）：登记通道失效意味着监督进程回收不到 detached 服务。REG.file 可变仅为节 T 把它临时指向坏路径做自检。
 */
const REG = { file: process.env.S2C_TEST_REGISTRY || null };
function regAppend(obj) {
    if (!REG.file) return;
    try { fs.appendFileSync(REG.file, `${JSON.stringify(obj)}\n`); } catch (e) { check(`登记通道写入失败（${obj && obj.pid}）：监督进程将回收不到该进程`, false, e && e.message); }
}
/**
 * 替身与它的长寿子进程 / detach 夹具服务启动时执行的自登记函数（toString 后以源码形式嵌入）：用 CIM 取**自己的精确创建时间**（与 line-proc 同口径）再追加到登记文件；
 * 取不到创建时间、写不进登记文件都在派生任何长寿子进程之前以退出码 86 退出（让启动方看到「提前退出」，套件判红）。没有环境变量 S2C_TEST_REGISTRY 时什么都不做。
 */
function selfRegisterMain() {
    const reg = process.env.S2C_TEST_REGISTRY;
    if (!reg) return;
    const bail = (why) => { try { console.error(`SELF_REGISTER_FAILED: ${why}`); } catch (_e) { /* */ } process.exit(86); };
    let start = null;
    try {
        const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${process.pid}" -ErrorAction Stop\nif ($null -eq $p) { exit 3 }\n[Console]::Out.Write($p.CreationDate.ToUniversalTime().ToString("o"))`;
        const enc = Buffer.from(script, 'utf16le').toString('base64');
        const r = require('child_process').spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
        const t = String(r.stdout || '').trim();
        if (r.error || r.status !== 0 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/.test(t)) bail(`CIM 取创建时间失败：退出码 ${r.status}`);
        start = t;
    } catch (e) { bail(`CIM 取创建时间失败：${e && e.message}`); }
    try { require('fs').appendFileSync(reg, `${JSON.stringify({ pid: process.pid, start })}\n`); } catch (e) { bail(`登记写入失败：${e && e.message}`); }
}
const SELF_REGISTER_SRC = `(${selfRegisterMain.toString()})();`;

// ---------------------------------------------------------------- 受控挂起夹具（监督进程自检用）
if (HANG_ARG) {
    // 夹具主体在共享监督进程模块里（起孙进程、把自己与孙进程的 CIM 精确创建时间写进 pid 文件、同步阻塞）：自检清理只认这份原身份
    require('./lines-test-supervisor.js').runHangFixture(HANG_ARG.slice('--hang-fixture='.length));
}
// 「中间启动器退出、detached 服务存活、套件同步挂起」夹具：启动器起一个 detached 服务（服务自登记并把自己的 PID 写进 pid 文件）后立刻退出，套件随即同步挂起。
if (DETACH_ARG) {
    const pidFile = DETACH_ARG.slice('--detach-fixture='.length);
    const serviceSrc = `${SELF_REGISTER_SRC} require('fs').writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ service: process.pid })); setInterval(function(){}, 1000);`;
    const launcherSrc = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(serviceSrc)}], { detached: true, stdio: 'ignore', windowsHide: true }).unref();`;
    spawn(process.execPath, ['-e', launcherSrc], { stdio: 'ignore', windowsHide: true });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2147483647);
    process.exit(0);
}

const C = lib('line-common.js');
const S = lib('state.js');
const N = lib('line-new.js');
const R = lib('line-remove.js');
const RUN = lib('line-run.js');
const PR = lib('line-proc.js');
const L = lib('line.js');
const WBS = path.join(C.REPO_ROOT, 'wbs-server');
const sqlite3 = require(path.join(WBS, 'node_modules', 'sqlite3'));
const instanceDb = require(path.join(WBS, 'utils', 'instance-db.js'));
const aes = require(path.join(WBS, 'utils', 'aes-password.js'));
const SELF_CHECKOUT_ROOT = path.join(__dirname, '..', '..');
/**
 * 生产缺省槽位端口：用于两件事——「选端口时要避开的值」（三个都避开）与 --zero-crosstalk 模式下的占位监听（入口取前两项 3100 / 3200，槽位 3 不起服务所以不占位）；套件其余部分一律用测试端口 TP。
 * 不带 --zero-crosstalk 时这张表只用来避开，整套不碰这些端口。
 */
const REAL_SLOT_PORTS = Object.freeze([3100, 3200, 3300]);
/** 本次运行选定的测试端口 [槽位 1, 槽位 2, 槽位 3]（入口 main 分支开头由 pickTestPorts 填充并设为进程内端口表；工作进程从 spec 里取）。 */
let TP = [0, 0, 0];
/** 选端口失败的原因（成功为 null）；第 0 节据此判红。 */
let TP_ERR = null;
/**
 * 零串扰占位（只在 --zero-crosstalk 下使用；入口里创建，Z 节关闭）。两类「证明来源」要分清：
 *   自持占位 PLACEHOLDERS = { port, server }：本进程自己持有，全程在位（Z.1b 末尾复核）；
 *   入口占用快照 PH_SKIPPED = { port, owners }：入口时端口上已有外部 LISTENING 监听者而没占位——这只是入口时刻的快照，监听者随时可能消失（例如真实线中途停掉），
 *     所以每节结束与 Z 节都要重查（recheckEntryListeners）：不再被监听或查询失败 → 移出 PH_SKIPPED、记入 PH_UNPROVEN（Z 节判红）。
 * PH_UNPROVEN = { port, reason }：这一轮对该端口什么都没证明（入口绑定失败又查不到监听者、netstat 失败，或入口快照里的监听者中途消失），0.ph0 / Z.1d 判红。
 * PH_ENTRY_PORTS = 入口时记入 PH_SKIPPED 的端口（不随后续移出而变），Z.1d 据此逐端口断言。
 */
const PLACEHOLDERS = [];
const PH_SKIPPED = [];
const PH_UNPROVEN = [];
const PH_ENTRY_PORTS = [];
/** 占位重试：最多 5 次尝试、相邻两次间隔 200ms。 */
const PH_ATTEMPTS = 5;
const PH_RETRY_MS = 200;
/** 20000–49999 是别的 FAMILY 成员（listen-safe-port.js）随机监听用的段，测试端口不得落在其中。 */
const PORT_BAND = Object.freeze({ low: 20000, high: 49999 });
/**
 * 候选端口来源：50060–65535 内随机取一个。为什么不用 listen(0) 让系统分配：wbs-server/scripts 下有静态守卫 verify-no-listen-zero（PROJECT_STATUS #95）禁止 listen(0) / listen({ port: 0 })——
 *   本机动态端口段内的系统分配会偶发落进 Fetch 禁用名单（6666 / 10080 等，undici 报 bad port）。50060 起：高于禁用名单最大端口 10080、高于本机动态端口段、高于管理排除段 50000–50059、
 *   且在 listenOnSafePort 的 20000–49999 之外（那一段是别的 FAMILY 成员随机监听用的，与之撞上会互相误判）。
 */
function randomCandidatePort() { return crypto.randomInt(50060, 65536); }
/** 候选端口的绑定探测：在 127.0.0.1 与 0.0.0.0 上各绑一次再关闭（指定端口，不是 listen(0)）；EADDRINUSE / EACCES（已被占用 / 管理排除段）→ false，其余错误原样抛出。 */
async function probeBindable(port) {
    for (const host of ['127.0.0.1', '0.0.0.0']) {
        const srv = net.createServer();
        const err = await new Promise((resolve) => { srv.once('error', (e) => resolve(e)); srv.listen({ port, host }, () => resolve(null)); });
        if (err !== null) { if (err.code === 'EADDRINUSE' || err.code === 'EACCES') return false; throw err; }
        await new Promise((resolve) => srv.close(resolve));
    }
    return true;
}
/**
 * 选三个测试端口：反复取候选，留下满足条件的（1024–65535、不在 20000–49999、不是 3000 / 3100 / 3200 / 3300、与已选的不同、探测可绑定、且与第 0 节同口径空闲）；最多 attempts 次，取不到返回 null（调用方判红，不重试到无限）。
 * 两道空闲检查各管一类：probe（绑 127.0.0.1 与 0.0.0.0）挡「同地址已被占用」；free（portFreeI：netstat 看全部地址与双栈的 LISTENING）挡「127.0.0.1 以外的具体地址或仅 IPv6 的监听者」——
 *   Windows 上通配地址与具体地址互不冲突（H1-B 修复批 1 实测：先 0.0.0.0 再 127.0.0.2 绑定成功，先 127.0.0.2 再 0.0.0.0 也成功），这类监听者 probe 看不见，却会让第 0 节判红。
 * next / probe / free 仅供测试（节 T 里注入固定候选序列、恒真探测与空闲判定）：缺省 randomCandidatePort / probeBindable / portFreeI。
 * 残余（登记，不处理）：①探测到正式使用之间、乃至运行途中，端口可能被别的程序抢走——第 0 节只在节开头再核一次空闲，挡不住运行中途；②同一台机器上同时跑两份本套件时，两份各自随机取端口，撞号概率约 3×3/15476 ≈ 0.06%
 *   （候选池 50060–65535 共 15476 个）；撞上时后起的一份在第 0 节判红（占用者是另一份套件的监听）或在节内 EADDRINUSE，重跑即可。
 * 候选落在 50060 以上：高于本机动态端口段，别的程序的客户端连接以它为源端口的可能性远低于此前的 3100–3300（该段在动态端口段内，见 portFreeI 注释）。
 */
async function pickTestPorts(attempts, next, probe, free) {
    const get = next || randomCandidatePort;
    const can = probe || probeBindable;
    const idle = free || portFreeI;
    const picked = [];
    for (let i = 0; i < attempts && picked.length < 3; i += 1) {
        const p = await get();
        const ok = Number.isInteger(p) && p >= 1024 && p <= 65535 && !(p >= PORT_BAND.low && p <= PORT_BAND.high) && p !== 3000 && !REAL_SLOT_PORTS.includes(p) && !picked.includes(p);
        if (ok && await can(p) && await idle(p)) picked.push(p);
    }
    return picked.length === 3 ? picked : null;
}
/** 占位监听一次绑定尝试：0.0.0.0 上监听（连入立即断开）；成功返回 { server }，失败返回 { code }。 */
async function bindPlaceholder(port) {
    const server = net.createServer((sock) => { sock.on('error', () => {}); sock.destroy(); });
    const err = await new Promise((resolve) => { server.once('error', (e) => resolve(e)); server.listen({ port, host: '0.0.0.0' }, () => resolve(null)); });
    return err === null ? { server } : { code: (err && (err.code || err.message)) || 'UNKNOWN' };
}
/**
 * 零串扰占位（--zero-crosstalk）：对每个端口最多尝试 attempts 次（相邻两次间隔 200ms），每次先看有没有 LISTENING 监听者：
 *   有 → skipped（真实占用，证明成立，记 owners，不强占）；netstat 失败 → 记原因、重试；没有 → 尝试绑定，成功 → placed；失败后再查一次监听者（有 → skipped），没有 → 记「绑定失败又无监听者」、重试。
 * 用尽次数仍无结果 → unproven（这一轮对该端口什么都没证明）。hooks 仅供测试：{ listeners(port) → PID 数组 | null, bind(port) → { server } | { code }, sleep(ms), attempts }。
 */
async function placeZeroCrosstalk(ports, hooks) {
    const h = hooks || {};
    const ownersOf = h.listeners || listenersStrict;
    const bind = h.bind || bindPlaceholder;
    const nap = h.sleep || sleep;
    const attempts = h.attempts || PH_ATTEMPTS;
    const out = { placed: [], skipped: [], unproven: [] };
    for (const port of ports) {
        let reason = '';
        let settled = false;
        for (let i = 1; i <= attempts && !settled; i += 1) {
            const own = ownersOf(port);
            if (Array.isArray(own) && own.length > 0) { out.skipped.push({ port, owners: own }); settled = true; }
            else if (own === null) reason = 'netstat 失败，无法确认端口上有没有监听者';
            else {
                const r = await bind(port);
                if (r.server) { out.placed.push({ port, server: r.server }); settled = true; }
                else {
                    const own2 = ownersOf(port);
                    if (Array.isArray(own2) && own2.length > 0) { out.skipped.push({ port, owners: own2 }); settled = true; }
                    else reason = `绑定失败（${r.code}）但端口上没有 LISTENING 监听者${own2 === null ? '（复查时 netstat 失败）' : '（疑似客户端源端口 / TIME_WAIT）'}`;
                }
            }
            if (!settled && i < attempts) await nap(PH_RETRY_MS);
        }
        if (!settled) out.unproven.push({ port, reason: `${reason}；已尝试 ${attempts} 次` });
    }
    return out;
}
/** 某真实槽位端口的零串扰是否「证明成立」：占位成功，或端口上有真实监听者（skipped 且 owners 非空）；unproven 不算。0.ph0 逐端口断言用它。 */
function zeroXtalkProven(port, st) {
    return st.placed.some((p) => p.port === port) || st.skipped.some((s) => s.port === port && s.owners.length > 0);
}
/**
 * 复核入口占用快照（M1）：对 skipped 里每个端口重查 LISTENING 监听者——仍有 → 保留；没有了 / netstat 查询失败 → 从 skipped 移出、记入 unproven（原因写明入口时的 PID 与失效的时点）。
 * afterId = 刚结束的节号（'Z' = 收尾时）。返回本次失效的 [{ port, reason }]（调用方立刻打印）。hooks.listeners 仅供测试。
 */
function recheckEntryListeners(skipped, unproven, afterId, hooks) {
    const ownersOf = (hooks && hooks.listeners) || listenersStrict;
    const when = afterId === 'Z' ? 'Z 节收尾时' : `第 ${afterId} 节后`;
    const lost = [];
    for (let i = 0; i < skipped.length;) {
        const s = skipped[i];
        const now = ownersOf(s.port);
        if (Array.isArray(now) && now.length > 0) { i += 1; continue; }
        const reason = `入口时有监听者 PID ${s.owners.join('、')}，${when}${now === null ? '复核时 netstat 查询失败' : '不再监听'}`;
        skipped.splice(i, 1);
        unproven.push({ port: s.port, reason });
        lost.push({ port: s.port, reason });
    }
    return lost;
}
/** 复核入口占用快照并把失效的立刻打到输出里（节循环边界与 Z 节调用）。 */
function recheckEntryAndLog(afterId) {
    for (const l of recheckEntryListeners(PH_SKIPPED, PH_UNPROVEN, afterId)) log(`  零串扰未证明：端口 ${l.port}（${l.reason}）`);
}
/** 夹具端口候选的有界尝试次数（M2）：超限即取不到夹具端口，调用方判红并写明原因，不无限重选。 */
const FIXTURE_TRIES = 20;
/**
 * 取一个自测夹具要用的端口（M2）：候选先过与 pickTestPorts 同口径的空闲前置检查（probeBindable + portFreeI），再（可选）真正建立夹具（occupy 绑定），
 *   绑定遇 EADDRINUSE / EACCES（探测之后被抢、管理排除段）就换候选；其余绑定错误不重试直接报。最多 tries 次候选，用尽返回 { ok:false, reason }（原因含次数与前几个被拒候选及理由）。
 * 为什么需要：夹具直接取 randomCandidatePort 的未筛选候选，撞上本来就有的监听者会让「被测断言」误报红——与已登记的「探测后被抢」竞态无关。
 * hooks（仅供测试注入）：next / probe / free / occupy(port) → { handle, err } / exclude（不得取的端口）/ tries。成功返回 { ok:true, port, handle, tries, rejected }。
 */
async function acquireFixture(hooks) {
    const h = hooks || {};
    const next = h.next || randomCandidatePort;
    const probe = h.probe || probeBindable;
    const free = h.free || portFreeI;
    const tries = h.tries || FIXTURE_TRIES;
    const exclude = h.exclude || [];
    const rejected = [];
    for (let i = 1; i <= tries; i += 1) {
        const p = await next();
        if (!Number.isInteger(p) || p < 1024 || p > 65535 || exclude.includes(p)) { rejected.push(`${p}（不合格或重复）`); continue; }
        if (!(await probe(p))) { rejected.push(`${p}（探测不可绑定）`); continue; }
        if (!(await free(p))) { rejected.push(`${p}（端口上已有 LISTENING 监听者）`); continue; }
        if (!h.occupy) return { ok: true, port: p, handle: null, tries: i, rejected };
        const o = await h.occupy(p);
        if (o.err) {
            if (o.err.code === 'EADDRINUSE' || o.err.code === 'EACCES') { rejected.push(`${p}（夹具绑定失败 ${o.err.code}）`); continue; }
            return { ok: false, reason: `夹具在端口 ${p} 上绑定出错（不是占用类错误，不重试）：${o.err.code || o.err.message}`, rejected };
        }
        return { ok: true, port: p, handle: o.handle, tries: i, rejected };
    }
    return { ok: false, reason: `${tries} 次候选都不能用作夹具端口（被拒：${rejected.slice(0, 5).join('；')}${rejected.length > 5 ? '…' : ''}）`, rejected };
}

// ================================================================ 断言、输出语料与汇总

let PASS = 0;
let FAIL = 0;
const FAILS = [];
const ALL_OUT = [];
const log = (s) => { const t = String(s); console.log(t); ALL_OUT.push(t); };
let SINK = null;   // 测试基础设施自检（节 T）时临时接管失败：不计入 FAIL，收集起来供自检断言
function check(name, cond, detail) {
    if (cond) { PASS += 1; return; }
    if (SINK !== null) { SINK.push(name); return; }
    FAIL += 1;
    FAILS.push(name);
    log(`  FAIL  ${name}${detail === undefined ? '' : `  -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
}
const section = (id, title) => log(`\n=== ${id} ${title}`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const w = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const rd = (file) => fs.readFileSync(file, 'utf8');
const git = (cwd, args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 60000 });
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// ================================================================ 测试侧独立的进程助手（不依赖被测的 line-proc.js，变异不会影响回收）

const FAULT = { ps: false, psPrelude: '' };   // 仅节 T 的基础设施自检用：ps = 让 ownStartTime 抛错；psPrelude = 拼进测试侧 PowerShell 脚本开头（遮蔽 Get-Process / Get-CimInstance 制造查询失败）
function psRun(script) {
    const full = [FAULT.psPrelude, script].join('\n');
    const enc = Buffer.from(full, 'utf16le').toString('base64');
    return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
}
/** 取不到进程对象时的统一处理（脚本片段）：只有 NoProcessFoundForGivenId（明确「找不到该进程」）才退出码 3，其余一律 4（查询失败）。 */
const GET_PROC = (pid) => `try { $p = Get-Process -Id ${pid} -ErrorAction Stop } catch { if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*') { exit 3 } else { [Console]::Error.Write($_.Exception.Message); exit 4 } }`;
const ISO_RE_I = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/;
/**
 * 独立实现（不依赖被测的 line-proc.js）：CIM CreationDate 的精确创建时间（与登记同口径）。进程不存在（明确「找不到该进程」，或 CIM 查不到且进程已退出）返回 null；
 * 查询本身失败（PowerShell 起不来 / 超时 / Get-Process 或 CIM 报错 / CIM 查不到但进程仍存活 / 输出非法）抛异常（调用方判红，不当成「进程不存在」）。
 */
function ownStartTime(pid) {
    if (FAULT.ps) throw new Error('injected ownStartTime failure');
    const r = psRun([
        GET_PROC(pid),
        `try { $c = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction Stop } catch { [Console]::Error.Write($_.Exception.Message); exit 4 }`,
        'if ($null -eq $c) { if ($p.HasExited) { exit 3 } else { [Console]::Error.Write("CIM 查不到该进程，但进程仍存活"); exit 4 } }',
        '[Console]::Out.Write($c.CreationDate.ToUniversalTime().ToString("o"))',
    ].join('\n'));
    if (r.error) throw new Error(`查询进程 ${pid} 失败：${r.error.message}`);
    if (r.status === 3) return null;
    const text = String(r.stdout || '').trim();
    if (r.status !== 0 || !ISO_RE_I.test(text)) throw new Error(`查询进程 ${pid} 失败：退出码 ${r.status}，输出 ${JSON.stringify(text.slice(0, 100))}，stderr ${JSON.stringify(String(r.stderr || '').replace(/#< CLIXML[\s\S]*$/, '').trim().slice(0, 150))}`);
    return text;
}
/** 另一个独立来源：Get-Process 的 StartTime（.NET，100ns FILETIME），与被测的 CIM CreationDate 不同源（末位可差 100ns）。只用于 1.7 的交叉核对。 */
function ownStartTimePs(pid) {
    const r = psRun(`$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue\nif ($null -eq $p) { exit 3 }\n[Console]::Out.Write($p.StartTime.ToUniversalTime().ToString("o"))`);
    if (r.error) throw new Error(`Get-Process 查询 ${pid} 失败：${r.error.message}`);
    if (r.status === 3) return null;
    const text = String(r.stdout || '').trim();
    if (r.status !== 0 || !ISO_RE_I.test(text)) throw new Error(`Get-Process 查询 ${pid} 失败：退出码 ${r.status}`);
    return text;
}
const aliveI = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); } };
async function waitDead(pid, ms) {
    const end = Date.now() + ms;
    while (aliveI(pid)) { if (Date.now() > end) return false; await sleep(100); }
    return true;
}
const killTreeI = (pid) => spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 30000, stdio: 'ignore' });
/** 端口上 LISTENING 的 PID（IPv4 与 IPv6 两个协议栈；netstat 不带 -p）。netstat 失败返回 null。 */
function listenersStrict(port) {
    const r = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
    if (r.status !== 0 || !r.stdout) return null;
    const pids = new Set();
    for (const line of String(r.stdout).split(/\r?\n/)) {
        const m = line.trim().split(/\s+/);
        if (m.length >= 5 && m[0].toUpperCase() === 'TCP' && /^LISTENING$/i.test(m[3]) && m[1].endsWith(`:${port}`)) pids.add(Number(m[4]));
    }
    return Array.from(pids);
}
const listenersOn = (port) => listenersStrict(port) || [];
/**
 * 端口上没有监听者 = netstat 成功，且 IPv4 / IPv6 两个协议栈上都没有该端口的 LISTENING；netstat 失败按「占用」处理。
 * 不用「0.0.0.0 独占绑定能否成功」判断，2026-10-16 实测它两头都错：
 *   - 漏判：另一个进程监听默认 host（双栈 ::）或 127.0.0.1 时，0.0.0.0 独占绑定照样成功；
 *   - 误判：本机 TCP 临时端口范围从 1024 起（netsh int ipv4 show dynamicport tcp），槽位端口 3100–3300 落在其中，
 *     别的程序的客户端连接偶尔以槽位端口为源端口，绑定报 EADDRINUSE 而端口上并没有监听者（当天 FAMILY 里 Z.1 判红的实例）。
 */
async function portFreeI(port) {
    const l = listenersStrict(port);
    return Array.isArray(l) && l.length === 0;
}
/**
 * 占端口夹具被终止后，等到该端口真的能再绑定（最多 timeoutMs，每 200ms 探一次）。进程退出与端口可再绑定之间在 Windows 上偶有滞后：
 * 2026-10-25 带 --zero-crosstalk 的全套里 2.11a 紧跟 2.9 的占端口者之后在同一测试端口 start，报 EADDRINUSE（netstat 上已无 LISTENING），重跑即绿。返回最终是否可绑定。
 */
async function waitPortBindable(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await probeBindable(port)) return true;
        if (Date.now() >= deadline) return false;
        await sleep(200);
    }
}
function httpGetI(port, urlPath) {
    return new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: urlPath, agent: false, timeout: 4000 }, (res) => {
            let b = '';
            res.on('data', (d) => { b += d; });
            res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(b) }); } catch (_) { resolve({ status: res.statusCode, body: b }); } });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', (e) => resolve({ error: e.message }));
    });
}

/**
 * 进程登记：键 = 「PID@创建时间」。同一 PID 复用出来的新身份照样登记（不按 PID 去重）；创建时间查询失败判红（不静默忽略）。
 * 同时追加到独立于套件存活的登记文件（监督进程超时 / 异常时按它回收）。
 */
const TRACK = new Map();
const REAP_FAILED = new Map();   // 终止失败的记录：保留到最终清理并报告
const KILL = { fn: null };       // 仅节 T 的基础设施自检用：替换终止函数，模拟「终止失败」
const TRACKER = { query: null }; // 仅节 T 的基础设施自检用：替换 track 的创建时间查询（可控的登记查询替身）
const trackKey = (pid, start) => `${pid}@${start}`;
function track(pid) {
    if (!pid || !aliveI(pid)) return;
    let st;
    try { st = (TRACKER.query || ownStartTime)(pid); } catch (e) { check(`TRACK 登记进程 ${pid} 时创建时间查询失败（不能静默忽略）`, false, e.message); return; }
    if (st === null) return;
    registerEntry(pid, st);
}
/** 登记一个身份（PID + 创建时间）。同一 PID 的不同创建时间是不同身份（PID 复用），各自登记。 */
function registerEntry(pid, st) {
    const key = trackKey(pid, st);
    if (TRACK.has(key)) return;
    TRACK.set(key, { pid, start: st });
    regAppend({ pid, start: st });
}
const FIXTURES = [];
/** 被测代码起的线服务不一定被断言登记过（例如变异实现里本该被拒绝的 start 却起来了）：扫各夹具的日志，把「日志里自报的 PID 仍活着、且创建时间与日志创建时刻相差不到 10 秒」的进程补登记。 */
function trackFromLogs() {
    for (const fx of FIXTURES) {
        const dir = path.join(fx.control, 'logs');
        let names = [];
        try { names = fs.readdirSync(dir); } catch (_) { continue; }
        for (const n of names) {
            const f = path.join(dir, n);
            let txt;
            let born;
            try { txt = rd(f); born = fs.statSync(f).birthtimeMs; } catch (_) { continue; }
            for (const key of ['STUB_PID', 'STUB_CHILD_PID']) {
                const pid = pidNum(logVal(txt, key));
                if (!Number.isSafeInteger(pid) || pid <= 0 || !aliveI(pid)) continue;
                let st;
                try { st = ownStartTime(pid); } catch (e) { check(`日志补登记进程 ${pid} 时创建时间查询失败`, false, e.message); continue; }
                if (st === null || TRACK.has(trackKey(pid, st))) continue;
                if (Math.abs(Date.parse(st) - born) < 10000) { TRACK.set(trackKey(pid, st), { pid, start: st }); regAppend({ pid, start: st }); }
            }
        }
    }
}
/** 该登记项现在还活着（PID 存活且创建时间仍是登记值）？查询失败视为「仍存活」（保守，交给上层报告）。 */
function entryAlive(e) {
    if (!aliveI(e.pid)) return false;
    try { return ownStartTime(e.pid) === e.start; } catch (_) { return true; }
}
/**
 * 终止登记项的 PowerShell 脚本：同一个 PowerShell 进程里 Get-Process 取对象 → 访问 .Handle 钉住 PID → CIM 核精确创建时间 → taskkill /T /F（身份核对与终止之间不再有 PID 复用窗口）。
 * 退出码：0 已终止 / 3 进程不存在 / 4 查询失败 / 5 创建时间不符（PID 已被复用，不碰）/ 6 taskkill 失败。测试侧独立实现，不调用被测的 line-proc；导出给静态守卫（.Handle 必须出现在 taskkill 之前）。
 */
function buildKillEntryScript(e) {
    return [
        GET_PROC(e.pid),
        'try { $h = $p.Handle } catch { [Console]::Error.Write($_.Exception.Message); exit 4 }',
        'if ($null -eq $h -or $h -eq [IntPtr]::Zero) { [Console]::Error.Write("拿不到进程句柄"); exit 4 }',
        `try { $c = Get-CimInstance Win32_Process -Filter "ProcessId=${e.pid}" -ErrorAction Stop } catch { [Console]::Error.Write($_.Exception.Message); exit 4 }`,
        'if ($null -eq $c) { if ($p.HasExited) { exit 3 } else { [Console]::Error.Write("CIM 查不到该进程，但进程仍存活"); exit 4 } }',
        `if ($c.CreationDate.ToUniversalTime().ToString("o") -ne '${e.start}') { exit 5 }`,
        `& taskkill.exe /PID ${e.pid} /T /F | Out-Null`,
        'if ($LASTEXITCODE -ne 0) { exit 6 }',
        'exit 0',
    ].join('\n');
}
/** 终止登记项（同句柄核对 + 终止，检查退出码）。查询失败 / 终止失败时重试，最多 3 次；返回是否已消失（查询失败且进程仍可能活着返回 false，由上层保留记录并报告）。 */
async function killEntry(e) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const r = psRun(buildKillEntryScript(e));
        if (!r.error && (r.status === 3 || r.status === 5)) return true;   // 已不存在 / 不是登记的那个进程（PID 已被复用，不碰）
        if (!r.error && r.status === 0) {
            const end = Date.now() + 10000;
            while (Date.now() < end) { if (!entryAlive(e)) return true; await sleep(150); }
            continue;
        }
        await sleep(300);   // 查询失败（4 / 起不来 / 超时）或 taskkill 失败（6）：保留记录，稍后重试
    }
    return !entryAlive(e);
}
/** 本节收尾：核对残留（判红）→ 按身份终止 → 核对测试端口。返回是否收净（进程全退出且测试端口空闲）。 */
async function reapSection(id) {
    trackFromLogs();
    const left = [];
    for (const [key, e] of TRACK) {
        if (!aliveI(e.pid)) { TRACK.delete(key); continue; }
        if (entryAlive(e)) left.push([key, e]);
        else TRACK.delete(key);
    }
    check(`${id}.R 本节起的所有进程都已退出（无残留）`, left.length === 0, left.map(([, e]) => e.pid));
    let clean = true;
    for (const [key, e] of left) {
        if (await (KILL.fn || killEntry)(e)) TRACK.delete(key);
        else { clean = false; REAP_FAILED.set(key, e); TRACK.delete(key); check(`${id}.R2 残留进程 ${e.pid} 终止失败（保留到最终清理）`, false, e); }
    }
    if (!PORTS_BUSY) {
        for (const port of TP) {
            if (!(await portFreeI(port))) { clean = false; check(`${id}.R3 本节结束时测试端口 ${port} 仍被占用`, false, listenersOn(port)); }
        }
    }
    return clean;
}
/** 起一个自己的辅助进程（诱饵 / 占端口者），登记回收。提前退出 / 出错 / 超时都 reject 并带原因。 */
function spawnHelper(jsSource, wantStdoutLine, extraArgs) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, extraArgs ? [...extraArgs] : ['-e', jsSource], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let errText = '';
        child.stderr.on('data', (d) => { errText += d; });
        child.on('error', reject);
        track(child.pid);
        if (!wantStdoutLine) { resolve(child); return; }
        let buf = '';
        const timer = setTimeout(() => reject(new Error('辅助进程没有在 20 秒内就绪')), 20000);
        child.stdout.on('data', (d) => { buf += d; if (buf.includes(wantStdoutLine)) { clearTimeout(timer); resolve(child); } });
        child.on('exit', (code, signal) => { clearTimeout(timer); if (!buf.includes(wantStdoutLine)) reject(new Error(`辅助进程在就绪标记 ${JSON.stringify(wantStdoutLine)} 之前退出（退出码 ${code}${signal ? `，信号 ${signal}` : ''}）：${errText.trim().slice(0, 300)}`)); });
    });
}

// ================================================================ 夹具

const ALL_ROOTS = [];
let rootSeq = 0;
const FAKE_KEY = 'fake-main-key-0123456789abcdef-XYZ';
const JWT = 'fake-jwt-secret-line-test-0001';
const WEBHOOK = 'fake-webhook-secret-0006';
const UNRELATED = 'unrelated-value-12345';
const EVIL_MAIN = 'evil-main';
const REAL_DT = { dingtalk_app_key: 'REAL-DT-APPKEY-0001', dingtalk_app_secret: 'REAL-DT-SECRET-0002', dingtalk_robot_code: 'REAL-DT-ROBOT-0003', platform_base_url: 'http://real-platform.example' };
const SEVEN = {
    collab_notify_admin_on_submit: 'on', issue_lite_developer_id: '23', issue_lite_chat_owner_id: '24', issue_lite_notify_target_ids: '10,11',
    sys_notify_dry_run: 'off', sys_release_default_executor_ids: '5,6', sys_single_commit_group_systems: 'SysAlpha,SysBeta',
};
const LEAK_STRINGS = [FAKE_KEY, JWT, WEBHOOK, UNRELATED, EVIL_MAIN, ...Object.values(REAL_DT), 'SysAlpha,SysBeta'];
const DYN_SECRETS = [];
const ENV_TEXT = [`DB_ENCRYPTION_KEY=${FAKE_KEY}`, `JWT_SECRET=${JWT}`, 'SYS_FASTLANE_ENABLE=1', `SDH_INSTANCE=${EVIL_MAIN}`, 'PORT=3000', `UNRELATED_KEY=${UNRELATED}`, `WEBHOOK_SECRET=${WEBHOOK}`, 'LOG_LEVEL=DEBUG', 'NODE_ENV=production', ''].join('\n');
const SURFACE_A = 'wbs-server/routes/x.js；public/x.html';

/** 替身 server.js（提交进临时仓库，线检出里就有）。行为由 STUB_CONTROL 指向的 JSON 控制，每个请求重读。 */
const STUB_SRC = [
    "'use strict';",
    "const http = require('http'); const fs = require('fs'); const path = require('path'); const cp = require('child_process');",
    SELF_REGISTER_SRC,
    "let ident = null; try { ident = fs.readFileSync(path.join(__dirname, '.sdh-instance'), 'utf8').trim(); } catch (_) { ident = null; }",
    'const ctlFile = process.env.STUB_CONTROL;',
    "const ctl = () => { try { return JSON.parse(fs.readFileSync(ctlFile, 'utf8')); } catch (_) { return {}; } };",
    'const c0 = ctl();',
    "console.log('STUB_PID=' + process.pid);",
    "console.log('STUB_ENV_NAMES=' + JSON.stringify(Object.keys(process.env).sort()));",
    "console.log('STUB_PORT=' + process.env.PORT);",
    "console.log('STUB_SDH_INSTANCE=' + process.env.SDH_INSTANCE);",
    "console.log('STUB_CWD=' + process.cwd());",
    "console.log('STUB_LEAK=' + (c0.leak || ''));",
    'if (c0.exitNow) process.exit(c0.exitCode === undefined ? 7 : c0.exitCode);',
    'if (c0.exitAfterMs) setTimeout(() => process.exit(c0.exitCode === undefined ? 7 : c0.exitCode), c0.exitAfterMs);',
    // 长寿子进程（自登记后空转）：用来证明终止的是整棵进程树。必须 detached：libuv 把非 detached 的子进程放进带 KILL_ON_JOB_CLOSE 的作业对象，
    // 父进程一死它们就跟着死，不带 /T 的终止也「杀得掉」，测不出 /T 的作用（实测：修复批 1 变异 R3a / R3b 因此存活）；detached 的孙进程只有 /T 才收得掉
    `if (c0.spawnChild) { const g = cp.spawn(process.execPath, ['-e', ${JSON.stringify(`${SELF_REGISTER_SRC} setInterval(function(){}, 1000);`)}], { detached: true, stdio: 'ignore', windowsHide: true }); console.log('STUB_CHILD_PID=' + g.pid); }`,
    'const server = http.createServer((req, res) => {',
    '    const c = ctl();',
    "    if (req.url === '/api/version') {",
    "        if (c.countFile) { try { fs.appendFileSync(c.countFile, 'x'); } catch (_) { /* */ } }",
    // 放行文件不存在 = 还没就绪：返回 503 与 mode=booting（start 必须继续轮询）
    "        if (c.gateFile && !fs.existsSync(c.gateFile)) { res.statusCode = 503; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ mode: 'booting', instance: ident })); return; }",
    '        if (c.hang) return;',
    // 合法 JSON 但 instance 缺失 / 非字符串 / 空串（如 {} 或 {"error":"…"}）：rawJson 原样返回
    "        if (c.rawJson !== undefined) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(c.rawJson)); return; }",
    // 收到响应头后正文中断 / 挂起 / 慢吐 / 超大
    "        if (c.brokenBody) { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '200' }); res.write('{\"mode\":\"isol'); setTimeout(() => { req.socket.destroy(); }, 50); return; }",
    "        if (c.stallBody) { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '200' }); res.write('{\"mode\":'); return; }",
    "        if (c.trickle) { res.writeHead(200, { 'Content-Type': 'application/json' }); const t = setInterval(() => { try { res.write(' '); } catch (_) { clearInterval(t); } }, 200); res.on('close', () => clearInterval(t)); return; }",
    "        if (c.hugeBody) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{\"a\":\"' + 'x'.repeat(3 * 1024 * 1024) + '\"}'); return; }",
    "        res.setHeader('Content-Type', 'application/json');",
    "        if (c.badBody) { res.end('not json'); return; }",
    "        res.end(JSON.stringify({ mode: c.mode || 'isolated', instance: c.instance || ident, external: 'stub', background: 'off', commit: 'stub-commit' }));",
    '        return;',
    '    }',
    '    res.statusCode = 404; res.end("{}");',
    '});',
    "const begin = () => server.listen(Number(process.env.PORT), () => console.log('STUB_LISTENING'));",
    'if (c0.neverReady) { setInterval(function () {}, 1000); } else if (c0.delayMs) { setTimeout(begin, c0.delayMs); } else { begin(); }',
    '',
].join('\n');

const dbOpen = (file, mode) => new Promise((resolve, reject) => { const d = new sqlite3.Database(file, mode, (e) => (e ? reject(e) : resolve(d))); });
const dbRun = (d, sql, p) => new Promise((resolve, reject) => d.run(sql, p || [], function cb(e) { return e ? reject(e) : resolve(this); }));
const dbClose = (d) => new Promise((resolve) => d.close(() => resolve()));
async function makeMainDb(file, key) {
    const d = await dbOpen(file, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);
    try {
        await dbRun(d, instanceDb.SYSTEM_CONFIGS_DDL);
        const put = (k, v) => dbRun(d, 'INSERT INTO system_configs (config_key, config_value_encrypted) VALUES (?, ?)', [k, aes.encryptWithKey(key, v)]);
        for (const [k, v] of Object.entries(REAL_DT)) await put(k, v);
        for (const [k, v] of Object.entries(SEVEN)) await put(k, v);
        await dbRun(d, 'CREATE TABLE db_connections (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, host TEXT NOT NULL, "database" TEXT NOT NULL, username TEXT NOT NULL, password TEXT NOT NULL)');
        await dbRun(d, 'INSERT INTO db_connections (name, host, "database", username, password) VALUES (?, ?, ?, ?, ?)', ['ext', 'h', 'db', 'u', aes.encryptWithKey(key, 'REAL-DB-PASSWORD-0005')]);
    } finally { await dbClose(d); }
}

const PKG_ROOT = '{"name":"fixture-root","version":"1.0.0"}\n';
const PKG_WBS = '{"name":"fixture-wbs","version":"1.0.0"}\n';
const LOCK_WBS = '{\n  "name": "fixture-wbs",\n  "lockfileVersion": 3\n}\n';
const LOCK_ROOT = '{\n  "name": "fixture-root",\n  "lockfileVersion": 3\n}\n';
/** 与 PKG_WBS 相比多了一条依赖：依赖指纹口径只比依赖相关字段（H2），要造「依赖不一致」必须改依赖，改 version 不再算（节 H）。 */
const PKG_WBS_DEPCHG = '{"name":"fixture-wbs","version":"1.0.0","dependencies":{"left-pad":"1.3.0"}}\n';

/** 建「主工作区」仓库夹具：中文 + 空格路径、替身 server.js、依赖文件、主库、主 .env。返回 { root, main, lines, control, ctl }。 */
async function buildFixture(label) {
    rootSeq += 1;
    const root = path.join(os.tmpdir(), `启停 测试 ${process.pid}-${rootSeq}-${label}`);
    if (!C.isInside(os.tmpdir(), root)) throw new Error('夹具根不在系统临时目录内');
    ALL_ROOTS.push(root);
    const main = path.join(root, '主 工作区');
    const lines = path.join(root, '线 目录');
    fs.mkdirSync(main, { recursive: true });
    w(path.join(main, '.gitignore'), rd(path.join(SELF_CHECKOUT_ROOT, '.gitignore')));
    w(path.join(main, 'package.json'), PKG_ROOT);
    w(path.join(main, 'wbs-server', 'package.json'), PKG_WBS);
    w(path.join(main, 'wbs-server', 'package-lock.json'), LOCK_WBS);
    w(path.join(main, 'wbs-server', 'server.js'), STUB_SRC);
    w(path.join(main, 'wbs-server', 'hello.txt'), 'hello\n');
    w(path.join(main, 'docs', 'a.txt'), 'doc a\n');
    git(main, ['init', '-q', '-b', 'main']);
    git(main, ['add', '-A']);
    git(main, ['add', '-f', 'wbs-server/package-lock.json']);   // 真实仓库里它是被跟踪的（忽略规则里有 package-lock.json，靠强制添加进仓）
    git(main, ['commit', '-q', '-m', 'init']);
    w(path.join(main, 'node_modules', 'sentinel.txt'), 'NM-ROOT');
    w(path.join(main, 'wbs-server', 'node_modules', 'sentinel.txt'), 'NM-WBS');
    w(path.join(main, 'package-lock.json'), LOCK_ROOT);   // 根锁文件：不受 git 跟踪（被忽略规则覆盖），只在主工作区有
    w(path.join(main, 'wbs-server', '.env'), ENV_TEXT);
    await makeMainDb(path.join(main, 'wbs-server', 'task_pool.db'), FAKE_KEY);
    const ctl = path.join(root, 'stub-control.json');
    w(ctl, '{}');
    const fx = { root, main, lines, control: path.join(main, 'docs', 'local', '多线并行', '_state'), ctl };
    FIXTURES.push(fx);
    return fx;
}
function setCtl(fx, obj) { const tmp = `${fx.ctl}.tmp`; fs.writeFileSync(tmp, JSON.stringify(obj)); fs.renameSync(tmp, fx.ctl); }

function removeTree(dir) {
    const left = [];
    const walk = (p) => {
        let st;
        try { st = fs.lstatSync(p); } catch (e) { if (e && e.code === 'ENOENT') return; left.push(p); return; }
        if (st.isSymbolicLink()) { try { fs.rmdirSync(p); } catch (_) { try { fs.unlinkSync(p); } catch (_e) { left.push(p); } } return; }
        if (st.isDirectory()) {
            let names = [];
            try { names = fs.readdirSync(p); } catch (_) { left.push(p); return; }
            for (const n of names) walk(path.join(p, n));
            try { fs.rmdirSync(p); } catch (_) { left.push(p); }
            return;
        }
        try { fs.unlinkSync(p); } catch (_) { try { fs.chmodSync(p, 0o666); fs.unlinkSync(p); } catch (_e) { left.push(p); } }
    };
    walk(dir);
    return left;
}

const ctxOf = (fx, outLines, extra) => Object.assign({ mainRoot: fx.main, controlRoot: fx.control, linesRoot: fx.lines, out: (s) => { outLines.push(String(s)); ALL_OUT.push(String(s)); }, readyTimeoutMs: 60000, pollIntervalMs: 100 }, extra || {});
async function attempt(fn) {
    try { return { res: await fn(), err: null }; } catch (e) { ALL_OUT.push(String(e && e.message)); return { res: null, err: e || new Error('空异常') }; }
}
const regOf = (fx) => S.readState(fx.control);
const wtOf = (fx, name) => path.join(fx.lines, name);
const newArgs = (name, mod, extra) => Object.assign({ name, module: mod || 'mod-x', surface: SURFACE_A }, extra || {});
const hasLine = (lines, text) => lines.some((l) => l.includes(text));

// 父进程环境里的污染：SDH_*（含小写）、不同写法的 PORT（Port：Windows 上环境变量名不分大小写，真实父进程可能是任一写法）、会盖过线 .env 的同名变量、禁拷键
const EVIL_ENV = {
    SDH_INSTANCE: 'evil-parent', SDH_DB_FILE: 'X:\\evil\\evil.db', sdh_external: 'real', SDH_BACKGROUND_JOBS: 'on', Port: '9',
    JWT_SECRET: 'evil-parent-jwt-secret', LOG_LEVEL: 'evil-parent-level', DB_ENCRYPTION_KEY: 'evil-parent-enc-key', WEBHOOK_SECRET: 'evil-parent-webhook', SYS_TEST_HOOKS: '1',
};
/** 线检出里 wbs-server/.env 定义的键名（测试侧独立解析：KEY=… 行）。 */
function lineEnvKeys(wt) {
    let txt = '';
    try { txt = rd(path.join(wt, 'wbs-server', '.env')); } catch (_) { return []; }
    return txt.split(/\r?\n/).map((l) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(l)).filter(Boolean).map((m) => m[1]);
}
/** 在设了 STUB_CONTROL（及可选的污染环境）的进程环境下运行 fn；结束后还原。start 会把当前进程环境传给子进程。 */
async function withEnv(fx, polluted, fn) {
    const saved = new Map();
    const set = (k, v) => { if (!saved.has(k)) saved.set(k, Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined); process.env[k] = v; };
    set('STUB_CONTROL', fx.ctl);
    if (polluted) for (const [k, v] of Object.entries(EVIL_ENV)) set(k, v);
    try { return await fn(); } finally {
        for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
}
const startLine = (fx, name, polluted, extra, outLines) => withEnv(fx, polluted, () => attempt(() => RUN.lineStart(ctxOf(fx, outLines || [], extra), { name })));
const stopLine = (fx, name, extra, outLines) => attempt(() => RUN.lineStop(ctxOf(fx, outLines || [], extra), { name }));
const newLine = (fx, name, mod, extra) => attempt(() => N.lineNew(ctxOf(fx, [], null), newArgs(name, mod, extra)));
const removeLine = (fx, name, args, outLines) => attempt(() => R.lineRemove(ctxOf(fx, outLines || [], null), Object.assign({ name }, args || {})));
const logsOf = (fx) => { try { return fs.readdirSync(path.join(fx.control, 'logs')).sort(); } catch (_) { return []; } };
/** 日志里读到的 PID 文本 → 数字；日志里没有这一行（替身还没来得及打印就被收掉了）返回 NaN（Number(null) 会得到 0，waitDead(0) 永远等不到）。 */
const pidNum = (v) => { const n = v === null ? NaN : Number(v); return Number.isSafeInteger(n) && n > 0 ? n : NaN; };
const logVal = (text, key) => { const m = new RegExp(`^${key}=(.*)$`, 'm').exec(text); return m ? m[1].replace(/\r$/, '') : null; };
const newestLog = (fx, before) => { const fresh = logsOf(fx).filter((f) => !before.includes(f)); return fresh.length ? path.join(fx.control, 'logs', fresh[fresh.length - 1]) : null; };

function runCli(args, env) {
    const r = spawnSync(process.execPath, [path.join(LINES_DIR, 'line.js'), ...args], { encoding: 'utf8', timeout: 240000, windowsHide: true, env: env || process.env });
    ALL_OUT.push(r.stdout || '', r.stderr || '');
    return r;
}
/** CLI 的三个根覆盖参数 + 测试端口表（--slot-ports 只在三个根全给时被接受；漏传则 CLI 子进程按生产缺省 3100 分配 / 校验，与进程内的测试表对不上）。 */
const rootsOf = (fx) => ['--control-root', fx.control, '--lines-root', fx.lines, '--main-root', fx.main, '--slot-ports', TP.join(',')];

const FAKE_START = '2001-02-03T04:05:06.0000000Z';
/** 经 line-proc 的 _test.psPrelude 注入：同名函数遮蔽 Get-CimInstance。FAIL = 报非终止错误（真实场景里 WMI 出毛病的样子）；EMPTY = 静默返回空。 */
const FAIL_CIM_FN = "function Get-CimInstance { [CmdletBinding()] param([Parameter(Position=0)]$ClassName, $Filter) Write-Error 'injected CIM failure' }";
const EMPTY_CIM_FN = 'function Get-CimInstance { [CmdletBinding()] param([Parameter(Position=0)]$ClassName, $Filter) }';
/** 经 line-proc 的 _test.psPrelude 注入：同名函数遮蔽 Get-Process。FAIL = 报「非找不到该进程」的错误（Write-Error，-ErrorAction Stop 下成为终止型错误）；EMPTY = 静默返回空（没有对象也没有错误）。 */
const FAIL_GETPROCESS_FN = "function Get-Process { [CmdletBinding()] param($Id) Write-Error 'injected Get-Process failure' }";
const EMPTY_GETPROCESS_FN = 'function Get-Process { [CmdletBinding()] param($Id) }';
/** Get-Process 被调用过之后 CIM 才静默返回空（其余脚本里 CIM 照常）：用来走到 killIfIdentity 的「已持句柄」分支。 */
const EMPTY_AFTER_GET_PROCESS = [
    'function Get-Process { [CmdletBinding()] param($Id) $global:__afterGetProcess = $true; Microsoft.PowerShell.Management\\Get-Process -Id $Id }',
    'function Get-CimInstance { [CmdletBinding()] param([Parameter(Position=0)]$ClassName, $Filter) if ($global:__afterGetProcess) { return }; CimCmdlets\\Get-CimInstance -ClassName $ClassName -Filter $Filter }',
].join('\n');

// ================================================================ 各节

let PORTS_BUSY = false;

async function sec0() {
    section('0', `前置：测试端口（H1-B）：选定条件、空闲；零串扰占位（${ZERO_XTALK ? '--zero-crosstalk 已启用' : '未启用'}）`);
    check('0.0 选出三个满足条件的测试端口（50060–65535 内随机取候选并探测可绑定，最多重试 200 次，取不到判红）', TP_ERR === null, TP_ERR);
    if (TP_ERR !== null) { PORTS_BUSY = true; return; }
    // 期望条件全部手写字面量，不复用 pickTestPorts 里的判断（防选择函数与断言同错）
    check('0.1 三个测试端口互不相同，都是 1024–65535 的整数', new Set(TP).size === 3 && TP.every((p) => Number.isInteger(p) && p >= 1024 && p <= 65535), TP);
    check('0.2 三个测试端口都不在 20000–49999（别的 FAMILY 成员随机监听用的段）', TP.every((p) => !(p >= 20000 && p <= 49999)), TP);
    check('0.3 三个测试端口都不是 3000 / 3100 / 3200 / 3300（不与主服务、真实线撞）', TP.every((p) => p !== 3000 && p !== 3100 && p !== 3200 && p !== 3300), TP);
    check('0.4 三个测试端口都在 50060–65535（高于 Fetch 禁用名单、动态端口段与管理排除段，守卫 verify-no-listen-zero 的取舍见 randomCandidatePort 注释）', TP.every((p) => p >= 50060 && p <= 65535), TP);
    for (const port of TP) {
        const free = await portFreeI(port);
        check(`0.${port} 测试端口 ${port} 空闲`, free, free ? undefined : `被占用，监听进程 PID：${listenersOn(port).join('、') || '未知'}（不会终止它）`);
        if (!free) PORTS_BUSY = true;
    }
    if (!ZERO_XTALK) {
        // 缺省模式不碰真实槽位端口：不起占位、不做 0.ph / 0.ph0（也不计 PASS）
        log(`  （零串扰占位未启用：没带 --zero-crosstalk，整套期间不碰真实槽位端口 ${REAL_SLOT_PORTS.slice(0, 2).join(' / ')}；要做零串扰回归请带该开关）`);
        // 缺省模式的承诺本身要有断言：真实槽位端口上没有本进程的监听（别的进程——例如真实线——占着是常态，不算；只看 PID）。防「缺省也偷偷占位」的实现
        for (const port of REAL_SLOT_PORTS.slice(0, 2)) {
            const l = listenersStrict(port);
            check(`0.np 缺省模式不碰真实槽位端口：端口 ${port} 上 LISTENING 的没有本进程`, Array.isArray(l) && !l.includes(process.pid), l);
        }
        return;
    }
    // 零串扰占位（--zero-crosstalk）：入口已在真实槽位端口 3100 / 3200 上起了占位监听，或记录了端口上已有真实监听者（那本身就证明套件不依赖该端口空闲）；绑定失败又无监听者的端口记为未证明
    for (const ph of PLACEHOLDERS) {
        check(`0.ph 占位监听在位：真实槽位端口 ${ph.port} 上 LISTENING 的有本进程（整套在它存在期间照常全绿 = 零串扰）`, listenersOn(ph.port).includes(process.pid), listenersOn(ph.port));
        log(`  （自持占位（全程本进程持有）：真实槽位端口 ${ph.port}）`);
    }
    for (const sk of PH_SKIPPED) log(`  （入口占用快照（外部监听者，逐节复核）：真实槽位端口 ${sk.port} 上有监听者 PID ${sk.owners.join('、')}，入口时证明成立；跳过占位，不强占；每节结束与 Z 节重查，监听者消失即记为未证明）`);
    for (const un of PH_UNPROVEN) log(`  零串扰未证明：端口 ${un.port}（${un.reason}）`);
    const phState = { placed: PLACEHOLDERS, skipped: PH_SKIPPED };
    for (const port of REAL_SLOT_PORTS.slice(0, 2)) {
        check(`0.ph0 真实槽位端口 ${port} 零串扰成立：占位成功，或端口上有真实监听者（绑定失败又无监听者 = 未证明，判红）`, zeroXtalkProven(port, phState), { placed: PLACEHOLDERS.map((p) => p.port), skipped: PH_SKIPPED.map((p) => ({ port: p.port, owners: p.owners })), unproven: PH_UNPROVEN });
    }
}

/**
 * 节 H（H2）：依赖指纹口径只取依赖相关内容。纯文件夹具（临时目录里的最小依赖文件树），不起进程、不占端口，所以端口被外部占用时也照常运行。
 * 期望状态全部手写（same / different），不从被测代码取；每条注明它防的是哪种错误实现。
 * 口径（手写，与 line-run.js depsFingerprint 的注释一致，41-R 后改排除法）：package.json 默认整份去掉顶层 version、其余全部参与（overrides 保声明顺序、其余键排序）；
 * 整文件比对（去 CR、先剥 BOM，version 也参与）的触发条件：scripts 含 10 个安装生命周期事件之一或不是普通对象 / 同目录有 binding.gyp / 任一边的根 package.json 声明 workspaces（或根解析失败）；
 * 成对判定：任一边触发则同一 rel 的两边都整文件；package-lock.json 去掉根 name / version 与 packages[""] 的 name / version；
 * 解析失败退回整文件哈希（宁严勿松）；对象键序无关、数组保序；开头的 BOM 不算内容。
 */
async function secH() {
    section('H', '依赖指纹口径（H2）：只比依赖相关内容，不比 version 等');
    rootSeq += 1;
    const root = path.join(os.tmpdir(), `依赖指纹 测试 ${process.pid}-${rootSeq}`);
    ALL_ROOTS.push(root);
    const mainD = path.join(root, '主 工作区');
    const wtD = path.join(root, '线 检出');
    const j = (o) => `${JSON.stringify(o, null, 2)}\n`;
    const BASE_PKG = { name: 'fixture-wbs', version: '1.0.0', description: 'd', scripts: { start: 'node server.js' }, dependencies: { express: '4.18.2', sqlite3: '5.1.7' }, devDependencies: { mocha: '10.0.0' }, engines: { node: '>=18' } };
    const BASE_LOCK = {
        name: 'fixture-wbs', version: '1.0.0', lockfileVersion: 3, requires: true,
        packages: {
            '': { name: 'fixture-wbs', version: '1.0.0', dependencies: { express: '4.18.2' } },
            'node_modules/express': { version: '4.18.2', resolved: 'https://r.example/express-4.18.2.tgz', integrity: 'sha512-AAA', dependencies: { accepts: '~1.3.8' } },
            'node_modules/accepts': { version: '1.3.8', resolved: 'https://r.example/accepts-1.3.8.tgz', integrity: 'sha512-BBB' },
        },
    };
    const clone = (o) => JSON.parse(JSON.stringify(o));
    const BASE = { 'wbs-server/package.json': j(BASE_PKG), 'wbs-server/package-lock.json': j(BASE_LOCK), 'package.json': j(Object.assign({}, BASE_PKG, { name: 'fixture-root' })) };
    const put = (dir, rel, text) => w(path.join(dir, ...rel.split('/')), text);
    for (const [rel, t] of Object.entries(BASE)) { put(mainD, rel, t); put(wtD, rel, t); }
    /** 主工作区写 mainText、线检出写 lineText（其余文件两边相同），返回 computeDeps 对该文件的判定；写完还原。 */
    const statusOf = (rel, mainText, lineText) => {
        put(mainD, rel, mainText);
        put(wtD, rel, lineText);
        try { return RUN.computeDeps(mainD, wtD, 'shared').files.find((f) => f.rel === rel).status; } finally { put(mainD, rel, BASE[rel]); put(wtD, rel, BASE[rel]); }
    };
    const PKG = 'wbs-server/package.json';
    const LOCK = 'wbs-server/package-lock.json';
    const ROOT_PKG = 'package.json';
    const pkgWith = (patch) => j(Object.assign(clone(BASE_PKG), patch));
    const lockWith = (fn) => { const l = clone(BASE_LOCK); fn(l); return j(l); };
    const eqS = (name, got, want) => check(name, got === want, `期望 ${want}，实际 ${got}`);
    const BOM = String.fromCharCode(0xfeff);
    /**
     * 多文件版本：edits = { 相对路径: 文本 | null(删除) }，分别写到主工作区 / 线检出（其余文件两边相同），返回 computeDeps 的完整结果；写完还原（BASE 里有的还原成 BASE，没有的删除）。
     * 用来造 binding.gyp / 根 package.json 声明 workspaces 这类「改的不是被比对文件本身」的夹具。
     */
    const depsOf = (mainEdits, lineEdits) => {
        const apply = (dir, edits) => { for (const [rel, t] of Object.entries(edits)) { const f = path.join(dir, ...rel.split('/')); if (t === null) { if (fs.existsSync(f)) fs.unlinkSync(f); } else put(dir, rel, t); } };
        const undo = (dir, edits) => { for (const rel of Object.keys(edits)) { const f = path.join(dir, ...rel.split('/')); if (Object.prototype.hasOwnProperty.call(BASE, rel)) put(dir, rel, BASE[rel]); else if (fs.existsSync(f)) fs.unlinkSync(f); } };
        apply(mainD, mainEdits);
        apply(wtD, lineEdits);
        try { return RUN.computeDeps(mainD, wtD, 'shared'); } finally { undo(mainD, mainEdits); undo(wtD, lineEdits); }
    };
    const fileOf = (res, rel) => res.files.find((f) => f.rel === rel);
    const GYP = 'wbs-server/binding.gyp';
    const ROOT_GYP = 'binding.gyp';
    const rootWithWs = j(Object.assign(clone(BASE_PKG), { name: 'fixture-root', workspaces: ['wbs-server'] }));

    check('H.0 基线：三个依赖文件两边相同 → 全部 same（对照；之后每条用例都只动一个文件）', same(RUN.computeDeps(mainD, wtD, 'shared').files.filter((f) => f.rel !== 'package-lock.json').map((f) => f.status), ['same', 'same', 'same']));

    // ---- package.json：非依赖字段不影响指纹
    eqS('H.1 wbs-server/package.json 只差 version → same（防整文件哈希：/deploy 每次改 version，部署后所有线 start 被拒）', statusOf(PKG, BASE[PKG], pkgWith({ version: '1.2.3' })), 'same');
    // 排除法（41-R）：除顶层 version 外一切参与。下面每个字段单独改，逐个判 different（防「仍按挑字段、只取依赖类键」的实现：它对这些都会判 same）
    const EXCL = [
        ['description', pkgWith({ description: 'other' })], ['keywords（新增）', pkgWith({ keywords: ['k'] })], ['license（新增）', pkgWith({ license: 'MIT' })],
        ['普通 scripts（start 命令不同）', pkgWith({ scripts: { start: 'node x.js' } })], ['普通 scripts（新增 test）', pkgWith({ scripts: { start: 'node server.js', test: 'echo t' } })],
        ['config（新增）', pkgWith({ config: { port: '1' } })], ['name', pkgWith({ name: 'renamed' })], ['bin（新增）', pkgWith({ bin: { fx: 'bin/fx.js' } })], ['gypfile（新增）', pkgWith({ gypfile: true })],
        ['未知顶层键（x-custom 新增）', pkgWith({ 'x-custom': 1 })], ['main', pkgWith({ main: 'index.js' })],
    ];
    for (const [label, txt] of EXCL) eqS(`H.2 只差 ${label} → different（排除法：只有顶层 version 不参与）`, statusOf(PKG, BASE[PKG], txt), 'different');
    eqS('H.2a 同时差 version 与 description → different（version 被排除，description 仍参与）', statusOf(PKG, BASE[PKG], pkgWith({ version: '8.8.8', description: 'other' })), 'different');
    eqS('H.2a2 嵌套对象里的 version 键不被排除（只排除顶层）：config.version 不同 → different', statusOf(PKG, pkgWith({ config: { version: '1' } }), pkgWith({ config: { version: '2' } })), 'different');
    eqS('H.2b 根 package.json 只差 version → same；防只对 wbs-server/package.json 这个路径特判、不按文件名处理', statusOf(ROOT_PKG, BASE[ROOT_PKG], j(Object.assign(clone(BASE_PKG), { name: 'fixture-root', version: '4.5.6' }))), 'same');
    eqS('H.2c 排版不同（紧凑 / 缩进 / CRLF）、内容相同 → same（防原始文本比对）', statusOf(PKG, BASE[PKG], JSON.stringify(BASE_PKG)), 'same');
    eqS('H.2d CRLF 版本 → same', statusOf(PKG, BASE[PKG], BASE[PKG].replace(/\n/g, '\r\n')), 'same');

    // ---- package.json 的 scripts：有安装生命周期脚本（10 个事件之一）或 scripts 不是普通对象 → 整文件比对；没有 → 字段口径（普通 scripts / config / version 都不影响）
    const scriptsOf = (sc) => pkgWith({ scripts: sc });
    const noScripts = (() => { const o = clone(BASE_PKG); delete o.scripts; return o; })();
    // 没有生命周期脚本：排除法（整份去掉 version）。pre/post 开头但不属于安装事件的键不触发整文件，此时 scripts 不同照样 different（排除法），但「只差 version」是 same——用这条区分「凡 pre/post 开头都算生命周期」的过宽实现
    eqS('H.2e 没有生命周期脚本（scripts 里只有 start / test / pretest / prestart / posttest 这类不属于安装事件的键），两边只差 version → same（防「凡 pre/post 开头都算生命周期」而退到整文件、把 version 也算进去）',
        statusOf(PKG, scriptsOf({ start: 'node server.js', pretest: 'x', prestart: 'y', posttest: 'z' }), j(Object.assign(clone(BASE_PKG), { scripts: { start: 'node server.js', pretest: 'x', prestart: 'y', posttest: 'z' }, version: '9.9.9' }))), 'same');
    eqS('H.2e2 没有生命周期脚本：config 两边都不同时只差 version 以外 → different；config 相同只差 version → same', statusOf(PKG, pkgWith({ config: { port: '1' } }), pkgWith({ config: { port: '2' }, version: '9.9.9' })) + statusOf(PKG, pkgWith({ config: { port: '1' } }), pkgWith({ config: { port: '1' }, version: '9.9.9' })), 'differentsame');
    // 有生命周期脚本：整文件比对（version、config、全部 scripts 都参与）
    eqS('H.2f 两边都只有非生命周期 scripts，一边多了 postinstall → different', statusOf(PKG, scriptsOf({ start: 'node server.js' }), scriptsOf({ start: 'node server.js', postinstall: 'node evil.js' })), 'different');
    eqS('H.2g 同一个生命周期脚本（postinstall）命令内容不同 → different（防只比键名、不比命令）', statusOf(PKG, scriptsOf({ postinstall: 'node a.js' }), scriptsOf({ postinstall: 'node b.js' })), 'different');
    eqS('H.2h 有生命周期脚本、生命周期部分相同、其余 scripts 不同 → different（整文件：生命周期脚本可以调用其他 scripts，防只比生命周期子集）', statusOf(PKG, scriptsOf({ postinstall: 'npm run setup', setup: 'node a.js' }), scriptsOf({ postinstall: 'npm run setup', setup: 'node b.js' })), 'different');
    eqS('H.2h2 有生命周期脚本、两边只差 version → different（整文件：安装脚本可以读 version；代价是这类仓库部署改 version 后各线需 rebase）', statusOf(PKG, scriptsOf({ postinstall: 'node a.js' }), j(Object.assign(clone(BASE_PKG), { scripts: { postinstall: 'node a.js' }, version: '9.9.9' }))), 'different');
    eqS('H.2h3 有生命周期脚本、两边只差 config → different（安装脚本可以读 npm_package_config_*，防字段口径漏掉 config）', statusOf(PKG, pkgWith({ scripts: { postinstall: 'node a.js' }, config: { port: '1' } }), pkgWith({ scripts: { postinstall: 'node a.js' }, config: { port: '2' } })), 'different');
    eqS('H.2h4 有生命周期脚本、两边完全相同 → same；只差 CRLF → same（整文件比对不等于一律判不同，仍去 CR）', statusOf(PKG, scriptsOf({ postinstall: 'node a.js' }), scriptsOf({ postinstall: 'node a.js' })) + statusOf(PKG, scriptsOf({ postinstall: 'node a.js' }), scriptsOf({ postinstall: 'node a.js' }).replace(/\n/g, '\r\n')), 'samesame');
    const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare', 'predependencies', 'dependencies', 'postdependencies'];   // 手写，不取自被测代码
    for (const ev of LIFECYCLE) {
        eqS(`H.2i 生命周期事件 ${ev}：一边有、一边没有 → different（防漏掉 ${ev}）`, statusOf(PKG, scriptsOf({ start: 'node server.js' }), scriptsOf({ start: 'node server.js', [ev]: 'node x.js' })), 'different');
        eqS(`H.2i2 生命周期事件 ${ev}：两边都有、只差 version → different（走整文件；防漏掉 ${ev} 而退回字段口径）`, statusOf(PKG, scriptsOf({ [ev]: 'node x.js' }), j(Object.assign(clone(BASE_PKG), { scripts: { [ev]: 'node x.js' }, version: '7.7.7' }))), 'different');
    }
    // scripts 不是普通对象：整文件比对
    eqS('H.2j scripts 是字符串，两边只差 version → different（整文件；防「非对象 scripts 退回字段口径」）', statusOf(PKG, pkgWith({ scripts: 'echo a' }), pkgWith({ scripts: 'echo a', version: '9.9.9' })), 'different');
    eqS('H.2k scripts 是数组，两边只差 version → different', statusOf(PKG, pkgWith({ scripts: ['a'] }), pkgWith({ scripts: ['a'], version: '9.9.9' })), 'different');
    eqS('H.2l scripts 是字符串且两边完全相同 → same（整文件比对不等于一律判不同）', statusOf(PKG, pkgWith({ scripts: 'echo a' }), pkgWith({ scripts: 'echo a' })), 'same');
    eqS('H.2m 一边 scripts 是对象（无生命周期）、另一边是字符串 → different', statusOf(PKG, scriptsOf({ start: 'node server.js' }), pkgWith({ scripts: 'echo a' })), 'different');
    eqS('H.2n 一边 scripts 是 null、另一边没有 scripts → different；null 两边只差 version → different', statusOf(PKG, j(noScripts), pkgWith({ scripts: null })) + statusOf(PKG, pkgWith({ scripts: null }), pkgWith({ scripts: null, version: '9.9.9' })), 'differentdifferent');

    // ---- package.json：依赖类的 10 个键（含 workspaces）每个都得进指纹（排除法下它们当然参与；保留这组用例，防回退成「只忽略几个键」之外的任何挑字段实现）
    const DEP_KEYS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'bundleDependencies', 'bundledDependencies', 'overrides', 'engines', 'workspaces'];
    for (const k of DEP_KEYS) {
        const isArr = k.startsWith('bundle') || k === 'workspaces';
        const va = isArr ? ['a'] : { a: '1.0.0' };
        const vb = isArr ? ['b'] : { a: '2.0.0' };
        const without = (o) => { const c = clone(o); delete c[k]; return c; };
        const mk = (v) => j(Object.assign(without(BASE_PKG), v === undefined ? {} : { [k]: v }));
        eqS(`H.3 ${k} 一边没有、一边有 → different（防漏掉 ${k} 键）`, statusOf(PKG, mk(undefined), mk(va)), 'different');
        eqS(`H.3 ${k} 两边都有、值不同 → different（防漏掉 ${k} 键）`, statusOf(PKG, mk(va), mk(vb)), 'different');
    }
    eqS('H.3b dependencies 里一个包的版本不同（express 4.18.2 → 4.19.0）→ different（防忽略依赖）', statusOf(PKG, BASE[PKG], pkgWith({ dependencies: { express: '4.19.0', sqlite3: '5.1.7' } })), 'different');
    eqS('H.3c 根 package.json 的 dependencies 不同 → different（防只比 wbs-server 那份）', statusOf(ROOT_PKG, BASE[ROOT_PKG], j(Object.assign(clone(BASE_PKG), { name: 'fixture-root', dependencies: { express: '9.9.9' } }))), 'different');
    eqS('H.3d 同时改 version 与一个依赖版本 → different（防「version 变了就整体放行」）', statusOf(PKG, BASE[PKG], pkgWith({ version: '2.0.0', dependencies: { express: '4.19.0', sqlite3: '5.1.7' } })), 'different');

    // ---- overrides 保声明顺序（npm 按顺序匹配规则），其余键仍排序
    eqS('H.3e overrides 两条规则交换声明顺序 → different（防 overrides 也被排序）', statusOf(PKG, pkgWith({ overrides: { a: '1.0.0', b: '2.0.0' } }), pkgWith({ overrides: { b: '2.0.0', a: '1.0.0' } })), 'different');
    eqS('H.3f overrides 嵌套对象内交换顺序 → different（保序递归整棵子树）', statusOf(PKG, pkgWith({ overrides: { a: { b: '1', c: '2' } } }), pkgWith({ overrides: { a: { c: '2', b: '1' } } })), 'different');
    eqS('H.3g overrides 声明顺序相同 → same（对照）', statusOf(PKG, pkgWith({ overrides: { b: '2.0.0', a: '1.0.0' } }), pkgWith({ overrides: { b: '2.0.0', a: '1.0.0' } })), 'same');
    eqS('H.3h dependencies 交换声明顺序 → same（其余键排序仍然生效；防全局不排序）', statusOf(PKG, pkgWith({ dependencies: { express: '4.18.2', sqlite3: '5.1.7' } }), pkgWith({ dependencies: { sqlite3: '5.1.7', express: '4.18.2' } })), 'same');
    eqS('H.3i engines / peerDependenciesMeta 内交换声明顺序 → same', statusOf(PKG, pkgWith({ engines: { node: '>=18', npm: '>=9' }, peerDependenciesMeta: { a: { optional: true }, b: { optional: true } } }), pkgWith({ engines: { npm: '>=9', node: '>=18' }, peerDependenciesMeta: { b: { optional: true }, a: { optional: true } } })), 'same');
    // ---- 键序与数组
    const reorder = (o) => { const out = {}; for (const k of Object.keys(o).reverse()) out[k] = (o[k] !== null && typeof o[k] === 'object' && !Array.isArray(o[k])) ? reorder(o[k]) : o[k]; return out; };
    eqS('H.4 package.json 键顺序不同（顶层与嵌套都倒序）、内容相同 → same（防不排序的序列化）', statusOf(PKG, BASE[PKG], j(reorder(BASE_PKG))), 'same');
    eqS('H.4b package-lock.json 键顺序不同、内容相同 → same', statusOf(LOCK, BASE[LOCK], j(reorder(BASE_LOCK))), 'same');
    eqS('H.4c 数组保序：bundleDependencies [a,b] 与 [b,a] → different（防把数组也排序）', statusOf(PKG, pkgWith({ bundleDependencies: ['a', 'b'] }), pkgWith({ bundleDependencies: ['b', 'a'] })), 'different');

    // ---- package-lock.json
    eqS('H.5 锁文件只差根 version 与 packages[""].version → same（防整文件哈希；防只删根 version 却漏 packages[""].version）', statusOf(LOCK, BASE[LOCK], lockWith((l) => { l.version = '3.0.0'; l.packages[''].version = '3.0.0'; })), 'same');
    eqS('H.5b 只差根 version → same', statusOf(LOCK, BASE[LOCK], lockWith((l) => { l.version = '3.0.0'; })), 'same');
    eqS('H.5c 只差 packages[""].version → same（防只删根 version）', statusOf(LOCK, BASE[LOCK], lockWith((l) => { l.packages[''].version = '3.0.0'; })), 'same');
    eqS('H.5d 根 name 与 packages[""].name 都不同 → same', statusOf(LOCK, BASE[LOCK], lockWith((l) => { l.name = 'x'; l.packages[''].name = 'x'; })), 'same');
    eqS('H.6 锁文件里某个依赖包条目的 version 不同（node_modules/express 4.18.2 → 4.19.0）→ different（防递归删掉所有 version 字段）', statusOf(LOCK, BASE[LOCK], lockWith((l) => { l.packages['node_modules/express'].version = '4.19.0'; })), 'different');
    eqS('H.6b 依赖包条目的 integrity 不同 → different', statusOf(LOCK, BASE[LOCK], lockWith((l) => { l.packages['node_modules/accepts'].integrity = 'sha512-ZZZ'; })), 'different');
    eqS('H.6c 依赖包条目的 resolved 不同 → different', statusOf(LOCK, BASE[LOCK], lockWith((l) => { l.packages['node_modules/accepts'].resolved = 'https://other.example/accepts.tgz'; })), 'different');
    eqS('H.6d packages[""].dependencies 不同 → different（防把 packages[""] 整个丢掉）', statusOf(LOCK, BASE[LOCK], lockWith((l) => { l.packages[''].dependencies = { express: '4.19.0' }; })), 'different');
    eqS('H.6e lockfileVersion 不同 → different', statusOf(LOCK, BASE[LOCK], lockWith((l) => { l.lockfileVersion = 2; })), 'different');
    eqS('H.6f 锁文件多一个依赖包条目 → different', statusOf(LOCK, BASE[LOCK], lockWith((l) => { l.packages['node_modules/left-pad'] = { version: '1.3.0' }; })), 'different');

    // ---- 解析失败：退回整文件（去 CR）比较，宁严勿松
    const BROKEN_A = '{"name":"fixture-wbs","version":"1.0.0",\n';
    const BROKEN_B = '{"name":"fixture-wbs","version":"2.0.0",\n';
    eqS('H.7 一边 package.json 不是合法 JSON → different（防把解析失败当空、当相同）', statusOf(PKG, BASE[PKG], BROKEN_A), 'different');
    eqS('H.7b 另一边（主工作区）不是合法 JSON → different', statusOf(PKG, BROKEN_A, BASE[PKG]), 'different');
    eqS('H.7c 两边都不是合法 JSON 且文本不同 → different（防解析失败时返回固定值：两个坏文件会被判相同）', statusOf(PKG, BROKEN_A, BROKEN_B), 'different');
    eqS('H.7d 两边是同一份坏文本 → same（整文件比较，不是一律判不同）', statusOf(PKG, BROKEN_A, BROKEN_A), 'same');
    eqS('H.7e 同一份坏文本只差 CRLF → same（退回的整文件哈希仍按去 CR 规范化）', statusOf(PKG, BROKEN_A, BROKEN_A.replace(/\n/g, '\r\n')), 'same');
    eqS('H.7f 锁文件一边不是合法 JSON → different', statusOf(LOCK, BASE[LOCK], BROKEN_A), 'different');
    eqS('H.7g 顶层不是对象的合法 JSON（[]）与 [ ] → different（按整文件比，防把数组当对象取到「空依赖」而全部判相同）', statusOf(PKG, '[]\n', '[ ]\n'), 'different');
    eqS('H.7h 顶层是 null 的 package.json 对 BASE → different', statusOf(PKG, BASE[PKG], 'null\n'), 'different');

    // ---- BOM 与文件缺失语义
    eqS('H.8 一边带 UTF-8 BOM、内容相同 → same（防把 BOM 当解析失败而判不一致）', statusOf(PKG, BASE[PKG], `\uFEFF${BASE[PKG]}`), 'same');
    eqS('H.8b 带 BOM 且依赖不同 → different（BOM 剥掉后仍然比依赖）', statusOf(PKG, BASE[PKG], `\uFEFF${pkgWith({ dependencies: { express: '1.0.0' } })}`), 'different');
    eqS('H.8c package-lock.json 一边带 UTF-8 BOM、内容相同 → same（防锁文件分支不剥 BOM、把它当解析失败）', statusOf(LOCK, BASE[LOCK], `\uFEFF${BASE[LOCK]}`), 'same');
    eqS('H.8d package-lock.json 带 BOM 且依赖包条目不同 → different', statusOf(LOCK, BASE[LOCK], `\uFEFF${lockWith((l) => { l.packages['node_modules/express'].version = '4.19.0'; })}`), 'different');
    check('H.9 文件不存在 → depsFingerprint 返回 null（语义不变）', RUN.depsFingerprint(path.join(mainD, 'wbs-server', 'nope.json')) === null && RUN.depsFingerprint(path.join(mainD, 'no-such-dir', 'package.json')) === null);
    const hideM = path.join(mainD, 'package.json');
    fs.renameSync(hideM, `${hideM}.hidden`);
    let missSt;
    try { missSt = RUN.computeDeps(mainD, wtD, 'shared').files.find((f) => f.rel === 'package.json').status; } finally { fs.renameSync(`${hideM}.hidden`, hideM); }
    eqS('H.9b 必需依赖文件仅主工作区缺 → missing（缺失语义不变）', missSt, 'missing');

    // ---- binding.gyp（41-R M1）：package.json 同目录有 binding.gyp → npm 隐式 node-gyp rebuild → 整文件比对（version 也参与）；成对判定：任一边有，两边都整文件
    const VERB = j(Object.assign(clone(BASE_PKG), { version: '9.9.9' }));   // wbs-server/package.json：只差 version
    const ROOT_VERB = j(Object.assign(clone(BASE_PKG), { name: 'fixture-root', version: '4.5.6' }));   // 根 package.json：只差 version
    const GYP_TXT = '{ "targets": [] }\n';
    const rawBoth = (res, rel, mainText, lineText) => { const f = fileOf(res, rel); return f.main === sha256(mainText) && f.line === sha256(lineText); };   // 两边指纹都等于各自（已是 LF 的）文本的整文件 sha256
    const rG1 = depsOf({ [GYP]: GYP_TXT }, { [PKG]: VERB });
    eqS('H.11 主工作区的 wbs-server/ 有 binding.gyp、两边 package.json 只差 version → different（整文件：version 参与）', fileOf(rG1, PKG).status, 'different');
    check('H.11a 同一用例的成对判定：线检出一边没有 binding.gyp，指纹也是整文件 sha256（不是排除法的规范串）；标记 wholeFile=true、原因 [binding.gyp]（防只看本边：没有 binding.gyp 的那一边会退回排除法）',
        rawBoth(rG1, PKG, BASE[PKG], VERB) && fileOf(rG1, PKG).wholeFile === true && same(fileOf(rG1, PKG).wholeReasons, ['binding.gyp']), fileOf(rG1, PKG));
    const rG2 = depsOf({ [PKG]: VERB }, { [GYP]: GYP_TXT });
    eqS('H.11b 线检出的 wbs-server/ 有 binding.gyp、主工作区没有、只差 version → different（任一边有即触发，不只看主工作区）', fileOf(rG2, PKG).status, 'different');
    check('H.11c 同上：两边指纹都是整文件 sha256', rawBoth(rG2, PKG, VERB, BASE[PKG]) && fileOf(rG2, PKG).wholeFile === true, fileOf(rG2, PKG));
    const rG3 = depsOf({ [GYP]: GYP_TXT }, { [GYP]: GYP_TXT });
    eqS('H.11d 两边都有 binding.gyp、package.json 逐字相同 → same（整文件比对不等于一律判不同）', fileOf(rG3, PKG).status, 'same');
    eqS('H.11e 两边都有 binding.gyp、只差 version → different（整文件：version 参与）', fileOf(depsOf({ [GYP]: GYP_TXT }, { [GYP]: GYP_TXT, [PKG]: VERB }), PKG).status, 'different');
    const rG0 = depsOf({}, { [PKG]: VERB });
    check('H.11f 两边都没有 binding.gyp、只差 version → same，且不按整文件（wholeFile=false，原因 []）', fileOf(rG0, PKG).status === 'same' && fileOf(rG0, PKG).wholeFile === false && same(fileOf(rG0, PKG).wholeReasons, []), fileOf(rG0, PKG));
    const rG4 = depsOf({ [GYP]: GYP_TXT }, { [ROOT_PKG]: ROOT_VERB });
    check('H.11g binding.gyp 只管同目录的 package.json：gyp 在 wbs-server/、根 package.json 只差 version → same（防「任何位置有 gyp 就全整文件」）', fileOf(rG4, ROOT_PKG).status === 'same' && fileOf(rG4, ROOT_PKG).wholeFile === false, fileOf(rG4, ROOT_PKG));
    const rG5 = depsOf({ [ROOT_GYP]: GYP_TXT }, { [ROOT_PKG]: ROOT_VERB, [PKG]: VERB });
    check('H.11h 反过来：gyp 在仓库根 → 根 package.json 只差 version 判 different（整文件），wbs-server/package.json 只差 version 仍 same', fileOf(rG5, ROOT_PKG).status === 'different' && fileOf(rG5, ROOT_PKG).wholeFile === true && fileOf(rG5, PKG).status === 'same' && fileOf(rG5, PKG).wholeFile === false, { r: fileOf(rG5, ROOT_PKG), p: fileOf(rG5, PKG) });

    // ---- 根 package.json 声明 workspaces（41-R M2）：工作区成员的 name / version / bin 都影响链接 → 根与 wbs-server 两个 package.json 都整文件；根解析失败按声明了算
    const rW1 = depsOf({ [ROOT_PKG]: rootWithWs }, { [PKG]: VERB });
    eqS('H.12 主工作区的根 package.json 声明 workspaces、两边 wbs-server/package.json 只差 version → different（整文件）', fileOf(rW1, PKG).status, 'different');
    check('H.12a 同上：两边指纹都是整文件 sha256，标记原因 [workspaces]（防只看线检出一边的根，或只在根 package.json 自己上生效）', rawBoth(rW1, PKG, BASE[PKG], VERB) && fileOf(rW1, PKG).wholeFile === true && same(fileOf(rW1, PKG).wholeReasons, ['workspaces']), fileOf(rW1, PKG));
    const rW2 = depsOf({ [PKG]: VERB }, { [ROOT_PKG]: rootWithWs });
    eqS('H.12b 线检出的根 package.json 声明 workspaces、主工作区没有 → wbs-server/package.json 只差 version 判 different（任一边声明即触发）', fileOf(rW2, PKG).status, 'different');
    const rW0 = depsOf({}, { [PKG]: VERB });
    eqS('H.12c 两边根 package.json 都没声明 workspaces、wbs-server/package.json 只差 version → same', fileOf(rW0, PKG).status, 'same');
    const rW3 = depsOf({ [ROOT_PKG]: rootWithWs }, { [ROOT_PKG]: rootWithWs });
    check('H.12d 两边根 package.json 都声明 workspaces 且逐字相同、wbs-server/package.json 也相同 → 两个 package.json 都 same（整文件比对不等于一律判不同）', fileOf(rW3, PKG).status === 'same' && fileOf(rW3, ROOT_PKG).status === 'same' && fileOf(rW3, ROOT_PKG).wholeFile === true, { p: fileOf(rW3, PKG), r: fileOf(rW3, ROOT_PKG) });
    const rW4 = depsOf({ [ROOT_PKG]: rootWithWs }, { [ROOT_PKG]: j(Object.assign(JSON.parse(rootWithWs), { version: '7.7.7' })) });
    eqS('H.12e 两边根 package.json 都声明 workspaces、只差 version → 根 package.json 自己也 different（整文件，version 参与）', fileOf(rW4, ROOT_PKG).status, 'different');
    const rW5 = depsOf({}, { [ROOT_PKG]: BROKEN_A, [PKG]: VERB });
    check('H.12f 线检出的根 package.json 不是合法 JSON → 按声明了 workspaces 算：wbs-server/package.json 只差 version 判 different，整文件', fileOf(rW5, PKG).status === 'different' && fileOf(rW5, PKG).wholeFile === true && fileOf(rW5, PKG).wholeReasons.includes('workspaces'), fileOf(rW5, PKG));
    eqS('H.12g wbs-server/package.json 自己带 workspaces（根没有）、两边只差 version → same（触发条件是「根」package.json 声明；排除法下 workspaces 值本身仍参与比对）', statusOf(PKG, pkgWith({ workspaces: ['a'] }), pkgWith({ workspaces: ['a'], version: '9.9.9' })), 'same');
    eqS('H.12h 根 package.json 的 workspaces 是空数组也算声明 → wbs-server/package.json 只差 version 判 different', fileOf(depsOf({ [ROOT_PKG]: j(Object.assign(JSON.parse(BASE[ROOT_PKG]), { workspaces: [] })) }, { [PKG]: VERB }), PKG).status, 'different');

    // ---- 整文件分支先剥 BOM（41-R L1）、去 CR：BOM / CRLF 不是内容
    const LC = scriptsOf({ postinstall: 'node a.js' });
    eqS('H.13 生命周期脚本（整文件）：两边相同、只差开头 BOM → same（防整文件分支不剥 BOM）', statusOf(PKG, LC, `${BOM}${LC}`), 'same');
    eqS('H.13b 生命周期脚本（整文件）：BOM + CRLF 都有、内容相同 → same', statusOf(PKG, LC, `${BOM}${LC.replace(/\n/g, '\r\n')}`), 'same');
    eqS('H.13c 生命周期脚本（整文件）：带 BOM 但内容不同 → different（剥 BOM 不等于放行）', statusOf(PKG, LC, `${BOM}${scriptsOf({ postinstall: 'node b.js' })}`), 'different');
    eqS('H.13d workspaces 触发的整文件：wbs-server/package.json 只差 BOM → same', fileOf(depsOf({ [ROOT_PKG]: rootWithWs }, { [ROOT_PKG]: rootWithWs, [PKG]: `${BOM}${BASE[PKG]}` }), PKG).status, 'same');
    eqS('H.13e binding.gyp 触发的整文件：wbs-server/package.json 只差 BOM → same', fileOf(depsOf({ [GYP]: GYP_TXT }, { [GYP]: GYP_TXT, [PKG]: `${BOM}${BASE[PKG]}` }), PKG).status, 'same');
    eqS('H.13f 解析失败的退路（整文件）：同一份坏文本只差 BOM → same', statusOf(PKG, BROKEN_A, `${BOM}${BROKEN_A}`), 'same');

    // ---- 指纹值本身（手写期望）：package.json 的指纹 = 整份去掉顶层 version 后的规范串
    const pj = path.join(root, 'fpdir', 'package.json');
    w(pj, '{"version":"1.0.0","name":"a","scripts":{"s":"x"},"dependencies":{"x":"1"}}');
    // 新口径（排除法）：{"dependencies":{"x":"1"},"name":"a","scripts":{"s":"x"}}；旧口径（挑 10 个依赖键）：{"dependencies":{"x":"1"}}——name、scripts 现在参与
    check('H.10 package.json 指纹值 = sha256({"dependencies":{"x":"1"},"name":"a","scripts":{"s":"x"}})（手写字面量：整份去掉顶层 version，其余键排序；防把 version 哈希进去、仍按挑字段、或序列化格式悄悄变化）', RUN.depsFingerprint(pj) === sha256('{"dependencies":{"x":"1"},"name":"a","scripts":{"s":"x"}}'), RUN.depsFingerprint(pj));
    const pj2 = path.join(root, 'fpdir3', 'package.json');
    w(pj2, '{"version":"1.0.0","overrides":{"b":"2","a":"1"},"dependencies":{"y":"1","x":"2"}}');
    check('H.10c package.json 指纹值（overrides 保序、dependencies 排序）= sha256({"dependencies":{"x":"2","y":"1"},"overrides":{"b":"2","a":"1"}})', RUN.depsFingerprint(pj2) === sha256('{"dependencies":{"x":"2","y":"1"},"overrides":{"b":"2","a":"1"}}'), RUN.depsFingerprint(pj2));
    const pj3 = path.join(root, 'fpdir4', 'package.json');
    w(pj3, `${BOM}{"version":"1.0.0","scripts":{"postinstall":"node a.js"}}\r\n`);
    check('H.10d 整文件分支的指纹值 = 去 BOM、去 CR 的原文 sha256（手写：{"version":"1.0.0","scripts":{"postinstall":"node a.js"}} + LF）', RUN.depsFingerprint(pj3) === sha256('{"version":"1.0.0","scripts":{"postinstall":"node a.js"}}\n'), RUN.depsFingerprint(pj3));
    const lj = path.join(root, 'fpdir2', 'package-lock.json');
    w(lj, '{"version":"1.0.0","name":"a","lockfileVersion":3,"packages":{"":{"name":"a","version":"1.0.0","dependencies":{"x":"1"}},"node_modules/x":{"version":"1.0.0"}}}');
    check('H.10b package-lock.json 指纹值 = sha256 的手写规范串（根 name / version 与 packages[""] 的 name / version 已去掉，其余键按字典序）', RUN.depsFingerprint(lj) === sha256('{"lockfileVersion":3,"packages":{"":{"dependencies":{"x":"1"}},"node_modules/x":{"version":"1.0.0"}}}'), RUN.depsFingerprint(lj));
}

async function sec1() {
    section('1', 'line start');
    const fx = await buildFixture('s1');
    const r0 = await newLine(fx, 'ra', 'mod-a');
    check('1.0 line new 建线成功（黑盒）', r0.err === null, r0.err && r0.err.message);
    if (r0.err) return;
    const wt = wtOf(fx, 'ra');
    setCtl(fx, {});

    // 1.1 正常启动（当前进程环境里放了会污染的 SDH_* 与 PORT）
    const tBefore = Date.now();
    const out1 = [];
    const s1 = await startLine(fx, 'ra', true, {}, out1);
    const tAfter = Date.now();
    check('1.1 start 成功', s1.err === null, s1.err && s1.err.message);
    if (s1.err) return;
    const reg1 = await regOf(fx);
    const rec1 = reg1.lines.ra;
    const p = rec1.process;
    check('1.2 登记 process 恰好五个字段 pid / start_time / cmd / instance / state，就绪确认后 state = running', p !== null && same(Object.keys(p).sort(), ['cmd', 'instance', 'pid', 'start_time', 'state']) && p.state === 'running', p);
    if (p === null) return;
    track(p.pid);
    check('1.3 pid 是正整数、instance=线名、cmd=「node 路径 + 线检出的 server.js 绝对路径」', Number.isSafeInteger(p.pid) && p.pid > 0 && p.instance === 'ra' && p.cmd === `${process.execPath} ${path.join(wt, 'wbs-server', 'server.js')}`, p);
    check('1.4 登记其余字段不变：lifecycle=ready、槽位 1、端口 = 套件选定的 TP[0]（期望值取自套件变量，不取自被测输出）',rec1.lifecycle === 'ready' && rec1.slot === 1 && rec1.port === TP[0]);
    const logFile = s1.res.logFile;
    check('1.5 日志写在 <控制根>/logs/<线名>-<时刻>.log', C.isInside(path.join(fx.control, 'logs'), logFile) && /^ra-\d{8}T\d{9}Z\.log$/.test(path.basename(logFile)) && fs.existsSync(logFile), logFile);
    const logText = rd(logFile);
    check('1.6 日志里替身自报的 PID 等于登记的 pid（登记的就是 server.js 进程本身）', logVal(logText, 'STUB_PID') === String(p.pid), logVal(logText, 'STUB_PID'));
    const own = ownStartTimePs(p.pid);
    check('1.7 登记的创建时间与独立查询（Get-Process）相差不到 2 秒', own !== null && Math.abs(Date.parse(own) - Date.parse(p.start_time)) < 2000 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/.test(p.start_time), { own, reg: p.start_time });
    check('1.8 创建时间落在启动窗口内（前后各放宽 3 秒），不是编造的值', Date.parse(p.start_time) >= tBefore - 3000 && Date.parse(p.start_time) <= tAfter + 3000, { reg: p.start_time, tBefore, tAfter });
    const q1 = PR.getStartTime(p.pid);
    await sleep(1100);
    const q2 = PR.getStartTime(p.pid);
    check('1.9 同一进程多次查询创建时间结果完全相同，且等于登记值', q1 === p.start_time && q2 === p.start_time, { q1, q2, reg: p.start_time });
    const ver = await httpGetI(TP[0], '/api/version');
    check('1.10 /api/version 身份正确（instance=ra、mode=isolated、external=stub、background=off）', ver.json && ver.json.instance === 'ra' && ver.json.mode === 'isolated' && ver.json.external === 'stub' && ver.json.background === 'off', ver);
    let names = [];
    try { names = JSON.parse(logVal(logText, 'STUB_ENV_NAMES')); } catch (_) { names = []; }
    const sdhNames = names.filter((n) => /^sdh_/i.test(n));
    check('1.11 子进程环境里的 SDH_* 只剩启动器设的 SDH_INSTANCE（父进程里污染的 SDH_DB_FILE / SDH_EXTERNAL / SDH_BACKGROUND_JOBS 全被去掉）', same(sdhNames.map((n) => n.toUpperCase()), ['SDH_INSTANCE']), sdhNames);
    check('1.12 子进程的 SDH_INSTANCE=线名（不是父进程里污染的 evil-parent）', logVal(logText, 'STUB_SDH_INSTANCE') === 'ra', logVal(logText, 'STUB_SDH_INSTANCE'));
    check('1.13 子进程的 PORT 等于槽位 1 的测试端口 TP[0]（不是父进程里的 Port=9），环境里只有一个 PORT（不分大小写）', logVal(logText, 'STUB_PORT') === String(TP[0]) && names.filter((n) => /^port$/i.test(n)).length === 1, { port: logVal(logText, 'STUB_PORT'), names: names.filter((n) => /^port$/i.test(n)) });
    const lekeys = lineEnvKeys(wt);
    const upperNames = new Set(names.map((n) => n.toUpperCase()));
    const survivors = [...lekeys, 'DB_ENCRYPTION_KEY', 'WEBHOOK_SECRET', 'SYS_TEST_HOOKS'].filter((k) => upperNames.has(k.toUpperCase()));
    check('1.13b 线 .env 非空且含每线随机的 JWT_SECRET（前置）', lekeys.includes('JWT_SECRET') && lekeys.length >= 2, lekeys);
    check('1.13c 子进程环境里没有线 .env 定义的任何键、也没有禁拷键（父进程里污染的 JWT_SECRET / LOG_LEVEL / DB_ENCRYPTION_KEY / WEBHOOK_SECRET / SYS_TEST_HOOKS 全被去掉，线 .env 才能由 dotenv 加载生效）', survivors.length === 0, survivors);
    const le = RUN.launchEnv({ PORT: '9', Port: '8', port: '7', sdh_x: '1', SDH_Y: '2', Jwt_Secret: 'p', db_encryption_key: 'k', KEEP_ME: 'v', Path: 'pp' }, 3300, 'zz', ['JWT_SECRET']);
    check('1.13d launchEnv 单元：PORT 不分大小写全去掉后只剩 PORT=3300，SDH_* 全去掉后只剩 SDH_INSTANCE=zz，线 .env 键（JWT_SECRET）与禁拷键（db_encryption_key）不分大小写去掉，其余原样',
        same(Object.keys(le).sort(), ['KEEP_ME', 'PORT', 'Path', 'SDH_INSTANCE']) && le.PORT === '3300' && le.SDH_INSTANCE === 'zz' && le.KEEP_ME === 'v' && le.Path === 'pp', le);
    // 修复批 3（47R3c M）：JWT_SECRET 无条件剥离（线 .env 键名单为空 / 缺省时父环境的同名变量也不流入）
    const le2 = RUN.launchEnv({ JWT_SECRET: 'parent-jwt', Jwt_Secret: 'p2', jwt_secret: 'p3', KEEP_ME: 'v', PORT: '9' }, 3300, 'zz', []);
    const le3 = RUN.launchEnv({ JWT_SECRET: 'parent-jwt', KEEP_ME: 'v' }, 3300, 'zz');
    check('1.13e launchEnv 单元：线 .env 键名单为空（或缺省）时，父环境的 JWT_SECRET（任何大小写）仍被无条件剥离，其余原样', same(Object.keys(le2).sort(), ['KEEP_ME', 'PORT', 'SDH_INSTANCE']) && same(Object.keys(le3).sort(), ['KEEP_ME', 'PORT', 'SDH_INSTANCE']), { le2, le3 });
    check('1.13f 子进程环境里没有 JWT_SECRET（不分大小写），父进程里污染的值也没出现在日志里（线 .env 的值由服务自己的 dotenv 加载）', !upperNames.has('JWT_SECRET') && !logText.includes(EVIL_ENV.JWT_SECRET), { has: upperNames.has('JWT_SECRET') });
    check('1.14 子进程工作目录 = 线检出的 wbs-server', C.pathKey(logVal(logText, 'STUB_CWD')) === C.pathKey(path.join(wt, 'wbs-server')), logVal(logText, 'STUB_CWD'));
    check('1.15 输出里有「已启动」和 pid', hasLine(out1, '已启动') && hasLine(out1, String(p.pid)), out1);

    // 1.16 重复 start
    const s2 = await startLine(fx, 'ra', false);
    check('1.16 重复 start：拒绝（LINE_ALREADY_RUNNING，消息含「已在运行」）', s2.err && s2.err.code === 'LINE_ALREADY_RUNNING' && /已在运行/.test(s2.err.message), s2.err && s2.err.message);
    const reg2 = (await regOf(fx)).lines.ra;
    check('1.17 重复 start 之后登记里的进程原样、进程仍活着', same(reg2.process, p) && aliveI(p.pid));
    const st1 = await stopLine(fx, 'ra');
    check('1.18 stop 收尾成功', st1.err === null, st1.err && st1.err.message);

    // 1.18b 修复批 3（47R3c M）：启动前要求线 .env 存在且含非空 JWT_SECRET，否则 LINE_ENV_JWT_MISSING 拒启（父环境的 JWT_SECRET 是污染的，不会替补）；不 spawn（没有新日志）、登记 process 仍为 null
    const leFile = path.join(wt, 'wbs-server', '.env');
    const leOrig = rd(leFile);
    const leLines = leOrig.split(/\r?\n/);
    for (const [tag, text] of [
        ['线 .env 里没有 JWT_SECRET 这个键', leLines.filter((l) => !/^JWT_SECRET=/.test(l)).join('\n')],
        ['线 .env 里 JWT_SECRET 值为空', leLines.map((l) => (/^JWT_SECRET=/.test(l) ? 'JWT_SECRET=' : l)).join('\n')],
        ['线 .env 里 JWT_SECRET 只有空白', leLines.map((l) => (/^JWT_SECRET=/.test(l) ? 'JWT_SECRET=   ' : l)).join('\n')],
        ['线 .env 不存在', null],
    ]) {
        const beforeJ = logsOf(fx);
        if (text === null) fs.unlinkSync(leFile); else fs.writeFileSync(leFile, text);
        const sj = await startLine(fx, 'ra', true);
        fs.writeFileSync(leFile, leOrig);
        check(`1.18b ${tag}（父进程环境里有污染的 JWT_SECRET）：拒绝启动（LINE_ENV_JWT_MISSING，退出码 1 路径），消息含「JWT_SECRET」「line new 应已生成」「检查是否被改动」，不回显父环境的值`,
            sj.err && sj.err.code === 'LINE_ENV_JWT_MISSING' && /JWT_SECRET/.test(sj.err.message) && /line new 应已生成/.test(sj.err.message) && /检查是否被改动/.test(sj.err.message) && !sj.err.message.includes(EVIL_ENV.JWT_SECRET), sj.err && sj.err.message);
        // 修复批 3b（LOW-1）：消息给恢复指引（写新的随机 JWT_SECRET 并说明旧令牌失效，或 line remove 后重新 line new），且不再有「服务会退回默认值或拿不到」这种与现状（server.js 自 #76 起 fail-closed）不符的说法
        check(`1.18b2 ${tag}：消息给恢复指引（往线 wbs-server/.env 写新的随机 JWT_SECRET、之前签发的令牌失效；或 line remove 后重新 line new），且不含「退回默认值」「拿不到」`,
            sj.err && /往线 wbs-server\/\.env 写一个新的随机 JWT_SECRET/.test(sj.err.message) && /之前签发的令牌/.test(sj.err.message) && /line remove 后重新 line new/.test(sj.err.message) && !/退回默认值|拿不到/.test(sj.err.message), sj.err && sj.err.message);
        check(`1.18c ${tag}：没有起进程（没有新日志）、登记 process 仍为 null`, same(logsOf(fx), beforeJ) && (await regOf(fx)).lines.ra.process === null);
    }
    check('1.18d 对照：.env 还原后能正常启动（线 .env 有非空 JWT_SECRET），随后 stop 收尾', await (async () => {
        const sok = await startLine(fx, 'ra', true);
        if (sok.err === null) { const pk = (await regOf(fx)).lines.ra.process; if (pk) track(pk.pid); }
        const stk = await stopLine(fx, 'ra');
        return sok.err === null && stk.err === null;
    })());
    // 1.18e CLI 端到端：线 .env 缺 JWT_SECRET 时 line start 退出码 1（普通操作失败），输出带错误码，没有起进程
    fs.writeFileSync(leFile, leLines.filter((l) => !/^JWT_SECRET=/.test(l)).join('\n'));
    const beforeCli = logsOf(fx);
    const cj = runCli(['start', 'ra', ...rootsOf(fx)], Object.assign({}, process.env, EVIL_ENV, { STUB_CONTROL: fx.ctl }));
    fs.writeFileSync(leFile, leOrig);
    check('1.18e CLI：线 .env 缺 JWT_SECRET → line start 退出码 1，输出含错误码 LINE_ENV_JWT_MISSING，没有起进程（没有新日志）', cj.status === 1 && /LINE_ENV_JWT_MISSING/.test(`${cj.stdout}${cj.stderr}`) && same(logsOf(fx), beforeCli), { s: cj.status, o: `${cj.stdout}${cj.stderr}`.slice(0, 300) });

    // 1.19 端口被占：两种占法（0.0.0.0 / 仅 127.0.0.1）
    for (const host of ['0.0.0.0', '127.0.0.1']) {
        const before = logsOf(fx);
        // 连入即断开：被测代码正确时只会做一次回环连接探测；端口预检读错端口的实现（H1-B 修复批 1 的 e4 变异）会照常起子进程并轮询就绪、往这里发 HTTP 请求——
        //   不处理连入的服务端 socket 读不到对端的 FIN，dummy.close 的回调永不触发，套件在 finally 里静默挂住（循环清空后无汇总行退出），而不是报一条 FAIL
        const dummy = net.createServer((sock) => { sock.on('error', () => {}); sock.destroy(); });
        const listened = await new Promise((resolve) => { dummy.once('error', (e) => resolve(e)); dummy.listen({ port: TP[0], host }, () => resolve(null)); });
        check(`1.19a 前置：占端口夹具（${host}）监听成功（失败说明测试端口 ${TP[0]} 已被前面的错误实现 / 残留占用）`, listened === null, listened && listened.message);
        let sb = { err: null };
        try { if (listened === null) sb = await startLine(fx, 'ra', false); } finally { if (listened === null) await new Promise((resolve) => dummy.close(resolve)); }
        if (listened !== null) continue;
        check(`1.19 端口被占（${host}）：拒绝（LINE_PORT_BUSY，消息含端口）`, sb.err && sb.err.code === 'LINE_PORT_BUSY' && sb.err.message.includes(`端口 ${TP[0]} `), sb.err && sb.err.message);   // 文案是「端口 <port> 已被占用或不可用…」（line-run.js:359）：带「端口 」前缀和后随空格，PID 等其他数字串蒙不过去
        check(`1.19b 端口被占（${host}）：登记 process 仍为 null、没有新日志（没有起进程）`, (await regOf(fx)).lines.ra.process === null && same(logsOf(fx), before));
    }

    // 1.20 永不就绪 → 超时后自己起的进程被终止、登记仍为 null；日志尾部经脱敏
    setCtl(fx, { neverReady: true, leak: UNRELATED });
    let before = logsOf(fx);
    const sn = await startLine(fx, 'ra', false, { readyTimeoutMs: 6000 });   // 替身启动要先做一次自登记（约 1 秒，CIM 查询）才打印 STUB_PID：超时给足余量，日志里才一定有 PID
    const nlog = newestLog(fx, before);
    check('1.20 永不就绪：失败（LINE_START_FAILED，消息含「超时」）', sn.err && sn.err.code === 'LINE_START_FAILED' && /超时/.test(sn.err.message), sn.err && sn.err.message);
    const npid = nlog ? pidNum(logVal(rd(nlog), 'STUB_PID')) : NaN;
    check('1.20b 失败时留下了新日志，替身 PID 可从日志取到', Number.isSafeInteger(npid) && npid > 0, nlog);
    if (Number.isSafeInteger(npid)) track(npid);
    check('1.20c 超时后自己起的进程已被终止', Number.isSafeInteger(npid) && await waitDead(npid, 10000), npid);
    check('1.20d 登记 process 仍为 null；测试端口 TP[0] 已释放',(await regOf(fx)).lines.ra.process === null && await portFreeI(TP[0]));
    check('1.20e 错误消息带日志末尾（含 STUB_PID 行），且替身打到日志里的 .env 值被脱敏（[已脱敏]，原值不出现）', sn.err && /STUB_PID=/.test(sn.err.message) && sn.err.message.includes('[已脱敏]') && !sn.err.message.includes(UNRELATED), sn.err && sn.err.message);

    // 1.21 进程提前退出
    setCtl(fx, { exitNow: true, exitCode: 9 });
    before = logsOf(fx);
    const sx = await startLine(fx, 'ra', false);
    check('1.21 进程提前退出：失败（LINE_START_FAILED，消息含「提前退出」与退出码 9）', sx.err && sx.err.code === 'LINE_START_FAILED' && /提前退出/.test(sx.err.message) && /退出码 9/.test(sx.err.message), sx.err && sx.err.message);
    check('1.21b 提前退出后登记 process 仍为 null', (await regOf(fx)).lines.ra.process === null);

    // 1.22 实例冒名（服务答 /api/version 但 instance 不是线名）→ 视为未就绪，超时终止
    setCtl(fx, { instance: 'other-line' });
    before = logsOf(fx);
    const sw = await startLine(fx, 'ra', false, { readyTimeoutMs: 6000 });
    const wlog = newestLog(fx, before);
    const wpid = wlog ? pidNum(logVal(rd(wlog), 'STUB_PID')) : NaN;
    if (Number.isSafeInteger(wpid)) track(wpid);
    check('1.22 /api/version.instance 与线名不符：不算就绪，超时失败，消息提到实际返回的 other-line', sw.err && sw.err.code === 'LINE_START_FAILED' && /超时/.test(sw.err.message) && /other-line/.test(sw.err.message), sw.err && sw.err.message);
    check('1.22b 冒名的进程被终止、登记仍为 null', Number.isSafeInteger(wpid) && await waitDead(wpid, 10000) && (await regOf(fx)).lines.ra.process === null);

    // 1.22c 实例名正确但 mode=normal：不算就绪（只核 instance 不核 mode 的实现会放过它）
    setCtl(fx, { mode: 'normal' });
    before = logsOf(fx);
    const sm = await startLine(fx, 'ra', false, { readyTimeoutMs: 6000 });
    const mlog = newestLog(fx, before);
    const mpid = mlog ? pidNum(logVal(rd(mlog), 'STUB_PID')) : NaN;
    if (Number.isSafeInteger(mpid)) track(mpid);
    check('1.22c instance 正确但 mode=normal：不算就绪，超时失败，消息提到实际返回的 mode="normal"', sm.err && sm.err.code === 'LINE_START_FAILED' && /超时/.test(sm.err.message) && /mode="normal"/.test(sm.err.message), sm.err && sm.err.message);
    check('1.22d mode=normal 的进程被终止、登记为 null、端口释放', Number.isSafeInteger(mpid) && await waitDead(mpid, 10000) && (await regOf(fx)).lines.ra.process === null && await portFreeI(TP[0]));

    // 1.23 延迟就绪：放行文件控制（放行前 /api/version 返回 503 + mode=booting；放行后才就绪），不靠耗时断言
    const gate = path.join(fx.root, 'ready.gate');
    const counter = path.join(fx.root, 'version.count');
    setCtl(fx, { gateFile: gate, countFile: counter });
    let settled = null;
    const pend = startLine(fx, 'ra', false).then((r) => { settled = r; return r; });
    const waitCount = async (n, ms) => { const end = Date.now() + ms; while (Date.now() < end) { let c = 0; try { c = fs.statSync(counter).size; } catch (_) { c = 0; } if (c >= n) return c; await sleep(50); } return -1; };
    const c1 = await waitCount(2, 60000);
    const regMid = (await regOf(fx)).lines.ra.process;
    await sleep(500);
    check('1.23a 放行前 start 已轮询（/api/version 被请求 >= 2 次）而没有成功返回', c1 >= 2 && settled === null, { c1, settled: settled && (settled.err ? settled.err.message : 'ok') });
    check('1.23b 放行前登记已是 starting（早登记）：pid / start_time / cmd / instance 齐全', regMid !== null && regMid.state === 'starting' && regMid.instance === 'ra' && Number.isSafeInteger(regMid.pid) && typeof regMid.start_time === 'string' && regMid.cmd === `${process.execPath} ${path.join(wt, 'wbs-server', 'server.js')}`, regMid);
    const cBefore = (() => { try { return fs.statSync(counter).size; } catch (_) { return 0; } })();
    fs.writeFileSync(gate, 'go');
    const sd = await pend;
    const cAfter = (() => { try { return fs.statSync(counter).size; } catch (_) { return 0; } })();
    check('1.23c 放行后 start 成功，放行后又请求了至少 1 次，总请求 >= 3 次', sd.err === null && cAfter > cBefore && cAfter >= 3, { err: sd.err && sd.err.message, cBefore, cAfter });
    const regDone = (await regOf(fx)).lines.ra.process;
    check('1.23d 成功后登记升级为 running，pid 与放行前一致（同一个进程）', !sd.err && regDone !== null && regMid !== null && regDone.pid === regMid.pid && regDone.state === 'running', { regMid, regDone });
    if (!sd.err) { track(sd.res.pid); await stopLine(fx, 'ra'); }
    setCtl(fx, {});

    // 1.24 deps 不一致 → 拒绝；独立依赖模式不比对
    setCtl(fx, {});
    const pkgFile = path.join(wt, 'wbs-server', 'package.json');
    w(pkgFile, PKG_WBS_DEPCHG);   // 依赖不一致 = dependencies 里多一个包（只改 version 不算，见 1.24e 与节 H）
    before = logsOf(fx);
    const sdp = await startLine(fx, 'ra', false);
    check('1.24 依赖指纹不一致且 deps_mode=shared：拒绝（LINE_DEPS_MISMATCH，消息列出 wbs-server/package.json）', sdp.err && sdp.err.code === 'LINE_DEPS_MISMATCH' && /wbs-server\/package\.json/.test(sdp.err.message), sdp.err && sdp.err.message);
    check('1.24a 拒绝文案：不再指向不存在的「转为独立依赖」，改为「线内不得改依赖；确需改依赖请在本线锚点登记，交用户在场处理」', sdp.err && !/转为独立依赖/.test(sdp.err.message) && sdp.err.message.includes('线内不得改依赖；确需改依赖请在本线锚点登记，交用户在场处理'), sdp.err && sdp.err.message);
    check('1.24b 拒绝后没有起进程（登记 null、没有新日志、端口空闲）', (await regOf(fx)).lines.ra.process === null && same(logsOf(fx), before) && await portFreeI(TP[0]));
    // 1.24e 只差 version（/deploy 每次都改）：不算依赖变更，start 不因依赖被拒（防「整文件哈希」实现：部署后所有线 start 被拒）
    w(pkgFile, '{"name":"fixture-wbs","version":"9.9.9"}\n');
    const sdv = await startLine(fx, 'ra', false);
    check('1.24e wbs-server/package.json 只差 version：依赖指纹一致，start 成功（不因依赖被拒）', sdv.err === null, sdv.err && sdv.err.message);
    if (!sdv.err) { track(sdv.res.pid); const stv = await stopLine(fx, 'ra'); check('1.24f 只差 version 的线 stop 成功', stv.err === null, stv.err && stv.err.message); }
    w(pkgFile, '{"name":"fixture-wbs","version":"1.0.0"}\n');   // 还原（下面单独测「必需依赖文件缺失」）
    // 必需依赖文件清单（RUN.DEPS_FILES 里 optional=false 的三项，这里手写，不从被测代码取）逐项 × {仅主缺 / 仅线缺 / 两边都缺}：start 都必须拒绝，消息点出该文件与「缺失」
    const REQUIRED_DEPS = ['wbs-server/package.json', 'wbs-server/package-lock.json', 'package.json'];
    for (const rel of REQUIRED_DEPS) {
        const fM = path.join(fx.main, ...rel.split('/'));
        const fL = path.join(wt, ...rel.split('/'));
        for (const [label, files] of [['仅主工作区缺', [fM]], ['仅线检出缺', [fL]], ['两边都缺', [fM, fL]]]) {
            for (const f of files) fs.renameSync(f, `${f}.hidden`);
            before = logsOf(fx);
            let sm2;
            try { sm2 = await startLine(fx, 'ra', false); } finally { for (const f of files) fs.renameSync(`${f}.hidden`, f); }
            check(`1.24c 必需依赖文件 ${rel} 缺失（${label}）：共享依赖线拒绝启动（LINE_DEPS_MISMATCH，消息点出该文件与「缺失」）`, sm2.err && sm2.err.code === 'LINE_DEPS_MISMATCH' && new RegExp(`[：、]${rel.replace(/\./g, '\\.')}[、。]`).test(sm2.err.message) && /缺失/.test(sm2.err.message), sm2.err && sm2.err.message);
            check(`1.24d 缺失（${rel}，${label}）拒绝后没有起进程（登记 null、没有新日志、端口空闲）`, (await regOf(fx)).lines.ra.process === null && same(logsOf(fx), before) && await portFreeI(TP[0]));
        }
    }
    w(pkgFile, PKG_WBS_DEPCHG);   // 依赖确实不同（只差 version 的话指纹本来就一致，1.25 就测不出「独立依赖不比对」了）
    await S.updateLine(fx.control, 'ra', (r) => { r.deps_mode = 'independent'; });
    const si = await startLine(fx, 'ra', false);
    check('1.25 deps_mode=independent：不比对，照常启动', si.err === null, si.err && si.err.message);
    if (!si.err) { track(si.res.pid); const sti = await stopLine(fx, 'ra'); check('1.25b 独立依赖线 stop 成功', sti.err === null, sti.err && sti.err.message); }
    await S.updateLine(fx.control, 'ra', (r) => { r.deps_mode = 'shared'; });
    git(wt, ['checkout', '--', 'wbs-server/package.json']);

    // 1.26 前置条件拒绝
    const sn0 = await startLine(fx, 'no-such', false);
    check('1.26 不存在的线：LINE_NO_SUCH_LINE', sn0.err && sn0.err.code === 'LINE_NO_SUCH_LINE', sn0.err && sn0.err.message);
    await S.createLine(fx.control, 'cr', { module: 'mod-c', branch: 'line/cr', worktree: wtOf(fx, 'cr'), surface: 's', deps_mode: 'shared' });
    const scr = await startLine(fx, 'cr', false);
    check('1.27 lifecycle=creating 的线：拒绝（LINE_START_REFUSED）', scr.err && scr.err.code === 'LINE_START_REFUSED' && /creating/.test(scr.err.message), scr.err && scr.err.message);
    await S.updateLine(fx.control, 'cr', (r) => { r.lifecycle = 'failed'; r.failed_step = 'x'; });
    await S.updateLine(fx.control, 'cr', (r) => { r.lifecycle = 'removing'; r.failed_step = null; });
    await S.removeLineRecord(fx.control, 'cr');

    // 1.27b .sdh-instance 被写成别的线名：拒绝启动（LINE_START_REFUSED），没有起进程
    const idFile = path.join(wt, 'wbs-server', '.sdh-instance');
    const idOrig = rd(idFile);
    w(idFile, 'other-line\n');
    before = logsOf(fx);
    const sid = await startLine(fx, 'ra', false);
    w(idFile, idOrig);
    check('1.27b wbs-server/.sdh-instance 内容与线名不符：拒绝启动（LINE_START_REFUSED，消息点出 .sdh-instance），没有起进程（登记 null、没有新日志）', sid.err && sid.err.code === 'LINE_START_REFUSED' && /\.sdh-instance/.test(sid.err.message) && (await regOf(fx)).lines.ra.process === null && same(logsOf(fx), before), sid.err && sid.err.message);

    // 1.27c 升级 running 的登记写入失败（就绪确认之后、写登记之前，登记被改成「process 已清空且 lifecycle=removing」）：自己起的进程不能留成孤儿
    setCtl(fx, {});
    before = logsOf(fx);
    const sh = await withEnv(fx, false, () => attempt(() => RUN.lineStart(ctxOf(fx, [], { testHooks: { beforeRegister: async () => { await S.updateLine(fx.control, 'ra', (r) => { r.process = null; r.lifecycle = 'removing'; }); } } }), { name: 'ra' })));
    const hlog = newestLog(fx, before);
    const hpid = hlog ? pidNum(logVal(rd(hlog), 'STUB_PID')) : NaN;
    if (Number.isSafeInteger(hpid)) track(hpid);
    check('1.27c 登记升级失败：start 抛出 LINE_START_FAILED（登记在启动期间被改动，不升级为 running）', sh.err && sh.err.code === 'LINE_START_FAILED' && /登记在启动期间被改动/.test(sh.err.message), sh.err && sh.err.message);
    check('1.27d 登记升级失败时自己起的进程已被终止（不留孤儿）、端口释放、登记 process 为 null', Number.isSafeInteger(hpid) && await waitDead(hpid, 10000) && (await regOf(fx)).lines.ra.process === null && await portFreeI(TP[0]), hpid);

    const rm = await removeLine(fx, 'ra');
    check('1.28 收尾：line remove 成功', rm.err === null, rm.err && rm.err.message);
}

async function sec2() {
    section('2', 'line stop');
    const fx = await buildFixture('s2');
    const r0 = await newLine(fx, 'rb', 'mod-b');
    check('2.0 line new 建线成功', r0.err === null, r0.err && r0.err.message);
    if (r0.err) return;
    setCtl(fx, {});
    const startOk = async (id) => {
        const s = await startLine(fx, 'rb', false);
        check(`${id} start 成功`, s.err === null, s.err && s.err.message);
        if (s.err) return null;
        track(s.res.pid);
        return (await regOf(fx)).lines.rb.process;
    };

    // 2.1 正常停止
    let p = await startOk('2.1a');
    if (p) {
        const out = [];
        const st = await stopLine(fx, 'rb', {}, out);
        check('2.1 正常停止：返回 stopped、进程已消失、端口释放、登记清空、日志仍在', st.err === null && st.res.stopped === true && await waitDead(p.pid, 5000) && await portFreeI(TP[0]) && (await regOf(fx)).lines.rb.process === null && logsOf(fx).length >= 1, st.err && st.err.message);
        check('2.1b 输出有「已停止」', hasLine(out, '已停止'), out);
    }

    // 2.2 PID 复用（登记 PID 存活，创建时间被改）→ 不终止、登记清空
    p = await startOk('2.2a');
    if (p) {
        const realStart2 = ownStartTime(p.pid);
        await S.updateLine(fx.control, 'rb', (r) => { r.process.start_time = FAKE_START; });
        const out = [];
        const st = await stopLine(fx, 'rb', {}, out);
        check('2.2 创建时间不一致：stop 不终止（该进程仍活着），登记清空', st.err === null && st.res.stopped === false && st.res.cleared === true && aliveI(p.pid) && (await regOf(fx)).lines.rb.process === null, st.err && st.err.message);
        check('2.2b 输出提示「登记的进程已不存在，已清空登记」', hasLine(out, '登记的进程已不存在，已清空登记'), out);
        check('2.2c 该进程的服务仍然可响应（真的没被动过）', (await httpGetI(TP[0], '/api/version')).json && (await httpGetI(TP[0], '/api/version')).json.instance === 'rb');
        await killEntry({ pid: p.pid, start: realStart2 });   // 按「PID + 真实创建时间」收掉这个被故意改了登记的服务
    }

    // 2.3 登记 PID 已死
    p = await startOk('2.3a');
    if (p) {
        killTreeI(p.pid);
        await waitDead(p.pid, 10000);
        const st = await stopLine(fx, 'rb');
        check('2.3 登记的 PID 已死：stop 清空登记，不报错', st.err === null && st.res.stopped === false && st.res.cleared === true && (await regOf(fx)).lines.rb.process === null, st.err && st.err.message);
    }

    // 2.4 服务响应的 instance 与线名不符 → 拒绝、进程仍活着；非 JSON 响应同样拒绝；恢复后可正常停止
    p = await startOk('2.4a');
    if (p) {
        setCtl(fx, { instance: 'someone-else' });
        const st = await stopLine(fx, 'rb');
        check('2.4 /api/version.instance 与线名不符：拒绝终止（LINE_STOP_REFUSED），进程仍活着，登记原样', st.err && st.err.code === 'LINE_STOP_REFUSED' && /someone-else/.test(st.err.message) && aliveI(p.pid) && same((await regOf(fx)).lines.rb.process, p), st.err && st.err.message);
        setCtl(fx, {});
        const ok = await stopLine(fx, 'rb');
        check('2.4c 身份恢复后 stop 正常终止', ok.err === null && ok.res.stopped === true && await waitDead(p.pid, 5000), ok.err && ok.err.message);
    }

    // 2.4d 有 HTTP 响应但无法核实例身份（非 JSON / 响应头后正文中断 / 响应头后挂起 / 慢吐 / 超大）：命令行与创建时间都与登记一致 → 按进程身份终止并在输出里注明；
    //      每种都在有界时间内完成（整请求绝对截止，不被慢吐拖住）
    for (const [label, ctlObj, expectKind] of [['非 JSON', { badBody: true }, 'badbody'], ['响应头后正文中断', { brokenBody: true }, 'broken'], ['响应头后挂起', { stallBody: true }, 'broken'], ['每 0.2 秒吐 1 字节永不结束', { trickle: true }, 'broken'], ['超过 1MB 上限', { hugeBody: true }, 'broken']]) {
        const pq = await startOk(`2.4d(${label})a`);
        if (!pq) continue;
        setCtl(fx, ctlObj);
        // 2.4e 整请求绝对截止直接测 httpGetJson（记请求开始到结束，不含进程查询耗时）：截止 1500ms，允许 2500ms 调度余量；被测函数失去截止时由测试侧 race 判红，不挂起
        const tH = Date.now();
        const hv = await Promise.race([PR.httpGetJson(TP[0], '/api/version', 1500), sleep(1500 + 6000).then(() => ({ kind: 'HUNG（超过截止 + 6 秒仍未返回）' }))]);
        const msH = Date.now() - tH;
        check(`2.4e 响应异常（${label}）：httpGetJson 的整请求截止生效（截止 1500ms，实测 ${msH}ms <= 4000），且结果是 ${expectKind}`, msH <= 4000 && hv.kind === expectKind, { kind: hv.kind, msH });
        const out = [];
        const sq = await stopLine(fx, 'rb', {}, out);
        check(`2.4d 响应异常（${label}）：命令行一致 → 终止成功、登记清空、输出注明「服务响应异常，按进程身份终止」`, sq.err === null && sq.res.stopped === true && await waitDead(pq.pid, 5000) && (await regOf(fx)).lines.rb.process === null && hasLine(out, '服务响应异常') && hasLine(out, '按进程身份终止'), sq.err ? sq.err.message : out);
        setCtl(fx, {});
    }
    // 2.4h 合法 JSON 但没有可用的实例身份（{} / {"error":"…"} / instance 不是字符串 / instance 为空串）：创建时间与命令行一致 → 按进程身份终止并注明，不得永久拒绝
    for (const [label, raw] of [['{}', {}], ['{"error":"服务异常"}', { error: '服务异常' }], ['instance 是数字', { instance: 123, mode: 'isolated' }], ['instance 为空串', { instance: '', mode: 'isolated' }]]) {
        const pq = await startOk(`2.4h(${label})a`);
        if (!pq) continue;
        setCtl(fx, { rawJson: raw });
        const out = [];
        const sq = await stopLine(fx, 'rb', {}, out);
        check(`2.4h 响应是合法 JSON 但没有可用的实例身份（${label}）：终止成功、登记清空、输出注明「没有可用的实例身份」「按进程身份终止」`, sq.err === null && sq.res.stopped === true && await waitDead(pq.pid, 5000) && (await regOf(fx)).lines.rb.process === null && hasLine(out, '没有可用的实例身份') && hasLine(out, '按进程身份终止'), sq.err ? sq.err.message : out);
        setCtl(fx, {});
    }
    // 2.4i 明确给出的、与线名不同的字符串 instance：仍然拒绝（原有行为不退步）
    const pq2 = await startOk('2.4i-a');
    if (pq2) {
        setCtl(fx, { rawJson: { instance: 'other-line', mode: 'isolated' } });
        const sq2 = await stopLine(fx, 'rb');
        check('2.4i 响应明确给出不同的字符串 instance：拒绝终止（LINE_STOP_REFUSED），进程仍活着、登记原样', sq2.err && sq2.err.code === 'LINE_STOP_REFUSED' && /other-line/.test(sq2.err.message) && aliveI(pq2.pid) && same((await regOf(fx)).lines.rb.process, pq2), sq2.err && sq2.err.message);
        setCtl(fx, {});
        const sq3 = await stopLine(fx, 'rb');
        check('2.4i2 恢复后 stop 正常终止', sq3.err === null && sq3.res.stopped === true && await waitDead(pq2.pid, 5000), sq3.err && sq3.err.message);
    }

    // 2.4f 命令行不一致（登记的 cmd 被改）：无论服务响应正常还是不响应，一律拒绝，进程仍活着、登记原样
    for (const [label, ctlObj] of [['服务响应正常', {}], ['服务不响应', { hang: true }]]) {
        const pc = await startOk(`2.4f(${label})a`);
        if (!pc) continue;
        await S.updateLine(fx.control, 'rb', (r) => { r.process.cmd = `${r.process.cmd} --extra`; });
        const regAltered = (await regOf(fx)).lines.rb.process;
        setCtl(fx, ctlObj);
        const sc = await stopLine(fx, 'rb');
        check(`2.4f 登记的命令行与现场不一致（${label}）：拒绝终止（LINE_STOP_REFUSED，消息含「不一致」），进程仍活着、登记原样`, sc.err && sc.err.code === 'LINE_STOP_REFUSED' && /不一致/.test(sc.err.message) && aliveI(pc.pid) && same((await regOf(fx)).lines.rb.process, regAltered), sc.err && sc.err.message);
        await S.updateLine(fx.control, 'rb', (r) => { r.process.cmd = pc.cmd; });
        setCtl(fx, {});
        const sok = await stopLine(fx, 'rb');
        check(`2.4g 命令行恢复后 stop 正常终止（${label}）`, sok.err === null && sok.res.stopped === true && await waitDead(pc.pid, 5000), sok.err && sok.err.message);
    }

    // 2.5 服务连接上但不响应（挂起）→ 视为不可响应，PID + 创建时间一致即终止
    p = await startOk('2.5a');
    if (p) {
        setCtl(fx, { hang: true });
        const st = await stopLine(fx, 'rb');
        check('2.5 服务挂起不响应：PID + 创建时间一致，照常终止并清空登记', st.err === null && st.res.stopped === true && await waitDead(p.pid, 5000) && (await regOf(fx)).lines.rb.process === null, st.err && st.err.message);
        setCtl(fx, {});
    }

    // 2.6 未运行
    const out6 = [];
    const s6 = await stopLine(fx, 'rb', {}, out6);
    check('2.6 未运行的线：提示「未运行」，不报错', s6.err === null && s6.res.reason === 'not-running' && hasLine(out6, '未运行'), s6.err && s6.err.message);
    const s7 = await stopLine(fx, 'no-such');
    check('2.7 不存在的线：LINE_NO_SUCH_LINE', s7.err && s7.err.code === 'LINE_NO_SUCH_LINE', s7.err && s7.err.message);

    // 2.8 登记已死 → start 清空登记后继续启动
    p = await startOk('2.8a');
    if (p) {
        killTreeI(p.pid);
        await waitDead(p.pid, 10000);
        const out = [];
        const s = await startLine(fx, 'rb', false, {}, out);
        check('2.8 登记的进程已死：start 清空旧登记后照常启动（身份 = PID + 创建时间 不同于旧登记；不强求 PID 不同，PID 可能被合法复用）', s.err === null && hasLine(out, '已清空登记') && !(s.res.pid === p.pid && s.res.startTime === p.start_time), s.err && s.err.message);
        if (!s.err) { track(s.res.pid); const cur = (await regOf(fx)).lines.rb.process; check('2.8b 登记里是新进程', cur && cur.pid === s.res.pid && cur.start_time === s.res.startTime); await stopLine(fx, 'rb'); }
    }

    // 2.8c start 遇到「登记的 PID 仍存活、但创建时间不符」（PID 被复用）：不当成已在运行、不碰那个进程、清空旧登记后照常启动
    w(path.join(fx.root, 'decoy.js'), 'setInterval(function(){}, 1000);\n');
    const bait = await spawnHelper('', null, [path.join(fx.root, 'decoy.js')]);
    await S.updateLine(fx.control, 'rb', (r) => { r.process = { pid: bait.pid, start_time: FAKE_START, cmd: `${process.execPath} ${path.join(fx.root, 'decoy.js')}`, instance: 'rb', state: 'running' }; });
    const outBait = [];
    const sbait = await startLine(fx, 'rb', false, {}, outBait);
    check('2.8c 登记 PID 存活但创建时间不符：start 成功（不报「已在运行」）、诱饵进程仍活着、输出提示旧登记已清空（PID 已被其他进程复用）', sbait.err === null && aliveI(bait.pid) && hasLine(outBait, '已清空登记') && hasLine(outBait, '复用'), sbait.err ? sbait.err.message : outBait);
    if (!sbait.err) {
        track(sbait.res.pid);
        const curB = (await regOf(fx)).lines.rb.process;
        check('2.8d 新服务已登记（pid 不是诱饵、创建时间不是编造的旧值）、服务可响应', curB !== null && curB.pid !== bait.pid && curB.start_time !== FAKE_START && curB.state === 'running' && (await httpGetI(TP[0], '/api/version')).json.instance === 'rb', curB);
        const sB = await stopLine(fx, 'rb');
        check('2.8e 随后 stop 只终止新服务，诱饵进程仍毫发无损', sB.err === null && sB.res.stopped === true && aliveI(bait.pid), sB.err && sB.err.message);
    }
    killTreeI(bait.pid);
    await waitDead(bait.pid, 10000);

    // 2.9 只按登记的 PID 终止，绝不按端口：诱饵进程（登记着真实身份与命令行）+ 另一个进程占着槽位 1 的测试端口
    const decoyFile = path.join(fx.root, 'decoy2.js');
    w(decoyFile, 'setInterval(function(){}, 1000);\n');
    const decoy = await spawnHelper('', null, [decoyFile]);
    const holder = await spawnHelper(`require('net').createServer(function(s){ s.on('error', function(){}); }).listen(${TP[0]}, '0.0.0.0', function(){ console.log('HOLDER_UP'); }); setInterval(function(){}, 1000)`, 'HOLDER_UP');
    const dst = ownStartTime(decoy.pid);
    await S.updateLine(fx.control, 'rb', (r) => { r.process = { pid: decoy.pid, start_time: PR.getStartTime(decoy.pid), cmd: `${process.execPath} ${decoyFile}`, instance: 'rb' }; });
    check('2.9a 前置：诱饵与占端口者是两个不同的进程，测试端口 TP[0] 确实被占端口者监听', decoy.pid !== holder.pid && listenersOn(TP[0]).includes(holder.pid) && dst !== null, { d: decoy.pid, h: holder.pid, l: listenersOn(TP[0]) });
    const st9 = await stopLine(fx, 'rb');
    check('2.9 stop 终止的是登记的 PID（诱饵已死），占着端口的另一个进程毫发无损', st9.err === null && await waitDead(decoy.pid, 5000) && aliveI(holder.pid), st9.err && st9.err.message);
    check('2.9b 登记清空', (await regOf(fx)).lines.rb.process === null);
    killTreeI(holder.pid);
    await waitDead(holder.pid, 10000);
    check('2.9c 收尾：占端口者退出后，测试端口 TP[0] 在 10 秒内可再绑定（后面 2.11a 要在同一端口 start）', await waitPortBindable(TP[0], 10000), TP[0]);

    // 2.11 终止的是整棵进程树：替身起了一个长寿子进程，stop 之后子进程也必须退出
    setCtl(fx, { spawnChild: true });
    const before11 = logsOf(fx);
    const s11 = await startLine(fx, 'rb', false);
    check('2.11a 带长寿子进程的替身 start 成功', s11.err === null, s11.err && s11.err.message);
    if (!s11.err) {
        track(s11.res.pid);
        const childPid = pidNum(logVal(rd(newestLog(fx, before11)), 'STUB_CHILD_PID'));
        track(childPid);
        check('2.11b 前置：子进程 PID 有效且存活', Number.isSafeInteger(childPid) && aliveI(childPid), childPid);
        const st11 = await stopLine(fx, 'rb');
        check('2.11 stop 之后服务与它的长寿子进程都已退出（taskkill /T）', st11.err === null && await waitDead(s11.res.pid, 5000) && await waitDead(childPid, 8000), { err: st11.err && st11.err.message, childAlive: aliveI(childPid) });
        if (aliveI(childPid)) killTreeI(childPid);
    }
    setCtl(fx, {});

    // 2.12 进程身份查询失败（CIM 报错的非终止错误）≠ 进程不存在：stop 报 LINE_PROC_QUERY_FAILED，登记保留，进程不被终止；start 对已登记的存活进程同样保留登记
    const p12 = await startOk('2.12a');
    if (p12) {
        PR._test.psPrelude = FAIL_CIM_FN;
        const regKeep = (await regOf(fx)).lines.rb.process;
        let s12;
        let st12;
        let li12;
        try {
            s12 = await stopLine(fx, 'rb');
            st12 = await startLine(fx, 'rb', false);
            const o12 = [];
            li12 = await attempt(() => RUN.lineList(ctxOf(fx, o12, null), { json: true }));
            li12.json = li12.err ? null : JSON.parse(o12.join('\n'));
        } finally { PR._test.psPrelude = ''; }
        check('2.12 CIM 查询失败：stop 报 LINE_PROC_QUERY_FAILED（消息说明登记保留、没有终止任何进程）、进程仍活着、登记原样', s12.err && s12.err.code === 'LINE_PROC_QUERY_FAILED' && /登记保留/.test(s12.err.message) && aliveI(p12.pid) && same((await regOf(fx)).lines.rb.process, regKeep), s12.err && s12.err.message);
        check('2.12b CIM 查询失败：start 对已登记的存活进程报 LINE_PROC_QUERY_FAILED，不清登记、不起新进程', st12.err && st12.err.code === 'LINE_PROC_QUERY_FAILED' && same((await regOf(fx)).lines.rb.process, regKeep) && aliveI(p12.pid), st12.err && st12.err.message);
        check('2.12c CIM 查询失败：list 把进程状态标为「无法确认」（unknown），不是「登记失效」', li12.err === null && li12.json.lines[0].process.state === 'unknown', li12.err ? li12.err.message : li12.json.lines[0].process);
        // CIM 静默返回空（查不到但进程仍存活）：checkIdentity 再查一次仍查不到，必须抛查询失败，不得判 dead
        PR._test.psPrelude = EMPTY_CIM_FN;
        let s12b;
        try { s12b = await stopLine(fx, 'rb'); } finally { PR._test.psPrelude = ''; }
        check('2.12d CIM 静默返回空而进程存活：stop 报 LINE_PROC_QUERY_FAILED，不判进程已死、不清登记、不终止', s12b.err && s12b.err.code === 'LINE_PROC_QUERY_FAILED' && aliveI(p12.pid) && same((await regOf(fx)).lines.rb.process, regKeep), s12b.err && s12b.err.message);
        // killIfIdentity 单元：身份不符不终止；查询失败抛出且不终止；身份一致才终止
        const k1 = PR.killIfIdentity({ pid: p12.pid, start_time: FAKE_START });
        check('2.12e killIfIdentity：创建时间不符 → { killed:false, state:reused }，进程仍活着', k1.killed === false && k1.state === 'reused' && aliveI(p12.pid), k1);
        PR._test.psPrelude = FAIL_CIM_FN;
        let k2err = null;
        try { PR.killIfIdentity({ pid: p12.pid, start_time: p12.start_time }); } catch (e) { k2err = e; } finally { PR._test.psPrelude = ''; }
        check('2.12f killIfIdentity：CIM 查询失败 → 抛 LINE_PROC_QUERY_FAILED，进程仍活着（核对失败不终止）', k2err && k2err.code === 'LINE_PROC_QUERY_FAILED' && aliveI(p12.pid), k2err && k2err.message);
        // 2.12h killIfIdentity 已持句柄时遇到 CIM 静默返回空、进程仍存活：按查询失败（不判「进程不存在」、不据此清登记）。
        //       prelude：Get-Process 被调用之后（= killIfIdentity 的脚本）让 CIM 返回空；checkIdentity 用的 getProcInfo 脚本不调 Get-Process，所以 stop 能走到 killIfIdentity 这一步
        PR._test.psPrelude = EMPTY_AFTER_GET_PROCESS;
        let s12h;
        try { s12h = await stopLine(fx, 'rb'); } finally { PR._test.psPrelude = ''; }
        check('2.12h 已持句柄、CIM 静默返回空而进程仍存活：stop 报 LINE_PROC_QUERY_FAILED，不判进程已不存在、不清登记、不终止', s12h.err && s12h.err.code === 'LINE_PROC_QUERY_FAILED' && aliveI(p12.pid) && same((await regOf(fx)).lines.rb.process, regKeep), s12h.err ? s12h.err.message : s12h.res);
        // 2.12i / 2.12j Get-Process 查询失败 ≠ 进程不存在（终止脚本开头；收口小批 1）：Get-Process 报「非找不到」的错误 / 静默返回空 → stop 报 LINE_PROC_QUERY_FAILED，登记保留、进程存活（不得 exit 3 → dead → clearStale）
        PR._test.psPrelude = FAIL_GETPROCESS_FN;
        let s12i;
        let k12i = null;
        try {
            s12i = await stopLine(fx, 'rb');
            try { PR.killIfIdentity({ pid: p12.pid, start_time: p12.start_time }); } catch (e) { k12i = e; }
        } finally { PR._test.psPrelude = ''; }
        check('2.12i Get-Process 报错（非「找不到该进程」）：stop 报 LINE_PROC_QUERY_FAILED（登记保留）、进程仍活着、登记原样；killIfIdentity 同样抛查询失败', s12i.err && s12i.err.code === 'LINE_PROC_QUERY_FAILED' && /登记保留/.test(s12i.err.message) && aliveI(p12.pid) && same((await regOf(fx)).lines.rb.process, regKeep) && k12i && k12i.code === 'LINE_PROC_QUERY_FAILED', { s: s12i.err && s12i.err.message, k: k12i && k12i.message });
        PR._test.psPrelude = EMPTY_GETPROCESS_FN;
        let s12j;
        try { s12j = await stopLine(fx, 'rb'); } finally { PR._test.psPrelude = ''; }
        check('2.12j Get-Process 静默返回空（没有对象也没有错误）：同样按查询失败，不判进程不存在、不清登记、不终止', s12j.err && s12j.err.code === 'LINE_PROC_QUERY_FAILED' && aliveI(p12.pid) && same((await regOf(fx)).lines.rb.process, regKeep), s12j.err ? s12j.err.message : s12j.res);
        const k3 = PR.killIfIdentity({ pid: p12.pid, start_time: p12.start_time });
        check('2.12g killIfIdentity：身份一致 → 终止（killed:true），进程退出', k3.killed === true && k3.state === 'match' && await waitDead(p12.pid, 8000), k3);
        await S.updateLine(fx.control, 'rb', (r) => { r.process = null; });
    }

    // 2.13 killIfIdentity 对已死进程返回 dead，对不存在 PID 不报错
    const k4 = PR.killIfIdentity({ pid: 2147483000, start_time: FAKE_START });
    check('2.13 killIfIdentity 对不存在的 PID：{ killed:false, state:dead }', k4.killed === false && k4.state === 'dead', k4);

    const rm = await removeLine(fx, 'rb');
    check('2.10 收尾：line remove 成功', rm.err === null, rm.err && rm.err.message);
}

async function sec3() {
    section('3', '删线联动');
    const fx = await buildFixture('s3');
    const r0 = await newLine(fx, 'rc', 'mod-c');
    check('3.0 line new 建线成功', r0.err === null, r0.err && r0.err.message);
    if (r0.err) return;
    setCtl(fx, {});
    const s = await startLine(fx, 'rc', false);
    check('3.1 start 成功', s.err === null, s.err && s.err.message);
    if (s.err) return;
    track(s.res.pid);
    const wt = wtOf(fx, 'rc');
    const regBefore = (await regOf(fx)).lines.rc;
    const rm1 = await removeLine(fx, 'rc');
    check('3.2 运行中的线 line remove：拒绝（LINE_REMOVE_REFUSED，提示先 stop）', rm1.err && rm1.err.code === 'LINE_REMOVE_REFUSED' && /line stop/.test(rm1.err.message), rm1.err && rm1.err.message);
    check('3.3 拒绝后：登记原样、worktree 在、进程仍活着、服务仍响应', same((await regOf(fx)).lines.rc, regBefore) && fs.existsSync(wt) && aliveI(s.res.pid) && (await httpGetI(TP[0], '/api/version')).json.instance === 'rc');
    const st = await stopLine(fx, 'rc');
    check('3.4 stop 成功', st.err === null && st.res.stopped === true, st.err && st.err.message);
    const rm2 = await removeLine(fx, 'rc');
    const reg = await regOf(fx);
    check('3.5 stop 之后 remove 成功：worktree 已删、lines 为空、旧记录进 history', rm2.err === null && !fs.existsSync(wt) && Object.keys(reg.lines).length === 0 && reg.history.length === 1 && reg.history[0].name === 'rc', rm2.err && rm2.err.message);
    check('3.6 端口已释放', await portFreeI(TP[0]));
}

// ---- 第 4 节的夹具：三条线、手写期望

function gitIn(cwd, args) { return git(cwd, args); }
async function sec4() {
    section('4', 'list / overlap / check-deps');
    const fx = await buildFixture('s4');
    git(fx.main, ['config', 'status.showUntrackedFiles', 'no']);   // 用户配置里的「不显示未跟踪文件」不能影响 list（必须显式 --untracked-files=all）
    git(fx.main, ['tag', 'main']);                                   // 与分支同名的标签：用短名 main 会解析到标签（旧提交），必须用 refs/heads/ 全名
    for (const [n, m] of [['la', 'mod-a'], ['lb', 'mod-b'], ['lc', 'mod-c']]) {
        const r = await newLine(fx, n, m);
        check(`4.0 line new ${n} 成功`, r.err === null, r.err && r.err.message);
        if (r.err) return;
    }
    const wa = wtOf(fx, 'la'); const wb = wtOf(fx, 'lb'); const wc = wtOf(fx, 'lc');
    // la：两个提交（hello.txt 改、la-only.txt 新增；shared.txt 新增），未提交：docs/a.txt 改 + 子目录里两个未跟踪文件
    w(path.join(wa, 'wbs-server', 'hello.txt'), 'hello from la\n'); w(path.join(wa, 'wbs-server', 'la-only.txt'), 'la\n');
    gitIn(wa, ['add', 'wbs-server/hello.txt', 'wbs-server/la-only.txt']); gitIn(wa, ['commit', '-q', '-m', 'la c1']);
    w(path.join(wa, 'wbs-server', 'shared.txt'), 'shared from la\n');
    gitIn(wa, ['add', 'wbs-server/shared.txt']); gitIn(wa, ['commit', '-q', '-m', 'la c2']);
    w(path.join(wa, 'docs', 'a.txt'), 'doc a changed by la\n');
    w(path.join(wa, 'wbs-server', 'newdir', 'u1.txt'), 'u1\n'); w(path.join(wa, 'wbs-server', 'newdir', 'u2.txt'), 'u2\n');
    // lb：一个提交（shared.txt 新增、lb-only.txt 新增），无未提交
    w(path.join(wb, 'wbs-server', 'shared.txt'), 'shared from lb\n'); w(path.join(wb, 'wbs-server', 'lb-only.txt'), 'lb\n');
    gitIn(wb, ['add', 'wbs-server/shared.txt', 'wbs-server/lb-only.txt']); gitIn(wb, ['commit', '-q', '-m', 'lb c1']);
    // lc：无提交；未提交：hello.txt 改 + 中文名未跟踪文件
    w(path.join(wc, 'wbs-server', 'hello.txt'), 'hello from lc\n');
    w(path.join(wc, 'wbs-server', '中文 文件.txt'), 'cjk\n');
    // 集成分支前进一个提交：docs/a.txt 改、main-only.txt 新增
    w(path.join(fx.main, 'docs', 'a.txt'), 'doc a changed on main\n'); w(path.join(fx.main, 'wbs-server', 'main-only.txt'), 'main\n');
    git(fx.main, ['add', 'docs/a.txt', 'wbs-server/main-only.txt']); git(fx.main, ['commit', '-q', '-m', 'main moves']);

    // 进程状态：la 真启动；lb 登记着「PID 活着但创建时间不一致」；lc 无
    setCtl(fx, {});
    const sa = await startLine(fx, 'la', false);
    check('4.1 la start 成功（用于「运行中」）', sa.err === null, sa.err && sa.err.message);
    if (!sa.err) track(sa.res.pid);
    await S.updateLine(fx.control, 'lb', (r) => { r.process = { pid: process.pid, start_time: FAKE_START, cmd: 'x', instance: 'lb' }; });
    // 三条线各设不同的 lifecycle / integration / yield_request（硬编码默认值的实现过不了 4.9）
    const YIELD_LB = { reason: 'need-la', at: '2026-10-16T00:00:00Z' };
    await S.updateLine(fx.control, 'la', (r) => { r.integration = { state: 'verifying' }; });
    await S.updateLine(fx.control, 'lb', (r) => { r.integration = { state: 'conflict', reason: 'rc-1' }; r.yield_request = YIELD_LB; });
    await S.updateLine(fx.control, 'lc', (r) => { r.lifecycle = 'removing'; r.integration = { state: 'verified', B: 'bbb', H: 'hhh' }; });

    // ---- list（--json）
    const outJ = [];
    const lj = await attempt(() => RUN.lineList(ctxOf(fx, outJ, null), { json: true }));
    check('4.2 list --json 成功且输出是合法 JSON', lj.err === null && (() => { try { JSON.parse(outJ.join('\n')); return true; } catch (_) { return false; } })(), lj.err && lj.err.message);
    const J = lj.err ? null : JSON.parse(outJ.join('\n'));
    if (J) {
        check('4.3 集成分支用 refs/heads/ 全名；线按槽位排序 la / lb / lc', J.integration_ref === 'refs/heads/main' && same(J.lines.map((x) => x.name), ['la', 'lb', 'lc']), J);
        const [ja, jb, jc] = J.lines;
        check('4.4 la：领先 2 落后 1、未提交 3（--untracked-files=all 展开子目录两个文件 + 一个已跟踪改动）', ja.ahead === 2 && ja.behind === 1 && ja.uncommitted === 3, { ahead: ja.ahead, behind: ja.behind, unc: ja.uncommitted });
        check('4.5 la 已改文件 = 手写期望（提交改动 ∪ 未提交，排序）', same(ja.changed_files, ['docs/a.txt', 'wbs-server/hello.txt', 'wbs-server/la-only.txt', 'wbs-server/newdir/u1.txt', 'wbs-server/newdir/u2.txt', 'wbs-server/shared.txt']), ja.changed_files);
        check('4.6 lb：领先 1 落后 1、未提交 0、已改文件 [lb-only, shared]', jb.ahead === 1 && jb.behind === 1 && jb.uncommitted === 0 && same(jb.changed_files, ['wbs-server/lb-only.txt', 'wbs-server/shared.txt']), jb);
        check('4.7 lc：领先 0 落后 1、未提交 2（含中文名文件）、已改文件 [hello.txt, 中文 文件.txt]', jc.ahead === 0 && jc.behind === 1 && jc.uncommitted === 2 && same(jc.changed_files, ['wbs-server/hello.txt', 'wbs-server/中文 文件.txt']), jc);
        check('4.8 进程状态：la 运行中（带 pid）、lb 登记失效、lc 未运行', ja.process.state === 'running' && ja.process.pid === (sa.res && sa.res.pid) && jb.process.state === 'stale' && jc.process.state === 'none', [ja.process, jb.process, jc.process]);
        const pick = (x) => ({ name: x.name, lifecycle: x.lifecycle, failed_step: x.failed_step, integration: x.integration, yield_request: x.yield_request, module: x.module, branch: x.branch, slot: x.slot, port: x.port, deps_mode: x.deps_mode, ahead: x.ahead, behind: x.behind, uncommitted: x.uncommitted, changed_files: x.changed_files, changed_files_complete: x.changed_files_complete, notes: x.notes });
        const EXPECT_ROWS = [
            { name: 'la', lifecycle: 'ready', failed_step: null, integration: { state: 'verifying' }, yield_request: null, module: 'mod-a', branch: 'line/la', slot: 1, port: TP[0], deps_mode: 'shared', ahead: 2, behind: 1, uncommitted: 3, changed_files: ['docs/a.txt', 'wbs-server/hello.txt', 'wbs-server/la-only.txt', 'wbs-server/newdir/u1.txt', 'wbs-server/newdir/u2.txt', 'wbs-server/shared.txt'], changed_files_complete: true, notes: [] },
            { name: 'lb', lifecycle: 'ready', failed_step: null, integration: { state: 'conflict', reason: 'rc-1' }, yield_request: YIELD_LB, module: 'mod-b', branch: 'line/lb', slot: 2, port: TP[1], deps_mode: 'shared', ahead: 1, behind: 1, uncommitted: 0, changed_files: ['wbs-server/lb-only.txt', 'wbs-server/shared.txt'], changed_files_complete: true, notes: [] },
            { name: 'lc', lifecycle: 'removing', failed_step: null, integration: { state: 'verified', B: 'bbb', H: 'hhh' }, yield_request: null, module: 'mod-c', branch: 'line/lc', slot: 3, port: TP[2], deps_mode: 'shared', ahead: 0, behind: 1, uncommitted: 2, changed_files: ['wbs-server/hello.txt', 'wbs-server/中文 文件.txt'], changed_files_complete: true, notes: [] },
        ];
        check('4.9 list --json 每条线的 lifecycle / failed_step / integration / yield_request / module / 分支 / 槽位 / 端口 / 依赖模式 / 领先落后 / 未提交 / 已改文件 / 完整标记 / notes 与手写期望逐字段全等', same(J.lines.map(pick), EXPECT_ROWS), J.lines.map(pick));
    }
    const outT = [];
    const lt = await attempt(() => RUN.lineList(ctxOf(fx, outT, null), { json: false }));
    const textAll = outT.join('\n');
    check('4.10 list 文本输出含 运行中 / 登记失效 / 未运行 / refs/heads/main / 领先 2 落后 1', lt.err === null && ['运行中', '登记失效', '未运行', 'refs/heads/main', '领先 2 落后 1'].every((s) => textAll.includes(s)), textAll);
    const emptyFx = await buildFixture('s4empty');
    const outE = [];
    const le = await attempt(() => RUN.lineList(ctxOf(emptyFx, outE, null), { json: true }));
    check('4.11 没有线时 list --json 返回空数组', le.err === null && JSON.parse(outE.join('\n')).lines.length === 0, le.err && le.err.message);

    // ---- overlap
    const ov = async (name) => { const o = []; const r = await attempt(() => RUN.lineOverlap(ctxOf(fx, o, null), { name, json: true })); return { err: r.err, res: r.err ? null : JSON.parse(o.join('\n')), text: o }; };
    const oa = await ov('la');
    check('4.12 overlap la：与集成分支重叠 [docs/a.txt]（la 未提交改了它、集成分支自 merge-base 以来也改了）', oa.err === null && same(oa.res.with_integration.overlap, ['docs/a.txt']) && same(oa.res.with_integration.changed, ['docs/a.txt', 'wbs-server/main-only.txt']), oa.err ? oa.err.message : oa.res.with_integration);
    const byName = (res, n) => res.with_lines.find((x) => x.name === n);
    check('4.13 overlap la：与 lb 重叠 [shared.txt]，与 lc 重叠 [hello.txt]', oa.err === null && same(byName(oa.res, 'lb').overlap, ['wbs-server/shared.txt']) && same(byName(oa.res, 'lc').overlap, ['wbs-server/hello.txt']), oa.res && oa.res.with_lines);
    const ob = await ov('lb');
    check('4.14 overlap lb：与集成分支无重叠；与 la 重叠 [shared.txt]；与 lc 无重叠', ob.err === null && ob.res.with_integration.overlap.length === 0 && same(byName(ob.res, 'la').overlap, ['wbs-server/shared.txt']) && byName(ob.res, 'lc').overlap.length === 0, ob.res);
    const oc = await ov('lc');
    check('4.15 overlap lc：与集成分支无重叠（lc 的 hello.txt 集成分支没改）；与 la 重叠 [hello.txt]', oc.err === null && oc.res.with_integration.overlap.length === 0 && same(byName(oc.res, 'la').overlap, ['wbs-server/hello.txt']), oc.res);
    // 4.15b overlap 结果整体与手写期望全等（线名集合、条目数、changed、overlap、完整标记、notes、merge-base 都逐项核对，重复或多余条目也会判红）
    const mbOf = (n) => git(fx.main, ['merge-base', 'refs/heads/main', `refs/heads/line/${n}`]).trim();
    const LA = ['docs/a.txt', 'wbs-server/hello.txt', 'wbs-server/la-only.txt', 'wbs-server/newdir/u1.txt', 'wbs-server/newdir/u2.txt', 'wbs-server/shared.txt'];
    const LB = ['wbs-server/lb-only.txt', 'wbs-server/shared.txt'];
    const LCF = ['wbs-server/hello.txt', 'wbs-server/中文 文件.txt'];
    const MAINCH = ['docs/a.txt', 'wbs-server/main-only.txt'];
    const wl = (name, lifecycle, changed, overlap) => ({ name, lifecycle, changed, overlap, incomplete: false, notes: [] });
    const EXP_OA = { name: 'la', integration_ref: 'refs/heads/main', merge_base: mbOf('la'), own_files: LA, own_complete: true, with_integration: { changed: MAINCH, overlap: ['docs/a.txt'], incomplete: false }, with_lines: [wl('lb', 'ready', LB, ['wbs-server/shared.txt']), wl('lc', 'removing', LCF, ['wbs-server/hello.txt'])], notes: [] };
    const EXP_OB = { name: 'lb', integration_ref: 'refs/heads/main', merge_base: mbOf('lb'), own_files: LB, own_complete: true, with_integration: { changed: MAINCH, overlap: [], incomplete: false }, with_lines: [wl('la', 'ready', LA, ['wbs-server/shared.txt']), wl('lc', 'removing', LCF, [])], notes: [] };
    const EXP_OC = { name: 'lc', integration_ref: 'refs/heads/main', merge_base: mbOf('lc'), own_files: LCF, own_complete: true, with_integration: { changed: MAINCH, overlap: [], incomplete: false }, with_lines: [wl('la', 'ready', LA, ['wbs-server/hello.txt']), wl('lb', 'ready', LB, [])], notes: [] };
    check('4.15b overlap la / lb / lc 的完整结果对象与手写期望全等', same(oa.res, EXP_OA) && same(ob.res, EXP_OB) && same(oc.res, EXP_OC), { oa: oa.res, ob: ob.res, oc: oc.res });
    const outO = [];
    await attempt(() => RUN.lineOverlap(ctxOf(fx, outO, null), { name: 'la', json: false }));
    check('4.16 overlap 文本输出逐项列出重叠文件', ['docs/a.txt', 'wbs-server/shared.txt', 'wbs-server/hello.txt'].every((s) => outO.join('\n').includes(s)), outO);
    const on = await attempt(() => RUN.lineOverlap(ctxOf(fx, [], null), { name: 'no-such', json: true }));
    check('4.17 overlap 不存在的线：LINE_NO_SUCH_LINE', on.err && on.err.code === 'LINE_NO_SUCH_LINE', on.err && on.err.message);

    // ---- 收掉 la 的进程 / lb 的假登记，之后测 check-deps
    if (!sa.err) { const s = await stopLine(fx, 'la'); check('4.18 la stop 成功', s.err === null, s.err && s.err.message); }
    await S.updateLine(fx.control, 'lb', (r) => { r.process = null; });

    const cd = async (name) => { const o = []; const r = await attempt(() => RUN.lineCheckDeps(ctxOf(fx, o, null), { name })); return { err: r.err, res: r.res, out: o }; };
    // 指纹口径（H2）：package-lock.json 去掉根 name / version 后规范化序列化再 sha256。LOCK_WBS 去掉 name 后只剩 lockfileVersion，期望值手写成这个字面量串的 sha256（不用被测代码的序列化函数）
    const fp = () => sha256('{"lockfileVersion":3}');
    const c1 = await cd('lc');
    const stat = (c) => (c.res ? c.res.files.map((f) => `${f.rel}=${f.status}`) : null);
    check('4.19 check-deps 初始：三个受 git 跟踪的依赖文件一致，根 package-lock.json 跳过（线检出里没有）', c1.err === null && same(stat(c1), ['wbs-server/package.json=same', 'wbs-server/package-lock.json=same', 'package.json=same', 'package-lock.json=skipped']), c1.err ? c1.err.message : stat(c1));
    check('4.20 指纹 = 锁文件去掉根 name / version 后规范化序列化的 sha256（与测试侧手写字面量的 sha256 相同；线检出里可能是 CRLF，主工作区是 LF）', c1.err === null && c1.res.files[1].main === fp(LOCK_WBS) && c1.res.files[1].line === fp(LOCK_WBS), c1.res && c1.res.files[1]);
    w(path.join(wc, 'wbs-server', 'package-lock.json'), LOCK_WBS.replace(/\n/g, '\r\n'));
    const c2 = await cd('lc');
    check('4.21 线里是 CRLF 版本、内容相同：仍判一致', c2.err === null && c2.res.files[1].status === 'same' && c2.res.files[1].line === fp(LOCK_WBS), c2.err ? c2.err.message : c2.res.files[1]);
    w(path.join(wc, 'wbs-server', 'package-lock.json'), LOCK_WBS.replace('"lockfileVersion": 3', '"lockfileVersion": 4'));
    const c3 = await cd('lc');
    check('4.22 线里锁文件内容不同：check-deps 失败（LINE_DEPS_MISMATCH），差异文件 = wbs-server/package-lock.json', c3.err && c3.err.code === 'LINE_DEPS_MISMATCH' && same(c3.err.mismatches, ['wbs-server/package-lock.json']) && /wbs-server\/package-lock\.json/.test(c3.err.message), c3.err && c3.err.message);
    git(wc, ['checkout', '--', 'wbs-server/package-lock.json']);
    w(path.join(wc, 'package-lock.json'), LOCK_ROOT.replace('3', '5'));
    const c4 = await cd('lc');
    check('4.23 根 package-lock.json 两边都有且不同：判不一致；线里删掉后回到跳过', c4.err && same(c4.err.mismatches, ['package-lock.json']), c4.err && c4.err.message);
    fs.unlinkSync(path.join(wc, 'package-lock.json'));
    const c5 = await cd('lc');
    check('4.24 还原后再次一致', c5.err === null && c5.res.mismatches.length === 0, c5.err && c5.err.message);
    w(path.join(wc, 'wbs-server', 'package.json'), PKG_WBS_DEPCHG);   // 依赖确实不同（只差 version 不算，见 4.26b 与节 H）
    await S.updateLine(fx.control, 'lc', (r) => { r.deps_mode = 'independent'; });
    const c6 = await cd('lc');
    check('4.25 deps_mode=independent：报告不比对（即使文件不同），不失败', c6.err === null && c6.res.independent === true && c6.res.files.length === 0 && hasLine(c6.out, '独立依赖'), c6.err ? c6.err.message : c6.res);
    await S.updateLine(fx.control, 'lc', (r) => { r.deps_mode = 'shared'; });
    const c7 = await cd('lc');
    check('4.26 改回 shared：同一个差异文件（wbs-server/package.json）被报出', c7.err && same(c7.err.mismatches, ['wbs-server/package.json']), c7.err && c7.err.message);
    // 4.26b 只差 version：check-deps 判一致（防「整文件哈希」实现：部署一改 version，check-deps 就判红）
    w(path.join(wc, 'wbs-server', 'package.json'), '{"name":"fixture-wbs","version":"6.6.6"}\n');
    const c7b = await cd('lc');
    check('4.26b wbs-server/package.json 只差 version：check-deps 成功，该文件判一致', c7b.err === null && stat(c7b)[0] === 'wbs-server/package.json=same' && c7b.res.mismatches.length === 0, c7b.err ? c7b.err.message : stat(c7b));
    check('4.26c 只差 version 的那次输出标明口径：wbs-server/package.json 行是「依赖口径指纹（排除法」，没有「整文件指纹」', hasLine(c7b.out, '依赖口径指纹（排除法') && !hasLine(c7b.out, '整文件指纹'), c7b.out);
    // 4.26d 线检出的 wbs-server/ 下放 binding.gyp，package.json 仍只差 version：整文件比对 → 判不一致，输出标「整文件指纹」与原因
    w(path.join(wc, 'wbs-server', 'binding.gyp'), '{ "targets": [] }\n');
    const c7d = await cd('lc');
    try { fs.unlinkSync(path.join(wc, 'wbs-server', 'binding.gyp')); } catch (_) { /* 已不在 */ }
    check('4.26d 线检出多了 wbs-server/binding.gyp、package.json 只差 version：check-deps 失败（LINE_DEPS_MISMATCH），差异文件 = wbs-server/package.json，输出标「整文件指纹」与原因「binding.gyp」',
        c7d.err && c7d.err.code === 'LINE_DEPS_MISMATCH' && same(c7d.err.mismatches, ['wbs-server/package.json']) && hasLine(c7d.out, '整文件指纹') && hasLine(c7d.out, 'binding.gyp'), c7d.err ? { m: c7d.err.message, o: c7d.out } : c7d.res);
    git(wc, ['checkout', '--', 'wbs-server/package.json']);

    // ---- 必需依赖文件缺失：任一边缺失（含两边都缺）都判「缺失」→ check-deps 失败；可选的根锁文件缺失仍是跳过
    const hideF = (f) => fs.renameSync(f, `${f}.hidden`);
    const showF = (f) => fs.renameSync(`${f}.hidden`, f);
    // 必需依赖文件清单手写（不从被测代码取）逐项 × {仅主缺 / 仅线缺 / 两边都缺}：每项 check-deps 都必须失败，差异列表恰为该文件
    const cases = [];
    for (const rel of ['wbs-server/package.json', 'wbs-server/package-lock.json', 'package.json']) {
        const fM = path.join(fx.main, ...rel.split('/'));
        const fL = path.join(wc, ...rel.split('/'));
        cases.push([`仅主工作区缺 ${rel}`, [fM], rel], [`仅线检出缺 ${rel}`, [fL], rel], [`两边都缺 ${rel}`, [fM, fL], rel]);
    }
    for (const [label, files, rel] of cases) {
        for (const f of files) hideF(f);
        let cm;
        try { cm = await cd('lc'); } finally { for (const f of files) showF(f); }
        const ent = cm.err && cm.err.mismatches ? cm.err.mismatches : null;
        check(`4.28 必需依赖文件缺失（${label}）：check-deps 失败（LINE_DEPS_MISMATCH），差异列表恰为 [${rel}]，输出标「缺失」`, cm.err && cm.err.code === 'LINE_DEPS_MISMATCH' && same(ent, [rel]) && hasLine(cm.out, '缺失'), cm.err ? { m: cm.err.message, ent } : cm.res);
    }
    const cback = await cd('lc');
    check('4.28b 文件还原后 check-deps 再次一致', cback.err === null && cback.res.mismatches.length === 0, cback.err && cback.err.message);
    // 可选的根 package-lock.json（不受 git 跟踪）单独保留跳过规则：仅主缺 / 仅线缺 / 两边都缺 都是 skipped，不算不一致
    const rootLockMain = path.join(fx.main, 'package-lock.json');
    const rootLockLine = path.join(wc, 'package-lock.json');
    for (const [label, hideMain, putLine] of [['仅线检出有、主工作区缺', true, true], ['两边都缺', true, false]]) {
        if (hideMain) hideF(rootLockMain);
        if (putLine) w(rootLockLine, LOCK_ROOT);
        let co;
        try { co = await cd('lc'); } finally { if (hideMain) showF(rootLockMain); if (putLine) fs.unlinkSync(rootLockLine); }
        check(`4.28c 可选根 package-lock.json（${label}）：跳过，不算不一致`, co.err === null && co.res.mismatches.length === 0 && co.res.files.find((f) => f.rel === 'package-lock.json').status === 'skipped', co.err ? co.err.message : co.res.files);
    }

    // ---- 改动集合完整性：任一来源（提交 / 未提交）未知时，overlap 标「数据不完整」，文本输出打印各线 notes，不把部分数据呈现成确定的零重叠
    const movedLc = `${wc}.moved`;
    fs.renameSync(wc, movedLc);
    let oi1;
    const outI1 = [];
    try {
        oi1 = await ov('la');
        await attempt(() => RUN.lineOverlap(ctxOf(fx, outI1, null), { name: 'la', json: false }));
    } finally { fs.renameSync(movedLc, wc); }
    const lcEnt = oi1.err ? null : oi1.res.with_lines.find((x) => x.name === 'lc');
    check('4.29 其他线 lc 的检出目录缺失（未提交改动未知）：条目 changed=[]（只剩提交部分）、overlap=[]、incomplete=true，notes 说明原因', same(lcEnt, { name: 'lc', lifecycle: 'removing', changed: [], overlap: [], incomplete: true, notes: ['worktree 不存在或不是已登记的检出，未提交改动未知'] }), oi1.err ? oi1.err.message : lcEnt);
    check('4.29b 文本输出：该线条目标「数据不完整」并打印它的 notes（【注意】线 lc：…未提交改动未知）', outI1.some((l) => /与线 lc/.test(l) && l.includes('数据不完整')) && outI1.some((l) => l.includes('【注意】线 lc：') && l.includes('未提交改动未知')), outI1);
    git(fx.main, ['branch', '-m', 'line/lb', 'line/lb-moved']);
    let oi2;
    const outI2 = [];
    try {
        oi2 = await ov('la');
        await attempt(() => RUN.lineOverlap(ctxOf(fx, outI2, null), { name: 'la', json: false }));
    } finally { git(fx.main, ['branch', '-m', 'line/lb-moved', 'line/lb']); }
    const lbEnt = oi2.err ? null : oi2.res.with_lines.find((x) => x.name === 'lb');
    check('4.30 其他线 lb 的分支缺失（提交改动未知，未提交可读且为空）：条目 changed=[]、overlap=[]、incomplete=true（旧实现会显示成确定的「重叠 0 个」）', same(lbEnt, { name: 'lb', lifecycle: 'ready', changed: [], overlap: [], incomplete: true, notes: ['分支 line/lb 不存在'] }), oi2.err ? oi2.err.message : lbEnt);
    check('4.30b 文本输出打印该线 notes（分支 line/lb 不存在）且标「数据不完整」', outI2.some((l) => /与线 lb/.test(l) && l.includes('数据不完整')) && outI2.some((l) => l.includes('【注意】线 lb：分支 line/lb 不存在')), outI2);
    const oiOk = await ov('la');
    check('4.31 还原后 overlap la 恢复为完整结果（与 4.15b 手写期望全等）', same(oiOk.res, EXP_OA), oiOk.err ? oiOk.err.message : oiOk.res);

    // 收尾
    for (const n of ['la', 'lb', 'lc']) {
        const rm = await removeLine(fx, n, { discard: true });
        check(`4.27 收尾：remove --discard ${n}`, rm.err === null, rm.err && rm.err.message);
    }
}

// ---- 第 5 节：建线中断 → recover

async function workerMain(spec) {
    // 工作进程是独立进程：端口表要和父进程的测试表一致，否则它写进登记表的槽位端口（生产缺省）会让父进程读登记表时校验失败
    S._internal.setSlotPortsForTest(spec.slotPorts);
    const ctx = {
        mainRoot: spec.mainRoot, controlRoot: spec.controlRoot, linesRoot: spec.linesRoot, out: () => {},
        testHooks: { afterStep: async (step) => { if (step === spec.hangAfter) { fs.writeFileSync(spec.flagFile, step); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2147483647); } } },
    };
    await N.lineNew(ctx, spec.args);
}

async function sec5() {
    section('5', 'recover');
    const fx = await buildFixture('s5');
    const flag = path.join(fx.root, 'hung.flag');
    const spec = { mainRoot: fx.main, controlRoot: fx.control, linesRoot: fx.lines, hangAfter: 'owner_record', flagFile: flag, args: newArgs('rx', 'mod-r'), slotPorts: TP };
    const child = spawn(process.execPath, [__filename, `--lines-dir=${LINES_DIR}`, `--worker=${Buffer.from(JSON.stringify(spec)).toString('base64')}`], { stdio: 'ignore', windowsHide: true });
    track(child.pid);
    const deadline = Date.now() + 180000;
    while (!fs.existsSync(flag) && Date.now() < deadline && aliveI(child.pid)) await sleep(100);
    check('5.0 建线工作进程停在 owner_record 步骤之后（持有线级锁，已建 worktree；S2b 定稿起步骤名由 owner_marker 改为 owner_record）', fs.existsSync(flag), 'flag 文件没有出现');
    if (!fs.existsSync(flag)) { killTreeI(child.pid); return; }
    const reg0 = (await regOf(fx)).lines.rx;
    check('5.1 此时登记 lifecycle=creating', reg0 && reg0.lifecycle === 'creating', reg0);

    // 5.2 建线进行中：recover 拒绝，什么都不改
    const rb = await attempt(() => RUN.lineRecover(ctxOf(fx, [], { lineLockTimeoutMs: 1500 }), { name: 'rx' }));
    check('5.2 建线仍在进行（线级锁被持有）：recover 拒绝（LINE_RECOVER_BUSY，消息含「建线仍在进行」）', rb.err && rb.err.code === 'LINE_RECOVER_BUSY' && /建线仍在进行/.test(rb.err.message), rb.err && rb.err.message);
    check('5.2b 拒绝后登记原样（仍 creating）', same((await regOf(fx)).lines.rx, reg0));
    const cb = runCli(['recover', 'rx', ...rootsOf(fx)]);
    check('5.3 CLI recover 同样拒绝：退出码 1，stderr 含「建线仍在进行」', cb.status === 1 && /建线仍在进行/.test(cb.stderr), { s: cb.status, e: cb.stderr });

    // 5.4 强杀建线进程（锁由系统释放）→ recover 成功
    killTreeI(child.pid);
    check('5.4 建线工作进程已被强杀', await waitDead(child.pid, 15000));
    const rec = await attempt(() => RUN.lineRecover(ctxOf(fx, [], null), { name: 'rx' }));
    const reg1 = (await regOf(fx)).lines.rx;
    check('5.5 recover 成功：lifecycle=failed、failed_step=interrupted、代次与槽位不变', rec.err === null && reg1.lifecycle === 'failed' && reg1.failed_step === 'interrupted' && reg1.generation === reg0.generation && reg1.slot === reg0.slot, rec.err ? rec.err.message : reg1);
    const again = await attempt(() => RUN.lineRecover(ctxOf(fx, [], null), { name: 'rx' }));
    check('5.6 对已是 failed 的线再 recover：拒绝（LINE_RECOVER_REFUSED，只处理 creating），登记不变', again.err && again.err.code === 'LINE_RECOVER_REFUSED' && same((await regOf(fx)).lines.rx, reg1), again.err && again.err.message);
    const nosuch = await attempt(() => RUN.lineRecover(ctxOf(fx, [], null), { name: 'no-such' }));
    check('5.7 recover 不存在的线：LINE_NO_SUCH_LINE', nosuch.err && nosuch.err.code === 'LINE_NO_SUCH_LINE', nosuch.err && nosuch.err.message);

    // 5.8 之后可用 remove --discard 清理
    const rm = await removeLine(fx, 'rx', { discard: true });
    const reg2 = await regOf(fx);
    check('5.8 remove --discard 清理成功：worktree 与分支已清、lines 为空、旧记录进 history', rm.err === null && !fs.existsSync(wtOf(fx, 'rx')) && Object.keys(reg2.lines).length === 0 && reg2.history.length === 1 && reg2.history[0].name === 'rx', rm.err && rm.err.message);
    check('5.9 分支 line/rx 已清（与 main 同提交 = 已合入）', git(fx.main, ['branch', '--list', 'line/rx']).trim() === '');

    // 5.10 对 ready 的线 recover：拒绝
    const r2 = await newLine(fx, 'ry', 'mod-y');
    if (!r2.err) {
        const regY = (await regOf(fx)).lines.ry;
        const ry = await attempt(() => RUN.lineRecover(ctxOf(fx, [], null), { name: 'ry' }));
        check('5.10 ready 的线 recover：拒绝，登记不变', ry.err && ry.err.code === 'LINE_RECOVER_REFUSED' && same((await regOf(fx)).lines.ry, regY), ry.err && ry.err.message);
        await removeLine(fx, 'ry');
    } else check('5.10 前置：建线 ry', false, r2.err.message);
}

// ---- 第 6 节：修复批 1 加固（冒名 / 信号 / CLI 被强杀 / 收尾不依赖复核）

async function sec6() {
    section('6', '修复批 1 加固');
    const fx = await buildFixture('s6');
    const r0 = await newLine(fx, 'rd', 'mod-d');
    check('6.0 line new 建线成功', r0.err === null, r0.err && r0.err.message);
    if (r0.err) return;
    const regNow = async () => (await regOf(fx)).lines.rd.process;
    const waitReg = async (pred, ms) => { const end = Date.now() + ms; for (;;) { const p = await regNow(); if (pred(p)) return p; if (Date.now() > end) return undefined; await sleep(100); } };

    // 6.1 就绪响应必须来自本次子进程：本线子进程还在慢启动（5 秒后才监听），另一个进程抢先占了槽位端口并答对 instance / mode ——
    //     start 必须判冒名失败、终止自己的子进程、登记仍为 null，而不能把没有服务的子进程登记成 running，也不能去动那个抢占者
    setCtl(fx, { delayMs: 5000 });
    const impSrc = `require('http').createServer(function(q, r){ r.setHeader('Content-Type', 'application/json'); r.end(JSON.stringify({ mode: 'isolated', instance: 'rd', who: 'impostor' })); }).listen(${TP[0]}, '0.0.0.0', function(){ console.log('IMP_UP'); }); setInterval(function(){}, 1000)`;
    let imp = null;
    let impBusy = false;
    let impErr = null;
    const before1 = logsOf(fx);
    const watcher = setInterval(() => {
        if (imp || impBusy || logsOf(fx).length <= before1.length) return;   // 启动日志出现 = portAvailable 已通过、子进程已 spawn
        impBusy = true;
        spawnHelper(impSrc, 'IMP_UP').then((c) => { imp = c; }, (e) => { impErr = e; });
    }, 20);
    let s1;
    try { s1 = await startLine(fx, 'rd', false, { readyTimeoutMs: 30000 }); } finally { clearInterval(watcher); }
    const ilog = newestLog(fx, before1);
    const ipid = ilog ? pidNum(logVal(rd(ilog), 'STUB_PID')) : NaN;
    if (Number.isSafeInteger(ipid)) track(ipid);
    check('6.1a 前置：抢占者在子进程之后抢到了槽位 1 的测试端口', imp !== null && impErr === null && listenersOn(TP[0]).includes(imp.pid), impErr ? impErr.message : { imp: imp && imp.pid, l: listenersOn(TP[0]) });
    check('6.1 抢占者答对 instance / mode：start 仍判冒名失败（LINE_START_FAILED，消息点出监听进程 PID 与子进程 PID）', s1.err && s1.err.code === 'LINE_START_FAILED' && /不是本次启动的子进程发出的/.test(s1.err.message) && imp !== null && s1.err.message.includes(String(imp.pid)), s1.err ? s1.err.message : s1.res);
    check('6.1b 登记 process 仍为 null；自己起的子进程已终止；抢占者毫发无损（仍活着、仍占着端口）', (await regNow()) === null && Number.isSafeInteger(ipid) && await waitDead(ipid, 10000) && imp !== null && aliveI(imp.pid) && listenersOn(TP[0]).includes(imp.pid), { reg: await regNow(), ipid, imp: imp && aliveI(imp.pid) });
    if (imp) { killTreeI(imp.pid); await waitDead(imp.pid, 10000); }
    check('6.1c 收尾：抢占者退出后，测试端口 TP[0] 在 10 秒内可再绑定（后面的用例还要用）', await waitPortBindable(TP[0], 10000), TP[0]);

    // 6.2 信号处理：start 轮询就绪期间收到 SIGINT —— 收掉自己的子进程、清登记、以 130 退出（测试里 onSignalExit 换成记录），start 本身以「收到终止信号」失败
    const gate2 = path.join(fx.root, 'never.gate');
    setCtl(fx, { gateFile: gate2 });
    let exitCode = null;
    const sigBefore = ['SIGINT', 'SIGBREAK', 'SIGHUP'].map((s) => process.listenerCount(s));
    const pendSig = startLine(fx, 'rd', false, { readyTimeoutMs: 25000, onSignalExit: (c) => { exitCode = c; } });
    const pStarting = await waitReg((p) => p !== null && p.state === 'starting', 60000);
    check('6.2a 前置：登记里出现 starting', pStarting !== undefined && pStarting !== null, pStarting);
    if (pStarting) track(pStarting.pid);
    const sigDuring = ['SIGINT', 'SIGBREAK', 'SIGHUP'].map((s) => process.listenerCount(s));
    process.emit('SIGINT');
    const rSig = await pendSig;
    const endSig = Date.now() + 15000;
    while (exitCode === null && Date.now() < endSig) await sleep(50);
    check('6.2b 启动期间 SIGINT / SIGBREAK / SIGHUP 各挂了一个处理函数', sigDuring.every((n, i) => n === sigBefore[i] + 1), { sigBefore, sigDuring });
    check('6.2 收到 SIGINT：退出处理被调用且退出码 130、子进程已终止、登记已清空、端口释放', exitCode === 130 && pStarting && await waitDead(pStarting.pid, 10000) && (await regNow()) === null && await portFreeI(TP[0]), { exitCode, reg: await regNow() });
    check('6.2c start 以「收到终止信号 SIGINT」失败（LINE_START_FAILED）', rSig.err && rSig.err.code === 'LINE_START_FAILED' && /收到终止信号 SIGINT/.test(rSig.err.message), rSig.err && rSig.err.message);
    check('6.2d start 结束后信号处理函数已摘除（监听数回到启动前）', ['SIGINT', 'SIGBREAK', 'SIGHUP'].every((s, i) => process.listenerCount(s) === sigBefore[i]), ['SIGINT', 'SIGBREAK', 'SIGHUP'].map((s) => process.listenerCount(s)));

    // 6.3 CLI 在轮询就绪期间被强杀（没有信号可处理）：早登记留下的 starting 让 stop 能按身份停掉 detached 服务；list 显示「启动中」；再 start 报已在运行
    const gate3 = path.join(fx.root, 'never3.gate');
    setCtl(fx, { gateFile: gate3 });
    const envCli = Object.assign({}, process.env, { STUB_CONTROL: fx.ctl });
    const cli = spawn(process.execPath, [path.join(LINES_DIR, 'line.js'), 'start', 'rd', '--ready-timeout', '120', ...rootsOf(fx)], { env: envCli, stdio: 'ignore', windowsHide: true });
    track(cli.pid);
    const pK = await waitReg((p) => p !== null && p.state === 'starting', 90000);
    check('6.3a 前置：CLI 起了服务并写下 starting 登记', pK !== undefined && pK !== null, pK);
    if (pK) {
        track(pK.pid);
        await sleep(300);
        const dead = new Promise((resolve) => cli.once('exit', resolve));
        cli.kill();
        await dead;
        check('6.3b CLI 被强杀后 detached 服务仍活着、登记仍是同一条 starting', aliveI(pK.pid) && same(await regNow(), pK), { alive: aliveI(pK.pid), reg: await regNow() });
        const oL = [];
        const lk = await attempt(() => RUN.lineList(ctxOf(fx, oL, null), { json: true }));
        check('6.3c list 把它显示为 starting（启动中），带 pid', lk.err === null && JSON.parse(oL.join('\n')).lines[0].process.state === 'starting' && JSON.parse(oL.join('\n')).lines[0].process.pid === pK.pid, lk.err && lk.err.message);
        const again = await startLine(fx, 'rd', false);
        check('6.3d 再 start：报已在运行（LINE_ALREADY_RUNNING，提示 starting），不起第二个进程', again.err && again.err.code === 'LINE_ALREADY_RUNNING' && /starting/.test(again.err.message) && same(await regNow(), pK), again.err && again.err.message);
        const sk = await stopLine(fx, 'rd');
        check('6.3e stop 按身份（PID + 创建时间 + 命令行）终止 starting 的服务：进程退出、登记清空、端口释放', sk.err === null && sk.res.stopped === true && await waitDead(pK.pid, 8000) && (await regNow()) === null && await portFreeI(TP[0]), sk.err && sk.err.message);
    } else { killTreeI(cli.pid); }

    // 6.4 收尾不依赖可能失败的身份复核（killOwn 的身份复核抛错仍收掉自己起的子进程）：早登记之后把 CIM 弄坏，再让就绪超时
    setCtl(fx, { neverReady: true });
    const before4 = logsOf(fx);
    let pid4 = NaN;   // 子进程 PID 从钩子取（超时收掉时替身可能还没打印 STUB_PID）
    const s4 = await withEnv(fx, false, () => attempt(() => RUN.lineStart(ctxOf(fx, [], { readyTimeoutMs: 5000, testHooks: { afterEarlyRegister: async (info) => { pid4 = info.pid; PR._test.psPrelude = FAIL_CIM_FN; } } }), { name: 'rd' })));
    PR._test.psPrelude = '';
    if (Number.isSafeInteger(pid4)) track(pid4);
    check('6.4 身份复核不可用（CIM 全坏）时就绪超时：start 以超时失败，自己起的子进程仍被终止、登记清空、端口释放', s4.err && s4.err.code === 'LINE_START_FAILED' && /超时/.test(s4.err.message) && Number.isSafeInteger(pid4) && await waitDead(pid4, 10000) && (await regNow()) === null && await portFreeI(TP[0]), s4.err && s4.err.message);

    // 6.5 取创建时间失败（CIM 坏）：start 失败，自己起的子进程被收掉（凭句柄），登记未写
    setCtl(fx, {});
    const before5 = logsOf(fx);
    PR._test.psPrelude = FAIL_CIM_FN;
    let s5;
    try { s5 = await startLine(fx, 'rd', false); } finally { PR._test.psPrelude = ''; }
    // 替身启动时要先做一次自登记（CIM 查询，约 1 秒）才打印 STUB_PID：start 失败后子进程可能在打印之前就被收掉（日志里没有 PID，正常）。
    // 等一个比自登记更长的时间再读日志：日志里出现了 PID 就必须已经退出（子进程没被收掉时它会在这段时间里打印出来）
    await sleep(4000);
    const log5 = newestLog(fx, before5);
    const pid5 = log5 ? pidNum(logVal(rd(log5), 'STUB_PID')) : NaN;
    if (Number.isSafeInteger(pid5) && pid5 > 0) track(pid5);
    check('6.5 取创建时间失败：start 报 LINE_START_FAILED（消息说明取创建时间失败）、子进程已终止（日志里没有 PID，或有 PID 但已退出）、登记为 null', s5.err && s5.err.code === 'LINE_START_FAILED' && /取进程创建时间失败/.test(s5.err.message) && (!(Number.isSafeInteger(pid5) && pid5 > 0) || await waitDead(pid5, 10000)) && (await regNow()) === null, s5.err && s5.err.message);

    // 6.6 start 超时失败：自己起的进程连同它的长寿子进程（整棵树）都被收掉
    setCtl(fx, { neverReady: true, spawnChild: true });
    const before6 = logsOf(fx);
    const s6 = await startLine(fx, 'rd', false, { readyTimeoutMs: 6000 });
    const log6 = newestLog(fx, before6);
    const txt6 = log6 ? rd(log6) : '';
    const pid6 = pidNum(logVal(txt6, 'STUB_PID'));
    const child6 = pidNum(logVal(txt6, 'STUB_CHILD_PID'));
    if (Number.isSafeInteger(pid6)) track(pid6);
    if (Number.isSafeInteger(child6)) track(child6);
    check('6.6 超时失败：服务与它的长寿子进程都已退出（killOwn 终止整棵树）、登记为 null', s6.err && s6.err.code === 'LINE_START_FAILED' && Number.isSafeInteger(child6) && await waitDead(pid6, 10000) && await waitDead(child6, 10000) && (await regNow()) === null, { err: s6.err && s6.err.message, pid6, child6 });
    setCtl(fx, {});

    const rm = await removeLine(fx, 'rd');
    check('6.9 收尾：line remove 成功', rm.err === null, rm.err && rm.err.message);
}

// ---- 第 7 节：修复批 2 加固（只支持 Windows / 转发模式信号 / 路径不可信任 / 早登记失败的提示 / 信号与主流程共享清理 / killOwn 的 exited 分支）

async function sec7() {
    section('7', '修复批 2 加固');
    const fx = await buildFixture('s7');
    for (const [n, m] of [['re', 'mod-e']]) {
        const r0 = await newLine(fx, n, m);
        check(`7.0 line new ${n} 建线成功`, r0.err === null, r0.err && r0.err.message);
        if (r0.err) return;
    }
    setCtl(fx, {});
    const regAll = async () => (await regOf(fx)).lines;
    const regProc = async (n) => (await regAll())[n].process;
    const SIGS = ['SIGINT', 'SIGBREAK', 'SIGHUP'];
    const sigCounts = () => SIGS.map((s) => process.listenerCount(s));

    // 7.1 只支持 Windows：身份查询 / 终止 / 端口监听者查询在非 Windows 一律抛固定文案；start / stop 入口先拒（不起进程、不动登记）
    const unsupported = (fn) => { try { fn(); return null; } catch (e) { return e; } };
    const okMsg = (e) => !!(e && e.code === 'LINE_PROC_UNSUPPORTED_PLATFORM' && e.message === '本工具只支持 Windows');
    const before71 = logsOf(fx);
    let e71;
    let sa71;
    let sb71;
    PR._test.platform = 'linux';
    try {
        e71 = [unsupported(() => PR.getProcInfo(process.pid)), unsupported(() => PR.killIfIdentity({ pid: 2147483000, start_time: FAKE_START })), unsupported(() => PR.killTree(2147483000)), unsupported(() => PR.portListeners(TP[0]))];
        sa71 = await startLine(fx, 're', false);
        sb71 = await stopLine(fx, 're');
    } finally { PR._test.platform = null; }
    check('7.1 非 Windows：getProcInfo / killIfIdentity / killTree / portListeners 一律抛 LINE_PROC_UNSUPPORTED_PLATFORM，文案固定为「本工具只支持 Windows」', e71.every(okMsg), e71.map((e) => e && `${e.code}:${e.message}`));
    check('7.1b 非 Windows：start / stop 入口先拒（同码同文案），没有起进程（没有新日志、登记 process 仍为 null）', okMsg(sa71.err) && okMsg(sb71.err) && same(logsOf(fx), before71) && (await regProc('re')) === null, { a: sa71.err && sa71.err.message, b: sb71.err && sb71.err.message });
    check('7.1c 平台恢复后身份查询照常（对照：上面的拒绝来自平台接缝，不是别的原因）', PR.getProcInfo(process.pid) !== null);

    // 7.2 转发模式：外层在 spawnSync 之前注册空的 SIGINT / SIGBREAK / SIGHUP 监听、结束后移除（含 spawnSync 抛异常时）；透传退出码
    const base72 = sigCounts();
    let during72 = null;
    const code72 = L.forwardRun('x.js', ['a'], { spawnSync: () => { during72 = sigCounts(); return { status: 7 }; } });
    const after72 = sigCounts();
    try { L.forwardRun('x.js', [], { spawnSync: () => { throw new Error('boom'); } }); } catch (_) { /* 预期：异常照常抛出 */ }
    const afterThrow72 = sigCounts();
    check('7.2 转发期间（spawnSync 被调用时）三个信号各多一个监听，结束后（含 spawnSync 抛异常）移除，退出码透传', same(L.FORWARD_SIGNALS, SIGS) && same(during72, base72.map((n) => n + 1)) && code72 === 7 && same(after72, base72) && same(afterThrow72, base72), { base72, during72, after72, afterThrow72, code72 });

    // 7.3 登记里的路径不可信任（expectedWorktree）：worktree 不在线目录根下 / 指向别处 / 分支被改 → start 与 check-deps 都拒绝（LINE_UNSAFE_PATH），不起进程
    const recE = (await regAll()).re;
    const logsE = logsOf(fx);
    for (const [label, patch] of [['worktree 指向线目录根之外（主工作区）', { worktree: fx.main }], ['worktree 指向线目录根之内的另一个目录', { worktree: path.join(fx.lines, 'other') }], ['worktree 指向别处', { worktree: path.join(fx.root, 'elsewhere') }], ['分支登记成别的名字', { branch: 'line/zzz' }]]) {
        await S.updateLine(fx.control, 're', (r) => { Object.assign(r, patch); });
        const sb = await startLine(fx, 're', false);
        const cb = await attempt(() => RUN.lineCheckDeps(ctxOf(fx, [], null), { name: 're' }));
        check(`7.3 登记路径不可信任（${label}）：start 与 check-deps 都拒绝（LINE_UNSAFE_PATH），没有起进程`, sb.err && sb.err.code === 'LINE_UNSAFE_PATH' && cb.err && cb.err.code === 'LINE_UNSAFE_PATH' && same(logsOf(fx), logsE) && (await regProc('re')) === null, { s: sb.err && `${sb.err.code}:${sb.err.message}`, c: cb.err && `${cb.err.code}:${cb.err.message}` });
        await S.updateLine(fx.control, 're', (r) => { r.worktree = recE.worktree; r.branch = recE.branch; });
    }
    const cOk = await attempt(() => RUN.lineCheckDeps(ctxOf(fx, [], null), { name: 're' }));
    check('7.3b 还原登记之后 check-deps 正常（对照）', cOk.err === null, cOk.err && cOk.err.message);

    const rm7 = await removeLine(fx, 're');
    check('7.9 收尾：line remove re 成功', rm7.err === null, rm7.err && rm7.err.message);
}

// ---- 第 8 节：修复批 2 加固（起服务的部分：登记没写成的提示 / 信号与主流程共享清理 / killOwn 的 exited 分支）

async function sec8() {
    section('8', '修复批 2 加固（起服务）');
    const fx = await buildFixture('s8');
    for (const [n, m] of [['re', 'mod-e'], ['rf', 'mod-f'], ['rg', 'mod-g']]) {
        const r0 = await newLine(fx, n, m);
        check(`8.0 line new ${n} 建线成功`, r0.err === null, r0.err && r0.err.message);
        if (r0.err) return;
    }
    setCtl(fx, {});
    const regAll = async () => (await regOf(fx)).lines;
    const regProc = async (n) => (await regAll())[n].process;
    const SIGS = ['SIGINT', 'SIGBREAK', 'SIGHUP'];
    const sigCounts = () => SIGS.map((s) => process.listenerCount(s));

    // 8.1 登记没写成时的提示不得承诺 line stop 接手
    //   A 早登记写失败（beforeEarlyRegister 钩子把线转成 removing，写 process 被状态层拒绝）+ 终止失败（killOwnFails 注入）：提示写完整进程身份与人工处理方法，不含接手承诺
    let pidA = NaN;
    const sA = await withEnv(fx, false, () => attempt(() => RUN.lineStart(ctxOf(fx, [], { readyTimeoutMs: 20000, stopTimeoutMs: 1000, testHooks: { killOwnFails: true, beforeEarlyRegister: async (info) => { pidA = info.pid; await S.updateLine(fx.control, 'rf', (r) => { r.lifecycle = 'removing'; }); } } }), { name: 'rf' })));
    let startA = null;
    if (Number.isSafeInteger(pidA) && aliveI(pidA)) { track(pidA); try { startA = ownStartTime(pidA); } catch (_) { startA = null; } }
    const msgA = sA.err ? sA.err.message : '';
    const cmdA = `${process.execPath} ${path.join(wtOf(fx, 'rf'), 'wbs-server', 'server.js')}`;
    check('8.1a 早登记写失败（状态层拒绝，STATE_PROCESS_REGISTERED）+ 终止失败：提示「登记没有写成」「line stop 无法接手」，并写出完整进程身份（PID、创建时间、命令行）', sA.err && sA.err.code === 'STATE_PROCESS_REGISTERED' && /登记没有写成/.test(msgA) && /line stop 无法接手/.test(msgA) && msgA.includes(`PID ${pidA}`) && startA !== null && msgA.includes(`创建时间 ${startA}`) && msgA.includes(cmdA), msgA);
    //   人工恢复指引（收口小批 2）：一条现成的同句柄命令（.Handle 先于 taskkill、含本次创建时间），不教裸 PID 终止
    const firstHandle = msgA.indexOf('.Handle');
    const firstTaskkill = msgA.toLowerCase().indexOf('taskkill');
    const encMatch = /powershell\.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ([A-Za-z0-9+/=]+)/.exec(msgA);
    const decoded = encMatch ? Buffer.from(encMatch[1], 'base64').toString('utf16le') : '';
    check('8.1a2 人工恢复指引：含 .Handle 且在 taskkill 之前、含本次精确创建时间；不含裸 PID 终止（taskkill /PID <pid>）的独立建议；EncodedCommand 解码后就是 同句柄+核创建时间+终止 的脚本', firstHandle !== -1 && firstTaskkill !== -1 && firstHandle < firstTaskkill && startA !== null && msgA.includes(`'${startA}'`) && !msgA.includes(`taskkill /PID ${pidA}`) && !/taskkill(\.exe)? \/PID \d+ \/T \/F[^\n]*$/m.test(msgA.split('\n').filter((l) => !l.startsWith('    ')).join('\n')) && decoded.includes('$p.Handle') && decoded.includes(`'${startA}'`) && decoded.indexOf('.Handle') < decoded.toLowerCase().indexOf('taskkill'), { firstHandle, firstTaskkill, hasEnc: !!encMatch });
    check('8.1b 同一提示不含「登记保留为 starting，可 line stop … 按身份终止」这种接手承诺', sA.err && !/登记保留为 starting/.test(msgA) && !/可 line stop/.test(msgA), msgA);
    check('8.1c 早登记写失败：登记里确实没有本次启动写下的进程（process 为 null）', (await regProc('rf')) === null);
    //   提示里的命令真的能用：直接执行它，创建时间一致 → 把残留进程终止（退出码 0）
    if (encMatch) {
        const rm8 = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encMatch[1]], { encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
        check('8.1a3 直接执行提示里的命令：退出码 0，残留进程被终止', rm8.status === 0 && await waitDead(pidA, 10000), { status: rm8.status, stderr: String(rm8.stderr || '').slice(0, 200), alive: aliveI(pidA) });
    }
    if (startA !== null) check('8.1d 注入的终止失败收尾：按「PID + 创建时间」把残留进程终止（测试侧）', await killEntry({ pid: pidA, start: startA }));
    //   B 已早登记但清理失败：提示保留为 starting、可 line stop 接手（对照）；随后真的 stop 能接手
    setCtl(fx, { neverReady: true });
    let pidB = NaN;
    const sB = await startLine(fx, 'rg', false, { readyTimeoutMs: 2500, stopTimeoutMs: 1000, testHooks: { killOwnFails: true, afterEarlyRegister: async (info) => { pidB = info.pid; } } });
    if (Number.isSafeInteger(pidB) && aliveI(pidB)) track(pidB);
    const procB = await regProc('rg');
    check('8.1e 已早登记但清理失败：提示「登记保留为 starting，可 line stop rg 按身份终止」', sB.err && sB.err.code === 'LINE_START_FAILED' && /登记保留为 starting，可 line stop rg 按身份终止/.test(sB.err.message), sB.err && sB.err.message);
    check('8.1f 此时登记里是 starting 的残留进程（pid 对得上），line stop 能接手：stop 终止它并清空登记', procB !== null && procB.pid === pidB && procB.state === 'starting' && (await stopLine(fx, 'rg')).err === null && await waitDead(pidB, 8000) && (await regProc('rg')) === null, procB);
    setCtl(fx, {});
    //   C 没取到创建时间（CIM 坏）+ 终止失败：生成不了带身份核对的命令，如实说明；不给任何按 PID 直接终止的写法（也不给 EncodedCommand）
    const beforeC = logsOf(fx);
    PR._test.psPrelude = FAIL_CIM_FN;
    let sC;
    try { sC = await startLine(fx, 'rg', false, { readyTimeoutMs: 20000, stopTimeoutMs: 1000, testHooks: { killOwnFails: true } }); } finally { PR._test.psPrelude = ''; }
    const msgC = sC.err ? sC.err.message : '';
    let pidC = NaN;
    const endC = Date.now() + 30000;
    while (!Number.isSafeInteger(pidC) && Date.now() < endC) {
        const lc = newestLog(fx, beforeC);
        pidC = lc ? pidNum(logVal(rd(lc), 'STUB_PID')) : NaN;
        if (!Number.isSafeInteger(pidC)) await sleep(200);
    }
    if (Number.isSafeInteger(pidC) && aliveI(pidC)) track(pidC);
    check('8.1g 没取到创建时间 + 终止失败：提示「没取到创建时间」，不给 EncodedCommand、不含任何 taskkill（不教按 PID 终止），登记 process 为 null', sC.err && sC.err.code === 'LINE_START_FAILED' && /创建时间 （没取到）/.test(msgC) && /没取到创建时间，生成不了/.test(msgC) && !/EncodedCommand/.test(msgC) && !/taskkill/i.test(msgC) && (await regProc('rg')) === null, msgC);
    if (Number.isSafeInteger(pidC) && aliveI(pidC)) {
        let stC = null;
        try { stC = ownStartTime(pidC); } catch (_) { stC = null; }
        if (stC !== null) await killEntry({ pid: pidC, start: stC });
        check('8.1h 收尾：8.1g 残留的服务进程已按「PID + 创建时间」终止', await waitDead(pidC, 10000));
    }

    // 8.2 信号与主流程共享一次性清理
    //   a 信号在最终登记（升级 running）写入期间到达（前面的检查点都已通过）：不得输出「已启动」，离开线级锁时清理已完成（进程已死、登记已清空），退出函数在清理之后以 130 调用
    const outS = [];
    let exitS = null;
    const sigBase = sigCounts();
    let pidS = NaN;
    const sS = await startLine(fx, 're', false, { readyTimeoutMs: 60000, onSignalExit: (c) => { exitS = c; }, testHooks: { cleanupDelayMs: 800, duringRunningUpgrade: (info) => { pidS = info.pid; setImmediate(() => process.emit('SIGINT')); } } }, outS);   // 信号在补丁返回之后才发（setImmediate；不在持状态锁的补丁里同步触发清理的外部命令）；清理故意慢 800ms：主流程不等它做完就离开线级锁的实现，返回时登记还没清
    const deadAtReturn = Number.isSafeInteger(pidS) && !aliveI(pidS);   // 刚返回（线级锁刚释放）就必须已经死了：不等待
    const regAtReturn = await regProc('re');
    if (Number.isSafeInteger(pidS) && aliveI(pidS)) track(pidS);
    const endS = Date.now() + 15000;
    while (exitS === null && Date.now() < endS) await sleep(50);
    check('8.2a 信号在最终登记期间到达：start 以「收到终止信号 SIGINT」失败（LINE_START_FAILED），输出里没有「已启动」', sS.err && sS.err.code === 'LINE_START_FAILED' && /收到终止信号 SIGINT/.test(sS.err.message) && !hasLine(outS, '已启动'), { err: sS.err && sS.err.message, out: outS });
    check('8.2b start 返回（线级锁释放）时清理已完成：子进程已终止、登记已清空；退出函数以 130 调用；信号处理函数已摘除', deadAtReturn && regAtReturn === null && exitS === 130 && same(sigCounts(), sigBase), { pidS, deadAtReturn, regAtReturn, exitS, sig: sigCounts() });
    //   c 信号在早登记写入期间到达（补丁返回之后、写入调用尚未返回；此时 registered 还是 false）：登记落盘之后仍要被清掉（clearRegistration 不以 registered 为前提），不留指向已死进程的 starting 登记
    const outE = [];
    let exitE = null;
    let pidE = NaN;
    const sE = await startLine(fx, 'rg', false, { readyTimeoutMs: 60000, onSignalExit: (c) => { exitE = c; }, testHooks: { duringEarlyRegister: (info) => { pidE = info.pid; setImmediate(() => process.emit('SIGINT')); } } }, outE);   // 同上：补丁返回之后再发信号
    const deadE = Number.isSafeInteger(pidE) && !aliveI(pidE);
    const regE = await regProc('rg');
    if (Number.isSafeInteger(pidE) && aliveI(pidE)) track(pidE);
    check('8.2c 信号在早登记写入期间到达：start 以「收到终止信号」失败，没有「已启动」，返回时子进程已终止、登记 process 为 null（不留指向已死进程的 starting）', sE.err && sE.err.code === 'LINE_START_FAILED' && /收到终止信号 SIGINT/.test(sE.err.message) && !hasLine(outE, '已启动') && deadE && regE === null, { err: sE.err && sE.err.message, deadE, regE });

    // 8.3 killOwn 的 exited 分支：子进程已被 Node 认定退出就直接判已终止（不再调 killIfIdentity）。即使此时身份查询全坏（CIM 报错），提示也必须是「已终止、登记已清空」，不是「仍未退出」
    setCtl(fx, { neverReady: true, exitAfterMs: 4000 });
    //     killIfIdentity 用调用记录替身包一层（退出后的进程 Get-Process 常常已查不到，单靠 CIM 注入不一定走进复核）：整个 start 期间它一次都不该被调用
    let pid76 = NaN;
    const killCalls = [];
    const origKill = PR.killIfIdentity;
    PR.killIfIdentity = (...a) => { killCalls.push(a); return origKill(...a); };
    let s6;
    try {
        s6 = await startLine(fx, 'rg', false, { readyTimeoutMs: 60000, testHooks: { afterEarlyRegister: async (info) => { pid76 = info.pid; PR._test.psPrelude = FAIL_CIM_FN; } } });
    } finally { PR.killIfIdentity = origKill; PR._test.psPrelude = ''; }
    if (Number.isSafeInteger(pid76) && aliveI(pid76)) track(pid76);
    check('8.3 子进程自己退出后失败：LINE_START_FAILED「进程提前退出」，提示「自己起的进程已终止，登记已清空」（不是「仍未退出」），登记 process 为 null；killIfIdentity 一次都没被调用', s6.err && s6.err.code === 'LINE_START_FAILED' && /提前退出/.test(s6.err.message) && /自己起的进程已终止，登记已清空/.test(s6.err.message) && !/仍未退出/.test(s6.err.message) && (await regProc('rg')) === null && killCalls.length === 0, { err: s6.err && s6.err.message, killCalls: killCalls.length });
    setCtl(fx, {});

    for (const n of ['re', 'rf', 'rg']) {
        const rm = await removeLine(fx, n);
        check(`8.9 收尾：line remove ${n} 成功`, rm.err === null, rm.err && rm.err.message);
    }
}

// ---- 第 T 节：测试基础设施自检（11T 的 H2 / H3：helper 提前退出、PID 复用的新身份、查询失败判红、终止失败保留并报告）

async function secT() {
    section('T', '测试基础设施自检');
    // T.1 spawnHelper 提前退出：reject 并带退出码，没有走「20 秒内没就绪」的超时路径。用可控的登记查询替身（TRACKER.query）排除真实 CIM 查询的耗时，不做总耗时断言
    TRACKER.query = () => null;
    let e1 = null;
    // 与一个 8 秒计时器赛跑：spawnHelper 在提前退出时不 reject 的实现会让 Promise 永远不落定（进程静默退出、没有汇总），这里让它变成一条断言失败
    try { await Promise.race([spawnHelper('process.exit(3)', 'NEVER_PRINTED_MARKER'), sleep(8000).then(() => { throw new Error('HUNG：spawnHelper 在提前退出 8 秒后仍未 reject'); })]); } catch (e) { e1 = e; } finally { TRACKER.query = null; }
    check('T.1 spawnHelper 在就绪标记之前提前退出：reject 的消息带退出码 3，且没有走「20 秒内没就绪」的超时路径', e1 !== null && /退出码 3/.test(e1.message) && !/20 秒内就绪/.test(e1.message), e1 && e1.message);

    // T.2 同一 PID 的不同创建时间 = 不同身份，各自登记（PID 复用）
    const saved = Array.from(TRACK.entries());
    TRACK.clear();
    registerEntry(2147483001, '2001-01-01T00:00:00.0000000Z');
    registerEntry(2147483001, '2002-02-02T00:00:00.0000000Z');
    registerEntry(2147483001, '2002-02-02T00:00:00.0000000Z');
    check('T.2 同 PID 两个创建时间登记为两条，完全相同的身份不重复登记', TRACK.size === 2, Array.from(TRACK.keys()));
    TRACK.clear();
    for (const [k, v] of saved) TRACK.set(k, v);

    // T.3 创建时间查询失败不得静默忽略：判红
    SINK = [];
    FAULT.ps = true;
    try { track(process.pid); } finally { FAULT.ps = false; }
    const got3 = SINK;
    SINK = null;
    check('T.3 track 时创建时间查询失败：报告一条失败（不是静默忽略），也没有登记任何身份', got3.length === 1 && /创建时间查询失败/.test(got3[0]) && !Array.from(TRACK.values()).some((e) => e.pid === process.pid), got3);

    // T.4 终止失败：记录保留到最终清理并报告，本节判「没收净」
    const h = await spawnHelper('setInterval(function(){}, 1000)');
    const hStart = ownStartTime(h.pid);
    SINK = [];
    KILL.fn = async () => false;
    let clean4;
    try { clean4 = await reapSection('T4'); } finally { KILL.fn = null; }
    const got4 = SINK;
    SINK = null;
    const keptKey = trackKey(h.pid, hStart);
    check('T.4a 终止失败时 reapSection 返回「没收净」', clean4 === false, clean4);
    check('T.4b 终止失败的记录保留在失败清单里，进程确实还活着', REAP_FAILED.has(keptKey) && aliveI(h.pid), Array.from(REAP_FAILED.keys()));
    check('T.4c 终止失败被报告（残留判红 T4.R 与终止失败 T4.R2 两条）', got4.some((n) => n.startsWith('T4.R ')) && got4.some((n) => n.startsWith('T4.R2 ')), got4);
    // 复原：用真实终止函数清掉，并清空失败清单（否则最终清理会把这个故意制造的失败报出来）
    const e4 = REAP_FAILED.get(keptKey);
    if (e4) { await killEntry(e4); REAP_FAILED.delete(keptKey); }
    check('T.4d 复原后该辅助进程已被按身份终止', await waitDead(h.pid, 10000));

    // T.5 / T.6 PowerShell 层注入：Get-Process / CIM 报错（非「找不到」）→ 查询失败（抛异常），不是「进程不存在」（null）；明确「找不到该进程」才是 null
    const getProcFail = "function Get-Process { [CmdletBinding()] param($Id) Write-Error 'injected Get-Process failure' }";
    for (const [label, prelude] of [['Get-Process 报错', getProcFail], ['CIM 报错', FAIL_CIM_FN]]) {
        FAULT.psPrelude = prelude;
        let errT = null;
        let valT;
        try { valT = ownStartTime(process.pid); } catch (e) { errT = e; } finally { FAULT.psPrelude = ''; }
        check(`T.5 ${label}（PowerShell 层注入）：ownStartTime 抛查询失败，不返回 null（不当成进程不存在）`, errT !== null && valT === undefined && /查询进程/.test(errT.message), errT ? errT.message : valT);
    }
    check('T.5b 明确「找不到该进程」才判不存在：不存在的 PID → null', ownStartTime(2147483000) === null);

    // T.7 查询失败时 killEntry 不终止、返回 false（保留记录交给上层报告）；恢复后同一条记录被终止
    const h7 = await spawnHelper('setInterval(function(){}, 1000)');
    const s7 = ownStartTime(h7.pid);
    FAULT.psPrelude = getProcFail;
    let k7;
    try { k7 = await killEntry({ pid: h7.pid, start: s7 }); } finally { FAULT.psPrelude = ''; }
    check('T.7 PowerShell 查询失败：killEntry 返回 false（保留记录），进程没有被终止', k7 === false && aliveI(h7.pid), k7);
    // T.8 创建时间差 2 秒的记录（同 PID）不碰
    const k8 = await killEntry({ pid: h7.pid, start: new Date(Date.parse(s7) + 2000).toISOString() });
    check('T.8 PID 相同、创建时间差 2 秒的记录：killEntry 视为「不是登记的那个进程」，不终止', k8 === true && aliveI(h7.pid), k8);
    const k7b = await killEntry({ pid: h7.pid, start: s7 });
    check('T.7b 精确匹配的记录被终止（对照）', k7b === true && await waitDead(h7.pid, 10000), k7b);

    // T.9 登记写入失败判红（不吞）
    const regSave = REG.file;
    SINK = [];
    REG.file = os.tmpdir();   // 一个目录：追加写必然失败
    try { registerEntry(2147483002, '2003-03-03T00:00:00.0000000Z'); } finally { REG.file = regSave; }
    const got9 = SINK;
    SINK = null;
    TRACK.delete(trackKey(2147483002, '2003-03-03T00:00:00.0000000Z'));
    check('T.9 登记文件写入失败：报告一条「登记通道写入失败」（不是静默吞掉）', got9.length === 1 && /登记通道写入失败/.test(got9[0]), got9);

    // T.10 / T.11 替身服务自登记：写不进登记文件 → 在派生任何长寿子进程前以 86 退出；正常 → 写入的创建时间等于独立查询的精确值（服务本身与它的长寿子进程各一条）
    const stubDir = path.join(os.tmpdir(), `启停 测试 ${process.pid}-T-stub`);
    ALL_ROOTS.push(stubDir);
    w(path.join(stubDir, 'server.js'), STUB_SRC);
    const stubCtl = path.join(stubDir, 'ctl.json');
    w(stubCtl, JSON.stringify({ spawnChild: true }));
    const runStub = (regPath) => new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(stubDir, 'server.js')], { cwd: stubDir, env: Object.assign({}, process.env, { STUB_CONTROL: stubCtl, PORT: '0', S2C_TEST_REGISTRY: regPath }), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let out = '';
        let exited = false;
        let code = null;
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });
        child.on('exit', (c) => { exited = true; code = c; });
        child.on('error', () => { exited = true; });
        const t0 = Date.now();
        const poll = setInterval(() => {
            if (exited || /STUB_LISTENING/.test(out) || Date.now() - t0 > 40000) { clearInterval(poll); resolve({ pid: child.pid, exited, code, out }); }
        }, 100);
    });
    const badRun = await runStub(os.tmpdir());   // 登记路径是目录：自登记写入失败
    for (const k of ['STUB_PID', 'STUB_CHILD_PID']) { const p = pidNum(logVal(badRun.out, k)); if (Number.isSafeInteger(p) && aliveI(p)) track(p); }
    if (!badRun.exited && aliveI(badRun.pid)) track(badRun.pid);
    check('T.10 自登记写不进登记文件：替身以退出码 86 退出，没有打印 STUB_PID、没有派生长寿子进程（STUB_CHILD_PID）', badRun.exited && badRun.code === 86 && !/STUB_PID=|STUB_CHILD_PID=/.test(badRun.out) && /SELF_REGISTER_FAILED/.test(badRun.out), { exited: badRun.exited, code: badRun.code, out: badRun.out.slice(0, 300) });
    const regOk = path.join(stubDir, 'reg.jsonl');
    const goodRun = await runStub(regOk);
    const gPid = pidNum(logVal(goodRun.out, 'STUB_PID'));
    const gChild = pidNum(logVal(goodRun.out, 'STUB_CHILD_PID'));
    const readRecs = () => { try { return rd(regOk).split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l)); } catch (_) { return []; } };
    let recs = readRecs();
    const endRecs = Date.now() + 30000;
    while (!(recs.some((r) => r.pid === gPid) && recs.some((r) => r.pid === gChild)) && Date.now() < endRecs) { await sleep(200); recs = readRecs(); }   // 长寿子进程的自登记比替身晚一步（各自要一次 CIM 查询）
    let gStart = null;
    let cStart = null;
    try { gStart = ownStartTime(gPid); cStart = ownStartTime(gChild); } catch (_) { /* 查询失败时下面的断言会判红 */ }
    check('T.11 正常自登记：登记文件里替身与它的长寿子进程各有一条 { pid, start }，start 等于独立查询到的精确创建时间（不是近似值）', gStart !== null && cStart !== null && recs.some((r) => r.pid === gPid && r.start === gStart) && recs.some((r) => r.pid === gChild && r.start === cStart) && recs.every((r) => Object.keys(r).sort().join() === 'pid,start'), { gPid, gChild, gStart, cStart, recs });
    for (const [pid, st] of [[gPid, gStart], [gChild, cStart]]) { if (Number.isSafeInteger(pid) && st !== null) { registerEntry(pid, st); await killEntry({ pid, start: st }); } }
    check('T.11b 收尾：替身与它的长寿子进程都已终止', Number.isSafeInteger(gPid) && await waitDead(gPid, 10000) && (!Number.isSafeInteger(gChild) || await waitDead(gChild, 10000)));

    // T.12 钉句柄的回归守卫（静态）：每份「核对并终止」脚本里 .Handle 都出现在 taskkill 之前（X1：把 `$h = $p.Handle` 改成 `$h = 1` → 判红）
    const SUP = require(path.join(__dirname, 'lines-test-supervisor.js'));
    const handleBeforeTaskkill = (text) => { const h = text.indexOf('.Handle'); const t = text.toLowerCase().indexOf('taskkill'); return h !== -1 && t !== -1 && h < t; };
    const ISO_SAMPLE = '2026-01-02T03:04:05.1234567Z';
    check('T.12a line-proc.js 的 killIfIdentity 脚本：.Handle 在 taskkill 之前', handleBeforeTaskkill(PR.buildKillScript(1234, ISO_SAMPLE).join('\n')));
    check('T.12b 套件的 killEntry 脚本（测试侧）：.Handle 在 taskkill 之前', handleBeforeTaskkill(buildKillEntryScript({ pid: 1234, start: ISO_SAMPLE })));
    check('T.12c 监督进程的登记回收脚本（测试侧）：.Handle 在 taskkill 之前', handleBeforeTaskkill(SUP.buildReapScript({ pid: 1234, start: ISO_SAMPLE }).join('\n')));
    const MK = PR.buildManualKillCommand(1234, ISO_SAMPLE);
    const mkEnc = /-EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(MK.command);
    check('T.12e 人工恢复命令（line-proc 的 buildManualKillCommand）：脚本与 EncodedCommand 解码内容里 .Handle 都在 taskkill 之前，且含精确创建时间', handleBeforeTaskkill(MK.script) && mkEnc !== null && handleBeforeTaskkill(Buffer.from(mkEnc[1], 'base64').toString('utf16le')) && MK.script.includes(`'${ISO_SAMPLE}'`));
    check('T.12d 守卫本身有判别力：没有 .Handle / .Handle 在 taskkill 之后的脚本被判不合格', !handleBeforeTaskkill('$h = 1\n& taskkill.exe /PID 1 /T /F') && !handleBeforeTaskkill('& taskkill.exe /PID 1 /T /F\n$h = $p.Handle'));

    // T.13 测试端口选择函数 pickTestPorts 的判别力（注入候选序列，期望值手写）：段内 / 真实槽位 / 3000 / 重复 / 越界的候选都被丢弃，合格的按出现顺序留下；取不到返回 null
    const seqOf = (arr) => { let i = 0; return async () => arr[i++]; };   // 序列耗尽后返回 undefined（被当成不合格候选）
    const okProbe = async () => true;   // 这组用例只验候选筛选逻辑，绑定探测与空闲判定恒真（探测本身见 T.13g，空闲判定见 T.13i1 / T.13i2）
    const okFree = async () => true;
    const pA = await pickTestPorts(50, seqOf([25001, 20000, 49999, 3000, 3100, 3200, 3300, 1023, 65536, 52001, 52001, 52002, 61003]), okProbe, okFree);
    check('T.13a 候选里的 20000–49999 段内值（25001 / 20000 / 49999）、3000、3100 / 3200 / 3300、越界值（1023 / 65536）、重复值全被丢弃，留下 [52001, 52002, 61003]', same(pA, [52001, 52002, 61003]), pA);
    const pB = await pickTestPorts(10, seqOf([25001, 25002, 25003, 30000, 40000, 20000, 49999, 25004, 25005, 25006]), okProbe, okFree);
    check('T.13b 候选全在 20000–49999 段内：重试用完后返回 null（不会把段内端口当合格值；重试有上限）', pB === null, pB);
    const pC = await pickTestPorts(10, seqOf([19999, 50000, 1024]), okProbe, okFree);
    check('T.13c 段的两侧边界：19999 与 50000 合格（防把段写宽），下限 1024 合格', same(pC, [19999, 50000, 1024]), pC);
    const pD = await pickTestPorts(10, seqOf([52001, 52002]), okProbe, okFree);
    check('T.13d 只凑得到两个合格端口 → null（不足三个不返回半截结果）', pD === null, pD);
    // 序列里只有一个不合格值（3100），其后连着三个合格值：上限 3 次只够取到两个合格值 → null；「循环多跑一次」的实现会取到 [52001, 52002, 52003]
    const pE = await pickTestPorts(3, seqOf([3100, 52001, 52002, 52003]), okProbe, okFree);
    check('T.13e 重试次数是硬上限：3 次内只取到两个合格值 → null（即使第 4 个候选合格；循环多一次的实现会返回三个端口）', pE === null, pE);
    const pF = await pickTestPorts(20, seqOf([52001, 52002, 52003, 52004, 52005]), async (p) => p !== 52001 && p !== 52003, okFree);
    check('T.13f 绑定探测不通过的候选（52001 / 52003 被占用）被跳过：留下 [52002, 52004, 52005]', same(pF, [52002, 52004, 52005]), pF);
    // T.13g 真实的绑定探测：占着的端口探测为 false，放开后为 true；候选来源落在 50060–65535
    // 绑定语义（H1-B 修复批 1 在本机 Windows / Node v24 实测，scratchpad probe-bind-semantics.js）：只有「同一地址」的第二次监听报 EADDRINUSE；先 0.0.0.0 再 127.0.0.1（或反过来）、先 127.0.0.2 再 0.0.0.0 / 127.0.0.1 都成功。
    //   所以探测必须 127.0.0.1 与 0.0.0.0 各绑一次：只绑 0.0.0.0 的实现看不见仅在 127.0.0.1 上的监听者（g2），只绑 127.0.0.1 的实现看不见 0.0.0.0 上的监听者（g）。
    // M2：本组夹具（T.13g / g2 的占位、T.13i 的占位与 freeThree）的端口一律经 acquireFixture 取——候选先过与 pickTestPorts 同口径的空闲前置检查（probeBindable + portFreeI），
    //   夹具自身绑定遇 EADDRINUSE / EACCES 有界换候选（FIXTURE_TRIES 次），取不到就判红并写明原因；成功建立夹具之后才执行被测断言。T.13h 仍直接取未筛选的随机候选（它测的就是候选来源的范围）。
    const cands = Array.from({ length: 200 }, () => randomCandidatePort());
    const closeSrv = (srv) => new Promise((resolve) => srv.close(resolve));
    const occupyAt = (host) => async (port) => {
        const srv = net.createServer();
        const err = await new Promise((resolve) => { srv.once('error', (e) => resolve(e)); srv.listen(host === undefined ? { port } : { port, host }, () => resolve(null)); });
        return { handle: srv, err };
    };
    const fxTaken = [];   // 本组已取走的夹具端口（互不重复）
    const fxPort = async (host, withOccupant) => {
        const r = await acquireFixture({ exclude: fxTaken, occupy: withOccupant ? occupyAt(host) : undefined });
        if (r.ok) fxTaken.push(r.port);
        return r;
    };
    for (const [tag, host] of [['T.13g', '0.0.0.0'], ['T.13g2', '127.0.0.1']]) {
        const fx = await fxPort(host, true);
        if (!fx.ok) { check(`${tag} 前置：取夹具端口并在 ${host} 上占位失败：${fx.reason}`, false, fx.reason); continue; }
        const port = fx.port;
        const busy = await probeBindable(port);
        await closeSrv(fx.handle);
        const freed = await probeBindable(port);
        check(`${tag} 绑定探测：仅在 ${host} 上被占用的端口探测为 false，放开后为 true`, busy === false && freed === true, { busy, freed, port, host, tries: fx.tries });
    }
    // T.13i LOW-1：127.0.0.1 以外的具体地址（127.0.0.2）与默认地址（双栈 ::）上的监听者，probeBindable 看不见（premise 断言），pickTestPorts 的 portFreeI（netstat）必须挡住——用真实探测与真实空闲判定
    for (const [tag, host] of [['T.13i1', '127.0.0.2'], ['T.13i2', undefined]]) {
        const hostText = host === undefined ? '默认地址（双栈 ::）' : host;
        const fx = await fxPort(host, true);
        if (!fx.ok) { check(`${tag} 前置：取夹具端口并在 ${hostText} 上占位失败：${fx.reason}`, false, fx.reason); continue; }
        const port = fx.port;
        try {
            const freeThree = [];
            let why = null;
            for (let k = 0; k < 3 && why === null; k += 1) {
                const f3 = await fxPort(undefined, false);
                if (f3.ok) freeThree.push(f3.port); else why = f3.reason;
            }
            if (why !== null) { check(`${tag} 前置：取三个空闲夹具端口失败：${why}`, false, why); continue; }
            const premise = await probeBindable(port);
            const nsFree = await portFreeI(port);
            const res = await pickTestPorts(10, seqOf([port, ...freeThree]));
            check(`${tag} 监听者在 ${hostText} 上：绑定探测看不见它（premise），空闲判定看得见；pickTestPorts 不选该端口，留下 [${freeThree.join(', ')}]`, premise === true && nsFree === false && same(res, freeThree), { premise, nsFree, res, port, host: host === undefined ? '默认' : host });
        } finally { await closeSrv(fx.handle); }
    }
    check('T.13h 候选来源 randomCandidatePort 的 200 次取值全部落在 50060–65535，且不是 3000 / 3100 / 3200 / 3300（手写边界）', cands.every((p) => Number.isInteger(p) && p >= 50060 && p <= 65535 && ![3000, 3100, 3200, 3300].includes(p)), cands.filter((p) => !(p >= 50060 && p <= 65535)));

    // T.14 零串扰占位 placeZeroCrosstalk 的分类与重试（注入假的监听者查询 / 绑定 / 睡眠，期望值手写）：有监听者 → 跳过且不绑定；绑定失败又无监听者 → 重试 5 次（间隔 200ms）后判未证明；中途成功 → 占位
    const fakeSrv = { close() {} };
    const run14 = async (listenersFn, bindFn, ports) => {
        const calls = { bind: 0, sleeps: [] };
        const res = await placeZeroCrosstalk(ports || [3100], { listeners: listenersFn, bind: async (p) => { calls.bind += 1; return bindFn(p, calls.bind); }, sleep: async (ms) => { calls.sleeps.push(ms); } });   // 不传 attempts：走缺省（手写期望 5 次 / 200ms，不引用常量）
        return { res, calls };
    };
    const t14a = await run14(() => [4242], () => ({ server: fakeSrv }));
    check('T.14a 端口上已有 LISTENING 监听者：记入 skipped（owners = [4242]），不绑定、不重试、不算占位', same(t14a.res.skipped, [{ port: 3100, owners: [4242] }]) && t14a.res.placed.length === 0 && t14a.res.unproven.length === 0 && t14a.calls.bind === 0 && t14a.calls.sleeps.length === 0, t14a);
    const t14b = await run14(() => [], () => ({ code: 'EADDRINUSE' }));
    check('T.14b 绑定失败且始终没有监听者：恰好绑定 5 次、重试间隔 4 次各 200ms，最终 unproven（原因含 EADDRINUSE 与「5 次」），不是 placed / skipped', t14b.calls.bind === 5 && same(t14b.calls.sleeps, [200, 200, 200, 200]) && t14b.res.unproven.length === 1 && t14b.res.unproven[0].port === 3100 && /EADDRINUSE/.test(t14b.res.unproven[0].reason) && /5 次/.test(t14b.res.unproven[0].reason) && t14b.res.placed.length === 0 && t14b.res.skipped.length === 0, t14b);
    const t14c = await run14(() => [], (p, n) => (n < 3 ? { code: 'EADDRINUSE' } : { server: fakeSrv }));
    check('T.14c 前两次绑定失败、第 3 次成功：placed，共绑定 3 次、睡眠 2 次，无 unproven', t14c.res.placed.length === 1 && t14c.res.placed[0].port === 3100 && t14c.calls.bind === 3 && t14c.calls.sleeps.length === 2 && t14c.res.unproven.length === 0, t14c);
    let q14d = 0;
    const t14d = await run14(() => (q14d++ < 1 ? [] : [77]), () => ({ code: 'EADDRINUSE' }));
    check('T.14d 绑定失败后复查发现监听者出现：记入 skipped（owners = [77]），只绑定 1 次', same(t14d.res.skipped, [{ port: 3100, owners: [77] }]) && t14d.calls.bind === 1 && t14d.res.unproven.length === 0 && t14d.res.placed.length === 0, t14d);
    const t14e = await run14(() => null, () => ({ server: fakeSrv }));
    check('T.14e netstat 查询始终失败（null）：不盲绑，最终 unproven（原因含 netstat），绑定 0 次', t14e.calls.bind === 0 && t14e.res.unproven.length === 1 && /netstat/.test(t14e.res.unproven[0].reason) && t14e.res.placed.length === 0, t14e);
    const t14f = await run14((p) => (p === 3100 ? [5] : []), (p) => (p === 3200 ? { code: 'EADDRINUSE' } : { server: fakeSrv }), [3100, 3200]);
    check('T.14f 两个端口各自分类互不影响：3100 有监听者 → skipped；3200 绑定失败无监听者 → unproven', same(t14f.res.skipped, [{ port: 3100, owners: [5] }]) && t14f.res.unproven.length === 1 && t14f.res.unproven[0].port === 3200 && t14f.res.placed.length === 0, t14f);
    // T.14g 0.ph0 的逐端口判据 zeroXtalkProven：占位成功或有真实监听者才算成立；unproven、owners 为空的 skipped、别的端口的结果都不算
    const stP = { placed: [{ port: 3100, server: fakeSrv }], skipped: [{ port: 3200, owners: [9] }] };
    check('T.14g 逐端口判据：3100 占位成功成立、3200 有监听者成立；3300 无记录不成立；owners 为空的 skipped 不成立；只有 unproven 的端口不成立',
        zeroXtalkProven(3100, stP) === true && zeroXtalkProven(3200, stP) === true && zeroXtalkProven(3300, stP) === false
        && zeroXtalkProven(3200, { placed: [], skipped: [{ port: 3200, owners: [] }] }) === false && zeroXtalkProven(3100, { placed: [], skipped: [] }) === false
        && zeroXtalkProven(3100, { placed: [{ port: 3200, server: fakeSrv }], skipped: [] }) === false);
    // T.14h 真实接线：用默认的监听者查询（netstat）与绑定（0.0.0.0）在一个随机空闲高位端口上占位 → 端口上 LISTENING 的有本进程；关闭后没有
    const fx14h = await fxPort(undefined, false);   // M2：先过空闲前置检查，不直接用未筛选的随机候选
    if (!fx14h.ok) check(`T.14h 前置：取空闲夹具端口失败：${fx14h.reason}`, false, fx14h.reason);
    else {
    const t14hPort = fx14h.port;
    const t14h = await placeZeroCrosstalk([t14hPort]);
    const t14hListen = listenersOn(t14hPort);
    for (const ph of t14h.placed) await closeSrv(ph.server);
    check(`T.14h 真实接线：默认查询与绑定在空闲端口 ${t14hPort} 上占位成功（placed 1 个、LISTENING 含本进程），关闭后端口上没有本进程的监听`, t14h.placed.length === 1 && t14h.skipped.length === 0 && t14h.unproven.length === 0 && t14hListen.includes(process.pid) && !listenersOn(t14hPort).includes(process.pid), { t14h: { placed: t14h.placed.length, skipped: t14h.skipped, unproven: t14h.unproven }, t14hListen });
    }

    // T.14i-m（M1）入口占用快照的逐节复核 recheckEntryListeners（注入假的监听者查询，期望值手写）：外部监听者中途消失 → 移出 skipped、记 unproven（原因含入口 PID 与「第 3 节后不再监听」）；全程在 → 保留；查询失败 → 未证明
    const mkSkipped = () => [{ port: 3100, owners: [9] }, { port: 3200, owners: [4, 5] }];
    const sk14i = mkSkipped();
    const un14i = [];
    const lost14i = recheckEntryListeners(sk14i, un14i, '3', { listeners: (p) => (p === 3100 ? [] : [4, 5]) });
    check('T.14i 外部监听者中途消失：3100 移出 skipped 记入 unproven（原因含入口时 PID 9 与「第 3 节后不再监听」），3200 仍在监听 → 保留；zeroXtalkProven 对 3100 为 false、对 3200 为 true',
        same(sk14i, [{ port: 3200, owners: [4, 5] }]) && un14i.length === 1 && un14i[0].port === 3100 && un14i[0].reason.includes('入口时有监听者 PID 9') && un14i[0].reason.includes('第 3 节后不再监听') && same(lost14i, un14i)
        && zeroXtalkProven(3100, { placed: [], skipped: sk14i }) === false && zeroXtalkProven(3200, { placed: [], skipped: sk14i }) === true, { sk14i, un14i });
    const sk14j = mkSkipped();
    const un14j = [];
    for (const id of ['0', 'H', '1', 'Z']) recheckEntryListeners(sk14j, un14j, id, { listeners: (p) => (p === 3100 ? [9, 11] : [4]) });
    check('T.14j 外部监听者全程在（逐节复核四次，PID 集合可以变化但始终非空）：skipped 原样保留、unproven 为空 → 证明成立', same(sk14j, mkSkipped()) && un14j.length === 0, { sk14j, un14j });
    const sk14k = mkSkipped();
    const un14k = [];
    recheckEntryListeners(sk14k, un14k, '5', { listeners: () => null });
    check('T.14k 复核时 netstat 查询失败（null）：两个端口都记 unproven（原因含「入口时有监听者 PID」与「netstat 查询失败」），skipped 清空 → 未证明（fail-closed）', sk14k.length === 0 && un14k.length === 2 && un14k.every((u) => u.reason.includes('入口时有监听者 PID') && u.reason.includes('netstat 查询失败') && u.reason.includes('第 5 节后')), un14k);
    const sk14l = [{ port: 3100, owners: [9] }];
    const un14l = [];
    recheckEntryListeners(sk14l, un14l, 'Z', { listeners: () => [] });
    check('T.14l Z 节收尾复核：监听者已消失 → unproven，原因写「Z 节收尾时不再监听」', un14l.length === 1 && un14l[0].reason.includes('Z 节收尾时不再监听'), un14l);
    const sk14m = [{ port: 3100, owners: [9] }];
    const un14m = [{ port: 3200, reason: '先前已记' }];
    recheckEntryListeners(sk14m, un14m, '2', { listeners: () => [] });
    check('T.14m 复核只追加不覆盖：先前已有的 unproven 记录原样保留在前', un14m.length === 2 && un14m[0].port === 3200 && un14m[0].reason === '先前已记' && un14m[1].port === 3100, un14m);

    // T.15（M2）acquireFixture 的空闲前置检查与有界重选（注入候选序列 / 探测 / 空闲判定 / 占位，期望值手写）
    const seqF = (arr) => { let i = 0; return async () => arr[i++ % arr.length]; };
    const noOcc = async () => ({ handle: { tag: 'h' }, err: null });
    const f15a = await acquireFixture({ next: seqF([60001, 60002, 60003]), probe: async (p) => p !== 60001, free: async (p) => p !== 60002, tries: 5 });
    check('T.15a 前置检查：60001 探测不可绑定、60002 端口上已有监听者 → 都被跳过，取到 60003（第 3 次），被拒记录写明各自理由', f15a.ok && f15a.port === 60003 && f15a.tries === 3 && f15a.rejected.length === 2 && f15a.rejected[0].includes('探测不可绑定') && f15a.rejected[1].includes('LISTENING'), f15a);
    let occN = 0;
    const f15b = await acquireFixture({ next: seqF([60011, 60012]), probe: async () => true, free: async () => true, occupy: async () => (occN++ < 1 ? { handle: null, err: { code: 'EADDRINUSE' } } : { handle: { tag: 'ok' }, err: null }), tries: 5 });
    check('T.15b 夹具自身绑定遇 EADDRINUSE（探测之后被抢）：换候选，第 2 个候选建立夹具成功', f15b.ok && f15b.port === 60012 && f15b.tries === 2 && f15b.handle.tag === 'ok' && f15b.rejected[0].includes('EADDRINUSE'), f15b);
    let occE = 0;
    const f15c = await acquireFixture({ next: seqF([60021, 60022]), probe: async () => true, free: async () => true, occupy: async () => { occE += 1; return { handle: null, err: { code: 'EADDRNOTAVAIL', message: 'x' } }; }, tries: 5 });
    check('T.15c 绑定遇非占用类错误（EADDRNOTAVAIL）：不重试，直接报失败并写出错误码', f15c.ok === false && occE === 1 && f15c.reason.includes('EADDRNOTAVAIL'), f15c);
    let probeN = 0;
    const f15d = await acquireFixture({ next: seqF([60031]), probe: async () => { probeN += 1; return true; }, free: async () => false, occupy: noOcc });
    check(`T.15d 全部候选都被占：恰好尝试 20 次后返回失败，原因写明「20 次候选都不能用作夹具端口」与被拒理由，且没有建立夹具`, f15d.ok === false && probeN === 20 && f15d.reason.includes('20 次候选都不能用作夹具端口') && f15d.reason.includes('LISTENING') && f15d.rejected.length === 20, f15d);
    const f15e = await acquireFixture({ next: seqF([60041, 60041, 60042]), probe: async () => true, free: async () => true, exclude: [60041], tries: 5 });
    check('T.15e exclude 里的端口（已被别的夹具取走）不再取：跳过 60041，取到 60042', f15e.ok && f15e.port === 60042 && f15e.tries === 3, f15e);
    const f15f = await acquireFixture({ next: seqF([60051]), probe: async () => true, free: async () => true });
    check('T.15f 不带 occupy 时只做前置检查：返回端口且 handle 为 null', f15f.ok && f15f.port === 60051 && f15f.handle === null && f15f.tries === 1, f15f);
}

// ---- 第 9 节：CLI

async function sec9() {
    section('9', 'CLI（line.js 分派）');
    const P = L.parseArgv;
    check('9.1 新子命令解析：start/stop/overlap/check-deps/recover 要恰好一个线名，list 不接受位置参数',
        P(['start', 'a']).ok && P(['stop', 'a']).ok && P(['overlap', 'a']).ok && P(['check-deps', 'a']).ok && P(['recover', 'a']).ok && P(['list']).ok
        && !P(['start']).ok && !P(['stop']).ok && !P(['list', 'a']).ok && !P(['recover', 'a', 'b']).ok);
    check('9.2 --json 只给 list / overlap；--ready-timeout 只给 start 且必须是 1–9999 的整数',
        P(['list', '--json']).opts.json === true && P(['overlap', 'a', '--json']).opts.json === true && !P(['stop', 'a', '--json']).ok && !P(['start', 'a', '--json']).ok
        && P(['start', 'a', '--ready-timeout', '5']).opts.readyTimeoutSec === 5 && !P(['stop', 'a', '--ready-timeout', '5']).ok && !P(['start', 'a', '--ready-timeout', '0']).ok && !P(['start', 'a', '--ready-timeout', 'x']).ok);
    check('9.3 旧子命令解析不受影响：new 缺 --module 仍是用法错误，remove --discard 正常，未知子命令仍拒绝', !P(['new', 'a', '--surface', 's']).ok && P(['remove', 'a', '--discard']).opts.discard === true && !P(['frob', 'x']).ok);

    // 9.3b 三方合并的结果：KNOWN_FLAGS 是所有子命令布尔参数名的并集（--json 属于 list / overlap，对 stop 是「该子命令不支持」而不是「不认识的参数」）；未知子命令 / 未知参数的错误文案不回显原始输入，可用子命令列全
    const eStopJson = P(['stop', 'a', '--json']).error || '';
    const eUnkFlag = P(['stop', 'a', '--zz-secret-flag']).error || '';
    const eUnkCmd = P(['zz-secret-cmd', 'a']).error || '';
    check('9.3b 未知参数 / 未知子命令的文案不回显原始输入；--json 对 stop 报「stop 不支持参数：--json」（认识这个参数名）；未知子命令文案列全 new / remove / 六个运行命令',
        eStopJson.includes('stop 不支持参数：--json') && !eUnkFlag.includes('zz-secret-flag') && eUnkFlag.includes('原始输入不回显') && !eUnkCmd.includes('zz-secret-cmd') && eUnkCmd.includes('原始输入不回显')
        && ['new', 'remove', 'start', 'stop', 'list', 'overlap', 'check-deps', 'recover'].every((c) => eUnkCmd.includes(c)), { eStopJson, eUnkFlag, eUnkCmd });
    const fx = await buildFixture('s9');
    const env = Object.assign({}, process.env, { STUB_CONTROL: fx.ctl });
    setCtl(fx, {});
    const cn = runCli(['new', 'ca', '--module', 'mod-ca', '--surface', SURFACE_A, ...rootsOf(fx)], env);
    check('9.4 CLI new 建线成功', cn.status === 0, { s: cn.status, e: cn.stderr });
    if (cn.status !== 0) return;
    const regNewR = await attempt(() => regOf(fx));   // CLI 若漏传 --slot-ports，登记里是 3100，按测试表读会 STATE_CORRUPT：包起来让它变成一条判红的断言，而不是整节异常
    const regNew = regNewR.err === null ? regNewR.res.lines.ca : null;
    check('9.4b CLI new 经 --slot-ports 分配：按测试表读登记表通过校验，登记 slot 1 / port = TP[0]（不是生产缺省 3100；期望值取自套件变量）', regNew !== null && regNew.slot === 1 && regNew.port === TP[0] && regNew.port !== 3100, regNewR.err ? regNewR.err.message : regNew);
    if (regNew === null) return;
    const cs = runCli(['start', 'ca', ...rootsOf(fx)], env);
    const reg = (await regOf(fx)).lines.ca;
    if (reg.process) track(reg.process.pid);
    check('9.5 CLI start：退出码 0、stdout 有「已启动」、登记了进程', cs.status === 0 && cs.stdout.includes('已启动') && reg.process !== null, { s: cs.status, e: cs.stderr, o: cs.stdout });
    check('9.6 CLI 进程退出后，detached 的线服务仍活着且 /api/version 可响应（unref + 输出写日志，不依赖 CLI 的管道）', reg.process !== null && aliveI(reg.process.pid) && (await httpGetI(TP[0], '/api/version')).json.instance === 'ca');
    const cl = runCli(['list', '--json', ...rootsOf(fx)], env);
    let lj = null;
    try { lj = JSON.parse(cl.stdout); } catch (_) { lj = null; }
    check('9.7 CLI list --json：退出码 0，ca 运行中', cl.status === 0 && lj && lj.lines.length === 1 && lj.lines[0].process.state === 'running', { s: cl.status, e: cl.stderr, o: cl.stdout.slice(0, 300) });
    const co = runCli(['overlap', 'ca', ...rootsOf(fx)], env);
    check('9.8 CLI overlap：退出码 0', co.status === 0, { s: co.status, e: co.stderr });
    const cc = runCli(['check-deps', 'ca', ...rootsOf(fx)], env);
    check('9.9 CLI check-deps（一致）：退出码 0', cc.status === 0, { s: cc.status, e: cc.stderr });
    w(path.join(wtOf(fx, 'ca'), 'wbs-server', 'package.json'), PKG_WBS_DEPCHG);   // 依赖确实不同（只差 version 不算依赖变更）
    const cc2 = runCli(['check-deps', 'ca', ...rootsOf(fx)], env);
    check('9.10 CLI check-deps（不一致）：退出码非 0（1），stderr 点出差异文件', cc2.status === 1 && /wbs-server\/package\.json/.test(cc2.stderr), { s: cc2.status, e: cc2.stderr });
    git(wtOf(fx, 'ca'), ['checkout', '--', 'wbs-server/package.json']);
    const cr = runCli(['recover', 'ca', ...rootsOf(fx)], env);
    check('9.11 CLI recover 对 ready 的线：退出码 1', cr.status === 1 && /LINE_RECOVER_REFUSED/.test(cr.stderr), { s: cr.status, e: cr.stderr });
    const cx = runCli(['stop', 'ca', ...rootsOf(fx)], env);
    check('9.12 CLI stop：退出码 0、进程已消失、登记清空', cx.status === 0 && reg.process !== null && await waitDead(reg.process.pid, 5000) && (await regOf(fx)).lines.ca.process === null, { s: cx.status, e: cx.stderr });
    const cx2 = runCli(['stop', 'ca', ...rootsOf(fx)], env);
    check('9.13 CLI 对未运行的线 stop：退出码 0、提示未运行', cx2.status === 0 && cx2.stdout.includes('未运行'), { s: cx2.status, o: cx2.stdout });
    setCtl(fx, { neverReady: true });
    const cf = runCli(['start', 'ca', '--ready-timeout', '2', ...rootsOf(fx)], env);
    check('9.14 CLI start 永不就绪（--ready-timeout 2）：退出码 1，stderr 含「超时」', cf.status === 1 && /超时/.test(cf.stderr), { s: cf.status, e: cf.stderr.slice(0, 400) });
    setCtl(fx, {});
    const cn0 = runCli(['start', 'no-such', ...rootsOf(fx)], env);
    check('9.15 CLI start 不存在的线：退出码 1', cn0.status === 1 && /没有这条线/.test(cn0.stderr), { s: cn0.status, e: cn0.stderr });
    const cu = runCli(['start', ...rootsOf(fx)], env);
    check('9.16 CLI 用法错误（start 缺线名）：退出码 2', cu.status === 2 && /用法错误/.test(cu.stderr), { s: cu.status, e: cu.stderr });
    const crm = runCli(['remove', 'ca', ...rootsOf(fx)], env);
    check('9.17 CLI remove 收尾成功', crm.status === 0, { s: crm.status, e: crm.stderr });
}

async function secZ() {
    section('Z', '收尾：端口、临时目录、泄漏扫描');
    // 终止失败的记录：最终清理再试一次并报告（仍存活的进程判红，列出 PID）
    const stuck = [];
    for (const [, e] of REAP_FAILED) { if (!(await killEntry(e))) stuck.push(e.pid); }
    check('Z.0 此前终止失败的进程在最终清理里已全部终止（无遗留）', stuck.length === 0, stuck);
    if (!PORTS_BUSY) for (const port of TP) check(`Z.1 测试端口 ${port} 结束时空闲（测试没有留下监听者）`, await portFreeI(port), listenersOn(port));
    // 零串扰占位（仅 --zero-crosstalk）：套件全程在位，到这里才关闭；关闭后真实槽位端口上不再有本进程的监听。缺省模式没有占位，Z.1b / Z.1c 不做（也不计 PASS）
    if (!ZERO_XTALK) log('  （零串扰占位未启用：Z.1b / Z.1c 不做）');
    for (const ph of PLACEHOLDERS) {
        check(`Z.1b 占位监听在整套运行期间一直在位（真实槽位端口 ${ph.port} 结束前仍有本进程 LISTENING）`, listenersOn(ph.port).includes(process.pid), listenersOn(ph.port));
        await new Promise((resolve) => ph.server.close(resolve));
        check(`Z.1c 占位监听已关闭（真实槽位端口 ${ph.port} 上没有本进程的监听）`, !listenersOn(ph.port).includes(process.pid), listenersOn(ph.port));
    }
    PLACEHOLDERS.length = 0;
    // M1：入口占用快照（外部监听者）在 Z 节再复核一次，并逐端口断言「全程没有失效」；失效的端口已在 recheckEntryAndLog 里记入 PH_UNPROVEN
    if (ZERO_XTALK) {
        recheckEntryAndLog('Z');
        for (const port of PH_ENTRY_PORTS) {
            const lost = PH_UNPROVEN.find((u) => u.port === port);
            // 逐节复核是离散采样：节内短暂释放、下次复核前又恢复的窗口不覆盖（codex 44-R L，登记残余）
            check(`Z.1d 入口占用快照的外部监听者在各复核点（每节结束与 Z 节）都在，未观测到占用失效（真实槽位端口 ${port}；任一复核点不在或查询失败 = 零串扰未证明，判红）`, lost === undefined, lost && lost.reason);
        }
    }
    for (const root of ALL_ROOTS) {
        const left = removeTree(root);
        check(`Z.2 临时目录逐项删除干净：${path.basename(root)}`, left.length === 0 && C.pathGone(root), left.slice(0, 5));
    }
    const text = ALL_OUT.join('\n');
    const hits = [...LEAK_STRINGS, ...DYN_SECRETS].filter((s) => text.includes(s));
    check('Z.3 全部输出（被测输出、子进程输出、异常文本）里搜不到任何手写秘密', hits.length === 0, hits);
    check('Z.4 脱敏确实发生过（语料里有 [已脱敏]；--only 不含第 1 节时不要求），且语料非空', ((ONLY !== null && !ONLY.has('1')) || text.includes('[已脱敏]')) && (ALL_OUT.length > 20 || (ONLY !== null && ONLY.size > 0 && [...ONLY].every((s) => s === 'H'))), ALL_OUT.length);   // 只跑节 H（纯文件夹具，不产生被测输出）时语料本来就近乎空
}

// ================================================================ 入口

if (WORKER_ARG) {
    const spec = JSON.parse(Buffer.from(WORKER_ARG.slice('--worker='.length), 'base64').toString('utf8'));
    workerMain(spec).then(() => process.exit(0), (e) => { console.error(String(e && e.stack)); process.exit(1); });
} else {
    process.exitCode = 1;   // 挂起 / 提前退出必须非零；只有跑到汇总且 FAIL=0 才置 0
    (async () => {
        const secs = [['0', sec0], ['H', secH], ['1', sec1], ['2', sec2], ['3', sec3], ['4', sec4], ['5', sec5], ['6', sec6], ['7', sec7], ['8', sec8], ['T', secT], ['9', sec9]];
        let dirty = false;   // 某节收尾没有收净（进程没退出 / 测试端口仍被占）：后续依赖测试端口的节不再运行
        // H1-B：选测试端口 → 设为进程内端口表；只有带 --zero-crosstalk 才在真实槽位端口 3100 / 3200（REAL_SLOT_PORTS 前两项）上起零串扰占位（端口上已有监听者就记录并跳过，不强占；绑定失败又无监听者短重试，仍失败记为未证明）
        try {
            const picked = await pickTestPorts(200);
            if (picked === null) TP_ERR = '200 次内没有取到三个满足条件的端口（1024–65535、不在 20000–49999、不是 3000 / 3100 / 3200 / 3300、互不相同）';
            else { TP = picked; S._internal.setSlotPortsForTest(TP); }
        } catch (e) { TP_ERR = `选端口或设端口表出错：${e && e.message}`; }
        if (TP_ERR === null && ZERO_XTALK) {
            const placed = await placeZeroCrosstalk(REAL_SLOT_PORTS.slice(0, 2));
            PLACEHOLDERS.push(...placed.placed);
            PH_SKIPPED.push(...placed.skipped);
            PH_UNPROVEN.push(...placed.unproven);
            PH_ENTRY_PORTS.push(...placed.skipped.map((s) => s.port));
        }
        try {
            for (const [id, fn] of secs) {
                if (ONLY && id !== '0' && !ONLY.has(id)) continue;
                // 节 H 是纯文件夹具、不占端口，端口被外部占用时也运行
                if (PORTS_BUSY && id !== '0' && id !== 'H') { log(`\n=== ${id} 跳过（测试端口被占用或没取到）`); continue; }
                if (dirty) { log(`\n=== ${id} 跳过（前一节的进程 / 测试端口没有收净，停止后续依赖测试端口的用例）`); continue; }
                try { await fn(); } catch (e) { FAIL += 1; FAILS.push(`节 ${id} 异常`); log(`  FAIL  节 ${id} 抛出未捕获异常：${e && e.stack ? e.stack : e}`); } finally {
                    // 节级回收边界：不管节是正常结束、提前 return 还是抛异常，都在这里收尾
                    if (id !== '0') {
                        let clean = false;
                        try { clean = await reapSection(id); } catch (e) { FAIL += 1; FAILS.push(`节 ${id} 收尾异常`); log(`  FAIL  节 ${id} 收尾抛出异常：${e && e.stack ? e.stack : e}`); }
                        if (!clean) dirty = true;
                    }
                }
                if (ZERO_XTALK) recheckEntryAndLog(id);   // M1：每节结束复核入口占用快照（外部监听者是否还在）
            }
        } finally {
            try { await reapSection('end'); await secZ(); } catch (e) { FAIL += 1; FAILS.push('节 Z 异常'); log(`  FAIL  节 Z 异常：${e && e.stack ? e.stack : e}`); }
            try { S._internal.setSlotPortsForTest(null); } catch (_) { /* 还原为生产缺省；失败不影响汇总 */ }
            for (const ph of PLACEHOLDERS) { try { ph.server.close(); } catch (_) { /* 兜底：Z 节没来得及关 */ } }
        }
        for (const un of PH_UNPROVEN) console.log(`零串扰未证明：端口 ${un.port}（${un.reason}）`);
        console.log(`\n汇总：PASS=${PASS} FAIL=${FAIL}${FAILS.length ? `\n失败项：\n  ${FAILS.join('\n  ')}` : ''}`);
        if (FAIL === 0) process.exitCode = 0;
    })();
}
