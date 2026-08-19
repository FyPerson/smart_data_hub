// verify-export-columns.js — 三模块列表导出 columns 配置静态守卫（暂缓与列表导出方案 v1.1 §3.5，编码任务 S4）
//
// 阶段声明（S4=脚手架+可跑框架）：本批只交付共享层 u-export.js + vendor + 本守卫框架，三页尚未接入
//   attachExport()（S5/S6 落地）。故本文件对"三页 columns 配置"的扫描面**当前会抓到 0 条**——这不是
//   守卫失效，是如实反映现状（框架已就位，S5/S6 接入后自动启用真实断言，本文件不必再改一行）。
//   为证明检测器本身确有判红能力（不是"因为没数据所以永远绿"的假通过），每条真实断言都配一组
//   **对照组自证**（构造违例样本喂检测器，断言必须判红），这是 S4 阶段"框架"两个字的实质。
//
// 覆盖（方案 §3.5）：
//   断言 1：无 value 列的 key + 全部 deps ⊆ 对应数据源字段集（corrections=列表投影 / sys-issues=投影段 /
//           collab=建表列全集 4 种形态并集）
//   断言 2：敏感黑名单（phone/dingtalk/notify/message_key/read_at）恒不出现在任何页 key/deps；
//           对照组：临时注入 requester_phone 列断言守卫判红
//   断言 3：三页配置结构一致（key/label 必有、value 有则 deps 有、key 配置内唯一）；按钮文案含「Excel」
//   断言 4：vendor 文件存在 + 三页引用带 ?v= 缓存串 + u-export.js 的 ?v= 尾缀与 KIT_VERSION 一致
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { findOuterBoundary } = require('./lib/sql-select-boundary');

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [OK] ${m}`); };
const bad = (m) => { fail++; console.log(`  [FAIL] ${m}`); };
const must = (cond, m) => cond ? ok(m) : bad(m);

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const ROUTES_CORR = fs.readFileSync(path.join(__dirname, '..', 'routes', 'corrections.js'), 'utf8');
const ROUTES_SI = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sys-iteration', 'index.js'), 'utf8');
const SERVER_JS = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// ============================================================
// 通用文本工具
// ============================================================
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '').replace(/([^:])\/\/.*$/gm, '$1');
}
function stripSqlLineComments(s) { return s.replace(/--.*$/gm, ''); }

// 给定"已定位到 FROM 之前"的 SELECT 列清单文本，做括号深度感知的顶层逗号切分，
// 收集裸列名 + `AS alias` 别名（同 verify-sys-list-badge-fields.js 的解析写法，本文件独立维护——
// 两处都是各自 verify 脚本的私有内部工具，非 scripts/lib/ 级别的跨文件复用，故不新抽公共库）。
function parseSelectColumns(selectBlockText) {
  const body = selectBlockText.replace(/^`SELECT/, '');
  let depth = 0, cur = '';
  const items = [];
  for (const ch of body) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { items.push(cur); cur = ''; } else cur += ch;
  }
  items.push(cur);
  const bare = new Set(), aliased = new Set(), unrecognized = [];
  for (const raw of items) {
    const t = raw.trim().replace(/\s+/g, ' ');
    if (!t) continue;
    if (/^[a-z_][a-z0-9_]*$/i.test(t)) { bare.add(t); continue; }
    const asM = t.match(/\bAS\s+([a-z_][a-z0-9_]*)\s*$/i);
    if (asM) { aliased.add(asM[1]); continue; }
    unrecognized.push(t);
  }
  return { bare, aliased, unrecognized };
}

// ============================================================
// 数据源字段集提取（三模块，逐 grep 定位、以当前代码为准——不手写枚举）
// ============================================================

function getCorrectionFields() {
  const startNeedle = '`SELECT id, source_system, source_system_other, location_info, correction_type, correction_count, status,';
  const start = ROUTES_CORR.indexOf(startNeedle);
  must(start > 0, '[数据源] 数据修正：列表投影 SELECT 可定位（GET /api/corrections）');
  if (start < 0) return null;
  const stripped = stripSqlLineComments(ROUTES_CORR.slice(start, start + 4000));
  const boundary = findOuterBoundary(stripped, 'FROM correction_requests');
  must(!boundary.wentNegative, '[数据源] 数据修正：边界扫描括号深度全程非负');
  must(boundary.index > 0, '[数据源] 数据修正：外层 FROM correction_requests 边界可定位');
  if (boundary.index <= 0) return null;
  const { bare, aliased, unrecognized } = parseSelectColumns(stripped.slice(0, boundary.index));
  must(unrecognized.length === 0, `[数据源] 数据修正：SELECT 列全部可解析（无法识别 ${unrecognized.length} 项${unrecognized.length ? '：' + JSON.stringify(unrecognized.slice(0, 3)) : ''}）`);
  const all = new Set([...bare, ...aliased]);
  must(all.size >= 20, `[数据源] 数据修正：列集合实抓 ${all.size} 个（过少=解析失败）`);
  console.log(`  [INFO] 数据修正：当前列表投影实抓 ${bare.size} 真实列 + ${aliased.size} 计算列（以当前代码为准，非固定基线）`);
  return all;
}

function getSysIssueFields() {
  const startNeedle = '`SELECT id, type, status, priority, risk_level, title';
  const start = ROUTES_SI.indexOf(startNeedle);
  must(start > 0, '[数据源] 系统迭代：列表投影 SELECT 可定位（GET /sys-issues）');
  if (start < 0) return null;
  const UPPER = 60000;   // 同 verify-sys-list-badge-fields.js 已验证的安全上界
  const stripped = stripComments(stripSqlLineComments(ROUTES_SI.slice(start, start + UPPER)));
  const boundary = findOuterBoundary(stripped, 'FROM sys_issues');
  must(!boundary.wentNegative, '[数据源] 系统迭代：边界扫描括号深度全程非负');
  must(boundary.index > 0, '[数据源] 系统迭代：外层 FROM sys_issues 边界可定位');
  if (boundary.index <= 0) return null;
  const { bare, aliased, unrecognized } = parseSelectColumns(stripped.slice(0, boundary.index));
  must(unrecognized.length === 0, `[数据源] 系统迭代：SELECT 列全部可解析（无法识别 ${unrecognized.length} 项${unrecognized.length ? '：' + JSON.stringify(unrecognized.slice(0, 3)) : ''}）`);
  const all = new Set([...bare, ...aliased]);
  must(all.size >= 30, `[数据源] 系统迭代：列集合实抓 ${all.size} 个（过少=解析失败）`);
  console.log(`  [INFO] 系统迭代：当前列表投影实抓 ${bare.size} 真实列 + ${aliased.size} 计算列（以当前代码为准，非固定基线）`);
  return all;
}

// collab 因 GET 走 `SELECT *`，须对拍建表列全集：CREATE TABLE 字面量 + v2CollabRequestColumns +
//   v3CollabRequestColumns 两数组 + 全部零散 safeAlterAddColumn('collab_requests', ...) 调用（4 种形态并集）。
function getCollabFields() {
  const cols = new Set();
  const ctMatch = SERVER_JS.match(/CREATE TABLE IF NOT EXISTS collab_requests \(([\s\S]*?)\n\s*\)`\);/);
  must(!!ctMatch, '[数据源] 数据协作：CREATE TABLE collab_requests 可定位');
  if (ctMatch) {
    for (const line of ctMatch[1].split('\n')) {
      const t = line.trim();
      if (!t || /^(FOREIGN KEY|PRIMARY KEY|UNIQUE|CHECK)\b/i.test(t)) continue;
      const m = t.match(/^([a-z_][a-z0-9_]*)\s+/i);
      if (m) cols.add(m[1]);
    }
  }
  let arrCount = 0;
  for (const arrName of ['v2CollabRequestColumns', 'v3CollabRequestColumns']) {
    const arrMatch = SERVER_JS.match(new RegExp('const ' + arrName + ' = \\[([\\s\\S]*?)\\n\\s*\\];'));
    must(!!arrMatch, `[数据源] 数据协作：${arrName} 数组可定位`);
    if (arrMatch) {
      for (const m of arrMatch[1].matchAll(/\[\s*'([a-z_][a-z0-9_]*)'/gi)) { cols.add(m[1]); arrCount++; }
    }
  }
  must(arrCount >= 10, `[数据源] 数据协作：v2/v3 数组合计实抓 ${arrCount} 列（过少=解析失败）`);
  let alterCount = 0;
  for (const m of SERVER_JS.matchAll(/safeAlterAddColumn\('collab_requests',\s*'([a-z_][a-z0-9_]*)'/gi)) { cols.add(m[1]); alterCount++; }
  must(alterCount >= 1, `[数据源] 数据协作：独立 safeAlterAddColumn('collab_requests', ...) 调用实抓 ${alterCount} 处`);
  must(cols.size >= 20, `[数据源] 数据协作：建表列全集（4 种形态并集）实抓 ${cols.size} 个（过少=解析失败）`);
  console.log(`  [INFO] 数据协作：建表列全集实抓 ${cols.size} 个（CREATE TABLE + v2/v3 数组 + ${alterCount} 处零散 ALTER 并集，以当前代码为准）`);
  return cols;
}

console.log('=== 三模块列表导出 columns 配置静态守卫（暂缓与列表导出方案 v1.1 §3.5）===\n');
console.log('— 数据源字段集提取（断言 1 的对拍基准，三模块 4 种形态）—');
const CORR_FIELDS = getCorrectionFields();
const SI_FIELDS = getSysIssueFields();
const COLLAB_FIELDS = getCollabFields();
// N2 评估结论（预筛 C4）：曾考虑加"SI_FIELDS 提取字段数与 verify-sys-list-badge-fields.js 的供给字段数
// 交叉核对"断言。成本评估=高——verify-sys-list-badge-fields.js 是顶层自执行脚本（断言体直接跑在模块
// 顶层、结尾 process.exit()，非可 require 的库形态），要接出可复用的字段集提取函数需重构该文件，而它
// 不在本批改动面（"勿碰"清单外的文件）。故本批不加自动交叉断言，仅在此说明：SI_FIELDS 与
// verify-sys-list-badge-fields.js 供给字段数的对应关系，是 S4 阶段人工核对过的一次性结论，不是持续
// 生效的代码断言——两者字段口径若后续分别演进，不会被本文件自动发现，需要时再单独立项重构。
console.log('');

// ============================================================
// 页面 columns 配置提取（框架：读三页 HTML 中的 UnifyHelpers.attachExport({...}) 调用）
// ============================================================
// 提取范围：本批只落地"解析器能正确解析真实契约形状"这一件事（用合成样例自证），三页真实调用
// 当前均不存在（S5/S6 接入），故 PAGES 扫描到的 columns 数组预期为 0——这是如实反映现状，非漏测。
const PAGES = [
  { file: 'Data_Correction.html', dataSource: () => CORR_FIELDS },
  { file: 'Sys_Iteration.html', dataSource: () => SI_FIELDS },
  { file: 'Data_Collab.html', dataSource: () => COLLAB_FIELDS },
];

// H3 附加断言：接入页 columns 解析结果非空下限（entries ≥ 方案 §3.2 三模块列白名单拍板列数）——
// 与 verify-export-content.js 测试 8 的 EXPECTED_COLUMN_COUNTS 同一份拍板表，两文件各自维护同一常量
// 属预期重复（各 verify 脚本独立可跑，不互相 require）。
const MIN_COLUMN_COUNTS = { 'Data_Correction.html': 19, 'Data_Collab.html': 17, 'Sys_Iteration.html': 18 };

// ============================================================
// 修2（预筛 C4c）：定位前遮罩——剥注释 + 字符串/模板字面量，同长度占位保行号/保偏移
// ============================================================
// 背景：extractAttachExportColumns / hasWiringSignal 都是靠"在源码文本里找字符位置"定位边界（括号
// 深度计数、colIdx 搜索），如果直接在原文上做，会被三类内容误导：
//   ① 字符串/模板字面量里的括号字符（如 value 函数里 formatX(r.a, '(注：括号)示例')）打乱括号深度计数，
//      导致数组/对象边界提前收口或算不平衡；
//   ② label 文案里恰好带 [ ] 字符，同样打乱 [...] 边界；
//   ③ 注释或模板字面量里恰好写着 "attachExport(" / "columns:" / "u-export.js" 等字样（如一段还没写完
//      的 TODO 注释、demo 说明文案），被当成真代码触发误判（自爆假红或解析错位）。
// 做法（本仓既有范式，同 verify-badge-alias.js 的 stripJsComments 思路）：先扫一遍源码，把注释/
// 字符串/模板字面量的内容替换成等长空白（保留换行符，不改变其余字符的绝对偏移），得到"遮罩文本"；
// 所有边界定位（正则匹配位置、findBalancedEnd 的括号计数）都在遮罩文本上做；定位到下标后，回**原文**
// `src` 做 `.slice()` 取真实内容——遮罩文本只用来定位，不用来当返回值（遮罩文本里字符串内容已被抹掉）。
//
// maskJsLike：假定输入本身就是 JS 文本的低层遮罩器（单遍字符扫描，非完整 AST，够用即可）。
//   模板字面量里的 `${...}` 插值按代码处理（不遮罩，用花括号深度计数找配对的 `}`）——否则真实插值
//   表达式里的括号会被连字符串一起遮罩掉，反而制造新的边界误判；已知边界：不处理插值内部再嵌套一层
//   模板字面量（`` `a${`b${c}`}` `` 这种双层嵌套），真实契约形状不会写到这么绕。
//   已知边界（N3，预筛 C6b 补登）：**正则字面量不识别**——`/xxx/` 形式的正则不会被当成独立的"字符串类"
//   上下文遮罩，其内容按普通代码字符处理；若正则里恰好写了 `{`/`}`/`(`/`)`/`[`/`]` 之类的元字符（如
//   `/\{[\s\S]*?\}/`），这些字符会被下游括号深度计数当真代码括号计入，可能扰动边界判定。真实契约形状
//   （columns 配置的 value/deps）不会出现正则字面量，暂不处理；真撞见了再补状态机识别 `/.../ `。
function maskJsLike(text) {
  const out = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') {
      let j = i;
      while (j < n && text[j] !== '\n') { out.push(' '); j++; }
      i = j; continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      out.push(' ', ' ');
      let j = i + 2;
      while (j < n && !(text[j] === '*' && text[j + 1] === '/')) {
        out.push(text[j] === '\n' || text[j] === '\r' ? text[j] : ' ');
        j++;
      }
      if (j < n) { out.push(' ', ' '); j += 2; }
      i = j; continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out.push(ch);
      let j = i + 1;
      while (j < n && text[j] !== quote) {
        // N3（预筛 C6b 对齐实现）：转义序列（反斜杠+下一字符）统一按 2 空格顶替，字符数不变、绝对偏移
        //   不受影响；但若被转义的恰是一个**真实换行符**（单/双引号字符串里出现 `\<LF>` 续行写法，
        //   ECMAScript 合法语法），这里会把该换行符也一并替换成空格——即该换行"消失"，不会被当空白
        //   保留。本函数对外承诺的"保行号"是指"不被转义吞掉的换行"，`\<换行>` 这种转义续行是唯一的
        //   例外（真实契约形状的字符串字面量不会写多行续行，暂不单独处理）。
        if (text[j] === '\\' && j + 1 < n) { out.push(' ', ' '); j += 2; continue; }
        if (text[j] === '\n') break;   // 未转义换行=字符串字面量非法结束，放弃遮罩（畸形输入兜底）
        out.push(' ');
        j++;
      }
      if (j < n && text[j] === quote) { out.push(quote); j++; }
      i = j; continue;
    }
    if (ch === '`') {
      out.push(ch);
      let j = i + 1;
      while (j < n && text[j] !== '`') {
        // N3：同上——`\<换行>` 转义续行会把该换行替换成空格（模板字面量本身允许字面多行，这里指的是
        //   "转义符后紧跟的那个换行"这个特定组合，不影响模板字面量里**未被转义**的普通换行，那些走
        //   下面的 `text[j]==='\n'` 分支原样保留）。
        if (text[j] === '\\' && j + 1 < n) { out.push(' ', ' '); j += 2; continue; }
        if (text[j] === '$' && text[j + 1] === '{') {
          out.push('$', '{');
          j += 2;
          let depth = 1;
          while (j < n && depth > 0) {
            if (text[j] === '{') depth++;
            else if (text[j] === '}') depth--;
            out.push(text[j]);
            j++;
          }
          continue;
        }
        out.push(text[j] === '\n' || text[j] === '\r' ? text[j] : ' ');
        j++;
      }
      if (j < n) { out.push('`'); j++; }
      i = j; continue;
    }
    out.push(ch);
    i++;
  }
  return out.join('');
}

// maskAttachExportSource：页面层入口。若文本里有内联 <script> 标签，只在各 <script> 块内部区间做
//   遮罩（块外的 HTML 标记原样保留，避免把 HTML 属性引号误当 JS 字符串遮罩掉无关内容——同
//   verify-badge-alias.js"先取 <script> 块区间再处理"的既有范式）；外链 <script src=...> 无内联内容
//   跳过。若整段文本一个 <script> 标签都没有（本文件大量自证用的纯 JS 合成样例即属此类），则整段
//   按 JS 文本处理。全程保持与输入等长（同偏移），供调用方直接拿遮罩文本定位、原文取内容。
function maskAttachExportSource(text) {
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let hasScriptTag = false;
  let out = '';
  let last = 0;
  let m;
  while ((m = scriptRe.exec(text))) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/.test(attrs)) continue;   // 外链脚本无内联内容，跳过
    hasScriptTag = true;
    // N2（预筛 C6b）：用长度算术定位内层起点，不用 m[0].indexOf(m[2]) 做内容搜索——后者在内层内容
    //   恰好与开标签文本重复（如内容为空串，或内容开头巧合复现了属性片段）时可能定位到错误的首个
    //   匹配。m[0] 结构固定=开标签+内层内容+'</script>'，三段长度已知，直接减法算出开标签结尾即
    //   内层起点，不依赖搜索、无歧义。
    const innerAbsStart = m.index + m[0].length - m[2].length - '</script>'.length;
    out += text.slice(last, innerAbsStart);
    out += maskJsLike(m[2]);
    last = innerAbsStart + m[2].length;
  }
  out += text.slice(last);
  if (!hasScriptTag) return maskJsLike(text);
  return out;
}

// H3 自爆判据：页面文本含 UnifyHelpers.attachExport( 调用字样，或提及 u-export.js（哪怕引用形态不标准），
// 都算"出现接入信号"——凡是"0 命中"分支在判定前都要先过这关，命中了却仍 0 条解析结果就必须判红。
// 修2：在遮罩文本上判定（不在原文上）——避免注释里一句"还没接 UnifyHelpers.attachExport(...)"的说明
// 文字，或示例字符串里提到 "u-export.js"，被误判成真接入信号。
function hasWiringSignal(html) {
  const masked = maskAttachExportSource(html);
  return /UnifyHelpers\.attachExport\s*\(/.test(masked) || /u-export\.js/.test(masked);
}

// 从任意源码文本里提取全部 `UnifyHelpers.attachExport({ ... })` 调用的 columns 数组原文（括号深度
// 感知定位 `columns:` 后的 `[...]`，深度计数覆盖 ()/[]/{} 三种括号——足以处理契约形状里
// `value: r => fn(r.x)` 这类嵌套调用）。修2：所有边界定位改在 maskAttachExportSource 遮罩文本上做，
// 定位到下标后回原文 src 取真实内容——字符串/模板字面量里的括号、方括号、或恰好出现的 "columns:"
// 字样不再干扰边界判定（已知边界：parseColumnsEntries 内部按 {}深度切分单条 entry 时仍在原文上做，
// 若 label/value 字符串里出现未配对的花括号仍可能误判——本批反例只覆盖括号/方括号/模板字符串三类，
// 花括号类不在本轮范围，真撞见了再补）。
// 返回每次 attachExport({...}) 调用的解析结果 { columnsText, identifier, resolved, reason }：
//   - 内联数组形态 `columns: [...]`：columnsText=数组原文，resolved=true，identifier=null
//   - 标识符形态 `columns: someConst`（H3：S5 可能把 columns 抽成页面级常量再传）：沿标识符名
//     在整份源码里找 `const/let/var someConst = [...]` 声明并取其数组原文，resolved=true，
//     identifier='someConst'；声明找不到则 resolved=false（调用方据此自爆报"无法解析"，不能静默当
//     0 条处理——H3 原话）
//   - 既非 `[` 也非合法标识符起始、或对应的 `columns` 键本身找不到：resolved=false，reason 说明原因
function extractAttachExportColumns(src) {
  const masked = maskAttachExportSource(src);
  const results = [];
  const callRe = /UnifyHelpers\.attachExport\s*\(\s*\{/g;
  let m;
  while ((m = callRe.exec(masked))) {
    const objStart = m.index + m[0].length - 1;   // 指向本次调用 `{` 本身
    const objEnd = findBalancedEnd(masked, objStart, '{', '}');
    if (objEnd < 0) { results.push({ columnsText: null, identifier: null, resolved: false, reason: '配置对象括号不平衡' }); continue; }
    const colIdx = masked.indexOf('columns', objStart);
    if (colIdx < 0 || colIdx > objEnd) continue;   // 本次调用没有 columns 字段（不合规，交断言 3 结构检查判，非本函数职责）
    const colonM = /^columns\s*:\s*/.exec(masked.slice(colIdx));
    if (!colonM) { results.push({ columnsText: null, identifier: null, resolved: false, reason: 'columns 键后未找到冒号' }); continue; }
    const valueStart = colIdx + colonM[0].length;
    if (masked[valueStart] === '[') {
      const bracketEnd = findBalancedEnd(masked, valueStart, '[', ']');
      if (bracketEnd < 0) {
        results.push({ columnsText: null, identifier: null, resolved: false, reason: '内联数组括号不平衡' });
        continue;
      }
      results.push({ columnsText: src.slice(valueStart, bracketEnd + 1), identifier: null, resolved: true });
      continue;
    }
    const identM = /^([A-Za-z_$][A-Za-zA-Z0-9_$]*)/.exec(masked.slice(valueStart));
    if (!identM) { results.push({ columnsText: null, identifier: null, resolved: false, reason: 'columns 值既非数组字面量也非合法标识符' }); continue; }
    const identName = identM[1];
    const declRe = new RegExp('\\b(?:const|let|var)\\s+' + identName + '\\s*=\\s*\\[');
    const declM = declRe.exec(masked);
    if (!declM) { results.push({ columnsText: null, identifier: identName, resolved: false, reason: `标识符 "${identName}" 的 const/let/var 数组声明未找到` }); continue; }
    const arrStart = declM.index + declM[0].length - 1;
    const arrEnd = findBalancedEnd(masked, arrStart, '[', ']');
    if (arrEnd < 0) { results.push({ columnsText: null, identifier: identName, resolved: false, reason: `标识符 "${identName}" 对应数组括号不平衡` }); continue; }
    results.push({ columnsText: src.slice(arrStart, arrEnd + 1), identifier: identName, resolved: true });
  }
  return results;
}

// 从 openIdx（指向开括号本身）起，找与之配对的闭括号下标；跨 ()/[]/{} 混合嵌套统一按"任意开括号 +1，
// 任意闭括号 -1"计深度（对定位一个已知类型括号对的配对闭符足够，不需要按类型分栈——契约形状不会出现
// 开合类型错配的畸形字面量）。
function findBalancedEnd(src, openIdx, openCh, closeCh) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// 解析单个 columns 数组原文 → [{key,label,hasValue,deps:[...]}, ...]
function parseColumnsEntries(columnsArrayText) {
  const inner = columnsArrayText.replace(/^\[/, '').replace(/\]$/, '');
  // 顶层（相对本数组）按 {...} 对象逐条切（深度感知，同支持嵌套）
  const entries = [];
  let depth = 0, cur = '', started = false;
  for (const ch of inner) {
    if (ch === '{') { if (depth === 0) { cur = ''; started = true; } depth++; }
    if (started) cur += ch;
    if (ch === '}') { depth--; if (depth === 0 && started) { entries.push(cur); started = false; } }
  }
  return entries.map((e) => {
    const keyM = e.match(/\bkey\s*:\s*'([^']*)'/);
    const labelM = e.match(/\blabel\s*:\s*'([^']*)'/);
    const hasValue = /\bvalue\s*:/.test(e);
    const depsM = e.match(/\bdeps\s*:\s*\[([^\]]*)\]/);
    const deps = depsM ? Array.from(depsM[1].matchAll(/'([^']*)'/g)).map((m) => m[1]) : [];
    return { key: keyM ? keyM[1] : null, label: labelM ? labelM[1] : null, hasValue, deps, raw: e };
  });
}

// ── 框架自证（合成样例，证明解析器能正确处理真实契约形状——不是"因为没数据所以恒过"）──
console.log('— columns 解析器自证（合成样例，验证解析器本身，非扫描三页真实文件）—');
{
  const sample = `UnifyHelpers.attachExport({
    buttonSelector: '#exportBtn',
    getViewRows: () => clusterItems(getFilteredItems()),
    columns: [
      { key: 'oa_number', label: 'OA 流程号', value: r => formatOaNo(r.oa_number) },
      { key: 'source_system', label: '所属系统', deps: ['source_system','source_system_other'],
        value: r => r.source_system === 'other' ? (r.source_system_other || '其他') : r.source_system },
      { key: 'is_overdue', label: '是否超时（对期望时限）', deps: ['status','expected_deadline','fixed_at','refixed_at'],
        value: (r, ctx) => ctx.overdueRule(r).overdue },
    ],
    filename: () => \`数据修正_导出_\${ts}\`,
    overdueRule: (row, now) => ({ overdue: '…', duration: '…' }),
  });`;
  const found = extractAttachExportColumns(sample);
  must(found.length === 1, `合成样例：恰提取到 1 处 attachExport columns 数组（实得 ${found.length}）`);
  if (found.length === 1) {
    must(found[0].resolved === true, '合成样例：内联数组形态解析成功（resolved===true）');
    const entries = parseColumnsEntries(found[0].columnsText);
    must(entries.length === 3, `合成样例：columns 数组恰含 3 个条目（实得 ${entries.length}）`);
    must(entries[0].key === 'oa_number' && entries[0].label === 'OA 流程号' && !entries[0].hasValue === false, '合成样例：第 1 条 key/label/value 解析正确');
    must(JSON.stringify(entries[1].deps) === JSON.stringify(['source_system', 'source_system_other']), `合成样例：第 2 条 deps 数组解析正确（实得 ${JSON.stringify(entries[1].deps)}）`);
    must(entries[2].key === 'is_overdue' && entries[2].deps.length === 4, '合成样例：第 3 条纯派生列（deps 4 项）解析正确');
  }
}
console.log('');

// ── H3 新增自证：columns 抽成页面级常量再传（`columns: IDENT` 标识符形态）解析器能否正确解析 ──
console.log('— columns 解析器自证（标识符形态，H3 新增：S5 可能把 columns 抽成页面常量再传）—');
{
  const identSample = `
    const EXPORT_COLUMNS = [
      { key: 'title', label: '标题' },
      { key: 'status', label: '状态', deps: ['status'], value: r => r.status },
    ];
    function initExport() {
      UnifyHelpers.attachExport({
        buttonSelector: '.u-btn-export',
        getViewRows: () => items,
        columns: EXPORT_COLUMNS,
        filename: 'export',
      });
    }
  `;
  const found = extractAttachExportColumns(identSample);
  must(found.length === 1, `标识符样例：恰提取到 1 处 attachExport 调用（实得 ${found.length}）`);
  if (found.length === 1) {
    must(found[0].resolved === true, `标识符样例：columns: EXPORT_COLUMNS 沿标识符找到数组声明并解析成功（resolved=${found[0].resolved}，reason=${found[0].reason || '(无)'}）`);
    must(found[0].identifier === 'EXPORT_COLUMNS', `标识符样例：identifier 字段记录为 "EXPORT_COLUMNS"（实得 "${found[0].identifier}"）`);
    if (found[0].resolved) {
      const entries = parseColumnsEntries(found[0].columnsText);
      must(entries.length === 2, `标识符样例：沿标识符解析出的数组恰含 2 个条目（实得 ${entries.length}）`);
    }
  }
  // 反向对照：标识符声明找不到 → 必须 resolved===false 且 reason 说明原因（不能静默当 0 条）
  const unresolvedSample = `
    UnifyHelpers.attachExport({
      buttonSelector: '.u-btn-export',
      getViewRows: () => items,
      columns: NOWHERE_DECLARED_COLUMNS,
      filename: 'export',
    });
  `;
  const foundBad = extractAttachExportColumns(unresolvedSample);
  must(foundBad.length === 1 && foundBad[0].resolved === false, `★对照组：标识符声明找不到 → resolved 必须为 false（实得 ${JSON.stringify(foundBad[0] && foundBad[0].resolved)}），不能静默当 0 条处理`);
}
console.log('');

// ── 修2 反例三连（预筛 C4c）：字符串/模板字面量里的括号/方括号/columns: 字样不能误导边界判定 ──
console.log('— columns 解析器自证（修2 反例三连：遮罩必须扛住这三类字符串内容）—');
{
  // 反例①（预筛 C6b M1 订正）：旧样例 '(注：括号)示例' 括号本身配对，无遮罩的旧逻辑也能"蒙对"——
  //   属套套断言，未真正证明遮罩起作用。换成**净不平衡**样例：value 字符串含未配对的单个 "("（无匹配
  //   ")"），且样例额外带 overdueRule 字段（返回对象含真花括号）——净多出的一个左括号让无遮罩的
  //   findBalancedEnd 收口延后一整个层级，多吞进 overdueRule 返回对象那组 {}，parseColumnsEntries
  //   会把它也算成第 3 个"条目"；有遮罩则字符串内容被抹成空白，边界精确停在真实的 columns 数组结尾，
  //   entries 恰为 2。entries.length 差值（2 vs 3）是真实可观测的分歧，非同一结果的两种描述。
  const sample1 = `UnifyHelpers.attachExport({
    buttonSelector: '.u-btn-export',
    getViewRows: () => items,
    columns: [
      { key: 'a', label: 'A', deps: ['a'], value: r => r.a },
      { key: 'b', label: 'B', deps: ['b'], value: r => formatX(r.b, '备注(未闭合') },
    ],
    filename: 'x',
    overdueRule: (row, now) => ({ overdue: 'x', duration: 'y' }),
  });`;
  const found1 = extractAttachExportColumns(sample1);
  must(found1.length === 1 && found1[0].resolved === true, `反例①（value 函数含未配对左括号字符串）：attachExport 调用正确解析（resolved=${found1[0] && found1[0].resolved}）`);
  if (found1.length === 1 && found1[0].resolved) {
    const entries1 = parseColumnsEntries(found1[0].columnsText);
    must(entries1.length === 2, `反例①：columns 数组恰含 2 个条目，未被字符串里未配对的 "(" 拖长边界吞进 overdueRule 的返回对象（实得 ${entries1.length}，旧版无遮罩逻辑在此样例下会得 3）`);
    must(entries1[1] && entries1[1].key === 'b', `反例①：第 2 条（真实数组结尾前的条目）能被正确抓到（实得 key=${entries1[1] && entries1[1].key}）`);
  }

  // 反例②：label 文案含未配对的方括号 —— 旧版会把这个 "]" 计入深度，导致数组提前收口，丢失后续条目。
  const sample2 = `UnifyHelpers.attachExport({
    buttonSelector: '.u-btn-export',
    getViewRows: () => items,
    columns: [
      { key: 'c', label: '状态]异常', deps: ['status'], value: r => r.status },
      { key: 'd', label: 'D', deps: ['d'], value: r => r.d },
    ],
    filename: 'x',
  });`;
  const found2 = extractAttachExportColumns(sample2);
  must(found2.length === 1 && found2[0].resolved === true, `反例②（label 含方括号）：attachExport 调用正确解析（resolved=${found2[0] && found2[0].resolved}）`);
  if (found2.length === 1 && found2[0].resolved) {
    const entries2 = parseColumnsEntries(found2[0].columnsText);
    must(entries2.length === 2, `反例②：columns 数组恰含 2 个条目，未被 label 里的 "]" 打乱边界（实得 ${entries2.length}）`);
    must(entries2[0] && entries2[0].label === '状态]异常', `反例②：label 原样解析出含方括号的文案（实得 "${entries2[0] && entries2[0].label}"）`);
  }

  // 反例③：模板字符串里恰好写着 "columns:" 字样，且出现在真实 columns 键之前 —— 旧版 indexOf('columns')
  //   会先命中这处假的，误把后续文本当 columns 值去解析。
  const sample3 = 'UnifyHelpers.attachExport({\n' +
    '  buttonSelector: \'.u-btn-export\',\n' +
    '  getViewRows: () => items,\n' +
    '  filename: () => `说明：columns: 这不是真的 key`,\n' +
    '  columns: [\n' +
    '    { key: \'e\', label: \'E\', deps: [\'e\'], value: r => r.e },\n' +
    '  ],\n' +
    '});';
  const found3 = extractAttachExportColumns(sample3);
  must(found3.length === 1 && found3[0].resolved === true, `反例③（模板字符串含 columns: 字样）：attachExport 调用正确解析（resolved=${found3[0] && found3[0].resolved}）`);
  if (found3.length === 1 && found3[0].resolved) {
    const entries3 = parseColumnsEntries(found3[0].columnsText);
    must(entries3.length === 1 && entries3[0].key === 'e', `反例③：定位到真实 columns 键（非模板字符串里的假 "columns:" 文字），恰 1 条 key='e'（实得 ${JSON.stringify(entries3.map((e) => e.key))}）`);
  }

  // 反例④（hasWiringSignal 侧）：注释里提及 attachExport(/u-export.js，不应被判定为真接入信号
  const commentOnlyHtml = '<script>\n  // TODO: 这里以后要接 UnifyHelpers.attachExport({...})，先占位，暂未接入 u-export.js\n  console.log(1);\n</script>';
  must(hasWiringSignal(commentOnlyHtml) === false, `反例④：注释里提及 attachExport(/u-export.js 不构成真实接入信号（hasWiringSignal 必须为 false）`);
  const realCallHtml = '<script>\n  UnifyHelpers.attachExport({buttonSelector:".x"});\n</script>';
  must(hasWiringSignal(realCallHtml) === true, `反例④对照：真实调用仍被正确识别为接入信号（hasWiringSignal 必须为 true）`);
}
console.log('');

// 预筛 C6d 修4：补三条 maskJsLike/maskAttachExportSource 当前实现处理不了的边界样例（对齐既有已知边界
//   纪律——已在函数定义处注释登记"正则字面量不识别"，本节把该已知边界从"文字声明"升级为"可跑断言锁定"，
//   同时新增两条此前未登记的边界）。三条经验证后行为分两类：①③是"显式自爆"（resolved:false 或
//   hasWiringSignal 误报但 columns 解析恰为 0——两者组合正是文件头 H3 纪律"命中信号却 0 条解析结果必须
//   判红"的触发条件，不是静默通过）；②是货真价实的**静默**丢列（resolved:true 但条目数比真实少），
//   不满足"自爆非静默"的理想——如实记录为已知缺口，不在本批修（真实契约形状的 value() 不会在模板插值里
//   塞一个裸字符串字面量、字面量内容又恰好是单字符 "}"，概率场景与断言 3 的"花括号类不在本轮范围"
//   已知边界同属性质，本条把它从"未测到"升级为"测到但明确标注是缺口"，不是佯装没有）。
console.log('— columns 解析器自证（修4 反例三连·预筛 C6d：遮罩当前处理不了的三类边界，验证失败方式）—');
{
  // 反例 A：正则字面量含引号 /['"]/ ——maskJsLike 不识别正则语法，字面量内的 "'" 会被误当字符串起点，
  //   连锁污染后续文本的引号奇偶性，最终导致 attachExport({...}) 外层大括号在遮罩文本里计数不平衡。
  //   实测结果：resolved===false，reason='配置对象括号不平衡'——显式自爆，非静默误判（安全失败方向）。
  const sampleA = `UnifyHelpers.attachExport({
    buttonSelector: '.u-btn-export',
    getViewRows: () => items,
    columns: [
      { key: 'f', label: 'F', deps: ['f'], value: r => /['"]/.test(r.f) ? '含引号' : r.f },
      { key: 'g', label: 'G', deps: ['g'], value: r => r.g },
    ],
    filename: 'x',
  });`;
  const foundA = extractAttachExportColumns(sampleA);
  must(foundA.length === 1, `反例 A（正则字面量含引号）：恰提取到 1 处 attachExport 调用（实得 ${foundA.length}）`);
  if (foundA.length === 1) {
    must(foundA[0].resolved === false, `反例 A：正则里的引号污染后续遮罩，外层括号计数不平衡，resolved 必须为 false（实得 ${foundA[0].resolved}）——显式自爆，非静默误判`);
    must(foundA[0].reason === '配置对象括号不平衡', `反例 A：自爆 reason 明确指向括号不平衡（实得 "${foundA[0].reason}"），调用方据此能定位问题、不会误当"0 条 columns"处理`);
  }

  // 反例 B：模板插值 ${...} 内嵌一个内容恰为单字符 "}" 的字符串字面量——maskJsLike 的插值深度计数
  //   对字符串内容不做二次遮罩，字符串里的 "}" 被当真代码括号提前收口插值，真正的插值收口符转而被当
  //   模板体普通文本遮罩掉。实测结果：resolved===true 但 columns 条目数比真实少（真实 2 条只解出 1 条）
  //   ——**这是静默丢列，不满足"自爆非静默"的理想**，如实记录为已知缺口（不在本批修，理由见本节头注释）。
  const sampleB = `UnifyHelpers.attachExport({
    buttonSelector: '.u-btn-export',
    getViewRows: () => items,
    columns: [
      { key: 'h', label: 'H', deps: ['h'], value: r => \`前缀\${r.h || '}'}后缀\` },
      { key: 'i', label: 'I', deps: ['i'], value: r => r.i },
    ],
    filename: 'x',
  });`;
  const foundB = extractAttachExportColumns(sampleB);
  must(foundB.length === 1 && foundB[0].resolved === true, `反例 B（模板插值内字符串含花括号）：attachExport 调用仍"解析成功"（resolved=${foundB[0] && foundB[0].resolved}）——本条恰是问题所在，见下`);
  if (foundB.length === 1 && foundB[0].resolved) {
    const entriesB = parseColumnsEntries(foundB[0].columnsText);
    must(entriesB.length === 1, `★已知缺口锁定（非"应然"断言）：真实 columns 数组有 2 个条目，本样例下静默丢到只剩 ${entriesB.length} 条——resolved 却仍是 true，未触发任何自爆信号；本断言锁定"现状就是这样"，防止未来退化到更糟（如直接抛异常）却无人发现，也提醒这不是可接受的终态`);
  }

  // 反例 C：HTML 注释（<script> 标签外）里出现 attachExport 字样——maskAttachExportSource 只遮罩
  //   <script> 块内部，块外 HTML（含注释）原样保留，hasWiringSignal 会在这类注释上误报"检测到接入信号"。
  //   实测结果：hasWiringSignal===true（误报） 但 extractAttachExportColumns 恰为 0（页面确实无真实调用）
  //   ——两者组合正是文件头 H3 纪律"命中信号却 0 条解析结果必须判红"的触发条件：调用方会显式自爆而非
  //   把这类页面误判为"已正确接入但没有列"悄悄放过，安全失败方向。
  const sampleC = '<!-- TODO: 还没接 UnifyHelpers.attachExport({...})，暂未接入 u-export.js -->\n<div>hi</div>\n<script>\n  console.log(1);\n</script>';
  must(hasWiringSignal(sampleC) === true, `反例 C（HTML 注释含 attachExport 字样，<script> 外）：hasWiringSignal 误报为 true（实得 ${hasWiringSignal(sampleC)}）——已知边界，maskAttachExportSource 不处理 <script> 外的 HTML 注释`);
  const foundC = extractAttachExportColumns(sampleC);
  must(foundC.length === 0, `反例 C：extractAttachExportColumns 正确找到 0 处真实调用（实得 ${foundC.length}）——与上一条 hasWiringSignal 误报组合，恰好触发 H3"信号命中但 0 解析结果"自爆判据，不会被静默当作真的接入`);
}
console.log('');

// H3 自爆统一入口：断言 1/2/3 共用同一份"0 命中即 ok"→自爆改造逻辑，避免三处各自实现出现不一致
// （复制 verify-export-content.js 测试 8 的自爆机制）。返回该页应参与后续断言的 resolved 数组
// （已解析出 columns 原文的调用列表）；若整页应跳过该断言（真尚未接入 / 已就地判红），返回 null。
function resolvePageForAssertion(p, html, assertionLabel) {
  const found = extractAttachExportColumns(html);
  let anyUnresolved = false;
  for (const r of found) {
    if (!r.resolved) {
      anyUnresolved = true;
      bad(`${assertionLabel}：${p.file} 检出 attachExport columns 配置但解析失败（原因=${r.reason}${r.identifier ? '，标识符=' + r.identifier : ''}）——H3 自爆：解析失败须显式判红，不能静默当 0 条`);
    }
  }
  const resolved = found.filter((r) => r.resolved);
  if (resolved.length > 0) return resolved;
  if (anyUnresolved) return null;   // 已在上面判红，不重复
  if (hasWiringSignal(html)) {
    bad(`${assertionLabel}：${p.file} 页面已出现 attachExport(/u-export.js 引用信号，但提取到 0 条可解析 columns——占位框架不应在真实接入后仍保持占位（H3 自爆）`);
    return null;
  }
  ok(`${assertionLabel}：${p.file} 尚未接入 attachExport（实抓 0 处，S5/S6 接入后自动启用真实对拍——预期现状，非漏测）`);
  return null;
}

// ============================================================
// 附加断言（预筛 C4c 修3）：每页 attachExport 调用数恰为 1（方案=每页一个导出按钮）
// ============================================================
// 只在这里跑一次（不放进断言1/2/3 各自的循环，否则同一件事会被判红/判绿三遍，重复刷屏）。
console.log('— 附加断言：每页 attachExport 调用数恰为 1（方案=每页一个导出按钮，修3）—');
for (const p of PAGES) {
  const htmlPath = path.join(PUBLIC_DIR, p.file);
  if (!fs.existsSync(htmlPath)) continue;
  const html = fs.readFileSync(htmlPath, 'utf8');
  const found = extractAttachExportColumns(html);
  if (found.length === 0) {
    ok(`调用数：${p.file} 尚未接入 attachExport（0 处，与"尚未接入"现状一致，非本断言判定范围）`);
  } else {
    must(found.length === 1, `调用数：${p.file} attachExport 调用数恰为 1（方案=每页一个导出按钮；实得 ${found.length} 处）`);
  }
}
// 对照组：构造一页出现 2 次 attachExport 调用的样例，断言必须判红
{
  const dupCallSample = `
    UnifyHelpers.attachExport({ buttonSelector: '.a', getViewRows: () => [], columns: [{key:'x',label:'X'}] });
    UnifyHelpers.attachExport({ buttonSelector: '.b', getViewRows: () => [], columns: [{key:'y',label:'Y'}] });
  `;
  const foundDup = extractAttachExportColumns(dupCallSample);
  must(foundDup.length === 2, `★对照组：合成样例正确检测到 2 次 attachExport 调用（实得 ${foundDup.length}）`);
  must(foundDup.length !== 1, `★对照组：调用数≠1 时"恰为1"判据必须判红——若真实页面出现这种情况，上面 must(found.length===1,...) 会失败（此处证明判据非恒真，found.length=${foundDup.length}）`);
}
console.log('');

// ============================================================
// 断言 1：依赖字段 ⊆ 数据源
// ============================================================
console.log('— 断言 1：无 value 列的 key + 全部 deps ⊆ 对应数据源字段集 —');

function checkDepsSubset(entries, dataSourceFields, pageLabel) {
  if (!dataSourceFields) return { violations: [`${pageLabel}：数据源字段集提取失败，跳过对拍`] };
  const violations = [];
  for (const e of entries) {
    if (!e.hasValue) {
      if (e.key && !dataSourceFields.has(e.key)) violations.push(`${pageLabel}：无 value 列 key="${e.key}" 不在数据源字段集`);
    }
    for (const d of e.deps) {
      if (!dataSourceFields.has(d)) violations.push(`${pageLabel}：列 key="${e.key}" 的 deps 含 "${d}" 不在数据源字段集`);
    }
  }
  return { violations };
}

for (const p of PAGES) {
  const htmlPath = path.join(PUBLIC_DIR, p.file);
  if (!fs.existsSync(htmlPath)) { bad(`断言1：${p.file} 不存在`); continue; }
  const html = fs.readFileSync(htmlPath, 'utf8');
  const resolved = resolvePageForAssertion(p, html, '断言1');
  if (!resolved) continue;
  for (const r of resolved) {
    const entries = parseColumnsEntries(r.columnsText);
    const { violations } = checkDepsSubset(entries, p.dataSource(), p.file);
    must(violations.length === 0, `断言1：${p.file} columns 依赖字段全部 ⊆ 数据源${violations.length ? '——' + violations.join('; ') : ''}`);
  }
}

// 对照组（证明 checkDepsSubset 真能判红，不是恒真）：构造一条 deps 含数据源不存在字段的样例
{
  const badEntries = parseColumnsEntries(`[{ key: 'x', label: 'X', deps: ['this_field_does_not_exist_anywhere'], value: r => r.x }]`);
  const { violations } = checkDepsSubset(badEntries, CORR_FIELDS, '★对照组');
  must(violations.length === 1 && violations[0].includes('this_field_does_not_exist_anywhere'),
    `★对照组：deps 含数据源不存在字段 → checkDepsSubset 必须判红（实得 ${JSON.stringify(violations)}）`);
  const goodEntries = parseColumnsEntries(`[{ key: 'x', label: 'X', deps: ['status'], value: r => r.status }]`);
  const { violations: v2 } = checkDepsSubset(goodEntries, CORR_FIELDS, '★对照组');
  must(v2.length === 0, '★对照组：deps 全部真实存在于数据源 → 不误报');
}
console.log('');

// ============================================================
// 断言 2：敏感黑名单 + 对照组
// ============================================================
console.log('— 断言 2：敏感黑名单（phone/dingtalk/notify/message_key/read_at）恒不出现在任何页 key/deps —');
const SENSITIVE_PATTERNS = [/phone/i, /dingtalk/i, /notify/i, /message_key/i, /read_at/i];

function checkSensitive(entries, pageLabel) {
  const violations = [];
  for (const e of entries) {
    const fields = [e.key, ...e.deps].filter(Boolean);
    for (const f of fields) {
      for (const pat of SENSITIVE_PATTERNS) {
        if (pat.test(f)) violations.push(`${pageLabel}：字段 "${f}" 命中敏感模式 ${pat}`);
      }
    }
  }
  return violations;
}

for (const p of PAGES) {
  const htmlPath = path.join(PUBLIC_DIR, p.file);
  if (!fs.existsSync(htmlPath)) continue;
  const html = fs.readFileSync(htmlPath, 'utf8');
  const resolved = resolvePageForAssertion(p, html, '断言2');
  if (!resolved) continue;
  for (const r of resolved) {
    const entries = parseColumnsEntries(r.columnsText);
    const violations = checkSensitive(entries, p.file);
    must(violations.length === 0, `断言2：${p.file} columns 中无敏感字段${violations.length ? '——' + violations.join('; ') : ''}`);
  }
}

// 对照组（codex/方案明确要求）：临时注入 requester_phone 列，断言守卫判红；全在内存内构造，不改任何文件
{
  const injected = parseColumnsEntries(`[{ key: 'requester_phone', label: '业务方手机号', value: r => r.requester_phone }]`);
  const violations = checkSensitive(injected, '★对照组');
  must(violations.length === 1 && violations[0].includes('requester_phone'),
    `★对照组：临时注入 requester_phone 列 → 敏感黑名单必须判红（实得 ${JSON.stringify(violations)}）`);
  // 反向对照：正常字段不应误报
  const clean = parseColumnsEntries(`[{ key: 'status', label: '状态', value: r => r.status }]`);
  must(checkSensitive(clean, '★对照组').length === 0, '★对照组：正常字段（status）不应被敏感黑名单误报');
}
console.log('');

// ============================================================
// 断言 3：三页配置结构一致 + 按钮文案含「Excel」
// ============================================================
console.log('— 断言 3：三页配置结构一致（key/label 必有、value 有则 deps 有、key 唯一）；按钮文案含「Excel」—');

function checkStructure(entries, pageLabel) {
  const violations = [];
  const seenKeys = new Set();
  const seenLabels = new Set();
  for (const e of entries) {
    if (!e.key) violations.push(`${pageLabel}：存在缺 key 的列`);
    if (!e.label) violations.push(`${pageLabel}：列 key="${e.key}" 缺 label`);
    if (e.hasValue && e.deps.length === 0) violations.push(`${pageLabel}：列 key="${e.key}" 有 value 但缺 deps`);
    if (e.key) {
      if (seenKeys.has(e.key)) violations.push(`${pageLabel}：key="${e.key}" 在配置内重复（须唯一）`);
      seenKeys.add(e.key);
    }
    // M1：label 配置内唯一——label 是 Excel 表头文字，重复会导致导出表头撞名，同 key 唯一性同等重要
    if (e.label) {
      if (seenLabels.has(e.label)) violations.push(`${pageLabel}：label="${e.label}" 在配置内重复（须唯一，Excel 表头不可重名）`);
      seenLabels.add(e.label);
    }
  }
  return violations;
}

// H2：按钮定位改按 class="...u-btn-export..." 定位真实导出按钮（与 Export_DateFilter_Demo.html 确认
// 口径的类名对齐），捕获整个按钮内部 HTML（[\s\S]*? 跨标签，容忍内嵌 <svg><path/>.../svg> 图标——旧版
// `[^<]*` 正则一遇 svg 子标签就断裂，永远匹配不到真实按钮），再去标签取纯文本判定。
function extractExportButtonTexts(html) {
  const btnRe = /<button\b[^>]*class="[^"]*\bu-btn-export\b[^"]*"[^>]*>([\s\S]*?)<\/button>/g;
  const texts = [];
  let m;
  while ((m = btnRe.exec(html))) {
    texts.push(m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim());
  }
  return texts;
}

// 按钮文案判据：纯文本须含「导出 Excel」；协作页（Data_Collab.html）额外禁止纯文本恰为「导出」二字
// （方案明确要求的独立断言，即便逻辑上已被第一条含蕴，仍按派单原话拆成两条各自留痕）。
function checkButtonText(text, pageFile) {
  const violations = [];
  if (!text.includes('导出 Excel')) violations.push(`${pageFile}：导出按钮纯文本不含「导出 Excel」（实得 "${text}"）`);
  if (pageFile === 'Data_Collab.html' && text === '导出') violations.push(`${pageFile}：协作页导出按钮纯文本禁止恰为「导出」二字（实得 "${text}"）`);
  return violations;
}

for (const p of PAGES) {
  const htmlPath = path.join(PUBLIC_DIR, p.file);
  if (!fs.existsSync(htmlPath)) continue;
  const html = fs.readFileSync(htmlPath, 'utf8');
  const resolved = resolvePageForAssertion(p, html, '断言3');
  if (resolved) {
    const minCount = MIN_COLUMN_COUNTS[p.file];
    for (const r of resolved) {
      const entries = parseColumnsEntries(r.columnsText);
      const violations = checkStructure(entries, p.file);
      must(violations.length === 0, `断言3：${p.file} columns 结构一致${violations.length ? '——' + violations.join('; ') : ''}`);
      // 修3：列数下限改按配置逐个断言（不再跨该页全部 attachExport 调用合计）——配合"调用数恰1"
      // 断言后，正常情况下 resolved 本就只有 1 个元素，这里改成对每个 r 单独判定，是为了在极端情况
      // （某处代码仍出现多次调用，"恰1"已判红但这里继续跑）下，每个配置各自的列数下限依旧独立成立，
      // 不会被"某一份列多、另一份列少"互相抵消掩盖。
      if (minCount) {
        must(entries.length >= minCount, `断言3：${p.file} columns 解析结果非空下限——该配置 entries(${entries.length}) ≥ 方案拍板列数下限(${minCount})`);
      }
    }
  }
  // 按钮文案（H2 重写）：class 定位 + 容忍内嵌 svg + 去标签取纯文本
  const btnTexts = extractExportButtonTexts(html);
  if (btnTexts.length === 0) {
    if (hasWiringSignal(html)) {
      bad(`断言3：${p.file} 页面已出现 attachExport(/u-export.js 引用信号，但未找到 u-btn-export 按钮——占位框架不应在真实接入后仍保持占位（H3 自爆）`);
    } else {
      ok(`断言3：${p.file} 尚无 u-btn-export 按钮可查（S5/S6 接入后启用——同断言1现状）`);
    }
  } else {
    for (const text of btnTexts) {
      const violations = checkButtonText(text, p.file);
      must(violations.length === 0, `断言3：${p.file} 导出按钮纯文本判定通过（实得 "${text}"）${violations.length ? '——' + violations.join('; ') : ''}`);
    }
  }
}

// 对照组：结构检查器本身能判红（缺 label / value 无 deps / key 重复 / label 重复 四个反例各一条）
{
  const noLabel = parseColumnsEntries(`[{ key: 'a', value: r => r.a, deps: ['a'] }]`);
  must(checkStructure(noLabel, '★对照组').some((v) => v.includes('缺 label')), '★对照组：缺 label 的列必须判红');
  const valueNoDeps = parseColumnsEntries(`[{ key: 'a', label: 'A', value: r => r.a }]`);
  must(checkStructure(valueNoDeps, '★对照组').some((v) => v.includes('缺 deps')), '★对照组：有 value 无 deps 的列必须判红');
  const dupKey = parseColumnsEntries(`[{ key: 'a', label: 'A1' }, { key: 'a', label: 'A2' }]`);
  must(checkStructure(dupKey, '★对照组').some((v) => v.includes('key=') && v.includes('重复')), '★对照组：key 重复必须判红');
  // M1：label 重复（key 不同）必须判红——Excel 表头不可重名，与 key 唯一性同等重要
  const dupLabel = parseColumnsEntries(`[{ key: 'a', label: 'A重复' }, { key: 'b', label: 'A重复' }]`);
  must(checkStructure(dupLabel, '★对照组').some((v) => v.includes('label=') && v.includes('重复')), '★对照组：label 重复（key 不同）必须判红（M1）');
}
console.log('');

// H2 对照组：按钮文案判据改走真实 extractExportButtonTexts + checkButtonText，喂真实 HTML 片段
// （含内嵌 svg 正例 + 「导出」二字负例）走真实判据函数——旧版对照组只对裸字符串做 .includes()，
// 判据函数本身从未被对照组实际调用过，形同虚设（H2 收敛）。
console.log('— 断言 3 对照组：按钮文案判据（H2，真实提取函数 + 真实判据函数）—');
{
  const goodBtnHtml = '<div><button class="u-btn-export" onclick="demoExport(this)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> 导出 Excel</button></div>';
  const goodTexts = extractExportButtonTexts(goodBtnHtml);
  must(goodTexts.length === 1 && goodTexts[0] === '导出 Excel', `★对照组：含内嵌 svg 的真实按钮结构 → extractExportButtonTexts 去标签后正确提取纯文本"导出 Excel"（实得 ${JSON.stringify(goodTexts)}）`);
  must(goodTexts.length === 1 && checkButtonText(goodTexts[0], 'Data_Correction.html').length === 0, '★对照组：「导出 Excel」纯文本 → checkButtonText 判定通过（数据修正页，不误报）');

  const badBtnHtml = '<button class="u-btn-export">导出</button>';
  const badTexts = extractExportButtonTexts(badBtnHtml);
  must(badTexts.length === 1 && badTexts[0] === '导出', `★对照组：只含「导出」二字的按钮 → 纯文本提取正确（实得 ${JSON.stringify(badTexts)}）`);
  must(badTexts.length === 1 && checkButtonText(badTexts[0], 'Data_Correction.html').length === 1, '★对照组：非协作页「导出」二字（不含 Excel）→ checkButtonText 必须判红 1 条（自证判据非恒真）');
  must(badTexts.length === 1 && checkButtonText(badTexts[0], 'Data_Collab.html').length === 2, `★对照组：协作页「导出」二字 → 同时触发「不含导出Excel」+「协作页恰为导出二字」两条判红（实得 ${checkButtonText(badTexts[0], 'Data_Collab.html').length} 条）`);
}
console.log('');

// ============================================================
// 断言 4：vendor 文件存在 + 三页引用带 ?v= 缓存串 + u-export.js 版本一致
// ============================================================
console.log('— 断言 4：vendor 文件存在 + 引用页缓存串与 KIT_VERSION 一致 —');
const VENDOR_PATH = path.join(PUBLIC_DIR, 'assets', 'vendor', 'xlsx.mini.min.js');
must(fs.existsSync(VENDOR_PATH), `vendor 文件存在：assets/vendor/xlsx.mini.min.js`);
if (fs.existsSync(VENDOR_PATH)) {
  // N5：vendor 完整性改 sha256 与 node_modules/xlsx/dist/xlsx.mini.min.js 逐字节比对（node crypto，
  // 禁外部命令），比"体积 > 100000 字节"更强——体积门槛只挡"拷错空文件"，挡不住"拷错了同量级的
  // 别的版本/被篡改"。
  const NODE_MODULES_XLSX = path.join(__dirname, '..', 'node_modules', 'xlsx', 'dist', 'xlsx.mini.min.js');
  must(fs.existsSync(NODE_MODULES_XLSX), 'N5：node_modules/xlsx/dist/xlsx.mini.min.js 存在（作为完整性比对基准）');
  if (fs.existsSync(NODE_MODULES_XLSX)) {
    const hashOf = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    const vendorHash = hashOf(VENDOR_PATH);
    const nodeModulesHash = hashOf(NODE_MODULES_XLSX);
    must(vendorHash === nodeModulesHash, `vendor 文件完整性（N5，sha256 逐字节比对）：public/assets/vendor/xlsx.mini.min.js 与 node_modules/xlsx/dist/xlsx.mini.min.js 一致（vendor=${vendorHash.slice(0, 12)}…，node_modules=${nodeModulesHash.slice(0, 12)}…）`);
  }
}

const UEXPORT_SRC = fs.readFileSync(path.join(PUBLIC_DIR, 'assets', 'js', 'u-export.js'), 'utf8');
const kitM = UEXPORT_SRC.match(/var KIT_VERSION = '([^']+)';/);
must(!!kitM, 'u-export.js：KIT_VERSION 声明可定位');
const KIT_VERSION = kitM ? kitM[1] : null;
// H1：UMD 挂载须暴露 UnifyHelpers.uexportCheckVersion（非裸 checkVersion 名，防未来撞名）+
//   UnifyHelpers.UEXPORT_KIT_VERSION（供页面/其他脚本读取当前版本号）。
must(/root\.UnifyHelpers\.uexportCheckVersion\s*=/.test(UEXPORT_SRC), 'u-export.js：UMD 头挂载 UnifyHelpers.uexportCheckVersion（H1）');
must(/root\.UnifyHelpers\.UEXPORT_KIT_VERSION\s*=/.test(UEXPORT_SRC), 'u-export.js：UMD 头挂载 UnifyHelpers.UEXPORT_KIT_VERSION（H1）');

// codex 442 MED（防御化吸收）：u-export.js 与 unify-helpers.js 共用 window.UnifyHelpers 命名空间——两文件
//   挂载名集合必须零交集（同名后挂载者静默覆盖先挂载者=跨文件语义劫持；442 时核实现状零交集，此断言防未来漂移）。
{
    const UNIFY_SRC = fs.readFileSync(path.join(PUBLIC_DIR, 'assets/js/unify-helpers.js'), 'utf8');
    const namesOf = (src) => new Set([...src.matchAll(/(?:w|root)\.UnifyHelpers\.([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]));
    const uexportNames = namesOf(UEXPORT_SRC);
    const unifyNames = namesOf(UNIFY_SRC);
    const overlap = [...uexportNames].filter((n) => unifyNames.has(n));
    must(uexportNames.size >= 6 && unifyNames.size >= 7, `零交集守卫前提：两文件挂载名均被提取到（u-export ${uexportNames.size} 个 / unify-helpers ${unifyNames.size} 个——提取为 0 即本断言失效，判红防守卫落空）`);
    must(overlap.length === 0, `UnifyHelpers 命名空间零交集（codex 442 MED 防御）：无同名覆盖${overlap.length ? '，冲突名=' + overlap.join(',') : ''}`);
}

// 扫描 public/*.html 找引用 u-export.js?v= 的页面（同 verify-u-paste.js F5 范式；S4 阶段预期 0 个，
// 框架就位不算失败）。H1+H3 自爆：页面已出现 attachExport(/u-export.js 文本信号，但没有走标准
// `<script src=".../u-export.js?v=...">` 引用形态 → 判红，不能静默漏检；已走标准引用的页面，
// 额外断言含 UnifyHelpers.uexportCheckVersion(...) 调用（H1：光挂 script 标签不调用版本比对等于没接）。
{
  const htmlFiles = fs.readdirSync(PUBLIC_DIR).filter((f) => f.toLowerCase().endsWith('.html'));
  const referencing = [];
  const wiredButNotReferencing = [];
  for (const f of htmlFiles) {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf8');
    if (/u-export\.js\?v=/.test(html)) referencing.push({ file: f, html });
    else if (hasWiringSignal(html)) wiredButNotReferencing.push(f);
  }
  for (const f of wiredButNotReferencing) {
    bad(`断言4：${f} 出现 attachExport(/u-export.js 文本信号，但未找到标准 <script src=".../u-export.js?v=..."> 引用——占位框架不应在真实接入后仍保持占位（H1+H3 自爆）`);
  }
  if (referencing.length === 0) {
    ok(`u-export.js 引用扫描：0 个页面引用（预期，S4 阶段共享层未接入任何页，S5/S6 接入后自动纳入下方版本一致性检查）`);
  } else {
    for (const { file, html } of referencing) {
      const srcMatch = /u-export\.js\?v=v[\d.]+_([a-zA-Z0-9]+)"/.exec(html);
      must(!!srcMatch, `${file}：含 u-export.js?v=..._<tag> 引用`);
      if (srcMatch && KIT_VERSION) {
        must(srcMatch[1] === KIT_VERSION, `${file}：<script src> 缓存串尾部 tag 与 KIT_VERSION 一致（实得="${srcMatch[1]}"，期望="${KIT_VERSION}"）`);
      }
      const expectMatch = /[A-Z0-9_]*_UEXPORT_KIT_EXPECTED\s*=\s*'([^']+)'/.exec(html);
      must(!!expectMatch, `${file}：含 *_UEXPORT_KIT_EXPECTED 版本比对常量`);
      if (expectMatch && KIT_VERSION) {
        must(expectMatch[1] === KIT_VERSION, `${file}：*_UEXPORT_KIT_EXPECTED 与 KIT_VERSION 一致（实得="${expectMatch[1]}"）`);
      }
      // H1：引用页须含 UnifyHelpers.uexportCheckVersion(...) 调用（同 u-paste.js 各引用页 UPaste.checkVersion() 范式）
      must(/UnifyHelpers\.uexportCheckVersion\s*\(/.test(html), `${file}：含 UnifyHelpers.uexportCheckVersion(...) 调用（H1）`);
    }
  }
}

// ── H1 对照组：合成样例证明"引用了 script 但没调用 uexportCheckVersion"确实会被判红（非恒真判据）──
console.log('');
console.log('— 断言 4 对照组：u-export.js 已引用但未调用 uexportCheckVersion（H1 自爆）—');
{
  const wiredNoCall = '<script src="assets/js/u-export.js?v=v1_uexport1"></script><script>UnifyHelpers.attachExport({buttonSelector:".x"});</script>';
  must(/UnifyHelpers\.uexportCheckVersion\s*\(/.test(wiredNoCall) === false, '★对照组：仅引用 script + 调用 attachExport，未调用 uexportCheckVersion → 判据函数正确识别为"未调用"（自证非恒真）');
  const wiredWithCall = wiredNoCall + '<script>UnifyHelpers.uexportCheckVersion("uexport1","Demo.html");</script>';
  must(/UnifyHelpers\.uexportCheckVersion\s*\(/.test(wiredWithCall) === true, '★对照组：补上调用后 → 判据函数正确识别为"已调用"');
}

// ============================================================
// 修4（预筛 C4c）：期望断言总数基线——防"pass===pass 自指真理"式假绿
// ============================================================
// 同 verify-correction-suspend-resume-e2e.js 的 EXPECTED_ASSERTION_COUNT 范式，但改成"基线+自爆条件"
// 组合而非硬钉等值：S4 脚手架阶段（三页均未接入）总数应恒定，硬钉等值能抓住"代码路径提前 return
// 漏跑断言"这类静默丢失；但 S5/S6 接入后，断言1/2/3 会从"0 命中即 ok"转成真实逐条判定，具体数字随
// 列配置/页面数量浮动，此时硬钉等值只会逼着每次业务微调列配置都要来改这个数字。改成"接入后总数必须
// 高于脚手架基线"：既不必随列数微调而改，又仍能防住假绿——如果接入后代码路径提前 return 漏跑了
// 断言，总数不可能被真实新增断言顶过基线，会在这里现形。
console.log('');
console.log('— 修4：期望断言总数基线（防 pass===pass 自指真理式假绿）—');
const anyPageWired = PAGES.some((p) => {
  const htmlPath = path.join(PUBLIC_DIR, p.file);
  if (!fs.existsSync(htmlPath)) return false;
  return hasWiringSignal(fs.readFileSync(htmlPath, 'utf8'));
});
const EXPORT_COLUMNS_SCAFFOLD_BASELINE = 77;
if (!anyPageWired) {
  must(pass + 1 === EXPORT_COLUMNS_SCAFFOLD_BASELINE,
    `期望断言总数基线：脚手架阶段（三页均未接入）总数应为 ${EXPORT_COLUMNS_SCAFFOLD_BASELINE}（实得 ${pass + 1}，含本条自身）——不等说明中途有断言被静默漏跑`);
} else {
  must(pass + 1 > EXPORT_COLUMNS_SCAFFOLD_BASELINE,
    `期望断言总数基线：检测到接入页 → 总数(${pass + 1}) 必须高于脚手架基线(${EXPORT_COLUMNS_SCAFFOLD_BASELINE})，证明接入触发了真实新增断言（非静默漏跑）`);
}

console.log(`\n=== ${fail === 0 ? 'PASS' : 'FAIL'}：${pass} 项通过 / ${fail} 项失败 ===`);
process.exit(fail === 0 ? 0 : 1);
