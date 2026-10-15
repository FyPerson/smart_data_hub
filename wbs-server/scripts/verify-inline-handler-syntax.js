// verify-inline-handler-syntax.js — #77 末次合并审 M7（codex 46）防再犯：内联事件处理器的语法静态守卫（收口批 2 起改为硬门）。
//
// 起因：Model_Workbench.html 的伴生表提示链接 onclick 少了一个右括号（`window.location.replace('…&mode=${…}'"`），
// 点击时抛 SyntaxError，整页没有任何一条守卫 / 用例会发现（内联属性不在页面主脚本的解析范围内，主脚本过 acorn 也查不到）。
//
// 做法：扫 public/*.html 与 public/assets/js/*.js 里所有内联事件处理器——静态 HTML 属性，以及 JS 模板串 / 字符串里拼出来的 on…="…" / on…='…'——
// 取属性值——读法 = 运行时浏览器实际拿到的属性值，由「处理器起点（on…= 的位置）所在的 JS 词法 token 类型」决定（复审 48 sol-M）：先对每个 JS 区域
// （.js 全文、.html 的 <script> 块）用 acorn 词法器（acorn.tokenizer，只做词法）取字符串 / 模板串静态段的区间，再按起点所在 token：
//   普通单 / 双引号字符串（str）  按 JS 规则解码转义，不做占位替换——字符串里的 `${` 是字面量，浏览器拿到的就是 `${id}`（`foo(${id})` 无法解析，判红）；
//   普通模板串静态段（tmpl）      按 cooked 值解码转义，模板插值 ${…} 整体替换成占位标识符（__P__）；
//   String.raw 模板串（raw）       按 raw 文本读（不解码，`'\n'` 原样是反斜杠加 n，运行时合法），${…} 换占位符；反斜杠连同后一个字符按原文一起消费（`\${` 在模板里不是插值，不进占位判断；后一个字符恰是属性收尾引号时只消费反斜杠，让引号收尾）；
//   其他标签模板串（tagged）       按 raw 读（同 raw），但**判红**（硬门，48 预筛 D1）：除非在 ALLOW 表里按「文件名 + 处理器原文」登记；当前全树 0 处、ALLOW 里没有 tagged 登记；
//   不在任何字符串 / 模板串静态段里（none，如行尾注释里的举例、插值表达式代码里）  沿用旧读法（解码 + 占位符）；整行是注释的行仍由 isCommentLine 跳过；
//   静态 HTML 属性（static，<script> 块之外）  原文，不解码、不换占位符。
// 最后把 HTML 实体（&quot; &#39; &amp; &lt; &gt;）还原，再用 new Function('event', 代码) 做语法检查。
// 某个 JS 区域词法失败（字符串 / 模板串没收尾等）判红（fail-closed），报出文件、行与原因；全树当前不出现。
//
// 读法只有一种：「占位符当标识符」。判红口径：每个处理器一项断言；属性值找不到收尾引号也判红（unterminated）。
//   —— 收口批 2 之前守卫对每个处理器试 4 种占位替换（标识符 / 空 / `,0` / 混合）× 原样与去转义共 8 种读法，任一能解析就放行，
//      结果「插值旁边缺逗号」（`foo('a' ${b})`、`foo(${a} ${b})`、`foo('a'${b})`）这类运行时必抛 SyntaxError 的写法全判绿。宽松读法已全部删除。
//   —— 处理器跨字符串拼接（`'<a onclick="foo(' + id + ')">'`）：起点所在 token 决定读法，之后逐字符读到收尾引号，不按 token 边界切换（与 47 版读法一致；全树 1038 个处理器新旧两版读出的代码逐个对拍，差异 0）。
//   —— 解码规则（decodeJsEscape）：\n \r \t \b \f \v、\0、\xHH、\uHHHH、\u{…}、行续接（反斜杠加换行）、其余 \c → c；逐字符边解码边读，收尾引号按「解码后的字符」判
//      （`'` 可以打断单引号包的属性值）。运行时属性值 = 解码结果，所以 `onclick="foo('a\nb')"`（普通模板串里单反斜杠 n，运行时是真换行）判红，`'\\n'`（两个反斜杠，运行时是反斜杠加 n）放行。
//      静态 HTML 属性（<script> 块之外）：原文送检，`\'` 运行时就是反斜杠加引号、`${id}` 运行时就是 `${id}`，二者必然判红。
//      处理器只可能出现在字符串 / 模板串里（<script> 块里不在字符串内的 on…=" 不是合法 JS），所以「在 <script> 块内」等价于「在 JS 字符串内」。
//   —— 个别现存处理器的写法依赖「插值本身是逗号加参数」（`'${t.key}'${ridArg}`），无法用标识符读法证明；它们登记在下面的 ALLOW 表
//      （文件名 + 处理器原文全等匹配，带原因），登记项原文改一个字符就不再被放行；页面修好后登记项失去存在意义，守卫判红要求删除登记。
//
// 注释行：只跳「整行是注释」的行（`//…`、`*…`、整行 `/* … */`）；`/* … */` 后面还接代码的行照常扫描。
//
// 不证明：处理器运行时的行为（只证明它能被解析）、插值 ${…} 内部表达式的语法（由页面主脚本的解析负责）、
// 占位符替换后的语义（占位符恒当标识符用，`${x}` 在字符串里 / 表达式里 / 语句位置都合法）；
// 词法器只做词法、不解析语法：正则字面量与除号的区分靠 acorn 词法器的上下文推断。
// 标签模板的判定（P57③，codex 49B）= 语法树 ∪ 词法启发式（加硬门，不加放行）：每个 JS 区域先用 acorn 完整解析（先 script 后 module），收集全部 TaggedTemplateExpression 的 quasi 起点
// （tag 是 String.raw ⇒ raw，其余 tagged）；词法启发式 = 开头反引号前一个 token 是标识符 / `)` / `]`，并补齐 `.` 之后的关键字成员（`tags.default`…``）、this / super、闭合反引号（连续标签模板 html`x``…``）。
// 任一方判为标签模板就按标签模板处理；raw 只有两边都认定 String.raw 才算。语法树完整解析失败的区域（不是完整合法 JS）只用词法结果，数量在输出里报出（「语法树不可用的区域 N 个」）。
// 全树 43 个 JS 区域与完整解析（acorn.parse + onToken）逐 token 对拍：字符串、模板、正则、花括号、`)`、`]` 这几类 token 的类型与起止一致。
// 误判清单（词法启发式会把这些判为 tagged，即按 raw 读，并因 D1 硬门判红、须人工看一眼或登记；并集只加硬门，语法树不会纠正词法的误判）：
// `of`、`await`、`yield` 后紧跟模板串，`if (x) `…`` 这类控制流括号 `)` 之后的模板串，以及 `)` / `]` 之后换行开头的模板串；
// raw 读不解码转义，该方向可能比解码读法宽，所以不静默放行；
// 已登记的残余（47B LOW，本守卫不处理）：插值内的块注释含右花括号会让插值提前结束（误红）；整行以 `*` 开头的模板文本被当作注释行跳过；
// 以及抽取正则（`on小写字母=` 紧跟引号）抓不到的写法——JS 字符串里用转义引号包属性值（`onclick=\"…\"`、`onclick=\'…\'`）、
// 等号两侧带空格、属性值不带引号、大写的 onClick。收口批 2 预筛复看时全树 grep 这几种写法均为 0 处；新增此类写法前先扩抽取正则。
//
// 用法：node scripts/verify-inline-handler-syntax.js                          扫 public/*.html 与 public/assets/js/*.js，全部处理器必须通过
//       node scripts/verify-inline-handler-syntax.js --file <页面副本>        只扫指定文件（供变异副本判红；.js 全文是 JS 区域，.html 按 <script> 块区分；不做登记过期检查）
//       node scripts/verify-inline-handler-syntax.js --self-test              内存变异自证：删一个右括号 / 多一个引号必须判红；M7 原样必须判红；缺逗号等负例必须判红（含静态 HTML 属性里的 ${…}、普通字符串里的 ${…}、模板串里的 \n / '）；
//                                                                              String.raw 里原样 \n 与普通模板里同写法的对照；词法失败判红；登记项改一个字符必须判红
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');   // 仓库已有依赖（package.json dependencies；verify-model-catalog-core.js 等同法 require）：只用它的词法器 acorn.tokenizer 取字符串 / 模板串 token 的区间

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const JS_DIR = path.join(PUBLIC_DIR, 'assets', 'js');
const PLACEHOLDER = '__P__';
const MAX_ATTR = 6000; // 属性值最长扫描长度，超过仍没有收尾引号就判 unterminated

/**
 * 显式登记放行表：处理器写法依赖「插值本身是逗号加参数」，标识符读法无法证明它能解析。
 * 匹配规则 = 文件名（public 下的相对名，如 Data_Correction.html）全等 + 处理器原文（属性值在源码里的原样文本，含 ${…}）全等；只放行「标识符读法判红」的处理器。
 * 登记项必须有原因；页面改好后（标识符读法能过）登记项即过期，守卫判红要求删除。
 */
const ALLOW = [
  {
    file: 'Data_Correction.html',
    raw: "queryReadStatus(${t.cid}, '${t.key}'${ridArg})",
    reason: "ridArg 是 `, 'rid'` 形式的整段参数串（空串或逗号加引号参数），插值本身带逗号；占位符当标识符时 `'__P__'__P__` 缺逗号。写法运行时合法，改业务页面超出本守卫范围。",
  },
];

/** 从 src[i]（紧跟在 `${` 之后）起，跳过一个模板插值表达式，返回收尾 `}` 之后的下标；找不到返回 -1。认字符串（' " `，模板串可嵌套 ${}）与花括号深度 */
function skipTemplateExpr(src, i) {
  let depth = 1;
  let j = i;
  const n = src.length;
  while (j < n) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '/' && src[j + 1] !== '/' && src[j + 1] !== '*' && /(^|[(,=:\[!&|?{};])\s*$/.test(src.slice(Math.max(i, j - 12), j))) {
      // 正则字面量（如 .replace(/'/g, …)）：跳到收尾的 /，认转义与字符类，避免里面的引号被当成字符串起点
      j++;
      let inClass = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        j++;
      }
      j++; continue;
    }
    if (c === "'" || c === '"') {
      const q = c; j++;
      while (j < n && src[j] !== q) { if (src[j] === '\\') j++; j++; }
      j++; continue;
    }
    if (c === '`') {
      j++;
      while (j < n && src[j] !== '`') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '{') {
          const k = skipTemplateExpr(src, j + 2);
          if (k < 0) return -1;
          j = k; continue;
        }
        j++;
      }
      j++; continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return j + 1; }
    j++;
  }
  return -1;
}

// 整行是注释：行首为 `//`、行首为 `*`（块注释续行）、或整行就是一段块注释（块注释收尾标记之后没有别的内容）。块注释后面还接代码的行不算注释行。
function isCommentLine(line) {
  const t = line.trim();
  if (t.startsWith('//') || t.startsWith('*')) return true;
  if (t.startsWith('/*')) {
    const e = t.indexOf('*/');
    return e < 0 || t.slice(e + 2).trim() === '';
  }
  return false;
}

/** .html 里 <script>…</script> 块的内容区间 [[start, end)…]（处理器位于这些区间内 = 位于 JS 字符串 / 模板串内） */
function scriptRegions(src) {
  const out = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(src))) { const s = m.index + m[0].indexOf('>') + 1; out.push([s, s + m[1].length]); }
  return out;
}

/**
 * 用 acorn 词法器（acorn.tokenizer，只做词法、不解析语法）取一段 JS 源码里全部「字符串 / 模板串静态段」的区间，返回 { spans, error }。
 *   spans = [{ s, e, kind }]（绝对下标 = base + token 在 text 里的位置，按起点升序）：
 *     kind 'str'   单 / 双引号字符串 token（含两端引号）；
 *     kind 'tmpl'  普通模板串的静态段（quasi，两个 ` / ${ / } 之间的原文）；
 *     kind 'raw'   String.raw 标签模板串的静态段；
 *     kind 'tagged' 其他标签模板串的静态段（按 raw 读，并在报告里标出）。
 *   模板串可嵌套（${…} 里再有模板串）：用栈跟踪「当前在静态段还是在插值表达式里」与花括号深度；标签判定 = 开头反引号前一个 token 是标识符 / `)` / `]`（String.raw = 前三个 token 依次是 String . raw）。
 *   词法失败（如字符串没收尾）返回 error（fail-closed：调用方判红）。注释与正则字面量不产出区间。
 */
function lexJsSpans(text, base) {
  const spans = [];
  const stack = [];   // 模板串栈：{ kind, inExpr, depth }
  let prev = null; let prev2 = null; let prev3 = null;
  // P57③（codex 49B MED）：标签模板的判定 = 语法树 ∪ 词法启发式（加硬门，不加放行）。语法树对该区域完整解析成功时给出每个标签模板的开头反引号位置（'raw' = String.raw，其余 'tagged'）；
  //   解析失败（该区域不是完整合法 JS，如 type="text/template" 块或语法超出 acorn）⇒ 只用词法结果，astUnavailable 计数由 extractHandlers 汇总、runScan 打印。
  const astMap = LEX.useAst ? collectTaggedTemplates(text) : null;
  try {
    for (const t of acorn.tokenizer(text, { ecmaVersion: 'latest' })) {
      const L = t.type.label;
      const top = stack.length ? stack[stack.length - 1] : null;
      if (L === 'string') spans.push({ s: base + t.start, e: base + t.end, kind: 'str' });
      else if (L === 'template' || L === 'invalidTemplate') spans.push({ s: base + t.start, e: base + t.end, kind: top ? top.kind : 'tmpl' });
      else if (L === '`') {
        if (top && !top.inExpr) stack.pop();   // 静态段里遇到反引号 = 收尾
        else {
          // 词法启发式：前一个 token 是标识符 / `)` / `]`；补齐（LEX.lexExtra）：`.` 之后的关键字成员（tags.default`…`）、this / super、闭合反引号（连续标签模板 html`x``…`）
          let lexTagged = !!prev && (prev.type.label === 'name' || prev.type.label === ')' || prev.type.label === ']');
          if (!lexTagged && LEX.lexExtra && prev) {
            lexTagged = prev.type.label === '`' || (LEX.thisSuper && (prev.type.label === 'this' || prev.type.label === 'super')) || (!!prev.type.keyword && !!prev2 && prev2.type.label === '.');
          }
          const lexRaw = lexTagged && prev.type.label === 'name' && prev.value === 'raw' && !!prev2 && prev2.type.label === '.' && !!prev3 && prev3.type.label === 'name' && prev3.value === 'String';
          const astKind = astMap ? astMap.get(t.start) : undefined;
          // 并集：任一方判为标签模板就按标签模板处理（LEX.union 关掉 = 自证变异「语法树可用时只看语法树」，正常恒开）
          const tagged = (LEX.union || !astMap) ? (lexTagged || astKind !== undefined) : astKind !== undefined;
          // raw 只有两边都认定 String.raw 才算（语法树不可用时只看词法；LEX.rawBothSides 关掉 = 自证变异「raw 只看词法」，正常恒开）
          const isRaw = tagged && lexRaw && (astMap && LEX.rawBothSides ? astKind === 'raw' : true);
          stack.push({ kind: !tagged ? 'tmpl' : (isRaw ? 'raw' : 'tagged'), inExpr: false, depth: 0 });
        }
      } else if (L === '${') { top.inExpr = true; top.depth = 0; }
      else if (top && top.inExpr) {
        if (L === '{') top.depth++;
        else if (L === '}') { if (top.depth === 0) top.inExpr = false; else top.depth--; }
      }
      prev3 = prev2; prev2 = prev; prev = t;
    }
  } catch (e) {
    // P57④（codex 49B LOW）：保留异常位置（acorn 的 SyntaxError 带 pos = 区域内偏移），供调用方换算成文件绝对行号；消息里 acorn 自带的相对 (行:列) 去掉，免得误导
    return { spans, error: String(e.message).replace(/\s*\(\d+:\d+\)\s*$/, ''), errPos: Number.isInteger(e.pos) ? e.pos : null, astUnavailable: LEX.useAst && astMap === null };
  }
  return { spans, error: stack.length ? '模板串没有收尾' : null, errPos: null, astUnavailable: LEX.useAst && astMap === null };
}

/** 自证开关（selfTest 里临时关闭以证明两边各自起作用；正常运行恒为全开） */
const LEX = { useAst: true, lexExtra: true, thisSuper: true, union: true, rawBothSides: true };

/**
 * 用 acorn 完整解析一段 JS（先按 script，失败再按 module），返回 Map<标签模板开头反引号在 text 里的位置, 'raw' | 'tagged'>；完整解析不成功返回 null。
 *   'raw' = tag 是 String.raw（MemberExpression，非计算属性，object 名 String、property 名 raw）；其余标签一律 'tagged'。
 */
function collectTaggedTemplates(text) {
  for (const sourceType of ['script', 'module']) {
    let ast;
    try { ast = acorn.parse(text, { ecmaVersion: 'latest', sourceType, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowHashBang: true }); } catch (_) { continue; }
    const found = new Map();
    const todo = [ast];   // 迭代遍历（长链式拼接的语法树很深，不用递归）
    while (todo.length) {
      const n = todo.pop();
      if (!n || typeof n !== 'object') continue;
      if (Array.isArray(n)) { for (const x of n) todo.push(x); continue; }
      if (typeof n.type !== 'string') continue;
      if (n.type === 'TaggedTemplateExpression') {
        const tg = n.tag;
        const isRaw = tg.type === 'MemberExpression' && !tg.computed && tg.object.type === 'Identifier' && tg.object.name === 'String' && tg.property.type === 'Identifier' && tg.property.name === 'raw';
        found.set(n.quasi.start, isRaw ? 'raw' : 'tagged');
      }
      for (const k of Object.keys(n)) { if (k !== 'type' && k !== 'start' && k !== 'end' && k !== 'loc' && k !== 'range') todo.push(n[k]); }
    }
    return found;
  }
  return null;
}

/**
 * 解码 src[j]（必为反斜杠）开头的一个 JS 字符串转义序列，返回 { text, next }（next = 序列之后的下标）。
 * 按 JS 词法：\n \r \t \b \f \v、\0（后面不跟数字）、\xHH、\uHHHH、\u{…}、行续接（反斜杠加换行 → 空）、其余 \c → c。
 */
function decodeJsEscape(src, j) {
  const c = src[j + 1];
  if (c === undefined) return { text: '\\', next: j + 1 };
  switch (c) {
    case 'n': return { text: '\n', next: j + 2 };
    case 'r': return { text: '\r', next: j + 2 };
    case 't': return { text: '\t', next: j + 2 };
    case 'b': return { text: '\b', next: j + 2 };
    case 'f': return { text: '\f', next: j + 2 };
    case 'v': return { text: '\v', next: j + 2 };
    case '0': if (!/[0-9]/.test(src[j + 2] || '')) return { text: '\0', next: j + 2 }; break;
    case 'x': { const h = src.slice(j + 2, j + 4); if (/^[0-9a-fA-F]{2}$/.test(h)) return { text: String.fromCharCode(parseInt(h, 16)), next: j + 4 }; break; }
    case 'u': {
      if (src[j + 2] === '{') {
        const e = src.indexOf('}', j + 3);
        const h = e > 0 ? src.slice(j + 3, e) : '';
        if (/^[0-9a-fA-F]{1,6}$/.test(h) && parseInt(h, 16) <= 0x10FFFF) return { text: String.fromCodePoint(parseInt(h, 16)), next: e + 1 };
      } else {
        const h = src.slice(j + 2, j + 6);
        if (/^[0-9a-fA-F]{4}$/.test(h)) return { text: String.fromCharCode(parseInt(h, 16)), next: j + 6 };
      }
      break;
    }
    case '\r': return { text: '', next: src[j + 2] === '\n' ? j + 3 : j + 2 };
    case '\n': case '\u2028': case '\u2029': return { text: '', next: j + 2 };
    default: break;
  }
  return { text: c, next: j + 2 };
}

/**
 * 抽出全部内联处理器：[{ attr, line, start, end, raw, code, lit, unterminated, jsCtx, kind }]
 *   opts.js = true：整份源码都是 JS（.js 文件）。否则 <script> 块 = JS 区域，块外 = 静态 HTML。
 *   每个 JS 区域先过 acorn 词法器（lexJsSpans）取字符串 / 模板串静态段的区间；处理器的读法由「处理器起点（on…= 的 o）落在哪种 token 里」决定（kind）：
 *     'str'    单 / 双引号字符串：按 JS 规则解码转义（decodeJsEscape），不做占位替换——字符串里的 `${` 是字面量，浏览器拿到的就是它；收尾引号按「解码后的字符」判；
 *     'tmpl'   普通模板串静态段：按 cooked 值解码转义，模板插值 ${…} 整体换成占位符（__P__）；
 *     'raw'    String.raw 模板串：按 raw 文本读（反斜杠不解码；`'\n'` 原样是反斜杠加 n），${…} 换占位符；
 *     'tagged' 其他标签模板串：同 raw 读法，并在报告里标出（analyze 的 tagged 列表）；
 *     'none'   JS 区域内但不在任何字符串 / 模板串静态段里（如行尾注释里的举例、插值表达式代码里）：沿用旧读法（解码 + 占位符）——整行注释仍由 isCommentLine 跳过；
 *     'static' 静态 HTML 属性（<script> 块之外）：原文，不解码转义、不换占位符。
 *   一个处理器可以跨字符串拼接（`'<a onclick="foo(' + id + ')">'`）：起点所在 token 决定读法，之后逐字符读到收尾引号，不按 token 边界切换——与旧读法一致。
 *   lexErrors = [{ line, err }]：某个 JS 区域词法失败（fail-closed，由 analyze 判红）；该区域里的处理器无法分类，不进 handlers。
 *   code = 上述读法得到的属性值（尚未还原 HTML 实体）；lit[k] = code 第 k 个字符在 src 里的下标（占位符与转义解码出的字符为 -1，供自证定位「字面量」位置）。
 *   raw = 属性值在源码里的原样文本（含 ${…}、转义），登记放行表按它全等匹配。start / end = 属性值在 src 里的 [start, end) 区间（end 指向收尾引号的起点）。
 *   返回数组上挂 .lexErrors。
 */
function extractHandlers(src, opts) {
  const o = opts || {};
  const regions = o.js ? [[0, src.length]] : scriptRegions(src);
  const out = [];
  out.lexErrors = [];
  const spans = [];
  const badRegions = [];
  out.astUnavailable = 0;   // 语法树完整解析失败的区域数（这些区域只用词法判定标签模板）
  for (const [s, e] of regions) {
    const r = lexJsSpans(src.slice(s, e), s);
    if (r.astUnavailable) out.astUnavailable++;
    if (r.error) {
      // 报文件绝对行号（P57④）：词法异常带位置 ⇒ 区域起点 + 偏移所在行；模板栈残留这类没有位置的错误 ⇒ 区域起点所在行，并在文案里标明「区域起点，无法定位」
      const located = r.errPos !== null && r.errPos !== undefined;
      const line = src.slice(0, located ? s + r.errPos : s).split('\n').length;
      out.lexErrors.push({ line, err: 'JS 区域词法失败（fail-closed）：' + r.error + (located ? '' : '（区域起点，无法定位）') });
      badRegions.push([s, e]); continue;
    }
    for (const sp of r.spans) spans.push(sp);
  }
  const kindAt = (pos) => {
    let lo = 0; let hi = spans.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pos < spans[mid].s) hi = mid - 1; else if (pos >= spans[mid].e) lo = mid + 1; else return spans[mid].kind;
    }
    return 'none';
  };
  const re = /\bon([a-z]+)=(["'])/g;
  let m;
  while ((m = re.exec(src))) {
    // 注释里的举例文字（如 `// 内联事件属性（onclick="…" 等）`）不是处理器：只跳整行是注释的行
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const nl = src.indexOf('\n', m.index);
    if (isCommentLine(src.slice(lineStart, nl < 0 ? src.length : nl))) continue;
    const q = m[2];
    const start = m.index + m[0].length;
    if (badRegions.some(([s, e]) => m.index >= s && m.index < e)) continue;   // 词法失败的区域：已由 lexErrors 判红，这里的处理器无法分类
    const inJs = regions.some(([s, e]) => m.index >= s && m.index < e);
    const kind = inJs ? kindAt(m.index) : 'static';
    const decode = kind === 'str' || kind === 'tmpl' || kind === 'none';              // 按 JS 规则解码转义
    const placeholder = kind === 'tmpl' || kind === 'raw' || kind === 'tagged' || kind === 'none';   // ${…} 是模板插值：换占位符（普通字符串里的 ${ 是字面量，静态 HTML 同）
    let j = start;
    let code = '';
    const lit = [];
    let closed = false;
    let closeLen = 1;
    while (j < src.length && j - start < MAX_ATTR) {
      const c = src[j];
      if (c === q) { closed = true; break; }
      if (!decode && kind !== 'static' && c === '\\') {   // raw / tagged：反斜杠连同后一个字符按原文一起消费，后一个字符不进占位判断（运行时模板里 `\${` 不是插值）；后一个字符恰是属性收尾引号时只消费反斜杠（引号照常收尾）
        const nx = src[j + 1];
        if (nx === undefined || nx === q) { code += c; lit.push(j); j++; continue; }
        code += c + nx; lit.push(j, j + 1); j += 2; continue;
      }
      if (decode && c === '\\') {
        const d = decodeJsEscape(src, j);
        if (d.text === q) { closed = true; closeLen = d.next - j; break; }   // 转义解码出的字符等于收尾引号：运行时属性值到此为止
        for (let t = 0; t < d.text.length; t++) { code += d.text[t]; lit.push(-1); }
        j = d.next; continue;
      }
      if (placeholder && c === '$' && src[j + 1] === '{') {
        const k = skipTemplateExpr(src, j + 2);
        if (k < 0) break;
        for (const ch of PLACEHOLDER) { code += ch; lit.push(-1); }
        j = k; continue;
      }
      code += c; lit.push(j); j++;
    }
    const line = src.slice(0, m.index).split('\n').length;
    out.push({ attr: 'on' + m[1], line, start, end: closed ? j : -1, raw: closed ? src.slice(start, j) : '', code, lit, unterminated: !closed, jsCtx: inJs, kind });
    if (closed) re.lastIndex = j + closeLen;
  }
  return out;
}

const decodeEntities = (s) => s.replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * 语法检查：返回 { ok, err }。唯一读法 = 占位符当标识符；code 已是「运行时属性值」（extractHandlers 在 JS 字符串内已按 JS 词法解码），这里只还原 HTML 实体。
 */
function checkSyntax(code) {
  const text = decodeEntities(code);
  try { new Function('event', text); return { ok: true, err: '' }; } catch (e) { return { ok: false, err: e.message }; }
}

/**
 * 对一份页面源码逐个处理器检查：返回 { handlers, bad: [{ attr, line, err, snippet }], allowed: [{ line, entry }] }
 *   opts.file = 文件名（登记放行表按它匹配）；opts.js = 整份源码是 JS。
 */
function analyze(src, opts) {
  const o = opts || {};
  const handlers = extractHandlers(src, o);
  const bad = [];
  const allowed = [];
  for (const le of handlers.lexErrors) bad.push({ attr: '(JS 区域)', line: le.line, err: le.err, snippet: '' });   // 词法失败 = 判红（fail-closed）
  for (const h of handlers) {
    if (h.kind === 'tagged') {   // D1 硬门：非 String.raw 的标签模板读法本守卫证明不了，判红；ALLOW 里按「文件名 + 处理器原文」登记才放行
      const te = o.file ? ALLOW.find(a => a.file === o.file && a.raw === h.raw) : null;
      if (te) allowed.push({ line: h.line, entry: te });
      else bad.push({ attr: h.attr, line: h.line, err: '标签模板（非 String.raw）里的处理器：读法未证明，须在 ALLOW 登记（文件名 + 处理器原文）', snippet: h.code.slice(0, 120) });
      continue;
    }
    if (h.unterminated) { bad.push({ attr: h.attr, line: h.line, err: '属性值找不到收尾引号（unterminated）', snippet: h.code.slice(0, 120) }); continue; }
    const r = checkSyntax(h.code);
    if (r.ok) continue;
    const entry = o.file ? ALLOW.find(a => a.file === o.file && a.raw === h.raw) : null;
    if (entry) { allowed.push({ line: h.line, entry }); continue; }
    bad.push({ attr: h.attr, line: h.line, err: r.err, snippet: h.code.slice(0, 120) });
  }
  return { handlers, bad, allowed, tagged: handlers.filter(h => h.kind === 'tagged'), lexErrors: handlers.lexErrors, astUnavailable: handlers.astUnavailable };
}

function targetFiles() {
  const html = fs.readdirSync(PUBLIC_DIR).filter(f => f.endsWith('.html')).sort().map(f => path.join(PUBLIC_DIR, f));
  const js = fs.readdirSync(JS_DIR).filter(f => f.endsWith('.js')).sort().map(f => path.join(JS_DIR, f));
  return html.concat(js);
}

function scanFiles(files) {
  const rows = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const r = analyze(src, { file: path.basename(f), js: f.endsWith('.js') });
    rows.push({ file: f, n: r.handlers.length, bad: r.bad, allowed: r.allowed, tagged: r.tagged, nLex: r.lexErrors.length, kinds: r.handlers.map(h => h.kind), astUnavailable: r.astUnavailable });
  }
  return rows;
}

/** checkStale = true（默认全量扫描）：每条登记项必须真的放行了至少一个处理器，否则判红（登记过期） */
function runScan(files, label, checkStale) {
  const rows = scanFiles(files);
  let pass = 0;
  let fail = 0;
  for (const r of rows) {
    pass += r.n - (r.bad.length - r.nLex);   // 词法失败项（nLex）不是处理器，单独计失败
    fail += r.bad.length;
    for (const b of r.bad) console.log(`  ✗ ${path.basename(r.file)}:${b.line} ${b.attr}  ${b.err}  ::  ${b.snippet}`);
  }
  const total = rows.reduce((a, r) => a + r.n, 0);
  const nAllowed = rows.reduce((a, r) => a + r.allowed.length, 0);
  for (const r of rows) for (const a of r.allowed) console.log(`  ○ 登记放行 ${path.basename(r.file)}:${a.line}  ${a.entry.raw}`);
  // 读法分布（按处理器起点所在 token 类型）；tagged 另由 analyze 判红（D1 硬门）
  const kindCount = {};
  for (const r of rows) for (const k of r.kinds) kindCount[k] = (kindCount[k] || 0) + 1;
  console.log(`  读法分布：${['static', 'str', 'tmpl', 'raw', 'tagged', 'none'].map(k => `${k}=${kindCount[k] || 0}`).join(' ')}`);
  const nAstOff = rows.reduce((a, r) => a + r.astUnavailable, 0);
  console.log(`  语法树不可用的区域 ${nAstOff} 个（这些区域的标签模板只按词法启发式判定；其余区域是 语法树 ∪ 词法）${nAstOff ? '：' + rows.filter(r => r.astUnavailable).map(r => path.basename(r.file) + '×' + r.astUnavailable).join('、') : ''}`);
  if (checkStale) {
    for (const a of ALLOW) {
      const hit = rows.some(r => path.basename(r.file) === a.file && r.allowed.some(x => x.entry === a));
      if (!hit) { fail++; console.log(`  ✗ 登记项已过期（${a.file} 里没有任何处理器依赖它）：${a.raw}`); }
    }
  }
  const nHtml = rows.filter(r => r.file.endsWith('.html')).length;
  console.log(`[${label}] 文件 ${rows.length} 个（html ${nHtml}、js ${rows.length - nHtml}），内联处理器 ${total} 个（其中模型中心 / 配置台 ${rows.filter(r => /Model_(Center|Workbench)\.html$/.test(r.file)).reduce((a, r) => a + r.n, 0)} 个；登记放行 ${nAllowed} 个）`);
  return { pass, fail, total };
}

// ---------------------------------------------------------------------------------------------
function selfTest() {
  let pass = 0;
  let fail = 0;
  const check = (name, ok, detail) => { if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}  ${detail || ''}`); } };
  const J2 = (v) => JSON.stringify(v);

  const wbFile = path.join(PUBLIC_DIR, 'Model_Workbench.html');
  const wb = fs.readFileSync(wbFile, 'utf8');
  const base = analyze(wb, { file: 'Model_Workbench.html' });
  check('前提：配置台抽到的处理器数 ≥ 100', base.handlers.length >= 100, `n=${base.handlers.length}`);
  check('基线（配置台原样）：0 个语法错误', base.bad.length === 0, base.bad.map(b => `${b.line}:${b.err}`).join(' | '));

  // 1) M7 原样：把修好的 `')"` 还原回缺右括号的 `'"`，必须判红，且红在伴生表提示链接那一行
  const FIXED = "&mode=${readOnly ? 'view' : 'edit'}')\" style=\"color:#2563eb";
  const BROKEN = "&mode=${readOnly ? 'view' : 'edit'}'\" style=\"color:#2563eb";
  check('前提：配置台含已修好的伴生表跳转链接写法', wb.includes(FIXED));
  const m7 = analyze(wb.replace(FIXED, BROKEN), { file: 'Model_Workbench.html' });
  check('M7 原样（缺右括号）判红', m7.bad.length === 1 && /replace/.test(m7.bad[0].snippet), `bad=${m7.bad.length}`);

  // 2) 逐个处理器：删掉该处理器最后一个「字面量」右括号（不在 ${…} 内）→ 必须判红；在最后一个右括号前多插一个单引号 / 双引号 → 必须判红
  const survive = { del: [], sq: [], dq: [] };
  let tried = 0;
  for (const h of base.handlers) {
    let idx = -1;
    for (let k = h.code.length - 1; k >= 0; k--) { if (h.code[k] === ')' && h.lit[k] >= 0) { idx = h.lit[k]; break; } }
    if (idx < 0) continue;
    tried++;
    const variants = {
      del: wb.slice(0, idx) + wb.slice(idx + 1),
      sq: wb.slice(0, idx) + "'" + wb.slice(idx),
      dq: wb.slice(0, idx) + '"' + wb.slice(idx),
    };
    for (const [kind, text] of Object.entries(variants)) {
      const r = analyze(text, { file: 'Model_Workbench.html' });
      if (r.bad.length === 0) survive[kind].push(h.line);
    }
  }
  check('前提：参与逐个变异的处理器 ≥ 80', tried >= 80, `tried=${tried}`);
  check(`删右括号变异：${tried} 个处理器全部判红`, survive.del.length === 0, `漏判行：${survive.del.slice(0, 12).join(',')}`);
  check(`多一个单引号变异：${tried} 个处理器全部判红`, survive.sq.length === 0, `漏判行：${survive.sq.slice(0, 12).join(',')}`);
  check(`多一个双引号变异：${tried} 个处理器全部判红`, survive.dq.length === 0, `漏判行：${survive.dq.slice(0, 12).join(',')}`);

  // 3) 对照组：合法写法必须放行（防守卫过严把正常写法判红）。JS 字符串里的写法包进 <script> 块，让守卫按「JS 字符串内」读
  const okSrc = [
    `<button onclick="foo(1)">a</button>`,
    `<button onclick='foo("a")'>a</button>`,
    `<input onchange="a(this.value); b(&quot;x&quot;)">`,
    "<script>",
    // 47B MED-1：模板插值 ${…} 只在 JS 字符串 / 模板串上下文（<script> 块内）按占位符读，所以这两条带插值的写法放进 <script> 块里
    "h += `<a onclick=\"go('x?id=${id}&mode=${ro ? 'view' : 'edit'}')\">a</a>`;",
    "h += `<a onclick=\"${cond ? 'a()' : ''}\">a</a>`;",
    "h += '<i onclick=\"del(\\'' + id + '\\')\">x</i>';",
    "</script>",
  ].join('\n');
  const okR = analyze(okSrc);
  check('对照组：6 条合法写法放行（含 <script> 块里带 \\\' 转义的拼接串）', okR.handlers.length === 6 && okR.bad.length === 0, `n=${okR.handlers.length} bad=${okR.bad.map(b => b.snippet).join(' | ')}`);
  const badR = analyze([`<button onclick="foo(1">a</button>`, `<button onclick="foo(1))">a</button>`].join('\n'));
  check('对照组：2 条非法写法判红', badR.bad.length === 2, `bad=${badR.bad.length}`);
  const unterm = analyze(`<button onclick="foo(1)>a</button>`);
  check('收尾引号缺失判红（unterminated）', unterm.bad.length === 1 && /unterminated/.test(unterm.bad[0].err), `bad=${unterm.bad.length}`);

  // 4) 收口批 2 负例：插值旁边缺逗号 / 静态属性里的 \' / 块注释后接代码；每条都必须判红（标识符读法下运行时必抛 SyntaxError）
  const neg = (name, src, opts) => { const r = analyze(src, opts); check(name, r.bad.length === 1, `handlers=${r.handlers.length} bad=${r.bad.length}`); };
  neg("负例：onclick=\"foo('a' ${b})\"（字符串与插值之间缺逗号）判红", "<button onclick=\"foo('a' ${b})\">x</button>");
  neg('负例：onclick="foo(${a} ${b})"（两个插值之间缺逗号）判红', '<button onclick="foo(${a} ${b})">x</button>');
  neg("负例：onclick=\"foo('a'${b})\"（字符串紧贴插值缺逗号）判红", "<button onclick=\"foo('a'${b})\">x</button>");
  neg("负例：静态 HTML 属性里的 \\'（运行时是反斜杠加引号）判红", "<a onclick=\"go(\\'x\\')\">a</a>");
  neg("负例：块注释后接代码的行照常扫描（/* note */ h += '<a onclick=\"bad(\">'）判红", ["<script>", "/* note */ h += '<a onclick=\"bad(\">';", "</script>"].join('\n'));
  neg('负例：.js 文件里（模板串拼出的处理器）缺逗号同样判红', "const t = `<a onclick=\"foo(${a} ${b})\">`;", { js: true });
  // 47B MED-1：静态 HTML 属性里的 ${…} 按原文送检（浏览器拿到的就是原文，不是占位符）
  neg('负例（47B MED-1）：静态 HTML 属性 <button onclick="foo(${id})"> 判红（${…} 不在 JS 字符串里，不换占位符）', '<button onclick="foo(${id})">x</button>');
  neg('负例（47B MED-1）：静态 HTML 属性里的插值夹在 <script> 块之外的另一处也判红（<div onclick="a(${x}, ${y})">）', ['<script>', 'var a = 1;', '</script>', '<div onclick="a(${x}, ${y})">x</div>'].join('\n'));
  // 47B MED-2：JS 字符串 / 模板串上下文按 JS 词法完整解码
  neg("负例（47B MED-2）：.js 模板串里 onclick=\"foo('a\\nb')\"（单反斜杠 n，运行时是真换行，字符串字面量被换行打断）判红", "const t = `<a onclick=\"foo('a\\nb')\">`;", { js: true });
  neg("负例（47B MED-2）：.js 里 onclick='foo(\\u0027a\\u0027)'（\\u0027 解码成单引号，运行时属性值在第一个 \\u0027 处结束，只剩 foo(；若不按解码后的引号收尾，会读成合法的 foo('a')）判红", "const t = `<a onclick='foo(\\u0027a\\u0027)'>`;", { js: true });
  neg("负例（47B MED-2）：.js 里 onclick=\"foo(\\x27)\"（\\x27 解码成单引号，运行时 foo(') 字符串未闭合；不解码 \\xHH 会读成合法的 foo(x27)）判红", "const t = `<a onclick=\"foo(\\x27)\">`;", { js: true });
  neg("负例（47B MED-2）：.js 里 onclick=\"foo(\\u{27})\"（\\u{…} 解码成单引号，字符串未闭合）判红", "const t = `<a onclick=\"foo(\\u{27})\">`;", { js: true });
  neg("负例（47B MED-2）：.js 里 onclick=\"foo(\\u0027)\"（\\uHHHH 解码成单引号，字符串未闭合；不解码会读成合法的 foo(u0027)）判红", "const t = `<a onclick=\"foo(\\u0027)\">`;", { js: true });
  neg("负例（47B MED-2）：<script> 块内模板串里的 \\n 同样按真换行读（onclick=\"foo('a\\nb')\"）判红", ['<script>', "const t = `<a onclick=\"foo('a\\nb')\">`;", '</script>'].join('\n'));
  const okDec = (name, src, opts, n) => { const r = analyze(src, opts); check(name, r.handlers.length === n && r.bad.length === 0, `handlers=${r.handlers.length} bad=${r.bad.map(b => b.snippet).join(' | ')}`); };
  okDec("对照（47B MED-2）：.js 里 '\\\\n'（两个反斜杠，运行时是反斜杠加 n）照常放行：onclick=\"foo('a\\\\nb')\"", "const t = `<a onclick=\"foo('a\\\\nb')\">`;", { js: true }, 1);
  okDec("对照（47B MED-2）：.js 里 \\u0027 当属性值内的引号（onclick=\"foo(\\u0027a\\u0027)\"，运行时 foo('a')）放行", "const t = `<a onclick=\"foo(\\u0027a\\u0027)\">`;", { js: true }, 1);
  okDec("对照（47B MED-2）：.js 里 \\u{61} 解码成 a：onclick=\"foo(\\u{61})\"（运行时 foo(a)）放行；不解码会读成 foo(u{61}) 而判红", "const t = `<a onclick=\"foo(\\u{61})\">`;", { js: true }, 1);
  okDec("对照（47B MED-2）：.js 里 \\x61 与 \\t \\r \\v \\f 转义（onclick=\"foo(\\x61,\\t\\r\\v\\f1)\"，运行时全是合法空白）放行", "const t = `<a onclick=\"foo(\\x61,\\t\\r\\v\\f1)\">`;", { js: true }, 1);
  okDec("对照（47B MED-2）：行续接（反斜杠加换行）在运行时消失：onclick=\"foo('a\\<换行>b')\"（运行时 foo('ab')；把续接读成真换行会让字符串字面量被打断）放行", "const t = `<a onclick=\"foo('a\\\nb')\">`;", { js: true }, 1);
  okDec('对照（47B MED-1）：<script> 块内模板串里的 ${id} 照常按占位符放行', ['<script>', 'const t = `<a onclick="foo(${id})">`;', '</script>'].join('\n'), undefined, 1);
  okDec('对照（47B MED-1）：.js 文件里模板串的 ${id} 照常放行', 'const t = `<a onclick="foo(${id})">`;', { js: true }, 1);
  // 48 sol-M：读法由处理器起点所在 token 的词法类型决定（普通引号字符串 / 普通模板串 / String.raw / 其他标签模板 / 不在字符串里 / 静态 HTML）
  const kindOf = (src, opts) => analyze(src, opts).handlers.map(h => h.kind).join(',');
  // 普通引号字符串：${…} 是字面量（浏览器拿到的就是 ${id}，foo(${id}) 无法解析）判红——.js 与 <script> 块各一；单 / 双引号字符串各一
  neg("负例（48 sol-M）：.js 普通单引号字符串里的 onclick=\"foo(${id})\"（${ 是字面量）判红", "const t = '<a onclick=\"foo(${id})\">';", { js: true });
  neg("负例（48 sol-M）：.js 普通双引号字符串里的 onclick='foo(${id})'（${ 是字面量）判红", "const t = \"<a onclick='foo(${id})'>\";", { js: true });
  neg("负例（48 sol-M）：<script> 块内普通字符串里的 onclick=\"foo(${id})\"（${ 是字面量）判红", ['<script>', "const t = '<a onclick=\"foo(${id})\">';", '</script>'].join('\n'));
  neg("负例（48 sol-M）：模板插值表达式里的普通字符串（`${ c ? '<a onclick=\"foo(${x})\">' : '' }`）按普通字符串读，其中的 ${ 是字面量，判红", "const t = `${ c ? '<a onclick=\"foo(${x})\">' : '' }`;", { js: true });
  check('读法（48 sol-M）：普通字符串 = str；普通模板串 = tmpl；静态 HTML = static；String.raw = raw；其他标签模板 = tagged；行中注释里的举例 = none',
    kindOf("const t = '<a onclick=\"foo(1)\">';", { js: true }) === 'str' && kindOf("const t = `<a onclick=\"foo(1)\">`;", { js: true }) === 'tmpl' && kindOf('<a onclick="foo(1)">') === 'static'
    && kindOf("const t = String.raw`<a onclick=\"foo(1)\">`;", { js: true }) === 'raw' && kindOf("const t = html`<a onclick=\"foo(1)\">`;", { js: true }) === 'tagged'
    && kindOf("foo(); /* <a onclick=\"ok()\"> */", { js: true }) === 'none',
    J2([kindOf("const t = '<a onclick=\"foo(1)\">';", { js: true }), kindOf("const t = String.raw`<a onclick=\"foo(1)\">`;", { js: true }), kindOf("const t = html`<a onclick=\"foo(1)\">`;", { js: true })]));
  // String.raw：按 raw 读（不解码）——`'\n'` 原样是反斜杠加 n，运行时合法，放行；普通模板里同样写法按解码判（真换行打断字符串字面量，判红，与上面的现有用例对齐）
  okDec("对照（48 sol-M）：String.raw 模板里 onclick=\"foo('a\\nb')\"（原样反斜杠加 n，运行时合法）放行", "const t = String.raw`<a onclick=\"foo('a\\nb')\">`;", { js: true }, 1);
  neg("负例（48 sol-M）：同样的 onclick=\"foo('a\\nb')\" 写在普通模板里按解码判（真换行打断字符串字面量）判红", "const t = `<a onclick=\"foo('a\\nb')\">`;", { js: true });
  okDec('对照（48 sol-M）：String.raw 模板里的 ${id} 照常按占位符放行', "const t = String.raw`<a onclick=\"foo(${id})\">`;", { js: true }, 1);
  neg('负例（48 sol-M）：String.raw 模板里缺逗号（foo(${a} ${b})）同样判红', "const t = String.raw`<a onclick=\"foo(${a} ${b})\">`;", { js: true });
  // 其他标签模板：按 raw 读，并在 analyze 的 tagged 列表里标出
  const tagSrc = "const t = html`<a onclick=\"foo('a\\nb')\">`;";
  const tg = analyze(tagSrc, { js: true });
  check('其他标签模板（html`…`）：D1 硬门判红 1 项（按 raw 读，原样 \\n 本身合法也一样），在 tagged 列表里标出 1 处；String.raw 与普通模板不进该列表也不判红', tg.tagged.length === 1 && tg.bad.length === 1 && /标签模板/.test(tg.bad[0].err) && analyze("const t = String.raw`<a onclick=\"foo(1)\">`;", { js: true }).bad.length === 0 && analyze("const t = `<a onclick=\"foo(1)\">`;", { js: true }).tagged.length === 0, J2([tg.tagged.length, tg.bad]));
  {
    // P57③（codex 49B MED）：标签模板 = 语法树 ∪ 词法启发式。四种原先漏判的 / 边界写法，未登记一律因「标签模板」判红；String.raw 正例仍按 raw；普通模板不得被判成标签
    const tagNeg = (name, src) => { const r = analyze(src, { js: true }); check(name, r.bad.length === 1 && /标签模板/.test(r.bad[0].err) && r.tagged.length === 1, J2([r.bad.length, r.bad[0] && r.bad[0].err, r.tagged.length])); };
    const NEG_SRCS = {
      kw: "const t = tags.default`<a onclick=\"foo(1)\">`;",
      thisTag: "const t = this.h`<a onclick=\"foo(1)\">`;",
      chain: "const t = html`x``<a onclick=\"foo(1)\">`;",
      comma: "const t = (0, h)`<a onclick=\"foo(1)\">`;",
    };
    tagNeg('标签模板（P57③）：tags.default`…`（关键字成员作标签）未登记 ⇒ 因「标签模板」判红', NEG_SRCS.kw);
    tagNeg('标签模板（P57③）：this.h`…` 未登记 ⇒ 因「标签模板」判红', NEG_SRCS.thisTag);
    tagNeg('标签模板（P57③）：html`x``…`（连续标签模板，第二段前是闭合反引号）未登记 ⇒ 因「标签模板」判红', NEG_SRCS.chain);
    tagNeg('标签模板（P57③）：(0, h)`…` 未登记 ⇒ 因「标签模板」判红', NEG_SRCS.comma);
    check('String.raw 正例（P57③）：String.raw`…`、String.raw 作外层的嵌套仍按 raw 读（不判红）；String .raw 中间带空白 / 注释同样是 raw',
      kindOf("const t = String.raw`<a onclick=\"foo(1)\">`;", { js: true }) === 'raw' && kindOf("const t = String /* c */ . raw`<a onclick=\"foo(1)\">`;", { js: true }) === 'raw' && analyze("const t = String.raw`<a onclick=\"foo('a\\nb')\">`;", { js: true }).bad.length === 0,
      J2([kindOf("const t = String.raw`<a onclick=\"foo(1)\">`;", { js: true }), kindOf("const t = String /* c */ . raw`<a onclick=\"foo(1)\">`;", { js: true })]));
    check('对照（P57③）：普通模板串不得被判成标签模板——return `…`、x = `…`、a ? `…` : `…`、+ 拼接、关键字之后（typeof `…`）都是 tmpl',
      kindOf("function f() { return `<a onclick=\"foo(1)\">`; }", { js: true }) === 'tmpl' && kindOf("let x; x = `<a onclick=\"foo(1)\">`;", { js: true }) === 'tmpl'
      && kindOf("const c = 1; const t = c ? `<a onclick=\"foo(1)\">` : `<b onclick=\"foo(2)\">`;", { js: true }) === 'tmpl,tmpl' && kindOf("const t = 'a' + `<a onclick=\"foo(1)\">`;", { js: true }) === 'tmpl'
      && kindOf("const t = typeof `<a onclick=\"foo(1)\">`;", { js: true }) === 'tmpl',
      J2([kindOf("function f() { return `<a onclick=\"foo(1)\">`; }", { js: true }), kindOf("const t = typeof `<a onclick=\"foo(1)\">`;", { js: true })]));
    // 判别力：语法树 / 词法补齐各自起作用——临时关掉一方，对应的负例必须由「判红」变「判绿」（证明另一方没有顺带兜住它）
    const withLex = (cfg, fn) => { const saved = Object.assign({}, LEX); Object.assign(LEX, cfg); try { return fn(); } finally { Object.assign(LEX, saved); } };
    const redUnder = (cfg, src) => withLex(cfg, () => analyze(src, { js: true }).bad.length === 1);
    check('判别力（P57③）：去掉并集（只用词法启发式的旧口径，关掉语法树与词法补齐）⇒ 关键字成员 / 连续标签模板两条负例判绿（漏判）——证明现在的判红来自语法树或补齐；(0, h)`…` 与 this.h`…`（前一个 token 是标识符 / `)`）旧口径本来就判红，不在此列',
      !redUnder({ useAst: false, lexExtra: false }, NEG_SRCS.kw) && redUnder({ useAst: false, lexExtra: false }, NEG_SRCS.comma) && !redUnder({ useAst: false, lexExtra: false }, NEG_SRCS.chain),
      J2([redUnder({ useAst: false, lexExtra: false }, NEG_SRCS.kw), redUnder({ useAst: false, lexExtra: false }, NEG_SRCS.chain), redUnder({ useAst: false, lexExtra: false }, NEG_SRCS.comma)]));
    check('判别力（P57③）：只关词法补齐（语法树在）⇒ 四条负例仍全部判红（语法树独立起作用）',
      [NEG_SRCS.kw, NEG_SRCS.thisTag, NEG_SRCS.chain, NEG_SRCS.comma].every((s) => redUnder({ useAst: true, lexExtra: false }, s)), J2([NEG_SRCS.kw, NEG_SRCS.thisTag, NEG_SRCS.chain].map((s) => redUnder({ useAst: true, lexExtra: false }, s))));
    check('判别力（P57③）：只关语法树（词法补齐在）⇒ 关键字成员 / this / 连续标签模板三条负例仍判红（词法补齐独立起作用）',
      [NEG_SRCS.kw, NEG_SRCS.thisTag, NEG_SRCS.chain].every((s) => redUnder({ useAst: false, lexExtra: true }, s)), J2([NEG_SRCS.kw, NEG_SRCS.thisTag, NEG_SRCS.chain].map((s) => redUnder({ useAst: false, lexExtra: true }, s))));
    // 语法树不可用的区域：构造「完整解析失败但词法能过」的区域（`a b c;` 是语法错误，词法器照常切 token），区域里的标签模板只能靠词法补齐
    const unparsable = "a b c;\nconst t = tags.default`<a onclick=\"foo(1)\">`;";
    const un = analyze(unparsable, { js: true });
    check('语法树不可用（P57③）：构造一个解析失败但词法能过的区域 ⇒ astUnavailable = 1；区域里的 tags.default`…` 靠词法补齐仍判红（标签模板）', un.astUnavailable === 1 && un.bad.length === 1 && /标签模板/.test(un.bad[0].err), J2([un.astUnavailable, un.bad]));
    check('判别力（P57③）：同一个语法树不可用的区域，去掉词法补齐 ⇒ 判绿（漏判）——证明这类区域里是词法补齐在兜；语法树可用的区域 astUnavailable = 0',
      !redUnder({ useAst: true, lexExtra: false }, unparsable) && analyze(NEG_SRCS.kw, { js: true }).astUnavailable === 0, J2([redUnder({ useAst: true, lexExtra: false }, unparsable), analyze(NEG_SRCS.kw, { js: true }).astUnavailable]));
    // §8.1（预筛 LOW-1）：三条补齐逻辑各自要有判别力——负例未登记一律因「标签模板」判红，且各配一个变异（LEX 开关）使它判绿
    const NEG8 = {
      thisUnparsable: "a b c;\nconst t = this`<a onclick=\"foo(1)\">`;",     // 语法树不可用的区域里，前一个 token 就是 this（走不到「前一个是标识符」的基础规则）
      xStringRaw: "const t = x.String.raw`<a onclick=\"foo(1)\">`;",          // 词法认 raw（String . raw 三 token），语法树认 tag 是 x.String 的成员 ⇒ 不是 String.raw
      ifTmpl: "if (a) `<a onclick=\"foo(1)\">`;",                              // 词法认 `)` 后是标签，语法树认它是普通模板：并集口径下仍判红
    };
    const un8 = analyze(NEG8.thisUnparsable, { js: true });
    check('标签模板（§8.1）：语法树不可用的区域里 this`…` 未登记 ⇒ 因「标签模板」判红（astUnavailable = 1）', un8.astUnavailable === 1 && un8.bad.length === 1 && /标签模板/.test(un8.bad[0].err) && un8.tagged.length === 1, J2([un8.astUnavailable, un8.bad, un8.tagged.length]));
    tagNeg('标签模板（§8.1）：x.String.raw`…`（词法认 raw、语法树不认）未登记 ⇒ 因「标签模板」判红，不按 raw 放行', NEG8.xStringRaw);
    tagNeg('标签模板（§8.1）：if (a) `…`（词法认标签、语法树认普通模板）未登记 ⇒ 因「标签模板」判红（并集口径）', NEG8.ifTmpl);
    check('判别力（§8.1）：删 this / super 词法补齐分支 ⇒ 语法树不可用区域里的 this`…` 判绿（漏判）；分支在时判红',
      redUnder({}, NEG8.thisUnparsable) && !redUnder({ thisSuper: false }, NEG8.thisUnparsable), J2([redUnder({}, NEG8.thisUnparsable), redUnder({ thisSuper: false }, NEG8.thisUnparsable)]));
    check('判别力（§8.1）：raw 只看词法（去掉「两边都认定」）⇒ x.String.raw`…` 被当 raw 放行（判绿，漏判）；两边都认定时判红',
      redUnder({}, NEG8.xStringRaw) && !redUnder({ rawBothSides: false }, NEG8.xStringRaw), J2([redUnder({}, NEG8.xStringRaw), redUnder({ rawBothSides: false }, NEG8.xStringRaw)]));
    check('判别力（§8.1）：语法树可用时只看语法树（去掉并集）⇒ if (a) `…` 判绿（硬门变放行）；并集在时判红',
      redUnder({}, NEG8.ifTmpl) && !redUnder({ union: false }, NEG8.ifTmpl), J2([redUnder({}, NEG8.ifTmpl), redUnder({ union: false }, NEG8.ifTmpl)]));
  }
  {
    // P57④（codex 49B LOW）：词法失败报文件绝对行号（异常位置），模板栈残留这类无法定位的错误报区域起点并标注
    const html = ['<!doctype html>', '<script>', 'var a = 1;', 'var b = 2;', "var c = 'ok';", "var d = 'unterminated;", 'var e = 5;', '</script>', '<p>x</p>'].join('\n');
    const rh = analyze(html);
    check('词法失败行号（P57④）：<script> 块后部的未闭合字符串 ⇒ 报的行号 = 实际所在行（第 6 行，不是脚本块起点第 2 行）', rh.bad.length === 1 && rh.bad[0].line === 6 && /词法失败/.test(rh.bad[0].err) && !/无法定位/.test(rh.bad[0].err), J2(rh.bad));
    const rj = analyze("const a = 1;\nconst b = 2;\nconst c = 'unterminated;\n", { js: true });
    check('词法失败行号（P57④）：.js 文件里的未闭合字符串 ⇒ 报真实所在行（第 3 行，不是第 1 行）', rj.bad.length === 1 && rj.bad[0].line === 3, J2(rj.bad));
    const rt = analyze(['<script>', 'var a = 1;', "var t = `abc ${", '</script>'].join('\n'));
    check('词法失败行号（P57④）：模板串没收尾（栈残留，无异常位置）⇒ 报区域起点所在行（第 1 行）并在文案里标「（区域起点，无法定位）」', rt.bad.length === 1 && rt.bad[0].line === 1 && /区域起点，无法定位/.test(rt.bad[0].err), J2(rt.bad));
  }
  {
    // 登记后放行：ALLOW 里按「文件名 + 处理器原文」登记（临时登记，用完即删）；原文改一个字符 / 换文件名不放行
    const rawText = "foo('a\\nb')";
    ALLOW.push({ file: 'T_tagged.js', raw: rawText, reason: '自证用临时登记' });
    try {
      const okTg = analyze(tagSrc, { js: true, file: 'T_tagged.js' });
      const otherFile = analyze(tagSrc, { js: true, file: 'T_other.js' });
      const noFile = analyze(tagSrc, { js: true });
      check('其他标签模板：登记（文件名 + 处理器原文）后放行（allowed 1、bad 0）；换文件名 / 不给文件名仍判红', okTg.bad.length === 0 && okTg.allowed.length === 1 && otherFile.bad.length === 1 && noFile.bad.length === 1, J2([okTg.bad, okTg.allowed.length, otherFile.bad.length, noFile.bad.length]));
      const changed = analyze("const t = html`<a onclick=\"foo('a\\nc')\">`;", { js: true, file: 'T_tagged.js' });
      check('其他标签模板：处理器原文改一个字符，登记不再放行（判红）', changed.bad.length === 1 && changed.allowed.length === 0, J2([changed.bad.length, changed.allowed.length]));
    } finally { ALLOW.pop(); }
  }
  {
    // L3：String.raw 里 \${ 不是插值（运行时模板里 \${ 是普通文本），不被换成占位符；\\${x}（两个反斜杠）里的 ${x} 才是插值
    const r1 = extractHandlers("const t = String.raw`<a onclick=\"foo('\\${x}')\">`;", { js: true })[0];
    const r2 = extractHandlers("const t = String.raw`<a onclick=\"foo('\\\\${x}')\">`;", { js: true })[0];
    check('读法（L3）：String.raw 里 \\${x} 不当插值——读出的代码保留 \\${x} 原文、不含占位符；\\\\${x} 里的 ${x} 仍是插值（换占位符）', r1 && r1.kind === 'raw' && r1.code === "foo('\\${x}')" && !r1.code.includes(PLACEHOLDER) && r2 && r2.kind === 'raw' && r2.code.includes(PLACEHOLDER) && r2.code.startsWith("foo('\\\\"), J2([r1 && r1.code, r2 && r2.code]));
    const r3 = extractHandlers("const t = String.raw`<a onclick=\"foo(\\\"x\">`;", { js: true })[0];
    check('读法（L3）：String.raw 里反斜杠后紧跟属性收尾引号时只消费反斜杠，引号照常收尾（读出 foo(\\）', r3 && r3.code === 'foo(\\' && r3.unterminated === false, J2(r3 && [r3.code, r3.unterminated]));
  }
  // 跨字符串拼接：起点所在 token 决定读法，之后逐字符读到收尾引号（与旧读法一致）——单引号串拼接、模板串拼接各一，对照放行
  okDec("对照（48 sol-M）：拼接写法 '<a onclick=\"foo(' + id + ')\">' 放行（读成 foo(' + id + ')，一个字符串字面量参数；与旧读法一致）", "h += '<a onclick=\"foo(' + id + ')\">';", { js: true }, 1);
  okDec("对照（48 sol-M）：拼接写法（<script> 块内，转义引号）'<i onclick=\"del(\\'' + id + '\\')\">' 放行", ['<script>', "h += '<i onclick=\"del(\\'' + id + '\\')\">x</i>';", '</script>'].join('\n'), undefined, 1);
  neg("负例（48 sol-M）：拼接写法缺右括号 '<a onclick=\"foo(' + id + '\">' 判红（读成 foo(' + id + ' 括号未闭合）", "h += '<a onclick=\"foo(' + id + '\">';", { js: true });
  // 嵌套模板串（插值表达式里再有对象字面量花括号 / 内层模板串）：栈与花括号深度跟踪正确，后面的静态段仍按 tmpl 读
  okDec('对照（48 sol-M）：插值表达式含对象字面量花括号与内层模板串后，外层模板串的静态段仍按 tmpl 读：`${ ({a: 1}).a + `x` }<a onclick="foo(${id})">`', "const t = `${ ({a: 1}).a + `x` }<a onclick=\"foo(${id})\">`;", { js: true }, 1);
  // 外层是 String.raw：插值表达式里的对象字面量花括号 + 内层普通模板串之后，外层静态段仍是 raw（原样 \n 放行）；花括号深度或模板栈跟踪错了，外层会被误读成内层的普通模板串（按解码判红）
  okDec("对照（48 sol-M）：外层 String.raw、插值表达式含对象字面量与内层模板串后，外层静态段仍按 raw 读：String.raw`${ ({a: 1}).a + `x` }<a onclick=\"foo('a\\nb')\">`", "const t = String.raw`${ ({a: 1}).a + `x` }<a onclick=\"foo('a\\nb')\">`;", { js: true }, 1);
  check('读法（48 sol-M）：同上 String.raw 外层静态段的处理器 kind = raw', kindOf("const t = String.raw`${ ({a: 1}).a + `x` }<a onclick=\"foo(1)\">`;", { js: true }) === 'raw', kindOf("const t = String.raw`${ ({a: 1}).a + `x` }<a onclick=\"foo(1)\">`;", { js: true }));
  check('读法（48 sol-M）：嵌套模板串内层静态段里的处理器也是 tmpl（`${ `<b onclick="foo(${id})">` }`）', kindOf("const t = `a${ `<b onclick=\"foo(${id})\">` }`;", { js: true }) === 'tmpl', kindOf("const t = `a${ `<b onclick=\"foo(${id})\">` }`;", { js: true }));
  // 词法失败：fail-closed 判红（字符串 / 模板串没收尾），报出原因；.js 与 <script> 块各一
  const lexJs = analyze("const a = 1;\nconst t = 'unterminated;\n", { js: true });
  const lexHtml = analyze(['<script>', "var t = `abc ${", '</script>', '<button onclick="foo(1)">x</button>'].join('\n'));
  check('词法失败（48 sol-M）：.js 里字符串没收尾 ⇒ 判红 1 项，原因含「词法失败」', lexJs.bad.length === 1 && /词法失败/.test(lexJs.bad[0].err), J2(lexJs.bad));
  check('词法失败（48 sol-M）：<script> 块里模板串没收尾 ⇒ 判红，原因含「词法失败」；块外的静态处理器照常放行', lexHtml.bad.length === 1 && /词法失败/.test(lexHtml.bad[0].err) && lexHtml.handlers.length === 1, J2([lexHtml.bad, lexHtml.handlers.length]));
  const cmtOk = analyze(["<script>", "// 举例：onclick=\"bad(\"", " * 举例：onclick=\"bad(\"", "/* 举例：onclick=\"bad(\" */", "</script>"].join('\n'));
  check('对照：整行注释里的举例文字不算处理器（0 个）', cmtOk.handlers.length === 0, `n=${cmtOk.handlers.length}`);

  // 5) 登记放行：真实页面里的登记项原样放行；原文改一个字符就不再被放行；换文件名也不放行
  const dcFile = path.join(PUBLIC_DIR, 'Data_Correction.html');
  const dc = fs.readFileSync(dcFile, 'utf8');
  const entry = ALLOW[0];
  check('前提：Data_Correction.html 含登记项原文', dc.includes(entry.raw));
  const dcBase = analyze(dc, { file: 'Data_Correction.html' });
  check('登记项原样：被放行（allowed 恰 1 个）且页面 0 个语法错误', dcBase.allowed.length === 1 && dcBase.bad.length === 0, `allowed=${dcBase.allowed.length} bad=${dcBase.bad.length}`);
  const dcNoReg = analyze(dc, {});
  check('同一页面不带文件名（不查登记表）：登记项那一处判红', dcNoReg.bad.length === 1 && dcNoReg.allowed.length === 0, `bad=${dcNoReg.bad.length}`);
  const dcOther = analyze(dc, { file: 'Other.html' });
  check('同一页面换文件名（登记表按文件名匹配）：登记项那一处判红', dcOther.bad.length === 1, `bad=${dcOther.bad.length}`);
  for (const [label, from, to] of [['函数名改一个字符', 'queryReadStatus(${t.cid}', 'queryReadStatuz(${t.cid}'], ['多一个空格', "'${t.key}'${ridArg})", "'${t.key}' ${ridArg})"], ['少一个逗号', "${t.cid}, '${t.key}'", "${t.cid} '${t.key}'"]]) {
    const r = analyze(dc.split(entry.raw).join(entry.raw.split(from).join(to)), { file: 'Data_Correction.html' });
    check(`登记项原文${label}：不再被放行（判红 1 个、放行 0 个）`, r.bad.length === 1 && r.allowed.length === 0, `bad=${r.bad.length} allowed=${r.allowed.length}`);
  }

  // 6) 扫描范围与登记过期：public/assets/js 下拼出的内联处理器也在范围内；登记项没有处理器依赖时判红
  const tf = targetFiles().map(f => path.basename(f));
  check('扫描范围含 public/assets/js 下的 app.js / admin.js / model-catalog.js / domain_manager.js', ['app.js', 'admin.js', 'model-catalog.js', 'domain_manager.js'].every(n => tf.includes(n)), `files=${tf.length}`);
  for (const n of ['app.js', 'admin.js', 'model-catalog.js', 'domain_manager.js']) {
    const hs = extractHandlers(fs.readFileSync(path.join(JS_DIR, n), 'utf8'), { js: true });
    check(`${n} 抽到内联处理器 ≥ 1 个（实得 ${hs.length}）`, hs.length >= 1, `n=${hs.length}`);
  }
  const origLog = console.log;
  console.log = () => {};
  const stale = runScan([wbFile], 'x', true);
  console.log = origLog;
  check('登记过期检查：只扫一个不含登记项的页面时，登记项无处理器依赖 → 判红 1 项', stale.fail === 1, `fail=${stale.fail}`);

  console.log(`\n=== 自证：${pass} 项通过 / ${fail} 项失败 ===`);
  return fail === 0;
}

// ---------------------------------------------------------------------------------------------
function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) { process.exit(selfTest() ? 0 : 1); }
  const fi = argv.indexOf('--file');
  let files;
  let label;
  let stale;
  if (fi >= 0) { files = [path.resolve(argv[fi + 1])]; label = '指定文件'; stale = false; }
  else { files = targetFiles(); label = 'public/*.html + public/assets/js/*.js'; stale = true; }
  const r = runScan(files, label, stale);
  console.log(`\n=== PASS：${r.pass} 项通过 / ${r.fail} 项失败 ===`);
  process.exit(r.fail === 0 ? 0 : 1);
}

if (require.main === module) main();
module.exports = { extractHandlers, checkSyntax, analyze, lexJsSpans, scriptRegions, ALLOW };
