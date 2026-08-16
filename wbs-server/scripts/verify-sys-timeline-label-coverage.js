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
//     note + action_code='assign_overdue_eta' → key = action_code（[MED-2·组A] /reassign 端点 ETA
//       变更留痕的独立徽章 carve-out，同 scope_change 一个模式，不逐个引入新徽章制造噪音）
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

// ── ②b 前端侧：解析 `const NAME = new Set([...]);` 字符串字面量成员集合 ───────────────────
//   [预筛 MED-5] 消灭 NOTE_OWN_LABEL_ACTION_CODES 的"第二份硬编码"风险——本文件（下方 §③）与
//   Sys_Iteration.html 的 SI_TL_NOTE_OWN_LABEL_CODES 各自独立维护同一份"note 型事件独立徽章白名单"，
//   此前只靠人工同步的注释提醒对方"改一处必须同改另一处"，没有可执行断言兜底——两处一旦漂移，
//   静态守卫看不见（producedKeys 是从后端源码算出来的 display key，只要那个 key 恰好也在 labelKeys
//   里就会绿，不管前端是否真把它当"独立徽章"渲染），只能等真人在页面上肉眼发现"这条本该有专属徽章却
//   显示成裸备注"。本函数把前端那份 Set 字面量解析出来，主流程与本文件的 NOTE_OWN_LABEL_ACTION_CODES
//   做集合相等断言，堵死这类静默漂移。
//   解析骨架复用 extractObjectKeys 同款纪律：skipBalanced 定位 `[...]` 边界、splitTopLevel 按顶层逗号
//   切分、stripComments 剥注释、非字符串字面量成员一律 throw（不静默丢弃）、解析到 0 个成员同样 throw
//   （fail-closed——本函数存在的意义就是"能读到真值才能比对"，读不到不能悄悄放行当作"集合为空即相等"）。
function extractSetLiteralStrings(text, constName) {
  const declNeedle = `const ${constName} = new Set([`;
  const declIdx = text.indexOf(declNeedle);
  if (declIdx === -1) throw new Error(`extractSetLiteralStrings(${constName}): 未找到 "const ${constName} = new Set([...])" 声明（声明写法可能已变，需要人工核实并扩展解析器）`);
  const bracketIdx = declIdx + declNeedle.length - 1;   // 指向开中括号 '['
  const end = skipBalanced(text, bracketIdx);
  const inner = text.slice(bracketIdx + 1, end - 1);
  const items = [];
  for (const t of splitTopLevel(inner)) {
    const cleaned = stripComments(t.text).trim();
    if (!cleaned) continue;   // 尾逗号/纯注释残留造成的空 token，非"无法识别的成员"
    const m = cleaned.match(/^'([^']*)'$/) || cleaned.match(/^"([^"]*)"$/);
    if (!m) throw new Error(`extractSetLiteralStrings(${constName}): 无法识别的顶层 token "${cleaned.slice(0, 60)}"（既非单引号也非双引号字符串字面量）——需要人工核实并扩展解析器，不能静默丢弃`);
    if (m[1].trim() === '') throw new Error(`extractSetLiteralStrings(${constName}): 出现空字符串成员——action_code 不应为空，可能是数据错误`);
    items.push(m[1]);
  }
  if (items.length === 0) throw new Error(`extractSetLiteralStrings(${constName}): 解析到 0 个成员——声明可能已变为空 Set 或解析失败，拒绝在空数据上继续判断`);
  return items;
}

// ── ③ 对账规则：与 Sys_Iteration.html siRenderTimeline 的 key 计算逐字同源 ────────────────
//   [MED-2·组A + 组B 扩] note 型事件的独立徽章 carve-out——action_code ∈ NOTE_OWN_LABEL_ACTION_CODES
//   时取自己的 key，其余 note 仍落回通用 'note'。与 scope_change 的 isReleaseScope carve-out 同一模式，
//   前端 SI_TL_NOTE_OWN_LABEL_CODES / isNoteWithOwnLabel 逐字同构（改一处必须同改另一处）。
//   集合成员：assign_overdue_eta（/reassign 端点 ETA 变更留痕，见 index.js "[MED-2·收口]" 注释）+
//   [组B] fast_release_authorize / fast_release_revoke（bug 先行上线授权/撤销，方案 v1.3 §3.1）。
// [S3·§5] +fast_release_exec_confirm（先行上线执行确认，event_type='note'，同 fast_release_staged 一带
//   模式）——fast_release_exec_online 刻意**不登记**：该码 event_type='status_change'（同 W-GATE 完成态
//   镜像范式），走独立于本 Set 的另一条渲染路径，登记进来不生效反而误导。
// [S4·§4-4a/4b·2026-08-14] +fast_release_roster_added / fast_release_roster_removed（admin 集合调整·
//   加人/移人，均 event_type='note'，同 fast_release_staged/_exec_confirm 一带模式）。
// [S5·§4-5/§4-6/§4-7·2026-08-14] +fast_release_roster_cleared（六码族第六码，撤销/五事件终结/批次发布
//   双保险点共用同一实现 clearFastReleaseRosterOnTermination，event_type='note'，同上模式）。
// [方案 §13·13.1·2026-08-14] +eta_auto_from_deadline/eta_auto_sla（feature ETA 直取/回退 SLA 独立留痕，
//   均 event_type='note'，同上模式——与既有码不同之处：本两码刻意登记专属标签，服务§13.1"对接人知情"
//   诉求，见 index.js 该两处 INSERT 前的注释）。
// [方案 §14·S11·2026-08-14] +completion_overrun_reason（feature 超期完成理由闸独立留痕行，均
//   event_type='note'，两处写点：case 'liaison_test_pass' + runWGate feature⑤⑥降级路径，同上模式）。
const NOTE_OWN_LABEL_ACTION_CODES = new Set(['assign_overdue_eta', 'fast_release_authorize', 'fast_release_revoke', 'fast_release_staged', 'fast_release_exec_confirm', 'fast_release_roster_added', 'fast_release_roster_removed', 'fast_release_roster_cleared', 'post_release_accept_pass', 'post_release_accept_fail', 'eta_auto_from_deadline', 'eta_auto_sla', 'completion_overrun_reason', 'fast_release_auth_expired']);
function computeDisplayKey(eventType, actionCode, releaseScopeKeySet) {
  const hasActionCode = actionCode !== null && actionCode !== undefined && actionCode !== '';
  if (eventType === 'status_change' || eventType === 'release') return hasActionCode ? actionCode : eventType;
  if (eventType === 'scope_change') return (hasActionCode && releaseScopeKeySet.has(actionCode)) ? actionCode : 'scope_change';
  if (eventType === 'note' && hasActionCode && NOTE_OWN_LABEL_ACTION_CODES.has(actionCode)) return actionCode;
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

// [预筛 MED-5] 前端 SI_TL_NOTE_OWN_LABEL_CODES 与本文件 NOTE_OWN_LABEL_ACTION_CODES 集合相等（双向）——
//   与上方 computeDisplayKey 用的同一个常量对账，任何一侧漏改/多改都会在此翻红，消灭"第二份硬编码"
//   静默漂移的风险（两处各自独立维护同一份 note carve-out 白名单，此前只靠人工同步注释）。
{
  const htmlNoteOwnLabelCodes = new Set(extractSetLiteralStrings(htmlSrc, 'SI_TL_NOTE_OWN_LABEL_CODES'));
  const backendSet = [...NOTE_OWN_LABEL_ACTION_CODES].sort();
  const frontendSet = [...htmlNoteOwnLabelCodes].sort();
  const mismatched = backendSet.length !== frontendSet.length || backendSet.some((v, i) => v !== frontendSet[i]);
  if (mismatched) {
    fail(`SI_TL_NOTE_OWN_LABEL_CODES（前端 Sys_Iteration.html）与 NOTE_OWN_LABEL_ACTION_CODES（本文件）集合不相等——两处必须逐字同步，实得 前端=${JSON.stringify(frontendSet)} 本文件=${JSON.stringify(backendSet)}`);
  }
  ok(`SI_TL_NOTE_OWN_LABEL_CODES 前端 Set 字面量解析成功（${frontendSet.length} 个成员）且与本文件 NOTE_OWN_LABEL_ACTION_CODES 集合相等：${JSON.stringify(frontendSet)}`);
}

// [后端] 直写站点数——[B7·328a 回卷] 改为显式基线，不再只设下限：下限检查只挡得住"少了"（漏检），挡不住
//   "多了"（新增站点悄悄溜过去没人看一眼语义）——两个方向都该有人工介入，不是本脚本能替你判断新站点该
//   不该纳入覆盖检查。数量漂移（无论增减）一律翻红，逼着改动者显式更新这个常量、同时读一遍新增/减少
//   站点的 event_type/action_code 语义。
// [组A·2.3] 29 → 30：/reassign 端点新增 1 个 sys_issue_timeline INSERT 站点（超时指派/人工设定命中
//   时才写）。[LOW-1·组A预筛修复批2 订正] 该站点实际写入 event_type='note'、action_code=
//   'assign_overdue_eta'——独立徽章 key（本文件 computeDisplayKey 对 note+assign_overdue_eta 直接
//   返回 action_code 本身，非复用既有 'estimate' 展示），见 index.js /sys-issues/:id/reassign 内
//   "[HIGH-1]"/"[MED-2·收口]" 注释块（该站点最初设计为 event_type='estimate'，落地时因与前端
//   siRenderTimeline 对 'estimate' 的"裸值契约"冲突改为 'note'，此处旧注释此前一直写着已废弃的
//   'estimate' 描述，未同步更新——本次一并订正）。intake_accept（折叠进既有引擎写点 summary）与
//   /assign（折叠进既有 assign timeline 行 summary）均未新增站点。
// [组B·2026-08-12] 30 → 32：新增两个自定义端点 POST /sys-issues/:id/fast-release-authorize 与
//   POST /sys-issues/:id/fast-release-revoke（方案 v1.3 §3.1），各自一条直写 INSERT（event_type=
//   'note'、action_code='fast_release_authorize'/'fast_release_revoke'），同 set_oa_number/
//   set_scheduled_start 既有"自定义端点直写 timeline"范式，非引擎写点。两个 action_code 均已登记进
//   NOTE_OWN_LABEL_ACTION_CODES（独立徽章，见上方 computeDisplayKey）+ Sys_Iteration.html 的
//   SI_TL_LABEL/SI_TL_NOTE_OWN_LABEL_CODES，主覆盖断言自然通过，不落入 KNOWN_GAPS。
// [组B·SB2·2026-08-13] 32 → 33：submit 端点 direct_release=true 分支新增 1 条直写 INSERT（event_type=
//   'status_change'、action_code='fast_release_direct_online'，方案 v1.3 §3.2）——同 runWGate 的 W-GATE
//   镜像行范式（event_type='status_change'），但本条不经 runWGate（direct_release 路径自成一路，不调用
//   runWGate，见 index.js submit 端点内 [组B·SB2] 注释），是独立于引擎写点（sysIssueTransition 内那条
//   `event_type: transition.timelineEvent` 参数化写点）与 W-GATE 写点（:3049 一带 `event_type: 'status_change',
//   ...action_code: mirrorActionCode`）之外的**第三处** status_change 直写站点。event_type/action_code
//   均为 SQL 内字面量（不经变量绑定，理由见 index.js SYS_FAST_RELEASE_DIRECT_ONLINE_SUMMARY 定义处注释），
//   按 computeDisplayKey 规则（status_change 有 action_code 时取 action_code 本身）不落入 note 型 carve-out
//   （NOTE_OWN_LABEL_ACTION_CODES 无需登记本码），已登记进 Sys_Iteration.html 的 SI_TL_LABEL（独立词条
//   '先行上线直上'），主覆盖断言自然通过，不落入 KNOWN_GAPS。
// [组B·SB3·2026-08-13] 33 → 35：新增 POST /sys-issues/:id/post-release-accept 端点，pass/fail 两分支
//   各自一条直写 INSERT（event_type='note'，action_code 分别为 'post_release_accept_pass'/
//   'post_release_accept_fail'，方案 v1.3 §3.3），同 fast-release-authorize/-revoke 既有"自定义端点直写
//   timeline"范式（非引擎写点）。derive 端点的原有 2 条 INSERT（'created'+'derive'）被抽成共享函数
//   insertDerivedSysIssue 供本端点 fail 分支复用——**源码文本层面仍各只出现一次**（函数体只写一遍，
//   被两个调用点共同调用），故这次重构本身对本文件的"静态源码位置计数"零净变化，真正新增的只有上述
//   2 条 note 型 INSERT。两个新 action_code 均已登记进 NOTE_OWN_LABEL_ACTION_CODES（独立徽章，见上方
//   computeDisplayKey）+ Sys_Iteration.html 的 SI_TL_LABEL/SI_TL_NOTE_OWN_LABEL_CODES，主覆盖断言自然
//   通过，不落入 KNOWN_GAPS。
// [组B·B1·授权终结事件制·2026-08-13] 35 → 37：三事件（验收通过/验收打回/上线翻牌）终结活跃先行上线
//   授权新增 2 条直写 INSERT（均 event_type='note'，action_code='fast_release_auth_terminated'）——
//   ① sysIssueTransition 引擎内 case 'accept'/'return' 共用的 post-processing 追加写点（[7] 主 timeline
//   写入之后，命中时补一条，见 index.js "fastReleaseTerminationSummary" 一带）；② _publishReleaseCoreInTxn
//   批次发布内新增的 H-3 步骤2.5，覆盖"批内成员携带未消费活跃授权、随批量翻牌一并终结"这条边。两处均
//   非引擎主写点（引擎主写点是既有那条 event_type=transition.timelineEvent 的参数化站点，未改动），
//   是独立于 fast-release-authorize/-revoke/post_release_accept_pass/_fail 之外的**第五个**"自定义端点
//   /引擎内按需追加直写 timeline"站点。⚠️ 本 action_code **刻意不登记进** NOTE_OWN_LABEL_ACTION_CODES
//   （与前四个既有 note 型独立徽章码不同）——落回 event_type='note' 的通用标签即可（summary 本身已是
//   完整可读文案），不为一条新徽章改动 public/Sys_Iteration.html（本批不碰前端静态资产），故不影响
//   SI_TL_LABEL/SI_TL_NOTE_OWN_LABEL_CODES 两张前端表，主覆盖断言按 computeDisplayKey 规则自然落回
//   'note' 这个已在表内的既有 key，不落入 KNOWN_GAPS。
// [组B·S2·先行上线两步化 S2-1 挂牌+S2-2 拆直上分支·2026-08-14] 37 → 37（净零变化，成分置换非"没动"）：
//   ① **减 1**：原 [组B·SB2·2026-08-13] 记的那条 submit direct_release=true 分支直写 INSERT
//   （event_type='status_change'，action_code='fast_release_direct_online'）已随两步化方案 §4-2
//   「整体替代」拍板整体拆除（S2-2）——该单步直上路径不复存在，SI_TL_LABEL 对应词条同批删除。
//   ② **加 1**：submit 端点新增挂牌逻辑（S2-1，方案 §4-1）——花名册全完成、主状态真正翻到「待验证」
//   且该单存在活跃先行上线授权时，同事务写一条 event_type='note'、action_code='fast_release_staged'
//   的直写 INSERT（同 fast-release-authorize/-revoke 既有"自定义端点/引擎内按需追加直写 timeline"
//   范式，非引擎写点），已登记进 NOTE_OWN_LABEL_ACTION_CODES（独立徽章）+ Sys_Iteration.html 的
//   SI_TL_LABEL/SI_TL_NOTE_OWN_LABEL_CODES，主覆盖断言自然通过，不落入 KNOWN_GAPS。两处改动经本守卫
//   实际解析确认：站点总数仍为 37（本行更新前已实跑验证，非手数推断）。
// [S3·先行上线两步化确认端点+共享翻牌内核·2026-08-14] 37 → 39：新增 2 条直写 INSERT——
//   ① 确认端点（POST /sys-issues/:id/fast-release-exec-confirm）非末位路径写一条 event_type='note'、
//   action_code='fast_release_exec_confirm' 的独立徽章行（同 fast-release-authorize/-revoke/
//   fast_release_staged 既有"自定义端点直写 timeline"范式，非引擎写点），已登记进
//   NOTE_OWN_LABEL_ACTION_CODES + Sys_Iteration.html 的 SI_TL_LABEL/SI_TL_NOTE_OWN_LABEL_CODES；
//   ② 共享翻牌内核（attemptFastReleaseFlipInTxn）末位路径写一条 event_type='status_change'、
//   action_code='fast_release_exec_online' 的镜像行（同 W-GATE 完成态镜像范式），按 computeDisplayKey
//   规则（status_change 有 action_code 时取 action_code 本身）不落入 note 型 carve-out（无需登记进
//   NOTE_OWN_LABEL_ACTION_CODES，同 S2 已删的 fast_release_direct_online 旧码同款处置），已登记进
//   SI_TL_LABEL 独立词条'先行上线翻牌上线'。两处改动经本守卫实际解析确认：站点总数 37→39（本行更新前
//   已实跑验证，非手数推断）。
// [S4·§4-4a/4b 执行人集合调整（admin 加人/移人）·2026-08-14] 39 → 41：新增 2 条直写 INSERT——
//   ① 加人端点（POST /sys-issues/:id/fast-release-executors）成功后写一条 event_type='note'、
//   action_code='fast_release_roster_added' 的独立徽章行（同 fast-release-authorize/-revoke/
//   fast_release_staged/_exec_confirm 既有"自定义端点直写 timeline"范式，非引擎写点）；
//   ② 移人端点（DELETE /sys-issues/:id/fast-release-executors/:userId）成功后写一条 event_type='note'、
//   action_code='fast_release_roster_removed' 的独立徽章行（同上范式；若移人触发共享翻牌内核
//   attemptFastReleaseFlipInTxn 翻牌，该内核自身的 fast_release_exec_online 镜像行 INSERT 是既有站点
//   ②(37→39 那批)，非本批新增）。两码均已登记进 NOTE_OWN_LABEL_ACTION_CODES + Sys_Iteration.html 的
//   SI_TL_LABEL/SI_TL_CLS/SI_TL_NOTE_OWN_LABEL_CODES。本次改动经本守卫实际解析确认：站点总数 39→41
//   （本行更新前已实跑验证，非手数推断）。
// [S5·§4-5/§4-6/§4-7 撤销收紧+验收/打回闸+五事件终结延伸·2026-08-14] 41 → 42：新增 1 条直写
//   INSERT——共享清集合内核 clearFastReleaseRosterOnTermination（唯一实现）内一条 event_type='note'、
//   action_code='fast_release_roster_cleared' 的独立徽章行。⚠️ 本次调用点有五处（撤销端点
//   fast-release-revoke / 引擎共享后处理点覆盖 case 'accept'|'return'|'issue_reject'|'void' 四 case /
//   批次发布双保险点 _publishReleaseCoreInTxn），但**源码文本层面只有一条 INSERT 语句**（helper 函数
//   体内），本静态扫描按"源码文本站点数"计数（同 attemptFastReleaseFlipInTxn 的 fast_release_exec_online
//   INSERT 被确认/移人两端点共用、仍计 1 处站点的既有先例），故只 +1 非 +5。已登记进
//   NOTE_OWN_LABEL_ACTION_CODES + Sys_Iteration.html 的 SI_TL_LABEL/SI_TL_CLS/SI_TL_NOTE_OWN_LABEL_CODES。
//   本次改动经本守卫实际解析确认：站点总数 41→42（本行更新前已实跑验证，非手数推断）。
// [方案 §13·13.1 feature ETA 直取·2026-08-14] 42 → 44：新增 2 条直写 INSERT——case 'intake_accept'
//   引擎写点之外，独立补两条留痕行：event_type='note'、action_code='eta_auto_from_deadline'（feature 且
//   deadline 有效时直取分支）与 action_code='eta_auto_sla'（feature 回退 SLA 且系统自动生成子分支）。
//   两码互斥（同一次至多一条），故各自独立一条 INSERT 语句（非共享同一站点），故 +2 非 +1。已登记进
//   NOTE_OWN_LABEL_ACTION_CODES + Sys_Iteration.html 的 SI_TL_LABEL/SI_TL_CLS/SI_TL_NOTE_OWN_LABEL_CODES。
//   本次改动经本守卫实际解析确认：站点总数 42→44（本行更新前已实跑验证，非手数推断）。
// [方案 §14·S11 feature 超期完成理由闸·2026-08-13] 44 → 46：新增 2 条直写 INSERT——两处写点各自独立补
//   一条留痕行：event_type='note'、action_code='completion_overrun_reason'（case 'liaison_test_pass'
//   正常路径 + runWGate feature⑤⑥降级路径，两处结构上不会同一次都命中，但源码文本层面各自一条
//   INSERT 语句，故 +2 非 +1，同 §13 两码先例）。已登记进 NOTE_OWN_LABEL_ACTION_CODES +
//   Sys_Iteration.html 的 SI_TL_LABEL/SI_TL_CLS/SI_TL_NOTE_OWN_LABEL_CODES。本次改动经本守卫实际解析
//   确认：站点总数 44→46（本行更新前已实跑验证，非手数推断）。
// 【2026-08-14 S11 预筛订正·闸边迁移】46 → 45：case 'liaison_test_pass' 的 completion_overrun_reason
//   INSERT 已随闸边迁移整体删除（该动作"撤闸"，见 index.js 该处订正注释）——action_code 本身不退场
//   （runWGate 侧那一条留痕行原样保留，且判定覆盖面从"仅⑤⑥"扩到"⑤⑥⑦"三条开发侧边），只是从两个
//   源码站点各写一条收拢为一个站点独写一条，物理 INSERT 语句数量 -1。SI_TL_LABEL 等前端登记表不变
//   （action_code 集合未变，只是产出源收拢）。
// 【2026-08-14 codex 395 预筛 NEW-1】45 → 46：runWGate 新增分支③（非 submit 触发+理由缺失 → defer 挂起）
//   补一条独立 INSERT——action_code 仍是既有 'completion_overrun_reason'（不新增码），但这是**新的物理
//   INSERT 语句**（不同源码位置，与分支①的既有 INSERT 各自独立），故 +1。
// 【2026-08-16 先行上线授权超时收回 S1】46 → 48：新增 2 条直写 INSERT——
//   ① 幂等超时终结内核 terminateExpiredFastReleaseAuthInTxn（唯一实现）内一条 event_type='note'、
//   action_code='fast_release_auth_expired'（新码）的独立徽章行。⚠️ 本内核调用点有七处（挂牌闸/
//   exec-confirm/加人/移人/五事件调用层分叉/revoke 格4/重授权），但**源码文本层面只有一条 INSERT
//   语句**（helper 函数体内），本静态扫描按"源码文本站点数"计数（同 attemptFastReleaseFlipInTxn 的
//   fast_release_exec_online INSERT、clearFastReleaseRosterOnTermination 的 fast_release_roster_cleared
//   INSERT 既有先例），故只 +1 非 +7。【2026-08-16 S2 前端收口订正】该码在 S1 落地时尚未登记前端三表，
//   落回 event_type='note' 的通用标签（主覆盖断言按 computeDisplayKey 规则自然落回既有 'note' key，
//   不落入 KNOWN_GAPS）；S2 已补齐登记——SI_TL_LABEL/SI_TL_CLS/SI_TL_NOTE_OWN_LABEL_CODES 三处新增
//   fast_release_auth_expired 词条（Sys_Iteration.html），本文件下方 NOTE_OWN_LABEL_ACTION_CODES 同步
//   补齐（两处必须逐字同步，见下方 [预筛 MED-5] 双向核对断言）。
//   ② revoke 端点五格决策表格 5（跨轮旧授权残迹清理）新增**独立** INSERT 语句——action_code 仍是既有
//   'fast_release_revoke'（不新增码，summary 前缀"跨轮失效残迹清理"区分成因），但方案 §5⑥/420 收口
//   明令"禁复用格 2 那条带 NOT EXISTS done 的既有 SQL"（清理面 fail-open 语义与格 2 的既有防线冲突），
//   故格 5 走独立 UPDATE + 独立 INSERT，物理站点 +1 非复用既有站点。已在既有 NOTE_OWN_LABEL_ACTION_CODES/
//   SI_TL_LABEL 内（复用既有 'fast_release_revoke' 码词条，无需新增前端登记）。
//   两处改动经本守卫实际解析确认：站点总数 46→48。
//   ⚠️ 码表说明文档（docs/local/系统迭代/时间线写入点码表_20260810.md）本批未同步更新——本任务范围
//   明确限定"只做后端（index.js + scripts/ 下 verify），不碰 docs/"，该文档同步留给下一次触碰 docs/
//   的批次一并处理（含 fast_release_auth_expired 新码登记）。
const EXPECTED_INSERT_SITE_COUNT = 48;
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
// [LOW-1·组A预筛修复批2 订正] 原硬编码"29"是 EXPECTED_INSERT_SITE_COUNT 早期基线遗留字面量——
//   常量已在 :872 一带随 [组A·2.3] 由 29 bump 到 30，这条失败文案当时未同步改，与常量本身脱节
//   （两处各写一份数字，改一处忘改另一处的典型漂移）；改用变量引用后天然同步，未来常量再变不会
//   重蹈覆辙。
if (!engineSiteLabel) fail(`未在 ${EXPECTED_INSERT_SITE_COUNT} 个写入点中找到引擎写点（event_type=transition.timelineEvent 的那一条）——源码结构可能已变`);
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
