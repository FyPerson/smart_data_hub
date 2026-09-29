// verify-no-listen-zero.js — 静态守卫：wbs-server/scripts/ 下禁止让系统分配端口（PROJECT_STATUS #95）
//
// 为什么：本机动态端口段 1024–15000 含 Fetch 禁用端口（6666/10080 等），listen(0) 偶发分到后 undici 报
//   `fetch failed / bad port`、Chromium 报 ERR_UNSAFE_PORT。所有回环服务一律走
//   scripts/lib/listen-safe-port.js 的 listenOnSafePort（20000–49999 随机 + 只重试绑定）。
// 判据：扫 wbs-server/scripts/**/*.js（不含 node_modules），用 acorn 精确定位注释并等长掩码后，匹配
//   「交给系统分配端口」的字面量写法：listen(0…) / listen('0'…) / listen() / listen({ port: 0 或 '0' … })。
//   字符串内容不剥——以字符串形式拼出来再执行的代码同样算。
// 能力边界（如实声明·定位=常规写法回归防护，不宣称完整）：只认上述字面量；以下写法看不出来——
//   经变量传递（const p = 0; listen(p)，verify-it-test-http.js 曾有一处，已改为助手取首个端口）、
//   表达式（listen(+0) / listen(0 + 0) / listen(p = 0)）、计算属性访问（server['listen'](0)）。
//   codex 08 提出过常量传播方案，未采纳：推断逻辑每多一条就多一个误放行面，不值得为罕见写法付出。
// 扫描集合（2026-09-29 改）：scripts/ 下 git 可见的 .js = 已跟踪 + 未跟踪但未被 .gitignore 忽略
//   （git ls-files -co --exclude-standard）。被忽略的本地文件（_demo-* / _seed-* 等）不进仓、不进镜像、
//   不属于仓库契约，按磁盘全扫会让守卫在主工作区判红、干净检出判绿。新写还没 add 的文件照样扫到。
//   git 取不到列表时判红（fail-closed），不回退到磁盘全扫也不静默放过。
//   这个扫描集合成立的前提由下方「扫描集合前提」四道硬门锁住（codex 09）：git 仓库根 = 本项目根
//   （防嵌套仓库 / 子模块）；scripts/ 下无符号链接与子模块入口；未开启稀疏检出；被忽略的 .js 不得以
//   verify- 开头（FAMILY 按 verify-sys-* 通配 + 显式名单选成员，部署是 git pull，被忽略文件因此既不进
//   FAMILY 也不进生产——这条硬门防的是有人把会执行的套件加进 .gitignore）。
// 扫描范围：只扫 wbs-server/scripts/。2026-09-29 全仓库（不含 node_modules）核过，scripts/ 以外没有
//   回环服务的 listen 调用（只有注释与一个 .deprecated 文件），范围与现状一致；新增目录起服务时要同步扩范围。
// 豁免：只有助手本身（lib/listen-safe-port.js）。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const acorn = require('acorn');

const SCRIPTS_DIR = __dirname;
const EXEMPT = new Set(['lib/listen-safe-port.js']);
// 注意：本文件自己不能出现字面量写法（否则自己判红），反例样本一律用拼接构造。
const L = 'listen';
const ZERO = `(?:0(?![0-9.xXbBoOeEn_])|'0'|"0")`; // 数字 0 或字符串 '0' / "0"（不用捕获组：ZERO 在正则里出现两次）
const FORBIDDEN = new RegExp(`\\b${L}\\s*\\(\\s*(?:${ZERO}|\\)|\\{\\s*port\\s*:\\s*${ZERO})`, 'g');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`FAIL ${label}${detail === undefined ? '' : '\n' + detail}`);
}

// git 可见集合：已跟踪 + 未跟踪未忽略。失败返回 { error }，由调用方判红。
function listJsFiles(dir) {
  let raw;
  try { raw = execFileSync('git', ['ls-files', '-z', '-c', '-o', '--exclude-standard', '--', '.'], { cwd: dir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }); }
  catch (e) { return { error: 'git ls-files 失败：' + e.message }; }
  const files = [];
  for (const rel of raw.split('\0')) {
    if (!rel || !rel.endsWith('.js') || rel.split('/').includes('node_modules')) continue;
    const full = path.join(dir, rel);
    if (fs.existsSync(full)) files.push(full); // 已跟踪但工作区已删的文件不扫
  }
  return { files };
}

// 用 acorn 拿到注释的精确区间（字符串/模板/正则内的 // 与 /* 不会被误判），等长掩码成空格（保留换行）。
function blankComments(src) {
  const ranges = [];
  const opts = { ecmaVersion: 'latest', allowHashBang: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, onComment: (block, text, start, end) => ranges.push([start, end]) };
  try { acorn.parse(src, { ...opts, sourceType: 'script' }); }
  catch (e1) {
    ranges.length = 0;
    try { acorn.parse(src, { ...opts, sourceType: 'module' }); }
    catch (e2) { return { error: e1.message }; }
  }
  const chars = src.split('');
  for (const [start, end] of ranges) for (let i = start; i < end; i++) if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
  return { text: chars.join('') };
}

function findViolations(src) {
  const r = blankComments(src);
  if (r.error) return { error: r.error, hits: [] };
  const hits = [];
  FORBIDDEN.lastIndex = 0;
  let m;
  while ((m = FORBIDDEN.exec(r.text))) {
    const line = r.text.slice(0, m.index).split('\n').length;
    hits.push({ line, text: src.split('\n')[line - 1].trim().slice(0, 160) });
  }
  return { hits };
}

// ── 1. 反例自证：判据在内存样本上必须判红 / 判绿 ──
const RED_SAMPLES = [
  `srv = app.${L}(0); PORT = srv.address().port;`,
  `await new Promise(res => server.${L}( 0, '127.0.0.1', res));`,
  `server = app.${L}(0, () => { port = server.address().port; resolve(); });`,
  `s.${L}(\n  0,\n  '127.0.0.1')`,
  `server.${L}();`,
  `server.${L}({ port: 0, host: '127.0.0.1' });`,
  `const code = "app.${L}(0)"; eval(code);`,
  `server.${L}('0', '127.0.0.1');`,
  `server.${L}("0");`,
  `server.${L}({ port: '0' });`,
];
const GREEN_SAMPLES = [
  `// app.${L}(0) 已废弃\nserver = await listenOnSafePort(app);`,
  `/* s.${L}(0, '127.0.0.1') */ s.${L}(port, '127.0.0.1');`,
  `server.${L}(PORT, '0.0.0.0');`,
  `server.${L}(20000 + n);`,
  `server.${L}(0x4e20);`,
  `server.${L}({ port: 20000 });`,
  `server.${L}('0.0.0.0');`,
  `server.${L}('08080');`,
  `const u = 'http://x/#// ${L}'; server.${L}(port);`,
];
RED_SAMPLES.forEach((s, i) => { const r = findViolations(s); check(`反例 R${i + 1} 判红`, !r.error && r.hits.length >= 1, JSON.stringify(r)); });
GREEN_SAMPLES.forEach((s, i) => { const r = findViolations(s); check(`正例 G${i + 1} 判绿`, !r.error && r.hits.length === 0, JSON.stringify(r)); });

// ── 2. 全量扫描 ──
const listed = listJsFiles(SCRIPTS_DIR);
check('git 可见文件列表可取（取不到即判红）', !listed.error, listed.error);
// ── 扫描集合前提（硬门，任一不满足即判红）──
function git(args) {
  try { return { out: execFileSync('git', args, { cwd: SCRIPTS_DIR, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }) }; }
  catch (e) { return { error: e.message, status: e.status }; }
}
{
  const top = git(['rev-parse', '--show-toplevel']);
  const expected = path.resolve(SCRIPTS_DIR, '..', '..');
  const actual = top.out ? path.resolve(top.out.trim()) : null;
  check('前提：git 仓库根 = 本项目根（非嵌套仓库 / 子模块）', !!actual && actual.toLowerCase() === expected.toLowerCase(), top.error || `${actual} vs ${expected}`);
  const staged = git(['ls-files', '-s', '-z', '--', '.']);
  const special = staged.out ? staged.out.split('\0').filter((l) => /^(120000|160000) /.test(l)) : null;
  check('前提：scripts/ 下无符号链接与子模块入口', !!special && special.length === 0, staged.error || (special || []).join('\n'));
  const sparse = git(['config', '--get', '--bool', 'core.sparseCheckout']);
  // 只有「输出 false」或「退出码 1 = 配置项不存在」算未开启；git 本身失败（其他退出码 / 无退出码）判红（codex 09-R M）
  const sparseOff = sparse.out !== undefined ? sparse.out.trim() === 'false' : sparse.status === 1;
  check('前提：未开启稀疏检出（git 失败即判红）', sparseOff, sparse.error || sparse.out);
  const ignored = git(['ls-files', '-z', '-o', '-i', '--exclude-standard', '--', '.']);
  const ignoredVerify = ignored.out !== undefined ? ignored.out.split('\0').filter((f) => /(^|\/)verify-[^/]*\.js$/.test(f)) : null;
  check('前提：被忽略的 .js 不以 verify- 开头（不得把会执行的套件移出扫描面）', !!ignoredVerify && ignoredVerify.length === 0, ignored.error || (ignoredVerify || []).join('\n'));
}
const files = listed.files || [];
const rel = (f) => path.relative(SCRIPTS_DIR, f).split(path.sep).join('/');
check('扫描面非空（>100 个 .js）', files.length > 100, files.length);
check('助手文件存在且在扫描面内', files.some((f) => rel(f) === 'lib/listen-safe-port.js'));
check('自身在扫描面内（不豁免自己）', files.some((f) => rel(f) === 'verify-no-listen-zero.js'));
const parseErrors = [], violations = [];
for (const f of files) {
  const r2 = rel(f);
  if (EXEMPT.has(r2)) continue;
  const res = findViolations(fs.readFileSync(f, 'utf8'));
  if (res.error) parseErrors.push(`${r2}: ${res.error}`);
  for (const h of res.hits) violations.push(`${r2}:${h.line}: ${h.text}`);
}
check('所有文件可解析（解析失败即判红，不静默跳过）', parseErrors.length === 0, parseErrors.join('\n'));
check(`scripts/ 下无 ${L}(0) / ${L}() / ${L}({port:0})（改用 lib/listen-safe-port.js）`,violations.length === 0, violations.join('\n'));

console.log(`verify-no-listen-zero files=${files.length} PASS=${pass} FAIL=${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
