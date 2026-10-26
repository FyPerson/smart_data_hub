#!/usr/bin/env node
/**
 * #77 C3a：模型中心脚本生成器「单一源」静态守卫（纯 node，不起服务、不连库）。
 *
 * 背景：脚本生成器（DIM / DWD / ODS 的 DDL、ETL、FDL、质量规则、同步脚本）原先内联在 public/Model_Center.html，
 *   C3a 抽到共享库 public/assets/js/model-script-gen.js（window.ModelScriptGen）。C3b 起配置台迁到新页，新页也引同一份库。
 *   本守卫钉死「页面只消费、不再自己定义，且用到的名字都已解构」，防止日后在页面里悄悄长出第二份生成器，
 *   或改解构行时漏写一个名字（运行时 ReferenceError，golden 只测库、测不到）。
 *
 * 解析方式：acorn 解析页面每个内联脚本 + eslint-scope 做作用域分析（仓库先例：verify-badge-alias.js 同款；eslint-scope 是 eslint 的传递依赖，
 *   package.json 只显式列了 acorn / eslint 两个 devDependencies）。不再用正则剥注释（字符串里含 `/*` 会让正则失明），也不用正则找定义。
 *
 * 判据（对 Model_Center.html）：
 *   ① 引用了 assets/js/model-script-gen.js（先剔除 HTML 注释 <!-- -->，被注释掉的 <script src> 不算），查询串恰为 ?v=auto（W4 起不再与库内 KIT_VERSION 同步），
 *      且位于解构该库的内联脚本之前；
 *   ② 页面任何内联脚本里都不得再定义库导出名（任意作用域的 function 声明 / const|let|var / 隐式全局赋值 / window.名 = …）；
 *      唯一放行：形如 `const { 名, 名 } = window.ModelScriptGen;` 的那一条解构声明（按语句里的名字精确放行）；
 *   ③ 页面解构的每个名字必须在库导出里；解构语句恰好一条；
 *   ④ 全局作用域里「未声明的引用」（eslint-scope globalScope.through）凡是库导出名（或 C3a 已删的三个死代码函数名）、
 *      却不在页面解构里的，判红（给出名字与内联脚本序号）——页面用了库函数但没解构，运行时才会 ReferenceError。
 *   另：库导出的每个名字（KIT_VERSION 除外）必须是函数。
 *   缓存串由服务端按文件内容自动注入（#106 W4）；本地引用全为 ?v=auto 由 verify-shared-css-cache-bust.js 的 S1 在全部页面上守。
 *
 * 用法：
 *   node scripts/verify-model-script-gen-single-source.js              校验真实页面
 *   node scripts/verify-model-script-gen-single-source.js --self-test  内存里造诚实变异（残留生成器定义 / 去掉 script 引用 / 解构库里不存在的名字 /
 *        页面调用未解构的库函数 / 从解构里删掉页面仍在调用的名字 / 库引用被 HTML 注释掉 / 字符串含 `/*` 后接生成器定义 / 隐式全局赋值），各自必须判红
 *   --page <文件> 可指定另一个页面（C3b 起新配置台页可复用本守卫的 check 函数）
 *
 * 威胁模型：只防「诚实实现写错 / 忘了删 / 忘了解构」，不防故意绕过（eval / new Function / 拼接标识符 / 对象方法简写 `{ 名() {} }`——后者 L3 登记为残余）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const eslintScope = require('eslint-scope');

const ROOT = path.resolve(__dirname, '..');
const PAGE = path.join(ROOT, 'public', 'Model_Center.html');
const LIB = path.join(ROOT, 'public', 'assets', 'js', 'model-script-gen.js');
const LIB_REL = 'assets/js/model-script-gen.js';
// C3a 已从页面删除的三个无调用方死代码函数：页面若又去调用它们，同样是运行时 ReferenceError
const DEAD_NAMES = ['generateDimETLFromConfig', 'generateSCD1ETL', 'generateSCD2ETL'];
// 29T M1：KIT_VERSION 不是函数导出，但页面若直接引用它同样要先解构（允许显式解构）；纳入 ④ 的检查集合
const KIT_NAME = 'KIT_VERSION';
// 默认检查的页面清单（C3b 起加入 Model_Workbench.html；check() 本身按单个页面检查）
const PAGES = [PAGE, path.join(ROOT, 'public', 'Model_Workbench.html')];
const ECMA = 2022;

function readLibExports() {
  const api = require(LIB);
  const names = Object.keys(api).filter(k => k !== 'KIT_VERSION');
  // kit 字段：W4 起已无人读取（原 ① 的“串尾 = KIT_VERSION”判据已换成“恰为 ?v=auto”），保留仅作信息，不改逻辑
  return { names, kit: api.KIT_VERSION, bad: names.filter(n => typeof api[n] !== 'function') };
}

/**
 * 顺序扫描页面：HTML 注释整体跳过；<script> 元素分为外链（src）与内联。
 * 用一条交替正则按出现顺序匹配，内联脚本正文里的 `<!--` 字面量不会被当成 HTML 注释（脚本元素先出现、整体被消费）。
 */
function scanScripts(html) {
  const out = [];
  const re = /<!--[\s\S]*?-->|<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (m[0].startsWith('<!--')) continue;
    const attrs = m[1] || '';
    const type = (/\stype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs) || [])[1];
    if (type && !/javascript|ecmascript/i.test(type)) continue;   // json / importmap / template 等不是 JS
    const srcM = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const src = srcM ? (srcM[1] !== undefined ? srcM[1] : srcM[2] !== undefined ? srcM[2] : srcM[3]) : null;
    out.push({ src, text: src ? '' : m[2], index: m.index, bodyStart: m.index + m[0].indexOf('>') + 1 });
  }
  return out;
}

/** 在一段脚本的 AST 里找「解构 window.ModelScriptGen 的声明」：返回 { names, decl }[]（decl 为 VariableDeclarator 节点） */
function findDestructures(ast) {
  const found = [];
  // 29T H1：顶层 = Program 体的直接语句（VariableDeclaration）里的声明符
  const topDeclarators = new Set();
  ast.body.forEach(st => { if (st.type === 'VariableDeclaration') st.declarations.forEach(d => topDeclarators.add(d)); });
  (function walk(n) {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'VariableDeclarator' && n.id && n.id.type === 'ObjectPattern' && n.init && n.init.type === 'MemberExpression' &&
        !n.init.computed && n.init.object.type === 'Identifier' && n.init.object.name === 'window' &&
        n.init.property.type === 'Identifier' && n.init.property.name === 'ModelScriptGen') {
      const names = n.id.properties.map(p => (p.type === 'Property' && !p.computed && p.key.type === 'Identifier' && p.value.type === 'Identifier' && p.key.name === p.value.name) ? p.key.name : null);
      found.push({ names: names.filter(Boolean), irregular: names.some(x => x === null), decl: n, topLevel: topDeclarators.has(n) });
    }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === 'string') walk(v);
    }
  })(ast);
  return found;
}

/** 返回问题列表（空 = 全绿） */
function check(html, lib) {
  const probs = [];
  if (lib.bad.length) probs.push(`库导出里这些名字不是函数：${lib.bad.join(', ')}`);
  const scripts = scanScripts(html);
  const inline = scripts.filter(s => s.src === null);
  // ① script 引用（HTML 注释已被 scanScripts 跳过）+ 缓存串
  const libTag = scripts.find(s => s.src !== null && s.src.split('?')[0] === LIB_REL);
  if (!libTag) probs.push(`① 页面没有引用 ${LIB_REL}（被 HTML 注释掉的不算）`);
  else {
    const q = libTag.src.includes('?') ? libTag.src.slice(libTag.src.indexOf('?')) : '';
    // #106 W4 / S6b：缓存串不再与库内 KIT_VERSION 同步（引用一律 ?v=auto，由服务端按文件内容注入指纹）；KIT_VERSION 只是库的版本标识（页面没有运行时比对）
    if (q !== '?v=auto') probs.push(`① 引用的查询串 ${JSON.stringify(q)} 不是 ?v=auto`);
  }
  // 解析每个内联脚本
  const analyzed = [];
  inline.forEach((s, i) => {
    let ast, sm;
    try {
      ast = acorn.parse(s.text, { ecmaVersion: ECMA, sourceType: 'script', ranges: true, locations: true });
      sm = eslintScope.analyze(ast, { ecmaVersion: ECMA, sourceType: 'script', ignoreEval: true });
    } catch (e) { probs.push(`内联脚本 #${i + 1} 无法解析（${e.message}）`); return; }
    analyzed.push({ i, s, ast, sm, destructs: findDestructures(ast) });
  });
  const destructuredNames = [];
  let nDestruct = 0, firstDestructScript = null;
  for (const a of analyzed) for (const d of a.destructs) {
    nDestruct++; if (!firstDestructScript) firstDestructScript = a.s;
    if (d.irregular) probs.push(`③ 内联脚本 #${a.i + 1} 的解构含非「同名简写」成员（改名 / 默认值 / rest 都不允许）`);
    if (!d.topLevel) probs.push(`③ 内联脚本 #${a.i + 1} 第 ${d.decl.loc.start.line} 行的解构不在脚本顶层（嵌套作用域里的解构不会绑定顶层引用）`);
    d.names.forEach(n => destructuredNames.push(n));
  }
  if (nDestruct !== 1) probs.push(`③ 解构 window.ModelScriptGen 的语句应恰好 1 条且位于脚本顶层，实得 ${nDestruct}`);
  if (libTag && firstDestructScript && libTag.index > firstDestructScript.index) probs.push('① script 引用位于解构语句所在的内联脚本之后');
  // ③ 解构名 ⊆ 库导出
  for (const n of destructuredNames) if (!lib.names.includes(n) && n !== KIT_NAME) probs.push(`③ 页面解构了库里不存在的名字：${n}`);
  const libSet = new Set([...lib.names, KIT_NAME]);   // ② 的集合也含 KIT_VERSION（29T-R：与 ④ 一致）
  const refSet = new Set([...lib.names, KIT_NAME, ...DEAD_NAMES]);   // ④ 检查的名字集合
  for (const a of analyzed) {
    // 放行的绑定 = 解构声明里的那些标识符节点（按节点范围精确放行，不按名字整体放行）
    const allowedIds = new Set();
    const allowedTopIds = new Set();   // 只含顶层解构声明里的标识符节点（④ 的绑定判断用）
    for (const d of a.destructs) d.decl.id.properties.forEach(p => { if (p.value) { const k = p.value.range[0] + ':' + p.value.range[1]; allowedIds.add(k); if (d.topLevel) allowedTopIds.add(k); } });
    // ② 任意作用域里的定义
    for (const sc of a.sm.scopes) for (const v of sc.variables) {
      if (!libSet.has(v.name)) continue;
      for (const d of v.defs) {
        if (d.type === 'Parameter' || d.type === 'ImplicitGlobalVariable') continue;
        if (d.type === 'Variable' && allowedIds.has(d.name.range[0] + ':' + d.name.range[1])) continue;
        probs.push(`② 内联脚本 #${a.i + 1} 里出现库导出名 ${v.name} 的定义（${d.type === 'FunctionName' ? 'function 声明 / 表达式名' : d.type === 'Variable' ? 'const/let/var 声明' : d.type}，第 ${d.name.loc.start.line} 行）`);
      }
    }
    // ② 隐式全局写入 / window.名 = …
    for (const r of a.sm.globalScope.through) {
      if (libSet.has(r.identifier.name) && r.isWrite()) probs.push(`② 内联脚本 #${a.i + 1} 里对库导出名 ${r.identifier.name} 做了隐式全局赋值（第 ${r.identifier.loc.start.line} 行）`);
    }
    (function walk(n) {
      if (!n || typeof n.type !== 'string') return;
      if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && !n.left.computed && n.left.object.type === 'Identifier' && n.left.object.name === 'window' &&
          n.left.property.type === 'Identifier' && libSet.has(n.left.property.name)) probs.push(`② 内联脚本 #${a.i + 1} 里 window.${n.left.property.name} = …（挂到 window，第 ${n.loc.start.line} 行）`);
      for (const k of Object.keys(n)) { const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === 'string') walk(v); }
    })(a.ast);
    // ④ 全局未声明引用里的库导出名 / KIT_VERSION / 死代码名，必须由「顶层解构声明」绑定（29T H1：按作用域绑定判断，不按全页名字集合）
    const topBound = new Set();
    for (const [name, v] of a.sm.globalScope.set) {
      if (v.defs.some(d => d.type === 'Variable' && allowedTopIds.has(d.name.range[0] + ':' + d.name.range[1]))) topBound.add(name);
    }
    const seen = new Set();
    for (const r of a.sm.globalScope.through) {
      const n = r.identifier.name;
      if (refSet.has(n) && !topBound.has(n) && !seen.has(n)) {
        seen.add(n);
        probs.push(`④ 内联脚本 #${a.i + 1} 引用了库导出名 ${n}（第 ${r.identifier.loc.start.line} 行）但它不在页面解构里${DEAD_NAMES.includes(n) ? '（C3a 已删除的死代码函数）' : ''}——运行时 ReferenceError`);
      }
    }
  }
  return probs;
}

function selfTest(html, lib) {
  const base = check(html, lib);
  if (base.length) { console.log('[self-test] 对照组（未变异）应全绿，实得：\n  ' + base.join('\n  ')); return 1; }
  console.log('[self-test] 对照组（未变异）全绿');
  const some = lib.names.find(n => /^build/.test(n)) || lib.names[0];
  const destructRe = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*window\.ModelScriptGen\s*;/;
  const afterDestruct = (h, code) => {
    const m = destructRe.exec(h);
    if (!m) throw new Error('找不到解构语句');
    const at = m.index + m[0].length;
    return h.slice(0, at) + '\n        ' + code + '\n' + h.slice(at);
  };
  const libTagRe = new RegExp('[ \\t]*<script[^>]*\\ssrc\\s*=\\s*"' + LIB_REL.replace(/[./]/g, '\\$&') + '[^"]*"[^>]*></script>\\r?\\n?', 'i');
  // 每页的解构清单不同（目录页 13 个、配置台 6 个）：「漏解构」类变异取该页解构里确有、且页面仍在调用的名字
  const target = ['generateSyncScript', 'generateFdlNodeScript'].find(n => new RegExp('\\b' + n + '\\b').test(destructRe.exec(html)[1]));
  const muts = [
    ['页面残留一个生成器定义', (h) => afterDestruct(h, `function ${some}(a, b) { return ''; }`)],
    ['去掉 script 引用', (h) => { if (!libTagRe.test(h)) throw new Error('找不到 script 引用'); return h.replace(libTagRe, ''); }],
    ['解构了库里不存在的名字', (h) => {
      const m = destructRe.exec(h); if (!m) throw new Error('找不到解构语句');
      return h.replace(destructRe, (mm, list) => mm.replace('{' + list + '}', '{' + list.replace(/\s+$/, '') + ', noSuchGenerator }'));
    }],
    ['页面新增调用一个未解构的库函数（normalizeDataType）', (h) => {
      if (/\bnormalizeDataType\b/.test(destructRe.exec(h)[1])) throw new Error('normalizeDataType 已在解构里，换个名字');
      return afterDestruct(h, "void normalizeDataType('varchar(10)', 'x');");
    }],
    [`从解构里删掉页面仍在调用的名字（${target}）`, (h) => {
      const m = destructRe.exec(h); if (!m || !new RegExp('\\b' + target + '\\b').test(m[1])) throw new Error('解构里没有 ' + target);
      return h.replace(destructRe, (mm, list) => mm.replace('{' + list + '}', '{' + list.split(',').filter(x => x.trim() !== target).join(',') + '}'));
    }],
    [`函数内部解构 ${target}、顶层仍调用它（29T H1）`, (h) => {
      const m = destructRe.exec(h); if (!m || !new RegExp('\\b' + target + '\\b').test(m[1])) throw new Error('解构里没有 ' + target);
      const h2 = h.replace(destructRe, (mm, list) => mm.replace('{' + list + '}', '{' + list.split(',').filter(x => x.trim() !== target).join(',') + '}'));
      return afterDestruct(h2, `function __nestedDestruct() { const { ${target} } = window.ModelScriptGen; return ${target}; }`);
    }, '④'],
    ['出现两条解构（顶层再解构一次，29T H1）', (h) => afterDestruct(h, 'const { buildChangeTag: __bct } = window.ModelScriptGen;'), '③'],
    ['页面在函数内 const 定义 KIT_VERSION（29T-R ②）', (h) => afterDestruct(h, 'function __k() { const KIT_VERSION = 1; return KIT_VERSION; }'), '②'],
    ['页面顶层 function 定义 KIT_VERSION（29T-R ②）', (h) => afterDestruct(h, 'function KIT_VERSION() {}'), '②'],
    ['页面引用 KIT_VERSION 但没解构（29T M1）', (h) => afterDestruct(h, 'void KIT_VERSION;'), '④'],
    // #106 S6b：① 的判据由“串尾 = KIT_VERSION”换成“恰为 ?v=auto”，下面两个变异证明新判据不是恒真（手写串 / 缺查询串都判红）
    ['库引用写回手写缓存串（W4 后须是 ?v=auto）', (h) => {
      if (!libTagRe.test(h)) throw new Error('找不到 script 引用');
      const out = h.replace(libTagRe, (t) => t.replace('?v=auto', '?v=v1.0.0_hand'));
      if (out === h) throw new Error('页面里库引用不是 ?v=auto，变异没改到');
      return out;
    }, '①'],
    ['库引用缺查询串', (h) => {
      if (!libTagRe.test(h)) throw new Error('找不到 script 引用');
      const out = h.replace(libTagRe, (t) => t.replace('?v=auto', ''));
      if (out === h) throw new Error('页面里库引用不是 ?v=auto，变异没改到');
      return out;
    }, '①'],
    ['库引用被 HTML 注释掉', (h) => {
      const m = libTagRe.exec(h); if (!m) throw new Error('找不到 script 引用');
      return h.replace(libTagRe, '<!-- ' + m[0].trim() + ' -->\n');
    }],
    ['字符串里含 /* 与 */，夹着一个生成器定义', (h) => afterDestruct(h, `var __a = '/* x'; function ${some}() {} var __b = 'y */';`)],
    ['隐式全局赋值覆盖库函数（无声明）', (h) => afterDestruct(h, `${some} = function () { return ''; };`)],
  ];
  let bad = 0;
  // 对照：显式解构 KIT_VERSION 并引用它应全绿（M1 允许显式解构）
  try {
    const okHtml = destructRe.exec(html) && html.replace(destructRe, (mm, list) => mm.replace('{' + list + '}', '{' + list.replace(/\s+$/, '') + ', KIT_VERSION }'));
    const okProbs = check(afterDestruct(okHtml, 'void KIT_VERSION;'), lib);
    if (okProbs.length) { console.log('[self-test] FAIL 对照：显式解构 KIT_VERSION 并引用，应全绿，实得 ' + okProbs[0]); bad++; } else console.log('[self-test] OK   对照：显式解构 KIT_VERSION 并引用，全绿');
  } catch (e) { console.log('[self-test] FAIL 对照构造失败：' + e.message); bad++; }
  for (const [label, fn, tag] of muts) {
    let probs;
    try { probs = check(fn(html), lib); } catch (e) { console.log(`[self-test] FAIL ${label}：构造变异失败（${e.stack}）`); bad++; continue; }
    if (tag && probs.length && !probs.some(p => p.startsWith(tag))) { console.log(`[self-test] FAIL ${label}：判红了但没有 ${tag} 类问题（${probs[0]}）`); bad++; continue; }
    if (!probs.length) { console.log(`[self-test] FAIL ${label}：变异后仍全绿（判别力不足）`); bad++; } else console.log(`[self-test] OK   ${label}：判红（${probs[0]}）`);
  }
  return bad ? 1 : 0;
}

function main() {
  const args = process.argv.slice(2);
  const pi = args.indexOf('--page');
  const pageFiles = pi >= 0 ? [path.resolve(args[pi + 1])] : PAGES;   // 按页面逐个检查
  const lib = readLibExports();
  let code = 0;
  for (const pageFile of pageFiles) {
    const html = fs.readFileSync(pageFile, 'utf8');
    if (args.includes('--self-test')) { console.log('[self-test] 页面 ' + path.basename(pageFile)); code |= selfTest(html, lib); continue; }
    const probs = check(html, lib);
    probs.forEach(p => console.log('[FAIL] ' + p));
    console.log(`[single-source] ${path.basename(pageFile)}：库导出 ${lib.names.length} 个名字；问题 ${probs.length}`);
    if (probs.length) code = 1;
  }
  return code;
}
process.exit(main());
