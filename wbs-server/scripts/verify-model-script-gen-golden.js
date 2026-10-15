#!/usr/bin/env node
/**
 * #77 C3a-0：模型中心脚本生成器「全文基线」对拍（Node + vm，零 DOM、不起服务、不连数据库）。
 *
 * 目的：C3a 要把约 3,400 行脚本生成器从 public/Model_Center.html 搬进共享文件、C3b 要迁出配置台。
 *   迁之前在 HEAD 上把「现在的输出」录成文件化的标准答案，后两个提交拿它逐字节对拍。
 *   期望值必须来自改前代码，所以本提交不改任何生产文件。
 *
 * 跑法（均在 wbs-server 目录或任意目录，脚本自己 chdir 无关）：
 *   node scripts/verify-model-script-gen-golden.js              校验模式（默认）：全部夹具 × 全部输出类型全文逐字相等，全绿后接着跑下面的判别力自测（FAMILY 登记的就是这一条）
 *   node scripts/verify-model-script-gen-golden.js --no-self-test 只对拍、不跑自测
 *   node scripts/verify-model-script-gen-golden.js --self-test  只跑判别力自测：对生成器源码做 3 个诚实变异，每个都必须判红
 *   node scripts/verify-model-script-gen-golden.js --record     重写期望（只在 HEAD 上用）。MANIFEST.json 里存录制时 Model_Center.html 的 SHA-256，
 *        当前文件哈希不同即拒绝重录（C3a 起页面里的生成器已被删，哈希必变）；--force-record 是显式逃生口，会打印醒目警告
 *   node scripts/verify-model-script-gen-golden.js --coverage   输出 V8 行覆盖率（按函数），供 UNCOVERED.md 维护
 *
 * 夹具：scripts/fixtures/model-script-gen/<夹具名>.json，形态
 *   { name, kind: 'dim'|'dwd'|'ods', description, cases: [ { name, config } ] }（可读输入）；期望全文在同名 <夹具名>.expected.json.gz（gzip level 9，{ 用例名: { 输出类型: 全文 } }）
 *   真实形态夹具（real-*）= 本地库模型脱敏后（词级确定性映射，映射表不入库）；合成夹具（syn-*）= build-synthetic.js 生成。
 *   输出类型：dim → ddl / full / incr / fdl（+ liveDdl：配置台实时版 generateDimDDL，仅 config.live 存在时）
 *            dwd → ddl / companion（仅变更追踪开启）/ full / incr / fdl / quality
 *            ods → ddl / ddlCols / sync
 *
 * 冻结环境：固定 Date（2026-01-15T04:05:06Z）+ TZ=Asia/Shanghai（formatDateTimeUnified 读本地时区；脚本自检
 *   本地小时数 = 12，TZ 未生效即 fail-closed）。
 *
 * 取源码（C3a 起的现行口径）：readGeneratorSourceText() 读取 public/assets/js/model-script-gen.js 的源码文本（fs.readFileSync，CRLF 统一为 LF），
 *   不 require；文本仍在同一个 vm 沙箱里执行（loadGenerators 内：冻结 Date、注入 app.js 的 formatDateTimeUnified、变异自测改的是这份文本、
 *   --coverage 按脚本名与函数名统计这份文本）。读取时对库源码做 sliceFunction 校验：每个生成器函数名恰好声明一次且片段可独立编译。
 *   配置台实时版 generateDimDDL 的签名是 (tableName, tableComment, scdConfig, sourceTables, loadedFields)；用例里的 generateDimDDLLive 只是它的别名（参数直传）。
 *   C3a 之前（HEAD）的做法是从 Model_Center.html 按函数名切出生成器源码，并用页面全局替身包出 generateDimDDLLive；该做法已废弃。
 *
 * 威胁模型：自测只覆盖「诚实实现写错」（默认类型 / 头注释 / 连接词被误改会判红），不防故意绕过。
 */
'use strict';
process.env.TZ = 'Asia/Shanghai';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const MC_HTML = path.join(ROOT, 'public', 'Model_Center.html');
const APP_JS = path.join(ROOT, 'public', 'assets', 'js', 'app.js');
const LIB_JS = path.join(ROOT, 'public', 'assets', 'js', 'model-script-gen.js');
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'model-script-gen');
const MANIFEST_FILE = path.join(FIXTURE_DIR, 'MANIFEST.json');

// ---------------------------------------------------------------------------------------------
// 取源码文本（C3a 只改这一节的 readGeneratorSourceText；沙箱执行 runInSandbox 与其余部分不动）
// ---------------------------------------------------------------------------------------------
// 生成器函数（S 类，N0-C3 §1.2；不含无调用方的 generateDimETLFromConfig / generateSCD1ETL / generateSCD2ETL）
const GENERATOR_FUNCTIONS = [
  'normalizeDataType', 'buildChangeTag', 'resolveFieldExpr', 'generateDimDDLFromConfig', 'generateDimDDL',
  'generateExpressionSQL', '_generateExpressionSQLInner', 'buildFromClause', 'buildCtePrefix',
  'generateFullLoadScript', 'generateIncrementalScript', 'generateFdlNodeScript',
  'buildRecordKey', 'buildAuditJsonSnapshot', 'buildAuditBeforeAfter', 'buildAuditFlatPairs', 'buildDiffFieldsStuff',
  'buildDwdHashExpression', 'getPrimarySourceAlias', 'sortFieldsWithNamePairing',
  'generateDwdDDL', 'generateCompanionDDL', 'generateDwdFullLoadScript', 'generateDwdIncrementalScript', 'generateDwdFdlScript', 'generateDwdQualityRules',
  'generateODSDDL', 'generateODSDDLWithColumns', 'generateSyncScript',
];
const SCRIPT_URL = 'model-script-gen-bundle.js';   // 生成器源码在沙箱里的脚本名（覆盖率按它找）

function readLines(file) { return fs.readFileSync(file, 'utf8').split(/\r?\n/); }
/** 从行数组（共享库源码）里切一个函数声明（以同缩进的单独一行 `}` 结束） */
function sliceFunction(lines, name, indent) {
  const head = indent + 'function ' + name + '(';
  const headAsync = indent + 'async function ' + name + '(';
  // 28 号审 L1：同名函数声明（任意缩进、含 async）在源码里必须恰好出现一次，防抽错 / 重复声明
  const declRe = new RegExp('^\\s*(?:async\\s+)?function\\s+' + name.replace(/[$]/g, '\\$&') + '\\s*\\(');
  const count = lines.filter(l => declRe.test(l)).length;
  if (count !== 1) throw new Error('函数 ' + name + ' 在源码里应恰好匹配一次，实得 ' + count);
  const i = lines.findIndex(l => l.startsWith(head) || l.startsWith(headAsync));
  if (i < 0) throw new Error('源码里找不到函数 ' + name + '（按缩进 ' + indent.length + ' 空格）');
  const close = indent + '}';
  for (let k = i + 1; k < lines.length; k++) if (lines[k] === close) {
    const snippet = lines.slice(i, k + 1).join('\n');
    // 28 号审 L1：抽出的片段必须能被 vm 独立编译通过（语法完整，没有被截断 / 抽错结束行）
    try { new vm.Script(snippet, { filename: 'slice-' + name + '.js' }); } catch (e) { throw new Error('函数 ' + name + ' 抽出的片段无法独立编译：' + e.message); }
    return snippet;
  }
  throw new Error('函数 ' + name + ' 找不到结束行');
}
/**
 * 取「生成器源码文本」+「取 API 的表达式」（现行口径，C3a 起）。
 * text：public/assets/js/model-script-gen.js 的源码（CRLF 统一为 LF，前缀同一行的 `var window = {}; ` 让 UMD 把 API 挂到 window.ModelScriptGen）；
 * apiExpr：Object.assign({}, window.ModelScriptGen, { generateDimDDLLive: window.ModelScriptGen.generateDimDDL })——库的全部导出，加一个 generateDimDDLLive 别名。
 * 后面的沙箱执行（冻结 Date、注入 app.js 的 formatDateTimeUnified、变异自测、--coverage）都作用于这份源码文本。
 */
function readGeneratorSourceText() {
  // C3a：源码文本 = 共享库文件本身（不 require，仍进下面的 vm 沙箱执行）；统一成 LF 以便含换行的变异锚点在 CRLF 检出下也能命中
  let text = fs.readFileSync(LIB_JS, 'utf8').split('\r\n').join('\n');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  // 28 号审 L1 作用于共享库源码：每个生成器函数名恰好声明一次，且抽出的片段能独立编译（不改变送进沙箱的文本）
  const libLines = text.split('\n');
  for (const n of GENERATOR_FUNCTIONS) sliceFunction(libLines, n, '        ');
  // 沙箱里没有 window / module：在同一行前缀一个空 window，让 UMD 把 API 挂到 window.ModelScriptGen（不增加行数，覆盖率行号与文件一致）
  text = 'var window = {}; ' + text;
  // generateDimDDLLive：新签名已是显式参数（tableName, tableComment, scdConfig, sourceTables, loadedFields），直传
  return { text, apiExpr: 'Object.assign({}, window.ModelScriptGen, { generateDimDDLLive: window.ModelScriptGen.generateDimDDL })' };
}

// ---------------------------------------------------------------------------------------------
// 沙箱执行（C3a 不动）：冻结 Date + 注入 app.js 的 formatDateTimeUnified（页面全局函数，生成器的外部依赖）
// ---------------------------------------------------------------------------------------------
function readFormatDateTimeUnifiedSource() {
  const app = readLines(APP_JS);
  const f0 = app.findIndex(l => l.startsWith('function formatDateTimeUnified('));
  if (f0 < 0) throw new Error('app.js 里找不到 formatDateTimeUnified');
  let f1 = -1;
  for (let k = f0 + 1; k < app.length; k++) if (app[k] === '}') { f1 = k; break; }
  return app.slice(f0, f1 + 1).join('\n');
}
const FIXED_INSTANT = Date.UTC(2026, 0, 15, 4, 5, 6);
class FrozenDate extends Date {
  constructor(...a) { if (a.length === 0) super(FIXED_INSTANT); else super(...a); }
  static now() { return FIXED_INSTANT; }
}
/** 在同一个 vm 沙箱里执行生成器源码文本并取回 API；opts.mutate(源码文本) 仅供 --self-test 变异用 */
function loadGenerators(opts = {}) {
  const src = readGeneratorSourceText();
  const text = opts.mutate ? opts.mutate(src.text) : src.text;
  const sandbox = { Date: FrozenDate, console };
  vm.createContext(sandbox);
  vm.runInContext(readFormatDateTimeUnifiedSource(), sandbox, { filename: 'app-formatDateTimeUnified.js' });
  vm.runInContext(text, sandbox, { filename: SCRIPT_URL });
  const api = vm.runInContext(src.apiExpr, sandbox, { filename: 'model-script-gen-api.js' });
  return { api, source: text };
}
// ---------------------------------------------------------------------------------------------

function assertFrozenEnvironment() {
  const d = new FrozenDate();
  if (d.getHours() !== 12 || d.toISOString() !== '2026-01-15T04:05:06.000Z') {
    throw new Error(`冻结环境失效：本地小时=${d.getHours()}（期望 12，TZ=Asia/Shanghai），ISO=${d.toISOString()}`);
  }
}

/** 一个夹具用例 → 各输出类型的全文 */
function computeOutputs(api, kind, c) {
  const out = {};
  if (kind === 'dim') {
    out.ddl = api.generateDimDDLFromConfig(c.tableName, c.tableComment, c.scdConfig, c.sourceTables);
    out.full = api.generateFullLoadScript(c.tableName, c.tableComment, c.scdConfig, c.sourceTables || [], c.advancedSql || {});
    out.incr = api.generateIncrementalScript(c.tableName, c.tableComment, c.scdConfig, c.sourceTables || [], c.advancedSql || {});
    out.fdl = api.generateFdlNodeScript(c.tableName, c.tableComment, c.scdConfig, c.sourceTables || [], c.advancedSql || {});
    if (c.live) out.liveDdl = api.generateDimDDLLive(c.tableName, c.tableComment, c.scdConfig, c.live.sourceTables, c.live.loadedFields);
  } else if (kind === 'dwd') {
    const dc = c.dwdConfig || {}, st = c.sourceTables || [], adv = c.advancedSql || {}, fm = c.selectedFields || [], df = c.derivedFields || [];
    out.ddl = api.generateDwdDDL(c.tableName, c.tableComment, dc, fm, df, st);
    if (dc.changeTracking && dc.changeTracking.enabled) out.companion = api.generateCompanionDDL(c.tableName, c.tableComment, dc, fm, df);
    out.full = api.generateDwdFullLoadScript(c.tableName, c.tableComment, dc, fm, df, st, adv);
    out.incr = api.generateDwdIncrementalScript(c.tableName, c.tableComment, dc, fm, df, st, adv);
    out.fdl = api.generateDwdFdlScript(c.tableName, c.tableComment, dc, fm, df, st, adv);
    out.quality = api.generateDwdQualityRules(c.tableName, c.tableComment, dc, fm, df, st);
  } else if (kind === 'ods') {
    out.ddl = api.generateODSDDL(c.model);
    out.ddlCols = api.generateODSDDLWithColumns(c.model, c.columns, c.comment);
    out.sync = api.generateSyncScript(c.model.table_name);
  } else throw new Error('未知夹具类型 ' + kind);
  for (const [k, v] of Object.entries(out)) if (typeof v !== 'string') throw new Error(`输出 ${k} 不是字符串`);
  return out;
}

function loadFixtures() {
  const files = fs.readdirSync(FIXTURE_DIR).filter(f => f.endsWith('.json') && f !== 'MANIFEST.json').sort();
  if (!files.length) throw new Error('夹具目录为空：' + FIXTURE_DIR);
  return files.map(f => {
    const file = path.join(FIXTURE_DIR, f);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    // 期望全文放同名 <夹具名>.expected.json.gz（{ 用例名: { 输出类型: 全文 } }），夹具 JSON 只留可读的输入 config
    const gzFile = file.replace(/\.json$/, '.expected.json.gz');
    const exp = fs.existsSync(gzFile) ? JSON.parse(zlib.gunzipSync(fs.readFileSync(gzFile)).toString('utf8')) : {};
    for (const cs of data.cases) cs.expected = exp[cs.name] || {};
    return { file, gzFile, base: f, data };
  });
}

function sha256File(f) { return require('crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex'); }
function readManifest() { try { return JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8')); } catch (_) { return null; } }
/** 钉死夹具规模：丢文件 / 丢用例 / 丢输出都判红（返回问题列表） */
function checkManifest(fixtures, res) {
  const mf = readManifest();
  if (!mf) return ['缺少 MANIFEST.json（先在 HEAD 上 --record）'];
  const probs = [];
  const names = fixtures.map(f => f.base);
  if (JSON.stringify(names) !== JSON.stringify(mf.files)) probs.push(`夹具文件清单与 MANIFEST 不一致：实有 ${names.length} 个，登记 ${mf.files.length} 个`);
  for (const f of mf.files) { if (!fs.existsSync(path.join(FIXTURE_DIR, f))) probs.push('缺夹具文件 ' + f); if (!fs.existsSync(path.join(FIXTURE_DIR, f.slice(0, -5) + '.expected.json.gz'))) probs.push('缺期望文件 ' + f.slice(0, -5) + '.expected.json.gz'); }
  if (res.cases !== mf.cases) probs.push(`用例数 ${res.cases} ≠ MANIFEST ${mf.cases}`);
  if (res.outputs !== mf.outputs) probs.push(`输出数 ${res.outputs} ≠ MANIFEST ${mf.outputs}`);
  return probs;
}

function diffContext(a, b) {
  let i = 0; const n = Math.min(a.length, b.length);
  while (i < n && a[i] === b[i]) i++;
  const cut = (s) => JSON.stringify(s.slice(Math.max(0, i - 200), i + 200));
  return `首个差异位置 ${i}（期望长 ${a.length}，实际长 ${b.length}）\n  期望：${cut(a)}\n  实际：${cut(b)}`;
}

/** 校验：返回 { cases, outputs, mismatches[] } */
function verifyAll(api, fixtures) {
  const mismatches = []; let cases = 0, outputs = 0;
  for (const fx of fixtures) {
    for (const cs of fx.data.cases) {
      cases++;
      let got;
      try { got = computeOutputs(api, fx.data.kind, cs.config); } catch (e) { mismatches.push({ fixture: fx.base, case: cs.name, type: '(抛错)', detail: e.name + ': ' + e.message }); continue; }
      const exp = cs.expected || {};
      const types = new Set([...Object.keys(exp), ...Object.keys(got)]);
      for (const t of [...types].sort()) {
        outputs++;
        if (!(t in exp)) { mismatches.push({ fixture: fx.base, case: cs.name, type: t, detail: '期望文件里没有该输出类型（实际有）' }); continue; }
        if (!(t in got)) { mismatches.push({ fixture: fx.base, case: cs.name, type: t, detail: '实际没有该输出类型（期望里有）' }); continue; }
        if (exp[t] !== got[t]) mismatches.push({ fixture: fx.base, case: cs.name, type: t, detail: diffContext(exp[t], got[t]) });
      }
    }
  }
  return { cases, outputs, mismatches };
}

function record(api, fixtures) {
  // 先全部算完再写盘：任何用例抛错（说明夹具对该生成器不合法）整体拒绝录制，避免半录状态
  let cases = 0, outputs = 0; const errors = [];
  for (const fx of fixtures) {
    for (const cs of fx.data.cases) {
      try { cs.expected = computeOutputs(api, fx.data.kind, cs.config); } catch (e) { errors.push(`${fx.base} · ${cs.name}：${e.name}: ${e.message}`); continue; }
      cases++; outputs += Object.keys(cs.expected).length;
    }
  }
  if (errors.length) { errors.forEach(e => console.log('[record] 抛错 ' + e)); throw new Error(`${errors.length} 个用例在 HEAD 上抛错，拒绝录制（先修夹具）`); }
  for (const fx of fixtures) {
    const exp = {};
    for (const cs of fx.data.cases) { exp[cs.name] = cs.expected; delete cs.expected; }
    fs.writeFileSync(fx.file, JSON.stringify(fx.data, null, 1) + '\n');
    // 固定压缩级别 9；Node 的 gzip 头 mtime 恒为 0。「同输入同字节」只在同一 zlib 构建内成立（gzip 头 OS 字节在 Windows / Linux 不同，zlib 版本不同压缩字节也可能不同）；
    // 这只影响重录时的字节一致性，不影响校验（校验是解压后比内容）
    fs.writeFileSync(fx.gzFile, zlib.gzipSync(Buffer.from(JSON.stringify(exp), 'utf8'), { level: 9 }));
    for (const cs of fx.data.cases) cs.expected = exp[cs.name];
  }
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify({ note: '夹具规模钉死 + 录制时页面源码哈希（record 守卫用）', modelCenterSha256: sha256File(MC_HTML), toolchain: { node: process.versions.node, zlib: process.versions.zlib, note: 'gzip 期望文件的压缩字节只在同一工具链（Node / zlib 版本、操作系统）内保证一致；跨工具链重录会产生字节不同但解压内容相同的文件，校验只比解压后的内容' }, files: fixtures.map(f => f.base), cases, outputs }, null, 1) + '\n');
  return { cases, outputs };
}

// ---- 变异自测：3 个诚实变异（改默认数据类型 / 删头注释行 / 换连接词），各自必须判红 ----
function replaceFirst(src, anchor, repl, label) {
  const i = src.indexOf(anchor);
  if (i < 0) throw new Error(`变异 ${label}：源码里找不到锚点 ${JSON.stringify(anchor)}`);
  return src.slice(0, i) + repl + src.slice(i + anchor.length);
}
const MUTATIONS = [
  { label: '改一个默认数据类型（无字段映射时的默认列类型 NVARCHAR(128)→NVARCHAR(129)）', mutate: (s) => replaceFirst(s, '${snakeField}    NVARCHAR(128),${comment}', '${snakeField}    NVARCHAR(129),${comment}', 'default-type') },
  { label: '删一行头注释（DIM DDL 的「跟踪字段」行）', mutate: (s) => replaceFirst(s, "  跟踪字段: ${trackFields ? trackFields.join(', ') : '无'}\n", '', 'header-line') },
  { label: "换一个连接词（脚本头注释里 `t.joinType || 'LEFT JOIN'` 的默认连接）", mutate: (s) => replaceFirst(s, "(${t.joinType || 'LEFT JOIN'})", "(${t.joinType || 'INNER JOIN'})", 'join-word') },
];

function selfTest(fixtures) {
  let bad = 0;
  const control = verifyAll(loadGenerators().api, fixtures);
  if (control.mismatches.length) { console.log(`[self-test] 对照组（未变异）应全绿，实得 ${control.mismatches.length} 处不一致`); return 1; }
  console.log(`[self-test] 对照组（未变异）全绿：${control.cases} 用例 / ${control.outputs} 输出`);
  for (const m of MUTATIONS) {
    let res;
    try { res = verifyAll(loadGenerators({ mutate: m.mutate }).api, fixtures); } catch (e) { console.log(`[self-test] FAIL ${m.label}：变异后加载失败（${e.message}）`); bad++; continue; }
    if (res.mismatches.length === 0) { console.log(`[self-test] FAIL ${m.label}：变异后仍全绿（判别力不足）`); bad++; } else console.log(`[self-test] OK   ${m.label}：判红 ${res.mismatches.length} 处`);
  }
  return bad ? 1 : 0;
}

// ---- V8 行覆盖率（--coverage）----
function coverageReport(fixtures) {
  const inspector = require('inspector');
  const session = new inspector.Session(); session.connect();
  const post = (m, p) => new Promise((res, rej) => session.post(m, p || {}, (e, r) => e ? rej(e) : res(r)));
  return (async () => {
    await post('Profiler.enable');
    await post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
    const { api, source } = loadGenerators();
    verifyAll(api, fixtures);
    const cov = await post('Profiler.takePreciseCoverage');
    const sc = cov.result.find(r => r.url === SCRIPT_URL);
    if (!sc) throw new Error('覆盖率结果里找不到脚本 ' + SCRIPT_URL);
    const L = source.split('\n');
    const starts = [0]; for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
    const lineOf = (o) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= o) lo = mid; else hi = mid - 1; } return lo; };
    const unc = new Set();
    sc.functions.forEach(f => f.ranges.forEach(r => { if (r.count === 0) for (let l = lineOf(r.startOffset); l <= lineOf(Math.max(r.startOffset, r.endOffset - 1)); l++) unc.add(l); }));
    const fnAt = [];
    // 按函数名匹配、不绑缩进：起始行 = `[缩进]function 名(`，结束行 = 同缩进的单独一行 `}`（共享文件里缩进可能不同）
    L.forEach((ln, i) => { const m = ln.match(/^(\s*)(?:async\s+)?function\s+(\w+)\s*\(/); if (m && GENERATOR_FUNCTIONS.includes(m[2])) fnAt.push([i, m[2], m[1]]); });
    let T = 0, U = 0; const detail = [];
    fnAt.forEach(([i, n, ind], k) => {
      let end = k + 1 < fnAt.length ? fnAt[k + 1][0] : L.length;
      for (let l = i + 1; l < end; l++) if (L[l] === ind + '}') { end = l + 1; break; }
      let tot = 0, un = 0;
      for (let l = i; l < end; l++) { if (L[l].trim() === '') continue; tot++; if (unc.has(l)) { un++; detail.push(`${n} | ${L[l].trim().slice(0, 100)}`); } }
      T += tot; U += un;
      console.log(`${n.padEnd(34)} ${String(tot).padStart(5)} 未覆盖 ${String(un).padStart(4)}  ${(100 * un / tot).toFixed(0)}%`);
    });
    console.log(`TOTAL 行 ${T} 未覆盖 ${U} ${(100 * U / T).toFixed(1)}%`);
    if (process.env.COV_DETAIL_FILE) fs.writeFileSync(process.env.COV_DETAIL_FILE, detail.join('\n'));
  })();
}

async function main() {
  const args = process.argv.slice(2);
  assertFrozenEnvironment();
  const fixtures = loadFixtures();
  if (args.includes('--record')) {
    // 期望值必须来自改前代码：MANIFEST 里存录制时 Model_Center.html 的 SHA-256，哈希不同（页面已被改过）即拒绝
    const mf0 = readManifest();
    const curSha = sha256File(MC_HTML);
    if (mf0 && mf0.modelCenterSha256 && mf0.modelCenterSha256 !== curSha) {
      if (!args.includes('--force-record')) {
        console.error(`[record] 拒绝：Model_Center.html 的 SHA-256 与录制时不同（登记 ${mf0.modelCenterSha256.slice(0, 12)}… / 当前 ${curSha.slice(0, 12)}…）。期望值必须来自改前代码，C3a 起不得再录制。确需重录请加 --force-record。`);
        return 1;
      }
      console.error('!!!!!! [record] --force-record：Model_Center.html 已与录制时不同，本次录制会把改后的输出固化为期望，仅限你明确知道在做什么 !!!!!!');
    }
    const { api } = loadGenerators();
    const r = record(api, fixtures);
    console.log(`[record] 已重写期望：${fixtures.length} 个夹具文件 / ${r.cases} 用例 / ${r.outputs} 输出`);
    return 0;
  }
  if (args.includes('--coverage')) { await coverageReport(fixtures); return 0; }
  if (args.includes('--self-test')) return selfTest(fixtures);
  const { api } = loadGenerators();
  const res = verifyAll(api, fixtures);
  for (const m of res.mismatches) console.log(`[FAIL] 夹具 ${m.fixture} · 用例 ${m.case} · 输出类型 ${m.type}\n  ${m.detail}`);
  console.log(`[golden] ${fixtures.length} 个夹具文件 / ${res.cases} 用例 / ${res.outputs} 输出；不一致 ${res.mismatches.length}`);
  const probs = checkManifest(fixtures, res);
  probs.forEach(x => console.log('[FAIL] 夹具规模：' + x));
  if (res.mismatches.length || probs.length) return 1;
  // 默认运行（含 FAMILY）在对拍全绿之后接着做判别力自测；只想对拍可加 --no-self-test
  return args.includes('--no-self-test') ? 0 : selfTest(fixtures);
}
main().then(code => process.exit(code), e => { console.error(e && e.stack || e); process.exit(1); });
