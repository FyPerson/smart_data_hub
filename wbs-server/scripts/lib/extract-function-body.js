// scripts/lib/extract-function-body.js — 按函数名从源码文本提取完整函数体（S13 收口批 LOW 追-6 新抽·
//   406 号合并轮 406-L2 升级为有限状态词法扫描）
//
// 抽出背景：verify-sys-list-badge-fields.js / verify-sys-derive-numbering.js（DN8）/
//   verify-sys-derive-display.js 三处逐字维护同一份"定位 `function <name>(` 后括号深度计数找匹配收尾
//   `}`"实现——同 sql-select-boundary.js 的抽取动机（同一逻辑三处各自维护，改一处会漏另两处，codex
//   246 MED-1 同款教训）。三处原实现都在**未剥注释的原文**上做深度计数，若函数体的中文说明注释里
//   恰好写了形似 `{ 示例对象 }` 的片段，注释里的花括号会一起被计入深度、把收尾 `}` 找错——本次下沉时
//   顺带补上"剥注释先行"。
//
// [406-L2] 首版只识别行/块注释，字符串字面量（`'...'`/`"..."`/模板字面量）与正则字面量内部的
//   `{`/`}` 字符没被排除在花括号计数之外——目标函数体内若含 `'}'` 这类字符串、`/}/` 这类正则，深度
//   计数会被字面量内容里的假花括号带偏，找错收尾位置（codex 406-L2 指出）。改为有限状态扫描：识别
//   单/双引号字符串（含转义字符）、模板字面量（含 `${...}` 表达式段，表达式段内的真实花括号仍参与
//   计数——嵌套仅需支持一层，见下方 blankNonCode 内联注释）、正则字面量（含 `[...]` 字符类内部 `/`
//   不结束正则）、行/块注释，只有真正的"代码态"字符才原样保留参与花括号深度计数，其余全部等长掩码
//   为空格（保留换行符，不改变总长度/行列位置）。
//
// ⚠️ 剥非代码内容必须**等长掩码**（内容原地替换成等量空格），不能用"删除式"剥离（如本仓其余守卫常用的
//   `stripComments`——那是给"纯文本模式匹配"场景设计的，剥完文本变短，若拿它上面找到的下标去切原始
//   源码字符串会系统性错位——verify-sys-prerelease-flags.js 头部注释明确记录过"首次实现犯过这个错，
//   此处直接改正"，本模块从一开始就用等长掩码规避同一类坑，不是自己没遇到过就没设防）。等长掩码后
//   位置信息与原始 src 完全对齐，可以直接拿掩码文本上算出的下标去切原始 src。
'use strict';

// [407-H1] 判定 `/` 是正则字面量起点还是除号运算符：原实现只看**前一个单字符**，`return /}/.test(x)`
//   里 `/` 前一个字符是 `n`（"return" 的最后一个字母），落进"标识符后判除号"分支，把正则内容错判成
//   除法表达式——而模块头注明确写着支持 `return /re/` 这类写法，实现与声称自相矛盾（codex 407-H1
//   指出）。改判**前一个完整 token**（跳空白后向前取整个词，而非只取一个字符）：
//   - token 是数字字面量（纯数字）→ 除号（`5 / 2` 这类）
//   - token 是标识符/关键字 → 仅当命中"允许正则起始"的关键字白名单（return/throw/yield/typeof/
//     case/in/of/delete/void/instanceof/new，JS 词法惯例——这些位置后面出现 `/` 语法上只能是正则，
//     不可能是除号，因为它们前面没有可供"相除"的表达式）才判正则，其余标识符（普通变量名）判除号
//     （`x / 2`）
//   - 非单词的前一个"有意义字符"：运算符/`(`/`,`/`=`/`[`/`{`/`;`/`:`/`!`/`&`/`|`/`?` 等判正则；
//     `)`/`]`（表达式/数组下标结束）判除号；起始位置（无前置字符）判正则
const REGEX_ALLOWED_KEYWORDS = new Set(['return', 'throw', 'yield', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'instanceof', 'new']);
const REGEX_ALLOWED_PUNCT = new Set(['(', '[', '{', ',', ';', ':', '=', '!', '&', '|', '?', '+', '-', '*', '%', '^', '~', '<', '>', '\n', '']);

function isWordChar(c) {
  return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c === '_' || c === '$';
}

function isWhitespace(c) {
  return c === ' ' || c === '\n' || c === '\t' || c === '\r';
}

function precedingTokenAllowsRegex(outArr) {
  let k = outArr.length - 1;
  while (k >= 0 && isWhitespace(outArr[k])) k--;
  if (k < 0) return true;   // 起始位置（文件/掩码文本最前）——只可能是正则，不存在"除以谁"的表达式
  const c = outArr[k];
  if (isWordChar(c)) {
    let start = k;
    while (start >= 0 && isWordChar(outArr[start])) start--;
    const word = outArr.slice(start + 1, k + 1).join('');
    // [408-H1] 属性访问后的关键字同名词是属性名，不是语法关键字——`obj.return / 2` 里 "return" 只是
    //   属性名，`.return` 与语句开头的 `return` 长得一样，但白名单判定不该命中。跳过 token 前的空白，
    //   若紧邻的是 `.`（含 `?.` 的那个 `.`——`obj?.return` 与 `obj.return` 从这个 `.` 往前看是同一种
    //   形状，不必再单独识别 `?`）就说明这是属性名，一律按标识符判除号，不查白名单。
    let before = start;
    while (before >= 0 && isWhitespace(outArr[before])) before--;
    if (before >= 0 && outArr[before] === '.') return false;   // 属性访问：`obj.return`/`obj.of`/`obj.new` 等，判除号
    if (/^[0-9]+$/.test(word)) return false;   // 纯数字字面量后 `/` 是除号
    return REGEX_ALLOWED_KEYWORDS.has(word);   // 真正的语句级关键字：仅白名单命中才判正则，普通变量名判除号
  }
  return REGEX_ALLOWED_PUNCT.has(c);   // 非单词字符：`)`/`]` 不在集合内，天然判除号；其余按集合判定
}

// 有限状态扫描：把源码中"非代码"部分（注释/字符串/正则字面量内容）等长掩码成空格，只留代码态字符
// （含模板字面量 `${...}` 表达式段内的真实花括号）原样保留。状态栈支持嵌套（模板字面量表达式段内
// 可以再开一层字符串/注释/嵌套模板字面量，标准的"状态入栈、结束出栈"处理）。
//   templateExprDepthStack 与栈内每个 'templateExpr' 状态一一对应，记录该表达式段自己的花括号深度
//   （从 1 起，归 0 时说明这段 `${...}` 表达式已经闭合，弹回外层的 'template' 状态继续扫模板静态
//   文本）——这是"仅需一层"嵌套支持的落地点：表达式段内部若再出现嵌套模板字面量，靠同一套状态栈
//   机制天然递归处理，不额外特殊处理更深层级。
function blankNonCode(s) {
  const out = [];
  const stack = ['code'];
  const templateExprDepthStack = [];
  let i = 0;

  while (i < s.length) {
    const state = stack[stack.length - 1];
    const c = s[i];

    if (state === 'code' || state === 'templateExpr') {
      if (c === '/' && s[i + 1] === '*') { stack.push('blockcomment'); out.push(' ', ' '); i += 2; continue; }
      // [407-H2] 删除旧例外 `s[i-1] !== ':'`——首版为防"字符串里的 http:// 被误判成行注释"，但字符串
      //   自 406-L2 起已由独立的 'sq'/'dq'/'template' 状态保护（进了那些状态就不会走到这个分支），这
      //   条例外对"防字符串误判"这个原始目的已经是死代码，只剩害处：`label: // }` 这类真代码里的行
      //   注释（label 语法在本仓源码风格里虽罕见但合法）会被误判成"冒号后不算注释"，注释里的 `}` 混
      //   进花括号深度计数（codex 407-H2 指出）。code/templateExpr 态出现 `//` 一律判行注释，不再看
      //   前一字符是不是冒号。
      if (c === '/' && s[i + 1] === '/') { stack.push('linecomment'); out.push(' ', ' '); i += 2; continue; }
      if (c === "'") { stack.push('sq'); out.push(c); i++; continue; }
      if (c === '"') { stack.push('dq'); out.push(c); i++; continue; }
      if (c === '`') { stack.push('template'); out.push(c); i++; continue; }
      if (c === '/' && precedingTokenAllowsRegex(out)) { stack.push('regex'); out.push(c); i++; continue; }
      if (state === 'templateExpr') {
        if (c === '{') { templateExprDepthStack[templateExprDepthStack.length - 1]++; out.push(c); i++; continue; }
        if (c === '}') {
          templateExprDepthStack[templateExprDepthStack.length - 1]--;
          out.push(c); i++;
          if (templateExprDepthStack[templateExprDepthStack.length - 1] === 0) { templateExprDepthStack.pop(); stack.pop(); }
          continue;
        }
      }
      out.push(c); i++; continue;
    }

    if (state === 'linecomment') {
      if (c === '\n') { stack.pop(); out.push('\n'); i++; continue; }
      out.push(' '); i++; continue;
    }
    if (state === 'blockcomment') {
      if (c === '*' && s[i + 1] === '/') { stack.pop(); out.push(' ', ' '); i += 2; continue; }
      out.push(c === '\n' ? '\n' : ' '); i++; continue;
    }
    if (state === 'sq' || state === 'dq') {
      const quote = state === 'sq' ? "'" : '"';
      if (c === '\\') { out.push(' ', ' '); i += 2; continue; }
      if (c === quote) { stack.pop(); out.push(c); i++; continue; }
      out.push(c === '\n' ? '\n' : ' '); i++; continue;
    }
    if (state === 'template') {
      if (c === '\\') { out.push(' ', ' '); i += 2; continue; }
      if (c === '`') { stack.pop(); out.push(c); i++; continue; }
      if (c === '$' && s[i + 1] === '{') { stack.push('templateExpr'); templateExprDepthStack.push(1); out.push(' ', '{'); i += 2; continue; }
      out.push(c === '\n' ? '\n' : ' '); i++; continue;
    }
    if (state === 'regex') {
      if (c === '\\') { out.push(' ', ' '); i += 2; continue; }
      if (c === '[') { stack.push('charclass'); out.push(' '); i++; continue; }
      if (c === '/') { stack.pop(); out.push(' '); i++; continue; }
      if (c === '\n') { stack.pop(); out.push('\n'); i++; continue; }   // 正则字面量不可跨行，异常兜底防死锁
      out.push(' '); i++; continue;
    }
    if (state === 'charclass') {
      if (c === '\\') { out.push(' ', ' '); i += 2; continue; }
      if (c === ']') { stack.pop(); out.push(' '); i++; continue; }
      out.push(' '); i++; continue;
    }
    // 兜底：理论不可达的未知状态，原样输出防死循环（不吞字符导致长度不对齐）。
    out.push(c); i++;
  }
  return out.join('');
}

/**
 * 从 src 中提取 `function <name>(...) { ... }` 的完整函数体文本（含 function 关键字起、到匹配的
 * 收尾 `}` 止，原始未剥注释/字面量文本）。用括号深度计数定位收尾 `}`（在有限状态扫描掩码后的文本上
 * 定位，再切原始文本），不依赖固定行号——源码改动后仍可定位；字符串/正则字面量内部的 `{`/`}` 不会
 * 干扰计数。
 * @param {string} src 源码全文
 * @param {string} name 函数名（不含括号）
 * @returns {string|null} 找不到返回 null
 */
function extractFunctionBody(src, name) {
  const blanked = blankNonCode(src);
  const start = blanked.indexOf(`function ${name}(`);
  if (start < 0) return null;
  let i = blanked.indexOf('{', start), depth = 0, end = -1;
  for (; i < blanked.length; i++) {
    if (blanked[i] === '{') depth++;
    else if (blanked[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  return end < 0 ? null : src.slice(start, end + 1);
}

module.exports = { extractFunctionBody };
