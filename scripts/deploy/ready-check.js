#!/usr/bin/env node
/**
 * 部署就绪检查（#106 S8b / 方案 W10 第 7 步）。
 *
 * 用途：部署脚本在 pm2 start 之后，从本机轮询生产的 /api/version 与 /api/health/ready，再逐页核对 HTML 不含字面 ?v=auto。
 * 调用方：S8c 的部署脚本（scripts/deploy-ssh.ps1）；也被 wbs-server/scripts/drill-deploy-failures.js 用来演练失败分支。
 * 只读：只发 GET。只用 node 内置 http / https 发请求，不用 fetch，不读任何代理环境变量
 *   （本机 HTTP_PROXY 会把 172.16.x 的请求转给外部代理而返回 502，见 deploy SKILL Gotcha 8）。
 *   每个请求显式发 `Accept-Encoding: identity`；响应头 content-encoding 存在且不是 identity 一律判坏（压缩字节里查不到 ?v=auto，不能放行）。
 *   不跟随重定向（3xx 判失败）。
 *
 * 命令行：
 *   node ready-check.js --base-url <url> --expect-commit <sha40> --expect-version <x.y.z>
 *     [--expect-mode normal] [--expect-external real] [--expect-background on] [--expect-instance null]
 *     [--timeout-sec 180] [--interval-ms 2000] [--request-timeout-ms 5000] [--check-args]
 *     (--pages-from-commit <sha40> [--repo <dir>] | --pages <a.html,b/c.html>)
 *   缺省期望值 = 生产值；只有演练与自检才覆盖。--expect-instance 的 null 写成字符串 null。
 *   两种页面来源二选一、必须给一个：--pages-from-commit 用 `git ls-tree -r --name-only -z <sha> -- wbs-server/public`
 *   取「本次发布的提交」里的 .html / .htm（不用工作区文件：部署机工作区可能不在该提交上）；--repo 缺省为本脚本所在检出。
 *   --check-args（不带取值）：只做参数校验与 --pages-from-commit 取页面清单，不发任何请求；成功输出 `READY_ARGS_OK <json>`（含页面数），
 *     失败同 READY_ARGS。S8c 在 pm2 stop 之前先调一次，让参数 / 提交 / 页面清单的问题在动生产之前暴露。
 *
 * 主机：--base-url 的主机必须是 IPv4 数字字面量（如 192.168.1.100、127.0.0.1），主机名与 IPv6 字面量一律 READY_ARGS。
 *   理由：域名解析走系统解析器，销毁请求取消不了底层 DNS 查询，解析阻塞时进程会超过总期限才退出；生产用数字 IP，不需要解析。
 *
 * 时间：--timeout-sec 是整个检查的总期限，在解析完参数后、取页面清单之前就开始计时（--check-args 也受它约束）；
 *   `git ls-tree` 子进程的超时取 min(30 秒, 剩余总时间)，超时按取页面清单失败处理（READY_ARGS）；
 *   之后每个请求的超时取 min(--request-timeout-ms, 剩余总时间)，剩余 ≤ 0 时停止本轮逐页检查并按超时收尾。
 *   所以最坏时长 ≈ --timeout-sec（加进程启停）；外层再套超时的话，给 --timeout-sec + --request-timeout-ms + 余量。
 *
 * 关键模块集合的完整性由服务端保证，本脚本不另存模块名单：server.js 的 /api/health/ready 把 sources 写成固定字面量（11 项），
 *   utils/health-ready.js 的 buildReport 对每个键必出一项，访问函数抛异常也记为未就绪（INIT_FAILED）。本脚本只要求 modules 非空且逐项 ready === true。
 *   （把名单抄进这里会在服务端增减模块时造出第二份要同步的真相。）
 *
 * 每一轮依次检查（遇到第一个不过的项就结束本轮，等一个间隔再来）：
 *   1 /api/version 返回 200 且为 JSON；version、commit、mode、external、background、instance 与期望全等。
 *   2 /api/health/ready 返回 200，ok === true，modules 非空且每项 ready === true（严格 true，"yes" / 1 不算）。
 *   3 以上都过之后逐页 GET：状态码 200，响应体不含字面 ?v=auto（本轮把所有页面查完，列出全部不合格的页）。
 *   总期限约束的是「等待多久」，不改变观察结果的真假：一轮在期限前开始、跨过期限才全部通过，照实报 READY_OK（codex 38-R L1 驳回，理由同此）。
 *   一轮全过即 OK（不要求连续两轮；新进程反复崩溃重启的情形由 S8c 在 pm2 start 后记 restart_time、READY_OK 后再读一次来排除）。
 *   ?v=auto 按字面全文查找（页面注释 / 文本里出现该字面量也会判坏；当前页面只出现在 script / link 引用里）。
 *
 * 输出协议：stdout 最后一行恰好是 `READY_OK <json>`、`READY_FAIL <json>` 或（--check-args）`READY_ARGS_OK <json>`。
 *   READY_OK 的 json：elapsedMs、rounds、pages、version、commit。
 *   READY_FAIL 的 json：code 为 READY_TIMEOUT（超时，退出码 1）、READY_ARGS（参数错误，退出码 2）或 READY_INTERNAL（脚本内部异常，退出码 3）。
 *     READY_TIMEOUT 带 elapsedMs、rounds、lastObserved：stage（version / ready / pages）+ 该项的细节
 *       （error 连接错误码如 ECONNREFUSED、REQUEST_TIMEOUT、DEADLINE，或 encoded:<content-encoding>；status、notJson、
 *        mismatches[{field,expected,actual}]（响应里缺字段时 actual 为 "(缺失)"）、unready[{module,code}]、
 *        bad[{page,status|error|hasVAuto}]、truncated / checked（总期限到了、逐页没查完））。
 *     version 阶段不符字段只有 commit 且实际值为 null 时，READY_FAIL 顶层多一个 hint:"COMMIT_NULL"
 *       （生产启动时 git rev-parse 没取到提交号；S8c 应先核远端 HEAD，不要直接回滚）。
 *   不打印响应体原文，只打印字段值（截断）与页面名。
 */
'use strict';

const http = require('http');
const https = require('https');
const path = require('path');
const { execFileSync } = require('child_process');

const SHA_RE = /^[0-9a-f]{40}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const KNOWN_FLAGS = ['--base-url', '--expect-commit', '--expect-version', '--expect-mode', '--expect-external', '--expect-background', '--expect-instance',
  '--timeout-sec', '--interval-ms', '--request-timeout-ms', '--pages-from-commit', '--repo', '--pages'];
const BOOL_FLAGS = ['--check-args'];
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_BAD_PAGES = 20;
const MAX_VALUE_CHARS = 80;

class ArgsError extends Error {}

/** IPv4 点分十进制字面量（URL 解析器已把 127.1、0x7f.1 之类规整成四段十进制） */
function isIpv4Literal(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return m !== null && m.slice(1).every((s) => Number(s) <= 255);
}

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (BOOL_FLAGS.includes(flag)) {
      if (Object.prototype.hasOwnProperty.call(values, flag)) throw new ArgsError(`参数重复：${flag}`);
      values[flag] = true;
      i -= 1;   // 开关没有取值：只前进一格
      continue;
    }
    if (!KNOWN_FLAGS.includes(flag)) throw new ArgsError(`未知参数或位置参数：${flag}`);
    if (Object.prototype.hasOwnProperty.call(values, flag)) throw new ArgsError(`参数重复：${flag}`);
    const v = argv[i + 1];
    if (typeof v !== 'string' || v === '' || v.startsWith('--')) throw new ArgsError(`参数缺少取值：${flag}`);
    values[flag] = v;
  }
  for (const f of ['--base-url', '--expect-commit', '--expect-version']) {
    if (!Object.prototype.hasOwnProperty.call(values, f)) throw new ArgsError(`缺少参数：${f}`);
  }
  let base;
  try { base = new URL(values['--base-url']); } catch (_) { throw new ArgsError(`--base-url 不是合法 URL：${values['--base-url']}`); }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new ArgsError('--base-url 只接受 http / https');
  if (base.username !== '' || base.password !== '' || base.search !== '' || base.hash !== '' || (base.pathname !== '/' && base.pathname !== '')) {
    throw new ArgsError('--base-url 只能是 协议://主机[:端口]，不带路径、查询串、凭证');
  }
  if (!isIpv4Literal(base.hostname)) throw new ArgsError(`--base-url 的主机必须是 IPv4 数字字面量（不接受主机名 / IPv6）：${base.hostname}`);
  if (!SHA_RE.test(values['--expect-commit'])) throw new ArgsError('--expect-commit 必须是 40 位小写十六进制');
  if (!VERSION_RE.test(values['--expect-version'])) throw new ArgsError('--expect-version 必须是 x.y.z 形式');
  const hasFrom = Object.prototype.hasOwnProperty.call(values, '--pages-from-commit');
  const hasPages = Object.prototype.hasOwnProperty.call(values, '--pages');
  if (hasFrom === hasPages) throw new ArgsError('--pages-from-commit 与 --pages 必须二选一，且必须给一个');
  if (hasFrom && !SHA_RE.test(values['--pages-from-commit'])) throw new ArgsError('--pages-from-commit 必须是 40 位小写十六进制');
  if (!hasFrom && Object.prototype.hasOwnProperty.call(values, '--repo')) throw new ArgsError('--repo 只能与 --pages-from-commit 一起用');
  const intOf = (flag, def, min, max) => {
    if (!Object.prototype.hasOwnProperty.call(values, flag)) return def;
    if (!/^\d+$/.test(values[flag])) throw new ArgsError(`${flag} 必须是整数`);
    const n = Number(values[flag]);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new ArgsError(`${flag} 必须在 ${min}–${max} 之间`);
    return n;
  };
  const expectInstance = values['--expect-instance'] === undefined || values['--expect-instance'] === 'null' ? null : values['--expect-instance'];
  let pages = null;
  if (hasPages) {
    pages = values['--pages'].split(',');
    for (const p of pages) {
      if (p === '' || p.startsWith('/') || p.split('/').includes('..') || /[?#\\]/.test(p)) throw new ArgsError(`--pages 里有不合法的页面名：${JSON.stringify(p)}`);
    }
  }
  return {
    baseUrl: base,
    expect: {
      version: values['--expect-version'],
      commit: values['--expect-commit'],
      mode: values['--expect-mode'] === undefined ? 'normal' : values['--expect-mode'],
      external: values['--expect-external'] === undefined ? 'real' : values['--expect-external'],
      background: values['--expect-background'] === undefined ? 'on' : values['--expect-background'],
      instance: expectInstance,
    },
    timeoutMs: intOf('--timeout-sec', 180, 1, 86400) * 1000,
    intervalMs: intOf('--interval-ms', 2000, 10, 600000),
    requestTimeoutMs: intOf('--request-timeout-ms', 5000, 50, 600000),
    checkArgs: values['--check-args'] === true,
    pagesFromCommit: hasFrom ? values['--pages-from-commit'] : null,
    repo: path.resolve(Object.prototype.hasOwnProperty.call(values, '--repo') ? values['--repo'] : path.join(__dirname, '..', '..')),
    pages,
  };
}

/** 取提交里 wbs-server/public 下的 .html / .htm（相对 public 的路径，排序）。gitTimeoutMs = min(30 秒, 剩余总时间)，超时算取清单失败 */
function pagesFromCommit(repo, sha, gitTimeoutMs) {
  if (!(gitTimeoutMs > 0)) throw new ArgsError(`总期限已用完，来不及取提交 ${sha} 的页面清单`);
  const env = Object.assign({}, process.env);
  for (const k of Object.keys(env)) if (/^GIT_(DIR|COMMON_DIR|WORK_TREE|INDEX_FILE)$/i.test(k)) delete env[k];
  let out;
  try {
    out = execFileSync('git', ['-C', repo, 'ls-tree', '-r', '--name-only', '-z', sha, '--', 'wbs-server/public'], { encoding: 'utf8', env, timeout: gitTimeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (e && e.code === 'ETIMEDOUT') throw new ArgsError(`git ls-tree 超时（${gitTimeoutMs} ms，仓库 ${repo}，提交 ${sha}）`);
    throw new ArgsError(`git ls-tree 失败（仓库 ${repo}，提交 ${sha}）：${String((e && e.stderr) || (e && e.message) || e).trim().split('\n')[0].slice(0, 200)}`);
  }
  const prefix = 'wbs-server/public/';
  const pages = out.split('\0').filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length)).filter((p) => /\.html?$/i.test(p)).sort();
  if (pages.length === 0) throw new ArgsError(`提交 ${sha} 的 wbs-server/public 下没有 .html / .htm 页面`);
  return pages;
}

const clip = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.length > MAX_VALUE_CHARS ? `${v.slice(0, MAX_VALUE_CHARS)}…` : v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  return `(${Array.isArray(v) ? 'array' : typeof v})`;
};

/**
 * 单个 GET：resolve { status, body } 或 { error }（连接错误码 / REQUEST_TIMEOUT / DEADLINE / BODY_TOO_LARGE / encoded:<content-encoding>）。
 * 不跟随重定向。timeoutMs 覆盖到响应体读完；<= 0 表示总期限已到，不发请求。
 */
function httpGet(baseUrl, urlPath, timeoutMs) {
  return new Promise((resolve) => {
    if (timeoutMs <= 0) { resolve({ error: 'DEADLINE' }); return; }
    const lib = baseUrl.protocol === 'https:' ? https : http;
    const opts = {
      method: 'GET',
      hostname: baseUrl.hostname.replace(/^\[|\]$/g, ''),
      port: baseUrl.port === '' ? undefined : Number(baseUrl.port),
      path: urlPath,
      headers: { Accept: '*/*', 'Accept-Encoding': 'identity', Connection: 'close' },
      agent: false,
    };
    let settled = false;
    let timer = null;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const req = lib.request(opts, (res) => {
      const encoding = res.headers['content-encoding'];
      if (encoding !== undefined && String(encoding).trim().toLowerCase() !== 'identity') {
        done({ error: `encoded:${clip(String(encoding).trim())}`, status: res.statusCode });
        res.resume();
        req.destroy();
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) { done({ error: 'BODY_TOO_LARGE' }); req.destroy(); return; }
        chunks.push(c);
      });
      res.on('end', () => done({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (e) => done({ error: (e && e.code) || 'RESPONSE_ERROR' }));
    });
    timer = setTimeout(() => { done({ error: 'REQUEST_TIMEOUT' }); req.destroy(); }, timeoutMs);
    req.on('error', (e) => done({ error: (e && e.code) || 'REQUEST_ERROR' }));
    req.on('close', () => done({ error: 'CONNECTION_CLOSED' }));
    req.end();
  });
}

const parseJson = (s) => { try { const v = JSON.parse(s); return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch (_) { return null; } };

/** 单个请求的超时：min(--request-timeout-ms, 总期限剩余)；总期限已到返回 0 */
function reqTimeout(cfg) {
  const left = cfg.deadline - Date.now();
  return left <= 0 ? 0 : Math.min(cfg.requestTimeoutMs, left);
}

async function checkVersion(cfg) {
  const r = await httpGet(cfg.baseUrl, '/api/version', reqTimeout(cfg));
  if (r.error) return r.status === undefined ? { stage: 'version', error: r.error } : { stage: 'version', status: r.status, error: r.error };
  if (r.status !== 200) return { stage: 'version', status: r.status };
  const j = parseJson(r.body);
  if (j === null) return { stage: 'version', status: r.status, notJson: true };
  const mismatches = [];
  for (const field of ['version', 'commit', 'mode', 'external', 'background', 'instance']) {
    const expected = cfg.expect[field];
    const actual = Object.prototype.hasOwnProperty.call(j, field) ? j[field] : undefined;
    if (actual !== expected) mismatches.push({ field, expected, actual: actual === undefined ? '(缺失)' : clip(actual) });
  }
  if (mismatches.length) {
    const detail = { stage: 'version', status: r.status, mismatches };
    // 生产启动时 git rev-parse 没取到提交号（commit 为 null）：只有 commit 不符且实际值为 null 时给提示，S8c 据此区分「先核远端 HEAD」与「真的版本不对」
    if (mismatches.length === 1 && mismatches[0].field === 'commit' && j.commit === null) detail.hint = 'COMMIT_NULL';
    return detail;
  }
  return null;
}

async function checkReady(cfg) {
  const r = await httpGet(cfg.baseUrl, '/api/health/ready', reqTimeout(cfg));
  if (r.error) return r.status === undefined ? { stage: 'ready', error: r.error } : { stage: 'ready', status: r.status, error: r.error };
  const j = r.status === 200 || r.status === 503 ? parseJson(r.body) : null;
  const unready = [];
  let modulesOk = false;
  if (j !== null && j.modules !== null && typeof j.modules === 'object' && !Array.isArray(j.modules)) {
    const names = Object.keys(j.modules);
    modulesOk = names.length > 0;
    for (const n of names) {
      const m = j.modules[n];
      if (!(m !== null && typeof m === 'object' && m.ready === true)) unready.push({ module: n, code: m !== null && typeof m === 'object' && typeof m.code === 'string' ? clip(m.code) : null });
    }
  }
  if (r.status === 200 && j !== null && j.ok === true && modulesOk && unready.length === 0) return null;
  const detail = { stage: 'ready', status: r.status };
  if (r.status === 200 || r.status === 503) {
    if (j === null) detail.notJson = true;
    else {
      detail.ok = j.ok === true;
      detail.unready = unready;
      if (!modulesOk) detail.noModules = true;
    }
  }
  return detail;
}

async function checkPages(cfg, pages) {
  const bad = [];
  let badCount = 0;
  let checked = 0;
  let truncated = false;
  for (const page of pages) {
    const t = reqTimeout(cfg);
    if (t <= 0) { truncated = true; break; }   // 总期限到了：停止逐页检查，按超时收尾
    const urlPath = `/${page.split('/').map(encodeURIComponent).join('/')}`;
    const r = await httpGet(cfg.baseUrl, urlPath, t);
    checked += 1;
    let problem = null;
    if (r.error) problem = { page, error: r.error };
    else if (r.status !== 200) problem = { page, status: r.status };
    else if (r.body.includes('?v=auto')) problem = { page, hasVAuto: true };
    if (problem) { badCount += 1; if (bad.length < MAX_BAD_PAGES) bad.push(problem); }
  }
  if (badCount === 0 && !truncated) return null;
  const detail = { stage: 'pages', badCount, bad };
  if (truncated) { detail.truncated = true; detail.checked = checked; }
  return detail;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const emit = (kind, obj) => process.stdout.write(`${kind} ${JSON.stringify(obj)}\n`);

async function main() {
  let cfg;
  let pages;
  const started = Date.now();
  try {
    cfg = parseArgs(process.argv.slice(2));
    cfg.deadline = started + cfg.timeoutMs;   // 总期限在取页面清单之前就开始计时（--check-args 也受约束）
    pages = cfg.pages !== null ? cfg.pages : pagesFromCommit(cfg.repo, cfg.pagesFromCommit, Math.min(30000, cfg.deadline - Date.now()));
  } catch (e) {
    if (!(e instanceof ArgsError)) throw e;
    emit('READY_FAIL', { code: 'READY_ARGS', message: e.message });
    process.exitCode = 2;
    return;
  }
  if (cfg.checkArgs) {
    // 只校验参数与页面清单，不发任何请求
    emit('READY_ARGS_OK', { pages: pages.length, version: cfg.expect.version, commit: cfg.expect.commit, baseUrl: cfg.baseUrl.origin });
    process.exitCode = 0;
    return;
  }
  const deadline = cfg.deadline;
  let rounds = 0;
  let last = null;
  for (;;) {
    rounds += 1;
    const budget = deadline - Date.now();
    const obs = (await checkVersion(cfg)) || (await checkReady(cfg)) || (await checkPages(cfg, pages));
    if (obs === null) {
      emit('READY_OK', { elapsedMs: Date.now() - started, rounds, pages: pages.length, version: cfg.expect.version, commit: cfg.expect.commit });
      process.exitCode = 0;
      return;
    }
    // 只有「本轮连 /api/version 都没拿到结果、且原因只是总期限不够」时才保留上一轮观察（这一轮没有任何新信息）。
    // 本轮只要 version 有了结果（不符或已通过），就用本轮观察：version 已通过而后面的 ready / 页面失败或截断，
    // 都比上一轮的旧诊断新，旧的 COMMIT_NULL 提示也随之作废（codex 38-R M1）。
    const noNewInfo = obs.stage === 'version' && (obs.error === 'REQUEST_TIMEOUT' || obs.error === 'DEADLINE');
    if (!(noNewInfo && budget < cfg.requestTimeoutMs && last !== null)) last = obs;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(cfg.intervalMs, remaining));
    if (deadline - Date.now() < 50) break;   // 剩下的时间做不了一次有意义的请求：保留上一轮的真实观察，不让「没时间」冒充观察结果
  }
  const fail = { code: 'READY_TIMEOUT', elapsedMs: Date.now() - started, rounds };
  if (last.hint) { fail.hint = last.hint; delete last.hint; }
  fail.lastObserved = last;
  emit('READY_FAIL', fail);
  process.exitCode = 1;
}

main().catch((e) => {
  emit('READY_FAIL', { code: 'READY_INTERNAL', message: `脚本内部异常：${String(e && e.message).slice(0, 200)}` });
  process.exitCode = 3;
});
