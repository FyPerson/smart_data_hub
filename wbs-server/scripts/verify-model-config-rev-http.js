// verify-model-config-rev-http.js — HTTP 级性质断言：config_rev 记账点 + 「改配置后旧验收不得通过」+ 门禁传 task + reopen 失效
// （#77 C1c，方案 v0.9 §7.1「性质断言 / 记账点 / 失效与旧路径」）
//
// 运行面（自包含、零本机库、零真实外发）：
//   · 不读不写仓库内的 wbs-server/task_pool.db，也不复制它：库是临时目录里的**空库**，由被测代码自己启动一次建出全部表
//     （等启动日志静默、校验关键表与列到位）→ 停服务 → 写夹具 → 再启动做测试。干净检出（无本机库）同样可跑。
//   · 被测服务 = 把 server.js / utils / routes 复制到临时目录（scripts/_test-it-asset-ledger-server-wrapper.js
//     通用 sqlite 重定向 wrapper 一并复制过去）后自起的独立进程：server.js 里写死的 `__dirname/uploads`、
//     `__dirname/archive`（save-scripts / edit-script 会写脚本文件）落在临时目录里，仓库内零临时产物；
//     依赖走 NODE_PATH 指向仓库 node_modules（不建 junction）。
//   · 端口：先用 scripts/lib/listen-safe-port.js 在 20000–49999 占一个端口再释放给被测服务（绑定失败自动换端口重试）。
//   · 外发：空库里没有钉钉凭证 / 通知开关行，也没有系统迭代 #73 到期扫描的候选行（库是新建的，运行时打印核对）；
//     出网统一拦截：被测服务进程以 `node --require net-guard.js` 启动，非回环地址的 TCP 连接（MSSQL / MySQL / 钉钉…）一律 ECONNREFUSED
//     并留日志，套件开头用同一预加载脚本起探针进程自证（外部地址被拒、回环放行）；
//     拦截范围：TCP connect、UDP send / connect、dns.lookup、以及全部 dns.resolve* / reverse / lookupService（dns.X、dns.promises.X、
//     dns.Resolver.prototype.X、dns.promises.Resolver.prototype.X 四处都封，回环 / localhost 放行）；探针共 11 项（udp / dns.lookup / 外部 tcp / 回环 tcp /
//     dns.resolve4 / dns.promises.resolve4 / new dns.Resolver().resolve4 / new dns.promises.Resolver().resolve4 / dns.resolve6 / dns.reverse / dns.lookupService），要求探针 status 0、无 signal / error / TIMEOUT、11 个结果各出现一次。
//     **不覆盖**：非 node 子进程（NODE_OPTIONS 只对 node 进程生效）——被测服务里会起外部程序的只有 inspection-collector，它仅由 API 触发，本套件不调用；
//     JS 层猴子补丁是「证据」不是网络沙箱（进程 / 系统级隔离不在本套件范围）。
//     清理复查：removeTree / killPid 之后复查目录不存在、pid 不存在，失败输出 [cleanup-check] 诊断并置退出码 1；信号处理防重入。
//     预加载脚本加载时往 stderr 写 `[net-guard] loaded pid=<pid>`，startInstance 在服务起来后断言服务日志里有该行且 pid 与所起进程一致（否则判失败）。不碰 db_connections（该表直写点由 verify-db-connections-writers 统管）。
//   · 「服务运行期间测试进程不写库」（根治 SQLITE_BUSY 让服务整进程退出）：所有夹具在服务启动前一次性写好（每个用例各用独立的
//     模型 / 任务 id，脚本文件也预先放进临时 uploads 目录）；服务运行期间测试进程只持有 OPEN_READONLY 连接做断言；
//     需要「改库再请求」的 reopen 用例走「停服务 → 写库 → 重启」。写连接只能经 openWriter 取得，并挂计数闸：服务运行期间一旦写库就抛错并计数，
//     收尾断言计数 = 0。库切 WAL（写夹具时设置）。结束时按自己起的 pid 精确停止（taskkill /T /F /PID），整目录删除。
//
// 覆盖面（断言期望值全部手写）：
//   §1 记账点 + 性质：PUT 的 A 类字段（dim_config 实质变化 / table_name / source_system / source_table / update_cycle /
//      config_mode）各一次 → config_rev 恰好 +1；只改 changeTracking.companionModelId（顶层与 dwdConfig 两处）→ 不变；
//      B 类字段（table_comment / design_notes / domain / tech_owner / biz_owner / category / status / model_type）
//      各一次 → 不变；save-scripts（首次落盘 / 仅头部生成时刻不同 / 业务内容变化 / 当前目录无同名文件但 script_path 目录有：
//      内容不同 +1、相同不变）；edit-script（新文件 / 内容变化 / 内容不变）；restore；软删除；删伴生表回写主表。
//      每个用例都预先造「当前版本的 pass 验收记录」，写入后读 GET /api/models/:id/validation-status 的 state：
//      A 类写入之后不再是 pass / warn，B 类写入之后仍是 pass。
//   §2 门禁传 task（4 处逐一）：can-self-archive、archivable-task、confirm（非 admin ODS）、confirm（admin DIM / DWD）——
//      验收 test_time 早于 / 同秒于 / 晚于任务 created_at：前两者拒绝（同秒的提示为方案原文），后者放行。
//   §2b validation-status（单个 / 批量）的 state 与 gatePass 值断言：fail / none / partial / companion 四种不通过态，
//      state 恒等于期望值且 gatePass 是布尔 false（期望手写）。
//   A 类写点覆盖（与守卫的契约）：scripts/fixtures/model-gate-contract/a-class-coverage.json 的每一条 entry 都必须被至少一个「通过的」用例覆盖——
//      用例用 covers 声明覆盖哪条（hash），且须：本用例全部断言通过 + config_rev 恰好 +1 + 证据断言成立（那条 SQL 确实执行：写点独有的列被写，
//      如 script_saved_by / script_modified_by / dim_config / is_deleted）；套件结束时逐条断言并打印「entry → 用例名」映射；用例声明了契约里没有的 hash 也判失败。
//   写点级运行时归因（codex 22-R2）：被测服务经 NODE_OPTIONS 另预加载 sql-trace.js，包装 sqlite3 的 run / get / all / each / exec / prepare（及 prepare 出的 Statement），
//      把实际执行的 data_models 写语句（UPDATE / INSERT / REPLACE / DELETE，先剥 SQL 注释再判）连同绑定参数与单调序号写进追踪日志（首行是带 pid 的加载标记，startInstance 断言）。
//      每个 §1 用例记录请求前后的序号窗口：窗口内「config_rev 自增量为 1」的语句必须恰好 1 条（A 类）/ 0 条（B 类）；契约 7 条各有归因判据（ATTRIBUTION，套件结束时打印）：
//      inline 形态须是同一条 UPDATE 写目标独有列并含 config_rev = config_rev + ?（绑定 1），call 形态须是助手单语句 + 窗口内恰好 1 条目标 SQL +
//      按 server.js 实际顺序固定的相对顺序与邻接（二者之间无其他 data_models 写语句；允许的中间语句为空）+ 助手参数与目标 SQL 的模型 id 相同（codex 22-R3：从「同窗存在」收紧到「顺序 + 邻接」）。
//      变异 M-D（递增插值挪进 SQL 注释 + 同请求另发 bumpConfigRev，整请求 +1 仍成立）须被归因断言判红；变异 M-E / M-F / M-G（三个 call 形态写点的助手调用迁位，请求级 +1 仍成立）须被「顺序与邻接」断言判红。
//      登记不改（codex 22-R3）：call 形态归因靠「顺序 + 邻接」而非调用点标识（被测代码不改）；完整响应结构 schema、请求指纹嵌套字段归一化见 snapshot-model-gate-contract.js 头部登记。
//      A 类覆盖硬门与分组解耦：默认执行，分组不含 accounting 直接判失败；只有变异自证运行显式豁免。每个覆盖用例的证据回调读取请求前后的整行，断言目标列由旧值变成预期新值，夹具每用例独立。
//   §3 reopen：ARCHIVED → OPEN 后该模型验收记录全部 invalidated = 1，再建任务不可凭旧记录归档。
//   变异自证（在临时目录的源码副本上改，服务从副本起）：M-A 删掉 PUT 的 config_rev 参数计算（恒传 0）→ §1 的 A 类记账断言须判红；
//      M-B 删掉 archivable-task 门禁的 task 实参 → §2 的「早于 / 同秒」断言须判红；「没改到」或「没红」都计为失败。
//
// 不证明：分支级覆盖由各用例的真实请求决定，未列出的写入路径（如 quick-submit 推进状态）由静态守卫
//   verify-model-write-classification.js 登记为 B 类，不在本套件逐个打请求；MSSQL 验收执行本身不在本套件范围。
//
// 运行：node scripts/verify-model-config-rev-http.js        （--tmp=<目录> 或环境变量 MC_C1C_TMP 可指定临时根目录，默认系统临时目录下的 mc-c1c）
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const { listenOnSafePort } = require('./lib/listen-safe-port');

const ROOT = path.resolve(__dirname, '..');
const REAL_DB_ABS = path.resolve(ROOT, 'task_pool.db');   // 仅作「禁止指向它」的比对用，本文件任何地方都不读不写它
const tmpArg = process.argv.find(x => x.startsWith('--tmp='));
const TMP_BASE = path.resolve(tmpArg ? tmpArg.slice(6) : (process.env.MC_C1C_TMP || path.join(os.tmpdir(), 'mc-c1c')));
require('dotenv').config({ path: path.join(ROOT, '.env') });

const SAME_SECOND_TEXT = '验收时间与任务创建时间在同一秒，请重新验收';
const EARLIER_TEXT = '当前版本的验收记录早于任务创建时间，请重新验收';   // 手写期望，不从 acceptance.js 导入（导入就成了测自己）

// ───────────────────────────── 通用：临时目录 / 清理 ─────────────────────────────
const cleanups = [];
function registerCleanup(fn) { cleanups.push(fn); }
// 清理复查失败的诊断（removeTree / killPid / worktree 清理之后复查路径与 pid 是否真的没了）：非空 ⇒ 输出诊断并把退出码置 1，不静默吞掉
const cleanupFailures = [];
function noteCleanupFailure(msg) { cleanupFailures.push(msg); console.error(`[cleanup-check] ${msg}`); process.exitCode = 1; }
function runCleanupsSync() {
  while (cleanups.length) { const fn = cleanups.pop(); try { fn(); } catch (e) { noteCleanupFailure(`清理动作抛错：${e && e.message}`); } }
}
process.on('exit', runCleanupsSync);
let shuttingDown = false;   // 信号处理防重入：第二次信号直接忽略，不在清理途中再进一遍
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { if (shuttingDown) return; shuttingDown = true; runCleanupsSync(); process.exit(130); });

function makeRunDir(tag) {
  fs.mkdirSync(TMP_BASE, { recursive: true });
  const dir = path.join(TMP_BASE, `${tag}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  registerCleanup(() => removeTree(dir));
  return dir;
}
// 只删 TMP_BASE 之下的目录（且不是 TMP_BASE 本身）；本目录树内没有符号链接 / junction
function removeTree(dir) {
  const target = path.resolve(dir);
  if (!target.startsWith(TMP_BASE + path.sep)) throw new Error(`removeTree 拒绝删除临时根之外的路径：${target}`);
  try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }); } catch (_) { /* 下面复查 */ }
  if (!fs.existsSync(target)) return;
  try {
    execFileSync('powershell', ['-NoProfile', '-Command', 'Remove-Item -LiteralPath $env:MC_RM_TARGET -Recurse -Force -ErrorAction Stop'],
      { env: { ...process.env, MC_RM_TARGET: target } });
  } catch (_) { /* 下面复查 */ }
  if (fs.existsSync(target)) noteCleanupFailure(`临时目录删除后仍存在：${target}`);
}

// ───────────────────────────── 被测服务：复制源码 / 起停 ─────────────────────────────
// 手写递归复制（fs.cpSync 在本机上会让进程静默退出，exit 127，不用）
function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name), to = path.join(dst, ent.name);
    if (ent.isDirectory()) copyTree(from, to);
    else if (ent.isFile()) fs.copyFileSync(from, to);
  }
}

// 被测服务进程的出网拦截（node --require 预加载）：net.Socket.prototype.connect 只放行回环 / IPC，
// 其余（MSSQL / MySQL / 钉钉 / 任何外部主机，tls.connect 与 http(s) 最终也走这里）直接以 ECONNREFUSED 拒绝并写日志。
const NET_GUARD_SRC = [
  "'use strict';",
  // 加载标记：服务日志里出现「本进程 pid」的这一行，才证明被测服务真的加载了 guard（startInstance 与快照工具据此断言）
  "console.error('[net-guard] loaded pid=' + process.pid);",
  "const net = require('net');",
  "const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '::']);",
  "const orig = net.Socket.prototype.connect;",
  "net.Socket.prototype.connect = function (...args) {",
  "  let a0 = args[0];",
  "  if (Array.isArray(a0)) a0 = a0[0];",
  "  let host; let ipc = false;",
  "  if (a0 && typeof a0 === 'object') { host = a0.host; ipc = !!a0.path && !a0.port; }",
  "  else if (typeof a0 === 'number' || (typeof a0 === 'string' && /^\\d+$/.test(a0))) host = typeof args[1] === 'string' ? args[1] : undefined;",
  "  else if (typeof a0 === 'string') ipc = true;",
  "  if (!ipc && host !== undefined && host !== null && !LOOPBACK.has(String(host))) {",
  "    const err = new Error('net-guard: blocked outbound connect to ' + host);",
  "    err.code = 'ECONNREFUSED';",
  "    console.error('[net-guard] blocked outbound connect to ' + host + ':' + (a0 && a0.port !== undefined ? a0.port : ''));",
  "    process.nextTick(() => this.destroy(err));",
  "    return this;",
  "  }",
  "  return orig.apply(this, args);",
  "};",
  // UDP 与 DNS 同样只放行回环 / localhost（被测服务的子进程经 NODE_OPTIONS 继承同一份预加载）
  "const dgram = require('dgram');",
  "const dns = require('dns');",
  "const isLo = (h) => h === undefined || h === null || h === '' || LOOPBACK.has(String(h));",
  "function block(what, host) { const e = new Error('net-guard: blocked outbound ' + what + ' to ' + host); e.code = 'ECONNREFUSED'; console.error('[net-guard] blocked outbound ' + what + ' to ' + host); return e; }",
  "const origSend = dgram.Socket.prototype.send;",
  "dgram.Socket.prototype.send = function (...args) {",
  "  const strs = args.slice(1).filter((a) => typeof a === 'string');",
  "  const host = strs.length ? strs[strs.length - 1] : undefined;",
  "  if (!isLo(host)) { const e = block('udp send', host); const cb = args.find((a) => typeof a === 'function'); if (cb) process.nextTick(cb, e); else process.nextTick(() => this.emit('error', e)); return; }",
  "  return origSend.apply(this, args);",
  "};",
  "const origUdpConnect = dgram.Socket.prototype.connect;",
  "dgram.Socket.prototype.connect = function (port, address) {",
  "  if (typeof address === 'string' && !isLo(address)) { const e = block('udp connect', address); process.nextTick(() => this.emit('error', e)); return; }",
  "  return origUdpConnect.apply(this, arguments);",
  "};",
  "const origLookup = dns.lookup;",
  "dns.lookup = function (hostname, ...rest) {",
  "  if (!isLo(hostname)) { const e = block('dns lookup', hostname); const cb = rest.find((a) => typeof a === 'function'); if (cb) { process.nextTick(cb, e); return {}; } throw e; }",
  "  return origLookup.call(this, hostname, ...rest);",
  "};",
  "const origPLookup = dns.promises.lookup;",
  "dns.promises.lookup = async function (hostname, ...rest) { if (!isLo(hostname)) throw block('dns lookup', hostname); return origPLookup.call(dns.promises, hostname, ...rest); };",
  // 其余全部 DNS 入口：resolve* / reverse / lookupService 走原生 c-ares，不经上面的 lookup。
  // 逐个封 dns.X、dns.promises.X、dns.Resolver.prototype.X、dns.promises.Resolver.prototype.X（首参是主机名 / IP，回环放行）
  "const RESOLVE_METHODS = ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse', 'lookupService'];",
  "function wrapCb(obj, m, isPromises) {",
  "  const orig = obj[m];",
  "  if (typeof orig !== 'function') return;",
  "  obj[m] = isPromises",
  "    ? async function (host, ...rest) { if (!isLo(host)) throw block('dns ' + m, host); return orig.call(this, host, ...rest); }",
  "    : function (host, ...rest) {",
  "        if (!isLo(host)) { const e = block('dns ' + m, host); const cb = rest.find((a) => typeof a === 'function'); if (cb) { process.nextTick(cb, e); return {}; } throw e; }",
  "        return orig.call(this, host, ...rest);",
  "      };",
  "}",
  "for (const m of RESOLVE_METHODS) {",
  "  wrapCb(dns, m, false);",
  "  wrapCb(dns.promises, m, true);",
  "  if (dns.Resolver && dns.Resolver.prototype) wrapCb(dns.Resolver.prototype, m, false);",
  "  if (dns.promises.Resolver && dns.promises.Resolver.prototype) wrapCb(dns.promises.Resolver.prototype, m, true);",
  "}",
  "",
].join('\n');

// 被测服务进程内的 SQL 追踪器（node --require 预加载，与 net-guard 同一注入方式）：包装 sqlite3 的 Database.prototype.run / get / all / each / exec / prepare
// 以及 prepare 出来的 Statement.prototype.run / get / all / each，把「实际发出的、目标表为 data_models 的写语句（UPDATE / INSERT / REPLACE / DELETE）」
// 连同绑定参数与单调序号逐行写入 MC_SQL_TRACE_FILE（每行一条 JSON）；先写一行加载标记 {loaded:true,pid}。
// 判断「是不是写 data_models」前先剥掉块注释与行注释——SQL 里被注释掉的片段不算数（SQLite 同样忽略注释）。
// node-sqlite3 的 Database#run/get/all/each 内部会 new 一个内部 Statement 再调 Statement#run，所以 Statement 方法只记「经 prepare 得到的」
// （带 __mcSql 标记），避免同一条语句记两次。
const SQL_TRACE_SRC = [
  "'use strict';",
  "const fs = require('fs');",
  "const file = process.env.MC_SQL_TRACE_FILE;",
  "if (file) {",
  "  let seq = 0;",
  "  const write = (o) => { try { fs.appendFileSync(file, JSON.stringify(o) + '\\n'); } catch (_) { /* 追踪失败不影响服务 */ } };",
  "  write({ loaded: true, pid: process.pid });",
  "  const sqlite3 = require('sqlite3');",
  "  const strip = (s) => String(s).replace(/\\/\\*[\\s\\S]*?\\*\\//g, ' ').replace(/--[^\\n]*/g, ' ');",
  "  const WRITE_RE = /^\\s*(UPDATE(\\s+OR\\s+\\w+)?|INSERT(\\s+OR\\s+\\w+)?\\s+INTO|REPLACE\\s+INTO|DELETE\\s+FROM)\\s+[\"`\\[]?(main\\.)?data_models\\b/i;",
  "  const paramsOf = (rest) => { const r = rest.filter((a) => typeof a !== 'function'); if (r.length === 1 && Array.isArray(r[0])) return r[0]; if (r.length === 1 && r[0] && typeof r[0] === 'object') return Object.values(r[0]); return r; };",
  "  const rec = (kind, sql, rest, multi) => {",
  "    try {",
  "      if (typeof sql !== 'string') return;",
  "      const hit = multi ? sql.split(';').some((part) => WRITE_RE.test(strip(part))) : WRITE_RE.test(strip(sql));",
  "      if (!hit) return;",
  "      write({ seq: ++seq, pid: process.pid, kind, sql, params: paramsOf(rest).map((p) => (typeof p === 'string' && p.length > 2000 ? p.slice(0, 2000) + '…' : p)) });",
  "    } catch (_) { /* ignore */ }",
  "  };",
  "  const D = sqlite3.Database.prototype;",
  "  for (const m of ['run', 'get', 'all', 'each']) { const o = D[m]; D[m] = function (sql, ...rest) { rec(m, sql, rest, false); return o.apply(this, arguments); }; }",
  "  { const o = D.exec; D.exec = function (sql, ...rest) { rec('exec', sql, rest, true); return o.apply(this, arguments); }; }",
  "  { const o = D.prepare; D.prepare = function (sql, ...rest) { const st = o.apply(this, arguments); try { st.__mcSql = sql; } catch (_) { /* ignore */ } return st; }; }",
  "  const S = sqlite3.Statement.prototype;",
  "  for (const m of ['run', 'get', 'all', 'each']) { const o = S[m]; S[m] = function (...a) { if (this && this.__mcSql !== undefined) rec('stmt-' + m, this.__mcSql, a, false); return o.apply(this, arguments); }; }",
  "}",
  "",
].join('\n');
/** 追踪日志：读出全部记录（加载标记单列）；文件不存在返回空 */
function readTrace(tracePath) {
  let text = '';
  try { text = fs.readFileSync(tracePath, 'utf8'); } catch (_) { return { marker: null, records: [] }; }
  let marker = null; const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch (_) { continue; }
    if (o.loaded) marker = o; else records.push(o);
  }
  return { marker, records };
}
/** 剥掉 SQL 块注释与行注释并压缩空白（供归因判据用；SQLite 同样忽略注释） */
function stripSql(sql) { return String(sql).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim(); }

function copyCode(codeRoot, dest, label, opts) {
  fs.mkdirSync(path.join(dest, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(codeRoot, 'server.js'), path.join(dest, 'server.js'));
  fs.copyFileSync(path.join(codeRoot, 'package.json'), path.join(dest, 'package.json'));
  for (const d of ['utils', 'routes']) copyTree(path.join(codeRoot, d), path.join(dest, d));
  // wrapper 一律取当前仓库的（基线工作树里的旧 wrapper 语义相同，取一份免得版本差异）
  fs.copyFileSync(path.join(ROOT, 'scripts', '_test-it-asset-ledger-server-wrapper.js'), path.join(dest, 'scripts', '_test-it-asset-ledger-server-wrapper.js'));
  fs.writeFileSync(path.join(dest, 'net-guard.js'), NET_GUARD_SRC);
  fs.writeFileSync(path.join(dest, 'sql-trace.js'), SQL_TRACE_SRC);
  // wrapper 启动校验要求「真实库路径」存在（realpath / inode 比对）：放一个空占位文件；
  // 服务的建库调用被 wrapper 重定向到临时库，这个占位文件永远不会被打开写入
  fs.writeFileSync(path.join(dest, 'task_pool.db'), '');
  // 浏览器类套件（Playwright）需要静态页面：opts.withPublic 时一并复制 public/（约 5MB）
  if (opts && opts.withPublic) copyTree(path.join(codeRoot, 'public'), path.join(dest, 'public'));
  else {
    // #77 C2b-3：服务端 routes/model-center/model-relations.js 直接 require 前端 UMD 模块（上游与抽屉血缘卡同源），副本里必须带上这一个文件
    const umd = ['public', 'assets', 'js', 'model-detail-normalize.js'];
    if (fs.existsSync(path.join(codeRoot, ...umd))) {
      fs.mkdirSync(path.dirname(path.join(dest, ...umd)), { recursive: true });
      fs.copyFileSync(path.join(codeRoot, ...umd), path.join(dest, ...umd));
    }
  }
  return { label, copyRoot: dest };
}

function replaceExactlyOnce(file, from, to, what) {
  let text = fs.readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';           // 坑 23：锚点按目标文件行尾规格化
  const f = from.split('\n').join(eol);
  const parts = text.split(f);
  if (parts.length !== 2) throw new Error(`变异锚点命中 ${parts.length - 1} 次（必须恰 1 次）：${what}`);
  text = parts[0] + to.split('\n').join(eol) + parts[1];
  fs.writeFileSync(file, text);
}

// ───────────────────────────── 库连接：写连接（带计数闸）/ 只读连接 ─────────────────────────────
function wrapDb(db, { readonly, gate }) {
  const p = (m, sql, params) => new Promise((resolve, reject) => {
    db[m](sql, params || [], function (err, rows) { if (err) reject(err); else resolve(m === 'run' ? { lastID: this.lastID, changes: this.changes } : rows); });
  });
  const api = {
    get: (s, a) => p('get', s, a), all: (s, a) => p('all', s, a),
    close: () => new Promise(r => db.close(() => r())),
  };
  if (!readonly) {
    // 写连接的 run / get / all / exec 一律过闸：服务运行期间任何使用都计数并拒绝（读也不行——写连接会持有锁 / 触发检查点）
    const guarded = (m, fn) => (s, a) => {
      if (gate && gate.up) { gate.writes++; return Promise.reject(new Error(`测试进程在服务运行期间使用写连接 ${m}（已计数并拒绝）：` + String(s).slice(0, 80))); }
      if (gate && m === 'run') gate.fixtureWrites++;
      return fn(s, a);
    };
    api.run = guarded('run', (s, a) => p('run', s, a));
    api.get = guarded('get', (s, a) => p('get', s, a));
    api.all = guarded('all', (s, a) => p('all', s, a));
    api.exec = guarded('exec', (s) => new Promise((resolve, reject) => db.exec(s, (err) => (err ? reject(err) : resolve()))));
  }
  return api;
}
/** 写连接：只能在服务停止时用；gate.up 为真时任何 run 都计数并抛错 */
async function openWriter(dbPath, gate) {
  const w = wrapDb(new sqlite3.Database(dbPath), { readonly: false, gate });
  await w.run('PRAGMA busy_timeout = 8000');
  return w;
}
/** 只读连接（OPEN_READONLY）：没有 run 方法，结构上不可能写 */
function openReader(dbPath) {
  return new Promise((resolve, reject) => {
    const raw = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
      if (err) return reject(err);
      const r = wrapDb(raw, { readonly: true });
      raw.run('PRAGMA busy_timeout = 8000', () => resolve(r));
    });
  });
}

async function pickPort() {
  const holder = http.createServer();
  const srv = await listenOnSafePort(holder);
  const port = srv.address().port;
  await new Promise(r => srv.close(r));
  return port;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
/** 强杀进程树并复查 pid 已不存在（最多同步等 3 秒）；仍存在 ⇒ 记清理失败 */
function killPid(pid) {
  try { spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' }); } catch (_) { /* 下面复查 */ }
  for (let i = 0; i < 15 && pidAlive(pid); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  if (pidAlive(pid)) noteCleanupFailure(`taskkill 之后进程 ${pid} 仍存在`);
}

/** 服务日志里是否有 net-guard 的加载标记（pid 必须等于所起进程；pid 后用非数字边界，避免 12 匹配 123） */
function guardMarkerPresent(logText, pid) {
  return new RegExp(`\\[net-guard\\] loaded pid=${pid}(?!\\d)`).test(logText);
}

// 冷启动「建表完成」的明确信号：只读查询这些关键表与列全部存在（不靠日志静默）
const CORE_TABLES = ['data_models', 'model_test_records', 'task_pool', 'users', 'system_configs', 'sys_issues', 'model_change_logs', 'task_attachments', 'model_impl_objects', 'model_impl_links'];
const CORE_COLUMNS = [['data_models', ['config_rev', 'companion_of', 'script_path', 'is_deleted', 'impl_note']], ['model_test_records', ['config_rev', 'invalidated']], ['task_pool', ['linked_model_id', 'created_at']], ['sys_issues', ['fast_release_auth_at']]];
const COLD_START_MAX_ATTEMPTS = 4;

/** 只读探测库里关键表与列是否都已建好；库不存在 / 被占用 / 读失败一律返回 false（调用方继续轮询） */
async function schemaReady(dbPath) {
  if (!fs.existsSync(dbPath)) return false;
  let rd = null;
  try {
    rd = await openReader(dbPath);
    const tables = (await rd.all("SELECT name FROM sqlite_master WHERE type = 'table'")).map(r => r.name);
    if (CORE_TABLES.some(t => !tables.includes(t))) return false;
    for (const [t, cols] of CORE_COLUMNS) {
      const have = (await rd.all(`PRAGMA table_info(${t})`)).map(c => c.name);
      if (cols.some(c => !have.includes(c))) return false;
    }
    return true;
  } catch (_) { return false; }
  finally { if (rd) { try { await rd.close(); } catch (_) { /* ignore */ } } }
}

/**
 * 冷启动失败后、对同一库重启之前，处理崩溃进程的残留：有 -journal（热日志）/ -wal / -shm 就用读写连接打开一次让 SQLite 自己恢复
 * （回滚热日志 / 回放 WAL；不能直接删 -journal，删了会让半写的页留在主库里）。恢复失败才丢弃整个临时库（调用方随后从空库重来）。
 * 只处理 TMP_BASE 之下的文件。返回一行给日志的说明。
 */
async function recoverDbAfterCrash(dbPath) {
  const base = path.resolve(dbPath);
  if (!base.startsWith(TMP_BASE + path.sep) || base === REAL_DB_ABS) throw new Error(`recoverDbAfterCrash 拒绝处理临时根之外的文件：${base}`);
  const left = ['-journal', '-wal', '-shm'].filter(s => fs.existsSync(base + s));
  if (!fs.existsSync(base)) return '库文件尚未生成，无需恢复';
  if (!left.length) return '无 -journal / -wal / -shm 残留';
  try {
    await new Promise((resolve, reject) => { const d = new sqlite3.Database(base, (e) => { if (e) return reject(e); d.get('SELECT count(*) AS c FROM sqlite_master', (e2) => d.close(() => (e2 ? reject(e2) : resolve()))); }); });
    const still = ['-journal', '-wal', '-shm'].filter(s => fs.existsSync(base + s));
    return `发现残留 ${left.join(',')}，读写连接恢复后仍剩 ${still.join(',') || '（无）'}`;
  } catch (e) {
    const removed = removeDbFiles(base);
    return `发现残留 ${left.join(',')}，恢复失败（${e.code || e.message}），已丢弃 ${removed.join(',')} 从空库重来`;
  }
}

/** 删掉一个临时库及其 -journal / -wal / -shm（只允许删 TMP_BASE 之下的文件；仅作恢复失败时的兜底） */
function removeDbFiles(dbPath) {
  const base = path.resolve(dbPath);
  if (!base.startsWith(TMP_BASE + path.sep) || base === REAL_DB_ABS) throw new Error(`removeDbFiles 拒绝处理临时根之外的文件：${base}`);
  const removed = [];
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const f = base + suffix;
    if (fs.existsSync(f)) { try { fs.unlinkSync(f); removed.push(path.basename(f)); } catch (_) { /* 仍被占用：下一轮 existsSync 复查 */ } }
  }
  return removed;
}

// 冷启动「建表启动」的已知 Uncaught 白名单（既有债：空库首次启动时启动扫描 / 巡检在建表前查表，logger 把错误打成 `[Error: SQLITE_ERROR: no such table: main.xxx] {` 一行加 errno / code 两行，
// 且每条同时出现在裸输出与 `[ERROR] <时间戳> ` 前缀两处；服务随后 1 秒内 process.exit(1)）。按错误原文精确匹配；白名单以外的 Uncaught 一律判失败。
// 表名限定 collab_ 前缀（2026-10-01 实测仅 collab_requests / collab_dev_plan_items / collab_operation_logs / collab_attachments 四张，来自数据协作模块启动扫描）。
const BUILD_START_UNCAUGHT_WHITELIST = [/^\[Error: SQLITE_ERROR: no such table: (?:main\.)?collab_[A-Za-z0-9_]*\] \{\s*$/];
/** 把服务日志里每一处 `Uncaught Exception:` 之后的首行原文按白名单分类：{ total, known: Map<原文,次数>, unknown: string[] } */
function classifyUncaught(logText) {
  const known = new Map(); const unknown = []; let total = 0;
  for (const m of String(logText).matchAll(/Uncaught Exception:[ \t]*(.*)/g)) {
    total++;
    const line = m[1].replace(/\r$/, '');
    if (BUILD_START_UNCAUGHT_WHITELIST.some(re => re.test(line))) known.set(line, (known.get(line) || 0) + 1);
    else unknown.push(line);
  }
  return { total, known, unknown };
}
const fmtUncaught = (c) => `已知(no such table) ×${[...c.known.values()].reduce((a, b) => a + b, 0)}（${[...c.known.keys()].map(k => k.replace(/^\[Error: SQLITE_ERROR: /, '').replace(/\] \{\s*$/, '')).join('；') || '无'}）、白名单外 ×${c.unknown.length}${c.unknown.length ? '：' + c.unknown.join(' | ') : ''}`;

/**
 * 起被测服务；copyRoot 已含源码。返回 { baseUrl, port, pid, logPath, stop, guardLoaded, attempts, state }
 * coldStart=true（空库首次启动）：先等「关键表与列全部存在」的只读探测信号，再做静默确认；任一环节进程退出（已知的冷启动竞态：
 *   启动扫描在建表前查表 → 未捕获异常 → 约 1 秒后 process.exit(1)，可能留下热日志 -journal；实测空库首次启动几乎必崩一次，第二次在已建表的库上稳定）
 *   → 记一行日志、用读写连接恢复该进程残留（recoverDbAfterCrash）、对同一库重启，最多 COLD_START_MAX_ATTEMPTS 次，仍失败则带每次诊断抛错。
 * injectCrashOnAttempt1（仅测试用故障注入）：第 1 次冷启动在服务起来后 0.3 秒强杀进程，证明重试路径能恢复。
 */
async function startInstance({ copyRoot, dbPath, tag, coldStart, injectCrashOnAttempt1, extraEnv }) {
  const logPath = path.join(copyRoot, `${tag}.server.log`);
  const tracePath = path.join(copyRoot, `${tag}.sqltrace.jsonl`);
  let lastErr = null;
  const attemptsLog = [];
  const maxAttempts = coldStart ? COLD_START_MAX_ATTEMPTS : 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (coldStart && attempt > 1) {
      const note = await recoverDbAfterCrash(dbPath);
      console.log(`[cold-start] 第 ${attempt - 1} 次失败（${attemptsLog[attempt - 2]}）；${note}；对同一库第 ${attempt} 次重启`);
    }
    const port = await pickPort();
    if (port === 3000) { attemptsLog.push('端口为 3000，跳过'); continue; }
    fs.writeFileSync(tracePath, '');   // 每次启动一份干净的追踪日志（序号从 1 起，加载标记在首行）
    const fd = fs.openSync(logPath, 'w');
    // 出网拦截经 NODE_OPTIONS=--require 注入：被测服务的子进程（若有）也继承同一份预加载
    const child = spawn(process.execPath, [path.join(copyRoot, 'scripts', '_test-it-asset-ledger-server-wrapper.js')], {
      cwd: copyRoot,
      stdio: ['ignore', fd, fd],
      env: {
        ...process.env,
        NODE_OPTIONS: `--require "${path.join(copyRoot, 'net-guard.js').split(path.sep).join('/')}" --require "${path.join(copyRoot, 'sql-trace.js').split(path.sep).join('/')}"`,
        MC_SQL_TRACE_FILE: tracePath,
        NODE_PATH: path.join(ROOT, 'node_modules'),
        PORT: String(port),
        IA_TEST_DB_PATH: dbPath,
        JWT_SECRET: process.env.JWT_SECRET || '',
        DB_ENCRYPTION_KEY: process.env.DB_ENCRYPTION_KEY || '',
        SYS_FASTLANE_ENABLE: '0',
        ...(extraEnv || {}),   // G1：时区实例用 { TZ: 'UTC' }（Windows 上对 Node 与 SQLite localtime 都生效，已探测）
        LOG_LEVEL: 'INFO',
      },
    });
    fs.closeSync(fd);
    let exited = false;
    let exitInfo = null;
    child.on('exit', (code, sig) => { exited = true; exitInfo = `exit code=${code} signal=${sig}`; });
    // 必须确认进程真的退出（事件 + pid 不存在）；超时判失败而不是继续（调用方据此才放开写闸）
    const stop = async () => {
      if (!exited) { killPid(child.pid); for (let i = 0; i < 50 && !exited; i++) await new Promise(r => setTimeout(r, 100)); }
      if (!exited) {
        let alive = true;
        try { process.kill(child.pid, 0); } catch (e) { alive = e.code === 'EPERM'; }
        if (alive) throw new Error(`被测服务进程 ${child.pid} 未能在 5 秒内退出（不放开写闸）`);
      }
    };
    registerCleanup(() => { if (!exited) killPid(child.pid); });
    const deadline = Date.now() + 40000;
    let up = false;
    while (Date.now() < deadline) {
      const log = fs.readFileSync(logPath, 'utf8');
      if (/Task Pool Server running/.test(log)) { up = true; break; }
      if (exited) break;
      await new Promise(r => setTimeout(r, 200));
    }
    let schemaOk = true;
    if (up && coldStart) {
      // 冷启动：以「关键表与列全部存在」的只读探测为建表完成信号（不靠日志静默）；进程在此之前退出 = 本次失败
      if (injectCrashOnAttempt1 && attempt === 1) { await new Promise(r => setTimeout(r, 300)); killPid(child.pid); }
      schemaOk = false;
      const tr = Date.now();
      while (Date.now() - tr < 30000 && !exited) {
        if (await schemaReady(dbPath)) { schemaOk = true; break; }
        await new Promise(r => setTimeout(r, 250));
      }
    }
    if (up && schemaOk) {
      // 等启动期的 ALTER / initSchema / 3 秒延迟的迁移标记检查全部落定：日志连续 1.5 秒无新增且距启动满 4.5 秒
      // （冷启动竞态导致的退出在这里或上面的建表信号阶段被发现：退出则判本次失败，冷启动路径清理后从空库重来）
      const t0 = Date.now();
      let lastSize = -1, lastChange = Date.now();
      while (Date.now() - t0 < 15000 && !exited) {
        const size = fs.statSync(logPath).size;
        if (size !== lastSize) { lastSize = size; lastChange = Date.now(); }
        if (Date.now() - lastChange >= 1500 && Date.now() - t0 >= 4500) break;
        await new Promise(r => setTimeout(r, 200));
      }
      if (!exited) {
        // 证明「服务加载了 guard」：日志里必须有带本进程 pid 的加载标记；没有即判失败（不重试——guard 没加载意味着出网拦截不成立）
        const guardLoaded = guardMarkerPresent(fs.readFileSync(logPath, 'utf8'), child.pid);
        if (!guardLoaded) {
          const tailLog = fs.readFileSync(logPath, 'utf8').slice(0, 400);
          await stop();
          throw new Error(`被测服务日志里没有 net-guard 加载标记 "[net-guard] loaded pid=${child.pid}"（出网拦截未加载，判失败）。日志开头：${tailLog}`);
        }
        // SQL 追踪器同样要证明加载：追踪日志首行的加载标记存在且 pid 与所起进程一致，否则判失败（不重试）
        const trMark = readTrace(tracePath).marker;
        const traceLoaded = !!(trMark && trMark.pid === child.pid);
        if (!traceLoaded) { await stop(); throw new Error(`被测服务的 SQL 追踪日志里没有加载标记（pid=${child.pid}；marker=${JSON.stringify(trMark)}），写点级归因不成立，判失败`); }
        // 冷启动重试不得掩盖真实的启动期异常：被采用的这一次启动（日志按次 'w' 重开）里 Uncaught Exception 必须为 0（预筛 LOW-3）
        const okCls = classifyUncaught(fs.readFileSync(logPath, 'utf8'));
        if (okCls.total > 0) {
          // 空库第 1 次启动 = 建表启动：Uncaught 全部属于白名单（no such table）⇒ 停掉重启（被采用的那次启动仍须 0）；白名单以外 ⇒ 判失败
          if (coldStart && attempt === 1 && okCls.unknown.length === 0) {
            console.log(`[cold-start] 建表启动（第 1 次，报了就绪但日志里有 Uncaught）分类：${fmtUncaught(okCls)}；停掉并重启`);
            attemptsLog.push(`建表启动：就绪后崩溃前被停；Uncaught ${fmtUncaught(okCls)}`);
            await stop();
            continue;
          }
          await stop(); throw new Error(`被测服务第 ${attempt} 次启动虽已就绪，但日志里有 Uncaught Exception ×${okCls.total}（启动期异常不得被重试掩盖；${fmtUncaught(okCls)}），判失败`);
        }
        return { baseUrl: `http://127.0.0.1:${port}`, port, pid: child.pid, logPath, tracePath, traceLoaded, stop, guardLoaded, attempts: attempt, state: () => (exited ? exitInfo || 'exited' : 'running') };
      }
    }
    const failLog = fs.readFileSync(logPath, 'utf8');
    lastErr = failLog.slice(-600);
    if (coldStart && attempt === 1) {
      // 建表启动（空库第 1 次启动）：打印 Uncaught 分类；出现白名单以外的 Uncaught ⇒ 判失败（不重试掩盖）
      const bc = classifyUncaught(failLog);
      console.log(`[cold-start] 建表启动（第 1 次）Uncaught 分类：${fmtUncaught(bc)}`);
      if (bc.unknown.length > 0) { await stop(); throw new Error(`建表启动出现白名单以外的 Uncaught Exception ×${bc.unknown.length}：${bc.unknown.join(' | ')}`); }
    }
    attemptsLog.push(`${exited ? '进程退出（' + exitInfo + '）' : (up ? (schemaOk ? '静默确认期间未稳定' : '30 秒内建表信号未出现') : '服务未起来')}；日志里 Uncaught Exception ×${(failLog.match(/Uncaught Exception/g) || []).length}`);
    await stop();
  }
  throw new Error(`被测服务启动失败（${coldStart ? '冷启动' : '普通启动'}，共 ${maxAttempts} 次）：\n  ${attemptsLog.map((x, i) => `第 ${i + 1} 次：${x}`).join('\n  ')}\n  最后一次日志尾部：${lastErr}`);
}

/** 服务控制器：start / stop 同步维护写闸（gate.up） */
function makeService({ copyRoot, dbPath, tag, gate, extraEnv }) {
  const svc = { inst: null, gate, copyRoot, dbPath };
  svc.start = async (opts) => { svc.inst = await startInstance({ copyRoot, dbPath, tag, extraEnv, ...(opts || {}) }); gate.up = true; };
  svc.stop = async () => { if (svc.inst) await svc.inst.stop(); gate.up = false; svc.inst = null; };
  Object.defineProperty(svc, 'baseUrl', { get: () => svc.inst.baseUrl });
  Object.defineProperty(svc, 'port', { get: () => svc.inst.port });
  return svc;
}

/**
 * 在临时目录建空库：用被测代码启动一次让它自建全部表 → 停服务 → 只读校验关键表与列 → 写库切 WAL。
 * 返回 { report }。全程不读本机 task_pool.db。
 */
async function createFreshDb(svc, opts) {
  const dest = path.resolve(svc.dbPath);
  if (!dest.startsWith(TMP_BASE + path.sep) || dest === REAL_DB_ABS) throw new Error(`库必须位于临时根内：${dest}`);
  if (fs.existsSync(dest)) throw new Error(`期望是全新空库，但文件已存在：${dest}`);
  // 冷启动走确定性流程（startInstance coldStart）：建表信号 + 失败清理重来；MC_COLD_INJECT_CRASH=1 或 opts.injectCrash 是仅测试用的故障注入（首次冷启动必退出一次）
  await svc.start({ coldStart: true, injectCrashOnAttempt1: !!(opts && opts.injectCrash) || process.env.MC_COLD_INJECT_CRASH === '1' });
  const coldAttempts = svc.inst.attempts;
  await svc.stop();
  // 被强杀的进程若留下热日志 / WAL，只读连接读库会 SQLITE_READONLY（回滚需要写权限）：先用读写连接打开一次让 SQLite 自己恢复
  const leftovers = ['-journal', '-wal', '-shm'].filter(s => fs.existsSync(dest + s));
  if (leftovers.length) {
    await new Promise((resolve, reject) => { const d = new sqlite3.Database(dest, (e) => { if (e) return reject(e); d.get('SELECT count(*) AS c FROM sqlite_master', (e2) => d.close(() => (e2 ? reject(e2) : resolve()))); }); });
    console.log(`[cold-start] 停服后发现残留 ${leftovers.join(',')}，已用读写连接恢复后再只读校验`);
  }
  const rd = await openReader(dest);
  const report = [];
  try {
    const tables = (await rd.all("SELECT name FROM sqlite_master WHERE type = 'table'")).map(r => r.name);
    const need = CORE_TABLES;
    const missing = need.filter(t => !tables.includes(t));
    if (missing.length) throw new Error(`被测代码自建库后缺表：${missing.join(', ')}（已有表 ${tables.length} 张）`);
    for (const [t, cols] of CORE_COLUMNS) {
      const have = (await rd.all(`PRAGMA table_info(${t})`)).map(c => c.name);
      const miss = cols.filter(c => !have.includes(c));
      if (miss.length) throw new Error(`${t} 缺列：${miss.join(', ')}`);
    }
    const cfg = await rd.get('SELECT COUNT(*) AS c FROM system_configs');
    const cand = await rd.get('SELECT COUNT(*) AS c FROM sys_issues WHERE fast_release_auth_at IS NOT NULL');
    report.push(`空库由被测代码自建：${tables.length} 张表（关键表与 config_rev / invalidated 列已核对）；冷启动第 ${coldAttempts} 次成功（建表信号=只读探测关键表与列）；不读本机 task_pool.db`);
    report.push(`system_configs 行数 = ${cfg.c}（无钉钉凭证 / 通知开关）；sys_issues 中 fast_release_auth_at 非空的行 = ${cand.c}（#73 到期扫描候选恒空）`);
    if (cfg.c !== 0 || cand.c !== 0) throw new Error('新建空库里出现了预期外的种子数据（凭证 / 到期扫描候选），不能启动做测试');
  } finally { await rd.close(); }
  return { report };
}

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username, role: user.role, display_name: user.display_name }, process.env.JWT_SECRET, { expiresIn: '2h' });
}

function makeApi(baseUrlOrGetter) {
  return async function api(method, urlPath, { token, body } = {}) {
    const baseUrl = typeof baseUrlOrGetter === 'function' ? baseUrlOrGetter() : baseUrlOrGetter;
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try { res = await fetch(baseUrl + urlPath, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }); }
    catch (e) { throw new Error(`${method} ${urlPath}: ${e.message}${e.cause ? ' cause=' + (e.cause.code || e.cause.message) : ''}`); }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* 非 JSON */ }
    return { status: res.status, json, text };
  };
}

// ───────────────────────────── 夹具（只在服务停止时，经写连接使用）─────────────────────────────
function makeFixtures(db) {
  let seq = 0;
  const nextName = (tag) => `mc_${tag}_${Date.now().toString(36)}_${++seq}`;
  return {
    nextName,
    async user(username, role) {
      const r = await db.run("INSERT INTO users (username, password, display_name, role, status) VALUES (?, 'not-used-jwt-only', ?, ?, 'active')", [`${username}_${Date.now().toString(36)}`, `${username}${seq++}`, role]);
      const row = await db.get('SELECT id, username, display_name, role FROM users WHERE id = ?', [r.lastID]);
      return { ...row, token: signToken(row) };
    },
    async model(f) {
      const row = {
        layer: 'ODS', domain: 'MCDOM', table_name: nextName('m'), table_comment: 'mc 夹具', tech_owner: 'mc_tech', biz_owner: 'mc_biz',
        update_cycle: 'di', status: 'DEVELOPING', source_table: 'src_a', source_system: 'SYS_A', model_type: 'TABLE', created_by_id: 1,
        category: 'general', dim_config: null, config_mode: 'standard', design_notes: null, companion_of: null, is_deleted: 0, ...f,
      };
      if (row.dim_config && typeof row.dim_config !== 'string') row.dim_config = JSON.stringify(row.dim_config);
      const cols = Object.keys(row);
      const r = await db.run(`INSERT INTO data_models (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, cols.map(c => row[c]));
      return r.lastID;
    },
    /** 验收记录：phase=null 表示 ODS 无 phase；config_rev 缺省取模型当前版本 */
    async record(modelId, { phase = null, result = 'pass', time = '2026-01-01 00:00:00', rev, invalidated = 0 } = {}) {
      const m = await db.get('SELECT table_name, config_rev FROM data_models WHERE id = ?', [modelId]);
      const detail = phase ? JSON.stringify({ phase }) : JSON.stringify({ summary: {} });
      const r = await db.run(
        `INSERT INTO model_test_records (model_id, table_name, test_time, test_user, overall_result, total_rows, detail_json, invalidated, config_rev)
         VALUES (?, ?, ?, 'mc_tester', ?, 10, ?, ?, ?)`,
        [modelId, m.table_name, time, result, detail, invalidated, rev === undefined ? m.config_rev : rev]);
      return r.lastID;
    },
    async task(f) {
      const row = { title: nextName('task'), status: 'DONE', category: 'ODS_SYNC', created_at: '2026-03-10 12:00:00', ...f };
      const cols = Object.keys(row);
      const r = await db.run(`INSERT INTO task_pool (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, cols.map(c => row[c]));
      return r.lastID;
    },
  };
}

/** P1：等被测实例日志出现时区一致性自检的结论行（通过 / [TZ-MISMATCH] 告警 / 重试耗尽失败）；超时抛错并带日志尾部 */
async function waitTzConclusion(inst, what) {
  const re = /时区一致性自检通过|\[TZ-MISMATCH\]|时区一致性自检失败，按时区不一致处理/;
  const ok = await waitFor(() => re.test(fs.readFileSync(inst.logPath, 'utf8')), 15000, 50);
  if (!ok) throw new Error(`时区自检结论行 15s 内未出现（${what}）：${fs.readFileSync(inst.logPath, 'utf8').slice(-600)}`);
}

async function waitFor(fn, timeoutMs = 4000, intervalMs = 60) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await new Promise(r => setTimeout(r, intervalMs));
  }
}
const settle = (ms = 500) => new Promise(r => setTimeout(r, ms));

// ───────────────────────────── 测试主体 ─────────────────────────────
const NET_PROBE_SRC = [
  "const net = require('net');",
  "const out = []; let n = 0;",
  "function step() { if (++n === 11) { console.log(out.join('|')); process.exit(0); } }",
  "const dgram = require('dgram'); const dns = require('dns');",
  "const u = dgram.createSocket('udp4');",
  "u.send(Buffer.from('x'), 9, '192.0.2.1', (e) => { out.push('udp:' + (e ? e.message : 'SENT')); u.close(); step(); });",
  "dns.lookup('mc-blocked.example', (e) => { out.push('dns:' + (e ? e.message : 'RESOLVED')); step(); });",
  // DNS 其余入口：dns.resolve4 / dns.promises.resolve4 / new dns.Resolver().resolve4（探针共 11 项，完成计数 = 11）
  "dns.resolve4('mc-blocked.example', (e) => { out.push('r4:' + (e ? e.message : 'RESOLVED')); step(); });",
  "dns.promises.resolve4('mc-blocked.example').then(() => { out.push('pr4:RESOLVED'); step(); }, (e) => { out.push('pr4:' + e.message); step(); });",
  "new dns.Resolver().resolve4('mc-blocked.example', (e) => { out.push('rs4:' + (e ? e.message : 'RESOLVED')); step(); });",
  "new dns.promises.Resolver().resolve4('mc-blocked.example').then(() => { out.push('prs4:RESOLVED'); step(); }, (e) => { out.push('prs4:' + e.message); step(); });",
  "dns.resolve6('mc-blocked.example', (e) => { out.push('r6:' + (e ? e.message : 'RESOLVED')); step(); });",
  "dns.reverse('192.0.2.1', (e) => { out.push('rev:' + (e ? e.message : 'RESOLVED')); step(); });",
  "dns.lookupService('192.0.2.1', 80, (e) => { out.push('ls:' + (e ? e.message : 'RESOLVED')); step(); });",
  "const a = net.connect({ host: '192.0.2.1', port: 1433 });",
  "a.on('error', (e) => { out.push('ext:' + e.message); step(); });",
  "a.on('connect', () => { out.push('ext:CONNECTED'); a.destroy(); step(); });",
  "const b = net.connect({ host: '127.0.0.1', port: Number(process.env.PROBE_PORT) });",
  "b.on('connect', () => { out.push('lo:CONNECTED'); b.destroy(); step(); });",
  "b.on('error', (e) => { out.push('lo:' + e.message); step(); });",
  "setTimeout(() => { console.log(out.join('|') + '|TIMEOUT'); process.exit(2); }, 8000);",
].join('\n');

// K1 / L1 写入点的变异锚点表：pre = 前置查询的 [from, to]；stmt = 语句级条件的 [from, to]（stmtAll = [from, to, 命中次数]：同形语句多处时整体替换）
const LINK_MUTATIONS = {
  update: {
    pre: ['            if (model.companion_of != null && !linkUnchanged) {', '            if (false) {'],
    stmt: ['linked_model_name = ? WHERE id = ? AND ((linked_model_id = ? AND status = \'ARCHIVED\') OR NOT EXISTS (SELECT 1 FROM data_models WHERE id = ? AND companion_of IS NOT NULL)) AND (status IS NULL OR status != \'DONE\' OR linked_model_id IS ?)",\n                [title, desc || \'\', validCategory, linked_model_id, model.table_name, id, linked_model_id, linked_model_id, linked_model_id]',   // 末次合并审 H3：语句级条件后多了 DONE 门条件与一个绑定参数，锚点随之更新（去掉整句条件 = K1 条件与 DONE 门条件一起去）
      'linked_model_name = ? WHERE id = ?",\n                [title, desc || \'\', validCategory, linked_model_id, model.table_name, id]'],
  },
  create: {
    pre: ['            if (target && target.companion_of != null) {', '            if (false) {'],
    stmt: [' WHERE NOT EXISTS (SELECT 1 FROM data_models WHERE id = ? AND companion_of IS NOT NULL)");\n    stmt.run(title.trim(), desc || \'\', req.user.id, validCategory, validPriority, linked_model_id === undefined ? null : linked_model_id, validEstHours, validDeadline, beijingTime, linked_model_id === undefined ? null : linked_model_id, function (err) {',
      '");\n    stmt.run(title.trim(), desc || \'\', req.user.id, validCategory, validPriority, linked_model_id === undefined ? null : linked_model_id, validEstHours, validDeadline, beijingTime, function (err) {'],
  },
  batch: {
    pre: ['                        // K1：伴生表不能单独关联任务（批量导入按条计失败，不整批 400）\n                        if (model.companion_of != null) { failCount++; continue; }',
      '                        // K1：伴生表不能单独关联任务（批量导入按条计失败，不整批 400）\n                        if (false) { failCount++; continue; }'],
    stmt: [' WHERE NOT EXISTS (SELECT 1 FROM data_models WHERE id = ? AND companion_of IS NOT NULL)",\n                    [task.title, task.desc, userId, task.category, linked_model_id, linked_model_name, linked_model_id]',
      '",\n                    [task.title, task.desc, userId, task.category, linked_model_id, linked_model_name]'],
  },
  quick: {
    pre: ['        // K1：伴生表不能单独关联任务（前置查询；INSERT 语句本身另带同一条件，零写入）\n        if (model.companion_of != null) {', '        // K1：伴生表不能单独关联任务（前置查询；INSERT 语句本身另带同一条件，零写入）\n        if (false) {'],
    stmt: ['\n             WHERE NOT EXISTS (SELECT 1 FROM data_models WHERE id = ? AND companion_of IS NOT NULL)`,\n            [taskTitle, taskDesc, userId, userName, userId, taskCategory, parseInt(id), beijingTime, beijingTime, beijingTime, parseInt(id)]',
      '`,\n            [taskTitle, taskDesc, userId, userName, userId, taskCategory, parseInt(id), beijingTime, beijingTime, beijingTime]'],
  },
  reopen: {
    pre: ['            if (cm && cm.companion_of != null) return res.status(400)', '            if (false) return res.status(400)'],
    stmtAll: [' AND NOT EXISTS (SELECT 1 FROM data_models WHERE id = task_pool.linked_model_id AND companion_of IS NOT NULL)', '', 2],
  },
};

/**
 * @param {object} cfg { groups:Set<string>, mutation:null|'bump0'|'gate-task', quiet:boolean }
 * @returns {Promise<{results:Array<{name,ok,detail}>, neutralized:string[], writeEvidence:object}>}
 */
async function runSuite(cfg) {
  const results = [];
  const check = (name, cond, detail) => { results.push({ name, ok: !!cond, detail: cond ? '' : detail }); if (!cond && !cfg.quiet) console.log(`FAIL ${name}${detail === undefined ? '' : '\n  ' + detail}`); };
  const runDir = makeRunDir(cfg.mutation ? `http-${cfg.mutation.replace(/[^\w.-]/g, '_')}` : 'http');
  const { copyRoot } = copyCode(ROOT, path.join(runDir, 'svc'), 'after');
  if (cfg.mutation === 'bump0') {
    replaceExactlyOnce(path.join(copyRoot, 'server.js'), 'const configRevBump = configRevChanged ? 1 : 0;', 'const configRevBump = 0;', 'PUT config_rev 参数计算');
  } else if (cfg.mutation === 'gate-task') {
    // K3 起 archivable-task 与 can-self-archive / confirm 共用 archiveGateDecision：锚点是共享函数里非管理员 ODS 判定的两行（checkAllValidationsPassed 里还有一句同形的调用，不能只靠单行锚点）；
    //   删掉 task 实参会让三处门禁同时丢任务时间条件，「早于 / 同秒」断言（含 archivable-task 的）须判红
    replaceExactlyOnce(path.join(copyRoot, 'server.js'),
      "    const ev = await evaluateModelAcceptance(task.linked_model_id, { task });\n    const s = ev.snap",
      "    const ev = await evaluateModelAcceptance(task.linked_model_id, {});\n    const s = ev.snap",
      '共享归档门禁判定：ODS 判定的 task 实参');
  } else if (cfg.mutation === 'comment-bump') {
    const srv = path.join(copyRoot, 'server.js');
    replaceExactlyOnce(srv, 'impl_note = ?,\n                    ${CONFIG_REV_BUMP_SQL},\n                    updated_at', 'impl_note = ?,\n                    /* ${CONFIG_REV_BUMP_SQL} */\n                    updated_at', 'PUT 不带 dim_config 分支：递增插值挪进 SQL 块注释');
    replaceExactlyOnce(srv, 'finalUpdateCycle, finalDomain, finalConfigMode, finalDesignNotes, finalImplNote,\n                configRevBump, id', 'finalUpdateCycle, finalDomain, finalConfigMode, finalDesignNotes, finalImplNote,\n                id', 'PUT 不带 dim_config 分支：去掉对应绑定参数');
    replaceExactlyOnce(srv, '            }\n\n            // 记录变更日志（只有实际变化时才记录）', '            }\n            if (configRevBump && !dimConfigProvided) { bumpConfigRev(db, [id]); }   // M-D：不带 dim_config 分支里另一条助手语句顶替递增\n\n            // 记录变更日志（只有实际变化时才记录）', 'PUT：同一请求里额外执行 bumpConfigRev');
  } else if (cfg.mutation === 'bump-move-save') {
    // M-E（codex 22-R3 H）：save-scripts 的 bumpConfigRev 从「写文件之前」迁到「UPDATE script_path 之后」——请求级 +1 仍成立，目标 SQL 仍在窗口内，只有顺序变了
    const srv = path.join(copyRoot, 'server.js');
    replaceExactlyOnce(srv, '        if (configRevBumped) {\n            await bumpConfigRev(db, [id]);\n        }\n\n        for (const w of pendingWrites) {', '        for (const w of pendingWrites) {', 'save-scripts：删掉原位置的 bumpConfigRev');
    replaceExactlyOnce(srv, '        const logParts = [];\n        if (savedFiles.length) logParts.push(', '        if (configRevBumped) { await bumpConfigRev(db, [id]); }   // M-E：迁到目标 UPDATE 之后\n        const logParts = [];\n        if (savedFiles.length) logParts.push(', 'save-scripts：UPDATE script_path 之后补调 bumpConfigRev');
  } else if (cfg.mutation === 'bump-move-edit-new') {
    // M-F：edit-script 首次建目录——bumpConfigRev 从「UPDATE script_path 之后」迁到「之前」（仅 script_path 为空的分支；其余情形仍在原位，请求级 +1 处处成立）
    const srv = path.join(copyRoot, 'server.js');
    replaceExactlyOnce(srv, '        let scriptPath = model.script_path;\n        if (!scriptPath) {', '        let scriptPath = model.script_path;\n        const hadScriptPathM = !!scriptPath;\n        if (!scriptPath) {', 'edit-script：记下进入时 script_path 是否已有');
    replaceExactlyOnce(srv, '            scriptPath = `${userName}/${safeTableName}`;\n', '            scriptPath = `${userName}/${safeTableName}`;\n            await bumpConfigRev(db, [id]);   // M-F：迁到目标 UPDATE script_path 之前\n', 'edit-script：建目录分支内、UPDATE script_path 之前调 bumpConfigRev');
    replaceExactlyOnce(srv, '        await bumpConfigRev(db, [id]);\n\n        // 写入新内容', '        if (hadScriptPathM) { await bumpConfigRev(db, [id]); }\n\n        // 写入新内容', 'edit-script：原位置仅在 script_path 已有时保留');
  } else if (cfg.mutation === 'bump-move-edit-mark') {
    // M-G：edit-script 人工编辑标记——bumpConfigRev 从「写文件之前」迁到「UPDATE script_modified 之后」
    const srv = path.join(copyRoot, 'server.js');
    replaceExactlyOnce(srv, '        await bumpConfigRev(db, [id]);\n\n        // 写入新内容', '        // 写入新内容', 'edit-script：删掉原位置的 bumpConfigRev');
    replaceExactlyOnce(srv, '        // 写入变更日志：区分"初始化"和"编辑修改"', '        await bumpConfigRev(db, [id]);   // M-G：迁到 UPDATE script_modified 之后\n\n        // 写入变更日志：区分"初始化"和"编辑修改"', 'edit-script：UPDATE script_modified 之后补调 bumpConfigRev');
  } else if (cfg.mutation === 'bump-autosave-skip') {
    // M-H（Opus 预筛 G2）：edit-script 原位 bumpConfigRev 改为只在新建文件时执行，并在「人工编辑标记」块里目标 UPDATE 前补一次——
    //   三个契约条目的顺序 / 邻接 / 请求级 +1 全部仍成立，只有「autoSave 改内容不再递增」；须由 autoSave 分支用例判红
    const srv = path.join(copyRoot, 'server.js');
    replaceExactlyOnce(srv, '        await bumpConfigRev(db, [id]);\n\n        // 写入新内容', '        if (isNewFile) { await bumpConfigRev(db, [id]); }   // M-H\n\n        // 写入新内容', 'edit-script：原位 bumpConfigRev 仅 isNewFile 时执行');
    replaceExactlyOnce(srv, '        if (!isNewFile && !autoSave) {\n            await dbRunAsync(', '        if (!isNewFile && !autoSave) {\n            await bumpConfigRev(db, [id]);   // M-H：目标 UPDATE 前补一次\n            await dbRunAsync(', 'edit-script：人工编辑标记块内补 bumpConfigRev');
  } else if (cfg.mutation === 'summary-key-off') {
    // M-I（#77 C2a）：从 PUT 的 afterValue 里删掉 impl_note 键——对照表仍含 impl_note，摘要对「库里有实现说明的模型」的任何编辑都会多报一项；「摘要不得误报」类用例须判红
    replaceExactlyOnce(path.join(copyRoot, 'server.js'), '                impl_note: finalImplNote, design_notes: finalDesignNotes,\n', '                design_notes: finalDesignNotes,\n', 'PUT afterValue：删掉 impl_note 键');
  } else if (cfg.mutation === 'summary-raw-off') {
    // M-K（#77 C2a 补修）：afterValue 里 tech_owner 改回取请求体原值——部分字段请求体里没带 ⇒ undefined ⇒ 摘要误报「技术负责人」
    replaceExactlyOnce(path.join(copyRoot, 'server.js'), '\n                table_comment: finalTableComment, tech_owner: finalTechOwner, biz_owner', '\n                table_comment: finalTableComment, tech_owner: tech_owner, biz_owner', 'PUT afterValue：tech_owner 改回请求体原值');
  } else if (cfg.mutation === 'basic-raw-off') {
    // M-NC（#77 C2a 补修 P2）：hasBasicInfoChange 改回对 final 值与旧值做原始 !== 比较（NULL 与规范默认值被判为变化）
    replaceExactlyOnce(path.join(copyRoot, 'server.js'), '.some(([k, v]) => normForSummary(k, v) !== normForSummary(k, oldModel[k]));', '.some(([k, v]) => v !== oldModel[k]);', 'PUT hasBasicInfoChange：改回原始 !==');
  } else if (cfg.mutation === 'cs-noop-early') {
    // M-CS（codex 24-R R4）：comment-split 的空操作（expected 与 set 全等）改回查模型之前提前返回 noChange（R4 前的旧写法）——不存在 / 已删除 / 归属不符 / 旧值不符的空操作也会被当成「已满足」
    replaceExactlyOnce(path.join(copyRoot, 'server.js'),
      "        const pre = await dbGetAsync('SELECT * FROM data_models WHERE id = ?', [modelId]);\n        if (!pre) return res.status(404).json({ error: '模型不存在' });\n        // R4（codex 24-R）",
      "        if (expected.table_comment === set.table_comment && expected.impl_note === setImplNote) return res.json({ message: '无变化', noChange: true });   // 变异：R4 前的旧写法\n        const pre = await dbGetAsync('SELECT * FROM data_models WHERE id = ?', [modelId]);\n        if (!pre) return res.status(404).json({ error: '模型不存在' });\n        // R4（codex 24-R）", 'comment-split：空操作提前返回');
  } else if (cfg.mutation === 'cs-rev-sql-off') {
    // M-CR（codex 24-R2 X1）：comment-split 条件写 SQL 去掉 config_rev 条件（占位符个数不变、恒真）——「expected_config_rev 不符 ⇒ 409」「revert 版本不符」类用例须判红
    replaceExactlyOnce(path.join(copyRoot, 'server.js'), ' AND (? IS NULL OR config_rev = ?)";', ' AND (? IS NULL OR ? IS NOT NULL)";', 'comment-split：SQL 去掉 config_rev 条件');
  } else if (cfg.mutation === 'cs-rev-noop-off') {
    // M-CR2：空操作（noChange）路径的前置校验去掉版本条件——「空操作 + expected_config_rev 不符 ⇒ 409」须判红
    replaceExactlyOnce(path.join(copyRoot, 'server.js'), ' && (!hasRevCond || pre.config_rev === body.expected_config_rev);', ';', 'comment-split：空操作前置去掉版本条件');
  } else if (cfg.mutation === 'dir-rule-off') {
    // M-J（C1 对抗审 F1）：删掉目录级规则——bump 只看逐文件 contentChanged；「目录翻转但内容相同」「script_path 不安全」两类须判红
    replaceExactlyOnce(path.join(copyRoot, 'server.js'), 'const configRevBumped = pendingWrites.some(w => w.contentChanged) || dirChanged;', 'const configRevBumped = pendingWrites.some(w => w.contentChanged);', 'save-scripts：删掉目录级规则');
  } else if (cfg.mutation === 'dir-set-off') {
    // M-J2（主会话返工）：删掉「生效集合比较」、改回「目录不同即递增」——「目录翻转但生效集合一致」两个用例须判红
    replaceExactlyOnce(path.join(copyRoot, 'server.js'), 'dirChanged = unsafePrev || (prevResolved !== path.resolve(scriptDir) && await effectiveSetDiffers(prevResolved));', 'dirChanged = unsafePrev || prevResolved !== path.resolve(scriptDir);', 'save-scripts：目录不同即递增');
  } else if (cfg.mutation === 'skip-content') {
    // M-L（Opus 预筛）：生效集合比较里去掉对「跳过写入」文件（新目录现有、本次未写）的内容比较——只比本次写入的文件；四步复现里被跳过的 ddl 已回退，须判红
    replaceExactlyOnce(path.join(copyRoot, 'server.js'), '                    if (newContent !== null && normalizeForCompare(newContent) !== normalizeForCompare(oldContent)) return true;', '                    if (pw && newContent !== null && normalizeForCompare(newContent) !== normalizeForCompare(oldContent)) return true;', 'save-scripts：生效集合只比本次写入的文件');
  } else if (cfg.mutation === 'no-attach-exclude') {
    // M-M（G2 新定义）：去掉对 task_attachments 登记附件的排除（目录列表过滤与读取两处）——已登记附件用例须判红
    const srv = path.join(copyRoot, 'server.js');
    replaceExactlyOnce(srv, " && !attKeys.has(absKey(path.join(dir, ent.name)))", '', 'save-scripts：目录列表不再排除登记附件');
    replaceExactlyOnce(srv, " || attKeys.has(absKey(f)) ||", " ||", 'save-scripts：读取不再排除登记附件');
  } else if (cfg.mutation === 'no-tablename-check') {
    // M-P（H1）：删掉 save-scripts 的「请求表名 = 模型表名」校验——S1 用例须判红
    replaceExactlyOnce(path.join(copyRoot, 'server.js'), 'if (tableName !== model.table_name) {', 'if (false) {', 'save-scripts：删掉表名一致性校验');
  } else if (cfg.mutation === 'no-precheck') {
    // M-O（G3）：去掉 PUT 的前置检查（只留语句级条件 UPDATE）——挂未归档任务时 PUT 返回 200，但该行 companion_of 仍为空（语句级兜底独立生效）
    replaceExactlyOnce(path.join(copyRoot, 'server.js'), '                if (targetRow) {\n                    const openTasks', '                if (false) {\n                    const openTasks', 'PUT：去掉伴生前置检查');
  } else if (cfg.mutation === 'no-same-name-check') {
    // M-N（Q2）：删掉 ① 的「伴生名 = 主表名」硬校验——用例须判红（200 而非 400），但 ② 的兜底仍须让主表 companion_of 为空
    replaceExactlyOnce(path.join(copyRoot, 'server.js'), "if ([oldModel.table_name, table_name].some(n => n && String(n).toLowerCase() === String(companionTableName).toLowerCase())) {", 'if (false) {', 'PUT：删掉伴生名 = 主表名硬校验');
  } else if (/^link-(pre|guard)-off:/.test(cfg.mutation)) {
    // M-Q 系列（K1 / L1 / L3）：同一写入点的「前置查询」与「语句级条件」两层各自可去——
    //   pre-off（只去前置、留语句级）：期望 400 / 计失败 / 零写入仍成立（用例不红，证明语句级条件独立生效）；
    //   guard-off（前置与语句级都去）：期望对应拒绝用例判红（证明「不红」不是用例没牙）
    const [kind, which] = cfg.mutation.replace(/^link-/, '').split('-off:');
    const srv = path.join(copyRoot, 'server.js');
    const LM = LINK_MUTATIONS[which];
    if (!LM) throw new Error('未知写入点变异：' + cfg.mutation);
    replaceExactlyOnce(srv, LM.pre[0], LM.pre[1], `${which}：去掉前置查询`);
    if (kind === 'guard') {
      if (LM.stmtAll) {
        const txt = fs.readFileSync(srv, 'utf8');
        const parts = txt.split(LM.stmtAll[0]);
        if (parts.length !== LM.stmtAll[2] + 1) throw new Error(`变异锚点命中 ${parts.length - 1} 次（须 ${LM.stmtAll[2]} 次）：${which}：去掉语句级条件`);
        fs.writeFileSync(srv, parts.join(LM.stmtAll[1]));
      } else replaceExactlyOnce(srv, LM.stmt[0], LM.stmt[1], `${which}：去掉语句级条件`);
    }
  } else if (cfg.mutation === 'edit-name-check-off') {
    // M-R（K2）：去掉 edit-script 的附件命名冲突校验——K2 的 400 用例须判红
    replaceExactlyOnce(path.join(copyRoot, 'server.js'), 'if (/^\\d+_[A-Za-z_]+_\\d{8}\\.[A-Za-z0-9]+$/.test(String(fileName))) {', 'if (false) {', 'edit-script：去掉附件命名冲突校验');
  } else if (/^n1-(task|model)-cond-off$/.test(cfg.mutation)) {
    // M-W（R1）：去掉 confirm 归档条件写里的任务字段条件；M-X（R2）：去掉模型行字段条件（存在性 / layer / companion_of / is_deleted）
    const srv = path.join(copyRoot, 'server.js');
    if (cfg.mutation === 'n1-task-cond-off') {
      replaceExactlyOnce(srv, 'AND linked_model_id IS ? AND category IS ? AND owner_id IS ? AND created_at IS ?', "AND ? IS NOT 'x' AND ? IS NOT 'x' AND ? IS NOT 'x' AND ? IS NOT 'x'", 'confirm 归档条件写：去掉任务字段条件');
    } else {
      replaceExactlyOnce(srv, 'AND (? IS NULL OR (? = 1 AND EXISTS (SELECT 1 FROM data_models WHERE id = ? AND layer IS ? AND companion_of IS ? AND is_deleted IS ?)) OR (? = 0 AND NOT EXISTS (SELECT 1 FROM data_models WHERE id = ?)))',
        "AND (? IS NOT 'x' AND ? IS NOT 'x' AND ? IS NOT 'x' AND ? IS NOT 'x' AND ? IS NOT 'x' AND ? IS NOT 'x' AND ? IS NOT 'x' AND ? IS NOT 'x')", 'confirm 归档条件写：去掉模型行字段条件');
    }
  } else if (cfg.mutation === 'n1-sameread-off') {
    // M-Z（23-R5）：去掉 archiveGateDecision 管理员 DIM / DWD 分支两次读取的一致性比较——R5 LAYER 注入用例须判红（按 ODS 单条规则被放行归档）
    replaceExactlyOnce(path.join(copyRoot, 'server.js'), 'const sameRead = !!gs && gs.exists === true && fm.exists === true && gs.layer === fm.layer && gs.companionOf === fm.companionOf && gs.isDeleted === fm.isDeleted;', 'const sameRead = true;', 'archiveGateDecision：去掉两次读一致性比较');
  } else if (/^n1-(all|rev|rec|inv)-cond-off$/.test(cfg.mutation)) {
    // M-U 系列（N1 / P2）：去掉 confirm 归档条件写里的模型条件——all = 整个模型条件（M-U）/ rev = 只去 config_rev 相等 / rec = 只去「无更新验收记录」/ inv = 只去「失效记录条数不变」（M-U4）
    const srv = path.join(copyRoot, 'server.js');
    const which = cfg.mutation.split('-')[1];
    const TRUE2 = "(? IS NOT 'x' AND ? IS NOT 'x')";
    if (which === 'all') {
      replaceExactlyOnce(srv, "AND (? IS NULL OR ((SELECT config_rev FROM data_models WHERE id = ?) IS ?\n                       AND NOT EXISTS (SELECT 1 FROM model_test_records WHERE model_id = ? AND id > ?)\n                       AND (SELECT COUNT(*) FROM model_test_records WHERE model_id = ? AND invalidated = 1) = ?))",
        "AND (? IS NULL OR (? IS NOT 'x' AND ? IS NOT 'x' AND ? IS NOT 'x' AND ? IS NOT 'x' AND ? IS NOT 'x' AND ? IS NOT 'x'))", 'confirm 归档条件写：去掉整个模型条件');
    } else if (which === 'inv') {
      replaceExactlyOnce(srv, '(SELECT COUNT(*) FROM model_test_records WHERE model_id = ? AND invalidated = 1) = ?', TRUE2, 'confirm 归档条件写：去掉「失效记录条数不变」条件');
    } else if (which === 'rev') {
      replaceExactlyOnce(srv, '(SELECT config_rev FROM data_models WHERE id = ?) IS ?', TRUE2, 'confirm 归档条件写：去掉 config_rev 相等条件');
    } else {
      replaceExactlyOnce(srv, 'NOT EXISTS (SELECT 1 FROM model_test_records WHERE model_id = ? AND id > ?)', TRUE2, 'confirm 归档条件写：去掉「无更新验收记录」条件');
    }
  } else if (cfg.mutation === 'edit-ntfs-check-off') {
    // M-T（L2）：去掉 edit-script 的 NTFS 流名 / 结尾 . 空格校验——L2 用例须判红
    replaceExactlyOnce(path.join(copyRoot, 'server.js'), "if (String(fileName).includes(':') || /[. ]$/.test(String(fileName))) {", 'if (false) {', 'edit-script：去掉 NTFS 流名校验');
  } else if (cfg.mutation === 'tz-catch-nomark') {
    // M-S（K4）：自检异常分支不再 markTzMismatch（回到只打日志）——「自检 SQL 报错」实例的拒绝用例须判红
    replaceExactlyOnce(path.join(copyRoot, 'server.js'), "            markTzMismatch('startup-sqlite-check-error');", '            void 0;', '时区自检：异常分支去掉 markTzMismatch');
  } else if (cfg.mutation === 'impl-link-bump-off') {
    // M-IL（#77 C2b-1）：impl-links 整组替换里去掉挂接集合变化的 bumpConfigRev——「挂接集合变化 +1」「解挂 +1」用例须判红
    replaceExactlyOnce(path.join(copyRoot, 'routes', 'model-center', 'impl-objects.js'), '                    await bumpConfigRev(conn, [modelId]);\n                    const hashOf', '                    /* 变异：去掉挂接集合变化的递增 */\n                    const hashOf', 'impl-links：去掉集合变化的 bumpConfigRev');
  } else if (cfg.mutation === 'impl-src-first-bump') {
    // M-IS（#77 C2b-1）：源码变化的递增条件改成「哈希变化即递增」（首次登记，旧值为空，也递增）——「首次登记 0」用例须判红
    replaceExactlyOnce(path.join(copyRoot, 'routes', 'model-center', 'impl-objects.js'), 'if (!isBlank(oldHash) && oldHash !== newHash) {', 'if (oldHash !== newHash) {', 'impl-source：首次登记也递增');
  } else if (/^h3-(pre|stmt|guard)-off$/.test(cfg.mutation)) {
    // M-H3 系列（末次合并审 H3）：/api/update 的 DONE 门有两层——前置 SELECT 检查（pre）与 UPDATE 语句级条件（stmt）。
    //   pre-off（只去前置、留语句级）：现有 H3 用例（改 / 清关联被拒）仍须全绿——证明语句级条件自己在挡（400 来自 changes=0 后的重读分流）；
    //   stmt-off（只去语句级、留前置）：H3x 注入用例（前置之后任务变 DONE）须判红；guard-off（两层都去）：现有 H3 用例须判红。
    const srv = path.join(copyRoot, 'server.js');
    if (cfg.mutation !== 'h3-stmt-off') replaceExactlyOnce(srv, "        if (curTask && curTask.status === 'DONE') {", '        if (false) {', '/api/update：去掉 DONE 前置检查');
    if (cfg.mutation !== 'h3-pre-off') {
      replaceExactlyOnce(srv, " AND (status IS NULL OR status != 'DONE' OR linked_model_id IS ?)\",\n                [title, desc || '', validCategory, linked_model_id, model.table_name, id, linked_model_id, linked_model_id, linked_model_id]", "\",\n                [title, desc || '', validCategory, linked_model_id, model.table_name, id, linked_model_id, linked_model_id]", '/api/update 改关联 UPDATE：去掉 DONE 门条件');
      replaceExactlyOnce(srv, " WHERE id = ? AND (status IS NULL OR status != 'DONE' OR linked_model_id IS NULL)\"", " WHERE id = ?\"", '/api/update 清空关联 UPDATE：去掉 DONE 门条件');
    }
  } else if (cfg.mutation === 'h3-null-clause-off') {
    // M-H3d（收口批 2 LOW-2）：清空分支 UPDATE 的放行条件漏写 OR linked_model_id IS NULL（诚实实现里常见的漏写）——「DONE 且本来没关联、只改标题」的放行侧对照须判红
    replaceExactlyOnce(path.join(copyRoot, 'server.js'), " WHERE id = ? AND (status IS NULL OR status != 'DONE' OR linked_model_id IS NULL)\"", " WHERE id = ? AND (status IS NULL OR status != 'DONE')\"", '/api/update 清空关联 UPDATE：漏写 OR linked_model_id IS NULL');
  } else if (cfg.mutation === 'first-save-no-layer') {
    // M-P53a：首次落盘豁免不查分层（DIM / DWD 带 purpose + 当前版本也豁免）。P57 §7 之后分层不是 ODS 的 ods-auto-save 请求在豁免判定之前就被 409 LAYER_NOT_ODS 拦下，
    //   所以这条变异要同时去掉两处 LAYER_NOT_ODS 判定，才能观测到「豁免是否查分层」
    const srvL = path.join(copyRoot, 'server.js');
    replaceExactlyOnce(srvL, "\n            && String(model.layer || '').toUpperCase() === 'ODS'", '', 'save-scripts 首次落盘豁免：去掉分层判定');
    replaceExactlyOnce(srvL, "if (savePurpose === 'ods-auto-save' && String(model.layer || '').toUpperCase() !== 'ODS') {", 'if (false) {', 'save-scripts：去掉早检的分层 409');
    replaceExactlyOnce(srvL, "if (String(fresh.layer || '').toUpperCase() !== 'ODS') {", 'if (false) {', 'save-scripts：去掉终检的分层 409');
  } else if (cfg.mutation === 'ods-layer-off') {
    // M-P57g：去掉两处 LAYER_NOT_ODS 判定（豁免里的分层判定保留）——分层不是 ODS 的自动保存退回「不豁免、按普通保存落盘并递增」
    const srvG = path.join(copyRoot, 'server.js');
    replaceExactlyOnce(srvG, "if (savePurpose === 'ods-auto-save' && String(model.layer || '').toUpperCase() !== 'ODS') {", 'if (false) {', 'save-scripts：去掉早检的分层 409');
    replaceExactlyOnce(srvG, "if (String(fresh.layer || '').toUpperCase() !== 'ODS') {", 'if (false) {', 'save-scripts：去掉终检的分层 409');
  } else if (cfg.mutation === 'ods-layer-final-off') {
    replaceExactlyOnce(path.join(copyRoot, 'server.js'), "if (String(fresh.layer || '').toUpperCase() !== 'ODS') {", 'if (false) {', 'save-scripts：去掉终检的分层 409');
  } else if (cfg.mutation === 'ods-layer-first-off') {
    replaceExactlyOnce(path.join(copyRoot, 'server.js'), "if (savePurpose === 'ods-auto-save' && String(model.layer || '').toUpperCase() !== 'ODS') {", 'if (false) {', 'save-scripts：去掉早检的分层 409');
  } else if (cfg.mutation === 'first-save-no-rev') {
    // M-P53b：首次落盘豁免不查版本（版本过期也豁免）。P57②之后 purpose = ods-auto-save 的版本过期请求在豁免判定之前就被 409 拦下，
    //   所以这条变异要同时去掉两处 409 判定，才能观测到「豁免是否查版本」（只去豁免里的版本判定是冗余防线，对外无差别）
    const srvB = path.join(copyRoot, 'server.js');
    replaceExactlyOnce(srvB, "\n            && expectedConfigRev === model.config_rev;", ';', 'save-scripts 首次落盘豁免：去掉版本判定');
    replaceExactlyOnce(srvB, "if (savePurpose === 'ods-auto-save' && expectedConfigRev !== model.config_rev) {", 'if (false) {', 'save-scripts：去掉第一次版本过期 409');
    replaceExactlyOnce(srvB, 'if (!fresh || fresh.config_rev !== expectedConfigRev) {', 'if (false) {', 'save-scripts：去掉第二次版本过期 409');
  } else if (cfg.mutation === 'ods-409-off') {
    // M-P57a：去掉两处版本过期 409 判定（豁免里的版本判定保留）——版本过期的 ODS 自动保存退回「不豁免、照常落盘并递增」
    const srvA = path.join(copyRoot, 'server.js');
    replaceExactlyOnce(srvA, "if (savePurpose === 'ods-auto-save' && expectedConfigRev !== model.config_rev) {", 'if (false) {', 'save-scripts：去掉第一次版本过期 409');
    replaceExactlyOnce(srvA, 'if (!fresh || fresh.config_rev !== expectedConfigRev) {', 'if (false) {', 'save-scripts：去掉第二次版本过期 409');
  } else if (cfg.mutation === 'ods-second-check-off') {
    // M-P57b：去掉第二次（进入写阶段之前的重读）版本检查，只留第一次
    replaceExactlyOnce(path.join(copyRoot, 'server.js'), 'if (!fresh || fresh.config_rev !== expectedConfigRev) {', 'if (false) {', 'save-scripts：去掉第二次版本过期 409');
  } else if (cfg.mutation === 'ods-first-check-off') {
    // M-P57c：去掉第一次（读出模型行后立即判）版本检查，只留第二次
    replaceExactlyOnce(path.join(copyRoot, 'server.js'), "if (savePurpose === 'ods-auto-save' && expectedConfigRev !== model.config_rev) {", 'if (false) {', 'save-scripts：去掉第一次版本过期 409');
  } else if (cfg.mutation === 'ods-final-moved-early') {
    // M-P57j（§8.4）：把终检的重读挪到早检之后、查任务之前（判定逻辑留在原处，只让读提前）——行为不变，真实窗口重新打开；静态位置断言须判红
    const srvM = path.join(copyRoot, 'server.js');
    replaceExactlyOnce(srvM, "const fresh = await dbGetAsync('SELECT config_rev, layer FROM data_models WHERE id = ?', [id]);", 'const fresh = __earlyFresh;', 'save-scripts：终检改用提前读到的行');
    replaceExactlyOnce(srvM, "code: 'LAYER_NOT_ODS', current_config_rev: model.config_rev });\n        }\n", "code: 'LAYER_NOT_ODS', current_config_rev: model.config_rev });\n        }\n        const __earlyFresh = savePurpose === 'ods-auto-save' ? await dbGetAsync('SELECT config_rev, layer FROM data_models WHERE id = ?', [id]) : null;\n", 'save-scripts：早检之后提前重读');
  } else if (cfg.mutation === 'ods-archive-before-final' || cfg.mutation === 'ods-move-prev-before-final' || cfg.mutation === 'ods-overwrite-before-final') {
    // M-P57l / M-P57m / M-P57n（codex 50C）：旧脚本的写 / 移动提前到终检之前的规划阶段，都不改变 409 响应本身，只有「文件零变化」断言（旧脚本交错用例）能判出：
    //   archive（l）= 当前目录旧文件先归档进 _history（旧文件被复制、_history 新增）；
    //   move-prev（m）= 终检前对 script_path 目录里的旧文件新增改名——假设实现，真实实现对该目录只读（planScript 只 existsSync / 读）；守卫与 planScript 同口径：
    //     只在 prevScriptDir !== path.resolve(scriptDir) 时才动，所以「当前目录有旧脚本」两例（二者相等）不受影响；
    //   overwrite（n）= 对 oldExists 的文件直接同名覆盖写入（不建新文件、不归档）：文件名清单不变，只有内容哈希变——证明清单里内容哈希这一维有判别力
    const anchor = "        if (savePurpose === 'ods-auto-save') {\n            const fresh = await dbGetAsync(";
    const early = cfg.mutation === 'ods-archive-before-final'
      ? "        for (const w of pendingWrites) { if (w.oldExists) archiveOldScript(scriptDir, w.fileName, 'm'); }\n"
      : cfg.mutation === 'ods-overwrite-before-final'
        ? "        for (const w of pendingWrites) { if (w.oldExists) fs.writeFileSync(w.filePath, w.content, 'utf8'); }\n"
        : "        if (prevScriptDir && prevScriptDir !== path.resolve(scriptDir)) { for (const w of pendingWrites) { const pf = path.join(prevScriptDir, w.fileName); if (fs.existsSync(pf)) fs.renameSync(pf, pf + '.moved'); } }\n";
    replaceExactlyOnce(path.join(copyRoot, 'server.js'), anchor, early + anchor, 'save-scripts：旧脚本写 / 移动提前到终检之前');
  } else if (cfg.mutation === 'ods-await-after-final') {
    // M-P57k（§8.4）：在终检与写文件循环之间插一个 await——静态断言（await 只有 dbGetAsync 与 bumpConfigRev）须判红
    replaceExactlyOnce(path.join(copyRoot, 'server.js'), '        // 逐文件 contentChanged（见 planScript：', '        await Promise.resolve();\n        // 逐文件 contentChanged（见 planScript：', 'save-scripts：终检与写循环之间插 await');
  } else if (cfg.mutation === 'ods-rev-required-off') {
    // M-P57d：去掉 EXPECTED_CONFIG_REV_REQUIRED（purpose = ods-auto-save 缺 expected_config_rev 不再 400）
    replaceExactlyOnce(path.join(copyRoot, 'server.js'), "if (savePurpose === 'ods-auto-save' && expectedConfigRev === undefined) {", 'if (false) {', 'save-scripts：去掉 EXPECTED_CONFIG_REV_REQUIRED');
  } else if (cfg.mutation === 'exempt-widen-cur') {
    // M-P57e（P57⑤）：豁免扩大到「当前目录已有同名旧脚本且内容改变」的自动保存（该分支的 contentChanged 受 firstSaveExempt 抑制）
    replaceExactlyOnce(path.join(copyRoot, 'server.js'), "                contentChanged = true;\n            }\n            if (prevScriptDir && prevScriptDir !== path.resolve(scriptDir)) {",
      "                if (!firstSaveExempt) contentChanged = true;\n            }\n            if (prevScriptDir && prevScriptDir !== path.resolve(scriptDir)) {", 'save-scripts：豁免扩大到当前目录已有脚本');
  } else if (cfg.mutation === 'exempt-widen-prev') {
    // M-P57f（P57⑤）：豁免扩大到「旧脚本只在 script_path 目录」的自动保存。该场景有两条互相冗余的递增规则（逐文件比较 + 目录级生效集合比较），变异须把两条都抑制才能观测
    const srvF = path.join(copyRoot, 'server.js');
    replaceExactlyOnce(srvF, "if (normalizeForCompare(fs.readFileSync(prevFile, 'utf8')) !== normalizeForCompare(content)) contentChanged = true;",
      "if (normalizeForCompare(fs.readFileSync(prevFile, 'utf8')) !== normalizeForCompare(content) && !firstSaveExempt) contentChanged = true;", 'save-scripts：逐文件规则对 script_path 目录的比较受豁免抑制');
    replaceExactlyOnce(srvF, 'const configRevBumped = pendingWrites.some(w => w.contentChanged) || dirChanged;', 'const configRevBumped = pendingWrites.some(w => w.contentChanged) || (dirChanged && !firstSaveExempt);', 'save-scripts：目录级规则受豁免抑制');
  } else if (cfg.mutation === 'first-save-no-purpose') {
    // M-P53c：首次落盘豁免不查 purpose（ODS + 当前版本的任何首次落盘都豁免）
    replaceExactlyOnce(path.join(copyRoot, 'server.js'), "const firstSaveExempt = savePurpose === 'ods-auto-save'\n", 'const firstSaveExempt = true\n', 'save-scripts 首次落盘豁免：去掉 purpose 判定');
  } else if (cfg.mutation === 'h2-guard-off') {
    // M-H2（末次合并审 H2）：PUT 两条最终 UPDATE 的版本条件改成恒真（占位符个数不变）——H2x 的 409 / 404 / 零落库用例须判红
    const srv = path.join(copyRoot, 'server.js');
    const txt = fs.readFileSync(srv, 'utf8');
    const parts = txt.split('WHERE id = ? AND config_rev IS ?');
    if (parts.length !== 3) throw new Error(`变异锚点命中 ${parts.length - 1} 次（必须恰 2 次）：PUT 版本条件`);
    fs.writeFileSync(srv, parts.join("WHERE id = ? AND ? IS NOT 'x'"));
  } else if (/^h2-(nodim|dim)-guard-off$/.test(cfg.mutation)) {
    // M-H2 拆分（复审 47C-MED）：只去掉其中一条 UPDATE 的版本条件——dim = 带 dim_config 的那条（SET 末尾 CONFIG_REV_BUMP_SQL 与 updated_at 同行）；
    //   nodim = 不带 dim_config 的那条（CONFIG_REV_BUMP_SQL 与 updated_at 分两行）。只能被对应分支的用例判红，另一分支的用例保持绿（mustPass 核）。
    const srv = path.join(copyRoot, 'server.js');
    if (cfg.mutation === 'h2-dim-guard-off') {
      replaceExactlyOnce(srv, "${CONFIG_REV_BUMP_SQL}, updated_at = datetime('now', 'localtime')\n                WHERE id = ? AND config_rev IS ?", "${CONFIG_REV_BUMP_SQL}, updated_at = datetime('now', 'localtime')\n                WHERE id = ? AND ? IS NOT 'x'", 'PUT 带 dim_config 分支：去掉版本条件');
    } else {
      replaceExactlyOnce(srv, "${CONFIG_REV_BUMP_SQL},\n                    updated_at = datetime('now', 'localtime')\n                WHERE id = ? AND config_rev IS ?", "${CONFIG_REV_BUMP_SQL},\n                    updated_at = datetime('now', 'localtime')\n                WHERE id = ? AND ? IS NOT 'x'", 'PUT 不带 dim_config 分支：去掉版本条件');
    }
  } else if (cfg.mutation === 'h2-404-writes') {
    // M-H2c（复审 47C-LOW）：404 分流先把请求里的 table_comment 写进库再回 404（「状态码对、但没有零落库」）——旧的 404 用例（只看状态码 / is_deleted / source_system）判不出，整行零落库用例须判红
    replaceExactlyOnce(path.join(copyRoot, 'server.js'), 'if (!still) return res.status(404).json({ error: "模型不存在" });', 'if (!still) return db.run("UPDATE data_models SET table_comment = ? WHERE id = ?", [table_comment, id], () => res.status(404).json({ error: "模型不存在" }));', 'PUT 404 分流：先写 table_comment 再回 404');
  } else if (cfg.mutation === 'early-text') {
    replaceExactlyOnce(path.join(copyRoot, 'routes', 'model-center', 'acceptance.js'),
      "const EARLIER_THAN_TASK_REASON = '当前版本的验收记录早于任务创建时间，请重新验收';",
      "const EARLIER_THAN_TASK_REASON = '';",
      'EARLIER_THAN_TASK_REASON 置空');
  }
  if (cfg.tzBroken) {
    // K4：被测实例的启动时区自检 SQL 必然报错（环境时区钉为北京时间，加载时 JS 判定为一致——拒绝只能来自「自检失败 ⇒ fail-closed」）
    replaceExactlyOnce(path.join(copyRoot, 'server.js'), `const row = await dbGetAsync("SELECT datetime('now','localtime') AS t");`, `const row = await dbGetAsync("SELECT datetime('now','localtime') AS t FROM k4_no_such_table");`, '时区自检：SQL 改为必然报错');
  }
  if (cfg.injectConfirm) {
    // N1 注入（仅副本，正式代码无钩子）：在 /api/confirm「判定通过之后、归档写入之前」插入一个 await 点，按 review_note 标记在此刻改模型配置 / 插入更新的 fail 记录
    //   （模拟并发请求在判定与写入之间改了状态）；标记之外的请求不受影响
    replaceExactlyOnce(path.join(copyRoot, 'server.js'),
      '        try {\n            // 1. 收集脚本快照（归档时保存当前脚本内容，便于追溯）',
      `        if (row.linked_model_id && review_note === 'INJECT_REV') { await dbRunAsync("UPDATE data_models SET config_rev = COALESCE(config_rev, 1) + 1 WHERE id = ?", [row.linked_model_id]); }
        if (row.linked_model_id && review_note === 'INJECT_INV') { await dbRunAsync("UPDATE model_test_records SET invalidated = 1 WHERE id = (SELECT MIN(id) FROM model_test_records WHERE model_id = ? AND (invalidated = 0 OR invalidated IS NULL))", [row.linked_model_id]); }
        if (row.linked_model_id && review_note === 'INJECT_FAIL') { await dbRunAsync("INSERT INTO model_test_records (model_id, table_name, test_time, test_user, overall_result, total_rows, detail_json, invalidated, config_rev) SELECT id, table_name, '2099-01-01 00:00:00', 'inject', 'fail', 0, '{\\"phase\\":\\"structure\\"}', 0, config_rev FROM data_models WHERE id = ?", [row.linked_model_id]); }
        if (review_note === 'INJECT_CAT') { await dbRunAsync("UPDATE task_pool SET category = 'DATA_FIX' WHERE id = ?", [id]); }
        if (review_note === 'INJECT_CREATED') { await dbRunAsync("UPDATE task_pool SET created_at = '2000-01-01 00:00:00' WHERE id = ?", [id]); }
        if (row.linked_model_id && review_note === 'INJECT_LINK') { await dbRunAsync("UPDATE task_pool SET linked_model_id = (SELECT id FROM data_models WHERE id <> ? AND id NOT IN (SELECT linked_model_id FROM task_pool WHERE linked_model_id IS NOT NULL AND status != 'ARCHIVED') ORDER BY id LIMIT 1) WHERE id = ?", [row.linked_model_id, id]); }
        if (row.linked_model_id && review_note === 'INJECT_DEL') { await dbRunAsync("UPDATE data_models SET is_deleted = 1 WHERE id = ?", [row.linked_model_id]); }
        if (row.linked_model_id && review_note === 'INJECT_RESTORE') { await dbRunAsync("UPDATE data_models SET is_deleted = 0 WHERE id = ?", [row.linked_model_id]); }
        if (row.linked_model_id && review_note === 'INJECT_COMP') { await dbRunAsync("UPDATE data_models SET companion_of = (SELECT MIN(id) FROM data_models WHERE id <> ?) WHERE id = ?", [row.linked_model_id, row.linked_model_id]); }
        if (review_note === 'INJECT_OWNER') { await dbRunAsync("UPDATE task_pool SET owner_id = 987654 WHERE id = ?", [id]); }
        if (row.linked_model_id && review_note === 'INJECT_MKMODEL') { await dbRunAsync("INSERT INTO data_models (id, layer, domain, table_name, table_comment, tech_owner, biz_owner, update_cycle, status, source_table, source_system, model_type, created_by_id, category, config_mode, is_deleted) VALUES (?, 'ODS', 'MCDOM', ?, 'inject', 'mc_tech', 'mc_biz', 'di', 'DEVELOPING', 'src_a', 'SYS_A', 'TABLE', 1, 'general', 'standard', 0)", [row.linked_model_id, 'mc_inject_missing_' + row.linked_model_id]); }
        if (row.linked_model_id && review_note === 'INJECT_LAYER') { await dbRunAsync("UPDATE data_models SET layer = 'DIM' WHERE id = ?", [row.linked_model_id]); }
        try {
            // 1. 收集脚本快照（归档时保存当前脚本内容，便于追溯）`,
      'confirm：判定与归档写入之间注入变化');
    // 23-R5 注入（仅副本）：在 archiveGateDecision 的 linkedModelLayer（第 1 次读）之后、checkAllValidationsPassed（第 2 次读）之前插入 await 点；
    //   标记由 /api/confirm 入口按 review_note 写入全局，注入点消费后清空（不影响其他请求）
    replaceExactlyOnce(path.join(copyRoot, 'server.js'),
      '    const { id, review_note, review_checklist } = req.body;\n    if (!id) return res.status(400).json({ error: "ID is required" });\n',
      '    const { id, review_note, review_checklist } = req.body;\n    globalThis.__mcR5Mark = review_note;\n    if (!id) return res.status(400).json({ error: "ID is required" });\n',
      'confirm：入口记录 R5 注入标记');
    replaceExactlyOnce(path.join(copyRoot, 'server.js'),
      '            const gate = await checkAllValidationsPassed(task.linked_model_id, task);\n            const gs = gate.snap || null;',
      `            { const mk5 = globalThis.__mcR5Mark; globalThis.__mcR5Mark = null;
              if (mk5 === 'INJECT_R5_LAYER') {
                await dbRunAsync("UPDATE data_models SET layer = 'ODS' WHERE id = ?", [task.linked_model_id]);
                await dbRunAsync("INSERT INTO model_test_records (model_id, table_name, test_time, test_user, overall_result, total_rows, detail_json, invalidated, config_rev) SELECT id, table_name, '2099-01-01 00:00:00', 'inject', 'pass', 0, '{\\"summary\\":{}}', 0, config_rev FROM data_models WHERE id = ?", [task.linked_model_id]);
              }
              if (mk5 === 'INJECT_R5_COMP') { await dbRunAsync("UPDATE data_models SET companion_of = (SELECT MIN(id) FROM data_models WHERE id <> ?) WHERE id = ?", [task.linked_model_id, task.linked_model_id]); }
              if (mk5 === 'INJECT_R5_DEL') { await dbRunAsync("UPDATE data_models SET is_deleted = 1 WHERE id = ?", [task.linked_model_id]); }
            }
            const gate = await checkAllValidationsPassed(task.linked_model_id, task);
            const gs = gate.snap || null;`,
      'archiveGateDecision：两次读之间注入模型变化');
  }
  if (cfg.injectH3) {
    // H3x 注入（仅副本，正式代码无钩子）：/api/update 前置检查之后、UPDATE 之前按标题标记把任务改成 DONE / 删掉；重读之前（409 标记）再把状态改回 CLAIMED
    const srv = path.join(copyRoot, 'server.js');
    replaceExactlyOnce(srv, "        if (linked_model_id) {\n            // 校验模型存在",
      "        if (title === 'INJECT_H3_DONE' || title === 'INJECT_H3_409') { await dbRunAsync(\"UPDATE task_pool SET status = 'DONE' WHERE id = ?\", [id]); }\n        if (title === 'INJECT_H3_DEL') { await dbRunAsync(\"DELETE FROM task_pool WHERE id = ?\", [id]); }\n        if (linked_model_id) {\n            // 校验模型存在",
      '/api/update：前置检查与 UPDATE 之间注入');
    const resetHook = "if (title === 'INJECT_H3_409') { await dbRunAsync(\"UPDATE task_pool SET status = 'CLAIMED' WHERE id = ?\", [id]); }\n                ";
    replaceExactlyOnce(srv, 'const again = await dbGetAsync("SELECT status, linked_model_id FROM task_pool WHERE id = ?", [id]);', resetHook + 'const again = await dbGetAsync("SELECT status, linked_model_id FROM task_pool WHERE id = ?", [id]);', '/api/update 改关联分支：重读之前注入状态回退');
    replaceExactlyOnce(srv, 'const again = await dbGetAsync("SELECT status FROM task_pool WHERE id = ?", [id]);', resetHook + 'const again = await dbGetAsync("SELECT status FROM task_pool WHERE id = ?", [id]);', '/api/update 清空分支：重读之前注入状态回退');
  }
  if (cfg.injectH2) {
    // H2x 注入（仅副本，正式代码无钩子）：PUT /api/models/:id 读旧行之后、最终 UPDATE 之前，按 table_comment 标记模拟「另一个请求的写入」
    replaceExactlyOnce(path.join(copyRoot, 'server.js'), '        db.run(sql, params, function (err) {\n            if (err) return res.status(500).json({ error: err.message });\n            // 末次合并审 H2',
      "        if (table_comment === 'INJECT_H2_BUMP') { await dbRunAsync(\"UPDATE data_models SET source_table = 'src_injected', config_rev = COALESCE(config_rev, 1) + 1 WHERE id = ?\", [id]); }\n        if (table_comment === 'INJECT_H2_DEL') { await dbRunAsync(\"UPDATE data_models SET is_deleted = 1, config_rev = COALESCE(config_rev, 1) + 1 WHERE id = ?\", [id]); }\n        db.run(sql, params, function (err) {\n            if (err) return res.status(500).json({ error: err.message });\n            // 末次合并审 H2",
      'PUT：读旧行与 UPDATE 之间注入他人写入');
  }
  if (cfg.injectP57) {
    // P57② 注入（仅副本，正式代码无钩子）：save-scripts 第二次版本检查（重读 config_rev）之前，按 configVersion 标记模拟「另一个请求改了配置」：
    //   BUMP = 版本 +1；REVERT = 版本 −1（把入口时领先的版本拨回请求带的值，用来单独观测第一次检查）。标记之外的请求不受影响。
    replaceExactlyOnce(path.join(copyRoot, 'server.js'), "        if (savePurpose === 'ods-auto-save') {\n            const fresh = await dbGetAsync(",
      "        if (req.body.configVersion === 'INJECT_P57_BUMP') { await dbRunAsync(\"UPDATE data_models SET config_rev = COALESCE(config_rev, 1) + 1 WHERE id = ?\", [id]); }\n        if (req.body.configVersion === 'INJECT_P57_REVERT') { await dbRunAsync(\"UPDATE data_models SET config_rev = config_rev - 1 WHERE id = ?\", [id]); }\n        if (req.body.configVersion === 'INJECT_P57_LAYER') { await dbRunAsync(\"UPDATE data_models SET layer = 'DIM' WHERE id = ?\", [id]); }\n        if (req.body.configVersion === 'INJECT_P57_LAYER_BACK') { await dbRunAsync(\"UPDATE data_models SET layer = 'ODS' WHERE id = ?\", [id]); }\n        if (savePurpose === 'ods-auto-save') {\n            const fresh = await dbGetAsync(",
      'save-scripts：第二次版本检查之前注入配置变更');
  }
  const holdFile = path.join(runDir, 'tz-hold.flag');
  if (cfg.tzRetry) {
    // N3 注入（仅副本）：自检第一次尝试先等 holdFile 出现（让测试在「自检未完成」期间发请求），且前两次尝试抛错（第三次才成功）
    replaceExactlyOnce(path.join(copyRoot, 'server.js'), `const row = await dbGetAsync("SELECT datetime('now','localtime') AS t");`,
      `const row = await (async () => { const hf = process.env.MC_TZ_HOLD; if (hf && attempt === 0) { while (!require('fs').existsSync(hf)) await new Promise(r => setTimeout(r, 50)); } if (attempt < 2) throw new Error('injected tz check failure ' + attempt); return dbGetAsync("SELECT datetime('now','localtime') AS t"); })();`,
      '时区自检：注入暂停 + 前两次失败');
  }
  if (cfg.tzJsFail) {
    // R4 注入（仅副本）：加载时 JS 时区检测抛异常——状态应保持 unknown，由 SQLite 自检定性
    replaceExactlyOnce(path.join(copyRoot, 'server.js'), "const parts = new Intl.DateTimeFormat(", "const parts = (() => { throw new Error('injected js tz probe failure'); })() || new Intl.DateTimeFormat(", 'JS 时区检测：注入抛异常');
  }
  if (cfg.mutation === 'tzjs-exc-mismatch') {
    replaceExactlyOnce(path.join(copyRoot, 'server.js'), 'if (verdict === true) {', 'if (verdict !== false) {', 'JS 时区检测：无法判定也置 mismatch');
  }
  if (cfg.mutation === 'tz-no-retry') {
    replaceExactlyOnce(path.join(copyRoot, 'server.js'), 'const retryDelaysMs = [1000, 2000, 4000];', 'const retryDelaysMs = [];', '时区自检：去掉退避重试');
  }
  const dbPath = path.join(runDir, 'fixture.db');
  const gate = { up: false, writes: 0, fixtureWrites: 0 };
  const svc = makeService({ copyRoot, dbPath, tag: 'svc', gate, extraEnv: cfg.tzRetry ? { ...(cfg.extraEnv || {}), MC_TZ_HOLD: holdFile } : cfg.extraEnv });
  const api = makeApi(() => svc.baseUrl);
  let rd = null;
  const ctx = { api, check, svc, copyRoot, results, coverage: new Map(), tzBroken: !!cfg.tzBroken };
  try {
    // 阶段 0：空库 → 被测代码自建全部表
    const fresh = await createFreshDb(svc);
    // 阶段 1：服务停止，写全部夹具（一次性）
    const w = await openWriter(dbPath, gate);
    try {
      await w.get('PRAGMA journal_mode = WAL');
      const fx = makeFixtures(w);
      ctx.admin = await fx.user('mc_admin', 'admin');
      ctx.owner = await fx.user('mc_owner', 'user');
      const env = { w, fx, admin: ctx.admin, owner: ctx.owner, copyRoot };
      if (cfg.groups.has('accounting')) ctx.accPlan = await planAccounting(env);
      if (cfg.groups.has('gates')) { ctx.gatePlan = await planGates(env); ctx.g4Plan = await planG4(env); }
      if (cfg.groups.has('tz')) ctx.tzPlan = await planGates(env, true);
      if (cfg.groups.has('reopen')) ctx.reopenPlan = await planReopen(env);
      if (cfg.groups.has('states')) ctx.statesPlan = await planStates(env);
      if (cfg.groups.has('k')) ctx.kPlan = await planK(env);
      if (cfg.groups.has('n1')) ctx.n1Plan = await planN1(env);
      if (cfg.groups.has('h3x')) ctx.h3xPlan = await planH3x(env);
      if (cfg.groups.has('h2x')) ctx.h2xPlan = await planH2x(env);
      if (cfg.groups.has('p57')) ctx.p57Plan = await planP57(env);
      if (cfg.groups.has('tzr')) ctx.tzrPlan = await planTzr(env);
      if (cfg.groups.has('tzjs')) ctx.tzjsPlan = await planTzr(env);
      await w.run('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally { await w.close(); }
    // 阶段 2：启动服务，测试进程只读
    await svc.start();
    rd = await openReader(dbPath);
    ctx.rd = rd;
    // P1：先等时区一致性自检出结论（通过 / 不一致 / 失败），再发任何门禁请求——否则门禁请求先于自检到达会被 unknown 拒绝造成偶发红。
    //   故意延迟或失败自检的实例（tzRetry / tzBroken）按各自的等待逻辑豁免。
    if (!cfg.tzRetry && !cfg.tzBroken) await waitTzConclusion(svc.inst, `${cfg.mutation || 'real'}`);
    ctx.traceRecords = () => readTrace(svc.inst.tracePath).records;
    ctx.traceLastSeq = () => { const r = ctx.traceRecords(); return r.length ? r[r.length - 1].seq : 0; };
    ctx.rev = async (id) => (await rd.get('SELECT config_rev FROM data_models WHERE id = ?', [id])).config_rev;
    ctx.row = (id) => rd.get('SELECT * FROM data_models WHERE id = ?', [id]);
    check('前提：被测服务端口不是 3000，库不是本机真实库，且不是从本机库复制而来', svc.port !== 3000 && path.resolve(dbPath) !== REAL_DB_ABS, `port=${svc.port}`);
    check('前提：被测服务日志里有 net-guard 加载标记（pid 与所起进程一致）——服务确实加载了出网拦截',
      svc.inst.guardLoaded === true && guardMarkerPresent(fs.readFileSync(svc.inst.logPath, 'utf8'), svc.inst.pid), `pid=${svc.inst.pid}`);
    // 出网拦截探针：用与被测服务进程同一份预加载脚本起一个探针进程——外部地址（TEST-NET-1 保留段）必须被拒，回环必须放行
    const probe = spawnSync(process.execPath, ['--require', path.join(copyRoot, 'net-guard.js'), '-e', NET_PROBE_SRC], { encoding: 'utf8', timeout: 20000, env: { ...process.env, PROBE_PORT: String(svc.port) } });
    const probeOut = `${probe.stdout || ''}`.trim();
    // 探针完成计数 = 11 项；进程必须正常退出（status 0、无 signal、无 error、输出不含 TIMEOUT），且 11 个结果标签各恰好出现一次
    const probeTags = probeOut.split('|').map(x => x.split(':')[0]);
    const tagsOnce = ['udp', 'dns', 'ext', 'lo', 'r4', 'pr4', 'rs4', 'prs4', 'r6', 'rev', 'ls'].every(t => probeTags.filter(x => x === t).length === 1) && probeTags.length === 11;
    check('前提：net-guard 探针进程正常退出且 11 个结果各出现一次（status 0 / 无 signal / 无 error / 无 TIMEOUT）',
      probe.status === 0 && probe.signal == null && !probe.error && !/TIMEOUT/.test(probeOut) && tagsOnce,
      `status=${probe.status} signal=${probe.signal} error=${probe.error && probe.error.message} out=${probeOut}`);
    check('前提：net-guard 预加载生效（TCP / UDP / DNS lookup / dns.resolve4 / promises.resolve4 / Resolver.resolve4 外部目标被拒、回环放行）',
      /ext:net-guard: blocked outbound connect to 192\.0\.2\.1/.test(probeOut) && /lo:CONNECTED/.test(probeOut)
      && /udp:net-guard: blocked outbound udp send to 192\.0\.2\.1/.test(probeOut) && /dns:net-guard: blocked outbound dns lookup to mc-blocked\.example/.test(probeOut)
      && /r4:net-guard: blocked outbound dns resolve4 to mc-blocked\.example/.test(probeOut) && /pr4:net-guard: blocked outbound dns resolve4 to mc-blocked\.example/.test(probeOut)
      && /rs4:net-guard: blocked outbound dns resolve4 to mc-blocked\.example/.test(probeOut) && /prs4:net-guard: blocked outbound dns resolve4 to mc-blocked\.example/.test(probeOut)
      && /r6:net-guard: blocked outbound dns resolve6 to mc-blocked\.example/.test(probeOut) && /rev:net-guard: blocked outbound dns reverse to 192\.0\.2\.1/.test(probeOut)
      && /ls:net-guard: blocked outbound dns lookupService to 192\.0\.2\.1/.test(probeOut),
      probeOut + ' ' + (probe.stderr || '').slice(0, 200));
    if (ctx.accPlan) { await runAccounting(ctx); await runImplNoteEntry(ctx); await runCommentSplit(ctx); runSaveScriptsStatic(ctx); }
    if (ctx.gatePlan) { await runGates(ctx); await runG4(ctx); }
    if (ctx.tzPlan) await runTz(ctx);
    if (!cfg.extraEnv) check('G1 时区自检：正常实例日志无 [TZ-MISMATCH] 告警', !/\[TZ-MISMATCH\]/.test(fs.readFileSync(svc.inst.logPath, 'utf8')), '正常实例出现了时区不一致告警');
    if (ctx.reopenPlan) await runReopen(ctx);
    if (ctx.statesPlan) await runStates(ctx);
    if (ctx.kPlan) await runK(ctx);
    if (ctx.n1Plan) await runN1(ctx);
    if (ctx.h3xPlan) await runH3x(ctx);
    if (ctx.h2xPlan) await runH2x(ctx);
    if (ctx.p57Plan) await runP57(ctx);
    if (ctx.tzrPlan) { ctx.holdFile = holdFile; await runTzr(ctx); }
    if (ctx.tzjsPlan) await runTzjs(ctx);
    // A 类覆盖硬门与分组解耦：默认执行；调用方选的分组不含 accounting ⇒ 直接判失败，不得静默跳过；只有变异自证运行（工具内部、故意只跑一组）显式豁免
    let coverageTable = null;
    if (cfg.coverageExempt) check('A 类覆盖：本次为变异自证运行（工具内部显式豁免 coverageExempt），不断言', true);
    else if (!cfg.groups.has('accounting')) check('A 类覆盖：所选分组不含 accounting，无法断言「契约每条 A 类写点都被通过的用例覆盖」——判失败（不得静默跳过）', false, `groups=${[...cfg.groups].join(',')}`);
    else coverageTable = assertAClassCoverage(ctx, check);
    check('服务运行期间测试进程写库次数 = 0（写连接只在服务停止时使用，写闸计数）', gate.writes === 0, `writes=${gate.writes}`);
    return { results, coverageTable, neutralized: fresh.report, writeEvidence: { writesWhileUp: gate.writes, fixtureWrites: gate.fixtureWrites } };
  } catch (e) {
    // 偶发失败先留证据（服务是否还活着、日志尾部），再向上抛
    let tail = '';
    try { tail = fs.readFileSync(svc.inst ? svc.inst.logPath : path.join(copyRoot, 'svc.server.log'), 'utf8').slice(-1800); } catch (_) { /* ignore */ }
    e.message = `${e.message}\n  [诊断] 被测服务状态=${svc.inst ? svc.inst.state() : '未运行'}；服务日志尾部：\n${tail}`;
    throw e;
  } finally {
    try { if (ctx.rd) await ctx.rd.close(); } catch (_) { /* ignore */ }
    await svc.stop();
    removeTree(runDir);
  }
}

// ───────── §1 记账 + 性质：计划（服务启动前写夹具）与执行（只读断言）─────────
const ddl = (date, body) => `-- 创建日期: ${date}\n-- 生成时间: ${date} 10:00:00\nCREATE TABLE t (${body});\n`;

async function planAccounting(env) {
  const { w, fx, admin, copyRoot } = env;
  const cases = [];
  const adminDir = admin.display_name;
  const seedFile = (rel, fileName, content) => {
    const d = path.join(copyRoot, 'uploads', rel);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, fileName), content);
  };
  const safe = (s) => s.replace(/[\\/:*?"<>|]/g, '_');
  // 每个用例各用独立模型 + 当前版本（rev 1）的 pass 记录
  async function mk(name, o) {
    const layer = o.layer || 'ODS';
    const id = await fx.model({ layer, ...(o.model || {}) });
    if (o.prep) await o.prep(id);
    await fx.record(id, layer === 'ODS' ? { phase: null } : { phase: 'all' });
    cases.push({ name, id, ...o });
    return id;
  }
  const setPath = (id, rel) => w.run('UPDATE data_models SET script_path = ? WHERE id = ?', [rel, id]);
  const call = (ctx, m, p, body) => ctx.api(m, p, { token: ctx.admin.token, body });
  const put = (ctx, id, body) => call(ctx, 'PUT', `/api/models/${id}`, body);

  // §1.1 PUT 的 A 类字段
  await mk('PUT dim_config 实质变化', {
    cls: 'A', layer: 'DIM', expectDelta: 1, expectStatus: 200, model: { dim_config: { version: 1, fields: [{ name: 'a' }] } },
    act: (c, id) => put(c, id, { dim_config: { version: 1, fields: [{ name: 'a' }, { name: 'b' }] } }),
    verify: async (c, id) => { const r = await c.row(id); c.check('PUT dim_config：新配置确已写库', JSON.parse(r.dim_config).fields.length === 2, r.dim_config); },
    covers: ['1a0c224d4a5f'], evidence: async (c, before, after) => before.dim_config !== after.dim_config && JSON.parse(before.dim_config).fields.length === 1 && JSON.parse(after.dim_config).fields.length === 2,   // PUT 带 dim_config 的 UPDATE 分支：dim_config 由 1 个字段变成 2 个
  });
  const aFields = [
    ['table_name', (c, id) => put(c, id, { table_name: fx.nextName('renamed') }), async (c, id) => c.check('PUT table_name：新表名确已写库', /^mc_renamed_/.test((await c.row(id)).table_name))],
    ['source_system', (c, id) => put(c, id, { source_system: 'SYS_B' }), async (c, id) => c.check('PUT source_system：确已写库', (await c.row(id)).source_system === 'SYS_B')],
    ['source_table', (c, id) => put(c, id, { source_table: 'src_b' }), async (c, id) => c.check('PUT source_table：确已写库', (await c.row(id)).source_table === 'src_b')],
    ['update_cycle', (c, id) => put(c, id, { update_cycle: 'da' }), async (c, id) => c.check('PUT update_cycle：确已写库', (await c.row(id)).update_cycle === 'da')],
    ['config_mode', (c, id) => put(c, id, { config_mode: 'custom' }), async (c, id) => c.check('PUT config_mode：确已写库', (await c.row(id)).config_mode === 'custom')],
  ];
  // PUT 不带 dim_config 的 UPDATE 分支（02567da9f1c1）：五个 A 类字段各一个用例，证据 = 新值确已写库
  const aEvidence = { table_name: r => /^mc_renamed_/.test(r.table_name), source_system: r => r.source_system === 'SYS_B', source_table: r => r.source_table === 'src_b', update_cycle: r => r.update_cycle === 'da', config_mode: r => r.config_mode === 'custom' };
  for (const [field, act, verify] of aFields) await mk(`PUT ${field}`, { cls: 'A', expectDelta: 1, expectStatus: 200, act, verify, covers: ['02567da9f1c1'], attrCol: new RegExp(`\\b${field}\\s*=`), evidence: async (c, before, after) => before[field] !== after[field] && aEvidence[field](after) });

  // §1.2 簿记字段 companionModelId：不触发（顶层 changeTracking 与 dwdConfig.changeTracking 两处）
  await mk('PUT 只改 changeTracking.companionModelId（顶层，DIM）', {
    cls: 'B', layer: 'DIM', expectDelta: 0, expectStatus: 200,
    model: { dim_config: { version: 1, fields: [{ name: 'a' }], changeTracking: { enabled: false, companionModelId: 11 } } },
    act: (c, id) => put(c, id, { dim_config: { version: 1, fields: [{ name: 'a' }], changeTracking: { enabled: false, companionModelId: 12 } } }),
    verify: async (c, id) => c.check('companionModelId（顶层）：新值确已写库（证明 UPDATE 真的执行了）', JSON.parse((await c.row(id)).dim_config).changeTracking.companionModelId === 12),
  });
  await mk('PUT 只改 dwdConfig.changeTracking.companionModelId（DWD）', {
    cls: 'B', layer: 'DWD', expectDelta: 0, expectStatus: 200, async: true,
    model: { dim_config: { version: 1, dwdConfig: { changeTracking: { enabled: false, companionModelId: 11 } } } },
    act: (c, id) => put(c, id, { dim_config: { version: 1, dwdConfig: { changeTracking: { enabled: false, companionModelId: 12 } } } }),
    verify: async (c, id) => c.check('companionModelId（dwdConfig）：新值确已写库', JSON.parse((await c.row(id)).dim_config).dwdConfig.changeTracking.companionModelId === 12),
  });

  // §1.3 B 类字段
  for (const [field, value] of [['table_comment', 'mc 新注释'], ['design_notes', 'mc 设计说明'], ['domain', 'NEWDOM'], ['tech_owner', 'mc_new_tech'], ['biz_owner', 'mc_new_biz'], ['category', 'core'], ['status', 'OFFLINE']]) {
    await mk(`PUT ${field}`, {
      cls: 'B', expectDelta: 0, expectStatus: 200,
      act: (c, id) => put(c, id, { [field]: value }),
      verify: async (c, id) => c.check(`PUT ${field}：新值确已写库（不是空操作才算「不变」）`, (await c.row(id))[field] === value, String((await c.row(id))[field])),
    });
  }
  // model_type：PUT 的变化判定（hasBasicInfoChange）不含 model_type，单独改它走 noChange 分支、根本不写库（既有行为，非 C1 引入）；
  // 所以与 table_comment 同时提交，保证 UPDATE 真的执行，再断言 model_type 已写库而 config_rev 不变
  await mk('PUT model_type（随 table_comment 一并提交）', {
    cls: 'B', expectDelta: 0, expectStatus: 200,
    act: (c, id) => put(c, id, { model_type: 'DICT', table_comment: 'mc 新注释（随 model_type）' }),
    verify: async (c, id) => c.check('PUT model_type：新值确已写库', (await c.row(id)).model_type === 'DICT', String((await c.row(id)).model_type)),
  });
  // §1.3b #77 C2a：impl_note（B 类）。变更日志经 insertModelChangeLog 异步写入，读侧用 waitFor 等行出现；期望摘要手写
  const changeLogs = (c, id) => c.rd.all("SELECT change_type, change_summary FROM model_change_logs WHERE model_id = ? AND action = 'UPDATE' ORDER BY id", [id]);
  const waitLogs = async (c, id, n) => { await waitFor(async () => (await changeLogs(c, id)).length >= n); await settle(150); return changeLogs(c, id); };
  // 带全当前值的请求体（让摘要里只剩「真正改动的字段」）。PUT 的 afterValue 已全部取 final 值（C2a 补修），部分字段请求体同样不误报（见「只发 {table_comment}」用例）。
  const fullBody = (extra) => ({ table_comment: 'mc 夹具', tech_owner: 'mc_tech', biz_owner: 'mc_biz', status: 'DEVELOPING', source_system: 'SYS_A', source_table: 'src_a', category: 'general', domain: 'MCDOM', update_cycle: 'di', config_mode: 'standard', ...extra });
  await mk('PUT 只改 impl_note（B 类，delta 0，写变更日志）', {
    cls: 'B', expectDelta: 0, expectStatus: 200,
    model: { impl_note: '旧实现说明' },
    act: (c, id) => put(c, id, fullBody({ impl_note: '新实现说明：每天全量覆盖' })),   // 全字段请求体：摘要只剩真正改动的字段（部分字段请求体的既有摘要误报见下方说明）
    verify: async (c, id) => {
      const r = await c.row(id);
      c.check('PUT impl_note：新值确已写库（不是空操作才算「不变」）', r.impl_note === '新实现说明：每天全量覆盖', String(r.impl_note));
      const logs = await waitLogs(c, id, 1);
      c.check('PUT impl_note：恰好 1 条 UPDATE 变更日志，change_type = basic_info，摘要 = 「修改: 实现说明」', logs.length === 1 && logs[0].change_type === 'basic_info' && logs[0].change_summary === '修改: 实现说明', JSON.stringify(logs));
    },
  });
  await mk('PUT impl_note 置空串（B 类，清空落库为 NULL）', {
    cls: 'B', expectDelta: 0, expectStatus: 200,
    model: { impl_note: '待清空' },
    act: (c, id) => put(c, id, fullBody({ impl_note: '' })),
    verify: async (c, id) => {
      const r = await c.row(id);
      c.check('PUT impl_note 空串：库里为 NULL', r.impl_note === null, JSON.stringify(r.impl_note));
      const logs = await waitLogs(c, id, 1);
      c.check('PUT impl_note 空串：摘要 = 「修改: 实现说明」', logs.length === 1 && logs[0].change_summary === '修改: 实现说明', JSON.stringify(logs));
    },
  });
  await mk('PUT 请求未带 impl_note（B 类：保留旧值，摘要不含实现说明）', {
    cls: 'B', expectDelta: 0, expectStatus: 200,
    model: { impl_note: '保留我', design_notes: '保留设计' },
    act: (c, id) => put(c, id, fullBody({ table_comment: 'mc 夹具（改）' })),
    verify: async (c, id) => {
      const r = await c.row(id);
      c.check('PUT 未带 impl_note / design_notes：两列保留旧值', r.impl_note === '保留我' && r.design_notes === '保留设计', JSON.stringify([r.impl_note, r.design_notes]));
      const logs = await waitLogs(c, id, 1);
      c.check('B-摘要 PUT 未带 impl_note / design_notes：摘要 = 「修改: 表注释」，不得误报实现说明 / 设计说明', logs.length === 1 && logs[0].change_summary === '修改: 表注释', JSON.stringify(logs));
    },
  });
  await mk('PUT 其它字段变化、impl_note / design_notes / 表名 / 业务域 / 更新周期 / 配置方式原样带回（假阳性回归）', {
    cls: 'B', expectDelta: 0, expectStatus: 200,
    model: { impl_note: '原样实现说明', design_notes: '原样设计说明' },
    act: async (c, id) => put(c, id, fullBody({ table_name: (await c.row(id)).table_name, table_comment: 'mc 夹具（再改）', impl_note: '原样实现说明', design_notes: '原样设计说明' })),
    verify: async (c, id) => {
      const logs = await waitLogs(c, id, 1);
      c.check('B-摘要 PUT 原样带回：摘要 = 「修改: 表注释」，不含实现说明 / 设计说明 / 表名 / 业务域 / 更新周期 / 配置方式', logs.length === 1 && logs[0].change_summary === '修改: 表注释', JSON.stringify(logs));
    },
  });
  await mk('PUT 只发 {table_comment} 部分字段（迁移脚本的请求形态）：摘要不得把未带字段报为变化', {
    cls: 'B', expectDelta: 0, expectStatus: 200,
    model: { impl_note: '部分字段保留', design_notes: '部分字段设计' },
    act: (c, id) => put(c, id, { table_comment: 'mc 夹具（部分字段）' }),
    verify: async (c, id) => {
      const r = await c.row(id);
      c.check('部分字段 PUT：表注释落库，其余字段（负责人 / 状态 / 源系统 / 源表 / 分类 / 两个说明）保持旧值', r.table_comment === 'mc 夹具（部分字段）' && r.tech_owner === 'mc_tech' && r.biz_owner === 'mc_biz' && r.status === 'DEVELOPING' && r.source_system === 'SYS_A' && r.source_table === 'src_a' && r.category === 'general' && r.impl_note === '部分字段保留' && r.design_notes === '部分字段设计', JSON.stringify(r));
      const logs = await waitLogs(c, id, 1);
      c.check('B-摘要 部分字段 PUT：摘要 = 「修改: 表注释」（不含技术负责人 / 业务负责人 / 状态 / 源系统 / 源表 / 分类等）', logs.length === 1 && logs[0].change_summary === '修改: 表注释', JSON.stringify(logs));
    },
  });
  // P2：变化判定与摘要同口径。遗留形态：category 在库里是 NULL（前端编辑弹窗回填 `model.category || 'general'`，保存时发规范默认值 'general'）
  const uiPayload = async (c, id, extra) => ({ layer: 'ODS', domain: 'MCDOM', table_name: (await c.row(id)).table_name, table_comment: 'mc 夹具', tech_owner: 'mc_tech', biz_owner: 'mc_biz', update_cycle: 'di', status: 'DEVELOPING', category: 'general', source_system: 'SYS_A', source_table: 'src_a', design_notes: null, impl_note: null, ...extra });
  await mk('PUT 遗留 NULL 的 category 按前端 confirmRegister 真实载荷原样回写 → noChange、零日志、库值仍为 NULL', {
    cls: 'B', expectDelta: 0, expectStatus: 200,
    model: { category: null },
    act: async (c, id) => put(c, id, await uiPayload(c, id)),
    verify: async (c, id, res) => {
      c.check('B-判定 遗留 NULL 回写：响应标记 noChange', res.json && res.json.noChange === true, JSON.stringify(res.json));
      await settle(400);
      const logs = await changeLogs(c, id);
      c.check('B-判定 遗留 NULL 回写：没有任何 UPDATE 变更日志', logs.length === 0, JSON.stringify(logs));
      const r = await c.row(id);
      c.check('B-判定 遗留 NULL 回写：库里 category 仍为 NULL（没有被规范化写成 general）', r.category === null, JSON.stringify(r.category));
    },
  });
  await mk('PUT 遗留 NULL 的 category 真实改成 core → 写库、摘要点名「分类」', {
    cls: 'B', expectDelta: 0, expectStatus: 200,
    model: { category: null },
    act: async (c, id) => put(c, id, await uiPayload(c, id, { category: 'core' })),
    verify: async (c, id) => {
      const r = await c.row(id);
      c.check('category 真实修改：新值落库', r.category === 'core', JSON.stringify(r.category));
      const logs = await waitLogs(c, id, 1);
      c.check('B-判定 category 真实修改：恰 1 条日志，摘要 = 「修改: 分类」', logs.length === 1 && logs[0].change_summary === '修改: 分类', JSON.stringify(logs));
    },
  });
  await mk('PUT 同时改 设计说明 与 业务域（补缺对照表字段各出一项）', {
    cls: 'B', expectDelta: 0, expectStatus: 200,
    model: { design_notes: '旧设计' },
    act: (c, id) => put(c, id, fullBody({ design_notes: '新设计', domain: 'NEWDOM2' })),
    verify: async (c, id) => {
      const logs = await waitLogs(c, id, 1);
      c.check('PUT 设计说明 + 业务域：摘要 = 「修改: 设计说明, 业务域」（按对照表顺序）', logs.length === 1 && logs[0].change_summary === '修改: 设计说明, 业务域', JSON.stringify(logs));
    },
  });
  await mk('PUT 全部字段（含 impl_note / design_notes）与当前值相同 → noChange、不写变更日志', {
    cls: 'B', expectDelta: 0, expectStatus: 200,
    model: { impl_note: '一致实现说明', design_notes: '一致设计说明' },
    act: async (c, id) => put(c, id, fullBody({ table_name: (await c.row(id)).table_name, impl_note: '一致实现说明', design_notes: '一致设计说明' })),
    verify: async (c, id, res) => {
      c.check('noChange（含 impl_note）：响应标记 noChange', res.json && res.json.noChange === true, JSON.stringify(res.json));
      await settle(400);
      const logs = await changeLogs(c, id);
      c.check('noChange（含 impl_note）：没有任何 UPDATE 变更日志', logs.length === 0, JSON.stringify(logs));
    },
  });
  await mk('PUT impl_note 空串而库里本就是 NULL → noChange（空值等价，不产生假变更日志）', {
    cls: 'B', expectDelta: 0, expectStatus: 200,
    act: (c, id) => put(c, id, { impl_note: '' }),
    verify: async (c, id, res) => {
      c.check('impl_note 空串 vs NULL：响应标记 noChange', res.json && res.json.noChange === true, JSON.stringify(res.json));
      await settle(400);
      const logs = await changeLogs(c, id);
      c.check('impl_note 空串 vs NULL：没有任何 UPDATE 变更日志', logs.length === 0, JSON.stringify(logs));
    },
  });
  await mk('PUT 全部字段值不变（noChange）', {
    cls: 'B', expectDelta: 0, expectStatus: 200,
    act: (c, id) => put(c, id, { table_comment: 'mc 夹具', domain: 'MCDOM', source_system: 'SYS_A', source_table: 'src_a', update_cycle: 'di', config_mode: 'standard' }),
    verify: async (c, id, res) => c.check('noChange：响应标记 noChange', res.json && res.json.noChange === true, JSON.stringify(res.json)),
  });

  // §1.3c #77 C2a 修复 F1：表注释拆分专用原子条件写接口 PUT /api/models/:id/comment-split（B 类，登记在写入点分类守卫里）。
  //   成功路径走 mk（B 类 delta 0 + 写点归因窗口 0 条递增）；409 / 403 / 400 / 404 / 伴生归属等负向与边界用例在 runCommentSplit（用 cases.cs 里预建的夹具）。
  const csFull = {};
  await mk('PUT comment-split 成功（B 类，delta 0）：只改 table_comment / impl_note 两列，写 1 条 basic_info 变更日志', {
    cls: 'B', expectDelta: 0, expectStatus: 200,
    model: { table_comment: 'mc 拆分旧注释（含括号的实现细节）', impl_note: null },
    act: async (c, id) => {
      csFull.before = await c.row(id);
      return call(c, 'PUT', `/api/models/${id}/comment-split`, { expected: { table_comment: 'mc 拆分旧注释（含括号的实现细节）', impl_note: null }, set: { table_comment: 'mc 拆分短名', impl_note: '（含括号的实现细节）' } });
    },
    verify: async (c, id) => {
      const r = await c.row(id);
      c.check('comment-split：table_comment / impl_note 确已落库', r.table_comment === 'mc 拆分短名' && r.impl_note === '（含括号的实现细节）', JSON.stringify([r.table_comment, r.impl_note]));
      const diffCols = Object.keys(csFull.before).filter(k => csFull.before[k] !== r[k]).sort();
      c.check('comment-split：整行只有 impl_note / table_comment / updated_at 三列变化（其余列包括 config_rev、category、dim_config 逐列相同）', JSON.stringify(diffCols) === JSON.stringify(['impl_note', 'table_comment', 'updated_at']), JSON.stringify(diffCols));
      const logs = await waitLogs(c, id, 1);
      c.check('comment-split：恰好 1 条 UPDATE 变更日志，change_type = basic_info，摘要 = 「修改: 表注释, 实现说明」', logs.length === 1 && logs[0].change_type === 'basic_info' && logs[0].change_summary === '修改: 表注释, 实现说明', JSON.stringify(logs));
    },
  });
  cases.cs = {
    mismatch: await fx.model({ table_comment: 'mc cs 旧注释', impl_note: null }),
    implMismatch: await fx.model({ table_comment: 'mc cs 注释B', impl_note: null }),
    nonAdmin: await fx.model({ table_comment: 'mc cs 注释C', impl_note: null }),
    deleted: await fx.model({ table_comment: 'mc cs 已删除模型注释', impl_note: null, is_deleted: 1 }),
    compParent: null, compOther: null, comp: null,
    blankImpl: await fx.model({ table_comment: 'mc cs 注释D', impl_note: '待清空的实现说明' }),
    noop: await fx.model({ table_comment: 'mc cs 注释E', impl_note: '原实现说明' }),
    parentOk: await fx.model({ table_comment: 'mc cs 注释F', impl_note: null }),
  };
  cases.cs.compParent = await fx.model({ layer: 'DWD', table_comment: 'mc cs 父表注释' });
  cases.cs.compOther = await fx.model({ layer: 'DWD', table_comment: 'mc cs 另一个父表注释' });
  cases.cs.comp = await fx.model({ layer: 'DWD', table_comment: 'mc cs 父表注释 - 变更追踪', companion_of: cases.cs.compParent, config_mode: 'companion' });

  // §1.4 save-scripts（脚本文件与 script_path 全部预先放好）
  const save = (c, id, scripts, tableName, extra) => call(c, 'POST', `/api/models/${id}/save-scripts`, { scripts, tableName, ...(extra || {}) });
  const curRev = async (c, id) => (await c.row(id)).config_rev;
  const tn = async (id) => (await w.get('SELECT table_name FROM data_models WHERE id = ?', [id])).table_name;
  // P53 = B（用户裁定）：首次落盘（当前目录与 script_path 目录都没有同名文件）一律递增，豁免只留给「ODS 验收后自动保存、purpose = ods-auto-save 且 expected_config_rev 等于当前版本」（见下方 P53 用例组）。
  //   旧口径：首次落盘 configRevBumped === false、delta 0；新口径：不带 purpose 的普通保存 === true、delta 1。
  await mk('save-scripts 首次落盘（无同名文件；不带 purpose 的普通保存）', {
    cls: 'A', expectDelta: 1, expectStatus: 200,
    act: async (c, id) => save(c, id, { ddl: ddl('2026-10-01', 'a int'), sync: 'SELECT 1;' }, (await c.row(id)).table_name),
    verify: async (c, id, res) => c.check('save-scripts 首次落盘（普通保存）：2 个文件确已保存，响应 configRevBumped === true', res.json && res.json.savedFiles && res.json.savedFiles.length === 2 && res.json.configRevBumped === true, JSON.stringify(res.json)),
  });
  const curDirPrep = (content) => async (id) => {       // 当前目录（无关联任务 = 用户目录下的模型文件夹）已有同名 DDL
    const t = await tn(id);
    const rel = `${adminDir}/model_${id}_${safe(t)}`;
    seedFile(rel, `${safe(t)}_DDL.sql`, content);
    await setPath(id, rel);
  };
  await mk('save-scripts 同内容仅头部生成时刻不同', {
    cls: 'B', expectDelta: 0, expectStatus: 200, prep: curDirPrep(ddl('2026-10-01', 'a int')),
    act: async (c, id) => save(c, id, { ddl: ddl('2026-10-02', 'a int') }, (await c.row(id)).table_name),
    verify: async (c, id, res) => c.check('save-scripts 仅时间戳不同：判「内容无变化」未写文件', res.json && res.json.savedFiles.length === 0 && res.json.skippedFiles.length === 1 && res.json.configRevBumped === false, JSON.stringify(res.json)),
  });
  await mk('save-scripts 业务内容变化', {
    cls: 'A', expectDelta: 1, expectStatus: 200, prep: curDirPrep(ddl('2026-10-01', 'a int')),
    act: async (c, id) => save(c, id, { ddl: ddl('2026-10-01', 'a int, b int') }, (await c.row(id)).table_name),
    verify: async (c, id, res) => c.check('save-scripts 业务变化：新文件确已保存，响应 configRevBumped === true', res.json && res.json.savedFiles.length === 1 && res.json.archivedFiles.length === 1 && res.json.configRevBumped === true, JSON.stringify(res.json)),
    // save-scripts 更新 script_path 的 UPDATE（2fc5964e2400）：夹具里 script_saved_by 为 NULL，执行后必为操作者名
    covers: ['2fc5964e2400'], evidence: async (c, before, after) => before.script_saved_by == null && after.script_saved_by === c.admin.display_name,
  });
  // save-scripts 分支全集：「当前目录有同名 / 仅 script_path 目录有同名 / 两处都没有」×「归一化后内容变化 / 不变」；两处都没有 = 首次落盘，无旧内容可比（P53：普通保存 +1，只有 ODS 验收后自动保存且版本等于当前才 0，见下方 P53 用例组）：
  //   当前目录有同名 + 变化 +1（上）／仅头部不同（归一化后不变）0（上）／完全相同 0（下）；仅 script_path 目录有同名 + 变化 +1 ／ 不变 0（下 for 循环）
  await mk('save-scripts 当前目录有同名文件且内容完全相同', {
    cls: 'B', expectDelta: 0, expectStatus: 200, prep: curDirPrep(ddl('2026-10-01', 'a int')),
    act: async (c, id) => save(c, id, { ddl: ddl('2026-10-01', 'a int') }, (await c.row(id)).table_name),
    verify: async (c, id, res) => c.check('save-scripts 完全相同：判「内容无变化」未写文件，响应 configRevBumped === false', res.json && res.json.savedFiles.length === 0 && res.json.skippedFiles.length === 1 && res.json.configRevBumped === false, JSON.stringify(res.json)),
  });
  // F1（C1 对抗审，主会话返工口径）：目录翻转时比较「生效脚本集合」——内容不同 +1；目录翻转但生效集合一致 0（ODS 新任务首次验收后自动保存的形态）
  for (const [label, changed] of [['内容不同', true], ['内容相同（目录翻转、生效集合一致）', false]]) {
    await mk(`save-scripts 当前目录无同名文件、script_path 目录有且${label}`, {
      cls: changed ? 'A' : 'B', expectDelta: changed ? 1 : 0, expectStatus: 200,
      prep: async (id) => {
        await curDirPrep(ddl('2026-10-01', 'a int'))(id);                       // script_path 目录里有同名 DDL
        await w.run("INSERT INTO task_pool (title, status, owner, owner_id, linked_model_id, category, created_at) VALUES (?, 'CLAIMED', ?, ?, ?, 'ODS_SYNC', '2026-03-10 12:00:00')",
          [fx.nextName('dirtask'), `mc_dir_owner_${id}`, 1, id]);               // 有关联任务 ⇒ 本次落盘目录换成任务目录（该目录里没有同名文件）
      },
      act: async (c, id) => save(c, id, { ddl: ddl('2026-10-09', changed ? 'a int, c int' : 'a int') }, (await c.row(id)).table_name),
      verify: async (c, id, res) => c.check(`save-scripts（${label}）：本次确实写入了新目录，响应 configRevBumped === ${changed}`, res.json && res.json.savedFiles.length === 1 && /mc_dir_owner_/.test(res.json.scriptPath || '') && res.json.configRevBumped === changed, JSON.stringify(res.json)),
    });
  }

  // F1（C1 对抗审，HIGH）：四步复现——① B 目录（script_path 所指）是验收时的 ddl（'a int, b int'）② A 目录（本次落盘目录）残留与新内容相同的旧 ddl（'a int'）
  //   ③ script_path 指向 B ④ 保存 { ddl（与 A 相同 ⇒ 跳过不写）, sync（新文件 ⇒ 写入，script_path 翻转回 A）}：实际生效的 ddl 由 B 的版本变成 A 的版本，config_rev 必须 +1。
  //   旧实现：ddl 只和 A 比（相同）、sync 两处都没有 ⇒ 不递增（漏记）。归因仍须满足 2fc5964e2400 的「助手在前、目标 UPDATE script_path 紧随其后」。
  const dirB = (id) => `mc_other_owner/b_dir_${id}`;
  await mk('save-scripts 四步复现（A 残留同内容 ddl、script_path 指向 B、另一文件触发写入使 script_path 翻转回 A）', {
    cls: 'A', expectDelta: 1, expectStatus: 200,
    prep: async (id) => {
      const t = await tn(id);
      const rel = `${adminDir}/model_${id}_${safe(t)}`;
      seedFile(rel, `${safe(t)}_DDL.sql`, ddl('2026-10-01', 'a int'));                    // A：残留旧 ddl，与本次新内容相同
      seedFile(dirB(id), `${safe(t)}_DDL.sql`, ddl('2026-10-01', 'a int, b int'));        // B：验收时的 ddl（与 A 残留 / 本次请求不同——这是唯一的差异）
      seedFile(dirB(id), `${safe(t)}_同步脚本.sql`, 'SELECT 1;');                          // B：同步脚本与本次请求里的 sync 完全一致，避免 sync「只在一边存在」自己撞出 +1
      await setPath(id, dirB(id));
    },
    act: async (c, id) => save(c, id, { ddl: ddl('2026-10-05', 'a int'), sync: 'SELECT 1;' }, (await c.row(id)).table_name),
    verify: async (c, id, res) => c.check('save-scripts 四步复现：ddl 跳过、sync 写入，script_path 翻转回 A，响应 configRevBumped === true',
      res.json && res.json.savedFiles.length === 1 && res.json.savedFiles[0].type === '同步脚本' && res.json.skippedFiles.length === 1 && res.json.configRevBumped === true && new RegExp(`^${adminDir}/model_${id}_`).test(String(res.json.scriptPath || '').replace(/\\/g, '/')), JSON.stringify(res.json)),
    covers: ['2fc5964e2400'], evidence: async (c, before, after) => /^mc_other_owner\/b_dir_/.test(String(before.script_path || '').replace(/\\/g, '/')) && String(after.script_path || '').replace(/\\/g, '/').startsWith(`${adminDir}/model_`),
  });
  // F1 ②b：旧目录（script_path）有同步脚本、新目录（任务目录）写后没有——某文件名只在一边存在 ⇒ 生效集合不同，+1
  const taskPrep = (id) => w.run("INSERT INTO task_pool (title, status, owner, owner_id, linked_model_id, category, created_at) VALUES (?, 'CLAIMED', ?, ?, ?, 'ODS_SYNC', '2026-03-10 12:00:00')", [fx.nextName('dirtask'), `mc_dir_owner_${id}`, 1, id]);
  await mk('save-scripts 目录翻转、旧目录有同步脚本而新目录写后没有（只在一边存在）', {
    cls: 'A', expectDelta: 1, expectStatus: 200,
    prep: async (id) => { await curDirPrep(ddl('2026-10-01', 'a int'))(id); const t = await tn(id); seedFile(`${adminDir}/model_${id}_${safe(t)}`, `${safe(t)}_同步脚本.sql`, 'SELECT 1;'); await taskPrep(id); },
    act: async (c, id) => save(c, id, { ddl: ddl('2026-10-09', 'a int') }, (await c.row(id)).table_name),
    verify: async (c, id, res) => c.check('save-scripts 只在一边存在：本次写入新目录，响应 configRevBumped === true', res.json && res.json.savedFiles.length === 1 && /mc_dir_owner_/.test(res.json.scriptPath || '') && res.json.configRevBumped === true, JSON.stringify(res.json)),
  });
  // ODS 新任务首次验收后自动保存：旧 script_path 为旧任务目录（ddl + sync），新任务目录为空，本次生成内容与旧目录一致 ⇒ 0（刚做的验收不得因此失效）
  await mk('save-scripts ODS 新任务首次验收后自动保存（旧任务目录内容与新生成一致）', {
    cls: 'B', expectDelta: 0, expectStatus: 200,
    prep: async (id) => { await curDirPrep(ddl('2026-10-01', 'a int'))(id); const t = await tn(id); seedFile(`${adminDir}/model_${id}_${safe(t)}`, `${safe(t)}_同步脚本.sql`, 'SELECT 1;'); await taskPrep(id); },
    act: async (c, id) => save(c, id, { ddl: ddl('2026-10-09', 'a int'), sync: 'SELECT 1;' }, (await c.row(id)).table_name, { purpose: 'ods-auto-save', expected_config_rev: await curRev(c, id) }),
    verify: async (c, id, res) => c.check('save-scripts ODS 自动保存（带 purpose + 当前版本）：两个文件写入新任务目录，响应 configRevBumped === false', res.json && res.json.savedFiles.length === 2 && /mc_dir_owner_/.test(res.json.scriptPath || '') && res.json.configRevBumped === false, JSON.stringify(res.json)),
  });
  // ═══ P53 = B：首次落盘的豁免只留给「ODS 验收后自动保存、请求带的版本等于当前版本」；其余首次落盘一律递增 ═══
  //   前置：每个用例的模型当前目录与 script_path 目录都没有同名文件（真正的首次落盘）。
  const firstSaveBody = { ddl: ddl('2026-10-01', 'a int'), sync: 'SELECT 1;' };
  await mk('save-scripts P53 ODS + purpose + 当前版本的首次落盘（唯一的豁免）', {
    cls: 'B', expectDelta: 0, expectStatus: 200,
    act: async (c, id) => save(c, id, firstSaveBody, (await c.row(id)).table_name, { purpose: 'ods-auto-save', expected_config_rev: await curRev(c, id) }),
    verify: async (c, id, res) => c.check('P53 豁免：ODS + purpose + 当前版本的首次落盘：2 个文件已保存，响应 configRevBumped === false', res.json && res.json.savedFiles && res.json.savedFiles.length === 2 && res.json.configRevBumped === false, JSON.stringify(res.json)),
  });
  await mk('save-scripts P53 layer 写成小写 ods 同样豁免（服务端按 layer 大小写不敏感判）', {
    cls: 'B', expectDelta: 0, expectStatus: 200,
    prep: async (id) => { await w.run("UPDATE data_models SET layer = 'ods' WHERE id = ?", [id]); },
    act: async (c, id) => save(c, id, firstSaveBody, (await c.row(id)).table_name, { purpose: 'ods-auto-save', expected_config_rev: await curRev(c, id) }),
    verify: async (c, id, res) => c.check('P53 豁免：layer = ods（小写）+ purpose + 当前版本：响应 configRevBumped === false', res.json && res.json.savedFiles && res.json.savedFiles.length === 2 && res.json.configRevBumped === false, JSON.stringify(res.json)),
  });
  // ═══ P57②（codex 49A-astra MED）：ODS 自动保存（purpose = ods-auto-save）版本过期 ⇒ 409 CONFIG_REV_STALE，零写入；缺 expected_config_rev ⇒ 400 EXPECTED_CONFIG_REV_REQUIRED，零写入 ═══
  //   旧口径（P53 = B 初版）：版本过期不豁免、照常落盘并递增（把按旧配置生成的脚本写进去）；新口径：直接 409，零写入；前端不重试（409 ⇒ 这次验收已失效，只提示并重查能否自行归档，见 Model_Center.html autoSaveOdsScripts）。
  const noWrites = async (c, label, s0) => {   // 请求窗口内 data_models 写语句 = 0（sql-trace 追踪）
    await settle(300);
    const writes = c.traceRecords().filter(r => r.seq > s0);
    c.check(`${label}：请求窗口内 data_models 写语句 = 0（零写入）`, writes.length === 0, JSON.stringify(writes.map(r => r.sql.slice(0, 100))));
  };
  const scriptDirOf = (c, id, t) => path.join(c.copyRoot, 'uploads', adminDir, `model_${id}_${safe(t)}`);
  const staleAct = (delta, label) => async (c, id) => {
    const s0 = c.traceLastSeq();
    const res = await save(c, id, firstSaveBody, (await c.row(id)).table_name, { purpose: 'ods-auto-save', expected_config_rev: (await curRev(c, id)) + delta });
    await noWrites(c, label, s0);
    return res;
  };
  await mk('save-scripts P53 ODS + purpose + 版本已过期（当前 - 1）的首次落盘 ⇒ 409', {
    cls: 'B', expectDelta: 0, expectStatus: 409,
    act: staleAct(-1, 'P57 版本过期（-1）'),
    verify: async (c, id, res) => {
      const row = await c.row(id);
      c.check('P57 版本过期 ⇒ 409 CONFIG_REV_STALE，响应带 current_config_rev（= 当前版本）；没有写出任何脚本文件（目录都不存在）、script_path 仍为空、config_rev 未递增',
        res.json && res.json.code === 'CONFIG_REV_STALE' && res.json.current_config_rev === row.config_rev && !fs.existsSync(scriptDirOf(c, id, row.table_name)) && row.script_path == null, JSON.stringify([res.json, row.script_path]));
    },
  });
  await mk('save-scripts P53 ODS + purpose + 版本领先于当前（当前 + 1）的首次落盘 ⇒ 409', {
    cls: 'B', expectDelta: 0, expectStatus: 409,
    act: staleAct(1, 'P57 版本领先（+1）'),
    verify: async (c, id, res) => c.check('P57 版本不等（领先）同样 409 CONFIG_REV_STALE：判据是「不等于当前」，不是「小于当前」；零写入', res.json && res.json.code === 'CONFIG_REV_STALE' && !fs.existsSync(scriptDirOf(c, id, (await c.row(id)).table_name)), JSON.stringify(res.json)),
  });
  {
    const oldDdl = ddl('2026-10-01', 'a int');
    await mk('save-scripts P53 ODS + purpose + 版本已过期 + 当前目录已有脚本 ⇒ 409', {
      cls: 'B', expectDelta: 0, expectStatus: 409, prep: curDirPrep(oldDdl),
      act: async (c, id) => {
        const s0 = c.traceLastSeq();
        const res = await save(c, id, { ddl: ddl('2026-10-09', 'a int, b int') }, (await c.row(id)).table_name, { purpose: 'ods-auto-save', expected_config_rev: (await curRev(c, id)) - 1 });
        await noWrites(c, 'P57 过期 + 已有脚本', s0);
        return res;
      },
      verify: async (c, id, res) => {
        const row = await c.row(id);
        const dir = scriptDirOf(c, id, row.table_name);
        const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
        c.check('P57 过期 + 已有脚本 ⇒ 409，旧脚本文件内容原样（不归档、不覆盖、没有 _history 目录），script_path 不变',
          res.json && res.json.code === 'CONFIG_REV_STALE' && names.length === 1 && fs.readFileSync(path.join(dir, names[0]), 'utf8') === oldDdl && row.script_path === `${adminDir}/model_${id}_${safe(row.table_name)}`, JSON.stringify([res.json, names, row.script_path]));
      },
    });
  }
  await mk('save-scripts P53 DIM + purpose + 版本已过期的首次落盘 ⇒ 409（purpose 驱动，不论分层）', {
    cls: 'B', layer: 'DIM', expectDelta: 0, expectStatus: 409,
    act: staleAct(-1, 'P57 DIM 版本过期'),
    verify: async (c, id, res) => c.check('P57 purpose 驱动：DIM 模型带 purpose = ods-auto-save + 过期版本同样 409 CONFIG_REV_STALE，零写入', res.json && res.json.code === 'CONFIG_REV_STALE' && !fs.existsSync(scriptDirOf(c, id, (await c.row(id)).table_name)), JSON.stringify(res.json)),
  });
  // P57 §7：分层不是 ODS 的 purpose = ods-auto-save 请求一律 409 LAYER_NOT_ODS（原口径是「不豁免、按普通保存落盘并递增」——会把 ODS 生成的 DDL 写进 DIM / DWD 模型的目录），零写入
  for (const layer of ['DIM', 'DWD']) {
    await mk(`save-scripts P53 ${layer} 模型带 purpose + 当前版本的首次落盘 ⇒ 409 LAYER_NOT_ODS`, {
      cls: 'B', layer, expectDelta: 0, expectStatus: 409,
      act: staleAct(0, `P57 ${layer} 当前版本`),
      verify: async (c, id, res) => c.check(`P53 分层不是 ODS：${layer} + purpose + 当前版本 ⇒ 409 LAYER_NOT_ODS，零写入（目录都不存在）`,
        res.json && res.json.code === 'LAYER_NOT_ODS' && !fs.existsSync(scriptDirOf(c, id, (await c.row(id)).table_name)), JSON.stringify(res.json)),
    });
  }
  await mk('save-scripts P53 purpose 写错（ods-autosave）+ 当前版本的首次落盘', {
    cls: 'A', expectDelta: 1, expectStatus: 200,
    act: async (c, id) => save(c, id, firstSaveBody, (await c.row(id)).table_name, { purpose: 'ods-autosave', expected_config_rev: await curRev(c, id) }),
    verify: async (c, id, res) => c.check('P53 purpose 写错不豁免：响应 configRevBumped === true', res.json && res.json.savedFiles && res.json.savedFiles.length === 2 && res.json.configRevBumped === true, JSON.stringify(res.json)),
  });
  for (const [label, layer] of [['ODS', 'ODS'], ['DIM（不论分层）', 'DIM']]) {
    await mk(`save-scripts P53 ${label} 只带 purpose、缺 expected_config_rev 的首次落盘 ⇒ 400`, {
      cls: 'B', layer, expectDelta: 0, expectStatus: 400,
      act: async (c, id) => {
        const s0 = c.traceLastSeq();
        const res = await save(c, id, firstSaveBody, (await c.row(id)).table_name, { purpose: 'ods-auto-save' });
        await noWrites(c, `P57 ${label} 缺版本`, s0);
        return res;
      },
      verify: async (c, id, res) => c.check(`P57 ${label} 缺版本：purpose = ods-auto-save 必须带 expected_config_rev ⇒ 400 EXPECTED_CONFIG_REV_REQUIRED，没有任何脚本文件被写出，零写入`,
        res.json && res.json.code === 'EXPECTED_CONFIG_REV_REQUIRED' && !fs.existsSync(scriptDirOf(c, id, (await c.row(id)).table_name)), JSON.stringify(res.json)),
    });
  }
  await mk('save-scripts P53 只带 expected_config_rev（当前版本）、缺 purpose 的首次落盘', {
    cls: 'A', expectDelta: 1, expectStatus: 200,
    act: async (c, id) => save(c, id, firstSaveBody, (await c.row(id)).table_name, { expected_config_rev: await curRev(c, id) }),
    verify: async (c, id, res) => c.check('P53 缺 purpose 不豁免：只带当前版本 ⇒ 响应 configRevBumped === true', res.json && res.json.savedFiles && res.json.savedFiles.length === 2 && res.json.configRevBumped === true, JSON.stringify(res.json)),
  });
  // ═══ P57⑤（codex 49C MED）：豁免只限「首次落盘」——ODS + 正确 purpose + 当前版本、但已有脚本且内容改变的自动保存必须照常递增 ═══
  //   两种「已有脚本」：旧脚本在本次落盘的当前目录；旧脚本只在 script_path 指向的另一个目录（当前目录无同名文件）。
  //   诚实实现若把豁免误用到所有合格自动保存，这两条会判红（版本不递增，刚做的验收不会失效）。
  {
    const oldDdl = ddl('2026-10-01', 'a int'), newDdl = ddl('2026-10-09', 'a int, b int');
    await mk('save-scripts P57⑤ ODS + purpose + 当前版本、当前目录已有脚本且内容改变 ⇒ 递增', {
      cls: 'A', expectDelta: 1, expectStatus: 200, prep: curDirPrep(oldDdl),
      act: async (c, id) => save(c, id, { ddl: newDdl }, (await c.row(id)).table_name, { purpose: 'ods-auto-save', expected_config_rev: await curRev(c, id) }),
      verify: async (c, id, res) => {
        const t = (await c.row(id)).table_name;
        const f = path.join(scriptDirOf(c, id, t), `${safe(t)}_DDL.sql`);
        c.check('P57⑤ 当前目录有旧脚本：豁免不适用——响应 configRevBumped === true，1 个文件已保存、旧版本已归档，文件内容已更新为新内容',
          res.json && res.json.configRevBumped === true && res.json.savedFiles.length === 1 && res.json.archivedFiles.length === 1 && fs.readFileSync(f, 'utf8') === newDdl, JSON.stringify(res.json));
      },
    });
    await mk('save-scripts P57⑤ ODS + purpose + 当前版本、旧脚本只在 script_path 目录且内容改变 ⇒ 递增', {
      cls: 'A', expectDelta: 1, expectStatus: 200,
      prep: async (id) => { await curDirPrep(oldDdl)(id); await taskPrep(id); },   // 旧 ddl 在 script_path 目录；有关联任务 ⇒ 本次落盘目录换成任务目录（该目录里没有同名文件）
      act: async (c, id) => save(c, id, { ddl: newDdl }, (await c.row(id)).table_name, { purpose: 'ods-auto-save', expected_config_rev: await curRev(c, id) }),
      verify: async (c, id, res) => {
        const t = (await c.row(id)).table_name;
        const newFile = res.json && res.json.scriptPath ? path.join(c.copyRoot, 'uploads', res.json.scriptPath, `${safe(t)}_DDL.sql`) : null;
        const oldFile = path.join(scriptDirOf(c, id, t), `${safe(t)}_DDL.sql`);
        c.check('P57⑤ 旧脚本只在 script_path 目录：豁免不适用——响应 configRevBumped === true，新内容写入任务目录，旧目录里的旧脚本原样',
          res.json && res.json.configRevBumped === true && res.json.savedFiles.length === 1 && /mc_dir_owner_/.test(res.json.scriptPath || '') && !!newFile && fs.readFileSync(newFile, 'utf8') === newDdl && fs.readFileSync(oldFile, 'utf8') === oldDdl, JSON.stringify(res.json));
      },
    });
  }
  // 类型不对 ⇒ 400 且零写入（data_models 写语句 = 0、没有文件、config_rev 不变）
  for (const [label, extra] of [['expected_config_rev 是字符串 "1"', { purpose: 'ods-auto-save', expected_config_rev: '1' }], ['expected_config_rev 是小数 1.5', { purpose: 'ods-auto-save', expected_config_rev: 1.5 }], ['expected_config_rev 是 null', { purpose: 'ods-auto-save', expected_config_rev: null }], ['purpose 是数字 123', { purpose: 123, expected_config_rev: 1 }], ['purpose 是 null', { purpose: null }]]) {
    await mk(`save-scripts P53 ${label} → 400、零写入`, {
      cls: 'B', expectDelta: 0, expectStatus: 400,
      act: async (c, id) => {
        const s0 = c.traceLastSeq();
        const res = await save(c, id, firstSaveBody, (await c.row(id)).table_name, extra);
        await settle(300);
        const writes = c.traceRecords().filter(r => r.seq > s0);
        c.check(`P53 ${label}：请求窗口内 data_models 写语句 = 0（零写入）`, writes.length === 0, JSON.stringify(writes.map(r => r.sql.slice(0, 100))));
        return res;
      },
      verify: async (c, id, res) => {
        const t = (await c.row(id)).table_name;
        c.check(`P53 ${label}：400 且没有任何脚本文件被写出`, res.status === 400 && res.json && res.json.error && !fs.existsSync(path.join(c.copyRoot, 'uploads', adminDir, `model_${id}_${safe(t)}`)), JSON.stringify(res.json));
      },
    });
  }
  // F1 P3：旧目录里有非 6 个受管名的顶层 .sql（custom 形态 X_FDL节点1.sql）——归档快照 / GET /scripts 读的是目录顶层全部 .sql；翻转后它只在旧目录 ⇒ +1
  await mk('save-scripts custom 形态：旧目录有 X_FDL节点1.sql（非受管名），本次只写内容相同的 ddl 到新目录', {
    cls: 'A', expectDelta: 1, expectStatus: 200,
    prep: async (id) => { await curDirPrep(ddl('2026-10-01', 'a int'))(id); const t = await tn(id); seedFile(`${adminDir}/model_${id}_${safe(t)}`, `${safe(t)}_FDL节点1.sql`, 'SELECT 7;'); await taskPrep(id); },
    act: async (c, id) => save(c, id, { ddl: ddl('2026-10-09', 'a int') }, (await c.row(id)).table_name),
    verify: async (c, id, res) => c.check('save-scripts custom 形态：ddl 写入新任务目录，响应 configRevBumped === true', res.json && res.json.savedFiles.length === 1 && /mc_dir_owner_/.test(res.json.scriptPath || '') && res.json.configRevBumped === true, JSON.stringify(res.json)),
  });
  // F1 P6：目录翻转 + 新目录里有本次未写的同名文件（ddl，跳过）+ 生效集合一致 ⇒ 0（质量规则本次写入，与旧目录相同）
  await mk('save-scripts 目录翻转、新目录有本次跳过的同名文件、生效集合一致', {
    cls: 'B', expectDelta: 0, expectStatus: 200,
    prep: async (id) => {
      await curDirPrep(ddl('2026-10-01', 'a int'))(id); const t = await tn(id);
      seedFile(`${adminDir}/model_${id}_${safe(t)}`, `${safe(t)}_质量规则.sql`, 'SELECT 2;');
      const title = `p6task_${id}`; const owner = `mc_dir_owner_${id}`;
      const tr = await w.run("INSERT INTO task_pool (title, status, owner, owner_id, linked_model_id, category, created_at) VALUES (?, 'CLAIMED', ?, 1, ?, 'ODS_SYNC', '2026-03-10 12:00:00')", [title, owner, id]);
      seedFile(`${owner}/${tr.lastID}_${title}`, `${safe(t)}_DDL.sql`, ddl('2026-10-01', 'a int'));   // 新任务目录里已有同名 ddl（本次请求里内容相同 ⇒ 跳过）
    },
    act: async (c, id) => save(c, id, { ddl: ddl('2026-10-09', 'a int'), quality: 'SELECT 2;' }, (await c.row(id)).table_name),
    verify: async (c, id, res) => c.check('save-scripts 跳过文件 + 集合一致：ddl 跳过、质量规则写入新任务目录，响应 configRevBumped === false', res.json && res.json.savedFiles.length === 1 && res.json.skippedFiles.length === 1 && /mc_dir_owner_/.test(res.json.scriptPath || '') && res.json.configRevBumped === false, JSON.stringify(res.json)),
  });
  // G2：任务提交附件（{任务号}_{类型}_{日期}.sql）与模型脚本同在任务目录；生效集合不靠表名前缀，而是按 task_attachments 登记精确排除
  //   （file_name 存相对 uploads 的路径，按 path.resolve(uploads, file_name) 比对绝对路径）。edit-script 能建出任意文件名，未登记的无前缀 .sql 必须算脚本。
  const registerAttachment = (taskId, relPath) => w.run("INSERT INTO task_attachments (task_id, attachment_type, file_name, original_name) VALUES (?, 'sql_script', ?, 'x.sql')", [taskId, relPath]);
  await mk('save-scripts 旧任务目录含任务附件（已登记）、模型脚本生效集合一致 → 0（附件不算）', {
    cls: 'B', expectDelta: 0, expectStatus: 200,
    prep: async (id) => {
      await curDirPrep(ddl('2026-10-01', 'a int'))(id); const t = await tn(id);
      const relDir = `${adminDir}/model_${id}_${safe(t)}`;
      seedFile(relDir, '77_sql_script_20260301.sql', 'SELECT 99;');
      await registerAttachment(77, `${relDir}/77_sql_script_20260301.sql`);
      await taskPrep(id);
    },
    act: async (c, id) => save(c, id, { ddl: ddl('2026-10-09', 'a int') }, (await c.row(id)).table_name),
    verify: async (c, id, res) => c.check('save-scripts 旧目录有已登记附件：ddl 写入新任务目录，响应 configRevBumped === false', res.json && res.json.savedFiles.length === 1 && /mc_dir_owner_/.test(res.json.scriptPath || '') && res.json.configRevBumped === false, JSON.stringify(res.json)),
  });
  await mk('save-scripts 新任务目录含任务附件（已登记）、旧目录没有、模型脚本生效集合一致 → 0（反方向）', {
    cls: 'B', expectDelta: 0, expectStatus: 200,
    prep: async (id) => {
      await curDirPrep(ddl('2026-10-01', 'a int'))(id);
      const title = `q1task_${id}`; const owner = `mc_dir_owner_${id}`;
      const tr = await w.run("INSERT INTO task_pool (title, status, owner, owner_id, linked_model_id, category, created_at) VALUES (?, 'CLAIMED', ?, 1, ?, 'ODS_SYNC', '2026-03-10 12:00:00')", [title, owner, id]);
      seedFile(`${owner}/${tr.lastID}_${title}`, `${tr.lastID}_sql_script_20260301.sql`, 'SELECT 98;');   // 新任务目录里只有附件
      await registerAttachment(tr.lastID, `${owner}/${tr.lastID}_${title}/${tr.lastID}_sql_script_20260301.sql`);
    },
    act: async (c, id) => save(c, id, { ddl: ddl('2026-10-09', 'a int') }, (await c.row(id)).table_name),
    verify: async (c, id, res) => c.check('save-scripts 新目录有已登记附件：ddl 写入新任务目录，响应 configRevBumped === false', res.json && res.json.savedFiles.length === 1 && /mc_dir_owner_/.test(res.json.scriptPath || '') && res.json.configRevBumped === false, JSON.stringify(res.json)),
  });
  await mk('save-scripts 旧目录有未登记的无表名前缀 .sql（edit-script 能建出的文件名形态）→ +1', {
    cls: 'A', expectDelta: 1, expectStatus: 200,
    prep: async (id) => { await curDirPrep(ddl('2026-10-01', 'a int'))(id); const t = await tn(id); seedFile(`${adminDir}/model_${id}_${safe(t)}`, 'hand_made_etl.sql', 'SELECT 5;'); await taskPrep(id); },
    act: async (c, id) => save(c, id, { ddl: ddl('2026-10-09', 'a int') }, (await c.row(id)).table_name),
    verify: async (c, id, res) => c.check('save-scripts 未登记无前缀 .sql 只在旧目录：ddl 写入新任务目录，响应 configRevBumped === true', res.json && res.json.savedFiles.length === 1 && /mc_dir_owner_/.test(res.json.scriptPath || '') && res.json.configRevBumped === true, JSON.stringify(res.json)),
  });
  // S1（H1 恢复）：请求体 tableName 与模型 table_name 不一致 ⇒ 400「请求的表名与模型表名不一致」，零写入、不递增、不建目录 / 不写文件
  await mk('save-scripts 请求 tableName 与模型表名不一致 → 400、零写入', {
    cls: 'B', expectDelta: 0, expectStatus: 400,
    act: async (c, id) => {
      const s0 = c.traceLastSeq();
      const res = await save(c, id, { ddl: ddl('2026-10-09', 'a int'), sync: 'SELECT 1;' }, `${(await c.row(id)).table_name}_forged`);
      await settle(300);
      const writes = c.traceRecords().filter(r => r.seq > s0);
      c.check('save-scripts tableName 不一致：请求窗口内 data_models 写语句 = 0（零写入）', writes.length === 0, JSON.stringify(writes.map(r => r.sql.slice(0, 100))));
      return res;
    },
    verify: async (c, id, res) => {
      const t = (await c.row(id)).table_name;
      c.check('save-scripts tableName 不一致：错误文案为「请求的表名与模型表名不一致」', res.json && res.json.error === '请求的表名与模型表名不一致', JSON.stringify(res.json));
      const dirs = [`${adminDir}/model_${id}_${safe(t)}_forged`, `${adminDir}/model_${id}_${safe(t)}`];
      const exist = dirs.filter(d => fs.existsSync(path.join(c.copyRoot, 'uploads', d)));
      c.check('save-scripts tableName 不一致：目标目录（伪造名与真实名两个）均未创建、无新文件', exist.length === 0, JSON.stringify(exist));
    },
  });
  // H2：领取 / 重新提交只删登记不删文件，旧附件以未登记身份留在任务目录——位于任务目录（目录名 {任务号}_{标题}）且文件名匹配 ^{该目录任务号}_[A-Za-z_]+_\d{8}\.sql$ 的文件排除
  const orphanCase = (label, orphanName, changed) => mk(label, {
    cls: changed ? 'A' : 'B', expectDelta: changed ? 1 : 0, expectStatus: 200,
    prep: async (id) => {
      const t = await tn(id);
      const oldRel = `${adminDir}/999_oldtask_${id}`;           // 旧 script_path：任务目录形态 {任务号}_{标题}（任务号 999）
      seedFile(oldRel, `${safe(t)}_DDL.sql`, ddl('2026-10-01', 'a int'));
      seedFile(oldRel, orphanName, 'SELECT 77;');                  // 未登记（task_attachments 里没有）
      await setPath(id, oldRel);
      await taskPrep(id);
    },
    act: async (c, id) => save(c, id, { ddl: ddl('2026-10-09', 'a int') }, (await c.row(id)).table_name),
    verify: async (c, id, res) => c.check(`${label}：ddl 写入新任务目录，响应 configRevBumped === ${changed}`, res.json && res.json.savedFiles.length === 1 && /mc_dir_owner_/.test(res.json.scriptPath || '') && res.json.configRevBumped === changed, JSON.stringify(res.json)),
  });
  await orphanCase('save-scripts 旧任务目录里未登记的孤儿附件（命名合规、任务号与目录一致）只在旧目录 → 0', '999_sql_script_20260301.sql', false);
  await orphanCase('save-scripts 旧任务目录里命名合规但任务号与目录不符的 .sql 仍计入集合 → +1', '888_sql_script_20260301.sql', true);
  // F1 目录级规则：原 script_path 无法安全解析（含 .. / 绝对路径）⇒ 视为不同目录，+1（夹具里直接写库）
  for (const [label, bad] of [['含 ..（..\\x）', '..\\x'], ['绝对路径', path.join(os.tmpdir(), 'mc-abs-script-path')]]) {
    await mk(`save-scripts 原 script_path 不安全（${label}）`, {
      cls: 'A', expectDelta: 1, expectStatus: 200,
      prep: async (id) => { await setPath(id, bad); },
      act: async (c, id) => save(c, id, { ddl: ddl('2026-10-01', 'a int') }, (await c.row(id)).table_name),
      verify: async (c, id, res) => c.check(`save-scripts 原 script_path 不安全（${label}）：本次落盘 1 个文件，响应 configRevBumped === true`, res.json && res.json.savedFiles.length === 1 && res.json.configRevBumped === true, JSON.stringify(res.json)),
    });
  }

  // F2（C1 对抗审，HIGH，主会话返工扩到全部会设置 companion_of 的分支）：开启变更追踪会把已存在（含已删除）的同名模型行改成伴生表
  //   三个分支：companion-link-existing（主表此前未启用、同名行未删除）／companion-link-by-name（主表此前已启用、同名行 companion_of 为空）／companion-restore（同名行已软删除）
  //   同名行挂着未归档任务 ⇒ 400、零写入；任务已 ARCHIVED ⇒ 照常成功
  const f2Task = async (companionId, status) => w.run("INSERT INTO task_pool (title, status, owner, owner_id, linked_model_id, category, created_at) VALUES (?, ?, 'mc_f2_owner', 1, ?, 'DWD_DEV', '2026-03-10 12:00:00')", [fx.nextName('f2task'), status, companionId]);
  const f2Variants = [
    { tag: 'link-existing', letter: 'a', parentEnabled: false, deleted: 0, version: 1 },
    { tag: 'link-by-name', letter: 'c', parentEnabled: true, deleted: 0, version: 2 },
    { tag: 'restore', letter: 'e', parentEnabled: false, deleted: 1, version: 1 },
  ];
  for (const v of f2Variants) {
    for (const archived of [false, true]) {
      const name = fx.nextName(`f2chg${v.letter}${archived ? 'y' : 'n'}`);
      let companionId, taskId;
      const body = { dim_config: { version: v.version, dwdConfig: { changeTracking: { enabled: true, changeTableName: name } } } };
      const baseCase = {
        layer: 'DWD',
        model: { dim_config: { version: 1, dwdConfig: { changeTracking: { enabled: v.parentEnabled, changeTableName: name } } } },
        prep: async () => {
          companionId = await fx.model({ layer: 'DWD', table_name: name, config_mode: 'standard', is_deleted: v.deleted, ...(v.deleted ? { deleted_at: '2026-01-01 00:00:00' } : {}) });
          taskId = (await f2Task(companionId, archived ? 'ARCHIVED' : 'CLAIMED')).lastID;
        },
      };
      if (!archived) {
        await mk(`companion-${v.tag}：同名模型挂 CLAIMED 任务 → 400、零写入`, {
          ...baseCase, cls: 'B', expectDelta: 0, expectStatus: 400,
          act: async (c, id) => {
            const s0 = c.traceLastSeq();
            const res = await put(c, id, body);
            await settle(500);
            const writes = c.traceRecords().filter(r => r.seq > s0);
            c.check(`companion-${v.tag} 400：请求窗口内 data_models 写语句 = 0（零写入）`, writes.length === 0, JSON.stringify(writes.map(r => r.sql.slice(0, 100))));
            return res;
          },
          verify: async (c, id, res) => {
            const comp = await c.row(companionId);
            c.check(`companion-${v.tag} 400：同名行 companion_of 仍为空、config_mode / is_deleted 未变`, comp.companion_of == null && comp.config_mode === 'standard' && comp.is_deleted === v.deleted, JSON.stringify({ companion_of: comp.companion_of, config_mode: comp.config_mode, is_deleted: comp.is_deleted }));
            c.check(`companion-${v.tag} 400：错误文案含伴生表名、「对应的模型仍有未归档的关联任务」与任务编号`, res.json && typeof res.json.error === 'string' && res.json.error.includes(`伴生表 ${name} 对应的模型仍有未归档的关联任务`) && res.json.error.includes(`#${taskId}`) && res.json.error.includes('请先归档或解除关联后再启用变更追踪'), JSON.stringify(res.json));
            const parent = await c.row(id);
            c.check(`companion-${v.tag} 400：主表 dim_config 未被改写（version 仍为 1）`, JSON.parse(parent.dim_config).version === 1, parent.dim_config);
          },
        });
      } else {
        await mk(`companion-${v.tag}：同名模型的任务已 ARCHIVED → 成功设为伴生`, {
          ...baseCase, cls: 'A', expectDelta: 1, expectStatus: 200, async: true,
          act: (c, id) => put(c, id, body),
          verify: async (c, id) => {
            const linked = await waitFor(async () => { const r = await c.row(companionId); return r.companion_of === id ? r : null; });
            c.check(`companion-${v.tag}（任务已归档）：同名行 companion_of 已指向主表、config_mode = companion、is_deleted = 0`, linked && linked.config_mode === 'companion' && linked.is_deleted === 0, JSON.stringify(linked && { companion_of: linked.companion_of, config_mode: linked.config_mode, is_deleted: linked.is_deleted }));
          },
        });
      }
    }
  }

  // F2 (a)：主表此前已启用且已有 companion_of = 本主表的活跃伴生 ⇒ syncCompanionTable 只同步元数据、不改任何行的 companion_of；
  //   另一条同名行（改了 changeTableName 指向它）即使挂未归档任务也不得误拦 ⇒ 200，同名行 companion_of 仍为空
  {
    const oldName = fx.nextName('f2chgoldA'); const newName = fx.nextName('f2chgnewA'); let otherId;
    await mk('companion (a)：已有活跃伴生时，另一条同名行挂未归档任务不误拦（200）', {
      layer: 'DWD', cls: 'A', expectDelta: 1, expectStatus: 200, async: true,
      model: { dim_config: { version: 1, dwdConfig: { changeTracking: { enabled: true, changeTableName: oldName } } } },
      prep: async (id) => {
        await fx.model({ layer: 'DWD', table_name: oldName, config_mode: 'companion', companion_of: id });
        otherId = await fx.model({ layer: 'DWD', table_name: newName, config_mode: 'standard' });
        await f2Task(otherId, 'CLAIMED');
      },
      act: (c, id) => put(c, id, { dim_config: { version: 2, dwdConfig: { changeTracking: { enabled: true, changeTableName: newName } } } }),
      verify: async (c) => { const o = await c.row(otherId); c.check('companion (a)：另一条同名行 companion_of 仍为空、config_mode 未变', o.companion_of == null && o.config_mode === 'standard', JSON.stringify({ companion_of: o.companion_of, config_mode: o.config_mode })); },
    });
  }

  // Q2（既有缺陷）：主表名不以 _df 结尾且未设 changeTableName ⇒ 派生伴生名 = 主表名；显式 changeTableName 与主表名仅大小写不同同理。
  //   ① 硬校验 400「变更追踪表名不能与主表同名」，零写入，与有无任务无关；② syncCompanionTable 取到的行就是主表自己时不写（兜底，M-N 去掉 ① 后由本用例的「companion_of 仍为空」证明）
  for (const v of [{ tag: '派生名 = 主表名（无 changeTableName）', explicit: false }, { tag: '显式 changeTableName = 主表名（大小写不同）', explicit: true }]) {
    await mk(`companion-同名：${v.tag} → 400、零写入`, {
      layer: 'DWD', cls: 'B', expectDelta: 0, expectStatus: 400,
      model: { dim_config: { version: 1, dwdConfig: { changeTracking: { enabled: false } } } },
      act: async (c, id) => {
        const s0 = c.traceLastSeq();
        const tbl = (await c.row(id)).table_name;
        const ct = v.explicit ? { enabled: true, changeTableName: tbl.toUpperCase() } : { enabled: true };
        const res = await put(c, id, { dim_config: { version: 2, dwdConfig: { changeTracking: ct } } });
        await settle(500);
        const writes = c.traceRecords().filter(r => r.seq > s0);
        c.check(`companion-同名 ${v.tag}：请求窗口内 data_models 写语句 = 0（零写入）`, writes.length === 0, JSON.stringify(writes.map(r => r.sql.slice(0, 100))));
        return res;
      },
      verify: async (c, id, res) => {
        c.check(`companion-同名 ${v.tag}：错误文案为「变更追踪表名不能与主表同名」`, res.json && res.json.error === '变更追踪表名不能与主表同名', JSON.stringify(res.json));
        const r = await c.row(id);
        c.check(`companion-同名 ${v.tag}：主表 dim_config 未改（version 仍为 1）、config_mode 未变`, JSON.parse(r.dim_config).version === 1 && r.config_mode === 'standard', JSON.stringify({ dim_config: r.dim_config, config_mode: r.config_mode }));
        // S2：显式大写变体只验 ① 的大小写不敏感；SQLite `table_name = ?` 区分大小写，sync 用大写名查不到主表行，② 兜底在此变体下不会被触发（断言恒绿），
        //   所以它不用「Q2② 兜底」前缀、不参与 M-N 的 mustPass；② 的行为级证明只来自「派生名 = 主表名」变体。
        c.check(`${v.explicit ? 'Q2① 大小写变体（非 ② 证明）' : 'Q2② 兜底'} ${v.tag}：主表 companion_of 仍为空（不是自身 id）`, r.companion_of == null, String(r.companion_of));
      },
    });
  }

  // G3（C1 对抗审复审）：伴生转换的「检查未归档任务 + 写 companion_of」合成一条条件 UPDATE（NOT EXISTS 未归档任务），覆盖 PUT 之外的路径；status 为 NULL 的任务视为未归档
  {
    const name = fx.nextName('g3nullA'); let companionId, taskId;
    await mk('companion-link-existing：关联任务 status 为 NULL 视为未归档 → 400、零写入', {
      layer: 'DWD', cls: 'B', expectDelta: 0, expectStatus: 400,
      model: { dim_config: { version: 1, dwdConfig: { changeTracking: { enabled: false, changeTableName: name } } } },
      prep: async () => { companionId = await fx.model({ layer: 'DWD', table_name: name, config_mode: 'standard' }); taskId = (await f2Task(companionId, null)).lastID; },
      act: async (c, id) => {
        const s0 = c.traceLastSeq();
        const res = await put(c, id, { dim_config: { version: 2, dwdConfig: { changeTracking: { enabled: true, changeTableName: name } } } });
        await settle(500);
        const writes = c.traceRecords().filter(r => r.seq > s0);
        c.check('companion status=NULL 400：请求窗口内 data_models 写语句 = 0（零写入）', writes.length === 0, JSON.stringify(writes.map(r => r.sql.slice(0, 100))));
        return res;
      },
      verify: async (c, id, res) => {
        const comp = await c.row(companionId);
        c.check('companion status=NULL 400：同名行 companion_of 仍为空，错误文案含任务编号', comp.companion_of == null && res.json && typeof res.json.error === 'string' && res.json.error.includes(`#${taskId}`), JSON.stringify({ companion_of: comp.companion_of, error: res.json && res.json.error }));
      },
    });
  }
  // G3 ①：无变化 PUT（走 ensureCompanionExists，只读 + 日志）：同名行挂未归档任务 ⇒ 该行 companion_of 仍为空（行为级；本仓库 ensureCompanionExists 不含写，故不会被改成伴生）
  {
    const name = fx.nextName('g3noopA'); let otherId;
    const cfg0 = { version: 1, dwdConfig: { changeTracking: { enabled: true, changeTableName: name } } };
    await mk('companion 无变化 PUT（ensureCompanionExists 路径）：同名行挂未归档任务 → 同名行 companion_of 仍为空', {
      layer: 'DWD', cls: 'B', expectDelta: 0, expectStatus: 200,
      model: { dim_config: cfg0 },
      prep: async () => { otherId = await fx.model({ layer: 'DWD', table_name: name, config_mode: 'standard' }); await f2Task(otherId, 'CLAIMED'); },
      act: async (c, id) => { const res = await put(c, id, { dim_config: cfg0 }); await settle(500); return res; },
      verify: async (c, id, res) => {
        const o = await c.row(otherId);
        c.check('companion 无变化 PUT：响应 noChange，同名行 companion_of 仍为空、config_mode 未变', res.json && res.json.noChange === true && o.companion_of == null && o.config_mode === 'standard', JSON.stringify({ res: res.json, companion_of: o.companion_of, config_mode: o.config_mode }));
      },
    });
  }
  // G3 ②：改表名（foo_df → bar_df）+ 首次启用追踪。syncCompanionTable 实际收到的是 oldModel（旧表名、请求里的 dim_config、旧 dim_config），伴生名由旧表名派生（foo_change_di）；
  //   前置检查与它取同一输入。⇒ foo_change_di 行挂未归档任务 → 400；只有 bar_change_di 行挂任务（sync 不会写它）→ 不误拦 200，bar 行 companion_of 仍为空
  {
    const base = fx.nextName('g3ren'); const oldName = `${base}_foo_df`; const newName = `${base}_bar_df`;
    const enable = { dim_config: { version: 2, dwdConfig: { changeTracking: { enabled: true } } } };
    const parentCfg = { layer: 'DWD', model: { table_name: oldName, dim_config: { version: 1, dwdConfig: { changeTracking: { enabled: false } } } } };
    await mk('companion 改表名 + 首次启用：旧名派生的 foo_change_di 行挂未归档任务 → 400、零写入', {
      ...parentCfg, cls: 'B', expectDelta: 0, expectStatus: 400,
      prep: async () => { const fooChg = await fx.model({ layer: 'DWD', table_name: `${base}_foo_change_di`, config_mode: 'standard' }); await f2Task(fooChg, 'CLAIMED'); },
      act: async (c, id) => {
        const s0 = c.traceLastSeq();
        const res = await put(c, id, { table_name: newName, ...enable });
        await settle(500);
        const writes = c.traceRecords().filter(r => r.seq > s0);
        c.check('companion 改表名 400：请求窗口内 data_models 写语句 = 0（零写入）', writes.length === 0, JSON.stringify(writes.map(r => r.sql.slice(0, 100))));
        return res;
      },
      verify: async (c, id, res) => c.check('companion 改表名 400：文案点名伴生表 foo_change_di，主表名未改', res.json && String(res.json.error).includes(`伴生表 ${base}_foo_change_di `) && (await c.row(id)).table_name === oldName, JSON.stringify(res.json)),
    });
    let barId;
    const base2 = fx.nextName('g3ren2'); const oldName2 = `${base2}_foo_df`; const newName2 = `${base2}_bar_df`;
    await mk('companion 改表名 + 首次启用：只有 bar_change_di 行挂未归档任务（sync 不会写它）→ 不误拦 200', {
      layer: 'DWD', model: { table_name: oldName2, dim_config: { version: 1, dwdConfig: { changeTracking: { enabled: false } } } },
      cls: 'A', expectDelta: 1, expectStatus: 200, async: true,
      prep: async () => { barId = await fx.model({ layer: 'DWD', table_name: `${base2}_bar_change_di`, config_mode: 'standard' }); await f2Task(barId, 'CLAIMED'); },
      act: (c, id) => put(c, id, { table_name: newName2, ...enable }),
      verify: async (c) => { await settle(500); const o = await c.row(barId); c.check('companion 改表名 200：bar_change_di 行 companion_of 仍为空（未被改写）', o.companion_of == null && o.config_mode === 'standard', JSON.stringify({ companion_of: o.companion_of, config_mode: o.config_mode })); },
    });
  }

  // §1.5 edit-script
  const edit = (c, id, fileName, content, autoSave) => call(c, 'PUT', `/api/models/${id}/edit-script`, { fileName, content, ...(autoSave ? { autoSave: true } : {}) });
  await mk('edit-script 新建文件', {
    cls: 'A', expectDelta: 1, expectStatus: 200,
    act: (c, id) => edit(c, id, 'mc_edit.sql', 'SELECT 1;'),
    verify: async (c, id, res) => c.check('edit-script 新建：响应成功', res.json && res.json.success === true, JSON.stringify(res.json)),
    // edit-script 首次建目录写 script_path 的 UPDATE（6874f3fcf2f0）：夹具无 script_path，执行后 script_path 非空且 script_saved_by 为操作者名
    covers: ['6874f3fcf2f0'], evidence: async (c, before, after) => !before.script_path && !!after.script_path && before.script_saved_by == null && after.script_saved_by === c.admin.display_name,
  });
  const existingFilePrep = async (id) => { const rel = `${adminDir}/mc_edit_${id}`; seedFile(rel, 'mc_edit.sql', 'SELECT 1;'); await setPath(id, rel); };
  await mk('edit-script 已有文件内容变化', {
    cls: 'A', expectDelta: 1, expectStatus: 200, prep: existingFilePrep,
    act: (c, id) => edit(c, id, 'mc_edit.sql', 'SELECT 2;'),
    verify: async (c, id, res) => c.check('edit-script 变化：响应成功且 changed 不为 false', res.json && res.json.success === true && res.json.changed !== false, JSON.stringify(res.json)),
    // edit-script 人工编辑标记 script_modified 的 UPDATE（08d8e0c2caa2）：已有文件 + 非 autoSave，执行后 script_modified = 1 且 script_modified_by 为操作者名
    covers: ['08d8e0c2caa2'], evidence: async (c, before, after) => before.script_modified !== 1 && before.script_modified_by == null && after.script_modified === 1 && after.script_modified_by === c.admin.display_name,
  });
  await mk('edit-script 内容不变', {
    cls: 'B', expectDelta: 0, expectStatus: 200, prep: existingFilePrep,
    act: (c, id) => edit(c, id, 'mc_edit.sql', 'SELECT 1;'),
    verify: async (c, id, res) => c.check('edit-script 不变：响应 changed=false', res.json && res.json.changed === false, JSON.stringify(res.json)),
  });
  // edit-script 分支全集（isNewFile × autoSave × 内容变化；期望手写）：新建文件 +1（上）／已有 + 非 autoSave + 变化 +1（上）／已有 + 非 autoSave + 不变 0（上）／
  //   已有 + autoSave + 变化 +1（下，方案规定按 contentChanged 递增，autoSave 不例外；该分支不写 script_modified，没有目标 SQL，不做邻接判据）／已有 + autoSave + 不变 0（下）
  await mk('edit-script autoSave 已有文件内容变化', {
    cls: 'A', expectDelta: 1, expectKind: 'helper', expectStatus: 200, prep: existingFilePrep,
    act: (c, id) => edit(c, id, 'mc_edit.sql', 'SELECT 3;', true),
    verify: async (c, id, res) => { const r = await c.row(id); c.check('edit-script autoSave 变化：响应成功且 changed 不为 false，script_modified 未被标记（autoSave 不走人工标记）', res.json && res.json.success === true && res.json.changed !== false && r.script_modified !== 1, JSON.stringify(res.json) + ' script_modified=' + r.script_modified); },
  });
  await mk('edit-script autoSave 已有文件内容不变', {
    cls: 'B', expectDelta: 0, expectStatus: 200, prep: existingFilePrep,
    act: (c, id) => edit(c, id, 'mc_edit.sql', 'SELECT 1;', true),
    verify: async (c, id, res) => c.check('edit-script autoSave 不变：响应 changed=false', res.json && res.json.changed === false, JSON.stringify(res.json)),
  });

  // §1.6 软删除（B）/ 恢复（A，夹具里预先是已删除态）
  await mk('DELETE 软删除模型', {
    cls: 'B', expectDelta: 0, expectStatus: 200,
    act: (c, id) => call(c, 'DELETE', `/api/models/${id}`, { force: true, reason: 'mc' }),
    verify: async (c, id) => c.check('软删除：is_deleted 确已置 1', (await c.row(id)).is_deleted === 1),
  });
  await mk('POST restore 恢复软删除模型', {
    cls: 'A', expectDelta: 1, expectStatus: 200,
    model: { is_deleted: 1, deleted_at: '2026-01-01 00:00:00' },
    act: (c, id) => call(c, 'POST', `/api/models/${id}/restore`),
    verify: async (c, id) => c.check('restore：is_deleted 确已置 0', (await c.row(id)).is_deleted === 0),
    covers: ['6abbcd6737d0'], evidence: async (c, before, after) => before.is_deleted === 1 && after.is_deleted === 0,   // 恢复软删除模型的 UPDATE（utils/model-restore.js）：is_deleted 1 → 0
  });

  // §1.7 删伴生表回写主表（changeTracking.enabled 为真 → +1；为假 → 不变）
  for (const enabled of [true, false]) {
    let companionId;
    await mk(`DELETE 伴生表回写主表（changeTracking.enabled=${enabled}）`, {
      cls: enabled ? 'A' : 'B', layer: 'DWD', expectDelta: enabled ? 1 : 0, async: true, expectStatus: 200,
      model: { dim_config: { version: 1, dwdConfig: { changeTracking: { enabled, changeTableName: 'mc_comp_chg' } } } },
      prep: async (id) => { companionId = await fx.model({ layer: 'DWD', config_mode: 'companion', companion_of: id, status: 'DEVELOPING' }); },
      act: (c) => call(c, 'DELETE', `/api/models/${companionId}`, { force: true, reason: 'mc' }),
      verify: async (c, id) => {
        const cfg = JSON.parse((await c.row(id)).dim_config);
        c.check(`删伴生表（enabled=${enabled}）：主表 changeTracking.enabled 写回 ${enabled ? 'false' : '保持 false'}`, cfg.dwdConfig.changeTracking.enabled === false, JSON.stringify(cfg));
      },
      // 删伴生表回写主表的 UPDATE（964a6ce5f613，仅 enabled=true 时执行）：回写后主表 enabled 必为 false（夹具里是 true）
      ...(enabled ? { covers: ['964a6ce5f613'], evidence: async (c, before, after) => JSON.parse(before.dim_config).dwdConfig.changeTracking.enabled === true && JSON.parse(after.dim_config).dwdConfig.changeTracking.enabled === false } : {}),
    });
  }
  // §1.8 实现对象（#77 C2b-1，方案 v0.9 §4.1.1 A 表末两行 + §4.3）：挂接 / 解挂（关系集合变化）与已挂接对象的登记源码变化递增；
  //   这两处递增都由 impl-objects 模块在其互斥锁内的事务里调 bumpConfigRev（助手单语句，目标「写点」是 model_impl_* 表而非 data_models，
  //   所以没有契约 hash、不进 a-class-coverage.json）；归因判据 = 窗口内恰好 expectDelta 条助手递增语句且绑定参数含受影响模型 id（expectKind: 'helper'）。
  //   夹具里的对象 / 关系行直接写表（服务停止期间）；PROC 的 db_connection_id 留 NULL（源码端点不校验连接，连接校验由 verify-model-impl-objects.js 覆盖）。
  const sha = (t) => require('node:crypto').createHash('sha256').update(Buffer.from(t, 'utf8')).digest('hex');   // 手写期望，不引用被测模块
  const implObj = async (type, o) => (await w.run(
    `INSERT INTO model_impl_objects (obj_type, db_connection_id, schema_name, obj_name, summary, reg_source, reg_hash, hash_algo, is_deleted, created_at, updated_at, created_by, updated_by)
     VALUES (?, NULL, NULL, ?, NULL, ?, ?, ?, 0, datetime('now','localtime'), datetime('now','localtime'), 'mc_fx', 'mc_fx')`,
    [type, fx.nextName('impl'), (o && o.src) || null, (o && o.src) ? sha(o.src) : null, (o && o.src) ? ((o && o.algo) || 'norm_v1') : null])).lastID;
  const implLink = (mid, oid, role, sortNo) => w.run(
    `INSERT INTO model_impl_links (model_id, object_id, role, sort_no, created_at, created_by) VALUES (?, ?, ?, ?, datetime('now','localtime'), 'mc_fx')`, [mid, oid, role || 'r', sortNo || 0]);
  const linksOf = (c, mid) => c.rd.all('SELECT object_id, role, sort_no FROM model_impl_links WHERE model_id = ? ORDER BY object_id', [mid]);
  const putLinks = (c, id, links) => call(c, 'PUT', `/api/models/${id}/impl-links`, { links });
  const putSource = (c, oid, text) => call(c, 'PUT', `/api/model-impl-objects/${oid}/source`, { reg_source: text });
  let implO = {};
  await mk('impl-links 挂接集合变化（新增一条关系）', {
    cls: 'A', expectDelta: 1, expectKind: 'helper', expectStatus: 200,
    prep: async (id) => { implO.add = await implObj('FDL_TASK'); implO.addId = id; },
    act: (c, id) => putLinks(c, id, [{ object_id: implO.add, role: '主流程', sort_no: 1 }]),
    verify: async (c, id) => { const l = await linksOf(c, id); c.check('impl-links 新增：关系行确已写库（role / sort_no 正确）', l.length === 1 && l[0].object_id === implO.add && l[0].role === '主流程' && l[0].sort_no === 1, JSON.stringify(l)); },
  });
  await mk('impl-links 解挂（对已有关系整组替换为空）', {
    cls: 'A', expectDelta: 1, expectKind: 'helper', expectStatus: 200,
    prep: async (id) => { const o = await implObj('FDL_TASK'); await implLink(id, o, '旧职责', 0); },
    act: (c, id) => putLinks(c, id, []),
    verify: async (c, id) => { const l = await linksOf(c, id); c.check('impl-links 解挂：关系行已清空', l.length === 0, JSON.stringify(l)); },
  });
  await mk('impl-links 只改 role / sort_no（object_id 集合不变）', {
    cls: 'B', expectDelta: 0, expectStatus: 200,
    prep: async (id) => { implO.keep = await implObj('FDL_TASK'); await implLink(id, implO.keep, '旧职责', 0); },
    act: (c, id) => putLinks(c, id, [{ object_id: implO.keep, role: '新职责', sort_no: 7 }]),
    verify: async (c, id) => { const l = await linksOf(c, id); c.check('impl-links 只改 role / sort_no：新值确已写库，集合仍是原对象', l.length === 1 && l[0].object_id === implO.keep && l[0].role === '新职责' && l[0].sort_no === 7, JSON.stringify(l)); },
  });
  await mk('impl-links 挂接同集合重放（内容也相同）', {
    cls: 'B', expectDelta: 0, expectStatus: 200,
    prep: async (id) => { implO.same = await implObj('FDL_TASK'); await implLink(id, implO.same, '职责', 3); },
    act: (c, id) => putLinks(c, id, [{ object_id: implO.same, role: '职责', sort_no: 3 }]),
    verify: async (c, id) => { const l = await linksOf(c, id); c.check('impl-links 同集合重放：关系行原样保留', l.length === 1 && l[0].object_id === implO.same && l[0].role === '职责' && l[0].sort_no === 3, JSON.stringify(l)); },
  });
  await mk('impl-source 登记源码（首次登记，旧值为空）', {
    cls: 'B', expectDelta: 0, expectStatus: 200,
    prep: async (id) => { implO.first = await implObj('PROC'); await implLink(id, implO.first, '主过程', 0); },
    act: (c) => putSource(c, implO.first, 'abc'),
    verify: async (c) => { const o = await c.rd.get('SELECT reg_source, reg_hash, hash_algo FROM model_impl_objects WHERE id = ?', [implO.first]); c.check('impl-source 首次登记：源码与 reg_hash（sha256("abc")）确已写库', o.reg_source === 'abc' && o.reg_hash === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' && o.hash_algo === 'norm_v1', JSON.stringify(o)); },
  });
  await mk('impl-source 源码变化（非空 → 另一非空）：每个挂接模型各 +1，已软删除模型不递增', {
    cls: 'A', expectDelta: 1, expectKind: 'helper', expectStatus: 200,
    prep: async (id) => {
      implO.chg = await implObj('PROC', { src: 'v1' });
      await implLink(id, implO.chg, '主过程', 0);
      implO.chgM2 = await fx.model({ layer: 'ODS' });          // 第二个挂接模型（不另造验收记录，只看 config_rev）
      implO.chgDel = await fx.model({ layer: 'ODS', is_deleted: 1, deleted_at: '2026-01-01 00:00:00' });   // 已软删除的挂接模型（历史脏关系，不应被递增）
      await implLink(implO.chgM2, implO.chg, '备用过程', 0);
      await implLink(implO.chgDel, implO.chg, '历史', 0);
    },
    act: (c) => putSource(c, implO.chg, 'v2'),
    verify: async (c) => {
      c.check('impl-source 源码变化：第二个挂接模型 config_rev 恰好 1 → 2', (await c.rev(implO.chgM2)) === 2, `rev=${await c.rev(implO.chgM2)}`);
      c.check('impl-source 源码变化：已软删除的挂接模型 config_rev 不变（仍为 1）', (await c.rev(implO.chgDel)) === 1, `rev=${await c.rev(implO.chgDel)}`);
      const o = await c.rd.get('SELECT reg_source, reg_hash FROM model_impl_objects WHERE id = ?', [implO.chg]);
      c.check('impl-source 源码变化：新源码与新 reg_hash（sha256("v2")）确已写库', o.reg_source === 'v2' && o.reg_hash === sha('v2'), JSON.stringify(o));
    },
  });
  await mk('impl-source 源码相同重放（旧值非空且哈希相同）', {
    cls: 'B', expectDelta: 0, expectStatus: 200,
    prep: async (id) => { implO.rep = await implObj('PROC', { src: 'same' }); await implLink(id, implO.rep, '主过程', 0); },
    act: (c) => putSource(c, implO.rep, 'same'),
    verify: async (c) => { const o = await c.rd.get('SELECT reg_hash FROM model_impl_objects WHERE id = ?', [implO.rep]); c.check('impl-source 相同重放：reg_hash 不变', o.reg_hash === sha('same'), JSON.stringify(o)); },
  });
  // §1.8b #77 C2b-2：reg_hash 改走 norm_v1（规范化后求哈希），比较口径同步；启动重算不算源码变化
  const implLogCount = (c, id) => c.rd.get("SELECT COUNT(*) AS n FROM model_change_logs WHERE model_id = ? AND change_type = 'impl_object'", [id]);
  await mk('impl-source norm_v1：只改空白 / 换行风格 / 对象头大小写的重登记（规范化后哈希相同）', {
    cls: 'B', expectDelta: 0, expectStatus: 200,
    prep: async (id) => { implO.ws = await implObj('PROC', { src: 'CREATE PROCEDURE p\nAS\nSELECT 1;' }); await implLink(id, implO.ws, '主过程', 0); },
    act: (c) => putSource(c, implO.ws, 'create  or  alter  procedure p  \r\nAS \r\nSELECT 1;\r\n\r\n'),
    verify: async (c, id) => {
      const o = await c.rd.get('SELECT reg_source, reg_hash, hash_algo FROM model_impl_objects WHERE id = ?', [implO.ws]);
      c.check('impl-source norm_v1 重登记：reg_hash 仍是规范化文本的 SHA-256（手写文本现算），hash_algo = norm_v1，源码原文确已更新为新提交（含 CRLF）', o.reg_hash === sha('CREATE PROCEDURE p\nAS\nSELECT 1;') && o.hash_algo === 'norm_v1' && o.reg_source.includes('\r\n'), JSON.stringify(o));
      c.check('impl-source norm_v1 重登记：config_rev 仍为 1、没有 impl_object 变更日志', (await c.rev(id)) === 1 && (await implLogCount(c, id)).n === 0, `rev=${await c.rev(id)}`);
    },
  });
  await mk('impl-source norm_v1：正文改变（同时带换行 / 大小写噪声）⇒ 挂接模型 +1', {
    cls: 'A', expectDelta: 1, expectKind: 'helper', expectStatus: 200,
    prep: async (id) => { implO.bodyChg = await implObj('PROC', { src: 'CREATE PROCEDURE p\nAS\nSELECT 1;' }); await implLink(id, implO.bodyChg, '主过程', 0); },
    act: (c) => putSource(c, implO.bodyChg, 'create or alter procedure p\r\nAS\r\nSELECT 2;'),
    verify: async (c, id) => {
      const o = await c.rd.get('SELECT reg_hash FROM model_impl_objects WHERE id = ?', [implO.bodyChg]);
      c.check('impl-source norm_v1 正文改变：新 reg_hash = 规范化后新正文的 SHA-256，config_rev 恰 1 → 2，写 1 条 impl_object 日志', o.reg_hash === sha('CREATE PROCEDURE p\nAS\nSELECT 2;') && (await c.rev(id)) === 2 && (await implLogCount(c, id)).n === 1, `${JSON.stringify(o)} rev=${await c.rev(id)}`);
    },
  });
  await mk('impl-object norm_v1 启动重算（夹具里是 raw_v0 行，服务启动时幂等重算）：config_rev 与变更日志都不变', {
    cls: 'B', expectDelta: 0, expectStatus: 200,
    prep: async (id) => {
      const raw = 'create or alter proc p\r\nAS  \r\nSELECT 1;\r\n';
      implO.rc = await implObj('PROC', { src: raw, algo: 'raw_v0' });
      await w.run("UPDATE model_impl_objects SET doc_path = 'sql/p.sql', doc_hash = ? WHERE id = ?", [sha('doc-raw'), implO.rc]);
      await implLink(id, implO.rc, '主过程', 0);
    },
    act: (c, id) => c.api('GET', `/api/model-impl-objects/${implO.rc}`, { token: c.admin.token }),
    verify: async (c, id) => {
      // L6：重算在服务启动序列里异步执行，先有界等待到 hash_algo = norm_v1 再断言（不靠固定延时）
      await waitFor(async () => ((await c.rd.get('SELECT hash_algo FROM model_impl_objects WHERE id = ?', [implO.rc])) || {}).hash_algo === 'norm_v1', 10000, 100);
      const o = await c.rd.get('SELECT reg_hash, hash_algo, doc_hash, doc_path FROM model_impl_objects WHERE id = ?', [implO.rc]);
      c.check('启动重算：raw_v0 行已按 norm_v1 重算 reg_hash（手写规范化文本现算）、hash_algo = norm_v1，旧算法 doc_hash 置空（原文不落库无从重算）、doc_path 保留', o.reg_hash === sha('CREATE PROC p\nAS\nSELECT 1;') && o.hash_algo === 'norm_v1' && o.doc_hash === null && o.doc_path === 'sql/p.sql', JSON.stringify(o));
      c.check('启动重算：该模型 config_rev 仍为夹具初值 1、没有任何 impl_object 变更日志（重算不递增、不留痕）', (await c.rev(id)) === 1 && (await implLogCount(c, id)).n === 0, `rev=${await c.rev(id)}`);
    },
  });
  await mk('impl-doc 文档上报（不递增）', {
    cls: 'B', expectDelta: 0, expectStatus: 200,
    prep: async (id) => { implO.doc = await implObj('PROC', { src: 'v1' }); await implLink(id, implO.doc, '主过程', 0); },
    act: (c) => call(c, 'PUT', `/api/model-impl-objects/${implO.doc}/doc`, { doc_path: 'sql/procs/usp_x.sql', doc_source: 'doc-text' }),
    verify: async (c) => { const o = await c.rd.get('SELECT doc_path, doc_hash, doc_reported_at, reg_hash FROM model_impl_objects WHERE id = ?', [implO.doc]); c.check('impl-doc 上报：doc_path / doc_hash 确已写库，登记源码哈希不变', o.doc_path === 'sql/procs/usp_x.sql' && o.doc_hash === sha('doc-text') && !!o.doc_reported_at && o.reg_hash === sha('v1'), JSON.stringify(o)); },
  });
  await mk('impl-object 对象软删除：对原挂接模型 +1，关系同事务删除', {
    cls: 'A', expectDelta: 1, expectKind: 'helper', expectStatus: 200,
    prep: async (id) => { implO.del = await implObj('FDL_TASK'); await implLink(id, implO.del, '待删', 0); },
    act: (c) => call(c, 'DELETE', `/api/model-impl-objects/${implO.del}`),
    verify: async (c, id) => {
      const o = await c.rd.get('SELECT is_deleted FROM model_impl_objects WHERE id = ?', [implO.del]);
      c.check('impl-object 对象软删除：is_deleted = 1，关系行全部删除', o.is_deleted === 1 && (await linksOf(c, id)).length === 0, JSON.stringify(o));
    },
  });
  await mk('impl-object 模型软删除只删关系（对象保留且变为未归属）', {
    cls: 'B', expectDelta: 0, expectStatus: 200,
    prep: async (id) => { implO.own = await implObj('FDL_TASK'); await implLink(id, implO.own, '唯一挂接', 0); },
    act: (c, id) => call(c, 'DELETE', `/api/models/${id}`, { force: true, reason: 'mc' }),
    verify: async (c, id) => {
      const o = await c.rd.get('SELECT is_deleted FROM model_impl_objects WHERE id = ?', [implO.own]);
      c.check('impl-object 模型软删除：该模型的关系行已删除，对象本身保留（is_deleted = 0）', (await linksOf(c, id)).length === 0 && o.is_deleted === 0, JSON.stringify(o));
      const un = await c.api('GET', '/api/model-impl-objects?unowned=1', { token: c.admin.token });
      c.check('impl-object 模型软删除后：GET /api/model-impl-objects?unowned=1 能看到该对象', un.status === 200 && Array.isArray(un.json) && un.json.some((x) => x.id === implO.own), JSON.stringify(un.json && un.json.length));
    },
  });
  return cases;
}

// ───────── A 类写点的「归因判据」（写点级运行时归因，codex 22-R2 H）─────────
// 被测服务内的 SQL 追踪器（sql-trace.js）记录窗口内实际执行的 data_models 写语句；每个契约 entry 的判据如下（先剥掉 SQL 注释再判）。
//   form = inline：递增并入写目标的同一条 UPDATE（config_rev = config_rev + ?，绑定的递增参数必须为 1），且这条语句本身必须写目标独有列；
//   form = call ：递增由助手 bumpConfigRev 单语句发出（UPDATE data_models SET config_rev = config_rev + 1 WHERE id IN (…)），目标 SQL（写 script_path / script_modified）也必须在窗口内执行。
//   窗口 = 请求前后追踪日志序号之间；窗口内「递增语句」（递增量为 1 的 config_rev 自增，不论 inline / 助手 / 字面量）必须恰好 1 条（A 类）或 0 条（B 类）。
//   两层防线分工（预筛 LOW-1）：sameStmt 只看「同句出现目标列赋值」，同列自赋值（如 dim_config = dim_config）这类刻意拆句写法本层不拦；
//   这类改写必然改变登记过的规范化 SQL 哈希，由静态守卫 verify-model-write-classification.js 的登记表双向相等硬门判红（预筛实测 D2：守卫报 UNREGISTERED + REGISTRY_STALE）。
const ATTRIBUTION = {
  '964a6ce5f613': { route: 'DELETE /api/models/:id', form: 'inline', sameStmt: [/\bdim_config\s*=/], notStmt: [], criterion: '同一条 UPDATE 含 dim_config = ? 且 config_rev = config_rev + ?（绑定 1）——删伴生表回写主表' },
  '1a0c224d4a5f': { route: 'PUT /api/models/:id（带 dim_config）', form: 'inline', sameStmt: [/\bdim_config\s*=/, /\btable_name\s*=/], notStmt: [], criterion: '同一条 UPDATE 含 dim_config = ? 与 table_name = ? 且 config_rev = config_rev + ?（绑定 1）' },
  '02567da9f1c1': { route: 'PUT /api/models/:id（不带 dim_config）', form: 'inline', sameStmt: [/\btable_name\s*=/], notStmt: [/\bdim_config\s*=/], criterion: '同一条 UPDATE 含 table_name = ? 与用例被改的那一列（见各用例 attrCol），且不含 dim_config，并含 config_rev = config_rev + ?（绑定 1）' },
  // call 形态（codex 22-R3 H）：除「窗口内递增语句为助手单语句 + 目标 SQL 恰好 1 条」外，还须按 server.js 的实际顺序固定「助手 ↔ 目标」的相对顺序与邻接（二者之间无其他 data_models 写语句），
  //   且助手参数的模型 id 与目标 SQL 的模型 id 相同。server.js 实际顺序（grep bumpConfigRev( 核过）：
  //     save-scripts   ：bumpConfigRev（:10181）→ 归档 / 写文件（只碰文件系统）→ UPDATE … script_path = ?（:10197）　　　　　　　　　　　　　　 helper 在前
  //     edit-script 建目录：UPDATE … script_path = ?, script_saved_at（:10330，在 !scriptPath 分支）→ 读文件 / 比较（只读）→ bumpConfigRev（:10362）  helper 在后
  //     edit-script 标记 ：bumpConfigRev（:10362）→ mkdir / 写文件 → UPDATE … script_modified = 1（:10372）　　　　　　　　　　　　　　　　　　helper 在前
  //   各条目的「允许的中间语句」均为空：两个处理器里助手与目标之间只有文件系统操作与 model_change_log / 读查询，没有别的 data_models 写。
  '2fc5964e2400': { route: 'POST /api/models/:id/save-scripts', form: 'call', order: 'helper-first', targets: [/^UPDATE data_models SET script_path = \?/i], criterion: '窗口内递增语句为助手单语句，目标 UPDATE data_models SET script_path = ? … 恰好 1 条且紧跟其后（助手在前、二者之间无其他 data_models 写），同一模型 id' },
  '6874f3fcf2f0': { route: 'PUT /api/models/:id/edit-script（首次建目录）', form: 'call', order: 'target-first', targets: [/^UPDATE data_models SET script_path = \?, script_saved_at/i], criterion: '窗口内递增语句为助手单语句，目标 UPDATE data_models SET script_path = ?, script_saved_at … 恰好 1 条且紧邻其前（目标在前、助手在后、二者之间无其他 data_models 写），同一模型 id' },
  '08d8e0c2caa2': { route: 'PUT /api/models/:id/edit-script（人工编辑标记）', form: 'call', order: 'helper-first', targets: [/^UPDATE data_models SET script_modified = 1\b/i], criterion: '窗口内递增语句为助手单语句，目标 UPDATE data_models SET script_modified = 1 … 恰好 1 条且紧跟其后（助手在前、二者之间无其他 data_models 写），同一模型 id' },
  '6abbcd6737d0': { route: 'tag:model-restore（POST /api/models/:id/restore）', form: 'inline', sameStmt: [/\bis_deleted\s*=\s*0/], notStmt: [], criterion: '同一条 UPDATE 含 is_deleted = 0 且 config_rev = config_rev + ?（绑定 1）' },
};
/** 把窗口里的每条追踪记录分类：inline（config_rev = config_rev + ?）/ helper（助手单语句）/ literal（其他字面量自增）/ 无递增 */
function classifyWindow(win) {
  return win.map((r) => {
    const s = stripSql(r.sql);
    const m = /config_rev\s*=\s*config_rev\s*\+\s*(\?|\d+)/i.exec(s);
    let kind = null, amount = null;
    if (m) {
      if (m[1] === '?') { kind = 'inline'; amount = Number(r.params[(s.slice(0, m.index).match(/\?/g) || []).length]); }
      else { amount = Number(m[1]); kind = /^UPDATE data_models SET config_rev = config_rev \+ 1 WHERE id IN \(\?(,\?)*\)$/i.test(s) ? 'helper' : 'literal'; }
    }
    return { r, s, kind, amount };
  });
}
function attributeWindow(c0, win, id, check) {
  const cl = classifyWindow(win);
  const incs = cl.filter(x => x.kind && x.amount === 1);
  const label = `${c0.cls === 'A' ? 'A' : 'B'}-归因 ${c0.name}`;
  const dump = JSON.stringify(cl.map(x => ({ seq: x.r.seq, kind: x.kind, amount: x.amount, sql: x.s.slice(0, 140), params: x.r.params.slice(-3) })));
  check(`${label}：窗口内（${win.length} 条 data_models 写语句）恰好 ${c0.expectDelta} 条递增语句（config_rev 自增量 1）`, incs.length === c0.expectDelta, `实际 ${incs.length} 条：${dump}`);
  if (c0.expectDelta !== 1 || incs.length !== 1) return;
  const inc = incs[0];
  check(`${label}：递增语句的绑定参数含本用例模型 id ${id}`, inc.r.params.some(p => Number(p) === id), dump);
  if (c0.expectKind) check(`${label}：递增语句形态为 ${c0.expectKind}`, inc.kind === c0.expectKind, `递增语句 kind=${inc.kind}；窗口：${dump}`);
  for (const h of (c0.covers || [])) {
    const a = ATTRIBUTION[h];
    if (!a) { check(`${label}：契约 hash ${h} 有归因判据`, false, `ATTRIBUTION 里没有 ${h}`); continue; }
    if (a.form === 'inline') {
      const cols = [...a.sameStmt, ...(c0.attrCol ? [c0.attrCol] : [])];
      check(`${label}：[${h}] 递增语句是 inline 形态且同句写目标独有列（${a.criterion}）`,
        inc.kind === 'inline' && cols.every(re => re.test(inc.s)) && !(a.notStmt || []).some(re => re.test(inc.s)), `递增语句 kind=${inc.kind}；窗口：${dump}`);
    } else {
      const incIdx = cl.indexOf(inc);
      const tIdx = [];
      cl.forEach((x, i) => { if (x !== inc && a.targets.every(re => re.test(x.s))) tIdx.push(i); });
      check(`${label}：[${h}] 递增语句是助手单语句，且窗口内恰好 1 条目标 SQL（${a.route}）`, inc.kind === 'helper' && tIdx.length === 1, `递增语句 kind=${inc.kind}；目标 SQL ${tIdx.length} 条；窗口：${dump}`);
      if (tIdx.length === 1) {
        const ti = tIdx[0];
        const wantIdx = a.order === 'helper-first' ? incIdx + 1 : incIdx - 1;
        const between = cl.slice(Math.min(incIdx, ti) + 1, Math.max(incIdx, ti)).map(x => x.s.slice(0, 80));
        check(`${label}：[${h}] 顺序与邻接——${a.order === 'helper-first' ? '助手在前、目标紧随其后' : '目标在前、助手紧随其后'}，二者之间无其他 data_models 写语句（允许的中间语句：无）`,
          ti === wantIdx, `助手序号 ${incIdx}、目标序号 ${ti}，期望目标序号 ${wantIdx}；二者之间 ${between.length} 条：${JSON.stringify(between)}；窗口：${dump}`);
        const tgt = cl[ti].r;
        check(`${label}：[${h}] 同一模型——助手参数恰为 [${id}] 且目标 SQL 的 WHERE id 参数为 ${id}`,
          inc.r.params.length === 1 && Number(inc.r.params[0]) === id && tgt.params.length > 0 && Number(tgt.params[tgt.params.length - 1]) === id,
          `助手参数 ${JSON.stringify(inc.r.params)}、目标参数 ${JSON.stringify(tgt.params)}；窗口：${dump}`);
      }
    }
  }
}

async function runAccounting(ctx) {
  const { api, check, admin } = ctx;
  for (const c0 of ctx.accPlan) {
    const c = { ...ctx, check };
    const { name, id } = c0;
    const startIdx = ctx.results.length;
    const pre = await api('GET', `/api/models/${id}/validation-status`, { token: admin.token });
    check(`${name}：前置——当前版本 pass 记录下 state=pass`, pre.json && pre.json.state === 'pass' && pre.json.gatePass === true, JSON.stringify(pre.json));
    const rev0 = await ctx.rev(id);
    const beforeRow = (c0.covers && c0.covers.length) ? await ctx.row(id) : null;   // 覆盖用例：请求前读目标列旧值
    const seq0 = ctx.traceLastSeq();
    const actRes = await c0.act(c, id);
    if (c0.expectStatus !== undefined) check(`${name}：写入请求返回 ${c0.expectStatus}`, actRes && actRes.status === c0.expectStatus, JSON.stringify(actRes && (actRes.json || actRes.text)));
    let rev1;
    if (c0.expectDelta > 0) rev1 = await waitFor(async () => { const r = await ctx.rev(id); return r !== rev0 ? r : null; }) || await ctx.rev(id);
    else { await settle(c0.async ? 700 : 100); rev1 = await ctx.rev(id); }
    const seq1 = ctx.traceLastSeq();
    check(`${c0.cls === 'A' ? 'A-记账' : 'B-记账'} ${name}：config_rev 恰好 +${c0.expectDelta}`, rev1 - rev0 === c0.expectDelta, `before=${rev0} after=${rev1}`);
    attributeWindow(c0, ctx.traceRecords().filter(r => r.seq > seq0 && r.seq <= seq1), id, check);   // 写点级归因：窗口内递增语句恰好 expectDelta 条且来自契约声明的那条写点
    if (c0.verify) await c0.verify(c, id, actRes);
    const post = await api('GET', `/api/models/${id}/validation-status`, { token: admin.token });
    const passing = post.json && ['pass', 'warn'].includes(post.json.state);
    // A 类写入后：当前版本已无候选、存在更早版本的 pass 记录 ⇒ 状态必须正好是 stale（不是 none / fail 之类的别的「不通过」）
    if (c0.expectDelta > 0) check(`A-性质 ${name}：写入后 state === 'stale'（不再是 pass / warn）`, post.json && !passing && post.json.state === 'stale' && post.json.gatePass === false, JSON.stringify(post.json));
    else check(`B-性质 ${name}：写入后 state 仍是 pass`, post.json && post.json.state === 'pass' && post.json.gatePass === true, JSON.stringify(post.json));
    // 列表接口同一模型那一行的 acceptance.state 必须与上面一致（A → 'stale'、B → 'pass'；期望手写）；已软删除的模型不在列表里，跳过
    const after = await ctx.row(id);
    if (after && after.is_deleted !== 1) {
      const list = await api('GET', `/api/models?keyword=${encodeURIComponent(after.table_name)}`, { token: admin.token });
      const row = Array.isArray(list.json) ? list.json.find(x => x.id === id) : null;
      const want = c0.expectDelta > 0 ? 'stale' : 'pass';
      check(`${c0.cls === 'A' ? 'A' : 'B'}-性质（列表）${name}：GET /api/models 该行 acceptance.state === '${want}'`, row && row.acceptance && row.acceptance.state === want, JSON.stringify(row ? row.acceptance : { status: list.status, rows: Array.isArray(list.json) ? list.json.length : typeof list.json }));
    }
    // A 类覆盖登记：该用例声明覆盖某些写点（covers），只有「本用例的全部断言都通过」且「config_rev 恰好 +1」且「证据断言成立（那条 SQL 确实执行了）」才算覆盖
    if (c0.covers && c0.covers.length) {
      const failedHere = ctx.results.slice(startIdx).some(r => !r.ok);
      let ev = false;
      try { ev = !!(await c0.evidence(c, beforeRow, after)); } catch (_) { ev = false; }
      const ok = !failedHere && c0.expectDelta === 1 && rev1 - rev0 === 1 && ev;
      for (const h of c0.covers) { if (!ctx.coverage.has(h)) ctx.coverage.set(h, []); ctx.coverage.get(h).push({ name, ok }); }
    }
  }
}

// #77 C2a：注册 / 批量导入入口接收 impl_note 与 design_notes 并落库（INSERT 路径，不属于「已有模型 + 验收记录」的 mk 用例形态，单独执行）
async function runImplNoteEntry(ctx) {
  const { api, check, admin } = ctx;
  const nm = (tag) => `mc_c2a_${tag}_${Date.now().toString(36)}`;
  const regName = nm('reg');
  const reg = await api('POST', '/api/models', { token: admin.token, body: { layer: 'ODS', table_name: regName, table_comment: '注册用例', domain: 'MCDOM', tech_owner: 'mc_tech', biz_owner: 'mc_biz', update_cycle: 'di', impl_note: '注册时的实现说明', design_notes: '注册时的设计说明' } });
  check('C2a 注册：POST /api/models 返回 200 并给出 id', reg.status === 200 && reg.json && Number.isInteger(reg.json.id), JSON.stringify(reg.json || reg.text));
  const regRow = reg.json && reg.json.id ? await ctx.row(reg.json.id) : null;
  check('C2a 注册：impl_note 与 design_notes 确已落库', regRow && regRow.impl_note === '注册时的实现说明' && regRow.design_notes === '注册时的设计说明', JSON.stringify(regRow && [regRow.impl_note, regRow.design_notes]));
  const regName2 = nm('reg2');
  const reg2 = await api('POST', '/api/models', { token: admin.token, body: { layer: 'ODS', table_name: regName2, table_comment: '注册用例（不带实现说明）', domain: 'MCDOM', tech_owner: 'mc_tech', biz_owner: 'mc_biz', update_cycle: 'di' } });
  const reg2Row = reg2.json && reg2.json.id ? await ctx.row(reg2.json.id) : null;
  check('C2a 注册：不带 impl_note 时落库为 NULL（不是字符串 "undefined"）', reg2.status === 200 && reg2Row && reg2Row.impl_note === null, JSON.stringify(reg2Row && reg2Row.impl_note));
  const bn1 = nm('b1'); const bn2 = nm('b2');
  const bat = await api('POST', '/api/models/batch', { token: admin.token, body: [
    { layer: 'ods', table_name: bn1, table_comment: '批量一', impl_note: '批量实现说明', design_notes: '批量设计说明' },
    { layer: 'ods', table_name: bn2, table_comment: '批量二' },
  ] });
  check('C2a 批量导入：POST /api/models/batch 成功 2 条', bat.status === 200 && bat.json && bat.json.success === 2 && bat.json.failed === 0, JSON.stringify(bat.json || bat.text));
  const bRow1 = await ctx.rd.get('SELECT impl_note, design_notes FROM data_models WHERE table_name = ?', [bn1]);
  const bRow2 = await ctx.rd.get('SELECT impl_note, design_notes FROM data_models WHERE table_name = ?', [bn2]);
  check('C2a 批量导入：带 impl_note / design_notes 的行确已落库', bRow1 && bRow1.impl_note === '批量实现说明' && bRow1.design_notes === '批量设计说明', JSON.stringify(bRow1));
  check('C2a 批量导入：不带的行两列均为 NULL', bRow2 && bRow2.impl_note === null && bRow2.design_notes === null, JSON.stringify(bRow2));
}

// #77 C2a 修复 F1：PUT /api/models/:id/comment-split 的负向 / 边界用例（成功路径在 planAccounting 的 mk 里）。
//   每个 409 / 403 / 400 / 404 用例都断言：整行逐列不变（含 updated_at、config_rev）、变更日志条数不变；期望值全部手写。
async function runCommentSplit(ctx) {
  const { api, check, admin, owner, rd } = ctx;
  const cs = ctx.accPlan && ctx.accPlan.cs;
  if (!cs) { check('comment-split：夹具计划存在', false, 'accPlan.cs 缺失'); return; }
  const put = (token, id, body) => api('PUT', `/api/models/${id}/comment-split`, { token, body });
  const rowJson = async (id) => JSON.stringify(await ctx.row(id));
  const logCount = async (id) => (await rd.get("SELECT COUNT(*) AS c FROM model_change_logs WHERE model_id = ?", [id])).c;
  const untouched = async (name, id, fn) => {
    const r0 = await rowJson(id), l0 = await logCount(id);
    const res = await fn();
    await settle(250);
    check(`${name}：整行逐列不变（含 updated_at / config_rev），变更日志条数不变`, (await rowJson(id)) === r0 && (await logCount(id)) === l0, `before=${r0} after=${await rowJson(id)}`);
    return res;
  };

  // 409：expected.table_comment 与现值不符
  let r = await untouched('comment-split expected.table_comment 不符', cs.mismatch, () => put(admin.token, cs.mismatch, { expected: { table_comment: '不是现值', impl_note: null }, set: { table_comment: '短', impl_note: '说明' } }));
  check('comment-split expected.table_comment 不符 ⇒ 409 precondition_failed，current 带当前值', r.status === 409 && r.json && r.json.error === 'precondition_failed' && r.json.current && r.json.current.table_comment === 'mc cs 旧注释' && r.json.current.impl_note === null, JSON.stringify(r.json || r.text));
  // 409：expected.impl_note 与现值不符（库里 NULL，期望 'x'）——NULL 安全比较
  r = await untouched('comment-split expected.impl_note 不符（库里 NULL）', cs.implMismatch, () => put(admin.token, cs.implMismatch, { expected: { table_comment: 'mc cs 注释B', impl_note: 'x' }, set: { table_comment: '短B', impl_note: null } }));
  check('comment-split expected.impl_note 不符 ⇒ 409', r.status === 409 && r.json && r.json.error === 'precondition_failed', JSON.stringify(r.json || r.text));
  // 403：非 admin（owner 为普通用户）
  r = await untouched('comment-split 非 admin', cs.nonAdmin, () => put(owner.token, cs.nonAdmin, { expected: { table_comment: 'mc cs 注释C', impl_note: null }, set: { table_comment: '短C', impl_note: null } }));
  check('comment-split 非 admin ⇒ 403（条件本来匹配也不写）', r.status === 403, JSON.stringify(r.json || r.text));
  // 无 token
  r = await api('PUT', `/api/models/${cs.nonAdmin}/comment-split`, { body: { expected: { table_comment: 'mc cs 注释C', impl_note: null }, set: { table_comment: '短C', impl_note: null } } });
  check('comment-split 无 token ⇒ 401 / 403（不写）', r.status === 401 || r.status === 403, `${r.status}`);
  // 409：已软删除模型（expected 与现值完全一致也不写）
  r = await untouched('comment-split 已删除模型', cs.deleted, () => put(admin.token, cs.deleted, { expected: { table_comment: 'mc cs 已删除模型注释', impl_note: null }, set: { table_comment: '短D', impl_note: null } }));
  check('comment-split 已删除模型 ⇒ 409，current.is_deleted = 1', r.status === 409 && r.json && r.json.current && r.json.current.is_deleted === 1, JSON.stringify(r.json || r.text));
  // 404 / 400
  r = await put(admin.token, 99999999, { expected: { table_comment: 'a', impl_note: null }, set: { table_comment: 'b', impl_note: null } });
  check('comment-split 不存在的模型 ⇒ 404', r.status === 404, `${r.status} ${JSON.stringify(r.json)}`);
  for (const [label, body] of [['缺 expected', { set: { table_comment: 'b', impl_note: null } }], ['缺 set', { expected: { table_comment: 'a', impl_note: null } }],
    ['expected 缺 impl_note', { expected: { table_comment: 'a' }, set: { table_comment: 'b', impl_note: null } }],
    ['set.table_comment 为空串', { expected: { table_comment: 'mc cs 注释B', impl_note: null }, set: { table_comment: '  ', impl_note: null } }],
    ['set.impl_note 类型不对', { expected: { table_comment: 'mc cs 注释B', impl_note: null }, set: { table_comment: 'b', impl_note: 5 } }],
    ['companion_of 不是正整数', { expected: { table_comment: 'mc cs 注释B', impl_note: null }, set: { table_comment: 'b', impl_note: null }, companion_of: 'x' }]]) {
    r = await untouched(`comment-split 请求体非法（${label}）`, cs.implMismatch, () => put(admin.token, cs.implMismatch, body));
    check(`comment-split 请求体非法（${label}）⇒ 400`, r.status === 400, `${r.status} ${JSON.stringify(r.json)}`);
  }
  // 伴生归属：companion_of 与实际不符 ⇒ 409，行不变；与实际相符 ⇒ 200，只改两列、config_rev 不变
  const compBody = (companionOf) => ({ expected: { table_comment: 'mc cs 父表注释 - 变更追踪', impl_note: null }, set: { table_comment: 'mc cs 短名 - 变更追踪', impl_note: null }, companion_of: companionOf });
  r = await untouched('comment-split 带 companion_of 不符', cs.comp, () => put(admin.token, cs.comp, compBody(cs.compOther)));
  check('comment-split 带 companion_of 不符（行实际挂在另一个父表）⇒ 409，current.companion_of = 实际父表', r.status === 409 && r.json && r.json.current && r.json.current.companion_of === cs.compParent, JSON.stringify(r.json || r.text));
  const compRev0 = await ctx.rev(cs.comp);
  const compBefore = await ctx.row(cs.comp);
  r = await put(admin.token, cs.comp, compBody(cs.compParent));
  await settle(250);
  const compAfter = await ctx.row(cs.comp);
  const compDiff = Object.keys(compBefore).filter(k => compBefore[k] !== compAfter[k]).sort();
  check('comment-split 带 companion_of 相符 ⇒ 200，只改 table_comment / updated_at 两列（impl_note 保持 NULL），companion_of 不变，config_rev 不变', r.status === 200 && JSON.stringify(compDiff) === JSON.stringify(['table_comment', 'updated_at']) && compAfter.table_comment === 'mc cs 短名 - 变更追踪' && compAfter.companion_of === cs.compParent && (await ctx.rev(cs.comp)) === compRev0, `${r.status} ${JSON.stringify(compDiff)}`);
  // S3：parent_only —— 对伴生行带 parent_only ⇒ 409（行不变）；对父行带 ⇒ 200；与 companion_of 同时给 ⇒ 400；非布尔 ⇒ 400
  r = await untouched('comment-split parent_only 作用在伴生行', cs.comp, () => put(admin.token, cs.comp, { expected: { table_comment: 'mc cs 短名 - 变更追踪', impl_note: null }, set: { table_comment: 'x - 变更追踪', impl_note: null }, parent_only: true }));
  check('S3 comment-split parent_only 作用在伴生行（companion_of 非 NULL）⇒ 409，current.companion_of = 实际父表', r.status === 409 && r.json && r.json.current && r.json.current.companion_of === cs.compParent, JSON.stringify(r.json || r.text));
  r = await untouched('comment-split parent_only 与 companion_of 同时给', cs.comp, () => put(admin.token, cs.comp, { expected: { table_comment: 'a', impl_note: null }, set: { table_comment: 'b', impl_note: null }, parent_only: true, companion_of: cs.compParent }));
  check('S3 comment-split parent_only 与 companion_of 同时给 ⇒ 400', r.status === 400, `${r.status} ${JSON.stringify(r.json)}`);
  r = await untouched('comment-split parent_only 非布尔', cs.parentOk, () => put(admin.token, cs.parentOk, { expected: { table_comment: 'mc cs 注释F', impl_note: null }, set: { table_comment: 'b', impl_note: null }, parent_only: 'yes' }));
  check('S3 comment-split parent_only 非布尔 ⇒ 400', r.status === 400, `${r.status} ${JSON.stringify(r.json)}`);
  const pRev0 = await ctx.rev(cs.parentOk);
  r = await put(admin.token, cs.parentOk, { expected: { table_comment: 'mc cs 注释F', impl_note: null }, set: { table_comment: 'mc cs 注释F（改）', impl_note: null }, parent_only: true });
  await settle(250);
  check('S3 comment-split parent_only 作用在父行 ⇒ 200，落库，config_rev 不变', r.status === 200 && (await ctx.row(cs.parentOk)).table_comment === 'mc cs 注释F（改）' && (await ctx.rev(cs.parentOk)) === pRev0, `${r.status} ${JSON.stringify(r.json)}`);
  // S4：expected 与 set 两列全等 ⇒ 200 noChange，不执行 UPDATE（整行含 updated_at 不变）、不写日志；窗口内无 data_models 写语句
  const nSeq0 = ctx.traceLastSeq();
  r = await untouched('comment-split expected 与 set 全等（空操作）', cs.noop, () => put(admin.token, cs.noop, { expected: { table_comment: 'mc cs 注释E', impl_note: '原实现说明' }, set: { table_comment: 'mc cs 注释E', impl_note: '原实现说明' } }));
  const nWin = ctx.traceRecords().filter(x => x.seq > nSeq0 && x.seq <= ctx.traceLastSeq());
  check('S4 comment-split 空操作 ⇒ 200 { noChange: true }，窗口内没有任何 data_models 写语句（不执行 UPDATE）', r.status === 200 && r.json && r.json.noChange === true && nWin.length === 0, `${r.status} ${JSON.stringify(r.json)} win=${nWin.length}`);
  // R4（codex 24-R）：空操作（expected 与 set 全等）也必须先过存在性 / 删除 / 归属 / 旧值校验，不能绕过条件检查
  const sameBody = (tc, impl, extra) => ({ expected: { table_comment: tc, impl_note: impl }, set: { table_comment: tc, impl_note: impl }, ...(extra || {}) });
  r = await put(admin.token, 99999999, sameBody('a', null));
  check('R4 comment-split 空操作 + 不存在的模型 ⇒ 404（不再提前返回 noChange）', r.status === 404 && !(r.json && r.json.noChange), `${r.status} ${JSON.stringify(r.json)}`);
  r = await untouched('R4 comment-split 空操作 + 已删除模型', cs.deleted, () => put(admin.token, cs.deleted, sameBody('mc cs 已删除模型注释', null)));
  check('R4 comment-split 空操作 + 已删除模型 ⇒ 409，current.is_deleted = 1，不返回 noChange', r.status === 409 && r.json && r.json.error === 'precondition_failed' && r.json.current && r.json.current.is_deleted === 1 && !r.json.noChange, JSON.stringify(r.json || r.text));
  r = await untouched('R4 comment-split 空操作 + companion_of 与实际不符', cs.comp, () => put(admin.token, cs.comp, sameBody('mc cs 短名 - 变更追踪', null, { companion_of: cs.compOther })));
  check('R4 comment-split 空操作 + companion_of 与实际不符 ⇒ 409，current.companion_of = 实际父表，不返回 noChange', r.status === 409 && r.json && r.json.current && r.json.current.companion_of === cs.compParent && !r.json.noChange, JSON.stringify(r.json || r.text));
  r = await untouched('R4 comment-split 空操作 + parent_only 作用在伴生行', cs.comp, () => put(admin.token, cs.comp, sameBody('mc cs 短名 - 变更追踪', null, { parent_only: true })));
  check('R4 comment-split 空操作 + parent_only 作用在伴生行 ⇒ 409，不返回 noChange', r.status === 409 && r.json && r.json.current && r.json.current.companion_of === cs.compParent && !r.json.noChange, JSON.stringify(r.json || r.text));
  r = await untouched('R4 comment-split 空操作 + 旧值与现值不符', cs.noop, () => put(admin.token, cs.noop, sameBody('不是现值的注释', null)));
  check('R4 comment-split 空操作但 expected 不是现值 ⇒ 409，current 带当前值，不返回 noChange', r.status === 409 && r.json && r.json.current && r.json.current.table_comment === 'mc cs 注释E' && !r.json.noChange, JSON.stringify(r.json || r.text));
  r = await untouched('R4 comment-split 空操作 + companion_of 与实际相符', cs.comp, () => put(admin.token, cs.comp, sameBody('mc cs 短名 - 变更追踪', null, { companion_of: cs.compParent })));
  check('R4 comment-split 空操作 + 条件全部满足（归属相符）⇒ 200 noChange（条件满足才返回 noChange）', r.status === 200 && r.json && r.json.noChange === true, JSON.stringify(r.json || r.text));
  // set.impl_note 空串 ⇒ 落库为 NULL（与 PUT 同口径）；expected 为现值
  r = await put(admin.token, cs.blankImpl, { expected: { table_comment: 'mc cs 注释D', impl_note: '待清空的实现说明' }, set: { table_comment: 'mc cs 注释D', impl_note: '' } });
  await settle(250);
  check('comment-split set.impl_note 空串 ⇒ 200，库里为 NULL', r.status === 200 && (await ctx.row(cs.blankImpl)).impl_note === null, `${r.status} ${JSON.stringify(r.json)}`);
  // 重放同一请求（expected 已不再是现值）⇒ 409：幂等 / 防重复覆盖
  const replay = await put(admin.token, cs.blankImpl, { expected: { table_comment: 'mc cs 注释D', impl_note: '待清空的实现说明' }, set: { table_comment: 'mc cs 注释D', impl_note: '' } });
  check('comment-split 重放同一请求 ⇒ 409（expected 已不是现值）', replay.status === 409, `${replay.status} ${JSON.stringify(replay.json)}`);

  // X1（codex 24-R2）：可选 expected_config_rev —— 版本不符 ⇒ 409（带当前 config_rev）、整行不变；相符 ⇒ 200 且 config_rev 仍不变（B 类）；缺省 ⇒ 行为不变；非整数 ⇒ 400；空操作也先过版本条件
  const revNow = await ctx.rev(cs.parentOk);
  const pBody = (extra) => ({ expected: { table_comment: 'mc cs 注释F（改）', impl_note: null }, set: { table_comment: 'mc cs 注释F（再改）', impl_note: null }, ...(extra || {}) });
  r = await untouched('X1 comment-split expected_config_rev 不符', cs.parentOk, () => put(admin.token, cs.parentOk, pBody({ parent_only: true, expected_config_rev: revNow + 1 })));
  check('X1 comment-split expected_config_rev 不符 ⇒ 409 precondition_failed，current.config_rev = 实际版本（其余条件本来都满足也不写）', r.status === 409 && r.json && r.json.error === 'precondition_failed' && r.json.current && r.json.current.config_rev === revNow, JSON.stringify(r.json || r.text));
  for (const [label, v] of [['字符串 "1"', '1'], ['小数 1.5', 1.5], ['null', null]]) {
    r = await untouched(`X1 comment-split expected_config_rev 非整数（${label}）`, cs.parentOk, () => put(admin.token, cs.parentOk, pBody({ expected_config_rev: v })));
    check(`X1 comment-split expected_config_rev 非整数（${label}）⇒ 400`, r.status === 400, `${r.status} ${JSON.stringify(r.json)}`);
  }
  const noopRev = await ctx.rev(cs.noop);
  r = await untouched('X1 comment-split 空操作 + expected_config_rev 不符', cs.noop, () => put(admin.token, cs.noop, sameBody('mc cs 注释E', '原实现说明', { expected_config_rev: noopRev + 5 })));
  check('X1 comment-split 空操作 + expected_config_rev 不符 ⇒ 409，不返回 noChange', r.status === 409 && r.json && r.json.error === 'precondition_failed' && !r.json.noChange, JSON.stringify(r.json || r.text));
  r = await put(admin.token, cs.noop, sameBody('mc cs 注释E', '原实现说明', { expected_config_rev: noopRev }));
  check('X1 comment-split 空操作 + expected_config_rev 相符 ⇒ 200 noChange', r.status === 200 && r.json && r.json.noChange === true, JSON.stringify(r.json || r.text));
  r = await put(admin.token, cs.parentOk, pBody({ parent_only: true, expected_config_rev: revNow }));
  await settle(250);
  check('X1 comment-split expected_config_rev 相符 ⇒ 200，落库，config_rev 仍不变（B 类）', r.status === 200 && (await ctx.row(cs.parentOk)).table_comment === 'mc cs 注释F（再改）' && (await ctx.rev(cs.parentOk)) === revNow, `${r.status} ${JSON.stringify(r.json)}`);
  r = await put(admin.token, cs.parentOk, { expected: { table_comment: 'mc cs 注释F（再改）', impl_note: null }, set: { table_comment: 'mc cs 注释F（三改）', impl_note: null }, parent_only: true });
  await settle(250);
  check('X1 comment-split 缺省 expected_config_rev ⇒ 行为不变（200，落库）', r.status === 200 && (await ctx.row(cs.parentOk)).table_comment === 'mc cs 注释F（三改）', `${r.status} ${JSON.stringify(r.json)}`);
  // X7（codex 24-R2）：expected / set 两列必须存在且为字符串或 null（缺失 / 类型不对 ⇒ 400，不靠 undefined 当 NULL 混过去）
  for (const [label, body] of [['expected 缺 table_comment', { expected: { impl_note: null }, set: { table_comment: 'b', impl_note: null } }],
    ['expected.table_comment 是数字', { expected: { table_comment: 5, impl_note: null }, set: { table_comment: 'b', impl_note: null } }],
    ['expected.impl_note 是对象', { expected: { table_comment: 'mc cs 注释B', impl_note: {} }, set: { table_comment: 'b', impl_note: null } }],
    ['set 缺 impl_note', { expected: { table_comment: 'mc cs 注释B', impl_note: null }, set: { table_comment: 'b' } }],
    ['expected 是数组', { expected: [], set: { table_comment: 'b', impl_note: null } }]]) {
    r = await untouched(`X7 comment-split 请求体非法（${label}）`, cs.implMismatch, () => put(admin.token, cs.implMismatch, body));
    check(`X7 comment-split 请求体非法（${label}）⇒ 400`, r.status === 400, `${r.status} ${JSON.stringify(r.json)}`);
  }
}

// A 类写点覆盖断言：契约文件（a-class-coverage.json，由主会话与守卫共用）的每一条都必须被至少一个「通过的」用例覆盖
const A_CLASS_COVERAGE_FILE = path.join(__dirname, 'fixtures', 'model-gate-contract', 'a-class-coverage.json');
function assertAClassCoverage(ctx, check) {
  let entries;
  try { entries = JSON.parse(fs.readFileSync(A_CLASS_COVERAGE_FILE, 'utf8')).entries; } catch (e) { check('A 类覆盖：契约文件可读', false, `${A_CLASS_COVERAGE_FILE}：${e.message}`); return []; }
  const table = [];
  for (const en of entries) {
    const hits = (ctx.coverage.get(en.hash) || []);
    const passed = hits.filter(h => h.ok).map(h => h.name);
    table.push({ hash: en.hash, route: en.route, passed, all: hits.map(h => `${h.name}${h.ok ? '' : '（未通过）'}`) });
    check(`A 类覆盖 ${en.route} ${en.hash}（${en.what}）：至少一个通过的用例让该条 SQL 执行且 config_rev 恰好 +1`, passed.length >= 1, `覆盖登记：${hits.length ? hits.map(h => h.name + (h.ok ? '' : '（未通过）')).join('；') : '（无用例声明覆盖）'}`);
  }
  // 反向：用例声明了契约文件里没有的 hash ⇒ 契约与套件不一致
  const known = new Set(entries.map(e => e.hash));
  for (const h of ctx.coverage.keys()) check(`A 类覆盖：用例声明的 hash ${h} 必须在契约文件里`, known.has(h), `契约文件没有 ${h}`);
  return table;
}

// ───────── §2 门禁传 task ─────────
async function planGates(env, onlyLate) {
  const { fx, owner } = env;
  const CREATED = '2026-03-10 12:00:00';
  const variants = [['早于任务', '2026-03-10 11:59:59', false], ['与任务同秒', '2026-03-10 12:00:00', false], ['晚于任务', '2026-03-10 12:00:01', true]];
  const build = async (kind, testTime) => {
    const layer = { ods: 'ODS', dim: 'DIM', dwd: 'DWD' }[kind];
    const modelId = await fx.model({ layer, status: 'REVIEWING' });
    if (kind === 'ods') await fx.record(modelId, { phase: null, time: testTime });
    else { await fx.record(modelId, { phase: 'structure', time: testTime }); await fx.record(modelId, { phase: 'data', time: testTime }); }
    const taskId = await fx.task({ status: 'DONE', category: { ods: 'ODS_SYNC', dim: 'DIM_DEV', dwd: 'DWD_DEV' }[kind], linked_model_id: modelId, owner: owner.display_name, owner_id: owner.id, created_at: CREATED, done_at: CREATED });
    return { modelId, taskId };
  };
  const items = [];
  for (const [label, time, allowed] of variants.filter(v => !onlyLate || v[2])) {
    for (const kind of ['ods', 'dim']) items.push({ t: 'cs', kind, label, allowed, ...(await build(kind, time)) });
    for (const kind of ['ods', 'dim']) items.push({ t: 'at', kind, label, allowed, ...(await build(kind, time)) });
    items.push({ t: 'cf-owner', kind: 'ods', label, allowed, ...(await build('ods', time)) });
    for (const kind of ['dim', 'dwd']) items.push({ t: 'cf-admin', kind, label, allowed, ...(await build(kind, time)) });
  }
  return items;
}

async function runGates(ctx) {
  const { api, rd, admin, owner, check } = ctx;
  const taskStatus = async (taskId) => (await rd.get('SELECT status FROM task_pool WHERE id = ?', [taskId])).status;
  for (const it of ctx.gatePlan) {
    const tag = it.label === '晚于任务' ? 'gate-放行' : 'gate-拒绝';
    const same = it.label === '与任务同秒';
    const early = it.label === '早于任务';
    // 早于任务：拒绝文案全文（ODS 走 odsGateFailText、DIM / DWD 走 dimDwdGateFailText，实际输出都是 reason 原文，confirm 的 suffix 为空）
    const earlyText = (name, got) => check(`gate-早于文案 ${name}：文案全文 = EARLIER_THAN_TASK_REASON`, got === EARLIER_TEXT, JSON.stringify(got));
    // K3：管理员 / 发布者对关联 ODS 模型的任务不过验收门禁（与 confirm 的管理员旁路一致）；ODS 门禁只对非管理员 owner 生效——ODS 用例用 owner 读，DIM / DWD 用管理员读
    const reader = it.kind === 'ods' ? owner : admin;
    if (it.t === 'cs') {
      const r = await api('GET', `/api/tasks/${it.taskId}/can-self-archive`, { token: reader.token });
      const name = `门禁1 can-self-archive（${it.kind.toUpperCase()}，验收${it.label}）`;
      check(`${tag} ${name}：canSelfArchive=${it.allowed}`, r.json && r.json.canSelfArchive === it.allowed, JSON.stringify(r.json));
      if (same) check(`${name}：提示为方案原文`, r.json && r.json.reason === SAME_SECOND_TEXT, JSON.stringify(r.json));
      if (early) earlyText(name, r.json && r.json.reason);
    } else if (it.t === 'at') {
      const r = await api('GET', `/api/models/${it.modelId}/archivable-task`, { token: reader.token });
      const name = `门禁2 archivable-task（${it.kind.toUpperCase()}，验收${it.label}）`;
      check(`${tag} ${name}：canSelfArchive=${it.allowed}`, r.json && r.json.found === true && r.json.canSelfArchive === it.allowed, JSON.stringify(r.json));
      if (same) check(`${name}：提示为方案原文`, r.json && r.json.reason === SAME_SECOND_TEXT, JSON.stringify(r.json));
      if (early) earlyText(name, r.json && r.json.reason);
    } else {
      const who = it.t === 'cf-owner' ? owner : admin;
      const r = await api('POST', '/api/confirm', { token: who.token, body: { id: it.taskId } });
      const name = it.t === 'cf-owner' ? `门禁3 confirm 非 admin ODS（验收${it.label}）` : `门禁4 confirm admin ${it.kind.toUpperCase()}（验收${it.label}）`;
      check(`${tag} ${name}：${it.allowed ? '200 且任务归档' : '403 且任务仍为 DONE'}`,
        it.allowed ? (r.status === 200 && await taskStatus(it.taskId) === 'ARCHIVED') : (r.status === 403 && await taskStatus(it.taskId) === 'DONE'), `${r.status} ${r.text.slice(0, 200)}`);
      if (same) check(`${name}：提示为方案原文`, r.json && r.json.error === SAME_SECOND_TEXT, JSON.stringify(r.json));
      if (early) earlyText(name, r.json && r.json.error);
    }
  }
}

// ───────── G4：门禁分支按关联模型 layer，不按 task.category ─────────
async function planG4(env) {
  const { fx, owner } = env;
  const CREATED = '2026-03-10 12:00:00';
  const mkTask = (modelId, category) => fx.task({ status: 'DONE', category, linked_model_id: modelId, owner: owner.display_name, owner_id: owner.id, created_at: CREATED, done_at: CREATED });
  const staleDwd = await fx.model({ layer: 'DWD', status: 'REVIEWING', config_rev: 2 });
  await fx.record(staleDwd, { phase: 'all', rev: 1, time: '2026-03-10 12:00:05' });          // 旧版本记录 ⇒ 当前版本 stale
  const passDwd = await fx.model({ layer: 'DWD', status: 'REVIEWING' });
  await fx.record(passDwd, { phase: 'structure', time: '2026-03-10 12:00:05' });
  await fx.record(passDwd, { phase: 'data', time: '2026-03-10 12:00:05' });
  const dws = await fx.model({ layer: 'DWS', status: 'REVIEWING' });
  const ods = await fx.model({ layer: 'ODS', status: 'REVIEWING' });
  // H3：DONE 任务不得改 / 清关联模型（退回路径 POST /api/reopen：DONE → CLAIMED）
  const h3a = await fx.model({ layer: 'ODS', status: 'REVIEWING' });
  const h3b = await fx.model({ layer: 'ODS', status: 'REVIEWING' });
  const h3c = await fx.model({ layer: 'ODS', status: 'REVIEWING' });
  const h3d = await fx.model({ layer: 'ODS', status: 'REVIEWING' });
  const h3e = await fx.model({ layer: 'ODS', status: 'REVIEWING' });
  const mkClaimed = (modelId) => fx.task({ status: 'CLAIMED', category: 'ODS_SYNC', linked_model_id: modelId, owner: owner.display_name, owner_id: owner.id, created_at: CREATED });
  return {
    h3: {
      clear: { modelId: h3a, taskId: await mkTask(h3a, 'ODS_SYNC') },
      change: { modelId: h3b, otherId: h3e, taskId: await mkTask(h3b, 'ODS_SYNC') },
      same: { modelId: h3d, taskId: await mkTask(h3d, 'ODS_SYNC') },
      // 收口批 2 LOW-2：DONE 且本来没有关联模型的任务（linked_model_id 为 NULL）——清空分支只改标题时，靠语句条件里的 OR linked_model_id IS NULL 放行
      nolink: { taskId: await fx.task({ status: 'DONE', category: 'ODS_SYNC', owner: owner.display_name, owner_id: owner.id, created_at: CREATED, done_at: CREATED }) },
      claimed: { modelId: h3c, otherId: await fx.model({ layer: 'ODS', status: 'REVIEWING' }), taskId: await mkClaimed(h3c) },
    },
    staleDwd: { modelId: staleDwd, taskId: await mkTask(staleDwd, 'DATA_FIX') },
    passDwd: { modelId: passDwd, taskId: await mkTask(passDwd, 'DATA_FIX') },
    dws: { modelId: dws, taskId: await mkTask(dws, 'DWD_DEV') },
    ods: { modelId: ods, taskId: await mkTask(ods, 'ODS_SYNC') },
  };
}
async function runG4(ctx) {
  const { api, rd, admin, check } = ctx;
  const p = ctx.g4Plan;
  const st = async (taskId) => (await rd.get('SELECT status FROM task_pool WHERE id = ?', [taskId])).status;
  const confirm = (taskId) => api('POST', '/api/confirm', { token: admin.token, body: { id: taskId } });
  const a = await confirm(p.staleDwd.taskId);
  check('G4 管理员把关联 DWD 模型（验收 stale）的任务 category 改为 DATA_FIX 后 confirm：403 + state=stale + 任务仍为 DONE', a.status === 403 && a.json && a.json.state === 'stale' && a.json.gatePass === false && await st(p.staleDwd.taskId) === 'DONE', `${a.status} ${a.text.slice(0, 200)}`);
  const a2 = await api('GET', `/api/tasks/${p.staleDwd.taskId}/can-self-archive`, { token: admin.token });
  check('G4 同一任务 can-self-archive（admin）：canSelfArchive=false，state=stale（门禁按 layer 不按 category）', a2.json && a2.json.canSelfArchive === false && a2.json.state === 'stale', JSON.stringify(a2.json));
  const a3 = await api('GET', `/api/models/${p.staleDwd.modelId}/archivable-task`, { token: admin.token });
  check('G4 同一模型 archivable-task（admin）：canSelfArchive=false', a3.json && a3.json.found === true && a3.json.canSelfArchive === false, JSON.stringify(a3.json));
  const c = await confirm(p.passDwd.taskId);
  check('G4 对照：关联 DWD 模型当前版本已通过验收、category=DATA_FIX → 管理员 confirm 放行并归档', c.status === 200 && await st(p.passDwd.taskId) === 'ARCHIVED', `${c.status} ${c.text.slice(0, 200)}`);
  const d0 = await api('GET', `/api/tasks/${p.dws.taskId}/can-self-archive`, { token: admin.token });
  check('G4 关联 DWS 模型的 DWD_DEV 任务 can-self-archive（admin）：不执行验收门禁，canSelfArchive=true', d0.json && d0.json.canSelfArchive === true, JSON.stringify(d0.json));
  const d = await confirm(p.dws.taskId);
  check('G4 关联 DWS 模型的 DWD_DEV 任务管理员 confirm：不执行验收门禁，可归档（DWS 无判定规则，不受困）', d.status === 200 && await st(p.dws.taskId) === 'ARCHIVED', `${d.status} ${d.text.slice(0, 200)}`);
  // H3
  const upd = (body) => api('POST', '/api/update', { token: admin.token, body });
  const link = async (taskId) => (await rd.get('SELECT linked_model_id, title FROM task_pool WHERE id = ?', [taskId]));
  const h = p.h3;
  const u1 = await upd({ id: h.clear.taskId, title: 'h3 清空', category: 'ODS_SYNC' });
  const l1 = await link(h.clear.taskId);
  check('H3 DONE 任务清空关联 → 400「任务已完成，修改关联模型前请先退回任务」且 linked_model_id 不变、标题未改', u1.status === 400 && u1.json && u1.json.error === '任务已完成，修改关联模型前请先退回任务' && l1.linked_model_id === h.clear.modelId && l1.title !== 'h3 清空', `${u1.status} ${u1.text.slice(0, 200)} ${JSON.stringify(l1)}`);
  const u2 = await upd({ id: h.change.taskId, title: 'h3 改关联', category: 'ODS_SYNC', linked_model_id: h.change.otherId });
  const l2 = await link(h.change.taskId);
  check('H3 DONE 任务改关联到另一个 ODS 模型 → 400 且 linked_model_id 不变', u2.status === 400 && l2.linked_model_id === h.change.modelId, `${u2.status} ${u2.text.slice(0, 200)} ${JSON.stringify(l2)}`);
  const u3 = await upd({ id: h.same.taskId, title: 'h3 同关联改标题', category: 'ODS_SYNC', linked_model_id: h.same.modelId });
  const l3 = await link(h.same.taskId);
  check('H3 对照：DONE 任务关联模型不变、只改标题 → 照常成功', u3.status === 200 && l3.linked_model_id === h.same.modelId && l3.title === 'h3 同关联改标题', `${u3.status} ${u3.text.slice(0, 200)} ${JSON.stringify(l3)}`);
  const u5 = await upd({ id: h.nolink.taskId, title: 'h3 无关联改标题', category: 'ODS_SYNC' });
  const l5 = await link(h.nolink.taskId);
  check('H3 对照：DONE 且本来没关联的任务走清空分支、只改标题 → 200 且标题已变、关联仍为空（放行靠清空分支 UPDATE 条件里的 OR linked_model_id IS NULL）', u5.status === 200 && l5.title === 'h3 无关联改标题' && l5.linked_model_id === null, `${u5.status} ${u5.text.slice(0, 200)} ${JSON.stringify(l5)}`);
  const u4 = await upd({ id: h.claimed.taskId, title: 'h3 领取中改关联', category: 'ODS_SYNC', linked_model_id: h.claimed.otherId });
  const l4 = await link(h.claimed.taskId);
  check('H3 对照：CLAIMED 任务改关联 → 照常成功', u4.status === 200 && l4.linked_model_id === h.claimed.otherId, `${u4.status} ${u4.text.slice(0, 200)} ${JSON.stringify(l4)}`);
  const e = await confirm(p.ods.taskId);
  check('G4 关联 ODS 模型（无验收记录）任务管理员 confirm：既有旁路不变，可归档', e.status === 200 && await st(p.ods.taskId) === 'ARCHIVED', `${e.status} ${e.text.slice(0, 200)}`);
}

// ───────── H3x（末次合并审 H3）：/api/update DONE 门的条件写 ─────────
//   H3 的前置 SELECT 与 UPDATE 之间有 await，DONE 提交可能插进来。本组在被测副本里（正式代码无钩子）按标题标记在「前置检查之后、UPDATE 之前」把任务改成 DONE / 删掉，
//   只有语句级条件（AND (status IS NULL OR status != 'DONE' OR linked_model_id IS ?)）能拦住；changes = 0 后的重读分流：不存在 404 / DONE 且关联会变 400（同前置文案）/ 其他 409。
//   不用 sleep：注入点是同步串在请求处理里的 await，交错点确定。
const H3X_DONE_TEXT = '任务已完成，修改关联模型前请先退回任务';   // 手写期望
const H3X_409_TEXT = '任务状态已变化，请刷新后重试';
async function planH3x(env) {
  const { fx, owner } = env;
  const out = {};
  for (const k of ['link', 'clear', 'link409', 'clear409', 'linkDel', 'clearDel', 'ctl']) {
    const modelId = await fx.model({ layer: 'ODS', status: 'REVIEWING' });
    const otherId = await fx.model({ layer: 'ODS', status: 'REVIEWING' });
    out[k] = { modelId, otherId, taskId: await fx.task({ status: 'CLAIMED', category: 'ODS_SYNC', linked_model_id: modelId, owner: owner.display_name, owner_id: owner.id, created_at: K_CREATED }) };
  }
  return out;
}
async function runH3x(ctx) {
  const { api, rd, admin, check } = ctx;
  const p = ctx.h3xPlan;
  const upd = (body) => api('POST', '/api/update', { token: admin.token, body });
  const row = (taskId) => rd.get('SELECT status, linked_model_id, title FROM task_pool WHERE id = ?', [taskId]);
  const det = (r, after) => `${r.status} ${r.text.slice(0, 160)} ${JSON.stringify(after)}`;
  // 前置检查通过（任务当时是 CLAIMED）→ 注入把它提交为 DONE → UPDATE 的条件写拦住
  let r = await upd({ id: p.link.taskId, title: 'INJECT_H3_DONE', category: 'ODS_SYNC', linked_model_id: p.link.otherId });
  let a = await row(p.link.taskId);
  check('H3x 前置检查之后任务被提交为 DONE（改关联）：条件写拦住 → 400「任务已完成…」，状态 DONE、linked_model_id 与标题均未变', r.status === 400 && r.json && r.json.error === H3X_DONE_TEXT && a.status === 'DONE' && a.linked_model_id === p.link.modelId && a.title !== 'INJECT_H3_DONE', det(r, a));
  r = await upd({ id: p.clear.taskId, title: 'INJECT_H3_DONE', category: 'ODS_SYNC' });
  a = await row(p.clear.taskId);
  check('H3x 前置检查之后任务被提交为 DONE（清空关联）：条件写拦住 → 400「任务已完成…」，状态 DONE、linked_model_id 与标题均未变', r.status === 400 && r.json && r.json.error === H3X_DONE_TEXT && a.status === 'DONE' && a.linked_model_id === p.clear.modelId && a.title !== 'INJECT_H3_DONE', det(r, a));
  // 重读时状态又变回非 DONE（并发退回）→ 409
  r = await upd({ id: p.link409.taskId, title: 'INJECT_H3_409', category: 'ODS_SYNC', linked_model_id: p.link409.otherId });
  a = await row(p.link409.taskId);
  check('H3x 条件写 changes=0 后重读已不是 DONE（改关联）→ 409「任务状态已变化…」，linked_model_id 与标题均未变', r.status === 409 && r.json && r.json.error === H3X_409_TEXT && a.linked_model_id === p.link409.modelId && a.title !== 'INJECT_H3_409', det(r, a));
  r = await upd({ id: p.clear409.taskId, title: 'INJECT_H3_409', category: 'ODS_SYNC' });
  a = await row(p.clear409.taskId);
  check('H3x 条件写 changes=0 后重读已不是 DONE（清空关联）→ 409「任务状态已变化…」，linked_model_id 与标题均未变', r.status === 409 && r.json && r.json.error === H3X_409_TEXT && a.linked_model_id === p.clear409.modelId && a.title !== 'INJECT_H3_409', det(r, a));
  // 重读时任务已不存在 → 404
  r = await upd({ id: p.linkDel.taskId, title: 'INJECT_H3_DEL', category: 'ODS_SYNC', linked_model_id: p.linkDel.otherId });
  a = await row(p.linkDel.taskId);
  check('H3x 前置检查之后任务被删（改关联）→ 404「Task not found」', r.status === 404 && r.json && r.json.error === 'Task not found' && !a, det(r, a));
  r = await upd({ id: p.clearDel.taskId, title: 'INJECT_H3_DEL', category: 'ODS_SYNC' });
  a = await row(p.clearDel.taskId);
  check('H3x 前置检查之后任务被删（清空关联）→ 404「Task not found」', r.status === 404 && r.json && r.json.error === 'Task not found' && !a, det(r, a));
  // 对照：无注入的 CLAIMED 任务改关联 / 清空关联照常成功（条件写不过严）
  r = await upd({ id: p.ctl.taskId, title: 'h3x 对照改关联', category: 'ODS_SYNC', linked_model_id: p.ctl.otherId });
  a = await row(p.ctl.taskId);
  check('H3x 对照：无注入的 CLAIMED 任务改关联 → 200 且关联已变', r.status === 200 && a.linked_model_id === p.ctl.otherId && a.title === 'h3x 对照改关联', det(r, a));
  r = await upd({ id: p.ctl.taskId, title: 'h3x 对照清空', category: 'ODS_SYNC' });
  a = await row(p.ctl.taskId);
  check('H3x 对照：无注入的 CLAIMED 任务清空关联 → 200 且关联为空', r.status === 200 && a.linked_model_id === null && a.title === 'h3x 对照清空', det(r, a));
}

// ───────── H2x（末次合并审 H2）：PUT /api/models/:id 的版本条件写（WHERE id = ? AND config_rev IS <读到旧行时的版本>）─────────
//   读旧行与最终 UPDATE 之间别的请求改了同一行时，本请求的 A 类判定与递增都基于过期旧行：UPDATE changes = 0 → 整请求不落库、不记日志，重读分流：行不存在 / 已删除 404，否则 409。
//   被测副本里（正式代码无钩子）按 table_comment 标记在「读旧行之后、UPDATE 之前」模拟另一个请求的写入：BUMP = 改 source_table 并把 config_rev +1；DEL = 软删除并把 config_rev +1（「删除同时递增」；真实软删除 server.js DELETE /api/models/:id 不递增 config_rev，纯软删时 UPDATE 照常命中、不走 404，与 main 同为既有行为，本批不改 SQL）。不用 sleep。
const H2X_409_TEXT = '该模型已被他人修改，请刷新后重试';   // 手写期望
async function planH2x(env) {
  const { fx } = env;
  const cfgA = { version: 1, fields: [{ name: 'a' }] };
  const out = {};
  for (const k of ['bumpNoDim', 'bumpDim', 'delNoDim', 'delDim', 'ctlNoDim', 'ctlDim']) {
    const dim = ['bumpDim', 'delDim', 'ctlDim'].includes(k);   // 复审 47C-MED：旧写法 /Dim$/ 对 bumpNoDim / delNoDim / ctlNoDim 也为真，六个用例全走带 dim_config 分支——显式集合
    out[k] = { dim, id: await fx.model(dim ? { layer: 'DIM', status: 'DEVELOPING', dim_config: cfgA } : { layer: 'ODS', status: 'DEVELOPING' }) };
  }
  return out;
}
async function runH2x(ctx) {
  const { api, rd, admin, check } = ctx;
  const p = ctx.h2xPlan;
  const put = (id, body) => api('PUT', `/api/models/${id}`, { token: admin.token, body });
  const row = (id) => rd.get('SELECT table_comment, source_system, source_table, config_rev, is_deleted, dim_config FROM data_models WHERE id = ?', [id]);
  const rowAll = (id) => rd.get('SELECT * FROM data_models WHERE id = ?', [id]);
  const logCount = async (id) => (await rd.get('SELECT COUNT(*) AS n FROM model_change_logs WHERE model_id = ?', [id])).n;
  // 预筛 F47 MED-1：请求体断言的期望取手写表，不能用 c.dim 自证（c.dim 正是被守护的分支选择——退回 /Dim$/ 时 c.dim 与请求体同步出错，断言恒真）
  const EXPECT_DIM = { bumpNoDim: false, bumpDim: true, delNoDim: false, delDim: true, ctlNoDim: false, ctlDim: true };
  const bodyFor = (c, comment) => (c.dim ? { table_comment: comment, source_system: 'SYS_B', dim_config: { version: 1, fields: [{ name: 'a' }, { name: 'b' }] } } : { table_comment: comment, source_system: 'SYS_B' });
  for (const [key, label] of [['bumpNoDim', '不带 dim_config 分支'], ['bumpDim', '带 dim_config 分支']]) {
    const c = p[key];
    const b0 = await row(c.id);
    const l0 = await logCount(c.id);
    const bodyB = bodyFor(c, 'INJECT_H2_BUMP');
    check(`H2x ${label}：请求体${EXPECT_DIM[key] ? '含' : '不含'} dim_config 键（用例确实走${EXPECT_DIM[key] ? '带' : '不带'} dim_config 的 UPDATE 分支；${key}）`, c.dim === EXPECT_DIM[key] && Object.prototype.hasOwnProperty.call(bodyB, 'dim_config') === EXPECT_DIM[key], JSON.stringify(Object.keys(bodyB)));
    const r = await put(c.id, bodyB);
    const a = await row(c.id);
    const l1 = await logCount(c.id);
    check(`H2x ${label}：读旧行之后他人改了同一行（版本 +1）→ 本请求 409「该模型已被他人修改…」`, r.status === 409 && r.json && r.json.error === H2X_409_TEXT, `${r.status} ${r.text.slice(0, 200)}`);
    check(`H2x ${label}：409 时本请求零落库——table_comment / source_system${c.dim ? ' / dim_config' : ''} 均未变，只剩他人的写入（source_table = src_injected、config_rev 恰好 +1，本请求没有再递增），也没写变更日志`,
      a.table_comment === b0.table_comment && a.source_system === b0.source_system && a.source_table === 'src_injected' && a.config_rev === b0.config_rev + 1 && (!c.dim || a.dim_config === b0.dim_config) && l1 === l0,
      `before=${JSON.stringify(b0)} after=${JSON.stringify(a)} logs ${l0}→${l1}`);
  }
  for (const [key, label] of [['delNoDim', '不带 dim_config 分支'], ['delDim', '带 dim_config 分支']]) {
    const c = p[key];
    const bodyD = bodyFor(c, 'INJECT_H2_DEL');
    check(`H2x ${label}：请求体${EXPECT_DIM[key] ? '含' : '不含'} dim_config 键（${key}）`, c.dim === EXPECT_DIM[key] && Object.prototype.hasOwnProperty.call(bodyD, 'dim_config') === EXPECT_DIM[key], JSON.stringify(Object.keys(bodyD)));
    const full0 = await rowAll(c.id);
    const dl0 = await logCount(c.id);
    const r = await put(c.id, bodyD);
    const a = await row(c.id);
    const full1 = await rowAll(c.id);
    const dl1 = await logCount(c.id);
    // 复审 47C-LOW：404 分流必须是「整请求零落库」——除注入的软删除（is_deleted 0→1）与注入带来的一次版本递增（config_rev +1）外，整行其余列（table_comment / dim_config / updated_at …）与变更日志条数全部不变
    const strip = (x) => { const y = Object.assign({}, x); delete y.is_deleted; delete y.config_rev; return JSON.stringify(y); };
    check(`H2x ${label}：404 时本请求零落库——整行除 is_deleted（0→1）与 config_rev（恰好 +1，注入带来的）外所有列不变（含 table_comment / source_system${c.dim ? ' / dim_config' : ''} / updated_at），变更日志条数不变`,
      !!full0 && !!full1 && full0.is_deleted === 0 && full1.is_deleted === 1 && full1.config_rev === full0.config_rev + 1 && strip(full1) === strip(full0) && dl1 === dl0,
      `before=${JSON.stringify(full0)} after=${JSON.stringify(full1)} logs ${dl0}→${dl1}`);
    check(`H2x ${label}：读旧行之后他人删除了该模型且同时让版本 +1（软删除 + 递增；404 只覆盖硬删 / 删除同时递增，纯软删不递增时 UPDATE 照常命中，与 main 同为既有行为）→ 404「模型不存在」，本请求零落库`, r.status === 404 && r.json && r.json.error === '模型不存在' && a.is_deleted === 1 && a.source_system !== 'SYS_B', `${r.status} ${r.text.slice(0, 200)} ${JSON.stringify(a)}`);
  }
  for (const [key, label] of [['ctlNoDim', '不带 dim_config 分支'], ['ctlDim', '带 dim_config 分支']]) {
    const c = p[key];
    const b0 = await row(c.id);
    const bodyC = bodyFor(c, 'h2x 对照');
    check(`H2x 对照（${label}）：请求体${EXPECT_DIM[key] ? '含' : '不含'} dim_config 键（${key}）`, c.dim === EXPECT_DIM[key] && Object.prototype.hasOwnProperty.call(bodyC, 'dim_config') === EXPECT_DIM[key], JSON.stringify(Object.keys(bodyC)));
    const r = await put(c.id, bodyC);
    const a = await row(c.id);
    check(`H2x 对照（${label}）：无并发写入的同样请求 → 200，A 类字段变化 config_rev 恰好 +1，新值已写库`, r.status === 200 && a.table_comment === 'h2x 对照' && a.source_system === 'SYS_B' && a.config_rev === b0.config_rev + 1, `${r.status} ${r.text.slice(0, 200)} ${JSON.stringify(a)}`);
  }
}

// ───────── P57② 终检位置的静态断言（§8.4，预筛 LOW-4）─────────
//   p57 组的注入锚点就是终检那条语句本身，注入会跟着检查一起移动：把终检挪到早检之后、查任务之前，注入用例仍全绿，而真实窗口（规划阶段的几个 await）会重新打开。
//   所以位置约束另用静态断言守着，读被测副本里 save-scripts 处理函数的源码（accounting 组的副本没有注入）：
//   ① 终检（重读 config_rev 与 layer）出现在 `await effectiveSetDiffers(` 之后；
//   ② 终检到写文件循环 `for (const w of pendingWrites)` 之间（去掉注释后），await 只有两处：终检那条 dbGetAsync 本身，和 bumpConfigRev（非豁免路径才执行）。
function runSaveScriptsStatic(ctx) {
  const { check, copyRoot } = ctx;
  const src = fs.readFileSync(path.join(copyRoot, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf("app.post('/api/models/:id/save-scripts'");
  const end = src.indexOf("app.get('/api/models/:id/scripts'", start);
  const h = start >= 0 && end > start ? src.slice(start, end) : '';
  check('P57 save-scripts 终检位置（静态）：前提——取到 save-scripts 处理函数源码', h.length > 5000, `start=${start} end=${end}`);
  const SEL = "SELECT config_rev, layer FROM data_models WHERE id = ?";
  const iFinal = h.indexOf(SEL);
  const iEff = h.indexOf('await effectiveSetDiffers(');
  const iLoop = h.indexOf('for (const w of pendingWrites)');
  check('P57 save-scripts 终检位置（静态）：终检（重读 config_rev 与 layer）出现在 `await effectiveSetDiffers(` 之后、写文件循环之前（三个位置都找得到）',
    iFinal >= 0 && iEff >= 0 && iLoop >= 0 && iFinal > iEff && iFinal < iLoop, JSON.stringify({ iEff, iFinal, iLoop }));
  const seg = iFinal >= 0 && iLoop > iFinal ? h.slice(h.lastIndexOf('\n', iFinal), iLoop).split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n') : '';   // 去掉行注释（注释里会提到 await）
  const awaits = (seg.match(/\bawait\s+\w+/g) || []).map((s) => s.replace(/\s+/g, ' '));
  check('P57 save-scripts 终检位置（静态）：终检到写文件循环之间（去注释后）await 只有两处——终检的 dbGetAsync 与 bumpConfigRev（豁免路径上 bumpConfigRev 不执行，重读之后到写文件之间没有 await）',
    JSON.stringify(awaits) === JSON.stringify(['await dbGetAsync', 'await bumpConfigRev']), JSON.stringify(awaits));
}

// ───────── P57②（codex 49A-astra MED）：ODS 自动保存的版本检查做两次（读出模型行后立即判 + 进入写阶段之前重读再判）─────────
//   两次检查在正常运行下无法分开观测（第二次只比第一次晚几毫秒），所以用被测副本里的注入（正式代码无钩子）造出确定性的交错：
//   · BUMP（configVersion = INJECT_P57_BUMP）：请求带的版本 = 入口时的版本（第一次检查通过），在第二次检查的重读之前把 config_rev +1 ⇒ 只有第二次检查能拦住（409、零写入）；
//   · REVERT（configVersion = INJECT_P57_REVERT）：入口时版本已领先于请求（第一次检查应拦），注入在第二次检查之前把 config_rev −1 回到请求带的值 ⇒ 若第一次检查被去掉，第二次检查会放行并落盘（200）。
//     这是为了让「第一次检查」也有独立可观测的判红用例（正常运行下它与第二次检查对外表现相同）。不用 sleep。
const P57_OLD_DDL = ddl('2026-10-01', 'a int, c int');   // 预置的旧脚本内容（与 runP57 请求里的 ddl 实质不同，归一化后不等）
async function planP57(env) {
  const { fx, w, admin, copyRoot } = env;
  const safeN = (s) => s.replace(/[\\/:*?"<>|]/g, '_');
  const seed = (rel, fileName, content) => { const d = path.join(copyRoot, 'uploads', rel); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, fileName), content); };
  // 「已有旧脚本」夹具（codex 50C）：旧脚本在当前目录（script_path 指向它），或只在 script_path 指向的另一个目录（本次落盘目录因有关联任务换成任务目录，那里没有同名文件）
  const withOld = async (where) => {
    const id = await fx.model({ layer: 'ODS' });
    const t = (await w.get('SELECT table_name FROM data_models WHERE id = ?', [id])).table_name;
    const fileName = `${safeN(t)}_DDL.sql`;
    if (where === 'cur') {
      const rel = `${admin.display_name}/model_${id}_${safeN(t)}`;
      seed(rel, fileName, P57_OLD_DDL);
      await w.run('UPDATE data_models SET script_path = ? WHERE id = ?', [rel, id]);
      return { id, rel, taskOwner: null, fileName };
    }
    const rel = `mc_other_owner/b_dir_${id}`;
    seed(rel, fileName, P57_OLD_DDL);
    await w.run('UPDATE data_models SET script_path = ? WHERE id = ?', [rel, id]);
    const taskOwner = `mc_dir_owner_${id}`;
    await w.run("INSERT INTO task_pool (title, status, owner, owner_id, linked_model_id, category, created_at) VALUES (?, 'CLAIMED', ?, ?, ?, 'ODS_SYNC', '2026-03-10 12:00:00')", [fx.nextName('p57task'), taskOwner, 1, id]);
    return { id, rel, taskOwner, fileName };
  };
  return {
    second: await fx.model({ layer: 'ODS' }),
    ctl: await fx.model({ layer: 'ODS' }),
    entry: await fx.model({ layer: 'ODS', config_rev: 2 }),
    layerFinal: await fx.model({ layer: 'ODS' }),
    layerEntry: await fx.model({ layer: 'DIM' }),
    oldBump: await withOld('cur'),      // 当前目录有旧脚本 + 终检前版本被改
    oldLayer: await withOld('cur'),     // 当前目录有旧脚本 + 终检前分层被改
    oldPrev: await withOld('prev'),     // 旧脚本只在 script_path 目录 + 终检前版本被改
  };
}
async function runP57(ctx) {
  const { api, rd, admin, check, copyRoot } = ctx;
  const p = ctx.p57Plan;
  const safe = (s) => s.replace(/[\\/:*?"<>|]/g, '_');
  const body = { ddl: ddl('2026-10-01', 'a int'), sync: 'SELECT 1;' };
  const row = (id) => rd.get('SELECT * FROM data_models WHERE id = ?', [id]);
  const dirOf = (id, t) => path.join(copyRoot, 'uploads', admin.display_name, `model_${id}_${safe(t)}`);
  const post = async (id, extra) => api('POST', `/api/models/${id}/save-scripts`, { token: admin.token, body: { scripts: body, tableName: (await row(id)).table_name, ...extra } });
  const INJECT_BUMP_RE = /UPDATE data_models SET config_rev = COALESCE\(config_rev, 1\) \+ 1 WHERE id = \?/;
  const INJECT_REVERT_RE = /UPDATE data_models SET config_rev = config_rev - 1 WHERE id = \?/;
  // ── 对照：无注入、版本等于当前 ⇒ 200，首次落盘豁免（configRevBumped === false）
  {
    const r0 = await row(p.ctl);
    const res = await post(p.ctl, { purpose: 'ods-auto-save', expected_config_rev: r0.config_rev });
    const r1 = await row(p.ctl);
    check('P57② 对照（无注入、版本等于当前）：200、2 个文件已保存、首次落盘豁免不递增（configRevBumped === false、config_rev 不变）',
      res.status === 200 && res.json && res.json.savedFiles.length === 2 && res.json.configRevBumped === false && r1.config_rev === r0.config_rev && fs.existsSync(dirOf(p.ctl, r0.table_name)), `${res.status} ${res.text.slice(0, 200)}`);
  }
  // ── 第二次检查：入口版本 = 请求版本（第一次通过），重读之前被注入 +1
  {
    const r0 = await row(p.second);
    const s0 = ctx.traceLastSeq();
    const res = await post(p.second, { purpose: 'ods-auto-save', expected_config_rev: r0.config_rev, configVersion: 'INJECT_P57_BUMP' });
    await settle(300);
    const r1 = await row(p.second);
    const writes = ctx.traceRecords().filter(r => r.seq > s0);
    check('P57② 第二次检查：第一次检查通过后、重读之前配置又变（版本 +1）⇒ 409 CONFIG_REV_STALE，current_config_rev = 重读到的新版本（旧版本 + 1）',
      res.status === 409 && res.json && res.json.code === 'CONFIG_REV_STALE' && res.json.current_config_rev === r0.config_rev + 1, `${res.status} ${res.text.slice(0, 200)}`);
    check('P57② 第二次检查：零写入——config_rev 只多了注入的那一次（旧版本 + 1），没有脚本文件（目录都不存在）、script_path 仍为空，窗口内 data_models 写语句只有注入的那一条',
      r1.config_rev === r0.config_rev + 1 && !fs.existsSync(dirOf(p.second, r0.table_name)) && r1.script_path == null && writes.length === 1 && INJECT_BUMP_RE.test(writes[0].sql), JSON.stringify([r1.config_rev, r1.script_path, writes.map(w => w.sql.slice(0, 90))]));
  }
  // ── 第一次检查：入口版本领先（应在入口就 409），注入想在第二次检查前把版本拨回——只有第一次检查在，注入才不会被执行
  {
    const r0 = await row(p.entry);
    const s0 = ctx.traceLastSeq();
    const res = await post(p.entry, { purpose: 'ods-auto-save', expected_config_rev: r0.config_rev - 1, configVersion: 'INJECT_P57_REVERT' });
    await settle(300);
    const r1 = await row(p.entry);
    const writes = ctx.traceRecords().filter(r => r.seq > s0);
    check('P57② 第一次检查：入口版本领先于请求 ⇒ 409 CONFIG_REV_STALE，current_config_rev = 入口版本（请求在到达写阶段与第二次检查之前就被拦下）',
      res.status === 409 && res.json && res.json.code === 'CONFIG_REV_STALE' && res.json.current_config_rev === r0.config_rev, `${res.status} ${res.text.slice(0, 200)}`);
    check('P57② 第一次检查：零写入——注入没有被执行（窗口内 data_models 写语句 = 0、config_rev 仍是入口版本），没有脚本文件、script_path 仍为空',
      writes.length === 0 && !writes.some(w => INJECT_REVERT_RE.test(w.sql)) && r1.config_rev === r0.config_rev && !fs.existsSync(dirOf(p.entry, r0.table_name)) && r1.script_path == null, JSON.stringify([r1.config_rev, r1.script_path, writes.map(w => w.sql.slice(0, 90))]));
  }
  // ── 分层终检：入口时是 ODS（早检通过），终检重读之前被注入改成 DIM ⇒ 只有终检能拦（409 LAYER_NOT_ODS，零写入）
  {
    const r0 = await row(p.layerFinal);
    const s0 = ctx.traceLastSeq();
    const res = await post(p.layerFinal, { purpose: 'ods-auto-save', expected_config_rev: r0.config_rev, configVersion: 'INJECT_P57_LAYER' });
    await settle(300);
    const r1 = await row(p.layerFinal);
    const writes = ctx.traceRecords().filter(r => r.seq > s0);
    check('P57② 分层终检：早检通过后、重读之前分层被改成 DIM ⇒ 409 LAYER_NOT_ODS（不是把 ODS 脚本写进 DIM 模型目录）',
      res.status === 409 && res.json && res.json.code === 'LAYER_NOT_ODS', `${res.status} ${res.text.slice(0, 200)}`);
    check('P57② 分层终检：零写入——窗口内 data_models 写语句只有注入的那一条，config_rev 不变，没有脚本文件（目录都不存在）、script_path 仍为空',
      writes.length === 1 && /SET layer = 'DIM'/.test(writes[0].sql) && r1.config_rev === r0.config_rev && r1.layer === 'DIM' && !fs.existsSync(dirOf(p.layerFinal, r0.table_name)) && r1.script_path == null, JSON.stringify([r1.config_rev, r1.layer, r1.script_path, writes.map(w => w.sql.slice(0, 90))]));
  }
  // ── 分层早检：入口时已是 DIM（应在入口就 409），注入想在终检前把分层改回 ODS——只有早检在，注入才不会执行
  {
    const r0 = await row(p.layerEntry);
    const s0 = ctx.traceLastSeq();
    const res = await post(p.layerEntry, { purpose: 'ods-auto-save', expected_config_rev: r0.config_rev, configVersion: 'INJECT_P57_LAYER_BACK' });
    await settle(300);
    const r1 = await row(p.layerEntry);
    const writes = ctx.traceRecords().filter(r => r.seq > s0);
    check('P57② 分层早检：入口时模型已是 DIM ⇒ 409 LAYER_NOT_ODS（请求在到达写阶段与终检之前就被拦下）', res.status === 409 && res.json && res.json.code === 'LAYER_NOT_ODS', `${res.status} ${res.text.slice(0, 200)}`);
    check('P57② 分层早检：零写入——注入没有被执行（窗口内 data_models 写语句 = 0、分层仍是 DIM），没有脚本文件、script_path 仍为空',
      writes.length === 0 && r1.layer === 'DIM' && !fs.existsSync(dirOf(p.layerEntry, r0.table_name)) && r1.script_path == null, JSON.stringify([r1.layer, r1.script_path, writes.map(w => w.sql.slice(0, 90))]));
  }
  // ── codex 50C：「已有旧脚本、早检通过、终检拒绝」——旧脚本的归档 / 覆盖 / 移动若被挪到终检之前的规划阶段，没有旧脚本的上面几例和静态位置断言都判不出。
  //   这里的请求内容与旧脚本实质不同（会触发归档旧版本 + 覆盖），purpose + 当前版本 ⇒ 早检通过；终检前注入版本 +1 / 分层改 DIM ⇒ 终检 409；
  //   断言请求前后相关目录的「文件名 + 内容哈希」清单完全相同（旧文件原样、没有 _history、没有新文件、没有被改名）。
  const snapTree = (dir) => {   // 递归：相对路径 + sha256 的排序清单；目录不存在 ⇒ null
    if (!fs.existsSync(dir)) return null;
    const out = [];
    const walk = (d, rel) => { for (const ent of fs.readdirSync(d, { withFileTypes: true })) { const p2 = path.join(d, ent.name); const r2 = rel ? rel + '/' + ent.name : ent.name; if (ent.isDirectory()) { out.push([r2 + '/', null]); walk(p2, r2); } else out.push([r2, require('node:crypto').createHash('sha256').update(fs.readFileSync(p2)).digest('hex')]); } };
    walk(dir, '');
    return JSON.stringify(out.sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  };
  const sha256 = (s) => require('node:crypto').createHash('sha256').update(s).digest('hex');
  const oldInterleave = async (tag, plan, inject, wantCode) => {
    const r0 = await row(plan.id);
    const dirs = [path.join(copyRoot, 'uploads', plan.rel)];   // 只有旧脚本所在目录需要比清单（任务目录另断言「没有被创建」），所以不设额外目录参数
    const before = dirs.map(snapTree);
    // 前置（预筛 LOW-3）：请求前的快照里确有预置的旧脚本，且内容哈希 = sha256(P57_OLD_DDL)——夹具漂移（没播上 / 内容被改）时「文件零变化」会对着空目录恒真，这里让它在 --only=p57 下也判红
    const snap0 = before[0] ? JSON.parse(before[0]) : [];
    check(`P57② 终检交错·${tag}：前置——请求前旧脚本所在目录里有 ${plan.fileName}，内容哈希 = sha256(预置的旧脚本内容)`,
      snap0.some(([n, h]) => n === plan.fileName && h === sha256(P57_OLD_DDL)), JSON.stringify(snap0));
    const s0 = ctx.traceLastSeq();
    const res = await post(plan.id, { purpose: 'ods-auto-save', expected_config_rev: r0.config_rev, configVersion: inject });
    await settle(300);
    const r1 = await row(plan.id);
    const writes = ctx.traceRecords().filter(r => r.seq > s0);
    check(`P57② 终检交错·${tag}：早检通过（版本 / 分层都对），终检前被注入变化 ⇒ 409 ${wantCode}`, res.status === 409 && res.json && res.json.code === wantCode, `${res.status} ${res.text.slice(0, 200)}`);
    check(`P57② 终检交错·${tag}：文件零变化——旧脚本所在目录的文件名 + 内容哈希清单与请求前完全相同（旧文件原样，没有 _history / 新文件 / 改名），${plan.taskOwner ? '本次落盘的任务目录没有被创建，' : ''}script_path 不变`,
      dirs.every((d, i) => snapTree(d) === before[i]) && before[0] !== null && r1.script_path === r0.script_path && (!plan.taskOwner || !fs.existsSync(path.join(copyRoot, 'uploads', plan.taskOwner))),
      JSON.stringify([dirs.map((d, i) => snapTree(d) === before[i]), r1.script_path, r0.script_path]));
    return { r0, r1, writes };
  };
  {
    const o = await oldInterleave('当前目录有旧脚本·版本被改', p.oldBump, 'INJECT_P57_BUMP', 'CONFIG_REV_STALE');
    check('P57② 终检交错·当前目录有旧脚本·版本被改：config_rev 只多了注入的那一次（旧版本 + 1），窗口内 data_models 写语句只有注入的那一条（没有 script_path / 递增写入）',
      o.r1.config_rev === o.r0.config_rev + 1 && o.writes.length === 1 && INJECT_BUMP_RE.test(o.writes[0].sql), JSON.stringify([o.r1.config_rev, o.writes.map(x => x.sql.slice(0, 90))]));
  }
  {
    const o = await oldInterleave('当前目录有旧脚本·分层被改', p.oldLayer, 'INJECT_P57_LAYER', 'LAYER_NOT_ODS');
    check('P57② 终检交错·当前目录有旧脚本·分层被改：窗口内 data_models 写语句只有注入的那一条，config_rev 不变，分层是注入后的 DIM',
      o.r1.config_rev === o.r0.config_rev && o.r1.layer === 'DIM' && o.writes.length === 1 && /SET layer = 'DIM'/.test(o.writes[0].sql), JSON.stringify([o.r1.config_rev, o.r1.layer, o.writes.map(x => x.sql.slice(0, 90))]));
  }
  {
    const o = await oldInterleave('旧脚本只在 script_path 目录·版本被改', p.oldPrev, 'INJECT_P57_BUMP', 'CONFIG_REV_STALE');
    check('P57② 终检交错·旧脚本只在 script_path 目录·版本被改：config_rev 只多了注入的那一次，窗口内 data_models 写语句只有注入的那一条',
      o.r1.config_rev === o.r0.config_rev + 1 && o.writes.length === 1 && INJECT_BUMP_RE.test(o.writes[0].sql), JSON.stringify([o.r1.config_rev, o.writes.map(x => x.sql.slice(0, 90))]));
  }
}

// ───────── K 组（C1 对抗审 23-R2 修复批 3）：K1 伴生互斥 / K2 附件命名空间 / K3 三接口门禁判定矩阵 ─────────
const K1_TEXT = '伴生表不能单独关联任务，请关联其主表模型';   // 手写期望
const K2_TEXT = '文件名与任务附件命名格式冲突，请换一个名字';
const K_CREATED = '2026-03-10 12:00:00';
const K_REC_TIME = '2026-03-10 12:00:05';
async function planK(env) {
  const { fx, owner } = env;
  // ── K1：已是伴生的目标模型 comp；控制组用普通模型（一个模型同时只能有一个未归档任务，每个控制各用一个）
  const parent = await fx.model({ layer: 'DWD', status: 'REVIEWING' });
  const comp = await fx.model({ layer: 'DWD', status: 'CREATED', config_mode: 'companion', companion_of: parent });
  const ctl = {};
  for (const k of ['create', 'update', 'batch', 'quick']) ctl[k] = await fx.model({ layer: 'DWD', status: 'CREATED' });
  const updTask = await fx.task({ status: 'OPEN', category: 'DWD_DEV' });
  const updCtlTask = await fx.task({ status: 'OPEN', category: 'DWD_DEV' });
  // ── K2：edit-script 文件名
  const k2WithPath = await fx.model({ layer: 'DWD', status: 'DEVELOPING', script_path: 'mc_k2/with_path' });
  const k2NoPath = await fx.model({ layer: 'DWD', status: 'DEVELOPING', script_path: null });
  // ── K3：矩阵（期望手写成表；confirm 的非管理员分支未改，矩阵以它的现行逻辑为准——见 deviation 标注）
  const PASS_ODS = [{ phase: null }];
  const PASS_2P = [{ phase: 'structure' }, { phase: 'data' }];
  const cells = [
    { n: 'ODS×owner×ODS_SYNC（验收 pass）', layer: 'ODS', cat: 'ODS_SYNC', role: 'owner', recs: PASS_ODS, want: true },
    { n: 'ODS×owner×ODS_SYNC（无验收记录）', layer: 'ODS', cat: 'ODS_SYNC', role: 'owner', recs: [], want: false },
    { n: 'ODS×owner×DWD_DEV（验收 pass）', layer: 'ODS', cat: 'DWD_DEV', role: 'owner', recs: PASS_ODS, want: false, deny: true },
    { n: 'ODS×admin×ODS_SYNC（无验收记录，管理员旁路）', layer: 'ODS', cat: 'ODS_SYNC', role: 'admin', recs: [], want: true },
    { n: 'ODS×admin×DWD_DEV（无验收记录，管理员旁路）', layer: 'ODS', cat: 'DWD_DEV', role: 'admin', recs: [], want: true },
    { n: 'DIM×owner×DIM_DEV（结构+数据 pass）', layer: 'DIM', cat: 'DIM_DEV', role: 'owner', recs: PASS_2P, want: false, deny: true },
    // N2：非管理员 + ODS_SYNC 任务关联 DIM / DWD 模型——evaluateModelAcceptance 按模型 layer 分派规则，走两阶段真值表（deviation：confirm 现行非管理员逻辑只看 category，不按 layer 硬拒）
    ...['DIM', 'DWD'].flatMap(L => [
      { n: `${L}×owner×ODS_SYNC（仅 structure pass、无 data；两阶段规则 → 拒绝）`, layer: L, cat: 'ODS_SYNC', role: 'owner', recs: [{ phase: 'structure' }], want: false },
      { n: `${L}×owner×ODS_SYNC（仅 data pass、无 structure；两阶段规则 → 拒绝）`, layer: L, cat: 'ODS_SYNC', role: 'owner', recs: [{ phase: 'data' }], want: false },
      { n: `${L}×owner×ODS_SYNC（structure + data 均 pass → 允许；正式口径：兼容既有 confirm 语义，按该模型两阶段规则判定）`, layer: L, cat: 'ODS_SYNC', role: 'owner', recs: PASS_2P, want: true },
      { n: `${L}×owner×ODS_SYNC（只有一条无 phase 的 ODS 形态记录 → 拒绝）`, layer: L, cat: 'ODS_SYNC', role: 'owner', recs: PASS_ODS, want: false },
    ]),
    { n: 'DIM×admin（stale）', layer: 'DIM', cat: 'DIM_DEV', role: 'admin', rev: 2, recs: [{ phase: 'structure', rev: 1 }, { phase: 'data', rev: 1 }], want: false },
    { n: 'DIM×admin（无验收记录）', layer: 'DIM', cat: 'DIM_DEV', role: 'admin', recs: [], want: false },
    { n: 'DIM×admin（pass）', layer: 'DIM', cat: 'DIM_DEV', role: 'admin', recs: PASS_2P, want: true },
    { n: 'DWD×admin×DATA_FIX（pass）', layer: 'DWD', cat: 'DATA_FIX', role: 'admin', recs: PASS_2P, want: true },
    { n: 'DWS×owner×ODS_SYNC（无判定规则）', layer: 'DWS', cat: 'ODS_SYNC', role: 'owner', recs: [], want: false },
    { n: 'DWS×owner×DWD_DEV', layer: 'DWS', cat: 'DWD_DEV', role: 'owner', recs: [], want: false, deny: true },
    { n: 'DWS×admin×DWD_DEV', layer: 'DWS', cat: 'DWD_DEV', role: 'admin', recs: [], want: true },
    { n: 'ADS×admin×ADS_RPT', layer: 'ADS', cat: 'ADS_RPT', role: 'admin', recs: [], want: true },
    { n: '无关联×owner×ODS_SYNC', noLink: true, cat: 'ODS_SYNC', role: 'owner', recs: [], want: false, deny: true },
    { n: '无关联×admin×DWD_DEV', noLink: true, cat: 'DWD_DEV', role: 'admin', recs: [], want: true },
    { n: '关联模型已删×admin×DWD_DEV（显式例外：管理员对已删模型不执行验收门禁，无模型可保护）', layer: 'DWD', cat: 'DWD_DEV', role: 'admin', recs: [], deleted: true, want: true },
  ];
  for (const c of cells) {
    const modelId = c.noLink ? null : await fx.model({ layer: c.layer, status: 'REVIEWING', config_rev: c.rev || 1, is_deleted: c.deleted ? 1 : 0 });
    if (modelId) for (const r of c.recs) await fx.record(modelId, { phase: r.phase, result: 'pass', time: K_REC_TIME, rev: r.rev === undefined ? (c.rev || 1) : r.rev });
    c.modelId = modelId;
    c.taskId = await fx.task({ status: 'DONE', category: c.cat, linked_model_id: modelId, owner: owner.display_name, owner_id: owner.id, created_at: K_CREATED, done_at: K_CREATED });
  }
  // ── L1：归档期间关联模型被转成伴生，reopen 不得让任务复活（夹具直接造「已归档任务挂在伴生模型上」）
  const l1 = {};
  for (const [k, target] of [['toOpen', 'OPEN'], ['toClaimed', 'CLAIMED']]) {
    const par = await fx.model({ layer: 'DWD', status: 'ONLINE' });
    const cm = await fx.model({ layer: 'DWD', status: 'ONLINE', config_mode: 'companion', companion_of: par });
    l1[k] = { target, modelId: cm, taskId: await fx.task({ status: 'ARCHIVED', category: 'DWD_DEV', linked_model_id: cm, owner: owner.display_name, owner_id: owner.id }) };
  }
  const l1ctlModel = await fx.model({ layer: 'DWD', status: 'ONLINE' });
  l1.control = { modelId: l1ctlModel, taskId: await fx.task({ status: 'ARCHIVED', category: 'DWD_DEV', linked_model_id: l1ctlModel, owner: owner.display_name, owner_id: owner.id }) };
  // ── L5：任务（已归档）历史上就挂着伴生，只改标题等字段、关联不变 → 200
  const l5par = await fx.model({ layer: 'DWD', status: 'ONLINE' });
  const l5comp = await fx.model({ layer: 'DWD', status: 'ONLINE', config_mode: 'companion', companion_of: l5par });
  const l5 = { modelId: l5comp, taskId: await fx.task({ status: 'ARCHIVED', category: 'DWD_DEV', linked_model_id: l5comp, owner: owner.display_name, owner_id: owner.id, title: 'l5 原标题' }) };
  // ── N4：未归档（CLAIMED）任务夹具里直接挂在伴生上，只改标题（关联未改）仍须 400
  const n4par = await fx.model({ layer: 'DWD', status: 'ONLINE' });
  const n4comp = await fx.model({ layer: 'DWD', status: 'ONLINE', config_mode: 'companion', companion_of: n4par });
  const n4 = { modelId: n4comp, taskId: await fx.task({ status: 'CLAIMED', category: 'DWD_DEV', linked_model_id: n4comp, owner: owner.display_name, owner_id: owner.id, title: 'n4 原标题' }) };
  // ── L4：owner 视角 ODS 拒绝分支的 reason / state / gatePass（期望手写；ODS×owner×ODS_SYNC）
  const BEFORE = '2026-03-10 11:59:59';
  const l4cells = [
    { n: '无验收记录', recs: [], state: 'none', cs: '关联模型尚未进行自测', at: '尚未进行自测' },
    { n: '验收 fail', recs: [{ result: 'fail', time: K_REC_TIME }], state: 'fail', cs: '关联模型最近一次自测未通过', at: '最近一次自测未通过' },
    { n: '配置已变更（stale）', rev: 2, recs: [{ result: 'pass', time: K_REC_TIME, rev: 1 }], state: 'stale', cs: '模型配置在最近一次验收之后已变更，请重新验收', at: '模型配置在最近一次验收之后已变更，请重新验收' },
    { n: '验收早于任务', recs: [{ result: 'pass', time: BEFORE }], state: 'none', cs: '当前版本的验收记录早于任务创建时间，请重新验收', at: '当前版本的验收记录早于任务创建时间，请重新验收' },
    { n: '验收与任务同秒', recs: [{ result: 'pass', time: K_CREATED }], state: 'none', cs: '验收时间与任务创建时间在同一秒，请重新验收', at: '验收时间与任务创建时间在同一秒，请重新验收' },
  ];
  for (const c of l4cells) {
    c.modelId = await fx.model({ layer: 'ODS', status: 'REVIEWING', config_rev: c.rev || 1 });
    for (const r of c.recs) await fx.record(c.modelId, { phase: null, result: r.result, time: r.time, rev: r.rev === undefined ? (c.rev || 1) : r.rev });
    c.taskId = await fx.task({ status: 'DONE', category: 'ODS_SYNC', linked_model_id: c.modelId, owner: owner.display_name, owner_id: owner.id, created_at: K_CREATED, done_at: K_CREATED });
  }
  return { comp, ctl, updTask, updCtlTask, k2WithPath, k2NoPath, cells, l1, l5, n4, l4cells };
}

async function runK(ctx) {
  const { api, rd, admin, owner, check, copyRoot } = ctx;
  const p = ctx.kPlan;
  const A = (method, url, body) => api(method, url, { token: admin.token, body });
  const cnt = async (sql, args) => (await rd.get(sql, args || [])).c;
  // ── K1
  const total0 = await cnt('SELECT COUNT(*) AS c FROM task_pool');
  const r1 = await A('POST', '/api/create', { title: 'k1 create 挂伴生', category: 'DWD_DEV', linked_model_id: p.comp });
  check('K1 create：挂到已是伴生的模型 → 400 且文案一致', r1.status === 400 && r1.json && r1.json.error === K1_TEXT, `${r1.status} ${r1.text.slice(0, 200)}`);
  check('K1 create：零写入（task_pool 总数不变、无任务关联该伴生）', await cnt('SELECT COUNT(*) AS c FROM task_pool') === total0 && await cnt('SELECT COUNT(*) AS c FROM task_pool WHERE linked_model_id = ?', [p.comp]) === 0, 'count changed');
  const r1c = await A('POST', '/api/create', { title: 'k1 create 对照', category: 'DWD_DEV', linked_model_id: p.ctl.create });
  check('K1 create 对照：挂普通模型 → 200 且任务写入', r1c.status === 200 && await cnt('SELECT COUNT(*) AS c FROM task_pool WHERE linked_model_id = ?', [p.ctl.create]) === 1, `${r1c.status} ${r1c.text.slice(0, 200)}`);
  const r2 = await A('POST', '/api/update', { id: p.updTask, title: 'k1 update 改标题', category: 'DWD_DEV', linked_model_id: p.comp });
  const t2 = await rd.get('SELECT title, linked_model_id FROM task_pool WHERE id = ?', [p.updTask]);
  check('K1 update：关联到已是伴生的模型 → 400 且文案一致', r2.status === 400 && r2.json && r2.json.error === K1_TEXT, `${r2.status} ${r2.text.slice(0, 200)}`);
  check('K1 update：零写入（linked_model_id 仍为空、标题未改）', t2.linked_model_id == null && t2.title !== 'k1 update 改标题', JSON.stringify(t2));
  const r2c = await A('POST', '/api/update', { id: p.updCtlTask, title: 'k1 update 对照', category: 'DWD_DEV', linked_model_id: p.ctl.update });
  const t2c = await rd.get('SELECT title, linked_model_id FROM task_pool WHERE id = ?', [p.updCtlTask]);
  check('K1 update 对照：关联普通模型 → 200 且写入', r2c.status === 200 && t2c.linked_model_id === p.ctl.update, `${r2c.status} ${r2c.text.slice(0, 200)} ${JSON.stringify(t2c)}`);
  const r3 = await A('POST', '/api/create/batch', [
    { title: 'k1 batch 挂伴生', desc: 'd', category: 'DWD_DEV', linked_model_id: p.comp },
    { title: 'k1 batch 对照', desc: 'd', category: 'DWD_DEV', linked_model_id: p.ctl.batch },
  ]);
  check('K1 batch：挂伴生的一条计失败、对照一条成功（success=1 failed=1）', r3.status === 200 && r3.json && r3.json.success === 1 && r3.json.failed === 1, `${r3.status} ${r3.text.slice(0, 200)}`);
  check('K1 batch：零写入（无任务关联该伴生）、对照任务已关联', await cnt('SELECT COUNT(*) AS c FROM task_pool WHERE linked_model_id = ?', [p.comp]) === 0 && await cnt('SELECT COUNT(*) AS c FROM task_pool WHERE linked_model_id = ?', [p.ctl.batch]) === 1, 'count wrong');
  const r4 = await A('POST', `/api/models/${p.comp}/quick-submit`, {});
  const m4 = await rd.get('SELECT status FROM data_models WHERE id = ?', [p.comp]);
  check('K1 quick-submit：伴生模型 → 400 且文案一致', r4.status === 400 && r4.json && r4.json.error === K1_TEXT, `${r4.status} ${r4.text.slice(0, 200)}`);
  check('K1 quick-submit：零写入（无任务关联该伴生、模型状态不变）', await cnt('SELECT COUNT(*) AS c FROM task_pool WHERE linked_model_id = ?', [p.comp]) === 0 && m4.status === 'CREATED', JSON.stringify(m4));
  const r4c = await A('POST', `/api/models/${p.ctl.quick}/quick-submit`, {});
  check('K1 quick-submit 对照：普通 CREATED 模型 → 200 且任务写入', r4c.status === 200 && await cnt('SELECT COUNT(*) AS c FROM task_pool WHERE linked_model_id = ?', [p.ctl.quick]) === 1, `${r4c.status} ${r4c.text.slice(0, 200)}`);
  // ── K2
  const dirWith = path.join(copyRoot, 'uploads', 'mc_k2', 'with_path');
  const rev = async (id) => (await rd.get('SELECT config_rev, script_path FROM data_models WHERE id = ?', [id]));
  for (const [fn, label] of [['12_sql_script_20260301.sql', '附件命名 .sql'], ['5_mapping_20260301.xlsx', '附件命名 .xlsx（任意扩展名）'], ['7_result_script_20261001.txt', '附件命名 .txt']]) {
    const b0 = await rev(p.k2WithPath);
    const r = await A('PUT', `/api/models/${p.k2WithPath}/edit-script`, { fileName: fn, content: 'SELECT 1;' });
    const b1 = await rev(p.k2WithPath);
    check(`K2 edit-script ${label}：400 且文案一致`, r.status === 400 && r.json && r.json.error === K2_TEXT, `${r.status} ${r.text.slice(0, 200)}`);
    check(`K2 edit-script ${label}：零写入（config_rev 不变、文件未创建）`, b1.config_rev === b0.config_rev && !fs.existsSync(path.join(dirWith, fn)), `${JSON.stringify(b0)} → ${JSON.stringify(b1)} exists=${fs.existsSync(path.join(dirWith, fn))}`);
  }
  {
    const r = await A('PUT', `/api/models/${p.k2NoPath}/edit-script`, { fileName: '12_sql_script_20260301.sql', content: 'SELECT 1;' });
    const b = await rev(p.k2NoPath);
    check('K2 edit-script 附件命名 + script_path 为空：400 且 script_path 仍为空（拒绝先于回填目录的写入）', r.status === 400 && r.json && r.json.error === K2_TEXT && b.script_path == null, `${r.status} ${r.text.slice(0, 200)} ${JSON.stringify(b)}`);
  }
  for (const fn of ['k2_ok.sql', '12_sql_script_2026030.sql', 'abc_sql_script_20260301.sql', '12_sql_script_20260301.sql.bak']) {
    const r = await A('PUT', `/api/models/${p.k2WithPath}/edit-script`, { fileName: fn, content: 'SELECT 2;' });
    check(`K2 edit-script 对照 ${fn}：不与附件命名同形 → 200 且文件已创建`, r.status === 200 && r.json && r.json.success === true && fs.existsSync(path.join(dirWith, fn)), `${r.status} ${r.text.slice(0, 200)}`);
  }
  // ── K3：三接口（can-self-archive / archivable-task / confirm）对同一格的结论一致；期望来自 planK 里手写的表
  for (const c of p.cells) {
    const who = c.role === 'admin' ? admin : owner;
    const name = `K3 ${c.n}`;
    const cs = await api('GET', `/api/tasks/${c.taskId}/can-self-archive`, { token: who.token });
    check(`${name}：can-self-archive.canSelfArchive === ${c.want}`, cs.json && cs.json.canSelfArchive === c.want, JSON.stringify(cs.json));
    if (c.deny) check(`${name}：can-self-archive 原因「需管理员归档」`, cs.json && cs.json.reason === '需管理员归档', JSON.stringify(cs.json));
    if (!c.noLink) {
      const at = await api('GET', `/api/models/${c.modelId}/archivable-task`, { token: who.token });
      check(`${name}：archivable-task.canSelfArchive === ${c.want}`, at.json && at.json.found === true && at.json.canSelfArchive === c.want, JSON.stringify(at.json));
      if (c.deny) check(`${name}：archivable-task 原因「需管理员归档」`, at.json && at.json.reason === '需管理员归档', JSON.stringify(at.json));
    }
    const cf = await api('POST', '/api/confirm', { token: who.token, body: { id: c.taskId } });
    const st = (await rd.get('SELECT status FROM task_pool WHERE id = ?', [c.taskId])).status;
    check(`${name}：confirm ${c.want ? '200 且任务归档' : '403 且任务仍为 DONE'}`, c.want ? (cf.status === 200 && st === 'ARCHIVED') : (cf.status === 403 && st === 'DONE'), `${cf.status} ${cf.text.slice(0, 200)} status=${st}`);
  }
  // ── L1：reopen（ARCHIVED → OPEN / CLAIMED）关联模型已是伴生 → 400、状态不变；对照：关联普通模型照常
  const L1_TEXT = '关联模型已成为伴生表，请先在归档状态下改关联主表模型后再退回';
  const taskSt = async (id) => (await rd.get('SELECT status, owner_id FROM task_pool WHERE id = ?', [id]));
  for (const k of ['toOpen', 'toClaimed']) {
    const it = p.l1[k];
    const r = await A('POST', '/api/reopen', { id: it.taskId, targetStatus: it.target, reason: 'l1', reasonType: 'other' });
    const s = await taskSt(it.taskId);
    check(`L1 reopen：已归档任务的关联模型已是伴生，退回到 ${it.target} → 400 且文案一致`, r.status === 400 && r.json && r.json.error === L1_TEXT, `${r.status} ${r.text.slice(0, 200)}`);
    check(`L1 reopen：退回到 ${it.target} 被拒后任务状态仍为 ARCHIVED、owner 未清`, s.status === 'ARCHIVED' && s.owner_id === owner.id, JSON.stringify(s));
  }
  const rc = await A('POST', '/api/reopen', { id: p.l1.control.taskId, targetStatus: 'OPEN', reason: 'l1 对照', reasonType: 'other' });
  check('L1 reopen 对照：关联普通模型的已归档任务退回到 OPEN → 200 且状态为 OPEN', rc.status === 200 && (await taskSt(p.l1.control.taskId)).status === 'OPEN', `${rc.status} ${rc.text.slice(0, 200)}`);
  // ── L2：edit-script 拒绝 NTFS 备用数据流名与结尾 `.` / 空格（零写入）
  for (const fn of ['12_sql_script_20260301.sql::$DATA', 'a.sql:x', 'a.sql.', 'a.sql ']) {
    const b0 = await rev(p.k2WithPath);
    const r = await A('PUT', `/api/models/${p.k2WithPath}/edit-script`, { fileName: fn, content: 'SELECT 3;' });
    const b1 = await rev(p.k2WithPath);
    const listing = fs.existsSync(dirWith) ? fs.readdirSync(dirWith) : [];
    check(`L2 edit-script ${JSON.stringify(fn)}：400「文件名不合法」且零写入（config_rev 不变、目录无 a.sql / 同名文件）`, r.status === 400 && r.json && r.json.error === '文件名不合法' && b1.config_rev === b0.config_rev && !listing.includes('a.sql') && !listing.includes('12_sql_script_20260301.sql'), `${r.status} ${r.text.slice(0, 200)} ${JSON.stringify(b0)} → ${JSON.stringify(b1)} ${JSON.stringify(listing)}`);
  }
  // ── L5：关联未改时不触发伴生检查
  const u5 = await A('POST', '/api/update', { id: p.l5.taskId, title: 'l5 新标题', category: 'DWD_DEV', linked_model_id: p.l5.modelId });
  const t5 = await rd.get('SELECT title, linked_model_id FROM task_pool WHERE id = ?', [p.l5.taskId]);
  check('L5 update：任务历史上挂着伴生、只改标题（关联不变）→ 200 且标题已改、关联不变', u5.status === 200 && t5.title === 'l5 新标题' && t5.linked_model_id === p.l5.modelId, `${u5.status} ${u5.text.slice(0, 200)} ${JSON.stringify(t5)}`);
  // ── N4：未归档任务关联未改也不豁免
  const u6 = await A('POST', '/api/update', { id: p.n4.taskId, title: 'n4 新标题', category: 'DWD_DEV', linked_model_id: p.n4.modelId });
  const t6 = await rd.get('SELECT title, linked_model_id FROM task_pool WHERE id = ?', [p.n4.taskId]);
  check('N4 update：CLAIMED 任务挂着伴生、只改标题（关联不变）→ 400 且文案一致、标题未改', u6.status === 400 && u6.json && u6.json.error === K1_TEXT && t6.title === 'n4 原标题' && t6.linked_model_id === p.n4.modelId, `${u6.status} ${u6.text.slice(0, 200)} ${JSON.stringify(t6)}`);
  // ── L4：owner 视角 ODS 拒绝分支（can-self-archive / archivable-task）reason / state / gatePass 全等
  for (const c of p.l4cells) {
    const cs = await api('GET', `/api/tasks/${c.taskId}/can-self-archive`, { token: owner.token });
    check(`L4 owner can-self-archive（${c.n}）：canSelfArchive=false、reason / state / gatePass 全等`, cs.json && cs.json.canSelfArchive === false && cs.json.reason === c.cs && cs.json.state === c.state && cs.json.gatePass === false, JSON.stringify(cs.json));
    const at = await api('GET', `/api/models/${c.modelId}/archivable-task`, { token: owner.token });
    check(`L4 owner archivable-task（${c.n}）：canSelfArchive=false、reason / state / gatePass 全等`, at.json && at.json.found === true && at.json.canSelfArchive === false && at.json.reason === c.at && at.json.state === c.state && at.json.gatePass === false, JSON.stringify(at.json));
  }
}

// ───────── N1：判定与归档写入之间的并发窗口（副本里注入 await 点，见 runSuite 的 injectConfirm；正式代码无钩子）─────────
const N1_TEXT = '验收状态在归档过程中发生变化，请刷新后重试';
const R5_TEXT = '模型状态在判定过程中发生变化，请刷新后重试';
async function planN1(env) {
  const { fx, owner } = env;
  const cells = [];
  await fx.model({ layer: 'DWS', status: 'ONLINE' });   // 备用模型（无未归档任务）：INJECT_LINK 把任务改挂到它
  const mk = async (n, layer, cat, role, mark, want, gated, deleted) => {
    const modelId = await fx.model({ layer, status: 'REVIEWING', is_deleted: deleted ? 1 : 0 });
    if (layer === 'ODS') await fx.record(modelId, { phase: null, result: 'pass', time: K_REC_TIME });
    else { await fx.record(modelId, { phase: 'structure', result: 'pass', time: K_REC_TIME }); await fx.record(modelId, { phase: 'data', result: 'pass', time: K_REC_TIME }); }
    const taskId = await fx.task({ status: 'DONE', category: cat, linked_model_id: modelId, owner: owner.display_name, owner_id: owner.id, created_at: K_CREATED, done_at: K_CREATED });
    cells.push({ n, role, mark, want, gated, modelId, taskId });
  };
  await mk('配置变更(REV)×DIM×admin', 'DIM', 'DIM_DEV', 'admin', 'INJECT_REV', 409, true);
  await mk('新 fail 记录(FAIL)×DIM×admin', 'DIM', 'DIM_DEV', 'admin', 'INJECT_FAIL', 409, true);
  await mk('配置变更(REV)×ODS×owner', 'ODS', 'ODS_SYNC', 'owner', 'INJECT_REV', 409, true);
  await mk('新 fail 记录(FAIL)×ODS×owner', 'ODS', 'ODS_SYNC', 'owner', 'INJECT_FAIL', 409, true);
  await mk('记录被置失效(INV，另一归档任务被退回)×DIM×admin', 'DIM', 'DIM_DEV', 'admin', 'INJECT_INV', 409, true);
  await mk('记录被置失效(INV)×ODS×owner', 'ODS', 'ODS_SYNC', 'owner', 'INJECT_INV', 409, true);
  await mk('对照：无注入×DIM×admin（钩子对其他请求惰性）', 'DIM', 'DIM_DEV', 'admin', 'NONE', 200, true);
  await mk('对照：无注入×ODS×owner', 'ODS', 'ODS_SYNC', 'owner', 'NONE', 200, true);
  // R1 任务字段（判定输入在写入时须未变）
  await mk('任务字段(CAT)×ODS×owner：判定后 category ODS_SYNC → DATA_FIX', 'ODS', 'ODS_SYNC', 'owner', 'INJECT_CAT', 409, true);
  await mk('任务字段(CAT)×DIM×admin', 'DIM', 'DIM_DEV', 'admin', 'INJECT_CAT', 409, true);
  await mk('任务字段(LINK)×DIM×admin：判定后 linked_model_id 改挂别的模型', 'DIM', 'DIM_DEV', 'admin', 'INJECT_LINK', 409, true);
  await mk('任务字段(CREATED)×ODS×admin（旁路）：判定后 created_at 被改', 'ODS', 'ODS_SYNC', 'admin', 'INJECT_CREATED', 409, false);
  await mk('任务字段(OWNER)×DIM×admin（过门禁）：判定后 owner_id 被改', 'DIM', 'DIM_DEV', 'admin', 'INJECT_OWNER', 409, true);
  await mk('任务字段(OWNER)×ODS×admin（旁路）：判定后 owner_id 被改', 'ODS', 'ODS_SYNC', 'admin', 'INJECT_OWNER', 409, false);
  await mk('任务字段(OWNER)×ODS×owner（过门禁）：判定后 owner_id 被改', 'ODS', 'ODS_SYNC', 'owner', 'INJECT_OWNER', 409, true);
  {
    // 判定时关联模型行不存在（夹具直接把 linked_model_id 指向不存在的 id），判定后写入前插入该 id 的模型行 → 409（覆盖「模型行不存在」分支）
    const missingId = 987654;
    const taskId = await fx.task({ status: 'DONE', category: 'ODS_SYNC', linked_model_id: missingId, owner: owner.display_name, owner_id: owner.id, created_at: K_CREATED, done_at: K_CREATED });
    cells.push({ n: '模型字段(MISSING)×不存在的关联模型×admin（判定后插入该 id 的模型行）', role: 'admin', mark: 'INJECT_MKMODEL', want: 409, gated: false, modelId: missingId, taskId, missing: true });
  }
  // R2 模型字段（不论是否走验收门禁）
  await mk('模型字段(DEL)×ODS×admin（旁路）：判定后模型被软删', 'ODS', 'ODS_SYNC', 'admin', 'INJECT_DEL', 409, false);
  await mk('模型字段(RESTORE)×已删 ODS 模型×admin（显式例外分支）：判定后模型被恢复', 'ODS', 'ODS_SYNC', 'admin', 'INJECT_RESTORE', 409, false, true);
  await mk('模型字段(COMP)×ODS×admin（旁路）：判定后模型被转为伴生', 'ODS', 'ODS_SYNC', 'admin', 'INJECT_COMP', 409, false);
  await mk('模型字段(COMP)×DIM×admin（过门禁）', 'DIM', 'DIM_DEV', 'admin', 'INJECT_COMP', 409, true);
  await mk('模型字段(LAYER)×ODS→DIM×admin（旁路）：判定后 layer 改为 DIM', 'ODS', 'ODS_SYNC', 'admin', 'INJECT_LAYER', 409, false);
  await mk('管理员 ODS 旁路（不过门禁，锁任务行与模型行，不锁验收快照）：注入配置变更仍归档', 'ODS', 'ODS_SYNC', 'admin', 'INJECT_REV', 200, false);
  // 23-R5：判定内两次读之间模型行变化（linkedModelLayer 选分支 → evaluateModelAcceptance 判定）→ 一律拒绝（403 + 变化文案），任务仍 DONE
  await mk('判定内读不一致(LAYER)×DIM→ODS×admin：两次读之间 layer 改为 ODS 且有一条 ODS 通过记录', 'DIM', 'DIM_DEV', 'admin', 'INJECT_R5_LAYER', 403, true);
  await mk('判定内读不一致(COMP)×DIM×admin：两次读之间被转为伴生', 'DIM', 'DIM_DEV', 'admin', 'INJECT_R5_COMP', 403, true);
  await mk('判定内读不一致(DEL)×DIM×admin：两次读之间被软删', 'DIM', 'DIM_DEV', 'admin', 'INJECT_R5_DEL', 403, true);
  return cells;
}
async function runN1(ctx) {
  const { api, rd, admin, owner, check } = ctx;
  for (const c of ctx.n1Plan) {
    const who = c.role === 'admin' ? admin : owner;
    const m0row = await rd.get('SELECT status FROM data_models WHERE id = ?', [c.modelId]);
    const m0 = c.missing ? 'DEVELOPING' : m0row.status;   // missing：判定时模型行不存在，注入后才出现（夹具状态 DEVELOPING）；归档若误成功会被联动改成 ONLINE
    const r = await api('POST', '/api/confirm', { token: who.token, body: { id: c.taskId, review_note: c.mark } });
    const st = (await rd.get('SELECT status FROM task_pool WHERE id = ?', [c.taskId])).status;
    const m1 = (await rd.get('SELECT status FROM data_models WHERE id = ?', [c.modelId])).status;
    if (c.want === 403) {
      check(`N1 ${c.n}：→ 403 且回显「模型状态在判定过程中发生变化，请刷新后重试」`, r.status === 403 && r.json && r.json.error === R5_TEXT && r.json.gatePass === false, `${r.status} ${r.text.slice(0, 200)}`);
      check(`N1 ${c.n}：零写入（任务仍为 DONE、模型状态不变）`, st === 'DONE' && m1 === m0, `task=${st} model ${m0} → ${m1}`);
    } else if (c.want === 409) {
      check(`N1 ${c.n}：判定后写入前状态变化 → 409「验收状态在归档过程中发生变化，请刷新后重试」`, r.status === 409 && r.json && r.json.error === N1_TEXT, `${r.status} ${r.text.slice(0, 200)}`);
      check(`N1 ${c.n}：零写入（任务仍为 DONE、模型状态不变）`, st === 'DONE' && m1 === m0, `task=${st} model ${m0} → ${m1}`);
    } else {
      check(`N1 ${c.n}：200 且任务归档`, r.status === 200 && st === 'ARCHIVED', `${r.status} ${r.text.slice(0, 200)} status=${st}`);
    }
  }
}

// ───────── N3：时区就绪屏障（副本里注入：自检先暂停、前两次尝试失败，见 runSuite 的 tzRetry）─────────
async function planTzr(env) {
  const { fx, owner } = env;
  const modelId = await fx.model({ layer: 'ODS', status: 'REVIEWING' });
  await fx.record(modelId, { phase: null, result: 'pass', time: K_REC_TIME });
  const taskId = await fx.task({ status: 'DONE', category: 'ODS_SYNC', linked_model_id: modelId, owner: owner.display_name, owner_id: owner.id, created_at: K_CREATED, done_at: K_CREATED });
  return { modelId, taskId };
}
async function runTzr(ctx) {
  const { api, owner, admin, check, svc } = ctx;
  const p = ctx.tzrPlan;
  const UNKNOWN = '服务启动中，归档门禁暂不可用，请稍后重试';
  const readLog = () => fs.readFileSync(svc.inst.logPath, 'utf8');
  const cs0 = await api('GET', `/api/tasks/${p.taskId}/can-self-archive`, { token: owner.token });
  check('N3 自检未完成期间首个门禁请求（can-self-archive）：拒绝且文案为「服务启动中」、state=none、gatePass=false', cs0.json && cs0.json.canSelfArchive === false && cs0.json.reason === UNKNOWN && cs0.json.state === 'none' && cs0.json.gatePass === false, JSON.stringify(cs0.json));
  const at0 = await api('GET', `/api/models/${p.modelId}/archivable-task`, { token: owner.token });
  check('N3 自检未完成期间 archivable-task：拒绝且文案为「服务启动中」', at0.json && at0.json.found === true && at0.json.canSelfArchive === false && at0.json.reason === UNKNOWN, JSON.stringify(at0.json));
  const cf0 = await api('POST', '/api/confirm', { token: owner.token, body: { id: p.taskId } });
  check('N3 自检未完成期间 confirm：403 且文案为「服务启动中」', cf0.status === 403 && cf0.json && cf0.json.error === UNKNOWN, `${cf0.status} ${cf0.text.slice(0, 200)}`);
  const vs0 = await api('GET', `/api/models/${p.modelId}/validation-status`, { token: admin.token });
  check('N3 自检未完成期间不带任务的 validation-status 不受影响（state=pass）', vs0.json && vs0.json.state === 'pass' && vs0.json.gatePass === true, JSON.stringify(vs0.json));
  fs.writeFileSync(ctx.holdFile, 'go');   // 放行：自检第 1 次尝试失败 → 1s → 第 2 次失败 → 2s → 第 3 次成功
  const ok = await waitFor(() => /时区一致性自检通过（第 3 次）/.test(readLog()), 20000, 100);
  check('N3 自检首两次失败、第三次成功：日志出现「自检通过（第 3 次）」且前两次失败各有记录', !!ok && /第 1 次失败/.test(readLog()) && /第 2 次失败/.test(readLog()), readLog().slice(-500));
  const cs1 = await api('GET', `/api/tasks/${p.taskId}/can-self-archive`, { token: owner.token });
  check('N3 自检最终 ok 后门禁放行（can-self-archive = true）', cs1.json && cs1.json.canSelfArchive === true, JSON.stringify(cs1.json));
  const cf1 = await api('POST', '/api/confirm', { token: owner.token, body: { id: p.taskId } });
  check('N3 自检最终 ok 后 confirm 200', cf1.status === 200, `${cf1.status} ${cf1.text.slice(0, 200)}`);
}

// ───────── R4：加载时 JS 时区检测抛异常 → 保持 unknown（不直接 mismatch），SQLite 自检通过后 ok、门禁放行（副本注入，见 runSuite 的 tzJsFail）─────────
async function runTzjs(ctx) {
  const { api, owner, check, svc } = ctx;
  const p = ctx.tzjsPlan;
  const log = fs.readFileSync(svc.inst.logPath, 'utf8');
  check('R4 JS 检测异常：日志出现「JS 时区检测不可用…保持 unknown，由 SQLite 自检定性」且没有 [TZ-MISMATCH] 告警', /JS 时区检测不可用.*保持 unknown/.test(log) && !/\[TZ-MISMATCH\]/.test(log), log.slice(-500));
  check('R4 JS 检测异常：SQLite 自检通过（日志「自检通过」）', /时区一致性自检通过（第 1 次）/.test(log), log.slice(-500));
  const cs = await api('GET', `/api/tasks/${p.taskId}/can-self-archive`, { token: owner.token });
  check('R4 JS 检测异常：自检通过后门禁放行（can-self-archive = true）', cs.json && cs.json.canSelfArchive === true, JSON.stringify(cs.json));
  const cf = await api('POST', '/api/confirm', { token: owner.token, body: { id: p.taskId } });
  check('R4 JS 检测异常：自检通过后 confirm 200', cf.status === 200, `${cf.status} ${cf.text.slice(0, 200)}`);
}

// ───────── G1：时区不一致实例（TZ=UTC）——带任务时间条件的三处门禁一律拒绝 ─────────
const TZ_TEXT = '服务器时区与北京时间不一致，归档门禁的时间判断不可靠，已暂停按验收归档，请联系管理员';   // 手写期望
async function runTz(ctx) {
  const { api, rd, admin, owner, check, svc } = ctx;
  const taskStatus = async (taskId) => (await rd.get('SELECT status FROM task_pool WHERE id = ?', [taskId])).status;
  // N3：自检查询失败按 1s / 2s / 4s 退避重试 3 次后才置 mismatch——先等「自检失败，按时区不一致处理」落日志（重试期间状态是 unknown，门禁同样拒绝但文案是「服务启动中」，由 N3 用例另测）
  if (ctx.tzBroken) await waitFor(() => /时区一致性自检失败，按时区不一致处理/.test(fs.readFileSync(svc.inst.logPath, 'utf8')), 25000, 100);
  for (const it of ctx.tzPlan) {
    const name = `${ctx.tzBroken ? 'K4 自检SQL报错（时区钉北京时间）' : 'G1 TZ=UTC'} ${it.t}（${it.kind.toUpperCase()}，验收晚于任务）`;
    const reader = it.kind === 'ods' ? owner : admin;   // K3：ODS 门禁只对非管理员 owner 生效
    if (it.t === 'cs') {
      const r = await api('GET', `/api/tasks/${it.taskId}/can-self-archive`, { token: reader.token });
      check(`${name}：can-self-archive 拒绝且文案为时区不一致`, r.json && r.json.canSelfArchive === false && r.json.reason === TZ_TEXT && r.json.gatePass === false && r.json.state === 'none', JSON.stringify(r.json));   // L4：state 手写期望 'none'（TZ 不一致时判定结果为 none + 时区原因）
    } else if (it.t === 'at') {
      const r = await api('GET', `/api/models/${it.modelId}/archivable-task`, { token: reader.token });
      check(`${name}：archivable-task 拒绝且文案为时区不一致`, r.json && r.json.found === true && r.json.canSelfArchive === false && r.json.reason === TZ_TEXT && r.json.state === 'none' && r.json.gatePass === false, JSON.stringify(r.json));
    } else {
      const who = it.t === 'cf-owner' ? owner : admin;
      const r = await api('POST', '/api/confirm', { token: who.token, body: { id: it.taskId } });
      check(`${name}：confirm 的验收分支 403、文案为时区不一致、任务仍为 DONE`, r.status === 403 && r.json && r.json.error === TZ_TEXT && await taskStatus(it.taskId) === 'DONE', `${r.status} ${r.text.slice(0, 200)}`);
    }
  }
  // 不带任务的展示接口不受影响：任意一个 pass 模型 validation-status 仍 state=pass
  const any = ctx.tzPlan.find(x => x.kind === 'ods');
  const vs = await api('GET', `/api/models/${any.modelId}/validation-status`, { token: admin.token });
  const tzTag = ctx.tzBroken ? 'K4 自检SQL报错' : 'G1 TZ=UTC';
  check(`${tzTag}：不带任务的 validation-status 展示不受影响（state=pass, gatePass=true）`, vs.json && vs.json.state === 'pass' && vs.json.gatePass === true, JSON.stringify(vs.json));
  const log = fs.readFileSync(svc.inst.logPath, 'utf8');
  if (ctx.tzBroken) {
    check('K4 自检SQL报错：日志出现「自检失败，按时区不一致处理」且没有 [TZ-MISMATCH] 数值告警行（拒绝来自自检失败而非时区差）', /时区一致性自检失败，按时区不一致处理/.test(log) && !/\[TZ-MISMATCH\]/.test(log), log.slice(-400));
    return;
  }
  check('G1 TZ=UTC：F5 启动自检告警行 [TZ-MISMATCH] 出现，含两边取值与失真说明', /\[TZ-MISMATCH\].*SQLite datetime\('now','localtime'\)=\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}，JS 北京时间=\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}.*验收晚于任务创建/.test(log), log.slice(-400));
}

// ───────── §2b validation-status 的 state / gatePass 值断言（fail / none / partial / companion；期望手写）─────────
// gatePass 恒等于 state ∈ {pass, warn}：这四种不通过态的 gatePass 必须是布尔 false（不是缺键 / null / 0）
async function planStates(env) {
  const { fx } = env;
  const items = [];
  const odsFail = await fx.model({ layer: 'ODS', status: 'REVIEWING' });
  await fx.record(odsFail, { phase: null, result: 'fail' });
  items.push({ name: 'fail（ODS 最新一条 fail）', id: odsFail, state: 'fail', gatePass: false, layer: 'ODS' });
  const odsNone = await fx.model({ layer: 'ODS', status: 'REVIEWING' });
  items.push({ name: 'none（ODS 无验收记录）', id: odsNone, state: 'none', gatePass: false, layer: 'ODS' });
  const odsLower = await fx.model({ layer: 'ods', status: 'REVIEWING' });   // 库里存小写：响应的 layer 须是大写规范化值
  items.push({ name: 'none（ODS，layer 存库为小写 ods）', id: odsLower, state: 'none', gatePass: false, layer: 'ODS' });
  const dimPartial = await fx.model({ layer: 'DIM', status: 'REVIEWING' });
  await fx.record(dimPartial, { phase: 'structure', result: 'pass' });
  items.push({ name: 'partial（DIM 只有 structure pass、缺 data）', id: dimPartial, state: 'partial', gatePass: false, layer: 'DIM' });
  const parent = await fx.model({ layer: 'DWD', status: 'REVIEWING' });
  const comp = await fx.model({ layer: 'DWD', status: 'REVIEWING', config_mode: 'companion', companion_of: parent });
  await fx.record(comp, { phase: 'all', result: 'pass' });   // 伴生表即使有 pass 记录也不独立验收
  items.push({ name: 'companion（DWD 伴生表，带 pass 记录也不通过）', id: comp, state: 'companion', gatePass: false, layer: 'DWD' });
  return items;
}

async function runStates(ctx) {
  const { api, admin, check } = ctx;
  for (const it of ctx.statesPlan) {
    const r = await api('GET', `/api/models/${it.id}/validation-status`, { token: admin.token });
    check(`状态值 validation-status ${it.name}：state === '${it.state}' 且 gatePass === false（布尔）`,
      r.status === 200 && r.json && r.json.state === it.state && r.json.gatePass === it.gatePass, `${r.status} ${JSON.stringify(r.json)}`);
    check(`状态值 validation-status ${it.name}：响应含 layer === '${it.layer}'（大写规范化）`, r.json && r.json.layer === it.layer, JSON.stringify(r.json));
    const b = await api('GET', `/api/models/validation-status/batch?ids=${it.id}`, { token: admin.token });
    const node = b.json && b.json[String(it.id)];
    check(`状态值 validation-status/batch ${it.name}：state === '${it.state}' 且 gatePass === false（布尔）`,
      b.status === 200 && node && node.state === it.state && node.gatePass === it.gatePass, `${b.status} ${JSON.stringify(b.json)}`);
    check(`状态值 validation-status/batch ${it.name}：响应含 layer === '${it.layer}'（大写规范化）`, node && node.layer === it.layer, JSON.stringify(b.json));
  }
}

// ───────── §3 reopen ─────────
async function planReopen(env) {
  const { fx, owner } = env;
  const modelId = await fx.model({ layer: 'ODS', status: 'ONLINE' });
  const r1 = await fx.record(modelId, { phase: null, time: '2026-01-01 00:00:00' });
  const r2 = await fx.record(modelId, { phase: null, time: '2026-01-02 00:00:00', result: 'warn' });
  const archivedTask = await fx.task({ status: 'ARCHIVED', category: 'ODS_SYNC', linked_model_id: modelId, owner: owner.display_name, owner_id: owner.id, created_at: '2025-12-01 00:00:00' });
  // 对照组：同一任务形态、同样早于记录，但记录未失效的另一模型可放行（证明 reopen 后的拒绝来自 invalidated，不是别的）
  const ctrlModel = await fx.model({ layer: 'ODS', status: 'REVIEWING' });
  await fx.record(ctrlModel, { phase: null, time: '2026-01-01 00:00:00' });
  const ctrlTask = await fx.task({ status: 'DONE', category: 'ODS_SYNC', linked_model_id: ctrlModel, owner: owner.display_name, owner_id: owner.id, created_at: '2000-01-01 00:00:00', done_at: '2000-01-01 00:00:00' });
  return { modelId, r1, r2, archivedTask, ctrlTask };
}

async function runReopen(ctx) {
  const { api, admin, owner, check, svc, copyRoot } = ctx;
  const p = ctx.reopenPlan;
  const pre = await api('GET', `/api/models/${p.modelId}/validation-status`, { token: admin.token });
  check('reopen 前置：回退前当前版本记录使 state=warn（最新一条是 warn）', pre.json && pre.json.state === 'warn' && pre.json.gatePass === true, JSON.stringify(pre.json));
  const res = await api('POST', '/api/reopen', { token: admin.token, body: { id: p.archivedTask, targetStatus: 'OPEN', reason: 'mc 回退', reasonType: 'other' } });
  check('reopen：ARCHIVED → OPEN 返回 200', res.status === 200, `${res.status} ${res.text.slice(0, 200)}`);
  const rows = await ctx.rd.all('SELECT id, invalidated FROM model_test_records WHERE model_id = ?', [p.modelId]);
  check('reopen：该模型验收记录全部 invalidated = 1', rows.length === 2 && rows.every(x => x.invalidated === 1), JSON.stringify(rows));
  check('reopen：夹具里两条记录都在（r1 / r2）', rows.some(x => x.id === p.r1) && rows.some(x => x.id === p.r2));
  const post = await api('GET', `/api/models/${p.modelId}/validation-status`, { token: admin.token });
  check('reopen：回退后 state 不再是 pass / warn', post.json && !['pass', 'warn'].includes(post.json.state) && post.json.gatePass === false, JSON.stringify(post.json));

  // 「停服务 → 写库 → 重启」：回退后的旧任务（现为 OPEN；该模型同时只能有一个未归档任务，唯一索引 idx_task_pool_one_active_per_model）
  //   模拟「重新领取并提交」= 置回 DONE；其 created_at（2025-12-01）早于两条旧记录，排除「时间条件」干扰，只有 invalidated 能挡住
  await ctx.rd.close(); ctx.rd = null;
  await svc.stop();
  const w = await openWriter(svc.dbPath, svc.gate);
  try { await w.run("UPDATE task_pool SET status = 'DONE', owner = ?, owner_id = ?, done_at = '2026-02-01 00:00:00' WHERE id = ?", [owner.display_name, owner.id, p.archivedTask]); }
  finally { await w.close(); }
  void copyRoot;
  await svc.start();
  ctx.rd = await openReader(svc.dbPath);
  const g1 = await api('GET', `/api/tasks/${p.archivedTask}/can-self-archive`, { token: owner.token });   // K3：ODS 门禁只对非管理员 owner 生效
  check('reopen：再建任务不可凭旧记录归档（can-self-archive）', g1.json && g1.json.canSelfArchive === false, JSON.stringify(g1.json));
  const g2 = await api('POST', '/api/confirm', { token: owner.token, body: { id: p.archivedTask } });
  check('reopen：再建任务不可凭旧记录归档（confirm 403，任务仍为 DONE）', g2.status === 403 && (await ctx.rd.get('SELECT status FROM task_pool WHERE id = ?', [p.archivedTask])).status === 'DONE', `${g2.status} ${g2.text.slice(0, 200)}`);
  const g3 = await api('GET', `/api/tasks/${p.ctrlTask}/can-self-archive`, { token: owner.token });
  check('reopen 对照组：未失效的记录 + 同样早建的任务 → 可归档', g3.json && g3.json.canSelfArchive === true, JSON.stringify(g3.json));
}

// ───────────────────────────── 主流程 ─────────────────────────────
async function main() {
  if (!process.env.JWT_SECRET || !process.env.DB_ENCRYPTION_KEY) { console.log('FAIL 缺少 JWT_SECRET / DB_ENCRYPTION_KEY（读自 wbs-server/.env）'); process.exit(1); }
  let pass = 0, fail = 0;
  const count = (r) => { for (const x of r) { if (x.ok) pass++; else fail++; } };

  // 调试用过滤（缺省全跑）：--only=real,tz,tzBroken,n1,tzr,tzjs,h3x,h2x 只跑所列的基础套件（不带 --mut 时不跑变异）；--mut=<id,id> 只跑所列变异
  const argOf = (k) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3).split(',').filter(Boolean) : null; };
  const ONLY = argOf('only');
  const MUTF = argOf('mut');
  const want = (k) => !ONLY || ONLY.includes(k);
  // 收口批 2 LOW-6：过滤名拼错不得静默空转出绿——--only 的套件名必须在已知集合内（空值也不行），--mut 的变异名在变异清单建好后同样核对；未知一律 exit 2
  const ONLY_KNOWN = ['real', 'tz', 'tzBroken', 'n1', 'h3x', 'h2x', 'p57', 'tzr', 'tzjs'];
  if (ONLY && (ONLY.length === 0 || ONLY.some(x => !ONLY_KNOWN.includes(x)))) { console.log(`FAIL 未知的 --only 套件名：${ONLY.filter(x => !ONLY_KNOWN.includes(x)).join(',') || '（空）'}（已知：${ONLY_KNOWN.join(',')}）`); process.exit(2); }
  if (MUTF && MUTF.length === 0) { console.log('FAIL --mut 没有给出变异名'); process.exit(2); }

  // 1. 真实套件
  const real = want('real') ? await runSuite({ groups: new Set(['accounting', 'gates', 'reopen', 'states', 'k']), mutation: null, quiet: false }) : null;
  if (real) {
  count(real.results);
  console.log(`  库与外发中和：\n${real.neutralized.map(x => '    - ' + x).join('\n')}`);
  console.log('  A 类写点归因判据（写点级运行时归因；窗口内追踪到的 data_models 写语句逐条核）：');
  for (const [h, a] of Object.entries(ATTRIBUTION)) console.log(`    - ${h} ${a.route}［${a.form}］${a.criterion}`);
  if (real.coverageTable) { console.log('  A 类写点覆盖（契约文件 a-class-coverage.json → 通过的用例）：'); for (const r of real.coverageTable) console.log(`    - ${r.hash} ${r.route} → ${r.passed.length ? r.passed.join('；') : '（未覆盖）'}`); }
  }
  // G1：时区不一致实例（TZ=UTC）
  if (want('tz')) { const tzRun = await runSuite({ groups: new Set(['tz']), mutation: null, quiet: false, coverageExempt: true, extraEnv: { TZ: 'UTC' } }); count(tzRun.results); }
  // K4：启动时区自检 SQL 必然报错的实例（环境时区钉北京时间）——带任务时间条件的三处门禁一律拒绝
  if (want('tzBroken')) { const tzBrokenRun = await runSuite({ groups: new Set(['tz']), mutation: null, quiet: false, coverageExempt: true, tzBroken: true, extraEnv: { TZ: 'Asia/Shanghai' } }); count(tzBrokenRun.results); }
  // N1：判定与归档写入之间注入变化（副本里插 await 点；正式代码无钩子）
  if (want('n1')) { const n1Run = await runSuite({ groups: new Set(['n1']), mutation: null, quiet: false, coverageExempt: true, injectConfirm: true }); count(n1Run.results); }
  // H3x（末次合并审 H3）：/api/update 前置检查之后、UPDATE 之前注入「任务变 DONE / 被删」，只有语句级条件能拦
  if (want('h3x')) { const h3xRun = await runSuite({ groups: new Set(['h3x']), mutation: null, quiet: false, coverageExempt: true, injectH3: true }); count(h3xRun.results); }
  // H2x（末次合并审 H2）：PUT 读旧行与 UPDATE 之间注入他人写入，版本条件写须拦住并分流 409 / 404
  if (want('h2x')) { const h2xRun = await runSuite({ groups: new Set(['h2x']), mutation: null, quiet: false, coverageExempt: true, injectH2: true }); count(h2xRun.results); }
  // P57②：save-scripts 版本检查的两次判定（副本里注入交错；正式代码无钩子）
  if (want('p57')) { const p57Run = await runSuite({ groups: new Set(['p57']), mutation: null, quiet: false, coverageExempt: true, injectP57: true }); count(p57Run.results); }
  // N3：时区就绪屏障——自检未完成期间门禁拒绝（unknown），自检首两次失败、第三次成功 → 最终 ok、门禁放行
  if (want('tzr')) { const tzrRun = await runSuite({ groups: new Set(['tzr']), mutation: null, quiet: false, coverageExempt: true, tzRetry: true }); count(tzrRun.results); }   // 不钉 TZ：Windows 上 TZ=Asia/Shanghai 只影响 Node、不影响 SQLite localtime（实测差 7 小时），本机即北京时间，与其余「正常实例」套件同口径
  // R4：JS 时区检测抛异常 → unknown → SQLite 自检通过后 ok
  if (want('tzjs')) { const tzjsRun = await runSuite({ groups: new Set(['tzjs']), mutation: null, quiet: false, coverageExempt: true, tzJsFail: true }); count(tzjsRun.results); }
  if (real) console.log(`  服务运行期间测试进程写库次数 = ${real.writeEvidence.writesWhileUp}（夹具写入 ${real.writeEvidence.fixtureWrites} 次，全部发生在服务停止期间；运行期只持只读连接）；不读本机 task_pool.db`);

  // 2. 变异自证：须判红，且红灯与变异有因果（首条失败断言名按前缀核对）
  const mutations = [
    { id: 'bump0', label: 'M-A 删掉 PUT 的 config_rev 参数计算（恒传 0）', groups: ['accounting'], expectPrefix: 'A-记账 PUT ' },
    { id: 'gate-task', label: 'M-B 删掉 archivable-task 门禁的 task 实参', groups: ['gates'], expectPrefix: 'gate-拒绝 门禁2 archivable-task' },
    { id: 'early-text', label: 'M-C 把 EARLIER_THAN_TASK_REASON 置空', groups: ['gates'], expectPrefix: 'gate-早于文案 ' },
    { id: 'comment-bump', label: 'M-D PUT 不带 dim_config 分支的递增插值挪进 SQL 注释 + 同请求另发 bumpConfigRev（整请求 +1 仍成立）', groups: ['accounting'], expectPrefix: 'A-归因 PUT ' },
    // call 形态写点迁移变异（codex 22-R3 H）：助手调用迁位后请求级 +1 仍成立，必须由「顺序与邻接」归因断言判红
    { id: 'bump-move-save', label: 'M-E save-scripts 的 bumpConfigRev 迁到 UPDATE script_path 之后', groups: ['accounting'], expectPrefix: 'A-归因 save-scripts 业务内容变化：[2fc5964e2400] 顺序与邻接' },
    { id: 'bump-move-edit-new', label: 'M-F edit-script 首次建目录的 bumpConfigRev 迁到 UPDATE script_path 之前', groups: ['accounting'], expectPrefix: 'A-归因 edit-script 新建文件：[6874f3fcf2f0] 顺序与邻接' },
    { id: 'bump-move-edit-mark', label: 'M-G edit-script 的 bumpConfigRev 迁到 UPDATE script_modified 之后', groups: ['accounting'], expectPrefix: 'A-归因 edit-script 已有文件内容变化：[08d8e0c2caa2] 顺序与邻接' },
    // #77 C2b-1：实现对象两处递增的变异自证
    { id: 'impl-link-bump-off', label: 'M-IL impl-links 整组替换去掉挂接集合变化的 bumpConfigRev（挂接 / 解挂须判红）', groups: ['accounting'], expectPrefix: 'A-记账 impl-links ' },
    { id: 'impl-src-first-bump', label: 'M-IS 源码变化递增条件改成「哈希变化即递增」（首次登记也递增；「首次登记 0」须判红）', groups: ['accounting'], expectPrefix: 'B-记账 impl-source 登记源码（首次登记' },
    { id: 'summary-key-off', label: 'M-I PUT 构造 afterValue 时漏掉 impl_note 键（对照表已补该字段，每次编辑都会误报「实现说明」）', groups: ['accounting'], expectPrefix: 'B-摘要 ' },
    { id: 'summary-raw-off', label: 'M-K PUT 构造 afterValue 时 tech_owner 改回取请求体原值（部分字段请求体会误报「技术负责人」）', groups: ['accounting'], expectPrefix: 'B-摘要 部分字段 PUT' },
    { id: 'basic-raw-off', label: 'M-NC PUT 的 hasBasicInfoChange 改回原始 !== 比较（遗留 NULL 与规范默认值被判为变化）', groups: ['accounting'], expectPrefix: 'B-判定 遗留 NULL 回写' },
    { id: 'cs-noop-early', label: 'M-CS comment-split 空操作改回查模型之前提前返回 noChange（R4 前的旧写法）', groups: ['accounting'], expectPrefix: 'R4 comment-split 空操作' },
    { id: 'cs-rev-sql-off', label: 'M-CR comment-split 条件写 SQL 去掉 config_rev 条件（codex 24-R2 X1）', groups: ['accounting'], expectPrefix: 'X1 comment-split' },
    { id: 'cs-rev-noop-off', label: 'M-CR2 comment-split 空操作前置校验去掉版本条件（codex 24-R2 X1）', groups: ['accounting'], expectPrefix: 'X1 comment-split 空操作' },
    { id: 'first-save-no-layer', label: 'M-P53a save-scripts 首次落盘豁免不查分层（连同两处 LAYER_NOT_ODS 一起去掉：DIM / DWD 带 purpose + 当前版本被豁免、不拦；须判红）', groups: ['accounting'], expectPrefix: 'save-scripts P53 DIM 模型带 purpose + 当前版本的首次落盘 ⇒ 409 LAYER_NOT_ODS：写入请求返回 409' },
    { id: 'ods-layer-off', label: 'M-P57g save-scripts 去掉两处「分层不是 ODS ⇒ 409 LAYER_NOT_ODS」判定（退回不豁免、照常落盘并递增；须判红）', groups: ['accounting'], expectPrefix: 'save-scripts P53 DIM 模型带 purpose + 当前版本的首次落盘 ⇒ 409 LAYER_NOT_ODS：写入请求返回 409' },
    { id: 'ods-layer-final-off', label: 'M-P57h save-scripts 去掉终检的分层判定——早检通过后分层被改成 DIM 的注入用例须判红', groups: ['p57'], expectPrefix: 'P57② 分层终检：早检通过后', runCfg: { injectP57: true } },
    { id: 'ods-layer-first-off', label: 'M-P57i save-scripts 去掉早检的分层判定——入口已是 DIM、注入想改回 ODS 的用例须判红（证明早检有独立判据）', groups: ['p57'], expectPrefix: 'P57② 分层早检：入口时模型已是 DIM', runCfg: { injectP57: true } },
    { id: 'first-save-no-rev', label: 'M-P53b save-scripts 首次落盘豁免不查版本（连同两处 409 一起去掉：版本过期的自动保存被豁免、不拦；须判红）', groups: ['accounting'], expectPrefix: 'save-scripts P53 ODS + purpose + 版本已过期（当前 - 1）的首次落盘 ⇒ 409：写入请求返回 409' },
    // P57②（codex 49A-astra MED）：版本过期 409 的三处判定各自可去
    { id: 'ods-409-off', label: 'M-P57a save-scripts 去掉两处「版本过期 ⇒ 409」判定（过期的 ODS 自动保存退回不豁免、照常落盘并递增；须判红）', groups: ['accounting'], expectPrefix: 'save-scripts P53 ODS + purpose + 版本已过期（当前 - 1）的首次落盘 ⇒ 409：写入请求返回 409' },
    { id: 'ods-second-check-off', label: 'M-P57b save-scripts 去掉第二次（写阶段前重读）版本检查——第一次检查通过后配置又变的注入用例须判红', groups: ['p57'], expectPrefix: 'P57② 第二次检查：第一次检查通过后', runCfg: { injectP57: true } },
    { id: 'ods-first-check-off', label: 'M-P57c save-scripts 去掉第一次（读出模型行后）版本检查——入口版本领先、注入想拨回的用例须判红（证明第一次检查有独立判据）', groups: ['p57'], expectPrefix: 'P57② 第一次检查：入口版本领先', runCfg: { injectP57: true } },
    { id: 'ods-overwrite-before-final', label: 'M-P57n save-scripts 终检前对 oldExists 的文件直接同名覆盖写入（不建新文件、不归档；文件名清单不变，只有内容哈希变——证明清单里内容哈希这一维有判别力；首条因果断言须是「当前目录有旧脚本·版本被改：文件零变化」）', groups: ['p57'], expectPrefix: 'P57② 终检交错·当前目录有旧脚本·版本被改：文件零变化', runCfg: { injectP57: true } },
    { id: 'ods-archive-before-final', label: 'M-P57l save-scripts 把当前目录旧文件的归档（_history）提前到终检之前（codex 50C；409 响应不变，旧脚本交错用例的「文件零变化」断言须判红）', groups: ['p57'], expectPrefix: 'P57② 终检交错·当前目录有旧脚本·版本被改：文件零变化', runCfg: { injectP57: true } },
    { id: 'ods-move-prev-before-final', label: 'M-P57m save-scripts 终检前对 script_path 目录旧文件新增改名（假设实现，真实实现对该目录只读；只在 prevScriptDir !== scriptDir 时才动；「旧脚本只在 script_path 目录」用例的「文件零变化」断言须判红，且「当前目录有旧脚本」两例保持绿）', groups: ['p57'], expectPrefix: 'P57② 终检交错·旧脚本只在 script_path 目录·版本被改：文件零变化', mustPass: ['P57② 终检交错·当前目录有旧脚本·版本被改：', 'P57② 终检交错·当前目录有旧脚本·分层被改：'], runCfg: { injectP57: true } },
    { id: 'ods-final-moved-early', label: 'M-P57j save-scripts 把终检的重读挪到早检之后、查任务之前（行为不变，真实窗口重新打开；§8.4 静态位置断言须判红）', groups: ['accounting'], expectPrefix: 'P57 save-scripts 终检位置（静态）：终检（重读 config_rev 与 layer）出现在' },
    { id: 'ods-await-after-final', label: 'M-P57k save-scripts 在终检与写文件循环之间插一个 await（§8.4 静态断言须判红）', groups: ['accounting'], expectPrefix: 'P57 save-scripts 终检位置（静态）：终检到写文件循环之间' },
    { id: 'ods-rev-required-off', label: 'M-P57d save-scripts 去掉 EXPECTED_CONFIG_REV_REQUIRED（purpose = ods-auto-save 缺 expected_config_rev 不再 400；须判红）', groups: ['accounting'], expectPrefix: 'save-scripts P53 ODS 只带 purpose、缺 expected_config_rev 的首次落盘 ⇒ 400：写入请求返回 400' },
    // P57⑤（codex 49C MED）：豁免扩大到非首次落盘
    { id: 'exempt-widen-cur', label: 'M-P57e 豁免扩大到「当前目录已有旧脚本且内容改变」的自动保存（须判红）', groups: ['accounting'], expectPrefix: 'A-记账 save-scripts P57⑤ ODS + purpose + 当前版本、当前目录已有脚本' },
    { id: 'exempt-widen-prev', label: 'M-P57f 豁免扩大到「旧脚本只在 script_path 目录且内容改变」的自动保存（逐文件 + 目录级两条规则都被抑制；须判红，且当前目录那条 P57⑤ 用例保持绿）', groups: ['accounting'], expectPrefix: 'A-记账 save-scripts P57⑤ ODS + purpose + 当前版本、旧脚本只在 script_path', mustPass: ['A-记账 save-scripts P57⑤ ODS + purpose + 当前版本、当前目录已有脚本'] },
    { id: 'first-save-no-purpose', label: 'M-P53c save-scripts 首次落盘豁免不查 purpose（不带 purpose / purpose 写错的首次落盘也豁免；须判红）', groups: ['accounting'], expectPrefix: 'A-记账 save-scripts P53 purpose 写错' },
    { id: 'dir-rule-off', label: 'M-J save-scripts 删掉目录级规则（生效集合不同 / 原 script_path 不安全 ⇒ 递增）', groups: ['accounting'], expectPrefix: 'A-记账 save-scripts ' },
    { id: 'dir-set-off', label: 'M-J2 save-scripts 删掉生效集合比较、改回目录不同即递增', groups: ['accounting'], expectPrefix: 'B-记账 save-scripts ' },
    { id: 'no-attach-exclude', label: 'M-M save-scripts 生效集合不再排除 task_attachments 登记的附件', groups: ['accounting'], expectPrefix: 'B-记账 save-scripts 旧任务目录含任务附件' },
    { id: 'no-tablename-check', label: 'M-P 删掉 save-scripts 请求表名 = 模型表名校验', groups: ['accounting'], expectPrefix: 'save-scripts tableName 不一致' },
    { id: 'no-precheck', label: 'M-O 去掉 PUT 伴生前置检查（只留语句级条件 UPDATE）', groups: ['accounting'], expectPrefix: 'companion-link-existing：同名模型挂 CLAIMED 任务', mustPass: ['companion-link-existing 400：同名行 companion_of 仍为空', 'companion-link-by-name 400：同名行 companion_of 仍为空', 'companion-restore 400：同名行 companion_of 仍为空'] },
    { id: 'no-same-name-check', label: 'M-N 删掉「伴生名 = 主表名」硬校验（兜底 ② 仍须让主表 companion_of 为空）', groups: ['accounting'], expectPrefix: 'companion-同名：', mustPass: 'Q2② 兜底 ' },
    { id: 'skip-content', label: 'M-L save-scripts 生效集合比较去掉对跳过写入文件的内容比较（只比本次写入的文件）', groups: ['accounting'], expectPrefix: 'A-记账 save-scripts 四步复现' },
    { id: 'bump-autosave-skip', label: 'M-H edit-script autoSave 改内容不再递增（原位只在新建文件时递增，人工标记块内补一次，三个契约条目的顺序仍成立）', groups: ['accounting'], expectPrefix: 'A-记账 edit-script autoSave 已有文件内容变化' },
    // 修复批 3（C1 对抗审 23-R2）
    { id: 'link-pre-off:update', label: 'M-Q /api/update 去掉伴生前置查询、只留语句级条件（期望：K1 update 用例全部仍绿——语句级条件独立生效）', groups: ['k'], expectNoRed: true, mustPass: 'K1 update' },
    { id: 'link-guard-off:update', label: 'M-Q2 /api/update 前置查询与语句级条件一起去掉（证明 M-Q 的「不红」不是用例没牙）', groups: ['k'], expectPrefix: 'K1 update：' },
    { id: 'link-pre-off:create', label: 'M-Q3 /api/create 去掉前置查询、只留语句级条件（期望：K1 create 用例仍绿）', groups: ['k'], expectNoRed: true, mustPass: 'K1 create：' },
    { id: 'link-guard-off:create', label: 'M-Q3b /api/create 前置与语句级条件都去', groups: ['k'], expectPrefix: 'K1 create：' },
    { id: 'link-pre-off:batch', label: 'M-Q4 /api/create/batch 去掉前置判断、只留语句级条件（期望：K1 batch 用例仍绿）', groups: ['k'], expectNoRed: true, mustPass: 'K1 batch：' },
    { id: 'link-guard-off:batch', label: 'M-Q4b /api/create/batch 前置与语句级条件都去', groups: ['k'], expectPrefix: 'K1 batch：' },
    { id: 'link-pre-off:quick', label: 'M-Q5 quick-submit 去掉前置查询、只留语句级条件（期望：K1 quick-submit 用例仍绿）', groups: ['k'], expectNoRed: true, mustPass: 'K1 quick-submit：' },
    { id: 'link-guard-off:quick', label: 'M-Q5b quick-submit 前置与语句级条件都去', groups: ['k'], expectPrefix: 'K1 quick-submit：' },
    { id: 'link-pre-off:reopen', label: 'M-Q6 /api/reopen 去掉前置查询、只留语句级条件（期望：L1 reopen 用例仍绿）', groups: ['k'], expectNoRed: true, mustPass: 'L1 reopen：' },
    { id: 'link-guard-off:reopen', label: 'M-Q6b /api/reopen 前置与语句级条件都去', groups: ['k'], expectPrefix: 'L1 reopen：' },
    { id: 'edit-name-check-off', label: 'M-R 去掉 edit-script 的附件命名冲突校验', groups: ['k'], expectPrefix: 'K2 edit-script 附件命名' },
    { id: 'n1-all-cond-off', label: 'M-U 去掉 confirm 归档条件写的整个模型条件（只剩 status 条件）', groups: ['n1'], expectPrefix: 'N1 ', runCfg: { injectConfirm: true } },
    { id: 'n1-rev-cond-off', label: 'M-U2 只去 config_rev 相等条件（配置变更注入用例须判红）', groups: ['n1'], expectPrefix: 'N1 配置变更(REV)', runCfg: { injectConfirm: true } },
    { id: 'n1-rec-cond-off', label: 'M-U3 只去「无更新验收记录」条件（新 fail 记录注入用例须判红）', groups: ['n1'], expectPrefix: 'N1 新 fail 记录(FAIL)', runCfg: { injectConfirm: true } },
    { id: 'n1-inv-cond-off', label: 'M-U4 只去「失效记录条数不变」条件（记录被置失效注入用例须判红）', groups: ['n1'], expectPrefix: 'N1 记录被置失效', runCfg: { injectConfirm: true } },
    { id: 'n1-task-cond-off', label: 'M-W 去掉任务字段条件（linked_model_id / category / owner_id / created_at）', groups: ['n1'], expectPrefix: 'N1 任务字段', runCfg: { injectConfirm: true } },
    { id: 'n1-sameread-off', label: 'M-Z 去掉管理员 DIM / DWD 分支两次读取的一致性比较（R5 LAYER 注入用例须判红）', groups: ['n1'], expectPrefix: 'N1 判定内读不一致(LAYER)', runCfg: { injectConfirm: true } },
    { id: 'n1-model-cond-off', label: 'M-X 去掉模型行字段条件（存在性 / layer / companion_of / is_deleted）', groups: ['n1'], expectPrefix: 'N1 模型字段', runCfg: { injectConfirm: true } },
    { id: 'tzjs-exc-mismatch', label: 'M-Y JS 时区检测抛异常时直接置 mismatch（回到 R4 之前）', groups: ['tzjs'], expectPrefix: 'R4 JS 检测异常', runCfg: { tzJsFail: true } },
    { id: 'tz-no-retry', label: 'M-V 时区自检去掉退避重试（首次失败即置 mismatch；「首两次失败、第三次成功」须判红）', groups: ['tzr'], expectPrefix: 'N3 自检首两次失败', runCfg: { tzRetry: true } },
    { id: 'edit-ntfs-check-off', label: 'M-T 去掉 edit-script 的 NTFS 流名 / 结尾点空格校验', groups: ['k'], expectPrefix: 'L2 edit-script' },
    { id: 'tz-catch-nomark', label: 'M-S 时区自检异常分支不再 markTzMismatch（自检 SQL 报错实例）', groups: ['tz'], expectPrefix: 'K4 自检SQL报错', runCfg: { tzBroken: true, extraEnv: { TZ: 'Asia/Shanghai' } } },
    // 末次合并审 H3：/api/update DONE 门两层各自可去
    { id: 'h3-pre-off', label: 'M-H3a /api/update 去掉 DONE 前置检查、只留语句级条件（期望：现有 H3 改 / 清关联被拒用例仍绿——条件写自己在挡）', groups: ['gates'], expectNoRed: true, mustPass: ['H3 DONE 任务清空关联', 'H3 DONE 任务改关联'] },
    { id: 'h3-stmt-off', label: 'M-H3b /api/update 去掉两条 UPDATE 的 DONE 门条件、只留前置检查（前置之后任务变 DONE 的注入用例须判红）', groups: ['h3x'], expectPrefix: 'H3x ', runCfg: { injectH3: true } },
    { id: 'h2-guard-off', label: 'M-H2 PUT 两条最终 UPDATE 的 config_rev 版本条件改成恒真（读旧行之后他人改了同一行的注入用例须判红）', groups: ['h2x'], expectPrefix: 'H2x ', runCfg: { injectH2: true } },
    { id: 'h2-nodim-guard-off', label: 'M-H2a PUT「不带 dim_config」那条 UPDATE 的版本条件改成恒真（只该被「不带 dim_config 分支」用例判红；「带 dim_config 分支」用例须全绿）', groups: ['h2x'], expectPrefix: 'H2x 不带 dim_config 分支：读旧行之后', mustPass: ['H2x 带 dim_config 分支', 'H2x 对照'], runCfg: { injectH2: true } },
    { id: 'h2-dim-guard-off', label: 'M-H2b PUT「带 dim_config」那条 UPDATE 的版本条件改成恒真（只该被「带 dim_config 分支」用例判红；「不带 dim_config 分支」用例须全绿）', groups: ['h2x'], expectPrefix: 'H2x 带 dim_config 分支：读旧行之后', mustPass: ['H2x 不带 dim_config 分支', 'H2x 对照'], runCfg: { injectH2: true } },
    { id: 'h2-404-writes', label: 'M-H2c PUT 404 分流先把请求里的 table_comment 写库再回 404（状态码仍对；整行零落库用例须判红——门槛只要求不带 dim_config 分支，404 分流在 server.js 只有一处，两个分支共用）', groups: ['h2x'], expectPrefix: 'H2x 不带 dim_config 分支：404 时本请求零落库', runCfg: { injectH2: true } },
    { id: 'h3-null-clause-off', label: 'M-H3d /api/update 清空关联 UPDATE 漏写 OR linked_model_id IS NULL（DONE 且本来没关联、只改标题的放行侧对照须判红；前置检查仍在，只有语句条件这一层漏）', groups: ['gates'], expectPrefix: 'H3 对照：DONE 且本来没关联' },
    { id: 'h3-guard-off', label: 'M-H3c /api/update 前置检查与语句级条件一起去掉（现有 H3 用例须判红）', groups: ['gates'], expectPrefix: 'H3 DONE 任务' },
  ];
  if (MUTF) {
    const unknown = MUTF.filter(x => !mutations.some(m => m.id === x));
    if (unknown.length) { console.log(`FAIL 未知的 --mut 变异名：${unknown.join(',')}（已知：${mutations.map(m => m.id).join(',')}）`); process.exitCode = 2; return; }
  }
  for (const m of (MUTF ? mutations.filter(x => MUTF.includes(x.id)) : (ONLY ? [] : mutations))) {
    let res;
    try { res = await runSuite({ groups: new Set(m.groups), mutation: m.id, quiet: true, coverageExempt: true, ...(m.runCfg || {}) }); }
    catch (e) { fail++; console.log(`FAIL 变异 ${m.label}：执行失败（跳过 = 失败）：${e.message}`); continue; }
    const failed = res.results.filter(x => !x.ok);
    const causal = failed.filter(x => x.name.startsWith(m.expectPrefix));
    if (m.mustPass) {
      const prefixes = [].concat(m.mustPass);
      const must = res.results.filter(x => prefixes.some(pf => x.name.startsWith(pf)));
      const missingPrefix = prefixes.filter(pf => !res.results.some(x => x.name.startsWith(pf)));
      if (must.length === 0 || missingPrefix.length > 0 || must.some(x => !x.ok)) { fail++; console.log(`FAIL 变异 ${m.label}：兜底断言「${prefixes.join(' / ')}」缺失或失败（${must.length} 条，失败 ${must.filter(x => !x.ok).length} 条，缺失前缀 ${missingPrefix.join(',') || '无'}）`); continue; }
    }
    if (m.expectNoRed) {
      if (failed.length === 0) { pass++; console.log(`  变异 ${m.label} → 未判红（符合预期；兜底断言「${[].concat(m.mustPass).join(' / ')}」全部通过）`); }
      else { fail++; console.log(`FAIL 变异 ${m.label}：预期不红但有 ${failed.length} 条失败：${failed[0].name} :: ${failed[0].detail}`); }
      continue;
    }
    if (failed.length > 0 && causal.length > 0) { pass++; console.log(`  变异 ${m.label} → 判红（${failed.length} 条失败；首条因果断言：${causal[0].name}${causal[0].detail ? ' :: ' + causal[0].detail : ''}）`); }
    else { fail++; console.log(`FAIL 变异 ${m.label}：${failed.length === 0 ? '没有任何断言变红' : '变红了但没有预期的「' + m.expectPrefix + '」类断言（红灯与变异无因果）：' + failed[0].name}`); }
  }
  if (pass === 0 && fail === 0) { fail = 1; console.log('FAIL 没有运行任何断言（pass 与 fail 都为 0）——过滤条件空转不算通过'); }   // 收口批 2 LOW-6
  console.log(`verify-model-config-rev-http PASS=${pass} FAIL=${fail}`);
  process.exitCode = fail === 0 ? 0 : 1;
}

if (require.main === module) {
  main().catch((e) => { console.log(`FAIL 套件异常：${e && e.stack || e}`); process.exitCode = 1; }).finally(() => {
    runCleanupsSync();
    if (cleanupFailures.length) { console.log(`FAIL 清理复查：${cleanupFailures.length} 项未通过（临时目录 / 进程仍在）\n  ${cleanupFailures.join('\n  ')}`); process.exitCode = 1; }
  });
}
module.exports = { waitTzConclusion, cleanupFailures, noteCleanupFailure, pidAlive, guardMarkerPresent, ROOT, REAL_DB_ABS, TMP_BASE, makeRunDir, removeTree, copyTree, copyCode, replaceExactlyOnce, startInstance, makeService, createFreshDb, openWriter, openReader, makeApi, makeFixtures, signToken, registerCleanup, runCleanupsSync, waitFor, settle };
