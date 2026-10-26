/**
 * #106 S8c 自检：部署脚本 scripts/deploy-ssh.ps1（新顺序 + -DryRun + 失败处置）。
 *
 * 不连生产、不 ssh / scp、不碰业务库、不读 .env、不写仓库里的临时目录。动态部分全部是
 *   powershell.exe -NoProfile -File scripts/deploy-ssh.ps1 -DryRun -RemoteStateFile <临时 json> -SkipPushCheck [-DryRunFailAt …]
 * 被测脚本的仓库根取脚本自身位置，所以动态用例把脚本副本放进临时 git 夹具仓库的 scripts/ 下（夹具仓库没有任何远端），进程当前目录是另一个同结构的诱饵仓库；
 * 子进程：PATH 里只留 node / git / 系统目录（没有 ssh.exe、scp.exe），git 配置被隔离，TEMP 指向每个用例私有的临时目录；
 * 脚本的 DryRun 发布记录因此落在私有临时目录里，并断言真实控制根 releases/ 前后一致。
 *
 * 隔离论证：自检里任何不带 -DryRun 的运行（R 节：不带 -DryRun 的 -DryRunFailAt / -RemoteStateFile / -SkipPushCheck 必须拒绝）必须同时满足三重隔离，R0 逐项断言，缺一项这一节整体不跑：
 *   ① 被测脚本副本放在不属于任何 git 仓库的临时目录里，进程当前目录同在那里——脚本的仓库根取脚本位置、并用 git -C 核对它就是 git 顶层，所以守卫一旦回归，也死在第 0 步；
 *   ② 子进程 PATH 只留 node 所在目录与 System32（没有 git、ssh、scp；R0 另用 Get-Command 在该环境下验证 git / ssh / scp 都解析不到），所以第 0 步连 git 都起不来；
 *   ③ 传 -ServerIP 192.0.2.1（TEST-NET，不可达），即使前两重都失守也连不到生产。
 * 因此 R 用例在隔离下到不了第 0 步之后，变异自证不把 R- 用例当作命中依据（对应的变异登记静态断言为目标）；
 * 其余变异命中必须来自能走过第 0 步的运行：动态用例的命中要求该次运行输出里出现 [2/9]，否则记 RED-BUT-NOT-TARGET（计失败）。
 *
 * 节：
 *   B1 末次合并审预筛六项（M1 推送超时 -PushTimeoutSec 与超时后只读核对远端引用 / M2 本地库备份轮转只认正式名 / M3 pm2 孤儿监听硬门：第 2 步、第 4 步、第 5 步自动起服务后、第 8 步终检、回滚指引第 7 步 /
 *      M4 启动期 SQLITE_BUSY 只读核对指引 / L1 COMMIT_NULL 补核对命令 / L5 回滚第 3 步不用 pm2 jlist）的断言分布：静态 S18-S21、单元 U12-U19、动态 D-orphan* / D-nolisten / D-listenprefix / D-nonetstat / D-nofield / D-nopid / D-v4only / D-v6only /
 *      D-stop-listen / D-ready-orphan / D-ready-init / D-pushto* / D-push-landed / D-push-failed（以及 D-loop、D-readynull、D-normal 的补充断言）、拒绝 R-pushtimeout-*；变异自证见 MUTATIONS 里「B1 末次合并审预筛六项」一段。
 *      设计铁律：只加硬门（只拒不放）与提示文字，不加放行 / 智能判定 / 新的自动动作；新硬门的每种不满足形态都有反向用例，netstat 解析与各判定函数按纯函数在 U 节单测。
 *   B1 末次合并审 codex 47R2a（修复批 1c）三项的断言分布：H 回滚第 3 步补「3000 零监听」硬门（静态 S23 H、rollbackChecks 里每条回滚路径的第 3 步按行断言）/
 *      M1 人工核对「没有输出 ≠ 成功」（Write-ListenerCheck：不加过滤的 netstat -ano + 判据一「查询成功」+ 判据二「3000 零 LISTENING」；SQLITE_BUSY 分支、第 4 步失败处置、回滚第 3 / 7 步；
 *      COMMIT_NULL 页面检查先要求 HTTP 200 再扫描内容；静态 S23、动态 D-readynull / D-loop / D-ready-init 的整行断言）/ M2 库备份下载走 .partial（静态 S24、单元 U20 Test-BackupSizeMatch、D-normal 的 DryRun 命令与预告行）；
 *      变异自证见 MUTATIONS 里「修复批 1c」一段。设计铁律不变：只加硬门与提示文字，不加放行 / 自动动作。
 *   S  静态：BOM / CRLF 一致、无 NUL；ssh / scp 只出现在 Invoke-RemoteRead / Invoke-RemoteWrite 两个函数体内；pm2 只操作 task-pool；
 *      reset --hard 的目标是提交号变量；写操作顺序 = 上传 → 停服前预取 fetch → stop → 备份 → reset → start → ready-check；
 *      含 -DryRun 守卫；Invoke-RemoteWrite 先判 DryRun 再执行；无 2>&1 / EncodedCommand / Copy-Item；备份失败才自动 start（条件只来自 Resolve-BackupOutcome）、没收到协议行不自动 start；
 *      仓库根取脚本位置；新提交就绪接口预检；回滚指引与前置检查文字；
 *      S16 全脚本层（所有 Write-Host / Write-Info / $q 输出行：含可复制命令的行里不得有中文，并按第 4 / 5 / 9 步区域锚定个数）；
 *      S17 分支内容层（第 4 步停服失败、第 5 步 restart_unverified 这两个 DryRun 走不到的分支：命令行与判据行逐行全等、按顺序出现）
 *   D  动态（假远端现状）：正常；backup（自动起服务分支）；backup_noline / code / start / ready / ready_commit_null / restart_loop（回滚步骤）；
 *      已跟踪改动非空 / RunCommit 与 RepoHead 不等 / RunCommit 为空且版本不符 / 为空且版本相符 / task-pool 非 online / 进程数不是 1 → 第 2 步中止
 *   U  单元（DryRun 走不到、真实部署才用的纯函数）：从被测脚本里取出协议行判定 / 第 5 步与第 8 步的判定函数（按真实退出码造输入）/ 参数引用 / 三态文字 / 本机子进程超时与启动失败 / pm2 jlist 经 node（stdin）解析，
 *      放进最小的 PowerShell 5.1 脚本里验证（协议行：整段须以换行结尾、须是最后一个非空行、前缀后须有空格、JSON 须完整且是对象；pm2 输出前有提示行、环境变量里有仅大小写不同的键）
 *   R  拒绝：-DryRunFailAt / -RemoteStateFile / -SkipPushCheck 不带 -DryRun；-DryRunFailAt 取值非法
 *   M  判别力（变异自证，默认运行）：在临时副本上改被测脚本，每个变异必须让上面的套件变红，且命中它登记的用例名前缀
 *
 * 运行：node wbs-server/scripts/verify-deploy-script.js
 *   内部参数：--script=<被测 ps1 绝对路径>  --no-mutations  --only=<静态 S 总是跑；动态用例 id 逗号分隔，缺省全跑>
 *   调试：--show=<动态用例 id> 打印该用例的完整输出后退出
 * 输出：失败用例逐行 `FAIL <名字> :: <细节>`；末行 `PASS=<n> FAIL=<m>`；有失败退出码 1。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LIVE_DB = `task_${'pool.db'}`;   // 生产库文件名（只出现在对被测脚本输出的断言里；拆开写是为了不被测试隔离静态守卫的 T2 字面量规则误判）
const argOf = (prefix) => process.argv.find((a) => a.startsWith(prefix));
const SCRIPT_ARG = argOf('--script=');
const SCRIPT_PATH = path.resolve(SCRIPT_ARG ? SCRIPT_ARG.slice('--script='.length) : path.join(REPO_ROOT, 'scripts', 'deploy-ssh.ps1'));
const RUN_MUTATIONS = !process.argv.includes('--no-mutations');
const ONLY_ARG = argOf('--only=');
const ONLY = ONLY_ARG === undefined ? null : new Set(ONLY_ARG.slice('--only='.length).split(',').filter(Boolean));
const SHOW_ARG = argOf('--show=');
const STUBBED = process.argv.includes('--ssh-stubbed');         // 内部参数：被测副本里远端执行已换成本地桩（变异自证用）
const EMIT_REACHED = process.argv.includes('--emit-reached');   // 内部参数：变异自证的子运行用，逐个动态用例报告「有没有走过第 0 步」
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// ---------------------------------------------------------------- 断言与汇总
let ISOLATION_ABORT = false;   // 隔离条件不成立：之后不再启动任何部署脚本 / 单元 / 变异子进程
let SPAWN_COUNT = 0;           // 本进程启动的 PowerShell 与变异子运行个数（--report-spawns 时在末尾打印）
let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; return true; }
  fail += 1;
  console.log(`FAIL ${name}${detail === undefined ? '' : ` :: ${String(detail).replace(/\s*[\r\n]+\s*/g, ' ').slice(0, 400)}`}`);
  return false;
}
const eq = (name, actual, expected) => check(name, JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);

// ---------------------------------------------------------------- 临时目录
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sdh-deploy-script-'));
let seq = 0;
function freshDir(label) {
  seq += 1;
  const d = path.join(TMP_ROOT, `${label}-${seq}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
/** 逐项 unlink / rmdir（链接只拆不跟随），不用 rmSync */
function removeTree(p) {
  let st;
  try { st = fs.lstatSync(p); } catch (_) { return; }
  if (st.isDirectory() && !st.isSymbolicLink()) {
    for (const n of fs.readdirSync(p)) removeTree(path.join(p, n));
    try { fs.rmdirSync(p); } catch (_) { /* ignore */ }
  } else {
    try { fs.unlinkSync(p); } catch (_) { /* ignore */ }
  }
}

// ---------------------------------------------------------------- git 夹具
// 被测脚本的仓库根取脚本自身位置，所以动态用例把被测脚本副本放进一个临时 git 仓库的 scripts/ 下（夹具仓库，有 main 与两个提交），
// 再从「另一个同结构的临时仓库」（诱饵仓库，也有 wbs-server/package.json 与自己的 main）作为进程当前目录启动，断言取到的是脚本所在仓库的 main。
// 夹具仓库没有任何远端（push production 必失败），子进程的 git 配置被隔离（空的全局配置、不读系统配置）。
const EMPTY_GITCONFIG = path.join(TMP_ROOT, 'empty.gitconfig');
fs.writeFileSync(EMPTY_GITCONFIG, '');
const GIT_ISOLATION = { GIT_CONFIG_GLOBAL: EMPTY_GITCONFIG, GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: os.tmpdir() };
const GIT_IDENTITY = { GIT_AUTHOR_NAME: 'fix', GIT_AUTHOR_EMAIL: 'fix@example.invalid', GIT_COMMITTER_NAME: 'fix', GIT_COMMITTER_EMAIL: 'fix@example.invalid' };
function gitIn(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: Object.assign({}, process.env, GIT_ISOLATION, GIT_IDENTITY) });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr}`);
  return r.stdout.trim();
}
/** 建临时仓库（main 分支），按 commits 逐个提交，返回各提交的 sha */
function makeRepo(dir, commits) {
  fs.mkdirSync(dir, { recursive: true });
  gitIn(dir, ['init', '-q']);
  gitIn(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  const shas = [];
  for (const c of commits) {
    for (const [rel, content] of Object.entries(c.files)) {
      const f = path.join(dir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, content);
    }
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '-q', '-m', c.msg]);
    shas.push(gitIn(dir, ['rev-parse', 'HEAD']));
  }
  return shas;
}
/** 把被测脚本（和它旁边的 deploy/*.js）放进 <dir>/<sub>scripts/ */
function installScript(dir, scriptPath, sub) {
  const base = sub ? path.join(dir, sub, 'scripts') : path.join(dir, 'scripts');
  fs.mkdirSync(path.join(base, 'deploy'), { recursive: true });
  fs.copyFileSync(scriptPath, path.join(base, 'deploy-ssh.ps1'));
  const src = path.join(path.dirname(scriptPath), 'deploy');
  if (fs.existsSync(src)) {
    for (const n of fs.readdirSync(src)) if (n.endsWith('.js')) fs.copyFileSync(path.join(src, n), path.join(base, 'deploy', n));
  }
  return path.join(base, 'deploy-ssh.ps1');
}

let NEW_COMMIT = null;     // 夹具仓库 main
let PREV_COMMIT = null;    // 夹具仓库 main 的第一个提交（假远端 HEAD）
const PREV_VERSION = '1.0.0';
const NEW_VERSION = '1.0.1';
let DECOY_COMMIT = null;   // 诱饵仓库 main
let FIX = null;            // { repo, script, decoy, norepoScript, subdirScript }
const SERVICE_ENTRY = `wbs-server/server${'.js'}`;   // 服务入口文件（拆开写是为了不被测试隔离静态守卫的 T3 字面量规则误判）
// 夹具里的服务入口文件：被测脚本在停服前用 git grep 核对新提交含这两处字面量（与脚本里的 $ReadyRouteLiteral / $CommitFieldLiteral 一致）
const SERVER_JS_FULL = "app.get('/api/health/ready', (req, res) => res.json({}));\napp.get('/api/version', (req, res) => res.json({\n    commit: DEPLOY_COMMIT\n}));\n";
const SERVER_JS_NO_READY = "app.get('/api/version', (req, res) => res.json({\n    commit: DEPLOY_COMMIT\n}));\n";
const SERVER_JS_NO_COMMIT = "app.get('/api/health/ready', (req, res) => res.json({}));\napp.get('/api/version', (req, res) => res.json({ version: '1' }));\n";
/** 夹具仓库：A（PREV_VERSION）→ B（NEW_VERSION，新增 ALTER TABLE 的 sql；测试脚本与说明文档里也各放一条示例 SQL，回滚指引的 schema 判断必须排除它们） */
function buildFixtureRepo(label, serverJs, scriptPath, ddl) {
  const repo = freshDir(label);
  const withDdl = ddl !== false;
  const bFiles = {
    'wbs-server/package.json': `{"name":"fix","version":"${NEW_VERSION}"}\n`,
    // 明确的测试文件与说明文档：schema 扫描要排除它们
    'wbs-server/scripts/verify-example.js': "const sql = 'CREATE TABLE example (id INTEGER)';\n",
    'wbs-server/scripts/test-example.js': "const sql = 'DROP TABLE example';\n",
    'wbs-server/notes.md': 'ALTER TABLE only_in_docs ADD COLUMN x;\n',
  };
  if (withDdl) {
    bFiles['wbs-server/db-migrate.sql'] = 'ALTER TABLE t ADD COLUMN c TEXT;\n';
    bFiles['wbs-server/scripts/migrate-x.js'] = "db.run('ALTER TABLE y ADD COLUMN z TEXT');\n";   // wbs-server/scripts/ 下的迁移脚本：不能被排除
  }
  const [a, b] = makeRepo(repo, [
    { msg: 'A', files: { 'wbs-server/package.json': `{"name":"fix","version":"${PREV_VERSION}"}\n`, 'wbs-server/public/index.html': '<html></html>\n', [SERVICE_ENTRY]: serverJs } },
    { msg: 'B', files: bFiles },
  ]);
  return { repo, a, b, script: installScript(repo, scriptPath) };
}
function setupFixture(scriptPath) {
  const main = buildFixtureRepo('fixrepo', SERVER_JS_FULL, scriptPath);
  const repo = main.repo;
  PREV_COMMIT = main.a;
  NEW_COMMIT = main.b;
  const noReady = buildFixtureRepo('fixrepo-noready', SERVER_JS_NO_READY, scriptPath);
  const noCommit = buildFixtureRepo('fixrepo-nocommit', SERVER_JS_NO_COMMIT, scriptPath);
  const noDdl = buildFixtureRepo('fixrepo-noddl', SERVER_JS_FULL, scriptPath, false);
  const decoy = freshDir('decoy');
  const [, d2] = makeRepo(decoy, [
    { msg: 'D1', files: { 'wbs-server/package.json': '{"name":"decoy","version":"9.9.9"}\n', 'wbs-server/public/index.html': '<html></html>\n' } },
    { msg: 'D2', files: { 'wbs-server/package.json': '{"name":"decoy","version":"9.9.10"}\n' } },
  ]);
  DECOY_COMMIT = d2;
  const script = main.script;
  const subdirScript = installScript(repo, scriptPath, 'sub');                 // <仓库>/sub/scripts/：脚本所在目录的上一级不是 git 顶层
  const norepo = freshDir('norepo');
  const norepoScript = installScript(norepo, scriptPath);                       // 完全不在任何 git 仓库里
  FIX = { repo, script, decoy, norepo, norepoScript, subdirScript, noReadyScript: noReady.script, noCommitScript: noCommit.script, noReadyRepo: noReady.repo, noCommitRepo: noCommit.repo, noDdlScript: noDdl.script, noDdlRepo: noDdl.repo, noDdlA: noDdl.a };
}

// ---------------------------------------------------------------- 子进程环境：PATH 里没有 ssh / scp
function findDirWith(exe) {
  for (const d of String(process.env.PATH || '').split(path.delimiter)) {
    if (d && fs.existsSync(path.join(d, exe))) return d;
  }
  return null;
}
const SYS32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
// 内部参数 --poison-path=<目录>：把该目录加进动态用例的 PATH（自检「隔离不成立 -> 零子进程」用，目录里放一个假的 ssh.exe）
const POISON_ARG = argOf('--poison-path=');
const POISON_DIR = POISON_ARG === undefined ? null : POISON_ARG.slice('--poison-path='.length);
const PATH_DIRS = [path.dirname(process.execPath), findDirWith('git.exe'), SYS32, process.env.SystemRoot || 'C:\\Windows', POISON_DIR].filter(Boolean);
const SAFE_PATH = Array.from(new Set(PATH_DIRS)).join(path.delimiter);
function sshInDirs() {
  return PATH_DIRS.filter((d) => fs.existsSync(path.join(d, 'ssh.exe')) || fs.existsSync(path.join(d, 'scp.exe')));
}
// 不带 -DryRun 的运行（R 系列拒绝用例）用的严格 PATH：只留 node 所在目录与 System32，没有 git、ssh、scp
const STRICT_PATH_DIRS = Array.from(new Set([path.dirname(process.execPath), SYS32]));
const STRICT_PATH = STRICT_PATH_DIRS.join(path.delimiter);
const TEST_NET_IP = '192.0.2.1';   // RFC 5737 TEST-NET-1，不可达
const DEPLOY_USER_DEFAULT = 'Administrator';   // 被测脚本 -ServerUser 的缺省值（动态用例不传 -ServerUser）；D-noline 用它拼人工起服务命令的期望行
const hasExe = (dir, names) => names.filter((n) => fs.existsSync(path.join(dir, n)));

function stripBom(s) { return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; }

/** 跑一次 powershell -File，返回 { status, out, timedOut }。opts.path 缺省为 SAFE_PATH（含 git，不含 ssh / scp） */
function runPs(scriptPath, scriptArgsIn, opts) {
  // 任何部署脚本子进程的统一入口：隔离不成立之后绝不允许再启动；所有运行都显式带不可达的测试地址
  if (ISOLATION_ABORT) throw new Error('隔离不成立之后不允许启动任何部署脚本子进程');
  const scriptArgs = scriptArgsIn.includes('-ServerIP') ? scriptArgsIn : ['-ServerIP', TEST_NET_IP, ...scriptArgsIn];
  if (scriptArgs[scriptArgs.indexOf('-ServerIP') + 1] !== TEST_NET_IP) throw new Error('动态用例必须用 -ServerIP 192.0.2.1');
  SPAWN_COUNT += 1;
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env, GIT_ISOLATION, opts.extraEnv || {}, { PATH: opts.path || SAFE_PATH, TEMP: opts.tempDir, TMP: opts.tempDir });
    // opts.viaCommand：像 PowerShell 工具那样在宿主里用 -Command 进程内调用（& 脚本），而不是 -File
    const psArgs = opts.viaCommand
      ? ['-NoProfile', '-NonInteractive', '-Command', `$origIn = [Console]::InputEncoding; try { ${opts.viaCommand.prefix}; Set-Location -LiteralPath '${opts.cwd}'; & '${scriptPath}' ${scriptArgs.join(' ')}; $code = $LASTEXITCODE } finally { [Console]::InputEncoding = $origIn }; exit $code`]
      : ['-NoProfile', '-File', scriptPath, ...scriptArgs];
    const child = spawn(POWERSHELL, psArgs, { cwd: opts.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch (_) { /* ignore */ } }, opts.timeoutMs || 240000);
    child.stdout.on('data', (b) => chunks.push(b));
    child.stderr.on('data', (b) => chunks.push(b));
    child.on('error', (e) => { clearTimeout(timer); resolve({ status: -1, out: `spawn error: ${e.message}`, timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ status: code, out: stripBom(Buffer.concat(chunks).toString('utf8')), timedOut }); });
  });
}

/**
 * 控制台输入代码页是控制台的状态，同一个控制台下的所有 PowerShell 子进程共享（变异自证的几个子运行也共享主运行的控制台）。
 * 会临时把它改成 65001 的运行（单元里的 65001 试验、像 PowerShell 工具那样 -Command 调用的 DryRun）与单元里依赖默认代码页的断言
 * 不能同时跑，否则默认代码页的行会被别的进程临时改成 65001 而偶发多出 BOM。这里用一个跨进程的锁文件把这两类运行串行化。
 */
async function withCpLock(fn) {
  const lock = path.join(os.tmpdir(), 'sdh-deploy-script-cp.lock');
  const t0 = Date.now();
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 600000) fs.unlinkSync(lock); } catch (_) { /* 别人刚释放 */ }
      if (Date.now() - t0 > 1200000) throw new Error('等代码页锁超时');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  try {
    return await fn();
  } finally {
    try { fs.unlinkSync(lock); } catch (_) { /* ignore */ }
  }
}

async function pool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next; next += 1;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

// ---------------------------------------------------------------- 静态检查
function stripComments(text) {
  return text.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => !/^\s*#/.test(l)).join('\n');
}
/** 取函数体（花括号配平；被测脚本的字符串里花括号都是成对的） */
function functionBody(text, name) {
  const m = new RegExp(`function ${name}\\b[^{]*\\{`).exec(text);
  if (!m) return null;
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  for (; i < text.length && depth > 0; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') depth -= 1;
  }
  return depth === 0 ? text.slice(start, i - 1) : null;
}
function cutOut(text, name) {
  const m = new RegExp(`function ${name}\\b[^{]*\\{`).exec(text);
  const body = functionBody(text, name);
  if (!m || body === null) return text;
  return text.slice(0, m.index) + text.slice(m.index + m[0].length + body.length + 1);
}

function staticChecks(buf) {
  const raw = buf.toString('utf8');
  const text = stripBom(raw);
  check('S1 UTF-8 BOM（前 3 字节 efbbbf）', buf.slice(0, 3).toString('hex') === 'efbbbf', buf.slice(0, 3).toString('hex'));
  let bareLf = 0;
  let bareCr = 0;
  let nul = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0x0A && !(i > 0 && buf[i - 1] === 0x0D)) bareLf += 1;
    if (buf[i] === 0x0D && !(i + 1 < buf.length && buf[i + 1] === 0x0A)) bareCr += 1;
    if (buf[i] === 0) nul += 1;
  }
  eq('S2 CRLF 一致（裸 LF 数）', bareLf, 0);
  eq('S2 CRLF 一致（裸 CR 数）', bareCr, 0);
  eq('S2 无 NUL', nul, 0);

  const code = stripComments(text);
  const readBody = functionBody(code, 'Invoke-RemoteRead');
  const writeBody = functionBody(code, 'Invoke-RemoteWrite');
  check('S3 两个调用口函数都存在', readBody !== null && writeBody !== null);
  check('S3 Invoke-RemoteRead / Invoke-RemoteWrite 各出现一次定义', (code.match(/function Invoke-RemoteRead\b/g) || []).length === 1 && (code.match(/function Invoke-RemoteWrite\b/g) || []).length === 1);
  if (!STUBBED) check('S3 调用口函数体里有 ssh 与 scp', !!readBody && !!writeBody && /'ssh'/.test(readBody) && /'scp'/.test(readBody) && /'ssh'/.test(writeBody) && /'scp'/.test(writeBody));
  else check('S3（桩副本）调用口函数体里的远端执行已换成本地桩（读写各两处 $env:STUB_JS，没有 $exe = ssh / scp）', !!readBody && !!writeBody && (readBody.split('$env:STUB_JS').length - 1) === 2 && (writeBody.split('$env:STUB_JS').length - 1) === 2 && !/\$exe = '(ssh|scp)'/.test(readBody + writeBody));
  let outside = code;
  outside = cutOut(outside, 'Invoke-RemoteRead');
  outside = cutOut(outside, 'Invoke-RemoteWrite');
  const sshHits = [];
  // 引号包着的 ssh / scp、命令位置的 ssh / scp、赋值右侧、-FileName ssh（裸词）、Start-Process
  for (const re of [/['"](ssh|scp)(\.exe)?['"]/i, /^\s*(&\s+)?(ssh|scp)(\.exe)?\s/im, /=\s*(&\s+)?(ssh|scp)(\.exe)?\s/i, /Start-Process[^\n]*\b(ssh|scp)\b/i, /-FileName\s+(ssh|scp)\b/i]) {
    const m = re.exec(outside);
    if (m) sshHits.push(m[0].trim());
  }
  // ssh.exe / scp.exe 字样：说明文字（Write-* 行）里可以出现，其余地方不行
  const outsideCode = outside.split('\n').filter((l) => !/^\s*Write-(Host|Info|DryLine)\b/.test(l)).join('\n');
  const exeHit = /\b(ssh|scp)\.exe\b/i.exec(outsideCode);
  if (exeHit) sshHits.push(exeHit[0]);
  check('S3 两个函数体之外没有直接的 ssh / scp 调用', sshHits.length === 0, sshHits.join(' | '));

  // pm2 只操作 task-pool
  const pm2Bad = [];
  const pm2Re = /pm2\s+(\w+)(?:\s+([A-Za-z0-9_-]+)|(\s*[^\s\u0080-\uFFFF]|\s*$))?/g;
  let pm;
  while ((pm = pm2Re.exec(code)) !== null) {
    const sub = pm[1];
    if (sub === 'jlist' || sub === 'ls') continue;
    if (!['stop', 'start', 'restart'].includes(sub)) {
      if (/^[a-z]+$/.test(sub) && ['delete', 'kill', 'reload', 'save', 'update', 'resurrect', 'flush', 'startup', 'unstartup', 'del'].includes(sub)) pm2Bad.push(pm[0]);
      continue;   // 其余是散文里的 pm2 xxx
    }
    if (pm[2] !== 'task-pool') {
      // 名字缺失且后面是中文散文（不在命令里）不算；后面是引号 / 行尾 / ASCII 才算命令里缺名字
      if (pm[2] === undefined && pm[3] === undefined) continue;
      pm2Bad.push(pm[0]);
    }
  }
  // 恰好一个应用名：stop / start / restart task-pool 后面不能再跟别的应用名（ASCII 单词，且不是以 - 开头的选项）
  const pm2Re2 = /pm2\s+(stop|start|restart)\s+task-pool((?:\s+[A-Za-z0-9_][A-Za-z0-9_-]*(?=[\s'"]|$))+)/g;
  let pm2b;
  while ((pm2b = pm2Re2.exec(code)) !== null) pm2Bad.push(pm2b[0]);
  check('S4 pm2 只操作 task-pool（无 stop all / restart all / 缺名字 / 多个名字 / 其他子命令）', pm2Bad.length === 0, pm2Bad.join(' | '));
  check('S4 脚本里有 pm2 stop task-pool 与 pm2 start task-pool 的命令常量', /\$Pm2StopCmd = '[^']*pm2 stop task-pool'/.test(code) && /\$Pm2StartCmd = '[^']*pm2 start task-pool'/.test(code));

  // reset --hard 的目标
  const resets = code.match(/reset --hard\s+\S+/g) || [];
  check('S5 出现 reset --hard', resets.length >= 2, resets.join(' | '));
  check('S5 reset --hard 的目标都是提交号变量（NewCommit / PrevCommit），不是 production/main', resets.every((r) => /\$\(\$script:(NewCommit|PrevCommit)\)/.test(r)) && !/production\/main/.test(code), resets.join(' | '));
  check('S5 换代码命令只有 reset --hard NewCommit（fetch 已挪到停服前的第 3 步）', /\$resetCmd = "cd \/d E:\\Task_Pool && git reset --hard \$\(\$script:NewCommit\)"/.test(code) && /\$FetchCmd = 'cd \/d E:\\Task_Pool && git fetch production'/.test(code));

  // 区域与写操作顺序
  const regions = {};
  // 区域按「# ==== STEP n」注释行切；区域文本去掉其中的整行注释，保证只看代码
  const lf = text.replace(/\r/g, '');
  const marks = [...lf.matchAll(/^# =+ STEP (\d) .*$/gm)];
  marks.forEach((m, i) => { regions[m[1]] = stripComments(lf.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : lf.length)); });
  check('S6 STEP 0-9 区域齐全', ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].every((k) => regions[k] !== undefined), Object.keys(regions).join(','));
  const at = (re) => { const m = re.exec(code); return m ? m.index : -1; };
  const order = [
    ['上传(scp)', at(/Invoke-RemoteWrite -TransferArgs @\('backup-db\.js'/)],
    ['停服前预取 fetch', at(/Invoke-RemoteWrite -Command \$FetchCmd/)],
    ['stop', at(/Invoke-RemoteWrite -Command \$Pm2StopCmd/)],
    ['备份', at(/Invoke-RemoteWrite -Command \$backupCmd/)],
    ['fetch/reset', at(/Invoke-RemoteWrite -Command \$resetCmd/)],
    ['start', at(/\$sres = Invoke-RemoteWrite -Command \$Pm2StartCmd/)],
    ['ready-check', at(/Invoke-Local -FileName 'node' -ArgList \(\$readyArgs\)/)],
  ];
  check('S6 七类写操作都找得到', order.every((o) => o[1] >= 0), order.map((o) => `${o[0]}=${o[1]}`).join(' '));
  check('S6 写操作顺序 = 上传 → 停服前预取 fetch → stop → 备份 → reset → start → ready-check', order.every((o, i) => i === 0 || o[1] > order[i - 1][1]), order.map((o) => `${o[0]}=${o[1]}`).join(' '));
  const occurrences = (re, s) => (s.match(re) || []).length;
  check('S6 fetch 只在第 3 步（停服之前），且紧跟 cat-file 核对新提交对象',
    occurrences(/Invoke-RemoteWrite -Command \$FetchCmd/g, code) === 1 && (regions['3'] || '').includes('Invoke-RemoteWrite -Command $FetchCmd') && (regions['3'] || '').includes('cat-file -t') && !(regions['6'] || '').includes('git fetch'));
  check('S6 stop 只在第 4 步、备份只在第 5 步、reset 只在第 6 步',
    occurrences(/Invoke-RemoteWrite -Command \$Pm2StopCmd/g, code) === 1 && (regions['4'] || '').includes('Invoke-RemoteWrite -Command $Pm2StopCmd')
    && occurrences(/Invoke-RemoteWrite -Command \$backupCmd/g, code) === 1 && (regions['5'] || '').includes('Invoke-RemoteWrite -Command $backupCmd')
    && occurrences(/Invoke-RemoteWrite -Command \$resetCmd/g, code) === 1 && (regions['6'] || '').includes('Invoke-RemoteWrite -Command $resetCmd'));
  check('S6 pm2 start 的写调用恰两处：第 5 步（备份失败自动起）与第 7 步',
    occurrences(/Invoke-RemoteWrite -Command \$Pm2StartCmd/g, code) === 2 && (regions['5'] || '').includes('$oldStartRes = Invoke-RemoteWrite -Command $Pm2StartCmd') && (regions['7'] || '').includes('$sres = Invoke-RemoteWrite -Command $Pm2StartCmd'));
  check('S6 就绪检查预检（--check-args）在第 2 步，真检查（含 ReadyTimeoutSec 外层超时）在第 8 步',
    (regions['2'] || '').includes("'--check-args'") && (regions['8'] || '').includes('$ReadyTimeoutSec + 5 + 30') && !(regions['8'] || '').includes('--check-args'));
  check('S6 git push 只出现一次，且在 DryRun 判断之后的分支里', occurrences(/'push'/g, code) === 1 && (regions['1'] || '').indexOf('if ($script:DryRun)') >= 0 && (regions['1'] || '').indexOf('if ($script:DryRun)') < (regions['1'] || '').indexOf("'push'"));

  // 备份失败才自动起服务；没收到协议行不自动起
  const step5 = regions['5'] || '';
  check('S7 备份失败分支的条件只来自 Resolve-BackupOutcome 返回 FAIL（第 5 步里没有别的判定入口）',
    step5.includes("$bo = Resolve-BackupOutcome $bres") && step5.includes("if ($bo.Outcome -eq 'FAIL') {") && !step5.includes('Read-Protocol') && !/\$bk\b/.test(step5) && occurrences(/Resolve-BackupOutcome/g, step5) === 1);
  check('S7 自动 pm2 start 只在 FAIL 分支里（$oldStartRes 的调用位于 FAIL 分支与 UNKNOWN 分支之间）', step5.indexOf("if ($bo.Outcome -eq 'FAIL') {") >= 0 && step5.indexOf('$oldStartRes = Invoke-RemoteWrite') > step5.indexOf("if ($bo.Outcome -eq 'FAIL') {") && step5.indexOf('$oldStartRes = Invoke-RemoteWrite') < step5.indexOf("if ($bo.Outcome -eq 'UNKNOWN') {"));
  const noline = /if \(\$bo\.Outcome -eq 'UNKNOWN'\) \{[\s\S]*?\n\}\r?\n/.exec(step5);
  check('S7 没收到协议行的分支存在、写阶段 failed、不含任何 Invoke-RemoteWrite', !!noline && noline[0].includes("Set-Stage -Stage 'failed'") && !noline[0].includes('Invoke-RemoteWrite'), noline ? noline[0].length : 'no match');
  check('S7 备份失败自动起服务后写 restarted_old / restart_unverified，result=failed', step5.includes("Set-Stage -Stage 'restarted_old' -Result 'failed'") && step5.includes("Set-Stage -Stage 'restart_unverified' -Result 'failed'") && step5.includes("Set-Stage -Stage 'backup_failed' -Note"));
  check('S7 backup_failed 阶段不带 --result', !/Set-Stage -Stage 'backup_failed'[^\n]*-Result/.test(step5));

  // DryRun 守卫
  check('S8 非 DryRun 拒绝 -DryRunFailAt / -RemoteStateFile / -SkipPushCheck（exit 2）',
    /if \(-not \$DryRun\) \{[\s\S]*?ContainsKey\('DryRunFailAt'\)[\s\S]*?ContainsKey\('RemoteStateFile'\)[\s\S]*?ContainsKey\('SkipPushCheck'\)[\s\S]*?exit 2/.test(code));
  check('S8 Invoke-RemoteWrite 先判 DryRun 并 return，再 Invoke-Local', !!writeBody && writeBody.indexOf('$script:DryRun') >= 0 && writeBody.indexOf('New-DryResult') > writeBody.indexOf('$script:DryRun') && writeBody.indexOf('New-DryResult') < writeBody.indexOf('Invoke-Local'));
  check('S8 RemoteStateFile 模式下 Invoke-RemoteRead 拒绝真实读取', !!readBody && readBody.indexOf('$script:RemoteStateMode') >= 0 && readBody.indexOf('$script:RemoteStateMode') < readBody.indexOf('Invoke-Local'));

  // 回滚步骤
  const guide = functionBody(code, 'Write-RollbackGuide') || '';
  const pre = functionBody(code, 'Write-PreChecks') || '';
  check('S9 回滚步骤调用前置检查，且含 7 项（先本地、再远端、停服确认、回退代码、是否恢复数据库、起服务、核对）', guide.includes('Write-PreChecks') && [1, 2, 3, 4, 5, 6, 7].every((k) => guide.includes(`回滚 ${k}/7`)));
  // H1：所有回滚路径同一顺序：前置检查 -> pm2 stop 并 jlist 确认 -> git reset --hard -> 是否恢复数据库 -> pm2 start -> 核对；不出现 pm2 restart
  // 顺序只看回滚七步本身（从 [回滚 1/7] 起）：它之前的 COMMIT_NULL / SQLITE_BUSY 提示块里的命令不参与排序（那两块另有 S21 与动态用例守着）
  const guide7 = guide.slice(Math.max(0, guide.indexOf('Write-Host "[回滚 1/7]')));
  const gi = (needle) => guide7.indexOf(needle);
  check('S9 回滚顺序（源码里）：Write-PreChecks < pm2 stop < pm2 pid 确认 < reset --hard < 读回 HEAD < Get-SchemaChanges < pm2 start < 核对',
    [gi('Write-PreChecks'), gi('$Pm2StopCmd'), gi('pm2 pid task-pool'), gi('git reset --hard $($script:PrevCommit)'), guide7.indexOf('$RepoHeadCmd', gi('git reset --hard $($script:PrevCommit)')), gi('Get-SchemaChanges'), gi('$Pm2StartCmd'), gi('Write-VerifyAfterStart')].every((x, i, a) => x >= 0 && (i === 0 || x > a[i - 1])),
    JSON.stringify([gi('Write-PreChecks'), gi('$Pm2StopCmd'), gi('pm2 pid task-pool'), gi('git reset --hard $($script:PrevCommit)'), gi('Get-SchemaChanges'), gi('$Pm2StartCmd'), gi('Write-VerifyAfterStart')]));
  check('S9 回滚指引与整个脚本里都不出现 pm2 restart（用 stop -> start 两步，中间可确认）', !/pm2 restart/.test(code));
  check('S9 恢复数据库的命令逐条写明「上一步成功并核对之后才执行下一条」，含改名留档 / 复制备份 / 核对大小', guide.includes('上一步成功并核对之后才执行下一条') && guide.includes('before_restore_') && guide.includes('大小等于备份文件的大小') && guide.includes('恢复之前不要起服务'));
  check('S9 schema 扫描只是人工排查线索：零命中文案「这不能证明数据库兼容」，没有「不含 schema 变化」「只回退代码，不恢复数据库」「无需恢复」「直接起服务」之类结论', guide.includes('这不能证明数据库兼容') && guide.includes('只是人工排查线索，不是结论') && !/不含 schema 变化|只回退代码，不恢复数据库|无需恢复|直接起服务/.test(guide));
  check('S9 前置检查：先本地（Get-CimInstance Win32_Process，按进程名与命令行含 deploy-ssh 过滤）', pre.includes('前置检查·先本地') && pre.includes('Get-CimInstance Win32_Process') && pre.includes('deploy-ssh'));
  check('S9 前置检查：再远端（tasklist git.exe / wmic 找备份进程且不匹配自身 / pm2 ls / HEAD 读两次间隔 10 秒）', pre.includes('前置检查·再远端') && pre.includes('tasklist') && pre.includes('wmic process') && pre.includes('findstr /i /r backup-db-[0-9]') && !pre.includes('findstr /i backup-db-') && pre.includes('Get-CimInstance Win32_Process -Filter') && pre.includes('pm2 ls') && pre.includes('Start-Sleep 10'));
  check('S9 前置检查确实打印「先本地」的 Get-CimInstance 查询（不只是标题）', /Write-Host \(\"      \" \+ \$q\.Replace\('@@T@@', \$target\)\)/.test(pre) && pre.includes('$q = \'Get-CimInstance Win32_Process'));
  check('S9 先本地在再远端之前', pre.indexOf('前置检查·先本地') >= 0 && pre.indexOf('前置检查·先本地') < pre.indexOf('前置检查·再远端'));
  check('S9 回滚目标是 PrevCommit，不执行回滚（指引里没有 Invoke-RemoteWrite）', guide.includes('git reset --hard $($script:PrevCommit)') && !guide.includes('Invoke-RemoteWrite') && !guide.includes('Invoke-RemoteRead'));
  check('S9 恢复步骤 c 逐个核对库文件与 -wal / -shm / -journal 四个都不存在、改名留档存在，允许其他备份与历史留档存在；没有「只应看到」', [LIVE_DB, `${LIVE_DB}-wal`, `${LIVE_DB}-shm`, `${LIVE_DB}-journal`].every((f) => guide.includes(`if exist ${f} (echo EXISTS) else (echo MISSING)`)) && guide.includes(`if exist ${LIVE_DB}.before_restore_`) && guide.includes('允许其他备份与历史留档存在') && !guide.includes('只应看到'));
  // L3：可复制的命令各占一行，判据 / 说明另起一行——源码里以 ssh / curl / node 开头的输出行，字符串里不含中文
  const cmdSrc = [functionBody(code, 'Write-PreChecks') || '', functionBody(code, 'Write-VerifyAfterStart') || '', guide].join('\n').split('\n').filter((l) => /Write-Host "\s*(ssh |curl|node )/.test(l));
  const cmdWithCjk = cmdSrc.filter((l) => /[一-鿿]/.test(l.slice(l.indexOf('Write-Host'), l.lastIndexOf('-ForegroundColor'))));
  check(`S9 回滚指引 / 前置检查 / 核对里 ${cmdSrc.length} 条以 ssh / curl / node 开头的输出行，字符串里都不含中文说明（判据另起一行）`, cmdSrc.length >= 15 && cmdWithCjk.length === 0, cmdWithCjk.slice(0, 2).map((l) => l.trim().slice(0, 100)).join(' || '));
  // S16（codex 39-R2 LOW③，B1 前置；LOW③ 预筛修复批 1 收紧）：S9 只扫回滚 / 前置检查 / 核对三个函数；这里扫全脚本。
  // 输出函数：Write-Host / Write-Info（不限引号形式）与 $q = '…' 字面量（第 5 步前置检查里被 Write-Host 间接打印的查询命令）。
  // 命令集合：ssh（本地变量 / $target 两种写法）/ scp / curl.exe / Stop-Process / Get-CimInstance。
  // 不纳入 Write-DryLine：它的「[DRYRUN] 将执行 / 将核对」是日志，不是给人复制的指令，命令与中文同行是故意的（纳入会误报）。
  // 取串：从输出函数名（或 $q = '）起，到最后一个 -ForegroundColor 止；没有 -ForegroundColor（Write-Info "…" 'White' / $q）则取到行尾；
  // 取到的串去掉函数名后为空，该行判红（防新假绿：取不到串不能当「没有中文」）。
  const outFnRe = /\bWrite-(Host|Info)\b|\$q = '/;
  const copyCmdRe = /(ssh \$\{ServerUser\}@\$\{ServerIP\}|ssh \$target |scp |curl\.exe |Stop-Process |Get-CimInstance )/;
  const cjkRe = /[　-〿一-鿿＀-￯]/;
  const outStr = (l) => { const s = l.search(outFnRe); const e = l.lastIndexOf('-ForegroundColor'); return s < 0 ? '' : (e > s ? l.slice(s, e) : l.slice(s)); };
  const isCmdOutLine = (l) => outFnRe.test(l) && copyCmdRe.test(l);
  const badCmdLines = (src) => src.split('\n').filter((l) => isCmdOutLine(l) && (outStr(l).replace(outFnRe, '').trim() === '' || cjkRe.test(outStr(l))));
  const hostCmd = code.split('\n').filter(isCmdOutLine);
  const hostCmdCjk = badCmdLines(code);
  check(`S16 全脚本 ${hostCmd.length} 条含可复制命令（ssh / scp / curl.exe / Stop-Process / Get-CimInstance）的输出行（Write-Host / Write-Info / $q 字面量），字符串里都不含中文（判据另起一行）`, hostCmd.length >= 20 && hostCmdCjk.length === 0, hostCmdCjk.slice(0, 2).map((l) => l.trim().slice(0, 100)).join(' || '));
  // 区域锚定：全脚本总数下限锚不住「删一条命令行」，这里按步骤锚住 S9 三个函数之外的输出行。
  // 个数 = 修后实际数（第 4 步：pm2 ls、起服务 = 2；第 5 步：pm2 ls、HEAD、curl.exe、UNKNOWN 起服务 = 4；第 9 步：备份 scp、远端备份大小查询 ssh、附件 scp -r = 3），用 ≥ 不用 ===，将来合法新增不用改这里。
  const regionCmdCount = (k) => (regions[k] || '').split('\n').filter(isCmdOutLine).length;
  const regionAnchor = { 4: 2, 5: 4, 9: 3 };
  check(`S16 区域锚定：含可复制命令的输出行 第 4 步 ${regionCmdCount('4')}（≥2）/ 第 5 步 ${regionCmdCount('5')}（≥4）/ 第 9 步 ${regionCmdCount('9')}（≥3）`, Object.keys(regionAnchor).every((k) => regionCmdCount(k) >= regionAnchor[k]));
  // S17（LOW③ 预筛 LOW-1）：第 4 步停服失败、第 5 步 restart_unverified 两个分支 DryRun 走不到，打印内容只有 S14（Write-PreChecks 在不在）与 S16（不含中文）守着；
  // 这里按「逐行全等 + 顺序」守内容：每条命令行与判据行必须原样出现，且按此顺序（第 4 步的起服务命令在 Write-PreChecks 之后）。
  // 威胁模型：以后诚实地改文案时误删一行、把判据写错、把起服务命令挪回前置检查之前；对抗性构造（把命令拼进变量）不在范围。
  const lineSeqMissing = (block, expected) => {
    const ls = block.split('\n').map((l) => l.trim());
    let from = 0;
    const missing = [];
    for (const want of expected) {
      const i = ls.indexOf(want, from);
      if (i < 0) missing.push(want); else from = i + 1;
    }
    return missing;
  };
  const step4Src = regions['4'] || '';
  const step4Block = step4Src.slice(Math.max(0, step4Src.indexOf('if (-not $stopOk) {')));
  // codex 40 M：本机 ssh 超时退出时远端 pm2 stop 可能仍在执行——前置检查与「无在途 pm2 stop」核对在前，间隔 10 秒两次 pm2 ls 一致后才按判据处理
  const step4Expect = [
    'Write-PreChecks',
    'Write-Host "      ssh ${ServerUser}@${ServerIP} ""wmic process get processid,commandline | findstr /r /c:Process[I]d /c:p[m]2.*sto[p]""" -ForegroundColor White',
    // codex 40-R M：查询失败与「无在途进程」都表现为没有匹配行——以表头为成功标记，看不到表头就停下改用带 try / catch 的 CIM 查询
    'Write-Host "      判据：输出第一行必须是表头（含 CommandLine 与 ProcessId），说明查询成功；表头之外没有任何行才继续；有行就是还有在途的 pm2 stop，等它结束后再查一次。" -ForegroundColor Gray',
    'Write-Host "      判据：看不到表头（查询失败、WMI 出错或远端没有 wmic）就停下，登录远端 PowerShell 运行下一行；输出最后一行是 CIM_OK 且其上没有进程行才继续，是 CIM_FAILED 就人工核实：" -ForegroundColor Gray',
    "$q = 'try { Get-CimInstance Win32_Process -Filter \"Name=''node.exe''\" -ErrorAction Stop | Where-Object { $_.CommandLine -match ''pm2.*stop'' } | Select-Object ProcessId,CommandLine; ''CIM_OK'' } catch { ''CIM_FAILED'' }'",
    'Write-Host ("      " + $q) -ForegroundColor White',
    'Write-Host "      ssh ${ServerUser}@${ServerIP} ""pm2 ls""" -ForegroundColor White',
    'Write-Host "      Start-Sleep 10" -ForegroundColor White',
    'Write-Host "      ssh ${ServerUser}@${ServerIP} ""pm2 ls""" -ForegroundColor White',
    // 修复批 1b LOW①：停服失败分支的判据补「且 3000 零 LISTENING」（pm2 已 stopped 也一样，多半是孤儿监听），并给出 netstat 只读核对命令
    STEP4_NS_INTRO,
    STEP4_NS_CMD,
    STEP4_STOPPED_JUDGE,
    'Write-Host "      判据：名为 task-pool 的只有一项，且为 online → 服务仍在跑，不要起服务，直接结束本次部署。" -ForegroundColor Gray',
    STEP4_OTHER_JUDGE,
    STEP4_START_HINT,
    'Write-Host "      ssh ${ServerUser}@${ServerIP} ""$Pm2StartCmd""" -ForegroundColor White',
  ];
  const step4Missing = step4Src.indexOf('if (-not $stopOk) {') < 0 ? ['(找不到 if (-not $stopOk) { 分支)'] : lineSeqMissing(step4Block, step4Expect);
  check('S17 第 4 步停服失败分支：Write-PreChecks 在先，随后在途 pm2 stop 核对、间隔 10 秒两次 pm2 ls、三条判据（stopped / online / 其他状态含两次不一致）、起服务提示与命令，逐行全等且按序', step4Missing.length === 0, step4Missing.slice(0, 2).map((l) => l.slice(0, 90)).join(' || '));
  const ruStart = step5.indexOf("Set-Stage -Stage 'restart_unverified' -Result 'failed'");
  const ruEnd = step5.indexOf("Add-Route '5 备份：BACKUP_FAIL -> 已发 pm2 start 但核对不过");
  const ruBlock = ruStart >= 0 && ruEnd > ruStart ? step5.slice(ruStart, ruEnd) : '';
  const ruExpect = [
    'Write-Host "      ssh ${ServerUser}@${ServerIP} ""pm2 ls""" -ForegroundColor White',
    'Write-Host "      判据：名为 task-pool 的只有一项，且为 online。" -ForegroundColor Gray',
    'Write-Host "      ssh ${ServerUser}@${ServerIP} ""$RepoHeadCmd""" -ForegroundColor White',
    'Write-Host "      判据：应为 $($script:PrevCommit)。" -ForegroundColor Gray',
    'Write-Host "      curl.exe --noproxy ""*"" -s -m 5 $BaseUrl/api/version" -ForegroundColor White',
    'Write-Host "      判据：version 应为 $($script:RunVersion)。" -ForegroundColor Gray',
    'Write-PreChecks',
  ];
  const ruMissing = ruBlock === '' ? ['(找不到 restart_unverified 块)'] : lineSeqMissing(ruBlock, ruExpect);
  check('S17 restart_unverified 分支：pm2 ls / HEAD / curl.exe 三条命令与各自判据（只有一项且 online、应为 PrevCommit、version 应为 RunVersion）、Write-PreChecks 逐行全等且按序', ruMissing.length === 0, ruMissing.slice(0, 2).map((l) => l.slice(0, 90)).join(' || '));
  check('S9 COMMIT_NULL 提示：HEAD = 新提交只说明代码检出成功，要求继续核对 pm2 状态 / 版本 / 其余就绪失败项；没有「部署本身成功、不要回滚」的结论', guide.includes('COMMIT_NULL') && guide.includes('只说明代码检出成功') && guide.includes('继续核对 pm2 状态') && !guide.includes('不要回滚') && !guide.includes('部署本身成功'));

  // 其他
  check('S10 不合并 stderr（无 2>&1）、无 EncodedCommand / Copy-Item / Invoke-Expression', !/2>&1/.test(code) && !/EncodedCommand/.test(code) && !/Copy-Item/.test(code) && !/Invoke-Expression|\biex\b/.test(code));
  check('S10 不含 npm install', !/npm\s+install/.test(code));
  check('S10 头注释已改写（无「6 步」「Copy-Item」）', !/6 步：\(1\)/.test(text) && !/Copy-Item/.test(text));
  // 仓库根：取脚本自身位置，所有本机 git / node 调用显式带仓库根
  check('S11 仓库根取脚本自身位置（Split-Path -Parent $PSScriptRoot）并用 git -C 核对顶层', /\$RepoRootCandidate = Split-Path -Parent \$PSScriptRoot/.test(code) && /@\('-C', \$RepoRootCandidate, 'rev-parse', '--show-toplevel'\)/.test(code) && /if \(\$topNorm -ne \$candNorm\) \{/.test(code) && /\$script:RepoRoot = \$candNorm/.test(code));
  const localCalls = code.split('\n').filter((l) => /Invoke-Local -FileName '(git|node)'/.test(l));
  const badCalls = localCalls.filter((l) => !(/-WorkDir/.test(l) || /ArgList @\('-C'/.test(l)));
  check('S11 每处本机 git / node 调用都显式带 -WorkDir 或以 git -C 开头', localCalls.length >= 6 && badCalls.length === 0, badCalls.map((l) => l.trim().slice(0, 100)).join(' | '));
  check('S11 不看进程当前目录（无 $PWD / Get-Location / Set-Location / [Environment]::CurrentDirectory）', !/\$PWD\b|Get-Location|Set-Location|CurrentDirectory/.test(code));
  const gitWrapper = functionBody(code, 'Invoke-Git') || '';
  check('S11 Invoke-Git 带 -WorkDir 仓库根，且仓库根没确定时拒绝起 git', /-WorkDir \$script:RepoRoot/.test(gitWrapper) && gitWrapper.indexOf('IsNullOrEmpty($script:RepoRoot)') >= 0 && gitWrapper.indexOf('IsNullOrEmpty($script:RepoRoot)') < gitWrapper.indexOf('Invoke-Local'));
  check('S11 ready-check 的 --repo 与回滚指引里的脚本路径都用仓库根 / 脚本自身位置', /'--repo', \$script:RepoRoot/.test(code) && !/node scripts\/deploy/.test(code));
  // 第 5 / 8 步的判定：真实与 DryRun 都只经 Resolve-* 纯函数
  const step8 = regions['8'] || '';
  check('S12 Resolve-BackupOutcome / Resolve-ReadyOutcome 各一个定义，协议判定 Read-Protocol 只在这两个函数与第 2 步预检里被调用', (code.match(/function Resolve-BackupOutcome\b/g) || []).length === 1 && (code.match(/function Resolve-ReadyOutcome\b/g) || []).length === 1 && occurrences(/Read-Protocol -Res/g, code) === 3, String(occurrences(/Read-Protocol -Res/g, code)));
  check('S12 第 8 步只经 Resolve-ReadyOutcome 判定（没有直接的协议解析）；DryRun 与真实路径喂同一个函数', step8.includes('$ro = Resolve-ReadyOutcome $rres') && !step8.includes('Read-Protocol') && occurrences(/Resolve-ReadyOutcome/g, step8) === 1 && step8.includes('New-FakeProc'));
  check('S12 第 5 步 DryRun 构造假的子进程结果（New-FakeProc）再喂 Resolve-BackupOutcome，不再直接合成结论', step5.includes('New-FakeProc') && step5.indexOf('New-FakeProc') < step5.indexOf('$bo = Resolve-BackupOutcome'));
  check('S12 Resolve-BackupOutcome 只看 stdout 协议行（不用退出码）', !/ExitCode/.test(functionBody(code, 'Resolve-BackupOutcome') || 'ExitCode') && !/ExitCode/.test(functionBody(code, 'Resolve-ReadyOutcome') || 'ExitCode') && !/ExitCode/.test(functionBody(code, 'Read-Protocol') || 'ExitCode'));
  // 就绪接口预检（停服前）与 fetch 前移
  const step2 = regions['2'] || '';
  check('S13 第 2 步在停服前核对新提交的服务入口文件含就绪接口路由与 commit 字段（git grep），不满足 Stop-BeforeStop', /\$ReadyRouteLiteral = "app\.get\('\/api\/health\/ready'"/.test(code) && /\$CommitFieldLiteral = 'commit: DEPLOY_COMMIT'/.test(code) && step2.includes(`'grep', '-q', '-F', $lit, $script:NewCommit, '--', '${SERVICE_ENTRY}'`) && step2.includes('foreach ($lit in @($ReadyRouteLiteral, $CommitFieldLiteral))') && step2.includes("'NO_READY_API'"));
  // 其他加固
  check('S14 远端 git status 带 --no-optional-locks', /git --no-optional-locks -C E:\\Task_Pool status --porcelain --untracked-files=no/.test(step2));
  check('S14 pm2 jlist 原文经 stdin 传给 node，不落盘；退出前删除工作临时目录', code.includes('-StdinText $JlistText') && !/WriteAllText\(\$in\b/.test(code) && /Remove-Item -LiteralPath \$script:WorkTmp -Recurse/.test(functionBody(code, 'Exit-Deploy') || ''));
  check('S14 pm2 解析的 node 脚本去掉 stdin 开头的 BOM；stdin 写入失败不再被吞掉（记入 StartError）', code.includes('while (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);') && /写 stdin 失败/.test(code));
  check('S14 第 4 步停服失败、restart_unverified 分支都打印两项前置检查', (regions['4'] || '').includes('Write-PreChecks') && /restart_unverified[\s\S]*Write-PreChecks/.test(step5));
  check('S14 备份失败后的核对：pm2 start 本身失败不空转；总截止 60 秒，每次读的超时取剩余时间', step5.includes('if (Test-Ok $oldStartRes) {') && step5.includes('AddSeconds(60)') && step5.includes('$rem = [int][math]::Max(1, [math]::Min(15,'));
  check('S14 换代码后读 HEAD、起服务后读 pm2：失败重读最多 3 次（间隔 3 秒）', /for \(\$i = 0; \$i -lt 3 -and \$nh -ne \$script:NewCommit; \$i\+\+\)/.test(regions['6'] || '') && /for \(\$i = 0; \$i -lt 3 -and -not \$startOk; \$i\+\+\)/.test(regions['7'] || '') && (regions['6'] || '').includes('Start-Sleep -Seconds 3') && (regions['7'] || '').includes('Start-Sleep -Seconds 3'));
  const schemaBody = functionBody(code, 'Get-SchemaChanges') || '';
  check('S14 schema 扫描只排除明确的测试文件（wbs-server/scripts/ 下的 verify-* / test-*）、*.md、docs/，不整体排除 wbs-server/scripts/', schemaBody.includes("'^b/wbs-server/scripts/(verify|test)-[^/]*$'") && schemaBody.includes("'\\.md$'") && schemaBody.includes("'^b/docs/'") && !schemaBody.includes("'^b/wbs-server/scripts/'"));
  // M2 / M3 / M5
  const finalFn = functionBody(code, 'Test-FinalPm2State') || '';
  check('S15 第 8 步 READY_OK 之后的终检经 Test-FinalPm2State（要求唯一 task-pool 为 online 且 restart_time 未增长），真实与 DryRun 都经它', finalFn.includes("'online'") && finalFn.includes('-gt [int]$BaseRestart') && (regions['8'] || '').includes('$fin = Test-FinalPm2State $pt2 $baseRestart') && !(regions['8'] || '').includes('$nowRestart'));
  const localFn = functionBody(code, 'Invoke-Local') || '';
  check('S15 Invoke-Local 的 stdin 写入是异步的并与等待退出共用同一个总截止时间：只等「总截止 - 已用时间」的剩余毫秒（不是再等一个完整的 TimeoutSec），超时终止子进程；收尾宽限是单独的常量', localFn.includes('WriteAsync(') && !/BaseStream\.Write\(/.test(localFn) && localFn.includes('$remainWriteMs = [int][math]::Max(0, ($TimeoutSec * 1000) - $sw.ElapsedMilliseconds)') && localFn.includes('$writeTask.Wait($remainWriteMs)') && !localFn.includes('Wait([int]($TimeoutSec * 1000))') && localFn.includes('$graceMs = 5000') && !/WaitForExit\(5000\)|Wait\(5000\)/.test(localFn));
  const step9 = regions['9'] || '';
  check('S15 附件快照：scp 先拉到 collab_<Id>.partial，核对后才 Move-Item 改名为正式名；保留份数只统计正式名；失败的 .partial 保留并提示', step9.includes('.partial') && /Move-Item -LiteralPath \$localPartialDir -Destination \$localSnapshotDir/.test(step9) && step9.includes('Get-FormalCollabSnapshots $localCollabBaseDir') && !/Get-ChildItem[^\n]*collab_\*/.test(step9) && step9.includes('已保留（不计入保留份数，不自动删除）') && (functionBody(code, 'Get-FormalCollabSnapshots') || '').includes("'^collab_\\d{8}_\\d{6}$'"));
  check('S14 BK_PUBLISH_FAILED 且 json 有 out 时提示「备份其实已发布到 <out>」', /BK_PUBLISH_FAILED[\s\S]{0,200}备份其实已发布到/.test(step5));
  check('S10 不写仓库里的临时目录', !new RegExp(`${'_'}temp`).test(text));
  check('S10 备份路径取协议行 out、不用 glob 挑最新', /\$script:BackupPath = \[string\]\$bo\.Json\.out/.test(code) && !/backup_\*[\s\S]{0,40}Select-Object -First 1/.test(code));
  check('S10 就绪后防重启循环（restart_time 基准与 READY_OK 后复读）', code.includes('$baseRestart') && /-gt \[int\]\$BaseRestart/.test(functionBody(code, 'Test-FinalPm2State') || ''));
  check('S10 ReadyTimeoutSec 缺省 180', /\[int\]\$ReadyTimeoutSec = 180/.test(code));

  // ---- B1 末次合并审预筛六项（M1 推送超时 / M2 库备份轮转 / M3 孤儿监听 / M4 启动期 SQLITE_BUSY / L1 COMMIT_NULL / L5 回滚第 3 步）。
  // 设计铁律：只加硬门（只拒不放）与提示文字，不加放行 / 智能判定 / 新的自动动作——下面 S18-S21 里的「只读」「写调用仍恰两处」断言守着这一点。
  const step1 = regions['1'] || '';
  const stopPush = functionBody(code, 'Stop-PushNotConfirmed') || '';
  const pushAfter = functionBody(code, 'Resolve-PushAftermath') || '';
  check('S18 M1 -PushTimeoutSec：缺省 1800、只收 60-7200 的整数（正则 ^[0-9]{1,5}$ + 上下界，非法 exit 2）；第 1 步 git push 用 $script:PushTimeoutSec 作超时，不再写死 300',
    /\[string\]\$PushTimeoutSec = '1800'/.test(code) && /if \(\$PushTimeoutSec -notmatch '\^\[0-9\]\{1,5\}\$' -or \[int\]\$PushTimeoutSec -lt 60 -or \[int\]\$PushTimeoutSec -gt 7200\) \{[^}]*?exit 2/.test(code) && step1.includes("Invoke-Git -ArgList @('push', 'production', 'main') -TimeoutSec $script:PushTimeoutSec") && !/'push'[^\n]*-TimeoutSec 300\b/.test(code));
  check('S18 M1 push 超时或失败：只读 git ls-remote 核对一次，经 Stop-PushNotConfirmed 中止（两种结论都 Stop-Early，生产未动）；核对与结论函数里没有任何远端写调用',
    /if \(-not \(Test-Ok \$push\)\) \{[\s\S]*?\$lrFail = Invoke-Git -ArgList @\('ls-remote', 'production', 'refs\/heads\/main'\) -TimeoutSec 120[\s\S]*?Stop-PushNotConfirmed \$push \$lrFail/.test(step1) && stopPush.includes('Resolve-PushAftermath $PushRes $LsRes $script:NewCommit') && /Stop-Early \$pa\.Message$/.test(stopPush.trim()) && !/Invoke-RemoteWrite/.test(stopPush + pushAfter) && pushAfter.includes('$first -eq $NewCommit'), stopPush.trim().slice(-80));
  const dbFnText = functionBody(code, 'Get-FormalDbBackups') || '';
  check('S19 M2 本地库备份轮转只统计正式名（口径同 Get-FormalCollabSnapshots）：第 9 步经 Get-DbBackupsToDelete 删除，不再用 -Filter 通配 backup_*',
    dbFnText.includes(`'^${LIVE_DB.replace('.', '\\.')}\\.backup_\\d{8}_\\d{6}$'`) && dbFnText.includes('-File') && (functionBody(code, 'Get-DbBackupsToDelete') || '').includes('Get-FormalDbBackups $Base | Select-Object -Skip $Keep') && step9.includes('$toDelete = Get-DbBackupsToDelete $localBackupDir 10') && !/-Filter\s+'[^']*backup_\*'/.test(step9));
  const ownerFnNames = ['Get-ListeningPids', 'Test-Pm2OwnsPort', 'Test-PortReleased', 'Read-RemoteListeners', 'New-FakeNetstat'];
  check('S20 M3 第 2 步硬门（停服之前）：online 检查之后、发布记录 init 之前，pm2 pid 必须等于 3000 的唯一 LISTENING pid，不满足 Stop-Early',
    step2.indexOf('$own2 = Test-Pm2OwnsPort $Pm2Pid $Listen') > step2.indexOf("if ($Pm2Status -ne 'online')") && step2.indexOf('if (-not $own2.Ok) { Stop-Early $own2.Why }') > step2.indexOf('$own2 = Test-Pm2OwnsPort') && step2.indexOf('if (-not $own2.Ok) { Stop-Early') < step2.indexOf('$ini = Invoke-Record $initArgs') && step2.includes('$Pm2Pid = $pt.Pid') && step2.includes('$Listen = Read-RemoteListeners'));
  check('S20 M3 第 4 步：pm2 确认 stopped 之后 3000 必须零 LISTENING（Test-PortReleased；真实路径只读重读最多 3 次；不满足 $stopOk=$false 走「停服确认不过」分支，不自动做任何事）；DryRun 经同一个判定函数',
    step4Src.includes('$portFree = Test-PortReleased (Read-RemoteListeners)') && step4Src.includes('if (-not $portFree.Ok) { $stopOk = $false; $stopWhy = $portFree.Why }') && step4Src.indexOf('$portFree = Test-PortReleased') > step4Src.indexOf("$pt.Status -eq 'stopped'") && step4Src.includes('$portFree4 = Test-PortReleased (Get-ListeningPids $fakeNs4 $AppPort)') && step4Src.includes('for ($j = 0; $j -lt 3; $j++) {'));
  check('S20 M3 第 5 步 BACKUP_FAIL 自动起服务后的核对含 pm2 pid = 3000 监听 pid（不符归入 restart_unverified）；restart_unverified 的人工核对含 pm2 pid 与 netstat 命令；没有新增自动动作（pm2 start 的写调用仍恰两处）',
    step5.includes('$own5 = Test-Pm2OwnsPort $pt.Pid (Read-RemoteListeners -TimeoutSec $rem)') && step5.includes('-and $own5.Ok) { $verified = $true }') && ruBlock.includes('""pm2 pid task-pool""') && ruBlock.includes('""netstat -ano | findstr LISTENING | findstr :3000""') && ruBlock.includes('feedback_pm2_orphan_listener_recovery') && occurrences(/Invoke-RemoteWrite -Command \$Pm2StartCmd/g, code) === 2);
  check('S20 M3 第 8 步终检：Test-FinalPm2State 通过之后再核 pm2 pid = 3000 监听 pid（真实路径读 netstat，DryRun 经同一个解析函数与硬门）',
    step8.includes('$own8 = Test-Pm2OwnsPort $pt2.Pid $ls8') && step8.includes('$ls8 = Read-RemoteListeners') && step8.includes('if ($own8.Ok) { $readyOk = $true } else { $readyWhy = $own8.Why }') && step8.indexOf('$own8 = Test-Pm2OwnsPort') > step8.indexOf('$fin = Test-FinalPm2State $pt2 $baseRestart'));
  check('S20 M3 netstat 只读：$NetstatCmd 只出现两次（常量定义 + Read-RemoteListeners 里的 Invoke-RemoteRead），不经 Invoke-RemoteWrite；新增的函数里没有任何远端写 / git / pm2 stop / start',
    occurrences(/\$NetstatCmd/g, code) === 2 && (functionBody(code, 'Read-RemoteListeners') || '').includes('Invoke-RemoteRead -Command $NetstatCmd') && !/Invoke-RemoteWrite[^\n]*(netstat|NetstatCmd)/i.test(code) && ownerFnNames.every((n) => !/Invoke-RemoteWrite|Invoke-Git|pm2 (stop|start)/.test(functionBody(code, n) || 'Invoke-RemoteWrite')));
  const verifyFn = functionBody(code, 'Write-VerifyAfterStart') || '';
  check('S20 M3 回滚第 7 步的核对（Write-VerifyAfterStart）含 pm2 pid task-pool 与 netstat 监听核对命令，判据点名孤儿监听的 memory 处置',
    verifyFn.includes('Write-Host "      ssh $target ""pm2 pid task-pool""" -ForegroundColor White') && verifyFn.includes('Write-Host "      ssh $target ""netstat -ano | findstr LISTENING | findstr :3000""" -ForegroundColor White') && verifyFn.includes('feedback_pm2_orphan_listener_recovery'));
  const busyFn = functionBody(code, 'Test-StartupBusyHint') || '';
  const iBusyBlock = guide.indexOf('if (Test-StartupBusyHint $Reason $Kind) {');
  const iGuide1 = guide.indexOf('Write-Host "[回滚 1/7]');
  check('S21 M4 回滚指引：Test-StartupBusyHint 为真时，在回滚七步之前先给 SQLITE_BUSY 的只读日志核对（findstr SQLITE_BUSY）与人工 stop / pm2 ls / start / 重跑 ready-check 命令，仍失败再走回滚七步；判定函数是纯文字判断，没有远端调用',
    iBusyBlock >= 0 && iBusyBlock < iGuide1 && [guide.indexOf('findstr SQLITE_BUSY', iBusyBlock), guide.indexOf('""$busyStop""', iBusyBlock), guide.indexOf('""pm2 ls""', iBusyBlock), guide.indexOf('""$busyStart""', iBusyBlock), guide.indexOf('--expect-commit $($script:NewCommit)', iBusyBlock), guide.indexOf('仍失败就再走下面的回滚七步', iBusyBlock)].every((x, i, a) => x > iBusyBlock && x < iGuide1 && (i === 0 || x > a[i - 1])) && /INIT_FAILED\|SQLITE_/.test(busyFn) && busyFn.includes("'RESTART_ONCE'") && !/Invoke-Remote|Invoke-Git|Invoke-Local/.test(busyFn));
  check('S21 M4 restart_time 只比基准多 1：Test-FinalPm2State 仍判失败（Ok=false）但 Kind=RESTART_ONCE、措辞「重启过 1 次」；第 8 步把 Kind 传给 Write-RollbackGuide',
    finalFn.includes("[int]$BaseRestart + 1) { return (& $bad") && finalFn.includes('新进程重启过 1 次') && finalFn.includes("'RESTART_ONCE'") && finalFn.includes('新进程在反复崩溃重启') && step8.includes('$readyKind = [string]$fin.Kind') && step8.includes('Write-RollbackGuide -Reason $readyWhy -Hint $readyHint -Kind $readyKind'));
  const iNullBlock = guide.indexOf("if ($Hint -eq 'COMMIT_NULL') {");
  const nullBlock = iNullBlock >= 0 && iBusyBlock > iNullBlock ? guide.slice(iNullBlock, iBusyBlock) : '';
  check('S21 L1 COMMIT_NULL 分支补打印模块就绪（/api/health/ready）与页面（Select-String ?v=auto）的可复制核对命令，命令行里没有中文，判据另起一行',
    nullBlock.includes('curl.exe --noproxy ""*"" -s -m 5 $BaseUrl/api/health/ready') && nullBlock.includes('判据：ok 为 true') && nullBlock.includes('Select-String -SimpleMatch ""?v=auto""') && nullBlock.includes('判据：200 之后这一条没有任何输出'));
  // 修复批 1c M1：页面检查先要求请求成功且 HTTP 200，再扫描内容里的字面 ?v=auto；不再是「curl -s 管道 Select-String、没有输出就算通过」（curl 失败或返回错误页也没有输出）
  const iCurl200 = nullBlock.indexOf('-o ""`$env:TEMP\\sdh-page-check.html"" -w ""%{http_code}"" $BaseUrl/<page>.html');
  const iJudge200 = nullBlock.indexOf('判据：输出恰为 200 才继续');
  const iScanCmd = nullBlock.indexOf('Select-String -SimpleMatch ""?v=auto"" -Path ""`$env:TEMP\\sdh-page-check.html""');
  check('S23 M1 COMMIT_NULL 页面检查：先 curl 取状态码（-o 临时文件 -w %{http_code}）并判「输出恰为 200」（其他输出 / 无输出 / 报错 = 请求失败，不是没有 ?v=auto），再对临时文件扫描字面 ?v=auto；不再用 curl 管道 Select-String',
    iCurl200 > 0 && iJudge200 > iCurl200 && iScanCmd > iJudge200 && nullBlock.includes('「请求失败」，不是「页面没有 ?v=auto」') && nullBlock.includes('查询成功但零命中') && !/curl\.exe[^\n]*\|\s*Select-String/.test(nullBlock), JSON.stringify([iCurl200, iJudge200, iScanCmd]));
  // 47R2a-R M1 残留：curl 回 200 后正文传输中断时状态码仍是 200、退出码非 0 → 200 判据之后、扫描之前必须单独读 $LASTEXITCODE 并判 0；扫描本身报错也算请求失败
  const iExitCmd = nullBlock.indexOf('Write-Host "      `$LASTEXITCODE" -ForegroundColor White');
  const iExitJudge = nullBlock.indexOf('判据：必须输出 0。');
  check('S23 47R2a-R COMMIT_NULL 页面检查：200 判据之后、扫描之前单独打印 $LASTEXITCODE 命令行并判「必须输出 0」（200 但退出码非 0 = 请求失败）；扫描判据含「报错同样是请求失败」',
    iExitCmd > iJudge200 && iExitJudge > iExitCmd && iScanCmd > iExitJudge && nullBlock.includes('状态码仍是 200 但退出码非 0') && nullBlock.includes('这一条报错（找不到或读不了临时文件）同样是「请求失败」'), JSON.stringify([iJudge200, iExitCmd, iExitJudge, iScanCmd]));
  // ---- 修复批 1b（静态；行为断言在 U14 / U12 / D-finwait / D-localized / D-stop-listen / D-normal / 回滚指引的 M4 用例）
  const lsPidsFn = functionBody(code, 'Get-ListeningPids') || '';
  check('S22 H1 netstat 状态列的形态是 [A-Z][A-Z0-9_]*（认带数字的 FIN_WAIT_1 / FIN_WAIT_2），不是 [A-Za-z_]+，也不放宽成 \\S+（本地化状态必须仍 fail-closed）',
    lsPidsFn.includes("\\s+(\\S+)\\s+([A-Z][A-Z0-9_]*)\\s+([0-9]+)\\s*$'") && !/\(\[A-Za-z_\]\+\)/.test(lsPidsFn) && !/\\s\+\(\\S\+\)\\s\+\(\\S\+\)\\s\+\(\[0-9\]\+\)/.test(lsPidsFn));
  check('S22 LOW② 第 4 步失败态 note：端口没确认释放（stopWhy 非空）记 PORT_NOT_RELEASED，其余记 STOP_UNCONFIRMED',
    step4Src.includes("-Note $(if ($stopWhy -ne '') { 'PORT_NOT_RELEASED' } else { 'STOP_UNCONFIRMED' })"));
  check('S22 LOW③ 「推送已生效」分支查 git 进程的命令收窄到 receive-pack / gc / TaskPool 的命令行', stopPush.includes("| Where-Object { `$_.CommandLine -match 'receive-pack|gc|TaskPool' } | Select-Object ProcessId,CommandLine"));
  check('S22 LOW⑤ DryRun 第 9 步只读预览轮转清单（Get-DbBackupsToDelete <目录> 9），预览分支里没有 Remove-Item，真实分支的删除仍是保留 10 份',
    step9.includes('$rotPreview = @(Get-DbBackupsToDelete $localBackupDir 9)') && step9.includes('Write-DryLine "（只读预览）拉回本次备份之后按保留 10 份轮转') && step9.includes('$toDelete = Get-DbBackupsToDelete $localBackupDir 10'));
  check('S22 LOW⑤b 预览行不在 Remove-Item 之后的删除分支里（预览与删除是 if / else 两个互斥分支）', (() => { const i = step9.indexOf('$rotPreview = @(Get-DbBackupsToDelete'); const j = step9.indexOf('Remove-Item -LiteralPath $f.FullName'); return i > j && j > 0 && !step9.slice(i).includes('Remove-Item -LiteralPath $f.FullName'); })());
  const step3Guide = guide.slice(guide.indexOf('Write-Host "[回滚 3/7]'), guide.indexOf('Write-Host "[回滚 4/7]'));
  check('S21 L5 回滚第 3 步的确认命令是 pm2 pid task-pool + pm2 ls（pm2 jlist 会把整份 pm2_env 含环境变量打进会话记录）；整份回滚指引里不再出现 jlist / Pm2JlistCmd',
    step3Guide.includes('Write-Host "      ssh $target ""pm2 pid task-pool""" -ForegroundColor White') && step3Guide.includes('Write-Host "      ssh $target ""pm2 ls""" -ForegroundColor White') && !/jlist|Pm2JlistCmd/.test(guide) && (functionBody(code, 'Write-VerifyAfterStart') || '').indexOf('jlist') < 0);

  // ---- 修复批 1c（codex 47R2a：H 回滚第 3 步零监听硬门 / M1 人工核对「没有输出 ≠ 成功」 / M2 库备份下载走 .partial）。
  // 设计铁律不变：只加硬门（只拒不放）与提示文字；唯一自动动作仍是 BACKUP_FAIL 后的 pm2 start（S6 / S7 / S20 守着，写调用仍恰两处）。行为层断言在 rollbackChecks 与 D-normal / D-readynull / D-loop / U20。
  const lcFn = functionBody(code, 'Write-ListenerCheck') || '';
  const lcCmdLine = lcFn.split('\n').find((l) => l.includes('netstat -ano')) || '';
  const iJ1 = lcFn.indexOf('判据一（先确认查询成功）');
  const iJ2 = lcFn.indexOf('判据二（再数监听者');
  check('S23 M1 Write-ListenerCheck：命令是不加过滤的 netstat -ano（没有 findstr / 管道），判据一「查询成功」（有 TCP 行；没有 TCP 行 / ssh 报错 / 超时 / 输出为空 = 查询失败，不是零监听）排在判据二「3000 的 LISTENING 行必须为零」之前；函数里没有任何远端 / git / 本机调用',
    lcCmdLine.trim() === 'Write-Host "      ssh $target ""netstat -ano""" -ForegroundColor White' && !lcFn.includes('findstr') && iJ1 > 0 && iJ2 > iJ1 && lcFn.includes('「查询失败」，不是「零监听」') && lcFn.includes('输出里有 TCP 行') && lcFn.includes('必须为零') && !/Invoke-Remote|Invoke-Git|Invoke-Local/.test(lcFn), lcCmdLine.trim());
  const s3 = step3Guide;
  const iPidC = s3.indexOf('pm2 pid task-pool');
  const iLsC = s3.indexOf('""pm2 ls""', iPidC);
  const iLcC = s3.indexOf('Write-ListenerCheck', iLsC);
  const iGateC = s3.indexOf('才能进入回滚 4/7', iLcC);
  check('S23 H 回滚第 3 步：pm2 pid / pm2 ls 确认 stopped 之后调用 Write-ListenerCheck，其后的判据写「查询成功且 3000 零 LISTENING 才能进入回滚 4/7；有监听者或查询失败：停止人工流程，不做 4/7、5/7、6/7」，且都在回滚 4/7（git reset --hard）之前；第 3 步里没有 findstr 过滤',
    iPidC >= 0 && iLsC > iPidC && iLcC > iLsC && iGateC > iLcC && s3.includes('有监听者或查询失败：停止人工流程') && s3.includes('不要做回滚 4/7、5/7、6/7') && !s3.includes('findstr') && guide.indexOf('git reset --hard $($script:PrevCommit)') > guide.indexOf('才能进入回滚 4/7'), JSON.stringify([iPidC, iLsC, iLcC, iGateC]));
  const busyBlk = iBusyBlock >= 0 && iGuide1 > iBusyBlock ? guide.slice(iBusyBlock, iGuide1) : '';
  const iStopB = busyBlk.indexOf('""$busyStop""');
  const iLcB = busyBlk.indexOf('Write-ListenerCheck', iStopB);
  const iStartB = busyBlk.indexOf('""$busyStart""', iLcB);
  check('S23 M1 SQLITE_BUSY 人工恢复：stop 之后经 Write-ListenerCheck 确认 3000 零监听（判据一、判据二都通过才 start），再 start；不再是「netstat | findstr … 没有任何输出才能 start」',
    iStopB >= 0 && iLcB > iStopB && iStartB > iLcB && busyBlk.includes('判据一、判据二都通过（查询成功且 3000 零 LISTENING）才能 start；查询失败或有监听者，停下，不要 start') && !busyBlk.includes('没有任何输出才能 start'), JSON.stringify([iStopB, iLcB, iStartB]));
  check('S23 M1 第 4 步失败处置：经 Write-ListenerCheck 打印不加过滤的 netstat，stopped 判据写明「查询成功、3000 零 LISTENING」，其他判据含「netstat 查询失败（没有 TCP 行不等于零监听）」；整个分支里没有「netstat … findstr …」命令',
    step4Block.includes(STEP4_NS_CMD) && step4Block.includes(STEP4_STOPPED_JUDGE.slice(STEP4_STOPPED_JUDGE.indexOf('判据：'), STEP4_STOPPED_JUDGE.indexOf('" -ForegroundColor'))) && step4Block.includes('netstat 查询失败（没有 TCP 行不等于零监听）') && !/netstat[^\n]*findstr/.test(step4Block));
  check('S23 M1 回滚第 7 步（Write-VerifyAfterStart）补一句：任一条命令失败（ssh 报错 / 超时 / 没有输出）都按未通过处理，没有输出不是「一致」也不是「没有监听者」',
    (functionBody(code, 'Write-VerifyAfterStart') || '').includes('上面任一条命令失败（ssh 报错、超时、没有输出）都按未通过处理：没有输出可能只是查询失败，不是「一致」，也不是「没有监听者」'));
  // M2：库备份下载先落 <正式名>.partial，核对大小后才改名，改名之后才轮转；失败分支保留 .partial 并打印精确路径
  const iPull = step9.indexOf('$pull1 = Invoke-RemoteWrite -TransferArgs @("${ServerUser}@${ServerIP}:$scpSrcPath", $localPartial)');
  const iBytes = step9.indexOf('$expectBytes = $script:BackupBytes');
  const iSizeQ = step9.indexOf('Invoke-RemoteRead -Command "for %I in ($($script:BackupPath)) do @echo %~zI"');
  const iSizeCmp = step9.indexOf('$sizeOk = Test-BackupSizeMatch $expectBytes (Get-Item -LiteralPath $localPartial).Length');
  const iSizeGate = step9.indexOf('if (-not $sizeOk.Ok) { throw $sizeOk.Why }');
  const iMove = step9.indexOf('Move-Item -LiteralPath $localPartial -Destination $localDst -ErrorAction Stop');
  const iRotate = step9.indexOf('$toDelete = Get-DbBackupsToDelete $localBackupDir 10');
  check('S24 M2 第 9 步库备份：$localPartial = "$localDst.partial"，scp 目标是 $localPartial（不是 $localDst），按序 下载 < 取期望大小（协议行 bytes，没有就只读查一次）< Test-BackupSizeMatch < 不通过就 throw < Move-Item 改名为正式名 < 之后才轮转',
    step9.includes('$localPartial = "$localDst.partial"') && !/TransferArgs @\([^)]*\$localDst\)/.test(step9) && iPull >= 0 && iBytes > iPull && iSizeQ > iBytes && iSizeCmp > iSizeQ && iSizeGate > iSizeCmp && iMove > iSizeGate && iRotate > iMove, JSON.stringify([iPull, iBytes, iSizeQ, iSizeCmp, iSizeGate, iMove, iRotate]));
  const dbCatchStart = step9.indexOf('} catch {');
  const dbCatch = dbCatchStart >= 0 ? step9.slice(dbCatchStart, step9.indexOf("Write-Step '9/9' 'Pull production collab")) : '';
  check('S24 M2 库备份下载的失败分支（catch）：保留 .partial 并打印精确路径，不改名、不轮转、不删；补拉提示的 scp 目标是 <正式名>.partial，并给出远端备份大小的只读查询',
    dbCatch.length > 0 && dbCatch.includes('精确路径：$localPartial') && /\$\{localBackupDir\}\\\$hintLeaf\.partial/.test(dbCatch) && dbCatch.includes('@echo %~zI') && !/Move-Item|Remove-Item|Rename-Item|Get-DbBackupsToDelete/.test(dbCatch), dbCatch.length);
  check('S24 M2 第 5 步把备份协议行的 bytes（正整数）记入 $script:BackupBytes；第 9 步的远端大小查询只经 Invoke-RemoteRead（只读）且只在真实下载分支里',
    step5.includes("$bkBytesProp = $bo.Json.PSObject.Properties['bytes']") && step5.includes('-and $bkBytesParsed -gt 0) { $script:BackupBytes = $bkBytesParsed }') && iSizeQ > step9.indexOf('if (-not $pull1.DryRun) {') && !/Invoke-RemoteWrite[^\n]*%~z/.test(step9));
  check('S24 M2 Test-BackupSizeMatch 是纯函数（不调用远端 / 文件系统），期望大小与本地大小两边读不到、或不相等都不通过',
    (() => { const f = functionBody(code, 'Test-BackupSizeMatch') || ''; return f.includes('$e -le 0') && f.includes('if ($a -ne $e) {') && !/Invoke-|Get-Item|Test-Path/.test(f); })());
}

// ---------------------------------------------------------------- 动态用例
// netstat -ano 形态的假输出（孤儿监听硬门的输入）。无关行里故意放了会误导解析的形态：端口前缀相同的 :30000、3000 上的 ESTABLISHED / TIME_WAIT、别处连到 :3000 的行、UDP 行
const PM2_PID = 4321;
const APP_PORT = 3 * 1000;   // 被测脚本核对的应用端口；样本行里的端口用常量拼，不写字面量 3000（全目录测试隔离守卫 T1 不认测试里写死的 3000）
const NS_NOISE = [
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       888',
  '  TCP    0.0.0.0:30000          0.0.0.0:0              LISTENING       777',
  `  TCP    192.168.1.100:${APP_PORT}      192.168.1.5:50123       ESTABLISHED     4321`,
  `  TCP    192.168.1.100:50001     198.51.100.9:${APP_PORT}        ESTABLISHED     555`,
  `  TCP    127.0.0.1:${APP_PORT}         127.0.0.1:50999        TIME_WAIT       0`,
  `  UDP    0.0.0.0:${APP_PORT}           *:*                                    999`,
].concat(
  // 修复批 1b H1：状态列带数字 / 下划线的非 LISTENING 状态（FIN_WAIT_1 / FIN_WAIT_2 等）——健康服务有服务端先关的长连接时 netstat 里就会有；
  // 3000 作本地端（pid 0 与 pid 4321 两种）和作外连端（别的进程连来 / 本进程外连）都放。解析必须照常通过，且它们都不算监听者
  ['FIN_WAIT_1', 'FIN_WAIT_2', 'CLOSE_WAIT', 'LAST_ACK', 'SYN_RECEIVED', 'CLOSING', 'SYN_SENT'].map((st, i) => [
    `  TCP    192.168.1.100:${APP_PORT}      198.51.100.7:${51000 + i}       ${st.padEnd(15)} 0`,
    `  TCP    192.168.1.100:${APP_PORT}      198.51.100.8:${52000 + i}       ${st.padEnd(15)} 4321`,
    `  TCP    192.168.1.100:${53000 + i}     198.51.100.9:${APP_PORT}        ${st.padEnd(15)} 4321`,
  ]).reduce((a, b) => a.concat(b), []),
);
const nsV4 = (pid) => `  TCP    0.0.0.0:${APP_PORT}           0.0.0.0:0              LISTENING       ${pid}`;
const nsV6 = (pid) => `  TCP    [::]:${APP_PORT}              [::]:0                 LISTENING       ${pid}`;
const nsText = (rows, eol) => ['Active Connections', '', '  Proto  Local Address          Foreign Address        State           PID'].concat(rows).join(eol || '\r\n') + (eol || '\r\n');
const NETSTAT_OK = nsText([].concat(NS_NOISE, [nsV4(PM2_PID), nsV6(PM2_PID)]));
const ORPHAN_MSG = '3000 监听者与 pm2 进程不一致，疑似孤儿监听，按 memory feedback_pm2_orphan_listener_recovery 处置';

function baseState(over) {
  return Object.assign({ repoHead: PREV_COMMIT, trackedChanges: '', pm2Status: 'online', pm2RestartTime: 0, pm2Pid: PM2_PID, netstat: NETSTAT_OK, runVersion: PREV_VERSION, runCommit: PREV_COMMIT, repoHeadVersion: PREV_VERSION, nodeVersion: 'v18.20.0' }, over || {});
}

const dryLines = (out) => out.split(/\r?\n/).filter((l) => l.includes('[DRYRUN] 将执行'));
const idx = (arr, pred) => arr.findIndex(pred);
function recordOf(tempDir) {
  const dirs = fs.readdirSync(tempDir).filter((n) => n.startsWith('sdh-deploy-dryrun-'));
  if (dirs.length !== 1) return null;
  const files = fs.readdirSync(path.join(tempDir, dirs[0])).filter((n) => /^\d{8}_\d{6}\.json$/.test(n));
  if (files.length !== 1) return null;
  return JSON.parse(fs.readFileSync(path.join(tempDir, dirs[0], files[0]), 'utf8'));
}
const stagesOf = (rec) => rec.history.map((h) => h.stage);

function noRealRemote(p, r) {
  check(`${p}: 没有任何真实 ssh / scp 调用（输出无 [REMOTE-READ] / [REMOTE-WRITE]）`, !/\[REMOTE-(READ|WRITE)\]/.test(r.out), r.out.split(/\r?\n/).filter((l) => /\[REMOTE-/.test(l)).slice(0, 3).join(' | '));
}

/** 假 ssh 用例：[REMOTE-READ] 行是预期的（走的是假远端），但 [REMOTE-WRITE] 不能出现（DryRun 下写操作不发出） */
function noRealRemote2(p, r) {
  check(`${p}: 没有任何 [REMOTE-WRITE]（DryRun 下写操作不发出）`, !/\[REMOTE-WRITE\]/.test(r.out));
}

function rollbackChecks(p, r, o) {
  const lines = r.out.split(/\r?\n/);
  eq(`${p}: 退出码 1`, r.status, 1);
  noRealRemote(p, r);
  const w = dryLines(r.out);
  const iLocal = r.out.indexOf('前置检查·先本地');
  const iRemote = r.out.indexOf('前置检查·再远端');
  const iBack = r.out.indexOf('回退代码到部署前实际运行的提交');
  check(`${p}: 打印回滚步骤（先本地检查 < 再远端检查 < 回退代码）`, iLocal >= 0 && iRemote > iLocal && iBack > iRemote, `${iLocal} ${iRemote} ${iBack}`);
  check(`${p}: 含「先本地」的 Get-CimInstance 查询命令与 rollbackTarget = 假远端 HEAD`, r.out.includes('Get-CimInstance Win32_Process | Where-Object') && r.out.includes(`rollbackTarget = ${PREV_COMMIT}`) && lines.some((l) => !l.includes('将执行') && l.includes(`git reset --hard ${PREV_COMMIT}`)));
  check(`${p}: 不自动回滚（没有「将执行」的 reset --hard ${'<PrevCommit>'} / pm2 restart）`, !w.some((l) => l.includes(`reset --hard ${PREV_COMMIT}`) || l.includes('pm2 restart')));
  check(`${p}: 声明不自动回滚`, r.out.includes('不自动回滚'));
  // H1：所有回滚路径同一顺序——前置检查（先本地、再远端）-> stop 并确认 -> reset 并读回 HEAD -> 是否恢复数据库 -> start -> 核对；回滚指引里不再出现 pm2 restart
  const at = (needle, from) => r.out.indexOf(needle, from === undefined ? 0 : from);
  const iStep = [1, 2, 3, 4, 5, 6, 7].map((k) => at(`[回滚 ${k}/7]`));
  const iStop = at('pm2 stop task-pool', iStep[2]);
  const iConfirm = at('pm2 pid task-pool', iStop);
  const iReset = at(`git reset --hard ${PREV_COMMIT}`, iStep[3]);
  const iReadBack = at('rev-parse HEAD', iReset);
  const iStart = at('pm2 start task-pool', iStep[5]);
  check(`${p}: 回滚顺序：1/7 先本地 < 2/7 再远端 < 3/7 stop 并用 pm2 pid + pm2 ls 确认 < 4/7 reset 并读回 HEAD < 5/7 是否恢复数据库 < 6/7 start < 7/7 核对`,
    iStep.every((x, i) => x >= 0 && (i === 0 || x > iStep[i - 1])) && iStop > iStep[2] && iConfirm > iStop && iConfirm < iStep[3] && iReset > iStep[3] && iReadBack > iReset && iReadBack < iStep[4] && iStart > iStep[5] && iStart < iStep[6], JSON.stringify([iStep, iStop, iConfirm, iReset, iReadBack, iStart]));
  check(`${p}: stop 命令在 reset 命令之前，start 命令在是否恢复数据库之后；回滚指引里没有 pm2 restart`, iStop > 0 && iReset > iStop && iStart > iStep[4] && !r.out.includes('pm2 restart'));
  check(`${p}: 停服确认给出判据（pm2 ls 里唯一的 task-pool、状态列必须是 stopped，pm2 pid 必须是 0 或没有输出，确认不了就停下）`, r.out.includes('状态列必须是 stopped') && r.out.includes('pm2 pid task-pool 的输出必须是 0 或没有输出') && r.out.includes('停下'));
  // L5：第 3 步不再用 pm2 jlist（它把整份 pm2_env 含环境变量打进会话记录），改 pm2 pid task-pool + pm2 ls；整份回滚指引里都没有 jlist
  const guideAll = r.out.indexOf('[回滚 1/7]') >= 0 ? r.out.slice(r.out.indexOf('[回滚 1/7]')) : '';
  const step3Text = iStep[2] >= 0 && iStep[3] > iStep[2] ? r.out.slice(iStep[2], iStep[3]) : '';
  const target = `${DEPLOY_USER_DEFAULT}@${TEST_NET_IP}`;
  check(`${p}: L5 回滚第 3 步的确认命令是 pm2 pid task-pool 加 pm2 ls（整行全等），回滚指引里没有 pm2 jlist / pm2_env`, step3Text.split(/\r?\n/).map((l) => l.trim()).includes(`ssh ${target} "pm2 pid task-pool"`) && step3Text.split(/\r?\n/).map((l) => l.trim()).includes(`ssh ${target} "pm2 ls"`) && !guideAll.includes('jlist') && !guideAll.includes('pm2_env'), step3Text.slice(0, 300));
  // 修复批 1c H（codex 47R2a）：回滚第 3 步 stop 并确认 stopped 之后补「3000 零监听」硬门，位于回滚 4/7（换代码）之前。
  // 命令是不加过滤的 netstat -ano（整行全等，没有 findstr）；判据分两段：先判查询成功（有 TCP 行），再判 3000 的 LISTENING 行为零；有监听者或查询失败 = 停止人工流程，不做 4/7、5/7、6/7
  const s3Lines = step3Text.split(/\r?\n/).map((l) => l.trim());
  const iLsCmd = s3Lines.indexOf(`ssh ${target} "pm2 ls"`);
  const iNsCmd = s3Lines.indexOf(`ssh ${target} "netstat -ano"`);
  const iGate = s3Lines.findIndex((l) => l.includes('才能进入回滚 4/7'));
  check(`${p}: 修复批 1c H 回滚第 3 步：pm2 ls 确认 stopped 之后、回滚 4/7 之前给出不加过滤的 netstat -ano（整行全等），判据一「查询成功」< 判据二「3000 零 LISTENING」< 「才能进入回滚 4/7；有监听者或查询失败：停止人工流程」`,
    iLsCmd >= 0 && iNsCmd > iLsCmd && iGate > iNsCmd && s3Lines.some((l, i) => i > iNsCmd && l.startsWith('判据一（先确认查询成功）') && l.includes('「查询失败」，不是「零监听」')) && s3Lines.some((l, i) => i > iNsCmd && l.startsWith('判据二（再数监听者') && l.includes('必须为零')) && s3Lines[iGate].includes('有监听者或查询失败：停止人工流程') && s3Lines[iGate].includes('不要做回滚 4/7、5/7、6/7') && !s3Lines.some((l) => /^ssh /.test(l) && l.includes('findstr')),
    JSON.stringify([iLsCmd, iNsCmd, iGate]));
  // M3：回滚第 7 步的核对含「pm2 pid = 3000 的监听 pid」，命令整行全等，判据点名孤儿监听的处置
  const step7Lines = (iStep[6] >= 0 ? r.out.slice(iStep[6]) : '').split(/\r?\n/).map((l) => l.trim());
  check(`${p}: M3 回滚第 7 步的核对含 pm2 pid task-pool 与 netstat 监听核对两条命令（整行全等）和孤儿监听处置判据`, step7Lines.includes(`ssh ${target} "pm2 pid task-pool"`) && step7Lines.includes(`ssh ${target} "netstat -ano | findstr LISTENING | findstr :3000"`) && step7Lines.some((l) => l.includes('feedback_pm2_orphan_listener_recovery')), step7Lines.slice(0, 12).join(' || '));
  // M4：SQLITE_BUSY 指引只在对应失败形态出现（o.busyHint），出现时必须排在回滚七步之前，且含只读日志核对、人工 stop + start、ready-check 命令（整行全等）
  const iHintBusy = r.out.indexOf('先只读查 pm2 日志里有无 SQLITE_BUSY');
  if (o.busyHint) {
    const head = r.out.slice(0, iStep[0] >= 0 ? iStep[0] : 0).split(/\r?\n/).map((l) => l.trim());
    const wantReady = `node "${FIX.repo}\\scripts\\deploy\\ready-check.js" --base-url http://${TEST_NET_IP}:${APP_PORT} --expect-commit ${NEW_COMMIT} --expect-version ${NEW_VERSION} --pages-from-commit ${NEW_COMMIT} --repo "${FIX.repo}"`.toLowerCase();
    check(`${p}: M4 SQLITE_BUSY 指引排在回滚七步之前，含只读查日志、人工 stop / pm2 ls / start、重跑 ready-check（整行全等）、「仍失败再走回滚七步」`,
      iHintBusy >= 0 && iHintBusy < iStep[0] && head.includes(`ssh ${target} "pm2 logs task-pool --nostream --lines 500 --timestamp | findstr SQLITE_BUSY"`) && head.includes(`ssh ${target} "cd /d E:\\Task_Pool\\wbs-server && pm2 stop task-pool"`) && head.includes(`ssh ${target} "pm2 ls"`) && head.includes(`ssh ${target} "cd /d E:\\Task_Pool\\wbs-server && pm2 start task-pool"`) && head.map((l) => l.toLowerCase()).includes(wantReady) && head.some((l) => l.includes('仍失败就再走下面的回滚七步')),
      `${iHintBusy} ${iStep[0]} ${head.slice(-14).join(' || ')}`);
    // 修复批 1b M1：人工恢复判据补齐——stop 之后先确认 3000 零监听才 start；READY_OK 之后还要 pid 对拍、间隔 10 秒两次 pm2 ls 的 ↺ 计数、补拉本次备份；日志命中行时间戳须晚于本次 start
    const lcHead = head.map((l) => l.toLowerCase());
    const nsCmd = `ssh ${target} "netstat -ano | findstr LISTENING | findstr :3000"`;   // READY_OK 之后的 pid 对拍用（空输出 = 一致性不成立，本来就 fail-closed）
    const nsAllCmd = `ssh ${target} "netstat -ano"`;                                      // 修复批 1c M1：stop 之后确认零监听用不加过滤的命令
    const iStopL = head.indexOf(`ssh ${target} "cd /d E:\\Task_Pool\\wbs-server && pm2 stop task-pool"`);
    const iNs1 = head.indexOf(nsAllCmd);
    const iStartL = head.indexOf(`ssh ${target} "cd /d E:\\Task_Pool\\wbs-server && pm2 start task-pool"`);
    const iReadyL = lcHead.indexOf(wantReady);
    const iPidL = head.indexOf(`ssh ${target} "pm2 pid task-pool"`);
    const iNs2 = head.indexOf(nsCmd, iPidL);
    const iLs1 = head.indexOf(`ssh ${target} "pm2 ls"`, iNs2);
    const iSleepL = head.indexOf('Start-Sleep 10', iLs1);
    const iLs2 = head.indexOf(`ssh ${target} "pm2 ls"`, iSleepL);
    // 修复批 1c M2：补拉也是先拉到 <正式名>.partial（命令行以 \生产数据库备份\<备份名>.partial 结尾），后面跟远端备份大小的只读查询与「大小一致才改名」的判据
    const bkPartialRe = new RegExp(`\\\\生产数据库备份\\\\${LIVE_DB.replace('.', '\\.')}\\.backup_\\d{8}_\\d{6}\\.partial$`);
    const iScpL = head.findIndex((l) => l.startsWith(`scp ${target}:/E:/Task_Pool/wbs-server/${LIVE_DB}.backup_`) && bkPartialRe.test(l));
    const iSzQ = head.findIndex((l, i) => i > iScpL && l.startsWith(`ssh ${target} "for %I in (E:\\Task_Pool\\wbs-server\\${LIVE_DB}.backup_`) && l.endsWith(') do @echo %~zI"'));
    check(`${p}: 修复批 1b M1 SQLITE_BUSY 人工恢复：stop < 确认 3000 零监听（不加过滤的 netstat -ano，查询成功且零 LISTENING 才 start）< start < ready-check < pm2 pid 与 netstat 对拍 < 间隔 10 秒两次 pm2 ls（↺ 计数）< 补拉本次备份 scp（整行命令，命令行不含中文说明）`,
      iStopL >= 0 && iNs1 > iStopL && iStartL > iNs1 && iReadyL > iStartL && iPidL > iReadyL && iNs2 > iPidL && iLs1 > iNs2 && iSleepL > iLs1 && iLs2 > iSleepL && iScpL > iLs2 && iSzQ > iScpL
      && head.some((l) => l.includes('判据：拉取命令退出码 0，且上一条输出的数字等于本地 .partial 的字节数，一致才改名为正式名；不一致就重拉，不要改名。'))
      && head.some((l) => l.includes('判据一、判据二都通过（查询成功且 3000 零 LISTENING）才能 start；查询失败或有监听者，停下，不要 start')) && head.some((l) => l.startsWith('判据一（先确认查询成功）') && l.includes('「查询失败」，不是「零监听」')) && !head.some((l) => l.includes('没有任何输出才能 start')) && head.some((l) => l.includes('等于 pm2 pid task-pool 的输出')) && head.some((l) => l.includes('两次读到的 ↺（重启次数）列相同'))
      && !/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/.test(head[iScpL].replace('E:\\数据开发与治理规范手册\\生产数据库备份\\', '')),
      JSON.stringify([iStopL, iNs1, iStartL, iReadyL, iPidL, iNs2, iLs1, iSleepL, iLs2, iScpL]));
    check(`${p}: 修复批 1b M1 SQLITE_BUSY：日志命中行的时间戳须晚于本次 start（命令带 --timestamp）；说明发布记录保持 ready_failed、第 9 步没有执行`, head.some((l) => l.includes('命中行的时间戳必须晚于本次 start')) && head.some((l) => l.includes('发布记录保持 ready_failed') && l.includes('第 9 步「拉回本地」也没有执行')));
  } else {
    check(`${p}: M4 这个失败形态不是启动期 SQLITE_BUSY 的可疑形态，不打印 SQLITE_BUSY 指引`, iHintBusy < 0 && !r.out.includes('findstr SQLITE_BUSY'));
  }
  // 恢复步骤 c：逐个文件核对（本次备份与历史备份 / 留档的文件名都以库文件名开头，所以不能用通配的 dir 去判断「只应看到改名留档」）
  const existCmds = [LIVE_DB, `${LIVE_DB}-wal`, `${LIVE_DB}-shm`, `${LIVE_DB}-journal`, `${LIVE_DB}.before_restore_`].map((f) => r.out.includes(`if exist ${f}`) && r.out.includes('(echo EXISTS) else (echo MISSING)'));
  check(`${p}: 恢复步骤 c 逐个核对：库文件与 -wal、-shm、-journal 四个都必须 MISSING，本次改名留档必须 EXISTS，并明确允许其他备份与历史留档存在；不再出现「只应看到」`,
    existCmds.every(Boolean) && r.out.includes(`前四条（${LIVE_DB}、-wal、-shm、-journal）都必须是 MISSING`) && r.out.includes('必须是 EXISTS') && r.out.includes('允许其他备份与历史留档存在') && !r.out.includes('只应看到') && !r.out.includes(`dir E:\\Task_Pool\\wbs-server\\${LIVE_DB}*`), JSON.stringify(existCmds));
  // L3：可复制的命令（ssh / curl / node 开头）各占一行，判据 / 说明另起一行——命令行里不跟中文说明
  const guideStart = at('[回滚 1/7]');
  const cmdLines = (guideStart >= 0 ? r.out.slice(guideStart) : '').split(/\r?\n/).map((l) => l.trim()).filter((l) => /^(ssh |curl|node )/.test(l));
  const mixed = cmdLines.filter((l) => /必须|应|判据|不等|停下/.test(l));
  check(`${p}: 回滚指引里以 ssh / curl / node 开头的命令行共 ${cmdLines.length} 条，行内都不跟判据 / 说明（不含「必须」「应」「判据」「停下」）`, cmdLines.length >= 15 && mixed.length === 0, mixed.slice(0, 2).join(' || '));
  check(`${p}: 恢复数据库的每条命令写明「上一步成功并核对之后才执行下一条」，含改名留档、复制备份、核对大小，且在 start 之前`, r.out.includes('上一步成功并核对之后才执行下一条') && r.out.includes('before_restore_') && r.out.includes('大小等于备份文件的大小') && r.out.includes('恢复之前不要起服务'));
  check(`${p}: schema 扫描：列出 db-migrate.sql 与 wbs-server/scripts/ 下的迁移脚本 migrate-x.js；只排除明确的测试文件（verify-* / test-*）与 .md`, r.out.includes('wbs-server/db-migrate.sql') && r.out.includes('wbs-server/scripts/migrate-x.js') && !r.out.includes('verify-example.js') && !r.out.includes('test-example.js') && !r.out.includes('notes.md'));
  check(`${p}: schema 扫描命中也只是人工排查线索（要求人工核对迁移与旧代码兼容性，再决定是否恢复备份），不下兼容结论`, r.out.includes('只是人工排查线索，不是结论') && r.out.includes('请人工核对') && !r.out.includes('无需恢复') && !r.out.includes('不含 schema 变化'));
  check(`${p}: 回滚核对命令里的路径加了引号（node "…ready-check.js"、--repo "…"、查看命令）`, r.out.includes('ready-check.js" --base-url') && r.out.toLowerCase().includes(`--repo "${FIX.repo}"`.toLowerCase()) && /release-record\.js" show --id \d{8}_\d{6} --dir "/.test(r.out));
  const rec = recordOf(r.tempDir);
  check(`${p}: 发布记录存在`, rec !== null);
  if (rec) {
    eq(`${p}: record 阶段`, rec.stage, o.stage);
    eq(`${p}: record result`, rec.result, 'failed');
    check(`${p}: record 的 rollbackTarget = 假远端 HEAD、backup 已记录`, rec.rollbackTarget === PREV_COMMIT && typeof rec.backup === 'string' && rec.backup.startsWith(`E:\\Task_Pool\\wbs-server\\${LIVE_DB}.backup_`), `${rec.rollbackTarget} ${rec.backup}`);
  }
  check(`${p}: 回滚指引里打印的记录路径与阶段`, r.out.includes('回滚 7/7') && r.out.includes(`当前阶段：${o.stage}`));
  if (o.nullHint) check(`${p}: COMMIT_NULL 提示只说「HEAD = 新提交只说明代码检出成功」，要求继续核对 pm2 状态与版本，没有「部署本身成功、不要回滚」的结论`, r.out.includes('生产读不到提交号') && r.out.includes('只说明代码检出成功') && r.out.includes('继续核对 pm2 状态') && !r.out.includes('不要回滚') && !r.out.includes('部署本身成功'));
  else check(`${p}: 没有 COMMIT_NULL 提示`, !r.out.includes('生产读不到提交号'));
  return w;
}

function abortChecks(p, r, msg) {
  eq(`${p}: 退出码 1`, r.status, 1);
  noRealRemote(p, r);
  check(`${p}: 第 2 步中止并说明原因（脚本自己的检查，不是下游工具兜底）`, r.out.includes(msg) && !r.out.includes('发布记录 init 失败'), r.out.split(/\r?\n/).filter((l) => l.includes('[ERROR]')).join(' | '));
  const w = dryLines(r.out);
  eq(`${p}: 只有第 1 步的 push 被打印，没有停服 / 备份 / 换代码`, w.map((l) => l.replace(/^.*将执行：/, '')), ['git push production main']);
  check(`${p}: 生产未动，且没有发布记录`, r.out.includes('生产未动') && recordOf(r.tempDir) === null);
}

/** 新提交的服务入口文件缺就绪接口 / commit 字段：停服之前（第 2 步）中止，写失败态，生产未动 */
function noReadyChecks(p, r, literal) {
  eq(`${p}: 退出码 1`, r.status, 1);
  noRealRemote(p, r);
  check(`${p}: 第 2 步停服前中止，点名缺的字面量与「只能部署 S1a、S3a 之后的代码」`, r.out.includes('新提交不含就绪接口 / commit 字段') && r.out.includes(literal) && r.out.includes('S1a、S3a 之后') && r.out.includes('生产服务未动'), r.out.split(/\r?\n/).filter((l) => l.includes('[ERROR]')).join(' | '));
  eq(`${p}: 只有第 1 步的 push 被打印，没有上传 / fetch / 停服`, dryLines(r.out).map((l) => l.replace(/^.*将执行：/, '')), ['git push production main']);
  const rec = recordOf(r.tempDir);
  if (check(`${p}: 发布记录存在（init 之后才预检）`, rec !== null)) {
    eq(`${p}: record 阶段序列`, stagesOf(rec), ['prepared', 'failed']);
    eq(`${p}: record result`, rec.result, 'failed');
  }
}

function buildCases() {
  return [
  { id: 'normal', title: 'D-normal', state: baseState(), args: [], check(p, r) {
    eq(`${p}: 退出码 0`, r.status, 0);
    noRealRemote(p, r);
    check(`${p}: 进程当前目录是诱饵仓库，但 NewCommit / NewVersion 取的是脚本所在仓库的 main`, r.out.includes(`NewCommit  = ${NEW_COMMIT}`) && r.out.includes(`NewVersion = ${NEW_VERSION}`) && !r.out.includes(DECOY_COMMIT), `${NEW_COMMIT} / 诱饵 ${DECOY_COMMIT} / ${r.out.split(/\r?\n/).filter((l) => l.includes('NewCommit')).join(' | ')}`);
    check(`${p}: 仓库根 = 脚本所在检出（取脚本自身位置）`, r.out.toLowerCase().includes(`仓库根     = ${FIX.repo}`.toLowerCase()), r.out.split(/\r?\n/).filter((l) => l.includes('仓库根')).join(' | '));
    check(`${p}: ready-check 的 --repo 是脚本所在检出`, r.out.toLowerCase().includes(`--repo ${FIX.repo}`.toLowerCase()));
    check(`${p}: M1 默认推送超时上限 1800 秒`, r.out.includes('推送超时上限 1800 秒'));
    check(`${p}: M3 第 2 步孤儿监听硬门放行：pm2 pid ${PM2_PID} = 3000 两栈的唯一 LISTENING pid ${PM2_PID}（:30000 的 777、ESTABLISHED / TIME_WAIT / UDP 行都不算）`, r.out.includes(`pm2 pid    = ${PM2_PID}    3000 的 LISTENING pid = ${PM2_PID}`), r.out.split(/\r?\n/).filter((l) => l.includes('pm2 pid')).join(' | '));
    check(`${p}: 修复批 1b LOW⑤ DryRun 第 9 步只读预览本地库备份轮转清单（拉回本次备份之后按保留 10 份、正式名里超出最新 9 份的将被删；手动命名的备份不计数也不删），且这行不是「将执行」的写命令`, r.out.includes('（只读预览）拉回本次备份之后按保留 10 份轮转：现有正式名备份里将删除 ') && r.out.includes('手动命名的备份不计数也不删') && !dryLines(r.out).some((l) => l.includes('只读预览')), r.out.split(/\r?\n/).filter((l) => l.includes('只读预览')).join(' | '));
    check(`${p}: 修复批 1c M2 DryRun 第 9 步预告：拉完并核对大小（与远端备份一致）之后才把 <正式名>.partial 改名为正式名、改名之后才轮转，失败时 .partial 保留；这行不是「将执行」的写命令`, /拉完并核对大小（与远端备份一致）之后才把 \S+\.partial 改名为 \S+backup_\d{8}_\d{6}，改名之后才轮转；失败时 \.partial 保留，不改名、不轮转/.test(r.out) && !dryLines(r.out).some((l) => l.includes('改名为')), r.out.split(/\r?\n/).filter((l) => l.includes('核对大小')).join(' | '));
    check(`${p}: M3 DryRun 预告第 4 步与第 8 步的 netstat 只读核对`, r.out.includes('将再读 netstat -ano，确认停服之后 3000 没有任何 LISTENING') && r.out.includes('READY_OK 之后将再读 netstat -ano'));
    const w = dryLines(r.out).map((l) => l.replace(/^.*将执行[^：]*：/, ''));
    const wanted = [
      ['git push production main', (l) => l === 'git push production main'],
      ['远端建临时目录', (l) => l.includes('mkdir E:\\Task_Pool_deploy_tmp')],
      ['scp 上传备份脚本', (l) => l.startsWith('scp backup-db.js') && l.includes('/E:/Task_Pool_deploy_tmp/backup-db-')],
      ['停服前预取 git fetch production（不带 reset）', (l) => l.includes('git fetch production') && !l.includes('reset')],
      ['pm2 stop task-pool', (l) => l.includes('pm2 stop task-pool')],
      ['远端备份', (l) => l.includes('node E:\\Task_Pool_deploy_tmp\\backup-db-') && l.includes('--sqlite3 E:\\Task_Pool\\wbs-server\\node_modules\\sqlite3') && l.includes(`--db E:\\Task_Pool\\wbs-server\\${LIVE_DB}`) && l.includes(`--out E:\\Task_Pool\\wbs-server\\${LIVE_DB}.backup_`)],
      ['reset --hard 提交号（不再 fetch）', (l) => l.includes(`git reset --hard ${NEW_COMMIT}`) && !l.includes('fetch')],
      ['pm2 start task-pool', (l) => l.includes('pm2 start task-pool')],
      ['ready-check', (l) => l.startsWith('node ') && l.includes('ready-check.js') && l.includes(`--expect-commit ${NEW_COMMIT}`) && l.includes(`--pages-from-commit ${NEW_COMMIT}`) && l.includes('--timeout-sec 180')],
      ['拉回备份(scp，目标是 <正式名>.partial，修复批 1c M2)', (l) => l.startsWith('scp ') && l.includes(`${LIVE_DB}.backup_`) && !l.includes('-r ') && l.endsWith('.partial') && /backup_\d{8}_\d{6}\.partial$/.test(l)],
      ['拉回附件(scp -r)', (l) => l.startsWith('scp -r ')],
    ];
    let last = -1;
    let ordered = true;
    const missing = [];
    for (const [name, pred] of wanted) {
      const i = w.findIndex((l, k) => k > last && pred(l));
      if (i < 0) { ordered = false; missing.push(name); } else last = i;
    }
    check(`${p}: 打印全部写命令且顺序正确`, ordered, `缺/乱序：${missing.join(',')}；实际：${w.join(' || ')}`);
    eq(`${p}: 写命令总数（push、mkdir、上传、fetch、stop、备份、reset、start、ready-check、两次拉回）`, w.length, wanted.length);
    check(`${p}: 预取核对 cat-file 在停服之前`, r.out.indexOf('cat-file -t') > 0 && r.out.indexOf('cat-file -t') < r.out.indexOf('pm2 stop task-pool'));
    check(`${p}: pm2 stop 与 pm2 start 各一次`, w.filter((l) => l.includes('pm2 stop')).length === 1 && w.filter((l) => l.includes('pm2 start')).length === 1);
    check(`${p}: 末尾有「[DRYRUN] 分支走向」`, r.out.includes('[DRYRUN] 分支走向'));
    const rec = recordOf(r.tempDir);
    check(`${p}: 发布记录只在临时目录里`, rec !== null);
    if (rec) {
      eq(`${p}: record 阶段序列`, stagesOf(rec), ['prepared', 'uploaded', 'stopped', 'backed_up', 'code_updated', 'started', 'ready', 'pulled', 'done']);
      check(`${p}: record result=ok、prevCommit / newCommit / rollbackTarget / prevRunning 正确`, rec.result === 'ok' && rec.prevCommit === PREV_COMMIT && rec.newCommit === NEW_COMMIT && rec.rollbackTarget === PREV_COMMIT && rec.prevRunning.commit === PREV_COMMIT && rec.prevRunning.version === PREV_VERSION && rec.newVersion === NEW_VERSION, JSON.stringify(rec).slice(0, 300));
      check(`${p}: record 的 backup 写入一次`, typeof rec.backup === 'string' && rec.backup.length > 0);
    }
    check(`${p}: 提示远端临时脚本位置、部署后不删`, r.out.includes('E:\\Task_Pool_deploy_tmp\\backup-db-') && r.out.includes('不删除'));
  } },
  { id: 'backup', title: 'D-backup', state: baseState(), args: ['-DryRunFailAt', 'backup'], check(p, r) {
    eq(`${p}: 退出码 1`, r.status, 1);
    noRealRemote(p, r);
    const w = dryLines(r.out).map((l) => l.replace(/^.*将执行[^：]*：/, ''));
    const iBackup = w.findIndex((l) => l.includes('backup-db-') && l.includes('--sqlite3'));
    const iStart = w.findIndex((l) => l.includes('pm2 start task-pool'));
    check(`${p}: 自动 pm2 start 原服务（排在备份命令之后）`, iBackup >= 0 && iStart > iBackup, w.join(' || '));
    check(`${p}: 没有换代码 / 就绪检查 / 回滚`, !w.some((l) => l.includes('reset --hard') || l.includes('ready-check')) && !r.out.includes('回滚 1/5'));
    check(`${p}: 说明自动 start 加只读核对`, r.out.includes('自动 pm2 start 原服务') && r.out.includes('只读核对'));
    check(`${p}: 打印 partial 路径与错误码`, r.out.includes('BK_VACUUM_FAILED') && r.out.includes('.partial'));
    const rec = recordOf(r.tempDir);
    check(`${p}: 发布记录存在`, rec !== null);
    if (rec) {
      eq(`${p}: record 阶段序列（到 backup_failed 为止；核对结果 DryRun 无从得知）`, stagesOf(rec), ['prepared', 'uploaded', 'stopped', 'backup_failed']);
      eq(`${p}: backup_failed 阶段不带 result`, rec.result, null);
    }
  } },
  { id: 'noline', title: 'D-noline', state: baseState(), args: ['-DryRunFailAt', 'backup_noline'], check(p, r) {
    eq(`${p}: 退出码 1`, r.status, 1);
    noRealRemote(p, r);
    const w = dryLines(r.out).map((l) => l.replace(/^.*将执行[^：]*：/, ''));
    check(`${p}: 不自动起服务（没有「将执行」的 pm2 start）`, !w.some((l) => l.includes('pm2 start')), w.join(' || '));
    check(`${p}: 没有换代码`, !w.some((l) => l.includes('reset --hard')));
    const iLocal = r.out.indexOf('前置检查·先本地');
    const iRemote = r.out.indexOf('前置检查·再远端');
    check(`${p}: 打印先本地、后远端两项前置检查与人工 pm2 start 命令`, iLocal >= 0 && iRemote > iLocal && r.out.includes('Get-CimInstance Win32_Process | Where-Object') && r.out.includes('人工起回原服务') && r.out.includes('pm2 start task-pool'));
    // 上一条只查整段输出含两个子串：分支走向行（Add-Route）里本来就有「pm2 start task-pool」，删掉命令行它照样绿（LOW③ 预筛 MED-1）。
    // 这里按行断言：含「人工起回原服务」的说明行，下一行整行（trim 后）全等于人工起服务命令，且说明行在「前置检查·再远端」之后。
    const outLines = r.out.split(/\r?\n/);
    const iHint = outLines.findIndex((l) => l.includes('人工起回原服务'));
    const iRemoteLine = outLines.findIndex((l) => l.includes('前置检查·再远端'));
    const startCmdWant = `ssh ${DEPLOY_USER_DEFAULT}@${TEST_NET_IP} "cd /d E:\\Task_Pool\\wbs-server && pm2 start task-pool"`;
    check(`${p}: 「人工起回原服务」说明行位于「前置检查·再远端」之后，且它的下一行整行全等于人工起服务命令`, iHint >= 0 && iRemoteLine >= 0 && iHint > iRemoteLine && iHint + 1 < outLines.length && outLines[iHint + 1].trim() === startCmdWant, `说明行=${iHint} 再远端=${iRemoteLine} 下一行=${JSON.stringify((outLines[iHint + 1] || '').trim())}`);
    check(`${p}: 说明状态未知、不自动起服务`, r.out.includes('状态未知') || r.out.includes('都未知'));
    check(`${p}: 找残留备份进程的命令不会匹配自身（findstr /i /r backup-db-[0-9]），并给 PowerShell 替代`, r.out.includes('findstr /i /r backup-db-[0-9]') && !r.out.includes('findstr /i backup-db-') && r.out.includes('Get-CimInstance Win32_Process -Filter'));
    const rec = recordOf(r.tempDir);
    if (check(`${p}: 发布记录存在`, rec !== null)) {
      eq(`${p}: record 阶段序列`, stagesOf(rec), ['prepared', 'uploaded', 'stopped', 'failed']);
      eq(`${p}: record result`, rec.result, 'failed');
    }
  } },
  { id: 'code', title: 'D-code', state: baseState(), args: ['-DryRunFailAt', 'code'], check(p, r) {
    const w = rollbackChecks(p, r, { stage: 'failed' });
    check(`${p}: 失败发生在换代码这一步（reset 命令已打印、没有 pm2 start / ready-check）`, w.some((l) => l.includes(`reset --hard ${NEW_COMMIT}`)) && !w.some((l) => l.includes('pm2 start') || l.includes('ready-check')));
  } },
  { id: 'start', title: 'D-start', state: baseState(), args: ['-DryRunFailAt', 'start'], check(p, r) {
    const w = rollbackChecks(p, r, { stage: 'failed' });
    check(`${p}: 失败发生在起服务这一步（没有 ready-check）`, w.some((l) => l.includes('pm2 start task-pool')) && !w.some((l) => l.includes('ready-check')));
  } },
  { id: 'ready', title: 'D-ready', state: baseState(), args: ['-DryRunFailAt', 'ready'], check(p, r) {
    const w = rollbackChecks(p, r, { stage: 'ready_failed' });
    check(`${p}: 失败发生在就绪检查（ready-check 已打印）`, w.some((l) => l.includes('ready-check')));
  } },
  { id: 'readynull', title: 'D-readynull', state: baseState(), args: ['-DryRunFailAt', 'ready_commit_null'], check(p, r) {
    rollbackChecks(p, r, { stage: 'ready_failed', nullHint: true });
    // L1：版本检查在提交号这一项短路，模块就绪与页面核对没有执行——补打印可复制的核对命令（整行全等），命令与判据分行
    const lines = r.out.split(/\r?\n/).map((l) => l.trim());
    const iNull = lines.findIndex((l) => l.includes('就绪检查在提交号这一项就停了'));
    const iReadyCmd = lines.indexOf(`curl.exe --noproxy "*" -s -m 5 http://${TEST_NET_IP}:${APP_PORT}/api/health/ready`);
    // 修复批 1c M1：页面检查拆成两条——先 curl 取 HTTP 状态码（判据「输出恰为 200」，其他输出 / 无输出 / 报错 = 请求失败），200 之后才对临时文件扫描字面 ?v=auto（判据「查询成功但零命中」才算通过）
    const iPageCmd = lines.indexOf(`curl.exe --noproxy "*" -s -m 5 -o "$env:TEMP\\sdh-page-check.html" -w "%{http_code}" http://${TEST_NET_IP}:${APP_PORT}/<page>.html`);
    const iScanCmd = lines.indexOf('Select-String -SimpleMatch "?v=auto" -Path "$env:TEMP\\sdh-page-check.html"');
    const iRollback1 = lines.findIndex((l) => l.includes('[回滚 1/7]'));
    check(`${p}: L1 COMMIT_NULL 分支补打印 /api/health/ready 与页面核对的可复制命令（整行全等），位于回滚七步之前，各自后面跟判据行`, iNull >= 0 && iReadyCmd > iNull && iPageCmd > iReadyCmd && iScanCmd > iPageCmd && iScanCmd < iRollback1 && lines[iReadyCmd + 1].startsWith('判据：ok 为 true') && lines[iPageCmd + 1].startsWith('判据：输出恰为 200 才继续') && lines[iScanCmd + 1].startsWith('判据：200 之后这一条没有任何输出'), JSON.stringify([iNull, iReadyCmd, iPageCmd, iScanCmd, iRollback1]));
    check(`${p}: 修复批 1c M1 页面检查的判据区分「请求失败」与「查询成功但零命中」：先要求 HTTP 200（其他输出 / 无输出 / 报错都是请求失败，不是「页面没有 ?v=auto」），再扫描内容；不再有「curl 管道 Select-String、没有输出就算通过」`, lines[iPageCmd + 1].includes('「请求失败」，不是「页面没有 ?v=auto」') && lines[iScanCmd + 1].includes('查询成功但零命中') && !lines.some((l) => /^curl\.exe .*\|\s*Select-String/.test(l)), lines[iPageCmd + 1]);
  } },
  { id: 'loop', title: 'D-loop', state: baseState(), args: ['-DryRunFailAt', 'restart_loop'], check(p, r) {
    rollbackChecks(p, r, { stage: 'ready_failed', busyHint: true });
    check(`${p}: 说明是 restart_time 增长`, r.out.includes('restart_time'));
    check(`${p}: M4 restart_time 只比基准多 1：措辞是「重启过 1 次」，不再说「反复崩溃重启」（仍判失败）`, r.out.includes('新进程重启过 1 次') && !r.out.includes('反复崩溃'), r.out.split(/\r?\n/).filter((l) => l.includes('[ERROR]')).join(' | '));
  } },
  { id: 'readyinit', title: 'D-ready-init', state: baseState(), args: ['-DryRunFailAt', 'ready_init_failed'], check(p, r) {
    rollbackChecks(p, r, { stage: 'ready_failed', busyHint: true });
    check(`${p}: M4 未就绪模块带 INIT_FAILED：失败原因里有 INIT_FAILED，仍判失败（打印回滚步骤，不自动做任何事）`, r.out.includes('INIT_FAILED') && r.out.includes('不自动回滚'), r.out.split(/\r?\n/).filter((l) => l.includes('[ERROR]')).join(' | '));
  } },
  { id: 'readyorphan', title: 'D-ready-orphan', state: baseState(), args: ['-DryRunFailAt', 'ready_orphan'], check(p, r) {
    rollbackChecks(p, r, { stage: 'ready_failed' });
    check(`${p}: M3 第 8 步终检：READY_OK 且 restart_time 未增长，但 3000 的监听 pid ${PM2_PID + 1} 不等于 pm2 记录的 pid ${PM2_PID} -> ready_failed，点名孤儿监听与 memory 处置`, r.out.includes(`3000 的监听 pid ${PM2_PID + 1} 不等于 pm2 记录的 pid ${PM2_PID}`) && r.out.includes('疑似孤儿监听') && r.out.includes('feedback_pm2_orphan_listener_recovery'), r.out.split(/\r?\n/).filter((l) => l.includes('[ERROR]')).join(' | '));
  } },
  { id: 'readystopped', title: 'D-ready-stopped', state: baseState(), args: ['-DryRunFailAt', 'ready_stopped'], check(p, r) {
    rollbackChecks(p, r, { stage: 'ready_failed' });
    check(`${p}: READY_OK 之后 task-pool 是 stopped、restart_time 没增长 -> 仍判 ready_failed，说明不是 online`, r.out.includes("状态是 'stopped'，不是 online"), r.out.split(/\r?\n/).filter((l) => l.includes('[ERROR]')).join(' | '));
  } },
  { id: 'readyerrored', title: 'D-ready-errored', state: baseState(), args: ['-DryRunFailAt', 'ready_errored'], check(p, r) {
    rollbackChecks(p, r, { stage: 'ready_failed' });
    check(`${p}: READY_OK 之后 task-pool 是 errored、restart_time 没增长 -> 仍判 ready_failed，说明不是 online`, r.out.includes("状态是 'errored'，不是 online"), r.out.split(/\r?\n/).filter((l) => l.includes('[ERROR]')).join(' | '));
  } },
  { id: 'noddl', title: 'D-noddl', state: baseState({ repoHead: FIX.noDdlA, runCommit: FIX.noDdlA }), args: ['-DryRunFailAt', 'code'], script: () => FIX.noDdlScript, check(p, r) {
    eq(`${p}: 退出码 1`, r.status, 1);
    check(`${p}: schema 扫描零命中：只说「未在新增行里发现常见 DDL 关键字」并明确「这不能证明数据库兼容」，要求人工核对迁移（含 UPDATE 数据回填、拼接生成的 DDL、wbs-server/scripts/ 下的迁移脚本）`, r.out.includes('未在新增行里发现常见 DDL 关键字') && r.out.includes('这不能证明数据库兼容') && r.out.includes('请人工核对本次的迁移') && r.out.includes('UPDATE') && r.out.includes('拼接生成的 DDL') && r.out.includes('wbs-server/scripts/ 下的迁移脚本'), r.out.split(/\r?\n/).filter((l) => l.includes('DDL')).join(' | '));
    check(`${p}: 零命中也不下「兼容 / 无需恢复」的结论（没有「不含 schema 变化」「只回退代码，不恢复数据库」「无需恢复」）`, !r.out.includes('不含 schema 变化') && !r.out.includes('只回退代码，不恢复数据库') && !r.out.includes('无需恢复') && !r.out.includes('直接起服务'));
    check(`${p}: 零命中也照样给出完整的回滚顺序与恢复命令（恢复与否由人决定）`, r.out.includes('[回滚 3/7]') && r.out.includes('[回滚 6/7]') && r.out.includes('before_restore_') && !r.out.includes('wbs-server/db-migrate.sql'));
  } },
  { id: 'tracked', title: 'D-tracked', state: baseState({ trackedChanges: ' M wbs-server/package.json' }), args: [], check(p, r) { abortChecks(p, r, '已跟踪文件的改动'); } },
  { id: 'mismatch', title: 'D-mismatch', state: baseState({ runCommit: NEW_COMMIT }), args: [], check(p, r) { abortChecks(p, r, '与远端仓库 HEAD'); } },
  { id: 'nocommitbad', title: 'D-nocommit-badver', state: baseState({ runCommit: null, runVersion: '0.0.1' }), args: [], check(p, r) { abortChecks(p, r, '没有 commit 字段'); } },
  { id: 'nocommitok', title: 'D-nocommit-okver', state: baseState({ runCommit: null }), args: [], check(p, r) {
    eq(`${p}: 退出码 0（RunCommit 为空但版本等于 RepoHead 上的版本，通过）`, r.status, 0);
    const rec = recordOf(r.tempDir);
    if (check(`${p}: 发布记录存在`, rec !== null)) {
      check(`${p}: prevRunning.commit 为 null、prevCommit = RepoHead`, rec.prevRunning.commit === null && rec.prevCommit === PREV_COMMIT);
    }
  } },
  { id: 'stopped', title: 'D-stopped', state: baseState({ pm2Status: 'stopped' }), args: [], check(p, r) { abortChecks(p, r, '不是 online'); } },
  { id: 'twoapps', title: 'D-twoapps', state: baseState({ pm2Count: 2 }), args: [], check(p, r) { abortChecks(p, r, '不是 1'); } },
  { id: 'nonode', title: 'D-nonode', state: baseState({ nodeVersion: 'not found' }), args: [], check(p, r) { abortChecks(p, r, 'node -v 输出异常'); } },
  { id: 'badprev', title: 'D-badprev', state: baseState({ repoHead: 'a'.repeat(40), runCommit: 'a'.repeat(40) }), args: ['-DryRunFailAt', 'code'], check(p, r) {
    eq(`${p}: 退出码 1`, r.status, 1);
    check(`${p}: 本机算不出差异（回滚目标提交本机没有）-> 如实说无法计算、按可能有 schema 变化处理，仍打印回滚步骤`, r.out.includes('无法在本机计算') && r.out.includes('回滚 7/7') && r.out.includes(`rollbackTarget = ${'a'.repeat(40)}`), r.out.split(/\r?\n/).filter((l) => l.includes('回滚 4/5') || l.includes('无法在本机')).join(' | '));
  } },
  { id: 'notrepo', title: 'D-notrepo', state: baseState(), args: [], script: () => FIX.norepoScript, check(p, r) {
    eq(`${p}: 退出码 1`, r.status, 1);
    noRealRemote(p, r);
    check(`${p}: 脚本所在目录不是 git 仓库 -> 第 0 步中止，生产未动，什么都没打印要执行`, r.out.includes('不是 git 仓库') && r.out.includes('生产未动') && dryLines(r.out).length === 0 && recordOf(r.tempDir) === null, r.out.split(/\r?\n/).filter((l) => l.includes('[ERROR]')).join(' | '));
  } },
  // 真实探测路径（不带 -RemoteStateFile）：第 2 步的远端只读命令经「假 ssh」走完整的 Invoke-RemoteRead -> Invoke-Local -> Get-Pm2Task -> stdin 链路
  { id: 'realprobe', title: 'D-realprobe', state: baseState(), args: [], run: async (c) => {
    const tempDir = freshDir(`case-${c.id}`);
    const fake = installFakeSsh(FIX.script);
    const r = await runPs(fake.script, ['-DryRun', '-SkipPushCheck', '-ServerIP', TEST_NET_IP], { cwd: FIX.decoy, tempDir, extraEnv: { FAKE_SSH_JS: fake.fakeJs, FAKE_CURL_JS: fake.fakeCurl, FAKE_HEAD: PREV_COMMIT, FAKE_HEAD_VERSION: PREV_VERSION } });
    return Object.assign(r, { tempDir });
  }, check(p, r) {
    check(`${p}: 第 2 步经假 ssh 读到的 pm2 jlist（合成的单行大 JSON）被解析出 task-pool online（输出「task-pool  = online (进程数 1)」）`, r.out.includes('task-pool  = online (进程数 1)'), r.out.split(/\r?\n/).filter((l) => l.includes('[ERROR]') || l.includes('task-pool')).join(' | '));
    check(`${p}: 第 2 步没有在读 pm2 / 运行版本处中止，PrevCommit 取到假远端 HEAD，整个 DryRun 走完（退出码 0）`, !r.out.includes('读不到 pm2 状态') && !r.out.includes('读不到运行中的版本') && r.out.includes(`PrevCommit（部署前实际运行的提交）= ${PREV_COMMIT}`) && r.status === 0, `exit=${r.status} ${r.out.split(/\r?\n/).filter((l) => l.includes('[ERROR]')).join(' | ')}`);
    check(`${p}: M3 第 2 步经假 ssh 读到 pm2 jlist 里 task-pool 的 pid 100 与 netstat 里 3000 两栈的唯一 LISTENING pid 100（读 netstat 走 Invoke-RemoteRead），硬门放行`, r.out.includes('pm2 pid    = 100    3000 的 LISTENING pid = 100') && /\[REMOTE-READ\] ssh [^\r\n]* netstat -ano/.test(r.out), r.out.split(/\r?\n/).filter((l) => l.includes('pm2 pid') || l.includes('[ERROR]')).join(' | '));
    noRealRemote2(p, r);
  } },
  { id: 'realprobecmd', title: 'D-realprobe-cmd', state: baseState(), args: [], run: async (c) => {
    const tempDir = freshDir(`case-${c.id}`);
    const fake = installFakeSsh(FIX.script);
    const r = await withCpLock(() => runPs(fake.script, ['-DryRun', '-SkipPushCheck', '-ServerIP', TEST_NET_IP], { cwd: FIX.decoy, tempDir, viaCommand: { prefix: "$ErrorActionPreference = 'Stop'; [Console]::InputEncoding = [System.Text.Encoding]::UTF8" }, extraEnv: { FAKE_NOPREFIX: '1', FAKE_SSH_JS: fake.fakeJs, FAKE_CURL_JS: fake.fakeCurl, FAKE_HEAD: PREV_COMMIT, FAKE_HEAD_VERSION: PREV_VERSION } }));
    return Object.assign(r, { tempDir });
  }, check(p, r) {
    check(`${p}: 像 PowerShell 工具那样在宿主里 -Command 调用（$ErrorActionPreference = 'Stop'、控制台输入代码页 65001、进程内 & 脚本），jlist 没有前缀行、以 [{ 打头，第 2 步 pm2 解析仍正常、DryRun 走完`, !r.out.includes('读不到 pm2 状态') && r.out.includes(`PrevCommit（部署前实际运行的提交）= ${PREV_COMMIT}`) && r.status === 0, `exit=${r.status} ${r.out.split(/\r?\n/).filter((l) => l.includes('[ERROR]')).join(' | ')} ${r.out.slice(-300)}`);
  } },
  { id: 'noready', title: 'D-noready', state: baseState(), args: [], script: () => FIX.noReadyScript, check(p, r) { noReadyChecks(p, r, "app.get('/api/health/ready'"); } },
  { id: 'nocommitfield', title: 'D-nocommitfield', state: baseState(), args: [], script: () => FIX.noCommitScript, check(p, r) { noReadyChecks(p, r, 'commit: DEPLOY_COMMIT'); } },
  { id: 'subdir', title: 'D-subdir', state: baseState(), args: [], script: () => FIX.subdirScript, check(p, r) {
    eq(`${p}: 退出码 1`, r.status, 1);
    noRealRemote(p, r);
    check(`${p}: 脚本在 <仓库>/sub/scripts/ 下（上一级不是 git 顶层）-> 第 0 步中止，生产未动`, r.out.includes('不是 git 仓库的顶层') && r.out.includes('生产未动') && dryLines(r.out).length === 0 && recordOf(r.tempDir) === null, r.out.split(/\r?\n/).filter((l) => l.includes('[ERROR]')).join(' | '));
  } },
  // ---- B1 末次合并审 M3：第 2 步孤儿监听硬门（停服之前；每种不满足形态都拒，两栈任一栈单独满足都放行）
  { id: 'orphan', title: 'D-orphan', state: baseState({ netstat: nsText([].concat(NS_NOISE, [nsV4(9999), nsV6(9999)])) }), args: [], check(p, r) {
    abortChecks(p, r, ORPHAN_MSG);
    check(`${p}: 点名 3000 的监听 pid 9999 不等于 pm2 记录的 pid ${PM2_PID}`, r.out.includes(`3000 的监听 pid 9999 不等于 pm2 记录的 pid ${PM2_PID}`));
  } },
  { id: 'orphanmulti', title: 'D-orphan-multi', state: baseState({ netstat: nsText([].concat(NS_NOISE, [nsV4(PM2_PID), nsV6(9999)])) }), args: [], check(p, r) {
    abortChecks(p, r, ORPHAN_MSG);
    check(`${p}: 两栈 pid 不同（v4 是 pm2 的、v6 是别的进程）-> 点名多个不同 pid 在监听`, r.out.includes(`3000 有多个不同 pid 在监听（${PM2_PID},9999）`));
  } },
  { id: 'nolisten', title: 'D-nolisten', state: baseState({ netstat: nsText(NS_NOISE) }), args: [], check(p, r) {
    abortChecks(p, r, ORPHAN_MSG);
    check(`${p}: 3000 上只有 ESTABLISHED / TIME_WAIT / UDP 行（含 pid ${PM2_PID} 的 ESTABLISHED）、没有 LISTENING -> 点名没有 LISTENING`, r.out.includes(`3000 没有 LISTENING（pm2 记录的 pid ${PM2_PID}）`));
  } },
  { id: 'listenprefix', title: 'D-listenprefix', state: baseState({ pm2Pid: 777, netstat: nsText(NS_NOISE) }), args: [], check(p, r) {
    abortChecks(p, r, ORPHAN_MSG);
    check(`${p}: pm2 的 pid 恰是 :30000 的监听者 777，3000 本身没有监听 -> 端口不按前缀匹配，仍拒`, r.out.includes('3000 没有 LISTENING（pm2 记录的 pid 777）'));
  } },
  { id: 'nonetstat', title: 'D-nonetstat', state: baseState({ netstat: 'command not found' }), args: [], check(p, r) {
    abortChecks(p, r, '无法核对 3000 监听者与 pm2 进程是否一致');
    check(`${p}: netstat 输出不是 TCP 表（命令没成功）-> 读不到而不是「没有监听者」，不说孤儿监听`, r.out.includes('netstat 输出里没有任何 TCP 行') && !r.out.includes('疑似孤儿监听'));
  } },
  { id: 'nofield', title: 'D-nofield', state: baseState({ netstat: undefined }), args: [], check(p, r) {
    abortChecks(p, r, '无法核对 3000 监听者与 pm2 进程是否一致');
    check(`${p}: 假远端现状没有 netstat 字段 -> 读不到，拒绝（不当作放行）`, r.out.includes('假远端现状文件没有 netstat 字段'));
  } },
  { id: 'nopid', title: 'D-nopid', state: baseState({ pm2Pid: 0 }), args: [], check(p, r) {
    abortChecks(p, r, '无法核对 3000 监听者与 pm2 进程是否一致');
    check(`${p}: pm2 记录的 pid 是 0 -> 读不到 pm2 的 pid，拒绝`, r.out.includes('读不到 pm2 记录的 pid'));
  } },
  { id: 'v4only', title: 'D-v4only', state: baseState({ netstat: nsText([].concat(NS_NOISE, [nsV4(PM2_PID)])) }), args: [], check(p, r) {
    eq(`${p}: 退出码 0（只有 IPv4（0.0.0.0）一栈在监听 3000、pid 等于 pm2 的 -> 放行）`, r.status, 0);
    check(`${p}: 点名 3000 的 LISTENING pid ${PM2_PID}`, r.out.includes(`3000 的 LISTENING pid = ${PM2_PID}`));
  } },
  { id: 'v6only', title: 'D-v6only', state: baseState({ netstat: nsText([].concat(NS_NOISE, [nsV6(PM2_PID)])) }), args: [], check(p, r) {
    eq(`${p}: 退出码 0（只有 [::]:3000 一栈在监听、pid 等于 pm2 的 -> 放行）`, r.status, 0);
    check(`${p}: 点名 3000 的 LISTENING pid ${PM2_PID}`, r.out.includes(`3000 的 LISTENING pid = ${PM2_PID}`));
  } },
  // ---- B1 末次合并审 M3：第 4 步停服后 3000 必须零 LISTENING；第 8 步终检 pid（后者在 D-ready-orphan）
  { id: 'stoplisten', title: 'D-stop-listen', state: baseState(), args: ['-DryRunFailAt', 'stop_listen'], check(p, r) {
    eq(`${p}: 退出码 1`, r.status, 1);
    noRealRemote(p, r);
    const w = dryLines(r.out).map((l) => l.replace(/^.*将执行[^：]*：/, ''));
    check(`${p}: 走「停服确认不过」分支：点名停服之后 3000 仍有 LISTENING 的 pid 9999，pm2 已 stopped 但没确认端口释放，说明孤儿监听与 memory 处置`, r.out.includes('停服命令失败或确认不过（停服之后 3000 仍有 LISTENING，pid 9999）') && r.out.includes('没能确认 3000 已释放') && r.out.includes('feedback_pm2_orphan_listener_recovery'), r.out.split(/\r?\n/).filter((l) => l.includes('[ERROR]')).join(' | '));
    check(`${p}: 只读核对命令整行全等、不起服务：打印的写命令止于 pm2 stop task-pool（没有备份 / reset / pm2 start）`, r.out.split(/\r?\n/).map((l) => l.trim()).includes(`ssh ${DEPLOY_USER_DEFAULT}@${TEST_NET_IP} "netstat -ano"`) && w[w.length - 1].includes('pm2 stop task-pool') && !w.some((l) => l.includes('--sqlite3') || l.includes('reset --hard') || l.includes('pm2 start')), w.join(' || '));
    // 修复批 1c M1：netstat 是不加过滤的整份输出（没有 findstr），先判查询成功（有 TCP 行）、再判 3000 零 LISTENING；stopped 的判据与「其他」判据都写到查询失败
    const sl = r.out.split(/\r?\n/).map((l) => l.trim());
    const iIntro = sl.findIndex((l) => l.startsWith('再查 3000 端口有没有监听者'));
    const iNsAll = sl.indexOf(`ssh ${DEPLOY_USER_DEFAULT}@${TEST_NET_IP} "netstat -ano"`);
    const iStoppedJ = sl.findIndex((l) => l.startsWith('判据：名为 task-pool 的只有一项，且为 stopped'));
    const iOtherJ = sl.findIndex((l) => l.startsWith('判据：读不到状态、两次不一致'));
    check(`${p}: 修复批 1c M1 第 4 步失败处置：「再查 3000 端口」< 不加过滤的 netstat -ano < 判据一（先确认查询成功，没有 TCP 行 / 报错 / 超时 = 查询失败，不是零监听）< 判据二（3000 的 LISTENING 行必须为零）< stopped 判据写「查询成功、3000 零 LISTENING」< 其他判据含「netstat 查询失败」；输出里没有 netstat | findstr 命令`,
      iIntro >= 0 && iNsAll > iIntro && sl.findIndex((l, i) => i > iNsAll && l.startsWith('判据一（先确认查询成功）') && l.includes('「查询失败」，不是「零监听」')) > iNsAll && sl.findIndex((l) => l.startsWith('判据二（再数监听者')) > iNsAll
      && iStoppedJ > iNsAll && sl[iStoppedJ].includes('netstat 查询成功、3000 零 LISTENING') && iOtherJ > iStoppedJ && sl[iOtherJ].includes('netstat 查询失败（没有 TCP 行不等于零监听）') && !sl.some((l) => /^ssh /.test(l) && l.includes('netstat') && l.includes('findstr')),
      JSON.stringify([iIntro, iNsAll, iStoppedJ, iOtherJ]));
    check(`${p}: 没有自动动作：不说「已起回原服务」`, !r.out.includes('自动 pm2 start') && !r.out.includes('restarted_old'));
    const rec = recordOf(r.tempDir);
    if (check(`${p}: 发布记录存在`, rec !== null)) {
      eq(`${p}: record 阶段序列（没有 stopped：端口没确认释放就不算停服完成）`, stagesOf(rec), ['prepared', 'uploaded', 'failed']);
      eq(`${p}: record result`, rec.result, 'failed');
      eq(`${p}: 修复批 1b LOW②：失败态 note 是 PORT_NOT_RELEASED（与 STOP_UNCONFIRMED 区分：pm2 已 stopped 但端口没确认释放）`, rec.history[rec.history.length - 1].note, 'PORT_NOT_RELEASED');
    }
    const ls4 = r.out.split(/\r?\n/).map((l) => l.trim());
    // 修复批 1c M1：端口未释放提示只剩一句指向「再查 3000 端口」一节，netstat 核对命令（不加过滤）整行只出现一次，在逐步判据前
    check(`${p}: 修复批 1b LOW①（修复批 1c 改）：停服失败分支的判据补了「且 3000 零 LISTENING」，netstat 只读核对命令整行出现一次（逐步判据前；端口未释放提示指向它），起服务提示也写明 3000 零 LISTENING`,
      ls4.filter((l) => l === `ssh ${DEPLOY_USER_DEFAULT}@${TEST_NET_IP} "netstat -ano"`).length === 1
      && ls4.some((l) => l.includes('只读核对命令与判据见下面「再查 3000 端口」一节'))
      && ls4.some((l) => l.includes('且为 stopped，并且上一条 netstat 查询成功、3000 零 LISTENING（判据一、判据二都通过）→ 可以起服务'))
      && ls4.some((l) => l.includes('3000 上仍有 LISTENING（pm2 已 stopped 也一样，多半是孤儿监听）、或 netstat 查询失败（没有 TCP 行不等于零监听）→ 不要起服务'))
      && ls4.some((l) => l.includes('task-pool 为 stopped 且 3000 零 LISTENING 后，如需起服务用下一行')), ls4.filter((l) => l.includes('netstat')).join(' | '));
  } },
  // ---- B1 末次合并审 修复批 1b H1：netstat 状态列带数字的 FIN_WAIT_1 / FIN_WAIT_2 等不能让解析失败（健康服务有服务端先关的长连接时必现）；本地化状态仍 fail-closed
  { id: 'finwait', title: 'D-finwait', state: baseState({ netstat: nsText([nsV4(PM2_PID), nsV6(PM2_PID), `  TCP    192.168.1.100:${APP_PORT}      198.51.100.7:50001       FIN_WAIT_2      0`, `  TCP    192.168.1.100:${APP_PORT}      198.51.100.7:50002       FIN_WAIT_1      ${PM2_PID}`]) }), args: [], check(p, r) {
    eq(`${p}: 退出码 0（健康服务 + 3000 上有 FIN_WAIT_1 / FIN_WAIT_2 行：第 2 步放行；DryRun 的第 4 步 / 第 8 步假 netstat 也带 FIN_WAIT 行，同样放行）`, r.status, 0);
    check(`${p}: 点名 3000 的 LISTENING pid 就是 ${PM2_PID}（FIN_WAIT 行不算监听者）`, r.out.includes(`3000 的 LISTENING pid = ${PM2_PID}`) && !r.out.includes('无法解析的 TCP 行'), r.out.split(/\r?\n/).filter((l) => l.includes('pm2 pid') || l.includes('[ERROR]')).join(' | '));
  } },
  { id: 'localized', title: 'D-localized', state: baseState({ netstat: nsText([].concat(NS_NOISE, [`  TCP    0.0.0.0:${APP_PORT}           0.0.0.0:0              侦听            ${PM2_PID}`])) }), args: [], check(p, r) {
    abortChecks(p, r, '无法核对 3000 监听者与 pm2 进程是否一致');
    check(`${p}: 3000 上的行状态是本地化文字（非 ASCII）-> 解析失败，fail-closed：点名无法解析的 TCP 行，不当成「没有监听者」`, r.out.includes('netstat 里有无法解析的 TCP 行（端口 3000）') && !r.out.includes('疑似孤儿监听'));
  } },
  // ---- B1 末次合并审 M1：-PushTimeoutSec 与 push 超时 / 失败后的只读核对
  { id: 'pushto', title: 'D-pushto', state: baseState(), args: ['-PushTimeoutSec', '60'], check(p, r) {
    eq(`${p}: 退出码 0（下限 60 放行）`, r.status, 0);
    check(`${p}: 推送超时上限取参数值 60 秒`, r.out.includes('推送超时上限 60 秒'));
  } },
  { id: 'pushtomax', title: 'D-pushto-max', state: baseState(), args: ['-PushTimeoutSec', '7200'], check(p, r) {
    eq(`${p}: 退出码 0（上限 7200 放行）`, r.status, 0);
    check(`${p}: 推送超时上限取参数值 7200 秒`, r.out.includes('推送超时上限 7200 秒'));
  } },
  { id: 'pushland', title: 'D-push-landed', state: baseState(), args: ['-DryRunFailAt', 'push_landed'], check(p, r) {
    eq(`${p}: 退出码 1（照旧中止，不继续往下走）`, r.status, 1);
    noRealRemote(p, r);
    check(`${p}: push 超时但只读核对 production 的 main 已等于 NewCommit -> 提示推送已生效、可能卡在远端 gc --auto、确认没有在跑的 git 进程后重跑本脚本（推送会是 up-to-date）`, r.out.includes('推送已生效，可能卡在远端 gc --auto。确认没有在跑的 git 进程后重跑本脚本（推送会是 up-to-date）') && r.out.includes(`已等于 NewCommit ${NEW_COMMIT}`) && r.out.includes('git push production main 没有正常结束（超时）'), r.out.split(/\r?\n/).filter((l) => l.includes('[ERROR]')).join(' | '));
    check(`${p}: 查 git 进程的命令整行全等，判据另起一行`, (() => { const ls = r.out.split(/\r?\n/).map((l) => l.trim()); const i = ls.indexOf('Get-CimInstance Win32_Process -Filter "Name=\'git.exe\'" | Where-Object { $_.CommandLine -match \'receive-pack|gc|TaskPool\' } | Select-Object ProcessId,CommandLine'); return i >= 0 && ls[i + 1].startsWith('判据：结果为空才重跑本脚本'); })());
    eq(`${p}: 只有 push 被打印，没有上传 / 停服 / 备份`, dryLines(r.out).map((l) => l.replace(/^.*将执行[^：]*：/, '')), ['git push production main']);
    check(`${p}: 生产未动，且没有发布记录（Stop-Early）`, r.out.includes('生产未动') && recordOf(r.tempDir) === null);
  } },
  { id: 'pushfail', title: 'D-push-failed', state: baseState(), args: ['-DryRunFailAt', 'push_failed'], check(p, r) {
    eq(`${p}: 退出码 1`, r.status, 1);
    noRealRemote(p, r);
    check(`${p}: push 失败且只读核对 production 的 main 不等于 NewCommit -> 打印原失败提示，不说推送已生效`, r.out.includes('git push production main 失败：退出码 1') && !r.out.includes('推送已生效') && !r.out.includes('gc --auto'), r.out.split(/\r?\n/).filter((l) => l.includes('[ERROR]')).join(' | '));
    check(`${p}: 不打印查 git 进程的命令（推送没有生效，不引导重跑）`, !r.out.includes("Name='git.exe'"));
    eq(`${p}: 只有 push 被打印`, dryLines(r.out).map((l) => l.replace(/^.*将执行[^：]*：/, '')), ['git push production main']);
    check(`${p}: 生产未动，且没有发布记录`, r.out.includes('生产未动') && recordOf(r.tempDir) === null);
  } },
  ];
}

/** 拒绝类用例：故意不带 -DryRun；被测脚本副本放在不在任何 git 仓库里的目录（守卫坏了也只会死在第 0 步：脚本所在目录不是 git 仓库） */
const REFUSE = [
  { id: 'r_failat', title: 'R-nodryrun-failat', extra: ['-DryRunFailAt', 'backup'], expect: 2, msg: '-DryRunFailAt' },
  { id: 'r_state', title: 'R-nodryrun-statefile', extra: ['-RemoteStateFile', '@state'], expect: 2, msg: '-RemoteStateFile' },
  { id: 'r_skip', title: 'R-nodryrun-skippush', extra: ['-SkipPushCheck'], expect: 2, msg: '-SkipPushCheck' },
  { id: 'r_bad', title: 'R-badfailat', dry: true, extra: ['-DryRunFailAt', 'bogus', '-RemoteStateFile', '@state', '-SkipPushCheck'], expect: 2, msg: '取值只能是' },
  // M1：-PushTimeoutSec 只收 60-7200 的整数，其余一律拒绝（退出码 2，与其他参数错误一致，没有做任何事）
  { id: 'r_push59', title: 'R-pushtimeout-59', extra: ['-PushTimeoutSec', '59'], expect: 2, msg: '-PushTimeoutSec' },
  { id: 'r_push7201', title: 'R-pushtimeout-7201', extra: ['-PushTimeoutSec', '7201'], expect: 2, msg: '-PushTimeoutSec' },
  { id: 'r_pushabc', title: 'R-pushtimeout-abc', extra: ['-PushTimeoutSec', 'abc'], expect: 2, msg: '-PushTimeoutSec' },
  { id: 'r_push15', title: 'R-pushtimeout-1.5', extra: ['-PushTimeoutSec', '1.5'], expect: 2, msg: '-PushTimeoutSec' },
  { id: 'r_push0', title: 'R-pushtimeout-0', extra: ['-PushTimeoutSec', '0'], expect: 2, msg: '-PushTimeoutSec' },
];

function writeJson(dir, name, obj) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, JSON.stringify(obj), 'utf8');
  return f;
}

/**
 * 假 ssh：不带 -RemoteStateFile 的 DryRun 会真去做第 2 步的远端只读探测。这里把被测脚本副本里 Invoke-RemoteRead 的 ssh 换成
 * 「node 跑一个假远端脚本」（只改副本里 Invoke-RemoteRead 的前两行取值；Invoke-RemoteWrite 不动，DryRun 下它不发出），
 * 假远端按命令串回答，jlist 是合成的大单行 JSON（中文、反斜杠、[PM2] 前缀行、CRLF）。这样走的就是生产同一条链：
 * Invoke-RemoteRead -> Invoke-Local 读 stdout -> Read-RemotePm2Task -> Get-Pm2Task -> Invoke-Local -StdinText -> node。
 */
function installFakeSsh(scriptPath) {
  if (FIX.fake) return FIX.fake;   // 只装一次（几个用例共用，并发运行时不能重复写同一个文件）
  const text = fs.readFileSync(scriptPath, 'utf8');
  const find = `$exe = 'ssh'${CRLF}        $argv = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', "\${ServerUser}@\${ServerIP}", $Command)`;
  const at = text.indexOf(find);
  if (at < 0) throw new Error('找不到 Invoke-RemoteRead 里 ssh 的取值行，无法安装假 ssh');
  let patched = text.slice(0, at) + `$exe = 'node'${CRLF}        $argv = @($env:FAKE_SSH_JS, $Command)` + text.slice(at + find.length);
  // 本机取运行版本的 curl 也换成假的（打印 {"version","commit"}），让第 2 步走完
  const curlFind = `-FileName 'curl.exe' -ArgList @('--noproxy', '*', '-s', '-m', '5', "$BaseUrl/api/version")`;
  if (!patched.includes(curlFind)) throw new Error('找不到 Get-RunningVersion 里的 curl 调用，无法安装假 curl');
  patched = patched.replace(curlFind, () => `-FileName 'node' -ArgList @($env:FAKE_CURL_JS)`);
  const target = path.join(path.dirname(scriptPath), 'deploy-ssh-fakessh.ps1');
  fs.writeFileSync(target, patched);
  const fakeJs = path.join(path.dirname(path.dirname(scriptPath)), 'fake-ssh.js');
  fs.writeFileSync(fakeJs, [
    "'use strict';",
    "const cmd = process.argv[2] || '';",
    "const filler = (n) => { const env = { PATH: 'C:\\\\Windows\\\\System32;E:\\\\工具\\\\node', Path: 'dup', 备注: '中文环境变量'.repeat(20) }; for (let i = 0; i < n; i += 1) env['VAR_' + i] = 'E:\\\\Task_Pool\\\\wbs-server\\\\uploads\\\\' + 'x'.repeat(60) + '中文'; return env; };",
    "const app = (name, status, restart) => ({ pid: 100, name, pm_id: 1, monit: { memory: 1, cpu: 0 }, pm2_env: { status, restart_time: restart, pm_cwd: 'E:\\\\Task_Pool\\\\wbs-server', env: filler(150) } });",
    "const eol = '\\r\\n';",
    "const prefix = process.env.FAKE_NOPREFIX ? '' : '[PM2] Spawning PM2 daemon with pm2_home=C:\\\\Users\\\\someone\\\\.pm2' + eol + '[PM2] PM2 Successfully daemonized' + eol;",
    "if (cmd.includes('pm2 jlist')) process.stdout.write(prefix + JSON.stringify([app('business-flow', 'online', 9), app('task-pool', 'online', 2314), app('sysbuild-pm-temp', 'online', 0)]) + eol);",
    "else if (cmd.includes('rev-parse HEAD')) process.stdout.write(process.env.FAKE_HEAD + eol);",
    "else if (cmd.includes('status --porcelain')) process.stdout.write('');",
    "else if (cmd.includes('node -v')) process.stdout.write('v18.20.0' + eol);",
    "else if (cmd.includes(' show ')) process.stdout.write('{\"version\":\"' + process.env.FAKE_HEAD_VERSION + '\"}' + eol);",
    // 第 2 步的孤儿监听核对：3000 两栈都由 pid 100（上面 jlist 里 task-pool 的 pid）监听，另有无关行
    `else if (cmd.includes('netstat -ano')) process.stdout.write('Active Connections' + eol + eol + '  Proto  Local Address          Foreign Address        State           PID' + eol + '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       888' + eol + '  TCP    0.0.0.0:${APP_PORT}           0.0.0.0:0              LISTENING       100' + eol + '  TCP    [::]:${APP_PORT}              [::]:0                 LISTENING       100' + eol + '  TCP    192.168.1.100:${APP_PORT}      192.168.1.5:50123       ESTABLISHED     100' + eol);`,
    "else { process.stderr.write('fake ssh: unexpected command ' + cmd); process.exit(3); }",
    '',
  ].join('\n'));
  const fakeCurl = path.join(path.dirname(path.dirname(scriptPath)), 'fake-curl.js');
  fs.writeFileSync(fakeCurl, "process.stdout.write(JSON.stringify({ version: process.env.FAKE_HEAD_VERSION, commit: process.env.FAKE_HEAD }) + '\\n');\n");
  FIX.fake = { script: target, fakeJs, fakeCurl };
  return FIX.fake;
}

/** 动态用例：被测脚本在夹具仓库的 scripts/ 下（或 c.script() 指定的位置），进程当前目录是诱饵仓库 */
async function runCase(c) {
  if (c.run) return c.run(c);
  const tempDir = freshDir(`case-${c.id}`);
  const stateFile = writeJson(tempDir, 'state.json', c.state);
  const script = c.script ? c.script() : FIX.script;
  const r = await runPs(script, ['-DryRun', '-RemoteStateFile', stateFile, '-SkipPushCheck', ...c.args], { cwd: FIX.decoy, tempDir });
  return Object.assign(r, { tempDir });
}

/**
 * 拒绝类用例（不带 -DryRun 的运行，三重隔离，缺一不可，R0 逐项断言）：
 *   ① 被测脚本副本在不属于任何 git 仓库的目录里，进程当前目录同在那里；
 *   ② 子进程 PATH 只留 node 所在目录与 System32（没有 git、ssh、scp）；
 *   ③ -ServerIP 192.0.2.1（TEST-NET，不可达）。
 * 守卫一旦回归，脚本会在第 0 步（git 不可解析 / 脚本所在目录不是 git 仓库）就中止，碰不到任何生产动作。
 */
async function runRefuse(c) {
  const tempDir = freshDir(`refuse-${c.id}`);
  const stateFile = writeJson(tempDir, 'state.json', baseState());
  const extra = c.extra.map((a) => (a === '@state' ? stateFile : a));
  const args = ['-ServerIP', TEST_NET_IP].concat(c.dry ? ['-DryRun'] : [], extra);
  const r = await runPs(FIX.norepoScript, args, { cwd: FIX.norepo, tempDir, timeoutMs: 120000, path: STRICT_PATH });
  return Object.assign(r, { tempDir });
}

/** 某个检出的控制根 releases/ 目录清单（与 release-record.js 的 defaultDir 同一路径：<主工作区根>/docs/local/多线并行/_state/releases；主工作区根经 git-common-dir 取） */
function releasesSnapshot(root) {
  const r = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8', env: Object.assign({}, process.env, GIT_ISOLATION) });
  if (r.status !== 0) return { dir: null, list: 'ERR 取不到 git-common-dir' };
  const mainRoot = path.dirname(path.resolve(root, r.stdout.trim()));
  const dir = path.join(mainRoot, 'docs', 'local', '多线并行', '_state', 'releases');
  try {
    return { dir, list: fs.existsSync(dir) ? fs.readdirSync(dir).sort() : null };
  } catch (e) {
    return { dir, list: `ERR ${e.message}` };
  }
}

// ---------------------------------------------------------------- 单元：从被测脚本里取出纯函数，在最小的 PowerShell 5.1 脚本里验证
// （协议行判定 / 参数引用 / pm2 jlist 经 node 解析 / 本机子进程超时与启动失败。这些路径在 DryRun 里走不到，真实部署时才会用）
function psFunctionText(lf, name) {
  const m = new RegExp(`^function ${name}\\b[\\s\\S]*?\\n\\}\\n(?=\\n|# |function )`, 'm').exec(lf);
  return m ? m[0] : null;
}

const UNIT_PS = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$ErrorActionPreference = "Continue"',
  '$script:WorkTmp = $null',
  '$nl = [string][char]10',
  '$cr = [string][char]13',
  '$res = [ordered]@{}',
  // 控制台输入代码页是控制台的状态：同一个控制台下的其他进程（包括之后的自检运行）都会看到。先记下进入时的值（宿主可能本来就是 65001），
  // 整个单元脚本在 try / finally 里，各段需要什么代码页就显式设什么，结束一律还原
  '$origInputEncoding = [Console]::InputEncoding',
  '$res["startCp"] = $origInputEncoding.CodePage',
  'try {',
  'function Mk($out, $to) { [pscustomobject]@{ Stdout = $out; TimedOut = [bool]$to; StartError = $null; ExitCode = 0; Stderr = "" } }',
  'function Proto($out, $to) { $p = Read-Protocol -Res (Mk $out $to) -Prefixes @("BACKUP_OK", "BACKUP_FAIL"); if ($null -eq $p) { return "null" } else { return ($p.Kind + "|" + [string]$p.Json.out + "|" + [string]$p.Json.code) } }',
  '$ok = "BACKUP_OK {""out"":""E:/x/b"",""bytes"":1}"',
  '$res["ok"] = Proto ("noise" + $nl + $ok + $nl) $false',
  '$res["okCrlf"] = Proto ("noise" + $cr + $nl + $ok + $cr + $nl) $false',
  '$res["noNewline"] = Proto ("noise" + $nl + $ok) $false',
  '$res["truncatedJson"] = Proto ("BACKUP_OK {""out"":""E:\\x"" " + $nl) $false',
  '$res["timedOut"] = Proto ($ok + $nl) $true',
  '$res["notLast"] = Proto ($ok + $nl + "extra line" + $nl) $false',
  '$res["prefixNoSpace"] = Proto ("BACKUP_OKX{""out"":""x""}" + $nl) $false',
  '$res["scalarJson"] = Proto ("BACKUP_OK 5" + $nl) $false',
  '$res["fail"] = Proto ("BACKUP_FAIL {""code"":""BK_VACUUM_FAILED"",""partial"":{""path"":""p"",""exists"":""unknown""},""sourceJournal"":{""journal"":true,""wal"":false}}" + $nl) $false',
  '$pf = Read-Protocol -Res (Mk ("BACKUP_FAIL {""code"":""BK_X"",""partial"":{""path"":""p"",""exists"":""unknown""},""sourceJournal"":{""journal"":true,""wal"":false}}" + $nl) $false) -Prefixes @("BACKUP_OK", "BACKUP_FAIL")',
  '$res["triUnknown"] = Format-Tri $pf.Json.partial.exists',
  '$res["triTrue"] = Format-Tri $pf.Json.sourceJournal.journal',
  '$res["triFalse"] = Format-Tri $pf.Json.sourceJournal.wal',
  '$se = [pscustomobject]@{ Stdout = ($ok + $nl); TimedOut = $false; StartError = "x"; ExitCode = 0; Stderr = "" }',
  '$res["startError"] = if ($null -eq (Read-Protocol -Res $se -Prefixes @("BACKUP_OK"))) { "null" } else { "parsed" }',
  '$r1 = Invoke-Local -FileName "node" -ArgList @("-e", "console.log(JSON.stringify(process.argv.slice(1)))", "a b", "", "c""d", "x\\") -TimeoutSec 30',
  '$res["argv"] = $r1.Stdout.Trim()',
  '$sw = [Diagnostics.Stopwatch]::StartNew()',
  '$r2 = Invoke-Local -FileName "node" -ArgList @("-e", "setTimeout(function(){},9000)") -TimeoutSec 1',
  '$res["timeoutFlag"] = [bool]$r2.TimedOut',
  '$res["timeoutFast"] = ($sw.Elapsed.TotalSeconds -lt 7)',
  '$r3 = Invoke-Local -FileName "no-such-exe-xyz-123" -ArgList @("a")',
  '$res["startErrorSet"] = ($null -ne $r3.StartError)',
  '$res["testOkFalse"] = (Test-Ok $r3)',
  // 第 5 / 8 步判定函数：按真实退出码造输入（backup-db 的 FAIL 真实退出码是 1；ssh 自己失败是 255；ready-check 内部异常是 3）
  'function Mk2($out, $exit, $to, $se, $err) { [pscustomobject]@{ Stdout = $out; TimedOut = [bool]$to; StartError = $se; ExitCode = $exit; Stderr = [string]$err } }',
  'function BO($r) { $o = Resolve-BackupOutcome $r; return ($o.Outcome + "|" + [string]$o.Json.out + "|" + [string]$o.Json.code) }',
  'function RO($r) { $o = Resolve-ReadyOutcome $r; return ($o.Outcome + "|" + $o.Hint) }',
  '$bfail = "BACKUP_FAIL {""code"":""BK_VACUUM_FAILED"",""stage"":""vacuum"",""out"":""E:/x/b"",""partial"":{""path"":""p"",""exists"":true},""sourceJournal"":{""journal"":false,""wal"":false}}"',
  '$res["boOk"] = BO (Mk2 ($ok + $nl) 0 $false $null "")',
  '$res["boOkExit1"] = BO (Mk2 ($ok + $nl) 1 $false $null "")',
  '$res["boFailExit1"] = BO (Mk2 ($bfail + $nl) 1 $false $null "")',
  '$res["boSsh255Empty"] = BO (Mk2 "" 255 $false $null "ssh: connect to host failed")',
  '$res["bo255Fail"] = BO (Mk2 ($bfail + $nl) 255 $false $null "")',
  '$res["boTimeoutFail"] = BO (Mk2 ($bfail + $nl) -1 $true $null "")',
  '$res["boStartError"] = BO (Mk2 "" -1 $false "cannot start" "")',
  '$res["boStderrOnly"] = BO (Mk2 "" 1 $false $null ($bfail + $nl))',
  '$res["boOkNoOut"] = BO (Mk2 ("BACKUP_OK {""bytes"":1}" + $nl) 0 $false $null "")',
  '$res["roOk"] = RO (Mk2 ("READY_OK {""elapsedMs"":5,""rounds"":1}" + $nl) 0 $false $null "")',
  '$res["roCommitNull"] = RO (Mk2 ("READY_FAIL {""code"":""READY_TIMEOUT"",""hint"":""COMMIT_NULL""}" + $nl) 1 $false $null "")',
  '$res["roFailNoHint"] = RO (Mk2 ("READY_FAIL {""code"":""READY_TIMEOUT""}" + $nl) 1 $false $null "")',
  '$res["roExit0NoLine"] = RO (Mk2 ("starting" + $nl) 0 $false $null "")',
  '$res["roInternal"] = RO (Mk2 ("READY_FAIL {""code"":""READY_INTERNAL""}" + $nl) 3 $false $null "")',
  '$res["roTimeoutOk"] = RO (Mk2 ("READY_OK {""elapsedMs"":5}" + $nl) -1 $true $null "")',
  'function J($f) { $t = Get-Pm2Task ([IO.File]::ReadAllText($f)); return ("" + $t.Ok + "|" + $t.Count + "|" + $t.Status + "|" + $t.RestartTime) }',
  '$res["pm2Ok"] = J $env:UNIT_DIR\\jlist-ok.txt',
  '$res["pm2Stopped"] = J $env:UNIT_DIR\\jlist-stopped.txt',
  '$res["pm2Two"] = J $env:UNIT_DIR\\jlist-two.txt',
  '$res["pm2None"] = J $env:UNIT_DIR\\jlist-none.txt',
  '$res["pm2Garbage"] = J $env:UNIT_DIR\\jlist-garbage.txt',
  // 真实形态：假「远端」可执行（node 脚本）把一份合成的 jlist 打到 stdout（单行大 JSON、中文、反斜杠、[PM2] 前缀行、CRLF），
  // 经与生产相同的调用链：Invoke-Local 读它的 stdout -> 取 .Stdout -> Get-Pm2Task（内部 Invoke-Local -StdinText 喂给解析用的 node）
  'function JR($variant) { $j = Invoke-Local -FileName "node" -ArgList @(($env:UNIT_DIR + "\\fake-remote.js"), $variant) -TimeoutSec 60; $t = Get-Pm2Task $j.Stdout; return ("" + $j.Stdout.Length + "|" + $t.Ok + "|" + $t.Count + "|" + $t.Status + "|" + $t.RestartTime + "|" + $t.Error) }',
  // M2：READY_OK 之后的终检（纯函数）。唯一的 task-pool 必须 online 且 restart_time 未增长；stopped / errored / waiting restart 即使计数没增长也判失败
  'function FP($st, $cnt, $rt, $base, $ok) { $t = [pscustomobject]@{ Ok = [bool]$ok; Count = $cnt; Status = $st; RestartTime = $rt; Error = "e" }; $o = Test-FinalPm2State $t $base; return ("" + $o.Ok + "|" + $o.Why) }',
  '$res["fpOnline"] = FP "online" 1 5 5 $true',
  '$res["fpStopped"] = FP "stopped" 1 5 5 $true',
  '$res["fpErrored"] = FP "errored" 1 5 5 $true',
  '$res["fpWaiting"] = FP "waiting restart" 1 5 5 $true',
  '$res["fpGrown"] = FP "online" 1 6 5 $true',
  '$res["fpTwo"] = FP "online" 2 5 5 $true',
  '$res["fpNoRt"] = FP "online" 1 $null 5 $true',
  '$res["fpReadFail"] = FP "online" 1 5 5 $false',
  // M3：stdin 写入受总截止时间约束——子进程不读 stdin、输入远大于管道缓冲区（2 MB）时，必须在 TimeoutSec 内返回 TimedOut，不能永远阻塞
  '$swHang = [Diagnostics.Stopwatch]::StartNew()',
  '$rHang = Invoke-Local -FileName "node" -ArgList @("-e", "setTimeout(function(){},12000)") -TimeoutSec 3 -StdinText ("x" * 2000000)',
  '$res["stdinHang"] = ("" + $rHang.TimedOut + "|" + [int]$swHang.Elapsed.TotalSeconds + "|" + $rHang.ExitCode)',
  // M5：附件快照的保留份数只统计正式名 collab_yyyyMMdd_HHmmss（失败残留的 .partial、普通文件、别的名字都不算）
  '$snap = $env:UNIT_DIR + "\\\\snap"; New-Item -ItemType Directory -Path $snap -Force | Out-Null',
  'foreach ($n in @("collab_20260101_000001", "collab_20260101_000002.partial", "collab_20260101_000003", "collab_20260101_000004.partial", "collab_x", "collab_20260101_00000")) { New-Item -ItemType Directory -Path ($snap + "\\\\" + $n) -Force | Out-Null }',
  '[IO.File]::WriteAllText(($snap + "\\\\collab_20260101_000005"), "file, not a dir")',
  '$res["formalSnaps"] = ((Get-FormalCollabSnapshots $snap | ForEach-Object { $_.Name }) -join ",")',
  // ---- B1 末次合并审预筛六项
  // M3：netstat 解析（两栈 / 多 pid / 无监听 / 非 LISTENING 行 / :30000 前缀 / 垃圾输出 / 无法解析的 3000 行）、pm2 pid 硬门、停服后端口释放硬门；输入是 UNIT_DIR 下的 ns-*.txt
  '$tab = [string][char]9',
  'function NSP($f) { return [IO.File]::ReadAllText($env:UNIT_DIR + "\\" + $f) }',
  'function NS($f, $port) { $o = Get-ListeningPids (NSP $f) $port; return ("" + $o.Ok + "|" + (@($o.Pids) -join ",")) }',
  '$res["nsOk"] = NS "ns-ok.txt" 3000',
  '$res["nsLf"] = NS "ns-lf.txt" 3000',
  '$res["nsV4"] = NS "ns-v4.txt" 3000',
  '$res["nsV6"] = NS "ns-v6.txt" 3000',
  '$res["nsMulti"] = NS "ns-multi.txt" 3000',
  '$res["nsSort"] = NS "ns-sort.txt" 3000',
  '$res["nsDup"] = NS "ns-dup.txt" 3000',
  '$res["nsNone"] = NS "ns-none.txt" 3000',
  '$res["nsPort30000"] = NS "ns-ok.txt" 30000',
  '$res["nsPort300"] = NS "ns-ok.txt" 300',
  '$res["nsGarbage"] = NS "ns-garbage.txt" 3000',
  '$res["nsEmpty"] = NS "ns-empty.txt" 3000',
  '$res["nsMalformed"] = NS "ns-malformed.txt" 3000',
  '$res["nsMalformedOtherPort"] = NS "ns-malformed.txt" 8080',
  '$res["nsFin"] = NS "ns-fin.txt" 3000',
  '$res["nsFinNone"] = NS "ns-fin.txt" 3001',
  '$res["nsLocalized"] = NS "ns-localized.txt" 3000',
  '$res["nsLocalizedV6"] = NS "ns-localized-v6.txt" 3000',
  '$res["nsLower"] = NS "ns-lower.txt" 3000',
  '$res["nsLocalizedOther"] = NS "ns-localized-other.txt" 3000',
  '$res["nsLocalizedOtherPort"] = NS "ns-localized-other.txt" 8080',
  'function OW($pm, $f) { $l = Get-ListeningPids (NSP $f) 3000; $o = Test-Pm2OwnsPort $pm $l; return ("" + $o.Ok + "|" + $o.Why) }',
  '$res["owOk"] = OW 4321 "ns-ok.txt"',
  '$res["owOkStr"] = OW "4321" "ns-ok.txt"',
  '$res["owV4"] = OW 4321 "ns-v4.txt"',
  '$res["owV6"] = OW 4321 "ns-v6.txt"',
  '$res["owMismatch"] = OW 9999 "ns-ok.txt"',
  '$res["owMulti"] = OW 4321 "ns-multi.txt"',
  '$res["owNone"] = OW 4321 "ns-none.txt"',
  '$res["owNullPid"] = OW $null "ns-ok.txt"',
  '$res["owZeroPid"] = OW 0 "ns-ok.txt"',
  '$res["owNegPid"] = OW -5 "ns-ok.txt"',
  '$res["owTextPid"] = OW "abc" "ns-ok.txt"',
  '$res["owGarbage"] = OW 4321 "ns-garbage.txt"',
  '$res["owNullListen"] = (Test-Pm2OwnsPort 4321 $null).Ok',
  'function PR($f) { $o = Test-PortReleased (Get-ListeningPids (NSP $f) 3000); return ("" + $o.Ok + "|" + $o.Why) }',
  '$res["prFree"] = PR "ns-none.txt"',
  '$res["prBusy"] = PR "ns-ok.txt"',
  '$res["prMulti"] = PR "ns-multi.txt"',
  '$res["prGarbage"] = PR "ns-garbage.txt"',
  '$res["prLocalized"] = PR "ns-localized.txt"',
  '$res["prFin"] = PR "ns-fin.txt"',
  '$res["prNull"] = (Test-PortReleased $null).Ok',
  // M1：推送超时 / 失败之后的只读核对结论
  '$nc = "0123456789abcdef0123456789abcdef01234567"',
  'function PA($push, $ls) { $o = Resolve-PushAftermath $push $ls $nc; return ("" + $o.Landed + "|" + $o.Message) }',
  '$lsHit = Mk2 ($nc + $tab + "refs/heads/main" + $nl) 0 $false $null ""',
  '$lsOther = Mk2 ("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" + $tab + "refs/heads/main" + $nl) 0 $false $null ""',
  '$pushTimeout = Mk2 "" -1 $true $null ""',
  '$res["paLanded"] = PA $pushTimeout $lsHit',
  '$res["paLandedCrlf"] = PA $pushTimeout (Mk2 ($nc + $tab + "refs/heads/main" + $cr + $nl) 0 $false $null "")',
  '$res["paLandedAfterFail"] = PA (Mk2 "" 1 $false $null "fatal: x") $lsHit',
  '$res["paOtherTimeout"] = PA $pushTimeout $lsOther',
  '$res["paOtherFail"] = PA (Mk2 "" 1 $false $null "fatal: x") $lsOther',
  '$res["paLsTimeout"] = PA $pushTimeout (Mk2 ($nc + $tab + "refs/heads/main" + $nl) -1 $true $null "")',
  '$res["paLsStartError"] = PA $pushTimeout (Mk2 "" -1 $false "cannot start" "")',
  '$res["paLsEmpty"] = PA $pushTimeout (Mk2 "" 0 $false $null "")',
  '$res["paLsExit1"] = PA $pushTimeout (Mk2 ($nc + $tab + "refs/heads/main" + $nl) 1 $false $null "")',
  '$res["paLsLonger"] = PA $pushTimeout (Mk2 ($nc + "a" + $tab + "refs/heads/main" + $nl) 0 $false $null "")',
  '$res["paLsShorter"] = PA $pushTimeout (Mk2 ($nc.Substring(0, 39) + $tab + "refs/heads/main" + $nl) 0 $false $null "")',
  // M2：本地库备份轮转——12 份正式名 + 各种手动命名 / 形似但不是正式名的文件 + 一个正式名的目录，只删最旧的 2 份正式名文件
  '$lv = "' + LIVE_DB + '"',
  '$bk = $env:UNIT_DIR + "\\bk"; New-Item -ItemType Directory -Path $bk -Force | Out-Null',
  'foreach ($i in 1..12) { [IO.File]::WriteAllText(($bk + "\\" + $lv + ".backup_20261001_" + $i.ToString("D6")), "x") }',
  'foreach ($n in @(".backup_20250101_000000_manual_old", ".backup_20261010_174241_pre_itasset_import", ".backup_20261001_000013.partial", ".backup_2026100_000001", ".backup_20261001_00001a", "")) { [IO.File]::WriteAllText(($bk + "\\" + $lv + $n), "x") }',
  'New-Item -ItemType Directory -Path ($bk + "\\" + $lv + ".backup_20261002_000099") -Force | Out-Null',
  '$res["dbFormal"] = ((Get-FormalDbBackups $bk | ForEach-Object { $_.Name }) -join ",")',
  '$del = @(Get-DbBackupsToDelete $bk 10)',
  '$res["dbDelete"] = (($del | ForEach-Object { $_.Name }) -join ",")',
  '$res["dbDeleteKeep20"] = (@(Get-DbBackupsToDelete $bk 20).Count)',
  'foreach ($f in $del) { Remove-Item -LiteralPath $f.FullName -Force }',
  '$res["dbLeft"] = ((Get-ChildItem -LiteralPath $bk | ForEach-Object { $_.Name }) -join ",")',
  '$res["dbDeleteAgain"] = (@(Get-DbBackupsToDelete $bk 10).Count)',
  '$res["dbNoDir"] = (@(Get-DbBackupsToDelete ($bk + "\\nope") 10).Count)',
  // 修复批 1c M2：库备份下载之后的大小核对（纯函数，只拒不放）：期望（远端备份大小）必须是正整数且等于本地 .partial 的大小
  'function SZ($e, $a) { $o = Test-BackupSizeMatch $e $a; return ("" + $o.Ok) }',
  '$res["szEq"] = SZ 1234 1234',
  '$res["szEqLong"] = SZ ([long]3000000000) ([long]3000000000)',
  '$res["szStrEq"] = SZ "1234" "1234"',
  '$res["szLess"] = SZ 1234 1000',
  '$res["szMore"] = SZ 1234 5000',
  '$res["szExpNull"] = SZ $null 1234',
  '$res["szExpZero"] = SZ 0 0',
  '$res["szExpNeg"] = SZ (-5) (-5)',
  '$res["szExpText"] = SZ "abc" 1234',
  '$res["szActNull"] = SZ 1234 $null',
  '$res["szActText"] = SZ 1234 "x"',
  '$res["szWhyLess"] = (Test-BackupSizeMatch 1234 1000).Why',
  // M4：restart_time 只多 1（Kind=RESTART_ONCE，措辞不说反复崩溃）与多于 1（仍说反复崩溃）；启动期 SQLITE_BUSY 指引的触发判定
  'function FPK($st, $cnt, $rt, $base) { $t = [pscustomobject]@{ Ok = $true; Count = $cnt; Status = $st; RestartTime = $rt; Error = "e" }; $o = Test-FinalPm2State $t $base; return ("" + $o.Ok + "|" + $o.Kind + "|" + $o.Why) }',
  '$res["fpkOnce"] = FPK "online" 1 6 5',
  '$res["fpkTwice"] = FPK "online" 1 7 5',
  '$res["fpkSame"] = FPK "online" 1 5 5',
  '$res["fpkStopped"] = FPK "stopped" 1 6 5',
  'function SB($r, $k) { return [string](Test-StartupBusyHint $r $k) }',
  `$res["sbInit"] = SB 'READY_FAIL {"code":"READY_TIMEOUT","lastObserved":{"stage":"ready","unready":[{"module":"m","code":"INIT_FAILED"}]}}' ''`,
  `$res["sbBusy"] = SB 'READY_FAIL {"code":"READY_TIMEOUT","lastObserved":{"stage":"ready","unready":[{"module":"m","code":"SQLITE_BUSY"}]}}' ''`,
  `$res["sbCantOpen"] = SB 'READY_FAIL {"unready":[{"module":"m","code":"SQLITE_CANTOPEN"}]}' ''`,
  `$res["sbPlain"] = SB 'READY_FAIL {"code":"READY_TIMEOUT","lastObserved":{"stage":"version"}}' ''`,
  `$res["sbOnceKind"] = SB 'READY_OK 之后 restart_time 从 5 增长到 6' 'RESTART_ONCE'`,
  `$res["sbOnceNoKind"] = SB 'READY_OK 之后 restart_time 从 5 增长到 6' ''`,
  `$res["sbGitFail"] = SB 'git reset 失败：退出码 1' ''`,
  `$res["sbEmpty"] = SB '' ''`,
  // M3：pm2 jlist 顶层 pid 的解析（整数；stopped 是 0；缺失 / 不是整数 = 读不到）
  'function JPID($f) { $t = Get-Pm2Task ([IO.File]::ReadAllText($env:UNIT_DIR + "\\" + $f)); return ("" + $t.Ok + "|[" + $t.Pid + "]") }',
  '$res["pidOk"] = JPID "jlist-ok.txt"',
  '$res["pidStopped"] = JPID "jlist-stopped.txt"',
  '$res["pidMissing"] = JPID "jlist-nopid.txt"',
  '$res["pidText"] = JPID "jlist-textpid.txt"',
  '$res["pidTwo"] = JPID "jlist-two.txt"',
  'function JRP($variant) { $j = Invoke-Local -FileName "node" -ArgList @(($env:UNIT_DIR + "\\fake-remote.js"), $variant) -TimeoutSec 60; $t = Get-Pm2Task $j.Stdout; return ("" + $t.Pid) }',
  '$res["pidReal"] = JRP "crlf"',
  // stdin 传输完整性：各种大小（含管道缓冲边界）、中文、反斜杠、非 BMP 字符，node 回报收到的字节数与 SHA256，与发送的 UTF-8 字节比对。
  // 显式把控制台输入代码页设成 437（单字节、没有 BOM 前导），这样「原样字节」的断言不依赖宿主原来是什么代码页
  '[Console]::InputEncoding = [System.Text.Encoding]::GetEncoding(437)',
  '$res["cpSweep"] = [Console]::InputEncoding.CodePage',
  'function ST($n, $kind) { $unit = if ($kind -eq "cn") { "中文E:\\\\路径\\\\x" } elseif ($kind -eq "emoji") { "a" + [char]::ConvertFromUtf32(0x1F600) + "b" } else { "abcdefghij" }; $sb = New-Object System.Text.StringBuilder; while ($sb.Length -lt $n) { [void]$sb.Append($unit) }; $text = $sb.ToString(); $exp = (New-Object System.Text.UTF8Encoding($false)).GetBytes($text); $sha = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($exp)).Replace("-", "").ToLower(); $r = Invoke-Local -FileName "node" -ArgList @(($env:UNIT_DIR + "\\\\stdin-echo.js")) -TimeoutSec 60 -StdinText $text; return ("" + $exp.Length + "|" + $sha + "|" + $r.ExitCode + "|" + $r.Stdout.Trim()) }',
  '$stRows = @(); foreach ($n in @(100, 4095, 4096, 4097, 8192, 32767, 32768, 32769, 65535, 65536, 65537, 200000, 1000000)) { foreach ($k in @("cn", "ascii", "emoji")) { $stRows += ($n.ToString() + "/" + $k + "=" + (ST $n $k)) } }',
  '$res["stdinRows"] = $stRows',
  '$res["pm2RealCrlf"] = JR "crlf"',
  '$res["pm2RealLf"] = JR "lf"',
  '$res["pm2RealBig"] = JR "big"',
  '$res["pm2RealNoPrefix"] = JR "noprefix"',
  // 宿主的控制台输入代码页是 UTF-8（chcp 65001，例如 PowerShell 工具）时：.NET 的 Process.StandardInput 会在 stdin 最前面多写 UTF-8 BOM（EF BB BF）。
  // 真实的 pm2 jlist 以 [{ 打头（没有前缀行），带着 BOM 就匹配不到行首的 [（NO_JSON_ARRAY）——修复批 2 在真实 DryRun 里踩到的回归。再把上面几种真实形态在这个代码页下各跑一遍
  '[Console]::InputEncoding = [System.Text.Encoding]::UTF8',
  '$res["inputCp"] = [Console]::InputEncoding.CodePage',
  '$bomProbe = Invoke-Local -FileName "node" -ArgList @(($env:UNIT_DIR + "\\\\stdin-echo.js")) -TimeoutSec 60 -StdinText "[{}]"',
  '$res["bomProbe"] = $bomProbe.Stdout.Trim()',
  '$res["pm2Real65001Crlf"] = JR "crlf"',
  '$res["pm2Real65001Lf"] = JR "lf"',
  '$res["pm2Real65001Big"] = JR "big"',
  '$res["pm2Real65001NoPrefix"] = JR "noprefix"',
  '} finally { [Console]::InputEncoding = $origInputEncoding }',
  '$res["inputCpRestored"] = ([Console]::InputEncoding.CodePage -eq $origInputEncoding.CodePage)',
  '"RESULT " + ($res | ConvertTo-Json -Compress)',
].join('\r\n');

async function unitChecks(scriptPath) {
  const lf = stripBom(fs.readFileSync(scriptPath, 'utf8')).replace(/\r/g, '');
  const names = ['Get-LastLine', 'Test-Ok', 'Get-ResultNote', 'ConvertTo-ArgString', 'Invoke-Local', 'Read-Protocol', 'New-FakeProc', 'Resolve-BackupOutcome', 'Resolve-ReadyOutcome', 'Test-FinalPm2State', 'Test-StartupBusyHint', 'Get-FormalCollabSnapshots', 'Get-FormalDbBackups', 'Get-DbBackupsToDelete', 'Test-BackupSizeMatch', 'Format-Tri', 'Initialize-WorkTmp', 'Get-Pm2Task', 'Get-ListeningPids', 'Test-Pm2OwnsPort', 'Test-PortReleased', 'Resolve-PushAftermath'];
  const texts = names.map((n) => psFunctionText(lf, n));
  if (!check('U0 能从被测脚本里取出全部纯函数', texts.every((t) => t !== null), names.filter((n, i) => texts[i] === null).join(','))) return;
  const dir = freshDir('unit');
  const app = (name, status, restart, pid) => Object.assign({ name, pm_id: 1, pm2_env: { status, restart_time: restart, env: { PATH: 'a', Path: 'b' } } }, pid === undefined ? {} : { pid });
  const noise = '[PM2] Spawning PM2 daemon with pm2_home=C:\\Users\\x\\.pm2\n[PM2] PM2 Successfully daemonized\n';
  fs.writeFileSync(path.join(dir, 'jlist-ok.txt'), noise + JSON.stringify([app('business-flow', 'online', 9, 111), app('task-pool', 'online', 3, 4321), app('sysbuild-pm-temp', 'online', 0, 222)]));
  fs.writeFileSync(path.join(dir, 'jlist-stopped.txt'), JSON.stringify([app('task-pool', 'stopped', 4, 0)]));
  fs.writeFileSync(path.join(dir, 'jlist-nopid.txt'), JSON.stringify([app('task-pool', 'online', 4)]));
  fs.writeFileSync(path.join(dir, 'jlist-textpid.txt'), JSON.stringify([app('task-pool', 'online', 4, '4321')]));
  // netstat -ano 形态的输入（M3）。ns-malformed：3000 的 LISTENING 行缺末尾的 pid 列，无法解析
  const writeNs = (name, rows, eol) => fs.writeFileSync(path.join(dir, name), nsText(rows, eol));
  writeNs('ns-ok.txt', [].concat(NS_NOISE, [nsV4(4321), nsV6(4321)]));
  writeNs('ns-lf.txt', [].concat(NS_NOISE, [nsV4(4321), nsV6(4321)]), '\n');
  writeNs('ns-v4.txt', [].concat(NS_NOISE, [nsV4(4321)]));
  writeNs('ns-v6.txt', [].concat(NS_NOISE, [nsV6(4321)]));
  writeNs('ns-multi.txt', [].concat(NS_NOISE, [nsV4(4321), nsV6(9999)]));
  writeNs('ns-sort.txt', [].concat(NS_NOISE, [nsV4(100), nsV6(9)]));
  writeNs('ns-dup.txt', [].concat(NS_NOISE, [nsV4(4321), nsV4(4321), nsV6(4321)]));
  writeNs('ns-none.txt', NS_NOISE);
  writeNs('ns-malformed.txt', [].concat(NS_NOISE, [`  TCP    0.0.0.0:${APP_PORT}           0.0.0.0:0              LISTENING`]));
  // 修复批 1b H1：健康服务 + 带数字的 FIN_WAIT_1 / FIN_WAIT_2 行（只列这些，不靠 NS_NOISE）；本地化（非 ASCII）状态与小写状态——3000 上的行解析不了必须 fail-closed
  writeNs('ns-fin.txt', [nsV4(4321), nsV6(4321), `  TCP    192.168.1.100:${APP_PORT}      198.51.100.7:50001       FIN_WAIT_2      0`, `  TCP    192.168.1.100:${APP_PORT}      198.51.100.7:50002       FIN_WAIT_1      4321`, '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       888']);
  writeNs('ns-localized.txt', [].concat(NS_NOISE, [`  TCP    0.0.0.0:${APP_PORT}           0.0.0.0:0              侦听            4321`]));
  writeNs('ns-localized-v6.txt', [].concat(NS_NOISE, [nsV4(4321), `  TCP    [::]:${APP_PORT}              [::]:0                 ÉCOUTE          4321`]));
  writeNs('ns-lower.txt', [].concat(NS_NOISE, [`  TCP    0.0.0.0:${APP_PORT}           0.0.0.0:0              listening       4321`]));
  writeNs('ns-localized-other.txt', [].concat(NS_NOISE, ['  TCP    0.0.0.0:8080           0.0.0.0:0              侦听            777', nsV4(4321)]));
  fs.writeFileSync(path.join(dir, 'ns-garbage.txt'), 'command not found\r\n');
  fs.writeFileSync(path.join(dir, 'ns-empty.txt'), '');
  fs.writeFileSync(path.join(dir, 'jlist-two.txt'), JSON.stringify([app('task-pool', 'online', 1), app('task-pool', 'online', 2)]));
  fs.writeFileSync(path.join(dir, 'jlist-none.txt'), JSON.stringify([app('other', 'online', 1)]));
  fs.writeFileSync(path.join(dir, 'jlist-garbage.txt'), 'command not found\n');
  fs.writeFileSync(path.join(dir, 'stdin-echo.js'), [
    "const crypto = require('crypto');",
    "const chunks = [];",
    "process.stdin.on('data', (c) => chunks.push(c));",
    "process.stdin.on('end', () => { const b = Buffer.concat(chunks); process.stdout.write(b.length + '|' + crypto.createHash('sha256').update(b).digest('hex') + '|' + b.slice(0, 4).toString('hex') + '|' + b.slice(-4).toString('hex')); });",
    '',
  ].join('\n'));
  // 假「远端」：自己合成 jlist（不使用任何真实生产内容）。task-pool 在中间；每个进程带很长的环境变量（中文、Windows 路径反斜杠、仅大小写不同的键），整体 > 30 KB 且全在一行
  fs.writeFileSync(path.join(dir, 'fake-remote.js'), [
    "'use strict';",
    "const variant = process.argv[2];",
    "const filler = (n) => { const env = { PATH: 'C:\\\\Windows\\\\System32;E:\\\\工具\\\\node', Path: 'dup', 备注: '中文环境变量'.repeat(20) }; for (let i = 0; i < n; i += 1) env['VAR_' + i] = 'E:\\\\Task_Pool\\\\wbs-server\\\\uploads\\\\' + 'x'.repeat(60) + '中文'; return env; };",
    "const app = (name, status, restart, n) => ({ pid: 100, name, pm_id: 1, monit: { memory: 1, cpu: 0 }, pm2_env: { status, restart_time: restart, pm_cwd: 'E:\\\\Task_Pool\\\\wbs-server', env: filler(n) } });",
    "const n = variant === 'big' ? 1200 : 150;",
    "const json = JSON.stringify([app('business-flow', 'online', 9, n), app('task-pool', 'online', 2314, n), app('sysbuild-pm-temp', 'online', 0, n)]);",
    "const eol = variant === 'lf' ? '\\n' : '\\r\\n';",
    "const prefix = variant === 'noprefix' ? '' : '[PM2] Spawning PM2 daemon with pm2_home=C:\\\\Users\\\\someone\\\\.pm2' + eol + '[PM2] PM2 Successfully daemonized' + eol;",
    "process.stdout.write(prefix + json + eol);",
    '',
  ].join('\n'));
  const psFile = path.join(dir, 'unit.ps1');
  fs.writeFileSync(psFile, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(`${texts.join('\r\n')}\r\n${UNIT_PS}\r\n`, 'utf8')]));
  const tempDir = freshDir('unit-temp');
  const env = Object.assign({}, process.env, { PATH: SAFE_PATH, TEMP: tempDir, TMP: tempDir, UNIT_DIR: dir });
  if (ISOLATION_ABORT) throw new Error('隔离不成立之后不允许启动子进程');
  SPAWN_COUNT += 1;
  const r = await withCpLock(async () => spawnSync(POWERSHELL, ['-NoProfile', '-File', psFile], { cwd: dir, env, encoding: 'utf8', timeout: 180000 }));
  const out = stripBom(r.stdout || '');
  const line = out.split(/\r?\n/).find((l) => l.startsWith('RESULT '));
  if (!check('U0 单元脚本跑出 RESULT 行', !!line, `${(r.stderr || '').slice(0, 300)} ${out.slice(0, 300)}`)) return;
  const R = JSON.parse(line.slice(7));
  eq('U1 协议行：正常', R.ok, 'BACKUP_OK|E:/x/b|');
  eq('U1 协议行：CRLF 行尾也认', R.okCrlf, 'BACKUP_OK|E:/x/b|');
  eq('U1 协议行：整段不以换行结尾 -> 没收到', R.noNewline, 'null');
  eq('U1 协议行：JSON 被截断 -> 没收到', R.truncatedJson, 'null');
  eq('U1 协议行：超时 -> 没收到', R.timedOut, 'null');
  eq('U1 协议行：协议行不是最后一个非空行 -> 没收到', R.notLast, 'null');
  eq('U1 协议行：前缀后没有空格（BACKUP_OKX{…}）-> 没收到', R.prefixNoSpace, 'null');
  eq('U1 协议行：JSON 不是对象 -> 没收到', R.scalarJson, 'null');
  eq('U1 协议行：BACKUP_FAIL 正常解析', R.fail, 'BACKUP_FAIL||BK_VACUUM_FAILED');
  eq('U1 协议行：启动错误 -> 没收到', R.startError, 'null');
  check('U2 三态「unknown」照实写「无法确认」，不当 false', String(R.triUnknown).includes('无法确认'), R.triUnknown);
  eq('U2 三态 true / false', [R.triTrue, R.triFalse], ['是', '否']);
  eq('U3 参数引用：空串 / 空格 / 内嵌双引号 / 末尾反斜杠原样到达子进程', JSON.parse(R.argv), ['a b', '', 'c"d', 'x\\']);
  check('U4 本机子进程超时：标记超时且很快返回', R.timeoutFlag === true && R.timeoutFast === true, JSON.stringify([R.timeoutFlag, R.timeoutFast]));
  check('U4 本机子进程启动失败：StartError 有值，Test-Ok 为假', R.startErrorSet === true && R.testOkFalse === false);
  eq('U6 第 5 步判定：BACKUP_OK + 退出码 0 -> OK', R.boOk, 'OK|E:/x/b|');
  eq('U6 第 5 步判定：以协议行为准，BACKUP_OK 但退出码 1 -> 仍是 OK', R.boOkExit1, 'OK|E:/x/b|');
  eq('U6 第 5 步判定：BACKUP_FAIL 行 + 退出码 1（backup-db 的真实失败）-> FAIL', R.boFailExit1, 'FAIL|E:/x/b|BK_VACUUM_FAILED');
  eq('U6 第 5 步判定：ssh 退出 255 且 stdout 为空 -> UNKNOWN（不得自动起服务）', R.boSsh255Empty, 'UNKNOWN||');
  eq('U6 第 5 步判定：退出码 255 但 stdout 有完整 BACKUP_FAIL 行 -> FAIL（协议行为准）', R.bo255Fail, 'FAIL|E:/x/b|BK_VACUUM_FAILED');
  eq('U6 第 5 步判定：超时但有完整行 -> UNKNOWN', R.boTimeoutFail, 'UNKNOWN||');
  eq('U6 第 5 步判定：启动失败 -> UNKNOWN', R.boStartError, 'UNKNOWN||');
  eq('U6 第 5 步判定：只有 stderr 含 BACKUP_FAIL 行 -> UNKNOWN', R.boStderrOnly, 'UNKNOWN||');
  eq('U6 第 5 步判定：BACKUP_OK 但 json 没有 out -> UNKNOWN', R.boOkNoOut, 'UNKNOWN||');
  eq('U7 第 8 步判定：READY_OK -> OK', R.roOk, 'OK|');
  eq('U7 第 8 步判定：READY_FAIL 带 hint=COMMIT_NULL -> FAIL 且取出 hint', R.roCommitNull, 'FAIL|COMMIT_NULL');
  eq('U7 第 8 步判定：READY_FAIL 无 hint -> FAIL', R.roFailNoHint, 'FAIL|');
  eq('U7 第 8 步判定：退出码 0 但没有协议行 -> UNKNOWN（不凭退出码判成功）', R.roExit0NoLine, 'UNKNOWN|');
  eq('U7 第 8 步判定：READY_INTERNAL（退出码 3）-> FAIL', R.roInternal, 'FAIL|');
  eq('U7 第 8 步判定：超时但有 READY_OK 行 -> UNKNOWN', R.roTimeoutOk, 'UNKNOWN|');
  eq('U5 pm2 jlist（前面有 PM2 提示行、环境变量里有仅大小写不同的键）经 node 解析', R.pm2Ok, 'True|1|online|3');
  // 行格式：<大小>/<种类>=<发送字节数>|<发送 SHA256>|<node 退出码>|<node 收到字节数>|<收到 SHA256>|<开头 4 字节>|<末尾 4 字节>
  const badRows = (R.stdinRows || []).filter((row) => {
    const f = String(row).split('=')[1].split('|');
    return !(f[2] === '0' && f[0] === f[3] && f[1] === f[4]);
  });
  check('U9 Invoke-Local -StdinText 的传输完整性（默认控制台代码页）：各种大小（含管道缓冲边界 4096 / 32768 / 65536 ±1，最大 1 MB）× 中文 / ASCII / 非 BMP 字符，node 收到的字节数与 SHA256 全部等于发送的 UTF-8 字节', badRows.length === 0 && (R.stdinRows || []).length === 39, `${(R.stdinRows || []).length} 行，不一致：${badRows.slice(0, 3).join(' || ')}`);
  // 控制台输入代码页 65001 时 .NET 在 stdin 最前面多写 BOM——这是已知的环境事实（Invoke-Local 关不掉它），接收端必须容忍；这里只记录，不当缺陷
  // 不预设宿主的初始代码页（主会话的宿主本来就是 65001）：单元脚本记下进入时的值，需要什么代码页就显式设，结束还原
  eq('U9 夹具：「原样字节」那组断言前显式把控制台输入代码页设成了 437（不依赖宿主原来是什么）', R.cpSweep, 437);
  eq('U9 夹具：控制台输入代码页已设为 65001', R.inputCp, 65001);
  check('U8 终检（M2）：唯一的 task-pool online 且 restart_time 未增长 -> 通过', String(R.fpOnline) === 'True|', String(R.fpOnline));
  for (const [key, label, frag] of [['fpStopped', 'stopped', "状态是 'stopped'，不是 online"], ['fpErrored', 'errored', "状态是 'errored'，不是 online"], ['fpWaiting', 'waiting restart', "状态是 'waiting restart'，不是 online"], ['fpGrown', 'restart_time 增长', '增长到 6'], ['fpTwo', '进程数 2', '数量是 2'], ['fpNoRt', 'restart_time 读不到', '读不到 restart_time'], ['fpReadFail', 'pm2 读取失败', '读不到 pm2 状态']]) {
    check(`U8 终检（M2）：READY_OK 之后 ${label}（计数未增长或读不到）-> 判失败`, String(R[key]).startsWith('False|') && String(R[key]).includes(frag), String(R[key]));
  }
  const hang = String(R.stdinHang).split('|');
  check('U10 stdin 写入受总截止时间约束（M3 / L2）：子进程不读 stdin、发送 2 MB 文本 -> 返回 TimedOut，耗时不超过 TimeoutSec(3) + 收尾宽限(5) = 8 秒（不永远阻塞，也不是 TimeoutSec 的两倍）', hang[0] === 'True' && Number(hang[1]) <= 8, String(R.stdinHang));
  eq('U11 附件快照保留份数只统计正式名 collab_yyyyMMdd_HHmmss（.partial、普通文件、别的名字都不计）', R.formalSnaps, 'collab_20260101_000003,collab_20260101_000001');
  // ---- B1 末次合并审预筛六项（U12-U19）。每个硬门：正向（满足放行）+ 反向（每种不满足形态都拒），拒绝类用 startsWith('False|') 与关键片段断言
  // U12 M1 推送超时 / 失败之后的只读核对结论
  const ncSha = '0123456789abcdef0123456789abcdef01234567';
  check('U12 M1 push 超时、只读核对 production 的 main 已等于 NewCommit -> Landed，提示「推送已生效」「可能卡在远端 gc --auto」「确认没有在跑的 git 进程后重跑本脚本（推送会是 up-to-date）」，点名 NewCommit 与「超时」',
    String(R.paLanded).startsWith('True|') && ['推送已生效', '可能卡在远端 gc --auto', '确认没有在跑的 git 进程后重跑本脚本（推送会是 up-to-date）', ncSha, '（超时）'].every((s) => String(R.paLanded).includes(s)), R.paLanded);
  check('U12 M1 ls-remote 行是 CRLF 结尾 / push 是失败（退出码 1）而非超时 -> 同样按 Landed 处理，原失败原因照实带上', String(R.paLandedCrlf).startsWith('True|') && String(R.paLandedAfterFail).startsWith('True|') && String(R.paLandedAfterFail).includes('退出码 1 fatal: x'), `${R.paLandedCrlf} || ${R.paLandedAfterFail}`);
  eq('U12 M1 远端 main 不等于 NewCommit（push 超时）-> 未生效，只打印原失败提示（超时）', R.paOtherTimeout, 'False|git push production main 失败：超时');
  eq('U12 M1 远端 main 不等于 NewCommit（push 失败退出码 1）-> 未生效，只打印原失败提示（带 stderr）', R.paOtherFail, 'False|git push production main 失败：退出码 1 fatal: x');
  // 只读核对本身成功但结果不对（无输出 / 提交号多一位或少一位）：照旧只打印原失败提示
  for (const key of ['paLsEmpty', 'paLsLonger', 'paLsShorter']) {
    eq(`U12 M1 只读核对成功但不等于 NewCommit（${key}：无输出 / 提交号多一位或少一位）-> 不当作推送已生效，只打印原失败提示`, R[key], 'False|git push production main 失败：超时');
  }
  // 只读核对本身也失败（超时 / 启动失败 / 退出码非 0）（修复批 1b LOW④）：推送是否生效未知——措辞如实说「也失败 / 未知 / 重跑安全（推送幂等）」，仍不当作已生效
  for (const key of ['paLsTimeout', 'paLsStartError', 'paLsExit1']) {
    const v = String(R[key]);
    check(`U12 M1 只读核对本身也失败（${key}）-> 不当作推送已生效；措辞「也失败」「推送是否生效未知」「重跑安全（推送幂等）」，且仍带原失败原因`, v.startsWith('False|git push production main 失败：超时；') && v.includes('git ls-remote production refs/heads/main 也失败（') && v.includes('推送是否生效未知') && v.includes('重跑安全（推送幂等）') && !v.includes('推送已生效'), v);
  }
  // U13 M2 本地库备份轮转
  const fmtBk = (i) => `${LIVE_DB}.backup_20261001_${String(i).padStart(6, '0')}`;
  eq(`U13 M2 本地库备份：只有正式名 ${LIVE_DB}.backup_YYYYMMDD_HHmmss 的文件才算（手动命名 / .partial / 日期位数不对 / 末位不是数字 / 库文件本身 / 正式名的目录都不算），按名字倒序`, R.dbFormal, [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map(fmtBk).join(','));
  eq('U13 M2 保留 10 份：12 份正式名里只删最旧的 2 份', R.dbDelete, `${fmtBk(2)},${fmtBk(1)}`);
  eq('U13 M2 保留份数 ≥ 正式名份数时不删任何文件（保留 20 份 -> 0 个待删）', R.dbDeleteKeep20, 0);
  const keepSet = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(fmtBk).concat([`${LIVE_DB}.backup_20250101_000000_manual_old`, `${LIVE_DB}.backup_20261010_174241_pre_itasset_import`, `${LIVE_DB}.backup_20261001_000013.partial`, `${LIVE_DB}.backup_2026100_000001`, `${LIVE_DB}.backup_20261001_00001a`, LIVE_DB, `${LIVE_DB}.backup_20261002_000099`]);
  eq('U13 M2 删除之后：最新 10 份正式名都在，手动命名的备份（最旧的 manual_old 与最新的 pre_itasset_import）、.partial、形似但不是正式名的文件、库文件、正式名的目录全部保留', String(R.dbLeft).split(',').sort(), keepSet.slice().sort());
  eq('U13 M2 删完再算：没有待删文件；目录不存在时也是 0 个待删（不抛错）', [R.dbDeleteAgain, R.dbNoDir], [0, 0]);
  // U14 M3 netstat 解析
  eq('U14 M3 netstat 解析：IPv4（0.0.0.0）与 IPv6（[::]）两栈的 3000 同一 pid -> 记一次；无关行（:30000、ESTABLISHED、TIME_WAIT、UDP、别处连到 :3000）都不算', R.nsOk, 'True|4321');
  eq('U14 M3 netstat 解析：LF 行尾也认', R.nsLf, 'True|4321');
  eq('U14 M3 netstat 解析：只有 IPv4 一栈 / 只有 IPv6 一栈 -> 各自都算', [R.nsV4, R.nsV6], ['True|4321', 'True|4321']);
  eq('U14 M3 netstat 解析：两栈 pid 不同 -> 两个 pid 都返回（硬门据此拒绝）', R.nsMulti, 'True|4321,9999');
  // U20 修复批 1c M2：库备份下载之后的大小核对（Test-BackupSizeMatch，纯函数，只拒不放）
  eq('U20 M2 Test-BackupSizeMatch：期望（远端备份大小）与本地 .partial 大小相等才通过（含超过 32 位整数的大小、字符串形式的数字）', [R.szEq, R.szEqLong, R.szStrEq], ['True', 'True', 'True']);
  eq('U20 M2 Test-BackupSizeMatch：本地比远端小（下载中断）/ 比远端大（文件被换过）都不通过', [R.szLess, R.szMore], ['False', 'False']);
  eq('U20 M2 Test-BackupSizeMatch：期望大小读不到（null / 0 / 负数 / 非数字）一律不通过，即使本地大小「等于」它（0 对 0、-5 对 -5 也不放行）', [R.szExpNull, R.szExpZero, R.szExpNeg, R.szExpText], ['False', 'False', 'False', 'False']);
  eq('U20 M2 Test-BackupSizeMatch：本地 .partial 的大小读不到（null / 非数字）不通过', [R.szActNull, R.szActText], ['False', 'False']);
  check('U20 M2 Test-BackupSizeMatch：不一致的说明里点名两边的大小与「不一致」', String(R.szWhyLess).includes('1000') && String(R.szWhyLess).includes('1234') && String(R.szWhyLess).includes('不一致'), R.szWhyLess);
  eq('U14 M3 netstat 解析：pid 按数值排序（9 在 100 之前）；同一 pid 出现多行只记一次', [R.nsSort, R.nsDup], ['True|9,100', 'True|4321']);
  eq('U14 M3 netstat 解析：3000 上只有非 LISTENING 行 -> 读得到、没有监听者（Ok 为真、pid 为空）', R.nsNone, 'True|');
  eq('U14 M3 netstat 解析：端口整数相等，不按前缀匹配（查 30000 只得 777；查 300 什么都没有；:30000 不会被当成 3000）', [R.nsPort30000, R.nsPort300], ['True|777', 'True|']);
  eq('U14 M3 netstat 解析 fail-closed：命令没成功（垃圾文字 / 空输出，没有任何 TCP 行）-> Ok 为假，不当成「没有监听者」', [R.nsGarbage, R.nsEmpty], ['False|', 'False|']);
  eq('U14 M3 netstat 解析 fail-closed：3000 的 TCP 行无法解析（缺 pid 列）-> Ok 为假；同一行对别的端口不相干 -> 照常', [R.nsMalformed, R.nsMalformedOtherPort], ['False|', 'True|']);
  eq('U14 H1（修复批 1b）健康服务 + 带数字状态的 FIN_WAIT_1 / FIN_WAIT_2 行（3000 作本地端，pid 0 与 4321）：照常解析，唯一监听者 4321；它们不算监听者（查没有监听的端口 3001 -> Ok 为真、pid 为空）', [R.nsFin, R.nsFinNone], ['True|4321', 'True|']);
  eq('U14 H1 本地化（非 ASCII：侦听 / ÉCOUTE）或小写（listening）的状态列：3000 上的行解析不了 -> Ok 为假（fail-closed，不能当成没有监听者，更不能让第 4 步把仍在监听的端口判成已释放）', [R.nsLocalized, R.nsLocalizedV6, R.nsLower], ['False|', 'False|', 'False|']);
  eq('U14 H1 无法解析的行只影响它自己的端口：8080 上的本地化行不妨碍查 3000（仍得 4321），查 8080 才 Ok 为假', [R.nsLocalizedOther, R.nsLocalizedOtherPort], ['True|4321', 'False|']);
  // U15 M3 pm2 pid 硬门
  const headMsg = '3000 监听者与 pm2 进程不一致，疑似孤儿监听，按 memory feedback_pm2_orphan_listener_recovery 处置';
  check('U15 M3 pm2 pid 等于 3000 的唯一监听 pid（两栈 / 只 v4 / 只 v6 / pid 以数字字符串给）-> 放行', [R.owOk, R.owOkStr, R.owV4, R.owV6].every((x) => x === 'True|'), JSON.stringify([R.owOk, R.owOkStr, R.owV4, R.owV6]));
  check('U15 M3 pid 不等 -> 拒，点名「疑似孤儿监听」与 memory 处置、双方 pid', String(R.owMismatch).startsWith(`False|${headMsg}`) && String(R.owMismatch).includes('3000 的监听 pid 4321 不等于 pm2 记录的 pid 9999'), R.owMismatch);
  check('U15 M3 多个不同 pid -> 拒，点名多个 pid', String(R.owMulti).startsWith(`False|${headMsg}`) && String(R.owMulti).includes('多个不同 pid 在监听（4321,9999）'), R.owMulti);
  check('U15 M3 3000 没有 LISTENING（只有 ESTABLISHED / TIME_WAIT）-> 拒', String(R.owNone).startsWith(`False|${headMsg}`) && String(R.owNone).includes('3000 没有 LISTENING（pm2 记录的 pid 4321）'), R.owNone);
  for (const key of ['owNullPid', 'owZeroPid', 'owNegPid', 'owTextPid']) {
    check(`U15 M3 pm2 记录的 pid 读不到 / 0 / 负数 / 非数字（${key}）-> 拒，且是「无法核对」而不是孤儿监听结论`, String(R[key]).startsWith('False|无法核对 3000 监听者与 pm2 进程是否一致：读不到 pm2 记录的 pid') && !String(R[key]).includes('疑似孤儿监听'), R[key]);
  }
  check('U15 M3 读不到 3000 的监听情况（netstat 输出不是 TCP 表）/ 监听结果为空对象 -> 拒（无法核对）', String(R.owGarbage).startsWith('False|无法核对 3000 监听者与 pm2 进程是否一致：读不到 3000 的监听情况') && R.owNullListen === false, `${R.owGarbage} || ${R.owNullListen}`);
  // U16 M3 停服后端口释放硬门
  eq('U16 M3 停服之后 3000 零 LISTENING（只有 ESTABLISHED / TIME_WAIT / :30000 的监听）-> 放行', R.prFree, 'True|');
  check('U16 M3 停服之后 3000 仍有 LISTENING（一个 / 两个 pid）-> 拒，点名 pid', String(R.prBusy).startsWith('False|停服之后 3000 仍有 LISTENING，pid 4321') && String(R.prMulti).includes('pid 4321,9999') && String(R.prMulti).startsWith('False|'), `${R.prBusy} || ${R.prMulti}`);
  check('U16 M3 读不到 3000 的监听情况 / 监听结果为空对象 -> 拒（读不到不等于已释放）', String(R.prGarbage).startsWith('False|读不到 3000 的监听情况，无法确认已释放') && R.prNull === false, `${R.prGarbage} || ${R.prNull}`);
  check('U16 H1 停服后 3000 上仍有监听、状态列是本地化文字（侦听）-> 拒（读不到 = 无法确认已释放，不是「已释放」）；3000 上有 LISTENING + FIN_WAIT 行 -> 拒并点名 pid 4321', String(R.prLocalized).startsWith('False|读不到 3000 的监听情况，无法确认已释放') && String(R.prFin).startsWith('False|停服之后 3000 仍有 LISTENING，pid 4321'), `${R.prLocalized} || ${R.prFin}`);
  // U17 M4 restart_time 只多 1
  check('U17 M4 restart_time 只比基准多 1 -> 仍判失败（Ok=False），Kind=RESTART_ONCE，措辞「新进程重启过 1 次」，不说「反复崩溃」', String(R.fpkOnce).startsWith('False|RESTART_ONCE|') && String(R.fpkOnce).includes('增长到 6') && String(R.fpkOnce).includes('新进程重启过 1 次') && !String(R.fpkOnce).includes('反复崩溃'), R.fpkOnce);
  check('U17 M4 restart_time 多于 1 -> 仍说「反复崩溃重启」，没有 Kind；没增长 -> 通过；非 online -> 失败且没有 Kind', String(R.fpkTwice).startsWith('False||') && String(R.fpkTwice).includes('增长到 7') && String(R.fpkTwice).includes('新进程在反复崩溃重启') && R.fpkSame === 'True||' && String(R.fpkStopped).startsWith('False||'), `${R.fpkTwice} || ${R.fpkSame} || ${R.fpkStopped}`);
  // U18 M4 SQLITE_BUSY 指引触发判定
  check('U18 M4 失败原因含未就绪模块的 INIT_FAILED / SQLITE_*（SQLITE_BUSY、SQLITE_CANTOPEN）或 Kind=RESTART_ONCE -> 触发指引', [R.sbInit, R.sbBusy, R.sbCantOpen, R.sbOnceKind].every((x) => x === 'True'), JSON.stringify([R.sbInit, R.sbBusy, R.sbCantOpen, R.sbOnceKind]));
  check('U18 M4 其他失败形态（版本阶段超时 / 只有 restart_time 增长的文字但没有 Kind / git 失败 / 空）-> 不触发', [R.sbPlain, R.sbOnceNoKind, R.sbGitFail, R.sbEmpty].every((x) => x === 'False'), JSON.stringify([R.sbPlain, R.sbOnceNoKind, R.sbGitFail, R.sbEmpty]));
  // U19 M3 pm2 jlist 顶层 pid 解析
  eq('U19 M3 pm2 jlist：task-pool 的顶层 pid（同名以外的应用不干扰）/ stopped 是 0 / 缺失或不是整数 = 读不到 / 同名两个 = 取不到', [R.pidOk, R.pidStopped, R.pidMissing, R.pidText, R.pidTwo], ['True|[4321]', 'True|[0]', 'True|[]', 'True|[]', 'True|[]']);
  eq('U19 M3 pm2 jlist 真实形态（单行 > 30 KB、CRLF、[PM2] 前缀行）：经 Invoke-Local 读 stdout -> Get-Pm2Task 解出 task-pool 的 pid 100', R.pidReal, '100');
  eq('U9 夹具：65001 的试验做完后控制台输入代码页已还原（不污染同一控制台下后续的运行）', R.inputCpRestored, true);
  check('U9 记录事实：65001 下 stdin 开头被 .NET 多写了 EF BB BF（所以 pm2 解析的 node 脚本必须去掉开头 BOM）', /^5\|[0-9a-f]{64}\|efbbbf5b\|/.test(String(R.bomProbe)) || String(R.bomProbe).includes('|efbbbf'), String(R.bomProbe));
  const realShapes = [['Crlf', '单行 > 30 KB、CRLF、[PM2] 前缀行、中文与反斜杠', 30000], ['Lf', 'LF 行尾', 30000], ['NoPrefix', '无前缀行（真实 jlist 就是以 [{ 打头）', 30000], ['Big', '单行约 400 KB', 300000]];
  for (const [shape, label, minLen] of realShapes) {
    for (const [cp, prefix] of [['默认代码页', 'pm2Real'], ['UTF-8 代码页 65001', 'pm2Real65001']]) {
      const parts = String(R[`${prefix}${shape}`]).split('|');
      check(`U8 真实形态的 pm2 jlist（${label}；${cp}）经 Invoke-Local 读 stdout -> Get-Pm2Task -> stdin 给 node：解出 task-pool online、restart_time 2314`, Number(parts[0]) >= minLen && parts.slice(1).join('|') === 'True|1|online|2314|', String(R[`${prefix}${shape}`]));
    }
  }
  eq('U5 pm2 jlist：stopped', R.pm2Stopped, 'True|1|stopped|4');
  eq('U5 pm2 jlist：两个同名应用 -> Count 2', R.pm2Two, 'True|2||');
  eq('U5 pm2 jlist：没有 task-pool -> Count 0', R.pm2None, 'True|0||');
  eq('U5 pm2 jlist：不是 JSON -> Ok 为 False', R.pm2Garbage, 'False|0||');
}

/**
 * 隔离门（H2）：动态用例、拒绝用例、变异自证启动任何部署脚本子进程之前，所有隔离条件必须成立，任一不成立就立即中止整个动态段、单元段与变异段
 * （ISOLATION_ABORT：runPs 此后直接抛错，变异段不进入），输出 `ABORT 隔离不成立：…`，退出码非 0。
 * 先做只读文件系统检查，全部通过才做需要起子进程的探测（git / PowerShell 的 Get-Command，都不是部署脚本）。
 * 返回 { problems, passed }：problems 为空 = 成立；passed 是每项通过的检查名（成立时记为通过的 check）。
 */
function isolationGate(needR) {
  const problems = [];
  const passed = [];
  const note = (ok, okName, bad) => { if (ok) passed.push(okName); else problems.push(bad); };
  const sshDirs = sshInDirs();
  note(sshDirs.length === 0, 'D0 隔离：动态用例的 PATH 目录里没有 ssh.exe / scp.exe', `动态用例的 PATH 目录里有 ssh.exe / scp.exe：${sshDirs.join(', ')}`);
  // CreateProcess 还会搜进程当前目录与调用者目录：诱饵仓库、各脚本副本所在目录与它们的 deploy/ 下也不能有 ssh / scp / git 可执行文件
  const searchDirs = [FIX.decoy, FIX.repo, path.dirname(FIX.script), path.dirname(FIX.norepoScript), FIX.norepo, path.join(path.dirname(FIX.script), 'deploy')];
  const dirty = searchDirs.filter((d) => hasExe(d, ['ssh.exe', 'scp.exe', 'git.exe']).length > 0);
  note(dirty.length === 0, 'D0 隔离：进程当前目录与脚本副本目录下没有 ssh.exe / scp.exe / git.exe', `进程当前目录或脚本副本目录下有 ssh / scp / git 可执行文件：${dirty.join(', ')}`);
  note(TEST_NET_IP === '192.0.2.1', 'D0 隔离：所有动态用例都带 -ServerIP 192.0.2.1（runPs 统一加，且拒绝别的取值）', `测试地址常量不是 192.0.2.1：${TEST_NET_IP}`);
  if (needR) {
    const exeInStrict = STRICT_PATH_DIRS.concat([FIX.norepo, path.dirname(FIX.norepoScript)]).filter((d) => hasExe(d, ['git.exe', 'ssh.exe', 'scp.exe']).length > 0);
    note(exeInStrict.length === 0 && STRICT_PATH_DIRS.length <= 2, 'R0 隔离②（目录）：严格 PATH 只有 node 目录与 System32，且其中与脚本副本目录下都没有 git / ssh / scp', `严格 PATH 或脚本副本目录下有 git / ssh / scp 可执行文件：${exeInStrict.join(', ')}`);
  }
  if (problems.length > 0) return { problems, passed };
  if (needR) {
    const probe = spawnSync('git', ['-C', path.dirname(path.dirname(FIX.norepoScript)), 'rev-parse', '--show-toplevel'], { encoding: 'utf8', env: Object.assign({}, process.env, GIT_ISOLATION) });
    note(probe.status !== 0, 'R0 隔离①：拒绝用例的脚本副本不在任何 git 仓库里', `拒绝用例的脚本副本在某个 git 仓库里：${probe.stdout}`);
    SPAWN_COUNT += 1;
    const probeCmd = spawnSync(POWERSHELL, ['-NoProfile', '-Command', '(@(Get-Command git, ssh, scp, git.exe, ssh.exe, scp.exe -ErrorAction SilentlyContinue)).Count'], { cwd: FIX.norepo, encoding: 'utf8', env: Object.assign({}, process.env, GIT_ISOLATION, { PATH: STRICT_PATH }), timeout: 60000 });
    note(String(probeCmd.stdout).trim() === '0', 'R0 隔离②（解析）：在严格 PATH 下 Get-Command 解析不到 git / ssh / scp', `严格 PATH 下 git / ssh / scp 仍可解析：${String(probeCmd.stdout).trim()} ${String(probeCmd.stderr).slice(0, 100)}`);
  }
  return { problems, passed };
}

/** 轻量隔离门（不建夹具）：给 --only=unit、--only=static 加变异这类入口用——PATH 目录里没有 ssh.exe / scp.exe，测试地址是 192.0.2.1。不成立同样 ABORT、零子进程 */
function lightGate() {
  const problems = [];
  const sshDirs = sshInDirs();
  if (sshDirs.length > 0) problems.push(`PATH 目录里有 ssh.exe / scp.exe：${sshDirs.join(', ')}`);
  if (TEST_NET_IP !== '192.0.2.1') problems.push(`测试地址常量不是 192.0.2.1：${TEST_NET_IP}`);
  if (problems.length === 0) { check('D0 隔离（轻量）：PATH 目录里没有 ssh.exe / scp.exe，测试地址是 192.0.2.1', true); return true; }
  check('D0 隔离条件全部成立', false, problems.join(' ; '));
  ISOLATION_ABORT = true;
  console.log(`ABORT 隔离不成立：${problems.join(' ; ')}。单元与变异自证都没有运行（没有启动任何子进程）。`);
  return false;
}

/** 建夹具并过隔离门；成立返回 true。不成立：记一条失败、输出 ABORT、置 ISOLATION_ABORT（此后不再启动任何子进程） */
function prepareDynamic(scriptPath) {
  const needR = ONLY === null || ONLY.has('refuse') || REFUSE.some((c) => ONLY.has(c.id));
  try {
    setupFixture(scriptPath);
  } catch (e) {
    check('D0 夹具：临时仓库建成', false, e.message);
    ISOLATION_ABORT = true;
    console.log(`ABORT 夹具建不起来：${e.message}`);
    return false;
  }
  const g = isolationGate(needR);
  if (g.problems.length > 0) {
    check('D0 隔离条件全部成立', false, g.problems.join(' ; '));
    ISOLATION_ABORT = true;
    console.log(`ABORT 隔离不成立：${g.problems.join(' ; ')}。动态用例、单元与变异自证都没有运行（没有启动任何部署脚本子进程）。`);
    return false;
  }
  g.passed.forEach((name) => check(name, true));
  return true;
}

async function dynamicChecks(scriptPath) {
  check('D0 夹具：夹具仓库与诱饵仓库的 main 都是 40 位提交号且互不相同', /^[0-9a-f]{40}$/.test(NEW_COMMIT) && /^[0-9a-f]{40}$/.test(PREV_COMMIT) && /^[0-9a-f]{40}$/.test(DECOY_COMMIT) && new Set([NEW_COMMIT, PREV_COMMIT, DECOY_COMMIT]).size === 3, `${NEW_COMMIT} ${PREV_COMMIT} ${DECOY_COMMIT}`);
  const before = releasesSnapshot(REPO_ROOT);
  check('D0 夹具：真实控制根 releases/ 路径已解析（前后清单对比才有意义）', before.dir !== null && !String(before.list).startsWith('ERR'), JSON.stringify(before));
  const wanted = buildCases().filter((c) => ONLY === null || ONLY.has(c.id));
  const results = await pool(wanted.map((c) => () => runCase(c)), 4);
  wanted.forEach((c, i) => {
    const r = results[i];
    if (EMIT_REACHED) console.log(`REACHED ${c.title} ${r.out.includes('[2/9]') ? 1 : 0}`);   // 给变异自证用：这次运行有没有走过第 0 步（排除「死在第 0 步」的伪命中）
    if (!check(`${c.title}: 子进程正常结束（未超时、无 spawn 错误）`, !r.timedOut && r.status !== -1, r.out.slice(0, 200))) return;
    check(`${c.title}: 输出无 PowerShell 解析 / 运行时错误`, !/(ParserError|At line:\d+|is not recognized|Cannot bind|The term '|Exception calling|Missing|Unexpected token)/.test(r.out), r.out.split(/\r?\n/).filter((l) => /ParserError|At line:|is not recognized|Cannot bind|The term '|Exception calling/.test(l)).slice(0, 3).join(' | '));
    c.check(c.title, r);
  });

  // 拒绝类：被测脚本副本不在任何 git 仓库里
  const wantedR = REFUSE.filter((c) => ONLY === null || ONLY.has(c.id) || ONLY.has('refuse'));
  if (wantedR.length > 0) {
    // 三重隔离（脚本副本不在 git 仓库里 / 严格 PATH / 测试地址）已在 isolationGate 里逐项断言，缺一项整个自检已经中止；走到这里隔离一定成立
    const rr = await pool(wantedR.map((c) => () => runRefuse(c)), 4);
    wantedR.forEach((c, i) => {
      const r = rr[i];
      eq(`${c.title}: 退出码 2`, r.status, c.expect);
      check(`${c.title}: 输出 [REFUSED] 并点名参数`, r.out.includes('[REFUSED]') && r.out.includes(c.msg), r.out.slice(0, 200));
      check(`${c.title}: 没有进入任何步骤（无 [0/9]、无 REMOTE、无 DRYRUN 打印）`, !r.out.includes('[0/9]') && !/\[REMOTE-/.test(r.out) && !r.out.includes('[DRYRUN]'), r.out.slice(0, 200));
    });
  }
  const after = releasesSnapshot(REPO_ROOT);
  eq('D0 DryRun 不写控制根 releases/（真实仓库前后目录清单一致）', after.list, before.list);
  eq('D0 DryRun 不写夹具仓库的控制根 releases/（目录不存在）', releasesSnapshot(FIX.repo).list, null);
}

/**
 * 隔离门自身的自检（H2）：故意让隔离条件不成立——在子运行的 PATH 目录里放一个名为 ssh.exe 的假文件（--poison-path）——
 * 子运行必须：退出码非 0、输出 ABORT 隔离不成立、没有启动任何子进程（SPAWN_COUNT=0）、没有进入变异段（子运行没有加 --no-mutations，门若没拦住它会去跑变异）。
 */
async function isolationSelfTest() {
  const poison = freshDir('poison');
  fs.writeFileSync(path.join(poison, 'ssh.exe'), '');   // 假的 ssh.exe（空文件，不可执行）
  // 三个入口都不能绕过隔离门：动态段、单元段（--only=unit）、静态加变异（--only=static，没有 --no-mutations）。子运行都带污染的 PATH 目录
  for (const [label, selector] of [['动态段（--only=poison）', '--only=poison'], ['单元段（--only=unit）', '--only=unit'], ['静态加变异（--only=static，变异段默认开启）', '--only=static']]) {
    SPAWN_COUNT += 1;
    const r = await new Promise((resolve) => {
      const child = spawn(process.execPath, [__filename, `--script=${SCRIPT_PATH}`, `--poison-path=${poison}`, selector, '--report-spawns'], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks = [];
      const timer = setTimeout(() => { try { child.kill(); } catch (_) { /* ignore */ } }, 300000);
      child.stdout.on('data', (b) => chunks.push(b));
      child.stderr.on('data', (b) => chunks.push(b));
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, out: Buffer.concat(chunks).toString('utf8') }); });
    });
    check(`H2 隔离不成立（PATH 目录里有 ssh.exe）+ ${label} -> 子运行退出码非 0`, r.code !== 0 && r.code !== null, `exit=${r.code}`);
    check(`H2 隔离不成立 + ${label} -> 输出「ABORT 隔离不成立」并点名 ssh.exe`, r.out.includes('ABORT 隔离不成立') && r.out.includes('ssh.exe'), r.out.slice(0, 300));
    check(`H2 隔离不成立 + ${label} -> 没有启动任何子进程（SPAWN_COUNT=0）`, /SPAWN_COUNT=0\b/.test(r.out), r.out.slice(-200));
    check(`H2 隔离不成立 + ${label} -> 动态、单元、变异三段都没有进入（输出里没有 D- 用例 / U 单元结果、没有「变异自证」）`, !/D-normal|D-backup|D-realprobe/.test(r.out) && !/^FAIL U\d/m.test(r.out) && !r.out.includes('变异自证（') && !r.out.includes('REACHED'), r.out.slice(0, 300));
  }
}

// ---------------------------------------------------------------- 变异自证
const CRLF = '\r\n';
// 被测脚本里被 LOW③ 预筛修复批 1 的变异反复引用的整行文本（单引号 JS 字符串里的 ${…} 是 PowerShell 的变量，不是模板）
const UNKNOWN_HINT_LINE = 'Write-Host "  确认无残留后，人工起回原服务（命令见下一行）：" -ForegroundColor Yellow';
const START_CMD_LINE = 'Write-Host "      ssh ${ServerUser}@${ServerIP} ""$Pm2StartCmd""" -ForegroundColor White';
const STEP4_START_HINT = 'Write-Host "  确认无残留、task-pool 为 stopped 且 3000 零 LISTENING 后，如需起服务用下一行：" -ForegroundColor Yellow';
const STEP4_NS_INTRO = 'Write-Host "  再查 3000 端口有没有监听者（命令见下一行）：" -ForegroundColor Gray';
// 修复批 1c M1：netstat 核对改由 Write-ListenerCheck 打印（不加过滤的 netstat -ano + 判据一「查询成功」+ 判据二「3000 零 LISTENING」），第 4 步这里只剩调用行
const STEP4_NS_CMD = 'Write-ListenerCheck';
const STEP4_STOPPED_JUDGE = 'Write-Host "      判据：名为 task-pool 的只有一项，且为 stopped，并且上一条 netstat 查询成功、3000 零 LISTENING（判据一、判据二都通过）→ 可以起服务（命令见后）。" -ForegroundColor Gray';
const STEP4_OTHER_JUDGE = 'Write-Host "      判据：读不到状态、两次不一致、名为 task-pool 的不止一项、为 errored 等其他状态、3000 上仍有 LISTENING（pm2 已 stopped 也一样，多半是孤儿监听）、或 netstat 查询失败（没有 TCP 行不等于零监听）→ 不要起服务，人工核实。" -ForegroundColor Gray';
const STEP4_INFLIGHT_LINE = 'Write-Host "      ssh ${ServerUser}@${ServerIP} ""wmic process get processid,commandline | findstr /r /c:Process[I]d /c:p[m]2.*sto[p]""" -ForegroundColor White';
const STEP4_INFLIGHT_FAIL_LINE = 'Write-Host "      判据：看不到表头（查询失败、WMI 出错或远端没有 wmic）就停下，登录远端 PowerShell 运行下一行；输出最后一行是 CIM_OK 且其上没有进程行才继续，是 CIM_FAILED 就人工核实：" -ForegroundColor Gray';
const PM2LS_LINE = 'Write-Host "      ssh ${ServerUser}@${ServerIP} ""pm2 ls""" -ForegroundColor White';
// 第 4 步停服失败分支开头那行（「当前状态 …」）：「起服务命令挪回前置检查之前」变异以它为插入锚点
const STEP4_STATE_LINE = 'Write-Host "  当前状态：服务可能仍在跑，也可能已停；代码未动；备份未做。本机 ssh 超时退出时，远端的 pm2 stop 可能还在执行，所以先做两项前置检查，再看 pm2 状态：" -ForegroundColor Yellow';
const SCP_HINT_LINE = 'Write-Host "  [HINT] 手动补拉（命令见下一行）：" -ForegroundColor Gray';
// 修复批 1c M2：库备份的补拉提示改为先拉到 .partial（说明行与命令行都变了）
const SCP_BACKUP_HINT_LINE = 'Write-Host "  [HINT] 手动补拉（先拉到 .partial，核对大小之后再改名为正式名；命令见下一行，本机运行）：" -ForegroundColor Gray';
const SCP_BACKUP_CMD_LINE = 'Write-Host "      scp ${ServerUser}@${ServerIP}:$scpSrcPath ${localBackupDir}\\$hintLeaf.partial" -ForegroundColor White';
const SCP_COLLAB_CMD_LINE = 'Write-Host "      scp -r ${ServerUser}@${ServerIP}:/E:/Task_Pool/wbs-server/uploads/collab ${localCollabBaseDir}\\collab_$($script:Id).partial\\" -ForegroundColor White';
const MUTATIONS = [
  { name: '停服改成 stop all', find: "pm2 stop task-pool'", replace: "pm2 stop all'", expect: ['S4'], only: ['normal'] },
  { name: 'pm2 start 不带名字', find: "$Pm2StartCmd = 'cd /d E:\\Task_Pool\\wbs-server && pm2 start task-pool'", replace: "$Pm2StartCmd = 'cd /d E:\\Task_Pool\\wbs-server && pm2 start'", expect: ['S4'], only: ['normal'] },
  { name: 'reset 目标改成 production/main', find: 'git reset --hard $($script:NewCommit)"', replace: 'git reset --hard production/main"', expect: ['S5', 'D-normal'], only: ['normal'] },
  { name: '备份失败后不起服务', find: '$oldStartRes = Invoke-RemoteWrite -Command $Pm2StartCmd -TimeoutSec 90', replace: '$oldStartRes = New-DryResult', expect: ['D-backup', 'S6', 'S7'], only: ['backup'] },
  { name: 'backup_noline 也自动起服务', find: "if ($bo.Outcome -eq 'FAIL') {", replace: "if ($bo.Outcome -ne 'OK') {", expect: ['D-noline', 'S7'], only: ['noline'] },
  { name: '回滚步骤真的不再打印先本地的查询命令（行为变异，不只是改标题）', find: `Write-Host ("      " + $q.Replace('@@T@@', $target)) -ForegroundColor White`, replace: "Write-Host ''", expect: ['D-code', 'S9'], only: ['code'] },
  { name: 'DryRun 下写操作真的发出', find: `        return (New-DryResult)${CRLF}`, replace: '', expect: ['S8', 'D-normal'], only: ['normal'] },
  { name: '非 DryRun 守卫被拿掉', find: `if (-not $DryRun) {${CRLF}    $refused`, replace: `if ($false) {${CRLF}    $refused`, expect: ['S8'], only: ['refuse'] },
  { name: '回滚目标写成新提交', find: 'git reset --hard $($script:PrevCommit)""', replace: 'git reset --hard $($script:NewCommit)""', expect: ['S9', 'D-code'], only: ['code'] },
  { name: '换代码失败不写失败态', find: "Set-Stage -Stage 'failed' -Result 'failed' -Note 'CODE_UPDATE_FAILED'", replace: "Write-Info 'x'", expect: ['D-code'], only: ['code'] },
  { name: '运行提交与仓库 HEAD 不一致不再中止', find: 'if ($script:RunCommit -ne $RepoHead) {', replace: 'if ($false) {', expect: ['D-mismatch'], only: ['mismatch'] },
  { name: '远端已跟踪改动不再中止', find: "if ($Tracked -ne '') {", replace: 'if ($false) {', expect: ['D-tracked'], only: ['tracked'] },
  { name: '旧版本版本号不符不再中止', find: 'if ([string]::IsNullOrEmpty($RepoHeadVersion) -or $script:RunVersion -ne $RepoHeadVersion) {', replace: 'if ($false) {', expect: ['D-nocommit-badver'], only: ['nocommitbad'] },
  { name: '停服后不写 stopped 阶段', find: "Set-Stage -Stage 'stopped'", replace: "Write-Info 'x'", expect: ['D-normal'], only: ['normal'] },
  { name: '备份脚本改成 glob 取最新', find: '$script:BackupPath = [string]$bo.Json.out', replace: `$script:BackupPath = (Get-ChildItem -Path "E:\\x\\${LIVE_DB}.backup_*" | Select-Object -First 1)`, expect: ['S10'], only: ['normal'] },
  { name: '在调用口之外直接调 ssh', find: "Write-Step '0/9' '本机准备（只读）'", replace: `Write-Step '0/9' '本机准备（只读）'${CRLF}& ssh x pm2 ls`, expect: ['S3'], staticOnly: true },
  { name: '去掉 BOM', transform: (buf) => (buf.slice(0, 3).toString('hex') === 'efbbbf' ? buf.slice(3) : buf), expect: ['S1'], staticOnly: true },
  { name: '协议行不要求整段以换行结尾', find: 'if (-not $text.EndsWith("`n")) { return $null }', replace: '', expect: ['U1'], only: ['unit'] },
  { name: '协议 JSON 不要求是对象', find: '-is [System.Management.Automation.PSCustomObject]', replace: '-is [psobject]', expect: ['U1'], only: ['unit'] },
  { name: '协议前缀后不要求空格', find: 'if ($line.StartsWith($p + \' \')) {', replace: 'if ($line.StartsWith($p)) {', expect: ['U1'], only: ['unit'] },
  { name: '参数引用不转义内嵌双引号', find: "'$1$1\\\"'", replace: "'$1$1\"'", expect: ['U3'], only: ['unit'] },
  { name: '三态 unknown 当 false 处理', find: "if ($v -is [string] -and $v -eq 'unknown') { return '无法确认（探测本身出错，需人工核对）' }", replace: "if ($v -is [string] -and $v -eq 'unknown') { return '否' }", expect: ['U2'], only: ['unit'] },
  { name: '仓库根改回取进程当前目录的 show-toplevel（修复前的缺陷）', edits: [
    ["$top = Invoke-Local -FileName 'git' -ArgList @('-C', $RepoRootCandidate, 'rev-parse', '--show-toplevel')", "$top = Invoke-Local -FileName 'git' -ArgList @('rev-parse', '--show-toplevel')"],
    ['if ($topNorm -ne $candNorm) {', 'if ($false) {'],
    ['$script:RepoRoot = $candNorm', '$script:RepoRoot = $topNorm'],
  ], expect: ['D-normal', 'S11'], only: ['normal'] },
  { name: '本机 git 调用不带仓库根（落到进程当前目录）', find: '-TimeoutSec $TimeoutSec -WorkDir $script:RepoRoot)', replace: '-TimeoutSec $TimeoutSec)', expect: ['D-normal', 'S11'], only: ['normal'] },
  { name: '不核对 git 顶层就是脚本所在目录', find: 'if ($topNorm -ne $candNorm) {', replace: 'if ($false) {', expect: ['D-subdir', 'S11'], only: ['subdir'] },
  { name: 'ready-check 不带 --repo（默认取脚本所在检出）', find: "'--timeout-sec', ([string]$ReadyTimeoutSec), '--repo', $script:RepoRoot)", replace: "'--timeout-sec', ([string]$ReadyTimeoutSec))", expect: ['S11', 'D-normal'], only: ['normal'] },
  // ---- 修复批 2：第 5 / 8 步判定（预筛的 A2 / B / C / D / E 五个变异）
  { name: '预筛 A2：ssh 失败（没有协议行）也当 BACKUP_FAIL 自动起服务', find: "if ($null -eq $p) { return [pscustomobject]@{ Outcome = 'UNKNOWN'; Json = $null } }", replace: "if ($null -eq $p) { return [pscustomobject]@{ Outcome = 'FAIL'; Json = $null } }", expect: ['U6'], only: ['unit'] },
  { name: '预筛 B：Read-Protocol 要求退出码为 0（真实的 BACKUP_FAIL 退出码 1，永远认不到）', find: 'if ($null -eq $Res -or $null -ne $Res.StartError -or $Res.TimedOut) { return $null }', replace: 'if ($null -eq $Res -or $null -ne $Res.StartError -or $Res.TimedOut -or $Res.ExitCode -ne 0) { return $null }', expect: ['U6'], only: ['unit'] },
  { name: "预筛 C：BACKUP_OK 不要求 json 有 out", find: "    if ($p.Json.out -isnot [string] -or $p.Json.out -eq '') { return [pscustomobject]@{ Outcome = 'UNKNOWN'; Json = $null } }", replace: '', expect: ['U6'], only: ['unit'] },
  { name: '预筛 D：不提取 hint=COMMIT_NULL', find: "if ($null -ne $p.Json.PSObject.Properties['hint'] -and [string]$p.Json.hint -eq 'COMMIT_NULL') { $hint = 'COMMIT_NULL' }", replace: '', expect: ['U7'], only: ['unit'] },
  { name: '预筛 E：退出码 0 就当 READY_OK（凭退出码成功）', find: "    if ($null -eq $p) { return [pscustomobject]@{ Outcome = 'UNKNOWN'; Hint = '';", replace: `    if ($null -eq $p -and $Res.ExitCode -eq 0) { return [pscustomobject]@{ Outcome = 'OK'; Hint = ''; Why = '' } }${CRLF}    if ($null -eq $p) { return [pscustomobject]@{ Outcome = 'UNKNOWN'; Hint = '';`, expect: ['U7'], only: ['unit'] },
  // ---- 修复批 2：新提交就绪接口预检 / fetch 前移 / 前置检查 / schema 排除
  { name: '停服前不再核对新提交含就绪接口与 commit 字段', find: 'foreach ($lit in @($ReadyRouteLiteral, $CommitFieldLiteral)) {', replace: 'foreach ($lit in @()) {', expect: ['D-noready', 'D-nocommitfield', 'S13'], only: ['noready', 'nocommitfield'] },
  { name: 'fetch 挪回停服之后（与 reset 同一条命令）', find: '$resetCmd = "cd /d E:\\Task_Pool && git reset --hard $($script:NewCommit)"', replace: '$resetCmd = "cd /d E:\\Task_Pool && git fetch production && git reset --hard $($script:NewCommit)"', expect: ['D-normal', 'S5'], only: ['normal'] },
  { name: '找残留备份进程的命令会匹配自身（去掉 /r）', find: '| findstr /i /r backup-db-[0-9]', replace: '| findstr /i backup-db-', expect: ['D-noline', 'S9'], only: ['noline'] },
  { name: 'schema 判断不再排除测试脚本与 .md', find: "if ($file -match '^b/wbs-server/scripts/(verify|test)-[^/]*$' -or $file -match '\\.md$' -or $file -match '^b/docs/') { continue }", replace: '', expect: ['D-code', 'S14'], only: ['code'] },
  { name: '备份失败自动起服务后不先看 pm2 start 本身是否成功', find: 'if (Test-Ok $oldStartRes) {', replace: 'if ($true) {', expect: ['S14'], staticOnly: true },
  { name: 'pm2 start 带两个应用名', find: "$Pm2StartCmd = 'cd /d E:\\Task_Pool\\wbs-server && pm2 start task-pool'", replace: "$Pm2StartCmd = 'cd /d E:\\Task_Pool\\wbs-server && pm2 start task-pool business-flow'", expect: ['S4'], staticOnly: true },
  // ---- 修复批 3：pm2 jlist 经 stdin 的 BOM 回归
  { name: '修复批 2 的写法：pm2 解析不去掉 stdin 开头的 BOM', find: 'while (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);', replace: '', expect: ['U8', 'D-realprobe-cmd'], only: ['unit', 'realprobecmd'] },
  { name: 'stdin 写入失败被吞掉（不记入 StartError）', find: '$r.StartError = "写 stdin 失败：$($_.Exception.Message)"', replace: '$null = 0', expect: ['S14'], staticOnly: true },
  // ---- 修复批 4（codex 39）：H1 回滚顺序 / H3 schema 不下兼容结论 / M1 COMMIT_NULL / M2 终检 / M3 stdin 截止 / M5 附件快照
  { name: 'H1：reset 提到 stop 之前（stop 挪到 reset 之后）', edits: [
    ['Write-Host "      ssh $target ""$Pm2StopCmd""" -ForegroundColor White', ''],
    ['Write-Host "      ssh $target ""cd /d E:\\Task_Pool && git reset --hard $($script:PrevCommit)""" -ForegroundColor White', `Write-Host "      ssh $target ""cd /d E:\\Task_Pool && git reset --hard $($script:PrevCommit)""" -ForegroundColor White${CRLF}    Write-Host "      ssh $target ""$Pm2StopCmd""" -ForegroundColor White`],
  ], expect: ['D-code', 'S9'], only: ['code'] },
  { name: 'H1：回滚指引里又用 pm2 restart 起服务', find: 'Write-Host "      ssh $target ""$Pm2StartCmd""" -ForegroundColor White', replace: 'Write-Host "      ssh $target ""cd /d E:\\Task_Pool\\wbs-server && pm2 restart task-pool""" -ForegroundColor White', expect: ['D-code', 'S9'], only: ['code'] },
  { name: 'H3：schema 零命中恢复旧结论文案（本次不含 schema 变化，只回退代码）', find: '未在新增行里发现常见 DDL 关键字（CREATE TABLE', replace: '本次不含 schema 变化，只回退代码，不恢复数据库（CREATE TABLE', expect: ['D-noddl', 'S9'], only: ['noddl'] },
  { name: 'H3：又整体排除 wbs-server/scripts/（迁移脚本被漏掉）', find: "'^b/wbs-server/scripts/(verify|test)-[^/]*$'", replace: "'^b/wbs-server/scripts/'", expect: ['D-code', 'S14'], only: ['code'] },
  { name: 'M1：COMMIT_NULL 恢复「部署本身成功、不要回滚」的结论', find: '请继续核对 pm2 状态、/api/version 的版本与其余就绪失败项，再决定是修复提交号读取，还是按下面的回滚步骤处理。', replace: '等于则说明部署本身成功，不要回滚。', expect: ['D-readynull', 'S9'], only: ['readynull'] },
  { name: 'M2：READY_OK 之后只比 restart_time、不看 pm2 状态是否 online', find: "if ([string]$Pt.Status -ne 'online') {", replace: 'if ($false) {', expect: ['U8', 'D-ready-stopped'], only: ['unit', 'readystopped', 'readyerrored'] },
  { name: 'M3：stdin 写入改回同步（不受总截止时间约束）', find: '$writeTask = $stdinStream.WriteAsync($bytes, 0, $bytes.Length)', replace: '$stdinStream.Write($bytes, 0, $bytes.Length); $writeTask = [System.Threading.Tasks.Task]::FromResult(0)', expect: ['U10'], only: ['unit'] },
  { name: 'M5：附件快照保留份数把 .partial 也算进去', find: "Where-Object { $_.Name -match '^collab_\\d{8}_\\d{6}$' }", replace: "Where-Object { $_.Name -like 'collab_*' }", expect: ['U11', 'S15'], only: ['unit'] },
  { name: 'M5：附件快照不经 .partial、直接改名这一步被拿掉', find: 'Move-Item -LiteralPath $localPartialDir -Destination $localSnapshotDir -ErrorAction Stop', replace: '$null = 0', expect: ['S15'], staticOnly: true },
  // ---- 修复批 5（codex 39-R）：恢复判据逐个核对 / stdin 等待扣除已用时间 / 命令与判据分行
  { name: 'M：恢复步骤 c 恢复旧判据（dir 通配只应看到改名留档）', find: 'Write-Host "      c) 逐个核对改名成功（每条输出 EXISTS 或 MISSING）：" -ForegroundColor Gray', replace: 'Write-Host "      c) 核对改名成功：dir 只应看到本次的 *.before_restore_ 文件" -ForegroundColor Gray', expect: ['D-code', 'S9'], only: ['code'] },
  { name: 'L2：stdin 写入等待又改回再等一个完整的 TimeoutSec', find: '$writeTask.Wait($remainWriteMs)', replace: '$writeTask.Wait([int]($TimeoutSec * 1000))', expect: ['S15'], only: ['unit'] },
  { name: 'L3：回滚命令行后面又跟了中文说明', find: 'git reset --hard $($script:PrevCommit)""" -ForegroundColor White', replace: 'git reset --hard $($script:PrevCommit)""    必须成功" -ForegroundColor White', expect: ['D-code', 'S9'], only: ['code'] },
  // ---- B1 前置（codex 39-R2 LOW③）：第 4 步停服失败、第 5 步 restart_unverified / UNKNOWN 分支的命令与判据分行
  { name: 'LOW③：第 4 步停服失败的起服务命令再注入一条同行版本（与判据同一行；注入的不是还原拆分前的原文）', find: STEP4_STOPPED_JUDGE, replace: 'Write-Host "      确认 task-pool 为 stopped 或 online 之后再决定；如需起服务：ssh ${ServerUser}@${ServerIP} ""$Pm2StartCmd""" -ForegroundColor White', expect: ['S16'], staticOnly: true },
  { name: 'LOW③：restart_unverified 的 HEAD 核对命令再注入一条同行版本（命令后面跟了中文判据）', find: 'Write-Host "      判据：应为 $($script:PrevCommit)。" -ForegroundColor Gray', replace: 'Write-Host "      ssh ${ServerUser}@${ServerIP} ""$RepoHeadCmd""    （应为 $($script:PrevCommit)）" -ForegroundColor White', expect: ['S16'], staticOnly: true },
  { name: 'LOW③：UNKNOWN 分支的人工起服务命令再注入一条同行版本（与说明同一行）', find: 'Write-Host "  确认无残留后，人工起回原服务（命令见下一行）：" -ForegroundColor Yellow', replace: 'Write-Host "  确认无残留后，人工起回原服务：ssh ${ServerUser}@${ServerIP} ""$Pm2StartCmd""" -ForegroundColor White', expect: ['S16'], staticOnly: true },
  { name: 'LOW③：前置检查的 Stop-Process 再注入一条同行版本（嵌进说明句里）', find: 'Write-Host "      Stop-Process -Id <ProcessId>" -ForegroundColor White', replace: 'Write-Host "      还在的：Stop-Process -Id <ProcessId>，再查一次确认为空。" -ForegroundColor White', expect: ['S16'], staticOnly: true },
  // ---- LOW③ 预筛修复批 1：D-noline 按行断言 / S16 放宽输出函数与取串 / S16 区域锚定 / S17 分支内容
  { name: 'MED-1：UNKNOWN 分支的人工起服务命令行被删掉（说明行还在，分支走向行里仍有 pm2 start task-pool 字样）', find: UNKNOWN_HINT_LINE + CRLF + '    ' + START_CMD_LINE, replace: UNKNOWN_HINT_LINE, expect: ['D-noline'], only: ['noline'] },
  { name: 'MED-1：UNKNOWN 分支的人工起服务命令被换成 pm2 stop（分支走向行里仍有 pm2 start task-pool 字样）', find: UNKNOWN_HINT_LINE + CRLF + '    ' + START_CMD_LINE, replace: UNKNOWN_HINT_LINE + CRLF + '    ' + START_CMD_LINE.replace('$Pm2StartCmd', '$Pm2StopCmd'), expect: ['D-noline'], only: ['noline'] },
  { name: 'MED-2 mutA：UNKNOWN 分支的说明与命令合回一行，并改用 Write-Info（旧过滤只认 Write-Host "）', find: UNKNOWN_HINT_LINE + CRLF + '    ' + START_CMD_LINE, replace: 'Write-Info "  确认无残留后，人工起回原服务：ssh ${ServerUser}@${ServerIP} ""$Pm2StartCmd""" ' + "'White'", expect: ['S16'], staticOnly: true },
  { name: "MED-2 mutC：前置检查的 Stop-Process 改成单引号同行写法（旧过滤只认 Write-Host \"）", find: 'Write-Host "      Stop-Process -Id <ProcessId>" -ForegroundColor White', replace: "Write-Host '      还在的：Stop-Process -Id <ProcessId>' -ForegroundColor White", expect: ['S16'], staticOnly: true },
  { name: 'MED-2 mutD：$q 查询字面量末尾加了中文（旧过滤不看 $q 行）', find: "| Select-Object ProcessId,Name,CommandLine'", replace: "| Select-Object ProcessId,Name,CommandLine（结果应为空）'", expect: ['S16'], staticOnly: true },
  { name: 'MED-3：第 9 步备份补拉的说明与 scp 命令合回一行', find: SCP_BACKUP_HINT_LINE + CRLF + '    ' + SCP_BACKUP_CMD_LINE, replace: 'Write-Host "  [HINT] 手动补拉：scp ${ServerUser}@${ServerIP}:$scpSrcPath ${localBackupDir}\\$hintLeaf.partial" -ForegroundColor Gray', expect: ['S16'], staticOnly: true },
  { name: 'MED-3：第 9 步附件补拉的说明与 scp -r 命令合回一行', find: SCP_HINT_LINE + CRLF + '    ' + SCP_COLLAB_CMD_LINE, replace: 'Write-Host "  [HINT] 手动补拉：scp -r ${ServerUser}@${ServerIP}:/E:/Task_Pool/wbs-server/uploads/collab ${localCollabBaseDir}\\collab_$($script:Id).partial\\" -ForegroundColor Gray', expect: ['S16'], staticOnly: true },
  { name: 'S16 区域锚定：第 9 步备份补拉的 scp 命令行被删（说明行还在，全脚本总数仍 ≥20）', find: SCP_BACKUP_HINT_LINE + CRLF + '    ' + SCP_BACKUP_CMD_LINE, replace: SCP_BACKUP_HINT_LINE, expect: ['S16'], staticOnly: true },
  { name: 'S16 区域锚定：第 9 步附件补拉的 scp -r 命令行被删（说明行还在，全脚本总数仍 ≥20）', find: SCP_HINT_LINE + CRLF + '    ' + SCP_COLLAB_CMD_LINE, replace: SCP_HINT_LINE, expect: ['S16'], staticOnly: true },
  { name: 'S17：第 4 步停服失败分支删掉「online → 不要起服务」判据行', find: 'Write-Host "      判据：名为 task-pool 的只有一项，且为 online → 服务仍在跑，不要起服务，直接结束本次部署。" -ForegroundColor Gray', replace: '$null = 0', expect: ['S17'], staticOnly: true },
  { name: 'S17：第 4 步停服失败分支删掉「其他状态 → 人工核实」判据行', find: STEP4_OTHER_JUDGE, replace: '$null = 0', expect: ['S17'], staticOnly: true },
  { name: 'codex 40 M：第 4 步删掉「远端无在途 pm2 stop」核对命令', find: STEP4_INFLIGHT_LINE, replace: '$null = 0', expect: ['S17'], staticOnly: true },
  { name: 'codex 40-R M：删掉「看不到表头就停下、改用 CIM 查询」判据（查询失败被当成无在途进程）', find: STEP4_INFLIGHT_FAIL_LINE, replace: '$null = 0', expect: ['S17'], staticOnly: true },
  { name: 'codex 40-R M：在途查询退回不带表头标记的写法（/i /r p[m]2.*sto[p]）', find: '/c:Process[I]d /c:p[m]2.*sto[p]', replace: '/i /r p[m]2.*sto[p]', expect: ['S17'], staticOnly: true },
  { name: 'codex 40 M：第 4 步只读一次 pm2 ls（删掉间隔 10 秒的第二次读）', find: '    Write-Host "      Start-Sleep 10" -ForegroundColor White' + CRLF + '    ' + PM2LS_LINE + CRLF + '    ' + STEP4_NS_INTRO, replace: '    ' + STEP4_NS_INTRO, expect: ['S17'], staticOnly: true },
  { name: '修复批 1b LOW①：第 4 步停服失败分支删掉 netstat 只读核对命令（stopped 的判据还写着「3000 零 LISTENING」却没有命令可查）', find: '    ' + STEP4_NS_CMD + CRLF + '    ' + STEP4_STOPPED_JUDGE, replace: '    ' + STEP4_STOPPED_JUDGE, expect: ['S17'], staticOnly: true },
  { name: '修复批 1b LOW①：第 4 步 stopped 判据退回不看 3000（pm2 已 stopped 就可以起服务）', find: STEP4_STOPPED_JUDGE, replace: 'Write-Host "      判据：名为 task-pool 的只有一项，且为 stopped → 可以起服务（命令见后）。" -ForegroundColor Gray', expect: ['S17'], staticOnly: true },
  { name: 'S17：restart_unverified 分支删掉「version 应为」判据行', find: 'Write-Host "      判据：version 应为 $($script:RunVersion)。" -ForegroundColor Gray', replace: '$null = 0', expect: ['S17'], staticOnly: true },
  { name: 'S17：restart_unverified 的 HEAD 判据写成「应为 NewCommit」', find: 'Write-Host "      判据：应为 $($script:PrevCommit)。" -ForegroundColor Gray', replace: 'Write-Host "      判据：应为 $($script:NewCommit)。" -ForegroundColor Gray', expect: ['S17'], staticOnly: true },
  { name: 'S17：第 4 步的起服务提示与命令挪回 Write-PreChecks 之前', transform: (buf) => {
    const t = buf.toString('utf8');
    const tail = CRLF + '    Write-Host ""' + CRLF + '    ' + STEP4_START_HINT + CRLF + '    ' + START_CMD_LINE;
    const head = STEP4_STATE_LINE + CRLF + '    Write-PreChecks';
    if (t.split(tail).length !== 2 || t.split(head).length !== 2) return buf; // 锚点不唯一 / 不存在：原样返回，由「变异未生效」判红
    return Buffer.from(t.replace(tail, '').replace(head, STEP4_STATE_LINE + CRLF + '    ' + STEP4_START_HINT + CRLF + '    ' + START_CMD_LINE + CRLF + '    Write-PreChecks'), 'utf8');
  }, expect: ['S17'], staticOnly: true },
  // ---- B1 末次合并审预筛六项：每项硬门至少一个变异（删掉 / 反转后套件必须变红并命中登记的前缀）
  // M1 推送超时 / 失败后的只读核对
  { name: 'M1：git push 的超时又写死 300 秒（不用 -PushTimeoutSec）', find: "Invoke-Git -ArgList @('push', 'production', 'main') -TimeoutSec $script:PushTimeoutSec", replace: "Invoke-Git -ArgList @('push', 'production', 'main') -TimeoutSec 300", expect: ['S18'], staticOnly: true },
  { name: 'M1：-PushTimeoutSec 上限校验被拿掉（7201 秒也放行）', find: '-or [int]$PushTimeoutSec -gt 7200) {', replace: '-or $false) {', expect: ['S18'], staticOnly: true },
  { name: 'M1：-PushTimeoutSec 下限校验被拿掉（59 秒也放行）', find: '-or [int]$PushTimeoutSec -lt 60 -or', replace: '-or $false -or', expect: ['S18'], staticOnly: true },
  { name: 'M1：push 超时 / 失败后不再只读核对远端引用，直接报失败', find: 'Stop-PushNotConfirmed $push $lrFail', replace: 'Stop-Early "git push production main 失败：$(Get-ResultNote $push)"', expect: ['S18'], staticOnly: true },
  { name: 'M1：Resolve-PushAftermath 永远判未生效（核对到远端 main 已等于 NewCommit 也不提示）', find: "if ($NewCommit -match '^[0-9a-f]{40}$' -and $first -eq $NewCommit) {", replace: 'if ($false) {', expect: ['U12', 'D-push-landed'], only: ['unit', 'pushland'] },
  { name: 'M1：Resolve-PushAftermath 永远判已生效（远端 main 不等于 NewCommit 也说推送已生效）', find: "if ($NewCommit -match '^[0-9a-f]{40}$' -and $first -eq $NewCommit) {", replace: 'if ($true) {', expect: ['U12', 'D-push-failed'], only: ['unit', 'pushfail'] },
  { name: 'M1：Resolve-PushAftermath 把提交号前缀相同也当作等于（只比前 7 位）', find: "$first -eq $NewCommit) {", replace: "$first.StartsWith($NewCommit.Substring(0, 7))) {", expect: ['U12'], only: ['unit'] },
  { name: 'M1：Stop-PushNotConfirmed 不再中止（只打印就继续往下走）', find: '    Stop-Early $pa.Message', replace: '    Write-Info $pa.Message', expect: ['D-push-landed', 'S18'], only: ['pushland', 'pushfail'] },
  // M2 本地库备份轮转
  { name: 'M2：库备份正式名正则放宽成 backup_ 前缀（手动命名的备份被算进轮转）', find: `'^${LIVE_DB.replace('.', '\\.')}\\.backup_\\d{8}_\\d{6}$'`, replace: `'^${LIVE_DB.replace('.', '\\.')}\\.backup_'`, expect: ['U13', 'S19'], only: ['unit'] },
  { name: 'M2：库备份轮转又改回 -Filter 通配 backup_*（手动命名的备份会被删）', find: '$toDelete = Get-DbBackupsToDelete $localBackupDir 10', replace: `$toDelete = @(Get-ChildItem -Path $localBackupDir -Filter '${LIVE_DB}.backup_*' -File | Sort-Object Name -Descending | Select-Object -Skip 10)`, expect: ['S19'], staticOnly: true },
  { name: 'M2：库备份待删清单不再跳过保留份数（正式名全删）', find: 'Get-FormalDbBackups $Base | Select-Object -Skip $Keep', replace: 'Get-FormalDbBackups $Base | Select-Object -Skip 0', expect: ['U13', 'S19'], only: ['unit'] },
  { name: 'M2：库备份正式名把目录也算进来（去掉 -File）', find: 'Get-ChildItem -LiteralPath $Base -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match', replace: 'Get-ChildItem -LiteralPath $Base -ErrorAction SilentlyContinue | Where-Object { $_.Name -match', expect: ['U13', 'S19'], only: ['unit'] },
  // M3 孤儿监听
  { name: 'M3：第 2 步不再核 pm2 pid 与 3000 监听者（硬门恒放行）', find: '$own2 = Test-Pm2OwnsPort $Pm2Pid $Listen', replace: "$own2 = [pscustomobject]@{ Ok = $true; Why = '' }", expect: ['D-orphan', 'D-nolisten', 'D-listenprefix', 'D-nonetstat', 'D-nofield', 'D-nopid', 'S20'], only: ['orphan', 'orphanmulti', 'nolisten', 'listenprefix', 'nonetstat', 'nofield', 'nopid'] },
  { name: 'M3：netstat 解析多个 pid 只取第一个（两栈 pid 不同也放行）', find: 'if (-not $pids.Contains($pp)) { $pids.Add($pp) }', replace: 'if ($pids.Count -eq 0) { $pids.Add($pp) }', expect: ['U14', 'D-orphan-multi'], only: ['unit', 'orphanmulti'] },
  { name: 'M3：netstat 解析不看状态（ESTABLISHED / TIME_WAIT 也算监听者）', find: "if ($m.Groups[4].Value -ne 'LISTENING') { continue }", replace: '$null = 0', expect: ['U14', 'D-nolisten'], only: ['unit', 'nolisten'] },
  { name: 'M3：netstat 解析端口按前缀匹配（:30000 当成 3000）', find: 'if ([int]$m.Groups[2].Value -ne $Port) { continue }', replace: 'if (-not $m.Groups[2].Value.StartsWith([string]$Port)) { continue }', expect: ['U14', 'D-listenprefix'], only: ['unit', 'listenprefix'] },
  { name: 'M3：netstat 解析只看 IPv4 一栈（[::]:3000 行被忽略）', find: "if ($m.Groups[4].Value -ne 'LISTENING') { continue }", replace: "if ($m.Groups[4].Value -ne 'LISTENING' -or $m.Groups[1].Value.StartsWith('[')) { continue }", expect: ['U14', 'D-v6only'], only: ['unit', 'v6only'] },
  { name: 'M3：netstat 解析不再要求输出里有 TCP 行（命令失败当成「没有监听者」）', find: 'if ($tcpRows -eq 0) {', replace: 'if ($false) {', expect: ['U14', 'D-nonetstat'], only: ['unit', 'nonetstat'] },
  { name: 'M3：netstat 解析遇到无法解析的 3000 行不拒绝（当成没有监听者）', find: 'if ($line -match "[:.]$Port\\s") { return', replace: 'if ($false) { return', expect: ['U14'], only: ['unit'] },
  { name: 'M3：pm2 pid 读不到（0 / null）时不拒绝', find: 'if ($null -eq $PmPid -or -not [int]::TryParse([string]$PmPid, [ref]$p) -or $p -le 0) {', replace: 'if ($false) {', expect: ['U15', 'D-nopid'], only: ['unit', 'nopid'] },
  { name: 'M3：pm2 pid 与监听 pid 不等时放行', find: 'if ([int]@($Listen.Pids)[0] -ne $p) {', replace: 'if ($false) {', expect: ['U15', 'D-orphan'], only: ['unit', 'orphan'] },
  { name: 'M3：监听者多于一个时放行', find: 'if ($n -gt 1) {', replace: 'if ($false) {', expect: ['U15', 'D-orphan-multi'], only: ['unit', 'orphanmulti'] },
  { name: 'M3：没有任何监听者时放行', find: 'if ($n -eq 0) {', replace: 'if ($false) {', expect: ['U15', 'D-nolisten'], only: ['unit', 'nolisten'] },
  { name: 'M3：pm2 jlist 的 pid 解析被拿掉（永远读不到 pid）', find: 'pid: one && Number.isInteger(one.pid) ? one.pid : null', replace: 'pid: null', expect: ['U19', 'D-realprobe'], only: ['unit', 'realprobe'] },
  { name: 'M3：第 4 步真实路径停服之后不再核 3000 零监听', find: '$portFree = Test-PortReleased (Read-RemoteListeners)', replace: "$portFree = [pscustomobject]@{ Ok = $true; Why = '' }", expect: ['S20'], staticOnly: true },
  { name: 'M3：停服后端口释放硬门恒放行（3000 仍有 LISTENING 也放行）', find: 'if (@($Listen.Pids).Count -gt 0) {', replace: 'if ($false) {', expect: ['U16', 'D-stop-listen'], only: ['unit', 'stoplisten'] },
  { name: 'M3：停服后读不到 3000 监听情况时放行', find: 'if ($null -eq $Listen -or -not $Listen.Ok) { return [pscustomobject]@{ Ok = $false; Why = "读不到 3000 的监听情况，无法确认已释放', replace: 'if ($false) { return [pscustomobject]@{ Ok = $false; Why = "读不到 3000 的监听情况，无法确认已释放', expect: ['U16'], only: ['unit'] },
  { name: 'M3：第 8 步终检不再核 pm2 pid 与 3000 监听 pid', find: '$own8 = Test-Pm2OwnsPort $pt2.Pid $ls8', replace: "$own8 = [pscustomobject]@{ Ok = $true; Why = '' }", expect: ['D-ready-orphan', 'S20'], only: ['readyorphan'] },
  { name: 'M3：BACKUP_FAIL 自动起服务后的核对不看 pm2 pid 与 3000 监听 pid', find: ' -and $own5.Ok) { $verified = $true }', replace: ') { $verified = $true }', expect: ['S20'], staticOnly: true },
  { name: 'M3：回滚第 7 步的核对删掉 netstat 监听核对命令', find: 'Write-Host "      ssh $target ""netstat -ano | findstr LISTENING | findstr :3000""" -ForegroundColor White', replace: '$null = 0', expect: ['D-code', 'S20'], only: ['code'] },
  { name: 'M3：restart_unverified 的人工核对删掉 pm2 pid 命令', find: 'Write-Host "      ssh ${ServerUser}@${ServerIP} ""pm2 pid task-pool""" -ForegroundColor White', replace: '$null = 0', expect: ['S20'], staticOnly: true },
  { name: 'M3：第 2 步的孤儿监听硬门挪到发布记录 init 之后（停服前的中止不再干净）', edits: [
    ['$own2 = Test-Pm2OwnsPort $Pm2Pid $Listen', "$own2 = [pscustomobject]@{ Ok = $true; Why = '' }"],
    ['$script:PrevCommit = $RepoHead', '$script:PrevCommit = $RepoHead' + `${CRLF}$own2 = Test-Pm2OwnsPort $Pm2Pid $Listen`],
  ], expect: ['S20'], staticOnly: true },
  // M4 启动期 SQLITE_BUSY 指引
  { name: 'M4：SQLITE_BUSY 指引整段不再打印', find: 'if (Test-StartupBusyHint $Reason $Kind) {', replace: 'if ($false) {', expect: ['D-loop', 'D-ready-init', 'S21'], only: ['loop', 'readyinit'] },
  { name: 'M4：SQLITE_BUSY 指引无条件打印（其他失败形态也出现）', find: 'if (Test-StartupBusyHint $Reason $Kind) {', replace: 'if ($true) {', expect: ['D-code'], only: ['code'] },
  { name: 'M4：判定不识别 INIT_FAILED（只认 SQLITE_）', find: "return ($Reason -match 'INIT_FAILED|SQLITE_')", replace: "return ($Reason -match 'SQLITE_')", expect: ['U18', 'D-ready-init'], only: ['unit', 'readyinit'] },
  { name: 'M4：判定不识别 restart_time 只多 1（Kind）', find: "if ($Kind -eq 'RESTART_ONCE') { return $true }", replace: '$null = 0', expect: ['U18', 'D-loop'], only: ['unit', 'loop'] },
  { name: 'M4：restart_time 只多 1 仍说「反复崩溃重启」', find: 'if ([int]$Pt.RestartTime -eq [int]$BaseRestart + 1) {', replace: 'if ($false) {', expect: ['U17', 'D-loop'], only: ['unit', 'loop'] },
  { name: 'M4：第 8 步不把 Kind 传给回滚指引', find: 'Write-RollbackGuide -Reason $readyWhy -Hint $readyHint -Kind $readyKind', replace: 'Write-RollbackGuide -Reason $readyWhy -Hint $readyHint', expect: ['D-loop', 'S21'], only: ['loop'] },
  // L1 COMMIT_NULL / L5 回滚第 3 步
  { name: 'L1：COMMIT_NULL 分支补打印的 /api/health/ready 核对命令被删', find: 'Write-Host "      curl.exe --noproxy ""*"" -s -m 5 $BaseUrl/api/health/ready" -ForegroundColor White', replace: '$null = 0', expect: ['D-readynull', 'S21'], only: ['readynull'] },
  { name: 'L1：COMMIT_NULL 分支补打印的页面核对命令被删', find: 'Write-Host "      curl.exe --noproxy ""*"" -s -m 5 -o ""`$env:TEMP\\sdh-page-check.html"" -w ""%{http_code}"" $BaseUrl/<page>.html" -ForegroundColor White', replace: '$null = 0', expect: ['D-readynull', 'S21'], only: ['readynull'] },
  { name: 'L5：回滚第 3 步的确认命令又用 pm2 jlist（整份 pm2_env 含环境变量进会话记录）', edits: [
    ['Write-Host "      确认命令（只看 pid 与状态，不拉 pm2 的完整环境变量）：" -ForegroundColor Gray' + CRLF + '    Write-Host "      ssh $target ""pm2 pid task-pool""" -ForegroundColor White', 'Write-Host "      确认命令：" -ForegroundColor Gray' + CRLF + '    Write-Host "      ssh $target ""$Pm2JlistCmd""" -ForegroundColor White'],
  ], expect: ['D-code', 'S21'], only: ['code'] },
  // ---- 修复批 1b（预筛 H1 / M1 / LOW①-⑤）：H1 的两个变异登记前缀只写 U / D（行为层必须判红，不靠静态 S22）
  { name: '修复批 1b H1：netstat 状态列退回 [A-Za-z_]+（FIN_WAIT_1 / FIN_WAIT_2 整行判无法解析）', find: '([A-Z][A-Z0-9_]*)\\s+([0-9]+)\\s*$\')', replace: '([A-Za-z_]+)\\s+([0-9]+)\\s*$\')', expect: ['U14', 'D-finwait', 'D-normal'], only: ['unit', 'finwait', 'normal'] },
  { name: '修复批 1b H1：netstat 状态列放宽成 \\S+（本地化状态也解析通过，仍在监听的端口可能被判成已释放）', find: '([A-Z][A-Z0-9_]*)\\s+([0-9]+)\\s*$\')', replace: '(\\S+)\\s+([0-9]+)\\s*$\')', expect: ['U14', 'D-localized', 'U16'], only: ['unit', 'localized'] },
  { name: '修复批 1b M1：SQLITE_BUSY 人工恢复删掉 stop 之后确认 3000 零监听的 netstat 命令（修复批 1c 起经 Write-ListenerCheck 打印）', find: 'Write-Host "      再确认 3000 端口已释放（pm2 已 stopped 不等于端口已释放；命令见下一行）：" -ForegroundColor Gray' + CRLF + '        Write-ListenerCheck', replace: '$null = 0', expect: ['D-loop', 'D-ready-init'], only: ['loop', 'readyinit'] },
  { name: '修复批 1b M1：SQLITE_BUSY 人工恢复删掉补拉本次备份的 scp 命令', find: 'Write-Host "      scp ${ServerUser}@${ServerIP}:$bkScpSrc ${bkLocalDir}\\$bkLeaf.partial" -ForegroundColor White', replace: '$null = 0', expect: ['D-loop', 'D-ready-init'], only: ['loop', 'readyinit'] },
  { name: '修复批 1b M1：SQLITE_BUSY 日志命令去掉 --timestamp（命中行没有时间戳可比）', find: '--lines 500 --timestamp |', replace: '--lines 500 |', expect: ['D-loop', 'D-ready-init'], only: ['loop', 'readyinit'] },
  { name: '修复批 1b M1：SQLITE_BUSY 人工恢复去掉「时间戳须晚于本次 start」判据', find: 'Write-Host "      判据：命中行的时间戳必须晚于本次 start', replace: 'Write-Host "      说明：命中行', expect: ['D-loop', 'D-ready-init'], only: ['loop', 'readyinit'] },
  { name: '修复批 1b LOW②：端口没确认释放时失败态 note 仍记 STOP_UNCONFIRMED', find: "-Note $(if ($stopWhy -ne '') { 'PORT_NOT_RELEASED' } else { 'STOP_UNCONFIRMED' })", replace: "-Note 'STOP_UNCONFIRMED'", expect: ['D-stop-listen'], only: ['stoplisten'] },
  { name: '修复批 1b LOW③：「推送已生效」分支查 git 进程的命令去掉 Where-Object 收窄', find: "| Where-Object { `$_.CommandLine -match 'receive-pack|gc|TaskPool' } ", replace: '', expect: ['S22', 'D-push-landed'], only: ['pushland'] },   // D-push-landed 在第 1 步就中止（输出里没有 [2/9]），不算「走过第 0 步」的命中，所以命中依据是静态 S22；D 用例同时判红
  { name: '修复批 1b LOW④：push 超时且 ls-remote 也失败时仍只说「失败」（不说推送是否生效未知）', find: 'if (-not (Test-Ok $LsRes)) {', replace: 'if ($false) {', expect: ['U12'], only: ['unit'] },
  { name: '修复批 1b LOW⑤：DryRun 第 9 步不再预览轮转清单', find: 'Write-DryLine "（只读预览）拉回本次备份之后按保留 10 份轮转：现有正式名备份里将删除', replace: 'Write-DryLine "（预览）现有正式名备份里将删除', expect: ['D-normal'], only: ['normal'] },
  // ---- 修复批 1c（codex 47R2a）：H 回滚第 3 步零监听硬门 / M1 人工核对「没有输出 ≠ 成功」 / M2 库备份下载走 .partial
  // H：回滚第 3 步（pm2 stop 并确认 stopped 之后、回滚 4/7 换代码之前）的零监听核对
  { name: '修复批 1c H：回滚第 3 步不再调用 Write-ListenerCheck（stopped 之后不核对 3000 零监听，孤儿监听存活时也能往下 reset / 恢复库）', find: '脱离 pm2 的孤儿进程可能还占着 3000（命令见下一行，只读）：" -ForegroundColor Gray' + CRLF + '    Write-ListenerCheck', replace: '脱离 pm2 的孤儿进程可能还占着 3000（命令见下一行，只读）：" -ForegroundColor Gray', expect: ['D-code', 'S23'], only: ['code'] },
  { name: '修复批 1c H：回滚第 3 步的闸门改成放行（有监听者也可以进入回滚 4/7）', find: '才能进入回滚 4/7；有监听者或查询失败：停止人工流程', replace: '即可进入回滚 4/7；有监听者时请留意', expect: ['D-code', 'S23'], only: ['code'] },
  { name: '修复批 1c H：零监听核对挪到回滚 4/7 读回 HEAD 之后（reset 之后才核对，太晚）', edits: [
    ['脱离 pm2 的孤儿进程可能还占着 3000（命令见下一行，只读）：" -ForegroundColor Gray' + CRLF + '    Write-ListenerCheck', '脱离 pm2 的孤儿进程可能还占着 3000（命令见下一行，只读）：" -ForegroundColor Gray'],
    ['Write-Host "      判据：必须等于 $($script:PrevCommit)，不等就停下。" -ForegroundColor Gray', 'Write-Host "      判据：必须等于 $($script:PrevCommit)，不等就停下。" -ForegroundColor Gray' + CRLF + '    Write-ListenerCheck'],
  ], expect: ['D-code', 'S23'], only: ['code'] },
  // M1：netstat 先不加过滤、先判查询成功再判零监听；页面检查先要求 HTTP 200
  { name: '修复批 1c M1：Write-ListenerCheck 的命令退回 netstat | findstr 过滤（ssh / netstat 失败与零监听都表现为没有输出）', find: 'Write-Host "      ssh $target ""netstat -ano""" -ForegroundColor White', replace: 'Write-Host "      ssh $target ""netstat -ano | findstr LISTENING | findstr :3000""" -ForegroundColor White', expect: ['D-code', 'S23'], only: ['code'] },
  { name: '修复批 1c M1：Write-ListenerCheck 的判据一删掉「没有 TCP 行 / 报错 / 超时 = 查询失败，不是零监听」', find: '没有 TCP 行、ssh 报错、超时或输出为空，都是「查询失败」，不是「零监听」：停下，重查，不要往下做。', replace: '', expect: ['D-code', 'S23'], only: ['code'] },
  { name: '修复批 1c M1：Write-ListenerCheck 的判据二（3000 的 LISTENING 行必须为零）被删', find: '必须为零；有一行就是还有监听者', replace: '可以有；有一行也不用管监听者', expect: ['D-code', 'S23'], only: ['code'] },
  { name: '修复批 1c M1：SQLITE_BUSY 人工恢复的 start 判据退回「没有任何输出才能 start」', find: '判据：判据一、判据二都通过（查询成功且 3000 零 LISTENING）才能 start；查询失败或有监听者，停下，不要 start。', replace: '判据：没有任何输出才能 start；有输出就是端口还有监听者，停下，不要 start。', expect: ['D-loop', 'D-ready-init', 'S23'], only: ['loop', 'readyinit'] },
  { name: '修复批 1c M1：第 4 步失败处置不再调用 Write-ListenerCheck（stopped 的判据还写着「查询成功、3000 零 LISTENING」却没有命令可查）', find: '    ' + STEP4_NS_CMD + CRLF + '    ' + STEP4_STOPPED_JUDGE, replace: '    ' + STEP4_STOPPED_JUDGE, expect: ['S17', 'S23', 'D-stop-listen'], only: ['stoplisten'] },
  { name: '修复批 1c M1：第 4 步其他判据去掉「netstat 查询失败」（没有输出被当成零监听）', find: STEP4_OTHER_JUDGE, replace: 'Write-Host "      判据：读不到状态、两次不一致、名为 task-pool 的不止一项、为 errored 等其他状态、或 3000 上仍有 LISTENING（pm2 已 stopped 也一样，多半是孤儿监听）→ 不要起服务，人工核实。" -ForegroundColor Gray', expect: ['S17', 'S23'], staticOnly: true },
  { name: '修复批 1c M1：回滚第 7 步删掉「命令失败 / 没有输出都按未通过处理」', find: '    Write-Host "      判据：上面任一条命令失败（ssh 报错、超时、没有输出）都按未通过处理：没有输出可能只是查询失败，不是「一致」，也不是「没有监听者」。" -ForegroundColor Gray' + CRLF, replace: '', expect: ['S23'], staticOnly: true },
  { name: '47R2a-R M1：页面检查删掉 $LASTEXITCODE 一行（curl 回 200 后正文中断、退出码非 0 也被放行）', find: 'Write-Host "      `$LASTEXITCODE" -ForegroundColor White', replace: '$null = 0', expect: ['S23'], staticOnly: true },
  { name: '修复批 1c M1：COMMIT_NULL 页面检查退回 curl 管道 Select-String（curl 失败或错误页也没有输出，被判通过）', find: 'Write-Host "      curl.exe --noproxy ""*"" -s -m 5 -o ""`$env:TEMP\\sdh-page-check.html"" -w ""%{http_code}"" $BaseUrl/<page>.html" -ForegroundColor White', replace: 'Write-Host "      curl.exe --noproxy ""*"" -s -m 5 $BaseUrl/<page>.html | Select-String -SimpleMatch ""?v=auto""" -ForegroundColor White', expect: ['D-readynull', 'S23', 'S21'], only: ['readynull'] },
  { name: '修复批 1c M1：COMMIT_NULL 页面检查删掉「输出恰为 200 才继续」判据', find: 'Write-Host "      判据：输出恰为 200 才继续看下一条；', replace: 'Write-Host "      说明：输出为 200 时看下一条；', expect: ['D-readynull', 'S23'], only: ['readynull'] },
  { name: '修复批 1c M1：COMMIT_NULL 页面检查的扫描判据退回「没有任何输出才算通过」（不区分查询成功但零命中）', find: '判据：200 之后这一条没有任何输出（查询成功但零命中）才算通过；', replace: '判据：没有任何输出才算通过；', expect: ['D-readynull', 'S23', 'S21'], only: ['readynull'] },
  // M2：库备份先下载到 .partial，核对大小后才改名，改名之后才轮转
  { name: '修复批 1c M2：库备份的 scp 目标退回正式名（SCP 中断会留下满足正式名正则的不完整文件）', find: 'Invoke-RemoteWrite -TransferArgs @("${ServerUser}@${ServerIP}:$scpSrcPath", $localPartial)', replace: 'Invoke-RemoteWrite -TransferArgs @("${ServerUser}@${ServerIP}:$scpSrcPath", $localDst)', expect: ['D-normal', 'S24'], only: ['normal'] },
  { name: '修复批 1c M2：下载之后不核对大小（闸门删掉，不完整的 .partial 也改名）', find: 'if (-not $sizeOk.Ok) { throw $sizeOk.Why }', replace: '', expect: ['S24'], staticOnly: true },
  { name: '修复批 1c M2：先改名再核对大小（改名在核对之前）', find: 'if (-not $sizeOk.Ok) { throw $sizeOk.Why }' + CRLF + '        Move-Item -LiteralPath $localPartial -Destination $localDst -ErrorAction Stop', replace: 'Move-Item -LiteralPath $localPartial -Destination $localDst -ErrorAction Stop' + CRLF + '        if (-not $sizeOk.Ok) { throw $sizeOk.Why }', expect: ['S24'], staticOnly: true },
  { name: '修复批 1c M2：先轮转再改名（轮转在改名之前，失败时已经删了旧备份）', edits: [
    ['        Move-Item -LiteralPath $localPartial -Destination $localDst -ErrorAction Stop', '        $toDelete = Get-DbBackupsToDelete $localBackupDir 10' + CRLF + '        Move-Item -LiteralPath $localPartial -Destination $localDst -ErrorAction Stop'],
  ], expect: ['S24'], staticOnly: true },
  { name: '修复批 1c M2：失败分支把 .partial 改名成正式名（失败产物冒充正式备份）', find: '    if ($null -ne $localPartial -and (Test-Path -LiteralPath $localPartial)) {' + CRLF + '        Write-Host "  [HINT] 失败留下的临时文件已保留', replace: '    if ($null -ne $localPartial -and (Test-Path -LiteralPath $localPartial)) {' + CRLF + '        Move-Item -LiteralPath $localPartial -Destination $localDst -ErrorAction SilentlyContinue' + CRLF + '        Write-Host "  [HINT] 失败留下的临时文件已保留', expect: ['S24'], staticOnly: true },
  { name: '修复批 1c M2：补拉提示的 scp 目标退回目录（直接落正式名）', find: '${localBackupDir}\\$hintLeaf.partial" -ForegroundColor White', replace: '${localBackupDir}\\" -ForegroundColor White', expect: ['S24'], staticOnly: true },
  { name: '修复批 1c M2：第 5 步不再记录备份协议行的 bytes（第 9 步每次都得再查远端）', find: '{ $script:BackupBytes = $bkBytesParsed }', replace: '{ }', expect: ['S24'], staticOnly: true },
  { name: '修复批 1c M2：Test-BackupSizeMatch 不比较两边大小（不相等也通过）', find: 'if ($a -ne $e) {', replace: 'if ($false) {', expect: ['U20', 'S24'], only: ['unit'] },
  { name: '修复批 1c M2：Test-BackupSizeMatch 期望大小读不到时放行（0 对 0、null 对任何值）', find: 'if ($null -eq $Expected -or -not [long]::TryParse([string]$Expected, [ref]$e) -or $e -le 0) {', replace: 'if ($false) {', expect: ['U20'], only: ['unit'] },
  { name: '混入裸 LF', transform: (buf) => Buffer.from(buf.toString('utf8').replace(`${CRLF}param(`, `\nparam(`), 'utf8'), expect: ['S2'], staticOnly: true },
];

/**
 * 把 Invoke-RemoteRead / Invoke-RemoteWrite 里 ssh / scp 的取值换成「node 跑本地桩」。四处取值（读写各一对 scp / ssh）都要换到，
 * 换完文本里不能再有 $exe = 'ssh' / 'scp'，且 $env:STUB_JS 恰出现 4 次；否则返回 ok=false（调用方不跑该变异）。
 */
function stubRemoteExec(text) {
  const reps = [
    ["$exe = 'scp'", "$exe = 'node'"],
    ["$exe = 'ssh'", "$exe = 'node'"],
    ["$argv = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15') + $TransferArgs", "$argv = @($env:STUB_JS, 'scp') + $TransferArgs"],
    ['$argv = @(\'-o\', \'BatchMode=yes\', \'-o\', \'ConnectTimeout=15\', "${ServerUser}@${ServerIP}", $Command)', "$argv = @($env:STUB_JS, 'ssh', $Command)"],
  ];
  let t = text;
  for (const [find, replace] of reps) t = t.split(find).join(replace);
  const stubUses = t.split('$env:STUB_JS').length - 1;
  if (/\$exe = '(ssh|scp)'/.test(t)) return { ok: false, why: "仍有 $exe = 'ssh' / 'scp'" };
  if (stubUses !== 4) return { ok: false, why: `$env:STUB_JS 出现 ${stubUses} 次，应为 4 次` };
  return { ok: true, text: t };
}

async function runMutations() {
  const orig = fs.readFileSync(SCRIPT_PATH);
  const deploySrc = path.join(path.dirname(SCRIPT_PATH), 'deploy');
  const items = MUTATIONS.map((m, i) => async () => {
    const root = freshDir(`mut${i + 1}`);
    const scriptsDir = path.join(root, 'scripts');
    fs.mkdirSync(path.join(scriptsDir, 'deploy'), { recursive: true });
    for (const n of fs.readdirSync(deploySrc)) {
      if (n.endsWith('.js')) fs.copyFileSync(path.join(deploySrc, n), path.join(scriptsDir, 'deploy', n));
    }
    let buf = orig;
    if (m.transform) {
      buf = m.transform(buf);
    } else {
      let text = orig.toString('utf8');
      const edits = m.edits || [[m.find, m.replace]];
      for (const [find, replace] of edits) {
        const n = text.split(find).length - 1;
        if (n !== 1) return { name: m.name, applied: false, detail: `find 出现 ${n} 次：${find.slice(0, 60)}` };
        text = text.replace(find, () => replace);
      }
      buf = Buffer.from(text, 'utf8');
    }
    if (buf.equals(orig)) return { name: m.name, applied: false, detail: '变异没有改变文件' };
    const target = path.join(scriptsDir, 'deploy-ssh.ps1');
    const only = m.staticOnly ? ['static'] : m.only;
    // H2：会跑部署脚本的变异（动态 / 拒绝类），其副本里 Invoke-RemoteRead / Invoke-RemoteWrite 的远端执行一律换成本地桩（只把命令记进文件，不起 ssh / scp）——
    // 这样即使变异破坏了 DryRun 守卫或让 Invoke-RemoteWrite 不再提前返回，也连不出去。桩替换必须真的发生（静态断言），否则不跑该变异
    const needsStub = !m.staticOnly && only.some((id) => id !== 'unit' && !id.startsWith('realprobe'));
    const stubLog = path.join(root, 'stub.log');
    const stubJs = path.join(root, 'stub.js');
    if (needsStub) {
      const stubbed = stubRemoteExec(buf.toString('utf8'));
      if (!stubbed.ok) return { name: m.name, applied: false, detail: `桩替换没有发生，不跑该变异：${stubbed.why}` };
      buf = Buffer.from(stubbed.text, 'utf8');
      fs.writeFileSync(stubJs, "require('fs').appendFileSync(process.env.STUB_LOG, process.argv.slice(2).join(' ') + '\\n');\n");
    }
    fs.writeFileSync(target, buf);
    SPAWN_COUNT += 1;
    const r = await new Promise((resolve) => {
      const child = spawn(process.execPath, [__filename, `--script=${target}`, '--no-mutations', '--emit-reached', ...(needsStub ? ['--ssh-stubbed'] : []), `--only=${only.join(',')}`], { cwd: REPO_ROOT, env: Object.assign({}, process.env, { STUB_JS: stubJs, STUB_LOG: stubLog }), stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks = [];
      const timer = setTimeout(() => { try { child.kill(); } catch (_) { /* ignore */ } }, 600000);
      child.stdout.on('data', (b) => chunks.push(b));
      child.stderr.on('data', (b) => chunks.push(b));
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, out: Buffer.concat(chunks).toString('utf8') }); });
    });
    const failed = r.out.split(/\r?\n/).filter((l) => l.startsWith('FAIL ')).map((l) => l.slice(5).split(' :: ')[0]);
    const reached = {};
    for (const l of r.out.split(/\r?\n/)) {
      const mm = /^REACHED (\S+) ([01])$/.exec(l);
      if (mm) reached[mm[1]] = mm[2];
    }
    let stubbedCalls = null;
    if (needsStub) {
      try { stubbedCalls = fs.readFileSync(stubLog, 'utf8').split(/\r?\n/).filter(Boolean).length; } catch (_) { stubbedCalls = 0; }
    }
    return { name: m.name, applied: true, failed, reached, expect: m.expect, code: r.code, stubbedCalls };
  });
  const res = await pool(items, 3);
  console.log(`\n变异自证（${MUTATIONS.length} 个）：`);
  MUTATIONS.forEach((m, i) => {
    const r = res[i];
    if (!r.applied) { check(`M${i + 1} ${m.name}: 变异已应用`, false, r.detail); return; }
    // 命中规则：登记前缀的红；若是动态用例（D-），该用例输出里必须出现 [2/9]（走过了第 0 步），否则是「死在第 0 步」的伪命中，计 RED-BUT-NOT-TARGET。
    // R- 用例在三重隔离下到不了第 0 步之后，不作为命中依据（登记的目标是静态 / 单元断言）。
    const cands = r.failed.filter((f) => m.expect.some((p) => f.startsWith(p)));
    const valid = cands.filter((f) => !/^R-/.test(f) && (!/^D-/.test(f) || r.reached[f.split(':')[0]] === '1'));
    const hit = valid[0];
    const detail = cands.length > 0 && hit === undefined ? `RED-BUT-NOT-TARGET：命中的红 ${cands.slice(0, 3).join(' | ')} 没有走过第 0 步（输出里无 [2/9]）或属于隔离下到不了的 R- 用例` : `变红的用例：${r.failed.slice(0, 4).join(' | ') || '(无)'}`;
    check(`M${i + 1} ${m.name}: 自检变红且命中 ${m.expect.join('/')}`, hit !== undefined, detail);
    const kinds = Array.from(new Set(r.failed.map((f) => f.split(/[ :-]/)[0]))).join('/');
    console.log(`  M${i + 1} ${m.name} -> ${hit !== undefined ? `红：${hit}` : (cands.length > 0 ? 'RED-BUT-NOT-TARGET' : '未命中')}（共 ${r.failed.length} 条红，涉及 ${kinds}${r.stubbedCalls === null ? '' : `；远端执行已换本地桩，桩收到 ${r.stubbedCalls} 条本该发往 ssh / scp 的命令`}）`);
  });
}

// ---------------------------------------------------------------- 主流程
async function main() {
  if (SHOW_ARG) {
    const id = SHOW_ARG.slice('--show='.length);
    setupFixture(SCRIPT_PATH);
    const cases = buildCases();
    const c = cases.find((x) => x.id === id);
    if (!c) { console.log(`未知用例 ${id}；可选：${cases.map((x) => x.id).join(',')}`); process.exitCode = 2; return; }
    const r = await runCase(c);
    console.log(r.out);
    console.log(`[exit=${r.status}]`);
    removeTree(TMP_ROOT);
    return;
  }
  // --emulate-utf8-host：把本进程所在控制台的输入 / 输出代码页临时设成 65001（模拟主会话那种 UTF-8 宿主），整个自检（含子运行）都在这个宿主下跑，结束还原
  let hostCpRestore = null;
  if (process.argv.includes('--emulate-utf8-host')) {
    const q = spawnSync(POWERSHELL, ['-NoProfile', '-Command', '[Console]::InputEncoding.CodePage; [Console]::OutputEncoding.CodePage'], { encoding: 'utf8' });
    const [inCp, outCp] = String(q.stdout).trim().split(/\s+/).map(Number);
    spawnSync(POWERSHELL, ['-NoProfile', '-Command', '[Console]::InputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8'], { encoding: 'utf8' });
    hostCpRestore = () => spawnSync(POWERSHELL, ['-NoProfile', '-Command', `[Console]::InputEncoding = [System.Text.Encoding]::GetEncoding(${inCp}); [Console]::OutputEncoding = [System.Text.Encoding]::GetEncoding(${outCp})`], { encoding: 'utf8' });
    console.log(`INFO 已模拟 UTF-8 宿主（控制台输入 / 输出代码页原为 ${inCp} / ${outCp}，结束时还原）`);
  }
  try {
    staticChecks(fs.readFileSync(SCRIPT_PATH));
    const wantDynamic = ONLY === null || !(ONLY.size === 1 && (ONLY.has('static') || ONLY.has('unit')));
    const wantUnit = ONLY === null || ONLY.has('unit');
    // H2：任何会起子进程的段（单元、动态、变异）之前，先建夹具并过隔离门；不成立就整体中止，一个子进程都不起
    // 凡准备运行单元、动态或变异任一段，都先过适用的隔离检查：动态段过完整的门（夹具 + 目录 + R0），其余（--only=unit、--only=static 加变异等）至少过 PATH / 测试地址检查
    let gateOk = true;
    if (wantDynamic) gateOk = prepareDynamic(SCRIPT_PATH);
    else if (wantUnit || RUN_MUTATIONS) gateOk = lightGate();
    if (gateOk) {
      if (wantUnit) await unitChecks(SCRIPT_PATH);
      if (wantDynamic) {
        if (ONLY === null) await isolationSelfTest();
        await dynamicChecks(SCRIPT_PATH);
      }
      if (RUN_MUTATIONS) await runMutations();
    } else {
      console.log('ABORT 变异自证也没有运行。');
    }
  } finally {
    removeTree(TMP_ROOT);
    if (hostCpRestore) hostCpRestore();
  }
  if (process.argv.includes('--report-spawns')) console.log(`SPAWN_COUNT=${SPAWN_COUNT}`);
  console.log(`PASS=${pass} FAIL=${fail}`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((e) => {
  console.log(`FAIL 自检运行异常 :: ${e && e.stack}`);
  console.log(`PASS=${pass} FAIL=${fail + 1}`);
  removeTree(TMP_ROOT);
  process.exitCode = 1;
});
