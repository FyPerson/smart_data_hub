/**
 * #106 S8b 自检：部署就绪检查 scripts/deploy/ready-check.js。
 *
 * 进程内用 http.createServer 起假服务器（127.0.0.1，经 scripts/lib/listen-safe-port.js 的 listenOnSafePort 取 20000–49999 的端口，
 * 不用 listen(0)：仓库有「禁系统分配端口」守卫），按用例返回可控的 /api/version、/api/health/ready 与页面；用子进程（异步 spawn，参数数组）跑 ready-check.js。
 * 不起真实实例、不碰业务库、不读 .env、不碰生产地址；临时 git 仓库与目录都建在 os.tmpdir() 下，结束时删除。
 *
 * 节：
 *   A 正常：全部正常 OK（页面编码 / 顺序 / 只发 GET / 不进页面检查直到前两项过）；第 N 轮才变正常（version 不符若干轮、ready 503 若干轮）→ OK；本机代理环境变量不被使用
 *   B 失败（短超时）：commit / version / mode / external / background / instance 各一例不符；version 非 200 / 非 JSON；ready 503（含「503 但体看着全好」）/ ok:false /
 *     200 且某模块 ready:false（含 "yes" / 1）/ modules 为空；某页含 ?v=auto；某页 404 / 302；version 302；缺字段报「(缺失)」；端口无人监听 → 连接错误；
 *     服务器不应答 / 发完响应头后响应体挂住 → REQUEST_TIMEOUT；页面永不应答时单请求超时被总期限截短；压缩（无视请求一律 gzip → 判坏；只在被要求时才压缩 → 通过，证明发的是 identity）；
 *     commit 为 null 时顶层 hint COMMIT_NULL；输出里不出现响应体原文
 *   C 参数错误（退出码 2，假服务器零请求）：缺 --expect-commit / --base-url / --expect-version、坏 sha、坏版本、坏 URL、两种页面来源同给 / 都不给、--repo 配 --pages 等；
 *     --check-args 零请求（连不上的地址也成功）；READY_INTERNAL 的静态钉
 *   D --pages-from-commit（临时 git 仓库）：只取 html / htm、取的是指定提交的文件而不是 HEAD 或工作区；未知提交 / 无页面 → 参数错误；--check-args 取页面清单
 *   H 演练的源文件检查（drill-deploy-failures.js 导出的 checkSource / enumerateDbFiles）：在 os.tmpdir() 下自建假的 wbs-server 树与备份目录，
 *     验证白名单目录、嵌套目录里的 .db 硬链接被拒绝、枚举出错拒绝运行、目录联接成环不死循环、node_modules 不枚举
 *   E 判别力（变异自证，默认运行）：临时副本上改被测脚本（ready-check.js 或内存里的演练脚本），变异共 45 个；每个变异登记「期望变红的具体行为断言名前缀」，
 *     判红要求套件失败且至少命中一个；运行故障（子进程被外层终止）不计为检出（靠挂住检出的两类变异除外）；变异个数与本头注释、FAMILY 里 S8b 那段注释互相核对
 *
 * 运行：node wbs-server/scripts/verify-deploy-ready-check.js
 *   内部参数（E 节递归调用自己用）：--deploy-dir=<被测 scripts/deploy 目录的绝对路径>  --no-mutations  --only=<节字母>  --drill-edits=<演练脚本变异的 json 文件>
 *   子进程并发上限见 B_CONCURRENCY / MUTATION_WORKERS 处的注释（整套同时存在的 node 子进程约 33 个以内）。
 * 输出：失败用例逐行 `FAIL <名字> :: <细节>`；末行 `PASS=<n> FAIL=<m>`；有失败退出码 1。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { spawn, execFileSync } = require('child_process');
const { listenOnSafePort } = require('./lib/listen-safe-port');

const argOf = (prefix) => process.argv.find((a) => a.startsWith(prefix));
const DEPLOY_ARG = argOf('--deploy-dir=');
const DEPLOY_DIR = path.resolve(DEPLOY_ARG ? DEPLOY_ARG.slice('--deploy-dir='.length) : path.join(__dirname, '..', '..', 'scripts', 'deploy'));
const RUN_MUTATIONS = !process.argv.includes('--no-mutations');
const ONLY_ARG = argOf('--only=');
const ONLY = ONLY_ARG ? new Set(ONLY_ARG.slice('--only='.length).split('')) : null;   // E 节递归调用自己时只跑与该变异相关的节（A/B/C/D），省时间；缺省全跑
const runSection = (letter) => ONLY === null || ONLY.has(letter);
const READY_JS = path.join(DEPLOY_DIR, 'ready-check.js');

// ---------------------------------------------------------------- 并发上限
//   子进程总数上限：B 节用例池 B_CONCURRENCY 个并发；变异阶段 MUTATION_WORKERS 个变异同时跑，每个变异的嵌套运行最多再占 B_CONCURRENCY 个（+1 个递归自检进程）。
//   所以整套同时存在的 node 子进程上限 = MUTATION_WORKERS × (1 + B_CONCURRENCY) + B 节自己 ≈ 3 × 11 = 33（不含各自短命的 git）。
//   不再用「全部用例一起 Promise.all」——并发太高时调度延迟会让带固定时间窗的断言偶发红。
const B_CONCURRENCY = 10;
const MUTATION_WORKERS = 3;

/** 最多 limit 个并发地对 items 逐个跑 fn，按原顺序返回结果 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------- 断言与汇总

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; return true; }
  fail += 1;
  console.log(`FAIL ${name}${detail === undefined ? '' : ` :: ${String(detail).replace(/\s*[\r\n]+\s*/g, ' ')}`}`);
  return false;
}
const eq = (name, actual, expected) => check(name, JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);

// ---------------------------------------------------------------- 临时目录

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sdh-deploy-ready-'));
let seq = 0;
function freshDir(label) {
  seq += 1;
  const d = path.join(TMP_ROOT, `${label}-${seq}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function removeTree(p) {
  let st;
  try { st = fs.lstatSync(p); } catch (_) { return; }
  if (st.isDirectory() && !st.isSymbolicLink()) {
    for (const n of fs.readdirSync(p)) removeTree(path.join(p, n));
    fs.rmdirSync(p);
  } else {
    fs.unlinkSync(p);
  }
}

// ---------------------------------------------------------------- 假服务器

const SHA = '1234567890abcdef1234567890abcdef12345678';
const SHA_OTHER = 'fedcba0987654321fedcba0987654321fedcba09';
const VERSION = '1.2.3';
const MARKER = 'SECRET-BODY-MARKER-9f3a1c';

const goodVersion = () => ({ version: VERSION, name: `智数协同平台${MARKER}`, nameEn: 'Smart Data Hub', mode: 'normal', instance: null, external: 'real', background: 'on', commit: SHA });
const goodReady = () => ({ ok: true, instance: null, mode: 'normal', modules: { core: { ready: true, code: null }, issue: { ready: true, code: null }, it_ledger: { ready: true, code: null } } });
const PAGE_OK = '<!doctype html><html><head><script src="/assets/js/app.js?v=0123456789ab"></script></head><body>ok</body></html>';

/** 用例状态：version / ready 可以是对象或 (第几次请求 从 0 起) => 对象；status 同理 */
function makeState(over) {
  return Object.assign({
    version: goodVersion,
    versionStatus: 200,
    versionRaw: null,
    ready: goodReady,
    readyStatus: 200,
    pageStatus: {},
    pageBody: {},
    hangVersion: false,        // /api/version 永不应答
    hangVersionBody: false,    // /api/version 发完响应头和半截体后挂住
    hangPages: false,          // 页面请求永不应答
    hangPageBody: {},          // { '/a.html': true }：该页发完响应头和半截体后挂住
    gzipVersion: false,        // false | 'always'（无视请求一律压缩）| 'ifAsked'（请求声明接受 gzip 才压缩）
    gzipPages: false,
    gzipReady: false,
    location: '/login.html',   // 3xx 时的 Location
  }, over || {});
}
const at = (v, n) => (typeof v === 'function' ? v(n) : v);

/** 按 gzip 模式发送：mode = 'always' 无视请求头一律 gzip；'ifAsked' 只有请求头的 Accept-Encoding 含 gzip 才 gzip */
function sendBody(req, res, mode, body) {
  const asked = /gzip/i.test(String(req.headers['accept-encoding'] || ''));
  if (mode === 'always' || (mode === 'ifAsked' && asked)) {
    res.setHeader('Content-Encoding', 'gzip');
    res.end(zlib.gzipSync(Buffer.from(body, 'utf8')));
  } else {
    res.end(body);
  }
}

async function withServer(state, fn) {
  const hits = [];
  const counts = { version: 0, ready: 0 };
  const pageCounts = {};
  const server = http.createServer((req, res) => {
    const url = req.url;
    hits.push({ method: req.method, url, acceptEncoding: req.headers['accept-encoding'] === undefined ? null : req.headers['accept-encoding'] });
    if (url === '/api/version') {
      const n = counts.version; counts.version += 1;
      if (state.hangVersion) return;   // 永不应答
      const status = at(state.versionStatus, n);
      res.statusCode = status;
      if (status >= 300 && status < 400) res.setHeader('Location', state.location);
      if (state.hangVersionBody) { res.setHeader('Content-Type', 'application/json'); res.write('{"version":'); return; }
      if (state.versionRaw !== null) { res.setHeader('Content-Type', 'text/plain'); res.end(at(state.versionRaw, n)); return; }
      res.setHeader('Content-Type', 'application/json');
      sendBody(req, res, state.gzipVersion, JSON.stringify(at(state.version, n)));
      return;
    }
    if (url === '/api/health/ready') {
      const n = counts.ready; counts.ready += 1;
      res.statusCode = at(state.readyStatus, n);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      sendBody(req, res, state.gzipReady, JSON.stringify(at(state.ready, n)));
      return;
    }
    let decoded = url;
    try { decoded = decodeURIComponent(url); } catch (_) { /* 保留原样 */ }
    if (state.hangPages) return;
    res.statusCode = state.pageStatus[decoded] === undefined ? 200 : state.pageStatus[decoded];
    if (res.statusCode >= 300 && res.statusCode < 400) res.setHeader('Location', state.location);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (state.hangPageBody[decoded]) { res.write('<!doctype html><html>'); return; }
    // 按「该页第几次被请求」切换响应（不依赖墙钟）：pageBodyAt(path, n) 返回页面体，返回 undefined 则用静态 pageBody / PAGE_OK
    const nth = pageCounts[decoded] === undefined ? 0 : pageCounts[decoded];
    pageCounts[decoded] = nth + 1;
    let body = state.pageBody[decoded] === undefined ? PAGE_OK : state.pageBody[decoded];
    if (typeof state.pageBodyAt === 'function') { const b = state.pageBodyAt(decoded, nth); if (b !== undefined) body = b; }
    sendBody(req, res, state.gzipPages, body);
  });
  await listenOnSafePort(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn({ base, hits, counts });
  } finally {
    await new Promise((resolve) => { server.close(() => resolve()); if (server.closeAllConnections) server.closeAllConnections(); });
  }
}

/** 取一个保留后立即释放的空闲端口 */
async function deadPort() {
  const s = http.createServer(() => {});
  await listenOnSafePort(s);
  const port = s.address().port;
  await new Promise((resolve) => s.close(() => resolve()));
  return port;
}

// ---------------------------------------------------------------- 运行被测脚本

function cleanEnv(extra) {
  const env = Object.assign({}, process.env);
  for (const k of Object.keys(env)) {
    if (/^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|NODE_USE_ENV_PROXY)$/i.test(k) || /^GIT_(DIR|COMMON_DIR|WORK_TREE|INDEX_FILE)$/i.test(k)) delete env[k];
  }
  return Object.assign(env, extra || {});
}

function parseProtocol(stdout) {
  const lines = String(stdout).split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l !== '');
  const last = lines.length ? lines[lines.length - 1] : '';
  const m = /^(READY_OK|READY_FAIL|READY_ARGS_OK) (\{.*\})$/.exec(last);
  let json = null;
  if (m) { try { json = JSON.parse(m[2]); } catch (_) { json = null; } }
  return { kind: m ? m[1] : null, json, protocolLines: lines.filter((l) => /^READY_(OK|FAIL|ARGS_OK) /.test(l)).length, last };
}

function runReady(args, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [READY_JS, ...args], { env: cleanEnv(o.env), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killed = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const t0 = Date.now();
    const killer = setTimeout(() => { killed = true; child.kill(); }, o.timeoutMs || 60000);
    child.on('close', (code) => {
      clearTimeout(killer);
      // 被外层终止是「运行故障」：打一行 FAULT，变异判红时区分「目标断言失败」与「运行故障」（后者不计为检出，登记了 faultOk 的变异除外——它们的检出方式就是挂住）
      if (killed) console.log(`FAULT 子进程被外层终止（${o.timeoutMs || 60000} ms）：${args.slice(0, 4).join(' ')}`);
      resolve(Object.assign({ status: killed ? 'KILLED' : code, stdout, stderr, wallMs: Date.now() - t0 }, parseProtocol(stdout)));
    });
  });
}

const baseArgs = (base, extra) => ['--base-url', base, '--expect-commit', SHA, '--expect-version', VERSION].concat(extra || []);
const PAGES = ['a.html', 'sub/b c.html', '中文.html'];
const withPages = (base, extra) => baseArgs(base, ['--pages', PAGES.join(',')].concat(extra || []));
// B 组（期望失败、要等满总期限）的总期限与轮询间隔。被测脚本的轮询是「睡 min(间隔, 剩余) 后，剩余 ≥ 50 ms 就再来一轮」，所以最后一轮的预算 = 总期限 mod 周期，落在 50 ms 到一个间隔之间：
//   间隔 200 ms 时最后一轮只有 50–200 ms，而一轮要连发 version / ready / 逐页共 3–5 个请求；机器一忙（多份 FAMILY 并跑、变异阶段 3 路 × 10 个子进程），
//   最后一轮被总期限截断，截断的半截观察（stage 停在 ready / pages 且 bad 为空，或页面请求记 REQUEST_TIMEOUT）覆盖掉上一轮的完整观察，B12 / B15 / B16 / B19 / B22 与变异 R-响应体 随机变红（S10 演练）。
//   间隔取总期限的一半：设第 1 轮耗时 d，第 2 轮约在 FAST_INTERVAL_MS + d 开始、预算约 FAST_INTERVAL_MS − d，随后睡到期限、剩余 < 50 ms 即收尾，通常 2 轮；
//   d 很大（第 1 轮本身就慢到接近 1.5 秒）时仍可能截断甚至只有 1 轮——新参数只是把抖动余量从 50–200 ms 提到约 1.5 秒，不是「恒 2 轮」的保证（codex 45 L2）。
//   残余（预筛 L3 / codex 45 L1）：新参数下「末轮 version 因期限不足超时、保留上一轮观察」这一分支不再被 B 组稳定触发，需要另加定向用例才能守住它。
const FAST_TIMEOUT_SEC = 3;
const FAST_INTERVAL_MS = 1500;
const FAST = ['--timeout-sec', String(FAST_TIMEOUT_SEC), '--interval-ms', String(FAST_INTERVAL_MS)];
// 期望成功 / 期望参数错误的运行也带一个短总期限：被测代码（或变异）走偏时是在几秒内以 READY_FAIL 结束，而不是挂到外层 60 秒终止（那是运行故障，不算检出）
const OK_T = ['--timeout-sec', '8', '--interval-ms', '200'];
const ARGS_T = ['--timeout-sec', '3', '--interval-ms', '200'];

function expectTimeoutFail(name, r, stage) {
  eq(`${name}: 退出码`, r.status, 1);
  check(`${name}: 最后一行是 READY_FAIL 协议`, r.kind === 'READY_FAIL' && r.json !== null, r.last);
  eq(`${name}: 协议行只有一条`, r.protocolLines, 1);
  eq(`${name}: code`, r.json && r.json.code, 'READY_TIMEOUT');
  eq(`${name}: lastObserved.stage`, r.json && r.json.lastObserved && r.json.lastObserved.stage, stage);
  check(`${name}: 轮询了不止一轮且等满了超时`, r.json && r.json.rounds >= 2 && r.json.elapsedMs >= FAST_TIMEOUT_SEC * 1000 - 100, r.json && `rounds=${r.json.rounds} elapsedMs=${r.json.elapsedMs}`);
  check(`${name}: 输出里没有响应体原文`, !r.stdout.includes(MARKER) && !r.stdout.includes('<html'), r.stdout);
}

// ---------------------------------------------------------------- A 正常

async function sectionNormal() {
  // A1 全部正常
  await withServer(makeState(), async ({ base, hits }) => {
    const r = await runReady(withPages(base, OK_T));
    eq('A1 退出码', r.status, 0);
    check('A1 最后一行是 READY_OK 协议', r.kind === 'READY_OK' && r.json !== null, r.last);
    eq('A1 协议行只有一条', r.protocolLines, 1);
    eq('A1 json 的 rounds / pages / version / commit', r.json && [r.json.rounds, r.json.pages, r.json.version, r.json.commit], [1, 3, VERSION, SHA]);
    check('A1 json 有 elapsedMs', r.json && Number.isInteger(r.json.elapsedMs) && r.json.elapsedMs >= 0, r.last);
    check('A1 只发 GET', hits.every((h) => h.method === 'GET'), JSON.stringify(hits.map((h) => h.method)));
    eq('A1 请求顺序：version → ready → 逐页（页面名编码，中文与空格）', hits.map((h) => h.url), ['/api/version', '/api/health/ready', '/a.html', '/sub/b%20c.html', '/%E4%B8%AD%E6%96%87.html']);
    check('A1 输出里没有响应体原文', !r.stdout.includes(MARKER) && !r.stdout.includes('<html'), r.stdout);
    check('A1 每个请求都显式发 Accept-Encoding: identity', hits.length === 5 && hits.every((h) => h.acceptEncoding === 'identity'), JSON.stringify(hits.map((h) => h.acceptEncoding)));
  });

  // A2 第 N 轮才变正常：version 前 3 次是旧提交
  await withServer(makeState({ version: (n) => (n < 3 ? Object.assign(goodVersion(), { commit: SHA_OTHER }) : goodVersion()) }), async ({ base, hits, counts }) => {
    const r = await runReady(withPages(base, ['--timeout-sec', '10', '--interval-ms', '200']));
    eq('A2 version 前 3 次不符、之后正常：退出码', r.status, 0);
    check('A2 rounds = 4（第 4 轮才过）', r.json && r.json.rounds === 4, r.last);
    eq('A2 version 被请求 4 次', counts.version, 4);
    check('A2 不符的几轮里没有请求 ready 与页面', hits.slice(0, 3).every((h) => h.url === '/api/version'), JSON.stringify(hits.slice(0, 4)));
  });
  // A3 ready 前 2 次 503
  await withServer(makeState({ readyStatus: (n) => (n < 2 ? 503 : 200), ready: (n) => (n < 2 ? { ok: false, instance: null, mode: 'normal', modules: { core: { ready: false, code: 'NOT_READY' } } } : goodReady()) }), async ({ base, counts }) => {
    const r = await runReady(withPages(base, ['--timeout-sec', '10', '--interval-ms', '200']));
    eq('A3 ready 前 2 次 503、之后正常：退出码', r.status, 0);
    check('A3 rounds = 3', r.json && r.json.rounds === 3, r.last);
    eq('A3 ready 被请求 3 次', counts.ready, 3);
  });
  // A4 页面前 2 次请求含 ?v=auto（部署刚完成、注入还没生效的情形）→ 之后正常。按「该页第几次被请求」切换，不依赖墙钟
  await withServer(makeState({ pageBodyAt: (p, n) => (p === '/a.html' && n < 2 ? '<html><script src="/x.js?v=auto"></script></html>' : undefined) }), async ({ base }) => {
    const r = await runReady(withPages(base, ['--timeout-sec', '10', '--interval-ms', '200']));
    eq('A4 页面先两次含 ?v=auto、之后正常：退出码', r.status, 0);
    check('A4 rounds = 3（第 3 轮才过）', r.json && r.json.rounds === 3, r.last);
  });
  // A5 本机代理环境变量不被使用
  {
    const dead = await deadPort();
    const proxy = `http://127.0.0.1:${dead}`;
    await withServer(makeState(), async ({ base, hits }) => {
      const r = await runReady(withPages(base, OK_T), { env: { HTTP_PROXY: proxy, http_proxy: proxy, HTTPS_PROXY: proxy, https_proxy: proxy, ALL_PROXY: proxy, NODE_USE_ENV_PROXY: '1' } });
      eq('A5 设了代理环境变量（指向无人监听的端口）：退出码', r.status, 0);
      check('A5 请求确实直达假服务器', hits.length === 5, hits.length);
    });
  }
  // A7 服务器只在客户端声明接受 gzip 时才压缩（version / ready / 页面都是）：ready-check 发 identity，所以拿到明文 → 通过（证明请求头确实是 identity）
  await withServer(makeState({ gzipVersion: 'ifAsked', gzipReady: 'ifAsked', gzipPages: 'ifAsked' }), async ({ base, hits }) => {
    const r = await runReady(withPages(base, OK_T));
    eq('A7 只在客户端要求时才 gzip 的服务器：退出码', r.status, 0);
    check('A7 请求头确实是 identity', hits.length === 5 && hits.every((h) => h.acceptEncoding === 'identity'), JSON.stringify(hits.map((h) => h.acceptEncoding)));
  });
  // A6 期望值覆盖：测试实例形态（mode isolated / external stub / background off / instance 名）
  await withServer(makeState({ version: () => Object.assign(goodVersion(), { mode: 'isolated', external: 'stub', background: 'off', instance: 'test-abc' }) }), async ({ base }) => {
    const r = await runReady(withPages(base, ['--expect-mode', 'isolated', '--expect-external', 'stub', '--expect-background', 'off', '--expect-instance', 'test-abc'].concat(OK_T)));
    eq('A6 期望值覆盖为测试实例形态：退出码', r.status, 0);
  });
}

// ---------------------------------------------------------------- B 失败

/** 一批失败用例并发跑（每个用例自己的假服务器），再按顺序断言 */
async function sectionFailures() {
  const cases = [];
  const addCase = (name, state, extraArgs, assertFn, opts) => cases.push({ name, state, extraArgs, assertFn, opts });

  // 不符的字段（各一例）
  const mismatchCase = (name, over, extraArgs, field, expected, actual, hint) => addCase(name, makeState({ version: () => Object.assign(goodVersion(), over) }), extraArgs || [], (r, ctx) => {
    expectTimeoutFail(name, r, 'version');
    eq(`${name}: mismatches 只有这一个字段`, r.json && r.json.lastObserved && r.json.lastObserved.mismatches, [{ field, expected, actual }]);
    eq(`${name}: 没有请求 ready 与页面`, ctx.hits.filter((h) => h.url !== '/api/version').length, 0);
    eq(`${name}: 顶层 hint`, r.json && r.json.hint, hint);
  });
  mismatchCase('B1 commit 不符', { commit: SHA_OTHER }, [], 'commit', SHA, SHA_OTHER);
  mismatchCase('B2 version 不符', { version: '1.2.4' }, [], 'version', VERSION, '1.2.4');
  mismatchCase('B3 mode 不符', { mode: 'isolated' }, [], 'mode', 'normal', 'isolated');
  mismatchCase('B4 external 不符', { external: 'stub' }, [], 'external', 'real', 'stub');
  mismatchCase('B5 background 不符', { background: 'off' }, [], 'background', 'on', 'off');
  mismatchCase('B6 instance 不符（期望缺省 null）', { instance: 'test-abc' }, [], 'instance', null, 'test-abc');
  mismatchCase('B6b commit 为 null（取不到提交号）：顶层 hint COMMIT_NULL', { commit: null }, [], 'commit', SHA, null, 'COMMIT_NULL');
  mismatchCase('B6c 期望 instance 为具体名而实际是 null', { instance: null }, ['--expect-instance', 'test-abc'], 'instance', 'test-abc', null);
  addCase('B7 version 返回 500', makeState({ versionStatus: 500 }), [], (r) => {
    expectTimeoutFail('B7 version 返回 500', r, 'version');
    eq('B7 status', r.json && r.json.lastObserved.status, 500);
  });
  addCase('B8 version 返回非 JSON', makeState({ versionRaw: `<html>${MARKER}</html>` }), [], (r) => {
    expectTimeoutFail('B8 version 返回非 JSON', r, 'version');
    eq('B8 notJson', r.json && r.json.lastObserved.notJson, true);
  });
  // ready
  addCase('B9 ready 503（模块未就绪）', makeState({ readyStatus: 503, ready: () => ({ ok: false, instance: null, mode: 'normal', modules: { core: { ready: true, code: null }, it_ledger: { ready: false, code: 'LEDGER_DRAINING' } } }) }), [], (r, ctx) => {
    expectTimeoutFail('B9 ready 503', r, 'ready');
    eq('B9 status 与 unready', r.json && [r.json.lastObserved.status, r.json.lastObserved.unready], [503, [{ module: 'it_ledger', code: 'LEDGER_DRAINING' }]]);
    eq('B9 没有请求页面', ctx.hits.filter((h) => !h.url.startsWith('/api/')).length, 0);
  });
  addCase('B10 ready 503 但体看着全好（状态码必须看）', makeState({ readyStatus: 503 }), [], (r) => {
    expectTimeoutFail('B10 ready 503 体全好', r, 'ready');
    eq('B10 status', r.json && r.json.lastObserved.status, 503);
  });
  addCase('B11 ready 200 且 ok:true，但某模块 ready:false（要逐项看）', makeState({ ready: () => ({ ok: true, instance: null, mode: 'normal', modules: { core: { ready: true, code: null }, sys_iteration: { ready: false, code: 'INIT_FAILED' } } }) }), [], (r) => {
    expectTimeoutFail('B11 某模块未就绪', r, 'ready');
    eq('B11 unready', r.json && r.json.lastObserved.unready, [{ module: 'sys_iteration', code: 'INIT_FAILED' }]);
  });
  addCase('B12 ready 200 但 ok:false（模块全 ready）', makeState({ ready: () => Object.assign(goodReady(), { ok: false }) }), [], (r) => {
    expectTimeoutFail('B12 ok:false', r, 'ready');
    eq('B12 ok', r.json && r.json.lastObserved.ok, false);
  });
  addCase('B13 ready 200 但 modules 为空', makeState({ ready: () => ({ ok: true, instance: null, mode: 'normal', modules: {} }) }), [], (r) => {
    expectTimeoutFail('B13 modules 为空', r, 'ready');
    eq('B13 noModules', r.json && r.json.lastObserved.noModules, true);
  });
  addCase('B14 ready 返回非 JSON', makeState({ ready: () => 'not json' }), [], (r) => {
    expectTimeoutFail('B14 ready 非 JSON', r, 'ready');
  });
  // 页面
  addCase('B15 某页含 ?v=auto', makeState({ pageBody: { '/sub/b c.html': `<html>${MARKER}<script src="/x.js?v=auto"></script></html>` } }), [], (r) => {
    expectTimeoutFail('B15 某页含 ?v=auto', r, 'pages');
    eq('B15 bad 只有那一页', r.json && r.json.lastObserved.bad, [{ page: 'sub/b c.html', hasVAuto: true }]);
  });
  addCase('B16 某页 404', makeState({ pageStatus: { '/a.html': 404, '/中文.html': 500 } }), [], (r) => {
    expectTimeoutFail('B16 某页 404', r, 'pages');
    eq('B16 bad 列出全部不合格的页', r.json && r.json.lastObserved.bad, [{ page: 'a.html', status: 404 }, { page: '中文.html', status: 500 }]);
  });
  // 服务器不应答：每个请求单独超时
  addCase('B17 version 永不应答（单请求超时）', makeState({ hangVersion: true }), ['--request-timeout-ms', '300'], (r) => {
    eq('B17 退出码', r.status, 1);
    eq('B17 code', r.json && r.json.code, 'READY_TIMEOUT');
    eq('B17 lastObserved', r.json && [r.json.lastObserved.stage, r.json.lastObserved.error], ['version', 'REQUEST_TIMEOUT']);
    check('B17 超时后仍轮询了不止一轮', r.json && r.json.rounds >= 2, r.last);
  }, { timeoutMs: 20000 });

  // MED-2 压缩：请求发 identity；服务器无视请求一律 gzip → 判坏（压缩字节里查不到 ?v=auto，放行就是假绿）
  addCase('B19 页面无视请求一律 gzip', makeState({ gzipPages: 'always', pageBody: { '/a.html': '<html><script src="/x.js?v=auto"></script></html>' } }), [], (r) => {
    expectTimeoutFail('B19 页面一律 gzip', r, 'pages');
    eq('B19 bad：每页都记 encoded:gzip', r.json && r.json.lastObserved.bad, PAGES.map((page) => ({ page, error: 'encoded:gzip' })));
  });
  addCase('B20 version 无视请求一律 gzip', makeState({ gzipVersion: 'always' }), [], (r) => {
    expectTimeoutFail('B20 version 一律 gzip', r, 'version');
    eq('B20 error', r.json && r.json.lastObserved.error, 'encoded:gzip');
  });
  addCase('B20b ready 无视请求一律 gzip', makeState({ gzipReady: 'always' }), [], (r) => {
    expectTimeoutFail('B20b ready 一律 gzip', r, 'ready');
    eq('B20b error', r.json && r.json.lastObserved.error, 'encoded:gzip');
  });
  // L2 重定向不跟随：302 判失败（现实里 302 到登录页，体看着正常）
  addCase('B21 version 返回 302（体是好的 JSON）', makeState({ versionStatus: 302 }), [], (r) => {
    expectTimeoutFail('B21 version 302', r, 'version');
    eq('B21 status', r.json && r.json.lastObserved.status, 302);
  });
  addCase('B22 某页返回 302（体看着正常）', makeState({ pageStatus: { '/a.html': 302 } }), [], (r) => {
    expectTimeoutFail('B22 某页 302', r, 'pages');
    eq('B22 bad', r.json && r.json.lastObserved.bad, [{ page: 'a.html', status: 302 }]);
  });
  // L3 缺字段：报告写「(缺失)」，且与期望 null 区分开
  addCase('B23 version 响应里缺 instance 字段', makeState({ version: () => { const v = goodVersion(); delete v.instance; return v; } }), [], (r) => {
    expectTimeoutFail('B23 缺 instance 字段', r, 'version');
    eq('B23 mismatches', r.json && r.json.lastObserved.mismatches, [{ field: 'instance', expected: null, actual: '(缺失)' }]);
  });
  // L5 模块 ready 必须严格 true
  for (const [label, val] of [['B24 模块 ready 是字符串 "yes"', 'yes'], ['B25 模块 ready 是数字 1', 1]]) {
    addCase(label, makeState({ ready: () => ({ ok: true, instance: null, mode: 'normal', modules: { core: { ready: true, code: null }, issue: { ready: val, code: null } } }) }), [], (r) => {
      expectTimeoutFail(label, r, 'ready');
      eq(`${label}: unready`, r.json && r.json.lastObserved.unready, [{ module: 'issue', code: null }]);
    });
  }
  // MED-1 hint 只在「只有 commit 不符且实际为 null」时出现
  addCase('B26 commit 为 null 且 mode 也不符：没有 hint', makeState({ version: () => Object.assign(goodVersion(), { commit: null, mode: 'isolated' }) }), [], (r) => {
    expectTimeoutFail('B26 commit null + mode 不符', r, 'version');
    eq('B26 没有 hint', r.json && r.json.hint, undefined);
    eq('B26 两个字段都报', ((r.json.lastObserved.mismatches) || []).map((m) => m.field).sort(), ['commit', 'mode']);
  });
  // L1 总期限：页面永不应答，请求超时 8 秒、总期限 FAST_TIMEOUT_SEC 秒 → 单请求超时被剩余总时间截短，总耗时约 FAST_TIMEOUT_SEC 秒（没有截短，第一页就要挂满 8 秒）
  addCase('B27 页面永不应答：单请求超时被总期限截短', makeState({ hangPages: true }), ['--request-timeout-ms', '8000'], (r) => {
    eq('B27 退出码', r.status, 1);
    eq('B27 code / stage', r.json && [r.json.code, r.json.lastObserved.stage], ['READY_TIMEOUT', 'pages']);
    check('B27 总耗时远小于单请求超时（< 7 秒；上限是总期限 + 子进程启动与收尾的余量，实际应约 3 秒；没有截短时要挂满 8 秒的单请求超时）', typeof r.wallMs === 'number' && r.wallMs < 7000, `wallMs=${r.wallMs}`);
    eq('B27 逐页检查被截断并标明', r.json && [r.json.lastObserved.truncated, r.json.lastObserved.checked], [true, 1]);
    eq('B27 第一页记 REQUEST_TIMEOUT', ((r.json.lastObserved.bad) || [])[0], { page: 'a.html', error: 'REQUEST_TIMEOUT' });
  }, { timeoutMs: 30000 });
  // L4 单请求超时覆盖到响应体读完
  addCase('B28 version 发完响应头和半截体后挂住', makeState({ hangVersionBody: true }), ['--request-timeout-ms', '300'], (r) => {
    eq('B28 退出码', r.status, 1);
    eq('B28 lastObserved', r.json && [r.json.lastObserved.stage, r.json.lastObserved.error], ['version', 'REQUEST_TIMEOUT']);
  }, { timeoutMs: 20000 });
  addCase('B29 某页发完响应头和半截体后挂住', makeState({ hangPageBody: { '/a.html': true } }), ['--request-timeout-ms', '300'], (r) => {
    eq('B29 退出码', r.status, 1);
    eq('B29 bad', r.json && r.json.lastObserved.bad, [{ page: 'a.html', error: 'REQUEST_TIMEOUT' }]);
  }, { timeoutMs: 20000 });
  // codex 38-R M1：第 1 轮 commit 为 null（带 COMMIT_NULL）；第 2 轮 version 已恢复、a.html 返回 500、下一页挂到总期限、第三页被截断。
  // 最终必须报本轮的页面失败，不能退回上一轮的 version 诊断与旧 hint。
  addCase('B30 旧 commit 为 null → 本轮 version 恢复 → 页面 500 后截断', makeState({
    version: (n) => (n === 0 ? Object.assign(goodVersion(), { commit: null }) : goodVersion()),
    pageStatus: { '/a.html': 500 },
    hangPageBody: { '/sub/b c.html': true },
  }), ['--request-timeout-ms', '8000'], (r) => {
    eq('B30 退出码', r.status, 1);
    eq('B30 最终阶段是本轮的 pages', r.json && r.json.lastObserved.stage, 'pages');
    eq('B30 保留本轮 a.html 的 500', ((r.json.lastObserved.bad) || [])[0], { page: 'a.html', status: 500 });
    eq('B30 顶层没有旧的 COMMIT_NULL', r.json && r.json.hint, undefined);
  }, { timeoutMs: 30000 });

  const results = await mapLimit(cases, B_CONCURRENCY, async (c) => withServer(c.state, async (ctx) => {
    const r = await runReady(withPages(ctx.base, c.extraArgs.concat(FAST)), c.opts);
    return { r, ctx: { hits: ctx.hits.slice() } };
  }));
  cases.forEach((c, i) => {
    // 被测输出缺字段（变异让它走了别的路径）时，让后面的具体断言照样执行并判红，而不是在读字段时抛异常把它们跳过
    const rr = results[i].r;
    rr.json = rr.json || {};
    rr.json.lastObserved = rr.json.lastObserved || {};
    try { c.assertFn(rr, results[i].ctx); } catch (e) { check(`${c.name}: 断言本身未抛异常（被测输出缺字段时判红，不中断后面的用例）`, false, e && e.message); }
  });

  // B18 端口无人监听 → 连接错误
  {
    const dead = await deadPort();
    const r = await runReady(withPages(`http://127.0.0.1:${dead}`, FAST));
    expectTimeoutFail('B18 端口无人监听', r, 'version');
    eq('B18 lastObserved.error', r.json && r.json.lastObserved.error, 'ECONNREFUSED');
  }
}

// ---------------------------------------------------------------- C 参数错误

async function sectionArgs() {
  await withServer(makeState(), async ({ base, hits }) => {
    const ok = withPages(base);
    const without = (flag) => { const a = ok.slice(); const i = a.indexOf(flag); a.splice(i, 2); return a; };
    const cases = [
      ['C1 缺 --expect-commit', without('--expect-commit')],
      ['C2 缺 --expect-version', without('--expect-version')],
      ['C3 缺 --base-url', without('--base-url')],
      ['C4 坏 sha：太短', baseArgs(base, ['--pages', 'a.html']).map((x) => (x === SHA ? 'abc123' : x))],
      ['C5 坏 sha：含大写', baseArgs(base, ['--pages', 'a.html']).map((x) => (x === SHA ? SHA.toUpperCase() : x))],
      ['C6 坏版本号', baseArgs(base, ['--pages', 'a.html']).map((x) => (x === VERSION ? '1.2' : x))],
      ['C7 坏 URL（非 http）', ok.map((x) => (x === base ? 'ftp://127.0.0.1:21' : x))],
      ['C8 坏 URL（不是 URL）', ok.map((x) => (x === base ? 'not a url' : x))],
      ['C9 URL 带路径', ok.map((x) => (x === base ? `${base}/api` : x))],
      ['C10 两种页面来源同时给', ok.concat(['--pages-from-commit', SHA])],
      ['C11 页面来源都不给', baseArgs(base)],
      ['C12 --repo 配 --pages', ok.concat(['--repo', TMP_ROOT])],
      ['C13 未知参数', ok.concat(['--bogus', 'x'])],
      ['C14 位置参数', ok.concat(['extra'])],
      ['C15 参数缺取值', ok.concat(['--timeout-sec'])],
      ['C16 参数重复', ok.concat(['--expect-mode', 'normal', '--expect-mode', 'normal'])],
      ['C17 --timeout-sec 为 0', ok.concat(['--timeout-sec', '0'])],
      ['C18 --interval-ms 不是整数', ok.concat(['--interval-ms', '1.5'])],
      ['C19 页面名含 ..', baseArgs(base, ['--pages', 'a/../b.html'])],
      ['C20 页面名以 / 开头', baseArgs(base, ['--pages', '/a.html'])],
      ['C21 页面名为空段', baseArgs(base, ['--pages', 'a.html,,b.html'])],
      ['C22 无参数', []],
      ['C23 --pages-from-commit 坏 sha', baseArgs(base, ['--pages-from-commit', 'HEAD'])],
      // --base-url 主机必须是 IPv4 数字字面量：主机名（含 localhost）、IPv6 字面量一律参数错误（域名解析取消不了，会超过总期限）
      ['C24 主机是 localhost', ok.map((x) => (x === base ? `http://localhost:${new URL(base).port}` : x))],
      ['C25 主机是域名', ok.map((x) => (x === base ? `http://example.com:${new URL(base).port}` : x))],
      ['C26 主机是 IPv6 字面量', ok.map((x) => (x === base ? `http://[::1]:${new URL(base).port}` : x))],
      ['C27 主机是带字母的伪 IP',ok.map((x) => (x === base ? `http://127.0.0.x:${new URL(base).port}` : x))],
      // 取页面清单失败是参数类失败：仓库目录不存在 → 快速失败，不挂住
      ['C28 --pages-from-commit 的仓库目录不存在', baseArgs(base, ['--pages-from-commit', SHA, '--repo', path.join(TMP_ROOT, '没有这个仓库')])],
    ];
    for (const [name, args] of cases) {
      // 被测代码（或变异）没拒绝参数时会去轮询假服务器：给个短总期限，几秒内以 READY_FAIL 结束，不挂到外层终止
      const r = await runReady(args.includes('--timeout-sec') ? args : args.concat(ARGS_T));
      eq(`${name}: 退出码`, r.status, 2);
      check(`${name}: 最后一行是 READY_FAIL 协议`, r.kind === 'READY_FAIL' && r.json !== null, r.last);
      eq(`${name}: code`, r.json && r.json.code, 'READY_ARGS');
    }
    // L6 --check-args：只校验参数与页面清单，不发任何请求（连不上的地址也成功）
    const chk = await runReady(ok.concat(['--check-args'], ARGS_T));
    eq('C30 --check-args（--pages）：退出码', chk.status, 0);
    check('C30 --check-args：最后一行是 READY_ARGS_OK 协议，页面数 3', chk.kind === 'READY_ARGS_OK' && chk.json !== null && chk.json.pages === 3, chk.last);
    eq('C30 --check-args：协议行只有一条', chk.protocolLines, 1);
    const dead = await deadPort();
    const chkDead = await runReady(withPages(`http://127.0.0.1:${dead}`, ['--check-args'].concat(ARGS_T)));
    eq('C31 --check-args 对无人监听的地址：退出码 0（没有发请求）', chkDead.status, 0);
    const chkBad = await runReady(baseArgs(base, ['--pages', 'a.html', '--check-args'].concat(ARGS_T)).map((x) => (x === SHA ? 'abc123' : x)));
    check('C32 --check-args 坏 sha：退出码 2 + READY_ARGS', chkBad.status === 2 && chkBad.json && chkBad.json.code === 'READY_ARGS', chkBad.last);
    const chkDup = await runReady(ok.concat(['--check-args', '--check-args'], ARGS_T));
    check('C33 --check-args 重复：退出码 2 + READY_ARGS', chkDup.status === 2 && chkDup.json && chkDup.json.code === 'READY_ARGS', chkDup.last);
    const chkVal = await runReady(ok.concat(['--check-args', 'yes'], ARGS_T));
    check('C34 --check-args 带取值（它是开关）：退出码 2', chkVal.status === 2 && chkVal.json && chkVal.json.code === 'READY_ARGS', chkVal.last);
    eq('C 节：参数错误与 --check-args 时假服务器零请求', hits.length, 0);

  });
  // L6 内部异常：没有诚实的办法让通过参数校验之后的脚本抛出内部异常（不加测试钩子），所以只做静态钉：收口是 READY_INTERNAL + 退出码 3，不再冒充参数错误
  const src = fs.readFileSync(READY_JS, 'utf8');
  check('C41 静态：main().catch 收口为 READY_INTERNAL 与退出码 3', /main\(\)\.catch\([\s\S]*READY_INTERNAL[\s\S]*process\.exitCode = 3/.test(src));
  check('C41 静态：READY_ARGS 只出现在参数错误的收口里，不在 main().catch 里', !/main\(\)\.catch\([\s\S]*READY_ARGS/.test(src));
  // 取页面清单的 git 子进程：真正的挂住场景（文件系统卡死）造不出来，所以静态钉 + 失败快的行为用例（C28）
  check('C42 静态：git ls-tree 调用带 timeout 选项', /execFileSync\('git',[^\n]*timeout: gitTimeoutMs/.test(src));
  check('C43 静态：总期限在取页面清单之前建立（cfg.deadline 赋值先于 pagesFromCommit 调用）', src.indexOf('cfg.deadline = started') > 0 && src.indexOf('cfg.deadline = started') < src.indexOf('pagesFromCommit(cfg.repo'));
}

// ---------------------------------------------------------------- D --pages-from-commit

function gitEnv(emptyCfg) {
  return cleanEnv({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyCfg, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' });
}

async function sectionFromCommit() {
  const repo = freshDir('repo');
  const emptyCfg = path.join(freshDir('cfg'), 'gitconfig');
  fs.writeFileSync(emptyCfg, '');
  const env = gitEnv(emptyCfg);
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...a], { env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const put = (rel, text) => {
    const p = path.join(repo, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  git('init', '-q');
  put('wbs-server/public/a.html', '<html>a v1</html>\n');
  put('wbs-server/public/sub/d.HTM', '<html>d</html>\n');
  put('wbs-server/public/中文 页.html', '<html>zh</html>\n');
  put('wbs-server/public/x.js', 'var x = 1;\n');
  put('wbs-server/other/e.html', '<html>e</html>\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  const sha1 = git('rev-parse', 'HEAD').trim();
  put('wbs-server/public/c.html', '<html>c</html>\n');
  put('wbs-server/public/a.html', '<html>a v2</html>\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'second');
  const sha2 = git('rev-parse', 'HEAD').trim();
  put('wbs-server/public/z.html', '<html>untracked</html>\n');   // 只在工作区，不在任何提交
  check('D0 夹具：两个提交不同', sha1 !== sha2 && /^[0-9a-f]{40}$/.test(sha1) && /^[0-9a-f]{40}$/.test(sha2), `${sha1} ${sha2}`);

  const pagesRequested = (hits) => hits.filter((h) => !h.url.startsWith('/api/')).map((h) => decodeURIComponent(h.url)).sort();
  await withServer(makeState(), async ({ base, hits }) => {
    const r = await runReady(baseArgs(base, ['--pages-from-commit', sha1, '--repo', repo].concat(OK_T)));
    eq('D1 取第一个提交的页面：退出码', r.status, 0);
    eq('D1 只取 html / htm（含 .HTM、中文空格名），不含 x.js、public 之外的 e.html、之后才有的 c.html、工作区的 z.html', pagesRequested(hits), ['/a.html', '/sub/d.HTM', '/中文 页.html'].sort());
    eq('D1 json.pages', r.json && r.json.pages, 3);
  });
  await withServer(makeState(), async ({ base, hits }) => {
    const r = await runReady(baseArgs(base, ['--pages-from-commit', sha2, '--repo', repo].concat(OK_T)));
    eq('D2 取第二个提交（HEAD）的页面：退出码', r.status, 0);
    eq('D2 多了 c.html，仍无 z.html', pagesRequested(hits), ['/a.html', '/c.html', '/sub/d.HTM', '/中文 页.html'].sort());
  });
  await withServer(makeState(), async ({ base, hits }) => {
    const r = await runReady(baseArgs(base, ['--pages-from-commit', 'a'.repeat(40), '--repo', repo].concat(ARGS_T)));
    eq('D3 未知提交：退出码', r.status, 2);
    eq('D3 code', r.json && r.json.code, 'READY_ARGS');
    eq('D3 零请求', hits.length, 0);
  });
  // D6 / D7 --check-args 取页面清单：成功得页面数，失败同 READY_ARGS；两者都零请求
  await withServer(makeState(), async ({ base, hits }) => {
    const r = await runReady(baseArgs(base, ['--pages-from-commit', sha1, '--repo', repo, '--check-args'].concat(ARGS_T)));
    eq('D6 --check-args + --pages-from-commit：退出码', r.status, 0);
    check('D6 READY_ARGS_OK 且页面数 3', r.kind === 'READY_ARGS_OK' && r.json && r.json.pages === 3, r.last);
    const bad = await runReady(baseArgs(base, ['--pages-from-commit', 'a'.repeat(40), '--repo', repo, '--check-args'].concat(ARGS_T)));
    check('D7 --check-args + 未知提交：退出码 2 + READY_ARGS', bad.status === 2 && bad.json && bad.json.code === 'READY_ARGS', bad.last);
    eq('D6/D7 --check-args 零请求', hits.length, 0);
  });
  {
    const repo2 = freshDir('repo2');
    const git2 = (...a) => execFileSync('git', ['-C', repo2, '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...a], { env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    git2('init', '-q');
    fs.mkdirSync(path.join(repo2, 'wbs-server', 'public'), { recursive: true });
    fs.writeFileSync(path.join(repo2, 'wbs-server', 'public', 'only.js'), 'x\n');
    git2('add', '-A');
    git2('commit', '-q', '-m', 'js only');
    const sha3 = git2('rev-parse', 'HEAD').trim();
    await withServer(makeState(), async ({ base, hits }) => {
      const r = await runReady(baseArgs(base, ['--pages-from-commit', sha3, '--repo', repo2].concat(ARGS_T)));
      eq('D4 提交里没有 html：退出码', r.status, 2);
      eq('D4 code', r.json && r.json.code, 'READY_ARGS');
      eq('D4 零请求', hits.length, 0);
    });
  }
  // D5 --repo 缺省 = 被测脚本所在检出（变异副本不在检出里，所以只在测真实脚本时跑）：用本检出 HEAD 的真实 sha，页面清单来自该提交
  if (!DEPLOY_ARG) {
    const head = execFileSync('git', ['-C', path.join(__dirname, '..', '..'), 'rev-parse', 'HEAD'], { env: cleanEnv(), encoding: 'utf8', windowsHide: true }).trim();
    await withServer(makeState(), async ({ base, hits }) => {
      const r = await runReady(baseArgs(base, ['--pages-from-commit', head, '--timeout-sec', '5', '--interval-ms', '200']));
      eq('D5 缺省 --repo（本检出）能列出页面：退出码', r.status, 0);
      check('D5 请求的页面都是 html / htm', pagesRequested(hits).length > 0 && pagesRequested(hits).every((p) => /\.html?$/i.test(p)), JSON.stringify(pagesRequested(hits).slice(0, 5)));
    });
  }
}

// ---------------------------------------------------------------- H 演练的源文件检查（drill-deploy-failures.js 导出的 checkSource / enumerateDbFiles）
//   全部在 os.tmpdir() 下自建假的 wbs-server 树与备份目录（里面的 .db 都是几个字节的假文件，硬链接也只指向这些假文件），不碰真实业务库 / 真实备份。

const DRILL_EDITS_ARG = argOf('--drill-edits=');
/** 加载演练模块；带 --drill-edits=<json 文件> 时先在内存里对源码做变异再编译（变异自证用，不写任何仓库文件） */
function loadDrill() {
  const file = path.join(__dirname, 'drill-deploy-failures.js');
  if (!DRILL_EDITS_ARG) return require(file);
  const edits = JSON.parse(fs.readFileSync(DRILL_EDITS_ARG.slice('--drill-edits='.length), 'utf8'));
  let src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');   // 同变异阶段：CRLF 检出先归一成 LF（与外层 sectionMutations 里对演练脚本的核对读同一份口径）
  for (const [from, to] of edits) {
    const first = src.indexOf(from);
    if (first < 0 || src.indexOf(from, first + 1) >= 0) throw new Error(`演练变异点不是恰好出现一次：${from.slice(0, 60)}`);
    src = src.slice(0, first) + to + src.slice(first + from.length);
  }
  const Module = require('module');
  const m = new Module(file, module);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(src, file);
  return m.exports;
}

async function sectionDrillFs() {
  const D = loadDrill();
  check('H0 演练模块导出了 checkSource / enumerateDbFiles（require 时不执行 main）', typeof D.checkSource === 'function' && typeof D.enumerateDbFiles === 'function');
  const root = freshDir('drillfs');
  const repoDir = path.join(root, 'repo');
  const wbsDir = path.join(repoDir, 'wbs-server');
  const backupDir = path.join(repoDir, '生产数据库备份');
  const put = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
  put(path.join(wbsDir, 'data', 'live.db'), 'fake-live');
  put(path.join(wbsDir, 'top.db'), 'fake-top');
  put(path.join(wbsDir, 'node_modules', 'pkg', 'skip.db'), 'fake-skip');
  put(path.join(wbsDir, 'uploads', 'note.txt'), 'note');
  put(path.join(backupDir, 'ordinary.bak'), 'ordinary backup');
  put(path.join(root, 'outside', 'other.bak'), 'outside');
  fs.linkSync(path.join(wbsDir, 'data', 'live.db'), path.join(backupDir, 'hardlink-nested.bak'));
  fs.linkSync(path.join(wbsDir, 'top.db'), path.join(backupDir, 'hardlink-top.bak'));
  const opts = { repoDir, wbsDir };
  const rel = (list) => list.map((p) => path.relative(wbsDir, p).split(path.sep).join('/')).sort();

  eq('H1 备份目录里的普通文件 → 放行', D.checkSource(path.join(backupDir, 'ordinary.bak'), opts), null);
  const outside = D.checkSource(path.join(root, 'outside', 'other.bak'), opts);
  check('H2 备份目录之外的文件 → 拒绝', !!outside && typeof outside.refuse === 'string' && /不在本检出的/.test(outside.refuse), JSON.stringify(outside));
  const nested = D.checkSource(path.join(backupDir, 'hardlink-nested.bak'), opts);
  check('H3 备份目录里指向 wbs-server/data/ 下 .db 的硬链接（嵌套目录）→ 拒绝，并点出相对路径', !!nested && typeof nested.refuse === 'string' && /data[\\/]live\.db/.test(nested.refuse), JSON.stringify(nested));
  const top = D.checkSource(path.join(backupDir, 'hardlink-top.bak'), opts);
  check('H4 指向 wbs-server 顶层 .db 的硬链接 → 拒绝', !!top && typeof top.refuse === 'string' && /top\.db/.test(top.refuse), JSON.stringify(top));
  const boom = Object.assign({}, fs, { readdirSync: () => { throw Object.assign(new Error('boom'), { code: 'EACCES' }); } });
  const failed = D.checkSource(path.join(backupDir, 'ordinary.bak'), Object.assign({ fsImpl: boom }, opts));
  check('H5 枚举过程出错（读目录 EACCES）→ 拒绝运行', !!failed && typeof failed.refuse === 'string' && /无法完成/.test(failed.refuse), JSON.stringify(failed));
  const missing = D.checkSource(path.join(backupDir, '没有这个文件.bak'), opts);
  check('H8 源文件不存在 → 用法错误（usage）', !!missing && typeof missing.usage === 'string', JSON.stringify(missing));
  eq('H10a 递归枚举：嵌套与顶层的 .db 都在，node_modules 下的不算', rel(D.enumerateDbFiles(wbsDir)), ['data/live.db', 'top.db']);

  // H6 目录联接 / 符号链接目录不跟随：造一个指回 wbs-server 的联接（环）——枚举必须结束、不重复、不报错
  let linked = false;
  try { fs.symlinkSync(wbsDir, path.join(wbsDir, 'loop'), 'junction'); linked = true; } catch (e) { check('H6 前置：创建目录联接', true, `（跳过：${e && e.code}）`); }
  if (linked) {
    eq('H6 目录联接成环：放行（不跟随，不死循环）', D.checkSource(path.join(backupDir, 'ordinary.bak'), opts), null);
    eq('H10b 联接成环时枚举结果不变（不跟随）', rel(D.enumerateDbFiles(wbsDir)), ['data/live.db', 'top.db']);
    const still = D.checkSource(path.join(backupDir, 'hardlink-nested.bak'), opts);
    check('H6b 联接成环时嵌套硬链接仍然被拒绝', !!still && typeof still.refuse === 'string', JSON.stringify(still));
  }
}

// ---------------------------------------------------------------- E 判别力

const FIELD_LIST = "['version', 'commit', 'mode', 'external', 'background', 'instance']";
const dropField = (f) => `[${['version', 'commit', 'mode', 'external', 'background', 'instance'].filter((x) => x !== f).map((x) => `'${x}'`).join(', ')}]`;
// 每个变异登记：only = 递归调用时只跑哪几节（静态检查每次都跑）；expect = 期望变红的「具体行为断言」名前缀（越窄越好）。
//   判红要求「套件失败」且「至少有一个变红的用例名以期望前缀之一开头」，否则按「变异没有被目标用例抓住」计失败；
//   另外，运行故障（子进程被外层终止，输出里有 FAULT 行）不计为检出——除非变异本来就靠挂住来检出（faultOk：请求没有超时、响应体超时这两类）。
//   drill = true 的变异改的是演练脚本（在内存里变异后编译，经 --drill-edits=<json> 传给递归调用），不是 ready-check.js。
const mut = (name, only, expect, edits, extra) => Object.assign({ name, only, expect, edits, faultOk: false, drill: false }, extra || {});
const MUTATIONS = [
  mut('R-旧观察保留 时间不够的轮次一律不覆盖（含已有新信息的页面截断）', 'B', ['B30 最终阶段', 'B30 保留本轮', 'B30 顶层没有旧'], [["const noNewInfo = obs.stage === 'version' && (obs.error === 'REQUEST_TIMEOUT' || obs.error === 'DEADLINE');", "const noNewInfo = obs.error === 'REQUEST_TIMEOUT' || obs.error === 'DEADLINE' || obs.truncated === true;"]]),
  ...['commit', 'version', 'mode', 'external', 'background', 'instance'].map((f, i) => mut(`R-${f} 不比 ${f}`, 'B', f === 'instance' ? ['B6 instance 不符（期望缺省 null）: mismatches', 'B6c 期望 instance 为具体名而实际是 null: mismatches'] : [`B${i + 1} ${{ commit: 'commit', version: 'version', mode: 'mode', external: 'external', background: 'background' }[f]} 不符: mismatches`], [[FIELD_LIST, dropField(f)]])),
  mut('R-modules 不逐项看模块、只看 ok', 'B', ['B11 unready'], [['if (r.status === 200 && j !== null && j.ok === true && modulesOk && unready.length === 0) return null;', 'if (r.status === 200 && j !== null && j.ok === true) return null;']]),
  mut('R-ready状态码 不看 ready 的 HTTP 状态码', 'B', ['B10 status'], [['if (r.status === 200 && j !== null && j.ok === true && modulesOk', 'if (j !== null && j.ok === true && modulesOk']]),
  mut('R-vauto 不查 ?v=auto', 'AB', ['B15 bad 只有那一页', 'A4 rounds = 3'], [["else if (r.body.includes('?v=auto')) problem", 'else if (false) problem']]),
  mut('R-页面状态码 不查页面状态码', 'B', ['B16 bad 列出全部不合格的页'], [['else if (r.status !== 200) problem = { page, status: r.status };', 'else if (false) problem = { page, status: r.status };']]),
  mut('R-退出码 超时后仍返回 0', 'B', ['B1 commit 不符: 退出码', 'B7 version 返回 500: 退出码'], [["emit('READY_FAIL', fail);\n  process.exitCode = 1;", "emit('READY_FAIL', fail);\n  process.exitCode = 0;"]]),
  mut('R-轮询 只查一轮不再等待', 'A', ['A2 rounds = 4', 'A3 rounds = 3'], [['if (remaining <= 0) break;', 'break;']]),
  mut('R-代理 使用代理环境变量', 'A', ['A5 设了代理环境变量', '静态：不用 fetch'], [['      agent: false,\n    };', "      agent: false,\n    };\n    if (process.env.HTTP_PROXY) { const px = new URL(process.env.HTTP_PROXY); opts.hostname = px.hostname; opts.port = Number(px.port); opts.path = `http://${baseUrl.host}${urlPath}`; }"]]),
  mut('R-代理b 使用代理环境变量（写法绕开静态断言，只剩 A5 能抓）', 'A', ['A5 设了代理环境变量'], [['      agent: false,\n    };', "      agent: false,\n    };\n    const px0 = process.env[['HTTP', 'PR' + 'OXY'].join('_')]; if (px0) { const px = new URL(px0); opts.hostname = px.hostname; opts.port = Number(px.port); opts.path = `http://${baseUrl.host}${urlPath}`; }"]]),
  mut('R-请求超时 单个请求没有超时（靠挂住检出）', 'B', ['B17 lastObserved'], [["timer = setTimeout(() => { done({ error: 'REQUEST_TIMEOUT' }); req.destroy(); }, timeoutMs);", 'timer = null;']], { faultOk: true }),
  mut('R-响应体 失败时把页面响应体打进输出', 'B', ['B15 某页含 ?v=auto: 输出里没有响应体原文'], [['problem = { page, hasVAuto: true };', 'problem = { page, hasVAuto: true, body: r.body };']]),
  mut('R-取页面 页面清单取 HEAD 而不是指定提交', 'D', ['D1 只取 html', 'D2 多了 c.html'], [["'-z', sha,", "'-z', 'HEAD',"]]),
  mut('R-取页面 页面清单不过滤扩展名', 'D', ['D1 只取 html', 'D4 提交里没有 html: 退出码'], [['.filter((p) => /\\.html?$/i.test(p)).sort();', '.sort();']]),
  mut('R-参数 页面来源二选一不校验', 'C', ['C10 两种页面来源同时给: 退出码', 'C11 页面来源都不给: 退出码'], [['if (hasFrom === hasPages) throw', 'if (false) throw']]),
  mut('R-参数 expect-commit 不校验', 'C', ['C4 坏 sha：太短: 退出码', 'C5 坏 sha：含大写: 退出码'], [["if (!SHA_RE.test(values['--expect-commit'])) throw", 'if (false) throw']]),
  mut('R-顺序 version 不过也去查 ready', 'AB', ['A2 不符的几轮里没有请求', 'B1 commit 不符: 没有请求 ready'], [['const obs = (await checkVersion(cfg)) || (await checkReady(cfg)) || (await checkPages(cfg, pages));', 'const v = await checkVersion(cfg); const rd = await checkReady(cfg); const obs = rd || v || (await checkPages(cfg, pages));']]),
  // ---- 预筛修复批新增 ----
  mut('Y2 页面接受 3xx', 'B', ['B22 bad'], [['else if (r.status !== 200) problem = { page, status: r.status };', 'else if (r.status < 200 || r.status >= 400) problem = { page, status: r.status };']]),
  mut('Y3 version 接受 3xx', 'B', ['B21 status'], [["if (r.status !== 200) return { stage: 'version', status: r.status };", "if (r.status >= 400) return { stage: 'version', status: r.status };"]]),
  mut('Y4 字段比较 !== 改 !=（缺字段与 null 混为一谈）', 'B', ['B23 mismatches'], [['if (actual !== expected) mismatches.push', 'if (actual != expected) mismatches.push']]),
  mut('Y5 单请求超时只管到响应头（响应头一到就清计时器；靠挂住检出）', 'B', ['B28 lastObserved', 'B29 bad'], [["const encoding = res.headers['content-encoding'];", "clearTimeout(timer);\n      const encoding = res.headers['content-encoding'];"]], { faultOk: true }),
  mut('Y6 请求头改成 Accept-Encoding: gzip', 'A', ['A1 每个请求都显式发', 'A7 请求头确实是 identity'], [["'Accept-Encoding': 'identity'", "'Accept-Encoding': 'gzip'"]]),
  mut('Y7 模块 ready 放宽为真值', 'B', ['B24 模块 ready 是字符串 "yes": unready', 'B25 模块 ready 是数字 1: unready'], [["typeof m === 'object' && m.ready === true", "typeof m === 'object' && m.ready"]]),
  mut('Y8 不判 content-encoding', 'B', ['B19 bad', 'B20 error'], [["if (encoding !== undefined && String(encoding).trim().toLowerCase() !== 'identity') {", 'if (false) {']]),
  mut('Y9 内部异常仍冒充 READY_ARGS', 'C', ['C41 静态：main().catch'], [["code: 'READY_INTERNAL', message", "code: 'READY_ARGS', message"]]),
  mut('Y10 --check-args 不早退（照样发请求）', 'CD', ['C30 --check-args：最后一行', 'C31 --check-args 对无人监听的地址', 'D6 READY_ARGS_OK'], [['if (cfg.checkArgs) {', 'if (false) {']]),
  mut('Y11 commit 为 null 时不给 hint', 'B', ['B6b commit 为 null（取不到提交号）：顶层 hint COMMIT_NULL: 顶层 hint'], [["detail.hint = 'COMMIT_NULL';", 'void 0;']]),
  mut('Y12 单请求超时不被总期限截短', 'B', ['B27 总耗时'], [['return left <= 0 ? 0 : Math.min(cfg.requestTimeoutMs, left);', 'return left <= 0 ? 0 : cfg.requestTimeoutMs;']]),
  mut('Y13 缺字段不写「(缺失)」', 'B', ['B23 mismatches'], [["actual === undefined ? '(缺失)' : clip(actual)", 'clip(actual)']]),
  mut('Y14 总期限到了仍继续逐页检查', 'B', ['B27 逐页检查被截断'], [['if (t <= 0) { truncated = true; break; }', 'if (t <= 0) { /* 继续 */ }']]),
  // ---- codex 38 修复批新增 ----
  mut('Z1 git ls-tree 不带超时', 'C', ['C42 静态'], [['timeout: gitTimeoutMs, ', '']]),
  mut('Z2 总期限在取页面清单之后才建立', 'C', ['C43 静态'], [['cfg.deadline = started + cfg.timeoutMs;', 'void 0;'], ['pages = cfg.pages !== null ? cfg.pages : pagesFromCommit(cfg.repo, cfg.pagesFromCommit, Math.min(30000, cfg.deadline - Date.now()));', 'pages = cfg.pages !== null ? cfg.pages : pagesFromCommit(cfg.repo, cfg.pagesFromCommit, 30000);\n    cfg.deadline = started + cfg.timeoutMs;']]),
  mut('Z3 --base-url 不限 IPv4 字面量', 'C', ['C24 主机是 localhost', 'C25 主机是域名', 'C26 主机是 IPv6 字面量', 'C27 主机是带字母的伪 IP'], [['if (!isIpv4Literal(base.hostname)) throw', 'if (false) throw']]),
  mut('Z4 IPv4 判断放宽成任意主机名', 'C', ['C25 主机是域名', 'C27 主机是带字母的伪 IP'], [['return m !== null && m.slice(1).every((s) => Number(s) <= 255);', 'return true;']]),
  mut('Z5 取页面清单失败（仓库不存在）不当参数错误', 'C', ['C28 --pages-from-commit 的仓库目录不存在: 退出码'], [["throw new ArgsError(`git ls-tree 失败（仓库 ${repo}，提交 ${sha}）", "throw new Error(`git ls-tree 失败（仓库 ${repo}，提交 ${sha}）"]]),
  // ---- 演练的源文件检查（改演练脚本，经 --drill-edits 传入）----
  mut('W1 演练枚举不递归（只看 wbs-server 顶层）', 'H', ['H3 备份目录里指向'], [["if (name.toLowerCase() !== 'node_modules') stack.push(full);", 'void 0;']], { drill: true }),
  mut('W2 演练枚举出错当没有（吞掉读目录错误）', 'H', ['H5 枚举过程出错'], [['for (const name of f.readdirSync(dir)) {', 'let names0 = [];\n    try { names0 = f.readdirSync(dir); } catch (_) { names0 = []; }\n    for (const name of names0) {']], { drill: true }),
  mut('W3 演练枚举跟随目录联接（用 stat 代替 lstat）', 'H', ['H6 目录联接成环', 'H10b'], [['const l = f.lstatSync(full);', 'const l = f.statSync(full);']], { drill: true }),
  mut('W4 演练枚举不跳过 node_modules', 'H', ['H10a'], [["if (name.toLowerCase() !== 'node_modules') stack.push(full);", 'stack.push(full);']], { drill: true }),
  mut('W5 演练不比较 dev+ino（硬链接放行）', 'H', ['H3 备份目录里指向', 'H4 指向'], [['other.dev === st.dev && other.ino === st.ino', 'false']], { drill: true }),
];

async function sectionMutations() {
  console.log('--- E 判别力：变异只在临时副本上做 ---');
  const runOne = async (m0, idx) => {
    const dest = path.join(TMP_ROOT, `mut-${idx}`, 'deploy');
    fs.mkdirSync(dest, { recursive: true });
    const extraArgs = [];
    if (m0.drill) {
      // 演练脚本的变异：先核对变异点恰好出现一次，再把编辑写成 json 交给递归调用（它在内存里变异后编译，不写仓库文件）
      const drillSrc = fs.readFileSync(path.join(__dirname, 'drill-deploy-failures.js'), 'utf8').replace(/\r\n/g, '\n');   // 与递归调用里 loadDrill 读同一份口径（CRLF 检出先归一）
      for (const [from] of m0.edits) {
        const first = drillSrc.indexOf(from);
        if (first < 0 || drillSrc.indexOf(from, first + 1) >= 0) return { mut: m0, applied: false };
      }
      const editsFile = path.join(dest, 'drill-edits.json');
      fs.writeFileSync(editsFile, JSON.stringify(m0.edits));
      extraArgs.push(`--drill-edits=${editsFile}`);
      fs.copyFileSync(path.join(DEPLOY_DIR, 'ready-check.js'), path.join(dest, 'ready-check.js'));
    } else {
      // 线 worktree 里被测脚本是 CRLF 检出（autocrlf），而变异点锚点含 \n（R-退出码 / R-代理 / R-代理b）：先归一成 LF 再找锚点（只改临时副本）
      let src = fs.readFileSync(path.join(DEPLOY_DIR, 'ready-check.js'), 'utf8').replace(/\r\n/g, '\n');
      for (const [from, to] of m0.edits) {
        const first = src.indexOf(from);
        if (first < 0 || src.indexOf(from, first + 1) >= 0) return { mut: m0, applied: false };
        src = src.slice(0, first) + to + src.slice(first + from.length);
      }
      fs.writeFileSync(path.join(dest, 'ready-check.js'), src);
    }
    const out = await new Promise((resolve) => {
      const child = spawn(process.execPath, [__filename, `--deploy-dir=${dest}`, '--no-mutations', `--only=${m0.only}`, ...extraArgs], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.resume();
      const killer = setTimeout(() => child.kill(), 600000);
      child.on('close', (code) => { clearTimeout(killer); resolve({ code, stdout }); });
    });
    return { mut: m0, applied: true, out };
  };
  const results = await mapLimit(MUTATIONS, MUTATION_WORKERS, runOne);
  for (const res of results) {
    const name = res.mut.name;
    if (!check(`E ${name}: 变异点在被测源码里恰好出现一次`, res.applied)) continue;
    const lines = String(res.out.stdout).split('\n');
    const reds = lines.map((l) => /^FAIL (.+?)( :: .*)?\r?$/.exec(l)).filter(Boolean).map((m) => m[1]);
    const faults = lines.filter((l) => l.startsWith('FAULT ')).length;
    const summary = /PASS=(\d+) FAIL=(\d+)/.exec(res.out.stdout || '');
    const red = res.out.code !== 0 && summary && Number(summary[2]) > 0;
    const hit = reds.filter((n) => res.mut.expect.some((p) => n.startsWith(p)));
    check(`E ${name}: 套件变红`, red, `退出码 ${res.out.code}；${summary ? summary[0] : '无汇总行'}`);
    if (red) check(`E ${name}: 被目标断言抓住（期望前缀 ${res.mut.expect.join(' / ')}）`, hit.length > 0, `变红的用例：${reds.slice(0, 6).join(' | ')}`);
    if (red && faults > 0 && !res.mut.faultOk) check(`E ${name}: 没有运行故障（FAULT ${faults} 行：子进程被外层终止，不计为检出）`, false, `FAULT ${faults} 行`);
    console.log(`MUTATION ${name} => ${!red ? 'STILL GREEN' : (hit.length > 0 ? 'RED' : 'RED-BUT-NOT-TARGET')}${faults > 0 ? `（含 ${faults} 个运行故障${res.mut.faultOk ? '，本变异靠挂住检出，允许' : '，不计为检出'}）` : ''}（${reds.length} 个用例变红，命中期望前缀 ${hit.length} 个：${reds.slice(0, 8).join(' | ')}${reds.length > 8 ? ' | …' : ''}）`);
  }
  console.log(`MUTATIONS 共 ${MUTATIONS.length} 个`);
}

/** 变异个数与文档一致：本文件头注释、FAMILY 里 S8b 那段注释写的数字都必须等于 MUTATIONS 的实际条数 */
function checkMutationCount() {
  const own = fs.readFileSync(__filename, 'utf8');
  const head = /变异共 (\d+) 个/.exec(own.slice(0, own.indexOf("'use strict'")));
  check('E 头注释里写的变异个数 = MUTATIONS 实际条数', !!head && Number(head[1]) === MUTATIONS.length, `头注释 ${head ? head[1] : '无'}，实际 ${MUTATIONS.length}`);
  let fam = null;
  try { fam = fs.readFileSync(path.join(__dirname, 'run-verify-family.js'), 'utf8'); } catch (_) { fam = null; }
  if (fam !== null) {
    const m = /#106 S8b（W10）[\s\S]*?含 (\d+) 个变异自证/.exec(fam);
    check('E FAMILY 里 S8b 那段注释写的变异个数 = MUTATIONS 实际条数', !!m && Number(m[1]) === MUTATIONS.length, `FAMILY 注释 ${m ? m[1] : '无'}，实际 ${MUTATIONS.length}`);
  }
}

// ---------------------------------------------------------------- 主流程

async function main() {
  try {
    check('被测脚本存在', fs.existsSync(READY_JS), READY_JS);
    const src = fs.readFileSync(READY_JS, 'utf8');
    check('静态：不用 fetch、不读代理环境变量', !/\bfetch\s*\(/.test(src) && !/PROXY/i.test(src.replace(/\/\*[\s\S]*?\*\//, '')) , 'ready-check.js 出现 fetch( 或 PROXY');
    check('静态：只用 http / https 发请求', /require\('http'\)/.test(src) && /require\('https'\)/.test(src));
    check('静态：只发 GET', /method: 'GET'/.test(src) && !/method: '(?!GET)/.test(src));
    if (runSection('A')) await sectionNormal();
    if (runSection('B')) await sectionFailures();
    if (runSection('C')) await sectionArgs();
    if (runSection('D')) await sectionFromCommit();
    if (runSection('H')) await sectionDrillFs();
    if (RUN_MUTATIONS) { checkMutationCount(); await sectionMutations(); }
  } catch (e) {
    check('套件自身未抛出异常', false, e && e.stack);
  } finally {
    try { removeTree(TMP_ROOT); } catch (e) { check('清理临时目录', false, e && e.message); }
    check('临时目录已删除', !fs.existsSync(TMP_ROOT), TMP_ROOT);
  }
  console.log(`PASS=${pass} FAIL=${fail}`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main();
