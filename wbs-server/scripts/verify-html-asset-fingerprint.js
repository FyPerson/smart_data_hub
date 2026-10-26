#!/usr/bin/env node
/**
 * #106 W4 / S6a：HTML 缓存串注入中间件（utils/html-asset-fingerprint.js）自检。纯进程内：临时 publicDir + 回环 express，不起 server.js、不碰库。
 *
 * 临时根建在系统临时目录下，路径含「中文 空格」一段（路径类坑：Windows 空格 + CJK）。
 * 挂法与 server.js 相同：注入中间件 + **server.js 里那一段 express.static 的原文**（按起点文本切出，在 vm 里原样执行，只把 __dirname 换成临时根）。
 * 所以 setHeaders 不是“照抄一份比对”，而是直接执行 server.js 的字节；server.js 里的 setHeaders 改坏，本脚本就会判红。
 *
 * 覆盖：① 替换正确 ② 资源 / 页面变化只影响相关引用与 ETag ③ 条件请求 ④ 响应头与 HEAD ⑤ 覆盖面向量（别名 / 出界 / 目录 / 点开头 / 联接点）
 *       ⑥ 不干扰（/api、资源缓存头、?v=auto 资源 no-cache、static 单独的大小写扩展名、/uploads 与 /archive 原样、无占位页面字节全等）
 *       ⑦ 读文件失败 ⑧ server.js 挂载顺序静态核对 ⑨ R 组：rawPathname 与 parseurl 逐 URL 对拍（含 `#` / 空白 / NBSP / BOM / 反斜杠 / `//user@host/` / 绝对 URL 形式）
 *       + 与 serve-static 解析到同一个 parseurl 文件（防依赖分叉）。
 * 变异自证（⑦ 在任务报告里）：在 E:/tmp/s6 的副本上改模块 / server.js，用 --module= / --server-js= 指到副本再跑本脚本，每个变异必须判红。
 *
 * 用法：node scripts/verify-html-asset-fingerprint.js [--module=<路径>] [--server-js=<路径>] [--verbose]
 * 输出：失败逐条列出；末行 `verify-html-asset-fingerprint PASS=<n> FAIL=<n>`；FAIL>0 退出码 1。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const crypto = require('crypto');
const express = require('express');
const { listenOnSafePort } = require('./lib/listen-safe-port');

function argOf(name, dflt) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : dflt;
}
const MODULE_PATH = argOf('module', path.join(__dirname, '..', 'utils', 'html-asset-fingerprint.js'));
const SERVER_JS = argOf('server-js', path.join(__dirname, '..', 'server.js'));
const VERBOSE = process.argv.includes('--verbose');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; return; }
  fail++;
  failures.push(`FAIL ${name}${detail === undefined ? '' : ' | ' + detail}`);
}
const say = (line) => { if (VERBOSE) console.log(line); };

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sha12 = (buf) => sha256(buf).slice(0, 12);
const STRONG_ETAG_RE = /^"[0-9a-f]{32}"$/;

// ───────────────────────── 临时 publicDir ─────────────────────────
const ROOT_PREFIX = '自检 空格 haf ';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), ROOT_PREFIX));
const PUB = path.join(ROOT, 'public');
const EXT = path.join(ROOT, 'ext');

function put(rel, content, base) {
  const full = path.join(base || PUB, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}
function removeTree(dir) {
  if (!dir.startsWith(path.join(os.tmpdir(), ROOT_PREFIX))) throw new Error('removeTree 只清理自己建的临时根：' + dir);
  let st;
  try { st = fs.lstatSync(dir); } catch (_) { return; }
  if (st.isSymbolicLink()) { try { fs.rmdirSync(dir); } catch (_) { fs.unlinkSync(dir); } return; }
  if (!st.isDirectory()) { fs.unlinkSync(dir); return; }
  for (const name of fs.readdirSync(dir)) removeTree(path.join(dir, name));
  fs.rmdirSync(dir);
}
const fileFp = (rel) => sha12(fs.readFileSync(path.join(PUB, ...rel.split('/'))));

// 页面 = 字符串与占位 {k} 的数组：源文件里占位写成 `?v=auto`，期望里写成 `?v=<fps[k]>`
const render = (parts, mapper) => parts.map((p) => (typeof p === 'string' ? p : mapper(p.k))).join('');
const srcOf = (parts) => render(parts, () => '?v=auto');
const expOf = (parts, fps) => render(parts, (k) => '?v=' + fps[k]);

const A = { k: 'app' };
const S = { k: 'style' };
const O = { k: 'other' };
const MISSING = { k: 'missing' };
const ESCAPE = { k: 'escape' };
const JUNCTION = { k: 'junction' };
const CN1 = { k: 'cn1' };
const CN2 = { k: 'cn2' };
const L = { k: 'lib' };

const P_PARTS = [
  '<!doctype html>\r\n<html><head><meta charset="utf-8"><title>干净页面</title>\r\n',
  '<link rel="stylesheet" href="assets/style.css', S, '">\r\n',
  '</head><body>\r\n<p>中文正文</p>\r\n',
  '<script src="assets/app.js', A, '"></script>\r\n</body></html>\r\n',
];
const LEGACY_PARTS = ['<!doctype html><title>旧扩展名</title><script src="assets/app.js', A, '"></script>\n'];
const BIG_PARTS = ['<!doctype html><title>大写扩展名</title><script src="assets/app.js', A, '"></script>\n'];
const SUB_PARTS = [
  '<!doctype html><title>子目录默认页</title>\n',
  '<script src="lib.js', L, '"></script>\n',
  '<script src="../assets/app.js', A, '"></script>\n',
  '<link rel="stylesheet" href="/assets/style.css', S, '">\n',
];
// 自定义元素 / 近似标签名：`<style-panel>`、`<script-editor>`、`<linkx>` 不是 style / script / link，不得吞掉其后的真实标签，自己的 src / href 也不替换
const CUSTOM_PARTS = [
  '<!doctype html><title>自定义元素</title>\n',
  '<style-panel></style-panel>\n',
  '<script-editor>内容</script-editor>\n',
  '<script src="assets/app.js', A, '"></script>\n',
  '<link rel="stylesheet" href="assets/style.css', S, '">\n',
  '<linkx href="assets/other.js?v=auto">\n',
  '<script-editor src="assets/other.js?v=auto"></script-editor>\n',
  '<style-panel src="assets/other.js?v=auto"></style-panel>\n',
];
// 文本元素（47R1a M1）：textarea / title（RCDATA）、xmp / iframe / noembed / noframes（RAWTEXT）的正文是纯文本，里面的 `<script src="…?v=auto">` 不是标签，逐字不变；
// 它们之后真实的 script / link 照常注入（结束标签大小写混写、`</名字` 后跟空白 / 换行都认；`</title>` 不会提前结束 textarea；`<textareax>` 不是 textarea）
const TEXTEL_PARTS = [
  '<!doctype html>\n<html><head><meta charset="utf-8"><title><script src="/demo.js?v=auto"></script> 标题里的伪标签</title>\n',
  '<link rel="stylesheet" href="assets/style.css', S, '">\n',
  '</head><body>\n',
  '<textarea id="t1"><script src="/demo.js?v=auto"></script><link href="/demo.css?v=auto"></textarea><script src="assets/app.js', A, '"></script>\n',
  '<TEXTAREA rows=2><script src="/demo.js?v=auto"></script></TextArea ><script src="assets/other.js', O, '"></script>\n',
  '<textarea>\n<script src="/demo.js?v=auto"></script>\n</textarea\n><link rel="stylesheet" href="assets/style.css', S, '">\n',
  '<textarea>x</title><script src="/demo.js?v=auto"></script></textarea><script src="assets/app.js', A, '"></script>\n',
  '<textarea title="a>b"><script src="/demo.js?v=auto"></script></textarea><script src="assets/app.js', A, '"></script>\n',
  '<xmp><script src="/demo.js?v=auto"></script></xmp><iframe><script src="/demo.js?v=auto"></script></iframe><noembed><script src="/demo.js?v=auto"></script></noembed><noframes><script src="/demo.js?v=auto"></script></noframes>\n',
  '<script src="assets/app.js', A, '"></script>\n',
  '<textareax><script src="assets/app.js', A, '"></script></textareax>\n',
  '<titlex><link rel="stylesheet" href="assets/style.css', S, '"></titlex>\n',
  '</body></html>\n',
];
// 未闭合的 textarea：到文件尾都是文本，其后的内容原样输出（含字面 ?v=auto），不注入
const UNCLOSED_PARTS = [
  '<!doctype html><title>未闭合</title>\n',
  '<script src="assets/app.js', A, '"></script>\n',
  '<textarea>\n<script src="assets/app.js?v=auto"></script>\n<link rel="stylesheet" href="assets/style.css?v=auto">\n</body></html>\n',
];
// 目录 / 文件名以两个点开头但不是 `..`（47R1a L1）：页面与资源都在这样的目录里
const DOTDOT_PARTS = [
  '<!doctype html><title>点点开头目录</title>\n',
  '<script src="/..assets/a.js', { k: 'dd1' }, '"></script>\n',
  '<script src="a2.js', { k: 'dd2' }, '"></script>\n',
  '<link rel="stylesheet" href="../..assets/c.css', { k: 'dd3' }, '">\n',
];
const RICH_PARTS = [
  '<!doctype html>\n<html><head><meta charset="utf-8"><title>丰富页面</title>\n',
  '<!-- <script src="assets/app.js?v=auto"></script> 注释里的 ?v=auto -->\n',
  '<link rel="stylesheet" href="assets/style.css', S, '">\n',
  "<link rel='stylesheet' href='assets/style.css", S, "#frag'>\n",
  '<script src="https://cdn.example.com/lib.js?v=auto"></script>\n',
  '<script src="//cdn.example.com/lib2.js?v=auto"></script>\n',
  '<script src="https://cdn.example.com/plain.js"></script>\n',
  "<style>.a{background:url('assets/bg.png?v=auto')}</style>\n",
  '</head><body>\n',
  '<script src="assets/app.js', A, '"></script>\n',
  "<script src='assets/app.js", A, "&x=1'></script>\n",
  '<script defer src=/assets/other.js', O, '></script>\n',
  '<script src="assets/missing.js', MISSING, '"></script>\n',
  '<script src="../escape.js', ESCAPE, '"></script>\n',
  '<script src="link/ext.js', JUNCTION, '"></script>\n',
  '<script src="assets/%E4%B8%AD%E6%96%87.js', CN1, '"></script>\n',
  '<script src="assets/文件二.js', CN2, '"></script>\n',
  '<script>var s = \'<script src="assets/app.js?v=auto"><\\/script>\'; var t = "x.js?v=auto";</script>\n',
  '<p>正文里的 ?v=auto 不动</p>\n',
  '<link rel="icon" href="assets/style.css?x=1">\n',
  '<script src="assets/app.js?v=autox"></script>\n',
  '<a href="assets/app.js?v=auto">不是资源引用</a>\n',
  '</body></html>\n',
];

function writeFixtures() {
  put('assets/app.js', 'window.APP = "app-1";\n');
  put('assets/style.css', 'body { color: #111; }\n');
  put('assets/other.js', 'window.OTHER = "other-1";\n');
  put('assets/中文.js', 'window.CN1 = 1;\n');
  put('assets/文件二.js', 'window.CN2 = 2;\n');
  put('sub/lib.js', 'window.LIB = 1;\n');
  put('sub2/readme.txt', 'no index here\n');
  put('escape.js', 'window.ESCAPE_TARGET = 1;\n');
  put('p.html', srcOf(P_PARTS));
  put('api/p.html', srcOf(P_PARTS)); // 仅用于验证 /api/ 前缀被注入中间件让路（见 6.2）
  put('legacy.htm', srcOf(LEGACY_PARTS));
  put('Big.HTML', srcOf(BIG_PARTS));
  put('sub/index.html', srcOf(SUB_PARTS));
  put('rich.html', srcOf(RICH_PARTS));
  put('.hidden.html', '<script src="assets/app.js?v=auto"></script>\n');
  put('locked.html', '<script src="assets/app.js?v=auto"></script> LOCKED-CONTENT\n');
  put('custom.html', srcOf(CUSTOM_PARTS));
  put('textel.html', srcOf(TEXTEL_PARTS));
  put('unclosed.html', srcOf(UNCLOSED_PARTS));
  put('..assets/a.js', 'window.DD1 = 1;\n');
  put('..assets/c.css', 'body { color: #222; }\n');
  put('..pages/a2.js', 'window.DD2 = 2;\n');
  put('..pages/p.html', srcOf(DOTDOT_PARTS));
  put('sized.html', '<script src="assets/app.js?v=auto"></script>\nSIZED-ONE\n');
  put('miss.html', '<script src="assets/late.js?v=auto"></script>\n');
  put('plain.html', '<!doctype html>\r\n<html><head><meta charset="utf-8"><title>无占位页面</title>\r\n<script src="assets/app.js?v=1.2.3_old"></script>\r\n</head><body>中文正文 ? v=auto\r\n</body></html>\r\n');
  // /uploads 与 /archive 是各自的 express.static，内容里的 ?v=auto 必须原样（本中间件只管 public）
  put('a.html', '<script src="assets/app.js?v=auto"></script> UPLOAD-A\n', path.join(ROOT, 'uploads'));
  put('x.txt', 'uploads x ?v=auto\n', path.join(ROOT, 'uploads'));
  put('b.html', '<script src="assets/app.js?v=auto"></script> ARCHIVE-B\n', path.join(ROOT, 'archive'));
  // 非 UTF-8 字节必须原样穿过（页面按字节处理，不能经 utf-8 往返改写）
  fs.writeFileSync(path.join(PUB, 'bytes.html'), Buffer.concat([
    Buffer.from('<!doctype html>\n<script src="assets/app.js?v=auto"></script>\n', 'latin1'),
    Buffer.from([0xff, 0xfe, 0x80, 0xc3, 0x28, 0x0a]),
    Buffer.from('<link rel="stylesheet" href="assets/style.css?v=auto">\n', 'latin1'),
  ]));
  // public 之外的 HTML 与联接点（public/link -> ROOT/ext）
  put('outside.html', '<p>OUTSIDE-SECRET</p> <script src="public/assets/app.js?v=auto"></script>\n', ROOT);
  put('outside2.html', '<p>JUNCTION-SECRET</p> <script src="ext.js?v=auto"></script>\n', EXT);
  put('ext.js', 'window.EXT = 1;\n', EXT);
  fs.symlinkSync(EXT, path.join(PUB, 'link'), 'junction');
}

// ───────────────────────── HTTP 小工具 ─────────────────────────
function request(port, method, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: Object.assign({ Connection: 'close' }, headers || {}), agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('请求超时 ' + method + ' ' + urlPath)));
    req.end();
  });
}
const text = (r) => r.body.toString('utf8');
const latin = (r) => r.body.toString('latin1');

function readStaticBlock(serverSource) {
  const normalized = serverSource.replace(/\r\n/g, '\n');
  const start = "app.use(express.static(path.join(__dirname, 'public'), {";
  check('S0 server.js 里 public 静态挂载起点文本恰 1 处', normalized.split(start).length === 2);
  const s = normalized.indexOf(start);
  const e = normalized.indexOf('\n}));', s);
  if (s < 0 || e < 0) return { normalized, block: null, start };
  return { normalized, block: normalized.slice(s, e + 4), start };
}

function buildApp(mod, staticBlock, withInjector, extra) {
  const app = express();
  app.set('env', 'test'); // 错误处理器不打印堆栈
  if (withInjector) app.use(mod.createHtmlAssetInjector(Object.assign({ publicDir: PUB }, extra)));
  vm.runInNewContext(staticBlock, { app, express, path, fs, __dirname: ROOT }, { timeout: 5000 });
  app.use('/uploads', express.static(path.join(ROOT, 'uploads')));
  app.use('/archive', express.static(path.join(ROOT, 'archive')));
  app.use('/api', (req, res) => res.json({ api: true, url: req.originalUrl }));
  return app;
}

const STAMP = '1799999999999';

async function main() {
  const mod = require(MODULE_PATH);
  check('M0 模块导出 createHtmlAssetInjector 工厂', typeof mod.createHtmlAssetInjector === 'function');
  const serverSource = fs.readFileSync(SERVER_JS, 'utf8');
  const { normalized, block, start } = readStaticBlock(serverSource);
  check('S0 能切出 static 挂载语句', block !== null && block.includes('setHeaders'));
  if (block === null || typeof mod.createHtmlAssetInjector !== 'function') return;

  writeFixtures();
  const logs = [];
  const log = { error: (...a) => logs.push(a.join(' ')) };
  const app = buildApp(mod, block, true, { log, startupStamp: STAMP });
  const staticOnly = buildApp(mod, block, false);
  const server = await listenOnSafePort(app);
  const server2 = await listenOnSafePort(staticOnly);
  const port = server.address().port;
  const port2 = server2.address().port;
  const get = (p, h) => request(port, 'GET', p, h);

  try {
    const fp = () => ({
      app: fileFp('assets/app.js'), style: fileFp('assets/style.css'), other: fileFp('assets/other.js'),
      missing: STAMP, escape: STAMP, junction: STAMP,
      cn1: fileFp('assets/中文.js'), cn2: fileFp('assets/文件二.js'), lib: fileFp('sub/lib.js'),
    });

    // ══ 1. 替换正确 ══
    const rich = await get('/rich.html');
    check('1.1 rich.html 200', rich.status === 200, String(rich.status));
    check('1.2 rich.html 响应体与期望逐字相等（替换位置全对、注释 / CDN / style url() / 脚本字符串 / 正文 / <a> / ?v=autox 原样）', text(rich) === expOf(RICH_PARTS, fp()), text(rich).slice(0, 400));
    const richFps = [...text(rich).matchAll(/\?v=([0-9a-f]{12})(?![0-9a-f])/g)].map((m) => m[1]);
    check('1.3 十二位指纹等于文件字节 sha256 前 12 位（app.js）', richFps.includes(fileFp('assets/app.js')));
    check('1.4 缺失文件 / 出界引用 / 联接点引用换成启动时刻戳', (text(rich).match(new RegExp('\\?v=' + STAMP, 'g')) || []).length === 3, String((text(rich).match(new RegExp('\\?v=' + STAMP, 'g')) || []).length));
    check('1.5 缺失 / 出界 / 联接点引用各记一条错误日志，含页面与引用路径', logs.length === 3
      && logs.some((l) => l.includes('rich.html') && l.includes('assets/missing.js'))
      && logs.some((l) => l.includes('rich.html') && l.includes('../escape.js'))
      && logs.some((l) => l.includes('rich.html') && l.includes('link/ext.js')), JSON.stringify(logs));
    check('1.6 错误日志不含文件内容', logs.every((l) => !l.includes('JUNCTION-SECRET') && !l.includes('window.EXT')));
    await get('/rich.html');
    check('1.7 同一缺失引用重复请求不重复刷日志（状态转换才记）', logs.length === 3, String(logs.length));
    const bytes = await get('/bytes.html');
    const bytesSrc = fs.readFileSync(path.join(PUB, 'bytes.html')).toString('latin1');
    const bytesExp = bytesSrc.replace('assets/app.js?v=auto', 'assets/app.js?v=' + fileFp('assets/app.js')).replace('assets/style.css?v=auto', 'assets/style.css?v=' + fileFp('assets/style.css'));
    check('1.8 非 UTF-8 字节原样穿过（字节透明）', bytes.status === 200 && latin(bytes) === bytesExp);
    const stampDefault = Date.now();
    const appDefault = buildApp(mod, block, true, { log: { error() {} } });
    const serverDefault = await listenOnSafePort(appDefault);
    try {
      const r = await request(serverDefault.address().port, 'GET', '/rich.html');
      const m = text(r).match(/assets\/missing\.js\?v=(\d+)/);
      check('1.9 未传 startupStamp 时缺省为工厂创建时刻的十进制串', !!m && Number(m[1]) >= stampDefault - 5000 && Number(m[1]) <= Date.now(), m ? m[1] : 'no match');
    } finally {
      await new Promise((resolve) => serverDefault.close(resolve));
    }
    // 1.10 缺失 → 出现 → 再消失：日志按状态转换各记一次
    const lateFile = path.join(PUB, 'assets', 'late.js');
    const lateLogs = () => logs.filter((l) => l.includes('miss.html') && l.includes('assets/late.js')).length;
    const m1 = await get('/miss.html');
    check('1.10a 引用先缺失：换成启动戳，记 1 条', m1.status === 200 && text(m1).includes('assets/late.js?v=' + STAMP) && lateLogs() === 1, String(lateLogs()));
    fs.writeFileSync(lateFile, 'window.LATE = 1;\n');
    const m2 = await get('/miss.html');
    check('1.10b 文件出现后请求一次：用真实指纹，不再记日志', m2.status === 200 && text(m2).includes('assets/late.js?v=' + fileFp('assets/late.js')) && lateLogs() === 1, String(lateLogs()));
    fs.unlinkSync(lateFile);
    const m3 = await get('/miss.html');
    check('1.10c 再删掉后请求：回到启动戳，日志 +1', m3.status === 200 && text(m3).includes('assets/late.js?v=' + STAMP) && lateLogs() === 2, String(lateLogs()));

    // 1.11 标签名边界：自定义元素之后紧跟的真实 script / link 必须被替换，自定义元素与 <linkx> 自己的 src / href 原样
    const custom = await get('/custom.html');
    check('1.11 <style-panel> / <script-editor> 之后的真实 script / link 被替换；<linkx> 与自定义元素自己的 ?v=auto 原样', custom.status === 200 && text(custom) === expOf(CUSTOM_PARTS, fp()), text(custom).slice(0, 300));

    // 1.12 文本元素（47R1a M1）：正文逐字不变，之后真实的 script / link 照常注入
    const textel = await get('/textel.html');
    check('1.12a 文本元素页 200', textel.status === 200, String(textel.status));
    check('1.12b textarea / title / xmp / iframe / noembed / noframes 正文里的伪 script / link 逐字不变；其后真实的 script / link 全部注入（结束标签大小写混写、`</textarea\\n>`、`</title>` 不提前结束 textarea、属性值里的 `>`、<textareax> / <titlex> 不是文本元素）', text(textel) === expOf(TEXTEL_PARTS, fp()), text(textel).slice(0, 600));
    check('1.12c 伪标签的 ?v=auto 一个没被改（共 10 处字面 /demo.js?v=auto 与 1 处 /demo.css?v=auto 仍在）', (text(textel).match(/\/demo\.js\?v=auto/g) || []).length === 10 && (text(textel).match(/\/demo\.css\?v=auto/g) || []).length === 1, String((text(textel).match(/\/demo\.js\?v=auto/g) || []).length));
    const unclosed = await get('/unclosed.html');
    check('1.13 未闭合的 textarea（到文件尾）：其后的内容原样输出、不注入（字面 ?v=auto 保留），textarea 之前的真实 script 照常注入', unclosed.status === 200 && text(unclosed) === expOf(UNCLOSED_PARTS, fp()) && (text(unclosed).match(/\?v=auto/g) || []).length === 2, text(unclosed).slice(0, 300));
    const pe = mod.parsePage;
    check('1.14 parsePage 单元：textarea 中的伪标签不产生引用；title 同理；大小写混写结束标签后的真实标签产生 1 个引用',
      pe('<textarea><script src="/d.js?v=auto"></script></textarea>').refs.length === 0
      && pe('<title><script src="/d.js?v=auto"></script></title>').refs.length === 0
      && pe('<TiTlE><link href="/d.css?v=auto"></tItLe\t><script src="/a.js?v=auto"></script>').refs.length === 1
      && pe('<textarea><script src="/d.js?v=auto"></script>').refs.length === 0
      && pe('<textarea></textarea><script src="/a.js?v=auto"></script>').refs.length === 1
      && pe('<textarea/><script src="/a.js?v=auto"></script></textarea>').refs.length === 0
      && pe('<textareax><script src="/a.js?v=auto"></script>').refs.length === 1
      && pe('<textarea></textareax><script src="/a.js?v=auto"></script>').refs.length === 0, '');

    // 1.15 L1：目录 / 文件名以两个点开头但不是 `..`——页面可注入、引用拿到真实指纹（不再被当成出界）
    const dd = await get('/..pages/p.html');
    const ddFps = Object.assign({}, fp(), { dd1: fileFp('..assets/a.js'), dd2: fileFp('..pages/a2.js'), dd3: fileFp('..assets/c.css') });
    check('1.15a /..pages/p.html（目录名以 .. 开头）：200 且注入，三个引用（绝对 /..assets/a.js、同目录 a2.js、相对 ../..assets/c.css）都拿到真实文件指纹，不是启动戳', dd.status === 200 && text(dd) === expOf(DOTDOT_PARTS, ddFps) && !text(dd).includes(STAMP), text(dd).slice(0, 300));
    check('1.15b isInside 单元：`..pages`、`..assets/a.js` 这类以两个点开头的名字在根内；根自己、`..`、`..` + 分隔符开头、同前缀的兄弟目录、跨盘符绝对路径都不在', (() => {
      const r = path.join(ROOT, 'r');
      const sep = path.sep;
      const yes = [r + sep + '..pages', r + sep + '..pages' + sep + 'p.html', r + sep + '..' + sep + 'r' + sep + '..x' + sep + 'y', r + sep + '...' + sep + 'z'];
      const no = [r, path.join(r, '..'), path.join(r, '..', 'x'), path.join(r, '..', 'rx'), path.join(r, '..', 'r2', 'p.html'), path.resolve(r, '..', '..')];
      if (process.platform === 'win32') no.push('Z:\\elsewhere\\p.html', '\\\\server\\share\\p.html');
      const bad = yes.filter((x) => mod.isInside(r, x) !== true).map((x) => '应在内 ' + x).concat(no.filter((x) => mod.isInside(r, x) !== false).map((x) => '应在外 ' + x));
      return bad.length === 0 ? true : bad.join(' | ');
    })() === true);
    for (const o of ['/..%2Foutside.html', '/..%5Coutside.html', '/%2e%2e/outside.html', '/..pages/../../outside.html']) {
      const r = await get(o);
      check(`1.15c ${o}：真正的 .. 越界仍拿不到 public 之外的页面`, r.status !== 200 && !text(r).includes('OUTSIDE-SECRET'), `status=${r.status}`);
    }

    // ══ 4. 头与 HEAD ══
    const pGet = await get('/p.html');
    const pExpBody = expOf(P_PARTS, fp());
    check('4.1 p.html 200 且逐字等于期望（含 CRLF 与中文）', pGet.status === 200 && text(pGet) === pExpBody);
    check('4.2 Cache-Control: no-cache', pGet.headers['cache-control'] === 'no-cache', String(pGet.headers['cache-control']));
    check('4.3 不发 Last-Modified', pGet.headers['last-modified'] === undefined);
    check('4.4 ETag 是强 ETag 形态且等于响应体 sha256 前 32 位', STRONG_ETAG_RE.test(String(pGet.headers.etag)) && pGet.headers.etag === '"' + sha256(pGet.body).slice(0, 32) + '"', String(pGet.headers.etag));
    check('4.5 Content-Type text/html; charset=UTF-8', pGet.headers['content-type'] === 'text/html; charset=UTF-8', String(pGet.headers['content-type']));
    const pHead = await request(port, 'HEAD', '/p.html');
    const strip = (h) => { const o = Object.assign({}, h); delete o.date; delete o.connection; delete o['keep-alive']; return JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]])); };
    check('4.6 HEAD 头与 GET 相同（含 Content-Length）', pHead.status === 200 && strip(pHead.headers) === strip(pGet.headers), strip(pHead.headers) + ' vs ' + strip(pGet.headers));
    check('4.7 HEAD 无响应体、Content-Length 等于 GET 体长', pHead.body.length === 0 && Number(pHead.headers['content-length']) === pGet.body.length);
    const post = await request(port, 'POST', '/p.html');
    check('4.8 POST 不被处理（不吐页面）', !text(post).includes('中文正文') && !text(post).includes('?v=auto') && post.status !== 200, String(post.status));

    // ══ 5. 覆盖面向量 ══
    const pEtag = pGet.headers.etag;
    const aliases = ['/p.html', '/P.HTML', '/p.Html', '/p.html.', '/p.html%20', '/p.html::$DATA', '/p%2ehtml', '/./p.html', '//p.html',
      '/assets/../p.html', '/p.html/', '/p.html?x=1', '/p.html%5C', '/p.html%5C.', '/%2e/p.html', '/assets%5C..%5Cp.html', '/p.html%00',
      '/p.html#frag', '/p.html::$DATA?x=1', '/P.HTML::$DATA', '/p.html:x', '/%70.html', '/p.htm%6C'];
    const table = [];
    for (const a of aliases) {
      const r = await get(a);
      const body = text(r);
      const is4xx = r.status >= 400 && r.status <= 499;
      const injectedOk = r.status === 200 && !body.includes('?v=auto') && STRONG_ETAG_RE.test(String(r.headers.etag))
        && r.headers['cache-control'] === 'no-cache' && body === pExpBody && r.headers.etag === pEtag;
      table.push(`${a} -> ${r.status}${is4xx ? ' (4xx)' : injectedOk ? ' (injected)' : ' (??)'}`);
      check(`5.v ${a}：4xx，或 200 且为正确注入页（无 ?v=auto、强 ETag、no-cache）`, is4xx || injectedOk, `status=${r.status} etag=${r.headers.etag} cc=${r.headers['cache-control']} body=${body.slice(0, 80)}`);
    }
    // parseurl 改走 url.parse 的向量（URL 含 # / 空白 / NBSP / BOM 时）：static 吐的页面与本中间件必须是同一个
    const subExp = expOf(SUB_PARTS, fp());
    for (const [a, exp] of [['//x@y/p.html#a', pExpBody], ['/\\x@y/p.html#a', pExpBody], ['/p.html\u00a0', pExpBody], ['/sub\\#a', subExp], ['/p.html\u00a0?x=1', pExpBody], ['/p.html\t', pExpBody]]) {
      let r;
      try { r = await get(a); } catch (err) {
        // 只有 `/p.html\t`（尾部 tab，Node 客户端本身拒发）且错误码恰为 ERR_UNESCAPED_CHARACTERS 才算通过；其余一律判红并带上 code
        const okRefuse = a === '/p.html\t' && err && err.code === 'ERR_UNESCAPED_CHARACTERS';
        table.push(`${JSON.stringify(a)} -> 客户端拒发 code=${err && err.code} ${err && err.message}`);
        check(`5.u ${JSON.stringify(a)}：仅 /p.html\\t 被客户端以 ERR_UNESCAPED_CHARACTERS 拒发才算通过`, okRefuse, `code=${err && err.code} message=${err && err.message}`);
        continue;
      }
      const body = text(r);
      const is4xx = r.status >= 400 && r.status <= 499;
      const injectedOk = r.status === 200 && !body.includes('?v=auto') && STRONG_ETAG_RE.test(String(r.headers.etag)) && r.headers['cache-control'] === 'no-cache' && body === exp;
      table.push(`${JSON.stringify(a)} -> ${r.status}${is4xx ? ' (4xx)' : injectedOk ? ' (injected)' : ' (??)'}`);
      check(`5.u ${JSON.stringify(a)}：4xx，或 200 且与注入页逐字相等`, is4xx || injectedOk, `status=${r.status} body=${body.slice(0, 80)}`);
    }
    for (const a of ['/legacy.htm', '/LEGACY.HTM', '/Big.HTML', '/big.html', '/BIG.HTML']) {
      const r = await get(a);
      const parts = a.toLowerCase().includes('legacy') ? LEGACY_PARTS : BIG_PARTS;
      const ok = r.status === 200 && text(r) === expOf(parts, fp()) && r.headers['cache-control'] === 'no-cache';
      table.push(`${a} -> ${r.status}${ok ? ' (injected)' : ' (??)'}`);
      check(`5.h ${a}：.htm / .HTML 也被注入且 no-cache`, ok, `status=${r.status} body=${text(r).slice(0, 80)}`);
    }
    const sub = await get('/sub/');
    check('5.d1 /sub/（有 index.html）= 注入后的默认页，引用按页面所在目录解析', sub.status === 200 && text(sub) === expOf(SUB_PARTS, fp()), text(sub).slice(0, 200));
    const subIdx = await get('/sub/index.html');
    check('5.d2 /sub/index.html 与 /sub/ 同体同 ETag', subIdx.status === 200 && text(subIdx) === text(sub) && subIdx.headers.etag === sub.headers.etag);
    const sub2 = await get('/sub2/');
    check('5.d3 /sub2/（无 index.html）交给 static：404', sub2.status === 404, String(sub2.status));
    const subNoSlash = await get('/sub');
    check('5.d4 /sub（目录无斜杠）交给 static：301 且不含页面字节', subNoSlash.status === 301 && !text(subNoSlash).includes('?v='), String(subNoSlash.status));
    const root = await get('/');
    check('5.d5 /（public 根无 index.html）404', root.status === 404, String(root.status));
    const hidden = await get('/.hidden.html');
    check('5.d6 点开头文件名与 static 同口径：404，不吐页面', hidden.status === 404 && !text(hidden).includes('?v='), String(hidden.status));
    for (const o of ['/%2e%2e/outside.html', '/..%2Foutside.html', '/..%5Coutside.html', '/%2e%2e%5coutside.html', '/assets/../../outside.html', '/../outside.html', '/%2e%2e/%2e%2e/outside.html']) {
      const r = await get(o);
      table.push(`${o} -> ${r.status}`);
      check(`5.o ${o}：拿不到 public 之外的页面内容`, r.status !== 200 && !text(r).includes('OUTSIDE-SECRET'), `status=${r.status}`);
    }
    for (const j of ['/link/outside2.html', '/LINK/OUTSIDE2.HTML', '/link/outside2.html::$DATA']) {
      const r = await get(j);
      table.push(`${j} -> ${r.status}`);
      check(`5.j ${j}：联接点指向 public 之外的 HTML：4xx 且不吐内容`, r.status >= 400 && r.status <= 499 && !text(r).includes('JUNCTION-SECRET'), `status=${r.status}`);
    }
    if (VERBOSE) for (const line of table) say(line);

    // ══ 6. 不干扰 ══
    const api = await get('/api/x');
    check('6.1 /api/x 不被处理，交给后面的 /api', api.status === 200 && JSON.parse(text(api)).api === true);
    // 6.2：public/api/p.html 真实存在；/api 处理器挂在注入中间件之后、static 之前，这样“是否让路”只取决于注入中间件自己
    const appApi = express();
    appApi.set('env', 'test');
    appApi.use(mod.createHtmlAssetInjector({ publicDir: PUB, log, startupStamp: STAMP }));
    appApi.use('/api', (req, res) => res.json({ api: true, url: req.originalUrl }));
    const serverApi = await listenOnSafePort(appApi);
    try {
      const apiHtml = await request(serverApi.address().port, 'GET', '/api/p.html');
      check('6.2 /api/ 前缀不被当页面处理：即使 public/api/p.html 真实存在，也交给后面的 /api 处理器', apiHtml.status === 200 && text(apiHtml).startsWith('{') && JSON.parse(text(apiHtml)).api === true, text(apiHtml).slice(0, 80));
      for (const p of ['/API/p.html', '/Api/p.html', '/aPi/p.html', '/aPi', '/API']) {
        const r = await request(serverApi.address().port, 'GET', p);
        check(`6.2b ${p}：大小写变体也让路给 /api 处理器（express 路由不分大小写）`, r.status === 200 && text(r).startsWith('{') && JSON.parse(text(r)).api === true, `status=${r.status} body=${text(r).slice(0, 60)}`);
      }
    } finally {
      await new Promise((resolve) => serverApi.close(resolve));
    }
    const js = await get('/assets/app.js');
    check('6.3 JS 请求不被处理，字节原样，无 ?v 时保持 7 天缓存头', js.status === 200 && js.body.equals(fs.readFileSync(path.join(PUB, 'assets', 'app.js'))) && /max-age=604800/.test(String(js.headers['cache-control'])), String(js.headers['cache-control']));
    const jsV = await get('/assets/app.js?v=abc123');
    check('6.4 ?v=其他值的资源保持 7 天缓存头', /max-age=604800/.test(String(jsV.headers['cache-control'])), String(jsV.headers['cache-control']));
    const jsAuto = await get('/assets/app.js?v=auto');
    check('6.5 带 ?v=auto 的 JS 请求得 no-cache', jsAuto.headers['cache-control'] === 'no-cache', String(jsAuto.headers['cache-control']));
    const cssAuto = await get('/assets/style.css?v=auto');
    check('6.6 带 ?v=auto 的 CSS 请求得 no-cache', cssAuto.headers['cache-control'] === 'no-cache', String(cssAuto.headers['cache-control']));
    const jsAutoTwice = await get('/assets/app.js?v=auto&v=zzz');
    check('6.7 重复 v 参数含 auto 也得 no-cache', jsAutoTwice.headers['cache-control'] === 'no-cache', String(jsAutoTwice.headers['cache-control']));
    // 6.15 setHeaders 解析原始查询串（不读 req.query）：精确的键 v 且值 auto 才 no-cache
    for (const [q, noCache] of [['?v[x]=1&v=auto', true], ['?v=auto&v[x]=1', true], ['?v%3Dauto', false], ['?vv=auto', false], ['?v=auto#x', true], ['?v=AUTO', false],
      ['?x=1&v=auto', true], ['?v=au%74o', true], ['?%76=auto', true], ['?v=auto%', false], ['?v=', false], ['?v', false], ['?a[v]=auto', false]]) {
      const r = await get('/assets/app.js' + q);
      const cc = String(r.headers['cache-control']);
      check(`6.15 /assets/app.js${q}：${noCache ? 'no-cache' : '保持 7 天缓存'}`, r.status === 200 && (noCache ? cc === 'no-cache' : /max-age=604800/.test(cc)), `status=${r.status} cc=${cc}`);
    }
    // static 单独（不经注入中间件）：第 C.1 / C.2 条
    const sBig = await request(port2, 'GET', '/Big.HTML');
    const sBig2 = await request(port2, 'GET', '/BIG.html');
    const sLegacy = await request(port2, 'GET', '/legacy.htm');
    const sP = await request(port2, 'GET', '/p.html');
    check('6.8 static 单独：.HTML 大写扩展名文件名命中时 no-cache（C.1）', sBig.status === 200 && sBig.headers['cache-control'] === 'no-cache' && sBig2.status === 200 && sBig2.headers['cache-control'] === 'no-cache', `${sBig.status} ${sBig.headers['cache-control']} / ${sBig2.status} ${sBig2.headers['cache-control']}`);
    check('6.9 static 单独：.htm 也 no-cache（C.1）', sLegacy.status === 200 && sLegacy.headers['cache-control'] === 'no-cache', String(sLegacy.headers['cache-control']));
    check('6.10 static 单独：.html no-cache 保持', sP.status === 200 && sP.headers['cache-control'] === 'no-cache');
    check('6.11 static 单独对照：未经注入的页面确实带着 ?v=auto（证明注入中间件才是替换的来源）', text(sP).includes('?v=auto'));
    const sAuto = await request(port2, 'GET', '/assets/app.js?v=auto');
    check('6.12 static 单独：?v=auto 资源 no-cache（C.2）', sAuto.headers['cache-control'] === 'no-cache');

    // 6.13 /uploads 与 /archive：各自的 express.static，原字节、保持 static 默认头（弱 ETag + Last-Modified + 非 no-cache），不被注入
    for (const [u, rel, base] of [['/uploads/a.html', 'a.html', 'uploads'], ['/uploads/x.txt', 'x.txt', 'uploads'], ['/archive/b.html', 'b.html', 'archive']]) {
      const r = await get(u);
      const file = fs.readFileSync(path.join(ROOT, base, rel));
      check(`6.13 ${u}：200、原字节（含 ?v=auto 原样）`, r.status === 200 && r.body.equals(file) && file.includes('?v=auto'), `status=${r.status}`);
      check(`6.13 ${u}：保持 express.static 默认头（弱 ETag、有 Last-Modified、Cache-Control 不是 no-cache）`, /^W\/"/.test(String(r.headers.etag)) && !!r.headers['last-modified'] && r.headers['cache-control'] !== 'no-cache', `etag=${r.headers.etag} lm=${r.headers['last-modified']} cc=${r.headers['cache-control']}`);
    }
    // 6.14 不含 ?v=auto 的页面：响应体与文件字节全等（S6a→S6b 之间生产 22 页都走这条路径）
    const plainFile = fs.readFileSync(path.join(PUB, 'plain.html'));
    const plain = await get('/plain.html');
    check('6.14a 无占位页面：200、响应体与文件字节全等（含 CRLF、中文、不该动的 ?v=1.2.3_old）', plain.status === 200 && plain.body.equals(plainFile), `status=${plain.status}`);
    check('6.14b 无占位页面：no-cache、强 ETag、无 Last-Modified', plain.headers['cache-control'] === 'no-cache' && STRONG_ETAG_RE.test(String(plain.headers.etag)) && plain.headers.etag === '"' + sha256(plainFile).slice(0, 32) + '"' && plain.headers['last-modified'] === undefined, String(plain.headers.etag));

    // ══ 9. R 组：rawPathname 与 parseurl 对拍 ══
    check('9.0 模块导出 rawPathname', typeof mod.rawPathname === 'function');
    const parseurl = require('parseurl');
    const fromServeStatic = require.resolve('parseurl', { paths: [path.dirname(require.resolve('serve-static'))] });
    check('9.1 本脚本 require 的 parseurl 与 serve-static 解析到的是同一个文件（防依赖分叉）', require.resolve('parseurl') === fromServeStatic, require.resolve('parseurl') + ' vs ' + fromServeStatic);
    const R_URLS = ['/p.html\t', '/p.html','/p.html?x=1', '/p.html?x=1?y=2', '/p.html#a', '/p.html?x=1#a', '/a\\b/p.html', '/a\\b?x#', '//p.html', '//x@y/p.html#a', '/\\x@y/p.html#a',
      '/p.html\u00a0', '/p.html\ufeff', '/sub\\#a', '/p.html\u00a0?x=1', ' /p.html', ' /p.html ', '/p.html ', '\t/p.html', '/p.html\n', '/p.html\r', '/p.html\f', '\u00a0/p.html', '\ufeff/p.html',
      '/p.html?q=a b', '/p.html?q=a\tb', '/p.html?a#b?c', 'http://h/p.html', 'http://h/p.html?x#y', 'http://h', 'https://u:p@h:8080/a/b.html?q', 'p.html', '', '*', '/', '/?', '/#', '?x', '//', '///p.html',
      '/p%20.html', '/p.html?', '/%E4%B8%AD.html', '/p.html%5C', '/..%5Cp.html', '/api/x?y', '/api\\x'];
    const outcome = (fn, u) => { try { return JSON.stringify(fn(u)); } catch (e) { return 'THROW ' + e.code; } };
    const R_ROWS = [];
    for (const u of R_URLS) {
      const mine = outcome(mod.rawPathname, u);
      const theirs = outcome((x) => parseurl({ url: x }).pathname, u);
      R_ROWS.push(`${JSON.stringify(u)} => mine=${mine} parseurl=${theirs}`);
      check(`9.r ${JSON.stringify(u)}：rawPathname === parseurl().pathname`, mine === theirs, `mine=${mine} parseurl=${theirs}`);
    }
    for (const row of R_ROWS) say('R ' + row);

    // ══ 7. 读文件失败 ══
    const realOpen = fs.openSync;
    fs.openSync = function patchedOpen(p, ...rest) {
      if (typeof p === 'string' && p.endsWith('locked.html')) { const e = new Error('EACCES: permission denied, open'); e.code = 'EACCES'; throw e; }
      return realOpen.call(fs, p, ...rest);
    };
    let locked;
    try { locked = await get('/locked.html'); } finally { fs.openSync = realOpen; }
    check('7.1 读页面失败 → 交给错误处理（500），不吐半截内容', locked.status === 500 && !text(locked).includes('LOCKED-CONTENT') && !text(locked).includes('<script'), String(locked.status));
    const lockedAfter = await get('/locked.html');
    check('7.2 失败不留脏缓存：恢复后同一页正常注入', lockedAfter.status === 200 && text(lockedAfter).includes('LOCKED-CONTENT') && !text(lockedAfter).includes('?v=auto'));

    // ══ 3 + 2. 条件请求与变化 ══
    const rich0 = await get('/rich.html');
    const p0 = await get('/p.html');
    const e0 = p0.headers.etag;
    const cond = async (value) => get('/p.html', { 'If-None-Match': value });
    const c1 = await cond(e0);
    check('3.1 同 ETag → 304，带 ETag 与 Cache-Control，无响应体', c1.status === 304 && c1.headers.etag === e0 && c1.headers['cache-control'] === 'no-cache' && c1.body.length === 0);
    check('3.2 W/ 前缀 → 304（弱比较）', (await cond('W/' + e0)).status === 304);
    check('3.3 多值列表含命中 → 304', (await cond('"nope", W/"also-no", ' + e0)).status === 304);
    check('3.4 * → 304', (await cond('*')).status === 304);
    check('3.5 不命中 → 200 带体', (await cond('"0123456789abcdef0123456789abcdef"')).status === 200);
    const ims = await get('/p.html', { 'If-Modified-Since': new Date(Date.now() + 86400000).toUTCString() });
    check('3.6 忽略 If-Modified-Since → 200', ims.status === 200 && ims.body.length > 0);
    const imsInm = await get('/p.html', { 'If-None-Match': '"nope"', 'If-Modified-Since': new Date(Date.now() + 86400000).toUTCString() });
    check('3.7 INM 不命中且 IMS 在未来 → 仍是 200', imsInm.status === 200);
    // 47R1a M2：If-Match 先于 If-None-Match（按最终响应体的 ETag；口径对齐 send@0.19 的 isPreconditionFailure）
    const im = async (value, extra, method) => request(port, method || 'GET', '/p.html', Object.assign({ 'If-Match': value }, extra || {}));
    const im1 = await im('"0123456789abcdef0123456789abcdef"');
    check('3.8 If-Match 不匹配 → 412，无页面内容，不带 ETag，no-cache', im1.status === 412 && !text(im1).includes('中文正文') && !text(im1).includes('<script') && im1.headers.etag === undefined && im1.headers['cache-control'] === 'no-cache', `status=${im1.status} etag=${im1.headers.etag}`);
    const im2 = await im(e0);
    check('3.9 If-Match 匹配 → 200 带体，ETag 不变', im2.status === 200 && im2.headers.etag === e0 && text(im2) === pExpBody);
    const im3 = await im('"0123456789abcdef0123456789abcdef"', { 'If-None-Match': e0 });
    check('3.10 If-Match 不匹配 + If-None-Match 匹配 → 412（不是 304）', im3.status === 412 && im3.body.length === 'Precondition Failed'.length, `status=${im3.status}`);
    const im4 = await im('*');
    check('3.11 If-Match: * → 200', im4.status === 200 && text(im4) === pExpBody);
    const im5 = await im(e0, { 'If-None-Match': e0 });
    check('3.12 If-Match 匹配 + If-None-Match 匹配 → 304（先过 If-Match，再判 If-None-Match）', im5.status === 304 && im5.body.length === 0 && im5.headers.etag === e0);
    const im6 = await im('W/' + e0);
    const im7 = await im('"nope", ' + e0 + ' ,"also-no"');
    check('3.13 If-Match 的 W/ 前缀与多值列表按 send 口径：W/ 强弱互认、列表里任一命中 → 200', im6.status === 200 && im7.status === 200, `${im6.status} ${im7.status}`);
    const im8 = await im('"nope", "also-no"', {}, 'HEAD');
    check('3.14 HEAD 的 If-Match 不匹配 → 412 且无体', im8.status === 412 && im8.body.length === 0);
    const im9 = await im('');
    check('3.15 If-Match 空串 → 不检查（200）；全空白值的 412 口径由 3.16c 差分对拍覆盖（Node 服务端会裁掉头部值首尾空白，HTTP 上发不出来）', im9.status === 200, String(im9.status));
    // 差分对拍：isPreconditionFailure 与 send@0.19 自己的 isPreconditionFailure（同一个 If-Match 值、同一个 ETag）逐值一致，且 send 就是 serve-static 用的那一份
    const sendMod = require('send');
    check('3.16a 本脚本 require 的 send 与 serve-static 解析到的是同一个文件（防依赖分叉）', require.resolve('send') === require.resolve('send', { paths: [path.dirname(require.resolve('serve-static'))] }));
    const sendProto = Object.getPrototypeOf(sendMod({ headers: {} }, '/x'));
    const sendPrecond = (header, etag) => sendProto.isPreconditionFailure.call({ req: { headers: header === undefined ? {} : { 'if-match': header } }, res: { getHeader: () => etag } });
    check('3.16b 模块导出 isPreconditionFailure', typeof mod.isPreconditionFailure === 'function');
    if (typeof mod.isPreconditionFailure === 'function') {
      const E = '"0123456789abcdef0123456789abcdef"';
      const headers = [undefined, '', ' ', '  ', '*', ' * ', '*,"x"', '"x",*', E, 'W/' + E, E + ',"x"', '"x",' + E, '"x" , ' + E + ' ', ',,' + E, E + ',', ',', 'W/"x"', '"x"', 'x', E.slice(1, -1), E.toLowerCase(), 'w/' + E, E + E, '"x","y"', 'W/' + E + ', W/"y"', '"y", W/' + E];
      const diffs = [];
      for (const h of headers) {
        for (const etag of [E, undefined]) {
          const mine = mod.isPreconditionFailure(h, etag);
          const theirs = sendPrecond(h, etag);
          if (mine !== theirs) diffs.push(`${JSON.stringify(h)} etag=${etag ? 'strong' : 'none'} mine=${mine} send=${theirs}`);
        }
      }
      check(`3.16c isPreconditionFailure 与 send@0.19 逐值一致（${headers.length} 个 If-Match 值 × 有 / 无 ETag）`, diffs.length === 0, diffs.slice(0, 3).join(' || '));
    }

    // 改 other.js（只被 rich.html 引用）：大小不变、mtime 变
    const otherFile = path.join(PUB, 'assets', 'other.js');
    const base = Date.now() - 600000;
    const setMtime = (f, offset) => { const t = new Date(base + offset); fs.utimesSync(f, t, t); };
    setMtime(otherFile, 1000);
    const rich1 = await get('/rich.html');
    const fps1 = fp();
    fs.writeFileSync(otherFile, 'window.OTHER = "other-2";\n'); // 同长度
    setMtime(otherFile, 20000);
    const rich2 = await get('/rich.html');
    const fps2 = fp();
    check('2.1 同大小改内容（mtime 变）→ 只有 other 的指纹变', text(rich1) === expOf(RICH_PARTS, fps1) && text(rich2) === expOf(RICH_PARTS, fps2) && fps1.other !== fps2.other && fps1.app === fps2.app && fps1.style === fps2.style);
    check('2.2 引用该资源的页面 ETag 变', rich1.headers.etag !== rich2.headers.etag);
    const p1 = await get('/p.html');
    check('2.3 未引用该资源的页面 ETag 不变（p.html）', p1.headers.etag === e0 && text(p1) === text(p0));
    const old = await get('/rich.html', { 'If-None-Match': rich2.headers.etag });
    check('2.4 未变化时带当前 ETag → 304', old.status === 304);
    fs.writeFileSync(otherFile, 'window.OTHER = "other-3-longer-content";\n'); // 大小变
    setMtime(otherFile, 20000); // mtime 回到上一次的值，只有大小在变
    const rich3 = await get('/rich.html', { 'If-None-Match': rich2.headers.etag });
    const fps3 = fp();
    check('2.5 资源变化后带旧 ETag → 200 且新指纹、新 ETag（大小变、mtime 同）', rich3.status === 200 && text(rich3) === expOf(RICH_PARTS, fps3) && rich3.headers.etag !== rich2.headers.etag && fps3.other !== fps2.other);
    // 共享资源 app.js 变 → 两个页面都变
    fs.writeFileSync(path.join(PUB, 'assets', 'app.js'), 'window.APP = "app-2";\n');
    setMtime(path.join(PUB, 'assets', 'app.js'), 30000);
    const p2 = await get('/p.html', { 'If-None-Match': e0 });
    check('2.6 共享资源变化：引用它的页面带旧 ETag → 200，指纹与 ETag 更新', p2.status === 200 && p2.headers.etag !== e0 && text(p2) === expOf(P_PARTS, fp()));
    // 页面自身同大小改内容（mtime 变）
    const pFile = path.join(PUB, 'p.html');
    const before = fs.readFileSync(pFile, 'utf8');
    setMtime(pFile, 40000);
    await get('/p.html');
    fs.writeFileSync(pFile, before.replace('中文正文', '汉语正文'));
    setMtime(pFile, 50000);
    const p3 = await get('/p.html');
    check('2.7 页面源文件同大小改内容（mtime 变）→ 下次请求即更新', p3.status === 200 && text(p3).includes('汉语正文') && p3.headers.etag !== p2.headers.etag);
    check('2.8 页面改动前后字节数相同（用例本身成立）', Buffer.byteLength(before, 'utf8') === fs.statSync(pFile).size);

    // 2.9 页面缓存只变大小（mtime 用 utimes 还原成同一个值）：带旧 ETag → 200、新正文、新 ETag
    const sizedFile = path.join(PUB, 'sized.html');
    setMtime(sizedFile, 60000);
    const sz1 = await get('/sized.html');
    fs.writeFileSync(sizedFile, '<script src="assets/app.js?v=auto"></script>\nSIZED-TWO-LONGER-BODY\n');
    setMtime(sizedFile, 60000);
    const sz2 = await get('/sized.html', { 'If-None-Match': sz1.headers.etag });
    check('2.9 页面只变大小、mtime 不变：带旧 ETag → 200、新正文、新 ETag', sz1.status === 200 && text(sz1).includes('SIZED-ONE') && sz2.status === 200 && text(sz2).includes('SIZED-TWO-LONGER-BODY') && !text(sz2).includes('SIZED-ONE') && sz2.headers.etag !== sz1.headers.etag, `status=${sz2.status} body=${text(sz2).slice(0, 80)}`);

    // ══ 8. server.js 挂载顺序静态核对 ══
    const mountRe = /app\.use\(\s*createHtmlAssetInjector\(/g;
    const mounts = [...normalized.matchAll(mountRe)];
    const staticAt = normalized.indexOf(start);
    check('8.1 注入中间件在 server.js 里只挂一次', mounts.length === 1, String(mounts.length));
    check('8.2 注入中间件的 app.use 在 public 静态挂载之前', mounts.length === 1 && mounts[0].index < staticAt);
    check('8.3 server.js 引入的是 utils/html-asset-fingerprint', /require\('\.\/utils\/html-asset-fingerprint'\)/.test(normalized));
    check('8.4 挂载处 publicDir 与 static 同一个 public 目录', /createHtmlAssetInjector\(\{ publicDir: path\.join\(__dirname, 'public'\)/.test(normalized));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => server2.close(resolve));
  }
}

main().then(() => {}, (err) => {
  fail++;
  failures.push('FAIL 自检异常 | ' + (err && err.stack ? err.stack : err));
}).then(() => {
  try { removeTree(ROOT); } catch (err) { fail++; failures.push('FAIL 清理临时根异常 | ' + err.message); }
  let left = false;
  try { fs.lstatSync(ROOT); left = true; } catch (_) { /* gone */ }
  if (left) { fail++; failures.push('FAIL 临时根未清理干净 | ' + ROOT); }
  for (const f of failures) console.log(f);
  console.log(`verify-html-asset-fingerprint PASS=${pass} FAIL=${fail}`);
  process.exitCode = fail === 0 ? 0 : 1;
});
