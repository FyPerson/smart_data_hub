'use strict';
// utils/html-asset-fingerprint.js — HTML 缓存串自动注入中间件（#106 W4 / S6a）
//
// 作用：把页面里 <script src="X?v=auto"> / <link href="X?v=auto"> 的 `?v=auto` 替换成 X 的内容指纹 `?v=<sha256 前 12 位>`，
//   并按最终响应体算强 ETag、处理 If-Match（先判，不满足 412）与 If-None-Match（命中 304）。以后改共享 JS/CSS 不再手改页面里的缓存串。
// 挂载位置：必须在 express.static(public) 之前。凡 express.static 会以某个 HTML 文件的字节作答的请求，要么由本中间件
//   注入后作答，要么被拒绝（404）；本中间件放行（next）的请求，static 不会吐出 HTML 原文。
//
// 路径口径与 parseurl@1.3.3 fastparse + send@0.19（express.static 的底层）逐步一致：
//   取未解码 pathname（rawPathname：以 `/` 开头且不含 \t \n \f \r 空格 # \u00a0 \ufeff 才按第一个 `?` 切，否则走 url.parse，
//   对拍用例见自检 scripts/verify-html-asset-fingerprint.js 的 R 组）→ decodeURIComponent（失败 / 含 NUL 放行给 static 回 400）→
//   normalize('.' + sep + path) → 含 `..` 放行给 static（403）→ join(root) → 末位点开头的文件名放行给 static（404）→ 原始路径以 `/` 结尾走 index.html。
//   这样 Windows 上 static 能命中的别名（大小写、`::$DATA`、`%5C` 结尾、`/./`、`//`、`/a/../p.html`、`#` / 空白 / NBSP 触发的 url.parse 路径…）
//   与本中间件算出的是同一个落盘文件，再取 fs.realpathSync.native 得到磁盘上的真实文件名（大小写、8.3 短名、流后缀都被还原）判是否 HTML，
//   而不是信请求里的拼写。
// HTML 判定 = 真实文件名或请求名任一为 .html / .htm（不分大小写；比“只看请求名”宽。static 本就按请求名给 text/html，这样判没有新增泄漏面）。
// 引用解析：相对引用按页面**真实路径**所在目录解析。经目录联接点 / 符号链接且层级不同时，会与浏览器按请求 URL 解析的结果不一致；
//   public 目前没有联接点（自检里的联接点只用来验证“指向 public 之外的 HTML 一律 404”）。
// 不支持 <base href>：引用按页面所在目录解析；public 页面禁用 <base>，由 S6b 静态守卫硬门保证。
//
// 依赖：只用 node 内置模块。不读请求体、不写库、不访问网络。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const nodeUrl = require('node:url');

const FINGERPRINT_LENGTH = 12;
const UP_PATH_RE = /(?:^|[\\/])\.\.(?:[\\/]|$)/;
const API_PREFIX_RE = /^\/api(?:\/|$)/i;
// 站内引用：排除任何 scheme（http: https: data: javascript: …）与协议相对（//host/…）。
const NON_LOCAL_RE = /^(?:[a-z][a-z0-9+.\-]*:|\/\/)/i;
// 属性值里的占位：`X?v=auto`，其后只能是串尾、`&` 或 `#`。
const VALUE_RE = /^([^?#]*)\?v=auto(?=$|[&#])/;
// HTML 文件名（真实文件名）。冒号之后是 NTFS 流后缀（`p.html::$DATA`），Windows 文件名不含冒号，所以按“扩展名后紧跟冒号”也算。
const HTML_NAME_RE = /\.html?(?::.*)?$/i;
// 页面扫描：HTML 注释 | <style>…</style> | <script …>…</script> | <link …> | 文本元素（RCDATA：textarea / title；RAWTEXT：xmp / iframe / noembed / noframes）整段。属性引号内可含 `>`。
// 文本元素的正文是纯文本，里面的 `<script src="…?v=auto">` 不是标签：整段跳过（结束标签按 HTML 规范：`</名字` 后紧跟空白 / `/` / `>`，名字不分大小写）。
//   没有结束标签（到文件尾）时一路吞到串尾，其后的内容原样输出、不注入（保守：浏览器也把它们当文本）。捕获组 3 = 文本元素名，用反向引用匹配同名结束标签。
//   局限：正则扫描器只做词法匹配，分不清当前位置在标签外、属性值里、noscript 里还是 SVG 外来内容里——不识别属性值（`placeholder="<title>"`）、noscript、SVG（`<svg><title/></svg>`）里出现的
//   文本元素名，会把其后的真实 script 当文本吞掉（漏注入、留下字面 ?v=auto）；反方向是 textarea 正文里的演示 `<script src="…?v=auto">` 按文本原样输出，而浏览器 / 守卫的规范扫描不这么看。
//   这类分歧不在本文件里逐类补，由缓存串守卫 scripts/verify-shared-css-cache-bust.js 的 S7 逐页要求两个扫描器的 `?v=auto` 引用列表全等来拦截。
const TOKEN_RE = /<!--[\s\S]*?(?:-->|$)|<style(?=[\t\n\f\r />])(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?(?:<\/style\s*>|$)|<(script|link)(?=[\t\n\f\r />])((?:[^>"']|"[^"]*"|'[^']*')*)>|<(textarea|title|xmp|iframe|noembed|noframes)(?=[\t\n\f\r />])(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?(?:<\/\3(?=[\t\n\f\r />])|$)/gi;
const SCRIPT_CLOSE_RE = /<\/script\s*>/gi;
const ATTR_RE = /([^\s"'<>\/=]+)(?:(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+)))?/g;

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (_) { return null; }
}

// real 在 realRoot 之内（不含 realRoot 自己）。出界只有三种形态：相对路径恰为 `..`、以 `..` + 分隔符开头（Windows 上 `/` 与 `\` 都认）、绝对路径（跨盘符）。
// `..pages`、`..assets/a.js` 这类以两个点开头的合法目录 / 文件名不是出界（不能用 startsWith('..') 判）。
function isInside(realRoot, real) {
  const rel = path.relative(realRoot, real);
  if (rel === '' || rel === '..' || path.isAbsolute(rel)) return false;
  if (rel.startsWith('..' + path.sep) || rel.startsWith('../')) return false;
  return true;
}

/**
 * 请求的未解码 pathname，按 parseurl@1.3.3 的 fastparse 规则重写（express.static 取路径用的就是它）：
 *   仅当 url 以 `/` 开头、且全串不含 \t \n \f \r 空格 # \u00a0 \ufeff 任何一个时，按第一个 `?` 切；
 *   否则交给 url.parse（去首尾空白、`?#` 前的反斜杠换成 `/`、`//user@host/…` 识别成主机、绝对 URL 形式取其 pathname）。
 * 不 require parseurl（它是 express 的传递依赖，不在 package.json），自检里有对拍用例和“同一个文件”断言防口径分叉。
 */
function rawPathname(url) {
  if (typeof url !== 'string') return null;
  if (url.charCodeAt(0) === 0x2f) {
    let cut = -1;
    let plain = true;
    for (let i = 1; i < url.length; i++) {
      const c = url.charCodeAt(i);
      if (c === 0x3f) {
        if (cut < 0) cut = i;
      } else if (c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20 || c === 0x23 || c === 0xa0 || c === 0xfeff) {
        plain = false;
        break;
      }
    }
    if (plain) return cut < 0 ? url : url.slice(0, cut);
  }
  try { return nodeUrl.parse(url).pathname; } catch (_) { return null; }
}

/** 一次读取内容与 stat（fstat 与读取同一个句柄，缓存键与内容一致） */
function readWithStat(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const st = fs.fstatSync(fd);
    const buf = fs.readFileSync(fd);
    return { buf, mtimeMs: st.mtimeMs, size: st.size };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 扫描页面（latin1 字节透明字符串），返回 { chunks, refs }：chunks.length === refs.length + 1，
 * 拼回时 chunks[0] + repl(refs[0]) + chunks[1] + …，repl = `?v=<指纹>`。chunks[i] 在 X 末尾截止（X 保留），下一块从 `?v=auto` 之后开始。
 * refs[i] = { x }：X 的 utf-8 解码串（未做 percent 解码）。注释 / <style> / <script> 正文、文本元素（textarea、title 等）正文里的内容不扫描。
 */
function parsePage(text) {
  const chunks = [];
  const refs = [];
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    if (m[1] === undefined) continue; // 注释 / style / 文本元素（textarea、title 等）正文：整段跳过
    const tag = m[1].toLowerCase();
    const attrsStart = m.index + 1 + m[1].length; // `<` + 标签名之后
    const attrs = m[2];
    const wanted = tag === 'script' ? 'src' : 'href';
    ATTR_RE.lastIndex = 0;
    let a;
    while ((a = ATTR_RE.exec(attrs)) !== null) {
      if (a[1].toLowerCase() !== wanted || a[2] === undefined) continue;
      const value = a[3] !== undefined ? a[3] : (a[4] !== undefined ? a[4] : a[5]);
      if (value === undefined) continue;
      const hit = VALUE_RE.exec(value);
      if (!hit) continue;
      const x = hit[1];
      if (NON_LOCAL_RE.test(x)) continue;
      // 值在 attrs 内的偏移 = 属性匹配起点 + 名称 + 等号段 + 引号（若有）
      const quote = (a[3] !== undefined || a[4] !== undefined) ? 1 : 0;
      const valueOffset = a.index + a[1].length + a[2].length + quote;
      const xEnd = attrsStart + valueOffset + x.length;
      chunks.push(text.slice(last, xEnd));
      refs.push({ x: Buffer.from(x, 'latin1').toString('utf8') });
      last = xEnd + '?v=auto'.length;
    }
    if (tag === 'script') {
      // 跳过脚本正文，避免正文里的 `<script src="…?v=auto">` 字符串被当成标签
      SCRIPT_CLOSE_RE.lastIndex = TOKEN_RE.lastIndex;
      const close = SCRIPT_CLOSE_RE.exec(text);
      TOKEN_RE.lastIndex = close ? close.index : text.length;
    }
  }
  chunks.push(text.slice(last));
  return { chunks, refs };
}

function etagMatches(header, etag) {
  if (typeof header !== 'string' || header === '') return false;
  const tokens = header.match(/(?:W\/)?"[^"]*"|\*/g);
  if (!tokens) return false;
  for (const t of tokens) {
    if (t === '*') return true;
    if (t.replace(/^W\//, '') === etag) return true;
  }
  return false;
}

// send@0.19 的 parseTokenList（逗号分隔，忽略空 token 与首尾空格）。If-Match 的解析口径与它逐字一致。
function parseTokenList(str) {
  let end = 0;
  let start = 0;
  const list = [];
  for (let i = 0; i < str.length; i++) {
    switch (str.charCodeAt(i)) {
      case 0x20:
        if (start === end) { start = end = i + 1; }
        break;
      case 0x2c:
        if (start !== end) { list.push(str.substring(start, end)); }
        start = end = i + 1;
        break;
      default:
        end = i + 1;
        break;
    }
  }
  if (start !== end) { list.push(str.substring(start, end)); }
  return list;
}

/**
 * If-Match 是否失败（对齐 send@0.19 的 isPreconditionFailure 里 if-match 一段，口径照抄）：
 *   header 为空 / 缺省 → 不检查（false）；有值时：响应没有 ETag → 失败；值不是 `*` 且每个 token 都既不等于 etag、也不等于 `W/` + etag、也不满足 `W/` + token === etag → 失败。
 *   send 的比较是宽松口径（弱 / 强 ETag 互认），这里不另起一套强比较。我们的 ETag 恒为强 ETag。
 * If-Unmodified-Since：本中间件不发 Last-Modified，不处理（保持“忽略 IMS / IUS”的既有口径）。
 */
function isPreconditionFailure(ifMatch, etag) {
  if (typeof ifMatch !== 'string' || ifMatch === '') return false;
  if (!etag) return true;
  if (ifMatch === '*') return false;
  return parseTokenList(ifMatch).every((m) => m !== etag && m !== 'W/' + etag && 'W/' + m !== etag);
}

/**
 * @param {{ publicDir: string, log?: { error: Function }, startupStamp?: string }} options
 * @returns express 中间件 (req, res, next)
 */
function createHtmlAssetInjector({ publicDir, log, startupStamp } = {}) {
  if (typeof publicDir !== 'string' || publicDir === '') throw new TypeError('createHtmlAssetInjector: publicDir 必须是非空字符串');
  const logger = log && typeof log.error === 'function' ? log : console;
  const stamp = startupStamp === undefined || startupStamp === null ? String(Date.now()) : String(startupStamp);
  const root = path.resolve(publicDir);
  let realRootCache = null;
  const getRealRoot = () => {
    if (realRootCache === null) realRootCache = fs.realpathSync.native(root);
    return realRootCache;
  };

  const pageCache = new Map();   // realpath -> { mtimeMs, size, chunks, refs, lastKey, lastBody, lastEtag }
  const fpCache = new Map();     // realpath -> { mtimeMs, size, fp }
  const missingLogged = new Set();

  /** X 解析到 public 内的真实文件；出界 / 找不到 / 不是文件 → null */
  function resolveRef(pageDir, x) {
    const decoded = safeDecode(x);
    if (decoded === null || decoded === '' || decoded.includes('\0')) return null;
    const urlPath = decoded.replace(/\\/g, '/');
    const full = urlPath.startsWith('/') ? urlPath : pageDir + urlPath;
    const segs = [];
    for (const s of full.split('/')) {
      if (s === '' || s === '.') continue;
      if (s === '..') {
        if (segs.length === 0) return null; // 出界
        segs.pop();
      } else {
        segs.push(s);
      }
    }
    if (segs.length === 0) return null;
    const realRoot = getRealRoot();
    let real;
    let st;
    try {
      real = fs.realpathSync.native(path.join(realRoot, ...segs));
      st = fs.statSync(real);
    } catch (_) {
      return null;
    }
    if (!st.isFile() || !isInside(realRoot, real)) return null;
    return { real, st };
  }

  function fingerprintOf(real, st) {
    const hit = fpCache.get(real);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.fp;
    const r = readWithStat(real);
    const fp = sha256Hex(r.buf).slice(0, FINGERPRINT_LENGTH);
    fpCache.set(real, { mtimeMs: r.mtimeMs, size: r.size, fp });
    return fp;
  }

  function loadPage(real, st) {
    const hit = pageCache.get(real);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
    const r = readWithStat(real);
    const parsed = parsePage(r.buf.toString('latin1'));
    const entry = { mtimeMs: r.mtimeMs, size: r.size, chunks: parsed.chunks, refs: parsed.refs, lastKey: null, lastBody: null, lastEtag: null };
    pageCache.set(real, entry);
    return entry;
  }

  function notFound(req, res) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=UTF-8');
    res.setHeader('Cache-Control', 'no-cache');
    if (req.method === 'HEAD') return res.end();
    return res.end('Not Found');
  }

  return function htmlAssetInjector(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    try {
      const pathname = rawPathname(req.url);
      if (pathname === null) return next();
      if (API_PREFIX_RE.test(pathname)) return next(); // 不区分大小写：express 路由默认不分大小写，Windows 上 /API/p.html 也能解析到 public/api/p.html

      // —— 与 send 同口径的路径解析 ——
      const decoded = safeDecode(pathname);
      if (decoded === null || decoded.includes('\0')) return next();
      let rel = decoded;
      if (rel) rel = path.normalize('.' + path.sep + rel);
      if (UP_PATH_RE.test(rel)) return next();
      const parts = rel.split(path.sep);
      const lastPart = parts[parts.length - 1];
      if (parts.some((p) => p.length > 1 && p[0] === '.') && lastPart[0] === '.') return next(); // static 对点开头文件名回 404
      let target = path.normalize(path.join(root, rel));
      if (pathname[pathname.length - 1] === '/') target = path.join(target, 'index.html'); // 目录默认页

      let real;
      let st;
      try {
        real = fs.realpathSync.native(target);
        st = fs.statSync(real);
      } catch (_) {
        return next(); // 不存在 / 无权限：static 自己会回 404 或报错
      }
      if (st.isDirectory()) return next();
      if (!HTML_NAME_RE.test(path.basename(real)) && !HTML_NAME_RE.test(path.basename(target))) return next();
      // 到这里：static 会以 HTML 文件的字节作答。必须在 public 的真实目录内，否则拒绝（不放行给 static 吐原文）。
      const realRoot = getRealRoot();
      if (!isInside(realRoot, real)) return notFound(req, res);

      const page = loadPage(real, st);
      const relPosix = path.relative(realRoot, real).split(path.sep).join('/');
      const slash = relPosix.lastIndexOf('/');
      const pageDir = slash < 0 ? '/' : '/' + relPosix.slice(0, slash + 1);

      const fps = new Array(page.refs.length);
      for (let i = 0; i < page.refs.length; i++) {
        const x = page.refs[i].x;
        const hit = resolveRef(pageDir, x);
        const missKey = relPosix + '\n' + x;
        if (hit === null) {
          if (!missingLogged.has(missKey)) {
            missingLogged.add(missKey);
            logger.error(`[html-asset-fingerprint] 页面 /${relPosix} 引用的 ${x}?v=auto 找不到对应文件，改用启动时刻戳 ${stamp}`);
          }
          fps[i] = stamp;
        } else {
          missingLogged.delete(missKey);
          fps[i] = fingerprintOf(hit.real, hit.st);
        }
      }

      const key = fps.join(',');
      if (page.lastKey !== key) {
        let out = page.chunks[0];
        for (let i = 0; i < page.refs.length; i++) out += '?v=' + fps[i] + page.chunks[i + 1];
        const body = Buffer.from(out, 'latin1');
        page.lastBody = body;
        page.lastEtag = '"' + sha256Hex(body).slice(0, 32) + '"';
        page.lastKey = key;
      }
      const body = page.lastBody;
      const etag = page.lastEtag;

      // 条件请求顺序同 send：先 If-Match（不满足 → 412），再 If-None-Match（命中 → 304）。按最终响应体的 ETag 判。
      if (isPreconditionFailure(req.headers['if-match'], etag)) {
        res.statusCode = 412;
        res.setHeader('Content-Type', 'text/plain; charset=UTF-8');
        res.setHeader('Cache-Control', 'no-cache');
        if (req.method === 'HEAD') return res.end();
        return res.end('Precondition Failed');
      }
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('ETag', etag);
      if (etagMatches(req.headers['if-none-match'], etag)) {
        res.statusCode = 304;
        return res.end();
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=UTF-8');
      res.setHeader('Content-Length', String(body.length));
      if (req.method === 'HEAD') return res.end();
      return res.end(body);
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { createHtmlAssetInjector, parsePage, etagMatches, isPreconditionFailure, isInside, rawPathname, FINGERPRINT_LENGTH };
