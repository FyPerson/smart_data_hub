#!/usr/bin/env node
/**
 * #106 W4 / S6c：保留缓存的浏览器上下文验证（方案 W4 守卫替换第 4 点：带旧 ETag 的条件请求在资源变化后拿到 200 和新指纹）。
 * 纯进程内：临时 publicDir + 回环 express + 真 Chromium。
 *   A 部分：launchPersistentContext，保留 HTTP 缓存；不设 bypassCSP、不用 page.route / context.route、不禁缓存。
 *   B 部分：用 context.route 只放行本临时服务的完整源（scheme + host + port），其余 http(s) 请求一律中止（Playwright 一旦启用路由就会关掉该上下文的 HTTP 缓存，所以 B 不验缓存，只验浏览器实际发出的本地 JS/CSS 请求）；
 *           被中止的请求里，公网域名（CDN）静默，回环 / localhost / IP 字面量 / 无点主机名（别的本地端口、内网服务）记为失败并打印 URL。
 * 挂法与 S6a 自检相同：注入中间件 + **server.js 里那一段 express.static 的原文**（按起点文本切出，在 vm 里原样执行，只把 __dirname 换成临时根）。
 * 不起 server.js、不碰库、不用 3000。
 * 覆盖面限制：A / B 的页面都在 public 根目录，没覆盖子目录页面里 `../` 这类相对引用（public 目前没有子目录页；<base> 由静态守卫 verify-shared-css-cache-bust.js 的 S5 禁止）。
 * 整体看门狗：默认 120 秒（--watchdog-ms=<毫秒> 可缩短，变异自证用）；到点打印「整体超时」、判红、尽力清理临时目录后强制退出。
 *
 * 「来自缓存 / 发了网络请求」的判据（Playwright 没有 fromCache 公开 API，按下面三层取证）：
 *   ① 服务端访问记录（最强）：每个到达服务器的请求记 url / 状态 / If-None-Match / ETag。某资源在某一步的服务端记录为 0 条 = 浏览器没有发出网络请求。
 *   ② CDP Network 域（page 级 newCDPSession）：`Network.requestServedFromCache`（内存缓存）与 `Network.responseReceived` 里 `response.fromDiskCache`（磁盘缓存）。
 *   ③ Playwright `page.on('request')` 的请求 URL 列表：浏览器**实际要请求**的 URL（含被缓存满足的），用来核对请求路径与指纹文件一致。
 *
 * A 合成页（主判据）：a.html 引用 js/one.js?v=auto、js/two.js?v=auto、css/s.css?v=auto。A1 首开 / A2 请求路径与指纹文件一致 / A3 不改文件再开 / A4 改 one.js 再开 / A5 只改 mtime / A6 旧 ETag 手工条件请求。
 * B 真实页抽查：仓库 wbs-server/public 逐文件复制到另一临时目录（只读源），打开 Task_Pool / Data_Collab / IT_Ledger。
 *   先读复制出的**原始** HTML 建本地 JS/CSS 引用清单（独立基准），与响应 HTML 的清单逐条对比（顺序 / 路径 / 除 v 外的查询参数 / 片段 / 出现次数一致；原始 v 恒为 auto、响应 v 为 12 位十六进制）；
 *   再核对浏览器实际发出的每个本地 JS / CSS 请求都带正确的 12 位指纹（= 该文件字节 sha256 前 12 位）。
 *
 * 变异自证：在 E:/tmp/s6c 的副本上改模块 / server.js，用 --module= / --server-js= 指到副本再跑本脚本，每个变异必须判红。
 * 用法：node scripts/verify-html-fingerprint-browser.js [--module=<路径>] [--server-js=<路径>] [--verbose]
 * 输出：失败逐条列出；末行 `verify-html-fingerprint-browser PASS=<n> FAIL=<n>`；FAIL>0 退出码 1。不进 FAMILY（方案写「验证一次」，FAMILY 现无 Playwright 成员）。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const crypto = require('crypto');
const express = require('express');
const { chromium } = require('playwright');
const { listenOnSafePort } = require('./lib/listen-safe-port');

function argOf(name, dflt) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : dflt;
}
const MODULE_PATH = argOf('module', path.join(__dirname, '..', 'utils', 'html-asset-fingerprint.js'));
const SERVER_JS = argOf('server-js', path.join(__dirname, '..', 'server.js'));
const REPO_PUBLIC = path.join(__dirname, '..', 'public');
const VERBOSE = process.argv.includes('--verbose');
const STARTED = Date.now();

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; return; }
  fail++;
  failures.push(`FAIL ${name}${detail === undefined ? '' : ' | ' + detail}`);
}
const say = (line) => { if (VERBOSE) console.log(line); };

const sha12 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
const HEX12_RE = /^[0-9a-f]{12}$/;
const ROOT_PREFIX = '浏览器指纹 空格 s6c ';

// ───────────────────────── 看门狗 ─────────────────────────
const WATCHDOG_MS = Number(argOf('watchdog-ms', '120000'));
const tempRoots = new Set();   // 已建且尚未确认清理掉的临时根；看门狗触发时尽力清理
let summarized = false;
function printSummary() {
  summarized = true;
  for (const f of failures) console.log(f);
  console.log(`耗时 ${((Date.now() - STARTED) / 1000).toFixed(1)} 秒`);
  console.log(`verify-html-fingerprint-browser PASS=${pass} FAIL=${fail}`);
}
const watchdog = setTimeout(() => {
  fail++;
  failures.push(`FAIL 整体超时 | ${WATCHDOG_MS} 毫秒内没跑完（挂起，不是失败）`);
  for (const d of tempRoots) { try { removeTree(d); } catch (_) { /* 尽力清理：浏览器进程可能还占着文件 */ } }
  printSummary();
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref();
// 兜底：若事件循环因某个 Promise 永不落定而静默排空，进程会以 0 退出——没打印汇总就退出一律判红
process.on('exit', () => {
  if (!summarized) { console.log('FAIL 未走到汇总就退出（有 Promise 永不落定）'); process.exitCode = 1; }
});
/** 关服务：先断开所有保持中的连接再 close，避免浏览器的 keep-alive 连接让 close 悬着 */
function closeServer(server) {
  return new Promise((resolve) => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => resolve());
  });
}

// ───────────────────────── 临时目录 ─────────────────────────
function removeTree(dir) {
  if (!dir.startsWith(path.join(os.tmpdir(), ROOT_PREFIX))) throw new Error('removeTree 只清理自己建的临时根：' + dir);
  let st;
  try { st = fs.lstatSync(dir); } catch (_) { return; }
  if (st.isSymbolicLink()) { try { fs.rmdirSync(dir); } catch (_) { fs.unlinkSync(dir); } return; }
  if (!st.isDirectory()) { fs.unlinkSync(dir); return; }
  for (const name of fs.readdirSync(dir)) removeTree(path.join(dir, name));
  fs.rmdirSync(dir);
}
/** 浏览器刚关闭时 Windows 可能还占着用户数据目录里的文件：有限次重试（有界，不是轮询等待外部条件） */
async function removeTreeWithRetry(dir) {
  let lastErr = null;
  for (let i = 0; i < 20; i++) {
    try { removeTree(dir); return null; } catch (err) { lastErr = err; await new Promise((r) => setTimeout(r, 250)); }
  }
  return lastErr;
}
function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyTree(s, d);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}

// ───────────────────────── 回环服务 ─────────────────────────
/** 与 server.js 相同的挂法：访问记录 → 注入中间件 → server.js 的 static 原文；/api 一律 404 的桩 */
function buildApp(mod, staticBlock, rootDir, accessLog) {
  const app = express();
  app.set('env', 'test');
  app.use((req, res, next) => {
    res.on('finish', () => {
      accessLog.push({ method: req.method, url: req.originalUrl, status: res.statusCode, inm: req.headers['if-none-match'] || null, etag: res.getHeader('etag') || null, cc: res.getHeader('cache-control') || null });
    });
    next();
  });
  app.use(mod.createHtmlAssetInjector({ publicDir: path.join(rootDir, 'public'), startupStamp: 'S6C-STAMP' }));
  vm.runInNewContext(staticBlock, { app, express, path, fs, __dirname: rootDir }, { timeout: 5000 });
  app.use('/api', (req, res) => res.status(404).json({ stub: true }));
  return app;
}
function readStaticBlock(serverSource) {
  const normalized = serverSource.replace(/\r\n/g, '\n');
  const start = "app.use(express.static(path.join(__dirname, 'public'), {";
  check('S0 server.js 里 public 静态挂载起点文本恰 1 处', normalized.split(start).length === 2);
  const s = normalized.indexOf(start);
  const e = normalized.indexOf('\n}));', s);
  if (s < 0 || e < 0) return null;
  return normalized.slice(s, e + 4);
}

/** node http 手工请求（不经浏览器缓存） */
function rawGet(port, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: urlPath, headers: Object.assign({ Connection: 'close' }, headers || {}), agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('请求超时 ' + urlPath)));
    req.end();
  });
}

// ───────────────────────── 浏览器取证 ─────────────────────────
/** page 级探针：Playwright 请求 URL 列表 + CDP 缓存标记。take() 返回自上次 take 以来的记录并清零 */
async function attachProbe(context, page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  let requested = [];
  let byId = new Map();
  page.on('request', (r) => { requested.push(r.url()); });
  cdp.on('Network.requestWillBeSent', (e) => {
    if (!byId.has(e.requestId)) byId.set(e.requestId, { url: e.request.url, type: e.type, memoryCache: false, diskCache: false, status: null });
  });
  cdp.on('Network.requestServedFromCache', (e) => { const r = byId.get(e.requestId); if (r) r.memoryCache = true; });
  cdp.on('Network.responseReceived', (e) => {
    const r = byId.get(e.requestId);
    if (!r) return;
    r.status = e.response.status;
    r.diskCache = !!e.response.fromDiskCache;
  });
  return {
    take() {
      const out = { requested, cdp: [...byId.values()] };
      requested = [];
      byId = new Map();
      return out;
    },
  };
}
const vOf = (url) => new URL(url).searchParams.get('v');
const pathOf = (url) => new URL(url).pathname;
const cdpFor = (cdpList, suffix) => cdpList.filter((r) => pathOf(r.url).endsWith(suffix));
const fromCache = (r) => r.memoryCache || r.diskCache;

async function openNormally(page, url) {
  await page.goto('about:blank');
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
}

// ───────────────────────── A 合成页 ─────────────────────────
const A_HTML = '<!doctype html>\n<html><head><meta charset="utf-8"><title>合成页</title>\n<link rel="stylesheet" href="css/s.css?v=auto">\n</head><body><p id="t">合成页</p>\n<script src="js/one.js?v=auto"></script>\n<script src="js/two.js?v=auto"></script>\n</body></html>\n';
const ONE_V1 = "window.__ONE = 'one-v1';\n";
const ONE_V2 = "window.__ONE = 'one-v2-这一版更长一些，大小也变';\n";
const TWO_V1 = "window.__TWO = 'two-v1';\n";
const CSS_V1 = 'body { color: rgb(18, 52, 86); }\n';

async function partA(mod, staticBlock) {
  // mkdtempSync 自己失败时没有留下目录；成功后立刻进入 try，建文件 / 监听 / 起浏览器的任何失败都由 finally 清理临时根
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), ROOT_PREFIX + 'A '));
  tempRoots.add(ROOT);
  const PUB = path.join(ROOT, 'public');
  const USER_DATA = path.join(ROOT, '浏览器 数据');
  const put = (rel, content) => { const f = path.join(PUB, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); return f; };
  const fpOf = (rel) => sha12(fs.readFileSync(path.join(PUB, ...rel.split('/'))));
  const accessLog = [];
  let server = null;
  let context = null;
  try {
    put('a.html', A_HTML);
    const oneFile = put('js/one.js', ONE_V1);
    put('js/two.js', TWO_V1);
    put('css/s.css', CSS_V1);
    server = await listenOnSafePort(buildApp(mod, staticBlock, ROOT, accessLog));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const pageUrl = base + '/a.html';
    context = await chromium.launchPersistentContext(USER_DATA, { headless: true });
    const page = context.pages()[0] || await context.newPage();
    const probe = await attachProbe(context, page);
    const hits = (suffix) => accessLog.filter((e) => e.url.split('?')[0].endsWith(suffix));
    const resetLog = () => { accessLog.length = 0; };
    const sums = () => ({ one: fpOf('js/one.js'), two: fpOf('js/two.js'), css: fpOf('css/s.css') });

    // ── A1 首次打开 ──
    resetLog();
    await openNormally(page, pageUrl);
    const s1 = sums();
    const t1 = probe.take();
    const htmlHits1 = hits('/a.html');
    const E1 = htmlHits1.length ? htmlHits1[htmlHits1.length - 1].etag : null;
    for (const [suffix, key] of [['/js/one.js', 'one'], ['/js/two.js', 'two'], ['/css/s.css', 'css']]) {
      const sv = hits(suffix);
      check(`A1.${key}.net 首次打开：${suffix} 服务端恰 1 次请求（200）`, sv.length === 1 && sv[0].status === 200, JSON.stringify(sv));
      check(`A1.${key}.v 首次打开：${suffix} 的 URL 上 v = 对应文件 sha256 前 12 位（${s1[key]}）`, sv.length === 1 && vOf('http://x' + sv[0].url) === s1[key], JSON.stringify(sv));
    }
    check('A1.html 首次打开：a.html 200 且带强 ETag', htmlHits1.length >= 1 && htmlHits1[0].status === 200 && /^"[0-9a-f]{32}"$/.test(String(E1)), JSON.stringify(htmlHits1));
    check('A1.one 首次打开：window.__ONE = one-v1', (await page.evaluate(() => window.__ONE)) === 'one-v1');
    check('A1.two 首次打开：window.__TWO = two-v1', (await page.evaluate(() => window.__TWO)) === 'two-v1');
    check('A1.css 首次打开：s.css 真的生效（body 计算色 rgb(18, 52, 86)）', (await page.evaluate(() => getComputedStyle(document.body).color)) === 'rgb(18, 52, 86)');

    // ── A2 请求路径与指纹文件一致（浏览器实际发出的请求 URL → 磁盘文件 → sha256） ──
    const reqs1 = t1.requested.filter((u) => /\.(?:js|css)(?:\?|$)/.test(u));
    check('A2.n 首次打开：浏览器请求的本地 JS/CSS 恰 3 个', reqs1.length === 3, JSON.stringify(reqs1));
    for (const u of reqs1) {
      const decoded = decodeURIComponent(pathOf(u));
      const file = path.join(PUB, ...decoded.split('/').filter((s) => s !== ''));
      let exists = false;
      try { exists = fs.statSync(file).isFile(); } catch (_) { exists = false; }
      const v = vOf(u);
      check(`A2.map ${decoded}：请求路径映射回临时 public 下真实文件，且 URL 的 v（${v}）= 该文件 sha256 前 12 位`, exists && HEX12_RE.test(String(v)) && v === sha12(fs.readFileSync(file)), `file=${file} exists=${exists}`);
      check(`A2.noauto ${decoded}：浏览器请求 URL 不含 v=auto`, !/[?&]v=auto(?:&|$)/.test(u));
    }

    // ── A3 不改任何文件，普通导航再开 ──
    resetLog();
    await openNormally(page, pageUrl);
    const t3 = probe.take();
    const htmlHits3 = hits('/a.html');
    check('A3.html.req 再开：a.html 服务端恰 1 次请求，带的 If-None-Match 就是上次的 ETag', htmlHits3.length === 1 && htmlHits3[0].inm === E1, JSON.stringify(htmlHits3));
    check('A3.html.status 再开：a.html 严格得 304；ETag 未变', htmlHits3.length === 1 && htmlHits3[0].status === 304 && htmlHits3[0].etag === E1, JSON.stringify(htmlHits3));
    say(`A3 a.html 实际状态 = ${htmlHits3.length ? htmlHits3[0].status : 'n/a'}`);
    for (const [suffix, key] of [['/js/one.js', 'one'], ['/js/two.js', 'two'], ['/css/s.css', 'css']]) {
      check(`A3.${key}.net 再开：${suffix} 服务端 0 次请求（没发网络请求）`, hits(suffix).length === 0, JSON.stringify(hits(suffix)));
      const c = cdpFor(t3.cdp, suffix);
      check(`A3.${key}.cache 再开：${suffix} 在浏览器侧被标记为来自缓存（CDP requestServedFromCache / fromDiskCache）`, c.length >= 1 && c.every(fromCache), JSON.stringify(c));
      const u = t3.requested.filter((x) => pathOf(x).endsWith(suffix));
      check(`A3.${key}.v 再开：${suffix} 请求 URL 的 v 与首次相同`, u.length === 1 && vOf(u[0]) === s1[key], JSON.stringify(u));
    }
    check('A3.one 再开：window.__ONE 仍 one-v1', (await page.evaluate(() => window.__ONE)) === 'one-v1');

    // ── A4 改 one.js（内容与大小都变），普通导航再开 ──
    fs.writeFileSync(oneFile, ONE_V2);
    const s4 = sums();
    check('A4.pre 用例成立：one.js 指纹变了、two.js / s.css 没变', s4.one !== s1.one && s4.two === s1.two && s4.css === s1.css);
    resetLog();
    await openNormally(page, pageUrl);
    const t4 = probe.take();
    const htmlHits4 = hits('/a.html');
    const E2 = htmlHits4.length ? htmlHits4[htmlHits4.length - 1].etag : null;
    check('A4.html 改后再开：浏览器带着旧 ETag（E1）发条件请求，服务器回 200 和新 ETag', htmlHits4.length === 1 && htmlHits4[0].inm === E1 && htmlHits4[0].status === 200 && /^"[0-9a-f]{32}"$/.test(String(E2)) && E2 !== E1, JSON.stringify(htmlHits4));
    const one4 = hits('/js/one.js');
    check('A4.one.net 改后再开：one.js 发生网络请求（恰 1 次，200）', one4.length === 1 && one4[0].status === 200, JSON.stringify(one4));
    check('A4.one.v 改后再开：one.js 的 v 变了，等于新内容 sha256 前 12 位', one4.length === 1 && vOf('http://x' + one4[0].url) === s4.one && s4.one !== s1.one, JSON.stringify(one4));
    check('A4.one.val 改后再开：window.__ONE = one-v2…（拿到新内容）', String(await page.evaluate(() => window.__ONE)).startsWith('one-v2'));
    const reqs4 = t4.requested.filter((u) => /\.(?:js|css)(?:\?|$)/.test(u));
    for (const [suffix, key] of [['/js/two.js', 'two'], ['/css/s.css', 'css']]) {
      check(`A4.${key}.net 改后再开：${suffix} 服务端 0 次请求`, hits(suffix).length === 0, JSON.stringify(hits(suffix)));
      const c = cdpFor(t4.cdp, suffix);
      check(`A4.${key}.cache 改后再开：${suffix} 来自缓存`, c.length >= 1 && c.every(fromCache), JSON.stringify(c));
      const u = reqs4.filter((x) => pathOf(x).endsWith(suffix));
      check(`A4.${key}.v 改后再开：${suffix} 的 v 不变`, u.length === 1 && vOf(u[0]) === s1[key], JSON.stringify(u));
    }
    for (const u of reqs4) {
      const file = path.join(PUB, ...decodeURIComponent(pathOf(u)).split('/').filter((s) => s !== ''));
      check(`A2.map4 ${pathOf(u)}：改后再开的请求路径与指纹文件仍一致`, vOf(u) === sha12(fs.readFileSync(file)));
    }

    // ── A5 只改 mtime 不改内容 ──
    const old = new Date(Date.now() - 2 * 3600 * 1000);
    fs.utimesSync(oneFile, old, old);
    const s5 = sums();
    resetLog();
    await openNormally(page, pageUrl);
    const t5 = probe.take();
    const htmlHits5 = hits('/a.html');
    check('A5.html 只改 mtime 再开：a.html 带 E2 条件请求得 304，ETag 未变（指纹只看内容）', htmlHits5.length === 1 && htmlHits5[0].inm === E2 && htmlHits5[0].status === 304 && htmlHits5[0].etag === E2, JSON.stringify(htmlHits5));
    const u5 = t5.requested.filter((x) => pathOf(x).endsWith('/js/one.js'));
    check('A5.one.v 只改 mtime 再开：one.js 请求 URL 的 v 与上一步相同', u5.length === 1 && vOf(u5[0]) === s4.one && s5.one === s4.one, JSON.stringify(u5));
    const raw5 = await rawGet(port, '/a.html');
    const m5 = /js\/one\.js\?v=([0-9a-f]{12})/.exec(raw5.body.toString('utf8'));
    check('A5.one.raw 只改 mtime 后直接取 HTML：one.js 的 v 不变，ETag 不变', !!m5 && m5[1] === s4.one && raw5.headers.etag === E2, `v=${m5 && m5[1]} etag=${raw5.headers.etag}`);
    check('A5.net 只改 mtime 再开：三个资源服务端 0 次请求', hits('/js/one.js').length === 0 && hits('/js/two.js').length === 0 && hits('/css/s.css').length === 0, JSON.stringify(accessLog));

    // ── A6 用第 1 步的旧 ETag 手工发条件请求 ──
    const raw6 = await rawGet(port, '/a.html', { 'If-None-Match': E1 });
    const m6 = /js\/one\.js\?v=([0-9a-f]{12})/.exec(raw6.body.toString('utf8'));
    check('A6.node 旧 ETag（E1）手工条件请求（node http）：200 + 新指纹 + 新 ETag', raw6.status === 200 && !!m6 && m6[1] === s4.one && m6[1] !== s1.one && raw6.headers.etag === E2 && raw6.headers.etag !== E1, `status=${raw6.status} v=${m6 && m6[1]} etag=${raw6.headers.etag}`);
    const pw6 = await context.request.get(pageUrl, { headers: { 'If-None-Match': E1 } });
    const pwBody = (await pw6.text());
    const m6b = /js\/one\.js\?v=([0-9a-f]{12})/.exec(pwBody);
    check('A6.pw 旧 ETag（E1）手工条件请求（Playwright context.request）：200 + 新指纹', pw6.status() === 200 && !!m6b && m6b[1] === s4.one, `status=${pw6.status()} v=${m6b && m6b[1]}`);
    const raw6ok = await rawGet(port, '/a.html', { 'If-None-Match': E2 });
    check('A6.ctl 对照：当前 ETag（E2）条件请求得 304', raw6ok.status === 304);
    say(`A 汇总：E1=${E1} E2=${E2} v(one) ${s1.one} -> ${s4.one}`);
  } finally {
    if (context) { try { await context.close(); } catch (err) { check('A.close 关闭浏览器上下文', false, err.message); } }
    if (server) await closeServer(server);
    const err = await removeTreeWithRetry(ROOT);
    let left = true;
    try { fs.lstatSync(ROOT); } catch (_) { left = false; }
    if (!left) tempRoots.delete(ROOT);
    check('A.clean 临时目录已清理（lstat 确认不存在）', !left && err === null, err ? err.message : ROOT);
  }
}

// ───────────────────────── B 真实页抽查 ─────────────────────────
const B_PAGES = ['Task_Pool.html', 'Data_Collab.html', 'IT_Ledger.html'];
const NON_LOCAL_RE = /^(?:[a-z][a-z0-9+.\-]*:|\/\/)/i;
/** 公网域名之外的主机（回环 / localhost / IP 字面量 / 无点主机名）：被拦下就是越界，不是 CDN */
const isNonCdnHost = (host) => host === 'localhost' || host.includes(':') || /^\d+(?:\.\d+){3}$/.test(host) || !host.includes('.');

/** HTML 里的本地 JS / CSS 引用清单（去注释后扫 script src / link href；顺序、出现次数照实记录）：[{ path, rest, hash, v, key }]。rest = 去掉 v 参数后的查询串；v = 恰一个 v 参数的值，否则 null */
function localRefsOfHtml(html, pageUrl) {
  const refs = [];
  const noComment = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const m of noComment.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const ref = m[1].trim();
    if (NON_LOCAL_RE.test(ref)) continue;
    const u = new URL(ref, pageUrl);
    if (!/\.(?:js|css)$/i.test(u.pathname)) continue;
    const segs = u.search === '' ? [] : u.search.slice(1).split('&');
    const isV = (s) => s === 'v' || s.startsWith('v=');
    const vSegs = segs.filter(isV);
    refs.push({ path: u.pathname, rest: segs.filter((s) => !isV(s)).join('&'), hash: u.hash, v: vSegs.length === 1 ? vSegs[0].slice(2) : null, key: u.pathname + u.search });
  }
  return refs;
}

async function partB(mod, staticBlock) {
  // 同 A：mkdtempSync 成功后立刻进入 try；复制 / 监听 / 起浏览器失败都由 finally 清理
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), ROOT_PREFIX + 'B '));
  tempRoots.add(ROOT);
  const PUB = path.join(ROOT, 'public');
  const accessLog = [];
  let server = null;
  let browser = null;
  try {
    copyTree(REPO_PUBLIC, PUB);
    server = await listenOnSafePort(buildApp(mod, staticBlock, ROOT, accessLog));
    const port = server.address().port;
    const origin = `http://127.0.0.1:${port}`;
    browser = await chromium.launch({ headless: true });
    // B 不验缓存，只验“浏览器实际发出的本地请求”：只放行本临时服务的完整源（scheme + host + port），其余 http(s) 请求一律中止。
    //   中止的请求里，公网域名（CDN）静默；回环 / localhost / IP 字面量 / 无点主机名（= 别的本地端口、内网服务）记为失败并打印 URL。
    const aborted = [];
    const context = await browser.newContext();
    await context.route((url) => (url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== origin, (route) => {
      const u = new URL(route.request().url());
      if (isNonCdnHost(u.hostname)) aborted.push(u.href);
      return route.abort();
    });
    for (const rel of B_PAGES) {
      check(`B.${rel}.exists 页面在复制出的临时 public 里`, fs.existsSync(path.join(PUB, rel)));
      const url = `${origin}/${rel}`;
      const page = await context.newPage();
      const requested = [];
      page.on('request', (r) => { requested.push({ url: r.url(), type: r.resourceType() }); });
      try {
        const resp = await page.goto(url, { waitUntil: 'load', timeout: 30000 });
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        const abortedHere = aborted.splice(0);
        check(`B.${rel}.origin 没有请求越出本临时服务的源（被拦下的回环其他端口 / 内网地址 / localhost 请求为 0）`, abortedHere.length === 0, abortedHere.join(' , '));
        check(`B.${rel}.status 页面 200`, !!resp && resp.status() === 200, String(resp && resp.status()));
        const raw = await rawGet(port, '/' + rel);
        const body = raw.body.toString('utf8');
        check(`B.${rel}.noauto 页面 HTML 不含字面 ?v=auto`, raw.status === 200 && !body.includes('?v=auto'));
        // 独立基准：先读复制出来的**原始** HTML（临时 public 里的文件字节）建本地 JS/CSS 引用清单，再与响应 HTML 的清单逐条对比
        const origRefs = localRefsOfHtml(fs.readFileSync(path.join(PUB, rel), 'utf8'), url);
        const respRefs = localRefsOfHtml(body, url);
        check(`B.${rel}.refcount 原始 HTML 与响应 HTML 的本地 JS/CSS 引用条数一致（原始 ${origRefs.length} / 响应 ${respRefs.length}）且 > 0`, origRefs.length > 0 && origRefs.length === respRefs.length, `orig=${origRefs.length} resp=${respRefs.length}`);
        for (let i = 0; i < Math.max(origRefs.length, respRefs.length); i++) {
          const o = origRefs[i];
          const r = respRefs[i];
          const same = !!o && !!r && o.path === r.path && o.rest === r.rest && o.hash === r.hash;
          check(`B.${rel}.refcmp#${i} ${o ? o.path : '(无)'}：顺序 / 路径 / 除 v 外的查询参数 / 片段与原始一致；原始 v 恒为 auto、响应 v 为 12 位十六进制`, same && o.v === 'auto' && HEX12_RE.test(String(r.v)), `orig=${o ? o.key : '(无)'} resp=${r ? r.key : '(无)'}`);
        }
        const declared = respRefs.map((r) => r.key);
        const local = requested.filter((r) => r.url.startsWith(origin + '/') && (/\.(?:js|css)$/i.test(pathOf(r.url)) || r.type === 'script' || r.type === 'stylesheet'));
        const localKeys = new Set(local.map((r) => pathOf(r.url) + new URL(r.url).search));
        check(`B.${rel}.n 页面声明的本地 JS/CSS 引用 > 0（${declared.length}）且浏览器实际发出的本地 JS/CSS 请求 > 0（${local.length}）`, declared.length > 0 && local.length > 0, `declared=${declared.length} requested=${local.length}`);
        for (const d of declared) check(`B.${rel}.declared ${d}：页面声明的引用都被浏览器实际请求`, localKeys.has(d), d);
        let okCount = 0;
        for (const r of local) {
          const u = new URL(r.url);
          const v = u.searchParams.get('v');
          const file = path.join(PUB, ...decodeURIComponent(u.pathname).split('/').filter((s) => s !== ''));
          let fp = null;
          try { fp = sha12(fs.readFileSync(file)); } catch (_) { fp = null; }
          const good = v !== null && HEX12_RE.test(v) && v !== 'auto' && fp !== null && v === fp;
          if (good) okCount++;
          check(`B.${rel}.req ${u.pathname}${u.search}：带 12 位 v 且等于临时 public 里该文件 sha256 前 12 位`, good, `v=${v} file=${fp === null ? '(读不到)' : fp}`);
        }
        say(`B ${rel}: 声明 ${declared.length} 条 / 实际本地 JS/CSS 请求 ${local.length} 条 / 指纹全对 ${okCount}`);
      } finally {
        await page.close();
      }
    }
    await context.close();
  } finally {
    if (browser) { try { await browser.close(); } catch (err) { check('B.close 关闭浏览器', false, err.message); } }
    if (server) await closeServer(server);
    const err = await removeTreeWithRetry(ROOT);
    let left = true;
    try { fs.lstatSync(ROOT); } catch (_) { left = false; }
    if (!left) tempRoots.delete(ROOT);
    check('B.clean 临时目录已清理（lstat 确认不存在）', !left && err === null, err ? err.message : ROOT);
  }
}

async function main() {
  const mod = require(MODULE_PATH);
  check('M0 模块导出 createHtmlAssetInjector 工厂', typeof mod.createHtmlAssetInjector === 'function');
  const staticBlock = readStaticBlock(fs.readFileSync(SERVER_JS, 'utf8'));
  check('S0 能切出 static 挂载语句', staticBlock !== null && staticBlock.includes('setHeaders'));
  if (staticBlock === null || typeof mod.createHtmlAssetInjector !== 'function') return;
  await partA(mod, staticBlock);
  await partB(mod, staticBlock);
}

main().then(() => {}, (err) => {
  fail++;
  failures.push('FAIL 脚本异常 | ' + (err && err.stack ? err.stack : err));
}).then(() => {
  printSummary();
  process.exitCode = fail === 0 ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode), 5000).unref(); // 兜底：句柄没放干净时 5 秒后按已定的退出码退出（Node v24 + fetch 的 libuv 断言坑：不在成功路径立刻 exit）
});
