#!/usr/bin/env node
/**
 * 线目录会话准备（PROJECT_STATUS #199；范围 docs/local/多线并行/线目录会话准备_setup-session_范围草稿_20261030_v0.2.md）
 *
 *   node scripts/lines/setup-session.js <线名>             往线 worktree 的 .claude\ 写 settings.json 与 settings.local.json
 *   node scripts/lines/setup-session.js <线名> --refresh   主工作区设置改过后重新生成（线内独有的权限条目保留并列出）
 *   node scripts/lines/setup-session.js <线名> --check     只读核对（与 --refresh 会生成的内容一致才算通过）
 *
 * 为什么只写设置文件（2026-10-30 实测，Claude Code 2.1.312）：在线目录启动的会话，项目记忆与项目 skills 已自动用主工作区的
 *   （记忆按 git 仓库共用；worktree 没有 .claude/skills 时读主工作区的，有就只读自己那份），读不到的是主工作区 .claude/settings.local.json 与 settings.json。
 *   所以：不建记忆联接；不复制 skills（会挡住自动读取；线目录已有 .claude\skills 时拒绝）；不复制 hooks（hook 命令写的是主工作区绝对路径，线里同样触发）。
 * 生成口径：settings.json = 主工作区原样（主工作区没有就不生成）；settings.local.json = 主工作区内容 + permissions.additionalDirectories 追加主工作区根目录
 *   （已有同一绝对路径则不重复；相对写法如 "\tmp" 的含义取决于会话启动目录，不解析、不比较）。
 * --refresh（两个文件同一口径）：permissions 下的 allow / deny / ask / additionalDirectories 取「按主工作区生成的条目」，再接上线内独有的条目（线会话里批准的——Windows 上写进线目录那份），
 *   其余键以主工作区为准，与线内现有内容不同的键名列出；内容无变化时不写；目标文件不存在就新建。
 *   「线内独有」靠生成记录 .claude\setup-session-base.json（每次写入时记下按主工作区生成的内容）区分：线内多出、且上次生成里没有的 = 线会话批准的，保留；
 *   线内多出、但上次生成里有的 = 主工作区已删掉的，随之去掉并列出（不让主工作区收回的权限留在线里）；生成记录缺失时无从区分，全部保留并说明。
 *   例外（取舍，2026-10-30 预筛 LOW-4）：线会话批准过的条目，后来主工作区也加了、又删掉，会被一并去掉——它进过生成记录，与「主工作区收回」无法区分。
 *   主工作区没有、线内有的文件：上次由主工作区生成过（记录里非 null，含 {}）= 主工作区后来整份删掉了，去掉生成过的条目与其余键、只留线内独有条目；
 *   上次没生成过（记录里为 null，线内自己建的）或没有生成记录，保留不动。
 *   setup 只在两个设置文件与生成记录都不存在时写（任一已存在即拒绝，提示 --refresh）。
 *   --check 通过 ⇔ 线目录没有 .claude\skills，且 --refresh 不会改任何设置文件（生成记录要不要补写 / 更新只提示，不算不一致；.claude 里的其他条目也只提示）。
 * 写入：持线级锁（与 line remove / start / stop 串行），锁内重读登记核代次与 lifecycle；worktree 根到目标文件逐级不得是链接 / 重解析点（assertChainSafe）；
 *   新建用 wx；替换先写同目录临时文件，每次改名之前（含占用重试的每一轮）都重读目标核 sha256 仍是读到的那份（不同 = 线会话刚写入，报 LINE_SESSION_CHANGED 不覆盖），
 *   改名遇占用有界重试；失败都删临时文件。
 *   顺序：只要要写设置文件，先落过渡生成记录（旧 ∪ 新；没有旧记录时就是新记录）→ 设置文件 → 正式生成记录，中途失败重跑 --refresh 即可。
 *   只写 <worktree>\.claude\ 下两个设置文件与生成记录（必要时建 .claude 目录本身；临时文件与之同目录），不碰主工作区与登记表。
 * 残余（威胁模型外）：最后一次核对 sha256 与改名之间、读取与写入之间被并发改动或换成联接的极短窗口；线会话若按内存旧快照整份回写设置，会覆盖刷新结果（刷新后可再跑 --check）；
 *   列出的权限条目原样输出（只经主 .env 脱敏），批准的命令里若带口令会进终端；.git 文件只核存在、不核指向；
 *   进程在新建文件写到一半时被强杀会留下不完整的 JSON，之后 --refresh / --check 报 LINE_SESSION_BAD_JSON 拒读，人工删掉该文件后重跑 --refresh 即可（codex 48-R）。
 * 路径参数、转发、脱敏、退出码与 line.js 同口径：根覆盖参数 --control-root / --lines-root / --main-root 全给或全不给（测试用），指向真实环境一律拒绝；
 *   从线检出运行且没有根覆盖参数时，原样转发到主工作区的 scripts/lines/setup-session.js；输出经主 .env 的脱敏器（线内独有的权限条目会原样列出）。
 *
 * 错误码（err.code，LineError）：LINE_BAD_ARGS / LINE_NO_SUCH_LINE / LINE_NOT_READY / LINE_UNSAFE_PATH / LINE_SESSION_SOURCE_MISSING / LINE_SESSION_BAD_JSON /
 *   LINE_SESSION_SKILLS_PRESENT / LINE_SESSION_EXISTS / LINE_SESSION_CHANGED / LINE_SESSION_CHECK_FAILED。
 * 退出码：0 成功（--check 全部一致）；1 操作失败、拒绝或 --check 发现不一致；2 用法错误。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { decideForward, forwardRun, DEFAULT_LINES_ROOT } = require('./line');

const ROOT_FLAGS = Object.freeze({ '--control-root': 'controlRoot', '--lines-root': 'linesRoot', '--main-root': 'mainRoot' });
const MODE_FLAGS = Object.freeze({ '--refresh': 'refresh', '--check': 'check' });
const FILES = Object.freeze({ shared: 'settings.json', local: 'settings.local.json' });
const BASE_FILE = 'setup-session-base.json';
const BASE_TOOL = 'setup-session';
const PERM_LISTS = Object.freeze(['allow', 'deny', 'ask', 'additionalDirectories']);

const USAGE = [
    '用法：',
    '  node scripts/lines/setup-session.js <线名>             往线目录 .claude\\ 写 settings.json 与 settings.local.json（两个都不存在时）',
    '  node scripts/lines/setup-session.js <线名> --refresh   按主工作区重新生成（线内独有的权限条目保留并列出；无变化不写）',
    '  node scripts/lines/setup-session.js <线名> --check     只读核对',
    '路径覆盖（测试用，三个必须同时给）：--control-root <目录> --lines-root <目录> --main-root <目录>',
].join('\n');

const fold = (s) => (process.platform === 'win32' ? String(s).toLowerCase() : String(s));
const realOf = (p) => { try { return fs.realpathSync.native(p); } catch (_) { return path.resolve(p); } };
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const serialize = (obj) => `${JSON.stringify(obj, null, 2)}\n`;
const clone = (v) => JSON.parse(JSON.stringify(v));
/** 比较用：对象键排序、数组保序。 */
function canonical(v) {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (isPlainObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
    return JSON.stringify(v);
}
const sameJson = (a, b) => canonical(a) === canonical(b);
/** 异常里可以安全带出的错误码（与 line.js 同口径）。 */
const safeCode = (e) => (e && typeof e.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(e.code) ? e.code : 'ERROR');

/** 解析 argv（不含 node 与脚本路径）。返回 { ok: true, name, mode, roots, help } 或 { ok: false, error }。错误文案不回显原始输入。 */
function parseArgv(argv) {
    const toks = Array.from(argv);
    // 只认 --help / -h：「help」是合法线名，不能被当成帮助
    if (toks.length === 1 && (toks[0] === '--help' || toks[0] === '-h')) return { ok: true, help: true };
    const roots = {};
    const positional = [];
    let mode = 'setup';
    for (let i = 0; i < toks.length; i += 1) {
        const t = toks[i];
        if (typeof t !== 'string' || !t.startsWith('--')) { positional.push(t); continue; }
        const eq = t.indexOf('=');
        const flag = eq === -1 ? t : t.slice(0, eq);
        if (Object.prototype.hasOwnProperty.call(ROOT_FLAGS, flag)) {
            if (roots[ROOT_FLAGS[flag]] !== undefined) return { ok: false, error: `${flag} 重复给出` };
            let value;
            if (eq !== -1) value = t.slice(eq + 1);
            else {
                value = toks[i + 1];
                i += 1;
                if (value === undefined || value.startsWith('--')) return { ok: false, error: `${flag} 缺少取值` };
            }
            if (value === '') return { ok: false, error: `${flag} 的取值不能为空` };
            roots[ROOT_FLAGS[flag]] = path.resolve(value);
        } else if (Object.prototype.hasOwnProperty.call(MODE_FLAGS, flag)) {
            if (eq !== -1) return { ok: false, error: `${flag} 不接受取值` };
            if (mode !== 'setup') return { ok: false, error: '--refresh 与 --check 只能给一个' };
            mode = MODE_FLAGS[flag];
        } else {
            return { ok: false, error: '不支持的参数（不是本脚本认识的参数名；原始输入不回显）' };
        }
    }
    if (positional.length !== 1) return { ok: false, error: `需要恰好一个线名，收到 ${positional.length} 个位置参数` };
    const n = Object.keys(roots).length;
    if (n > 0 && n < Object.keys(ROOT_FLAGS).length) {
        const missing = Object.keys(ROOT_FLAGS).filter((f) => roots[ROOT_FLAGS[f]] === undefined);
        return { ok: false, error: `根路径覆盖参数必须全给或全不给，缺少 ${missing.join('、')}` };
    }
    return { ok: true, name: positional[0], mode, roots };
}

// ---------------------------------------------------------------- 生成与合并（纯函数）

/** 按主工作区 settings.local.json 生成线目录那份：additionalDirectories 追加主工作区根目录（已有同一绝对路径则不重复）。不改入参。 */
function buildLocal(mainLocal, mainRoot) {
    const out = clone(mainLocal);
    if (!isPlainObject(out.permissions)) out.permissions = {};
    const dirs = Array.isArray(out.permissions.additionalDirectories) ? out.permissions.additionalDirectories.slice() : [];
    if (!dirs.some((d) => sameAbsDir(d, mainRoot))) dirs.push(mainRoot);
    out.permissions.additionalDirectories = dirs;
    return out;
}
/** 只比带盘符的绝对路径（去掉末尾分隔符、win32 折叠大小写）；根相对（"\tmp"）与相对写法一律视为不同。 */
function sameAbsDir(entry, dir) {
    if (typeof entry !== 'string' || !/^[A-Za-z]:[\\/]/.test(entry)) return false;
    const norm = (p) => fold(path.resolve(p));
    return norm(entry) === norm(dir);
}

/**
 * refresh 合并：want 为按主工作区生成的内容，have 为线内现有内容（null = 不存在），prev 为上次生成的内容（生成记录里这一份；null = 没有记录，无从区分）。
 * 返回 { merged, kept: [{ list, entry }], dropped: [{ list, entry }], overridden: [键名] }：
 *   kept = 线内多出、上次生成里没有（线会话批准的），已接在主工作区条目之后；dropped = 线内多出、上次生成里有（主工作区已删掉的），已去掉；
 *   overridden = 线内现有内容与 merged 不同的键（以主工作区为准；含被去掉的线内独有键）。
 */
function mergeLineOnly(want, have, prev) {
    const merged = clone(want);
    const kept = [];
    const dropped = [];
    if (have === null) return { merged, kept, dropped, overridden: [] };
    const hp = isPlainObject(have.permissions) ? have.permissions : {};
    const pp = prev && isPlainObject(prev.permissions) ? prev.permissions : {};
    for (const k of PERM_LISTS) {
        const fromLine = Array.isArray(hp[k]) ? hp[k] : [];
        const base = isPlainObject(merged.permissions) && Array.isArray(merged.permissions[k]) ? merged.permissions[k] : [];
        const wasGenerated = new Set(prev && Array.isArray(pp[k]) ? pp[k] : []);
        const seen = new Set(base);
        const extra = [];
        for (const x of fromLine) {
            if (seen.has(x)) continue;
            seen.add(x);
            if (prev && wasGenerated.has(x)) dropped.push({ list: k, entry: x }); else extra.push(x);
        }
        if (extra.length === 0) continue;
        if (!isPlainObject(merged.permissions)) merged.permissions = {};
        merged.permissions[k] = base.concat(extra);
        for (const x of extra) kept.push({ list: k, entry: x });
    }
    const overridden = [];
    for (const k of new Set([...Object.keys(have), ...Object.keys(merged)])) {
        if (k === 'permissions') continue;
        if (!sameJson(have[k], merged[k])) overridden.push(k);
    }
    const mp = isPlainObject(merged.permissions) ? merged.permissions : {};
    for (const k of new Set([...Object.keys(hp), ...Object.keys(mp)])) {
        if (!sameJson(hp[k], mp[k])) overridden.push(`permissions.${k}`);
    }
    return { merged, kept, dropped, overridden };
}

// ---------------------------------------------------------------- 文件

/** 设置内容的形态问题（null = 没问题）：顶层是对象；permissions 若有须是对象，其四个列表若有须是字符串数组。设置文件与生成记录里的每一份同一口径。 */
function shapeProblem(obj) {
    if (!isPlainObject(obj)) return '顶层不是对象';
    if (obj.permissions === undefined) return null;
    if (!isPlainObject(obj.permissions)) return '的 permissions 不是对象';
    for (const k of PERM_LISTS) {
        const v = obj.permissions[k];
        if (v !== undefined && !(Array.isArray(v) && v.every((x) => typeof x === 'string'))) return `的 permissions.${k} 不是字符串数组`;
    }
    return null;
}

/** 读设置文件：不存在返回 null；不是普通文件、不是合法 JSON、形态不对（shapeProblem）一律拒绝（不回显内容）。返回 { raw, obj, sha256 }。调用方先做 assertChainSafe。 */
function readSettings(C, file, label) {
    const st = C.lstatOrNull(file);
    if (st === null) return null;
    if (st.isSymbolicLink() || !st.isFile()) throw new C.LineError('LINE_UNSAFE_PATH', `${label} 不是普通文件（链接或目录），拒绝：${file}`);
    const raw = fs.readFileSync(file);
    let obj;
    try { obj = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')); } catch (_) { throw new C.LineError('LINE_SESSION_BAD_JSON', `${label} 不是合法 JSON（内容不回显）：${file}`); }
    const why = shapeProblem(obj);
    if (why) throw new C.LineError('LINE_SESSION_BAD_JSON', `${label} ${why}（内容不回显）：${file}`);
    return { raw, obj, sha256: sha256(raw) };
}

// Windows 上改名替换遇到杀毒 / 索引器 / 正开着的会话瞬时占用会报 EPERM / EACCES / EBUSY：与 state.js 同口径，最多 12 次，间隔 20ms * 次数（上限 200ms）
const REPLACE_RETRY_CODES = Object.freeze(['EPERM', 'EACCES', 'EBUSY']);
const REPLACE_MAX_ATTEMPTS = 12;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const tmpNameOf = (file) => path.join(path.dirname(file), `.${path.basename(file)}.setup-session-${process.pid}.tmp`);
const TMP_RE = /^\..+\.setup-session-\d+\.tmp$/;

/** 新建（目标不得存在，wx）；写到一半失败时删掉这个新文件。 */
function writeNew(C, file, obj) {
    let created = false;
    try {
        const fd = fs.openSync(file, 'wx');
        created = true;
        try { fs.writeFileSync(fd, serialize(obj)); } finally { fs.closeSync(fd); }
    } catch (e) {
        if (created) { try { C.unlinkChecked(file); } catch (_) { /* 原错误优先 */ } }
        throw e;
    }
}
/**
 * 替换：先写同目录临时文件（wx）；每次改名之前都重读目标，核 sha256 仍是读到时的那份（线会话正开着时可能刚写进一条「总是允许」——不同就放弃，报 LINE_SESSION_CHANGED 请重跑；
 * 占用重试的等待期间同样可能被写入，所以每一轮都核，codex 48 H2）；改名遇 EPERM / EACCES / EBUSY 有界重试。任何一步失败都删临时文件。
 * 最后一次核对与改名之间仍有极短窗口（残余，见文件头）。
 */
function replaceFile(C, file, obj, expectSha) {
    const tmp = tmpNameOf(file);
    try { fs.writeFileSync(tmp, serialize(obj), { flag: 'wx' }); } catch (e) {
        // 写了一半（如磁盘满）也删掉；EEXIST 是同名文件原本就在（不是这次写的），不动它
        if (!(e && e.code === 'EEXIST') && C.lstatOrNull(tmp) !== null) { try { C.unlinkChecked(tmp); } catch (_) { /* 原错误优先 */ } }
        throw e;
    }
    let made = true;
    const unchanged = () => {
        const st = C.lstatOrNull(file);
        if (st === null || st.isSymbolicLink() || !st.isFile() || sha256(fs.readFileSync(file)) !== expectSha) {
            throw new C.LineError('LINE_SESSION_CHANGED', `${file} 在读取之后被改动过（可能是线目录会话刚写入），没有覆盖；请重跑`);
        }
    };
    try {
        let lastErr = null;
        for (let attempt = 1; attempt <= REPLACE_MAX_ATTEMPTS; attempt += 1) {
            unchanged();
            try { fs.renameSync(tmp, file); made = false; return; } catch (e) {
                lastErr = e;
                if (!e || !REPLACE_RETRY_CODES.includes(e.code)) break;
                sleepSync(Math.min(20 * attempt, 200));
            }
        }
        throw lastErr;
    } catch (e) {
        if (made) { try { C.unlinkChecked(tmp); } catch (_) { /* 原错误优先 */ } }
        throw e;
    }
}

// ---------------------------------------------------------------- 主流程

function findRecord(C, state, name) {
    const key = Object.keys(state.lines).find((k) => k.toLowerCase() === String(name).toLowerCase());
    if (key === undefined) throw new C.LineError('LINE_NO_SUCH_LINE', `没有这条线：${name}`);
    return state.lines[key];
}

/** 登记的 worktree 必须就是 <线目录根>/<线名>、分支 line/<线名>、lifecycle=ready；目录真实存在、不是链接 / 重解析点、根上有 .git 文件、不是主工作区。返回 worktree 真实路径。 */
function checkWorktree(C, ctx, rec) {
    if (rec.lifecycle !== 'ready') throw new C.LineError('LINE_NOT_READY', `线 ${rec.name} 的 lifecycle 是 ${rec.lifecycle}，只处理 ready 的线`);
    const linesReal = realOf(ctx.linesRoot);
    const wt = path.join(path.resolve(ctx.linesRoot), rec.name);
    if (!C.isNonEmptyString(rec.worktree) || !C.samePath(rec.worktree, wt) || rec.branch !== `line/${rec.name}`) {
        throw new C.LineError('LINE_UNSAFE_PATH', `线 ${rec.name} 的登记路径 / 分支（${rec.worktree} / ${rec.branch}）与线目录根推导的 ${wt} / line/${rec.name} 不一致，拒绝（请人工核对登记表）`);
    }
    const st = C.lstatOrNull(wt);
    if (st === null) throw new C.LineError('LINE_UNSAFE_PATH', `线 ${rec.name} 的 worktree 不存在：${wt}`);
    C.assertChainSafe(linesReal, rec.name);
    if (!st.isDirectory()) throw new C.LineError('LINE_UNSAFE_PATH', `线 ${rec.name} 的 worktree 不是目录：${wt}`);
    const wtReal = path.join(linesReal, rec.name);
    if (C.samePath(wtReal, ctx.mainRoot)) throw new C.LineError('LINE_UNSAFE_PATH', 'worktree 就是主工作区，拒绝');
    const g = C.lstatOrNull(path.join(wtReal, '.git'));
    if (g === null || !g.isFile()) throw new C.LineError('LINE_UNSAFE_PATH', `线 ${rec.name} 的 worktree 根没有 .git 文件（不是 linked worktree）：${wt}`);
    return wtReal;
}

/** 读主工作区两个来源：settings.local.json 必须有，settings.json 可无。 */
function readSources(C, mainRoot) {
    const mainReal = realOf(mainRoot);
    const out = {};
    for (const [k, base] of Object.entries(FILES)) {
        C.assertChainSafe(mainReal, path.join('.claude', base));
        out[k] = readSettings(C, path.join(mainReal, '.claude', base), `主工作区 .claude/${base}`);
    }
    if (out.local === null) throw new C.LineError('LINE_SESSION_SOURCE_MISSING', `主工作区没有 .claude/${FILES.local}，无可生成的内容`);
    return out;
}

/** 读生成记录：不存在返回 null；形态不对拒绝（它决定哪些条目算线内批准，不能猜）。 */
function readBase(C, wtReal) {
    C.assertChainSafe(wtReal, path.join('.claude', BASE_FILE));
    const file = path.join(wtReal, '.claude', BASE_FILE);
    const st = C.lstatOrNull(file);
    if (st === null) return null;
    if (st.isSymbolicLink() || !st.isFile()) throw new C.LineError('LINE_UNSAFE_PATH', `线目录 .claude/${BASE_FILE} 不是普通文件，拒绝：${file}`);
    let obj;
    try { obj = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (_) { obj = null; }
    // 每一份（非 null）与设置文件同一形态口径：内部 permissions 坏了不能当「上次没生成任何条目」去猜
    const okFile = (v) => v === null || shapeProblem(v) === null;
    if (!isPlainObject(obj) || obj.tool !== BASE_TOOL || obj.version !== 1 || !isPlainObject(obj.files) || !Object.values(FILES).every((b) => okFile(obj.files[b] === undefined ? null : obj.files[b]))) {
        throw new C.LineError('LINE_SESSION_BAD_JSON', `线目录 .claude/${BASE_FILE}（生成记录）形态不对，拒绝（内容不回显；确认无误后可人工删除它，下次 --refresh 会把线内多出的条目全部按线内独有保留）：${file}`);
    }
    return { obj, sha256: sha256(fs.readFileSync(file)) };
}
const baseOf = (want) => ({ tool: BASE_TOOL, version: 1, files: { [FILES.shared]: want.shared, [FILES.local]: want.local } });
/**
 * 上次生成的这一份（三态，codex 48 M1：不能用 {} 兼表「没生成过」与「生成过但为空」）：
 *   { state: 'unknown' }——没有生成记录，无从区分；{ state: 'none' }——有记录，当时没生成这个文件（记录里为 null）；{ state: 'generated', obj }——生成过（obj 可以是 {}）。
 * base 是生成记录对象（不是 readBase 的返回包）。
 */
function prevOf(base, file) {
    if (base === null) return { state: 'unknown', obj: null };
    const v = base.files[file];
    return v === null || v === undefined ? { state: 'none', obj: null } : { state: 'generated', obj: v };
}
/**
 * 写入中途的过渡记录：某份在旧记录或新生成里出现过，就记为「生成过」（不会被压成 null 或 {}）；它的四个权限列表取「新 ∪ 旧」，其余键取新（新没有就取旧）。
 * 设置文件写到一半失败时，下次 --refresh 按过渡记录区分——这一轮之前或这一轮生成过的条目都算「生成过」，主工作区后来删掉时能被去掉。没有旧记录时就是新记录。
 */
function unionBase(oldBase, newBase) {
    if (oldBase === null) return newBase;
    const files = {};
    for (const f of Object.values(FILES)) {
        const a = oldBase.files[f] || null;
        const b = newBase.files[f] || null;
        if (a === null && b === null) { files[f] = null; continue; }
        if (b === null) { files[f] = clone(a); continue; }   // 主工作区这一轮删掉了它：保留旧的「生成过」记录与内容
        const out = clone(b);
        const ap = a && isPlainObject(a.permissions) ? a.permissions : {};
        for (const k of PERM_LISTS) {
            const cur = isPlainObject(out.permissions) && Array.isArray(out.permissions[k]) ? out.permissions[k] : [];
            const extra = (Array.isArray(ap[k]) ? ap[k] : []).filter((x) => !cur.includes(x));
            if (extra.length === 0) continue;
            if (!isPlainObject(out.permissions)) out.permissions = {};
            out.permissions[k] = cur.concat(extra);
        }
        files[f] = out;
    }
    return { tool: BASE_TOOL, version: 1, files };
}

/** 读线目录现状：.claude、两个目标与生成记录逐级不得是链接；.claude\skills 是否存在；.claude 里本脚本之外的条目（只供 --check 提示）。 */
function readTargets(C, wtReal) {
    const dir = path.join(wtReal, '.claude');
    const out = { dir, dirExists: false, skills: false, others: [] };
    const ds = C.lstatOrNull(dir);
    if (ds !== null && (ds.isSymbolicLink() || !ds.isDirectory())) throw new C.LineError('LINE_UNSAFE_PATH', `线目录的 .claude 不是普通目录（链接或文件），拒绝：${dir}`);
    for (const [k, base] of Object.entries(FILES)) {
        C.assertChainSafe(wtReal, path.join('.claude', base));
        out[k] = readSettings(C, path.join(dir, base), `线目录 .claude/${base}`);
    }
    const b = readBase(C, wtReal);
    out.base = b === null ? null : b.obj;
    out.baseSha = b === null ? null : b.sha256;
    if (ds !== null) {
        out.dirExists = true;
        out.skills = C.lstatOrNull(path.join(dir, 'skills')) !== null;
        const mine = new Set([...Object.values(FILES), BASE_FILE].map(fold));
        out.others = fs.readdirSync(dir).filter((n) => !mine.has(fold(n))).sort();
    }
    return out;
}

/** 每个目标按主工作区应得的内容：{ shared: 对象 | null（主工作区没有就不生成）, local: 对象 }。 */
const wantOf = (src, mainRoot) => ({ shared: src.shared ? clone(src.shared.obj) : null, local: buildLocal(src.local.obj, mainRoot) });

/**
 * 计划：每个目标 { action: 'create' | 'replace' | 'same' | 'absent' | 'keep-line-only', merged, kept, dropped, overridden, noBase, mainGone }。
 * absent = 主工作区与线目录都没有这个文件；prev 见 prevOf（缺省按 unknown）；noBase = 线内有这个文件但没有生成记录（多出的条目全部按线内独有保留）。
 */
function planFor(want, have, prev) {
    const pv = prev || { state: 'unknown', obj: null };
    const prevObj = pv.state === 'generated' ? pv.obj : null;   // 给 mergeLineOnly：null = 没有「生成过」的条目可去掉
    if (want === null) {
        if (have === null) return { action: 'absent', merged: null, kept: [], dropped: [], overridden: [], noBase: false, mainGone: false };
        // 主工作区没有这个文件。上次生成过（generated，含内容为 {}）= 主工作区后来整份删掉了：去掉生成过的条目与其余键，只留线内独有的条目；
        //   上次没生成过（none）= 线内自己建的，保留不动；没有生成记录（unknown）= 无从区分，保留不动
        if (pv.state !== 'generated') return { action: 'keep-line-only', merged: null, kept: [], dropped: [], overridden: [], noBase: pv.state === 'unknown', mainGone: false };
        const g = mergeLineOnly({}, have.obj, prevObj);
        return Object.assign({ action: sameJson(have.obj, g.merged) ? 'keep-line-only' : 'replace', noBase: false, mainGone: true }, g);
    }
    const m = mergeLineOnly(want, have === null ? null : have.obj, prevObj);
    const action = have === null ? 'create' : (sameJson(have.obj, m.merged) ? 'same' : 'replace');
    return Object.assign({ action, noBase: have !== null && pv.state === 'unknown', mainGone: false }, m);
}

/** applied = 这次已按计划写入（setup / refresh）；false = 只读核对（--check），措辞用「刷新时会…」。 */
function describe(say, label, p, applied) {
    if (p.action === 'absent') { say(`  ${label}：主工作区与线目录都没有这个文件`); return; }
    if (p.action === 'keep-line-only') { say(`  ${label}：主工作区没有这个文件，线内这份${p.noBase ? '（没有生成记录，无从区分）' : '是线内自己的内容'}，保留不动`); return; }
    if (p.mainGone) say(`  ${label}：主工作区已整份删掉这个文件，${applied ? '已' : '刷新时会'}去掉上次由主工作区生成的内容，只留线内独有的条目`);
    if (p.action === 'same') say(`  ${label}：与按主工作区生成的内容一致`);
    if (p.kept.length > 0) {
        say(`  ${label}：线内独有的权限条目 ${p.kept.length} 条（${applied ? '保留' : '刷新时保留'}，接在主工作区条目之后）${p.noBase ? '——没有生成记录，无从区分「线会话批准」与「主工作区已删掉」，全部按线内独有保留' : ''}：`);
        for (const x of p.kept) say(`    permissions.${x.list}：${x.entry}`);
    }
    if (p.dropped.length > 0) {
        say(`  ${label}：主工作区已删掉的权限条目 ${p.dropped.length} 条（上次由主工作区生成，${applied ? '已从线内去掉' : '刷新时会去掉'}）：`);
        for (const x of p.dropped) say(`    permissions.${x.list}：${x.entry}`);
    }
    if (p.action === 'replace' && p.overridden.length > 0) say(`  ${label}：${applied ? '与线内原有内容不同、已按主工作区更新的键' : '与按主工作区生成的内容不同的键'}：${p.overridden.join('、')}`);
}

/**
 * ctx = { mainRoot, controlRoot, linesRoot, out(s) }（out 已经过脱敏）；args = { name, mode: 'setup' | 'refresh' | 'check' }。
 * 返回 { ok: true, mode, worktree, plans[, written] }；--check 不一致时抛 LINE_SESSION_CHECK_FAILED（入口转成退出码 1）。
 */
async function setupSession(ctx, args) {
    const C = require('./line-common');
    const S = require('./state');
    for (const k of ['controlRoot', 'linesRoot', 'mainRoot']) if (!C.isNonEmptyString(ctx && ctx[k])) throw new C.LineError('LINE_BAD_ARGS', `内部错误：缺少 ${k}`);
    const name = args && args.name;
    if (!C.isNonEmptyString(name)) throw new C.LineError('LINE_BAD_ARGS', '缺少线名');
    const problem = S.checkLineName(name);
    if (problem) throw new C.LineError('LINE_BAD_ARGS', `线名 ${JSON.stringify(name)} 非法：${problem}`);
    const mode = (args && args.mode) || 'setup';
    if (!['setup', 'refresh', 'check'].includes(mode)) throw new C.LineError('LINE_BAD_ARGS', `内部错误：未知模式 ${mode}`);
    const say = typeof ctx.out === 'function' ? ctx.out : (s) => console.log(s);

    const rec0 = findRecord(C, await S.readState(ctx.controlRoot), name);
    const wtReal0 = checkWorktree(C, ctx, rec0);

    if (mode === 'check') {
        const src = readSources(C, ctx.mainRoot);
        const want = wantOf(src, ctx.mainRoot);
        const tg = readTargets(C, wtReal0);
        const plans = { shared: planFor(want.shared, tg.shared, prevOf(tg.base, FILES.shared)), local: planFor(want.local, tg.local, prevOf(tg.base, FILES.local)) };
        const problems = [];
        if (tg.skills) problems.push(`线目录有 .claude${path.sep}skills：会挡住从主工作区读取项目 skills，请人工移走后再核对`);
        for (const [k, base] of Object.entries(FILES)) {
            const p = plans[k];
            if (p.action === 'create') problems.push(`.claude/${base} 不存在`);
            else if (p.action === 'replace') problems.push(`.claude/${base} 与按主工作区生成的内容不一致（差异键：${p.overridden.join('、') || '（无，只有权限条目要去掉）'}）`);
        }
        say(`线 ${rec0.name}：核对 ${wtReal0}${path.sep}.claude（只读）`);
        for (const [k, base] of Object.entries(FILES)) describe(say, `.claude/${base}`, plans[k], false);
        if (tg.base === null) say(`  .claude/${BASE_FILE}（生成记录）不存在：--refresh 会补写；在那之前线内多出的权限条目一律按线内独有对待`);
        else if (!sameJson(tg.base, baseOf(want))) say(`  .claude/${BASE_FILE}（生成记录）与按主工作区现在生成的不同：--refresh 会更新`);
        // 只提示、不算不一致（--refresh 不处理它们）：残留的临时文件、嵌套 worktree（线会话里用 EnterWorktree 建在这里，被 git 忽略，删线时连同未提交改动一起删掉）、其他条目
        for (const n of tg.others) {
            if (n !== 'skills') say(`  提示：.claude${path.sep}${n}${TMP_RE.test(n) ? ' 是本脚本残留的临时文件，可以删除' : (fold(n) === 'worktrees' ? ' 是嵌套 worktree 目录：删线前先把里面的改动提交或移走，删线会连同它一起删掉' : ' 不是本脚本写的')}`);
        }
        if (problems.length > 0) {
            for (const p of problems) say(`  不一致：${p}`);
            throw new C.LineError('LINE_SESSION_CHECK_FAILED', `线 ${rec0.name} 的会话设置与主工作区不一致 ${problems.length} 处（--refresh 可按主工作区重新生成）`);
        }
        say(`线 ${rec0.name}：会话设置与主工作区一致；additionalDirectories 含主工作区根目录`);
        return { ok: true, mode, worktree: wtReal0, plans };
    }

    return S.withLineLock(ctx.controlRoot, rec0.name, async () => {
        // 锁内重读：登记仍是同一代次、仍是 ready（防 remove / recover 抢在前面）
        const rec = findRecord(C, await S.readState(ctx.controlRoot), name);
        if (rec.generation !== rec0.generation) throw new C.LineError('LINE_SESSION_CHANGED', `线 ${rec0.name} 的登记在操作期间变了（代次不同），拒绝；请重跑`);
        const wtReal = checkWorktree(C, ctx, rec);
        const src = readSources(C, ctx.mainRoot);
        const want = wantOf(src, ctx.mainRoot);
        const tg = readTargets(C, wtReal);
        if (tg.skills) throw new C.LineError('LINE_SESSION_SKILLS_PRESENT', `线目录有 .claude${path.sep}skills：会挡住从主工作区读取项目 skills，拒绝；请人工移走后重跑`);
        if (mode === 'setup' && (tg.shared !== null || tg.local !== null || tg.base !== null)) {
            const exist = [...Object.entries(FILES).filter(([k]) => tg[k] !== null).map(([, b]) => `.claude/${b}`), ...(tg.base !== null ? [`.claude/${BASE_FILE}`] : [])];
            throw new C.LineError('LINE_SESSION_EXISTS', `线目录已有 ${exist.join('、')}，不覆盖；主工作区设置改过后用 --refresh，看差异用 --check`);
        }
        const plans = { shared: planFor(want.shared, tg.shared, prevOf(tg.base, FILES.shared)), local: planFor(want.local, tg.local, prevOf(tg.base, FILES.local)) };
        const newBase = baseOf(want);
        const baseAction = tg.base === null ? 'create' : (sameJson(tg.base, newBase) ? 'same' : 'replace');
        if (!tg.dirExists) {
            fs.mkdirSync(tg.dir);
            C.assertChainSafe(wtReal, '.claude');
        }
        const baseFile = path.join(tg.dir, BASE_FILE);
        let cur = tg.base;   // 盘上现在的生成记录（null = 没有）
        let curSha = tg.baseSha;
        const putBase = (obj) => {
            if (cur === null) writeNew(C, baseFile, obj); else replaceFile(C, baseFile, obj, curSha);
            cur = obj;
            curSha = sha256(Buffer.from(serialize(obj), 'utf8'));
        };
        const willWrite = Object.keys(FILES).some((k) => plans[k].action === 'create' || plans[k].action === 'replace');
        // 顺序：只要要写设置文件，先落过渡记录（旧 ∪ 新；没有旧记录时就是新记录，codex 48 H1）→ 设置文件 → 正式记录。
        //   中途失败时，下次 --refresh 按过渡记录区分，主工作区收回的条目不会被当成线内独有留下（见 unionBase）
        if (willWrite) {
            const mid = unionBase(cur, newBase);
            if (cur === null || !sameJson(mid, cur)) putBase(mid);
        }
        const written = [];
        for (const [k, base] of Object.entries(FILES)) {
            const p = plans[k];
            const file = path.join(tg.dir, base);
            if (p.action === 'create') { writeNew(C, file, p.merged); written.push(base); }
            else if (p.action === 'replace') { replaceFile(C, file, p.merged, tg[k].sha256); written.push(base); }
        }
        if (cur === null || !sameJson(cur, newBase)) putBase(newBase);
        say(`线 ${rec.name}：${mode === 'setup' ? '会话设置已写入' : (written.length > 0 ? '会话设置已刷新' : '会话设置无变化，未写入')} ${tg.dir}`);
        for (const [k, base] of Object.entries(FILES)) {
            const s = src[k];
            say(`  来源 主工作区 .claude/${base}：${s ? `sha256 ${s.sha256}` : '（不存在，不生成）'}`);
            describe(say, `.claude/${base}`, plans[k], true);
        }
        if (mode === 'refresh' && baseAction !== 'same') say(`  .claude/${BASE_FILE}（生成记录）：${baseAction === 'create' ? '原先没有，已补写' : '已更新为按主工作区现在生成的内容'}`);
        const lp = plans.local.merged.permissions;
        say(`  settings.local.json：permissions.allow ${Array.isArray(lp.allow) ? lp.allow.length : 0} 条；hooks 事件 ${isPlainObject(plans.local.merged.hooks) ? Object.keys(plans.local.merged.hooks).join('、') || '（无）' : '（无）'}`);
        const before = Array.isArray(src.local.obj.permissions && src.local.obj.permissions.additionalDirectories) ? src.local.obj.permissions.additionalDirectories : [];
        say(`  additionalDirectories：主工作区 ${JSON.stringify(before)} → 线目录 ${JSON.stringify(lp.additionalDirectories)}`);
        if (mode === 'setup') say(`下一步：在 ${wtReal} 启动 Claude Code 会话（项目记忆与 skills 自动用主工作区的）；主工作区 .claude 设置改过后跑 --refresh；删线仍在主工作区会话做`);
        return { ok: true, mode, worktree: wtReal, plans, written };
    });
}

// ---------------------------------------------------------------- 入口

/**
 * opts.realLinesRoot：「真实线目录根」，缺省 E:/sdh-lines；仅供测试把它指到临时目录（不经环境变量）。
 */
async function run(argv, scriptRoot, opts) {
    const realLinesRoot = (opts && opts.realLinesRoot) || DEFAULT_LINES_ROOT;
    // 转发判定之前先查覆盖参数「全给或全不给」（只认参数名，不回显取值）
    const present = Object.keys(ROOT_FLAGS).filter((f) => argv.some((t) => typeof t === 'string' && (t === f || t.startsWith(`${f}=`))));
    if (present.length > 0 && present.length < Object.keys(ROOT_FLAGS).length) {
        const missing = Object.keys(ROOT_FLAGS).filter((f) => !present.includes(f));
        console.error(`用法错误：根路径覆盖参数必须全给或全不给，缺少 ${missing.join('、')}\n${USAGE}`);
        return 2;
    }
    const fwd = decideForward({ argv, scriptRoot });
    if (fwd.error) { console.error(`错误：${fwd.error}`); return 1; }
    if (fwd.forward) {
        const target = path.join(fwd.mainRoot, 'scripts', 'lines', 'setup-session.js');
        if (!fs.existsSync(target)) { console.error('错误：主工作区里没有 scripts/lines/setup-session.js，无法转发（路径已隐藏）'); return 1; }
        if (fold(realOf(target)) === fold(realOf(__filename))) { console.error('错误：转发目标就是当前脚本，拒绝循环转发'); return 1; }
        return forwardRun(target, argv);
    }
    const parsed = parseArgv(argv);
    if (!parsed.ok) { console.error(`用法错误：${parsed.error}\n${USAGE}`); return 2; }
    if (parsed.help) { console.log(USAGE); return 0; }

    let redact = null;
    const emit = (e) => {
        if (redact === null && !(e && e.fixed === true)) { console.error(`错误[${safeCode(e)}]：初始化阶段失败（脱敏器尚未建立，详情已隐藏）`); return; }
        const rd = redact || ((t) => String(t));
        try { require('./line-common').scrubError(e, rd); } catch (_) { /* 脱敏失败时下面只输出脱敏后的 message */ }
        console.error(rd(`错误[${safeCode(e)}]：${e && e.message ? e.message : '（无消息）'}`));
    };
    try {
        const C = require('./line-common');
        const S = require('./state');
        const fixedBad = (msg) => new C.LineError('LINE_BAD_ARGS', msg, { fixed: true });
        let realMain = null;
        try { realMain = C.gitMainRoot(scriptRoot); } catch (_) { realMain = null; }
        if (Object.keys(parsed.roots).length > 0) {
            // 覆盖参数指向真实环境一律拒绝（与 line.js 同口径；在读 .env、碰任何东西之前；文案写死，不回显取值）
            let realDefaultControl = null;
            try { realDefaultControl = S.resolveControlRoot({ cwd: scriptRoot }); } catch (_) { realDefaultControl = null; }
            if (realDefaultControl !== null && C.pathKey(parsed.roots.controlRoot) === C.pathKey(realDefaultControl)) throw fixedBad('--control-root 指向真实主工作区的默认控制根：测试覆盖参数不得用来读真实登记表');
            if (realMain !== null && C.pathKey(parsed.roots.mainRoot) === C.pathKey(realMain)) throw fixedBad('--main-root 指向脚本所在检出的真实主仓库：测试覆盖参数不得用来读真实主工作区设置');
            let overrideOwner = null;
            try { overrideOwner = C.gitMainRoot(parsed.roots.mainRoot); } catch (_) { overrideOwner = null; }
            if (overrideOwner !== null && realMain !== null && C.pathKey(overrideOwner) === C.pathKey(realMain)) throw fixedBad('--main-root 属于脚本所在检出的真实仓库（它的某个 worktree）：测试覆盖参数不得指向真实仓库');
            if (C.pathKey(parsed.roots.linesRoot) === C.pathKey(realLinesRoot) || C.isInside(path.resolve(realLinesRoot), path.resolve(parsed.roots.linesRoot))) throw fixedBad('--lines-root 等于或位于真实线目录根之内：测试覆盖参数不得用来写真实线目录');
        }
        const mainRoot = parsed.roots.mainRoot || realMain || C.gitMainRoot(scriptRoot);
        redact = C.loadMainEnv(mainRoot).redact;
        const ctx = {
            mainRoot,
            controlRoot: parsed.roots.controlRoot !== undefined ? parsed.roots.controlRoot : S.resolveControlRoot({ cwd: scriptRoot }),
            linesRoot: parsed.roots.linesRoot || path.resolve(realLinesRoot),
            out: (s) => console.log(redact(s)),
        };
        await setupSession(ctx, { name: parsed.name, mode: parsed.mode });
        return 0;
    } catch (e) {
        emit(e);
        return e && e.code === 'LINE_BAD_ARGS' ? 2 : 1;
    }
}

if (require.main === module) {
    run(process.argv.slice(2), path.resolve(__dirname, '..', '..')).then((code) => { process.exitCode = code; }, (e) => { console.error(`错误[${safeCode(e)}]：入口发生未处理的异常（详情已隐藏）`); process.exitCode = 1; });
}

module.exports = { parseArgv, buildLocal, sameAbsDir, mergeLineOnly, planFor, unionBase, setupSession, run, USAGE };
