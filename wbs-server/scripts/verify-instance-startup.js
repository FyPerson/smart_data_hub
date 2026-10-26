/**
 * #106 S1a 隔离实例启动集成验证（起真实 server.js 子进程）。
 *
 * 安全约束（本脚本自身的）：
 *   - 只起「隔离模式」子进程：身份 test-<随机>、库与数据根都在 os.tmpdir() 下的临时目录、端口 20000–49999 随机；
 *   - **所有** server.js 子进程（预热、成功启动、拒绝启动）都预加载业务库安全守卫：在任何 sqlite 连接打开前拦截 sqlite3.Database，
 *     只放行测试临时根之内的库，否则写标记文件并以退出码 98 立即退出（守卫保存原始 process.exit，预热的覆盖吞不掉它）；
 *     拒绝启动用例另禁止监听（退出码 97）。所以即便判定逻辑被改坏而按正常模式去开业务库，也在打开之前被截停；
 *   - 业务库只读取 size / mtime 做前后对照，不打开写入；
 *   - 结束时核对所有子进程已退出、临时目录已删。
 *   - （S1b 修复批 1·T6）守卫经 NODE_OPTIONS=--require 传给所有后代 node 进程（身份核对子进程也在其下），加载时往守卫日志追加 { pid, argv1 }，用例 1 据此断言；
 *   - （S1b 增补）守卫另拦外连：任何指向非回环地址的 TCP 连接 / 全局 fetch 立即退出码 94，所以钉钉闸门即使失效，请求也发不出去；
 *     第 5 段起隔离实例并驱动钉钉替身 / EXTERNAL_DISABLED / 文档只读 / 周期任务关闭下的一次性维护。
 *   - 变异自证：设置 INSTANCE_VERIFY_SOURCE_ROOT=<wbs-server 副本> 让子进程从副本起（不改真实检出里的文件）。
 *
 * 运行：node scripts/verify-instance-startup.js   （退出码 0 = 全部通过；失败时打印出问题子进程的日志尾部）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync, execFileSync } = require('child_process');

for (const k of Object.keys(process.env)) { if (/^sdh_/i.test(k)) delete process.env[k]; }   // 不分大小写（win32 上变量名不分大小写）

// 被测源码根：默认是本脚本所在检出的 wbs-server；变异自证时设置 INSTANCE_VERIFY_SOURCE_ROOT 指向 wbs-server 的一份副本（放在 wbs-server/scripts/.mutant-scratch 下，
//   这样 node_modules 能向上解析），server.js 子进程就从副本起，不必改动真实检出里的文件。业务库永远是本检出的 task_pool.db（只 stat）。
const SELF_WBS = path.resolve(__dirname, '..');
const WBS = process.env.INSTANCE_VERIFY_SOURCE_ROOT ? path.resolve(process.env.INSTANCE_VERIFY_SOURCE_ROOT) : SELF_WBS;
const SERVER_JS = path.join(WBS, 'server.js');
const REAL_DB = path.join(SELF_WBS, 'task_pool.db');
const SQLITE3_PATH = require.resolve('sqlite3', { paths: [WBS] });
const mode = require('../utils/instance-mode');
const instanceDb = require('../utils/instance-db');
const aes = require('../utils/aes-password');

let pass = 0;
let fail = 0;
const ok = (m) => { pass++; console.log(`  [OK] ${m}`); };
const bad = (m, d) => { fail++; console.log(`  [FAIL] ${m}${d ? '\n         ' + d : ''}`); };
const must = (cond, m, d) => (cond ? ok(m) : bad(m, d));
const section = (t) => console.log(`\n== ${t} ==`);

const TEST_JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(24).toString('hex');
// 周期任务启动痕迹：sys-iteration 过期扫描在 schema 就绪后立刻补跑一次并打印「授权到期扫描完成」；每日核验 / 排定类日志同理
const BG_TRACE = /授权到期扫描|每日核验|已排定/;
const SYS_READY_LOG = /\[系统迭代 C1\] ✅/;
// 调度决策的同步信号（#106 在 sys-iteration/index.js 的 expirySweep.start() 之后、impl-objects 的 startDailyVerify() 里各加了一行 info 日志）
// 预热要等齐的模块就绪 / 迁移完成信号（server.js 启动序列里 initSchema 的各模块 + initTable 里的迁移，日志文案取自实际运行输出）
const WARMUP_SIGNALS = [
    { name: '系统迭代 C1 就绪', re: /\[系统迭代 C1\] ✅/ },
    { name: '系统迭代迁移（C1 受理与排期）', re: /\[系统迭代迁移\] ✅ C1 受理与排期改造完成/ },
    { name: '系统迭代迁移（C0 受理门）', re: /\[系统迭代迁移\] ✅ C0 受理门焊死/ },
    { name: 'it-ledger 就绪', re: /\[it-ledger\] ✅ 7 表/ },
    { name: '数据开发换壳 issue_lite 就绪', re: /\[数据开发换壳 C1\] ✅ issue_lite/ },
    { name: '零星事项台账就绪', re: /\[零星事项台账\] ✅/ },
    { name: '需求跟踪 v1.75.0 迁移到位', re: /\[需求跟踪 v1\.75\.0\] ✅/ },
    { name: '取数质量双校验就绪', re: /\[取数质量双校验\] ✅/ },
    { name: '周期取数推送就绪', re: /\[周期取数推送\] ✅/ },
    { name: '历史台账归档就绪', re: /\[历史台账归档\] ✅/ },
    { name: '数据修正 A 就绪', re: /\[数据修正 A\] ✅/ },
];
/**
 * 模板拷出的实例启动后，日志里不应再有迁移语句再执行——唯一例外是需求跟踪的 issues / issue_comments：这几张表每次启动都会 DROP 重建，
 * 再由 v1.75.0 migration 补 5 列 + is_system（server.js 重建段 + runIssueV1750Migration，生产同样每次启动都走），日志固定 6 行，允许。
 * 返回不符合预期的行（空数组 = 模板已完全迁移）。
 */
const ISSUE_REBUILD_ALTERS = new Set(['issues:dingtalk_chat_id', 'issues:dingtalk_open_conversation_id', 'issues:dingtalk_chat_created_at', 'issues:dingtalk_chat_created_by', 'issues:dingtalk_chat_name', 'issue_comments:is_system']);
function unexpectedMigrationLines(out) {
    const bad1 = [];
    for (const line of String(out).split(/\r?\n/)) {
        if (/旧库 ALTER 不补 CHECK/.test(line)) continue;          // 取数质量巡检的一句说明文字，不是迁移语句
        if (!/ADD COLUMN|ALTER/.test(line)) continue;
        const m = /\[需求跟踪 v1\.75\.0\] ALTER (\w+): 列 (\w+) 已添加/.exec(line);
        if (m && ISSUE_REBUILD_ALTERS.has(`${m[1]}:${m[2]}`)) continue;
        bad1.push(line);
    }
    return bad1;
}
const SCHED_SWEEP_LOG =/\[sys-expiry\] 周期扫描已排定/;
const SCHED_VERIFY_LOG = /\[impl-objects\] 每日核验已排定/;
/** 在有界时间内等日志出现某模式；等不到返回 false（调用方据此判红，不当作通过） */
async function waitForLog(rec, re, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        if (re.test(rec.out)) return true;
        if (rec.exited) return false;
        await sleep(100);
    }
    return false;
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sdh-s1a-start-'));
const children = [];

// ---------------------------------------------------------------- 工具
function isPortFree(port) {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.once('error', () => resolve(false));
        s.listen(port, '0.0.0.0', () => s.close(() => resolve(true)));
    });
}
async function pickPort() {
    for (let i = 0; i < 50; i++) {
        const p = 20000 + crypto.randomInt(0, 30000);
        if (await isPortFree(p)) return p;
    }
    throw new Error('找不到空闲端口');
}
function getJson(port, urlPath) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 3000 }, (res) => {
            let b = '';
            res.on('data', (c) => { b += c; });
            res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(b) }); } catch (e) { reject(e); } });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('timeout')));
    });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 探测「三端核验」是否启用：admin 调手动核验端点。核验关闭 ⇒ 503 VERIFY_DISABLED；启用 ⇒ 先查对象，不存在 404 OBJECT_NOT_FOUND。
 * （这是模型中心 verifyEnabled 接线的行为层探针；该开关本身不产生启动日志，每日 07:30 任务启动期也无从观察。）
 * 隔离库初始化种子里的内置管理员 id=1 可能稍晚才写入，遇到「账号不存在」重试。
 */
async function probeImplVerify(port, jwtSecret) {
    const jwt = require('jsonwebtoken');
    const token = jwt.sign({ id: 1, username: 'probe', role: 'admin' }, jwtSecret, { expiresIn: '5m' });
    let last = null;
    for (let i = 0; i < 40; i++) {
        last = await new Promise((resolve) => {
            const req = http.request({ host: '127.0.0.1', port, path: '/api/model-impl-objects/999999/verify', method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 3000 }, (res) => {
                let b = '';
                res.on('data', (c) => { b += c; });
                res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) { /* 非 JSON */ } resolve({ status: res.statusCode, json: j, raw: b.slice(0, 200) }); });
            });
            req.on('error', (e) => resolve({ status: 0, json: null, raw: String(e.message) }));
            req.on('timeout', () => req.destroy(new Error('timeout')));
            req.end('{}');
        });
        const transient = last.status === 0 || last.status === 403 || last.status === 500 || (last.json && last.json.code === 'SCHEMA_NOT_READY');
        if (!transient) return last;
        await sleep(300);
    }
    return last;
}

/** 通用 JSON 请求（本机回环，带 admin JWT）；返回 { status, json, raw }。网络错误返回 status 0。 */
function httpJson(port, method, urlPath, body, token) {
    return new Promise((resolve) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        if (payload !== null) headers['Content-Length'] = Buffer.byteLength(payload);
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers, timeout: 15000 }, (res) => {
            let b = '';
            res.on('data', (c) => { b += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) { /* 非 JSON */ } resolve({ status: res.statusCode, json: j, raw: b.slice(0, 300) }); });
        });
        req.on('error', (e) => resolve({ status: 0, json: null, raw: String(e.message) }));
        req.on('timeout', () => req.destroy(new Error('timeout')));
        if (payload !== null) req.write(payload);
        req.end();
    });
}
/** 重试到状态码不在 transient 里（模块就绪前 503 / 账号种子未落库前 403 等） */
async function httpJsonRetry(port, method, urlPath, body, token, transient = [0, 503]) {
    let last = null;
    for (let i = 0; i < 60; i++) {
        last = await httpJson(port, method, urlPath, body, token);
        if (!transient.includes(last.status)) return last;
        await sleep(500);
    }
    return last;
}
function execSqlRW(dbFile, sqlText) {
    const sqlite3 = require('sqlite3');
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbFile, (e) => {
            if (e) return reject(e);
            db.exec(sqlText, (err) => db.close(() => (err ? reject(err) : resolve())));
        });
    });
}
/** 种两条带「真实形态密文」的外部库连接（单条 INSERT、一个字符串字面量——db_connections 直写登记守卫 verify-db-connections-writers 的约定）；地址用不可路由的 TEST-NET，万一发出连接也会被外连守卫截停。 */
async function seedExternalConnections(dbFile, cipher) {
    await execSqlRW(dbFile, `INSERT INTO db_connections (name, type, host, port, database, username, password, is_default, connection_type, source_system_code) VALUES ('s1b-wh', 'sqlserver', '192.0.2.10', 1433, 'dw', 'sa', '${cipher}', 1, 'warehouse', NULL), ('s1b-src', 'mysql', '192.0.2.11', 3306, 'hrd', 'ro', '${cipher}', 0, 'source', 'S1B')`);
}
/** 文档目录指纹：docs 顶层目录项名 + docs/archive 递归的文件名与大小（发布接口只会往这里搬文件） */
function docsFingerprint() {
    const docs = path.join(WBS, '..', 'docs');
    if (!fs.existsSync(docs)) return '(no docs dir)';
    const out = [fs.readdirSync(docs).sort().join('|')];
    const walk = (d, rel) => {
        for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, ent.name);
            if (ent.isDirectory()) walk(p, `${rel}/${ent.name}`);
            else out.push(`${rel}/${ent.name}:${fs.statSync(p).size}`);
        }
    };
    const arch = path.join(docs, 'archive');
    if (fs.existsSync(arch)) walk(arch, 'archive');
    return out.join('\n');
}

// 检出（wbs-server）目录快照：顶层目录项名 + 几个运行期目录的一层目录项名与目录自身 mtime。
//   只能发现「目录项的新增 / 删除」（及这几个目录的直接子项变动），看不到已有文件的内容被改写，所以相关断言的措辞也只声称前者。
function snapshotCheckout() {
    const snap = {};
    snap.top = fs.readdirSync(WBS).filter((n) => n !== 'node_modules').sort().join('|');
    for (const rel of ['uploads', 'archive', 'periodic-results', 'private', 'it-reconcile', path.join('routes', 'it-ledger', 'uploads')]) {
        const p = path.join(WBS, rel);
        if (fs.existsSync(p)) snap[rel] = fs.readdirSync(p).sort().join('|') + '@' + fs.statSync(p).mtimeMs;
        else snap[rel] = '(none)';
    }
    snap.externalCalls = fs.existsSync(path.join(WBS, 'external-calls.jsonl')) ? 'exists' : '(none)';
    return snap;
}
function statKey(p) {
    if (!fs.existsSync(p)) return '(none)';
    const s = fs.statSync(p);
    return `${s.size}@${s.mtimeMs}`;
}

// 业务库安全守卫：**所有** spawnServer 启动的 server.js 子进程都预加载它（成功启动、预热、拒启用例一视同仁）。
//   - 在任何 sqlite 连接打开前拦截 sqlite3.Database 构造：只放行真实路径位于本次测试临时根（GUARD_ROOT）之内的库（和 :memory:），
//     否则写标记文件并以专用退出码 98 立即退出——即使判定逻辑被改坏而按正常模式去开业务库，也在打开之前就被截停；
//   - 监听拦截：拒启用例（GUARD_NO_LISTEN=1）禁止任何监听（退出码 97）；其余用例只放行本用例分配的随机端口 GUARD_PORT，其他端口（含 3000）退出码 96；
//   - 运行模式拦截：成功启动类用例（GUARD_EXPECT_ISOLATED=1）在 getInstanceConfig 首次返回非隔离配置时退出码 95（发生在读配置、开库、监听之前）；
//   - 加载时保存原始 process.exit，守卫的退出走原始函数：预热预加载对 process.exit 的覆盖吞不掉它。
const guardPath = path.join(ROOT, '_guard.js');
fs.writeFileSync(guardPath, `
'use strict';
// 同一进程里可能被加载两次（NODE_OPTIONS 与命令行 --require 各一次）：只生效一次
if (globalThis.__sdhGuardLoaded) return;
globalThis.__sdhGuardLoaded = true;
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');
const realExit = process.exit.bind(process);
const marker = process.env.GUARD_MARKER;
// 加载留痕（T6）：每个加载了守卫的 node 进程往守卫日志追加一行 { pid, argv1 }——用来证明 server.js 启动前拉起的身份核对子进程也在守卫之下
if (process.env.GUARD_LOG) { try { fs.appendFileSync(process.env.GUARD_LOG, JSON.stringify({ pid: process.pid, argv1: process.argv[1] || null }) + '\\n'); } catch (_) {} }
const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const rootReal = fold(fs.realpathSync(process.env.GUARD_ROOT));
function trip(what, code) { try { fs.writeFileSync(marker, what); } catch (_) {} realExit(code); throw new Error('GUARD_TRIPPED:' + what); }
function realOf(p) {
  const abs = path.resolve(p);
  try { return fs.realpathSync(abs); } catch (_) {
    try { return path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs)); } catch (_2) { return abs; }
  }
}
function allowed(filename) {
  if (filename === ':memory:' || filename === '') return true;
  if (typeof filename !== 'string') return false;
  let p = filename;
  if (filename.startsWith('file:')) { try { p = fileURLToPath(filename.split('?')[0]); } catch (_) { return false; } }
  const r = fold(realOf(p));
  return r === rootReal || r.startsWith(rootReal + path.sep);
}
const sqlite3 = require(process.env.GUARD_SQLITE3);
const Orig = sqlite3.Database;
function Patched(filename, ...rest) {
  if (!allowed(filename)) trip('OPEN_OUTSIDE_TEST_ROOT:' + filename, 98);
  return new Orig(filename, ...rest);
}
Patched.prototype = Orig.prototype;
sqlite3.Database = Patched;
// 监听拦截（所有用例）：拒启用例（GUARD_NO_LISTEN=1）禁止任何监听，退出码 97；其余用例只放行本用例分配的随机端口（GUARD_PORT），
//   其他端口（含 3000、含系统分配端口 0）立即退出码 96。
{
  const net = require('net');
  const origListen = net.Server.prototype.listen;
  const portOf = (args) => { const a = args[0]; if (a && typeof a === 'object') return a.port; if (typeof a === 'number' || typeof a === 'string') return Number(a); return undefined; };
  net.Server.prototype.listen = function () {
    if (process.env.GUARD_NO_LISTEN === '1') trip('LISTEN', 97);
    const want = process.env.GUARD_PORT ? Number(process.env.GUARD_PORT) : null;
    const got = portOf(arguments);
    if (want !== null && got !== want) trip('LISTEN_WRONG_PORT:' + got + ' (allowed ' + want + ')', 96);
    return origListen.apply(this, arguments);
  };
}
// 外连拦截（所有用例，S1b）：任何指向非回环地址的 TCP 连接（含 TLS，经 net.Socket.connect）与指向非回环地址的全局 fetch 一律立即退出码 94——
//   隔离实例本来就不该发出真实请求；万一闸门失效（或变异自证里被故意弄坏），请求也发不出去，且标记文件让对应用例判红。
{
  const net = require('net');
  const isLoopback = (h) => h === undefined || h === null || h === '' || h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h === '0.0.0.0' || h === '::';
  const origSockConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function () {
    let a = arguments[0];
    if (Array.isArray(a)) a = a[0];                                   // net 内部把参数归一成 [options, cb]
    if (a && typeof a === 'object') {
      if (!(typeof a.path === 'string' && a.path !== '') && !isLoopback(a.host)) trip('NET_CONNECT_NON_LOOPBACK:' + a.host + ':' + a.port, 94);
    } else if (typeof a === 'number' || (typeof a === 'string' && /^\\d+$/.test(a))) {
      const h = typeof arguments[1] === 'string' ? arguments[1] : undefined;
      if (!isLoopback(h)) trip('NET_CONNECT_NON_LOOPBACK:' + h + ':' + a, 94);
    }
    return origSockConnect.apply(this, arguments);
  };
  if (typeof globalThis.fetch === 'function') {
    const origFetch = globalThis.fetch;
    globalThis.fetch = function (input) {
      let host = null;
      try { host = new URL(typeof input === 'string' ? input : (input && input.url) || String(input)).hostname; } catch (_) { host = '(unparseable)'; }
      if (!isLoopback(host)) trip('FETCH_NON_LOOPBACK:' + host, 94);
      return origFetch.apply(this, arguments);
    };
  }
}
// 运行模式拦截（GUARD_EXPECT_ISOLATED=1，成功启动类用例）：包一层 getInstanceConfig，首次返回的结果若不是隔离模式（含 refuse），
//   立即退出码 95——这发生在 server.js 读到配置、算出库路径、打开库、开始监听之前。拒启类用例不设该变量（它们期望被拒）。
if (process.env.GUARD_EXPECT_ISOLATED === '1') {
  const im = require(path.join(process.env.GUARD_WBS, 'utils', 'instance-mode.js'));
  const origGet = im.getInstanceConfig;
  let checked = false;
  im.getInstanceConfig = function () {
    const c = origGet.apply(this, arguments);
    if (!checked) {
      checked = true;
      if (!c || c.refuse || c.mode !== 'isolated') trip('MODE_NOT_ISOLATED:' + JSON.stringify(c && (c.refuse ? { refuse: c.code } : { mode: c.mode })), 95);
    }
    return c;
  };
}
`);
const GUARD_EXIT_OPEN = 98;
const GUARD_EXIT_LISTEN = 97;
const GUARD_EXIT_PORT = 96;
const GUARD_EXIT_MODE = 95;
const GUARD_EXIT_NET = 94;

// 预热模板库专用：空库首启时 initTable 里数据协作段（server.js:2246 建 collab_requests 表、:2267–2270 等处无回调的 db.run 建索引）
//   在 serialize 块之外并行发出，索引语句抢在建表之前执行，报 `no such table: main.collab_requests` 等（日志里 `Uncaught Exception ×7`），
//   触发 uncaughtException 处理器 → 1 秒后 process.exit(1)。这是既有竞态（归因取自预筛报告；不是 listen 回调里的协作巡检，巡检的报错另有
//   `[collab-integrity] 巡检异常（非阻塞）` 单独记录且被 catch）。生产 / 线库 / 测试库都是已有表的库，不受影响。
//   为了让 initTable 在本测试里跑完，预热那一次启动把 process.exit(非 0) 变成空操作，由测试自己杀进程。
const noExitPath = path.join(ROOT, '_noexit.js');
fs.writeFileSync(noExitPath, `
'use strict';
const realExit = process.exit;
process.exit = function (code) { if (code) return undefined; return realExit.apply(process, arguments); };
`);
let TEMPLATE_DB = null;

function makeInstance(tag, opts) {
    const o = Object.assign({ identity: true, manifest: true }, opts || {});
    const id = 'test-' + crypto.randomBytes(5).toString('hex');
    const dataDir = path.join(ROOT, id);
    fs.mkdirSync(dataDir, { recursive: true });
    const dbFile = path.join(dataDir, 'instance.db');
    // 本检出身份：线检出里父身份是线名，主工作区是 main
    const idFile = path.join(WBS, '.sdh-instance');
    const parent = fs.existsSync(idFile) ? fs.readFileSync(idFile, 'utf8').trim() : 'main';
    if (o.manifest) {
        fs.writeFileSync(path.join(dataDir, 'sdh-instance.json'), JSON.stringify({ instance: id, parent, pid: process.pid, createdAt: new Date().toISOString(), dir: dataDir }));
    }
    return { id, dataDir, dbFile, parent, tag };
}

// .env 注入预加载：拦截对 <WBS>/.env 的 fs.readFileSync（dotenv 与 instance-mode 的判定都走它），返回环境变量 ENVINJECT_CONTENT 的内容，
//   用来在不写真实 .env 的前提下让真实 server.js 读到 `SDH_*=…`。其他文件的读取原样放行。
const envInjectPath = path.join(ROOT, '_envinject.js');
fs.writeFileSync(envInjectPath, `
'use strict';
const fs = require('fs');
const path = require('path');
const target = path.resolve(process.env.ENVINJECT_TARGET).toLowerCase();
const orig = fs.readFileSync;
fs.readFileSync = function (p, ...rest) {
  if (typeof p === 'string' && path.resolve(p).toLowerCase() === target) {
    const enc = rest[0] && (typeof rest[0] === 'string' ? rest[0] : rest[0].encoding);
    return enc ? process.env.ENVINJECT_CONTENT : Buffer.from(process.env.ENVINJECT_CONTENT);
  }
  return orig.call(this, p, ...rest);
};
`);

/** NODE_OPTIONS 里的路径值：双引号包裹，内部反斜杠换正斜杠、双引号转义 */
function quoteNodeOption(p) {
    return '"' + String(p).replace(/\\/g, '/').replace(/"/g, '\\"') + '"';
}
/** 读守卫日志（每个加载了守卫的 node 进程一行 { pid, argv1 }） */
function readGuardLog(rec) {
    if (!rec.guardLog || !fs.existsSync(rec.guardLog)) return [];
    return fs.readFileSync(rec.guardLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// execPath 仅供自检注入一个不存在的可执行文件，模拟「启动失败」（spawn 的 error 事件）
function spawnServer(inst, { env = {}, trap = false, noExit = false, envInject = null, execPath = process.execPath, expectIsolated = !trap, port }) {
    const childEnv = Object.assign({}, process.env, {
        PORT: String(port),
        JWT_SECRET: TEST_JWT_SECRET,
        SDH_INSTANCE: inst.id,
        SDH_DB_FILE: inst.dbFile,
        SDH_DATA_DIR: inst.dataDir,
    });
    // 用例覆盖项：值为 undefined = 删除基线里的该变量；win32 上变量名不分大小写，所以连同基线里其他大小写写法一并删除；
    //   值不是 undefined = 设置（保留用例自己写的大小写，如 sdh_external / Sdh_Instance，用来测不分大小写语义）
    for (const k of Object.keys(env)) {
        if (env[k] === undefined) {
            for (const k2 of Object.keys(childEnv)) { if (k2.toLowerCase() === k.toLowerCase()) delete childEnv[k2]; }
        }
    }
    for (const k of Object.keys(env)) { if (env[k] !== undefined) childEnv[k] = env[k]; }
    const marker = path.join(ROOT, `trap-${inst.id}.marker`);
    Object.assign(childEnv, { GUARD_MARKER: marker, GUARD_WBS: WBS, GUARD_ROOT: ROOT, GUARD_SQLITE3: SQLITE3_PATH });
    // T6：守卫经 NODE_OPTIONS 传给所有后代 node 进程（server.js 启动前 execFileSync 拉起的身份核对子进程不走命令行 --require）。
    //   路径按 Node 文档加双引号；Windows 反斜杠在引号内会被当转义吃掉，所以统一换成正斜杠。
    const guardLog = path.join(ROOT, `guard-log-${inst.id}.jsonl`);
    childEnv.GUARD_LOG = guardLog;
    childEnv.NODE_OPTIONS = [childEnv.NODE_OPTIONS, `--require ${quoteNodeOption(guardPath)}`].filter(Boolean).join(' ');
    if (trap) childEnv.GUARD_NO_LISTEN = '1'; else delete childEnv.GUARD_NO_LISTEN;
    childEnv.GUARD_PORT = String(port);   // 非拒启用例只放行本用例分配的随机端口
    if (expectIsolated) childEnv.GUARD_EXPECT_ISOLATED = '1'; else delete childEnv.GUARD_EXPECT_ISOLATED;   // 成功启动类用例要求判定为隔离模式
    const preloads = [guardPath];   // 守卫必须第一个加载（先保存原始 process.exit，再让后面的预加载去覆盖）
    if (noExit) preloads.push(noExitPath);
    if (envInject !== null) {
        Object.assign(childEnv, { ENVINJECT_TARGET: path.join(WBS, '.env'), ENVINJECT_CONTENT: envInject });
        preloads.push(envInjectPath);
    }
    const args = [];
    for (const p of preloads) args.push('--require', p);
    args.push(SERVER_JS);
    const child = spawn(execPath, args, { cwd: WBS, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const rec = { child, pid: child.pid, out: '', exited: false, exitCode: null, signal: null, spawnError: null, marker, port, guardLog };
    child.stdout.on('data', (d) => { rec.out += d; });
    child.stderr.on('data', (d) => { rec.out += d; });
    // exit 与 error 都要收口：spawn 失败（可执行文件不存在 / 没权限）只发 error 不发 exit，没有这一支就会一直等到超时
    rec.exitPromise = new Promise((resolve) => {
        child.once('exit', (code, signal) => { rec.exited = true; rec.exitCode = code; rec.signal = signal; resolve(); });
        child.once('error', (e) => { rec.spawnError = e; rec.out += `[spawn error] ${e && e.message}\n`; if (!child.pid) { rec.exited = true; resolve(); } });
    });
    children.push(rec);
    return rec;
}

/** 等待就绪：/api/version 返回 200；子进程提前退出或超时都返回原因（把「挂起」和「失败」分开） */
async function waitReady(rec, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        if (rec.exited) return { ready: false, reason: rec.spawnError ? `SPAWN_ERROR(${rec.spawnError.code || rec.spawnError.message})` : `EXITED(code=${rec.exitCode})` };
        try {
            const r = await getJson(rec.port, '/api/version');
            if (r.status === 200) return { ready: true, version: r.json };
        } catch (_) { /* 还没监听 */ }
        await sleep(250);
    }
    return { ready: false, reason: 'HANG(startup timeout)' };
}
async function waitExit(rec, timeoutMs) {
    await Promise.race([rec.exitPromise, sleep(timeoutMs)]);
    return rec.exited;
}
async function stopServer(rec) {
    if (!rec.exited) {
        try { rec.child.kill(); } catch (_) { /* ignore */ }
        await waitExit(rec, 10000);
        if (!rec.exited) { try { rec.child.kill('SIGKILL'); } catch (_) { /* ignore */ } await waitExit(rec, 5000); }
    }
}
function pidAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (_) { return false; }
}
function tail(rec, n) {
    return rec.out.split(/\r?\n/).slice(-n).join('\n');
}

async function readonlyAll(dbFile, sql) {
    const sqlite3 = require('sqlite3');
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbFile, sqlite3.OPEN_READONLY, (e) => {
            if (e) return reject(e);
            db.all(sql, [], (err, rows) => db.close(() => (err ? reject(err) : resolve(rows))));
        });
    });
}
async function prepareDb(inst, { instanceId, parent, extra }) {
    const sqlite3 = require('sqlite3');
    if (instanceId !== null && TEMPLATE_DB) fs.copyFileSync(TEMPLATE_DB, inst.dbFile);   // 已建好全部表的库（见预热段），再把身份替换成本实例
    if (instanceId !== null) await instanceDb._internal.writeInstanceIdentity(inst.dbFile, { instanceId: instanceId || inst.id, parent: parent || inst.parent, from: 'verify-instance-startup' });
    if (extra) {
        await new Promise((resolve, reject) => {
            const db = new sqlite3.Database(inst.dbFile, (e) => {
                if (e) return reject(e);
                db.exec(extra, (err) => db.close(() => (err ? reject(err) : resolve())));
            });
        });
    }
}

// ---------------------------------------------------------------- 主流程
(async () => {
    const realDbBefore = statKey(REAL_DB);
    const checkoutBefore = snapshotCheckout();
    const hasIdentityFile = fs.existsSync(path.join(WBS, '.sdh-instance'));
    const headFromGit = (() => {
        try { const h = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: WBS, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); return /^[0-9a-f]{40}$/.test(h) ? h : null; } catch (_) { return null; }
    })();
    console.log(`临时根目录：${ROOT}`);
    console.log(`业务库 ${REAL_DB} 前态：${realDbBefore}（只读 stat，不打开）`);

    try {
        // ======================= 0a. 守卫自检 =======================
        section('0a 业务库安全守卫自检：库在测试临时根之外 → 打开前截停（退出码 98）；在之内 → 放行；noExit 预加载吞不掉守卫的退出');
        {
            const probe = path.join(ROOT, '_guard-probe.js');
            fs.writeFileSync(probe, `
const s = require(${JSON.stringify(SQLITE3_PATH)});
new s.Database(process.env.PROBE_DB);
console.log('OPENED');
`);
            const outside = path.join(os.tmpdir(), `sdh-guard-selftest-outside-${crypto.randomBytes(4).toString('hex')}.db`);
            const inside = path.join(ROOT, 'guard-selftest-inside.db');
            const runProbe = (db, tag) => spawnSync(process.execPath, ['--require', guardPath, '--require', noExitPath, probe], {
                cwd: ROOT, encoding: 'utf8', timeout: 30000, windowsHide: true,
                env: Object.assign({}, process.env, { GUARD_MARKER: path.join(ROOT, `guard-selftest-${tag}.marker`), GUARD_WBS: WBS, GUARD_ROOT: ROOT, GUARD_SQLITE3: SQLITE3_PATH, PROBE_DB: db }),
            });
            try {
                const r1 = runProbe(outside, 'outside');
                const m1 = path.join(ROOT, 'guard-selftest-outside.marker');
                must(r1.status === GUARD_EXIT_OPEN && !/OPENED/.test(r1.stdout || ''), '临时根之外的库：打开前被截停，退出码 98（预热用的 noExit 预加载在其后加载，也吞不掉）', `status=${r1.status} out=${r1.stdout} err=${(r1.stderr || '').slice(0, 200)}`);
                must(fs.existsSync(m1) && /OPEN_OUTSIDE_TEST_ROOT/.test(fs.readFileSync(m1, 'utf8')), '截停时写了标记文件');
                must(!fs.existsSync(outside), '被截停的库文件没有被创建');
                const r2 = runProbe(inside, 'inside');
                must(r2.status === 0 && /OPENED/.test(r2.stdout || ''), '临时根之内的库：放行', `status=${r2.status} out=${r2.stdout} err=${(r2.stderr || '').slice(0, 200)}`);
                // 路径前缀撞名：与临时根只差一个后缀的兄弟目录不算在临时根之内
                const sibling = path.join(path.dirname(ROOT), path.basename(ROOT) + '-sibling', 'x.db');
                const r3 = runProbe(sibling, 'sibling');
                must(r3.status === GUARD_EXIT_OPEN && !fs.existsSync(path.dirname(sibling)), '临时根的同前缀兄弟目录（字符串以临时根开头但不在其内）同样被截停，且没有创建任何东西');
            } finally {
                try { fs.rmSync(outside, { force: true }); } catch (_) { /* ignore */ }
            }
            // ---- 运行模式拦截：成功启动类用例（GUARD_EXPECT_ISOLATED=1）读到非隔离配置 → 退出码 95，发生在开库 / 监听之前 ----
            const modeProbe = path.join(ROOT, '_guard-probe-mode.js');
            fs.writeFileSync(modeProbe, `
const im = require(${JSON.stringify(path.join(WBS, 'utils', 'instance-mode.js'))});
const c = im.getInstanceConfig();
if (process.env.PROBE_DB) { const s = require(${JSON.stringify(SQLITE3_PATH)}); new s.Database(process.env.PROBE_DB); console.log('OPENED'); }
console.log('MODE=' + c.mode);
`);
            const runMode = (tag, extraEnv) => spawnSync(process.execPath, ['--require', guardPath, modeProbe], {
                cwd: ROOT, encoding: 'utf8', timeout: 30000, windowsHide: true,
                env: Object.assign({}, process.env, { GUARD_MARKER: path.join(ROOT, `guard-selftest-${tag}.marker`), GUARD_WBS: WBS, GUARD_ROOT: ROOT, GUARD_SQLITE3: SQLITE3_PATH, GUARD_EXPECT_ISOLATED: '1' }, extraEnv),
            });
            if (hasIdentityFile) {
                console.log('  [SKIP] 本检出存在 .sdh-instance（线检出）：跳过「配置被判成 normal」的守卫自检');
            } else {
                // 「隔离配置被错写成 normal、库路径仍是临时库」：环境里没有任何 SDH_* ⇒ 判定为 normal；PROBE_DB 是临时根内的库，若放行就会打开它
                const tmpDbForMode = path.join(ROOT, 'guard-selftest-mode.db');
                const m1 = runMode('mode-normal', { PROBE_DB: tmpDbForMode });
                must(m1.status === GUARD_EXIT_MODE && !/OPENED|MODE=/.test(m1.stdout || '') && !fs.existsSync(tmpDbForMode),
                    '判定为 normal（库路径是临时库）→ 被运行模式拦截截停，退出码 95，库没被打开', `status=${m1.status} out=${m1.stdout}`);
                const mm1 = path.join(ROOT, 'guard-selftest-mode-normal.marker');
                must(fs.existsSync(mm1) && /MODE_NOT_ISOLATED/.test(fs.readFileSync(mm1, 'utf8')), '模式拦截写了标记文件');
                const m3 = runMode('mode-refuse', { SDH_EXTERNAL: 'stub', PROBE_DB: tmpDbForMode });
                must(m3.status === GUARD_EXIT_MODE && !/OPENED/.test(m3.stdout || ''), '判定被拒绝（refuse）也被模式拦截截停，退出码 95', `status=${m3.status} out=${m3.stdout}`);
            }
            {
                const G = makeInstance('guard-mode-ok');
                const m2 = runMode('mode-isolated', { SDH_INSTANCE: G.id, SDH_DATA_DIR: G.dataDir, SDH_DB_FILE: G.dbFile });
                must(m2.status === 0 && /MODE=isolated/.test(m2.stdout || ''), '对照：判定为隔离模式 → 放行', `status=${m2.status} out=${m2.stdout} err=${(m2.stderr || '').slice(0, 200)}`);
            }
            // ---- 监听拦截：只放行本用例端口；其他端口（含 3000、listen(0)）退出码 96；拒启类禁止任何监听（97）----
            const listenProbe = path.join(ROOT, '_guard-probe-listen.js');
            fs.writeFileSync(listenProbe, `
const net = require('net');
const s = net.createServer();
s.listen(Number(process.env.PROBE_LISTEN_PORT), '127.0.0.1', () => { console.log('LISTENING'); s.close(); });
`);
            const allowedPort = await pickPort();
            const runListen = (tag, want, extraEnv) => spawnSync(process.execPath, ['--require', guardPath, listenProbe], {
                cwd: ROOT, encoding: 'utf8', timeout: 30000, windowsHide: true,
                env: Object.assign({}, process.env, { GUARD_MARKER: path.join(ROOT, `guard-selftest-${tag}.marker`), GUARD_WBS: WBS, GUARD_ROOT: ROOT, GUARD_SQLITE3: SQLITE3_PATH, GUARD_PORT: String(allowedPort), PROBE_LISTEN_PORT: String(want) }, extraEnv),
            });
            const l1 = runListen('listen-3000', 3000);
            must(l1.status === GUARD_EXIT_PORT && !/LISTENING/.test(l1.stdout || ''), '监听 3000 → 被端口拦截截停，退出码 96，没有真正监听', `status=${l1.status} out=${l1.stdout}`);
            const l2 = runListen('listen-zero', 0);
            must(l2.status === GUARD_EXIT_PORT && !/LISTENING/.test(l2.stdout || ''), '监听 0（系统分配端口）→ 同样截停，退出码 96', `status=${l2.status} out=${l2.stdout}`);
            const l3 = runListen('listen-ok', allowedPort);
            must(l3.status === 0 && /LISTENING/.test(l3.stdout || ''), '对照：监听本用例分配的端口 → 放行', `status=${l3.status} out=${l3.stdout} err=${(l3.stderr || '').slice(0, 200)}`);
            const l4 = runListen('listen-nolisten', allowedPort, { GUARD_NO_LISTEN: '1' });
            must(l4.status === GUARD_EXIT_LISTEN && !/LISTENING/.test(l4.stdout || ''), '拒启类（GUARD_NO_LISTEN=1）：连本用例端口也不许监听，退出码 97', `status=${l4.status} out=${l4.stdout}`);

            // ---- 外连拦截（S1b）：非回环地址的 TCP 连接 / fetch 一律截停（退出码 94）；回环放行 ----
            const netProbe = path.join(ROOT, '_guard-probe-net.js');
            fs.writeFileSync(netProbe, `
const net = require('net');
if (process.env.PROBE_MODE === 'fetch') {
  fetch(process.env.PROBE_URL).then((r) => console.log('FETCHED'), () => console.log('FETCH_ERROR'));
} else if (process.env.PROBE_MODE === 'obj-null-path') {
  const s = net.connect({ host: process.env.PROBE_HOST, port: Number(process.env.PROBE_PORT), path: null });
  s.on('connect', () => { console.log('CONNECTED'); s.destroy(); });
  s.on('error', () => console.log('CONNECT_ERROR'));
} else {
  const s = net.connect(Number(process.env.PROBE_PORT), process.env.PROBE_HOST);
  s.on('connect', () => { console.log('CONNECTED'); s.destroy(); });
  s.on('error', () => console.log('CONNECT_ERROR'));
}
`);
            const runNet = (tag, extraEnv) => spawnSync(process.execPath, ['--require', guardPath, netProbe], {
                cwd: ROOT, encoding: 'utf8', timeout: 30000, windowsHide: true,
                env: Object.assign({}, process.env, { GUARD_MARKER: path.join(ROOT, `guard-selftest-${tag}.marker`), GUARD_WBS: WBS, GUARD_ROOT: ROOT, GUARD_SQLITE3: SQLITE3_PATH }, extraEnv),
            });
            const n1 = runNet('net-remote', { PROBE_MODE: 'connect', PROBE_HOST: '203.0.113.1', PROBE_PORT: '80' });
            must(n1.status === GUARD_EXIT_NET && !/CONNECTED|CONNECT_ERROR/.test(n1.stdout || ''), '连接非回环地址 → 被外连拦截截停，退出码 94，连接没有发出', `status=${n1.status} out=${n1.stdout}`);
            const n1b = runNet('net-remote-null-path', { PROBE_MODE: 'obj-null-path', PROBE_HOST: '203.0.113.1', PROBE_PORT: '80' });
            must(n1b.status === GUARD_EXIT_NET && !/CONNECTED|CONNECT_ERROR/.test(n1b.stdout || ''), '对象参数 { host: 非回环, port, path: null }（Node 按 TCP 处理）同样被外连拦截截停，退出码 94', `status=${n1b.status} out=${n1b.stdout}`);
            const n2 = runNet('net-fetch', { PROBE_MODE: 'fetch', PROBE_URL: 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend' });
            must(n2.status === GUARD_EXIT_NET && !/FETCHED|FETCH_ERROR/.test(n2.stdout || ''), 'fetch 非回环地址（钉钉域名）→ 同样截停，退出码 94', `status=${n2.status} out=${n2.stdout}`);
            const mk2 = path.join(ROOT, 'guard-selftest-net-fetch.marker');
            must(fs.existsSync(mk2) && /FETCH_NON_LOOPBACK:api\.dingtalk\.com/.test(fs.readFileSync(mk2, 'utf8')), '外连拦截写了标记文件（含被拦的主机名）');
            const loopSrv = net.createServer((sock) => sock.end());
            const loopPort = await pickPort();   // 随机端口 + 先探空闲（#95：不用系统分配端口）
            await new Promise((r) => loopSrv.listen(loopPort, '127.0.0.1', r));
            try {
                const n3 = runNet('net-loop', { PROBE_MODE: 'connect', PROBE_HOST: '127.0.0.1', PROBE_PORT: String(loopPort) });
                must(n3.status === 0 && /CONNECTED/.test(n3.stdout || ''), '对照：连接回环地址 → 放行', `status=${n3.status} out=${n3.stdout} err=${(n3.stderr || '').slice(0, 200)}`);
            } finally {
                await new Promise((r) => loopSrv.close(r));
            }
        }

        // ---- 「模板已完全迁移」判据自检：该报的要报，允许的 6 行不报 ----
        section('0c 迁移语句判据自检（unexpectedMigrationLines）');
        {
            const allowed6 = ['dingtalk_chat_id', 'dingtalk_open_conversation_id', 'dingtalk_chat_created_at', 'dingtalk_chat_created_by', 'dingtalk_chat_name']
                .map((c) => `[INFO] t [需求跟踪 v1.75.0] ALTER issues: 列 ${c} 已添加`).concat('[INFO] t [需求跟踪 v1.75.0] ALTER issue_comments: 列 is_system 已添加').join('\n');
            must(unexpectedMigrationLines(allowed6).length === 0, '需求跟踪每次启动重建后补的 6 列（固定文案）不报');
            must(unexpectedMigrationLines('[INFO] t [系统迭代迁移] sys_issues ADD COLUMN online_source TEXT（C9）').length === 1, '系统迭代的 ADD COLUMN 迁移再执行 → 报');
            must(unexpectedMigrationLines('[INFO] t [需求跟踪 v1.75.0] ALTER issues: 列 some_new_col 已添加').length === 1, '需求跟踪里不在固定 6 列内的 ALTER → 报');
            must(unexpectedMigrationLines('[INFO] t 取数质量双校验 schema 列巡检通过：旧库 ALTER 不补 CHECK').length === 0, '取数质量巡检里的说明文字（含 ALTER 字样）不误报');
        }

        // ---- spawn 失败（error 事件）也能收口：注入一个不存在的可执行文件 ----
        section('0b 启动失败收口：spawn 的 error 事件不会让用例一直等到超时');
        {
            const E = makeInstance('spawn-error');
            const t0 = Date.now();
            const srvE = spawnServer(E, { port: await pickPort(), execPath: path.join(ROOT, 'no-such-node-executable.exe') });
            const exitedE = await waitExit(srvE, 15000);
            const readyE = await waitReady(srvE, 5000);
            must(exitedE && srvE.exited && srvE.spawnError && Date.now() - t0 < 10000, 'spawn 失败：exitPromise 随 error 事件收口（秒级，不是等到超时）', `exited=${srvE.exited} err=${srvE.spawnError && srvE.spawnError.code} ms=${Date.now() - t0}`);
            must(!readyE.ready && /SPAWN_ERROR/.test(readyE.reason || ''), 'waitReady 给出 SPAWN_ERROR 原因，不报就绪也不挂起', JSON.stringify(readyE));
            await stopServer(srvE);
            must(!pidAlive(srvE.pid), 'spawn 失败的记录能被正常清理（没有残留进程）');
        }

        // ======================= 0. 预热模板库 =======================
        section('0 预热：空库 + 身份 → 首次启动让 initTable 建完全部表，作为后续用例的模板库');
        {
            const T = makeInstance('template');
            await prepareDb(T, {});   // 此时 TEMPLATE_DB 还是 null：只有身份表的空库
            const portT = await pickPort();
            const srvT = spawnServer(T, { port: portT, noExit: true });
            const readyT = await waitReady(srvT, 90000);
            // 本步只为产出模板库；「能通过身份核对并以隔离模式监听」由后面的用例 1（实例 A）证明，这里不重复声称
            must(readyT.ready, '预热实例（空库首启，process.exit(非 0) 已被预加载脚本变空操作）在期限内开始监听', `${readyT.reason || ''}\n${tail(srvT, 15)}`);
            // 等各模块的就绪 / 迁移完成信号全部出现（以 server.js 启动序列里 initSchema 的模块为准），有界超时（120 秒），连续两次轮询无 journal；
            //   缺哪个信号就判红并打印日志尾部，不退回「日志静默若干秒」的猜测。
            {
                const t0 = Date.now();
                let noJournalPolls = 0;
                let missing = WARMUP_SIGNALS.map((s) => s.name);
                while (Date.now() - t0 < 120000) {
                    missing = WARMUP_SIGNALS.filter((s) => !s.re.test(srvT.out)).map((s) => s.name);
                    noJournalPolls = (missing.length === 0 && !fs.existsSync(T.dbFile + '-journal')) ? noJournalPolls + 1 : 0;
                    if (noJournalPolls >= 2 || srvT.exited) break;
                    await sleep(500);
                }
                must(missing.length === 0 && noJournalPolls >= 2, `预热实例：${WARMUP_SIGNALS.length} 个模块的就绪 / 迁移完成信号全部出现且无 journal（初始化已落定）`, `缺少：${missing.join('、') || '（无，journal 未清）'}\n${tail(srvT, 40)}`);
            }
            await stopServer(srvT);
            must(srvT.exited && !pidAlive(srvT.pid), '预热实例已退出');
            must(!fs.existsSync(srvT.marker), '守卫未触发：预热实例没有试图打开测试临时根之外的库');
            const tplTables = await readonlyAll(T.dbFile, "SELECT count(*) AS n FROM sqlite_master WHERE type='table'");
            must(tplTables[0].n > 50 && !fs.existsSync(T.dbFile + '-journal'), `模板库建出业务表（${tplTables[0].n} 张）且无残留 journal`);
            TEMPLATE_DB = path.join(ROOT, 'template.db');
            fs.copyFileSync(T.dbFile, TEMPLATE_DB);
        }

        // ======================= 1. 正常启动（隔离模式）=======================
        section('1 隔离实例正常启动：/api/version、目录落点、检出目录零新增');
        const A = makeInstance('A');
        await prepareDb(A, {});
        const portA = await pickPort();
        const srvA = spawnServer(A, { port: portA, env: { DB_ENCRYPTION_KEY: 'short' } }); // 非法进程键：隔离模式必须忽略它
        const readyA = await waitReady(srvA, 90000);
        must(readyA.ready, `子进程在期限内就绪（端口 ${portA}，DB_ENCRYPTION_KEY=short 被忽略）`, `${readyA.reason}\n${tail(srvA, 25)}`);
        if (readyA.ready) {
            const v = readyA.version;
            const pkg = require('../package.json');
            must(v.version === pkg.version && v.name === '智数协同平台' && v.nameEn === 'Smart Data Hub', '/api/version 原字段不变（version / name / nameEn）', JSON.stringify(v));
            must(v.mode === 'isolated', '/api/version.mode = isolated', JSON.stringify(v));
            must(v.instance === A.id, '/api/version.instance = SDH_INSTANCE', JSON.stringify(v));
            must(v.external === 'stub' && v.background === 'off', '/api/version.external = stub、background = off（隔离默认）', JSON.stringify(v));
            must(v.commit === null || /^[0-9a-f]{40}$/.test(v.commit), '/api/version.commit 为 40 位十六进制或 null', JSON.stringify(v.commit));
            if (headFromGit) must(v.commit === headFromGit, '/api/version.commit 等于 git rev-parse HEAD', `${v.commit} vs ${headFromGit}`);
            // T6：守卫也在 server.js 启动前拉起的身份核对子进程里加载（NODE_OPTIONS 传给后代进程）——守卫日志里有 server.js 主进程一行和身份核对脚本一行
            {
                const gl = readGuardLog(srvA);
                const sameFile = (a, b) => path.resolve(String(a || '')).toLowerCase() === path.resolve(b).toLowerCase();
                const serverLine = gl.find((l) => sameFile(l.argv1, SERVER_JS));
                const checkLine = gl.find((l) => l.argv1 && /[\\/]instance-db-check\.js$/i.test(l.argv1));
                must(!!serverLine && serverLine.pid === srvA.pid, '守卫日志：server.js 主进程加载了守卫（pid 即子进程 pid）', JSON.stringify(gl));
                must(!!checkLine && checkLine.pid !== srvA.pid && sameFile(checkLine.argv1, path.join(WBS, 'utils', 'instance-db-check.js')),
                    '守卫日志：启动前拉起的身份核对子进程（instance-db-check.js，另一个 pid）也加载了守卫', JSON.stringify(gl));
            }
            must(srvA.out.includes(`[instance] mode=isolated instance=${A.id} external=stub background=off port=${portA}`), '启动日志含 [instance] 行且端口为实际监听端口', tail(srvA, 12));
            must(!/实际监听端口 .* 与期望端口/.test(srvA.out), '端口自检无告警');
            must(fs.existsSync(path.join(A.dataDir, 'uploads')) && fs.existsSync(path.join(A.dataDir, 'archive')), 'uploads / archive 建在数据根下');
            must(fs.existsSync(path.join(A.dataDir, 'uploads', 'collab')), 'uploads/collab 建在数据根下（协作附件根）');
            must(fs.existsSync(path.join(A.dataDir, 'periodic-results')), 'periodic-results 建在数据根下（A3）');
            // 背景任务关闭（对照见用例 2）。直接观察调度决策：sys-iteration 在 `expirySweep.start()` 被调用后同步打印「[sys-expiry] 周期扫描已排定」，
            //   随后才打印就绪日志 `[系统迭代 C1] ✅`（on / off 都会打）。所以等到就绪日志 = 决策已发生；此时没有「已排定」行就是没有排定
            //   （不再靠"完成日志在 3 秒内没出现"间接推断——扫描可能已启动却在等锁）。等不到就绪日志判红。
            const sysReady = await waitForLog(srvA, SYS_READY_LOG, 90000);
            must(sysReady, '隔离默认：等到 sys-iteration 就绪日志 `[系统迭代 C1] ✅`（调度决策已发生）', tail(srvA, 20));
            // 模板已完全迁移：模板拷出的实例启动后，日志里没有 ADD COLUMN / ALTER 类迁移再执行（需求跟踪每次启动重建的 6 行除外，见 unexpectedMigrationLines）
            const unexpectedA = unexpectedMigrationLines(srvA.out);
            must(sysReady && unexpectedA.length === 0, '模板已完全迁移：用例 1 实例的日志里没有迁移语句再执行（需求跟踪每次启动重建后补的 6 列除外）', unexpectedA.slice(0, 5).join('\n'));
            must(sysReady && !SCHED_SWEEP_LOG.test(srvA.out), '隔离默认：没有「[sys-expiry] 周期扫描已排定」（过期扫描未排定）', tail(srvA, 40));
            must(!BG_TRACE.test(srvA.out), '隔离默认：日志中也没有扫描完成 / 每日核验痕迹（辅助）', tail(srvA, 40));
            const pvA = await probeImplVerify(portA, TEST_JWT_SECRET);
            must(pvA.status === 503 && pvA.json && pvA.json.code === 'VERIFY_DISABLED', '隔离默认：模型中心三端核验关闭（手动核验端点 503 VERIFY_DISABLED）', JSON.stringify(pvA));
            must(!SCHED_VERIFY_LOG.test(srvA.out), '隔离默认：没有「[impl-objects] 每日核验已排定」', tail(srvA, 20));
        }
        must(!fs.existsSync(srvA.marker), '守卫未触发：没有试图打开测试临时根之外的库（用例 1）');
        await stopServer(srvA);
        must(srvA.exited && !pidAlive(srvA.pid), '子进程 A 已退出');
        const idAfterA = await instanceDb.checkInstanceIdentity(A.dbFile, { expectedInstance: A.id, expectedParent: A.parent });
        must(idAfterA.ok, '运行后库内身份仍一致（服务没有改写它）', JSON.stringify(idAfterA));
        const checkoutAfterA = snapshotCheckout();
        must(JSON.stringify(checkoutAfterA) === JSON.stringify(checkoutBefore), '检出目录下（wbs-server 顶层与几个运行期目录的直接子项）没有新增或删除的目录项', JSON.stringify({ before: checkoutBefore, after: checkoutAfterA }));

        // ======================= 2. 对照：显式开启周期任务 =======================
        section('2 对照组：SDH_BACKGROUND_JOBS=on 时 /api/version 反映且周期任务痕迹出现');
        const B = makeInstance('B');
        await prepareDb(B, {});
        const portB = await pickPort();
        const srvB = spawnServer(B, { port: portB, env: { SDH_BACKGROUND_JOBS: 'on', DB_ENCRYPTION_KEY: '' } }); // 空值：同样应能启动
        const readyB = await waitReady(srvB, 90000);
        must(readyB.ready, `对照实例就绪（端口 ${portB}，DB_ENCRYPTION_KEY 置空）`, `${readyB.reason}\n${tail(srvB, 25)}`);
        if (readyB.ready) {
            must(readyB.version.background === 'on' && readyB.version.mode === 'isolated', '/api/version.background = on', JSON.stringify(readyB.version));
            // 偶发判红的根因已定位：it-ledger 的独立连接每次启动在 applyReconcileSchema 里 BEGIN IMMEDIATE，若落进主连接的启动写入高峰，
            //   再叠加 libuv 线程池被占满，主连接的写语句按 5 秒 busy_timeout 逐条报 SQLITE_BUSY，[数据修正 A] / [系统迭代 C1] 等迁移失败、就绪状态锁死。
            //   这是既有的产品启动竞态（非 S1b 引入），已另行登记处理；对照组偶发判红属该竞态，不在测试里加重试或放宽断言。
            //   下面 60 秒上限只是给“排定日志出现得晚”留余量；迁移一旦失败，等多久都救不回来（日志不会再出现），所以保留 60 秒不是为了容错，而是让这种情形以明确的“等不到”判红而不是挂起。
            const schedSweep = await waitForLog(srvB, SCHED_SWEEP_LOG, 60000);
            must(schedSweep, '对照组：出现「[sys-expiry] 周期扫描已排定」（证明用例 1 里的「没有该行」不是正则写偏）', tail(srvB, 40));
            const unexpectedB = unexpectedMigrationLines(srvB.out);
            must(unexpectedB.length === 0, '模板已完全迁移：用例 2 实例的日志里同样没有迁移语句再执行', unexpectedB.slice(0, 5).join('\n'));
            const schedVerify = await waitForLog(srvB, SCHED_VERIFY_LOG, 60000);
            must(schedVerify, '对照组：出现「[impl-objects] 每日核验已排定」', tail(srvB, 40));
            const pvB = await probeImplVerify(portB, TEST_JWT_SECRET);
            must(pvB.status === 404 && pvB.json && pvB.json.code === 'OBJECT_NOT_FOUND', '对照组：模型中心三端核验启用（手动核验端点越过 VERIFY_DISABLED，对象不存在 404 OBJECT_NOT_FOUND）', JSON.stringify(pvB));
        }
        must(!fs.existsSync(srvB.marker), '守卫未触发（用例 2）');
        await stopServer(srvB);
        must(srvB.exited && !pidAlive(srvB.pid), '子进程 B 已退出');

        // ======================= 3. 拒绝启动 =======================
        section('3 拒绝启动（带陷阱：打开业务库 / 监听即写标记并退出）');
        async function expectRefusal(label, inst, spawnOpts, expectText) {
            const port = await pickPort();
            const srv = spawnServer(inst, Object.assign({ port, trap: true }, spawnOpts || {}));
            const exited = await waitExit(srv, 90000);
            if (!exited) {
                bad(`${label}：挂起（90 秒内未退出）`, tail(srv, 15));
                await stopServer(srv);
                return;
            }
            const marker = fs.existsSync(srv.marker) ? fs.readFileSync(srv.marker, 'utf8') : null;
            must(srv.exitCode === 1, `${label}：以退出码 1 拒绝启动`, `exit=${srv.exitCode} signal=${srv.signal}\n${tail(srv, 12)}`);
            must(expectText.test(srv.out), `${label}：日志含原因 ${expectText}`, tail(srv, 12));
            must(marker === null, `${label}：陷阱未触发（没打开业务库、没监听）`, String(marker));
            must(!pidAlive(srv.pid), `${label}：子进程已退出`);
            must(!fs.existsSync(path.join(inst.dataDir, 'uploads')) && !fs.existsSync(path.join(inst.dataDir, 'archive')), `${label}：没有在数据根下创建 uploads / archive`);
        }

        const C1 = makeInstance('no-table');
        await prepareDb(C1, { instanceId: null, extra: 'CREATE TABLE t (a INTEGER);' });
        await expectRefusal('库无 _sdh_instance 表', C1, {}, /TABLE_MISSING/);

        const C2 = makeInstance('empty-table');
        await prepareDb(C2, { instanceId: null, extra: 'CREATE TABLE _sdh_instance (id INTEGER PRIMARY KEY CHECK (id = 1), instance_id TEXT NOT NULL, created_at TEXT NOT NULL, source TEXT NOT NULL);' });
        await expectRefusal('_sdh_instance 空表', C2, {}, /ROW_COUNT/);

        const C3 = makeInstance('two-rows');
        await prepareDb(C3, { instanceId: null, extra: `CREATE TABLE _sdh_instance (id INTEGER, instance_id TEXT NOT NULL, created_at TEXT NOT NULL, source TEXT NOT NULL); INSERT INTO _sdh_instance VALUES (1, '${C3.id}', 't', '{"parent":"${C3.parent}"}'); INSERT INTO _sdh_instance VALUES (1, 'other', 't', '{}');` });
        await expectRefusal('_sdh_instance 两行（第一行匹配）', C3, {}, /ROW_COUNT/);

        const C4 = makeInstance('wrong-instance');
        await prepareDb(C4, { instanceId: 'test-someone-else' });
        await expectRefusal('instance_id 不符', C4, {}, /INSTANCE_MISMATCH/);

        const C5 = makeInstance('wrong-parent');
        await prepareDb(C5, { parent: 'some-other-line' });
        await expectRefusal('父检出身份不符', C5, {}, /PARENT_MISMATCH/);

        // 「业务库形态」：临时目录里一个有业务表、没有身份表的库（原来这里让 SDH_DB_FILE 指向真实 wbs-server/task_pool.db，但身份核对子进程
        //   不在守卫里，会真的只读打开业务库——测试不再以任何方式打开真实业务库，只对它做 stat 比较）。子进程崩溃（CHECK_PROCESS_FAILED）不算数。
        const C6 = makeInstance('business-shaped');
        await prepareDb(C6, { instanceId: null, extra: 'CREATE TABLE users (id INTEGER PRIMARY KEY); CREATE TABLE task_pool (id INTEGER PRIMARY KEY); CREATE TABLE data_models (id INTEGER PRIMARY KEY);' });
        await expectRefusal('业务库形态的库（有业务表、无 _sdh_instance）', C6, {}, /库内身份核对失败（TABLE_MISSING）/);

        const C7 = makeInstance('no-manifest', { manifest: false });
        await expectRefusal('test- 实例缺实例清单', C7, {}, /TEST_MANIFEST_MISSING/);

        const C8 = makeInstance('relative-db');
        await prepareDb(C8, {});
        await expectRefusal('SDH_DB_FILE 相对路径', C8, { env: { SDH_DB_FILE: 'rel-instance.db' } }, /PATH_NOT_ABSOLUTE/);   // 相对路径（cwd 是 wbs-server，故意不用业务库的文件名，免得误放行时解析到业务库）

        const C9 = makeInstance('impersonation');
        await prepareDb(C9, {});
        await expectRefusal('冒用非 test- 身份', C9, { env: { SDH_INSTANCE: 'not-a-test-instance' } }, hasIdentityFile ? /INSTANCE_IMPERSONATION/ : /INSTANCE_WITHOUT_CHECKOUT_IDENTITY/);

        if (hasIdentityFile) {
            console.log('  [SKIP] 本检出存在 .sdh-instance（线检出）：跳过「正常模式 + 隔离类变量」用例');
        } else {
            const N = makeInstance('normal-ext');
            // 正常模式：不设 SDH_INSTANCE，仅设 SDH_EXTERNAL=stub（SDH_DB_FILE / SDH_DATA_DIR 一并去掉，只留要测的那个变量）
            await expectRefusal('正常模式设 SDH_EXTERNAL=stub', N, { env: { SDH_INSTANCE: undefined, SDH_DB_FILE: undefined, SDH_DATA_DIR: undefined, SDH_EXTERNAL: 'stub' } }, /ISOLATION_VAR_IN_NORMAL_MODE/);
            // 同一类用例另三个变量也各过一遍（判定阶段退出）
            const N2 = makeInstance('normal-bg');
            await expectRefusal('正常模式设 SDH_BACKGROUND_JOBS=off', N2, { env: { SDH_INSTANCE: undefined, SDH_DB_FILE: undefined, SDH_DATA_DIR: undefined, SDH_BACKGROUND_JOBS: 'off' } }, /ISOLATION_VAR_IN_NORMAL_MODE/);
            // 真实 server.js 端到端：.env 里的 SDH_*（经预加载拦截对 <WBS>/.env 的 readFileSync 注入，不写真实 .env）必须让正常模式拒启。
            //   首次判定发生在 server.js:20 加载 collab-submit-helpers 时（早于 server.js 的 dotenv），所以这条同时覆盖「判定自己读 .env」。
            const noIso = { SDH_INSTANCE: undefined, SDH_DB_FILE: undefined, SDH_DATA_DIR: undefined };
            const N3 = makeInstance('env-inject');
            await expectRefusal('.env（注入）写 SDH_EXTERNAL=stub、正常模式', N3, { envInject: 'SDH_EXTERNAL=stub\n', env: noIso }, /ISOLATION_VAR_IN_NORMAL_MODE/);
            if (process.platform === 'win32') {
                // Windows 环境变量名不分大小写：小写名与大写名是同一个变量
                const N4 = makeInstance('lowercase-proc');
                await expectRefusal('进程环境小写键 sdh_external=stub、正常模式（win32）', N4, { env: Object.assign({}, noIso, { sdh_external: 'stub' }) }, /ISOLATION_VAR_IN_NORMAL_MODE/);
                const N5 = makeInstance('lowercase-dotenv');
                await expectRefusal('.env（注入）小写键 sdh_external=stub、正常模式（win32）', N5, { envInject: 'sdh_external=stub\n', env: noIso }, /ISOLATION_VAR_IN_NORMAL_MODE/);
                const N6 = makeInstance('mixedcase-instance');
                await expectRefusal('进程环境混合大小写键 Sdh_Instance=line-b、正常模式（win32）', N6, { env: Object.assign({}, noIso, { Sdh_Instance: 'line-b' }) }, /INSTANCE_WITHOUT_CHECKOUT_IDENTITY/);
            } else {
                console.log('  [SKIP] 非 win32：跳过环境变量名大小写不敏感的端到端用例');
            }
        }

        // ======================= 4. 进程内：协作附件解析根与 server.js 同源（A1）=======================
        section('4 collab-submit-helpers / periodic-fetch 目录与实例数据根同源（偏差 A1 / A3）');
        {
            const D = makeInstance('inproc');
            const saved = {};
            for (const k of ['SDH_INSTANCE', 'SDH_DATA_DIR', 'SDH_DB_FILE']) saved[k] = process.env[k];
            const helperPath = require.resolve('../utils/collab-submit-helpers');
            const runnerPath = require.resolve('../routes/periodic-fetch/runner');
            try {
                process.env.SDH_INSTANCE = D.id;
                process.env.SDH_DATA_DIR = D.dataDir;
                process.env.SDH_DB_FILE = D.dbFile;
                mode._resetInstanceConfigForTest();
                delete require.cache[helperPath];
                delete require.cache[runnerPath];
                const helpers = require('../utils/collab-submit-helpers');
                const runner = require('../routes/periodic-fetch/runner');
                const cfg = mode.getInstanceConfig();
                must(cfg.mode === 'isolated' && cfg.uploadDir === path.join(D.dataDir, 'uploads'), '进程内隔离配置：uploadDir 在数据根下', JSON.stringify(cfg));
                must(helpers.resolveAttachmentPath('collab/x/1.xlsx') === path.resolve(D.dataDir, 'uploads', 'collab/x/1.xlsx'), 'resolveAttachmentPath 的根 = <数据根>/uploads（与 server.js 的 UPLOAD_DIR 同源）', helpers.resolveAttachmentPath('collab/x/1.xlsx'));
                must(helpers.resolveAttachmentPath('collab/x/1.xlsx') !== path.resolve(WBS, 'uploads', 'collab/x/1.xlsx'), '隔离模式下附件解析根不再指向检出目录的 uploads');
                must(runner.PERIODIC_RESULTS_DIR === path.join(D.dataDir, 'periodic-results'), 'periodic-fetch 结果目录 = <数据根>/periodic-results');
                // 与真实运行的 server.js 落点一致：用例 1 的实例 A 在其数据根下建了同名目录
                must(fs.existsSync(path.join(A.dataDir, 'uploads', 'collab')) && fs.existsSync(path.join(A.dataDir, 'periodic-results')), '同一规则在真实 server.js 子进程里的落点（用例 1）一致：<数据根>/uploads/collab、<数据根>/periodic-results');
            } finally {
                for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
                mode._resetInstanceConfigForTest();
                delete require.cache[helperPath];
                delete require.cache[runnerPath];
            }
        }

        // ======================= 5. 外部调用闸（S1b）=======================
        section('5 外部调用闸（S1b）：钉钉替身 / 外部库 EXTERNAL_DISABLED / 文档只读 / 周期任务关闭下的一次性维护');
        {
            const jwt = require('jsonwebtoken');
            const E = makeInstance('external');
            // 来源库：已建好全部表的库（预热段产出）的一份拷贝，下面往里预置“生产形态”数据；目标 E.dbFile 由 createIsolatedDb 用 VACUUM INTO 自己创建（原先不存在）
            const E_SRC = path.join(ROOT, `${E.id}-source.db`);
            fs.copyFileSync(TEMPLATE_DB, E_SRC);
            const REAL_KEY = 'real-production-key-0123456789abcdef-xyz';
            const realCipher = aes.encryptWithKey(REAL_KEY, 'Pr0dPassw0rd!');
            const DEV_PHONE = '13812345678';
            // 预置（测试进程直接写临时库，不碰业务库）：开发账号（带手机号）、两条带「真实形态密文」的外部库连接（地址用不可路由的 TEST-NET，万一发出连接也会被守卫截停）、
            //   一条旧算法（raw_v0）的实现对象（用来证明周期任务关闭后一次性的 norm_v1 重算照常跑）
            await execSqlRW(E_SRC, `INSERT INTO users (username, password, display_name, role, status, phone) VALUES ('sdh-dev-s1b', 'x', 'S1B开发', 'user', 'active', '${DEV_PHONE}')`);
            await seedExternalConnections(E_SRC, realCipher);
            await execSqlRW(E_SRC, `INSERT INTO model_impl_objects (obj_type, db_connection_id, schema_name, obj_name, reg_source, reg_hash, hash_algo, is_deleted) VALUES ('PROC', NULL, 'dbo', 'sdh_s1b_probe', 'CREATE PROC dbo.sdh_s1b_probe AS SELECT 1', 'raw-old-hash', 'raw_v0', 0)`);
            const srcShaBefore = crypto.createHash('sha256').update(fs.readFileSync(E_SRC)).digest('hex');
            const prep = await instanceDb.createIsolatedDb({ sourceDbPath: E_SRC, targetDbPath: E.dbFile, instanceId: E.id, parent: E.parent, from: 'verify-instance-startup', sourceEncryptionKey: null });
            must(prep.dbConnectionsCleared >= 2, 'createIsolatedDb 清空了预置的外部库口令（>= 2 行）', JSON.stringify(prep));
            must(crypto.createHash('sha256').update(fs.readFileSync(E_SRC)).digest('hex') === srcShaBefore, 'createIsolatedDb 没有改动来源库（sha256 前后一致）');
            const adminRow = await readonlyAll(E.dbFile, 'SELECT id, role, status FROM users WHERE id = 1');
            must(adminRow.length === 1 && adminRow[0].role === 'admin' && adminRow[0].status === 'active', '前提：库里有内置管理员 id=1（用来签 JWT）', JSON.stringify(adminRow));
            const devRow = await readonlyAll(E.dbFile, "SELECT id FROM users WHERE username = 'sdh-dev-s1b'");
            const docsBefore = docsFingerprint();
            const token = jwt.sign({ id: 1, username: 'admin', role: 'admin', display_name: '管理员' }, TEST_JWT_SECRET, { expiresIn: '10m' });

            const portE = await pickPort();
            const srvE = spawnServer(E, { port: portE, env: { DB_ENCRYPTION_KEY: REAL_KEY } });   // 进程里放着「真」键：隔离实例必须忽略它
            const readyE = await waitReady(srvE, 90000);
            must(readyE.ready, `外部调用闸实例就绪（端口 ${portE}）`, `${readyE.reason || ''}\n${tail(srvE, 25)}`);
            if (readyE.ready) {
                must(readyE.version.mode === 'isolated' && readyE.version.external === 'stub' && readyE.version.background === 'off', '/api/version：isolated / stub / off', JSON.stringify(readyE.version));

                // ---- 钉钉配置测试接口（虚拟凭证 -> 前置校验通过 -> 请求走到闸门）----
                const cfgGet = await httpJsonRetry(portE, 'GET', '/api/admin/dingtalk-config', undefined, token, [0, 403, 500, 503]);
                must(cfgGet.status === 200 && cfgGet.json && cfgGet.json.configured === true && cfgGet.json.platform_base_url === instanceDb.VIRTUAL_DINGTALK_CONFIG.platform_base_url,
                    'GET /api/admin/dingtalk-config：configured=true（虚拟凭证用隔离键读得出来）、platform_base_url 为虚拟值', JSON.stringify(cfgGet));
                const cfgTest = await httpJson(portE, 'POST', '/api/admin/dingtalk-config/test', {}, token);
                must(cfgTest.status === 200 && cfgTest.json && cfgTest.json.ok === true, 'POST /api/admin/dingtalk-config/test：走完 gettoken 替身，ok=true', JSON.stringify(cfgTest));

                // ---- 一条真实业务通知路径：需求跟踪「通知开发」（取配置 -> gettoken -> 手机号反查 userid -> 发 markdown -> 落库 message_key）----
                const created = await httpJsonRetry(portE, 'POST', '/api/issues', {
                    title: 'S1B 钉钉替身验证', type: '平台 bug', requester_dept: '信息技术部', requester_name: '测试业务方', requester_phone: '13900001111',
                    assigned_to: devRow[0].id, description: 'verify-instance-startup 第 5 段',
                }, token);
                must(created.status === 200 && created.json && Number.isInteger(created.json.id), '创建需求（指派给带手机号的开发账号）', JSON.stringify(created));
                if (created.status === 200 && created.json) {
                    const notified = await httpJson(portE, 'POST', `/api/issues/${created.json.id}/notify-developer`, {}, token);
                    must(notified.status === 200 && notified.json && notified.json.success === true && /^sdh-stub-pqk-/.test(notified.json.message_key || ''),
                        '通知开发：业务流程走完（HTTP 200、success、message_key 为替身 processQueryKey）', JSON.stringify(notified));
                    const detail = await httpJson(portE, 'GET', `/api/issues/${created.json.id}`, undefined, token);
                    must(detail.status === 200 && detail.json && detail.json.notify_status === 'sent' && detail.json.notify_message_key === (notified.json && notified.json.message_key),
                        '需求行 notify_status=sent、notify_message_key 已落库', JSON.stringify(detail.json && { s: detail.json.notify_status, k: detail.json.notify_message_key }));
                }
                const logFileE = path.join(E.dataDir, 'external-calls.jsonl');
                must(fs.existsSync(logFileE), `external-calls.jsonl 写在数据根下（${logFileE}）`);
                const recs = fs.existsSync(logFileE) ? fs.readFileSync(logFileE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
                const apisE = recs.map((r) => r.api);
                for (const a of ['/gettoken', '/user/get_by_mobile', '/v1.0/robot/oToMessages/batchSend']) must(apisE.includes(a), `external-calls.jsonl 含 ${a} 的调用记录`, apisE.join(' '));
                must(recs.length > 0 && recs.every((r) => r.at && r.method && r.params && r.outcome === 'stubbed'), '每条记录都有 at / api / method / params，且都是替身处理（无未识别调用）', JSON.stringify(recs.filter((r) => r.outcome !== 'stubbed')));
                const logTextE = fs.existsSync(logFileE) ? fs.readFileSync(logFileE, 'utf8') : '';
                must(logTextE.length > 0 && !logTextE.includes(instanceDb.VIRTUAL_DINGTALK_CONFIG.dingtalk_app_secret), '日志已脱敏：搜不到虚拟 appsecret 原文');
                must(logTextE.length > 0 && !logTextE.includes(instanceDb.VIRTUAL_DINGTALK_CONFIG.dingtalk_app_key), '日志已脱敏：搜不到虚拟 appkey 原文');
                must(logTextE.length > 0 && !logTextE.includes('sdh-stub-access-token'), '日志已脱敏：搜不到 access_token 原文');
                must(logTextE.length > 0 && !logTextE.includes(DEV_PHONE) && logTextE.includes('138****5678'), '日志已脱敏：手机号只留前三后四');
                must(logTextE.length > 0 && !logTextE.includes('S1B 钉钉替身验证'), '日志里没有消息正文 / 标题');

                // ---- 外部库：两种类型都 EXTERNAL_DISABLED，且没有真实连接发出（守卫标记 + 响应）----
                for (const type of ['sqlserver', 'mysql']) {
                    const r = await httpJson(portE, 'POST', '/api/db-connections/test-new', { type, host: '192.0.2.99', port: type === 'mysql' ? 3306 : 1433, database: 'x', username: 'u', password: 'p' }, token);
                    must(r.status === 500 && r.json && r.json.success === false && r.json.code === 'EXTERNAL_DISABLED' && /EXTERNAL_DISABLED/.test(r.json.error || ''),
                        `POST /api/db-connections/test-new（${type}）：失败响应含 EXTERNAL_DISABLED`, JSON.stringify(r));
                }
                const connRows = await readonlyAll(E.dbFile, "SELECT id, password FROM db_connections WHERE host LIKE '192.0.2.%' ORDER BY id");
                must(connRows.length === 2 && connRows.every((c) => c.password === ''), '预置的外部库连接口令已被 createIsolatedDb 清空（空串）', JSON.stringify(connRows));
                const t3 = await httpJson(portE, 'POST', `/api/db-connections/${connRows[0].id}/test`, {}, token);
                must(t3.status === 500 && t3.json && t3.json.success === false, '已保存连接的测试接口：解不出口令 / 外部库被禁，失败而不是成功', JSON.stringify(t3));

                // ---- 文档发布：409，且在任何文件操作之前 ----
                const pub = await httpJson(portE, 'POST', '/api/docs/publish', { old_filename: 'docs/sdh-s1b-probe-old.md', new_filename: 'docs/sdh-s1b-probe-new.md' }, token);
                must(pub.status === 409 && pub.json && pub.json.code === 'ISOLATED_DOCS_READONLY', 'POST /api/docs/publish：409 ISOLATED_DOCS_READONLY（不是 404 文件不存在——说明在任何文件检查之前就拒绝了）', JSON.stringify(pub));
                // 辅助：探针文件本就不存在，闸门即使失效也只会 404、不动磁盘，所以这条按构造恒绿，不证明闸门；起判别作用的是上一条「409 且不是 404」
                must(docsFingerprint() === docsBefore, '辅助：docs 目录指纹不变（顶层目录项与 docs/archive 文件清单一致；不证明闸门，见上一条）');
                const docsList = await httpJson(portE, 'GET', '/api/docs', undefined, token);
                must(docsList.status === 200, '读接口 GET /api/docs 不受影响', JSON.stringify(docsList).slice(0, 200));

                // ---- 周期任务关闭，但启动期一次性维护照常 ----
                const recalc = await waitForLog(srvE, /\[impl-objects\] norm_v1 重算完成：扫描 1 行，更新 1 行/, 60000);
                must(recalc, '周期任务关闭（background=off）下，模型中心启动期的一次性 norm_v1 重算照常执行（扫描 1 行，更新 1 行）', tail(srvE, 30));
                must(!SCHED_VERIFY_LOG.test(srvE.out) && !SCHED_SWEEP_LOG.test(srvE.out), '两个周期任务都没有排定（没有「每日核验已排定」「周期扫描已排定」）', tail(srvE, 30));
                const pvE = await probeImplVerify(portE, TEST_JWT_SECRET);
                must(pvE.status === 503 && pvE.json && pvE.json.code === 'VERIFY_DISABLED', '三端核验关闭（手动核验端点 503 VERIFY_DISABLED）', JSON.stringify(pvE));
            }
            must(!fs.existsSync(srvE.marker), '守卫未触发：没有打开测试根之外的库、没有监听其他端口、没有向非回环地址发起连接 / fetch（用例 5）', fs.existsSync(srvE.marker) ? fs.readFileSync(srvE.marker, 'utf8') : '');
            await stopServer(srvE);
            must(srvE.exited && !pidAlive(srvE.pid), '外部调用闸实例已退出');
            const implAfter = await readonlyAll(E.dbFile, "SELECT hash_algo, reg_hash FROM model_impl_objects WHERE obj_name = 'sdh_s1b_probe'");
            must(implAfter.length === 1 && implAfter[0].hash_algo === 'norm_v1' && implAfter[0].reg_hash && implAfter[0].reg_hash !== 'raw-old-hash', '一次性重算的结果落库：hash_algo = norm_v1、reg_hash 已重算', JSON.stringify(implAfter));
            const idAfterE = await instanceDb.checkInstanceIdentity(E.dbFile, { expectedInstance: E.id, expectedParent: E.parent });
            must(idAfterE.ok, '运行后库内身份仍一致', JSON.stringify(idAfterE));
        }

        // ======================= 6. 收尾核对 =======================
        section('6 收尾：业务库、检出目录、子进程');
        must(statKey(REAL_DB) === realDbBefore, '业务库 task_pool.db 全程 size / mtime 不变（未被打开写入）', `${realDbBefore} -> ${statKey(REAL_DB)}`);
        const finalSnap = snapshotCheckout();
        must(JSON.stringify(finalSnap) === JSON.stringify(checkoutBefore), '全部用例结束后，检出目录下依旧没有新增或删除的目录项', JSON.stringify({ before: checkoutBefore, after: finalSnap }));
    } catch (e) {
        bad('未预期异常', e && e.stack);
    } finally {
        for (const rec of children) await stopServer(rec);
        // 调试 / 留证：设置 S1A_LOG_DIR（绝对路径）则把每个子进程的完整日志落盘
        if (process.env.S1A_LOG_DIR && path.isAbsolute(process.env.S1A_LOG_DIR)) {
            try {
                fs.mkdirSync(process.env.S1A_LOG_DIR, { recursive: true });
                children.forEach((rec, i) => fs.writeFileSync(path.join(process.env.S1A_LOG_DIR, `child-${String(i + 1).padStart(2, '0')}-port${rec.port}.log`), rec.out));
            } catch (_) { /* 留证失败不影响结论 */ }
        }
        must(children.length > 0 && children.every((r) => r.exited && !pidAlive(r.pid)), `全部 ${children.length} 个子进程已退出`);
        try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) { bad('临时目录清理失败', e && e.message); }
        must(!fs.existsSync(ROOT), '临时根目录已删除');
        console.log(`\nverify-instance-startup PASS=${pass} FAIL=${fail}`);
        if (fail) {
            for (const rec of children) { if (rec.exitCode !== 1 && rec.exitCode !== null && rec.exitCode !== 0) console.log(`(子进程 pid=${rec.pid} exit=${rec.exitCode})`); }
        }
        process.exit(fail ? 1 : 0);
    }
})();
