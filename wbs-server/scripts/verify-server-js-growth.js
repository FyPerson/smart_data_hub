#!/usr/bin/env node
/**
 * server.js 止增长守卫（#106 S13 / 方案 v1.4 W6）。
 *
 * 目的：server.js 已有 200 多个端点和几十处建表，多条开发线并行时每条线都往里加会让它成为合并冲突的中心。
 *   本守卫把「端点数」「建表数」以及几种能绕过端点计数的写法，按基线提交 f9133118 写死为常量，**计数必须恰好等于基线**：
 *     · 多了 → 判红：新端点 / 新建表放 routes/<模块>/，在 server.js 只加 app.use(...) 挂载；
 *     · 少了 → 也判红（棘轮）：删了端点或建表是好事，但要把基线常量同一提交调低，否则空出来的名额会被后来的新增悄悄吃掉。
 *
 * 计数口径（硬门，不做智能放行）：
 *   · 全部对 server.js **原文**计数：注释里的写法也算（不剥注释、不解析 JS）。注释里出现 CREATE TABLE 的 9 处已计入基线；
 *   · 行尾无关（CRLF / LF 结果相同），计数只依赖正则命中数；
 *   · 运行时不读 git、不读 main、不起服务、不开库、不起进程（不 require child_process），只 readFileSync 一个文件。
 *
 * 棘轮规则与下调做法：
 *   实际数少于基线时本守卫判红。做法：同一个提交里把下面 COUNTERS 表中对应项的 baseline 调低，并在该项旁追加一行注释（日期 + 原因，
 *   例如「2026-11-02 baseline 207 → 205：订单模块两个端点迁入 routes/orders/」）。调高基线等于放行新增，不应出现；确需调高时必须在提交说明里写明理由并经用户裁定。
 *
 * 能力边界（登记在此，不假装挡住）：
 *   · 只看 server.js 一个文件。把 app 传出去、在别处加端点（routes/<模块>/ 的合法做法）不在本守卫范围——这是出口，不是漏洞；
 *     但「在别的文件里无限加端点而不挂载」、「别的文件里的建表」同样不在本守卫范围；
 *   · 动态方法名 app[m](…) 由 bracketAccess 挡住；解构 { get } = app 由 aliasAssign 挡住。
 *     以下写法不识别：Object.assign(app, …)、app.get.bind(app)、(0, app.get)(…)；
 *   · 别名赋值一项只识别「= app」后面不跟 . 或标识符字符的写法（且 = 前不是 = ! < >）；`foo(app)` 把 app 当参数传给别的函数不识别（那是合法的挂载写法）；
 *   · 其他路由器变量上的端点（routerStyleCalls）只识别第一个实参是以 / 开头的字面量的写法；`r.get(pathVar, h)` 不识别；
 *   · 建表只识别 CREATE [TEMP|TEMPORARY|VIRTUAL] TABLE；`SELECT … INTO` 之类的隐式建表、ALTER TABLE ADD 不计；
 *   · 带内联函数的 app.use 只识别「app.use( [路径,] [若干中间件,] 紧跟 ( / async / function」（路径可以是字符串 / 数组 / 正则字面量 / 标识符或成员表达式）；
 *     `app.use(mw)` 把内联函数先赋给变量再传入不识别；中间件写成数组（'/x', [auth], (req,res)=>…）、嵌套调用（requireRole(getRole()), …）、
 *     拼接路径（BASE + '/x', …）也不识别。
 *   · 漏计（残余）：既有路由器上用变量当路径（implBodyGate.post(VAR, …)，不冻结 implBodyGate）；非 app 对象的 .use(path, 内联)；
 *     链式追加、数组路径加别名；同一提交里删一个加一个（净零）；app.search 等冷门方法与 app?.get( 的可选链写法。
 *   · 误红：app.get('trust proxy') 这类读设置的调用；注释里代码形状的 .get('/…')；以路径字面量为键的 Map、客户端实例 client.post('/…')；
 *     module.exports = app / exports.app = app 导出 app 会被 aliasAssign 计入。
 *   · 注释两头影响（原文计数，注释也算）：迁出说明里留着 app.get( 或 CREATE TABLE 字样，会掩盖真实的减少（计数没降，棘轮看不见）。
 *     写法指引：迁出说明写成「GET /api/foo」「建表 xxx」；撞到误红时改写代码（例如把路径放进常量），不要调基线。
 *
 * 用法：
 *   node wbs-server/scripts/verify-server-js-growth.js                 基线核对（读 wbs-server/server.js）
 *   node wbs-server/scripts/verify-server-js-growth.js --verbose       同上，并逐项列出命中行号
 *   node wbs-server/scripts/verify-server-js-growth.js --file <路径>   读另一个文件代替 server.js（变异用）
 *   node wbs-server/scripts/verify-server-js-growth.js --self-test     在内存里对真实 server.js 原文做变异的自证
 * 输出：每项一行 `[OK]` / `[FAIL] 名称 实际 N 基线 M —— 提示`；末行 `=== PASS：x 项通过 / y 项失败 ===` 或 FAIL；失败 exit 1。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SERVER_JS = path.join(__dirname, '..', 'server.js');

/**
 * 计数表（冻结）：名称 + 正则 + 基线数 + 一句含义。
 * 基线提交 f9133118（#106 S13，2026-10-23）；下调规则见文件头。
 * 正则全部带 g；计数用 matchAll（会克隆正则，不依赖 lastIndex 状态）。
 */
const COUNTERS = Object.freeze([
  // 基线提交 f9133118（#106 S13，2026-10-23）：207 = get 88 / post 80 / put 26 / delete 13 / patch 0 / all 0，首条第 4592 行、末条第 22515 行；注释与字符串内 0 处
  Object.freeze({
    name: 'endpoints',
    re: /\bapp\s*\.\s*(get|post|put|patch|delete|all|options|head)\s*\(/g,
    baseline: 207,
    meaning: 'app.<方法>( 形式的端点注册（空白 / 换行宽容，含 options / head）',
  }),
  // 基线提交 f9133118（#106 S13，2026-10-23）：48 = 代码 39 + 注释 9（含注释 9 处：第 346 1876 2006 2183 2625 2639 2688 2694 3008 行）；TEMP / VIRTUAL / 跨行写法为 0
  Object.freeze({
    name: 'createTable',
    re: /\bCREATE\s+(?:TEMP\s+|TEMPORARY\s+|VIRTUAL\s+)?TABLE\b/gi,
    baseline: 48,
    meaning: 'CREATE [TEMP|TEMPORARY|VIRTUAL] TABLE（大小写不敏感，含注释 9 处）',
  }),
  // 基线提交 f9133118（#106 S13，2026-10-23）：0
  Object.freeze({
    name: 'bracketAccess',
    re: /\bapp\s*\[/g,
    baseline: 0,
    meaning: 'app[ 方括号取方法（app[\'get\'](…) / app[m](…) 绕过端点计数的写法）',
  }),
  // 基线提交 f9133118（#106 S13，2026-10-23）：0
  Object.freeze({
    name: 'appRoute',
    re: /\bapp\s*\.\s*route\s*\(/g,
    baseline: 0,
    meaning: 'app.route( 链式注册（app.route(p).get(h) 不会被 endpoints 命中）',
  }),
  // 基线提交 f9133118（#106 S13，2026-10-23）：1（第 945 行 const implBodyGate = express.Router();）
  Object.freeze({
    name: 'routerFactory',
    re: /\bRouter\s*\(/g,
    baseline: 1,
    meaning: 'Router( 创建路由器（express.Router() 或解构出的 Router()；新路由器放 routes/<模块>/）',
  }),
  // 基线提交 f9133118（#106 S13，2026-10-23）：0
  Object.freeze({
    name: 'aliasAssign',
    re: /(?<![=!<>])=\s*app\b(?!\s*[.\w])/g,
    baseline: 0,
    meaning: '= app 别名赋值（const a = app; a.get(…) 绕过端点计数；解构 `{ get } = app` 同样命中）',
  }),
  // 基线提交 f9133118（#106 S13，2026-10-23）：4（第 1047 行 '/uploads' 内联、第 22109 / 22748 / 22757 行）
  Object.freeze({
    name: 'inlineUse',
    re: /\bapp\s*\.\s*use\s*\(\s*(?:(?:(['"\x60])[^'"\x60\r\n]*\1|\[[^\]]*\]|\/(?:[^/\\\r\n]|\\.)+\/[a-z]*|[A-Za-z_$][\w$.]*)\s*,\s*)?(?:[A-Za-z_$][\w$.]*(?:\([^()]*\))?\s*,\s*)*(?:\(|async\b|function\b)/g,
    baseline: 4,
    meaning: '带内联函数的 app.use( （[路径,] [中间件,] 紧跟 ( / async / function；内联中间件里可以藏端点，挂载路由器的 app.use 不计）',
  }),
  // 基线提交 f9133118（#106 S13，2026-10-23）：0（派单事实 router.METHOD( 为 0；本项把「app 以外任何标识符 .METHOD('/…'」都收进来，防止新路由器换个变量名绕过）
  Object.freeze({
    name: 'routerStyleCalls',
    re: /\b(?!app\b)[A-Za-z_$][\w$]*\s*\.\s*(?:get|post|put|patch|delete|all)\s*\(\s*['"`]\//g,
    baseline: 0,
    meaning: '非 app 标识符上的 .METHOD(\'/… 调用（如 router.get(\'/x\', h)；换变量名绕过端点计数的写法）',
  }),
]);

const HINT_OVER = '新端点 / 新建表放 routes/<模块>/，在 server.js 只加 app.use(...) 挂载；不要调高本守卫的基线';
const HINT_UNDER = '少于基线（棘轮）：同一提交把本守卫里 COUNTERS 对应项的 baseline 调低，并在常量旁追加一行注释：日期 + 原因';

/** 对一段源码原文计数。返回 [{ name, actual, baseline, ok, lines, meaning }]；src 不是非空字符串时返回 { fatal } */
function evaluate(src, counters) {
  const table = counters === undefined ? COUNTERS : counters;
  if (typeof src !== 'string') return { fatal: `源文件内容不是字符串（实得 ${src === null ? 'null' : typeof src}）` };
  if (src.trim() === '') return { fatal: '源文件为空（空文件一律判红，fail-closed）' };
  const results = [];
  for (const c of table) {
    const lines = [];
    let line = 1;
    let from = 0;
    for (const m of src.matchAll(c.re)) {
      for (let i = src.indexOf('\n', from); i !== -1 && i < m.index; i = src.indexOf('\n', from)) { line += 1; from = i + 1; }
      lines.push(line);
    }
    results.push({ name: c.name, actual: lines.length, baseline: c.baseline, ok: lines.length === c.baseline, lines, meaning: c.meaning });
  }
  return { results };
}

function fmtResult(r) {
  if (r.ok) return `[OK] ${r.name} 实际 ${r.actual} 基线 ${r.baseline} —— ${r.meaning}`;
  return `[FAIL] ${r.name} 实际 ${r.actual} 基线 ${r.baseline} —— ${r.actual > r.baseline ? HINT_OVER : HINT_UNDER}（${r.meaning}）`;
}

/** 基线核对。io = { readFile(p) → string, log(s) }；返回退出码 */
function runCheck(file, verbose, io) {
  let src;
  try { src = io.readFile(file); } catch (e) { io.log(`[FAIL] 读取 ${file} 失败：${e && e.message}`); io.log('=== FAIL：0 项通过 / 1 项失败 ==='); return 1; }
  const ev = evaluate(src);
  if (ev.fatal) { io.log(`[FAIL] ${file}：${ev.fatal}`); io.log('=== FAIL：0 项通过 / 1 项失败 ==='); return 1; }
  let pass = 0;
  let fail = 0;
  for (const r of ev.results) {
    io.log(fmtResult(r));
    if (verbose) io.log(`    命中行号（${r.lines.length} 处）：${r.lines.join(', ')}`);
    if (r.ok) pass += 1; else fail += 1;
  }
  io.log(`=== ${fail === 0 ? 'PASS' : 'FAIL'}：${pass} 项通过 / ${fail} 项失败 ===`);
  return fail === 0 ? 0 : 1;
}

// ---------------------------------------------------------------- 自证

/** 把 src 追加一段文本 */
const addTail = (src, text) => src + '\n' + text + '\n';
/** 删掉第 n 个命中（只删命中的那段文字） */
function removeFirstMatch(src, re) {
  const m = src.matchAll(re).next();
  if (m.done) return null;
  return src.slice(0, m.value.index) + src.slice(m.value.index + m.value[0].length);
}
const toLF = (s) => s.replace(/\r\n/g, '\n');
const toCRLF = (s) => toLF(s).replace(/\n/g, '\r\n');

function runSelfTest(io) {
  let pass = 0;
  let fail = 0;
  let n = 0;
  const check = (desc, cond, detail) => {
    n += 1;
    const id = `ST.${n}`;
    if (cond) { pass += 1; io.log(`[OK] ${id} ${desc}`); } else { fail += 1; io.log(`[FAIL] ${id} ${desc}${detail === undefined ? '' : ' —— ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))}`); }
  };
  const finish = () => { io.log(`=== ${fail === 0 ? 'PASS' : 'FAIL'}：${pass} 项通过 / ${fail} 项失败 ===`); return fail === 0 ? 0 : 1; };

  let real;
  try { real = io.readFile(SERVER_JS); } catch (e) { check('读取真实 server.js 原文', false, e && e.message); return finish(); }
  check('读取真实 server.js 原文：非空字符串', typeof real === 'string' && real.trim() !== '', typeof real);
  if (!(typeof real === 'string' && real.trim() !== '')) return finish();

  const failing = (src) => { const ev = evaluate(src); return ev.fatal ? ['<fatal>'] : ev.results.filter((r) => !r.ok).map((r) => r.name); };
  const countOf = (src, name) => { const ev = evaluate(src); return ev.fatal ? null : ev.results.find((r) => r.name === name).actual; };
  const baseOf = (name) => COUNTERS.find((c) => c.name === name).baseline;
  const J = JSON.stringify;

  // 0 计数表自身
  check('计数表冻结、名称不重复、基线是非负整数、正则都带 g', Object.isFrozen(COUNTERS) && COUNTERS.every((c) => Object.isFrozen(c) && c.re.global && Number.isInteger(c.baseline) && c.baseline >= 0 && typeof c.meaning === 'string' && c.meaning !== '') && new Set(COUNTERS.map((c) => c.name)).size === COUNTERS.length, COUNTERS.map((c) => c.name));
  check('计数表恰为这 8 项且顺序一致（endpoints / createTable / bracketAccess / appRoute / routerFactory / aliasAssign / inlineUse / routerStyleCalls）', J(COUNTERS.map((c) => c.name)) === J(['endpoints', 'createTable', 'bracketAccess', 'appRoute', 'routerFactory', 'aliasAssign', 'inlineUse', 'routerStyleCalls']), COUNTERS.map((c) => c.name));

  // 1 原文
  check('原文 → 全部计数项等于基线（无红）', J(failing(real)) === J([]), failing(real));

  // 2 对照组：合法写法不判红
  const benign = [
    ['挂载路由器 app.use(\'/api/x\', xRouter);', "app.use('/api/x', xRouter);"],
    ['挂载无路径 app.use(xRouter);', 'app.use(xRouter);'],
    ['挂载 express.static', "app.use(express.static('public'));"],
    ['app.listen(port)', 'app.listen(port);'],
    ['CREATE INDEX（不是建表）', 'db.run("CREATE INDEX idx_x ON t(a)");'],
    ['CREATE TABLESPACE 之类（\\b 边界）', '// CREATE TABLESPACES are not a thing here'],
    ['xapp.get 前缀不同的标识符（\\b 边界，且第一个实参不是 / 开头）', "xapp.get(pathVar, h);"],
    ['标识符 application 不是别名赋值', 'const x = application;'],
    ['app.get 作为属性读取（后面不是 左括号）', 'const g = app.get;'],
    ['db.get(sql, …)（第一个实参不是 / 开头的字面量）', "db.get('SELECT 1', cb);"],
    ['req.app.locals', 'const v = req.app.locals.x;'],
    ['挂载带静态中间件 app.use(\'/x\', express.static(d))', "app.use('/x', express.static(d));"],
    ['挂载 app.use(bodyParser.json({ limit: \'1mb\' }))', "app.use(bodyParser.json({ limit: '1mb' }));"],
    ['app.use(cors())', 'app.use(cors());'],
    ['app.use(compression())', 'app.use(compression());'],
    ['挂载模块路由器 app.use(\'/api\', sysIterModule.router)', "app.use('/api', sysIterModule.router);"],
    ['挂载多个中间件加路由器 app.use(\'/api/z\', authenticateToken, zRouter)', "app.use('/api/z', authenticateToken, zRouter);"],
    ['全等比较 if (req.app === app) {}', 'if (req.app === app) {}'],
    ['不等比较 if (x !== app) {}', 'if (x !== app) {}'],
    ['宽松比较 / 大小比较 if (x == app || x >= app || x <= app) {}', 'if (x == app || x >= app || x <= app) {}'],
  ];
  for (const [desc, text] of benign) check(`对照组（合法写法应全绿）：${desc}`, J(failing(addTail(real, text))) === J([]), failing(addTail(real, text)));

  // 3 各计数项「加一处」→ 只有该项 FAIL
  const adds = [
    ['endpoints', 'app.post 一处', "app.post('/x', (req, res) => {});"],
    ['endpoints', 'app . get 空白变体', "app . get ('/x', h);"],
    ['endpoints', 'app 换行再 .get 变体', "app\n  .get('/x', h);"],
    ['endpoints', 'app.options 一处', "app.options('/x', h);"],
    ['endpoints', 'app.head 一处', "app.head('/x', h);"],
    ['endpoints', 'app.all 一处', "app.all('/x', h);"],
    ['endpoints', 'app.patch 一处', "app.patch('/x', h);"],
    ['endpoints', 'app.put / app.delete 各一处（共加 2）', "app.put('/x', h);\napp.delete('/x', h);"],
    ['endpoints', '注释里的 app.get( 也计入（原文计数）', "// app.get('/commented', h)"],
    ['createTable', '注释里的 create table（小写）', '// create table foo (id integer)'],
    ['createTable', 'CREATE TABLE IF NOT EXISTS 一处', 'db.run("CREATE TABLE IF NOT EXISTS foo (id INTEGER)");'],
    ['createTable', 'CREATE TEMP TABLE', 'db.run("CREATE TEMP TABLE foo (id INTEGER)");'],
    ['createTable', 'CREATE TEMPORARY TABLE', 'db.run("CREATE TEMPORARY TABLE foo (id INTEGER)");'],
    ['createTable', 'CREATE VIRTUAL TABLE', 'db.run("CREATE VIRTUAL TABLE foo USING fts5(a)");'],
    ['createTable', '跨行 CREATE 换行 TABLE', 'db.run(`CREATE\n   TABLE foo (id INTEGER)`);'],
    ['bracketAccess', "app['get'](…)", "app['get']('/x', h);"],
    ['bracketAccess', 'app [ method ](…) 带空白', 'app [ method ](\'/x\', h);'],
    ['appRoute', "app.route('/x')", "app.route('/x');"],
    ['appRoute', 'app . route (…) 带空白', "app . route ('/x').get(h);"],
    ['routerFactory', 'express.Router()', 'const r = express.Router();'],
    ['routerFactory', '解构出来的 Router()', 'const r2 = Router({ mergeParams: true });'],
    ['aliasAssign', 'const a = app;', 'const a = app;'],
    ['aliasAssign', '换行后的 = app', 'let b\n  = app\n;'],
    ['aliasAssign', '解构 { get } = app', 'const { get } = app;'],
    ['inlineUse', "app.use('/x', (req,res)=>{})", "app.use('/x', (req,res)=>{});"],
    ['inlineUse', 'app.use((req,res,next)=>…) 无路径', 'app.use((req, res, next) => next());'],
    ['inlineUse', 'app.use(async (req,res,next)=>…)', 'app.use(async (req, res, next) => next());'],
    ['inlineUse', "app.use('/x', function(req,res){…})", "app.use('/x', function (req, res) {});"],
    ['inlineUse', 'app.use("/y", async function …) 双引号', 'app.use("/y", async function (req, res) {});'],
    ['inlineUse', '数组路径 app.use([\'/a\', \'/b\'], (req…', "app.use(['/a', '/b'], (req, res) => {});"],
    ['inlineUse', '正则路径 app.use(/^\\/x/, (req…', 'app.use(/^\\/x/, (req, res) => {});'],
    ['inlineUse', '模板串路径 app.use(`/x`, (req…', 'app.use(`/x`, (req, res) => {});'],
    ['inlineUse', "路径后跟中间件标识符再接内联函数 app.use('/api/x', authenticateToken, (req, res) => …)", "app.use('/api/x', authenticateToken, (req, res) => { res.json({}); });"],
    ['inlineUse', '路径是标识符 app.use(UPLOAD_PATHS, (req, res, next) => …)', 'app.use(UPLOAD_PATHS, (req, res, next) => next());'],
    ['inlineUse', "路径后跟调用形态的中间件 app.use('/api/y', express.json(), (req, res) => …)", "app.use('/api/y', express.json(), (req, res) => res.json({}));"],
    ['routerStyleCalls', "r.get('/x', h)", "r.get('/x', h);"],
    ['routerStyleCalls', 'implBodyGate.post("/y", h)', 'implBodyGate.post("/y", h);'],
    ['routerStyleCalls', "router . delete ( '/z' …) 带空白", "router . delete ( '/z', h);"],
  ];
  for (const [name, desc, text] of adds) {
    const mutated = addTail(real, text);
    const want = (name === 'endpoints' && /共加 2/.test(desc)) ? baseOf(name) + 2 : baseOf(name) + 1;
    check(`加一处 ${name}：${desc} → 只有 ${name} 判红且实际数 = 基线 + ${want - baseOf(name)}`, J(failing(mutated)) === J([name]) && countOf(mutated, name) === want, { failing: failing(mutated), actual: countOf(mutated, name) });
  }

  // 4 棘轮：每个基线 > 0 的计数项「删一处」→ 判红（endpoints、createTable 为必做）
  for (const c of COUNTERS.filter((x) => x.baseline > 0)) {
    const mutated = removeFirstMatch(real, c.re);
    const underLine = mutated === null ? '' : fmtResult(evaluate(mutated).results.find((r) => r.name === c.name));
    check(`删一处 ${c.name}（棘轮）→ 只有 ${c.name} 判红，实际数 = 基线 - 1，提示是整句「调低基线」且不含「放 routes」整句`,
      mutated !== null && J(failing(mutated)) === J([c.name]) && countOf(mutated, c.name) === c.baseline - 1 && underLine.includes(HINT_UNDER) && ['同一提交', 'baseline', '调低', '日期 + 原因'].every((k) => underLine.includes(k)) && !underLine.includes(HINT_OVER),
      mutated === null ? 'no match' : { failing: failing(mutated), actual: countOf(mutated, c.name), underLine });
  }
  const eb = baseOf('endpoints');
  const overLine = fmtResult(evaluate(addTail(real, "app.post('/x', h);")).results[0]);
  check('「多了」的失败行带整句提示（放 routes/<模块>/，只加 app.use(...) 挂载，不要调高基线），且不含「调低」整句', overLine.startsWith(`[FAIL] endpoints 实际 ${eb + 1} 基线 ${eb} —— `) && overLine.includes(HINT_OVER) && !overLine.includes(HINT_UNDER) && overLine.includes('routes/<模块>/') && overLine.includes('app.use(...)') && overLine.includes('不要调高'), overLine);

  // 5 行尾无关
  const lf = toLF(real);
  const crlf = toCRLF(real);
  check('CRLF 与 LF 两种行尾的计数结果（含命中行号）完全相同', J(evaluate(lf).results) === J(evaluate(crlf).results) && J(failing(crlf)) === J([]), null);
  check('真实原文的行尾形态不影响结论（原文 = LF 版 = CRLF 版）', J(evaluate(real).results.map((r) => r.actual)) === J(evaluate(lf).results.map((r) => r.actual)), null);
  check('CRLF 行尾下加一处 app.post 仍只有 endpoints 判红', J(failing(addTail(crlf, "app.post('/x', h);"))) === J(['endpoints']), failing(addTail(crlf, "app.post('/x', h);")));
  check('CRLF 行尾下 app.use 内联函数（路径后紧跟换行再函数）仍被 inlineUse 命中', countOf(toCRLF("app.use('/x',\n  (req, res) => {});"), 'inlineUse') === 1, countOf(toCRLF("app.use('/x',\n  (req, res) => {});"), 'inlineUse'));

  // 6 fail-closed
  const f1 = evaluate('');
  const f2 = evaluate('  \r\n\t\n');
  const f3 = evaluate(undefined);
  const f4 = evaluate(null);
  const f5 = evaluate(Buffer.from('app.get("/x")'));
  check('空字符串 → fatal（判红）', typeof f1.fatal === 'string' && f1.results === undefined, f1);
  check('只有空白 → fatal（判红）', typeof f2.fatal === 'string', f2);
  check('undefined / null / Buffer（读文件拿到非字符串）→ fatal（判红）', typeof f3.fatal === 'string' && typeof f4.fatal === 'string' && typeof f5.fatal === 'string', [f3, f4, f5]);
  const positiveNames = COUNTERS.filter((x) => x.baseline > 0).map((x) => x.name);
  check('与 server.js 无关的非空文本 → 恰好是基线 > 0 的计数项判红（不假设某项基线恒为正）', J(failing('hello world\n')) === J(positiveNames), { failing: failing('hello world\n'), positiveNames });

  const cap = () => { const out = []; return { out, log: (s) => out.push(s) }; };
  const c1 = cap();
  const code1 = runCheck('E:/__no_such_dir__/none.js', false, { readFile: () => { throw new Error('ENOENT: no such file'); }, log: c1.log });
  check('读文件失败 → 退出码 1，输出 [FAIL] 与 FAIL 汇总行', code1 === 1 && c1.out[0].startsWith('[FAIL] 读取 ') && c1.out[c1.out.length - 1] === '=== FAIL：0 项通过 / 1 项失败 ===', c1.out);
  const c2 = cap();
  const code2 = runCheck('empty.js', false, { readFile: () => '', log: c2.log });
  check('读到空文件 → 退出码 1，输出 [FAIL] 与 FAIL 汇总行', code2 === 1 && c2.out[0].startsWith('[FAIL] empty.js') && c2.out[c2.out.length - 1] === '=== FAIL：0 项通过 / 1 项失败 ===', c2.out);
  const c3 = cap();
  const code3 = runCheck('real', false, { readFile: () => real, log: c3.log });
  check('真实原文 → 退出码 0，每项一行 [OK]，末行 PASS 汇总', code3 === 0 && c3.out.length === COUNTERS.length + 1 && c3.out.slice(0, -1).every((l) => l.startsWith('[OK] ')) && c3.out[c3.out.length - 1] === `=== PASS：${COUNTERS.length} 项通过 / 0 项失败 ===`, c3.out);
  const c4 = cap();
  const code4 = runCheck('mut', false, { readFile: () => addTail(real, "app.post('/x', h);"), log: c4.log });
  check('多一个端点 → 退出码 1，恰一行 [FAIL]，末行 FAIL 汇总', code4 === 1 && c4.out.filter((l) => l.startsWith('[FAIL] ')).length === 1 && c4.out[c4.out.length - 1] === `=== FAIL：${COUNTERS.length - 1} 项通过 / 1 项失败 ===`, c4.out);
  const c5 = cap();
  runCheck('real', true, { readFile: () => real, log: c5.log });
  check(`--verbose 逐项追加命中行号：endpoints 行号个数 = 基线 ${eb}`, c5.out.some((l) => l.startsWith(`    命中行号（${eb} 处）：`)), c5.out.filter((l) => l.includes('命中行号')).slice(0, 2));

  // 7 入口 main(argv, io)：参数解析与读取路径（io 注入）
  const mainRun = (argv, content) => { const o = cap(); const reads = []; const code = main(argv, { readFile: (p) => { reads.push(p); if (content instanceof Error) throw content; return content; }, log: o.log }); return { code, reads, out: o.out }; };
  const m1 = mainRun(['--file', 'X-given-path.js'], real);
  check('main --file <路径>：readFile 收到的恰是给定路径，原文 → 退出码 0', m1.code === 0 && J(m1.reads) === J(['X-given-path.js']) && m1.out[m1.out.length - 1] === `=== PASS：${COUNTERS.length} 项通过 / 0 项失败 ===`, m1);
  const m2 = mainRun([], real);
  check('main 无参数：readFile 收到的是 server.js 的默认路径（SERVER_JS）', m2.code === 0 && J(m2.reads) === J([SERVER_JS]), m2.reads);
  const m3 = mainRun(['--bogus'], real);
  check('main 未知参数 → 退出码 1，不读文件，输出 FAIL 汇总行', m3.code === 1 && m3.reads.length === 0 && m3.out[m3.out.length - 1] === '=== FAIL：0 项通过 / 1 项失败 ===', m3);
  const m4 = mainRun(['--self-test', '--file', 'X.js'], real);
  check('main --self-test 与 --file 同用 → 退出码 1，不读文件', m4.code === 1 && m4.reads.length === 0 && m4.out[m4.out.length - 1] === '=== FAIL：0 项通过 / 1 项失败 ===', m4);
  const m5 = mainRun(['--file'], real);
  const m6 = mainRun(['--file', '--verbose'], real);
  check('main --file 缺路径（末尾 / 后面紧跟另一个选项）→ 退出码 1，不读文件', m5.code === 1 && m5.reads.length === 0 && m6.code === 1 && m6.reads.length === 0, { m5, m6 });
  const m7 = mainRun(['--file', 'broken.js'], new Error('EACCES'));
  check('main --file 读取抛错 → 退出码 1，输出 [FAIL] 读取', m7.code === 1 && m7.out[0].startsWith('[FAIL] 读取 broken.js'), m7);

  return finish();
}

// ---------------------------------------------------------------- 入口

function main(argv, io) {
  let file = null;
  let selfTest = false;
  let verbose = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--self-test') selfTest = true;
    else if (a === '--verbose') verbose = true;
    else if (a === '--file') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) { io.log('[FAIL] --file 缺少路径参数'); io.log('=== FAIL：0 项通过 / 1 项失败 ==='); return 1; }
      file = argv[i + 1];
      i += 1;
    } else { io.log(`[FAIL] 未知参数 ${a}（可用：--file <路径> / --self-test / --verbose）`); io.log('=== FAIL：0 项通过 / 1 项失败 ==='); return 1; }
  }
  if (selfTest) {
    if (file !== null) { io.log('[FAIL] --self-test 不能与 --file 同用（自证固定读真实 server.js 原文）'); io.log('=== FAIL：0 项通过 / 1 项失败 ==='); return 1; }
    return runSelfTest(io);
  }
  return runCheck(file === null ? SERVER_JS : file, verbose, io);
}

if (require.main === module) {
  const io = { readFile: (p) => fs.readFileSync(p, 'utf8'), log: (s) => console.log(s) };
  process.exitCode = main(process.argv.slice(2), io);
}

module.exports = { COUNTERS, evaluate, runCheck, runSelfTest, main };
