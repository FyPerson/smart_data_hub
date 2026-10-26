/**
 * line merge（#106 多线并行改造 · S7 · 方案 v1.4 W8 第 4 步「快进 + --merge-commit」）
 *
 *   node scripts/lines/line.js merge <线名> --base <B> --head <H> [--merge-commit]
 *   node scripts/lines/line.js merge --branch <分支名> --base <B> --head <H> [--merge-commit]   （S7b，U10 = A：合入一个不是登记线的本地分支，如 B1 的改造分支 feat/multi-line-106）
 *
 * --branch 入口：<线名> 与 --branch 二选一（都给 / 都不给 = LINE_BAD_ARGS，退出码 2）。只收分支短名，统一拼成 refs/heads/<名>（不经 git 的短名消歧，同名标签 / 远程分支撞不上）：
 *   非空、不以 - 开头、不以 refs/ 开头，git check-ref-format refs/heads/<名> 通过，不以 line/ 开头、不等于 main、不等于 line（后几项大小写不敏感；登记线必须走线名入口，否则四项登记核对被绕过）——不符报 LINE_MERGE_BAD_BRANCH；
 *   refs/heads/<名> 不存在（含只有同名标签）报 LINE_MERGE_NO_SUCH_BRANCH；当前值 ≠ H 报 LINE_MERGE_HEAD_MISMATCH。
 *   跳过线名入口的四项登记核对（线记录存在、登记分支 = line/<线名>、登记 worktree 路径与 HEAD、lifecycle = ready）；integration_branch 仍读登记表核对（登记表文件不存在时按 readState 的行为——空状态，null 视为 main，不新增回退）。
 *   其余核对（B/H 形态、主工作区、进行中标记、干净口径、模式核对含目录前缀交集、碰撞核对、ORIG_HEAD、事后核对、git 失败只读善后）与线名入口共用同一条代码路径；工具唯一的 git 写操作仍然只有 git merge。
 *   merge-commit 提交说明第一行 `Merge branch <分支名> into main (merge-commit mode)`；成功输出把「线名：」换成「分支：<名>」。
 *
 * 只在用户在场时于主工作区运行；--base / --head 按完整提交号，不接受分支名 / 缩写 / 标签（--branch 的取值是合入目标的分支短名，不是 B / H）。只读登记表（readState），不持线级锁、不写登记表；
 * git 调用经 line-common 的 gitTry / gitInput（cleanGitEnv，不经 shell）：cwd 都是主工作区根，唯一例外是核对线 worktree 的 HEAD 时在线 worktree 里执行 `rev-parse HEAD`。
 *
 * 前置核对（任一不符即拒绝，退出码 1，仓库不留任何改动；错误码以 LINE_MERGE_ 开头，例外：LINE_BAD_ARGS〔退出码 2；线名非法、线名与 --branch 二选一不满足、--branch 空值〕、读登记表时 state.js 抛出的 STATE_*）：
 *   1 B、H 是完整 40 位小写十六进制，且 `rev-parse --verify --quiet <X>^{commit}` 与其逐字相等；B ≠ H
 *   2 登记表里有这条线（线名不分大小写）且 lifecycle 为 ready；登记的分支是 line/<线名>、refs/heads/<分支> 当前值 = H；登记的 worktree 是 <线目录根>/<线名>，存在时其 HEAD 也 = H
 *   3 登记表 config.integration_branch（缺省 main）必须是字面 main
 *   4 主工作区：symbolic-ref HEAD = refs/heads/main（分离头指针 / 别的分支都拒绝）；refs/heads/main = B 且 HEAD = B
 *   5 主工作区没有进行中的操作：MERGE_HEAD / CHERRY_PICK_HEAD / REVERT_HEAD / rebase-merge / rebase-apply / BISECT_LOG / sequencer，也没有 index.lock（路径都用 rev-parse --git-path 取；
 *       sequencer 是多提交 cherry-pick / revert 的待办目录：首个冲突解决后手动 git commit，CHERRY_PICK_HEAD 就消失了，但后续步骤还留在 sequencer 里，已跟踪文件又是干净的，只看 *_HEAD 会漏掉）
 *   6 主工作区「干净」的口径：`git --no-optional-locks status --porcelain=v1 -z --untracked-files=no --no-renames --ignore-submodules=none` 输出为空——已跟踪文件无改动、无暂存（命令行显式参数，
 *       不受 status.* / diff.ignoreSubmodules / submodule.<名>.ignore 等配置影响）。
 *       **未跟踪文件不计入**（主工作区长期有既有遗留的未跟踪文件）。git 只拒绝覆盖「未被忽略的」未跟踪文件（实测：快进加 --no-overwrite-ignore 才拒绝被忽略的同名文件，--no-ff 在 git 2.43 下
 *       加了也照样覆盖），被忽略的同名文件（.env、*.db 一类）由第 7b 步前置核对拒绝。
 *   7 快进（默认）：B 必须是 H 的祖先，否则拒绝并提示先 rebase；
 *     --merge-commit：H 不能是 B 的祖先；merge-base 恰有一个（没有共同祖先或有多个都拒绝）；主侧改动集 PB = diff-tree(MB, B)、线侧改动集 PH = diff-tree(MB, H)（-r -z --name-only --no-renames --ignore-submodules=none），
 *       PB 与 PH 有交集即拒绝（合并结果没被任何一边验证过）；交集按小写比较（本机文件系统大小写不敏感，只差大小写的两个路径落到磁盘上是同一个文件），只拒不放行；
 *       另外拒绝任一方向的「目录前缀关系」（小写后 a === b，或 a 以 b + '/' 开头，或反过来）：共同祖先没有 d，主侧新增 d/x、线侧新增文件 d 时，PB = {d/x}、PH = {d} 没有字符串交集，
 *       但 git 做文件 / 目录冲突处理时会把线侧文件移到辅助路径 d~<H 的完整提交号>（git 2.43 实测，见 35a-H1 复现）——这个路径不在任何改动集里、没经过碰撞核对，
 *       并且会直接覆盖主工作区里被忽略的同名文件。错误码沿用 LINE_MERGE_OVERLAP，文案点明「一侧是文件、另一侧是同名目录下的路径」。快进没有主侧改动，不涉及。
 *   7b 覆盖未跟踪 / 被忽略文件的前置核对（LINE_MERGE_UNTRACKED_COLLISION）：W = 本次合并会写入、且 B 的树里没有的路径（快进：diff-tree(B, H) 里 B 树里不存在的；merge-commit：PH 里 B 树里不存在的；
 *       「B 树里有没有」用 `ls-tree -r -t -z --full-tree B` 带条目类型判：blob / 符号链接 = 已跟踪文件，不进 W；commit = gitlink，仅当 H 里它也是 gitlink〔单侧改指针〕才不算碰撞，被换成文件 / 目录 / 删除一律拒绝；
 *       查不到明确类型按「没有」处理〔fail-closed〕）。对 W 的每个路径在主工作区逐级 lstat（Windows 上父路径是文件时整条路径报 ENOENT 而非 ENOTDIR，所以不能只看整条）：某一级 ENOENT 才通过，路径存在、某一级父路径不是普通目录、或任何别的错误都拒绝；
 *       目录换文件（D/F）：候选路径 p 在 B 里是目录、在 H 里不再是目录（diff-tree 不带 -t，只列叶子，目录换文件表现为 p〔新文件〕+ p/xxx〔删除〕）→ 要求 p/ 之下没有未跟踪（`ls-files -o --exclude-standard`）
 *       也没有被忽略（`ls-files -o -i --exclude-standard --directory`）的项（路径用 `:(literal)p/` 按字面传），否则拒绝——merge-commit 下 git 不拦、快进也只靠 --no-overwrite-ignore，目录里的被忽略文件会被静默删掉。
 *       文案只列路径、不回显文件内容。快进另加 --no-overwrite-ignore 兜底（merge-commit 下该参数在 git 2.43 无效，不加）；它与上面的核对是两层防线，只有前置核对之后、git merge 之前有并发写入时才起作用（自检 33 用 fsmonitor 钩子在 git merge 自己的那次调用里造出被忽略文件来钉住它）。
 *       已知保守面：①线把「文件 x」换成「目录 x/」时，x/y 的逐级 lstat 因父路径是已跟踪文件被判 blocked，也会被拒绝（只拒不放行，人工处理）；
 *       ②（L-b）线只把文件名改大小写（git mv notes.txt NOTES.txt）时，新路径 NOTES.txt 不在 B 的树里、lstat 又命中本次要删除的已跟踪 notes.txt（NTFS 大小写不敏感），会被同一错误码拒绝，文案已提示这种情形；
 *       裸 git 能直接快进，本工具不放行（放过某种情形等于加智能放行），请手动合并。
 *   合并前再取一份「未跟踪路径集合」：`ls-files -o --exclude-standard -z`（未被忽略的未跟踪文件，逐个）∪ `ls-files -o -i --exclude-standard --directory -z`（被忽略的未跟踪项，整目录折叠，
 *       不逐个展开 node_modules 这类大目录）。选这个口径而不是 `status --ignored` 的理由：status 在 --ignored 下要么折叠未跟踪目录（漏掉目录里新增的文件）、要么把被忽略目录逐个展开（体量不可控）。
 * 执行：快进 `git merge --ff-only --no-overwrite-ignore H`；--merge-commit `git -c merge.directoryRenames=false merge --no-ff --no-edit -m <消息> H`（消息第一行 `Merge line <线名> into main (merge-commit mode)`，空一行后 `base: <B>` / `head: <H>`）。
 *   merge-commit 钉死 merge.directoryRenames=false（L-e）的理由：本工具按路径建模（交集核对和 verifyMergeTree 都按「主侧改动路径集 PB / 线侧改动路径集 PH」判断）；用户配置成 true 时 ort 会把线侧新增的文件
 *       挪到主侧整目录改名后的新目录，落在 PH 之外的路径上，不经碰撞核对；默认值 conflict 则在这种场景下冲突退出、留下合并中状态。钉成 false 后按路径合并，与模型一致，拒绝面不扩（自检 32）。快进不需要。
 *   工具唯一的 git 写操作是 git merge 本身；失败与事后核对不通过时一律不自动修复（不 abort、不 reset），交人工。威胁模型：main 只由在场的合入写入，并发写 main 不在常规使用中出现，残余靠 ORIG_HEAD 核对检测。
 *   git 成功返回后先核对合并起点：ORIG_HEAD 必须等于 B（git merge 每次调用都把调用开始时的 HEAD 记入 ORIG_HEAD；不等于 B 说明 main 在前置核对与 git merge 之间被别人动过）；不符报 LINE_MERGE_STATE_UNKNOWN，不修。
 *   git 失败（只读善后）：有 MERGE_HEAD（git 留下合并中状态）→ 不 abort、原样保留，报 LINE_MERGE_GIT_FAILED_IN_PROGRESS（文案含 git 的 stderr 摘要、B、当前 main / HEAD、人工指引：先核对 main 仍是 B，再 git merge --abort；
 *       main 已不是 B 时先查 reflog）；没有 MERGE_HEAD → 核 main = B、HEAD = B、干净口径为空、没有新增的未跟踪路径、合并前存在的未跟踪路径没有消失、没有 index.lock——都成立报 LINE_MERGE_GIT_FAILED，
 *       任一不成立报 LINE_MERGE_STATE_UNKNOWN（残留文件原样保留）。
 * 事后核对（全部通过才成功）：快进 main = HEAD = H 且干净；merge-commit 新提交 M = main = HEAD，父提交恰为 [B, H]，树核对（见 verifyMergeTree）且干净。成功输出的「合入后 main」用事后核对读到的值。
 *   事后核对失败（含核对本身出错）：不做任何 git 写操作、不回滚，报 LINE_MERGE_POSTCHECK_FAILED（退出码 1）；文案写明「合并已执行，但事后核对不通过；本工具没有回滚」、B / H / 当前 main / 当前 HEAD、
 *       不符项，以及人工回退指引（先核对 main 确实是本次合并的产物，再 `git reset --keep <B>`；被移走的提交可从 reflog 找回）。决定不自动回滚的理由：回滚本身与并发写入无法原子化，
 *       「复读—reset—复核」的任何兜底都留有把别人的提交撤离 main 的窗口（预筛 HIGH-1、HIGH-N1 连续两轮），用户裁定（U11 = A）整段删除，交人工。
 *
 * 残余（登记，不处置）：①测试夹具里 core.autocrlf 与用户实际配置可能不同，行尾相关的 status 差异只在真实配置下才暴露；
 *   ②前置核对与 git merge 之间的窗口无法原子化——由 ORIG_HEAD 核对兜底（不符报 STATE_UNKNOWN）；事后核对失败一律不回滚、交人工；
 *   ③ORIG_HEAD 核对依赖 git 对 ORIG_HEAD 的改写语义（git 2.43 实测，见 checkMergeOrigin 注释）；git 大版本升级后改变该语义时自检 21.x 会判红；
 *   L3 ④被忽略的未跟踪目录经 `--directory` 折叠成一项：失败的合并若在这类目录里留下了新文件，「新增未跟踪路径」比较看不到，仍可能报「已确认回到合并前」（推理所得，未实测；node_modules、数据目录这类
 *       被忽略目录里的残留靠人工 status --ignored 核对）；
 *   ⑤交集的小写比较只覆盖 toLowerCase 能折叠的大小写（ASCII、常见拉丁 / 西里尔字母）；NTFS 的特殊折叠（如土耳其语 İ、ß 一类）不保证覆盖。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const C = require('./line-common');
const S = require('./state');

const { LineError } = C;

const FULL_OID_RE = /^[0-9a-f]{40}$/;
const MAIN_BRANCH = 'main';
const MAIN_REF = 'refs/heads/main';
/** 主工作区「进行中的操作」标记（rev-parse --git-path 取路径，存在即拒绝）。 */
const IN_PROGRESS_MARKS = Object.freeze(['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_LOG', 'sequencer']);
const LIST_CAP = 20;
const STDERR_CAP = 600;

const fail = (code, message) => new LineError(code, message);
const capList = (arr) => `${arr.slice(0, LIST_CAP).join('、')}${arr.length > LIST_CAP ? `……（共 ${arr.length} 个，仅列前 ${LIST_CAP} 个）` : ''}`;
/** git 的 stderr 摘要：折叠空白、截断（输出统一再经入口的脱敏出口）。 */
const brief = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, STDERR_CAP);

// ---------------------------------------------------------------- git 读取助手

/** rev-parse --verify --quiet <expr>：解析成功返回 40 位对象名，不存在返回 null（退出码 1），其他失败（不是仓库 / 超时等）抛 LINE_MERGE_GIT_QUERY_FAILED。 */
function revParse(cwd, expr) {
    const r = C.gitTry(cwd, ['rev-parse', '--verify', '--quiet', expr]);
    if (r.status === 0) return r.stdout.trim();
    if (r.status === 1) return null;
    throw fail('LINE_MERGE_GIT_QUERY_FAILED', `git rev-parse 失败（退出码 ${r.status}）：${brief(r.stderr)}`);
}

/** 已跟踪文件的改动 / 暂存条目（口径见文件头第 6 条）；空数组 = 干净。 */
function dirtyEntries(cwd) {
    const r = C.gitTry(cwd, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=no', '--no-renames', '--ignore-submodules=none']);
    if (r.status !== 0) throw fail('LINE_MERGE_GIT_QUERY_FAILED', `git status 失败（退出码 ${r.status}）：${brief(r.stderr)}`);
    return r.stdout.split('\0').filter((x) => x !== '');
}

/** HEAD 符号引用的值（refs/heads/...）；分离头指针返回 null。 */
function headSymbolicRef(cwd) {
    const r = C.gitTry(cwd, ['symbolic-ref', '-q', 'HEAD']);
    if (r.status === 0) return r.stdout.trim();
    if (r.status === 1) return null;
    throw fail('LINE_MERGE_GIT_QUERY_FAILED', `git symbolic-ref 失败（退出码 ${r.status}）：${brief(r.stderr)}`);
}

/** `rev-parse --git-path <名>` 的绝对路径（不自己拼 .git/）。 */
function gitPathOf(cwd, name) {
    const r = C.gitTry(cwd, ['rev-parse', '--git-path', name]);
    if (r.status !== 0 || r.stdout.trim() === '') throw fail('LINE_MERGE_GIT_QUERY_FAILED', `git rev-parse --git-path ${name} 失败（退出码 ${r.status}）：${brief(r.stderr)}`);
    return path.resolve(cwd, r.stdout.trim());
}

/** 存在的「进行中的操作」标记名。 */
function inProgressMarks(cwd) {
    return IN_PROGRESS_MARKS.filter((name) => C.lstatOrNull(gitPathOf(cwd, name)) !== null);
}

/** index.lock 是否存在（别的 git 进程正在写，或崩溃遗留）。 */
function indexLockExists(cwd) {
    return C.lstatOrNull(gitPathOf(cwd, 'index.lock')) !== null;
}

/** 未跟踪路径集合（口径见文件头）：元素带 `U ` / `I ` 前缀区分「未被忽略」与「被忽略」。 */
function untrackedPaths(cwd) {
    const a = C.gitTry(cwd, ['ls-files', '-o', '--exclude-standard', '-z']);
    if (a.status !== 0) throw fail('LINE_MERGE_GIT_QUERY_FAILED', `git ls-files -o 失败（退出码 ${a.status}）：${brief(a.stderr)}`);
    const b = C.gitTry(cwd, ['ls-files', '-o', '-i', '--exclude-standard', '--directory', '-z']);
    if (b.status !== 0) throw fail('LINE_MERGE_GIT_QUERY_FAILED', `git ls-files -o -i 失败（退出码 ${b.status}）：${brief(b.stderr)}`);
    const out = new Set();
    for (const p of a.stdout.split('\0')) if (p !== '') out.add(`U ${p}`);
    for (const p of b.stdout.split('\0')) if (p !== '') out.add(`I ${p}`);
    return out;
}
const newPathsSince = (before, after) => Array.from(after).filter((p) => !before.has(p));

/**
 * diff-tree -r -z --name-only --no-renames --ignore-submodules=none <a> <b> --：改动路径数组（git 输出原样）。
 * 不受 diff.ignoreSubmodules 影响（实测），但会受 submodule.<名>.ignore（config 或 .gitmodules）影响：设成 all 时子模块指针的改动整条消失，
 * 所以命令行显式加 --ignore-submodules=none。
 */
function changedPaths(cwd, a, b) {
    const r = C.gitTry(cwd, ['diff-tree', '-r', '-z', '--name-only', '--no-renames', '--ignore-submodules=none', a, b, '--']);
    if (r.status !== 0) throw fail('LINE_MERGE_GIT_QUERY_FAILED', `git diff-tree 失败（退出码 ${r.status}）：${brief(r.stderr)}`);
    return r.stdout.split('\0').filter((x) => x !== '');
}

/** 一批路径在某提交里的对象名：Map 路径 → 40 位对象名（不存在为 null）。含换行 / 回车的路径逐个 rev-parse，其余走 cat-file --batch-check。 */
function blobMap(cwd, rev, paths) {
    const map = new Map();
    const batch = [];
    for (const p of paths) {
        if (/[\r\n]/.test(p)) map.set(p, revParse(cwd, `${rev}:${p}`));
        else batch.push(p);
    }
    if (batch.length > 0) {
        const r = C.gitInput(cwd, ['cat-file', '--batch-check'], batch.map((p) => `${rev}:${p}\n`).join(''));
        if (r.status !== 0) throw fail('LINE_MERGE_GIT_QUERY_FAILED', `git cat-file 失败（退出码 ${r.status}）：${brief(r.stderr)}`);
        const lines = r.stdout.split('\n');
        batch.forEach((p, i) => {
            const line = lines[i];
            const m = typeof line === 'string' ? /^([0-9a-f]{40}) [a-z]+ [0-9]+$/.exec(line) : null;
            if (m) map.set(p, m[1]);
            else if (line === `${rev}:${p} missing`) map.set(p, null);
            else throw fail('LINE_MERGE_GIT_QUERY_FAILED', 'git cat-file --batch-check 返回了无法解析的行（路径已隐藏）');
        });
    }
    return map;
}

// ---------------------------------------------------------------- 纯函数：事后核对

/**
 * 父提交核对：parents 必须恰为 [B, H]（数量 2、顺序对）。返回 { ok, reasons }。
 */
function verifyMergeParents(parents, B, H) {
    const reasons = [];
    if (!Array.isArray(parents)) return { ok: false, reasons: ['父提交列表不是数组'] };
    if (parents.length !== 2) reasons.push(`父提交数量应为 2，实际 ${parents.length}`);
    else {
        if (parents[0] !== B) reasons.push('第一个父提交不是 B');
        if (parents[1] !== H) reasons.push('第二个父提交不是 H');
    }
    return { ok: reasons.length === 0, reasons };
}

/**
 * 树核对（merge-commit 模式，M = 合入产生的提交）。输入：
 *   pb / ph：主侧 / 线侧改动路径数组；diffHM / diffBM：diff(H, M) / diff(B, M) 的路径数组；
 *   blobM / blobB / blobH：Map 路径 → 对象名（不存在为 null）；必须覆盖 pb 与 ph 的每个路径（缺项按失败处理）。
 * 断言：pb 与 ph 无交集；diff(H, M) ⊆ pb；diff(B, M) ⊆ ph；pb 中每个路径 M 的对象 = B 的；ph 中每个路径 M 的对象 = H 的。返回 { ok, reasons }（原因最多各列前 LIST_CAP 个路径）。
 */
function verifyMergeTree(f) {
    const reasons = [];
    const inp = f || {};
    const asSet = (a) => new Set(Array.isArray(a) ? a : []);
    for (const k of ['pb', 'ph', 'diffHM', 'diffBM']) if (!Array.isArray(inp[k])) reasons.push(`输入 ${k} 不是数组`);
    for (const k of ['blobM', 'blobB', 'blobH']) if (!(inp[k] instanceof Map)) reasons.push(`输入 ${k} 不是 Map`);
    if (reasons.length > 0) return { ok: false, reasons };
    const pb = asSet(inp.pb);
    const ph = asSet(inp.ph);
    const overlap = inp.pb.filter((p) => ph.has(p));
    if (overlap.length > 0) reasons.push(`主侧与线侧改动集有交集：${capList(overlap)}`);
    const extraH = inp.diffHM.filter((p) => !pb.has(p));
    if (extraH.length > 0) reasons.push(`合并结果相对 H 多出主侧改动之外的路径：${capList(extraH)}`);
    const extraB = inp.diffBM.filter((p) => !ph.has(p));
    if (extraB.length > 0) reasons.push(`合并结果相对 B 多出线侧改动之外的路径：${capList(extraB)}`);
    const need = (m, p) => m.has(p);
    const badB = [];
    for (const p of pb) if (!need(inp.blobM, p) || !need(inp.blobB, p) || inp.blobM.get(p) !== inp.blobB.get(p)) badB.push(p);
    if (badB.length > 0) reasons.push(`主侧改动的路径在合并结果里不等于 B 的：${capList(badB)}`);
    const badH = [];
    for (const p of ph) if (!need(inp.blobM, p) || !need(inp.blobH, p) || inp.blobM.get(p) !== inp.blobH.get(p)) badH.push(p);
    if (badH.length > 0) reasons.push(`线侧改动的路径在合并结果里不等于 H 的：${capList(badH)}`);
    return { ok: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------- 前置核对

function checkArgs(ctx, args) {
    for (const k of ['controlRoot', 'linesRoot', 'mainRoot']) {
        if (!C.isNonEmptyString(ctx && ctx[k])) throw new LineError('LINE_BAD_ARGS', `内部错误：缺少 ${k}`);
    }
    // 线名（登记线入口）与 branch（--branch 入口）二选一：都给 / 都不给 = 用法错误（退出码 2）。line.js 的 parseArgv 先拦一次，这里是同一口径的内部兜底
    const hasName = !!args && args.name !== undefined && args.name !== null;
    const hasBranch = !!args && args.branch !== undefined && args.branch !== null;
    if (hasName && hasBranch) throw new LineError('LINE_BAD_ARGS', '线名与 --branch 只能给一个');
    if (!hasName && !hasBranch) throw new LineError('LINE_BAD_ARGS', '缺少线名或 --branch');
    if (hasBranch) {
        if (!C.isNonEmptyString(args.branch)) throw new LineError('LINE_BAD_ARGS', '--branch 不能为空');
        return;
    }
    const name = args.name;
    if (!C.isNonEmptyString(name)) throw new LineError('LINE_BAD_ARGS', '缺少线名');
    const problem = S.checkLineName(name);
    if (problem) throw new LineError('LINE_BAD_ARGS', `线名 ${JSON.stringify(name)} 非法：${problem}`);
}

/** 第 1 步：B、H 必须是完整 40 位小写十六进制提交号，且与 rev-parse 的结果逐字相等；B ≠ H。文案不回显原始取值。 */
function checkRevs(mainRoot, base, head) {
    for (const [label, v] of [['--base', base], ['--head', head]]) {
        if (typeof v !== 'string' || !FULL_OID_RE.test(v)) throw fail('LINE_MERGE_BAD_REV', `${label} 必须是完整 40 位小写十六进制提交号（不接受分支名、缩写、标签、大写；原始取值不回显）`);
    }
    if (base === head) throw fail('LINE_MERGE_BAD_REV', '--base 与 --head 不能相同');
    for (const [label, v] of [['--base', base], ['--head', head]]) {
        const resolved = revParse(mainRoot, `${v}^{commit}`);
        if (resolved !== v) throw fail('LINE_MERGE_BAD_REV', `${label} 不是仓库里存在的提交（不存在，或指向的不是提交对象）`);
    }
}

/**
 * 第 2、3 步：登记表。返回线记录。登记表里的路径 / 分支不可信任（与 line-run 同口径）：分支必须是 line/<线名>，worktree 必须是 <线目录根>/<线名>；lifecycle 必须是 ready。
 */
async function checkRegistry(ctx, name, H) {
    const state = await S.readState(ctx.controlRoot, ctx.stateOpts || {});
    const key = Object.keys(state.lines).find((k) => k.toLowerCase() === name.toLowerCase());
    if (key === undefined) throw fail('LINE_MERGE_NO_SUCH_LINE', `没有这条线：${name}`);
    const rec = state.lines[key];
    if (rec.lifecycle !== 'ready') throw fail('LINE_MERGE_LINE_STATE', `线 ${rec.name} 的状态是 ${rec.lifecycle}，只有 ready 的线才能合入`);
    if (rec.branch !== `line/${rec.name}`) throw fail('LINE_MERGE_LINE_STATE', `线 ${rec.name} 的登记分支不是 line/${rec.name}，拒绝（请人工核对登记表）`);
    const tip = revParse(ctx.mainRoot, `refs/heads/${rec.branch}`);
    if (tip === null) throw fail('LINE_MERGE_HEAD_MISMATCH', `线分支 ${rec.branch} 不存在`);
    if (tip !== H) throw fail('LINE_MERGE_HEAD_MISMATCH', `线分支 ${rec.branch} 当前提交是 ${tip}，与 --head ${H} 不一致（线上有新提交？先重新验证）`);
    if (rec.worktree !== null && rec.worktree !== undefined) {
        const wt = path.join(path.resolve(ctx.linesRoot), rec.name);
        if (!C.isNonEmptyString(rec.worktree) || !C.samePath(rec.worktree, wt)) throw fail('LINE_MERGE_LINE_STATE', `线 ${rec.name} 的登记 worktree 与线目录根推导的路径不一致，拒绝（请人工核对登记表）`);
        if (C.lstatOrNull(wt) !== null) {
            const wtHead = revParse(wt, 'HEAD');
            if (wtHead !== H) throw fail('LINE_MERGE_HEAD_MISMATCH', `线 worktree 的 HEAD（${wtHead === null ? '无法解析' : wtHead}）与 --head ${H} 不一致`);
        }
    }
    checkIntegrationBranch(state);
    return rec;
}

/** 第 3 步（两个入口共用）：登记表 config.integration_branch（缺省 / 登记表文件不存在时按 readState 的返回，null 视为 main）必须是字面 main。 */
function checkIntegrationBranch(state) {
    const ib = state.config ? state.config.integration_branch : null;
    if (ib !== null && ib !== undefined && ib !== MAIN_BRANCH) throw fail('LINE_MERGE_NOT_MAIN', `登记表 config.integration_branch 不是 main（演练后忘记改回？），拒绝`);
}

/**
 * --branch 入口的分支名校验（只收短名，统一拼成 refs/heads/<名>，不经 git 的短名消歧）。任一不符抛 LINE_MERGE_BAD_BRANCH：
 *   非空、不以 - 开头、不以 refs/ 开头；git check-ref-format refs/heads/<名> 通过；不以 line/ 开头（大小写不敏感，登记线必须走线名入口，否则四项登记核对被绕过）；不等于 main（大小写不敏感）。
 */
function checkBranchName(mainRoot, branch) {
    if (!C.isNonEmptyString(branch)) throw fail('LINE_MERGE_BAD_BRANCH', '--branch 不能为空');
    if (branch.startsWith('-')) throw fail('LINE_MERGE_BAD_BRANCH', '--branch 不能以 - 开头');
    if (branch.startsWith('refs/')) throw fail('LINE_MERGE_BAD_BRANCH', '--branch 只收分支短名，不收 refs/ 开头的完整引用名');
    const r = C.gitTry(mainRoot, ['check-ref-format', `refs/heads/${branch}`]);
    if (r.status === 1) throw fail('LINE_MERGE_BAD_BRANCH', '--branch 不是合法的分支名（git check-ref-format 不通过）');
    if (r.status !== 0) throw fail('LINE_MERGE_GIT_QUERY_FAILED', `git check-ref-format 失败（退出码 ${r.status}）：${brief(r.stderr)}`);
    const lower = branch.toLowerCase();
    if (lower.startsWith('line/')) throw fail('LINE_MERGE_BAD_BRANCH', '--branch 不能是 line/ 开头的分支：登记线必须走线名入口（线名入口才会核对登记表）');
    if (lower === MAIN_BRANCH) throw fail('LINE_MERGE_BAD_BRANCH', '--branch 不能是 main（集成分支自己）');
    // 纵深防御：叫 line 的分支名本身没有意义，且它是 line/<线名> 的目录前缀（branchTip 的精确比较是第一道，这里是第二道）
    if (lower === 'line') throw fail('LINE_MERGE_BAD_BRANCH', '--branch 不能是 line（它是 line/<线名> 登记线分支的前缀）');
}

/** refs/heads/<branch> 的当前值：精确匹配完整引用名（for-each-ref 取，不经 rev-parse 的短名消歧，同名标签 / 远程分支撞不上）；不存在返回 null。 */
function branchTip(mainRoot, branch) {
    const full = `refs/heads/${branch}`;
    const r = C.gitTry(mainRoot, ['for-each-ref', '--format=%(objectname) %(refname)', full]);
    if (r.status !== 0) throw fail('LINE_MERGE_GIT_QUERY_FAILED', `git for-each-ref 失败（退出码 ${r.status}）：${brief(r.stderr)}`);
    for (const line of r.stdout.split('\n')) {
        const t = line.replace(/\r$/, '');
        if (t.endsWith(` ${full}`)) {
            const oid = t.slice(0, t.length - full.length - 1);
            if (FULL_OID_RE.test(oid)) return oid;
        }
    }
    return null;
}

/**
 * --branch 入口的目标核对：分支名校验 → 分支存在（LINE_MERGE_NO_SUCH_BRANCH）→ 当前值 = H（LINE_MERGE_HEAD_MISMATCH）→ 登记表 integration_branch = main（共用 checkIntegrationBranch）。
 * 跳过线名入口的四项登记核对（线记录 / 登记分支 / 登记 worktree / lifecycle）；登记表文件不存在时按 readState 的行为处理（不新增回退）。
 */
async function checkBranchTarget(ctx, branch, H) {
    checkBranchName(ctx.mainRoot, branch);
    const tip = branchTip(ctx.mainRoot, branch);
    if (tip === null) throw fail('LINE_MERGE_NO_SUCH_BRANCH', `没有本地分支 refs/heads/${branch}（只认本地分支，同名标签 / 远程分支不算）`);
    if (tip !== H) throw fail('LINE_MERGE_HEAD_MISMATCH', `分支 ${branch} 当前提交是 ${tip}，与 --head ${H} 不一致（分支上有新提交？先重新验证）`);
    const state = await S.readState(ctx.controlRoot, ctx.stateOpts || {});
    checkIntegrationBranch(state);
}

/** 第 4–6 步：主工作区必须在 main、main 与 HEAD 都 = B、没有进行中的操作和 index.lock、已跟踪文件干净。 */
function checkMainWorkspace(mainRoot, B) {
    const sym = headSymbolicRef(mainRoot);
    if (sym !== MAIN_REF) throw fail('LINE_MERGE_MAIN_STATE', `主工作区 HEAD 不在 main 分支上（${sym === null ? '分离头指针' : sym}）`);
    const mainTip = revParse(mainRoot, MAIN_REF);
    const headOid = revParse(mainRoot, 'HEAD');
    if (mainTip !== B) throw fail('LINE_MERGE_MAIN_STATE', `main 当前提交是 ${mainTip === null ? '（无）' : mainTip}，与 --base ${B} 不一致（main 已前进？先把线 rebase 到新的 main、重新验证）`);
    if (headOid !== B) throw fail('LINE_MERGE_MAIN_STATE', `主工作区 HEAD 是 ${headOid === null ? '（无）' : headOid}，与 --base ${B} 不一致`);
    const marks = inProgressMarks(mainRoot);
    if (marks.length > 0) throw fail('LINE_MERGE_IN_PROGRESS', `主工作区有进行中的操作：${marks.join('、')}（先人工完成或放弃它：merge / cherry-pick / revert / rebase 用对应的 --continue 或 --abort，sequencer 残留用 git cherry-pick --quit 或 git revert --quit，bisect 用 git bisect reset）`);
    if (indexLockExists(mainRoot)) throw fail('LINE_MERGE_IN_PROGRESS', '主工作区的 index.lock 已存在（别的 git 进程正在运行，或崩溃遗留）；脚本不删除它，请确认后人工处理');
    const dirty = dirtyEntries(mainRoot);
    if (dirty.length > 0) throw fail('LINE_MERGE_DIRTY', `主工作区已跟踪文件有改动或暂存（未跟踪文件不计入）：${capList(dirty)}`);
}

/** 第 7 步：模式分支前置。快进返回 null；merge-commit 返回 { pb, ph }。 */
function checkMode(mainRoot, B, H, mergeCommit) {
    if (!mergeCommit) {
        const r = C.gitTry(mainRoot, ['merge-base', '--is-ancestor', B, H]);
        if (r.status === 1) throw fail('LINE_MERGE_NOT_FF', 'B 不是 H 的祖先，不能快进：先把线 rebase 到当前 main、重新验证后再合（或改用 --merge-commit）');
        if (r.status !== 0) throw fail('LINE_MERGE_GIT_QUERY_FAILED', `git merge-base --is-ancestor 失败（退出码 ${r.status}）：${brief(r.stderr)}`);
        return null;
    }
    const anc = C.gitTry(mainRoot, ['merge-base', '--is-ancestor', H, B]);
    if (anc.status === 0) throw fail('LINE_MERGE_NOTHING_TO_MERGE', 'H 已经是 B 的祖先，无可合入');
    if (anc.status !== 1) throw fail('LINE_MERGE_GIT_QUERY_FAILED', `git merge-base --is-ancestor 失败（退出码 ${anc.status}）：${brief(anc.stderr)}`);
    const mb = C.gitTry(mainRoot, ['merge-base', '--all', B, H]);
    // 没有共同祖先时 merge-base 退出码 1、输出为空：与「多个共同祖先」一并归到 BASE_AMBIGUOUS；其他非 0 才是查询失败
    if (mb.status !== 0 && !(mb.status === 1 && mb.stdout.trim() === '')) throw fail('LINE_MERGE_GIT_QUERY_FAILED', `git merge-base 失败（退出码 ${mb.status}）：${brief(mb.stderr)}`);
    const bases = mb.stdout.split('\n').map((x) => x.trim()).filter(Boolean);
    if (bases.length !== 1 || !FULL_OID_RE.test(bases[0])) throw fail('LINE_MERGE_BASE_AMBIGUOUS', `B 与 H 的共同祖先不是恰好一个（${bases.length} 个：没有共同祖先或交叉合并历史），无法按改动集判断冲突，拒绝`);
    const MB = bases[0];
    const pb = changedPaths(mainRoot, MB, B);
    const ph = changedPaths(mainRoot, MB, H);
    // 按小写比较：本机文件系统大小写不敏感，主侧 Readme.md 与线侧 README.MD 落到磁盘上是同一个文件。只拒不放行；列原始路径（大小写不同时附上线侧写法）
    const phByLower = new Map();
    for (const p of ph) phByLower.set(p.toLowerCase(), p);
    const overlap = pb.filter((p) => phByLower.has(p.toLowerCase())).map((p) => {
        const q = phByLower.get(p.toLowerCase());
        return q === p ? p : `${p}（线侧写法：${q}）`;
    });
    // 目录前缀关系（35a-H1）：一侧的路径是另一侧路径的祖先目录（小写后比较），即一侧是文件、另一侧是同名目录下的路径
    const pbByLower = new Map();
    for (const p of pb) pbByLower.set(p.toLowerCase(), p);
    const ancestors = (lp) => { const segs = lp.split('/'); const out = []; for (let i = 1; i < segs.length; i += 1) out.push(segs.slice(0, i).join('/')); return out; };
    const dirFile = [];
    for (const p of pb) {
        for (const q of ancestors(p.toLowerCase())) if (phByLower.has(q)) dirFile.push(`${p}（主侧）与 ${phByLower.get(q)}（线侧）`);
    }
    for (const p of ph) {
        for (const q of ancestors(p.toLowerCase())) if (pbByLower.has(q)) dirFile.push(`${pbByLower.get(q)}（主侧）与 ${p}（线侧）`);
    }
    if (overlap.length > 0 || dirFile.length > 0) {
        const parts = [];
        if (overlap.length > 0) parts.push(`主侧与线侧都改了同一批文件（交集 ${overlap.length} 个）：${capList(overlap)}`);
        if (dirFile.length > 0) parts.push(`一侧是文件、另一侧是同名目录下的路径（${dirFile.length} 对）：${capList(dirFile)}（git 会把文件移到辅助路径，不经碰撞核对）`);
        throw fail('LINE_MERGE_OVERLAP', `${parts.join('；另外，')}；合并结果没被任何一边验证过，应把线 rebase 到当前 main 并重新验证后再快进`);
    }
    return { pb, ph };
}

/**
 * 相对路径在主工作区的状态，逐级 lstat：'absent'（某一级 ENOENT，更深的不可能存在）/ 'exists'（路径本身存在）/ 'blocked'（某一级父路径存在但不是普通目录，
 * 或任何非 ENOENT 的错误〔ENAMETOOLONG、EINVAL、EACCES……〕）。逐级而不是只 lstat 整条路径，因为 Windows 上「父路径是文件」时 lstat 报的是 ENOENT 而不是 ENOTDIR（自检 26.3 实测），
 * 只看整条路径的错误码会把这种情形当成「不存在」放行。
 */
function lstatKind(root, rel) {
    const segs = rel.split('/');
    let cur = root;
    for (let i = 0; i < segs.length; i += 1) {
        cur = path.join(cur, segs[i]);
        let st;
        try { st = fs.lstatSync(cur); } catch (e) { return e && e.code === 'ENOENT' ? 'absent' : 'blocked'; }
        if (i === segs.length - 1) return 'exists';
        if (st.isSymbolicLink() || !st.isDirectory()) return 'blocked';
    }
    return 'blocked';
}

/**
 * 一个提交的整棵树：Map 路径 → 条目类型（'blob'〔含符号链接〕/ 'tree' / 'commit'〔gitlink，子模块〕）。`ls-tree -r -t -z --full-tree`：-t 连目录条目一起列出，-z 路径不转义。
 * 不用 cat-file --batch-check 的原因：它对 gitlink 输出 missing（子模块的提交不在本仓库），会把子模块路径误判成「B 里没有」。解析不了就抛 LINE_MERGE_GIT_QUERY_FAILED（fail-closed）。
 */
function treeTypes(cwd, rev) {
    const r = C.gitTry(cwd, ['ls-tree', '-r', '-t', '-z', '--full-tree', rev]);
    if (r.status !== 0) throw fail('LINE_MERGE_GIT_QUERY_FAILED', `git ls-tree 失败（退出码 ${r.status}）：${brief(r.stderr)}`);
    const m = new Map();
    for (const rec of r.stdout.split('\0')) {
        if (rec === '') continue;
        const tab = rec.indexOf('\t');
        const meta = tab < 0 ? [] : rec.slice(0, tab).split(' ');
        if (meta.length !== 3 || !['blob', 'tree', 'commit'].includes(meta[1])) throw fail('LINE_MERGE_GIT_QUERY_FAILED', 'git ls-tree 返回了无法解析的条目（路径已隐藏）');
        m.set(rec.slice(tab + 1), meta[1]);
    }
    return m;
}

/** 目录 p 之下是否有未跟踪（未被忽略）或被忽略的项。路径按字面传（:(literal) 魔法，p 里的 * ? [ 不当通配符）；查询失败抛 LINE_MERGE_GIT_QUERY_FAILED。 */
function dirHasUntrackedItems(cwd, p) {
    const spec = `:(literal)${p}/`;
    const a = C.gitTry(cwd, ['ls-files', '-o', '--exclude-standard', '-z', '--', spec]);
    if (a.status !== 0) throw fail('LINE_MERGE_GIT_QUERY_FAILED', `git ls-files -o 失败（退出码 ${a.status}）：${brief(a.stderr)}`);
    const b = C.gitTry(cwd, ['ls-files', '-o', '-i', '--exclude-standard', '--directory', '-z', '--', spec]);
    if (b.status !== 0) throw fail('LINE_MERGE_GIT_QUERY_FAILED', `git ls-files -o -i 失败（退出码 ${b.status}）：${brief(b.stderr)}`);
    return a.stdout !== '' || b.stdout !== '';
}

/**
 * 第 7b 步：W = 本次合并会写入、且 B 的树里没有的路径；W 里任何一个路径在主工作区已存在（含被忽略的文件、只差大小写的同名文件）或无法确认不存在（含 ENOTDIR）都拒绝。
 * 候选路径按它在 B 里的条目类型分流（treeTypes）：
 *   blob / 符号链接 —— 已跟踪文件，干净核对已保证没有本地改动，覆盖它们是合并的本意，不在此列；
 *   commit（gitlink）—— 仅当 H 里它也是 gitlink（单侧改指针，子模块目录本来就在）才不算碰撞；H 里它变成文件 / 目录 / 被删除时，子模块目录里的内容会被删掉，
 *           而 ls-files 不进子模块目录、查不出里面有什么，所以一律拒绝（文案：子模块将被替换，请人工处理）；
 *   tree —— 候选里出现「B 里是目录」的路径，说明合入目标（H）把这个目录换成了别的（diff-tree 不带 -t，只列叶子：目录换文件表现为 d〔新文件〕+ d/xxx〔删除〕）：
 *           若 H 里它不再是目录，则该目录将被替换为文件，目录下任何未跟踪 / 被忽略的项都会被删掉（merge-commit 下 git 不拦，快进只靠 --no-overwrite-ignore）→ 有则拒绝；
 *   B 里没有 —— 进 W（查不到明确类型也按「没有」处理，fail-closed）。
 */
function checkWriteCollisions(mainRoot, B, H, mergeCommit, sets) {
    const cand = mergeCommit ? sets.ph : changedPaths(mainRoot, B, H);
    if (cand.length === 0) return;
    const typesB = treeTypes(mainRoot, B);
    let typesH = null;
    const writes = [];
    const dirToOther = [];
    const submoduleReplaced = [];
    for (const p of cand) {
        const t = typesB.get(p);
        if (t === 'blob') continue;
        if (t === 'commit') {
            // gitlink：只有 H 里它也是 gitlink（单侧改指针）才不算碰撞；被换成文件 / 目录 / 删除时子模块目录里的内容会被删掉，
            // 而 ls-files 不进子模块目录，dirHasUntrackedItems 查不出来，所以一律拒绝
            if (typesH === null) typesH = treeTypes(mainRoot, H);
            if (typesH.get(p) !== 'commit') submoduleReplaced.push(p);
            continue;
        }
        if (t === 'tree') {
            if (typesH === null) typesH = treeTypes(mainRoot, H);
            if (typesH.get(p) !== 'tree') dirToOther.push(p);
            continue;
        }
        writes.push(p);
    }
    const hit = writes.filter((p) => lstatKind(mainRoot, p) !== 'absent');
    const dfHit = dirToOther.filter((p) => dirHasUntrackedItems(mainRoot, p));
    const parts = [];
    if (hit.length > 0) {
        parts.push(`本次合并会写入的路径在主工作区已经有同名的未跟踪 / 被忽略文件（或同名只差大小写，或某一级父路径是文件），共 ${hit.length} 个：${capList(hit)}；`
            + '也可能是本次合并要删除的已跟踪文件与新文件只差大小写（例如线侧只改了文件名大小写），这种情形请手动合并');
    }
    if (dfHit.length > 0) parts.push(`该目录将被替换为文件，目录下有未跟踪 / 被忽略的项（会被删掉），共 ${dfHit.length} 个目录：${capList(dfHit)}`);
    if (submoduleReplaced.length > 0) parts.push(`子模块将被替换，超级项目看不到子模块目录里的内容，请人工处理，共 ${submoduleReplaced.length} 个：${capList(submoduleReplaced)}`);
    if (parts.length > 0) throw fail('LINE_MERGE_UNTRACKED_COLLISION', `${parts.join('；另外，')}。脚本不覆盖也不删除它们（文案不回显内容），请先人工处理后重试`);
}

// ---------------------------------------------------------------- 执行与善后

function snapshot(mainRoot) {
    return {
        ref: headSymbolicRef(mainRoot), main: revParse(mainRoot, MAIN_REF), head: revParse(mainRoot, 'HEAD'), dirty: dirtyEntries(mainRoot),
        marks: inProgressMarks(mainRoot), lock: indexLockExists(mainRoot),
    };
}
/** 读取现状；读不了返回 null（调用方按 STATE_UNKNOWN 处理）。 */
function safeSnapshot(mainRoot) {
    try { return snapshot(mainRoot); } catch (_) { return null; }
}
const unknownState = (what, snap) => fail('LINE_MERGE_STATE_UNKNOWN', `${what}；当前 main = ${snap ? snap.main : '未知'}、HEAD = ${snap ? snap.head : '未知'}。脚本不做任何自动修复，请人工核对主工作区`);

/** 回到合并前状态的判定（git 失败善后用）：返回不符之处的数组，空数组 = 确认回到 B 且无残留（未跟踪路径既没有新增也没有消失）。 */
function notBackAtBase(mainRoot, B, snap, untrackedBefore) {
    const bad = [];
    if (snap.ref !== MAIN_REF) bad.push('HEAD 不在 main 上');
    if (snap.main !== B) bad.push('main 不是 B');
    if (snap.head !== B) bad.push('HEAD 不是 B');
    if (snap.dirty.length > 0) bad.push(`已跟踪文件有改动：${capList(snap.dirty)}`);
    if (snap.marks.length > 0) bad.push(`有进行中的操作：${snap.marks.join('、')}`);
    if (snap.lock) bad.push('index.lock 存在');
    let now = null;
    try { now = untrackedPaths(mainRoot); } catch (e) { bad.push('无法读取未跟踪路径集合'); }
    if (now !== null) {
        const fresh = newPathsSince(untrackedBefore, now);
        if (fresh.length > 0) bad.push(`出现了合并前没有的未跟踪路径（原样保留，不清理）：${capList(fresh)}`);
        const gone = newPathsSince(now, untrackedBefore);   // 合并前有、现在没有
        if (gone.length > 0) bad.push(`合并前存在的未跟踪路径现在不见了（脚本不恢复，请人工核对）：${capList(gone)}`);
    }
    return bad;
}

/** refs/heads/main 或 HEAD 的当前值，只读：不存在写「（无）」，读不到写「无法读取」（不抛错）。 */
function readRefOr(mainRoot, expr) {
    try { const v = revParse(mainRoot, expr); return v === null ? '（无）' : v; } catch (_) { return '无法读取'; }
}

/**
 * git merge 失败之后的善后（只读，不做任何 git 写操作）：
 *   有 MERGE_HEAD（git 留下了合并中状态）→ 不 abort，原样保留，LINE_MERGE_GIT_FAILED_IN_PROGRESS + 人工指引；
 *   没有 MERGE_HEAD → 核对回到 B 且无残留 → LINE_MERGE_GIT_FAILED，否则 LINE_MERGE_STATE_UNKNOWN。始终抛错。
 */
function handleGitFailure(mainRoot, B, res, untrackedBefore) {
    let inProgress;
    try { inProgress = inProgressMarks(mainRoot).includes('MERGE_HEAD'); } catch (_) {
        throw unknownState('git merge 失败，且善后核对时读取主工作区状态也失败', null);
    }
    if (inProgress) {
        throw fail('LINE_MERGE_GIT_FAILED_IN_PROGRESS',
            `git merge 失败，留下了合并中状态；本工具没有执行 merge --abort，仓库保持当前状态（git 退出码 ${res.status === null ? '无（超时 / 未启动）' : res.status}）：${brief(res.stderr)}。`
            + `B = ${B}；当前 refs/heads/main = ${readRefOr(mainRoot, MAIN_REF)}；当前 HEAD = ${readRefOr(mainRoot, 'HEAD')}。`
            + '人工指引：先核对 main 仍是 B（运行 git rev-parse main），确认后在主工作区运行 git merge --abort；main 已经不是 B 时不要 abort，先查 reflog，弄清 main 是被谁移动的。');
    }
    let snap = null;
    try {
        snap = snapshot(mainRoot);
    } catch (_) {
        throw unknownState('git merge 失败，且善后核对时读取主工作区状态也失败', snap);
    }
    const bad = notBackAtBase(mainRoot, B, snap, untrackedBefore);
    if (bad.length === 0) {
        throw fail('LINE_MERGE_GIT_FAILED', `git merge 被拒绝或失败（退出码 ${res.status === null ? '无（超时 / 未启动）' : res.status}），主工作区已确认回到合并前状态：${brief(res.stderr)}`);
    }
    throw unknownState(`git merge 失败（${brief(res.stderr)}），善后后主工作区没有确认回到合并前状态：${bad.join('；')}`, snap);
}

/**
 * git merge 成功返回之后、事后核对之前：核对合并起点。ORIG_HEAD 必须等于 B（git 2.43 实测：每次 `git merge` 调用——快进、真合并、「已是最新」的空操作——都会把调用开始时的 HEAD 改写进 ORIG_HEAD，
 * 所以历史遗留的 ORIG_HEAD 不会蒙混过关；自检 21.4 预置一个陈旧的 ORIG_HEAD = B 来钉住这一点）。不符抛 LINE_MERGE_STATE_UNKNOWN（不修）。
 */
function checkMergeOrigin(mainRoot, B) {
    let oh;
    try { oh = revParse(mainRoot, 'ORIG_HEAD'); } catch (e) {
        // git merge 已经返回成功：此时查询失败不能当作「没有发生」，按状态未知处理
        throw unknownState(`git merge 已返回成功、合并可能已经发生，但读取 ORIG_HEAD 失败（${brief(e && e.message)}），无法核对合并起点`, safeSnapshot(mainRoot));
    }
    if (oh !== B) {
        throw unknownState(`git merge 成功返回，但合并起点不是 B（ORIG_HEAD = ${oh === null ? '无' : oh}）：main 在前置核对与合并之间被别的进程移动过，合入结果的来历不明`, safeSnapshot(mainRoot));
    }
}

/** 事后核对（只读）：返回 { problems, seen }。problems 为空 = 通过；seen = { main, head }（核对时读到的 refs/heads/main 与 HEAD；成功输出用 seen.main）。 */
function postCheck(mainRoot, B, H, mergeCommit, sets) {
    const problems = [];
    const mainTip = revParse(mainRoot, MAIN_REF);
    const headOid = revParse(mainRoot, 'HEAD');
    const seen = { main: mainTip, head: headOid };
    const dirty = dirtyEntries(mainRoot);
    if (dirty.length > 0) problems.push(`合入后主工作区已跟踪文件不干净：${capList(dirty)}`);
    if (!mergeCommit) {
        if (mainTip !== H) problems.push(`合入后 main 是 ${mainTip}，不是 H`);
        if (headOid !== H) problems.push(`合入后 HEAD 是 ${headOid}，不是 H`);
        return { problems, seen };
    }
    const M = mainTip;
    if (M === null || M === B || M === H) problems.push('合入后 main 没有产生新的合并提交');
    if (headOid !== M) problems.push('合入后 HEAD 与 main 不一致');
    if (M === null || M === B || M === H || headOid !== M) return { problems, seen };
    const rl = C.gitTry(mainRoot, ['rev-list', '--parents', '-n', '1', M]);
    if (rl.status !== 0) { problems.push(`git rev-list 失败（退出码 ${rl.status}）`); return { problems, seen }; }
    const toks = rl.stdout.trim().split(/\s+/).filter(Boolean);
    if (toks[0] !== M) problems.push('rev-list 返回的提交不是 M');
    const pv = verifyMergeParents(toks.slice(1), B, H);
    if (!pv.ok) problems.push(...pv.reasons);
    const all = Array.from(new Set(sets.pb.concat(sets.ph)));
    const tv = verifyMergeTree({
        pb: sets.pb, ph: sets.ph, diffHM: changedPaths(mainRoot, H, M), diffBM: changedPaths(mainRoot, B, M),
        blobM: blobMap(mainRoot, M, all), blobB: blobMap(mainRoot, B, sets.pb), blobH: blobMap(mainRoot, H, sets.ph),
    });
    if (!tv.ok) problems.push(...tv.reasons);
    return { problems, seen };
}

/**
 * 事后核对失败：不做任何 git 写操作（不回滚）。只读 refs/heads/main 与 HEAD 用于文案（读不到写「无法读取」，不换错误码）。返回要抛出的 LineError（LINE_MERGE_POSTCHECK_FAILED）。
 */
function postCheckFailure(mainRoot, B, H, problems) {
    const readOr = (expr) => readRefOr(mainRoot, expr);
    return fail('LINE_MERGE_POSTCHECK_FAILED',
        `合并已执行，但事后核对不通过；本工具没有回滚，仓库保持当前状态。B = ${B}；H = ${H}；当前 refs/heads/main = ${readOr(MAIN_REF)}；当前 HEAD = ${readOr('HEAD')}。`
        + `核对不符项：${capList(problems)}。`
        + `人工回退指引：先核对 main 确实是本次合并的产物（快进 = H；merge-commit 的父提交 = [B, H]），确认后在主工作区运行 git reset --keep ${B} ；被移走的提交可以从 reflog 找回。`
        + 'B / H 之间有差异的已跟踪文件如果被改脏了，git reset --keep 会被拒绝，需要先处理这些改动。'
        + 'main 不等于 H（快进），或父提交不是 [B, H]（merge-commit）时，不要直接 reset：先查 reflog，弄清 main 是被谁移动的。');
}

/**
 * args = { name | branch（二选一）, base, head, mergeCommit }。成功输出模式、线名（--branch 入口为「分支：<名>」）、B、H、合入后 main 提交号各一行；任何拒绝 / 失败抛 LineError（line.js 负责输出与退出码）。
 */
async function lineMerge(ctx, args) {
    checkArgs(ctx, args);
    const say = typeof ctx.out === 'function' ? ctx.out : (s) => console.log(s);
    const mainRoot = ctx.mainRoot;
    const B = args.base;
    const H = args.head;
    const mergeCommit = args.mergeCommit === true;
    checkRevs(mainRoot, B, H);
    // 两个入口只在这一步不同；从 checkMainWorkspace 起全部共用同一条代码路径
    let subject;
    if (args.branch !== undefined && args.branch !== null) {
        await checkBranchTarget(ctx, args.branch, H);
        subject = { label: '分支', value: args.branch, title: `Merge branch ${args.branch} into main (merge-commit mode)` };
    } else {
        const rec = await checkRegistry(ctx, args.name, H);
        subject = { label: '线名', value: rec.name, title: `Merge line ${rec.name} into main (merge-commit mode)` };
    }
    checkMainWorkspace(mainRoot, B);
    const sets = checkMode(mainRoot, B, H, mergeCommit);
    checkWriteCollisions(mainRoot, B, H, mergeCommit, sets);
    const untrackedBefore = untrackedPaths(mainRoot);

    const gitArgs = mergeCommit
        ? ['-c', 'merge.directoryRenames=false', 'merge', '--no-ff', '--no-edit', '-m', `${subject.title}\n\nbase: ${B}\nhead: ${H}`, H]
        : ['merge', '--ff-only', '--no-overwrite-ignore', H];
    const res = C.gitTry(mainRoot, gitArgs);
    if (res.status !== 0) handleGitFailure(mainRoot, B, res, untrackedBefore);
    checkMergeOrigin(mainRoot, B);

    let outcome;
    try { outcome = postCheck(mainRoot, B, H, mergeCommit, sets); } catch (e) { outcome = { problems: [`事后核对本身出错：${brief(e && e.message)}`], seen: null }; }
    if (outcome.problems.length > 0) throw postCheckFailure(mainRoot, B, H, outcome.problems);

    say(`模式：${mergeCommit ? 'merge-commit' : '快进（ff-only）'}`);
    say(`${subject.label}：${subject.value}`);
    say(`B：${B}`);
    say(`H：${H}`);
    say(`合入后 main：${outcome.seen.main}`);
}

module.exports = { lineMerge, verifyMergeTree, verifyMergeParents, FULL_OID_RE, IN_PROGRESS_MARKS };
