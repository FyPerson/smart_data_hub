/**
 * #106 S2b 验证（套件本体）：line new / line remove（scripts/lines/line.js、line-new.js、line-remove.js、line-common.js）
 * 入口是同目录的 verify-lines-new-remove.js（独立监督进程：超时杀进程树并非零退出）；本文件不要直接当入口跑。
 *
 * 全部在测试自建的临时 git 仓库里执行：os.tmpdir() 下建「中文 + 空格」目录，内含一个「主工作区」仓库（main 分支一个提交）、线目录根、控制根。
 * 不对真实仓库建线或删线、不读真实 .env、不开业务库、不碰 E:/sdh-lines；.env / task_pool.db 都由本脚本生成（假键、假数据）。
 * 清理与复制不用 fs.rmSync / fs.cpSync（Node v24 对中文路径不可靠）：逐项 unlinkSync / rmdirSync，链接只拆不跟随，残留判红。
 * 本文件里所有同步 git 调用都带 timeout。
 *
 * 覆盖：
 *   1 line new 成功（登记 / 代次 / 分支 / worktree / junction / .sdh-instance / 线库 / 运行期文件 / 缺失附件 / 线 .env（JWT 每线随机）/ 归属凭据 / 脱敏）
 *   2 建库顺序    3 同模块闸门（含锁内：过期预检查、双进程竞争）与槽位
 *   4 失败路径与清理（含预先存在的目录 / worktree / 分支不被删）
 *   5 line remove：未提交 / 未合入 / detached HEAD / HEAD reflog / 分支前移 / status.showUntrackedFiles=no；每次删后主 node_modules 深度摘要全等
 *   6 预检防线（残留链接、祖先目录被换成 junction、建线与删线都在修改前中止）
 *   7 登记 process 非空   8 临时目录清理 + 泄漏扫描
 *   9 CLI：用法 / 根参数全给或全不给 / 覆盖到真实控制根 / 入口转发 / 端到端 / 测试端口表 --slot-ports（H1：只在三根全给时接受、非法表退出码 2、new 分配与登记 port 等于测试表、不带时仍 3100）
 *   10 实现项：.env 往返、附件表（11 张，手写期望）、junction 与删除助手、来源键、登记路径篡改、npm ls、删除后失败的重试、并发 remove（确定性交错）、代次、归属、脱敏、重解析点（注入）、归属凭据写失败不回滚
 *   11 修复批 2 新防线：删线全程不调用 git worktree remove / prune（记录器）、归属凭据逐字段篡改、管理目录 junction、worktree 目录缺失按管理目录核实 HEAD / reflog、
 *      分支被其他检出占用、集成分支检查后变化（update-ref 事务）、cwd 在 worktree 内、预检失败不改状态、上锁 worktree、删除中途失败后的重试、根覆盖参数指向真实值、
 *      复制的重解析点检查、入口输出不回显、scrubError（stack / cause）、reflog 批量检查与 64 位对象名、新增条目只告警、两处代次写入、预留槽位后输出失败、strict 逐项删除
 *   11（收口小批）：git 调用记录器覆盖 child_process 全部 6 个入口并扩到所有删线场景（目录缺失分支 / CLI 子进程 / 工作进程，11.1f-h，汇总断言 11.26）、放宽状态不放过缺失的归属标记（11.21）、
 *      reflog 旧新两端 + 线分支 reflog 收集（11.22）、线分支是符号引用时不删（11.23）、脱敏器建立前两处固定文案（11.24）、建线最后一步步骤名不与删线撞名（11.25）
 *
 * 威胁模型（与被测代码一致）：保证诚实误用与真实故障下不删到 worktree 之外、不丢未合入提交；不防删除进行期间别的进程并发篡改目录结构（本套件只证明窗口被缩小、预检之后出现的链接 / 重解析点会中止）。
 *
 * 运行（经监督进程）：node E:/tmp/wt-s2b/wbs-server/scripts/verify-lines-new-remove.js [--lines-dir=<被测 scripts/lines 目录的绝对路径>] [--only=1,5]
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const { execFileSync, spawn, spawnSync } = cp;   // 本脚本自己用的是这里取到的原始函数（下面的记录器只包被测库加载时取到的那一份）

// 被测库加载之前，把 child_process 的全部 6 个入口（exec / execSync / execFile / execFileSync / spawn / spawnSync）包一层：记录被测代码发出的每一条 git 命令。
//   用途：证明删线全程不调用 `git worktree remove` / `git worktree prune`（修复批 2 第 1.1 条），而不是只断言结果。本脚本自己的 git 调用（夹具搭建、读状态）用上面取到的原始函数，不入记录。
//   识别：file 本身是 git 可执行文件 → args 数组；否则命令行（file + args 拼起来，含 shell 字符串形式）里出现 git 一词 → 整条按空白切成 token（匹配 `worktree remove|prune` 用拼接后的整串）。
//   记录范围：被测代码所有实际删线场景——进程内（removeLine 助手 / recordGit 包裹）、CLI 子进程、工作进程；子进程里用同一份记录器（installRecorder 源码经 --require 预加载 / 工作进程自身加载），
//   把记录写到 LINES_TEST_GIT_REC 指定的文件，父进程读回并入汇总（REMOVAL_GIT）。
const GIT_REC = { depth: 0, removal: 0, calls: [] };   // calls：recordGit 期间记录到的 git 调用（token 数组）；depth / removal 为嵌套计数
const REMOVAL_GIT = [];                                  // 所有删线场景里记录到的 git 调用（进程内 + CLI + 工作进程）
function installRecorder(sink) {
    const cpm = require('child_process');
    const isGitFile = (f) => /(^|[\\/])git(\.exe)?$/i.test(String(f));
    for (const name of ['execFileSync', 'spawnSync', 'execSync', 'exec', 'execFile', 'spawn']) {
        const orig = cpm[name];
        cpm[name] = function recorded(file, args, ...rest) {
            const tail = Array.isArray(args) ? args.map(String) : [];
            let a = null;
            if (isGitFile(file)) a = tail.slice();
            else if (/\bgit(\.exe)?\b/i.test([String(file), ...tail].join(' '))) a = [String(file), ...tail].join(' ').split(/\s+/).filter(Boolean);
            if (a !== null) sink({ fn: name, args: a });
            return orig.call(this, file, args, ...rest);
        };
    }
}
const REC_ENV = process.env.LINES_TEST_GIT_REC;   // 工作进程：记录写文件，由父进程读回
installRecorder(REC_ENV
    ? (rec) => { try { fs.appendFileSync(REC_ENV, `${JSON.stringify(rec)}\n`); } catch (_) { /* */ } }
    : (rec) => { if (GIT_REC.depth > 0) { GIT_REC.calls.push(rec.args); if (GIT_REC.removal > 0) REMOVAL_GIT.push(rec.args); } });
/** CLI 子进程用的预加载脚本源码：与上面是同一个 installRecorder。 */
const RECORDER_PRELOAD_SRC = `(${installRecorder.toString()})(function (rec) { try { require('fs').appendFileSync(process.env.LINES_TEST_GIT_REC, JSON.stringify(rec) + '\\n'); } catch (e) { /* */ } });\n`;
/** 读子进程写出的记录文件 → token 数组的数组。 */
function readRecFile(file) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
    return text.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l).args; } catch (_) { return null; } }).filter(Array.isArray);
}

const argOf = (prefix) => process.argv.find((a) => a.startsWith(prefix));
const LINES_DIR_ARG = argOf('--lines-dir=');
const LINES_DIR = path.resolve(LINES_DIR_ARG ? LINES_DIR_ARG.slice('--lines-dir='.length) : path.join(__dirname, '..', '..', 'scripts', 'lines'));
const ONLY_ARG = argOf('--only=');
const ONLY = ONLY_ARG ? new Set(ONLY_ARG.slice('--only='.length).split(',').map((s) => s.trim())) : null;
const WORKER_ARG = argOf('--worker=');
const HANG_ARG = argOf('--hang-fixture=');
const lib = (n) => require(path.join(LINES_DIR, n));

// ---------------------------------------------------------------- 受控挂起夹具（监督进程自检用）：同步阻塞 + 一个孙进程，证明超时后整棵进程树被回收
if (HANG_ARG) {
    // 夹具主体在共享监督进程模块里（起孙进程、把自己与孙进程的 CIM 精确创建时间写进 pid 文件、同步阻塞）：自检清理只认这份原身份
    require('./lines-test-supervisor.js').runHangFixture(HANG_ARG.slice('--hang-fixture='.length));
}

const C = lib('line-common.js');
const S = lib('state.js');
const N = lib('line-new.js');
const R = lib('line-remove.js');
const L = lib('line.js');
const WBS = path.join(C.REPO_ROOT, 'wbs-server');
const sqlite3 = require(path.join(WBS, 'node_modules', 'sqlite3'));
const instanceDb = require(path.join(WBS, 'utils', 'instance-db.js'));   // 与 line-new.js 同一个模块实例（同一路径），可在同进程内包一层
const instanceMode = require(path.join(WBS, 'utils', 'instance-mode.js'));
const aes = require(path.join(WBS, 'utils', 'aes-password.js'));
const dotenv = require(path.join(WBS, 'node_modules', 'dotenv'));
const SELF_CHECKOUT_ROOT = path.join(__dirname, '..', '..');

// ================================================================ 断言、输出语料与汇总

let PASS = 0;
let FAIL = 0;
const FAILS = [];
const ALL_OUT = [];          // 一切输出文本（被测输出、子进程输出、全程捕获的 console、异常文本、本脚本自己打印的失败详情），结尾统一扫描密钥明文
const RAN = new Set();       // 实际执行了的章节编号（--only 子集时，章节专属的证据要求按它判断）
// 全程捕获 console：被测代码（含入口 run）直接 console.log / error / warn / info 的内容也进语料（先入语料再原样输出）
const ORIG_CONSOLE = { log: console.log, error: console.error, warn: console.warn, info: console.info };
for (const k of Object.keys(ORIG_CONSOLE)) {
    console[k] = (...a) => { ALL_OUT.push(a.map((x) => (typeof x === 'string' ? x : require('util').inspect(x))).join(' ')); ORIG_CONSOLE[k](...a); };
}
const log = (s) => { console.log(String(s)); };
function check(name, cond, detail) {
    if (cond) { PASS += 1; return; }
    FAIL += 1;
    FAILS.push(name);
    log(`  FAIL  ${name}${detail === undefined ? '' : `  -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
}
const section = (id, title) => log(`\n=== ${id} ${title}`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (a) => a.slice().sort();

// ================================================================ 夹具

const ALL_ROOTS = [];
let rootSeq = 0;
const FAKE_KEY = 'fake-main-key-0123456789abcdef-XYZ';
const WRONG_KEY = 'wrong-main-key-fedcba9876543210-QRS';
const JWT = 'fake-jwt-secret-line-test-0001';
const WEBHOOK = 'fake-webhook-secret-0006';
const UNRELATED = 'unrelated-value-12345';
const EVIL_MAIN = 'evil-main';   // 主 .env 里 SDH_INSTANCE 的值（长度 9，达到脱敏门槛）
const REAL_DT = { dingtalk_app_key: 'REAL-DT-APPKEY-0001', dingtalk_app_secret: 'REAL-DT-SECRET-0002', dingtalk_robot_code: 'REAL-DT-ROBOT-0003', platform_base_url: 'http://real-platform.example' };
const SEVEN = {
    collab_notify_admin_on_submit: 'on', issue_lite_developer_id: '23', issue_lite_chat_owner_id: '24', issue_lite_notify_target_ids: '10,11',
    sys_notify_dry_run: 'off', sys_release_default_executor_ids: '5,6', sys_single_commit_group_systems: 'SysAlpha,SysBeta',
};
const OTHER_CFG = 'SECRET-OTHER-0004';
const DB_PASSWORD = 'REAL-DB-PASSWORD-0005';
// 手写的完整秘密集合（脱敏必须让它们一个都不出现在任何输出里）。随机生成的线 JWT 在运行中补进 DYN_SECRETS。
const ARG_SECRET = 'argv-pasted-secret-0123456789abcdef';   // 误粘贴到命令 / 参数名位置的长密钥（入口在脱敏器建立之前不得回显）
const LEAK_STRINGS = [FAKE_KEY, WRONG_KEY, JWT, WEBHOOK, UNRELATED, EVIL_MAIN, OTHER_CFG, DB_PASSWORD, ARG_SECRET, ...Object.values(REAL_DT), 'SysAlpha,SysBeta'];
const DYN_SECRETS = [];
let SEC1_JWT = null;   // 节 1 那条线的随机 JWT（节 10 比较「各线互不相同」用）
let K4_JWT = null;     // 节 10.8 那条线（k4）的随机 JWT
const SURFACE_A = 'wbs-server/routes/x.js；public/x.html';
const ENV_TEXT = [
    `DB_ENCRYPTION_KEY=${FAKE_KEY}`, `JWT_SECRET=${JWT}`, 'SYS_FASTLANE_ENABLE=1', `SDH_INSTANCE=${EVIL_MAIN}`, 'sdh_external=real', 'PORT=3000',
    `UNRELATED_KEY=${UNRELATED}`, `WEBHOOK_SECRET=${WEBHOOK}`, 'LOG_LEVEL=DEBUG', 'NODE_ENV=production', '',
].join('\n');
const EXPECTED_LINE_ENV_COPIED = { SYS_FASTLANE_ENABLE: '1', LOG_LEVEL: 'DEBUG', NODE_ENV: 'production' };   // 手写期望：从主 .env 拷贝的三键，值原样
const EXPECTED_ENV_DROPPED = sorted(['DB_ENCRYPTION_KEY', 'JWT_SECRET', 'PORT', 'SDH_INSTANCE', 'UNRELATED_KEY', 'WEBHOOK_SECRET', 'sdh_external']);
const RT_FILES = {   // 运行期哨兵：[主工作区 wbs-server 下相对路径, 线 wbs-server 下相对路径, 内容]
    uploads: ['uploads/sentinel.txt', 'uploads/sentinel.txt', 'RT-UPLOADS-OK'],
    collab: ['uploads/collab/1/file1.xlsx', 'uploads/collab/1/file1.xlsx', 'RT-COLLAB-1'],
    cjk: [path.join('uploads', '中文 目录', '文件 1.txt'), path.join('uploads', '中文 目录', '文件 1.txt'), 'RT-CJK-OK'],
    quicklog: ['uploads/quick-log/present.png', 'uploads/quick-log/present.png', 'RT-QL-OK'],
    archive: ['archive/a.txt', 'archive/a.txt', 'RT-ARCHIVE-OK'],
    private: ['private/it-inspection-sheets/x.bin', 'private/it-inspection-sheets/x.bin', 'RT-PRIVATE-OK'],
    periodic: ['periodic-results/p.csv', 'periodic-results/p.csv', 'RT-PERIODIC-OK'],
    reconcile: ['routes/it-ledger/uploads/it-reconcile/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.xlsx', 'it-reconcile/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.xlsx', 'RT-RECONCILE-OK'],
};
const MAIN_SENTINELS = [   // [主工作区根下相对路径, 内容]
    ['node_modules/sentinel.txt', 'NM-ROOT-SENTINEL'], ['node_modules/pkgA/index.js', 'NM-ROOT-PKGA'], ['node_modules/pkgA/lib/deep/inner.js', 'NM-ROOT-DEEP'],
    ['wbs-server/node_modules/sentinel.txt', 'NM-WBS-SENTINEL'], ['wbs-server/node_modules/pkgB/index.js', 'NM-WBS-PKGB'], ['wbs-server/node_modules/pkgB/data/x.json', '{"k":"NM-WBS-DEEP"}'],
    ['wbs-server/uploads/sentinel.txt', 'RT-UPLOADS-OK'], ['wbs-server/uploads/collab/1/file1.xlsx', 'RT-COLLAB-1'],
];
const DIGEST_DIRS = ['node_modules', path.join('wbs-server', 'node_modules'), path.join('wbs-server', 'uploads')];

/** 同步 git（临时仓库内）：带超时；提交身份 / autocrlf 用 -c 固定，保证夹具字节稳定。 */
const git = (cwd, args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 60000 });
/** 读状态用：不带 -c core.autocrlf=false（那样会与被测工具实际使用的用户 git 配置不一致，把 CRLF 检出的文件误报为已修改）。 */
const gitq = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 60000 });
const w = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const rd = (file) => fs.readFileSync(file, 'utf8');

const dbOpen = (file, mode) => new Promise((resolve, reject) => { const d = new sqlite3.Database(file, mode, (e) => (e ? reject(e) : resolve(d))); });
const dbRun = (d, sql, p) => new Promise((resolve, reject) => d.run(sql, p || [], function cb(e) { return e ? reject(e) : resolve(this); }));
const dbAll = (d, sql, p) => new Promise((resolve, reject) => d.all(sql, p || [], (e, rows) => (e ? reject(e) : resolve(rows))));
const dbClose = (d) => new Promise((resolve) => d.close(() => resolve()));
async function dbQuery(file, sql, p) { const d = await dbOpen(file, sqlite3.OPEN_READONLY); try { return await dbAll(d, sql, p); } finally { await dbClose(d); } }

async function makeMainDb(file, key) {
    const d = await dbOpen(file, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);
    try {
        await dbRun(d, instanceDb.SYSTEM_CONFIGS_DDL);
        const put = (k, v) => dbRun(d, 'INSERT INTO system_configs (config_key, config_value_encrypted) VALUES (?, ?)', [k, aes.encryptWithKey(key, v)]);
        for (const [k, v] of Object.entries(REAL_DT)) await put(k, v);
        for (const [k, v] of Object.entries(SEVEN)) await put(k, v);
        await put('non_whitelist_key', OTHER_CFG);
        await dbRun(d, 'CREATE TABLE db_connections (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, host TEXT NOT NULL, "database" TEXT NOT NULL, username TEXT NOT NULL, password TEXT NOT NULL)');
        await dbRun(d, 'INSERT INTO db_connections (name, host, "database", username, password) VALUES (?, ?, ?, ?, ?)', ['ext', 'h', 'db', 'u', aes.encryptWithKey(key, DB_PASSWORD)]);
        await dbRun(d, 'CREATE TABLE collab_attachments (id INTEGER PRIMARY KEY AUTOINCREMENT, file_name TEXT NOT NULL)');
        await dbRun(d, 'INSERT INTO collab_attachments (file_name) VALUES (?), (?)', ['collab/1/file1.xlsx', 'collab/2/missing.xlsx']);
        await dbRun(d, 'CREATE TABLE sys_quick_log_attachments (id INTEGER PRIMARY KEY AUTOINCREMENT, file_name TEXT NOT NULL)');
        await dbRun(d, 'INSERT INTO sys_quick_log_attachments (file_name) VALUES (?)', ['quick-log/present.png']);
    } finally { await dbClose(d); }
}

/** 测试侧独立实现的目录深度摘要：完整相对路径 + 条目类型 + 文件内容 sha256，不跟随链接。 */
function deepDigest(dir) {
    const out = [];
    const walk = (d, rel) => {
        for (const n of fs.readdirSync(d).sort()) {
            const p = path.join(d, n);
            const r = rel === '' ? n : `${rel}/${n}`;
            const st = fs.lstatSync(p);
            if (st.isSymbolicLink()) out.push(`L ${r}`);
            else if (st.isDirectory()) { out.push(`D ${r}`); walk(p, r); } else out.push(`F ${r} ${st.size} ${sha(p)}`);
        }
    };
    walk(dir, '');
    return out.join('\n');
}
const digestsOf = (main) => DIGEST_DIRS.map((rel) => deepDigest(path.join(main, rel)));

/** 建一个「主工作区」仓库夹具。返回 { root, main, lines, control, mainDb, digest }。 */
async function buildFixture(label, opts) {
    const o = opts || {};
    rootSeq += 1;
    const root = path.join(os.tmpdir(), `行线 测试 ${process.pid}-${rootSeq}-${label}`);
    if (!C.isInside(os.tmpdir(), root)) throw new Error('夹具根不在系统临时目录内');
    ALL_ROOTS.push(root);
    const main = path.join(root, '主 工作区');
    const lines = path.join(root, '线 目录');
    fs.mkdirSync(main, { recursive: true });
    w(path.join(main, '.gitignore'), rd(path.join(SELF_CHECKOUT_ROOT, '.gitignore')));   // 真实仓库的忽略规则：线检出里新增的文件是否被忽略，必须与真实一致
    w(path.join(main, 'package.json'), '{"name":"fixture-root","version":"1.0.0"}\n');
    w(path.join(main, 'wbs-server', 'package.json'), '{"name":"fixture-wbs","version":"1.0.0"}\n');
    w(path.join(main, 'wbs-server', 'server.js'), '// fixture server\n');
    w(path.join(main, 'wbs-server', 'hello.txt'), 'hello\n');
    if (o.stubLine) w(path.join(main, 'scripts', 'lines', 'line.js'), o.stubLine);
    git(main, ['init', '-q', '-b', 'main']);
    git(main, ['add', '-A']);
    git(main, ['commit', '-q', '-m', 'init']);
    for (const [rel, text] of MAIN_SENTINELS) w(path.join(main, rel), text);
    w(path.join(main, 'node_modules', '.bin', 'x'), 'bin');
    for (const [src, , text] of Object.values(RT_FILES)) w(path.join(main, 'wbs-server', src), text);
    w(path.join(main, 'wbs-server', '.env'), o.envText === undefined ? ENV_TEXT : o.envText);
    const mainDb = path.join(main, 'wbs-server', 'task_pool.db');
    if (!o.noDb) await makeMainDb(mainDb, FAKE_KEY);
    return { root, main, lines, control: path.join(main, 'docs', 'local', '多线并行', '_state'), mainDb, digest: digestsOf(main) };
}

/** 不跟随链接地逐项删除；返回残留路径数组。 */
function removeTree(dir) {
    const left = [];
    const walk = (p) => {
        let st;
        try { st = fs.lstatSync(p); } catch (e) { if (e && e.code === 'ENOENT') return; left.push(p); return; }
        if (st.isSymbolicLink()) {
            try { fs.rmdirSync(p); } catch (_) { try { fs.unlinkSync(p); } catch (_e) { left.push(p); } }
            return;
        }
        if (st.isDirectory()) {
            let names = [];
            try { names = fs.readdirSync(p); } catch (_) { left.push(p); return; }
            for (const n of names) walk(path.join(p, n));
            try { fs.rmdirSync(p); } catch (_) { left.push(p); }
            return;
        }
        try { fs.unlinkSync(p); } catch (_) {
            try { fs.chmodSync(p, 0o666); fs.unlinkSync(p); } catch (_e) { left.push(p); }
        }
    };
    walk(dir);
    return left;
}

const ctxOf = (fx, lines, extra) => Object.assign({ mainRoot: fx.main, controlRoot: fx.control, linesRoot: fx.lines, out: (s) => { lines.push(String(s)); ALL_OUT.push(String(s)); } }, extra || {});
async function attempt(fn) {
    try { return { res: await fn(), err: null }; } catch (e) { ALL_OUT.push(String(e && e.message)); return { res: null, err: e || new Error('空异常') }; }
}
const regOf = (fx) => S.readState(fx.control);
const hasLine = (lines, text) => lines.some((l) => l.includes(text));
const mainIntact = (fx) => { try { return same(digestsOf(fx.main), fx.digest); } catch (_) { return false; } };
const NM_RELS = ['node_modules', path.join('wbs-server', 'node_modules')];
const newArgs = (name, mod, extra) => Object.assign({ name, module: mod || 'mod-x', surface: SURFACE_A }, extra || {});
const wtOf = (fx, name) => path.join(fx.lines, name);
const ownerFileOf = (fx, gen) => path.join(fx.control, 'owners', `${gen}.json`);
const branchExists = (fx, b) => git(fx.main, ['branch', '--list', b]).trim() !== '';
const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch (_) { return false; } };

// ---- owner_record 失败现场清单（U14 裁定 = A：工具不生成任何清理命令，只打印只读清单）的判读助手 ----
//   旧版提示生成拆联接 / 复核 / git worktree remove / git branch -d / line remove 命令，codex 两轮 HIGH；现在只许出现两条只读 reflog 命令，其余一律不得出现。
const REFLOG_HEAD_CMD = 'git reflog show --date=iso HEAD';
const reflogBranchCmd = (b) => `git reflog show --date=iso refs/heads/${b}`;
const msgLinesOf = (msg) => String(msg).split(/\r?\n/).map((l) => l.trim());
// ---- 现场清单「不含改动类写法」的判据（M2：白名单为主、精确禁用片段表为纵深；全部只在「剥离已知路径与两条允许的 reflog 命令行」之后的文本上跑）----
//   旧版只靠 17 条黑名单 + 行首匹配，句中命令（`确认不要时人工执行：git update-ref -d …`、`Move-Item a b`、`ri X`、`fsutil …` 等）全部漏判；
//   黑名单还会误中路径单词（`Juan del Rio` 中的 `del `、`reset-lines` 中的 `reset`，LOW-6）。现在三层，各层独立可判红：
//     层 A 禁用片段表（精确片段，纵深）  层 B 剥离后任何 `git <字母>` 一律判红（`git 管理目录：` 这种中文后缀不算）  层 C 剥离后出现白名单外的 ASCII 词一律判红
//     层 D 剥离后出现 ASCII 的 `>` `<` `|` `&` `;` `$` 或反引号一律判红（重定向 / 管道 / 拼接 / 展开：`'' > '<reflog 文件路径>'` 这类没有任何 ASCII 词、层 A–C 都抓不到的写法；剥离已知路径之后真实消息里一个都没有）
//     mutatingHits 把四层汇总成标签数组（层 A = 片段名，B / C / D = LABEL_B / LABEL_C / LABEL_D），守卫的守卫（11.28w）按标签断言每一层确实被汇总进去
//   残余：只管 ASCII 命令形态；纯中文的操作指令（如「请删除目录」）不在判据内——那类由 CLAUDE.md 小节与评审管。
/** 层 A：精确禁用片段表（不合并成宽正则，免得漏）。旧：此时没有联接 = 修复批 3b 之前的错误断言。 */
const MUTATING_PATTERNS = [
    ['::', /::/],
    ['-Item', /-Item/i],
    ['Remove-Item', /Remove-Item/i],
    ['Delete(', /Delete\(/],
    ['update-ref', /update-ref/i],
    ['clean', /clean/i],
    ['reflog expire', /reflog\s+expire/i],
    ['reflog delete', /reflog\s+delete/i],
    ['symbolic-ref', /symbolic-ref/i],
    ['fsutil', /fsutil/i],
    ['ri/rd/erase', /\b(ri|rd|erase)\b/i],
    ['git worktree', /git\s+worktree/i],
    ['worktree remove / prune', /worktree\s+(remove|prune)/i],
    ['git -C / -c', /git\s+-[A-Za-z]/i],
    ['git branch', /git\s+branch/i],
    ['rmdir', /rmdir/i],
    ['rm ', /(^|\s)rm\s/],
    ['del ', /(^|\s)del\s/i],
    ['--force', /--force/i],
    ['--discard', /--discard/i],
    ['/S /Q', /\/S \/Q/i],
    ['-Recurse', /-Recurse/i],
    ['cmd /c', /cmd \/c/i],
    ['node -e', /node -e/],
    ['powershell -', /powershell -/i],
    ['reset', /\breset\b/i],
    ['旧：此时没有联接', /此时 worktree 里还没有联接|此时没有联接/],
];
/** 层 C 的白名单：以真实消息为准，剥离路径 / 两条 reflog 命令行 / 线名相关固定短语之后消息里仍会出现的 ASCII 说明词（`git` 只在「git 管理目录」里，层 B 另行把关）。 */
const ALLOWED_ASCII_WORDS = new Set(['owner_record', 'failed', 'CLAUDE.md', 'worktree', 'reflog', 'HEAD', 'git']);
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 一个路径的匹配式：分隔符 / 与 \ 通用，大小写不敏感，路径本体按字面量。 */
const pathRe = (p) => new RegExp(String(p).split(/[\\/]+/).map(escRe).join('[\\\\/]+'), 'gi');
const realOrSelf = (p) => { try { return fs.realpathSync.native(p); } catch (_) { return p; } };
/**
 * 要剥离的「已知完整路径」精确清单（由测试从文件系统算出，不从被测消息里取）：worktree、git 管理目录（主工作区 .git/worktrees 下各项）、两个 reflog 文件
 * （管理目录 logs/HEAD、主工作区 .git/logs/refs/heads/<分支>）、调用方追加的（每个联接路径等）；每个都带「原样」与「真实路径」两种写法。
 * 只剥这些完整路径，不剥「前缀」：命令若夹带在路径后面（`<路径> -Recurse`）不会被一并吞掉。
 */
function sitePathsOf(fx, wt, branch, extra) {
    const out = [wt, ...(extra || [])];
    const adminRoot = path.join(fx.main, '.git', 'worktrees');
    let ids = [];
    try { ids = fs.readdirSync(adminRoot); } catch (_) { /* 没有管理目录 */ }
    for (const id of ids) { const d = path.join(adminRoot, id); out.push(d, path.join(d, 'logs', 'HEAD'), path.join(realOrSelf(d), 'logs', 'HEAD')); out.push(realOrSelf(d)); }
    out.push(path.join(fx.main, '.git', 'logs', 'refs', 'heads', ...String(branch).split('/')), path.join(realOrSelf(fx.main), '.git', 'logs', 'refs', 'heads', ...String(branch).split('/')));
    return [...new Set([...out, ...out.map(realOrSelf)])];
}
/** 判读选项：线名（由分支名 line/<名> 得出）+ 要剥离的已知完整路径。 */
const siteOpts = (fx, wt, branch, extra, mapPath) => ({ name: String(branch).replace(/^line\//, ''), paths: sitePathsOf(fx, wt, branch, extra).map(mapPath || ((p) => p)) });   // mapPath：守卫的守卫里把消息里的路径前缀整体换掉时，剥离清单同步换
/** 剥离：两条允许的 reflog 命令行（整行逐字相等才剥，各剥第一处）→ 已知路径（长的先）→ 分支名 / 线名固定短语。返回剩余文本。 */
function residueOf(msg, o) {
    const ls = String(msg).split(/\r?\n/);
    for (const cmd of [reflogBranchCmd(`line/${o.name}`), REFLOG_HEAD_CMD]) {
        const i = ls.findIndex((l) => l.trim() === cmd);
        if (i >= 0) ls.splice(i, 1);
    }
    let t = ls.join('\n');
    for (const p of o.paths.filter((x) => typeof x === 'string' && x !== '').sort((a, b) => b.length - a.length)) t = t.replace(pathRe(p), ' ');
    const n = escRe(o.name);
    // L1：线名相关固定短语只剥「正文那两句原话」里的那一处，其余位置出现的 `line remove <名>` 留给判据（旧版全局剥离，句中插「line remove <名>」会被一并吞掉）。
    //   原话 1（ownerRecordFailureMessage 第 2 行）：…之后 line remove <名> 只会清登记、不会删除它们；原话 2（lineNew 拼的尾句）：line remove 因归属无法证明只清登记…
    t = t.replace(new RegExp(`line/${n}(?![A-Za-z0-9_-])`, 'g'), ' ')
        .replace(new RegExp(`line new ${n}(?![A-Za-z0-9_-])`, 'g'), ' ')
        .replace(new RegExp(`(?<=之后 )line remove ${n}(?= 只会清登记)`, 'g'), ' ')
        .replace(/(?<=；)line remove(?= 因归属无法证明只清登记)/g, ' ');
    return t;
}
const fragHitsIn = (res) => MUTATING_PATTERNS.filter(([, re]) => re.test(res)).map(([nm]) => nm);                 // 层 A
const gitHitsIn = (res) => res.match(/\bgit\s+[a-z-]/gi) || [];                                                  // 层 B
const strayWordsIn = (res) => (res.match(/[A-Za-z][A-Za-z0-9_.-]*/g) || []).filter((x) => !ALLOWED_ASCII_WORDS.has(x));   // 层 C
const symbolsIn = (res) => res.match(/[><|&;$`]/g) || [];                                                         // 层 D：ASCII 重定向 / 管道 / 拼接 / 展开符号（剥离后的剩余文本里一个都不许有）
// 命中标签（mutatingHits 的输出）：层 A 的标签就是片段表里的名字，其余三层固定如下；测试按标签断言「每一层都被汇总进 hits」
const PATTERN_NAMES = new Set(MUTATING_PATTERNS.map(([nm]) => nm));
const LABEL_B = 'git <子命令>';
const LABEL_C = '白名单外 ASCII 词';
const LABEL_D = '重定向 / 拼接符号（层 D）';
/** 把 mutatingHits 的输出按层拆开：a = 层 A 片段名数组，b / c / d = 该层是否命中。 */
const layersOfHits = (hits) => ({ a: hits.filter((h) => PATTERN_NAMES.has(h)), b: hits.includes(LABEL_B), c: hits.some((h) => h.startsWith(LABEL_C)), d: hits.some((h) => h.startsWith(LABEL_D)) });
/** 四层命中汇总（空数组 = 干净）。`line remove` 作为命令行（行首）另判，对原文行。 */
const mutatingHits = (msg, o) => {
    const res = residueOf(msg, o);
    const out = [];
    out.push(...fragHitsIn(res));                                                                   // 层 A
    if (gitHitsIn(res).length > 0) out.push(LABEL_B);                                               // 层 B
    const stray = strayWordsIn(res);
    if (stray.length > 0) out.push(`${LABEL_C}：${[...new Set(stray)].join(',')}`);                   // 层 C
    const sym = symbolsIn(res);
    if (sym.length > 0) out.push(`${LABEL_D}：${[...new Set(sym)].join(' ')}`);                       // 层 D
    if (msgLinesOf(msg).some((l) => /^line remove\b/.test(l))) out.push('line remove（命令行）');
    return out;
};
const manualStepsClean = (msg, o) => mutatingHits(msg, o).length === 0;
/** 看起来像命令行的行（去空白后以这些开头）：现场清单里只许有两条 reflog 命令。 */
const CMDISH_RE = /^(git [a-z-]|powershell|node |Get-|line remove|cmd |rm |del |rmdir )/i;   // `git 管理目录：` / `line new … 失败于步骤` 这类位置行、标题行不会误中
const cmdishLinesOf = (msg) => msgLinesOf(msg).filter((l) => CMDISH_RE.test(l));
/** 最后一行是说明句（上层会在消息末尾追加一句话，不能接在命令行后面）。 */
const lastLineIsNote = (msg) => { const ls = msgLinesOf(msg).filter((l) => l !== ''); const last = ls[ls.length - 1] || ''; return last.startsWith('以上是现场清单') && !CMDISH_RE.test(last); };
/** 联接清单行：`<路径>（目录型|文件型|目标读不到）`。 */
const linkListingOf = (msg) => msgLinesOf(msg).filter((l) => /（(目录型|文件型|目标读不到)）$/.test(l));
const CLAUDE_MD_SECTION = 'CLAUDE.md「建线中断（owner_record 失败）的现场处理」';
/** 现场清单的共同形状（位置三行 + 保留 / 不回滚 / 只清登记 + 两条 reflog 只读命令 + 指向 CLAUDE.md 小节 + 说明句收尾 + 剥离路径后四层判据都干净）。
 *  fx = 夹具；extra = 追加的要剥离的完整路径（每个联接路径等）；mapPath 见 siteOpts。`clean` 的含义见上面三层判据；`hits` 是命中清单（诊断用）。 */
const siteListShape = (msg, wt, branch, fx, extra, mapPath) => ({
    hits: mutatingHits(msg, siteOpts(fx, wt, branch, extra, mapPath)),
    loc: msg.includes(wt) && msg.includes(`分支：${branch}`) && /git 管理目录：/.test(msg),
    keep: /原样保留，工具不删、不回滚/.test(msg) && /只会清登记/.test(msg),
    header: /现场清单（只读，供在场人员核对）：/.test(msg),
    reflogCmds: msgLinesOf(msg).includes(reflogBranchCmd(branch)) && msgLinesOf(msg).includes(REFLOG_HEAD_CMD),
    onsite: msg.includes('现场原样保留，不要自行删除任何东西') && msg.includes(`交在场人员按 ${CLAUDE_MD_SECTION}一节处理`),
    onlyReflogCmds: same(cmdishLinesOf(msg), [reflogBranchCmd(branch), REFLOG_HEAD_CMD]),
    clean: manualStepsClean(msg, siteOpts(fx, wt, branch, extra, mapPath)),
    note: lastLineIsNote(msg),
});
/** 非递归拆联接（.NET Directory.Delete(path) 对联接只拆链接本身；经 spawnSync 参数数组传递，不过外层 shell；测试代码自己拆，命令不取自消息）。 */
const psDeleteLink = (p) => spawnSync('powershell.exe', ['-NoProfile', '-Command', `[System.IO.Directory]::Delete('${String(p).split("'").join("''")}')`], { encoding: 'utf8', windowsHide: true, timeout: 60000 });

/** PowerShell `Test-Path -LiteralPath '<路径>'`（CLAUDE.md 第 2 步的复核命令；经 spawnSync 参数数组，单引号字面量，路径里的单引号写两个）。stdout 为 True / False。 */
const psTestPath = (p) => spawnSync('powershell.exe', ['-NoProfile', '-Command', `Test-Path -LiteralPath '${String(p).split("'").join("''")}'`], { encoding: 'utf8', windowsHide: true, timeout: 60000 });

/**
 * CLAUDE.md 第 3 步原文命令 `git -c core.quotePath=false status --porcelain=v1 --ignored --untracked-files=all`；只额外加了 `-z`（便于按 NUL 解析路径），其余参数一字不差。
 * `--untracked-files=all` 不能省：配了 `status.showUntrackedFiles=no` 时不加它一个未跟踪 / 被忽略文件都列不出（11.28p2 对照）。
 */
const RULE_STATUS_ARGS = ['-c', 'core.quotePath=false', 'status', '--porcelain=v1', '-z', '--ignored', '--untracked-files=all'];
const statusEntriesOf = (r) => String(r.stdout).split('\0').filter(Boolean).map((e) => ({ xy: e.slice(0, 2), p: e.slice(3) }));
/** 在 worktree 目录里跑第 3 步的 status：返回退出码、全部条目，以及规则要判的三类（`?? ` 未跟踪 → 停；路径含 node_modules → 停；`!! ` 被忽略 → 备份）。args 可替换（变异自证 / 对照用）。 */
function ruleStatus(wt, args) {
    const r = spawnSync('git', args || RULE_STATUS_ARGS, { cwd: wt, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    const entries = statusEntriesOf(r);
    return {
        st: r.status, err: r.stderr, entries,
        untracked: entries.filter((e) => e.xy === '??').map((e) => e.p),
        nodeMods: entries.filter((e) => e.p.includes('node_modules')).map((e) => e.p),
        ign: entries.filter((e) => e.xy === '!!').map((e) => e.p),
    };
}
/** 第 3 步「`!! ` 条目逐个复制到 worktree 之外备份」：mkdtemp 私有备份目录 + copyTreeNoFollow（遇链接抛错）。返回 { dir, err }；用完由调用方 removeTree(dir)。 */
function preserveIgnored(wt, ign) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), '行线 备份 '));
    let err = null;
    try { for (const p of ign) { const rel = p.replace(/\/$/, ''); copyTreeNoFollow(path.join(wt, rel), path.join(dir, rel)); } } catch (e) { err = e && e.message; }
    return { dir, err };
}

/**
 * CLAUDE.md 第 1 步「直接读清单列出的两个 reflog 文件」：每行前两列（旧值、新值）里的 40 位提交号都算，全零的跳过。返回去重后的数组。
 * （`git reflog show` 只显示每条记录的新值，只出现在旧值列的提交它看不到。）文件读不到时抛错，不静默当空。
 */
const ZERO_OID = '0'.repeat(40);
function oidsFromReflogFiles(files) {
    const set = new Set();
    for (const f of files) {
        const text = fs.readFileSync(f, 'utf8');
        for (const line of text.split(/\r?\n/)) {
            const cols = line.split(/\s+/);
            for (const c of [cols[0], cols[1]]) if (/^[0-9a-f]{40}$/.test(c || '') && c !== ZERO_OID) set.add(c);
        }
    }
    return [...set];
}
/** 清单列出的两个 reflog 文件：worktree 的 HEAD reflog（管理目录 logs/HEAD，由 worktree 里 `git rev-parse --absolute-git-dir` 得出）与主工作区的线分支 reflog（.git/logs/refs/heads/<分支>）。必须在 worktree / 分支删除之前调用。 */
function reflogFilesOf(fx, wt, branch) {
    const gd = spawnSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: wt, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    const adminDir = gd.status === 0 ? path.normalize(gd.stdout.trim()) : path.join(wt, '<未能取得管理目录>');
    return [path.join(adminDir, 'logs', 'HEAD'), path.join(fx.main, '.git', 'logs', 'refs', 'heads', ...String(branch).split('/'))];
}
/** 复制文件 / 目录树（备份被 git 忽略的文件用）：不跟随链接，遇到链接就抛错；只用 mkdirSync / copyFileSync（Node v24 的 cpSync 对中文路径不可靠）。 */
function copyTreeNoFollow(src, dst) {
    const st = fs.lstatSync(src);
    if (st.isSymbolicLink()) throw new Error(`备份遇到链接，拒绝跟随：${src}`);
    if (st.isDirectory()) {
        fs.mkdirSync(dst, { recursive: true });
        for (const n of fs.readdirSync(src)) copyTreeNoFollow(path.join(src, n), path.join(dst, n));
    } else {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
    }
}

/** 包 createIsolatedDb：记录调用时的现场（.sdh-instance 是否已在、来源键等）。返回 { calls, restore }。 */
function hookCreateDb() {
    const orig = instanceDb.createIsolatedDb;
    const calls = [];
    instanceDb.createIsolatedDb = async function wrapped(a) {
        const idFile = path.join(path.dirname(a.targetDbPath), '.sdh-instance');
        calls.push({ args: Object.assign({}, a), idExists: fs.existsSync(idFile), idText: fs.existsSync(idFile) ? rd(idFile) : null });
        return orig.call(this, a);
    };
    return { calls, restore: () => { instanceDb.createIsolatedDb = orig; } };
}

async function newLine(fx, name, mod, extra, lines, ctxExtra) {
    const out = lines || [];
    const r = await attempt(() => N.lineNew(ctxOf(fx, out, ctxExtra), newArgs(name, mod, extra)));
    return Object.assign(r, { out });
}
const commitIn = (fx, name, file, text) => { w(path.join(wtOf(fx, name), 'wbs-server', file), text); git(wtOf(fx, name), ['add', '-A']); git(wtOf(fx, name), ['commit', '-q', '-m', `c-${file}`]); };
/** 动态秘密集合去重加入。 */
const addDyn = (v) => { if (typeof v === 'string' && v !== '' && !DYN_SECRETS.includes(v)) DYN_SECRETS.push(v); };
/**
 * 收集所有夹具里每条线 .env 的 JWT_SECRET（线随机生成的）进动态秘密集合——含 CLI 与工作进程建出来的线。删线之前、起 CLI / 工作进程之前、最后扫描之前都调用，
 * 这样一条线即使已被删除，它的 JWT 也在最后的泄漏扫描集合里。
 */
function harvestJwts() {
    for (const root of ALL_ROOTS) {
        const linesDir = path.join(root, '线 目录');
        let names = [];
        try { names = fs.readdirSync(linesDir); } catch (_) { continue; }
        for (const n of names) {
            try { addDyn(dotenv.parse(fs.readFileSync(path.join(linesDir, n, 'wbs-server', '.env'))).JWT_SECRET); } catch (_) { /* 这条线没有 .env */ }
        }
    }
}
// 所有进程内的删线调用都经这里：同时记录被测代码发出的全部 git 命令（REMOVAL_GIT），节 11 末尾断言其中没有 worktree remove / prune
const removeLine = async (fx, name, args, ctxExtra, lines) => { harvestJwts(); return (await recordGit(() => attempt(() => R.lineRemove(ctxOf(fx, lines || [], ctxExtra), Object.assign({ name }, args || {}))), true)).res; };

// ================================================================ 各节

async function sec1() {
    section('1', 'line new 成功');
    const fx = await buildFixture('s1');
    const T = '2026-03-01T00:00:00.000Z';
    const mainShaBefore = sha(fx.mainDb);
    const hook = hookCreateDb();
    const lines = [];
    let r;
    try { r = await attempt(() => N.lineNew(ctxOf(fx, lines, { stateOpts: { now: () => new Date(T) } }), newArgs('line-a', 'mod-x'))); } finally { hook.restore(); }
    check('1.0 line new 成功（无异常）', r.err === null, r.err && r.err.message);
    if (r.err) return;
    const res = r.res;
    const wt = wtOf(fx, 'line-a');
    const st = await regOf(fx);
    const rec = st.lines['line-a'];
    const gen = rec.generation;
    check('1.1 登记整条记录（除代次外）全等于手写期望：ready、槽位 1、端口 3100、浅依赖；代次是 UUID', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(gen) && same(rec, {
        name: 'line-a', generation: gen, lifecycle: 'ready', failed_step: null, integration: { state: 'idle' }, yield_request: null, module: 'mod-x', branch: 'line/line-a', worktree: wt,
        slot: 1, port: 3100, surface: SURFACE_A, deps_mode: 'shared', process: null, created_at: T, updated_at: T,
    }), rec);
    check('1.2 分支 line/line-a 存在且与 main 同提交', git(fx.main, ['rev-parse', 'refs/heads/line/line-a']).trim() === git(fx.main, ['rev-parse', 'refs/heads/main']).trim());
    check('1.3 worktree 目录存在且登记在 git worktree list 里', fs.statSync(wt).isDirectory() && git(fx.main, ['worktree', 'list', '--porcelain', '-z']).split('\0').some((f) => f.startsWith('worktree ') && C.samePath(f.slice(9), wt)));
    for (const rel of NM_RELS) {
        const link = path.join(wt, rel);
        const target = path.join(fx.main, rel);
        check(`1.4 ${rel} 是联接（lstat.isSymbolicLink）且指向主工作区`, fs.lstatSync(link).isSymbolicLink() && C.samePath(link, target) && fs.realpathSync.native(link).toLowerCase() === fs.realpathSync.native(target).toLowerCase());
        check(`1.4b ${rel} 经联接能读到主工作区的哨兵文件`, rd(path.join(link, 'sentinel.txt')) === rd(path.join(target, 'sentinel.txt')));
    }
    check('1.5 .sdh-instance 内容精确等于 "line-a\\n"', rd(path.join(wt, 'wbs-server', '.sdh-instance')) === 'line-a\n');
    const cfg = instanceMode.resolveInstanceConfig({ env: {}, checkoutDir: path.join(wt, 'wbs-server') });
    check('1.5b 按 instance-mode 判定为线服务（isolated / line / 线名 / 线库路径）', !cfg.refuse && cfg.mode === 'isolated' && cfg.kind === 'line' && cfg.instance === 'line-a' && path.resolve(cfg.dbFile) === path.resolve(wt, 'wbs-server', 'task_pool.db'), cfg);
    const lineDb = path.join(wt, 'wbs-server', 'task_pool.db');
    const idRows = await dbQuery(lineDb, 'SELECT id, instance_id, source FROM _sdh_instance');
    check('1.6 线库身份行：恰好一行、id=1、instance_id=线名、source={"parent":"main","from":"line-new"}', idRows.length === 1 && idRows[0].id === 1 && idRows[0].instance_id === 'line-a' && same(JSON.parse(idRows[0].source), { parent: 'main', from: 'line-new' }), idRows);
    const cfgRows = await dbQuery(lineDb, 'SELECT config_key, config_value_encrypted FROM system_configs ORDER BY config_key');
    check('1.7 线库 system_configs 键集合 = 钉钉四键 + 7 键（非白名单键不存在）', same(cfgRows.map((x) => x.config_key), sorted([...Object.keys(REAL_DT), ...Object.keys(SEVEN)])), cfgRows.map((x) => x.config_key));
    const dec = {};
    for (const x of cfgRows) dec[x.config_key] = aes.decryptWithKey(aes.ISOLATED_ENCRYPTION_KEY, x.config_value_encrypted);
    check('1.8 钉钉四键是虚拟值（与 VIRTUAL_DINGTALK_CONFIG 全等，不含真值）', Object.keys(REAL_DT).every((k) => dec[k] === instanceDb.VIRTUAL_DINGTALK_CONFIG[k] && dec[k] !== REAL_DT[k]));
    check('1.9 7 键明文与主库相同（隔离键解开）', Object.keys(SEVEN).every((k) => dec[k] === SEVEN[k]), dec);
    const conn = await dbQuery(lineDb, 'SELECT password FROM db_connections');
    check('1.10 外部库口令已清（db_connections.password 全为空串）', conn.length === 1 && conn[0].password === '', conn);
    check('1.11 来源（主库）文件字节不变（只读快照）', sha(fx.mainDb) === mainShaBefore);
    for (const [key, [, dst, text]] of Object.entries(RT_FILES)) {
        const f = path.join(wt, 'wbs-server', dst);
        check(`1.12 运行期哨兵 ${key} 已复制到线（内容一致）`, fs.existsSync(f) && rd(f) === text, f);
    }
    check('1.12b 对账附件只落在线读取的 it-reconcile，不落 routes/it-ledger/uploads', !fs.existsSync(path.join(wt, 'wbs-server', 'routes', 'it-ledger', 'uploads')));
    check('1.13 缺失附件恰好 1 条（collab_attachments#2），告警里列出；核对总数 3', res.missingAttachments.count === 1 && res.missingAttachments.first[0].table === 'collab_attachments' && res.missingAttachments.first[0].id === 2 && hasLine(lines, 'collab/2/missing.xlsx') && res.attachmentCheck.checked === 3, res.missingAttachments);
    const envBack = dotenv.parse(fs.readFileSync(path.join(wt, 'wbs-server', '.env')));
    const lineJwt = envBack.JWT_SECRET;
    addDyn(lineJwt);
    SEC1_JWT = lineJwt;
    check('1.14 线 .env 键集合全等于手写期望（JWT_SECRET + 三个拷贝键；无 DB_ENCRYPTION_KEY / PORT / SDH_*），拷贝键值原样', same(Object.keys(envBack).sort(), sorted(['JWT_SECRET', ...Object.keys(EXPECTED_LINE_ENV_COPIED)])) && Object.keys(EXPECTED_LINE_ENV_COPIED).every((k) => envBack[k] === EXPECTED_LINE_ENV_COPIED[k]), Object.keys(envBack));
    check('1.14a 线的 JWT_SECRET 是本线随机生成的 64 位十六进制，与主工作区的值不同', /^[0-9a-f]{64}$/.test(lineJwt || '') && lineJwt !== JWT);
    check('1.14b 被丢弃的键名（只键名）与手写期望一致（含主工作区的 JWT_SECRET）', same(sorted(res.envDropped), EXPECTED_ENV_DROPPED), res.envDropped);
    check('1.15 configRewritten = 7 键；configDropped = 仅 non_whitelist_key(not_whitelisted)', same(res.configRewritten, sorted(Object.keys(SEVEN))) && same(res.configDropped, [{ key: 'non_whitelist_key', reason: 'not_whitelisted' }]), { rw: res.configRewritten, dr: res.configDropped });
    check('1.16 线检出 git status --untracked-files=all 干净（新增文件都被忽略规则覆盖，含联接与归属标记）', gitq(wt, ['status', '--porcelain', '--untracked-files=all']).trim() === '', gitq(wt, ['status', '--porcelain', '--untracked-files=all']));
    check('1.17 createIsolatedDb 被调用 1 次：来源键 = 主 .env 的键、身份 = 线名、父 = main、来源 = 主库、目标 = 线库', hook.calls.length === 1 && hook.calls[0].args.sourceEncryptionKey === FAKE_KEY && hook.calls[0].args.instanceId === 'line-a' && hook.calls[0].args.parent === 'main'
        && C.samePath(hook.calls[0].args.sourceDbPath, fx.mainDb) && path.resolve(hook.calls[0].args.targetDbPath) === path.resolve(lineDb), hook.calls.map((c) => Object.assign({}, c.args, { sourceEncryptionKey: '…' })));
    check('1.18 建库时 .sdh-instance 已就位且内容正确（先写身份文件、再建库）', hook.calls.length === 1 && hook.calls[0].idExists === true && hook.calls[0].idText === 'line-a\n', hook.calls.map((c) => ({ e: c.idExists, t: c.idText })));
    const text = lines.join('\n');
    check('1.19 开线单含线名 / 分支 / 路径 / 端口 / 槽位 / 线库 / 缺失附件数 / 锚点位置 / 禁区', ['line-a', 'line/line-a', wt, '3100', lineDb, '缺失附件数：1', path.join(fx.main, 'docs', 'local', 'mod-x'), '不得改依赖', '不得用 3000 端口', '不得登录生产'].every((s) => text.includes(s)));
    check('1.19b 开线单打印了 configRewritten / configDropped 的键名与原因', text.includes('collab_notify_admin_on_submit') && text.includes('non_whitelist_key(not_whitelisted)'));
    check('1.20 开线单与全部输出里搜不到手写秘密集合（假 DB 键、JWT、webhook、真钉钉值、外部库口令、非白名单配置值、evil-main）也搜不到线的随机 JWT', [...LEAK_STRINGS, lineJwt].every((s) => !text.includes(s)), [...LEAK_STRINGS, lineJwt].filter((s) => text.includes(s)));
    // 归属凭据
    const ownerRec = JSON.parse(rd(ownerFileOf(fx, gen)));
    const adminDir = path.join(fx.main, '.git', 'worktrees', ownerRec.admin_id || '?');
    check('1.21 归属记录（控制根 owners/<代次>.json）：线名 / 代次 / 分支 / 真实 worktree 路径 / 分支提交 oid / 管理目录 id 与真实路径', ownerRec.name === 'line-a' && ownerRec.generation === gen && ownerRec.branch === 'line/line-a' && C.fold(ownerRec.worktree) === C.pathKey(wt) && ownerRec.branch_oid === git(fx.main, ['rev-parse', 'refs/heads/line/line-a']).trim()
        && typeof ownerRec.admin_id === 'string' && ownerRec.admin_id !== '' && C.pathKey(ownerRec.admin_dir) === C.pathKey(adminDir) && fs.statSync(adminDir).isDirectory(), ownerRec);
    const marker = JSON.parse(rd(path.join(adminDir, 'sdh-line-owner.json')));
    check('1.22 归属标记在 worktree 的私有管理目录里（<公共目录>/worktrees/<id>/sdh-line-owner.json）：线名 / 代次 / 分支 / worktree 与登记一致', marker.name === 'line-a' && marker.generation === gen && marker.branch === 'line/line-a' && C.fold(marker.worktree) === C.pathKey(wt), marker);
    check('1.22b worktree 里（根及整棵树）没有任何本工具的文件：根目录条目只有 git 检出的跟踪文件、.git、node_modules、wbs-server 等', (() => { const bad = []; const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); const s = fs.lstatSync(p); if (/sdh-line-owner/i.test(n)) bad.push(p); if (s.isDirectory() && !s.isSymbolicLink() && n !== 'node_modules') walk(p); } }; walk(wt); return bad.length === 0; })() && !fs.existsSync(path.join(wt, '.sdh-line-owner')));
    check('1.22c 管理目录与 worktree 互相指向：gitdir 文件指向 <worktree>/.git，worktree 的 .git 文件指回管理目录', C.pathKey(path.dirname(rd(path.join(adminDir, 'gitdir')).trim())) === C.pathKey(wt) && C.pathKey(C.readWorktreeGitPointer(wt)) === C.pathKey(adminDir));
    const dup = await newLine(fx, 'line-a', 'mod-x', { ackOverlap: true });
    check('1.23 重复线名被拒绝（STATE_LINE_EXISTS）且登记不变', dup.err && dup.err.code === 'STATE_LINE_EXISTS' && same((await regOf(fx)).lines['line-a'], rec));
}

async function sec2() {
    section('2', '建库顺序（防呆锁住顺序）');
    const fx = await buildFixture('s2');
    const ord = path.join(fx.lines, 'ord');
    git(fx.main, ['worktree', 'add', '-q', '-b', 'ord-branch', ord, 'main']);
    const target = path.join(ord, 'wbs-server', 'task_pool.db');
    const e1 = await attempt(() => instanceDb.createIsolatedDb({ sourceDbPath: fx.mainDb, targetDbPath: target, instanceId: 'ord', parent: 'main', from: 't', sourceEncryptionKey: FAKE_KEY }));
    check('2.1 目标检出缺 .sdh-instance：createIsolatedDb 拒绝', e1.err !== null && /拒绝在/.test(e1.err.message) && /没有 \.sdh-instance/.test(e1.err.message), e1.err && e1.err.message);
    check('2.1b 被拒绝时没有留下线库文件', !fs.existsSync(target));
    w(path.join(ord, 'wbs-server', '.sdh-instance'), 'ord\n');
    const e2 = await attempt(() => instanceDb.createIsolatedDb({ sourceDbPath: fx.mainDb, targetDbPath: target, instanceId: 'ord', parent: 'main', from: 't', sourceEncryptionKey: FAKE_KEY }));
    check('2.2 先写 .sdh-instance 后同一调用成功（顺序是唯一差别）', e2.err === null && fs.existsSync(target), e2.err && e2.err.message);
}

// ---- 子进程工作者（双进程竞争用）
let recSeq = 0;
/** 新建一个 git 记录文件路径（子进程写、父进程读；登记进 ALL_ROOTS 由节 8 清理）。 */
function newRecFile() {
    recSeq += 1;
    const f = path.join(os.tmpdir(), `lines-gitrec-${process.pid}-${recSeq}.jsonl`);
    ALL_ROOTS.push(f);
    return f;
}
let preloadFile = null;
function recorderPreload() {
    if (preloadFile === null) {
        preloadFile = path.join(os.tmpdir(), `lines-gitrec-preload-${process.pid}.js`);
        ALL_ROOTS.push(preloadFile);
        fs.writeFileSync(preloadFile, RECORDER_PRELOAD_SRC);
    }
    return preloadFile;
}
/** 子进程里记录到的 git 调用并入父进程汇总：删线场景（isRemoval）进 REMOVAL_GIT；recordGit 期间同时进 GIT_REC.calls。 */
function absorbChildRecs(recs, isRemoval) {
    for (const a of recs) {
        if (GIT_REC.depth > 0) GIT_REC.calls.push(a);
        if (isRemoval) REMOVAL_GIT.push(a);
    }
}
function runWorker(spec, timeoutMs) {
    return new Promise((resolve) => {
        const recFile = newRecFile();
        const child = spawn(process.execPath, [__filename, `--lines-dir=${LINES_DIR}`, `--worker=${Buffer.from(JSON.stringify(spec)).toString('base64')}`], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: Object.assign({}, process.env, { LINES_TEST_GIT_REC: recFile }) });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });
        const timer = setTimeout(() => { try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 20000 }); } catch (_) { /* */ } }, timeoutMs || 180000);
        const fin = (code, o) => { clearTimeout(timer); ALL_OUT.push(o); const gitRecs = readRecFile(recFile); absorbChildRecs(gitRecs, spec.cmd === 'remove'); resolve({ code, out: o, gitRecs }); };
        child.on('close', (code) => fin(code, out));
        child.on('error', (e) => fin(-1, String(e)));
    });
}
/** 轮询等待条件成立（到达信号 + 有界超时）；超时返回 false。 */
async function waitFor(pred, timeoutMs) {
    const end = Date.now() + (timeoutMs || 60000);
    while (Date.now() < end) {
        if (pred()) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return pred();
}
/**
 * 工作进程协议：加载完被测库后写 readyFile，等 goFile 出现再执行；业务输出随结果返回（父进程并入泄漏语料）。
 *   spec.hold === 'beforeRemoving'（remove）：持线级锁期间写 lockedFile 并停在钩子里，等 releaseFile 出现才继续（用来固定「第一个持锁、第二个启动」的交错）。
 *   spec.startedFile：go 之后、调用被测函数之前写下（证明这个进程确实已经在调用里了）。
 */
async function workerMain(spec) {
    const writeOut = (o) => fs.writeFileSync(spec.outFile, JSON.stringify(o));
    const outLines = [];
    const hooks = {};
    if (spec.hold === 'beforeRemoving') {
        hooks.beforeRemoving = async () => {
            fs.writeFileSync(spec.lockedFile, 'locked');
            while (!fs.existsSync(spec.releaseFile)) await new Promise((resolve) => setTimeout(resolve, 25));
        };
    }
    const ctx = { mainRoot: spec.mainRoot, controlRoot: spec.controlRoot, linesRoot: spec.linesRoot, out: (s) => outLines.push(String(s)), testHooks: hooks };
    if (spec.lockTimeoutMs) ctx.lineLockTimeoutMs = spec.lockTimeoutMs;
    if (spec.readyFile) fs.writeFileSync(spec.readyFile, 'ready');
    while (!fs.existsSync(spec.goFile)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    if (spec.startedFile) fs.writeFileSync(spec.startedFile, 'started');
    try {
        if (spec.cmd === 'new') await N.lineNew(ctx, spec.args); else await R.lineRemove(ctx, spec.args);
        writeOut({ ok: true, out: outLines });
    } catch (e) { writeOut({ ok: false, code: e && e.code, message: String(e && e.message).slice(0, 300), out: outLines }); }
}

async function sec3() {
    section('3', '同模块闸门（锁内）与槽位');
    const fx = await buildFixture('s3');
    const a = await newLine(fx, 'line-a', 'mod-x');
    check('3.0 line-a 建成', a.err === null, a.err && a.err.message);
    const before = await regOf(fx);
    const b = await newLine(fx, 'line-b', 'mod-x');
    check('3.1 同模块第二条线不带 --ack-overlap 被拒（LINE_MODULE_OVERLAP），消息含对方线名与预计改动面', b.err && b.err.code === 'LINE_MODULE_OVERLAP' && b.err.message.includes('line-a') && b.err.message.includes(SURFACE_A), b.err && b.err.message);
    check('3.2 被拒后登记完全不变（没有新记录、槽位 2 未占）', same(await regOf(fx), before));
    check('3.3 被拒后没有 worktree 目录、没有分支', !fs.existsSync(wtOf(fx, 'line-b')) && git(fx.main, ['branch', '--list', 'line/line-b']).trim() === '');
    const b2 = await newLine(fx, 'line-b', ' MOD-X ');
    check('3.4 模块名大小写 / 首尾空白不同仍算同模块（被拒）', b2.err && b2.err.code === 'LINE_MODULE_OVERLAP', b2.err && b2.err.message);
    const b3 = await newLine(fx, 'line-b', 'mod-x', { ackOverlap: true });
    const st = await regOf(fx);
    check('3.5 带 --ack-overlap 成功：槽位 2、端口 3200，输出里有第一条线的预计改动面', b3.err === null && st.lines['line-b'].slot === 2 && st.lines['line-b'].port === 3200 && st.lines['line-b'].lifecycle === 'ready' && hasLine(b3.out, `预计改动面：${SURFACE_A}`), b3.err && b3.err.message);
    const c = await newLine(fx, 'line-c', 'mod-y');
    check('3.6 不同模块无需确认：槽位 3、端口 3300', c.err === null && (await regOf(fx)).lines['line-c'].slot === 3 && (await regOf(fx)).lines['line-c'].port === 3300, c.err && c.err.message);
    const regFull = await regOf(fx);
    const d = await newLine(fx, 'line-d', 'mod-z');
    check('3.7 槽位用满后再建被拒（STATE_NO_FREE_SLOT），登记不变、没有目录与分支', d.err && d.err.code === 'STATE_NO_FREE_SLOT' && same(await regOf(fx), regFull) && !fs.existsSync(wtOf(fx, 'line-d')) && git(fx.main, ['branch', '--list', 'line/line-d']).trim() === '');
    check('3.8 线名规则沿用 S2a（main / test- 前缀被拒，且不建登记）', (await newLine(fx, 'main', 'm')).err.code === 'LINE_BAD_ARGS' && (await newLine(fx, 'test-1', 'm')).err.code === 'LINE_BAD_ARGS' && same(await regOf(fx), regFull));

    // 3.9 过期预检查：在目标调用进入状态层之前，用原始状态函数先登记一条同模块线 → 目标必须在锁内被拒
    const fx2 = await buildFixture('s3stale');
    const origCreate = S.createLine;
    S.createLine = async function stale(cr, nm, init, opts) {
        if (nm === 'line-x') await origCreate.call(S, cr, 'rival', { module: 'mod-race', branch: 'line/rival', worktree: wtOf(fx2, 'rival'), surface: 'rival-surface', deps_mode: 'shared' });
        return origCreate.call(S, cr, nm, init, opts);
    };
    let sx;
    try { sx = await newLine(fx2, 'line-x', 'mod-race'); } finally { S.createLine = origCreate; }
    const stx = await regOf(fx2);
    check('3.9 过期预检查：竞争线在目标进入状态层之前登记 → 目标被拒（LINE_MODULE_OVERLAP，消息含竞争线的改动面）', sx.err && sx.err.code === 'LINE_MODULE_OVERLAP' && sx.err.message.includes('rival') && sx.err.message.includes('rival-surface'), sx.err && sx.err.message);
    check('3.9b 竞争线保留、目标无记录无产物', Object.keys(stx.lines).join() === 'rival' && stx.lines.rival.lifecycle === 'creating' && !fs.existsSync(wtOf(fx2, 'line-x')) && !branchExists(fx2, 'line/line-x'));

    // 3.9c 「目标已读模块 → 竞争线登记 → 目标继续提交」的确定性交错：目标的第一次 readState 返回之后（目标手里已经有一份不含竞争线的快照），
    //   先用原始状态函数登记一条同模块线，再放目标继续。闸门只能在 createLine 的状态锁内用重读的登记表判（用目标早先读到的快照判就会放行）。
    const fx2c = await buildFixture('s3read');
    const origRead = S.readState;
    const origCreateC = S.createLine;
    let armed = true;
    S.readState = async function afterReadRegisterRival(...a) {
        const snapshot = await origRead.apply(this, a);
        if (armed) {
            armed = false;
            await origCreateC.call(S, fx2c.control, 'rival2', { module: 'mod-race2', branch: 'line/rival2', worktree: wtOf(fx2c, 'rival2'), surface: 'rival2-surface', deps_mode: 'shared' });
        }
        return snapshot;
    };
    let sy;
    try { sy = await newLine(fx2c, 'line-y', 'mod-race2'); } finally { S.readState = origRead; }
    const sty = await regOf(fx2c);
    check('3.9c 目标已读登记表之后、竞争线才登记：目标仍被闸门拒绝（LINE_MODULE_OVERLAP，消息含竞争线的改动面）', sy.err && sy.err.code === 'LINE_MODULE_OVERLAP' && sy.err.message.includes('rival2-surface'), sy.err && sy.err.message);
    check('3.9d 竞争线保留、目标无记录无产物', Object.keys(sty.lines).join() === 'rival2' && !fs.existsSync(wtOf(fx2c, 'line-y')) && !branchExists(fx2c, 'line/line-y'));

    // 3.10 双进程竞争（就绪确认 + 同一个 go 信号）：两个进程都确认加载完毕、停在 go 之前，再同时放行 → 恰好一个成功、另一个被闸门拒绝
    const fx3 = await buildFixture('s3race');
    const goFile = path.join(fx3.root, 'go.flag');
    const mk = (nm) => ({ cmd: 'new', mainRoot: fx3.main, controlRoot: fx3.control, linesRoot: fx3.lines, goFile, readyFile: path.join(fx3.root, `${nm}.ready`), outFile: path.join(fx3.root, `${nm}.out.json`), args: newArgs(nm, 'mod-race') });
    const specs = [mk('race-a'), mk('race-b')];
    const procs = specs.map((s) => runWorker(s, 240000));
    const bothReady = await waitFor(() => specs.every((s) => fs.existsSync(s.readyFile)), 90000);
    check('3.10a 两个工作进程都已就绪（加载完被测库、停在 go 信号之前）', bothReady);
    fs.writeFileSync(goFile, 'go');
    const rr = await Promise.all(procs);
    const outs = specs.map((s) => { try { return JSON.parse(rd(s.outFile)); } catch (_) { return null; } });
    for (const o of outs) if (o) ALL_OUT.push(JSON.stringify(o));   // 工作进程的业务输出与错误消息并入泄漏语料
    check('3.10 双进程竞争：两个工作进程都正常结束并留下结果', rr.every((x) => x.code === 0) && outs.every((o) => o !== null), { codes: rr.map((x) => x.code), outs });
    const okCount = outs.filter((o) => o && o.ok).length;
    const rejected = outs.filter((o) => o && !o.ok);
    check('3.10b 恰好一个成功，另一个被同模块闸门拒绝（LINE_MODULE_OVERLAP）', okCount === 1 && rejected.length === 1 && rejected[0].code === 'LINE_MODULE_OVERLAP', outs);
    const st3 = await regOf(fx3);
    check('3.10c 登记里只有胜出的一条线（ready），败者没有记录 / 目录 / 分支', Object.keys(st3.lines).length === 1 && Object.values(st3.lines)[0].lifecycle === 'ready' && fs.readdirSync(fx3.lines).length === 1, st3);
}

async function sec4() {
    section('4', '失败路径与清理；预先存在的资源不被删');
    const fx = await buildFixture('s4');
    fs.unlinkSync(fx.mainDb);   // 让建线库步骤失败：来源库不存在
    const f = await newLine(fx, 'line-f', 'mod-f');
    check('4.1 来源库不存在：line new 失败（LINE_NEW_FAILED，step=create_db），消息提示 line remove --discard', f.err && f.err.code === 'LINE_NEW_FAILED' && f.err.step === 'create_db' && /line remove line-f --discard/.test(f.err.message), f.err && f.err.message);
    const st = await regOf(fx);
    check('4.2 登记 lifecycle=failed、failed_step=create_db，槽位仍占用', st.lines['line-f'] && st.lines['line-f'].lifecycle === 'failed' && st.lines['line-f'].failed_step === 'create_db' && st.lines['line-f'].slot === 1, st.lines['line-f']);
    const wt = wtOf(fx, 'line-f');
    const ownerF = JSON.parse(rd(ownerFileOf(fx, st.lines['line-f'].generation)));
    check('4.3 已建出的东西原样保留（worktree、两个联接、.sdh-instance、两份归属凭据：控制根记录 + 管理目录里的标记；worktree 根没有标记文件）', fs.existsSync(wt) && NM_RELS.every((rel) => isLink(path.join(wt, rel))) && fs.existsSync(path.join(wt, 'wbs-server', '.sdh-instance'))
        && fs.existsSync(path.join(ownerF.admin_dir, 'sdh-line-owner.json')) && !fs.existsSync(path.join(wt, '.sdh-line-owner')));
    check('4.3b 失败后没有留下线库与 .sdh-create-* 临时目录', !fs.existsSync(path.join(wt, 'wbs-server', 'task_pool.db')) && fs.readdirSync(path.join(wt, 'wbs-server')).every((n) => !n.startsWith('.sdh-create-')));
    const gen = st.lines['line-f'].generation;
    const rm = await removeLine(fx, 'line-f', { discard: true });
    check('4.4 line remove --discard 清理成功', rm.err === null, rm.err && rm.err.message);
    const st2 = await regOf(fx);
    check('4.5 槽位释放（lines 为空）、旧记录进 history（removed，代次保留）', Object.keys(st2.lines).length === 0 && st2.history.length === 1 && st2.history[0].name === 'line-f' && st2.history[0].lifecycle === 'removed' && st2.history[0].failed_step === null && st2.history[0].generation === gen, st2.history);
    check('4.6 worktree 与联接都不在，主工作区深度摘要完好；归属记录已删', !fs.existsSync(wt) && mainIntact(fx) && !fs.existsSync(ownerFileOf(fx, gen)));
    check('4.7 分支已清理（与 main 同提交=已合入）', !branchExists(fx, 'line/line-f'));

    // 4b：目录被别人占用（不是 worktree）→ 失败，remove 不得动这个目录
    w(path.join(wtOf(fx, 'line-g'), 'foreign.txt'), 'FOREIGN');
    const g = await newLine(fx, 'line-g', 'mod-g');
    check('4.8 目标目录已存在：失败于 worktree 步骤（不复用、不覆盖）', g.err && g.err.step === 'worktree' && /目录已存在/.test(g.err.message), g.err && g.err.message);
    check('4.8b 此时没有 line/line-g 分支、没有归属记录', !branchExists(fx, 'line/line-g') && !fs.existsSync(path.join(wtOf(fx, 'line-g'), 'wbs-server')) && (!fs.existsSync(path.join(fx.control, 'owners')) || fs.readdirSync(path.join(fx.control, 'owners')).length === 0));
    const rl = [];
    const gr = await removeLine(fx, 'line-g', {}, {}, rl);
    check('4.9 remove 失败线（worktree 未由本工具建出）：登记清理成功', gr.err === null && Object.keys((await regOf(fx)).lines).length === 0, gr.err && gr.err.message);
    check('4.9b 不是本工具建出的目录原样保留（哨兵文件还在），并有提示', rd(path.join(wtOf(fx, 'line-g'), 'foreign.txt')) === 'FOREIGN' && hasLine(rl, '证明不了是本工具'));

    // 4c：预先存在的 worktree（另一分支，带未提交文件）→ new 失败，remove --discard 只清登记
    const pre = wtOf(fx, 'line-p');
    git(fx.main, ['worktree', 'add', '-q', '-b', 'preexisting-branch', pre, 'main']);
    w(path.join(pre, 'wbs-server', 'uncommitted.txt'), 'PRE-UNCOMMITTED');
    const p = await newLine(fx, 'line-p', 'mod-p');
    check('4.10 目标目录是预先存在的已登记 worktree：line new 失败（precheck 或 worktree 步骤）', p.err && ['precheck', 'worktree'].includes(p.err.step), p.err && p.err.message);
    const pr = await removeLine(fx, 'line-p', { discard: true });
    check('4.11 remove --discard 只清登记；预先存在的 worktree（含未提交文件）、其分支、git 登记全部原样', pr.err === null && Object.keys((await regOf(fx)).lines).length === 0 && rd(path.join(pre, 'wbs-server', 'uncommitted.txt')) === 'PRE-UNCOMMITTED' && branchExists(fx, 'preexisting-branch') && git(fx.main, ['worktree', 'list', '--porcelain', '-z']).split('\0').some((x) => x.startsWith('worktree ') && C.samePath(x.slice(9), pre)), pr.err && pr.err.message);

    // 4d：预先存在的同名分支（已与 main 同提交=已合入）→ new 失败，remove 不删这个分支
    git(fx.main, ['branch', 'line/line-q', 'main']);
    const q = await newLine(fx, 'line-q', 'mod-q');
    check('4.12 预先存在的同名分支：line new 失败于 worktree 步骤（分支已存在，不复用）', q.err && q.err.step === 'worktree' && /分支已存在/.test(q.err.message) && !fs.existsSync(wtOf(fx, 'line-q')), q.err && q.err.message);
    const qr = await removeLine(fx, 'line-q', { discard: true });
    check('4.13 remove 只清登记，预先存在的分支（即使已合入）原样保留', qr.err === null && branchExists(fx, 'line/line-q') && Object.keys((await regOf(fx)).lines).length === 0, qr.err && qr.err.message);
}

async function sec5() {
    section('5', 'line remove：拒绝 / --discard / 已合入 / HEAD 与 reflog / 分支条件删除');
    const fx = await buildFixture('s5');
    const a = await newLine(fx, 'l1', 'mod-1');
    check('5.0 l1 建成', a.err === null, a.err && a.err.message);
    if (a.err) return;
    const wt1 = wtOf(fx, 'l1');
    const regReady = await regOf(fx);
    w(path.join(wt1, 'wbs-server', 'new-file.txt'), 'untracked');
    const d1 = await removeLine(fx, 'l1');
    check('5.1 有未提交改动（未跟踪文件）：拒绝', d1.err && d1.err.code === 'LINE_REMOVE_REFUSED' && /未提交改动/.test(d1.err.message), d1.err && d1.err.message);
    check('5.1b 拒绝后登记不变（仍 ready）、worktree 与联接都在、主工作区深度摘要完好', same(await regOf(fx), regReady) && NM_RELS.every((rel) => isLink(path.join(wt1, rel))) && mainIntact(fx));
    fs.unlinkSync(path.join(wt1, 'wbs-server', 'new-file.txt'));
    fs.appendFileSync(path.join(wt1, 'wbs-server', 'hello.txt'), 'more\n');
    const d2 = await removeLine(fx, 'l1');
    check('5.2 已跟踪文件有修改：拒绝', d2.err && d2.err.code === 'LINE_REMOVE_REFUSED' && /未提交改动/.test(d2.err.message), d2.err && d2.err.message);
    gitq(wt1, ['checkout', '--', 'wbs-server/hello.txt']);   // 临时仓库内还原（用户 git 配置 autocrlf=true，检出为 CRLF，手写 LF 会被 git 判为已修改）
    check('5.2b 还原后 git status 干净', gitq(wt1, ['status', '--porcelain', '--untracked-files=all']).trim() === '', gitq(wt1, ['status', '--porcelain']));
    commitIn(fx, 'l1', 'feature.txt', 'feature');
    const d3 = await removeLine(fx, 'l1');
    check('5.3 有未合入集成分支的提交：拒绝（消息含提交数）', d3.err && d3.err.code === 'LINE_REMOVE_REFUSED' && /1 个未合入 main 的提交/.test(d3.err.message), d3.err && d3.err.message);
    check('5.3b 拒绝后登记 / 联接 / 主工作区深度摘要不变', same(await regOf(fx), regReady) && NM_RELS.every((rel) => isLink(path.join(wt1, rel))) && mainIntact(fx));
    const out4 = [];
    const d4 = await removeLine(fx, 'l1', { discard: true }, {}, out4);
    check('5.4 --discard 成功', d4.err === null, d4.err && d4.err.message);
    if (!d4.err) {
        check('5.4a 两个联接都被非递归拆除（junctionsRemoved 全等于手写期望），逐项删除统计里有文件', same(d4.res.junctionsRemoved, NM_RELS) && d4.res.treeDeleted.files > 0, d4.res.junctionsRemoved);
        check('5.4b worktree 已删除，登记已 removed 进 history 且槽位释放', !fs.existsSync(wt1) && Object.keys((await regOf(fx)).lines).length === 0 && (await regOf(fx)).history.length === 1);
        check('5.4c 未合入分支保留（提交没丢），输出提示分支名', branchExists(fx, 'line/l1') && d4.res.branchKept === true && hasLine(out4, 'line/l1') && !d4.res.branchDeleted);
        check('5.4d 主工作区两级 node_modules 与 uploads 的深度摘要（完整相对路径 + 类型 + 内容 sha256）全等', mainIntact(fx));
    }
    // 5.5 已合入
    const b = await newLine(fx, 'l2', 'mod-2');
    check('5.5.0 l2 建成', b.err === null, b.err && b.err.message);
    commitIn(fx, 'l2', 'feature2.txt', 'f2');
    git(fx.main, ['merge', '-q', '--no-ff', '-m', 'merge l2', 'line/l2']);
    const d5 = await removeLine(fx, 'l2');
    check('5.5 已合入：不带 --discard 成功，分支被条件删除', d5.err === null && !branchExists(fx, 'line/l2') && d5.res.branchDeleted === true, d5.err && d5.err.message);
    check('5.5b 已合入删线后：worktree 不在、主工作区深度摘要不变', !fs.existsSync(wtOf(fx, 'l2')) && mainIntact(fx));
    // 5.6 主工作区 HEAD 在别的分支：条件删除不依赖主工作区 HEAD
    const c = await newLine(fx, 'l3', 'mod-3');
    check('5.6.0 l3 建成', c.err === null, c.err && c.err.message);
    commitIn(fx, 'l3', 'feature3.txt', 'f3');
    git(fx.main, ['merge', '-q', '--no-ff', '-m', 'merge l3', 'line/l3']);
    git(fx.main, ['branch', 'other', 'main~2']);
    git(fx.main, ['switch', '-q', 'other']);
    const d6 = await removeLine(fx, 'l3');
    git(fx.main, ['switch', '-q', 'main']);
    check('5.6 主工作区 HEAD 在别的分支：已合入的线照常删除，分支被条件删除', d6.err === null && !branchExists(fx, 'line/l3'), d6.err && d6.err.message);
    check('5.7 三次删线后主工作区深度摘要仍不变', mainIntact(fx));
    const nope = await removeLine(fx, 'nope');
    check('5.8 不存在的线：LINE_NO_SUCH_LINE', nope.err && nope.err.code === 'LINE_NO_SUCH_LINE');

    // 5.9 detached HEAD 上有提交（登记分支本身已合入、worktree 干净）：不带 --discard 必须拒绝
    const e4 = await newLine(fx, 'l4', 'mod-4');
    check('5.9.0 l4 建成', e4.err === null, e4.err && e4.err.message);
    gitq(wtOf(fx, 'l4'), ['checkout', '-q', '--detach']);
    commitIn(fx, 'l4', 'detached.txt', 'only-on-detached-head');
    const detachedOid = git(wtOf(fx, 'l4'), ['rev-parse', 'HEAD']).trim();
    const d9 = await removeLine(fx, 'l4');
    check('5.9 detached HEAD 上有提交：拒绝（消息说明 HEAD 不是线分支且不在集成分支里）', d9.err && d9.err.code === 'LINE_REMOVE_REFUSED' && /HEAD（detached/.test(d9.err.message), d9.err && d9.err.message);
    check('5.9b 拒绝后 worktree 与那个提交都在', fs.existsSync(wtOf(fx, 'l4')) && git(wtOf(fx, 'l4'), ['rev-parse', 'HEAD']).trim() === detachedOid && mainIntact(fx));
    const d9b = await removeLine(fx, 'l4', { discard: true });
    check('5.9c --discard 才能删', d9b.err === null && !fs.existsSync(wtOf(fx, 'l4')), d9b.err && d9b.err.message);

    // 5.10 HEAD reflog 里有被丢弃的提交（commit 后 reset --hard 回到线分支原位，status 干净、分支已合入）
    const e5 = await newLine(fx, 'l5', 'mod-5');
    check('5.10.0 l5 建成', e5.err === null, e5.err && e5.err.message);
    commitIn(fx, 'l5', 'lost.txt', 'lost-by-reset');
    const lostOid = git(wtOf(fx, 'l5'), ['rev-parse', 'HEAD']).trim();
    git(wtOf(fx, 'l5'), ['reset', '-q', '--hard', 'HEAD~1']);
    check('5.10.1 前置：reset 之后 worktree 干净，HEAD = 线分支 = main 的提交', gitq(wtOf(fx, 'l5'), ['status', '--porcelain', '--untracked-files=all']).trim() === '' && git(wtOf(fx, 'l5'), ['rev-parse', 'HEAD']).trim() === git(fx.main, ['rev-parse', 'refs/heads/main']).trim());
    const d10 = await removeLine(fx, 'l5');
    check('5.10 HEAD reflog 里有不被集成分支或线分支包含的提交：拒绝并列出提交', d10.err && d10.err.code === 'LINE_REMOVE_REFUSED' && /reflog/.test(d10.err.message) && d10.err.message.includes(lostOid.slice(0, 10)), d10.err && d10.err.message);
    const d10b = await removeLine(fx, 'l5', { discard: true });
    check('5.10b --discard 才能删', d10b.err === null && !fs.existsSync(wtOf(fx, 'l5')), d10b.err && d10b.err.message);

    // 5.11 分支在检查之后前移 → 条件删除失败；重试时分支（已含未合入提交）保留
    const e6 = await newLine(fx, 'l6', 'mod-6');
    check('5.11.0 l6 建成', e6.err === null, e6.err && e6.err.message);
    let movedTo = null;
    const d11 = await removeLine(fx, 'l6', {}, { testHooks: { beforeBranchDelete: (oid) => {
        const tree = git(fx.main, ['rev-parse', 'refs/heads/main^{tree}']).trim();
        movedTo = git(fx.main, ['commit-tree', tree, '-p', oid, '-m', 'moved-after-check']).trim();
        git(fx.main, ['update-ref', 'refs/heads/line/l6', movedTo]);
    } } });
    check('5.11 分支在检查之后前移：条件删除失败（branch_delete），分支保留在新位置', d11.err && d11.err.code === 'LINE_REMOVE_FAILED' && d11.err.step === 'branch_delete' && git(fx.main, ['rev-parse', 'refs/heads/line/l6']).trim() === movedTo, d11.err && d11.err.message);
    const st11 = await regOf(fx);
    check('5.11b 登记 failed（branch_delete）；worktree 已删', st11.lines.l6.lifecycle === 'failed' && st11.lines.l6.failed_step === 'branch_delete' && !fs.existsSync(wtOf(fx, 'l6')));
    const d11b = await removeLine(fx, 'l6');
    check('5.11c 重试成功：新位置的分支含未合入提交 → 保留并提示，登记移入 history', d11b.err === null && d11b.res.branchKept === true && branchExists(fx, 'line/l6') && !(await regOf(fx)).lines.l6, d11b.err && d11b.err.message);

    // 5.12 status.showUntrackedFiles=no：工具用的 status 不受用户配置影响
    git(fx.main, ['config', 'status.showUntrackedFiles', 'no']);
    const e7 = await newLine(fx, 'l7', 'mod-7');
    check('5.12.0 l7 建成', e7.err === null, e7.err && e7.err.message);
    w(path.join(wtOf(fx, 'l7'), 'wbs-server', 'hidden-untracked.txt'), 'U');
    check('5.12.1 前置：此配置下普通 git status --porcelain 看不到未跟踪文件', gitq(wtOf(fx, 'l7'), ['status', '--porcelain']).trim() === '');
    const d12 = await removeLine(fx, 'l7');
    check('5.12 showUntrackedFiles=no 的仓库里未跟踪文件仍被识别：拒绝', d12.err && d12.err.code === 'LINE_REMOVE_REFUSED' && /未提交改动/.test(d12.err.message) && /hidden-untracked\.txt/.test(d12.err.message), d12.err && d12.err.message);
    git(fx.main, ['config', '--unset', 'status.showUntrackedFiles']);
    const d12b = await removeLine(fx, 'l7', { discard: true });
    check('5.12b --discard 清理', d12b.err === null, d12b.err && d12b.err.message);
    check('5.13 全部删线结束后主工作区深度摘要仍不变', mainIntact(fx));

    // 5.14 worktree 目录已被人手删掉（git 里留着失效登记）：只清「这一条线」的管理目录，不动别的失效登记（不用 git worktree prune）
    const stale = path.join(fx.root, '别人的 失效 worktree', 'stale-x');
    git(fx.main, ['worktree', 'add', '-q', '-b', 'stale-branch', stale, 'main']);
    check('5.14.0 前置：另有一个失效登记（目录删掉、git 里还留着）', removeTree(stale).length === 0 && !fs.existsSync(stale) && fs.existsSync(path.join(fx.main, '.git', 'worktrees', 'stale-x')));
    const e8 = await newLine(fx, 'l8', 'mod-8');
    check('5.14.1 l8 建成', e8.err === null, e8.err && e8.err.message);
    if (!e8.err) {
        check('5.14.2 前置：人手删掉 l8 的 worktree 目录（git 登记还在）', removeTree(wtOf(fx, 'l8')).length === 0 && !fs.existsSync(wtOf(fx, 'l8')) && fs.existsSync(path.join(fx.main, '.git', 'worktrees', 'l8')));
        const d14 = await removeLine(fx, 'l8');
        const wlist = git(fx.main, ['worktree', 'list', '--porcelain', '-z']).split('\0').filter((x) => x.startsWith('worktree '));
        check('5.14 删线成功：l8 的 git 管理目录被清掉，而别人的失效登记（stale-x）原样保留', d14.err === null && !fs.existsSync(path.join(fx.main, '.git', 'worktrees', 'l8')) && fs.existsSync(path.join(fx.main, '.git', 'worktrees', 'stale-x')) && wlist.every((x) => !/[\\/]l8$/.test(x)), d14.err && d14.err.message);
        check('5.14b 分支已条件删除，主工作区完好', !branchExists(fx, 'line/l8') && mainIntact(fx));
    }
}

async function sec6() {
    section('6', '预检防线（修改之前中止）');
    const fx = await buildFixture('s6');
    const a = await newLine(fx, 'l1', 'mod-1');
    check('6.0 l1 建成', a.err === null, a.err && a.err.message);
    if (a.err) return;
    const wt = wtOf(fx, 'l1');
    const leak = path.join(wt, 'wbs-server', 'uploads', 'leak');
    C.makeJunction(path.join(fx.main, 'wbs-server', 'uploads'), leak);   // 模拟漏拆：worktree 里一个指向主工作区目录的 junction（落在被忽略的 uploads 下，git status 看不到）
    check('6.0b 前置：git status 干净（残留链接藏在被忽略目录里，dirty 检查拦不住）', gitq(wt, ['status', '--porcelain', '--untracked-files=all']).trim() === '');
    const regBefore6 = await regOf(fx);
    const r = await removeLine(fx, 'l1');
    check('6.1 预检拒绝（LINE_REMOVE_REFUSED，step=precheck，消息说明未做任何修改、登记表未变），消息列出残留链接路径', r.err && r.err.code === 'LINE_REMOVE_REFUSED' && r.err.step === 'precheck' && r.err.message.includes(leak) && /登记表未变/.test(r.err.message), r.err && r.err.message);
    const st = await regOf(fx);
    check('6.2 预检失败不改状态：登记表整体不变（lifecycle 仍是 ready、failed_step 为 null、槽位仍占用）', st.lines.l1 && st.lines.l1.lifecycle === 'ready' && st.lines.l1.failed_step === null && st.lines.l1.slot === 1 && same(st, regBefore6), st.lines.l1);
    check('6.3 修改之前中止：worktree 在、残留联接在、两个标准联接也都还在（一个都没拆）', fs.existsSync(wt) && isLink(leak) && NM_RELS.every((rel) => isLink(path.join(wt, rel))));
    check('6.4 主工作区被指向的目录内容完好（深度摘要）', mainIntact(fx) && rd(path.join(fx.main, 'wbs-server', 'uploads', '中文 目录', '文件 1.txt')) === 'RT-CJK-OK');
    C.removeLinkChecked(leak);
    const r2 = await removeLine(fx, 'l1');
    check('6.5 人工拆除残留联接后重试 remove 成功（ready → removing → removed）', r2.err === null && !fs.existsSync(wt) && Object.keys((await regOf(fx)).lines).length === 0, r2.err && r2.err.message);
    check('6.6 重试后主工作区仍完好', mainIntact(fx));

    // 6.7 建线：祖先目录在创建过程中被换成 junction（指向别处）→ 后续步骤在修改前中止，外部目录一个字节都不动
    const fx2 = await buildFixture('s6anc');
    const victim = path.join(fx2.root, '外部 受害');
    w(path.join(victim, 'victim-wbs', 'keep.txt'), 'VICTIM');
    const victimDigest = deepDigest(victim);
    const swap = async (stepName) => {
        if (stepName !== 'owner_record') return;
        const wtp = wtOf(fx2, 'anc');
        const left = removeTree(path.join(wtp, 'wbs-server'));
        if (left.length) throw new Error(`夹具：清理 wbs-server 失败 ${left.join()}`);
        C.makeJunction(path.join(victim, 'victim-wbs'), path.join(wtp, 'wbs-server'));
    };
    const an = await newLine(fx2, 'anc', 'mod-anc', {}, [], { testHooks: { afterStep: swap } });
    check('6.7 建线：祖先目录 wbs-server 被换成 junction → 失败于 node_modules_junction，消息说明是链接', an.err && an.err.step === 'node_modules_junction' && /链接/.test(an.err.message) && /LINE_UNSAFE_PATH|拒绝在其上修改/.test(an.err.message), an.err && an.err.message);
    check('6.7b 外部目录一个字节都没动（没有建联接、没有写 .sdh-instance / .env / 线库）', deepDigest(victim) === victimDigest, deepDigest(victim));
    check('6.7c 主工作区完好；登记 failed(node_modules_junction)', mainIntact(fx2) && (await regOf(fx2)).lines.anc.failed_step === 'node_modules_junction');
    // 清理：人工拆掉被换的 junction 后 remove --discard（worktree 里 wbs-server 已不存在，预检照常通过）
    C.removeLinkChecked(path.join(wtOf(fx2, 'anc'), 'wbs-server'));
    const anr = await removeLine(fx2, 'anc', { discard: true });
    check('6.7d 拆除后 remove --discard 成功，外部目录仍完好', anr.err === null && deepDigest(victim) === victimDigest, anr.err && anr.err.message);

    // 6.8 删线：祖先目录 wbs-server 被换成 junction，指向「另一个检出」（里面也有指向别处的 node_modules 联接）→ 预检在拆任何联接之前中止
    const fx3 = await buildFixture('s6anc2');
    const l1 = await newLine(fx3, 'l1', 'mod-1');
    check('6.8.0 l1 建成', l1.err === null, l1.err && l1.err.message);
    if (l1.err) return;
    const other = path.join(fx3.root, '另一个 检出');
    const otherNm = path.join(fx3.root, '另一个 依赖');
    w(path.join(otherNm, 'pkgZ', 'index.js'), 'OTHER-NM');
    w(path.join(other, 'wbs-server', 'keep.txt'), 'OTHER-CHECKOUT');
    C.makeJunction(otherNm, path.join(other, 'wbs-server', 'node_modules'));
    const otherDigest = deepDigest(other) + deepDigest(otherNm);
    const wt3 = wtOf(fx3, 'l1');
    check('6.8.1 前置：换掉 wbs-server', removeTree(path.join(wt3, 'wbs-server')).length === 0);
    C.makeJunction(path.join(other, 'wbs-server'), path.join(wt3, 'wbs-server'));
    const rm3 = await removeLine(fx3, 'l1', { discard: true });
    check('6.8 删线：祖先目录被换成 junction → 预检中止（step=precheck），消息说明', rm3.err && rm3.err.step === 'precheck' && /链接/.test(rm3.err.message), rm3.err && rm3.err.message);
    check('6.8b 另一个检出的 node_modules 联接及其目标一个都没被拆 / 删', isLink(path.join(other, 'wbs-server', 'node_modules')) && deepDigest(other) + deepDigest(otherNm) === otherDigest);
    check('6.8c 本线的根联接 node_modules 也没被拆（修改之前中止），worktree 还在，主工作区完好', isLink(path.join(wt3, 'node_modules')) && fs.existsSync(wt3) && mainIntact(fx3));
    C.removeLinkChecked(path.join(wt3, 'wbs-server'));
    const rm3b = await removeLine(fx3, 'l1', { discard: true });
    check('6.8d 人工拆除被换的 junction 后重试成功，另一个检出仍完好', rm3b.err === null && deepDigest(other) + deepDigest(otherNm) === otherDigest && mainIntact(fx3), rm3b.err && rm3b.err.message);
}

async function sec7() {
    section('7', '登记 process 非空');
    const fx = await buildFixture('s7');
    const a = await newLine(fx, 'l1', 'mod-1');
    check('7.0 l1 建成', a.err === null, a.err && a.err.message);
    if (a.err) return;
    const wt = wtOf(fx, 'l1');
    await S.updateLine(fx.control, 'l1', (r) => { r.process = { pid: 99999, start_time: '2026-03-01T00:00:00.000Z', cmd: 'node server.js', instance: 'l1' }; });
    const reg = await regOf(fx);
    const r1 = await removeLine(fx, 'l1');
    check('7.1 process 非空：拒绝，提示先 line stop', r1.err && r1.err.code === 'LINE_REMOVE_REFUSED' && /line stop l1/.test(r1.err.message), r1.err && r1.err.message);
    const r2 = await removeLine(fx, 'l1', { discard: true });
    check('7.2 带 --discard 同样拒绝', r2.err && r2.err.code === 'LINE_REMOVE_REFUSED' && /line stop/.test(r2.err.message));
    check('7.3 拒绝后登记不变（ready）、worktree 与联接都在、主工作区完好', same(await regOf(fx), reg) && NM_RELS.every((rel) => isLink(path.join(wt, rel))) && mainIntact(fx));
    await S.updateLine(fx.control, 'l1', (r) => { r.process = null; });
    // 7.5 removing 状态不能再登记进程（状态层不变量）：worktree 仍在
    await S.updateLine(fx.control, 'l1', (r) => { r.lifecycle = 'removing'; });
    const reg2 = await regOf(fx);
    const bad = await attempt(() => S.updateLine(fx.control, 'l1', (r) => { r.process = { pid: 99999, start_time: '2026-03-01T00:00:00.000Z', cmd: 'node server.js', instance: 'l1' }; }));
    check('7.5 已在 removing 的线登记 process：状态层拒绝（STATE_PROCESS_REGISTERED），登记不变、worktree 仍在', bad.err && bad.err.code === 'STATE_PROCESS_REGISTERED' && same(await regOf(fx), reg2) && fs.existsSync(wt));
    const r3 = await removeLine(fx, 'l1');
    check('7.4 清空 process 后可删除（removing 状态的线也能继续删）', r3.err === null && !fs.existsSync(wt), r3.err && r3.err.message);
}

function runCli(args, extra) {
    harvestJwts();   // CLI 可能删线：删之前先收集现有各线的随机 JWT
    const isRemove = args[0] === 'remove';
    const recFile = isRemove ? newRecFile() : null;   // remove 子命令：子进程里用同一份记录器（--require 预加载），记录汇总回父进程
    const opts = Object.assign({ encoding: 'utf8', timeout: 120000, windowsHide: true }, extra || {});
    if (recFile) opts.env = Object.assign({}, opts.env || process.env, { LINES_TEST_GIT_REC: recFile });
    const r = spawnSync(process.execPath, [...(recFile ? ['--require', recorderPreload()] : []), path.join(LINES_DIR, 'line.js'), ...args], opts);
    ALL_OUT.push(r.stdout || '', r.stderr || '');
    r.gitRecs = recFile ? readRecFile(recFile) : [];
    if (recFile) absorbChildRecs(r.gitRecs, true);
    return r;
}

async function sec9() {
    section('9', 'CLI：用法 / 根参数 / 入口转发 / 端到端');
    const P = L.parseArgv;
    check('9.1 缺子命令 / 未知子命令 / 缺线名 / 缺 --module / 缺 --surface / 多余位置参数 都是用法错误',
        !P([]).ok && !P(['frob', 'x']).ok && !P(['new']).ok && !P(['new', 'a', '--surface', 's']).ok && !P(['new', 'a', '--module', 'm']).ok && !P(['new', 'a', 'b', '--module', 'm', '--surface', 's']).ok);
    check('9.2 --module 吞到下一个 -- 开头的参数、空取值、remove 带 --module、new 带 --discard 都是用法错误',
        !P(['new', 'a', '--module', '--surface', 's']).ok && !P(['new', 'a', '--module=', '--surface', 's']).ok && !P(['remove', 'a', '--module', 'm']).ok && !P(['new', 'a', '--module', 'm', '--surface', 's', '--discard']).ok);
    const ok1 = P(['new', 'a', '--module', 'm', '--surface=x y', '--ack-overlap', '--no-config-key', '--lines-root', 'R']);
    check('9.3 合法 new 的解析结果（等号 / 空格两种取值写法、布尔开关、根路径覆盖）', ok1.ok && ok1.cmd === 'new' && ok1.name === 'a' && ok1.opts.module === 'm' && ok1.opts.surface === 'x y' && ok1.opts.ackOverlap === true && ok1.opts.noConfigKey === true && ok1.roots.linesRoot === path.resolve('R'), ok1);
    const ok2 = P(['remove', 'a', '--discard']);
    check('9.4 合法 remove 的解析结果', ok2.ok && ok2.cmd === 'remove' && ok2.opts.discard === true && Object.keys(ok2.roots).length === 0);
    const bad = runCli(['new', 'a', '--surface', 's', '--control-root', os.tmpdir(), '--lines-root', os.tmpdir(), '--main-root', os.tmpdir()]);
    check('9.5 进程级：用法错误退出码 2，stderr 有用法', bad.status === 2 && /用法错误/.test(bad.stderr), { s: bad.status, e: bad.stderr });
    check('9.5b scanRootOverrides：`--x v` 与 `--x=v` 两种写法都扫到', same(sorted(Array.from(L.scanRootOverrides(['--lines-root', 'a', '--control-root=b']))), ['--control-root', '--lines-root']) && L.scanRootOverrides(['new', 'x']).size === 0);
    const partial1 = runCli(['remove', 'x', '--lines-root', os.tmpdir()]);
    const partial2 = runCli(['remove', 'x', '--lines-root=' + os.tmpdir(), '--main-root=' + os.tmpdir()]);
    check('9.5c 根覆盖参数部分给（给一个 / 给两个）：用法错误退出码 2，消息指出缺哪个', partial1.status === 2 && /全给或全不给/.test(partial1.stderr) && /--control-root/.test(partial1.stderr) && partial2.status === 2 && /--control-root/.test(partial2.stderr), { a: partial1.stderr, b: partial2.stderr });

    // 9.6 转发判定与进程级转发
    const STUB = [
        "'use strict';", "const fs = require('fs'); const path = require('path');",
        "const main = path.resolve(__dirname, '..', '..');",
        "fs.writeFileSync(path.join(main, 'forward-record.json'), JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));",
        "let code = 0; try { code = Number(fs.readFileSync(path.join(main, 'exit-code.txt'), 'utf8')); } catch (_) {}",
        'process.exit(code);', '',
    ].join('\n');
    const fx = await buildFixture('s9fwd', { stubLine: STUB, noDb: true });
    const linked = path.join(fx.lines, 'linked');
    git(fx.main, ['worktree', 'add', '-q', '-b', 'linked-branch', linked, 'main']);
    fs.copyFileSync(path.join(LINES_DIR, 'line.js'), path.join(linked, 'scripts', 'lines', 'line.js'));   // 线检出里的入口 = 被测的真实 line.js（覆盖掉检出的替身）
    const dMain = L.decideForward({ argv: ['new', 'x'], scriptRoot: fx.main });
    const dLinked = L.decideForward({ argv: ['new', 'x'], scriptRoot: linked });
    const dOver = L.decideForward({ argv: ['new', 'x', '--lines-root', fx.lines], scriptRoot: linked });
    const dOverEq = L.decideForward({ argv: ['new', 'x', '--control-root=' + fx.lines], scriptRoot: linked });
    check('9.6 decideForward：主工作区不转发；线检出且无覆盖转发到主工作区的 line.js；带覆盖参数（两种写法）不转发',
        dMain.forward === false && dMain.reason === 'in-main' && dLinked.forward === true && C.samePath(dLinked.target, path.join(fx.main, 'scripts', 'lines', 'line.js')) && dOver.forward === false && dOver.reason === 'roots-overridden' && dOverEq.forward === false, { dMain, dLinked, dOver, dOverEq });
    w(path.join(fx.main, 'exit-code.txt'), '7');
    const argv = ['new', 'foo', '--module', 'm x', '--surface', 'a b；c'];
    const odd = path.join(fx.root, '调用 目录');
    fs.mkdirSync(odd, { recursive: true });
    const fr = spawnSync(process.execPath, [path.join(linked, 'scripts', 'lines', 'line.js'), ...argv], { cwd: odd, encoding: 'utf8', timeout: 60000, windowsHide: true });
    ALL_OUT.push(fr.stdout || '', fr.stderr || '');
    let rec = null;
    try { rec = JSON.parse(rd(path.join(fx.main, 'forward-record.json'))); } catch (_) { rec = null; }
    check('9.7进程级转发：替身收到的 argv 与原样一致', rec !== null && same(rec.argv, argv), rec);
    check('9.8 进程级转发：cwd 透传（替身的 cwd = 调用目录）', rec !== null && C.pathKey(rec.cwd) === C.pathKey(odd), rec);
    check('9.9 进程级转发：退出码透传（替身退出 7 → 入口退出 7）', fr.status === 7, { s: fr.status, e: fr.stderr });
    fs.unlinkSync(path.join(fx.main, 'forward-record.json'));
    const fr3 = spawnSync(process.execPath, [path.join(linked, 'scripts', 'lines', 'line.js'), 'new'], { cwd: odd, encoding: 'utf8', timeout: 60000, windowsHide: true });
    ALL_OUT.push(fr3.stdout || '', fr3.stderr || '');
    let rec3 = null;
    try { rec3 = JSON.parse(rd(path.join(fx.main, 'forward-record.json'))); } catch (_) { rec3 = null; }
    check('9.9b 转发先于参数解析：线检出里即使参数不合法（只有 new）也原样转发给主工作区（由主工作区报用法错误）', rec3 !== null && same(rec3.argv, ['new']) && fr3.status === 7, { rec3, s: fr3.status });
    fs.unlinkSync(path.join(fx.main, 'forward-record.json'));
    // 9.20 --slot-ports 在转发之前被拒：从线检出（linked，带 git 的夹具）运行被测 line.js，主工作区放的是替身。
    //   若转发前的检查失效，请求会被原样转发给替身：替身写出 forward-record.json、并按 exit-code.txt（此时是 7）退出——所以「没有 forward-record.json」且「退出码是 2 而不是 7」同时成立才算拒绝在转发之前。
    //   不再从真实检出运行（真实检出在回归时会读真实 .env 与真实控制根）。
    const SLOTS = '20201,20202,20203';
    const ranFrom = (extraArgv) => {
        const rr = spawnSync(process.execPath, [path.join(linked, 'scripts', 'lines', 'line.js'), ...extraArgv], { cwd: odd, encoding: 'utf8', timeout: 60000, windowsHide: true });
        ALL_OUT.push(rr.stdout || '', rr.stderr || '');
        return rr;
    };
    const FWD_REC = path.join(fx.main, 'forward-record.json');
    const sp0 = ranFrom(['list', '--slot-ports', SLOTS]);
    const sp0Fwd = fs.existsSync(FWD_REC);
    if (sp0Fwd) fs.unlinkSync(FWD_REC);
    const sp0b = ranFrom(['list', `--slot-ports=${SLOTS}`]);
    const sp0bFwd = fs.existsSync(FWD_REC);
    if (sp0bFwd) fs.unlinkSync(FWD_REC);
    const sp0c = ranFrom(['list', '--slot-ports', SLOTS, '--control-root', os.tmpdir()]);
    const sp0cFwd = fs.existsSync(FWD_REC);
    if (sp0cFwd) fs.unlinkSync(FWD_REC);
    check('9.20 进程级（从线检出运行，主工作区是替身）：不带根覆盖参数（`--x v` / `--x=v` 两种写法）或根不全时给 --slot-ports：退出码 2（不是替身的 7），stderr 点名 --slot-ports 或"全给或全不给"，替身没有被调用（没有 forward-record.json）',
        sp0.status === 2 && /--slot-ports/.test(sp0.stderr) && !sp0Fwd && sp0b.status === 2 && /--slot-ports/.test(sp0b.stderr) && !sp0bFwd && sp0c.status === 2 && /全给或全不给/.test(sp0c.stderr) && !sp0cFwd,
        { a: [sp0.status, sp0.stderr, sp0Fwd], b: [sp0b.status, sp0b.stderr, sp0bFwd], c: [sp0c.status, sp0c.stderr, sp0cFwd] });
    fs.unlinkSync(path.join(fx.main, 'scripts', 'lines', 'line.js'));
    const fr2 = spawnSync(process.execPath, [path.join(linked, 'scripts', 'lines', 'line.js'), ...argv], { cwd: odd, encoding: 'utf8', timeout: 60000, windowsHide: true });
    ALL_OUT.push(fr2.stdout || '', fr2.stderr || '');
    check('9.10 主工作区没有 scripts/lines/line.js：报错退出（退出码 1，消息说明无法转发），没有调用任何替身', fr2.status === 1 && /无法转发/.test(fr2.stderr) && !fs.existsSync(path.join(fx.main, 'forward-record.json')), { s: fr2.status, e: fr2.stderr });

    // 9.11 端到端（显式覆盖三个根路径）
    const fx2 = await buildFixture('s9e2e');
    const roots = ['--control-root', fx2.control, '--lines-root', fx2.lines, '--main-root', fx2.main];
    const cn = runCli(['new', 'cli-a', '--module', 'mod-c', '--surface', SURFACE_A, ...roots]);
    const outText = `${cn.stdout}\n${cn.stderr}`;
    check('9.11 CLI new 成功（退出码 0、开线单在 stdout）', cn.status === 0 && cn.stdout.includes('开线单：cli-a'), { s: cn.status, e: cn.stderr });
    check('9.12 CLI 输出（stdout + stderr）里搜不到任何密钥明文', LEAK_STRINGS.every((s) => !outText.includes(s)), LEAK_STRINGS.filter((s) => outText.includes(s)));
    check('9.13 CLI new 的登记：ready、槽位 1', (await regOf(fx2)).lines['cli-a'].lifecycle === 'ready');
    const cdup = runCli(['new', 'cli-b', '--module', 'mod-c', '--surface', 's2', ...roots]);
    check('9.14 CLI：同模块无 --ack-overlap 退出码 1，stderr 含对方线名', cdup.status === 1 && /cli-a/.test(cdup.stderr), { s: cdup.status, e: cdup.stderr });
    const crm = runCli(['remove', 'cli-a', ...roots]);
    check('9.15 CLI remove 成功（退出码 0）、worktree 不在、主工作区深度摘要完好', crm.status === 0 && !fs.existsSync(wtOf(fx2, 'cli-a')) && mainIntact(fx2), { s: crm.status, e: crm.stderr, o: crm.stdout });

    // 9.17 默认路径推导（不带任何覆盖）
    const fx3 = await buildFixture('s9default', { noDb: true });
    await S.createLine(fx3.control, 'dflt', { module: 'm', branch: 'line/dflt', worktree: wtOf(fx3, 'dflt'), surface: 's', deps_mode: 'shared' });
    const errs = [];
    const origErr = console.error;
    console.error = (...a) => { errs.push(a.join(' ')); ALL_OUT.push(a.join(' ')); };
    let code;
    try { code = await L.run(['remove', 'dflt'], fx3.main); } finally { console.error = origErr; }
    check('9.17 不带覆盖参数：控制根按 state.js 从 scriptRoot 推导（找到了登记的线），线目录根默认值不被触碰；creating 线被拒绝，退出码 1', code === 1 && errs.some((l) => /LINE_REMOVE_REFUSED/.test(l) && /creating/.test(l)), { code, errs });
    check('9.17b 默认线目录根常量是 E:/sdh-lines，且本节没有在其下建任何东西', L.DEFAULT_LINES_ROOT === 'E:/sdh-lines' && !fs.existsSync(wtOf(fx3, 'dflt')));
    // 9.18 覆盖到真实（脚本所在检出的 git 主仓库的）默认控制根 → 拒绝
    const errs2 = [];
    console.error = (...a) => { errs2.push(a.join(' ')); ALL_OUT.push(a.join(' ')); };
    let code2;
    try { code2 = await L.run(['remove', 'dflt', '--control-root', fx3.control, '--lines-root', fx3.lines, '--main-root', fx3.main], fx3.main); } finally { console.error = origErr; }
    check('9.18 三个根都给，但 --control-root 等于脚本所在主仓库的默认控制根：拒绝（退出码 2，消息说明），登记里的线原样', code2 === 2 && errs2.some((l) => /默认控制根/.test(l)) && (await regOf(fx3)).lines.dflt.lifecycle === 'creating', { code2, errs2 });
    const cno = runCli(['remove', 'cli-a', ...roots]);
    check('9.16 CLI remove 不存在的线：退出码 1', cno.status === 1 && /没有这条线/.test(cno.stderr), { s: cno.status, e: cno.stderr });

    // ---- 9.19–9.23 测试端口表 --slot-ports（H1）：期望值全部手写（20201 / 20202 / 20203 是只拿来写登记值的高位端口，不监听）----
    const rootsP =['--control-root', 'C', '--lines-root', 'L', '--main-root', 'M'];
    const okSp = P(['new', 'a', '--module', 'm', '--surface', 's', '--slot-ports', SLOTS, ...rootsP]);
    check('9.19 parseArgv：三个根都给时接受 --slot-ports，解析成 [20201,20202,20203]（`--x=v` 写法同样）', okSp.ok && same(okSp.opts.slotPorts, [20201, 20202, 20203]) && P(['list', `--slot-ports=${SLOTS}`, ...rootsP]).ok && same(P(['list', `--slot-ports=${SLOTS}`, ...rootsP]).opts.slotPorts, [20201, 20202, 20203]), okSp);
    check('9.19b parseArgv：不带根 / 只带一个或两个根时给 --slot-ports 都是用法错误（防「CLI 不检查根覆盖参数」）',
        !P(['list', '--slot-ports', SLOTS]).ok && !P(['list', '--slot-ports', SLOTS, '--control-root', 'C']).ok && !P(['list', '--slot-ports', SLOTS, '--control-root', 'C', '--lines-root', 'L']).ok);
    check('9.19c parseArgv：形态错（两段 / 四段 / 非数字 / 带空格 / 空取值）和重复给出都是用法错误',
        ['20201,20202', '20201,20202,20203,20204', 'a,b,c', '20201, 20202,20203', '20201,,20203', ''].every((v) => !P(['list', `--slot-ports=${v}`, ...rootsP]).ok) && !P(['list', '--slot-ports', SLOTS, '--slot-ports', SLOTS, ...rootsP]).ok);
    // （9.20 在上面 9.6–9.10 的 linked 夹具里：--slot-ports 缺根的进程级拒绝必须从线检出运行，不从真实检出运行）
    const fxS = await buildFixture('s9slotports');
    const rootsS = ['--control-root', fxS.control, '--lines-root', fxS.lines, '--main-root', fxS.main];
    const spBad = [['含 3100', '3100,20202,20203'], ['含 3000', '20201,3000,20203'], ['含 3300', '20201,20202,3300'], ['重复', '20201,20201,20203'], ['越界 1023', '1023,20202,20203'], ['越界 65536', '20201,65536,20203']];
    for (const [label, v] of spBad) {
        const rb = runCli(['new', 'sp-bad', '--module', 'm-bad', '--surface', 's', '--slot-ports', v, ...rootsS]);
        check(`9.21 --slot-ports 非法表（${label}）：退出码 2，stderr 说明不合规，没有建线（登记表无 sp-bad、worktree 不存在）`, rb.status === 2 && /--slot-ports 不合规/.test(rb.stderr) && (await regOf(fxS)).lines['sp-bad'] === undefined && !fs.existsSync(wtOf(fxS, 'sp-bad')), { s: rb.status, e: rb.stderr });
    }
    const sa = runCli(['new', 'sp-a', '--module', 'm-sa', '--surface', 's', '--slot-ports', SLOTS, ...rootsS]);
    const sb = runCli(['new', 'sp-b', '--module', 'm-sb', '--surface', 's', '--slot-ports', SLOTS, ...rootsS]);
    // 父进程里读这份登记表也要用同一张测试端口表校验（读完立即还原为生产缺省）；表里的端口写的是 CLI 子进程用的测试表
    const regUnderTable = async (fx, ports) => { S._internal.setSlotPortsForTest(ports); try { return await regOf(fx); } finally { S._internal.setSlotPortsForTest(null); } };
    const regS = await regUnderTable(fxS, [20201, 20202, 20203]);
    check('9.22 带三个根和 --slot-ports 20201,20202,20203：new 成功（退出码 0），登记的 slot / port 等于手写期望（sp-a = 槽位 1 / 20201，sp-b = 槽位 2 / 20202）；开线单里的端口也是测试端口（防分配仍读生产缺省常量）',
        sa.status === 0 && sb.status === 0 && regS.lines['sp-a'].slot === 1 && regS.lines['sp-a'].port === 20201 && regS.lines['sp-b'].slot === 2 && regS.lines['sp-b'].port === 20202 && sa.stdout.includes('槽位 / 端口：1 / 20201') && sa.stdout.includes('20201'), { sa: [sa.status, sa.stderr], sb: [sb.status, sb.stderr], reg: regS.lines });
    const lt = runCli(['list', '--json', '--slot-ports', SLOTS, ...rootsS]);
    let ltj = null;
    try { ltj = JSON.parse(lt.stdout); } catch (_) { ltj = null; }
    // 不用字符串子串判断（UUID / 进程号里可能碰巧含 3100）：解析登记文件，逐条核对 lines 与 history 里每条记录的 port（期望按槽位手写）
    let fileS = null;
    try { fileS = JSON.parse(rd(path.join(fxS.control, 'lines.json'))); } catch (_) { fileS = null; }
    const SP_PORT = { 1: 20201, 2: 20202, 3: 20203 };
    const recsS = fileS === null ? [] : Object.values(fileS.lines).concat(fileS.history);
    check('9.22b 同一测试表下读登记表通过校验（list --json 退出码 0，两条线的端口 20201 / 20202）；登记文件里 lines 与 history 的每条记录 port 都是测试端口（逐条核对），没有一条是生产端口 3100',
        lt.status === 0 && ltj !== null && same(ltj.lines.map((r) => r.port).sort(), [20201, 20202]) && fileS !== null && recsS.length === 2 && recsS.every((r) => r.port !== 3100 && r.port === SP_PORT[r.slot]), { s: lt.status, e: lt.stderr, recs: recsS.map((r) => [r.name, r.slot, r.port]) });
    const ltNo = runCli(['list', '--json', ...rootsS]);
    check('9.22c 不带 --slot-ports 读测试表下写的登记表：按生产缺省校验，端口 20201 与槽位 1 不对应 → 失败（退出码 1），stderr 是 STATE_CORRUPT 且点出「port 与槽位不对应（槽位 1 应为 3100）」，证明测试表只在本次进程内存里',
        ltNo.status === 1 && /STATE_CORRUPT/.test(ltNo.stderr) && ltNo.stderr.includes('port 与槽位不对应（槽位 1 应为 3100）'), { s: ltNo.status, e: ltNo.stderr });
    // 不设测试表：分配仍是生产缺省（只验登记值，CLI 不监听端口）
    const fxD = await buildFixture('s9slotdefault');
    const rootsD = ['--control-root', fxD.control, '--lines-root', fxD.lines, '--main-root', fxD.main];
    const sd = runCli(['new', 'sp-d', '--module', 'm-sd', '--surface', 's', ...rootsD]);
    const regD = await regOf(fxD);
    check('9.23 不带 --slot-ports：new 分配生产缺省（槽位 1 / 端口 3100，手写期望）', sd.status === 0 && regD.lines['sp-d'].slot === 1 && regD.lines['sp-d'].port === 3100, { s: sd.status, e: sd.stderr });
    // 9.24（codex 42 M）：同进程里调用导出的 run——测试端口表的作用域是一次 run：进入时选定（不带 --slot-ports = 生产缺省），退出时（成功或失败）还原生产缺省。
    // 观测方式：在本进程里读 fxD（9.23 用生产缺省写的登记表，sp-d = 槽位 1 / 3100）——当前表若残留测试表就会 STATE_CORRUPT
    const fxE = await buildFixture('s9slotinproc');
    const rootsE = ['--control-root', fxE.control, '--lines-root', fxE.lines, '--main-root', fxE.main];
    const quietRun = async (argv) => {
        const oLog = console.log; const oErr = console.error;
        console.log = (...a) => { ALL_OUT.push(a.join(' ')); }; console.error = (...a) => { ALL_OUT.push(a.join(' ')); };
        try { return await L.run(argv, SELF_CHECKOUT_ROOT); } finally { console.log = oLog; console.error = oErr; }
    };
    const readsDefault = async () => { try { const r = await regOf(fxD); return r.lines['sp-d'].port === 3100; } catch (e) { return `${e && e.code}`; } };
    const c1 = await quietRun(['new', 'ip-a', '--module', 'm-ipa', '--surface', 's', '--slot-ports', SLOTS, ...rootsE]);
    const after1 = await readsDefault();   // 必须在 regUnderTable 之前观测：regUnderTable 自己的 finally 会把表还原，放在它之后就看不出 run 有没有还原（变异「去掉 finally」实测漏网）
    const regE = await regUnderTable(fxE, [20201, 20202, 20203]);
    check('9.24a 同进程调用 run 带 --slot-ports 建线成功（退出码 0、登记 槽位 1 / 20201）；run 返回后本进程的当前端口表已还原为生产缺省（读 9.23 的生产缺省登记表正常）', c1 === 0 && !!regE.lines['ip-a'] && regE.lines['ip-a'].slot === 1 && regE.lines['ip-a'].port === 20201 && after1 === true, { c1, after1, port: regE.lines['ip-a'] && regE.lines['ip-a'].port });
    const c2 = await quietRun(['new', 'ip-a', '--module', 'm-ipa2', '--surface', 's', '--slot-ports', SLOTS, ...rootsE]);   // 同名再建：设表之后失败
    const after2 = await readsDefault();
    check('9.24b 带 --slot-ports 的 run 在设表之后失败（同名线已存在，退出码 1）：失败路径同样还原生产缺省', c2 === 1 && after2 === true, { c2, after2 });
    const fxF = await buildFixture('s9slotinproc2');   // 夹具先在生产缺省下建好，残留测试表只覆盖被测的那一次 run（codex 42-R L2）
    let c3;
    S._internal.setSlotPortsForTest([20201, 20202, 20203]);   // 模拟本进程里别处残留的测试表
    try { c3 = await quietRun(['new', 'ip-d', '--module', 'm-ipd', '--surface', 's', '--control-root', fxF.control, '--lines-root', fxF.lines, '--main-root', fxF.main]); } finally { S._internal.setSlotPortsForTest(null); }
    let regF = null; let regFErr = null;
    try { regF = await regOf(fxF); } catch (e) { regFErr = `${e && e.code}`; }   // 分配若用了残留测试表，按缺省读会 STATE_CORRUPT：记为断言失败而不是节异常
    check('9.24c 本进程当前表残留测试表时，不带 --slot-ports 的 run 仍按生产缺省分配（槽位 1 / 3100）：run 进入时明确选定生产缺省', c3 === 0 && regF !== null && !!regF.lines['ip-d'] && regF.lines['ip-d'].slot === 1 && regF.lines['ip-d'].port === 3100, { c3, regFErr, port: regF && regF.lines['ip-d'] && regF.lines['ip-d'].port });
}

async function sec10() {
    section('10', '实现项');
    // 10.1 .env 往返
    const tricky = ['plain-value_1.2', 'a b', 'a#b', "it's", 'back\\slash', 'dollar$VAR', ' lead', 'trail ', '', 'x"y', '=eq=', 'quote\'and"double'];
    const entries = tricky.map((v, i) => ({ key: `K${i}`, value: v }));
    const back = dotenv.parse(Buffer.from(N.renderEnvFile(entries)));
    check('10.1 renderEnvFile 对含空格 / # / 引号 / 反斜杠 / $ / 首尾空白 / 空串的值能被 dotenv 原样读回', entries.every((e) => back[e.key] === e.value), entries.filter((e) => back[e.key] !== e.value));
    let thrown = null;
    try { N.renderEnvFile([{ key: 'BAD', value: 'line\nbreak' }]); } catch (e) { thrown = e; }
    check('10.1b 含换行的值无法安全写入：抛 LINE_ENV_UNWRITABLE（不写出错误内容）', thrown && thrown.code === 'LINE_ENV_UNWRITABLE');

    // 10.2 白名单形态与大小写（JWT_SECRET 不再拷贝）
    const picked = N.pickEnvEntries({ jwt_secret: 'j', Sys_Fastlane_Enable: '1', jwt_SECRET: 'dup', DB_ENCRYPTION_KEY: 'k', PORT: '1', SDH_X: 'x', Sdh_y: 'y', NODE_ENV: 'n' });
    if (C.isWin) check('10.2 win32：白名单不分大小写匹配、写规范大写名；JWT_SECRET（任何大小写）/ 禁拷键 / SDH_* 全部丢弃', same(picked.entries, [{ key: 'SYS_FASTLANE_ENABLE', value: '1' }, { key: 'NODE_ENV', value: 'n' }]) && same(sorted(picked.dropped), sorted(['jwt_secret', 'jwt_SECRET', 'DB_ENCRYPTION_KEY', 'PORT', 'SDH_X', 'Sdh_y'])), picked);
    check('10.2b 拷贝白名单三键（手写）且不含任何禁拷键 / SDH_*；JWT_SECRET 属于线内随机生成', same(N.LINE_ENV_WHITELIST.map((x) => x.key), ['SYS_FASTLANE_ENABLE', 'LOG_LEVEL', 'NODE_ENV']) && N.LINE_ENV_WHITELIST.every((x) => !(x.key in N.LINE_ENV_NEVER) && !/^sdh_/i.test(x.key)) && same(N.LINE_ENV_GENERATED, ['JWT_SECRET']));

    // 10.3 附件表：手写全部 11 张表与列，逐表造存在与缺失，断言核对总数与缺失明细全等
    const dir = path.join(os.tmpdir(), `行线 测试 ${process.pid}-att`);
    ALL_ROOTS.push(dir);
    const rootsA = { uploads: path.join(dir, 'up'), archive: path.join(dir, 'ar'), inspection: path.join(dir, 'in'), periodic: path.join(dir, 'pe'), reconcile: path.join(dir, 're'), mainPeriodic: path.join(dir, '主 结果') };
    for (const d of Object.values(rootsA)) fs.mkdirSync(d, { recursive: true });
    const touch = (base, rel) => w(path.join(base, rel), 'x');
    const adb = path.join(dir, 'a.db');
    const dd = await dbOpen(adb, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);
    const PLAIN = ['task_attachments', 'issue_attachments', 'issue_lite_attachments', 'collab_attachments', 'sys_quick_log_attachments', 'sys_issue_attachments', 'correction_attachments'];   // 手写：七张 file_name 表
    for (const t of PLAIN) {
        await dbRun(dd, `CREATE TABLE ${t} (id INTEGER PRIMARY KEY AUTOINCREMENT, file_name TEXT)`);
        touch(rootsA.uploads, `${t}/ok.bin`);
        await dbRun(dd, `INSERT INTO ${t} (file_name) VALUES (?), (?)`, [`${t}/ok.bin`, `${t}/gone.bin`]);
    }
    await dbRun(dd, 'CREATE TABLE it_inspection_sheet_photos (id INTEGER PRIMARY KEY AUTOINCREMENT, stored_name TEXT)');
    touch(rootsA.inspection, 'aaaaaaaa-0000-0000-0000-000000000001.bin');
    await dbRun(dd, 'INSERT INTO it_inspection_sheet_photos (stored_name) VALUES (?), (?)', ['aaaaaaaa-0000-0000-0000-000000000001.bin', 'aaaaaaaa-0000-0000-0000-000000000002.bin']);
    await dbRun(dd, 'CREATE TABLE periodic_task_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, result_file_path TEXT)');
    touch(rootsA.periodic, 'r1.xlsx');
    await dbRun(dd, 'INSERT INTO periodic_task_runs (result_file_path) VALUES (?), (?), (?), (NULL), (?)', [path.join(rootsA.mainPeriodic, 'r1.xlsx'), path.join(rootsA.mainPeriodic, 'r2.xlsx'), path.join(dir, '别处', 'r3.xlsx'), '']);
    await dbRun(dd, 'CREATE TABLE it_reconciles (id INTEGER PRIMARY KEY AUTOINCREMENT, source_meta TEXT NOT NULL)');
    touch(rootsA.reconcile, 'rec-ok.xlsx');
    await dbRun(dd, 'INSERT INTO it_reconciles (source_meta) VALUES (?), (?), (?)', ['{"stored_name":"rec-ok.xlsx"}', '{"stored_name":"rec-gone.xlsx"}', 'not-json']);
    await dbRun(dd, 'CREATE TABLE task_pool (id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT, status TEXT)');
    touch(rootsA.uploads, 'tp/open.bin');
    touch(rootsA.archive, 'tp/arch.bin');
    touch(rootsA.uploads, 'tp/arch-only-in-uploads.bin');
    await dbRun(dd, 'INSERT INTO task_pool (file_path, status) VALUES (?, ?), (?, ?), (?, ?), (NULL, ?), (?, ?)', ['tp/open.bin', 'DONE', 'tp/arch.bin', 'ARCHIVED', 'tp/arch-only-in-uploads.bin', 'ARCHIVED', 'DONE', '', 'DONE']);
    await dbClose(dd);
    const att = await N.checkAttachments(adb, rootsA);
    const EXPECT_PER = {   // 手写期望：{ 核对数, 缺失数 }
        task_attachments: [2, 1], issue_attachments: [2, 1], issue_lite_attachments: [2, 1], collab_attachments: [2, 1], sys_quick_log_attachments: [2, 1], sys_issue_attachments: [2, 1], correction_attachments: [2, 1],
        it_inspection_sheet_photos: [2, 1], periodic_task_runs: [3, 2], it_reconciles: [3, 2], task_pool: [3, 1],
    };
    check('10.3 附件检查：11 张表逐表核对数与缺失数全等于手写期望', same(Object.fromEntries(Object.entries(att.perTable).map(([k, v]) => [k, [v.checked, v.missing]])), EXPECT_PER), att.perTable);
    check('10.3b 核对总数 = 25、缺失总数 = 13、没有缺表、没有读表错误', att.checked === 25 && att.missingCount === 13 && att.tablesAbsent.length === 0 && att.errors.length === 0, { c: att.checked, m: att.missingCount, a: att.tablesAbsent, e: att.errors });
    const missKeys = att.missing.map((m) => `${m.table}#${m.id}:${m.reason}`).sort();
    const wantMiss = [
        ...PLAIN.map((t) => `${t}#2:文件不存在`), 'it_inspection_sheet_photos#2:文件不存在',
        'periodic_task_runs#2:文件不存在', 'periodic_task_runs#3:路径不在主工作区结果目录之内', 'it_reconciles#2:文件不存在', 'it_reconciles#3:路径为空', 'task_pool#3:文件不存在',
    ].sort();
    check('10.3c 缺失明细（表#编号:原因）与手写期望全等（task_pool 的 ARCHIVED 行按 archive 目录判；periodic 的绝对路径按主结果目录换算；无效 JSON 算缺失）', same(missKeys, wantMiss), { got: missKeys, want: wantMiss });
    // 10.3d 流式：单表 30 条缺失 → 只留前 20 条明细，但总数是 30
    const bdb = path.join(dir, 'b.db');
    const bd = await dbOpen(bdb, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);
    await dbRun(bd, 'CREATE TABLE collab_attachments (id INTEGER PRIMARY KEY AUTOINCREMENT, file_name TEXT)');
    for (let i = 0; i < 30; i += 1) await dbRun(bd, 'INSERT INTO collab_attachments (file_name) VALUES (?)', [`gone/${i}.bin`]);
    await dbClose(bd);
    const attB = await N.checkAttachments(bdb, rootsA);
    check('10.3d 单表 30 条缺失：缺失总数 30，明细只留前 20 条；缺的 10 张表跳过（手写名单）', attB.missingCount === 30 && attB.missing.length === 20 && attB.checked === 30 && same(sorted(attB.tablesAbsent), sorted([
        'task_attachments', 'issue_attachments', 'issue_lite_attachments', 'sys_quick_log_attachments', 'sys_issue_attachments', 'correction_attachments', 'it_inspection_sheet_photos', 'periodic_task_runs', 'it_reconciles', 'task_pool',
    ])), { m: attB.missingCount, l: attB.missing.length, a: attB.tablesAbsent });

    // 10.4 junction 与删除助手
    const jd = path.join(dir, 'j');
    fs.mkdirSync(path.join(jd, '目标 目录', 'sub'), { recursive: true });
    w(path.join(jd, '目标 目录', 'sub', 'f.txt'), 'JF');
    C.makeJunction(path.join(jd, '目标 目录'), path.join(jd, '联接 路径'));
    check('10.4 makeJunction 在「中文 + 空格」路径下建出联接（lstat.isSymbolicLink、经联接读到内容）', fs.lstatSync(path.join(jd, '联接 路径')).isSymbolicLink() && rd(path.join(jd, '联接 路径', 'sub', 'f.txt')) === 'JF');
    check('10.4b makeJunction 目标不存在 / 联接路径已存在都报错', (() => { let a = null; let b = null; try { C.makeJunction(path.join(jd, '不存在'), path.join(jd, 'l2')); } catch (e) { a = e; } try { C.makeJunction(path.join(jd, '目标 目录'), path.join(jd, '联接 路径')); } catch (e) { b = e; } return a && a.code === 'LINE_JUNCTION_FAILED' && b && b.code === 'LINE_JUNCTION_FAILED'; })());
    check('10.4c removeLinkChecked 只拆链接：目标目录内容完好、链接路径不再存在', C.removeLinkChecked(path.join(jd, '联接 路径')) === true && !fs.existsSync(path.join(jd, '联接 路径')) && rd(path.join(jd, '目标 目录', 'sub', 'f.txt')) === 'JF');
    let notLink = null;
    try { C.removeLinkChecked(path.join(jd, '目标 目录')); } catch (e) { notLink = e; }
    check('10.4d removeLinkChecked 对真目录拒绝（LINE_NOT_A_LINK），目录内容完好；对不存在的路径返回 false', notLink && notLink.code === 'LINE_NOT_A_LINK' && rd(path.join(jd, '目标 目录', 'sub', 'f.txt')) === 'JF' && C.removeLinkChecked(path.join(jd, '没有这个')) === false);
    C.makeJunction(path.join(jd, '目标 目录'), path.join(jd, '目标 目录', 'sub', 'inner-link'));
    const scan = C.scanTree(fs.realpathSync.native(path.join(jd, '目标 目录')), []);
    check('10.4e scanTree 不跟随地找出嵌套的链接（只列链接本身，不下钻）', scan.unexpectedLinks.length === 1 && scan.unexpectedLinks[0].endsWith(path.join('sub', 'inner-link')) && scan.mismatches.length === 0, scan);
    check('10.4f copyTreeNoFollow 遇到链接拒绝并报路径', (() => { let e1 = null; try { C.copyTreeNoFollow(path.join(jd, '目标 目录'), path.join(jd, 'copy-dst')); } catch (e) { e1 = e; } return e1 && e1.code === 'LINE_LINK_REFUSED' && e1.message.includes('inner-link'); })());

    // 10.4g 逐项删除助手：树里有 junction 指向外部目录 → 只拆链接，外部完好；root 保留 .git
    const del = path.join(dir, 'del 树');
    const ext = path.join(dir, 'del 外部');
    w(path.join(ext, 'deep', 'keep.txt'), 'EXT-KEEP');
    w(path.join(del, '.git'), 'gitdir: x');
    w(path.join(del, 'a', 'b', 'c.txt'), 'C');
    w(path.join(del, 'ro.txt'), 'RO');
    fs.chmodSync(path.join(del, 'ro.txt'), 0o444);
    C.makeJunction(ext, path.join(del, 'a', 'link-to-ext'));
    const stats = C.deleteTreeNoFollow(fs.realpathSync.native(del), ['.git']);
    check('10.4g deleteTreeNoFollow：删光除 .git 以外的内容（含只读文件、嵌套目录），树内 junction 只拆链接，外部目录内容完好', fs.readdirSync(del).join() === '.git' && rd(path.join(ext, 'deep', 'keep.txt')) === 'EXT-KEEP' && stats.links === 1 && stats.files === 2, { left: fs.readdirSync(del), stats });
    // 10.4h 重解析点（lstat 是目录、realpath 不一致）——无法在本机造卷挂载点，用注入的 realpath 模拟；局限：只证明判据分支，不证明真实挂载点
    const fakeBase = path.join(dir, 'fake');
    w(path.join(fakeBase, 'ok', 'f.txt'), 'F');
    fs.mkdirSync(path.join(fakeBase, 'mnt-empty'), { recursive: true });
    w(path.join(fakeBase, 'mnt-full', 'inside.txt'), 'INSIDE');
    const fakeReal = (p) => { const r = fs.realpathSync.native(p); return /mnt-/.test(path.basename(p)) ? `${r}-REDIRECTED` : r; };
    const baseReal = fs.realpathSync.native(fakeBase);
    let chainErr = null;
    try { C.assertChainSafe(baseReal, 'mnt-full/inside.txt', { realpath: fakeReal }); } catch (e) { chainErr = e; }
    check('10.4h assertChainSafe：目录 lstat 是目录但 realpath 与「父真实路径 + 名字」不一致 → 抛 LINE_UNSAFE_PATH（重解析点）', chainErr && chainErr.code === 'LINE_UNSAFE_PATH' && /重解析点/.test(chainErr.message), chainErr && chainErr.message);
    const scanF = C.scanTree(baseReal, [], { realpath: fakeReal });
    check('10.4i scanTree：同样的目录记入 mismatches 且不下钻', scanF.mismatches.length === 2 && scanF.unexpectedLinks.length === 0, scanF);
    let delErr = null;
    try { C.deleteTreeNoFollow(baseReal, [], { realpath: fakeReal }); } catch (e) { delErr = e; }
    check('10.4j deleteTreeNoFollow：重解析点只做非递归 rmdir——空的拆掉、非空的拒绝进入并抛错，其内容原样', delErr && delErr.code === 'LINE_DELETE_FAILED' && rd(path.join(fakeBase, 'mnt-full', 'inside.txt')) === 'INSIDE' && !fs.existsSync(path.join(fakeBase, 'mnt-empty')), delErr && delErr.message);

    // 10.5 来源键三种情形；JWT 缺失不再是失败
    const fx = await buildFixture('s10keys');
    const hook = hookCreateDb();
    try {
        const k1 = await newLine(fx, 'k1', 'm-k1', { noConfigKey: true });
        check('10.5 --no-config-key：传给 createIsolatedDb 的来源键是 null；7 键全部 no_source_key 丢弃；输出有醒目提示', k1.err === null && hook.calls[0].args.sourceEncryptionKey === null
            && sorted(k1.res.configDropped.filter((x) => x.reason === 'no_source_key').map((x) => x.key)).join() === sorted(Object.keys(SEVEN)).join() && k1.res.configRewritten.length === 0 && hasLine(k1.out, '【注意】没有来源键'), k1.err && k1.err.message);
        await removeLine(fx, 'k1', { discard: true });
        w(path.join(fx.main, 'wbs-server', '.env'), ENV_TEXT.split('\n').filter((l) => !l.startsWith('DB_ENCRYPTION_KEY')).join('\n'));
        const k2 = await newLine(fx, 'k2', 'm-k2');
        check('10.6 主 .env 没有 DB_ENCRYPTION_KEY：同样传 null、7 键丢弃、有提示（不报错）', k2.err === null && hook.calls[1].args.sourceEncryptionKey === null && k2.res.configRewritten.length === 0 && hasLine(k2.out, '【注意】没有来源键'), k2.err && k2.err.message);
        await removeLine(fx, 'k2', { discard: true });
        w(path.join(fx.main, 'wbs-server', '.env'), ENV_TEXT.replace(FAKE_KEY, WRONG_KEY));
        const k3 = await newLine(fx, 'k3', 'm-k3');
        check('10.7 来源键错：失败于 create_db，消息提示确认键或加 --no-config-key，且消息里不含任何一个键', k3.err && k3.err.step === 'create_db' && /--no-config-key/.test(k3.err.message) && !k3.err.message.includes(WRONG_KEY) && !k3.err.message.includes(FAKE_KEY), k3.err && k3.err.message);
        check('10.7b 键错时 createIsolatedDb 没有留下线库文件', !fs.existsSync(path.join(wtOf(fx, 'k3'), 'wbs-server', 'task_pool.db')));
        await removeLine(fx, 'k3', { discard: true });
        w(path.join(fx.main, 'wbs-server', '.env'), ENV_TEXT.split('\n').filter((l) => !l.startsWith('JWT_SECRET')).join('\n'));
        const k4 = await newLine(fx, 'k4', 'm-k4');
        const k4env = k4.err === null ? dotenv.parse(fs.readFileSync(path.join(wtOf(fx, 'k4'), 'wbs-server', '.env'))) : {};
        check('10.8 主 .env 缺 JWT_SECRET 不再是失败条件：线照常建成，线的 JWT_SECRET 仍是随机生成的 64 位十六进制', k4.err === null && /^[0-9a-f]{64}$/.test(k4env.JWT_SECRET || ''), k4.err && k4.err.message);
        addDyn(k4env.JWT_SECRET);
        K4_JWT = k4env.JWT_SECRET || null;
        await removeLine(fx, 'k4');
        // 10.8c 主 .env 不可读（是个目录）：什么都没建，不占槽
        fs.unlinkSync(path.join(fx.main, 'wbs-server', '.env'));
        fs.mkdirSync(path.join(fx.main, 'wbs-server', '.env'));
        const k5 = await newLine(fx, 'k5', 'm-k5');
        check('10.8c 主 .env 读不了：报错退出，什么都没建（登记里没有这条线、没有目录）', k5.err && k5.err.code === 'LINE_ENV_UNREADABLE' && !(await regOf(fx)).lines.k5 && !fs.existsSync(wtOf(fx, 'k5')), k5.err && k5.err.message);
        fs.rmdirSync(path.join(fx.main, 'wbs-server', '.env'));
        w(path.join(fx.main, 'wbs-server', '.env'), ENV_TEXT);
    } finally { hook.restore(); }
    check('10.8d 两条线（节 1 的 line-a 与 k4）各自的 JWT_SECRET 互不相同，且都不等于主工作区的', ONLY && !RAN.has('1') ? true : (SEC1_JWT !== null && K4_JWT !== null && SEC1_JWT !== K4_JWT && SEC1_JWT !== JWT && K4_JWT !== JWT), { a: !!SEC1_JWT, b: !!K4_JWT });

    // 10.9 复制拒绝链接：主工作区 uploads 里有 junction
    const fx3 = await buildFixture('s10link');
    C.makeJunction(path.join(fx3.main, 'wbs-server', 'archive'), path.join(fx3.main, 'wbs-server', 'uploads', 'lk'));
    const lk = await newLine(fx3, 'lk', 'm-lk');
    check('10.9 运行期目录里有链接：失败于 copy_runtime，消息报链接路径', lk.err && lk.err.step === 'copy_runtime' && /链接/.test(lk.err.message) && lk.err.message.includes(path.join(fx3.main, 'wbs-server', 'uploads', 'lk')), lk.err && lk.err.message);
    const lkr = await removeLine(fx3, 'lk', { discard: true });
    check('10.9b 随后 remove --discard 清理成功，主工作区的 archive 与联接目标完好', lkr.err === null && rd(path.join(fx3.main, 'wbs-server', 'archive', 'a.txt')) === 'RT-ARCHIVE-OK' && C.scanTree(fs.realpathSync.native(path.join(fx3.main, 'wbs-server', 'uploads')), []).unexpectedLinks.length === 1, lkr.err && lkr.err.message);

    // 10.10 登记路径篡改；10.11 npm ls
    const fx4 = await buildFixture('s10tamper');
    const t1 = await newLine(fx4, 't1', 'm-t');
    check('10.10.0 t1 建成', t1.err === null, t1.err && t1.err.message);
    if (!t1.err) {
        const victim = path.join(fx4.root, '受害 目录');
        w(path.join(victim, 'keep.txt'), 'KEEP');
        await S.updateLine(fx4.control, 't1', (r) => { r.worktree = victim; });
        const tr = await removeLine(fx4, 't1', { discard: true });
        check('10.10 登记里的 worktree 路径与线目录根推导不一致：拒绝，不动那个目录', tr.err && tr.err.code === 'LINE_REMOVE_REFUSED' && /不一致/.test(tr.err.message) && rd(path.join(victim, 'keep.txt')) === 'KEEP', tr.err && tr.err.message);
        await S.updateLine(fx4.control, 't1', (r) => { r.worktree = wtOf(fx4, 't1'); });
        const calls = [];
        const outN = [];
        harvestJwts();
        const nr = (await recordGit(() => attempt(() => R.lineRemove(ctxOf(fx4, outN, { runNpmLs: (cwd) => { calls.push(cwd); return { status: calls.length === 2 ? 1 : 0, tail: 'npm ERR! 假的' }; } }), { name: 't1' })), true)).res;
        check('10.11 npm ls：在主工作区根与 wbs-server 各跑一次；退出码非 0 只告警不阻断删线', nr.err === null && calls.length === 2 && C.samePath(calls[0], fx4.main) && C.samePath(calls[1], path.join(fx4.main, 'wbs-server')) && hasLine(outN, '【警告】npm ls --depth=0') && nr.res.warnings.length === 1, nr.err && nr.err.message);
    }
    const emptyPkg = path.join(dir, 'npmls 空依赖');
    w(path.join(emptyPkg, 'package.json'), '{"name":"x","version":"1.0.0"}\n');
    fs.mkdirSync(path.join(emptyPkg, 'node_modules'), { recursive: true });
    const real = R.runNpmLsReal(emptyPkg);
    check('10.12 真实 npm ls --depth=0（node 直接跑 npm-cli.js）在无依赖的临时项目上退出码 0', real.skipped === false && real.status === 0, real);

    // 10.13 node_modules 核对 + 删除后失败的重试
    const fx5 = await buildFixture('s10nm');
    const n1 = await newLine(fx5, 'n1', 'm-n');
    check('10.13.0 n1 建成', n1.err === null, n1.err && n1.err.message);
    if (!n1.err) {
        await S.updateLine(fx5.control, 'n1', (r) => { r.yield_request = { by: 'hotfix', at: '2026-03-01T00:00:00.000Z' }; });
        const sentinel = path.join(fx5.main, 'node_modules', 'sentinel.txt');
        const nr2 = await removeLine(fx5, 'n1', {}, { testHooks: { afterWorktreeRemove: () => fs.unlinkSync(sentinel) } });
        const stN = await regOf(fx5);
        check('10.13 主 node_modules 顶层条目丢失：失败于 main_node_modules_check，登记 failed，槽位不释放', nr2.err && nr2.err.step === 'main_node_modules_check' && /丢失 1/.test(nr2.err.message) && stN.lines.n1.lifecycle === 'failed' && stN.lines.n1.failed_step === 'main_node_modules_check', nr2.err && nr2.err.message);
        check('10.13b 此时 worktree 已删、分支已删（失败发生在删除之后）', !fs.existsSync(wtOf(fx5, 'n1')) && !branchExists(fx5, 'line/n1'));
        w(sentinel, 'NM-ROOT-SENTINEL');   // 恢复哨兵
        const nr3 = await removeLine(fx5, 'n1');
        const stN2 = await regOf(fx5);
        check('10.13c 恢复哨兵后重试成功：记录进 history（yield_request 已清空）、槽位释放、归属记录已删', nr3.err === null && !stN2.lines.n1 && stN2.history.length === 1 && stN2.history[0].lifecycle === 'removed' && stN2.history[0].yield_request === null && !fs.existsSync(ownerFileOf(fx5, stN.lines.n1.generation)), nr3.err && nr3.err.message);
        const n1b = await newLine(fx5, 'n1b', 'm-nb');
        check('10.13d 槽位可复用：新线拿到槽位 1', n1b.err === null && (await regOf(fx5)).lines.n1b.slot === 1, n1b.err && n1b.err.message);
        // 10.13e 故障注入：只删深层文件 / 只改文件内容（顶层名称不变）→ 测试侧深度摘要必须判不一致（证明检测器本身有判别力）
        const base = digestsOf(fx5.main);
        const deepFile = path.join(fx5.main, 'node_modules', 'pkgA', 'lib', 'deep', 'inner.js');
        fs.unlinkSync(deepFile);
        const afterDeepDelete = digestsOf(fx5.main);
        w(deepFile, 'NM-ROOT-DEEP');
        const restoredOk = same(digestsOf(fx5.main), base);
        fs.writeFileSync(path.join(fx5.main, 'node_modules', 'pkgA', 'index.js'), 'NM-ROOT-PKGA-TAMPERED');
        const afterTamper = digestsOf(fx5.main);
        fs.writeFileSync(path.join(fx5.main, 'node_modules', 'pkgA', 'index.js'), 'NM-ROOT-PKGA');
        check('10.13e 深度摘要判别力：只删深层文件 → 判不一致；只改文件内容（名称与大小可变）→ 判不一致；恢复后全等', !same(afterDeepDelete, base) && !same(afterTamper, base) && restoredOk && same(digestsOf(fx5.main), base));
        check('10.13f 顶层名称清单在「只删深层文件」时不变（说明旧口径判不出，必须靠深度摘要）', (() => { fs.unlinkSync(deepFile); const top = C.listTop(path.join(fx5.main, 'node_modules')).join(); w(deepFile, 'NM-ROOT-DEEP'); return top === ['.bin', 'pkgA', 'sentinel.txt'].join(); })());
    }

    // 10.14 creating 拒绝
    const fx6 = await buildFixture('s10creating', { noDb: true });
    await S.createLine(fx6.control, 'cr', { module: 'm', branch: 'line/cr', worktree: wtOf(fx6, 'cr'), surface: 's', deps_mode: 'shared' });
    const cr = await removeLine(fx6, 'cr', { discard: true });
    check('10.14 lifecycle=creating 的线：remove 拒绝（不动任何东西）', cr.err && cr.err.code === 'LINE_REMOVE_REFUSED' && /creating/.test(cr.err.message) && (await regOf(fx6)).lines.cr.lifecycle === 'creating');

    // 10.15 参数校验
    const bads = [{ name: 'x', module: '', surface: 's' }, { name: 'x', module: 'a/b', surface: 's' }, { name: 'x', module: '..', surface: 's' }, { name: 'x', module: '.hid', surface: 's' }, { name: 'x', module: 'm', surface: '  ' }, { name: 'x', module: 'a'.repeat(65), surface: 's' }, { name: 'x', module: 'a:b', surface: 's' }];
    check('10.15 line new 的模块名 / 预计改动面校验（空 / 路径分隔符 / .. / 以 . 开头 / 过长 / 冒号）', bads.every((b) => { try { N.validateArgs(b); return false; } catch (e) { return e.code === 'LINE_BAD_ARGS'; } }));

    // 10.16 SOURCE_HOT_JOURNAL 提示原样转给用户
    const fxh = await buildFixture('s10hot');
    const origCreate = instanceDb.createIsolatedDb;
    const HOT_MSG = 'createIsolatedDb：来源库有未回滚的 journal（上次异常退出），请先用读写连接打开来源库、执行一次读取（如 SELECT count(*) FROM sqlite_master）后关闭，再重试（只开关连接不保证触发热日志恢复；原错误：SQLITE_READONLY）';
    instanceDb.createIsolatedDb = async () => { const e = new Error(HOT_MSG); e.code = 'SOURCE_HOT_JOURNAL'; throw e; };
    let hot;
    try { hot = await newLine(fxh, 'hot', 'm-hot'); } finally { instanceDb.createIsolatedDb = origCreate; }
    check('10.16 SOURCE_HOT_JOURNAL：失败于 create_db，createIsolatedDb 的提示原文转给用户', hot.err && hot.err.step === 'create_db' && hot.err.message.includes(HOT_MSG), hot.err && hot.err.message);

    // 10.17 脱敏不把通用词当机密
    const fxp = await buildFixture('s10production');
    const pr = await newLine(fxp, 'pr', 'm-pr');
    check('10.17 输出脱敏不改花路径里的 production（NODE_ENV 值不当机密），同时机密值照常不出现', pr.err === null && hasLine(pr.out, wtOf(fxp, 'pr')) && !pr.out.join('\n').includes('[已脱敏]'), pr.err && pr.err.message);

    // 10.18 脱敏出口：建库替身 / 删线钩子抛出含秘密的错误 → 输出里出现 [已脱敏] 而不是原值（new / remove / 入口 catch / 同模块闸门）
    const fxl = await buildFixture('s10leak');
    const SECRET_ERR = `boom key=${FAKE_KEY} jwt=${JWT} other=${UNRELATED} sdh=${EVIL_MAIN} hook=${WEBHOOK}`;
    instanceDb.createIsolatedDb = async () => { throw new Error(SECRET_ERR); };
    let lk1;
    try { lk1 = await newLine(fxl, 'lk1', 'm-lk1'); } finally { instanceDb.createIsolatedDb = origCreate; }
    const msg1 = lk1.err ? lk1.err.message : '';
    check('10.18 建库替身抛出含来源键 / 主 JWT / 其他长值的错误：line new 的错误里出现 [已脱敏]，原值一个都不出现', lk1.err && msg1.includes('[已脱敏]') && [FAKE_KEY, JWT, UNRELATED, EVIL_MAIN, WEBHOOK].every((s) => !msg1.includes(s)) && msg1.includes('boom'), msg1);
    const rmLeak = await removeLine(fxl, 'lk1', { discard: true }, { testHooks: { afterWorktreeRemove: () => { throw new Error(SECRET_ERR); } } });
    const msg2 = rmLeak.err ? rmLeak.err.message : '';
    check('10.18b 删线钩子抛出含秘密的错误：line remove 的错误里出现 [已脱敏]，原值不出现', rmLeak.err && msg2.includes('[已脱敏]') && [FAKE_KEY, JWT, UNRELATED, EVIL_MAIN, WEBHOOK].every((s) => !msg2.includes(s)), msg2);
    await removeLine(fxl, 'lk1', { discard: true });
    // 同模块闸门的错误（含 surface）也经脱敏：surface 里写进主 .env 的值
    const g1 = await newLine(fxl, 'g1', 'm-g', { surface: `改动面含 ${UNRELATED} 与 ${WEBHOOK}` });
    check('10.18c 前置：g1 建成', g1.err === null, g1.err && g1.err.message);
    const g2 = await newLine(fxl, 'g2', 'm-g');
    const msg3 = g2.err ? g2.err.message : '';
    check('10.18d 同模块闸门的拒绝消息里对方的改动面经脱敏：出现 [已脱敏]，原值不出现', g2.err && g2.err.code === 'LINE_MODULE_OVERLAP' && msg3.includes('[已脱敏]') && !msg3.includes(UNRELATED) && !msg3.includes(WEBHOOK), msg3);
    // 入口 catch：进程内跑 L.run（console 被捕获），建库替身抛秘密
    const errs = [];
    const origConsoleErr = console.error;
    const origConsoleLog = console.log;
    console.error = (...a) => { errs.push(a.join(' ')); ALL_OUT.push(a.join(' ')); };
    console.log = (...a) => { ALL_OUT.push(a.join(' ')); };
    instanceDb.createIsolatedDb = async () => { throw new Error(SECRET_ERR); };
    let codeL;
    try {
        codeL = await L.run(['new', 'ent', '--module', 'm-ent', '--surface', 's', '--control-root', fxl.control + '-e', '--lines-root', fxl.lines, '--main-root', fxl.main], SELF_CHECKOUT_ROOT);   // scriptRoot 不能是夹具主仓库本身（--main-root 等于脚本所在主仓库会被拒）
    } finally { instanceDb.createIsolatedDb = origCreate; console.error = origConsoleErr; console.log = origConsoleLog; }
    const entryText = errs.join('\n');
    check('10.18e 入口 catch 经同一脱敏出口：stderr 里出现 [已脱敏]，原值不出现', codeL === 1 && entryText.includes('[已脱敏]') && [FAKE_KEY, JWT, UNRELATED, EVIL_MAIN, WEBHOOK].every((s) => !entryText.includes(s)), { codeL, entryText });

    // 10.19 删除后失败的重试：分支删除失败一次、最终登记失败一次
    const fxr = await buildFixture('s10retry');
    const r1 = await newLine(fxr, 'r1', 'm-r1');
    check('10.19.0 r1 建成', r1.err === null, r1.err && r1.err.message);
    if (!r1.err) {
        const f1 = await removeLine(fxr, 'r1', {}, { testHooks: { beforeBranchDelete: () => { throw new Error('注入：分支删除失败'); } } });
        check('10.19 注入分支删除失败：失败于 branch_delete，登记 failed；worktree 已删，分支还在', f1.err && f1.err.step === 'branch_delete' && (await regOf(fxr)).lines.r1.failed_step === 'branch_delete' && !fs.existsSync(wtOf(fxr, 'r1')) && branchExists(fxr, 'line/r1'), f1.err && f1.err.message);
        const f2 = await removeLine(fxr, 'r1', {}, { testHooks: { beforeFinalize: () => { throw new Error('注入：最终登记失败'); } } });
        check('10.19b 重试时再注入最终登记失败：失败于 finalize，分支此时已删', f2.err && f2.err.step === 'finalize' && (await regOf(fxr)).lines.r1.failed_step === 'finalize' && !branchExists(fxr, 'line/r1'), f2.err && f2.err.message);
        const f3 = await removeLine(fxr, 'r1');
        const st19 = await regOf(fxr);
        check('10.19c 再重试成功：记录进 history、槽位释放（lines 为空）', f3.err === null && Object.keys(st19.lines).length === 0 && st19.history.length === 1, f3.err && f3.err.message);
    }

    // 10.20 两个并发 remove（双进程，确定性交错）：第一个进程持线级锁并停在钩子里（确认已持锁后才放第二个进程），
    //   第二个进程确认进入了调用，但在第一个释放锁之前不能完成；放行后恰好一个成功，另一个得到 LINE_NO_SUCH_LINE（等锁超时设得远大于持锁时间，所以不会是 STATE_LINE_BUSY）
    const fxc = await buildFixture('s10conc');
    const c1 = await newLine(fxc, 'cc', 'm-cc');
    check('10.20.0 cc 建成', c1.err === null, c1.err && c1.err.message);
    if (!c1.err) {
        harvestJwts();
        const lockedFile = path.join(fxc.root, 'A.locked');
        const releaseFile = path.join(fxc.root, 'A.release');
        const mk = (i, hold) => ({
            cmd: 'remove', mainRoot: fxc.main, controlRoot: fxc.control, linesRoot: fxc.lines, goFile: path.join(fxc.root, `go${i}.flag`), readyFile: path.join(fxc.root, `rm${i}.ready`), startedFile: path.join(fxc.root, `rm${i}.started`),
            outFile: path.join(fxc.root, `rm${i}.out.json`), lockedFile, releaseFile, hold, lockTimeoutMs: 120000, args: { name: 'cc', discard: true },
        });
        const specA = mk(1, 'beforeRemoving');
        const specB = mk(2, null);
        const pA = runWorker(specA, 240000);
        const pB = runWorker(specB, 240000);
        const bothReady = await waitFor(() => fs.existsSync(specA.readyFile) && fs.existsSync(specB.readyFile), 90000);
        check('10.20a 两个工作进程都已就绪', bothReady);
        fs.writeFileSync(specA.goFile, 'go');
        const aLocked = await waitFor(() => fs.existsSync(lockedFile), 90000);
        check('10.20b 第一个进程已持线级锁并停在钩子里（此时才放第二个）', aLocked);
        fs.writeFileSync(specB.goFile, 'go');
        const bStarted = await waitFor(() => fs.existsSync(specB.startedFile), 90000);
        await new Promise((resolve) => setTimeout(resolve, 2500));   // 负向证据只能靠观察窗口：第二个进程已进入调用 2.5 秒，仍不能有结果
        check('10.20c 第二个进程已进入调用，但在第一个释放线级锁之前不能完成（2.5 秒后没有结果文件）', bStarted && !fs.existsSync(specB.outFile), { bStarted });
        fs.writeFileSync(releaseFile, 'go');
        const rr = await Promise.all([pA, pB]);
        const outs = [specA, specB].map((s) => { try { return JSON.parse(rd(s.outFile)); } catch (_) { return null; } });
        for (const o of outs) if (o) ALL_OUT.push(JSON.stringify(o));
        const stc = await regOf(fxc);
        check('10.20 并发 remove：两个工作进程都正常结束；持锁的第一个成功，第二个在释放后得到 LINE_NO_SUCH_LINE（不是等锁超时）', rr.every((x) => x.code === 0) && outs[0] && outs[0].ok === true && outs[1] && outs[1].ok === false && outs[1].code === 'LINE_NO_SUCH_LINE', outs);
        check('10.20d 登记只有一条 history，worktree 与分支都不在，主工作区完好', Object.keys(stc.lines).length === 0 && stc.history.length === 1 && !fs.existsSync(wtOf(fxc, 'cc')) && !branchExists(fxc, 'line/cc') && mainIntact(fxc), stc);
    }

    // 10.21 删后同名重建 + 旧操作 → 代次不符拒绝
    const fxg = await buildFixture('s10gen');
    const gg = await newLine(fxg, 'gg', 'm-gg');
    check('10.21.0 gg 建成', gg.err === null, gg.err && gg.err.message);
    if (!gg.err) {
        const oldGen = gg.res.generation;
        let newGen = null;
        const gr = await removeLine(fxg, 'gg', {}, { testHooks: { beforeRemoving: async () => {
            // 模拟「绕过线级锁的状态层操作」：旧操作读完登记之后，线被删除并同名重建
            await S.updateLine(fxg.control, 'gg', (r) => { r.lifecycle = 'removing'; });
            await S.removeLineRecord(fxg.control, 'gg');
            const nr = await S.createLine(fxg.control, 'gg', { module: 'm-gg2', branch: 'line/gg', worktree: wtOf(fxg, 'gg'), surface: 'new-gen', deps_mode: 'shared' });
            newGen = nr.generation;
        } } });
        const stg = await regOf(fxg);
        check('10.21 旧操作遇到同名重建的新线：代次不符拒绝（LINE_GENERATION_MISMATCH），新线记录原样（creating、新代次）', gr.err && gr.err.code === 'LINE_GENERATION_MISMATCH' && stg.lines.gg.generation === newGen && newGen !== oldGen && stg.lines.gg.lifecycle === 'creating' && stg.lines.gg.surface === 'new-gen', gr.err && gr.err.message);
        check('10.21b 旧操作没有动文件：worktree 与联接都还在', fs.existsSync(wtOf(fxg, 'gg')) && NM_RELS.every((rel) => isLink(path.join(wtOf(fxg, 'gg'), rel))));
        const direct = await attempt(() => S.updateLine(fxg.control, 'gg', (r) => { r.surface = 'tamper'; }, { expectGeneration: oldGen }));
        check('10.21c 状态层：带旧代次的 updateLine / removeLineRecord 都报 STATE_GENERATION_MISMATCH，登记不变', direct.err && direct.err.code === 'STATE_GENERATION_MISMATCH' && (await attempt(() => S.removeLineRecord(fxg.control, 'gg', { expectGeneration: oldGen }))).err.code === 'STATE_GENERATION_MISMATCH' && same(await regOf(fxg), stg));
    }

    // 10.22 归属：管理目录里的标记缺失 / 归属记录缺失 → 不删 worktree 与分支，只清登记
    const fxo = await buildFixture('s10owner');
    const o1 = await newLine(fxo, 'o1', 'm-o1');
    check('10.22.0 o1 建成', o1.err === null, o1.err && o1.err.message);
    if (!o1.err) {
        fs.unlinkSync(path.join(JSON.parse(rd(ownerFileOf(fxo, o1.res.generation))).admin_dir, 'sdh-line-owner.json'));
        const ol = [];
        const o1r = await removeLine(fxo, 'o1', { discard: true }, {}, ol);
        check('10.22 管理目录里的归属标记缺失：证明不了归属 → 只清登记，worktree（含联接）与分支原样，有提示', o1r.err === null && fs.existsSync(wtOf(fxo, 'o1')) && NM_RELS.every((rel) => isLink(path.join(wtOf(fxo, 'o1'), rel))) && branchExists(fxo, 'line/o1') && hasLine(ol, '证明不了是本工具') && Object.keys((await regOf(fxo)).lines).length === 0, o1r.err && o1r.err.message);
        const o2 = await newLine(fxo, 'o2', 'm-o2');
        check('10.22b o2 建成', o2.err === null, o2.err && o2.err.message);
        if (!o2.err) {
            fs.unlinkSync(ownerFileOf(fxo, o2.res.generation));
            const o2r = await removeLine(fxo, 'o2', { discard: true });
            check('10.22c 控制根的归属记录缺失：同样只清登记，worktree 与分支原样', o2r.err === null && fs.existsSync(wtOf(fxo, 'o2')) && branchExists(fxo, 'line/o2'), o2r.err && o2r.err.message);
            check('10.22d 以上两种情形都没碰主工作区', mainIntact(fxo));
        }
    }

    // 10.23 归属凭据写失败：**不回滚**（修复批 2 第 1.4 条）。三种注入——第一份（控制根归属记录）写失败、第二份（管理目录标记）写失败、管理目录核实失败。
    //   约定：不删任何东西；lifecycle=failed、failed_step=owner_record；消息写明 worktree / 分支 / 管理目录位置与只读现场清单（U14 = A：不生成命令）；之后 line remove 因归属无法证明只清登记、资源保留。
    for (const [tag, patch] of [
        ['A', () => { const o = C.writeOwnerRecord; C.writeOwnerRecord = () => { throw new Error('注入：控制根归属记录写入失败'); }; return () => { C.writeOwnerRecord = o; }; }],
        ['B', () => { const o = C.writeAdminMarker; C.writeAdminMarker = () => { throw new Error('注入：管理目录标记写入失败'); }; return () => { C.writeAdminMarker = o; }; }],
        ['C', () => { const o = C.findWorktreeAdmin; C.findWorktreeAdmin = () => { throw new Error('注入：管理目录核实失败'); }; return () => { C.findWorktreeAdmin = o; }; }],
    ]) {
        const fxm = await buildFixture(`s10marker${tag}`);
        const restore = patch();
        let mk1;
        try { mk1 = await newLine(fxm, 'mk', 'm-mk'); } finally { restore(); }
        const wtm = wtOf(fxm, 'mk');
        const stm = await regOf(fxm);
        const adminDirs = fs.existsSync(path.join(fxm.main, '.git', 'worktrees')) ? fs.readdirSync(path.join(fxm.main, '.git', 'worktrees')) : [];
        check(`10.23${tag} 凭据写失败（注入 ${tag}）：失败于 owner_record；worktree、分支、管理目录都还在（不回滚）；还没建联接 / 身份文件 / 线库`, mk1.err && mk1.err.code === 'LINE_NEW_FAILED' && mk1.err.step === 'owner_record' && fs.existsSync(path.join(wtm, '.git')) && branchExists(fxm, 'line/mk') && adminDirs.length === 1
            && NM_RELS.every((rel) => !fs.existsSync(path.join(wtm, rel)) || !isLink(path.join(wtm, rel))) && !fs.existsSync(path.join(wtm, 'wbs-server', '.sdh-instance')) && !fs.existsSync(path.join(wtm, 'wbs-server', 'task_pool.db')), mk1.err && mk1.err.message);
        // U14 = A：消息只是只读现场清单——位置三行、保留 / 不回滚 / 只清登记、联接清单（这里为零）、两条不含路径的 reflog 只读命令、reflog 文件位置、指向 CLAUDE.md 小节，不生成任何清理命令
        const mkMsg = mk1.err ? mk1.err.message : '';
        const shp = siteListShape(mkMsg, wtm, 'line/mk', fxm);
        check(`10.23${tag}b 消息写明 worktree / 分支 / 管理目录位置，并说明原样保留、不回滚、line remove 只会清登记；有「现场清单（只读…）」标题`, !!mk1.err && shp.loc && shp.keep && shp.header, mkMsg);
        const adminIdM = adminDirs.length === 1 ? adminDirs[0] : null;
        const adminRealM = adminIdM ? fs.realpathSync.native(path.join(fxm.main, '.git', 'worktrees', adminIdM)) : null;
        const adminLogLine = adminRealM ? path.join(adminRealM, 'logs', 'HEAD') : null;
        const branchLogFile = path.join(fxm.main, '.git', 'logs', 'refs', 'heads', 'line', 'mk');
        const mkLinesT = msgLinesOf(mkMsg);
        check(`10.23${tag}e 现场清单（联接为零）：说明「没有发现联接」；两条 reflog 只读命令逐字存在（${reflogBranchCmd('line/mk')} / ${REFLOG_HEAD_CMD}）且是仅有的命令行；列出线分支 reflog 文件路径，${tag === 'C' ? '管理目录未核实 → 写「（未能核实）」且不列管理目录 reflog' : '列出管理目录 logs/HEAD 路径'}；指向 CLAUDE.md 小节名；剥离已知路径与两条 reflog 命令行后：禁用片段表 ${MUTATING_PATTERNS.length} 条无一命中、无 git <子命令>、无白名单外 ASCII 词（只判 ASCII 命令形态）；最后一行是说明句`,
            !!mk1.err && /worktree 里没有发现联接/.test(mkMsg) && linkListingOf(mkMsg).length === 0 && shp.reflogCmds && shp.onlyReflogCmds && shp.onsite && shp.clean && shp.note
            && mkLinesT.includes(branchLogFile) && fs.existsSync(branchLogFile)
            && (tag === 'C' ? /git 管理目录：（未能核实）/.test(mkMsg) && !mkLinesT.some((l) => /[\\/]logs[\\/]HEAD$/.test(l)) : (adminLogLine !== null && mkLinesT.includes(adminLogLine) && fs.existsSync(adminLogLine))),
            { shp, cmdish: cmdishLinesOf(mkMsg), mkLines: mkLinesT.join(' | ') });
        check(`10.23${tag}c 登记 failed / owner_record，槽位仍占用`, stm.lines.mk && stm.lines.mk.lifecycle === 'failed' && stm.lines.mk.failed_step === 'owner_record' && stm.lines.mk.slot === 1, stm.lines.mk);
        const mkl = [];
        const mk2 = await removeLine(fxm, 'mk', {}, {}, mkl);
        check(`10.23${tag}d 之后 line remove：归属无法证明，只清登记（槽位释放），worktree、分支、管理目录原样保留并有提示；主工作区完好`, mk2.err === null && Object.keys((await regOf(fxm)).lines).length === 0 && fs.existsSync(path.join(wtm, '.git')) && branchExists(fxm, 'line/mk')
            && fs.readdirSync(path.join(fxm.main, '.git', 'worktrees')).length === 1 && hasLine(mkl, '证明不了是本工具') && mainIntact(fxm), mk2.err && mk2.err.message);
    }
    // 10.24 线级锁互斥 new 与 remove：remove 持锁期间，对同名线的 new 必须排队等待（不是立刻 STATE_LINE_EXISTS）；remove 完成后 new 成功且是新代次
    const fxq = await buildFixture('s10queue');
    const q1 = await newLine(fxq, 'qq', 'm-q1');
    check('10.24.0 qq 建成', q1.err === null, q1.err && q1.err.message);
    if (!q1.err) {
        let entered;
        const enteredP = new Promise((resolve) => { entered = resolve; });
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        const pRemove = removeLine(fxq, 'qq', {}, { testHooks: { beforeRemoving: async () => { entered(); await gate; } } });
        await enteredP;
        let newSettled = false;
        const pNew = newLine(fxq, 'qq', 'm-q2').then((x) => { newSettled = true; return x; });
        await new Promise((resolve) => setTimeout(resolve, 2500));
        check('10.24 remove 持线级锁期间，同名 new 在排队等待（2.5 秒后仍未结束）', newSettled === false);
        release();
        const rq = await pRemove;
        const nq = await pNew;
        const stq = await regOf(fxq);
        check('10.24b remove 完成后排队的 new 成功，且是新代次、新模块；旧记录在 history', rq.err === null && nq.err === null && stq.lines.qq.module === 'm-q2' && stq.lines.qq.generation !== q1.res.generation && stq.history.length === 1 && stq.history[0].generation === q1.res.generation, { r: rq.err && rq.err.message, n: nq.err && nq.err.message });
    }
}

// ---------------------------------------------------------------- 节 11：修复批 2 新防线

/** 记录 fn 执行期间被测代码发出的全部 git 命令（经 child_process 包装，见文件头；可嵌套）。asRemoval：同时计入 REMOVAL_GIT。返回 { res, calls }（calls = 本次调用期间新记录的）。 */
async function recordGit(fn, asRemoval) {
    const start = GIT_REC.calls.length;
    GIT_REC.depth += 1;
    if (asRemoval) GIT_REC.removal += 1;
    let res;
    try { res = await fn(); } finally { GIT_REC.depth -= 1; if (asRemoval) GIT_REC.removal -= 1; }
    return { res, calls: GIT_REC.calls.slice(start) };
}
/** 记录里出现过的 `git worktree remove|prune`（token 数组拼回整串后匹配：含 --git-dir 等前置参数、shell 字符串形式）。 */
const worktreeRemovalCalls = (calls) => calls.filter((a) => /\bworktree\s+(remove|prune)\b/.test(a.join(' ')));
const adminDirOf = (fx, gen) => JSON.parse(rd(ownerFileOf(fx, gen))).admin_dir;
const rewriteJson = (file, patch) => { const o = JSON.parse(rd(file)); patch(o); fs.writeFileSync(file, `${JSON.stringify(o)}\n`); };
/** 建线并检查成功；返回 { gen, wt, admin, res }。 */
async function mkLine(fx, name, extra) {
    const r = await newLine(fx, name, `m-${name}`, extra || {});
    check(`11.0 ${name} 建成`, r.err === null, r.err && r.err.message);
    if (r.err) return null;
    return { gen: r.res.generation, wt: wtOf(fx, name), admin: adminDirOf(fx, r.res.generation), res: r.res };
}
/** 用原始状态函数把一条处于 removing 的线删掉并同名重建（新代次），再推到 removing：模拟「绕过线级锁的状态层操作」。返回新代次。 */
async function recreateAsRemoving(fx, name) {
    await S.removeLineRecord(fx.control, name);
    const nr = await S.createLine(fx.control, name, { module: 'm-new-gen', branch: `line/${name}`, worktree: wtOf(fx, name), surface: 'new-gen', deps_mode: 'shared' });
    await S.updateLine(fx.control, name, (r) => { r.lifecycle = 'failed'; r.failed_step = 'injected'; });
    await S.updateLine(fx.control, name, (r) => { r.lifecycle = 'removing'; r.failed_step = null; });
    return nr.generation;
}
/** 递归复制（测试夹具用，不跟随链接）。 */
function copyDirPlain(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const n of fs.readdirSync(src)) {
        const f = path.join(src, n);
        const st = fs.lstatSync(f);
        if (st.isDirectory()) copyDirPlain(f, path.join(dst, n)); else fs.copyFileSync(f, path.join(dst, n));
    }
}

async function sec11() {
    section('11', '修复批 2 新防线');

    // ---- 11.1 删线全程不调用 git worktree remove / prune（包一层 child_process 记录被测代码发出的全部 git 命令）----
    const fx1 = await buildFixture('s11nogit');
    const a1 = await mkLine(fx1, 'g1');
    if (a1) {
        commitIn(fx1, 'g1', 'feature-g1.txt', 'g1');
        git(fx1.main, ['merge', '-q', '--no-ff', '-m', 'merge g1', 'line/g1']);
        const rec1 = await recordGit(() => removeLine(fx1, 'g1'));
        check('11.1 已合入的正常删线成功', rec1.res.err === null, rec1.res.err && rec1.res.err.message);
        check('11.1a 记录器确实录到了被测代码的 git 调用（含 update-ref / status / rev-list），不是空记录', rec1.calls.length > 5 && rec1.calls.some((a) => a.includes('update-ref')) && rec1.calls.some((a) => a.includes('status')) && rec1.calls.some((a) => a.includes('rev-list')), rec1.calls.length);
        check('11.1b 删线全程没有调用 `git worktree remove` / `git worktree prune`', worktreeRemovalCalls(rec1.calls).length === 0, worktreeRemovalCalls(rec1.calls));
        check('11.1c 删后：worktree 目录、管理目录、分支都不在，git worktree list 只剩主工作区，主工作区完好', !fs.existsSync(a1.wt) && !fs.existsSync(a1.admin) && !branchExists(fx1, 'line/g1')
            && git(fx1.main, ['worktree', 'list', '--porcelain', '-z']).split('\0').filter((x) => x.startsWith('worktree ')).length === 1 && mainIntact(fx1));
    }
    // 失败线 --discard 清理路径同样不调用
    fs.unlinkSync(fx1.mainDb);
    const f1 = await newLine(fx1, 'g2', 'm-g2');
    check('11.1d g2 失败于 create_db（前置）', f1.err && f1.err.step === 'create_db', f1.err && f1.err.message);
    const rec2 = await recordGit(() => removeLine(fx1, 'g2', { discard: true }));
    check('11.1e --discard 清理失败线成功，且同样没有调用 git worktree remove / prune', rec2.res.err === null && worktreeRemovalCalls(rec2.calls).length === 0 && !fs.existsSync(wtOf(fx1, 'g2')), rec2.res.err && rec2.res.err.message);
    // 11.1f-h：记录范围覆盖所有实际删线场景——目录缺失分支（只剩管理目录）、CLI 子进程、工作进程（后两者的记录来自子进程里的同一份记录器，汇总回父进程）
    const fx1b = await buildFixture('s11nogit2');
    const roots1b = ['--control-root', fx1b.control, '--lines-root', fx1b.lines, '--main-root', fx1b.main];
    const m1 = await mkLine(fx1b, 'g3');
    if (m1) {
        check('11.1f.0 前置：人手删掉 worktree 目录（管理目录还在）', removeTree(m1.wt).length === 0 && !fs.existsSync(m1.wt) && fs.existsSync(m1.admin));
        const rec3 = await recordGit(() => removeLine(fx1b, 'g3'));
        check('11.1f 目录缺失分支（只剩管理目录）的删线成功，记录器录到了 git 调用，且没有调用 git worktree remove / prune', rec3.res.err === null && rec3.calls.length > 3 && worktreeRemovalCalls(rec3.calls).length === 0 && !fs.existsSync(m1.admin), { err: rec3.res.err && rec3.res.err.message, n: rec3.calls.length, bad: worktreeRemovalCalls(rec3.calls) });
    }
    const m2 = await mkLine(fx1b, 'g4');
    if (m2) {
        const crm = runCli(['remove', 'g4', ...roots1b]);
        check('11.1g CLI 子进程删线成功；子进程里的记录器录到了 git 调用（汇总回父进程），且没有调用 git worktree remove / prune', crm.status === 0 && crm.gitRecs.length > 3 && worktreeRemovalCalls(crm.gitRecs).length === 0 && !fs.existsSync(m2.wt), { s: crm.status, n: crm.gitRecs.length, bad: worktreeRemovalCalls(crm.gitRecs), e: crm.stderr });
    }
    const m3 = await mkLine(fx1b, 'g5');
    if (m3) {
        harvestJwts();
        const goW = path.join(fx1b.root, 'g5.go');
        fs.writeFileSync(goW, 'go');
        const wr = await runWorker({ cmd: 'remove', mainRoot: fx1b.main, controlRoot: fx1b.control, linesRoot: fx1b.lines, goFile: goW, outFile: path.join(fx1b.root, 'g5.out.json'), args: { name: 'g5' } }, 240000);
        let wout = null;
        try { wout = JSON.parse(rd(path.join(fx1b.root, 'g5.out.json'))); } catch (_) { wout = null; }
        if (wout) ALL_OUT.push(JSON.stringify(wout));
        check('11.1h 工作进程删线成功；工作进程里的记录器录到了 git 调用（汇总回父进程），且没有调用 git worktree remove / prune', wr.code === 0 && wout && wout.ok === true && wr.gitRecs.length > 3 && worktreeRemovalCalls(wr.gitRecs).length === 0 && !fs.existsSync(m3.wt), { c: wr.code, o: wout, n: wr.gitRecs.length, bad: worktreeRemovalCalls(wr.gitRecs) });
    }

    // ---- 11.2 归属凭据不匹配：分别篡改两份凭据的线名 / 代次 / worktree / 分支（以及管理目录 id / 路径、gitdir 指向、worktree 的 .git 指回）→ 资源原样保留，只清登记 ----
    const fx2 = await buildFixture('s11tamper');
    const randUuid = crypto.randomUUID();
    const TAMPERS = [
        ['owner.name', (c) => rewriteJson(ownerFileOf(fx2, c.gen), (o) => { o.name = 'someone-else'; })],
        ['owner.generation', (c) => rewriteJson(ownerFileOf(fx2, c.gen), (o) => { o.generation = randUuid; })],
        ['owner.worktree', (c) => rewriteJson(ownerFileOf(fx2, c.gen), (o) => { o.worktree = path.join(fx2.root, '别处 worktree'); })],
        ['owner.branch', (c) => rewriteJson(ownerFileOf(fx2, c.gen), (o) => { o.branch = 'line/another'; })],
        ['owner.admin_id', (c) => rewriteJson(ownerFileOf(fx2, c.gen), (o) => { o.admin_id = 'no-such-admin'; })],
        ['owner.admin_dir', (c) => rewriteJson(ownerFileOf(fx2, c.gen), (o) => { o.admin_dir = path.join(fx2.root, '别处 管理目录'); })],
        ['marker.name', (c) => rewriteJson(path.join(c.admin, 'sdh-line-owner.json'), (o) => { o.name = 'someone-else'; })],
        ['marker.generation', (c) => rewriteJson(path.join(c.admin, 'sdh-line-owner.json'), (o) => { o.generation = randUuid; })],
        ['marker.branch', (c) => rewriteJson(path.join(c.admin, 'sdh-line-owner.json'), (o) => { o.branch = 'line/another'; })],
        ['marker.worktree', (c) => rewriteJson(path.join(c.admin, 'sdh-line-owner.json'), (o) => { o.worktree = path.join(fx2.root, '别处 worktree'); })],
        ['admin.gitdir 指向别处', (c) => fs.writeFileSync(path.join(c.admin, 'gitdir'), `${path.join(fx2.root, '别处 worktree', '.git').replace(/\\/g, '/')}\n`)],
        ['worktree/.git 没有指回管理目录', (c) => { fs.unlinkSync(path.join(c.wt, '.git')); fs.writeFileSync(path.join(c.wt, '.git'), `gitdir: ${path.join(fx2.root, '别处 管理目录').replace(/\\/g, '/')}\n`); }],
    ];
    let ti = 0;
    for (const [label, tamper] of TAMPERS) {
        ti += 1;
        const name = `t${ti}`;
        const c = await mkLine(fx2, name);
        if (!c) continue;
        tamper(c);
        const out = [];
        const rr = await removeLine(fx2, name, { discard: true }, {}, out);
        check(`11.2 篡改 ${label}：证明不了归属 → 只清登记（槽位释放），worktree（含联接）、管理目录、分支原样保留，并有提示`, rr.err === null && Object.keys((await regOf(fx2)).lines).length === 0 && fs.existsSync(c.wt) && NM_RELS.every((rel) => isLink(path.join(c.wt, rel)))
            && fs.existsSync(c.admin) && branchExists(fx2, `line/${name}`) && hasLine(out, '证明不了是本工具'), rr.err && rr.err.message);
    }
    check('11.2z 全部篡改用例之后主工作区深度摘要不变', mainIntact(fx2));

    // ---- 11.3 管理目录被换成 junction（指向外部目录，里面有与真目录一致的 gitdir / 标记）→ 不跟随、外部原样 ----
    const fx3 = await buildFixture('s11adminlink');
    const c3 = await mkLine(fx3, 'al');
    if (c3) {
        const ext = path.join(fx3.root, '外部 管理目录副本');
        copyDirPlain(c3.admin, ext);
        const extDigest = deepDigest(ext);
        check('11.3.0 前置：外部副本含 gitdir 与标记', fs.existsSync(path.join(ext, 'gitdir')) && fs.existsSync(path.join(ext, 'sdh-line-owner.json')));
        check('11.3.1 前置：原管理目录清空并换成指向外部副本的 junction', removeTree(c3.admin).length === 0 && (C.makeJunction(ext, c3.admin), isLink(c3.admin)));
        const rr = await removeLine(fx3, 'al', { discard: true });
        check('11.3 管理目录是 junction：证明不了归属 → 只清登记；外部副本一个字节没动，worktree 原样保留', rr.err === null && deepDigest(ext) === extDigest && fs.existsSync(c3.wt) && Object.keys((await regOf(fx3)).lines).length === 0, rr.err && rr.err.message);
        C.removeLinkChecked(c3.admin);
    }

    // ---- 11.4 worktree 目录缺失：按管理目录的 HEAD 与 reflog 做未合入检查（git --git-dir=<管理目录>）----
    const fx4 = await buildFixture('s11missing');
    const h1 = await mkLine(fx4, 'h1');
    if (h1) {
        gitq(h1.wt, ['checkout', '-q', '--detach']);
        commitIn(fx4, 'h1', 'detached-only.txt', 'only-on-detached');
        const lostH1 = git(h1.wt, ['rev-parse', 'HEAD']).trim();
        check('11.4.0 前置：人手删掉 worktree 目录（管理目录还在，HEAD 是只存在于 detached HEAD 的提交）', removeTree(h1.wt).length === 0 && !fs.existsSync(h1.wt) && fs.existsSync(h1.admin));
        const regH1 = await regOf(fx4);
        const d1 = await removeLine(fx4, 'h1');
        check('11.4a 目录缺失 + detached HEAD 有提交：拒绝，消息说明按管理目录核实、HEAD 不在集成分支里；登记不变、管理目录与分支原样', d1.err && d1.err.code === 'LINE_REMOVE_REFUSED' && /管理目录/.test(d1.err.message) && /HEAD/.test(d1.err.message) && same(await regOf(fx4), regH1) && fs.existsSync(h1.admin) && branchExists(fx4, 'line/h1'), d1.err && d1.err.message);
        check('11.4a2 那个只在 detached HEAD 上的提交对象还在（没被丢）', git(fx4.main, ['cat-file', '-t', lostH1]).trim() === 'commit');
        const d1b = await removeLine(fx4, 'h1', { discard: true });
        check('11.4b --discard 才能清理：管理目录被逐项删除，分支（已合入）被条件删除，登记移入 history', d1b.err === null && !fs.existsSync(h1.admin) && !branchExists(fx4, 'line/h1') && Object.keys((await regOf(fx4)).lines).length === 0, d1b.err && d1b.err.message);
    }
    const h2 = await mkLine(fx4, 'h2');
    if (h2) {
        commitIn(fx4, 'h2', 'lost2.txt', 'lost-by-reset');
        const lost2 = git(h2.wt, ['rev-parse', 'HEAD']).trim();
        git(h2.wt, ['reset', '-q', '--hard', 'HEAD~1']);
        check('11.4c.0 前置：reset 之后 HEAD = 线分支 = main；人手删掉 worktree 目录', removeTree(h2.wt).length === 0 && git(fx4.main, ['rev-parse', 'refs/heads/line/h2']).trim() === git(fx4.main, ['rev-parse', 'refs/heads/main']).trim());
        const d2 = await removeLine(fx4, 'h2');
        check('11.4c 目录缺失 + HEAD reflog 有被丢弃的提交：拒绝并列出提交', d2.err && d2.err.code === 'LINE_REMOVE_REFUSED' && /reflog/.test(d2.err.message) && d2.err.message.includes(lost2.slice(0, 10)) && fs.existsSync(h2.admin), d2.err && d2.err.message);
        const d2b = await removeLine(fx4, 'h2', { discard: true });
        check('11.4d --discard 才能清理', d2b.err === null && !fs.existsSync(h2.admin), d2b.err && d2b.err.message);
    }
    const h3 = await mkLine(fx4, 'h3');
    if (h3) {
        removeTree(h3.wt);
        fs.unlinkSync(path.join(h3.admin, 'HEAD'));
        const d3 = await removeLine(fx4, 'h3');
        check('11.4e 目录缺失 + 管理目录里的 HEAD 读不了（无法核实）：默认拒绝，消息说明无法核实', d3.err && d3.err.code === 'LINE_REMOVE_REFUSED' && /无法读取 worktree 的 HEAD/.test(d3.err.message) && fs.existsSync(h3.admin), d3.err && d3.err.message);
        const d3b = await removeLine(fx4, 'h3', { discard: true });
        check('11.4f --discard 才能清理（残缺的管理目录也能逐项删干净）', d3b.err === null && !fs.existsSync(h3.admin), d3b.err && d3b.err.message);
    }
    const h4 = await mkLine(fx4, 'h4');
    if (h4) {
        removeTree(h4.wt);
        check('11.4g.0 前置：管理目录也被手工删掉', removeTree(h4.admin).length === 0 && !fs.existsSync(h4.admin));
        const d4 = await removeLine(fx4, 'h4');
        check('11.4g worktree 目录与管理目录都不在：不拒绝，只清登记 + 条件删除分支（已合入）', d4.err === null && Object.keys((await regOf(fx4)).lines).length === 0 && !branchExists(fx4, 'line/h4'), d4.err && d4.err.message);
    }
    check('11.4z 以上用例之后主工作区完好', mainIntact(fx4));

    // ---- 11.5 分支被其他检出占用 → 保留并提示 ----
    const fx5 = await buildFixture('s11occupied');
    const o5 = await mkLine(fx5, 'oc');
    if (o5) {
        gitq(o5.wt, ['checkout', '-q', '--detach']);   // 线自己的 worktree 切到 detached（HEAD 与 main 同提交），把分支让出来
        const other = path.join(fx5.root, '别人的 检出', 'occupier');
        git(fx5.main, ['worktree', 'add', '-q', other, 'line/oc']);
        const out = [];
        const r5 = await removeLine(fx5, 'oc', {}, {}, out);
        check('11.5 线分支已合入，但正被另一个检出占用：线删除成功，分支保留并提示占用者；占用者的检出与分支原样', r5.err === null && r5.res.branchKept === true && r5.res.branchDeleted === false && branchExists(fx5, 'line/oc') && fs.existsSync(path.join(other, '.git')) && hasLine(out, '正被其他检出占用') && hasLine(out, 'occupier'), r5.err && r5.err.message);
        check('11.5b 登记已移入 history，主工作区完好', Object.keys((await regOf(fx5)).lines).length === 0 && mainIntact(fx5));
    }

    // ---- 11.6 集成分支在检查之后变化 → update-ref 事务整体失败，分支保留 ----
    const fx6 = await buildFixture('s11txn');
    const t6 = await mkLine(fx6, 'tx');
    if (t6) {
        const r6 = await removeLine(fx6, 'tx', {}, { testHooks: { beforeBranchDelete: () => { git(fx6.main, ['commit', '--allow-empty', '-q', '-m', 'integration moved after check']); } } });
        check('11.6 集成分支在合入判断之后前移：事务（verify 集成分支 + delete 线分支）整体失败，失败于 branch_delete，分支保留', r6.err && r6.err.step === 'branch_delete' && /条件删除分支/.test(r6.err.message) && branchExists(fx6, 'line/tx'), r6.err && r6.err.message);
        const st6 = await regOf(fx6);
        check('11.6b 登记 failed / branch_delete；worktree 与管理目录已删', st6.lines.tx && st6.lines.tx.lifecycle === 'failed' && st6.lines.tx.failed_step === 'branch_delete' && !fs.existsSync(t6.wt) && !fs.existsSync(t6.admin));
        const r6b = await removeLine(fx6, 'tx');
        check('11.6c 重试成功（线分支仍被新的集成分支包含）：分支被条件删除，登记移入 history', r6b.err === null && !branchExists(fx6, 'line/tx') && Object.keys((await regOf(fx6)).lines).length === 0, r6b.err && r6b.err.message);
    }

    // ---- 11.7 在 worktree 之内执行 remove：任何修改之前拒绝（CLI 子进程，cwd = worktree）----
    const fx7 = await buildFixture('s11cwd');
    const w7 = await mkLine(fx7, 'cw');
    if (w7) {
        const regBefore = await regOf(fx7);
        const roots7 = ['--control-root', fx7.control, '--lines-root', fx7.lines, '--main-root', fx7.main];
        const cr = runCli(['remove', 'cw', ...roots7], { cwd: w7.wt });
        check('11.7 cwd 在 worktree 之内：退出码 1，stderr 提示「先切到线目录之外」', cr.status === 1 && /先切到线目录之外/.test(cr.stderr), { s: cr.status, e: cr.stderr });
        check('11.7b 什么都没改：登记表不变（ready）、worktree 与两个联接都在、主工作区完好', same(await regOf(fx7), regBefore) && NM_RELS.every((rel) => isLink(path.join(w7.wt, rel))) && mainIntact(fx7));
        const cr2 = runCli(['remove', 'cw', ...roots7], { cwd: path.join(w7.wt, 'wbs-server') });
        check('11.7c cwd 在 worktree 的子目录里同样拒绝', cr2.status === 1 && /先切到线目录之外/.test(cr2.stderr), { s: cr2.status, e: cr2.stderr });
        const cr3 = runCli(['remove', 'cw', ...roots7], { cwd: fx7.root });
        check('11.7d 在线目录之外执行则正常删除', cr3.status === 0 && !fs.existsSync(w7.wt), { s: cr3.status, e: cr3.stderr });
    }

    // ---- 11.8 预检失败不改状态（对 failed 的线同样）----
    const fx8 = await buildFixture('s11pre');
    fs.unlinkSync(fx8.mainDb);
    const p8 = await newLine(fx8, 'pf', 'm-pf');
    check('11.8.0 pf 失败于 create_db（前置）', p8.err && p8.err.step === 'create_db', p8.err && p8.err.message);
    const leak8 = path.join(wtOf(fx8, 'pf'), 'wbs-server', 'uploads-leak');
    fs.mkdirSync(path.join(wtOf(fx8, 'pf'), 'wbs-server'), { recursive: true });
    C.makeJunction(path.join(fx8.main, 'wbs-server', 'archive'), leak8);
    const reg8 = await regOf(fx8);
    const pr8 = await removeLine(fx8, 'pf', { discard: true });
    check('11.8 failed 的线预检失败：拒绝（step=precheck），登记表整体不变（仍是 failed / create_db）', pr8.err && pr8.err.code === 'LINE_REMOVE_REFUSED' && pr8.err.step === 'precheck' && same(await regOf(fx8), reg8) && reg8.lines.pf.failed_step === 'create_db', pr8.err && pr8.err.message);
    C.removeLinkChecked(leak8);
    const pr8b = await removeLine(fx8, 'pf', { discard: true });
    check('11.8b 拆掉残留联接后重试成功', pr8b.err === null && !fs.existsSync(wtOf(fx8, 'pf')) && mainIntact(fx8), pr8b.err && pr8b.err.message);

    // ---- 11.9 上锁的 worktree ----
    const fx9 = await buildFixture('s11lock');
    const k9 = await mkLine(fx9, 'lk');
    if (k9) {
        git(fx9.main, ['worktree', 'lock', '--reason', 'keep-me', k9.wt]);
        const reg9 = await regOf(fx9);
        const l9 = await removeLine(fx9, 'lk');
        check('11.9 worktree 被 git worktree lock 上锁：拒绝，消息含上锁原因；登记不变、worktree 与联接都在', l9.err && l9.err.code === 'LINE_REMOVE_REFUSED' && /上锁/.test(l9.err.message) && /keep-me/.test(l9.err.message) && same(await regOf(fx9), reg9) && NM_RELS.every((rel) => isLink(path.join(k9.wt, rel))), l9.err && l9.err.message);
        const l9d = await removeLine(fx9, 'lk', { discard: true });
        check('11.9b 带 --discard 同样拒绝（上锁不是未合入 / 未提交，不能靠 --discard 绕过）', l9d.err && l9d.err.code === 'LINE_REMOVE_REFUSED' && /上锁/.test(l9d.err.message) && fs.existsSync(k9.wt), l9d.err && l9d.err.message);
        git(fx9.main, ['worktree', 'unlock', k9.wt]);
        const l9u = await removeLine(fx9, 'lk');
        check('11.9c 解锁后正常删除', l9u.err === null && !fs.existsSync(k9.wt), l9u.err && l9u.err.message);
    }

    // ---- 11.10 删除中途失败后的重试：不加 --discard 即可，其余检查照做 ----
    const fx10 = await buildFixture('s11retry');
    const r10 = await mkLine(fx10, 'rt');
    if (r10) {
        const inj = await removeLine(fx10, 'rt', {}, { testHooks: { beforeTreeDelete: () => { fs.unlinkSync(path.join(r10.wt, 'wbs-server', 'hello.txt')); throw new Error('注入：删除中途失败'); } } });
        const st10 = await regOf(fx10);
        check('11.10.0 注入失败：失败于 tree_delete，登记 failed；被跟踪文件 hello.txt 已被删（status 里是 ` D`）；联接已拆', inj.err && inj.err.step === 'tree_delete' && st10.lines.rt.failed_step === 'tree_delete' && /^ D /m.test(gitq(r10.wt, ['status', '--porcelain'])) && NM_RELS.every((rel) => !fs.existsSync(path.join(r10.wt, rel))), inj.err && inj.err.message);
        check('11.10.0b 失败消息写明重试方式（首次带了 --discard 的，重试也要带；不再说「不需要 --discard」）', inj.err && /重试 line remove rt/.test(inj.err.message) && /首次带了 --discard 的，重试也要带 --discard/.test(inj.err.message) && !/不需要 --discard/.test(inj.err.message), inj.err && inj.err.message);
        // 其余检查照做：新出现一个未跟踪文件 → 重试仍拒绝
        w(path.join(r10.wt, 'wbs-server', 'extra-untracked.txt'), 'U');
        const rA = await removeLine(fx10, 'rt');
        check('11.10a 重试时新出现未跟踪文件：仍按未提交改动拒绝（只放宽「被跟踪文件被删」），登记仍是 failed / tree_delete', rA.err && rA.err.code === 'LINE_REMOVE_REFUSED' && /extra-untracked\.txt/.test(rA.err.message) && !/hello\.txt/.test(rA.err.message) && (await regOf(fx10)).lines.rt.failed_step === 'tree_delete', rA.err && rA.err.message);
        fs.unlinkSync(path.join(r10.wt, 'wbs-server', 'extra-untracked.txt'));
        // 其余检查照做：新增一个未合入提交（只提交新文件，hello.txt 的删除仍是 ` D`）→ 仍按未合入拒绝
        w(path.join(r10.wt, 'wbs-server', 'f10.txt'), 'f10');
        git(r10.wt, ['add', 'wbs-server/f10.txt']);
        git(r10.wt, ['commit', '-q', '-m', 'c-f10']);
        const rB = await removeLine(fx10, 'rt');
        check('11.10b 重试时线分支有未合入提交：仍拒绝（未合入检查照做）', rB.err && rB.err.code === 'LINE_REMOVE_REFUSED' && /未合入/.test(rB.err.message), rB.err && rB.err.message);
        git(fx10.main, ['merge', '-q', '--no-ff', '-m', 'merge rt', 'line/rt']);   // 把那个提交合入集成分支：未合入的原因消除，只剩 hello.txt 的 ` D`
        const rC = await removeLine(fx10, 'rt');
        check('11.10c 只剩「被跟踪文件被删」时不加 --discard 重试成功：worktree、管理目录、分支（已合入）都清掉，登记移入 history', rC.err === null && !fs.existsSync(r10.wt) && !fs.existsSync(r10.admin) && !branchExists(fx10, 'line/rt') && Object.keys((await regOf(fx10)).lines).length === 0, rC.err && rC.err.message);
    }
    // .git 文件已被删、根目录 rmdir 失败（新出现的文件）后的重试
    const r10b = await mkLine(fx10, 'rt2');
    if (r10b) {
        const inj2 = await removeLine(fx10, 'rt2', {}, { testHooks: { afterTreeContentDelete: (root) => { fs.writeFileSync(path.join(root, 'stray.txt'), 'S'); } } });
        check('11.10d 内容删光后根目录 rmdir 失败（出现新文件）：失败于 tree_delete；此时 .git 文件已被删', inj2.err && inj2.err.step === 'tree_delete' && /rmdir/.test(inj2.err.message) && !fs.existsSync(path.join(r10b.wt, '.git')) && fs.existsSync(path.join(r10b.wt, 'stray.txt')), inj2.err && inj2.err.message);
        const rD = await removeLine(fx10, 'rt2');
        check('11.10e .git 已不在的重试：预检放过，按管理目录核实后发现未跟踪文件 stray.txt → 拒绝', rD.err && rD.err.code === 'LINE_REMOVE_REFUSED' && /stray\.txt/.test(rD.err.message), rD.err && rD.err.message);
        fs.unlinkSync(path.join(r10b.wt, 'stray.txt'));
        const rE = await removeLine(fx10, 'rt2');
        check('11.10f 去掉 stray.txt 后重试成功（.git 已被删也能重试）', rE.err === null && !fs.existsSync(r10b.wt) && !fs.existsSync(r10b.admin), rE.err && rE.err.message);
    }

    // ---- 11.11 根覆盖参数指向真实值被拒（--main-root / --lines-root；--control-root 见 9.18）----
    const fx11 = await buildFixture('s11roots', { noDb: true });
    const runIn = async (argv, scriptRoot, opts) => {
        const errs = [];
        const origE = console.error;
        console.error = (...a) => { errs.push(a.join(' ')); ALL_OUT.push(a.join(' ')); };
        let code;
        try { code = await L.run(argv, scriptRoot, opts); } finally { console.error = origE; }
        return { code, errs };
    };
    const base11 = ['new', 'rr', '--module', 'm-rr', '--surface', 's'];
    const altControl = path.join(fx11.root, '别的 控制根');
    const rm = await runIn([...base11, '--control-root', altControl, '--lines-root', fx11.lines, '--main-root', fx11.main], fx11.main);
    check('11.11 --main-root 等于脚本所在检出的真实主仓库：拒绝（退出码 2，文案说明），没有建线（登记里没有、没有目录）、没有读 .env', rm.code === 2 && rm.errs.some((l) => /--main-root/.test(l) && /真实主仓库/.test(l)) && Object.keys((await S.readState(altControl)).lines).length === 0 && !fs.existsSync(wtOf(fx11, 'rr')), rm);
    const rl = await runIn([...base11, '--control-root', fx11.control, '--lines-root', fx11.lines, '--main-root', fx11.main], SELF_CHECKOUT_ROOT, { realLinesRoot: fx11.lines });
    check('11.11b --lines-root 等于真实线目录根：拒绝（退出码 2），没有建线', rl.code === 2 && rl.errs.some((l) => /--lines-root/.test(l)) && Object.keys((await regOf(fx11)).lines).length === 0 && !fs.existsSync(wtOf(fx11, 'rr')), rl);
    const rl2 = await runIn([...base11, '--control-root', fx11.control, '--lines-root', path.join(fx11.lines, '子 目录'), '--main-root', fx11.main], SELF_CHECKOUT_ROOT, { realLinesRoot: fx11.lines });
    check('11.11c --lines-root 位于真实线目录根之内：同样拒绝', rl2.code === 2 && rl2.errs.some((l) => /--lines-root/.test(l)) && Object.keys((await regOf(fx11)).lines).length === 0, rl2);
    check('11.11d 拒绝文案写死、不回显取值（stderr 里没有传入的路径）', ![rm, rl, rl2].some((x) => x.errs.some((l) => l.includes(fx11.root))), [rm.errs, rl.errs]);

    // ---- 11.12 复制：来源根的祖先链与每个来源子目录做重解析点检查（注入 realpath）----
    const cdir = path.join(os.tmpdir(), `行线 测试 ${process.pid}-copy`);
    ALL_ROOTS.push(cdir);
    w(path.join(cdir, 'base', 'anc', 'uploads', 'ok', 'f.txt'), 'F');
    w(path.join(cdir, 'base', 'anc', 'uploads', 'mnt-sub', 'g.txt'), 'G');
    const baseReal = fs.realpathSync.native(path.join(cdir, 'base'));
    const fakeRealC = (p) => { const r = fs.realpathSync.native(p); return /(^mnt-|^anc-bad)/.test(path.basename(p)) ? `${r}-REDIRECTED` : r; };
    let e12a = null;
    try { C.copyTreeNoFollow(path.join(baseReal, 'anc', 'uploads'), path.join(cdir, 'dst-a'), { srcBase: baseReal, realpath: fakeRealC }); } catch (e) { e12a = e; }
    check('11.12 来源子目录 realpath 与「父真实路径 + 名字」不一致（重解析点）：拒绝进入，抛 LINE_UNSAFE_PATH，消息指明目录', e12a && e12a.code === 'LINE_UNSAFE_PATH' && /mnt-sub/.test(e12a.message) && !fs.existsSync(path.join(cdir, 'dst-a', 'mnt-sub', 'g.txt')), e12a && e12a.message);
    fs.renameSync(path.join(cdir, 'base', 'anc'), path.join(cdir, 'base', 'anc-bad'));
    let e12b = null;
    try { C.copyTreeNoFollow(path.join(baseReal, 'anc-bad', 'uploads'), path.join(cdir, 'dst-b'), { srcBase: baseReal, realpath: fakeRealC }); } catch (e) { e12b = e; }
    check('11.12b 来源根的祖先目录（anc-bad）是重解析点：在创建任何目标之前拒绝（LINE_UNSAFE_PATH）', e12b && e12b.code === 'LINE_UNSAFE_PATH' && /anc-bad/.test(e12b.message) && !fs.existsSync(path.join(cdir, 'dst-b')), e12b && e12b.message);
    fs.renameSync(path.join(cdir, 'base', 'anc-bad'), path.join(cdir, 'base', 'anc'));
    fs.renameSync(path.join(cdir, 'base', 'anc', 'uploads', 'mnt-sub'), path.join(cdir, 'base', 'anc', 'uploads', 'plain-sub'));
    const s12 = C.copyTreeNoFollow(path.join(baseReal, 'anc', 'uploads'), path.join(cdir, 'dst-c'), { srcBase: baseReal, realpath: fakeRealC });
    check('11.12c 对照：没有重解析点时同样的调用复制成功（2 个文件），内容一致', s12.files === 2 && rd(path.join(cdir, 'dst-c', 'ok', 'f.txt')) === 'F' && rd(path.join(cdir, 'dst-c', 'plain-sub', 'g.txt')) === 'G', s12);
    let e12d = null;
    try { C.copyTreeNoFollow(path.join(cdir, 'dst-c'), path.join(cdir, 'dst-d'), { srcBase: baseReal }); } catch (e) { e12d = e; }
    check('11.12d 来源不在基准目录之内：拒绝（LINE_UNSAFE_PATH）', e12d && e12d.code === 'LINE_UNSAFE_PATH' && !fs.existsSync(path.join(cdir, 'dst-d')), e12d && e12d.message);

    // ---- 11.13 入口输出：脱敏器建立之前只输出固定文案，不回显原始参数与未处理的异常内容 ----
    const fx13 = await buildFixture('s11envdir', { noDb: true });
    const roots13 = ['--control-root', fx13.control, '--lines-root', fx13.lines, '--main-root', fx13.main];   // 带根覆盖参数：不转发，用法错误在本进程里报（不会触达真实主工作区的脚本）
    const cliBad = [
        ['未知子命令位置放长密钥', [`frob-${ARG_SECRET}`, ...roots13]],
        ['new 的未知参数名放长密钥（--x=v 写法）', ['new', 'x', `--${ARG_SECRET}=1`, '--module', 'm', '--surface', 's', ...roots13]],
        ['remove 的未知参数名放长密钥（空格写法）', ['remove', 'x', `--bogus-${ARG_SECRET}`, 'v', ...roots13]],
    ];
    for (const [label, argv] of cliBad) {
        const cr = runCli(argv);
        check(`11.13 ${label}：用法错误（退出码 2），stderr / stdout 里没有这个密钥`, cr.status === 2 && /用法错误/.test(cr.stderr) && !`${cr.stderr}${cr.stdout}`.includes(ARG_SECRET), { s: cr.status, e: cr.stderr });
    }
    const cKnown = runCli(['new', 'x', '--discard', '--module', 'm', '--surface', 's', ...roots13]);
    check('11.13b 本脚本认识的参数名用错子命令时仍回显参数名（可用性保留）', cKnown.status === 2 && /--discard/.test(cKnown.stderr), cKnown.stderr);
    const nogit = path.join(os.tmpdir(), `行线 测试 ${process.pid}-nogit`);
    ALL_ROOTS.push(nogit);
    fs.mkdirSync(path.join(nogit, 'scripts', 'lines'), { recursive: true });
    fs.copyFileSync(path.join(LINES_DIR, 'line.js'), path.join(nogit, 'scripts', 'lines', 'line.js'));
    const cNoGit = spawnSync(process.execPath, [path.join(nogit, 'scripts', 'lines', 'line.js'), 'new', 'x', '--module', 'm', '--surface', 's'], { encoding: 'utf8', timeout: 60000, windowsHide: true });
    ALL_OUT.push(cNoGit.stdout || '', cNoGit.stderr || '');
    check('11.13c 脚本不在 git 仓库里（转发判定阶段失败）：退出码 1，只有固定文案，不含 git / 系统的原始异常（Command failed / fatal）', cNoGit.status === 1 && /详情已隐藏/.test(cNoGit.stderr) && !/Command failed|fatal:/.test(cNoGit.stderr), { s: cNoGit.status, e: cNoGit.stderr });
    fs.unlinkSync(path.join(fx13.main, 'wbs-server', '.env'));
    fs.mkdirSync(path.join(fx13.main, 'wbs-server', '.env'));
    const cEnv = runCli(['new', 'z', '--module', 'm', '--surface', 's', ...roots13]);
    check('11.13d 主 .env 读不了（脱敏器建不起来）：退出码 1，输出固定文案 + 错误码，不回显 fs 的原始异常（EISDIR）', cEnv.status === 1 && /LINE_ENV_UNREADABLE/.test(cEnv.stderr) && /详情已隐藏/.test(cEnv.stderr) && !/EISDIR|illegal operation/.test(cEnv.stderr), { s: cEnv.status, e: cEnv.stderr });

    // ---- 11.14 scrubError：message / stack / cause 链 / 异常上的字符串字段 ----
    const SCRUB_SECRET = 'scrub-secret-0123456789abcdef';
    const redactS = C.makeRedactor([SCRUB_SECRET]);
    const innerE = new Error(`inner ${SCRUB_SECRET}`);
    const outerE = new C.LineError('LINE_X', `outer ${SCRUB_SECRET}`, { cause: innerE });
    outerE.stderr = `stderr ${SCRUB_SECRET}`;
    const had = outerE.stack.includes(SCRUB_SECRET) && innerE.stack.includes(SCRUB_SECRET);
    C.scrubError(outerE, redactS);
    const hasSecret = (e) => [e.message, e.stack, e.cause && e.cause.message, e.cause && e.cause.stack, e.stderr].some((s) => typeof s === 'string' && s.includes(SCRUB_SECRET));
    check('11.14 scrubError 前置：构造的异常 stack 里确实含密钥（V8 把旧消息固化在 stack 头部）', had);
    check('11.14b scrubError 之后 message / stack / cause.message / cause.stack / stderr 里都没有密钥，且出现 [已脱敏]；code 保留、stack 仍有调用栈行', !hasSecret(outerE) && outerE.message.includes('[已脱敏]') && outerE.stack.includes('[已脱敏]') && outerE.cause.stack.includes('[已脱敏]') && outerE.code === 'LINE_X' && /\n\s+at /.test(outerE.stack), { m: outerE.message, s: outerE.stack.slice(0, 200) });
    const cyc = new Error(`cyc ${SCRUB_SECRET}`);
    cyc.cause = cyc;
    check('11.14c 环形 cause 不死循环', (() => { C.scrubError(cyc, redactS); return !cyc.message.includes(SCRUB_SECRET); })());

    // ---- 11.15 reflog 批量检查：一次 rev-list --stdin；对象名按 Git 输出原样（SHA-256 仓库 64 位）----
    const fx15 = await buildFixture('s11reflog');
    const b15 = await mkLine(fx15, 'bl');
    if (b15) {
        for (let i = 0; i < 10; i += 1) commitIn(fx15, 'bl', `many-${i}.txt`, `m${i}`);
        const tip15 = git(b15.wt, ['rev-parse', 'HEAD']).trim();
        git(b15.wt, ['reset', '-q', '--hard', 'HEAD~10']);
        const recB = await recordGit(() => removeLine(fx15, 'bl'));
        const listed = /(\d+) 个不被 main 或 line\/bl 包含的提交/.exec(recB.res.err ? recB.res.err.message : '');
        check('11.15 reflog 里有 10 个被丢弃的提交：拒绝，数量 = 10（手写期望），列出的提交里含最后那个', recB.res.err && recB.res.err.code === 'LINE_REMOVE_REFUSED' && listed && Number(listed[1]) === 10 && recB.res.err.message.includes(tip15.slice(0, 10)), recB.res.err && recB.res.err.message);
        const revListStdin = recB.calls.filter((a) => a.includes('rev-list') && a.includes('--stdin')).length;
        const mergeBase = recB.calls.filter((a) => a.includes('merge-base')).length;
        check('11.15b 批量化：reflog 检查只起 1 次 `rev-list --stdin`，merge-base 次数与 reflog 条目数无关（<= 3）', revListStdin === 1 && mergeBase <= 3, { revListStdin, mergeBase, total: recB.calls.length });
        const rB2 = await removeLine(fx15, 'bl', { discard: true });
        check('11.15c --discard 清理', rB2.err === null, rB2.err && rB2.err.message);
    }
    let sha256Ok = false;
    const sdir = path.join(os.tmpdir(), `行线 测试 ${process.pid}-sha256`);
    ALL_ROOTS.push(sdir);
    try {
        fs.mkdirSync(sdir, { recursive: true });
        git(sdir, ['init', '-q', '-b', 'main', '--object-format=sha256']);
        sha256Ok = gitq(sdir, ['rev-parse', '--show-object-format']).trim() === 'sha256';
    } catch (_) { sha256Ok = false; }
    if (!sha256Ok) {
        log('  SKIP  11.15d SHA-256 仓库：本机 git 不支持 --object-format=sha256，未跑（64 位对象名的处理本批没有别的覆盖）');
    } else {
        w(path.join(sdir, 'a.txt'), 'a');
        git(sdir, ['add', '-A']);
        git(sdir, ['commit', '-q', '-m', 'one']);
        w(path.join(sdir, 'b.txt'), 'b');
        git(sdir, ['add', '-A']);
        git(sdir, ['commit', '-q', '-m', 'two']);
        const lost256 = git(sdir, ['rev-parse', 'HEAD']).trim();
        git(sdir, ['reset', '-q', '--hard', 'HEAD~1']);
        const reflog256 = git(sdir, ['reflog', 'show', '--format=%H', 'HEAD']).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        const sr = R.strayReflogOids(sdir, Array.from(new Set(reflog256)), 'refs/heads/main', 'refs/heads/line/none');
        check('11.15d SHA-256 仓库（64 位对象名）：reflog 里被丢弃的提交被找出（不因长度被静默丢弃）', lost256.length === 64 && sr.ok && sr.stray.length === 1 && sr.stray[0] === lost256, { len: lost256.length, sr });
    }

    // ---- 11.16 主 node_modules 在拆线期间「新增条目」只告警，不判失败 ----
    const fx16 = await buildFixture('s11added');
    const a16 = await mkLine(fx16, 'ad');
    if (a16) {
        const out16 = [];
        const r16 = await removeLine(fx16, 'ad', {}, { testHooks: { afterWorktreeRemove: () => { w(path.join(fx16.main, 'node_modules', 'newpkg', 'x.js'), 'NEW'); } } }, out16);
        check('11.16 拆线期间主 node_modules 新增了条目：只告警（warnings 与输出里有），删线照常成功', r16.err === null && r16.res.warnings.some((x) => /新增条目/.test(x) && /newpkg/.test(x)) && hasLine(out16, '只告警'), r16.err && r16.err.message);
        removeTree(path.join(fx16.main, 'node_modules', 'newpkg'));
    }

    // ---- 11.17 两处 expectGeneration 写入：失败回写（catch 里的 upd）与最终登记（removeLineRecord）----
    const fx17 = await buildFixture('s11gen');
    const g17 = await mkLine(fx17, 'ga');
    if (g17) {
        let newGen = null;
        const r17 = await removeLine(fx17, 'ga', {}, { testHooks: { beforeBranchDelete: async () => { newGen = await recreateAsRemoving(fx17, 'ga'); throw new Error('注入：分支删除失败'); } } });
        const st17 = await regOf(fx17);
        check('11.17 失败回写带代次：旧操作失败后把线标 failed 的写入被代次拦下（消息里有「登记表写入也失败」），同名重建的新线原样（removing、新代次、failed_step 仍为 null）',
            r17.err && r17.err.step === 'branch_delete' && /登记表写入也失败/.test(r17.err.message) && st17.lines.ga.generation === newGen && st17.lines.ga.lifecycle === 'removing' && st17.lines.ga.failed_step === null && st17.lines.ga.module === 'm-new-gen', r17.err && r17.err.message);
    }
    const g17b = await mkLine(fx17, 'gb');
    if (g17b) {
        let newGen2 = null;
        const r17b = await removeLine(fx17, 'gb', {}, { testHooks: { beforeFinalize: async () => { newGen2 = await recreateAsRemoving(fx17, 'gb'); } } });
        const st17b = await regOf(fx17);
        check('11.17b 最终登记带代次：旧操作的 removeLineRecord 被代次拦下（失败于 finalize），同名重建的新线没有被删（仍在 lines 里、removing、新代次），history 里没有新代次', r17b.err && r17b.err.step === 'finalize' && /代次/.test(r17b.err.message) && st17b.lines.gb && st17b.lines.gb.generation === newGen2 && st17b.lines.gb.lifecycle === 'removing' && !st17b.history.some((h) => h.generation === newGen2), r17b.err && r17b.err.message);
    }

    // ---- 11.18 槽位预留之后的输出失败也落到 failed（不让记录停在 creating）----
    const fx18 = await buildFixture('s11say');
    const s18 = await newLine(fx18, 'sy', 'm-sy', {}, [], { out: () => { throw new Error('注入：输出通道失败'); } });
    const st18 = await regOf(fx18);
    check('11.18 预留槽位后第一条输出就失败：lifecycle=failed、failed_step=reserve（不停在 creating），错误是 LINE_NEW_FAILED', s18.err && s18.err.code === 'LINE_NEW_FAILED' && s18.err.step === 'reserve' && st18.lines.sy && st18.lines.sy.lifecycle === 'failed' && st18.lines.sy.failed_step === 'reserve', s18.err && s18.err.message);

    // ---- 11.19 预检的重解析点分支端到端（注入 realpath）----
    const fx19 = await buildFixture('s11mismatch');
    const m19 = await mkLine(fx19, 'mm');
    if (m19) {
        const reg19 = await regOf(fx19);
        const nativeReal = (p) => fs.realpathSync.native(p);
        const r19 = await removeLine(fx19, 'mm', { discard: true }, { testHooks: { realpath: (p) => (path.basename(p) === 'uploads' ? `${nativeReal(p)}-REDIRECTED` : nativeReal(p)) } });
        check('11.19 整树预检里目录 realpath 与「父真实路径 + 名字」不一致（重解析点）：预检拒绝并列出该目录，登记不变，worktree 与联接原样', r19.err && r19.err.code === 'LINE_REMOVE_REFUSED' && r19.err.step === 'precheck' && /uploads/.test(r19.err.message) && /重解析点/.test(r19.err.message) && same(await regOf(fx19), reg19) && NM_RELS.every((rel) => isLink(path.join(m19.wt, rel))), r19.err && r19.err.message);
        // 预检之后才出现的不一致：strict 逐项删除中止（failed_step=tree_delete），不进入
        let armed = false;
        const r19b = await removeLine(fx19, 'mm', { discard: true }, { testHooks: { beforeTreeDelete: () => { armed = true; }, realpath: (p) => (armed && path.basename(p) === 'uploads' ? `${nativeReal(p)}-REDIRECTED` : nativeReal(p)) } });
        check('11.19b 预检之后才出现的重解析点：逐项删除中止（失败于 tree_delete，不进入该目录），uploads 的内容原样', r19b.err && r19b.err.step === 'tree_delete' && /重解析点/.test(r19b.err.message) && rd(path.join(m19.wt, 'wbs-server', 'uploads', 'sentinel.txt')) === 'RT-UPLOADS-OK', r19b.err && r19b.err.message);
        const r19c = await removeLine(fx19, 'mm', { discard: true });
        check('11.19c 排除原因后重试成功', r19c.err === null && !fs.existsSync(m19.wt) && mainIntact(fx19), r19c.err && r19c.err.message);
        // readdir 之后再复核目录自身身份：进入时 realpath 一致，列出内容之后第二次取 realpath 变了 → 中止
        const m19b = await mkLine(fx19, 'mm2');
        if (m19b) {
            let armed2 = false;
            const seen = new Map();
            const r19e = await removeLine(fx19, 'mm2', { discard: true }, { testHooks: { beforeTreeDelete: () => { armed2 = true; }, realpath: (p) => {
                const real = nativeReal(p);
                if (!armed2 || path.basename(p) !== 'uploads') return real;
                const n = (seen.get(p) || 0) + 1;
                seen.set(p, n);
                return n >= 2 ? `${real}-SWAPPED` : real;
            } } });
            check('11.19e 目录进入前 realpath 一致、readdir 之后第二次复核身份变了：逐项删除中止（身份发生变化），该目录内容原样', r19e.err && r19e.err.step === 'tree_delete' && /身份发生变化/.test(r19e.err.message) && rd(path.join(m19b.wt, 'wbs-server', 'uploads', 'sentinel.txt')) === 'RT-UPLOADS-OK', r19e.err && r19e.err.message);
        }
    }

    // ---- 11.20 逐项删除遇到预检之后出现的链接 / 被换掉的 worktree 根：中止，外部原样 ----
    const fx20 = await buildFixture('s11strict');
    const s20 = await mkLine(fx20, 'st');
    const victim20 = path.join(fx20.root, '外部 受害目录');
    w(path.join(victim20, 'deep', 'keep.txt'), 'VICTIM');
    const victimDigest20 = deepDigest(victim20);
    if (s20) {
        const lk20 = path.join(s20.wt, 'wbs-server', 'uploads', 'late-link');
        const r20 = await removeLine(fx20, 'st', { discard: true }, { testHooks: { beforeTreeDelete: () => { C.makeJunction(victim20, lk20); } } });
        check('11.20 预检之后才出现的 junction：逐项删除中止（失败于 tree_delete，消息说明与预检不一致），junction 不跟随、外部目录一个字节没动', r20.err && r20.err.step === 'tree_delete' && /与预检不一致/.test(r20.err.message) && deepDigest(victim20) === victimDigest20, r20.err && r20.err.message);
        check('11.20b 该 junction 还在原处（strict 模式不拆也不进）', isLink(lk20));
        C.removeLinkChecked(lk20);
        const r20b = await removeLine(fx20, 'st', { discard: true });
        check('11.20c 人工拆掉 junction 后重试成功', r20b.err === null && !fs.existsSync(s20.wt) && deepDigest(victim20) === victimDigest20 && mainIntact(fx20), r20b.err && r20b.err.message);
    }
    const s20b = await mkLine(fx20, 'st2');
    if (s20b) {
        const r20c = await removeLine(fx20, 'st2', { discard: true }, { testHooks: { beforeTreeDelete: () => { check('11.20d.0 前置：夹具把 worktree 根换成 junction', removeTree(s20b.wt).length === 0 && (C.makeJunction(victim20, s20b.wt), isLink(s20b.wt))); } } });
        check('11.20d worktree 根在预检之后被换成 junction：中止（失败于 tree_delete，消息说明身份变化），外部目录一个字节没动', r20c.err && r20c.err.step === 'tree_delete' && /身份发生变化/.test(r20c.err.message) && deepDigest(victim20) === victimDigest20, r20c.err && r20c.err.message);
        C.removeLinkChecked(s20b.wt);
    }

    // ---- 11.21 放宽状态不再放过缺失的归属标记（预筛 MED-1：用户手工收尾后在同一路径自建的 worktree 不得被当成本线的删掉）----
    //   场景：删除中途失败（线进入放宽状态）→ 用户手工收尾（删目录 + git worktree prune）→ 在同一路径自建一个 worktree（git 复用同名管理目录 id，没有归属标记、内容齐全，
    //   含被 git 忽略的个人文件）→ 重试 line remove。只在 failed_step=admin_delete 且管理目录正好只剩 gitdir（deleteAdminDir 中途失败的残留）时才放过缺失的标记。
    const fx21 = await buildFixture('s11marker');
    const userReAdd = async (c, branchName) => {
        removeTree(c.wt);
        git(fx21.main, ['worktree', 'prune']);
        const goneOld = !fs.existsSync(c.admin);
        git(fx21.main, ['worktree', 'add', '-q', '-b', branchName, c.wt, 'main']);
        w(path.join(c.wt, 'wbs-server', '.env'), 'USER_OWN=keep-me-please\n');
        w(path.join(c.wt, 'wbs-server', 'uploads', '我的 数据.txt'), 'USER-DATA');
        return goneOld && fs.existsSync(c.admin) && !fs.existsSync(path.join(c.admin, 'sdh-line-owner.json'));   // 前置：新管理目录与旧的同名、没有标记
    };
    const userIntact = (c, branchName) => fs.existsSync(path.join(c.wt, '.git')) && rd(path.join(c.wt, 'wbs-server', '.env')) === 'USER_OWN=keep-me-please\n' && rd(path.join(c.wt, 'wbs-server', 'uploads', '我的 数据.txt')) === 'USER-DATA'
        && branchExists(fx21, branchName) && fs.existsSync(c.admin) && git(fx21.main, ['worktree', 'list', '--porcelain', '-z']).split('\0').some((x) => x.startsWith('worktree ') && C.samePath(x.slice(9), c.wt));
    // a：失败于 tree_delete（放宽状态）后用户自建
    const v1 = await mkLine(fx21, 'va');
    if (v1) {
        const inj = await removeLine(fx21, 'va', {}, { testHooks: { beforeTreeDelete: () => { throw new Error('注入：删除中途失败'); } } });
        check('11.21a.0 前置：失败于 tree_delete（放宽状态）', inj.err && inj.err.step === 'tree_delete' && (await regOf(fx21)).lines.va.failed_step === 'tree_delete', inj.err && inj.err.message);
        check('11.21a.1 前置：用户手工收尾并在同一路径自建 worktree（同名管理目录、无标记）', await userReAdd(v1, 'user-branch-a'));
        const outA = [];
        const rA = await removeLine(fx21, 'va', {}, {}, outA);
        check('11.21a tree_delete 放宽状态 + 管理目录无标记：不当成本线的 worktree，只清登记（成功），用户的 worktree / .env / 个人文件 / 分支原样，有「证明不了是本工具」提示', rA.err === null && Object.keys((await regOf(fx21)).lines).includes('va') === false && userIntact(v1, 'user-branch-a') && hasLine(outA, '证明不了是本工具'), rA.err && rA.err.message);
        check('11.21a2 线分支 line/va 也原样保留（不是本工具建的检出占着它）', branchExists(fx21, 'line/va'));
    }
    // b：失败于 admin_delete（放过标记缺失的唯一状态）但管理目录是用户新建的完整目录（不是只剩 gitdir 的残留）
    const v2 = await mkLine(fx21, 'vb');
    if (v2) {
        await S.updateLine(fx21.control, 'vb', (r) => { r.lifecycle = 'removing'; });
        await S.updateLine(fx21.control, 'vb', (r) => { r.lifecycle = 'failed'; r.failed_step = 'admin_delete'; });
        check('11.21b.1 前置：登记为 failed / admin_delete；用户手工收尾并自建 worktree', (await regOf(fx21)).lines.vb.failed_step === 'admin_delete' && await userReAdd(v2, 'user-branch-b'));
        const outB = [];
        const rB = await removeLine(fx21, 'vb', {}, {}, outB);
        check('11.21b admin_delete 失败态 + 管理目录无标记且内容齐全（不是只剩 gitdir 的残留形态）：同样不当成本线的，只清登记，用户的 worktree / 个人文件 / 分支原样', rB.err === null && !(await regOf(fx21)).lines.vb && userIntact(v2, 'user-branch-b') && hasLine(outB, '证明不了是本工具'), rB.err && rB.err.message);
    }
    // c：真正的 admin_delete 残留（worktree 目录已不在，管理目录只剩 gitdir）：重试不加 --discard 就能清掉，分支（已合入）条件删除
    const v3 = await mkLine(fx21, 'vc');
    if (v3) {
        await S.updateLine(fx21.control, 'vc', (r) => { r.lifecycle = 'removing'; });
        await S.updateLine(fx21.control, 'vc', (r) => { r.lifecycle = 'failed'; r.failed_step = 'admin_delete'; });
        removeTree(v3.wt);
        for (const n of fs.readdirSync(v3.admin)) if (n !== 'gitdir') removeTree(path.join(v3.admin, n));   // deleteAdminDir 中途失败的残留：标记与其余内容已删，只剩 gitdir
        check('11.21c.0 前置：worktree 目录不在，管理目录只剩 gitdir', !fs.existsSync(v3.wt) && fs.readdirSync(v3.admin).join() === 'gitdir');
        const rC = await removeLine(fx21, 'vc');
        check('11.21c 真正的 admin_delete 残留（只剩 gitdir、failed_step=admin_delete）：重试不加 --discard 成功，管理目录被逐项删除，分支（已合入）被条件删除，登记移入 history', rC.err === null && !fs.existsSync(v3.admin) && !branchExists(fx21, 'line/vc') && !(await regOf(fx21)).lines.vc, rC.err && rC.err.message);
    }
    // d：只剩 gitdir 的残留形态，但 failed_step 不是 admin_delete（tree_delete）：不放过标记缺失，只清登记，管理目录原样
    const v4 = await mkLine(fx21, 'vd');
    if (v4) {
        await S.updateLine(fx21.control, 'vd', (r) => { r.lifecycle = 'removing'; });
        await S.updateLine(fx21.control, 'vd', (r) => { r.lifecycle = 'failed'; r.failed_step = 'tree_delete'; });
        removeTree(v4.wt);
        for (const n of fs.readdirSync(v4.admin)) if (n !== 'gitdir') removeTree(path.join(v4.admin, n));
        const outD = [];
        const rD = await removeLine(fx21, 'vd', {}, {}, outD);
        check('11.21d 管理目录只剩 gitdir 但 failed_step=tree_delete（不是 admin_delete）：证明不了归属，只清登记，管理目录与分支原样', rD.err === null && fs.existsSync(v4.admin) && branchExists(fx21, 'line/vd') && !(await regOf(fx21)).lines.vd && hasLine(outD, '证明不了是本线的'), rD.err && rD.err.message);
    }
    check('11.21z 以上用例之后主工作区完好', mainIntact(fx21));

    // ---- 11.22 reflog 收集完整（10-R2 H1）：HEAD reflog + 线分支 reflog，旧、新两端；读不了 / 格式异常默认拒绝 ----
    //   reflog 文件按 Git 的原始格式手写（<旧> <新> <ident>\t<消息>），模拟「较早记录过期后，丢失提交只剩在旧值一侧 / 只在线分支 reflog 里」。
    const fx22 = await buildFixture('s11reflog2');
    const IDENT = 't <t@t> 1700000000 +0000';
    const ZERO = '0'.repeat(40);
    const dangling = (name) => {   // 在主仓库造一个没有任何引用的悬空提交（父 = main）
        const tree = git(fx22.main, ['rev-parse', 'refs/heads/main^{tree}']).trim();
        const base = git(fx22.main, ['rev-parse', 'refs/heads/main']).trim();
        return { base, lost: git(fx22.main, ['commit-tree', tree, '-p', base, '-m', `lost-${name}`]).trim() };
    };
    const headLog = (c) => path.join(c.admin, 'logs', 'HEAD');
    const branchLog = (name) => path.join(fx22.main, '.git', 'logs', 'refs', 'heads', 'line', name);
    const lineOf = (o, n, msg) => `${o} ${n} ${IDENT}\t${msg}\n`;
    const reasonOf = async (name, args) => { const r = await removeLine(fx22, name, args); return r; };
    // a：丢失提交只在 HEAD reflog 的旧值一侧
    const q1 = await mkLine(fx22, 'rfa');
    if (q1) {
        const d = dangling('a');
        fs.writeFileSync(headLog(q1), lineOf(d.lost, d.base, 'reset: moving to HEAD~1'));
        fs.writeFileSync(branchLog('rfa'), lineOf(ZERO, d.base, 'branch: Created from main'));
        const ra = await reasonOf('rfa');
        check('11.22a 丢失提交只在 HEAD reflog 记录的旧值一侧（新值都被包含）：拒绝并列出该提交；worktree 与登记不变', ra.err && ra.err.code === 'LINE_REMOVE_REFUSED' && /reflog/.test(ra.err.message) && ra.err.message.includes(d.lost.slice(0, 10)) && fs.existsSync(q1.wt) && (await regOf(fx22)).lines.rfa.lifecycle === 'ready', ra.err && ra.err.message);
        const ra2 = await reasonOf('rfa', { discard: true });
        check('11.22a2 --discard 才能删', ra2.err === null && !fs.existsSync(q1.wt), ra2.err && ra2.err.message);
    }
    // b：丢失提交只在线分支 reflog 里（本 worktree 的 HEAD reflog 里没有）
    const q2 = await mkLine(fx22, 'rfb');
    if (q2) {
        const d = dangling('b');
        fs.writeFileSync(headLog(q2), lineOf(ZERO, d.base, 'checkout: moving from main to line/rfb'));
        fs.writeFileSync(branchLog('rfb'), lineOf(d.lost, d.base, 'update by push') + lineOf(d.base, d.base, 'noop'));
        const rb = await reasonOf('rfb');
        check('11.22b 丢失提交只在线分支自己的 reflog 里（HEAD reflog 没有）：拒绝并列出该提交', rb.err && rb.err.code === 'LINE_REMOVE_REFUSED' && /reflog/.test(rb.err.message) && rb.err.message.includes(d.lost.slice(0, 10)) && fs.existsSync(q2.wt), rb.err && rb.err.message);
        const rb2 = await reasonOf('rfb', { discard: true });
        check('11.22b2 --discard 才能删', rb2.err === null && !fs.existsSync(q2.wt), rb2.err && rb2.err.message);
    }
    // c：对照——reflog 里全是被集成分支包含的提交 → 正常删除（零值只当占位，不当对象）
    const q3 = await mkLine(fx22, 'rfc');
    if (q3) {
        const d = dangling('c');
        fs.writeFileSync(headLog(q3), lineOf(ZERO, d.base, 'checkout: moving'));
        fs.writeFileSync(branchLog('rfc'), lineOf(ZERO, d.base, 'branch: Created from main'));
        const rc = await reasonOf('rfc');
        check('11.22c 对照：reflog 两端都是被集成分支包含的提交（零值不当对象）：不加 --discard 正常删除', rc.err === null && !fs.existsSync(q3.wt), rc.err && rc.err.message);
    }
    // d：HEAD reflog 格式异常 / 不是普通文件、线分支 reflog 格式异常 → 无法核实，默认拒绝
    let rfIdx = 0;
    for (const [tag, setup] of [
        ['HEAD reflog 内容是垃圾', (c, n) => fs.writeFileSync(headLog(c), 'this is not a reflog\n')],
        ['HEAD reflog 新值长度与旧值不一致', (c, n) => fs.writeFileSync(headLog(c), `${ZERO} ${'a'.repeat(64)} ${IDENT}\tx\n`)],
        ['线分支 reflog 内容是垃圾', (c, n) => fs.writeFileSync(branchLog(n), 'garbage-line\n')],
        ['HEAD reflog 是个目录（读不了）', (c, n) => { fs.unlinkSync(headLog(c)); fs.mkdirSync(headLog(c)); }],
    ]) {
        rfIdx += 1;
        const name = `rfd${rfIdx}`;
        const q4 = await mkLine(fx22, name);
        if (q4) {
            setup(q4, name);
            const rd4 = await reasonOf(name);
            check(`11.22d ${tag}：无法核实 → 默认拒绝（消息说明无法读取 reflog）；worktree 在`, rd4.err && rd4.err.code === 'LINE_REMOVE_REFUSED' && /无法读取 reflog/.test(rd4.err.message) && fs.existsSync(q4.wt), rd4.err && rd4.err.message);
            if (tag.includes('目录')) removeTree(headLog(q4));
            const rd5 = await reasonOf(name, { discard: true });
            check(`11.22d2 ${tag}：--discard 才能删`, rd5.err === null && !fs.existsSync(q4.wt), rd5.err && rd5.err.message);
        }
    }
    check('11.22z 以上用例之后主工作区完好', mainIntact(fx22));

    // ---- 11.23 线分支是符号引用时不删（10-R2 H3）----
    const fx23 = await buildFixture('s11symref');
    const sy1 = await mkLine(fx23, 'sya');
    if (sy1) {
        git(fx23.main, ['symbolic-ref', 'refs/heads/line/sya', 'refs/heads/main']);   // 线分支被改成指向主工作区当前分支的符号引用
        const mainOid = git(fx23.main, ['rev-parse', 'refs/heads/main']).trim();
        const outS = [];
        const rS = await removeLine(fx23, 'sya', { discard: true }, {}, outS);
        check('11.23 线分支被改成指向主工作区当前分支的符号引用：线删除成功，但主工作区的分支 main 完好（仍指向原提交、HEAD 仍可解析），符号引用被保留并提示', rS.err === null && rS.res.branchKept === true && rS.res.branchDeleted === false && git(fx23.main, ['rev-parse', 'refs/heads/main']).trim() === mainOid
            && git(fx23.main, ['symbolic-ref', '--short', 'HEAD']).trim() === 'main' && git(fx23.main, ['symbolic-ref', 'refs/heads/line/sya']).trim() === 'refs/heads/main' && hasLine(outS, '符号引用'), rS.err && rS.err.message);
    }
    // 检查之后线分支才被换成符号引用（race）：update-ref 事务用 no-deref，对符号引用的 verify/delete 失败，不会解引用去删别的分支
    const sy2 = await mkLine(fx23, 'syb');
    if (sy2) {
        // 符号引用指向另一个与线分支同提交的分支 other23（不是集成分支：指向集成分支时，同一事务里的 verify 与解引用后的 delete 会因「同一引用多次更新」而整体失败，掩盖 no-deref 的作用）
        git(fx23.main, ['branch', 'other23', 'main']);
        const mainOid2 = git(fx23.main, ['rev-parse', 'refs/heads/main']).trim();
        const rS2 = await removeLine(fx23, 'syb', {}, { testHooks: { beforeBranchDelete: () => { git(fx23.main, ['symbolic-ref', 'refs/heads/line/syb', 'refs/heads/other23']); } } });
        // no-deref 下 git 对符号引用本身做 delete（删掉的是符号引用这个名字，不是目标）或整体失败，两种结局都可接受；不可接受的是解引用去删 other23 / main
        check('11.23b 检查之后线分支才被换成指向 other23 的符号引用：update-ref 事务不解引用——other23 与 main 分支完好（仍指向原提交，HEAD 仍可解析）；结局只能是整体失败（branch_delete）或只删掉符号引用本身', (rS2.err === null || rS2.err.step === 'branch_delete') && branchExists(fx23, 'other23') && git(fx23.main, ['rev-parse', 'refs/heads/other23']).trim() === mainOid2 && git(fx23.main, ['rev-parse', 'refs/heads/main']).trim() === mainOid2 && git(fx23.main, ['symbolic-ref', '--short', 'HEAD']).trim() === 'main' && branchExists(fx23, 'main'), rS2.err && rS2.err.message);
    }

    // ---- 11.24 脱敏器建立前两处固定文案（10-R2 M6）：公共目录名不符、转发目标缺失，不插入 commonDir / mainRoot ----
    const sep = path.join(os.tmpdir(), `行线 测试 ${process.pid}-sepgit`);
    ALL_ROOTS.push(sep);
    const sepWork = path.join(sep, '工作 树');
    const sepGit = path.join(sep, 'sepstore XQ库');
    fs.mkdirSync(path.join(sepWork, 'scripts', 'lines'), { recursive: true });
    git(sepWork, ['init', '-q', '-b', 'main', `--separate-git-dir=${sepGit}`]);
    fs.copyFileSync(path.join(LINES_DIR, 'line.js'), path.join(sepWork, 'scripts', 'lines', 'line.js'));
    const dSep = L.decideForward({ argv: ['new', 'x'], scriptRoot: sepWork });
    check('11.24 decideForward：git 公共目录名不是 .git（分离的 git 目录）：不转发，错误文案固定、不含公共目录路径', dSep.forward === false && dSep.reason === 'no-git' && typeof dSep.error === 'string' && dSep.error.length > 0 && !dSep.error.includes('XQ库') && !dSep.error.includes('行线 测试') && !dSep.error.includes(sepGit), dSep);
    const cSep = spawnSync(process.execPath, [path.join(sepWork, 'scripts', 'lines', 'line.js'), 'new', 'x', '--module', 'm', '--surface', 's'], { encoding: 'utf8', timeout: 60000, windowsHide: true });
    ALL_OUT.push(cSep.stdout || '', cSep.stderr || '');
    check('11.24b 进程级：同一场景退出码 1，stderr 是固定文案，不含公共目录路径', cSep.status === 1 && /不是名为 \.git 的主仓库目录/.test(cSep.stderr) && !cSep.stderr.includes('XQ库') && !cSep.stderr.includes('行线 测试'), { s: cSep.status, e: cSep.stderr });
    // 转发目标缺失：线检出里调用，主工作区没有 scripts/lines/line.js
    const fx24 = await buildFixture('s11nofwd', { noDb: true });
    const linked24 = path.join(fx24.lines, 'linked');
    git(fx24.main, ['worktree', 'add', '-q', '-b', 'linked-branch24', linked24, 'main']);
    fs.mkdirSync(path.join(linked24, 'scripts', 'lines'), { recursive: true });
    fs.copyFileSync(path.join(LINES_DIR, 'line.js'), path.join(linked24, 'scripts', 'lines', 'line.js'));
    const cNoFwd = spawnSync(process.execPath, [path.join(linked24, 'scripts', 'lines', 'line.js'), 'new', 'x', '--module', 'm', '--surface', 's'], { encoding: 'utf8', timeout: 60000, windowsHide: true });
    ALL_OUT.push(cNoFwd.stdout || '', cNoFwd.stderr || '');
    check('11.24c 转发目标缺失：退出码 1，stderr 说明无法转发，但固定文案不含主工作区路径', cNoFwd.status === 1 && /无法转发/.test(cNoFwd.stderr) && !cNoFwd.stderr.includes('主 工作区') && !cNoFwd.stderr.includes('行线 测试') && !cNoFwd.stderr.includes(fx24.main), { s: cNoFwd.status, e: cNoFwd.stderr });

    // ---- 11.25 步骤名撞名（预筛 L2）：line new 最后一步不叫 finalize，line remove 的放宽只认自己的步骤 ----
    const fx25 = await buildFixture('s11stepname');
    const origU = S.updateLine;
    let armed25 = false;
    S.updateLine = async function failOnce(...a) { if (armed25) { armed25 = false; throw new Error('注入：转 ready 的登记写入失败'); } return origU.apply(this, a); };
    let fz;
    try { fz = await newLine(fx25, 'fz', 'm-fz', {}, [], { testHooks: { afterStep: (s) => { if (s === 'final_verify') armed25 = true; } } }); } finally { S.updateLine = origU; }
    const stz = await regOf(fx25);
    check('11.25 line new 失败于最后一步：failed_step = ready_commit（不是 line remove 的 finalize），登记 failed', fz.err && fz.err.code === 'LINE_NEW_FAILED' && fz.err.step === 'ready_commit' && stz.lines.fz && stz.lines.fz.lifecycle === 'failed' && stz.lines.fz.failed_step === 'ready_commit', fz.err && fz.err.message);
    if (fz.err && fz.err.step === 'ready_commit') {
        const wz = wtOf(fx25, 'fz');
        fs.unlinkSync(path.join(wz, 'wbs-server', 'hello.txt'));   // 被跟踪文件被删（status 里是 ` D`）：放宽状态才会忽略它
        const rz = await removeLine(fx25, 'fz');
        check('11.25b 建线失败于最后一步后 line remove 不放宽：被跟踪文件被删仍算未提交改动 → 拒绝（消息列出 hello.txt），worktree 在', rz.err && rz.err.code === 'LINE_REMOVE_REFUSED' && /hello\.txt/.test(rz.err.message) && fs.existsSync(wz), rz.err && rz.err.message);
        const rz2 = await removeLine(fx25, 'fz', { discard: true });
        check('11.25c --discard 才能清理', rz2.err === null && !fs.existsSync(wz), rz2.err && rz2.err.message);
    }
    check('11.25d RELAXED_STEPS 只含 line remove 自己的步骤名，且 line new 的步骤名集合里没有 finalize（手写期望）', same(R.RELAXED_STEPS.slice().sort(), ['admin_delete', 'branch_delete', 'finalize', 'main_node_modules_check', 'tree_delete']));

    // ---- 11.27 删分支前独立核线分支自己的 reflog（修复批 3，47R3c H1）----
    //   场景：人工删了 worktree 目录和管理目录（再 git worktree prune），线分支尖端已合入集成分支（尖端 = main），但线分支自己的 reflog 里有只在那里的提交：
    //   第 3 步（只在 worktree / 管理目录还在时才跑）不会拒绝，旧版第 8 步只看尖端 → 分支连 reflog 一起被删，游离提交丢失。
    const fx27 = await buildFixture('s11h1');
    const dangling27 = (tag) => {
        const tree = git(fx27.main, ['rev-parse', 'refs/heads/main^{tree}']).trim();
        const base = git(fx27.main, ['rev-parse', 'refs/heads/main']).trim();
        return { base, lost: git(fx27.main, ['commit-tree', tree, '-p', base, '-m', `lost-${tag}`]).trim() };
    };
    const blog27 = (name) => path.join(fx27.main, '.git', 'logs', 'refs', 'heads', 'line', name);
    const bothGone27 = async (name) => {   // 建线 → 人手删 worktree 目录与管理目录 → git worktree prune（夹具搭建，不入被测记录）
        const q = await mkLine(fx27, name);
        if (!q) return null;
        const left = removeTree(q.wt).concat(removeTree(q.admin));
        git(fx27.main, ['worktree', 'prune']);
        check(`11.27.0 ${name} 前置：worktree 目录与管理目录都已不在，git worktree 登记已清，分支还在、尖端 = main`, left.length === 0 && !fs.existsSync(q.wt) && !fs.existsSync(q.admin) && branchExists(fx27, `line/${name}`)
            && git(fx27.main, ['rev-parse', `refs/heads/line/${name}`]).trim() === git(fx27.main, ['rev-parse', 'refs/heads/main']).trim(), left);
        return q;
    };
    const stray27 = (d) => lineOf(ZERO, d.base, 'branch: Created from main') + lineOf(d.lost, d.base, 'update by push');
    const ha = await bothGone27('h1a');
    if (ha) {
        const da = dangling27('a');
        fs.writeFileSync(blog27('h1a'), stray27(da));
        const regBeforeA = (await regOf(fx27)).lines.h1a;
        const outA = [];
        const rA = await removeLine(fx27, 'h1a', {}, {}, outA);
        // 修复批 3b（MED-1，主会话裁定改为拒绝）：第 3 步没跑的路径，在第 4 步之前就独立核线分支 reflog，命中且无 --discard → LINE_REMOVE_REFUSED：登记表不变、什么都没删，用户加 --discard 重跑
        check('11.27a 线分支 reflog 里有游离提交、worktree 与管理目录都不在、不带 --discard：第 4 步之前就拒绝（LINE_REMOVE_REFUSED），消息列出该提交与「加 --discard」；登记原样（lifecycle 仍 ready、代次不变）、分支保留、游离提交没丢',
            rA.err && rA.err.code === 'LINE_REMOVE_REFUSED' && rA.err.message.includes(da.lost.slice(0, 10)) && /--discard/.test(rA.err.message) && same((await regOf(fx27)).lines.h1a, regBeforeA) && regBeforeA.lifecycle === 'ready'
            && branchExists(fx27, 'line/h1a') && git(fx27.main, ['cat-file', '-t', da.lost]).trim() === 'commit', rA.err && rA.err.message);
        const cmdsA = String(rA.err ? rA.err.message : '').split(/\r?\n/).map((l) => l.trim()).filter((l) => /^git (reflog|branch|update-ref) /.test(l));
        check('11.27a2 拒绝消息里的命令行（git reflog show …）单独成行、不含中文（提示与命令分行）', same(cmdsA, ['git reflog show refs/heads/line/h1a']), cmdsA);
        const outA2 = [];
        const rA2 = await removeLine(fx27, 'h1a', { discard: true }, {}, outA2);
        check('11.27a3 用户按提示加 --discard 重跑：删除成功（分支删掉、登记清掉），输出列出丢弃的游离提交', rA2.err === null && rA2.res.branchDeleted === true && !branchExists(fx27, 'line/h1a') && hasLine(outA2, '【--discard】') && hasLine(outA2, da.lost.slice(0, 10)) && !(await regOf(fx27)).lines.h1a, rA2.err && rA2.err.message);
    }
    // f：第 8 步的独立核对保留作为最后一道。3b 通过（那时 reflog 干净）、删除进行中 reflog 才出现游离提交——用 afterWorktreeRemove 钩子在两者之间写入，只能由第 8 步拦住
    const hf = await bothGone27('h1f');
    if (hf) {
        const df = dangling27('f');
        const outF = [];
        const rF = await removeLine(fx27, 'h1f', {}, { testHooks: { afterWorktreeRemove: async () => { fs.writeFileSync(blog27('h1f'), stray27(df)); } } }, outF);
        const cmdsF = outF.filter((l) => /^\s*git (reflog|branch|update-ref) /.test(l));
        check('11.27f 最后一道（第 8 步）：第 3b 步放行后 reflog 才出现游离提交、不带 --discard → 分支保留（result.branchKept）、游离提交没丢、线登记清掉；输出列出该提交与人工命令（3 条，单独成行、不含中文）',
            rF.err === null && rF.res.branchKept === true && rF.res.branchDeleted === false && branchExists(fx27, 'line/h1f') && git(fx27.main, ['cat-file', '-t', df.lost]).trim() === 'commit'
            && hasLine(outF, df.lost.slice(0, 10)) && cmdsF.length === 3 && cmdsF.every((l) => !/[　-〿一-鿿＀-￯]/.test(l)) && hasLine(outF, `git update-ref -d refs/heads/line/h1f`) && hasLine(outF, 'git reflog show refs/heads/line/h1f') && !(await regOf(fx27)).lines.h1f, rF.err && rF.err.message);
    }
    const hb = await bothGone27('h1b');
    if (hb) {
        const db = dangling27('b');
        fs.writeFileSync(blog27('h1b'), stray27(db));
        const outB = [];
        const rB = await removeLine(fx27, 'h1b', { discard: true }, {}, outB);
        check('11.27b 同样的场景带 --discard：分支照旧删除，输出列出丢弃的游离提交', rB.err === null && rB.res.branchDeleted === true && !branchExists(fx27, 'line/h1b') && hasLine(outB, '【--discard】') && hasLine(outB, db.lost.slice(0, 10)), rB.err && rB.err.message);
    }
    const hc = await bothGone27('h1c');
    if (hc) {
        const dc = dangling27('c');
        fs.writeFileSync(blog27('h1c'), lineOf(ZERO, dc.base, 'branch: Created from main') + lineOf(dc.base, dc.base, 'noop'));
        const rC = await removeLine(fx27, 'h1c');
        check('11.27c 对照：线分支 reflog 里全是被集成分支包含的提交 → 照常删除分支（不需要 --discard）', rC.err === null && rC.res.branchDeleted === true && rC.res.branchKept === false && !branchExists(fx27, 'line/h1c'), rC.err && rC.err.message);
    }
    // d：线分支 reflog 读不了 / 格式异常（垃圾内容、是目录、新旧对象长度不一致）→ 无法核实，保留；--discard 才删
    let h1i = 0;
    for (const [tag, setup, cleanup] of [
        ['内容是垃圾', (n) => fs.writeFileSync(blog27(n), 'garbage-line\n'), null],
        ['新旧对象长度不一致', (n) => fs.writeFileSync(blog27(n), `${ZERO} ${'a'.repeat(64)} ${IDENT}\tx\n`), null],
        ['是个目录', (n) => { fs.unlinkSync(blog27(n)); fs.mkdirSync(blog27(n)); }, (n) => removeTree(blog27(n))],
    ]) {
        h1i += 1;
        const nm = `h1d${h1i}`;
        const hd = await bothGone27(nm);
        if (!hd) continue;
        setup(nm);
        const regBeforeD = (await regOf(fx27)).lines[nm];
        const outD = [];
        const rD = await removeLine(fx27, nm, {}, {}, outD);
        check(`11.27d ${tag}：线分支 reflog 读不了 → 第 4 步之前拒绝（LINE_REMOVE_REFUSED，说明无法核实、提示加 --discard），登记原样、分支保留`,
            rD.err && rD.err.code === 'LINE_REMOVE_REFUSED' && /读不了或格式异常/.test(rD.err.message) && /--discard/.test(rD.err.message) && same((await regOf(fx27)).lines[nm], regBeforeD) && branchExists(fx27, `line/${nm}`), rD.err && rD.err.message);
        // 同一条线（登记还在）加 --discard 重跑才删分支
        const rD2 = await removeLine(fx27, nm, { discard: true });
        if (cleanup) cleanup(nm);
        check(`11.27d2 ${tag}：同一条线带 --discard 重跑 → 删分支、清登记`, rD2.err === null && rD2.res.branchDeleted === true && !branchExists(fx27, `line/${nm}`) && !(await regOf(fx27)).lines[nm], rD2.err && rD2.err.message);
    }
    // e：worktree 目录已不在但管理目录还在（第 3 步照旧跑）+ 线分支 reflog 有游离提交 → 第 3 步拒绝（行为不变），分支与登记都在
    const he = await mkLine(fx27, 'h1e');
    if (he) {
        const de = dangling27('e');
        fs.writeFileSync(blog27('h1e'), stray27(de));
        removeTree(he.wt);
        const rE = await removeLine(fx27, 'h1e');
        check('11.27e worktree 目录不在但管理目录在：第 3 步照旧拒绝（行为不变），线登记与分支都保留', rE.err && rE.err.code === 'LINE_REMOVE_REFUSED' && /reflog/.test(rE.err.message) && rE.err.message.includes(de.lost.slice(0, 10)) && branchExists(fx27, 'line/h1e') && !!(await regOf(fx27)).lines.h1e, rE.err && rE.err.message);
    }
    // g：失败于 admin_delete 之后不带 --discard 重试（第 3 步在这条路径上不跑）→ 3b 拒绝，登记 / 管理目录 / 分支都在；首次带了 --discard 的，重试也要带——带上则完成
    const hg = await mkLine(fx27, 'h1g');
    if (hg) {
        const dg = dangling27('g');
        fs.writeFileSync(blog27('h1g'), stray27(dg));
        const origDel = C.deleteAdminDir;
        C.deleteAdminDir = () => { throw new Error('注入：管理目录删除失败'); };
        let r1g;
        try { r1g = await removeLine(fx27, 'h1g', { discard: true }); } finally { C.deleteAdminDir = origDel; }
        const regG = (await regOf(fx27)).lines.h1g;
        check('11.27g.0 前置：首次带 --discard 删线失败于 admin_delete（worktree 内容已删、管理目录与分支还在），登记 failed / admin_delete', r1g.err && r1g.err.code === 'LINE_REMOVE_FAILED' && r1g.err.step === 'admin_delete' && regG && regG.lifecycle === 'failed' && regG.failed_step === 'admin_delete' && !fs.existsSync(hg.wt) && fs.existsSync(hg.admin) && branchExists(fx27, 'line/h1g'), r1g.err && r1g.err.message);
        check('11.27g.1 失败消息的重试提示：首次带了 --discard 的，重试也要带', r1g.err && /首次带了 --discard 的，重试也要带 --discard/.test(r1g.err.message) && !/不需要 --discard/.test(r1g.err.message), r1g.err && r1g.err.message);
        const rGn = await removeLine(fx27, 'h1g');
        check('11.27g admin_delete 失败后不带 --discard 重试：第 3 步不跑，第 3b 步拒绝（LINE_REMOVE_REFUSED，列出游离提交）；登记仍是 failed / admin_delete（代次不变），管理目录与分支都还在',
            rGn.err && rGn.err.code === 'LINE_REMOVE_REFUSED' && rGn.err.message.includes(dg.lost.slice(0, 10)) && same((await regOf(fx27)).lines.h1g, regG) && fs.existsSync(hg.admin) && branchExists(fx27, 'line/h1g'), rGn.err && rGn.err.message);
        const rGd = await removeLine(fx27, 'h1g', { discard: true });
        check('11.27g2 带 --discard 重试：成功（管理目录逐项删除、分支删除、登记清掉）', rGd.err === null && !fs.existsSync(hg.admin) && !branchExists(fx27, 'line/h1g') && !(await regOf(fx27)).lines.h1g, rGd.err && rGd.err.message);
    }
    // r：真实 rebase 产生的 reflog（不用手写 reflog）——线上提交一次、main 前进、线 rebase 到 main（旧提交只剩在 reflog 里）、main 快进到 rebase 后的尖端（尖端已合入）、人工删 worktree 与管理目录
    const hr = await mkLine(fx27, 'h1r');
    if (hr) {
        commitIn(fx27, 'h1r', 'feat-r.txt', 'r1');
        const c1 = git(fx27.main, ['rev-parse', 'refs/heads/line/h1r']).trim();
        w(path.join(fx27.main, 'main-adv.txt'), 'adv\n');
        git(fx27.main, ['add', 'main-adv.txt']);
        git(fx27.main, ['commit', '-q', '-m', 'main advance']);
        git(wtOf(fx27, 'h1r'), ['rebase', 'main']);
        const c1p = git(fx27.main, ['rev-parse', 'refs/heads/line/h1r']).trim();
        git(fx27.main, ['merge', '-q', '--ff-only', 'line/h1r']);
        const left = removeTree(hr.wt).concat(removeTree(hr.admin));
        git(fx27.main, ['worktree', 'prune']);
        let c1InMain = true;
        try { git(fx27.main, ['merge-base', '--is-ancestor', c1, 'main']); } catch (_) { c1InMain = false; }
        const logText = fs.existsSync(blog27('h1r')) ? rd(blog27('h1r')) : '';
        check('11.27r.0 前置（真实 rebase 的现场）：rebase 改写了提交（旧提交 ≠ 新尖端）、旧提交不在 main 里、新尖端 = main、线分支真实 reflog 里有旧提交；worktree 与管理目录都已不在', c1 !== c1p && !c1InMain && git(fx27.main, ['rev-parse', 'refs/heads/main']).trim() === c1p && logText.includes(c1) && left.length === 0 && !fs.existsSync(hr.wt) && !fs.existsSync(hr.admin), { c1, c1p, left });
        const regR = (await regOf(fx27)).lines.h1r;
        const rR = await removeLine(fx27, 'h1r');
        check('11.27r 真实 rebase 产生的 reflog：尖端已合入但 reflog 里有 rebase 前的旧提交 → 拒绝（LINE_REMOVE_REFUSED，列出旧提交），登记与分支原样、旧提交没丢',
            rR.err && rR.err.code === 'LINE_REMOVE_REFUSED' && rR.err.message.includes(c1.slice(0, 10)) && same((await regOf(fx27)).lines.h1r, regR) && branchExists(fx27, 'line/h1r') && git(fx27.main, ['cat-file', '-t', c1]).trim() === 'commit', rR.err && rR.err.message);
        const rR2 = await removeLine(fx27, 'h1r', { discard: true });
        check('11.27r2 带 --discard 才删', rR2.err === null && rR2.res.branchDeleted === true && !branchExists(fx27, 'line/h1r') && !(await regOf(fx27)).lines.h1r, rR2.err && rR2.err.message);
    }
    check('11.27z 以上用例之后主工作区完好', mainIntact(fx27));

    // ---- 11.28 owner_record 失败提示（修复批 3b，预筛 HIGH-1；放在节 11 里让 --only=11 的变异自证也覆盖）----
    //   场景：worktree 里有被忽略的联接（node_modules 两处 + 一个悬空联接 + 名字带单引号的联接），其中一个目标里再嵌一个联接。
    //   U14 = A：旧提示生成拆联接 / 复核 / git worktree remove / git branch -d / line remove 命令（codex 两轮 HIGH），现在整个删掉；
    //   新消息只是只读现场清单：最外层联接的路径与类型（不附命令）、两条不含路径的 reflog 只读命令、reflog 文件位置、指向 CLAUDE.md 小节。
    //   清理由在场人员按 CLAUDE.md「建线中断（owner_record 失败）的现场处理」做——本测试里由测试代码自己做（命令不取自消息）。分工如实：
    //   11.28e–i 只跑其中第 2–5 步（.NET 非递归拆联接 → 复核 → git worktree remove 不带强制 → git branch -d → line remove）；复核用 scanTree，另在 11.28e3 / 11.28f2 补 PowerShell Test-Path；
    //   第 1 步（救援提交：读两个 reflog 文件 → 收到的每个提交号都建 rescue 分支）与 1–5 步全流程在 11.28m / 11.28m2 / 11.28n（那个场景里有只存在于 reflog 的提交）；
    //   第 3 步的规则命令（status --ignored --untracked-files=all：见 `?? ` 即停、路径含 node_modules 即停、`!! ` 先备份）在 11.28m2c / n4 / p / p2；目录已不在的变体（只清本线登记、不用 prune）在 11.28q；node_modules 绊线在 11.28r。
    {
        const fx28 = await buildFixture('s11ownerrec');
        const ext1 = path.join(fx28.root, '外部 目标1');
        const ext2 = path.join(fx28.root, '外部 目标2');
        const extIn = path.join(fx28.root, '嵌套 目标');
        for (const d of [ext1, ext2, extIn]) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, '哨兵.txt'), `SENT-${path.basename(d)}`); }
        fs.symlinkSync(extIn, path.join(ext1, '嵌套联接'), 'junction');   // 目标里再嵌一个联接：只应列最外层，不列它
        const wt28 = wtOf(fx28, 'or');
        const linkA = path.join(wt28, 'node_modules');
        const linkB = path.join(wt28, 'wbs-server', 'node_modules');
        const linkC = path.join(wt28, 'dangling-link');
        const linkD = path.join(wt28, "it's link");
        const origW = C.writeOwnerRecord;
        C.writeOwnerRecord = () => { throw new Error('注入：控制根归属记录写入失败'); };
        let r28;
        try {
            r28 = await newLine(fx28, 'or', 'm-or', {}, [], { testHooks: { afterStep: async (s) => {
                if (s !== 'worktree') return;
                fs.symlinkSync(ext1, linkA, 'junction');
                fs.symlinkSync(ext2, linkB, 'junction');
                fs.symlinkSync(path.join(fx28.root, '不存在 目标'), linkC, 'junction');
                fs.symlinkSync(extIn, linkD, 'junction');
            } } });
        } finally { C.writeOwnerRecord = origW; }
        const msg28 = r28.err ? r28.err.message : '';
        const wtReal28 = fs.existsSync(wt28) ? fs.realpathSync.native(wt28) : wt28;
        const rA = path.join(wtReal28, 'node_modules');
        const rB = path.join(wtReal28, 'wbs-server', 'node_modules');
        const rC = path.join(wtReal28, 'dangling-link');
        const rD = path.join(wtReal28, "it's link");
        const listing28 = linkListingOf(msg28);
        const wantListing = sorted([`${rA}（目录型）`, `${rB}（目录型）`, `${rC}（目标读不到）`, `${rD}（目录型）`]);
        const known28 = [wtReal28, rA, rB, rC, rD];   // 剥离用的已知完整路径：worktree 真实路径 + 4 个最外层联接（worktree / 管理目录 / reflog 文件路径由 sitePathsOf 从文件系统算）
        const sh28 = siteListShape(msg28, wt28, 'line/or', fx28, known28);
        check('11.28a owner_record 失败（worktree 里有 4 个最外层联接，其一的目标里还嵌着联接）：清单里恰好列出最外层 4 个联接的路径与类型（悬空的写「目标读不到」；名字带单引号的路径原样），有「最外层联接 / 符号链接 4 个」；不列嵌套的那个；不说「没有发现联接」',
            r28.err && r28.err.step === 'owner_record' && same(sorted(listing28), wantListing) && !msg28.includes('嵌套联接') && /最外层联接 \/ 符号链接 4 个：/.test(msg28) && !/没有发现联接/.test(msg28), { listing28, wantListing });
        const adminId28 = fs.readdirSync(path.join(fx28.main, '.git', 'worktrees'));
        const adminReal28 = adminId28.length === 1 ? fs.realpathSync.native(path.join(fx28.main, '.git', 'worktrees', adminId28[0])) : null;
        const adminLog28 = adminReal28 ? path.join(adminReal28, 'logs', 'HEAD') : null;
        const branchLog28 = path.join(fx28.main, '.git', 'logs', 'refs', 'heads', 'line', 'or');
        const ls28 = msgLinesOf(msg28);
        check(`11.28b 清单里没有任何命令行：仅有的命令行是两条 reflog 只读命令（逐字 git reflog show --date=iso refs/heads/line/or / git reflog show --date=iso HEAD，不含路径）；剥离已知路径（夹具根 / worktree / 4 个联接路径）与这两条命令行之后：禁用片段表 ${MUTATING_PATTERNS.length} 条无一命中、无 git <子命令>、无白名单外 ASCII 词（只判 ASCII 命令形态，中文指令不在判据内）；位置三行、原样保留 / 不回滚 / 只会清登记、指向 CLAUDE.md 小节、最后一行是说明句`,
            sh28.loc && sh28.keep && sh28.header && sh28.reflogCmds && sh28.onlyReflogCmds && sh28.onsite && sh28.clean && sh28.note, { sh28, cmdish: cmdishLinesOf(msg28) });
        check('11.28c 列出 reflog 文件位置：管理目录 logs/HEAD 与线分支 reflog 文件（纯路径、非命令），两个文件真实存在', adminLog28 !== null && ls28.includes(adminLog28) && ls28.includes(branchLog28) && fs.existsSync(adminLog28) && fs.existsSync(branchLog28), { adminLog28, branchLog28, ls28 });
        const stillLinks = [linkA, linkB, linkC, linkD, path.join(ext1, '嵌套联接')].every(isLink);
        const stillTargets = [ext1, ext2, extIn].every((d) => rd(path.join(d, '哨兵.txt')) === `SENT-${path.basename(d)}`);
        check('11.28d 失败之后现场完好（工具什么都没删）：worktree 目录在、4 个联接与嵌套联接都在、三个目标里的哨兵文件原样、线分支在、两个 reflog 文件在', stillLinks && stillTargets && fs.existsSync(path.join(wt28, '.git')) && branchExists(fx28, 'line/or') && adminLog28 !== null && fs.existsSync(adminLog28) && fs.existsSync(branchLog28), { stillLinks, stillTargets });
        // ---- 11.28w 守卫的守卫（M2）：现场清单「不含改动类写法」的判据本身要有判别力 ----
        //   取上面这条真实消息（11.28a–d 已证明它形状正确且判干净），逐条插入 9 个旧判据漏判过的句中 / 行内命令变体，各自单独插入；
        //   每个变体两种插法：独立一行（紧跟「现场清单」标题）、句中（插进「现场原样保留…」那句里）。断言：clean 判红，其余形状字段不受影响（红只来自这一道判据），
        //   且三层各自独立判红（层 A 片段表、层 C 白名单词对 9 个变体全红；层 B git 子命令对 5 个 git 变体全红）——任何一层被注掉，对应用例判红。
        //   再插入合法干扰：路径段含 `del` / `reset`（`Juan del Rio\reset-lines`）的夹具根 / worktree 路径，剥离集合含它 → 仍判绿；对照：同一条消息不把它加入剥离集合 → 判红（证明绿来自剥离、LOW-6 误报确实存在）。
        {
            const OID = '0123456789abcdef0123456789abcdef01234567';
            const HEADER_LINE = '现场清单（只读，供在场人员核对）：';
            const SENT_JOIN = '）；交在场人员按';
            const VARIANTS = [   // [名, 内容, 是否 git 子命令, 手写期望：层 A 应命中的片段名（整份集合，不是子集）]
                ['update-ref', `确认不要时人工执行：git update-ref -d refs/heads/line/or ${OID}`, true, ['update-ref']],
                ['worktree-remove', '拆 worktree：git -C X worktree remove X', true, ['git -C / -c', 'worktree remove / prune']],
                ['clean', '清理时执行：git clean -fdx', true, ['clean']],
                ['reflog-expire', '然后执行 git reflog expire --expire=now --all', true, ['reflog expire']],
                ['symbolic-ref', '然后 git symbolic-ref --delete refs/heads/x', true, ['symbolic-ref']],
                ['Move-Item', 'Move-Item a b', false, ['-Item']],
                ['ri', 'ri X', false, ['ri/rd/erase']],
                ['erase', 'erase X', false, ['ri/rd/erase']],
                ['fsutil', 'fsutil reparsepoint delete X', false, ['fsutil']],
            ];
            const asLine = (m, v) => m.replace(HEADER_LINE, `${HEADER_LINE}\n  ${v}`);
            const inSentence = (m, v) => m.replace(SENT_JOIN, `）；${v}；交在场人员按`);
            const optsW = siteOpts(fx28, wt28, 'line/or', known28);
            const shapeOk = (s) => s.loc && s.keep && s.header && s.reflogCmds && s.onsite && s.note;   // 红只许来自 clean / onlyReflogCmds
            const base = siteListShape(msg28, wt28, 'line/or', fx28, known28);
            check('11.28w0 基线：真实消息过全部形状与三层判据；插入点（标题行 / 「）；交在场人员按」）各恰好出现一次，插入确实改了消息', base.clean && base.hits.length === 0 && shapeOk(base) && base.onlyReflogCmds
                && msg28.split(HEADER_LINE).length === 2 && msg28.split(SENT_JOIN).length === 2 && asLine(msg28, 'x') !== msg28 && inSentence(msg28, 'x') !== msg28, base);
            // 11.28w0b 层 D 的基线：真实消息剥离后，剩余文本里除字母数字 / 空白外的 ASCII 字符恰好是 `.`（CLAUDE.md）、`/`（「联接 / 符号链接」）、`_`（owner_record），没有任何 D 符号——层 D 不会误报
            const baseRes = residueOf(msg28, optsW);
            const baseSyms = [...new Set((baseRes.match(/[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/g) || []))].sort();
            check('11.28w0b 基线：真实消息剥离后剩余文本的 ASCII 标点集合恰为 . / _（无任何 > < | & ; $ 反引号），层 D 无命中', same(baseSyms, ['.', '/', '_']) && symbolsIn(baseRes).length === 0, { baseSyms });
            VARIANTS.forEach(([vn, vtext, isGit, wantA], i) => {
                for (const [form, ins] of [['行', asLine], ['句', inSentence]]) {
                    const mm = ins(msg28, vtext);
                    const sh = siteListShape(mm, wt28, 'line/or', fx28, known28);
                    const res = residueOf(mm, optsW);
                    const ly = layersOfHits(sh.hits);   // 接线断言：直接看 mutatingHits 的输出（sh.hits）里有没有各层标签，不是只调层函数；从 mutatingHits 删任何一层的 push 都会让这里判红
                    check(`11.28w${i + 1}${form} 变体「${vn}」（${vtext}）${form === '行' ? '单独一行' : '句中'}插入：clean 判红且其余形状字段不变；层函数各自独立判红（层 A 片段表、层 C 白名单词${isGit ? '、层 B git 子命令' : ''}）；mutatingHits 输出（hits）里层 A 片段名恰为手写期望 ${JSON.stringify(wantA)}、层 C ${isGit ? '、层 B ' : ''}标签在、${isGit ? '' : '层 B 标签不在、'}层 D 标签不在（汇总接线）`,
                        mm !== msg28 && sh.clean === false && shapeOk(sh) && fragHitsIn(res).length > 0 && strayWordsIn(res).length > 0 && (!isGit || gitHitsIn(res).length > 0) && (isGit || gitHitsIn(res).length === 0)
                        && same(sorted(ly.a), sorted(wantA)) && ly.b === isGit && ly.c === true && ly.d === false,
                        { form, hits: sh.hits, frag: fragHitsIn(res), stray: strayWordsIn(res), git: gitHitsIn(res), ly });
                }
            });
            // ---- 层 D（重定向 / 拼接符号）变体：独立一行 / 句中各插一次。没有任何 ASCII 词的写法（`'' > '<路径>'`）层 A–C 都抓不到，只有层 D 能抓 ----
            const BRANCH_LOG_P = path.join(fx28.main, '.git', 'logs', 'refs', 'heads', 'line', 'or');   // 线分支 reflog 文件路径（已在剥离集合里，消息里本来就有这一行）
            const D_VARIANTS = [   // [名, 内容, 层 C 是否也该命中（含 ASCII 词）]
                ['redirect-reflog', `'' > '${BRANCH_LOG_P}'`, false],
                ['redirect-worktree', `> "${wtReal28}"`, false],
                ['pipe', 'x | y', true],
                ['semicolon', 'x; y', true],
                ['ampersand', 'x & y', true],
                ['backtick', '`x`', true],
                ['dollar', '$X', true],
                ['append-redirect', '>> x', true],
                ['input-redirect', '< x', true],
            ];
            D_VARIANTS.forEach(([vn, vtext, cToo], i) => {
                for (const [form, ins] of [['行', asLine], ['句', inSentence]]) {
                    const mm = ins(msg28, vtext);
                    const sh = siteListShape(mm, wt28, 'line/or', fx28, known28);
                    const res = residueOf(mm, optsW);
                    const ly = layersOfHits(sh.hits);
                    check(`11.28w12.${i + 1}${form} 层 D 变体「${vn}」（${vtext}）${form === '行' ? '单独一行' : '句中'}插入：clean 判红且其余形状字段不变；剥离后剩余文本含 ASCII 重定向 / 拼接符号；mutatingHits 输出里层 D 标签在、层 A / B 标签不在、层 C 标签${cToo ? '在（含 ASCII 词）' : '不在（没有任何 ASCII 词，只有层 D 抓得到）'}`,
                        mm !== msg28 && sh.clean === false && shapeOk(sh) && symbolsIn(res).length > 0 && ly.d === true && ly.a.length === 0 && ly.b === false && ly.c === cToo,
                        { form, hits: sh.hits, sym: symbolsIn(res), ly });
                }
            });
            // ---- 单层判红：每个变体只被一层抓到（hits 恰好一个标签）。从 mutatingHits 删掉对应层的 push，这里必有一个判红 ----
            const SINGLE = [   // [层名, 内容, 期望标签判定]
                ['A', '::', (h) => h.length === 1 && PATTERN_NAMES.has(h[0])],
                ['B', 'git reflog HEAD', (h) => h.length === 1 && h[0] === LABEL_B],   // git 子命令不在片段表里、ASCII 词 git / reflog / HEAD 全在白名单里；它本身是只读命令，但清单只许出现那两条逐字命令行，多一条 git 调用就判红
                ['C', 'mklink /J a b', (h) => h.length === 1 && h[0].startsWith(LABEL_C)],
                ['D', `'' > '${BRANCH_LOG_P}'`, (h) => h.length === 1 && h[0].startsWith(LABEL_D)],
            ];
            for (const [lay, stext, okFn] of SINGLE) {
                for (const [form, ins] of [['行', asLine], ['句', inSentence]]) {
                    const mm = ins(msg28, stext);
                    const sh = siteListShape(mm, wt28, 'line/or', fx28, known28);
                    check(`11.28w13${lay}${form} 单层变体「${stext}」${form === '行' ? '单独一行' : '句中'}插入：只有层 ${lay} 抓得到（mutatingHits 输出恰好一个标签且是层 ${lay} 的），clean 判红，其余形状字段不变`,
                        mm !== msg28 && sh.clean === false && shapeOk(sh) && okFn(sh.hits), { form, hits: sh.hits });
                }
            }
            // ---- L1：线名固定短语只剥正文原话，句中另插的 `line remove <名>` 必须留给判据（旧版全局剥离会把它吞掉，整体判绿）----
            for (const [form, ins] of [['行', asLine], ['句', inSentence]]) {
                const lt = '清理时先执行 line remove or';
                const mm = ins(msg28, lt);
                const sh = siteListShape(mm, wt28, 'line/or', fx28, known28);
                const res = residueOf(mm, optsW);
                const ly = layersOfHits(sh.hits);
                check(`11.28w14${form} L1 变体「${lt}」${form === '行' ? '单独一行' : '句中'}插入：剥离后剩余文本仍含 line remove or（只剥了正文原话那两处）；clean 判红，层 C 标签在，其余形状字段不变`,
                    mm !== msg28 && /line remove or/.test(res) && sh.clean === false && shapeOk(sh) && ly.c === true, { form, hits: sh.hits });
            }
            // 正文原话两处（「之后 line remove <名> 只会清登记」与尾句「line remove 因归属无法证明」）真实消息里各恰好一处，剥离后都不剩（基线 clean 已证明；这里再证明它们确实存在，免得剥离式变成空操作）
            check('11.28w14c 基线里正文原话两处各恰好出现一次（「之后 line remove or 只会清登记」「；line remove 因归属无法证明只清登记」），剥离后剩余文本里没有 line remove',
                msg28.split('之后 line remove or 只会清登记').length === 2 && msg28.split('；line remove 因归属无法证明只清登记').length === 2 && !/line remove/.test(residueOf(msg28, optsW)), { hasA: msg28.includes('之后 line remove or 只会清登记'), hasB: msg28.includes('；line remove 因归属无法证明只清登记') });
            const JDR = 'Juan del Rio';
            const wtNew = path.join('C:\\Users', JDR, 'reset-lines', 'or');
            const mainNew = path.join('D:\\work', JDR, 'reset-lines', '主 工作区');
            const swap = (m, pairs) => pairs.reduce((acc, [from, to]) => (from ? acc.split(from).join(to) : acc), m);
            const wtPairs = [...new Set([wtReal28, wt28])].sort((a, b) => b.length - a.length).map((p) => [p, wtNew]);
            const mainPairs = [...new Set([realOrSelf(fx28.main), fx28.main])].sort((a, b) => b.length - a.length).map((p) => [p, mainNew]);
            // 消息里的路径前缀整体换成含 del / reset 的路径；剥离清单经 mapPath 同步换（= 把这些路径加入剥离集合）
            const mapW = (p) => swap(p, wtPairs);
            const mapM = (p) => swap(p, mainPairs);
            const mapWM = (p) => mapM(mapW(p));
            const dist = [
                ['w10a worktree 路径段含 del / reset', swap(msg28, wtPairs), wtNew, mapW],
                ['w10b 主工作区路径段含 del / reset（reflog 文件、管理目录两处）', swap(msg28, mainPairs), wt28, mapM],
                ['w10c 两处都含', swap(swap(msg28, wtPairs), mainPairs), wtNew, mapWM],
            ];
            for (const [dn, dm, dwt, dmap] of dist) {
                const sh = siteListShape(dm, dwt, 'line/or', fx28, known28, dmap);
                check(`11.28${dn}：路径加入剥离集合后仍判绿（全部形状 + 三层判据）；消息里确实出现了 ${JDR} 与 reset-lines`, dm !== msg28 && dm.includes(JDR) && dm.includes('reset-lines') && sh.clean && sh.hits.length === 0 && shapeOk(sh) && sh.onlyReflogCmds, sh);
            }
            const ctl = siteListShape(dist[0][1], wt28, 'line/or', fx28, known28);   // 不做映射：剥离清单仍是旧路径，消息里是新路径（只看 hits / clean，不看 loc）
            const ctlRes = residueOf(dist[0][1], siteOpts(fx28, wt28, 'line/or', known28));
            check('11.28w11 对照：同一条消息不把含 del / reset 的路径加入剥离集合 → 判红（片段表 del / reset 与白名单词都命中，LOW-6 的误报确实存在，绿来自剥离）', ctl.clean === false && fragHitsIn(ctlRes).includes('del ') && fragHitsIn(ctlRes).includes('reset') && strayWordsIn(ctlRes).includes('Juan'), { hits: ctl.hits });
        }
        // ---- 以下由测试代码自己做 CLAUDE.md 第 2–5 步（命令不取自消息）：先读 reflog，再非递归拆联接，scanTree 复核为零，git worktree remove（不带强制选项），git branch -d，line remove；第 1 步救援见 11.28m2 ----
        const rlBranch = spawnSync('git', ['reflog', 'show', '--date=iso', 'refs/heads/line/or'], { cwd: fx28.main, encoding: 'utf8', windowsHide: true, timeout: 60000 });
        const rlHead = spawnSync('git', ['reflog', 'show', '--date=iso', 'HEAD'], { cwd: wt28, encoding: 'utf8', windowsHide: true, timeout: 60000 });
        check('11.28e 先读 reflog（证明可查）：主工作区里的线分支 reflog 与 worktree 里的 HEAD reflog 都退出码 0 且有内容', rlBranch.status === 0 && rlBranch.stdout.trim() !== '' && rlHead.status === 0 && rlHead.stdout.trim() !== '', { b: rlBranch.stdout, h: rlHead.stdout, be: rlBranch.stderr, he: rlHead.stderr });
        const scanBefore = C.scanTree(fs.realpathSync.native(wt28), []);
        check('11.28e2 拆之前 scanTree 复核：读到 4 个最外层联接、重解析点不符 0 个（没有递归进联接）', scanBefore.unexpectedLinks.length === 4 && scanBefore.mismatches.length === 0, { u: scanBefore.unexpectedLinks, m: scanBefore.mismatches });
        const tpBeforeA = psTestPath(linkA);
        const tpBeforeD = psTestPath(linkD);
        check('11.28e3 对照：拆之前 PowerShell Test-Path -LiteralPath 对目标存在的联接（含名字带单引号的）为 True（这条复核命令确有判别力，单引号写两个的转义有效）', tpBeforeA.status === 0 && tpBeforeA.stdout.trim() === 'True' && tpBeforeD.status === 0 && tpBeforeD.stdout.trim() === 'True', { a: tpBeforeA.stdout, d: tpBeforeD.stdout, ae: tpBeforeA.stderr, de: tpBeforeD.stderr });
        const results = [];
        for (const p of [linkA, linkB, linkC, linkD]) { const pr = psDeleteLink(p); results.push({ p, s: pr.status, e: (pr.stderr || '').slice(0, 200) }); }
        check('11.28f 测试代码用 .NET 非递归方式逐个拆联接（含悬空联接与带单引号的联接）：全部退出码 0，4 个联接都没了', results.length === 4 && results.every((r) => r.s === 0) && [linkA, linkB, linkC, linkD].every((p) => !fs.existsSync(p) && !isLink(p)), results);
        const tpAfter = [linkA, linkB, linkC, linkD].map((p) => ({ p, r: psTestPath(p) }));
        check('11.28f2 拆完后对每个联接路径跑 PowerShell Test-Path -LiteralPath：4 个都退出码 0 且输出 False（CLAUDE.md 第 2 步的复核命令；与 scanTree 复核互为印证）', tpAfter.every((x) => x.r.status === 0 && x.r.stdout.trim() === 'False'), tpAfter.map((x) => ({ p: x.p, s: x.r.status, o: x.r.stdout, e: x.r.stderr })));
        check('11.28g 链接目标原样：三个目标里的哨兵文件在，嵌套联接还在（只拆了最外层链接本身，没有穿过去）', [ext1, ext2, extIn].every((d) => rd(path.join(d, '哨兵.txt')) === `SENT-${path.basename(d)}`) && isLink(path.join(ext1, '嵌套联接')));
        const scanAfter = C.scanTree(fs.realpathSync.native(wt28), []);
        check('11.28h 拆完后 scanTree 复核为零；git worktree remove（不带强制选项）成功，worktree 没了，三个目标原样', (() => {
            if (!(scanAfter.unexpectedLinks.length === 0 && scanAfter.mismatches.length === 0)) return false;
            gitq(fx28.main, ['worktree', 'remove', wt28]);   // 用 gitq（不带 -c core.autocrlf=false）：与在场人员实际执行时的 git 配置一致，否则 CRLF 检出的文件被判成已修改
            return !fs.existsSync(wt28) && [ext1, ext2, extIn].every((d) => rd(path.join(d, '哨兵.txt')) === `SENT-${path.basename(d)}`) && isLink(path.join(ext1, '嵌套联接'));
        })(), { u: scanAfter.unexpectedLinks, m: scanAfter.mismatches });
        gitq(fx28.main, ['branch', '-d', 'line/or']);   // 分支刚从 main 尖端建出，已合入，-d 能删
        const rr28 = await removeLine(fx28, 'or');
        check('11.28i git branch -d 删掉分支、line remove 清登记：登记空、分支没了、主工作区完好、三个联接目标原样', rr28.err === null && Object.keys((await regOf(fx28)).lines).length === 0 && !branchExists(fx28, 'line/or') && mainIntact(fx28) && [ext1, ext2, extIn].every((d) => rd(path.join(d, '哨兵.txt')) === `SENT-${path.basename(d)}`), rr28.err && rr28.err.message);
    }
    // 11.28j 扫描自身失败（注入 scanTree 抛错）：清单改说「无法自动列出」+ 错误原文，不假装「没有联接」；reflog 两条只读命令照给；不出现任何改动类命令
    {
        const fx28j = await buildFixture('s11ownerrecscan');
        const extJ = path.join(fx28j.root, '外部 目标J');
        fs.mkdirSync(extJ, { recursive: true });
        const wtJ = wtOf(fx28j, 'oj');
        const origW = C.writeOwnerRecord;
        const origScan = C.scanTree;
        C.writeOwnerRecord = () => { throw new Error('注入：控制根归属记录写入失败'); };
        C.scanTree = () => { throw new Error('注入：扫描失败'); };
        let rj;
        try {
            rj = await newLine(fx28j, 'oj', 'm-oj', {}, [], { testHooks: { afterStep: async (s) => { if (s === 'worktree') fs.symlinkSync(extJ, path.join(wtJ, 'node_modules'), 'junction'); } } });
        } finally { C.writeOwnerRecord = origW; C.scanTree = origScan; }
        const msgJ = rj.err ? rj.err.message : '';
        const shJ = siteListShape(msgJ, wtJ, 'line/oj', fx28j);
        check('11.28j 扫描失败：说明「无法自动列出」且带错误原文，须人工只读检查；不说「没有发现联接」、不列联接；reflog 两条只读命令照给且是仅有的命令行；剥离已知路径与两条 reflog 命令行后三层判据（片段表 / git 子命令 / 白名单外 ASCII 词）都为零；最后一行是说明句',
            rj.err && rj.err.step === 'owner_record' && /无法自动列出 worktree 里的联接（注入：扫描失败），在场人员须先人工只读检查/.test(msgJ) && !/没有发现联接/.test(msgJ) && linkListingOf(msgJ).length === 0
            && shJ.reflogCmds && shJ.onlyReflogCmds && shJ.clean && shJ.note && shJ.onsite && shJ.loc && shJ.keep, { shJ, cmdish: cmdishLinesOf(msgJ), msgJ });
        check('11.28k 以上之后联接与 worktree、分支都还在（清单不是动作）', isLink(path.join(wtJ, 'node_modules')) && fs.existsSync(path.join(wtJ, '.git')) && branchExists(fx28j, 'line/oj'));
    }
    // 11.28m 「先救援」路径可行：worktree 里提交一次再 `git reset --hard HEAD~1`，那次提交只存在于 reflog；owner_record 失败后，消息里的两条 reflog 命令（原样取自消息，不经 shell）在对应目录里能看到该提交号
    {
        const fxr = await buildFixture('s11ownerrecreflog');
        const wtr = wtOf(fxr, 'rf');
        let lostOid = null;
        const origW = C.writeOwnerRecord;
        C.writeOwnerRecord = () => { throw new Error('注入：控制根归属记录写入失败'); };
        let rr;
        try {
            rr = await newLine(fxr, 'rf', 'm-rf', {}, [], { testHooks: { afterStep: async (s) => {
                if (s !== 'worktree') return;
                commitIn(fxr, 'rf', 'rescue-me.txt', 'only-in-reflog');
                lostOid = git(wtr, ['rev-parse', 'HEAD']).trim();
                git(wtr, ['reset', '--hard', 'HEAD~1']);
            } } });
        } finally { C.writeOwnerRecord = origW; }
        const msgR = rr.err ? rr.err.message : '';
        const shR = siteListShape(msgR, wtr, 'line/rf', fxr);
        const tipR = branchExists(fxr, 'line/rf') ? git(fxr.main, ['rev-parse', 'refs/heads/line/rf']).trim() : null;
        check('11.28m.0 前置：失败于 owner_record；那次提交已被 reset 掉（不在线分支尖端），但对象还在库里；消息形状正确', !!rr.err && rr.err.step === 'owner_record' && lostOid !== null && tipR !== null && tipR !== lostOid && git(fxr.main, ['cat-file', '-t', lostOid]).trim() === 'commit' && shR.reflogCmds && shR.onlyReflogCmds && shR.clean && shR.note, { lostOid, tipR, shR });
        const cmdOf = (line) => msgLinesOf(msgR).find((l) => l === line);
        const argsOf = (line) => (cmdOf(line) || '').split(' ').slice(1);
        const rlB = spawnSync('git', argsOf(reflogBranchCmd('line/rf')), { cwd: fxr.main, encoding: 'utf8', windowsHide: true, timeout: 60000 });
        const rlH = spawnSync('git', argsOf(REFLOG_HEAD_CMD), { cwd: wtr, encoding: 'utf8', windowsHide: true, timeout: 60000 });
        const seesOid = (out) => (String(out).match(/\b[0-9a-f]{7,40}\b/g) || []).some((t) => lostOid !== null && lostOid.startsWith(t));
        check('11.28m 消息里的 reflog 命令（原样、不经 shell）：在主工作区看线分支 reflog、在 worktree 里看 HEAD reflog，两处都能看到那次只存在于 reflog 的提交号（先救援路径可行）；现场仍在', rlB.status === 0 && rlH.status === 0 && seesOid(rlB.stdout) && seesOid(rlH.stdout) && fs.existsSync(path.join(wtr, '.git')) && branchExists(fxr, 'line/rf'), { lostOid, b: rlB.stdout, h: rlH.stdout, be: rlB.stderr, he: rlH.stderr });
        // 11.28m2 跑完 CLAUDE.md「建线中断（owner_record 失败）的现场处理」全部 5 步（测试代码按规则自己做，命令不取自消息；全部 git 调用 spawnSync 参数数组）：
        //   1 读两个 reflog 文件的每行前两列（旧值、新值，全零跳过；不用 reflog show），收到的**每个**提交号都建 rescue/rf-<序号>（不再按 merge-base --is-ancestor 筛选：筛选命令两种结果都没有输出、退出码易看错）；2 拆联接（这个场景里没有联接，仍扫描复核）；
        //   3 先跑规则命令 status（--porcelain=v1 --ignored --untracked-files=all）：无 `?? ` 行、无含 node_modules 的路径，`!! ` 条目备份后 git worktree remove（不带强制）；4 git branch -d line/rf；5 line remove。最后证明那次只存在于 reflog 的提交仍可从救援分支到达。
        const gitRaw = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 60000 });
        const reflogFilesR = reflogFilesOf(fxr, wtr, 'line/rf');   // 清单列出的两个 reflog 文件（管理目录 logs/HEAD、主工作区 logs/refs/heads/line/rf）
        const filesExistBefore = reflogFilesR.every((f) => fs.existsSync(f));
        const allOids = filesExistBefore ? oidsFromReflogFiles(reflogFilesR) : [];   // 第 1 步按规则：直接读两个文件，每行前两列（旧值、新值）都算，全零跳过
        const rescued = [];   // [{ oid, branch, st }]：收到的每个提交号都建
        for (const oid of allOids) {
            const br = `rescue/rf-${rescued.length + 1}`;
            rescued.push({ oid, branch: br, st: gitRaw(fxr.main, ['branch', br, oid]).status });
        }
        const notInMainR = gitRaw(fxr.main, ['merge-base', '--is-ancestor', lostOid, 'main']).status;   // 仅作对照：X 确实不在 main 里（退出码 1），不参与第 1 步的取舍
        check('11.28m2a 第 1 步（按规则读两个 reflog 文件的每行前两列、跳过全零，不用 reflog show）：两个文件都在且读到提交；被测提交 X 在收集集合里；收到的每个提交号都建了救援分支且全部成功（个数 = 收集个数，不筛选）；对照：X 确实不在 main 里（merge-base --is-ancestor 退出码 1）',
            filesExistBefore && allOids.length >= 2 && allOids.includes(lostOid) && notInMainR === 1
            && rescued.length === allOids.length && rescued.every((x) => x.st === 0) && rescued.some((x) => x.oid === lostOid), { lostOid, allOids, rescued, notInMainR, reflogFilesR, filesExistBefore });
        const scanR = fs.existsSync(wtr) ? C.scanTree(fs.realpathSync.native(wtr), []) : { unexpectedLinks: [], mismatches: [] };
        const linkRes = scanR.unexpectedLinks.map((p) => psDeleteLink(p).status);
        const scanR2 = fs.existsSync(wtr) ? C.scanTree(fs.realpathSync.native(wtr), []) : { unexpectedLinks: [], mismatches: [] };
        check('11.28m2b 第 2 步：拆联接（本场景没有联接：扫描读到的最外层联接全部拆成功，拆后复核联接 / 重解析点不符均为零）', linkRes.every((s) => s === 0) && scanR2.unexpectedLinks.length === 0 && scanR2.mismatches.length === 0, { linkRes, u: scanR2.unexpectedLinks, m: scanR2.mismatches });
        const stR3 = ruleStatus(wtr);   // 第 3 步先跑规则命令
        const bakR3 = preserveIgnored(wtr, stR3.ign);
        const wtRem = gitRaw(fxr.main, ['worktree', 'remove', wtr]);
        const bakR3Left = removeTree(bakR3.dir);
        check('11.28m2c 第 3 步：规则命令 status 退出码 0、无 `?? ` 行、无含 node_modules 的路径；`!! ` 条目备份成功（备份目录用完逐项清理干净）；git worktree remove（不带强制选项）退出码 0，worktree 目录没了',
            stR3.st === 0 && stR3.untracked.length === 0 && stR3.nodeMods.length === 0 && bakR3.err === null && bakR3Left.length === 0 && wtRem.status === 0 && !fs.existsSync(wtr), { st: stR3.st, entries: stR3.entries, bakErr: bakR3.err, s: wtRem.status, e: wtRem.stderr });
        const brDel = gitRaw(fxr.main, ['branch', '-d', 'line/rf']);
        check('11.28m2d 第 4 步：git branch -d line/rf（不用 -D）退出码 0，线分支没了', brDel.status === 0 && !branchExists(fxr, 'line/rf'), { s: brDel.status, e: brDel.stderr });
        const rrm = await removeLine(fxr, 'rf');
        check('11.28m2e 第 5 步：line remove rf 成功，登记表里这条线不在了', rrm.err === null && Object.keys((await regOf(fxr)).lines).length === 0, rrm.err && rrm.err.message);
        const reach = rescued.map((x) => ({ branch: x.branch, st: gitRaw(fxr.main, ['merge-base', '--is-ancestor', lostOid, x.branch]).status }));
        check('11.28m2f 救援有效：那次只存在于 reflog 的提交 X 可从某个 rescue 分支到达（merge-base --is-ancestor X rescue/… 退出码 0），对象仍是 commit；worktree / 线分支 / 登记都没了，两个 reflog 文件（管理目录 logs/HEAD、线分支 reflog）也已不存在（reflog 随之消失，所以必须先救援）；主工作区完好', reach.some((x) => x.st === 0) && git(fxr.main, ['cat-file', '-t', lostOid]).trim() === 'commit'
            && !fs.existsSync(wtr) && !branchExists(fxr, 'line/rf') && !(await regOf(fxr)).lines.rf && reflogFilesR.every((f) => !fs.existsSync(f)) && mainIntact(fxr), { lostOid, reach, reflogFilesR: reflogFilesR.map((f) => ({ f, exists: fs.existsSync(f) })) });
    }

    // 11.28n 只出现在旧值列的提交（codex H1，规则第 1 步）：`git reflog show` 只显示每条记录的新值；早期的记录若被改写 / 过期而丢了，
    //   提交就只剩在后一行的旧值列里。规则要求直接读两个 reflog 文件的每行前两列。场景：同 11.28m（worktree 里提交 X 再 reset 回去），
    //   然后由测试直接改写两个 reflog 文件，删掉「新值 = X」的行（模拟早期记录过期），X 只剩在「X → 尖端（reset）」那一行的旧值列。
    {
        const fxn = await buildFixture('s11ownerrecold');
        const wtn = wtOf(fxn, 'on');
        let lostOid = null;
        const origW = C.writeOwnerRecord;
        C.writeOwnerRecord = () => { throw new Error('注入：控制根归属记录写入失败'); };
        let rn;
        try {
            rn = await newLine(fxn, 'on', 'm-on', {}, [], { testHooks: { afterStep: async (s) => {
                if (s !== 'worktree') return;
                commitIn(fxn, 'on', 'only-old.txt', 'only-in-old-column');
                lostOid = git(wtn, ['rev-parse', 'HEAD']).trim();
                git(wtn, ['reset', '--hard', 'HEAD~1']);
            } } });
        } finally { C.writeOwnerRecord = origW; }
        const gitRaw = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 60000 });
        const hashesOf = (r) => String(r.stdout).split(/\r?\n/).map((s) => s.trim()).filter((s) => /^[0-9a-f]{40}$/.test(s));
        const showB = () => gitRaw(fxn.main, ['reflog', 'show', '--format=%H', 'refs/heads/line/on']);
        const showH = () => gitRaw(wtn, ['reflog', 'show', '--format=%H', 'HEAD']);
        const filesN = reflogFilesOf(fxn, wtn, 'line/on');
        const tipN = branchExists(fxn, 'line/on') ? git(fxn.main, ['rev-parse', 'refs/heads/line/on']).trim() : null;
        const filesBefore = filesN.every((f) => fs.existsSync(f));
        const showBefore = { b: hashesOf(showB()), h: hashesOf(showH()) };
        check('11.28n.0 前置：失败于 owner_record；X 已被 reset 掉（不在线分支尖端），对象还在库里；两个 reflog 文件都在；改写之前 reflog show 两处都看得到 X（对照：看不到是下面改写造成的）',
            !!rn.err && rn.err.step === 'owner_record' && lostOid !== null && tipN !== null && tipN !== lostOid && git(fxn.main, ['cat-file', '-t', lostOid]).trim() === 'commit' && filesBefore
            && showBefore.b.includes(lostOid) && showBefore.h.includes(lostOid), { lostOid, tipN, filesN, showBefore });
        // 改写两个 reflog 文件：删掉新值列（第 2 列）= X 的行
        const dropNewEq = (f) => {
            const keep = [];
            let dropped = 0;
            for (const ln of fs.readFileSync(f, 'utf8').split('\n')) { if (ln.split(/\s+/)[1] === lostOid) dropped += 1; else keep.push(ln); }
            fs.writeFileSync(f, keep.join('\n'));
            return dropped;
        };
        const droppedN = filesN.map(dropNewEq);
        const colsOf = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => l.split(/\s+/));
        const oldOnly = filesN.every((f) => colsOf(f).some((c) => c[0] === lostOid) && !colsOf(f).some((c) => c[1] === lostOid));
        const showAfter = { b: hashesOf(showB()), h: hashesOf(showH()) };
        const fileOidsN = oidsFromReflogFiles(filesN);
        check('11.28n 只在旧值端：改写后两个文件各删掉恰好 1 行，X 在两个文件里只出现在旧值列；git reflog show --format=%H 两处都不含 X（只看 show 会漏）；按「读两个文件、每行前两列、跳过全零」收集到的集合含 X',
            droppedN.every((d) => d === 1) && oldOnly && !showAfter.b.includes(lostOid) && !showAfter.h.includes(lostOid) && fileOidsN.includes(lostOid), { droppedN, oldOnly, showAfter, fileOidsN, lostOid });
        const rescuedN = [];   // 收到的每个提交号都建救援分支（不筛选）
        for (const oid of fileOidsN) {
            const br = `rescue/on-${rescuedN.length + 1}`;
            rescuedN.push({ oid, branch: br, st: gitRaw(fxn.main, ['branch', br, oid]).status });
        }
        const notInMainN = gitRaw(fxn.main, ['merge-base', '--is-ancestor', lostOid, 'main']).status;   // 仅作对照：X 确实不在 main 里
        check('11.28n2 第 1 步：收到的每个提交号都建了救援分支且全部成功（个数 = 收集个数，不筛选），X 在其中；对照：X 确实不在 main 里（merge-base --is-ancestor 退出码 1）',
            notInMainN === 1 && fileOidsN.includes(lostOid) && rescuedN.length === fileOidsN.length && rescuedN.length >= 1 && rescuedN.every((x) => x.st === 0) && rescuedN.some((x) => x.oid === lostOid), { fileOidsN, rescuedN, notInMainN });
        const scanN = fs.existsSync(wtn) ? C.scanTree(fs.realpathSync.native(wtn), []) : { unexpectedLinks: [], mismatches: [] };
        const linkResN = scanN.unexpectedLinks.map((p) => psDeleteLink(p).status);
        const scanN2 = fs.existsSync(wtn) ? C.scanTree(fs.realpathSync.native(wtn), []) : { unexpectedLinks: [], mismatches: [] };
        check('11.28n3 第 2 步：拆联接成功，拆后复核联接 / 重解析点不符均为零', linkResN.every((s) => s === 0) && scanN2.unexpectedLinks.length === 0 && scanN2.mismatches.length === 0, { linkResN, u: scanN2.unexpectedLinks, m: scanN2.mismatches });
        const stN3 = ruleStatus(wtn);   // 第 3 步先跑规则命令
        const bakN3 = preserveIgnored(wtn, stN3.ign);
        const wtRemN = gitRaw(fxn.main, ['worktree', 'remove', wtn]);
        const bakN3Left = removeTree(bakN3.dir);
        check('11.28n4 第 3 步：规则命令 status 退出码 0、无 `?? ` 行、无含 node_modules 的路径；`!! ` 条目备份成功（备份目录用完逐项清理干净）；git worktree remove（不带强制选项）退出码 0，worktree 目录没了（改写过的 reflog 没让 git 拒绝）',
            stN3.st === 0 && stN3.untracked.length === 0 && stN3.nodeMods.length === 0 && bakN3.err === null && bakN3Left.length === 0 && wtRemN.status === 0 && !fs.existsSync(wtn), { st: stN3.st, entries: stN3.entries, bakErr: bakN3.err, s: wtRemN.status, e: wtRemN.stderr });
        const brDelN = gitRaw(fxn.main, ['branch', '-d', 'line/on']);
        check('11.28n5 第 4 步：git branch -d line/on 退出码 0，线分支没了', brDelN.status === 0 && !branchExists(fxn, 'line/on'), { s: brDelN.status, e: brDelN.stderr });
        const rrmN = await removeLine(fxn, 'on');
        check('11.28n6 第 5 步：line remove on 成功，登记表里这条线不在了', rrmN.err === null && Object.keys((await regOf(fxn)).lines).length === 0, rrmN.err && rrmN.err.message);
        const reachN = rescuedN.map((x) => ({ branch: x.branch, st: gitRaw(fxn.main, ['merge-base', '--is-ancestor', lostOid, x.branch]).status }));
        check('11.28n7 救援有效：只存在于旧值列的 X 可从某个 rescue 分支到达（退出码 0），对象仍是 commit；worktree / 线分支 / 登记 / 两个 reflog 文件都没了；主工作区完好',
            reachN.some((x) => x.st === 0) && git(fxn.main, ['cat-file', '-t', lostOid]).trim() === 'commit' && !fs.existsSync(wtn) && !branchExists(fxn, 'line/on') && !(await regOf(fxn)).lines.on && filesN.every((f) => !fs.existsSync(f)) && mainIntact(fxn), { lostOid, reachN });
    }
    // 11.28p 被 git 忽略的普通文件（codex H2）：`git status --porcelain` 看不到它们，`git worktree remove`（不带强制）却会连目录一起删。
    //   规则要求：拆完联接之后跑 `git -c core.quotePath=false status --porcelain=v1 --ignored --untracked-files=all`，见 `?? ` 或含 node_modules 的路径就停，把 `!! ` 列出的被忽略文件先复制到备份目录再拆 worktree。
    //   场景：owner_record 失败后在 worktree 里写两个被仓库 .gitignore 忽略的文件（wbs-server/.env.local；tmp/codex-runs/r1.final.txt，即线内 codex 原话的位置），含哨兵内容。
    //   两个独立夹具：对照组不保全（证明 worktree remove 退出码 0、文件随目录消失）；保全组复制到 mkdtemp 私有备份目录后再拆（证明备份完好）。
    {
        const IGN_FILES = [['wbs-server/.env.local', 'IGNORED-ENV-LOCAL-SENTINEL-0001'], ['tmp/codex-runs/r1.final.txt', 'IGNORED-CODEX-FINAL-SENTINEL-0002']];
        const gitRaw = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 60000 });
        const entriesOf = (r) => String(r.stdout).split('\0').filter(Boolean).map((e) => ({ xy: e.slice(0, 2), p: e.slice(3) }));
        const runCase = async (label, name, keep) => {
            const fxp = await buildFixture(`s11ignored${label}`);
            const wtp = wtOf(fxp, name);
            const origWp = C.writeOwnerRecord;
            C.writeOwnerRecord = () => { throw new Error('注入：控制根归属记录写入失败'); };
            let rp;
            try { rp = await newLine(fxp, name, `m-${name}`, {}, []); } finally { C.writeOwnerRecord = origWp; }
            for (const [rel, text] of IGN_FILES) w(path.join(wtp, rel), text);
            // 第 2 步：先拆联接（status 不能穿过联接去扫目标）
            const scanP = fs.existsSync(wtp) ? C.scanTree(fs.realpathSync.native(wtp), []) : { unexpectedLinks: [], mismatches: [] };
            const linkResP = scanP.unexpectedLinks.map((p) => psDeleteLink(p).status);
            const scanP2 = fs.existsSync(wtp) ? C.scanTree(fs.realpathSync.native(wtp), []) : { unexpectedLinks: [], mismatches: [] };
            const stIgn = ruleStatus(wtp);   // 规则第 3 步原文命令（+ -z）：-c core.quotePath=false status --porcelain=v1 --ignored --untracked-files=all
            const stPlain = gitRaw(wtp, ['status', '--porcelain=v1', '-z']);
            const ign = stIgn.ign;
            const plain = entriesOf(stPlain).map((e) => e.p);
            check(`11.28p${label}.1 owner_record 失败后、拆完联接：规则命令（--porcelain=v1 --ignored --untracked-files=all）退出码 0，以 !! 逐个文件列出 wbs-server/.env.local 与 tmp/codex-runs/r1.final.txt（--untracked-files=all 把被忽略目录展开成文件）；没有 \`?? \` 行、没有含 node_modules 的路径；普通 status --porcelain 两个都不列（普通 status 看不到被忽略文件）`,
                !!rp.err && rp.err.step === 'owner_record' && linkResP.every((s) => s === 0) && scanP2.unexpectedLinks.length === 0 && scanP2.mismatches.length === 0
                && stIgn.st === 0 && stPlain.status === 0 && ign.includes('wbs-server/.env.local') && ign.includes('tmp/codex-runs/r1.final.txt')
                && stIgn.untracked.length === 0 && stIgn.nodeMods.length === 0
                && !plain.some((p) => p === 'wbs-server/.env.local' || p.startsWith('tmp/')), { entries: stIgn.entries, err: stIgn.err, plain, linkResP, u: scanP2.unexpectedLinks, m: scanP2.mismatches });
            let backupDir = null;
            let copyErr = null;
            if (keep) {
                backupDir = fs.mkdtempSync(path.join(os.tmpdir(), '行线 备份 '));
                try { for (const p of ign) copyTreeNoFollow(path.join(wtp, p.replace(/\/$/, '')), path.join(backupDir, p.replace(/\/$/, ''))); } catch (e) { copyErr = e && e.message; }
            }
            const wtRemP = gitRaw(fxp.main, ['worktree', 'remove', wtp]);
            const goneP = IGN_FILES.every(([rel]) => !fs.existsSync(path.join(wtp, rel)));
            if (!keep) {
                check('11.28p0.2 对照组（不保全）：git worktree remove（不带强制选项）退出码 0，被忽略的哨兵文件随目录一起消失（所以规则必须先备份）',
                    wtRemP.status === 0 && !fs.existsSync(wtp) && goneP, { s: wtRemP.status, e: wtRemP.stderr });
            } else {
                const backedUp = IGN_FILES.map(([rel, text]) => { try { return rd(path.join(backupDir, rel)) === text; } catch (_) { return false; } });
                check('11.28p1.2 保全组：把 status --ignored 列出的被忽略文件逐项复制进 mkdtemp 私有备份目录后 git worktree remove（不带强制选项）退出码 0、worktree 没了；备份里两个哨兵文件内容完好；复制全程没遇到链接',
                    copyErr === null && wtRemP.status === 0 && !fs.existsSync(wtp) && goneP && backedUp.every(Boolean), { copyErr, s: wtRemP.status, e: wtRemP.stderr, backedUp, ign });
                const leftB = removeTree(backupDir);
                check('11.28p1.3 备份目录用完逐项清理干净', leftB.length === 0 && !fs.existsSync(backupDir), leftB.slice(0, 5));
            }
            const brDelP = gitRaw(fxp.main, ['branch', '-d', `line/${name}`]);
            const rrmP = await removeLine(fxp, name);
            check(`11.28p${label}.4 第 4、5 步：git branch -d line/${name} 退出码 0、line remove ${name} 成功、登记空；主工作区完好`, brDelP.status === 0 && rrmP.err === null && Object.keys((await regOf(fxp)).lines).length === 0 && mainIntact(fxp), { s: brDelP.status, e: brDelP.stderr, re: rrmP.err && rrmP.err.message });
        };
        await runCase('0', 'ig0', false);
        await runCase('1', 'ig1', true);
    }
    // 11.28p2 配置了 `status.showUntrackedFiles=no`（codex 47R3c-R3 H / 预筛 M1）：不加 `--untracked-files=all` 时 status 一个未跟踪 / 被忽略文件都列不出，
    //   `git worktree remove` 自己 fork 的脏检查读同一份配置，同样失效 → 文件被静默删掉。规则第 3 步命令显式带 `--untracked-files=all` 盖过配置。
    //   配置方式：`git -C <worktree> config status.showUntrackedFiles no`（worktree 的 config 落在公共 .git/config）。选这种而不是 `-c` 逐命令注入，因为它更接近「用户机器上真配了」，
    //   且 worktree remove 内部的 status 子进程也读得到；不污染别的用例：每个夹具是独立的临时仓库（buildFixture 自己 git init），配置只落在该夹具的 .git/config，夹具用完即弃，不碰真实仓库。
    //   三个独立夹具：P = 按规则走（见 `??` 即停，处理后保全 `!!` 再拆）；C = 对照，配置在、不按规则直接 worktree remove → 丢文件；C0 = 对照，配置不在 → worktree remove 因未跟踪文件拒绝（证明是配置让脏检查失效）。
    {
        const SENT_IGN = ['wbs-server/.env.local', 'IGNORED-CFGNO-SENTINEL-0003'];
        const SENT_UNT = ['wbs-server/untracked-sentinel.txt', 'UNTRACKED-CFGNO-SENTINEL-0004'];
        const gitRaw = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 60000 });
        const setup = async (label, name, cfgNo) => {
            const fxc = await buildFixture(`s11cfg${label}`);
            const wtc = wtOf(fxc, name);
            const origWc = C.writeOwnerRecord;
            C.writeOwnerRecord = () => { throw new Error('注入：控制根归属记录写入失败'); };
            let rc;
            try { rc = await newLine(fxc, name, `m-${name}`, {}, []); } finally { C.writeOwnerRecord = origWc; }
            const cfgSet = cfgNo ? gitRaw(wtc, ['config', 'status.showUntrackedFiles', 'no']).status : null;
            const cfgGet = gitRaw(wtc, ['config', '--get', 'status.showUntrackedFiles']);
            w(path.join(wtc, SENT_IGN[0]), SENT_IGN[1]);
            w(path.join(wtc, SENT_UNT[0]), SENT_UNT[1]);
            const scanC = fs.existsSync(wtc) ? C.scanTree(fs.realpathSync.native(wtc), []) : { unexpectedLinks: [], mismatches: [] };
            const linkResC = scanC.unexpectedLinks.map((p) => psDeleteLink(p).status);
            const scanC2 = fs.existsSync(wtc) ? C.scanTree(fs.realpathSync.native(wtc), []) : { unexpectedLinks: [], mismatches: [] };
            const pre = !!rc.err && rc.err.step === 'owner_record' && linkResC.every((s) => s === 0) && scanC2.unexpectedLinks.length === 0 && scanC2.mismatches.length === 0
                && (cfgNo ? cfgSet === 0 && cfgGet.status === 0 && cfgGet.stdout.trim() === 'no' : cfgGet.status === 1);
            return { fxc, wtc, pre, cfgGet: cfgGet.stdout, rcErr: rc.err && rc.err.message };
        };
        const sentOf = (wtc) => ({ ign: fs.existsSync(path.join(wtc, SENT_IGN[0])), unt: fs.existsSync(path.join(wtc, SENT_UNT[0])) });
        // ---- P：按规则走 ----
        {
            const P = await setup('P', 'cn1', true);
            const { fxc, wtc } = P;
            check('11.28p2.0 前置（P）：owner_record 失败、联接已拆净；git config --get status.showUntrackedFiles 输出 no；worktree 里有一个被忽略哨兵与一个未跟踪哨兵', P.pre && sentOf(wtc).ign && sentOf(wtc).unt, { pre: P.pre, cfg: P.cfgGet, err: P.rcErr });
            const ctlPlain = gitRaw(wtc, ['status', '--porcelain', '--ignored']);
            check('11.28p2.1 对照（配置确实生效）：不带 --untracked-files=all 的 `git status --porcelain --ignored` 退出码 0 且输出为空——被忽略哨兵与未跟踪哨兵都看不见', ctlPlain.status === 0 && ctlPlain.stdout === '', { s: ctlPlain.status, o: ctlPlain.stdout, e: ctlPlain.stderr });
            const stR = ruleStatus(wtc);
            check('11.28p2.2 规则命令（带 --untracked-files=all）退出码 0，列出 `!! wbs-server/.env.local` 与 `?? wbs-server/untracked-sentinel.txt`', stR.st === 0 && stR.entries.some((e) => e.xy === '!!' && e.p === SENT_IGN[0]) && stR.entries.some((e) => e.xy === '??' && e.p === SENT_UNT[0]), { st: stR.st, entries: stR.entries, err: stR.err });
            // 规则：有 `?? ` 行就停下核对——这里不执行 worktree remove
            const stopped = stR.untracked.length > 0;
            const wtListHas = (wt) => gitRaw(fxc.main, ['worktree', 'list', '--porcelain']).stdout.split(/\r?\n/).some((l) => l.startsWith('worktree ') && C.pathKey(l.slice(9).trim()) === C.pathKey(wt));
            check('11.28p2.3 按规则见到 `?? ` 即停：本用例此时没有执行 worktree remove——worktree 目录、两个哨兵文件、git 的 worktree 登记都还在', stopped && fs.existsSync(wtc) && sentOf(wtc).ign && sentOf(wtc).unt && wtListHas(wtc), { stopped, sent: sentOf(wtc) });
            // 在场人员核对后处理未跟踪文件（这里由测试删掉那个哨兵），再重跑规则命令：不再有 `?? ` 行才往下走
            fs.unlinkSync(path.join(wtc, SENT_UNT[0]));
            const stR2 = ruleStatus(wtc);
            const bak = preserveIgnored(wtc, stR2.ign);
            const wtRem = gitRaw(fxc.main, ['worktree', 'remove', wtc]);
            const backedUp = (() => { try { return rd(path.join(bak.dir, SENT_IGN[0])) === SENT_IGN[1]; } catch (_) { return false; } })();
            const bakLeft = removeTree(bak.dir);
            const brDel = gitRaw(fxc.main, ['branch', '-d', 'line/cn1']);
            const rrm = await removeLine(fxc, 'cn1');
            check('11.28p2.4 处理掉未跟踪文件后重跑规则命令：无 `?? ` 行、无 node_modules；`!! ` 条目（含被忽略哨兵）备份进私有目录且内容完好；git worktree remove（不带强制选项）退出码 0、worktree 没了；git branch -d、line remove 成功、登记空；备份目录清理干净',
                stR2.st === 0 && stR2.untracked.length === 0 && stR2.nodeMods.length === 0 && stR2.ign.includes(SENT_IGN[0]) && bak.err === null && backedUp && bakLeft.length === 0
                && wtRem.status === 0 && !fs.existsSync(wtc) && brDel.status === 0 && rrm.err === null && Object.keys((await regOf(fxc)).lines).length === 0 && mainIntact(fxc),
                { entries: stR2.entries, bakErr: bak.err, backedUp, s: wtRem.status, e: wtRem.stderr, bs: brDel.status, re: rrm.err && rrm.err.message });
        }
        // ---- C：对照（不按规则）：配置在，直接 worktree remove ----
        {
            const Cc = await setup('C', 'cn2', true);
            const { fxc, wtc } = Cc;
            const sent0 = sentOf(wtc);
            const rem = gitRaw(fxc.main, ['worktree', 'remove', wtc]);
            check('11.28p2.5 对照（不按规则、配置在）：直接 git worktree remove（不带强制选项）退出码 0——脏检查被配置骗过，没有拒绝；worktree 目录没了，被忽略哨兵与未跟踪哨兵随目录一起消失（所以规则必须先跑带 --untracked-files=all 的 status）',
                Cc.pre && sent0.ign && sent0.unt && rem.status === 0 && !fs.existsSync(wtc) && !fs.existsSync(path.join(wtc, SENT_IGN[0])) && !fs.existsSync(path.join(wtc, SENT_UNT[0])), { pre: Cc.pre, sent0, s: rem.status, e: rem.stderr });
        }
        // ---- C0：对照：配置不在，同样的现场 → worktree remove 拒绝（证明是配置让脏检查失效，不是 git 本来就不查）----
        {
            const C0 = await setup('C0', 'cn0', false);
            const { fxc, wtc } = C0;
            const rem = gitRaw(fxc.main, ['worktree', 'remove', wtc]);
            check('11.28p2.6 对照（配置不在、同样的现场）：git worktree remove（不带强制选项）因未跟踪文件拒绝（退出码非 0），worktree 目录与两个哨兵都还在', C0.pre && rem.status !== 0 && fs.existsSync(wtc) && sentOf(wtc).ign && sentOf(wtc).unt, { pre: C0.pre, s: rem.status, e: rem.stderr });
        }
    }
    // 11.28q worktree 目录已不在、管理目录还在（预筛 L9 / L2；规则第 3 步末句）：不用 `git worktree prune`（它连带清掉别的失效登记），直接 `git worktree remove <路径>` 只清这一条。
    //   注入选 B：C.writeOwnerRecord 成功、C.writeAdminMarker 抛错——归属记录文件已写（ownerOk 为真）、管理目录还在、marker 缺失，最贴近 line-remove.js 里「worktree 目录已不在、管理目录证明不了 / 核对」的场景（第 282 行附近）；
    //   注入 A（writeOwnerRecord 抛错）的 ownerOk 为假，走的是另一条分支。两条线（qa 本线、qb 另一条）都是 B 注入失败后由测试非递归删掉 worktree 目录（removeTree：不跟随链接、unlinkSync / rmdirSync，不用 fs.rmSync；本场景没有联接，仍先 scanTree 复核）。
    {
        const gitRaw = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 60000 });
        const fxq = await buildFixture('s11dirgone');
        const failB = async (name) => {
            const origO = C.writeAdminMarker;
            C.writeAdminMarker = () => { throw new Error('注入：管理目录归属标记写入失败'); };
            let r;
            try { r = await newLine(fxq, name, `m-${name}`, {}, []); } finally { C.writeAdminMarker = origO; }
            return r;
        };
        const wta = wtOf(fxq, 'qa');
        const wtb = wtOf(fxq, 'qb');
        const ra = await failB('qa');
        const rb = await failB('qb');
        const regQ = await regOf(fxq);
        const adminOf = (wt) => { const g = gitRaw(wt, ['rev-parse', '--absolute-git-dir']); return g.status === 0 ? path.normalize(g.stdout.trim()) : null; };
        const adminA = adminOf(wta);
        const adminB = adminOf(wtb);
        const ownerOkOf = (name) => { try { const o = C.readOwnerRecord(fxq.control, regQ.lines[name].generation); return !!o && o.name === name; } catch (_) { return false; } };
        check('11.28q.0 前置（注入 B）：qa / qb 都失败于 owner_record，登记 failed；归属记录文件已写（ownerOk 为真）；各自的管理目录在；worktree 目录在',
            !!ra.err && ra.err.step === 'owner_record' && !!rb.err && rb.err.step === 'owner_record' && regQ.lines.qa.lifecycle === 'failed' && regQ.lines.qb.lifecycle === 'failed'
            && ownerOkOf('qa') && ownerOkOf('qb') && adminA !== null && adminB !== null && fs.existsSync(adminA) && fs.existsSync(adminB) && adminA !== adminB && fs.existsSync(wta) && fs.existsSync(wtb),
            { ra: ra.err && ra.err.message, rb: rb.err && rb.err.message, adminA, adminB });
        // 规则第 1 步（qa）：读两个 reflog 文件，收到的每个提交号都建救援分支
        const reflogA = reflogFilesOf(fxq, wta, 'line/qa');
        const oidsA = reflogA.every((f) => fs.existsSync(f)) ? oidsFromReflogFiles(reflogA) : [];
        const rescA = oidsA.map((oid, i) => ({ oid, br: `rescue/qa-${i + 1}`, st: gitRaw(fxq.main, ['branch', `rescue/qa-${i + 1}`, oid]).status }));
        const tipA = git(fxq.main, ['rev-parse', 'refs/heads/line/qa']).trim();
        check('11.28q.1 第 1 步（qa）：读两个 reflog 文件收到提交，线分支尖端在其中，每个都建了救援分支且全部成功', oidsA.length >= 1 && oidsA.includes(tipA) && rescA.length === oidsA.length && rescA.every((x) => x.st === 0), { oidsA, tipA, rescA, reflogA });
        // 模拟「目录已不在、管理目录还在」：先拆联接（本场景没有），再非递归逐项删普通文件与目录
        const dropDir = (wt) => {
            const sc = C.scanTree(fs.realpathSync.native(wt), []);
            const lr = sc.unexpectedLinks.map((p) => psDeleteLink(p).status);
            const left = removeTree(wt);
            return { lr, links: sc.unexpectedLinks.length, mism: sc.mismatches.length, left };
        };
        const dA = dropDir(wta);
        const dB = dropDir(wtb);
        const tpA = psTestPath(wta);
        check('11.28q.2 非递归删掉两个 worktree 目录（无联接、无残留）：Test-Path 对 qa 为 False；两个管理目录仍在；git 仍把两条都列为 worktree',
            dA.lr.every((s) => s === 0) && dA.links === 0 && dA.mism === 0 && dA.left.length === 0 && dB.left.length === 0 && !fs.existsSync(wta) && !fs.existsSync(wtb)
            && tpA.status === 0 && tpA.stdout.trim() === 'False' && fs.existsSync(adminA) && fs.existsSync(adminB)
            && gitRaw(fxq.main, ['worktree', 'list', '--porcelain']).stdout.includes('qa') && gitRaw(fxq.main, ['worktree', 'list', '--porcelain']).stdout.includes('qb'),
            { dA, dB, tp: tpA.stdout });
        // 对照：prune --dry-run -v 会把两条都列出（证明 prune 会连带清掉别的失效登记）；dry-run 本身不改任何东西
        const prune = gitRaw(fxq.main, ['worktree', 'prune', '--dry-run', '-v']);
        const pruneOut = `${prune.stdout}\n${prune.stderr}`;
        check('11.28q.3 对照：`git worktree prune --dry-run -v` 退出码 0，把 qa 与 qb 两条失效登记都列出（prune 会连带）；dry-run 之后两个管理目录都还在', prune.status === 0 && pruneOut.includes(`worktrees/${path.basename(adminA)}`) && pruneOut.includes(`worktrees/${path.basename(adminB)}`) && fs.existsSync(adminA) && fs.existsSync(adminB), { s: prune.status, o: pruneOut });
        // 规则第 3 步（目录已不在）：跳过第 2 步与 status，直接 git worktree remove <本线路径>（不带强制选项）
        const remA = gitRaw(fxq.main, ['worktree', 'remove', wta]);
        const listAfter = gitRaw(fxq.main, ['worktree', 'list', '--porcelain']).stdout;
        check('11.28q.4 直接 `git worktree remove <qa 路径>`（不带强制选项）退出码 0：qa 的管理目录消失；另一条失效登记 qb 的管理目录仍在、git 仍列着 qb（不像 prune 那样连带）',
            remA.status === 0 && !fs.existsSync(adminA) && fs.existsSync(adminB) && !listAfter.includes('qa') && listAfter.includes('qb'), { s: remA.status, e: remA.stderr, listAfter });
        const brA = gitRaw(fxq.main, ['branch', '-d', 'line/qa']);
        const rrmA = await removeLine(fxq, 'qa');
        const regA = await regOf(fxq);
        check('11.28q.5 第 4、5 步（qa）：git branch -d line/qa 退出码 0；line remove qa 成功，登记表里 qa 没了、qb 还在；qa 的救援分支都还在且仍指向原提交',
            brA.status === 0 && !branchExists(fxq, 'line/qa') && rrmA.err === null && !regA.lines.qa && !!regA.lines.qb
            && rescA.every((x) => gitRaw(fxq.main, ['rev-parse', `refs/heads/${x.br}`]).stdout.trim() === x.oid), { bs: brA.status, be: brA.stderr, re: rrmA.err && rrmA.err.message, lines: Object.keys(regA.lines) });
        // qb 走完同样的尾巴，登记清空
        const remB = gitRaw(fxq.main, ['worktree', 'remove', wtb]);
        const brB = gitRaw(fxq.main, ['branch', '-d', 'line/qb']);
        const rrmB = await removeLine(fxq, 'qb');
        check('11.28q.6 qb 同样 git worktree remove <路径> 退出码 0、管理目录消失，git branch -d line/qb 退出码 0，line remove qb 成功，登记空；主工作区完好',
            remB.status === 0 && !fs.existsSync(adminB) && brB.status === 0 && rrmB.err === null && Object.keys((await regOf(fxq)).lines).length === 0 && mainIntact(fxq), { rs: remB.status, re: remB.stderr, bs: brB.status, be: brB.stderr, e: rrmB.err && rrmB.err.message });
    }
    // 11.28r node_modules 绊线（规则第 3 步：列出的路径里有 node_modules 就停，说明还有联接没拆）：worktree 里留一个没拆的 node_modules 目录联接，规则命令必须列出它。
    //   本用例绝不在此状态下执行 git worktree remove（带不带 --force 它都会穿过联接）；联接目标是 mkdtemp 私有目录，测完非递归拆联接、再逐项删目标目录。
    {
        const gitRaw = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 60000 });
        const fxm = await buildFixture('s11nmtrip');
        const wtm = wtOf(fxm, 'nm1');
        const origWm = C.writeOwnerRecord;
        C.writeOwnerRecord = () => { throw new Error('注入：控制根归属记录写入失败'); };
        let rm;
        try { rm = await newLine(fxm, 'nm1', 'm-nm1', {}, []); } finally { C.writeOwnerRecord = origWm; }
        const target = fs.mkdtempSync(path.join(os.tmpdir(), '行线 绊线目标 '));
        w(path.join(target, '哨兵.txt'), 'NM-TRIP-SENTINEL-0005');
        const linkNm = path.join(wtm, 'node_modules');
        fs.symlinkSync(target, linkNm, 'junction');
        const stTrip = ruleStatus(wtm);
        check('11.28r.1 worktree 里留着没拆的 node_modules 联接：规则命令退出码 0，输出里出现含 node_modules 的路径（绊线可触发，规则要求此时停下）；本用例没有执行 worktree remove，联接目标原样',
            !!rm.err && rm.err.step === 'owner_record' && isLink(linkNm) && stTrip.st === 0 && stTrip.nodeMods.length > 0 && rd(path.join(target, '哨兵.txt')) === 'NM-TRIP-SENTINEL-0005' && fs.existsSync(path.join(wtm, '.git')), { st: stTrip.st, entries: stTrip.entries, err: stTrip.err });
        const unl = psDeleteLink(linkNm);
        const stAfter = ruleStatus(wtm);
        const targetOk = rd(path.join(target, '哨兵.txt')) === 'NM-TRIP-SENTINEL-0005';
        const tLeft = removeTree(target);
        check('11.28r.2 非递归拆联接后：退出码 0、联接没了、目标里的哨兵原样；再跑规则命令不再列 node_modules（绊线解除）；私有目标目录逐项清理干净', unl.status === 0 && !isLink(linkNm) && !fs.existsSync(linkNm) && targetOk && stAfter.st === 0 && stAfter.nodeMods.length === 0 && tLeft.length === 0 && !fs.existsSync(target), { us: unl.status, ue: unl.stderr, entries: stAfter.entries, tLeft });
    }

    // ---- 11.26 全部删线场景（进程内 / CLI 子进程 / 工作进程）里记录到的 git 命令汇总：没有 worktree remove / prune ----
    check(`11.26 全部删线场景合计记录到 ${REMOVAL_GIT.length} 条 git 调用（记录器确实在工作），其中 git worktree remove / prune 共 0 条`, REMOVAL_GIT.length > 50 && worktreeRemovalCalls(REMOVAL_GIT).length === 0, { n: REMOVAL_GIT.length, bad: worktreeRemovalCalls(REMOVAL_GIT).slice(0, 3) });
}

async function sec8() {
    section('8', '临时目录清理与泄漏扫描');
    harvestJwts();   // 清理之前把仍存在的线（含 CLI / 工作进程建的）的随机 JWT 收齐
    for (const root of ALL_ROOTS) {
        const left = removeTree(root);
        check(`8.1 临时目录逐项删除干净：${path.basename(root)}`, left.length === 0 && C.pathGone(root), left.slice(0, 5));
    }
    const text = ALL_OUT.join('\n');
    const secrets = [...LEAK_STRINGS, ...DYN_SECRETS];
    // 注意：10.18 系列故意让被测代码抛出含秘密的错误，被测输出里只允许出现 [已脱敏]；本脚本自己的失败详情若打印了原值也会在这里被抓到
    const hits = secrets.filter((s) => text.includes(s));
    check('8.2 全部输出（被测输出、子进程输出、全程捕获的 console、工作进程业务输出与错误、异常文本）里搜不到任何手写秘密或任何一条线的随机 JWT', hits.length === 0, hits);
    // 8.3 脱敏证据只在实际执行了产生它的章节（节 10 的 10.18 系列）时要求；--only 子集不要求，也不再有固定的输出条数门槛
    if (RAN.has('10')) check('8.3 脱敏确实发生过（节 10 的 10.18 系列执行了，语料里必须出现 [已脱敏]）', text.includes('[已脱敏]'));
    check('8.4 语料非空（捕获通道本身在工作）', ALL_OUT.length > 0 && DYN_SECRETS.length >= (RAN.has('1') ? 1 : 0), { out: ALL_OUT.length, dyn: DYN_SECRETS.length });
}

// ================================================================ 入口

if (WORKER_ARG) {
    const spec = JSON.parse(Buffer.from(WORKER_ARG.slice('--worker='.length), 'base64').toString('utf8'));
    workerMain(spec).then(() => process.exit(0), (e) => { console.error(String(e && e.stack)); process.exit(1); });
} else {
    process.exitCode = 1;   // 守卫挂起 / 提前退出必须非零；只有跑到汇总且 FAIL=0 才置 0
    (async () => {
        const secs = [['1', sec1], ['2', sec2], ['3', sec3], ['4', sec4], ['5', sec5], ['6', sec6], ['7', sec7], ['9', sec9], ['10', sec10], ['11', sec11]];
        try {
            for (const [id, fn] of secs) {
                if (ONLY && !ONLY.has(id)) continue;
                RAN.add(id);
                try { await fn(); } catch (e) { FAIL += 1; FAILS.push(`节 ${id} 异常`); log(`  FAIL  节 ${id} 抛出未捕获异常：${e && e.stack ? e.stack : e}`); }
            }
        } finally {
            try { await sec8(); } catch (e) { FAIL += 1; FAILS.push('节 8 异常'); log(`  FAIL  节 8 异常：${e && e.stack ? e.stack : e}`); }
        }
        console.log(`\n汇总：PASS=${PASS} FAIL=${FAIL}${FAILS.length ? `\n失败项：\n  ${FAILS.join('\n  ')}` : ''}`);
        if (FAIL === 0) process.exitCode = 0;
    })();
}
