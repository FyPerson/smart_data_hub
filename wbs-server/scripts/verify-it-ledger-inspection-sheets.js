'use strict';
// C1（长任务 E · 巡检台账）接口层守卫。用 createFixture() 直接打 HTTP，不需要浏览器。
// 覆盖派单 spec-C1.md §三 12 条 + 变异自检 ≥5 处。
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { createFixture, isProbeViolation, normalizeInspectionRouteKey } = require('./it-ledger-browser-fixture');
let pass = 0;
function check(name, ok, detail) { if (!ok && detail !== undefined) console.error('DETAIL', name, JSON.stringify(detail)); assert.ok(ok, name); pass++; console.log('[OK] ' + name); }

// ============================================================
// G2A2（长任务 E 段2）：巡检单静态语法树守卫第四次被绕过（G1A 白名单硬门版仍被高阶函数收函数
// 引用、同名遮蔽/别名、路由注册返回值别名与条件注册绕过——G1A Opus 预筛 H1-H3/M1-M5）后，用户
// 2026-09-24 11:08 裁定 G2=A2：JS 静态分析对"写路由锁外不读库"这条性质本质上无法完备判定，
// 静态守卫只保留不涉及绑定/数据流分析的结构规则；"写路由锁外不读库"改由运行时探针保证（测试
// 模式下用 AsyncLocalStorage 记录每条 SQL 是否处在写请求的 withWrite 事务内，见
// routes/it-ledger/index.js 的 ledgerRequestContext/probeSql/_testHooks.sqlProbe，接口测试套件
// 末尾断言违规数精确为 0——见本文件"G2A2 运行时探针"节）。
//
// **结构约定检查声明（防误写，不防对抗性写法）**：以下 R1/R2/R5/R6/R7/R10 全部是"只做语法树层面的
// 结构核对"，可以被故意构造的高阶函数封装/间接调用/reflect 等手法绕过；它们的价值是防止无意间
// 写错（漏挂中间件、withWrite 数量算错、collectSnapshot 位置搬错、误引入数据库驱动），不是安全
// 边界。"写路由锁外不读库"这条真正的安全性质，权威保证在运行时探针（保证范围见下方 G3A 段落——
// 只到经 q.get/all/run/assertWrite 四个入口执行的 SQL 为止，不是"权威保证=能挡住任何写法"这种
// 无限定表述），不在这里（L5：本句订正措辞，删去容易被读成"运行时探针无限定保证"的省略写法）。
//
// G3A（41S/41T 审查订正保证边界）→ G3A-b（M6：探针入口扩到 assertWrite；M5：R10 扫描扩到四个
// 文件）：运行时探针的保证范围**只到经 withRead / withWrite 注入的 q.get/all/run/assertWrite
// 四个入口执行的 SQL 为止**——路由文件（或其 require 的本地助手模块）若自行引入数据库驱动
// （sqlite3/better-sqlite3 等，不在各自文件的 require 白名单内）绕开这四个入口直接执行 SQL，
// 探针看不到，不在这套运行时保证的覆盖范围内；这部分改由 R10 结构规则挡住（禁止巡检相关路由
// 文件及其本地助手模块 inspection-photo-files.js 引入白名单外的驱动/助手、工厂参数解构键集合
// 与预期全等、不得出现 RestElement/非 Identifier 键），不是"任何写法都绕不过"。
//
// runSheetRouteGuard(src, options?) 是纯函数：只做 acorn 解析与规则判定，不 check()、不读文件。
// 真实源码调用方式见 main() 内"R1-R9静态守卫"节——读文件、调用本函数、对返回的 {violations,
// routes} 做 check() 断言。负向用例（本文件"负向用例：24条判别力"节）对同一个函数喂由真实源码
// 程序化字符串替换得到的变体。
//
// 规则清单（结构约定检查，全部是"只放行"，未列出的写法一律产生 violation）：
//   R1 路由注册——router 标识符全文件只允许出现在三处：①恰一处 const router=express.Router()
//      声明 ②工厂函数 return {...,router,...}(shorthand 导出) ③作为 router.<get|post|put|
//      delete>(...) 调用的 callee 对象，且该调用的直接父节点就是工厂函数体顶层的
//      ExpressionStatement 本身（不是赋值右侧/逻辑表达式/条件表达式/参数/序列表达式的一部分，
//      G2A2 修 H3：旧实现沿祖先链向上搜索最近的 ExpressionStatement，被"隔一层才是顶层语句"的
//      写法绕过）、非 computed、首参字符串字面量、中间参数只能是 MIDDLEWARE_WHITELIST 里的标识
//      符、末参是内联 async 箭头/函数表达式。express.Router() 全文件只允许调用一次。
//   R2 路由集合 + 中间件——写/读路由集合各自与预期(WRITE_ROUTES/READ_ROUTES)全等，每个键恰好
//      出现一次；每条写路由的中间参数必须恰好为 [requireLedgerWrite]，读路由必须为空数组
//      （G2A2 修 M1：旧实现只检查"中间参数都在白名单里"，空数组恒真，既拦不住写路由漏挂
//      requireLedgerWrite，也拦不住读路由被多挂）。
//   R5 withWrite 形态——每个写路由恰1处（采集路由恰2处）；每个回调内联、首句
//      `await <q参数名>.assertWrite(req.user)`（须非计算属性访问，G2A2 修 L2）；withWrite
//      标识符全文件只允许出现在工厂参数解构声明与直接调用 callee 两处；全文件 withWrite 总数=
//      路由内总数+两个清理助手(queueUploadAborted/processCleanupQueue)各1(逐函数精确计数)。
//   R6 读路由处理器不得出现 withWrite。
//   R7 采集路由形态——collect.collectSnapshot 全文件恰出现1次，位于采集路由处理器内、两次
//      withWrite 之间（G2A2 修 M2：旧实现按"锁外白名单"方式扫描，隐含只看采集路由自己；本轮直接
//      扫全文件，任何其它路由出现即判违规）。
//   R8（G2A2 Commit2，主会话裁定新增；G3A 收窄改名）——runCleanupDetached 标识符（清理队列维护
//      动作退出请求 ALS 上下文的专属通道，由 index.js 注入，只接受一个数字型 limit、不接受任何
//      回调）只允许出现在工厂参数解构声明处 + 处理清理队列的 processCleanupQueueBestEffort 函数
//      体内恰好一次直接调用；出现在任何路由处理器内或本文件其它位置（含别名、透传）一律判违规。
//   R10（G3A 新增，41S/41T H1 部分成立后的结构规则；G3A-b M5 改白名单全等 + 扫描扩到
//      inspection-photo-files.js；G3A-c 41RT M5 覆盖动态入口）——巡检相关路由文件
//      （inspection-sheets.js、inspections.js、inspection-collect.js）及其 require 的本地助手
//      模块（inspection-photo-files.js）：①require() 的参数必须是单一字符串字面量且在各文件
//      固定白名单内（全等比较，不是只挡 sqlite3/better-sqlite3 的黑名单，动态 require 或白名单
//      外的任何依赖都判违规）；②不得使用动态 import()（ImportExpression）；③不得使用
//      module.require(...)（MemberExpression 形式的调用）；④require 标识符不得被当值引用
//      （赋值/传递给别的标识符后再调用，只要不是直接调用点就判违规）；⑤
//      createInspectionSheets / createInspections / createInspectionCollect 工厂参数解构的键
//      集合必须与各自的预期集合全等（固定注入依赖集合，新增依赖即判违规，须同步更新预期），且
//      不得出现 RestElement 或非 Identifier 键（否则会绕开①⑤的全等比较本身）——防止路由文件
//      （或其本地助手模块）绕开 withRead/withWrite/assertWrite 引入独立的数据库访问路径，这部分
//      探针本身看不见。**保证边界**：R10 挡的是"直接 require / 动态 import / module.require /
//      经上述四个本地模块间接"这些常规入口；eval()/new Function()/process.binding() 等更隐蔽的
//      代码执行/原生绑定入口，是这条纯语法树结构规则的已知限制，不追补（真要挡这些需要更重的静态
//      分析甚至运行时沙箱）。
//
// 已删除（不再声明，改由运行时探针保证）：旧 R3 写处理器锁外调用白名单（IDENTIFIER_WHITELIST/
// memberCallOk/rootRestrictedMemberOk 一整套"根类别"判定）、旧 R4 纯助手本体约束（禁用标识符/
// it_前缀字符串扫描）、旧 TH1 叠加层（写路由体内禁 withRead、受控表字符串与 q.get/q.all 只许出
// 现在 withWrite 回调内）——这些规则本质上都是"锁外不能碰库"的静态近似，连续四轮被绕过后判定
// JS 语法树层面做不到完备，见本节开头的 G2=A2 裁定。
// ============================================================
const SHEET_WRITE_ROUTES = new Set(['post:/', 'post:/archive', 'put:/:id', 'post:/:id/submit', 'delete:/:id', 'post:/:id/restore', 'post:/:id/unarchive', 'post:/:id/photos', 'delete:/:id/photos/:photoId', 'delete:/:id/pending-photos', 'post:/:id/items/:itemId/collect']);
const SHEET_READ_ROUTES = new Set(['get:/', 'get:/overview', 'get:/stats', 'get:/deleted', 'get:/:id', 'get:/:id/photos/:photoId/content']);
const SHEET_ALL_EXPECTED_ROUTES = new Set([...SHEET_WRITE_ROUTES, ...SHEET_READ_ROUTES]);
const SHEET_MIDDLEWARE_WHITELIST = new Set(['requireLedgerWrite']);
const SHEET_COLLECT_ROUTE_KEY = 'post:/:id/items/:itemId/collect';
// R5：全文件 withWrite 总数校验用的"两个清理助手"——各自独立判据（见 R5 续），逐函数精确计数
// withWrite=1。queueUploadAborted(未入库上传文件兜底清理入队)、processCleanupQueue(清理队列
// 重试)。
const SHEET_WHITELIST_FUNCTIONS = ['queueUploadAborted', 'processCleanupQueue'];
// R10（G3A 新增）：createInspectionSheets 工厂参数解构键的预期集合——固定注入依赖集合，新增/减少
// 依赖即判违规（须同步更新这里）。与 routes/it-ledger/inspection-sheets.js 顶部
// module.exports 那一行的真实签名逐字对应。
const SHEET_EXPECTED_DEPS = ['withRead', 'withWrite', 'requireLedgerWrite', 'handleErr', 'recordManagement', 'storageDir', 'testHooks', 'collect', 'stripFinance', 'runCleanupDetached'];
// R10（G3A 新增）：createInspections（routes/it-ledger/inspections.js）与 createInspectionCollect
// （routes/it-ledger/inspection-collect.js）各自的工厂参数解构键预期集合——main() 内单独对这两个
// 文件的真实源码跑一次 runDbAccessGuard（不接入 runSheetRouteGuard 的负向用例矩阵，那套矩阵只
// 变异 inspection-sheets.js 自己的源码）。
const INSPECTIONS_EXPECTED_DEPS = ['withRead', 'handleErr', 'collect', 'sheetVisibility', 'stripFinance'];
const INSPECTION_COLLECT_EXPECTED_DEPS = ['collector', 'recordManagement'];
// G3A-b（M5 必修）：四个文件各自的 require() 白名单——全等比较（不是"至少包含"），逐字对应各
// 文件顶部真实 require 语句（2026-09-24 实测扫描结果，新增/减少依赖须同步更新这里）。
// inspection-photo-files.js 是 inspection-sheets.js require 的本地助手模块，没有工厂函数（导出
// 一组普通函数，不走依赖注入），下面 factoryFnName 传 null，只跑 require 检查这一半。
const SHEET_REQUIRE_WHITELIST = ['express', 'crypto', 'fs', './inspection-photo-files'];
const INSPECTIONS_REQUIRE_WHITELIST = ['express'];
const INSPECTION_COLLECT_REQUIRE_WHITELIST = [];
const INSPECTION_PHOTO_FILES_REQUIRE_WHITELIST = ['fs', 'path', 'crypto', 'multer'];

// G3A（R10 新增）：walk 提升到模块作用域——供 runSheetRouteGuard 与新增的 runDbAccessGuard（R10，
// 巡检相关三个路由文件共用同一份"禁引入数据库驱动/工厂依赖键集合全等"判定）共用同一份 AST 遍历
// 实现，不在两处各写一份。纯函数，不依赖任何闭包状态。
function walk(node, visit, parents) {
  if (!node || typeof node.type !== 'string') return;
  const myParents = parents || [];
  visit(node, myParents);
  const nextParents = myParents.concat([node]);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'range') continue;
    const v = node[key];
    if (Array.isArray(v)) { for (const it of v) walk(it, visit, nextParents); }
    else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v, visit, nextParents);
  }
}

// G3A（R10 新增）→ G3A-b（M5 必修，改白名单全等比较 + 扫描扩到 inspection-photo-files.js）：
// 巡检相关路由文件（inspection-sheets.js/inspections.js/inspection-collect.js）及其 require 的
// 本地助手模块（inspection-photo-files.js）共用的结构规则——
//   ① require() 的参数必须是单一字符串字面量，且该字符串必须在 requireWhitelist 内（全等比较，
//      不是"只挡 sqlite3/better-sqlite3 黑名单"——新增任何依赖都要求先同步这里的白名单，动态
//      require（变量/表达式）一律判违规，不管值是什么）。
//   ② 工厂函数（module.exports = function <factoryFnName>({...})）的参数解构：不得出现
//      RestElement（`{...rest}`）或非 Identifier 键（如计算属性 `{[x]: y}`）——旧实现只统计
//      Property+Identifier 的键，RestElement/计算键会被直接跳过、既不算 extra 也不算 missing，
//      是全等比较的一个逃逸口；解构键集合本身仍须与 expectedDeps 全等。factoryFnName 传
//      null/undefined 时跳过这一整段（inspection-photo-files.js 导出一组普通函数，没有工厂/
//      依赖注入，只需要检查①）。
// 纯函数，接收已解析好的 acorn AST（调用方自己 parse，PARSE 失败由调用方处理，与
// runSheetRouteGuard 的既有约定一致）。返回 violations 数组，每条 { rule: 'R10', detail }。
function runDbAccessGuard(ast, src, factoryFnName, expectedDeps, requireWhitelist) {
  const violations = [];
  const fileLabel = factoryFnName || '(inspection-photo-files.js)';
  function violate(detail) { violations.push({ rule: 'R10', detail: { file: fileLabel, ...detail } }); }
  const whitelist = new Set(requireWhitelist || []);
  const badRequires = [];
  const requiredLiterals = new Set();
  walk(ast, (node) => {
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require') {
      const arg = node.arguments[0];
      const isLiteralString = node.arguments.length === 1 && arg && arg.type === 'Literal' && typeof arg.value === 'string';
      if (!isLiteralString) badRequires.push({ start: node.start, reason: 'require参数不是单一字符串字面量(动态require)' });
      else {
        requiredLiterals.add(arg.value);
        if (!whitelist.has(arg.value)) badRequires.push({ start: node.start, reason: 'require目标不在固定白名单内', value: arg.value });
      }
    }
  });
  if (badRequires.length) {
    violate({ reason: 'require调用不合规(动态require或目标不在白名单内)', count: badRequires.length, details: badRequires });
  }
  // C7-c（Opus预筛 MED-5 附带项）：白名单原来只是"子集"判据——只挡"调用了白名单外的模块"，
  // 白名单本身可以比真实 require 语句更宽（挂着从未被实际 require() 过的模块名）而不会被判
  // 违规，导致上面 106-108 行注释宣称的"全等比较"名不副实。这里反向核对白名单每一项是否都被
  // 实际 require() 过，多出来的一律判违规，使其成为真正的全等比较（依赖被删掉之后，如果忘记
  // 同步收窄白名单，这里会立刻报违规提醒）。四份白名单（2026-09-25 实测扫描结果）已逐字对应
  // 各文件真实 require 语句，本次收紧不需要再改任何白名单常量。
  const unusedWhitelist = (requireWhitelist || []).filter((w) => !requiredLiterals.has(w));
  if (unusedWhitelist.length) {
    violate({ reason: 'require白名单存在从未被实际require()过的多余项(与真实依赖不全等)', unusedWhitelist });
  }
  // G3A-c（41RT M5 必修）：R10 覆盖动态引入入口——旧实现只识别 callee 为标识符 require 的直接
  // 调用，以下三类写法都绕开了这条检查：
  //   ① 动态 import('node:sqlite')（ImportExpression，与 require() 平行的另一套模块加载入口，
  //      本仓库全部是 CommonJS，正常代码不会出现，出现即可疑）。
  //   ② module.require('sqlite3')（MemberExpression 形式的调用，callee 不是裸标识符
  //      require，文本扫描"callee.name==='require'"看不到）。
  //   ③ require 被当值引用而非直接调用（如 const r = require; 之后 r('sqlite3')）——真正的
  //      恶意调用点 r(...) 的 callee 是 r 不是 require，R10 原有逻辑对 r(...) 视而不见；改为
  //      直接判"require 这个标识符只要不是被直接调用（不是某个 CallExpression 的 callee），
  //      出现在任何位置都算违规"，不给它被赋值/传递的机会。
  const importExprs = [];
  const moduleRequireCalls = [];
  const requireAsValueRefs = [];
  walk(ast, (node, parents) => {
    if (node.type === 'ImportExpression') importExprs.push(node);
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed
      && node.callee.object.type === 'Identifier' && node.callee.object.name === 'module'
      && node.callee.property.type === 'Identifier' && node.callee.property.name === 'require') {
      moduleRequireCalls.push(node);
    }
    if (node.type === 'Identifier' && node.name === 'require') {
      const parent = parents[parents.length - 1];
      const isDirectCallCallee = !!(parent && parent.type === 'CallExpression' && parent.callee === node);
      if (!isDirectCallCallee) requireAsValueRefs.push(node);
    }
  });
  if (importExprs.length) {
    violate({ reason: '不得使用动态 import()(ImportExpression)引入模块', count: importExprs.length, positions: importExprs.map((n) => n.start) });
  }
  if (moduleRequireCalls.length) {
    violate({ reason: '不得使用 module.require(...) 引入模块', count: moduleRequireCalls.length, positions: moduleRequireCalls.map((n) => n.start) });
  }
  if (requireAsValueRefs.length) {
    violate({ reason: 'require 标识符被当值引用(赋值/传递)而非直接调用,可能被换个名字后再调用绕开检查', count: requireAsValueRefs.length, positions: requireAsValueRefs.map((n) => n.start) });
  }
  // 保证边界（41RT M5）：R10 挡的是"直接 require / 动态 import / module.require / 经上述四个
  // 本地模块间接"这些常规入口；eval()/new Function()/process.binding() 等更隐蔽的代码执行/
  // 原生绑定入口，是这条纯语法树结构规则的已知限制（列为限制，不追补——真要挡这些需要更重的
  // 静态分析甚至运行时沙箱，不是"扫 AST 找几种调用形状"能覆盖的范畴）。
  if (!factoryFnName) return violations;
  let factoryNode = null;
  walk(ast, (node) => {
    if (factoryNode) return;
    if (node.type === 'FunctionExpression' && node.id && node.id.name === factoryFnName) factoryNode = node;
  });
  if (!factoryNode) {
    violate({ reason: `找不到工厂函数${factoryFnName}` });
  } else if (factoryNode.params.length !== 1 || factoryNode.params[0].type !== 'ObjectPattern') {
    violate({ reason: '工厂函数参数不是单一对象解构模式' });
  } else {
    const props = factoryNode.params[0].properties;
    const badProps = props.filter((p) => p.type === 'RestElement' || (p.type === 'Property' && p.key.type !== 'Identifier'));
    if (badProps.length) {
      violate({ reason: '工厂参数解构出现RestElement或非Identifier键(会绕开下面的键集合全等比较,让新增依赖不被计入extra)', count: badProps.length, positions: badProps.map((p) => p.start) });
    }
    const gotKeys = props
      .filter((p) => p.type === 'Property' && p.key.type === 'Identifier')
      .map((p) => p.key.name);
    const gotSet = new Set(gotKeys);
    const expectedSet = new Set(expectedDeps);
    const missing = expectedDeps.filter((k) => !gotSet.has(k));
    const extra = gotKeys.filter((k) => !expectedSet.has(k));
    const duplicated = gotKeys.length !== gotSet.size;
    if (missing.length || extra.length || duplicated) {
      violate({ reason: '工厂参数解构键集合与预期不全等', got: gotKeys, expected: expectedDeps, missing, extra, duplicated });
    }
  }
  return violations;
}

function runSheetRouteGuard(src, options) {
  const opts = options || {};
  const WRITE = opts.writeRoutes || SHEET_WRITE_ROUTES;
  const READ = opts.readRoutes || SHEET_READ_ROUTES;
  const ALL_EXPECTED = new Set([...WRITE, ...READ]);

  const violations = [];
  function violate(rule, detail) { violations.push({ rule, detail }); }
  let ast;
  try {
    const acorn = require('acorn');
    ast = acorn.parse(src, { ecmaVersion: 2022, sourceType: 'script' });
  } catch (e) {
    // 35T-R H1：require/parse 失败直接判整体失败（本函数返回一个必然让调用方 violations.length===0
    // 断言失败的结果），不降级为文本切片、不新增 package.json 依赖。
    violate('PARSE', { message: e.message });
    return { violations, routes: [] };
  }

  let factoryNode = null;
  walk(ast, (node) => {
    if (node.type === 'FunctionExpression' && node.id && node.id.name === 'createInspectionSheets') factoryNode = node;
  });
  if (!factoryNode) { violate('R1', { reason: '找不到 createInspectionSheets 工厂函数' }); return { violations, routes: [] }; }

  // ---- R1：router 标识符只允许出现在三处 ----
  const knownGoodRouterNodes = new Set();

  const routerDecls = [];
  walk(ast, (node) => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.id.name === 'router'
      && node.init && node.init.type === 'CallExpression' && node.init.callee.type === 'MemberExpression'
      && !node.init.callee.computed && node.init.callee.object.type === 'Identifier' && node.init.callee.object.name === 'express'
      && node.init.callee.property.type === 'Identifier' && node.init.callee.property.name === 'Router') {
      routerDecls.push(node);
    }
  });
  if (routerDecls.length === 1) knownGoodRouterNodes.add(routerDecls[0].id);
  else violate('R1', { reason: 'const router = express.Router() 不是恰好一处', count: routerDecls.length });

  const allExpressRouterCalls = [];
  walk(ast, (node) => {
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed
      && node.callee.object.type === 'Identifier' && node.callee.object.name === 'express'
      && node.callee.property.type === 'Identifier' && node.callee.property.name === 'Router') {
      allExpressRouterCalls.push(node);
    }
  });
  if (allExpressRouterCalls.length !== 1) violate('R1', { reason: 'express.Router() 全文件出现次数不为1', count: allExpressRouterCalls.length });

  const returnRouterShorthands = [];
  walk(ast, (node) => {
    if (node.type === 'ReturnStatement' && node.argument && node.argument.type === 'ObjectExpression') {
      for (const prop of node.argument.properties) {
        if (prop.type === 'Property' && prop.shorthand && !prop.computed
          && prop.key.type === 'Identifier' && prop.key.name === 'router') {
          returnRouterShorthands.push(prop);
        }
      }
    }
  });
  if (returnRouterShorthands.length === 1) {
    knownGoodRouterNodes.add(returnRouterShorthands[0].key);
    if (returnRouterShorthands[0].value !== returnRouterShorthands[0].key) knownGoodRouterNodes.add(returnRouterShorthands[0].value);
  } else {
    violate('R1', { reason: 'return {...,router,...}(shorthand) 不是恰好一处', count: returnRouterShorthands.length });
  }

  // 修 G2A2 派单 H3（原 G1A Opus 预筛 H3）：旧实现沿 parents 数组从深到浅搜索"最近的
  // ExpressionStatement 祖先"，只要曾祖先链上某处有一个 ExpressionStatement 挂在工厂体顶层就
  // 判定合法——这让 `let r2; r2 = router.get(...)`（AssignmentExpression 包一层）、
  // `testHooks && router.get(...)`（LogicalExpression 包一层）、`helper(router.post(...))`
  // （CallExpression 包一层）这类"隔了一层才是顶层语句"的写法被误判为合法路由注册。新实现只认
  // "CallExpression 的直接父节点就是 ExpressionStatement 本身，且该 ExpressionStatement.expression
  // 恰是这个调用节点"，不再向上搜索更远的祖先。
  function isTopLevelStatementOfFactory(callNode, parents) {
    const n = parents.length;
    if (n < 3) return false;
    const immediateParent = parents[n - 1];
    if (!immediateParent || immediateParent.type !== 'ExpressionStatement' || immediateParent.expression !== callNode) return false;
    return parents[n - 2] === factoryNode.body && parents[n - 3] === factoryNode;
  }

  const routeCalls = [];
  walk(ast, (node, parents) => {
    if (node.type !== 'CallExpression') return;
    if (node.callee.type !== 'MemberExpression') return;
    let objectHasRouterIdentifier = false;
    let cursor = node.callee.object;
    let directRouterObject = null;
    if (cursor.type === 'Identifier' && cursor.name === 'router') { objectHasRouterIdentifier = true; directRouterObject = cursor; }
    else if (cursor.type === 'CallExpression') {
      let inner = cursor;
      while (inner && inner.type === 'CallExpression' && inner.callee && inner.callee.type === 'MemberExpression') {
        if (inner.callee.object.type === 'Identifier' && inner.callee.object.name === 'router') { objectHasRouterIdentifier = true; break; }
        inner = inner.callee.object;
      }
    }
    if (!objectHasRouterIdentifier) return;

    const pathArg = node.arguments[0];
    const handler = node.arguments[node.arguments.length - 1];
    const middleArgs = node.arguments.slice(1, -1);
    const method = node.callee.property && node.callee.property.type === 'Identifier' ? node.callee.property.name : null;
    const ok = !node.callee.computed
      && directRouterObject !== null
      && method && ['get', 'post', 'put', 'delete'].includes(method)
      && pathArg && pathArg.type === 'Literal' && typeof pathArg.value === 'string'
      && middleArgs.every((a) => a.type === 'Identifier' && SHEET_MIDDLEWARE_WHITELIST.has(a.name))
      && handler && (handler.type === 'ArrowFunctionExpression' || handler.type === 'FunctionExpression') && handler.async === true
      && isTopLevelStatementOfFactory(node, parents);
    if (ok) {
      knownGoodRouterNodes.add(directRouterObject);
      routeCalls.push({ key: method + ':' + pathArg.value, handler, node, middlewareNames: middleArgs.map((a) => a.name) });
    } else {
      violate('R1', {
        reason: '路由注册写法不合法(computed/非顶层/路径非字面量/中间件不在白名单/处理器非内联async函数)',
        snippet: src.slice(node.start, Math.min(node.end, node.start + 100)),
      });
    }
  });

  const allRouterIdentifiers = [];
  walk(ast, (node) => { if (node.type === 'Identifier' && node.name === 'router') allRouterIdentifiers.push(node); });
  const badRouterRefs = allRouterIdentifiers.filter((n) => !knownGoodRouterNodes.has(n));
  if (badRouterRefs.length) violate('R1', { reason: 'router标识符出现在三处已知写法之外', count: badRouterRefs.length, positions: badRouterRefs.map((n) => n.start) });

  // ---- R2：路由键集合与预期全等 ----
  const routeKeys = routeCalls.map((r) => r.key);
  const keyCounts = {};
  for (const k of routeKeys) keyCounts[k] = (keyCounts[k] || 0) + 1;
  const duplicated = Object.entries(keyCounts).filter(([, c]) => c !== 1);
  if (duplicated.length) violate('R2', { reason: '路由键重复', duplicated });
  const routeKeysSet = new Set(routeKeys);
  const missing = [...ALL_EXPECTED].filter((k) => !routeKeysSet.has(k));
  const extra = [...routeKeysSet].filter((k) => !ALL_EXPECTED.has(k));
  if (missing.length || extra.length) violate('R2', { reason: '路由键集合与预期不全等', missing, extra });
  const gotWrite = routeKeys.filter((k) => WRITE.has(k));
  const gotRead = routeKeys.filter((k) => READ.has(k));
  if (gotWrite.length !== WRITE.size || [...WRITE].some((k) => !gotWrite.includes(k))) violate('R2', { reason: '写路由集合与预期不全等', got: gotWrite });
  if (gotRead.length !== READ.size || [...READ].some((k) => !gotRead.includes(k))) violate('R2', { reason: '读路由集合与预期不全等', got: gotRead });
  // 修 M1（G2A2 派单）：逐路由核对中间参数——写路由必须恰好为 [requireLedgerWrite]，读路由必须
  // 为空数组。旧实现只检查"中间参数都在白名单里"（.every，空数组恒真），既不能拦"写路由漏挂
  // requireLedgerWrite"也不能拦"读路由被多挂 requireLedgerWrite"。
  for (const rc of routeCalls) {
    if (WRITE.has(rc.key)) {
      const middlewareOk = rc.middlewareNames.length === 1 && rc.middlewareNames[0] === 'requireLedgerWrite';
      if (!middlewareOk) violate('R2', { key: rc.key, reason: '写路由中间参数必须恰好为[requireLedgerWrite]', got: rc.middlewareNames });
    } else if (READ.has(rc.key)) {
      if (rc.middlewareNames.length !== 0) violate('R2', { key: rc.key, reason: '读路由不得包含任何中间件', got: rc.middlewareNames });
    }
  }

  // ---- R5/R6/R7：逐路由判定（G2A2 降级：删除 R3 锁外调用白名单 / R4 纯助手本体约束 / TH1
  // 叠加层——这些承诺改由运行时探针保证，静态层不再声称；只保留不涉及绑定/数据流分析的结构规则）----
  function findWithWriteCalls(handlerNode) {
    const calls = [];
    walk(handlerNode, (node) => { if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'withWrite') calls.push(node); });
    return calls;
  }

  const perRouteWithWrite = [];
  for (const rc of routeCalls) {
    const withWriteCalls = findWithWriteCalls(rc.handler);
    const expectedCount = rc.key === SHEET_COLLECT_ROUTE_KEY ? 2 : (WRITE.has(rc.key) ? 1 : 0);
    perRouteWithWrite.push({ key: rc.key, withWriteCalls, expectedCount });

    if (READ.has(rc.key)) {
      if (withWriteCalls.length !== 0) violate('R6', { key: rc.key, reason: '读路由不得出现withWrite', count: withWriteCalls.length });
      continue;
    }
    if (withWriteCalls.length !== expectedCount) {
      violate('R5', { key: rc.key, reason: 'withWrite数量与预期不符', got: withWriteCalls.length, expected: expectedCount });
    }
    for (const wwCall of withWriteCalls) {
      const cbArg = wwCall.arguments[0];
      const isInline = cbArg && (cbArg.type === 'ArrowFunctionExpression' || cbArg.type === 'FunctionExpression');
      if (!isInline) { violate('R5', { key: rc.key, reason: 'withWrite回调不是内联函数' }); continue; }
      const qParamName = cbArg.params[0] && cbArg.params[0].type === 'Identifier' ? cbArg.params[0].name : null;
      const body = cbArg.body.type === 'BlockStatement' ? cbArg.body.body : null;
      const first = body && body[0];
      // 修 L2（G2A2 派单）：q.assertWrite 必须是非计算属性访问——旧实现只比对
      // `callee.property.name === 'assertWrite'`，对 `q['assertWrite'](req.user)` 这类计算属性
      // 访问，property 节点是 Literal（没有 .name，恒 undefined）已经间接落空，但没有显式声明
      // "必须非计算访问"这条契约本身，补 `!callee.computed` 让判据名实相符、也堵住
      // `q[assertWriteAliasVar]()`（变量名恰好叫 assertWrite）这种边界写法。
      const firstOk = !!(qParamName && first && first.type === 'ExpressionStatement' && first.expression.type === 'AwaitExpression'
        && first.expression.argument.type === 'CallExpression'
        && first.expression.argument.callee.type === 'MemberExpression'
        && !first.expression.argument.callee.computed
        && first.expression.argument.callee.object.type === 'Identifier' && first.expression.argument.callee.object.name === qParamName
        && first.expression.argument.callee.property.type === 'Identifier'
        && first.expression.argument.callee.property.name === 'assertWrite'
        && first.expression.argument.arguments.length === 1
        && first.expression.argument.arguments[0].type === 'MemberExpression'
        && first.expression.argument.arguments[0].object.name === 'req' && first.expression.argument.arguments[0].property.name === 'user');
      if (!firstOk) violate('R5', { key: rc.key, reason: 'withWrite回调首句不是await q.assertWrite(req.user)(非计算属性访问)' });
    }
  }

  // ---- R7：采集路由形态——collect.collectSnapshot 全文件恰出现 1 次，位于采集路由处理器内、
  // 两次 withWrite 之间（修 M2：旧实现只在"采集路由自己锁外扫描"时才检查这条，本身已经隐含"只看
  // 采集路由"，本轮直接扫全文件——任何路由(含采集路由自己的withWrite回调内、任何其它路由锁内锁外)
  // 多出现一次都判违规，唯一合法位置是采集路由锁外、两次withWrite之间）----
  const allCollectSnapshotCalls = [];
  walk(ast, (node) => {
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed
      && node.callee.object.type === 'Identifier' && node.callee.object.name === 'collect'
      && node.callee.property.type === 'Identifier' && node.callee.property.name === 'collectSnapshot') {
      allCollectSnapshotCalls.push(node);
    }
  });
  // M1（41T 必修）→ M4（G3A-b 必修，改按命中位置计算 key）：R7 违规详情的 key 不再恒填
  // SHEET_COLLECT_ROUTE_KEY——按"命中位置落在哪条 routeCalls 的 handler 区间内"计算，落在任何
  // 已注册路由的 handler 区间之外（比如顶层模块代码、某个共享助手函数体内，不属于任何一条路由的
  // 处理器）填 '(非路由)'；另加 ownerKey 恒记 SHEET_COLLECT_ROUTE_KEY——R7 这条规则概念上"属于"
  // 采集路由这一条（不管命中数超标的那个多余调用实际写在哪个路由里，R7 都是因为采集路由的这条
  // 约定被破坏才违规），key 答"在哪发现的"，ownerKey 答"这条规则归属哪"，两者用途不同不能合并。
  function routeKeyForPosition(pos) {
    const hit = routeCalls.find((rc) => pos >= rc.handler.start && pos <= rc.handler.end);
    return hit ? hit.key : '(非路由)';
  }
  if (allCollectSnapshotCalls.length !== 1) {
    // count!==1 时可能有 0 个（缺失，没有"命中位置"可言）或 >=2 个（多出的那些各自可能落在不同
    // 路由里）——取"命中位置的路由键里，第一个不等于采集路由自己的那个"作为诊断用 key（多出的
    // 那次调用最有诊断价值：它说明了违规实际发生在哪）；找不到这样的位置（比如 count===0 缺失，
    // 或者恰巧全部命中都仍在采集路由自己范围内）就退回 ownerKey 本身。
    const hitKeys = allCollectSnapshotCalls.map((n) => routeKeyForPosition(n.start));
    const key = hitKeys.find((k) => k !== SHEET_COLLECT_ROUTE_KEY) || SHEET_COLLECT_ROUTE_KEY;
    violate('R7', { key, ownerKey: SHEET_COLLECT_ROUTE_KEY, reason: 'collect.collectSnapshot全文件命中数不为1', count: allCollectSnapshotCalls.length, hitKeys });
  } else {
    const hit = allCollectSnapshotCalls[0];
    const hitKey = routeKeyForPosition(hit.start);
    const collectRoute = routeCalls.find((rc) => rc.key === SHEET_COLLECT_ROUTE_KEY);
    const insideCollectHandler = !!(collectRoute && hit.start >= collectRoute.handler.start && hit.end <= collectRoute.handler.end);
    if (!insideCollectHandler) {
      violate('R7', { key: hitKey, ownerKey: SHEET_COLLECT_ROUTE_KEY, reason: 'collect.collectSnapshot不在采集路由处理器内(或采集路由本身未合法注册)', start: hit.start });
    } else {
      const collectWW = perRouteWithWrite.find((r) => r.key === SHEET_COLLECT_ROUTE_KEY);
      const cbRanges = (collectWW ? collectWW.withWriteCalls : []).map((c) => c.arguments[0]).filter(Boolean).map((cb) => [cb.start, cb.end]);
      if (cbRanges.length === 2) {
        const between = hit.start > cbRanges[0][1] && hit.end < cbRanges[1][0];
        if (!between) violate('R7', { key: hitKey, ownerKey: SHEET_COLLECT_ROUTE_KEY, reason: 'collect.collectSnapshot不在两次withWrite之间', start: hit.start });
      } else {
        violate('R7', { key: hitKey, ownerKey: SHEET_COLLECT_ROUTE_KEY, reason: '采集路由withWrite数量不为2,无法判定collectSnapshot位置', count: cbRanges.length });
      }
    }
  }

  // ---- R8（G2A2 Commit2，主会话裁定新增；G3A 随函数改名同步改名）：runCleanupDetached 标识符
  // 只允许出现在工厂参数解构声明处 + processCleanupQueueBestEffort 函数体内恰好一次直接调用；
  // 出现在任何路由处理器内或本文件其它位置即违规——这是清理队列维护动作退出请求 ALS 上下文的
  // 专属通道（只接受一个数字型 limit，不接受任何回调，见 index.js 该函数定义处注释），不得被
  // 挪用（比如塞进某个写路由处理器里）或起别名。----
  // 修 M3（G2A2b 必修）：工厂参数解构里 runCleanupDetached 只接受 shorthand（{ runCleanupDetached }），
  // 恰好出现一次；出现重命名（{ runCleanupDetached: d }）、重复键（{ runCleanupDetached,
  // runCleanupDetached: d }——JS 允许同一个属性名在解构模式里出现多次，各自独立绑定，都从同一个
  // deps.runCleanupDetached 取值，等于白送一个不受本规则监视的别名 d）或默认值（{ runCleanupDetached
  // = fallback }）都判违规——旧实现只按 prop.key.name==='runCleanupDetached' 匹配、不检查
  // shorthand/是否重复/value是不是同一个标识符，重命名/重复键能白送一个新别名，正是这条规则要
  // 堵的绕过口子。
  const knownGoodDetachNodes = new Set();
  const detachFactoryProps = (factoryNode.params.length === 1 && factoryNode.params[0].type === 'ObjectPattern')
    ? factoryNode.params[0].properties.filter((p) => p.type === 'Property' && p.key.type === 'Identifier' && p.key.name === 'runCleanupDetached')
    : [];
  if (detachFactoryProps.length !== 1) {
    violate('R8', { reason: '工厂参数解构里runCleanupDetached必须恰好出现一次', count: detachFactoryProps.length });
  } else {
    const prop = detachFactoryProps[0];
    if (!prop.shorthand || prop.value.type !== 'Identifier' || prop.value.name !== 'runCleanupDetached') {
      violate('R8', { reason: '工厂参数解构里runCleanupDetached只接受shorthand写法({ runCleanupDetached })，不接受重命名/默认值', snippet: src.slice(prop.start, prop.end) });
    } else {
      knownGoodDetachNodes.add(prop.key);
      if (prop.value !== prop.key) knownGoodDetachNodes.add(prop.value);
    }
  }
  let processCleanupQueueBestEffortNode = null;
  walk(ast, (node) => {
    if (processCleanupQueueBestEffortNode) return;
    if (node.type === 'FunctionDeclaration' && node.id && node.id.name === 'processCleanupQueueBestEffort') processCleanupQueueBestEffortNode = node;
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.id.name === 'processCleanupQueueBestEffort'
      && node.init && (node.init.type === 'ArrowFunctionExpression' || node.init.type === 'FunctionExpression')) processCleanupQueueBestEffortNode = node.init;
  });
  if (!processCleanupQueueBestEffortNode) {
    violate('R8', { reason: '找不到processCleanupQueueBestEffort函数定义' });
  } else {
    const detachCallsInside = [];
    walk(processCleanupQueueBestEffortNode, (node) => {
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'runCleanupDetached') {
        detachCallsInside.push(node);
        knownGoodDetachNodes.add(node.callee);
      }
    });
    if (detachCallsInside.length !== 1) violate('R8', { reason: 'processCleanupQueueBestEffort内runCleanupDetached直接调用数不为1', count: detachCallsInside.length });
  }
  const allDetachIdentifiers = [];
  walk(ast, (node) => { if (node.type === 'Identifier' && node.name === 'runCleanupDetached') allDetachIdentifiers.push(node); });
  const badDetachRefs = allDetachIdentifiers.filter((n) => !knownGoodDetachNodes.has(n));
  if (badDetachRefs.length) violate('R8', { reason: 'runCleanupDetached标识符出现在工厂参数声明与processCleanupQueueBestEffort内直接调用之外', count: badDetachRefs.length, positions: badDetachRefs.map((n) => n.start) });

  // ---- R9（G2A2b L3 顺手修）：processCleanupQueueBestEffort(...) 调用点只能以不 await 的独立
  // 语句出现（ExpressionStatement，expression 直接是该调用本身）；出现 await
  // processCleanupQueueBestEffort(...) 即违规——"响应发出之后顺带处理，不让本次请求等这把锁"
  // （C2c M1 既有设计约定）的静态体现：await它会让写请求重新等上这把清理锁，违背这个函数存在的
  // 意义，也会让 runCleanupDetached 的退出上下文动作发生在写请求的 finally/await 链路里，
  // 时序上更贴近"这次写请求还没结束"。----
  const allCleanupBestEffortCalls = [];
  walk(ast, (node, parents) => {
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'processCleanupQueueBestEffort') {
      allCleanupBestEffortCalls.push({ node, parents: parents.slice() });
    }
  });
  for (const { node, parents } of allCleanupBestEffortCalls) {
    const immediateParent = parents[parents.length - 1];
    if (immediateParent && immediateParent.type === 'AwaitExpression') {
      violate('R9', { reason: '出现await processCleanupQueueBestEffort(...)，不得await该调用', start: node.start });
      continue;
    }
    if (!immediateParent || immediateParent.type !== 'ExpressionStatement' || immediateParent.expression !== node) {
      violate('R9', { reason: 'processCleanupQueueBestEffort(...)调用必须是独立语句(ExpressionStatement直接持有该调用)', start: node.start });
    }
  }

  // ---- R5（续）：全文件 withWrite 总数 = 路由内总数 + 两个清理助手各 1（逐函数精确计数）----
  const cleanupHelperDecls = {};
  walk(ast, (node) => { if (node.type === 'FunctionDeclaration' && node.id && SHEET_WHITELIST_FUNCTIONS.includes(node.id.name)) cleanupHelperDecls[node.id.name] = node; });
  let totalWithWriteInHelpers = 0;
  for (const name of SHEET_WHITELIST_FUNCTIONS) {
    const node = cleanupHelperDecls[name];
    if (!node) { violate('R5', { fn: name, reason: '找不到清理助手FunctionDeclaration(逐函数withWrite计数需要)' }); continue; }
    const calls = [];
    walk(node, (n2) => { if (n2.type === 'CallExpression' && n2.callee.type === 'Identifier' && n2.callee.name === 'withWrite') calls.push(n2); });
    totalWithWriteInHelpers += calls.length;
    if (calls.length !== 1) violate('R5', { fn: name, reason: '清理助手withWrite命中数不为1(逐函数精确计数)', count: calls.length });
  }

  // ---- R5（续）：T2-H4，withWrite 标识符只出现在工厂参数声明与直接调用callee两处 ----
  // 修 M3（G2A2b 必修）：同 runCleanupDetached——工厂参数解构里 withWrite 只接受 shorthand、恰好
  // 出现一次，重命名/重复键/默认值都判违规（理由同上）。
  const knownGoodWithWriteNodes = new Set();
  walk(ast, (node) => { if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'withWrite') knownGoodWithWriteNodes.add(node.callee); });
  const withWriteFactoryProps = (factoryNode.params.length === 1 && factoryNode.params[0].type === 'ObjectPattern')
    ? factoryNode.params[0].properties.filter((p) => p.type === 'Property' && p.key.type === 'Identifier' && p.key.name === 'withWrite')
    : [];
  let factoryParamWithWriteNode = null;
  if (withWriteFactoryProps.length !== 1) {
    violate('R5', { reason: '工厂参数解构里withWrite必须恰好出现一次', count: withWriteFactoryProps.length });
  } else {
    const prop = withWriteFactoryProps[0];
    if (!prop.shorthand || prop.value.type !== 'Identifier' || prop.value.name !== 'withWrite') {
      violate('R5', { reason: '工厂参数解构里withWrite只接受shorthand写法({ withWrite })，不接受重命名/默认值', snippet: src.slice(prop.start, prop.end) });
    } else {
      knownGoodWithWriteNodes.add(prop.key);
      if (prop.value !== prop.key) knownGoodWithWriteNodes.add(prop.value);
      factoryParamWithWriteNode = prop;
    }
  }
  if (!factoryParamWithWriteNode) violate('R5', { reason: '找不到withWrite在工厂参数解构处的合法声明' });
  const allWithWriteIdentifiers = [];
  walk(ast, (node) => { if (node.type === 'Identifier' && node.name === 'withWrite') allWithWriteIdentifiers.push(node); });
  const badWithWriteRefs = allWithWriteIdentifiers.filter((n) => !knownGoodWithWriteNodes.has(n));
  if (badWithWriteRefs.length) violate('R5', { reason: 'withWrite标识符出现在别名/透传/解构等非法位置', count: badWithWriteRefs.length });

  let globalWithWriteCount = 0;
  walk(ast, (node) => { if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'withWrite') globalWithWriteCount++; });
  const totalWithWriteInRoutes = perRouteWithWrite.reduce((s, r) => s + r.withWriteCalls.length, 0);
  if (globalWithWriteCount !== totalWithWriteInRoutes + totalWithWriteInHelpers) {
    violate('R5', { reason: '全文件withWrite总数与(路由内总数+清理助手总数)不符', globalWithWriteCount, totalWithWriteInRoutes, totalWithWriteInHelpers });
  }

  // ---- R10（G3A 新增）：本文件（inspection-sheets.js）自己的"禁引入数据库驱动 + 工厂依赖键
  // 集合全等"检查——复用模块级 runDbAccessGuard，与 inspections.js/inspection-collect.js 共用
  // 同一份判定逻辑（main() 内单独对那两个文件的真实源码各跑一次）。----
  for (const v of runDbAccessGuard(ast, src, 'createInspectionSheets', SHEET_EXPECTED_DEPS, SHEET_REQUIRE_WHITELIST)) violations.push(v);

  return { violations, routes: routeKeys.slice().sort() };
}

async function verifyRedesignOverview() {
  const f = await createFixture({ cleanup: true });
  const equal = (name, actual, expected) => { assert.deepEqual(actual, expected, name); check(name, true); };
  const emptyRoom = room => ({ room, this_month_done: false, last_submitted_at: null, last_submitted_by_name: null, last_filled: null, last_total: null, last_abnormal: null, days_since_last: null, draft: null });
  const request = async (method, url, body, uid = 2, status = 200) => {
    const res = await f.api(method, url, body, uid);
    assert.equal(res.status, status, JSON.stringify(res.body));
    return res.body;
  };
  const rack = room => request('POST', '/racks', { name: room, room, u_total: 20 }, 1, 201);
  const draft = room => request('POST', '/inspections/sheets', { room_name: room }, 2, 201);
  async function submitted(room) {
    const s = await draft(room);
    const filled = await request('PUT', '/inspections/sheets/' + s.id, { expected_version: s.version, items: s.items.map(it => ({ id: it.id, result: it.value_kind === 'check' ? 'ok' : null, number_value: it.value_kind === 'number' ? (it.item_key === 'temperature' ? 22 : 45) : null, note: null })) });
    const fd = new FormData(); fd.append('slot', 'rack_front'); fd.append('target_id', String(s.scope.racks[0].id));
    fd.append('file', new Blob([Buffer.from([255,216,255,224,0,0,255,217])], {type:'image/jpeg'}), 'front.jpg');
    const photo = await fetch(f.base + '/api/it-assets/inspections/sheets/' + s.id + '/photos', {method:'POST',headers:{Authorization:'Bearer fixture-2'},body:fd});
    assert.equal(photo.status, 201);
    return request('POST', '/inspections/sheets/' + s.id + '/submit', { expected_version: filled.version });
  }
  try {
    const start = (await f.all("SELECT date('now','localtime') AS day"))[0].day;
    const [year, month, day] = start.split('-').map(Number);
    const monthStart = new Date(year, month - 1, 1, 0, 30).toISOString();
    const previousEnd = new Date(year, month - 1, 0, 23, 30).toISOString();
    const today = new Date(year, month - 1, day, 0, 30).toISOString();
    const overview = uid => request('GET', '/inspections/sheets/overview', undefined, uid);
    equal('OV无权限403', (await f.api('GET', '/inspections/sheets/overview', undefined, 4)).status, 403);
    equal('OV空库响应全等', await overview(1), {month:start.slice(0,7),rooms:[]});
    await rack('OV-A未巡检');
    equal('OV懒建前机房全等', await overview(3), {month:start.slice(0,7),rooms:[emptyRoom('OV-A未巡检')]});
    equal('OV只读不建巡检表', await f.all("SELECT name FROM sqlite_master WHERE name='it_inspection_sheets'"), []);
    for (const name of ['OV-B本月','OV-C上月','OV-D删除','OV-E草稿','OV-F历史']) await rack(name);
    const current = await submitted('OV-B本月');
    await f.run('UPDATE it_inspection_sheets SET submitted_at=? WHERE id=?', [monthStart,current.id]);
    const previous = await submitted('OV-C上月');
    await request('POST','/inspections/sheets/archive',{items:[{id:previous.id,expected_version:previous.version}]},1);
    await f.run('UPDATE it_inspection_sheets SET submitted_at=? WHERE id=?',[previousEnd,previous.id]);
    const removed = await submitted('OV-D删除');
    await request('DELETE','/inspections/sheets/'+removed.id,{expected_version:removed.version,reason:'OV删除'});
    // Historical room survives after its empty rack is moved, a production-reachable union case.
    const historical = await submitted('OV-F历史');
    await f.run('UPDATE it_inspection_sheets SET submitted_at=? WHERE id=?',[today,historical.id]);
    await request('PUT','/racks/'+historical.scope.racks[0].id,{room:'OV-A未巡检'},1);
    const owner = await draft('OV-E草稿');
    const badItem = owner.items.find(it => it.item_key === 'aircon');
    await request('PUT','/inspections/sheets/'+owner.id,{expected_version:owner.version,items:[{id:badItem.id,result:'bad',number_value:null,note:'测试异常'}]});
    const second = await draft('OV-B本月');
    const fullDraft = s => ({id:s.id,created_by_name:'测试维护员',created_at:s.created_at,filled:s.id === owner.id ? 1 : 0,total:12,visibility:'full',abnormal:s.id === owner.id ? 1 : 0});
    const ownerResult = await overview(2);
    const readerResult = await overview(3);
    const adminResult = await overview(1);
    const end = (await f.all("SELECT date('now','localtime') AS day"))[0].day;
    equal('OV运行期间跨日，请重跑', end, start);
    equal('OV机房集合和排序全等', ownerResult.rooms.map(r => r.room), ['OV-A未巡检','OV-B本月','OV-C上月','OV-D删除','OV-E草稿','OV-F历史']);
    equal('OV从未巡检字段全等', ownerResult.rooms[0], emptyRoom('OV-A未巡检'));
    const lastFields = (room, at, days, done) => ({...emptyRoom(room),this_month_done:done,last_submitted_at:at,last_submitted_by_name:'测试维护员',last_filled:12,last_total:12,last_abnormal:0,days_since_last:days});
    equal('OV月份边界上月归档不计本月', ownerResult.rooms[2], lastFields('OV-C上月',previousEnd,day,false));
    equal('OV本月月初与草稿共存字段全等', ownerResult.rooms[1], {...lastFields('OV-B本月',monthStart,day-1,true),draft:fullDraft(second)});
    equal('OV已删除单不计入', ownerResult.rooms[3], emptyRoom('OV-D删除'));
    equal('OV本人草稿full含abnormal', ownerResult.rooms[4], {...emptyRoom('OV-E草稿'),draft:fullDraft(owner)});
    const summaryDraft = {...fullDraft(owner),visibility:'summary'}; delete summaryDraft.abnormal;
    equal('OV他人草稿summary不含abnormal', readerResult.rooms[4], {...emptyRoom('OV-E草稿'),draft:summaryDraft});
    equal('OV管理员草稿full全等', adminResult.rooms[4], ownerResult.rooms[4]);
    equal('OV历史机房今日天数为零', ownerResult.rooms[5], lastFields('OV-F历史',today,0,true));
    // Newest submitted time wins even when its id is lower than a later-created backdated sheet.
    const later = await submitted('OV-C上月');
    await f.run('UPDATE it_inspection_sheets SET submitted_at=? WHERE id=?',[new Date(year,month-2,1,0,30).toISOString(),later.id]);
    equal('OV最近单按提交时间取归档单', (await overview(2)).rooms[2], ownerResult.rooms[2]);
    await request('DELETE','/inspections/sheets/'+second.id,{expected_version:second.version});
    const proxy = await draft('OV-B本月');
    const proxyFilled = await request('PUT','/inspections/sheets/'+proxy.id,{expected_version:proxy.version,items:proxy.items.map(it=>({id:it.id,result:it.value_kind==='check'?'ok':null,number_value:it.value_kind==='number'?(it.item_key==='temperature'?22:45):null,note:null}))},1);
    const fd = new FormData(); fd.append('slot','rack_front'); fd.append('target_id',String(proxy.scope.racks[0].id)); fd.append('file',new Blob([Buffer.from([255,216,255,224,0,0,255,217])],{type:'image/jpeg'}),'proxy.jpg');
    assert.equal((await fetch(f.base+'/api/it-assets/inspections/sheets/'+proxy.id+'/photos',{method:'POST',headers:{Authorization:'Bearer fixture-1'},body:fd})).status,201);
    await request('POST','/inspections/sheets/'+proxy.id+'/submit',{expected_version:proxyFilled.version},1);
    equal('OV代提交姓名取实际提交人', (await overview(2)).rooms[1].last_submitted_by_name, '测试管理员');
    const named = await request('GET','/inspections/sheets/'+owner.id,undefined,1);
    equal('OV日志姓名关联', named.log.map(l => l.actor_name), ['测试维护员']);
    await f.run('DELETE FROM users WHERE id=2');
    const missing = await request('GET','/inspections/sheets/'+owner.id,undefined,1);
    equal('OV日志用户不存在保留日志且姓名null', missing.log.map(l => ({actor_id:l.actor_id,actor_name:l.actor_name,action:l.action})), [{actor_id:2,actor_name:null,action:'create'}]);
    console.log('OVERVIEW_SAMPLE='+JSON.stringify(ownerResult));
  } finally { await f.close(); }
}

async function main() {
  await verifyRedesignOverview();
  // G2A2（长任务 E 段2）：运行时锁外读库探针——全套接口测试共用这一个收集器，sqlProbe 只记录不
  // 抛错，套件末尾统一断言（见文件尾"G2A2 运行时探针"节）。enableTestHooks:true 只解锁测试专用
  // seam（含本探针与 _internals 的行为改写型 setter），不改变任何既有断言依赖的生产行为。
  const sqlProbeRecords = [];
  // G3A（41T M2 必修）：逐例构造违规前先等前面的异步工作（比如某次写请求触发的
  // processCleanupQueueBestEffort 后台清理）真正结束——不这样做的话，若它恰好在某条用例的
  // "before~读一次"窗口内产生一条不相关的探针记录，会污染"恰好新增1条"这类精确计数断言（可能让
  // 用例假红，也可能让目标记录被淹没在噪音里还侥幸凑够条数假绿）。用"探针记录数连续几轮不再增长"
  // 判定"没有更多在途的异步写请求副作用了"，不是猜一个固定 sleep 时长。
  // G3A-b（L2）→ G3A-c（41RT M4 必修，改用可观测完成信号 + 超时即失败）：旧版只看"探针记录数
  // 连续3轮不再增长"——codex 41RT 指出这不能证明异步清理已经结束，超时后函数还会静默继续、让
  // 调用方在一个"可能仍有清理任务在途"的时刻取快照。改为：额外要求 index.js 新增的
  // getCleanupSettleCounters() 返回 started===settled（没有清理动作在途，这是真正的完成信号，
  // 不是记录数不再增长这种间接推断），且超时不再只打日志——直接 throw，让调用它的用例失败（不
  // 静默放行一个"取快照时机可能不对"的断言结果）。
  async function waitForProbeQuiescence(maxWaitMs) {
    const budget = maxWaitMs || 500;
    const deadline = Date.now() + budget;
    let last = sqlProbeRecords.length;
    let stableRounds = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
      const counters = f.internals.getCleanupSettleCounters();
      const cleanupIdle = counters.settled === counters.started;
      if (sqlProbeRecords.length === last && cleanupIdle) {
        stableRounds += 1;
        if (stableRounds >= 3) return;
      } else {
        stableRounds = 0;
        last = sqlProbeRecords.length;
      }
    }
    const counters = f.internals.getCleanupSettleCounters();
    throw new Error(`[verify-it-ledger-inspection-sheets] waitForProbeQuiescence: 等待${budget}ms后仍未稳定(探针记录数=${sqlProbeRecords.length}, cleanup started=${counters.started}/settled=${counters.settled})`);
  }
  const f = await createFixture({ enableTestHooks: true, sqlProbe: (rec) => sqlProbeRecords.push(rec) });
  console.log('ISOLATED_ARTIFACTS=' + f.dir);
  const NUMBER_DEFAULT = { temperature: 22, humidity: 45 };
  async function makeRoom(roomName, rackCount = 1, devicesPerRack = 1) {
    const racks = [];
    for (let i = 0; i < rackCount; i++) {
      const r = (await f.api('POST', '/racks', { name: roomName + '-柜' + (i + 1), room: roomName, u_total: 20 })).body;
      racks.push(r);
      for (let d = 0; d < devicesPerRack; d++) {
        await f.api('POST', '', { category: 'server', name: roomName + '-设备' + (i + 1) + '-' + (d + 1), u_height: 1, placement: { kind: 'rack', rack_id: r.id, u_start: d + 1 } });
      }
    }
    return racks;
  }
  const createSheet = (uid, roomName) => f.api('POST', '/inspections/sheets', { room_name: roomName }, uid);
  const getSheet = (sheetId, uid) => f.api('GET', '/inspections/sheets/' + sheetId, undefined, uid);
  async function currentVersion(sheetId) { const r = await getSheet(sheetId, 1); return r.body.version; }
  function fillPayloadAllOk(items) {
    return items.map((it) => (it.value_kind === 'number'
      ? { id: it.id, result: null, number_value: NUMBER_DEFAULT[it.item_key] ?? 25, note: null }
      : { id: it.id, result: 'ok', number_value: null, note: null }));
  }
  // C2：最小合法 JPEG 字节（SOI FFD8FF + 任意载荷 + EOI FFD9）——够 matchesMagic() 判定通过，不需要
  // 是真实可解码的图片（本模块从不真正解码像素）。
  const MIN_JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xd9]);
  // uploadPhoto：走真实 multipart（Node18+ FormData/Blob + fetch），不经过 f.api()（那个只发
  // JSON）。fixture 参数支持主夹具 f 或任何独立 fixture（如 H4 的 freshH4），只要有 .base。
  async function uploadPhoto(fixture, sheetId, slot, targetId, uid, opts = {}) {
    const fd = new FormData();
    fd.append('slot', slot);
    fd.append('target_id', String(targetId));
    const bytes = opts.bytes || MIN_JPEG_BYTES;
    const filename = opts.filename || 'p.jpg';
    fd.append('file', new Blob([bytes], { type: opts.mime || 'image/jpeg' }), filename);
    const resp = await fetch(fixture.base + '/api/it-assets/inspections/sheets/' + sheetId + '/photos', { method: 'POST', headers: { Authorization: 'Bearer fixture-' + uid }, body: fd });
    const body = await resp.json();
    return { status: resp.status, body };
  }
  async function deletePhoto(fixture, sheetId, photoId, uid) {
    const resp = await fetch(fixture.base + '/api/it-assets/inspections/sheets/' + sheetId + '/photos/' + photoId, { method: 'DELETE', headers: { Authorization: 'Bearer fixture-' + uid } });
    const body = await resp.json();
    return { status: resp.status, body };
  }
  async function discardPendingPhotos(fixture, sheetId, uid) {
    const resp = await fetch(fixture.base + '/api/it-assets/inspections/sheets/' + sheetId + '/pending-photos', { method: 'DELETE', headers: { Authorization: 'Bearer fixture-' + uid } });
    const body = await resp.json();
    return { status: resp.status, body };
  }
  async function getPhotoContent(fixture, sheetId, photoId, uid) {
    const resp = await fetch(fixture.base + '/api/it-assets/inspections/sheets/' + sheetId + '/photos/' + photoId + '/content', { headers: { Authorization: 'Bearer fixture-' + uid } });
    const buf = Buffer.from(await resp.arrayBuffer());
    return { status: resp.status, headers: resp.headers, buf };
  }
  // uploadAllRackFrontPhotos：每个机柜 1 张（§3.1"应传"的机柜正面照），供建单后要"全部填完可提交"
  // 的用例统一复用——不这样做，任何走完整提交流程的既有 C1 用例在 C2 之后都会因缺 rack_front 照片
  // 卡在 SHEET_INCOMPLETE（35T-R 之外、C2 新增的完整性维度）。
  async function uploadAllRackFrontPhotos(fixture, sheetId, scope, uid) {
    for (const r of scope.racks) {
      const res = await uploadPhoto(fixture, sheetId, 'rack_front', r.id, uid);
      assert.equal(res.status, 201, 'uploadAllRackFrontPhotos ' + JSON.stringify(res.body));
    }
  }
  async function buildDraftSheet(roomName, ownerUid = 2) {
    await makeRoom(roomName);
    const created = await createSheet(ownerUid, roomName);
    assert.equal(created.status, 201, 'buildDraftSheet create ' + roomName + ' ' + JSON.stringify(created.body));
    return created.body;
  }
  async function buildSubmittedSheet(roomName, ownerUid = 2) {
    const created = await buildDraftSheet(roomName, ownerUid);
    const detail = await getSheet(created.id, ownerUid);
    const put = await f.api('PUT', '/inspections/sheets/' + created.id, { expected_version: created.version, items: fillPayloadAllOk(detail.body.items) }, ownerUid);
    assert.equal(put.status, 200, 'buildSubmittedSheet put ' + roomName + ' ' + JSON.stringify(put.body));
    await uploadAllRackFrontPhotos(f, created.id, created.scope, ownerUid);
    const submit = await f.api('POST', '/inspections/sheets/' + created.id + '/submit', { expected_version: put.body.version }, ownerUid);
    assert.equal(submit.status, 200, 'buildSubmittedSheet submit ' + roomName + ' ' + JSON.stringify(submit.body));
    return submit.body;
  }

  try {
    // ============================================================
    // 2) 懒建：先确认表不存在、GET 不建表
    // ============================================================
    const t0 = await f.all("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('it_inspection_sheets','it_inspection_sheet_items','it_inspection_sheet_photos','it_inspection_sheet_log','it_inspection_file_cleanup')");
    check('数据库初始无巡检台账相关表', t0.length === 0);

    // ============================================================
    // 1) 路由命中：GET /inspections/sheets 返回台账列表结构（不是设备巡检的 400/404）
    // ============================================================
    const hit = await f.api('GET', '/inspections/sheets');
    check('GET /inspections/sheets 命中台账列表结构', hit.status === 200 && Array.isArray(hit.body.items) && hit.body.items.length === 0, hit.body);

    const t1 = await f.all("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('it_inspection_sheets','it_inspection_sheet_items','it_inspection_sheet_photos','it_inspection_sheet_log','it_inspection_file_cleanup')");
    check('GET 不建表', t1.length === 0);

    // ============================================================
    // 建第一张单，触发懒建；同时给后面的 CHECK 反例测试提供一个存在的 sheet_id
    // ============================================================
    await makeRoom('R1');
    const mainCreated = await createSheet(2, 'R1');
    check('建单201', mainCreated.status === 201, mainCreated.body);
    const sheetIdMain = mainCreated.body.id;

    const t2 = (await f.all("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('it_inspection_sheets','it_inspection_sheet_items','it_inspection_sheet_photos','it_inspection_sheet_log','it_inspection_file_cleanup') ORDER BY name")).map((x) => x.name).sort();
    const expectedTables = ['it_inspection_file_cleanup', 'it_inspection_sheet_items', 'it_inspection_sheet_log', 'it_inspection_sheet_photos', 'it_inspection_sheets'].sort();
    check('建单后五表齐全', JSON.stringify(t2) === JSON.stringify(expectedTables), t2);

    const idx = (await f.all("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('it_inspection_sheets','it_inspection_sheet_items','it_inspection_sheet_photos','it_inspection_sheet_log','it_inspection_file_cleanup') ORDER BY name")).map((x) => x.name).sort();
    const expectedIdx = ['idx_it_inspection_sheet_items_device', 'idx_it_inspection_sheet_items_target', 'idx_it_inspection_sheet_log_sheet', 'idx_it_inspection_sheet_photos_sha', 'idx_it_inspection_sheet_photos_sheet', 'uq_it_inspection_sheet_items', 'idx_it_inspection_photos_position', 'uq_it_inspection_sheets_draft_room',
      // SQLite 为列级 UNIQUE（photos.stored_name、file_cleanup.stored_name）自动生成的隐式索引，也落在 sqlite_master 里。
      'sqlite_autoindex_it_inspection_sheet_photos_1', 'sqlite_autoindex_it_inspection_file_cleanup_1'].sort();
    check('建单后全部索引齐全', JSON.stringify(idx) === JSON.stringify(expectedIdx), idx);
    // Claude 复核 L3：方案 B 的照片暂存移除表——表、主键、列与索引全等（不只是「存在」）。
    const removalCols = (await f.all('PRAGMA table_info(it_inspection_photo_removals)')).map((c) => [c.name, c.type, c.notnull, c.pk]);
    check('照片暂存移除表列/非空/主键全等', JSON.stringify(removalCols) === JSON.stringify([['sheet_id', 'INTEGER', 1, 0], ['photo_id', 'INTEGER', 1, 1], ['pending_by', 'INTEGER', 1, 2], ['created_at', 'TEXT', 1, 0]]), removalCols);
    const removalIdx = (await f.all("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='it_inspection_photo_removals' ORDER BY name")).map((x) => x.name);
    check('照片暂存移除表索引全等', JSON.stringify(removalIdx) === JSON.stringify(['idx_it_inspection_photo_removals_sheet', 'sqlite_autoindex_it_inspection_photo_removals_1']), removalIdx);
    const removalIdxCols = (await f.all("PRAGMA index_info('idx_it_inspection_photo_removals_sheet')")).map((c) => c.name);
    check('照片暂存移除表按单+人索引列序全等', JSON.stringify(removalIdxCols) === JSON.stringify(['sheet_id', 'pending_by']), removalIdxCols);
    const positionIdxCols = (await f.all("PRAGMA index_info('idx_it_inspection_photos_position')")).map((c) => c.name);
    check('照片位置普通索引列序全等', JSON.stringify(positionIdxCols) === JSON.stringify(['sheet_id', 'slot', 'target_id', 'state', 'pending_by']), positionIdxCols);
    // codex 49 L-3：名字与列序相同不代表定义相同——位置索引与移除表按单索引必须是非唯一、非部分索引。
    const indexShape = async (table, name) => (await f.all("PRAGMA index_list('" + table + "')")).filter((x) => x.name === name).map((x) => [x.unique, x.partial]);
    const positionShape = await indexShape('it_inspection_sheet_photos', 'idx_it_inspection_photos_position');
    const removalShape = await indexShape('it_inspection_photo_removals', 'idx_it_inspection_photo_removals_sheet');
    check('位置索引与移除表索引均为非唯一、非部分索引', JSON.stringify(positionShape) === '[[0,0]]' && JSON.stringify(removalShape) === '[[0,0]]', { positionShape, removalShape });
    const uniqueLeft = (await f.all("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('uq_it_inspection_sheet_photos_active','uq_it_inspection_sheet_photos_pending')")).length;
    check('单图唯一索引不再存在', uniqueLeft === 0, uniqueLeft);

    const itemCount = (await f.all('SELECT COUNT(*) n FROM it_inspection_sheet_items WHERE sheet_id=?', [sheetIdMain]))[0].n;
    check('建单生成 8(room)+4(rack)+1(device) = 13 行检查项', itemCount === 13, itemCount);

    // ============================================================
    // 3) 表级 CHECK 反例（直接 f.run 写 SQL）+ 正向对照（M5：去掉违规点即成功插入）
    // ============================================================
    const CHECK_MSG = /CHECK constraint failed|NOT NULL constraint failed|UNIQUE constraint failed/;
    async function expectReject(label, sql, params) {
      let threw = false; let msg = '';
      try { await f.run(sql, params); } catch (e) { threw = true; msg = e.message; }
      check(label, threw && CHECK_MSG.test(msg), msg);
    }
    async function expectAccept(label, sql, params) {
      let ok = false; let msg = '';
      try { await f.run(sql, params); ok = true; } catch (e) { msg = e.message; }
      check(label, ok, msg);
    }
    let ck = 0; const ckRoom = () => 'CK' + (++ck); const CK_SHEET_ID = 999999; // 无FK约束，专供本节CHECK反例/正向对照使用，避免污染 sheetIdMain 的真实检查项/日志计数
    const validStoredName = () => require('crypto').randomUUID() + '.bin';

    // §2.1 sheets：draft 分支——submitted_by 非空 / 去掉后可插入
    await expectReject('CHECK§2.1 draft分支违反(submitted_by非空)',
      "INSERT INTO it_inspection_sheets(room_name,scope_json,template_version,status,created_by,created_at,submitted_by,version,updated_at) VALUES(?,'{}','v1','draft',1,'t',1,1,'t')", [ckRoom()]);
    await expectAccept('CHECK§2.1 draft分支正向(不带submitted_by)',
      "INSERT INTO it_inspection_sheets(room_name,scope_json,template_version,status,created_by,created_at,version,updated_at) VALUES(?,'{}','v1','draft',1,'t',1,'t')", [ckRoom()]);
    // submitted 分支——submitted_by 为空 / 补齐后可插入
    await expectReject('CHECK§2.1 submitted分支违反(submitted_by为空)',
      "INSERT INTO it_inspection_sheets(room_name,scope_json,template_version,status,created_by,created_at,version,updated_at) VALUES(?,'{}','v1','submitted',1,'t',1,'t')", [ckRoom()]);
    await expectAccept('CHECK§2.1 submitted分支正向(补齐submitted_by/at)',
      "INSERT INTO it_inspection_sheets(room_name,scope_json,template_version,status,created_by,created_at,submitted_by,submitted_at,version,updated_at) VALUES(?,'{}','v1','submitted',1,'t',1,'t',1,'t')", [ckRoom()]);
    // archived 分支——archived_by 为空 / 补齐后可插入
    await expectReject('CHECK§2.1 archived分支违反(archived_by为空)',
      "INSERT INTO it_inspection_sheets(room_name,scope_json,template_version,status,created_by,created_at,submitted_by,submitted_at,version,updated_at) VALUES(?,'{}','v1','archived',1,'t',1,'t',1,'t')", [ckRoom()]);
    await expectAccept('CHECK§2.1 archived分支正向(补齐archived_by/at)',
      "INSERT INTO it_inspection_sheets(room_name,scope_json,template_version,status,created_by,created_at,submitted_by,submitted_at,archived_by,archived_at,version,updated_at) VALUES(?,'{}','v1','archived',1,'t',1,'t',1,'t',1,'t')", [ckRoom()]);
    // 删除分支——delete_reason 为 NULL / 为空白 / 补齐合法原因后可插入
    await expectReject('CHECK§2.1 删除分支违反(delete_reason为NULL)',
      "INSERT INTO it_inspection_sheets(room_name,scope_json,template_version,status,created_by,created_at,submitted_by,submitted_at,deleted_by,deleted_at,version,updated_at) VALUES(?,'{}','v1','submitted',1,'t',1,'t',1,'t',1,'t')", [ckRoom()]);
    await expectReject('CHECK§2.1 删除分支违反(delete_reason为空白)',
      "INSERT INTO it_inspection_sheets(room_name,scope_json,template_version,status,created_by,created_at,submitted_by,submitted_at,deleted_by,deleted_at,delete_reason,version,updated_at) VALUES(?,'{}','v1','submitted',1,'t',1,'t',1,'t','   ',1,'t')", [ckRoom()]);
    await expectAccept('CHECK§2.1 删除分支正向(合法原因)',
      "INSERT INTO it_inspection_sheets(room_name,scope_json,template_version,status,created_by,created_at,submitted_by,submitted_at,deleted_by,deleted_at,delete_reason,version,updated_at) VALUES(?,'{}','v1','submitted',1,'t',1,'t',1,'t','测试原因',1,'t')", [ckRoom()]);
    // 新增分支：draft 带删除列 / draft 带归档列
    await expectReject('CHECK§2.1 draft带删除列违反',
      "INSERT INTO it_inspection_sheets(room_name,scope_json,template_version,status,created_by,created_at,deleted_by,deleted_at,delete_reason,version,updated_at) VALUES(?,'{}','v1','draft',1,'t',1,'t','x',1,'t')", [ckRoom()]);
    await expectReject('CHECK§2.1 draft带归档列违反',
      "INSERT INTO it_inspection_sheets(room_name,scope_json,template_version,status,created_by,created_at,archived_by,archived_at,version,updated_at) VALUES(?,'{}','v1','draft',1,'t',1,'t',1,'t')", [ckRoom()]);
    // 新增分支：已提交带归档列
    await expectReject('CHECK§2.1 submitted带归档列违反',
      "INSERT INTO it_inspection_sheets(room_name,scope_json,template_version,status,created_by,created_at,submitted_by,submitted_at,archived_by,archived_at,version,updated_at) VALUES(?,'{}','v1','submitted',1,'t',1,'t',1,'t',1,'t')", [ckRoom()]);
    // 新增分支：已提交删除三列只填一部分（deleted_by 非空但 deleted_at 为 NULL）
    await expectReject('CHECK§2.1 submitted删除三列只填一部分违反',
      "INSERT INTO it_inspection_sheets(room_name,scope_json,template_version,status,created_by,created_at,submitted_by,submitted_at,deleted_by,delete_reason,version,updated_at) VALUES(?,'{}','v1','submitted',1,'t',1,'t',1,'x',1,'t')", [ckRoom()]);
    // 新增分支：已归档带删除信息
    await expectReject('CHECK§2.1 archived带删除信息违反',
      "INSERT INTO it_inspection_sheets(room_name,scope_json,template_version,status,created_by,created_at,submitted_by,submitted_at,archived_by,archived_at,deleted_by,deleted_at,delete_reason,version,updated_at) VALUES(?,'{}','v1','archived',1,'t',1,'t',1,'t',1,'t','x',1,'t')", [ckRoom()]);
    // 部分唯一索引：同机房两张草稿 / 不同机房则可插入
    await expectReject('部分唯一索引拒绝同机房两张草稿',
      "INSERT INTO it_inspection_sheets(room_name,scope_json,template_version,status,created_by,created_at,version,updated_at) VALUES('R1','{}','v1','draft',1,'t',1,'t')", []);
    await expectAccept('部分唯一索引正向(不同机房各一张草稿)',
      "INSERT INTO it_inspection_sheets(room_name,scope_json,template_version,status,created_by,created_at,version,updated_at) VALUES(?,'{}','v1','draft',1,'t',1,'t')", [ckRoom()]);

    // §2.4 log：reason 为 NULL（action=delete）/ 补齐后可插入
    await expectReject('CHECK§2.4 delete无reason',
      'INSERT INTO it_inspection_sheet_log(sheet_id,actor_id,at,op_id,action,reason) VALUES(?,?,?,?,?,NULL)', [CK_SHEET_ID, 1, 't', 'op-a', 'delete']);
    await expectAccept('CHECK§2.4 delete正向(带reason)',
      'INSERT INTO it_inspection_sheet_log(sheet_id,actor_id,at,op_id,action,reason) VALUES(?,?,?,?,?,?)', [CK_SHEET_ID, 1, 't', 'op-a2', 'delete', 'x']);
    // 新增：unarchive 的 reason 为 NULL
    await expectReject('CHECK§2.4 unarchive无reason',
      'INSERT INTO it_inspection_sheet_log(sheet_id,actor_id,at,op_id,action,reason) VALUES(?,?,?,?,?,NULL)', [CK_SHEET_ID, 1, 't', 'op-c', 'unarchive']);
    // 非 edit 行带 diff_json / 去掉后可插入
    await expectReject('CHECK§2.4 非edit行带diff_json',
      "INSERT INTO it_inspection_sheet_log(sheet_id,actor_id,at,op_id,action,diff_json) VALUES(?,?,?,?,?,'[]')", [CK_SHEET_ID, 1, 't', 'op-b', 'create']);
    await expectAccept('CHECK§2.4 create正向(不带diff_json)',
      'INSERT INTO it_inspection_sheet_log(sheet_id,actor_id,at,op_id,action) VALUES(?,?,?,?,?)', [CK_SHEET_ID, 1, 't', 'op-b2', 'create']);
    // 新增：非 unarchive/delete 动作带 reason（如 submit 带 reason）
    await expectReject('CHECK§2.4 submit动作带reason违反',
      'INSERT INTO it_inspection_sheet_log(sheet_id,actor_id,at,op_id,action,reason) VALUES(?,?,?,?,?,?)', [CK_SHEET_ID, 1, 't', 'op-d', 'submit', '不该有原因']);
    // 新增：edit 行缺 diff_json / 补齐后可插入
    await expectReject('CHECK§2.4 edit行缺diff_json违反',
      'INSERT INTO it_inspection_sheet_log(sheet_id,actor_id,at,op_id,action) VALUES(?,?,?,?,?)', [CK_SHEET_ID, 1, 't', 'op-e', 'edit']);
    await expectAccept('CHECK§2.4 edit正向(带diff_json)',
      "INSERT INTO it_inspection_sheet_log(sheet_id,actor_id,at,op_id,action,diff_json) VALUES(?,?,?,?,?,'[]')", [CK_SHEET_ID, 1, 't', 'op-e2', 'edit']);

    // §2.2 items：number 项带 result；check 项带 number_value / 去掉后可插入
    await expectReject('CHECK§2.2 number项带result',
      "INSERT INTO it_inspection_sheet_items(sheet_id,section,target_id,target_label,item_key,item_label,value_kind,result) VALUES(?,?,?,?,?,?,?,?)",
      [CK_SHEET_ID, 'room', 99991, 'x', 'chk_bad_1', 'x', 'number', 'ok']);
    await expectAccept('CHECK§2.2 number正向(不带result)',
      "INSERT INTO it_inspection_sheet_items(sheet_id,section,target_id,target_label,item_key,item_label,value_kind) VALUES(?,?,?,?,?,?,?)",
      [CK_SHEET_ID, 'room', 99993, 'x', 'chk_ok_1', 'x', 'number']);
    await expectReject('CHECK§2.2 check项带number_value',
      "INSERT INTO it_inspection_sheet_items(sheet_id,section,target_id,target_label,item_key,item_label,value_kind,number_value) VALUES(?,?,?,?,?,?,?,?)",
      [CK_SHEET_ID, 'room', 99992, 'x', 'chk_bad_2', 'x', 'check', 5.0]);
    await expectAccept('CHECK§2.2 check正向(不带number_value)',
      "INSERT INTO it_inspection_sheet_items(sheet_id,section,target_id,target_label,item_key,item_label,value_kind) VALUES(?,?,?,?,?,?,?)",
      [CK_SHEET_ID, 'room', 99994, 'x', 'chk_ok_2', 'x', 'check']);
    // 新增：note 501 字
    await expectReject('CHECK§2.2 note501字违反',
      'INSERT INTO it_inspection_sheet_items(sheet_id,section,target_id,target_label,item_key,item_label,value_kind,note) VALUES(?,?,?,?,?,?,?,?)',
      [CK_SHEET_ID, 'room', 99995, 'x', 'chk_bad_note', 'x', 'check', 'x'.repeat(501)]);
    // 新增：非 device 段带 device_inspection_id
    await expectReject('CHECK§2.2 非device段带device_inspection_id违反',
      'INSERT INTO it_inspection_sheet_items(sheet_id,section,target_id,target_label,item_key,item_label,value_kind,device_inspection_id) VALUES(?,?,?,?,?,?,?,?)',
      [CK_SHEET_ID, 'room', 99996, 'x', 'chk_bad_dev', 'x', 'check', 999]);
    // 新增：number_value 为文本（L6 新增 typeof CHECK）
    await expectReject('CHECK§2.2 number_value为文本违反',
      'INSERT INTO it_inspection_sheet_items(sheet_id,section,target_id,target_label,item_key,item_label,value_kind,number_value) VALUES(?,?,?,?,?,?,?,?)',
      [CK_SHEET_ID, 'room', 99997, 'x', 'chk_bad_text', 'x', 'number', 'abc']);

    // 照片表：state 为 NULL / pending 缺 pending_by / 非 pending 带 pending_by /
    //   superseded 缺 superseded_at / state 非法值 / stored_name 格式非法（M8）
    await expectReject('照片表state为NULL',
      'INSERT INTO it_inspection_sheet_photos(sheet_id,slot,target_id,original_name,stored_name,mime,size,sha256,created_by,created_at,state) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      [sheetIdMain, 'rack_front', 1, 'a.jpg', validStoredName(), 'image/jpeg', 100, 'abc', 1, 't', null]);
    await expectReject('照片表pending缺pending_by违反',
      'INSERT INTO it_inspection_sheet_photos(sheet_id,slot,target_id,original_name,stored_name,mime,size,sha256,created_by,created_at,state) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      [sheetIdMain, 'rack_front', 1, 'a.jpg', validStoredName(), 'image/jpeg', 100, 'abc', 1, 't', 'pending']);
    await expectAccept('照片表pending正向(带pending_by)',
      'INSERT INTO it_inspection_sheet_photos(sheet_id,slot,target_id,original_name,stored_name,mime,size,sha256,created_by,created_at,state,pending_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      [sheetIdMain, 'rack_front', 1, 'a.jpg', validStoredName(), 'image/jpeg', 100, 'abc', 1, 't', 'pending', 1]);
    await expectReject('照片表active带pending_by违反',
      'INSERT INTO it_inspection_sheet_photos(sheet_id,slot,target_id,original_name,stored_name,mime,size,sha256,created_by,created_at,state,pending_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      [sheetIdMain, 'rack_front', 1, 'a.jpg', validStoredName(), 'image/jpeg', 100, 'abc', 1, 't', 'active', 1]);
    await expectReject('照片表superseded缺superseded_at违反',
      'INSERT INTO it_inspection_sheet_photos(sheet_id,slot,target_id,original_name,stored_name,mime,size,sha256,created_by,created_at,state,superseded_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      [sheetIdMain, 'rack_front', 1, 'a.jpg', validStoredName(), 'image/jpeg', 100, 'abc', 1, 't', 'superseded', 1]);
    await expectAccept('照片表superseded正向(补齐superseded_at)',
      'INSERT INTO it_inspection_sheet_photos(sheet_id,slot,target_id,original_name,stored_name,mime,size,sha256,created_by,created_at,state,superseded_by,superseded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [sheetIdMain, 'rack_front', 1, 'a.jpg', validStoredName(), 'image/jpeg', 100, 'abc', 1, 't', 'superseded', 1, 't']);
    await expectReject('照片表state非法值违反',
      'INSERT INTO it_inspection_sheet_photos(sheet_id,slot,target_id,original_name,stored_name,mime,size,sha256,created_by,created_at,state) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      [sheetIdMain, 'rack_front', 1, 'a.jpg', validStoredName(), 'image/jpeg', 100, 'abc', 1, 't', 'bogus']);
    await expectReject('照片表stored_name格式非法违反(M8)',
      'INSERT INTO it_inspection_sheet_photos(sheet_id,slot,target_id,original_name,stored_name,mime,size,sha256,created_by,created_at,state) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      [sheetIdMain, 'rack_front', 1, 'a.jpg', 'not-a-valid-name.bin', 'image/jpeg', 100, 'abc', 1, 't', 'active']);
    await expectAccept('照片表stored_name正向(合法40字符)',
      'INSERT INTO it_inspection_sheet_photos(sheet_id,slot,target_id,original_name,stored_name,mime,size,sha256,created_by,created_at,state) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      [sheetIdMain, 'rack_front', 1, 'a.jpg', validStoredName(), 'image/jpeg', 100, 'abc', 1, 't', 'active']);

    // 清理队列表：dir_key 非法 / stored_name 格式非法（含 ../ 路径穿越样例，M8）
    await expectReject('清理队列dir_key非法违反',
      'INSERT INTO it_inspection_file_cleanup(stored_name,dir_key,reason,created_at) VALUES(?,?,?,?)',
      [validStoredName(), 'bogus_dir', 'draft_deleted', 't']);
    await expectAccept('清理队列dir_key正向(sheet_photos)',
      'INSERT INTO it_inspection_file_cleanup(stored_name,dir_key,reason,created_at) VALUES(?,?,?,?)',
      [validStoredName(), 'sheet_photos', 'draft_deleted', 't']);
    await expectReject('清理队列stored_name路径穿越违反(M8)',
      'INSERT INTO it_inspection_file_cleanup(stored_name,dir_key,reason,created_at) VALUES(?,?,?,?)',
      ['../../../etc/passwd', 'sheet_photos', 'draft_deleted', 't']);
    await expectReject('清理队列stored_name格式非法违反(M8)',
      'INSERT INTO it_inspection_file_cleanup(stored_name,dir_key,reason,created_at) VALUES(?,?,?,?)',
      ['short.bin', 'sheet_photos', 'draft_deleted', 't']);

    // ============================================================
    // 6) 完整性：未填提交400、异常项无说明400、全部填完可提交、submitted_by/at 与日志
    // ============================================================
    const incomplete = await f.api('POST', '/inspections/sheets/' + sheetIdMain + '/submit', { expected_version: 1 }, 2);
    check('未填写完整提交400 SHEET_INCOMPLETE', incomplete.status === 400 && incomplete.body.code === 'SHEET_INCOMPLETE' && Array.isArray(incomplete.body.detail.unfilled_item_ids) && incomplete.body.detail.unfilled_item_ids.length === 13, incomplete.body);

    const detail1 = await getSheet(sheetIdMain, 2);
    const fill1 = detail1.body.items.map((it) => (it.value_kind === 'number'
      ? { id: it.id, result: null, number_value: NUMBER_DEFAULT[it.item_key] ?? 25, note: null }
      : { id: it.id, result: it.item_key === 'door' ? 'bad' : 'ok', number_value: null, note: null }));
    const put1 = await f.api('PUT', '/inspections/sheets/' + sheetIdMain, { expected_version: 1, items: fill1 }, 2);
    check('保存草稿200且version+1', put1.status === 200 && put1.body.version === 2, put1.body);

    const submitMissingNote = await f.api('POST', '/inspections/sheets/' + sheetIdMain + '/submit', { expected_version: 2 }, 2);
    check('异常项无说明提交400', submitMissingNote.status === 400 && submitMissingNote.body.code === 'SHEET_INCOMPLETE' && submitMissingNote.body.detail.missing_note_item_ids.length === 1, submitMissingNote.body);

    const doorItem = detail1.body.items.find((it) => it.item_key === 'door');
    const put2 = await f.api('PUT', '/inspections/sheets/' + sheetIdMain, { expected_version: 2, items: [{ id: doorItem.id, result: 'bad', number_value: null, note: '柜门锁损坏，需要维修' }] }, 2);
    check('补充说明200', put2.status === 200 && put2.body.version === 3, put2.body);

    // C2：door 项被标 bad，应传集合多了它的 item 照片；机柜正面照也要传，否则提交仍会
    // SHEET_INCOMPLETE（missing_photo_positions），不是本节要测的完整性维度。
    await uploadAllRackFrontPhotos(f, sheetIdMain, mainCreated.body.scope, 2);
    const doorPhotoUpload = await uploadPhoto(f, sheetIdMain, 'item', doorItem.id, 2);
    check('C2补door项照片201', doorPhotoUpload.status === 201, doorPhotoUpload.body);

    const submitOk = await f.api('POST', '/inspections/sheets/' + sheetIdMain + '/submit', { expected_version: 3 }, 2);
    check('全部填完可提交200且状态submitted', submitOk.status === 200 && submitOk.body.status === 'submitted' && submitOk.body.submitted_by === 2 && !!submitOk.body.submitted_at && submitOk.body.version === 4, submitOk.body);
    check('提交后日志多一行submit', submitOk.body.log.some((l) => l.action === 'submit'));

    // ============================================================
    // 7) 版本冲突：draft 上的 PUT/submit/delete（用另一张单，避免打乱上面的 sheetIdMain 状态机）
    // ============================================================
    const sv = await buildDraftSheet('R1'); // room R1 已空出（sheetIdMain 已提交离开草稿态）
    const putConflict = await f.api('PUT', '/inspections/sheets/' + sv.id, { expected_version: 999, items: [], remark: null }, 2);
    check('PUT旧版本409 SHEET_VERSION_CONFLICT', putConflict.status === 409 && putConflict.body.code === 'SHEET_VERSION_CONFLICT', putConflict.body);
    const submitConflict = await f.api('POST', '/inspections/sheets/' + sv.id + '/submit', { expected_version: 999 }, 2);
    check('submit旧版本409', submitConflict.status === 409 && submitConflict.body.code === 'SHEET_VERSION_CONFLICT', submitConflict.body);
    const deleteConflictDraft = await f.api('DELETE', '/inspections/sheets/' + sv.id, { expected_version: 999 }, 2);
    check('delete(草稿)旧版本409', deleteConflictDraft.status === 409 && deleteConflictDraft.body.code === 'SHEET_VERSION_CONFLICT', deleteConflictDraft.body);

    // sheetIdMain（submitted, version 4）继续走 archive → unarchive → delete → restore，顺带覆盖 7/9/10
    const archiveConflict = await f.api('POST', '/inspections/sheets/archive', { items: [{ id: sheetIdMain, expected_version: 999 }] }, 1);
    check('archive批量版本不符409且属于problems', archiveConflict.status === 409 && archiveConflict.body.code === 'SHEET_STATE' && archiveConflict.body.detail.problems.some((p) => p.id === sheetIdMain), archiveConflict.body);
    const archiveOk = await f.api('POST', '/inspections/sheets/archive', { items: [{ id: sheetIdMain, expected_version: 4 }] }, 1);
    check('归档200', archiveOk.status === 200 && archiveOk.body.archived.includes(sheetIdMain), archiveOk.body);

    const unarchiveNoReason = await f.api('POST', '/inspections/sheets/' + sheetIdMain + '/unarchive', { expected_version: 5 }, 1);
    check('撤回无原因400 LEDGER_BAD_REQUEST', unarchiveNoReason.status === 400 && unarchiveNoReason.body.code === 'LEDGER_BAD_REQUEST', unarchiveNoReason.body);
    const unarchiveConflict = await f.api('POST', '/inspections/sheets/' + sheetIdMain + '/unarchive', { expected_version: 999, reason: '测试' }, 1);
    check('撤回旧版本409', unarchiveConflict.status === 409 && unarchiveConflict.body.code === 'SHEET_VERSION_CONFLICT', unarchiveConflict.body);
    const unarchiveOk = await f.api('POST', '/inspections/sheets/' + sheetIdMain + '/unarchive', { expected_version: 5, reason: '需要复核' }, 1);
    check('撤回归档200：archived两列清空、submitted两列保留', unarchiveOk.status === 200 && unarchiveOk.body.status === 'submitted' && unarchiveOk.body.archived_by === null && unarchiveOk.body.archived_at === null && unarchiveOk.body.submitted_by === 2 && !!unarchiveOk.body.submitted_at, unarchiveOk.body);
    check('撤回后日志多一行unarchive带原因', unarchiveOk.body.log.some((l) => l.action === 'unarchive' && l.reason === '需要复核'));

    const delConflictSubmitted = await f.api('DELETE', '/inspections/sheets/' + sheetIdMain, { expected_version: 999, reason: 'x' }, 2);
    check('delete(已提交)旧版本409', delConflictSubmitted.status === 409 && delConflictSubmitted.body.code === 'SHEET_VERSION_CONFLICT', delConflictSubmitted.body);
    const delNoReason = await f.api('DELETE', '/inspections/sheets/' + sheetIdMain, { expected_version: 6 }, 2);
    check('已提交删除无原因400 LEDGER_BAD_REQUEST', delNoReason.status === 400 && delNoReason.body.code === 'LEDGER_BAD_REQUEST', delNoReason.body);
    const delOk = await f.api('DELETE', '/inspections/sheets/' + sheetIdMain, { expected_version: 6, reason: '资产已迁出，记录作废' }, 2);
    // L2：已提交逻辑删除改为直接在 withWrite 内返回精简结果 {id,version,deleted_at}，不再是完整明细
    // （delete_reason 不在响应体里，改为下面直接读库核实）。
    check('已提交删除200带精简结果', delOk.status === 200 && delOk.body.id === sheetIdMain && delOk.body.version === 7 && !!delOk.body.deleted_at && !Object.hasOwn(delOk.body, 'delete_reason') && !Object.hasOwn(delOk.body, 'items'), delOk.body);
    const delRow = (await f.all('SELECT * FROM it_inspection_sheets WHERE id=?', [sheetIdMain]))[0];
    check('已提交删除落库delete_reason正确', delRow.delete_reason === '资产已迁出，记录作废' && delRow.version === 7);
    const delLog = await f.all("SELECT * FROM it_inspection_sheet_log WHERE sheet_id=? AND action='delete'", [sheetIdMain]);
    check('逻辑删除日志delete带原因', delLog.length === 1 && delLog[0].reason === '资产已迁出，记录作废');

    const restoreConflict = await f.api('POST', '/inspections/sheets/' + sheetIdMain + '/restore', { expected_version: 999 }, 1);
    check('恢复旧版本409', restoreConflict.status === 409 && restoreConflict.body.code === 'SHEET_VERSION_CONFLICT', restoreConflict.body);
    const restoreOk = await f.api('POST', '/inspections/sheets/' + sheetIdMain + '/restore', { expected_version: 7 }, 1);
    check('恢复200回到submitted', restoreOk.status === 200 && restoreOk.body.status === 'submitted' && !restoreOk.body.deleted_at, restoreOk.body);
    check('恢复日志多一行restore', restoreOk.body.log.some((l) => l.action === 'restore'));

    // 12) C2：方案 §5.3 的已提交单保存修改已开放；空 items+remark:null（且无待生效照片）
    // 是真正的空更新，diff 为空，不写日志、
    // 不增版本——用重读版本核实"没有变化"是可观察信号，不是靠 409 挡住请求本身。
    const putSubmitted = await f.api('PUT', '/inspections/sheets/' + sheetIdMain, { expected_version: 8, items: [], remark: null }, 2);
    check('C2已提交单空更新PUT200(不再409)', putSubmitted.status === 200, putSubmitted.body);
    check('C2已提交单空更新PUT版本不变(没有变化=不写日志不增版本)', putSubmitted.body.version === 8, putSubmitted.body);
    const editLogAfterNoop = putSubmitted.body.log.filter((l) => l.action === 'edit');
    check('C2已提交单空更新PUT无新edit日志', editLogAfterNoop.length === 0, editLogAfterNoop);

    // 9) 草稿删除：单、检查项、日志全部不存在
    const svDetail = await getSheet(sv.id, 2);
    check('草稿单初始日志恰1行create', svDetail.body.log.length === 1 && svDetail.body.log[0].action === 'create');
    const delDraft = await f.api('DELETE', '/inspections/sheets/' + sv.id, { expected_version: 1 }, 2);
    check('草稿物理删除200', delDraft.status === 200 && delDraft.body.ok === true, delDraft.body);
    const afterSheetRows = await f.all('SELECT * FROM it_inspection_sheets WHERE id=?', [sv.id]);
    check('草稿删除后单不存在', afterSheetRows.length === 0);
    const afterItemRows = await f.all('SELECT * FROM it_inspection_sheet_items WHERE sheet_id=?', [sv.id]);
    check('草稿删除后检查项不存在', afterItemRows.length === 0);
    const afterLogRows = await f.all('SELECT * FROM it_inspection_sheet_log WHERE sheet_id=?', [sv.id]);
    check('草稿删除后日志不存在', afterLogRows.length === 0);

    // 已归档删除409
    const archTest = await buildSubmittedSheet('R-Arch', 2);
    const archArchive = await f.api('POST', '/inspections/sheets/archive', { items: [{ id: archTest.id, expected_version: archTest.version }] }, 1);
    check('辅助单归档200', archArchive.status === 200, archArchive.body);
    const archDeleteAttempt = await f.api('DELETE', '/inspections/sheets/' + archTest.id, { expected_version: archTest.version + 1, reason: 'x' }, 1);
    check('已归档删除409 SHEET_STATE', archDeleteAttempt.status === 409 && archDeleteAttempt.body.code === 'SHEET_STATE', archDeleteAttempt.body);

    // ============================================================
    // 4) 状态×角色×动作矩阵（负向为主；正向已由上面 sheetIdMain 的生命周期覆盖）
    // ============================================================
    await f.run("INSERT INTO it_asset_acl (user_id,level,granted_by) VALUES (5,'write',1)");
    const roles = [
      { label: '巡检人', uid: 2 }, { label: '管理员', uid: 1 }, { label: '其他写权限者', uid: 5 }, { label: '只读', uid: 3 }, { label: '无权限', uid: 4 },
    ];
    const disallowedForWrite = [
      { label: '其他写权限者', uid: 5, code: 'SHEET_FORBIDDEN' },
      { label: '只读', uid: 3, code: 'LEDGER_FORBIDDEN' },
      { label: '无权限', uid: 4, code: 'LEDGER_FORBIDDEN' },
    ];

    const mDraft = await buildDraftSheet('M-Draft', 2);
    for (const r of disallowedForWrite) {
      const v = await currentVersion(mDraft.id);
      const rs = await f.api('PUT', '/inspections/sheets/' + mDraft.id, { expected_version: v, items: [], remark: null }, r.uid);
      check(`草稿-${r.label}-保存:403 ${r.code}`, rs.status === 403 && rs.body.code === r.code, rs.body);
      const rsub = await f.api('POST', '/inspections/sheets/' + mDraft.id + '/submit', { expected_version: v }, r.uid);
      check(`草稿-${r.label}-提交:403 ${r.code}`, rsub.status === 403 && rsub.body.code === r.code, rsub.body);
      const rdel = await f.api('DELETE', '/inspections/sheets/' + mDraft.id, { expected_version: v }, r.uid);
      check(`草稿-${r.label}-删除:403 ${r.code}`, rdel.status === 403 && rdel.body.code === r.code, rdel.body);
    }
    check('草稿单未被负向探测意外改动(version仍1)', (await currentVersion(mDraft.id)) === 1);

    const mSubmitted = await buildSubmittedSheet('M-Submitted', 2);
    for (const { label, uid } of roles) {
      const v = await currentVersion(mSubmitted.id);
      const rp = await f.api('PUT', '/inspections/sheets/' + mSubmitted.id, { expected_version: v, items: [], remark: null }, uid);
      // C2：方案 §5.3 允许巡检人/管理员保存已提交单；
      // 修改；这里传的是空 items+remark:null 且没有待生效照片，属于真正的空更新（无变化），200
      // 且版本不变（不是"放宽"，是按方案变化的既定行为）。
      if (uid === 2 || uid === 1) check(`已提交-${label}-空更新保存:200且版本不变(C2)`, rp.status === 200 && rp.body.version === v, rp.body);
      else if (uid === 5) check(`已提交-${label}-保存:403 SHEET_FORBIDDEN`, rp.status === 403 && rp.body.code === 'SHEET_FORBIDDEN', rp.body);
      else check(`已提交-${label}-保存:403 LEDGER_FORBIDDEN`, rp.status === 403 && rp.body.code === 'LEDGER_FORBIDDEN', rp.body);
    }
    const archiveDisallowed = [
      { label: '巡检人(非管理员)', uid: 2, code: 'SHEET_FORBIDDEN' }, { label: '其他写权限者', uid: 5, code: 'SHEET_FORBIDDEN' },
      { label: '只读', uid: 3, code: 'LEDGER_FORBIDDEN' }, { label: '无权限', uid: 4, code: 'LEDGER_FORBIDDEN' },
    ];
    for (const r of archiveDisallowed) {
      const v = await currentVersion(mSubmitted.id);
      const ra = await f.api('POST', '/inspections/sheets/archive', { items: [{ id: mSubmitted.id, expected_version: v }] }, r.uid);
      check(`已提交-${r.label}-归档:403 ${r.code}`, ra.status === 403 && ra.body.code === r.code, ra.body);
    }
    const deleteDisallowedSubmitted = [
      { label: '其他写权限者', uid: 5, code: 'SHEET_FORBIDDEN' }, { label: '只读', uid: 3, code: 'LEDGER_FORBIDDEN' }, { label: '无权限', uid: 4, code: 'LEDGER_FORBIDDEN' },
    ];
    for (const r of deleteDisallowedSubmitted) {
      const v = await currentVersion(mSubmitted.id);
      const rd = await f.api('DELETE', '/inspections/sheets/' + mSubmitted.id, { expected_version: v, reason: 'x' }, r.uid);
      check(`已提交-${r.label}-删除:403 ${r.code}`, rd.status === 403 && rd.body.code === r.code, rd.body);
    }
    check('已提交单未被负向探测意外改动', (await currentVersion(mSubmitted.id)) === mSubmitted.version);

    const mArchivedPre = await buildSubmittedSheet('M-Archived', 2);
    const mArchArchive = await f.api('POST', '/inspections/sheets/archive', { items: [{ id: mArchivedPre.id, expected_version: mArchivedPre.version }] }, 1);
    check('矩阵辅助单归档200', mArchArchive.status === 200, mArchArchive.body);
    const mArchivedId = mArchivedPre.id;
    const versionAfterArchive = await currentVersion(mArchivedId);
    for (const { label, uid } of roles) {
      const v = await currentVersion(mArchivedId);
      const rd = await f.api('DELETE', '/inspections/sheets/' + mArchivedId, { expected_version: v, reason: 'x' }, uid);
      if (uid === 2 || uid === 1) check(`已归档-${label}-删除:409 SHEET_STATE`, rd.status === 409 && rd.body.code === 'SHEET_STATE', rd.body);
      else if (uid === 5) check(`已归档-${label}-删除:403 SHEET_FORBIDDEN`, rd.status === 403 && rd.body.code === 'SHEET_FORBIDDEN', rd.body);
      else check(`已归档-${label}-删除:403 LEDGER_FORBIDDEN`, rd.status === 403 && rd.body.code === 'LEDGER_FORBIDDEN', rd.body);
    }
    const unarchiveDisallowed = [
      { label: '巡检人(非管理员)', uid: 2, code: 'SHEET_FORBIDDEN' }, { label: '其他写权限者', uid: 5, code: 'SHEET_FORBIDDEN' },
      { label: '只读', uid: 3, code: 'LEDGER_FORBIDDEN' }, { label: '无权限', uid: 4, code: 'LEDGER_FORBIDDEN' },
    ];
    for (const r of unarchiveDisallowed) {
      const v = await currentVersion(mArchivedId);
      const ru = await f.api('POST', '/inspections/sheets/' + mArchivedId + '/unarchive', { expected_version: v, reason: 'x' }, r.uid);
      check(`已归档-${r.label}-撤回:403 ${r.code}`, ru.status === 403 && ru.body.code === r.code, ru.body);
    }
    const versAfterArchiveProbes = await currentVersion(mArchivedId);
    check('已归档单未被负向探测意外改动(版本仍为归档后那一次)', versAfterArchiveProbes === versionAfterArchive);

    const mDeletedPre = await buildSubmittedSheet('M-Deleted', 2);
    const mDelDel = await f.api('DELETE', '/inspections/sheets/' + mDeletedPre.id, { expected_version: mDeletedPre.version, reason: '矩阵测试删除' }, 2);
    check('矩阵辅助单逻辑删除200', mDelDel.status === 200, mDelDel.body);
    const mDeletedId = mDeletedPre.id;
    for (const { label, uid } of roles) {
      const g = await f.api('GET', '/inspections/sheets/' + mDeletedId, undefined, uid);
      if (uid === 4) check(`已删除-${label}-查看:403`, g.status === 403 && g.body.code === 'LEDGER_FORBIDDEN', g.body);
      else if (uid === 1) check(`已删除-${label}-查看:200(管理员)`, g.status === 200, g.body);
      else check(`已删除-${label}-查看:404`, g.status === 404 && g.body.code === 'SHEET_NOT_FOUND', g.body);

      const v2 = await currentVersion(mDeletedId);
      const rp = await f.api('PUT', '/inspections/sheets/' + mDeletedId, { expected_version: v2, items: [], remark: null }, uid);
      if (uid === 3 || uid === 4) check(`已删除-${label}-保存:403`, rp.status === 403 && rp.body.code === 'LEDGER_FORBIDDEN', rp.body);
      else check(`已删除-${label}-保存:404`, rp.status === 404 && rp.body.code === 'SHEET_NOT_FOUND', rp.body);
    }
    const restoreDisallowed = [
      { label: '巡检人', uid: 2, code: 'SHEET_FORBIDDEN' }, { label: '其他写权限者', uid: 5, code: 'SHEET_FORBIDDEN' },
      { label: '只读', uid: 3, code: 'LEDGER_FORBIDDEN' }, { label: '无权限', uid: 4, code: 'LEDGER_FORBIDDEN' },
    ];
    for (const r of restoreDisallowed) {
      const v = await currentVersion(mDeletedId);
      const rr = await f.api('POST', '/inspections/sheets/' + mDeletedId + '/restore', { expected_version: v }, r.uid);
      check(`已删除-${r.label}-恢复:403 ${r.code}`, rr.status === 403 && rr.body.code === r.code, rr.body);
    }

    // 写权限被收回的巡检人：删掉2号ACL后对自己的草稿保存 → 403 LEDGER_FORBIDDEN
    await f.run('DELETE FROM it_asset_acl WHERE user_id=2');
    const revokedAttempt = await f.api('PUT', '/inspections/sheets/' + mDraft.id, { expected_version: 1, items: [], remark: null }, 2);
    check('写权限被收回的巡检人保存自己草稿403 LEDGER_FORBIDDEN', revokedAttempt.status === 403 && revokedAttempt.body.code === 'LEDGER_FORBIDDEN', revokedAttempt.body);
    await f.run("INSERT INTO it_asset_acl (user_id,level,granted_by) VALUES (2,'write',1)");

    // ============================================================
    // 5) 可见性
    // ============================================================
    const listAsReadOnly = await f.api('GET', '/inspections/sheets?room=M-Draft', undefined, 3);
    check('只读者列表看到他人草稿仅一行', listAsReadOnly.status === 200 && listAsReadOnly.body.items.length === 1, listAsReadOnly.body);
    // H1：summary 字段集合与实现约定全等（不是只排除少数已知字段——多返回任何字段都要变红）。
    const SUMMARY_KEYS = ['id', 'room_name', 'created_by_name', 'created_at', 'filled', 'total', 'visibility', 'actions'].sort();
    const summaryRow0 = listAsReadOnly.body.items[0];
    check('H1只读者列表summary字段集合全等', summaryRow0 && JSON.stringify(Object.keys(summaryRow0).sort()) === JSON.stringify(SUMMARY_KEYS), summaryRow0);
    check('H1只读者列表visibility=summary', summaryRow0 && summaryRow0.visibility === 'summary', summaryRow0);
    check('C4 summary行不含version字段(批量归档/恢复用不到,版本号会暴露他人草稿保存次数)', summaryRow0 && !Object.hasOwn(summaryRow0, 'version'), summaryRow0);
    // C4：full 可见行的键集合含 version，且与详情响应/库内值逐一相等——列表补返回 version 是 C4 唯一
    // 允许的 routes/ 改动（批量归档 POST /sheets/archive 与恢复 POST /sheets/:id/restore 都要求
    // expected_version，此前列表不返回这个字段前端拿不到）。用巡检人本人(uid=2)看自己的草稿，full 可见。
    const listAsOwner = await f.api('GET', '/inspections/sheets?room=M-Draft', undefined, 2);
    const fullRow0 = listAsOwner.body.items.find((x) => x.id === mDraft.id);
    const FULL_KEYS = ['id', 'room_name', 'status', 'version', 'abnormal', 'filled', 'total', 'photos_expected', 'photos_uploaded', 'edit_count', 'created_by_name', 'created_at', 'submitted_at', 'archived_at', 'deleted_at', 'delete_reason', 'visibility', 'actions'].sort();
    check('C4 full行键集合全等且含version', fullRow0 && JSON.stringify(Object.keys(fullRow0).sort()) === JSON.stringify(FULL_KEYS), fullRow0);
    const fullDetail0 = await getSheet(mDraft.id, 2);
    check('C4 full行version与详情响应一致', fullRow0 && fullDetail0.body && fullRow0.version === fullDetail0.body.version, { list: fullRow0 && fullRow0.version, detail: fullDetail0.body && fullDetail0.body.version });
    const dbRow0 = (await f.all('SELECT version FROM it_inspection_sheets WHERE id=?', [mDraft.id]))[0];
    check('C4 full行version与库内值一致', fullRow0 && dbRow0 && fullRow0.version === dbRow0.version, { list: fullRow0 && fullRow0.version, db: dbRow0 && dbRow0.version });
    const detailAsReadOnly = await f.api('GET', '/inspections/sheets/' + mDraft.id, undefined, 3);
    check('只读者查看他人草稿详情404 SHEET_NOT_FOUND', detailAsReadOnly.status === 404 && detailAsReadOnly.body.code === 'SHEET_NOT_FOUND', detailAsReadOnly.body);

    const listNonAdmin = await f.api('GET', '/inspections/sheets', undefined, 2);
    check('已删除单不出现在非管理员列表', !listNonAdmin.body.items.some((x) => x.id === mDeletedId));
    const deletedDetailOwner = await f.api('GET', '/inspections/sheets/' + mDeletedId, undefined, 2);
    check('已删除单对巡检人本人也404 SHEET_NOT_FOUND', deletedDetailOwner.status === 404 && deletedDetailOwner.body.code === 'SHEET_NOT_FOUND', deletedDetailOwner.body);
    const deletedDetailAdmin = await f.api('GET', '/inspections/sheets/' + mDeletedId, undefined, 1);
    check('已删除单管理员可见', deletedDetailAdmin.status === 200, deletedDetailAdmin.body);

    const deletedListNonAdminGet = await f.api('GET', '/inspections/sheets/deleted', undefined, 2);
    check('GET /deleted 非管理员403 SHEET_FORBIDDEN', deletedListNonAdminGet.status === 403 && deletedListNonAdminGet.body.code === 'SHEET_FORBIDDEN', deletedListNonAdminGet.body);
    const deletedListAdminGet = await f.api('GET', '/inspections/sheets/deleted', undefined, 1);
    check('GET /deleted 管理员200且含该单', deletedListAdminGet.status === 200 && deletedListAdminGet.body.items.some((x) => x.id === mDeletedId), deletedListAdminGet.body);

    // ============================================================
    // 8) 批量归档原子性
    // ============================================================
    const batchA = await buildSubmittedSheet('Batch-A', 2);
    const batchB = await buildSubmittedSheet('Batch-B', 2);
    const batchC = await buildDraftSheet('Batch-C', 2);
    const beforeBatch = await f.all('SELECT id,status,version FROM it_inspection_sheets WHERE id IN (?,?,?) ORDER BY id', [batchA.id, batchB.id, batchC.id]);
    const batchAttempt = await f.api('POST', '/inspections/sheets/archive', { items: [{ id: batchA.id, expected_version: batchA.version }, { id: batchB.id, expected_version: batchB.version }, { id: batchC.id, expected_version: batchC.version }] }, 1);
    check('批量归档含一张草稿整批409', batchAttempt.status === 409 && batchAttempt.body.code === 'SHEET_STATE' && batchAttempt.body.detail.problems.some((p) => p.id === batchC.id), batchAttempt.body);
    const afterBatch = await f.all('SELECT id,status,version FROM it_inspection_sheets WHERE id IN (?,?,?) ORDER BY id', [batchA.id, batchB.id, batchC.id]);
    check('批量归档失败三张都未变', JSON.stringify(beforeBatch) === JSON.stringify(afterBatch));

    const batchOk = await f.api('POST', '/inspections/sheets/archive', { items: [{ id: batchA.id, expected_version: batchA.version }, { id: batchB.id, expected_version: batchB.version }] }, 1);
    check('全部合格批量归档200', batchOk.status === 200 && batchOk.body.archived.length === 2, batchOk.body);
    const logsA = await f.all("SELECT * FROM it_inspection_sheet_log WHERE sheet_id=? AND action='archive'", [batchA.id]);
    const logsB = await f.all("SELECT * FROM it_inspection_sheet_log WHERE sheet_id=? AND action='archive'", [batchB.id]);
    check('批量归档各一行archive日志且共用op_id', logsA.length === 1 && logsB.length === 1 && logsA[0].op_id === logsB[0].op_id, { logsA, logsB });

    // ============================================================
    // 11) 白名单与校验
    // ============================================================
    const extraField = await f.api('POST', '/inspections/sheets', { room_name: 'X', extra: 1 }, 2);
    check('建单多余字段400 LEDGER_BAD_REQUEST', extraField.status === 400 && extraField.body.code === 'LEDGER_BAD_REQUEST', extraField.body);

    const otherSheet = await buildDraftSheet('Other-Sheet', 2);
    const foreignItemId = (await getSheet(otherSheet.id, 2)).body.items[0].id;
    const wrongItemPut = await f.api('PUT', '/inspections/sheets/' + mDraft.id, { expected_version: 1, items: [{ id: foreignItemId, result: 'ok', number_value: null, note: null }] }, 2);
    check('他单item id 400 LEDGER_BAD_REQUEST', wrongItemPut.status === 400 && wrongItemPut.body.code === 'LEDGER_BAD_REQUEST', wrongItemPut.body);

    const detailForRange = await getSheet(mDraft.id, 2);
    const tempItem = detailForRange.body.items.find((it) => it.item_key === 'temperature');
    const rangeBad = await f.api('PUT', '/inspections/sheets/' + mDraft.id, { expected_version: 1, items: [{ id: tempItem.id, result: null, number_value: 9999, note: null }] }, 2);
    check('数值越界400 LEDGER_BAD_REQUEST', rangeBad.status === 400 && rangeBad.body.code === 'LEDGER_BAD_REQUEST', rangeBad.body);

    const doorItem2 = detailForRange.body.items.find((it) => it.item_key === 'door');
    const longNote = 'x'.repeat(501);
    const noteBad = await f.api('PUT', '/inspections/sheets/' + mDraft.id, { expected_version: 1, items: [{ id: doorItem2.id, result: 'bad', number_value: null, note: longNote }] }, 2);
    check('说明501字400 LEDGER_BAD_REQUEST', noteBad.status === 400 && noteBad.body.code === 'LEDGER_BAD_REQUEST', noteBad.body);

    check('全部负向探测未意外改动mDraft(version仍1)', (await currentVersion(mDraft.id)) === 1);

    // ============================================================
    // M静态守卫（L1，G2A2b 订正措辞）：静态守卫历经 G1A 白名单硬门 → G2A2 结构约定检查降级
    // （"写路由锁外不读库"这条性质改由运行时探针保证，见文件头"结构约定检查声明"）→ G2A2b Commit3
    // 补 R9（processCleanupQueueBestEffort 独立语句约束）→ G3A 补 R10（禁引入数据库驱动/工厂
    // 依赖键集合全等）。当前规则集是 R1/R2/R5/R6/R7/R8/R9/R10 共8条，全部是"只做语法树结构核对，
    // 不做绑定/数据流分析"（不再声称能防对抗性写法）。判定逻辑抽成纯函数 runSheetRouteGuard（本
    // 文件顶部，main() 之前），真实源码调用与负向用例调用同一个函数。
    // 采集路由（C3）走两阶段共用同一个只在withWrite回调内被调用的判定函数 checkSheetAndItem /
    // assertCollectableAsset（inspection-sheets.js，G1A-b 由 checkCollectable 拆出；第二阶段不调
    // assertCollectableAsset，资产资格由 reverifyTarget 复核），因此 withWrite恰2处，是全文件唯一
    // 例外，R5显式认可。
    // ============================================================
    {
      const srcPath = path.join(__dirname, '../routes/it-ledger/inspection-sheets.js');
      const src = fs.readFileSync(srcPath, 'utf8');
      const result = runSheetRouteGuard(src);
      check('R1-R10静态守卫(真实源码) 无PARSE级失败(acorn require/parse成功)', !result.violations.some((v) => v.rule === 'PARSE'), result.violations);
      check('R1-R10静态守卫(真实源码) violations为空数组(严格deepEqual)', JSON.stringify(result.violations) === '[]', result.violations);
      check('R1-R10静态守卫(真实源码) violations.length===0', result.violations.length === 0, result.violations);
      check('R1-R10静态守卫(真实源码) routes总数为17', result.routes.length === 17, result.routes);
      const expectedKeysSorted = [...SHEET_ALL_EXPECTED_ROUTES].sort();
      check('R1-R10静态守卫(真实源码) routes键集合与预期16个全等', JSON.stringify(result.routes) === JSON.stringify(expectedKeysSorted), { got: result.routes, expected: expectedKeysSorted });
      const gotWriteSorted = result.routes.filter((k) => SHEET_WRITE_ROUTES.has(k)).sort();
      const expectedWriteSorted = [...SHEET_WRITE_ROUTES].sort();
      check('R2静态守卫(真实源码) 写路由集合(11个)与预期全等', gotWriteSorted.length === 11 && JSON.stringify(gotWriteSorted) === JSON.stringify(expectedWriteSorted), { got: gotWriteSorted, expected: expectedWriteSorted });
      const gotReadSorted = result.routes.filter((k) => SHEET_READ_ROUTES.has(k)).sort();
      const expectedReadSorted = [...SHEET_READ_ROUTES].sort();
      check('R2静态守卫(真实源码) 读路由集合(6个)与预期全等', gotReadSorted.length === 6 && JSON.stringify(gotReadSorted) === JSON.stringify(expectedReadSorted), { got: gotReadSorted, expected: expectedReadSorted });
      check('R5静态守卫(真实源码) 采集路由在路由集合内(恰2处withWrite的唯一例外)', result.routes.includes(SHEET_COLLECT_ROUTE_KEY), result.routes);
      // 逐路由核对：violations 里没有一条 detail.key 指向该路由（17条路由各自独立可见，与旧版
      // "每个路由各自一条check"的可读性保持一致，不是只看一个笼统的总violations.length===0）。
      for (const key of expectedKeysSorted) {
        const routeViolations = result.violations.filter((v) => v.detail && v.detail.key === key);
        check(`R1-R10静态守卫(真实源码) 路由[${key}]无violation`, routeViolations.length === 0, routeViolations);
      }
    }

    // ============================================================
    // R10（G3A 新增）→ G3A-b（M5：扫描扩到 inspection-photo-files.js，require 检查改白名单全等）：
    // inspections.js / inspection-collect.js / inspection-photo-files.js 各自的真实源码也跑一次
    // runDbAccessGuard——与 inspection-sheets.js 共用同一份判定逻辑，验证它们当前确实没有引入
    // 白名单外的依赖、工厂依赖键集合与预期一致（41S 部分成立结论"路由文件当前拿不到裸连接"的静态
    // 复核，见 41S 原话档案 recommendations 第2条）。不接入负向用例矩阵（那套矩阵只变异
    // inspection-sheets.js 自己的源码，inspection-photo-files.js 的负向用例见下方独立块），只做
    // "真实源码零违规"这一条正面断言。
    // ============================================================
    {
      const acorn = require('acorn');
      const inspectionsSrc = fs.readFileSync(path.join(__dirname, '../routes/it-ledger/inspections.js'), 'utf8');
      const inspectionsAst = acorn.parse(inspectionsSrc, { ecmaVersion: 2022, sourceType: 'script' });
      const inspectionsViolations = runDbAccessGuard(inspectionsAst, inspectionsSrc, 'createInspections', INSPECTIONS_EXPECTED_DEPS, INSPECTIONS_REQUIRE_WHITELIST);
      check('R10静态守卫(inspections.js真实源码) violations.length===0', inspectionsViolations.length === 0, inspectionsViolations);

      // C7-e（codex 46-R，主会话"第十人"裁定）：C7-d 的静态语法树路由收集被指出可被写法绕过——
      // router['post'](...)（方括号）、router.route(path).post(...)（链式）、router.all(...)
      // （匹配任意method）、动态路径变量，静态扫描只认"router.<method>(字符串字面量,...)"这一种点号
      // 写法，新增/恢复路由只要换个写法就不进集合，全等断言照样通过；这与 G1/G2 已经踩过的同一个坑
      // 相同：静态分析列举写法，永远列不全。不再给静态收集补写法，改为运行时读 Express 自己的路由表
      // （router.stack）——这与源码怎么写路由无关，Express 内部处理完各种写法后，最终落在 stack 里
      // 的 Layer 形状是统一的（layer.route.path / layer.route.methods），点号/方括号/route()链式
      // 写出来的路由在运行时完全等价，绕不开。用桩依赖调用 createInspections() 拿到真实 router 实例
      // （只取结构，不发起任何请求，依赖函数从不会被调用到）。
      const stubRouter = require('../routes/it-ledger/inspections')({ withRead: () => {}, handleErr: () => {}, collect: {}, sheetVisibility: () => {}, stripFinance: () => {} }).router;
      const runtimePairs = [];
      let runtimeMiddlewareLayers = 0;
      let runtimeRouteLayers = 0;
      const runtimeUnrecognized = [];
      const runtimeHandlerCounts = [];
      for (const layer of stubRouter.stack) {
        if (!layer.route) { runtimeMiddlewareLayers++; continue; }
        runtimeRouteLayers++;
        const route = layer.route;
        if (typeof route.path !== 'string') { runtimeUnrecognized.push({ reason: 'path不是字符串(动态/正则路径)', path: route.path }); continue; }
        const methodKeys = Object.keys(route.methods || {});
        if (!methodKeys.length) { runtimeUnrecognized.push({ reason: '没有任何method', path: route.path }); continue; }
        runtimeHandlerCounts.push({ path: route.path, methods: methodKeys, stackLength: (route.stack || []).length });
        for (const m of methodKeys) {
          if (m === '_all') { runtimeUnrecognized.push({ reason: 'router.all()匹配任意method', path: route.path }); continue; }
          runtimePairs.push(m + ':' + route.path);
        }
      }
      const INSPECTIONS_EXPECTED_ROUTES = ['get:/', 'get:/:id(\\d+)'];
      const runtimePairsSet = new Set(runtimePairs);
      check('C7-e:inspections.js运行时路由表——无法识别的层数为0(动态路径/router.all等一律判违规)', runtimeUnrecognized.length === 0, runtimeUnrecognized);
      check('C7-e:inspections.js运行时路由表——中间件/子路由层(router.use等无route的层)数为0', runtimeMiddlewareLayers === 0, runtimeMiddlewareLayers);
      // C7-f（codex 46-R2 H1）：只统计route.methods键统计不出"同一个route对象被.get()连续调两次"这类
      // 重复注册——Express的methods是幂等集合(第二次调.get()不会新增key)，但route自己的stack(该Route
      // 内部真实挂的处理层)会多出一层；这与"多注册了一整条新Route"是两种不同的绕过手法，各自要一条
      // 独立断言：①router.stack里"带route的层数"必须恰为2（挡住整条Route被多注册一次，哪怕它复用了
      // 已有的method+path对，凑巧不改变runtimePairs的长度/集合）；②每条Route自己的处理层数
      // (route.stack.length)必须恰为1——inspections.js两条路由都是单处理器直接写async(req,res)=>{...}，
      // canRead()是在handler内部被显式await调用的普通函数、不是Express中间件层，不会占一层，两条路由
      // 预期处理层数都是1（先读源码确认过，见本文件头部与inspections.js:33起的工厂体）。
      check('C7-f(H1,codex46-R2):router.stack中带route的层数恰为2(无整条Route重复注册)', runtimeRouteLayers === 2, runtimeRouteLayers);
      check('C7-f(H1,codex46-R2):每条route自己的处理层数(route.stack.length)恰为1(两条路由均无前置中间件,同一route的.get()未被连续调用两次)', runtimeHandlerCounts.every((r) => r.stackLength === 1), runtimeHandlerCounts);
      check('C7-e:inspections.js运行时路由表——注册的method+path对总数恰为2(无重复注册)', runtimePairs.length === 2, runtimePairs);
      check('C7-e:inspections.js运行时路由表——与预期集合(仅两条只读路由)全等,与源码写法无关(router[\'post\']/router.route()/router.all任何写法都会出现在这里)', runtimePairsSet.size === INSPECTIONS_EXPECTED_ROUTES.length && INSPECTIONS_EXPECTED_ROUTES.every((k) => runtimePairsSet.has(k)), { got: runtimePairs, expected: INSPECTIONS_EXPECTED_ROUTES });

      const collectSrc = fs.readFileSync(path.join(__dirname, '../routes/it-ledger/inspection-collect.js'), 'utf8');
      const collectAst = acorn.parse(collectSrc, { ecmaVersion: 2022, sourceType: 'script' });
      const collectViolations = runDbAccessGuard(collectAst, collectSrc, 'createInspectionCollect', INSPECTION_COLLECT_EXPECTED_DEPS, INSPECTION_COLLECT_REQUIRE_WHITELIST);
      check('R10静态守卫(inspection-collect.js真实源码) violations.length===0', collectViolations.length === 0, collectViolations);

      // G3A-b（M5 必修）：inspection-photo-files.js 是 inspection-sheets.js 唯一 require 的本地
      // 助手模块，此前不在 R10 扫描范围内——没有工厂函数（factoryFnName 传 null，只跑 require
      // 白名单检查）。
      const photoFilesSrc = fs.readFileSync(path.join(__dirname, '../routes/it-ledger/inspection-photo-files.js'), 'utf8');
      const photoFilesAst = acorn.parse(photoFilesSrc, { ecmaVersion: 2022, sourceType: 'script' });
      const photoFilesViolations = runDbAccessGuard(photoFilesAst, photoFilesSrc, null, null, INSPECTION_PHOTO_FILES_REQUIRE_WHITELIST);
      check('R10静态守卫(inspection-photo-files.js真实源码) violations.length===0', photoFilesViolations.length === 0, photoFilesViolations);

      // G3A-b（M5 负向用例）：在 inspection-photo-files.js 源码的字符串副本上加驱动 require，
      // 验证 R10 一定拦下（不改真实文件，只对内存中的字符串副本做变异）。
      const photoFilesMutated = photoFilesSrc.replace("const multer = require('multer');", "const multer = require('multer');\nconst sqlite3 = require('sqlite3');");
      if (photoFilesMutated === photoFilesSrc) throw new Error('M5负向用例: inspection-photo-files.js needle未命中');
      const photoFilesMutatedAst = acorn.parse(photoFilesMutated, { ecmaVersion: 2022, sourceType: 'script' });
      const photoFilesMutatedViolations = runDbAccessGuard(photoFilesMutatedAst, photoFilesMutated, null, null, INSPECTION_PHOTO_FILES_REQUIRE_WHITELIST);
      check("M5负向用例: inspection-photo-files.js加require('sqlite3')命中R10", photoFilesMutatedViolations.some((v) => v.rule === 'R10'), photoFilesMutatedViolations);
    }

    // ============================================================
    // 放行侧对照：合法新增写路由——证明白名单不是"全拒"，按规定写法（顶层ExpressionStatement、
    // 非computed、路径字面量、中间件在白名单、内联async处理器、恰1处withWrite且首句assertWrite）
    // 新增的路由，把它的键加入预期集合后应当零violation。
    // ============================================================
    {
      const srcPath = path.join(__dirname, '../routes/it-ledger/inspection-sheets.js');
      const src = fs.readFileSync(srcPath, 'utf8');
      const needle = 'return { router, sheetActions, sheetVisibility, sheetProgress, processCleanupQueue };';
      const newRouteSrc = [
        "router.post('/:id/ping', requireLedgerWrite, async (req, res) => {",
        '    try {',
        '      const n = id(req.params.id);',
        '      await withWrite(async (q) => {',
        '        await q.assertWrite(req.user);',
        '        if (!(await exists(q))) throw notFound();',
        '      });',
        '      res.json({ ok: true, id: n });',
        '    } catch (e) { handleErr(res, e); }',
        '  });',
        '  ' + needle,
      ].join('\n');
      const count = src.split(needle).length - 1;
      check('放行侧对照:合法新增写路由needle精确命中一次', count === 1, { count });
      const mutated = src.split(needle).join(newRouteSrc);
      const expandedWrite = new Set([...SHEET_WRITE_ROUTES, 'post:/:id/ping']);
      const result = runSheetRouteGuard(mutated, { writeRoutes: expandedWrite, readRoutes: SHEET_READ_ROUTES });
      check('放行侧对照:合法新增写路由(加入预期键后)零violation', result.violations.length === 0, result.violations);
    }

    // ============================================================
    // 负向用例：26 条判别力用例（G2A2 派单任务3 + Commit2 新增 R8 两条 + G2A2b M3/L3 新增三条 +
    // G3A 新增 R10 两条）。对 runSheetRouteGuard 喂由真实源码程序化字符串替换得到的变体，每条先
    // 断言替换确实发生了一次（needle count===1，否则用例自身失败），再断言 violations 非空且包含
    // 预期的 rule 编号（不是只断言"有violation"）；带 expectedKey/expectedFn 的用例额外断言命中
    // violation 的 detail 里路由键/函数名与预期一致（修 L3：旧实现只断言"命中了预期 rule"，不断言
    // 是不是命中在"预期那一条路由"上——多路由共享同一 rule 时可能张冠李戴）。
    // 对照原 20 条（G1A/G1A-b）：保留 1-6/12-15/17/18（按新规则编号核对，R3→R7 改名）；删除
    // 7-11/16/19/20（只测已删的 R3/R4/TH1，本轮不再声明）；新增 H3a/H3b/H3c（R1 直接父节点判据）/
    // M1a/M1b（R2 中间件契约）/M2（R7 全文件计数）/L2（R5 assertWrite 非计算访问）/20-21（R8
    // runCleanupDetached 挪用/别名，Commit2 新增，G3A 随函数改名同步改名）/25-26（R10 新增，
    // require('sqlite3') 与工厂参数多一个 db，G3A 新增）。
    // ============================================================
    {
      const srcPath = path.join(__dirname, '../routes/it-ledger/inspection-sheets.js');
      const ORIG_SRC = fs.readFileSync(srcPath, 'utf8');
      function mutateOnce(src, needle, replacement, label) {
        const count = src.split(needle).length - 1;
        if (count !== 1) throw new Error(`APPLY_FAILED(${label}): needle count != 1, got ${count}`);
        return src.split(needle).join(replacement);
      }
      const RETURN_NEEDLE = 'return { router, sheetActions, sheetVisibility, sheetProgress, processCleanupQueue };';
      const cases = [
        {
          no: 1, desc: "router['post']('/x', requireLedgerWrite, async (req,res)=>{})", expectedRule: 'R1',
          mutate: (src) => mutateOnce(src, RETURN_NEEDLE, "router['post']('/x-case1', requireLedgerWrite, async (req, res) => {});\n  " + RETURN_NEEDLE, 'case1'),
        },
        {
          no: 2, desc: "router.route('/x').post(requireLedgerWrite, async ...)", expectedRule: 'R1',
          mutate: (src) => mutateOnce(src, RETURN_NEEDLE, "router.route('/x-case2').post(requireLedgerWrite, async (req, res) => {});\n  " + RETURN_NEEDLE, 'case2'),
        },
        {
          no: 3, desc: "router.post('/x', requireLedgerWrite, namedHandler)", expectedRule: 'R1',
          mutate: (src) => mutateOnce(src, RETURN_NEEDLE, "router.post('/x-case3', requireLedgerWrite, namedHandler);\n  " + RETURN_NEEDLE, 'case3'),
        },
        {
          no: 4, desc: 'const r2 = router; r2.post(...)', expectedRule: 'R1',
          mutate: (src) => mutateOnce(src, RETURN_NEEDLE, "const r2 = router; r2.post('/x-case4', requireLedgerWrite, async (req, res) => {});\n  " + RETURN_NEEDLE, 'case4'),
        },
        {
          no: 5, desc: 'if块内注册路由', expectedRule: 'R1',
          mutate: (src) => mutateOnce(src, RETURN_NEEDLE, "if (true) { router.get('/x-case5', async (req, res) => {}); }\n  " + RETURN_NEEDLE, 'case5'),
        },
        {
          no: 6, desc: '第二个express.Router()', expectedRule: 'R1',
          mutate: (src) => mutateOnce(src, 'const router = express.Router();', 'const router = express.Router();\n  const anotherRouter = express.Router();', 'case6'),
        },
        {
          // G2A2 修 H3a：直接父节点是 AssignmentExpression（先声明后赋值），不是 ExpressionStatement
          // 本身——旧实现沿祖先链向上搜索会把外层的 ExpressionStatement 误判为"顶层语句"。
          no: 7, desc: 'H3a: let r2case7; r2case7 = router.get(...)（赋值表达式包一层）', expectedRule: 'R1',
          mutate: (src) => mutateOnce(src, RETURN_NEEDLE, "let r2case7; r2case7 = router.get('/x-case7', async (req, res) => {});\n  " + RETURN_NEEDLE, 'case7'),
        },
        {
          // G2A2 修 H3b：直接父节点是 LogicalExpression。
          no: 8, desc: 'H3b: testHooksCase8 && router.get(...)（逻辑表达式包一层）', expectedRule: 'R1',
          mutate: (src) => mutateOnce(src, RETURN_NEEDLE, "testHooksCase8 && router.get('/x-case8', async (req, res) => {});\n  " + RETURN_NEEDLE, 'case8'),
        },
        {
          // G2A2 修 H3c：直接父节点是外层 CallExpression（helper(...) 包一层）——本条是 H3 三个
          // 反例里最贴近真实绕过手法的一条：高阶函数"收"一次路由注册调用的返回值。
          no: 9, desc: 'H3c: helperCase9(router.post(...))（外层调用包一层）', expectedRule: 'R1',
          mutate: (src) => mutateOnce(src, RETURN_NEEDLE, "helperCase9(router.post('/x-case9', async (req, res) => {}));\n  " + RETURN_NEEDLE, 'case9'),
        },
        {
          // G2A2 修 M1a：写路由 /archive 删掉 requireLedgerWrite，中间参数变空数组——旧实现的
          // .every() 对空数组恒真，完全拦不住。
          no: 10, desc: "M1a: router.post('/archive', ...) 删掉 requireLedgerWrite", expectedRule: 'R2', expectedKey: 'post:/archive',
          mutate: (src) => mutateOnce(src,
            "router.post('/archive', requireLedgerWrite, async (req, res) => {",
            "router.post('/archive', async (req, res) => {",
            'case10'),
        },
        {
          // G2A2 修 M1b：读路由 /stats 被多挂 requireLedgerWrite——旧实现的白名单只看"是不是在白名单
          // 里"，不看"这条路由该不该有"，读路由被多挂反而会被放行。
          no: 11, desc: "M1b: router.get('/stats', ...) 加上 requireLedgerWrite", expectedRule: 'R2', expectedKey: 'get:/stats',
          mutate: (src) => mutateOnce(src,
            "router.get('/stats', async (req, res) => {",
            "router.get('/stats', requireLedgerWrite, async (req, res) => {",
            'case11'),
        },
        {
          no: 12, desc: 'const w = withWrite; await w(...)', expectedRule: 'R5',
          mutate: (src) => mutateOnce(src, 'const router = express.Router();', "const router = express.Router();\n  const w = withWrite; w(async (q) => { q.assertWrite(req.user); });", 'case12'),
        },
        {
          no: 13, desc: 'POST / 多一处withWrite', expectedRule: 'R5', expectedKey: 'post:/',
          mutate: (src) => mutateOnce(src,
            "res.status(201).json(detail);\n      processCleanupQueueBestEffort(); // C2c M1：响应发出之后顺带处理，不让本次请求等这把锁\n    } catch (e) { handleErr(res, e); }\n  });\n\n  router.post('/archive'",
            "await withWrite(async (q) => { await q.assertWrite(req.user); });\n      res.status(201).json(detail);\n      processCleanupQueueBestEffort(); // C2c M1：响应发出之后顺带处理，不让本次请求等这把锁\n    } catch (e) { handleErr(res, e); }\n  });\n\n  router.post('/archive'",
            'case13'),
        },
        {
          no: 14, desc: '采集路由第二回调删首句assertWrite', expectedRule: 'R5', expectedKey: SHEET_COLLECT_ROUTE_KEY,
          mutate: (src) => mutateOnce(src,
            "const result = await withWrite(async (q) => {\n        await q.assertWrite(req.user);\n        // 第二阶段：与第一阶段完全同一组判定",
            "const result = await withWrite(async (q) => {\n        // 第二阶段：与第一阶段完全同一组判定",
            'case14'),
        },
        {
          // R3 已删除，本条原本命中"锁外白名单"，现改归 R7（采集路由形态——collectSnapshot 挪到
          // 第一个 withWrite 之前之后，不再位于两次 withWrite 之间）。M4（G3A-b）核对：命中位置
          // 仍在采集路由自己的 handler 区间内（只是挪到两次 withWrite 之外，没跳出这条路由本身），
          // 按命中位置计算的 key 仍是 SHEET_COLLECT_ROUTE_KEY，不变（本用例走"insideCollectHandler
          // 为真"分支）。
          no: 15, desc: 'collect.collectSnapshot挪到第一个withWrite之前', expectedRule: 'R7', expectedKey: SHEET_COLLECT_ROUTE_KEY,
          mutate: (src) => mutateOnce(src,
            "const { asset } = await withWrite(async (q) => {\n        await q.assertWrite(req.user);\n        const { item } = await checkSheetAndItem(q, req.user, n, itemId);\n        const asset = await assertCollectableAsset(q, item.target_id);\n        return { asset };\n      });\n      // 锁外：collectSnapshot 内部按 host 的单飞集合（原与服务器单独采集共用同一份、不形成两把锁，\n      // C7 单独设备巡检退役后那个采集入口已删，现在只有本路由在用这份集合，实现不变）+\n      // 调用采集器，慢的是这一步，绝不能夹在两个写事务之间持锁做（方案 §5.1 明文）。\n      const snapshot = await collect.collectSnapshot(asset);",
            "const snapshot = await collect.collectSnapshot(asset);\n      const { asset } = await withWrite(async (q) => {\n        await q.assertWrite(req.user);\n        const { item } = await checkSheetAndItem(q, req.user, n, itemId);\n        const asset = await assertCollectableAsset(q, item.target_id);\n        return { asset };\n      });",
            'case15'),
        },
        {
          no: 16, desc: '读路由GET /里加withWrite', expectedRule: 'R6', expectedKey: 'get:/',
          mutate: (src) => mutateOnce(src,
            "router.get('/', async (req, res) => {\n    try {",
            "router.get('/', async (req, res) => {\n    try {\n      await withWrite(async (q) => { await q.assertWrite(req.user); });",
            'case16'),
        },
        {
          no: 17, desc: 'processCleanupQueue多一处withWrite(逐函数计数)', expectedRule: 'R5', expectedFn: 'processCleanupQueue',
          mutate: (src) => mutateOnce(src,
            "    await withWrite(async (q) => {\n      for (const o of outcomes) {\n        if (o.ok) await q.run('DELETE FROM it_inspection_file_cleanup WHERE id=?', [o.id]);\n        else await q.run('UPDATE it_inspection_file_cleanup SET attempts=attempts+1,last_error=? WHERE id=?', [o.message || 'unlink failed', o.id]);\n      }\n    });\n    return { processed: rows.length, failed: outcomes.filter((o) => !o.ok).length };",
            "    await withWrite(async (q) => {\n      for (const o of outcomes) {\n        if (o.ok) await q.run('DELETE FROM it_inspection_file_cleanup WHERE id=?', [o.id]);\n        else await q.run('UPDATE it_inspection_file_cleanup SET attempts=attempts+1,last_error=? WHERE id=?', [o.message || 'unlink failed', o.id]);\n      }\n    });\n    await withWrite(async (q) => { await q.run('SELECT 1'); });\n    return { processed: rows.length, failed: outcomes.filter((o) => !o.ok).length };",
            'case17'),
        },
        {
          // G2A2 修 M2：POST / 处理器锁外插入第二处 collect.collectSnapshot 调用——全文件命中数变成
          // 2，R7"恰1处"判定失效。旧实现按"只在采集路由自己锁外扫描"方式检查，别的路由多挂一次测不出来。
          // M1（41T 必修）：R7 天然只归属采集路由这一条路由（不管命中数超标的那个多余调用实际写在
          // 哪个路由里），补 expectedKey 精确核对。M4（G3A-b 必修，改按命中位置计算）：key 改按
          // "命中位置落在哪条路由"计算——多出的那次调用实际写在 post:/ 处理器内，实测 key 就是
          // 'post:/'（不再是 SHEET_COLLECT_ROUTE_KEY），ownerKey 仍恒为 SHEET_COLLECT_ROUTE_KEY。
          no: 18, desc: 'M2: POST / 处理器锁外加 collect.collectSnapshot(x)', expectedRule: 'R7', expectedKey: 'post:/',
          mutate: (src) => mutateOnce(src,
            "const roomName = b.room_name.trim();\n      const detail = await withWrite(async (q) => {",
            "const roomName = b.room_name.trim();\n      collect.collectSnapshot(x);\n      const detail = await withWrite(async (q) => {",
            'case18'),
        },
        {
          // G2A2 修 L2：归档路由首句改成计算属性访问 q['assertWrite'](req.user)。
          no: 19, desc: "L2: router.post('/archive',...) 首句改 q['assertWrite'](req.user)", expectedRule: 'R5', expectedKey: 'post:/archive',
          mutate: (src) => mutateOnce(src,
            "await q.assertWrite(req.user);\n        if (req.user.role !== 'admin') throw forbidden('仅管理员可以归档');",
            "await q['assertWrite'](req.user);\n        if (req.user.role !== 'admin') throw forbidden('仅管理员可以归档');",
            'case19'),
        },
        {
          // G2A2 Commit2 新增，G3A 随函数改名同步改名：runCleanupDetached 被挪用进某个写路由
          // 处理器（锁外插入一次调用）——专属通道被塞进业务处理器，理应判违规（不因为"参数是个
          // 数字/闭包看起来无害"就放行，R8 只看标识符出现的位置，不看调用参数）。
          no: 20, desc: 'R8: POST / 处理器锁外插入 runCleanupDetached(1)', expectedRule: 'R8',
          mutate: (src) => mutateOnce(src,
            "const roomName = b.room_name.trim();\n      const detail = await withWrite(async (q) => {",
            "const roomName = b.room_name.trim();\n      runCleanupDetached(1);\n      const detail = await withWrite(async (q) => {",
            'case20'),
        },
        {
          // G2A2 Commit2 新增，G3A 随函数改名同步改名：runCleanupDetached 起别名——旧 R5 对
          // withWrite 也有同款判据（别名/透传一律判违规），R8 对 runCleanupDetached 照搬同一思路。
          no: 21, desc: 'R8: const d = runCleanupDetached（起别名）', expectedRule: 'R8',
          mutate: (src) => mutateOnce(src, 'const router = express.Router();', "const router = express.Router();\n  const d = runCleanupDetached;", 'case21'),
        },
        {
          // G2A2b M3 新增，G3A 随函数改名同步改名：工厂参数解构里 runCleanupDetached 重复键——JS
          // 解构模式允许同一属性名出现多次，各自独立绑定，白送一个不受 R8 文本匹配监视的别名 d，
          // 路由内用 d(...) 就绕开了"runCleanupDetached 只能在工厂参数声明与
          // processCleanupQueueBestEffort 内出现"这条约束。调用参数改传数字（1）——新函数不接受
          // 回调，传函数也只会被当成一个被忽略/误用的 limit 值，不影响本条静态判定的意图（R8 只
          // 判定标识符出现位置，不判定调用参数）。
          no: 22, desc: "M3: 工厂参数解构runCleanupDetached重复键({ runCleanupDetached, runCleanupDetached: d })+路由内d(1)", expectedRule: 'R8',
          mutate: (src) => {
            const withDup = mutateOnce(src,
              'module.exports = function createInspectionSheets({ withRead, withWrite, requireLedgerWrite, handleErr, recordManagement, storageDir, testHooks, collect, stripFinance, runCleanupDetached }) {',
              'module.exports = function createInspectionSheets({ withRead, withWrite, requireLedgerWrite, handleErr, recordManagement, storageDir, testHooks, collect, stripFinance, runCleanupDetached, runCleanupDetached: d }) {',
              'case22-dup');
            return mutateOnce(withDup,
              "const roomName = b.room_name.trim();\n      const detail = await withWrite(async (q) => {",
              "const roomName = b.room_name.trim();\n      d(1);\n      const detail = await withWrite(async (q) => {",
              'case22-call');
          },
        },
        {
          // G2A2b M3 新增：工厂参数解构里 withWrite 重命名——旧实现只按 key.name==='withWrite' 匹配，
          // 不检查是不是 shorthand，重命名后 w 这个别名同样不受任何规则监视。
          no: 23, desc: "M3: 工厂参数解构withWrite重命名({ withWrite: w })", expectedRule: 'R5',
          mutate: (src) => mutateOnce(src,
            'module.exports = function createInspectionSheets({ withRead, withWrite, requireLedgerWrite, handleErr, recordManagement, storageDir, testHooks, collect, stripFinance, runCleanupDetached }) {',
            'module.exports = function createInspectionSheets({ withRead, withWrite: w, requireLedgerWrite, handleErr, recordManagement, storageDir, testHooks, collect, stripFinance, runCleanupDetached }) {',
            'case23'),
        },
        {
          // G2A2b L3 新增：await processCleanupQueueBestEffort()——违反"只能以不await的独立语句
          // 出现"这条约束（R9）。
          no: 24, desc: 'L3/R9: await processCleanupQueueBestEffort()（POST / 路由内）', expectedRule: 'R9',
          mutate: (src) => mutateOnce(src,
            "res.status(201).json(detail);\n      processCleanupQueueBestEffort(); // C2c M1：响应发出之后顺带处理，不让本次请求等这把锁\n    } catch (e) { handleErr(res, e); }\n  });\n\n  router.post('/archive'",
            "res.status(201).json(detail);\n      await processCleanupQueueBestEffort(); // C2c M1：响应发出之后顺带处理，不让本次请求等这把锁\n    } catch (e) { handleErr(res, e); }\n  });\n\n  router.post('/archive'",
            'case24'),
        },
        {
          // G3A 新增：路由文件自行 require('sqlite3')——41S 部分成立结论"路由文件当前拿不到裸
          // 连接...需自行 require 驱动才算绕过"的静态反例，证明"只要真引入驱动，R10 一定拦下"。
          no: 25, desc: "R10: 文件顶部加 require('sqlite3')", expectedRule: 'R10',
          mutate: (src) => mutateOnce(src,
            "const photoFiles = require('./inspection-photo-files');",
            "const photoFiles = require('./inspection-photo-files');\nconst sqlite3 = require('sqlite3');",
            'case25'),
        },
        {
          // G3A 新增：工厂参数解构多一个 db——固定注入依赖集合被悄悄扩大，即使这个 db 从未被任何
          // 路由处理器实际使用，R10 也要拦（"新增依赖即失败"，不等到真被消费才报）。
          no: 26, desc: 'R10: 工厂参数解构多一个db', expectedRule: 'R10',
          mutate: (src) => mutateOnce(src,
            'module.exports = function createInspectionSheets({ withRead, withWrite, requireLedgerWrite, handleErr, recordManagement, storageDir, testHooks, collect, stripFinance, runCleanupDetached }) {',
            'module.exports = function createInspectionSheets({ withRead, withWrite, requireLedgerWrite, handleErr, recordManagement, storageDir, testHooks, collect, stripFinance, runCleanupDetached, db }) {',
            'case26'),
        },
        {
          // G3A-b（M5 新增）：require 目标是字面量字符串，但不在固定白名单内——不是黑名单式只挡
          // sqlite3/better-sqlite3，任何不在白名单里的依赖都要拦，包括 Node 内置的现代 sqlite
          // 模块（node:sqlite，Node 22+ 自带，不需要额外装包，比 require('sqlite3') 更隐蔽）。
          no: 27, desc: "R10: 文件顶部加 require('node:sqlite')", expectedRule: 'R10',
          mutate: (src) => mutateOnce(src,
            "const photoFiles = require('./inspection-photo-files');",
            "const photoFiles = require('./inspection-photo-files');\nconst sqlite = require('node:sqlite');",
            'case27'),
        },
        {
          // G3A-b（M5 新增）：同上，另一个不在白名单内的字面量（npm 上确实存在的包名 'sqlite'，
          // 与 'sqlite3' 只差一个字符，验证白名单是精确字符串匹配，不是前缀/子串匹配）。
          no: 28, desc: "R10: 文件顶部加 require('sqlite')", expectedRule: 'R10',
          mutate: (src) => mutateOnce(src,
            "const photoFiles = require('./inspection-photo-files');",
            "const photoFiles = require('./inspection-photo-files');\nconst sqlite = require('sqlite');",
            'case28'),
        },
        {
          // G3A-b（M5 新增）：工厂参数解构加 RestElement（...rest）——旧实现只统计
          // Property+Identifier 键，RestElement 会被直接跳过，既不算 extra 也不算 missing，是
          // 全等比较的逃逸口：路由处理器可以通过 rest.anything 拿到任意未来新增的依赖，而 R10
          // 却认为"键集合与预期一致"。
          no: 29, desc: 'R10: 工厂参数解构加...rest', expectedRule: 'R10',
          mutate: (src) => mutateOnce(src,
            'module.exports = function createInspectionSheets({ withRead, withWrite, requireLedgerWrite, handleErr, recordManagement, storageDir, testHooks, collect, stripFinance, runCleanupDetached }) {',
            'module.exports = function createInspectionSheets({ withRead, withWrite, requireLedgerWrite, handleErr, recordManagement, storageDir, testHooks, collect, stripFinance, runCleanupDetached, ...rest }) {',
            'case29'),
        },
        {
          // G3A-c（41RT M5 新增）：动态 import()——与 require() 平行的另一套模块加载入口，旧
          // 实现只扫 CallExpression callee 是标识符 require 的调用，看不到 ImportExpression。
          no: 30, desc: "R10: 文件顶部加 import('node:sqlite')", expectedRule: 'R10',
          mutate: (src) => mutateOnce(src,
            "const photoFiles = require('./inspection-photo-files');",
            "const photoFiles = require('./inspection-photo-files');\nimport('node:sqlite');",
            'case30'),
        },
        {
          // G3A-c（41RT M5 新增）：module.require(...)——MemberExpression 形式的调用，callee 不是
          // 裸标识符 require，旧实现的"callee.name==='require'"判据看不到。
          no: 31, desc: "R10: 文件顶部加 module.require('sqlite3')", expectedRule: 'R10',
          mutate: (src) => mutateOnce(src,
            "const photoFiles = require('./inspection-photo-files');",
            "const photoFiles = require('./inspection-photo-files');\nmodule.require('sqlite3');",
            'case31'),
        },
        {
          // G3A-c（41RT M5 新增）：require 被当值引用（赋给别名）而非直接调用——真正的恶意调用点
          // r('sqlite3') 的 callee 是 r 不是 require，旧实现对它视而不见；新判据直接拦"require
          // 标识符出现在非直接调用位置"这个动作本身，不等到看见后续用别名发起的调用。
          no: 32, desc: 'R10: const r = require（起别名，为后续绕开检查的调用铺垫）', expectedRule: 'R10',
          mutate: (src) => mutateOnce(src,
            "const photoFiles = require('./inspection-photo-files');",
            "const photoFiles = require('./inspection-photo-files');\nconst __r = require;",
            'case32'),
        },
        {
          // G3A-c（41RT M5 新增）：require() 调用参数非字符串字面量（动态拼接/变量）——这条判据
          // 在①里已经存在（isLiteralString 检查），本条是按派单要求补一条独立的负向用例，实测确认
          // 该分支确实会被命中，不只是"理论上覆盖"。
          no: 33, desc: 'R10: require(变量) 而非字符串字面量', expectedRule: 'R10',
          mutate: (src) => mutateOnce(src,
            "const photoFiles = require('./inspection-photo-files');",
            "const photoFiles = require('./inspection-photo-files');\nconst __modName = 'sqlite3';\nrequire(__modName);",
            'case33'),
        },
      ];
      const negativeReport = [];
      for (const c of cases) {
        let mutated = null;
        let applyErr = null;
        try { mutated = c.mutate(ORIG_SRC); } catch (e) { applyErr = e; }
        check(`负向用例${c.no}应用变异成功(needle精确命中一次): ${c.desc}`, !applyErr, applyErr && applyErr.message);
        if (applyErr) { negativeReport.push({ no: c.no, desc: c.desc, expectedRule: c.expectedRule, applyError: applyErr.message }); continue; }
        const result = runSheetRouteGuard(mutated);
        check(`负向用例${c.no}产生violation: ${c.desc}`, result.violations.length > 0, result.violations);
        const rulesHit = [...new Set(result.violations.map((v) => v.rule))];
        check(`负向用例${c.no}命中预期rule=${c.expectedRule}: ${c.desc}`, rulesHit.includes(c.expectedRule), { rulesHit });
        if (c.expectedKey !== undefined) {
          const keyHit = result.violations.some((v) => v.rule === c.expectedRule && v.detail && v.detail.key === c.expectedKey);
          check(`负向用例${c.no}命中的violation.detail.key=${c.expectedKey}: ${c.desc}`, keyHit, result.violations);
        }
        if (c.expectedFn !== undefined) {
          const fnHit = result.violations.some((v) => v.rule === c.expectedRule && v.detail && v.detail.fn === c.expectedFn);
          check(`负向用例${c.no}命中的violation.detail.fn=${c.expectedFn}: ${c.desc}`, fnHit, result.violations);
        }
        negativeReport.push({ no: c.no, desc: c.desc, expectedRule: c.expectedRule, rulesHit });
      }
      check('负向用例33条全部跑完(编号1-33无遗漏,G3A新增25-26,G3A-b新增27-29,G3A-c新增30-33)', negativeReport.length === 33 && new Set(negativeReport.map((r) => r.no)).size === 33, negativeReport.map((r) => r.no));
      const coveredRules = new Set(negativeReport.map((r) => r.expectedRule));
      check('负向用例覆盖R1/R2/R5/R6/R7/R8/R9/R10全部8条规则', ['R1', 'R2', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10'].every((r) => coveredRules.has(r)), [...coveredRules]);
      console.log('G2A2_NEGATIVE_CASES_REPORT=' + JSON.stringify(negativeReport));
    }

    // ============================================================
    // M2：已删除单——巡检人与管理员对逻辑删除单的写动作一律404（或批量整批409+problems标明），
    // 行未变；restore 未删除的单 → 404，版本不变，无 restore 日志。
    // ============================================================
    {
      const m2 = await buildSubmittedSheet('M2-Deleted', 2);
      const m2del = await f.api('DELETE', '/inspections/sheets/' + m2.id, { expected_version: m2.version, reason: 'M2测试删除' }, 2);
      check('M2辅助单逻辑删除200', m2del.status === 200, m2del.body);
      const beforeRow = (await f.all('SELECT * FROM it_inspection_sheets WHERE id=?', [m2.id]))[0];
      const beforeItems = await f.all('SELECT * FROM it_inspection_sheet_items WHERE sheet_id=? ORDER BY id', [m2.id]);
      const beforeLog = await f.all('SELECT * FROM it_inspection_sheet_log WHERE sheet_id=? ORDER BY id', [m2.id]);
      for (const uid of [2, 1]) {
        const label = uid === 2 ? '巡检人' : '管理员';
        const put = await f.api('PUT', '/inspections/sheets/' + m2.id, { expected_version: beforeRow.version, items: [], remark: null }, uid);
        check(`M2已删除-${label}-保存404`, put.status === 404 && put.body.code === 'SHEET_NOT_FOUND', put.body);
        const submit = await f.api('POST', '/inspections/sheets/' + m2.id + '/submit', { expected_version: beforeRow.version }, uid);
        check(`M2已删除-${label}-提交404`, submit.status === 404 && submit.body.code === 'SHEET_NOT_FOUND', submit.body);
        const del2 = await f.api('DELETE', '/inspections/sheets/' + m2.id, { expected_version: beforeRow.version, reason: 'x' }, uid);
        check(`M2已删除-${label}-删除404`, del2.status === 404 && del2.body.code === 'SHEET_NOT_FOUND', del2.body);
        const unarchive = await f.api('POST', '/inspections/sheets/' + m2.id + '/unarchive', { expected_version: beforeRow.version, reason: 'x' }, uid);
        // 撤回归档先过"仅管理员"闸——非管理员（巡检人）在这一步就 403，永远到不了已删除判定；
        // 只有管理员会真正走到"已删除→404"这条分支。
        if (uid === 1) check(`M2已删除-${label}-撤回404`, unarchive.status === 404 && unarchive.body.code === 'SHEET_NOT_FOUND', unarchive.body);
        else check(`M2已删除-${label}-撤回403(先过角色闸)`, unarchive.status === 403 && unarchive.body.code === 'SHEET_FORBIDDEN', unarchive.body);
      }
      const m2valid = await buildSubmittedSheet('M2-ValidCompanion', 2);
      const archiveBatch = await f.api('POST', '/inspections/sheets/archive', { items: [{ id: m2.id, expected_version: beforeRow.version }, { id: m2valid.id, expected_version: m2valid.version }] }, 1);
      check('M2批量归档夹已删除单整批409', archiveBatch.status === 409 && archiveBatch.body.code === 'SHEET_STATE' && archiveBatch.body.detail.problems.some((p) => p.id === m2.id), archiveBatch.body);
      const afterRow = (await f.all('SELECT * FROM it_inspection_sheets WHERE id=?', [m2.id]))[0];
      const afterItems = await f.all('SELECT * FROM it_inspection_sheet_items WHERE sheet_id=? ORDER BY id', [m2.id]);
      const afterLog = await f.all('SELECT * FROM it_inspection_sheet_log WHERE sheet_id=? ORDER BY id', [m2.id]);
      check('M2已删除单全部探测后行未变(单/检查项/日志)', JSON.stringify(beforeRow) === JSON.stringify(afterRow) && JSON.stringify(beforeItems) === JSON.stringify(afterItems) && JSON.stringify(beforeLog) === JSON.stringify(afterLog));
      const validAfter = (await f.all('SELECT * FROM it_inspection_sheets WHERE id=?', [m2valid.id]))[0];
      check('M2批量归档中合格的一张也未被写入(整批回滚)', validAfter.status === 'submitted' && validAfter.version === m2valid.version);

      const restoreNotDeleted = await f.api('POST', '/inspections/sheets/' + m2valid.id + '/restore', { expected_version: m2valid.version }, 1);
      check('M2恢复未删除的单404', restoreNotDeleted.status === 404 && restoreNotDeleted.body.code === 'SHEET_NOT_FOUND', restoreNotDeleted.body);
      const validAfterRestore = (await f.all('SELECT * FROM it_inspection_sheets WHERE id=?', [m2valid.id]))[0];
      check('M2恢复未删除的单版本不变', validAfterRestore.version === m2valid.version);
      const restoreLog = await f.all("SELECT * FROM it_inspection_sheet_log WHERE sheet_id=? AND action='restore'", [m2valid.id]);
      check('M2恢复未删除的单无restore日志', restoreLog.length === 0);
    }

    // ============================================================
    // M3a：建单撞草稿，detail.draft 键集合恰为 {id, created_by_name, created_at}
    // ============================================================
    {
      const m3room = 'M3-DraftExists';
      await makeRoom(m3room);
      const first = await createSheet(2, m3room);
      check('M3a建单201', first.status === 201, first.body);
      const dup = await createSheet(1, m3room);
      check('M3a撞草稿409 SHEET_DRAFT_EXISTS', dup.status === 409 && dup.body.code === 'SHEET_DRAFT_EXISTS', dup.body);
      check('M3a detail.draft键集合恰为{id,created_by_name,created_at}', JSON.stringify(Object.keys(dup.body.detail.draft).sort()) === JSON.stringify(['created_at', 'created_by_name', 'id']), dup.body.detail);
      check('M3a detail.draft.id指向first', dup.body.detail.draft.id === first.body.id);
    }

    // ============================================================
    // M3b + M3f：全新独立 fixture（建表前）——机房无机柜400且五表仍不存在（证明懒建在写事务内
    // 回滚）；/stats、/deleted、/:id 在表不存在时不建表。
    // ============================================================
    {
      const fresh = await createFixture();
      try {
        const TABLE_IN_LIST = "('it_inspection_sheets','it_inspection_sheet_items','it_inspection_sheet_photos','it_inspection_sheet_log','it_inspection_file_cleanup')";
        const t0fresh = await fresh.all(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ${TABLE_IN_LIST}`);
        check('M3f-fresh初始无表', t0fresh.length === 0);
        const statsResp = await fresh.api('GET', '/inspections/sheets/stats', undefined, 1);
        check('M3f stats表不存在时200且全0', statsResp.status === 200 && statsResp.body.submitted_month === 0 && statsResp.body.abnormal_month === 0 && statsResp.body.drafts === 0 && statsResp.body.pending_archive === 0, statsResp.body);
        const deletedResp = await fresh.api('GET', '/inspections/sheets/deleted', undefined, 1);
        check('M3f deleted表不存在时200且空', deletedResp.status === 200 && deletedResp.body.items.length === 0, deletedResp.body);
        const detailResp = await fresh.api('GET', '/inspections/sheets/1', undefined, 1);
        check('M3f 详情表不存在时404', detailResp.status === 404 && detailResp.body.code === 'SHEET_NOT_FOUND', detailResp.body);
        const t1fresh = await fresh.all(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ${TABLE_IN_LIST}`);
        check('M3f stats/deleted/:id都不建表', t1fresh.length === 0, t1fresh);

        const noRackResp = await fresh.api('POST', '/inspections/sheets', { room_name: '不存在机柜的机房' }, 2);
        check('M3b机房无机柜400', noRackResp.status === 400 && noRackResp.body.code === 'LEDGER_BAD_REQUEST', noRackResp.body);
        const t2fresh = await fresh.all(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ${TABLE_IN_LIST}`);
        check('M3b建单失败后五表仍不存在(证明懒建在写事务内回滚)', t2fresh.length === 0, t2fresh);
      } finally {
        await fresh.close();
      }
    }

    // ============================================================
    // M3c：建单范围排除——作废资产、非in_service资产、其他机房机柜里的设备都不在scope与检查项里
    // ============================================================
    {
      // 平台侧的 record-management 触发器（it_record_block_update）与 detached() 前置检查决定了
      // "已作废但仍在机柜里"“非in_service但仍在机柜里”这两种状态，经由真实接口/正常UPDATE都不可能
      // 构造出来（作废前必须先下架；下架会清 rack_id）——所以直接用 f.run 绕过应用层，在库里强行
      // 造出这两种"只应由 buildScope 的过滤条件挡住、不该指望别的机制顺带挡住"的状态，这样一来，
      // 如果谁误删了 activeClause 或 status='in_service' 过滤，这里才会真正变红（已用
      // mutate-c1b.js 实测确认：改前的写法对这两个变异都不变红，因为被排除的资产本来就没有
      // rack_id，删不删过滤条件结果都一样）。
      const room = 'M3-ScopeExclude';
      const rack = (await f.api('POST', '/racks', { name: room + '-柜X', room, u_total: 20 })).body;
      const otherRack = (await f.api('POST', '/racks', { name: room + '-其他机房柜', room: room + '-OtherRoom', u_total: 20 })).body;
      const active = (await f.api('POST', '', { category: 'server', name: room + '-在用', u_height: 1, placement: { kind: 'rack', rack_id: rack.id, u_start: 1 } })).body;
      const depot = (await f.api('POST', '', { category: 'server', name: room + '-库房', u_height: 1, placement: { kind: 'depot' } })).body;
      const otherRoomDevice = (await f.api('POST', '', { category: 'server', name: room + '-别的机房设备', u_height: 1, placement: { kind: 'rack', rack_id: otherRack.id, u_start: 1 } })).body;
      // it_asset_record_controls 本身懒建（首次授权写事务才建）：先用一次真实的、走接口的作废动作
      // （对一台可正常作废的库房设备）把表建出来，再直接 SQL 插入下面那条"绕开前置检查"的行。
      const bootstrapVoid = (await f.api('POST', '', { category: 'server', name: room + '-引导建表用', u_height: 1, placement: { kind: 'depot' } })).body;
      const bootstrapVoidResp = await f.api('POST', '/' + bootstrapVoid.id + '/record-management', { action: 'void', reason: 'M3c引导建表', expected_version: bootstrapVoid.version }, 1);
      check('M3c引导建表用作废200', bootstrapVoidResp.status === 200, bootstrapVoidResp.body);
      // 已作废但仍留在机柜里（直接插 it_asset_record_controls，不经过 void 接口，绕开 detached() 前置检查）。
      const voidedButRacked = (await f.api('POST', '', { category: 'server', name: room + '-作废但仍在柜', u_height: 1, placement: { kind: 'rack', rack_id: rack.id, u_start: 3 } })).body;
      await f.run("INSERT INTO it_asset_record_controls(asset_id,state,reason,operator_id,created_at) VALUES(?,?,?,?,?)", [voidedButRacked.id, 'voided', 'M3c直接构造(绕开detached前置检查)', 1, new Date().toISOString()]);
      // 非 in_service 但仍留在机柜里（直接 SQL 改 status，不经过 rack_out——rack_out 会清 rack_id）。
      const nonServiceButRacked = (await f.api('POST', '', { category: 'server', name: room + '-非在用但仍在柜', u_height: 1, placement: { kind: 'rack', rack_id: rack.id, u_start: 5 } })).body;
      await f.run("UPDATE it_assets SET status='faulty' WHERE id=?", [nonServiceButRacked.id]);
      const created = await createSheet(2, room);
      check('M3c建单201', created.status === 201, created.body);
      const deviceIds = created.body.scope.devices.map((d) => d.id);
      check('M3c范围只含在用设备(排除作废/库房/非在用/别的机房)', deviceIds.includes(active.id) && !deviceIds.includes(depot.id) && !deviceIds.includes(voidedButRacked.id) && !deviceIds.includes(nonServiceButRacked.id) && !deviceIds.includes(otherRoomDevice.id), deviceIds);
      const deviceItemTargets = created.body.items.filter((it) => it.section === 'device').map((it) => it.target_id);
      check('M3c检查项device段target与scope一致(仅在用设备)', JSON.stringify(deviceItemTargets.sort((a, b) => a - b)) === JSON.stringify([active.id]), deviceItemTargets);
    }

    // ============================================================
    // M3d：actions 数组在列表与详情里对各角色各状态的全等值
    // ============================================================
    {
      // C2：submitted 态巡检人/管理员有 save 动作（方案 §5.3
      // 保存修改）——不是放宽，是既定行为变化。
      const expectActions = {
        // C3b L6：草稿态给 manager(巡检人/管理员) 多一个 collect（一键采集，方案 §5.4/§5.2）——
        // 与 save/submit/delete 同一批判据，不是放宽。
        draft: { 2: ['save', 'submit', 'delete', 'collect'], 1: ['save', 'submit', 'delete', 'collect'], 5: [], 3: [] },
        submitted: { 2: ['save', 'delete'], 1: ['save', 'delete', 'archive'], 5: [], 3: [] },
        archived: { 2: [], 1: ['unarchive'], 5: [], 3: [] },
        deleted: { 2: [], 1: ['restore'], 5: [], 3: [] },
      };
      const fixturesByState = { draft: mDraft, submitted: mSubmitted, archived: mArchivedPre, deleted: mDeletedPre };
      for (const [stateName, sheetRef] of Object.entries(fixturesByState)) {
        for (const uid of [2, 1, 5, 3]) {
          // deleted 状态的单不出现在常规列表（WHERE deleted_at IS NULL），只有 GET /deleted（管理员）能看到。
          const listResp = stateName === 'deleted'
            ? await f.api('GET', '/inspections/sheets/deleted', undefined, uid)
            : await f.api('GET', '/inspections/sheets?room=' + encodeURIComponent(sheetRef.room_name), undefined, uid);
          if (stateName === 'deleted' && uid !== 1) {
            check(`M3d ${stateName} uid${uid} 非管理员无权访问/deleted:403`, listResp.status === 403);
            continue;
          }
          check(`M3d ${stateName} uid${uid} list请求200`, listResp.status === 200, listResp.body);
          const row = listResp.body.items.find((x) => x.id === sheetRef.id);
          // H1：目标行必须先存在——找不到就是失败，不能把"没找到"悄悄折叠成空 actions 再比对通过。
          check(`H1 M3d ${stateName} uid${uid} 列表中目标行存在`, !!row, { ids: listResp.body.items.map((x) => x.id), wantId: sheetRef.id });
          const rowActions = row.actions;
          check(`M3d ${stateName} uid${uid} 列表actions全等`, JSON.stringify((rowActions || []).slice().sort()) === JSON.stringify(expectActions[stateName][uid].slice().sort()), { got: rowActions, want: expectActions[stateName][uid] });
        }
      }
      // 详情里的 actions：admin 对四个状态都是 full 可见；owner(uid2) 对 draft/submitted/archived 可见（deleted 404）。
      for (const stateName of ['draft', 'submitted', 'archived', 'deleted']) {
        const sheetRef = fixturesByState[stateName];
        const adminDetail = await f.api('GET', '/inspections/sheets/' + sheetRef.id, undefined, 1);
        check(`M3d ${stateName} 管理员详情actions全等`, adminDetail.status === 200 && JSON.stringify(adminDetail.body.actions.slice().sort()) === JSON.stringify(expectActions[stateName][1].slice().sort()), adminDetail.body);
        if (stateName !== 'deleted') {
          const ownerDetail = await f.api('GET', '/inspections/sheets/' + sheetRef.id, undefined, 2);
          check(`M3d ${stateName} 巡检人详情actions全等`, ownerDetail.status === 200 && JSON.stringify(ownerDetail.body.actions.slice().sort()) === JSON.stringify(expectActions[stateName][2].slice().sort()), ownerDetail.body);
        }
      }
    }

    // ============================================================
    // M3e：GET /stats 四个数字的全等值（用增量比对，避免与前面测试遗留的数据冲突）
    // ============================================================
    {
      const before = (await f.api('GET', '/inspections/sheets/stats', undefined, 1)).body;
      const thisMonthNormal = await buildSubmittedSheet('M3e-ThisMonthNormal', 2);
      const thisMonthAbnormalDraft = await buildDraftSheet('M3e-ThisMonthAbnormal', 2);
      const detailA = await getSheet(thisMonthAbnormalDraft.id, 2);
      const doorA = detailA.body.items.find((it) => it.item_key === 'door');
      const fillA = fillPayloadAllOk(detailA.body.items).map((it) => (it.id === doorA.id ? { ...it, result: 'bad', note: 'M3e测试异常' } : it));
      const putA = await f.api('PUT', '/inspections/sheets/' + thisMonthAbnormalDraft.id, { expected_version: thisMonthAbnormalDraft.version, items: fillA }, 2);
      check('M3e本月异常单保存200', putA.status === 200, putA.body);
      await uploadAllRackFrontPhotos(f, thisMonthAbnormalDraft.id, thisMonthAbnormalDraft.scope, 2);
      const doorAPhotoUpload = await uploadPhoto(f, thisMonthAbnormalDraft.id, 'item', doorA.id, 2);
      check('C2d T2-补 M3e异常项照片201', doorAPhotoUpload.status === 201, doorAPhotoUpload.body);
      const submitA = await f.api('POST', '/inspections/sheets/' + thisMonthAbnormalDraft.id + '/submit', { expected_version: putA.body.version }, 2);
      check('M3e本月异常单提交200', submitA.status === 200, submitA.body);

      const notThisMonth = await buildSubmittedSheet('M3e-NotThisMonth', 2);
      await f.run("UPDATE it_inspection_sheets SET submitted_at='2020-01-01T00:00:00.000Z' WHERE id=?", [notThisMonth.id]);

      const extraDraft = await buildDraftSheet('M3e-ExtraDraft', 2);
      const extraPendingArchive = await buildSubmittedSheet('M3e-ExtraPendingArchive', 2);

      const after = (await f.api('GET', '/inspections/sheets/stats', undefined, 1)).body;
      check('M3e本月已提交恰好+3(不含被回填到上月的那张)', after.submitted_month === before.submitted_month + 3, { before, after });
      check('M3e本月有异常恰好+1', after.abnormal_month === before.abnormal_month + 1, { before, after });
      check('M3e草稿数恰好+1(只剩extraDraft，异常单已提交离开草稿)', after.drafts === before.drafts + 1, { before, after });
      check('M3e待归档恰好+4(含被回填到上月的那张——待归档不看月份)', after.pending_archive === before.pending_archive + 4, { before, after });
    }

    // ============================================================
    // M4：正向格子——管理员对他人草稿保存/提交/删除成功并重读落库；管理员逻辑删除他人已提交单
    // 成功；只读与其他写权限者查看 submitted/archived 详情200且为完整字段。
    // ============================================================
    {
      const m4draft = await buildDraftSheet('M4-AdminAsManager', 2);
      const detail = await getSheet(m4draft.id, 1);
      const fill = fillPayloadAllOk(detail.body.items);
      const adminSave = await f.api('PUT', '/inspections/sheets/' + m4draft.id, { expected_version: m4draft.version, items: fill, remark: '管理员代填' }, 1);
      check('M4管理员对他人草稿保存成功', adminSave.status === 200 && adminSave.body.remark === '管理员代填', adminSave.body);
      const rowAfterSave = (await f.all('SELECT remark,version FROM it_inspection_sheets WHERE id=?', [m4draft.id]))[0];
      check('M4管理员保存落库确认', rowAfterSave.remark === '管理员代填' && rowAfterSave.version === adminSave.body.version);
      await uploadAllRackFrontPhotos(f, m4draft.id, m4draft.scope, 1);
      const adminSubmit = await f.api('POST', '/inspections/sheets/' + m4draft.id + '/submit', { expected_version: adminSave.body.version }, 1);
      check('M4管理员对他人草稿提交成功', adminSubmit.status === 200 && adminSubmit.body.status === 'submitted', adminSubmit.body);
      const adminDelete = await f.api('DELETE', '/inspections/sheets/' + m4draft.id, { expected_version: adminSubmit.body.version, reason: '管理员测试删除' }, 1);
      check('M4管理员逻辑删除他人已提交单成功', adminDelete.status === 200 && !!adminDelete.body.deleted_at, adminDelete.body);
      const rowAfterDelete = (await f.all('SELECT deleted_by,delete_reason FROM it_inspection_sheets WHERE id=?', [m4draft.id]))[0];
      check('M4管理员删除落库确认', rowAfterDelete.deleted_by === 1 && rowAfterDelete.delete_reason === '管理员测试删除');

      const m4submitted = await buildSubmittedSheet('M4-ViewSubmitted', 2);
      const m4archivedPre = await buildSubmittedSheet('M4-ViewArchived', 2);
      const m4archive = await f.api('POST', '/inspections/sheets/archive', { items: [{ id: m4archivedPre.id, expected_version: m4archivedPre.version }] }, 1);
      check('M4辅助单归档200', m4archive.status === 200, m4archive.body);
      for (const uid of [3, 5]) {
        const label = uid === 3 ? '只读' : '其他写权限者';
        const vSub = await f.api('GET', '/inspections/sheets/' + m4submitted.id, undefined, uid);
        check(`M4${label}查看submitted详情200完整字段`, vSub.status === 200 && Array.isArray(vSub.body.items) && vSub.body.items.length === 13 && Array.isArray(vSub.body.log), vSub.body);
        const vArch = await f.api('GET', '/inspections/sheets/' + m4archivedPre.id, undefined, uid);
        check(`M4${label}查看archived详情200完整字段`, vArch.status === 200 && Array.isArray(vArch.body.items) && vArch.body.items.length === 13 && Array.isArray(vArch.body.log), vArch.body);
      }
    }

    // ============================================================
    // M7：钉死时刻的「本月」测试——submitted_at 写为本地时间本月1日00:30对应的UTC时刻（落在UTC
    // 上个月的日期，若用纯UTC比较会被误判为上月），断言仍计入本月。
    // ============================================================
    {
      // 35T-R M3：本用例不冻结时钟——接口统计与期望值 SQL 各自读取当时的 'now'，不是同一个冻结
      // 时刻；用例开始与结束各用 SQLite strftime('%Y-%m','now','localtime') 取一次本地年月，两者
      // 不同就说明运行期间跨月，直接让测试失败提示重跑，而不是产出一个偶发的假失败。
      // 35T-R2：跨月时不能让四条统计相关断言各自因为时间变化先炸出假失败，把「跨月请重跑」这条
      // 挤到最后才看到——本轮改为：先把数据（premise/baseline/afterM7/期望值/afterControl）全部
      // 取完，不提前断言；取完立刻读 ymAtEnd 做跨月判定；跨月则只报一条「运行期间跨月，请重跑」
      // 并跳过下面四条统计断言（check() 失败即抛出，天然跳过）；未跨月才逐条断言（含前提校验）。
      const ymAtStart = (await f.all("SELECT strftime('%Y-%m','now','localtime') AS ym"))[0].ym;
      const tzOffsetMin = new Date().getTimezoneOffset(); // 分钟，UTC-本地；中国为 -480
      const now = new Date();
      // 本地时间本月1日00:30对应的真实UTC时刻——当本地时区早于UTC（中国UTC+8）时这一刻落在UTC上个
      // 月，若统计口径用纯UTC比较会误判为上月不计入；断言必须钉死这个边界时刻，不能靠"今天"凑巧。
      const localMonthStartUtcMs = Date.UTC(now.getFullYear(), now.getMonth(), 1, 0, 30, 0) + tzOffsetMin * 60000;
      const submittedAt = new Date(localMonthStartUtcMs).toISOString();
      // 不能只信 JS 算出来的 tzOffsetMin，要用 SQLite 自己的 strftime(...,'localtime') 校验这个
      // 时刻确实"本地=本月、UTC≠本地月"——先取数，断言挪到跨月判定之后统一做。
      const premise = (await f.all("SELECT strftime('%Y-%m',?,'localtime') AS local_ym, strftime('%Y-%m',?) AS utc_ym, strftime('%Y-%m','now','localtime') AS cur_local_ym", [submittedAt, submittedAt]))[0];
      const baseline = (await f.api('GET', '/inspections/sheets/stats', undefined, 1)).body;
      const m7 = await buildSubmittedSheet('M7-LocalMonthBoundary', 2);
      await f.run('UPDATE it_inspection_sheets SET submitted_at=? WHERE id=?', [submittedAt, m7.id]);
      const afterM7 = (await f.api('GET', '/inspections/sheets/stats', undefined, 1)).body;
      // 用独立 SQL 在此刻重新计算期望值（不是复用同一个冻结时刻），与增量断言互为印证（不是只信
      // delta）；用例整体是否跨月由块首尾两次 strftime('now','localtime') 校验，不是靠这里"冻结"。
      const expSubmittedMonthM7 = (await f.all("SELECT COUNT(*) n FROM it_inspection_sheets WHERE status IN ('submitted','archived') AND deleted_at IS NULL AND submitted_at IS NOT NULL AND strftime('%Y-%m',submitted_at,'localtime')=strftime('%Y-%m','now','localtime')"))[0].n;
      // 对照单：真实当前时刻提交，验证增量口径本身是可靠的（不是巧合出现+1）。
      const control = await buildSubmittedSheet('M7-Control', 2);
      const afterControl = (await f.api('GET', '/inspections/sheets/stats', undefined, 1)).body;
      void control;
      const ymAtEnd = (await f.all("SELECT strftime('%Y-%m','now','localtime') AS ym"))[0].ym;
      if (ymAtEnd !== ymAtStart) {
        check('M用例期间本地年月未变(35T-R2:跨月只报这一条,不连带炸出下面四条统计断言)', false, { ymAtStart, ymAtEnd });
      } else {
        check('M月初边界前提成立(SQLite自身strftime校验:该时刻本地=本月且UTC≠本地月)', premise.local_ym === premise.cur_local_ym && premise.utc_ym !== premise.local_ym, { premise, submittedAt, tzOffsetMin });
        check('M7本地时间月初边界时刻计入本月', afterM7.submitted_month === baseline.submitted_month + 1, { baseline, afterM7, submittedAt, tzOffsetMin });
        check('M月初边界统计与独立SQL期望值全等(非仅增量)', afterM7.submitted_month === expSubmittedMonthM7, { afterM7, expSubmittedMonthM7 });
        check('M7对照单(真实当前时刻)也计入本月', afterControl.submitted_month === afterM7.submitted_month + 1, { afterM7, afterControl });
      }
    }

    // ============================================================
    // C1c(a)：草稿 PUT 空更新（items:[]，不带 remark）→ 200，version 与 updated_at 都不变（L5 后半）
    // ============================================================
    {
      const noop = await buildDraftSheet('C1c-NoopPut', 2);
      const before = (await f.all('SELECT version,updated_at FROM it_inspection_sheets WHERE id=?', [noop.id]))[0];
      const resp = await f.api('PUT', '/inspections/sheets/' + noop.id, { expected_version: noop.version, items: [] }, 2);
      check('C1c(a)草稿空更新200', resp.status === 200 && resp.body.version === noop.version, resp.body);
      const after = (await f.all('SELECT version,updated_at FROM it_inspection_sheets WHERE id=?', [noop.id]))[0];
      check('C1c(a)草稿空更新version不变', after.version === before.version, { before, after });
      check('C1c(a)草稿空更新updated_at不变', after.updated_at === before.updated_at, { before, after });
    }

    // ============================================================
    // C1c(b)：GET / 的 room/status 若被 Express 解析成数组（同名参数重复）→ 400 LEDGER_BAD_REQUEST（L7）
    // ============================================================
    {
      const roomArrayResp = await f.api('GET', '/inspections/sheets?room=a&room=b');
      check('C1c(b)room为数组400 LEDGER_BAD_REQUEST', roomArrayResp.status === 400 && roomArrayResp.body.code === 'LEDGER_BAD_REQUEST', roomArrayResp.body);
      const statusArrayResp = await f.api('GET', '/inspections/sheets?status=draft&status=submitted');
      check('C1c(b)status为数组400 LEDGER_BAD_REQUEST', statusArrayResp.status === 400 && statusArrayResp.body.code === 'LEDGER_BAD_REQUEST', statusArrayResp.body);
    }

    // ============================================================
    // H2：判定顺序——版本冲突不能抢在归属/已删除/状态判定之前暴露信息（codex 35T HIGH）
    // ============================================================
    {
      // a) 其他写权限者(uid5)对他人草稿(mDraft)用明显错误的版本 → 403 SHEET_FORBIDDEN，不是409版本冲突。
      const vDraft = await currentVersion(mDraft.id);
      const wrongDraft = vDraft + 999;
      const h2a1 = await f.api('PUT', '/inspections/sheets/' + mDraft.id, { expected_version: wrongDraft, items: [], remark: null }, 5);
      check('H2其他写权限者对他人草稿错误版本保存403 SHEET_FORBIDDEN(不是409)', h2a1.status === 403 && h2a1.body.code === 'SHEET_FORBIDDEN', h2a1.body);
      const h2a2 = await f.api('POST', '/inspections/sheets/' + mDraft.id + '/submit', { expected_version: wrongDraft }, 5);
      check('H2其他写权限者对他人草稿错误版本提交403 SHEET_FORBIDDEN(不是409)', h2a2.status === 403 && h2a2.body.code === 'SHEET_FORBIDDEN', h2a2.body);
      const h2a3 = await f.api('DELETE', '/inspections/sheets/' + mDraft.id, { expected_version: wrongDraft }, 5);
      check('H2其他写权限者对他人草稿错误版本删除403 SHEET_FORBIDDEN(不是409)', h2a3.status === 403 && h2a3.body.code === 'SHEET_FORBIDDEN', h2a3.body);
      check('H2草稿未被上面错误版本探测改动', (await currentVersion(mDraft.id)) === vDraft);

      // b) 其他写权限者(uid5)对他人已提交单(mSubmitted)用错误版本 → 403 SHEET_FORBIDDEN。
      const vSub = await currentVersion(mSubmitted.id);
      const wrongSub = vSub + 999;
      const h2b1 = await f.api('PUT', '/inspections/sheets/' + mSubmitted.id, { expected_version: wrongSub, items: [], remark: null }, 5);
      check('H2其他写权限者对他人已提交单错误版本保存403 SHEET_FORBIDDEN(不是409)', h2b1.status === 403 && h2b1.body.code === 'SHEET_FORBIDDEN', h2b1.body);
      const h2b2 = await f.api('POST', '/inspections/sheets/' + mSubmitted.id + '/submit', { expected_version: wrongSub }, 5);
      check('H2其他写权限者对他人已提交单错误版本提交403 SHEET_FORBIDDEN(不是409)', h2b2.status === 403 && h2b2.body.code === 'SHEET_FORBIDDEN', h2b2.body);
      const h2b3 = await f.api('DELETE', '/inspections/sheets/' + mSubmitted.id, { expected_version: wrongSub, reason: 'x' }, 5);
      check('H2其他写权限者对他人已提交单错误版本删除403 SHEET_FORBIDDEN(不是409)', h2b3.status === 403 && h2b3.body.code === 'SHEET_FORBIDDEN', h2b3.body);
      check('H2已提交单未被上面错误版本探测改动', (await currentVersion(mSubmitted.id)) === vSub);

      // c) 巡检人(uid2,本人)对自己已删除的单(mDeletedId)用错误版本 → 404 SHEET_NOT_FOUND(可见性先于版本)。
      const vDel = await currentVersion(mDeletedId);
      const wrongDel = vDel + 999;
      const h2c1 = await f.api('PUT', '/inspections/sheets/' + mDeletedId, { expected_version: wrongDel, items: [], remark: null }, 2);
      check('H2巡检人对自己已删除单错误版本保存404 SHEET_NOT_FOUND', h2c1.status === 404 && h2c1.body.code === 'SHEET_NOT_FOUND', h2c1.body);
      const h2c2 = await f.api('POST', '/inspections/sheets/' + mDeletedId + '/submit', { expected_version: wrongDel }, 2);
      check('H2巡检人对自己已删除单错误版本提交404 SHEET_NOT_FOUND', h2c2.status === 404 && h2c2.body.code === 'SHEET_NOT_FOUND', h2c2.body);
      const h2c3 = await f.api('DELETE', '/inspections/sheets/' + mDeletedId, { expected_version: wrongDel, reason: 'x' }, 2);
      check('H2巡检人对自己已删除单错误版本删除404 SHEET_NOT_FOUND', h2c3.status === 404 && h2c3.body.code === 'SHEET_NOT_FOUND', h2c3.body);
      check('H2已删除单未被上面错误版本探测改动', (await currentVersion(mDeletedId)) === vDel);

      // d) 管理员对已归档单(mArchivedId)用错误版本删除 → 409 SHEET_STATE（状态先于版本）。
      const vArch = await currentVersion(mArchivedId);
      const wrongArch = vArch + 999;
      const h2d1 = await f.api('DELETE', '/inspections/sheets/' + mArchivedId, { expected_version: wrongArch, reason: 'x' }, 1);
      check('H2管理员对已归档单错误版本删除409 SHEET_STATE(状态先于版本,不是VERSION_CONFLICT)', h2d1.status === 409 && h2d1.body.code === 'SHEET_STATE', h2d1.body);
      check('H2已归档单未被上面错误版本探测改动', (await currentVersion(mArchivedId)) === vArch);
    }

    // ============================================================
    // H3：正向格子——管理员物理删除他人草稿；其他写权限者(uid5)成功建单（codex 35T HIGH）
    // ============================================================
    {
      const h3draft = await buildDraftSheet('H3-AdminDeleteDraft', 2);
      const h3del = await f.api('DELETE', '/inspections/sheets/' + h3draft.id, { expected_version: h3draft.version }, 1);
      check('H3管理员物理删除他人草稿200', h3del.status === 200 && h3del.body.ok === true, h3del.body);
      const h3rowsSheet = await f.all('SELECT * FROM it_inspection_sheets WHERE id=?', [h3draft.id]);
      check('H3管理员删除他人草稿后单不存在(重读)', h3rowsSheet.length === 0);
      const h3rowsItems = await f.all('SELECT * FROM it_inspection_sheet_items WHERE sheet_id=?', [h3draft.id]);
      check('H3管理员删除他人草稿后检查项不存在(重读)', h3rowsItems.length === 0);
      const h3rowsLog = await f.all('SELECT * FROM it_inspection_sheet_log WHERE sheet_id=?', [h3draft.id]);
      check('H3管理员删除他人草稿后日志不存在(重读)', h3rowsLog.length === 0);

      await makeRoom('H3-Uid5Create');
      const h3create = await createSheet(5, 'H3-Uid5Create');
      check('H3其他写权限者(uid5)建单201且created_by=5(重读响应体)', h3create.status === 201 && h3create.body.created_by === 5, h3create.body);
      const h3ItemCount = (await f.all('SELECT COUNT(*) n FROM it_inspection_sheet_items WHERE sheet_id=?', [h3create.body.id]))[0].n;
      check('H3其他写权限者建单检查项行数为13(重读)', h3ItemCount === 13, h3ItemCount);
      const h3LogRows = await f.all("SELECT * FROM it_inspection_sheet_log WHERE sheet_id=? AND action='create'", [h3create.body.id]);
      check('H3其他写权限者建单create日志actor_id=5(重读)', h3LogRows.length === 1 && h3LogRows[0].actor_id === 5, h3LogRows);
    }

    // ============================================================
    // H4：统计口径——两异常项的单只让abnormal_month+1；本月提交后归档仍计入submitted_month
    // （codex 35T HIGH）。用全新独立 fixture + 独立 SQL 算期望值，不用前后增量，避免跨月/共享态污染。
    // ============================================================
    {
      const freshH4 = await createFixture();
      try {
        // 35T-R M2：独立 fixture 不继承主 fixture 状态——建单前先确认五表都不存在；夹具默认已给
        // 2 号写权限（it-ledger-browser-fixture.js:56，未传 dbCopyPath 时），不需要额外插 ACL，
        // 但每次建单都要显式断言201（不能只信"没抛异常"）。
        const TABLE_IN_LIST_H4 = "('it_inspection_sheets','it_inspection_sheet_items','it_inspection_sheet_photos','it_inspection_sheet_log','it_inspection_file_cleanup')";
        const t0H4 = await freshH4.all(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ${TABLE_IN_LIST_H4}`);
        check('H4独立夹具建单前巡检单相关五表均不存在(不继承主夹具状态,35T-R M2)', t0H4.length === 0, t0H4);
        await freshH4.api('POST', '/racks', { name: 'H4柜1', room: 'H4Room', u_total: 20 });
        const h4a = await freshH4.api('POST', '/inspections/sheets', { room_name: 'H4Room' }, 2);
        check('H4两异常项单建单201', h4a.status === 201, h4a.body);
        const h4aDetail = await freshH4.api('GET', '/inspections/sheets/' + h4a.body.id, undefined, 2);
        const h4aFill = fillPayloadAllOk(h4aDetail.body.items).map((it) => {
          const orig = h4aDetail.body.items.find((x) => x.id === it.id);
          return (orig.item_key === 'aircon' || orig.item_key === 'ups') ? { ...it, result: 'bad', note: 'H4两处异常' } : it;
        });
        const h4aPut = await freshH4.api('PUT', '/inspections/sheets/' + h4a.body.id, { expected_version: h4a.body.version, items: h4aFill }, 2);
        check('H4两异常项单保存200', h4aPut.status === 200, h4aPut.body);
        await uploadAllRackFrontPhotos(freshH4, h4a.body.id, h4a.body.scope, 2);
        const h4aAircon = h4aDetail.body.items.find((it) => it.item_key === 'aircon');
        const h4aUps = h4aDetail.body.items.find((it) => it.item_key === 'ups');
        const h4aAirconUpload = await uploadPhoto(freshH4, h4a.body.id, 'item', h4aAircon.id, 2);
        check('C2d T2-补 H4 aircon照片201', h4aAirconUpload.status === 201, h4aAirconUpload.body);
        const h4aUpsUpload = await uploadPhoto(freshH4, h4a.body.id, 'item', h4aUps.id, 2);
        check('C2d T2-补 H4 ups照片201', h4aUpsUpload.status === 201, h4aUpsUpload.body);
        const h4aSubmit = await freshH4.api('POST', '/inspections/sheets/' + h4a.body.id + '/submit', { expected_version: h4aPut.body.version }, 2);
        check('H4两异常项单提交200', h4aSubmit.status === 200, h4aSubmit.body);

        await freshH4.api('POST', '/racks', { name: 'H4柜2', room: 'H4Room2', u_total: 20 });
        const h4b = await freshH4.api('POST', '/inspections/sheets', { room_name: 'H4Room2' }, 2);
        check('H4正常单建单201(35T-R M2)', h4b.status === 201, h4b.body);
        const h4bDetail = await freshH4.api('GET', '/inspections/sheets/' + h4b.body.id, undefined, 2);
        const h4bPut = await freshH4.api('PUT', '/inspections/sheets/' + h4b.body.id, { expected_version: h4b.body.version, items: fillPayloadAllOk(h4bDetail.body.items) }, 2);
        await uploadAllRackFrontPhotos(freshH4, h4b.body.id, h4b.body.scope, 2);
        const h4bSubmit = await freshH4.api('POST', '/inspections/sheets/' + h4b.body.id + '/submit', { expected_version: h4bPut.body.version }, 2);
        check('H4正常单提交200', h4bSubmit.status === 200, h4bSubmit.body);
        const h4bArchive = await freshH4.api('POST', '/inspections/sheets/archive', { items: [{ id: h4b.body.id, expected_version: h4bSubmit.body.version }] }, 1);
        check('H4正常单归档200(本月提交后归档，验证submitted_month仍计入)', h4bArchive.status === 200, h4bArchive.body);

        const expSubmittedMonth = (await freshH4.all("SELECT COUNT(*) n FROM it_inspection_sheets WHERE status IN ('submitted','archived') AND deleted_at IS NULL AND submitted_at IS NOT NULL AND strftime('%Y-%m',submitted_at,'localtime')=strftime('%Y-%m','now','localtime')"))[0].n;
        const expAbnormalRows = await freshH4.all("SELECT s.id FROM it_inspection_sheets s WHERE s.status IN ('submitted','archived') AND s.deleted_at IS NULL AND s.submitted_at IS NOT NULL AND strftime('%Y-%m',s.submitted_at,'localtime')=strftime('%Y-%m','now','localtime') AND EXISTS (SELECT 1 FROM it_inspection_sheet_items i WHERE i.sheet_id=s.id AND i.result='bad')");
        const expDrafts = (await freshH4.all("SELECT COUNT(*) n FROM it_inspection_sheets WHERE status='draft'"))[0].n;
        const expPendingArchive = (await freshH4.all("SELECT COUNT(*) n FROM it_inspection_sheets WHERE status='submitted' AND deleted_at IS NULL"))[0].n;
        const statsH4 = (await freshH4.api('GET', '/inspections/sheets/stats', undefined, 1)).body;
        check('H4统计submitted_month=2且与独立SQL期望值全等(含归档单)', statsH4.submitted_month === 2 && statsH4.submitted_month === expSubmittedMonth, { statsH4, expSubmittedMonth });
        check('H4统计abnormal_month=1且与独立SQL期望值全等(两异常项只记一张单，不是数异常项数)', statsH4.abnormal_month === 1 && statsH4.abnormal_month === expAbnormalRows.length, { statsH4, expAbnormalCount: expAbnormalRows.length });
        check('H4统计drafts/pending_archive与独立SQL期望值全等', statsH4.drafts === expDrafts && statsH4.pending_archive === expPendingArchive, { statsH4, expDrafts, expPendingArchive });
      } finally {
        await freshH4.close();
      }
    }

    // ============================================================
    // H5：完整性——纯空格异常说明仍算"缺说明"；直接写库越界数值不算已填(详情/提交/列表三处口径一致，
    // 后者覆盖 35S 的 listRow 补 item_key 修复)。（codex 35T HIGH）
    // ============================================================
    {
      const h5a = await buildDraftSheet('H5-WhitespaceNote', 2);
      const h5aDetail = await getSheet(h5a.id, 2);
      const h5aDoor = h5aDetail.body.items.find((it) => it.item_key === 'door');
      const h5aFill = fillPayloadAllOk(h5aDetail.body.items).map((it) => (it.id === h5aDoor.id ? { ...it, result: 'bad', note: '   ' } : it));
      const h5aPut = await f.api('PUT', '/inspections/sheets/' + h5a.id, { expected_version: h5a.version, items: h5aFill }, 2);
      check('H5纯空格说明PUT层可保存200(PUT层不拒绝空格，留给提交校验拦)', h5aPut.status === 200, h5aPut.body);
      const h5aSubmit = await f.api('POST', '/inspections/sheets/' + h5a.id + '/submit', { expected_version: h5aPut.body.version }, 2);
      check('H5纯空格异常说明提交400 SHEET_INCOMPLETE(trim后判定为空)', h5aSubmit.status === 400 && h5aSubmit.body.code === 'SHEET_INCOMPLETE', h5aSubmit.body);
      check('H5缺说明清单含该异常项', h5aSubmit.body.detail.missing_note_item_ids.includes(h5aDoor.id), h5aSubmit.body.detail);

      // H5a2：C2c L1 把 validateItemPatch(PUT 与 saveSubmittedEdit 两条写路径共用)里的纯空白说明提前
      // normalize 成 null，H5a 上面那条用例的"note 是非空但全空白字符串"这条路径，经这条写路径已经
      // 走不到 sheetProgress 自己的 note.trim() 分支了(它在 validateItemPatch 之后才拿到 note，届时
      // 已经是 null，与 null 走同一条 !it.note 短路判断，观察不到 trim() 是否还在)。sheetProgress 的
      // trim() 判断本身仍是独立的防御层(万一未来有别的写路径不经 validateItemPatch)，直接写库绕开
      // validateItemPatch 构造"接口不可达但库里确实存在"的纯空格说明，验证该防御层没有被一并删掉
      // （做法同 H5b 用直接 SQL 绕开 PUT 层数值范围校验的先例）。
      const h5a2 = await buildDraftSheet('H5a2-DirectSqlWhitespaceNote', 2);
      const h5a2Detail = await getSheet(h5a2.id, 2);
      const h5a2Door = h5a2Detail.body.items.find((it) => it.item_key === 'door');
      const h5a2FillNormal = fillPayloadAllOk(h5a2Detail.body.items).map((it) => (it.id === h5a2Door.id ? { ...it, result: 'bad', note: '正常说明占位' } : it));
      const h5a2Put = await f.api('PUT', '/inspections/sheets/' + h5a2.id, { expected_version: h5a2.version, items: h5a2FillNormal }, 2);
      check('H5a2先用正常说明填完12+1项(为后续直接写库替换做准备)200', h5a2Put.status === 200, h5a2Put.body);
      await f.run("UPDATE it_inspection_sheet_items SET note='   ' WHERE id=?", [h5a2Door.id]);
      const h5a2Detail2 = await getSheet(h5a2.id, 2);
      check('H5a2直接写库的纯空格说明detail.progress仍判missing_note(sheetProgress自身trim()防御独立生效，不依赖validateItemPatch)', h5a2Detail2.body.progress.missing.missingNoteItemIds.includes(h5a2Door.id), h5a2Detail2.body.progress.missing);
      const h5a2Submit = await f.api('POST', '/inspections/sheets/' + h5a2.id + '/submit', { expected_version: h5a2Put.body.version }, 2);
      check('H5a2直接写库的纯空格说明提交400 SHEET_INCOMPLETE(sheetProgress自身trim()防御独立生效)', h5a2Submit.status === 400 && h5a2Submit.body.code === 'SHEET_INCOMPLETE' && h5a2Submit.body.detail.missing_note_item_ids.includes(h5a2Door.id), h5a2Submit.body);

      const h5b = await buildDraftSheet('H5-OutOfRangeTemp', 2);
      const h5bDetail = await getSheet(h5b.id, 2);
      const h5bTemp = h5bDetail.body.items.find((it) => it.item_key === 'temperature');
      // 先把其余12项正常填完（正常PUT，受范围校验），只对温度项之后用直接SQL写入越界值（绕开PUT的
      // validateItemAgainstTarget），这样"越界数值不算已填"才是唯一变量，不与"其余项本来就没填"混淆。
      const h5bFillNormal = fillPayloadAllOk(h5bDetail.body.items);
      const h5bPutNormal = await f.api('PUT', '/inspections/sheets/' + h5b.id, { expected_version: h5b.version, items: h5bFillNormal }, 2);
      check('H5越界温度用例-先正常填完12+1项200', h5bPutNormal.status === 200, h5bPutNormal.body);
      await f.run('UPDATE it_inspection_sheet_items SET number_value=999 WHERE id=?', [h5bTemp.id]);
      const h5bDetail2 = await getSheet(h5b.id, 2);
      check('H5越界温度详情progress.filled不计入该项(其余12项都已正常填完)', h5bDetail2.body.progress.filled === h5bDetail2.body.progress.total - 1, h5bDetail2.body.progress);
      check('H5越界温度详情unfilled清单恰为该项', JSON.stringify(h5bDetail2.body.progress.missing.unfilledItemIds) === JSON.stringify([h5bTemp.id]), h5bDetail2.body.progress.missing);
      const h5bSubmit = await f.api('POST', '/inspections/sheets/' + h5b.id + '/submit', { expected_version: h5bPutNormal.body.version }, 2);
      check('H5越界温度提交400 SHEET_INCOMPLETE且清单含该项', h5bSubmit.status === 400 && h5bSubmit.body.code === 'SHEET_INCOMPLETE' && h5bSubmit.body.detail.unfilled_item_ids.includes(h5bTemp.id), h5bSubmit.body);
      const h5bList = await f.api('GET', '/inspections/sheets?room=H5-OutOfRangeTemp', undefined, 2);
      const h5bRow = h5bList.body.items.find((x) => x.id === h5b.id);
      check('H5越界温度列表中目标行存在', !!h5bRow, h5bList.body);
      check('H5越界温度列表filled也不计入该项(覆盖35S:listRow查询须带item_key)', h5bRow.filled === h5bDetail2.body.progress.total - 1, h5bRow);
    }

    // ============================================================
    // H6：恢复版本——重读恰好+1；用恢复前版本发后续合法操作要409（codex 35T HIGH）
    // ============================================================
    {
      const h6base = await buildSubmittedSheet('H6-Restore', 2);
      const h6del = await f.api('DELETE', '/inspections/sheets/' + h6base.id, { expected_version: h6base.version, reason: 'H6测试删除' }, 2);
      check('H6删除200', h6del.status === 200, h6del.body);
      const versionBeforeRestore = h6del.body.version;
      const h6restore = await f.api('POST', '/inspections/sheets/' + h6base.id + '/restore', { expected_version: versionBeforeRestore }, 1);
      check('H6恢复200', h6restore.status === 200, h6restore.body);
      check('H6恢复后重读版本恰好+1', h6restore.body.version === versionBeforeRestore + 1, { versionBeforeRestore, got: h6restore.body.version });
      const h6row = (await f.all('SELECT version FROM it_inspection_sheets WHERE id=?', [h6base.id]))[0];
      check('H6恢复落库版本恰好+1', h6row.version === versionBeforeRestore + 1, h6row);
      const h6stale = await f.api('DELETE', '/inspections/sheets/' + h6base.id, { expected_version: versionBeforeRestore, reason: 'x' }, 2);
      check('H6用恢复前版本发后续操作409 SHEET_VERSION_CONFLICT', h6stale.status === 409 && h6stale.body.code === 'SHEET_VERSION_CONFLICT', h6stale.body);
    }

    // ============================================================
    // H7：日志逐次核对——create/submit/archive/unarchive/delete/restore 各恰好新增1行，actor_id为
    // 实际操作人(不是建单人)、at/op_id非空、action/reason正确（codex 35T HIGH）。
    // 35T-R H7 收紧：只查非空测不出「at 写成固定/错误时间」——补两层：① at 与单据对应的时间列
    // 逐动作核对全等（create→created_at，submit→submitted_at，archive→archived_at，
    // delete→deleted_at；unarchive/restore 没有独立的操作时间列，核对操作后单据的 updated_at，
    // 与实现里"同一个 now 变量既写状态列又写日志 at"一致）② at 落在「请求发出前-1秒」到
    // 「响应返回后+1秒」的窗口内，防止两边各写各的时间还恰好字符串相等的极端假象。
    // ============================================================
    {
      async function logsFor(sheetId) { return f.all('SELECT * FROM it_inspection_sheet_log WHERE sheet_id=? ORDER BY id', [sheetId]); }
      function checkAtWindow(label, atIso, tBeforeMs, tAfterMs) {
        const t = new Date(atIso).getTime();
        check(label, Number.isFinite(t) && t >= tBeforeMs - 1000 && t <= tAfterMs + 1000, { atIso, t, tBeforeMs, tAfterMs });
      }

      await makeRoom('H7-Room');
      const tCreateBefore = Date.now();
      const h7create = await createSheet(2, 'H7-Room');
      const tCreateAfter = Date.now();
      check('H7建单201', h7create.status === 201, h7create.body);
      const h7id = h7create.body.id;
      let logs = await logsFor(h7id);
      check('H7 create日志恰1行', logs.length === 1, logs);
      check('H7 create日志字段正确', logs[0].actor_id === 2 && logs[0].action === 'create' && !!logs[0].at && !!logs[0].op_id && logs[0].reason === null, logs[0]);
      check('H7 create日志at等于单据created_at(35T-R H7)', logs[0].at === h7create.body.created_at, { logAt: logs[0].at, created_at: h7create.body.created_at });
      checkAtWindow('H7 create日志at落在请求窗口内(35T-R H7)', logs[0].at, tCreateBefore, tCreateAfter);

      const h7detail = await getSheet(h7id, 1);
      const h7put = await f.api('PUT', '/inspections/sheets/' + h7id, { expected_version: h7create.body.version, items: fillPayloadAllOk(h7detail.body.items) }, 1);
      check('H7管理员代填200', h7put.status === 200, h7put.body);
      await uploadAllRackFrontPhotos(f, h7id, h7create.body.scope, 1);
      const tSubmitBefore = Date.now();
      const h7submit = await f.api('POST', '/inspections/sheets/' + h7id + '/submit', { expected_version: h7put.body.version }, 1);
      const tSubmitAfter = Date.now();
      check('H7管理员代提交200', h7submit.status === 200, h7submit.body);
      let logsNow = await logsFor(h7id);
      check('H7 submit后日志恰新增1行', logsNow.length === logs.length + 1, { before: logs.length, after: logsNow.length });
      let lastRow = logsNow[logsNow.length - 1];
      check('H7 submit日志actor_id为实际操作人(管理员1，不是建单人2)', lastRow.actor_id === 1 && lastRow.action === 'submit' && !!lastRow.at && !!lastRow.op_id && lastRow.reason === null, lastRow);
      check('H7 submit日志at等于单据submitted_at(35T-R H7)', lastRow.at === h7submit.body.submitted_at, { logAt: lastRow.at, submitted_at: h7submit.body.submitted_at });
      checkAtWindow('H7 submit日志at落在请求窗口内(35T-R H7)', lastRow.at, tSubmitBefore, tSubmitAfter);
      logs = logsNow;

      const tArchiveBefore = Date.now();
      const h7archive = await f.api('POST', '/inspections/sheets/archive', { items: [{ id: h7id, expected_version: h7submit.body.version }] }, 1);
      const tArchiveAfter = Date.now();
      check('H7归档200', h7archive.status === 200, h7archive.body);
      logsNow = await logsFor(h7id);
      check('H7 archive后日志恰新增1行', logsNow.length === logs.length + 1, { before: logs.length, after: logsNow.length });
      lastRow = logsNow[logsNow.length - 1];
      check('H7 archive日志字段正确(op_id与批量响应一致)', lastRow.actor_id === 1 && lastRow.action === 'archive' && !!lastRow.at && lastRow.op_id === h7archive.body.op_id && lastRow.reason === null, lastRow);
      // 归档接口不返回完整详情（只有 {archived, op_id}），archived_at 需重读落库确认。
      const h7archivedRow = (await f.all('SELECT archived_at FROM it_inspection_sheets WHERE id=?', [h7id]))[0];
      check('H7 archive日志at等于单据archived_at(35T-R H7)', lastRow.at === h7archivedRow.archived_at, { logAt: lastRow.at, archived_at: h7archivedRow.archived_at });
      checkAtWindow('H7 archive日志at落在请求窗口内(35T-R H7)', lastRow.at, tArchiveBefore, tArchiveAfter);
      logs = logsNow;

      const tUnarchiveBefore = Date.now();
      const h7unarchive = await f.api('POST', '/inspections/sheets/' + h7id + '/unarchive', { expected_version: await currentVersion(h7id), reason: 'H7撤回测试' }, 1);
      const tUnarchiveAfter = Date.now();
      check('H7撤回200', h7unarchive.status === 200, h7unarchive.body);
      logsNow = await logsFor(h7id);
      check('H7 unarchive后日志恰新增1行', logsNow.length === logs.length + 1, { before: logs.length, after: logsNow.length });
      lastRow = logsNow[logsNow.length - 1];
      check('H7 unarchive日志字段正确(带原因)', lastRow.actor_id === 1 && lastRow.action === 'unarchive' && !!lastRow.at && !!lastRow.op_id && lastRow.reason === 'H7撤回测试', lastRow);
      check('H7 unarchive日志at等于单据操作后updated_at(35T-R H7:无独立unarchive时间列)', lastRow.at === h7unarchive.body.updated_at, { logAt: lastRow.at, updated_at: h7unarchive.body.updated_at });
      checkAtWindow('H7 unarchive日志at落在请求窗口内(35T-R H7)', lastRow.at, tUnarchiveBefore, tUnarchiveAfter);
      logs = logsNow;

      const tDeleteBefore = Date.now();
      const h7delete = await f.api('DELETE', '/inspections/sheets/' + h7id, { expected_version: await currentVersion(h7id), reason: 'H7删除测试' }, 2);
      const tDeleteAfter = Date.now();
      check('H7逻辑删除200', h7delete.status === 200, h7delete.body);
      logsNow = await logsFor(h7id);
      check('H7 delete后日志恰新增1行', logsNow.length === logs.length + 1, { before: logs.length, after: logsNow.length });
      lastRow = logsNow[logsNow.length - 1];
      check('H7 delete日志actor_id为实际操作人(巡检人2，带原因)', lastRow.actor_id === 2 && lastRow.action === 'delete' && !!lastRow.at && !!lastRow.op_id && lastRow.reason === 'H7删除测试', lastRow);
      check('H7 delete日志at等于单据deleted_at(35T-R H7)', lastRow.at === h7delete.body.deleted_at, { logAt: lastRow.at, deleted_at: h7delete.body.deleted_at });
      checkAtWindow('H7 delete日志at落在请求窗口内(35T-R H7)', lastRow.at, tDeleteBefore, tDeleteAfter);
      logs = logsNow;

      const tRestoreBefore = Date.now();
      const h7restore = await f.api('POST', '/inspections/sheets/' + h7id + '/restore', { expected_version: await currentVersion(h7id) }, 1);
      const tRestoreAfter = Date.now();
      check('H7恢复200', h7restore.status === 200, h7restore.body);
      logsNow = await logsFor(h7id);
      check('H7 restore后日志恰新增1行', logsNow.length === logs.length + 1, { before: logs.length, after: logsNow.length });
      lastRow = logsNow[logsNow.length - 1];
      check('H7 restore日志字段正确', lastRow.actor_id === 1 && lastRow.action === 'restore' && !!lastRow.at && !!lastRow.op_id && lastRow.reason === null, lastRow);
      check('H7 restore日志at等于单据操作后updated_at(35T-R H7:无独立restore时间列)', lastRow.at === h7restore.body.updated_at, { logAt: lastRow.at, updated_at: h7restore.body.updated_at });
      checkAtWindow('H7 restore日志at落在请求窗口内(35T-R H7)', lastRow.at, tRestoreBefore, tRestoreAfter);
    }

    // ============================================================
    // H8：CHECK子条件逐条——number项带note；device段number项带device_inspection_id；日志reason只有
    // 空格(unarchive与delete各一)，每条只违反一个子条件并配合法对照（codex 35T HIGH）
    // ============================================================
    {
      await expectReject('CHECK§2.2 number项带note违反(H8)',
        'INSERT INTO it_inspection_sheet_items(sheet_id,section,target_id,target_label,item_key,item_label,value_kind,note) VALUES(?,?,?,?,?,?,?,?)',
        [CK_SHEET_ID, 'room', 99998, 'x', 'chk_bad_h8_note', 'x', 'number', '备注']);
      await expectReject('CHECK§2.2 device段number项带device_inspection_id违反(H8)',
        'INSERT INTO it_inspection_sheet_items(sheet_id,section,target_id,target_label,item_key,item_label,value_kind,device_inspection_id) VALUES(?,?,?,?,?,?,?,?)',
        [CK_SHEET_ID, 'device', 99999, 'x', 'chk_bad_h8_devnum', 'x', 'number', 1]);
      await expectAccept('CHECK§2.2 device段check项带device_inspection_id正向(H8)',
        'INSERT INTO it_inspection_sheet_items(sheet_id,section,target_id,target_label,item_key,item_label,value_kind,device_inspection_id) VALUES(?,?,?,?,?,?,?,?)',
        [CK_SHEET_ID, 'device', 100000, 'x', 'chk_ok_h8_devnum', 'x', 'check', 1]);
      await expectReject('CHECK§2.4 delete原因只有空格违反(H8)',
        'INSERT INTO it_inspection_sheet_log(sheet_id,actor_id,at,op_id,action,reason) VALUES(?,?,?,?,?,?)',
        [CK_SHEET_ID, 1, 't', 'op-h8-1', 'delete', '   ']);
      await expectReject('CHECK§2.4 unarchive原因只有空格违反(H8)',
        'INSERT INTO it_inspection_sheet_log(sheet_id,actor_id,at,op_id,action,reason) VALUES(?,?,?,?,?,?)',
        [CK_SHEET_ID, 1, 't', 'op-h8-2', 'unarchive', '   ']);
      await expectAccept('CHECK§2.4 unarchive正向(带非空原因,H8)',
        'INSERT INTO it_inspection_sheet_log(sheet_id,actor_id,at,op_id,action,reason) VALUES(?,?,?,?,?,?)',
        [CK_SHEET_ID, 1, 't', 'op-h8-3', 'unarchive', '合法原因']);
    }

    // ============================================================
    // M-模板全等：含机柜+设备的建单结果，按 section/target_id 核对完整 item_key/item_label/value_kind
    // 与模板v1全等——不是只靠总数和少数 item_key 间接校验（codex 35T MEDIUM）
    // ============================================================
    {
      const TPL_ROOM = [
        ['temperature', '温度（℃，参考 18–27）', 'number'], ['humidity', '湿度（%，参考 40–60）', 'number'],
        ['aircon', '空调运行', 'check'], ['ups', 'UPS 与供电', 'check'], ['fire', '消防设施', 'check'],
        ['access', '门禁与门锁', 'check'], ['water', '漏水与地面', 'check'], ['cleanliness', '卫生与杂物', 'check'],
      ];
      const TPL_RACK = [['door', '柜门锁闭', 'check'], ['lights', '运行指示灯', 'check'], ['cabling', '线缆与标签', 'check'], ['pdu', 'PDU 与电源', 'check']];
      const TPL_DEVICE = [['front_panel', '前面板与告警灯', 'check']];

      await makeRoom('M-Template', 2, 1); // 2个机柜，每柜1台设备
      const tplCreated = await createSheet(2, 'M-Template');
      check('M模板全等建单201', tplCreated.status === 201, tplCreated.body);
      const expected = [];
      for (const [k, l, v] of TPL_ROOM) expected.push({ section: 'room', target_id: 0, item_key: k, item_label: l, value_kind: v });
      for (const rack of tplCreated.body.scope.racks) for (const [k, l, v] of TPL_RACK) expected.push({ section: 'rack', target_id: rack.id, item_key: k, item_label: l, value_kind: v });
      for (const dev of tplCreated.body.scope.devices) for (const [k, l, v] of TPL_DEVICE) expected.push({ section: 'device', target_id: dev.id, item_key: k, item_label: l, value_kind: v });
      const normalize = (arr) => arr.map((it) => ({ section: it.section, target_id: it.target_id, item_key: it.item_key, item_label: it.item_label, value_kind: it.value_kind }))
        .sort((a, b) => (a.section + a.target_id + a.item_key).localeCompare(b.section + b.target_id + b.item_key));
      check('M模板全等(8+4*2+1*2=18行)按section/target_id/item_key/item_label/value_kind全等模板v1', JSON.stringify(normalize(tplCreated.body.items)) === JSON.stringify(normalize(expected)), { got: normalize(tplCreated.body.items), expected: normalize(expected) });
    }

    // ============================================================
    // G2A2 Commit2（主会话裁定）：证明 detachFromRequest 确实生效、且只对清理动作生效——预置一条
    // 待清理记录，触发一次真实写请求（建单，同时会触发 processCleanupQueueBestEffort），有界轮询
    // 清理队列表直到该行被处理完（不是猜时间的sleep，是真实完成信号），断言：①该请求期间探针违规
    // 数为0（detach 生效，锁外读不再被计成"写请求上下文里的"）②探针确实记录到了清理相关SQL（不是
    // 没跑到/假阴性）且其 store 均无 writeRequest 标记（确实退出了ALS上下文，不是巧合躲过谓词）。
    // ============================================================
    {
      const seedStoredName = require('crypto').randomUUID() + '.bin'; // CHECK约束要求40字符UUID+.bin格式
      const seedIns = await f.run('INSERT INTO it_inspection_file_cleanup(stored_name,dir_key,reason,created_at) VALUES(?,?,?,?)', [seedStoredName, 'sheet_photos', 'g2a2_detach_test', new Date().toISOString()]);
      const seedId = seedIns.lastID;
      await makeRoom('G2A2-Detach', 1, 1);
      // M2订正：快照挪到makeRoom之后、createSheet之前——makeRoom内部走POST /racks与POST ''建资产，
      // 这两条路由走requireAdmin不走requireLedgerWrite，探针记录天然writeRequest:false（这是真实、
      // 正确的现象，不是bug），混进before~createSheet窗口会污染"建单请求自己事务内的记录"这条断言
      // （错把别的写请求的记录也算进"建单请求自己"）。
      const before = sqlProbeRecords.length;
      const detachCreated = await createSheet(2, 'G2A2-Detach');
      check('G2A2Detach: 触发写请求(建单)201', detachCreated.status === 201, detachCreated.body);
      // 有界轮询（非sleep猜时长）：等种子行被清理队列处理完成——成功会被DELETE(种子文件不存在磁盘，
      // unlink触发ENOENT按ok处理)，处理不到才继续等，超过3s判定异常。
      let remaining = null;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const rows = await f.all('SELECT * FROM it_inspection_file_cleanup WHERE id=?', [seedId]);
        remaining = rows[0] || null;
        if (!remaining) break;
        await new Promise((r) => setTimeout(r, 30));
      }
      check('G2A2Detach: 种子清理行在有界等待内被处理(已从队列删除,证明清理确实跑完)', remaining === null, remaining);
      // M4（G2A2b 必修）：违规谓词改用夹具统一导出的 isProbeViolation（写请求内事务外的任何SQL，
      // 不再限定表名），不在本文件各处各写一份正则。
      const newRecords = sqlProbeRecords.slice(before);
      const newViolations = newRecords.filter(isProbeViolation);
      check('G2A2Detach: 该请求期间探针违规数为0(detachFromRequest生效)', newViolations.length === 0, newViolations);
      // 只看processCleanupQueue自己发出的锁外读/删(inWriteTxn!==true)——不含ensureTables在真实写
      // 事务(inWriteTxn===true)内建it_inspection_file_cleanup表这条合法SQL(它引用同一张表名但是
      // 建单本身的写事务一部分，不是detachFromRequest要处理的对象)。
      const cleanupRecords = newRecords.filter((r) => /it_inspection_file_cleanup/.test(r.sql) && r.inWriteTxn !== true);
      check('G2A2Detach: 探针确实记录到了清理相关的锁外SQL(不是没跑到的假阴性)', cleanupRecords.length > 0, { count: cleanupRecords.length, sample: newRecords.slice(0, 5) });
      // M2（G2A2b 必修）：detach用例补断言——同一次建单请求自己的事务内记录带writeRequest:true，
      // 证明detachFromRequest只作用于清理这一段，没有连带把建单本身的写事务也退出了ALS上下文
      // （否则前面"该请求期间探针违规数为0"这条断言会因为一种完全不同的原因而通过——建单事务本身
      // 的SQL也失去了writeRequest标记，谓词自然也判不出违规，是假阳性）。按method+path精确匹配到
      // "这条POST /inspections/sheets请求自己的事务"——不能只按inWriteTxn===true笼统抓，
      // processCleanupQueue自己的第二个withWrite(处理outcomes那个)也是inWriteTxn===true，但那是
      // detach之后另开的一段独立事务，理应writeRequest:false，混进来会把这条断言的意图搞反。
      const ownTxnRecords = newRecords.filter((r) => r.inWriteTxn === true && r.method === 'POST' && r.path === '/api/it-assets/inspections/sheets');
      check('G2A2Detach: 建单请求自己事务内的记录全部带writeRequest:true(detach只影响清理,不影响主事务)', ownTxnRecords.length > 0 && ownTxnRecords.every((r) => r.writeRequest === true), ownTxnRecords);
      check('G2A2Detach: 清理相关锁外SQL的store均无writeRequest标记(确实退出了ALS上下文)', cleanupRecords.every((r) => r.writeRequest !== true), cleanupRecords);
    }

    // ============================================================
    // G2A2 运行时探针（长任务 E 段2；G2A2b M4 放宽谓词）：静态守卫降级为结构约定检查后，"写路由
    // 锁外不读库"这条性质改由运行时探针在测试模式下保证（routes/it-ledger/index.js 的
    // ledgerRequestContext/probeSql/_testHooks.sqlProbe）。套件末尾统一断言：本文件全部写路由测试
    // 跑下来，从未出现"写请求上下文里、不在 withWrite 事务内"的任何 SQL（谓词不再限定表名，见夹具
    // isProbeViolation）。
    // ============================================================
    {
      const violations = sqlProbeRecords.filter(isProbeViolation);
      check('G2A2探针: 写请求锁外SQL违规数精确为0', violations.length === 0, violations.slice(0, 10));
      const inTxnCount = sqlProbeRecords.filter((r) => r.writeRequest === true && r.inWriteTxn === true).length;
      check('G2A2探针: 确实收到过写请求写事务内的SQL记录(探针接通,非空跑)', inTxnCount > 0, { inTxnCount, total: sqlProbeRecords.length });
      // M6（G3A-b 必修）→ G3A-c（41RS M2 订正，只记真实SQL）：assertWrite 是第四个探针入口，
      // 但只在真正发出 ACL 查询时才记录——用真实 SQL 文本，不是占位符，admin 分支/跳过分支不产生
      // 任何记录。本文件全套写路由测试跑下来，本就大量走非管理员写请求（fixture-write，uid 2），
      // 一定能看到至少一条真实 ACL SQL 且 inWriteTxn===true 的记录。
      const ACL_SQL_TEXT = 'SELECT level FROM it_asset_acl WHERE user_id = ?';
      const assertWriteInTxnCount = sqlProbeRecords.filter((r) => r.sql === ACL_SQL_TEXT && r.inWriteTxn === true).length;
      check('M6: 能看到assertWrite真实ACL查询记录且inWriteTxn===true(第四个入口确实接通)', assertWriteInTxnCount > 0, { assertWriteInTxnCount });

      // G3A-c（41RS M2 必修）：受控正反两例，精确核对"只在真正发出ACL查询时才记录"这条性质——
      // ①非管理员(uid 2, fixture-write, ACL level='write')写请求内调用assertWrite，确实产生
      // 恰好1条真实ACL SQL记录且inWriteTxn===true②管理员写请求内调用assertWrite（admin分支直接
      // return，从不查ACL表），窗口内0条ACL SQL记录。用 f.internals 直接引用，不依赖本文件后面
      // "H1"节才解构出的 ledgerRequestContext/withWrite/adminUser（本块在那之前）。
      {
        const m6Ctx = f.internals.ledgerRequestContext;
        const m6WithWrite = f.internals.withWrite;
        await waitForProbeQuiescence();
        const beforeNonAdmin = sqlProbeRecords.length;
        await m6Ctx.run({ writeRequest: true, method: 'POST', path: '/probe-m6-nonadmin' }, async () => {
          await m6WithWrite(async (q) => { await q.assertWrite({ id: 2, role: 'user' }); });
        });
        const nonAdminRecs = sqlProbeRecords.slice(beforeNonAdmin).filter((r) => r.sql === ACL_SQL_TEXT);
        check('M6(41RS M2): 非管理员写请求assertWrite恰好产生1条真实ACL查询记录且inWriteTxn=true', nonAdminRecs.length === 1 && nonAdminRecs[0].inWriteTxn === true, sqlProbeRecords.slice(beforeNonAdmin));

        await waitForProbeQuiescence();
        const beforeAdmin = sqlProbeRecords.length;
        await m6Ctx.run({ writeRequest: true, method: 'POST', path: '/probe-m6-admin' }, async () => {
          await m6WithWrite(async (q) => { await q.assertWrite({ id: 1, role: 'admin' }); });
        });
        const adminRecs = sqlProbeRecords.slice(beforeAdmin).filter((r) => r.sql === ACL_SQL_TEXT);
        check('M6(41RS M2): 管理员写请求assertWrite不产生任何ACL查询记录(admin分支从不发SQL)', adminRecs.length === 0, sqlProbeRecords.slice(beforeAdmin));
      }

      // M2（G2A2b 必修）：逐路由接通断言——本文件覆盖的8条写路由，每条都至少产生过一条
      // writeRequest:true 的探针记录（method+path按normalizeInspectionRouteKey归一化匹配）。
      const SHEETS_COVERED_WRITE_ROUTES = ['post:/', 'post:/archive', 'put:/:id', 'post:/:id/submit', 'delete:/:id', 'post:/:id/restore', 'post:/:id/unarchive', 'post:/:id/photos'];
      const sheetsSeenRouteKeys = new Set(sqlProbeRecords.filter((r) => r.writeRequest === true).map((r) => normalizeInspectionRouteKey(r.method, r.path)));
      for (const routeKey of SHEETS_COVERED_WRITE_ROUTES) {
        check(`M2逐路由接通: ${routeKey} 存在writeRequest:true的探针记录`, sheetsSeenRouteKeys.has(routeKey), [...sheetsSeenRouteKeys]);
      }

      // 正向对照（证明探针有判别力）：在一个写请求上下文里真的发生一次锁外读——直接调用测试模式下
      // 导出的 ledgerRequestContext 与 withRead（不经过任何真实路由），断言收集器恰好新增1条违规
      // 记录，不是"探针从未报过警所以看起来安全"这种假阴性。
      // M2（41T 必修）：取快照前先等前面用例触发的异步工作真正结束，再断言恰好新增1条——同时逐条
      // 核对新增违规记录的 method/path/op/sql 与本例构造一致，不只看条数（防止别的延迟任务恰好
      // 在窗口内产生的一条违规被误当成本例命中）。
      await waitForProbeQuiescence();
      const before = sqlProbeRecords.length;
      const CONTROL_SQL = 'SELECT id FROM it_inspection_sheets /*g3a_control*/ LIMIT 1';
      await f.internals.ledgerRequestContext.run({ writeRequest: true, method: 'POST', path: '/probe-control' },
        () => f.internals.withRead((q) => q.get(CONTROL_SQL)));
      const newRecords = sqlProbeRecords.slice(before);
      const newViolations = newRecords.filter(isProbeViolation);
      check('G2A2探针正向对照: 写请求上下文里的一次锁外读恰好新增1条违规记录', newViolations.length === 1, newRecords);
      const controlV = newViolations[0];
      // G3A-c（41RT M4 同款收紧，顺带修）：改完整SQL全等，不用表名正则子串匹配。
      check('G2A2探针正向对照: 违规记录method/path/op/sql与构造一致(41RT M4:完整SQL全等)',
        !!controlV && controlV.method === 'POST' && controlV.path === '/probe-control' && controlV.op === 'get' && controlV.sql === CONTROL_SQL,
        controlV);
    }

    // ============================================================
    // H1（G2A2b 必修，修探针漏报）：事务提交后才跑的SQL不该被记成"事务内"——直接用_internals与
    // ledgerRequestContext构造3种"withWrite回调内派生出、真正执行SQL时事务早已结束"的场景，不改
    // 路由、不经过真实HTTP。每条都断言"违规恰好新增1条"（不是>=1，防止把derive调用本身触发的其它
    // 副作用SQL也算进来污染判定）。放在套件最末尾（正向对照之后）——这几条用例本身就是刻意构造
    // 违规，若放在前面会污染"写请求锁外SQL违规数精确为0"这条全局汇总断言。
    // ============================================================
    {
      const { ledgerRequestContext, withWrite, withRead } = f.internals;
      const adminUser = { id: 1, role: 'admin' };

      // M2（41T 必修）：本节每条用例断言前都先核对新增违规记录的 method/path/op/sql 与自己的构造
      // 一致（不只看条数）；取快照前先等前面异步工作结束，避免被无关的延迟任务污染。
      // G3A-c（41RT M4 必修，改完整SQL全等）：sql 字段改为期望的**完整 SQL 文本**，用全等比较
      // （不是正则子串匹配）——旧版用表名正则只能证明"SQL 里出现了这个表名"，证不了"SQL 是构造
      // 的那一条、没有被替换成别的同样引用该表的语句"；每例的 SQL 文本本身在下面各调用点都构造得
      // 互不相同（含独有标记），全等比较能精确绑定"这条违规记录就是本例构造的那次调用"。
      function checkOneViolation(label, newRecords, expected) {
        const violations = newRecords.filter(isProbeViolation);
        check(`${label}恰好新增1条违规`, violations.length === 1, newRecords);
        const v = violations[0];
        check(`${label}违规记录method/path/op/sql与构造一致(41RT M4:完整SQL全等)`,
          !!v && v.method === expected.method && v.path === expected.path && v.op === expected.op && v.sql === expected.sql,
          v);
      }

      // ①withWrite回调内派生一个不await的withRead(...it_inspection_sheets...)，事务结束后该读
      // 才真正执行(withRead自己要抢同一把itTxnMutex，事务还没释放锁之前它排不上号)。
      {
        await waitForProbeQuiescence();
        const before = sqlProbeRecords.length;
        let derived;
        await ledgerRequestContext.run({ writeRequest: true, method: 'POST', path: '/probe-h1-case1' }, async () => {
          await withWrite(async (q) => {
            await q.assertWrite(adminUser);
            derived = withRead((q2) => q2.get('SELECT id FROM it_inspection_sheets /*h1_case1*/ LIMIT 1')); // 不 await，fire-and-forget
          });
        });
        await derived; // 测试侧显式等它跑完，不代表生产代码里这一行本身被await——生产路径就是不await
        checkOneViolation('H1①: withWrite回调内派生不await的withRead，事务提交后才执行的SQL',
          sqlProbeRecords.slice(before), { method: 'POST', path: '/probe-h1-case1', op: 'get', sql: 'SELECT id FROM it_inspection_sheets /*h1_case1*/ LIMIT 1' });
      }

      // ②回调内 setImmediate(() => withRead(...)) 同样记为违规——比①多一层"跳到下一个事件循环tick
      // 再执行"，进一步证明判定不依赖"在哪个tick执行"，只看事务这个标记对象此刻是否还活动。
      {
        await waitForProbeQuiescence();
        const before = sqlProbeRecords.length;
        let resolveDerived2;
        const derived2Done = new Promise((resolve) => { resolveDerived2 = resolve; });
        await ledgerRequestContext.run({ writeRequest: true, method: 'POST', path: '/probe-h1-case2' }, async () => {
          await withWrite(async (q) => {
            await q.assertWrite(adminUser);
            setImmediate(() => { withRead((q2) => q2.get('SELECT id FROM it_inspection_sheets /*h1_case2*/ LIMIT 1')).then(resolveDerived2, resolveDerived2); });
          });
        });
        await derived2Done;
        checkOneViolation('H1②: withWrite回调内setImmediate派生的withRead，事务提交后才执行的SQL',
          sqlProbeRecords.slice(before), { method: 'POST', path: '/probe-h1-case2', op: 'get', sql: 'SELECT id FROM it_inspection_sheets /*h1_case2*/ LIMIT 1' });
      }

      // ③回调内捕获q，回调返回后（withWrite本身也已经resolve、COMMIT已完成）再用这个q.get(...)——
      // 验证的是txnMarker机制本身（案例①②验证的是withRead恒报false，这条验证的是withWrite的
      // txnMarker.active在事务结束后确实被置false）。
      {
        await waitForProbeQuiescence();
        const before = sqlProbeRecords.length;
        let capturedQ;
        await ledgerRequestContext.run({ writeRequest: true, method: 'POST', path: '/probe-h1-case3' }, async () => {
          await withWrite(async (q) => {
            await q.assertWrite(adminUser);
            capturedQ = q;
          });
          await capturedQ.get('SELECT id FROM it_inspection_sheets /*h1_case3*/ LIMIT 1');
        });
        checkOneViolation('H1③: 回调内捕获q，回调返回(事务已COMMIT)后再用该q.get(...)的SQL',
          sqlProbeRecords.slice(before), { method: 'POST', path: '/probe-h1-case3', op: 'get', sql: 'SELECT id FROM it_inspection_sheets /*h1_case3*/ LIMIT 1' });
      }

      // ============================================================
      // G3A①（41S H1 必修，还原漏报窗口）：案例③验证的是"withWrite整个resolve之后"（COMMIT早已
      // 真正完成）txnMarker.active已经是false；这里要验证更窄的一点——"发出COMMIT之前"就已经是
      // false，不是像旧实现那样要等到finally里COMMIT真正完成才置false。用_internals.setPreCommitGate
      // 精确卡在withWrite内"txnMarker.active已置false、真正的dbRunOn(conn,'COMMIT')尚未发出"这个
      // 窗口内，从窗口内（借ledgerRequestContext.run显式还原写请求上下文，与"正向对照"同一手法——
      // 探针的writeRequest/method/path字段来自调用发生时刻的store，与q对象本身是否处于哪个原始
      // 请求无关）用捕获的q发起一次读，断言恰好新增1条违规，且该条记录的method/path/op/sql与构造
      // 一致。变异：把index.js里"发出COMMIT之前置txnMarker.active=false"的两行代码删掉/移回只在
      // finally里做 → 这条用例应变红（窗口内active仍是true，读被误判成"事务内"，探针记不到违规）。
      // G3A-c（41RS/41RT M1 订正口径，保守语义）：本用例在放行闸（gateResolve）之前**先 await
      // 完这次读本身**，读真正执行完毕后才放行、真正的dbRunOn(conn,'COMMIT')才发出——这条读在
      // SQLite连接的执行队列里严格排在COMMIT之前，此刻它在数据库层面事实上仍处于事务内。这不是
      // 本用例的缺陷，是探针"标记已失效即报违规"这条保守（悲观）口径的直接体现：只要txnMarker
      // .active已经置false，不管SQL在驱动/数据库层面是先执行还是后执行、是否恰好还排在COMMIT
      // 前面，一律报"不在事务内"。本用例证明的是"active确实在发出COMMIT之前就已置false"这个更宽
      // 的属性，天然覆盖（但不等同于单独复现）"COMMIT已提交给连接、驱动回调尚未完成"这个更窄的
      // 窗口——要精确复现后者需要在sqlite3驱动内部插桩，不在本轮范围内。
      // ============================================================
      {
        await waitForProbeQuiescence();
        const before = sqlProbeRecords.length;
        let capturedQ;
        let gateResolve;
        const arrived = f.internals.setPreCommitGate(new Promise((resolve) => { gateResolve = resolve; }));
        const writeDone = ledgerRequestContext.run({ writeRequest: true, method: 'POST', path: '/probe-g3a-commitwindow' }, async () => {
          await withWrite(async (q) => {
            await q.assertWrite(adminUser);
            capturedQ = q;
          });
        });
        await arrived; // 到达"active已置false、COMMIT尚未真正发出"这个窗口
        await ledgerRequestContext.run({ writeRequest: true, method: 'POST', path: '/probe-g3a-commitwindow' },
          () => capturedQ.get('SELECT id FROM it_inspection_sheets /*g3a_commitwindow*/ LIMIT 1'));
        gateResolve(); // 放行，真正的COMMIT才会被发出
        await writeDone;
        f.internals.setPreCommitGate(null); // 与setTxnMidGate同款约定：用完显式清空，不留给后续用例
        checkOneViolation('G3A①(41S H1): COMMIT发出前的窗口内用捕获的q发起一次读，其SQL',
          sqlProbeRecords.slice(before), { method: 'POST', path: '/probe-g3a-commitwindow', op: 'get', sql: 'SELECT id FROM it_inspection_sheets /*g3a_commitwindow*/ LIMIT 1' });
      }

      // ============================================================
      // G3A①b（G3A-b H1 必修，回滚侧前置置false补测）：G3A①验证的是COMMIT成功路径；withWrite
      // 回调抛业务错误走的ROLLBACK路径同样在发出ROLLBACK之前把txnMarker.active置false（见
      // index.js bizErr catch分支），此前没有任何用例验证过这条路径本身（只验证过它不会崩，没
      // 验证过它的探针语义）。用preCommitGate精确卡在"active已置false、真正的ROLLBACK尚未发出"
      // 这个窗口，窗口内借ledgerRequestContext.run显式还原写请求上下文后用捕获的q发起一次读
      // （SQL用独有标记g3a_rollback_marker，与COMMIT侧窗口测试的SQL区分），断言：①写调用本身
      // 以构造的业务码reject（证明确实走的是bizErr/ROLLBACK分支，不是意外滑进成功路径）②窗口内
      // 那次读恰好新增1条违规且method/path/op/sql与构造一致。变异：删掉index.js bizErr分支里
      // "txnMarker.active = false;"那一行（只留finally兜底）→ 这条用例应变红（窗口内active仍是
      // true，读被误判成"事务内"，探针记不到违规）。
      // G3A-c（41RS/41RT M1 订正口径，保守语义，同G3A①）：本用例同样在放行闸之前先await完这次
      // 读，读严格排在真正的ROLLBACK之前——数据库层面这条SQL此刻仍处于事务内，探针仍按"active
      // 已置false"这条保守口径统一报违规，不代表本用例单独复现了"ROLLBACK已提交给连接、驱动
      // 回调未完成"这个更窄的窗口（同G3A①，需要驱动内部插桩才能精确构造，不在本轮范围）。
      // ============================================================
      {
        await waitForProbeQuiescence();
        const before = sqlProbeRecords.length;
        let capturedQ;
        let gateResolve;
        const bizCode = 'G3A_ROLLBACK_MARKER_ERR';
        const arrived = f.internals.setPreCommitGate(new Promise((resolve) => { gateResolve = resolve; }));
        const writeDone = ledgerRequestContext.run({ writeRequest: true, method: 'POST', path: '/probe-g3a-rollbackwindow' }, async () => {
          await withWrite(async (q) => {
            await q.assertWrite(adminUser);
            capturedQ = q;
            const e = new Error('G3A①b构造的业务错误'); e.status = 400; e.code = bizCode; throw e;
          });
        });
        // 立即挂接收 settle 的 handler（不等 gate 放行），避免 writeDone 在放行前被视为
        // unhandled rejection；真正的等待放在 gateResolve() 之后。
        const writeSettled = writeDone.then(() => ({ outcome: 'resolved' }), (e) => ({ outcome: 'rejected', code: e && e.code }));
        await arrived; // 到达"active已置false、ROLLBACK尚未真正发出"这个窗口
        await ledgerRequestContext.run({ writeRequest: true, method: 'POST', path: '/probe-g3a-rollbackwindow' },
          () => capturedQ.get('SELECT 1 AS g3a_rollback_marker'));
        gateResolve(); // 放行，真正的ROLLBACK才会被发出
        const settled = await writeSettled;
        f.internals.setPreCommitGate(null);
        check('G3A①b(H1回滚侧): 写调用以构造的业务码reject(确实走了bizErr/ROLLBACK分支)', settled.outcome === 'rejected' && settled.code === bizCode, settled);
        checkOneViolation('G3A①b(H1回滚侧): ROLLBACK发出前的窗口内用捕获的q发起一次读，其SQL',
          sqlProbeRecords.slice(before), { method: 'POST', path: '/probe-g3a-rollbackwindow', op: 'get', sql: 'SELECT 1 AS g3a_rollback_marker' });
      }

      // ============================================================
      // G3A②（41T H2 必修）→ G3A-b（M2 必修，改用 hidden/direct 双标记精确区分）：即使路由处理器
      // 借 Reflect.get(arguments[0], 'runCleanupDetached') 反射拿到该函数（不需要在源码里出现这个
      // 标识符，绕开R8的文本扫描），调用它也藏不住路由自己的锁外读——runCleanupDetached只接受数字
      // 型limit（G3A-b L1 起非法limit直接throw），从不把参数当函数调用（见index.js该函数定义处
      // 注释）。直接用_internals拿到与inspection-sheets.js工厂收到的同一个函数引用（依赖注入的对象
      // 恒等，不需要真的改源码去模拟反射取值这个动作本身——被反射取到的和这里导出的是同一个函数，
      // 行为完全一致）。
      // 声明与实际证明范围一致（M2 订正）→ G3A-c（41RT M2 必修，恢复calledWithFn与hidden标记
      // 并存）：codex 41RT 指出二者证明的是不同性质，不能互相替代——①calledWithFn 证明"传入的
      // JS 函数对象本身有没有被 invoke"，是入口层面的证据：哪怕回调内部在到达 q.get 之前就失败、
      // 或者查询尚未真正完成，只要函数体被调用过，calledWithFn 就能捕捉到这个事实②hidden 标记
      // 扫描证明"回调内部那条读有没有真的被探针记录"，是更细粒度、更贴近探针语义本身的证据（回调
      // 被调用了不代表内部那条 q.get 一定真的执行/被记录到）。本用例证明的是——①传给
      // runCleanupDetached 的"伪装成 limit"的函数从未被调用（calledWithFn）②被 viaReflect(...)
      // 包住、企图借runCleanupDetached"退出ALS上下文"逃逸探针的那次读（SQL 标记 /*g3a_hidden*/）
      // 在任何探针记录里都不出现③路由自己转而直接发起的锁外读（SQL 标记 /*g3a_direct*/）仍被探针
      // 如实记为违规——不证明"任何借 runCleanupDetached 传参都会被拒绝"（拒绝只是 L1 校验的副作用，
      // 不是本用例要证明的性质）。变异 mH2：把 runCleanupDetached 改回"遇到函数参数就在 exit 里
      // 直接调用它"（模拟旧版 detachFromRequest 的行为）→ calledWithFn 与 hidden 标记两条断言都
      // 应变红（伪装回调确实被调用，调用内部那条 hidden 读也确实被探针记到）；报告以实测的首红为准。
      // ============================================================
      {
        const runCleanupDetached = f.internals.runCleanupDetached;
        const hiddenSql = 'SELECT id FROM it_inspection_sheets /*g3a_hidden*/ LIMIT 1';
        const directSql = 'SELECT id FROM it_inspection_sheets /*g3a_direct*/ LIMIT 1';
        const viaReflect = Reflect.get({ runCleanupDetached }, 'runCleanupDetached');

        // G3A-c（41RT M2 必修）：恢复的入口层证据——disguisedCallback 只会被当成一个不合法的
        // limit（非 undefined 非安全正整数），G3A-c L1 校验直接 throw，从未被当函数调用过。
        let calledWithFn = false;
        const disguisedCallback = () => { calledWithFn = true; };
        try { await viaReflect(disguisedCallback); } catch (_e) { /* 预期：非法limit被L1校验拒绝 */ }
        check('G3A②(41T H2/41RT M2): 反射取得runCleanupDetached后传入的"伪装回调"从未被调用', calledWithFn === false);

        await waitForProbeQuiescence();
        const before = sqlProbeRecords.length;
        await ledgerRequestContext.run({ writeRequest: true, method: 'POST', path: '/probe-g3a-reflect-escape' }, async () => {
          await withWrite(async (q) => { await q.assertWrite(adminUser); });
          // 想借runCleanupDetached"退出ALS上下文"掩盖这次读——但传入的回调从未被调用（上面已证），
          // 所以这次读（hiddenSql）要么根本不会发生，要么路由只能老老实实自己直接发起（不经由
          // runCleanupDetached包裹，用directSql），后者仍然暴露给探针。
          try { await viaReflect(async () => { await withRead((q2) => q2.get(hiddenSql)); }); } catch (_e) { /* 参数被L1校验拒绝，不会执行，预期内 */ }
          await withRead((q2) => q2.get(directSql)); // 路由自己直接读，如实暴露
        });
        const newRecords = sqlProbeRecords.slice(before);
        // M2（G3A-b 必修，41RT M2 保留）：不只看违规数——扫描本窗口内**任何**探针记录（不管是不是
        // 违规），断言没有一条 SQL 含 hidden 标记，这是"回调确实从未执行"的更细粒度证据（弱断言
        // "违规数没变"可能因为该读被误判成非违规而侥幸通过，不能排除它其实执行了但被漏记）。
        check('G3A②(41T H2/M2): 本窗口全部探针记录中不出现hidden标记(回调确实从未被执行)', newRecords.every((r) => !/g3a_hidden/.test(r.sql)), newRecords.map((r) => r.sql));
        checkOneViolation('G3A②(41T H2): runCleanupDetached包不住路由自己的锁外读，该读',
          newRecords, { method: 'POST', path: '/probe-g3a-reflect-escape', op: 'get', sql: directSql });

        // L4（G3A-b 必修）→ G3A-c（41RT M2 订正）：旧版在没有任何 ledgerRequestContext.run() 包裹
        // 的地方直接调用 runCleanupDetached(1)——即使 exit() 完全不生效，getStore() 本来就是
        // undefined，writeRequest 本来就不是 true，这条断言什么都没真正证明。改为把调用包进一个
        // 显式的写请求上下文（writeRequest:true）里，只有真的执行了 ledgerRequestContext.exit()，
        // 内部 cleanupFn 发出的 SQL 才会丢失这个 ambient writeRequest:true 标记；断言能看到
        // processCleanupQueue 自己发出的、writeRequest 非 true 的探针记录，这才是 exit() 确实
        // 生效的直接证据。变异：runCleanupDetached 把 ledgerRequestContext.exit 去掉（直接调
        // cleanupFn(limit)）→ 这条用例应变红（cleanupFn 的 SQL 会继承外层写请求上下文的
        // writeRequest:true，再也找不到 writeRequest 非 true 的清理 SQL 记录）。
        const beforeL4 = sqlProbeRecords.length;
        await ledgerRequestContext.run({ writeRequest: true, method: 'POST', path: '/probe-l4-detach-context' }, async () => {
          await runCleanupDetached(1);
        });
        const cleanupExecuted = sqlProbeRecords.slice(beforeL4).some((r) => /it_inspection_file_cleanup/.test(r.sql) && r.writeRequest !== true);
        check('L4(41RT M2): 显式写请求上下文内调用runCleanupDetached(1),清理SQL确实丢失writeRequest标记(exit生效的直接证据)', cleanupExecuted, sqlProbeRecords.slice(beforeL4));
      }
    }

    console.log(`INSPECTION_SHEETS PASS=${pass} FAIL=0`);
  } finally {
    await f.close();
  }
}
main().catch((e) => { console.error(e.stack); console.log(`INSPECTION_SHEETS PASS=${pass} FAIL=1`); process.exitCode = 1; });
