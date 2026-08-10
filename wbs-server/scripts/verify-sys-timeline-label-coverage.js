// scripts/verify-sys-timeline-label-coverage.js — 时间线「后端写入码 ⊆ 前端标签表」静态对账守卫（B2+B5+B6+B7 加固）
//   背景：前端 siRenderTimeline 兜底="查不到映射就裸显 key"——历史上已三轮"漏一个补一个"
//   （set_release_flag / 执行人四码 / 本次又发现 9 个）。本守卫把这类回归结构性堵死：**纯静态源码解析**，
//   不起服务、不建库、不依赖 node_modules（只用 Node 内置 fs/path），可在任意 worktree 直接跑。
//
//   用法：node scripts/verify-sys-timeline-label-coverage.js
//
//   ⚠️ 本脚本不读、不信任任何"人工码表"——29 个写入点的 event_type/action_code 全部从
//   routes/sys-iteration/index.js 与 transitions.js 源码文本程序化解析得出（下方「通用小型扫描器」），
//   docs/local/系统迭代/时间线写入点码表_20260810.md 只作为人工交叉核对参照（不在本文件路径依赖内——
//   docs/local 在 .gitignore，CI/其它 worktree 可能没有该文件，脚本运行不依赖它）。
//
//   对账规则（与 public/Sys_Iteration.html 的 siRenderTimeline 显示 key 计算逐字同源，见该函数 ~2254 行）：
//     status_change/release → key = action_code || event_type
//     scope_change          → key = action_code（仅当 action_code ∈ SI_TL_RELEASE_SCOPE_LABEL）否则 'scope_change'
//     其余 event_type       → key = event_type 自身
//
//   KNOWN_GAPS：见下方常量定义处（当前应为空数组，F4 已清零）。
//
//   ⭐ [B5 加固·Opus 预筛第三轮 MED-1+LOW 系收口] 解析面 fail-closed 五件——把"静默漏检/静默丢弃"的口子
//   逐个改成"归不了类就报错"，理由统一：guard_static_analysis_gotchas 沉淀的教训是"越界比落空更隐蔽"，
//   一个本该被扫到却被现有窄正则/窄判据漏掉的新写入点/新调用形态，不会让守卫变红——它只会让守卫的"绿"
//   变得不可信。五处：
//     MED-1a：locateRealInsertSites 对"非注释但前一字符不是反引号"的命中不再静默丢弃，改 throw。
//     MED-1b：deriveEngineReachableActions 的候选采集从"窄正则一步到位"改成"先枚举全部非注释命中→
//             逐个归类为声明/中继/字面量三类之一→归不了类 throw"。
//     LOW-1：resolveIdentifierLiterals/resolvePropertyLiterals 解析前剥注释（防"注释里写的示例代码被
//            误当真实赋值采集"——本文件自己的 B3 注释块 `mirrorActionCode='liaison_test_skip_excused'`
//            就是实证，只是恰好值同码才无害）+ 搜索范围收窄到所属函数体（防跨函数同名变量误命中）+
//            剥注释逻辑带对照自证。
//     LOW-2：extractObjectKeys 兼容引号键 `'x':`/"x": + 对无法识别的顶层 token 报错而非静默丢弃（在主
//            会话已落的"剥注释单点修"基础上做通用加固，复用同一份 stripComments，不回退原修法）。
//     LOW-3：一处过时的行号引用订正 + 末行输出的"待 F4 清零"字样改为按 KNOWN_GAPS 是否非空的条件文案。
//
//   ⭐ [B6 回卷·预筛第四轮 LOW-1/LOW-2 收口] 两件：
//     LOW-1：skipStringLiteral/skipBalanced/splitTopLevel/stripComments 补正则字面量识别（预筛实测
//            index.js `file.originalname.replace(/[\\/:*?"<>|]/g, '_')` 字符类内的裸 `"` 曾被误判为
//            字符串起点，一路吞掉约 4.3k 字符、藏起 27 处真注释——当前恰好无害仅因无 scope-narrowed
//            解析站点落在该区间，不能依赖这个偶然事实）。见 precedingSignificantToken/
//            looksLikeRegexLiteralStart/skipRegexLiteral 三个新函数 + selfTestStripComments 第 4 组自证。
//     LOW-2：findEnclosingFunctionBody 的文档注释收窄覆盖面声称——29 个写入点里只有 2 个（runWGate 的
//            mirrorActionCode、applyReleaseChange 的 t.actionCode）真正触发本函数的作用域收窄解析，
//            其余 27 处 event_type/action_code 均为字面量，从不调用 resolveIdentifierLiterals/
//            resolvePropertyLiterals，自然也不会走到这里。
//
//   ⭐ [B7·328a 回卷] 三件（MED+LOW）：
//     统一注释区间表：isInLineComment（"同行前有 //"窄判断）弃用，改用 buildCommentMask/isInCommentRange
//            （复用 stripComments 同一套字符串/正则识别状态机），修两个盲区——块注释完全测不出、字符串/
//            正则里的 "//" 会被误判成注释起点。findEnclosingFunctionBody/locateRealInsertSites/
//            findNonCommentCalls 三处候选定位统一改口，补 selfTestBlockCommentExclusion 块注释变异自证。
//     INSERT 站点数显式基线：sites.length !== 29（原只设下限 < 29）即 fail，报错文案要求人工核实新增/
//            减少站点的语义、更新 EXPECTED_INSERT_SITE_COUNT 常量、同步码表说明——数量漂移双向都要可见。
//     两张标签表补 value 形状断言：extractObjectKeys 此前只解析/校验 key，value 被直接丢弃；现在补
//            validateLabelValueShape（须是简单非空字符串字面量），防"key 存在但 value 是空字符串"这类
//            比"缺 key"更隐蔽的数据错误从主覆盖断言的眼皮底下溜过去。
//
//   ⚠️ [B7·328a 回卷·边界声明] 本文件是手写的启发式源码扫描器，**不是**通用 JS/AST 解析器，也不追求成为
//   一个——它的服务范围明确限定在当前这三个源文件（routes/sys-iteration/index.js、
//   routes/sys-iteration/transitions.js、public/Sys_Iteration.html）已实际出现过的代码形态。任何这三个
//   文件之外的新用途、或这三个文件里出现了本文件从未见过的语法形态，都不在既有测试覆盖范围内，需要
//   先读一遍新代码形态再决定是否要扩展解析器——不要假设它能顺带正确处理任意 JS。
//   已知的一个具体假红风险（[B6·LOW-1] 正则字面量识别）：looksLikeRegexLiteralStart 判断"前一个有效
//   token ∈ 固定集合"来识别 `/` 是正则起点还是除法运算符，这个集合里的 `{`/`}` 理论上能让一个真实的除法
//   运算符被误判成正则起点（比如某处新代码写出 `} / x` 这种紧跟在块语句后面的除法——本仓库当前没有这种
//   写法，但没人能保证以后不会有）。误判后果是 skipRegexLiteral 在同一行内找不到能配对的收尾 `/` 便
//   throw（见该函数的报错信息）——这是一次**假红**（fail-closed 的自然代价：宁可报错拦下人工核实，也不
//   静默把除法运算符当正则吞掉、進而可能把除法右侧的真实代码错当成正则体丢弃）。假红对本文件的 fail-
//   closed 设计哲学是可接受的失败模式（响亮地失败，逼人来看一眼，而不是安静地算错）；若这类假红真的
//   在未来某次改动中触发，说明手写启发式已经顶到了它能处理的复杂度上限，那时候该做的不是给
//   REGEX_CONTEXT_TOKENS 集合继续打补丁，而是把这一层解析迁移到真正的 AST 解析器（如 acorn/espree）。
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INDEX_PATH = path.join(ROOT, 'routes', 'sys-iteration', 'index.js');
const TRANSITIONS_PATH = path.join(ROOT, 'routes', 'sys-iteration', 'transitions.js');
const HTML_PATH = path.join(ROOT, 'public', 'Sys_Iteration.html');

const indexSrc = fs.readFileSync(INDEX_PATH, 'utf8');
const transitionsSrc = fs.readFileSync(TRANSITIONS_PATH, 'utf8');
const htmlSrc = fs.readFileSync(HTML_PATH, 'utf8');

let passed = 0;
const ok = (m) => { passed++; console.log('  \u2713 ' + m); };
function fail(msg) {
  console.error('\n\u274c verify-sys-timeline-label-coverage 失败: ' + msg);
  process.exit(1);
}

// ── 通用小型扫描器（跳过空白/注释、括号平衡匹配、字符串跳过、顶层逗号切分）──────────
//   足够处理本文件 29 个 INSERT 站点 + 两张前端标签表的 JS/SQL 混合文本，不追求通用 JS 解析器完整性。

function isWs(ch) { return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'; }

// pos 指向一个引号字符（' " `）。返回闭合引号的位置。正确跳过反斜杠转义；
// 若是反引号，还要递归跳过内部 ${...} 模板表达式（本仓库这几处未用到，但防御性支持）。
function skipStringLiteral(text, pos) {
  const q = text[pos];
  let i = pos + 1;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') { i++; continue; }
    if (q === '`' && ch === '$' && text[i + 1] === '{') {
      const braceEnd = skipBalanced(text, i + 1);
      i = braceEnd - 1;
      continue;
    }
    if (ch === q) return i;
  }
  return text.length - 1; // 容错：未闭合时退到文末（上层会因后续解析失败而报错，不静默）
}

// ── [B6·LOW-1] 正则字面量识别——实证 fail-open 盲区收口 ──────────────────────────────────
//   背景（预筛实测）：index.js `file.originalname.replace(/[\\/:*?"<>|]/g, '_')` 的正则字面量字符类
//   `[...]` 内含一个裸 `"`。本文件三处字符分派（skipBalanced/splitTopLevel/stripComments）此前把任意
//   `'`/`"`/`` ` `` 无条件当字符串起点，会把这个字符类内的 `"` 误判成字符串开引号，进而 skipStringLiteral
//   一路扫到文件里"下一个不相关的 `"`"才停——本例实测吞掉约 4.3k 字符、连带藏起 27 处真注释（当前恰好
//   无 scope-narrowed 解析站点落在这段区间内所以无害，但不能依赖"恰好没撞上"这种偶然事实，fail-closed
//   精神要求主动修，而不是等真出问题）。
//   修法：识别"这个 `/` 是正则字面量起点还是除法运算符"——看紧邻的上一个有效 token 是否 ∈ 一个固定的
//   "正则上下文" token 集合（`(` `,` `=` `:` `[` `!` `&` `|` `?` `{` `}` `;` `return` `=>`）。命中即整体
//   跳过该正则字面量（含其内部的引号/斜杠——按正则语义处理，`[...]` 字符类内的 `/` 不结束正则），
//   使后续字符级扫描永远不会单独访问到字符类内那个 `"`，从根上堵死误判，而不是事后修补。
//   拿不准的形态一律 throw：紧邻正则起点的上一个非空白字符若是块注释的收尾 `*/`，本启发式判定为
//   "未覆盖形态"直接报错，不猜测（这是唯一已知的未覆盖分支，本仓库当前无此形态的真实站点）。

// 从 slashPos 向前跳过空白，返回紧邻的"上一个有效 token"文本（不含前导空白）。只需要识别有限的
// 标点/关键字集合，不追求通用 JS token 化——遇到紧邻块注释收尾 `*/` 判定为未覆盖形态，直接 throw。
function precedingSignificantToken(text, slashPos) {
  let i = slashPos;
  while (i > 0 && isWs(text[i - 1])) i--;
  if (i === 0) return '';
  if (text[i - 1] === '/' && text[i - 2] === '*') {
    throw new Error(`precedingSignificantToken: 位置 ${slashPos} 前紧邻块注释收尾 "*/"——正则/除法判定遇到未覆盖形态，需人工核实`);
  }
  const last = text[i - 1];
  if (/[a-zA-Z0-9_$]/.test(last)) {
    let s = i - 1;
    while (s > 0 && /[a-zA-Z0-9_$]/.test(text[s - 1])) s--;
    return text.slice(s, i);
  }
  if (last === '>' && text[i - 2] === '=') return '=>';
  return last;
}

const REGEX_CONTEXT_TOKENS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', 'return', '=>']);

// 判定 slashPos 处的 '/' 是正则字面量起点（true）还是除法运算符/其它（false）。
// 调用前提：调用方已排除 `//`/`/*` 两种注释起点（text[slashPos+1] 不是 '/' 或 '*'）。
function looksLikeRegexLiteralStart(text, slashPos) {
  const token = precedingSignificantToken(text, slashPos);
  if (token === '') return false; // 文件开头无上文——本仓库不存在这种真实站点，按非正则处理
  return REGEX_CONTEXT_TOKENS.has(token);
}

// pos 指向已判定为正则字面量起点的 '/'。返回该正则字面量"最后一个被消耗字符"的位置（闭合 '/' 或其后
// 最后一个 flag 字母）——与本文件 skipStringLiteral 的返回值约定一致（调用方 `i = skipRegexLiteral(...);
// continue;` 让 for/while 循环的 i++ 自然移到正则之后的下一个字符）。字符类 [...] 内的 '/' 不结束正则；
// 反斜杠转义（含字符类内的）原样跳过一个字符。正则字面量不能跨行——闭合前遇到换行或文件结尾，判定
// 为未闭合或本启发式判定有误，throw 而不是静默吞掉一大段文本。
function skipRegexLiteral(text, pos) {
  let inClass = false;
  let i = pos + 1;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') {
      throw new Error(
        `skipRegexLiteral: 位置 ${pos} 处的正则字面量在闭合前遇到换行——未闭合，或者这其实是一个被 ` +
        `looksLikeRegexLiteralStart 误判成正则起点的除法运算符（REGEX_CONTEXT_TOKENS 集合过宽的已知假红 ` +
        `风险，见本文件头部边界声明）。这是 fail-closed 设计下可接受的响亮失败，需人工核实是哪一种；若这类 ` +
        `假红开始频繁出现，说明手写启发式已经不够用，该迁移到真正的 AST 解析器（如 acorn/espree），而不是` +
        `继续给 token 集合打补丁。`
      );
    }
    if (ch === '\\') { i++; continue; }
    if (inClass) { if (ch === ']') inClass = false; continue; }
    if (ch === '[') { inClass = true; continue; }
    if (ch === '/') {
      let end = i;
      while (end + 1 < text.length && /[a-zA-Z]/.test(text[end + 1])) end++;
      return end;
    }
  }
  throw new Error(
    `skipRegexLiteral: 位置 ${pos} 处的正则字面量未找到闭合 '/'（到达文件末尾）——同上，可能是除法运算符` +
    `被误判为正则起点，若频繁出现应考虑迁移到 AST 解析器而非继续打补丁。`
  );
}

// pos 指向一个开括号（([{ 之一）。返回匹配闭括号之后的位置（跳过内部字符串/注释/嵌套括号）。
function skipBalanced(text, pos) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const openCh = text[pos];
  const closeCh = pairs[openCh];
  if (!closeCh) throw new Error(`skipBalanced: 位置 ${pos} 处 '${openCh}' 不是支持的开括号`);
  let depth = 0;
  let i = pos;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') { i = skipStringLiteral(text, i); continue; }
    if (ch === '/' && text[i + 1] === '/') { const nl = text.indexOf('\n', i); i = (nl === -1 ? text.length : nl); continue; }
    if (ch === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = (e === -1 ? text.length : e + 1); continue; }
    if (ch === '/' && looksLikeRegexLiteralStart(text, i)) { i = skipRegexLiteral(text, i); continue; }
    if (ch === openCh) depth++;
    else if (ch === closeCh) { depth--; if (depth === 0) return i + 1; }
  }
  throw new Error(`skipBalanced: 未找到位置 ${pos} 处 '${openCh}' 的匹配闭合`);
}

function skipTrivia(text, pos) {
  for (;;) {
    while (pos < text.length && isWs(text[pos])) pos++;
    if (text.startsWith('//', pos)) { const nl = text.indexOf('\n', pos); pos = nl === -1 ? text.length : nl + 1; continue; }
    if (text.startsWith('/*', pos)) { const e = text.indexOf('*/', pos + 2); pos = e === -1 ? text.length : e + 2; continue; }
    break;
  }
  return pos;
}

// 单个顶层片段 [rawStart,rawEnd) → {text,start,end}，start/end 是**去掉首尾空白后**的精确边界
//   （text 本身是 trim 过的，start/end 必须跟着一起收窄，否则调用方拿 start 去定位一个具体字符
//   ——例如某个 token 恰好是单个 '?' ——会因为前导空格而指向错误的字符，见 countPlaceholdersUpTo）。
function makeToken(text, rawStart, rawEnd) {
  let s = rawStart, e = rawEnd;
  while (s < e && isWs(text[s])) s++;
  while (e > s && isWs(text[e - 1])) e--;
  return { text: text.slice(s, e), start: s, end: e };
}

// 按“顶层逗号”（不在任何括号/字符串内）切分 text，返回 [{text,start,end}]（start/end 相对 text 自身，已 trim 对齐）。
function splitTopLevel(text) {
  const tokens = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') { i = skipStringLiteral(text, i); continue; }
    if (ch === '/' && text[i + 1] === '/') { const nl = text.indexOf('\n', i); i = (nl === -1 ? text.length - 1 : nl); continue; }
    if (ch === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = (e === -1 ? text.length - 1 : e + 1); continue; }
    if (ch === '/' && looksLikeRegexLiteralStart(text, i)) { i = skipRegexLiteral(text, i); continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) { tokens.push(makeToken(text, start, i)); start = i + 1; }
  }
  tokens.push(makeToken(text, start, i));
  return tokens.filter(t => t.text.length > 0);
}

// ── [B7·328a 回卷] 统一注释区间表——替代原 isInLineComment 的"同行前有 //"窄判断，供
//   findEnclosingFunctionBody / locateRealInsertSites / findNonCommentCalls 三处候选定位统一调用。
//   本文件大量注释用反引号标注行内代码引用（如 :5246「全部 10 处 `INSERT INTO sys_issue_timeline`」、
//   :3367「旧单一 `makeTransitionEndpoint('submit')` 注册」），字面正则会把这些注释里的引用误当成真实
//   站点/调用点——这一层的职责就是准确分辨"这个位置是不是在注释里"。
//   旧 isInLineComment 有两个盲区（名字就叫 isIn**Line**Comment，望文知义）：
//     ①块注释 /* ... */ 完全测不出——块注释里的 INSERT/makeTransitionEndpoint('literal') 调用会被当
//       成真实代码误采集（见下方 selfTestBlockCommentExclusion 的实证）。
//     ②字符串/正则字面量里出现的 "//" 会被误判成注释起点——旧实现是"同一行前面出现过 // 就算"，
//       不会先跳过字符串/正则去看那个 // 是不是真的注释开头。
//   本次改为与 stripComments 逐字同构的状态机扫描（复用同一份 skipStringLiteral/skipRegexLiteral/
//   looksLikeRegexLiteralStart，不是又发明一套新的窄正则），产出一张等长布尔表：mask[i]===1 表示位置 i
//   落在 // 行注释或 /* */ 块注释内。三处调用方从"每次命中都现场判断一次"改成"O(1) 查表"。
function buildCommentMask(text) {
  const mask = new Uint8Array(text.length);
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') { i = skipStringLiteral(text, i) + 1; continue; }
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      const stop = nl === -1 ? text.length : nl;
      mask.fill(1, i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      mask.fill(1, i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && looksLikeRegexLiteralStart(text, i)) { i = skipRegexLiteral(text, i) + 1; continue; }
    i++;
  }
  return mask;
}
function isInCommentRange(mask, idx) {
  return mask[idx] === 1;
}

// ── [B5·LOW-1(d)] 剥除 // 行注释与 /* */ 块注释，字符串字面量安全（不误伤字符串值里可能出现的 //）──
//   用途双重：① resolveIdentifierLiterals/resolvePropertyLiterals 解析前剥注释，防"注释里的示例代码
//   被误采集为真实赋值"（本文件 B3 注释块 `mirrorActionCode='liaison_test_skip_excused'` 实证）；
//   ② extractObjectKeys 复用同一份实现替换主会话此前的单点正则修法（不回退，是通用化）。
//   注释区间用等长空格占位（不整体删除），保持字符偏移不变——上层若需要绝对位置仍可用。
function stripComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = skipStringLiteral(text, i);
      out += text.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      const stop = nl === -1 ? text.length : nl;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    if (ch === '/' && looksLikeRegexLiteralStart(text, i)) {
      const end = skipRegexLiteral(text, i);
      out += text.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// ── [B5·LOW-1(d)] stripComments 对照自证：构造带注释的假源码，断言剥得对——不是只靠"跑一遍全脚本绿了"
//   这种间接证据。三组：行注释整体清除但真实赋值保留 / 块注释整体清除 / 字符串内的 // 不被误判为注释起点。
function selfTestStripComments() {
  const cases = [
    {
      name: '行注释整体清除但真实赋值保留',
      input: `  // mirrorActionCode='liaison_test_skip_excused'（示例引用，非真实赋值）\n  mirrorActionCode = 'liaison_test_skip_excused';`,
      mustNotContain: [`mirrorActionCode='liaison_test_skip_excused'（示例引用`],
      mustContain: [`mirrorActionCode = 'liaison_test_skip_excused';`],
    },
    {
      name: '块注释整体清除',
      input: `/* actionCode: 'fake_block_comment_value' */\nconst actionCode = 'real_value';`,
      mustNotContain: [`fake_block_comment_value`],
      mustContain: [`actionCode = 'real_value';`],
    },
    {
      name: '字符串字面量内的双斜杠不被误判为注释起点',
      input: `const url = 'https://example.com/path'; // 说明文字`,
      mustContain: [`const url = 'https://example.com/path';`],
      mustNotContain: [`说明文字`],
    },
  ];
  for (const c of cases) {
    const stripped = stripComments(c.input);
    for (const frag of c.mustNotContain) {
      if (stripped.includes(frag)) fail(`LOW-1 剥注释对照自证失败（${c.name}）：剥注释后仍残留注释片段 "${frag}"，实得="${stripped}"`);
    }
    for (const frag of c.mustContain) {
      if (!stripped.includes(frag)) fail(`LOW-1 剥注释对照自证失败（${c.name}）：剥注释后丢失了本该保留的真实代码 "${frag}"，实得="${stripped}"`);
    }
  }
  ok(`LOW-1 剥注释逻辑对照自证通过（${cases.length} 组：行注释清除保留真赋值/块注释清除/字符串内双斜杠不误判）`);

  // [B6·LOW-1] 正则字面量对照自证——独立成组（不并进上面的聚合行），字符类 [...] 内含裸 `"` 的真实形态
  // （index.js `file.originalname.replace(/[\\/:*?"<>|]/g, '_')` 实证原型），断言①正则原样保留（含内部
  // 引号/斜杠，未被误判成字符串起点吞掉）②紧随其后的真注释被正常剥除。
  const regexCase = {
    name: '正则字面量内的引号字符类不被误判为字符串起点（index.js `file.originalname.replace` 实证形态）',
    input: `const safeOriginal = file.originalname.replace(/[\\\\/:*?"<>|]/g, '_'); // 说明文字`,
    mustContain: [`file.originalname.replace(/[\\\\/:*?"<>|]/g, '_');`],
    mustNotContain: [`说明文字`],
  };
  const regexStripped = stripComments(regexCase.input);
  for (const frag of regexCase.mustNotContain) {
    if (regexStripped.includes(frag)) fail(`LOW-1 正则字面量对照自证失败：剥注释后仍残留注释片段 "${frag}"，实得="${regexStripped}"`);
  }
  for (const frag of regexCase.mustContain) {
    if (!regexStripped.includes(frag)) fail(`LOW-1 正则字面量对照自证失败：剥注释后正则字面量未原样保留 "${frag}"，实得="${regexStripped}"`);
  }
  ok(`LOW-1 正则字面量对照自证通过（字符类内裸引号不再误判为字符串起点，紧随其后的真注释正确剥除）`);
}

// ── [B5·LOW-1(b)] 定位 pos 所在的最近一层"函数体"边界 [start,end)——把标识符/属性字面量搜索收窄到
//   "调用点所属函数"而非全文件（防跨函数同名变量误命中；本仓库当前没有实际撞车案例，但不该依赖
//   "恰好没有同名变量"这个偶然事实）。
//   启发式：从 pos 向前找最近一个非注释 `function` 关键字，越过其参数列表（skipBalanced 天然正确跳过
//   参数默认值里的 `= {}` 这类嵌套括号——若直接找"function 之后第一个 {"会被这种默认值骗到错误起点，
//   sysIssueTransition 自身的 `opts = {}` 就是活样本），再找参数列表后的函数体 '{'，括号平衡到其 '}'。
//   仅覆盖本仓库这批调用点使用的具名 function 声明形态；若某天调用点搬进箭头函数，本函数会在"找不到
//   function 关键字"或"计算出的函数体不包含目标位置"时 throw，而不是悄悄退化成全文件搜索。
//   [B6·LOW-2] 覆盖面声称收窄（预筛第四轮）：本函数看似"通用的作用域收窄工具"，但 29 个 INSERT 写入点
//   里实际会调用到它的只有 2 个——runWGate 里 mirrorActionCode（标识符，走 resolveIdentifierLiterals）、
//   applyReleaseChange 里 t.actionCode（属性访问，走 resolvePropertyLiterals）——因为这两处的
//   event_type/action_code 是"变量/属性"而非字面量。其余 27 个写入点的 event_type/action_code 全是
//   字符串字面量或裸 null，candidatesFor 在那些站点上根本不会调用 resolveIdentifierLiterals/
//   resolvePropertyLiterals，自然也不会走到 findEnclosingFunctionBody 这条路径——不是"覆盖了 29 处但
//   只有 2 处用得上"，是"结构上只有这 2 处会用到"。若未来新增第 3 个变量/属性形态的写入点且恰好嵌在
//   箭头函数里（无 `function` 关键字可回溯），本函数会在下方"未能在位置 ${pos} 之前找到任何非注释
//   function 声明"处 throw，不会静默退化成全文件搜索去猜一个可能撞车的候选。
function findEnclosingFunctionBody(text, pos) {
  const mask = buildCommentMask(text);
  const funcRe = /\bfunction\b/g;
  let best = -1;
  let m;
  while ((m = funcRe.exec(text))) {
    if (m.index >= pos) break;
    if (isInCommentRange(mask, m.index)) continue;
    best = m.index;
  }
  if (best === -1) throw new Error(`findEnclosingFunctionBody: 未能在位置 ${pos} 之前找到任何非注释 function 声明`);
  const parenPos = text.indexOf('(', best);
  if (parenPos === -1) throw new Error(`findEnclosingFunctionBody: 位置 ${best} 处 function 声明后未找到参数列表 '('`);
  const paramsEnd = skipBalanced(text, parenPos);
  const braceStart = skipTrivia(text, paramsEnd);
  if (text[braceStart] !== '{') throw new Error(`findEnclosingFunctionBody: 位置 ${best} 处参数列表后未找到函数体 '{'（实际="${text[braceStart]}"）`);
  const bodyEnd = skipBalanced(text, braceStart);
  if (pos < braceStart || pos >= bodyEnd) throw new Error(`findEnclosingFunctionBody: 计算出的函数体 [${braceStart},${bodyEnd}) 不包含目标位置 ${pos}——启发式失效，需要人工核实`);
  return { start: braceStart, end: bodyEnd };
}

// ── ① 后端侧：定位全部真实 INSERT 写入点（排除 :5246 那种写在 // 注释里的反引号引用）────────
//   [B5·MED-1a] 非注释命中但前一字符不是反引号 → 不再静默丢弃，改 throw：这类命中意味着"有一处真实
//   代码在写 INSERT INTO sys_issue_timeline，但不是本解析器认识的『反引号紧跟 INSERT』这种写法"（比如
//   反引号后换行、或用字符串拼接），静默跳过会让新写入点从候选集里凭空消失而无人知晓。
function locateRealInsertSites(text) {
  const needle = 'INSERT INTO sys_issue_timeline';
  const mask = buildCommentMask(text);
  const sites = [];
  let idx = text.indexOf(needle);
  while (idx !== -1) {
    if (isInCommentRange(mask, idx)) {
      idx = text.indexOf(needle, idx + 1);
      continue;
    }
    const lineNo = text.slice(0, idx).split('\n').length;
    if (text[idx - 1] !== '`') {
      throw new Error(
        `locateRealInsertSites: index.js:${lineNo} 处 "${needle}" 命中于非注释代码，但紧邻前一字符不是反引号` +
        `（实际="${text[idx - 1]}"）——可能是新写入点采用了本解析器未覆盖的写法（反引号后换行/字符串拼接等），` +
        `需要人工核实并扩展解析器，不能静默漏检。`
      );
    }
    sites.push({ idx, lineNo, label: `index.js:${lineNo}` });
    idx = text.indexOf(needle, idx + 1);
  }
  return sites;
}

// 在 [rangeStart, rangeEnd) 内（跳过 SQL 单引号字符串）数 '?' 出现次数，直到数到位于 absOffset 的那个，返回其 1-based 序号。
function countPlaceholdersUpTo(text, rangeStart, rangeEnd, absOffset) {
  let count = 0;
  for (let i = rangeStart; i < rangeEnd; i++) {
    const ch = text[i];
    if (ch === "'") { i = skipStringLiteral(text, i); continue; }
    if (ch === '?') { count++; if (i === absOffset) return count; }
  }
  throw new Error(`countPlaceholdersUpTo: 未在范围内找到位于 ${absOffset} 的 '?'`);
}

// 紧跟在查询模板字符串闭合反引号之后，提取 dbRunAsync(query, [params]) 的 params 数组（跳过反引号与 [ 之间可能存在的注释）。
function extractParamsArray(fullText, afterQueryClosePos) {
  let p = skipTrivia(fullText, afterQueryClosePos);
  if (fullText[p] !== ',') throw new Error(`extractParamsArray: 位置 ${p} 期望 ','`);
  p = skipTrivia(fullText, p + 1);
  if (fullText[p] !== '[') throw new Error(`extractParamsArray: 位置 ${p} 期望 '['`);
  const end = skipBalanced(fullText, p);
  const inner = fullText.slice(p + 1, end - 1);
  return splitTopLevel(inner).map(t => t.text);
}

// 解析单个 INSERT 站点：返回 { label, columns, eventType:{present,expr}, actionCode:{present,expr} }
//   expr 已完成“若为 ? 占位符则回填 params 数组同位表达式”这一步，尚未做字面量候选解析（下一步 candidatesFor 做）。
function analyzeInsertSite(fullText, site) {
  const label = site.label;
  let backtickPos = site.idx - 1;
  if (fullText[backtickPos] !== '`') throw new Error(`${label}: 未在预期位置找到开反引号`);
  const closeQuotePos = skipStringLiteral(fullText, backtickPos);
  const queryText = fullText.slice(backtickPos + 1, closeQuotePos);
  const queryAbsStart = backtickPos + 1;

  const tblIdx = queryText.indexOf('sys_issue_timeline');
  if (tblIdx === -1) throw new Error(`${label}: 查询文本中未找到 sys_issue_timeline`);
  let p = skipTrivia(queryText, tblIdx + 'sys_issue_timeline'.length);
  if (queryText[p] !== '(') throw new Error(`${label}: 表名后未找到列清单括号`);
  const colsEnd = skipBalanced(queryText, p);
  const columns = splitTopLevel(queryText.slice(p + 1, colsEnd - 1)).map(t => t.text);

  let vp = skipTrivia(queryText, colsEnd);
  let tokens;
  if (/^VALUES\b/i.test(queryText.slice(vp))) {
    let vvp = skipTrivia(queryText, vp + 'VALUES'.length);
    if (queryText[vvp] !== '(') throw new Error(`${label}: VALUES 后未找到括号`);
    const vEnd = skipBalanced(queryText, vvp);
    tokens = splitTopLevel(queryText.slice(vvp + 1, vEnd - 1)).map(t => ({ text: t.text, start: t.start + vvp + 1 }));
    if (tokens.length !== columns.length) throw new Error(`${label}: VALUES 令牌数(${tokens.length}) \u2260 列数(${columns.length})`);
  } else if (/^SELECT\b/i.test(queryText.slice(vp))) {
    const svp = skipTrivia(queryText, vp + 'SELECT'.length);
    const raw = splitTopLevel(queryText.slice(svp)).map(t => ({ text: t.text, start: t.start + svp }));
    if (raw.length < columns.length) throw new Error(`${label}: SELECT 令牌数(${raw.length}) < 列数(${columns.length})`);
    tokens = raw.slice(0, columns.length);
  } else {
    throw new Error(`${label}: 列清单后既非 VALUES 也非 SELECT（实际："${queryText.slice(vp, vp + 30)}"）`);
  }

  const eventTypeIdx = columns.indexOf('event_type');
  const actionCodeIdx = columns.indexOf('action_code');
  if (eventTypeIdx === -1) throw new Error(`${label}: 列清单缺 event_type`);

  function resolveColumn(colIdx) {
    if (colIdx === -1) return { present: false, expr: null };
    const tokText = tokens[colIdx].text;
    if (tokText === '?') {
      const absOffset = queryAbsStart + tokens[colIdx].start;
      const phIndex = countPlaceholdersUpTo(fullText, queryAbsStart, closeQuotePos, absOffset);
      // closeQuotePos 是 skipStringLiteral 返回的闭反引号**自身**的位置（非其后一位），
      // extractParamsArray 要从"反引号之后"开始找逗号+数组，故 +1。
      const paramsArr = extractParamsArray(fullText, closeQuotePos + 1);
      if (phIndex > paramsArr.length) throw new Error(`${label}: 占位符序号 ${phIndex} 超出 params 数组长度 ${paramsArr.length}`);
      return { present: true, expr: paramsArr[phIndex - 1] };
    }
    return { present: true, expr: tokText };
  }

  return { label, columns, eventType: resolveColumn(eventTypeIdx), actionCode: resolveColumn(actionCodeIdx) };
}

// ── 表达式 → 字面量候选值集合（含"?"回填后的表达式解析）──────────────────────────────
//   [B5·LOW-1] 解析前剥注释 + 搜索范围收窄到 sitePos 所属函数体（findEnclosingFunctionBody）；
//   范围内零命中仍 throw（既有行为保留，只是现在"零命中"意味着真的哪儿都没有，不是被注释幻影误救活）。
function resolveIdentifierLiterals(ident, ctx, sitePos) {
  const scope = findEnclosingFunctionBody(indexSrc, sitePos);
  const scopedText = stripComments(indexSrc.slice(scope.start, scope.end));
  const re = new RegExp('\\b' + ident.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=\\s*(null|\'[^\']*\')', 'g');
  const vals = new Set();
  let m;
  while ((m = re.exec(scopedText))) vals.add(m[1] === 'null' ? null : m[1].slice(1, -1));
  if (vals.size === 0) throw new Error(`${ctx}: 在所属函数体范围内（已剥注释）搜索不到标识符 "${ident}" 的字面量赋值（需人工核实并扩展解析器）`);
  return [...vals];
}
function resolvePropertyLiterals(prop, ctx, sitePos) {
  const scope = findEnclosingFunctionBody(indexSrc, sitePos);
  const scopedText = stripComments(indexSrc.slice(scope.start, scope.end));
  const re = new RegExp('\\b' + prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*(null|\'[^\']*\')', 'g');
  const vals = new Set();
  let m;
  while ((m = re.exec(scopedText))) vals.add(m[1] === 'null' ? null : m[1].slice(1, -1));
  if (vals.size === 0) throw new Error(`${ctx}: 在所属函数体范围内（已剥注释）搜索不到属性 "${prop}" 的字面量赋值（需人工核实并扩展解析器）`);
  return [...vals];
}
function candidatesFor(resolved, ctx, sitePos) {
  if (!resolved.present) return [undefined];
  const t = resolved.expr.trim();
  if (t === 'null') return [null];
  let m = t.match(/^'([^']*)'$/) || t.match(/^"([^"]*)"$/);
  if (m) return [m[1]];
  m = t.match(/^(.+?)\s*\|\|\s*null$/);
  if (m) { const left = candidatesFor({ present: true, expr: m[1] }, ctx, sitePos); return [...new Set([...left, null])]; }
  if (/^[A-Za-z_$][\w$]*$/.test(t)) return resolveIdentifierLiterals(t, ctx, sitePos);
  m = t.match(/^[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)$/);
  if (m) return resolvePropertyLiterals(m[1], ctx, sitePos);
  throw new Error(`${ctx}: 无法静态解析表达式 "${t}"（需人工核实并扩展解析器）`);
}

// ── ① 后端侧（续）：引擎写点（index.js :3778 一带，event_type/action_code 均来自 transitions.js 的
//     transition.timelineEvent / transition.actionCode）——只取**可达**动作。
//     [B5·MED-1b 加固] 候选采集不再是"两条窄正则各自 matchAll 一步到位"（旧写法：只认死
//     `sysIssueTransition(id, 'literal'` 这一种形态，换个首参变量名就会被正则悄悄漏出候选集，无任何
//     信号）。改为：先枚举全部非注释 `makeTransitionEndpoint(` / `sysIssueTransition(` 命中，逐个归类：
//       makeTransitionEndpoint：函数声明本体 / `makeTransitionEndpoint('literal')` 单参字面量注册
//       sysIssueTransition：函数声明本体 / factory 泛型中继形态 `sysIssueTransition(id, action, ...)`
//         （首参 id·次参变量 action，本身不产出字面量，仅确认该形态存在）/ 字面量动作调用
//         `sysIssueTransition(id, 'literal', ...)`（首参 id·次参字符串字面量）
//     任何一处命中三类都归不了 → throw，而不是静默从候选集消失。
//     每个候选在 transitions.js 里查 `action: 'X'` 条目——查不到 ⇒ 该 action 从未被状态机承认，
//     即便路由层调用了 sysIssueTransition 也会在 [1] findTransition 处 400 拒绝、走不到 :3778 的 INSERT
//     （典型例：'confirm-online-norelease'——v1.6 退场时 transitions.js 条目已删，路由注册调用点仍在但
//     100% 落 400 死代码。⚠️ [B5·LOW-3a 引用订正] 那句解释性注释「本分支 100% 不可达死代码」实际位于
//     **引擎 sysIssueTransition 内部 switch(action) 的 default 分支**附近（index.js :3781 一带，随代码
//     演进这个行号会漂移，认准的是"引擎 switch 的 default 分支"这个结构位置，不是路由注册那一行的上方——
//     旧版本注释把这两处混为一谈，此处订正）。
//     若同一 action 在 feature/improvement/bug 三张表中出现且 timelineEvent/actionCode 不一致 → 报错（交叉引用分歧）。

// [B5·MED-1b] 找到 text 中标识符 name 后紧跟 "(" 的全部非注释出现位置。
function findNonCommentCalls(text, name) {
  const re = new RegExp('\\b' + name + '\\s*\\(', 'g');
  const mask = buildCommentMask(text);
  const out = [];
  let m;
  while ((m = re.exec(text))) {
    if (isInCommentRange(mask, m.index)) continue;
    const parenPos = m.index + m[0].length - 1; // m[0] 以 '(' 结尾
    out.push({ nameStart: m.index, parenPos });
  }
  return out;
}
// [B5·MED-1b] nameStart 紧邻其前（跳过空白）是否为 "function" 关键字——用于识别函数声明本体。
function isPrecededByFunctionKeyword(text, nameStart) {
  const before = text.slice(Math.max(0, nameStart - 30), nameStart);
  return /\bfunction\s*$/.test(before);
}
// [B5·MED-1b] 归类 makeTransitionEndpoint 的全部非注释命中：声明本体 / 'literal' 单参注册。归不了类 throw。
function classifyMakeTransitionEndpointCandidates(text) {
  const occurrences = findNonCommentCalls(text, 'makeTransitionEndpoint');
  const registrations = [];
  let declSeen = false;
  for (const occ of occurrences) {
    if (isPrecededByFunctionKeyword(text, occ.nameStart)) { declSeen = true; continue; }
    const closeParenPos = skipBalanced(text, occ.parenPos);
    const argsText = text.slice(occ.parenPos + 1, closeParenPos - 1);
    const argTokens = splitTopLevel(argsText);
    if (argTokens.length === 1) {
      const m = argTokens[0].text.match(/^'([\w-]+)'$/);
      if (m) { registrations.push(m[1]); continue; }
    }
    const lineNo = text.slice(0, occ.nameStart).split('\n').length;
    throw new Error(
      `classifyMakeTransitionEndpointCandidates: index.js:${lineNo} 处 makeTransitionEndpoint(...) 调用` +
      `既非函数声明也非 makeTransitionEndpoint('literal') 单参字面量注册形态（实参="${argsText}"）——` +
      `需要人工核实并扩展解析器，不能静默漏检。`
    );
  }
  if (!declSeen) throw new Error('classifyMakeTransitionEndpointCandidates: 未找到 makeTransitionEndpoint 函数声明本体——源码结构可能已变');
  return registrations;
}
// [B5·MED-1b] 归类 sysIssueTransition 的全部非注释命中：声明本体 / factory 泛型中继 / 字面量动作调用。归不了类 throw。
function classifySysIssueTransitionCandidates(text) {
  const occurrences = findNonCommentCalls(text, 'sysIssueTransition');
  const directLiterals = [];
  let declSeen = false;
  let relaySeen = false;
  for (const occ of occurrences) {
    if (isPrecededByFunctionKeyword(text, occ.nameStart)) { declSeen = true; continue; }
    const closeParenPos = skipBalanced(text, occ.parenPos);
    const argsText = text.slice(occ.parenPos + 1, closeParenPos - 1);
    const argTokens = splitTopLevel(argsText);
    const first = argTokens[0] ? argTokens[0].text : '';
    const second = argTokens[1] ? argTokens[1].text : '';
    if (first === 'id' && second === 'action') { relaySeen = true; continue; }
    if (first === 'id') {
      const m = second.match(/^'([\w-]+)'$/);
      if (m) { directLiterals.push(m[1]); continue; }
    }
    const lineNo = text.slice(0, occ.nameStart).split('\n').length;
    throw new Error(
      `classifySysIssueTransitionCandidates: index.js:${lineNo} 处 sysIssueTransition(...) 调用既非函数声明、` +
      `非 factory 泛型中继形态 sysIssueTransition(id, action, ...)、也非字面量动作调用 ` +
      `sysIssueTransition(id, 'literal', ...)（实参="${argsText}"）——需要人工核实并扩展解析器，不能静默漏检。`
    );
  }
  if (!declSeen) throw new Error('classifySysIssueTransitionCandidates: 未找到 sysIssueTransition 函数声明本体——源码结构可能已变');
  if (!relaySeen) throw new Error('classifySysIssueTransitionCandidates: 未找到 sysIssueTransition 的 factory 泛型中继调用形态（makeTransitionEndpoint 内部应有一处）——源码结构可能已变');
  return directLiterals;
}

function deriveEngineReachableActions(text, transitionsText) {
  const viaFactory = classifyMakeTransitionEndpointCandidates(text);
  const viaDirect = classifySysIssueTransitionCandidates(text);
  const candidates = [...new Set([...viaFactory, ...viaDirect])];

  const results = [];
  const unreachable = [];
  for (const action of candidates) {
    const esc = action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`action:\\s*'${esc}'`, 'g');
    const entries = [];
    let m;
    while ((m = re.exec(transitionsText))) {
      const start = m.index + m[0].length;
      const nextActionIdx = transitionsText.indexOf('action:', start);
      const windowEnd = nextActionIdx === -1 ? transitionsText.length : nextActionIdx;
      const win = transitionsText.slice(start, windowEnd);
      const teM = win.match(/timelineEvent:\s*(null|'[^']*')/);
      const acM = win.match(/actionCode:\s*(null|'[^']*')/);
      if (!teM || !acM) throw new Error(`transitions.js action='${action}' 条目缺 timelineEvent/actionCode 字段（窗口解析失败）`);
      entries.push({
        timelineEvent: teM[1] === 'null' ? null : teM[1].slice(1, -1),
        actionCode: acM[1] === 'null' ? null : acM[1].slice(1, -1),
      });
    }
    if (entries.length === 0) { unreachable.push(action); continue; }
    const uniq = [...new Set(entries.map(e => e.timelineEvent + '|' + e.actionCode))];
    if (uniq.length > 1) throw new Error(`action='${action}' 在 transitions.js 多个 type 表中 timelineEvent/actionCode 不一致：${JSON.stringify(entries)}`);
    results.push({ action, timelineEvent: entries[0].timelineEvent, actionCode: entries[0].actionCode, tableHits: entries.length });
  }
  return { results, unreachable, candidateCount: candidates.length, viaFactory, viaDirect };
}

// ── [B5·两组变异自证] MED-1a（反引号换行 INSERT）与 MED-1b（sysIssueTransition 首参非 id 的直调）
//   均应触发报错而非静默漏检——用合成假源码直接驱动被加固的函数，不依赖真实 index.js 里恰好没有这类
//   写法（那只能证明"目前没撞上"，证不了"撞上了会被拦住"）。
function selfTestFailClosedVariants() {
  // 变异①（MED-1a）：INSERT 前一字符不是反引号（模拟"反引号后换行"写法）。
  {
    const fakeSrc = "      await dbRunAsync(\n        `\nINSERT INTO sys_issue_timeline (issue_id) VALUES (?)`,\n        [1]\n      );\n";
    let threw = false, msg = '';
    try { locateRealInsertSites(fakeSrc); } catch (e) { threw = true; msg = e.message; }
    if (!threw) fail('MED-1a 变异自证失败：反引号换行形态的假 INSERT 未触发报错，静默漏检的口子没被堵住');
    ok(`MED-1a 变异自证通过：反引号换行 INSERT（非注释、紧邻前一字符非反引号）正确触发解析器报错——"${msg.slice(0, 50)}..."`);
  }
  // 变异②（MED-1b）：sysIssueTransition 直调但首参不是 id（模拟换了个变量名当第一实参）。
  {
    const fakeSrc2 = [
      'async function sysIssueTransition(issueId, action, expectedFromStatus, actor, payload = {}, opts = {}) { }',
      'function makeTransitionEndpoint(action) {',
      '  return async (req, res) => {',
      "    const r = await sysIssueTransition(id, action, null, actor, req.body || {});",
      '  };',
      '}',
      'async function someOtherHandler(req, res) {',
      "  const bad = await sysIssueTransition(notId, 'weird_action', null, actor, req.body || {});",
      '}',
    ].join('\n');
    let threw2 = false, msg2 = '';
    try { classifySysIssueTransitionCandidates(fakeSrc2); } catch (e) { threw2 = true; msg2 = e.message; }
    if (!threw2) fail("MED-1b 变异自证失败：sysIssueTransition(notId, 'weird_action', ...) 首参非 id 的直调未触发报错，被静默漏出候选集之外");
    ok(`MED-1b 变异自证通过：sysIssueTransition 首参非 id 的直调正确触发分类器报错——"${msg2.slice(0, 50)}..."`);
  }
}

// ── [B7·328a 回卷] 块注释变异自证：块注释内的 INSERT/sysIssueTransition 调用不得进候选集 ──────
//   isInLineComment 换成 buildCommentMask 之前，块注释是完全测不出的盲区（旧名字就叫 isIn**Line**Comment）
//   ——若真实代码里出现过一段 `/* 临时禁用: INSERT INTO sys_issue_timeline ... */` 这样的块注释掉的旧
//   写法，locateRealInsertSites 会把它当成"真实但反引号缺失"的写入点误报（甚至可能因为反引号判定失败
//   直接 throw 假报警）；同理 `/* return sysIssueTransition(id, 'ghost_action', ...); */` 若被块注释掉，
//   classifySysIssueTransitionCandidates 会把 'ghost_action' 误采集进候选集，污染引擎可达动作集合。
//   本组各自构造"块注释内一个假站点 + 块注释外一个真站点"的双控形态（正/反例同源，比单纯"断言排除"更
//   强——若解析器整个失灵导致两个站点都漏掉，正例控制会先报错拦下，不会被误判成"负例过了"）。
function selfTestBlockCommentExclusion() {
  // 控制组①：locateRealInsertSites——块注释内的 INSERT 语句不得进候选集，块注释外的真实站点必须进。
  {
    const fakeInsertSrc = [
      'async function noop(id) {',
      '  /* 临时禁用（历史遗留，未删除）：',
      '  await dbRunAsync(',
      '    `INSERT INTO sys_issue_timeline (issue_id, event_type, action_code) VALUES (?, ?, ?)`,',
      "    [id, 'status_change', 'ghost_action']",
      '  );',
      '  */',
      '  await dbRunAsync(',
      '    `INSERT INTO sys_issue_timeline (issue_id, event_type, action_code) VALUES (?, ?, ?)`,',
      "    [id, 'status_change', 'real_action']",
      '  );',
      '  return 1;',
      '}',
    ].join('\n');
    const sites = locateRealInsertSites(fakeInsertSrc);
    if (sites.length !== 1) {
      fail(`块注释变异自证失败（locateRealInsertSites）：期望恰 1 个真实站点（块注释内的应被排除，块注释外的应保留），实得 ${sites.length} 个：${JSON.stringify(sites)}`);
    }
  }
  // 控制组②：classifySysIssueTransitionCandidates——块注释内的字面量 action 不得进候选集，块注释外的真实字面量必须进。
  {
    const fakeTransitionSrc = [
      'async function sysIssueTransition(issueId, action, expectedFromStatus, actor, payload = {}, opts = {}) { }',
      'function makeTransitionEndpoint(action) {',
      '  return async (req, res) => {',
      "    const r = await sysIssueTransition(id, action, null, actor, req.body || {});",
      '  };',
      '}',
      '/* 已废弃分支，暂时注释掉，未删除：',
      "  return sysIssueTransition(id, 'ghost_transition_action', null, actor, req.body || {});",
      '*/',
      "sysIssueTransition(id, 'real_transition_action', null, actor, req.body || {});",
    ].join('\n');
    const candidates = classifySysIssueTransitionCandidates(fakeTransitionSrc);
    if (!candidates.includes('real_transition_action')) {
      fail(`块注释变异自证失败（classifySysIssueTransitionCandidates）：块注释外的真实字面量调用未被采集，实得 ${JSON.stringify(candidates)}`);
    }
    if (candidates.includes('ghost_transition_action')) {
      fail(`块注释变异自证失败（classifySysIssueTransitionCandidates）：块注释内的字面量 action 被误采集进候选集，实得 ${JSON.stringify(candidates)}`);
    }
  }
  ok('块注释变异自证通过：locateRealInsertSites 与 classifySysIssueTransitionCandidates 均正确排除块注释内的 INSERT/sysIssueTransition 调用，同时保留块注释外的真实站点（isInCommentRange 统一化后块注释不再是盲区）');
}

// [B7·328a 回卷] 校验一张标签表某个 key 对应的 value 表达式是简单非空字符串字面量——两张标签表
//   （SI_TL_LABEL/SI_TL_RELEASE_SCOPE_LABEL）按设计恒是 "code: '人话标签'" 的纯字符串映射，不该出现
//   表达式/函数/空字符串这类会让 siRenderTimeline 显示出空白或裸代码的形态。空字符串比"没这个 key"更
//   隐蔽——后者会被主覆盖断言当缺口直接翻红，前者却能通过"key 存在"的检查，实际显示出的是空白标签。
function validateLabelValueShape(key, rawValueText, constName) {
  const v = rawValueText.trim();
  const m = v.match(/^'([^']*)'$/) || v.match(/^"([^"]*)"$/);
  if (!m) {
    throw new Error(`extractObjectKeys(${constName}): key "${key}" 的 value 不是简单字符串字面量（实际="${v.slice(0, 60)}"）——两张标签表按设计恒是纯字符串映射，出现表达式/函数值需要人工核实并扩展解析器`);
  }
  if (m[1].trim() === '') {
    throw new Error(`extractObjectKeys(${constName}): key "${key}" 的 value 是空字符串或全空白——标签表的显示文本不该为空，可能是数据错误`);
  }
}

// ── ② 前端侧：解析 SI_TL_LABEL / SI_TL_RELEASE_SCOPE_LABEL 两张表的 key 集合 ─────────────
//   [B5·LOW-2 加固，基于主会话已落的剥注释单点修通用化，不回退]：
//     · 剥注释复用 stripComments（字符串字面量安全，比原地正则 `t.text.replace(/\/\/[^\n]*/g,'')`
//       更不容易误伤——虽然本文件当前的标签值都不含 //，仍统一到一份有对照自证的实现）。
//     · 兼容引号键 'x': / "x":（此前只认裸标识符键，引号键会静默丢弃）。
//     · 对剥注释后仍无法识别的顶层 token 报错，而不是静默跳过——纯注释残留（剥完是空串）除外，那不是
//       "无法识别的键"，是本来就没有键。
//   [B7·328a 回卷] 补 value 形状断言：此前只解析/校验了 key，value 部分被直接丢弃——若某个 key 的 value
//   是空字符串（如手误 `foo: ''`），旧实现照样把 key 加入 labelKeys 集合，主覆盖断言就会误判"foo 已被
//   前端覆盖"，实际前端渲染出的是空白标签。见下方 validateLabelValueShape。
function extractObjectKeys(text, constName) {
  const declNeedle = `const ${constName} = {`;
  const declIdx = text.indexOf(declNeedle);
  if (declIdx === -1) throw new Error(`未找到 ${constName} 声明`);
  const braceIdx = declIdx + declNeedle.length - 1;
  const end = skipBalanced(text, braceIdx);
  const inner = text.slice(braceIdx + 1, end - 1);
  const keys = [];
  for (const t of splitTopLevel(inner)) {
    const cleaned = stripComments(t.text).trim();
    if (!cleaned) continue; // 纯注释残留（无实际键值内容），非"无法识别的 token"，跳过不算异常
    const mBare = cleaned.match(/^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]*)$/);
    if (mBare) { validateLabelValueShape(mBare[1], mBare[2], constName); keys.push(mBare[1]); continue; }
    const mQuoted = cleaned.match(/^(?:'([^']*)'|"([^"]*)")\s*:\s*([\s\S]*)$/);
    if (mQuoted) {
      const k = mQuoted[1] !== undefined ? mQuoted[1] : mQuoted[2];
      validateLabelValueShape(k, mQuoted[3], constName);
      keys.push(k);
      continue;
    }
    throw new Error(`extractObjectKeys(${constName}): 无法识别的顶层 token "${cleaned.slice(0, 60)}"（既非裸标识符键也非引号字符串键）——需要人工核实并扩展解析器，不能静默丢弃`);
  }
  return keys;
}

// ── ③ 对账规则：与 Sys_Iteration.html siRenderTimeline 的 key 计算逐字同源 ────────────────
function computeDisplayKey(eventType, actionCode, releaseScopeKeySet) {
  const hasActionCode = actionCode !== null && actionCode !== undefined && actionCode !== '';
  if (eventType === 'status_change' || eventType === 'release') return hasActionCode ? actionCode : eventType;
  if (eventType === 'scope_change') return (hasActionCode && releaseScopeKeySet.has(actionCode)) ? actionCode : 'scope_change';
  return eventType;
}

// ════════════════════════════════════════════════════════════════════════════════════════
// 主流程
// ════════════════════════════════════════════════════════════════════════════════════════

// [B5] 两组解析器自证（对照自证 + 变异自证）先跑——它们不依赖真实 index.js/HTML 的具体内容，
//   是"解析器本身对不对"的独立证据，放在使用真实数据之前，出错时诊断范围更收窄。
selfTestStripComments();
selfTestFailClosedVariants();
selfTestBlockCommentExclusion();

// [前端] 两张标签表
const labelKeys = new Set(extractObjectKeys(htmlSrc, 'SI_TL_LABEL'));
const releaseScopeKeys = new Set(extractObjectKeys(htmlSrc, 'SI_TL_RELEASE_SCOPE_LABEL'));
if (labelKeys.size < 20) fail(`SI_TL_LABEL 只解析到 ${labelKeys.size} 个 key，低于下限 20——前端文件结构可能已变，拒绝在不完整数据上作判`);
ok(`SI_TL_LABEL 解析到 ${labelKeys.size} 个 key（\u2265 20 下限）`);
if (releaseScopeKeys.size < 8) fail(`SI_TL_RELEASE_SCOPE_LABEL 只解析到 ${releaseScopeKeys.size} 个 key，低于下限 8`);
ok(`SI_TL_RELEASE_SCOPE_LABEL 解析到 ${releaseScopeKeys.size} 个 key（\u2265 8 下限）`);

// [后端] 直写站点数——[B7·328a 回卷] 改为显式基线，不再只设下限：下限检查只挡得住"少了"（漏检），挡不住
//   "多了"（新增站点悄悄溜过去没人看一眼语义）——两个方向都该有人工介入，不是本脚本能替你判断新站点该
//   不该纳入覆盖检查。数量漂移（无论增减）一律翻红，逼着改动者显式更新这个常量、同时读一遍新增/减少
//   站点的 event_type/action_code 语义。
const EXPECTED_INSERT_SITE_COUNT = 29;
const sites = locateRealInsertSites(indexSrc);
if (sites.length !== EXPECTED_INSERT_SITE_COUNT) {
  fail(
    `定位到 ${sites.length} 个真实 INSERT 写入点，与显式基线 ${EXPECTED_INSERT_SITE_COUNT} 不符（已排除 :5246 注释引用）——` +
    `新增或减少写入点都是有意义的语义变化，需人工核实新/删站点的 event_type/action_code 语义、更新本文件的 ` +
    `EXPECTED_INSERT_SITE_COUNT 常量、并同步更新码表说明文档（docs/local/系统迭代/时间线写入点码表_20260810.md），` +
    `不能只靠下限检查悄悄放过数量漂移。`
  );
}
ok(`定位到 ${sites.length} 个真实 INSERT 写入点（显式基线 ${EXPECTED_INSERT_SITE_COUNT}，已排除 :5246 注释引用）`);

const producedKeys = new Map(); // key -> Set(provenance)
function addProduced(key, provenance) {
  if (!producedKeys.has(key)) producedKeys.set(key, new Set());
  producedKeys.get(key).add(provenance);
}

let engineSiteLabel = null;
let directSiteCount = 0;
for (const site of sites) {
  const analyzed = analyzeInsertSite(indexSrc, site);
  const evExpr = analyzed.eventType.present ? analyzed.eventType.expr.trim() : null;
  if (evExpr === 'transition.timelineEvent') {
    engineSiteLabel = site.label; // 引擎写点，交给下方 deriveEngineReachableActions() 统一处理
    continue;
  }
  directSiteCount++;
  const evCandidates = candidatesFor(analyzed.eventType, `${site.label}/event_type`, site.idx);
  const acCandidates = candidatesFor(analyzed.actionCode, `${site.label}/action_code`, site.idx);
  for (const et of evCandidates) {
    if (et === null || et === undefined) throw new Error(`${site.label}: event_type 解析为空——异常（event_type 列不应能删除）`);
    for (const ac of acCandidates) {
      addProduced(computeDisplayKey(et, ac, releaseScopeKeys), site.label);
    }
  }
}
if (!engineSiteLabel) fail('未在 29 个写入点中找到引擎写点（event_type=transition.timelineEvent 的那一条）——源码结构可能已变');
ok(`${directSiteCount} 个非引擎写入点解析完成，引擎写点定位于 ${engineSiteLabel}`);

// [后端] 引擎可达动作
const engine = deriveEngineReachableActions(indexSrc, transitionsSrc);
if (engine.results.length < 14) fail(`引擎可达动作只有 ${engine.results.length} 个，低于下限 14`);
for (const r of engine.results) {
  addProduced(computeDisplayKey(r.timelineEvent, r.actionCode, releaseScopeKeys), `引擎:${engineSiteLabel} action=${r.action}（命中${r.tableHits}张表）`);
}
ok(`引擎可达动作 ${engine.results.length} 个（\u2265 14 下限）：${engine.results.map(r => r.action).sort().join('/')}`);
if (engine.unreachable.length > 0) {
  ok(`引擎候选中 ${engine.unreachable.length} 个经 transitions.js 交叉验证为不可达（无对应 action 条目）：${engine.unreachable.join('/')}——属死代码，不计入覆盖检查`);
}

console.log(`\n  \u2192 后端共产出 ${producedKeys.size} 个不重复 display key（字段直写 + 引擎可达合并）`);

// KNOWN_GAPS：〔2026-08-10 F4 清零〕原 9 项缺映射码已全部由 F4 补进 SI_TL_LABEL（含 change_intake_mode
//   存量兜底标签），本数组按设计清空——自此任何新缺口都会被主覆盖断言直接翻红，不再有 allowlist 缓冲。
//   若未来某码需要临时豁免，按 { key, reachable, source } 格式登记并注明清零责任方。
const KNOWN_GAPS = [];

for (const g of KNOWN_GAPS) {
  if (labelKeys.has(g.key) || releaseScopeKeys.has(g.key)) {
    fail(`allowlist 过期："${g.key}" 已在前端标签表中找到映射，请从 KNOWN_GAPS 中删除该项（F4 补映射后的预期动作）`);
  }
  if (g.reachable && !producedKeys.has(g.key)) {
    fail(`allowlist 过期："${g.key}" 不再出现在后端可产出的 key 集合中（代码可能已重构），请确认后从 KNOWN_GAPS 中删除`);
  }
}
ok(`KNOWN_GAPS ${KNOWN_GAPS.length} 项全部双向断言通过（当前应为空——F4 已清零，无 allowlist 缓冲）`);

// 主覆盖断言：producedKeys \ (labelKeys ∪ releaseScopeKeys ∪ KNOWN_GAPS) 必须为空——
//   非空即"新长出的缺口"，翻红拦截。
const knownGapKeySet = new Set(KNOWN_GAPS.map(g => g.key));
const newGaps = [];
for (const [key, provenance] of producedKeys) {
  const covered = labelKeys.has(key) || releaseScopeKeys.has(key);
  const known = knownGapKeySet.has(key);
  if (!covered && !known) newGaps.push({ key, provenance: [...provenance] });
}
if (newGaps.length > 0) {
  const detail = newGaps.map(g => `  - "${g.key}"（来源：${g.provenance.join('; ')}）`).join('\n');
  fail(`发现 ${newGaps.length} 个不在标签表也不在 KNOWN_GAPS 的新缺口（回归）：\n${detail}`);
}
ok(`主覆盖断言通过：全部 ${producedKeys.size} 个写入点 display key \u2286 前端标签表并集 \u222a KNOWN_GAPS（无新缺口）`);

// [B5·LOW-3b] "待 F4 清零" 字样已过时（KNOWN_GAPS 已清零）——改三元：仅当 KNOWN_GAPS 非空时才附临时
//   豁免提示，为空时不再暗示"还有事没做完"。
const gapSuffix = KNOWN_GAPS.length > 0 ? `，含 ${KNOWN_GAPS.length} 项临时豁免待清零` : '';
console.log(`\n[全部通过] ${passed}/${passed} \u2713 时间线写入码\u2286标签表静态对账守卫通过（KNOWN_GAPS=${KNOWN_GAPS.length}${gapSuffix}）`);
