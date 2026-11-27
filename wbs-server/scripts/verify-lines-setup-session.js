/**
 * #199 验证：线目录会话准备 scripts/lines/setup-session.js。单文件自检，不需要监督模块；纯 node，不起服务，约 20–40 秒。
 *
 * 全部在 os.tmpdir() 下 mkdtemp 的私有目录里执行（其下再建「中文 + 空格」子目录）：每个用例自建一套假主工作区（.claude 两个设置文件，不是 git 仓库）、
 *   控制根（登记由 state.js 的 createLine / updateLine 写入）、线目录根（假 worktree = 目录 + .git 文件，不建真 worktree）。
 * 被测命令以子进程运行 node <被测目录>/setup-session.js <线名> [--refresh | --check] --control-root <临时> --lines-root <临时> --main-root <临时>；纯函数在进程内调。
 * 不碰真实登记表、真实线目录与主工作区 .claude（第 8 节把真实路径当参数传入，只断言在动任何东西之前就被拒）；不起服务。
 * 清理用 line-common 的 deleteTreeNoFollow（逐项 unlink / rmdir，链接只拆不跟随），不用 fs.rmSync；全部通过才清理，有失败保留现场并打印位置。
 *
 * 节：1 正常写入（含 BOM 来源、主工作区路径带中文与空格）  2 再跑 setup 拒绝  3 --check 一致且不写  4 --refresh 无变化不写
 *   5 主工作区改动 + 线内独有条目：--check 报不一致 → --refresh 保留线内条目、去掉主工作区已删的条目、其余按主工作区 → 再 --check 一致；主工作区没有 settings.json 的情形
 *     （线内自己建的保留且 --check 通过；主工作区整份删掉 → 去掉生成过的条目）；生成记录缺失（全部保留并补写）/ 形态不对含内部形态（拒绝）/ 只剩生成记录时 setup 拒绝；
 *     --check 对残留临时文件与嵌套 worktree 只提示；.claude 不存在时 --refresh 写齐
 *   6 拒绝（setup 与 --check 两侧都核错误码）：未登记 / 非 ready / worktree 不存在 / 登记路径不符 / 分支不符 / worktree 根没有 .git 文件 / worktree 是联接 / .claude 是联接或普通文件 /
 *     目标与生成记录的位置是目录联接 / 已有 .claude\skills（先写好再建，--check 失败只因 skills）/ 主工作区缺 settings.local.json / 来源不是合法 JSON（内容不回显）/
 *     permissions.allow 形态不对 / 线内设置文件不是合法 JSON / 主工作区 .claude 是联接 / worktree 就是主工作区；对照：.claude 是空的普通目录
 *   7 用法错误（退出码 2）与「help」按线名处理  8 根覆盖参数指向真实环境（退出码 2；8.3 在主工作区跑时取真实仓库的另一个 worktree，没有就打 NOTE 不计数）
 *   9 纯函数（buildLocal / sameAbsDir / mergeLineOnly / planFor / unionBase）  10 进程内注入：锁内代次变化、读取与改名之间线会话写入（都应报 LINE_SESSION_CHANGED）
 * 每个拒绝用例都断言「什么都没写」：线目录与主工作区 .claude 的文件快照（相对路径 → sha256 / 链接目标）前后全等、登记表文件逐字节不变。
 * 对照口径：拒绝用例的夹具与第 1 节正常用例相同，只多一处扰动（prep），第 1 节即它们的「合法写法应通过」对照。
 *
 * 未覆盖（登记）：①目标文件是文件符号链接——本机无开发者模式建不了（EPERM），代码按 assertChainSafe + lstat 拒绝，与 6.16 的目录联接走同一判据；
 *   ②转发（在线检出里不带根覆盖参数运行 → 转发到主工作区那份）——要碰真实主工作区，不测；判定本身复用 line.js 的 decideForward / forwardRun；
 *   ③输出脱敏——走 line-common.loadMainEnv，由线路工具其他套件覆盖，本套件不写主工作区机密配置文件（测试隔离静态守卫 T2）；
 *   ④改名遇占用的有界重试、写到一半失败后的过渡生成记录——要注入文件系统错误，只由纯函数用例（9.7）与代码审查覆盖。
 *
 * 运行：node wbs-server/scripts/verify-lines-setup-session.js [--lines-dir=<被测 scripts/lines 目录的绝对路径>]
 *   --lines-dir 仅供变异演练；缺省为本检出的 scripts/lines。输出末行 `汇总：PASS=<n> FAIL=<n>`，有失败退出码 1。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const argLines = process.argv.slice(2).find((a) => a.startsWith('--lines-dir='));
const LINES_DIR = argLines ? path.resolve(argLines.slice('--lines-dir='.length)) : path.resolve(__dirname, '..', '..', 'scripts', 'lines');
const SCRIPT = path.join(LINES_DIR, 'setup-session.js');
const C = require(path.join(LINES_DIR, 'line-common'));
const S = require(path.join(LINES_DIR, 'state'));
const M = require(SCRIPT);

let PASS = 0;
let FAIL = 0;
function check(id, desc, cond, detail) {
    if (cond) { PASS += 1; console.log(`PASS ${id} ${desc}`); return; }
    FAIL += 1;
    console.log(`FAIL ${id} ${desc}${detail === undefined ? '' : `\n     ${JSON.stringify(detail).slice(0, 1500)}`}`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sdh-setup-session-'));
const ROOT = path.join(TMP, '会话 准备');
fs.mkdirSync(ROOT);
const NAME = 'demo-line';
const BASE = 'setup-session-base.json';
const THREE = ['settings.json', 'settings.local.json', BASE];
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
/** \u7EBF\u76EE\u5F55\u751F\u6210\u8BB0\u5F55\uFF1A\u8BFB\u4E0D\u5230\uFF08\u4E0D\u5B58\u5728 / \u4E0D\u662F JSON\uFF09\u8FD4\u56DE null\u2014\u2014\u88AB\u6D4B\u4EE3\u7801\u5199\u9519\u65F6\u65AD\u8A00\u5224\u7EA2\uFF0C\u800C\u4E0D\u662F\u629B\u5F02\u5E38\u4E2D\u65AD\u6574\u4E2A\u5957\u4EF6\u3002 */
const baseOfLine = (f) => { try { return readJson(path.join(f.claude, BASE)); } catch (_) { return null; } };
const J = (v) => JSON.stringify(v);

const MAIN_SHARED = { permissions: { allow: ['Bash(python:*)'] } };
const MAIN_LOCAL = {
    permissions: { allow: ['Bash(git status)', 'Read(//tmp/**)'], additionalDirectories: ['\\tmp'] },
    enableAllProjectMcpServers: false,
    hooks: { PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'node "X:/main/.claude/hooks/check.js"', timeout: 10 }] }] },
};

/** 一套夹具：<ROOT>/<tag>/{主 工作区, control, lines/<NAME>}。opt.lifecycle / opt.noWorktree / opt.noGit / opt.worktreeReg / opt.local（来源内容，null = 不写）/ opt.shared / opt.bom */
let seq = 0;
async function fixture(tag, opt) {
    const o = opt || {};
    seq += 1;
    const base = path.join(ROOT, `${String(seq).padStart(2, '0')}-${tag}`);
    const main = path.join(base, '主 工作区');
    const control = path.join(base, 'control');
    const lines = path.join(base, 'lines');
    const wt = path.join(lines, NAME);
    fs.mkdirSync(path.join(main, '.claude'), { recursive: true });
    fs.mkdirSync(lines, { recursive: true });
    const local = o.local === undefined ? MAIN_LOCAL : o.local;
    const shared = o.shared === undefined ? MAIN_SHARED : o.shared;
    const bom = o.bom ? '\uFEFF' : '';
    if (local !== null) fs.writeFileSync(path.join(main, '.claude', 'settings.local.json'), typeof local === 'string' ? local : bom + JSON.stringify(local, null, 2));
    if (shared !== null) fs.writeFileSync(path.join(main, '.claude', 'settings.json'), JSON.stringify(shared, null, 2));
    if (!o.noWorktree) {
        fs.mkdirSync(wt);
        if (!o.noGit) fs.writeFileSync(path.join(wt, '.git'), 'gitdir: X:/fake/.git/worktrees/demo-line\n');
    }
    await S.createLine(control, NAME, { module: 'mod-x', branch: o.branchReg || `line/${NAME}`, worktree: o.worktreeReg || wt, surface: 'x' });
    const lc = o.lifecycle || 'ready';
    if (lc === 'ready') await S.updateLine(control, NAME, (r) => { r.lifecycle = 'ready'; });
    if (lc === 'failed') await S.updateLine(control, NAME, (r) => { r.lifecycle = 'failed'; r.failed_step = 'test'; });
    return { base, main, control, lines, wt, claude: path.join(wt, '.claude') };
}

function runCli(f, args) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args, '--control-root', f.control, '--lines-root', f.lines, '--main-root', f.main], { cwd: TMP, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, error: r.error ? r.error.code : null };
}

/** 目录快照：相对路径 → 'file:<sha256>' / 'dir' / 'link:<目标>'（不跟随链接）；目录不存在返回 null。 */
function snap(dir) {
    if (C.lstatOrNull(dir) === null) return null;
    const out = {};
    const walk = (d, rel) => {
        for (const n of fs.readdirSync(d).sort()) {
            const p = path.join(d, n);
            const r = rel ? `${rel}/${n}` : n;
            const st = fs.lstatSync(p);
            if (st.isSymbolicLink()) out[r] = `link:${fs.readlinkSync(p)}`;
            else if (st.isDirectory()) { out[r] = 'dir'; walk(p, r); } else out[r] = `file:${sha(fs.readFileSync(p))}`;
        }
    };
    walk(dir, '');
    return out;
}
const regBytes = (f) => sha(fs.readFileSync(path.join(f.control, 'lines.json')));
/** 拒绝用例的「什么都没变」：线目录、主工作区 .claude、登记表。 */
function freeze(f) { return { wt: J(snap(f.wt)), main: J(snap(path.join(f.main, '.claude'))), reg: regBytes(f) }; }
const sameFreeze = (a, b) => a.wt === b.wt && a.main === b.main && a.reg === b.reg;

async function main() {
    // ---------------------------------------------------------------- 1 正常写入
    {
        const f = await fixture('setup', { bom: true });
        const mainBefore = J(snap(path.join(f.main, '.claude')));
        const r = runCli(f, [NAME]);
        check('1.1', 'setup 退出码 0，输出含「已写入」与主工作区 settings.local.json 的 sha256', r.status === 0 && /会话设置已写入/.test(r.out) && r.out.includes(sha(fs.readFileSync(path.join(f.main, '.claude', 'settings.local.json')))), r);
        const shared = readJson(path.join(f.claude, 'settings.json'));
        const local = readJson(path.join(f.claude, 'settings.local.json'));
        check('1.2', 'settings.json 与主工作区内容全等', J(shared) === J(MAIN_SHARED), shared);
        check('1.3', 'settings.local.json：allow / hooks / 其余键与主工作区全等，additionalDirectories 恰为 [\\tmp, 主工作区根目录]（带中文与空格）',
            J(local.permissions.allow) === J(MAIN_LOCAL.permissions.allow) && J(local.hooks) === J(MAIN_LOCAL.hooks) && local.enableAllProjectMcpServers === false
            && J(local.permissions.additionalDirectories) === J(['\\tmp', f.main]) && J(Object.keys(local).sort()) === J(Object.keys(MAIN_LOCAL).sort()), local);
        check('1.4', '线目录 .claude 下恰好两个设置文件 + 生成记录、没有 skills；主工作区 .claude 不变', J(Object.keys(snap(f.claude))) === J(THREE) && J(snap(path.join(f.main, '.claude'))) === mainBefore, snap(f.claude));
        const baseRec = baseOfLine(f) || { files: {} };
        check('1.5', '生成记录 = { tool, version: 1, files: 两份按主工作区生成的内容 }', baseRec.tool === 'setup-session' && baseRec.version === 1 && J(baseRec.files['settings.json']) === J(MAIN_SHARED) && J(baseRec.files['settings.local.json']) === J(local), baseRec);

        // ------------------------------------------------------------ 2 再跑 setup
        const before = freeze(f);
        const r2 = runCli(f, [NAME]);
        check('2.1', '目标已存在时再跑 setup：退出码 1、LINE_SESSION_EXISTS、提示 --refresh，什么都没变', r2.status === 1 && /LINE_SESSION_EXISTS/.test(r2.out) && /--refresh/.test(r2.out) && sameFreeze(before, freeze(f)), r2);

        // ------------------------------------------------------------ 3 --check 一致
        const mt = fs.statSync(path.join(f.claude, 'settings.local.json')).mtimeMs;
        const r3 = runCli(f, [NAME, '--check']);
        check('3.1', '--check：退出码 0、报一致，什么都没变（含 mtime）', r3.status === 0 && /与主工作区一致/.test(r3.out) && sameFreeze(before, freeze(f)) && fs.statSync(path.join(f.claude, 'settings.local.json')).mtimeMs === mt, r3);

        // ------------------------------------------------------------ 4 --refresh 无变化
        const mtBase = fs.statSync(path.join(f.claude, BASE)).mtimeMs;
        const r4 = runCli(f, [NAME, '--refresh']);
        check('4.1', '--refresh 无变化：退出码 0、输出「无变化，未写入」，三个文件都不变（含 settings.local.json 与生成记录的 mtime，生成记录没被无谓重写）',
            r4.status === 0 && /无变化，未写入/.test(r4.out) && sameFreeze(before, freeze(f)) && fs.statSync(path.join(f.claude, 'settings.local.json')).mtimeMs === mt && fs.statSync(path.join(f.claude, BASE)).mtimeMs === mtBase, r4);

        // ------------------------------------------------------------ 5 主工作区改动 + 线内独有条目
        const newMain = JSON.parse(JSON.stringify(MAIN_LOCAL));
        newMain.permissions.allow = ['Bash(new-first)', 'Bash(git status)'];   // 删一条、加一条、改顺序
        newMain.hooks = { PreToolUse: [{ matcher: 'Workflow', hooks: [{ type: 'command', command: 'node -v' }] }] };
        fs.writeFileSync(path.join(f.main, '.claude', 'settings.local.json'), JSON.stringify(newMain, null, 2));
        const lineNow = readJson(path.join(f.claude, 'settings.local.json'));
        lineNow.permissions.allow.push('Bash(line-only approval)');
        lineNow.permissions.additionalDirectories.push('D:\\线内 目录');
        lineNow.localOnlyKey = 1;
        fs.writeFileSync(path.join(f.claude, 'settings.local.json'), JSON.stringify(lineNow, null, 2));
        const before5 = freeze(f);
        const r5a = runCli(f, [NAME, '--check']);
        check('5.1', '主工作区改过：--check 退出码 1、LINE_SESSION_CHECK_FAILED、列出差异键（hooks、permissions.allow）、线内独有条目与「刷新时会去掉」的主工作区已删条目，什么都没写',
            r5a.status === 1 && /LINE_SESSION_CHECK_FAILED/.test(r5a.out) && /hooks/.test(r5a.out) && /permissions\.allow/.test(r5a.out) && r5a.out.includes('Bash(line-only approval)')
            && /主工作区已删掉的权限条目 1 条（上次由主工作区生成，刷新时会去掉）/.test(r5a.out) && r5a.out.includes('Read(//tmp/**)') && sameFreeze(before5, freeze(f)), r5a);
        const r5b = runCli(f, [NAME, '--refresh']);
        const after = readJson(path.join(f.claude, 'settings.local.json'));
        check('5.2', '--refresh：退出码 0；allow = 主工作区新条目 + 线内独有条目（接在后面），主工作区删掉的 Read(//tmp/**) 已去掉；hooks 用主工作区新的；线内独有的其他键被去掉',
            r5b.status === 0 && J(after.permissions.allow) === J(['Bash(new-first)', 'Bash(git status)', 'Bash(line-only approval)']) && J(after.hooks) === J(newMain.hooks) && after.localOnlyKey === undefined
            && /主工作区已删掉的权限条目 1 条（上次由主工作区生成，已从线内去掉）/.test(r5b.out), { r5b, after });
        const base5 = baseOfLine(f) || { files: {} };
        check('5.2b', '--refresh 后生成记录更新为主工作区现在生成的内容（不含线内独有条目）', J(base5.files['settings.local.json']?.permissions?.allow) === J(newMain.permissions.allow) && /生成记录）：已更新/.test(r5b.out), base5);
        check('5.3', '--refresh：additionalDirectories = 主工作区的 + 主工作区根目录（恰一次）+ 线内独有目录；输出列出两条线内独有条目与 localOnlyKey',
            J(after.permissions.additionalDirectories) === J(['\\tmp', f.main, 'D:\\线内 目录']) && r5b.out.includes('Bash(line-only approval)') && r5b.out.includes('D:\\线内 目录') && /localOnlyKey/.test(r5b.out), { dirs: after.permissions.additionalDirectories, out: r5b.out });
        check('5.4', '--refresh 不碰主工作区 .claude 与 settings.json（主工作区那份没变）', J(snap(path.join(f.main, '.claude'))) === before5.main && J(readJson(path.join(f.claude, 'settings.json'))) === J(MAIN_SHARED), null);
        const r5c = runCli(f, [NAME, '--check']);
        check('5.5', '刷新后再 --check：退出码 0（线内独有条目已计入，不算不一致）', r5c.status === 0, r5c);
        const leftovers = fs.readdirSync(f.claude).filter((n) => n.endsWith('.tmp'));
        check('5.6', '替换不留临时文件', leftovers.length === 0, leftovers);
    }
    {
        // 主工作区没有 settings.json：setup 只写 settings.local.json；线内后来有了 settings.json → --refresh 保留不动、--check 报不一致
        const f = await fixture('no-shared', { shared: null });
        const r = runCli(f, [NAME]);
        check('5.7', '主工作区没有 settings.json：setup 退出码 0、只写 settings.local.json 与生成记录（记录里 settings.json 为 null）',
            r.status === 0 && J(Object.keys(snap(f.claude))) === J(['settings.local.json', BASE]) && baseOfLine(f)?.files?.['settings.json'] === null, { r, s: snap(f.claude) });
        const rc = runCli(f, [NAME, '--check']);
        check('5.8', '两边都没有 settings.json 时 --check 退出码 0、写明「都没有」', rc.status === 0 && /都没有这个文件/.test(rc.out), rc);
        fs.writeFileSync(path.join(f.claude, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(x)'] } }));
        const shBefore = sha(fs.readFileSync(path.join(f.claude, 'settings.json')));
        const rr = runCli(f, [NAME, '--refresh']);
        check('5.9', '主工作区没有、线内有 settings.json：--refresh 退出码 0、保留不动', rr.status === 0 && /保留不动/.test(rr.out) && sha(fs.readFileSync(path.join(f.claude, 'settings.json'))) === shBefore, rr);
        const rc2 = runCli(f, [NAME, '--check']);
        check('5.10', '同上情形（线内自己建的、生成记录里这份为 null）--check 退出码 0，写明「是线内自己的内容，保留不动」（--refresh 也不会动它）',
            rc2.status === 0 && /settings\.json：主工作区没有这个文件，线内这份是线内自己的内容，保留不动/.test(rc2.out), rc2);
    }
    {
        // 预筛 MED-1：主工作区整份删掉 settings.json → 上次由主工作区生成的条目随之去掉，线内独有条目保留
        const f = await fixture('main-drops-shared');
        runCli(f, [NAME]);
        const lineShared = readJson(path.join(f.claude, 'settings.json'));
        lineShared.permissions.allow.push('Bash(line-shared approval)');
        lineShared.extraKey = 1;
        fs.writeFileSync(path.join(f.claude, 'settings.json'), JSON.stringify(lineShared, null, 2));
        fs.unlinkSync(path.join(f.main, '.claude', 'settings.json'));
        const before = freeze(f);
        const rc = runCli(f, [NAME, '--check']);
        check('5.16', '主工作区整份删掉 settings.json：--check 退出码 1，写明「已整份删掉」、点名要去掉的 Bash(python:*)，什么都没写',
            rc.status === 1 && /主工作区已整份删掉这个文件，刷新时会去掉/.test(rc.out) && /刷新时会去掉）/.test(rc.out) && rc.out.includes('Bash(python:*)') && sameFreeze(before, freeze(f)), rc);
        const rr = runCli(f, [NAME, '--refresh']);
        const sh = readJson(path.join(f.claude, 'settings.json'));
        check('5.17', '--refresh：线内 settings.json 只剩线内独有条目（Bash(python:*) 与其余键已去掉）；生成记录里 settings.json 变为 null',
            rr.status === 0 && J(sh) === J({ permissions: { allow: ['Bash(line-shared approval)'] } }) && baseOfLine(f)?.files?.['settings.json'] === null, { rr, sh });
        const rc2 = runCli(f, [NAME, '--check']);
        check('5.18', '刷新后 --check 退出码 0（剩下的是线内自己的内容）', rc2.status === 0 && /是线内自己的内容，保留不动/.test(rc2.out), rc2);
    }
    {
        // --check 对 .claude 里其他条目只提示、不算不一致；--refresh 不动它们
        const f = await fixture('others');
        runCli(f, [NAME]);
        fs.writeFileSync(path.join(f.claude, '.settings.local.json.setup-session-99999.tmp'), 'x');
        fs.mkdirSync(path.join(f.claude, 'worktrees'));
        const rc = runCli(f, [NAME, '--check']);
        check('5.15', '残留临时文件与嵌套 worktree 目录：--check 退出码 0，分别提示「残留的临时文件」与「嵌套 worktree」',
            rc.status === 0 && /是本脚本残留的临时文件/.test(rc.out) && /是嵌套 worktree 目录/.test(rc.out), rc);
    }
    {
        // 生成记录内部形态坏了（预筛 LOW-3）：拒绝，不当「上次没生成」去猜
        const f = await fixture('bad-base-inner');
        runCli(f, [NAME]);
        const b = baseOfLine(f) || { tool: 'setup-session', version: 1, files: {} };
        b.files['settings.local.json'] = { permissions: { allow: 'Bash(x)' } };
        fs.writeFileSync(path.join(f.claude, BASE), JSON.stringify(b));
        const before = freeze(f);
        const rr = runCli(f, [NAME, '--refresh']);
        check('5.19', '生成记录里某份的 permissions.allow 不是字符串数组：--refresh 退出码 1、LINE_SESSION_BAD_JSON，什么都没变', rr.status === 1 && /LINE_SESSION_BAD_JSON/.test(rr.out) && sameFreeze(before, freeze(f)), rr);
    }
    {
        // .claude 不存在时直接 --refresh：按「目标不存在就新建」写齐三个文件
        const f = await fixture('refresh-fresh');
        const rr = runCli(f, [NAME, '--refresh']);
        check('5.20', '.claude 不存在时 --refresh：退出码 0、写齐两个设置文件与生成记录（内容同 setup）',
            rr.status === 0 && J(Object.keys(snap(f.claude))) === J(THREE) && J(readJson(path.join(f.claude, 'settings.json'))) === J(MAIN_SHARED), rr);
    }
    {
        // 生成记录缺失：无从区分 → 线内多出的条目全部保留并说明；--refresh 补写记录
        const f = await fixture('no-base');
        runCli(f, [NAME]);
        fs.unlinkSync(path.join(f.claude, BASE));
        const m2 = JSON.parse(JSON.stringify(MAIN_LOCAL));
        m2.permissions.allow = ['Bash(git status)'];   // 主工作区删掉 Read(//tmp/**)
        fs.writeFileSync(path.join(f.main, '.claude', 'settings.local.json'), JSON.stringify(m2, null, 2));
        const before = freeze(f);
        const rc = runCli(f, [NAME, '--check']);
        check('5.11', '生成记录缺失：--check 退出码 0（设置文件不会被改），说明「没有生成记录」且记录会被补写，什么都没写',
            rc.status === 0 && /没有生成记录，无从区分/.test(rc.out) && /生成记录）不存在：--refresh 会补写/.test(rc.out) && sameFreeze(before, freeze(f)), rc);
        const rr = runCli(f, [NAME, '--refresh']);
        const loc = readJson(path.join(f.claude, 'settings.local.json'));
        check('5.12', '生成记录缺失时 --refresh：Read(//tmp/**) 按线内独有保留，设置文件不改，生成记录已补写',
            rr.status === 0 && J(loc.permissions.allow) === J(['Bash(git status)', 'Read(//tmp/**)']) && /原先没有，已补写/.test(rr.out) && /会话设置无变化，未写入/.test(rr.out)
            && J(baseOfLine(f)?.files?.['settings.local.json']?.permissions?.allow) === J(['Bash(git status)']), { rr, loc });
    }
    {
        // 生成记录形态不对：拒绝（它决定哪些条目算线内批准，不能猜）
        const f = await fixture('bad-base');
        runCli(f, [NAME]);
        fs.writeFileSync(path.join(f.claude, BASE), JSON.stringify({ tool: 'other', version: 1, files: {} }));
        const before = freeze(f);
        const rr = runCli(f, [NAME, '--refresh']);
        const rc = runCli(f, [NAME, '--check']);
        check('5.13', '生成记录形态不对：--refresh 与 --check 都退出码 1、LINE_SESSION_BAD_JSON，什么都没变', rr.status === 1 && rc.status === 1 && /LINE_SESSION_BAD_JSON/.test(rr.out) && /LINE_SESSION_BAD_JSON/.test(rc.out) && sameFreeze(before, freeze(f)), { rr, rc });
        fs.unlinkSync(path.join(f.claude, 'settings.json'));
        fs.unlinkSync(path.join(f.claude, 'settings.local.json'));
        fs.writeFileSync(path.join(f.claude, BASE), JSON.stringify({ tool: 'setup-session', version: 1, files: {} }));
        const before2 = freeze(f);
        const rs = runCli(f, [NAME]);
        check('5.14', '只剩生成记录时 setup 仍拒绝（LINE_SESSION_EXISTS，点名生成记录）', rs.status === 1 && /LINE_SESSION_EXISTS/.test(rs.out) && rs.out.includes(BASE) && sameFreeze(before2, freeze(f)), rs);
    }

    // ---------------------------------------------------------------- 6 拒绝
    const refuse = async (id, desc, tag, opt, prep, codeRe, extra) => {
        const f = await fixture(tag, opt);
        if (prep) prep(f);
        const before = freeze(f);
        const decoyBefore = f.decoy ? J(snap(f.decoy)) : null;
        const who = (opt && opt.callName) || NAME;
        const r = runCli(f, [who]);
        const rc = runCli(f, [who, '--check']);
        // 两侧都核错误码（预筛 MED-2：只核 --check 的退出码时，「设置文件不存在」本身就会让它退出 1，拒绝分支坏了也判不出来）
        const ok = r.status === 1 && codeRe.test(r.out) && rc.status === 1 && codeRe.test(rc.out) && !/LINE_SESSION_CHECK_FAILED/.test(rc.out)
            && sameFreeze(before, freeze(f)) && (f.decoy ? J(snap(f.decoy)) === decoyBefore : true) && (extra ? extra(r, f) : true);
        check(id, `${desc}：setup 与 --check 都退出码 1、都报 ${codeRe.source}，线目录 / 主工作区 .claude / 登记表 / 联接目标都没变`, ok, { r, rc });
    };
    await refuse('6.1', '线未登记（按另一个线名调用）', 'unreg', { callName: 'ghost-line' }, (f) => { fs.mkdirSync(path.join(f.lines, 'ghost-line')); }, /LINE_NO_SUCH_LINE/,
        (r, f) => C.lstatOrNull(path.join(f.lines, 'ghost-line', '.claude')) === null);
    await refuse('6.2', 'lifecycle=failed', 'failed', { lifecycle: 'failed' }, null, /LINE_NOT_READY/);
    await refuse('6.3', 'lifecycle=creating', 'creating', { lifecycle: 'creating' }, null, /LINE_NOT_READY/);
    await refuse('6.4', 'worktree 不存在', 'no-wt', { noWorktree: true }, null, /LINE_UNSAFE_PATH/);
    await refuse('6.5', '登记的 worktree 路径与线目录根推导的不符', 'reg-mismatch', { worktreeReg: path.join(ROOT, 'elsewhere', NAME) }, null, /LINE_UNSAFE_PATH/,
        () => C.lstatOrNull(path.join(ROOT, 'elsewhere')) === null);
    await refuse('6.6', 'worktree 根没有 .git 文件', 'no-git', { noGit: true }, null, /LINE_UNSAFE_PATH/);
    await refuse('6.7', 'worktree 本身是联接', 'wt-junction', { noWorktree: true }, (f) => {
        f.decoy = path.join(f.base, 'decoy-wt');
        fs.mkdirSync(f.decoy);
        fs.writeFileSync(path.join(f.decoy, '.git'), 'gitdir: X:/fake\n');
        fs.symlinkSync(f.decoy, f.wt, 'junction');
    }, /LINE_UNSAFE_PATH/);
    await refuse('6.8', '.claude 是联接（指向别处的目录）', 'claude-junction', {}, (f) => {
        f.decoy = path.join(f.base, 'decoy-claude');
        fs.mkdirSync(f.decoy);
        fs.symlinkSync(f.decoy, f.claude, 'junction');
    }, /LINE_UNSAFE_PATH/);
    {
        // 先正常写好（--check 本可通过），再建 .claude\skills：--check 失败只可能因为 skills；--refresh 报 SKILLS_PRESENT；setup 那边另由 6.9b 核
        const f = await fixture('skills');
        runCli(f, [NAME]);
        fs.mkdirSync(path.join(f.claude, 'skills'));
        const before = freeze(f);
        const rc = runCli(f, [NAME, '--check']);
        const rr = runCli(f, [NAME, '--refresh']);
        check('6.9', '线目录已有 .claude\\skills（设置文件都一致）：--check 退出码 1 且点名 skills、不报「不存在」；--refresh 退出码 1、LINE_SESSION_SKILLS_PRESENT；什么都没变',
            rc.status === 1 && /线目录有 \.claude.skills/.test(rc.out) && !/不存在/.test(rc.out) && rr.status === 1 && /LINE_SESSION_SKILLS_PRESENT/.test(rr.out) && sameFreeze(before, freeze(f)), { rc, rr });
        const g = await fixture('skills-setup');
        fs.mkdirSync(path.join(g.claude, 'skills'), { recursive: true });
        const beforeG = freeze(g);
        const rs = runCli(g, [NAME]);
        check('6.9b', '只有 .claude\\skills 时 setup：退出码 1、LINE_SESSION_SKILLS_PRESENT，什么都没写', rs.status === 1 && /LINE_SESSION_SKILLS_PRESENT/.test(rs.out) && sameFreeze(beforeG, freeze(g)), rs);
    }
    await refuse('6.10', '主工作区缺 settings.local.json', 'no-src', { local: null }, null, /LINE_SESSION_SOURCE_MISSING/);
    await refuse('6.11', '来源不是合法 JSON（内容不回显）', 'bad-json', { local: '{ "permissions": SENTINEL-must-not-echo' }, null, /LINE_SESSION_BAD_JSON/,
        (r) => !r.out.includes('SENTINEL-must-not-echo'));
    await refuse('6.12', '来源 permissions.allow 不是字符串数组', 'bad-shape', { local: { permissions: { allow: 'Bash(x)' } } }, null, /LINE_SESSION_BAD_JSON/);
    await refuse('6.13', '线目录现有 settings.local.json 不是合法 JSON', 'bad-target', {}, (f) => {
        fs.mkdirSync(f.claude);
        fs.writeFileSync(path.join(f.claude, 'settings.local.json'), 'not json SENTINEL-must-not-echo');
    }, /LINE_SESSION_BAD_JSON/, (r) => !r.out.includes('SENTINEL-must-not-echo'));
    await refuse('6.15', '主工作区的 .claude 是联接（来源经链接读取）', 'main-junction', {}, (f) => {
        f.decoy = path.join(f.main, 'real-claude');
        fs.renameSync(path.join(f.main, '.claude'), f.decoy);
        fs.symlinkSync(f.decoy, path.join(f.main, '.claude'), 'junction');
    }, /LINE_UNSAFE_PATH/, (r, f) => C.lstatOrNull(f.claude) === null);
    await refuse('6.16', '目标 settings.local.json 的位置是目录联接', 'target-junction', {}, (f) => {
        fs.mkdirSync(f.claude);
        f.decoy = path.join(f.base, 'decoy-target');
        fs.mkdirSync(f.decoy);
        fs.symlinkSync(f.decoy, path.join(f.claude, 'settings.local.json'), 'junction');
    }, /LINE_UNSAFE_PATH/);
    await refuse('6.17', '生成记录的位置是目录联接', 'base-junction', {}, (f) => {
        fs.mkdirSync(f.claude);
        f.decoy = path.join(f.base, 'decoy-base');
        fs.mkdirSync(f.decoy);
        fs.symlinkSync(f.decoy, path.join(f.claude, BASE), 'junction');
    }, /LINE_UNSAFE_PATH/);
    await refuse('6.18', '.claude 是普通文件', 'claude-file', {}, (f) => { fs.writeFileSync(f.claude, 'x'); }, /LINE_UNSAFE_PATH/);
    await refuse('6.19', '登记的分支不是 line/<线名>', 'branch', { branchReg: 'line/other-line' }, null, /LINE_UNSAFE_PATH/);
    await refuse('6.20', '主工作区 settings.json 不是合法 JSON', 'bad-shared', { shared: '{ oops' }, null, /LINE_SESSION_BAD_JSON/);
    {
        // worktree 就是主工作区：把假主工作区直接放在 <线目录根>/<线名>
        const f = await fixture('wt-is-main');
        const mainAsWt = f.wt;
        fs.mkdirSync(path.join(mainAsWt, '.claude'));
        fs.copyFileSync(path.join(f.main, '.claude', 'settings.local.json'), path.join(mainAsWt, '.claude', 'settings.local.json'));
        const before = J(snap(mainAsWt));
        const r = spawnSync(process.execPath, [SCRIPT, NAME, '--refresh', '--control-root', f.control, '--lines-root', f.lines, '--main-root', mainAsWt], { cwd: TMP, encoding: 'utf8', windowsHide: true, timeout: 60000 });
        const out = `${r.stdout || ''}${r.stderr || ''}`;
        check('6.21', 'worktree 就是主工作区：--refresh 退出码 1、LINE_UNSAFE_PATH「worktree 就是主工作区」，什么都没写', r.status === 1 && /worktree 就是主工作区/.test(out) && J(snap(mainAsWt)) === before, { status: r.status, out: out.slice(0, 400) });
    }
    {
        // 对照：.claude 是普通空目录（例如上次半途失败留下的）时 setup 正常写入
        const f = await fixture('empty-claude');
        fs.mkdirSync(f.claude);
        const r = runCli(f, [NAME]);
        check('6.14', '对照：.claude 已是空的普通目录时 setup 正常写入两个设置文件与生成记录', r.status === 0 && J(Object.keys(snap(f.claude))) === J(THREE), r);
    }

    // ---------------------------------------------------------------- 7 用法错误
    {
        const f = await fixture('usage');
        const before = freeze(f);
        const u = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: TMP, encoding: 'utf8', windowsHide: true, timeout: 60000 });
        const roots = ['--control-root', f.control, '--lines-root', f.lines, '--main-root', f.main];
        const cases = [
            ['7.1', '没有线名', [...roots]],
            ['7.2', '两个线名', [NAME, 'x2', ...roots]],
            ['7.3', '--refresh 与 --check 同时给', [NAME, '--refresh', '--check', ...roots]],
            ['7.4', '不认识的参数（取值不回显）', [NAME, '--bogus=SENTINEL-must-not-echo', ...roots]],
            ['7.5', '根覆盖参数只给一个', [NAME, '--control-root', f.control]],
            ['7.6', '--check 带取值', [NAME, '--check=1', ...roots]],
            ['7.7', '非法线名', ['bad name!', ...roots]],
        ];
        for (const [id, desc, args] of cases) {
            const r = u(args);
            const out = `${r.stdout || ''}${r.stderr || ''}`;
            check(id, `用法错误：${desc} → 退出码 2，不回显原始取值，什么都没变`, r.status === 2 && !out.includes('SENTINEL-must-not-echo') && sameFreeze(before, freeze(f)), { status: r.status, out: out.slice(0, 400) });
        }
        // 「是不是帮助」在进程内判：不带根覆盖参数的 CLI 在线检出里会先转发到主工作区（与 line.js 同口径），结果随运行位置变
        const hName = u(['help', ...roots]);
        const hOut = `${hName.stdout || ''}${hName.stderr || ''}`;
        check('7.8', 'parseArgv：--help / -h 是帮助；「help」按线名处理（CLI 带根覆盖参数：未登记 → 退出码 1、LINE_NO_SUCH_LINE），不当成帮助',
            M.parseArgv(['--help']).help === true && M.parseArgv(['-h']).help === true && M.parseArgv(['help']).name === 'help' && !M.parseArgv(['help']).help
            && hName.status === 1 && /LINE_NO_SUCH_LINE/.test(hOut) && sameFreeze(before, freeze(f)), { hName: hName.status, hOut: hOut.slice(0, 300) });
    }

    // ---------------------------------------------------------------- 8 根覆盖参数指向真实环境
    {
        const f = await fixture('real-roots');
        const before = freeze(f);
        const repoRoot = path.resolve(LINES_DIR, '..', '..');
        let realMain = null;
        try { realMain = C.gitMainRoot(repoRoot); } catch (_) { realMain = null; }
        let realControl = null;
        try { realControl = S.resolveControlRoot({ cwd: repoRoot }); } catch (_) { realControl = null; }
        const u = (args) => { const r = spawnSync(process.execPath, [SCRIPT, NAME, ...args], { cwd: TMP, encoding: 'utf8', windowsHide: true, timeout: 60000 }); return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` }; };
        const r1 = u(['--control-root', f.control, '--lines-root', 'E:/sdh-lines', '--main-root', f.main]);
        check('8.1', '--lines-root 等于真实线目录根 → 退出码 2、固定文案', r1.status === 2 && /--lines-root 等于或位于真实线目录根之内/.test(r1.out), r1);
        const r2 = u(['--control-root', f.control, '--lines-root', f.lines, '--main-root', realMain || repoRoot]);
        check('8.2', '--main-root 指向真实主仓库 → 退出码 2、固定文案', r2.status === 2 && /--main-root (指向|属于)/.test(r2.out), r2);
        // 8.3 要一个「真实仓库的 linked worktree」：在线检出里跑时就是本检出；在主工作区跑时从 git worktree list 取一个别的（只当参数传，被拒在动任何东西之前）
        let linked = null;
        if (realMain !== null && !C.samePath(repoRoot, realMain)) linked = repoRoot;
        else if (realMain !== null) {
            const others = C.listWorktrees(realMain).map((w) => w.path).filter((p) => p && !C.samePath(p, realMain) && C.lstatOrNull(p) !== null);
            linked = others.length > 0 ? others[0] : null;
        }
        if (linked !== null) {
            const r3 = u(['--control-root', f.control, '--lines-root', f.lines, '--main-root', linked]);
            check('8.3', '--main-root 指向真实仓库的 linked worktree → 退出码 2、「属于脚本所在检出的真实仓库」', r3.status === 2 && /--main-root 属于/.test(r3.out), r3);
        } else console.log('NOTE 8.3 未覆盖：本机真实仓库此刻没有别的 worktree 可当参数（不计入 PASS / FAIL）');
        const r6 = u(['--control-root', f.control, '--lines-root', 'E:/sdh-lines/zz-not-a-line', '--main-root', f.main]);
        check('8.6', '--lines-root 位于真实线目录根之内 → 退出码 2、固定文案', r6.status === 2 && /--lines-root 等于或位于真实线目录根之内/.test(r6.out), r6);
        if (realControl !== null) {
            const r4 = u(['--control-root', realControl, '--lines-root', f.lines, '--main-root', f.main]);
            check('8.4', '--control-root 指向真实默认控制根 → 退出码 2、固定文案', r4.status === 2 && /--control-root 指向真实主工作区的默认控制根/.test(r4.out), r4);
        } else check('8.4', '求得真实默认控制根（本检出应在 git 仓库里）', false, null);
        check('8.5', '以上拒绝都没有改动夹具', sameFreeze(before, freeze(f)), null);
    }

    // ---------------------------------------------------------------- 9 纯函数
    {
        const mainRoot = path.join(ROOT, '主 工作区X');
        const src = { permissions: { allow: ['a'], additionalDirectories: ['\\tmp', `${mainRoot.toUpperCase()}\\`] } };
        const srcCopy = J(src);
        const g = M.buildLocal(src, mainRoot);
        check('9.1', 'buildLocal：已有同一绝对路径（大小写不同、带末尾分隔符）不重复追加；入参不被修改', J(g.permissions.additionalDirectories) === J(src.permissions.additionalDirectories) && J(src) === srcCopy, g);
        const g2 = M.buildLocal({ hooks: {} }, mainRoot);
        check('9.2', 'buildLocal：来源没有 permissions 时新建，additionalDirectories 恰为 [主工作区根目录]', J(g2.permissions) === J({ additionalDirectories: [mainRoot] }) && J(g2.hooks) === '{}', g2);
        check('9.3', 'sameAbsDir：根相对写法 "\\tmp" 与相对写法不与任何绝对路径相等；同一路径大小写 / 末尾分隔符不同视为相等',
            M.sameAbsDir('\\tmp', 'C:\\tmp') === false && M.sameAbsDir('tmp', path.resolve('tmp')) === false && M.sameAbsDir('c:/A/b/', 'C:\\a\\B') === true && M.sameAbsDir(42, 'C:\\a') === false, null);
        const m = M.mergeLineOnly({ permissions: { allow: ['a', 'b'] }, k: 1 }, { permissions: { allow: ['b', 'z', 'z', 'a'], deny: ['d'], defaultMode: 'x' }, k: 2, extra: true });
        check('9.4', 'mergeLineOnly：线内独有条目去重后接在后面（含主工作区没有的 deny 列表）；k / extra / permissions.defaultMode 列为按主工作区更新的键',
            J(m.merged) === J({ permissions: { allow: ['a', 'b', 'z'], deny: ['d'] }, k: 1 }) && J(m.kept) === J([{ list: 'allow', entry: 'z' }, { list: 'deny', entry: 'd' }])
            && J(m.overridden.slice().sort()) === J(['extra', 'k', 'permissions.allow', 'permissions.defaultMode']), m);
        const m0 = M.mergeLineOnly({ permissions: { allow: ['a'] } }, null);
        check('9.5', 'mergeLineOnly：线内不存在时 merged = want、无 kept / dropped / overridden', J(m0) === J({ merged: { permissions: { allow: ['a'] } }, kept: [], dropped: [], overridden: [] }), m0);
        const mp = M.mergeLineOnly({ permissions: { allow: ['a'] } }, { permissions: { allow: ['a', 'old', 'mine'], ask: ['q'] } }, { permissions: { allow: ['a', 'old'], ask: ['q'] } });
        check('9.5b', 'mergeLineOnly 带上次生成：上次生成过、这次主工作区没有的（old、ask 的 q）去掉并列入 dropped；上次没生成过的（mine）保留',
            J(mp.merged) === J({ permissions: { allow: ['a', 'mine'] } }) && J(mp.kept) === J([{ list: 'allow', entry: 'mine' }]) && J(mp.dropped) === J([{ list: 'allow', entry: 'old' }, { list: 'ask', entry: 'q' }]), mp);
        const mq = M.mergeLineOnly({ permissions: { allow: ['a'] } }, { permissions: { allow: ['a', 'x'] } }, {});
        check('9.5c', 'mergeLineOnly：有生成记录但当时没生成这个文件（prev = {}）→ 线内多出的全部保留', J(mq.kept) === J([{ list: 'allow', entry: 'x' }]) && mq.dropped.length === 0, mq);
        const same = M.planFor({ a: 1, b: [1, 2] }, { obj: { b: [1, 2], a: 1 } });
        const order = M.planFor({ permissions: { allow: ['a', 'b'] } }, { obj: { permissions: { allow: ['b', 'a'] } } });
        check('9.6', 'planFor：对象键顺序不同算一致（same）；数组顺序不同算要替换（replace）；两边都没有 = absent；主工作区没有、线内有、没有生成记录 = keep-line-only',
            same.action === 'same' && order.action === 'replace' && M.planFor(null, null).action === 'absent' && M.planFor(null, { obj: {} }).action === 'keep-line-only', { same: same.action, order: order.action });
        const gone = M.planFor(null, { obj: { permissions: { allow: ['g', 'mine'] }, k: 1 } }, { state: 'generated', obj: { permissions: { allow: ['g'] }, k: 1 } });
        const own = M.planFor(null, { obj: { permissions: { allow: ['mine'] } } }, { state: 'none', obj: null });
        const empty = M.planFor(null, { obj: { hooks: { X: [] }, permissions: { allow: ['mine'] } } }, { state: 'generated', obj: {} });
        check('9.6b', 'planFor：主工作区没有、上次生成过 → replace（去掉 g 与其余键，只留 mine，mainGone）；上次生成过但内容为 {} 也算生成过（去掉 hooks）；上次没生成过（none）→ keep-line-only、不算 noBase',
            gone.action === 'replace' && gone.mainGone === true && J(gone.merged) === J({ permissions: { allow: ['mine'] } }) && J(gone.dropped) === J([{ list: 'allow', entry: 'g' }])
            && empty.action === 'replace' && J(empty.merged) === J({ permissions: { allow: ['mine'] } }) && own.action === 'keep-line-only' && own.noBase === false, { gone, empty, own: own.action });
        const u1 = M.unionBase({ tool: 'setup-session', version: 1, files: { 'settings.json': { permissions: { allow: ['a', 'old'] } }, 'settings.local.json': null } },
            { tool: 'setup-session', version: 1, files: { 'settings.json': { permissions: { allow: ['a', 'new'] }, k: 2 }, 'settings.local.json': { permissions: { deny: ['d'] } } } });
        const u2 = M.unionBase({ tool: 'setup-session', version: 1, files: { 'settings.json': { hooks: { X: [] } }, 'settings.local.json': { permissions: { allow: ['a'] } } } },
            { tool: 'setup-session', version: 1, files: { 'settings.json': null, 'settings.local.json': { permissions: { allow: ['a'] } } } });
        check('9.7', 'unionBase：每份四个权限列表取「新 ∪ 旧」（新在前）、其余键取新；旧没有而新有的份照新；新为 null（主工作区删掉）时保留旧的「生成过」记录（不压成 null / {}）；没有旧记录时就是新记录',
            J(u1.files['settings.json']) === J({ permissions: { allow: ['a', 'new', 'old'] }, k: 2 }) && J(u1.files['settings.local.json']) === J({ permissions: { deny: ['d'] } })
            && J(u2.files['settings.json']) === J({ hooks: { X: [] } }) && J(M.unionBase(null, { x: 1 })) === J({ x: 1 }), { u1, u2 });
    }

    // ---------------------------------------------------------------- 10 进程内：锁内代次变化、读与改名之间被写入（LINE_SESSION_CHANGED）
    {
        const f = await fixture('gen-change');
        runCli(f, [NAME]);
        const lines = [];
        const ctx = { mainRoot: f.main, controlRoot: f.control, linesRoot: f.lines, out: (s) => lines.push(s) };
        const realRead = S.readState;
        let calls = 0;
        S.readState = async (...a) => { const st = await realRead(...a); calls += 1; if (calls === 2) for (const k of Object.keys(st.lines)) st.lines[k].generation = 'changed-generation'; return st; };
        const before = freeze(f);
        let err = null;
        try { await M.setupSession(ctx, { name: NAME, mode: 'refresh' }); } catch (e) { err = e; } finally { S.readState = realRead; }
        check('10.1', '锁外与锁内两次读登记之间代次变了 → LINE_SESSION_CHANGED，什么都没写', err !== null && err.code === 'LINE_SESSION_CHANGED' && calls === 2 && sameFreeze(before, freeze(f)), { code: err && err.code, calls });
    }
    {
        const f = await fixture('race-write');
        runCli(f, [NAME]);
        const m3 = JSON.parse(JSON.stringify(MAIN_LOCAL));
        m3.hooks = {};
        fs.writeFileSync(path.join(f.main, '.claude', 'settings.local.json'), JSON.stringify(m3, null, 2));   // 让 --refresh 必须替换 settings.local.json
        const target = path.join(f.claude, 'settings.local.json');
        const injected = JSON.stringify({ permissions: { allow: ['Bash(approved while refreshing)'] } });
        const realWrite = fs.writeFileSync;
        let fired = false;
        fs.writeFileSync = function patched(file, ...rest) {
            if (!fired && typeof file === 'string' && path.basename(file).startsWith('.settings.local.json.') && file.endsWith('.tmp')) { fired = true; realWrite.call(fs, target, injected); }
            return realWrite.call(fs, file, ...rest);
        };
        const ctx = { mainRoot: f.main, controlRoot: f.control, linesRoot: f.lines, out: () => {} };
        let err = null;
        try { await M.setupSession(ctx, { name: NAME, mode: 'refresh' }); } catch (e) { err = e; } finally { fs.writeFileSync = realWrite; }
        const tmpLeft = fs.readdirSync(f.claude).filter((n) => n.endsWith('.tmp'));
        check('10.2', '读取之后、改名之前线会话写入了 settings.local.json → LINE_SESSION_CHANGED，线会话写的内容原样保留，不留临时文件',
            fired && err !== null && err.code === 'LINE_SESSION_CHANGED' && fs.readFileSync(target, 'utf8') === injected && tmpLeft.length === 0, { fired, code: err && err.code, tmpLeft });
    }
    {
        // codex 48 H1：首次 setup 写完 settings.json 后中断（建 settings.local.json 失败）→ 生成记录必须已先落盘；之后主工作区收回 Bash(python:*)，--refresh 要把它去掉
        const f = await fixture('first-write-crash');
        const realOpen = fs.openSync;
        let baseAtFirstSettingsOpen;   // undefined = 没走到「新建 settings.json」这一步
        fs.openSync = function patched(file, flags, ...rest) {
            if (typeof file === 'string' && flags === 'wx') {
                // 48-R LOW：在新建第一个设置文件的那一刻核「生成记录已在盘上」，直接约束「记录先于任何设置文件」
                if (path.basename(file) === 'settings.json' && baseAtFirstSettingsOpen === undefined) baseAtFirstSettingsOpen = baseOfLine(f);
                if (path.basename(file) === 'settings.local.json') { const e = new Error('注入：创建失败'); e.code = 'EIO'; throw e; }
            }
            return realOpen.call(fs, file, flags, ...rest);
        };
        const ctx = { mainRoot: f.main, controlRoot: f.control, linesRoot: f.lines, out: () => {} };
        let err = null;
        try { await M.setupSession(ctx, { name: NAME, mode: 'setup' }); } catch (e) { err = e; } finally { fs.openSync = realOpen; }
        const baseAfter = baseOfLine(f);
        check('10.3', '首次写入中断：新建 settings.json 的那一刻生成记录已在盘上且记下 settings.json；中断后 settings.json 已写、settings.local.json 未建',
            err !== null && err.code === 'EIO' && J(baseAtFirstSettingsOpen?.files?.['settings.json']) === J(MAIN_SHARED)
            && C.lstatOrNull(path.join(f.claude, 'settings.json')) !== null && C.lstatOrNull(path.join(f.claude, 'settings.local.json')) === null
            && J(baseAfter?.files?.['settings.json']) === J(MAIN_SHARED), { code: err && err.code, baseAtFirstSettingsOpen, baseAfter });
        fs.writeFileSync(path.join(f.main, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: [] } }));   // 主工作区收回 Bash(python:*)
        const rr = runCli(f, [NAME, '--refresh']);
        const sh = readJson(path.join(f.claude, 'settings.json'));
        check('10.3b', '中断后主工作区收回 Bash(python:*)，--refresh：退出码 0，线内 settings.json 去掉它（不当线内独有保留），settings.local.json 补齐',
            rr.status === 0 && J(sh.permissions.allow) === '[]' && C.lstatOrNull(path.join(f.claude, 'settings.local.json')) !== null, { rr, sh });
    }
    {
        // 48-R LOW：首份生成记录建失败 → 两个设置文件都不能被建出来
        const f = await fixture('base-create-fail');
        const realOpen = fs.openSync;
        fs.openSync = function patched(file, flags, ...rest) {
            if (typeof file === 'string' && flags === 'wx' && path.basename(file) === BASE) { const e = new Error('注入：生成记录创建失败'); e.code = 'EIO'; throw e; }
            return realOpen.call(fs, file, flags, ...rest);
        };
        const ctx = { mainRoot: f.main, controlRoot: f.control, linesRoot: f.lines, out: () => {} };
        let err = null;
        try { await M.setupSession(ctx, { name: NAME, mode: 'setup' }); } catch (e) { err = e; } finally { fs.openSync = realOpen; }
        check('10.3c', '首份生成记录建失败：报原错误，settings.json 与 settings.local.json 都没有被建出来',
            err !== null && err.code === 'EIO' && C.lstatOrNull(path.join(f.claude, 'settings.json')) === null && C.lstatOrNull(path.join(f.claude, 'settings.local.json')) === null, { code: err && err.code, s: snap(f.claude) });
    }
    {
        // codex 48 H2：第一次改名报占用（EPERM），等待期间线会话写入 → 下一轮重试前重核 sha256，报 LINE_SESSION_CHANGED，不覆盖
        const f = await fixture('retry-race');
        runCli(f, [NAME]);
        const m4 = JSON.parse(JSON.stringify(MAIN_LOCAL));
        m4.hooks = {};
        fs.writeFileSync(path.join(f.main, '.claude', 'settings.local.json'), JSON.stringify(m4, null, 2));
        const target = path.join(f.claude, 'settings.local.json');
        const injected = JSON.stringify({ permissions: { allow: ['Bash(approved during retry)'] } });
        const realRename = fs.renameSync;
        let renameCalls = 0;
        fs.renameSync = function patched(from, to) {
            if (typeof to === 'string' && path.basename(to) === 'settings.local.json') {
                renameCalls += 1;
                if (renameCalls === 1) { fs.writeFileSync(target, injected); const e = new Error('注入：占用'); e.code = 'EPERM'; throw e; }
            }
            return realRename.call(fs, from, to);
        };
        const ctx = { mainRoot: f.main, controlRoot: f.control, linesRoot: f.lines, out: () => {} };
        let err = null;
        try { await M.setupSession(ctx, { name: NAME, mode: 'refresh' }); } catch (e) { err = e; } finally { fs.renameSync = realRename; }
        const tmpLeft = fs.readdirSync(f.claude).filter((n) => n.endsWith('.tmp'));
        check('10.4', '改名第一次报 EPERM、等待期间线会话写入 → 重试前重核发现变化，LINE_SESSION_CHANGED，线会话写的内容保留，只尝试改名一次，不留临时文件',
            err !== null && err.code === 'LINE_SESSION_CHANGED' && renameCalls === 1 && fs.readFileSync(target, 'utf8') === injected && tmpLeft.length === 0, { code: err && err.code, renameCalls, tmpLeft });
    }
    {
        // codex 48 M1：主工作区 settings.json 只有 hooks（没有权限列表）；主工作区整份删掉后 --refresh 在替换 settings.json 时失败 →
        //   过渡记录必须仍记「生成过」；再跑 --refresh 要把 hooks 去掉，不能当线内自建保留
        const f = await fixture('mid-fail-hooks', { shared: { hooks: { Stop: [] } } });
        runCli(f, [NAME]);
        fs.unlinkSync(path.join(f.main, '.claude', 'settings.json'));
        const realRename = fs.renameSync;
        fs.renameSync = function patched(from, to) {
            if (typeof to === 'string' && path.basename(to) === 'settings.json') { const e = new Error('注入：替换失败'); e.code = 'EIO'; throw e; }
            return realRename.call(fs, from, to);
        };
        const ctx = { mainRoot: f.main, controlRoot: f.control, linesRoot: f.lines, out: () => {} };
        let err = null;
        try { await M.setupSession(ctx, { name: NAME, mode: 'refresh' }); } catch (e) { err = e; } finally { fs.renameSync = realRename; }
        const mid = baseOfLine(f) || { files: {} };
        check('10.5', '替换 settings.json 失败时，过渡记录里 settings.json 仍是「生成过」（{ hooks }，不是 null / {}），线内 settings.json 未变',
            err !== null && err.code === 'EIO' && J(mid.files['settings.json']) === J({ hooks: { Stop: [] } }) && J(readJson(path.join(f.claude, 'settings.json'))) === J({ hooks: { Stop: [] } }), { code: err && err.code, mid: mid.files });
        const rr = runCli(f, [NAME, '--refresh']);
        const rc = runCli(f, [NAME, '--check']);
        check('10.5b', '再跑 --refresh：线内 settings.json 去掉 hooks 变为 {}、生成记录里变为 null；之后 --check 退出码 0',
            rr.status === 0 && J(readJson(path.join(f.claude, 'settings.json'))) === '{}' && baseOfLine(f)?.files?.['settings.json'] === null && rc.status === 0, { rr, rc });
    }
}

main().catch((e) => { FAIL += 1; console.log(`FAIL 未处理的异常：${e && e.stack ? e.stack : e}`); }).then(() => {
    console.log(`汇总：PASS=${PASS} FAIL=${FAIL}`);
    if (FAIL === 0) {
        try {
            const real = fs.realpathSync.native(TMP);
            C.deleteTreeNoFollow(real, []);
            fs.rmdirSync(real);
            if (C.lstatOrNull(real) !== null) { console.log(`FAIL 清理后临时目录仍在：${real}`); process.exitCode = 1; return; }
        } catch (e) { console.log(`FAIL 清理临时目录失败（保留现场）：${TMP}：${e && e.message}`); process.exitCode = 1; return; }
    } else console.log(`现场保留：${TMP}`);
    process.exitCode = FAIL === 0 ? 0 : 1;
});
