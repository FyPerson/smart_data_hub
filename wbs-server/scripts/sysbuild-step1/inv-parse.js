'use strict';
// #212 第一步（C1c）：取证原件（markdown 表格）的共用解析器，给 build-impl-list.js 与 build-test-disposition.js 用。
//   只读：读 UTF-8 文本、切表格，不改任何文件。
//   原件：docs/local/系统建设记录/送审准备/删除清单取证_20261119/ 下的 del-inv-*.md（后端逐文件符号表、测试表、变异表、守卫表）。
//
// 表格口径：
//   · 一个表 = 表头行 + 分隔行（|---|---|）+ 其后连续以 | 开头的数据行；围栏代码块里的不算表。行首允许 0–3 个空格的缩进（解析与审计同一口径，见 isPipeLine）。
//     围栏按开启符的类型与长度闭合（fenceMask：反引号围栏与波浪线围栏，闭合符的字符相同、个数不少于开启符、后面只有空白；四个反引号的围栏里的三反引号行不闭合它；
//     反引号围栏的信息串里还有反引号的是行内代码，不算围栏）；文件末尾围栏还没闭合时 auditPipeLines 报 unclosedFence，生成器判问题（不支持的写法显式报错，不静默吞掉后面的表）。
//   · 分隔行只认「紧随表头行、且各格都是 :?-+:? 、格数与表头相同」的那一行；表体里只由 - 与 : 组成的数据行（占位行）是数据行，不当分隔行（表体里要开新表，分隔行的每格至少 3 个 -）。
//   · 单元格按未转义的 | 切分，\| 还原成 |；行内 `...` 代码里的 | 先按代码处理（不切，splitRowCode）。配对反引号读法的格数不等于表头、普通切分刚好等于表头时不再静默改用普通切分：
//     把欠宽的配对反引号读法（尾部补空）与普通切分的分派字段比，任一不同 → ambiguous（H1 路径 B）。
//     多出来的单元格（原始格数 m > 表头列数 n，行尾空单元格也算，不再先弹掉）：有锚点列的表枚举全部吞并位置（mergeReadings：在 m-1 个相邻缝里合上 m-n 个），
//     按列类型约束过滤（typeValid：编号列数字、行号列数字区间、目标文件列文件名、类别列 A / B / C），比较所有仍成立读法的分派键（dispatchKey：第 0 列、名称 / 编号列、文件列、行号列、类别列取原文，
//     标签 / 被测 / 搭数据 / 锚点列取主标签、注记标签、未知词三者键；标签列不做过滤，只比较，过滤掉含未知词的读法会让 `ZZZ | HIS` 里的 ZZZ 无声消失）：
//     一个都不成立 → ambiguous；成立读法的分派键不止一种 → ambiguous（候选与原文写进 candText，弹掉行尾空单元格的读法单独标明）；键相同 → 不歧义。没有锚点列的表把多余单元格并回最后一列。
//     单元格数少于表头时，若下一行不以 | 开头就当作断行的续行并进来（见 parseTables）；缩进的 | 行接在欠宽行后面时：它自己凑不够单元格才并入上一行，
//     自己能独立成行（单元格数不少于表头，或以该表型的独立行起始字段开头：序号 + 名称、名称 + 合法行号，见 startsRecord）就不并入，保留两条物理行，两条都标 ambiguous（「边界待裁定」）；
//     合并到表尾 / 下一行仍欠宽的行同样标 ambiguous，保留原文与行号范围。
//     登记行可带第 8 项物理位置（表头行号），reconcile 按位置配对（重复节不再靠出现顺序）；顶层围栏只认 0–3 空格缩进，缩进 ≥ 4 的成对标记夹着表时 auditPipeLines 报 deepFenceAroundTable。
//   · auditPipeLines：围栏外每个以 | 开头、又不是某张表「表头紧随的分隔行」的行，必须落在某张已解析表的表头行或数据行上；两个生成器的反向校验都用它兜「表被切丢了」。
//   · 文件名 = 标题层级里离表最近的（表所在标题自己，再往上逐级的上级标题）、含 xxx.js / xxx.cjs / xxx.html 的标题里的文件名（opts.fileFilter 可限定哪些文件名算数）；
//     不跨同级章节沿用：进入新的同级标题后，前一个同级章节标题里的文件名作废；整条标题路径里都没有则为 ''。
//   · 标签 = 单元格里的大写标签词（CHG / INV / ITEM / ENT / HND / HIS / NTC / PRX / MLT / KEEP / SETUP / RPT）。括号（含全角）之外出现的是「主标签」，括号之内出现的是「注记标签」
//     （例：`KEEP（CHG：含 'change'）` 主标签 KEEP、注记标签 CHG；`KEEP(278-286 ...)；INV(284-285 ...)` 主标签 KEEP + INV）。
//     RPT = 进度汇报，保留（依据：取证原件 del-inv-backend-2.md:3 的标签表与 :417「整文件服务于 RPT（要保留）」；第一步实施清单 v1.0 裁定「RPT 保留」）；
//     它是已知标签，按保留类处理（不是可删标签，也不是未知词）。
//   · 未知词 = 括号之外、由 ASCII 字母数字下划线连成的整词（以 CJK 字符、标点、空白为界），整词全是大写字母 / 数字 / 下划线且以大写字母开头（任意长度，含单字母与带数字的词，
//     例 X、S12、FEATURE_FLAG_12、PROXYABLE_PURPOSES），又不是已知标签、也不在 ALLOWED_NOTE_WORDS（登记过的、允许忽略的说明缩写）里。含小写字母的词不算（change、xxSUBMIT_PURPOSES）。
//     2026-11-19 对八份取证原件逐个标签类单元格扫了一遍：括号之外的这类词共 12 个（REC_COLS、REASON_MAX、REPLY_MIN、INVITATION、DELEGATION_ACCEPT、SCHEDULE_NOTICE、PURPOSES、REF_TYPES、
//     PROXYABLE_PURPOSES、PENDING_TIMEOUT_TEXT、NO_ACCOUNT_TEXT、S12），都是代码标识符或编号，不是说明缩写，所以 ALLOWED_NOTE_WORDS 现在是空的；要放行某个缩写，在这里登记并写明依据。
const fs = require('fs');
const crypto = require('crypto');

const KNOWN_LABELS = ['CHG', 'INV', 'ITEM', 'ENT', 'HND', 'HIS', 'NTC', 'PRX', 'MLT', 'KEEP', 'SETUP', 'RPT'];
// 允许忽略的说明缩写（登记制，现为空；见上）
const ALLOWED_NOTE_WORDS = new Set([]);
// 冻结的取证原件与删除清单：sha256（2026-11-19 取得；两个生成器共用同一份登记，原件被改动、缺失都报）
const EVIDENCE_SHA256 = {
  'del-inv-backend-1.md': '7547a293c9fa4ce3e3229372209f4a6fc310d6d9300bbb59df627587bbbe22fe',
  'del-inv-backend-2.md': '7522c5725bf5413d06010d8ac9c2df954c27f836453e3483baa8d5a0334dc73e',
  'del-inv-backend-3.md': 'c896dcb01f13ad4e3fd2b6fbb779462c2604f73f900f7314962c3f73b3935dfc',
  'del-inv-backend-4.md': '59f321d051c14e16a9939253b1f13e165fd69a259c2e86c8e722e7f9c74994e4',
  'del-inv-guards.md': '913385da2c45ebd3d57367427393d6306291286086d67c4cf95e75bd3546dbe2',
  'del-inv-tests-1.md': '3eac8be87ea6b9ae2b38fb2a853219be781330b986436855aec0eb4b524e9931',
  'del-inv-tests-2.md': 'f8b05ec3d7ffc21770e70190c3390d405b4e2c8b2dc80062f44e2fe4b594e1e6',
  'del-inv-tests-3.md': 'b39e52e26d8f00b6bdddb1c45e62a740e8de12621694b4d935df79254afe96fa',
};
const DELETION_LIST_NAME = '系统建设记录_流程简化_第一步_删除清单_20261119_v1.0.md';
const DELETION_LIST_SHA256 = 'ba29ca1fbd400dc416d9949114e7519f3db42fdfb15076d5bf7e112deb9470a7';
const FILE_RE = /[A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:js|cjs|html)\b/g;
const SEP_RE = /^ {0,3}\|[\s:|-]+\|?\s*$/;

const readText = (file) => fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sha12 = (file) => sha256(file).slice(0, 12);
const isPipeLine = (l) => typeof l === 'string' && /^ {0,3}\|/.test(l);
const unindent = (l) => l.replace(/^ {0,3}(?=\|)/, '');
const stripEdges = (line) => line.trim().replace(/^\|/, '').replace(/\|\s*$/, '');

// 普通切分：只认 \| 转义，其余 | 都是列边界
function splitRow(line) {
  const t = stripEdges(line);
  const out = [];
  let cur = '';
  for (let i = 0; i < t.length; i += 1) {
    if (t[i] === '\\' && t[i + 1] === '|') { cur += '|'; i += 1; } else if (t[i] === '|') { out.push(cur.trim()); cur = ''; } else cur += t[i];
  }
  out.push(cur.trim());
  return out;
}
// 代码感知切分：成对反引号之间（同一行内、反引号个数相同的一对）的 | 不是列边界；\| 照旧还原成 |（代码里的 \| 也还原）。配不上对的反引号当普通字符。
function splitRowCode(line) {
  const t = stripEdges(line);
  const out = [];
  let cur = '';
  for (let i = 0; i < t.length; i += 1) {
    const ch = t[i];
    if (ch === '\\' && t[i + 1] === '|') { cur += '|'; i += 1; continue; }
    if (ch === '`') {
      let n = 1;
      while (t[i + n] === '`') n += 1;
      let j = i + n;
      let close = -1;
      while (j < t.length) {
        if (t[j] === '`') { let m = 1; while (t[j + m] === '`') m += 1; if (m === n) { close = j; break; } j += m; } else j += 1;
      }
      if (close >= 0) { cur += t.slice(i, close + n).replace(/\\\|/g, '|'); i = close + n - 1; } else { cur += t.slice(i, i + n); i += n - 1; }
      continue;
    }
    if (ch === '|') { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}
const normHeader = (header) => header.map((h) => String(h).replace(/\s+/g, ' ').trim()).join(' | ');

// 标签 / 类别「锚点列」：表头里第一个含「标签」的列；没有则第一个以「被测」开头的列；再没有则「类别」「类」列。没有锚点列的表不做多余单元格的合并。
function anchorCol(header) {
  let i = header.findIndex((h) => /标签/.test(h));
  if (i < 0) i = header.findIndex((h) => /^被测/.test(h));
  if (i < 0) i = header.findIndex((h) => /^(类别|类)$/.test(h));
  return i;
}
// 「行号」列：表头恰为「行」「行号」「行号范围」「取数行号」之类；用来识别读错位（行号格里不该是没有数字的说明文字）
const lineColOf = (header) => header.findIndex((h) => /^(取数)?行(号)?(范围)?$|^行号/.test(h));
const plausibleLine = (cell) => /\d/.test(String(cell)) || /^[\s—–\-?？]*$/.test(String(cell));
// 一个单元格读出的「标签签名」：已知标签（含注记）排序后用 + 连接；类别列的单字母 A / B / C 也算；都没有为 ''。
function labelSig(cell) {
  const l = parseLabels(cell);
  const k = Array.from(new Set(l.main.concat(l.note))).sort();
  if (k.length) return k.join('+');
  return /^[ABC]$/.test(String(cell).trim()) ? String(cell).trim() : '';
}
// 「文件」列（锚点列之前的第一个表头含「文件」的列）：读出的单元格应像文件名（含 .xx 后缀），否则多半是 id 或说明里的裸 | 把列挤歪了
const fileColOf = (header, a) => { const i = header.findIndex((h) => /文件/.test(h)); return i >= 0 && i < a ? i : -1; };
const plausibleFile = (cell) => /\.\w{1,5}\b/.test(String(cell));
// 标签类单元格的「读出内容」键：主标签、注记标签、未知词三者各自排序后的组合（候选读法比较用：三者任一不同就是读法会改变分派）
const labelKeyOf = (cell) => { const l = parseLabels(cell); return JSON.stringify([l.main.slice().sort(), l.note.slice().sort(), l.unknown.slice().sort()]); };
// 分派相关的列：第 0 列（符号 / 用例名 / 变异名，是匹配的键）、锚点列、含「标签」「被测」「搭数据」的列、类别列、行号列、文件列
function dispatchColsOf(header, a) {
  const out = new Set([0]);
  if (a >= 0) out.add(a);
  header.forEach((h, i) => { if (/标签|^被测|搭数据/.test(h) || /^(类别|类)$/.test(h) || isNameHeader(h) || isIdHeader(h) || isFileHeader(h)) out.add(i); });
  const li = lineColOf(header);
  if (li >= 0) out.add(li);
  const fc = fileColOf(header, a);
  if (fc >= 0) out.add(fc);
  return Array.from(out).sort((x, y) => x - y);
}
const isLabelCol = (header, i, a) => i === a || /标签|^被测|搭数据/.test(header[i]) || /^(类别|类)$/.test(header[i]);
// 两种读法在分派列上的差异：返回 [{ col, name, left, right }]
function readingDiffs(header, a, left, right) {
  const out = [];
  for (const i of dispatchColsOf(header, a)) {
    const l = String(left[i] === undefined ? '' : left[i]).trim();
    const r = String(right[i] === undefined ? '' : right[i]).trim();
    const same = isLabelCol(header, i, a) ? (labelKeyOf(l) === labelKeyOf(r) && (!/^(类别|类)$/.test(header[i]) || l === r)) : l === r;
    if (!same) out.push({ col: i, name: header[i], left: l, right: r });
  }
  return out;
}
const clipText = (s, n) => (String(s).length > n ? String(s).slice(0, n) + '…' : String(s));
// ── 候选读法枚举（76 号 HIGH-1 / HIGH-2）──────────────────────────────────────────────
// 原始单元格 m 个、表头 n 列（m > n）：把相邻单元格吞并成 n 列的全部读法 = 在 m-1 个相邻缝里选 k = m-n 个合上（同一格里的 | 还原）。
// 每个读法用列类型约束过滤：编号列（表头 #、序、序号、行）须全是数字；行号列（行号、行号范围、取数行号）去掉括号注释后只含数字与区间 / 分隔符；
// 目标文件列（表头 改的（源 / 前端）文件、目标（源）文件）须是单个文件名（xxx.js / .cjs / .html / .json / .md）；类别列须以 A / B / C 开头。
// 标签列不做过滤，只在读法之间比较（主标签、注记标签、未知词三者键）：过滤掉「含未知词」的读法会让 `ZZZ | HIS` 里的 ZZZ 无声消失（74 号 HIGH-1）。
const MERGE_CAP = 4000;
const isIdHeader = (h) => /^(#|序|序号|行)$/.test(h);
const isFileHeader = (h) => /^(改的(源|前端)?文件|目标(源)?文件)$/.test(h);
const isNameHeader = (h) => /^(用例|场景|断言|标题|用例编号|变异 ?(名|id)|符号|函数|键)/.test(h);
const stripParen = (s) => String(s).replace(/[（(][^）)]*[）)]/g, '');
const strictLine = (c) => { const t = stripParen(c).trim(); return /^[\s\d–—\-~～,，、.:：;；|/]*$/.test(t) && (/\d/.test(t) || /^[\s—–\-?？]*$/.test(t)); };
const strictFile = (c) => /^[A-Za-z0-9_.\-/]+\.(?:js|cjs|html|json|md)$/.test(String(c).trim());
function typeValid(header, cs) {
  for (let i = 0; i < header.length; i += 1) {
    const h = header[i];
    const c = cs[i] === undefined ? '' : String(cs[i]);
    if (isIdHeader(h) && !/^\d+$/.test(c.trim())) return false;
    if (!isIdHeader(h) && /^行号|^(取数)?行号?范围$/.test(h) && !strictLine(c)) return false;
    if (isFileHeader(h) && !strictFile(c)) return false;
    if (/^(类别|类)$/.test(h) && !/^[ABC]/.test(c.trim())) return false;
  }
  return true;
}
// 读法的「分派键」：第 0 列、名称 / 编号列、文件列、行号列、类别列取原文；标签 / 被测 / 搭数据列与锚点列取标签读出内容键
function dispatchKey(header, a, cs) {
  const parts = [];
  for (let i = 0; i < header.length; i += 1) {
    const h = header[i];
    const c = (cs[i] === undefined ? '' : String(cs[i])).trim();
    if (i === a || /标签|^被测|搭数据/.test(h)) parts.push(i + '=' + labelKeyOf(c));
    else if (i === 0 || isNameHeader(h) || isIdHeader(h) || isFileHeader(h) || /^行号|^(取数)?行号?范围$/.test(h) || /^(类别|类)$/.test(h)) parts.push(i + '=' + c);
  }
  return parts.join('\u0001');
}
// 全部吞并读法：返回 [{ cells, gaps }]（gaps = 合上的缝下标）；超过 MERGE_CAP 返回 null
function mergeReadings(cells, n) {
  const m = cells.length;
  const k = m - n;
  if (k <= 0) return [{ cells: cells.slice(), gaps: [] }];
  let total = 1;
  for (let i = 0; i < k; i += 1) total = (total * (m - 1 - i)) / (i + 1);
  if (total > MERGE_CAP) return null;
  const res = [];
  const pick = (start, left, gaps) => {
    if (left === 0) {
      const g = new Set(gaps);
      const cs = [];
      let cur = cells[0];
      for (let i = 0; i < m - 1; i += 1) { if (g.has(i)) cur += '|' + cells[i + 1]; else { cs.push(cur); cur = cells[i + 1]; } }
      cs.push(cur);
      res.push({ cells: cs, gaps: gaps.slice() });
      return;
    }
    for (let i = start; i <= m - 1 - left; i += 1) pick(i + 1, left - 1, gaps.concat([i]));
  };
  pick(0, k, []);
  return res;
}
// 一行的单元格（见头注释）。返回 { cells, ambiguous, ambReason, candText, how, extra, diffNames }。
//   H1 路径 B：配对反引号读法的格数 ≠ 表头、普通切分刚好等于表头时，不再静默采用普通切分——把欠宽的配对反引号读法（尾部补空）与普通切分的分派字段比，任一不同 → ambiguous（带两种读法）。
//   原始单元格多于表头（m > n，行尾的空单元格也算，不再先弹掉）：
//   · 没有锚点列的表（含锚点列是第 0 列）：弹掉行尾空单元格后，多余单元格并回最后一列，只保证最后一列之前的列对位（这类表没有分派列）；
//   · 有锚点列的表：枚举全部吞并位置（mergeReadings），按列类型约束过滤（typeValid），比较所有仍成立读法的分派键（dispatchKey）：
//     一个都不成立 → ambiguous；成立读法的分派键不止一种 → ambiguous（候选与原文写进 candText）；成立读法键相同 → 不歧义，按优先序取一个
//     （优先：行尾空单元格弹掉的读法，其次标签 / 锚点格较短的读法）。
function readCells(header, raw) {
  const n = header.length;
  const plain = splitRow(raw);
  const code = splitRowCode(raw);
  const a = anchorCol(header);
  const candLine = (cs) => dispatchColsOf(header, a).map((i) => header[i] + '=' + clipText(cs[i] === undefined ? '' : cs[i], 40)).join('；');
  if (code.length !== n && plain.length === n) {
    // H1 路径 B：配对反引号读法欠宽（反引号把 | 当成代码里的字符），改用普通切分会把单元格重新分开
    const padded = code.concat(new Array(Math.max(0, n - code.length)).fill(''));
    const diffs = readingDiffs(header, a, padded, plain);
    const candText = '配对反引号读法（' + code.length + ' 格，尾部补空）：' + candLine(padded) + ' ／ 普通切分（' + plain.length + ' 格）：' + candLine(plain);
    if (diffs.length) return { cells: plain, ambiguous: true, ambReason: '配对反引号读法欠宽（' + code.length + ' 格 < 表头 ' + n + ' 格），改用普通切分会移动分派字段：' + diffs.map((d) => d.name + '（配对反引号读法「' + clipText(d.left, 24) + '」/ 普通切分「' + clipText(d.right, 24) + '」）').join('、'), candText, how: 'amb-backtick', extra: 0, diffNames: diffs.map((d) => d.name), candidates: [padded, plain] };
    return { cells: plain, ambiguous: false, ambReason: '', candText: '', how: 'backtick-same', extra: 0, diffNames: [] };
  }
  const cells = code;
  if (cells.length <= n) return { cells, ambiguous: false, ambReason: '', candText: '', how: '', extra: 0, diffNames: [] };
  if (a <= 0) {
    const c = cells.slice();
    while (c.length > n && c[c.length - 1] === '') c.pop(); // 没有分派列的表：行尾 `| |` 留下的空单元格不算内容
    if (c.length <= n) return { cells: c, ambiguous: false, ambReason: '', candText: '', how: 'noanchor', extra: 0, diffNames: [] };
    return { cells: c.slice(0, n - 1).concat([c.slice(n - 1).join('|')]), ambiguous: false, ambReason: '', candText: '', how: 'noanchor', extra: c.length - n, diffNames: [] };
  }
  const m = cells.length;
  const extra = m - n;
  const tailCols = n - 1 - a;
  const all = mergeReadings(cells, n);
  const fallback = () => { const c = cells.slice(); while (c.length > n && c[c.length - 1] === '') c.pop(); return c.length <= n ? c : c.slice(0, n - 1).concat([c.slice(n - 1).join('|')]); };
  if (all === null) return { cells: fallback(), ambiguous: true, ambReason: '多余的单元格 ' + extra + ' 个，吞并位置组合过多（超过 ' + MERGE_CAP + '），列边界定不下来', candText: '', how: 'amb-cap', extra, diffNames: [] };
  // 优先序：行尾空单元格弹掉的读法（合上的缝全在行尾空格之内）排最前，其次锚点格短的
  let trailing = 0;
  while (trailing < m && cells[m - 1 - trailing] === '') trailing += 1;
  const popReading = (() => { if (trailing < extra) return null; const c = cells.slice(0, m - extra); return c.length === n ? { cells: c, gaps: ['pop'] } : null; })();
  const cands = (popReading ? [popReading] : []).concat(all);
  const valid = cands.filter((r) => typeValid(header, r.cells));
  const anchorLen = (r) => String(r.cells[a] === undefined ? '' : r.cells[a]).length;
  // 展示 / 取用顺序：弹掉行尾空单元格的读法最前；其次标签类列里读出已知标签的列越多越前；再其次锚点格越短越前（只影响不歧义时取哪个、歧义时 cells 默认展示哪个，不影响是否歧义）
  const gapSum = (r) => r.gaps.reduce((s, g) => s + (typeof g === 'number' ? g : 0), 0); // 再其次合上的缝越靠后越前（多余的 | 更可能在靠后的说明类列里）
  const labelScore = (r) => header.reduce((s, h, i) => s + (i === a || /标签|^被测|搭数据/.test(h) ? (() => { const l = parseLabels(r.cells[i]); return l.main.length + l.note.length > 0 ? 1 : 0; })() : 0), 0);
  valid.sort((x, y) => (x.gaps[0] === 'pop' ? -1 : 0) - (y.gaps[0] === 'pop' ? -1 : 0) || labelScore(y) - labelScore(x) || anchorLen(x) - anchorLen(y) || gapSum(y) - gapSum(x));
  const keys = new Set(valid.map((r) => dispatchKey(header, a, r.cells)));
  if (valid.length === 0) return { cells: fallback(), ambiguous: true, ambReason: '多余的单元格 ' + extra + ' 个，枚举全部吞并位置后没有一种读法满足列类型约束（编号列数字、行号列数字区间、目标文件列文件名）', candText: '原始 ' + m + ' 格：' + JSON.stringify(cells.map((c) => clipText(c, 30))), how: 'amb-none', extra, diffNames: [] };
  if (keys.size === 1) return { cells: valid[0].cells, ambiguous: false, ambReason: '', candText: '', how: valid.length === 1 ? 'only' : 'same', extra, diffNames: [] };
  // 不止一种分派键：列出差异列与（至多 3 种）不同键的读法
  const first = valid[0];
  const seen = new Set([dispatchKey(header, a, first.cells)]);
  const alts = [first];
  for (const r of valid) { const k = dispatchKey(header, a, r.cells); if (!seen.has(k) && alts.length < 3) { seen.add(k); alts.push(r); } }
  const diffNames = [];
  const diffPieces = [];
  for (const alt of alts.slice(1)) for (const d of readingDiffs(header, a, first.cells, alt.cells)) { if (!diffNames.includes(d.name)) diffNames.push(d.name); diffPieces.push(d.name + '（「' + clipText(d.left, 24) + '」/「' + clipText(d.right, 24) + '」）'); }
  const anchorDiff = diffNames.includes(header[a]);
  const candText = alts.map((r, i) => '读法 ' + (i + 1) + (r.gaps[0] === 'pop' ? '（弹掉行尾空单元格）' : '（合上缝 ' + r.gaps.join(',') + '）') + '：' + candLine(r.cells)).join(' ／ ');
  return { cells: first.cells, ambiguous: true, ambReason: '多余的单元格 ' + extra + ' 个，枚举全部吞并位置后 ' + valid.length + ' 种读法成立、分派字段不同，列边界定不下来：' + diffPieces.slice(0, 4).join('、') + (tailCols === 0 && anchorDiff ? '（标签单元格里可能也有 |）' : ''), candText, how: 'amb-diff', extra, diffNames, candidates: valid.map((r) => r.cells) };
}

// 一行（已切成单元格 cs）是不是该表型的「独立行起始字段」：序号列在第 0 列的表 = 第 0 格全是数字且第 1 格非空；有行号列（下标 > 0）的表 = 行号格是合法行号（含数字）且第 0 格非空
function startsRecord(header, cs) {
  if (isIdHeader(header[0] || '') && cs.length >= 2 && /^\d+$/.test(String(cs[0]).trim()) && String(cs[1]).trim() !== '') return true;
  const li = lineColOf(header);
  if (li > 0 && cs.length > li && strictLine(cs[li]) && /\d/.test(String(cs[li])) && String(cs[0]).trim() !== '') return true;
  return false;
}
const SEP_CELL = (k) => new RegExp('^:?-{' + k + ',}:?$');
// 这一行是不是「分隔行」：以 | 开头（≤3 空格缩进）、格数 = ncols、每格 :?-{k,}:?
function isSepRow(line, ncols, minDash) {
  if (!isPipeLine(line)) return false;
  const cs = splitRow(line);
  const re = SEP_CELL(minDash);
  return cs.length === ncols && cs.every((x) => re.test(x));
}
// 候选表头行 + 下一行是不是分隔行：返回表头单元格（普通切分与代码切分里与分隔行格数一致的那一个）或 null
function headerOf(line, next, minDash) {
  if (!isPipeLine(line) || !isPipeLine(next)) return null;
  const sepCells = splitRow(next).length;
  for (const h of [splitRow(line), splitRowCode(line)]) if (h.length === sepCells && isSepRow(next, sepCells, minDash)) return h;
  return null;
}

// 围栏：开启符 = 行首（任意缩进）连续 ≥ 3 个同种字符（` 或 ~）；反引号围栏的信息串里再有反引号的是行内代码，不算围栏。闭合符 = 同种字符、个数不少于开启符、后面只有空白。
// 顶层围栏只认 0–3 个空格缩进（76 号 MEDIUM-1：任意缩进都当围栏，两个缩进四格的 ~~~ 夹一张顶层取证表时整张表被遮、审计同遮、围栏成对也没有未闭合提示）；
// 缩进 ≥ 4 空格（或 tab）的围栏标记不当围栏，由 fenceMask 记在 deep 里，auditPipeLines 把「夹着表的成对深缩进标记」报给生成器。
const DEEP_FENCE_RE = /^( {4,}|\t+ *)(`{3,}|~{3,})/;
function fenceInfo(l) {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(l);
  if (!m) return null;
  if (m[1][0] === '`' && m[2].includes('`')) return null;
  return { ch: m[1][0], len: m[1].length, rest: m[2] };
}
// 逐行标围栏（解析与审计共用这一份）：mask[i] = 1 表示第 i 行是围栏行或在围栏里；open = 文件末尾仍没闭合的围栏（{ ch, len, line（1 起）}）或 null；deep = 围栏外缩进 ≥ 4 的围栏标记行号（1 起）
function fenceMask(lines) {
  const mask = new Uint8Array(lines.length);
  let open = null;
  const deep = [];
  for (let i = 0; i < lines.length; i += 1) {
    const f = fenceInfo(lines[i]);
    if (open) {
      mask[i] = 1;
      if (f && f.ch === open.ch && f.len >= open.len && f.rest.trim() === '') open = null;
    } else if (f) { mask[i] = 1; open = { ch: f.ch, len: f.len, line: i + 1 }; } else if (DEEP_FENCE_RE.test(lines[i])) deep.push(i + 1);
  }
  return { mask, open, deep };
}
// 返回 [{ file, heading, headingLine, headingPath, headingLines, headerLine, header, rows: [{ line, endLine, cells, raw, ambiguous, ambReason, candText, boundary }] }]
//   headingLines = headingPath 里每一级标题在原文里的行号（同名标题的区分、前缀继承绑定父节实例都靠它）。
//   断行：表内遇到不以 | 开头的行时，若上一数据行的单元格数少于表头，就把这一行（去首尾空白，用空格接上）并进上一行继续读，直到标题、围栏或上一行已凑够单元格为止；
//   上一行还没凑够单元格时，夹在中间的空行也不算表尾（跳过，该行记 crossedBlank，生成器把它列为警告）；上一行已凑够时，空行 / 标题 / 围栏 / 别的文字都结束这张表。
//   缩进的 | 行接在欠宽行后面：它自己能独立成行（读出的单元格数不少于表头）就不并入——保留两条物理行，两条都标 ambiguous（boundary 写明两行的位置）；自己也欠宽才当续行并入。
//   最终（下一行、表尾都过了）仍欠宽的行标 ambiguous（原文与行号范围保留）。ambiguous = 列边界歧义（readCells）或边界待裁定或仍欠宽，ambReason 把几种原因用「；」连起来。
//   「以 | 开头且下一行是分隔行（每格 ≥ 3 个 -、格数相同）」的行（另一张表的表头）也结束本表，不会被并进上一行。
//   opts.fileFilter(name) → bool：限定哪些文件名算「表所在标题里的文件」（默认全算）。
function parseTables(text, opts) {
  const fileOk = (opts && opts.fileFilter) || (() => true);
  const lines = text.split(/\r?\n/);
  const fm = fenceMask(lines);
  const tables = [];
  const stack = []; // 标题层级：{ level, text, line }
  let tblUnderTop = 0; // 当前最内层标题下已解析的表数
  // 标题里有多个文件名（例：「2.9 a.js（449 行）与 b.js（222 行）」）时，这个标题下第 n 张表取第 n 个文件名（超出取最后一个）；上级标题里的多个文件名只取第一个
  const fileOf = () => {
    for (let k = stack.length - 1; k >= 0; k -= 1) {
      const names = Array.from(new Set(Array.from(stack[k].text.matchAll(FILE_RE)).map((m) => m[0]).filter(fileOk)));
      if (names.length) return k === stack.length - 1 && names.length > 1 ? names[Math.min(tblUnderTop, names.length - 1)] : names[0];
    }
    return '';
  };
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    if (fm.mask[i]) continue;
    const hm = /^(#{1,6}) /.exec(l);
    if (hm) {
      const level = hm[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, text: l.replace(/^#+\s*/, '').trim(), line: i + 1 });
      tblUnderTop = 0;
      continue;
    }
    const header = headerOf(l, lines[i + 1], 1);
    if (!header) continue;
    const rows = [];
    let j = i + 2;
    const mkRow = (line, raw) => { const rc = readCells(header, raw); return { line, endLine: line, raw, cells: rc.cells, readAmb: rc.ambiguous, readReason: rc.ambReason, candText: rc.candText, candidates: rc.candidates || [], how: rc.how || '', extra: rc.extra || 0, diffNames: rc.diffNames || [], boundary: '' }; };
    while (j < lines.length) {
      const lj = lines[j];
      const last = rows[rows.length - 1];
      const incomplete = !!last && last.cells.length < header.length;
      if (fm.mask[j] || /^#{1,6} /.test(lj)) break;
      if (headerOf(lj, lines[j + 1], 3)) break; // 另一张表的表头：本表到此为止
      if (lj.trim() === '') {
        if (incomplete) { last.crossedBlank = true; j += 1; continue; }
        break;
      }
      if (isPipeLine(lj)) {
        // 上一行已凑够单元格，或这一行没缩进：新的数据行
        if (!(incomplete && /^\s/.test(lj))) { rows.push(mkRow(j + 1, unindent(lj))); j += 1; continue; }
        // 缩进的 | 行接在欠宽行后面：它自己能独立成行就不并入（保留两条物理行，边界待裁定）；自己也欠宽才是断行的续行
        // 76 号 HIGH-3：自己能独立成行 = 单元格数不少于表头，或自己以该表型「独立行起始字段」开头（序号 + 名称 / 编号；名称 + 合法行号）——
        //   两条各自欠宽的记录否则会被拼成一条表面完整的记录（`| 前条 | 20 | KEEP` + `  | 次条 | 30 |` 恰好拼满五格）
        const alone = readCells(header, unindent(lj));
        if (alone.cells.length >= header.length || startsRecord(header, alone.cells)) {
          const nr = mkRow(j + 1, unindent(lj));
          const why = '上一行（原文第 ' + last.line + (last.endLine !== last.line ? '–' + last.endLine : '') + ' 行）欠宽、本行（第 ' + (j + 1) + ' 行，缩进的 | 行）自己能独立成行：边界待裁定，两条物理行都保留';
          last.boundary = why;
          nr.boundary = why;
          rows.push(nr);
          j += 1;
          continue;
        }
      }
      if (incomplete) {
        last.raw = last.raw + ' ' + lj.trim();
        last.endLine = j + 1;
        const rc = readCells(header, last.raw);
        last.cells = rc.cells;
        last.readAmb = rc.ambiguous;
        last.readReason = rc.ambReason;
        last.candText = rc.candText;
        last.candidates = rc.candidates || [];
        last.how = rc.how || '';
        last.extra = rc.extra || 0;
        last.diffNames = rc.diffNames || [];
        j += 1;
        continue;
      }
      break;
    }
    // 最终判歧义：列边界歧义 / 边界待裁定 / 合并到表尾（或下一行）仍欠宽
    for (const r of rows) {
      const why = [];
      if (r.readAmb) why.push(r.readReason);
      if (r.boundary) why.push(r.boundary);
      if (r.cells.length < header.length) why.push('仍欠宽：单元格 ' + r.cells.length + ' 个 < 表头 ' + header.length + ' 个（原文第 ' + r.line + (r.endLine !== r.line ? '–' + r.endLine : '') + ' 行）');
      r.ambiguous = why.length > 0;
      r.ambReason = why.join('；');
      // 候选读法是否完整可枚举（78 号 MEDIUM-2）：只因「读法歧义」（amb-diff / amb-backtick，候选已全部在 candidates 里）而歧义、没有边界待裁定 / 仍欠宽时才算完整；
      //   amb-none / amb-cap / 边界待裁定 / 仍欠宽的行，候选读法不完整，生成器必须把它列进人工裁定清单
      r.candComplete = r.ambiguous && !r.boundary && r.cells.length >= header.length && r.readAmb && (r.how === 'amb-diff' || r.how === 'amb-backtick') && (r.candidates || []).length > 0;
    }
    const top = stack.length ? stack[stack.length - 1] : null;
    const fileName = fileOf();
    tblUnderTop += 1;
    tables.push({ file: fileName, heading: top ? top.text : '', headingLine: top ? top.line : 0, headingPath: stack.map((s) => s.text), headingLines: stack.map((s) => s.line), headerLine: i + 1, header, rows });
    i = j - 1;
  }
  return tables;
}

// 原文里代码围栏之外每一个以 | 开头（≤3 空格缩进）的行：除「某张表表头紧随的分隔行」外，必须落在某张已解析表的表头行、数据行或其断行续行上。
//   返回 { total（不含这些分隔行）, uncovered: [行号…], parsedEmpty（原文有 | 行、但一张表都没解析出来）, contPipe（以 | 开头的断行续行数）, unclosedFence（文件末尾仍没闭合的围栏开启行号，没有为 null）}。
function auditPipeLines(text, tables) {
  const lines = text.split(/\r?\n/);
  const fm = fenceMask(lines);
  const covered = new Set();
  const seps = new Set();
  for (const t of tables) { covered.add(t.headerLine); seps.add(t.headerLine + 1); for (const r of t.rows) for (let k = r.line; k <= r.endLine; k += 1) covered.add(k); } // 断行的续行（含缩进的 | 行）也算这一行的内容
  const pipe = [];
  let all = 0;
  lines.forEach((l, i) => {
    if (fm.mask[i]) return;
    if (isPipeLine(l)) { all += 1; if (!seps.has(i + 1)) pipe.push(i + 1); }
  });
  // 续行里以 | 开头的行（缩进的 | 行并进了上一行）：算已覆盖，但不是「表头行 + 数据行起始行」，核对「入选 + 排除 = 总数」时单列
  let contPipe = 0;
  for (const t of tables) for (const r of t.rows) for (let k = r.line + 1; k <= r.endLine; k += 1) if (isPipeLine(lines[k - 1])) contPipe += 1;
  // 缩进 ≥ 4 的围栏标记（不当围栏）：成对的（第 1、2 个，第 3、4 个……）夹着顶层 | 行的 → 报原件位置，由生成器判问题
  const deepAround = [];
  for (let i = 0; i + 1 < fm.deep.length; i += 2) {
    const open = fm.deep[i];
    const close = fm.deep[i + 1];
    if (lines.slice(open, close - 1).some((x) => isPipeLine(x))) deepAround.push({ open, close });
  }
  return { total: pipe.length, uncovered: pipe.filter((n) => !covered.has(n)), parsedEmpty: all > 0 && tables.length === 0, contPipe, unclosedFence: fm.open ? fm.open.line : null, deepFence: fm.deep, deepFenceAroundTable: deepAround };
}

// 标签单元格 → { main: [标签…], note: [标签…], unknown: [括号之外的未知词…] }（均去重、按出现顺序；括号之内的未知大写词多是英文标识符，不报）
//   词 = ASCII 字母数字下划线连成的整词（以 CJK、标点、空白为界）；整词全大写（数字、下划线可有）且以大写字母开头才是候选，不限长度；已知标签进 main / note，
//   ALLOWED_NOTE_WORDS 里登记的说明缩写忽略，其余括号之外的进 unknown（见头注释「未知词」）。
function parseLabels(cell) {
  const s = String(cell || '');
  const main = [];
  const note = [];
  const unknown = [];
  let depth = 0;
  const re = /[（(）)]|[A-Za-z0-9_]+/g;
  for (let m = re.exec(s); m !== null; m = re.exec(s)) {
    const t = m[0];
    if (t === '(' || t === '（') depth += 1;
    else if (t === ')' || t === '）') depth = Math.max(0, depth - 1);
    else if (!/^[A-Z][A-Z0-9_]*$/.test(t)) continue;
    else if (KNOWN_LABELS.includes(t)) { const arr = depth === 0 ? main : note; if (!arr.includes(t)) arr.push(t); } else if (depth === 0 && !ALLOWED_NOTE_WORDS.has(t) && !unknown.includes(t)) unknown.push(t);
  }
  return { main, note, unknown };
}

// 变异表的统一识别（impl 清单与测试去向表共用）：表头里有以「变异 名」或「变异 id」开头的列（`^变异 ?(名|id)`，不分大小写，后面可以跟括号说明）。
//   返回 { nameCol, prefix, labelCol } 或 null。prefix：表头单元格括号里写了「前缀 X」的（例 `变异 id（前缀 C5 分流：）`），读 id 时补在每个 id 前面；labelCol = 含「流程标签」的列，没有为 -1。
function mutationTable(header) {
  const nameCol = header.findIndex((h) => /^变异 ?(名|id)/i.test(h));
  if (nameCol < 0) return null;
  const m = /前缀\s*(.+?)\s*[）)]\s*$/.exec(header[nameCol]);
  return { nameCol, prefix: m ? m[1] : '', labelCol: header.findIndex((h) => /流程标签/.test(h)) };
}

// ── 期望清单（身份）核对（两个生成器共用）─────────────────────────────────────────────
// 表的身份 = 文件名 + 所在标题（标题行原文，去 # 与首尾空白）+ 规范化表头（各格去首尾空白、连续空白并成一个空格，用 ' | ' 连接）；同一文件里身份相同的表按出现顺序编号（第 0、1…张）。
// 登记行 = [文件, 标题, 表头, 角色, 理由, 完整标题路径, 所属文件]：后两项（可缺，缺则不核）登记这张表的完整标题路径（各级标题用 ' › ' 连接）与它归属的套件 / 后端文件名（表所在标题层级里解析出的 file）。
//   末级标题相同、表头相同、上级套件不同的表在身份上分不开，靠这两项补「归属错配」的自检：把表归到错误的上级章节，路径或所属文件就对不上。
// reconcile 返回 { matched: [{ table, entry }], missing: [登记行…], unregistered: [表…], mismatched: [{ table, entry, why }]（身份对上、但完整标题路径或所属文件与登记不符） }。
function tableIdentity(fileName, t) { return [fileName, t.heading, normHeader(t.header)]; }
const pathOfTable = (t) => (t.headingPath || [t.heading]).join(' › ');
function reconcile(fileName, tables, entries) {
  const key = (a) => a.slice(0, 3).join('\u0001');
  const bag = new Map();
  for (const e of entries) { if (e[0] !== fileName) continue; const k = key(e); if (!bag.has(k)) bag.set(k, []); bag.get(k).push(e); }
  const used = new Map();
  const usedEntries = new Set();
  const matched = [];
  const unregistered = [];
  const mismatched = [];
  for (const t of tables) {
    const k = key(tableIdentity(fileName, t));
    const list = bag.get(k) || [];
    const ord = used.get(k) || 0;
    used.set(k, ord + 1);
    // 76 号 MEDIUM-2：登记行带物理位置（第 8 项 = 表头行号）时，按位置配对，不再靠「同身份第几次出现」：
    //   完整路径、所属文件、表头都相同的两张表（重复节）交换后路径与文件字段仍全部相等，登记角色会对到另一张表
    const positional = list.some((e) => e[7] !== undefined);
    const entry = positional ? list.find((e) => !usedEntries.has(e) && e[7] === t.headerLine) : list[ord];
    if (entry) {
      usedEntries.add(entry);
      matched.push({ table: t, entry });
      const why = [];
      if (entry[5] !== undefined && entry[5] !== pathOfTable(t)) why.push('完整标题路径登记为「' + entry[5] + '」，原件里是「' + pathOfTable(t) + '」');
      if (entry[6] !== undefined && entry[6] !== t.file) why.push('所属文件登记为「' + entry[6] + '」，原件里解析为「' + t.file + '」');
      if (why.length) mismatched.push({ table: t, entry, why: why.join('；') });
    } else unregistered.push(t);
  }
  const missing = [];
  for (const list of bag.values()) for (const e of list) if (!usedEntries.has(e)) missing.push(e);
  return { matched, missing, unregistered, mismatched };
}
// 从一个目录生成登记行（生成登记数据与自检用）：roleFn(table, fileName) → { role, reason }；带完整标题路径与所属文件；snapOpts.withLine = true 时再带第 8 项（表头行号，按物理位置配对用）
function snapshotRegistry(invDir, fileNames, parseOpts, roleFn, snapOpts) {
  const out = [];
  for (const f of fileNames) {
    const text = readText(require('path').join(invDir, f));
    for (const t of parseTables(text, parseOpts)) { const r = roleFn(t, f); const row = tableIdentity(f, t).concat([r.role, r.reason || '', pathOfTable(t), t.file]); if (snapOpts && snapOpts.withLine) row.push(t.headerLine); out.push(row); }
  }
  return out;
}
const shortTable = (fileName, t) => fileName + ':' + t.headerLine + '（标题「' + t.heading + '」；表头「' + normHeader(t.header) + '」）';
const shortEntry = (e) => e[0] + '（标题「' + e[1] + '」；表头「' + e[2] + '」；角色 ' + e[3] + '）';

// ── 自检（node inv-parse.js --self-test）───────────────────────────────────────────────
function selfTest() {
  let total = 0;
  let ok = 0;
  const check = (pass, label) => { total += 1; if (pass) ok += 1; console.log(`  ${pass ? '✓' : '✗'} ${label}`); };
  const H5 = ['符号', '行号', '说明', '标签', '依据'];
  const rc = (header, raw) => readCells(header, raw);
  // 切分
  check(splitRowCode('| `a | b` | c |').join('~') === '`a | b`~c' && splitRow('| `a | b` | c |').length === 3, '切分：代码感知切分不切反引号行内代码里的 |（普通切分会切成 3 格）');
  check(splitRowCode('| `x \\| y` | z |').join('~') === '`x | y`~z' && splitRowCode('| a\\|b | c |').join('~') === 'a|b~c', '切分：\\| 还原成 |（代码里外都一样）');
  check(splitRowCode('| `unclosed | b |').join('~') === '`unclosed~b' && splitRowCode('| ``a ` b | c`` | d |').join('~') === '``a ` b | c``~d', '切分：配不上对的反引号当普通字符（后面的 | 照切）；双反引号的代码里的单反引号与 | 不切');
  // 读行
  const a1 = rc(H5, '| s | 12 | 说明末尾| | KEEP、PRX | 解释 c|d |');
  check(a1.ambiguous === true && /多余的单元格 2 个/.test(a1.ambReason), 'H2 回归：标签两侧都有裸 |（说明末尾一个、依据里一个，多余单元格 2 个，锚点列后面还有列）→ ambiguous，不再按左读 / 右读猜');
  const a2 = rc(H5, '| s | 12 | 说明 | KEEP | HIS | 依据 |');
  check(a2.ambiguous === true && /分派字段不同/.test(a2.ambReason) && /读法 1/.test(a2.candText) && /读法 2/.test(a2.candText), 'H2：只多 1 个、枚举全部吞并位置后读法的标签不同（KEEP / HIS / KEEP|HIS）→ ambiguous，原文与不同键的读法写进 candText');
  // 76 HIGH-1 路径 A：行尾空单元格不再先弹掉；弹掉的读法只是候选之一，会移动分派字段就歧义；弹掉后其余读法都被列类型约束排除（或键相同）时，末列确实为空 → 不歧义
  const t3 = rc(['用例', '行号', '被测'], '| u | 12 | KEEP | |');
  check(t3.ambiguous === false && t3.cells.join('~') === 'u~12~KEEP' && rc(H5, '| s | 12 | 说明 | KEEP | HIS | |').ambiguous === true && rc(H5, '| s | 12 | 说明 | KEEP | HIS | |').candText.includes('弹掉行尾空单元格'), '76 H1 回归（末列确实为空）：三列表 `| u | 12 | KEEP | |`：弹掉行尾空单元格后其余吞并读法都被行号列约束排除或分派键相同 → 不歧义；五列 sym 表 `| s | 12 | 说明 | KEEP | HIS | |`：弹掉的读法与「KEEP|HIS 合并」等读法分派键不同 → ambiguous，候选写明「弹掉行尾空单元格」');
  const a3 = rc(H5, '| s | 12 | 含 | 竖线的说明 | HIS | 依据 |');
  check(a3.ambiguous === true && /分派字段不同/.test(a3.ambReason) && /标签/.test(a3.candText), '74 H1：只多 1 个、左读读不出标签（说明列里的裸 |）：两种读法的标签不同 → ambiguous（旧版会取右读并说成不歧义，是在替人猜；候选读法会改变分派字段就不猜）');
  // 74 HIGH-1 原话反例：被测原文 `KEEP | 分支说明`、搭数据 HIS，左读得被测 KEEP / 搭数据「分支说明」，右读得被测「分支说明」/ 搭数据 HIS；两边行号都合法
  const h1 = rc(['用例', '行号', '被测', '搭数据', '说明'], '| u | 12 | KEEP | 分支说明 | HIS | 说明 |');
  const h1c = rc(['用例', '行号', '被测', '搭数据', '说明'], '| u | 12 | KEEP | 分支说明 | HIS | |');
  check(h1c.ambiguous === true && /搭数据/.test(h1c.ambReason) && h1c.candText.includes('弹掉行尾空单元格') && /KEEP/.test(h1c.candText) && /HIS/.test(h1c.candText), '76 H1 原话反例（路径 A）：`| 某用例 | 12 | KEEP | 分支说明 | HIS | |`——旧版弹掉末尾空格后直接接受五格，搭数据读成「分支说明」、HIS 落到说明列；现在弹掉的读法与「KEEP | 分支说明」合并读法的搭数据不同 → ambiguous，候选带原文位置');
  const h1d = rc(['用例', '行号', '被测', '搭数据', '说明'], '| 某用例 | 12 | KEEP | `说明 | HIS` |');
  check(h1d.ambiguous === true && h1d.how === 'amb-backtick' && /配对反引号读法欠宽/.test(h1d.ambReason) && /搭数据/.test(h1d.ambReason) && /普通切分/.test(h1d.candText) && rc(['用例', '行号', '被测', '搭数据', '说明'], '| 某用例 | 12 | KEEP | HIS | `a | b` |').how !== 'amb-backtick', '76 H1 回归（配对反引号欠宽）：`| 某用例 | 12 | KEEP | ` + 反引号包裹的 `说明 | HIS` ——配对反引号读法只有四格，普通切分刚好五格，旧版采用普通切分使 HIS 移出搭数据列；现在两种读法分派字段不同 → ambiguous（带两种读法）；格数本来就够（5 格）的行不触发');
  check(h1.ambiguous === true && /搭数据/.test(h1.ambReason) && /KEEP/.test(h1.candText) && /HIS/.test(h1.candText), '74 H1 原话反例：被测 `KEEP | 分支说明` + 搭数据 HIS（两种读法行号都合法）→ ambiguous，不再按「一边读得出标签」选左读初判「不受影响」；candText 带两种读法');
  const h1b = rc(['#', '变异名', '改的源文件', '锚点字面量', '流程标签'], '| 1 | m | rules.js | a | ZZZ | HIS |');
  check(h1b.ambiguous === true && /标签单元格里可能也有/.test(h1b.ambReason), '74 H1 原话反例（末列右读）：标签原文 `ZZZ | HIS`：整段与末格的已知标签签名都是 HIS，旧版接受列边界、未知词 ZZZ 消失 → 现在主标签 / 未知词的差异也比，判 ambiguous');
  check(rc(['#', '变异名', '改的源文件', '锚点字面量', '流程标签'], '| 1 | m | rules.js | a || b | KEEP |').ambiguous === false, '74 H1：两种读法读出同一组标签（锚点字面量里的 `||`）→ 不歧义');
  const a4 = rc(H5, '| s | 说明里有 | 竖线 | KEEP | 依据 | 多 |');
  check(a4.ambiguous === true && a4.how === 'amb-none' && /没有一种读法满足列类型约束/.test(a4.ambReason), 'H2：行号列被挤成文字（枚举全部吞并位置后没有一种读法的行号列是数字区间）→ ambiguous（amb-none），不静默采用错位读法');
  const a5 = rc(['#', '变异名', '改的源文件', '锚点字面量', '流程标签'], '| 1 | m | rules.js | a || b || c | KEEP |');
  check(a5.ambiguous === false && a5.cells.length === 5 && a5.cells[3] === 'a||b||c' && a5.cells[4] === 'KEEP' && a5.cells[2] === 'rules.js', 'H2：锚点列是最后一列（变异表的流程标签）、多余单元格多于 1 个：裸 | 只可能在锚点列之前 → 右读，标签读 KEEP，不歧义');
  const a6 = rc(['#', '变异名', '改的源文件', '锚点字面量', '流程标签'], '| 1 | m | x | rules.js | a || b | KEEP |');
  check(a6.ambiguous === false && a6.how === 'same' && a6.cells[1] === 'm|x' && a6.cells[2] === 'rules.js' && a6.cells[3] === 'a||b' && a6.cells[4] === 'KEEP', '76 H2：锚点列是最后一列，裸 | 在「改的源文件」之前（`m | x` 是变异名）：枚举全部吞并位置，文件列必须是文件名 → 只有「变异名 m|x、文件 rules.js」一类读法成立、分派键相同 → 不歧义（旧版右读后文件列不像文件名就一律歧义）');
  // 76 HIGH-2 原话反例：编号 / 文件都读错、旧的左右两读法同时错且标签键相同 → 旧版返回 same
  const h2a = rc(['#', '变异名', '改的源文件', '锚点字面量', '流程标签'], '| 1 | 编号甲 | packages.js | attachments.js | lit | KEEP |');
  check(h2a.ambiguous === true && /改的源文件/.test(h2a.ambReason) && h2a.candText.includes('attachments.js') && h2a.candText.includes('packages.js') && h2a.cells[2] !== undefined, '76 H2 原话反例：`| 1 | 编号甲 | packages.js | attachments.js | lit | KEEP |` 可表示变异名「编号甲 | packages.js」、目标文件 attachments.js——旧的左 / 右两读法都把编号读成「编号甲」、文件读成 packages.js，标签键相同，返回 same；现在枚举全部吞并位置：文件名约束后仍有「目标文件 attachments.js」与「packages.js」两种成立读法且编号 / 文件不同 → ambiguous');
  check(mergeReadings(['a', 'b', 'c', 'd'], 3).length === 3 && mergeReadings(['a', 'b', 'c', 'd'], 2).length === 3 && mergeReadings(['a', 'b', 'c'], 3).length === 1 && mergeReadings(['a', 'b', 'c', 'd'], 3).map((r) => r.cells.join('~')).join() === 'a|b~c~d,a~b|c~d,a~b~c|d', '76 H2：mergeReadings 枚举「在 m-1 个相邻缝里合上 k 个」的全部读法（4 格并成 3 列 = 3 种，并成 2 列 = 3 种）');
  const a7 = rc(['#', '变异名', '改的源文件', '锚点字面量', '流程标签'], '| 1 | m | rules.js | a | KEEP | b |');
  check(a7.ambiguous === true && /最后一格读不出标签|标签单元格里可能也有/.test(a7.ambReason), 'H2：锚点列是最后一列，最后一格读不出标签、但前面的片段里有标签词 → ambiguous（标签文字自己可能被切开）');
  const a8 = rc(['#', '变异名', '改的源文件', '锚点字面量', '流程标签'], '| 1 | m | rules.js | a | HIS | KEEP |');
  check(a8.ambiguous === true && /标签单元格里可能也有/.test(a8.ambReason) && a8.cells[4] === 'KEEP', 'M2 回归：标签列是最后一列、真标签是「HIS | KEEP」（标签文字自己带 |）：只取最后一格读 KEEP、整段读 HIS+KEEP，两者不同 → ambiguous（若把这条判断改成 if (false)，本条会红）');
  check(rc(['a', 'b'], '| 1 | 2 | 3 |').ambiguous === false && rc(['a', 'b'], '| 1 | 2 | 3 |').cells.join('~') === '1~2|3', '读行：没有锚点列的表，多余单元格并回最后一列，不歧义');
  check(rc(H5, '| `a|b` | 1 | x | KEEP | y |').cells.length === 5 && rc(H5, '| `a|b` | 1 | x | KEEP | y |').ambiguous === false, '读行：反引号代码里的 | 先按代码消化，不产生多余单元格');
  // 解析表
  const doc = [
    '# 总', '', '## 1. aa.js', '', '### 1.1 小', '', '| 符号 | 行号 | 标签 |', '|---|---|---|', '| x | 1 | KEEP |', '  | y | 2 | KEEP |', '| - | - | - |', '',
    '## 2. 章节二（没有文件名）', '', '| 符号 | 行号 | 标签 |', '|---|---|---|', '| z | 3 | KEEP |', '',
    '## 3. 带续行 bb.js', '', '| 符号 | 行号 | 说明 | 标签 |', '|---|---|---|---|', '| w | 4 | 断行 {', '  | KEEP |', '| v | 5 | ok | HIS |', '',
  ].join('\n');
  const ts = parseTables(doc);
  check(ts.length === 3 && ts[0].file === 'aa.js' && ts[0].heading === '1.1 小' && ts[0].headingPath.join('/') === '总/1. aa.js/1.1 小', 'M5：标题层级：「### 1.1」沿用上级「## 1. aa.js」，headingPath 带全部上级标题');
  check(ts[1].file === '' && ts[2].file === 'bb.js', 'M5：不跨同级章节沿用：「## 2.」没有文件名 → 文件为空（不沿用「## 1. aa.js」）');
  check(ts[0].rows.length === 3 && ts[0].rows[1].cells[0] === 'y' && ts[0].rows[2].cells.join() === '-,-,-', 'M1：行首缩进 2 个空格的表格行也解析；表体里只含 - 的占位行是数据行（不当分隔行丢掉）');
  check(ts[2].rows.length === 2 && ts[2].rows[0].cells.length === 4 && ts[2].rows[0].cells[3] === 'KEEP' && ts[2].rows[0].endLine === ts[2].rows[0].line + 1, 'M1：缩进的 | 行接在没凑够单元格的行后面 → 断行的续行（并进上一行），不是新行');
  const au = auditPipeLines(doc, ts);
  check(au.uncovered.length === 0 && au.parsedEmpty === false && au.contPipe === 1, 'M1：审计与解析同一口径：缩进行、占位行、续行都算已覆盖，没有落不到的行；以 | 开头的续行单独计数（contPipe = 1）');
  const onlyFilter = parseTables('# x.js\n\n## 目标在 pkg.js\n\n| a | b |\n|---|---|\n| 1 | 2 |\n', { fileFilter: (n) => /^x/.test(n) });
  check(onlyFilter[0].file === 'x.js', 'M5：fileFilter 限定哪些文件名算数：标题里的目标文件 pkg.js 不当表所在文件，取上级的 x.js');
  const multi = parseTables('## 2.9 a.js（449 行）与 b.js（222 行）\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n| x | y |\n|---|---|\n| 3 | 4 |\n\n| x | y |\n|---|---|\n| 5 | 6 |\n\n### 子节\n\n| x | y |\n|---|---|\n| 7 | 8 |\n');
  check(multi.map((t) => t.file).join() === 'a.js,b.js,b.js,a.js', 'L2：标题里有两个文件名：该标题下第 1 张表取第一个、第 2 张起取第二个；下级标题里的表沿用上级标题的第一个文件名');
  const bad1 = parseTables('| a | b |\n|---|---|---|\n| 1 | 2 |\n');
  check(bad1.length === 0 && auditPipeLines('| a | b |\n|---|---|---|\n| 1 | 2 |\n', bad1).uncovered.length === 3 && auditPipeLines('| a | b |\n|---|---|---|\n| 1 | 2 |\n', bad1).parsedEmpty === true, 'M1：表头与分隔行格数对不上不算表；原文有 | 行却一张表都没解析出来 → parsedEmpty，三行都落不到表');
  const two = parseTables('| a | b |\n|---|---|\n| 1 | 2 |\n| c | d |\n|---|---|\n| 3 | 4 |\n');
  check(two.length === 2 && two[0].rows.length === 1 && two[1].rows.length === 1 && two[1].header.join() === 'c,d', '表体里「下一行是分隔行（≥3 个 -、格数相同）」的行是另一张表的表头：本表到此为止');
  // 74 HIGH-2：缩进的 | 行接在欠宽行后面、自己能独立成行 → 不并入，保留两条物理行，边界待裁定
  const bd = parseTables('| a | b | c |\n|---|---|---|\n| 1 | KEEP\n  | 2 | x | HIS |\n| 3 | y | z |\n');
  check(bd.length === 1 && bd[0].rows.length === 3 && bd[0].rows[0].line === 3 && bd[0].rows[0].endLine === 3 && bd[0].rows[1].line === 4 && bd[0].rows[0].ambiguous === true && bd[0].rows[1].ambiguous === true && /边界待裁定/.test(bd[0].rows[1].ambReason) && bd[0].rows[1].cells.join() === '2,x,HIS' && bd[0].rows[2].ambiguous === false, '74 H2 原话反例：一条断在 KEEP 的欠宽行后面紧跟缩进两格、带独立序号与 HIS 的完整行 → 不并入（旧版把后者吞成续行），两条物理行各留各的位置，两条都标 ambiguous（边界待裁定）');
  const bdAudit = auditPipeLines('| a | b | c |\n|---|---|---|\n| 1 | KEEP\n  | 2 | x | HIS |\n', parseTables('| a | b | c |\n|---|---|---|\n| 1 | KEEP\n  | 2 | x | HIS |\n'));
  check(bdAudit.uncovered.length === 0 && bdAudit.contPipe === 0, '74 H2：拆成两条物理行后审计仍全覆盖，且不再算「以 | 开头的续行」（contPipe = 0）');
  const bd2 = parseTables('| a | b | c |\n|---|---|---|\n| 1 | KEEP\n\n后面是别的文字\n');
  check(bd2[0].rows.length === 1 && bd2[0].rows[0].cells.length === 2 && bd2[0].rows[0].ambiguous === true && /仍欠宽/.test(bd2[0].rows[0].ambReason) && /第 3–5 行/.test(bd2[0].rows[0].ambReason), '74 H2：合并到表尾仍欠宽的记录标 ambiguous，ambReason 带原文行号范围');
  const bd3 = parseTables('| a | b | c |\n|---|---|---|\n| 1 | 断行 {\n  续 | KEEP |\n');
  check(bd3[0].rows.length === 1 && bd3[0].rows[0].cells.length === 3 && bd3[0].rows[0].endLine === 4 && bd3[0].rows[0].ambiguous === false, '74 H2：自己也欠宽的缩进 | 行 / 非 | 开头的行仍是断行的续行，并进上一行，合并后凑够单元格 → 不歧义');
  // 76 HIGH-3：欠宽的缩进竖线行若自己能作为独立记录开头（按表型起始字段：用例名 + 合法行号 / 序号 + 编号），不并入上一行
  const cH = ['| 用例 | 行号 | 被测 | 搭数据 | 说明 |', '|---|---|---|---|---|'];
  const h3a = parseTables([...cH, '| 前条 | 20 | KEEP', '  | 次条 | 30 |', ''].join('\n'));
  check(h3a[0].rows.length === 2 && h3a[0].rows[0].line === 3 && h3a[0].rows[1].line === 4 && h3a[0].rows[0].ambiguous === true && h3a[0].rows[1].ambiguous === true && /边界待裁定/.test(h3a[0].rows[1].ambReason) && h3a[0].rows[1].cells.join() === '次条,30', '76 H3 反例（两条欠宽行恰好拼满）：`| 前条 | 20 | KEEP`（3 格）+ 缩进 `  | 次条 | 30 |`（2 格，以「名称 + 合法行号」开头）——旧版把后者并进前者，合并后恰好五格 `前条、20、KEEP、次条、30`，欠宽检查通过、「次条」整条消失；现在两条物理行各留各的位置，都标 ambiguous（边界待裁定）');
  const h3b = parseTables([...cH, '| 甲 | 5 | KEEP', '  | HIS | 说明 |', ''].join('\n'));
  check(h3b[0].rows.length === 1 && h3b[0].rows[0].cells.join() === '甲,5,KEEP,HIS,说明' && h3b[0].rows[0].ambiguous === false && h3b[0].rows[0].endLine === 4, '76 H3 回归（真正的缩进续行）：缩进 `  | HIS | 说明 |` 第二格不是合法行号、不以起始字段开头 → 仍是上一行的续行，并回后恰好凑够五格，不歧义');
  const h3c = parseTables(['| # | 变异名 | 流程标签 |', '|---|---|---|', '| 1 | 前条', '  | 2 | 次条', ''].join('\n'));
  check(h3c[0].rows.length === 2 && h3c[0].rows[1].cells.join() === '2,次条' && h3c[0].rows[1].ambiguous === true && startsRecord(['#', '变异名', '流程标签'], ['2', '次条']) === true && startsRecord(['#', '变异名', '流程标签'], ['KEEP']) === false, '76 H3：序号列表型：缩进行以「数字序号 + 非空名称」开头 → 独立记录开头，不并入');
  // 76 MEDIUM-1：顶层围栏只认 0–3 空格缩进；成对的深缩进标记夹着顶层表 → 表照常解析，并把位置报给生成器
  const deepDoc = '    ~~~\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n    ~~~\n';
  const dtb = parseTables(deepDoc);
  const dau = auditPipeLines(deepDoc, dtb);
  check(dtb.length === 1 && dau.uncovered.length === 0 && dau.unclosedFence === null && dau.deepFence.join() === '1,7' && dau.deepFenceAroundTable.length === 1 && dau.deepFenceAroundTable[0].open === 1 && dau.deepFenceAroundTable[0].close === 7 && fenceMask(deepDoc.split('\n')).mask.every((x) => x === 0), '76 M1 反例（成对深缩进标记夹独立表）：两个缩进四格的 `~~~` 夹一张顶层取证表——旧版任意缩进都当围栏，整张表被遮、审计同遮、围栏成对也没有未闭合提示；现在不当围栏，表照常解析，audit 报 deepFenceAroundTable（原件位置 1–7）');
  check(auditPipeLines('    ~~~\n文字\n    ~~~\n', []).deepFenceAroundTable.length === 0 && parseTables('   ~~~\n| a | b |\n|---|---|\n| 1 | 2 |\n   ~~~\n').length === 0 && parseTables('\t```\n| a | b |\n|---|---|\n| 1 | 2 |\n').length === 1, '76 M1：深缩进标记之间没有表 → 不报；缩进 3 空格的顶层围栏仍是围栏（遮住表）；tab 缩进不是顶层围栏');
  // 76 MEDIUM-2：登记行带物理位置（第 8 项 = 表头行号），按位置配对；期望值手写
  const dupSrc = (gap) => ['# 总', '', '## 1. a.js', '', '### 三、用例', '', '| x | y |', '|---|---|', '| 1 | 2 |', '', '### 三、用例', '', gap + '| x | y |', '|---|---|', '| 3 | 4 |', ''].join('\n');
  const pth = '总 › 1. a.js › 三、用例';
  const regPos = [['f.md', '三、用例', 'x | y', 'case', '', pth, 'a.js', 7], ['f.md', '三、用例', 'x | y', 'oth', '理由', pth, 'a.js', 13]];
  const tPos = parseTables(dupSrc(''));
  const rPos = reconcile('f.md', tPos, regPos);
  const rSwap = reconcile('f.md', [tPos[1], tPos[0]], regPos);
  check(tPos.length === 2 && tPos[0].headerLine === 7 && tPos[1].headerLine === 13 && rPos.matched.map((x) => x.entry[3]).join() === 'case,oth' && rSwap.matched.map((x) => x.table.headerLine + ':' + x.entry[3]).join() === '13:oth,7:case' && rSwap.unregistered.length === 0 && rSwap.missing.length === 0 && reconcile('f.md', [tPos[1], tPos[0]], regPos.map((e) => e.slice(0, 7))).matched.map((x) => x.entry[3]).join() === 'case,oth', '76 M2 反例（完整路径、文件、表头全相同、位置不同的双表）：手写期望登记 7 → case、13 → oth；交换传给 reconcile 的两个表对象后，按位置配对仍是 13 → oth、7 → case（旧版按「同身份第几次出现」配对，交换后角色对到另一张表，路径 / 文件字段仍全相等）；没有位置项的旧格式登记仍按出现顺序配对');
  const rShift = reconcile('f.md', parseTables(dupSrc('\n')), regPos);
  check(rShift.unregistered.length === 1 && rShift.unregistered[0].headerLine === 14 && rShift.missing.length === 1 && rShift.missing[0][7] === 13 && rShift.matched.length === 1, '76 M2：第二张表前多了一行（表头行号 13 → 14）：该表按位置对不上登记 → 多出未登记的表 + 缺表各一条（旧版按出现顺序照样配上）');
  // 74 MEDIUM：围栏按开启符的类型与长度闭合
  const fenceDoc = '````\n```\n| a | b |\n|---|---|\n| 1 | 2 |\n````\n\n| c | d |\n|---|---|\n| 3 | 4 |\n';
  const ft = parseTables(fenceDoc);
  const fa = auditPipeLines(fenceDoc, ft);
  check(ft.length === 1 && ft[0].header.join() === 'c,d' && fa.total === 2 && fa.uncovered.length === 0 && fa.unclosedFence === null, '74 M：四反引号围栏里的三反引号行不闭合它（旧版把它当闭合符，外层闭合后 c | d 表被一起跳过，解析与审计同时漏）：围栏里的 a | b 表不算表，围栏后的 c | d 表照常解析，审计全覆盖');
  const tilde = parseTables('~~~\n| a | b |\n|---|---|\n| 1 | 2 |\n~~~\n\n| c | d |\n|---|---|\n| 3 | 4 |\n');
  check(tilde.length === 1 && tilde[0].header.join() === 'c,d' && parseTables('```a```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n').length === 1, '74 M：波浪线围栏也认；行内的 ```a``` 是行内代码，不是围栏（不吞后面的表）');
  const unclosed = '```\n| a | b |\n|---|---|\n| 1 | 2 |\n';
  check(parseTables(unclosed).length === 0 && auditPipeLines(unclosed, []).unclosedFence === 1, '74 M：文件末尾围栏没闭合 → auditPipeLines 报 unclosedFence（行号 1），生成器据此判问题，不静默吞掉后面的表');
  // 74 MEDIUM：未知词按整词识别，含单字母、带数字、超长词；登记过的说明缩写才忽略
  const pl = (s) => parseLabels(s);
  check(pl('KEEP；X').unknown.join() === 'X' && pl('KEEP；FEATURE_FLAG_12').unknown.join() === 'FEATURE_FLAG_12' && pl('KEEP；S12 与表单有关').unknown.join() === 'S12' && pl('PRX；各用途限制见 PROXYABLE_PURPOSES').unknown.join() === 'PROXYABLE_PURPOSES', '74 M：未知词 = 括号之外的整词（全大写 / 数字 / 下划线、以大写字母开头），含单字母（X）、带数字（S12、FEATURE_FLAG_12）、超 10 字符的词（旧版漏掉，单靠 KEEP / PRX 就得结论）');
  check(pl('KEEP；change').unknown.length === 0 && pl('KEEP（FEATURE_FLAG_12）').unknown.length === 0 && pl('KEEP').main.join() === 'KEEP', '74 M：含小写字母的词、括号之内的词不报；已知标签照常');
  ALLOWED_NOTE_WORDS.add('OK');
  check(pl('KEEP；OK').unknown.length === 0 && pl('KEEP；NOPE').unknown.join() === 'NOPE', '74 M：ALLOWED_NOTE_WORDS 里登记过的说明缩写（测试里临时登记 OK）才被忽略，未登记的照报');
  ALLOWED_NOTE_WORDS.delete('OK');
  check(ALLOWED_NOTE_WORDS.size === 0, '74 M：内置的 ALLOWED_NOTE_WORDS 现在是空的（八份原件括号之外的 12 个这类词都是标识符 / 编号，没有说明缩写）');
  // 期望清单
  const tb = parseTables('# x.js\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n# x.js\n\n| a | b |\n|---|---|\n| 3 | 4 |\n');
  const reg = [['f.md', 'x.js', 'a | b', 'r1', ''], ['f.md', 'x.js', 'a | b', 'r2', ''], ['f.md', '不在', 'z', 'r3', '']];
  const rec = reconcile('f.md', tb, reg);
  check(rec.matched.length === 2 && rec.matched[0].entry[3] === 'r1' && rec.matched[1].entry[3] === 'r2' && rec.missing.length === 1 && rec.missing[0][3] === 'r3' && rec.unregistered.length === 0, '期望清单：身份相同的表按出现顺序对应登记行（第 0、1 张）；多登记的一行报缺表');
  const rec2 = reconcile('f.md', tb.concat(tb), reg.slice(0, 2));
  check(rec2.unregistered.length === 2, '期望清单：多出一张身份相同的表（登记只有 2 行）→ 多出未登记的表');
  // 75 MEDIUM-1 / 74 M：登记完整标题路径与所属文件，补「归属错配」自检（末级标题相同、表头相同、上级套件不同的两张表）
  const dupDoc = (second) => ['# 总', '', '## 1. a.js', '', '### 三、用例', '', '| x | y |', '|---|---|', '| 1 | 2 |', '', second, '', '### 三、用例', '', '| x | y |', '|---|---|', '| 3 | 4 |', ''].join('\n');
  const tDup = parseTables(dupDoc('## 2. b.js'));
  const regDup = tDup.map((t) => tableIdentity('f.md', t).concat(['case', '', pathOfTable(t), t.file]));
  check(tDup.length === 2 && regDup[0][5] === '总 › 1. a.js › 三、用例' && regDup[1][5] === '总 › 2. b.js › 三、用例' && regDup[1][6] === 'b.js' && regDup[0].length === 7 && reconcile('f.md', tDup, regDup).mismatched.length === 0 && reconcile('f.md', tDup, regDup).matched.length === 2, '75 M1：登记行带完整标题路径与所属文件（snapshotRegistry 同样生成 7 项）；两张末级标题和表头相同、上级套件不同的表，各自登记各自的路径 → 对得上');
  const tMis = parseTables(dupDoc('## 1.5 仍在 a.js 下的小节'));
  const recMis = reconcile('f.md', tMis, regDup);
  check(tMis.length === 2 && recMis.matched.length === 2 && recMis.unregistered.length === 0 && recMis.mismatched.length === 1 && /完整标题路径登记为/.test(recMis.mismatched[0].why) && /所属文件登记为「b\.js」，原件里解析为「a\.js」/.test(recMis.mismatched[0].why), '75 M1 / 74 M：同一张表被归到错误的上级章节（登记 2. b.js，实际落在 a.js 下）：身份（文件 + 末级标题 + 表头）一样、旧版查不出，现在路径与所属文件都对不上 → mismatched');
  check(reconcile('f.md', tDup, regDup.map((e) => e.slice(0, 5))).mismatched.length === 0, '登记行没有路径 / 所属文件两项（旧格式）→ 不核（自检里的临时登记用；内置登记由两个生成器的自检断言每行 7 项）');
  console.log(`\n${ok}/${total} 通过`);
  return ok === total ? 0 : 1;
}
if (require.main === module) {
  if (process.argv.includes('--self-test')) process.exitCode = selfTest();
  else { console.error('用法：node inv-parse.js --self-test（本文件是两个生成器共用的解析器，不单独运行）'); process.exitCode = 2; }
}

module.exports = { startsRecord, mergeReadings, typeValid, dispatchKey, KNOWN_LABELS, ALLOWED_NOTE_WORDS, EVIDENCE_SHA256, DELETION_LIST_NAME, DELETION_LIST_SHA256, FILE_RE, SEP_RE, readText, sha256, sha12, splitRow, splitRowCode, normHeader, parseTables, parseLabels, anchorCol, lineColOf, labelSig, labelKeyOf, readCells, auditPipeLines, fenceInfo, fenceMask, mutationTable, isPipeLine, isSepRow, tableIdentity, pathOfTable, reconcile, snapshotRegistry, shortTable, shortEntry };
