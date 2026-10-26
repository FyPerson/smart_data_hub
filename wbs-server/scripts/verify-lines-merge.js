/**
 * #106 S7 验证：line merge（scripts/lines/line-merge.js + line.js 接线）。单文件自检，不需要监督模块。
 *
 * 全部在测试自建的临时 git 仓库里执行：os.tmpdir() 下建「中文 + 空格」目录，内含一个「主工作区」仓库、线目录根、控制根（登记表由 state.js 的 createLine 写入）；
 * 被测命令以子进程运行 node scripts/lines/line.js merge ... --control-root <临时> --lines-root <临时> --main-root <临时>（三个根都先校验在 os.tmpdir() 之内）。
 * 绝不对真实仓库运行 line merge；不开业务库、不读 .env、不碰 E:/sdh-lines。
 * 清理只用 unlinkSync / rmdirSync 逐项（链接只拆不跟随），不用 fs.rmSync / fs.cpSync（Node v24 对中文路径不可靠）；残留判红。
 *
 * 每个拒绝用例都断言「什么都没变」：运行前后 refs/heads/main、HEAD、symbolic-ref HEAD、全部 refs、status --porcelain=v1 -z --untracked-files=all --ignored（被忽略文件也看得见）、
 *   夹具声明的被忽略文件内容（fx.watch）、进行中的操作标记、ORIG_HEAD / index.lock / MERGE_MSG 是否存在全等（git merge 已经开始过的用例，ORIG_HEAD 允许变为合并前的 main）。
 * 并发写入用 git 钩子模拟，不在被测代码里留接缝：core.fsmonitor 钩子在被测命令的第一次 `git status`（干净核对）时执行一段 shell，把 main 挪到别的提交、或造出 index.lock，
 *   落在「前置核对已通过」与「git merge 开始」之间；post-merge 钩子再武装一次同样的注入，落在「合并已完成」与「事后核对的 git status」之间。
 * L4（自检的已知脆弱点）：git 的 status / ls-files / diff-tree / reset / merge 都会触发 fsmonitor 钩子，rev-parse 不触发。所以本文件的并发注入点 =
 *   「被测代码里第一个读索引的 git 调用」（目前是前置核对里的 `git status`）；调整被测代码里 git 调用的先后顺序时，注入点会悄悄移位（注入没发生时 `injectConsumed` 断言会判红，不会静默通过）。
 * 事后核对失败不回滚（用户裁定 U11 = A）：相关用例断言「没有任何 git 写操作」——main / HEAD 停在 git merge 之后的值、main 的 reflog 条数与手写期望相等且没有 reset 条目、
 *   ORIG_HEAD 仍是合并起点 B、工作区改动与未跟踪文件原样保留。
 * 进行中的标记名在本文件里独立写出（TEST_MARKS），不取被测代码的常量。
 *
 * 节：1 快进正常（线名大小写不敏感）  2 main 已前进  3 线分支 / 线 worktree HEAD 不符（含 worktree 目录缺失只看分支）  4 已跟踪文件改动 / 暂存 / 子模块改脏（配置想藏起来）
 *   5 无关未跟踪文件不影响  6 未跟踪文件会被覆盖 → git 拒绝  7 主工作区不在 main  8 integration_branch 不是 main  9 B / H 不合法
 *   10 快进时 B 不是祖先  11 进行中的操作（七种标记，含 sequencer）  12 线名不存在  13 用法错误（退出码 2）  14 --merge-commit 正常（含删除 / 新增 / 中文空格路径 / B 是 H 的祖先）
 *   15 --merge-commit 路径交集  16 --merge-commit 时 H 已是 B 的祖先  17 钩子拒绝（pre-merge-commit；含钩子先移动 main 再退出 1）  18 纯函数（树核对 / 父提交核对）
 *   19 事后核对失败一律不回滚（钩子造意外提交 / 钩子改脏文件，快进与 merge-commit；文案含人工回退指引）  20 登记表不可信（分支名、worktree 路径、lifecycle 三种非 ready）
 *   21 并发写入（main 在核对与合并之间被移动：三种；陈旧 ORIG_HEAD；事后核对之后 main 又被移动；index.lock）  22 合并失败残留未跟踪文件（> 260 字符路径）
 *   23 交叉合并历史  24 主侧改名 + 线侧改原文件  25 根覆盖参数指向「真实仓库的 linked worktree」（用临时仓库充当真实仓库）
 *   26 被忽略 / 未跟踪的同名文件（快进、merge-commit、ENOTDIR、只差大小写、对照）  27 git 失败后合并前的未跟踪路径消失 → UNKNOWN  28 交集按小写比较
 *   29 子模块指针双方都改（submodule.<名>.ignore = all 想藏起来）  30 git merge 成功后读 ORIG_HEAD 失败 → UNKNOWN
 *   31 类型感知的前置核对（目录换文件、gitlink 单侧改指针放行 / gitlink 换成文件拒绝、只改大小写的改名）  32 merge-commit 钉死 merge.directoryRenames=false  33 快进 --no-overwrite-ignore 兜底（注入落在 git merge 自己的 fsmonitor 调用里）
 *   34 跨侧祖先路径冲突（文件 / 同名目录下的路径，35a-H1）  35 sequencer（35a-M1）  36 树核对接线（35b-H1）  37 事后核对本身出错（35b-H2）  38 登记表只读（35b-H4）  39 快进 main / HEAD 两项分开约束（35b-H5）
 *   41 S7b --branch 入口（快进 / merge-commit 成功含登记表逐字节不变；二选一；分支名校验；line/ 与 main；分支 ≠ H；保留的核对与共用路径；事后核对失败；登记表不存在）
 *   夹具 git 环境隔离（35b-M1）：cleanEnv 清除 GIT_DIR / GIT_COMMON_DIR / GIT_WORK_TREE / GIT_INDEX_FILE / GIT_OBJECT_DIRECTORY / GIT_ALTERNATE_OBJECT_DIRECTORIES / GIT_NAMESPACE / GIT_TEMPLATE_DIR / 全部 GIT_CONFIG*，
 *   GIT_CONFIG_GLOBAL 指向私有空文件、GIT_CONFIG_NOSYSTEM=1，夹具仓库首次提交前把 core.hooksPath 固定为自己的 .git/hooks。被测代码 line-common 的 cleanGitEnv 只清前四个变量（不改，见报告）。
 * git merge 失败不 abort（用户裁定 U12 = A）：有 MERGE_HEAD 时断言 GIT_FAILED_IN_PROGRESS + MERGE_HEAD 仍在 + main / reflog 不动 + 文案含人工指引（17、27.1）；没有 MERGE_HEAD 的失败照旧只读核对（27.2 / 27.3）。
 * 「注入落在 git merge 自己的那次 fsmonitor 调用」用校准实现（calibrateMergeCall）：同形状夹具先跑一次成功合并，post-merge 钩子记下累计调用次数，再让真实用例的钩子在那一次动手。
 *   脆弱点：若将来 git merge 不再调用 fsmonitor，校准出的 N 会退到 untrackedPaths 的第二次 ls-files（merge 之前最后一次触发 fsmonitor 的调用）；33 / 27.2 的结论不变（注入仍落在前置核对全部做完之后、git merge 开始之前），
 *   但「落在 git merge 自己的那次调用里」就不再准确了。
 *
 * 运行：node wbs-server/scripts/verify-lines-merge.js [--lines-dir=<被测 scripts/lines 目录的绝对路径>] [--only=1,5]
 *   --lines-dir 仅供变异演练（把被测目录指到副本）；缺省为本检出的 scripts/lines。输出末行 `汇总：PASS=<n> FAIL=<n>`，有失败退出码 1。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const argOf = (prefix) => process.argv.find((a) => a.startsWith(prefix));
const LINES_DIR_ARG = argOf('--lines-dir=');
const LINES_DIR = path.resolve(LINES_DIR_ARG ? LINES_DIR_ARG.slice('--lines-dir='.length) : path.join(__dirname, '..', '..', 'scripts', 'lines'));
const ONLY_ARG = argOf('--only=');
const ONLY = ONLY_ARG ? new Set(ONLY_ARG.slice('--only='.length).split(',').map((s) => s.trim())) : null;
const lib = (n) => require(path.join(LINES_DIR, n));
const C = lib('line-common.js');
const S = lib('state.js');
const M = lib('line-merge.js');
const LINE_JS = path.join(LINES_DIR, 'line.js');

// ---------------------------------------------------------------- 断言与汇总

let PASS = 0;
let FAIL = 0;
const FAILS = [];
function check(name, cond, detail) {
    if (cond) { PASS += 1; return; }
    FAIL += 1;
    FAILS.push(name);
    console.log(`  FAIL  ${name}${detail === undefined ? '' : `  -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
}
const section = (id, title) => console.log(`\n=== ${id} ${title}`);
const want = (id) => ONLY === null || ONLY.has(String(id));

// ---------------------------------------------------------------- git 与文件助手（测试侧独立实现）

const GIT_ID = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false'];
/**
 * 夹具子进程（含被测命令及其 git 子进程、钩子）的 git 环境隔离（35b-M1）：
 *   清除仓库定位 / 对象目录 / 模板 / 配置注入类变量——GIT_DIR、GIT_COMMON_DIR、GIT_WORK_TREE、GIT_INDEX_FILE、GIT_OBJECT_DIRECTORY、GIT_ALTERNATE_OBJECT_DIRECTORIES、GIT_NAMESPACE、
 *   GIT_TEMPLATE_DIR（codex 35b-R M1：模板目录里启用的钩子会在 git init 时被复制进 .git/hooks；私有全局配置同时让 init.templateDir 失效，git init 回到内置模板，只有不执行的 *.sample）、
 *   以及所有 GIT_CONFIG*（GIT_CONFIG、GIT_CONFIG_PARAMETERS、GIT_CONFIG_COUNT、GIT_CONFIG_KEY_<n> / GIT_CONFIG_VALUE_<n>、GIT_CONFIG_GLOBAL、GIT_CONFIG_SYSTEM、GIT_CONFIG_NOSYSTEM）；
 *   再把 GIT_CONFIG_GLOBAL 指向本进程私有的空文件、GIT_CONFIG_NOSYSTEM=1：用户全局 / 系统配置（core.hooksPath、core.autocrlf、credential.*、init.*……）都不进入夹具。
 *   取舍（git 2.43 for Windows 实测）：系统配置里 Git for Windows 的 core.symlinks 等默认值丢失——本文件不依赖它们（链接一律用 junction，行尾显式 core.autocrlf=false，longpaths 在用例 22 显式设置）。
 */
const GIT_EMPTY_CONFIG = path.join(os.tmpdir(), `lines-merge-empty-gitconfig-${process.pid}`);
const GIT_ENV_DROP = new Set(['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_TEMPLATE_DIR']);
function cleanEnv() {
    const env = Object.assign({}, process.env);
    for (const k of Object.keys(env)) if (GIT_ENV_DROP.has(k.toUpperCase()) || /^GIT_CONFIG/i.test(k)) delete env[k];   // Windows 环境变量名不分大小写
    env.GIT_CONFIG_GLOBAL = GIT_EMPTY_CONFIG;
    env.GIT_CONFIG_NOSYSTEM = '1';
    return env;
}
/** 夹具搭建用：失败抛错。 */
function git(cwd, args) {
    const r = spawnSync('git', [...GIT_ID, ...args], { cwd, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 60000 });
    if (r.error || r.status !== 0) throw new Error(`git ${args.join(' ')} 失败（${r.status}）：${r.stderr || (r.error && r.error.message)}`);
    return r.stdout;
}
/** 读状态用：不抛错，返回 `status|stdout|stderr`（稳定字符串，供快照比较）。 */
function gq(cwd, args) {
    const r = spawnSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 60000 });
    return `${r.error ? 'ERR' : r.status}|${r.stdout}|${r.status === 0 ? '' : r.stderr}`;
}
/** 夹具搭建用，带 stdin。 */
function gitIn(cwd, args, input) {
    const r = spawnSync('git', [...GIT_ID, ...args], { cwd, env: cleanEnv(), encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, timeout: 60000 });
    if (r.error || r.status !== 0) throw new Error(`git ${args.join(' ')} 失败（${r.status}）：${r.stderr || (r.error && r.error.message)}`);
    return r.stdout;
}
const oidOf = (cwd, rev) => git(cwd, ['rev-parse', '--verify', rev]).trim();
const w = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const rd = (file) => fs.readFileSync(file, 'utf8');
/** 主工作区「进行中的操作」七种标记（含 sequencer）：本文件独立写出，不取被测代码的常量。 */
const TEST_MARKS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_LOG', 'sequencer'];

/** 不跟随链接地逐项删除；返回残留路径数组。 */
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

// ---------------------------------------------------------------- 夹具

const ALL_ROOTS = [];
let rootSeq = 0;
const nLines = (prefix, n) => `${Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join('\n')}\n`;

/**
 * 建夹具：主工作区仓库（main 一个提交 B0）+ 线 worktree（line/<name> 从 B0 起）+ 登记表。
 * o.ignore 主工作区 .gitignore 的内容（随初始提交一起提交，线也继承）；o.files 额外的初始已跟踪文件 { 相对路径: 内容 }；
 * o.name 线名（默认 Line-A，登记大小写与 CLI 传入的不同，顺带验证不分大小写）；o.branch 登记的分支名（默认 line/<name>）；
 * o.worktreeReg 登记表里的 worktree 路径（默认 = 真实建出的那个）；o.lifecycle 登记的 lifecycle（默认 ready；creating / removing / failed 供拒绝用例）。
 */
async function build(label, o) {
    const opt = o || {};
    rootSeq += 1;
    const root = path.join(os.tmpdir(), `合并 测试 ${process.pid}-${rootSeq}-${label}`);
    if (!C.isInside(os.tmpdir(), root)) throw new Error('夹具根不在系统临时目录内');
    ALL_ROOTS.push(root);
    const main = path.join(root, '主 工作区');
    const lines = path.join(root, '线 目录');
    const control = path.join(root, '控制根');
    const name = opt.name || 'Line-A';
    fs.mkdirSync(main, { recursive: true });
    git(main, ['init', '-q', '-b', 'main']);
    git(main, ['config', 'core.hooksPath', path.join(main, '.git', 'hooks').replace(/\\/g, '/')]);   // 首次提交前固定到夹具自己的 hooks 目录（35b-M1）
    git(main, ['config', 'user.name', 't']);
    git(main, ['config', 'user.email', 't@t']);
    git(main, ['config', 'commit.gpgsign', 'false']);
    git(main, ['config', 'core.autocrlf', 'false']);
    w(path.join(main, 'a.txt'), nLines('a', 20));
    w(path.join(main, 'b.txt'), nLines('b', 5));
    w(path.join(main, 'del.txt'), 'will be deleted by main\n');
    w(path.join(main, 'del-line.txt'), 'will be deleted by line\n');
    w(path.join(main, '文档 目录', '说明 1.txt'), '说明 v0\n');
    w(path.join(main, 'README.md'), 'readme\n');
    if (opt.ignore) w(path.join(main, '.gitignore'), opt.ignore);
    for (const [rel, text] of Object.entries(opt.files || {})) w(path.join(main, rel), text);
    git(main, ['add', '-A']);
    git(main, ['commit', '-q', '-m', 'init']);
    const fx = { root, main, lines, control, name, wt: path.join(lines, name), B0: oidOf(main, 'HEAD') };
    fs.mkdirSync(lines, { recursive: true });
    await S.createLine(control, name, { module: 'mod-x', branch: opt.branch || `line/${name}`, worktree: opt.worktreeReg || fx.wt, surface: 'x' });
    const lc = opt.lifecycle || 'ready';
    if (lc === 'ready' || lc === 'removing') await S.updateLine(control, name, (r) => { r.lifecycle = 'ready'; });
    if (lc === 'removing') await S.updateLine(control, name, (r) => { r.lifecycle = 'removing'; });
    if (lc === 'failed') await S.updateLine(control, name, (r) => { r.lifecycle = 'failed'; r.failed_step = 'test'; });
    git(main, ['worktree', 'add', '-q', '-b', `line/${name}`, fx.wt, fx.B0]);
    return fx;
}

/** 在 dir 里提交：files = { 相对路径: 内容 | null（删除） }。返回新 HEAD。 */
function commitIn(dir, files, msg) {
    for (const [rel, text] of Object.entries(files)) {
        const p = path.join(dir, rel);
        if (text === null) fs.unlinkSync(p); else w(p, text);
    }
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', msg || 'c']);
    return oidOf(dir, 'HEAD');
}
/** 同 commitIn，但用 `add -f` 把被忽略的路径也提交（files 不含删除）。返回新 HEAD。 */
function commitForce(dir, files, msg) {
    for (const [rel, text] of Object.entries(files)) w(path.join(dir, rel), text);
    git(dir, ['add', '-f', '--', ...Object.keys(files)]);
    git(dir, ['commit', '-q', '-m', msg || 'c-force']);
    return oidOf(dir, 'HEAD');
}
const lineCommit = (fx, files, msg) => commitIn(fx.wt, files, msg);
const mainCommit = (fx, files, msg) => commitIn(fx.main, files, msg);

function assertTemp(...ps) {
    for (const p of ps) if (!C.isInside(os.tmpdir(), p)) throw new Error('拒绝：路径不在系统临时目录内（绝不对真实仓库运行 line merge）');
}
/** 以子进程运行 line.js <args> 并追加三个根覆盖参数。 */
function cli(fx, args) {
    assertTemp(fx.main, fx.lines, fx.control);
    const r = spawnSync(process.execPath, [LINE_JS, ...args, '--control-root', fx.control, '--lines-root', fx.lines, '--main-root', fx.main], { cwd: fx.root, env: cleanEnv(), encoding: 'utf8', timeout: 180000, windowsHide: true });
    return { status: r.error ? null : r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error ? r.error.message : null };
}
const merge = (fx, base, head, extra) => cli(fx, ['merge', fx.name.toLowerCase(), '--base', base, '--head', head, ...(extra || [])]);
const codeOf = (r) => { const m = /错误\[([A-Z0-9_]+)\]/.exec(r.stderr); return m ? m[1] : null; };

/**
 * 仓库快照：main / HEAD / 符号引用 / 全部 refs / status（含未跟踪、含被忽略）/ fx.watch 里列出的文件内容（被忽略文件的「内容没变」）/ 进行中的操作标记 / index.lock 与 MERGE_MSG 是否存在 / ORIG_HEAD。
 * 返回 { core: 字符串（除 ORIG_HEAD 外的全部）, origHead: 字符串, mainOid }。
 */
function snap(fx) {
    const gd = (n) => path.join(fx.main, '.git', n);
    const core = JSON.stringify({
        main: gq(fx.main, ['rev-parse', '--verify', '--quiet', 'refs/heads/main']),
        head: gq(fx.main, ['rev-parse', '--verify', '--quiet', 'HEAD']),
        sym: gq(fx.main, ['symbolic-ref', '-q', 'HEAD']),
        refs: gq(fx.main, ['for-each-ref', '--format=%(refname) %(objectname)']),
        // noStatus：夹具里有联接进来的大目录（见 42.10），逐个列出未跟踪 / 被忽略项会超出 spawnSync 的 maxBuffer；此时只比已跟踪状态（codex 36 L2：不整项跳过）
        status: fx.noStatus ? `TRACKED-ONLY:${gq(fx.main, ['status', '--porcelain=v1', '-z', '--untracked-files=no'])}` : gq(fx.main, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored']),
        watch: (fx.watch || []).map((rel) => { try { return fs.readFileSync(path.join(fx.main, rel), 'utf8'); } catch (_) { return null; } }),
        marks: TEST_MARKS.map((n) => fs.existsSync(gd(n))),
        indexLock: fs.existsSync(gd('index.lock')),
        mergeMsg: fs.existsSync(gd('MERGE_MSG')),
    });
    return { core, origHead: gq(fx.main, ['rev-parse', '--verify', '--quiet', 'ORIG_HEAD']), mainOid: oidOf(fx.main, 'refs/heads/main') };
}
/**
 * 快照比较。origMode：'strict'（ORIG_HEAD 也必须不变，默认）/ 'B'（git merge 已经开始过：ORIG_HEAD 允许变成合并前的 main）。
 */
function sameSnap(before, after, origMode) {
    if (before.core !== after.core) return false;
    const mode = origMode || 'strict';
    if (after.origHead === before.origHead) return true;
    return mode === 'B' && after.origHead === `0|${before.mainOid}\n|`;
}
const cleanTracked = (fx) => gq(fx.main, ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--no-renames']) === '0||';
/** 拒绝类断言：退出码、错误码、仓库什么都没变。 */
function rejected(label, fx, before, r, code, exit, origMode) {
    const ex = exit === undefined ? 1 : exit;
    check(`${label}：退出码 ${ex}`, r.status === ex, { status: r.status, err: r.stderr.slice(0, 300), e: r.error });
    if (code !== null) check(`${label}：错误码 ${code}`, codeOf(r) === code, { code: codeOf(r), err: r.stderr.slice(0, 300) });
    const after = snap(fx);
    check(`${label}：仓库什么都没变`, sameSnap(before, after, origMode), { before: before.core === after.core ? 'core 相同' : 'core 不同', origBefore: before.origHead, origAfter: after.origHead });
}
/** 失败后状态保留类断言（STATE_UNKNOWN 等）：退出码 1 + 错误码；仓库状态由调用方另外断言。 */
function failedWith(label, r, code) {
    check(`${label}：退出码 1`, r.status === 1, { status: r.status, err: r.stderr.slice(0, 300), e: r.error });
    check(`${label}：错误码 ${code}`, codeOf(r) === code, { code: codeOf(r), err: r.stderr.slice(0, 400) });
}
const isAncestor = (cwd, a, b) => gq(cwd, ['merge-base', '--is-ancestor', a, b]).startsWith('0|');
const emptyCommitIn = (dir, msg) => { git(dir, ['commit', '-q', '--allow-empty', '-m', msg || 'e']); return oidOf(dir, 'HEAD'); };

// ---- 并发写入模拟：core.fsmonitor 钩子（git status 时执行）。标记文件 .git/fsm-inject 存在时执行其中的 shell 一次并删除。
function setupInject(fx) {
    const hook = path.join(fx.main, '.git', 'fsm-hook.sh');
    w(hook, ['#!/bin/sh', 'if [ -f .git/fsm-inject ]; then', '  mv .git/fsm-inject .git/fsm-running', '  sh .git/fsm-running >> .git/fsm.log 2>&1', '  rm -f .git/fsm-running', 'fi', '# fsmonitor v2：回复「令牌 + /」表示所有文件都可能变过，让 git 做完整扫描（只回令牌会让 git 相信没有任何文件变过，漏掉工作区改动）', 'printf \'%s\\0/\\0\' "$2"', ''].join('\n'));
    git(fx.main, ['config', 'core.fsmonitor', `"${hook.replace(/\\/g, '/')}"`]);
}
const injectFile = (fx) => path.join(fx.main, '.git', 'fsm-inject');
const fire = (fx, lines) => w(injectFile(fx), `${lines.join('\n')}\n`);
const injectConsumed = (fx) => !fs.existsSync(injectFile(fx)) && !fs.existsSync(path.join(fx.main, '.git', 'fsm-running'));
/** 在 main 上追加一个与父提交树相同的空提交并把 main 挪过去的 shell（old 是预期的 main 当前值）。 */
const shMoveMainTo = (parent, old, msg) => [`X=$(git commit-tree ${parent}^{tree} -p ${parent} -m ${msg})`, `git update-ref refs/heads/main $X ${old}`];

// ---------------------------------------------------------------- 各节

async function sec1() {
    section('1', '快进正常（登记线名 Line-A，命令行传小写）');
    const fx = await build('s1');
    const H = lineCommit(fx, { 'b.txt': nLines('b', 6), 'line-new.txt': 'new\n' }, 'line work');
    const r = merge(fx, fx.B0, H);
    check('1.0 退出码 0', r.status === 0, { status: r.status, out: r.stdout.slice(0, 300), err: r.stderr.slice(0, 300) });
    check('1.1 refs/heads/main = H，HEAD = H', oidOf(fx.main, 'refs/heads/main') === H && oidOf(fx.main, 'HEAD') === H);
    check('1.2 主工作区干净（已跟踪）且文件内容就位', cleanTracked(fx) && rd(path.join(fx.main, 'line-new.txt')) === 'new\n');
    check('1.3 输出五项：模式 / 线名（登记写法）/ B / H / 合入后 main',
        r.stdout.includes('模式：快进') && r.stdout.includes('线名：Line-A') && r.stdout.includes(`B：${fx.B0}`) && r.stdout.includes(`H：${H}`) && r.stdout.includes(`合入后 main：${H}`), r.stdout);
    check('1.4 线分支没动', oidOf(fx.main, 'refs/heads/line/Line-A') === H);
}

async function sec2() {
    section('2', 'main 已前进（main ≠ B）');
    const fx = await build('s2');
    const H = lineCommit(fx, { 'line-new.txt': 'new\n' });
    mainCommit(fx, { 'README.md': 'readme v2\n' });
    const before = snap(fx);
    const r = merge(fx, fx.B0, H);
    rejected('2.1 base 是旧提交', fx, before, r, 'LINE_MERGE_MAIN_STATE');
    check('2.2 提示 main 与 --base 不一致', /main 当前提交/.test(r.stderr), r.stderr.slice(0, 300));
}

async function sec3() {
    section('3', '线分支 / 线 worktree HEAD 不符');
    const fx = await build('s3a');
    const H = lineCommit(fx, { 'line-new.txt': 'new\n' });
    lineCommit(fx, { 'line-new2.txt': 'new2\n' }, 'newer');
    let before = snap(fx);
    rejected('3.1 线分支已前进（分支 ≠ H）', fx, before, merge(fx, fx.B0, H), 'LINE_MERGE_HEAD_MISMATCH');

    const fx2 = await build('s3b');
    const H2 = lineCommit(fx2, { 'line-new.txt': 'new\n' });
    git(fx2.wt, ['checkout', '-q', '--detach', fx2.B0]);   // 分支仍在 H2，worktree 分离到别处
    before = snap(fx2);
    const r2 = merge(fx2, fx2.B0, H2);
    rejected('3.2 分支对、worktree 分离到别处', fx2, before, r2, 'LINE_MERGE_HEAD_MISMATCH');
    check('3.2b 提示是 worktree 的 HEAD', /worktree 的 HEAD/.test(r2.stderr), r2.stderr.slice(0, 300));

    const fx4 = await build('s3d');
    const H4 = lineCommit(fx4, { 'line-new.txt': 'new\n' });
    lineCommit(fx4, { 'line-new2.txt': 'new2\n' }, 'newer');   // 分支前进到 H4 之后
    git(fx4.wt, ['checkout', '-q', '--detach', H4]);           // worktree 的 HEAD 回到 H4：只有分支核对能拦住
    before = snap(fx4);
    rejected('3.4 worktree HEAD = H 但线分支已前进', fx4, before, merge(fx4, fx4.B0, H4), 'LINE_MERGE_HEAD_MISMATCH');

    const fx3 = await build('s3c');
    const H3 = lineCommit(fx3, { 'line-new.txt': 'new\n' });
    fs.renameSync(fx3.wt, `${fx3.wt}-moved`);   // 登记的 worktree 目录不在了：只看分支
    const r3 = merge(fx3, fx3.B0, H3);
    check('3.3 worktree 目录不存在时只核对分支，快进成功', r3.status === 0 && oidOf(fx3.main, 'refs/heads/main') === H3, { status: r3.status, err: r3.stderr.slice(0, 300) });
}

async function sec4() {
    section('4', '主工作区已跟踪文件有改动 / 暂存');
    const fx = await build('s4a');
    const H = lineCommit(fx, { 'line-new.txt': 'new\n' });
    w(path.join(fx.main, 'README.md'), 'dirty\n');
    let before = snap(fx);
    let r = merge(fx, fx.B0, H);
    rejected('4.1 未暂存改动', fx, before, r, 'LINE_MERGE_DIRTY');
    check('4.1b 改动内容原样', rd(path.join(fx.main, 'README.md')) === 'dirty\n');

    const fx2 = await build('s4b');
    const H2 = lineCommit(fx2, { 'line-new.txt': 'new\n' });
    w(path.join(fx2.main, 'README.md'), 'staged\n');
    git(fx2.main, ['add', 'README.md']);
    before = snap(fx2);
    r = merge(fx2, fx2.B0, H2);
    rejected('4.2 已暂存改动', fx2, before, r, 'LINE_MERGE_DIRTY');

    // 4.3 子模块被改脏，而仓库配置 diff.ignoreSubmodules=all / submodule.sm.ignore=all 想把它藏起来：干净判定用命令行 --ignore-submodules=none，不受配置影响（实测见文件头）
    const fx3 = await build('s4c');
    const subSrc = path.join(fx3.root, '子模块 源');
    fs.mkdirSync(subSrc, { recursive: true });
    git(subSrc, ['init', '-q', '-b', 'main']);
    w(path.join(subSrc, 's.txt'), 's\n');
    git(subSrc, ['add', '-A']);
    git(subSrc, ['commit', '-q', '-m', 's']);
    git(fx3.main, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subSrc.replace(/\\/g, '/'), 'sm']);
    git(fx3.main, ['commit', '-q', '-m', 'add submodule']);
    const B3 = oidOf(fx3.main, 'HEAD');
    const H3 = lineCommit(fx3, { 'line-new.txt': 'new\n' });
    git(fx3.main, ['config', 'diff.ignoreSubmodules', 'all']);
    git(fx3.main, ['config', 'submodule.sm.ignore', 'all']);
    w(path.join(fx3.main, 'sm', 's.txt'), 'dirty\n');
    check('4.3a 夹具前提：带配置的普通 status 看不到子模块改动，--ignore-submodules=none 看得到',
        gq(fx3.main, ['status', '--porcelain=v1', '-z', '--untracked-files=no']) === '0||' && gq(fx3.main, ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--ignore-submodules=none']).includes('sm'));
    before = snap(fx3);
    rejected('4.3 子模块改脏（配置想藏起来）', fx3, before, merge(fx3, B3, H3, ['--merge-commit']), 'LINE_MERGE_DIRTY');
}

async function sec5() {
    section('5', '主工作区只有无关未跟踪文件');
    const fx = await build('s5');
    const H = lineCommit(fx, { 'line-new.txt': 'new\n' });
    w(path.join(fx.main, '_temp', '遗留 文件.txt'), 'legacy\n');
    w(path.join(fx.main, 'junk.txt'), 'junk\n');
    const r = merge(fx, fx.B0, H);
    check('5.1 快进成功', r.status === 0 && oidOf(fx.main, 'refs/heads/main') === H, { status: r.status, err: r.stderr.slice(0, 300) });
    check('5.2 未跟踪文件原样还在', rd(path.join(fx.main, '_temp', '遗留 文件.txt')) === 'legacy\n' && rd(path.join(fx.main, 'junk.txt')) === 'junk\n');
}

async function sec6() {
    section('6', '未跟踪（未被忽略）文件与 H 新增文件同名：前置核对拒绝（git 都还没运行）');
    const fx = await build('s6');
    const H = lineCommit(fx, { 'new-file.txt': 'from line\n' });
    w(path.join(fx.main, 'new-file.txt'), 'local untracked\n');
    const before = snap(fx);
    const r = merge(fx, fx.B0, H);
    rejected('6.1 快进被前置核对拒绝', fx, before, r, 'LINE_MERGE_UNTRACKED_COLLISION');
    check('6.2 未跟踪文件内容不变', rd(path.join(fx.main, 'new-file.txt')) === 'local untracked\n');
    check('6.3 文案列出路径、不回显内容', r.stderr.includes('new-file.txt') && !r.stderr.includes('local untracked'), r.stderr.slice(0, 300));
}

async function sec7() {
    section('7', '主工作区不在 main');
    const fx = await build('s7a');
    const H = lineCommit(fx, { 'line-new.txt': 'new\n' });
    git(fx.main, ['checkout', '-q', '--detach']);
    let before = snap(fx);
    rejected('7.1 分离头指针', fx, before, merge(fx, fx.B0, H), 'LINE_MERGE_MAIN_STATE');
    const fx2 = await build('s7b');
    const H2 = lineCommit(fx2, { 'line-new.txt': 'new\n' });
    git(fx2.main, ['checkout', '-q', '-b', 'other']);
    before = snap(fx2);
    rejected('7.2 在别的分支（main 指针仍 = B）', fx2, before, merge(fx2, fx2.B0, H2), 'LINE_MERGE_MAIN_STATE');
}

async function sec8() {
    section('8', 'integration_branch 不是 main');
    const fx = await build('s8');
    const H = lineCommit(fx, { 'line-new.txt': 'new\n' });
    await S.updateConfig(fx.control, (c) => { c.integration_branch = 'develop'; });
    const before = snap(fx);
    rejected('8.1 integration_branch = develop', fx, before, merge(fx, fx.B0, H), 'LINE_MERGE_NOT_MAIN');
    await S.updateConfig(fx.control, (c) => { c.integration_branch = 'main'; });
    const r = merge(fx, fx.B0, H);
    check('8.2 integration_branch = main（字面）照常成功', r.status === 0 && oidOf(fx.main, 'refs/heads/main') === H, { status: r.status, err: r.stderr.slice(0, 300) });
}

async function sec9() {
    section('9', 'B / H 不合法（一律退出码 1 + LINE_MERGE_BAD_REV，仓库不变）');
    const fx = await build('s9');
    const H = lineCommit(fx, { 'line-new.txt': 'new\n' });
    const tree = oidOf(fx.main, `${fx.B0}^{tree}`);
    const cases = [
        ['分支名当 base', 'main', H], ['分支名当 head', fx.B0, 'line/Line-A'], ['7 位缩写 base', fx.B0.slice(0, 7), H], ['7 位缩写 head', fx.B0, H.slice(0, 7)],
        ['大写十六进制 head', fx.B0, H.toUpperCase()], ['不存在的 40 位 head', fx.B0, 'f'.repeat(40)], ['不存在的 40 位 base', 'e'.repeat(40), H],
        ['指向 tree 的 base', tree, H], ['指向 tree 的 head', fx.B0, tree], ['B = H', H, H], ['HEAD 字面量', 'HEAD', H],
    ];
    const before = snap(fx);
    for (const [label, b, h] of cases) rejected(`9 ${label}`, fx, before, merge(fx, b, h), 'LINE_MERGE_BAD_REV');
    const r = merge(fx, fx.B0, H);
    check('9.9 全部拒绝之后合法输入照常成功', r.status === 0, { status: r.status, err: r.stderr.slice(0, 300) });
}

async function sec10() {
    section('10', '快进模式下 B 不是 H 的祖先');
    const fx = await build('s10');
    const H = lineCommit(fx, { 'line-new.txt': 'new\n' });
    const B2 = mainCommit(fx, { 'README.md': 'readme v2\n' });
    const before = snap(fx);
    const r = merge(fx, B2, H);
    rejected('10.1 线没跟上 main', fx, before, r, 'LINE_MERGE_NOT_FF');
    check('10.2 提示先 rebase', r.stderr.includes('rebase'), r.stderr.slice(0, 300));
}

async function sec11() {
    section('11', '主工作区有进行中的操作');
    check('11.0 本文件独立写出的标记名恰为七种', TEST_MARKS.length === 7 && new Set(TEST_MARKS).size === 7);
    for (const mark of TEST_MARKS) {
        const fx = await build(`s11-${mark}`);
        const H = lineCommit(fx, { 'line-new.txt': 'new\n' });
        const p = path.join(fx.main, '.git', mark);
        if (mark === 'rebase-merge' || mark === 'rebase-apply' || mark === 'sequencer') fs.mkdirSync(p); else w(p, `${fx.B0}\n`);
        const before = snap(fx);
        const r = merge(fx, fx.B0, H);
        rejected(`11 ${mark}`, fx, before, r, 'LINE_MERGE_IN_PROGRESS');
        check(`11 ${mark}：提示里点名`, r.stderr.includes(mark), r.stderr.slice(0, 300));
    }
}

async function sec12() {
    section('12', '线名不存在');
    const fx = await build('s12');
    const H = lineCommit(fx, { 'line-new.txt': 'new\n' });
    const before = snap(fx);
    rejected('12.1 没有这条线', fx, before, cli(fx, ['merge', 'no-such', '--base', fx.B0, '--head', H]), 'LINE_MERGE_NO_SUCH_LINE');
}

async function sec13() {
    section('13', '用法错误（退出码 2）');
    const fx = await build('s13');
    const H = lineCommit(fx, { 'line-new.txt': 'new\n' });
    const before = snap(fx);
    const B = fx.B0;
    const cases = [
        ['缺 --base', ['merge', 'line-a', '--head', H]], ['缺 --head', ['merge', 'line-a', '--base', B]], ['缺线名', ['merge', '--base', B, '--head', H]],
        ['多一个位置参数', ['merge', 'line-a', 'line-b', '--base', B, '--head', H]], ['--base 缺取值', ['merge', 'line-a', '--head', H, '--base']],
        ['merge 带 --json', ['merge', 'line-a', '--base', B, '--head', H, '--json']], ['merge 带 --discard', ['merge', 'line-a', '--base', B, '--head', H, '--discard']],
        ['merge-commit 不接受取值', ['merge', 'line-a', '--base', B, '--head', H, '--merge-commit=1']],
        ['new 带 --merge-commit', ['new', 'x', '--module', 'm', '--surface', 's', '--merge-commit']], ['remove 带 --merge-commit', ['remove', 'line-a', '--merge-commit']],
        ['remove 带 --base', ['remove', 'line-a', '--base', B]], ['start 带 --head', ['start', 'line-a', '--head', H]], ['list 带 --base', ['list', '--base', B]],
        ['new 带 --base', ['new', 'x', '--module', 'm', '--surface', 's', '--base', B]], ['stop 带 --merge-commit', ['stop', 'line-a', '--merge-commit']],
    ];
    for (const [label, args] of cases) {
        const r = cli(fx, args);
        check(`13 ${label}：退出码 2`, r.status === 2, { status: r.status, err: r.stderr.slice(0, 200) });
        check(`13 ${label}：是用法错误`, r.stderr.startsWith('用法错误：'), r.stderr.slice(0, 200));
    }
    check('13.9 全部用法错误之后仓库什么都没变', sameSnap(before, snap(fx), 'strict'));
    const L = lib('line.js');
    const P = L.parseArgv;
    const ok = P(['merge', 'x', '--base', 'a', '--head', 'b', '--merge-commit']);
    check('13.10 parseArgv：merge 三项解析', ok.ok && ok.opts.base === 'a' && ok.opts.head === 'b' && ok.opts.mergeCommit === true && P(['merge', 'x', '--base', 'a', '--head', 'b']).opts.mergeCommit === undefined);
    check('13.11 USAGE 里有 merge 一行，写明在场 / 提交号 / 未跟踪不计入', L.USAGE.includes('line.js merge') && L.USAGE.includes('用户在场') && L.USAGE.includes('完整 40 位小写十六进制提交号') && L.USAGE.includes('未跟踪文件不计入'));
    check('13.12 未知子命令文案列出 merge', (P(['frob', 'x']).error || '').includes('merge'));
}

async function sec14() {
    section('14', '--merge-commit 正常');
    const fx = await build('s14a');
    const zh = path.join('文档 目录', '说明 1.txt');
    const H = lineCommit(fx, { 'b.txt': nLines('b', 6), 'line-new.txt': 'new\n', 'del-line.txt': null, [zh]: '说明 v1 by line\n' }, 'line work');
    const B = mainCommit(fx, { 'a.txt': nLines('x', 20), 'del.txt': null, 'main-new.txt': 'main new\n' }, 'main docs');
    const r = merge(fx, B, H, ['--merge-commit']);
    check('14.0 退出码 0', r.status === 0, { status: r.status, out: r.stdout.slice(0, 300), err: r.stderr.slice(0, 300) });
    const Mc = oidOf(fx.main, 'refs/heads/main');
    check('14.1 main = HEAD = 新提交，且不是 B / H', Mc === oidOf(fx.main, 'HEAD') && Mc !== B && Mc !== H);
    check('14.2 父提交恰为 [B, H]（顺序也对）', git(fx.main, ['rev-list', '--parents', '-n', '1', Mc]).trim() === `${Mc} ${B} ${H}`);
    check('14.3 主侧改动文件：M:a.txt = B:a.txt', oidOf(fx.main, `${Mc}:a.txt`) === oidOf(fx.main, `${B}:a.txt`));
    check('14.4 线侧改动文件：M:b.txt = H:b.txt，M:新增 = H:新增，M:中文空格路径 = H:同路径',
        oidOf(fx.main, `${Mc}:b.txt`) === oidOf(fx.main, `${H}:b.txt`) && oidOf(fx.main, `${Mc}:line-new.txt`) === oidOf(fx.main, `${H}:line-new.txt`)
        && oidOf(fx.main, `${Mc}:文档 目录/说明 1.txt`) === oidOf(fx.main, `${H}:文档 目录/说明 1.txt`));
    const has = (rev, f) => gq(fx.main, ['cat-file', '-e', `${rev}:${f}`]).startsWith('0|');
    check('14.5 主侧删除的文件（del.txt）在 M 里不存在；线侧删除的文件（del-line.txt）在 M 里不存在；主侧新增在',
        !has(Mc, 'del.txt') && !has(Mc, 'del-line.txt') && has(Mc, 'main-new.txt') && has(Mc, 'line-new.txt'));
    const msg = git(fx.main, ['log', '-1', '--format=%B', Mc]).replace(/\r/g, '').replace(/\n+$/, '');
    check('14.6 提交说明格式：第一行 + 空行 + base: / head:', msg === `Merge line Line-A into main (merge-commit mode)\n\nbase: ${B}\nhead: ${H}`, msg);
    check('14.7 工作区干净且文件就位', cleanTracked(fx) && rd(path.join(fx.main, 'main-new.txt')) === 'main new\n' && !fs.existsSync(path.join(fx.main, 'del.txt')) && !fs.existsSync(path.join(fx.main, 'del-line.txt')));
    check('14.8 输出五项（模式 merge-commit）', r.stdout.includes('模式：merge-commit') && r.stdout.includes('线名：Line-A') && r.stdout.includes(`合入后 main：${Mc}`), r.stdout);

    const fx2 = await build('s14b');
    const H2 = lineCommit(fx2, { 'line-new.txt': 'new\n' });
    const r2 = merge(fx2, fx2.B0, H2, ['--merge-commit']);
    const M2 = oidOf(fx2.main, 'refs/heads/main');
    check('14.9 B 是 H 的祖先（主侧无改动）时 --merge-commit 也产生合并提交，父提交 [B, H]，树 = H 的树',
        r2.status === 0 && git(fx2.main, ['rev-list', '--parents', '-n', '1', M2]).trim() === `${M2} ${fx2.B0} ${H2}` && oidOf(fx2.main, `${M2}^{tree}`) === oidOf(fx2.main, `${H2}^{tree}`), { status: r2.status, err: r2.stderr.slice(0, 300) });
}

async function sec15() {
    section('15', '--merge-commit 路径交集');
    const fx = await build('s15');
    const H = lineCommit(fx, { 'a.txt': nLines('a', 19) + 'a20-by-line\n', 'line-new.txt': 'new\n' });   // 改第 20 行
    const B = mainCommit(fx, { 'a.txt': `a1-by-main\n${nLines('a', 20).split('\n').slice(1).join('\n')}` });   // 改第 1 行：git 能自动合并
    const before = snap(fx);
    const r = merge(fx, B, H, ['--merge-commit']);
    rejected('15.1 两边都改 a.txt（即使能自动合并）', fx, before, r, 'LINE_MERGE_OVERLAP');
    check('15.2 提示列出交集路径与 rebase 建议', r.stderr.includes('a.txt') && r.stderr.includes('rebase'), r.stderr.slice(0, 300));
}

async function sec16() {
    section('16', '--merge-commit 时 H 已是 B 的祖先');
    const fx = await build('s16');
    const H = lineCommit(fx, { 'line-new.txt': 'new\n' });
    git(fx.main, ['merge', '-q', '--ff-only', H]);   // 夹具：main 吃进 H 再前进
    const B = mainCommit(fx, { 'README.md': 'readme v2\n' });
    const before = snap(fx);
    rejected('16.1 无可合入', fx, before, merge(fx, B, H, ['--merge-commit']), 'LINE_MERGE_NOTHING_TO_MERGE');
}

function installHook(fx, hookName, body) {
    const f = path.join(fx.main, '.git', 'hooks', hookName);
    w(f, `#!/bin/sh\n${body}\n`);
}
/**
 * git merge 失败并留下合并中状态时的断言（不 abort）：错误码 GIT_FAILED_IN_PROGRESS；MERGE_HEAD 仍在；main = HEAD = want；
 * main 的 reflog 比 git merge 之前多 extra 条（手写：钩子自己的写入），且没有 reset 条目；文案含 B、当前 main、git 退出码、人工指引（git rev-parse main、git merge --abort、reflog）。
 */
function inProgressKept(label, fx, r, B, logBefore, extra, want) {
    failedWith(label, r, 'LINE_MERGE_GIT_FAILED_IN_PROGRESS');
    check(`${label}：MERGE_HEAD 仍在（没有 abort）`, fs.existsSync(path.join(fx.main, '.git', 'MERGE_HEAD')));
    check(`${label}：main = HEAD = ${want === B ? 'B' : '并发写入后的值'}`, oidOf(fx.main, 'refs/heads/main') === want && oidOf(fx.main, 'HEAD') === want, { want });
    const log = reflogMain(fx);
    check(`${label}：main 的 reflog 比 git merge 之前多 ${extra} 条，没有 reset 条目`, log.length === logBefore.length + extra && !log.some((s) => /^reset/.test(s)), log);
    const e = r.stderr;
    check(`${label}：文案写明没有 abort、含 git 退出码、B 与当前 main`, e.includes('留下了合并中状态') && e.includes('没有执行 merge --abort') && e.includes('git 退出码') && e.includes(`B = ${B}`) && e.includes(`当前 refs/heads/main = ${want}`), e.slice(0, 700));
    check(`${label}：文案含人工指引（git rev-parse main、git merge --abort、reflog）`, e.includes('git rev-parse main') && e.includes('git merge --abort') && e.includes('reflog'), e.slice(0, 900));
}
async function sec17() {
    section('17', '钩子拒绝（pre-merge-commit 退出 1）：git 留下合并中状态 → 不 abort，GIT_FAILED_IN_PROGRESS，仓库原样保留');
    const fx = await build('s17');
    const H = lineCommit(fx, { 'b.txt': nLines('b', 6), 'line-new.txt': 'new\n' });
    const B = mainCommit(fx, { 'README.md': 'readme v2\n' });
    w(path.join(fx.main, 'junk.txt'), 'junk\n');
    installHook(fx, 'pre-merge-commit', 'exit 1');
    const logBefore = reflogMain(fx);
    const r = merge(fx, B, H, ['--merge-commit']);
    inProgressKept('17.1 钩子拒绝', fx, r, B, logBefore, 0, B);
    check('17.2 工作区原样：合并写出的 line-new.txt 与暂存都还在（没有 abort 清理），未跟踪文件不动', fs.existsSync(path.join(fx.main, 'line-new.txt')) && rd(path.join(fx.main, 'junk.txt')) === 'junk\n'
        && fs.existsSync(path.join(fx.main, '.git', 'MERGE_MSG')));

    // 17.3 钩子先把 main 挪到别的提交（模拟并发提交）再退出 1：不 abort；main 停在并发写入后的值，文案里的「当前 main」是它
    const fx2 = await build('s17b');
    const H2 = lineCommit(fx2, { 'b.txt': nLines('b', 6), 'line-new.txt': 'new\n' });
    const B2 = mainCommit(fx2, { 'README.md': 'readme v2\n' });
    installHook(fx2, 'pre-merge-commit', [...shMoveMainTo(B2, B2, 'concurrent-in-hook'), 'exit 1'].join('\n'));
    const logBefore2 = reflogMain(fx2);
    const r2 = merge(fx2, B2, H2, ['--merge-commit']);
    const mainNow = oidOf(fx2.main, 'refs/heads/main');
    inProgressKept('17.3 钩子先移动 main 再退出 1', fx2, r2, B2, logBefore2, 1, mainNow);   // 钩子里的无 -m 的 update-ref 多写一条（说明为空）
    check('17.4 并发写入的提交没有被撤离：main 不是 B，父提交是 B，说明是 concurrent-in-hook',
        mainNow !== B2 && oidOf(fx2.main, `${mainNow}^`) === B2 && git(fx2.main, ['log', '-1', '--format=%s', mainNow]).trim() === 'concurrent-in-hook', { mainNow });
    check('17.5 文案里的当前 main 不是 B（读到的是并发写入后的值）', !r2.stderr.includes(`当前 refs/heads/main = ${B2}`), r2.stderr.slice(0, 500));
}

function sec18() {
    section('18', '纯函数：树核对 / 父提交核对');
    const T = M.verifyMergeTree;
    const P = M.verifyMergeParents;
    const o = (s) => `${s}`.padEnd(40, '0');
    const base = () => ({
        pb: ['X', 'D'], ph: ['Y', 'N'], diffHM: ['X', 'D'], diffBM: ['Y', 'N'],
        blobM: new Map([['X', o('bx')], ['D', null], ['Y', o('hy')], ['N', o('hn')]]),
        blobB: new Map([['X', o('bx')], ['D', null]]),
        blobH: new Map([['Y', o('hy')], ['N', o('hn')]]),
    });
    const res = (f) => { try { return T(f); } catch (e) { return { ok: 'THROW', reasons: [String(e && e.message)] }; } };
    const good = res(base());
    check('18.1 正确输入（含删除、新增）判通过', good.ok === true && good.reasons.length === 0, good);
    const bad = (label, mut) => { const f = base(); mut(f); const r = res(f); check(`18 树核对：${label} 判失败`, r.ok === false && Array.isArray(r.reasons) && r.reasons.length > 0, r); };
    bad('M 多改了一个两边都没改的文件 Z（diff(H,M) 与 diff(B,M) 都多出 Z）', (f) => { f.diffHM.push('Z'); f.diffBM.push('Z'); });
    bad('diff(H,M) 多出主侧改动之外的路径', (f) => { f.diffHM.push('Z'); });
    bad('diff(B,M) 多出线侧改动之外的路径', (f) => { f.diffBM.push('Z'); });
    bad('M:X ≠ B:X', (f) => { f.blobM.set('X', o('other')); });
    bad('M:Y ≠ H:Y', (f) => { f.blobM.set('Y', o('other')); });
    bad('主侧删除的文件在 M 里又出现了（M:D 非空）', (f) => { f.blobM.set('D', o('back')); });
    bad('线侧新增的文件在 M 里不存在', (f) => { f.blobM.set('N', null); });
    bad('blob 映射缺项', (f) => { f.blobM.delete('X'); });
    bad('主侧与线侧改动集有交集', (f) => { f.ph.push('X'); f.diffBM.push('X'); f.blobH.set('X', o('bx')); });
    bad('输入不是数组', (f) => { f.pb = 'X'; });
    bad('blob 映射不是 Map', (f) => { f.blobM = {}; });
    check('18.2 空改动集（B 是 H 的祖先）且 M = H 判通过', res({ pb: [], ph: ['Y'], diffHM: [], diffBM: ['Y'], blobM: new Map([['Y', o('hy')]]), blobB: new Map(), blobH: new Map([['Y', o('hy')]]) }).ok === true);
    const B = o('b1');
    const H = o('h1');
    check('18.3 父提交 [B, H] 判通过', P([B, H], B, H).ok === true);
    check('18.4 父提交顺序反了判失败', P([H, B], B, H).ok === false && P([H, B], B, H).reasons.length > 0);
    check('18.5 多一个父提交判失败', P([B, H, o('x')], B, H).ok === false);
    check('18.6 只有一个父提交判失败', P([B], B, H).ok === false && P([], B, H).ok === false);
    check('18.7 父提交里有别的提交判失败 / 非数组判失败', P([B, o('x')], B, H).ok === false && P([o('x'), H], B, H).ok === false && P(null, B, H).ok === false);
}

/** main 的 reflog 条目说明（新到旧）。 */
const reflogMain = (fx) => git(fx.main, ['reflog', 'show', '--format=%H %gs', 'refs/heads/main']).split('\n').map((s) => s.replace(/\r/g, ''))
    .filter((s) => /^[0-9a-f]{40}( |$)/.test(s)).map((s) => s.slice(41));   // 每条 = 40 位提交号 + 空格 + 说明；说明为空的条目（不带 -m 的 update-ref 也写 reflog）也计入，返回说明数组（可能为空串）
/**
 * 「事后核对失败没有任何 git 写操作」的断言：main / HEAD 停在 want；ORIG_HEAD 仍是合并起点 B（reset 会把它改成被替换的 HEAD）；
 * main 的 reflog 恰有 n 条（手写期望，含夹具自己的提交）、没有 reset 条目、最新一条匹配 newest。
 */
function noWrite(label, fx, want, B, n, newest) {
    const log = reflogMain(fx);
    check(`${label}：main = HEAD = 停在 git merge 之后的值`, oidOf(fx.main, 'refs/heads/main') === want && oidOf(fx.main, 'HEAD') === want, { want });
    check(`${label}：ORIG_HEAD 仍是合并起点 B（没有 reset）`, oidOf(fx.main, 'ORIG_HEAD') === B);
    check(`${label}：main 的 reflog 恰有 ${n} 条，最新一条符合预期，没有 reset 条目`, log.length === n && newest.test(log[0]) && !log.some((s) => /^reset/.test(s)), log);
}
/** 事后核对失败的文案断言：开头句、B / H / 当前 main / 当前 HEAD、人工回退指引（git reset --keep 与 B）。 */
function guidance(label, r, B, H, curMain, curHead) {
    const e = r.stderr;
    check(`${label}：文案写明合并已执行、没有回滚`, e.includes('合并已执行，但事后核对不通过') && e.includes('本工具没有回滚'), e.slice(0, 400));
    check(`${label}：文案含 B、H、当前 main、当前 HEAD`, e.includes(`B = ${B}`) && e.includes(`H = ${H}`) && e.includes(`当前 refs/heads/main = ${curMain}`) && e.includes(`当前 HEAD = ${curHead}`), e.slice(0, 600));
    check(`${label}：文案含人工回退指引（git reset --keep <B>、reflog）`, e.includes(`git reset --keep ${B}`) && e.includes('reflog'), e.slice(0, 800));
    check(`${label}：文案补充两句（reset --keep 会被拒绝需先处理改动；main 不等于 H / 父提交不是 [B, H] 时不要直接 reset）`,
        e.includes('git reset --keep 会被拒绝') && e.includes('不要直接 reset') && e.includes('弄清 main 是被谁移动的'), e.slice(0, 1200));
}

const HOOK_EXTRA_COMMIT ='git -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q --allow-empty -m extra';

async function sec19() {
    section('19', '事后核对失败一律不回滚：钩子造意外提交 / 钩子改脏文件（快进与 merge-commit）→ POSTCHECK_FAILED，仓库保持 git merge 之后的样子');
    // 19.1–19.3：post-merge 钩子又提交了一次，合入后的 main 不是本次合并的产物（可能是并发写入）：不撤离、不回滚
    const fx = await build('s19a');
    const H = lineCommit(fx, { 'line-new.txt': 'new\n' });
    installHook(fx, 'post-merge', HOOK_EXTRA_COMMIT);
    const r = merge(fx, fx.B0, H);
    failedWith('19.1 快进后 post-merge 钩子又提交了一次：main ≠ H', r, 'LINE_MERGE_POSTCHECK_FAILED');
    const m1 = oidOf(fx.main, 'refs/heads/main');
    check('19.2 钩子的提交原样保留（main 不是 B，父提交是 H），脚本没有回滚，H 的文件还在', m1 !== fx.B0 && oidOf(fx.main, `${m1}^`) === H && fs.existsSync(path.join(fx.main, 'line-new.txt')));
    noWrite('19.2b', fx, m1, fx.B0, 3, /: extra$/);   // init、快进、钩子的提交（钩子里的 git commit 继承了 merge 的 reflog 动作名，说明形如「merge <oid>: extra」）
    guidance('19.2c', r, fx.B0, H, m1, m1);

    const fx2 = await build('s19b');
    const H2 = lineCommit(fx2, { 'line-new.txt': 'new\n' });
    const B2 = mainCommit(fx2, { 'README.md': 'readme v2\n' });
    installHook(fx2, 'post-merge', HOOK_EXTRA_COMMIT);
    const r2 = merge(fx2, B2, H2, ['--merge-commit']);
    failedWith('19.3 merge-commit 后 post-merge 钩子又提交了一次：父提交不是 [B, H]', r2, 'LINE_MERGE_POSTCHECK_FAILED');
    const m2 = oidOf(fx2.main, 'refs/heads/main');
    check('19.3b 钩子的提交原样保留：main 的父提交是合并提交，不是 B', m2 !== B2 && oidOf(fx2.main, `${m2}^`) !== B2 && git(fx2.main, ['log', '-1', '--format=%s', m2]).trim() === 'extra');
    noWrite('19.3c', fx2, m2, B2, 4, /: extra$/);   // init、主侧提交 B、merge-commit、钩子的提交
    guidance('19.3d', r2, B2, H2, m2, m2);

    // 19.4 钩子改脏一个 B / H 之间无差异的已跟踪文件：事后核对失败，不回滚：main = HEAD = H，H 的文件还在，钩子的改动与未跟踪文件原样保留
    const fx3 = await build('s19c');
    const H3 = lineCommit(fx3, { 'line-new.txt': 'new\n' });
    w(path.join(fx3.main, 'junk-keep.txt'), 'untracked-keep\n');
    installHook(fx3, 'post-merge', 'echo dirty-by-hook > README.md');
    const r3 = merge(fx3, fx3.B0, H3);
    failedWith('19.4 快进后钩子改脏了 B / H 间无差异的 README.md', r3, 'LINE_MERGE_POSTCHECK_FAILED');
    check('19.4b 没有回滚：H 的文件还在，钩子的改动与未跟踪文件原样保留', fs.existsSync(path.join(fx3.main, 'line-new.txt')) && rd(path.join(fx3.main, 'line-new.txt')) === 'new\n'
        && rd(path.join(fx3.main, 'README.md')).replace(/\r/g, '') === 'dirty-by-hook\n' && rd(path.join(fx3.main, 'junk-keep.txt')) === 'untracked-keep\n');
    noWrite('19.4c', fx3, H3, fx3.B0, 2, /^merge /);   // init、快进
    guidance('19.4d', r3, fx3.B0, H3, H3, H3);
    check('19.4e 不符项点名「已跟踪文件不干净」', r3.stderr.includes('核对不符项') && r3.stderr.includes('不干净') && r3.stderr.includes('README.md'), r3.stderr.slice(0, 600));

    // 19.5 钩子改脏一个 B / H 之间有差异的已跟踪文件（b.txt）：（旧版回滚会被 git 拒绝报 UNKNOWN；现在同场景同样不回滚）→ POSTCHECK_FAILED，什么都没被动
    const fx4 = await build('s19d');
    const H4 = lineCommit(fx4, { 'b.txt': nLines('b', 6) });
    installHook(fx4, 'post-merge', 'echo dirty-by-hook > b.txt');
    const r4 = merge(fx4, fx4.B0, H4);
    failedWith('19.5 快进后钩子改脏了 B / H 间有差异的 b.txt', r4, 'LINE_MERGE_POSTCHECK_FAILED');
    check('19.5b 钩子的改动保留', rd(path.join(fx4.main, 'b.txt')).replace(/\r/g, '') === 'dirty-by-hook\n');
    noWrite('19.5c', fx4, H4, fx4.B0, 2, /^merge /);

    // 19.6 merge-commit 模式下同 19.4：不回滚，main = HEAD = 新提交 M（父提交 [B, H]）
    const fx5 = await build('s19e');
    const H5 = lineCommit(fx5, { 'b.txt': nLines('b', 6) });
    const B5 = mainCommit(fx5, { 'a.txt': nLines('x', 20) });
    w(path.join(fx5.main, 'junk-keep.txt'), 'untracked-keep\n');
    installHook(fx5, 'post-merge', 'echo dirty-by-hook > README.md');
    const r5 = merge(fx5, B5, H5, ['--merge-commit']);
    failedWith('19.6 merge-commit 后钩子改脏了 README.md', r5, 'LINE_MERGE_POSTCHECK_FAILED');
    const M5 = oidOf(fx5.main, 'refs/heads/main');
    check('19.6b M5 是合并提交（父提交 [B, H]），钩子的改动与未跟踪文件原样保留', git(fx5.main, ['rev-list', '--parents', '-n', '1', M5]).trim() === `${M5} ${B5} ${H5}`
        && rd(path.join(fx5.main, 'README.md')).replace(/\r/g, '') === 'dirty-by-hook\n' && rd(path.join(fx5.main, 'junk-keep.txt')) === 'untracked-keep\n');
    noWrite('19.6c', fx5, M5, B5, 3, /^merge /);   // init、主侧提交 B、merge-commit
    guidance('19.6d', r5, B5, H5, M5, M5);
}

async function sec20() {
    section('20', '登记表不可信：分支名 / worktree 路径 / lifecycle');
    const fx = await build('s20', { branch: 'hold/other' });
    const H = lineCommit(fx, { 'line-new.txt': 'new\n' });
    let before = snap(fx);
    rejected('20.1 登记分支不是 line/<线名>', fx, before, merge(fx, fx.B0, H), 'LINE_MERGE_LINE_STATE');

    const fx2 = await build('s20b', { worktreeReg: path.join(os.tmpdir(), `别处 目录 ${process.pid}`) });
    const H2 = lineCommit(fx2, { 'line-new.txt': 'new\n' });
    before = snap(fx2);
    const r2 = merge(fx2, fx2.B0, H2);
    rejected('20.2 登记的 worktree 不是 <线目录根>/<线名>', fx2, before, r2, 'LINE_MERGE_LINE_STATE');
    check('20.2b 提示是 worktree 路径不一致', r2.stderr.includes('worktree'), r2.stderr.slice(0, 300));

    for (const lc of ['creating', 'removing', 'failed']) {
        const f = await build(`s20-${lc}`, { lifecycle: lc });
        const h = lineCommit(f, { 'line-new.txt': 'new\n' });
        before = snap(f);
        const r = merge(f, f.B0, h);
        rejected(`20.3 lifecycle = ${lc}`, f, before, r, 'LINE_MERGE_LINE_STATE');
        check(`20.3 lifecycle = ${lc}：提示里点名状态`, r.stderr.includes(lc), r.stderr.slice(0, 300));
    }
}

/** 空提交链夹具：线上 L1（空提交）→ H（空提交），B = B0。空提交让树不变，注入的提交不干扰 status。 */
async function raceFixture(label, opt) {
    const fx = await build(label, opt);
    fx.L1 = emptyCommitIn(fx.wt, 'L1');
    fx.H = emptyCommitIn(fx.wt, 'L2');
    setupInject(fx);
    return fx;
}

async function sec21() {
    section('21', '并发写入：main 在前置核对与 git merge 之间被移动（core.fsmonitor 钩子注入）');
    // 21.1 快进：X 是 B 的后代、H 的祖先（= L1）。git merge --ff-only H 会成功（main 从 X 到 H），但合并起点不是 B
    const fx = await raceFixture('s21a');
    fire(fx, [`git update-ref refs/heads/main ${fx.L1} ${fx.B0}`]);
    let r = merge(fx, fx.B0, fx.H);
    failedWith('21.1 X 是 B 的后代且是 H 的祖先', r, 'LINE_MERGE_STATE_UNKNOWN');
    check('21.1b 注入确实发生；main 停在 H（并发写入的 X 是它的祖先，没被撤离）', injectConsumed(fx) && oidOf(fx.main, 'refs/heads/main') === fx.H && isAncestor(fx.main, fx.L1, 'refs/heads/main'));
    check('21.1c 提示合并起点不是 B', r.stderr.includes('合并起点不是 B'), r.stderr.slice(0, 300));

    // 21.2 快进：X 是 H 的后代。git merge --ff-only H 什么都不做（已是最新），ORIG_HEAD 不存在
    const fx2 = await raceFixture('s21b');
    fire(fx2, shMoveMainTo(fx2.H, fx2.B0, 'X-after-H'));
    r = merge(fx2, fx2.B0, fx2.H);
    failedWith('21.2 X 是 H 的后代', r, 'LINE_MERGE_STATE_UNKNOWN');
    const mx = oidOf(fx2.main, 'refs/heads/main');
    check('21.2b 注入确实发生；main 保持并发写入后的值 X（父提交是 H），没有被撤到 B', injectConsumed(fx2) && mx !== fx2.B0 && oidOf(fx2.main, `${mx}^`) === fx2.H);

    // 21.3 merge-commit：X 是 B 之上的新提交。git 把 H 合到 X 上，合并起点不是 B
    const fx3 = await build('s21c');
    const B3 = mainCommit(fx3, { 'README.md': 'readme v2\n' });
    fx3.H = emptyCommitIn(fx3.wt, 'L1');
    setupInject(fx3);
    fire(fx3, shMoveMainTo(B3, B3, 'X-on-B'));
    r = merge(fx3, B3, fx3.H, ['--merge-commit']);
    failedWith('21.3 merge-commit 下 main 上多出新提交 X', r, 'LINE_MERGE_STATE_UNKNOWN');
    const m3 = oidOf(fx3.main, 'refs/heads/main');
    check('21.3b 注入确实发生；main 是 git 合到 X 上的合并提交（第一个父提交是 X，X 的父提交是 B），没有被撤到 B',
        injectConsumed(fx3) && m3 !== B3 && git(fx3.main, ['log', '-1', '--format=%s', `${m3}^1`]).trim() === 'X-on-B' && oidOf(fx3.main, `${m3}^1^`) === B3);

    // 21.4 预置一个陈旧的 ORIG_HEAD（= B）+ X 是 H 的后代（git merge 空操作）：git 仍会把调用开始时的 HEAD（= X）改写进 ORIG_HEAD，历史遗留值蒙混不过去
    const fx4 = await raceFixture('s21d');
    const oh = path.join(fx4.main, '.git', 'ORIG_HEAD');
    w(oh, `${fx4.B0}\n`);
    const old = new Date(Date.now() - 3600 * 1000);
    fs.utimesSync(oh, old, old);
    fire(fx4, shMoveMainTo(fx4.H, fx4.B0, 'X-after-H'));
    r = merge(fx4, fx4.B0, fx4.H);
    failedWith('21.4 预置陈旧 ORIG_HEAD = B', r, 'LINE_MERGE_STATE_UNKNOWN');
    check('21.4b 提示合并起点不是 B（ORIG_HEAD 已被改写为 X）', r.stderr.includes('合并起点不是 B') && !r.stderr.includes(`ORIG_HEAD = ${fx4.B0}`), r.stderr.slice(0, 400));

    // 21.5 事后核对之后 main 又被移动：post-merge 钩子改脏 README.md（让事后核对失败）并武装注入；注入在事后核对的 git status 里把 main 挪到 H 之后的 X。
    //   不回滚：main 停在并发写入后的值 X，文案里「当前 main」读到的是 X（不是核对开头读到的 H）
    const fx5 = await raceFixture('s21e');
    w(path.join(fx5.main, '.git', 'inject2.sh'), `${shMoveMainTo(fx5.H, fx5.H, 'X-after-merge').join('\n')}\n`);
    installHook(fx5, 'post-merge', 'echo dirty-by-hook > README.md\ncp .git/inject2.sh .git/fsm-inject');
    r = merge(fx5, fx5.B0, fx5.H);
    failedWith('21.5 事后核对之后 main 又被移动（且工作区被钩子改脏）', r, 'LINE_MERGE_POSTCHECK_FAILED');
    const m5 = oidOf(fx5.main, 'refs/heads/main');
    check('21.5b 注入确实发生；main 保持并发写入后的值 X（父提交是 H），没有被 reset 到 B', injectConsumed(fx5) && m5 !== fx5.B0 && oidOf(fx5.main, `${m5}^`) === fx5.H, { m5 });
    check('21.5c reflog 恰有 3 条（init、快进、注入的无 -m 的 update-ref〔说明为空，但也写 reflog〕），没有 reset 条目（reset 会多一条）；ORIG_HEAD 仍是 B；钩子的改动保留',
        reflogMain(fx5).length === 3 && reflogMain(fx5)[0] === '' && !reflogMain(fx5).some((s) => /^reset/.test(s)) && oidOf(fx5.main, 'ORIG_HEAD') === fx5.B0 && rd(path.join(fx5.main, 'README.md')).replace(/\r/g, '') === 'dirty-by-hook\n', reflogMain(fx5));
    guidance('21.5d', r, fx5.B0, fx5.H, m5, m5);

    // 21.6 index.lock 在核对之后出现：git merge 因此失败（main 仍是 B、没有别的残留），但别的 git 进程可能正在运行 → STATE_UNKNOWN，锁文件原样保留
    const fx6 = await raceFixture('s21f');
    fire(fx6, [': > .git/index.lock']);
    r = merge(fx6, fx6.B0, fx6.H);
    failedWith('21.6 index.lock 出现在核对之后', r, 'LINE_MERGE_STATE_UNKNOWN');
    check('21.6b 注入确实发生；index.lock 原样保留，main 仍是 B', injectConsumed(fx6) && fs.existsSync(path.join(fx6.main, '.git', 'index.lock')) && oidOf(fx6.main, 'refs/heads/main') === fx6.B0);
    check('21.6c 提示 index.lock', r.stderr.includes('index.lock'), r.stderr.slice(0, 400));

    // 21.7 index.lock 在合并开始之前就存在：前置核对直接拒绝
    const fx7 = await raceFixture('s21g');
    w(path.join(fx7.main, '.git', 'index.lock'), '');
    const before7 = snap(fx7);
    rejected('21.7 合并前 index.lock 已存在', fx7, before7, merge(fx7, fx7.B0, fx7.H), 'LINE_MERGE_IN_PROGRESS');
}

async function sec22() {
    section('22', '合并失败残留未跟踪文件（> 260 字符路径）');
    const fx = await build('s22');
    git(fx.main, ['config', 'core.longpaths', 'false']);   // 钉死：不让本机全局配置的 longpaths 改变夹具行为
    w(path.join(fx.wt, 'aaa-new.txt'), 'new\n');
    git(fx.wt, ['add', 'aaa-new.txt']);
    const oid = gitIn(fx.wt, ['hash-object', '-w', '--stdin'], 'deep\n').trim();
    const deep = `${'d'.repeat(120)}/${'e'.repeat(120)}/zz.txt`;
    git(fx.wt, ['update-index', '--add', '--cacheinfo', `100644,${oid},${deep}`]);
    git(fx.wt, ['commit', '-q', '-m', 'L-long']);
    const H = oidOf(fx.wt, 'HEAD');
    const r = merge(fx, fx.B0, H);
    failedWith('22.1 快进在长路径上失败，留下 aaa-new.txt', r, 'LINE_MERGE_STATE_UNKNOWN');
    check('22.2 残留文件原样保留（不清理），main 仍是 B', fs.existsSync(path.join(fx.main, 'aaa-new.txt')) && rd(path.join(fx.main, 'aaa-new.txt')).replace(/\r/g, '') === 'new\n' && oidOf(fx.main, 'refs/heads/main') === fx.B0);
    check('22.3 提示出现了新的未跟踪路径', r.stderr.includes('未跟踪路径') && r.stderr.includes('aaa-new.txt'), r.stderr.slice(0, 400));
}

async function sec23() {
    section('23', '交叉合并历史：merge-base 不唯一');
    const fx = await build('s23');
    const l1 = lineCommit(fx, { 'l.txt': 'l1\n' }, 'L1');
    const m1 = mainCommit(fx, { 'a.txt': nLines('m', 20) }, 'M1');
    git(fx.main, ['merge', '-q', '--no-ff', '--no-edit', l1]);   // main 吃进线的 L1
    git(fx.wt, ['merge', '-q', '--no-ff', '--no-edit', m1]);     // 线吃进 main 的 M1
    const B = mainCommit(fx, { 'README.md': 'readme v2\n' }, 'B');
    const H = lineCommit(fx, { 'b.txt': nLines('b', 6) }, 'H');
    const bases = git(fx.main, ['merge-base', '--all', B, H]).trim().split(/\s+/).filter(Boolean);
    check('23.0 夹具前提：B 与 H 有两个共同祖先（M1 与 L1）', bases.length === 2, bases);
    const before = snap(fx);
    rejected('23.1 交叉合并历史', fx, before, merge(fx, B, H, ['--merge-commit']), 'LINE_MERGE_BASE_AMBIGUOUS');
}

async function sec24() {
    section('24', '主侧改名（内容不变）+ 线侧改原文件：关闭改名检测后路径有交集');
    const fx = await build('s24');
    const H = lineCommit(fx, { 'a.txt': nLines('a', 19) + 'a20-by-line\n' });
    const B = mainCommit(fx, { 'a2.txt': nLines('a', 20), 'a.txt': null }, 'main renames a.txt');
    const before = snap(fx);
    rejected('24.1 git mv a a2 + 线改 a', fx, before, merge(fx, B, H, ['--merge-commit']), 'LINE_MERGE_OVERLAP');
}

// 残余（v6 预筛 L-2，登记不处置）：本节进程内调用 L.run，被测代码的 git 子进程继承本测试进程的环境（不经 cleanEnv，含用户全局 / 系统 git 配置）；本节只核根覆盖参数被拒还是被放行，不依赖 git 配置
async function sec25() {
    section('25', '根覆盖参数指向「真实仓库的 linked worktree」（用临时仓库 A 充当真实仓库，进程内调用 run）');
    const A = await build('s25a');
    const O = await build('s25b');
    const L = lib('line.js');
    const runCaptured = async (argv, scriptRoot) => {
        const saved = { log: console.log, error: console.error };
        const lines = [];
        console.log = (...x) => { lines.push(x.join(' ')); };
        console.error = (...x) => { lines.push(x.join(' ')); };
        let code;
        try { code = await L.run(argv, scriptRoot); } finally { console.log = saved.log; console.error = saved.error; }
        return { code, text: lines.join('\n') };
    };
    assertTemp(A.main, A.wt, A.lines, A.control, O.main, O.lines, O.control);
    const beforeA = snap(A);
    const bad = await runCaptured(['list', '--control-root', O.control, '--lines-root', O.lines, '--main-root', A.wt], A.main);
    check('25.1 --main-root 是「真实仓库」A 的 linked worktree：拒绝（用法错误，退出码 2）', bad.code === 2 && bad.text.includes('真实仓库'), bad);
    const same = await runCaptured(['list', '--control-root', O.control, '--lines-root', O.lines, '--main-root', A.main], A.main);
    check('25.2 --main-root 就是「真实仓库」A 本身：照旧拒绝', same.code === 2, same);
    const ok = await runCaptured(['list', '--control-root', O.control, '--lines-root', O.lines, '--main-root', O.main], A.main);
    check('25.3 对照：--main-root 指向另一个临时仓库 O，不被拒绝（list 正常）', ok.code === 0, ok);
    check('25.4 拒绝之后「真实仓库」A 什么都没变', sameSnap(beforeA, snap(A), 'strict'));
}

/** 系统临时目录所在的文件系统是否大小写不敏感。 */
function fsCaseInsensitive() {
    const probe = path.join(os.tmpdir(), `case-probe-${process.pid}.tmp`);
    fs.writeFileSync(probe, 'x');
    const insensitive = fs.existsSync(probe.replace(/case-probe/, 'CASE-PROBE'));
    fs.unlinkSync(probe);
    return insensitive;
}
const IGN = 'secret.env\ndata/\n';
const hex = (c) => c.repeat(40);

async function sec26() {
    section('26', '本次合并要写入的路径在主工作区已有同名文件（被忽略 / 未跟踪 / 只差大小写 / 父路径是文件）：前置核对拒绝，内容一字不动');
    // 26.1 快进：线上 add -f 了 secret.env 与 data/biz.db，主工作区放同名的被忽略文件
    const fx = await build('s26a', { ignore: IGN });
    const H = commitForce(fx.wt, { 'secret.env': 'FROM-LINE\n', 'data/biz.db': 'FROM-LINE-DB\n' }, 'oops force-added ignored files');
    w(path.join(fx.main, 'secret.env'), 'REAL-SECRET\n');
    w(path.join(fx.main, 'data', 'biz.db'), 'REAL-DB\n');
    fx.watch = ['secret.env', 'data/biz.db'];
    let before = snap(fx);
    check('26.0 夹具前提：两个主工作区文件确实被忽略（status --ignored 里是 !! 项）', gq(fx.main, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored']).includes('!! secret.env'));
    let r = merge(fx, fx.B0, H);
    rejected('26.1 快进：被忽略的同名文件', fx, before, r, 'LINE_MERGE_UNTRACKED_COLLISION');
    check('26.1b 两个文件内容不变（断言内容）', rd(path.join(fx.main, 'secret.env')) === 'REAL-SECRET\n' && rd(path.join(fx.main, 'data', 'biz.db')) === 'REAL-DB\n');
    check('26.1c 文案列出两个路径、不回显内容', r.stderr.includes('secret.env') && r.stderr.includes('data/biz.db') && !r.stderr.includes('REAL-SECRET') && !r.stderr.includes('REAL-DB'), r.stderr.slice(0, 400));

    // 26.2 merge-commit：同上
    const fx2 = await build('s26b', { ignore: IGN });
    const H2 = commitForce(fx2.wt, { 'secret.env': 'FROM-LINE\n', 'data/biz.db': 'FROM-LINE-DB\n' }, 'oops force-added ignored files');
    const B2 = mainCommit(fx2, { 'README.md': 'readme v2\n' });
    w(path.join(fx2.main, 'secret.env'), 'REAL-SECRET\n');
    w(path.join(fx2.main, 'data', 'biz.db'), 'REAL-DB\n');
    fx2.watch = ['secret.env', 'data/biz.db'];
    before = snap(fx2);
    r = merge(fx2, B2, H2, ['--merge-commit']);
    rejected('26.2 merge-commit：被忽略的同名文件', fx2, before, r, 'LINE_MERGE_UNTRACKED_COLLISION');
    check('26.2b 两个文件内容不变', rd(path.join(fx2.main, 'secret.env')) === 'REAL-SECRET\n' && rd(path.join(fx2.main, 'data', 'biz.db')) === 'REAL-DB\n');

    // 26.3 ENOTDIR：线上新增 x/y.txt，主工作区有被忽略的「文件」x
    const fx3 = await build('s26c', { ignore: 'x\n' });
    const H3 = commitForce(fx3.wt, { 'x/y.txt': 'FROM-LINE\n' }, 'add x/y.txt');
    w(path.join(fx3.main, 'x'), 'IGNORED-FILE\n');
    fx3.watch = ['x'];
    before = snap(fx3);
    r = merge(fx3, fx3.B0, H3);
    rejected('26.3 父路径 x 是被忽略的文件（lstat x/y.txt 得 ENOTDIR）', fx3, before, r, 'LINE_MERGE_UNTRACKED_COLLISION');
    check('26.3b 文件 x 内容不变', rd(path.join(fx3.main, 'x')) === 'IGNORED-FILE\n');

    // 26.4 对照：W 里的路径在主工作区都不存在（只有无关的被忽略文件）→ 照常成功（快进与 merge-commit）；现有成功用例 1.0 / 14.0 / 5.1 同理
    const fx4 = await build('s26d', { ignore: IGN });
    const H4 = commitForce(fx4.wt, { 'secret.env': 'FROM-LINE\n', 'data/biz.db': 'FROM-LINE-DB\n' }, 'force-added');
    w(path.join(fx4.main, 'data', 'other.db'), 'OTHER-IGNORED\n');
    r = merge(fx4, fx4.B0, H4);
    check('26.4 快进成功，线上的两个文件就位，无关的被忽略文件不动', r.status === 0 && oidOf(fx4.main, 'refs/heads/main') === H4 && rd(path.join(fx4.main, 'secret.env')) === 'FROM-LINE\n'
        && rd(path.join(fx4.main, 'data', 'biz.db')) === 'FROM-LINE-DB\n' && rd(path.join(fx4.main, 'data', 'other.db')) === 'OTHER-IGNORED\n', { status: r.status, err: r.stderr.slice(0, 300) });
    const fx5 = await build('s26e', { ignore: IGN });
    const H5 = commitForce(fx5.wt, { 'secret.env': 'FROM-LINE\n' }, 'force-added');
    const B5 = mainCommit(fx5, { 'README.md': 'readme v2\n' });
    r = merge(fx5, B5, H5, ['--merge-commit']);
    check('26.4b merge-commit 成功，线上的文件就位', r.status === 0 && git(fx5.main, ['rev-list', '--parents', '-n', '1', 'refs/heads/main']).trim().endsWith(` ${B5} ${H5}`) && rd(path.join(fx5.main, 'secret.env')) === 'FROM-LINE\n', { status: r.status, err: r.stderr.slice(0, 300) });

    // 26.5 只差大小写：主工作区有 Secret.ENV，线上新增 secret.env。本机文件系统大小写不敏感时 lstat 命中；大小写敏感的文件系统上两个是不同文件，跳过
    if (fsCaseInsensitive()) {
        const fx6 = await build('s26f', { ignore: IGN });
        const H6 = commitForce(fx6.wt, { 'secret.env': 'FROM-LINE\n' }, 'force-added');
        w(path.join(fx6.main, 'Secret.ENV'), 'REAL-CASE\n');
        fx6.watch = ['Secret.ENV'];
        before = snap(fx6);
        r = merge(fx6, fx6.B0, H6);
        rejected('26.5 主工作区有只差大小写的 Secret.ENV', fx6, before, r, 'LINE_MERGE_UNTRACKED_COLLISION');
        check('26.5b Secret.ENV 内容不变', rd(path.join(fx6.main, 'Secret.ENV')) === 'REAL-CASE\n');
    } else console.log('  （本机文件系统大小写敏感，跳过 26.5）');
}

// ---- 并发写入模拟（按调用次序）：core.fsmonitor 钩子对每次调用计数（.git/fsm-count），第 n 次调用时执行 .git/fsm-act.sh（n = 0 只计数不动作）。
//      git 的 status / ls-files / diff-tree / merge 等会触发 fsmonitor，rev-parse / ls-tree 不触发（L4）。
function setupInjectAt(fx, n, actLines) {
    const hook = path.join(fx.main, '.git', 'fsm-hook-n.sh');
    w(hook, ['#!/bin/sh', 'c=$(cat .git/fsm-count 2>/dev/null || echo 0)', 'c=$((c+1))', 'echo $c > .git/fsm-count', `if [ "$c" = "${n}" ]; then sh .git/fsm-act.sh >> .git/fsm.log 2>&1; fi`,
        'printf \'%s\\0/\\0\' "$2"', ''].join('\n'));
    w(path.join(fx.main, '.git', 'fsm-act.sh'), `${actLines.join('\n')}\n`);
    git(fx.main, ['config', 'core.fsmonitor', `"${hook.replace(/\\/g, '/')}"`]);
}
/**
 * 校准：在同形状的夹具上跑一次成功的合并，用 post-merge 钩子记下 git merge 自己调用 fsmonitor 时的累计次数。
 * 这样「注入落在 git merge 自己的那次调用里（前置核对全部做完之后、git 检查未跟踪文件之前）」不依赖被测代码里 git 调用的个数与先后。
 */
async function calibrateMergeCall(mk) {
    const fx = await mk('cal');
    setupInjectAt(fx, 0, ['true']);
    installHook(fx, 'post-merge', 'cp .git/fsm-count .git/fsm-merge-index');
    const r = merge(fx, fx.B0, fx.H);
    if (r.status !== 0) throw new Error(`校准合并失败：${r.stderr.slice(0, 300)}`);
    const n = Number(rd(path.join(fx.main, '.git', 'fsm-merge-index')).trim());
    if (!(n >= 2)) throw new Error(`校准得到的 fsmonitor 次数异常：${n}`);
    return n;
}

async function sec27() {
    section('27', 'git 失败：有 MERGE_HEAD → 不 abort（GIT_FAILED_IN_PROGRESS，已删的未跟踪文件不恢复）；无 MERGE_HEAD → 合并前存在的未跟踪路径不见了 → STATE_UNKNOWN；对照 → GIT_FAILED');
    // 27.1 有 MERGE_HEAD：钩子删掉两个未跟踪文件再退出 1：只读善后，不 abort、不恢复
    const fx = await build('s27a', { ignore: 'local.cfg\n' });
    const H = lineCommit(fx, { 'b.txt': nLines('b', 6), 'line-new.txt': 'new\n' });
    const B = mainCommit(fx, { 'README.md': 'readme v2\n' });
    w(path.join(fx.main, 'junk.txt'), 'junk\n');
    w(path.join(fx.main, 'local.cfg'), 'cfg\n');
    installHook(fx, 'pre-merge-commit', 'rm -f junk.txt local.cfg\nexit 1');
    const logBefore = reflogMain(fx);
    const r = merge(fx, B, H, ['--merge-commit']);
    inProgressKept('27.1 钩子删掉两个未跟踪文件再退出 1', fx, r, B, logBefore, 0, B);
    check('27.1b 脚本不恢复：两个文件仍不存在', !fs.existsSync(path.join(fx.main, 'junk.txt')) && !fs.existsSync(path.join(fx.main, 'local.cfg')));

    // 27.2–27.4 无 MERGE_HEAD 的失败（快进被 git 的 --no-overwrite-ignore 拒绝）：注入落在 git merge 自己的 fsmonitor 调用里，造出被忽略的 data/biz.db（前置核对时它不存在）。
    //   主工作区合并前就有被忽略目录 data/（含 other.db，折叠成一项 `I data/`），所以新增的 data/biz.db 不改变「新增路径」比较（L3 盲区）——
    //   这样能把「合并前存在的 junk.txt 消失」隔离成唯一的不符项。
    const mk = async (label) => {
        const f = await build(label, { ignore: 'data/\n' });
        f.H = commitForce(f.wt, { 'data/biz.db': 'FROM-LINE\n' }, 'force-added data/biz.db');
        w(path.join(f.main, 'junk.txt'), 'junk\n');
        w(path.join(f.main, 'data', 'other.db'), 'OTHER\n');
        return f;
    };
    const N = await calibrateMergeCall(mk);
    const f2 = await mk('s27b');
    setupInjectAt(f2, N, ['printf "RACE-IGNORED\\n" > data/biz.db', 'rm -f junk.txt']);
    const r2 = merge(f2, f2.B0, f2.H);
    failedWith('27.2 git 因被忽略的 data/biz.db 拒绝，且合并前的 junk.txt 同时消失', r2, 'LINE_MERGE_STATE_UNKNOWN');
    check('27.2b 提示点名消失的路径 junk.txt；注入发生；data/biz.db 内容原样；main = B', r2.stderr.includes('不见了') && r2.stderr.includes('junk.txt') && rd(path.join(f2.main, 'data', 'biz.db')) === 'RACE-IGNORED\n' && oidOf(f2.main, 'refs/heads/main') === f2.B0, r2.stderr.slice(0, 500));
    const f3 = await mk('s27c');
    setupInjectAt(f3, N, ['printf "RACE-IGNORED\\n" > data/biz.db']);
    const r3 = merge(f3, f3.B0, f3.H);
    failedWith('27.3 对照：同一注入但 junk.txt 没有消失', r3, 'LINE_MERGE_GIT_FAILED');
    check('27.3b 对照：junk.txt 与 data/biz.db 内容原样，main = B', rd(path.join(f3.main, 'junk.txt')) === 'junk\n' && rd(path.join(f3.main, 'data', 'biz.db')) === 'RACE-IGNORED\n' && oidOf(f3.main, 'refs/heads/main') === f3.B0);

    // 27.4（35b-H3）：同一注入，另外把已跟踪的 README.md 改脏；未跟踪路径集合保持不变（junk.txt 还在，data/ 已折叠）→ 唯一的不符项是「已跟踪文件有改动」→ STATE_UNKNOWN
    const f4 = await mk('s27d');
    setupInjectAt(f4, N, ['printf "RACE-IGNORED\\n" > data/biz.db', 'printf "dirty-by-race\\n" >> README.md']);
    const r4 = merge(f4, f4.B0, f4.H);
    failedWith('27.4 git 因被忽略的 data/biz.db 拒绝，同时已跟踪的 README.md 被改脏', r4, 'LINE_MERGE_STATE_UNKNOWN');
    check('27.4b 原因点名「已跟踪文件有改动」与 README.md，没有「新增 / 消失」类原因', r4.stderr.includes('已跟踪文件有改动') && r4.stderr.includes('README.md') && !r4.stderr.includes('不见了') && !r4.stderr.includes('出现了合并前没有的未跟踪路径'), r4.stderr.slice(0, 600));
    check('27.4c 现场原样：README.md 仍是脏的，junk.txt 在，main = B', rd(path.join(f4.main, 'README.md')).replace(/\r/g, '').trim().endsWith('dirty-by-race') && rd(path.join(f4.main, 'junk.txt')) === 'junk\n' && oidOf(f4.main, 'refs/heads/main') === f4.B0);
}

/** 用临时索引文件、不经工作区地造一个提交：在 parent 的树上 add 或覆盖 files，返回新提交号。 */
function plumbCommit(fx, parent, files, msg) {
    const idx = path.join(fx.root, `tmp-index-${rootSeq}-${Object.keys(files).length}-${Date.now()}`);
    const env = Object.assign(cleanEnv(), { GIT_INDEX_FILE: idx });
    const run = (args, input) => {
        const r = spawnSync('git', [...GIT_ID, ...args], { cwd: fx.main, env, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, timeout: 60000 });
        if (r.error || r.status !== 0) throw new Error(`git ${args.join(' ')} 失败（${r.status}）：${r.stderr}`);
        return r.stdout.trim();
    };
    run(['read-tree', parent]);
    for (const [rel, text] of Object.entries(files)) run(['update-index', '--add', '--cacheinfo', `100644,${run(['hash-object', '-w', '--stdin'], text)},${rel}`]);
    const tree = run(['write-tree']);
    const c = run(['commit-tree', tree, '-p', parent, '-m', msg || 'plumb']);
    fs.unlinkSync(idx);
    return c;
}

async function sec28() {
    section('28', '--merge-commit 路径交集按小写比较：主侧 Docs.md、线侧 DOCS.MD');
    const fx = await build('s28');
    const H = plumbCommit(fx, fx.B0, { 'DOCS.MD': 'line doc\n' }, 'line adds DOCS.MD');
    git(fx.main, ['update-ref', 'refs/heads/line/Line-A', H, fx.B0]);
    const B = plumbCommit(fx, fx.B0, { 'Docs.md': 'main doc\n' }, 'main adds Docs.md');
    git(fx.main, ['update-ref', 'refs/heads/main', B, fx.B0]);
    git(fx.main, ['reset', '-q', '--hard']);   // 夹具：把主工作区与索引对齐到新的 main（写出 Docs.md）
    const pbCase = git(fx.main, ['diff-tree', '-r', '--name-only', '--no-renames', fx.B0, B]).trim();
    const phCase = git(fx.main, ['diff-tree', '-r', '--name-only', '--no-renames', fx.B0, H]).trim();
    check('28.0 夹具前提：主侧改动集恰为 Docs.md，线侧恰为 DOCS.MD（字符串比较没有交集）；merge-base 就是 B0',pbCase === 'Docs.md' && phCase === 'DOCS.MD' && git(fx.main, ['merge-base', B, H]).trim() === fx.B0);
    const before = snap(fx);
    const r = merge(fx, B, H, ['--merge-commit']);
    rejected('28.1 只差大小写的两个路径算交集', fx, before, r, 'LINE_MERGE_OVERLAP');
    check('28.2 文案列出原始路径（主侧写法与线侧写法）', r.stderr.includes('Docs.md') && r.stderr.includes('DOCS.MD'), r.stderr.slice(0, 400));
}

async function sec29() {
    section('29', '子模块指针双方都改（submodule.sm.ignore = all 想让 diff-tree 看不见）：仍判交集');
    const fx = await build('s29');
    fs.mkdirSync(path.join(fx.main, 'sm'));
    w(path.join(fx.main, '.gitmodules'), '[submodule "sm"]\n\tpath = sm\n\turl = ../sub\n');
    git(fx.main, ['add', '.gitmodules']);
    git(fx.main, ['update-index', '--add', '--cacheinfo', `160000,${hex('1')},sm`]);
    git(fx.main, ['commit', '-q', '-m', 'add submodule pointer']);
    const B1 = oidOf(fx.main, 'HEAD');
    git(fx.wt, ['merge', '-q', '--ff-only', B1]);
    git(fx.main, ['update-index', '--cacheinfo', `160000,${hex('2')},sm`]);
    git(fx.main, ['commit', '-q', '-m', 'main moves sm']);
    const B = oidOf(fx.main, 'HEAD');
    git(fx.wt, ['update-index', '--cacheinfo', `160000,${hex('3')},sm`]);
    git(fx.wt, ['commit', '-q', '-m', 'line moves sm']);
    const H = oidOf(fx.wt, 'HEAD');
    git(fx.main, ['config', 'submodule.sm.ignore', 'all']);
    const seen = (a, b, extra) => gq(fx.main, ['diff-tree', '-r', '-z', '--name-only', '--no-renames', ...extra, a, b, '--']);
    check('29.0 夹具前提：submodule.sm.ignore=all 时不带参数的 diff-tree 看不见指针改动，--ignore-submodules=none 看得见',
        seen(B1, B, []) === '0||' && seen(B1, B, ['--ignore-submodules=none']).includes('sm'), [seen(B1, B, []), seen(B1, B, ['--ignore-submodules=none'])]);
    const before = snap(fx);
    const r = merge(fx, B, H, ['--merge-commit']);
    rejected('29.1 两边都改了 sm 的指针', fx, before, r, 'LINE_MERGE_OVERLAP');
    check('29.2 文案列出 sm', r.stderr.includes('sm'), r.stderr.slice(0, 300));
}

async function sec30() {
    section('30', 'git merge 已成功返回，但读取 ORIG_HEAD 失败（post-merge 钩子把 .git/HEAD 写坏 → rev-parse 退出 128）→ STATE_UNKNOWN，点明「合并可能已经发生」');
    const fx = await build('s30');
    const H = lineCommit(fx, { 'line-new.txt': 'new\n' });
    installHook(fx, 'post-merge', 'echo garbage > .git/HEAD');
    const r = merge(fx, fx.B0, H);
    failedWith('30.1 ORIG_HEAD 读取失败', r, 'LINE_MERGE_STATE_UNKNOWN');
    check('30.2 文案点明 git merge 已返回成功、合并可能已经发生，并提到 ORIG_HEAD', r.stderr.includes('git merge 已返回成功') && r.stderr.includes('合并可能已经发生') && r.stderr.includes('ORIG_HEAD'), r.stderr.slice(0, 500));
    check('30.3 refs/heads/main 的值已经是 H（合并确实发生了；直接读 loose ref 文件，因为 git 已不认这个仓库）', rd(path.join(fx.main, '.git', 'refs', 'heads', 'main')).trim() === H);
    fs.writeFileSync(path.join(fx.main, '.git', 'HEAD'), 'ref: refs/heads/main\n');   // 夹具善后：把 HEAD 写回去，让后面的清理 / 快照不受影响
}

/** 线上把已跟踪目录 d 换成同名文件（git rm -r d、写文件 d、提交），返回 H。 */
function lineDirToFile(fx, dir, text) {
    git(fx.wt, ['rm', '-q', '-r', dir]);
    w(path.join(fx.wt, dir), text);
    git(fx.wt, ['add', dir]);
    git(fx.wt, ['commit', '-q', '-m', 'dir to file']);
    return oidOf(fx.wt, 'HEAD');
}

async function sec31() {
    section('31', '类型感知的前置核对：目录换文件（D/F）、子模块指针（gitlink）、只改大小写的改名');
    // 31.1 快进：B 里 d/ 是已跟踪目录，主工作区 d/cache.log 被忽略，线把 d 换成文件
    const mkDf = async (label) => {
        const f = await build(label, { ignore: '*.log\n', files: { 'd/x.txt': 'x\n', 'keep.txt': 'k\n' } });
        f.H = lineDirToFile(f, 'd', 'now a file\n');
        return f;
    };
    const fx = await mkDf('s31a');
    w(path.join(fx.main, 'd', 'cache.log'), 'IGNORED-IN-DIR\n');
    fx.watch = ['d/cache.log'];
    let before = snap(fx);
    let r = merge(fx, fx.B0, fx.H);
    rejected('31.1 快进：目录换文件，目录下有被忽略的 cache.log', fx, before, r, 'LINE_MERGE_UNTRACKED_COLLISION');
    check('31.1b cache.log 内容不变，d 仍是目录；文案点明目录将被替换为文件', rd(path.join(fx.main, 'd', 'cache.log')) === 'IGNORED-IN-DIR\n' && fs.statSync(path.join(fx.main, 'd')).isDirectory()
        && r.stderr.includes('该目录将被替换为文件') && r.stderr.includes('未跟踪 / 被忽略的项'), r.stderr.slice(0, 400));

    // 31.2 merge-commit：同上（git 在 merge-commit 下不拦，原先会静默删掉 cache.log）
    const fx2 = await mkDf('s31b');
    const B2 = mainCommit(fx2, { 'keep.txt': 'k2\n' });
    w(path.join(fx2.main, 'd', 'cache.log'), 'IGNORED-IN-DIR\n');
    fx2.watch = ['d/cache.log'];
    before = snap(fx2);
    r = merge(fx2, B2, fx2.H, ['--merge-commit']);
    rejected('31.2 merge-commit：目录换文件，目录下有被忽略的 cache.log', fx2, before, r, 'LINE_MERGE_UNTRACKED_COLLISION');
    check('31.2b cache.log 内容不变，文案点明目录将被替换为文件', rd(path.join(fx2.main, 'd', 'cache.log')) === 'IGNORED-IN-DIR\n' && r.stderr.includes('该目录将被替换为文件'), r.stderr.slice(0, 400));

    // 31.2c 目录下是未被忽略的未跟踪文件（只查 -o --exclude-standard 那一条能抓到；只查 -i 那条抓不到它）
    const fx2c = await mkDf('s31c');
    w(path.join(fx2c.main, 'd', 'notes.txt'), 'UNTRACKED-IN-DIR\n');
    fx2c.watch = ['d/notes.txt'];
    before = snap(fx2c);
    rejected('31.2c 快进：目录换文件，目录下有未被忽略的未跟踪 notes.txt', fx2c, before, merge(fx2c, fx2c.B0, fx2c.H), 'LINE_MERGE_UNTRACKED_COLLISION');
    check('31.2d notes.txt 内容不变', rd(path.join(fx2c.main, 'd', 'notes.txt')) === 'UNTRACKED-IN-DIR\n');

    // 31.3 对照：d/ 下没有未跟踪 / 被忽略的项 → 快进、merge-commit 都照常成功，d 变成文件
    const fx3 = await mkDf('s31d');
    r = merge(fx3, fx3.B0, fx3.H);
    check('31.3 对照：快进成功，d 是文件', r.status === 0 && oidOf(fx3.main, 'refs/heads/main') === fx3.H && fs.statSync(path.join(fx3.main, 'd')).isFile() && rd(path.join(fx3.main, 'd')) === 'now a file\n', { status: r.status, err: r.stderr.slice(0, 300) });
    const fx3b = await mkDf('s31e');
    const B3b = mainCommit(fx3b, { 'keep.txt': 'k2\n' });
    r = merge(fx3b, B3b, fx3b.H, ['--merge-commit']);
    check('31.3b 对照：merge-commit 成功，d 是文件', r.status === 0 && fs.statSync(path.join(fx3b.main, 'd')).isFile() && rd(path.join(fx3b.main, 'keep.txt')) === 'k2\n', { status: r.status, err: r.stderr.slice(0, 300) });

    // 31.4 L-a：线单侧改子模块指针（主工作区 sm 是普通的空目录）→ 不报 UNTRACKED_COLLISION
    const fx4 = await build('s31f');
    fs.mkdirSync(path.join(fx4.main, 'sm'));
    git(fx4.main, ['update-index', '--add', '--cacheinfo', `160000,${hex('1')},sm`]);
    git(fx4.main, ['commit', '-q', '-m', 'add submodule pointer']);
    const B4 = oidOf(fx4.main, 'HEAD');
    git(fx4.wt, ['merge', '-q', '--ff-only', B4]);
    git(fx4.wt, ['update-index', '--cacheinfo', `160000,${hex('2')},sm`]);
    git(fx4.wt, ['commit', '-q', '-m', 'line moves sm']);
    const H4 = oidOf(fx4.wt, 'HEAD');
    r = merge(fx4, B4, H4);
    check('31.4 线单侧改子模块指针：快进成功（不被误拒）', r.status === 0 && oidOf(fx4.main, 'refs/heads/main') === H4, { status: r.status, code: codeOf(r), err: r.stderr.slice(0, 400) });
    check('31.4b 合并后 sm 的 gitlink 是线上的值，sm 目录还在', git(fx4.main, ['ls-tree', 'HEAD', 'sm']).includes(hex('2')) && fs.statSync(path.join(fx4.main, 'sm')).isDirectory());

    // 31.6 MED-N4：线把子模块 sm 换成普通文件，主工作区 sm/ 下有内容（ls-files 不进子模块目录，查不出来）→ 拒绝，sm/data.txt 内容不变；只有两边都是 gitlink 才放行（31.4）
    // mode：'file'（gitlink 换成普通文件）/ 'delete'（gitlink 被删除）/ 'dir'（gitlink 换成普通目录，里面有文件 sm/real.txt）
    const mkSm = async (label, mode) => {
        const f = await build(label);
        fs.mkdirSync(path.join(f.main, 'sm'));
        git(f.main, ['update-index', '--add', '--cacheinfo', `160000,${hex('1')},sm`]);
        git(f.main, ['commit', '-q', '-m', 'add submodule pointer']);
        f.B1 = oidOf(f.main, 'HEAD');
        git(f.wt, ['merge', '-q', '--ff-only', f.B1]);
        git(f.wt, ['rm', '-q', '--cached', 'sm']);
        try { fs.rmdirSync(path.join(f.wt, 'sm')); } catch (_) { /* 线 worktree 里没有这个目录 */ }
        const m = mode || 'file';
        if (m === 'file') { w(path.join(f.wt, 'sm'), 'now a file\n'); git(f.wt, ['add', 'sm']); }
        if (m === 'dir') { w(path.join(f.wt, 'sm', 'real.txt'), 'real\n'); git(f.wt, ['add', 'sm/real.txt']); }
        git(f.wt, ['commit', '-q', '-m', `gitlink ${m}`]);
        f.H = oidOf(f.wt, 'HEAD');
        return f;
    };
    const fx6 = await mkSm('s31h');
    check('31.6 夹具前提：B 里 sm 是 gitlink（160000），H 里 sm 是普通文件（100644）', git(fx6.main, ['ls-tree', fx6.B1, 'sm']).startsWith('160000 commit') && git(fx6.main, ['ls-tree', fx6.H, 'sm']).startsWith('100644 blob'));
    w(path.join(fx6.main, 'sm', 'data.txt'), 'SUBMODULE-CONTENT\n');
    fx6.watch = ['sm/data.txt'];
    before = snap(fx6);
    r = merge(fx6, fx6.B1, fx6.H);
    rejected('31.6a 快进：gitlink 换成文件，sm/ 下有内容', fx6, before, r, 'LINE_MERGE_UNTRACKED_COLLISION');
    check('31.6b sm/data.txt 内容不变，sm 仍是目录；文案点明子模块将被替换', rd(path.join(fx6.main, 'sm', 'data.txt')) === 'SUBMODULE-CONTENT\n' && fs.statSync(path.join(fx6.main, 'sm')).isDirectory()
        && r.stderr.includes('子模块将被替换') && r.stderr.includes('请人工处理'), r.stderr.slice(0, 400));
    const fx7 = await mkSm('s31i');
    const B7 = mainCommit(fx7, { 'b.txt': 'b\n' });
    w(path.join(fx7.main, 'sm', 'data.txt'), 'SUBMODULE-CONTENT\n');
    fx7.watch = ['sm/data.txt'];
    before = snap(fx7);
    r = merge(fx7, B7, fx7.H, ['--merge-commit']);
    rejected('31.6c merge-commit：gitlink 换成文件，sm/ 下有内容', fx7, before, r, 'LINE_MERGE_UNTRACKED_COLLISION');
    check('31.6d sm/data.txt 内容不变，文案点明子模块将被替换', rd(path.join(fx7.main, 'sm', 'data.txt')) === 'SUBMODULE-CONTENT\n' && r.stderr.includes('子模块将被替换'), r.stderr.slice(0, 400));

    // 31.7 / 31.8（35b-H6）：gitlink 被删除、gitlink 换成普通目录（含文件）：原 sm/ 下有需要保留的内容 → 拒绝，内容、引用、ORIG_HEAD 都不变（rejected 默认 strict）
    for (const [mode, tag, what] of [['delete', '31.7', 'gitlink 被删除'], ['dir', '31.8', 'gitlink 换成普通目录（含文件 sm/real.txt）']]) {
        const f = await mkSm(`s31-${mode}`, mode);
        check(`${tag} 夹具前提：B 里 sm 是 gitlink，H 里 sm ${mode === 'delete' ? '不存在' : '是目录'}`, git(f.main, ['ls-tree', f.B1, 'sm']).startsWith('160000 commit')
            && (mode === 'delete' ? git(f.main, ['ls-tree', f.H, 'sm']).trim() === '' : git(f.main, ['ls-tree', f.H, 'sm']).startsWith('040000 tree')));
        w(path.join(f.main, 'sm', 'data.txt'), 'SUBMODULE-CONTENT\n');
        f.watch = ['sm/data.txt'];
        const b = snap(f);
        const rr = merge(f, f.B1, f.H);
        rejected(`${tag}a 快进：${what}，sm/ 下有内容`, f, b, rr, 'LINE_MERGE_UNTRACKED_COLLISION');
        check(`${tag}b sm/data.txt 内容不变，sm 仍是目录，文案点明子模块将被替换`, rd(path.join(f.main, 'sm', 'data.txt')) === 'SUBMODULE-CONTENT\n' && fs.statSync(path.join(f.main, 'sm')).isDirectory()
            && rr.stderr.includes('子模块将被替换'), rr.stderr.slice(0, 400));
    }

    // 31.5 L-b：线只把文件名改大小写（notes.txt → NOTES.txt）：新路径不在 B 的树里，lstat 又命中本次要删的 notes.txt → 被同一错误码拒绝，文案提示这种情形。只拒不放行
    if (fsCaseInsensitive()) {
        const fx5 = await build('s31g', { files: { 'notes.txt': 'n\n' } });
        git(fx5.wt, ['mv', 'notes.txt', 'NOTES.txt']);
        git(fx5.wt, ['commit', '-q', '-m', 'case rename']);
        const H5 = oidOf(fx5.wt, 'HEAD');
        before = snap(fx5);
        r = merge(fx5, fx5.B0, H5);
        rejected('31.5 线只改文件名大小写', fx5, before, r, 'LINE_MERGE_UNTRACKED_COLLISION');
        check('31.5b 文案含「只差大小写」提示与「请手动合并」', r.stderr.includes('本次合并要删除的已跟踪文件与新文件只差大小写') && r.stderr.includes('请手动合并'), r.stderr.slice(0, 500));
    } else console.log('  （本机文件系统大小写敏感，跳过 31.5）');
}

async function sec32() {
    section('32', 'merge-commit 钉死 merge.directoryRenames=false：主侧整目录改名 + 线侧在旧目录新增文件，按路径合并，与用户配置无关');
    const mk = async (label, cfg) => {
        const f = await build(label, { files: { 'docs/a.txt': 'a\n', 'docs/b.txt': 'b\n' } });
        f.H = lineCommit(f, { 'docs/new.txt': 'new\n' }, 'line adds docs/new.txt');
        git(f.main, ['mv', 'docs', 'manual']);
        git(f.main, ['commit', '-q', '-m', 'main renames docs to manual']);
        f.B = oidOf(f.main, 'HEAD');
        if (cfg) git(f.main, ['config', 'merge.directoryRenames', cfg]);
        return f;
    };
    const verifyOne = (label, f, r) => {
        check(`${label}：退出码 0（按路径合并，PB 与 PH 无交集）`, r.status === 0, { status: r.status, code: codeOf(r), err: r.stderr.slice(0, 500) });
        const lsTree = gq(f.main, ['ls-tree', '-r', '--name-only', 'HEAD']);
        check(`${label}：结果树：线侧新文件留在 docs/new.txt（不被挪到 manual/），主侧改名保留`, lsTree.includes('docs/new.txt') && !lsTree.includes('manual/new.txt') && lsTree.includes('manual/a.txt') && lsTree.includes('manual/b.txt'), lsTree);
        check(`${label}：父提交恰为 [B, H]`, git(f.main, ['rev-list', '--parents', '-n', '1', 'HEAD']).trim().endsWith(` ${f.B} ${f.H}`));
    };
    const f1 = await mk('s32a', null);
    verifyOne('32.1 默认配置', f1, merge(f1, f1.B, f1.H, ['--merge-commit']));
    const f2 = await mk('s32b', 'true');
    verifyOne('32.2 仓库本地配置 merge.directoryRenames=true（钉死生效，结果与默认配置相同）', f2, merge(f2, f2.B, f2.H, ['--merge-commit']));
}

async function sec33() {
    section('33', '快进的 --no-overwrite-ignore 兜底：前置核对之后、git merge 之前出现被忽略的同名文件（注入落在 git merge 自己的 fsmonitor 调用里）→ git 拒绝，文件不被覆盖');
    const mk = async (label) => {
        const f = await build(label, { ignore: IGN });
        f.H = commitForce(f.wt, { 'secret.env': 'FROM-LINE\n' }, 'force-added secret.env');
        return f;
    };
    const N = await calibrateMergeCall(mk);
    const fx = await mk('s33');
    setupInjectAt(fx, N, ['printf "RACE-IGNORED\\n" > secret.env']);
    const r = merge(fx, fx.B0, fx.H);
    failedWith('33.1 注入后 git merge 拒绝覆盖（出现了合并前没有的未跟踪路径 → UNKNOWN）', r, 'LINE_MERGE_STATE_UNKNOWN');
    check('33.2 被忽略的 secret.env 内容原样（RACE-IGNORED），main 仍是 B', rd(path.join(fx.main, 'secret.env')) === 'RACE-IGNORED\n' && oidOf(fx.main, 'refs/heads/main') === fx.B0, r.stderr.slice(0, 400));
    check('33.3 git 的拒绝原因是「未跟踪文件会被覆盖」', r.stderr.includes('would be overwritten') || r.stderr.includes('overwritten'), r.stderr.slice(0, 500));
}

async function sec34() {
    section('34', '35a-H1 跨侧祖先路径冲突：一侧是文件、另一侧是同名目录下的路径（git 会把文件移到 d~<H> 辅助路径，不经碰撞核对）→ OVERLAP');
    // 34.1 共同祖先没有 d：主侧新增 d/x，线侧新增文件 d。主工作区在辅助路径 d~<H> 放一个被忽略的哨兵文件
    const fx = await build('s34a', { ignore: 'd~*\n' });
    const H = lineCommit(fx, { d: 'LINE-FILE\n' }, 'line adds file d');
    const B = mainCommit(fx, { 'd/x': 'MAIN-X\n' }, 'main adds d/x');
    const aux = `d~${H}`;
    w(path.join(fx.main, aux), 'SENTINEL\n');
    fx.watch = [aux];
    let before = snap(fx);
    check('34.0 夹具前提：PB = {d/x}，PH = {d}，没有字符串交集；哨兵文件是被忽略的', git(fx.main, ['diff-tree', '-r', '--name-only', '--no-renames', fx.B0, B]).trim() === 'd/x'
        && git(fx.main, ['diff-tree', '-r', '--name-only', '--no-renames', fx.B0, H]).trim() === 'd' && gq(fx.main, ['status', '--porcelain=v1', '-z', '--ignored']).includes(`!! ${aux}`));
    let r = merge(fx, B, H, ['--merge-commit']);
    rejected('34.1 主侧 d/x + 线侧文件 d', fx, before, r, 'LINE_MERGE_OVERLAP');
    check('34.1b 哨兵文件内容不变；文案点明「一侧是文件、另一侧是同名目录下的路径」并列出两个路径', rd(path.join(fx.main, aux)) === 'SENTINEL\n' && r.stderr.includes('一侧是文件、另一侧是同名目录下的路径') && r.stderr.includes('d/x'), r.stderr.slice(0, 500));

    // 34.2 反方向：主侧新增文件 e，线侧新增 e/y
    const fx2 = await build('s34b');
    const H2 = lineCommit(fx2, { 'e/y': 'LINE-Y\n' }, 'line adds e/y');
    const B2 = mainCommit(fx2, { e: 'MAIN-FILE\n' }, 'main adds file e');
    before = snap(fx2);
    r = merge(fx2, B2, H2, ['--merge-commit']);
    rejected('34.2 主侧文件 e + 线侧 e/y', fx2, before, r, 'LINE_MERGE_OVERLAP');
    check('34.2b 文案点明文件 / 目录关系', r.stderr.includes('一侧是文件、另一侧是同名目录下的路径') && r.stderr.includes('e/y'), r.stderr.slice(0, 400));

    // 34.3 大小写：主侧 Dd/x，线侧文件 dD（小写后 dd 是 dd/x 的祖先）
    const fx3 = await build('s34c');
    const H3 = lineCommit(fx3, { dD: 'LINE-FILE\n' }, 'line adds file dD');
    const B3 = mainCommit(fx3, { 'Dd/x': 'MAIN-X\n' }, 'main adds Dd/x');
    before = snap(fx3);
    r = merge(fx3, B3, H3, ['--merge-commit']);
    rejected('34.3 主侧 Dd/x + 线侧文件 dD（大小写不同的祖先目录）', fx3, before, r, 'LINE_MERGE_OVERLAP');
    check('34.3b 文案点明文件 / 目录关系', r.stderr.includes('一侧是文件、另一侧是同名目录下的路径'), r.stderr.slice(0, 400));

    // 34.4 对照：g 与 g.txt 只是字符串前缀、不是目录前缀；g 是主侧新增的文件，g.txt 是线侧新增的文件 → 无关，照常成功
    const fx4 = await build('s34d');
    const H4 = lineCommit(fx4, { 'g.txt': 'LINE\n' }, 'line adds g.txt');
    const B4 = mainCommit(fx4, { g: 'MAIN\n' }, 'main adds g');
    r = merge(fx4, B4, H4, ['--merge-commit']);
    check('34.4 对照：字符串前缀但不是目录前缀（g / g.txt）→ 成功', r.status === 0 && rd(path.join(fx4.main, 'g')) === 'MAIN\n' && rd(path.join(fx4.main, 'g.txt')) === 'LINE\n', { status: r.status, code: codeOf(r), err: r.stderr.slice(0, 300) });
}

async function sec35() {
    section('35', '35a-M1 sequencer：多提交 cherry-pick 在首个冲突后手动提交，CHERRY_PICK_HEAD 消失但 sequencer 还在 → IN_PROGRESS');
    const fx = await build('s35');
    git(fx.main, ['checkout', '-q', '-b', 'pick']);
    const lines1 = (first) => `${first}\n${nLines('a', 20).split('\n').slice(1).join('\n')}`;
    commitIn(fx.main, { 'a.txt': lines1('a1-pick') }, 'A');
    commitIn(fx.main, { 'c.txt': 'c\n' }, 'C');
    git(fx.main, ['checkout', '-q', 'main']);
    commitIn(fx.main, { 'a.txt': lines1('a1-main') }, 'main change');
    const cp = gq(fx.main, ['cherry-pick', 'pick~1', 'pick']);
    check('35.0 夹具前提：cherry-pick 在 A 上冲突退出（非 0），CHERRY_PICK_HEAD 与 sequencer 都在', !cp.startsWith('0|') && fs.existsSync(path.join(fx.main, '.git', 'CHERRY_PICK_HEAD')) && fs.existsSync(path.join(fx.main, '.git', 'sequencer')), cp.slice(0, 200));
    w(path.join(fx.main, 'a.txt'), lines1('a1-resolved'));
    git(fx.main, ['add', 'a.txt']);
    git(fx.main, ['commit', '-q', '--no-edit']);
    check('35.0b 夹具前提：手动提交后 CHERRY_PICK_HEAD 消失、sequencer 还在、已跟踪文件干净', !fs.existsSync(path.join(fx.main, '.git', 'CHERRY_PICK_HEAD')) && fs.existsSync(path.join(fx.main, '.git', 'sequencer')) && cleanTracked(fx));
    const B = oidOf(fx.main, 'HEAD');
    const H = lineCommit(fx, { 'line-new.txt': 'new\n' }, 'line work');
    const before = snap(fx);
    const r = merge(fx, B, H, ['--merge-commit']);
    rejected('35.1 sequencer 还在', fx, before, r, 'LINE_MERGE_IN_PROGRESS');
    check('35.1b 文案点名 sequencer', r.stderr.includes('sequencer'), r.stderr.slice(0, 300));
}

async function sec36() {
    section('36', '35b-H1 树核对接线：post-merge 钩子换掉合并提交（替身提交，父提交仍是 [B, H]、工作区干净、ORIG_HEAD = B），只有树核对能拒绝');
    // 钩子里不能 `commit --amend`（post-merge 时 MERGE_HEAD 还在：git 报 cannot amend），改用管道命令造一个「同父提交 [B, H]、树不同」的替身提交并把 main 指过去：
    // 索引已 add 了改动，工作区也有，所以 HEAD、索引、工作区三者一致（干净），ORIG_HEAD 不变，父提交仍是 [B, H]
    const AMEND = ['T=$(git write-tree)', 'NEW=$(git commit-tree $T -p $(git rev-parse HEAD^1) -p $(git rev-parse HEAD^2) -m amended-merge)', 'git update-ref refs/heads/main $NEW'].join('\n');
    const cases = [
        ['36.1', '改无关路径：新增 PB / PH 之外的文件 extra.txt', 'echo extra > extra.txt\ngit add extra.txt', '多出'],
        ['36.2', '改已有改动路径的内容：线侧的 line-new.txt', 'echo tampered > line-new.txt\ngit add line-new.txt', '不等于 H'],
    ];
    for (const [tag, what, change, reasonFrag] of cases) {
        const fx = await build(`s${tag.replace('.', '-')}`);
        const H = lineCommit(fx, { 'line-new.txt': 'new\n' });
        const B = mainCommit(fx, { 'README.md': 'readme v2\n' });
        installHook(fx, 'post-merge', `${change}\n${AMEND}`);
        const r = merge(fx, B, H, ['--merge-commit']);
        failedWith(`${tag} amend 合并提交（${what}）`, r, 'LINE_MERGE_POSTCHECK_FAILED');
        const M2 = oidOf(fx.main, 'refs/heads/main');
        check(`${tag}b 夹具确认：amend 之后父提交仍是 [B, H]，工作区干净，ORIG_HEAD = B；main 停在 amend 后的提交（没有回滚）`,
            git(fx.main, ['rev-list', '--parents', '-n', '1', M2]).trim() === `${M2} ${B} ${H}` && cleanTracked(fx) && oidOf(fx.main, 'ORIG_HEAD') === B && oidOf(fx.main, 'HEAD') === M2, { M2 });
        const reasons = (/核对不符项：(.*?)。人工回退指引/s.exec(r.stderr) || [null, ''])[1];   // 只看「核对不符项」一段（后面的人工指引里本来就有「父提交」字样）
        check(`${tag}c 拒绝原因只来自树核对：不符项含「${reasonFrag}」，不含父提交 / 不干净 / 没有产生新的合并提交 / HEAD 与 main 不一致 / 核对本身出错`,
            reasons.includes(reasonFrag) && !reasons.includes('父提交') && !reasons.includes('不干净') && !reasons.includes('没有产生新的合并提交') && !reasons.includes('HEAD 与 main 不一致') && !reasons.includes('核对本身出错'), reasons.slice(0, 500));
    }
}

async function sec37() {
    section('37', '35b-H2 事后核对本身出错：post-merge 钩子写坏 .git/index（HEAD、main、ORIG_HEAD 保持有效）→ 起点核对通过，postCheck 里 git status 失败 → POSTCHECK_FAILED');
    const fx = await build('s37');
    const H = lineCommit(fx, { 'line-new.txt': 'new\n' });
    installHook(fx, 'post-merge', 'echo garbage > .git/index');
    const r = merge(fx, fx.B0, H);
    failedWith('37.1 索引被写坏', r, 'LINE_MERGE_POSTCHECK_FAILED');
    check('37.2 文案含「事后核对本身出错」、B / H / 当前 main、人工指引', r.stderr.includes('事后核对本身出错') && r.stderr.includes('合并已执行，但事后核对不通过') && r.stderr.includes(`B = ${fx.B0}`) && r.stderr.includes(`H = ${H}`)
        && r.stderr.includes(`当前 refs/heads/main = ${H}`) && r.stderr.includes(`git reset --keep ${fx.B0}`), r.stderr.slice(0, 700));
    // git 已不认这个索引：直接读文件，现场保留（索引仍是坏的，main 停在 H，ORIG_HEAD = B）
    check('37.3 现场保留：索引仍是写坏的内容，refs/heads/main = H，ORIG_HEAD = B', rd(path.join(fx.main, '.git', 'index')).startsWith('garbage') && rd(path.join(fx.main, '.git', 'refs', 'heads', 'main')).trim() === H && rd(path.join(fx.main, '.git', 'ORIG_HEAD')).trim() === fx.B0,
        { index: rd(path.join(fx.main, '.git', 'index')).slice(0, 20), main: rd(path.join(fx.main, '.git', 'refs', 'heads', 'main')), orig: rd(path.join(fx.main, '.git', 'ORIG_HEAD')) });
}

/** 控制根下所有文件的相对路径 → 内容 sha256（逐字节）；目录记为 DIR。 */
function dumpTree(root) {
    const out = new Map();
    const walk = (dir, rel) => {
        for (const n of fs.readdirSync(dir).sort()) {
            const p = path.join(dir, n);
            const r = rel === '' ? n : `${rel}/${n}`;
            const st = fs.lstatSync(p);
            if (st.isDirectory()) { out.set(r, 'DIR'); walk(p, r); } else out.set(r, require('crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
        }
    };
    walk(root, '');
    return out;
}
const sameDump = (a, b) => a.size === b.size && Array.from(a.entries()).every(([k, v]) => b.get(k) === v);

async function sec38() {
    section('38', '35b-H4 登记表只读：成功与拒绝用例前后，控制根下所有文件逐字节不变；成功后线记录仍在、lifecycle 仍为 ready');
    const stillReady = async (fx) => { const st = await S.readState(fx.control); const k = Object.keys(st.lines).find((x) => x.toLowerCase() === fx.name.toLowerCase()); return k !== undefined && st.lines[k].lifecycle === 'ready'; };
    // 38.1 快进成功
    const fx = await build('s38a');
    const H = lineCommit(fx, { 'line-new.txt': 'new\n' });
    let d0 = dumpTree(fx.control);
    check('38.0 夹具前提：控制根下至少有登记表 lines.json', d0.has('lines.json'), Array.from(d0.keys()));
    let r = merge(fx, fx.B0, H);
    check('38.1 快进成功，控制根下文件（含列表）逐字节不变，线记录仍在、lifecycle = ready', r.status === 0 && sameDump(d0, dumpTree(fx.control)) && await stillReady(fx), { status: r.status, before: Array.from(d0.keys()), after: Array.from(dumpTree(fx.control).keys()) });
    // 38.2 merge-commit 成功
    const fx2 = await build('s38b');
    const H2 = lineCommit(fx2, { 'line-new.txt': 'new\n' });
    const B2 = mainCommit(fx2, { 'README.md': 'readme v2\n' });
    d0 = dumpTree(fx2.control);
    r = merge(fx2, B2, H2, ['--merge-commit']);
    check('38.2 merge-commit 成功，控制根下文件逐字节不变，线记录仍在、lifecycle = ready', r.status === 0 && sameDump(d0, dumpTree(fx2.control)) && await stillReady(fx2), { status: r.status });
    // 38.3 前置拒绝（已跟踪文件改动）
    const fx3 = await build('s38c');
    const H3 = lineCommit(fx3, { 'line-new.txt': 'new\n' });
    w(path.join(fx3.main, 'README.md'), 'dirty\n');
    d0 = dumpTree(fx3.control);
    r = merge(fx3, fx3.B0, H3);
    check('38.3 前置拒绝（DIRTY），控制根下文件逐字节不变，线记录仍在', codeOf(r) === 'LINE_MERGE_DIRTY' && sameDump(d0, dumpTree(fx3.control)) && await stillReady(fx3), { code: codeOf(r) });
    // 38.4 POSTCHECK_FAILED（post-merge 钩子又提交了一次）
    const fx4 = await build('s38d');
    const H4 = lineCommit(fx4, { 'line-new.txt': 'new\n' });
    installHook(fx4, 'post-merge', HOOK_EXTRA_COMMIT);
    d0 = dumpTree(fx4.control);
    r = merge(fx4, fx4.B0, H4);
    check('38.4 POSTCHECK_FAILED，控制根下文件逐字节不变，线记录仍在、lifecycle = ready', codeOf(r) === 'LINE_MERGE_POSTCHECK_FAILED' && sameDump(d0, dumpTree(fx4.control)) && await stillReady(fx4), { code: codeOf(r) });
}

async function sec39() {
    section('39', '35b-H5 快进事后核对：main 与 HEAD 两项分开约束（树相同、引用不同；干净、ORIG_HEAD = B）');
    // 39.1 HEAD 分离停在 H，main 被移到 X（X = H 的空子提交，树与 H 相同）
    const fx = await build('s39a');
    const H = lineCommit(fx, { 'line-new.txt': 'new\n' });
    installHook(fx, 'post-merge', ['H=$(git rev-parse HEAD)', 'X=$(git commit-tree HEAD^{tree} -p HEAD -m x-main)', 'git update-ref --no-deref HEAD $H', 'git update-ref refs/heads/main $X'].join('\n'));
    let r = merge(fx, fx.B0, H);
    failedWith('39.1 HEAD = H（分离），main 被移到 X', r, 'LINE_MERGE_POSTCHECK_FAILED');
    const X = oidOf(fx.main, 'refs/heads/main');
    check('39.1b 夹具确认：HEAD 分离停在 H，main = X ≠ H，X 与 H 树相同，工作区干净，ORIG_HEAD = B', oidOf(fx.main, 'HEAD') === H && X !== H && oidOf(fx.main, `${X}^{tree}`) === oidOf(fx.main, `${H}^{tree}`) && cleanTracked(fx) && oidOf(fx.main, 'ORIG_HEAD') === fx.B0);
    check('39.1c 拒绝原因是 main：文案含「合入后 main 是 X」，不含「HEAD 是」', r.stderr.includes(`合入后 main 是 ${X}`) && !r.stderr.includes('合入后 HEAD 是'), r.stderr.slice(0, 500));

    // 39.2 main 留在 H，HEAD 分离停在 X
    const fx2 = await build('s39b');
    const H2 = lineCommit(fx2, { 'line-new.txt': 'new\n' });
    installHook(fx2, 'post-merge', ['X=$(git commit-tree HEAD^{tree} -p HEAD -m x-head)', 'git update-ref --no-deref HEAD $X'].join('\n'));
    r = merge(fx2, fx2.B0, H2);
    failedWith('39.2 main = H，HEAD 分离停在 X', r, 'LINE_MERGE_POSTCHECK_FAILED');
    const X2 = oidOf(fx2.main, 'HEAD');
    check('39.2b 夹具确认：main = H，HEAD = X ≠ H，X 与 H 树相同，工作区干净，ORIG_HEAD = B', oidOf(fx2.main, 'refs/heads/main') === H2 && X2 !== H2 && oidOf(fx2.main, `${X2}^{tree}`) === oidOf(fx2.main, `${H2}^{tree}`) && cleanTracked(fx2) && oidOf(fx2.main, 'ORIG_HEAD') === fx2.B0);
    check('39.2c 拒绝原因是 HEAD：文案含「合入后 HEAD 是 X」，不含「合入后 main 是」', r.stderr.includes(`合入后 HEAD 是 ${X2}`) && !r.stderr.includes('合入后 main 是'), r.stderr.slice(0, 500));
}

async function sec40() {
    section('40', '35b-M1 夹具 git 环境隔离：对象目录 / 配置注入变量被清除，全局 / 系统配置不进入夹具，core.hooksPath 固定到夹具自己的 hooks 目录');
    const fake = { GIT_OBJECT_DIRECTORY: 'X', GIT_ALTERNATE_OBJECT_DIRECTORIES: 'X', GIT_NAMESPACE: 'x', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: 'X', GIT_CONFIG_PARAMETERS: "'a.b'='c'",
        GIT_CONFIG_GLOBAL: 'X', GIT_CONFIG_SYSTEM: 'X', GIT_CONFIG: 'X', GIT_DIR: 'X', GIT_INDEX_FILE: 'X', GIT_WORK_TREE: 'X', GIT_COMMON_DIR: 'X', GIT_TEMPLATE_DIR: 'X' };
    const saved = {};
    for (const [k, v] of Object.entries(fake)) { saved[k] = process.env[k]; process.env[k] = v; }
    let env;
    try { env = cleanEnv(); } finally { for (const k of Object.keys(fake)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
    const leaked = Object.keys(fake).filter((k) => k !== 'GIT_CONFIG_GLOBAL' && Object.keys(env).some((e) => e.toUpperCase() === k));
    check('40.1 被污染的进程环境经 cleanEnv 之后：对象目录 / 命名空间 / 仓库定位 / GIT_CONFIG* 注入变量全部清除', leaked.length === 0, leaked);
    check('40.2 GIT_CONFIG_GLOBAL 指向私有空文件，GIT_CONFIG_NOSYSTEM = 1', env.GIT_CONFIG_GLOBAL === GIT_EMPTY_CONFIG && env.GIT_CONFIG_NOSYSTEM === '1' && fs.existsSync(GIT_EMPTY_CONFIG) && fs.statSync(GIT_EMPTY_CONFIG).size === 0);
    const fx = await build('s40');
    const origins = git(fx.main, ['config', '--list', '--show-origin']).split('\n').map((s) => s.replace(/\r/g, '')).filter(Boolean);
    const foreign = origins.filter((l) => !/^command line:/.test(l) && !/^file:(.*\/)?\.git\/config\t/.test(l.replace(/\\/g, '/')));
    check('40.3 夹具仓库的有效配置只来自它自己的 .git/config 与命令行，没有全局 / 系统配置', origins.length > 0 && foreign.length === 0, foreign.slice(0, 3));
    const hp = git(fx.main, ['config', '--get', 'core.hooksPath']).trim();
    check('40.4 core.hooksPath = 夹具自己的 .git/hooks（正斜杠绝对路径）', hp === path.join(fx.main, '.git', 'hooks').replace(/\\/g, '/'), hp);
}

// ---- S7b：--branch 入口

/** 建夹具 + 一个不是登记线的本地分支（默认 feat/x，从 B0 起，单独的 worktree 里提交）。 */
async function buildBranch(label, o) {
    const fx = await build(label, o);
    fx.branch = (o && o.branch) || 'feat/x';
    fx.bwt = path.join(fx.root, '分支 工作区');
    git(fx.main, ['worktree', 'add', '-q', '-b', fx.branch, fx.bwt, fx.B0]);
    return fx;
}
const branchCommit = (fx, files, msg) => commitIn(fx.bwt, files, msg);
const mergeBr = (fx, branch, base, head, extra) => cli(fx, ['merge', '--branch', branch, '--base', base, '--head', head, ...(extra || [])]);

async function sec41() {
    section('41', 'S7b --branch <分支名> 入口：二选一、分支名校验、共用核对路径、登记表只读');
    // 41.1 快进成功
    const fx = await buildBranch('s41a');
    const H = branchCommit(fx, { 'b.txt': nLines('b', 6), 'line-new.txt': 'new\n' }, 'branch work');
    const d0 = dumpTree(fx.control);
    let r = mergeBr(fx, 'feat/x', fx.B0, H);
    check('41.1 --branch 快进成功：退出码 0，main = HEAD = H，已跟踪文件干净，文件就位', r.status === 0 && oidOf(fx.main, 'refs/heads/main') === H && oidOf(fx.main, 'HEAD') === H && cleanTracked(fx) && rd(path.join(fx.main, 'line-new.txt')) === 'new\n', { status: r.status, err: r.stderr.slice(0, 300) });
    check('41.1b 输出含「分支：feat/x」，不含「线名：」；模式 / B / H / 合入后 main 照旧', r.stdout.includes('分支：feat/x') && !r.stdout.includes('线名：') && r.stdout.includes('模式：快进') && r.stdout.includes(`B：${fx.B0}`) && r.stdout.includes(`H：${H}`) && r.stdout.includes(`合入后 main：${H}`), r.stdout);
    check('41.1c 登记表（控制根下全部文件）逐字节不变，登记线的记录与 lifecycle 不受影响', sameDump(d0, dumpTree(fx.control)));

    // 41.2 merge-commit 成功
    const fx2 = await buildBranch('s41b');
    const zh = path.join('文档 目录', '说明 1.txt');
    const H2 = branchCommit(fx2, { 'b.txt': nLines('b', 6), 'line-new.txt': 'new\n', [zh]: '说明 v1 by branch\n' }, 'branch work');
    const B2 = mainCommit(fx2, { 'a.txt': nLines('x', 20), 'main-new.txt': 'main new\n' }, 'main docs');
    const d2 = dumpTree(fx2.control);
    r = mergeBr(fx2, 'feat/x', B2, H2, ['--merge-commit']);
    const M2 = oidOf(fx2.main, 'refs/heads/main');
    check('41.2 --branch + --merge-commit 成功：退出码 0，父提交恰为 [B, H]，main = HEAD = M', r.status === 0 && git(fx2.main, ['rev-list', '--parents', '-n', '1', M2]).trim() === `${M2} ${B2} ${H2}` && oidOf(fx2.main, 'HEAD') === M2, { status: r.status, err: r.stderr.slice(0, 300) });
    const msg2 = git(fx2.main, ['log', '-1', '--format=%B', M2]).replace(/\r/g, '').replace(/\n+$/, '');
    check('41.2b 提交说明逐字：第一行 Merge branch feat/x into main (merge-commit mode)，空行，base: / head:', msg2 === `Merge branch feat/x into main (merge-commit mode)\n\nbase: ${B2}\nhead: ${H2}`, msg2);
    check('41.2c 树核对：主侧改动 = B 的、分支侧改动 = H 的，工作区干净；输出含「分支：feat/x」', oidOf(fx2.main, `${M2}:a.txt`) === oidOf(fx2.main, `${B2}:a.txt`) && oidOf(fx2.main, `${M2}:b.txt`) === oidOf(fx2.main, `${H2}:b.txt`)
        && oidOf(fx2.main, `${M2}:文档 目录/说明 1.txt`) === oidOf(fx2.main, `${H2}:文档 目录/说明 1.txt`) && cleanTracked(fx2) && r.stdout.includes('分支：feat/x') && r.stdout.includes('模式：merge-commit'));
    check('41.2d 登记表逐字节不变', sameDump(d2, dumpTree(fx2.control)));

    // 41.3 二选一与参数适用范围（用法错误，退出码 2；先过 parseArgv，「用法错误：」开头）
    const fx3 = await buildBranch('s41c');
    const H3 = branchCommit(fx3, { 'line-new.txt': 'new\n' });
    const before3 = snap(fx3);
    const usage = [
        ['线名与 --branch 同给', ['merge', 'line-a', '--branch', 'feat/x', '--base', fx3.B0, '--head', H3]],
        ['线名与 --branch 都不给', ['merge', '--base', fx3.B0, '--head', H3]],
        ['list 带 --branch', ['list', '--branch', 'feat/x']],
        ['new 带 --branch', ['new', 'x', '--module', 'm', '--surface', 's', '--branch', 'feat/x']],
        ['remove 带 --branch', ['remove', 'line-a', '--branch', 'feat/x']],
        ['--branch 缺取值', ['merge', '--base', fx3.B0, '--head', H3, '--branch']],
    ];
    for (const [label, args] of usage) {
        const u = cli(fx3, args);
        check(`41.3 ${label}：退出码 2，用法错误`, u.status === 2 && u.stderr.startsWith('用法错误：'), { status: u.status, err: u.stderr.slice(0, 200) });
    }
    check('41.3b 用法错误之后仓库什么都没变', sameSnap(before3, snap(fx3), 'strict'));
    // 41.3g 同一个取值参数重复给出（含 `--x v` 与 `--x=v` 混用）一律用法错误：静默取最后一个会让前面写的被悄悄忽略
    const LJ0 = () => lib('line.js');
    const dupCli = [
        ['--branch 重复（空格写法）：前一个不存在、后一个存在', ['merge', '--branch', 'nope', '--branch', 'feat/x', '--base', fx3.B0, '--head', H3], '--branch'],
        ['--branch 重复（= 与空格混用）', ['merge', '--branch=nope', '--branch', 'feat/x', '--base', fx3.B0, '--head', H3], '--branch'],
        ['--base 重复', ['merge', '--branch', 'feat/x', '--base', 'f'.repeat(40), '--base', fx3.B0, '--head', H3], '--base'],
        ['--head 重复', ['merge', '--branch', 'feat/x', '--base', fx3.B0, '--head', 'f'.repeat(40), '--head', H3], '--head'],
        ['--module 重复', ['new', 'x', '--module', 'm1', '--module=m2', '--surface', 's'], '--module'],
        ['--surface 重复', ['new', 'x', '--module', 'm', '--surface', 's1', '--surface', 's2'], '--surface'],
        ['--ready-timeout 重复', ['start', 'line-a', '--ready-timeout', '5', '--ready-timeout=6'], '--ready-timeout'],
    ];
    for (const [label, args, flag] of dupCli) {
        const u = cli(fx3, args);
        check(`41.3g ${label}：退出码 2，用法错误，点名 ${flag} 重复`, u.status === 2 && u.stderr.startsWith('用法错误：') && u.stderr.includes(`${flag} 重复给出`), { status: u.status, err: u.stderr.slice(0, 200) });
    }
    check('41.3h 重复给出之后（含「后一个能合入」的那条）仓库什么都没变：main 仍是 B', sameSnap(before3, snap(fx3), 'strict') && oidOf(fx3.main, 'refs/heads/main') === fx3.B0);
    const dupRoot = ['--control-root', '--lines-root', '--main-root'].map((f) => [f, LJ0().parseArgv(['list', f, 'a', `${f}=b`])]);
    check('41.3i 三个根覆盖参数重复给出：parseArgv 用法错误', dupRoot.every(([f, p]) => p.ok === false && p.error.includes(`${f} 重复给出`)), dupRoot);
    check('41.3j 不重复的正常用法不受影响：merge 线名 / --branch、new、start 带各一个取值参数', [['merge', 'x', '--base', 'a', '--head', 'b'], ['merge', '--branch=f', '--base=a', '--head=b'], ['new', 'x', '--module', 'm', '--surface', 's'], ['start', 'x', '--ready-timeout=5'], ['list', '--control-root', 'a', '--lines-root', 'b', '--main-root', 'c']]
        .every((a) => LJ0().parseArgv(a).ok === true));
    const ctxIn = { controlRoot: fx3.control, linesRoot: fx3.lines, mainRoot: fx3.main };
    assertTemp(fx3.main, fx3.lines, fx3.control);
    const inProc = async (args) => { try { await M.lineMerge(Object.assign({ out: () => {} }, ctxIn), args); return 'RESOLVED'; } catch (e) { return e && e.code; } };
    check('41.3c 进程内调用 lineMerge：name 与 branch 同给 → LINE_BAD_ARGS', await inProc({ name: 'line-a', branch: 'feat/x', base: fx3.B0, head: H3 }) === 'LINE_BAD_ARGS');
    check('41.3d 进程内调用 lineMerge：name 与 branch 都不给 → LINE_BAD_ARGS', await inProc({ base: fx3.B0, head: H3 }) === 'LINE_BAD_ARGS');
    check('41.3e 上面两次进程内拒绝之后仓库什么都没变', sameSnap(before3, snap(fx3), 'strict'));
    const LJ = lib('line.js');
    const okB = LJ.parseArgv(['merge', '--branch', 'feat/x', '--base', 'a', '--head', 'b', '--merge-commit']);
    check('41.3f parseArgv：--branch 入口解析（线名为空、branch/base/head/mergeCommit 就位）；线名 + --branch 同给不通过；USAGE 写明新入口',
        okB.ok && okB.name === undefined && okB.opts.branch === 'feat/x' && okB.opts.base === 'a' && okB.opts.head === 'b' && okB.opts.mergeCommit === true
        && LJ.parseArgv(['merge', 'x', '--branch', 'feat/x', '--base', 'a', '--head', 'b']).ok === false && LJ.USAGE.includes('merge --branch <分支名>'), okB);

    // 41.4 分支名不合格 / 不存在
    const fx4 = await buildBranch('s41d');
    const H4 = branchCommit(fx4, { 'line-new.txt': 'new\n' });
    git(fx4.main, ['tag', 'tagonly', H4]);   // 只有同名标签、没有本地分支
    const before4 = snap(fx4);
    const names = [
        ['分支不存在', 'nope', 'LINE_MERGE_NO_SUCH_BRANCH'], ['只有同名标签、没有本地分支', 'tagonly', 'LINE_MERGE_NO_SUCH_BRANCH'],
        ['refs/heads/feat/x 写法', 'refs/heads/feat/x', 'LINE_MERGE_BAD_BRANCH'], ['refs/tags/tagonly 写法', 'refs/tags/tagonly', 'LINE_MERGE_BAD_BRANCH'], ['-x（--branch=-x）', '-x', 'LINE_MERGE_BAD_BRANCH'],
        ['非法 ref 名：含 ..', 'a..b', 'LINE_MERGE_BAD_BRANCH'], ['非法 ref 名：含空格', 'a b', 'LINE_MERGE_BAD_BRANCH'], ['非法 ref 名：含 ~', 'a~1', 'LINE_MERGE_BAD_BRANCH'],
        ['非法 ref 名：.lock 结尾', 'x.lock', 'LINE_MERGE_BAD_BRANCH'], ['非法 ref 名：含 *', 'a*b', 'LINE_MERGE_BAD_BRANCH'],
    ];
    for (const [label, nm, code] of names) {
        const rr = cli(fx4, ['merge', `--branch=${nm}`, '--base', fx4.B0, '--head', H4]);
        rejected(`41.4 ${label}`, fx4, before4, rr, code);
    }

    // 41.5 line/ 前缀与 main（大小写不敏感）：已存在的分支 line/zz、LINE/yy 也拒绝；Main 不存在也先按名字拒绝。
    //   注：NTFS 上 refs/heads/line/ 目录已存在时，`git branch LINE/yy` 实际写成 refs/heads/line/yy（大小写折叠），所以第二个分支名在磁盘上是 line/yy；判别力不受影响（两个名字都在 line/ 前缀下）
    const fx5 = await buildBranch('s41e');
    const H5 = branchCommit(fx5, { 'line-new.txt': 'new\n' });
    git(fx5.main, ['branch', 'line/zz', H5]);
    git(fx5.main, ['branch', 'LINE/yy', H5]);
    const before5 = snap(fx5);
    for (const nm of ['line/zz', 'LINE/yy', 'Line/anything', 'main', 'Main', 'MAIN']) rejected(`41.5 ${nm}`, fx5, before5, cli(fx5, ['merge', `--branch=${nm}`, '--base', fx5.B0, '--head', H5]), 'LINE_MERGE_BAD_BRANCH');
    check('41.5b line/zz 与 LINE/yy 的提交没被合入（main 仍是 B）', oidOf(fx5.main, 'refs/heads/main') === fx5.B0);
    // 41.5c 纵深防御：登记线分支 line/zz 的提交 = H 时传 --branch=line（line 是 line/zz 的目录前缀）：名字就是 line → BAD_BRANCH（不是靠 branchTip 的精确比较才拒）
    rejected('41.5c 登记线 line/zz 指向 H 时传 --branch=line', fx5, before5, cli(fx5, ['merge', '--branch=line', '--base', fx5.B0, '--head', H5]), 'LINE_MERGE_BAD_BRANCH');
    // 41.5d 钉住 branchTip 的精确比较：只有 feat/x 指向 H 时传 --branch=feat（for-each-ref refs/heads/feat 会列出 refs/heads/feat/x）→ NO_SUCH_BRANCH，仓库不变
    const fx5d = await buildBranch('s41e2');
    const H5d = branchCommit(fx5d, { 'line-new.txt': 'new\n' });
    rejected('41.5d 只有 feat/x 指向 H 时传 --branch=feat', fx5d, snap(fx5d), cli(fx5d, ['merge', '--branch=feat', '--base', fx5d.B0, '--head', H5d]), 'LINE_MERGE_NO_SUCH_BRANCH');

    // 41.6 分支当前值 ≠ H
    const fx6 = await buildBranch('s41f');
    const H6 = branchCommit(fx6, { 'line-new.txt': 'new\n' });
    branchCommit(fx6, { 'line-new2.txt': 'new2\n' }, 'newer');
    const before6 = snap(fx6);
    const r6 = mergeBr(fx6, 'feat/x', fx6.B0, H6);
    rejected('41.6 分支已前进（分支 ≠ H）', fx6, before6, r6, 'LINE_MERGE_HEAD_MISMATCH');

    // 41.7 保留的核对没有被跳过（与线名入口共用同一路径）
    const fx7 = await buildBranch('s41g');
    const H7 = branchCommit(fx7, { 'line-new.txt': 'new\n' });
    await S.updateConfig(fx7.control, (c) => { c.integration_branch = 'develop'; });
    let b7 = snap(fx7);
    rejected('41.7a --branch 下 integration_branch = develop', fx7, b7, mergeBr(fx7, 'feat/x', fx7.B0, H7), 'LINE_MERGE_NOT_MAIN');
    await S.updateConfig(fx7.control, (c) => { c.integration_branch = 'main'; });

    const fx8 = await buildBranch('s41h');
    const H8 = branchCommit(fx8, { 'line-new.txt': 'new\n' });
    mainCommit(fx8, { 'README.md': 'readme v2\n' });
    rejected('41.7b --branch 下 main ≠ B', fx8, snap(fx8), mergeBr(fx8, 'feat/x', fx8.B0, H8), 'LINE_MERGE_MAIN_STATE');

    const fx9 = await buildBranch('s41i');
    const H9 = branchCommit(fx9, { 'line-new.txt': 'new\n' });
    w(path.join(fx9.main, 'README.md'), 'dirty\n');
    rejected('41.7c --branch 下主工作区有已跟踪文件改动', fx9, snap(fx9), mergeBr(fx9, 'feat/x', fx9.B0, H9), 'LINE_MERGE_DIRTY');

    const fx10 = await buildBranch('s41j');
    const H10 = branchCommit(fx10, { 'a.txt': `${nLines('a', 19)}a20-by-branch\n`, 'line-new.txt': 'new\n' });
    const B10 = mainCommit(fx10, { 'a.txt': `a1-by-main\n${nLines('a', 20).split('\n').slice(1).join('\n')}` });
    rejected('41.7d --branch + --merge-commit 两边都改 a.txt（交集）', fx10, snap(fx10), mergeBr(fx10, 'feat/x', B10, H10, ['--merge-commit']), 'LINE_MERGE_OVERLAP');

    const fx11 = await buildBranch('s41k', { ignore: IGN });
    const H11 = commitForce(fx11.bwt, { 'secret.env': 'FROM-BRANCH\n' }, 'force-added secret.env');
    w(path.join(fx11.main, 'secret.env'), 'REAL-SECRET\n');
    fx11.watch = ['secret.env'];
    const before11 = snap(fx11);   // codex 36 L1：快照取在调用之前
    const r11 = mergeBr(fx11, 'feat/x', fx11.B0, H11);
    rejected('41.7e --branch 下被忽略的同名文件（碰撞核对）', fx11, before11, r11, 'LINE_MERGE_UNTRACKED_COLLISION');
    check('41.7f secret.env 内容不变', rd(path.join(fx11.main, 'secret.env')) === 'REAL-SECRET\n');

    // 41.8 事后核对失败 / git 失败走同一份善后（--branch 下）
    const fx12 = await buildBranch('s41l');
    const H12 = branchCommit(fx12, { 'line-new.txt': 'new\n' });
    installHook(fx12, 'post-merge', HOOK_EXTRA_COMMIT);
    const d12 = dumpTree(fx12.control);
    const r12 = mergeBr(fx12, 'feat/x', fx12.B0, H12);
    failedWith('41.8 --branch 下事后核对失败（钩子又提交了一次）', r12, 'LINE_MERGE_POSTCHECK_FAILED');
    check('41.8b 不回滚（main 的父提交是 H），文案含人工回退指引；登记表逐字节不变', oidOf(fx12.main, `${oidOf(fx12.main, 'refs/heads/main')}^`) === H12 && r12.stderr.includes(`git reset --keep ${fx12.B0}`) && sameDump(d12, dumpTree(fx12.control)));

    // 41.9 登记表文件不存在：readState 返回空状态（integration_branch 为 null，按 main 处理），不新增回退——--branch 照常成功
    const fx13 = await buildBranch('s41m');
    const H13 = branchCommit(fx13, { 'line-new.txt': 'new\n' });
    const left13 = removeTree(fx13.control);
    check('41.9 夹具前提：控制根已移除', left13.length === 0 && !fs.existsSync(fx13.control), left13);
    const r13 = mergeBr(fx13, 'feat/x', fx13.B0, H13);
    check('41.9b 登记表不存在时 --branch 快进成功（integration_branch 缺省按 main）', r13.status === 0 && oidOf(fx13.main, 'refs/heads/main') === H13, { status: r13.status, err: r13.stderr.slice(0, 300) });
    check('41.9c 运行之后控制根仍然不存在（工具没有补建登记表 / 锁目录）', !fs.existsSync(fx13.control));
}

/**
 * 引导合入夹具（U13）：临时仓库 R 的 main 上没有工具；改造分支 feat/x 在 R 的一个 linked worktree W 里，分支上提交了被测工具副本（scripts/lines/*）。
 * W 里联接 wbs-server/node_modules 与 utils（工具按相对路径找它们；清理只拆联接本身）。脚本位于 W，所以 gitMainRoot(脚本所在检出) = R，与真实仓库无关。
 * 返回 fx（fx.main = R）并带 fx.W、fx.H（改造分支提交）、fx.B（main 上的提交，merge-commit 用）。
 */
async function buildBootstrap(label) {
    const fx = await build(label);
    fx.W = path.join(fx.root, '改造 工作区');
    git(fx.main, ['worktree', 'add', '-q', '-b', 'feat/x', fx.W, fx.B0]);
    const dst = path.join(fx.W, 'scripts', 'lines');
    fs.mkdirSync(dst, { recursive: true });
    for (const n of fs.readdirSync(LINES_DIR)) if (fs.lstatSync(path.join(LINES_DIR, n)).isFile()) fs.copyFileSync(path.join(LINES_DIR, n), path.join(dst, n));
    git(fx.W, ['add', '-A']);
    git(fx.W, ['commit', '-q', '-m', 'branch carries the tool']);
    fx.H = oidOf(fx.W, 'HEAD');
    fx.B = mainCommit(fx, { 'README.md': 'readme v2\n' }, 'main side');
    // 提交之后再放联接（联接不进提交）
    fs.mkdirSync(path.join(fx.W, 'wbs-server'), { recursive: true });
    for (const n of ['node_modules', 'utils']) fs.symlinkSync(path.join(__dirname, '..', n), path.join(fx.W, 'wbs-server', n), 'junction');
    check(`${label} 夹具前提：R 的 main 上没有 scripts/lines/，改造分支上有`, git(fx.main, ['ls-tree', '-r', '--name-only', 'refs/heads/main', '--', 'scripts/lines']).trim() === ''
        && git(fx.main, ['ls-tree', '-r', '--name-only', fx.H, '--', 'scripts/lines']).includes('scripts/lines/line.js') && !fs.existsSync(path.join(fx.main, 'scripts', 'lines')));
    return fx;
}
/** 从 W 里的脚本副本运行，不带任何根覆盖参数（控制根 / 线目录根 / .env 都由主工作区按默认规则求出）。 */
function runFromW(fx, args, dir) {
    const base = dir || fx.W;
    assertTemp(fx.main, base);
    const r = spawnSync(process.execPath, [path.join(base, 'scripts', 'lines', 'line.js'), ...args], { cwd: base, env: cleanEnv(), encoding: 'utf8', timeout: 180000, windowsHide: true });
    return { status: r.error ? null : r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error ? r.error.message : null };
}

async function sec42() {
    section('42', 'U13 引导合入：main 上没有工具时，linked worktree 里的 line.js 只对 merge --branch 就地运行；其余情形不变');
    const NOTE = '主工作区没有 scripts/lines/line.js：按引导合入就地运行（仅 merge --branch）';
    // 42.1 成功
    const fx = await buildBootstrap('42.0');
    const r = runFromW(fx, ['merge', '--branch', 'feat/x', '--base', fx.B, '--head', fx.H, '--merge-commit']);
    const M2 = oidOf(fx.main, 'refs/heads/main');
    check('42.1 就地运行 merge --branch --merge-commit 成功：退出码 0，父提交恰为 [B, H]，R 的 main = HEAD = M', r.status === 0 && git(fx.main, ['rev-list', '--parents', '-n', '1', M2]).trim() === `${M2} ${fx.B} ${fx.H}` && oidOf(fx.main, 'HEAD') === M2, { status: r.status, err: r.stderr.slice(0, 400) });
    check('42.1b 输出含就地运行说明、「分支：feat/x」、合入后 main', r.stdout.includes(NOTE) && r.stdout.includes('分支：feat/x') && r.stdout.includes(`合入后 main：${M2}`), r.stdout);
    check('42.1c 合入的是主工作区自己的仓库 R：R 的工作区里出现了 scripts/lines/line.js，已跟踪文件干净；控制根（按主工作区默认规则）没有被创建',
        fs.existsSync(path.join(fx.main, 'scripts', 'lines', 'line.js')) && cleanTracked(fx) && !fs.existsSync(path.join(fx.main, 'docs', 'local', '多线并行', '_state')));
    const msg = git(fx.main, ['log', '-1', '--format=%B', M2]).replace(/\r/g, '').replace(/\n+$/, '');
    check('42.1d 提交说明第一行 Merge branch feat/x into main (merge-commit mode)', msg.split('\n')[0] === 'Merge branch feat/x into main (merge-commit mode)', msg);

    // 42.2 对照：线名入口（merge <线名>）不就地运行：退出 1，R 什么都没变
    const fx2 = await buildBootstrap('42.0b');
    let before = snap(fx2);
    let rr = runFromW(fx2, ['merge', 'line-a', '--base', fx2.B, '--head', fx2.H, '--merge-commit']);
    check('42.2 线名入口：退出码 1，仍报「主工作区里没有 scripts/lines/line.js」，没有输出就地运行说明', rr.status === 1 && rr.stderr.includes('主工作区里没有 scripts/lines/line.js') && !rr.stdout.includes(NOTE), { status: rr.status, err: rr.stderr.slice(0, 300) });
    check('42.2b R 什么都没变', sameSnap(before, snap(fx2), 'strict') && !fs.existsSync(path.join(fx2.main, 'scripts', 'lines')));
    // 42.3 对照：list
    rr = runFromW(fx2, ['list']);
    check('42.3 list：退出码 1，仍报「主工作区里没有 scripts/lines/line.js」', rr.status === 1 && rr.stderr.includes('主工作区里没有 scripts/lines/line.js') && !rr.stdout.includes(NOTE), { status: rr.status, err: rr.stderr.slice(0, 300) });
    check('42.3b R 什么都没变', sameSnap(before, snap(fx2), 'strict'));
    // 42.4 对照：merge --branch 但 argv 解析失败（缺 --head）→ 不就地运行
    rr = runFromW(fx2, ['merge', '--branch', 'feat/x', '--base', fx2.B]);
    check('42.4 argv 解析不过（merge --branch 缺 --head）：退出码 1，不就地运行', rr.status === 1 && rr.stderr.includes('主工作区里没有 scripts/lines/line.js') && !rr.stdout.includes(NOTE) && sameSnap(before, snap(fx2), 'strict'), { status: rr.status, err: rr.stderr.slice(0, 300) });

    // 42.5 对照：R 的主工作区存在 line.js 时照常转发（放一个只打印标记的 line.js，确实被转发执行）
    const fx3 = await buildBootstrap('42.0c');
    w(path.join(fx3.main, 'scripts', 'lines', 'line.js'), "console.log('FORWARDED-MARKER ' + process.argv.slice(2).join(' '));\n");
    before = snap(fx3);
    rr = runFromW(fx3, ['merge', '--branch', 'feat/x', '--base', fx3.B, '--head', fx3.H, '--merge-commit']);
    check('42.5 主工作区有 line.js：照常转发（标记行出现，参数原样透传），没有就地运行', rr.status === 0 && rr.stdout.includes('FORWARDED-MARKER merge --branch feat/x --base') && !rr.stdout.includes(NOTE), { status: rr.status, out: rr.stdout.slice(0, 300), err: rr.stderr.slice(0, 300) });
    check('42.5b 转发时 R 什么都没变（merge 没有执行）', oidOf(fx3.main, 'refs/heads/main') === fx3.B);

    // 42.6 控制根取的是主工作区的默认控制根，不是脚本所在检出的：R 主工作区的默认控制根里登记 integration_branch = develop → 就地运行报 NOT_MAIN
    //   （若控制根误取脚本所在检出下的 docs/local/多线并行/_state，那里没有登记表 → 空状态 → 照常合入）
    const fx6 = await buildBootstrap('42.0d');
    const ctl6 = path.join(fx6.main, 'docs', 'local', '多线并行', '_state');
    fs.mkdirSync(ctl6, { recursive: true });
    await S.updateConfig(ctl6, (c) => { c.integration_branch = 'develop'; });
    const dump6 = dumpTree(ctl6);
    const before6 = snap(fx6);
    const r6 = runFromW(fx6, ['merge', '--branch', 'feat/x', '--base', fx6.B, '--head', fx6.H, '--merge-commit']);
    rejected('42.6 主工作区默认控制根里 integration_branch = develop', fx6, before6, r6, 'LINE_MERGE_NOT_MAIN');
    check('42.6b 就地运行说明已输出（走的就是就地运行路径）；登记表逐字节不变', r6.stdout.includes(NOTE) && sameDump(dump6, dumpTree(ctl6)), r6.stdout);

    // 42.7 .env 取的是主工作区的 wbs-server/.env（脱敏器按它建立）：放一个假密钥，传同名不存在的分支（报错会回显分支名）→ 回显被脱敏，原文不出现
    const fx7 = await buildBootstrap('42.0e');
    const secret = `zq${require('crypto').randomBytes(6).toString('hex')}`;
    // 临时仓库 R 里的假 .env（只写随机假密钥）。字面量照写、不拼接绕开隔离静态守卫的 T2：本文件因此与同族 lines 自检一样登记 INFRA（S7b，主会话裁定）
    w(path.join(fx7.main, 'wbs-server', '.env'), `FAKE_PROBE_TOKEN=${secret}\n`);
    const before7 = snap(fx7);
    const r7 = runFromW(fx7, ['merge', '--branch', secret, '--base', fx7.B, '--head', fx7.H, '--merge-commit']);
    rejected('42.7 假密钥作分支名（分支不存在）', fx7, before7, r7, 'LINE_MERGE_NO_SUCH_BRANCH');
    check('42.7b stderr 含「[已脱敏]」且不含原文', r7.stderr.includes('[已脱敏]') && !r7.stderr.includes(secret) && !r7.stdout.includes(secret), r7.stderr.slice(0, 300));

    // 42.8–42.10 就地运行的两道硬门（调 lineMerge 之前；固定文案，退出 1，R 不变）
    // 42.8 脚本所在检出的 HEAD ≠ --head（检出里又提交了一次，分支也跟着前进；--head 仍是旧的 H）
    const fx8 = await buildBootstrap('42.0f');
    git(fx8.W, ['commit', '-q', '--allow-empty', '-m', 'checkout moved past H']);
    const before8 = snap(fx8);
    const r8 = runFromW(fx8, ['merge', '--branch', 'feat/x', '--base', fx8.B, '--head', fx8.H, '--merge-commit']);
    rejected('42.8 脚本所在检出的 HEAD ≠ H', fx8, before8, r8, 'LINE_INPLACE_NOT_AT_HEAD');
    check('42.8b 没有输出就地运行说明（门在说明之前）', !r8.stdout.includes(NOTE), r8.stdout);
    // 42.9 脚本所在检出有已跟踪改动
    const fx9 = await buildBootstrap('42.0g');
    w(path.join(fx9.W, 'README.md'), 'dirty in the script checkout\n');
    const before9 = snap(fx9);
    const r9 = runFromW(fx9, ['merge', '--branch', 'feat/x', '--base', fx9.B, '--head', fx9.H, '--merge-commit']);
    rejected('42.9 脚本所在检出有已跟踪改动', fx9, before9, r9, 'LINE_INPLACE_DIRTY');
    // 42.9b 无法确认干净（脚本所在检出的索引写坏，git status 失败而 rev-parse HEAD 仍可用）→ 同样拒绝，不放行
    const fx9b = await buildBootstrap('42.0g2');
    fs.writeFileSync(path.resolve(fx9b.W, git(fx9b.W, ['rev-parse', '--git-path', 'index']).trim()), 'garbage\n');
    const before9b = snap(fx9b);
    const r9b = runFromW(fx9b, ['merge', '--branch', 'feat/x', '--base', fx9b.B, '--head', fx9b.H, '--merge-commit']);
    rejected('42.9b 脚本所在检出的索引写坏（git status 失败）', fx9b, before9b, r9b, 'LINE_INPLACE_DIRTY');
    check('42.9c 文案点明「无法确认」', r9b.stderr.includes('无法确认'), r9b.stderr.slice(0, 300));
    // 42.9d 只有已暂存改动（改了工具文件并 git add，未暂存 diff 为空）→ 同样拒绝：运行的工具不是要合入的那一版（v3 预筛 LOW-1；只看未暂存 diff 的写法会放行）
    const fx9d = await buildBootstrap('42.0g3');
    const toolInW = path.join(fx9d.W, 'scripts', 'lines', 'line-merge.js');
    fs.appendFileSync(toolInW, '// staged-only edit in the script checkout\n');
    git(fx9d.W, ['add', '--', 'scripts/lines/line-merge.js']);
    const before9d = snap(fx9d);
    const r9d = runFromW(fx9d, ['merge', '--branch', 'feat/x', '--base', fx9d.B, '--head', fx9d.H, '--merge-commit']);
    rejected('42.9d 脚本所在检出只有已暂存改动', fx9d, before9d, r9d, 'LINE_INPLACE_DIRTY');
    // 42.10 P3 形状：工具副本放在主工作区的未跟踪子目录里（decideForward 也判为需要转发；该检出的 HEAD = B ≠ H）
    const fx10 = await buildBootstrap('42.0h');
    const sub = path.join(fx10.main, '_tmpcopy');
    fs.mkdirSync(path.join(sub, 'scripts', 'lines'), { recursive: true });
    for (const n of fs.readdirSync(LINES_DIR)) if (fs.lstatSync(path.join(LINES_DIR, n)).isFile()) fs.copyFileSync(path.join(LINES_DIR, n), path.join(sub, 'scripts', 'lines', n));
    fs.mkdirSync(path.join(sub, 'wbs-server'), { recursive: true });
    for (const n of ['node_modules', 'utils']) fs.symlinkSync(path.join(__dirname, '..', n), path.join(sub, 'wbs-server', n), 'junction');
    // 联接进主工作区子目录的 node_modules 有几千个文件；快照里的 `status --untracked-files=all --ignored` 会逐个列出，超过 spawnSync 的默认 maxBuffer 被截断（输出 ERR，截断点每次不同
    // → 快照比较偶发不等，实测两次复现）。本夹具的快照里 status 只比已跟踪状态（其余：main / HEAD / 全部 refs / 进行中标记 / index.lock / MERGE_MSG / ORIG_HEAD 照比），下面另外断言工具没有被合入
    fx10.noStatus = true;
    const before10 = snap(fx10);
    const r10 = runFromW(fx10, ['merge', '--branch', 'feat/x', '--base', fx10.B, '--head', fx10.H, '--merge-commit'], sub);
    rejected('42.10 工具副本在主工作区未跟踪子目录里（HEAD = B ≠ H）', fx10, before10, r10, 'LINE_INPLACE_NOT_AT_HEAD');
    check('42.10b R 的 main 仍是 B，工具没有被合入', oidOf(fx10.main, 'refs/heads/main') === fx10.B && !fs.existsSync(path.join(fx10.main, 'scripts', 'lines', 'line.js')));
    // 42.11 codex 36 M1：工具副本放在 HEAD = H 的检出（W）的未跟踪子目录里，副本内容做了无害修改（不是 H 的那一版）。HEAD 门（HEAD = H）与干净门（不计未跟踪）都看不到它 → 由「脚本必须在检出根上」拒绝
    const fx11b = await buildBootstrap('42.0i');
    const sub11 = path.join(fx11b.W, '_tmpcopy');
    fs.mkdirSync(path.join(sub11, 'scripts', 'lines'), { recursive: true });
    for (const n of fs.readdirSync(LINES_DIR)) if (fs.lstatSync(path.join(LINES_DIR, n)).isFile()) fs.copyFileSync(path.join(LINES_DIR, n), path.join(sub11, 'scripts', 'lines', n));
    fs.appendFileSync(path.join(sub11, 'scripts', 'lines', 'line-merge.js'), '// untracked copy, not the reviewed H version\n');
    fs.mkdirSync(path.join(sub11, 'wbs-server'), { recursive: true });
    for (const n of ['node_modules', 'utils']) fs.symlinkSync(path.join(__dirname, '..', n), path.join(sub11, 'wbs-server', n), 'junction');
    check('42.11 夹具前提：W 的 HEAD = H，W 的已跟踪文件干净', oidOf(fx11b.W, 'HEAD') === fx11b.H && git(fx11b.W, ['status', '--porcelain=v1', '--untracked-files=no']).trim() === '');
    const before11b = snap(fx11b);
    const r11b = runFromW(fx11b, ['merge', '--branch', 'feat/x', '--base', fx11b.B, '--head', fx11b.H, '--merge-commit'], sub11);
    rejected('42.11 工具副本在 HEAD = H 的检出的未跟踪子目录里', fx11b, before11b, r11b, 'LINE_INPLACE_NOT_TOPLEVEL');
    check('42.11b R 的 main 仍是 B，没有输出就地运行说明', oidOf(fx11b.main, 'refs/heads/main') === fx11b.B && !r11b.stdout.includes(NOTE), r11b.stdout);
    // 42.12 codex 36-R M1：H 本身不跟踪工具，工具是 W 根上 scripts/lines/ 里的未跟踪文件（前三道门都成立：HEAD = H、脚本在检出根上、已跟踪文件干净）→ 由「工具文件都被 HEAD 跟踪」拒绝
    const fx12 = await buildBootstrap('42.0j');
    git(fx12.W, ['rm', '-r', '-q', '--cached', '--', 'scripts/lines']);
    git(fx12.W, ['commit', '-q', '-m', 'untrack the tool (files stay on disk)']);
    const H12 = oidOf(fx12.W, 'HEAD');
    check('42.12 夹具前提：W 的 HEAD = 分支 = H12、H12 不跟踪 scripts/lines、工具文件仍在 W 根上、已跟踪文件干净',
        oidOf(fx12.main, 'refs/heads/feat/x') === H12 && git(fx12.W, ['ls-files', '--', 'scripts/lines']).trim() === ''
        && fs.existsSync(path.join(fx12.W, 'scripts', 'lines', 'line.js')) && git(fx12.W, ['status', '--porcelain=v1', '--untracked-files=no']).trim() === '');
    const before12 = snap(fx12);
    const r12 = runFromW(fx12, ['merge', '--branch', 'feat/x', '--base', fx12.B, '--head', H12, '--merge-commit']);
    rejected('42.12 H 不跟踪工具、W 根上是未跟踪副本', fx12, before12, r12, 'LINE_INPLACE_UNTRACKED_TOOL');
    check('42.12b R 的 main 仍是 B，没有输出就地运行说明', oidOf(fx12.main, 'refs/heads/main') === fx12.B && !r12.stdout.includes(NOTE), r12.stdout);
    // 42.13 codex 36-R2 M1：H 跟踪工具，但 W 的 scripts/lines/ 里残留一个未跟踪的目录模块（require 可解析目录入口）→ 由「scripts/lines/ 下不得有未跟踪项」拒绝
    const fx13b = await buildBootstrap('42.0k');
    fs.mkdirSync(path.join(fx13b.W, 'scripts', 'lines', 'stale-module'), { recursive: true });
    w(path.join(fx13b.W, 'scripts', 'lines', 'stale-module', 'index.js'), 'module.exports = {};\n');
    check('42.13 夹具前提：W 的 HEAD = H、已跟踪文件干净、line.js 被跟踪', oidOf(fx13b.W, 'HEAD') === fx13b.H && git(fx13b.W, ['status', '--porcelain=v1', '--untracked-files=no']).trim() === ''
        && git(fx13b.W, ['ls-files', '--', 'scripts/lines/line.js']).trim() === 'scripts/lines/line.js');
    const before13b = snap(fx13b);
    const r13b = runFromW(fx13b, ['merge', '--branch', 'feat/x', '--base', fx13b.B, '--head', fx13b.H, '--merge-commit']);
    rejected('42.13 W 的 scripts/lines/ 里有未跟踪的目录模块', fx13b, before13b, r13b, 'LINE_INPLACE_UNTRACKED_TOOL');
    check('42.13b R 的 main 仍是 B，没有输出就地运行说明', oidOf(fx13b.main, 'refs/heads/main') === fx13b.B && !r13b.stdout.includes(NOTE), r13b.stdout);
    // 42.14 被忽略的项也算：W 的 info/exclude 忽略 *.cjs，scripts/lines/ 里放一个被忽略的 helper.cjs（require 可加载）→ 同样拒绝
    const fx14 = await buildBootstrap('42.0l');
    const excl = path.resolve(fx14.W, git(fx14.W, ['rev-parse', '--git-path', 'info/exclude']).trim());
    fs.mkdirSync(path.dirname(excl), { recursive: true });
    fs.appendFileSync(excl, '\n*.cjs\n');
    w(path.join(fx14.W, 'scripts', 'lines', 'helper.cjs'), 'module.exports = {};\n');
    check('42.14 夹具前提：helper.cjs 被忽略（不在 --exclude-standard 的未跟踪列表里）', git(fx14.W, ['ls-files', '-o', '--exclude-standard', '--', 'scripts/lines']).trim() === ''
        && git(fx14.W, ['ls-files', '-o', '--', 'scripts/lines']).includes('helper.cjs'));
    const before14 = snap(fx14);
    const r14 = runFromW(fx14, ['merge', '--branch', 'feat/x', '--base', fx14.B, '--head', fx14.H, '--merge-commit']);
    rejected('42.14 W 的 scripts/lines/ 里有被忽略的文件', fx14, before14, r14, 'LINE_INPLACE_UNTRACKED_TOOL');
}

// ---------------------------------------------------------------- 主流程

const SECTIONS = [[1, sec1], [2, sec2], [3, sec3], [4, sec4], [5, sec5], [6, sec6], [7, sec7], [8, sec8], [9, sec9], [10, sec10], [11, sec11], [12, sec12], [13, sec13],
    [14, sec14], [15, sec15], [16, sec16], [17, sec17], [18, sec18], [19, sec19], [20, sec20], [21, sec21], [22, sec22], [23, sec23], [24, sec24], [25, sec25],
    [26, sec26], [27, sec27], [28, sec28], [29, sec29], [30, sec30], [31, sec31], [32, sec32], [33, sec33],
    [34, sec34], [35, sec35], [36, sec36], [37, sec37], [38, sec38], [39, sec39], [40, sec40], [41, sec41], [42, sec42]];

async function main() {
    console.log(`verify-lines-merge：被测目录 ${LINES_DIR}`);
    fs.writeFileSync(GIT_EMPTY_CONFIG, '');
    for (const [id, fn] of SECTIONS) {
        if (!want(id)) continue;
        try { await fn(); } catch (e) { check(`${id}.EXC 章节抛出未预期的异常`, false, String(e && e.stack ? e.stack : e).slice(0, 600)); }
    }
    section('99', '临时目录清理');
    const left = [];
    for (const root of ALL_ROOTS) left.push(...removeTree(root));
    try { fs.unlinkSync(GIT_EMPTY_CONFIG); } catch (e) { left.push(GIT_EMPTY_CONFIG); }
    check('99.1 临时目录逐项清理，无残留', left.length === 0, left.slice(0, 5));
    console.log(`\n汇总：PASS=${PASS} FAIL=${FAIL}`);
    if (FAIL > 0) { console.log(`失败项：${FAILS.join(' | ')}`); process.exitCode = 1; }
}

main().then(() => {}, (e) => { console.log(`未处理异常：${e && e.stack ? e.stack : e}`); process.exitCode = 1; });
