/**
 * 页面缓存串注入的实例级检查（#106 W4 / S6b）
 *
 * 被测 = 隔离临时实例（scripts/lib/test-env.js 自起，或由批跑器给的 TEST_* 变量组）上真实的 server.js 静态托管：
 * utils/html-asset-fingerprint.js 注入中间件 + express.static(public) 的 setHeaders。进程内自检（verify-html-asset-fingerprint.js）只证明中间件模块本身，
 * 本脚本证明“挂在真实服务上、对真实页面”也成立。只读：不写库、不写文件，只对静态页面与静态资源发 GET。
 *
 * 检查（每个页面 = git 可见集合里 public 下全部 .html / .htm，与静态守卫 verify-shared-css-cache-bust.js 的 S4 同一口径）：
 *   P1 GET /<页面> → 200；响应体不含字面 `?v=auto`；响应里每个本地 JS / CSS 引用的查询串恰为 `?v=<12 位十六进制>`，且等于该文件**磁盘字节** sha256 前 12 位
 *      （证明指纹只由文件内容决定——“改一个资源只有它的指纹变”在真实页面上的前提；与磁盘源码里 `?v=auto` 引用条数相等，防引用被漏替换或多出）。
 *      逐页之后还对账：实际核对的本地引用累计条数 > 0，且等于静态守卫（verify-shared-css-cache-bust.js 的 runAll）此刻扫描到的本地引用总数（现算）。
 *   P2 响应头：强 ETag（`"<32 位十六进制>"`，无 W/ 前缀）、Cache-Control 恰为 no-cache、无 Last-Modified。
 *   P3 带上一步的 ETag 再请求 → 304（无响应体、ETag 不变）。
 *   P4 大小写与 Windows 别名抽 3 条（/TASK_POOL.HTML、/Task_Pool.html.、/Task_Pool.html::$DATA）：要么 4xx，要么 P1 + P2 全部成立。
 *   P5 一个本地 JS：带 `?v=auto` 直接请求 → Cache-Control: no-cache；带 12 位指纹请求 → 7 天缓存头（max-age=604800）。
 *
 * 用法：node scripts/verify-html-fingerprint-e2e.js
 * 输出：失败逐条列出；末行 `verify-html-fingerprint-e2e PASS=<n> FAIL=<n>`；FAIL>0 退出码 1。
 * 批跑登记：needsService（共享实例，只读，不依赖库内数据；run-verify-family.js 的 SERVICE_MEMBERS）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const testEnv = require('./lib/test-env');
const guard = require('./verify-shared-css-cache-bust');

let PUBLIC_DIR = null;   // main() 开头赋值（模块顶层只放声明，不放调用）
const NON_LOCAL_RE = /^(?:[a-z][a-z0-9+.\-]*:|\/\/)/i;
const HEX12_RE = /^[0-9a-f]{12}$/;
const STRONG_ETAG_RE = /^"[0-9a-f]{32}"$/;
const ALIASES = ['/TASK_POOL.HTML', '/Task_Pool.html.', '/Task_Pool.html::$DATA'];
const ALIAS_BASE_PAGE = 'Task_Pool.html';
const JS_SAMPLE = 'assets/js/app.js';

let pass = 0;
let fail = 0;
let checkedRefs = 0;   // 逐页实际核对过指纹的本地 JS/CSS 引用累计条数（别名请求不计）
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(`  [FAIL] ${name}${detail ? ' · ' + detail : ''}`);
}

const sha12 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
const encodePath = (rel) => '/' + rel.split('/').map(encodeURIComponent).join('/');

/** git 可见集合里 public 下的页面（与静态守卫 S4 同口径）；失败抛错 */
function listPages() {
  const out = execFileSync('git', ['-C', path.resolve(PUBLIC_DIR, '..', '..'), 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'wbs-server/public'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const prefix = 'wbs-server/public/';
  return out.split('\0').filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length)).filter((p) => /\.html?$/i.test(p) && fs.existsSync(path.join(PUBLIC_DIR, p))).sort();
}

/** 响应体里的本地 JS / CSS 引用：[{ raw, url }]（url 已按页面地址解析） */
function localRefsOf(body, pageUrl) {
  const refs = [];
  for (const tag of guard.scanHtml(body)) {
    const attr = tag.name === 'script' ? 'src' : (tag.name === 'link' ? 'href' : null);
    if (attr === null) continue;
    const v = guard.attrOf(tag, attr);
    if (v === undefined || v.trim() === '' || NON_LOCAL_RE.test(v.trim())) continue;
    let u;
    try { u = new URL(v.trim(), pageUrl); } catch (_) { continue; }
    let decoded = u.pathname;
    try { decoded = decodeURIComponent(u.pathname); } catch (_) { /* 保留原样 */ }
    if (/\.(?:js|css)$/i.test(u.pathname) || /\.(?:js|css)$/i.test(decoded)) refs.push({ raw: v.trim(), url: u, decoded });
  }
  return refs;
}

/** P1 + P2：对一个 200 响应逐项核对（pageRel = 该响应对应的磁盘页面，别名请求传被别名指向的页面） */
function checkOkResponse(label, pageRel, pageUrl, res, body, countRefs) {
  check(`${label}：响应体不含字面 ?v=auto`, !body.includes('?v=auto'));
  const etag = res.headers.get('etag');
  check(`${label}：强 ETag（"<32 位十六进制>"，无 W/ 前缀）`, typeof etag === 'string' && STRONG_ETAG_RE.test(etag), `etag=${etag}`);
  check(`${label}：Cache-Control 恰为 no-cache`, res.headers.get('cache-control') === 'no-cache', `cache-control=${res.headers.get('cache-control')}`);
  check(`${label}：无 Last-Modified`, res.headers.get('last-modified') === null, `last-modified=${res.headers.get('last-modified')}`);
  const refs = localRefsOf(body, pageUrl);
  const srcText = fs.readFileSync(path.join(PUBLIC_DIR, pageRel), 'utf8');
  const expectedCount = guard.analyzeHtml(pageRel, srcText, {}).stats.localRefs;
  check(`${label}：本地 JS/CSS 引用条数 = 磁盘源码里的引用条数（${expectedCount}）`, refs.length === expectedCount, `响应 ${refs.length} 条`);
  for (const r of refs) {
    const m = /^\?v=([^&#]*)$/.exec(r.url.search);
    const got = m ? m[1] : null;
    check(`${label}：${r.raw} 的查询串恰为 ?v=<12 位十六进制>`, got !== null && HEX12_RE.test(got), `search=${r.url.search}`);
    const segs = r.decoded.split('/').filter((s) => s !== '');
    const file = path.join(PUBLIC_DIR, ...segs);
    let expected = null;
    try { expected = sha12(fs.readFileSync(file)); } catch (_) { expected = null; }
    check(`${label}：${r.raw} 指向的文件在 public 下存在`, expected !== null, file);
    if (expected !== null) {
      check(`${label}：${r.raw} 的指纹 = 磁盘字节 sha256 前 12 位（${expected}）`, got === expected, `实得 ${got}`);
      if (countRefs && got === expected) checkedRefs++;
    }
  }
  return etag;
}

async function main(base) {
  PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
  const pages = listPages();
  check('页面集合非空（git 可见集合 public 下的 .html / .htm）', pages.length >= 1, `共 ${pages.length} 个`);
  for (const rel of pages) {
    const url = base + encodePath(rel);
    const res = await fetch(url, { redirect: 'manual' });
    const body = await res.text();
    check(`${rel}：GET → 200`, res.status === 200, `status=${res.status}`);
    if (res.status !== 200) continue;
    const etag = checkOkResponse(rel, rel, url, res, body, true);
    // P3 条件请求
    if (typeof etag === 'string') {
      const r2 = await fetch(url, { redirect: 'manual', headers: { 'If-None-Match': etag } });
      const b2 = await r2.text();
      check(`${rel}：带上一步的 ETag 再请求 → 304 且无响应体`, r2.status === 304 && b2 === '', `status=${r2.status} len=${b2.length}`);
      check(`${rel}：304 仍带同一 ETag 与 no-cache`, r2.headers.get('etag') === etag && r2.headers.get('cache-control') === 'no-cache', `etag=${r2.headers.get('etag')} cc=${r2.headers.get('cache-control')}`);
    }
  }

  // P1 的覆盖面对账：实际核对（指纹 = 磁盘字节 sha256 前 12 位）的本地引用累计条数 > 0，且等于静态守卫此刻扫描到的引用总数（现算，不写死）
  const scanned = guard.runAll(PUBLIC_DIR, guard.gitVisibleHtml(PUBLIC_DIR), guard.S2_EXEMPT).stats.localRefs;
  check(`实际核对的本地引用累计条数 > 0（${checkedRefs}）`, checkedRefs > 0, `checkedRefs=${checkedRefs}`);
  check(`实际核对的本地引用累计条数 = 静态守卫扫描到的本地引用总数（核对 ${checkedRefs} / 扫描 ${scanned}）`, checkedRefs === scanned, `checkedRefs=${checkedRefs} scanned=${scanned}`);

  // P4 别名
  check(`别名基准页 ${ALIAS_BASE_PAGE} 在页面集合里`, pages.includes(ALIAS_BASE_PAGE));
  for (const alias of ALIASES) {
    const url = base + alias;
    const res = await fetch(url, { redirect: 'manual' });
    const body = await res.text();
    if (res.status >= 400 && res.status < 500) { check(`别名 ${alias}：4xx 拒绝（status=${res.status}）`, true); continue; }
    check(`别名 ${alias}：状态码要么 4xx，要么 200 且全部成立`, res.status === 200, `status=${res.status}`);
    if (res.status === 200) checkOkResponse(`别名 ${alias}`, ALIAS_BASE_PAGE, url, res, body);
  }

  // P5 本地 JS 的缓存头
  const jsUrl = base + '/' + JS_SAMPLE;
  const jsBytes = fs.readFileSync(path.join(PUBLIC_DIR, JS_SAMPLE));
  const fp = sha12(jsBytes);
  const auto = await fetch(jsUrl + '?v=auto', { redirect: 'manual' });
  await auto.arrayBuffer();
  check(`${JS_SAMPLE}?v=auto → 200 且 Cache-Control: no-cache`, auto.status === 200 && auto.headers.get('cache-control') === 'no-cache', `status=${auto.status} cc=${auto.headers.get('cache-control')}`);
  const hashed = await fetch(jsUrl + '?v=' + fp, { redirect: 'manual' });
  await hashed.arrayBuffer();
  check(`${JS_SAMPLE}?v=<12 位指纹> → 200 且 7 天缓存头（max-age=604800）`, hashed.status === 200 && /(?:^|[ ,])max-age=604800(?:$|[ ,])/.test(hashed.headers.get('cache-control') || ''), `status=${hashed.status} cc=${hashed.headers.get('cache-control')}`);
  const bare = await fetch(jsUrl, { redirect: 'manual' });
  await bare.arrayBuffer();
  check(`${JS_SAMPLE}（无 ?v）→ 200 且 7 天缓存头（对照：只有 v=auto 被降级为 no-cache）`, bare.status === 200 && /max-age=604800/.test(bare.headers.get('cache-control') || ''), `status=${bare.status} cc=${bare.headers.get('cache-control')}`);
  return pages.length;
}

(async () => {
  await testEnv.ready();   // 先于任何网络请求：自起隔离实例（或核对 TEST_* 变量组）
  let code = 1;
  let nPages = 0;
  try {
    nPages = await main(testEnv.env().baseUrl);
    code = fail === 0 ? 0 : 1;
  } catch (e) {
    fail++;
    failures.push(`  [FAIL] 异常中断：${e && e.stack || e}`);
    code = 1;
  } finally {
    try { await testEnv.teardown(); } catch (e) { console.error(`teardown 失败：${e.message}`); code = 1; }
  }
  for (const line of failures) console.log(line);
  console.log(`扫描页面 ${nPages} 个；实际核对本地引用 ${checkedRefs} 条`);
  console.log(`verify-html-fingerprint-e2e PASS=${pass} FAIL=${fail}`);
  testEnv.finish(code);   // teardown 已落定；只设退出码，不立刻 process.exit
})().catch(async (e) => {
  console.error('verify-html-fingerprint-e2e 启动失败：', e && e.stack || e);
  try { await testEnv.teardown(); } catch (_) { /* 已在报错路径 */ }
  process.exit(1);
});
