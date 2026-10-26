/**
 * 线路工具共用助手（#106 多线并行改造 · S2b · line new / line remove 共用）
 *
 * 只放与具体命令无关的部分：错误类型、git 调用、不跟随链接的文件系统助手（复制 / 遍历 / 删除 / 拆链接）、路径安全预检、归属记录、.env 读写、输出脱敏。
 *
 * 文件系统纪律（Node v24.11.1 实测：fs.rmSync 对含中文的路径静默不删、fs.cpSync 把内容写进乱码路径且不报错；
 *   git 2.43 for Windows 的 `git worktree remove` 带不带 --force 都会穿过没拆的 junction 删掉链接目标里的内容）：
 *   - 不用 fs.rmSync / fs.cpSync；复制用 readdir + copyFileSync 递归，删除用 unlinkSync / rmdirSync，删后 lstat 确认。
 *   - 复制 / 遍历 / 删除一律先 lstat：遇到符号链接 / junction 不跟随（复制拒绝并报路径，遍历收集，删除只拆链接本身）；
 *     目录项再用 realpathSync.native 核对「等于父目录真实路径 + 名字」，不等则视为其他类型的重解析点（卷挂载点等），只拆不进。
 *   - 删线全程不调用 git 的递归删除（不用 `git worktree remove` / `git worktree prune`）：worktree 里的全部内容（含 .git 文件）由 deleteTreeNoFollow 逐项删光，
 *     再 rmdir worktree 根，最后核对 worktree 私有管理目录（<git 公共目录>/worktrees/<id>/）的身份后逐项删除该目录（deleteAdminDir）。
 * git 一律 execFileSync / spawnSync（不经 shell 字符串拼接，设超时），并去掉 GIT_DIR / GIT_COMMON_DIR / GIT_WORK_TREE / GIT_INDEX_FILE（与 state.js 同口径）。
 *
 * 威胁模型（删线 / 复制的保证范围）：
 *   保证：诚实误用与真实故障（中途失败、进程崩溃、并发的 line 命令、用户手动删改 worktree、git 与 Windows 的真实行为）下，
 *     不删到 worktree 之外的任何文件、不丢未合入的提交。
 *   不防：删除进行期间，别的进程并发篡改 worktree 目录结构（例如把某个子目录换成 junction）。Node 没有「按句柄、不跟随重解析点」的删除 API，
 *     路径复核与实际删除之间必然留有窗口。本模块做到的是缩小窗口：整树预检在修改之前；逐项删除时每个目录 readdir 之后再复核目录身份、对每一项再 lstat，
 *     目录进入前复核 realpath 等于「父真实路径 + 名字」，任何不一致立即中止（不跟随、不进入）；剩余窗口登记为残余风险。
 *   归属：worktree 根不放任何本工具的文件；「这个 worktree 与分支是本工具为这条线建的」由两份凭据共同证明——控制根 owners/<代次>.json 与 worktree 私有管理目录里的标记文件，
 *     再加管理目录 gitdir 文件与 worktree 根 .git 文件的互相指向；任何一项对不上，只清登记，worktree / 分支 / 管理目录原样保留。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WBS_NODE_MODULES = path.join(REPO_ROOT, 'wbs-server', 'node_modules');
/** 从 wbs-server/node_modules 取依赖（与 state.js 取 sqlite3 同法，不依赖调用目录）。 */
const requireWbs = (name) => require(path.join(WBS_NODE_MODULES, name));

class LineError extends Error {
    constructor(code, message, extra) {
        super(message);
        this.name = 'LineError';
        this.code = code;
        if (extra && typeof extra === 'object') Object.assign(this, extra);
    }
}

const isNonEmptyString = (v) => typeof v === 'string' && v !== '';
const isWin = process.platform === 'win32';
const fold = (s) => (isWin ? String(s).toLowerCase() : String(s));
const GIT_TIMEOUT_MS = 120000;
/** 归属标记文件名（放在该 worktree 的私有管理目录 <git 公共目录>/worktrees/<id>/ 里，不放 worktree 根）：内容是 JSON { name, generation, branch, worktree }。 */
const ADMIN_MARKER = 'sdh-line-owner.json';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------- git

const GIT_ENV_STRIP = Object.freeze(['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']);
function cleanGitEnv() {
    const env = Object.assign({}, process.env);
    for (const k of Object.keys(env)) if (GIT_ENV_STRIP.includes(k.toUpperCase())) delete env[k];   // Windows 环境变量名不分大小写
    return env;
}

/** 执行 git，成功返回 stdout 文本；失败抛 LineError(LINE_GIT_FAILED)，消息带 stderr。 */
function git(cwd, args) {
    try {
        return execFileSync('git', args, { cwd, env: cleanGitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 256 * 1024 * 1024, timeout: GIT_TIMEOUT_MS });
    } catch (e) {
        const stderr = e && e.stderr ? String(e.stderr).trim() : '';
        throw new LineError('LINE_GIT_FAILED', `git ${args.join(' ')} 失败（cwd=${cwd}）：${stderr || (e && e.message)}`, { cause: e });
    }
}
/** 执行 git，不抛错，返回 { status, stdout, stderr }（status 为 null 表示进程没跑起来或超时）。 */
function gitTry(cwd, args) {
    const r = spawnSync('git', args, { cwd, env: cleanGitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 256 * 1024 * 1024, timeout: GIT_TIMEOUT_MS });
    return { status: r.error ? null : r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? r.error.message : '') };
}

/** 执行 git 并经 stdin 喂入文本（update-ref --stdin / rev-list --stdin 用），不抛错，返回 { status, stdout, stderr }。 */
function gitInput(cwd, args, input) {
    const r = spawnSync('git', args, { cwd, env: cleanGitEnv(), input: String(input), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 256 * 1024 * 1024, timeout: GIT_TIMEOUT_MS });
    return { status: r.error ? null : r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? r.error.message : '') };
}

/** 主工作区根 = git 公共目录（须是名为 .git 的主仓库目录）的父目录，取真实路径。 */
function gitMainRoot(cwd) {
    let out;
    try {
        out = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd, env: cleanGitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: GIT_TIMEOUT_MS });
    } catch (e) {
        throw new LineError('LINE_NO_GIT', `在 ${cwd} 执行 git rev-parse --git-common-dir 失败：${e && e.message}`, { cause: e });
    }
    const commonDir = path.resolve(cwd, String(out).trim());
    if (path.basename(commonDir).toLowerCase() !== '.git') throw new LineError('LINE_NO_GIT', `git 公共目录 ${commonDir} 不是名为 .git 的主仓库目录（裸库 / 子模块不支持）`);
    const mainRoot = path.dirname(commonDir);
    try { return fs.realpathSync.native(mainRoot); } catch (_) { return mainRoot; }
}

/** git worktree list 里全部检出的路径键（含主工作区）。 */
function registeredWorktreeKeys(mainRoot) {
    const out = git(mainRoot, ['worktree', 'list', '--porcelain', '-z']);
    const keys = [];
    for (const field of out.split('\0')) if (field.startsWith('worktree ')) keys.push(pathKey(field.slice('worktree '.length)));
    return keys;
}

/**
 * git worktree list --porcelain -z 的结构化结果：[{ path, head, branch（refs/heads/... 或 null）, detached, locked（布尔）, lockedReason, prunable }]。
 * -z 输出里每个属性以 NUL 结尾，条目之间多一个 NUL（空字段）。
 */
function listWorktrees(mainRoot) {
    const out = git(mainRoot, ['worktree', 'list', '--porcelain', '-z']);
    const entries = [];
    let cur = null;
    for (const field of out.split('\0')) {
        if (field === '') { cur = null; continue; }
        if (field.startsWith('worktree ')) {
            cur = { path: field.slice('worktree '.length), head: null, branch: null, detached: false, locked: false, lockedReason: '', prunable: false };
            entries.push(cur);
        } else if (cur) {
            if (field.startsWith('HEAD ')) cur.head = field.slice(5);
            else if (field.startsWith('branch ')) cur.branch = field.slice(7);
            else if (field === 'detached') cur.detached = true;
            else if (field === 'locked' || field.startsWith('locked ')) { cur.locked = true; cur.lockedReason = field.slice(7); }
            else if (field === 'prunable' || field.startsWith('prunable ')) cur.prunable = true;
        }
    }
    return entries;
}

// ---------------------------------------------------------------- 路径

/** 比较用的路径键：存在则取真实路径（解开 junction / 8.3 短名），win32 折叠大小写。 */
function pathKey(p) {
    let r = path.resolve(p);
    try { r = fs.realpathSync.native(r); } catch (_) { /* 不存在：按 resolve 的结果 */ }
    return fold(r);
}
const samePath = (a, b) => pathKey(a) === pathKey(b);
/** child 是否在 parent 之内（不含相等）。纯字符串比较（调用方先 resolve）；win32 折叠大小写。 */
function isInside(parent, child) {
    const rel = path.relative(fold(path.resolve(parent)), fold(path.resolve(child)));
    return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function lstatOrNull(p) {
    try { return fs.lstatSync(p); } catch (e) { if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null; throw e; }
}
const pathGone = (p) => lstatOrNull(p) === null;

/**
 * 路径安全预检（修改之前）：从 baseReal（调用方已取真实路径）起，沿 relPath 逐级 lstat：
 *   - 链接（符号链接 / junction）→ 抛 LINE_UNSAFE_PATH（opts.allowLinkTail 时允许最后一级是链接）；
 *   - 目录 → realpathSync.native 必须等于「父目录真实路径 + 名字」（win32 折叠大小写），否则按重解析点处理，抛 LINE_UNSAFE_PATH；
 *   - 中间级不是目录 → 抛；某一级不存在 → 其后不再检查（那些路径由本工具随后自己创建）。
 * opts.realpath 仅供单测注入（模拟 lstat 看是目录、realpath 却不一致的重解析点）。
 */
function assertChainSafe(baseReal, relPath, opts) {
    const o = opts || {};
    const realFn = o.realpath || ((p) => fs.realpathSync.native(p));
    const segs = String(relPath).split(/[\\/]+/).filter(Boolean);
    let curReal = baseReal;
    for (let i = 0; i < segs.length; i += 1) {
        const next = path.join(curReal, segs[i]);
        const last = i === segs.length - 1;
        const st = lstatOrNull(next);
        if (st === null) return;
        if (st.isSymbolicLink()) {
            if (last && o.allowLinkTail) return;
            throw new LineError('LINE_UNSAFE_PATH', `路径 ${next} 是链接（符号链接 / junction），拒绝在其上修改（${relPath}）`);
        }
        if (st.isDirectory()) {
            const real = realFn(next);
            if (fold(real) !== fold(path.join(curReal, segs[i]))) throw new LineError('LINE_UNSAFE_PATH', `目录 ${next} 的真实路径是 ${real}，与「父目录真实路径 + 名字」不一致（重解析点），拒绝在其上修改`);
            curReal = real;
        } else {
            if (!last) throw new LineError('LINE_UNSAFE_PATH', `路径 ${next} 不是目录，无法继续向下（${relPath}）`);
            return;
        }
    }
}

/**
 * 整树预检（不修改任何东西）：不跟随地遍历 rootReal 下的全部内容，返回
 *   { expectedLinks: [相对路径...], unexpectedLinks: [路径...], mismatches: [路径...], entries }
 * expectedLinkRels 里列出的相对路径（两个 node_modules 联接）允许是链接，其余任何链接都算 unexpected；
 * 目录项的真实路径与「父目录真实路径 + 名字」不一致算 mismatches（不下钻）。读不了目录直接抛（fail-closed）。
 */
function scanTree(rootReal, expectedLinkRels, opts) {
    const o = opts || {};
    const realFn = o.realpath || ((p) => fs.realpathSync.native(p));
    const expected = new Set((expectedLinkRels || []).map((r) => fold(path.normalize(r))));
    const out = { expectedLinks: [], unexpectedLinks: [], mismatches: [], entries: 0 };
    const stack = [{ dir: rootReal, real: rootReal, rel: '' }];
    while (stack.length) {
        const { dir, real, rel } = stack.pop();
        for (const name of fs.readdirSync(dir)) {
            const p = path.join(dir, name);
            const r = rel === '' ? name : path.join(rel, name);
            const st = fs.lstatSync(p);
            out.entries += 1;
            if (st.isSymbolicLink()) {
                if (expected.has(fold(path.normalize(r)))) out.expectedLinks.push(r); else out.unexpectedLinks.push(p);
            } else if (st.isDirectory()) {
                const rp = realFn(p);
                if (fold(rp) !== fold(path.join(real, name))) { out.mismatches.push(p); continue; }
                stack.push({ dir: p, real: rp, rel: r });
            }
        }
    }
    return out;
}

// ---------------------------------------------------------------- 链接（junction）

/** 建目录联接：target 必须是已存在的目录；link 不得已存在。建后核对 lstat 是链接、真实路径等于 target。 */
function makeJunction(target, linkPath) {
    const t = path.resolve(target);
    let st = null;
    try { st = fs.statSync(t); } catch (_) { /* 下面统一报 */ }
    if (!st || !st.isDirectory()) throw new LineError('LINE_JUNCTION_FAILED', `联接目标不存在或不是目录：${t}`);
    if (lstatOrNull(linkPath) !== null) throw new LineError('LINE_JUNCTION_FAILED', `联接路径已存在（不覆盖）：${linkPath}`);
    fs.symlinkSync(t, linkPath, 'junction');
    const lst = fs.lstatSync(linkPath);
    if (!lst.isSymbolicLink()) throw new LineError('LINE_JUNCTION_FAILED', `${linkPath} 建出来不是链接（lstat.isSymbolicLink() 为假）`);
    if (fs.realpathSync.native(linkPath).toLowerCase() !== fs.realpathSync.native(t).toLowerCase()) {
        throw new LineError('LINE_JUNCTION_FAILED', `${linkPath} 的真实路径与目标 ${t} 不一致`);
    }
}

/** 非递归拆一个链接：拆前 lstat 确认是链接，只用 rmdirSync / unlinkSync（目录联接 rmdir 只拆链接本身；真目录非空时 rmdir 会失败而不是删内容）。拆后确认路径不存在。 */
function removeLinkChecked(linkPath) {
    const st = lstatOrNull(linkPath);
    if (st === null) return false;
    if (!st.isSymbolicLink()) throw new LineError('LINE_NOT_A_LINK', `${linkPath} 不是链接，拒绝按链接拆除`);
    try { fs.rmdirSync(linkPath); } catch (_) {
        try { fs.unlinkSync(linkPath); } catch (e2) { throw new LineError('LINE_LINK_REMOVE_FAILED', `拆除链接 ${linkPath} 失败：${e2 && e2.message}`, { cause: e2 }); }
    }
    if (!pathGone(linkPath)) throw new LineError('LINE_LINK_REMOVE_FAILED', `拆除链接后 ${linkPath} 仍然存在`);
    return true;
}

/** 删一个文件：失败（常见是只读属性）时放开写权限再删一次；删后 lstat 确认。 */
function unlinkChecked(p) {
    try { fs.unlinkSync(p); } catch (e) {
        if (e && e.code === 'ENOENT') return;
        try { fs.chmodSync(p, 0o666); fs.unlinkSync(p); } catch (e2) { throw new LineError('LINE_DELETE_FAILED', `删除文件 ${p} 失败：${e2 && e2.message}`, { cause: e2 }); }
    }
    if (!pathGone(p)) throw new LineError('LINE_DELETE_FAILED', `删除后文件 ${p} 仍然存在`);
}

/**
 * 不跟随重解析点的逐项删除（不用 fs.rmSync，不交给 git 的递归删除）：删光 rootReal 下除 keepAtRoot 以外的全部内容，rootReal 本身保留。
 *   每个目录项先 lstat：链接 → 只拆链接本身；目录 → 核对 realpath 等于「父目录真实路径 + 名字」，不等视为重解析点，只用非递归 rmdir 拆、不进入；
 *   普通目录 → 递归清空后 rmdir；文件 → unlink（只读则放开权限）。任何一项失败立即抛（已删的不回滚）。返回 { files, dirs, links }。
 * 每个目录 readdir 之后再复核目录自身身份（仍是目录、不是链接、真实路径未变），对列出的每一项再 lstat；进入子目录前复核 realpath 等于「父真实路径 + 名字」。
 * opts.strict（line remove 的 tree_delete 用）：整树预检之后再出现的链接 / 重解析点一律视为不一致，直接中止（不拆、不进）；缺省（非 strict）时链接只拆链接本身、重解析点只做非递归 rmdir。
 * opts.realpath 仅供单测注入。
 */
function deleteTreeNoFollow(rootReal, keepAtRoot, opts) {
    const o = opts || {};
    const realFn = o.realpath || ((p) => fs.realpathSync.native(p));
    const strict = o.strict === true;
    const keep = new Set((keepAtRoot || []).map(fold));
    const stats = { files: 0, dirs: 0, links: 0 };
    const clear = (dirPath, dirReal, isRoot) => {
        const names = fs.readdirSync(dirPath);
        const self = lstatOrNull(dirPath);
        if (self === null || self.isSymbolicLink() || !self.isDirectory() || fold(realFn(dirPath)) !== fold(dirReal)) {
            throw new LineError('LINE_DELETE_FAILED', `目录 ${dirPath} 在列出内容之后身份发生变化（不再是原来的真实目录），中止，不继续删除`);
        }
        for (const name of names) {
            if (isRoot && keep.has(fold(name))) continue;
            const p = path.join(dirPath, name);
            const st = fs.lstatSync(p);
            if (st.isSymbolicLink()) {
                if (strict) throw new LineError('LINE_DELETE_FAILED', `删除过程中发现链接 ${p}（整树预检时不存在）：与预检不一致，中止；不跟随、不拆除`);
                removeLinkChecked(p); stats.links += 1; continue;
            }
            if (st.isDirectory()) {
                const rp = realFn(p);
                if (fold(rp) !== fold(path.join(dirReal, name))) {
                    if (strict) throw new LineError('LINE_DELETE_FAILED', `目录 ${p} 的真实路径是 ${rp}，与「父真实路径 + 名字」不一致（重解析点）：与预检不一致，中止；不进入、不拆除`);
                    try { fs.rmdirSync(p); } catch (e) { throw new LineError('LINE_DELETE_FAILED', `目录 ${p} 的真实路径是 ${rp}（重解析点），非递归拆除失败，拒绝进入：${e && e.message}`, { cause: e }); }
                    if (!pathGone(p)) throw new LineError('LINE_DELETE_FAILED', `拆除重解析点 ${p} 后仍然存在`);
                    stats.links += 1;
                    continue;
                }
                clear(p, rp, false);
                try { fs.rmdirSync(p); } catch (e) { throw new LineError('LINE_DELETE_FAILED', `删除目录 ${p} 失败：${e && e.message}`, { cause: e }); }
                if (!pathGone(p)) throw new LineError('LINE_DELETE_FAILED', `删除后目录 ${p} 仍然存在`);
                stats.dirs += 1;
                continue;
            }
            unlinkChecked(p);
            stats.files += 1;
        }
    };
    clear(rootReal, rootReal, true);
    return stats;
}

/** 目录顶层条目名（排序）；目录不存在返回 null。 */
function listTop(dir) {
    try { return fs.readdirSync(dir).sort(); } catch (e) { if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null; throw e; }
}

/** 目录顶层快照：名字 → 类型与（文件的）大小、修改时间；目录不存在返回 null。用于拆线前后核对主 node_modules。 */
function snapshotTop(dir) {
    const names = listTop(dir);
    if (names === null) return null;
    const snap = {};
    for (const n of names) {
        const st = fs.lstatSync(path.join(dir, n));
        snap[n] = st.isSymbolicLink() ? 'link' : (st.isDirectory() ? 'dir' : `file:${st.size}:${Math.floor(st.mtimeMs)}`);
    }
    return snap;
}
/** 比较两个顶层快照：返回 { lost: [...], changed: [...], added: [...] }。 */
function diffSnapshots(before, after) {
    const b = before || {};
    const a = after || {};
    return {
        lost: Object.keys(b).filter((n) => !(n in a)),
        changed: Object.keys(b).filter((n) => n in a && a[n] !== b[n]),
        added: Object.keys(a).filter((n) => !(n in b)),
    };
}

// ---------------------------------------------------------------- 复制（不跟随链接）

/**
 * 递归复制目录（readdir + copyFileSync）。不跟随链接：来源树里任何符号链接 / junction 都拒绝并报路径；
 * 来源根的祖先链与每个来源子目录都与删除同口径检查——目录的 realpath 必须等于「父真实路径 + 名字」，否则按重解析点（卷挂载点等）处理，抛 LINE_UNSAFE_PATH；
 * 目标不得已存在（COPYFILE_EXCL + mkdirSync 非 recursive 的根）。返回 { files, dirs, bytes }。
 * opts.srcBase：来源所在基准目录的真实路径（调用方取主工作区的真实路径）；给了就对 srcBase → src 逐级做 assertChainSafe（祖先链检查）。
 * opts.realpath 仅供单测注入。
 */
function copyTreeNoFollow(src, dst, opts) {
    const o = opts || {};
    const realFn = o.realpath || ((p) => fs.realpathSync.native(p));
    const top = lstatOrNull(src);
    if (top === null) throw new LineError('LINE_COPY_FAILED', `复制来源不存在：${src}`);
    if (top.isSymbolicLink()) throw new LineError('LINE_LINK_REFUSED', `复制来源是链接（运行期目录里不应有链接），拒绝：${src}`);
    if (!top.isDirectory()) throw new LineError('LINE_COPY_FAILED', `复制来源不是目录：${src}`);
    let srcReal;
    if (o.srcBase) {
        const rel = path.relative(path.resolve(o.srcBase), path.resolve(src));
        if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new LineError('LINE_UNSAFE_PATH', `复制来源 ${src} 不在基准目录 ${o.srcBase} 之内，拒绝`);
        assertChainSafe(o.srcBase, rel, { realpath: realFn });   // 祖先链：逐级不是链接、realpath 等于「父真实路径 + 名字」
        srcReal = path.join(o.srcBase, rel);
    } else {
        srcReal = realFn(src);   // 没给基准目录：只以来源根自身的真实路径为准检查其下的子目录（祖先链由调用方传 srcBase 检查）
    }
    if (lstatOrNull(dst) !== null) throw new LineError('LINE_COPY_FAILED', `复制目标已存在（不合并、不覆盖）：${dst}`);
    const stats = { files: 0, dirs: 0, bytes: 0 };
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const walk = (from, fromReal, to) => {
        fs.mkdirSync(to);
        stats.dirs += 1;
        for (const name of fs.readdirSync(from)) {
            const f = path.join(from, name);
            const t = path.join(to, name);
            const st = fs.lstatSync(f);
            if (st.isSymbolicLink()) throw new LineError('LINE_LINK_REFUSED', `复制来源里有链接（运行期目录里不应有链接），拒绝：${f}`);
            if (st.isDirectory()) {
                const rp = realFn(f);
                if (fold(rp) !== fold(path.join(fromReal, name))) throw new LineError('LINE_UNSAFE_PATH', `复制来源目录 ${f} 的真实路径是 ${rp}，与「父真实路径 + 名字」不一致（重解析点），拒绝进入`);
                walk(f, rp, t);
            } else if (st.isFile()) {
                fs.copyFileSync(f, t, fs.constants.COPYFILE_EXCL);
                stats.files += 1;
                stats.bytes += st.size;
            } else throw new LineError('LINE_COPY_FAILED', `复制来源里有非常规文件（既不是文件也不是目录），拒绝：${f}`);
        }
    };
    walk(src, srcReal, dst);
    return stats;
}

// ---------------------------------------------------------------- 归属记录（资源由本工具创建的凭据）

/**
 * 状态层没有专用的「资源归属」字段，所以用两份凭据（worktree 根不放任何本工具的文件）：
 *   ① 控制根下 owners/<generation>.json：worktree 与分支由本次创建的记录（内容含线名、代次、分支、创建时分支提交 oid、worktree 真实路径、
 *      该 worktree 的私有管理目录 id 与真实路径 admin_id / admin_dir）；
 *   ② 管理目录里的 sdh-line-owner.json（<git 公共目录>/worktrees/<id>/，git 自己的元数据目录，不会进入 worktree 的文件列表）：内容 { name, generation, branch, worktree }。
 * 再加互相指向：管理目录的 gitdir 文件指向本线 worktree 的 .git，worktree 根的 .git 文件指回管理目录（verifyAdmin / findWorktreeAdmin 核对）。
 * line remove 只删除「①存在且与登记一致、②与登记一致、管理目录身份核对通过」的 worktree 与管理目录，以及「①存在且分支名一致」的分支。
 */
function ownerFile(controlRoot, generation) {
    if (!UUID_RE.test(String(generation))) throw new LineError('LINE_BAD_ARGS', `非法代次：${generation}`);
    return path.join(path.resolve(controlRoot), 'owners', `${String(generation).toLowerCase()}.json`);
}
function writeOwnerRecord(controlRoot, rec) {
    const f = ownerFile(controlRoot, rec.generation);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `${JSON.stringify(rec, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}
/** 读归属记录；不存在返回 null；损坏抛错（fail-closed 由调用方处理）。 */
function readOwnerRecord(controlRoot, generation) {
    const f = ownerFile(controlRoot, generation);
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
    const rec = JSON.parse(text);
    return rec && typeof rec === 'object' ? rec : null;
}
function deleteOwnerRecord(controlRoot, generation) {
    const f = ownerFile(controlRoot, generation);
    try { fs.unlinkSync(f); } catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
}

// ---------------------------------------------------------------- worktree 私有管理目录（<git 公共目录>/worktrees/<id>/）

const ADMIN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** 宽松路径键：只 resolve 并折叠大小写，不碰文件系统（目录已不存在时用）。 */
const looseKey = (p) => fold(path.resolve(String(p)));
/** 读文本文件的首行（去首尾空白）；不存在或读不了返回 null。 */
function readFirstLine(file) {
    try { return fs.readFileSync(file, 'utf8').split(/\r?\n/)[0].trim(); } catch (_) { return null; }
}

/** <主工作区>/.git/worktrees；.git 必须是真目录（不是链接 / 文件）。 */
function adminRootOf(mainRoot) {
    const gitDir = path.join(mainRoot, '.git');
    const st = lstatOrNull(gitDir);
    if (st === null || st.isSymbolicLink() || !st.isDirectory()) throw new LineError('LINE_UNSAFE_PATH', `${gitDir} 不是真目录（链接 / 文件 / 不存在），无法定位 worktree 管理目录`);
    return path.join(gitDir, 'worktrees');
}

/** worktree 根的 .git 文件指向的管理目录（`gitdir: <路径>`）；不是文件 / 格式不对返回 null。 */
function readWorktreeGitPointer(wtRoot) {
    const f = path.join(wtRoot, '.git');
    const st = lstatOrNull(f);
    if (st === null || !st.isFile()) return null;
    const first = readFirstLine(f);
    const m = first === null ? null : /^gitdir:\s*(.+)$/.exec(first);
    return m ? path.resolve(wtRoot, m[1].trim()) : null;
}

/**
 * 建线时核实刚建出的 worktree 的管理目录：扫 <公共目录>/worktrees/*，gitdir 文件指向 wtReal/.git 的恰好一个，且 wtReal/.git 文件指回它。
 * 返回 { id, dir（真实路径） }；找不到 / 不唯一 / 互相指向对不上 → 抛 LINE_ADMIN_NOT_FOUND。
 */
function findWorktreeAdmin(mainRoot, wtReal) {
    const adminRoot = adminRootOf(mainRoot);
    let ids = [];
    try { ids = fs.readdirSync(adminRoot); } catch (e) { if (!e || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')) throw e; }
    const hits = [];
    for (const id of ids) {
        const dir = path.join(adminRoot, id);
        const gd = readFirstLine(path.join(dir, 'gitdir'));
        if (gd === null || gd === '') continue;
        const target = path.dirname(gd);
        if (looseKey(target) === looseKey(wtReal) || pathKey(target) === pathKey(wtReal)) hits.push({ id, dir });
    }
    if (hits.length !== 1) throw new LineError('LINE_ADMIN_NOT_FOUND', `在 ${adminRoot} 里找不到指向 ${wtReal} 的唯一管理目录（找到 ${hits.length} 个）`);
    const hit = hits[0];
    const ptr = readWorktreeGitPointer(wtReal);
    if (ptr === null || (looseKey(ptr) !== looseKey(hit.dir) && pathKey(ptr) !== pathKey(hit.dir))) {
        throw new LineError('LINE_ADMIN_NOT_FOUND', `worktree 根的 .git 文件没有指回管理目录 ${hit.dir}（互相指向对不上）`);
    }
    return { id: hit.id, dir: fs.realpathSync.native(hit.dir) };
}

function writeAdminMarker(adminDir, rec) {
    fs.writeFileSync(path.join(adminDir, ADMIN_MARKER), `${JSON.stringify(rec)}\n`, { encoding: 'utf8', flag: 'wx' });
}
function readAdminMarker(adminDir) {
    let text;
    try { text = fs.readFileSync(path.join(adminDir, ADMIN_MARKER), 'utf8'); } catch (e) { if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null; throw e; }
    try { const m = JSON.parse(text); return m && typeof m === 'object' ? m : null; } catch (_) { return null; }
}

/**
 * 管理目录是不是 deleteAdminDir 中途失败的残留形态：该函数的删除顺序是 其余内容 → logs → HEAD → commondir → 标记 → gitdir（身份依据最后删）→ rmdir，
 * 所以「标记已被删、gitdir 还在」时，前面的 logs / HEAD / commondir 与其余内容必然已经删光——目录里恰好只剩 gitdir 一项。
 */
function isAdminDeleteResidue(dir) {
    let names;
    try { names = fs.readdirSync(dir); } catch (_) { return false; }
    return names.length === 1 && names[0] === 'gitdir';
}

/**
 * 核对归属记录里的管理目录身份。返回 { ok, absent, reason, dir }：
 *   absent=true 表示管理目录不存在（只清登记即可）；ok=false 且 absent=false 表示存在但证明不了是本线的（不得触碰）。
 * 核对项：id 合法 → 目录存在、不是链接、祖先链安全、realpath 等于「真实公共目录/worktrees/<id>」→ 与归属记录里的 admin_dir 一致 →
 *   gitdir 文件指向本线 worktree 的 .git（同时对 expect.wtPath 与 owner.worktree 成立）→ 标记文件的线名 / 代次 / 分支 / worktree 与登记一致。
 * expect = { name, generation, branch, wtPath }；opts.allowMissingMarker（必须严格为 true）：仅当上一次失败于 admin_delete 时由调用方传入，且只对 isAdminDeleteResidue 形态（只剩 gitdir）生效；opts.realpath 仅供单测注入。
 */
function verifyAdmin(mainRoot, owner, expect, opts) {
    const o = opts || {};
    const realFn = o.realpath || ((p) => fs.realpathSync.native(p));
    const bad = (reason) => ({ ok: false, absent: false, reason, dir: null });
    if (!owner || typeof owner.admin_id !== 'string' || !ADMIN_ID_RE.test(owner.admin_id) || typeof owner.admin_dir !== 'string' || owner.admin_dir === '') return bad('归属记录里没有合法的管理目录信息（admin_id / admin_dir）');
    let adminRoot;
    let realMain;
    try { adminRoot = adminRootOf(mainRoot); realMain = fs.realpathSync.native(mainRoot); } catch (e) { return bad(e.message); }
    const dir = path.join(adminRoot, owner.admin_id);
    const st = lstatOrNull(dir);
    if (st === null) return { ok: false, absent: true, reason: '管理目录不存在', dir };
    if (st.isSymbolicLink() || !st.isDirectory()) return bad(`管理目录 ${dir} 是链接或不是目录`);
    try { assertChainSafe(realMain, path.join('.git', 'worktrees', owner.admin_id), { realpath: realFn }); } catch (e) { return bad(e.message); }
    if (looseKey(owner.admin_dir) !== looseKey(dir) && pathKey(owner.admin_dir) !== pathKey(dir)) return bad('归属记录里的 admin_dir 与按 admin_id 推导的管理目录不一致');
    const gd = readFirstLine(path.join(dir, 'gitdir'));
    if (gd === null || gd === '') return bad('管理目录里没有 gitdir 文件');
    const target = path.dirname(gd);
    const pointsTo = (p) => looseKey(target) === looseKey(p) || pathKey(target) === pathKey(p);
    if (!pointsTo(expect.wtPath) || !pointsTo(owner.worktree)) return bad(`管理目录的 gitdir 指向 ${gd}，不是这条线的 worktree ${expect.wtPath}`);
    let marker = null;
    try { marker = readAdminMarker(dir); } catch (_) { marker = null; }
    if (marker === null) {
        // 标记缺失只在一种形态下放过：调用方声明「上一次失败于 admin_delete」，并且这个管理目录正好是 deleteAdminDir 中途失败的残留（只剩 gitdir）。
        // 其余放宽状态（tree_delete 失败后重试、崩溃后停在 removing）一律照常要求标记：用户在同一路径手工收尾后自建的 worktree 会得到同名的新管理目录（没有标记、内容齐全）。
        if (!(o.allowMissingMarker === true && isAdminDeleteResidue(dir))) return bad('管理目录里的归属标记缺失或损坏');
    } else if (marker.name !== expect.name || marker.generation !== expect.generation || marker.branch !== expect.branch || typeof marker.worktree !== 'string' || looseKey(marker.worktree) !== looseKey(owner.worktree)) {
        return bad('管理目录里的归属标记与登记不一致（线名 / 代次 / 分支 / worktree）');
    }
    return { ok: true, absent: false, reason: '', dir };
}

/**
 * 逐项删除 worktree 私有管理目录（不调用 git worktree remove / prune）。前提：调用方刚用 verifyAdmin 核对过身份。
 * 顺序：先删其余内容 → logs → HEAD → commondir → 标记 → gitdir（身份依据最后删）→ rmdir。任何一项失败立即抛。
 */
function deleteAdminDir(dir, opts) {
    const o = opts || {};
    const realFn = o.realpath || ((p) => fs.realpathSync.native(p));
    const last = ['logs', 'HEAD', 'commondir', ADMIN_MARKER, 'gitdir'];
    const real = realFn(dir);
    const stats = deleteTreeNoFollow(real, last, { strict: true, realpath: realFn });
    const logs = path.join(real, 'logs');
    const lst = lstatOrNull(logs);
    if (lst !== null) {
        if (lst.isSymbolicLink() || !lst.isDirectory()) throw new LineError('LINE_DELETE_FAILED', `管理目录里的 ${logs} 不是普通目录，中止`);
        const lreal = realFn(logs);
        if (fold(lreal) !== fold(path.join(real, 'logs'))) throw new LineError('LINE_DELETE_FAILED', `管理目录里的 ${logs} 真实路径是 ${lreal}（重解析点），中止`);
        const s2 = deleteTreeNoFollow(lreal, [], { strict: true, realpath: realFn });
        stats.files += s2.files; stats.dirs += s2.dirs; stats.links += s2.links;
        try { fs.rmdirSync(logs); } catch (e) { throw new LineError('LINE_DELETE_FAILED', `删除目录 ${logs} 失败：${e && e.message}`, { cause: e }); }
    }
    for (const n of ['HEAD', 'commondir', ADMIN_MARKER, 'gitdir']) {
        const p = path.join(real, n);
        const st = lstatOrNull(p);
        if (st === null) continue;
        if (st.isSymbolicLink() || !st.isFile()) throw new LineError('LINE_DELETE_FAILED', `管理目录里的 ${p} 不是普通文件，中止`);
        unlinkChecked(p);
        stats.files += 1;
    }
    try { fs.rmdirSync(real); } catch (e) { throw new LineError('LINE_DELETE_FAILED', `删除管理目录 ${real} 失败（可能还有未识别的内容）：${e && e.message}`, { cause: e }); }
    if (!pathGone(real)) throw new LineError('LINE_DELETE_FAILED', `删除后管理目录 ${real} 仍然存在`);
    return stats;
}

// ---------------------------------------------------------------- .env

/** 读并解析 .env；文件不存在返回 null。解析用 dotenv.parse（与 server.js 加载口径一致）。 */
function readEnvFile(file) {
    let buf;
    try { buf = fs.readFileSync(file); } catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
    return requireWbs('dotenv').parse(buf);
}

/** 把值格式化成 dotenv 能原样读回的写法；安全字符集裸写，其余优先单引号、其次反引号，都不行则抛。调用方须再用 parse 回读校验。 */
function formatEnvValue(v) {
    const s = String(v);
    if (/^[A-Za-z0-9_.:\/@%+=,-]+$/.test(s)) return s;
    if (!/['\r\n]/.test(s)) return `'${s}'`;
    if (!/[`\r\n]/.test(s)) return '`' + s + '`';
    throw new LineError('LINE_ENV_UNWRITABLE', '值同时含单引号 / 反引号 / 换行，无法安全写入 .env');
}

// ---------------------------------------------------------------- 输出脱敏（统一出口）

/** 输出脱敏时不当作机密的 .env 键（取值是 production / DEBUG / 1 / 3000 这类通用词，脱敏会把路径等无关文字改花）。 */
const NON_SECRET_ENV_KEYS = Object.freeze(['NODE_ENV', 'LOG_LEVEL', 'SYS_FASTLANE_ENABLE', 'PORT']);

/** 返回 redact(text)：把 secrets 里出现的每个串（长度 >= 8）替换为 [已脱敏]。 */
function makeRedactor(secrets) {
    const list = Array.from(new Set((secrets || []).filter((s) => typeof s === 'string' && s.length >= 8))).sort((a, b) => b.length - a.length);
    return (text) => {
        let out = String(text);
        for (const s of list) out = out.split(s).join('[已脱敏]');
        return out;
    };
}
/** 主工作区 .env 里除 NON_SECRET_ENV_KEYS 外的全部值（长度 >= 8）→ 脱敏器。 */
function redactorFromEnv(envObj) {
    const o = envObj || {};
    return makeRedactor(Object.keys(o).filter((k) => !NON_SECRET_ENV_KEYS.includes(k.toUpperCase())).map((k) => o[k]));
}
/** 读主 .env 并建脱敏器：.env 不存在 → 空集；读 / 解析失败抛 LineError(LINE_ENV_UNREADABLE)。返回 { env, redact }。 */
function loadMainEnv(mainRoot) {
    let env = null;
    try { env = readEnvFile(path.join(mainRoot, 'wbs-server', '.env')); } catch (e) { throw new LineError('LINE_ENV_UNREADABLE', `读取主工作区 wbs-server/.env 失败：${e && e.message}`); }
    const parsed = env === null ? {} : env;
    return { env: parsed, redact: redactorFromEnv(parsed) };
}
/**
 * 脱敏异常（就地改，保留原对象的 code / 附加字段）：message；stack（V8 的 stack 在构造时把旧消息固化进了头部，
 * 所以重置为「脱敏后的名字: 消息」+ 原调用栈行的脱敏文本）；cause 链与 errors 数组里的异常递归处理；对象上的字符串字段（如 execFileSync 错误带的 stderr / stdout / cmd）也过一遍。
 * 冻结 / 只读的对象放弃就地改（该字段保持原样，由调用方不再向外输出它）。
 */
function scrubError(e, redact, seen) {
    const visited = seen || new Set();
    if (!e || typeof e !== 'object' || visited.has(e)) return e;
    visited.add(e);
    const tryRedact = (s) => { try { return redact(s); } catch (_) { return s; } };
    if (typeof e.message === 'string') { try { e.message = tryRedact(e.message); } catch (_) { /* 冻结对象 */ } }
    if (typeof e.stack === 'string') {
        try {
            const frames = e.stack.split(/\r?\n/).filter((l) => /^\s+at\s/.test(l)).map(tryRedact);
            const head = `${typeof e.name === 'string' ? e.name : 'Error'}: ${typeof e.message === 'string' ? e.message : ''}`;
            e.stack = [head, ...frames].join('\n');
        } catch (_) { /* 冻结对象 */ }
    }
    for (const k of Object.keys(e)) {
        if (k === 'message' || k === 'stack') continue;
        let v;
        try { v = e[k]; } catch (_) { continue; }
        if (typeof v === 'string') { try { e[k] = tryRedact(v); } catch (_) { /* 只读 */ } } else if (v && typeof v === 'object' && Buffer.isBuffer(v)) { try { e[k] = tryRedact(v.toString('utf8')); } catch (_) { /* 只读 */ } } else if (v && typeof v === 'object') scrubError(v, redact, visited);
    }
    if (e.cause && typeof e.cause === 'object') scrubError(e.cause, redact, visited);   // Error 的 cause 默认不可枚举
    if (Array.isArray(e.errors)) for (const x of e.errors) scrubError(x, redact, visited);
    return e;
}

/** 登记表里的 surface 可能是字符串或数组，统一成一行文本。 */
function surfaceText(surface) {
    if (surface === null || surface === undefined) return '（未填）';
    return Array.isArray(surface) ? surface.join('；') : String(surface);
}

module.exports = {
    REPO_ROOT, requireWbs, LineError, isNonEmptyString, isWin, fold, ADMIN_MARKER, UUID_RE, NON_SECRET_ENV_KEYS,
    git, gitTry, gitInput, gitMainRoot, registeredWorktreeKeys, listWorktrees,
    pathKey, looseKey, samePath, isInside, lstatOrNull, pathGone, assertChainSafe, scanTree,
    makeJunction, removeLinkChecked, unlinkChecked, deleteTreeNoFollow, listTop, snapshotTop, diffSnapshots, copyTreeNoFollow,
    ownerFile, writeOwnerRecord, readOwnerRecord, deleteOwnerRecord,
    adminRootOf, readWorktreeGitPointer, findWorktreeAdmin, writeAdminMarker, readAdminMarker, isAdminDeleteResidue, verifyAdmin, deleteAdminDir,
    readEnvFile, formatEnvValue, makeRedactor, redactorFromEnv, loadMainEnv, scrubError, surfaceText,
};
