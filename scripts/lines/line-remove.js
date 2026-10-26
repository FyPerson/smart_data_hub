/**
 * line remove（#106 多线并行改造 · S2b · 方案 W2「line remove 步骤」、第七节风险「删线清空主工作区 node_modules」；修复批 2）
 *
 * 入口：lineRemove(ctx, args)。ctx = { controlRoot, linesRoot, mainRoot, out?, stateOpts?, lineLockTimeoutMs?, runNpmLs?, testHooks? }；args = { name, discard? }。
 *   runNpmLs：true = 用 node 直接跑 npm-cli.js 的 `npm ls --depth=0`（主工作区根与 wbs-server 各一次；正常模式用）；函数 = 测试替身 (cwd) => { status, tail }；缺省 / false = 不跑。
 *   testHooks（仅测试用）：beforeRemoving(rec)、beforeTreeDelete(wtReal)、afterTreeContentDelete(wtReal)、afterWorktreeRemove()、beforeBranchDelete(oid)、beforeFinalize()、realpath(p)（注入重解析点判据）。
 *
 * 威胁模型（删线的保证范围）：
 *   保证：诚实误用与真实故障（中途失败、进程崩溃、并发的 line 命令、用户手动删改 worktree、git 与 Windows 的真实行为）下，
 *     不删到 worktree 之外的任何文件、不丢未合入的提交。
 *   不防：删除进行期间，别的进程并发篡改 worktree 目录结构（例如把某个子目录换成 junction）。Node 没有「按句柄、不跟随重解析点」的删除 API，
 *     路径复核与实际删除之间必然留有窗口。本批做到的是缩小窗口（见下「删线不调用 git 的递归删除」与 deleteTreeNoFollow 的逐项复核）；剩余窗口登记为残余风险。
 *
 * 整个操作包在线级锁 withLineLock(controlRoot, args.name, …) 里，所有 updateLine / removeLineRecord 带 expectGeneration（读到登记时的代次）：
 *   两个 remove 并发 → 后到的等锁，拿到锁后线已不在；删后同名重建的新线不会被旧操作改到（STATE_GENERATION_MISMATCH）。
 *
 * 删线不调用 git 的递归删除：全程不执行 `git worktree remove` / `git worktree prune`。顺序：预检 → 拆两个 junction → 自写逐项删除 worktree 里的**全部**内容（含 .git 文件）→
 *   rmdir worktree 根 → 核对归属记录里的管理目录身份（目录存在、gitdir 文件指向本线 worktree、标记与代次一致）后逐项删除该管理目录（<git 公共目录>/worktrees/<id>/）。
 *   worktree 根不放任何本工具的文件（归属标记在管理目录里），所以 git 从头到尾不需要面对一个「里面还有东西」的 worktree。
 *
 * 资源归属：只删除「控制根 owners/<代次>.json 存在且与登记一致、管理目录身份核对通过」的线创建出来的 worktree 与分支。
 *   归属证明不了的（`git worktree add` 本身失败的目录 / 分支、归属凭据丢了或对不上的）原样保留，只清登记并提示。
 *
 * 失败与状态：预检失败、有未提交 / 未合入的拒绝、cwd 在 worktree 内、上锁——都只报错，lifecycle 不变（修改还没开始）。
 *   进入 removing 之后的失败才转 failed，failed_step 为 junction_remove / tree_delete / admin_delete / branch_delete / main_node_modules_check / finalize。
 *   failed_step 为 tree_delete 或其后步骤（或崩溃后停在 removing）时，重试放宽 dirty 检查：忽略「只有被跟踪文件被删除」的条目（` D`）和已被删的 .git 文件，
 *   HEAD / reflog / 未合入检查照做。
 *
 * 步骤：
 *   0 读主 .env 建脱敏器（所有输出统一经它）
 *   1 归属判定（凭据 + 管理目录身份 + 互相指向）；cwd 在 worktree 之内 → 拒绝
 *   2 修改之前的整树预检（线目录根 → worktree 根的真实路径、排除主工作区与其他检出、整棵树不跟随地扫一遍、上锁 worktree）
 *   3 未提交 / 未合入检查（status --untracked-files=all；HEAD 必须是线分支或已是集成分支的祖先；本 worktree 的 HEAD reflog 与线分支 reflog 里每条记录旧、新两端的非零对象，
 *     不被集成分支或线分支包含的按**一次**批量 rev-list 找出；reflog 读不了 / 格式异常 → 默认拒绝），除非 --discard；
 *     worktree 目录已不在时用 `git --git-dir=<管理目录>` 读它的 HEAD 与 reflog 做同样检查
 *   3b 第 3 步没跑的路径（worktree 与管理目录都不在，或上一次失败于 admin_delete 的重试）且第 8 步会删分支时：在第 4 步之前独立核线分支自己的 reflog，
 *     有游离提交 / 读不了 / 核实失败 且无 --discard → LINE_REMOVE_REFUSED（登记不变、什么都没删）；首次带了 --discard 的，重试也要带
 *   4 登记里 process 非空 → 拒绝；lifecycle=removing
 *   5 junction_remove：拆两个 junction     6 tree_delete：strict 逐项删除 + rmdir 根     7 admin_delete：管理目录身份再核对后逐项删除
 *   8 branch_delete：线分支是符号引用 → 保留并提示；被其他检出占用 → 保留；未合入保留并提示；尖端已合入时**再独立核线分支自己的 reflog**
 *     （worktree 与管理目录都不在时第 3 步不跑，不能只看尖端）：有游离提交 / reflog 读不了 / 核实失败 且无 --discard → 保留分支并打印；有 --discard 才删并列出丢弃内容；
 *     然后 update-ref --stdin 事务（option no-deref；verify 集成分支 + delete 线分支，任一变化整体失败）
 *   9 main_node_modules_check：主工作区两级 node_modules 顶层条目拆线前后核对（丢失 / 变化判失败，新增只告警）；正常模式另跑 npm ls --depth=0
 *  10 finalize：removeLineRecord（yield_request 清空、lifecycle=removed、释放槽位、旧记录移入 history）；再删归属记录
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const C = require('./line-common');
const S = require('./state');
const N = require('./line-new');

const { LineError } = C;
const NODE_MODULES_RELS = Object.freeze(['node_modules', path.join('wbs-server', 'node_modules')]);
const REFLOG_LIST_LIMIT = 10;
/** 失败于这些步骤（删除已经开始）之后的重试，放宽 dirty 检查与残缺项。 */
const RELAXED_STEPS = Object.freeze(['tree_delete', 'admin_delete', 'branch_delete', 'main_node_modules_check', 'finalize']);

class StepFailure extends Error {
    constructor(step, cause) {
        super(cause && cause.message ? cause.message : String(cause));
        this.step = step;
        this.cause = cause;
    }
}

/** 真实 npm ls：用 node 直接跑 npm-cli.js（Windows 上不能 execFile .cmd）。找不到 npm-cli.js 返回 { skipped: true }。 */
function runNpmLsReal(cwd) {
    const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!fs.existsSync(cli)) return { skipped: true, status: null, tail: `找不到 ${cli}` };
    const r = spawnSync(process.execPath, [cli, 'ls', '--depth=0'], { cwd, encoding: 'utf8', windowsHide: true, timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    const text = `${r.stdout || ''}${r.stderr || ''}`.trim().split(/\r?\n/);
    return { skipped: false, status: r.error ? null : r.status, tail: text.slice(-15).join('\n') };
}

/**
 * HEAD reflog 批量检查：一次 `git rev-list --stdin`（正向给 reflog 里的全部对象，反向给集成分支与线分支）找出不被两者包含的提交。
 * 对象名按 Git 输出原样使用，不假定 40 位（SHA-256 仓库是 64 位）。返回 { ok, stray: [reflog 里的对象名...], error }。
 */
function strayReflogOids(mainRoot, oids, integRef, branchRef) {
    if (oids.length === 0) return { ok: true, stray: [], error: null };
    const lines = [...oids];
    lines.push(`^${integRef}`);
    if (C.gitTry(mainRoot, ['rev-parse', '--verify', '--quiet', branchRef]).status === 0) lines.push(`^${branchRef}`);
    const r = C.gitInput(mainRoot, ['rev-list', '--stdin'], `${lines.join('\n')}\n`);
    if (r.status !== 0) return { ok: false, stray: [], error: r.stderr.trim() || `git rev-list 退出码 ${r.status}` };
    const reachable = new Set(r.stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^[0-9a-f]{20,}$/.test(s)));
    return { ok: true, stray: oids.filter((o) => reachable.has(o)), error: null };
}

/**
 * 未提交 / 未合入检查，返回原因数组。adminDir = 该 worktree 的私有管理目录（HEAD / reflog 都从它读，worktree 目录已不在时同样适用）；
 * wtReal 非 null 时另查 worktree 的 status（`--git-dir=<管理目录> --work-tree=<wtReal>`，不依赖 worktree 根的 .git 文件还在不在）。
 * relaxed：删除中途失败后的重试——status 里忽略「只有被跟踪文件被删除」的条目（` D`），其余照做。
 */
function unmergedReasons(p) {
    const reasons = [];
    const gd = [`--git-dir=${p.adminDir}`];
    if (p.wtReal !== null) {
        const st = C.gitTry(p.wtReal, [...gd, `--work-tree=${p.wtReal}`, 'status', '--porcelain', '--untracked-files=all']);
        if (st.status !== 0) reasons.push(`无法读取 worktree 的状态（git status 失败：${st.stderr.trim()}）`);
        else {
            let dirty = st.stdout.split(/\r?\n/).filter((l) => l.trim() !== '');
            if (p.relaxed) dirty = dirty.filter((l) => !/^ D /.test(l));
            if (dirty.length) reasons.push(`有未提交改动（git status --porcelain --untracked-files=all 非空）：\n${dirty.slice(0, 10).join('\n')}`);
        }
    }
    const rev = (ref) => { const r = C.gitTry(p.mainRoot, ['rev-parse', '--verify', '--quiet', ref]); return r.status === 0 ? r.stdout.trim() : null; };
    const integOid = rev(p.integRef);
    const branchOid = rev(p.branchRef);
    const isAncestor = (a, b) => b !== null && C.gitTry(p.mainRoot, ['merge-base', '--is-ancestor', a, b]).status === 0;
    if (integOid === null) {
        reasons.push(`集成分支 ${p.integ} 不存在，无法判断是否已合入`);
        return reasons;
    }
    const sym = C.gitTry(p.mainRoot, [...gd, 'symbolic-ref', '-q', 'HEAD']);
    const headRef = sym.status === 0 ? sym.stdout.trim() : null;
    const head = C.gitTry(p.mainRoot, [...gd, 'rev-parse', '--verify', 'HEAD']);
    if (head.status !== 0) {
        reasons.push('无法读取 worktree 的 HEAD（管理目录里的 HEAD 缺失或损坏，无法核实有没有未合入的提交）');
    } else {
        const headOid = head.stdout.trim();
        if (headRef !== p.branchRef && !isAncestor(headOid, integOid)) {
            reasons.push(`worktree 的 HEAD（${headRef || 'detached'} ${headOid.slice(0, 10)}）不是线分支 ${p.branch}，且不在 ${p.integ} 里：其上的提交可能没有别的引用`);
        }
        if (headRef === p.branchRef && branchOid !== null && headOid !== branchOid) reasons.push('worktree 的 HEAD 与线分支不在同一提交');
    }
    if (branchOid !== null && !isAncestor(branchOid, integOid)) {
        const cnt = C.gitTry(p.mainRoot, ['rev-list', '--count', `${p.integRef}..${p.branchRef}`]);
        reasons.push(`线分支 ${p.branch} 有${cnt.status === 0 ? ` ${cnt.stdout.trim()} 个` : ''}未合入 ${p.integ} 的提交`);
    }
    // reflog：本 worktree 的 HEAD reflog 与线分支自己的 reflog 两处，每条记录的旧、新两端非零对象一并收集（较早记录过期后，旧值一侧可能是某个提交仅剩的记录；
    // 线分支被删时它的 reflog 一并消失，在别处更新过又恢复的提交可能从未出现在本 worktree 的 HEAD reflog 里）；读不了 / 格式异常 → 无法核实，默认拒绝
    const col = collectReflogOids(p.adminDir, p.mainRoot, p.branch);
    if (!col.ok) {
        reasons.push(`无法读取 reflog，无法核实有没有未合入的提交（${col.error}）`);
    } else {
        const sr = strayReflogOids(p.mainRoot, col.oids, p.integRef, p.branchRef);
        if (!sr.ok) reasons.push(`无法核实 reflog（git rev-list 失败：${sr.error}）`);
        else if (sr.stray.length) reasons.push(`worktree 的 HEAD reflog 或线分支 reflog（旧、新两端）里有 ${sr.stray.length} 个不被 ${p.integ} 或 ${p.branch} 包含的提交（可能已被 reset / 换分支丢弃）：${sr.stray.slice(0, REFLOG_LIST_LIMIT).map((o) => o.slice(0, 10)).join('、')}`);
    }
    return reasons;
}

/**
 * 读一个原始 reflog 文件，返回 { ok, oids, error }（oids = 每条记录旧、新两端的非零对象名，去重）。
 * 文件不存在 = 没有 reflog（git 的语义，如 core.logAllRefUpdates=false）→ ok、空；是链接 / 不是普通文件 / 读不了 / 任一行格式不是「<旧> <新> …」→ ok=false（调用方默认拒绝）。
 * 对象名长度按 Git 的 SHA-1（40）/ SHA-256（64）两种，旧新两端长度须一致；不假定 40 位。
 */
function readReflogFile(file, label) {
    const st = C.lstatOrNull(file);
    if (st === null) return { ok: true, oids: [], error: null };
    if (st.isSymbolicLink() || !st.isFile()) return { ok: false, oids: [], error: `${label} 不是普通文件（链接 / 目录）` };
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { ok: false, oids: [], error: `${label} 读取失败：${e && e.code ? e.code : e && e.message}` }; }
    const set = new Set();
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
        if (lines[i] === '') continue;
        const m = /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64})(?: |\t|$)/.exec(lines[i]);
        if (!m || m[1].length !== m[2].length) return { ok: false, oids: [], error: `${label} 第 ${i + 1} 行格式异常` };
        for (const o of [m[1], m[2]]) if (!/^0+$/.test(o)) set.add(o);
    }
    return { ok: true, oids: Array.from(set), error: null };
}

/**
 * 线分支自己的 reflog（<主 .git>/logs/refs/heads/line/<线名>）里每条记录旧、新两端的非零对象，返回 { ok, oids, error }（口径同 readReflogFile：读不了 / 格式异常 → ok=false）。
 * 不依赖 worktree 与管理目录：它们都已不在（人工删目录 + git worktree prune）时，branch_delete 仍要靠它独立核实有没有只在这份 reflog 里的提交（修复批 3，47R3c H1）。
 */
function collectBranchReflogOids(mainRoot, branch) {
    return readReflogFile(path.join(mainRoot, '.git', 'logs', 'refs', 'heads', ...String(branch).split('/')), '线分支 reflog');
}

/**
 * 线分支自己的 reflog 里的游离提交（不被集成分支或线分支包含的），返回 { why, oids, desc }：
 *   why 非 null = 读不了 / 格式异常 / 核实失败（无法核实，调用方按「有问题」处理）；oids = 游离提交；desc = 给人看的一句话，没问题时为 null。
 * 第 3 步没跑的路径（修复批 3b MED-1，在第 4 步之前拒绝）与第 8 步 branch_delete（最后一道）共用，两处口径一致。
 */
function branchReflogStray(mainRoot, branch, integRef, integ, branchRef) {
    const brl = collectBranchReflogOids(mainRoot, branch);
    let why = null;
    let oids = [];
    if (!brl.ok) why = `线分支 reflog 读不了或格式异常，无法核实有没有游离提交（${brl.error}）`;
    else {
        const sr = strayReflogOids(mainRoot, brl.oids, integRef, branchRef);
        if (!sr.ok) why = `无法核实线分支 reflog（git rev-list 失败：${sr.error}）`;
        else oids = sr.stray;
    }
    const desc = why !== null ? why : (oids.length > 0 ? `线分支 reflog（旧、新两端）里有 ${oids.length} 个不被 ${integ} 或 ${branch} 包含的提交：${oids.slice(0, REFLOG_LIST_LIMIT).map((o) => o.slice(0, 10)).join('、')}` : null);
    return { why, oids, desc };
}

/** 本 worktree 的 HEAD reflog（<管理目录>/logs/HEAD）与线分支 reflog（<主 .git>/logs/refs/heads/line/<线名>）的旧新两端对象并集。 */
function collectReflogOids(adminDir, mainRoot, branch) {
    const head = readReflogFile(path.join(adminDir, 'logs', 'HEAD'), 'worktree 的 HEAD reflog');
    if (!head.ok) return head;
    const br = collectBranchReflogOids(mainRoot, branch);
    if (!br.ok) return br;
    return { ok: true, oids: Array.from(new Set([...head.oids, ...br.oids])), error: null };
}

async function lineRemove(ctx, rawArgs) {
    const args = rawArgs || {};
    if (!C.isNonEmptyString(args.name)) throw new LineError('LINE_BAD_ARGS', '缺少线名');
    const { controlRoot, linesRoot, mainRoot } = ctx;
    for (const [k, v] of [['controlRoot', controlRoot], ['linesRoot', linesRoot], ['mainRoot', mainRoot]]) {
        if (!C.isNonEmptyString(v)) throw new LineError('LINE_BAD_ARGS', `内部错误：缺少 ${k}`);
    }
    let redact = (t) => String(t);
    try {
        const loaded = C.loadMainEnv(mainRoot);
        redact = loaded.redact;
        return await runRemove(ctx, args, redact);
    } catch (e) {
        throw C.scrubError(e, redact);
    }
}

async function runRemove(ctx, args, redact) {
    const { controlRoot, linesRoot, mainRoot } = ctx;
    const discard = !!args.discard;
    const stateOpts = ctx.stateOpts || {};
    const hooks = ctx.testHooks || {};
    const realNative = (p) => fs.realpathSync.native(p);
    const realFn = typeof hooks.realpath === 'function' ? hooks.realpath : realNative;   // 仅供单测注入重解析点判据（树扫描 / 逐项删除 / 管理目录核对）
    const sink = typeof ctx.out === 'function' ? ctx.out : (s) => console.log(s);
    const say = (s) => sink(redact(s));

    return S.withLineLock(controlRoot, args.name, async () => {
        const st0 = await S.readState(controlRoot, stateOpts);
        const key = Object.keys(st0.lines).find((k) => k.toLowerCase() === String(args.name).toLowerCase());
        if (key === undefined) throw new LineError('LINE_NO_SUCH_LINE', `没有这条线：${args.name}`);
        const rec = st0.lines[key];
        const name = rec.name;
        const generation = rec.generation;
        const integ = st0.config.integration_branch || 'main';
        const integRef = `refs/heads/${integ}`;
        const branch = `line/${name}`;
        const branchRef = `refs/heads/${branch}`;
        if (integ.startsWith('-')) throw new LineError('LINE_BAD_ARGS', `集成分支名不合法：${integ}`);
        const upd = (patch) => S.updateLine(controlRoot, name, patch, Object.assign({}, stateOpts, { expectGeneration: generation }));
        if (rec.lifecycle === 'creating') throw new LineError('LINE_REMOVE_REFUSED', `线 ${name} 处于 creating（正在创建，或创建进程已异常中断）：删线不处理 creating。创建进程已经崩溃的残留，先用 line recover ${name} 转成 failed（拿得到线级锁才会转，建线仍在进行时会拒绝），再 line remove ${name} --discard`);
        if (!['ready', 'failed', 'removing'].includes(rec.lifecycle)) throw new LineError('LINE_REMOVE_REFUSED', `线 ${name} 的 lifecycle=${rec.lifecycle}，不能删除`);

        // 登记表里的路径不可信任：必须就是 <线目录根>/<线名> 与 line/<线名>，否则拒绝
        const wtPath = path.join(path.resolve(linesRoot), name);
        if (!C.isNonEmptyString(rec.worktree) || !C.samePath(rec.worktree, wtPath) || rec.branch !== branch) {
            throw new LineError('LINE_REMOVE_REFUSED', `线 ${name} 的登记路径 / 分支（${rec.worktree} / ${rec.branch}）与线目录根推导的 ${wtPath} / ${branch} 不一致，拒绝（请人工核对登记表）`);
        }
        const relaxed = rec.lifecycle === 'removing' || RELAXED_STEPS.includes(rec.failed_step);
        // 归属标记缺失只在「上一次失败于 admin_delete」时才可能放过（且 verifyAdmin 还要求管理目录正好是只剩 gitdir 的残留形态）；其余放宽状态照常要求标记与代次一致
        const allowMarkerMissing = rec.failed_step === 'admin_delete';

        // ---- 1. 资源归属 ----
        let owner = null;
        let ownerNote = null;
        try { owner = C.readOwnerRecord(controlRoot, generation); } catch (e) { ownerNote = `归属记录读取失败：${e && e.message}`; }
        const ownerOk = !!owner && owner.name === name && owner.generation === generation && owner.branch === branch;
        if (owner && !ownerOk) ownerNote = '归属记录与登记不一致';
        const wtStat = C.lstatOrNull(wtPath);
        const wtExists = wtStat !== null;
        let admin = { ok: false, absent: true, reason: ownerNote || '无归属记录：`git worktree add` 本身失败，或归属凭据丢失', dir: null };
        if (ownerOk) admin = C.verifyAdmin(mainRoot, owner, { name, generation, branch, wtPath }, { allowMissingMarker: allowMarkerMissing, realpath: realFn });
        let wtOwned = false;
        let unprovenWhy = admin.reason;
        if (wtExists && ownerOk) {
            const gitEntry = C.lstatOrNull(path.join(wtPath, '.git'));
            const ptr = C.readWorktreeGitPointer(wtPath);
            const pointerOk = admin.ok && (ptr !== null ? (C.looseKey(ptr) === C.looseKey(admin.dir) || C.pathKey(ptr) === C.pathKey(admin.dir)) : (gitEntry === null && relaxed));
            const samePlace = C.pathKey(wtPath) === C.fold(path.resolve(owner.worktree)) && !wtStat.isSymbolicLink();
            wtOwned = admin.ok && pointerOk && samePlace;
            if (!wtOwned) unprovenWhy = !admin.ok ? admin.reason : (!pointerOk ? 'worktree 根的 .git 文件没有指回归属记录里的管理目录' : 'worktree 的位置与归属记录不一致');
        }
        const adminOwned = !wtExists && ownerOk && admin.ok;                       // worktree 目录已不在，但管理目录还在且身份核对通过
        const adminUnproven = !wtExists && ownerOk && !admin.ok && !admin.absent;   // 管理目录在，但证明不了是本线的
        if (wtExists && !wtOwned) {
            say(`【注意】${wtPath} 存在，但证明不了是本工具为这条线创建的（${unprovenWhy}）：原样保留，不触碰；只清登记`);
        }
        if (adminUnproven) say(`【注意】worktree 目录已不在，但它的 git 管理目录证明不了是本线的（${admin.reason}）：原样保留，不触碰；只清登记`);
        if (!ownerOk && C.gitTry(mainRoot, ['rev-parse', '--verify', '--quiet', branchRef]).status === 0) {
            say(`【注意】分支 ${branch} 存在，但证明不了是本工具为这条线创建的：原样保留`);
        }

        // 在 worktree 之内执行 remove：任何修改之前拒绝（转发保留 cwd，主工作区的入口能看到）
        let wtReal = null;
        if (wtOwned) {
            try { wtReal = realNative(wtPath); } catch (_) { wtReal = null; }
            let cwdReal = null;
            try { cwdReal = realNative(process.cwd()); } catch (_) { cwdReal = null; }
            if (wtReal !== null && cwdReal !== null && (C.fold(cwdReal) === C.fold(wtReal) || C.isInside(wtReal, cwdReal))) {
                throw new LineError('LINE_REMOVE_REFUSED', `当前目录（${cwdReal}）在要删除的 worktree ${wtReal} 之内：先切到线目录之外再执行 line remove（本次什么都没改，登记不变）`);
            }
        }

        // 上锁的 worktree（git worktree lock）：拒绝（含目录已不在的登记）
        if (wtOwned || adminOwned) {
            const entry = C.listWorktrees(mainRoot).find((e) => C.looseKey(e.path) === C.looseKey(wtPath) || C.looseKey(e.path) === C.looseKey(owner.worktree) || C.pathKey(e.path) === C.pathKey(wtPath));
            if (entry && entry.locked) {
                throw new LineError('LINE_REMOVE_REFUSED', `worktree ${wtPath} 已被 git worktree lock 上锁${entry.lockedReason ? `（${entry.lockedReason}）` : ''}：先确认原因，再 git worktree unlock，然后重试（本次什么都没改，登记不变）`);
            }
        }

        // ---- 2. 修改之前的整树预检（只报错，不改状态）----
        if (wtOwned) {
            const problems = [];
            try {
                const realLines = realNative(path.resolve(linesRoot));
                wtReal = realNative(wtPath);
                if (C.fold(wtReal) !== C.fold(path.join(realLines, name))) problems.push(`worktree 的真实路径 ${wtReal} 不是预期的 ${path.join(realLines, name)}`);
                try { N.assertNotOtherCheckout(wtReal, mainRoot, C.pathKey(wtReal)); } catch (e) { problems.push(e.message); }
                const gitStat = C.lstatOrNull(path.join(wtReal, '.git'));
                if (gitStat === null) { if (!relaxed) problems.push('worktree 根没有 .git 文件（不是 linked worktree）'); } else if (!gitStat.isFile()) problems.push('worktree 根的 .git 不是文件（不是 linked worktree）');
                const scan = C.scanTree(wtReal, NODE_MODULES_RELS, { realpath: realFn });
                for (const p of scan.unexpectedLinks) problems.push(`树内有非预期的链接（符号链接 / junction）：${p}`);
                for (const p of scan.mismatches) problems.push(`目录 ${p} 的真实路径与「父真实路径 + 名字」不一致（重解析点）`);
                for (const rel of scan.expectedLinks) {
                    let want = null;
                    let got = null;
                    try { want = realNative(path.join(mainRoot, rel)); got = realNative(path.join(wtReal, rel)); } catch (_) { /* 下面按不一致处理 */ }
                    if (want === null || got === null || C.fold(want) !== C.fold(got)) problems.push(`联接 ${rel} 没有指向主工作区的 ${rel}`);
                }
            } catch (e) {
                problems.push(`预检出错：${e && e.message}`);
            }
            if (problems.length) {
                throw new LineError('LINE_REMOVE_REFUSED', `line remove ${name} 预检未通过，未做任何修改，登记表未变（step=precheck）：\n${problems.slice(0, 10).join('\n')}`, { step: 'precheck', lineName: name, generation });
            }
        }

        // ---- 3. 未提交 / 未合入 ----
        // worktree 在：status + HEAD + reflog；worktree 目录已不在（管理目录还在）：只读管理目录的 HEAD 与 reflog，无法核实就拒绝；
        // 唯一跳过：上一次失败于 admin_delete（管理目录已被删了一部分，HEAD / reflog 不再完整）——检查已在那一次做过，worktree 也早已不存在
        if (wtOwned || (adminOwned && rec.failed_step !== 'admin_delete')) {
            const reasons = unmergedReasons({ mainRoot, adminDir: admin.dir, wtReal: wtOwned ? wtReal : null, integRef, integ, branch, branchRef, relaxed });
            if (reasons.length && !discard) {
                throw new LineError('LINE_REMOVE_REFUSED', `线 ${name} 拒绝删除${wtOwned ? '' : '（worktree 目录已不在，按它的 git 管理目录核实）'}；确认丢弃请加 --discard：\n- ${reasons.join('\n- ')}`);
            }
            if (reasons.length) say(`【--discard】将丢弃：\n- ${reasons.join('\n- ')}`);
        }
        // ---- 3b. 第 3 步没跑的路径：线分支自己的 reflog（修复批 3b，MED-1）----
        //   worktree 与管理目录都不在（人工删目录 + git worktree prune），或上一次失败于 admin_delete 的重试：第 3 步不跑，不会核 reflog；
        //   而第 8 步删分支会连 reflog 一起删。所以在第 4 步（进程登记检查、转 removing）之前就独立核线分支 reflog，命中且无 --discard 直接拒绝：登记表不变、什么都没删，用户加 --discard 重跑。
        //   只在第 8 步真会走到删分支时核（分支是本工具建的、没有证明不了归属的检出、分支存在且不是符号引用、没被其他检出占用、尖端已合入）；其余情形第 8 步本来就保留分支。
        const step3Ran = wtOwned || (adminOwned && rec.failed_step !== 'admin_delete');
        if (!step3Ran && ownerOk && !(wtExists && !wtOwned) && !adminUnproven) {
            const symB = C.gitTry(mainRoot, ['symbolic-ref', '-q', branchRef]);
            const boB = C.gitTry(mainRoot, ['rev-parse', '--verify', '--quiet', branchRef]);
            const ioB = C.gitTry(mainRoot, ['rev-parse', '--verify', '--quiet', integRef]);
            const mergedB = symB.status === 1 && boB.status === 0 && ioB.status === 0 && C.gitTry(mainRoot, ['merge-base', '--is-ancestor', boB.stdout.trim(), ioB.stdout.trim()]).status === 0;
            // 占用者不含本线自己的登记项：上一次失败于 admin_delete 时，管理目录还在，git 仍把「已不存在的本线 worktree」列为占着线分支；第 7 步删掉管理目录之后它就不占了
            const ownEntry = (e) => C.looseKey(e.path) === C.looseKey(wtPath) || C.pathKey(e.path) === C.pathKey(wtPath) || (owner && C.looseKey(e.path) === C.looseKey(owner.worktree));
            const occupiedB = mergedB && C.listWorktrees(mainRoot).some((e) => e.branch === branchRef && !ownEntry(e));
            if (mergedB && !occupiedB) {
                const bs = branchReflogStray(mainRoot, branch, integRef, integ, branchRef);
                if (bs.desc !== null && !discard) {
                    throw new LineError('LINE_REMOVE_REFUSED', `线 ${name} 拒绝删除（worktree 与管理目录都没有可核对的内容，第 3 步没有跑；删分支会连它的 reflog 一起丢掉）；确认丢弃请加 --discard（本次什么都没改，登记不变）：\n- ${bs.desc}\n查看 reflog（命令见下一行）：\n  git reflog show ${branchRef}`);
                }
                if (bs.desc !== null) say(`【--discard】将丢弃：\n- ${bs.desc}`);
            }
        }
        // ---- 4. 进程登记 ----
        if (rec.process !== null) throw new LineError('LINE_REMOVE_REFUSED', `线 ${name} 登记着运行中的进程（pid ${rec.process.pid}），拒绝删除：先 line stop ${name}`);

        if (typeof hooks.beforeRemoving === 'function') await hooks.beforeRemoving(rec);
        if (rec.lifecycle !== 'removing') {
            try {
                await upd((r) => { r.lifecycle = 'removing'; r.failed_step = null; });   // failed → removing 时 failed_step 必须同时清空（登记表结构校验）
            } catch (e) {
                if (e && e.code === 'STATE_PROCESS_REGISTERED') throw new LineError('LINE_REMOVE_REFUSED', `线 ${name} 在检查之后登记了进程，拒绝删除：先 line stop ${name}`);
                if (e && e.code === 'STATE_GENERATION_MISMATCH') throw new LineError('LINE_GENERATION_MISMATCH', `线 ${name} 的代次已变化（可能已被删除并同名重建），本次操作放弃：${e.message}`);
                throw e;
            }
        }
        say(`线 ${name}：lifecycle=removing${discard ? '（--discard）' : ''}`);

        const before = NODE_MODULES_RELS.map((rel) => C.snapshotTop(path.join(mainRoot, rel)));
        const result = {
            name, generation, branchDeleted: false, branchKept: false, branchOccupiedBy: [], worktreeRemoved: false, adminRemoved: false, junctionsRemoved: [], warnings: [], npmLs: [], mainNodeModulesBefore: before,
            unprovenWorktree: wtExists && !wtOwned, unprovenBranch: !ownerOk,
        };
        const step = async (stepName, fn) => {
            try { return await fn(); } catch (e) { throw new StepFailure(stepName, e); }
        };
        try {
            if (wtOwned) {
                // ---- 5. 拆 junction ----
                await step('junction_remove', async () => {
                    for (let i = 0; i < NODE_MODULES_RELS.length; i += 1) {
                        const rel = NODE_MODULES_RELS[i];
                        const link = path.join(wtReal, rel);
                        const lst = C.lstatOrNull(link);
                        if (lst === null) { say(`  ${rel}：不存在，跳过`); continue; }
                        if (!lst.isSymbolicLink()) { say(`  ${rel}：不是链接（视为线内独立依赖），随 worktree 内容一并删除`); continue; }
                        C.removeLinkChecked(link);
                        result.junctionsRemoved.push(rel);
                        if (before[i] !== null) {
                            let ok = false;
                            try { ok = fs.statSync(path.join(mainRoot, rel)).isDirectory(); } catch (_) { ok = false; }
                            if (!ok) throw new Error(`拆除 ${rel} 联接之后主工作区的 ${path.join(mainRoot, rel)} 不见了`);
                        }
                        say(`  ${rel}：联接已拆，主工作区对应目录仍在`);
                    }
                });
                // ---- 6. 自写逐项删除（含 .git 文件）+ rmdir 根 ----
                await step('tree_delete', async () => {
                    if (typeof hooks.beforeTreeDelete === 'function') await hooks.beforeTreeDelete(wtReal);
                    const rst = C.lstatOrNull(wtPath);
                    if (rst === null || rst.isSymbolicLink() || !rst.isDirectory() || C.fold(realNative(wtPath)) !== C.fold(wtReal)) {
                        throw new Error(`worktree 根 ${wtPath} 在预检之后身份发生变化（不再是原来的真实目录），中止，不删除任何内容`);
                    }
                    const stats = C.deleteTreeNoFollow(wtReal, [], { strict: true, realpath: realFn });
                    result.treeDeleted = stats;
                    say(`  worktree 内容已逐项删除（含 .git 文件）：${stats.files} 个文件 / ${stats.dirs} 个目录 / ${stats.links} 个链接`);
                    if (typeof hooks.afterTreeContentDelete === 'function') await hooks.afterTreeContentDelete(wtReal);
                    try { fs.rmdirSync(wtReal); } catch (e) { throw new Error(`删除 worktree 根目录 ${wtReal} 失败（rmdir 非递归；可能还有新出现的文件，或有进程占用着该目录）：${e && e.message}`); }
                    if (!C.pathGone(wtPath)) throw new Error(`删除之后 worktree 根目录 ${wtPath} 仍然存在`);
                    result.worktreeRemoved = true;
                });
            }
            // ---- 7. 管理目录（不调用 git worktree remove / prune）----
            if (wtOwned || adminOwned) {
                await step('admin_delete', async () => {
                    const v = C.verifyAdmin(mainRoot, owner, { name, generation, branch, wtPath }, { allowMissingMarker: allowMarkerMissing, realpath: realFn });
                    if (v.absent) { say('  git 管理目录已不在，跳过'); return; }
                    if (!v.ok) throw new Error(`git 管理目录身份核对未通过（${v.reason}），不删除；worktree 内容已删，需人工核对 ${v.dir || admin.dir}`);
                    const stats = C.deleteAdminDir(v.dir, { realpath: realFn });
                    result.adminRemoved = true;
                    say(`  git 管理目录已逐项删除：${v.dir}（${stats.files} 个文件 / ${stats.dirs} 个目录）`);
                    if (C.registeredWorktreeKeys(mainRoot).includes(C.pathKey(wtPath))) throw new Error(`删除之后 ${wtPath} 仍在 git worktree 登记里`);
                });
                if (wtOwned) say(`worktree 已删除：${wtPath}`);
                else say(`worktree 目录已不在：其 git 管理目录已清理`);
            }
            if (typeof hooks.afterWorktreeRemove === 'function') await hooks.afterWorktreeRemove();

            // ---- 8. 分支 ----
            await step('branch_delete', async () => {
                if (!ownerOk || (wtExists && !wtOwned) || adminUnproven) return;   // 分支不是本工具建的，或还有一个证明不了归属的检出着它：保留
                // 线分支是符号引用（被人改成指向别的分支，如主工作区当前分支）：rev-parse 与 update-ref 默认都会解引用，会删到目标分支 → 不删，保留并提示
                const sym = C.gitTry(mainRoot, ['symbolic-ref', '-q', branchRef]);
                if (sym.status === 0) {
                    result.branchKept = true;
                    say(`【注意】${branchRef} 是符号引用（指向 ${sym.stdout.trim()}），不是本工具建的普通分支：已保留，不删除；确认不要时人工处理（git symbolic-ref --delete ${branchRef}）`);
                    return;
                }
                if (sym.status !== 1) throw new Error(`无法判断 ${branchRef} 是不是符号引用（git symbolic-ref 退出码 ${sym.status}：${sym.stderr.trim()}），分支已保留`);
                const bo = C.gitTry(mainRoot, ['rev-parse', '--verify', '--quiet', branchRef]);
                if (bo.status !== 0) { say(`分支 ${branch} 不存在，跳过`); return; }
                const oid = bo.stdout.trim();
                const occupants = C.listWorktrees(mainRoot).filter((e) => e.branch === branchRef);
                if (occupants.length) {
                    result.branchKept = true;
                    result.branchOccupiedBy = occupants.map((e) => e.path);
                    say(`【注意】分支 ${branch}（${oid.slice(0, 10)}）正被其他检出占用（${occupants.map((e) => e.path).join('、')}），已保留；那个检出不用了再人工删分支`);
                    return;
                }
                const io = C.gitTry(mainRoot, ['rev-parse', '--verify', '--quiet', integRef]);
                const integOid = io.status === 0 ? io.stdout.trim() : null;
                const merged = integOid !== null && C.gitTry(mainRoot, ['merge-base', '--is-ancestor', oid, integOid]).status === 0;
                if (!merged) {
                    result.branchKept = true;
                    say(`【注意】分支 ${branch}（${oid.slice(0, 10)}）未合入 ${integ}，已保留（其上的提交没有丢）；确认不要时人工执行：git update-ref -d ${branchRef} ${oid}`);
                    return;
                }
                // 删分支连它的 reflog 一起删：独立核线分支自己的 reflog（不依赖第 3 步是否跑过——worktree 与管理目录都不在时第 3 步不跑，尖端已合入并不说明 reflog 里的提交都被包含）。
                // 有游离提交（不被集成分支或线分支包含）、或 reflog 读不了 / 格式异常 / 核实失败：没有 --discard 一律保留分支；有 --discard 才删，并列出丢弃的内容
                //   正常情况下第 3 步 / 第 3b 步已经拒绝过；这里是最后一道（两次检查之间 reflog 又变了，或有未预料到的路径）
                const bs8 = branchReflogStray(mainRoot, branch, integRef, integ, branchRef);
                if (bs8.desc !== null) {
                    const desc = bs8.desc;
                    if (!discard) {
                        result.branchKept = true;
                        say(`【注意】分支 ${branch}（${oid.slice(0, 10)}）的尖端已合入 ${integ}，但${desc}；删分支会连 reflog 一起丢掉它们，已保留分支。`);
                        say('  查看 reflog（命令见下一行）：');
                        say(`  git reflog show ${branchRef}`);
                        say('  要留住游离提交，先建救援分支（命令见下一行，<commit> 换成 reflog 里的某个提交）：');
                        say(`  git branch rescue/${name} <commit>`);
                        say('  确认不要这些提交时人工执行（命令见下一行）：');
                        say(`  git update-ref -d ${branchRef} ${oid}`);
                        return;
                    }
                    say(`【--discard】分支 ${branch} 将连同它的 reflog 一并删除，丢弃：${desc}`);
                }
                if (typeof hooks.beforeBranchDelete === 'function') await hooks.beforeBranchDelete(oid);
                // 一个事务：集成分支必须仍是读到的值，线分支必须仍是读到的值；任一变化整体失败、分支保留
                // option no-deref：两个引用都按「引用本身」处理——检查之后线分支又被换成符号引用时，不会解引用去删别的分支（verify 也对符号引用失败）
                const r = C.gitInput(mainRoot, ['update-ref', '--stdin'], `option no-deref\nverify ${integRef} ${integOid}\noption no-deref\ndelete ${branchRef} ${oid}\n`);
                if (r.status !== 0) throw new Error(`条件删除分支 ${branch} 失败（集成分支 ${integ} 或线分支在检查之后发生了变化，已保留）：${r.stderr.trim()}`);
                if (C.gitTry(mainRoot, ['rev-parse', '--verify', '--quiet', branchRef]).status === 0) throw new Error(`删除之后分支 ${branch} 仍然存在`);
                result.branchDeleted = true;
                say(`分支 ${branch}（${oid.slice(0, 10)}）：已合入 ${integ}，已条件删除`);
            });

            // ---- 9. 主工作区 node_modules 完好 ----
            await step('main_node_modules_check', async () => {
                NODE_MODULES_RELS.forEach((rel, i) => {
                    const d = C.diffSnapshots(before[i], C.snapshotTop(path.join(mainRoot, rel)));
                    if (d.added.length) { result.warnings.push(`主工作区 ${rel} 新增条目：${d.added.join('、')}`); say(`【注意】主工作区 ${rel} 在拆线期间新增了条目（只告警）：${d.added.slice(0, 10).join('、')}`); }
                    if (d.lost.length || d.changed.length) {
                        throw new Error(`主工作区 ${rel} 顶层条目与拆线前不一致（丢失 ${d.lost.length}：${d.lost.slice(0, 10).join('、')}；变化 ${d.changed.length}：${d.changed.slice(0, 10).join('、')}）`);
                    }
                });
                say('主工作区两级 node_modules 顶层条目与拆线前一致');
                const npmLs = ctx.runNpmLs === true ? runNpmLsReal : (typeof ctx.runNpmLs === 'function' ? ctx.runNpmLs : null);
                if (npmLs) {
                    for (const cwd of [mainRoot, path.join(mainRoot, 'wbs-server')]) {
                        const r = npmLs(cwd);
                        result.npmLs.push({ cwd, status: r.status, skipped: !!r.skipped });
                        if (r.skipped) { result.warnings.push(`npm ls 未跑（${cwd}）：${r.tail || ''}`); say(`【注意】npm ls 未跑（${cwd}）：${r.tail || ''}`); }
                        else if (r.status !== 0) { result.warnings.push(`npm ls --depth=0 在 ${cwd} 退出码 ${r.status}`); say(`【警告】npm ls --depth=0 在 ${cwd} 退出码 ${r.status}（非 0，请人工核对主工作区依赖）：\n${r.tail || ''}`); }
                        else say(`npm ls --depth=0 在 ${cwd}：退出码 0`);
                    }
                }
            });

            // ---- 10. 登记 ----
            await step('finalize', async () => {
                if (typeof hooks.beforeFinalize === 'function') await hooks.beforeFinalize();
                await S.removeLineRecord(controlRoot, name, Object.assign({}, stateOpts, { expectGeneration: generation }));
            });
            try { C.deleteOwnerRecord(controlRoot, generation); } catch (e) { result.warnings.push(`归属记录删除失败：${e && e.message}`); say(`【注意】归属记录删除失败（不影响删线）：${e && e.message}`); }
        } catch (e) {
            const failedStep = e instanceof StepFailure ? e.step : 'unknown';
            const cause = e instanceof StepFailure ? e.cause : e;
            let stateNote = '';
            try {
                await upd((r) => { r.lifecycle = 'failed'; r.failed_step = failedStep; });
            } catch (e2) {
                stateNote = `（另：把线标为 failed 时登记表写入也失败：${e2 && e2.message}）`;
            }
            const retry = ['junction_remove', 'tree_delete', 'admin_delete', 'branch_delete', 'main_node_modules_check', 'finalize'].includes(failedStep)
                ? `；排除原因后重试 line remove ${name}${RELAXED_STEPS.includes(failedStep) ? '（删除已开始，重试时只有被跟踪文件被删除的条目不再算未提交改动，其余检查照做；首次带了 --discard 的，重试也要带 --discard）' : ''}`
                : '';
            throw new LineError('LINE_REMOVE_FAILED', `line remove ${name} 失败于步骤 ${failedStep}：${cause && cause.message ? cause.message : String(cause)}${stateNote}${retry}`, { step: failedStep, lineName: name, generation });
        }
        say(`线 ${name} 已删除：lifecycle=removed，槽位 ${rec.slot} 已释放，记录已移入 history`);
        return result;
    }, { lockTimeoutMs: ctx.lineLockTimeoutMs });
}

module.exports = { lineRemove, runNpmLsReal, strayReflogOids, branchReflogStray, unmergedReasons, collectReflogOids, collectBranchReflogOids, readReflogFile, RELAXED_STEPS };
