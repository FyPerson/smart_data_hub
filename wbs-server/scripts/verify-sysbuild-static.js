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
//      理由：片段「出现在 WHERE 深度 0」不等于它属于最外层合取链（`CASE WHEN 0 THEN 1 AND removed_at IS NULL AND 1 ELSE 1 END`、
//      `id BETWEEN 0 AND removed_at IS NULL AND 1 = 1` 都能骗过逐项判断），与其逐个追加特例，不如把文法收到只剩简单 AND 链。
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
//   S11 导航（lib/sysbuild-frontend-static.js 的 scanNav）：Sys_Build.html 手抄的平台导航，对 Legacy_Archive.html 的标准导航只做三项归一
//     （去 aria-label="平台导航"、LOGO 渐变 id 换成参照页的、摘掉「项目管理」入口）后去空白逐字全等；被摘掉的入口另断言：恰好 1 个、紧跟「系统迭代」、
//     起始标签与 `<a href="/Sys_Build.html" class="nav-item active" aria-current="page" style="color:#d97706; font-weight:600;">` 逐字全等
//     （分项报 aria-current / 选中样式缺失，全等不成立另报）、恰好 1 个带 aria-hidden 的 svg 且去掉 aria-hidden 后与 app.js 里 SVG_ICONS.clipboard 字面量逐字相同
//     （取不到常量判红）、文字「项目管理」，以及入口整段（去空白）与「约定起始标签 + 带 aria-hidden 的图标 + 文字 + </a>」全等（只在前面各分项都没报问题时才另报）。
//     另查 assets/css/sysbuild.css：去掉 /* */ 注释后不得出现 .navbar / .nav-item / .nav-right / .nav-left / .nav-title /
//     .nav-logo / .nav-divider / .nav-dropdown(-*) / .fixed-header 类选择器（按点号开头的完整类名判，.sbui-nav-item 不误伤；文件读不到判红，命中给行号与该行内容；
//     类名黑名单，已知限制见 lib 里 navCssHits 的注释）。
//     自测对真实 HTML / css 在内存里做变异（不落盘）：HTML 反例必须真的改动内容（没改动就抛错）并命中预期失败信息；样式表反例断言命中的类名与条数（绿例为 0 条）。
//   S13 停用标识（#212 第一步 C1b 加的骨架；名单 RETIRED_IDENTIFIERS 随 C2–C8 的删除提交逐步填入，C2 已填入 17 个历史补录标识，C3 再填 11 个代录标识，C4 / C5 各填其名单，C6 填 141 个，C7 填 54 个）：
//     元素 { token, kind: 'table'|'action'|'event'|'path'|'file', from: 'C2'…'C8', lastClear?: { commit, where }, note }。
//     扫描面：routes/sysbuild/ 下全部 .js（跟随 --root）、public/assets/js/sysbuild-*.js、public/Sys_Build.html（公共目录取法与 S10 相同）。
//     RETIRED_SCHEMA_EXEMPT = true 时 schema.js 不扫（结构提交之前它还登记着旧表）；C8 结构提交把它改成 false。
//     匹配（JS 用 acorn tokenizer，注释不进 token）：table / action / event = 标识符 token 等值；字符串字面量、模板字面量静态片段与 HTML 文本
//     （先去掉 <!-- --> 与内联 <script> 的内容；内联脚本按 JS 分词）按词边界 (?<![A-Za-z0-9_])token(?![A-Za-z0-9_])——表名主要写在 SQL 串里，
//     字符串只做等值会漏掉 'INSERT INTO <表> …' 这类引用（主会话 C1b 收口改）；
//     path / file = 字符串字面量、模板静态片段按子串（HTML 文本同样按子串，否则 <script src="…"> 里的旧文件名漏扫）。
//     file 类的子串命中左侧加路径段边界：命中位置前一个字符必须是字符串开头或 '/'（'assets/js/x.js' 算；'sysbuild-x.js'、'a.x.js'、'a_x.js' 不算）；
//     .js 结尾的 file 类右侧不得紧跟标识符字符（'x.json' 里的 'x.js' 不算）。path 类仍是纯子串。
//     file 类 token 以 .js 结尾时再加一个判法（对应不带 .js 的 require）：只对以 ./ 或 ../ 开头的字符串 token 生效，去掉 .js 后的名字是它的
//     「完整最后一个路径段」才命中（'./x'、'../sysbuild/x' 算；裸写 'x'——如 registerTab('history')——、'/x'——如 URL 尾段——、'./x-y'、'./x.json'、'./xy' 不算）。
//     path 类覆盖完整字面量和静态路径段可恢复的直接拼接、模板字面量。路径段本身藏在变量或函数里时，由 xref-exports 调用方反查和浏览器用例覆盖。
//     已知局限：正则字面量不扫。
//     纯函数 scanRetired(名单, 文件内容表, schema 豁免) 单独可测；自检里有函数级正反例（不走子进程变异）。
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
  ['S11', '项目管理页导航 = Legacy_Archive.html 的标准导航 + 「项目管理」一项（紧跟系统迭代、入口起始标签逐字全等、入口整段去空白全等、图标与 SVG_ICONS.clipboard 逐字相同）；sysbuild.css 不覆盖平台导航类名'],
  ['S12', '表单存储列只允许出现在 schema.js、entries-core.js、entry-forms.js'],
  ['S13', '停用标识与路由不再出现在 routes/sysbuild、本模块前端脚本和页面里'],
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
    // L1：列名出现位置采用源码文件白名单，含注释，新增读取必须经表单助手。
    if (!['schema.js', 'entries-core.js', 'entry-forms.js'].includes(rel)) {
      const source = fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
      source.split('\n').forEach((line, i) => {
        if (line.includes('routing_json')) add('S12', rel, i + 1, '表单存储列必须经 entry-forms.js 读取');
      });
    }
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

// ── S13 停用标识（#212 第一步 C1b 骨架）─────────────────────────────────────────────────
// 名单随删除提交逐步填入：元素 { token, kind, from, lastClear?, note }；名单为空时 S13 恒通过。lastClear / note 只给人看，不参与判定。
const RETIRED_KINDS = ['table', 'action', 'event', 'path', 'file'];
const RETIRED_FROM_RE = /^(?:C[2-8]|B2\.[23]|B3\.3)$/;
// 填名单注意：元素的 note / lastClear 里不要写字符序列 `]);`——自检的端到端块用正则截取这整段声明，遇到它会提前截断（会判红，不会假绿）。
const RETIRED_IDENTIFIERS = Object.freeze([
  { token: 'sysbuild_invitations', kind: 'table', from: 'B2.3', note: '#212 邀请表退出' },
  { token: 'invitationKind', kind: 'action', from: 'B2.3', note: '#212 邀请类型退出' },
  { token: 'invitationStatus', kind: 'action', from: 'B2.3', note: '#212 邀请状态退出' },
  { token: '/my/invitations', kind: 'path', from: 'B2.2', note: '#212 直接指定后退出' },
  { token: '/sysbuild/parties/:pid/appointments', kind: 'path', from: 'B2.2', note: '#212 直接指定后退出' },
  { token: '/sysbuild/parties/:pid/delegations', kind: 'path', from: 'B2.2', note: '#212 直接指定后退出' },
  { token: '/sysbuild/appointments/:apid/withdraw', kind: 'path', from: 'B2.2', note: '#212 直接指定后退出' },
  { token: '/sysbuild/delegations/:did/approve', kind: 'path', from: 'B2.2', note: '#212 直接指定后退出' },
  { token: '/sysbuild/delegations/:did/reject', kind: 'path', from: 'B2.2', note: '#212 直接指定后退出' },
  { token: '/sysbuild/delegations/:did/withdraw', kind: 'path', from: 'B2.2', note: '#212 直接指定后退出' },
  { token: '/sysbuild/delegations/:did/accept', kind: 'path', from: 'B2.2', note: '#212 直接指定后退出' },
  { token: '/sysbuild/delegations/:did/decline', kind: 'path', from: 'B2.2', note: '#212 直接指定后退出' },
  { token: 'member_invited', kind: 'event', from: 'B2.2', note: '#212 直接指定后退出' },
  { token: 'member_joined', kind: 'event', from: 'B2.2', note: '#212 直接指定后退出' },
  { token: 'invitation_accepted', kind: 'event', from: 'B2.2', note: '#212 直接指定后退出' },
  { token: 'invitation_declined', kind: 'event', from: 'B2.2', note: '#212 直接指定后退出' },
  { token: 'invitation_withdrawn', kind: 'event', from: 'B2.2', note: '#212 直接指定后退出' },
  { token: 'appointment_proposed', kind: 'event', from: 'B2.2', note: '#212 直接指定后退出' },
  { token: 'appointment_rejected', kind: 'event', from: 'B2.2', note: '#212 直接指定后退出' },
  { token: 'appointment_withdrawn', kind: 'event', from: 'B2.2', note: '#212 直接指定后退出' },
  { token: 'delegation_proposed', kind: 'event', from: 'B2.2', note: '#212 直接指定后退出' },
  { token: 'delegation_approved', kind: 'event', from: 'B2.2', note: '#212 直接指定后退出' },
  { token: 'delegation_rejected', kind: 'event', from: 'B2.2', note: '#212 直接指定后退出' },
  { token: 'delegation_withdrawn', kind: 'event', from: 'B2.2', note: '#212 直接指定后退出' },
  { token: 'appointment_propose', kind: 'action', from: 'B2.2', note: '#212 直接指定后退出' },
  { token: 'appointment_withdraw', kind: 'action', from: 'B2.2', note: '#212 直接指定后退出' },
  { token: 'delegation_propose', kind: 'action', from: 'B2.2', note: '#212 直接指定后退出' },
  { token: 'delegation_approve', kind: 'action', from: 'B2.2', note: '#212 直接指定后退出' },
  { token: 'delegation_reject', kind: 'action', from: 'B2.2', note: '#212 直接指定后退出' },
  { token: 'delegation_withdraw', kind: 'action', from: 'B2.2', note: '#212 直接指定后退出' },
  { token: 'delegation_accept', kind: 'action', from: 'B2.2', note: '#212 直接指定后退出' },
  { token: 'delegation_decline', kind: 'action', from: 'B2.2', note: '#212 直接指定后退出' },
  { token: 'invitation_accept', kind: 'action', from: 'B2.2', note: '#212 直接指定后退出' },
  { token: 'invitation_decline', kind: 'action', from: 'B2.2', note: '#212 直接指定后退出' },
  { token: 'myInvitationItems', kind: 'action', from: 'B2.2', note: '#212 直接指定后退出' },
  { token: 'INVITATION_SELECT', kind: 'action', from: 'B2.2', note: '#212 直接指定后退出' },
  { token: 'enqueueMemberIntent', kind: 'action', from: 'B2.2', note: '#212 直接指定后退出' },
  { token: 'pending_invitation_count', kind: 'action', from: 'B2.2', note: '#212 直接指定后退出' },
  { token: 'pendingInvitations', kind: 'action', from: 'B2.2', note: '#212 直接指定后退出' },
  { token: 'hasPendingProposal', kind: 'action', from: 'B2.2', note: '#212 直接指定后退出' },
  { token: 'pendingMemberRow', kind: 'action', from: 'B2.2', note: '#212 直接指定后退出' },
  { token: 'withdrawInvitationsOfInviter', kind: 'action', from: 'B2.2', note: '#212 直接指定后退出' },
  // C2（删 S6 历史补录）：生效清单 v1.2 第六节的 17 个标识
  { token: 'sysbuild_history_imports', kind: 'table', from: 'C2', note: 'C2 后扫描面里只剩 schema.js（C8 前豁免）；C8 删表' },
  { token: 'history_window_open', kind: 'action', from: 'C2', note: 'OBJECT_OPS 与 OP_KIND 同提交删' },
  { token: 'history_window_close', kind: 'action', from: 'C2', note: '同上' },
  { token: 'history_window_reopen', kind: 'action', from: 'C2', note: '同上' },
  { token: 'history_confirmation_record', kind: 'action', from: 'C2', note: '同上' },
  { token: 'history_fact_import', kind: 'action', from: 'C2', note: '同上' },
  { token: 'history_window_opened', kind: 'event', from: 'C2', note: 'events.js 登记；前端 page.js 事件文案同删' },
  { token: 'history_window_closed', kind: 'event', from: 'C2', note: '同上' },
  { token: 'history_window_reopened', kind: 'event', from: 'C2', note: '同上' },
  { token: 'history_confirmation_recorded', kind: 'event', from: 'C2', note: '另一写点 confirm-core 的历史补录分支同提交删' },
  { token: 'history_fact_imported', kind: 'event', from: 'C2', note: '另一读点 confirm-core.submittedNodePlans 的后备同提交删' },
  { token: '/sysbuild/projects/:id/history-window', kind: 'path', from: 'C2', note: '原 history.js 的窗口端点' },
  { token: '/sysbuild/projects/:id/history-window/events', kind: 'path', from: 'C2', note: '原 history.js 的窗口事件读接口' },
  { token: '/sysbuild/projects/:id/history-confirmations', kind: 'path', from: 'C2', note: '原 history.js 的历史补录写读端点' },
  { token: '/sysbuild/projects/:id/history-imports', kind: 'path', from: 'C2', note: '原 history.js 的历史事实导入端点' },
  { token: 'history.js', kind: 'file', from: 'C2', note: 'routes/sysbuild/history.js 整文件删' },
  { token: 'sysbuild-history.js', kind: 'file', from: 'C2', note: '前端页签脚本；history.js 的左边界判定不会命中它，两个都登记' },
  // C3（删 S9 代录与无账号成员）：生效清单 v1.3 第六节的 11 个标识
  { token: 'confirm_proxy', kind: 'action', from: 'C3', note: 'OBJECT_OPS 与 OP_KIND 同提交删' },
  { token: 'appointment_proxy_accept', kind: 'action', from: 'C3', note: '同上' },
  { token: 'delegation_proxy', kind: 'action', from: 'C3', note: '同上' },
  { token: 'entry_conclusion_proxy', kind: 'action', from: 'C3', note: '同上（骨架判 C6，本清单提前）' },
  { token: 'confirm_proxy_recorded', kind: 'event', from: 'C3', note: 'events.js 登记；前端 sysbuild-page.js 事件文案同删' },
  { token: 'appointment_proxy_accepted', kind: 'event', from: 'C3', note: '同上' },
  { token: 'delegation_proxy_granted', kind: 'event', from: 'C3', note: '同上' },
  { token: 'delegation_proxy_accepted', kind: 'event', from: 'C3', note: '同上' },
  { token: '/sysbuild/confirm-tasks/:tid/proxy', kind: 'path', from: 'C3', note: '原 confirm.js 的代录端点' },
  { token: '/sysbuild/appointments/:apid/proxy-accept', kind: 'path', from: 'C3', note: '原 membership.js 的任职接受代录端点' },
  { token: '/sysbuild/delegations/:did/proxy', kind: 'path', from: 'C3', note: '原 membership.js 的授权代录端点' },
  // C4（删 S5 上线交接）：生效清单 v1.2 第六节的 4 个标识（不登记：GET /sysbuild/batches/:bid/handover、页签键 handover、确认用途 handover_accept_issue / handover_no_further、对象类型 handover、阻塞原因代码，见清单第六节）
  { token: 'handover_request', kind: 'action', from: 'C4', note: 'OBJECT_OPS 与 OP_KIND 同提交删' },
  { token: 'handover_requested', kind: 'event', from: 'C4', note: 'events.js 登记；前端 sysbuild-page.js 事件文案同删' },
  { token: 'handover_replied', kind: 'event', from: 'C4', note: '同上' },
  { token: '/sysbuild/batches/:bid/handover/requests', kind: 'path', from: 'C4', note: '原 golive.js 的发起交接确认端点' },
  // C5（删 S1 正式变更）：生效清单 v1.4 第六节名单（路由 4 条、文件 2 个、表单种类 2 个、事件 5 个、动作规则键与办理动作 4 个、待办类别 1 个、导出名 19 个）
  { token: '/sysbuild/projects/:id/changes', kind: 'path', from: 'C5', note: '原 changes.js 的建变更与列表端点' },
  { token: '/sysbuild/changes/:cid', kind: 'path', from: 'C5', note: '原 changes.js 的变更详情端点（子串口径同时覆盖 /new-version 与 /submit）' },
  { token: '/sysbuild/changes/:cid/new-version', kind: 'path', from: 'C5', note: '原 changes.js 的出新版本端点' },
  { token: '/sysbuild/changes/:cid/submit', kind: 'path', from: 'C5', note: '原 confirm.js 的变更提交端点' },
  { token: 'changes.js', kind: 'file', from: 'C5', note: 'routes/sysbuild/changes.js 整文件删' },
  { token: 'assessment-view.js', kind: 'file', from: 'C5', note: 'routes/sysbuild/assessment-view.js 整文件删' },
  { token: 'change_request', kind: 'action', from: 'C5', note: '需求变更申请表单种类（旧库遗留登记读成不可读，见清单 C5-RC37）' },
  { token: 'dev_assessment', kind: 'action', from: 'C5', note: '开发评估表单种类' },
  { token: 'change_created', kind: 'event', from: 'C5', note: 'events.js 登记同批删' },
  { token: 'change_submitted', kind: 'event', from: 'C5', note: '同上' },
  { token: 'change_withdrawn', kind: 'event', from: 'C5', note: '同上' },
  { token: 'change_new_version', kind: 'event', from: 'C5', note: '同上（动作规则键 change_new_version 同名，action 类同删）' },
  { token: 'change_effective', kind: 'event', from: 'C5', note: '同上；submittedNodePlans 的回退读点同批删' },
  { token: 'change_create', kind: 'action', from: 'C5', note: 'OBJECT_OPS 与 OP_KIND 同提交删' },
  { token: 'entry_link_change', kind: 'action', from: 'C5', note: '同上' },
  { token: 'link_change', kind: 'action', from: 'C5', note: '办理动作名；ACTION_FIELDS / ACTION_FLAGS 去键，请求走通用动作表拒绝（schema.js 枚举留 C8）' },
  { token: 'change_assess', kind: 'action', from: 'C5', note: '待办类别与前端标签同批删' },
  { token: 'createChangeRoutes', kind: 'action', from: 'C5', note: '导出名（以下 19 个：本体与全部使用点都在删除区间）' },
  { token: 'createChangeDraft', kind: 'action', from: 'C5', note: '导出名' },
  { token: 'applyChangeEffect', kind: 'action', from: 'C5', note: '导出名' },
  { token: 'submittedAssessmentView', kind: 'action', from: 'C5', note: '导出名' },
  { token: 'devAssessmentOf', kind: 'action', from: 'C5', note: '导出名' },
  { token: 'CHANGE_DRAFT_ABANDONED_REASON', kind: 'action', from: 'C5', note: '导出名' },
  { token: 'CHANGE_FACT_UNKNOWN_MESSAGE', kind: 'action', from: 'C5', note: '导出名' },
  { token: 'renderChangeRows', kind: 'action', from: 'C5', note: '导出名' },
  { token: 'renderAssessmentRows', kind: 'action', from: 'C5', note: '导出名' },
  { token: 'renderChangeImpact', kind: 'action', from: 'C5', note: '导出名' },
  { token: 'assessmentView', kind: 'action', from: 'C5', note: '导出名' },
  { token: 'changeForm', kind: 'action', from: 'C5', note: '导出名' },
  { token: 'numberField', kind: 'action', from: 'C5', note: '导出名' },
  { token: 'CHANGE_LABELS', kind: 'action', from: 'C5', note: '导出名' },
  { token: 'FEASIBLE_LABELS', kind: 'action', from: 'C5', note: '导出名' },
  { token: 'checkJsonValue', kind: 'action', from: 'C5', note: '导出名' },
  { token: 'newVersionFacts', kind: 'action', from: 'C5', note: '导出名' },
  { token: 'changeView', kind: 'action', from: 'C5', note: '导出名' },
  { token: 'loadChangeCtx', kind: 'action', from: 'C5', note: '导出名' },
  // C6（删 S4 结论确认 / 分流拆分、S7 异议、R2 / R3 / R5 / R6 / R9 退出键）：生效清单 v1.3 第六节名单（共 141 个：路由 1、文件 1、事件 4、动作规则键 14、办理动作名 7、待办与阻塞码 3、键 4、表 4、导出名与内部符号 103）
  // C6 路由（1）
  { token: '/sysbuild/notices/:nid/object', kind: 'path', from: 'C6', note: '原 entries.js 的改期知会 / 仅供参考知会异议端点' },
  // C6 文件（1）
  { token: 'entries-routing.js', kind: 'file', from: 'C6', note: 'routes/sysbuild/entries-routing.js 整文件删' },
  // C6 事件类型（4）
  { token: 'routing_decided', kind: 'event', from: 'C6', note: 'events.js 登记同批删；前端 sysbuild-page.js 事件文案同删（entry_split 同名动作规则键同删，登记一次）' },
  { token: 'routing_assigned', kind: 'event', from: 'C6', note: 'events.js 登记同批删；前端 sysbuild-page.js 事件文案同删（entry_split 同名动作规则键同删，登记一次）' },
  { token: 'entry_split', kind: 'event', from: 'C6', note: 'events.js 登记同批删；前端 sysbuild-page.js 事件文案同删（entry_split 同名动作规则键同删，登记一次）' },
  { token: 'notice_objected', kind: 'event', from: 'C6', note: 'events.js 登记同批删；前端 sysbuild-page.js 事件文案同删（entry_split 同名动作规则键同删，登记一次）' },
  // C6 动作规则键（14）
  { token: 'entry_conclude', kind: 'action', from: 'C6', note: 'OBJECT_OPS 与 OP_KIND 同提交删' },
  { token: 'entry_for_reference', kind: 'action', from: 'C6', note: 'OBJECT_OPS 与 OP_KIND 同提交删' },
  { token: 'entry_mark_commitment', kind: 'action', from: 'C6', note: 'OBJECT_OPS 与 OP_KIND 同提交删' },
  { token: 'entry_unmark_commitment', kind: 'action', from: 'C6', note: 'OBJECT_OPS 与 OP_KIND 同提交删' },
  { token: 'entry_mark_risk', kind: 'action', from: 'C6', note: 'OBJECT_OPS 与 OP_KIND 同提交删' },
  { token: 'entry_unmark_risk', kind: 'action', from: 'C6', note: 'OBJECT_OPS 与 OP_KIND 同提交删' },
  { token: 'entry_escalate', kind: 'action', from: 'C6', note: 'OBJECT_OPS 与 OP_KIND 同提交删' },
  { token: 'entry_assign_items', kind: 'action', from: 'C6', note: 'OBJECT_OPS 与 OP_KIND 同提交删' },
  { token: 'entry_link_sys_issue', kind: 'action', from: 'C6', note: 'OBJECT_OPS 与 OP_KIND 同提交删' },
  { token: 'entry_object', kind: 'action', from: 'C6', note: 'OBJECT_OPS 与 OP_KIND 同提交删' },
  { token: 'notice_object', kind: 'action', from: 'C6', note: 'OBJECT_OPS 与 OP_KIND 同提交删' },
  { token: 'schedule_notice_object', kind: 'action', from: 'C6', note: 'OBJECT_OPS 与 OP_KIND 同提交删' },
  { token: 'entry_conclusion_decide', kind: 'action', from: 'C6', note: 'OBJECT_OPS 与 OP_KIND 同提交删' },
  { token: 'entry_conclusion_reissue', kind: 'action', from: 'C6', note: 'OBJECT_OPS 与 OP_KIND 同提交删' },
  // C6 办理动作名（7）
  { token: 'for_reference', kind: 'action', from: 'C6', note: 'ACTION_FIELDS / ACTION_FLAGS 去键，请求走通用动作表拒绝（schema.js 枚举留 C8）' },
  { token: 'mark_commitment', kind: 'action', from: 'C6', note: 'ACTION_FIELDS / ACTION_FLAGS 去键，请求走通用动作表拒绝（schema.js 枚举留 C8）' },
  { token: 'unmark_commitment', kind: 'action', from: 'C6', note: 'ACTION_FIELDS / ACTION_FLAGS 去键，请求走通用动作表拒绝（schema.js 枚举留 C8）' },
  { token: 'mark_risk', kind: 'action', from: 'C6', note: 'ACTION_FIELDS / ACTION_FLAGS 去键，请求走通用动作表拒绝（schema.js 枚举留 C8）' },
  { token: 'unmark_risk', kind: 'action', from: 'C6', note: 'ACTION_FIELDS / ACTION_FLAGS 去键，请求走通用动作表拒绝（schema.js 枚举留 C8）' },
  { token: 'assign_items', kind: 'action', from: 'C6', note: 'ACTION_FIELDS / ACTION_FLAGS 去键，请求走通用动作表拒绝（schema.js 枚举留 C8）' },
  { token: 'link_sys_issue', kind: 'action', from: 'C6', note: 'ACTION_FIELDS / ACTION_FLAGS 去键，请求走通用动作表拒绝（schema.js 枚举留 C8）' },
  // C6 待办与阻塞码（3）
  { token: 'entry_unresolved', kind: 'action', from: 'C6', note: '待办 handle 类子项与收口阻塞码同批删' },
  { token: 'ENTRY_UNRESOLVED', kind: 'action', from: 'C6', note: '待办 handle 类子项与收口阻塞码同批删' },
  { token: 'ENTRY_FACTS_MISSING', kind: 'action', from: 'C6', note: '待办 handle 类子项与收口阻塞码同批删' },
  // C6 请求键 / 前端键 / 响应键（4）
  { token: 'self_confirm_text', kind: 'action', from: 'C6', note: '请求键、前端控件键与响应键同批删' },
  { token: 'self_ack', kind: 'action', from: 'C6', note: '请求键、前端控件键与响应键同批删' },
  { token: 'post_close_objections_open', kind: 'action', from: 'C6', note: '请求键、前端控件键与响应键同批删' },
  { token: 'to_change', kind: 'action', from: 'C6', note: '请求键、前端控件键与响应键同批删' },
  // C6 表（4）
  { token: 'sysbuild_notice_objections', kind: 'table', from: 'C6', note: 'C6 删全部读写点；schema.js 由 RETIRED_SCHEMA_EXEMPT 豁免，C8 删表' },
  { token: 'sysbuild_routing_snapshots', kind: 'table', from: 'C6', note: 'C6 删全部读写点；schema.js 由 RETIRED_SCHEMA_EXEMPT 豁免，C8 删表' },
  { token: 'sysbuild_entry_items', kind: 'table', from: 'C6', note: 'C6 删全部读写点；schema.js 由 RETIRED_SCHEMA_EXEMPT 豁免，C8 删表' },
  { token: 'sysbuild_changes', kind: 'table', from: 'C6', note: 'C6 删全部读写点；schema.js 由 RETIRED_SCHEMA_EXEMPT 豁免，C8 删表' },
  // C6 导出名与内部符号 · rules.js（23）
  { token: 'ENTRY_CONCLUSION_STATES', kind: 'action', from: 'C6', note: '导出名 / 内部符号（rules.js；本体与全部使用点都在删除区间）' },
  { token: 'EFFECTIVE_CONCLUSION_STATES', kind: 'action', from: 'C6', note: '导出名 / 内部符号（rules.js；本体与全部使用点都在删除区间）' },
  { token: 'CONCLUDE_FROM_STATES', kind: 'action', from: 'C6', note: '导出名 / 内部符号（rules.js；本体与全部使用点都在删除区间）' },
  { token: 'FOR_REFERENCE_FROM_STATES', kind: 'action', from: 'C6', note: '导出名 / 内部符号（rules.js；本体与全部使用点都在删除区间）' },
  { token: 'ENTRY_OPEN_OBJECTION_STATES', kind: 'action', from: 'C6', note: '导出名 / 内部符号（rules.js；本体与全部使用点都在删除区间）' },
  { token: 'ENTRY_HANDLED_TYPES', kind: 'action', from: 'C6', note: '导出名 / 内部符号（rules.js；本体与全部使用点都在删除区间）' },
  { token: 'ENTRY_DEV_PURPOSES', kind: 'action', from: 'C6', note: '导出名 / 内部符号（rules.js；本体与全部使用点都在删除区间）' },
  { token: 'DEV_CONFIRM_PROJECT_MESSAGE', kind: 'action', from: 'C6', note: '导出名 / 内部符号（rules.js；本体与全部使用点都在删除区间）' },
  { token: 'ENTRY_DEV_NOT_APPROVED_SPLIT_MESSAGE', kind: 'action', from: 'C6', note: '导出名 / 内部符号（rules.js；本体与全部使用点都在删除区间）' },
  { token: 'devConfirmProjectBlock', kind: 'action', from: 'C6', note: '导出名 / 内部符号（rules.js；本体与全部使用点都在删除区间）' },
  { token: 'ENTRY_CONFIRMER_UNAVAILABLE_MESSAGE', kind: 'action', from: 'C6', note: '导出名 / 内部符号（rules.js；本体与全部使用点都在删除区间）' },
  { token: 'ENTRY_OUT_OF_PLAN_PROJECT_MESSAGE', kind: 'action', from: 'C6', note: '导出名 / 内部符号（rules.js；本体与全部使用点都在删除区间）' },
  { token: 'ENTRY_SYS_ITERATION_ROUTE_MESSAGE', kind: 'action', from: 'C6', note: '导出名 / 内部符号（rules.js；本体与全部使用点都在删除区间）' },
  { token: 'ENTRY_SYS_ITERATION_REFERENCE_MESSAGE', kind: 'action', from: 'C6', note: '导出名 / 内部符号（rules.js；本体与全部使用点都在删除区间）' },
  { token: 'ENTRY_SPLIT_FROM_STATES', kind: 'action', from: 'C6', note: '导出名 / 内部符号（rules.js；本体与全部使用点都在删除区间）' },
  { token: 'ENTRY_OBJECTOR_BASES', kind: 'action', from: 'C6', note: '导出名 / 内部符号（rules.js；本体与全部使用点都在删除区间）' },
  { token: 'ENTRY_TASK_OBJECT_TYPES', kind: 'action', from: 'C6', note: '导出名 / 内部符号（rules.js；本体与全部使用点都在删除区间）' },
  { token: 'ENTRY_SPLIT_CONTAINER_MESSAGE', kind: 'action', from: 'C6', note: '导出名 / 内部符号（rules.js；本体与全部使用点都在删除区间）' },
  { token: 'entryStateKnown', kind: 'action', from: 'C6', note: '导出名 / 内部符号（rules.js；本体与全部使用点都在删除区间）' },
  { token: 'entryConfirmerState', kind: 'action', from: 'C6', note: '导出名 / 内部符号（rules.js；本体与全部使用点都在删除区间）' },
  { token: 'NOTICE_OBJECTOR_BASES', kind: 'action', from: 'C6', note: '导出名 / 内部符号（rules.js；本体与全部使用点都在删除区间）' },
  { token: 'canObjectNotice', kind: 'action', from: 'C6', note: '导出名 / 内部符号（rules.js；本体与全部使用点都在删除区间）' },
  { token: 'CONCLUSION_KINDS_FINAL', kind: 'action', from: 'C6', note: '导出名 / 内部符号（rules.js；本体与全部使用点都在删除区间）' },
  // C6 导出名与内部符号 · entries-core.js（38）
  { token: 'to_change_lapsed', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries-core.js）' },
  { token: 'changeStatusOf', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries-core.js）' },
  { token: 'SNAPSHOT_COLS', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries-core.js）' },
  { token: 'SUPERSEDED_BY_NEW_CONCLUSION', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries-core.js）' },
  { token: 'ENTRY_VOIDED_REASON', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries-core.js）' },
  { token: 'ESCALATED_CLOSED_BY_TERMINATION_REASON', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries-core.js）' },
  { token: 'resolveConclusionConfirmer', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries-core.js）' },
  { token: 'resolveAdjudicator', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries-core.js）' },
  { token: 'confirmerView', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries-core.js）' },
  { token: 'CONCLUDE_STATE_OF_REVISION', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries-core.js）' },
  { token: 'ADJUDICATE_STATE_OF_REVISION', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries-core.js）' },
  { token: 'returnedToHandling', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries-core.js）' },
  { token: 'deriveContainerState', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries-core.js）' },
  { token: 'entryResolved', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries-core.js）' },
  { token: 'currentItemRowsOf', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries-core.js）' },
  { token: 'currentRoutingOf', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries-core.js）' },
  { token: 'unresolvedProcessEntriesOf', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries-core.js）' },
  { token: 'postCloseObjectionsOf', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries-core.js）' },
  { token: 'objectorBasisOf', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries-core.js）' },
  { token: 'ensureEntryFrozen', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries-core.js）' },
  { token: 'closePendingEntryRevisions', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries-core.js）' },
  { token: 'loadEntryTaskObject', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries-core.js）' },
  { token: 'entryTaskObjectView', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries-core.js）' },
  { token: 'DEV_CANCELLED_COMMITMENT_REASON', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries-core.js）' },
  { token: 'DEV_VOIDED_REASON', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries-core.js）' },
  { token: 'DEV_PURPOSES', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries-core.js）' },
  { token: 'DEV_STATUS_OF_REVISION', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries-core.js）' },
  { token: 'entryNeedsDevConfirm', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries-core.js）' },
  { token: 'devConfirmOf', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries-core.js）' },
  { token: 'devApprovalUsable', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries-core.js）' },
  { token: 'devOwnerSelfSubmit', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries-core.js）' },
  { token: 'requestDevConfirm', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries-core.js）' },
  { token: 'invalidatePendingDevRevisions', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries-core.js）' },
  { token: 'loadDevTaskObject', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries-core.js）' },
  { token: 'devEntryTaskObjectView', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries-core.js）' },
  { token: 'entryVoidedOf', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries-core.js）' },
  { token: 'usedAsScheduleKey', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries-core.js）' },
  { token: 'usedAsBasis', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries-core.js）' },
  // C6 导出名与内部符号 · entries.js（16）
  { token: 'LATER_ACTIONS', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries.js）' },
  { token: 'LATER_ACTION_MESSAGE', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries.js）' },
  { token: 'ADJUDICATE_ACTION_MESSAGE', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries.js）' },
  { token: 'OBJECTION_KEYS', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries.js）' },
  { token: 'OBJECTION_TYPES', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries.js）' },
  { token: 'DEV_CONFIRM_LABELS', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries.js）' },
  { token: 'devConfirmView', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries.js）' },
  { token: 'currentConclusionOf', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries.js）' },
  { token: 'noticeView', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries.js）' },
  { token: 'noticeTarget', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries.js）' },
  { token: 'recipientUserOf', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries.js）' },
  { token: 'scheduleNoticeTarget', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries.js）' },
  { token: 'SYS_ISSUE_MAX', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries.js）' },
  { token: 'ASSIGNEE_MAX', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries.js）' },
  { token: 'ITEM_IDS_MAX', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries.js）' },
  { token: 'readFlag', kind: 'action', from: 'C6', note: '导出名 / 内部符号（entries.js）' },
  // C6 导出名与内部符号 · confirm.js / confirm-core.js（8）
  { token: 'ENTRY_TASK_PURPOSES', kind: 'action', from: 'C6', note: '导出名 / 内部符号（confirm.js / confirm-core.js）' },
  { token: 'ENTRY_TASK_DECISIONS', kind: 'action', from: 'C6', note: '导出名 / 内部符号（confirm.js / confirm-core.js）' },
  { token: 'ENTRY_TASK_DECISION_MESSAGES', kind: 'action', from: 'C6', note: '导出名 / 内部符号（confirm.js / confirm-core.js）' },
  { token: 'assertEntryTaskDecision', kind: 'action', from: 'C6', note: '导出名 / 内部符号（confirm.js / confirm-core.js）' },
  { token: 'isEntryTask', kind: 'action', from: 'C6', note: '导出名 / 内部符号（confirm.js / confirm-core.js）' },
  { token: 'decideOpOf', kind: 'action', from: 'C6', note: '导出名 / 内部符号（confirm.js / confirm-core.js）' },
  { token: 'reissueOpOf', kind: 'action', from: 'C6', note: '导出名 / 内部符号（confirm.js / confirm-core.js）' },
  { token: 'resolveEntryReissue', kind: 'action', from: 'C6', note: '导出名 / 内部符号（confirm.js / confirm-core.js）' },
  // C6 导出名与内部符号 · entries-routing.js（16）
  { token: 'GROUP_ORDER', kind: 'action', from: 'C6', note: '导出名 / 内部符号（原 entries-routing.js，整文件已删）' },
  { token: 'CANCELLED_WITH_PARENT_TEXT', kind: 'action', from: 'C6', note: '导出名 / 内部符号（原 entries-routing.js，整文件已删）' },
  { token: 'ASSIGN_BASES', kind: 'action', from: 'C6', note: '导出名 / 内部符号（原 entries-routing.js，整文件已删）' },
  { token: 'ASSIGN_ROUTES', kind: 'action', from: 'C6', note: '导出名 / 内部符号（原 entries-routing.js，整文件已删）' },
  { token: 'liveGoliveOf', kind: 'action', from: 'C6', note: '导出名 / 内部符号（原 entries-routing.js，整文件已删）' },
  { token: 'classifyItems', kind: 'action', from: 'C6', note: '导出名 / 内部符号（原 entries-routing.js，整文件已删）' },
  { token: 'planParts', kind: 'action', from: 'C6', note: '导出名 / 内部符号（原 entries-routing.js，整文件已删）' },
  { token: 'snapshotRowsOfPart', kind: 'action', from: 'C6', note: '导出名 / 内部符号（原 entries-routing.js，整文件已删）' },
  { token: 'appendSnapshots', kind: 'action', from: 'C6', note: '导出名 / 内部符号（原 entries-routing.js，整文件已删）' },
  { token: 'describeLiveItems', kind: 'action', from: 'C6', note: '导出名 / 内部符号（原 entries-routing.js，整文件已删）' },
  { token: 'liveRejection', kind: 'action', from: 'C6', note: '导出名 / 内部符号（原 entries-routing.js，整文件已删）' },
  { token: 'createChildEntry', kind: 'action', from: 'C6', note: '导出名 / 内部符号（原 entries-routing.js，整文件已删）' },
  { token: 'splitIntoParts', kind: 'action', from: 'C6', note: '导出名 / 内部符号（原 entries-routing.js，整文件已删）' },
  { token: 'planManualSplit', kind: 'action', from: 'C6', note: '导出名 / 内部符号（原 entries-routing.js，整文件已删）' },
  { token: 'planAssignment', kind: 'action', from: 'C6', note: '导出名 / 内部符号（原 entries-routing.js，整文件已删）' },
  { token: 'objectionFacts', kind: 'action', from: 'C6', note: '导出名 / 内部符号（原 entries-routing.js，整文件已删）' },
  // C6 导出名与内部符号 · plan.js（2）
  { token: 'devKeyEntryId', kind: 'action', from: 'C6', note: '内部符号（plan.js）' },
  { token: 'entryUnresolved', kind: 'action', from: 'C6', note: '内部符号（plan.js）' },
  // C7（删 S3 需求条目流程、R1 范围包重核）：提交卡 v1.0 主表末节名单（共 54 个：表 4、动作规则键 7、导出名与内部符号 28、事件 9、路径 6）
  // C7 表（4）
  { token: 'sysbuild_modules', kind: 'table', from: 'C7', note: 'C7 删全部读写点；schema.js 由 RETIRED_SCHEMA_EXEMPT 豁免，C8 删表' },
  { token: 'sysbuild_items', kind: 'table', from: 'C7', note: 'C7 删全部读写点；schema.js 由 RETIRED_SCHEMA_EXEMPT 豁免，C8 删表' },
  { token: 'sysbuild_item_versions', kind: 'table', from: 'C7', note: 'C7 删全部读写点；schema.js 由 RETIRED_SCHEMA_EXEMPT 豁免，C8 删表' },
  { token: 'sysbuild_package_item_revisions', kind: 'table', from: 'C7', note: 'C7 删全部读写点；schema.js 由 RETIRED_SCHEMA_EXEMPT 豁免，C8 删表' },
  // C7 动作规则键（7）
  { token: 'module_create', kind: 'action', from: 'C7', note: 'OBJECT_OPS 与 OP_KIND 同提交删' },
  { token: 'module_rename', kind: 'action', from: 'C7', note: 'OBJECT_OPS 与 OP_KIND 同提交删' },
  { token: 'item_create', kind: 'action', from: 'C7', note: 'OBJECT_OPS 与 OP_KIND 同提交删' },
  { token: 'item_version_create', kind: 'action', from: 'C7', note: 'OBJECT_OPS 与 OP_KIND 同提交删' },
  { token: 'item_set_module', kind: 'action', from: 'C7', note: 'OBJECT_OPS 与 OP_KIND 同提交删' },
  { token: 'package_item_add', kind: 'action', from: 'C7', note: 'OBJECT_OPS 与 OP_KIND 同提交删' },
  { token: 'package_item_remove', kind: 'action', from: 'C7', note: 'OBJECT_OPS 与 OP_KIND 同提交删' },
  // C7 导出名与内部符号 · 后端（23）
  { token: 'canRegisterItem', kind: 'action', from: 'C7', note: '导出名 / 内部符号（rules.js）' },
  { token: 'canCreateItemVersion', kind: 'action', from: 'C7', note: '导出名 / 内部符号（rules.js）' },
  { token: 'moduleNameState', kind: 'action', from: 'C7', note: '导出名 / 内部符号（rules.js）' },
  { token: 'createItemRoutes', kind: 'action', from: 'C7', note: '导出名（原 items.js，整文件已删）' },
  { token: 'resolveCurrentPlan', kind: 'action', from: 'C7', note: '导出名（packages.js；读接口改用 effectiveOverallVersionId）' },
  { token: 'foldRevisions', kind: 'action', from: 'C7', note: '导出名 / 内部符号（packages.js）' },
  { token: 'loadFoldedSet', kind: 'action', from: 'C7', note: '导出名 / 内部符号（packages.js 与其延迟加载包装）' },
  { token: 'loadRevisionRows', kind: 'action', from: 'C7', note: '内部符号（packages.js）' },
  { token: 'recheckOverallSet', kind: 'action', from: 'C7', note: '导出名（submission-scope.js；R1 取消总体规划集合重核）' },
  { token: 'canonicalJson', kind: 'action', from: 'C7', note: '导出名（submission-scope.js；摘要随 R1 删）' },
  { token: 'evidenceCount', kind: 'action', from: 'C7', note: '内部符号（submission-scope.js）' },
  { token: 'liveFreezeBreaches', kind: 'action', from: 'C7', note: '导出名（entries-core.js；唯一调用方 recheckOverallSet 已删）' },
  { token: 'isFrozenLiveBatch', kind: 'action', from: 'C7', note: '导出名（entries-core.js）' },
  { token: 'createProposerTask', kind: 'action', from: 'C7', note: '导出名（confirm-core.js）' },
  { token: 'supersedeProposerRevisions', kind: 'action', from: 'C7', note: '导出名（confirm-core.js）' },
  { token: 'ITEM_SUPERSEDED_REASON', kind: 'action', from: 'C7', note: '导出名（confirm-core.js）' },
  { token: 'PROPOSER_DENIED_REISSUE_MESSAGE', kind: 'action', from: 'C7', note: '内部符号（rules.js）' },
  { token: 'itemFrozenViews', kind: 'action', from: 'C7', note: '内部符号（confirmation-sheet.js）' },
  { token: 'renderItem', kind: 'action', from: 'C7', note: '内部符号（confirmation-sheet.js）' },
  { token: 'proposerDetail', kind: 'action', from: 'C7', note: '内部符号（confirmation-sheet.js）' },
  { token: 'mapProposerStatus', kind: 'action', from: 'C7', note: '内部符号（confirmation-sheet.js）' },
  { token: 'scope_digest', kind: 'action', from: 'C7', note: '送审范围摘要（submission-scope.js；R1 删）' },
  { token: 'digestInput', kind: 'action', from: 'C7', note: '送审范围摘要入参（submission-scope.js；R1 删）' },
  // C7 前端内部符号（5）
  { token: 'itemForm', kind: 'action', from: 'C7', note: '前端内部符号（sysbuild-content.js）' },
  { token: 'itemsTab', kind: 'action', from: 'C7', note: '前端内部符号（sysbuild-content.js）' },
  { token: 'addItemToVersion', kind: 'action', from: 'C7', note: '前端内部符号（sysbuild-packages.js）' },
  { token: 'evidenceDeclaration', kind: 'action', from: 'C7', note: '前端内部符号（sysbuild-confirm.js）' },
  { token: 'proposerStates', kind: 'action', from: 'C7', note: '前端内部符号（sysbuild-content.js）' },
  // C7 事件类型（9）
  { token: 'module_created', kind: 'event', from: 'C7', note: 'events.js 登记同批删' },
  { token: 'module_renamed', kind: 'event', from: 'C7', note: '同上' },
  { token: 'item_created', kind: 'event', from: 'C7', note: '同上' },
  { token: 'item_version_created', kind: 'event', from: 'C7', note: '同上' },
  { token: 'item_module_changed', kind: 'event', from: 'C7', note: '同上' },
  { token: 'package_item_added', kind: 'event', from: 'C7', note: '同上' },
  { token: 'package_item_removed', kind: 'event', from: 'C7', note: '同上' },
  { token: 'item_proposer_status_changed', kind: 'event', from: 'C7', note: '唯一写入点 confirm.js 随删' },
  { token: 'confirm_revision_superseded', kind: 'event', from: 'C7', note: '唯一写入点 supersedeProposerRevisions 随删（不在方案条目 8 种之内，提交卡 main-gaps 第 3 条）' },
  // C7 路径（6）
  { token: '/sysbuild/projects/:id/modules', kind: 'path', from: 'C7', note: '原 items.js 的建模块与列表端点' },
  { token: '/sysbuild/modules/:mid', kind: 'path', from: 'C7', note: '原 items.js 的改模块名端点' },
  { token: '/sysbuild/projects/:id/items', kind: 'path', from: 'C7', note: '原 items.js 的登记条目与列表端点' },
  { token: '/sysbuild/items/:iid', kind: 'path', from: 'C7', note: '原 items.js 的条目详情与改模块端点（子串口径同时覆盖 /versions）' },
  { token: '/sysbuild/items/:iid/versions', kind: 'path', from: 'C7', note: '原 items.js 的条目出新版本端点' },
  { token: '/sysbuild/package-versions/:vid/items', kind: 'path', from: 'C7', note: '原 packages.js 的条目集合修订端点' },
  { token: 'proposer_confirm', kind: 'action', from: 'C8', note: '结构收口时退出' },
  { token: 'handover_accept', kind: 'action', from: 'C8', note: '旧确认用途及前端标签已退役' },
  { token: 'accept_invitation', kind: 'action', from: 'C8', note: '旧确认用途退役，邀请使用独立入口' },
  { token: 'delegation_grant', kind: 'action', from: 'C8', note: '旧确认用途退役，授权使用独立入口' },
  { token: 'batch_req', kind: 'action', from: 'C8', note: '批次需求包旧类型退役' },
  { token: 'handover_snapshot_json', kind: 'action', from: 'C8', note: '结构收口时退出' },
  { token: 'HANDOVER_SNAPSHOT_PLACEHOLDER', kind: 'action', from: 'C8', note: '结构收口时退出' },
  { token: 'sysbuild_batch_relations', kind: 'table', from: 'C8', note: '结构收口时退出' },
  { token: 'sysbuild_notice_receipts', kind: 'table', from: 'C8', note: '结构收口时退出' },
  { token: 'sysbuild_comments', kind: 'table', from: 'C8', note: '结构收口时退出' },
  { token: 'setup', kind: 'action', from: 'B3.3', note: '项目详情旧三步页签' },
  { token: 'stepper', kind: 'action', from: 'B3.3', note: '旧步骤导航' },
  { token: 'basisStep', kind: 'action', from: 'B3.3', note: '旧立项依据步骤' },
  { token: 'preparationPanel', kind: 'action', from: 'B3.3', note: '旧立项准备概览' },
  { token: 'initiationPreparation', kind: 'action', from: 'B3.3', note: '旧立项准备概览调用' },
  { token: '保存并进入立项准备', kind: 'action', from: 'B3.3', note: '旧建档按钮' },
]);
const RETIRED_SCHEMA_EXEMPT = false;

const retiredWordRe = (token) => new RegExp(`(?<![A-Za-z0-9_])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`);
function retiredLineOf(text, offset) {
  let n = 1;
  for (let i = 0; i < offset; i += 1) if (text.charCodeAt(i) === 10) n += 1;
  return n;
}
// acorn tokenizer：注释不进 token；只留标识符 / 关键字（k=name）、字符串（k=string）、模板静态片段（k=template）
function retiredJsTokens(text, lineBase) {
  const out = [];
  for (const t of acorn.tokenizer(text, { ecmaVersion: 'latest', allowHashBang: true, locations: true })) {
    let k = null;
    let v = null;
    if (t.type === acorn.tokTypes.name || t.type.keyword) { k = 'name'; v = t.value !== undefined && t.value !== null ? t.value : t.type.keyword; } else if (t.type === acorn.tokTypes.string) { k = 'string'; v = t.value; } else if (t.type === acorn.tokTypes.template) { k = 'template'; v = t.value !== null && t.value !== undefined ? t.value : text.slice(t.start, t.end); }
    if (k) out.push({ k, v: String(v), line: t.loc.start.line + lineBase });
  }
  return out;
}
// HTML：<!-- --> 整段换成空白（保留换行，行号对齐）；内联 <script>（无 src、类型为空或 JS）的内容另取出按 JS 分词，在文本里同样换成空白；开始 / 结束标签留在文本里（src 等属性要能被扫到）。
function retiredSplitHtml(text) {
  const re = /<!--[\s\S]*?-->|(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)/gi;
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  const scripts = [];
  let plain = '';
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    plain += text.slice(last, m.index);
    if (m[0].startsWith('<!--')) plain += blank(m[0]);
    else {
      const typeMatch = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(m[1]);
      const type = typeMatch ? typeMatch[1].toLowerCase() : '';
      const isJs = (type === '' || /javascript|ecmascript|^module$/.test(type)) && !/\bsrc\s*=/i.test(m[1]);
      plain += m[1];
      if (isJs) { scripts.push({ text: m[2], line: retiredLineOf(text, m.index + m[1].length) }); plain += blank(m[2]); } else plain += m[2];
      plain += m[3];
    }
    last = m.index + m[0].length;
  }
  plain += text.slice(last);
  return { plain, scripts };
}
// 纯函数：名单 + 文件内容表（[{ rel, kind: 'js'|'html', text }]）+ schema 豁免开关 → findings（[{ rule: 'S13', file, line, msg }]）。名单为空直接返回，不分词。
function retiredFrontendPaths(text, lineBase) {
  const paths = [];
  function shape(node) {
    if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
    if (node.type === 'TemplateLiteral') return node.quasis.map((q) => q.value.cooked ?? '').join(':dynamic');
    if (node.type === 'BinaryExpression' && node.operator === '+') return shape(node.left) + shape(node.right);
    return ':dynamic';
  }
  walk(acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'module', locations: true }), (node) => {
    if (node.type !== 'TemplateLiteral' && !(node.type === 'BinaryExpression' && node.operator === '+')) return;
    const value = shape(node).replace(/^(?::dynamic)+(?=\/)/, '');
    if (value.startsWith('/')) paths.push({ v: value.replace(/^\/(?:api\/)?sysbuild\//, '/'), line: lineBase + node.loc.start.line });
  });
  return paths;
}

function scanRetired(list, files, schemaExempt) {
  const findings = [];
  if (!Array.isArray(list) || list.length === 0) return findings;
  list.forEach((it, i) => {
    if (!it || typeof it.token !== 'string' || it.token === '' || !RETIRED_KINDS.includes(it.kind) || typeof it.from !== 'string' || !RETIRED_FROM_RE.test(it.from)) {
      findings.push({ rule: 'S13', file: 'verify-sysbuild-static.js', line: 0, msg: `RETIRED_IDENTIFIERS[${i}] 形态不合法（要求 token 非空字符串、kind 为 ${RETIRED_KINDS.join(' / ')}、from 为已登记的退役批次）` });
    }
  });
  if (findings.length > 0) return findings;
  const seen = new Set();
  const add = (f, line, it) => {
    const key = `${f.rel}\u0000${line}\u0000${it.token}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ rule: 'S13', file: f.rel, line, msg: `停用标识 ${it.token}（${it.kind}，自 ${it.from} 起）` });
  };
  for (const f of files) {
    if (schemaExempt && f.rel === 'schema.js') continue;
    let tokens;
    let plain = null;
    const frontendPaths = [];
    try {
      if (f.kind === 'html') {
        const sp = retiredSplitHtml(f.text.replace(/\r\n/g, '\n'));
        plain = sp.plain;
        tokens = [];
        for (const s of sp.scripts) {
          tokens.push(...retiredJsTokens(s.text, s.line - 1));
          frontendPaths.push(...retiredFrontendPaths(s.text, s.line - 1));
        }
      } else {
        const source = f.text.replace(/\r\n/g, '\n');
        tokens = retiredJsTokens(source, 0);
        if (f.rel.startsWith('assets/js/')) frontendPaths.push(...retiredFrontendPaths(source, 0));
      }
    } catch (e) {
      findings.push({ rule: 'S13', file: f.rel, line: e.loc ? e.loc.line : 0, msg: `无法分词，停用标识扫描做不了：${e.message}` });
      continue;
    }
    for (const it of list) {
      const loose = it.kind === 'path' || it.kind === 'file'; // path / file 按子串；其余按等值 / 词边界
      const re = loose ? null : retiredWordRe(it.token);
      // file 类 token 以 .js 结尾时再加一个判法（对应不带 .js 的 require）：只对以 ./ 或 ../ 开头的字符串 token 生效，
      //   去掉 .js 后的名字是它的完整最后一个路径段才命中（'./x'、'../sysbuild/x' 算；裸写 'x'、'/x'、'./x-y'、'./x.json'、'./xy' 不算）
      const stem = it.kind === 'file' && it.token.endsWith('.js') && it.token.length > 3 ? it.token.slice(0, -3) : null;
      // 子串口径：path 类纯子串；file 类左侧加路径段边界（命中位置前一个字符必须是开头或 '/'，'sysbuild-x.js' 里的 'x.js' 不算），
      //   且 .js 结尾的 file 类右侧不得紧跟标识符字符（'./x.json' 里的 'x.js' 不算）
      // 左边界含引号、'='、空白：<script src="x.js"> 与 src='x.js' 也要命中（预筛复看 LOW-1）
      const looseRe = loose ? new RegExp((it.kind === 'file' ? '(?<![^/"\'=\\s])' : '') + it.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + (stem !== null ? '(?![A-Za-z0-9_])' : ''), 'g') : null;
      const looseFirst = (text) => { looseRe.lastIndex = 0; const m = looseRe.exec(text); return m ? m.index : -1; };
      if (it.kind === 'path' && it.token.startsWith('/sysbuild/') && frontendPaths.length) {
        const shape = it.token.slice('/sysbuild'.length).split('/').map((segment) =>
          segment.startsWith(':') ? '[^/?#]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        ).join('/');
        const endpoint = new RegExp('^' + shape + '(?:[/?#]|$)');
        for (const candidate of frontendPaths) {
          if (endpoint.test(candidate.v)) add(f, candidate.line, it);
        }
      }
      for (const t of tokens) {
        if (t.k === 'name') { if (!loose && t.v === it.token) add(f, t.line, it); } else if (t.k === 'string') { if (loose ? (looseFirst(t.v) >= 0 || (stem !== null && /^\.\.?\//.test(t.v) && t.v.split('/').pop() === stem)) : re.test(t.v)) add(f, t.line, it); } else if (t.k === 'template') {
          const at = loose ? looseFirst(t.v) : (() => { const m = re.exec(t.v); return m ? m.index : -1; })();
          if (at >= 0) add(f, t.line + (t.v.slice(0, at).match(/\n/g) || []).length, it);
        }
      }
      if (plain !== null) {
        if (loose) {
          looseRe.lastIndex = 0;
          for (let m = looseRe.exec(plain); m !== null; m = looseRe.exec(plain)) add(f, retiredLineOf(plain, m.index), it);
        } else {
          const g = new RegExp(re.source, 'g');
          for (let m = g.exec(plain); m !== null; m = g.exec(plain)) add(f, retiredLineOf(plain, m.index), it);
        }
      }
    }
  }
  return findings;
}
// 真实扫描面：routes/sysbuild/ 全部 .js（rel 相对 root，同 S0–S9）+ public/Sys_Build.html + public/assets/js/sysbuild-*.js（枚举方式同 S10 的 lib/sysbuild-frontend-static.js）。
// 页面或脚本目录读不到由 S10 报，这里不重复。
function collectRetiredFiles(root, publicDir) {
  const files = listJsFiles(root).map((rel) => ({ rel, kind: 'js', text: fs.readFileSync(path.join(root, rel), 'utf8') }));
  try { files.push({ rel: 'Sys_Build.html', kind: 'html', text: fs.readFileSync(path.join(publicDir, 'Sys_Build.html'), 'utf8') }); } catch (e) { /* S10 报 */ }
  try {
    const dir = path.join(publicDir, 'assets', 'js');
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (ent.isFile() && /^sysbuild-.*\.js$/.test(ent.name)) files.push({ rel: `assets/js/${ent.name}`, kind: 'js', text: fs.readFileSync(path.join(dir, ent.name), 'utf8') });
    }
  } catch (e) { /* S10 报 */ }
  return files;
}

function report(root) {
  const { findings, rels } = scan(root);
  const front = frontendStatic.scan(path.join(__dirname, '..', 'public'));
  findings.push(...front.findings);
  findings.push(...frontendStatic.scanNav(path.join(__dirname, '..', 'public')));
  const retiredFiles = collectRetiredFiles(root, path.join(__dirname, '..', 'public'));
  if (RETIRED_IDENTIFIERS.length > 0) findings.push(...scanRetired(RETIRED_IDENTIFIERS, retiredFiles, RETIRED_SCHEMA_EXEMPT));
  console.log(`扫描 ${root}（${rels.length} 个文件: ${rels.join(', ')}）`);
  let passed = 0;
  for (const [id, title] of RULES) {
    const mine = findings.filter((f) => f.rule === id);
    if (mine.length === 0) { passed += 1; console.log(`  PASS [${id}] ${title}`); continue; }
    for (const f of mine) console.log(`  FAIL [${id}] ${f.file}:${f.line} ${f.msg}`);
  }
  console.log(`  前端：Sys_Build.html 与 ${front.files.length} 个本模块脚本（共享脚本不在 S10 扫描范围）`);
  console.log(`  S13：核对 ${RETIRED_IDENTIFIERS.length} 个停用标识；库结构${RETIRED_SCHEMA_EXEMPT ? '豁免' : '纳入'}扫描`);
  console.log(`\n${passed}/${RULES.length} 通过`);
  return passed === RULES.length ? 0 : 1;
}

// ── 自检 ───────────────────────────────────────────────────────────────────────────────
const BT = '`';
const HEAD = "'use strict';\n";

// 注入文件 / 锚点替换。create：在副本里新建文件；from/to：对已有文件做唯一锚点替换。
const MUTATIONS = [
  { id: '#212 B2.3 成员加入时间可被更新', rule: 'S1', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run('UPDATE sysbuild_members SET joined_at = ? WHERE id = ?', [1, 2]);\n` }] },
  { id: '#212 B2.3 任职生效时间可被更新', rule: 'S1', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_appointments SET effective_at = ? WHERE id = ? AND status = 'active'", [1, 2]);\n` }] },
  { id: '#212 B2.3 授权生效时间可被更新', rule: 'S1', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_delegations SET effective_at = ? WHERE id = ? AND status = 'active'", [1, 2]);\n` }] },
  { id: '#212 B2.3 结束任职不检查原状态', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_appointments SET status = 'ended' WHERE id = ?", [1]);\n` }] },
  { id: '#212 B2.3 撤销授权不检查原状态', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_delegations SET status = 'revoked' WHERE id = ?", [1]);\n` }] },
  { id: '#212 B2.3 移出原因不检查原状态', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run('UPDATE sysbuild_members SET removed_reason = ? WHERE id = ?', [1, 2]);\n` }] },
  { id: 'L1 S12 白名单外出现表单存储列', rule: 'S12', edits: [{ create: 'zz_mut.js', text: "'use strict';\nmodule.exports = (row) => row.routing_json;\n" }] },
  { id: 'S0 语法错误的文件', rule: 'S0', edits: [{ create: 'zz_bad.js', text: `${HEAD}module.exports = (;\n` }] },
  { id: 'C5 S13：停用标识名单漏表单种类', rule: 'S13', edits: [{ create: 'zz_mut.js', text: "'use strict';\nmodule.exports = 'dev_assessment';\n" }] },
  { id: 'C5 S13：停用标识名单漏路由字面量', rule: 'S13', edits: [{ create: 'zz_mut.js', text: "'use strict';\nmodule.exports = '/sysbuild/changes/:cid';\n" }] },
  { id: 'C6 S13：停用标识名单漏办理规则名', rule: 'S13', edits: [{ create: 'zz_mut.js', text: "'use strict';\nmodule.exports = 'entry_conclude';\n" }] },
  { id: 'C6 S13：停用标识名单漏异议路由字面量', rule: 'S13', edits: [{ create: 'zz_mut.js', text: "'use strict';\nmodule.exports = '/sysbuild/notices/:nid/object';\n" }] },
  { id: 'C6 S13：停用标识名单漏事件类型字面量', rule: 'S13', edits: [{ create: 'zz_mut.js', text: "'use strict';\nmodule.exports = 'routing_decided';\n" }] },
  { id: 'C7 S13：停用标识名单漏表名', rule: 'S13', edits: [{ create: 'zz_mut.js', text: "'use strict';\nmodule.exports = 'sysbuild_items';\n" }] },
  { id: 'C7 S13：停用标识名单漏动作键', rule: 'S13', edits: [{ create: 'zz_mut.js', text: "'use strict';\nmodule.exports = 'item_create';\n" }] },
  { id: 'C7 S13：停用标识名单漏内部符号', rule: 'S13', edits: [{ create: 'zz_mut.js', text: "'use strict';\nmodule.exports = { recheckOverallSet };\n" }] },
  { id: 'C7 S13：停用标识名单漏事件类型', rule: 'S13', edits: [{ create: 'zz_mut.js', text: "'use strict';\nmodule.exports = 'item_created';\n" }] },
  { id: 'C7 S13：停用标识名单漏路径字面量', rule: 'S13', edits: [{ create: 'zz_mut.js', text: "'use strict';\nmodule.exports = '/sysbuild/items/:iid';\n" }] },
  { id: 'S1 UPDATE 未登记列', rule: 'S1', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_projects SET created_by = ? WHERE id = ?", [1, 2]);\n` }] },
  { id: 'S1 UPDATE 未登记表', rule: 'S1', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_events SET payload_json = ? WHERE id = ?", [1, 2]);\n` }] },
  { id: 'S1 多列 SET 中第二列未登记（第一列含带逗号的函数）', rule: 'S1', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_projects SET status = datetime('now','localtime'), created_by = ? WHERE id = ?", [1, 2]);\n` }] },
  { id: 'S1 模板字符串里的动态表名', rule: 'S1', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q, t) => q.run(${BT}UPDATE \${t} SET name = ? WHERE id = ?${BT}, [1, 2]);\n` }] },
  { id: 'S1 小写 update 语句', rule: 'S1', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run('update sysbuild_projects set created_by = ? where id = ?', [1, 2]);\n` }] },
  { id: 'S1 拼接字符串里的 UPDATE 未登记列', rule: 'S1', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run('UPDATE sysbuild_projects ' + 'SET created_by = ? WHERE id = ?', [1, 2]);\n` }] },
  { id: 'S2 snapshot_json 缺 status = draft', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_package_versions SET snapshot_json = ?, updated_at = datetime('now','localtime') WHERE id = ?", [1, 2]);\n` }] },
  { id: 'S2 条件片段在 OR 分支里', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_package_versions SET snapshot_json = ? WHERE id = ? OR status = 'draft'", [1, 2]);\n` }] },
  { id: 'S2 条件片段在括号内的 OR 里', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_package_versions SET snapshot_json = ? WHERE id = ? AND (status = 'draft' OR 1 = 1)", [1, 2]);\n` }] },
  { id: 'S2 joined_at 缺 joined_at IS NULL', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_members SET removed_at = datetime('now','localtime') WHERE id = ?", [1]);\n` }] },
  { id: 'S2 完全没有 WHERE', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_members SET removed_at = datetime('now','localtime')");\n` }] },
  // C4a：新登记的条件更新（任务修订的终态只从待确认转入；提出人状态只在待确认时改写）
  { id: 'C4a S2 任务修订 status 缺 status = pending', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_confirm_task_revisions SET status = ?, updated_at = datetime('now','localtime') WHERE id = ?", [1, 2]);\n` }] },
  { id: 'C4a S2 任务修订 status_reason 缺 status = pending', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_confirm_task_revisions SET status_reason = ? WHERE id = ? AND rev_no = 1", [1, 2]);\n` }] },
  { id: 'C4a P32 S2 提交回写 form / parent 缺 status = draft', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_package_versions SET form = ?, parent_overall_version_id = ?, updated_at = datetime('now','localtime') WHERE id = ?", [1, 2, 3]);\n` }] },
  { id: 'C4a P32 S2 只改 parent 缺 status = draft', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_package_versions SET parent_overall_version_id = ? WHERE id = ? AND status <> 'effective'", [1, 2]);\n` }] },
  { id: 'C4a 修订批三 M-1 S2 批次 status 缺 status = planning', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_batches SET status = 'active' WHERE id = ?", [1]);\n` }] },
  { id: 'C4a 修订批三 M-1 S2 批次 status 条件在 OR 分支里', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_batches SET status = 'active' WHERE id = ? OR status = 'planning'", [1]);\n` }] },
  { id: 'C6a S2 批次 status 登记片段是 status = ?（旧状态写成字面量不算）', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_batches SET status = 'live' WHERE id = ? AND status = 'active'", [1]);\n` }] },
  { id: 'C6a S2 批次 status 上线 / 撤销的旧状态条件在 OR 分支里', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_batches SET status = ? WHERE id = ? OR status = ?", ['live', 1, 'active']);\n` }] },
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
  { id: '12R-M1 S2 CASE 吞 AND（sysbuild_members）', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run('UPDATE sysbuild_members SET removed_at = ? WHERE CASE WHEN 0 THEN 1 AND removed_at IS NULL AND 1 ELSE 1 END', [1]);\n` }] },
  { id: '12R-M1 S2 标识符前缀伪造（xjoined_at IS NULL 子串含片段但不是登记的那一项）', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run('UPDATE sysbuild_members SET removed_at = ? WHERE id = ? AND xremoved_at IS NULL', [1, 2]);\n` }] },
  { id: '12R-M1 S2 BETWEEN 吞 AND（sysbuild_members）', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run('UPDATE sysbuild_members SET removed_at = ? WHERE id BETWEEN 0 AND removed_at IS NULL AND 1 = 1', [1]);\n` }] },
  { id: '12R-M1 S2 条件更新 WHERE 里的 IN (${…})（白名单之外，收紧后判红）', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q, ids) => q.run(${BT}UPDATE sysbuild_package_versions SET snapshot_json = ? WHERE id IN (\${ids}) AND status = 'draft'${BT}, [1]);\n` }] },
  { id: 'M1 S2 片段只出现在 SQL 字符串字面量里（sysbuild_members）', rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_members SET removed_at = ? WHERE 'AND removed_at IS NULL AND' = 'AND removed_at IS NULL AND'", [1]);\n` }] },
  { id: 'M2 S7 end;', rule: 'S7', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run('end;');\n` }] },
  { id: 'M2 S7 eNd', rule: 'S7', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run('eNd');\n` }] },
  { id: 'M2 S7 前导空白 end', rule: 'S7', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run(' end');\n` }] },
  { id: 'L4 S8 schema.js 里有 INSERT 字符串', rule: 'S8', edits: [{ file: 'schema.js', from: 'const TABLE_NAMES = Object.freeze(TABLES.map(([name]) => name));', to: "const TABLE_NAMES = Object.freeze(TABLES.map(([name]) => name));\nconst sql8 = 'INSERT INTO sysbuild_events (id) VALUES (1)';" }] },
  // ── C2-0（codex 13 号 L-1 / R-2）：字面量项禁空白与 =；S0 校验登记片段形态 ──
  { id: 'C2-0 S0 登记片段字面量含 =（status = \'a=b\'）', rule: 'S0', edits: [{ file: 'schema.js', from: `snapshot_json: "status = 'draft'"`, to: `snapshot_json: "status = 'a=b'"` }] },
  { id: 'C2-0 S0 登记片段含 AND（status = \'draft\' AND id = ?）', rule: 'S0', edits: [{ file: 'schema.js', from: `snapshot_json: "status = 'draft'"`, to: `snapshot_json: "status = 'draft' AND id = ?"` }] },
  { id: 'C2-0 S0 登记片段字面量含空白（status = \'dr aft\'）', rule: 'S0', edits: [{ file: 'schema.js', from: `snapshot_json: "status = 'draft'"`, to: `snapshot_json: "status = 'dr aft'"` }] },
  { id: "C2-0 S2 条件更新 WHERE 追加非登记项 note = 'x=y'（字面量含 =）", rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_members SET removed_at = ? WHERE removed_at IS NULL AND note = 'x=y'", [1]);\n` }] },
  { id: 'C2-0 S0 整表登记值改成字符串（\'joined_at IS NULL\'）', rule: 'S0', edits: [{ file: 'schema.js', from: "sysbuild_members: Object.freeze({ removed_at: 'removed_at IS NULL', removed_reason: 'removed_at IS NULL' })", to: "sysbuild_members: 'removed_at IS NULL'" }] },
  { id: 'C2-0 S0 整表登记值改成数组', rule: 'S0', edits: [{ file: 'schema.js', from: "sysbuild_members: Object.freeze({ removed_at: 'removed_at IS NULL', removed_reason: 'removed_at IS NULL' })", to: "sysbuild_members: Object.freeze(['removed_at IS NULL'])" }] },
  { id: 'C2-0 S0 登记列名写错（joinedat 不在 UPDATABLE_COLUMNS 登记列内）', rule: 'S0', edits: [{ file: 'schema.js', from: "Object.freeze({ removed_at: 'removed_at IS NULL', removed_reason: 'removed_at IS NULL' })", to: "Object.freeze({ joinedat: 'removed_at IS NULL' })" }] },
  { id: 'C2-0 S0 登记表名写错（sysbuild_member 不在 UPDATABLE_COLUMNS）', rule: 'S0', edits: [{ file: 'schema.js', from: "sysbuild_members: Object.freeze({ removed_at: 'removed_at IS NULL', removed_reason: 'removed_at IS NULL' })", to: "sysbuild_member: Object.freeze({ removed_at: 'removed_at IS NULL', removed_reason: 'removed_at IS NULL' })" }] },
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
    { file: 'schema.js', from: "removed_at: 'removed_at IS NULL'", to: 'removed_at: undefined' },
    { create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_members SET removed_at = ? WHERE id = ? AND removed_at IS NULL", [1, 2]);\n` },
  ] },
  { id: "C2-0 S2 条件更新 WHERE 追加非登记项 note = 'x y'（字面量含空白）", rule: 'S2', edits: [{ create: 'zz_mut.js', text: `${HEAD}module.exports = (q) => q.run("UPDATE sysbuild_members SET removed_at = ? WHERE removed_at IS NULL AND note = 'x y'", [1]);\n` }] },
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
      '  await q.run("UPDATE sysbuild_members SET removed_at = datetime(\'now\',\'localtime\') WHERE removed_at IS NULL AND id = ?", [1]);',
      "  await q.run(\"UPDATE sysbuild_appointments SET status = 'ended', ended_at = datetime('now','localtime'), end_reason = ? WHERE id = ? AND status = 'active'\", ['结束', 1]);",
      "  await q.run(\"UPDATE sysbuild_delegations SET status = 'revoked', revoked_at = datetime('now','localtime'), revoke_reason = ? WHERE id = ? AND status = 'active'\", ['撤销', 1]);",
      "  await q.run('UPDATE sysbuild_members SET removed_reason = ? WHERE removed_at IS NULL AND id = ?', ['移出', 1]);",
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
      "  await q.run('UPDATE sysbuild_members SET removed_at = datetime(\\'now\\',\\'localtime\\') WHERE\\n    id = ?\\n    AND removed_at IS NULL', [1]);",
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
  const mutRec = require('./lib/sysbuild-mut-record'); // C1c：机器基线输出（只在 SYSBUILD_MUT_RECORD=1 时多打 @@MUT 行）；放在函数内，守卫副本（不进自检）不依赖它
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
  check(whereHasConjunct('id = ? AND removed_at IS NULL', 'removed_at IS NULL') === 'ok', '函数级：正例 id = ? AND removed_at IS NULL 仍为 ok');
  // codex 14 号 M-2 纵深防御：非字符串片段不抛异常，且不为 ok（期望手写：只要求「不抛、不是 ok」）。
  for (const [label, bad] of [['null', null], ['数字 1', 1], ['undefined', undefined]]) {
    let threw = false;
    let got = null;
    try { got = whereHasConjunct('id = ? AND removed_at IS NULL', bad); } catch (e) { threw = true; }
    check(!threw && got !== 'ok', `函数级：片段为 ${label} 时 whereHasConjunct 不抛异常且不为 ok（${threw ? '抛了异常' : `返回 ${got}`}）`);
  }

  // 函数级断言（#212 C1b，S13 停用标识骨架）：直接调用 scanRetired，不走子进程变异；名单与文件内容都是合成的，期望值手写。
  const RT = [{ token: 'sysbuild_zz_retired', kind: 'table', from: 'C2' }];
  const rJs = (text, rel) => ({ rel: rel || 'zz_r.js', kind: 'js', text });
  const retiredFixture = [{ token: '/sysbuild/projects/:id/items', kind: 'path', from: 'C7' }];
  const scanFront = (source) => scanRetired(retiredFixture, [rJs(source, 'assets/js/sysbuild-probe.js')], false);
  check(scanFront('A.request("/projects/" + pid + "/items");').length === 1, 'S13：前端拼接的停用路由判红');
  check(scanFront('A.request(`/projects/${pid}/items`);').length === 1, 'S13：前端模板的停用路由判红');
  check(scanFront('A.request("/projects/" + pid + "/materials");').length === 0, 'S13：保留材料路由仍通过');
  const rHtml = (text) => ({ rel: 'Sys_Build.html', kind: 'html', text });
  check(scanFront('A.request(API + "/projects/" + pid + "/items");').length === 1, 'S13：变量前缀与静态停用路径拼接判红');
  check(scanFront('A.request(`${API}/api/sysbuild/projects/${pid}/items`);').length === 1, 'S13：变量前缀的停用路径模板判红');
  check(scanFront('A.request(API + "/projects/" + pid + "/materials");').length === 0, 'S13：变量前缀的保留路径不受影响');
  check(scanRetired(retiredFixture, [rHtml('<script>A.request(API + "/projects/" + pid + "/items");</script>')], false).length === 1,
    'S13：HTML 内联脚本内的停用路由判红');
  const c8Actions = RETIRED_IDENTIFIERS.filter((it) => it.from === 'C8' && it.kind === 'action');
  const oldC8Values = ['proposer_confirm', 'handover_accept', 'accept_invitation', 'delegation_grant', 'batch_req', 'handover_snapshot_json', 'HANDOVER_SNAPSHOT_PLACEHOLDER'];
  for (const value of oldC8Values) {
    check(scanRetired(c8Actions, [rJs('const value = ' + JSON.stringify(value) + ';')], false).length === 1, 'S13：C8 退役值 ' + value + ' 判红');
  }
  check(scanRetired(c8Actions, [rJs("const kept = ['overall_batch_req', 'delegation_accept'];")], false).length === 0,
    'S13：保留的合并形态及授权接受均通过');
  const rRun = (files, list, exempt) => scanRetired(list || RT, files, exempt === undefined ? true : exempt);
  // C5（生效清单第六节）：名单里每个 C5 标识放回扫描面都必须判红（路径 / 文件类按字符串字面量，其余按字符串词边界；名单只增不改，这里逐个对照）
  {
    const c5List = RETIRED_IDENTIFIERS.filter((it) => it.from === 'C5');
    const missed = c5List.filter((it) => scanRetired([it], [rJs(`module.exports = ${JSON.stringify(it.kind === 'file' ? `assets/js/${it.token}` : it.token)};\n`)], true).length !== 1).map((it) => it.token);
    check(c5List.length === 36 && missed.length === 0, `S13 C5 名单：36 个标识（路由 4、文件 2、表单种类 2、事件 5（含同名动作规则键 change_new_version）、动作规则键与办理动作 3、待办类别 1、导出名 19）逐个放回扫描面都判红（名单 ${c5List.length} 个；漏判：${missed.join('、') || '无'}）`);
    // 151-M1：独立的预期名单——手写自清单第六节（标识 + 类别，路由 / 文件 / 表单种类 / 事件类型 / 动作规则键与办理动作 / 待办类别 / 导出名），不从被测的 RETIRED_IDENTIFIERS 生成；
    //   上面的逐个判红只证明「名单里的每一项都能判红」，证明不了名单就是清单第六节：把 loadChangeCtx 误换成已登记的 changeView，总数仍是 36、每项各自仍命中一次，只有与独立名单比对才报缺项 / 多项 / 重复。
    const EXPECT_C5 = Object.freeze([
      ['path', '/sysbuild/projects/:id/changes'], ['path', '/sysbuild/changes/:cid'], ['path', '/sysbuild/changes/:cid/new-version'], ['path', '/sysbuild/changes/:cid/submit'],
      ['file', 'changes.js'], ['file', 'assessment-view.js'],
      ['action', 'change_request'], ['action', 'dev_assessment'],
      ['event', 'change_created'], ['event', 'change_submitted'], ['event', 'change_withdrawn'], ['event', 'change_new_version'], ['event', 'change_effective'],
      ['action', 'change_create'], ['action', 'entry_link_change'], ['action', 'link_change'],
      ['action', 'change_assess'],
      ['action', 'createChangeRoutes'], ['action', 'createChangeDraft'], ['action', 'applyChangeEffect'], ['action', 'submittedAssessmentView'], ['action', 'devAssessmentOf'],
      ['action', 'CHANGE_DRAFT_ABANDONED_REASON'], ['action', 'CHANGE_FACT_UNKNOWN_MESSAGE'], ['action', 'renderChangeRows'], ['action', 'renderAssessmentRows'], ['action', 'renderChangeImpact'],
      ['action', 'assessmentView'], ['action', 'changeForm'], ['action', 'numberField'], ['action', 'CHANGE_LABELS'], ['action', 'FEASIBLE_LABELS'], ['action', 'checkJsonValue'],
      ['action', 'newVersionFacts'], ['action', 'changeView'], ['action', 'loadChangeCtx'],
    ]);
    const nameKey = (kind, token) => `${kind} ${token}`;
    const expectKeys = EXPECT_C5.map(([kind, token]) => nameKey(kind, token));
    const diffNames = (list) => {
      const seen = new Map();
      for (const it of list) seen.set(nameKey(it.kind, it.token), (seen.get(nameKey(it.kind, it.token)) || 0) + 1);
      return {
        missing: expectKeys.filter((k) => !seen.has(k)),
        extra: Array.from(seen.keys()).filter((k) => !expectKeys.includes(k)),
        duplicated: Array.from(seen.entries()).filter(([, n]) => n > 1).map(([k]) => k),
      };
    };
    const dReal = diffNames(c5List);
    check(EXPECT_C5.length === 36 && new Set(expectKeys).size === 36 && dReal.missing.length === 0 && dReal.extra.length === 0 && dReal.duplicated.length === 0,
      `S13 C5 名单与独立预期名单（清单第六节手写 ${EXPECT_C5.length} 项，标识 + 类别）全等（缺项：${dReal.missing.join('、') || '无'}；多项：${dReal.extra.join('、') || '无'}；重复：${dReal.duplicated.join('、') || '无'}）`);
    // 比对函数自身的判别力：合成名单（期望值手写）——把 loadChangeCtx 换成 changeView（总数仍 36、两项各命中一次）、少一项、多一项、类别写错，各自必须被报出
    const swapped = c5List.map((it) => (it.token === 'loadChangeCtx' ? { ...it, token: 'changeView' } : it));
    const dSwap = diffNames(swapped);
    check(swapped.length === 36 && dSwap.missing.join('|') === 'action loadChangeCtx' && dSwap.duplicated.join('|') === 'action changeView' && dSwap.extra.length === 0, `S13 名单比对函数级：loadChangeCtx 误换成已登记的 changeView（总数仍 36）→ 报缺项 loadChangeCtx 与重复 changeView（实际缺项 ${dSwap.missing.join('、') || '无'}；重复 ${dSwap.duplicated.join('、') || '无'}）`);
    // 152-L3：缺项样本改为按标识与类别从名单里删指定项（不再用 slice(1) 写死「第一项是项目变更路由」），每个样本分别比 missing / extra / duplicated 三个集合；类别写错样本同时核多出项与缺项
    const dropOne = diffNames(c5List.filter((it) => !(it.kind === 'path' && it.token === '/sysbuild/projects/:id/changes')));
    const addOne = diffNames(c5List.concat([{ token: 'zzExtra', kind: 'action', from: 'C5' }]));
    const wrongKind = diffNames(c5List.map((it) => (it.token === 'change_assess' ? { ...it, kind: 'event' } : it)));
    check(dropOne.missing.join('|') === 'path /sysbuild/projects/:id/changes' && dropOne.extra.length === 0 && dropOne.duplicated.length === 0
      && addOne.extra.join('|') === 'action zzExtra' && addOne.missing.length === 0 && addOne.duplicated.length === 0
      && wrongKind.extra.join('|') === 'event change_assess' && wrongKind.missing.join('|') === 'action change_assess' && wrongKind.duplicated.length === 0,
    'S13 名单比对函数级：少一项报缺项（三集合逐个核）、多一项报多项、类别写错（change_assess 写成 event）报多项与缺项');
    // 151-L1：导出名以代码标识符出现的形态（具名导出 / 解构导入）也必须判红——上面的逐个判红只放了字符串字面量，扫描器若只认 'createChangeRoutes' 这种字面量、漏掉标识符形态，那组断言仍会通过
    const identTokens = c5List.filter((it) => /^[A-Za-z_$][\w$]*$/.test(it.token));
    const missedIdent = identTokens.filter((it) => scanRetired([it], [rJs(`module.exports = { ${it.token} };\n`)], true).length !== 1 || scanRetired([it], [rJs(`const { ${it.token} } = require('./zz_x');\n`)], true).length !== 1).map((it) => it.token);
    check(identTokens.length === 30 && missedIdent.length === 0, `S13 C5 名单：30 个标识符形态的标识（${identTokens.length} 个，除去 4 条路由与 2 个文件名）以具名导出 \`module.exports = { x }\` 与解构导入 \`const { x } = require(…)\` 的代码标识符形态放回扫描面也都判红（漏判：${missedIdent.join('、') || '无'}）`);
  }
  // C6（生效清单 v1.3 第六节）：141 个标识逐个放回判红、与独立预期名单全等、比对函数判别力、标识符形态、对照组（保留标识放进扫描面不报）
  {
    const c6List = RETIRED_IDENTIFIERS.filter((it) => it.from === 'C6');
    const missed6 = c6List.filter((it) => scanRetired([it], [rJs(`module.exports = ${JSON.stringify(it.kind === 'file' ? `assets/js/${it.token}` : it.token)};\n`)], true).length !== 1).map((it) => it.token);
    check(c6List.length === 141 && missed6.length === 0, `S13 C6 名单：141 个标识（路由 1、文件 1、事件 4、动作规则键 14、办理动作名 7、待办与阻塞码 3、键 4、表 4、导出名与内部符号 103）逐个放回扫描面都判红（名单 ${c6List.length} 个；漏判：${missed6.join('、') || '无'}）`);
    // 独立的预期名单：手写自清单第六节（标识 + 类别），不从被测的 RETIRED_IDENTIFIERS 生成；逐个判红只证明「名单里每一项都能判红」，证明不了名单就是第六节
    const EXPECT_C6 = Object.freeze([
      // 路由（1）
      ['path', '/sysbuild/notices/:nid/object'],
      // 文件（1）
      ['file', 'entries-routing.js'],
      // 事件类型（4）
      ['event', 'routing_decided'], ['event', 'routing_assigned'], ['event', 'entry_split'], ['event', 'notice_objected'],
      // 动作规则键（14）
      ['action', 'entry_conclude'], ['action', 'entry_for_reference'], ['action', 'entry_mark_commitment'], ['action', 'entry_unmark_commitment'],
      ['action', 'entry_mark_risk'], ['action', 'entry_unmark_risk'], ['action', 'entry_escalate'], ['action', 'entry_assign_items'],
      ['action', 'entry_link_sys_issue'], ['action', 'entry_object'], ['action', 'notice_object'], ['action', 'schedule_notice_object'],
      ['action', 'entry_conclusion_decide'], ['action', 'entry_conclusion_reissue'],
      // 办理动作名（7）
      ['action', 'for_reference'], ['action', 'mark_commitment'], ['action', 'unmark_commitment'], ['action', 'mark_risk'],
      ['action', 'unmark_risk'], ['action', 'assign_items'], ['action', 'link_sys_issue'],
      // 待办与阻塞码（3）
      ['action', 'entry_unresolved'], ['action', 'ENTRY_UNRESOLVED'], ['action', 'ENTRY_FACTS_MISSING'],
      // 请求键 / 前端键 / 响应键（4）
      ['action', 'self_confirm_text'], ['action', 'self_ack'], ['action', 'post_close_objections_open'], ['action', 'to_change'],
      // 表（4）
      ['table', 'sysbuild_notice_objections'], ['table', 'sysbuild_routing_snapshots'], ['table', 'sysbuild_entry_items'], ['table', 'sysbuild_changes'],
      // 导出名与内部符号 · rules.js（23）
      ['action', 'ENTRY_CONCLUSION_STATES'], ['action', 'EFFECTIVE_CONCLUSION_STATES'], ['action', 'CONCLUDE_FROM_STATES'], ['action', 'FOR_REFERENCE_FROM_STATES'],
      ['action', 'ENTRY_OPEN_OBJECTION_STATES'], ['action', 'ENTRY_HANDLED_TYPES'], ['action', 'ENTRY_DEV_PURPOSES'], ['action', 'DEV_CONFIRM_PROJECT_MESSAGE'],
      ['action', 'ENTRY_DEV_NOT_APPROVED_SPLIT_MESSAGE'], ['action', 'devConfirmProjectBlock'], ['action', 'ENTRY_CONFIRMER_UNAVAILABLE_MESSAGE'], ['action', 'ENTRY_OUT_OF_PLAN_PROJECT_MESSAGE'],
      ['action', 'ENTRY_SYS_ITERATION_ROUTE_MESSAGE'], ['action', 'ENTRY_SYS_ITERATION_REFERENCE_MESSAGE'], ['action', 'ENTRY_SPLIT_FROM_STATES'], ['action', 'ENTRY_OBJECTOR_BASES'],
      ['action', 'ENTRY_TASK_OBJECT_TYPES'], ['action', 'ENTRY_SPLIT_CONTAINER_MESSAGE'], ['action', 'entryStateKnown'], ['action', 'entryConfirmerState'],
      ['action', 'NOTICE_OBJECTOR_BASES'], ['action', 'canObjectNotice'], ['action', 'CONCLUSION_KINDS_FINAL'],
      // 导出名与内部符号 · entries-core.js（38）
      ['action', 'to_change_lapsed'], ['action', 'changeStatusOf'], ['action', 'SNAPSHOT_COLS'], ['action', 'SUPERSEDED_BY_NEW_CONCLUSION'],
      ['action', 'ENTRY_VOIDED_REASON'], ['action', 'ESCALATED_CLOSED_BY_TERMINATION_REASON'], ['action', 'resolveConclusionConfirmer'], ['action', 'resolveAdjudicator'],
      ['action', 'confirmerView'], ['action', 'CONCLUDE_STATE_OF_REVISION'], ['action', 'ADJUDICATE_STATE_OF_REVISION'], ['action', 'returnedToHandling'],
      ['action', 'deriveContainerState'], ['action', 'entryResolved'], ['action', 'currentItemRowsOf'], ['action', 'currentRoutingOf'],
      ['action', 'unresolvedProcessEntriesOf'], ['action', 'postCloseObjectionsOf'], ['action', 'objectorBasisOf'], ['action', 'ensureEntryFrozen'],
      ['action', 'closePendingEntryRevisions'], ['action', 'loadEntryTaskObject'], ['action', 'entryTaskObjectView'], ['action', 'DEV_CANCELLED_COMMITMENT_REASON'],
      ['action', 'DEV_VOIDED_REASON'], ['action', 'DEV_PURPOSES'], ['action', 'DEV_STATUS_OF_REVISION'], ['action', 'entryNeedsDevConfirm'],
      ['action', 'devConfirmOf'], ['action', 'devApprovalUsable'], ['action', 'devOwnerSelfSubmit'], ['action', 'requestDevConfirm'],
      ['action', 'invalidatePendingDevRevisions'], ['action', 'loadDevTaskObject'], ['action', 'devEntryTaskObjectView'], ['action', 'entryVoidedOf'],
      ['action', 'usedAsScheduleKey'], ['action', 'usedAsBasis'],
      // 导出名与内部符号 · entries.js（16）
      ['action', 'LATER_ACTIONS'], ['action', 'LATER_ACTION_MESSAGE'], ['action', 'ADJUDICATE_ACTION_MESSAGE'], ['action', 'OBJECTION_KEYS'],
      ['action', 'OBJECTION_TYPES'], ['action', 'DEV_CONFIRM_LABELS'], ['action', 'devConfirmView'], ['action', 'currentConclusionOf'],
      ['action', 'noticeView'], ['action', 'noticeTarget'], ['action', 'recipientUserOf'], ['action', 'scheduleNoticeTarget'],
      ['action', 'SYS_ISSUE_MAX'], ['action', 'ASSIGNEE_MAX'], ['action', 'ITEM_IDS_MAX'], ['action', 'readFlag'],
      // 导出名与内部符号 · confirm.js / confirm-core.js（8）
      ['action', 'ENTRY_TASK_PURPOSES'], ['action', 'ENTRY_TASK_DECISIONS'], ['action', 'ENTRY_TASK_DECISION_MESSAGES'], ['action', 'assertEntryTaskDecision'],
      ['action', 'isEntryTask'], ['action', 'decideOpOf'], ['action', 'reissueOpOf'], ['action', 'resolveEntryReissue'],
      // 导出名与内部符号 · entries-routing.js（16）
      ['action', 'GROUP_ORDER'], ['action', 'CANCELLED_WITH_PARENT_TEXT'], ['action', 'ASSIGN_BASES'], ['action', 'ASSIGN_ROUTES'],
      ['action', 'liveGoliveOf'], ['action', 'classifyItems'], ['action', 'planParts'], ['action', 'snapshotRowsOfPart'],
      ['action', 'appendSnapshots'], ['action', 'describeLiveItems'], ['action', 'liveRejection'], ['action', 'createChildEntry'],
      ['action', 'splitIntoParts'], ['action', 'planManualSplit'], ['action', 'planAssignment'], ['action', 'objectionFacts'],
      // 导出名与内部符号 · plan.js（2）
      ['action', 'devKeyEntryId'], ['action', 'entryUnresolved'],
    ]);
    const nameKey6 = (kind, token) => `${kind} ${token}`;
    const expectKeys6 = EXPECT_C6.map(([kind, token]) => nameKey6(kind, token));
    const diffNames6 = (list) => {
      const seen = new Map();
      for (const it of list) seen.set(nameKey6(it.kind, it.token), (seen.get(nameKey6(it.kind, it.token)) || 0) + 1);
      return {
        missing: expectKeys6.filter((k) => !seen.has(k)),
        extra: Array.from(seen.keys()).filter((k) => !expectKeys6.includes(k)),
        duplicated: Array.from(seen.entries()).filter(([, n]) => n > 1).map(([k]) => k),
      };
    };
    const dReal6 = diffNames6(c6List);
    const kindCount6 = (list) => ['path', 'file', 'event', 'action', 'table'].map((k) => list.filter((it) => it.kind === k).length).join('/');
    check(EXPECT_C6.length === 141 && new Set(expectKeys6).size === 141 && dReal6.missing.length === 0 && dReal6.extra.length === 0 && dReal6.duplicated.length === 0,
      `S13 C6 名单与独立预期名单（清单第六节手写 ${EXPECT_C6.length} 项，标识 + 类别）全等（缺项：${dReal6.missing.join('、') || '无'}；多项：${dReal6.extra.join('、') || '无'}；重复：${dReal6.duplicated.join('、') || '无'}）`);
    check(kindCount6(c6List) === '1/1/4/131/4' && kindCount6(EXPECT_C6.map(([kind, token]) => ({ kind, token }))) === '1/1/4/131/4', `S13 C6 名单按类别计数 path 1 / file 1 / event 4 / action 131 / table 4（九组里五组共用 action，不按组断言；实际 ${kindCount6(c6List)}）`);
    // 比对函数自身的判别力（期望值手写）：①少一项报缺项；②多一项报多项；③总数不变但把 entry_conclude 误写成已登记的 entry_for_reference 报缺项与重复；④类别写错（notice_objected 写成 action）报多项与缺项
    const swapped6 = c6List.map((it) => (it.token === 'entry_conclude' ? { ...it, token: 'entry_for_reference' } : it));
    const dSwap6 = diffNames6(swapped6);
    check(swapped6.length === 141 && dSwap6.missing.join('|') === 'action entry_conclude' && dSwap6.duplicated.join('|') === 'action entry_for_reference' && dSwap6.extra.length === 0, `S13 C6 名单比对函数级：entry_conclude 误换成已登记的 entry_for_reference（总数仍 141）→ 报缺项 entry_conclude 与重复 entry_for_reference（实际缺项 ${dSwap6.missing.join('、') || '无'}；重复 ${dSwap6.duplicated.join('、') || '无'}）`);
    const dropOne6 = diffNames6(c6List.filter((it) => !(it.kind === 'path' && it.token === '/sysbuild/notices/:nid/object')));
    const addOne6 = diffNames6(c6List.concat([{ token: 'zzExtra6', kind: 'action', from: 'C6' }]));
    check(dropOne6.missing.join('|') === 'path /sysbuild/notices/:nid/object' && dropOne6.extra.length === 0 && dropOne6.duplicated.length === 0
      && addOne6.extra.join('|') === 'action zzExtra6' && addOne6.missing.length === 0 && addOne6.duplicated.length === 0, 'S13 C6 名单比对函数级：按标识与类别删一项报缺项、多一项报多项（三集合逐个核）');
    const wrongKind6 = diffNames6(c6List.map((it) => (it.token === 'notice_objected' ? { ...it, kind: 'action' } : it)));
    check(wrongKind6.extra.join('|') === 'action notice_objected' && wrongKind6.missing.join('|') === 'event notice_objected' && wrongKind6.duplicated.length === 0, 'S13 C6 名单比对函数级：类别写错（notice_objected 写成 action）报多项与缺项');
    // 导出名以代码标识符出现的形态（具名导出 / 解构导入）也必须判红：除去 1 条路由与 1 个文件名，其余 139 个都是标识符形态
    const identTokens6 = c6List.filter((it) => /^[A-Za-z_$][\w$]*$/.test(it.token));
    const missedIdent6 = identTokens6.filter((it) => scanRetired([it], [rJs(`module.exports = { ${it.token} };\n`)], true).length !== 1 || scanRetired([it], [rJs(`const { ${it.token} } = require('./zz_x');\n`)], true).length !== 1).map((it) => it.token);
    check(identTokens6.length === 139 && missedIdent6.length === 0, `S13 C6 名单：139 个标识符形态的标识（${identTokens6.length} 个，除去 1 条路由与 1 个文件名）以具名导出 module.exports = { x } 与解构导入 const { x } = require(…) 的代码标识符形态放回扫描面也都判红（漏判：${missedIdent6.join('、') || '无'}）`);
    // 规则键 entry_split 与事件类型同名、只登记一次：对象键形态（OBJECT_OPS 里 entry_split: Object.freeze({…})）也必须命中（写法同 C6 子进程变异的合成文件）
    check(scanRetired(c6List.filter((it) => it.token === 'entry_split'), [rJs("const OBJECT_OPS = { entry_split: Object.freeze({ can: () => true }) };\n")], true).length === 1, 'S13 C6 名单：entry_split 的对象键形态（OBJECT_OPS 里 entry_split: Object.freeze({…})）放回扫描面判红');
    // 对照组（必须绿）：保留标识放进扫描面都不报，防名单误收保留标识
    const keep6 = ['entry_create_dev', 'entry_void', 'entry_correct', 'milestone_warning', 'routing_json', 'dev_key_entry_id', 'commitment_flag', 'is_risk', 'change_id', 'purpose', 'conclusion_confirm', 'adjudicate', 'dev_key_confirm', 'RETAINED_ON_TERMINATE_PURPOSES', 'INVALIDATED_ON_TERMINATE_PURPOSES', 'myNoticeItems', 'scheduleNoticeView', 'createScheduleNotices', 'scheduleNoticeObjectorFacts'];
    const keepText6 = keep6.map((t) => `const o_${t} = { ${t}: 1 }; const s_${t} = '${t}'; module.exports.${t} = ${t};`).join('\n') + "\nrouter.get('/sysbuild/my/notices', h);\nrouter.get('/sysbuild/notices/:nid', h);\nconst parts = text.split(',');\n";
    const keepHit6 = scanRetired(c6List, [rJs(keepText6)], true);
    check(keepHit6.length === 0, `S13 C6 对照组：保留标识（${keep6.length} 个标识、/sysbuild/my/notices、/sysbuild/notices/:nid、.split( 属性访问）放进扫描面都不报（误报：${keepHit6.map((h) => h.msg).join('；') || '无'}）`);
  }
  // C7（提交卡 v1.0 主表末节）：54 个标识逐个放回判红、与独立预期名单全等、比对函数判别力、标识符形态、对照组（保留标识放进扫描面不报）
  {
    const c7List = RETIRED_IDENTIFIERS.filter((it) => it.from === 'C7');
    const missed7 = c7List.filter((it) => scanRetired([it], [rJs(`module.exports = ${JSON.stringify(it.kind === 'file' ? `assets/js/${it.token}` : it.token)};\n`)], true).length !== 1).map((it) => it.token);
    check(c7List.length === 54 && missed7.length === 0, `S13 C7 名单：54 个标识（表 4、动作规则键 7、导出名与内部符号 28、事件 9、路径 6）逐个放回扫描面都判红（名单 ${c7List.length} 个；漏判：${missed7.join('、') || '无'}）`);
    // 独立的预期名单：手写自提交卡主表末节（标识 + 类别），不从被测的 RETIRED_IDENTIFIERS 生成
    const EXPECT_C7 = Object.freeze([
      // 表（4）
      ['table', 'sysbuild_modules'], ['table', 'sysbuild_items'], ['table', 'sysbuild_item_versions'], ['table', 'sysbuild_package_item_revisions'],
      // 动作规则键（7）
      ['action', 'module_create'], ['action', 'module_rename'], ['action', 'item_create'], ['action', 'item_version_create'],
      ['action', 'item_set_module'], ['action', 'package_item_add'], ['action', 'package_item_remove'],
      // 导出名与内部符号 · 后端（23）
      ['action', 'canRegisterItem'], ['action', 'canCreateItemVersion'], ['action', 'moduleNameState'], ['action', 'createItemRoutes'],
      ['action', 'resolveCurrentPlan'], ['action', 'foldRevisions'], ['action', 'loadFoldedSet'], ['action', 'loadRevisionRows'],
      ['action', 'recheckOverallSet'], ['action', 'canonicalJson'], ['action', 'evidenceCount'], ['action', 'liveFreezeBreaches'],
      ['action', 'isFrozenLiveBatch'], ['action', 'createProposerTask'], ['action', 'supersedeProposerRevisions'], ['action', 'ITEM_SUPERSEDED_REASON'],
      ['action', 'PROPOSER_DENIED_REISSUE_MESSAGE'], ['action', 'itemFrozenViews'], ['action', 'renderItem'], ['action', 'proposerDetail'],
      ['action', 'mapProposerStatus'], ['action', 'scope_digest'], ['action', 'digestInput'],
      // 前端内部符号（5）
      ['action', 'itemForm'], ['action', 'itemsTab'], ['action', 'addItemToVersion'], ['action', 'evidenceDeclaration'], ['action', 'proposerStates'],
      // 事件类型（9）
      ['event', 'module_created'], ['event', 'module_renamed'], ['event', 'item_created'], ['event', 'item_version_created'],
      ['event', 'item_module_changed'], ['event', 'package_item_added'], ['event', 'package_item_removed'], ['event', 'item_proposer_status_changed'],
      ['event', 'confirm_revision_superseded'],
      // 路径（6）
      ['path', '/sysbuild/projects/:id/modules'], ['path', '/sysbuild/modules/:mid'], ['path', '/sysbuild/projects/:id/items'],
      ['path', '/sysbuild/items/:iid'], ['path', '/sysbuild/items/:iid/versions'], ['path', '/sysbuild/package-versions/:vid/items'],
    ]);
    const nameKey7 = (kind, token) => `${kind} ${token}`;
    const expectKeys7 = EXPECT_C7.map(([kind, token]) => nameKey7(kind, token));
    const diffNames7 = (list) => {
      const seen = new Map();
      for (const it of list) seen.set(nameKey7(it.kind, it.token), (seen.get(nameKey7(it.kind, it.token)) || 0) + 1);
      return {
        missing: expectKeys7.filter((k) => !seen.has(k)),
        extra: Array.from(seen.keys()).filter((k) => !expectKeys7.includes(k)),
        duplicated: Array.from(seen.entries()).filter(([, n]) => n > 1).map(([k]) => k),
      };
    };
    const dReal7 = diffNames7(c7List);
    const kindCount7 = (list) => ['path', 'file', 'event', 'action', 'table'].map((k) => list.filter((it) => it.kind === k).length).join('/');
    check(EXPECT_C7.length === 54 && new Set(expectKeys7).size === 54 && dReal7.missing.length === 0 && dReal7.extra.length === 0 && dReal7.duplicated.length === 0 && kindCount7(c7List) === '6/0/9/35/4' && kindCount7(EXPECT_C7.map(([kind, token]) => ({ kind, token }))) === '6/0/9/35/4',
      `S13 C7 名单与独立预期名单（提交卡手写 ${EXPECT_C7.length} 项，标识 + 类别）全等，类别计数 path 6 / file 0 / event 9 / action 35 / table 4（缺项：${dReal7.missing.join('、') || '无'}；多项：${dReal7.extra.join('、') || '无'}；重复：${dReal7.duplicated.join('、') || '无'}；实际计数 ${kindCount7(c7List)}）`);
    // 比对函数自身的判别力（期望值手写）：①少一项报缺项；②多一项报多项；③总数不变但把 module_create 误写成已登记的 module_rename 报缺项与重复；④类别写错（module_created 写成 action）报多项与缺项
    const swapped7 = c7List.map((it) => (it.token === 'module_create' ? { ...it, token: 'module_rename' } : it));
    const dSwap7 = diffNames7(swapped7);
    const dropOne7 = diffNames7(c7List.filter((it) => !(it.kind === 'path' && it.token === '/sysbuild/items/:iid')));
    const addOne7 = diffNames7(c7List.concat([{ token: 'zzExtra7', kind: 'action', from: 'C7' }]));
    const wrongKind7 = diffNames7(c7List.map((it) => (it.token === 'module_created' ? { ...it, kind: 'action' } : it)));
    check(swapped7.length === 54 && dSwap7.missing.join('|') === 'action module_create' && dSwap7.duplicated.join('|') === 'action module_rename' && dSwap7.extra.length === 0
      && dropOne7.missing.join('|') === 'path /sysbuild/items/:iid' && dropOne7.extra.length === 0 && dropOne7.duplicated.length === 0
      && addOne7.extra.join('|') === 'action zzExtra7' && addOne7.missing.length === 0 && addOne7.duplicated.length === 0
      && wrongKind7.extra.join('|') === 'action module_created' && wrongKind7.missing.join('|') === 'event module_created' && wrongKind7.duplicated.length === 0,
    'S13 C7 名单比对函数级：module_create 误换成已登记的 module_rename（总数仍 54）报缺项与重复；删一项报缺项、多一项报多项（三集合逐个核）；类别写错（module_created 写成 action）报多项与缺项');
    // 标识符形态（具名导出 / 解构导入）也必须判红：除去 6 条路径，其余 48 个都是标识符形态
    const identTokens7 = c7List.filter((it) => /^[A-Za-z_$][\w$]*$/.test(it.token));
    const missedIdent7 = identTokens7.filter((it) => scanRetired([it], [rJs(`module.exports = { ${it.token} };\n`)], true).length !== 1 || scanRetired([it], [rJs(`const { ${it.token} } = require('./zz_x');\n`)], true).length !== 1).map((it) => it.token);
    check(identTokens7.length === 48 && missedIdent7.length === 0, `S13 C7 名单：48 个标识符形态的标识（${identTokens7.length} 个，除去 6 条路径）以具名导出 module.exports = { x } 与解构导入 const { x } = require(…) 的代码标识符形态放回扫描面也都判红（漏判：${missedIdent7.join('、') || '无'}）`);
    // 对照组（必须绿）：保留标识放进扫描面都不报，防名单误收保留标识（attachment_referenced 另有材料写入点；proposer_confirm / item_version 到 C8 才清；附件视图助手与现行版本编号函数仍有使用方）
    const keep7 = ['attachment_referenced', 'package_created', 'package_version_created', 'package_version_edited', 'proposer_confirm', 'item_version', 'attachmentDisplayName', 'attachmentStateFields',
      'effectiveOverallVersionId', 'closePendingRevision', 'eligibleMember', 'batchLiveState', 'package_create', 'package_version_create', 'package_version_edit', 'material_version_create', 'confirm_task_created', 'confirm_task_reissued'];
    const keepText7 = keep7.map((t) => `const o_${t} = { ${t}: 1 }; const s_${t} = '${t}'; module.exports.${t} = ${t};`).join('\n') + "\nrouter.get('/sysbuild/package-versions/:vid', h);\nrouter.post('/sysbuild/packages/:pkid/versions', h);\nrouter.get('/sysbuild/projects/:id/materials', h);\n";
    const keepHit7 = scanRetired(c7List, [rJs(keepText7)], true);
    check(keepHit7.length === 0, `S13 C7 对照组：保留标识（${keep7.length} 个标识、/sysbuild/package-versions/:vid、/sysbuild/packages/:pkid/versions、/sysbuild/projects/:id/materials）放进扫描面都不报（误报：${keepHit7.map((h) => h.msg).join('；') || '无'}）`);

    const b33List = RETIRED_IDENTIFIERS.filter((item) => item.from === 'B3.3');
    const s8Tokens = ['setup', 'stepper', 'basisStep', 'preparationPanel', 'initiationPreparation', '保存并进入立项准备'];
    check(b33List.map((item) => item.token).join('|') === s8Tokens.join('|')
      && s8Tokens.every((token) => scanRetired(b33List, [rJs(JSON.stringify(token))], true).length === 1),
      'S13 B3.3：旧三步路由、函数和文案逐个放回均判红');
    check(scanRetired(b33List, [rJs("location.hash = '#project=1&tab=setup&step=3';")], true).length === 1
      && scanRetired(b33List, [rJs("const hint = '点击保存并进入立项准备继续';")], true).length === 1,
      'S13 B3.3：旧路由嵌入 URL 或旧按钮名嵌入中文时仍判红');
    check(scanRetired(b33List, [rJs("const setupKeyboard = () => 'setupKeyboard'; A.registerTab('plan', () => '立项确认');")], true).length === 0,
      'S13 B3.3：通用 setupKeyboard、现有排期页与立项确认卡均不误报');
  }
  const r1 = rRun([rJs("const a = 1;\nmodule.exports = 'sysbuild_zz_retired';\n")]);
  check(r1.length === 1 && r1[0].rule === 'S13' && r1[0].file === 'zz_r.js' && r1[0].line === 2 && r1[0].msg === '停用标识 sysbuild_zz_retired（table，自 C2 起）', 'S13 函数级：字符串字面量命中停用标识 → 红，行号与失败信息格式（FAIL [S13] 文件:行 停用标识 <token>（<kind>，自 <from> 起））正确');
  check(rRun([rJs('// sysbuild_zz_retired\n/* sysbuild_zz_retired */\nconst a = 1;\n')]).length === 0, 'S13 函数级：只出现在 JS 注释里 → 绿');
  check(rRun([rJs("const sysbuild_zz_retired_x = 'sysbuild_zz_retired_x';\n")]).length === 0, 'S13 函数级：作为更长标识符 / 字符串的一部分（sysbuild_zz_retired_x）→ 绿');
  const rSql = rRun([rJs("const a = 1;\nq.run('INSERT INTO sysbuild_zz_retired (a) VALUES (?)', [1]);\n")]);
  check(rSql.length === 1 && rSql[0].line === 2, 'S13 函数级：单引号 SQL 串里按词边界嵌着表名 → 红（字符串不只做整串等值）');
  check(rRun([rJs("q.run('INSERT INTO sysbuild_zz_retired_x (a) VALUES (?)');\n")]).length === 0, 'S13 函数级：SQL 串里是更长表名（sysbuild_zz_retired_x）→ 绿');
  check(rRun([rJs('const sysbuild_zz_retired = 1;\n')]).length === 1, 'S13 函数级：标识符 token 与停用标识等值 → 红');
  const r2 = rRun([rJs('const s = `SELECT 1\nFROM sysbuild_zz_retired WHERE id = ${x}`;\n')]);
  check(r2.length === 1 && r2[0].line === 2, 'S13 函数级：模板字面量静态片段里的词边界命中 → 红（行号按片段内换行折算）');
  check(rRun([rJs('const s = `FROM sysbuild_zz_retired_x WHERE id = ${x}`;\n')]).length === 0, 'S13 函数级：模板字面量里是更长标识符 → 绿');
  const r3 = rRun([rHtml('<p>a</p>\n<p>sysbuild_zz_retired</p>\n')]);
  check(r3.length === 1 && r3[0].file === 'Sys_Build.html' && r3[0].line === 2, 'S13 函数级：HTML 文本里的词边界命中 → 红');
  check(rRun([rHtml('<!-- sysbuild_zz_retired -->\n<p>x</p>\n')]).length === 0, 'S13 函数级：只出现在 HTML 注释里 → 绿');
  const r4 = rRun([rHtml('<p>a</p>\n<script>\nvar q = "sysbuild_zz_retired";\n</script>\n')]);
  check(r4.length === 1 && r4[0].line === 3, 'S13 函数级：HTML 内联 <script> 按 JS 处理，字符串命中 → 红且行号对齐页面');
  check(rRun([rJs("module.exports = 'sysbuild_zz_retired';\n", 'schema.js')], RT, true).length === 0, 'S13 函数级：RETIRED_SCHEMA_EXEMPT=true 时 schema.js 不扫 → 绿');
  check(rRun([rJs("module.exports = 'sysbuild_zz_retired';\n", 'schema.js')], RT, false).length === 1, 'S13 函数级：RETIRED_SCHEMA_EXEMPT=false 时 schema.js 扫到 → 红');
  const rPath = [{ token: 'routes/zz_old', kind: 'path', from: 'C3' }];
  check(rRun([rJs("require('./routes/zz_old/x.js');\n")], rPath).length === 1 && rRun([rJs("require('./routes/zz_new/x.js');\n")], rPath).length === 0, 'S13 函数级：path 类按子串命中字符串字面量（zz_old 红、zz_new 绿）');
  const rFile = [{ token: 'sysbuild-zz-old.js', kind: 'file', from: 'C8' }];
  check(rRun([rJs("const f = 'assets/js/sysbuild-zz-old.js';\n")], rFile).length === 1 && rRun([rHtml('<script src="assets/js/sysbuild-zz-old.js?v=auto"></script>\n')], rFile).length === 1, 'S13 函数级：file 类按子串命中字符串字面量与 HTML 里 <script src> 属性');
  const rAct = [{ token: 'entry_zz', kind: 'action', from: 'C4' }, { token: 'ev_zz', kind: 'event', from: 'C5' }];
  check(rRun([rJs("const a = 'entry_zz'; x.ev_zz();\n")], rAct).length === 2, 'S13 函数级：action / event 类同 table（字符串词边界、标识符等值）各命中一处 → 红');
  check(rRun([rJs("'sysbuild_zz_retired';\n")], []).length === 0 && rRun([rJs("'sysbuild_zz_retired';\n")], Object.freeze([])).length === 0, 'S13 函数级：名单为空 → 绿（不扫描）');
  check(rRun([rJs('x\n')], [{ token: '', kind: 'table', from: 'C2' }]).length === 1 && rRun([rJs('x\n')], [{ token: 'a', kind: 'zzz', from: 'C2' }]).length === 1 && rRun([rJs('x\n')], [{ token: 'a', kind: 'table', from: 'C9' }]).length === 1, 'S13 函数级：名单元素形态不合法（空 token / 未知 kind / from 不在 C2–C8）→ 红');
  check(rRun([rJs("const s = 'unterminated;\n")]).length === 1, 'S13 函数级：文件无法分词 → 红（无法确认没有停用标识）');
  // L-1：前置下划线属于词的一部分，x_ 开头的更长标识符 / 字符串不算命中（词边界的左侧）
  check(rRun([rJs("const x_sysbuild_zz_retired = 'x_sysbuild_zz_retired';\nq.run('SELECT 1 FROM x_sysbuild_zz_retired');\n")]).length === 0, 'S13 函数级：x_sysbuild_zz_retired（前置下划线的更长标识符 / 字符串 / SQL 串）→ 绿');
  // L-2：path 类是子串口径（routes/zz_older 含 routes/zz_old）
  check(rRun([rJs("require('./routes/zz_older/x.js');\n")], rPath).length === 1, 'S13 函数级：path 类是子串口径——routes/zz_older 对 token routes/zz_old 必须命中');
  // M-1：不带 .js 的 require（file 类、token 以 .js 结尾）按完整最后一个路径段判
  const rStem = [{ token: 'zz-old.js', kind: 'file', from: 'C8' }];
  check(rRun([rJs("const a = require('./zz-old');\n")], rStem).length === 1 && rRun([rJs("const a = require('../sysbuild/zz-old');\n")], rStem).length === 1, 'S13 函数级：require(\'./zz-old\') / (\'../sysbuild/zz-old\') 对 token zz-old.js → 红（不带 .js 的 require，以 ./ 或 ../ 开头）');
  check(rRun([rJs("const a = require('./zz-old-y');\nconst b = require('./zz-old.json');\nconst c = require('./zz-oldy');\n")], rStem).length === 0, 'S13 函数级：require(\'./zz-old-y\') / (\'./zz-old.json\') / (\'./zz-oldy\') 对 token zz-old.js → 绿（不是完整的最后一个路径段）');
  check(rRun([rJs("const a = require('zz-old');\nconst b = '/zz-old';\n")], rStem).length === 0, 'S13 函数级：裸写 \'zz-old\'、URL 尾段 \'/zz-old\' 对 token zz-old.js → 绿（路径段判法只对 ./ 或 ../ 开头的字符串生效）');
  check(rRun([rJs("const f = 'assets/js/zz-old.js';\n")], rStem).length === 1 && rRun([rHtml('<script src="assets/js/zz-old.js?v=auto"></script>\n')], rStem).length === 1, 'S13 函数级：\'assets/js/zz-old.js\'（左边是 /）与 <script src="assets/js/zz-old.js?v=auto"> 对 token zz-old.js → 红');
  check(rRun([rHtml('<script src="zz-old.js"></script>\n')], rStem).length === 1 && rRun([rJs("const h = \"<script src='zz-old.js'>\";\n")], rStem).length === 1 && rRun([rJs("const h = 'x zz-old.js';\n")], rStem).length === 1, 'S13 函数级：文件名左边紧挨引号、= 或空白（<script src="zz-old.js">、src=\'zz-old.js\'、空格后）→ 红（预筛复看 LOW-1）');
  // MED-2：真实树上的误报形态必须是绿例
  const rReal = [{ token: 'history.js', kind: 'file', from: 'C3' }, { token: 'confirm.js', kind: 'file', from: 'C3' }, { token: 'invitations.js', kind: 'file', from: 'C3' }];
  check(rRun([rJs("A.registerTab('history', fn);\n")], rReal).length === 0, 'S13 函数级：A.registerTab(\'history\', …) 对 token history.js → 绿');
  check(rRun([rJs("const s = 'assets/js/sysbuild-confirm.js';\n"), rHtml('<script src="assets/js/sysbuild-history.js"></script>\n')], rReal).length === 0, 'S13 函数级：\'assets/js/sysbuild-confirm.js\' 对 token confirm.js、<script src="assets/js/sysbuild-history.js"> 对 history.js → 绿（左边是 -，不是路径段边界）');
  check(rRun([rJs("const u = '/projects/:id/invitations';\n")], rReal).length === 0, 'S13 函数级：\'/projects/:id/invitations\' 对 token invitations.js → 绿');
  check(rRun([rJs("const a = 'a.history.js'; const b = 'a_confirm.js';\n")], rReal).length === 0, 'S13 函数级：前一个字符是 . 或 _（a.history.js、a_confirm.js）→ 绿');
  // 真实扫描面（只读，内存里扫，不落盘）：用真实存在的标识符当「合成停用标识」，证明 routes / 页面 / 脚本都被读到，且 schema.js 豁免开关起作用。
  const realFiles = collectRetiredFiles(DEFAULT_ROOT, path.join(__dirname, '..', 'public'));
  const realRels = realFiles.map((f) => f.rel);
  check(['db.js', 'schema.js', 'Sys_Build.html'].every((r) => realRels.includes(r)) && realRels.some((r) => /^assets\/js\/sysbuild-.*\.js$/.test(r)) && realFiles.every((f) => f.text.length > 0), 'S13 真实扫描面：routes/sysbuild 的 .js（含 db.js、schema.js）、Sys_Build.html、assets/js/sysbuild-*.js 都读到了内容');
  const realHit = scanRetired([{ token: 'createSysbuildDb', kind: 'action', from: 'C2' }], realFiles, true);
  check(realHit.some((h) => h.file === 'db.js') && realHit.every((h) => h.rule === 'S13'), 'S13 真实扫描面：用真实标识符 createSysbuildDb 当合成停用标识，db.js 被扫到并判红');
  const schemaOff = scanRetired([{ token: 'SCHEMA_OBJECTS', kind: 'action', from: 'C2' }], realFiles, false);
  const schemaOn = scanRetired([{ token: 'SCHEMA_OBJECTS', kind: 'action', from: 'C2' }], realFiles, true);
  check(schemaOff.some((h) => h.file === 'schema.js') && !schemaOn.some((h) => h.file === 'schema.js'), 'S13 真实扫描面：schema.js 在 RETIRED_SCHEMA_EXEMPT=false 时扫到、=true 时不扫');

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
    // L1 正对照：三个白名单文件分别出现列名均不应被 S12 拦截。
    for (const name of ['schema.js', 'entries-core.js', 'entry-forms.js']) {
      const d = fresh();
      fs.appendFileSync(path.join(d, name), '\n// routing_json 白名单正对照\n');
      const r = runGuard(__filename, ['--root', d]);
      check(r.kind === 'green', `L1 S12 白名单 ${name} 出现列名应绿（${r.kind}: ${r.detail}）`);
      removeTree(d);
    }
    // S13 接入 report 的端到端（#212 C1b M-3）：守卫副本里把名单换成合成 table token，用 --root 指向「真实 routes/sysbuild 的副本 + zz_retired_probe.js」；
    //   副本的 schema.js 末尾追加一处同 token 的字符串（RETIRED_SCHEMA_EXEMPT=true 时不得报）。前端目录用真实 public（只读）。
    //   副本里替换了三处：① RETIRED_IDENTIFIERS 的空名单声明换成含合成 token 的名单；② 对 lib/sysbuild-frontend-static 的相对 require 换成绝对路径；
    //   ③ 全部 __dirname（DEFAULT_ROOT、前端 public 目录、runGuard 的 NODE_PATH）换成真实 scripts 目录的绝对路径。
    //   替换锚点在本文件里必须恰好出现 1 次，所以下面的锚点串用拼接写，避免自检代码自己制造第二处命中。
    {
      const gdir = fs.mkdtempSync(path.join(tmpRoot, 'retired-'));
      const rootCopy = path.join(gdir, 'routes-copy');
      fs.mkdirSync(rootCopy);
      copyTree(DEFAULT_ROOT, rootCopy);
      fs.writeFileSync(path.join(rootCopy, 'zz_retired_probe.js'), "'use strict';\nmodule.exports = 'sysbuild_zz_retired_e2e';\n");
      fs.appendFileSync(path.join(rootCopy, 'schema.js'), "\nconst zzRetiredSchemaProbe = 'sysbuild_zz_retired_e2e';\n");
      const own = fs.readFileSync(__filename, 'utf8');
      // 替换锚点用正则匹配整段声明（不管名单当前是空还是已填、一行还是多行），要求在文本里恰好匹配 1 次（LOW-1：C2 一填名单也不会抛错）。
      //   正则字面量里的 `\.`、`\(` 等转义让这段自检代码自己不会成为第二处匹配；require 锚点用拼接写，理由同上。
      const swapRe = (text, re, to, label) => {
        const n = (text.match(re) || []).length;
        if (n !== 1) throw new Error(`S13 端到端自检：守卫副本替换锚点 ${label} 匹配了 ${n} 次（应恰好 1 次）`);
        return text.replace(re, () => to);
      };
      const makeGuardCopy = (text, exempt) => {
        let c = swapRe(text, /const RETIRED_IDENTIFIERS = Object\.freeze\(\[[\s\S]*?\]\);/g, 'const RETIRED_IDENTIFIERS = ' + "Object.freeze([{ token: 'sysbuild_zz_retired_e2e', kind: 'table', from: 'C2' }]);", 'RETIRED_IDENTIFIERS 声明');
        c = swapRe(c, /const RETIRED_SCHEMA_EXEMPT = (?:true|false);/g, `const RETIRED_SCHEMA_EXEMPT = ${exempt ? 'true' : 'false'};`, 'RETIRED_SCHEMA_EXEMPT 声明');
        const reqFrom = "require('./lib/" + "sysbuild-frontend-static')";
        if (c.split(reqFrom).length - 1 !== 1) throw new Error('S13 端到端自检：守卫副本替换锚点 sysbuild-frontend-static 的 require 不是恰好 1 处');
        c = c.replace(reqFrom, () => `require(${JSON.stringify(path.join(__dirname, 'lib', 'sysbuild-frontend-static'))})`);
        return c.split('__dirname').join(JSON.stringify(__dirname));
      };
      const copyExempt = path.join(gdir, 'guard-exempt.js');
      fs.writeFileSync(copyExempt, makeGuardCopy(own, true));
      const re1 = runGuard(copyExempt, ['--root', rootCopy]);
      check(re1.kind === 'red' && re1.fails.some((l) => l.includes('FAIL [S13] zz_retired_probe.js')), `S13 端到端：守卫副本带合成名单，--root 副本里的 zz_retired_probe.js 判红且输出含 FAIL [S13] zz_retired_probe.js（${re1.kind}: ${re1.fails.join(' | ') || re1.detail}）`);
      check(!re1.fails.some((l) => l.includes('FAIL [S13] schema.js')) && re1.fails.every((l) => l.includes('FAIL [S13]')), 'S13 端到端：RETIRED_SCHEMA_EXEMPT=true 时副本 schema.js 里的同 token 不报，且没有别的规则连带判红');
      const copyOpen = path.join(gdir, 'guard-open.js');
      fs.writeFileSync(copyOpen, makeGuardCopy(own, false));
      const re2 = runGuard(copyOpen, ['--root', rootCopy]);
      check(re2.kind === 'red' && re2.fails.some((l) => l.includes('FAIL [S13] schema.js')) && re2.fails.some((l) => l.includes('FAIL [S13] zz_retired_probe.js')), `S13 端到端：RETIRED_SCHEMA_EXEMPT=false 时副本 schema.js 那处也判红（豁免开关接到了 report）（${re2.kind}: ${re2.fails.join(' | ') || re2.detail}）`);
      // LOW-1：把真实守卫源码里的名单在内存里换成非空（多行、多元素，模拟 C2 之后的样子）后，端到端块仍能生成副本并判红。
      //   替换文本用拼接写，免得它在本文件源码里自成第二处「名单声明」匹配。
      const filledDecl = 'const RETIRED_IDENTIFIERS = ' + "Object.freeze([\n  { token: 'zz_filled_other', kind: 'file', from: 'C3', note: '名单已填' },\n  { token: 'zz_filled_two', kind: 'action', from: 'C4', lastClear: { commit: 'x', where: 'y' } },\n]);";
      const ownFilled = own.replace(/const RETIRED_IDENTIFIERS = Object\.freeze\(\[[\s\S]*?\]\);/, () => filledDecl);
      let filledOk = ownFilled !== own;
      let filledMsg = '';
      try {
        const copyFilled = path.join(gdir, 'guard-filled.js');
        fs.writeFileSync(copyFilled, makeGuardCopy(ownFilled, true));
        const re3 = runGuard(copyFilled, ['--root', rootCopy]);
        filledOk = filledOk && re3.kind === 'red' && re3.fails.some((l) => l.includes('FAIL [S13] zz_retired_probe.js'));
        filledMsg = `${re3.kind}: ${re3.fails.join(' | ') || re3.detail}`;
      } catch (e) { filledOk = false; filledMsg = e.message; }
      check(filledOk, `S13 端到端：真实守卫的名单（内存里）已填成多行非空时，替换锚点仍恰好匹配 1 次、副本照样生成并对 zz_retired_probe.js 判红（${filledMsg}）`);
    }
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
      if (!anchorOk) { check(false, `[${mu.id}] 变异锚点出现次数不是 1`); if (mutRec.enabled()) console.log(mutRec.mutLine('static', mu.id, mutRec.VERDICT.ANCHOR, [], '变异锚点出现次数不是 1')); removeTree(d); continue; }
      const r = runGuard(__filename, ['--root', d]);
      const need = [mu.rule].concat(mu.also || []);
      const hit = r.kind === 'red' && need.every((rule) => r.fails.some((l) => l.includes(`FAIL [${rule}]`)));
      const other = [...new Set(r.fails.map((l) => /\[(S\d+)\]/.exec(l)[1]))].filter((x) => !need.includes(x));
      check(hit, `[${mu.id}] ${hit ? `命中 ${mu.rule}${other.length ? `（另命中 ${other.join('/')}）` : ''}` : `未检出（${r.kind}: ${r.detail}${r.fails.length ? ` | ${r.fails.join(' | ')}` : ''}）`}`);
      // C1c 机器基线：守卫类失败不是异常，每条 FAIL 行记一条 GuardFail（case = 规则号，message = FAIL 行原文）
      if (mutRec.enabled()) console.log(mutRec.mutLine('static', mu.id, hit ? mutRec.VERDICT.RED : (r.kind === 'abnormal' ? mutRec.VERDICT.ABNORMAL : mutRec.VERDICT.WEAK), r.fails.map((l) => ({ case: /\[(S\d+)\]/.exec(l)[1], errorClass: 'GuardFail', message: l.trim(), site: null, label: null })), hit ? null : (r.kind === 'abnormal' ? r.detail : (r.kind === 'red' ? '红但未命中期望规则' : null))));
      removeTree(d);
    }
    for (const entry of frontendStatic.selfTest().results) check(entry.ok, `S10 前端正反例：${entry.name}`);
    for (const entry of frontendStatic.navSelfTest(path.join(__dirname, '..', 'public'))) check(entry.ok, entry.name);
  } finally {
    try { removeTree(tmpRoot); } catch (e) { console.error(`  [清理] 临时目录未删除（保留现场）: ${tmpRoot} — ${e.message}`); }
  }
  console.log(`\n${ok}/${total} 通过`);
  return ok === total ? 0 : 1;
}

// 只读导出（#212 C1b，供 scripts/sysbuild-step1/mutation-check.js 读取）：变异登记、规则清单、S13 纯函数；入口只在直接运行本脚本时执行。
module.exports = { MUTATIONS, RULES, scanRetired, collectRetiredFiles };
if (require.main === module) {
  if (SELF_TEST) {
    process.exitCode = selfTest();
  } else {
    process.exitCode = report(ROOT);
  }
}
