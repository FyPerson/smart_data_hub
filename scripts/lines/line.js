#!/usr/bin/env node
/**
 * 线路工具入口（#106 多线并行改造 · S2b；修复批 2）
 *
 *   node scripts/lines/line.js new <线名> --module <模块> --surface "<预计改动面>" [--ack-overlap] [--no-config-key]
 *   node scripts/lines/line.js remove <线名> [--discard]
 *   node scripts/lines/line.js start <线名> [--ready-timeout <秒>] | stop <线名> | list [--json] | overlap <线名> [--json] | check-deps <线名> | recover <线名>   （S2c，实现在 line-run.js）
 *   node scripts/lines/line.js merge <线名> --base <B> --head <H> [--merge-commit]   （S7，实现在 line-merge.js；只在用户在场时于主工作区运行，按完整提交号；未跟踪文件不计入「干净」判定）
 *   node scripts/lines/line.js merge --branch <分支名> --base <B> --head <H> [--merge-commit]   （S7b：合入一个不是登记线的本地分支，如 B1 的改造分支；<线名> 与 --branch 二选一，都给 / 都不给是用法错误；--branch 只给 merge 用）
 *
 * 路径参数在正常使用时自动推导：主工作区根 = git 公共目录的父目录；控制根按 state.js（<主工作区根>/docs/local/多线并行/_state）；线目录根默认 E:/sdh-lines。
 * 测试通过显式参数覆盖：--control-root / --lines-root / --main-root（不经环境变量，避免 SDH_* 混入）。
 *   三个覆盖参数「全给或全不给」：部分给 → 用法错误；全给时，下面三种指向真实环境的取值一律拒绝（在读 .env、碰任何东西之前）：
 *     --control-root 等于真实主工作区（本脚本所在检出的 git 主仓库）的默认控制根；--main-root 等于该真实主仓库；--lines-root 等于或位于真实线目录根（默认 E:/sdh-lines）之内。
 *   （防止测试 / 误用触达真实仓库、真实登记表与真实线目录；脚本不在 git 仓库里时无从判定前两项，不做。）
 * 测试专用 --slot-ports <a,b,c>（H1）：把槽位 1/2/3 的端口换成这三个（只在本进程内存里换，经 state.js 的 _internal.setSlotPortsForTest；不写进登记表），让自检不占真实线用的 3100 / 3200 / 3300。
 *   只在三个根覆盖参数全给时接受（否则用法错误，退出码 2；在转发之前就拒）；端口表不合规（不是三个互不相同的 1024–65535 整数、含 3000 或 3100 / 3200 / 3300 之一）同样退出码 2；解析之后、读写登记表之前生效。不带它则用生产缺省 3100 / 3200 / 3300。
 *
 * 输出纪律：脱敏器（主 .env 的机密值）建立之前只输出固定错误文案，不回显原始参数与未处理的异常内容；脱敏器建立之后的错误统一经它（含 stack 与 cause 链，见 scrubError）。
 *
 * 入口转发（S2a 预筛待裁 C）：登记表由主工作区的代码管。从线检出（linked worktree）调用本脚本、且原始 argv 里没有任何根路径覆盖参数（`--x v` 与 `--x=v` 两种写法都扫）时，
 *   用 process.execPath 原样转发到 <主工作区根>/scripts/lines/line.js（argv、cwd、退出码透传；不经 shell）；主工作区里没有该文件则报错退出。转发之后才解析参数。
 *   已在主工作区里运行、或带了根路径覆盖参数（测试）时不转发。
 *   转发期间外层挂空的 SIGINT / SIGBREAK / SIGHUP 监听（forwardRun）：Ctrl+C 由内层自行收尾，外层透传退出码（外层若按默认处理直接退出，作业对象会立即杀掉内层，内层的信号清理不执行）。
 * 引导合入的就地运行例外（U13 = A，只用于 B1 这类「main 上还没有 scripts/lines/，把含工具的改造分支合进 main」）：从「脚本所在检出不是主工作区、但属于同一个仓库」的检出运行（decideForward 判为 linked-checkout）、转发目标不存在、没有根覆盖参数、argv 解析成功、
 *   且子命令是 merge 并给了 --branch，这五条同时成立时不转发、用本脚本就地运行（输出一行说明）；就地运行另有四道硬门（调 lineMerge 之前，只拒不放行）：脚本所在检出的 HEAD 必须等于 --head
 *   （LINE_INPLACE_NOT_AT_HEAD），脚本必须位于该检出的根上（scriptRoot = rev-parse --show-toplevel，LINE_INPLACE_NOT_TOPLEVEL：挡住副本放在 HEAD = H 的检出的未跟踪子目录里），
 *   scripts/lines/ 下不得有任何未跟踪 / 被忽略的项（LINE_INPLACE_UNTRACKED_TOOL：挡住 H 没有工具、根上放未跟踪副本或残留目录模块；残余：wbs-server/utils 的归属不核），已跟踪文件必须干净（口径同主工作区干净核对，LINE_INPLACE_DIRTY）——保证运行的工具就是要合入的那一版，且挡住「工具副本放在主工作区未跟踪子目录里」（HEAD = B ≠ H）；ctx 与主工作区自己的 line.js 不带覆盖参数运行时完全一致（mainRoot / controlRoot / linesRoot / .env 都按主工作区求）。
 *   其余情形不变：目标存在就照常转发；目标不存在时非 merge、或 merge 不带 --branch（线名入口），仍报错退出 1。
 * 本文件在决定是否转发之前只用 fs / path / child_process（不加载 sqlite3 等依赖），以便线检出里即使缺少其他文件也能转发。
 *
 * 退出码：0 成功；1 操作失败（含拒绝）；2 用法错误。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const DEFAULT_LINES_ROOT = 'E:/sdh-lines';
const ROOT_FLAGS = Object.freeze({ '--control-root': 'controlRoot', '--lines-root': 'linesRoot', '--main-root': 'mainRoot' });
const VALUE_FLAGS = Object.freeze(Object.assign({ '--module': 'module', '--surface': 'surface', '--ready-timeout': 'readyTimeoutSec', '--base': 'base', '--head': 'head', '--branch': 'branch', '--slot-ports': 'slotPorts' }, ROOT_FLAGS));   // --base / --head / --branch 只给 merge 用（parseArgv 末尾校验）
const BOOL_FLAGS = Object.freeze({
    new: Object.freeze({ '--ack-overlap': 'ackOverlap', '--no-config-key': 'noConfigKey' }), remove: Object.freeze({ '--discard': 'discard' }),
    start: Object.freeze({}), stop: Object.freeze({}), list: Object.freeze({ '--json': 'json' }), overlap: Object.freeze({ '--json': 'json' }), 'check-deps': Object.freeze({}), recover: Object.freeze({}),
    merge: Object.freeze({ '--merge-commit': 'mergeCommit' }),
});
const RUN_COMMANDS = Object.freeze(['start', 'stop', 'list', 'overlap', 'check-deps', 'recover']);   // S2c：实现在 line-run.js
// 所有子命令的布尔参数名并集（S2b 定稿只并了 new / remove；漏掉其余子命令会让 --json 之类被当成未知参数、按「不回显原始输入」处理）
const KNOWN_FLAGS = new Set([...Object.keys(VALUE_FLAGS), ...Object.values(BOOL_FLAGS).flatMap((m) => Object.keys(m))]);

const USAGE = [
    '用法：',
    '  node scripts/lines/line.js new <线名> --module <模块> --surface "<预计改动面>" [--ack-overlap] [--no-config-key]',
    '  node scripts/lines/line.js remove <线名> [--discard]',
    '  node scripts/lines/line.js start <线名> [--ready-timeout <秒>]',
    '  node scripts/lines/line.js stop <线名>',
    '  node scripts/lines/line.js list [--json]',
    '  node scripts/lines/line.js overlap <线名> [--json]',
    '  node scripts/lines/line.js check-deps <线名>',
    '  node scripts/lines/line.js recover <线名>',
    '  node scripts/lines/line.js merge <线名> --base <B> --head <H> [--merge-commit]   （只在用户在场时于主工作区运行；B、H 按完整 40 位小写十六进制提交号；未跟踪文件不计入干净判定）',
    '  node scripts/lines/line.js merge --branch <分支名> --base <B> --head <H> [--merge-commit]   （合入一个不是登记线的本地分支：<线名> 与 --branch 二选一；只收短名，不收 line/ 开头与 main；其余核对与线名入口相同；例外：主工作区没有 scripts/lines/ 时，只有 merge --branch 才在「不是主工作区、但属于同一个仓库」的检出里就地运行，且要求该检出 HEAD = --head、脚本位于该检出的根上、工具文件都被 HEAD 跟踪、已跟踪文件干净，仅用于 B1 这类引导合入）',
    '路径覆盖（测试用，三个必须同时给）：--control-root <目录> --lines-root <目录> --main-root <目录>',
    '测试端口表（测试用，只在三个路径覆盖参数都给时接受）：--slot-ports <槽位1端口>,<槽位2端口>,<槽位3端口>   （三个互不相同的 1024–65535 整数，不得含 3000、3100、3200、3300）',
].join('\n');

/** 扫原始 argv：返回出现过的根路径覆盖参数名集合（`--x v` 与 `--x=v` 都算）。 */
function scanRootOverrides(argv) {
    const present = new Set();
    for (const t of argv) {
        if (typeof t !== 'string' || !t.startsWith('--')) continue;
        const eq = t.indexOf('=');
        const flag = eq === -1 ? t : t.slice(0, eq);
        if (Object.prototype.hasOwnProperty.call(ROOT_FLAGS, flag)) present.add(flag);
    }
    return present;
}

/** 原始 argv 里有没有给 --slot-ports（`--slot-ports v` 与 `--slot-ports=v` 两种写法都算）。 */
function hasSlotPortsFlag(argv) {
    return argv.some((t) => typeof t === 'string' && (t === '--slot-ports' || t.startsWith('--slot-ports=')));
}

/** 解析 argv（不含 node 与脚本路径）。返回 { ok: true, cmd, name, opts, roots, help } 或 { ok: false, error }。 */
function parseArgv(argv) {
    const toks = Array.from(argv);
    if (toks.length === 0) return { ok: false, error: '缺少子命令' };
    if (toks[0] === '--help' || toks[0] === '-h' || toks[0] === 'help') return { ok: true, help: true };
    const cmd = toks.shift();
    // 错误文案不回显原始参数（脱敏器此时还没建立，误粘贴到命令 / 参数位置的密钥不能进终端日志）；只回显本脚本自己认识的参数名
    if (cmd !== 'new' && cmd !== 'remove' && cmd !== 'merge' && !RUN_COMMANDS.includes(cmd)) return { ok: false, error: `未知子命令（可用：new / remove / merge / ${RUN_COMMANDS.join(' / ')}；原始输入不回显）` };
    const opts = {};
    const roots = {};
    const positional = [];
    const seenValueFlags = new Set();
    for (let i = 0; i < toks.length; i += 1) {
        const t = toks[i];
        if (!t.startsWith('--')) { positional.push(t); continue; }
        const eq = t.indexOf('=');
        const flag = eq === -1 ? t : t.slice(0, eq);
        if (Object.prototype.hasOwnProperty.call(VALUE_FLAGS, flag)) {
            // 同一个取值参数重复出现（含 `--x v` 与 `--x=v` 混用）一律拒绝：静默取最后一个会让「前面写的」被悄悄忽略（只拒不放行）
            if (seenValueFlags.has(flag)) return { ok: false, error: `${flag} 重复给出` };
            seenValueFlags.add(flag);
            let value;
            if (eq !== -1) value = t.slice(eq + 1);
            else {
                value = toks[i + 1];
                i += 1;
                if (value === undefined || value.startsWith('--')) return { ok: false, error: `${flag} 缺少取值` };
            }
            if (value === '') return { ok: false, error: `${flag} 的取值不能为空` };
            const field = VALUE_FLAGS[flag];
            if (Object.prototype.hasOwnProperty.call(ROOT_FLAGS, flag)) roots[field] = path.resolve(value);
            else if (flag === '--slot-ports') {
                // 只检查形态（恰好三段十进制整数）；取值范围与互异等由 state.js 的 setSlotPortsForTest 判定。错误文案不回显原始取值
                if (!/^[0-9]{1,6},[0-9]{1,6},[0-9]{1,6}$/.test(value)) return { ok: false, error: '--slot-ports 必须是三个用逗号分隔的整数：<槽位1端口>,<槽位2端口>,<槽位3端口>' };
                opts[field] = value.split(',').map(Number);
            } else opts[field] = value;
        } else if (Object.prototype.hasOwnProperty.call(BOOL_FLAGS[cmd], flag)) {
            if (eq !== -1) return { ok: false, error: `${flag} 不接受取值` };
            opts[BOOL_FLAGS[cmd][flag]] = true;
        } else if (KNOWN_FLAGS.has(flag)) {
            return { ok: false, error: `${cmd} 不支持参数：${flag}` };
        } else {
            return { ok: false, error: `${cmd} 不支持的参数（不是本脚本认识的参数名；原始输入不回显）` };
        }
    }
    if (opts.slotPorts !== undefined && Object.keys(roots).length !== Object.keys(ROOT_FLAGS).length) return { ok: false, error: '--slot-ports 只在三个根路径覆盖参数（--control-root / --lines-root / --main-root）全给时接受' };
    if (cmd !== 'merge' && opts.branch !== undefined) return { ok: false, error: `${cmd} 不接受 --branch` };
    if (cmd === 'list') {
        if (positional.length !== 0) return { ok: false, error: `list 不接受位置参数，收到 ${positional.length} 个` };
    } else if (cmd === 'merge') {
        // 线名（位置参数）与 --branch 二选一
        if (positional.length > 1) return { ok: false, error: `merge 最多一个线名，收到 ${positional.length} 个位置参数` };
        if (positional.length === 1 && opts.branch !== undefined) return { ok: false, error: 'merge 的 <线名> 与 --branch 只能给一个' };
        if (positional.length === 0 && opts.branch === undefined) return { ok: false, error: 'merge 需要 <线名> 或 --branch <分支名> 之一' };
    } else if (positional.length !== 1) return { ok: false, error: `${cmd} 需要恰好一个线名，收到 ${positional.length} 个位置参数` };
    if (cmd === 'new') {
        if (opts.module === undefined) return { ok: false, error: 'new 缺少 --module <模块>' };
        if (opts.surface === undefined) return { ok: false, error: 'new 缺少 --surface "<预计改动面>"' };
    } else if (opts.module !== undefined || opts.surface !== undefined) {
        return { ok: false, error: `${cmd} 不接受 --module / --surface` };
    }
    if (cmd === 'merge') {
        if (opts.base === undefined) return { ok: false, error: 'merge 缺少 --base <B>' };
        if (opts.head === undefined) return { ok: false, error: 'merge 缺少 --head <H>' };
    } else if (opts.base !== undefined || opts.head !== undefined) {
        return { ok: false, error: `${cmd} 不接受 --base / --head` };
    }
    if (opts.readyTimeoutSec !== undefined) {
        if (cmd !== 'start') return { ok: false, error: `${cmd} 不接受 --ready-timeout` };
        if (!/^[1-9][0-9]{0,3}$/.test(opts.readyTimeoutSec)) return { ok: false, error: '--ready-timeout 必须是 1–9999 的整数秒' };
        opts.readyTimeoutSec = Number(opts.readyTimeoutSec);
    }
    return { ok: true, cmd, name: positional[0], opts, roots };
}

function cleanGitEnv() {
    const env = Object.assign({}, process.env);
    for (const k of Object.keys(env)) if (['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(k.toUpperCase())) delete env[k];
    return env;
}
function realOf(p) { try { return fs.realpathSync.native(p); } catch (_) { return path.resolve(p); } }
const fold = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);

/** 决定是否转发（只看原始 argv 里有没有根路径覆盖参数）：{ forward, target?, mainRoot?, reason, error? }。scriptRoot = 运行本脚本的检出根。 */
function decideForward({ argv, scriptRoot }) {
    if (scanRootOverrides(argv || []).size > 0) return { forward: false, reason: 'roots-overridden' };
    let out;
    try {
        out = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: scriptRoot, env: cleanGitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 60000 });
    } catch (_) {
        // 固定文案：脱敏器此时还没建立，不回显 git / 系统的原始异常内容
        return { forward: false, reason: 'no-git', error: '无法判定主工作区：在脚本所在目录执行 git rev-parse --git-common-dir 失败（详情已隐藏）' };
    }
    const commonDir = path.resolve(scriptRoot, String(out).trim());
    // 固定文案：脱敏器此时还没建立，不插入 commonDir
    if (path.basename(commonDir).toLowerCase() !== '.git') return { forward: false, reason: 'no-git', error: 'git 公共目录不是名为 .git 的主仓库目录（裸库 / 子模块 / 分离的 git 目录不支持；路径已隐藏）' };
    const mainRoot = realOf(path.dirname(commonDir));
    if (fold(realOf(scriptRoot)) === fold(mainRoot)) return { forward: false, reason: 'in-main', mainRoot };
    return { forward: true, mainRoot, target: path.join(mainRoot, 'scripts', 'lines', 'line.js'), reason: 'linked-checkout' };
}

/** 异常里可以安全带出的错误码（只认全大写下划线的码，其余一律当作未知）。 */
const safeCode = (e) => (e && typeof e.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(e.code) ? e.code : 'ERROR');

/** 转发期间外层挂上的空监听的信号（见 forwardRun）。 */
const FORWARD_SIGNALS = Object.freeze(['SIGINT', 'SIGBREAK', 'SIGHUP']);

/**
 * 用 process.execPath 把 argv 原样转发给 target（不经 shell；cwd、stdio、退出码透传）。
 * 转发期间（spawnSync 之前注册、结束后移除）外层挂空的 SIGINT / SIGBREAK / SIGHUP 监听：Ctrl+C 发给整个控制台进程组，外层若按默认处理会立刻退出，
 * libuv 的作业对象（关闭即终止）随之立即杀掉内层，内层 line start 的信号清理（收子进程、清登记）就没有机会执行；有监听后外层不退出，等内层自己收尾，再透传内层的退出码。
 * deps.spawnSync 仅供测试替换（验证「spawnSync 被调用时监听已注册、返回后已移除」）。
 */
function forwardRun(target, argv, deps) {
    const spawn = (deps && deps.spawnSync) || spawnSync;
    const noop = () => {};
    for (const s of FORWARD_SIGNALS) process.on(s, noop);
    let r;
    try {
        r = spawn(process.execPath, [target, ...argv], { cwd: process.cwd(), stdio: 'inherit', windowsHide: true });
    } finally {
        for (const s of FORWARD_SIGNALS) process.removeListener(s, noop);
    }
    if (r.error) { console.error(`错误：转发失败（启动子进程出错，错误码 ${safeCode(r.error)}；详情已隐藏）`); return 1; }
    return r.status === null ? 1 : r.status;
}

/**
 * opts.realLinesRoot：「真实线目录根」，缺省 DEFAULT_LINES_ROOT（E:/sdh-lines）；仅供测试把它指到临时目录，用来验证 --lines-root 覆盖到真实值被拒（不经环境变量）。
 */
async function run(argv, scriptRoot, opts) {
    const realLinesRoot = (opts && opts.realLinesRoot) || DEFAULT_LINES_ROOT;
    // 先扫原始 argv：根路径覆盖参数全给或全不给
    const present = scanRootOverrides(argv);
    if (present.size > 0 && present.size < Object.keys(ROOT_FLAGS).length) {
        const missing = Object.keys(ROOT_FLAGS).filter((f) => !present.has(f));
        console.error(`用法错误：根路径覆盖参数必须全给或全不给，缺少 ${missing.join('、')}\n${USAGE}`);
        return 2;
    }
    // --slot-ports 只给测试用：没有三个根覆盖参数就在转发之前拒绝（不能让它被原样转发到别处的 line.js）
    if (hasSlotPortsFlag(argv) && present.size !== Object.keys(ROOT_FLAGS).length) {
        console.error(`用法错误：--slot-ports 只在三个根路径覆盖参数（--control-root / --lines-root / --main-root）全给时接受\n${USAGE}`);
        return 2;
    }
    // 再决定转发（转发之后才解析参数；主工作区的 line.js 自己报用法错误）。转发阶段的错误只输出固定文案
    const fwd = decideForward({ argv, scriptRoot });
    if (fwd.error) { console.error(`错误：${fwd.error}`); return 1; }
    // 引导合入的就地运行例外（U13 = A）：main 上没有 scripts/lines/（B1 合入改造分支时就是这样），从改造分支所在的检出（不是主工作区、但属于同一个仓库）运行时无处可转发。
    // 只在下面五条同时成立时就地运行（只拒不放行地收窄）：decideForward 判为 linked-checkout；转发目标不存在；没有根覆盖参数（forward 为真已蕴含）；argv 解析成功；子命令是 merge 且给了 --branch。
    // 其余情形一律不变：目标存在就照常转发；目标不存在时，非 merge、或 merge 不带 --branch（线名入口），仍报错退出 1。
    let inPlace = false;
    if (fwd.forward) {
        if (!fs.existsSync(fwd.target)) {
            const pre = parseArgv(argv);
            if (fwd.reason === 'linked-checkout' && pre.ok && !pre.help && pre.cmd === 'merge' && pre.opts.branch !== undefined) inPlace = true;
            else { console.error('错误：主工作区里没有 scripts/lines/line.js，无法转发（线路登记表由主工作区的代码管理；路径已隐藏）'); return 1; }
        }
        if (!inPlace) {
            if (fold(realOf(fwd.target)) === fold(realOf(__filename))) { console.error('错误：转发目标就是当前脚本，拒绝循环转发'); return 1; }
            return forwardRun(fwd.target, argv);
        }
    }

    const parsed = parseArgv(argv);
    if (!parsed.ok) { console.error(`用法错误：${parsed.error}\n${USAGE}`); return 2; }
    if (parsed.help) { console.log(USAGE); return 0; }

    // redact === null 表示脱敏器尚未建立：此阶段的任何失败只输出固定文案（LineError 带 fixed:true 的除外，那是本脚本自己写死的文案）
    let redact = null;
    const emit = (e) => {
        if (redact === null && !(e && e.fixed === true)) {
            console.error(`错误[${safeCode(e)}]：初始化阶段失败（脱敏器尚未建立，详情已隐藏）`);
            return;
        }
        const rd = redact || ((t) => String(t));
        let C0 = null;
        try { C0 = require('./line-common'); } catch (_) { C0 = null; }
        if (C0) C0.scrubError(e, rd);   // message / stack / cause 链 / 异常上的字符串字段
        console.error(rd(`错误[${safeCode(e)}]：${e && e.message ? e.message : '（无消息）'}`));
    };
    let SS = null;   // state.js 模块（加载后才有）：finally 里据此还原端口表
    try {
        const C = require('./line-common');
        const S = require('./state');
        SS = S;
        const { lineNew } = require('./line-new');
        const { lineRemove } = require('./line-remove');
        const fixedBad = (msg) => new C.LineError('LINE_BAD_ARGS', msg, { fixed: true });
        const overridden = Object.keys(parsed.roots).length > 0;
        let realMain = null;
        try { realMain = C.gitMainRoot(scriptRoot); } catch (_) { realMain = null; }
        let realDefaultControl = null;
        try { realDefaultControl = S.resolveControlRoot({ cwd: scriptRoot }); } catch (_) { realDefaultControl = null; }
        if (overridden) {
            // 覆盖参数指向真实环境一律拒绝（在读任何 .env 之前）；文案写死，不回显取值
            if (realDefaultControl !== null && C.pathKey(parsed.roots.controlRoot) === C.pathKey(realDefaultControl)) {
                throw fixedBad('--control-root 指向真实主工作区的默认控制根：测试覆盖参数不得用来写真实登记表');
            }
            if (realMain !== null && C.pathKey(parsed.roots.mainRoot) === C.pathKey(realMain)) {
                throw fixedBad('--main-root 指向脚本所在检出的真实主仓库：测试覆盖参数不得用来对真实仓库建线或删线');
            }
            // 归属比较（LOW-1）：--main-root 不得是真实仓库的任何 worktree（含 linked worktree），即它的 git 公共目录归属不得等于真实仓库；只拒不放行（求不出归属——不是 git 仓库——则不属于真实仓库，不在此拒绝）
            let overrideOwner = null;
            try { overrideOwner = C.gitMainRoot(parsed.roots.mainRoot); } catch (_) { overrideOwner = null; }
            if (overrideOwner !== null && realMain !== null && C.pathKey(overrideOwner) === C.pathKey(realMain)) {
                throw fixedBad('--main-root 属于脚本所在检出的真实仓库（它的某个 worktree）：测试覆盖参数不得用来对真实仓库建线 / 删线 / 合并');
            }
            if (C.pathKey(parsed.roots.linesRoot) === C.pathKey(realLinesRoot) || C.isInside(path.resolve(realLinesRoot), path.resolve(parsed.roots.linesRoot))) {
                throw fixedBad('--lines-root 等于或位于真实线目录根之内：测试覆盖参数不得用来在真实线目录里建线或删线');
            }
        }
        // 测试端口表：在读写登记表（以及读 .env）之前生效；不合规固定文案退出 2（消息里只有 state.js 自己写死的文案，不回显取值）。
        // 作用域是本次 run（codex 42 M）：不带 --slot-ports 时明确选定生产缺省（不沿用同进程上一次 run 留下的测试表）；run 退出时（含异常）在 finally 里还原缺省。
        // 只支持同进程串行调用 run：并发交错时共享 state.js 的模块级端口表，会互相改写（codex 42-R L1，测试专用路径，登记残余）
        S._internal.setSlotPortsForTest(null);
        if (parsed.opts.slotPorts !== undefined) {
            try { S._internal.setSlotPortsForTest(parsed.opts.slotPorts); } catch (e) { throw fixedBad(`--slot-ports 不合规：${e && e.message}`); }
        }
        const mainRoot = parsed.roots.mainRoot || realMain || C.gitMainRoot(scriptRoot);
        // 就地运行：ctx 必须与「主工作区自己的 line.js 不带覆盖参数运行」算出的完全一致——下面的 mainRoot / controlRoot / linesRoot / .env 与脱敏器都复用同一段代码，
        // 它们都按 git 公共目录（= 主工作区）求，不是脚本所在的 worktree；这里再核一次 mainRoot 确实是 decideForward 求出的主工作区根（不符固定文案退出 1）
        if (inPlace && fold(realOf(mainRoot)) !== fold(fwd.mainRoot)) throw new C.LineError('LINE_INPLACE_MAIN_MISMATCH', '就地运行：ctx.mainRoot 与 decideForward 求出的主工作区根不一致，拒绝（路径已隐藏）', { fixed: true });
        redact = C.loadMainEnv(mainRoot).redact;   // 读不了 .env 抛出，由 emit 输出固定文案（此时脱敏器未建立）
        const controlRoot = parsed.roots.controlRoot !== undefined ? parsed.roots.controlRoot : S.resolveControlRoot({ cwd: scriptRoot });
        const ctx = {
            mainRoot,
            controlRoot,
            linesRoot: parsed.roots.linesRoot || path.resolve(realLinesRoot),
            out: (s) => console.log(redact(s)),
            runNpmLs: overridden ? false : true,   // 正常模式（没有任何测试覆盖路径）才跑 npm ls
        };
        if (parsed.cmd === 'new') {
            await lineNew(ctx, { name: parsed.name, module: parsed.opts.module, surface: parsed.opts.surface, ackOverlap: !!parsed.opts.ackOverlap, noConfigKey: !!parsed.opts.noConfigKey });
        } else if (parsed.cmd === 'remove') {
            await lineRemove(ctx, { name: parsed.name, discard: !!parsed.opts.discard });
        } else if (parsed.cmd === 'merge') {
            if (inPlace) {
                // 就地运行的四道硬门（只拒不放行；固定文案，不回显路径）：运行的工具必须就是要合入的那一版——脚本所在检出的 HEAD = --head、脚本在该检出的根上、工具文件都被 HEAD 跟踪、已跟踪文件干净
                const gitIn = (args) => spawnSync('git', args, { cwd: scriptRoot, env: cleanGitEnv(), encoding: 'utf8', windowsHide: true, timeout: 60000 });
                const hd = gitIn(['rev-parse', 'HEAD']);
                if (hd.status !== 0 || String(hd.stdout).trim() !== parsed.opts.head) throw new C.LineError('LINE_INPLACE_NOT_AT_HEAD', '就地运行：脚本所在检出的 HEAD 不等于 --head（运行的工具不是要合入的那一版；路径已隐藏）', { fixed: true });
                // 第三道门（codex 36 M1）：脚本必须位于那个检出的根上（scriptRoot = git rev-parse --show-toplevel）。否则工具副本可以放在 HEAD = H 的检出的未跟踪子目录里，
                // 前两道门都看不到它（HEAD 取的是外层检出，status 不计未跟踪文件），运行的就不是 H 里的那一版
                const tl = gitIn(['rev-parse', '--show-toplevel']);
                if (tl.status !== 0 || fold(realOf(String(tl.stdout).trim())) !== fold(realOf(scriptRoot))) throw new C.LineError('LINE_INPLACE_NOT_TOPLEVEL', '就地运行：脚本不在所在检出的根目录上（工具副本放在检出的子目录里？运行的工具不是要合入的那一版；路径已隐藏）', { fixed: true });
                // 第四道门（codex 36-R / 36-R2 M1）：scripts/lines/ 下不得有任何未跟踪或被忽略的项（`ls-files -o` 不带 --exclude-standard，被忽略的也列出；正在运行的 line.js 若未被跟踪也会列在其中）。
                // 配合干净门（已跟踪文件与 HEAD 一致），scripts/lines/ 里能被 require 到的源码（含目录模块、只差大小写的文件）都是 H 里那一份。
                // 安装依赖（wbs-server/node_modules）不在此列；wbs-server/utils 的归属不核（残余，见文件头）
                const untrackedTool = gitIn(['ls-files', '-o', '-z', '--', 'scripts/lines']);
                // 顺序：干净门在前（索引读不了时先报「无法确认干净」），工具跟踪门在后
                const st = gitIn(['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=no', '--no-renames', '--ignore-submodules=none']);
                if (st.status !== 0) throw new C.LineError('LINE_INPLACE_DIRTY', '就地运行：无法确认脚本所在检出的已跟踪文件是否干净（git status 失败；路径已隐藏）', { fixed: true });
                if (String(st.stdout) !== '') throw new C.LineError('LINE_INPLACE_DIRTY', '就地运行：脚本所在检出的已跟踪文件有改动或暂存（运行的工具不是要合入的那一版；路径已隐藏）', { fixed: true });
                if (untrackedTool.status !== 0 || String(untrackedTool.stdout) !== '') throw new C.LineError('LINE_INPLACE_UNTRACKED_TOOL', '就地运行：scripts/lines/ 下有未跟踪 / 被忽略的项（运行的工具不是要合入的那一版；路径已隐藏）', { fixed: true });
                ctx.out('主工作区没有 scripts/lines/line.js：按引导合入就地运行（仅 merge --branch）');
            }
            await require('./line-merge').lineMerge(ctx, { name: parsed.name, branch: parsed.opts.branch, base: parsed.opts.base, head: parsed.opts.head, mergeCommit: !!parsed.opts.mergeCommit });
        } else {
            await require('./line-run').dispatch(parsed.cmd, ctx, parsed);
        }
        return 0;
    } catch (e) {
        emit(e);
        return e && e.code === 'LINE_BAD_ARGS' ? 2 : 1;
    } finally {
        if (SS) SS._internal.setSlotPortsForTest(null);   // 还原生产缺省（null 不会抛）
    }
}

if (require.main === module) {
    run(process.argv.slice(2), path.resolve(__dirname, '..', '..')).then((code) => { process.exitCode = code; }, (e) => { console.error(`错误[${safeCode(e)}]：入口发生未处理的异常（脱敏器可能尚未建立，详情已隐藏）`); process.exitCode = 1; });
}

module.exports = { parseArgv, decideForward, scanRootOverrides, run, forwardRun, FORWARD_SIGNALS, USAGE, DEFAULT_LINES_ROOT };
