// 静态守卫：项目管理（系统建设记录）模块 routes/sysbuild/ 的写法约束
//   方案：docs/local/系统建设记录/系统建设记录_平台集成_方案_20261027_v1.1.md §12（verify-sysbuild-static.js 行）、
//         §6.1「只追加」、§10.2（R 系列：`.close(` 与 processExit 位置）。
//   派单：docs/local/系统建设记录/送审准备/C1c2_静态守卫与FAMILY登记_派单_20261028.md
//
// 用法：node scripts/verify-sysbuild-static.js                    扫描真实 routes/sysbuild/
//       node scripts/verify-sysbuild-static.js --root <目录>      扫描指定目录（变异自检用）
//       node scripts/verify-sysbuild-static.js --self-test        未变异基线 + 分类器自检 + 正例 + 逐条变异
//
// ── 威胁模型 ───────────────────────────────────────────────────────────────────────────
//   只证明「诚实实现写错会判红」：漏写条件、顺手加了 UPDATE 某列、误用共享连接、在别处 close 连接、
//   自己开事务。**不防**刻意绕过：运行时拼接 SQL（变量 / 非字面量拼接）、反射 / 计算成员调用
//   （`q[name](`）、eval、把 q 赋给别名再调用——这类由代码审查负责，登记为残余。
//   其余残余：S1/S2 只看字符串字面量（模板字符串、可静态折叠的 '+' 拼接）里的 UPDATE；
//   S5 对「变量绑定到正则」的识别只看同文件内 `const X = /re/` 或 `new RegExp(` 的变量名，不分作用域；
//   动态 `import()` 引入 sqlite 驱动不在 S4 扫描面内（脚本模式下 acorn 把它当 ImportExpression，未识别）；
//   `INSERT … ON CONFLICT DO NOTHING` 允许，`DO UPDATE` 一律禁用（不解析其 SET）。
//   扫描面 = routes/sysbuild/ 下全部 .js（fs.readdirSync 现取，含子目录；新增文件自动纳入）。
//   源码先把 CRLF 换成 LF（线 worktree 是 CRLF，主工作区常是 LF）。词法不靠正则扫源码，
//   用 acorn 解析成 AST（仓库已有依赖，acorn 8.15.0；没有装包）——注释里的关键词不会误报。
//
// ── 规则（编号即失败行里的 [Sx]）─────────────────────────────────────────────────────────
//   S0 扫描面前提：每个文件能解析；db.js、schema.js 存在；schema 导出 UPDATABLE_COLUMNS / CONDITIONAL_UPDATES。
//      R-2 硬门（codex 13 号）：CONDITIONAL_UPDATES 每张表的每个登记片段必须是非空字符串，且按 whereHasConjunct 同样的方式
//      归一（`\s+` 折叠 + trim + `=` 两侧补空格）后恰好匹配 WHERE_ITEM_RES 的某一项——含 AND 的片段、字面量含空白或 `=` 的片段登记时即判红。
//      预筛 LOW-1 再收紧：整表登记值必须是非 null、非数组的对象；表名必须是 UPDATABLE_COLUMNS 的键；列名必须在该表登记列内。
//   S1 只追加：每条 UPDATE 的表在 schema.UPDATABLE_COLUMNS，SET 的每一列在该表登记列内（schema.js 不扫）。
//      UPDATE 目标表或 SET 列不是静态标识符（含 ${...} 占位）也判红——守卫无法确认。
//      兜底（M1）：不分大小写匹配 `\bUPDATE\b[\s\S]{0,80}?\bSET\b`，凡命中而上面的句式解析不了的一律判 S1
//      「UPDATE 句式无法解析」（如 `update t set(a) = (?)`、大写 `'UPDATE t SET' + c`）；
//      不含 SET 的英文提示（`please update the record`）不误伤。
//   S2 条件更新：SET 含 schema.CONDITIONAL_UPDATES 登记列的 UPDATE，其 WHERE 必须是「白名单文法」的简单 AND 链（12-R M1 硬门）：
//      以引号外的 AND 连接若干项，每项只能是 `<标识符> = ?`、`<标识符> IS NULL`、`<标识符> IS NOT NULL`、
//      `<标识符> = '<字面量>'`（字面量不含引号、不含任何空白与 `=`，L-1 硬门）、`<标识符> = <整数>`，且登记的条件片段恰为其中一项。
//      L-1（codex 13 号）：比较前的 `\s+` 折叠与 `=` 两侧补空格作用于整个 WHERE（含引号内），所以引号内的空白与 `=` 会被归一化改写——
//      `kind = 'a=b'` 与 `kind = 'a = b'`、`'a  b'` 与 `'a b'` 归一后相同会被误判相等。用硬门收口：字面量项里禁掉空白与 `=`，
//      归一化就只会碰到引号外的字符，不需要区分引号内外（不做「只归一引号外」的智能处理）。S0 同时校验登记片段本身的形态（R-2）。
//      CASE / BETWEEN / OR / 括号（含 IN (…)）/ 函数调用 / 子查询 / 模板插值一律判 S2——
//      理由：片段「出现在 WHERE 深度 0」不等于它属于最外层合取链（`CASE WHEN 0 THEN 1 AND joined_at IS NULL AND 1 ELSE 1 END`、
//      `id BETWEEN 0 AND joined_at IS NULL AND 1 = 1` 都能骗过逐项判断），与其逐个追加特例，不如把文法收到只剩简单 AND 链。
//      本文法替代了第二、三批的「深度 0 / 顶层 OR / 顶层插值 / 引号对齐 / AND 运算符」逐项判断（二选一取白名单，那些情形全被覆盖）；
//      代价：条件更新的 WHERE 里不能再写 `IN (${…})` 之类，需要时改成多条语句或另议。
//   S3 无 DELETE / 无整行替换：M1 追加——不分大小写判红 `\bREPLACE\s+INTO\b`、`\bINSERT\s+OR\s+REPLACE\b`、
//      `\bDO\s+UPDATE\b`（upsert 一律禁用：它们都能在 UPDATE 白名单之外整行改写已有行）。
//      任何字符串里的 `DELETE FROM` 都判红（比派单的 `DELETE FROM sysbuild_` 宽：派单唯一例外的
//      `DELETE FROM ${TXN_MARK_TABLE}` 本身就不含 sysbuild_ 字样）；唯一例外 = db.js 里整串恰为
//      `DELETE FROM ${TXN_MARK_TABLE} WHERE seq = ?` 的那一条，恰好 1 条（多出或消失都判红），
//      且 db.js 里 TXN_MARK_TABLE 必须是字面量 'temp.sysbuild_txn_mark'（本连接临时表）。
//   S4 不用共享连接：不出现标识符 / 字符串 dbRunAsync、dbGetAsync、dbAllAsync；除 db.js 外不得 require 'sqlite3' /
//      'better-sqlite3' / 'node:sqlite'（含子路径）；任何文件不得 `module.require(`（绕过 require 名单的另一个入口）。
//   S5 SQL 只经 q 助手（db.js、schema.js 除外）：调用者口径——
//        · `.run(` / `.all(` / `.exec(` / `.prepare(` / `.each(` 的接收者必须是标识符 q；
//        · `.get(` 的接收者必须是标识符 q，或标识符 router 且首个实参是以 '/' 开头的路径字符串（express 路由）；
//        · 豁免：接收者是正则字面量（/re/.exec(s)），或同文件里 `const X = /re/` / `new RegExp(` 绑定的变量
//          （RE.exec(s)）——那是正则匹配，不是 SQL；
//        · 其余接收者（conn / db / this.db / 调用结果 / req / Map …）一律判红。明确举例：`Promise.all(`、`Map.get(`、
//          `req.get(` 都会判红——Promise.all 虽与 SQL 无关，`.all(` 与 sqlite3 的 all 同名，守卫看不出语义。
//          理由：加硬门不加智能放行，每多一条放行逻辑就多一个攻击面；遇到时改写法（如 for 循环里逐个 await、
//          `req.headers[...]`），或由主会话决定是否改规则，不在守卫里做「聪明放行」。
//        `.each(` 是在派单清单之外追加的（sqlite3 的逐行回调接口，同属绕过 q 的入口）。
//   S6 关闭与退出：`.close(` 只出现在 db.js 的 closeFaultedConnOnce 与 closeUnpublished 两个函数体内（两个函数
//      必须都在）；`processExit(` 调用只在 closeFaultedConnOnce 内。另追加：`process.exit(` 只允许出现在 db.js 里
//      `const processExit = …` 默认值的初始化表达式内（那一行是派单写明的例外，process.exit 其他位置同样绕过受控退出）。
//   S7 不自控事务：除 db.js 外，任何字符串（字面量 / 模板 / 可折叠拼接）跳过前导空白、分号、注释后不得以
//      BEGIN / COMMIT / END / ROLLBACK / SAVEPOINT / RELEASE 开头（不分大小写，要求词边界）。与 db.js 的运行时检查互为两道防线。
//      END 的唯一豁免（12 号审 M2 收窄）：字符串全文恰为小写 `end`（不 trim、不带分号）——attachments.js hashFile 的
//      stream 事件名 `s.on('end', …)` 与它同形，围栏不允许改那一行；`end;`、`eNd`、` end`、`END`、`end transaction` 一律判红。
//      M2 硬门：本守卫的关键字集合必须与 db.js 的 TXN_CONTROL_KEYWORDS 全等——从 db.js AST 里取该 Set 构造参数
//      数组的字面量元素（不 require db.js）；取不到或不全等都判红，防两边悄悄分叉。
//   S8 schema.js 只含 DDL（L4 硬门）：schema.js 里不得有 `.run( / .all( / .get( / .exec( / .prepare( / .each(` 调用，
//      不得有含 UPDATE…SET / DELETE / REPLACE INTO / INSERT 的字符串（CREATE TABLE / CREATE INDEX 的 DDL 串允许）。
//   S9 SQL 字符串不得含注释（H1，12 号审硬门）：任何静态字符串 / 模板静态片段里出现 `/*` 或 `--` 即判红。
//      理由：SQL 注释会让本守卫所有词法扫描失去可靠性（`DELETE /*说明*/ FROM …` 漏 S3；SET 里夹一段含 WHERE 的注释让 SET 扫描
//      提前结束漏 S1）。选硬门而不是教 scanSql 识别注释（加硬门不加智能放行）；sysbuild 的 SQL 不需要注释，说明写在 JS 注释里。
//      唯一例外：db.js 里全文恰为 '--' 与 '/*' 的两个字面量（isTxnControlSql 跳过注释用），各恰 1 处，多出或消失都判红。
//      误伤（含 `--` 的普通提示串）接受——改写措辞即可。schema.js 一并适用。
//   H2（12 号审）：可折叠的拼接 / 模板收集静态串后仍遍历全部子树（含 ${} 插值里的调用与字符串）。
//   S10 前端：Sys_Build.html 与 sysbuild-*.js 的直接 HTML 注入 / 动态代码出口由 lib/sysbuild-frontend-static.js 扫描。
//     硬门含任意对象 write / writeln、成员 eval / Function、字符串计时器、非字面量计算属性写入、HTML Blob 与注入方法 call / apply；每类均有正反例。
//       只管本模块直接 DOM 写法，不做污点分析，不证明共享 app.js 或反射调用安全。
//
// ── 自检 --self-test ───────────────────────────────────────────────────────────────────
//   ① 真实 routes/sysbuild/ 基线必须全绿；② 分类器自检：追加非法 JavaScript 的守卫副本必须判「异常」而不是检出；
//   ③ 正例：合规写法（含 S5 豁免、S2 合规条件、含 COMMIT 字样的中文提示）必须全绿，证明规则没有过严；
//   ④ 变异：把 routes/sysbuild/ 复制到私有临时目录，逐条注入违规，守卫以 --root 运行，只认「退出码 1 且输出含
//      该规则编号失败行（FAIL [Sx]）」为检出。汇总行格式 `N/M 通过`。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const acorn = require('acorn');
const frontendStatic = require('./lib/sysbuild-frontend-static');

const argv = process.argv.slice(2);
const SELF_TEST = argv.includes('--self-test');
const DEFAULT_ROOT = path.join(__dirname, '..', 'routes', 'sysbuild');
const rootIdx = argv.indexOf('--root');
if (rootIdx >= 0 && (!argv[rootIdx + 1] || argv[rootIdx + 1].startsWith('--'))) {
  console.error('用法错误：--root 需要一个目录参数');
  process.exit(2);
}
const ROOT = rootIdx >= 0 ? path.resolve(argv[rootIdx + 1]) : DEFAULT_ROOT;

const RULES = [
  ['S0', '扫描面前提（可解析 / db.js 与 schema.js 在 / schema 导出 / 条件片段登记形态）'],
  ['S1', 'UPDATE 只写 UPDATABLE_COLUMNS 登记的表与列'],
  ['S2', '条件更新列的 UPDATE 带登记的 WHERE 条件片段'],
  ['S3', '无 DELETE / REPLACE INTO / INSERT OR REPLACE / DO UPDATE（唯一例外：db.js 删本连接临时表标记行）'],
  ['S4', '不用共享连接（dbXxxAsync / 非 db.js require sqlite 驱动 / module.require）'],
  ['S5', 'SQL 只经 q 助手（接收者白名单）'],
  ['S6', '.close( / processExit( / process.exit( 位置'],
  ['S7', '非 db.js 的字符串不得以事务控制关键字开头（关键字集合与 db.js 全等）'],
  ['S8', 'schema.js 只含 DDL'],
  ['S9', 'SQL 字符串不得含注释（/* 与 --）'],
  ['S10', '本模块前端采用 DOM / textContent，不直接写可执行 HTML 或动态代码'],
];

// ── 文件清单与解析 ─────────────────────────────────────────────────────────────────────
function listJsFiles(root) {
  const out = [];
  (function rec(dir, rel) {
    const ents = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of ents) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) rec(path.join(dir, ent.name), r);
      else if (ent.isFile() && ent.name.endsWith('.js')) out.push(r);
    }
  }(root, ''));
  return out;
}

const PH = '\u0001'; // 模板字符串里 ${...} 在「视图文本」中的占位（单字符，下标与 SQL 扫描一致）

// 静态字符串：返回 { t, v }；t = 带 ${源码} 的文本（S3 白名单精确比较用），v = 带 PH 占位的文本（SQL 扫描用）。
function staticText(node, src) {
  if (node.type === 'Literal') return typeof node.value === 'string' ? { t: node.value, v: node.value } : null;
  if (node.type === 'TemplateLiteral') {
    let t = '';
    let v = '';
    node.quasis.forEach((q, i) => {
      const piece = q.value.cooked !== null && q.value.cooked !== undefined ? q.value.cooked : q.value.raw;
      t += piece;
      v += piece;
      if (i < node.expressions.length) {
        const e = node.expressions[i];
        t += `\${${src.slice(e.start, e.end)}}`;
        v += PH;
      }
    });
    return { t, v };
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const l = staticText(node.left, src);
    if (!l) return null;
    const r = staticText(node.right, src);
    return r ? { t: l.t + r.t, v: l.v + r.v } : null;
  }
  return null;
}

// 把一个已整体收集的静态字符串节点及其折叠成员（Binary '+' 的两侧、嵌套 Binary）标记为 folded；模板的插值表达式不标记。
function markFolded(node, folded) {
  folded.add(node);
  if (node.type === 'BinaryExpression') { markFolded(node.left, folded); markFolded(node.right, folded); }
}

function walk(node, visit) {
  if (visit(node) === false) return;
  for (const key of Object.keys(node)) {
    if (key === 'loc') continue;
    const val = node[key];
    if (Array.isArray(val)) {
      for (const c of val) if (c && typeof c.type === 'string') walk(c, visit);
    } else if (val && typeof val.type === 'string') {
      walk(val, visit);
    }
  }
}

// 解析一个文件，返回后续规则要用的信息；解析失败返回 { error }。
function parseFile(root, rel) {
  const src = fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
  let ast;
  try {
    ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true, locations: true });
  } catch (e) {
    return { rel, error: e.message, line: e.loc ? e.loc.line : 1 };
  }
  const info = { rel, src, strings: [], calls: [], idents: [], fns: [], decls: [], regexNames: new Set() };
  const folded = new Set();
  walk(ast, (node) => {
    switch (node.type) {
      case 'Identifier':
        info.idents.push({ name: node.name, line: node.loc.start.line });
        break;
      case 'CallExpression':
        info.calls.push(node);
        break;
      case 'FunctionDeclaration':
        info.fns.push(node);
        break;
      case 'VariableDeclarator':
        info.decls.push(node);
        if (node.id.type === 'Identifier' && node.init) {
          const init = node.init;
          if ((init.type === 'Literal' && init.regex) || (init.type === 'NewExpression' && init.callee.type === 'Identifier' && init.callee.name === 'RegExp')) {
            info.regexNames.add(node.id.name);
          }
        }
        break;
      default:
        break;
    }
    if (node.type === 'Literal' || node.type === 'TemplateLiteral' || (node.type === 'BinaryExpression' && node.operator === '+')) {
      // H2（12 号审）：可折叠的拼接 / 模板整体只收集一次，但**子树照常遍历**——模板的 ${} 插值表达式里还有调用和别的字符串。
      //   已被整体收集的成员节点（folded）不再各自重复收集静态片段，其余节点（含插值里的）一律照常处理。
      //   本函数里不再有「收集后跳过子树」的分支（Literal 没有子树；原来对折叠 Binary 的 return false 就是 H2 的漏洞）。
      //   H2 的删分支证据（tmp/branch_check.js 的 H2 处理）是「重新引入整体收集后 return false 的退化」——把下面 BRANCH-H2 行改回
      //   `markFolded(node, folded); if (node.type !== 'TemplateLiteral') return false;` → H2 两条变异出现未判红；
      //   不是「删除一行」。单独删掉 markFolded 只会让成员节点被重复收集，不影响检出（只多报重复的失败行）。
      if (!folded.has(node)) {
        const st = staticText(node, src);
        if (st) {
          info.strings.push({ t: st.t, v: st.v, line: node.loc.start.line });
          markFolded(node, folded); // BRANCH-H2
        }
      }
    }
    return true;
  });
  return info;
}

// ── SQL 文本扫描（引号与括号层级）──────────────────────────────────────────────────────────
const QUOTE_CLOSE = { "'": "'", '"': '"', '`': '`', '[': ']' };
function scanSql(text) {
  const n = text.length;
  const depth = new Array(n).fill(0);
  const quoted = new Array(n).fill(false);
  let d = 0;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    const close = QUOTE_CLOSE[ch];
    if (close) {
      let j = i + 1;
      for (;;) {
        if (j >= n) break;
        if (text[j] === close) {
          if (close !== ']' && text[j + 1] === close) { j += 2; continue; }
          break;
        }
        j += 1;
      }
      const end = Math.min(j, n - 1);
      for (let k = i; k <= end; k += 1) { quoted[k] = true; depth[k] = d; }
      i = end + 1;
      continue;
    }
    if (ch === '(') { depth[i] = d; d += 1; } else if (ch === ')') { d = Math.max(0, d - 1); depth[i] = d; } else { depth[i] = d; }
    i += 1;
  }
  return { depth, quoted };
}
const isWordChar = (c) => c !== undefined && /[A-Za-z0-9_]/.test(c);
// 从 from 起找第一个顶层（引号外、括号深度 0）的 ';' 或关键字 WHERE / RETURNING。
function findTopStop(text, sc, from) {
  for (let i = from; i < text.length; i += 1) {
    if (sc.quoted[i] || sc.depth[i] !== 0) continue;
    if (text[i] === ';') return { idx: i, word: ';' };
    if (isWordChar(text[i - 1])) continue;
    const m = /^(WHERE|RETURNING)\b/i.exec(text.slice(i, i + 10));
    if (m) return { idx: i, word: m[1].toUpperCase() };
  }
  return null;
}
function splitTopCommas(text, sc) {
  const items = [];
  let cur = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === ',' && !sc.quoted[i] && sc.depth[i] === 0) { items.push(text.slice(cur, i)); cur = i + 1; }
  }
  items.push(text.slice(cur));
  return items;
}
const stripIdentQuotes = (s) => s.replace(/^["`[]/, '').replace(/["`\]]$/, '');
const UPDATE_RE = /\bUPDATE\s+(?:OR\s+(?:ROLLBACK|ABORT|REPLACE|FAIL|IGNORE)\s+)?(\S+?)(?:\s+(?:AS\s+)?\w+)?\s+SET\s/gi;

// 解析字符串视图里的全部 UPDATE，返回 [{ idx, table, cols, where, problems }]。
function analyseUpdates(v) {
  const out = [];
  const covered = [];
  for (const m of v.matchAll(UPDATE_RE)) {
    covered.push([m.index, m.index + 6]);
    const table = stripIdentQuotes(m[1]);
    const problems = [];
    const rest = v.slice(m.index + m[0].length);
    const sc = scanSql(rest);
    const stop = findTopStop(rest, sc, 0);
    const setEnd = stop ? stop.idx : rest.length;
    const cols = [];
    for (const item of splitTopCommas(rest.slice(0, setEnd), sc)) {
      const it = item.trim();
      const cm = /^("[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(it);
      if (cm) cols.push(stripIdentQuotes(cm[1]));
      else problems.push(`SET 项无法静态解析列名: ${it.slice(0, 40).replace(/\u0001/g, '${…}')}`); // BRANCH-B
    }
    let where = null;
    if (stop && stop.word === 'WHERE') {
      const part = rest.slice(stop.idx + 5);
      const sc2 = scanSql(part);
      const stop2 = findTopStop(part, sc2, 0);
      where = part.slice(0, stop2 ? stop2.idx : part.length);
    }
    out.push({ idx: m.index, table, cols, where, problems });
  }
  // 兜底（M1）：不分大小写的 `UPDATE … SET`（间隔 80 字符内），凡命中而上面的完整句式没覆盖的，写法无法解析 ⇒ 判红。
  //   不含 SET 的英文提示（please update the record）不命中。
  for (const m of v.matchAll(/\bUPDATE\b[\s\S]{0,80}?\bSET\b/gi)) {
    if (!covered.some(([a, b]) => m.index >= a && m.index < b)) out.push({ idx: m.index, table: null, cols: [], where: null, problems: [`UPDATE 句式无法解析: ${v.slice(m.index, m.index + 40).replace(/\u0001/g, '${…}')}`] }); // BRANCH-A
  }
  return out;
}

// 条件更新的 WHERE 白名单文法（12-R M1）。WHERE（引号外）必须能切成以顶层 AND 连接的若干项，每一项都是下列简单形态之一，
//   且登记的条件片段恰为其中一项。CASE / BETWEEN / OR / 括号 / 函数调用 / 子查询 / 模板插值 / 引号外的任何别的写法都不在文法里，
//   一律判红——不再逐个追加特例（12 号审的引号伪造、12-R 的 CASE 与 BETWEEN 吞 AND 都是同一类：深度 0 ≠ 属于最外层合取链）。
//   本文法替代了第二、三批的「深度 0 / 顶层 OR / 插值 / 引号对齐 / AND 运算符」逐项判断（二选一取白名单：白名单把那些情形全部覆盖，
//   且判定面更小）。
//   字面量项（第四项）不允许任何空白与 `=`（L-1）：比较前的归一化（`\s+` 折叠、`=` 两侧补空格）对整个 WHERE 生效，只有在
//   引号外才是安全的；字面量里禁掉会被归一化改写的字符，就不必区分引号内外。`[^'"\u0001\s=]` 里 `\s` 含 Unicode 空白。
//   字符类里的 `=` 在当前归一顺序（normEq 先把 `=` 补成 ` = `）下是冗余防线：补出来的空格已经让含 `=` 的字面量匹配不上字符类，
//   只禁空白就能拒掉含 `=` 的字面量，所以 `=` 这一项无法独立变异（去掉它任何用例都不会变红）；保留它是为了归一顺序将来变动时不放宽。
const SQL_IDENT = '[A-Za-z_][A-Za-z0-9_]*';
const WHERE_ITEM_RES = [
  new RegExp(`^${SQL_IDENT} = \\?$`),
  new RegExp(`^${SQL_IDENT} IS NULL$`, 'i'),
  new RegExp(`^${SQL_IDENT} IS NOT NULL$`, 'i'),
  new RegExp(`^${SQL_IDENT} = '[^'"\\u0001\\s=]*'$`),
  new RegExp(`^${SQL_IDENT} = -?\\d+$`),
];
// 归一化：whereHasConjunct 与 S0 的登记片段校验共用同一套（\s+ 折叠、trim、= 两侧补空格），保证两处口径一致。
const collapseWs = (s) => s.replace(/\s+/g, ' ').trim();
const normEq = (s) => s.replace(/\s*=\s*/g, ' = ');
// S0（R-2）：登记片段是否为非空字符串且归一后恰好匹配 WHERE_ITEM_RES 的某一项。
const conditionFragmentOk = (frag) => typeof frag === 'string' && frag.trim() !== '' && WHERE_ITEM_RES.some((re) => re.test(normEq(collapseWs(frag))));
// 返回 'ok' | 'missing'（没有 WHERE 或不含片段）| 'not-simple'（WHERE 不是白名单文法的简单 AND 链，或片段不是其中一项）。
function whereHasConjunct(where, fragment) {
  if (where === null) return 'missing';
  if (typeof fragment !== 'string') return 'not-simple'; // BRANCH-WF（纵深防御：非字符串片段直接判红结果，不抛异常；S0 才是权威判定）
  const w = collapseWs(where);
  const frag = collapseWs(fragment);
  const norm = normEq;
  if (!norm(w).includes(norm(frag))) return 'missing';
  // 按引号外的 AND 切项（引号里的 AND 字样属于字面量）。
  const sc = scanSql(w);
  const items = [];
  let cur = 0;
  for (let i = 0; i < w.length; i += 1) {
    if (sc.quoted[i] || isWordChar(w[i - 1]) || !/^AND\b/i.test(w.slice(i, i + 4))) continue;
    items.push(w.slice(cur, i).trim());
    cur = i + 3;
    i += 2;
  }
  items.push(w.slice(cur).trim());
  for (const it of items.map(norm)) if (!WHERE_ITEM_RES.some((re) => re.test(it))) return 'not-simple'; // BRANCH-W
  if (!items.some((it) => norm(it) === norm(frag))) return 'not-simple'; // BRANCH-WE
  return 'ok';
}

// ── 扫描主体 ─────────────────────────────────────────────────────────────────────────────
const lineAt = (s, idx) => s.line + (s.v.slice(0, idx).match(/\n/g) || []).length;
const TXN_WHITELIST_TEXT = 'DELETE FROM ${TXN_MARK_TABLE} WHERE seq = ?';
const SQL_METHODS = new Set(['run', 'all', 'exec', 'prepare', 'each', 'get']);
// 事务控制关键字集合：必须与 db.js 的 TXN_CONTROL_KEYWORDS 全等（M2 硬门在 scan 里按 db.js AST 核对）。
const TXN_KEYWORDS = ['begin', 'commit', 'end', 'rollback', 'savepoint', 'release'];
// END 的唯一豁免（M2 收窄，12 号审）：字符串全文恰为小写 `end`（不 trim、不带分号、不变大小写）——真实代码里 stream 的 'end'
//   事件名（attachments.js hashFile 的 s.on('end', …)）与它同形，无法区分，围栏又不允许改那一行。其余一切以 end 开头的
//   写法（`end;`、`eNd`、` end`、`END`、`end transaction`）跳过前导空白 / 分号 / 注释后一律判红。
const TXN_KEYWORD_RE = new RegExp(`^(${TXN_KEYWORDS.filter((k) => k !== 'end').join('|')})\\b`, 'i');
const txnKeywordAtStart = (t) => {
  const m = TXN_KEYWORD_RE.exec(t);
  if (m) return m[1];
  if (/^end\b/i.test(t)) return 'END'; // BRANCH-M2e
  return null;
};
const UPSERT_PATTERNS = [
  [/\bREPLACE\s+INTO\b/gi, 'REPLACE INTO'],
  [/\bINSERT\s+OR\s+REPLACE\b/gi, 'INSERT OR REPLACE'],
  [/\bDO\s+UPDATE\b/gi, 'ON CONFLICT … DO UPDATE'],
];
const SQLITE_DRIVER_RE = /^(better-sqlite3|sqlite3|node:sqlite)(\/|$)/;

function memberName(callee) {
  if (callee.type !== 'MemberExpression') return null;
  if (!callee.computed && callee.property.type === 'Identifier') return callee.property.name;
  if (callee.computed && callee.property.type === 'Literal' && typeof callee.property.value === 'string') return callee.property.value;
  return null;
}
function leadingKeywordText(v) {
  let s = v;
  for (;;) {
    const t = s.replace(/^[\s;]+/, '');
    if (t.startsWith('--')) { const nl = t.indexOf('\n'); s = nl < 0 ? '' : t.slice(nl + 1); continue; }
    if (t.startsWith('/*')) { const end = t.indexOf('*/'); s = end < 0 ? '' : t.slice(end + 2); continue; }
    return t;
  }
}

function scan(root) {
  const findings = [];
  const add = (rule, file, line, msg) => findings.push({ rule, file, line, msg });
  const rels = listJsFiles(root);
  const files = [];
  for (const rel of rels) {
    const f = parseFile(root, rel);
    if (f.error) add('S0', rel, f.line, `无法解析: ${f.error}`);
    else files.push(f);
  }
  if (!rels.includes('db.js')) add('S0', '.', 0, '扫描面缺 db.js'); // BRANCH-E2
  if (!rels.includes('schema.js')) add('S0', '.', 0, '扫描面缺 schema.js');

  let schema = null;
  if (rels.includes('schema.js')) {
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      schema = require(path.join(root, 'schema.js'));
      // codex 14 号 M-1：两个导出都必须是非 null、非数组的对象（导出 [] 会让 S1/S2 静默失效）；UPDATABLE_COLUMNS 每个表值须是字符串数组。
      const isPlainObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
      if (!isPlainObj(schema.UPDATABLE_COLUMNS)) throw new Error('缺 UPDATABLE_COLUMNS（必须是非 null、非数组的对象）'); // BRANCH-E1a
      if (!isPlainObj(schema.CONDITIONAL_UPDATES)) throw new Error('缺 CONDITIONAL_UPDATES（必须是非 null、非数组的对象）'); // BRANCH-E1b
      for (const [t, cols] of Object.entries(schema.UPDATABLE_COLUMNS)) if (!Array.isArray(cols) || !cols.every((c) => typeof c === 'string')) throw new Error(`UPDATABLE_COLUMNS.${t} 必须是字符串数组`); // BRANCH-E1c
    } catch (e) {
      schema = null;
      add('S0', 'schema.js', 0, `schema 加载失败: ${e.message}`);
    }
  }
  // ── S0 硬门（R-2，codex 13 号；预筛 LOW-1 收紧）：CONDITIONAL_UPDATES 的整表值必须是非 null、非数组的对象；
  //    表名必须是 UPDATABLE_COLUMNS 的键；列名必须在该表 UPDATABLE_COLUMNS 登记列内；登记片段必须是 WHERE_ITEM_RES 里的单个简单项 ──
  //    非法片段（非字符串 / 空 / 不在文法里）记进 badFrag，S2 对它们跳过（codex 14 号 M-2：不让 whereHasConjunct 在非字符串上抛异常，S0 照常输出）。
  const badFrag = new Set();
  if (schema) {
    for (const [table, cols] of Object.entries(schema.CONDITIONAL_UPDATES)) {
      const isObj = cols !== null && typeof cols === 'object' && !Array.isArray(cols);
      if (!isObj) add('S0', 'schema.js', 0, `CONDITIONAL_UPDATES.${table} 的整表登记值必须是对象（列名 → 条件片段），实际 ${Array.isArray(cols) ? '数组' : cols === null ? 'null' : typeof cols}`); // BRANCH-S0G
      const regs = isObj ? Object.entries(cols) : [];
      const registered = schema.UPDATABLE_COLUMNS[table];
      if (!Array.isArray(registered)) add('S0', 'schema.js', 0, `CONDITIONAL_UPDATES 的表 ${table} 不在 UPDATABLE_COLUMNS`); // BRANCH-S0T
      for (const [col, frag] of regs) {
        if (Array.isArray(registered) && !registered.includes(col)) add('S0', 'schema.js', 0, `CONDITIONAL_UPDATES.${table} 的列 ${col} 不在该表 UPDATABLE_COLUMNS 登记列内（登记: ${registered.join(', ')}）`); // BRANCH-S0C
        if (!conditionFragmentOk(frag)) badFrag.add(`${table}.${col}`);
        if (!conditionFragmentOk(frag)) add('S0', 'schema.js', 0, `CONDITIONAL_UPDATES.${table}.${col} 的登记片段 ${JSON.stringify(frag)} 不是单个白名单文法项（非空字符串，形如 <标识符> = ? / IS [NOT] NULL / = '<不含空白与 = 的字面量>' / = <整数>；含 AND、空白或 = 的字面量都不行）`); // BRANCH-S0F
      }
    }
  }
  const dbFile = files.find((f) => f.rel === 'db.js');

  for (const f of files) {
    // ── S1 / S2：UPDATE（schema.js 不扫）──
    if (f.rel !== 'schema.js' && schema) {
      for (const s of f.strings) {
        for (const u of analyseUpdates(s.v)) {
          const line = lineAt(s, u.idx);
          for (const p of u.problems) add('S1', f.rel, line, p);
          if (u.table === null) continue;
          const allowed = schema.UPDATABLE_COLUMNS[u.table];
          if (!Array.isArray(allowed)) {
            add('S1', f.rel, line, `UPDATE 目标表 ${u.table.replace(/\u0001/g, '${…}')} 不在 schema.UPDATABLE_COLUMNS`);
            continue;
          }
          for (const c of u.cols) {
            if (!allowed.includes(c)) add('S1', f.rel, line, `UPDATE ${u.table} SET 的列 ${c} 不在登记列内（登记: ${allowed.join(', ')}）`);
          }
          const cond = schema.CONDITIONAL_UPDATES[u.table] || {};
          for (const c of u.cols) {
            if (!Object.prototype.hasOwnProperty.call(cond, c)) continue;
            if (badFrag.has(`${u.table}.${c}`)) continue; // BRANCH-S2S（与 BRANCH-WF 互为两层防线，成对删除自检；登记片段已在 S0 判红，S2 不重复）
            const r = whereHasConjunct(u.where, cond[c]);
            if (r === 'missing') add('S2', f.rel, line, `UPDATE ${u.table} SET ${c} 的 WHERE 缺登记条件片段 ${JSON.stringify(cond[c])}`);
            else if (r === 'not-simple') add('S2', f.rel, line, `UPDATE ${u.table} SET ${c}：条件更新的 WHERE 只允许简单 AND 链（白名单文法：<标识符> = ? / IS NULL / IS NOT NULL / = '<字面量，不含空白与 =>' / = <整数>，且恰含 ${JSON.stringify(cond[c])} 一项）: ${(u.where || '').replace(/\s+/g, ' ').trim().slice(0, 80).replace(/\u0001/g, '${…}')}`);
          }
        }
      }
    }

    // ── S3：DELETE FROM / 整行替换（schema.js 也扫）──
    for (const s of f.strings) {
      for (const m of s.v.matchAll(/\bDELETE\s+FROM\b/gi)) {
        const whole = f.rel === 'db.js' && s.t.trim() === TXN_WHITELIST_TEXT;
        if (!whole) add('S3', f.rel, lineAt(s, m.index), `出现 DELETE FROM（只允许 db.js 里的 ${TXN_WHITELIST_TEXT}）: ${s.v.slice(m.index, m.index + 50).replace(/\u0001/g, '${…}')}`);
      }
      for (const [re, label] of UPSERT_PATTERNS) {
        for (const m of s.v.matchAll(re)) add('S3', f.rel, lineAt(s, m.index), `出现 ${label}（整行替换 / upsert 一律禁用）: ${s.v.slice(m.index, m.index + 50).replace(/\u0001/g, '${…}')}`);
      }
    }

    // ── S4 ──
    for (const id of f.idents) {
      if (id.name === 'dbRunAsync' || id.name === 'dbGetAsync' || id.name === 'dbAllAsync') add('S4', f.rel, id.line, `出现共享连接助手 ${id.name}`);
    }
    for (const s of f.strings) {
      if (s.t === 'dbRunAsync' || s.t === 'dbGetAsync' || s.t === 'dbAllAsync') add('S4', f.rel, s.line, `字符串里出现共享连接助手 ${s.t}`); // BRANCH-D
    }
    for (const c of f.calls) {
      if (c.callee.type === 'MemberExpression' && c.callee.object.type === 'Identifier' && c.callee.object.name === 'module' && memberName(c.callee) === 'require') add('S4', f.rel, c.loc.start.line, '不得 module.require(（绕过 require 名单）'); // BRANCH-L3b
      if (f.rel !== 'db.js' && c.callee.type === 'Identifier' && c.callee.name === 'require' && c.arguments[0]) {
        const st = staticText(c.arguments[0], f.src);
        if (st && SQLITE_DRIVER_RE.test(st.t)) add('S4', f.rel, c.loc.start.line, `非 db.js 不得 require('${st.t}')`); // BRANCH-L3a
      }
    }

    // ── S5：调用者口径见头注释（db.js、schema.js 除外）──
    if (f.rel !== 'db.js' && f.rel !== 'schema.js') {
      for (const c of f.calls) {
        const name = memberName(c.callee);
        if (!name || !SQL_METHODS.has(name)) continue;
        const obj = c.callee.object;
        if (obj.type === 'Literal' && obj.regex) continue;
        const recv = obj.type === 'Identifier' ? obj.name : null;
        if (recv !== null && f.regexNames.has(recv)) continue;
        const line = c.loc.start.line;
        if (name === 'get') {
          if (recv === 'q') continue;
          if (recv === 'router') {
            const a0 = c.arguments[0] ? staticText(c.arguments[0], f.src) : null;
            if (a0 && a0.t.startsWith('/')) continue;
            add('S5', f.rel, line, 'router.get( 首个实参不是以 / 开头的路径字符串');
            continue;
          }
        } else if (recv === 'q') {
          continue;
        }
        add('S5', f.rel, line, `.${name}( 的接收者是 ${recv === null ? `${obj.type} 表达式` : recv}，只允许 q${name === 'get' ? ' 或 router' : ''}`);
      }
    }

    // ── S6 ──
    const fnRange = (n) => { const d = f.fns.find((x) => x.id && x.id.name === n); return d ? [d.start, d.end] : null; };
    const inRange = (pos, r) => !!r && pos >= r[0] && pos < r[1];
    const rFault = f.rel === 'db.js' ? fnRange('closeFaultedConnOnce') : null;
    const rUnpub = f.rel === 'db.js' ? fnRange('closeUnpublished') : null;
    if (f.rel === 'db.js') {
      if (!rFault) add('S6', f.rel, 0, '缺函数 closeFaultedConnOnce'); // BRANCH-F1
      if (!rUnpub) add('S6', f.rel, 0, '缺函数 closeUnpublished'); // BRANCH-F2
    }
    const rExitDefault = (() => {
      if (f.rel !== 'db.js') return null;
      const d = f.decls.find((x) => x.id.type === 'Identifier' && x.id.name === 'processExit' && x.init);
      return d ? [d.init.start, d.init.end] : null;
    })();
    for (const c of f.calls) {
      const callee = c.callee;
      const line = c.loc.start.line;
      const name = callee.type === 'Identifier' ? callee.name : memberName(callee);
      if (name === 'close' && callee.type === 'MemberExpression') {
        if (!(inRange(c.start, rFault) || inRange(c.start, rUnpub))) add('S6', f.rel, line, '.close( 只允许出现在 db.js 的 closeFaultedConnOnce / closeUnpublished 函数体内');
      }
      if (name === 'processExit') {
        if (!inRange(c.start, rFault)) add('S6', f.rel, line, 'processExit( 只允许出现在 db.js 的 closeFaultedConnOnce 函数体内');
      }
      if (callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && callee.object.name === 'process' && name === 'exit') {
        if (!inRange(c.start, rExitDefault)) add('S6', f.rel, line, 'process.exit( 只允许出现在 db.js 的 processExit 默认值初始化表达式内');
      }
    }

    // ── S7 ──
    if (f.rel !== 'db.js') {
      for (const s of f.strings) {
        if (s.v === 'end') continue; // 唯一豁免：全文恰为小写 end（stream 事件名）
        const kw = txnKeywordAtStart(leadingKeywordText(s.v));
        if (kw) add('S7', f.rel, s.line, `字符串以事务控制关键字 ${kw.toUpperCase()} 开头: ${s.v.slice(0, 40).replace(/\u0001/g, '${…}')}`);
      }
    }

    // ── S9：SQL 字符串不得含注释（H1，12 号审）──
    for (const s of f.strings) {
      if (f.rel === 'db.js' && (s.t === '--' || s.t === '/*')) continue; // 精确白名单（isTxnControlSql 跳过注释用），个数在下面核对
      const m = /\/\*|--/.exec(s.v);
      if (m) add('S9', f.rel, lineAt(s, m.index), `字符串含 SQL 注释标记 ${m[0]}（注释让词法扫描失去可靠性，说明写在 JS 注释里）: ${s.v.slice(Math.max(0, m.index - 10), m.index + 30).replace(/\u0001/g, '${…}')}`); // BRANCH-S9
    }

    // ── S8：schema.js 只含 DDL（L4）──
    if (f.rel === 'schema.js') {
      for (const c of f.calls) {
        const name = memberName(c.callee);
        if (name && SQL_METHODS.has(name)) add('S8', f.rel, c.loc.start.line, `schema.js 里不得有 .${name}( 调用（只含 DDL）`);
      }
      for (const s of f.strings) {
        const hit = [
          [/\bUPDATE\b[\s\S]{0,80}?\bSET\b/i, 'UPDATE…SET'], [/\bDELETE\b/i, 'DELETE'], [/\bREPLACE\s+INTO\b/i, 'REPLACE INTO'], [/\bINSERT\b/i, 'INSERT'],
        ].find(([re]) => re.test(s.v));
        if (hit) add('S8', f.rel, s.line, `schema.js 的字符串里不得有 ${hit[1]}（只含 DDL）: ${s.v.slice(0, 40).replace(/\u0001/g, '${…}')}`);
      }
    }
  }

  // ── S3 白名单：恰好 1 条 + 临时表常量 ──
  if (dbFile) {
    let n = 0;
    for (const s of dbFile.strings) if (/\bDELETE\s+FROM\b/i.test(s.v) && s.t.trim() === TXN_WHITELIST_TEXT) n += 1;
    if (n !== 1) add('S3', 'db.js', 0, `白名单例外（${TXN_WHITELIST_TEXT}）应恰好 1 条，实际 ${n} 条`);
    const d = dbFile.decls.find((x) => x.id.type === 'Identifier' && x.id.name === 'TXN_MARK_TABLE');
    if (!d || !d.init || d.init.type !== 'Literal' || d.init.value !== 'temp.sysbuild_txn_mark') {
      add('S3', 'db.js', d ? d.loc.start.line : 0, "白名单前提：db.js 的 TXN_MARK_TABLE 必须是字面量 'temp.sysbuild_txn_mark'（本连接临时表）");
    }
    // ── S9 白名单：db.js 里全文恰为 '--' 与 '/*' 的字面量各恰 1 处 ──
    for (const mark of ['--', '/*']) {
      const cnt = dbFile.strings.filter((s) => s.t === mark).length;
      if (cnt !== 1) add('S9', 'db.js', 0, `白名单字面量 ${JSON.stringify(mark)} 应恰好 1 处，实际 ${cnt} 处`); // BRANCH-S9W
    }
    // ── S7 硬门（M2）：守卫的事务控制关键字集合与 db.js 的 TXN_CONTROL_KEYWORDS 全等（取 AST 字面量，不 require）──
    const kd = dbFile.decls.find((x) => x.id.type === 'Identifier' && x.id.name === 'TXN_CONTROL_KEYWORDS');
    const arr = kd && kd.init && kd.init.type === 'NewExpression' && kd.init.callee.type === 'Identifier' && kd.init.callee.name === 'Set'
      && kd.init.arguments[0] && kd.init.arguments[0].type === 'ArrayExpression' ? kd.init.arguments[0].elements : null;
    const dbKw = arr && arr.every((e) => e && e.type === 'Literal' && typeof e.value === 'string') ? arr.map((e) => e.value.toLowerCase()) : null;
    if (!dbKw) add('S7', 'db.js', kd ? kd.loc.start.line : 0, '无法从 db.js 取 TXN_CONTROL_KEYWORDS（应为 new Set([字符串字面量…])），关键字全等核对做不了');
    else if (dbKw.length !== new Set(dbKw).size || dbKw.length !== TXN_KEYWORDS.length || !TXN_KEYWORDS.every((k) => dbKw.includes(k))) add('S7', 'db.js', kd.loc.start.line, `db.js 的 TXN_CONTROL_KEYWORDS [${dbKw.join(', ')}] 与守卫的关键字集合 [${TXN_KEYWORDS.join(', ')}] 不全等`); // BRANCH-M2
  }
  return { findings, fileCount: files.length, rels };
}

function report(root) {
  const { findings, rels } = scan(root);
  const front = frontendStatic.scan(path.join(__dirname, '..', 'public'));
  findings.push(...front.findings);
  console.log(`扫描 ${root}（${rels.length} 个文件: ${rels.join(', ')}）`);
  let passed = 0;
  for (const [id, title] of RULES) {
    const mine = findings.filter((f) => f.rule === id);
    if (mine.length === 0) { passed += 1; console.log(`  PASS [${id}] ${title}`); continue; }
    for (const f of mine) console.log(`  FAIL [${id}] ${f.file}:${f.line} ${f.msg}`);
  }
  console.log(`  前端：Sys_Build.html 与 ${front.files.length} 个本模块脚本（共享脚本不在 S10 扫描范围）`);
  console.log(`\n${passed}/${RULES.length} 通过`);
  return passed === RULES.length ? 0 : 1;
}

// ── 自检 ───────────────────────────────────────────────────────────────────────────────
const BT = '`';
const HEAD = "'use strict';\n";

// 注入文件 / 锚点替换。create：在副本里新建文件；from/to：对已有文件做唯一锚点替换。
const MUTATIONS = [
  { id: 'S0 语法错误的文件', rule: 'S0', edits: [{ create: 'zz_bad.js', text: `${HEAD}module.exports = (;\n` }] },
  { id: 'S1 UPDATE 未登记列', rule: 'S1', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_projects SET created_by = ? WHERE id = ?", [1, 2]);\n` }] },
  { id: 'S1 UPDATE 未登记表', rule: 'S1', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_events SET payload_json = ? WHERE id = ?", [1, 2]);\n` }] },
  { id: 'S1 多列 SET 中第二列未登记（第一列含带逗号的函数）', rule: 'S1', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_projects SET status = datetime('now','localtime'), created_by = ? WHERE id = ?", [1, 2]);\n` }] },
  { id: 'S1 模板字符串里的动态表名', rule: 'S1', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q, t) => q.run(${BT}UPDATE \${t} SET name = ? WHERE id = ?${BT}, [1, 2]);\n` }] },
  { id: 'S1 小写 update 语句', rule: 'S1', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run('update sysbuild_projects set created_by = ? where id = ?', [1, 2]);\n` }] },
  { id: 'S1 拼接字符串里的 UPDATE 未登记列', rule: 'S1', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run('UPDATE sysbuild_projects ' + 'SET created_by = ? WHERE id = ?', [1, 2]);\n` }] },
  { id: 'S2 snapshot_json 缺 status = draft', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_package_versions SET snapshot_json = ?, updated_at = datetime('now','localtime') WHERE id = ?", [1, 2]);\n` }] },
  { id: 'S2 条件片段在 OR 分支里', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_package_versions SET snapshot_json = ? WHERE id = ? OR status = 'draft'", [1, 2]);\n` }] },
  { id: 'S2 条件片段在括号内的 OR 里', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_package_versions SET snapshot_json = ? WHERE id = ? AND (status = 'draft' OR 1 = 1)", [1, 2]);\n` }] },
  { id: 'S2 joined_at 缺 joined_at IS NULL', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_members SET joined_at = datetime('now','localtime') WHERE id = ?", [1]);\n` }] },
  { id: 'S2 完全没有 WHERE', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_members SET joined_at = datetime('now','localtime')");\n` }] },
  // C4a：新登记的条件更新（任务修订的终态只从待确认转入；提出人状态只在待确认时改写）
  { id: 'C4a S2 任务修订 status 缺 status = pending', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_confirm_task_revisions SET status = ?, updated_at = datetime('now','localtime') WHERE id = ?", [1, 2]);\n` }] },
  { id: 'C4a S2 任务修订 status_reason 缺 status = pending', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_confirm_task_revisions SET status_reason = ? WHERE id = ? AND rev_no = 1", [1, 2]);\n` }] },
  { id: 'C4a P32 S2 提交回写 form / parent 缺 status = draft', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_package_versions SET form = ?, parent_overall_version_id = ?, updated_at = datetime('now','localtime') WHERE id = ?", [1, 2, 3]);\n` }] },
  { id: 'C4a P32 S2 只改 parent 缺 status = draft', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_package_versions SET parent_overall_version_id = ? WHERE id = ? AND status <> 'effective'", [1, 2]);\n` }] },
  { id: 'C4a S2 提出人状态缺 proposer_status = pending', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_item_versions SET proposer_status = 'confirmed' WHERE id = ?", [1]);\n` }] },
  { id: 'C4a S2 deny_reason 缺 proposer_status = pending', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_item_versions SET deny_reason = ? WHERE id = ?", [1, 2]);\n` }] },
  { id: 'C4a 修订批三 M-1 S2 批次 status 缺 status = planning', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_batches SET status = 'active' WHERE id = ?", [1]);\n` }] },
  { id: 'C4a 修订批三 M-1 S2 批次 status 条件在 OR 分支里', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_batches SET status = 'active' WHERE id = ? OR status = 'planning'", [1]);\n` }] },
  { id: 'C6a S2 批次 status 登记片段是 status = ?（旧状态写成字面量不算）', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_batches SET status = 'live' WHERE id = ? AND status = 'active'", [1]);\n` }] },
  { id: 'C6a S2 批次 status 上线 / 撤销的旧状态条件在 OR 分支里', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_batches SET status = ? WHERE id = ? OR status = ?", ['live', 1, 'active']);\n` }] },
  { id: 'C4b Q-S2 S2 历史补录窗口 history_window 缺旧值条件 history_window = ?', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_projects SET history_window = 'open' WHERE id = ?", [1]);\n` }] },
  { id: 'C4b Q-S2 S2 历史补录窗口旧值条件在 OR 分支里', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_projects SET history_window = 'open' WHERE id = ? OR history_window = ?", [1, 'never']);\n` }] },
  { id: 'C4a S1 条目版本内容列不在可更新列', rule: 'S1', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_item_versions SET content = ? WHERE id = ? AND proposer_status = 'pending'", [1, 2]);\n` }] },
  { id: 'C4a S1 确认记录无可更新列', rule: 'S1', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_confirmations SET decision = ? WHERE id = ?", [1, 2]);\n` }] },
  { id: 'C4a S3 删除确认记录', rule: 'S3', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("DELETE FROM sysbuild_confirmations WHERE id = ?", [1]);\n` }] },
  { id: 'S3 新增 DELETE FROM sysbuild_x', rule: 'S3', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run('DELETE FROM sysbuild_items WHERE id = ?', [1]);\n` }] },
  { id: 'S3 白名单那条 DELETE 改文本', rule: 'S3', edits: [{ file: 'db.js', from: `${BT}DELETE FROM \${TXN_MARK_TABLE} WHERE seq = ?${BT}`, to: `${BT}DELETE FROM \${TXN_MARK_TABLE} WHERE 1 = 1${BT}` }] },
  { id: 'S3 白名单例外多出一条（db.js 内重复）', rule: 'S3', edits: [{ file: 'db.js', from: 'module.exports = {\n  createSysbuildDb,', to: `const dupDelete = ${BT}DELETE FROM \${TXN_MARK_TABLE} WHERE seq = ?${BT};\nmodule.exports = {\n  createSysbuildDb,` }] },
  { id: 'S3 白名单例外消失', rule: 'S3', edits: [{ file: 'db.js', from: `await runOn(conn, ${BT}DELETE FROM \${TXN_MARK_TABLE} WHERE seq = ?${BT}, [markSeq]);`, to: "await runOn(conn, 'SELECT 1', [markSeq]);" }] },
  { id: 'S3 白名单文本出现在非 db.js 文件', rule: 'S3', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q, TXN_MARK_TABLE) => q.run(${BT}DELETE FROM \${TXN_MARK_TABLE} WHERE seq = ?${BT}, [1]);\n` }] },
  { id: 'S3 TXN_MARK_TABLE 改指业务表', rule: 'S3', edits: [{ file: 'db.js', from: "const TXN_MARK_TABLE = 'temp.sysbuild_txn_mark';", to: "const TXN_MARK_TABLE = 'sysbuild_events';" }] },
  { id: 'S4 dbRunAsync(', rule: 'S4', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (dbRunAsync) => dbRunAsync('SELECT 1');\n` }] },
  { id: 'S4 deps.dbAllAsync 属性', rule: 'S4', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (deps) => deps.dbAllAsync;\n` }] },
  { id: 'S4 非 db.js require sqlite3', rule: 'S4', edits: [{ create: 'zz_mut.js', text: `${HEAD}const sqlite3 = require('sqlite3');\nmodule.exports = sqlite3;\n` }] },
  { id: 'S5 conn.run(', rule: 'S5', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (conn) => conn.run('SELECT 1');\n` }] },
  { id: 'S5 db.get(', rule: 'S5', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (db) => db.get('SELECT 1');\n` }] },
  { id: 'S5 this.db.all( 复合接收者', rule: 'S5', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = { f() { return this.db.all('SELECT 1'); } };\n` }] },
  { id: 'S5 x.prepare(', rule: 'S5', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (stmtSource) => stmtSource.prepare('SELECT 1');\n` }] },
  { id: 'S5 router.get 首参不是路径', rule: 'S5', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (router, sqlText) => router.get(sqlText);\n` }] },
  { id: 'S5 q 之外的 exec', rule: 'S5', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (database) => database.exec('PRAGMA user_version');\n` }] },
  { id: 'S6 非 db.js 文件里 .close(', rule: 'S6', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (c) => c.close(() => {});\n` }] },
  { id: 'S6 db.js 其他函数里 .close(', rule: 'S6', edits: [{ file: 'db.js', from: 'function markFault(reason) {', to: 'function markFault(reason) {\n    if (sbDb) sbDb.close(() => {});' }] },
  { id: 'S6 非 db.js 文件里 processExit(1)', rule: 'S6', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (processExit) => processExit(1);\n` }] },
  { id: 'S6 db.js 其他函数里 processExit(1)', rule: 'S6', edits: [{ file: 'db.js', from: 'function markFault(reason) {', to: 'function markFault(reason) {\n    processExit(1);' }] },
  { id: 'S6 process.exit( 在别处', rule: 'S6', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = () => process.exit(1);\n` }] },
  { id: 'S6 closeUnpublished 被改名（函数缺失）', rule: 'S6', edits: [{ file: 'db.js', from: 'function closeUnpublished(conn, reason) {', to: 'function closeUnpublishedRenamed(conn, reason) {' }] },
  { id: "S7 'COMMIT' 字面量", rule: 'S7', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run('COMMIT');\n` }] },
  { id: 'S7 前导分号 + 注释 + 小写 begin', rule: 'S7', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run(' ; /* x */ begin immediate');\n` }] },
  { id: 'S7 模板字符串 SAVEPOINT', rule: 'S7', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q, n) => q.run(${BT}SAVEPOINT sp_\${n}${BT});\n` }] },
  { id: 'S7 拼接字符串 ; ROLLBACK', rule: 'S7', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run('; ROLL' + 'BACK');\n` }] },
  // ── 预筛修订（第二批）新增 ──
  // M1：整行替换 / upsert / 不分大小写兜底
  { id: 'M1 S3 INSERT OR REPLACE INTO', rule: 'S3', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run('INSERT OR REPLACE INTO sysbuild_projects (id, system_name) VALUES (?, ?)', [1, 'x']);\n` }] },
  { id: 'M1 S3 REPLACE INTO（小写）', rule: 'S3', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run('replace into sysbuild_projects (id, system_name) values (?, ?)', [1, 'x']);\n` }] },
  { id: 'M1 S3 小写 insert … on conflict(id) do update set …', rule: 'S3', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run('insert into sysbuild_projects (id, system_name) values (?, ?) on conflict(id) do update set created_by = excluded.created_by', [1, 'x']);\n` }] },
  { id: 'M1 S1 小写 update … set(col) = (?) 行值写法', rule: 'S1', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run('update sysbuild_projects set(created_by) = (?) where id = ?', [1, 2]);\n` }] },
  // M2：END + 关键字集合与 db.js 全等
  { id: 'M2 S7 大写 END', rule: 'S7', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run('END');\n` }] },
  { id: 'M2 S7 end transaction（小写）', rule: 'S7', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run('end  transaction');\n` }] },
  { id: 'M2 S7 END TRANSACTION', rule: 'S7', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run('END TRANSACTION');\n` }] },
  { id: 'M2 S7 db.js 的 TXN_CONTROL_KEYWORDS 删一项（全等硬门）', rule: 'S7', edits: [{ file: 'db.js', from: "new Set(['begin', 'commit', 'end', 'rollback', 'savepoint', 'release'])", to: "new Set(['begin', 'commit', 'rollback', 'savepoint', 'release'])" }] },
  { id: 'M2 S7 db.js 的 TXN_CONTROL_KEYWORDS 增一项（全等硬门）', rule: 'S7', edits: [{ file: 'db.js', from: "new Set(['begin', 'commit', 'end', 'rollback', 'savepoint', 'release'])", to: "new Set(['begin', 'commit', 'end', 'rollback', 'savepoint', 'release', 'vacuum'])" }] },
  { id: 'M2 S7 db.js 的 TXN_CONTROL_KEYWORDS 不再是字面量数组（取不到）', rule: 'S7', edits: [{ file: 'db.js', from: "new Set(['begin', 'commit', 'end', 'rollback', 'savepoint', 'release'])", to: 'new Set(Object.keys({}))' }] },
  // M3：只走单个分支的变异（「删分支自检」逐个删掉对应代码，这些变异必须随之出现未判红）
  { id: 'M3-A 大写 UPDATE … SET 兜底（只被兜底分支拦）', rule: 'S1', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q, c) => q.run('UPDATE sysbuild_projects SET' + c);\n` }] },
  { id: 'M3-B SET 项是模板插值（只被「SET 项无法解析」分支拦）', rule: 'S1', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q, cols) => q.run(${BT}UPDATE sysbuild_projects SET \${cols} WHERE id = ?${BT}, [1]);\n` }] },
  { id: "M3-C 条件片段在括号内、括号内的 OR 在深度 1（12-R 起由白名单文法拦）", rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_package_versions SET snapshot_json = ? WHERE id = ? AND (0 OR 1 AND status = 'draft' AND 1)", [1, 2]);\n` }] },
  { id: "M3-D deps['dbRunAsync'] 字符串键（只被 S4 字符串分支拦）", rule: 'S4', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (deps) => deps['dbRunAsync']('SELECT 1');\n` }] },
  { id: 'M3-E1a schema.js 副本缺 UPDATABLE_COLUMNS 导出', rule: 'S0', edits: [{ file: 'schema.js', from: 'module.exports = { SCHEMA_OBJECTS, TABLE_NAMES, ENUMS, UPDATABLE_COLUMNS, CONDITIONAL_UPDATES, dateCheck };', to: 'module.exports = { SCHEMA_OBJECTS, TABLE_NAMES, ENUMS, CONDITIONAL_UPDATES, dateCheck };' }] },
  { id: 'M3-E1b schema.js 副本缺 CONDITIONAL_UPDATES 导出', rule: 'S0', edits: [{ file: 'schema.js', from: 'module.exports = { SCHEMA_OBJECTS, TABLE_NAMES, ENUMS, UPDATABLE_COLUMNS, CONDITIONAL_UPDATES, dateCheck };', to: 'module.exports = { SCHEMA_OBJECTS, TABLE_NAMES, ENUMS, UPDATABLE_COLUMNS, dateCheck };' }] },
  { id: 'M3-E2 副本缺 db.js', rule: 'S0', edits: [{ remove: 'db.js' }] },
  { id: 'M3-F1 closeUnpublished 只改名且其 .close( 一并去掉（只剩「缺函数」一条因果）', rule: 'S6', edits: [
    { file: 'db.js', from: 'function closeUnpublished(conn, reason) {', to: 'function closeUnpublishedRenamed(conn, reason) {' },
    { file: 'db.js', from: '      conn.close((err) => {\n        if (settled) return;\n        settled = true;\n        clearTimeout(timer);\n        if (err) logger.error(', to: '      conn.closeQuietly((err) => {\n        if (settled) return;\n        settled = true;\n        clearTimeout(timer);\n        if (err) logger.error(' },
  ] },
  { id: 'M3-F2 closeFaultedConnOnce 只改名且其 .close( / processExit( 一并去掉（只剩「缺函数」一条因果）', rule: 'S6', edits: [
    { file: 'db.js', from: 'function closeFaultedConnOnce(conn) {', to: 'function closeFaultedConnOnceRenamed(conn) {' },
    { file: 'db.js', from: '      conn.close((err) => {\n        if (settled) return;\n        settled = true;\n        clearTimeout(timer);\n        resolve(err ?', to: '      conn.closeQuietly((err) => {\n        if (settled) return;\n        settled = true;\n        clearTimeout(timer);\n        resolve(err ?' },
    { file: 'db.js', from: '        processExit(1);', to: '        exitHook(1);' },
  ] },
  // L1 / L3 / L4
  { id: 'L1 S2 WHERE 顶层插值 AND ${extra}', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q, extra) => q.run(${BT}UPDATE sysbuild_package_versions SET snapshot_json = ? WHERE status = 'draft' AND \${extra}${BT}, [1]);\n` }] },
  { id: "L3 S4 require('better-sqlite3')", rule: 'S4', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = require('better-sqlite3');\n` }] },
  { id: "L3 S4 require('node:sqlite')", rule: 'S4', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = require('node:sqlite');\n` }] },
  { id: "L3 S4 module.require('sqlite3')", rule: 'S4', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = module.require('sqlite3');\n` }] },
  { id: 'L4 S8 schema.js 里有 x.run(…) 调用', rule: 'S8', edits: [{ file: 'schema.js', from: 'const TABLE_NAMES = Object.freeze(TABLES.map(([name]) => name));', to: "const TABLE_NAMES = Object.freeze(TABLES.map(([name]) => name));\nconst x8 = { run() {} };\nx8.run('UPDATE sysbuild_projects SET created_by = 1');" }] },
  // ── 12 号审修订（第三批）：H1 / H2 / M1 / M2 ──
  { id: 'H1a S9 DELETE /*说明*/ FROM（夹注释）', rule: 'S9', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run('DELETE /*说明*/ FROM sysbuild_events WHERE id = ?', [1]);\n` }] },
  { id: 'H1b S9 SET 里夹含 WHERE 的注释', rule: 'S9', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run('UPDATE sysbuild_projects SET status = ? /* WHERE 条件 */, created_by = ? WHERE id = ?', [1, 2, 3]);\n` }] },
  { id: 'H1c S9 行注释 --', rule: 'S9', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run('SELECT 1 -- 说明');\n` }] },
  { id: 'H1d S9 非 db.js 的普通提示串含 --（接受误伤）', rule: 'S9', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = () => '-- x';\n` }] },
  { id: 'H1e S9 db.js 白名单字面量多一处', rule: 'S9', edits: [{ file: 'db.js', from: 'module.exports = {\n  createSysbuildDb,', to: "const dupDash = '--';\nmodule.exports = {\n  createSysbuildDb," }] },
  { id: 'H1f S9 db.js 白名单字面量消失', rule: 'S9', edits: [{ file: 'db.js', from: "t.startsWith('--')", to: "t.startsWith('-')" }] },
  { id: 'H2 S3+S5 折叠串里的模板插值调用', rule: 'S3', also: ['S5'], edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (conn) => '结果：' + ${BT}\${conn.run('DELETE FROM sysbuild_events')}${BT};\n` }] },
  { id: 'H2b S3+S5 多层拼接里嵌套的模板插值调用', rule: 'S3', also: ['S5'], edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (conn) => 'a' + ('b' + ${BT}x\${conn.run('DELETE FROM sysbuild_events')}${BT}) + 'c';\n` }] },
  // ── 12-R M1：白名单文法硬门（以下三条只靠白名单检查拦；删掉白名单检查后 CASE / BETWEEN 两条须出现未判红）──
  { id: '12R-M1 S2 CASE 吞 AND（sysbuild_members）', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run('UPDATE sysbuild_members SET joined_at = ? WHERE CASE WHEN 0 THEN 1 AND joined_at IS NULL AND 1 ELSE 1 END', [1]);\n` }] },
  { id: '12R-M1 S2 标识符前缀伪造（xjoined_at IS NULL 子串含片段但不是登记的那一项）', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run('UPDATE sysbuild_members SET joined_at = ? WHERE id = ? AND xjoined_at IS NULL', [1, 2]);\n` }] },
  { id: '12R-M1 S2 BETWEEN 吞 AND（sysbuild_members）', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run('UPDATE sysbuild_members SET joined_at = ? WHERE id BETWEEN 0 AND joined_at IS NULL AND 1 = 1', [1]);\n` }] },
  { id: '12R-M1 S2 条件更新 WHERE 里的 IN (${…})（白名单之外，收紧后判红）', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q, ids) => q.run(${BT}UPDATE sysbuild_package_versions SET snapshot_json = ? WHERE id IN (\${ids}) AND status = 'draft'${BT}, [1]);\n` }] },
  { id: 'M1 S2 片段只出现在 SQL 字符串字面量里（sysbuild_members）', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_members SET joined_at = ? WHERE 'AND joined_at IS NULL AND' = 'AND joined_at IS NULL AND'", [1]);\n` }] },
  { id: 'M2 S7 end;', rule: 'S7', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run('end;');\n` }] },
  { id: 'M2 S7 eNd', rule: 'S7', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run('eNd');\n` }] },
  { id: 'M2 S7 前导空白 end', rule: 'S7', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run(' end');\n` }] },
  { id: 'L4 S8 schema.js 里有 INSERT 字符串', rule: 'S8', edits: [{ file: 'schema.js', from: 'const TABLE_NAMES = Object.freeze(TABLES.map(([name]) => name));', to: "const TABLE_NAMES = Object.freeze(TABLES.map(([name]) => name));\nconst sql8 = 'INSERT INTO sysbuild_events (id) VALUES (1)';" }] },
  // ── C2-0（codex 13 号 L-1 / R-2）：字面量项禁空白与 =；S0 校验登记片段形态 ──
  { id: 'C2-0 S0 登记片段字面量含 =（status = \'a=b\'）', rule: 'S0', edits: [{ file: 'schema.js', from: `snapshot_json: "status = 'draft'"`, to: `snapshot_json: "status = 'a=b'"` }] },
  { id: 'C2-0 S0 登记片段含 AND（status = \'draft\' AND id = ?）', rule: 'S0', edits: [{ file: 'schema.js', from: `snapshot_json: "status = 'draft'"`, to: `snapshot_json: "status = 'draft' AND id = ?"` }] },
  { id: 'C2-0 S0 登记片段字面量含空白（status = \'dr aft\'）', rule: 'S0', edits: [{ file: 'schema.js', from: `snapshot_json: "status = 'draft'"`, to: `snapshot_json: "status = 'dr aft'"` }] },
  { id: "C2-0 S2 条件更新 WHERE 追加非登记项 note = 'x=y'（字面量含 =）", rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_members SET joined_at = ? WHERE joined_at IS NULL AND note = 'x=y'", [1]);\n` }] },
  { id: 'C2-0 S0 整表登记值改成字符串（\'joined_at IS NULL\'）', rule: 'S0', edits: [{ file: 'schema.js', from: "sysbuild_members: Object.freeze({ joined_at: 'joined_at IS NULL' })", to: "sysbuild_members: 'joined_at IS NULL'" }] },
  { id: 'C2-0 S0 整表登记值改成数组', rule: 'S0', edits: [{ file: 'schema.js', from: "sysbuild_members: Object.freeze({ joined_at: 'joined_at IS NULL' })", to: "sysbuild_members: Object.freeze(['joined_at IS NULL'])" }] },
  { id: 'C2-0 S0 登记列名写错（joinedat 不在 UPDATABLE_COLUMNS 登记列内）', rule: 'S0', edits: [{ file: 'schema.js', from: "Object.freeze({ joined_at: 'joined_at IS NULL' })", to: "Object.freeze({ joinedat: 'joined_at IS NULL' })" }] },
  { id: 'C2-0 S0 登记表名写错（sysbuild_member 不在 UPDATABLE_COLUMNS）', rule: 'S0', edits: [{ file: 'schema.js', from: "sysbuild_members: Object.freeze({ joined_at: 'joined_at IS NULL' })", to: "sysbuild_member: Object.freeze({ joined_at: 'joined_at IS NULL' })" }] },
  // ── codex 14 号 M-1：schema 顶层导出形态 ──
  { id: 'C14 S0 CONDITIONAL_UPDATES 导出为空数组 []', rule: 'S0', edits: [{ file: 'schema.js', from: 'module.exports = { SCHEMA_OBJECTS, TABLE_NAMES, ENUMS, UPDATABLE_COLUMNS, CONDITIONAL_UPDATES, dateCheck };', to: 'module.exports = { SCHEMA_OBJECTS, TABLE_NAMES, ENUMS, UPDATABLE_COLUMNS, CONDITIONAL_UPDATES: [], dateCheck };' }] },
  { id: 'C14 S0 UPDATABLE_COLUMNS 导出为空数组 []', rule: 'S0', edits: [{ file: 'schema.js', from: 'module.exports = { SCHEMA_OBJECTS, TABLE_NAMES, ENUMS, UPDATABLE_COLUMNS, CONDITIONAL_UPDATES, dateCheck };', to: 'module.exports = { SCHEMA_OBJECTS, TABLE_NAMES, ENUMS, UPDATABLE_COLUMNS: [], CONDITIONAL_UPDATES: {}, dateCheck };' }] }, // CONDITIONAL_UPDATES 同时置空：否则 S0T（登记表不在 UPDATABLE_COLUMNS）会遮蔽 E1a 分支
  { id: 'C14 S0 UPDATABLE_COLUMNS 某表值改为字符串', rule: 'S0', edits: [{ file: 'schema.js', from: 'module.exports = { SCHEMA_OBJECTS, TABLE_NAMES, ENUMS, UPDATABLE_COLUMNS, CONDITIONAL_UPDATES, dateCheck };', to: "module.exports = { SCHEMA_OBJECTS, TABLE_NAMES, ENUMS, UPDATABLE_COLUMNS: Object.assign({}, UPDATABLE_COLUMNS, { sysbuild_projects: 'status' }), CONDITIONAL_UPDATES, dateCheck };" }] }, // 选条件登记之外的表：否则 S0T 会遮蔽 E1c 分支
  // ── codex 14 号 M-2：登记片段非字符串——必须落在「检出且命中 S0」，不能是异常（带一条真实 UPDATE 去触发 S2 路径）──
  { id: 'C14 S0 登记片段改 null（并有对应 UPDATE 走到 S2 路径）', rule: 'S0', edits: [
    { file: 'schema.js', from: `snapshot_json: "status = 'draft'"`, to: 'snapshot_json: null' },
    { create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_package_versions SET snapshot_json = ? WHERE id = ? AND status = 'draft'", [1, 2]);\n` },
  ] },
  { id: 'C14 S0 登记片段改数字 1（并有对应 UPDATE 走到 S2 路径）', rule: 'S0', edits: [
    { file: 'schema.js', from: `snapshot_json: "status = 'draft'"`, to: 'snapshot_json: 1' },
    { create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_package_versions SET snapshot_json = ? WHERE id = ? AND status = 'draft'", [1, 2]);\n` },
  ] },
  { id: 'C14 S0 登记片段删掉值（joined_at: undefined，并有对应 UPDATE 走到 S2 路径）', rule: 'S0', edits: [
    { file: 'schema.js', from: "joined_at: 'joined_at IS NULL'", to: 'joined_at: undefined' },
    { create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_members SET joined_at = ? WHERE id = ? AND joined_at IS NULL", [1, 2]);\n` },
  ] },
  { id: "C2-0 S2 条件更新 WHERE 追加非登记项 note = 'x y'（字面量含空白）", rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_members SET joined_at = ? WHERE joined_at IS NULL AND note = 'x y'", [1]);\n` }] },
];

// 正例：合规写法必须全绿（证明规则没有过严，也让变异的「判红」有对照）。
const CONTROLS = [
  {
    id: '合规写法：q 助手 / router.get 路径 / 正则 exec / 条件齐全的 UPDATE / 中间含 COMMIT 字样的提示',
    text: [
      "'use strict';",
      'const RE = /a(b)/;',
      'const RE2 = new RegExp("x");',
      'module.exports = async (q, router) => {',
      "  /c/.exec('c'); RE.exec('ab'); RE2.exec('x');",
      "  router.get('/sysbuild/ok', () => {});",
      "  await q.get('SELECT 1');",
      "  await q.all('SELECT 1');",
      '  await q.run("UPDATE sysbuild_projects SET status = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?", [1, 2]);',
      '  await q.run("UPDATE sysbuild_package_versions SET snapshot_json = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ? AND status = \'draft\'", [1, 2]);',
      '  await q.run("UPDATE sysbuild_members SET joined_at = datetime(\'now\',\'localtime\') WHERE joined_at IS NULL AND id = ?", [1]);',
      "  await q.run(`UPDATE sysbuild_nodes SET name = ?, status = ? WHERE id = ? AND project_id IN (${[1].map(() => '?').join(',')})`, [1]);",
      "  return '业务查询不得自行 COMMIT，please update the record';",
      '};',
      '',
    ].join('\n'),
  },
  {
    id: '合规写法（修订批）：INSERT … ON CONFLICT DO NOTHING / 条件更新 WHERE 的白名单各形态 / 英文提示 / endpoint 开头的词',
    text: [
      "'use strict';",
      'module.exports = async (q, ids) => {',
      '  await q.run("INSERT INTO sysbuild_guide_state (user_id, guide_key) VALUES (?, ?) ON CONFLICT(user_id, guide_key) DO NOTHING", [1, \'k\']);',
      "  await q.run(`UPDATE sysbuild_package_versions SET snapshot_json = ? WHERE id = ? AND status = 'draft'`, [1]);",
      "  await q.run(\"UPDATE sysbuild_package_versions SET snapshot_json = ? WHERE status='draft' and id = 3 AND deleted IS NOT NULL and kind = 'x_y' AND pkg_id=?\", [1]);",
      "  await q.run('UPDATE sysbuild_members SET joined_at = datetime(\\'now\\',\\'localtime\\') WHERE\\n    id = ?\\n    AND joined_at IS NULL', [1]);",
      "  await q.run('UPDATE sysbuild_projects SET status = ? WHERE id = ?', [1, 2]);",
      "  const stream = { on() {} }; stream.on('end', () => {});",
      "  return ['endpoint ok', 'Please update the record'];",
      '};',
      '',
    ].join('\n'),
  },
];

function copyTree(src, dst) {
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) { fs.mkdirSync(d); copyTree(s, d); } else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}
function removeTree(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) removeTree(p); else fs.unlinkSync(p);
  }
  fs.rmdirSync(dir);
}

// 子进程结果分三类：red（退出码 1 且汇总 passed<total）/ green / abnormal（没有汇总行、被信号终止等）。
function runGuard(scriptPath, args) {
  // 守卫副本（分类器自检 / 删分支自检）不在 scripts/ 下，acorn 靠 NODE_PATH 找；保留调用方已有的 NODE_PATH。
  const env = Object.assign({}, process.env, { NODE_PATH: [path.join(__dirname, '..', 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter) });
  const r = spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8', timeout: 120000, env });
  const out = r.stdout || '';
  const m = /^(\d+)\/(\d+) 通过\s*$/m.exec(out);
  const fails = out.split('\n').filter((l) => /^\s*FAIL \[S\d+\]/.test(l));
  if (r.error || r.signal || m === null) {
    return { kind: 'abnormal', fails, detail: (r.error && r.error.message) || r.signal || ((r.stderr || '').split('\n').filter(Boolean).slice(0, 2).join(' | ') || '无汇总行') };
  }
  const p = Number(m[1]);
  const t = Number(m[2]);
  if (r.status === 1 && p < t) return { kind: 'red', fails, detail: `${p}/${t}` };
  if (r.status === 0 && p === t) return { kind: 'green', fails, detail: `${p}/${t}` };
  return { kind: 'abnormal', fails, detail: `退出码 ${r.status} 与汇总 ${p}/${t} 不一致` };
}

function selfTest() {
  let total = 0;
  let ok = 0;
  const check = (pass, label) => { total += 1; if (pass) ok += 1; console.log(`  ${pass ? '✓' : '✗'} ${label}`); return pass; };

  const base = runGuard(__filename, ['--root', DEFAULT_ROOT]);
  const baseOk = check(base.kind === 'green', `未变异基线（真实 routes/sysbuild/）${base.kind === 'green' ? `${base.detail} 全绿` : `不是全绿（${base.kind}: ${base.detail}${base.fails.length ? ` | ${base.fails.join(' | ')}` : ''}），变异结果不可信，终止`}`);
  if (!baseOk) { console.log(`\n${ok}/${total} 通过`); return 1; }

  // 函数级断言（C2-0，codex 13 号 L-1）：直接调用 whereHasConjunct，不经文件扫描；期望值手写，不从被测函数取。
  check(whereHasConjunct("kind = 'a = b'", "kind = 'a=b'") !== 'ok', "函数级：引号内 = 不被归一化抹平（WHERE kind = 'a = b' vs 登记 kind = 'a=b' 不得为 ok）");
  check(whereHasConjunct("kind = 'a  b'", "kind = 'a b'") !== 'ok', "函数级：引号内空白不被折叠抹平（WHERE kind = 'a  b' vs 登记 kind = 'a b' 不得为 ok）");
  check(whereHasConjunct("status = 'draft'", "status = 'draft'") === 'ok', "函数级：正例 status = 'draft' 仍为 ok");
  check(whereHasConjunct('id = ? AND joined_at IS NULL', 'joined_at IS NULL') === 'ok', '函数级：正例 id = ? AND joined_at IS NULL 仍为 ok');
  // codex 14 号 M-2 纵深防御：非字符串片段不抛异常，且不为 ok（期望手写：只要求「不抛、不是 ok」）。
  for (const [label, bad] of [['null', null], ['数字 1', 1], ['undefined', undefined]]) {
    let threw = false;
    let got = null;
    try { got = whereHasConjunct('id = ? AND joined_at IS NULL', bad); } catch (e) { threw = true; }
    check(!threw && got !== 'ok', `函数级：片段为 ${label} 时 whereHasConjunct 不抛异常且不为 ok（${threw ? '抛了异常' : `返回 ${got}`}）`);
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sysbuild-static-'));
  try {
    // 分类器自检：追加非法 JavaScript 的守卫副本必须判异常，不能被算作检出。
    const brokenGuard = path.join(tmpRoot, 'broken-guard.js');
    fs.writeFileSync(brokenGuard, `${fs.readFileSync(__filename, 'utf8')}\n这一行不是合法的 JavaScript(\n`);
    const broken = runGuard(brokenGuard, ['--root', DEFAULT_ROOT]);
    fs.unlinkSync(brokenGuard);
    if (!check(broken.kind === 'abnormal', `分类器自检：语法错误的守卫副本判为 ${broken.kind}（应为 abnormal）${broken.kind === 'abnormal' ? `（${broken.detail}）` : ''}`)) {
      console.log(`\n${ok}/${total} 通过`);
      return 1;
    }

    const fresh = () => { const d = fs.mkdtempSync(path.join(tmpRoot, 'copy-')); copyTree(DEFAULT_ROOT, d); return d; };
    for (const c of CONTROLS) {
      const d = fresh();
      fs.writeFileSync(path.join(d, 'zz_ok.js'), c.text);
      const r = runGuard(__filename, ['--root', d]);
      check(r.kind === 'green', `正例 [${c.id}] ${r.kind === 'green' ? '全绿' : `被判 ${r.kind}: ${r.fails.join(' | ') || r.detail}`}`);
      removeTree(d);
    }
    for (const mu of MUTATIONS) {
      const d = fresh();
      let anchorOk = true;
      for (const e of mu.edits) {
        if (e.create) { fs.writeFileSync(path.join(d, e.create), e.text); continue; }
        if (e.remove) { fs.unlinkSync(path.join(d, e.remove)); continue; }
        const file = path.join(d, e.file);
        const src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
        const count = src.split(e.from).length - 1;
        if (count !== 1) { anchorOk = false; break; }
        fs.writeFileSync(file, src.replace(e.from, () => e.to));
      }
      if (!anchorOk) { check(false, `[${mu.id}] 变异锚点出现次数不是 1`); removeTree(d); continue; }
      const r = runGuard(__filename, ['--root', d]);
      const need = [mu.rule].concat(mu.also || []);
      const hit = r.kind === 'red' && need.every((rule) => r.fails.some((l) => l.includes(`FAIL [${rule}]`)));
      const other = [...new Set(r.fails.map((l) => /\[(S\d+)\]/.exec(l)[1]))].filter((x) => !need.includes(x));
      check(hit, `[${mu.id}] ${hit ? `命中 ${mu.rule}${other.length ? `（另命中 ${other.join('/')}）` : ''}` : `未检出（${r.kind}: ${r.detail}${r.fails.length ? ` | ${r.fails.join(' | ')}` : ''}）`}`);
      removeTree(d);
    }
    for (const entry of frontendStatic.selfTest().results) check(entry.ok, `S10 前端正反例：${entry.name}`);
  } finally {
    try { removeTree(tmpRoot); } catch (e) { console.error(`  [清理] 临时目录未删除（保留现场）: ${tmpRoot} — ${e.message}`); }
  }
  console.log(`\n${ok}/${total} 通过`);
  return ok === total ? 0 : 1;
}

if (SELF_TEST) {
  process.exitCode = selfTest();
} else {
  process.exitCode = report(ROOT);
}
