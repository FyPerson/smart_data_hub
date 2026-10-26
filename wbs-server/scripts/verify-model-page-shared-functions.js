#!/usr/bin/env node
/**
 * #77 C3b：模型中心两页「各留一份」的共用小工具函数同源守卫（纯 node，不起服务）。
 *
 * 背景：配置台迁出后，Model_Center.html（目录页）与 Model_Workbench.html（配置台）都要用 copyToClipboard / loadRegDomainOptions /
 *   行号与高亮家族（attachLineNumbers / highlightSQL / attachLineNumbersAndHighlight / refreshHighlight）。方案 §6.2 第 4 条裁定「不另开第二个
 *   共享文件，两页各留一份并加同源断言」。本守卫钉死：这几个函数两页都恰好定义一次，且函数文本去掉全部空白后逐字相等；
 *   防止日后只改一页造成两页行为悄悄分叉。
 *   （比较口径 2026-10 由「去全部空白」改为 acorn tokenizer 的 token 序列：忽略空白与注释，但字符串字面量 / 模板串内容按 token value 比较，
 *   所以字符串里多一个或少一个空格会判红；原口径会把它吞掉。）
 *
 * 判据：
 *   ① SAME 清单里的每个函数：两页各有且仅有一个顶层 function 声明；
 *   ② 两页的函数文本（acorn 取节点源码）的 token 序列（type.label + value，忽略空白与注释）逐个相等；
 *   ③ 两页顶层都定义了的同名标识符（函数 / const / let / var）必须在 SAME 或 DIFFERENT_BY_DESIGN 里登记——
 *      新增一个两页同名的函数，要么登记为同源（并受 ② 约束），要么登记为「有意不同」并写明理由，不允许悄悄复制。
 *   ⑤ 每页内联脚本顶层的函数声明不得同名重复（报出名字与两个行号）：后一个会静默覆盖前一个，前一个是死代码或行为分叉（30 H2）；
 *      目录页的「页面代码」= 内联脚本 + assets/js/model-catalog.js（C4a 起列表代码在其中），catalog 自身顶层函数同样不得重名。
 *   ⑥ （C4a）目录页必须恰好一次、未被注释地 `<script src>` 引用 assets/js/model-catalog.js：位置在 app.js 标签之后、第一个内联 <script> 之前，
 *      标签上除 src 外不得有任何属性（defer / async / type=module 都会改变求值时机）；配置台页不得引用 catalog（配置台页上 typeof currentPage 必须不存在）。
 *   ⑦ （C4a）catalog 顶层声明名 ∩（目录页内联顶层名 ∪ app.js 顶层名）必须为空：经典脚本共享一个全局环境，let / const 撞名会让后执行的脚本整段 SyntaxError，
 *      function 撞名会静默覆盖。
 *   DIFFERENT_BY_DESIGN：两页需求不同、各留各的实现（方案 §6.2 第 4 条）。
 *
 * 用法：node scripts/verify-model-page-shared-functions.js [--self-test]
 * 威胁模型：只防「诚实改了一页忘了另一页 / 新增同名复制」，不防故意绕过（动态定义、字符串拼接定义）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const PUB = path.join(__dirname, '..', 'public');
const PAGE_A = 'Model_Center.html';
const PAGE_B = 'Model_Workbench.html';
const CATALOG = 'assets/js/model-catalog.js';
const APP_JS = 'assets/js/app.js';
const SAME = ['userCanEditModel', 'copyToClipboard', 'loadRegDomainOptions', 'attachLineNumbers', 'highlightSQL', 'attachLineNumbersAndHighlight', 'refreshHighlight'];
const DIFFERENT_BY_DESIGN = {
  loadSourceSystems: '目录页版另带 code→name 缓存（MDC_SOURCE_SYSTEM_NAMES）且只填 regSourceSystem；配置台版只填 genSourceSystem / regSourceSystem，不写 MDC 缓存',
  confirmRegister: '目录页只保留「编辑信息」分支（PUT）；配置台只保留「注册新模型」分支（POST，成功后跳回目录页）',
};

function inlineScripts(html) {
  const out = []; const re = /<!--[\s\S]*?-->|<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi; let m;
  while ((m = re.exec(html))) { if (m[0].startsWith('<!--')) continue; if (!/\ssrc\s*=/.test(m[1] || '')) out.push(m[2]); }
  return out;
}
/** 页面里每个内联脚本顶层的函数声明：{ name, line }（line = 声明所在的 html 行号）；同名重复 = 后一个静默覆盖前一个（30 H2：目录页曾留着被覆盖的旧 openDimConfigViewModal 死代码） */
function topLevelFunctionDecls(html) {
  const out = []; const re = /<!--[\s\S]*?-->|<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi; let m;
  while ((m = re.exec(html))) {
    if (m[0].startsWith('<!--') || /\ssrc\s*=/.test(m[1] || '')) continue;
    const off = m.index + m[0].indexOf('>') + 1;
    const ast = acorn.parse(m[2], { ecmaVersion: 2022, ranges: true, allowAwaitOutsideFunction: true });
    for (const n of ast.body) if (n.type === 'FunctionDeclaration') out.push({ name: n.id.name, line: html.slice(0, off + n.start).split('\n').length });
  }
  return out;
}
/** 顶层标识符定义：{ funcs: Map<name, 源码[]>, vars: Set<name> } */
function topLevel(html) {
  const funcs = new Map(), vars = new Set();
  for (const s of inlineScripts(html)) {
    const ast = acorn.parse(s, { ecmaVersion: 2022, ranges: true, allowAwaitOutsideFunction: true });
    for (const n of ast.body) {
      if (n.type === 'FunctionDeclaration') { const a = funcs.get(n.id.name) || []; a.push(s.slice(n.start, n.end)); funcs.set(n.id.name, a); }
      else if (n.type === 'VariableDeclaration') for (const d of n.declarations) { if (d.id.type === 'Identifier') vars.add(d.id.name); /* ObjectPattern（共享库解构）由 verify-model-script-gen-single-source.js 管 */ }
    }
  }
  return { funcs, vars };
}
/** token 序列：type.label + value（正则 token 的 value 是 {pattern, flags}，转成字符串）；空白与注释 tokenizer 本身不产出 */
const toks = (t) => {
  const out = [];
  for (const tk of acorn.tokenizer(t, { ecmaVersion: 2022, allowAwaitOutsideFunction: true })) {
    const v = tk.value;
    out.push(tk.type.label + '\u0001' + (v === undefined || v === null ? '' : (typeof v === 'object' ? 'RE:' + v.pattern + '/' + v.flags : String(v))));
  }
  return out;
};

/** 经典脚本源码的顶层声明名：[{ name, kind, line }]（kind: function / var；解构声明逐个取名） */
function scriptTopNames(src) {
  const out = [];
  const lineOf = (pos) => src.slice(0, pos).split('\n').length;
  const patNames = (p, acc) => {
    if (!p) return;
    if (p.type === 'Identifier') acc.push(p.name);
    else if (p.type === 'ObjectPattern') p.properties.forEach(q => patNames(q.type === 'RestElement' ? q.argument : q.value, acc));
    else if (p.type === 'ArrayPattern') p.elements.forEach(e => patNames(e, acc));
    else if (p.type === 'AssignmentPattern') patNames(p.left, acc);
    else if (p.type === 'RestElement') patNames(p.argument, acc);
  };
  const ast = acorn.parse(src, { ecmaVersion: 2022, allowAwaitOutsideFunction: true });
  for (const n of ast.body) {
    if (n.type === 'FunctionDeclaration') out.push({ name: n.id.name, kind: 'function', line: lineOf(n.start) });
    else if (n.type === 'ClassDeclaration') out.push({ name: n.id.name, kind: 'var', line: lineOf(n.start) });
    else if (n.type === 'VariableDeclaration') for (const d of n.declarations) { const acc = []; patNames(d.id, acc); acc.forEach(name => out.push({ name, kind: 'var', line: lineOf(n.start) })); }
  }
  return out;
}
/** 页面内联脚本的顶层声明名（与 catalog / app.js 一侧同一个取名函数 scriptTopNames：收解构名与 class 名；⑦ 用）。
 *  ③ 仍用 topLevel()（只收 Identifier 声明）：两页都有的 `const { generateXxx } = window.ModelScriptGen` 是有意共享（由 verify-model-script-gen-single-source.js 管），改用本函数会让 ③ 把它们当成未登记的同名。 */
function inlineTopNames(html) {
  const out = [];
  for (const sc of inlineScripts(html)) for (const d of scriptTopNames(sc)) out.push(d.name);
  return out;
}
/** src 规范化成同源 URL pathname（去 ?v= / 相对 / 绝对 / ./ 写法的差异）；外部 origin（含 //host 协议相对写法）或解析不了 → null（codex 33-R H：只认同源规范路径） */
function srcLocalPath(src) { try { const u = new URL(src, 'http://local/'); return u.origin === 'http://local' ? u.pathname : null; } catch (_) { return null; } }
/** 规范引用：同源且 pathname 恰为 /assets/js/model-catalog.js（硬门：不按文件名后缀放行） */
const isCatalogSrc = (src) => !!src && srcLocalPath(src) === '/' + CATALOG;
/** #77 C4b：核心与 normalize 的规范引用（同源 pathname 硬门，口径同 catalog） */
const CORE_JS = 'assets/js/model-catalog-core.js';
const KIT_JS = 'assets/js/model-detail-normalize.js';
const isCoreSrc = (src) => !!src && srcLocalPath(src) === '/' + CORE_JS;
const isKitSrc = (src) => !!src && srcLocalPath(src) === '/' + KIT_JS;
/** 任意形式引用到名为 model-catalog-core.js 的脚本（外部主机 / 别的目录也算） */
const mentionsCore = (src) => !!src && /(^|[\/\\])model-catalog-core\.js([?#]|$)/i.test(String(src).trim());
/** 任意形式引用到名为 model-catalog.js 的脚本（外部主机 / 别的目录也算）：目录页上出现非规范引用即判红，配置台上出现任何一个即判红 */
const mentionsCatalog = (src) => !!src && /(^|[\/\\])model-catalog\.js([?#]|$)/i.test(String(src).trim());
const isAppSrc = (src) => !!src && srcLocalPath(src) === '/' + APP_JS;
/** html 里按出现顺序的 <script> 标签（先剥掉 HTML 注释）：[{ attrs, src, inline }] */
function scriptTags(html) {
  const out = []; const re = /<!--[\s\S]*?-->|<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi; let m;
  while ((m = re.exec(html))) {
    if (m[0].startsWith('<!--')) continue;
    const attrs = m[1] || ''; const sm = /\ssrc\s*=\s*"([^"]*)"/.exec(attrs);
    out.push({ attrs, src: sm ? sm[1] : null, inline: !sm });
  }
  return out;
}

/** 返回问题列表（空 = 全绿）。ctx = { cat: model-catalog.js 源码, app: app.js 源码 } */
function check(htmlA, htmlB, ctx) {
  const probs = [];
  const A = topLevel(htmlA), B = topLevel(htmlB);
  // 目录页「页面代码」= 内联 + catalog：catalog 的顶层名并进 A（③ 用），顶层函数同名检查（⑤）也跨两者
  const catNames = scriptTopNames(ctx.cat);
  for (const d of catNames) { if (d.kind === 'function') { const a = A.funcs.get(d.name) || []; a.push('/*catalog*/'); A.funcs.set(d.name, a); } else A.vars.add(d.name); }
  for (const name of SAME) {
    const a = A.funcs.get(name) || [], b = B.funcs.get(name) || [];
    if (a.length !== 1) probs.push(`① ${PAGE_A} 里 ${name} 应恰好定义 1 次，实得 ${a.length}`);
    if (b.length !== 1) probs.push(`① ${PAGE_B} 里 ${name} 应恰好定义 1 次，实得 ${b.length}`);
    if (a.length === 1 && b.length === 1) {
      const x = toks(a[0]), y = toks(b[0]);
      if (x.length !== y.length || x.some((t, k) => t !== y[k])) {
        let i = 0; while (i < x.length && i < y.length && x[i] === y[i]) i++;
        const show = (arr) => arr.slice(Math.max(0, i - 3), i + 4).map(t => t.replace('\u0001', ':')).join(' ');
        probs.push(`② ${name} 两页 token 序列不一致（第 ${i} 个 token 起不同：${PAGE_A}「${show(x)}」vs ${PAGE_B}「${show(y)}」）`);
      }
    }
  }
  // ⑤ 每页顶层函数声明不得同名重复（后一个静默覆盖前一个，前一个就是死代码或行为分叉）
  for (const [page, html] of [[PAGE_A, htmlA], [PAGE_B, htmlB]]) {
    const seen = new Map();
    for (const d of topLevelFunctionDecls(html)) {
      if (seen.has(d.name)) probs.push(`⑤ ${page} 顶层函数 ${d.name} 重复声明（第 ${seen.get(d.name)} 行与第 ${d.line} 行）`);
      else seen.set(d.name, d.line);
    }
  }
  { const seen = new Map();
    for (const d of catNames) if (d.kind === 'function') { if (seen.has(d.name)) probs.push(`⑤ ${CATALOG} 顶层函数 ${d.name} 重复声明（第 ${seen.get(d.name)} 行与第 ${d.line} 行）`); else seen.set(d.name, d.line); } }
  // ⑥ 标签存在 / 位置 / 属性
  { const tags = scriptTags(htmlA);
    const idx = tags.map((t, i) => (isCatalogSrc(t.src) ? i : -1)).filter(i => i >= 0);
    const offCanon = tags.filter(t => mentionsCatalog(t.src) && !isCatalogSrc(t.src));
    if (offCanon.length) probs.push(`⑥ ${PAGE_A} 引用 model-catalog.js 必须是同源规范路径 /${CATALOG}（实得非规范引用：${offCanon.map(t => t.src).join('、')}）`);
    if (idx.length !== 1) probs.push(`⑥ ${PAGE_A} 应恰好一次、未被注释地引用 ${CATALOG}，实得 ${idx.length}`);
    else {
      const t = tags[idx[0]];
      if (t.attrs.replace(/\ssrc\s*=\s*"[^"]*"/, '').trim() !== '') probs.push(`⑥ ${CATALOG} 的 <script> 标签除 src 外不得带属性（实得「${t.attrs.trim()}」）：defer / async / type 会改变求值时机`);
      const iApp = tags.findIndex(x => isAppSrc(x.src));
      if (iApp < 0 || iApp > idx[0]) probs.push(`⑥ ${CATALOG} 必须在 ${APP_JS} 标签之后`);
      const iInline = tags.findIndex(x => x.inline);
      if (iInline >= 0 && iInline < idx[0]) probs.push(`⑥ ${CATALOG} 必须在第一个内联 <script> 之前（当前第 ${iInline + 1} 个标签是内联脚本，catalog 是第 ${idx[0] + 1} 个）`);
    }
    if (scriptTags(htmlB).some(x => isCatalogSrc(x.src) || mentionsCatalog(x.src))) probs.push(`⑥ ${PAGE_B} 不得引用 ${CATALOG}（任何来源与目录都不行；配置台页上 typeof currentPage 必须不存在）`);
  }
  // ⑧ #77 C4b：核心标签——恰一次、无属性、同源规范路径；顺序 model-detail-normalize.js → 核心 → model-catalog.js；配置台不得引用
  { const tags = scriptTags(htmlA);
    const idx = tags.map((t, i) => (isCoreSrc(t.src) ? i : -1)).filter(i => i >= 0);
    const offCanon = tags.filter(t => mentionsCore(t.src) && !isCoreSrc(t.src));
    if (offCanon.length) probs.push(`⑧ ${PAGE_A} 引用 model-catalog-core.js 必须是同源规范路径 /${CORE_JS}（实得非规范引用：${offCanon.map(t => t.src).join('、')}）`);
    if (idx.length !== 1) probs.push(`⑧ ${PAGE_A} 应恰好一次、未被注释地引用 ${CORE_JS}，实得 ${idx.length}`);
    else {
      const t = tags[idx[0]];
      if (t.attrs.replace(/\ssrc\s*=\s*"[^"]*"/, '').trim() !== '') probs.push(`⑧ ${CORE_JS} 的 <script> 标签除 src 外不得带属性（实得「${t.attrs.trim()}」）：defer / async / type 会改变求值时机`);
      const iKit = tags.findIndex(x => isKitSrc(x.src));
      const iCat = tags.findIndex(x => isCatalogSrc(x.src));
      if (iKit < 0 || iKit > idx[0]) probs.push(`⑧ ${CORE_JS} 必须在 ${KIT_JS} 标签之后（核心的 upstreamNames 依赖 ModelDetailKit）`);
      if (iCat < 0 || iCat < idx[0]) probs.push(`⑧ ${CORE_JS} 必须在 ${CATALOG} 标签之前（目录代码在调用时取 ModelCatalogCore）`);
    }
    if (scriptTags(htmlB).some(x => isCoreSrc(x.src) || mentionsCore(x.src))) probs.push(`⑧ ${PAGE_B} 不得引用 ${CORE_JS}（配置台不加载目录代码，核心只服务目录页）`);
  }
  // ⑦ catalog 顶层名与（目录页内联 ∪ app.js）不得撞名
  { const inlNames = new Set(inlineTopNames(htmlA));
    const appNames = new Set(scriptTopNames(ctx.app).map(d => d.name));
    for (const d of catNames) {
      if (inlNames.has(d.name)) probs.push(`⑦ ${CATALOG} 第 ${d.line} 行的顶层名 ${d.name} 与 ${PAGE_A} 内联脚本顶层名撞名（let / const 撞名整段 SyntaxError，function 撞名静默覆盖）`);
      if (appNames.has(d.name)) probs.push(`⑦ ${CATALOG} 第 ${d.line} 行的顶层名 ${d.name} 与 ${APP_JS} 顶层名撞名`);
    } }
  const namesA = new Set([...A.funcs.keys(), ...A.vars]), namesB = new Set([...B.funcs.keys(), ...B.vars]);
  for (const n of namesA) if (namesB.has(n) && !SAME.includes(n) && !(n in DIFFERENT_BY_DESIGN)) probs.push(`③ 两页顶层都定义了 ${n}，却没登记为同源（SAME）或有意不同（DIFFERENT_BY_DESIGN）`);
  for (const n of Object.keys(DIFFERENT_BY_DESIGN)) if (!(A.funcs.has(n) && B.funcs.has(n))) probs.push(`③ DIFFERENT_BY_DESIGN 登记的 ${n} 不是两页都有（登记已失效，请清理）`);
  return probs;
}

function selfTest(htmlA, htmlB, ctx0) {
  const base = check(htmlA, htmlB, ctx0);
  if (base.length) { console.log('[self-test] 对照组（未变异）应全绿，实得：\n  ' + base.join('\n  ')); return 1; }
  console.log('[self-test] 对照组（未变异）全绿');
  const fnRange = (html, name) => {
    const s0 = html.indexOf('<script>'); const body = html.slice(s0 + 8, html.indexOf('</script>', s0));
    const ast = acorn.parse(body, { ecmaVersion: 2022, ranges: true, allowAwaitOutsideFunction: true });
    const n = ast.body.find(x => x.type === 'FunctionDeclaration' && x.id.name === name);
    return { a: s0 + 8 + n.start, b: s0 + 8 + n.end };
  };
  const L = (f) => (c) => { const [a, b] = f(c.a, c.b); return { ...c, a, b }; };   // 旧式 (a,b)=>[a,b] 变异的适配
  const muts0 = [
    ['控制：只改函数内部空白 / 缩进，仍应全绿（空白不算差异）', (a, b) => { const r = fnRange(b, 'copyToClipboard'); return [a, b.slice(0, r.a) + b.slice(r.a, r.b).replace(/\n/g, '\n  ') + b.slice(r.b)]; }, true],
    ['配置台页里 copyToClipboard 改一个字符', (a, b) => { const r = fnRange(b, 'copyToClipboard'); return [a, b.slice(0, r.a) + b.slice(r.a, r.b).replace('document.execCommand', 'document.execCommandX') + b.slice(r.b)]; }],
    ['目录页里 loadRegDomainOptions 改一个字符', (a, b) => { const r = fnRange(a, 'loadRegDomainOptions'); return [a.slice(0, r.a) + a.slice(r.a, r.b).replace("'deprecated'", "'deprecatedX'") + a.slice(r.b), b]; }],
    ['配置台页里 highlightSQL 改成 async（函数头一个词的差异）', (a, b) => { const r = fnRange(b, 'highlightSQL'); return [a, b.slice(0, r.a) + 'async ' + b.slice(r.a, r.b) + b.slice(r.b)]; }],
    ['配置台页删掉 refreshHighlight', (a, b) => { const r = fnRange(b, 'refreshHighlight'); return [a, b.slice(0, r.a) + b.slice(r.b)]; }],
    ['配置台 highlightSQL 里某字符串字面量删掉一个空格（旧「去全部空白」口径会漏）', (a, b) => { const r = fnRange(b, 'highlightSQL'); const body = b.slice(r.a, r.b); const from = 'style="color:#6b7280; font-style:italic;"'; if (!body.includes(from)) throw new Error('变异锚点不存在'); return [a, b.slice(0, r.a) + body.replace(from, 'style="color:#6b7280;font-style:italic;"') + b.slice(r.b)]; }],
    ['控制：函数内加注释 / 换行，仍应全绿（注释不算差异）', (a, b) => { const r = fnRange(b, 'copyToClipboard'); const body = b.slice(r.a, r.b); const i = body.indexOf('{') + 1; return [a, b.slice(0, r.a) + body.slice(0, i) + ' /* 注释 */\n' + body.slice(i) + b.slice(r.b)]; }, true],
    ['目录页再声明一次 openWorkbench（⑤ 同页同名重复）', (a, b) => { const r = fnRange(a, 'openWorkbench'); return [a.slice(0, r.b) + '\n' + a.slice(r.a, r.b) + a.slice(r.b), b]; }],
    ['配置台再声明一次 openDimEditModal（⑤ 同页同名重复）', (a, b) => { const r = fnRange(b, 'openDimEditModal'); return [a, b.slice(0, r.b) + '\n' + b.slice(r.a, r.b) + b.slice(r.b)]; }],
    ['目录页多定义一次 attachLineNumbers（重复）', (a, b) => { const r = fnRange(a, 'attachLineNumbers'); return [a.slice(0, r.b) + '\n' + a.slice(r.a, r.b) + a.slice(r.b), b]; }],
    ['两页新增一个同名未登记函数 fooShared', (a, b) => { const add = '\nfunction fooShared() { return 1; }\n'; return [a.replace('<script>', '<script>' + add), b.replace('<script>', '<script>' + add)]; }],
  ];
  const muts = muts0.map(([label, f, g]) => [label, L(f), g, null]);
  const TAG = /[ \t]*<script src="assets\/js\/model-catalog\.js[^"]*"><\/script>\r?\n?/;
  const CORE_TAG = /[ \t]*<script src="assets\/js\/model-catalog-core\.js[^"]*"><\/script>\r?\n?/;
  // [label, ctx => 变异后的 ctx, expectGreen, 期望判红的判据前缀]
  muts.push(
    ['C4a-a WB 的 userCanEditModel 把 String() 比较改回严格相等', (c) => { const k = 'String(model.created_by_id) === String(currentUser.id)'; if (!c.b.includes(k)) throw new Error('变异锚点不存在'); return { ...c, b: c.b.replace(k, 'model.created_by_id === currentUser.id') }; }, false, '②'],
    ['C4a-b MC 内联里重新声明 let currentPage = 1;', (c) => ({ ...c, a: c.a.replace('<script>', '<script>\nlet currentPage = 1;\n') }), false, '⑦'],
    ['C4a-c MC 内联里重新声明 function goToPage(page) {}', (c) => ({ ...c, a: c.a.replace('<script>', '<script>\nfunction goToPage(page) {}\n') }), false, '⑦'],
    ['C4a-d 删掉 MC 的 catalog <script src>', (c) => { if (!TAG.test(c.a)) throw new Error('变异锚点不存在'); return { ...c, a: c.a.replace(TAG, '') }; }, false, '⑥'],
    ['C4a-e catalog 标签加 defer', (c) => { const k = '<script src="assets/js/model-catalog.js'; if (!c.a.includes(k)) throw new Error('变异锚点不存在'); return { ...c, a: c.a.replace(k, '<script defer src="assets/js/model-catalog.js') }; }, false, '⑥'],
    ['C4a-f catalog 标签挪到第一个内联 <script> 之后', (c) => { const m = TAG.exec(c.a); if (!m) throw new Error('变异锚点不存在'); const a1 = c.a.replace(TAG, ''); const i0 = a1.indexOf('<script>'); const i1 = a1.indexOf('</script>', i0) + 9; return { ...c, a: a1.slice(0, i1) + '\n' + m[0].trim() + a1.slice(i1) }; }, false, '⑥'],
    ['C4a-g catalog 里新增顶层 let currentUser;（与 app.js 撞名）', (c) => ({ ...c, cat: c.cat + '\nlet currentUser;\n' }), false, '⑦'],
    ['C4a-h 配置台页也引用 catalog', (c) => ({ ...c, b: c.b.replace('<script>', '<script src="assets/js/model-catalog.js?v=x"></script>\n<script>') }), false, '⑥'],
    ['C4a-i catalog 里同名函数重复声明', (c) => ({ ...c, cat: c.cat + '\nfunction goToPage(page) {}\n' }), false, '⑤'],
    ['C4a-j MC 里把 userCanEditModel 改一个字符（与 WB 分叉）', (c) => { const i = c.a.indexOf('function userCanEditModel'); return { ...c, a: c.a.slice(0, i) + c.a.slice(i).replace("role === 'admin'", "role === 'adminX'") }; }, false, '②'],
    ['C4a-k catalog 里新增 const { generateODSDDL } = window.ModelScriptGen;（内联已有同名解构）', (c) => ({ ...c, cat: c.cat + '\nconst { generateODSDDL } = window.ModelScriptGen;\n' }), false, '⑦'],
    ['C4a-l catalog 与内联各加同名 class Foo {}', (c) => ({ ...c, a: c.a.replace('<script>', '<script>\nclass Foo {}\n'), cat: c.cat + '\nclass Foo {}\n' }), false, '⑦'],
    ['C4a-m 配置台用绝对路径 /assets/js/model-catalog.js 引用 catalog', (c) => ({ ...c, b: c.b.replace('<script>', '<script src="/assets/js/model-catalog.js"></script>\n<script>') }), false, '⑥'],
    ['C4a-n catalog 标签移到 app.js 标签之前', (c) => { const m = TAG.exec(c.a); if (!m) throw new Error('变异锚点不存在'); const a1 = c.a.replace(TAG, ''); const i = a1.indexOf('<script src="assets/js/app.js'); if (i < 0) throw new Error('变异锚点不存在：app.js'); return { ...c, a: a1.slice(0, i) + m[0].trim() + '\n    ' + a1.slice(i) }; }, false, '⑥'],
    ['C4b-a 删掉 MC 的核心 <script src>', (c) => { if (!CORE_TAG.test(c.a)) throw new Error('变异锚点不存在'); return { ...c, a: c.a.replace(CORE_TAG, '') }; }, false, '⑧'],
    ['C4b-b 核心标签挪到 model-catalog.js 标签之后', (c) => { const m = CORE_TAG.exec(c.a); if (!m) throw new Error('变异锚点不存在'); const a1 = c.a.replace(CORE_TAG, ''); const t = TAG.exec(a1); if (!t) throw new Error('变异锚点不存在：catalog 标签'); const at = a1.indexOf(t[0]) + t[0].length; return { ...c, a: a1.slice(0, at) + '    ' + m[0].trim() + '\n' + a1.slice(at) }; }, false, '⑧'],
    ['C4b-c 核心标签挪到 model-detail-normalize.js 标签之前', (c) => { const m = CORE_TAG.exec(c.a); if (!m) throw new Error('变异锚点不存在'); const a1 = c.a.replace(CORE_TAG, ''); const i = a1.indexOf('<script src="assets/js/model-detail-normalize.js'); if (i < 0) throw new Error('变异锚点不存在：normalize'); return { ...c, a: a1.slice(0, i) + m[0].trim() + '\n    ' + a1.slice(i) }; }, false, '⑧'],
    ['C4b-d 核心标签加 defer', (c) => { const k = '<script src="assets/js/model-catalog-core.js'; if (!c.a.includes(k)) throw new Error('变异锚点不存在'); return { ...c, a: c.a.replace(k, '<script defer src="assets/js/model-catalog-core.js') }; }, false, '⑧'],
    ['C4b-e 配置台引用核心', (c) => ({ ...c, b: c.b.replace('<script>', '<script src="assets/js/model-catalog-core.js?v=x"></script>\n<script>') }), false, '⑧'],
    ['C4b-f 核心标签改指外部主机', (c) => { const k = 'src="assets/js/model-catalog-core.js'; if (!c.a.includes(k)) throw new Error('变异锚点不存在'); return { ...c, a: c.a.replace(k, 'src="https://cdn.example.com/assets/js/model-catalog-core.js') }; }, false, '⑧'],
    ['C4b-g 核心标签重复引用一次', (c) => { const m = CORE_TAG.exec(c.a); if (!m) throw new Error('变异锚点不存在'); return { ...c, a: c.a.replace(m[0], m[0] + m[0]) }; }, false, '⑧'],
    ['控制：MC 的核心标签把 ?v=auto 换成别的值（W4 后页面一律 ?v=auto；改 ?v= 值不影响共享函数判定），仍应全绿', (c) => { const re = /(model-catalog-core\.js\?v=)[^"]+/; if (!re.test(c.a)) throw new Error('变异锚点不存在'); const a = c.a.replace(re, '$1other'); if (a === c.a) throw new Error('变异未生效（替换前后相同）'); return { ...c, a }; }, true, null],
    ['控制：catalog 里某函数内部加注释 / 空白，仍应全绿', (c) => { const k = 'function goToPage(page) {'; if (!c.cat.includes(k)) throw new Error('变异锚点不存在'); return { ...c, cat: c.cat.replace(k, k + ' /* 注释 */\n\n   ') }; }, true, null],
    ['控制：MC 的 catalog 标签把 ?v=auto 换成别的值，仍应全绿', (c) => { const re = /(model-catalog\.js\?v=)[^"]+/; if (!re.test(c.a)) throw new Error('变异锚点不存在'); const a = c.a.replace(re, '$1other'); if (a === c.a) throw new Error('变异未生效（替换前后相同）'); return { ...c, a }; }, true, null],
    ['C4a-o（33-R H）MC 的 catalog 标签改指外部主机 https://cdn.example.com/assets/js/model-catalog.js', (c) => { const k = 'src="assets/js/model-catalog.js'; if (!c.a.includes(k)) throw new Error('变异锚点不存在'); return { ...c, a: c.a.replace(k, 'src="https://cdn.example.com/assets/js/model-catalog.js') }; }, false, '⑥'],
    ['C4a-p（33-R H）MC 的 catalog 标签改指别的目录 assets/js/legacy/model-catalog.js', (c) => { const k = 'src="assets/js/model-catalog.js'; if (!c.a.includes(k)) throw new Error('变异锚点不存在'); return { ...c, a: c.a.replace(k, 'src="assets/js/legacy/model-catalog.js') }; }, false, '⑥'],
    ['C4a-q（33-R H）MC 的 app.js 标签改指外部主机（catalog 不变）', (c) => { const k = 'src="assets/js/app.js'; if (!c.a.includes(k)) throw new Error('变异锚点不存在'); return { ...c, a: c.a.replace(k, 'src="//cdn.example.com/assets/js/app.js') }; }, false, '⑥'],
    ['C4a-r（33-R H）配置台用外部主机引用 model-catalog.js', (c) => ({ ...c, b: c.b.replace('<script>', '<script src="https://cdn.example.com/x/model-catalog.js"></script>\n<script>') }), false, '⑥'],
    ['控制：MC 的 catalog 标签改成 ./assets/js/model-catalog.js（同源规范路径的等价写法），仍应全绿', (c) => { const k = 'src="assets/js/model-catalog.js'; if (!c.a.includes(k)) throw new Error('变异锚点不存在'); return { ...c, a: c.a.replace(k, 'src="./assets/js/model-catalog.js') }; }, true, null],
  );
  let bad = 0;
  for (const [label, fn, expectGreen, crit] of muts) {
    let probs;
    try { const c = fn({ a: htmlA, b: htmlB, cat: ctx0.cat, app: ctx0.app }); probs = check(c.a, c.b, c); } catch (e) { console.log(`[self-test] FAIL ${label}：构造变异失败（${e.message}）`); bad++; continue; }
    if (expectGreen) { if (probs.length) { console.log(`[self-test] FAIL ${label}：不应判红，实得 ${probs[0]}`); bad++; } else console.log(`[self-test] OK   ${label}：全绿`); continue; }
    if (!probs.length) { console.log(`[self-test] FAIL ${label}：变异后仍全绿（判别力不足）`); bad++; }
    else if (crit && !probs.some(p => p.startsWith(crit))) { console.log(`[self-test] FAIL ${label}：判红了但不是预期判据 ${crit}（实得 ${probs[0].slice(0, 100)}）`); bad++; }
    else console.log(`[self-test] OK   ${label}：判红（${probs[0].slice(0, 120)}）`);
  }
  return bad ? 1 : 0;
}

function main() {
  const a = fs.readFileSync(path.join(PUB, PAGE_A), 'utf8'), b = fs.readFileSync(path.join(PUB, PAGE_B), 'utf8');
  const ctx = { cat: fs.readFileSync(path.join(PUB, CATALOG), 'utf8'), app: fs.readFileSync(path.join(PUB, APP_JS), 'utf8') };
  if (process.argv.includes('--self-test')) return selfTest(a, b, ctx);
  const probs = check(a, b, ctx);
  probs.forEach(p => console.log('[FAIL] ' + p));
  console.log(`[shared-functions] ${PAGE_A} vs ${PAGE_B}：同源函数 ${SAME.length} 个、有意不同 ${Object.keys(DIFFERENT_BY_DESIGN).length} 个；问题 ${probs.length}`);
  return probs.length ? 1 : 0;
}
process.exit(main());
