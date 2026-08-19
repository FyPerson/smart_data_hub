// verify-export-content.js — 三模块列表导出 文件内容测试（暂缓与列表导出方案 v1.1 §3.5，编码任务 S4-S6）
//
// 阶段声明（S6 全接线完成）：S4 交付共享层脚手架；S5 数据修正页接线；S6 数据协作+系统迭代两页接线，
//   至此三页 overdueRule/columns 全部落地。测试 5/6 是真实归一化逻辑断言（u-export.js 已交付，不依赖
//   任何页面）；测试 7/8 从 S4 的占位框架（0 次迭代 vacuous pass）演进为对三页真实源码的提取+编译+断言
//   （extractCorrOverdueRule/extractCollabFns/extractSiFns），不手抄复刻页面逻辑——写读两端同源核对。
//
// node 可测形态说明（回应派单方要求）：u-export.js 用 UMD 头（`typeof window` 守卫，见其文件头注释）
//   导出 fallbackVal/isValidDatePrefix 两个纯函数，以及 buildExportRows/buildExportHeader——后两者是
//   attachExport() 浏览器点击流程内部实际调用的同一份归一化函数（非另起复刻），供本文件直接 require
//   并接上同版 SheetJS（node_modules/xlsx，与 public/assets/vendor/xlsx.mini.min.js 同一份文件同版本）
//   完整走 json_to_sheet → write buffer → read 回读，测的是"实际导出路径的最终产物"（方案 §3.1.1 原话），
//   不测手工构造的内存 sheet。attachExport 本体的 DOM 操作部分（querySelector/addEventListener/
//   disabled 态切换）不在本文件测试范围——那需要真实 DOM，留浏览器实测（方案 §3.5"浏览器实测"清单）。
//
// 覆盖：
//   测试 5：公式注入反向样例 =1+1/@cmd/+55/-2 → 真实归一化 → XLSX.write → XLSX.read 回读，
//           断言 cell t==='s' 且无 f 属性
//   测试 6：空值/空串行 → cell 空串非 undefined；value() 抛错行 → '#ERR'
//   测试 7：超时列样例矩阵（三页全接入：数据修正/数据协作/系统迭代，各自 overdueRule 逐状态枚举）
//   测试 8：列数断言（三页全接入：数据修正 19 / 协作 17 / 系统迭代 18，表头文案+顺序逐一相等）
'use strict';
const fs = require('fs');
const path = require('path');
const XLSX = require(path.join(__dirname, '..', 'node_modules', 'xlsx', 'dist', 'xlsx.mini.min.js'));
const U = require(path.join(__dirname, '..', 'public', 'assets', 'js', 'u-export.js'));

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [OK] ${m}`); };
const bad = (m) => { fail++; console.log(`  [FAIL] ${m}`); };
const must = (cond, m) => cond ? ok(m) : bad(m);

// 三页路径（测试 7/8 共用——从各自文件迁到文件头，供两处自爆规则都能引用，非新增职责）。
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PAGE_MAP = { correction: 'Data_Correction.html', collab: 'Data_Collab.html', sysIssue: 'Sys_Iteration.html' };
function readPageIfExists(file) {
  const p = path.join(PUBLIC_DIR, file);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

// S5：从 Data_Correction.html 源码里原样提取 corrOverdueRule（含其两个辅助函数 corrParseDatetimeLocal/
//   corrFormatDuration）并编译为可调用函数——**不在本文件手写一份复刻实现**（写读两端语义必须同源核对：
//   若在这里手抄一遍判定逻辑，页面改了判定分支而这里忘了同步改，测试会继续对着一份过期逻辑judge 出假绿）。
//   提取边界=三个 function 声明起点 + CORR_EXPORT_COLUMNS 声明前（该常量引用 corrOverdueRule/STATUS_LABELS
//   等页面变量，不纳入提取，否则 compile 会因未定义的 STATUS_LABELS 等报错）。
//   返回可调用的 (row, now) => {overdue, duration}；标记文本任一缺失或编译失败均返回 null（调用方据此
//   区分"真尚未接入"与"接入了但提取/编译失败"，H3 同款自爆纪律，不能静默当同一种"0 条"处理）。
function extractCorrOverdueRule() {
  const html = readPageIfExists(PAGE_MAP.correction);
  if (!html) return null;
  const s1 = html.indexOf('function corrParseDatetimeLocal');
  const s2 = html.indexOf('function corrFormatDuration');
  const s3 = html.indexOf('function corrOverdueRule');
  const s4 = html.indexOf('const CORR_EXPORT_COLUMNS');
  if (s1 < 0 || s2 < 0 || s3 < 0 || s4 < 0 || !(s1 < s2 && s2 < s3 && s3 < s4)) return null;
  const src = html.slice(s1, s4);
  try {
    const factory = new Function('UnifyHelpers', src + '\nreturn corrOverdueRule;');
    const fn = factory({ fallbackVal: U.fallbackVal, isValidDatePrefix: U.isValidDatePrefix });
    return (typeof fn === 'function') ? fn : null;
  } catch (e) {
    console.warn('[verify-export-content] extractCorrOverdueRule 编译失败：' + String(e && e.message || e));
    return null;
  }
}

// S6：从任意起点提取一个 function 声明的完整源码（花括号深度平衡定位闭合 `}`）——供 extractSiFns
//   截取独立的单行函数 siStatusDisplay（它前后没有本文件已知的其他 marker 可夹取）。
function findFunctionEnd(text, startIdx) {
  const braceStart = text.indexOf('{', startIdx);
  if (braceStart < 0) return -1;
  let depth = 0;
  for (let i = braceStart; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// M2（预筛 C6b）：从 `[` 起（openIdx 指向该字符本身）找配对的 `]`，跨 ()/[]/{} 混合按任意开括号+1/
//   任意闭括号-1 计深度（同 verify-export-columns.js findBalancedEnd 算法）——供 extractExportColumnLabels
//   与三个 extractXxxColumnsRuntime 共用（原先各自各写一份内联循环，此处收成一份不重复）。
function findArrayEnd(text, openIdx) {
  let depth = 0, end = -1;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  return end;
}

// S6：同 extractCorrOverdueRule 范式——原样提取 Data_Collab.html 的 collabOverdueRule +
//   collabExportValidationStatus（含其依赖的 collabParseDatetimeLocal/collabFormatDuration），
//   不手抄复刻。返回 { rule, val } 或 null（标记缺失/编译失败）。
function extractCollabFns() {
  const html = readPageIfExists(PAGE_MAP.collab);
  if (!html) return null;
  const s1 = html.indexOf('function collabParseDatetimeLocal');
  const s2 = html.indexOf('function collabFormatDuration');
  const s3 = html.indexOf('function collabOverdueRule');
  const s4 = html.indexOf('function collabExportValidationStatus');
  const s5 = html.indexOf('const COLLAB_EXPORT_COLUMNS');
  if (s1 < 0 || s2 < 0 || s3 < 0 || s4 < 0 || s5 < 0 || !(s1 < s2 && s2 < s3 && s3 < s4 && s4 < s5)) return null;
  const src = html.slice(s1, s5);
  try {
    const factory = new Function('UnifyHelpers', src + '\nreturn { rule: collabOverdueRule, val: collabExportValidationStatus };');
    const out = factory({ fallbackVal: U.fallbackVal, isValidDatePrefix: U.isValidDatePrefix });
    return (out && typeof out.rule === 'function' && typeof out.val === 'function') ? out : null;
  } catch (e) {
    console.warn('[verify-export-content] extractCollabFns 编译失败：' + String(e && e.message || e));
    return null;
  }
}

// S6：同上，Sys_Iteration.html 的 siOverdueRule + siStatusDisplay（后者用于验证"状态列出改名值、
//   超时列按原始值命中分支"这条方案明文要求的双态断言）。返回 { rule, statusDisplay } 或 null。
function extractSiFns() {
  const html = readPageIfExists(PAGE_MAP.sysIssue);
  if (!html) return null;
  const s1 = html.indexOf('function siLocalDatePrefix');
  const s2 = html.indexOf('function siDatePrefixDiffDays');
  const s3 = html.indexOf('function siOverdueRule');
  const s4 = html.indexOf('const SI_EXPORT_COLUMNS');
  const sd = html.indexOf('function siStatusDisplay(');
  if (s1 < 0 || s2 < 0 || s3 < 0 || s4 < 0 || sd < 0 || !(s1 < s2 && s2 < s3 && s3 < s4)) return null;
  const ruleSrc = html.slice(s1, s4);
  const sdEnd = findFunctionEnd(html, sd);
  if (sdEnd < 0) return null;
  const sdSrc = html.slice(sd, sdEnd + 1);
  try {
    const factory = new Function('UnifyHelpers', ruleSrc + '\n' + sdSrc + '\nreturn { rule: siOverdueRule, statusDisplay: siStatusDisplay };');
    const out = factory({ fallbackVal: U.fallbackVal, isValidDatePrefix: U.isValidDatePrefix });
    return (out && typeof out.rule === 'function' && typeof out.statusDisplay === 'function') ? out : null;
  } catch (e) {
    console.warn('[verify-export-content] extractSiFns 编译失败：' + String(e && e.message || e));
    return null;
  }
}

// M2（预筛 C6b，方案 §3.5 测试7 末句）：原样提取三页 COLUMNS 常量 + 其 value() 真正引用的依赖函数/常量
//   （formatOaNo/sysLabel/收窄版 overdueRule 链），编译出真实可跑的 { columns, overdueRule }——
//   不手抄 value() 逻辑，跑的是页面里那份原文。只提取"我方将实际调用的列"所需的依赖（未测的列如
//   状态/类型等即便在数组里也不需要其依赖存在——JS 对象字面量里的箭头函数体只在真正调用时才解析
//   自由变量，不调用就不需要该变量已定义）。
// 预筛 C6d 修2：M3 从代表列扩到全部含 value() 的派生列后，status 列（STATUS_LABELS[r.status]）也要真跑
//   得到，故提取范围补上 STATUS_LABELS 声明（数据修正/数据协作各一份，页面独立不共享）。
function extractCorrColumnsRuntime() {
  const html = readPageIfExists(PAGE_MAP.correction);
  if (!html) return null;
  const sl = html.indexOf('const STATUS_LABELS = {');
  const slEnd = sl >= 0 ? findArrayEnd(html, html.indexOf('{', sl)) : -1;
  const s0 = html.indexOf('function oaCore(raw)');
  const s1 = html.indexOf('function formatOaNo(raw)');
  const e1 = s1 >= 0 ? findFunctionEnd(html, s1) : -1;
  const s2 = html.indexOf('function sysLabel(it)');
  const e2 = s2 >= 0 ? findFunctionEnd(html, s2) : -1;
  const s3 = html.indexOf('function corrParseDatetimeLocal');
  const s4 = html.indexOf('const CORR_EXPORT_COLUMNS = [');
  if (sl < 0 || slEnd < 0 || s0 < 0 || s1 < 0 || e1 < 0 || s2 < 0 || e2 < 0 || s3 < 0 || s4 < 0) return null;
  const arrEnd = findArrayEnd(html, html.indexOf('[', s4));
  if (arrEnd < 0) return null;
  const combinedSrc = html.slice(sl, slEnd + 1) + ';\n' + html.slice(s0, e1 + 1) + '\n' + html.slice(s2, e2 + 1) + '\n' +
    html.slice(s3, s4) + '\n' + html.slice(s4, arrEnd + 1) + ';\n';
  try {
    const factory = new Function('UnifyHelpers', combinedSrc + 'return { columns: CORR_EXPORT_COLUMNS, overdueRule: corrOverdueRule };');
    return factory({ fallbackVal: U.fallbackVal, isValidDatePrefix: U.isValidDatePrefix });
  } catch (e) {
    console.warn('[verify-export-content] extractCorrColumnsRuntime 编译失败：' + String(e && e.message || e));
    return null;
  }
}
// 预筛 C6d 修2：target_db_connection_id 列的 value() 读页面级闭包变量 targetDbMap（Data_Collab.html:1853
//   声明，提取范围外——本函数只提取 collabParseDatetimeLocal 起的一段，targetDbMap 声明在更早处，
//   不便随意扩大提取范围引入更多无关依赖），改走 Function 工厂形参注入一份 fixture map（COLLAB_TARGET_DB_MAP_FIXTURE，
//   定义见下方 M3 分段）。STATUS_LABELS 同上——补进提取范围供 status 列真跑。
function extractCollabColumnsRuntime(targetDbMapFixture) {
  const html = readPageIfExists(PAGE_MAP.collab);
  if (!html) return null;
  const sl = html.indexOf('const STATUS_LABELS = {');
  const slEnd = sl >= 0 ? findArrayEnd(html, html.indexOf('{', sl)) : -1;
  const s1 = html.indexOf('function collabParseDatetimeLocal');
  const s2 = html.indexOf('const COLLAB_EXPORT_COLUMNS = [');
  if (sl < 0 || slEnd < 0 || s1 < 0 || s2 < 0) return null;
  const arrEnd = findArrayEnd(html, html.indexOf('[', s2));
  if (arrEnd < 0) return null;
  const combinedSrc = html.slice(sl, slEnd + 1) + ';\n' + html.slice(s1, s2) + '\n' + html.slice(s2, arrEnd + 1) + ';\n';
  try {
    const factory = new Function('UnifyHelpers', 'targetDbMap', combinedSrc + 'return { columns: COLLAB_EXPORT_COLUMNS, overdueRule: collabOverdueRule, val: collabExportValidationStatus };');
    return factory({ fallbackVal: U.fallbackVal, isValidDatePrefix: U.isValidDatePrefix }, targetDbMapFixture || {});
  } catch (e) {
    console.warn('[verify-export-content] extractCollabColumnsRuntime 编译失败：' + String(e && e.message || e));
    return null;
  }
}
// 预筛 C6d 修2：dev_roster_names 列的 value()（C6c M-2 引入）依赖 siDevRosterNamesResolved（:2276 声明，
//   自包含函数、无外部自由变量，见其定义处注释核实）与 type 列依赖的 SI_TYPE_LABEL/siTypeLabel（:867/:1485），
//   均须一并提取，否则对应列 value() 调用时 ReferenceError（M3 扩全列后会真的调用到它们）。
function extractSiColumnsRuntime() {
  const html = readPageIfExists(PAGE_MAP.sysIssue);
  if (!html) return null;
  const tl = html.indexOf('const SI_TYPE_LABEL = {');
  const tlEnd = tl >= 0 ? findArrayEnd(html, html.indexOf('{', tl)) : -1;
  const tf = html.indexOf('function siTypeLabel(');
  const tfEnd = tf >= 0 ? findFunctionEnd(html, tf) : -1;
  const sd = html.indexOf('function siStatusDisplay(');
  const sdEnd = sd >= 0 ? findFunctionEnd(html, sd) : -1;
  const sr = html.indexOf('function siDevRosterNamesResolved');
  const srEnd = sr >= 0 ? findFunctionEnd(html, sr) : -1;
  const s1 = html.indexOf('function siLocalDatePrefix');
  const s2 = html.indexOf('const SI_EXPORT_COLUMNS = [');
  if (tl < 0 || tlEnd < 0 || tf < 0 || tfEnd < 0 || sd < 0 || sdEnd < 0 || sr < 0 || srEnd < 0 || s1 < 0 || s2 < 0) return null;
  const arrEnd = findArrayEnd(html, html.indexOf('[', s2));
  if (arrEnd < 0) return null;
  const combinedSrc = html.slice(tl, tlEnd + 1) + ';\n' + html.slice(tf, tfEnd + 1) + '\n' +
    html.slice(sd, sdEnd + 1) + '\n' + html.slice(sr, srEnd + 1) + '\n' +
    html.slice(s1, s2) + '\n' + html.slice(s2, arrEnd + 1) + ';\n';
  try {
    const factory = new Function('UnifyHelpers', combinedSrc + 'return { columns: SI_EXPORT_COLUMNS, overdueRule: siOverdueRule };');
    return factory({ fallbackVal: U.fallbackVal, isValidDatePrefix: U.isValidDatePrefix });
  } catch (e) {
    console.warn('[verify-export-content] extractSiColumnsRuntime 编译失败：' + String(e && e.message || e));
    return null;
  }
}

// 修4（预筛 C4c）：测试 7 的 wiredPages 检测原先直接在页面原文上跑正则，会被"注释里提一句 overdueRule
// 还没写"或"示例字符串/文档说明里恰好出现 attachExport("这类文字误导（假判红）。剥注释+字符串/模板
// 字面量遮罩后再匹配——与 verify-export-columns.js 的 maskJsLike/maskAttachExportSource 同一份逻辑
// （各 verify 脚本独立可跑、不互相 require，故本文件按同款范式独立维护一份，非重复造轮子）：注释/
// 字符串/模板字面量内容替换为空白（本文件只做布尔信号判定，不需要位置保持，直接拼接省去即可，不必
// 等长占位）。<script> 块作用域同款处理：只在内联 <script> 内部遮罩，块外 HTML 标记原样保留。
// 已知边界（N3，预筛 C6b 补登，同 verify-export-columns.js maskJsLike 同款说明）：**正则字面量不识别**
// ——`/xxx/` 形式的正则内容按普通代码字符处理，不当独立上下文遮罩；本文件只做布尔信号判定（是否出现
// overdueRule/attachExport 字样），真撞见正则里带这些子串的情况极小概率，暂不处理。
function maskJsLikeForSignal(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      if (i < n) i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch; i++;
      while (i < n && text[i] !== quote) {
        if (text[i] === '\\' && i + 1 < n) { i += 2; continue; }
        if (quote !== '`' && text[i] === '\n') break;   // 单/双引号内未转义换行=非法结束，放弃遮罩
        i++;
      }
      if (i < n && text[i] === quote) { out += quote; i++; }
      continue;
    }
    out += ch; i++;
  }
  return out;
}
function maskPageForSignal(html) {
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let hasScriptTag = false;
  let out = '';
  let last = 0;
  let m;
  while ((m = scriptRe.exec(html))) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/.test(attrs)) continue;   // 外链脚本无内联内容，跳过
    hasScriptTag = true;
    // N2（预筛 C6b）：长度算术定位内层起点，不用 m[0].indexOf(m[2]) 内容搜索（同 verify-export-columns.js
    // maskAttachExportSource 同款修法——m[0] 结构固定=开标签+内层内容+'</script>'，减法直接算出，
    // 不受"内层内容恰与开标签文本重复"这类边界干扰）。
    const innerAbsStart = m.index + m[0].length - m[2].length - '</script>'.length;
    out += html.slice(last, innerAbsStart);
    out += maskJsLikeForSignal(m[2]);
    last = innerAbsStart + m[2].length;
  }
  out += html.slice(last);
  if (!hasScriptTag) return maskJsLikeForSignal(html);
  return out;
}

console.log('=== 三模块列表导出 文件内容测试（暂缓与列表导出方案 v1.1 §3.5）===\n');

// 走真实路径：U.buildExportWorkbook（attachExport 点击流程内部同一份函数，预筛 C4 M3 下沉）→
//   write buffer → read 回读，返回回读后的 worksheet 供断言。sheetRows/header 仍另调 buildExportRows/
//   buildExportHeader 取（同一份函数，供断言读中间产物，非重复实现——sheet 构建这一层已只有一份）。
function exportAndReread(rows, columns, ctx) {
  const wb = U.buildExportWorkbook(rows, columns, ctx || {}, XLSX);
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const wbRead = XLSX.read(buf, { type: 'buffer' });
  const wsRead = wbRead.Sheets[wbRead.SheetNames[0]];
  const sheetRows = U.buildExportRows(rows, columns, ctx || {});
  const header = U.buildExportHeader(columns);
  return { wsRead, sheetRows, header };
}

// ============================================================
// 测试 5：公式注入反向样例（codex 431 HIGH-4 + 432 HIGH-6 收敛）
// ============================================================
console.log('— 测试 5：公式注入反向样例（真实归一化 → XLSX.write buffer → XLSX.read 回读）—');
{
  const injectionSamples = ['=1+1', '@cmd', '+55', '-2'];
  const columns = [{ key: 'location_info', label: '修正方式' }];
  for (const sample of injectionSamples) {
    const rows = [{ location_info: sample }];
    const { wsRead } = exportAndReread(rows, columns);
    const cellAddr = XLSX.utils.encode_cell({ r: 1, c: 0 });   // r0=header 行，r1=首条数据行
    const cell = wsRead[cellAddr];
    must(!!cell, `样例 "${sample}"：回读单元格 ${cellAddr} 存在`);
    if (cell) {
      must(cell.t === 's', `样例 "${sample}"：cell.t === 's'（实得 "${cell.t}"）`);
      must(!Object.prototype.hasOwnProperty.call(cell, 'f'), `样例 "${sample}"：cell 无 f（公式）属性`);
      must(cell.v === sample, `样例 "${sample}"：cell.v 原样保留为文本（实得 ${JSON.stringify(cell.v)}）`);
    }
  }
}
console.log('');

// ============================================================
// 测试 6：空值/空串行 → cell 空串非 undefined；value() 抛错行 → '#ERR'
// ============================================================
console.log('— 测试 6：空值/空串行 → 空串非 undefined；value() 抛错行 → #ERR —');
{
  const columns = [
    { key: 'a', label: 'A' },
    { key: 'b', label: 'B', deps: ['b'], value: (r) => { throw new Error('模拟 value() 抛异常'); } },
  ];
  const rows = [
    { a: null, b: 1 },
    { a: undefined, b: 1 },
    { a: '', b: 1 },
    { a: '   ', b: 1 },   // 纯空白同样归一为空（fallbackVal trim 判定）
    { a: 'x', b: 1 },
  ];
  const { wsRead, sheetRows } = exportAndReread(rows, columns);
  const expectedA = ['', '', '', '', 'x'];
  for (let i = 0; i < rows.length; i++) {
    must(sheetRows[i].A === expectedA[i], `buildExportRows 行${i}：A 列归一化值为 ${JSON.stringify(expectedA[i])}（实得 ${JSON.stringify(sheetRows[i].A)}）`);
    must(sheetRows[i].A !== undefined, `buildExportRows 行${i}：A 列值非 undefined`);
    const addrA = XLSX.utils.encode_cell({ r: i + 1, c: 0 });
    const cellA = wsRead[addrA];
    must(!!cellA && cellA.v === expectedA[i], `回读行${i}：A 列 cell.v 与归一化值一致（实得 ${JSON.stringify(cellA && cellA.v)}）`);
    must(sheetRows[i].B === '#ERR', `buildExportRows 行${i}：B 列 value() 抛异常 → '#ERR'（实得 ${JSON.stringify(sheetRows[i].B)}）`);
    const addrB = XLSX.utils.encode_cell({ r: i + 1, c: 1 });
    const cellB = wsRead[addrB];
    must(!!cellB && cellB.v === '#ERR' && cellB.t === 's', `回读行${i}：B 列 cell.v==='#ERR' 且 t==='s'（非中断整文件生成）`);
  }
}
console.log('');

// ============================================================
// 纯函数直测（预筛 C4 M4）：isValidDatePrefix / fallbackVal 样本矩阵直接 require 断言
// ============================================================
console.log('— 纯函数直测：isValidDatePrefix 日期矩阵（预筛 C4 M4）—');
{
  const DATE_CASES = [
    ['2026-02-29', null, '2026 非闰年，2 月无 29 日'],
    ['2024-02-29', '2024-02-29', '2024 是闰年（4 整除且非世纪年）'],
    ['2400-02-29', '2400-02-29', '2400 是世纪闰年（400 整除）'],
    ['2100-02-29', null, '2100 是世纪年但非 400 整除，非闰年'],
    ['2026-13-01', null, '月份 13 非法'],
    ['2026-00-10', null, '月份 00 非法（<1）'],
    ['2026-04-31', null, '4 月无 31 日'],
    ['2026-8-19', null, '月份非两位数字，正则 \\d{2} 不匹配'],
    [123, null, '非字符串输入直接 null（类型判定）'],
    [null, null, 'null 输入直接 null'],
    [undefined, null, 'undefined 输入直接 null'],
  ];
  for (const [input, expected, reason] of DATE_CASES) {
    const got = U.isValidDatePrefix(input);
    must(got === expected, `isValidDatePrefix(${JSON.stringify(input)}) === ${JSON.stringify(expected)}（${reason}），实得 ${JSON.stringify(got)}`);
  }
  // 前后空白：L2 新增行为——trim 后验证，返回值是 trim 后的规范化前缀（非原始未 trim 值）。
  must(U.isValidDatePrefix('  2026-08-19  ') === '2026-08-19', 'isValidDatePrefix 容忍前后空白（L2）：trim 后校验并返回规范化的 10 位前缀');
}
console.log('');

console.log('— 纯函数直测：fallbackVal 四态语义（预筛 C4 M4）—');
{
  must(U.fallbackVal(0, 'D') === 0, 'fallbackVal(0, "D") === 0（数字 0 不算"空"，非 undefined/null/空串/纯空白）');
  must(U.fallbackVal(false, 'D') === false, 'fallbackVal(false, "D") === false（布尔 false 不算"空"）');
  must(U.fallbackVal('  x  ', 'D') === '  x  ', 'fallbackVal("  x  ", "D") 原样返回未 trim 的原值（trim 只用于"是否算空"的判定，不改写返回值）');
  must(U.fallbackVal('\t\n', 'D') === 'D', 'fallbackVal("\\t\\n", "D") === "D"（纯空白 trim 后为空串，算"空"，回退）');
}
console.log('');

console.log('— 纯函数直测：toCellString 日期串裁秒归一（L1，预筛 C6b，方案 §3.1.1 展示格式字面兑现）—');
{
  must(U.toCellString('2026-08-19 09:05:30') === '2026-08-19 09:05', 'toCellString("2026-08-19 09:05:30") 裁秒 → "2026-08-19 09:05"');
  must(U.toCellString('2026-08-19 09:05:00') === '2026-08-19 09:05', 'toCellString("2026-08-19 09:05:00") 裁秒 → "2026-08-19 09:05"（秒=00 同样裁）');
  must(U.toCellString('2026-08-19 09:05') === '2026-08-19 09:05', 'toCellString("2026-08-19 09:05")（本就无秒）原样直通');
  must(U.toCellString('2026-08-19') === '2026-08-19', 'toCellString("2026-08-19")（纯日期无时分）不匹配裁秒正则，原样直通');
  must(U.toCellString('客户报销平台') === '客户报销平台', 'toCellString("客户报销平台")（非日期文本）原样直通，不误伤');
  must(U.toCellString('2026-08-19T09:05:30') === '2026-08-19T09:05:30', 'toCellString("2026-08-19T09:05:30")（T 分隔的 ISO 形态，非本仓存储格式）不匹配，原样直通');
}
console.log('');

console.log('— 修4 对照组：maskPageForSignal 剥注释+字符串遮罩，wiredPages 判据非恒真 —');
{
  const commentOnly = '<script>\n  // 还没写：overdueRule/UnifyHelpers.attachExport(...) 都待实现\n  console.log(1);\n</script>';
  const maskedComment = maskPageForSignal(commentOnly);
  must(!/overdueRule\s*[:(]/.test(maskedComment) && !/UnifyHelpers\.attachExport\s*\(/.test(maskedComment),
    '★对照组：注释里提及 overdueRule/attachExport( 不构成真实信号（遮罩后两个正则都不应命中）');
  const sampleStringOnly = '<script>\n  var demoText = "示例文案：overdueRule 即将上线，UnifyHelpers.attachExport(占位)";\n</script>';
  const maskedString = maskPageForSignal(sampleStringOnly);
  must(!/overdueRule\s*[:(]/.test(maskedString) && !/UnifyHelpers\.attachExport\s*\(/.test(maskedString),
    '★对照组：示例字符串里提及 overdueRule/attachExport( 不构成真实信号（遮罩后两个正则都不应命中）');
  const realCode = '<script>\n  function overdueRule(row){return 1;}\n  UnifyHelpers.attachExport({buttonSelector:".x"});\n</script>';
  const maskedReal = maskPageForSignal(realCode);
  must(/overdueRule\s*[:(]/.test(maskedReal) && /UnifyHelpers\.attachExport\s*\(/.test(maskedReal),
    '★对照组：真实代码里的 overdueRule/attachExport( 遮罩后仍能被正确识别（判据非恒假）');
}
console.log('');

// ============================================================
// 测试 7：超时列样例矩阵（S5：数据修正矩阵接入；协作/系统迭代 S6 待补）
// ============================================================
console.log('— 测试 7：超时列样例矩阵（数据修正 corrOverdueRule，方案 §3.3.1 数据修正枚举表逐行覆盖）—');
const CORR_OVERDUE_RULE = extractCorrOverdueRule();
if (readPageIfExists(PAGE_MAP.correction) && !CORR_OVERDUE_RULE) {
  bad('超时列样例矩阵：Data_Correction.html 已存在但 corrOverdueRule 提取/编译失败——见 extractCorrOverdueRule 实现，检查页面源码内 function corrParseDatetimeLocal/corrFormatDuration/corrOverdueRule + const CORR_EXPORT_COLUMNS 四个标记文本的出现顺序与拼写是否仍与提取逻辑一致（H3 自爆：接入了却抓不到，不能静默当未接入）');
}
// 固定基准时刻（非 new Date()）：矩阵样例围绕它手工构造，跑多少次结果都一致，不做"随跑随变"的浮动断言。
const CORR_NOW = new Date(2026, 7, 19, 12, 0);   // 2026-08-19 12:00 本地时间
// 结构：{ label, row, expectOverdue, expectDuration }。label 覆盖清单对照方案 §3.3.1 数据修正枚举表
//   （9 态全覆盖，逐行见下方注释）+ §3.5 测试7 原文要求的暂缓中/未设时限/进行中已超期/无完成时间/
//   日期无效（脏值）/行政闭环/fallbackVal 回退（首完成字段空串而备用字段有值）。
const OVERDUE_MATRIX = CORR_OVERDUE_RULE ? [
  // § 表行 2：SUSPENDED → 暂缓中（不判，优先于时限检查）
  { label: '暂缓中（SUSPENDED，不判）', row: { status: 'SUSPENDED', expected_deadline: '2026-08-01 10:00:00' }, expectOverdue: '暂缓中', expectDuration: '' },
  // § 表行 5：REJECTED/VOIDED → —（不判）
  { label: '—（REJECTED，不判）', row: { status: 'REJECTED', expected_deadline: '2026-08-01 10:00:00' }, expectOverdue: '—', expectDuration: '' },
  { label: '—（VOIDED，不判，无 deadline 也不判）', row: { status: 'VOIDED' }, expectOverdue: '—', expectDuration: '' },
  // § 表行 6：时限空（任意状态）→ 未设时限（PENDING_ASSIGN 代表；null 与空串两种空值形态各一条）
  { label: '未设时限（PENDING_ASSIGN，deadline=null）', row: { status: 'PENDING_ASSIGN', expected_deadline: null }, expectOverdue: '未设时限', expectDuration: '' },
  { label: '未设时限（ASSIGNED_PENDING_ESTIMATE，deadline=""）', row: { status: 'ASSIGNED_PENDING_ESTIMATE', expected_deadline: '' }, expectOverdue: '未设时限', expectDuration: '' },
  // § 表行 1：未完成三态 → now>时限「进行中已超期」/ 否则「未超时」
  { label: '进行中已超期（PENDING_ASSIGN，now>deadline）', row: { status: 'PENDING_ASSIGN', expected_deadline: '2026-08-18 10:00:00' }, expectOverdue: '进行中已超期', expectDuration: '1 天 2 小时' },
  { label: '进行中已超期（IN_PROGRESS，跨小时不跨天）', row: { status: 'IN_PROGRESS', expected_deadline: '2026-08-19 09:00:00' }, expectOverdue: '进行中已超期', expectDuration: '0 天 3 小时' },
  { label: '未超时（ASSIGNED_PENDING_ESTIMATE，now<=deadline）', row: { status: 'ASSIGNED_PENDING_ESTIMATE', expected_deadline: '2026-08-20 10:00:00' }, expectOverdue: '未超时', expectDuration: '' },
  // § 表行 3：FIXED/REFIXED → 完成锚>时限「超时」/ 否则「未超时」；锚缺失/非法「无完成时间」
  { label: '超时（FIXED，完成锚>deadline）', row: { status: 'FIXED', expected_deadline: '2026-08-10 10:00:00', fixed_at: '2026-08-12 10:00:00' }, expectOverdue: '超时', expectDuration: '2 天 0 小时' },
  { label: '未超时（FIXED，完成锚<=deadline）', row: { status: 'FIXED', expected_deadline: '2026-08-15 10:00:00', fixed_at: '2026-08-12 10:00:00' }, expectOverdue: '未超时', expectDuration: '' },
  { label: '无完成时间（FIXED，refixed_at/fixed_at 均缺失）', row: { status: 'FIXED', expected_deadline: '2026-08-10 10:00:00', fixed_at: null, refixed_at: null }, expectOverdue: '无完成时间', expectDuration: '' },
  { label: 'fallbackVal 回退：首完成字段空串而备用字段有值（refixed_at=""→回退 fixed_at）', row: { status: 'FIXED', expected_deadline: '2026-08-10 10:00:00', fixed_at: '2026-08-12 10:00:00', refixed_at: '' }, expectOverdue: '超时', expectDuration: '2 天 0 小时' },
  { label: 'REFIXED 完成锚取 refixed_at（非 fixed_at，两者皆有值时优先取首位）', row: { status: 'REFIXED', expected_deadline: '2026-08-10 10:00:00', fixed_at: '2026-08-05 10:00:00', refixed_at: '2026-08-13 10:00:00' }, expectOverdue: '超时', expectDuration: '3 天 0 小时' },
  // § 表行 4：ARCHIVED → 完成锚非空按已完成判；完成锚空「行政闭环」（不判，优先于时限检查）
  { label: '行政闭环（ARCHIVED，完成锚空，未修正过）', row: { status: 'ARCHIVED', expected_deadline: '2026-08-10 10:00:00', fixed_at: null, refixed_at: null }, expectOverdue: '行政闭环', expectDuration: '' },
  { label: '超时（ARCHIVED，完成锚非空按已完成判）', row: { status: 'ARCHIVED', expected_deadline: '2026-08-10 10:00:00', fixed_at: '2026-08-15 10:00:00' }, expectOverdue: '超时', expectDuration: '5 天 0 小时' },
  { label: '未超时（ARCHIVED，完成锚非空未超时）', row: { status: 'ARCHIVED', expected_deadline: '2026-08-20 10:00:00', fixed_at: '2026-08-12 10:00:00' }, expectOverdue: '未超时', expectDuration: '' },
  // §3.3 日期比较纪律：deadline 非空但非法（脏值）→「日期无效」（区别于「未设时限」的"空"）
  { label: '日期无效（deadline 非空但非法，13 月不存在）', row: { status: 'IN_PROGRESS', expected_deadline: '2026-13-45 10:00:00' }, expectOverdue: '日期无效', expectDuration: '' },
  // 预筛 C6d 修1：corrParseDatetimeLocal 收紧后的两条反例——时分超范围（禁 Date 自动进位吞掉脏值）+
  //   带脏后缀（正则须锚定结尾，防非锚定正则截断匹配前缀就当合法）。
  { label: '日期无效（时分超范围脏值 99:99，禁 Date 自动进位）', row: { status: 'IN_PROGRESS', expected_deadline: '2026-08-10 99:99' }, expectOverdue: '日期无效', expectDuration: '' },
  { label: '日期无效（时间部分带脏后缀，正则须锚定结尾）', row: { status: 'IN_PROGRESS', expected_deadline: '2026-08-10 10:00脏后缀' }, expectOverdue: '日期无效', expectDuration: '' },
  // 通则②：完成锚非空但非法（脏值）→ 仍统一「无完成时间」（不像 deadline 那样拆出"日期无效"）
  { label: '无完成时间（完成锚非空但非法脏值，与 deadline 处理刻意不同）', row: { status: 'FIXED', expected_deadline: '2026-08-10 10:00:00', fixed_at: '2026-99-99 10:00:00' }, expectOverdue: '无完成时间', expectDuration: '' },
  // L2（预筛 C6b）：完成锚纯空白（refixed_at 空、fixed_at 是纯空白脏值 '   '）→ anchorEmpty 须判空
  // （UnifyHelpers.fallbackVal(anchorRaw,'')==='' 的 trim 尺子），FIXED 态落「无完成时间」、ARCHIVED
  // 态落「行政闭环」——两条各一样例，对齐 anchorEmpty 修复前后行为分叉的两个真实触发点。
  { label: '完成锚纯空白（FIXED，fixed_at="   "）→无完成时间', row: { status: 'FIXED', expected_deadline: '2026-08-10 10:00:00', refixed_at: null, fixed_at: '   ' }, expectOverdue: '无完成时间', expectDuration: '' },
  { label: '完成锚纯空白（ARCHIVED，fixed_at="   "）→行政闭环', row: { status: 'ARCHIVED', expected_deadline: '2026-08-10 10:00:00', refixed_at: null, fixed_at: '   ' }, expectOverdue: '行政闭环', expectDuration: '' },
] : [];

// S6：数据协作矩阵（collabOverdueRule，方案 §3.3.1 协作表 + collabExportValidationStatus 7 态映射）。
console.log('— 测试 7：超时列样例矩阵（数据协作 collabOverdueRule，方案 §3.3.1 协作表逐行覆盖）—');
const COLLAB_FNS = extractCollabFns();
if (readPageIfExists(PAGE_MAP.collab) && !COLLAB_FNS) {
  bad('超时列样例矩阵：Data_Collab.html 已存在但 collabOverdueRule/collabExportValidationStatus 提取/编译失败——见 extractCollabFns 实现，检查页面源码内 function collabParseDatetimeLocal/collabFormatDuration/collabOverdueRule/collabExportValidationStatus + const COLLAB_EXPORT_COLUMNS 五个标记文本的出现顺序与拼写是否仍与提取逻辑一致（H3 自爆：接入了却抓不到，不能静默当未接入）');
}
const COLLAB_NOW = new Date(2026, 7, 19, 12, 0);
const COLLAB_OVERDUE_MATRIX = COLLAB_FNS ? [
  { label: 'DONE 超时（done_at>deadline）', row: { status: 'DONE', deadline: '2026-08-10 10:00:00', done_at: '2026-08-15 10:00:00' }, expectOverdue: '超时', expectDuration: '5 天 0 小时' },
  { label: 'DONE 未超时（done_at<=deadline）', row: { status: 'DONE', deadline: '2026-08-25 10:00:00', done_at: '2026-08-15 10:00:00' }, expectOverdue: '未超时', expectDuration: '' },
  { label: 'ARCHIVED 完成锚空（done_at/archived_final_at 均缺失）→无完成时间', row: { status: 'ARCHIVED', deadline: '2026-08-10 10:00:00', done_at: null, archived_final_at: null }, expectOverdue: '无完成时间', expectDuration: '' },
  { label: 'fallbackVal 回退（done_at 空串→回退 archived_final_at）', row: { status: 'ARCHIVED', deadline: '2026-08-10 10:00:00', done_at: '', archived_final_at: '2026-08-13 10:00:00' }, expectOverdue: '超时', expectDuration: '3 天 0 小时' },
  { label: '日期无效（deadline 非空但非法脏值）', row: { status: 'PENDING', deadline: '2026-13-45 10:00:00' }, expectOverdue: '日期无效', expectDuration: '' },
  // 预筛 C6d 修1：collabParseDatetimeLocal 收紧后的两条反例——时分超范围（禁 Date 自动进位吞掉脏值）+
  //   带脏后缀（正则须锚定结尾，防非锚定正则截断匹配前缀就当合法）。
  { label: '日期无效（时分超范围脏值 99:99，禁 Date 自动进位）', row: { status: 'PENDING', deadline: '2026-08-10 99:99' }, expectOverdue: '日期无效', expectDuration: '' },
  { label: '日期无效（时间部分带脏后缀，正则须锚定结尾）', row: { status: 'PENDING', deadline: '2026-08-10 10:00脏后缀' }, expectOverdue: '日期无效', expectDuration: '' },
  // 预筛 C6c L-1：未知状态兜底样例（脏值，协作无 DB CHECK 理论可达）——deadline 非空且合法，
  //   兜底输出须为「—」而非「未设时限」（后者会假陈述"没设时限"）。
  { label: '未知状态兜底（脏值，deadline 非空合法）', row: { status: 'GARBAGE_STATUS', deadline: '2026-08-10 10:00:00' }, expectOverdue: '—', expectDuration: '' },
] : [];
const COLLAB_VAL_MATRIX = COLLAB_FNS ? [
  { label: 'bypass_validation===1 优先于 sql_validation_status', row: { bypass_validation: 1, sql_validation_status: 'failed' }, expect: '旁路放行' },
  { label: "sql_validation_status='bypassed' 同样命中旁路放行", row: { sql_validation_status: 'bypassed' }, expect: '旁路放行' },
  { label: 'passed→已通过', row: { sql_validation_status: 'passed' }, expect: '已通过' },
  { label: 'failed→待重传', row: { sql_validation_status: 'failed' }, expect: '待重传' },
  { label: 'running→验收中', row: { sql_validation_status: 'running' }, expect: '验收中' },
  { label: 'queued→排队中', row: { sql_validation_status: 'queued' }, expect: '排队中' },
  { label: 'admin_closed→行政闭环（未执行SQL验收）', row: { sql_validation_status: 'admin_closed' }, expect: '行政闭环（未执行SQL验收）' },
  { label: 'NULL→—', row: { sql_validation_status: null }, expect: '—' },
] : [];
console.log('');

// S6：系统迭代矩阵（siOverdueRule，方案 §3.3.1 SI 表；含"状态列出改名值、超时列按原始值命中分支"双态断言）。
console.log('— 测试 7：超时列样例矩阵（系统迭代 siOverdueRule，方案 §3.3.1 SI 表逐行覆盖）—');
const SI_FNS = extractSiFns();
if (readPageIfExists(PAGE_MAP.sysIssue) && !SI_FNS) {
  bad('超时列样例矩阵：Sys_Iteration.html 已存在但 siOverdueRule/siStatusDisplay 提取/编译失败——见 extractSiFns 实现，检查页面源码内 function siLocalDatePrefix/siDatePrefixDiffDays/siOverdueRule/siStatusDisplay + const SI_EXPORT_COLUMNS 五个标记文本的出现顺序与拼写是否仍与提取逻辑一致（H3 自爆：接入了却抓不到，不能静默当未接入）');
}
const SI_NOW = new Date(2026, 7, 19, 12, 0);
const SI_OVERDUE_MATRIX = SI_FNS ? [
  { label: '待验证：状态列显示改名值「待验收」+超时列按原始值判定（未超时）', row: { status: '待验证', deadline: '2026-08-20' }, expectStatusDisplay: '待验收', expectOverdue: '未超时', expectDuration: '' },
  { label: '待验证：状态列显示改名值「待验收」+超时列按原始值判定（已超期）', row: { status: '待验证', deadline: '2026-08-18' }, expectStatusDisplay: '待验收', expectOverdue: '进行中已超期', expectDuration: '1 天' },
  { label: '已关闭：状态列显示改名值「已归档」+超时列按原始值判定（released_at 非空按完成判-超时）', row: { status: '已关闭', deadline: '2026-08-10', released_at: '2026-08-15' }, expectStatusDisplay: '已归档', expectOverdue: '超时', expectDuration: '5 天' },
  { label: '已关闭：状态列显示改名值「已归档」+超时列按原始值判定（released_at 空→未上线关闭）', row: { status: '已关闭', deadline: '2026-08-10', released_at: null }, expectStatusDisplay: '已归档', expectOverdue: '未上线关闭', expectDuration: '' },
  { label: '已暂缓→暂缓中（不判）', row: { status: '已暂缓', deadline: '2026-08-10' }, expectOverdue: '暂缓中', expectDuration: '' },
  { label: '未设时限（deadline 空，防御分支）', row: { status: '开发中', deadline: null }, expectOverdue: '未设时限', expectDuration: '' },
  { label: '已上线 超时（released_at 日>deadline 日）', row: { status: '已上线', deadline: '2026-08-10', released_at: '2026-08-15' }, expectOverdue: '超时', expectDuration: '5 天' },
  { label: '已上线 未超时', row: { status: '已上线', deadline: '2026-08-20', released_at: '2026-08-12' }, expectOverdue: '未超时', expectDuration: '' },
  { label: '日期分量跨日边界：deadline 恰为当日不算超（导出日=deadline 日）', row: { status: '待处理', deadline: '2026-08-19' }, expectOverdue: '未超时', expectDuration: '' },
  { label: '日期分量跨日边界：超出 1 天即判超', row: { status: '待处理', deadline: '2026-08-18' }, expectOverdue: '进行中已超期', expectDuration: '1 天' },
  // 预筛 C6d 修5：siDatePrefixDiffDays 改 Date.UTC 锚定后的跨月边界样例——7 月（31 天）跨到 8 月，
  // 验证纯日历天数差不受月长/时区影响（deadline 2026-07-30 → SI_NOW 2026-08-19，应为 20 天整）。
  { label: '跨月边界（7 月 31 天→8 月，纯日历天数差）', row: { status: '待处理', deadline: '2026-07-30' }, expectOverdue: '进行中已超期', expectDuration: '20 天' },
  // 矩阵补齐（预筛 C6b）：以下两条此前只在临时 node -e 里验证过、未纳入常驻矩阵，现补齐为持久断言。
  { label: '已拒绝→—（不判）', row: { status: '已拒绝', deadline: '2026-08-10' }, expectOverdue: '—', expectDuration: '' },
  { label: '已作废→—（不判，deadline 缺失也不判）', row: { status: '已作废' }, expectOverdue: '—', expectDuration: '' },
  { label: '已上线但 released_at 脏值（非空但非法）→无完成时间', row: { status: '已上线', deadline: '2026-08-10', released_at: '2026-99-99' }, expectOverdue: '无完成时间', expectDuration: '' },
  // 预筛 C6c L-1：未知状态兜底样例（脏值/尚未落地的状态如「待验收」config 流 TODO，理论可达）——
  //   deadline 非空且合法，兜底输出须为「—」而非「未设时限」（后者会假陈述"没设时限"）。
  { label: '未知状态兜底（脏值，deadline 非空合法）', row: { status: '未知状态X', deadline: '2026-08-10' }, expectOverdue: '—', expectDuration: '' },
] : [];
console.log('');

// 三页矩阵的统一自爆闸：任一页已出现接入信号但其矩阵仍为空 → 判红（H3/M5 同款纪律，不因拆成三段
//   矩阵就分别各写一套判断——共用一个闸门，逐页报告哪个矩阵还空着）。
{
  const wiredPages = Object.values(PAGE_MAP).filter((file) => {
    const html = readPageIfExists(file);
    const masked = maskPageForSignal(html);   // 修4：剥注释+字符串/模板遮罩后再匹配，见上方函数注释
    return /overdueRule\s*[:(]/.test(masked) || /UnifyHelpers\.attachExport\s*\(/.test(masked);
  });
  const matrixByPage = {
    'Data_Correction.html': OVERDUE_MATRIX,
    'Data_Collab.html': COLLAB_OVERDUE_MATRIX,
    'Sys_Iteration.html': SI_OVERDUE_MATRIX,
  };
  const emptyMatrixPages = wiredPages.filter((f) => matrixByPage[f].length === 0);
  if (emptyMatrixPages.length > 0) {
    bad(`超时列样例矩阵：检测到已接入页面（${emptyMatrixPages.join(',')}）出现 overdueRule/attachExport 接入信号，但对应矩阵仍为空——占位框架不应在真实配置出现后仍保持占位`);
  } else if (wiredPages.length === 0) {
    ok('超时列样例矩阵：占位框架就绪，0 条样例，三页均未出现 overdueRule/attachExport（如实标注，非假装测过）');
  } else {
    ok(`超时列样例矩阵：已接入页面（${wiredPages.join(',')}）均有对应矩阵样例，逐条断言见下`);
  }

  for (const sample of OVERDUE_MATRIX) {
    const got = CORR_OVERDUE_RULE(sample.row, CORR_NOW);
    must(got && got.overdue === sample.expectOverdue, `超时列样例「${sample.label}」：overdue 符合预期（实得 ${JSON.stringify(got && got.overdue)}，期望 "${sample.expectOverdue}"）`);
    must(got && got.duration === sample.expectDuration, `超时列样例「${sample.label}」：duration 符合预期（实得 ${JSON.stringify(got && got.duration)}，期望 "${sample.expectDuration}"）`);
  }
  for (const sample of COLLAB_OVERDUE_MATRIX) {
    const got = COLLAB_FNS.rule(sample.row, COLLAB_NOW);
    must(got && got.overdue === sample.expectOverdue, `超时列样例「${sample.label}」：overdue 符合预期（实得 ${JSON.stringify(got && got.overdue)}，期望 "${sample.expectOverdue}"）`);
    must(got && got.duration === sample.expectDuration, `超时列样例「${sample.label}」：duration 符合预期（实得 ${JSON.stringify(got && got.duration)}，期望 "${sample.expectDuration}"）`);
  }
  for (const sample of COLLAB_VAL_MATRIX) {
    const got = COLLAB_FNS.val(sample.row);
    must(got === sample.expect, `验收状态样例「${sample.label}」：符合预期（实得 ${JSON.stringify(got)}，期望 "${sample.expect}"）`);
  }
  for (const sample of SI_OVERDUE_MATRIX) {
    const got = SI_FNS.rule(sample.row, SI_NOW);
    must(got && got.overdue === sample.expectOverdue, `超时列样例「${sample.label}」：overdue 符合预期（实得 ${JSON.stringify(got && got.overdue)}，期望 "${sample.expectOverdue}"）`);
    must(got && got.duration === sample.expectDuration, `超时列样例「${sample.label}」：duration 符合预期（实得 ${JSON.stringify(got && got.duration)}，期望 "${sample.expectDuration}"）`);
    if (sample.expectStatusDisplay !== undefined) {
      const gotDisplay = SI_FNS.statusDisplay(sample.row.status);
      must(gotDisplay === sample.expectStatusDisplay, `超时列样例「${sample.label}」：状态列 siStatusDisplay 输出改名值（实得 "${gotDisplay}"，期望 "${sample.expectStatusDisplay}"；超时列上方已断言按原始值 "${sample.row.status}" 命中分支）`);
    }
  }
}
console.log('');

// ============================================================
// M2（预筛 C6b，方案 §3.5 测试7 末句）：value() 端到端 + deps 裁剪反向对照
//   "并以矩阵行反向验证 deps 声明完整（漏声明字段的列在裁剪数据下输出必变——兜 value 偷读未声明字段）"
// ============================================================
// 通用对拍：column 在 fullRow（含大量与 deps 无关的噪声字段）vs trimmedRow（仅按 column.deps 裁剪）下
//   value() 输出必须一致——正向证明 deps 完整（value() 没有偷读声明外的字段，裁剪掉噪声字段不影响
//   结果）；再从 trimmedRow 里去掉 removeField（一个真实被消费的字段）断言输出必变——反向证明这套
//   "裁剪后比对"判据本身有判别力，不是"不管怎么裁都不变"的死判据（防套套断言，同 M1 教训）。
// 预筛 C6d 修2：从"代表列"扩为"三页全部含 value() 的派生列"表驱动。单列判据不变（完整行 vs 仅
//   deps 裁剪行输出一致 + 逐个删除单 deps 字段断言输出必变——删除后不变=冗余声明，同样判红），
//   新增 skipFields 参数处理"同列内部存在跨分支互斥读取"的情况：例如 completion_time 的
//   fallbackVal(a,b) 是 a-优先型回退——a 非空时 b 完全不会被读到（反之亦然），从单一固定行永远
//   无法同时证明两个 deps 字段各自都被消费（不是"没找对 fixture 值"，是该分支下另一字段确实
//   不会被访问，这是真实语义不是测试盲区）。这类字段改用独立多行专项测试单独证明双向 load-bearing
//   （见下方各页"特别覆盖"分段），此处按字段名跳过、且必须留痕（ok() 而非静默 continue，同 H3
//   自爆纪律——不能让"跳过"和"没测到"长得一样）。
function checkColumnDepsHonesty(pageLabel, column, fullRow, ctx, skipFields) {
  skipFields = skipFields || [];
  if (!column) { bad(`${pageLabel}：M3 待测列未在提取到的 columns 中找到（提取/编译异常，检查 key 拼写）`); return; }
  const deps = column.deps || [];
  if (!deps.length) { bad(`${pageLabel}列「${column.label}」：含 value() 但未声明 deps（H3 契约：value 列必须声明 deps，检测器无法对空 deps 做反向验证）`); return; }
  const trimmedRow = {};
  deps.forEach((f) => { trimmedRow[f] = fullRow[f]; });
  const fullOut = U.buildExportRows([fullRow], [column], ctx)[0][column.label];
  const trimmedOut = U.buildExportRows([trimmedRow], [column], ctx)[0][column.label];
  must(fullOut === trimmedOut, `${pageLabel}列「${column.label}」：deps 完整——全字段行 vs 仅按 deps(${JSON.stringify(deps)}) 裁剪的行 value() 输出一致（均="${fullOut}"），未偷读声明外字段`);

  for (const f of deps) {
    if (skipFields.indexOf(f) !== -1) {
      ok(`${pageLabel}列「${column.label}」：deps 字段 "${f}" 本行跳过逐个删除检验（列内存在跨分支互斥读取，本行落在另一分支、结构性不触达该字段——非静默漏测，load-bearing 证明见专项多行测试/§测试7 overdueRule 矩阵对应分支样例）`);
      continue;
    }
    const reversedRow = Object.assign({}, trimmedRow);
    delete reversedRow[f];
    const reversedOut = U.buildExportRows([reversedRow], [column], ctx)[0][column.label];
    must(reversedOut !== trimmedOut, `${pageLabel}列「${column.label}」★逐 deps 反向对照：去掉声明字段 "${f}" 后输出必变（裁剪值="${trimmedOut}"，去除后="${reversedOut}"）`);
  }
}
// 表驱动扫描：columns 中所有含 value() 的列都跑一遍 checkColumnDepsHonesty；wholeSkipKeys=整列跳过
//   （改走专项多行测试的列，如 completion_time/validation_status/dev_roster_names，见各页"特别覆盖"
//   分段），columnFieldSkip={ 列key: [跳过的 deps 字段名] }=单列内部分字段跳过（见上方函数注释）。
//   跳过名单本身也做存在性校验——名单里的 key 若已不在 columns 中（列被改名/删除），判红而非静默失效。
function checkAllColumnsDepsHonesty(pageLabel, columns, fullRow, ctx, wholeSkipKeys, columnFieldSkip) {
  wholeSkipKeys = wholeSkipKeys || [];
  columnFieldSkip = columnFieldSkip || {};
  const valueColumns = (columns || []).filter((c) => typeof c.value === 'function');
  if (!valueColumns.length) { bad(`${pageLabel}：M3 全列 deps 判据——columns 中未扫描到任何含 value() 的派生列（提取/编译异常或列定义变化）`); return; }
  for (const k of wholeSkipKeys) {
    if (!valueColumns.some((c) => c.key === k)) bad(`${pageLabel}：M3 整列跳过名单声明了 "${k}"，但该 key 未在 columns 中找到（跳过名单与实际列定义脱节，需要同步更新）`);
  }
  const tested = valueColumns.filter((c) => wholeSkipKeys.indexOf(c.key) === -1);
  for (const column of tested) {
    checkColumnDepsHonesty(pageLabel, column, fullRow, ctx, columnFieldSkip[column.key] || []);
  }
}

// 预筛 C6c M-3：检测器对照组——临时构造一个"偷读白名单外噪声字段 requester_phone"的假列，验证
//   checkDepsHonesty 依赖的核心判据（deps 裁剪前后 value() 输出必须一致）确实具备判别力：若这份
//   对照组本身测不出分歧，说明上方给三页 fullRow 加噪声字段是摆设——判据本身失灵而不自知。
//   假列 deps 故意声明为 []（不含 requester_phone），value() 却直接读 r.requester_phone——
//   裁剪行（deps=[] → trimmedRow 不含任何字段）与全字段行的输出必然分歧，此为"检测器有效"的证据。
//   不走 checkDepsHonesty 本体：那会把"预期产生分歧"计入同一份 fullOut===trimmedOut 断言，
//   而该断言语义是"分歧=坏"，会把这条正确案例误判为 [FAIL] 污染全局统计；改写等价局部断言，
//   期望方向相反（分歧=对照组通过）。
function assertLeakDetectorWorks(pageLabel, fullRow, ctx) {
  const leakyColumn = { key: '__leak_probe__', label: '__leak_probe__', deps: [], value: (r) => String(r.requester_phone || '') };
  const trimmedRow = {};   // deps=[] → 裁剪行不含 requester_phone，模拟"漏声明"的裁剪结果
  const fullOut = U.buildExportRows([fullRow], [leakyColumn], ctx)[0][leakyColumn.label];
  const trimmedOut = U.buildExportRows([trimmedRow], [leakyColumn], ctx)[0][leakyColumn.label];
  must(fullOut !== trimmedOut, `${pageLabel}：检测器对照组——偷读白名单外字段 requester_phone（假列 deps 声明为 []）被正确判红（fullOut="${fullOut}"，trimmedOut="${trimmedOut}"）`);
}

console.log('— M3：数据修正 value() 端到端 + deps 表驱动全列 —');
const CORR_COLUMNS_RUNTIME = extractCorrColumnsRuntime();
if (readPageIfExists(PAGE_MAP.correction) && !CORR_COLUMNS_RUNTIME) {
  bad('M3：Data_Correction.html 已存在但 columns 运行时提取/编译失败（STATUS_LABELS/oaCore/formatOaNo/sysLabel/corrOverdueRule/CORR_EXPORT_COLUMNS 任一环节）——见 extractCorrColumnsRuntime 实现');
} else if (CORR_COLUMNS_RUNTIME) {
  // 全字段行：19 列拍板表里除待测列 deps 外的字段全部填充为可区分的噪声值，用来证明"裁掉它们不影响
  //   待测列输出"——这是"deps 完整"这句话真正要验的东西。
  //   预筛 C6d 修2：correction_type 由 'single' 改 'batch'——value() 是二值分支（batch→批量/否则→单条），
  //   旧值 'single' 与"删除该字段后 undefined"同落"否则"分支输出同为'单条'，是"空值巧合"假绿（删了跟没删
  //   一样）；改 'batch' 后删除会真的翻到'单条'，才是货真价实的"字段被消费"证明。
  const corrFullRow = {
    id: 1, oa_number: '20260819', process_type: '数据修正', status: 'FIXED',
    correction_type: 'batch', correction_count: 3, source_system: '其他', source_system_other: 'X系统',
    location_info: '测试修正方式', requester_name: '张三', requester_dept: '财务部',
    assigned_to_name: '李四', created_by_name: '王五', submission_count: 2,
    created_at: '2026-08-01 09:00:00', expected_deadline: '2026-08-10 10:00:00',
    fixed_at: '2026-08-15 10:00:00', refixed_at: null, archived_at: null,
    // 预筛 C6c M-3：白名单外噪声字段（19 列拍板表 key/deps 均不含），赋非空值——用来证明"deps 完整"
    //   这句话不是靠"噪声字段恰好都是空值所以裁不裁都一样"混过去的（空值裁剪前后本就都是 ''，
    //   判据形同虚设）。requester_phone/dingtalk_chat_id/assigned_by/internal_note 四字段各页同款。
    requester_phone: '13800000000', dingtalk_chat_id: 'ding_test_chat_001', assigned_by: '测试指派人',
    internal_note: '仅内部可见备注',
  };
  const CORR_M2_NOW = new Date(2026, 7, 19, 12, 0);
  const corrCtx = { now: CORR_M2_NOW, overdueRule: (row) => CORR_COLUMNS_RUNTIME.overdueRule(row, CORR_M2_NOW) };
  // 通用表驱动：全部含 value() 列（is_overdue/overdue_duration 内部依赖 corrOverdueRule 的
  //   anchorRaw=fallbackVal(refixed_at, fixed_at)——corrFullRow 里 refixed_at=null/fixed_at 有值，
  //   fixed_at 是当前分支的活跃字段、真实可测；refixed_at 已空，删它是"删除已空字段"的空值巧合，
  //   跳过、改在下方 completion_time 专项双行测试里用非空 refixed_at 单独证明）。completion_time
  //   同款 fallbackVal masking，整列跳过、专项测试见下。
  checkAllColumnsDepsHonesty(
    '数据修正', CORR_COLUMNS_RUNTIME.columns, corrFullRow, corrCtx,
    ['completion_time'],
    { is_overdue: ['refixed_at'], overdue_duration: ['refixed_at'] }
  );
  // 特别覆盖：完成时间 fallbackVal(refixed_at, fixed_at) 双行测试——a-优先型回退单行无法同时证明
  //   两个 deps 字段均被消费（a 非空时 b 结构性不被读到，反之亦然），拆两行各打各自的活跃分支。
  {
    const col = CORR_COLUMNS_RUNTIME.columns.find((c) => c.key === 'completion_time');
    if (!col) { bad('数据修正：完成时间列（completion_time）未在提取到的 columns 中找到'); }
    else {
      const rowA = { refixed_at: '2026-08-16 11:00:00', fixed_at: '2026-08-12 10:00:00' };
      const outA = U.buildExportRows([rowA], [col], corrCtx)[0][col.label];
      const rowAMissing = { fixed_at: '2026-08-12 10:00:00' };
      const outAMissing = U.buildExportRows([rowAMissing], [col], corrCtx)[0][col.label];
      must(outAMissing !== outA, `数据修正列「完成时间」★专项对照 1：refixed_at 非空时优先取 refixed_at，去掉后必回退到 fixed_at、输出必变（有 refixed_at="${outA}"，去掉后="${outAMissing}"）`);
      const rowB = { refixed_at: null, fixed_at: '2026-08-12 10:00:00' };
      const outB = U.buildExportRows([rowB], [col], corrCtx)[0][col.label];
      const rowBMissing = { refixed_at: null };
      const outBMissing = U.buildExportRows([rowBMissing], [col], corrCtx)[0][col.label];
      must(outBMissing !== outB, `数据修正列「完成时间」★专项对照 2：refixed_at 为空时回退 fixed_at，去掉 fixed_at 后输出必变（有 fixed_at="${outB}"，去掉后="${outBMissing}"）`);
    }
  }
  assertLeakDetectorWorks('数据修正', corrFullRow, corrCtx);
}
console.log('');

// 预筛 C6d 修2：target_db_connection_id 列 fixture map——id=5 对应 collabFullRow.target_db_connection_id，
//   注入进 extractCollabColumnsRuntime 的 Function 工厂形参（该变量在页面里是运行时闭包，提取范围外）。
const COLLAB_TARGET_DB_MAP_FIXTURE = { 5: '测试业务库A' };

console.log('— M3：数据协作 value() 端到端 + deps 表驱动全列 —');
const COLLAB_COLUMNS_RUNTIME = extractCollabColumnsRuntime(COLLAB_TARGET_DB_MAP_FIXTURE);
if (readPageIfExists(PAGE_MAP.collab) && !COLLAB_COLUMNS_RUNTIME) {
  bad('M3：Data_Collab.html 已存在但 columns 运行时提取/编译失败（STATUS_LABELS/collabExportValidationStatus/collabOverdueRule/COLLAB_EXPORT_COLUMNS 任一环节）——见 extractCollabColumnsRuntime 实现');
} else if (COLLAB_COLUMNS_RUNTIME) {
  const collabFullRow = {
    id: 1, oa_request_no: 'OA-20260819', requester_dept: '财务部', requester_name: '张三',
    description: '测试需求描述', status: 'DONE', target_db_connection_id: 5,
    contact_person_name: '赵六', developer_name: '钱七', created_at: '2026-08-01 09:00:00',
    deadline: '2026-08-10 10:00:00', dev_estimated_at: '2026-08-08 10:00:00',
    last_submitted_at: '2026-08-12 10:00:00', sql_validation_status: 'failed', bypass_validation: 1,
    done_at: '2026-08-15 10:00:00', archived_final_at: null,
    // 预筛 C6c M-3：白名单外噪声字段（17 列拍板表 key/deps 均不含），赋非空值，同 M-3 说明见数据修正处。
    requester_phone: '13800000000', dingtalk_chat_id: 'ding_test_chat_001', assigned_by: '测试指派人',
    internal_note: '仅内部可见备注',
  };
  const COLLAB_M2_NOW = new Date(2026, 7, 19, 12, 0);
  const collabCtx = { now: COLLAB_M2_NOW, overdueRule: (row) => COLLAB_COLUMNS_RUNTIME.overdueRule(row, COLLAB_M2_NOW) };
  // 通用表驱动：validation_status（bypass_validation===1 优先，masking sql_validation_status，见下方
  //   专项测试）与 completion_time（同 corr 款 fallbackVal masking）整列跳过；is_overdue/overdue_duration
  //   的 archived_final_at——collabFullRow.status='DONE' 只读 done_at 单锚，ARCHIVED 分支才用
  //   fallbackVal(done_at, archived_final_at)，DONE 分支下 archived_final_at 结构性不触达，跳过（该
  //   字段在 ARCHIVED 分支的 load-bearing 已由 §测试7 COLLAB_OVERDUE_MATRIX「fallbackVal 回退（done_at
  //   空串→回退 archived_final_at）」样例证明）。
  checkAllColumnsDepsHonesty(
    '数据协作', COLLAB_COLUMNS_RUNTIME.columns, collabFullRow, collabCtx,
    ['completion_time', 'validation_status'],
    { is_overdue: ['archived_final_at'], overdue_duration: ['archived_final_at'] }
  );
  // 特别覆盖：完成时间 fallbackVal(done_at, archived_final_at) 双行测试，同 corr 款理由。
  {
    const col = COLLAB_COLUMNS_RUNTIME.columns.find((c) => c.key === 'completion_time');
    if (!col) { bad('数据协作：完成时间列（completion_time）未在提取到的 columns 中找到'); }
    else {
      const rowA = { done_at: '2026-08-15 10:00:00', archived_final_at: '2026-08-13 10:00:00' };
      const outA = U.buildExportRows([rowA], [col], collabCtx)[0][col.label];
      const rowAMissing = { archived_final_at: '2026-08-13 10:00:00' };
      const outAMissing = U.buildExportRows([rowAMissing], [col], collabCtx)[0][col.label];
      must(outAMissing !== outA, `数据协作列「完成时间」★专项对照 1：done_at 非空时优先取 done_at，去掉后必回退到 archived_final_at、输出必变（有 done_at="${outA}"，去掉后="${outAMissing}"）`);
      const rowB = { done_at: null, archived_final_at: '2026-08-13 10:00:00' };
      const outB = U.buildExportRows([rowB], [col], collabCtx)[0][col.label];
      const rowBMissing = { done_at: null };
      const outBMissing = U.buildExportRows([rowBMissing], [col], collabCtx)[0][col.label];
      must(outBMissing !== outB, `数据协作列「完成时间」★专项对照 2：done_at 为空时回退 archived_final_at，去掉 archived_final_at 后输出必变（有 archived_final_at="${outB}"，去掉后="${outBMissing}"）`);
    }
  }
  // 特别覆盖：验收状态 bypass_validation===1 短路优先——单行无法同时证明 bypass_validation 与
  //   sql_validation_status 均被消费（bypass=1 时 sql 完全不读；bypass≠1 时 sql 才生效），拆两行。
  {
    const col = COLLAB_COLUMNS_RUNTIME.columns.find((c) => c.key === 'validation_status');
    if (!col) { bad('数据协作：验收状态列（validation_status）未在提取到的 columns 中找到'); }
    else {
      const rowBypass = { bypass_validation: 1, sql_validation_status: 'failed' };
      const outBypass = U.buildExportRows([rowBypass], [col], collabCtx)[0][col.label];
      const rowBypassMissing = { sql_validation_status: 'failed' };
      const outBypassMissing = U.buildExportRows([rowBypassMissing], [col], collabCtx)[0][col.label];
      must(outBypassMissing !== outBypass, `数据协作列「验收状态」★专项对照 1：bypass_validation===1 优先命中"旁路放行"，去掉后必回落 sql_validation_status 判定、输出必变（有 bypass="${outBypass}"，去掉后="${outBypassMissing}"）`);
      const rowSql = { bypass_validation: 0, sql_validation_status: 'failed' };
      const outSql = U.buildExportRows([rowSql], [col], collabCtx)[0][col.label];
      const rowSqlMissing = { bypass_validation: 0 };
      const outSqlMissing = U.buildExportRows([rowSqlMissing], [col], collabCtx)[0][col.label];
      must(outSqlMissing !== outSql, `数据协作列「验收状态」★专项对照 2：bypass_validation 关闭时 sql_validation_status 生效，去掉后输出必变（有 sql="${outSql}"，去掉后="${outSqlMissing}"）`);
    }
  }
  assertLeakDetectorWorks('数据协作', collabFullRow, collabCtx);
}
console.log('');

console.log('— M3：系统迭代 value() 端到端 + deps 表驱动全列 —');
const SI_COLUMNS_RUNTIME = extractSiColumnsRuntime();
if (readPageIfExists(PAGE_MAP.sysIssue) && !SI_COLUMNS_RUNTIME) {
  bad('M3：Sys_Iteration.html 已存在但 columns 运行时提取/编译失败（SI_TYPE_LABEL/siTypeLabel/siStatusDisplay/siDevRosterNamesResolved/siOverdueRule/SI_EXPORT_COLUMNS 任一环节）——见 extractSiColumnsRuntime 实现');
} else if (SI_COLUMNS_RUNTIME) {
  const siFullRow = {
    id: 1, type: 'bug', priority: 'P1', risk_level: '高', status: '已关闭', title: '测试标题',
    system_name: 'BMS', module_name: '模块A', dev_roster_names: '["张三","李四"]', assigned_to_name: '赵六',
    created_by_name: '王五', requester_name: '赵六', requester_dept: '财务部',
    dev_estimated_at: '2026-08-08 10:00:00', deadline: '2026-08-10', last_completed_at: '2026-08-12 10:00:00',
    released_at: '2026-08-15',
    // 预筛 C6c M-3：白名单外噪声字段（18 列拍板表 key/deps 均不含），赋非空值，同 M-3 说明见数据修正处。
    requester_phone: '13800000000', dingtalk_chat_id: 'ding_test_chat_001', assigned_by: '测试指派人',
    internal_note: '仅内部可见备注',
  };
  const SI_M2_NOW = new Date(2026, 7, 19, 12, 0);
  const siCtx = { now: SI_M2_NOW, overdueRule: (row) => SI_COLUMNS_RUNTIME.overdueRule(row, SI_M2_NOW) };
  // 通用表驱动：is_overdue/overdue_duration 的完成锚是单一 released_at 字段（config 类型待验收态无
  //   fallback 对，见 N3 前瞻登记），status/deadline/released_at 三个 deps 在本行（已关闭+released_at
  //   非空+deadline 合法）下逐个删除均可观测（status 删除落最终未知状态兜底、deadline 删除落未设时限、
  //   released_at 删除因 status='已关闭' 命中提前的「未上线关闭」分支），无 masking，故不需 columnFieldSkip。
  //   dev_roster_names 整列跳过（'["张三","李四"]' 非空分支下 assigned_to_name 结构性不读，masking，
  //   见下方专项三分支测试）。
  checkAllColumnsDepsHonesty(
    '系统迭代', SI_COLUMNS_RUNTIME.columns, siFullRow, siCtx,
    ['dev_roster_names'],
    {}
  );
  // 特别覆盖：dev_roster_names 列——siDevRosterNamesResolved 三分支各一测（非空名单 / '[]' 零命中 /
  //   parse 失败脏 JSON），后两分支均须回退 assigned_to_name（预筛 C6 M-2 的修复目标：旧实现只判
  //   !r.dev_roster_names，拦不住 '[]' 这种非 NULL 空数组 JSON，会悄悄输出空串而非回退）。
  {
    const col = SI_COLUMNS_RUNTIME.columns.find((c) => c.key === 'dev_roster_names');
    if (!col) { bad('系统迭代：开发列（dev_roster_names）未在提取到的 columns 中找到'); }
    else {
      // 分支 1：非空名单——dev_roster_names 生效，assigned_to_name 完全不读（masked，同上方跳过说明）。
      const rowRoster = { dev_roster_names: '["张三","李四"]', assigned_to_name: '赵六' };
      const outRoster = U.buildExportRows([rowRoster], [col], siCtx)[0][col.label];
      must(outRoster === '张三、李四', `系统迭代列「开发」：非空名单按 join('、') 输出（实得 "${outRoster}"）`);
      const rowRosterMissing = { assigned_to_name: '赵六' };
      const outRosterMissing = U.buildExportRows([rowRosterMissing], [col], siCtx)[0][col.label];
      must(outRosterMissing !== outRoster, `系统迭代列「开发」★专项对照 1：去掉 dev_roster_names 后输出必变（有名单="${outRoster}"，去掉后="${outRosterMissing}"）`);
      must(outRosterMissing === '赵六', `系统迭代列「开发」：dev_roster_names 缺失后正确回退 assigned_to_name（实得 "${outRosterMissing}"）`);

      // 分支 2：'[]' 零命中——预筛 C6 M-2 修复目标——须回退 assigned_to_name（非旧实现的空串）。
      const rowEmptyArr = { dev_roster_names: '[]', assigned_to_name: '赵六' };
      const outEmptyArr = U.buildExportRows([rowEmptyArr], [col], siCtx)[0][col.label];
      must(outEmptyArr === '赵六', `系统迭代列「开发」：dev_roster_names='[]'（零命中）回退 assigned_to_name（实得 "${outEmptyArr}"，非旧实现的空串）`);
      const rowEmptyArrMissing = { dev_roster_names: '[]' };
      const outEmptyArrMissing = U.buildExportRows([rowEmptyArrMissing], [col], siCtx)[0][col.label];
      must(outEmptyArrMissing !== outEmptyArr, `系统迭代列「开发」★专项对照 2：'[]' 分支下去掉 assigned_to_name 后输出必变（有="${outEmptyArr}"，去掉后="${outEmptyArrMissing}"）`);

      // 分支 3：parse 失败（脏 JSON）——同样应回退 assigned_to_name（siDevRosterNamesResolved catch 分支）。
      const rowBadJson = { dev_roster_names: '{脏JSON', assigned_to_name: '赵六' };
      const outBadJson = U.buildExportRows([rowBadJson], [col], siCtx)[0][col.label];
      must(outBadJson === '赵六', `系统迭代列「开发」：dev_roster_names 脏 JSON（parse 失败）回退 assigned_to_name（实得 "${outBadJson}"）`);
    }
  }
  assertLeakDetectorWorks('系统迭代', siFullRow, siCtx);
}
console.log('');

// ============================================================
// 修3（预筛 C6d，2026-08-19）："补显灰根进导出"现状锁定断言——D13 日期范围筛选是行级 AND 于
//   getFilteredItems/siVisibleList，聚类层（clusterItems/siClusterFamilyBlocks）在"子项在筛选结果里、
//   根不在"时会从 allItems/siList（服务端全量响应，非二次筛选）里把根补显回来（isContext/rootIsContext:
//   true，灰显上下文行）；导出 getViewRows 复用同一条聚类产线（方案 D5 所见即所得），故导出文件里也会
//   带出这行"技术上不在筛选范围但被树形完整性拉回来"的根行。这是**现状**（既有代码明文如此，非本批
//   引入），本条测试目的是把这个行为锁定住，防未来"顺手改成严格按筛选剔除"悄悄打破所见即所得契约——
//   不是新校验业务正确性，纯回归卡口。
//   选择依据（二选一，报告需说明）：走"聚类函数直测"（非静态存在性检查）。clusterItems/
//   siClusterFamilyBlocks 均相对自包含——前者靠 allItems 全局闭包但可用 Function 工厂形参注入替身；
//   后者 allItems 本就是显式参数，提取成本低。直测能拿到真实行为断言（根行确实出现在输出里 +
//   isContext/rootIsContext 确实为 true），比"扫代码字符串里还有没有 isContext 关键字"这种静态断言
//   判别力强得多——静态断言测不出"根真的被拉回结果集"这件事本身，只能测"这行代码字面上还在文件里"，
//   对"改坏了但字面残留"完全无感。getFilteredItems/corrGetViewRows/siVisibleList/siBuildFamilyBlocks
//   这条更外层的链路耦合了 DOM 筛选控件读取 + 服务端分页状态等大量页面运行时状态，提取成本才是真正
//   "过高"的那部分；直测聚类函数本身已覆盖"补显"行为的核心判定逻辑——corrGetViewRows/siGetViewRows
//   对聚类结果只做展开摊平、不做二次过滤（已读源码核实），故直测聚类层等价于间接测了 getViewRows
//   层的这部分行为，不必再往外拉整条链路。
// ============================================================
console.log('— 修3：补显灰根进导出 现状锁定断言 —');
function extractCorrClusterItems() {
  const html = readPageIfExists(PAGE_MAP.correction);
  if (!html) return null;
  const s1 = html.indexOf('function clusterItems(items, sortField, sortDir)');
  const e1 = s1 >= 0 ? findFunctionEnd(html, s1) : -1;
  if (s1 < 0 || e1 < 0) return null;
  const src = html.slice(s1, e1 + 1);
  try {
    // allItems 是页面级全局（组件闭包读取，非入参）——本函数用 Function 工厂形参注入替身；测试固定传
    // sortField=null 走 else 分支（纯 maxId 排序，无外部依赖），规避 UnifyHelpers.sortByField/
    // CORR_SORT_FIELD_TYPES 等只在 if(sortField) 分支才用到的额外依赖，不需要一并提取/注入。
    const factory = new Function('allItems', src + '\nreturn clusterItems;');
    return factory;
  } catch (e) {
    console.warn('[verify-export-content] extractCorrClusterItems 编译失败：' + String(e && e.message || e));
    return null;
  }
}
function extractSiClusterFamilyBlocks() {
  const html = readPageIfExists(PAGE_MAP.sysIssue);
  if (!html) return null;
  const cd = html.indexOf('const SI_FAMILY_MAX_DEPTH = ');
  const cdLineEnd = cd >= 0 ? html.indexOf('\n', cd) : -1;
  const rf = html.indexOf('function siFamilyRootId(');
  const rfEnd = rf >= 0 ? findFunctionEnd(html, rf) : -1;
  // ①②分支排子级用 siSortFamilyChildren（依赖 siDeriveSeqSortValue），须一并提取。
  const dv = html.indexOf('function siDeriveSeqSortValue(');
  const dvEnd = dv >= 0 ? findFunctionEnd(html, dv) : -1;
  const sc = html.indexOf('function siSortFamilyChildren(');
  const scEnd = sc >= 0 ? findFunctionEnd(html, sc) : -1;
  const ml = html.indexOf('function siMarkLastChild(');
  const mlEnd = ml >= 0 ? findFunctionEnd(html, ml) : -1;
  const cb = html.indexOf('function siClusterFamilyBlocks(');
  const cbEnd = cb >= 0 ? findFunctionEnd(html, cb) : -1;
  if (cd < 0 || cdLineEnd < 0 || rf < 0 || rfEnd < 0 || dv < 0 || dvEnd < 0 || sc < 0 || scEnd < 0 || ml < 0 || mlEnd < 0 || cb < 0 || cbEnd < 0) return null;
  const combinedSrc = html.slice(cd, cdLineEnd) + '\n' + html.slice(rf, rfEnd + 1) + '\n' +
    html.slice(dv, dvEnd + 1) + '\n' + html.slice(sc, scEnd + 1) + '\n' +
    html.slice(ml, mlEnd + 1) + '\n' + html.slice(cb, cbEnd + 1) + '\n';
  try {
    // siClusterFamilyBlocks 的 sortField=null "else" 分支仍读页面级全局 siActiveSearch（未声明的自由
    // 变量引用会直接 ReferenceError，不论真假都会先报错）——注入为 Function 形参并固定传 false，短路掉
    // siIsExactSearchMatch 相关分支（未提取；传 true 会再炸一个 ReferenceError，且"搜索相关性排序"与
    // 本测试目的无关，不需要它）。
    const factory = new Function('siActiveSearch', combinedSrc + 'return siClusterFamilyBlocks;');
    return factory;
  } catch (e) {
    console.warn('[verify-export-content] extractSiClusterFamilyBlocks 编译失败：' + String(e && e.message || e));
    return null;
  }
}
{
  const corrFactory = extractCorrClusterItems();
  if (readPageIfExists(PAGE_MAP.correction) && !corrFactory) {
    bad('修3：Data_Correction.html 已存在但 clusterItems 提取/编译失败——见 extractCorrClusterItems 实现');
  } else if (corrFactory) {
    const rootRow = { id: 500, correction_group_id: 500, status: 'ARCHIVED', location_info: '根单（应被灰显补出）' };
    const childRow = { id: 501, correction_group_id: 500, rework_parent_id: null, status: 'FIXED', location_info: '子单（在筛选范围内）' };
    const clusterItemsFn = corrFactory([rootRow, childRow]);   // allItems=全量（含根，模拟服务端响应未过滤根）
    const blocks = clusterItemsFn([childRow], null, null);   // items=筛选后（模拟"子项在日期范围内、根不在"）
    const flatRows = [];
    blocks.forEach((blockRows) => blockRows.forEach((r) => flatRows.push(r)));
    const rootWrapper = flatRows.find((r) => Number(r.it.id) === 500);
    must(!!rootWrapper, `数据修正 clusterItems：子项在筛选结果里、根被筛掉时，根行仍出现在聚类输出中（补显灰根，导出继承同一产线）——实得行 id 列表 ${JSON.stringify(flatRows.map((r) => r.it.id))}`);
    must(!!rootWrapper && rootWrapper.isContext === true, `数据修正 clusterItems：补显的根行 isContext===true（灰显上下文标记，实得 ${JSON.stringify(rootWrapper && rootWrapper.isContext)}）`);
  }
}
{
  const siFactory = extractSiClusterFamilyBlocks();
  if (readPageIfExists(PAGE_MAP.sysIssue) && !siFactory) {
    bad('修3：Sys_Iteration.html 已存在但 siClusterFamilyBlocks 提取/编译失败——见 extractSiClusterFamilyBlocks 实现');
  } else if (siFactory) {
    const rootItem = { id: 600, derive_root_id: null, origin_issue_id: null, title: '族根（应被灰显补出）' };
    const childItem = { id: 601, derive_root_id: 600, origin_issue_id: null, title: '派生子单（在筛选范围内）' };
    const clusterFn = siFactory(false);   // siActiveSearch=false，走非搜索相关性分支
    const blocks = clusterFn([childItem], [rootItem, childItem], null, null);   // allItems=全量（含根）
    const flatRows = [];
    blocks.forEach((blockRows) => blockRows.forEach((r) => flatRows.push(r)));
    const rootWrapper = flatRows.find((r) => Number(r.item.id) === 600);
    must(!!rootWrapper, `系统迭代 siClusterFamilyBlocks：子项在筛选结果里、根被筛掉时，根行仍出现在聚类输出中（补显灰根，导出继承同一产线）——实得行 id 列表 ${JSON.stringify(flatRows.map((r) => r.item.id))}`);
    must(!!rootWrapper && rootWrapper.isContext === true, `系统迭代 siClusterFamilyBlocks：补显的根行 isContext===true（灰显上下文标记，② 分支，实得 ${JSON.stringify(rootWrapper && rootWrapper.isContext)}）`);
  }
}
console.log('');

// ============================================================
// 测试 8：列数断言（三页全接入真实断言：数据修正 19 / 协作 17 / 系统迭代 18，表头逐一相等）
// ============================================================
console.log('— 测试 8：列数断言（三页 19/17/18 列 + 表头逐一相等，S5+S6 全接入）—');
// 目标值来自方案 §3.2 三模块列白名单拍板表。
const EXPECTED_COLUMN_COUNTS = { correction: 19, collab: 17, sysIssue: 18 };
// 方案 §3.2.1/§3.2.2/§3.2.3 逐列拍板表，逐一比对表头文案（顺序也须一致——Excel 列序即业务方对账阅读序）。
const EXPECTED_CORR_HEADERS = [
  'ID', 'OA 流程号', '流程类型', '状态', '修正类型', '修正条数', '所属系统', '修正方式', '业务方',
  '业务部门', '开发', '创建人', '提交次数', '创建时间', '期望完成时限', '完成时间', '归档时间',
  '是否超时（对期望时限）', '超时时长',
];
const EXPECTED_COLLAB_HEADERS = [
  'ID', 'OA 流程号', '需求部门', '业务方', '需求描述', '状态', '目标业务库', '对接人', '开发',
  '创建时间', '期望完成时间', '预计完成时间', '最后提交时间', '验收状态', '完成时间',
  '是否超时（对期望时限）', '超时时长',
];
const EXPECTED_SI_HEADERS = [
  'ID', '类型', '优先级', '风险等级', '状态', '标题', '系统', '模块', '开发', '建单人', '需求方',
  '需求部门', '预计完成', '期望完成', '实际完成', '上线时间', '是否超时（对期望时限）', '超时时长',
];
// 从页面源码提取 `const <constName> = [...]` 数组内全部 label 值（顺序即声明顺序）——括号深度感知
//   定位数组边界（同 verify-export-columns.js findBalancedEnd 算法），非手抄一份列表；三页共用一份
//   提取逻辑，只是常量名不同（S6 由 extractCorrExportColumnLabels 单页版泛化）。
function extractExportColumnLabels(pageFile, constName) {
  const html = readPageIfExists(pageFile);
  if (!html) return null;
  const declIdx = html.indexOf(`const ${constName} = [`);
  if (declIdx < 0) return null;
  const arrStart = html.indexOf('[', declIdx);
  const end = findArrayEnd(html, arrStart);
  if (end < 0) return null;
  const arrText = html.slice(arrStart, end + 1);
  const labels = [];
  const re = /label:\s*'([^']*)'/g;
  let m;
  while ((m = re.exec(arrText))) labels.push(m[1]);
  return labels;
}
function checkColumnList(modKey, pageFile, constName, expectedCount, expectedHeaders) {
  const labels = extractExportColumnLabels(pageFile, constName);
  if (readPageIfExists(pageFile) && labels === null) {
    bad(`列数断言（${modKey}）：${pageFile} 已存在但 ${constName} 数组提取失败——H3 自爆：接入了却抓不到不能静默当未接入`);
    return;
  }
  if (labels === null) {
    ok(`列数断言（${modKey}）：${pageFile} 尚未接入 attachExport，占位跳过（目标 ${expectedCount} 列）`);
    return;
  }
  must(labels.length === expectedCount, `列数断言（${modKey}）：${constName} 恰含 ${expectedCount} 列（实得 ${labels.length}）`);
  must(JSON.stringify(labels) === JSON.stringify(expectedHeaders),
    `列数断言（${modKey}）：表头文案+顺序与方案拍板表逐一相等（实得 ${JSON.stringify(labels)}）`);
}
checkColumnList('correction', PAGE_MAP.correction, 'CORR_EXPORT_COLUMNS', EXPECTED_COLUMN_COUNTS.correction, EXPECTED_CORR_HEADERS);
checkColumnList('collab', PAGE_MAP.collab, 'COLLAB_EXPORT_COLUMNS', EXPECTED_COLUMN_COUNTS.collab, EXPECTED_COLLAB_HEADERS);
checkColumnList('sysIssue', PAGE_MAP.sysIssue, 'SI_EXPORT_COLUMNS', EXPECTED_COLUMN_COUNTS.sysIssue, EXPECTED_SI_HEADERS);

// ============================================================
// 修4（预筛 C4c）：期望断言总数基线——防"pass===pass 自指真理"式假绿
// ============================================================
// 同 verify-export-columns.js 末尾的基线检查同一套设计（基线+自爆条件组合，非硬钉等值）：脚手架阶段
// （三页均未出现 overdueRule/attachExport 接入信号）总数应恒定，硬钉能抓住断言被静默漏跑；一旦任意页
// 出现接入信号，测试 7/8 会从"占位 ok"转成真实判定分支，此时改为"总数必须高于脚手架基线"。
console.log('');
console.log('— 修4：期望断言总数基线（防 pass===pass 自指真理式假绿）—');
const anyPageWiredContent = Object.values(PAGE_MAP).some((file) => {
  const html = readPageIfExists(file);
  const masked = maskPageForSignal(html);
  return /overdueRule\s*[:(]/.test(masked) || /UnifyHelpers\.attachExport\s*\(/.test(masked);
});
const EXPORT_CONTENT_SCAFFOLD_BASELINE = 65;
if (!anyPageWiredContent) {
  must(pass + 1 === EXPORT_CONTENT_SCAFFOLD_BASELINE,
    `期望断言总数基线：脚手架阶段（三页均未出现接入信号）总数应为 ${EXPORT_CONTENT_SCAFFOLD_BASELINE}（实得 ${pass + 1}，含本条自身）——不等说明中途有断言被静默漏跑`);
} else {
  must(pass + 1 > EXPORT_CONTENT_SCAFFOLD_BASELINE,
    `期望断言总数基线：检测到接入页 → 总数(${pass + 1}) 必须高于脚手架基线(${EXPORT_CONTENT_SCAFFOLD_BASELINE})，证明接入触发了真实新增断言（非静默漏跑）`);
}

console.log(`\n=== ${fail === 0 ? 'PASS' : 'FAIL'}：${pass} 项通过 / ${fail} 项失败 ===`);
process.exit(fail === 0 ? 0 : 1);
